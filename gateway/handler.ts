/**
 * The gateway itself.
 *
 * Order of operations, which is also the order of the gates in the reference architecture:
 *
 *   1. CORS preflight                 — answered without touching any downstream.
 *   2. Body size                      — read the payload once, refuse it if it is too big.
 *   3. Auth                           — hash the API key, resolve it to a tenant.
 *   4. Parse + validate               — questions and state, against the tenant's limits.
 *   5. Redact                         — before hashing for the cache and before the wire.
 *   6. Cache (L0 in-process, L1 DynamoDB).
 *   7. Quota                          — reserve a slot for this UTC hour, atomically.
 *   8. Model                          — SigV4 to the decider Function URL.
 *   9. Gate + format                  — local confidence metrics, act/review/escalate.
 *  10. Evidence                       — EMF metrics, a usage record, a structured log line.
 *
 * Every step that can fail throws a `DecideError`; the catch at the bottom turns it into a
 * status, and the whole path is wrapped so that no response ever carries an upstream body
 * or a stack trace.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHash } from "node:crypto";
import { decider, type Decider, type DeciderResponse } from "./backends.ts";
import { cacheKey, TtlCache } from "./cache.ts";
import { gate, parseAnswer, summarise, validateBands } from "./confidence.ts";
import { DecideError, publicMessage, STATUS } from "./errors.ts";
import {
  appPolicy,
  authorized,
  callerFor,
  limit,
  pickModel,
  redactions as tenantRedactions,
  releaseRequest,
  reserveRequest,
  tenantConfig,
  utilization,
} from "./policy.ts";
import { compileRedactions, redact, type BuiltinRedaction } from "./redact.ts";
import { lookupCached, putCached } from "./store.ts";
import { emitMetrics, log, logException, shipUsageRecord } from "./telemetry.ts";
import type { Bands, Question, Result, Usage } from "./types.ts";
import { parseQuestions, parseState } from "./validate.ts";
import { serveClient, type ClientAsset } from "./client.ts";

/** Defaults for anything a tenant does not override. These are the deployment's posture. */
export const DEFAULTS = {
  maxBodyBytes: 256 * 1024,
  /** Per attempt. The decider's worst case is a cold start, so this is generous. */
  timeoutMs: 45_000,
  retries: 2,
  cacheTtlSeconds: 300,
  maxStateChars: 20_000,
  requestsPerHour: 1_000,
  redact: ["email", "card", "phone"] as readonly BuiltinRedaction[],
} as const;

export interface GatewayConfig {
  /** The decider's internal ALB URL. */
  readonly deciderUrl: string;
  readonly deciderPath?: string;
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** Defaults applied when a tenant sets none. Env-tunable so both stacks stay in step. */
  readonly defaults?: Partial<typeof DEFAULTS>;
  /** L0 cache. */
  readonly cache?: { readonly ttlSeconds: number; readonly maxEntries: number };
  readonly fetch?: typeof globalThis.fetch;
  /** Contents of the web client, or undefined to serve the API only. */
  readonly client?: ClientAsset;
}

export interface HandlerDeps {
  readonly config: GatewayConfig;
  readonly createDecider?: (config: GatewayConfig) => Decider;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-api-key",
  "access-control-max-age": "3600",
} as const;

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
} as const;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { "content-type": "application/json", ...CORS, ...SECURITY, ...headers },
  body: JSON.stringify(body),
});

const notFound = (): APIGatewayProxyStructuredResultV2 =>
  json(404, { error: { code: "not_found", message: "no such route" } });

const badRequest = (message: string): DecideError => new DecideError("invalid_request", message);

/** Small helpers over the v2 event, so the routing code below reads like prose. */
const methodOf = (event: APIGatewayProxyEventV2): string =>
  (event.requestContext?.http?.method ?? "GET").toUpperCase();

const pathOf = (event: APIGatewayProxyEventV2): string => event.rawPath || event.requestContext?.http?.path || "/";

const headerOf = (event: APIGatewayProxyEventV2, name: string): string | undefined => {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === lowered && value !== undefined) return value;
  }
  return undefined;
};

/** A request id we control, so a caller cannot forge log correlation. */
const requestId = (event: APIGatewayProxyEventV2): string =>
  event.requestContext?.requestId ?? crypto.randomUUID();

async function bodyOf(event: APIGatewayProxyEventV2, maxBytes: number): Promise<unknown> {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === "") throw badRequest("request body is required");
  const text = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  if (Buffer.byteLength(text) > maxBytes) throw badRequest(`body exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DecideError("invalid_request", "body must be valid JSON", { cause });
  }
}

export function createHandler(deps: HandlerDeps) {
  const { config } = deps;
  const defaults = { ...DEFAULTS, ...config.defaults };
  const makeDecider = deps.createDecider ?? ((c: GatewayConfig) => decider({
    baseUrl: c.deciderUrl,
    ...(c.deciderPath === undefined ? {} : { path: c.deciderPath }),
    timeoutMs: c.timeoutMs ?? defaults.timeoutMs,
    retries: c.retries ?? defaults.retries,
    ...(c.fetch === undefined ? {} : { fetch: c.fetch }),
  }));
  const backend = makeDecider(config);
  const l0 = new TtlCache<Record<string, unknown>>(
    config.cache?.ttlSeconds ?? defaults.cacheTtlSeconds,
    config.cache?.maxEntries ?? 500,
  );

  async function decide(
    event: APIGatewayProxyEventV2,
    id: string,
    started: number,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    /* ---------------------------------------------------------- 3. auth */
    const apiKey = headerOf(event, "x-api-key") ?? bearer(event);
    if (!apiKey) throw new DecideError("unauthorized", "missing x-api-key header");
    const caller = await callerFor(hashKey(apiKey));
    if (!caller) throw new DecideError("unauthorized", "unknown API key");
    const { tenant, app } = caller;

    const cfg = (await tenantConfig(tenant)) ?? {};
    if (cfg["disabled"] === true) throw new DecideError("unauthorized", "tenant is disabled");
    const rules = appPolicy(cfg, app);

    const model = pickModel(rules, null);
    if (!authorized(rules, model)) {
      throw new DecideError("unauthorized", `tenant is not allowed to use model ${model}`);
    }

    /* ------------------------------------------------- 4. parse + validate */
    const body = await bodyOf(event, defaults.maxBodyBytes);
    const envelope = asEnvelope(body);
    const maxStateChars = limit(rules, "max_state_chars", defaults.maxStateChars);
    const state = parseState(envelope.state, maxStateChars);
    const questions = parseQuestions(envelope.questions);
    const bands = envelope.bands;
    if (bands) validateBands(bands);

    /* ---------------------------------------------------------- 5. redact */
    const specs = tenantRedactions(rules) ?? defaults.redact;
    const ruleset = compileRedactions(specs);
    const safeState = redact(state, ruleset);
    const cacheable = envelope.cache !== false;

    /* ----------------------------------------------------------- 6. cache */
    const ttl = envelope.cache_ttl_seconds ?? limit(rules, "cache_ttl_seconds", defaults.cacheTtlSeconds);
    const digest = cacheKey(tenant, app, model, safeState, questions);
    if (cacheable && ttl > 0) {
      const hit = l0.get(digest);
      if (hit) return finish(withCacheState(hit, true), "hit-l0", id, tenant, model, started, undefined);
      const shared = await lookupCached(digest);
      if (shared) {
        l0.set(digest, shared);
        return finish(withCacheState(shared, true), "hit-l1", id, tenant, model, started, undefined);
      }
    }

    /* ----------------------------------------------------------- 7. quota */
    const ceiling = limit(rules, "requests_per_hour", defaults.requestsPerHour);
    const reservation = await reserveRequest(tenant, ceiling);
    if (!reservation) {
      emitMetrics({ Throttled: 1 }, { Tenant: tenant });
      throw new DecideError("rate_limited", `tenant ${tenant} is over ${ceiling} requests/hour`, {
        retryable: true,
      });
    }

    /* ----------------------------------------------------------- 8. model */
    let upstream: DeciderResponse | undefined;
    try {
      upstream = await backend.evaluate({ state: safeState, questions, model });
    } catch (cause) {
      // The tenant should not pay for our failure to reach the model.
      void releaseRequest(reservation.key).catch(() => {});
      throw cause;
    }

    /* ------------------------------------------------- 9. gate + format */
    const results: Record<string, Result> = {};
    const gated: Record<string, string> = {};
    for (const [name, question] of Object.entries(questions) as [string, Question][]) {
      const raw = upstream.answers[name];
      if (raw === undefined) {
        throw new DecideError("malformed_response", `decider returned no answer for question "${name}"`);
      }
      const result = parseAnswer(name, question, raw);
      results[name] = result;
      if (bands) gated[name] = gate(result, bands);
    }

    const response: Record<string, unknown> = {
      request_id: id,
      model,
      ...(upstream.model === undefined ? {} : { model_id: upstream.model }),
      answers: results,
      ...(bands ? { bands: gated } : {}),
      usage: upstream.usage ?? {},
      latency_ms: Math.round(performance.now() - started),
      ...(upstream.upstreamLatencyMs === undefined ? {} : { model_latency_ms: Math.round(upstream.upstreamLatencyMs) }),
      cached: false,
    };

    if (cacheable && ttl > 0) {
      void putCached(digest, response, ttl).catch(() => {});
      l0.set(digest, response);
    }
    return finish(response, "miss", id, tenant, model, started, upstream, utilization(reservation.used, ceiling));
  }

  /** Emit the evidence for a completed request and hand back the response. */
  function finish(
    body: Record<string, unknown>,
    cacheState: string,
    id: string,
    tenant: string,
    model: string,
    started: number,
    upstream: DeciderResponse | undefined,
    quotaUsed?: number,
  ): APIGatewayProxyStructuredResultV2 {
    const latency = Math.round(performance.now() - started);
    const answers = (body["answers"] ?? {}) as Record<string, unknown>;
    const results = Object.values(answers) as Result[];
    const modelLatency = upstream?.upstreamLatencyMs;
    const worstTop = results.length ? Math.min(...results.map((r) => r.top)) : undefined;
    const coldStart = upstream?.coldStart;
    const usage = (body["usage"] ?? {}) as Usage;

    emitMetrics(
      {
        Latency: latency,
        ModelLatency: modelLatency === undefined ? undefined : Math.round(modelLatency),
        ModelLoadTime: upstream?.modelLoadMs,
        Requests: 1,
        CacheHit: cacheState === "miss" ? 0 : 1,
        ColdStart: coldStart === undefined ? undefined : coldStart ? 1 : 0,
        QuotaUtilization: quotaUsed,
        // The *weakest* answer in the batch. A batch is only as trustworthy as its worst call,
        // so gating on the mean would let one confident answer hide a coin flip next to it.
        ConfidenceFloor: worstTop,
      },
      { Tenant: tenant },
    );

    log("request", id, {
      tenant,
      model,
      cache: cacheState,
      latency_ms: latency,
      model_latency_ms: modelLatency,
      cold_start: coldStart,
      in_tokens: usage.input_tokens,
      out_tokens: usage.output_tokens,
      questions: results.length,
      confidence_floor: worstTop,
    });

    void shipUsageRecord({
      request_id: id,
      ts: new Date().toISOString(),
      tenant,
      model,
      model_id: body["model_id"] ?? null,
      cache: cacheState,
      latency_ms: latency,
      model_latency_ms: modelLatency ?? null,
      model_load_ms: upstream?.modelLoadMs ?? null,
      cold_start: coldStart ?? null,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      questions: results.length,
      confidence_floor: worstTop ?? null,
      bands: body["bands"] ?? null,
      answers: summariseAnswers(results),
    }).catch(() => {});

    return json(200, body, { "x-request-id": id, "x-cache": cacheState, "x-decider-model": model });
  }

  return async function handler(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const id = requestId(event);
    const started = performance.now();
    const method = methodOf(event);
    const path = pathOf(event);

    try {
      /* ------------------------------------------------------ 1. preflight */
      if (method === "OPTIONS") return { statusCode: 204, headers: { ...CORS }, body: "" };

      /* ------------------------------------------------ 0. non-API routes */
      if (method === "GET") {
        if (path === "/" || path === "/index.html") {
          return config.client
            ? serveClient(config.client, "index.html")
            : json(200, { service: "strands-decider-gateway", endpoint: "POST /v1/systemone" });
        }
        if (path === "/healthz") {
          // The version deployed, for a smoke test to confirm it is talking to the build it
          // thinks it is. Unset in development, where it reports `dev`.
          return json(200, { ok: true, uptime_s: Math.round(process.uptime()), version: process.env["APP_VERSION"] ?? "dev" });
        }
        if (config.client && (path === "/app.js" || path === "/style.css")) {
          return serveClient(config.client, path.slice(1));
        }
        return notFound();
      }

      if (method !== "POST") return json(405, { error: { code: "method_not_allowed", message: `no ${method}` } });
      if (path !== "/v1/systemone" && path !== "/") return notFound();

      return await decide(event, id, started);
    } catch (error) {
      const known = error instanceof DecideError;
      const status = known ? STATUS[error.code] : 500;
      const retryable = known && error.retryable;

      if (known && error.code === "invalid_request") {
        log("rejected", id, { reason: error.message });
      } else {
        logException("failed", id);
        console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      emitMetrics({ Errors: 1 }, { Code: known ? error.code : "internal" });

      return json(
        status,
        { request_id: id, error: { code: known ? error.code : "internal", message: known ? publicMessage(error) : "internal error" } },
        { "x-request-id": id, ...(retryable ? { "retryable": "true" } : {}) },
      );
    }
  };
}

/** Rebuild a cached body for this request: `request_id` and `latency_ms` are always fresh. */
function withCacheState(
  cached: Record<string, unknown>,
  hit: boolean,
): Record<string, unknown> {
  return { ...cached, cached: hit };
}

/* ------------------------------------------------------------------ helpers */

/**
 * Per-answer numbers for the audit record: shapes and rounded values only, never the
 * caller's text and never the model's rationale. This row is what makes "which tenant
 * asked which kind of question, and how sure was the model" answerable in Athena without
 * the usage table becoming a copy of the requests.
 */
function summariseAnswers(results: readonly Result[]): Record<string, unknown> {
  return Object.fromEntries(results.map((result, i) => [String(i), summarise(result)]));
}

/** The request envelope: `state` and `questions` are the model's; the rest are the gateway's. */
interface Envelope {
  readonly state: unknown;
  readonly questions: unknown;
  readonly bands?: Bands;
  readonly cache?: boolean;
  readonly cache_ttl_seconds?: number;
}

function asEnvelope(body: unknown): Envelope {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  if (record["questions"] === undefined) throw badRequest("questions is required");
  const bands = record["bands"];
  if (bands !== undefined && (typeof bands !== "object" || bands === null)) {
    throw badRequest("bands must be an object");
  }
  const ttl = record["cache_ttl_seconds"];
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl < 0)) {
    throw badRequest("cache_ttl_seconds must be a non-negative number");
  }
  return body as Envelope;
}

function bearer(event: APIGatewayProxyEventV2): string | undefined {
  const header = headerOf(event, "authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/**
 * SHA-256 of the API key. Only the hash is stored, logged and compared; the key itself is
 * never persisted. A plain digest rather than an HMAC is enough here: the keys are 32 bytes
 * of CSPRNG output generated at seed time, so there is no dictionary to attack.
 */
export const hashKey = (apiKey: string): string => createHash("sha256").update(apiKey).digest("hex");
