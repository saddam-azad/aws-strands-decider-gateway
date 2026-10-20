/**
 * Tenant rules, model routing and per-tenant rate limits.
 *
 * Tenant items are free-form DynamoDB rows seeded from `config/tenants.json`, so they are
 * deliberately loosely typed: the JSON shape is the contract, and `scripts/setup.ts` is
 * what enforces it at seed time.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const TENANT_CACHE_SECONDS = 60;
const QUOTA_TTL_SECONDS = 2 * 24 * 3600;

export type TenantConfig = Record<string, any>;
export type Rules = Record<string, any>;

/** One row per tenant: what this tenant's callers are allowed to do. */
export const TENANT_KEY = (tenant: string): string => `TENANT#${tenant}`;
/** One row per API key: which tenant (and app) it belongs to. */
export const KEY_KEY = (hash: string): string => `KEY#${hash}`;
/** One row per tenant per UTC hour: the rate-limit counter. */
export const QUOTA_KEY = (tenant: string, hour: string): string => `QUOTA#${tenant}#${hour}`;
/** One row per identical request: the shared response cache. */
export const CACHE_KEY = (digest: string): string => `CACHE#${digest}`;

export interface Caller {
  readonly tenant: string;
  readonly app: string;
}

export interface QuotaReservation {
  readonly key: string;
  readonly used: number;
}

let doc: DynamoDBDocumentClient | undefined;

/**
 * The document client, built on first use. `docFor` exists so tests can inject a client
 * without touching the process-wide one.
 */
export function table(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return doc;
}

export function setTable(client: DynamoDBDocumentClient | undefined): void {
  doc = client;
}

/* ------------------------------------------------------------------ caching */

interface Entry<T> {
  readonly at: number;
  readonly value: T;
}
const cache = new Map<string, Entry<unknown>>();

/** Negative results are cached too, or a bad API key becomes a free DynamoDB read per request. */
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() / 1000) return Promise.resolve(hit.value as T);
  return load().then((value) => {
    cache.set(key, { at: Date.now() / 1000 + TENANT_CACHE_SECONDS, value });
    return value;
  });
}

/** Drop the in-process tenant/key caches. Exported for tests and for `scripts/setup.ts`. */
export function clearCaches(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ lookup */

/** Resolve an API key (already hashed) to its tenant and app, or undefined when unknown. */
export async function callerFor(apiKeyHash: string): Promise<Caller | undefined> {
  return memo(KEY_KEY(apiKeyHash), async () => {
    const res = await table().send(
      new GetCommand({ TableName: required("TABLE_NAME"), Key: { pk: KEY_KEY(apiKeyHash) } }),
    );
    const item = res.Item as { tenant?: unknown; app?: unknown } | undefined;
    if (typeof item?.tenant !== "string" || typeof item?.app !== "string") return undefined;
    return { tenant: item.tenant, app: item.app };
  });
}

export async function tenantConfig(tenant: string): Promise<TenantConfig | undefined> {
  return memo(TENANT_KEY(tenant), async () => {
    const res = await table().send(
      new GetCommand({ TableName: required("TABLE_NAME"), Key: { pk: TENANT_KEY(tenant) } }),
    );
    return res.Item as TenantConfig | undefined;
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/* ------------------------------------------------------------------ policy */

/** Tenant defaults, narrowed by any per-app override. */
export function appPolicy(tenantCfg: TenantConfig, app: string): Rules {
  const rules: Rules = {};
  for (const [key, value] of Object.entries(tenantCfg)) {
    if (key !== "pk" && key !== "apps") rules[key] = value;
  }
  Object.assign(rules, (tenantCfg.apps as Record<string, Rules> | undefined)?.[app] ?? {});
  return rules;
}

/** The model alias this request should run on: the caller's ask, else the tenant default. */
export function pickModel(rules: Rules, requested?: string | null): string {
  const model = requested || rules["default_model"];
  if (typeof model !== "string" || model.length === 0) {
    throw new Error("tenant has no default_model and the request named none");
  }
  return model;
}

export function authorized(rules: Rules, model: string): boolean {
  const allowed = (rules["allowed_models"] as string[] | undefined) ?? [];
  return allowed.includes(model);
}

/** Numeric limit with a fallback, read straight off the free-form rules object. */
export function limit(rules: Rules, name: string, fallback: number): number {
  const raw = rules[name];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/**
 * The tenant's redaction set, or `undefined` to mean "whatever the deployment default is".
 *
 * An explicit empty array is *not* the same as an absent one: `"redact": []` is a tenant
 * opting out of the defaults entirely, which is a legitimate choice for a tenant whose
 * payloads are already non-sensitive. Collapsing the two would make the defaults
 * impossible to escape.
 */
export function redactions(rules: Rules): readonly string[] | undefined {
  const raw = rules["redact"];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === "string");
}

/* ------------------------------------------------------------------ quota */

/**
 * Atomically reserve one request in this tenant's current UTC hour bucket, or return null
 * when the tenant is over its `requests_per_hour` limit.
 *
 * The conditional ADD is what makes this safe across concurrent executions: either the
 * increment lands below the ceiling, or the whole statement fails and nothing is written.
 */
export async function reserveRequest(
  tenant: string,
  limitPerHour: number,
  now: Date = new Date(),
): Promise<QuotaReservation | null> {
  if (limitPerHour <= 0) return null;
  const key = QUOTA_KEY(tenant, quotaHour(now));
  try {
    const resp = await table().send(
      new UpdateCommand({
        TableName: required("TABLE_NAME"),
        Key: { pk: key },
        UpdateExpression: "ADD requests_used :one SET expires_at = if_not_exists(expires_at, :exp)",
        ConditionExpression: "attribute_not_exists(requests_used) OR requests_used < :ceiling",
        ExpressionAttributeValues: {
          ":one": 1,
          ":ceiling": limitPerHour,
          ":exp": Math.floor(now.getTime() / 1000) + QUOTA_TTL_SECONDS,
        },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return { key, used: Number(resp.Attributes?.requests_used ?? 1) };
  } catch (err) {
    if (err instanceof Error && err.name === "ConditionalCheckFailedException") return null;
    throw err;
  }
}

/** Put a rejected reservation back, so a request that failed downstream does not count against the tenant. */
export async function releaseRequest(key: string): Promise<void> {
  await table().send(
    new UpdateCommand({
      TableName: required("TABLE_NAME"),
      Key: { pk: key },
      UpdateExpression: "ADD requests_used :minus",
      ExpressionAttributeValues: { ":minus": -1 },
    }),
  );
}

export function quotaHour(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}

/** Utilisation of the hourly allowance, as a 0-100 percentage for the dashboard. */
export function utilization(used: number, limitPerHour: number): number {
  if (limitPerHour <= 0) return 0;
  return Math.round((used / limitPerHour) * 10000) / 100;
}
