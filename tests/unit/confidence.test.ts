import assert from "node:assert/strict";
import { test } from "node:test";
import { gate, metricsOf, parseAnswer, summarise, validateBands } from "../../gateway/confidence.ts";
import { DecideError } from "../../gateway/errors.ts";
import { compileRedactions, redact } from "../../gateway/redact.ts";
import { cacheKey, TtlCache } from "../../gateway/cache.ts";

const choiceQ = { type: "choice", instructions: "Pick", criteria: { a: "first", b: "second" } } as const;

test("metricsOf renormalises before measuring", () => {
  const m = metricsOf([2, 2]);
  assert.equal(m.top, 0.5);
  assert.equal(m.margin, 0);
  assert.ok(m.certainty < 0.001, "a uniform vector has no certainty");
});

test("a concentrated vector is fully certain", () => {
  const m = metricsOf([1, 0, 0]);
  assert.equal(m.top, 1);
  assert.equal(m.margin, 1);
  assert.equal(m.certainty, 1);
});

test("a single-option vector is certain, not NaN", () => {
  assert.deepEqual(metricsOf([0.9]), { top: 1, margin: 1, certainty: 1 });
});

test("parseAnswer turns a choice into probabilities keyed by option", () => {
  const r = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.7, b: 0.3 } });
  assert.equal(r.type, "choice");
  assert.equal(r.choice, "a");
  assert.deepEqual(r.probabilities, { a: 0.7, b: 0.3 });
  assert.equal(r.top, 0.7);
});

test("parseAnswer fills a missing option with zero rather than dropping it", () => {
  const r = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.8 } });
  assert.equal(r.type === "choice" && r.probabilities["b"], 0);
});

test("parseAnswer keeps the model's own confidence separate from our metrics", () => {
  const r = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.41 });
  assert.equal(r.vendorConfidence, 0.41);
  assert.equal(r.top, 0.6);
});

test("parseAnswer rejects an option the question never offered", () => {
  assert.throws(
    () => parseAnswer("d", choiceQ, { choice: "c", probabilities: { a: 0.5, b: 0.5 } }),
    (e: unknown) => e instanceof DecideError && e.code === "malformed_response",
  );
});

test("parseAnswer scores over the question's level count, not the response's", () => {
  const q = { type: "score", instructions: "Rate", criteria: ["low", "mid", "high"] } as const;
  const r = parseAnswer("risk", q, { probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } });
  assert.equal(r.type, "score");
  if (r.type !== "score") return;
  assert.equal(r.level, 2);
  assert.equal(Math.round(r.score * 100) / 100, 1.6);
  assert.equal(r.legend["2"], "high");
});

test("parseAnswer falls back to the caller's criteria strings for the legend", () => {
  const q = { type: "score", instructions: "Rate", criteria: ["low", "high"] } as const;
  const r = parseAnswer("risk", q, { probabilities: { "0": 0.5, "1": 0.5 } });
  assert.equal(r.type === "score" && r.legend["0"], "low");
  assert.equal(r.type === "score" && r.legend["1"], "high");
});

test("parseAnswer prefers the model's own legend when it sends one", () => {
  const q = { type: "score", instructions: "Rate", criteria: ["low", "high"] } as const;
  const r = parseAnswer("risk", q, { probabilities: { "0": 0.5, "1": 0.5 }, legend: { "0": "negligible", "1": "severe" } });
  assert.equal(r.type === "score" && r.legend["0"], "negligible");
});

test("parseAnswer flips the noul verdict at exactly 0.5", () => {
  const q = { type: "noul", instructions: "Is it?" } as const;
  const verdictOf = (p: number): boolean => {
    const r = parseAnswer("n", q, p);
    assert.equal(r.type, "noul");
    return r.type === "noul" ? r.verdict : false;
  };
  assert.equal(verdictOf(0.5), true);
  assert.equal(verdictOf(0.4999), false);
  assert.throws(() => parseAnswer("n", q, 1.2), DecideError);
});

test("gate buckets on the requested metric, and vendor falls back to top", () => {
  const bands = { act: 0.9, review: 0.5, metric: "vendor" } as const;
  const withVendor = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.55, b: 0.45 }, confidence: 0.95 });
  assert.equal(gate(withVendor, bands), "act");
  const withoutVendor = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.55, b: 0.45 } });
  assert.equal(gate(withoutVendor, bands), "review");
});

test("gate covers all three bands", () => {
  const bands = { act: 0.7, review: 0.4 } as const;
  // `gate` scores the confidence of the *winning* answer, and the model's winner is always
  // the argmax — so the bands are reached through how spread the probabilities are, not
  // through which option won.
  const confident = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.9, b: 0.1 } });
  const middling = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.58, b: 0.42 } });
  const coinFlip = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.5, b: 0.5 } });
  assert.equal(gate(confident, bands), "act");
  assert.equal(gate(middling, bands), "review");
  assert.equal(gate(coinFlip, bands), "review", "0.5 sits exactly on the review floor");

  // Pulling the floor up past 0.5 is the only way a two-option answer escalates.
  assert.equal(gate(coinFlip, { act: 0.9, review: 0.6 }), "escalate");
});

test("validateBands insists review <= act", () => {
  assert.throws(() => validateBands({ act: 0.3, review: 0.8 }), DecideError);
  assert.throws(() => validateBands({ act: 1.2, review: 0.5 }), DecideError);
  validateBands({ act: 0.8, review: 0.5 });
});

test("summarise keeps numbers and drops text", () => {
  const r = parseAnswer("d", choiceQ, { choice: "a", probabilities: { a: 0.75, b: 0.25 } });
  const s = summarise(r, "act");
  // A 0.75/0.25 split is not a confident one: entropy is high, so certainty stays low.
  assert.deepEqual(s, { type: "choice", top: 0.75, margin: 0.5, certainty: 0.189, band: "act" });
  assert.equal(JSON.stringify(s).includes("first"), false, "descriptions never reach the audit record");
});

test("TtlCache expires and evicts the least recently used", () => {
  let now = 0;
  const cache = new TtlCache<number>(10, 2, () => now);
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // refreshes a's recency
  cache.set("c", 3); // evicts b
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  now = 10_001;
  assert.equal(cache.get("a"), undefined, "expired");
  assert.equal(cache.get("c"), undefined, "expired too");
  assert.equal(cache.size, 0, "reading an expired key drops it; `c` is dropped on write-over");
});

test("redact scrubs strings at any depth and leaves other types alone", () => {
  const rules = compileRedactions(["email", "card", "phone"]);
  const input = {
    note: "mail bob@example.com or call +1 (555) 123-4567",
    card: "4111 1111 1111 1111",
    count: 3,
    nested: [{ ok: true, deep: "x@y.co" }],
    nothing: null,
  };
  const out = redact(input, rules);
  assert.equal(out.count, 3);
  assert.equal(out.nothing, null);
  assert.equal(out.card, "[REDACTED:card]");
  assert.ok(!JSON.stringify(out).includes("bob@example.com"));
  assert.ok(!JSON.stringify(out).includes("x@y.co"));
  assert.ok(out.note.includes("[REDACTED:email]"));
  assert.ok(out.note.includes("[REDACTED:phone]"));
});

test("redact is a no-op with no rules, and custom patterns compile", () => {
  const value = { a: "secret-123" };
  assert.equal(redact(value, []), value);
  const custom = compileRedactions(["secret-\\d+"]);
  assert.equal(redact(value, custom).a, "[REDACTED:custom]");
  assert.throws(() => compileRedactions(["["]), /invalid redaction pattern/);
});

test("cacheKey ignores key order but not values", () => {
  const a = cacheKey("t", "app", "m", { x: 1, y: 2 }, { q: { z: [1, 2] } });
  const b = cacheKey("t", "app", "m", { y: 2, x: 1 }, { q: { z: [1, 2] } });
  const c = cacheKey("t", "app", "m", { x: 2, y: 1 }, { q: { z: [1, 2] } });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test("cacheKey separates tenants", () => {
  assert.notEqual(cacheKey("acme", "app", "m", "s", {}), cacheKey("globex", "app", "m", "s", {}));
});
