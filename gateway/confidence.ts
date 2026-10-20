/**
 * Local confidence metrics and act / review / escalate gating.
 *
 * Every answer carries comparable numbers computed from renormalised probabilities, so
 * they mean the same thing across question types. The decider's own `confidence` is kept
 * beside them untouched as `vendorConfidence`.
 */
import { DecideError } from "./errors.ts";
import type { Band, Bands, ChoiceResult, Metrics, NoulResult, Question, Result, ScoreResult } from "./types.ts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isProb = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

const malformed = (message: string): never => {
  throw new DecideError("malformed_response", message);
};

/** Metrics over a probability vector (renormalised, so rounded answers still work). */
export function metricsOf(probabilities: readonly number[]): Pick<Metrics, "top" | "margin" | "certainty"> {
  const total = probabilities.reduce((a, b) => a + b, 0) || 1;
  const p = probabilities.map((x) => x / total).sort((a, b) => b - a);
  const top = p[0] ?? 0;
  const margin = top - (p[1] ?? 0);
  const entropy = -p.reduce((h, x) => (x > 0 ? h + x * Math.log(x) : h), 0);
  const certainty = p.length > 1 ? clamp01(1 - entropy / Math.log(p.length)) : 1;
  return { top, margin, certainty };
}

const vendor = (raw: Record<string, unknown>): { vendorConfidence?: number } =>
  isProb(raw["confidence"]) ? { vendorConfidence: raw["confidence"] } : {};

/**
 * Turn one raw answer into a typed result. The *question* decides the shape, not the
 * response, because that is what the caller asked for and what they will be gating on.
 */
export function parseAnswer(name: string, question: Question, raw: unknown): Result {
  switch (question.type) {
    case "choice": {
      if (!isRecord(raw) || typeof raw["choice"] !== "string") return malformed(`answer "${name}": missing choice`);
      const keys = Object.keys(question.criteria);
      const picked = raw["choice"];
      if (!keys.includes(picked)) return malformed(`answer "${name}": "${picked}" is not one of ${keys.join(", ")}`);
      const rp = raw["probabilities"];
      if (!isRecord(rp)) return malformed(`answer "${name}": missing probabilities`);
      const probabilities: Record<string, number> = {};
      for (const k of keys) {
        const v = rp[k];
        if (v !== undefined && !isProb(v)) return malformed(`answer "${name}": bad probability for "${k}"`);
        probabilities[k] = v ?? 0;
      }
      const result: ChoiceResult = {
        type: "choice",
        choice: picked,
        probabilities,
        ...metricsOf(Object.values(probabilities)),
        ...vendor(raw),
      };
      return result;
    }
    case "score": {
      if (!isRecord(raw)) return malformed(`answer "${name}": expected an object`);
      const rp = raw["probabilities"];
      if (!isRecord(rp)) return malformed(`answer "${name}": missing probabilities`);
      const levels = question.criteria.length;
      const ps = Array.from({ length: levels }, (_, i) => {
        const v = rp[String(i)];
        if (v !== undefined && !isProb(v)) return malformed(`answer "${name}": bad probability for level ${i}`);
        return (v as number | undefined) ?? 0;
      });
      const expected = ps.reduce((sum, p, i) => sum + p * i, 0);
      const level = ps.indexOf(Math.max(...ps));
      // The model sends its own legend (what each level index meant when it rendered the
      // rubric), so prefer that over the caller's criteria strings: they are the same thing
      // by construction, and the model's copy is what the probabilities actually refer to.
      const sentLegend = isRecord(raw["legend"]) ? raw["legend"] : undefined;
      const legend: Record<string, string> = {};
      for (let i = 0; i < levels; i += 1) {
        const fromModel = sentLegend?.[String(i)];
        legend[String(i)] = typeof fromModel === "string" ? fromModel : (question.criteria[i] ?? `level ${i}`);
      }
      const result: ScoreResult = {
        type: "score",
        score: typeof raw["score"] === "number" && Number.isFinite(raw["score"]) ? raw["score"] : expected,
        level,
        legend,
        probabilities: Object.fromEntries(ps.map((p, i) => [String(i), p])),
        ...metricsOf(ps),
        ...vendor(raw),
      };
      return result;
    }
    case "noul": {
      const p = isRecord(raw) ? raw["noul"] : raw;
      if (!isProb(p)) return malformed(`answer "${name}": noul must be a probability in [0, 1]`);
      const result: NoulResult = {
        type: "noul",
        probability: p,
        verdict: p >= 0.5,
        ...metricsOf([p, 1 - p]),
      };
      return result;
    }
  }
}

export function validateBands({ act, review }: Bands): void {
  if (![act, review].every(isProb) || act < review) {
    throw new DecideError("invalid_request", "bands need 0 <= review <= act <= 1");
  }
}

/** Bucket one result: act automatically, ask for a review, or escalate to a human / stronger model. */
export function gate(result: Result, bands: Bands): Band {
  validateBands(bands);
  const { act, review, metric = "top" } = bands;
  const value = metric === "vendor" ? (result.vendorConfidence ?? result.top) : result[metric];
  return value >= act ? "act" : value >= review ? "review" : "escalate";
}

/** Per-answer numbers the audit log is allowed to keep: names and rounded values, never the text. */
export function summarise(result: Result, band?: Band): Record<string, number | string> {
  return {
    type: result.type,
    top: round(result.top),
    margin: round(result.margin),
    certainty: round(result.certainty),
    ...(result.vendorConfidence === undefined ? {} : { vendor: round(result.vendorConfidence) }),
    ...(band ? { band } : {}),
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
