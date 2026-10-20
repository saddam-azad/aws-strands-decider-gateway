import assert from "node:assert/strict";
import { test } from "node:test";
import { DecideError, publicMessage, STATUS } from "../../gateway/errors.ts";
import { parseQuestions, parseState, LIMITS } from "../../gateway/validate.ts";

const ok = { instructions: "Pick one", criteria: { a: "first", b: "second" } };

test("accepts the three question types", () => {
  const questions = parseQuestions({
    c: { type: "choice", ...ok },
    s: { type: "score", instructions: "How bad?", criteria: ["mild", "severe"] },
    n: { type: "noul", instructions: "Is it?" },
  });
  assert.deepEqual(Object.keys(questions), ["c", "s", "n"]);
});

test("choice and noul criteria descriptions may be null, as the decider allows", () => {
  parseQuestions({ c: { type: "choice", instructions: "Pick", criteria: { a: null, b: "second" } } });
  parseQuestions({
    n: { type: "noul", instructions: "Is it?", criteria: { true: "yes it is", false: null } },
  });
});

test("score levels must be strings, matching the model's own schema", () => {
  // `ScoreQuestion.criteria` is `list[str]`, not `list[Content]`, so a null level is a 422
  // three seconds into a forward pass. Refusing it here turns that into a 400 in the gateway.
  assert.throws(
    () => parseQuestions({ s: { type: "score", instructions: "Rate", criteria: [null, "severe"] } }),
    (e: unknown) => e instanceof DecideError && /level 0 must be a string/.test(e.message),
  );
});

test("noul criteria keys must be true or false", () => {
  assert.throws(
    () => parseQuestions({ n: { type: "noul", instructions: "x", criteria: { yes: "y" } } }),
    (e: unknown) => e instanceof DecideError && /"true" or "false"/.test(e.message),
  );
});

test("rejects an unknown question type", () => {
  assert.throws(
    () => parseQuestions({ c: { type: "ranking", instructions: "x" } }),
    (e: unknown) => e instanceof DecideError && /type must be/.test(e.message),
  );
});

test("rejects a choice with too few options", () => {
  assert.throws(
    () => parseQuestions({ c: { type: "choice", instructions: "Pick", criteria: { only: "yes" } } }),
    (e: unknown) => e instanceof DecideError && /2-255 options/.test(e.message),
  );
});

test("rejects a choice above the engine's option ceiling", () => {
  const criteria = Object.fromEntries(Array.from({ length: LIMITS.maxChoices + 1 }, (_, i) => [`o${i}`, "x"]));
  assert.throws(() => parseQuestions({ c: { type: "choice", instructions: "Pick", criteria } }), DecideError);
});

test("rejects a score above the engine's level ceiling", () => {
  const criteria = Array.from({ length: LIMITS.maxScoreLevels + 1 }, (_, i) => `level ${i}`);
  assert.throws(
    () => parseQuestions({ s: { type: "score", instructions: "Rate", criteria } }),
    (e: unknown) => e instanceof DecideError && /2-10 levels/.test(e.message),
  );
});

test("rejects empty instructions but allows empty state", () => {
  assert.throws(() => parseQuestions({ c: { type: "noul", instructions: "   " } }), DecideError);
  // The decider lets `state` be empty when the question carries the whole task.
  assert.equal(parseState(""), "");
});

test("state accepts string, object and array, and nothing else", () => {
  assert.deepEqual(parseState({ a: [1, 2] }), { a: [1, 2] });
  assert.deepEqual(parseState([1, "x"]), [1, "x"]);
  assert.throws(() => parseState(null), DecideError);
  assert.throws(() => parseState(42), DecideError);
  assert.throws(() => parseState(undefined), DecideError);
});

test("state length is bounded per tenant", () => {
  assert.throws(() => parseState("x".repeat(11), 10), (e: unknown) => e instanceof DecideError && /10 characters/.test(e.message));
  assert.equal(parseState("x".repeat(10), 10).length, 10);
});

test("question names are bounded", () => {
  assert.throws(() => parseQuestions({ ["n".repeat(LIMITS.maxNameLength + 1)]: { type: "noul", instructions: "x" } }), DecideError);
  assert.throws(() => parseQuestions({ "": { type: "noul", instructions: "x" } }), DecideError);
});

test("every error code has a status and a safe public message", () => {
  // `auth` is the only code whose message is allowed through: it means "this Lambda cannot
  // reach the model", which the caller can neither cause nor fix — but the operator must see.
  for (const code of Object.keys(STATUS) as (keyof typeof STATUS)[]) {
    assert.equal(typeof STATUS[code], "number");
    const error = new DecideError(code, "internal detail: /var/task/secret");
    // `invalid_request` echoes the caller's own message; `auth` is the one internal code
    // whose detail is deliberately forwarded, because it means "this deployment cannot
    // reach the model" — the caller cannot cause it, and an operator must be able to see it.
    if (code === "auth" || code === "invalid_request") {
      assert.equal(publicMessage(error), error.message);
      continue;
    }
    const message = publicMessage(error);
    assert.ok(!message.includes("secret"), `${code} leaked detail`);
    assert.ok(!/[A-Za-z0-9+/]{40}/.test(message), `${code} looks like it leaked a token`);
  }
});

test("invalid_request keeps the caller's own message", () => {
  assert.equal(publicMessage(new DecideError("invalid_request", "state is required")), "state is required");
});
