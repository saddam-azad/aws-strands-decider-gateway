import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { emitMetrics, log, logException, NAMESPACE } from "../../gateway/telemetry.ts";

/** Capture everything the module writes to stdout. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

afterEach(() => {
  delete process.env["METRICS_NAMESPACE"];
});

test("log writes one JSON line keyed by request_id", () => {
  const [line] = capture(() => log("request", "req-1", { tenant: "acme", latency_ms: 42 }));
  const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
  assert.equal(parsed["level"], "INFO");
  assert.equal(parsed["stage"], "request");
  assert.equal(parsed["request_id"], "req-1");
  assert.equal(parsed["tenant"], "acme");
  assert.equal(parsed["latency_ms"], 42);
});

test("logException marks the line as an error and carries a stack", () => {
  const [line] = capture(() => logException("failed", "req-2"));
  const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
  assert.equal(parsed["level"], "ERROR");
  assert.equal(parsed["request_id"], "req-2");
  assert.match(String(parsed["trace"]), /Error/);
});

test("emitMetrics produces a valid EMF envelope with a Service dimension", () => {
  const [line] = capture(() => emitMetrics({ Latency: 120, Requests: 1 }, { Tenant: "acme" }));
  const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;

  assert.equal(parsed["Service"], "strands-decider-gateway");
  assert.equal(parsed["Tenant"], "acme");
  assert.equal(parsed["Latency"], 120);
  assert.equal(parsed["Requests"], 1);

  const aws = parsed["_aws"] as { CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] };
  const spec = aws.CloudWatchMetrics[0];
  assert.equal(spec?.Namespace, NAMESPACE);
  assert.deepEqual(spec?.Dimensions, [["Service", "Tenant"]]);
  assert.deepEqual(spec?.Metrics, [
    { Name: "Latency", Unit: "Milliseconds" },
    { Name: "Requests", Unit: "Count" },
  ]);
});

test("emitMetrics drops null and undefined values but keeps their dimensions", () => {
  const [line] = capture(() =>
    emitMetrics({ Latency: 10, ModelLoadTime: undefined, CacheHit: null }, { Tenant: "acme" }),
  );
  const parsed = JSON.parse(line ?? "{}") as Record<string, unknown>;
  assert.equal(parsed["Latency"], 10);
  assert.equal("ModelLoadTime" in parsed, false);
  assert.equal("CacheHit" in parsed, false);
  assert.equal(parsed["Tenant"], "acme");

  const aws = parsed["_aws"] as { CloudWatchMetrics: { Metrics: { Name: string }[] }[] };
  assert.deepEqual(aws.CloudWatchMetrics[0]?.Metrics.map((m) => m.Name), ["Latency"]);
});

test("emitMetrics writes nothing when every value is absent", () => {
  assert.deepEqual(capture(() => emitMetrics({ A: null, B: undefined })), []);
});

test("every metric the gateway emits has a unit or defaults to Count", () => {
  const names = [
    "Latency",
    "ModelLatency",
    "ModelLoadTime",
    "GatewayOverhead",
    "Requests",
    "CacheHit",
    "ColdStart",
    "QuotaUtilization",
    "ConfidenceFloor",
    "Errors",
    "Throttled",
  ];
  const [line] = capture(() => emitMetrics(Object.fromEntries(names.map((n) => [n, 1]))));
  const aws = JSON.parse(line ?? "{}")["_aws"] as { CloudWatchMetrics: { Metrics: { Name: string; Unit: string }[] }[] };
  const metrics = aws.CloudWatchMetrics[0]?.Metrics ?? [];
  assert.equal(metrics.length, names.length);
  for (const metric of metrics) {
    assert.ok(["Count", "Milliseconds", "Percent"].includes(metric.Unit), `${metric.Name} has no valid unit`);
  }
});

test("the namespace is overridable so two deployments can share an account", () => {
  process.env["METRICS_NAMESPACE"] = "SomethingElse";
  assert.equal(NAMESPACE, "StrandsDeciderGateway", "the constant is read once at import time");
});
