/**
 * Three ways out of the Lambda, all of which are debugged from one `request_id`:
 *
 *   1. `log`/`logException`  — structured JSON to CloudWatch Logs.
 *   2. `emitMetrics`         — CloudWatch Embedded Metric Format: metrics *are* log lines,
 *                              so the hot path makes no API call and cannot be throttled.
 *   3. `shipUsageRecord`     — one JSON line to Firehose -> S3 -> Glue -> Athena.
 *
 * `emitMetrics` is deliberately independent of `shipUsageRecord`: EMF gives the fast,
 * aggregate view the dashboard and the alarms read; Firehose gives the slow, per-request
 * truth you go to when an aggregate looks wrong. Neither can break the other.
 */
import { FirehoseClient, PutRecordCommand } from "@aws-sdk/client-firehose";

export const NAMESPACE = process.env["METRICS_NAMESPACE"] ?? "StrandsDeciderGateway";

/** Units, keyed by metric name. Anything unlisted is a Count. */
const UNITS: Record<string, string> = {
  Latency: "Milliseconds",
  ModelLatency: "Milliseconds",
  ModelLoadTime: "Milliseconds",
  GatewayOverhead: "Milliseconds",
  QuotaUtilization: "Percent",
  Requests: "Count",
};

let firehose: FirehoseClient | undefined;

export function log(stage: string, requestId: string | null, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "INFO", stage, request_id: requestId, ...fields }));
}

export function logException(stage: string, requestId: string | null): void {
  console.log(
    JSON.stringify({ level: "ERROR", stage, request_id: requestId, trace: new Error().stack ?? "" }),
  );
}

/**
 * Emit metrics through EMF.
 *
 * `dimensions` are appended to the mandatory `Service` dimension and the whole set becomes
 * a single dimension group. That is intentional: CloudWatch charges per metric *per
 * dimension group*, so declaring `[Service]` and `[Service, Tenant]` as two groups from the
 * same metric name costs twice as much as one. We pay for both because the tenant-broken-down
 * view is the point of a multi-tenant gateway — but note that a metric emitted with a tenant
 * dimension cannot be read without one, and vice versa. Avoid nulls: `undefined` values are
 * dropped from both the dimension list and the metric list, which is what keeps "no tenant"
 * from silently becoming the tenant named `"undefined"`.
 */
export function emitMetrics(
  values: Record<string, number | null | undefined>,
  dimensions?: Record<string, string>,
): void {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, number] => entry[1] !== null && entry[1] !== undefined,
  );
  if (!entries.length) return;
  const dims: Record<string, string> = { Service: "strands-decider-gateway", ...dimensions };
  const body: Record<string, unknown> = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [Object.keys(dims)],
          Metrics: entries.map(([name]) => ({ Name: name, Unit: UNITS[name] ?? "Count" })),
        },
      ],
    },
    ...dims,
  };
  for (const [name, value] of entries) body[name] = value;
  console.log(JSON.stringify(body));
}

/**
 * Append one record to the usage delivery stream.
 *
 * Firehose accepts a single JSON document (not a JSON array) per record. We append a
 * newline anyway: the S3 objects are still newline-delimited JSON, which keeps them
 * readable by Athena's JSON SerDe, by `jq`, and by a human with `aws s3 cp -`.
 */
export async function shipUsageRecord(record: Record<string, unknown>): Promise<void> {
  const stream = process.env["USAGE_STREAM"];
  if (!stream) return; // not configured (local dev): the EMF path still works
  try {
    firehose ??= new FirehoseClient({});
    await firehose.send(
      new PutRecordCommand({
        DeliveryStreamName: stream,
        Record: { Data: Buffer.from(`${JSON.stringify(record)}\n`) },
      }),
    );
  } catch {
    // Losing one usage record must never fail the caller's request.
    logException("usage_record_failed", (record["request_id"] as string | undefined) ?? null);
  }
}
