import assert from "node:assert/strict";
import { test } from "node:test";
import { decider } from "../../gateway/backends.ts";
import { AwsClient as Vendored } from "../../gateway/vendor/aws4fetch.mjs";
import { DecideError } from "../../gateway/errors.ts";

const QUESTIONS = { q: { type: "noul", instructions: "Is it?" } } as const;

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

test("posts the model's own protocol and parses the answer", async () => {
  let seen: { url: string; body: unknown; headers: Record<string, string> } | undefined;
  const backend = decider({
    baseUrl: "https://internal-alb.us-east-1.elb.amazonaws.com/",
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
      return ok({
        model: "strands-decider-2B-qwen3.5-v1-2610",
        answers: { q: 0.82 },
        usage: { input_tokens: 10, output_tokens: 1 },
        latency_ms: 3_140,
      });
    }) as typeof globalThis.fetch,
  });

  const res = await backend.evaluate({ state: "hello", questions: QUESTIONS, model: "decider-2b" });
  assert.equal(seen?.url, "https://internal-alb.us-east-1.elb.amazonaws.com/v1/systemone", "no doubled slash");
  assert.deepEqual(seen?.body, { state: "hello", questions: QUESTIONS, model: "decider-2b" });
  assert.equal(seen?.headers["content-type"], "application/json");
  assert.equal(res.answers.q, 0.82);
  assert.equal(res.model, "strands-decider-2B-qwen3.5-v1-2610");
  assert.equal(res.upstreamLatencyMs, 3_140);
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 1 });
});

test("preserves a base path in the URL", async () => {
  let url = "";
  const backend = decider({
    baseUrl: "https://example.com/api",
    fetch: (async (u: string) => {
      url = String(u);
      return ok({ answers: { q: 0.5 } });
    }) as typeof globalThis.fetch,
  });
  await backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" });
  assert.equal(url, "https://example.com/api/v1/systemone");
});

test("reads cold-start attribution off the response headers", async () => {
  const cold = decider({
    baseUrl: "https://x",
    fetch: (async () =>
      ok({ answers: { q: 0.5 } }, { "x-decider-cold-start": "true", "x-decider-model-load-ms": "21400" })) as typeof globalThis.fetch,
  });
  const res = await cold.evaluate({ state: "s", questions: QUESTIONS, model: "m" });
  assert.equal(res.coldStart, true);
  assert.equal(res.modelLoadMs, 21_400);
});

test("omits cold-start fields when the model did not report them", async () => {
  const warm = decider({
    baseUrl: "https://x",
    fetch: (async () => ok({ answers: { q: 0.5 } })) as typeof globalThis.fetch,
  });
  const res = await warm.evaluate({ state: "s", questions: QUESTIONS, model: "m" });
  assert.equal("coldStart" in res, false);
  assert.equal("modelLoadMs" in res, false);
});

test("retries a 503 and then succeeds", async () => {
  let calls = 0;
  const backend = decider({
    baseUrl: "https://x",
    retries: 2,
    fetch: (async () => {
      calls += 1;
      return calls <= 2 ? new Response("busy", { status: 503 }) : ok({ answers: { q: 0.6 } });
    }) as typeof globalThis.fetch,
  });
  assert.equal((await backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" })).answers.q, 0.6);
  assert.equal(calls, 3);
});

test("does not retry a 400", async () => {
  let calls = 0;
  const backend = decider({
    baseUrl: "https://x",
    retries: 3,
    fetch: (async () => {
      calls += 1;
      return new Response('{"detail":"bad"}', { status: 400 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
    (e: unknown) => e instanceof DecideError && e.code === "invalid_request" && e.status === 400,
  );
  assert.equal(calls, 1);
});

test("maps status codes onto error codes", async () => {
  const cases: [number, string][] = [
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [422, "invalid_request"],
    [500, "upstream"],
  ];
  for (const [status, code] of cases) {
    const backend = decider({
      baseUrl: "https://x",
      retries: 0,
      fetch: (async () => new Response("nope", { status })) as typeof globalThis.fetch,
    });
    await assert.rejects(
      () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
      (e: unknown) => e instanceof DecideError && e.code === code,
      `HTTP ${status} should map to ${code}`,
    );
  }
});

test("never puts the upstream body in the message for a 5xx", async () => {
  const backend = decider({
    baseUrl: "https://x",
    retries: 0,
    fetch: (async () => new Response('{"secret":"token-abc123"}', { status: 500 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
    (e: unknown) => {
      assert.ok(e instanceof DecideError);
      assert.ok(!e.message.includes("token-abc123"));
      return true;
    },
  );
});

test("reports a non-JSON body as a malformed response", async () => {
  const backend = decider({
    baseUrl: "https://x",
    fetch: (async () => new Response("<html>gateway timeout</html>", { status: 200 })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
    (e: unknown) => e instanceof DecideError && e.code === "malformed_response",
  );
});

test("reports a JSON body with no answers as a malformed response", async () => {
  const backend = decider({
    baseUrl: "https://x",
    fetch: (async () => ok({ model: "m" })) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
    (e: unknown) => e instanceof DecideError && /no "answers"/.test(e.message),
  );
});

test("treats a timeout as retryable, then reports a timeout error", async () => {
  const backend = decider({
    baseUrl: "https://x",
    retries: 1,
    timeoutMs: 20,
    fetch: (async (_url: string, init: RequestInit) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        });
      });
      return ok({ answers: { q: 0.5 } });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => backend.evaluate({ state: "s", questions: QUESTIONS, model: "m" }),
    (e: unknown) => e instanceof DecideError && e.code === "timeout" && e.retryable,
  );
});

test("aborts the attempt when the caller's signal fires", async () => {
  const controller = new AbortController();
  const backend = decider({
    baseUrl: "https://x",
    retries: 2,
    timeoutMs: 60_000,
    fetch: (async (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      })) as typeof globalThis.fetch,
  });
  const promise = backend.evaluate({ state: "s", questions: QUESTIONS, model: "m", signal: controller.signal });
  controller.abort(new Error("caller went away"));
  await assert.rejects(promise, /caller went away/);
});

/* ---------------------------------------------------------------------- vendored aws4fetch */

test("the vendored aws4fetch still signs correctly", async () => {
  const client = new Vendored({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "session-token",
    region: "us-east-1",
    service: "execute-api",
    retries: 0,
  });
  const signed = await client.sign("https://x.example/v1/systemone", { method: "POST", body: "{}" });
  assert.ok(signed.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256"), "signed with v4 algorithm");
  assert.equal(signed.headers.get("x-amz-security-token"), "session-token");
});
