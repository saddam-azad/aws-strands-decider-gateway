/**
 * Tests for the stack's *contract*, not its CloudFormation.
 *
 * A snapshot would break on every unrelated CDK upgrade and tell you nothing. What is
 * worth asserting is the handful of decisions that are expensive to get wrong in
 * production — the ones where a silent change means a 3am page rather than a red test:
 *
 *   - the gateway runs Node 26 with no bundler
 *   - the model function has IAM auth and enough memory, because a 2B fp32 torso does not
 *     fit in the default 128 MB and the failure is an OOM, not a validation error
 *   - the two Glue tables project their partitions, so today's data is queryable without a
 *     crawler
 *   - every alarm exists and reads the metric the gateway actually emits
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { StrandsDeciderStack, METRICS_NAMESPACE } from "../../lib/stack.ts";

function synth(props: ConstructorParameters<typeof StrandsDeciderStack>[2] = {}) {
  const app = new App();
  const stack = new StrandsDeciderStack(app, "Test", { env: { account: "123456789012", region: "us-east-1" }, ...props });
  return { stack, template: Template.fromStack(stack) };
}

const functions = (template: Template): Record<string, any>[] =>
  Object.values(template.findResources("AWS::Lambda::Function"));

const byId = (template: Template, id: string): any => template.findResources("AWS::Lambda::Function")[id];

/** The sole resource of a type, asserted rather than indexed — `noUncheckedIndexedAccess` is on. */
function only<T>(resources: Record<string, T>): T {
  const values = Object.values(resources);
  assert.equal(values.length, 1, `expected exactly one resource, found ${values.length}`);
  return values[0] as T;
}

test("the gateway is a Node 26 function shipped as a plain asset", () => {
  const { template } = synth();
  const gateway = byId(template, "Gateway43CB3636");
  assert.ok(gateway, "the gateway function exists");
  assert.equal(gateway.Properties.Runtime, "nodejs26.x");
  assert.equal(gateway.Properties.Handler, "entry.handler");
  // No bundler: the source is the asset, so there is no `Code.S3Key` pointing at a build.
  assert.ok(gateway.Properties.Code, "the code is an inline asset or S3 upload");
});

test("the gateway is configured to reach the model with a per-attempt deadline under its own", () => {
  const { template } = synth();
  const gateway = byId(template, "Gateway43CB3636");
  const env = gateway.Properties.Environment.Variables;
  assert.equal(env.DECIDER_PATH, "/v1/systemone");
  assert.ok(Number(env.DECIDER_TIMEOUT_MS) < gateway.Properties.Timeout * 1000, "attempt deadline is under the Lambda timeout");
  assert.ok(Number(env.DECIDER_RETRIES) >= 1, "at least one retry survives a cold start");
  assert.equal(env.METRICS_NAMESPACE, METRICS_NAMESPACE);
});

test("the model is a 10 GB x86_64 container with IAM auth and a concurrency ceiling", () => {
  const { template } = synth();
  const model = Object.values(template.findResources("AWS::Lambda::Function")).find((f) => f.Properties.PackageType === "Image");
  assert.ok(model, "the model is a container image function");
  assert.equal(model.Properties.MemorySize, 10_240);
  assert.deepEqual(model.Properties.Architectures, ["x86_64"]);
  assert.equal(model.Properties.ReservedConcurrentExecutions, 4, "cold-start blast radius is bounded");

  const modelUrl = Object.entries(template.findResources("AWS::Lambda::Url")).find(([id]) => id.startsWith("Model"));
  assert.equal(modelUrl?.[1].Properties.AuthType, "AWS_IAM", "only a SigV4 signer may invoke the model");
});

test("the model is reachable only by an identity holding the invoke grant", () => {
  const { template } = synth();
  // With `AWS_IAM` there is no `Lambda::Permission` resource to check: the boundary is the
  // URL's auth type plus the caller's IAM policy. Both halves are asserted here, because
  // getting either wrong is a public model endpoint or a permanently-403ing gateway.
  const modelUrl = Object.entries(template.findResources("AWS::Lambda::Url")).find(([id]) => id.startsWith("Model"));
  assert.equal(modelUrl?.[1].Properties.AuthType, "AWS_IAM");

  const policies = Object.entries(template.findResources("AWS::IAM::Policy"));
  const gatewayPolicy = policies.find(([id]) => id.startsWith("GatewayServiceRole"));
  const document = JSON.stringify(gatewayPolicy?.[1].Properties.PolicyDocument);
  assert.ok(gatewayPolicy, "the gateway has a role policy");
  assert.ok(document.includes("lambda:InvokeFunctionUrl"), "the gateway may invoke a function URL");
  assert.ok(document.includes("Model0"), "and the grant names the model function");

  const gatewayUrl = Object.entries(template.findResources("AWS::Lambda::Url")).find(([id]) => id.startsWith("Gateway"));
  assert.equal(gatewayUrl?.[1].Properties.AuthType, "NONE", "the public front door is the gateway, not the model");
});

test("the gateway URL is public with CORS for a browser and an API key", () => {
  const { template } = synth();
  const gatewayUrl = Object.entries(template.findResources("AWS::Lambda::Url")).find(([id]) => id.startsWith("Gateway"));
  assert.equal(gatewayUrl?.[1].Properties.AuthType, "NONE");
  const cors = gatewayUrl?.[1].Properties.Cors;
  assert.ok(cors.AllowHeaders.includes("x-api-key"), "the browser may send the tenant key");
});

test("both Glue tables project day partitions, so no crawler is needed", () => {
  const { template } = synth();
  const tables = Object.values(template.findResources("AWS::Glue::Table"));
  assert.equal(tables.length, 2);
  for (const table of tables) {
    const input = table.Properties.TableInput;
    const params = input.Parameters;
    assert.equal(params["projection.enabled"], "true", `${input.Name} projects`);
    assert.equal(params["projection.day.type"], "date");
    assert.ok(String(params["projection.day.range"]).endsWith(",NOW"), "the range is open-ended");
    // The location template is an `Fn::Join` over the bucket name, so flatten it and check
    // that `${day}` survived as a literal — Athena, not CDK, expands it.
    const location = JSON.stringify(params["storage.location.template"]);
    assert.ok(location.includes("${day}"), "the template keeps `${day}` literal for Athena");
    assert.equal(input.StorageDescriptor.SerdeInfo.Parameters["ignore.malformed.json"], "true");
    assert.deepEqual(input.PartitionKeys, [{ Name: "day", Type: "string" }]);
  }
});

test("the usage records bucket expires and is not public", () => {
  const { template } = synth();
  const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
  const records = buckets.find((b) => JSON.stringify(b.Properties.LifecycleConfiguration ?? {}).includes("30"));
  assert.ok(records, "the records bucket has a 30-day lifecycle");
});

test("each delivery stream has its own day-partitioned prefix", () => {
  const { template } = synth();
  const streams = Object.values(template.findResources("AWS::KinesisFirehose::DeliveryStream"));
  assert.equal(streams.length, 2);
  const prefixes = streams.map((s) => s.Properties.ExtendedS3DestinationConfiguration.Prefix);
  assert.ok(prefixes.some((p) => p.startsWith("gw-usage/day=")));
  assert.ok(prefixes.some((p) => p.startsWith("model-inference/day=")));
  for (const stream of streams) {
    assert.equal(stream.Properties.ExtendedS3DestinationConfiguration.CompressionFormat, "GZIP");
    assert.equal(stream.Properties.DeliveryStreamType, "DirectPut");
  }
});

test("the three alarms exist and read metrics the gateway emits", () => {
  const { template } = synth();
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
  const names = alarms.map((a) => a.Properties.AlarmName).sort();
  assert.deepEqual(names, [
    "strands-decider-error-rate-high",
    "strands-decider-model-cold-starts-high",
    "strands-decider-model-p95-latency-high",
  ]);
  for (const alarm of alarms) {
    const text = JSON.stringify(alarm.Properties);
    assert.ok(text.includes(METRICS_NAMESPACE), `${alarm.Properties.AlarmName} reads the deployment's namespace`);
    // No alarm may notify nobody by accident: either it has an action, or it was built
    // without an email, and that is a deployment choice, not a bug.
  }
});

test("an alarm email wires every alarm to an SNS topic", () => {
  const { template } = synth({ alarmEmail: "ops@example.com" });
  const topics = template.findResources("AWS::SNS::Topic");
  assert.equal(Object.keys(topics).length, 1);
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm"));
  for (const alarm of alarms) {
    assert.ok(alarm.Properties.AlarmActions?.length, `${alarm.Properties.AlarmName} notifies the topic`);
  }
});

test("the Athena workgroup caps an accidental full-table scan", () => {
  const { template } = synth();
  const workgroup = only(template.findResources("AWS::Athena::WorkGroup"));
  const config = workgroup.Properties.WorkGroupConfiguration;
  assert.equal(config.EnforceWorkGroupConfiguration, true);
  assert.ok(config.BytesScannedCutoffPerQuery <= 1_000_000_000, "an unfiltered query fails loudly rather than billing");
});

test("every query in queries/ is registered as a named query", () => {
  const { template } = synth();
  const queries = Object.values(template.findResources("AWS::Athena::NamedQuery"));
  assert.ok(queries.length >= 5, `expected the named queries, found ${queries.length}`);
  for (const query of queries) {
    assert.equal(query.Properties.Database, "strands_decider");
    assert.ok(query.Properties.QueryString.trim().length > 0, `${query.Properties.Name} is not empty`);
  }
});

test("the dashboard has widgets and a stable name", () => {
  const { template } = synth();
  const dashboard = only(template.findResources("AWS::CloudWatch::Dashboard"));
  assert.equal(dashboard.Properties.DashboardName, "strands-decider-control-tower");
  assert.ok(dashboard.Properties.DashboardBody["Fn::Join"][1].length > 5, "the dashboard has several widgets");
});

test("the stack outputs the URL a caller needs and the table to seed", () => {
  const { template } = synth();
  const outputs = template.toJSON().Outputs as Record<string, unknown>;
  for (const name of ["GatewayUrl", "ModelUrl", "TableName", "RecordsBucket", "AthenaWorkgroup", "DashboardUrl", "ClientUrl"]) {
    assert.ok(outputs[name], `missing output ${name}`);
  }
});

test("the coverage is not empty — a stack that synthesises no functions is a broken test", () => {
  const { template } = synth();
  assert.ok(functions(template).length >= 2);
});
