import assert from "node:assert/strict";
import { test } from "node:test";
import { AwsClient as Published } from "aws4fetch";
import { decider, signingFetch } from "../../gateway/backends.ts";
import { AwsClient as Vendored } from "../../gateway/vendor/aws4fetch.mjs";
import { DecideError } from "../../gateway/errors.ts";

const QUESTIONS = { q: { type: "noul", instructions: "Is it?" } } as const;

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

test("posts the model's own protocol and parses the answer", async () => {
  let seen: { url: string; body: unknown; headers: Record<string, string> } | undefined;
  const backend = decider({
    baseUrl: "https://example.lambda-url.us-east-1.on.aws/",
    auth: "none",
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
  assert.equal(seen?.url, "https://example.lambda-url.us-east-1.on.aws/v1/systemone", "no doubled slash");
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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
      auth: "none",
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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
    auth: "none",
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

/* ---------------------------------------------------------------------- SigV4 */

test("signingFetch refuses to sign without credentials", async () => {
  // `signingFetch` is lazy: it returns a fetch that resolves credentials per call, so a
  // missing role shows up as a failed request, not as a failed construction.
  const saved = { ...process.env };
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  delete process.env["AWS_SESSION_TOKEN"];
  const savedFetch = globalThis.fetch;
  try {
    const signedFetch = signingFetch();
    assert.throws(
      () => signedFetch.call(globalThis, "https://x.example/v1/systemone", { method: "POST", body: "{}" }),
      (e: unknown) => e instanceof DecideError && e.code === "auth",
    );
  } finally {
    Object.assign(process.env, saved);
    globalThis.fetch = savedFetch;
  }
});

test("the vendored aws4fetch signs byte-identically to the published package", async () => {
  // This is the whole justification for vendoring: if these ever diverge, the Lambda's
  // signature stops matching and every request 403s, so it is worth a test.
  const credentials = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "session-token",
    region: "us-east-1",
    service: "lambda",
    retries: 0,
  };
  const url = "https://abc123.lambda-url.us-east-1.on.aws/v1/systemone";
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: '{"state":"s"}' };

  const a = await new Vendored(credentials).sign(url, init);
  const b = await new Published(credentials).sign(url, init);

  const auth = (req: Request | undefined) => req?.headers.get("authorization");
  assert.ok(auth(a)?.startsWith("AWS4-HMAC-SHA256"), "signed with the v4 algorithm");
  assert.equal(auth(a), auth(b));
  assert.equal(a?.headers.get("x-amz-security-token"), b?.headers.get("x-amz-security-token"));
  assert.equal(a?.headers.get("x-amz-date"), b?.headers.get("x-amz-date"));
});

test("the vendored signer carries the session token", async () => {
  const client = new Vendored({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "secret",
    sessionToken: "the-session-token",
    region: "us-east-1",
    service: "lambda",
    retries: 0,
  });
  const signed = await client.sign("https://x.example/v1/systemone", { method: "POST", body: "{}" });
  assert.equal(signed.headers.get("x-amz-security-token"), "the-session-token");
});
