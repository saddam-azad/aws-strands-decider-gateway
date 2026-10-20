/**
 * Tests for the in-memory table the dev server runs the real handler against.
 *
 * `devfake.ts` is load-bearing: `scripts/dev-server.ts` swaps it in for DynamoDB and then runs
 * the *shipping* handler, so a bug here is a bug that hides a gate in development. The parts
 * worth testing are the ones whose failure mode is silent — a condition that always holds
 * makes a quota stop enforcing, and a quota that stops enforcing looks like a working
 * gateway right up until the bill arrives.
 *
 * Each test drives the fake through the real `@aws-sdk/lib-dynamodb` command objects, so the
 * shapes match what `policy.ts` and `store.ts` actually send.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { inMemoryTable } from "../../gateway/devfake.ts";

const TABLE = "test";

test("get returns the seeded item and undefined for a miss", async () => {
  const table = inMemoryTable({ items: [{ pk: "A", value: 1 }] });
  assert.deepEqual((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "A" } }))).Item, {
    pk: "A",
    value: 1,
  });
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "B" } }))).Item, undefined);
});

test("put stores an item and get reads it back", async () => {
  const table = inMemoryTable();
  await table.send(new PutCommand({ TableName: TABLE, Item: { pk: "K", body: "x" } }));
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "K" } }))).Item?.body, "x");
});

test("a cache write is rejected while the row is still fresh", async () => {
  const now = Math.floor(Date.now() / 1000);
  const table = inMemoryTable();
  // The first write wins; the second meets `attribute_not_exists(expires_at) OR expires_at < :now`.
  await table.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: "C", body: "first", expires_at: now + 300 },
      ConditionExpression: "attribute_not_exists(expires_at) OR expires_at < :now",
      ExpressionAttributeValues: { ":now": now },
    }),
  );
  await assert.rejects(
    table.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: "C", body: "second", expires_at: now + 300 },
        ConditionExpression: "attribute_not_exists(expires_at) OR expires_at < :now",
        ExpressionAttributeValues: { ":now": now },
      }),
    ),
    (e: Error) => e.name === "ConditionalCheckFailedException",
  );
  // The first value survives: the losing write did not overwrite it.
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "C" } }))).Item?.body, "first");
});

test("a cache write succeeds once the row has expired", async () => {
  const now = Math.floor(Date.now() / 1000);
  const table = inMemoryTable({ items: [{ pk: "C", body: "stale", expires_at: now - 1 }] });
  await table.send(
    new PutCommand({
      TableName: TABLE,
      Item: { pk: "C", body: "fresh", expires_at: now + 300 },
      ConditionExpression: "attribute_not_exists(expires_at) OR expires_at < :now",
      ExpressionAttributeValues: { ":now": now },
    }),
  );
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "C" } }))).Item?.body, "fresh");
});

test("the quota ADD increments in place and returns the new total", async () => {
  const table = inMemoryTable();
  const reserve = () =>
    table.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: "Q" },
        UpdateExpression: "ADD requests_used :one SET expires_at = if_not_exists(expires_at, :exp)",
        ConditionExpression: "attribute_not_exists(requests_used) OR requests_used < :ceiling",
        ExpressionAttributeValues: { ":one": 1, ":ceiling": 3, ":exp": 999 },
        ReturnValues: "UPDATED_NEW",
      }),
    );

  assert.equal((await reserve()).Attributes?.requests_used, 1);
  assert.equal((await reserve()).Attributes?.requests_used, 2);
  const third = await reserve();
  assert.equal(third.Attributes?.requests_used, 3);
  // And the expiry was set on the first write, not overwritten on later ones.
  assert.equal(third.Attributes?.expires_at, 999);
});

test("the quota refuses to exceed its ceiling", async () => {
  const table = inMemoryTable({ items: [{ pk: "Q", requests_used: 3, expires_at: 999 }] });
  await assert.rejects(
    table.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: "Q" },
        UpdateExpression: "ADD requests_used :one SET expires_at = if_not_exists(expires_at, :exp)",
        ConditionExpression: "attribute_not_exists(requests_used) OR requests_used < :ceiling",
        ExpressionAttributeValues: { ":one": 1, ":ceiling": 3, ":exp": 999 },
        ReturnValues: "UPDATED_NEW",
      }),
    ),
    (e: Error) => e.name === "ConditionalCheckFailedException",
  );
  // Nothing was written: a refused reservation must not count.
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "Q" } }))).Item?.requests_used, 3);
});

test("a released reservation decrements the counter", async () => {
  const table = inMemoryTable({ items: [{ pk: "Q", requests_used: 2 }] });
  const res = await table.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: "Q" },
      UpdateExpression: "ADD requests_used :minus",
      ExpressionAttributeValues: { ":minus": -1 },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  assert.equal(res.Attributes?.requests_used, 1);
});

test("delete removes a row", async () => {
  const table = inMemoryTable({ items: [{ pk: "D", x: 1 }] });
  await table.send(new DeleteCommand({ TableName: TABLE, Key: { pk: "D" } }));
  assert.equal((await table.send(new GetCommand({ TableName: TABLE, Key: { pk: "D" } }))).Item, undefined);
});

test("query returns the rows under one partition key", async () => {
  const table = inMemoryTable({ items: [{ pk: "Q#a" }, { pk: "Q#b" }, { pk: "OTHER" }] });
  const res = await table.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "Q#a" },
    }),
  );
  assert.equal(res.Count, 1);
  assert.equal((res.Items?.[0] as { pk: string }).pk, "Q#a");
});

test("an unrecognised condition throws rather than quietly holding", async () => {
  // This is the point of the fake. A condition it does not understand must not be treated as
  // satisfied: that would make a gate disappear in development while production still enforced it.
  const table = inMemoryTable();
  await assert.rejects(
    table.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: "X" },
        ConditionExpression: "attribute_exists(something) AND contains(other, :v)",
        ExpressionAttributeValues: { ":v": "x" },
      }),
    ),
    /unsupported ConditionExpression/,
  );
});

test("an unrecognised command throws", async () => {
  const table = inMemoryTable();
  const command = { input: {}, constructor: { name: "ScanCommand" } };
  await assert.rejects(
    table.send(command as never),
    /unsupported command ScanCommand/,
  );
});
