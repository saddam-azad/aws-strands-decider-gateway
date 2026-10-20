/**
 * The shared (cross-execution) response cache: DynamoDB, tenant-scoped, opt-in per tenant.
 *
 * This is L1. L0 is the in-process TtlCache in `cache.ts`; L2 is the model. Because a
 * decider request costs 3-5 s on a 10 GB Lambda, a hit here is worth far more than a
 * typical LLM gateway cache hit, so it is on by default wherever the tenant sets a TTL.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CACHE_KEY } from "./policy.ts";

const DEFAULT_TTL_SECONDS = 300;

let doc: DynamoDBDocumentClient | undefined;

function table(): DynamoDBDocumentClient {
  doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return doc;
}

export function setCacheTable(client: DynamoDBDocumentClient | undefined): void {
  doc = client;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** The cached body, or undefined on a miss, an expired row, or any DynamoDB failure. */
export async function lookupCached(digest: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await table().send(
      new GetCommand({ TableName: required("TABLE_NAME"), Key: { pk: CACHE_KEY(digest) } }),
    );
    const item = res.Item as { body?: unknown; expires_at?: unknown } | undefined;
    if (!item || typeof item.body !== "string") return undefined;
    if (typeof item.expires_at === "number" && item.expires_at <= Math.floor(Date.now() / 1000)) {
      void evict(digest);
      return undefined;
    }
    return JSON.parse(item.body) as Record<string, unknown>;
  } catch {
    return undefined; // a cache failure must never fail the request
  }
}

/** Store a response body. Failures are swallowed: this is an optimisation, not a contract. */
export async function putCached(
  digest: string,
  body: Record<string, unknown>,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (ttlSeconds <= 0) return;
  try {
    await table().send(
      new PutCommand({
        TableName: required("TABLE_NAME"),
        Item: {
          pk: CACHE_KEY(digest),
          body: JSON.stringify(body),
          expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ConditionExpression: "attribute_not_exists(expires_at) OR expires_at < :now",
        ExpressionAttributeValues: { ":now": Math.floor(Date.now() / 1000) },
      }),
    );
  } catch {
    // ConditionalCheckFailed means someone else won the race; either way, move on.
  }
}

async function evict(digest: string): Promise<void> {
  try {
    await table().send(new DeleteCommand({ TableName: required("TABLE_NAME"), Key: { pk: CACHE_KEY(digest) } }));
  } catch {
    /* best effort */
  }
}
