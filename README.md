# claude-headless-api

A portable HTTP service that wraps Claude Code headless. It exposes two surfaces:

- **`/v1/messages`** — Anthropic Messages API compatible, including tool calling.
  Point `ANTHROPIC_BASE_URL` at this service and an existing client (LangChain's
  `ChatAnthropic`, the Anthropic SDKs, `curl`) talks to it unchanged.
- **`/v1/runs`** — agent mode. The harness keeps its own tools (bash, file edit,
  search) and works a task to completion.

Callers supply their own Claude credential per request, so a user's personal
subscription backs their own work instead of the platform paying metered API
costs. The service stores no credential of its own.

---

## Read this before you deploy it

**The harness adds ~2,000 prompt tokens to every cold request.** That is the
floor after every available reduction. Measured on `claude-sonnet-4-6` with the
prompt `"Say OK."`:

| configuration | prompt tokens | cost |
|---|---:|---:|
| Claude Code defaults | 17,175 | $0.103 |
| **`tools: []`** (what this service does) | **1,999** | $0.012 |
| `tools: []` + one caller tool | 2,615 | $0.014 |

The same call against `api.anthropic.com` is roughly 20 tokens.

Two consequences:

1. **On `ANTHROPIC_API_KEY` this service is far more expensive than calling the
   API directly.** It is not a cost optimisation. Use it on a subscription
   credential, where tokens draw down rate limit rather than money.
2. **Subscription credentials are for your own automation.** Pointing shared or
   customer traffic at one is outside the terms, and the rate limits — sized for
   one person at a keyboard — collapse under concurrency regardless.

The service warns at boot if it finds any Claude credential in its own
environment, since that would be used for callers who supplied none.

---

## Quick start

```bash
npm install
export SERVICE_AUTH_TOKEN="$(openssl rand -hex 16)"
npm start
```

```bash
curl localhost:8787/v1/messages \
  -H "x-api-key: $SERVICE_AUTH_TOKEN" \
  -H "x-claude-token: sk-ant-oat01-…" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello"}]}'
```

The full request/response contract is in `openapi.json`, also served at
`GET /openapi.json`.

Run the end-to-end suite (60 checks, spends real tokens):

```bash
./scripts/smoke.sh
```

## Bring-your-own credential

The service runs on **the caller's** Claude account and stores none of its own.
Every request carries the user's token in `x-claude-token`, so a compromised
instance costs no accounts and each user draws on their own rate limit.

```
x-api-key:      <service token>   gates access to this service
x-claude-token: sk-ant-oat01-...  the caller's Claude account
```

Both subscription tokens (`sk-ant-oat…`) and API keys are accepted; the kind is
detected by prefix and routed to the right upstream variable.

Validate a token before building anything around it — this costs no tokens, it
authenticates against `GET /v1/models`:

```bash
curl localhost:8787/v1/credentials/verify \
  -H "x-api-key: $SERVICE_AUTH_TOKEN" -H 'content-type: application/json' \
  -d '{"token":"sk-ant-oat01-…"}'
# -> {"valid":true,"kind":"oauth"}
```

For local development, `ALLOW_AMBIENT_CREDENTIAL=1` lets requests without the
header fall back to this machine's own `claude` login. Never set it in a
deployment; a container has no such login, so production fails closed anyway.

### Credential expiry

Subscription tokens last about a year. There is no way to read an expiry out of
the token, and the upstream returns the same 401 for expired, revoked and
malformed — so this service does not pretend to tell them apart. What it reports
instead is the one thing that changes what you do:

```json
{"type":"error","error":{
  "type":"authentication_error",
  "message":"Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  "reauth_required": true}}
```

`reauth_required` means *get a new token*, as opposed to *retry later*. It is
additive — clients that ignore it still see a normal `authentication_error`.

For scheduled health checks, `POST /v1/credentials/status` verifies the token in
the `x-claude-token` header and **always answers 200** when one is present. The
credential's health is the payload, not the outcome of the call, so a monitor
can distinguish "the token is dead" from "the check itself failed":

| `status` | `reauth_required` | Meaning |
|---|---|---|
| `valid` | false | Still good |
| `invalid` | **true** | Expired, revoked or malformed — prompt the user |
| `rate_limited` | false | Says nothing about the credential |
| `unreachable` | false | Upstream down; do not prompt |

### The precedence trap

`ANTHROPIC_API_KEY` silently outranks `CLAUDE_CODE_OAUTH_TOKEN`. If the process
has an API key in its environment and a user's subscription token is injected
*without clearing that key*, the run quietly bills the platform instead of the
user — with no error to notice.

So `core/credentials.ts` writes **every** credential variable into the harness
subprocess on every call, blanking the ones that do not apply, and the service
warns at boot if it finds any credential in its own environment. Tokens are
injected via `Options.env` per call and never set on the service process, so a
shared instance cannot bleed one caller's credential into another's turn.

### The fallback trap

Blanking the environment is not sufficient on its own. The CLI treats an
*invalid* `CLAUDE_CODE_OAUTH_TOKEN` as if it were absent and falls back to
whatever account is logged in on the host — so a caller sending a junk token
would silently run on someone else's account, which is the exact failure this
service exists to prevent.

The fix is `CLAUDE_CONFIG_DIR`: it is pointed at `SESSION_DIR`, a service-owned
directory that holds session transcripts and no stored login. With nothing to
fall back to, an invalid token fails loudly instead. Measured both ways:

| `CLAUDE_CONFIG_DIR` | bogus OAuth token |
|---|---|
| inherited | succeeds — silently uses the host's login |
| isolated (what this does) | `401 OAuth access token is invalid` |

Ambient mode deliberately inherits the host's config dir, since using the
developer's own login is the whole point of it.

Tokens are never logged — the smoke suite asserts the service log contains no
raw `sk-ant-…` string.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Bind port |
| `SERVICE_AUTH_TOKEN` | *(empty)* | Required on every request. Empty disables auth — only safe on loopback |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Used when the request names no model |
| `WORKDIR` | `process.cwd()` | Working directory for agent runs |
| `SESSION_DIR` | `<workdir>/.claude-sessions` | Session transcripts. Must contain no stored login — see the fallback trap below |
| `TURN_TIMEOUT_MS` | `600000` | Hard ceiling per turn. Headless has none of its own |
| `ALLOW_AMBIENT_CREDENTIAL` | *(unset)* | `1` lets requests without `x-claude-token` use the host's `claude` login. Local development only |
| `MAX_CONCURRENT_TURNS` | `4` | Concurrent harness subprocesses. This is what bounds memory |
| `MAX_QUEUED_TURNS` | `16` | Requests parked waiting for a slot before load is shed |
| `QUEUE_TIMEOUT_MS` | `30000` | How long a queued request waits before a 429 |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-caller budget. `0` disables |
| `RATE_LIMIT_BURST` | `20` | Bucket size |
| `SHUTDOWN_GRACE_MS` | `30000` | How long in-flight turns get on SIGTERM |
| `LOG_LEVEL` | `info` | `debug`, `info`, or `error` |

No Claude credential is configured here — callers send their own per request.

---

## How tool calling works

This is the part that is not obvious, and the reason the service can emulate a
stateless API on top of a stateful agent.

`/v1/messages` expects the **caller** to execute tools: the model returns a
`tool_use` block, you run it, you send back a `tool_result`. Claude Code normally
does the opposite — it executes tools itself and never yields control.

The bridge is a `PreToolUse` hook that returns `permissionDecision: 'defer'`.
The harness then **ends the turn** and reports the pending call, instead of
running it. Two details make it reliable:

- Caller tools are registered as an in-process MCP server with `alwaysLoad`, so
  the model never routes through `ToolSearch` first (which would get deferred
  instead of the real call).
- The hook matcher is scoped to `mcp__bridge__.*`, so built-in tools are
  unaffected.

Because the turn *ends*, no process is parked between HTTP requests. Session
state lives in the CLI's own transcript.

### The `tool_use.id` contract

Continuations need to find the harness session, but the Messages API is
stateless — there is nowhere to put a session id. So it rides inside the one
field the protocol guarantees is echoed back verbatim:

```
toolu_01Q4wJxoDB87FRno89XdthZo~9be0403a-6683-4aaa-9eb3-dee9a600f3c8
└─ harness tool_use id ────────┘ └─ session id ───────────────────┘
```

The service packs it on the way out and unpacks it from `tool_result.tool_use_id`
on the way back. Clients treat `tool_use.id` as opaque, so this is invisible to
them — but a client that *rewrites* the id will break the continuation.

When no session can be resolved (the process restarted, or the caller trimmed
the transcript) the service falls back to a cold start: prior turns are replayed
as recounted context rather than real turns. Correct, but lossy — assume it is
recovery, not the normal path.

---

## API

### `POST /v1/messages`

Anthropic Messages API shape. Supported: `model`, `system`, `messages`, `tools`,
`stream`. Content blocks may be `text`, `image`, or `document` — vision and PDF
input work.

Responses carry a non-standard additive field:

```json
"_headless": { "session_id": "…", "cost_usd": 0.014 }
```

`stream: true` emits standard SSE: `message_start`, `content_block_start`,
`content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.

### `POST /v1/runs`

Agent mode. Same body plus `cwd`, `session_id`, `allowed_tools`, `max_turns`.
Returns `session_id`, `result`, `content`, `usage`, `cost_usd`. With
`stream: true`, relays raw harness events (`assistant`, `user`, `result`, …) so
you can watch tool calls as they happen.

### `POST /v1/credentials/verify`, `POST /v1/credentials/status`

`verify` takes `{"token": "..."}` in the body — use it when a user first
attaches an account. `status` reads `x-claude-token` — use it for scheduled
re-checks. Both cost no tokens and never echo the credential.

### `GET /v1/models`, `GET /openapi.json`, `GET /health`, `GET /ready`

Metadata; `/health`, `/ready` and `/openapi.json` need no auth. `/health` is
liveness and stays 200 while draining; `/ready` is readiness and returns 503 so
the instance leaves rotation first.

### `POST /v1/messages/count_tokens`

Returns **501** deliberately. The harness reports usage only after a turn has
run and exposes no counting endpoint. An estimate here would be worse than a
refusal — a caller sizing a context window against a wrong number fails later
and further from the cause. Call `api.anthropic.com` directly for this.

---

## Limits and failure handling

**Concurrency is the limit that matters.** Every metered turn spawns a `claude`
subprocess holding hundreds of megabytes, so unbounded concurrency is an
out-of-memory kill rather than a slowdown. `MAX_CONCURRENT_TURNS` bounds it;
excess requests queue up to `MAX_QUEUED_TURNS` and are then shed with a 429 and
a `Retry-After` header. The queue is deliberately bounded — an unbounded one
converts a memory problem into a latency problem where everyone times out
instead of some callers succeeding.

**Rate limiting** is a per-caller token bucket, keyed by a hash of the Claude
credential (the raw token is never held in a long-lived map). It is checked
*before* queueing, so a caller over budget is told immediately rather than
occupying a slot to find out. Only harness-backed routes are metered;
`/health`, `/v1/models` and `/openapi.json` are not.

**Client disconnects abort the turn.** Without this a caller who hangs up leaves
the harness running and billing them for output nobody will read. The request's
abort signal is combined with the turn timeout and passed to the harness.

**Errors** are handled at four levels: per-request (mapped onto the Anthropic
error envelope), in-band for SSE once headers are sent, `clientError` for
malformed HTTP at the socket, and `unhandledRejection` / `uncaughtException` at
the process. An uncaught exception drains before exiting rather than dropping
in-flight turns outright — each one is spending real money.

**Shutdown** stops accepting work and waits up to `SHUTDOWN_GRACE_MS` for
in-flight turns. Liveness and readiness are separate endpoints for this reason:
`/ready` returns 503 while draining so the instance leaves the load balancer,
while `/health` stays 200 so the orchestrator does not kill it mid-drain. Set
the pod's `terminationGracePeriodSeconds` above `SHUTDOWN_GRACE_MS`, or the
grace period is moot.

## Known gaps

| Feature | Status |
|---|---|
| `max_tokens` | Validated, not enforced. The harness exposes no output cap; `stop_reason: "max_tokens"` is reported when it happens |
| `temperature`, `top_p`, `top_k` | Ignored. Not exposed by the harness (and removed on current models anyway) |
| Prompt caching control (`cache_control`) | Ignored. The harness manages its own caching |
| Structured outputs (`output_config.format`) | Not supported |
| Thinking blocks | Stripped. Their signatures are bound to the harness session and cannot be replayed by a caller |
| Batches API | Not supported |
| Multi-turn history on a cold start | Flattened to recounted context — see above |
| Expiry ahead of time | Not possible; tokens are opaque. Poll `/v1/credentials/status` instead |

---

## Deployment

Every request is short-lived, but session transcripts must persist between them.

**Recommended: one small always-on container with a volume.** Roughly $3–5/month
and it handles everything below correctly. Mount a volume at the CLI's session
directory.

Why not Lambda:

- `node_modules/@anthropic-ai` is ~286 MB of bundled CLI binaries, which blows
  the 250 MB unzipped limit — container image only, with multi-second cold starts.
- Lambda bills wall-clock, and a turn is mostly *waiting* on the model. You pay
  for idle.
- The 15-minute cap kills long agent runs.
- Its elasticity is unusable here: your ceiling is the Claude account's rate
  limit, reached at single-digit concurrency.

If you want scale-to-zero, use **Cloud Run or Fly auto-stop machines** — container
images, no size limit, 60-minute timeouts.

To run replicas, set `Options.sessionStore` (the SDK supports a pluggable store)
and back it with S3 or Postgres. That removes the local-disk dependency and the
need for sticky routing.

---

## Layout

```
src/
  index.ts              bootstrap
  server.ts             route table, per-request wiring
  config.ts             env parsing, startup warnings
  logger.ts
  types/
    wire.ts             Anthropic request/response shapes
    session-ref.ts      session id packing into tool_use.id
  http/
    errors.ts           ApiError + mapping onto the Anthropic envelope
    respond.ts          JSON and SSE writers
    body.ts             request body reading
    auth.ts             service-token check
    limits.ts           concurrency gate + per-caller rate limiter
  validation/
    assert.ts           field-level assertions
    messages.ts         /v1/messages and /v1/runs bodies
    credentials.ts      /v1/credentials/verify body
  routes/
    messages.route.ts   runs.route.ts   credentials.route.ts
    meta.route.ts       relay.ts
  core/
    context.ts          per-turn context
    options.ts          harness options + prompt selection
    prompt.ts           history rendering, tool-result replay
    run-turn.ts         buffered turn
    stream-turn.ts      SSE turn + agent trace
    turn.ts             block translation, stop reasons, deadlines
    tools.ts            JSON Schema -> Zod, MCP bridge, defer hook
    credentials.ts      token parsing, child env, verification
    workspace.ts        filesystem confinement
    usage.ts            token accounting
openapi.json            served at GET /openapi.json
scripts/smoke.sh        60-check end-to-end suite
```

Two runtime dependencies: `@anthropic-ai/claude-agent-sdk` and `zod`.
