/**
 * One error type for the whole gateway, mapped to HTTP at the edge.
 *
 * Anything that is not a DecideError is treated as unexpected and becomes a bare 500:
 * the detail goes to the audit log, never to the caller.
 */
export type DecideErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "auth"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network"
  | "malformed_response";

export interface DecideErrorOptions {
  readonly status?: number;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export class DecideError extends Error {
  override readonly name = "DecideError";
  readonly code: DecideErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(code: DecideErrorCode, message: string, options: DecideErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

/** Codes the caller may act on, and the status each one earns. */
export const STATUS: Readonly<Record<DecideErrorCode, number>> = {
  invalid_request: 400,
  unauthorized: 401,
  auth: 500,
  rate_limited: 429,
  upstream: 502,
  timeout: 504,
  network: 502,
  malformed_response: 502,
};

/**
 * What the caller is told.
 *
 * The rule is *who can fix it*: anything the caller can act on keeps its real message
 * (`invalid_request`, an API key that is missing rather than wrong); anything that would
 * leak upstream bodies, table names or stack traces gets a generic one. `auth` is the
 * deliberate exception — it means this deployment cannot reach the model, which the caller
 * cannot cause, and a support ticket that says only "model error" is worse than the leak.
 */
export function publicMessage(error: DecideError): string {
  switch (error.code) {
    case "invalid_request":
    case "auth":
      return error.message;
    case "unauthorized":
      // Only "you sent no key at all" is safe to be specific about: the caller can fix it,
      // and it tells them nothing about which keys exist.
      return /missing/i.test(error.message) ? error.message : "unknown or invalid API key";
    case "rate_limited":
      return "rate limit exceeded";
    default:
      return "model error";
  }
}
