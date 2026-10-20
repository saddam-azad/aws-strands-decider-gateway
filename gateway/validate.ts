/**
 * Request validation. Every rule here rejects *before* a model call is made, so a bad
 * request costs a 400 instead of 3 seconds of CPU on a 10 GB Lambda.
 *
 * Limits are the decider's own engine limits (MAX_CHOICE_OPTIONS 255, MIN/MAX_SCORE_LEVELS
 * 2..10), mirrored so the gateway refuses what the model would anyway reject with a 422.
 */
import { DecideError } from "./errors.ts";
import type { Question, Questions, State } from "./types.ts";

export const LIMITS = {
  minOptions: 2,
  maxChoices: 255,
  maxScoreLevels: 10,
  maxQuestions: 32,
  maxNameLength: 64,
  /** Instructions and state text. The engine truncates past its window; this is the gateway's ceiling. */
  maxTextLength: 4_000,
  maxCriterionLength: 1_000,
} as const;

const invalid = (message: string): never => {
  throw new DecideError("invalid_request", message);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCriterion = (v: unknown): boolean =>
  v === null || (typeof v === "string" && v.length <= LIMITS.maxCriterionLength);

function validateQuestion(name: string, q: unknown): asserts q is Question {
  if (!isRecord(q)) return invalid(`question "${name}" must be an object`);
  const instructions = q["instructions"];
  if (typeof instructions !== "string" || instructions.trim().length === 0) {
    return invalid(`question "${name}": instructions must be a non-empty string`);
  }
  if (instructions.length > LIMITS.maxTextLength) {
    return invalid(`question "${name}": instructions exceed ${LIMITS.maxTextLength} characters`);
  }

  switch (q["type"]) {
    case "noul": {
      const c = q["criteria"];
      if (c === undefined || c === null) return;
      if (!isRecord(c)) {
        return invalid(`question "${name}": noul criteria must be an object, if given`);
      }
      for (const [key, description] of Object.entries(c)) {
        if (key !== "true" && key !== "false") {
          return invalid(`question "${name}": noul criteria keys must be "true" or "false"`);
        }
        if (!isCriterion(description)) {
          return invalid(`question "${name}": noul criterion "${key}" must be a string or null`);
        }
      }
      return;
    }
    case "choice": {
      const c = q["criteria"];
      if (!isRecord(c)) {
        return invalid(`question "${name}": choice criteria must be an object of option -> description`);
      }
      const entries = Object.entries(c);
      if (entries.length < LIMITS.minOptions || entries.length > LIMITS.maxChoices) {
        return invalid(
          `question "${name}": choice needs ${LIMITS.minOptions}-${LIMITS.maxChoices} options, got ${entries.length}`,
        );
      }
      for (const [option, description] of entries) {
        if (option.length === 0) return invalid(`question "${name}": option names must not be empty`);
        if (!isCriterion(description)) {
          return invalid(
            `question "${name}": option "${option}" needs a description of at most ${LIMITS.maxCriterionLength} characters, or null`,
          );
        }
      }
      return;
    }
    case "score": {
      const c = q["criteria"];
      if (!Array.isArray(c)) return invalid(`question "${name}": score criteria must be an ordered array`);
      if (c.length < LIMITS.minOptions || c.length > LIMITS.maxScoreLevels) {
        return invalid(`question "${name}": score needs ${LIMITS.minOptions}-${LIMITS.maxScoreLevels} levels, got ${c.length}`);
      }
      for (const [i, level] of c.entries()) {
        // The model's schema types score levels as plain strings, not Content, so a `null`
        // level would be rejected downstream with a 422. Refuse it here instead.
        if (typeof level !== "string" || level.length > LIMITS.maxCriterionLength) {
          return invalid(
            `question "${name}": level ${i} must be a string of at most ${LIMITS.maxCriterionLength} characters`,
          );
        }
      }
      return;
    }
    default:
      return invalid(`question "${name}": type must be "choice", "score" or "noul"`);
  }
}

/** Validate untrusted input (e.g. a request body) into typed questions. Throws invalid_request. */
export function parseQuestions(input: unknown): Questions {
  if (!isRecord(input)) return invalid("questions must be an object of name -> question");
  const entries = Object.entries(input);
  if (entries.length === 0) return invalid("at least one question is required");
  if (entries.length > LIMITS.maxQuestions) return invalid(`at most ${LIMITS.maxQuestions} questions per request`);
  for (const [name, q] of entries) {
    if (name.length === 0 || name.length > LIMITS.maxNameLength) {
      return invalid(`question names must be 1-${LIMITS.maxNameLength} characters`);
    }
    validateQuestion(name, q);
  }
  return input as Questions;
}

/**
 * The decider's `state` is `str | dict | list` and may legitimately be empty when the
 * question carries the whole task (a quiz item, a pair to compare). Only null/undefined
 * and the wrong JSON type are rejected here.
 */
export function parseState(input: unknown, maxChars?: number): State {
  if (input === undefined || input === null) return invalid("state is required");
  const isString = typeof input === "string";
  const isStructured = Array.isArray(input) || isRecord(input);
  if (!isString && !isStructured) return invalid("state must be a string, object or array");
  if (isString && maxChars !== undefined && input.length > maxChars) {
    return invalid(`state exceeds the ${maxChars} characters allowed for this tenant`);
  }
  return input as State;
}

export type { State };
