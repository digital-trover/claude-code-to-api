# claude-headless-api

Claude Code behind an HTTP endpoint, so you can use the Claude subscription you
already pay for from your own scripts and tools instead of a metered API key.

Two ways to call it:

- **`POST /v1/messages`** — Anthropic Messages API compatible. Point
  `ANTHROPIC_BASE_URL` at this service and an existing client (the Anthropic
  SDKs, LangChain's `ChatAnthropic`, `curl`) works unchanged. Tool calling
  included.
- **`POST /v1/runs`** — agent mode. Claude keeps its own tools (bash, file
  edits, search) and works a task to completion.

Every request carries the caller's own Claude token. The service stores none.

> **It draws down your rate limit, not your wallet — so it is for your own
> automation.** Pointing other people's traffic at a personal subscription is
> outside Anthropic's terms, and those limits collapse under concurrency anyway.
> See [`USAGE.md`](USAGE.md).

---

## 1. Get a Claude token

Install the CLI if you have not already, then mint a long-lived token:

```bash
npm install -g @anthropic-ai/claude-code   # if needed
claude setup-token
```

It opens a browser, you authorise with your own Claude account, and it prints a
token starting `sk-ant-oat01-…`. Valid about a year. Treat it like a password —
whoever holds it can spend your subscription.

If you have API access instead, an `sk-ant-api…` key works in the same field.

```bash
export CLAUDE_TOKEN="sk-ant-oat01-…"
```

## 2. Run the service

```bash
npm install
export SERVICE_AUTH_TOKEN="$(openssl rand -hex 16)"
npm start
```

It binds `127.0.0.1:8787` by default.

## 3. Call it

```bash
curl localhost:8787/v1/messages \
  -H "x-api-key: $SERVICE_AUTH_TOKEN" \
  -H "x-claude-token: $CLAUDE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello"}]}'
```

Or point an existing app at it. The base URL and service token are environment
variables; the Claude credential rides in one extra header:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=$SERVICE_AUTH_TOKEN   # gates this service, not Anthropic
```

```python
client = anthropic.Anthropic(default_headers={"x-claude-token": CLAUDE_TOKEN})
```

Check a token is good before building on it (costs no tokens):

```bash
curl localhost:8787/v1/credentials/verify \
  -H "x-api-key: $SERVICE_AUTH_TOKEN" -H 'content-type: application/json' \
  -d "{\"token\":\"$CLAUDE_TOKEN\"}"
# -> {"valid":true,"kind":"oauth"}
```

**Working on your own machine?** Set `ALLOW_AMBIENT_CREDENTIAL=1` and drop the
`x-claude-token` header — requests then use whatever account `claude` is already
logged into. Local development only.

---

## Two tokens, two jobs

Easy to confuse, so:

| Header | What it is |
|---|---|
| `x-api-key` | `SERVICE_AUTH_TOKEN` — gates **this service**, i.e. your container |
| `x-claude-token` | The **caller's** Claude account, sent per request, never stored |

The service token matters because `/v1/runs` can execute code. On loopback it
adds nothing; bound to `0.0.0.0` it is the only thing between the network and a
shell. Details in [`docs/DESIGN.md`](docs/DESIGN.md#why-there-is-a-service-token-as-well).

## Endpoints

| Route | What it does |
|---|---|
| `POST /v1/messages` | Messages API shape: `model`, `system`, `messages`, `tools`, `stream`. Text, image and PDF blocks. Responses add `_headless: { session_id, cost_usd }` |
| `POST /v1/runs` | Agent mode. Adds `cwd`, `session_id`, `allowed_tools`, `max_turns`. Streaming relays tool calls as they happen |
| `POST /v1/credentials/verify` | Check a token from the body — use when a user first connects |
| `POST /v1/credentials/status` | Check the `x-claude-token` header — use for scheduled re-checks |
| `GET /v1/workspace/files`, `/raw` | Read back files an agent run wrote |
| `GET /v1/models`, `/health`, `/ready`, `/openapi.json` | Metadata. The last three need no auth |

Full contract: [`openapi.json`](openapi.json), also served at `GET /openapi.json`.

**Continuing a conversation:** responses carry a session reference; send it back
as `x-session-id` and include *only* the new message. Without it, each request is
a cold start.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8787` | Bind port |
| `SERVICE_AUTH_TOKEN` | *(empty)* | Required on every request. Empty disables auth — only safe on loopback |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Used when the request names no model |
| `WORKDIR` | `process.cwd()` | Working directory for agent runs |
| `SESSION_DIR` | `<workdir>/.claude-sessions` | Session transcripts |
| `ALLOW_AMBIENT_CREDENTIAL` | *(unset)* | `1` allows requests with no `x-claude-token`. Local development only |
| `MAX_CONCURRENT_TURNS` | `4` | Concurrent harness subprocesses. This is what bounds memory |
| `MAX_QUEUED_TURNS` | `16` | Requests parked waiting for a slot before load is shed |
| `QUEUE_TIMEOUT_MS` | `30000` | How long a queued request waits before a 429 |
| `TURN_TIMEOUT_MS` | `600000` | Hard ceiling per turn |
| `RATE_LIMIT_PER_MINUTE` | `60` | Per-caller budget. `0` disables |
| `RATE_LIMIT_BURST` | `20` | Bucket size |
| `SHUTDOWN_GRACE_MS` | `30000` | How long in-flight turns get on SIGTERM |
| `LOG_LEVEL` | `info` | `debug`, `info`, or `error` |

No Claude credential is configured here — callers send their own.

## Deploying

Build the image and run it with two volumes, `/workspace` and `/sessions`:

```bash
docker build -t claude-headless-api .
docker run -p 8787:8787 -e HOST=0.0.0.0 -e SERVICE_AUTH_TOKEN=… \
  -v ./workspace:/workspace -v ./sessions:/sessions claude-headless-api
```

One small always-on container is enough, roughly $3–5/month. Use a **glibc**
base, not alpine. Cloud Run or Fly auto-stop machines if you want scale-to-zero.
Rationale, and why not Lambda, in [`docs/DESIGN.md`](docs/DESIGN.md#deployment).

## Testing

```bash
./scripts/smoke.sh    # 74 end-to-end checks — spends real tokens
```

## Not supported

`temperature`, `top_p`, `top_k` and `stop_sequences` are **rejected with 400** —
the harness fixes its own sampling, so honouring them is impossible and silently
dropping them would be worse. `max_tokens` is accepted but not enforced.
`count_tokens` returns 501 rather than a guess. Full list in
[`docs/DESIGN.md`](docs/DESIGN.md#known-gaps).

## More

- [`docs/DESIGN.md`](docs/DESIGN.md) — how tool calls are deferred back to the
  caller, how sessions resume, the credential traps this service exists to
  avoid, concurrency limits, deployment notes, source layout.
- [`USAGE.md`](USAGE.md) — operating terms, what you take on if you run this for
  other people.

## Licence

MIT — see [`LICENSE`](LICENSE).

That covers this source code only. Running it means using Anthropic's Claude,
which is governed by Anthropic's terms. Not affiliated with, endorsed by, or
supported by Anthropic.
