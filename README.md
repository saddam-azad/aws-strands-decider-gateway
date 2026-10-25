# aws-strands-decider-gateway

[Strands Decider](https://github.com/strands-labs/strands-decider) — a system-one classifier
that gives calibrated answers to `noul` (yes/no), `choice` and `score` questions — hosted on
Fargate, behind a TypeScript gateway with multi-tenancy, confidence gating, and an evidence
trail that reaches Athena.

Two services. The gateway runs on ECS Express Gateway (public, scale-to-zero). The model runs
on Fargate behind an internal ALB (private subnet, reachable only from within the VPC). Between
them: a plain HTTP call over the VPC, and a Firehose → S3 → Glue → Athena pipeline that
records every request that went through.

```
                 ┌──────────────────────────┐
  browser ──┐    │  gateway (Node 26, arm64) │      plain HTTP      ┌────────────────────────┐
  curl ─────┼───▶│  ECS Express Gateway      │────────────────────▶│ model (Fargate, x86_64)│
  client ───┘    │  x-api-key auth           │    internal ALB      │ 10 GB, FastAPI/uvicorn │
                 │  API keys → DynamoDB      │    private subnet    │ CPU-only torch + 2B    │
                 │  cache, quota, redaction  │                      │ cold start 25-60 s     │
                 └────────────┬──────────────┘                      └───────────┬────────────┘
                              │ EMF metrics                                     │ EMF metrics
                              ▼                                                 ▼
                     CloudWatch dashboard + alarms          Firehose ─▶ S3 (day partitions)
                                                                            │
                                                Athena workgroup ◀── Glue tables (projection)
```

## Quick start

```bash
bun install
bun run dev                     # fake model + real gateway, on localhost, in ~2 s
```

Then, in another shell:

```bash
curl -s -X POST localhost:3000/v1/systemone \
  -H 'x-api-key: dev' \
  -d '{"state":"a refund is late","questions":{"escalate":{"type":"noul","instructions":"Should this be escalated?"}}}'
```

No AWS account, no torch, no 4.8 GB download. See [Local development](#local-development) for
what that fake is and is not.

To deploy:

```bash
bun run deploy                  # ~15 min the first time: it builds the 6.7 GB image
bun run setup                   # seeds tenants, mints API keys, writes local config
bun run e2e                     # exercises the deployed stack end to end
```

## Why there is no build step

`gateway/` is deployed to ECS **verbatim**. There is no bundler, no transpile, no `dist/`.
The asset is the source, and `gateway/entry.mjs` is 4 lines.

This works because Node 26 strips TypeScript types natively, and three things are kept true so
it keeps working:

1. **`erasableSyntaxOnly`** in `tsconfig.json`. Only type syntax is allowed — no `enum`, no
   `namespace`, no parameter properties, nothing that needs a real transform. Node erases
   types; it does not compile them.
2. **Explicit `.ts` extensions** on every relative import (`allowImportingTsExtensions`).
   Node's resolver does not guess; `./handler.ts` is a file, `./handler` is not.
3. **`entry.mjs` stays a single dynamic import.** The one place a transform could sneak in is
   the entry point itself, so it does one thing: `await import("./bootstrap.ts")`.

The payoff is that a deployed container's stack trace points at `gateway/handler.ts:359`, the
file you edited, with no source maps between you and it. The cost is that the gateway's
dependencies must already exist in the Node 26 runtime. They do: the entire bare specifier set is

```
node:crypto  node:fs  node:path  node:timers/promises  node:url
aws-lambda
@aws-sdk/client-dynamodb  @aws-sdk/client-firehose  @aws-sdk/lib-dynamodb
```

`aws4fetch` is vendored into `gateway/vendor/` — it is no longer used for signing the model
call (the model is internal), but it remains available for any future IAM-authenticated
upstream. See [`gateway/vendor/README.md`](gateway/vendor/README.md).

## The model on Fargate

`model/Dockerfile` builds one image containing a CPU-only torch, `transformers`, the
strands-decider package from git, and the checkpoint itself. It runs as a FastAPI/uvicorn
HTTP server on port 8080, behind an internal ALB in a private subnet.

| | |
|---|---|
| memory | 10240 MiB (Fargate task) |
| CPU | 4 vCPU (minimum that supports 10240 MiB in Fargate) |
| architecture | x86_64 |
| image size | ~6.7 GB |
| cold start | 25–60 s (weights), warm request 3–5 s |
| min tasks | 1 (always warm) |
| max tasks | 4 (bounds the cold-start blast radius) |

Some things that are load-bearing and non-obvious:

- **Only one checkpoint fits.** `strands-decider-2B-qwen3.5-v1-2610` is 4.8 GB: the ungated,
  Apache-2.0 `Qwen/Qwen3.5-2B-Base` torso plus a 235 MB adapter. Larger releases are
  SageMaker-only.
- **CPU upcasts the torso to fp32.** The CPU path is not the fp16 path with a different
  device; it is ~9 GB of resident memory for a 2B model. That is why memory is 10240 MiB.
- **Weights are baked, not downloaded.** `HF_HOME=/opt/hf` puts the Hub cache inside the
  image, and `HF_HUB_OFFLINE=1` makes that promise enforceable.
- **The model loads at startup, not on first request.** The FastAPI `lifespan` hook calls
  `engine()` before the container is marked healthy, so the ALB never routes a request to a
  cold task.
- **The internal ALB is the only ingress.** The model's security group only accepts traffic
  from the ALB's security group on port 8080. There is no public IP and no IAM auth needed
  on this hop.

The decider's `ScoreQuestion.criteria` is `list[str]` and `NoulQuestion.criteria` is an
optional `{"true","false"}` map. The gateway's validator enforces exactly that, so a malformed
question is a 400 in the gateway rather than a 422 three seconds into a forward pass.

## The gateway

`gateway/handler.ts` runs ten gates in a fixed order. Everything that can fail throws a
`DecideError`; one catch at the bottom turns it into a status, and no response ever carries an
upstream body or a stack trace.

| # | gate | notes |
|---|---|---|
| 1 | CORS preflight | answered without touching anything downstream |
| 2 | Body size | payload read once, refused if over 256 KB |
| 3 | Auth | `x-api-key` → SHA-256 → DynamoDB → tenant + app |
| 4 | Validate | questions and state, against the tenant's own limits |
| 5 | Redact | **before** hashing for the cache and before the wire |
| 6 | Cache | L0 in-process, then L1 DynamoDB |
| 7 | Quota | atomic `ADD` against the tenant's hourly bucket |
| 8 | Model | plain HTTP to the internal ALB, with a retry ladder |
| 9 | Gate + format | local confidence metrics, act/review/escalate |
| 10 | Evidence | EMF metrics, a usage record, a structured log line |

Two details worth calling out:

**Redaction is upstream of the cache key.** The cache digest is computed over the redacted
state, so a response cached for one caller cannot be served to a caller whose state differed
only in the redacted material. Getting this order backwards is a data-leak bug that no test
would catch by accident.

**Confidence is computed locally.** The model returns probabilities; the gateway computes
`top`, `margin` and `certainty` itself, and applies the tenant's `bands` to turn them into
`act` / `review` / `escalate`. A vendor `confidence` field is passed through as
`vendorConfidence` for comparison but is never what the routing decision rests on — so a model
change cannot silently move the decision boundary.

### Tenants and keys

Tenants are DynamoDB rows seeded from `config/tenants.json` by `bun run setup`. A tenant can
set its own default model, allowed models, hourly quota, cache TTL, state-size ceiling,
redaction set, and per-app overrides:

```json
{
  "acme": {
    "default_model": "decider-2b",
    "allowed_models": ["decider-2b"],
    "requests_per_hour": 1000,
    "cache_ttl_seconds": 300,
    "redact": ["email", "card", "phone", "\\b\\d{3}-\\d{2}-\\d{4}\\b"],
    "apps": { "risk": { "requests_per_hour": 200, "redact": ["card", "\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b"] } }
  }
}
```

API keys are 32 bytes of CSPRNG prefixed `pk_live_`. Only the SHA-256 is stored: the table
holds `KEY#<sha256>`, never the key. `bun run setup` writes the plaintext to
`client/config.json` and `loadtest/config.json`, both gitignored. A key that lives in a
CloudFormation output is not a secret — anyone with `cloudformation:DescribeStacks` can read
it — so the keys are generated by the script, never by the stack.

`bun run setup --rotate` mints new keys for every entry in the file.

A `redact` entry is either a builtin name — `email`, `card`, `phone` — or, for anything else,
a **case-insensitive regular-expression source**. So `"iban"` is not a builtin and is treated
as the regex `/iban/gi`, which matches the word "iban" and no actual IBAN. Write the pattern
you mean: `"\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b"`. Cards are scrubbed before phones, because
otherwise a 16-digit card number is eaten as a phone number first.

## Local development

```bash
bun run dev          # fake model on :8080, real gateway on :3000
```

`scripts/dev.sh` starts `model/devserver.py --fake` and then `scripts/dev-server.ts`, which
runs **the same handler the ECS task runs**, wrapped in a `node:http` server that translates a
request into an API Gateway v2 event. The translation is deliberate: a second, simplified
request path for development is how "works locally, 502s in the cloud" happens.

Two things are swapped out, and only two:

- **The model** is fake. `--fake` returns plausible probabilities in the model's own wire
  shapes, including the `x-decider-cold-start` and `x-decider-model-load-ms` headers — a
  fake that omits those would hide every bug in the cold-start accounting.
- **The two DynamoDB tables** are `gateway/devfake.ts`, an in-memory object implementing the
  five DynamoDB operations the gateway uses. It parses the same condition expressions
  `policy.ts` and `store.ts` actually pass, and it **throws on any expression it does not
  recognise**, because a condition that silently holds is how a quota stops enforcing without
  anyone noticing.

Everything else is real: auth, validation, redaction, the cache, the quota arithmetic, the
confidence math, the telemetry. The dev server seeds every tenant from `config/tenants.json`
with its real quota, so `429` is reachable locally.

To run the actual model locally:

```bash
bun run model:local                          # downloads 4.8 GB, loads in 25-60 s
DECIDER_URL=http://127.0.0.1:8080 bun run scripts/dev-server.ts
```

`bun run dev` polls `/healthz` rather than sleeping a guessed amount, so the gateway's first
request is never a race.

## The evidence stack

Every request writes three things: an EMF metric, a structured log line, and a usage record.
The usage record goes to Firehose, which buffers for 60 s (or 5 MB) and writes GZIP JSON to
S3 under a day partition:

```
s3://<records>/gw-usage/day=2026-10-20/...
s3://<records>/model-inference/day=2026-10-20/...
```

Glue tables over those prefixes use **partition projection** (`projection.day.range =
2026-01-01,NOW`), so today's partition is queryable the moment Firehose writes it — no
crawler, no `MSCK REPAIR`. The range start must predate the first deploy; if it does not,
queries against earlier days silently return nothing.

`queries/*.sql` are registered as named Athena queries — request traces, daily usage by
tenant, decision bands, cache value, cost of cold starts, lowest-confidence answers worth a
human's time. The workgroup caps a query at 1 GB scanned, so an unfiltered accident fails
loudly rather than billing quietly.

Metrics are EMF, namespace `StrandsDeciderGateway`, dimensioned `[Service]` and
`[Service,Tenant]`; the model emits `[Service,Model]` under the same namespace. The dashboard
is `strands-decider-control-tower`, and three alarms watch the error rate, the model p95
latency, and cold-start frequency. Set an email to wire them up:

```bash
cdk deploy -c alarmEmail=ops@example.com
```

## Load testing

```bash
bun run loadtest baseline      # 10 users, one request each
bun run loadtest load          # ramp past the model's task ceiling
bun run loadtest burst         # everything at once
bun run loadtest coldstart     # every request a cache miss
bun run loadtest quota         # exceed a tenant's hourly limit
bun run loadtest mixed         # all question shapes, all tenants
```

Needs [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) and the config from
`bun run setup`; `loadtest/run.sh` prints install instructions if k6 is missing.

Sizing note: with `maxTaskCount: 4` on the model, `load` is *expected* to bend sharply past
four concurrent callers — beyond that, requests queue for a free task, and those that wait
longer than the gateway's 45 s per-attempt deadline become retries. That bend is the finding,
not a failure. Raise `modelMaxTasks` in `cdk.json` if you need the flat part to extend further
right.

## Layout

```
gateway/            the ECS Express Gateway asset, shipped verbatim
  handler.ts        the ten gates
  backends.ts       the decider HTTP client, retry ladder
  policy.ts         tenants, keys, quota, routing
  confidence.ts     top / margin / certainty, bands
  redact.ts         email, card, phone, iban, ssn
  store.ts          L1 DynamoDB cache
  cache.ts          L0 in-process cache
  telemetry.ts      EMF metrics, usage records, structured logs
  client/           the web client (static, no build)
  vendor/           aws4fetch, vendored
  devfake.ts        in-memory DynamoDB, for `bun run dev` only
model/              the Fargate model service
  Dockerfile        CPU torch + the 4.8 GB checkpoint, baked in; FastAPI/uvicorn server
  handler.py        FastAPI app, model load at startup, inference endpoint
  devserver.py      the same HTTP contract over http.server
  tests/            pytest, no torch required
lib/stack.ts        the CDK stack
bin/app.ts          the CDK app
queries/*.sql       named Athena queries
scripts/            setup, dev, build, run
loadtest/           k6
tests/unit/         node --test, offline
tests/e2e.ts        against a deployed stack
```

## Testing

```bash
bun run typecheck     # tsc --noEmit, strict
bun run test          # node --test, no AWS, no torch, ~3 s
bun run verify        # typecheck + test + synth
cd model && python -m pytest tests/   # no torch required
```

The unit suite covers the ten gates, the retry ladder, the confidence math, the validator, the
telemetry shape, the in-memory table, and the stack's contract. The stack tests assert the
decisions that are expensive to get wrong — the runtime, the memory, the IAM boundary, the
partition projection, the alarm names — rather than a snapshot, which would break on every
unrelated CDK upgrade and tell you nothing.

The model's pytest suite replaces `strands_decider` in `sys.modules` with a stub, so what it
asserts is the HTTP contract — status codes, error shapes, cold-start attribution — not the
model's own correctness, which belongs to the upstream project.

## Configuration

`cdk.json` context:

| key | default | what |
|---|---|---|
| `modelMemoryMb` | 10240 | model Fargate task memory in MiB. 2B at fp32 needs ~9 GB. |
| `modelMaxTasks` | 4 | maximum model tasks. Bounds the cold-start blast radius. |
| `deciderGitRef` | `main` | the strands-decider commit baked into the image. Pin a SHA for a reproducible build. |
| `appVersion` | `unset` | reported by `/healthz`, so a smoke test can tell which build it reached. |
| `alarmEmail` | *(none)* | SNS topic for the three alarms. |

## Cost

The model dominates. At `maxTaskCount: 4` and a warm request of 3–5 s, a 4 vCPU / 10 GB
Fargate task costs roughly $0.0009 per request in vCPU+memory seconds, plus the cold starts.
Unlike Lambda, Fargate tasks with `minCapacity: 1` keep one task warm at all times — you pay
for idle time but avoid cold starts on the first request of the day.

The rest — the gateway on ECS Express Gateway, DynamoDB on-demand, Firehose, S3 with a 30-day
lifecycle, Athena at a 1 GB cap — is noise beside it.

`cdk destroy` removes everything except the two S3 buckets' contents if you keep them; the
buckets themselves are set to destroy with the stack.

## License

Apache-2.0
