// k6 load test for the decider gateway.
//
// Unlike the reference gateway's test, there is no WebSocket here: a system-one decider
// answers in one shot, so the interesting dimension is not streaming but *confidence* and
// *cold starts*, both of which this measures.
//
//   ./run.sh baseline
//
// Scenarios: baseline | load | burst | coldstart | quota | mixed
//
// A note on sizing. The model Lambda has `reservedConcurrentExecutions: 4` and a warm
// request costs 3-5 s and ~$0.0007. Beyond four concurrent callers every extra request
// queues for a free instance, and once it waits longer than the gateway's 45 s per-attempt
// deadline it becomes a retry — so `load` is expected to bend sharply, and that bend is the
// finding, not a failure. Ship the model to more instances (a second deployment, or Fargate)
// if you need the flat part to extend further right.
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const cfg = JSON.parse(open("./config.json"));
const SCENARIO = __ENV.SCENARIO || "baseline";
const LOAD_MAX = Number(__ENV.LOAD_MAX || 50);
const TIMEOUT_MS = Number(__ENV.TIMEOUT_MS || 60000);
const URL = `${cfg.gatewayUrl.replace(/\/$/, "")}/v1/systemone`;

const latency = new Trend("gw_latency", true);
const modelLatency = new Trend("gw_model_latency", true);
const success = new Rate("gw_success");
const confidenceFloor = new Trend("gw_confidence_floor");
const cacheHits = new Counter("gw_cache_hits");
const coldStarts = new Counter("gw_cold_starts");
const quota429 = new Counter("gw_quota_429");
const badRequests = new Counter("gw_4xx");
const serverErrors = new Counter("gw_5xx");

const TENANTS = cfg.tenants?.length ? cfg.tenants : [{ tenant: "acme", app: "support", apiKey: "" }];

// Three question shapes, because the model's cost and its confidence behave differently
// across them and a load test that only exercises `noul` would miss a score-path regression.
const QUESTIONS = {
  noul: {
    state: "A customer asks whether their refund will arrive before the weekend. The order shipped 2 days ago, standard delivery is 3-5 days, and today is Thursday.",
    questions: {
      before_weekend: { type: "noul", instructions: "Will the refund arrive before the weekend?" },
    },
  },
  choice: {
    state: {
      service: "checkout-api",
      change: "raise the payment client's retry budget from 3 to 5",
      canary_error_rate: "0.42% vs 0.38% baseline",
      canary_p95_ms: 812,
      baseline_p95_ms: 640,
    },
    questions: {
      deploy: {
        type: "choice",
        instructions: "What should be done with this change?",
        criteria: { ship: "release now", hold: "wait an hour", revert: "roll back" },
      },
    },
  },
  score: {
    state: { amount: 42000, term_months: 60, dti: 0.31, delinquencies_24m: 0, score: 712 },
    questions: {
      risk: {
        type: "score",
        instructions: "Place this application on the risk scale.",
        criteria: ["very low", "low", "moderate", "elevated", "high"],
      },
    },
  },
};

/** Bodies keyed by cache-ability, so `cache` can measure the hit path and `coldstart` can bypass it. */
function bodyFor(kind, cache) {
  const base = QUESTIONS[kind];
  return JSON.stringify({ ...base, bands: { act: 0.6, review: 0.4 }, cache });
}

/** Vary the state, so the cache is genuinely missed when we want a miss. */
function uniqueBody(kind, seq) {
  const base = QUESTIONS[kind];
  const state =
    typeof base.state === "string" ? `${base.state} (variant ${seq})` : { ...base.state, seq };
  return JSON.stringify({ ...base, state, bands: { act: 0.6, review: 0.4 }, cache: true });
}

function record(res) {
  latency.add(res.timings.duration);
  const ok = res.status === 200;
  success.add(ok);
  if (res.status === 429) quota429.add(1);
  else if (res.status >= 500) serverErrors.add(1);
  else if (res.status >= 400) badRequests.add(1);
  if (res.headers["X-Cache"] && res.headers["X-Cache"] !== "miss") cacheHits.add(1);
  if (res.headers["X-Cold-Start"] === "1") coldStarts.add(1);
  if (ok) {
    const body = res.json();
    if (typeof body.model_latency_ms === "number") modelLatency.add(body.model_latency_ms);
    if (typeof body.answers?.deploy === "object" && body.answers.deploy.top !== undefined) {
      confidenceFloor.add(body.answers.deploy.top);
    }
  }
  return ok;
}

const params = (apiKey) => ({
  headers: { "content-type": "application/json", "x-api-key": apiKey },
  timeout: `${TIMEOUT_MS}ms`,
  tags: { scenario: SCENARIO },
});

export const options = {
  scenarios: {
    // 10 users, one request each: the smoke test you run after every deploy.
    baseline: { executor: "per-vu-iterations", vus: 10, iterations: 1, maxDuration: "10m", exec: "steady" },
    // Ramp past the model's concurrency ceiling to find where latency bends.
    load: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: "1m", target: 2 },
        { duration: "1m", target: 4 },
        { duration: "2m", target: LOAD_MAX },
        { duration: "30s", target: 0 },
      ],
      exec: "steady",
    },
    // All at once, to see how the retry ladder behaves under a thundering herd.
    burst: { executor: "shared-iterations", vus: LOAD_MAX, iterations: LOAD_MAX, maxDuration: "5m", exec: "steady" },
    // Bypass the cache entirely, so every iteration is a model call. The expensive one.
    coldstart: { executor: "per-vu-iterations", vus: 2, iterations: 4, maxDuration: "10m", exec: "uncached" },
    // Exceed the `trial` tenant's 20/hour and confirm the gateway says 429, not 500.
    quota: { executor: "per-vu-iterations", vus: 5, iterations: 8, maxDuration: "10m", exec: "quota" },
    // Steady traffic across all three question shapes and every tenant.
    mixed: { executor: "constant-vus", vus: 6, duration: "2m", exec: "mixed" },
  },
  thresholds: {
    gw_5xx: ["count<5"], // a 5xx is always a bug in the gateway
    gw_success: ["rate>0.80"], // 429s under load are expected; a flood of them is not
  },
};

// Run only the selected scenario. k6 has no "disabled" flag, so the others are removed
// entirely rather than given an `exec` nothing calls — a scenario that still allocates VUs
// shows up in the results as a run that did nothing, which reads like a broken test.
if (SCENARIO in options.scenarios) {
  options.scenarios = { [SCENARIO]: options.scenarios[SCENARIO] };
}

export function steady() {
  const tenant = randomItem(TENANTS);
  const kind = randomItem(["noul", "choice", "score"]);
  // Alternate cached and unique bodies, so the cache is exercised but not assumed.
  const body = __ITER % 2 === 0 ? bodyFor(kind, true) : uniqueBody(kind, `${__VU}-${__ITER}`);
  record(
    http.post(URL, body, {
      ...params(tenant.apiKey),
      tags: { scenario: SCENARIO, tenant: tenant.tenant, kind },
    }),
  );
}

export function uncached() {
  const tenant = TENANTS[0];
  // A unique state per call, so the cache key never repeats and every call is a real miss.
  const res = http.post(URL, uniqueBody("noul", `${__VU}-${__ITER}-${Date.now()}`), {
    ...params(tenant.apiKey),
    tags: { scenario: "coldstart", tenant: tenant.tenant },
  });
  record(res);
  sleep(1);
}

export function quota() {
  const trial = TENANTS.find((t) => t.tenant === "trial") ?? TENANTS[0];
  const res = http.post(URL, uniqueBody("noul", `${__VU}-${__ITER}`), {
    ...params(trial.apiKey),
    tags: { scenario: "quota", tenant: trial.tenant },
  });
  const ok = record(res);
  if (res.status === 429) {
    check(res, { "quota is a 429 with a retryable header": (r) => r.headers["Retryable"] === "true" });
  }
  if (!ok && res.status !== 429) {
    check(res, { "over-quota failures are never 5xx": (r) => r.status < 500 });
  }
}

export function mixed() {
  const tenant = randomItem(TENANTS);
  for (const kind of Object.keys(QUESTIONS)) {
    record(
      http.post(URL, uniqueBody(kind, `${__VU}-${__ITER}-${kind}`), {
        ...params(tenant.apiKey),
        tags: { scenario: "mixed", tenant: tenant.tenant, kind },
      }),
    );
    sleep(0.5);
  }
}
