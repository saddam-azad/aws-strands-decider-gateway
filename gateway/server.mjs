/**
 * Container HTTP server for the gateway (ECS Fargate).
 *
 * This runs the same handler logic as Lambda, but exposes an HTTP server directly.
 * It adapts incoming HTTP requests to API Gateway v2 event shape and translates responses back.
 */
import { createServer } from "node:http";
import { createHandler } from "./handler.ts";
import { loadBundledClient } from "./client.ts";

const PORT = Number(process.env["PORT"] ?? 8080);

function configFromEnv(env = process.env) {
  const deciderUrl = env["DECIDER_URL"];
  if (!deciderUrl) throw new Error("DECIDER_URL is not set; the gateway has no model to call");
  const num = (name, fallback) => {
    const raw = env[name];
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    deciderUrl,
    ...(env["DECIDER_PATH"] === undefined ? {} : { deciderPath: env["DECIDER_PATH"] }),
    deciderAuth: env["DECIDER_AUTH"] === "none" ? "none" : "iam",
    timeoutMs: num("DECIDER_TIMEOUT_MS", 45000),
    retries: num("DECIDER_RETRIES", 2),
    cache: { ttlSeconds: num("CACHE_TTL_SECONDS", 300), maxEntries: num("CACHE_MAX_ENTRIES", 500) },
    ...(env["SERVE_CLIENT"] === "false" ? {} : { client: loadBundledClient() }),
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function buildEvent(req, bodyBuffer) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : String(v);
  }

  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers,
    requestContext: {
      accountId: process.env["AWS_ACCOUNT_ID"] ?? "000000000000",
      apiId: "ecs-gateway",
      domainName: req.headers.host ?? "localhost",
      domainPrefix: (req.headers.host ?? "localhost").split(".")[0],
      http: {
        method: (req.method ?? "GET").toUpperCase(),
        path: url.pathname,
        protocol: req.httpVersion === "2" ? "HTTP/2" : "HTTP/1.1",
        sourceIp: req.socket?.remoteAddress ?? "127.0.0.1",
        userAgent: req.headers["user-agent"] ?? "",
      },
      requestId: crypto.randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
    body: bodyBuffer.length > 0 ? bodyBuffer.toString("utf8") : undefined,
    isBase64Encoded: false,
  };
}

const handler = createHandler({ config: configFromEnv() });

const server = createServer(async (req, res) => {
  try {
    const bodyBuffer = await readBody(req);
    const event = buildEvent(req, bodyBuffer);
    const result = await handler(event);
    
    const headers = {};
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) {
        if (v !== undefined && v !== null) headers[k] = String(v);
      }
    }
    
    res.writeHead(result.statusCode ?? 500, headers);
    res.end(result.body ?? "");
  } catch (error) {
    console.error("server error:", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway (ecs) listening on 0.0.0.0:${PORT}`);
});
