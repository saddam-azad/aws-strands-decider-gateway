/**
 * The gateway, on localhost.
 *
 * This is the *same* handler the Lambda runs, wrapped in a `node:http` server that
 * translates a real request into an API Gateway v2 event and the response back. That is
 * deliberate: the alternative — a second, simplified request path for development — is how
 * "works locally, 502s in the cloud" happens. Anything this server gets wrong about the
 * event shape will be wrong in exactly the same way as this file, so the translation is kept
 * to the ten obvious fields.
 *
 *   DECIDER_URL=http://127.0.0.1:8080 bun run dev
 *
 * Then:
 *   curl -s localhost:3000/healthz
 *   curl -s -X POST localhost:3000/v1/systemone -H 'x-api-key: dev' -d @request.json
 *
 * Auth is still enforced, against an in-memory table seeded from `config/tenants.json` and a
 * single fixed key (`dev`, or `DEV_API_KEY`). The gates the handler runs — validation,
 * redaction, the cache, the quota arithmetic, the call to the model — are the real ones; only
 * the two DynamoDB tables are replaced, because there is no AWS account behind a dev loop.
 * `gateway/devfake.ts` is that replacement and it fails loudly on any command it does not
 * implement, so this cannot silently stop exercising a gate.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { loadClient } from "../gateway/client.ts";
import { inMemoryTable, type Row } from "../gateway/devfake.ts";
import { createHandler, hashKey } from "../gateway/handler.ts";
import { setTable } from "../gateway/policy.ts";
import { setCacheTable } from "../gateway/store.ts";

const PORT = Number(process.env["PORT"] ?? 3000);
const DECIDER_URL = process.env["DECIDER_URL"];
if (!DECIDER_URL) {
  console.error("DECIDER_URL is required. Start the model first (bun run model:local --fake), then:");
  console.error("  DECIDER_URL=http://127.0.0.1:8080 bun run dev");
  process.exit(1);
}

/**
 * The dev key is a fixed, obviously-fake string. It goes into shell history and curl commands
 * all day, and a real-looking key invites someone to reuse it somewhere that matters.
 */
const DEV_API_KEY = process.env["DEV_API_KEY"] ?? "dev";
const DEV_TENANT = process.env["DEV_TENANT"] ?? "acme";
const DEV_APP = process.env["DEV_APP"] ?? "support";

/**
 * Seed the rows `scripts/setup.ts` would seed in the cloud, from `config/tenants.json`.
 *
 * Every tenant in the file is seeded, with its real quota: a dev server that quietly raised
 * every limit would hide the 429 path, which is one of the more awkward things to test.
 */
function seedRows(): Row[] {
  const tenantsPath = path.join(import.meta.dirname, "..", "config", "tenants.json");
  if (!existsSync(tenantsPath)) throw new Error("config/tenants.json is missing");
  const config = JSON.parse(readFileSync(tenantsPath, "utf8")) as {
    tenants: Record<string, Record<string, unknown>>;
  };
  if (config.tenants[DEV_TENANT] === undefined) {
    throw new Error(`DEV_TENANT=${DEV_TENANT} is not in config/tenants.json`);
  }
  const rows: Row[] = Object.entries(config.tenants).map(([name, rules]) => ({
    pk: `TENANT#${name}`,
    tenant: name,
    ...rules,
  }));
  rows.push({ pk: `KEY#${hashKey(DEV_API_KEY)}`, tenant: DEV_TENANT, app: DEV_APP, label: "dev" });
  return rows;
}

// `TABLE_NAME` is read by every DynamoDB path even though nothing is contacted. The handler
// treats a missing value as a startup error, so set a placeholder before it is first read.
process.env["TABLE_NAME"] ??= "dev-in-memory";
const table = inMemoryTable({ items: seedRows() });
setTable(table);
setCacheTable(table);

const handler = createHandler({
  config: {
    deciderUrl: DECIDER_URL,
    deciderPath: process.env["DECIDER_PATH"] ?? "/v1/systemone",
    // The dev server runs against a local fake, which has no IAM to check, so no signing by
    // default. Set `DECIDER_AUTH=iam` to exercise the SigV4 path against a real Function URL.
    deciderAuth: process.env["DECIDER_AUTH"] === "iam" ? "iam" : "none",
    timeoutMs: Number(process.env["DECIDER_TIMEOUT_MS"] ?? 45_000),
    ...(process.env["SERVE_CLIENT"] === "false"
      ? {}
      : { client: loadClient(new URL("../gateway/client", import.meta.url).pathname) }),
  },
});

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const event: APIGatewayProxyEventV2 = {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
    ),
    requestContext: {
      accountId: "000000000000",
      apiId: "dev",
      domainName: `localhost:${PORT}`,
      domainPrefix: "localhost",
      http: {
        method: (req.method ?? "GET").toUpperCase(),
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: req.socket.remoteAddress ?? "127.0.0.1",
        userAgent: req.headers["user-agent"] ?? "dev",
      },
      requestId: crypto.randomUUID(),
      routeKey: "$default",
      stage: "$default",
      time: new Date().toUTCString(),
      timeEpoch: Date.now(),
    },
    body: await readBody(req),
    isBase64Encoded: false,
  };

  try {
    const result = await handler(event);
    res.writeHead(result.statusCode ?? 500, result.headers as Record<string, string>);
    res.end(result.body ?? "");
  } catch (error) {
    // The Lambda handler catches its own errors, so reaching here means the *translation*
    // failed, which is worth seeing in full.
    console.error(error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "dev_server_error", message: String(error) } }));
  }
});

server.listen(PORT, () => {
  console.log(`gateway (dev) on http://localhost:${PORT}`);
  console.log(`  model:  ${DECIDER_URL}`);
  console.log(`  client: http://localhost:${PORT}/`);
  console.log(`  auth:   x-api-key: ${DEV_API_KEY}  (tenant ${DEV_TENANT}/${DEV_APP}, in-memory table)`);
  console.log(`  try:    curl -s -X POST localhost:${PORT}/v1/systemone -H 'x-api-key: ${DEV_API_KEY}' \\`);
  console.log(`            -d '{"state":"a support ticket","questions":{"escalate":{"type":"noul","instructions":"Escalate?"}}}'`);
});
