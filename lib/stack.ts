/**
 * Strands Decider: model on Fargate (internal ALB), gateway on ECS Express Gateway.
 * CfnExpressGatewayService manages the public ALB, Fargate tasks, and scale-to-zero
 * for the gateway automatically. The model runs in a private Fargate service behind
 * an internal ALB reachable only from within the VPC.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_athena as athena,
  aws_cloudwatch as cw,
  aws_cloudwatch_actions as cw_actions,
  aws_dynamodb as dynamodb,
  aws_ec2 as ec2,
  aws_ecr_assets as ecr_assets,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_glue as glue,
  aws_iam as iam,
  aws_kinesisfirehose as firehose,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";

const ROOT = path.resolve(import.meta.dirname, "..");
const MODEL_DIR = path.join(ROOT, "model");

export const METRICS_NAMESPACE = "StrandsDeciderGateway";
const GLUE_DATABASE = "strands_decider";
const GATEWAY_TABLE = "gw_usage";
const MODEL_TABLE = "model_inference";
const ATHENA_WORKGROUP = "strands-decider";
const DASHBOARD_NAME = "strands-decider-control-tower";

// aws-cdk-lib predates the Node.js 26 runtime constant, so name it directly.
// const NODEJS_26_X = new lambda_.Runtime("nodejs26.x", lambda_.RuntimeFamily.NODEJS);

export interface StrandsDeciderStackProps extends StackProps {
  /** Memory for the decider Fargate task in MiB. The 2B model needs ~9 GB resident on CPU. */
  readonly modelMemoryMb?: number;
  /** Max model Fargate tasks. Bounds the cold-start blast radius. */
  readonly modelMaxTasks?: number;
  /** Email address for alarm notifications. Omitted means alarms exist but notify nobody. */
  readonly alarmEmail?: string;
  /** Model alias -> HF checkpoint, for the model function's `MODEL_MAP`. */
  readonly modelMap?: Record<string, string>;
  /** Gateway task CPU units (256, 512, 1024, etc.) */
  readonly gatewayCpu?: number;
  /** Gateway task memory (MB) */
  readonly gatewayMemoryMiB?: number;
  /** Max tasks for Express Gateway auto-scaling (default 10) */
  readonly gatewayMaxTasks?: number;
}

export class StrandsDeciderStack extends Stack {
  public readonly gatewayUrl: string;
  public readonly modelUrl: string;
  public readonly tableName: string;
  public readonly usageBucket: s3.Bucket;


  constructor(scope: Construct, id: string, props: StrandsDeciderStackProps = {}) {
    super(scope, id, props);

    const modelMemoryMb = props.modelMemoryMb ?? Number(this.node.tryGetContext("modelMemoryMb") ?? 10_240);
    const modelMaxTasks = props.modelMaxTasks ?? Number(this.node.tryGetContext("modelReservedConcurrency") ?? 4);
    const modelMap =
      props.modelMap ??
      (JSON.parse(readFileSync(path.join(ROOT, "config", "models.json"), "utf8")) as Record<string, string>);

    /* ------------------------------------- help desk records and shared state */
    // One table for tenants, API keys, hourly quota counters, and the shared response
    // cache. `expires_at` is a TTL attribute, which is what makes the quota buckets and
    // cache rows self-cleaning rather than something that needs a sweeper.
    const state = new dynamodb.Table(this, "State", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    /* -------------------------------------------------- the evidence warehouse */
    const records = new s3.Bucket(this, "Records", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.usageBucket = records;

    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
    });
    records.grantReadWrite(firehoseRole);
    firehoseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation", "s3:ListBucket", "s3:ListBucketMultipartUploads"],
        resources: [records.bucketArn],
      }),
    );

    const gatewayStream = this.deliveryStream("GatewayRecords", records, firehoseRole, "gw-usage");
    const modelStream = this.deliveryStream("ModelRecords", records, firehoseRole, "model-inference");

    /* --------------------------------------------------------- VPC (shared by model + gateway) */
    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC },
        { name: "Private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    /* --------------------------------------------------------- the model (Fargate + internal ALB) */
    const modelLogs = new logs.LogGroup(this, "ModelLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const modelCluster = new ecs.Cluster(this, "ModelCluster", { vpc: vpc as ec2.IVpc });

    const modelImage = new ecr_assets.DockerImageAsset(this, "ModelImage", {
      directory: MODEL_DIR,
      platform: Platform.LINUX_AMD64,
      buildArgs: {
        DECIDER_GIT_REF: String(this.node.tryGetContext("deciderGitRef") ?? "main"),
      },
    });

    const modelTaskRole = new iam.Role(this, "ModelTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    modelTaskRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["firehose:PutRecord"], resources: [modelStream.attrArn] }),
    );

    const modelExecRole = new iam.Role(this, "ModelExecRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });

    const modelTaskDef = new ecs.FargateTaskDefinition(this, "ModelTaskDef", {
      // x86_64: torch CPU wheels are only published for amd64
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      // 4 vCPU is the minimum that supports 10240 MiB memory in Fargate
      cpu: 4096,
      memoryLimitMiB: modelMemoryMb,
      taskRole: modelTaskRole,
      executionRole: modelExecRole,
    });
    modelTaskDef.addContainer("Model", {
      image: ecs.ContainerImage.fromDockerImageAsset(modelImage),
      logging: ecs.LogDrivers.awsLogs({ logGroup: modelLogs, streamPrefix: "model" }),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        PORT: "8080",
        TASK_MEMORY_MB: String(modelMemoryMb),
        MODEL_MAP: JSON.stringify(modelMap),
        DEFAULT_MODEL: Object.keys(modelMap)[0] ?? "",
        METRICS_NAMESPACE,
        USAGE_STREAM: modelStream.ref,
      },
      healthCheck: {
        // python:3.11-slim has no curl; use python to probe the health endpoint.
        command: ["CMD-SHELL", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:8080/healthz')\" || exit 1"],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 5,
        // The model loads ~4.8 GB of weights at startup before uvicorn accepts connections.
        // 25-60 s for weights + uvicorn startup + first healthz response = allow 3 minutes.
        startPeriod: Duration.seconds(180),
      },
    });

    const modelAlbSg = new ec2.SecurityGroup(this, "ModelAlbSg", { vpc: vpc as ec2.IVpc, allowAllOutbound: true });
    const modelSvcSg = new ec2.SecurityGroup(this, "ModelSvcSg", { vpc: vpc as ec2.IVpc, allowAllOutbound: true });
    // Only the ALB can reach the model tasks
    modelSvcSg.addIngressRule(modelAlbSg, ec2.Port.tcp(8080));

    const modelAlb = new elbv2.ApplicationLoadBalancer(this, "ModelAlb", {
      vpc: vpc as ec2.IVpc,
      internetFacing: false,
      securityGroup: modelAlbSg,
    });
    const modelListener = modelAlb.addListener("ModelListener", { port: 80, open: false });

    const modelService = new ecs.FargateService(this, "ModelService", {
      cluster: modelCluster as ecs.ICluster,
      taskDefinition: modelTaskDef,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [modelSvcSg],
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 0,
    });

    modelListener.addTargets("ModelTargets", {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [modelService],
      healthCheck: {
        path: "/healthz",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    // Give the model time to load weights before CloudFormation checks service stability.
    modelService.node.addDependency(modelAlb);
    const cfnService = modelService.node.defaultChild as ecs.CfnService;
    // 420 s = ~60 s Fargate task startup + up to 60 s uvicorn/lifespan init
    // + up to 60 s weight loading (25-60 s observed) + 4 min buffer.
    // ECS does not count ALB failures against the task until this window expires.
    cfnService.healthCheckGracePeriodSeconds = 420;

    const modelScaling = modelService.autoScaleTaskCount({ minCapacity: 1, maxCapacity: modelMaxTasks });
    modelScaling.scaleOnCpuUtilization("ModelCpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.seconds(120),
      scaleOutCooldown: Duration.seconds(30),
    });

    const modelInternalUrl = `http://${modelAlb.loadBalancerDnsName}`;
    this.modelUrl = modelInternalUrl;

    /* --------------------------------------------------------------- the gateway (ECS Express Gateway) */
    const gatewayLogs = new logs.LogGroup(this, "GatewayLogs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const gatewayImage = new ecr_assets.DockerImageAsset(this, "GatewayImage", {
      directory: ROOT,
      file: "gateway/Dockerfile",
      platform: Platform.LINUX_ARM64,
    });

    const taskExecutionRole = new iam.Role(this, "GatewayTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy"),
      ],
    });

    const taskRole = new iam.Role(this, "GatewayTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    state.grantReadWriteData(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["firehose:PutRecord"], resources: [gatewayStream.attrArn] }),
    );

    // Infrastructure role: Express Gateway uses this to manage the ALB, Fargate tasks,
    // Auto Scaling, security groups, and log groups on your behalf.
    const infrastructureRole = new iam.Role(this, "GatewayInfraRole", {
      assumedBy: new iam.ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"),
      ],
    });

    const expressGateway = new ecs.CfnExpressGatewayService(this, "GatewayService", {
      serviceName: "strands-decider-gateway",
      cpu: String(props.gatewayCpu ?? 256),
      memory: String(props.gatewayMemoryMiB ?? 512),
      executionRoleArn: taskExecutionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      infrastructureRoleArn: infrastructureRole.roleArn,
      healthCheckPath: "/healthz",
      networkConfiguration: {
        subnets: vpc.publicSubnets.map((s) => s.subnetId),
      },
      primaryContainer: {
        image: gatewayImage.imageUri,
        containerPort: 8080,
        awsLogsConfiguration: {
          logGroup: gatewayLogs.logGroupName,
          logStreamPrefix: "gateway",
        },
        environment: [
          { name: "PORT", value: "8080" },
          { name: "TABLE_NAME", value: state.tableName },
          { name: "USAGE_STREAM", value: gatewayStream.ref },
          { name: "DECIDER_URL", value: modelInternalUrl },
          { name: "DECIDER_PATH", value: "/v1/systemone" },
          { name: "DECIDER_TIMEOUT_MS", value: "45000" },
          { name: "DECIDER_RETRIES", value: "2" },
          { name: "DECIDER_AUTH", value: "none" },
          { name: "METRICS_NAMESPACE", value: METRICS_NAMESPACE },
          { name: "CACHE_TTL_SECONDS", value: "300" },
          { name: "APP_VERSION", value: String(this.node.tryGetContext("appVersion") ?? "unset") },
        ],
      },
      scalingTarget: {
        minTaskCount: 0,
        maxTaskCount: props.gatewayMaxTasks ?? 10,
        autoScalingMetric: "AVERAGE_CPU",
        autoScalingTargetValue: 60,
      },
    });
    expressGateway.node.addDependency(infrastructureRole);

    this.gatewayUrl = expressGateway.attrEndpoint;
    this.tableName = state.tableName;

    /* ------------------------------------------------- the filing system and auditors */
    this.catalog(records);
    const dashboardName = this.controlTower(gatewayLogs, modelLogs, props.alarmEmail);

    /* ------------------------------------------------------------------ outputs */
    new CfnOutput(this, "GatewayUrl", {
      value: expressGateway.attrEndpoint,
      description: "ECS Express Gateway public endpoint.",
    });
    new CfnOutput(this, "ModelUrl", {
      value: modelInternalUrl,
      description: "Decider internal ALB URL. Reachable only from within the VPC.",
    });
    new CfnOutput(this, "TableName", { value: state.tableName, description: "Seed tenants into this table." });
    new CfnOutput(this, "RecordsBucket", { value: records.bucketName });
    new CfnOutput(this, "AthenaWorkgroup", { value: ATHENA_WORKGROUP });
    new CfnOutput(this, "DashboardUrl", {
      value: `https://${Aws.REGION}.console.aws.amazon.com/cloudwatch/home?region=${Aws.REGION}#dashboards/dashboard/${dashboardName}`,
    });

  }

  /** One DirectPut delivery stream into a day-partitioned prefix, GZIP-compressed. */
  private deliveryStream(
    id: string,
    bucket: s3.Bucket,
    role: iam.Role,
    prefix: string,
  ): firehose.CfnDeliveryStream {
    const stream = new firehose.CfnDeliveryStream(this, id, {
      deliveryStreamType: "DirectPut",
      extendedS3DestinationConfiguration: {
        bucketArn: bucket.bucketArn,
        roleArn: role.roleArn,
        prefix: `${prefix}/day=!{timestamp:yyyy-MM-dd}/`,
        errorOutputPrefix: `errors/${prefix}/!{firehose:error-output-type}/day=!{timestamp:yyyy-MM-dd}/`,
        // 60 s of latency is invisible next to a 3-5 s inference; the alternative, 5-minute
        // buffers, is not. The size trigger is what actually flushes under load.
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
        compressionFormat: "GZIP",
      },
    });
    stream.node.addDependency(role);
    return stream;
  }

  /**
   * The Glue catalog and the Athena workgroup.
   *
   * Both tables use partition projection rather than a crawler: `day` is a synthetic
   * partition, so today's data is queryable the moment it lands and there is no crawler
   * to be silently broken. The cost is that the partition range is a guess — hence the
   * explicit start date, which must predate the deployment.
   */
  private catalog(bucket: s3.Bucket): void {
    const database = new glue.CfnDatabase(this, "Database", {
      catalogId: Aws.ACCOUNT_ID,
      databaseInput: {
        name: GLUE_DATABASE,
        description: "Strands Decider gateway usage and model inference records.",
      },
    });

    const gatewayTable = this.glueTable("GatewayTable", GATEWAY_TABLE, bucket, "gw-usage", [
      ["request_id", "string"],
      ["ts", "string"],
      ["tenant", "string"],
      ["model", "string"],
      ["model_id", "string"],
      ["cache", "string"],
      ["latency_ms", "int"],
      ["model_latency_ms", "int"],
      ["model_load_ms", "int"],
      ["cold_start", "boolean"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["questions", "int"],
      ["confidence_floor", "double"],
      ["bands", "string"],
      ["answers", "string"],
    ]);
    gatewayTable.addResourceDependency(database);

    const modelTable = this.glueTable("ModelTable", MODEL_TABLE, bucket, "model-inference", [
      ["request_id", "string"],
      ["ts", "string"],
      ["model", "string"],
      ["questions", "int"],
      ["latency_ms", "int"],
      ["cold_start", "boolean"],
      ["model_load_ms", "int"],
      ["input_tokens", "int"],
      ["output_tokens", "int"],
      ["device", "string"],
    ]);
    modelTable.addResourceDependency(database);

    const results = new s3.Bucket(this, "AthenaResults", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(7) }],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const workgroup = new athena.CfnWorkGroup(this, "Workgroup", {
      name: ATHENA_WORKGROUP,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        // A 1 GB scan ceiling per query: an accidental unfiltered join on a year of
        // records should fail loudly, not quietly bill.
        bytesScannedCutoffPerQuery: 1_000_000_000,
        resultConfiguration: { outputLocation: `s3://${results.bucketName}/` },
      },
    });

    const queriesDir = path.join(ROOT, "queries");
    for (const file of readdirSync(queriesDir).filter((f) => f.endsWith(".sql")).sort()) {
      const stem = path.basename(file, ".sql");
      const query = new athena.CfnNamedQuery(this, `Query-${stem}`, {
        name: stem.replace(/_/g, " "),
        description: firstComment(path.join(queriesDir, file)),
        database: GLUE_DATABASE,
        workGroup: workgroup.name,
        queryString: readFileSync(path.join(queriesDir, file), "utf8"),
      });
      query.addResourceDependency(workgroup);
    }
  }

  private glueTable(
    id: string,
    name: string,
    bucket: s3.Bucket,
    prefix: string,
    columns: [string, string][],
  ): glue.CfnTable {
    return new glue.CfnTable(this, id, {
      catalogId: Aws.ACCOUNT_ID,
      databaseName: GLUE_DATABASE,
      tableInput: {
        name,
        tableType: "EXTERNAL_TABLE",
        parameters: {
          classification: "json",
          "projection.enabled": "true",
          "projection.day.type": "date",
          "projection.day.format": "yyyy-MM-dd",
          // Must predate the first deployment, or early partitions silently do not exist.
          "projection.day.range": "2026-01-01,NOW",
          "projection.day.interval": "1",
          "projection.day.interval.unit": "DAYS",
          "storage.location.template": `s3://${bucket.bucketName}/${prefix}/day=\${day}/`,
        },
        partitionKeys: [{ name: "day", type: "string" }],
        storageDescriptor: {
          location: `s3://${bucket.bucketName}/${prefix}/`,
          inputFormat: "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            // A single malformed line — a truncated record from a killed container —
            // must not make a whole partition unreadable.
            parameters: { "ignore.malformed.json": "true" },
          },
          columns: columns.map(([columnName, type]) => ({ name: columnName, type })),
        },
      },
    });
  }

  /** The control tower: one dashboard, three alarms, two saved log queries. */
  private controlTower(
    gatewayLogs: logs.LogGroup,
    modelLogs: logs.LogGroup,
    alarmEmail?: string,
  ): string {
    const metric = (name: string, stat = "Sum", dimension: Record<string, string> = { Service: "strands-decider-gateway" }): cw.Metric =>
      new cw.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: name,
        dimensionsMap: dimension,
        statistic: stat,
        period: Duration.minutes(1),
        label: `${name} ${stat}`,
      });

    const rate = (label: string, expression: string, usingMetrics: Record<string, cw.IMetric>): cw.MathExpression =>
      new cw.MathExpression({ expression, usingMetrics, label, period: Duration.minutes(1) });

    const percentiles = (name: string, dimension?: Record<string, string>): cw.Metric[] => [
      metric(name, "p50", dimension),
      metric(name, "p95", dimension),
      metric(name, "p99", dimension),
    ];

    const requests = metric("Requests");
    const errors = metric("Errors");
    // The denominator is successes + failures, because `Errors` is emitted per failure and
    // `Requests` per success — a plain `n / d` would read as a 100% error rate under a
    // partial outage.
    const errorRate = rate("Error rate %", "IF(d + n > 0, 100 * n / (d + n), 0)", { n: errors, d: requests });
    const cacheHitRate = rate("Cache hit rate %", "IF(h + x > 0, 100 * h / (h + x), 0)", {
      h: metric("CacheHit"),
      x: requests,
    });

    const dashboard = new cw.Dashboard(this, "ControlTower", { dashboardName: DASHBOARD_NAME });

    dashboard.addWidgets(
      new cw.SingleValueWidget({
        title: "Last hour",
        metrics: [
          metric("Requests", "Sum", { Service: "strands-decider-gateway" }),
          metric("Latency", "p95"),
          metric("ModelLatency", "p95"),
          metric("ColdStart"),
          metric("Errors"),
        ],
        period: Duration.hours(1),
        width: 24,
      }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({ title: "End-to-end latency (ms)", left: percentiles("Latency"), width: 12 }),
      new cw.GraphWidget({ title: "Model inference only (ms): the gateway's own overhead is the gap", left: percentiles("ModelLatency"), width: 12 }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Cold starts and model load time: the cost of a 4.8 GB checkpoint",
        left: [metric("ColdStart"), metric("ModelLoadTime", "Average")],
        width: 12,
      }),
      new cw.GraphWidget({ title: "Cache hit rate %", left: [cacheHitRate], width: 12 }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({ title: "Requests, errors and throttles per minute", left: [requests, errors, metric("Throttled")], width: 8 }),
      new cw.GraphWidget({ title: "Error rate %: the alarm fires above 5%", left: [errorRate], width: 8 }),
      new cw.GraphWidget({
        title: "Confidence floor: the weakest answer in each batch",
        left: [metric("ConfidenceFloor", "Average"), metric("ConfidenceFloor", "p10")],
        width: 8,
      }),
      // CloudWatch cannot average a gauge per-tenant on this side, so the SEARCH expression
      // is what turns "some tenant is near their limit" into a question you can see.
      new cw.GraphWidget({
        title: "Quota utilization % by tenant",
        left: [
          new cw.MathExpression({
            expression: `SEARCH('{${METRICS_NAMESPACE},Service,Tenant} MetricName="QuotaUtilization"', 'Maximum', 300)`,
            usingMetrics: {},
            label: "",
            period: Duration.minutes(5),
          }),
        ],
        width: 8,
      }),
    );

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Gateway service (ECS Express Gateway): CPU/Memory",
        left: [
          new cw.Metric({ namespace: "AWS/ECS", metricName: "CPUUtilization", dimensionsMap: { ServiceName: "strands-decider-gateway" }, statistic: "Average" }),
          new cw.Metric({ namespace: "AWS/ECS", metricName: "MemoryUtilization", dimensionsMap: { ServiceName: "strands-decider-gateway" }, statistic: "Average" }),
        ],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Model service (Fargate): CPU/Memory",
        left: [
          new cw.Metric({ namespace: "AWS/ECS", metricName: "CPUUtilization", dimensionsMap: { ClusterName: "ModelCluster", ServiceName: "ModelService" }, statistic: "Average" }),
          new cw.Metric({ namespace: "AWS/ECS", metricName: "MemoryUtilization", dimensionsMap: { ClusterName: "ModelCluster", ServiceName: "ModelService" }, statistic: "Average" }),
        ],
        width: 12,
      }),
    );

    /* ------------------------------------------------------------------- alarms */
    const topic = alarmEmail ? new sns.Topic(this, "Alarms", { displayName: "Strands Decider alarms" }) : undefined;
    if (topic && alarmEmail) {
      new sns.Subscription(this, "AlarmEmail", {
        topic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: alarmEmail,
      });
    }

    const alarms: cw.Alarm[] = [
      new cw.Alarm(this, "ErrorRateHigh", {
        alarmName: "strands-decider-error-rate-high",
        alarmDescription: "More than 5% of requests are failing. Check the model function's logs before the gateway's.",
        // Errors are emitted per failure, requests per success, so the denominator needs both.
        metric: rate("Error rate %", "IF(d + n > 0, 100 * n / (d + n), 0)", { n: errors, d: requests }),
        threshold: 5,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, "ModelP95LatencyHigh", {
        alarmName: "strands-decider-model-p95-latency-high",
        alarmDescription: "p95 inference is over 15 s. Either memory is short or the concurrency ceiling is being hit.",
        metric: metric("ModelLatency", "p95"),
        threshold: 15_000,
        evaluationPeriods: 5,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
      new cw.Alarm(this, "ModelColdStartsHigh", {
        alarmName: "strands-decider-model-cold-starts-high",
        alarmDescription: "More than 10 cold starts in 5 minutes: the function is scaling past the point where the model fits in memory, and every new instance pays 25-60 s.",
        metric: metric("ColdStart"),
        threshold: 10,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }),
    ];

    if (topic) {
      for (const alarm of alarms) alarm.addAlarmAction(new cw_actions.SnsAction(topic));
    }

    /* ------------------------------------------------------- saved log queries */
    new logs.QueryDefinition(this, "FindRequest", {
      queryDefinitionName: "strands-decider/find-request-by-id",
      queryString: new logs.QueryString({
        fields: ["@timestamp", "stage", "tenant", "model", "cache", "latency_ms", "model_latency_ms", "cold_start", "confidence_floor"],
        filterStatements: ['request_id = "PASTE-REQUEST-ID"'],
        sort: "@timestamp asc",
      }),
      logGroups: [gatewayLogs],
    });

    new logs.QueryDefinition(this, "SlowestRequests", {
      queryDefinitionName: "strands-decider/slowest-requests",
      queryString: new logs.QueryString({
        fields: ["@timestamp", "request_id", "tenant", "model", "latency_ms", "model_latency_ms", "cold_start", "questions", "confidence_floor"],
        filterStatements: ['stage = "request"'],
        sort: "latency_ms desc",
        limit: 20,
      }),
      logGroups: [gatewayLogs],
    });

    new logs.QueryDefinition(this, "ModelColdStarts", {
      queryDefinitionName: "strands-decider/model-cold-starts",
      queryString: new logs.QueryString({
        fields: ["@timestamp", "request_id", "model", "model_load_ms", "latency_ms"],
        filterStatements: ['cold_start = true'],
        sort: "@timestamp desc",
        limit: 50,
      }),
      logGroups: [modelLogs],
    });

    return DASHBOARD_NAME;
  }
}

/** The first `--` comment block in a `.sql` file, used as the saved query's description. */
function firstComment(file: string): string {
  if (!statSync(file).isFile()) return "";
  const lines = readFileSync(file, "utf8").split("\n");
  const comment = lines
    .filter((line) => line.trim().startsWith("--"))
    .map((line) => line.replace(/^\s*--\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return comment.slice(0, 200);
}
