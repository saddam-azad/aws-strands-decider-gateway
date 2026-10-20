/**
 * A fake decider: an in-process `fetch` that speaks the model's protocol, so the whole
 * handler path (auth, validation, redaction, cache, quota, retries, telemetry) can be
 * exercised without a 6.7 GB container or an AWS account.
 */
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { Questions } from "../../gateway/types.ts";

export interface FakeDeciderOptions {
  /** Answers to return, keyed by question name. Defaults to a confident answer per type. */
  readonly answers?: Record<string, unknown>;
  readonly model?: string;
  readonly status?: number;
  readonly body?: string;
  /** Fail this many times before succeeding, to exercise the retry ladder. */
  readonly failFirst?: number;
  readonly failStatus?: number;
  readonly latencyMs?: number;
  readonly coldStart?: boolean;
  readonly modelLoadMs?: number;
  /** Called with every decoded request body, in order. */
  readonly onRequest?: (body: { state: unknown; questions: Questions; model: string }) => void;
}

/** A plausible answer for each question type, built from the questions themselves. */
export function answerFor(questions: Questions): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const first = options[0] ?? "a";
      answers[name] = {
        choice: first,
        probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.8 : 0.2 / (options.length - 1 || 1)])),
        confidence: 0.8,
      };
    } else if (q.type === "score") {
      const levels = q.criteria.length;
      answers[name] = {
        probabilities: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === levels - 1 ? 0.7 : 0.3 / (levels - 1 || 1)])),
      };
    } else {
      answers[name] = 0.91;
    }
  }
  return answers;
}

export function fakeDecider(options: FakeDeciderOptions = {}): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; init: RequestInit | undefined; body: unknown }[];
} {
  const calls: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  let remaining = options.failFirst ?? 0;

  const fetchImpl = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as { questions: Questions; state: unknown; model: string }) : undefined;
    calls.push({ url, init, body });
    if (body) options.onRequest?.(body);

    if (remaining > 0) {
      remaining -= 1;
      return new Response("upstream is busy", { status: options.failStatus ?? 503, headers: { "retry-after": "0" } });
    }
    if (options.latencyMs) await new Promise((resolve) => setTimeout(resolve, options.latencyMs));
    if (options.status !== undefined) {
      return new Response(options.body ?? "{}", { status: options.status, headers: { "content-type": "application/json" } });
    }

    const answers = options.answers ?? answerFor(body?.questions ?? {});
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(options.coldStart === undefined ? {} : { "x-decider-cold-start": String(options.coldStart) }),
      ...(options.modelLoadMs === undefined ? {} : { "x-decider-model-load-ms": String(options.modelLoadMs) }),
    };
    return new Response(
      JSON.stringify({
        model: options.model ?? "strands-decider-2B-qwen3.5-v1-2610",
        answers,
        usage: { input_tokens: 128, output_tokens: 3 },
        latency_ms: options.latencyMs ?? 12,
      }),
      { status: 200, headers },
    );
  }) as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

/** A DynamoDB document client stub backed by a Map. Only the calls the gateway makes. */
export function fakeDynamo(seed: Record<string, Record<string, unknown>> = {}): {
  client: { send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> };
  items: Map<string, Record<string, unknown>>;
} {
  const items = new Map(Object.entries(seed));

  return {
    items,
    client: {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name;
        const input = command.input;
        const key = (input["Key"] as { pk: string } | undefined)?.pk;

        if (name === "GetCommand" && key !== undefined) {
          const item = items.get(key);
          return item ? { Item: item } : {};
        }
        if (name === "PutCommand") {
          const item = input["Item"] as Record<string, unknown>;
          const pk = item["pk"] as string;
          const existing = items.get(pk);
          const now = Math.floor(Date.now() / 1000);
          if (existing && typeof existing["expires_at"] === "number" && existing["expires_at"] > now) {
            const error = new Error("the conditional request failed");
            error.name = "ConditionalCheckFailedException";
            throw error;
          }
          items.set(pk, item);
          return {};
        }
        if (name === "DeleteCommand" && key !== undefined) {
          items.delete(key);
          return {};
        }
        if (name === "UpdateCommand") {
          const values = input["ExpressionAttributeValues"] as Record<string, number>;
          const expression = String(input["UpdateExpression"] ?? "");
          const current = items.get(String(key)) ?? { pk: key };
          if (expression.includes("ADD requests_used")) {
            const delta = values[":one"] ?? values[":minus"] ?? 0;
            const used = Number(current["requests_used"] ?? 0);
            const ceiling = values[":ceiling"];
            if (input["ConditionExpression"] && ceiling !== undefined && used >= ceiling) {
              const error = new Error("the conditional request failed");
              error.name = "ConditionalCheckFailedException";
              throw error;
            }
            const next = { ...current, requests_used: used + delta, ...(values[":exp"] === undefined ? {} : { expires_at: values[":exp"] }) };
            items.set(String(key), next);
            return { Attributes: { requests_used: next["requests_used"] } };
          }
          return { Attributes: current };
        }
        return {};
      },
    },
  };
}

/** A minimal API Gateway v2 event. */
export function event(overrides: {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestId?: string;
} = {}): APIGatewayProxyEventV2 {
  const path = overrides.path ?? "/v1/systemone";
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: overrides.headers ?? {},
    requestContext: {
      accountId: "123456789012",
      apiId: "test",
      domainName: "test.lambda-url.us-east-1.on.aws",
      domainPrefix: "test",
      http: { method: overrides.method ?? "POST", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: overrides.requestId ?? "req-00000000-0000-4000-8000-000000000000",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2026:00:00:00 +0000",
      timeEpoch: 1_767_225_600_000,
    },
    body: overrides.body ?? "",
    isBase64Encoded: overrides.isBase64Encoded ?? false,
  };
}

export const goodQuestions = {
  deploy: {
    type: "choice",
    instructions: "What should be done with this change?",
    criteria: { ship: "release now", hold: "wait", revert: "roll back" },
  },
} as const;
