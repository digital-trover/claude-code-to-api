# Design notes

Why this service is built the way it is. Read `README.md` first — this is the
detail behind it.

- [Cost: what the harness adds](#cost-what-the-harness-adds)
- [Credentials](#credentials)
- [How tool calling works](#how-tool-calling-works)
- [Continuing a conversation](#continuing-a-conversation)
- [Limits and failure handling](#limits-and-failure-handling)
- [Known gaps](#known-gaps)
- [Deployment](#deployment)
- [Layout](#layout)

---

## Cost: what the harness adds

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

1. **On `ANTHROPIC_API_KEY` this service is more expensive than calling the API
   directly.** It is not a cost optimisation. Use it on a subscription
   credential, where tokens draw down rate limit rather than money.
2. **Subscription credentials are for your own automation.** Pointing shared or
   customer traffic at one is outside the terms, and the rate limits — sized for
   one person at a keyboard — collapse under concurrency regardless.

The service warns at boot if it finds any Claude credential in its own
environment, since that would be used for callers who supplied none.

---

## Credentials

The service runs on **the caller's** Claude account and stores none of its own.
Every request carries the user's token in `x-claude-token`, so a compromised
instance costs no accounts and each user draws on their own rate limit.

Both subscription tokens (`sk-ant-oat…`) and API keys (`sk-ant-api…`) are
accepted; the kind is detected by prefix and routed to the right upstream
variable.

For local development, `ALLOW_AMBIENT_CREDENTIAL=1` lets requests without the
header fall back to this machine's own `claude` login. Never set it in a
deployment; a container has no such login, so production fails closed anyway.

### Expiry

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

### Connecting an account without copy-paste

There is **no third-party OAuth flow for Claude subscriptions** — no client to
register, no `client_id`, no redirect to authorise against. Building a "Connect
with Claude" button would mean driving Anthropic's own first-party OAuth client
to mint tokens on your users' behalf, which is client impersonation whatever the
intent. The supported handoff is `claude setup-token`, which is interactive by
design.

What can be removed is the copy-paste, not the browser step.
`scripts/connect.sh` runs on the user's own machine, takes one argument, and
posts the token straight to your platform:

```bash
./scripts/connect.sh https://your-platform/claude/connect/7Q2K-9WXT
```

You generate that URL — single-use, short-lived, and carrying whatever identifies
the account. The token never reaches a clipboard, a chat window, or shell
history: the script refuses a non-https URL, sends the token on stdin rather
than as an argument where any local process could read it from the process
table, and never prints it.

Verify it server-side when it arrives, with `/v1/credentials/verify`.

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

### Why there is a service token as well

Requests carry two credentials that are easy to confuse, because they protect
different things:

| Header | What it is | What it protects |
|---|---|---|
| `x-api-key` (or `authorization: Bearer`) | `SERVICE_AUTH_TOKEN` — gates **this service** | Your container |
| `x-claude-token` | The caller's own Claude credential | Their Anthropic account |

The service token is not about protecting the Claude key — that arrives per
request and is never stored. It exists because `POST /v1/runs` runs with
`bypassPermissions`, which is a shell on this container. Without the token,
anyone who can reach the port can bring *their own* Claude credential and use
your machine as free compute with arbitrary code execution.

So whether you need it follows from reachability, not from secrecy:

- **Loopback only** (the default `HOST`): nothing off-box can reach it, and the
  token adds nothing.
- **Bound to `0.0.0.0`, or a ClusterIP service**: it is the only thing between
  any pod in the cluster and a shell here.

The service warns at startup when it is unset *and* bound to a non-loopback
address, which is exactly the case where its absence matters.

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

---

## Continuing a conversation

The harness is stateful; this API is not. Every response carries a session
reference — `_headless.session_id` on `/v1/messages`, `session_id` on `/v1/runs`
— and sending it back as `x-session-id` continues that conversation.

```bash
REF=$(curl -s ... | jq -r '._headless.session_id')
curl ... -H "x-session-id: $REF" -d '{"messages":[{"role":"user","content":"and what did I say before?"}]}'
```

On a resumed turn, **send only the new message**. The transcript already exists
on the harness side, so re-sending history would show the model its own
conversation twice.

Without a reference each request is a cold start: earlier turns are replayed as
recounted context rather than real turns, because the harness accepts user
messages but not assistant ones. That is lossy, so treat it as the first turn of
a conversation or as recovery — not the steady state.

References are **bound to the credential** that created them. The binding key is
derived from the token itself, so it needs no configuration and survives a
restart, while a reference leaked through a log is inert in anyone else's hands.
One that does not verify is treated as absent — a fresh session, never someone
else's.

### The `tool_use.id` contract

A tool loop has the same problem, but a client mid-loop is not obliged to carry
a header. The one field the protocol *does* require it to echo verbatim is
`tool_use.id`, so the reference rides inside it:

```
toolu_01Q4wJxoDB87FRno89XdthZo~9be0403a-...-dee9a600f3c8.a_4-4thHgk-G7ZtO
└─ harness tool_use id ────────┘ └─ session id ──────────┘└─ signature ──┘
```

The service packs it on the way out and unpacks it from `tool_result.tool_use_id`
on the way back. Clients treat `tool_use.id` as opaque, so this is invisible to
them — but a client that *rewrites* the id will break the continuation.

When no session can be resolved (the process restarted, or the caller trimmed
the transcript) the service falls back to a cold start: prior turns are replayed
as recounted context rather than real turns. Correct, but lossy — assume it is
recovery, not the normal path.

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

---

## Known gaps

| Feature | Status |
|---|---|
| `max_tokens` | Accepted (the API requires it) but **not enforced** — the harness exposes no output cap, so a response may exceed it. Each overrun is logged. `stop_reason: "max_tokens"` reflects the harness's own cap, not yours |
| `temperature`, `top_p`, `top_k` | **Rejected with 400.** Not exposed by the harness, so honouring them is impossible; refused rather than silently dropped |
| `stop_sequences` | **Rejected with 400.** The harness ends turns on its own |
| `count_tokens` | **501 deliberately.** The harness reports usage only after a turn has run. An estimate would be worse than a refusal — a caller sizing a context window against a wrong number fails later and further from the cause |
| Prompt caching control (`cache_control`) | Ignored. The harness manages its own caching |
| Structured outputs (`output_config.format`) | Not supported |
| Thinking blocks | Stripped. Their signatures are bound to the harness session and cannot be replayed by a caller |
| Batches API | Not supported |
| Multi-turn history on a cold start | Flattened to recounted context — see above |
| Expiry ahead of time | Not possible; tokens are opaque. Poll `/v1/credentials/status` instead |

---

## Deployment

Every request is short-lived, but session transcripts must persist between them.

**Recommended: one small always-on container with two volumes** — `/workspace`
for user files and `/sessions` for transcripts. Roughly $3–5/month.

The image must be **glibc, not musl**. Claude Code ships as a platform-specific
native binary selected from optionalDependencies, and an alpine base resolves
the `-musl` variant; mixing them fails at runtime with *"binary exists but
failed to launch … musl dynamic loader missing"*, which surfaces as an opaque
500 rather than a build error.

The Dockerfile is multi-stage: TypeScript is compiled in the builder, and only
production dependencies, `dist/` and `openapi.json` reach the runtime image —
`typescript`, `tsx` and `@types` (~26MB) stay behind. `tini` is the entrypoint
because every turn spawns a `claude` subprocess which spawns its own children,
and Node as PID 1 does not reap orphaned grandchildren.

`.dockerignore` matters here more than usual: `node_modules` holds a ~265MB
platform-specific binary for whatever machine last ran `npm install`, and
shipping it into the build context is both slow and the wrong architecture.

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

### Workspace files

Agent runs write to the workspace; two routes read it back. Read-only and
pull-based, so nothing that writes elsewhere — a git remote, an object store —
needs a credential inside the sandbox where agent code runs.

```bash
# Manifest. Dependency trees and build output are filtered; add &all=1 to see them.
curl "$BASE/v1/workspace/files?prefix=agent" -H "x-api-key: $SERVICE_AUTH_TOKEN"
# -> {"files":[{"path":"agent/graph.py","size":64,"modified":1786100497959}],"truncated":false}

# One file, raw bytes.
curl "$BASE/v1/workspace/raw?path=agent/graph.py" -H "x-api-key: $SERVICE_AUTH_TOKEN"
```

Contents are never inlined or base64-wrapped. A caller that needs base64 — for a
git blob, say — encodes the bytes it received, which is also the only way binary
files survive intact. `content-length` is set so a truncated transfer is
detectable.

Both routes are confined by the same guard as `cwd`: absolute paths and `..`
are rejected, and symlinks are not followed.

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
    session-ref.ts      signed, credential-bound session references
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
    workspace.route.ts  meta.route.ts   relay.ts
  core/
    context.ts          per-turn context
    files.ts            workspace manifest + file resolution
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
scripts/smoke.sh        74-check end-to-end suite
scripts/connect.sh      user-run account connection helper
```

Two runtime dependencies: `@anthropic-ai/claude-agent-sdk` and `zod`.
