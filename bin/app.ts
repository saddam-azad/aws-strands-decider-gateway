#!/usr/bin/env node
/**
 * The CDK app. `cdk.json` points here; there is no `tsx` or `ts-node` involved, because
 * Node 26 strips the types itself. That is also why every import carries a `.ts` extension.
 */
import * as cdk from "aws-cdk-lib";
import { StrandsDeciderStack } from "../lib/stack.ts";

const app = new cdk.App();

new StrandsDeciderStack(app, "StrandsDecider", {
  env: {
    ...(process.env["CDK_DEFAULT_ACCOUNT"] === undefined
      ? {}
      : { account: process.env["CDK_DEFAULT_ACCOUNT"] }),
    region: process.env["CDK_DEFAULT_REGION"] ?? "us-east-1",
  },
  description: "Strands Decider model on Lambda, behind a TypeScript gateway with an Athena evidence trail.",
  // Email for the three alarms. Unset means they exist and stay silent.
  ...(app.node.tryGetContext("alarmEmail") === undefined
    ? {}
    : { alarmEmail: String(app.node.tryGetContext("alarmEmail")) }),
});

app.synth();
