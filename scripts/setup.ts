/**
 * After `cdk deploy`: seed tenants and hand out API keys.
 *
 * Writes `loadtest/config.json` and `client/config.json`, both gitignored because they hold
 * generated keys. Re-running is safe: existing keys are read back and reused rather than
 * minted again, so a load test that is already running does not start 401ing.
 *
 *   bun run setup
 *
 * The keys are generated here, not by the stack. CloudFormation state is readable by anyone
 * with `cloudformation:DescribeStacks`, so a secret that lives in a stack output is not a
 * secret; this script stores only the SHA-256 of each key, exactly as the gateway looks it
 * up, and keeps the plaintext in a gitignored file on the operator's machine.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

const ROOT = path.resolve(import.meta.dirname, "..");
const STACK = process.env["STACK_NAME"] ?? "StrandsDecider";
const REGION = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";

interface KeySpec {
  readonly tenant: string;
  readonly app: string;
  readonly label: string;
}

interface TenantsFile {
  readonly tenants: Record<string, Record<string, unknown>>;
  readonly keys: readonly KeySpec[];
}

interface IssueOptions {
  /** Mint new keys even if ones already exist. Rotates every key in the file. */
  readonly rotate?: boolean;
}

/** SHA-256 hex, matching `hashKey` in gateway/handler.ts. Keys are 32 bytes of CSPRNG. */
const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** `pk_` prefix so a leaked key is recognisable, and a scanner can match it. */
const newKey = (): string => `pk_live_${randomBytes(24).toString("base64url")}`;

async function stackOutputs(): Promise<Record<string, string>> {
  const cf = new CloudFormationClient({ region: REGION });
  try {
    const res = await cf.send(new DescribeStacksCommand({ StackName: STACK }));
    const outputs = res.Stacks?.[0]?.Outputs ?? [];
    return Object.fromEntries(outputs.map((o) => [o.OutputKey as string, o.OutputValue as string]));
  } catch (error) {
    throw new Error(
      `could not read stack "${STACK}" in ${REGION}: ${(error as Error).message}\n` +
        `Deploy it first (bun run deploy), or set STACK_NAME if you named it differently.`,
    );
  }
}

/**
 * Reuse a key that is still in the table, so a re-run is idempotent.
 *
 * "Still in the table" is checked by hashing each candidate and looking for it, because the
 * plaintext is never stored: the table only ever holds `KEY#<sha256>`.
 */
async function existingKey(
  doc: DynamoDBDocumentClient,
  table: string,
  saved: Record<string, string>,
  spec: KeySpec,
): Promise<string | undefined> {
  const candidate = saved[`${spec.tenant}/${spec.app}`];
  if (!candidate) return undefined;
  const res = await doc.send(new GetCommand({ TableName: table, Key: { pk: `KEY#${hashKey(candidate)}` } }));
  if (!res.Item) return undefined;
  // Constant-time because it costs nothing here and this is the one place we compare a key
  // to a key rather than a hash to a hash.
  const stored = String(res.Item["pk"]).slice("KEY#".length);
  const a = Buffer.from(hashKey(candidate));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b) ? candidate : undefined;
}

export async function issueKeys(options: IssueOptions = {}): Promise<Record<string, string>> {
  const out = await stackOutputs();
  const table = out["TableName"];
  if (!table) throw new Error("the stack has no TableName output; is it the right stack?");

  const config = JSON.parse(readFileSync(path.join(ROOT, "config", "tenants.json"), "utf8")) as TenantsFile;
  const savedPath = path.join(ROOT, "client", "config.json");
  const saved = existsSync(savedPath)
    ? (JSON.parse(readFileSync(savedPath, "utf8")) as { keys?: Record<string, string> }).keys ?? {}
    : {};

  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  for (const [name, rules] of Object.entries(config.tenants)) {
    await doc.send(
      new PutCommand({ TableName: table, Item: { pk: `TENANT#${name}`, tenant: name, ...rules } }),
    );
    console.log(`seeded tenant ${name} (${String(rules["requests_per_hour"] ?? "default")} req/h)`);
  }

  const keys: Record<string, string> = {};
  for (const spec of config.keys) {
    const key = options.rotate ? undefined : await existingKey(doc, table, saved, spec);
    const value = key ?? newKey();
    await doc.send(
      new PutCommand({
        TableName: table,
        Item: { pk: `KEY#${hashKey(value)}`, tenant: spec.tenant, app: spec.app, label: spec.label },
      }),
    );
    keys[`${spec.tenant}/${spec.app}`] = value;
    console.log(`${key ? "reused " : "issued "} key for ${spec.tenant}/${spec.app}`);
  }

  mkdirSync(path.join(ROOT, "client"), { recursive: true });
  writeFileSync(
    savedPath,
    `${JSON.stringify({ gatewayUrl: out["GatewayUrl"], region: REGION, keys }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(ROOT, "loadtest", "config.json"),
    `${JSON.stringify(
      {
        gatewayUrl: out["GatewayUrl"],
        region: REGION,
        keys,
        // k6 wants a flat list; one entry per tenant so per-tenant throttling is visible.
        tenants: config.keys.map((spec) => ({ ...spec, apiKey: keys[`${spec.tenant}/${spec.app}`] })),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\nwrote client/config.json and loadtest/config.json`);
  console.log(`gateway: ${out["GatewayUrl"]}`);
  console.log(`open ${out["ClientUrl"]} and paste a key from client/config.json\n`);
  return keys;
}

if (import.meta.main) {
  const rotate = process.argv.includes("--rotate");
  await issueKeys({ rotate });
}
