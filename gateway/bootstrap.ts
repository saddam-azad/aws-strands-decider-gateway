/**
 * The Lambda bootstrap: configuration from the environment, resolved lazily so that a warm
 * execution environment reuses one handler, one client and one L0 cache across invocations.
 *
 * `entry.mjs` calls exactly one function here, and the returned handler is what Lambda sees.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Handler } from "aws-lambda";
import { loadBundledClient } from "./client.ts";
import { createHandler, type GatewayConfig } from "./handler.ts";

/**
 * Configuration is read from the environment, which is how both this stack and the CDK
 * construct wire things up. Everything has a default except the decider URL, because
 * getting that wrong is a configuration error worth failing loudly on — at startup, not
 * on the first request.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const deciderUrl = env["DECIDER_URL"];
  if (!deciderUrl) throw new Error("DECIDER_URL is not set; the gateway has no model to call");
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    deciderUrl,
    ...(env["DECIDER_PATH"] === undefined ? {} : { deciderPath: env["DECIDER_PATH"] }),
    timeoutMs: num("DECIDER_TIMEOUT_MS", 45_000),
    retries: num("DECIDER_RETRIES", 2),
    cache: { ttlSeconds: num("CACHE_TTL_SECONDS", 300), maxEntries: num("CACHE_MAX_ENTRIES", 500) },
    ...(env["SERVE_CLIENT"] === "false" ? {} : { client: loadBundledClient() }),
  };
}

let _handler: ((event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>) | undefined;

/** Build the handler once per execution environment. */
export function createHandlerForLambda(): {
  handler: Handler<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2>;
} {
  _handler ??= createHandler({ config: configFromEnv() });
  return { handler: _handler as Handler<APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2> };
}

// Top-level named export for NodejsFunction (esbuild entry point). Plain async — Node.js 24
// removed callback-based handler support.
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  _handler ??= createHandler({ config: configFromEnv() });
  return _handler(event);
};
