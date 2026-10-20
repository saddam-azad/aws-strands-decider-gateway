/**
 * The gateway's only HTTP hop: `POST /v1/systemone` on the decider Lambda's Function URL.
 *
 * Ported from lambda-decide's `backends.ts` — same retry ladder, same status→error mapping,
 * same "never leak the upstream body" discipline — with two changes:
 *
 *   1. The upstream is our own decider function, so auth is SigV4 (`AuthType: AWS_IAM`)
 *      rather than an API key. Credentials come from the execution role's environment
 *      variables, which Lambda rotates in place, so they are read per call.
 *   2. The decider is a cold-starting 10 GB container, so the per-attempt deadline is
 *      measured in tens of seconds, not the 15 s a hosted API would get.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { DecideError } from "./errors.ts";
import type { Questions, State, Usage } from "./types.ts";
import { AwsClient } from "./vendor/aws4fetch.mjs";

export interface DeciderRequest {
  readonly state: State;
  readonly questions: Questions;
  readonly model: string;
  readonly signal?: AbortSignal;
}

export interface DeciderResponse {
  /** Raw per-question answers exactly as the model returned them. */
  readonly answers: { readonly [name: string]: unknown };
  /** The model's own label (the checkpoint name), which may differ from the alias asked for. */
  readonly model?: string;
  readonly usage?: Usage;
  /** Server-measured inference time, straight from the decider's `latency_ms`. */
  readonly upstreamLatencyMs?: number;
  /** True when this response paid for a model load — the number the dashboard alarms on. */
  readonly coldStart?: boolean;
  readonly modelLoadMs?: number;
}

export interface Decider {
  readonly name: string;
  evaluate(request: DeciderRequest): Promise<DeciderResponse>;
}

export interface DeciderOptions {
  /** The decider's Function URL, e.g. https://xxxx.lambda-url.us-east-1.on.aws/ */
  readonly baseUrl: string;
  /** Default "/v1/systemone". */
  readonly path?: string;
  /** "iam" signs with SigV4; "none" sends no credentials (local dev against a fake decider). */
  readonly auth?: "iam" | "none";
  /** Per attempt. Must outlast the model's worst-case inference, not its median. */
  readonly timeoutMs?: number;
  /** Extra attempts on 429/502/503/504/529 and network errors. Default 2. */
  readonly retries?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const RETRYABLE = new Set([429, 502, 503, 504, 529]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  // Response headers are strings, so accept a numeric string for the `x-decider-*` values.
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Headers arrive as strings, so `"true"`/`"1"` mean true and anything else false. */
const parseBool = (v: string | null): boolean | undefined =>
  v === null ? undefined : v === "true" || v === "1";

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    input_tokens: num(raw["input_tokens"]) ?? 0,
    output_tokens: num(raw["output_tokens"]) ?? 0,
  };
}

function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 10) * 1000 : undefined;
}

const backoff = (attempt: number): number => Math.min(2_000, 200 * 2 ** attempt) * (0.5 + Math.random() / 2);

interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * The execution role's credentials, read fresh on every call.
 *
 * Lambda rotates them in place inside a warm environment, so caching the *client* across
 * invocations would eventually sign with an expired token — and `AWS_SESSION_TOKEN` is
 * required for the signature to be accepted at all.
 */
function credentials(): Credentials {
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) {
    throw new DecideError(
      "auth",
      "no AWS credentials in the environment; the gateway must run as a Lambda execution role to SigV4-sign the decider call",
    );
  }
  const sessionToken = process.env["AWS_SESSION_TOKEN"];
  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

/** A `fetch` that SigV4-signs every request for `service: "lambda"`. */
export function signingFetch(region: string = process.env["AWS_REGION"] ?? "us-east-1"): typeof globalThis.fetch {
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const { accessKeyId, secretAccessKey, sessionToken } = credentials();
    // retries: 0 — our ladder owns the retry count, so retries show up in the metrics.
    const client = new AwsClient({
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      region,
      service: "lambda",
      retries: 0,
    });
    return client.fetch(input as string, init);
  }) as typeof globalThis.fetch;
}

/**
 * Speaks the decider's `POST /v1/systemone` protocol: `{state, questions, model}` in,
 * `{model, answers, usage, latency_ms}` out.
 */
export function decider(options: DeciderOptions): Decider {
  const {
    baseUrl,
    path = "/v1/systemone",
    auth = "iam",
    timeoutMs = 60_000,
    retries = 2,
    fetch: fetchImpl,
  } = options;
  const url = baseUrl.replace(/\/+$/, "") + path;

  return {
    name: "decider",
    async evaluate({ state, questions, model, signal }) {
      const body = JSON.stringify({ model, state, questions });
      const requestHeaders: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };

      // A caller-supplied fetch (tests, a local fake) is used as-is; otherwise IAM auth
      // wraps globalThis.fetch in a SigV4 signer.
      const doFetch = fetchImpl ?? (auth === "iam" ? signingFetch() : globalThis.fetch);

      for (let attempt = 0; ; attempt++) {
        const attemptSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
        let res: Response;
        try {
          res = await doFetch(url, { method: "POST", headers: requestHeaders, body, signal: attemptSignal });
        } catch (cause) {
          if (signal?.aborted) throw signal.reason ?? cause; // the caller cancelled: not our error
          const timedOut = cause instanceof Error && cause.name === "TimeoutError";
          if (attempt < retries) {
            await sleep(backoff(attempt), undefined, signal ? { signal } : undefined);
            continue;
          }
          throw new DecideError(
            timedOut ? "timeout" : "network",
            `decider: ${timedOut ? `no response after ${timeoutMs}ms` : "network error"}`,
            { cause, retryable: true },
          );
        }

        if (res.ok) {
          const json: unknown = await res.json().catch((cause: unknown) => {
            throw new DecideError("malformed_response", "decider: response was not JSON", { cause });
          });
          return parseResponse(json, res.headers);
        }

        const detail = (await res.text().catch(() => "")).slice(0, 300);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          await sleep(retryAfterMs(res) ?? backoff(attempt), undefined, signal ? { signal } : undefined);
          continue;
        }
        const code =
          res.status === 401 || res.status === 403
            ? "auth"
            : res.status === 429
              ? "rate_limited"
              : res.status === 400 || res.status === 422
                ? "invalid_request"
                : "upstream";
        // The upstream body goes into the *cause*, which is logged, never into the message,
        // which is what a caller may one day be shown. A 4xx from the model is about the
        // caller's own request, so its detail is forwarded directly.
        const ownFault = code === "invalid_request";
        throw new DecideError(
          code,
          ownFault ? `decider: HTTP ${res.status}${detail ? ` ${detail}` : ""}` : `decider: HTTP ${res.status}`,
          { status: res.status, retryable: RETRYABLE.has(res.status), cause: detail },
        );
      }
    },
  };
}

function parseResponse(json: unknown, headers: Headers): DeciderResponse {
  if (!isRecord(json) || !isRecord(json["answers"])) {
    throw new DecideError("malformed_response", 'decider: response has no "answers" object');
  }
  const usage = parseUsage(json["usage"]);
  const upstreamLatencyMs = num(json["latency_ms"]);
  const coldStart = parseBool(headers.get("x-decider-cold-start"));
  const modelLoadMs = num(headers.get("x-decider-model-load-ms"));
  return {
    answers: json["answers"],
    ...(typeof json["model"] === "string" ? { model: json["model"] } : {}),
    ...(usage ? { usage } : {}),
    ...(upstreamLatencyMs === undefined ? {} : { upstreamLatencyMs }),
    ...(coldStart === undefined ? {} : { coldStart }),
    ...(modelLoadMs === undefined ? {} : { modelLoadMs }),
  };
}
