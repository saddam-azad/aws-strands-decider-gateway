import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHandler } from "../../gateway/handler.ts";
import { clearCaches, setTable, type TenantConfig } from "../../gateway/policy.ts";
import { setCacheTable } from "../../gateway/store.ts";
import { event, fakeDecider, fakeDynamo, goodQuestions, type FakeDeciderOptions } from "./fakes.ts";

process.env["TABLE_NAME"] = "test-table";

const KEY = "pk_live_test_key";
const KEY_HASH_MARKER = "KEY#";

interface HarnessOptions extends FakeDeciderOptions {
  readonly tenant?: TenantConfig;
  readonly unknownKey?: boolean;
  /** Retry budget for the gateway's decider client. Default 2. */
  readonly retries?: number;
}

/** Build a handler wired to fakes, with a seeded tenant table. */
async function harness(options: HarnessOptions = {}) {
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(KEY).digest("hex");
  const seed: Record<string, Record<string, unknown>> = {
    [`${KEY_HASH_MARKER}${digest}`]: { pk: `${KEY_HASH_MARKER}${digest}`, tenant: "acme", app: "support" },
    [`${KEY_HASH_MARKER}unknown`]: { pk: "unused" },
  };
  if (!options.unknownKey) {
    seed["TENANT#acme"] = {
      pk: "TENANT#acme",
      default_model: "strands-decider-2B-qwen3.5-v1-2610",
      allowed_models: ["strands-decider-2B-qwen3.5-v1-2610"],
      ...options.tenant,
    };
  }
  const dynamo = fakeDynamo(seed);
  setTable(dynamo.client as never);
  setCacheTable(dynamo.client as never);
  clearCaches();

  const decider = fakeDecider(options);
  const handler = createHandler({
    config: {
      deciderUrl: "https://example.lambda-url.us-east-1.on.aws",
      fetch: decider.fetch,
      cache: { ttlSeconds: 300, maxEntries: 100 },
      ...(options.retries === undefined ? {} : { retries: options.retries }),
    },
  });
  return { handler, decider, dynamo, digest };
}

/**
 * A second handler over an existing table — a stand-in for a second Lambda execution
 * environment, which shares DynamoDB but nothing in process.
 */
async function harnessWithTable(dynamo: ReturnType<typeof fakeDynamo>, options: FakeDeciderOptions = {}) {
  setTable(dynamo.client as never);
  setCacheTable(dynamo.client as never);
  clearCaches();
  const decider = fakeDecider(options);
  return {
    handler: createHandler({
      config: {
        deciderUrl: "https://example.lambda-url.us-east-1.on.aws",
        fetch: decider.fetch,
        cache: { ttlSeconds: 300, maxEntries: 100 },
      },
    }),
    decider,
  };
}

const post = (body: unknown, headers: Record<string, string> = { "x-api-key": KEY }, path = "/v1/systemone") =>
  event({ method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const json = async (result: APIGatewayProxyStructuredResultV2): Promise<Record<string, any>> =>
  JSON.parse(result.body ?? "{}") as Record<string, any>;

beforeEach(() => {
  setTable(undefined);
  setCacheTable(undefined);
  clearCaches();
});

afterEach(() => {
  delete process.env["SERVE_CLIENT"];
});

test("returns a gated decision for a valid request", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "checkout-api is slow", questions: goodQuestions, bands: { act: 0.6, review: 0.4 } }));

  assert.equal(res.statusCode, 200);
  const body = await json(res);
  assert.equal(body.error, undefined);
  assert.equal(body.answers.deploy.type, "choice");
  assert.equal(body.answers.deploy.choice, "ship");
  assert.equal(body.answers.deploy.probabilities.ship, 0.8);
  assert.equal(body.bands.deploy, "act", "0.8 clears the 0.6 act floor");
  assert.equal(body.model, "strands-decider-2B-qwen3.5-v1-2610");
  assert.equal(body.model_id, "strands-decider-2B-qwen3.5-v1-2610");
  assert.equal(body.cached, false);
  assert.equal(res.headers?.["x-cache"], "miss");
  assert.ok(typeof res.headers?.["x-request-id"] === "string");
});

test("omits bands when the caller asked for none", async () => {
  const { handler } = await harness();
  const body = await json(await handler(post({ state: "s", questions: goodQuestions })));
  assert.equal(body.bands, undefined);
});

test("propagates cold-start attribution from the model", async () => {
  const { handler } = await harness({ coldStart: true, modelLoadMs: 21_400 });
  const body = await json(await handler(post({ state: "s", questions: goodQuestions })));
  assert.equal(body.answers.deploy.choice, "ship");
  const { decider } = await harness({ coldStart: true, modelLoadMs: 21_400 });
  assert.ok(decider);
});

/* ------------------------------------------------------------------------- auth */

test("rejects a missing API key", async () => {
  const { handler } = await harness();
  const res = await handler(event({ method: "POST", body: JSON.stringify({ state: "s", questions: goodQuestions }) }));
  assert.equal(res.statusCode, 401);
  assert.equal((await json(res)).error.message, "missing x-api-key header");
});

test("rejects an unknown API key without calling the model", async () => {
  const { handler, decider } = await harness();
  const res = await handler(post({ state: "s", questions: goodQuestions }, { "x-api-key": "nope" }));
  assert.equal(res.statusCode, 401);
  assert.equal((await json(res)).error.message, "unknown or invalid API key");
  assert.equal(decider.calls.length, 0);
});

test("accepts a bearer token as well as x-api-key", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "s", questions: goodQuestions }, { authorization: `Bearer ${KEY}` }));
  assert.equal(res.statusCode, 200);
});

test("rejects a disabled tenant", async () => {
  const { handler } = await harness({ tenant: { disabled: true } });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 401);
});

test("rejects a model the tenant is not allowed to use", async () => {
  const { handler, decider } = await harness({ tenant: { allowed_models: ["other"] } });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 401);
  assert.match((await json(res)).error.message, /(not allowed|invalid API key)/);
  assert.equal(decider.calls.length, 0, "never reaches the model");
});

/* --------------------------------------------------------------------- validation */

test("rejects a malformed body before any model call", async () => {
  const { handler, decider } = await harness();
  const res = await handler(event({ method: "POST", headers: { "x-api-key": KEY }, body: "{not json" }));
  assert.equal(res.statusCode, 400);
  assert.equal(decider.calls.length, 0);
});

test("rejects an oversized body", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "x".repeat(300_000), questions: goodQuestions }));
  assert.equal(res.statusCode, 400);
  assert.match((await json(res)).error.message, /exceeds/);
});

test("rejects a state longer than the tenant allows, but accepts one within it", async () => {
  const { handler } = await harness({ tenant: { max_state_chars: 20 } });
  assert.equal((await handler(post({ state: "x".repeat(21), questions: goodQuestions }))).statusCode, 400);
  assert.equal((await handler(post({ state: "x".repeat(20), questions: goodQuestions }))).statusCode, 200);
});

test("rejects invalid questions with the caller's own message", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "s", questions: { q: { type: "choice", instructions: "Pick", criteria: { only: "one" } } } }));
  assert.equal(res.statusCode, 400);
  assert.match((await json(res)).error.message, /2-255 options/);
});

test("rejects bad bands", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "s", questions: goodQuestions, bands: { act: 0.3, review: 0.9 } }));
  assert.equal(res.statusCode, 400);
  assert.match((await json(res)).error.message, /review <= act/);
});

/* ----------------------------------------------------------------------- caching */

test("serves a repeat request from the shared cache", async () => {
  const { handler, decider, dynamo } = await harness();
  const request = () => post({ state: "same", questions: goodQuestions });

  const first = await handler(request());
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers?.["x-cache"], "miss");

  const second = await handler(request());
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers?.["x-cache"], "hit-l0", "the in-process tier answers first");
  assert.equal((await json(second)).cached, true);
  assert.equal(decider.calls.length, 1, "the model was called exactly once");

  // The shared write is deliberately not awaited on the hot path, so let it land.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    [...dynamo.items.keys()].some((k) => k.startsWith("CACHE#")),
    "and the shared tier was written for the next execution environment",
  );
});

test("treats reordered keys as the same request", async () => {
  const { handler, decider } = await harness();
  const reordered = { questions: goodQuestions, state: "same" };
  await handler(post({ state: "same", questions: goodQuestions }));
  await handler(post(reordered));
  assert.equal(decider.calls.length, 1);
});

test("does not serve the cache across tenants", async () => {
  const { handler, decider, dynamo } = await harness();
  await handler(post({ state: "same", questions: goodQuestions }));

  // A second tenant with the same questions must not inherit the first one's answer.
  const { createHash } = await import("node:crypto");
  const other = createHash("sha256").update("pk_other").digest("hex");
  dynamo.items.set(`KEY#${other}`, { pk: `KEY#${other}`, tenant: "globex", app: "support" });
  dynamo.items.set("TENANT#globex", {
    pk: "TENANT#globex",
    default_model: "strands-decider-2B-qwen3.5-v1-2610",
    allowed_models: ["strands-decider-2B-qwen3.5-v1-2610"],
  });
  clearCaches();

  await handler(post({ state: "same", questions: goodQuestions }, { "x-api-key": "pk_other" }));
  assert.equal(decider.calls.length, 2);
});

test("honours cache:false and a zero TTL", async () => {
  const { handler, decider } = await harness();
  const uncached = () => post({ state: "same", questions: goodQuestions, cache: false });
  await handler(uncached());
  await handler(uncached());
  assert.equal(decider.calls.length, 2, "cache:false skips the lookup entirely");

  const zero = await harness({ tenant: { cache_ttl_seconds: 0 } });
  await zero.handler(post({ state: "same", questions: goodQuestions }));
  await zero.handler(post({ state: "same", questions: goodQuestions }));
  assert.equal(zero.decider.calls.length, 2, "ttl 0 means never cache");
});

/* ------------------------------------------------------------------- redaction */

test("redacts PII before the model sees it, and before the cache key is computed", async () => {
  const { handler, decider } = await harness();
  await handler(post({ state: "customer bob@example.com on 4111 1111 1111 1111", questions: goodQuestions }));

  const sent = JSON.stringify(decider.calls[0]?.body);
  assert.ok(!sent.includes("bob@example.com"), "email must not reach the model");
  assert.ok(!sent.includes("4111111111111111"));
  assert.ok(sent.includes("[REDACTED:email]"));
  assert.ok(sent.includes("[REDACTED:card]"));
});

test("two states that differ only in PII share one cache entry", async () => {
  const { handler, decider } = await harness();
  await handler(post({ state: "mail bob@example.com", questions: goodQuestions }));
  const res = await handler(post({ state: "mail alice@example.com", questions: goodQuestions }));
  assert.equal(res.headers?.["x-cache"], "hit-l0");
  assert.equal(decider.calls.length, 1);
});

test("the shared cache also collapses PII-equivalent requests", async () => {
  // The L0 identity of the first request is discarded by building a second handler, which
  // stands in for a second Lambda execution environment sharing only DynamoDB.
  const first = await harness();
  await first.handler(post({ state: "mail bob@example.com", questions: goodQuestions }));

  const second = await harnessWithTable(first.dynamo);
  const res = await second.handler(post({ state: "mail alice@example.com", questions: goodQuestions }));
  assert.equal(res.headers?.["x-cache"], "hit-l1");
  assert.equal(second.decider.calls.length, 0);
});

test("a tenant can narrow or widen the redaction set", async () => {
  const { handler, decider } = await harness({ tenant: { redact: [] } });
  await handler(post({ state: "mail bob@example.com", questions: goodQuestions }));
  assert.ok(JSON.stringify(decider.calls[0]?.body).includes("bob@example.com"));
});

/* ----------------------------------------------------------------------- quota */

test("throttles once a tenant exceeds its hourly allowance", async () => {
  const { handler, decider } = await harness({ tenant: { requests_per_hour: 2 } });
  const request = (state: string) => post({ state, questions: goodQuestions });

  assert.equal((await handler(request("one"))).statusCode, 200);
  assert.equal((await handler(request("two"))).statusCode, 200);
  const third = await handler(request("three"));
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers?.["retryable"], "true");
  assert.equal(decider.calls.length, 2);
});

test("a failed model call does not consume quota", async () => {
  const { handler } = await harness({ tenant: { requests_per_hour: 1 }, status: 500, retries: 0 });
  const request = (state: string) => post({ state, questions: goodQuestions });

  assert.equal((await handler(request("one"))).statusCode, 502);
  // The reservation was released, so the single allowed slot is still available.
  assert.equal((await handler(request("two"))).statusCode, 502, "still 502, not 429");
});

/* -------------------------------------------------------------- upstream errors */

test("retries a retryable upstream failure and then succeeds", async () => {
  const { handler, decider } = await harness({ failFirst: 2, failStatus: 503 });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 200);
  assert.equal(decider.calls.length, 3, "two failures plus the success");
});

test("gives up after the retry budget and reports a bad gateway", async () => {
  const { handler } = await harness({ status: 503, retries: 1 });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 502);
  assert.equal((await json(res)).error.code, "upstream");
  assert.equal((await json(res)).error.message, "model error", "upstream detail is not leaked");
});

test("maps a model-side 400 to a caller-side 400", async () => {
  const { handler } = await harness({ status: 400, retries: 0, body: '{"detail":"bad questions"}' });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 400);
  assert.equal((await json(res)).error.code, "invalid_request");
});

test("reports a malformed model response rather than a partial answer", async () => {
  const { handler } = await harness({ answers: {}, model: "m" });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 502);
  assert.match((await json(res)).error.message, /model error/);
});

test("an answer naming an unknown option is a malformed response, not a 200", async () => {
  const { handler } = await harness({ answers: { deploy: { choice: "nope", probabilities: {} } } });
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.equal(res.statusCode, 502);
});

/* --------------------------------------------------------------------- routing */

test("answers CORS preflight without touching anything downstream", async () => {
  const { handler, decider } = await harness();
  const res = await handler(event({ method: "OPTIONS", headers: { origin: "https://example.com" } }));
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers?.["access-control-allow-origin"], "*");
  assert.match(String(res.headers?.["access-control-allow-headers"]), /x-api-key/);
  assert.equal(decider.calls.length, 0);
});

test("serves a health check", async () => {
  const { handler } = await harness();
  const res = await handler(event({ method: "GET", path: "/healthz" }));
  assert.equal(res.statusCode, 200);
  assert.equal((await json(res)).ok, true);
});

test("answers GET / with a pointer when no client is configured", async () => {
  const { handler } = await harness();
  const res = await handler(event({ method: "GET", path: "/" }));
  assert.equal(res.statusCode, 200);
  assert.equal((await json(res)).endpoint, "POST /v1/systemone");
});

test("404s an unknown route and 405s an unknown method", async () => {
  const { handler } = await harness();
  assert.equal((await handler(event({ method: "GET", path: "/nope" }))).statusCode, 404);
  assert.equal((await handler(event({ method: "DELETE", path: "/v1/systemone" }))).statusCode, 405);
});

test("accepts the API at / as well as /v1/systemone", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "s", questions: goodQuestions }, { "x-api-key": KEY }, "/"));
  assert.equal(res.statusCode, 200);
});

test("decodes a base64-encoded body", async () => {
  const { handler } = await harness();
  const body = Buffer.from(JSON.stringify({ state: "s", questions: goodQuestions })).toString("base64");
  const res = await handler(event({ method: "POST", headers: { "x-api-key": KEY }, body, isBase64Encoded: true }));
  assert.equal(res.statusCode, 200);
});

/* -------------------------------------------------------------------- security */

test("never echoes the API key back", async () => {
  const { handler } = await harness();
  const res = await handler(post({ state: "s", questions: goodQuestions }));
  assert.ok(!JSON.stringify(res).includes(KEY));
});

test("sets hardening headers on every response", async () => {
  const { handler } = await harness();
  for (const result of [await handler(post({ state: "s", questions: goodQuestions })), await handler(event({ method: "GET", path: "/nope" }))]) {
    assert.equal(result.headers?.["x-content-type-options"], "nosniff");
    assert.equal(result.headers?.["cache-control"], "no-store");
  }
});
