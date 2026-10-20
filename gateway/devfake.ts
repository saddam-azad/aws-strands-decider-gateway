/**
 * A DynamoDB-free stand-in for the two tables the gateway reads and writes.
 *
 * Why this exists in `gateway/` rather than in `scripts/`: the dev server
 * (`scripts/dev-server.ts`) runs the *real* handler, and the real handler reaches for
 * DynamoDB on the auth path, the cache path, the tenant path and the quota path. Without
 * something behind those calls, the dev server can only exercise the routes that never touch
 * a table, which is most of the interesting surface.
 *
 * The alternative — a `DEV_BYPASS_AUTH` branch inside the handler — would mean the code under
 * development is not the code that ships. This keeps the handler honest: it runs its real
 * gates, its real quota arithmetic and its real cache write against an object that behaves
 * like the handful of DynamoDB operations used here. If a change to the handler starts
 * issuing a command this file does not implement, the dev server fails loudly instead of
 * quietly skipping a gate.
 *
 * It is deliberately *not* a general DynamoDB emulator. It implements the five commands the
 * gateway uses, with the exact condition and update expressions its callers pass. An
 * unrecognised expression throws, because a condition that silently holds is how a quota
 * stops enforcing without anyone noticing.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface Row {
  readonly pk: string;
  [key: string]: unknown;
}

/** Commands are duck-typed by name and `input`, because the middleware classes are opaque. */
interface CommandLike {
  readonly input?: Record<string, unknown>;
  readonly constructor: { readonly name: string };
}

function conditionalFailure(): Error {
  return Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
  });
}

/** Evaluate the two `ConditionExpression` shapes the project uses, or throw on an unknown one. */
function satisfies(
  item: Row | undefined,
  expression: string | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!expression) return true;
  const expressionText = expression.trim();

  // The cache's write-if-absent-or-stale guard:
  //   attribute_not_exists(expires_at) OR expires_at < :now
  const stale = expressionText.match(
    /^attribute_not_exists\((\w+)\)\s+OR\s+(\w+)\s*<\s*(:\w+)$/i,
  );
  if (stale) {
    const [, field, compared, placeholder] = stale;
    if (field !== compared) throw new Error(`devfake: mismatched ConditionExpression: ${expression}`);
    const now = Number(values[placeholder as string]);
    const current = item?.[field as string];
    return current === undefined || Number(current) < now;
  }

  // The quota's first-write guard: attribute_not_exists(requests_used).
  const absent = expressionText.match(/^attribute_not_exists\((\w+)\)$/i);
  if (absent) return item?.[absent[1] as string] === undefined;

  // The quota's update guard, expressed with OR over a named field pair — the shape that
  // `reserveRequest` passes, which is `… OR requests_used < :ceiling`.
  const below = expressionText.match(
    /^attribute_not_exists\((\w+)\)\s+OR\s+(\w+)\s*<\s*(:\w+)$/i,
  );
  if (below) {
    const [, , field, placeholder] = below;
    const current = item?.[field as string];
    return current === undefined || Number(current) < Number(values[placeholder as string]);
  }

  throw new Error(`devfake: unsupported ConditionExpression: ${expression}`);
}

/** Apply `ADD a :one SET b = if_not_exists(b, :x)`, and return the changed attributes. */
function applyUpdate(
  item: Row | undefined,
  expression: string,
  values: Record<string, unknown>,
  names: Record<string, string>,
): Row {
  const next: Record<string, unknown> = { ...(item ?? {}) };
  const add = expression.match(/ADD\s+([\w#]+)\s+(:\w+)/i);
  if (add) {
    const field = names[add[1] as string] ?? (add[1] as string);
    next[field] = Number(next[field] ?? 0) + Number(values[add[2] as string]);
  }
  for (const set of expression.matchAll(/SET\s+([\w#]+)\s*=\s*if_not_exists\(\1,\s*(:\w+)\)/gi)) {
    const field = names[set[1] as string] ?? (set[1] as string);
    if (next[field] === undefined) next[field] = values[set[2] as string];
  }
  return next as Row;
}

export interface InMemoryTableOptions {
  /** Seeds, keyed by pk. */
  readonly items?: readonly Row[];
}

/** A stand-in for `DynamoDBDocumentClient`, implementing only the methods the gateway calls. */
export function inMemoryTable(options: InMemoryTableOptions = {}): DynamoDBDocumentClient {
  const rows = new Map<string, Row>();
  for (const item of options.items ?? []) rows.set(item.pk, { ...item });

  const send = async (command: CommandLike): Promise<Record<string, unknown>> => {
    const name = command.constructor.name;
    const input = command.input ?? {};

    switch (name) {
      case "GetCommand": {
        const key = input["Key"] as { pk: string };
        return { Item: rows.get(key.pk) };
      }

      case "PutCommand": {
        const item = input["Item"] as Row;
        const values = (input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
        if (!satisfies(rows.get(item.pk), input["ConditionExpression"] as string | undefined, values)) {
          throw conditionalFailure();
        }
        rows.set(item.pk, { ...item });
        return {};
      }

      case "UpdateCommand": {
        const key = input["Key"] as { pk: string };
        const current = rows.get(key.pk);
        const values = (input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
        const names = (input["ExpressionAttributeNames"] ?? {}) as Record<string, string>;
        if (!satisfies(current, input["ConditionExpression"] as string | undefined, values)) {
          throw conditionalFailure();
        }
        const updated = applyUpdate(current, String(input["UpdateExpression"] ?? ""), values, names);
        const stored: Row = { ...updated, pk: key.pk };
        rows.set(key.pk, stored);
        return input["ReturnValues"] === "UPDATED_NEW" ? { Attributes: stored } : {};
      }

      case "DeleteCommand": {
        const key = input["Key"] as { pk: string };
        rows.delete(key.pk);
        return {};
      }

      case "QueryCommand": {
        // Only `pk = :pk` is used (the cold-start quota probe). Anything richer fails loudly.
        const expression = String(input["KeyConditionExpression"] ?? "").trim();
        if (!/^pk\s*=\s*:\w+$/i.test(expression)) {
          throw new Error(`devfake: unsupported KeyConditionExpression: ${expression}`);
        }
        const values = (input["ExpressionAttributeValues"] ?? {}) as Record<string, unknown>;
        const wanted = String(Object.values(values)[0]);
        const found = [...rows.values()].filter((r) => r.pk === wanted);
        return { Items: found, Count: found.length };
      }

      default:
        throw new Error(`devfake: unsupported command ${name}`);
    }
  };

  return { send } as unknown as DynamoDBDocumentClient;
}
