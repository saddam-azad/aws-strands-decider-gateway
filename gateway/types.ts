/** Anything JSON-serialisable you want a decision about. */
export type State = string | readonly unknown[] | { readonly [key: string]: unknown };

/**
 * A criteria entry: the decider accepts a description, structured data, or null.
 * The gateway only ever reads the keys, so it admits string | null and bounds the strings.
 */
export type Criterion = string | null;

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  /** option key -> description. The key is what comes back as the answer. */
  readonly criteria: { readonly [option: string]: Criterion };
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  /** Ordered levels, least to most. The model's schema requires plain strings here. */
  readonly criteria: readonly string[];
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  /** Optional `{"true": "...", "false": "..."}` descriptions that sharpen the boundary. */
  readonly criteria?: { readonly true?: Criterion; readonly false?: Criterion };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = { readonly [name: string]: Question };

/**
 * Metrics computed locally from the returned probabilities, so the numbers mean the same
 * thing whatever the backend's own `confidence` field happens to mean.
 */
export interface Metrics {
  /** Probability of the winning answer (noul: max(p, 1 - p)). */
  readonly top: number;
  /** top minus runner-up (noul: |2p - 1|). */
  readonly margin: number;
  /** 1 - normalised entropy: 0 = uniform, 1 = fully concentrated. */
  readonly certainty: number;
  /** The model's own `confidence`, untouched, when it sent one. */
  readonly vendorConfidence?: number;
}

export interface ChoiceResult extends Metrics {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: { readonly [option: string]: number };
}

export interface ScoreResult extends Metrics {
  readonly type: "score";
  /** Probability-weighted level, 0 .. levels-1. */
  readonly score: number;
  /** Most likely level (argmax). */
  readonly level: number;
  readonly legend: { readonly [level: string]: string };
  readonly probabilities: { readonly [level: string]: number };
}

export interface NoulResult extends Metrics {
  readonly type: "noul";
  /** P(yes). */
  readonly probability: number;
  /** probability >= 0.5. Near 0.5 means "don't know": gate it. */
  readonly verdict: boolean;
}

export type Result = ChoiceResult | ScoreResult | NoulResult;

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export type Band = "act" | "review" | "escalate";

export interface Bands {
  /** metric >= act   -> "act" (run automatically). */
  readonly act: number;
  /** metric >= review -> "review" (confirm / second opinion); below -> "escalate". */
  readonly review: number;
  /** Which number to compare. Default "top". "vendor" falls back to "top" if the model sent none. */
  readonly metric?: "top" | "margin" | "certainty" | "vendor";
}

/** The decider's `POST /v1/systemone` response, as parsed off the wire. */
export interface DeciderResponse {
  readonly answers: { readonly [name: string]: unknown };
  readonly model?: string;
  readonly usage?: Usage;
  readonly latency_ms?: number;
}
