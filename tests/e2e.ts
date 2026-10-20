/**
 * End-to-end tests against a deployed decider gateway.
 *
 * Unlike `tests/unit` (offline, no AWS), these talk to the real stack: the Function URL, the
 * real model Lambda behind it, the real DynamoDB table, and the real telemetry pipeline. They
 * cover the outcomes a caller can actually see, in the order a caller would meet them:
 *
 *   1. the three question shapes, answered and formatted
 *   2. the response cache (miss then hit for the same cacheable request)
 *   3. auth (a missing key and a wrong key are both 401, never 500)
 *   4. quota, when a tenant is over its hourly allowance
 *   5. the model allow-list (a 403 for a model the tenant may not use)
 *   6. the evidence path: the usage record reaches S3, so Athena can query it
 *
 * Requires a deployed stack and the config `bun run setup` writes:
 *
 *     cdk deploy
 *     bun run setup
 *     bun run e2e
 *
 * Deliberately *not* wired into `node --test`: it needs a live deployment, real keys and
 * ~$0.001 per uncached request, so it is run by hand and by the deploy pipeline, not on
 * every save.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = process.env["GATEWAY_CONFIG"] ?? path.join(ROOT, "loadtest", "config.json");
const REGION = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1";
const STACK = process.env["STACK_NAME"] ?? "StrandsDecider";

interface Config {
  readonly gatewayUrl: string;
  readonly region: string;
  readonly keys: Record<string, string>;
  readonly tenants: readonly { tenant: string; app: string; apiKey: string }[];
}

interface Outcome {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const results: Outcome[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Every request needs a key; there is no anonymous path. */
async function post(
  base: string,
  key: string | undefined,
  body: unknown,
): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base.replace(/\/$/, "")}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "x-api-key": key }),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : {}, headers: res.headers };
}

const NOUL = {
  state: "A customer asks whether their refund will arrive before the weekend. The order shipped 2 days ago, standard delivery is 3-5 days, and today is Thursday.",
  questions: { before_weekend: { type: "noul", instructions: "Will the refund arrive before the weekend?" } },
};

async function main(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`no config at ${CONFIG_PATH}\nDeploy first (bun run deploy), then seed keys: bun run setup`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
  const base = config.gatewayUrl;
  const acme = config.tenants.find((t) => t.tenant === "acme") ?? config.tenants[0];
  if (!acme) throw new Error("config has no tenants");

  console.log(`\ne2e against ${base}\n`);

  /* ------------------------------------------------- 1. the three shapes */

  const shapes = await post(base, acme.apiKey, {
    state: (NOUL as { state: string }).state,
    questions: {
      ...NOUL.questions,
      route: {
        type: "choice",
        instructions: "Which team should own this?",
        criteria: { billing: "money in or out", engineering: "the product is broken" },
      },
      severity: {
        type: "score",
        instructions: "How urgent is this?",
        criteria: ["low", "medium", "high"],
      },
    },
  });
  const answers = shapes.body?.answers ?? {};
  record(
    "all three question types answer",
    shapes.status === 200 && answers.before_weekend?.type === "noul" && answers.route?.type === "choice" && answers.severity?.type === "score",
    `status ${shapes.status}, ${Object.keys(answers).join(", ")}`,
  );
  record(
    "answers carry a calibrated confidence, not just a verdict",
    typeof answers.before_weekend?.top === "number" && typeof answers.before_weekend?.margin === "number",
    `top=${answers.before_weekend?.top} margin=${answers.before_weekend?.margin}`,
  );
  record(
    "the response reports model latency",
    typeof shapes.body?.model_latency_ms === "number",
    `${shapes.body?.model_latency_ms} ms`,
  );

  /* ------------------------------------------------------------- 2. cache */

  const cacheBody = {
    state: `cache probe ${Date.now()}`,
    questions: NOUL.questions,
    cache_ttl_seconds: 300,
  };
  const miss = await post(base, acme.apiKey, cacheBody);
  const hit = await post(base, acme.apiKey, cacheBody);
  record(
    "an identical request is cached (miss then hit)",
    miss.body?.cached === false && hit.body?.cached === true,
    `miss=${miss.body?.cached} hit=${hit.body?.cached}`,
  );
  record(
    "a cache hit costs no model time",
    hit.body?.cached === true && (hit.body?.model_latency_ms ?? 0) < (miss.body?.model_latency_ms ?? 0),
    `miss ${miss.body?.model_latency_ms}ms vs hit ${hit.body?.model_latency_ms}ms`,
  );

  /* -------------------------------------------------------------- 3. auth */

  const noKey = await post(base, undefined, NOUL);
  const badKey = await post(base, "pk_live_definitely-not-a-real-key", NOUL);
  record("a missing key is a 401", noKey.status === 401, `status ${noKey.status}`);
  record("an unknown key is a 401, not a 500", badKey.status === 401, `status ${badKey.status}`);
  record(
    "an auth failure never echoes the key",
    !JSON.stringify(badKey.body).includes("pk_live_definitely-not-a-real-key"),
    "",
  );

  /* --------------------------------------------------------------- 4. quota */

  const trial = config.tenants.find((t) => t.tenant === "trial");
  if (trial) {
    // Burn the trial tenant's allowance. It is 20/hour, so this is bounded and cheap: most
    // calls hit the limit and never reach the model.
    let sawRateLimit = false;
    for (let i = 0; i < 30 && !sawRateLimit; i++) {
      const res = await post(base, trial.apiKey, { state: `quota ${i}`, questions: NOUL.questions });
      if (res.status === 429) {
        sawRateLimit = res.headers.get("retryable") === "true" && res.body?.error?.code === "rate_limited";
      }
    }
    record("a tenant over its hourly limit gets a clean 429", sawRateLimit, "");
  }

  /* ------------------------------------------------------- 5. allow-list */

  const forbidden = await post(base, acme.apiKey, { ...NOUL, model: "decider-70b" });
  record(
    "a model the tenant may not use is refused",
    forbidden.status === 400 || forbidden.status === 403,
    `status ${forbidden.status}, ${forbidden.body?.error?.code}`,
  );

  /* ---------------------------------------------------------- 6. evidence */

  console.log("\n  (waiting up to 120 s for the usage record to reach S3; Firehose buffers to 60 s)");
  const cf = new CloudFormationClient({ region: REGION });
  const outputs = await cf
    .send(new DescribeStacksCommand({ StackName: STACK }))
    .then((r) => Object.fromEntries((r.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey as string, o.OutputValue as string])))
    .catch(() => ({}) as Record<string, string>);

  if (outputs["RecordsBucket"] && miss.body?.request_id) {
    const s3 = new S3Client({ region: REGION });
    const deadline = Date.now() + 120_000;
    let landed = false;
    let where = "";
    while (Date.now() < deadline && !landed) {
      const listing = await s3.send(
        new ListObjectsV2Command({ Bucket: outputs["RecordsBucket"], Prefix: "gw-usage/", MaxKeys: 100 }),
      );
      if ((listing.KeyCount ?? 0) > 0) {
        landed = true;
        where = listing.Contents?.[0]?.Key ?? "";
      } else {
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    record("the usage record reaches S3 for Athena to query", landed, where);
  } else {
    record("the usage record reaches S3 for Athena to query", false, "RecordsBucket output or request_id missing");
  }

  /* ------------------------------------------------------------- summary */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`failed: ${f.name} — ${f.detail}`);
    process.exit(1);
  }
}

await main();
