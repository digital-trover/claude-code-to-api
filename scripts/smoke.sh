#!/usr/bin/env bash
# End-to-end smoke test. Starts the service on a scratch port, exercises every
# route, and tears down. Requires a working `claude` credential.
set -uo pipefail

PORT="${PORT:-8799}"
BASE="http://127.0.0.1:${PORT}"
TOKEN="smoke-token"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$(mktemp)"
PASS=0
FAIL=0

cleanup() { for pid in "${SVC_PID:-}" "${STRICT_PID:-}" "${RL_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null
  done; true; }
trap cleanup EXIT

check() { # check <name> <condition-result> [detail]
  if [[ "$2" == "0" ]]; then
    printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1))
  else
    printf '  \033[31mFAIL\033[0m %s\n    %s\n' "$1" "${3:-}"; FAIL=$((FAIL+1))
  fi
}

has() { grep -q "$1" <<<"$2"; }

cd "$ROOT"
SERVICE_AUTH_TOKEN="$TOKEN" PORT="$PORT" ALLOW_AMBIENT_CREDENTIAL=1 npx tsx src/index.ts >"$LOG" 2>&1 &
SVC_PID=$!

for _ in $(seq 1 40); do
  curl -sf "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.5
done

AUTH=(-H "x-api-key: $TOKEN" -H 'content-type: application/json')

echo "== auth =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/messages" -H 'content-type: application/json' -d '{"messages":[]}')
check "unauthenticated request is rejected" "$([[ "$CODE" == "401" ]] && echo 0 || echo 1)" "got $CODE"

echo "== validation =="
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d '{"messages":[]}')
check "empty messages rejected" "$(has 'invalid_request_error' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"bad name!"}]}')
check "malformed tool name rejected" "$(has 'must match' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d '{"messages":[{"role":"user","content":"hi"}],"max_tokens":-4}')
check "negative max_tokens rejected" "$(has 'max_tokens' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d 'not json')
check "malformed JSON rejected" "$(has 'malformed JSON' "$R" && echo 0 || echo 1)" "$R"

echo "== metadata routes =="
R=$(curl -s "$BASE/ready")
check "/ready reports ready while serving" "$(has '"ready":true' "$R" && echo 0 || echo 1)" "$R"
R=$(curl -s "$BASE/health")
check "/health reports draining state" "$(has '"draining":false' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s "$BASE/v1/models" "${AUTH[@]}")
check "/v1/models lists models" "$(has 'claude-sonnet-4-6' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/messages/count_tokens" "${AUTH[@]}" -d '{}')
check "count_tokens returns a clear 501" "$(has 'not_implemented_error' "$R" && echo 0 || echo 1)" "$R"

echo "== tier 2: plain completion =="
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"system":"Reply with exactly: PONG","messages":[{"role":"user","content":"ping"}]}')
check "returns an assistant message" "$(has '"role":"assistant"' "$R" && echo 0 || echo 1)" "$R"
check "stop_reason is end_turn" "$(has '"stop_reason":"end_turn"' "$R" && echo 0 || echo 1)" "$R"
check "reports usage" "$(has 'input_tokens' "$R" && echo 0 || echo 1)" "$R"

echo "== tier 2: streaming =="
S=$(curl -sN -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"stream":true,"system":"Reply with exactly: PONG","messages":[{"role":"user","content":"ping"}]}')
for ev in message_start content_block_start content_block_delta content_block_stop message_delta message_stop; do
  check "stream emits $ev" "$(has "event: $ev" "$S" && echo 0 || echo 1)" "$(head -c 300 <<<"$S")"
done
check "stream carries a terminal stop_reason" "$(has '"stop_reason":"end_turn"' "$S" && echo 0 || echo 1)" ""

echo "== tier 3: tool loop (non-streaming) =="
TOOLS='[{"name":"get_weather","description":"Get current weather for a city.","input_schema":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}]'
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d "{\"system\":\"You are a weather bot. Use get_weather.\",\"messages\":[{\"role\":\"user\",\"content\":\"Weather in Paris?\"}],\"tools\":$TOOLS}")
check "turn 1 stops on tool_use" "$(has '"stop_reason":"tool_use"' "$R" && echo 0 || echo 1)" "$R"
check "tool name is un-prefixed" "$(has '"name":"get_weather"' "$R" && echo 0 || echo 1)" "$R"

TUID=$(sed -n 's/.*"type":"tool_use","id":"\([^"]*\)".*/\1/p' <<<"$R")
check "tool_use id carries a session" "$([[ "$TUID" == *"~"* ]] && echo 0 || echo 1)" "id=$TUID"

R2=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d "{
  \"system\":\"You are a weather bot. Use get_weather.\",
  \"messages\":[
    {\"role\":\"user\",\"content\":\"Weather in Paris?\"},
    {\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"$TUID\",\"name\":\"get_weather\",\"input\":{\"city\":\"Paris\"}}]},
    {\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$TUID\",\"content\":\"18C, light rain\"}]}
  ],\"tools\":$TOOLS}")
check "turn 2 completes the loop" "$(has '"stop_reason":"end_turn"' "$R2" && echo 0 || echo 1)" "$R2"
check "turn 2 used the tool result" "$(has '18' "$R2" && echo 0 || echo 1)" "$R2"

echo "== tier 3: tool loop (streaming) =="
S=$(curl -sN -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d "{\"stream\":true,\"system\":\"You are a weather bot. Use get_weather.\",\"messages\":[{\"role\":\"user\",\"content\":\"Weather in Tokyo?\"}],\"tools\":$TOOLS}")
check "stream opens a tool_use block" "$(has '"type":"tool_use"' "$S" && echo 0 || echo 1)" "$(head -c 400 <<<"$S")"
check "stream ends with stop_reason tool_use" "$(has '"stop_reason":"tool_use"' "$S" && echo 0 || echo 1)" ""

echo "== workspace confinement =="
for BAD in '../../etc' '../..' 'a/../../..' '/etc' '/' '\\\\etc'; do
  R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" \
    -d "{\"cwd\":\"$BAD\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_turns\":1}")
  check "cwd $BAD is rejected" \
    "$(has 'invalid_request_error' "$R" && echo 0 || echo 1)" "$R"
done
R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" \
  -d '{"cwd":"nope/missing","messages":[{"role":"user","content":"hi"}],"max_turns":1}')
check "missing cwd is diagnosed clearly" "$(has 'no such directory' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"

mkdir -p "$ROOT/sub/dir"
R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" \
  -d '{"cwd":"sub/dir","messages":[{"role":"user","content":"Reply with exactly: SUBDIR-OK"}],"max_turns":2}')
check "cwd inside the workspace is allowed" "$(has 'SUBDIR-OK' "$R" && echo 0 || echo 1)" "$R"

echo "== tier 1: agent run =="
R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: AGENT-OK"}],"max_turns":3}')
check "run returns a session id" "$(has 'session_id' "$R" && echo 0 || echo 1)" "$R"
check "run returns result text" "$(has 'AGENT-OK' "$R" && echo 0 || echo 1)" "$R"

S=$(curl -sN -X POST "$BASE/v1/runs" "${AUTH[@]}" \
  -d '{"stream":true,"messages":[{"role":"user","content":"Reply with exactly: STREAM-OK"}],"max_turns":3}')
check "run stream relays harness events" "$(has 'event: assistant' "$S" && echo 0 || echo 1)" "$(head -c 300 <<<"$S")"
check "run stream ends with a result" "$(has 'event: result' "$S" && echo 0 || echo 1)" ""

echo "== credentials =="
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -H 'x-claude-token: totally-bogus' \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
check "malformed x-claude-token rejected" "$(has 'sk-ant' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/credentials/verify" "${AUTH[@]}" \
  -d '{"token":"sk-ant-oat01-definitely-not-real-aaaaaaaaaaaaaaaa"}')
check "verify rejects a bad token" "$(has '"valid":false' "$R" && echo 0 || echo 1)" "$R"
check "verify reports the credential kind" "$(has '"kind":"oauth"' "$R" && echo 0 || echo 1)" "$R"
check "verify never echoes the token" "$(has 'definitely-not-real' "$R" && echo 1 || echo 0)" "$R"

R=$(curl -s -X POST "$BASE/v1/credentials/verify" "${AUTH[@]}" -d '{}')
check "verify requires a token" "$(has 'invalid_request_error' "$R" && echo 0 || echo 1)" "$R"

SERVICE_AUTH_TOKEN=t PORT=8802 npx tsx src/index.ts >/dev/null 2>&1 &
STRICT_PID=$!
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8802/health >/dev/null 2>&1 && break; sleep 0.5; done
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8802/v1/messages \
  -H 'x-api-key: t' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
kill "$STRICT_PID" 2>/dev/null
check "x-claude-token required without ambient opt-in" "$([[ "$CODE" == "401" ]] && echo 0 || echo 1)" "got $CODE"

check "service log never contains a raw token" \
  "$(grep -qE 'sk-ant-[A-Za-z0-9_-]{12,}' "$LOG" && echo 1 || echo 0)" \
  "$(grep -oE 'sk-ant-[A-Za-z0-9_-]{12,}' "$LOG" | head -1)"

echo "== credential expiry =="
# The regression that matters: an invalid token must fail, not silently fall
# back to whatever account is logged in on the host.
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -H 'x-claude-token: sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
check "invalid oauth token does not fall back to the host login" \
  "$(has 'authentication_error' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"
check "dead credential is flagged reauth_required" \
  "$(has 'reauth_required' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"

R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -H 'x-claude-token: sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' \
  -d '{"messages":[{"role":"user","content":"hi"}]}')
check "invalid api key is flagged reauth_required" \
  "$(has 'reauth_required' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"

R=$(curl -s -X POST "$BASE/v1/credentials/status" "${AUTH[@]}" \
  -H 'x-claude-token: sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' -d '{}')
check "status reports an invalid credential" "$(has '"status":"invalid"' "$R" && echo 0 || echo 1)" "$R"
check "status sets reauth_required" "$(has '"reauth_required":true' "$R" && echo 0 || echo 1)" "$R"
check "status stamps checked_at" "$(has 'checked_at' "$R" && echo 0 || echo 1)" "$R"
check "status never echoes the token" "$(has 'AAAAAAAA' "$R" && echo 1 || echo 0)" "$R"

R=$(curl -s -X POST "$BASE/v1/credentials/status" "${AUTH[@]}" -d '{}')
check "status without a credential explains why" \
  "$(has 'required to report credential status' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s -X POST "$BASE/v1/credentials/verify" "${AUTH[@]}" \
  -d '{"token":"sk-ant-oat01-definitely-not-real-aaaaaaaaaaaaaaaa"}')
check "verify distinguishes invalid from unreachable" \
  "$(has '"status":"invalid"' "$R" && echo 0 || echo 1)" "$R"

echo "== limits and transport =="
RL_LOG="$(mktemp)"
SERVICE_AUTH_TOKEN=t PORT=8803 ALLOW_AMBIENT_CREDENTIAL=1 RATE_LIMIT_PER_MINUTE=1 \
  RATE_LIMIT_BURST=2 MAX_CONCURRENT_TURNS=1 MAX_QUEUED_TURNS=0 npx tsx src/index.ts >"$RL_LOG" 2>&1 &
RL_PID=$!
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8803/health >/dev/null 2>&1 && break; sleep 0.5; done
RL=(-H 'x-api-key: t' -H 'content-type: application/json')
BODY='{"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'

# burst=2, so sequential requests three and four must be shed.
CODES=""
for _ in 1 2 3 4; do
  CODES="$CODES$(curl -s -o /dev/null -w '%{http_code} ' -X POST http://127.0.0.1:8803/v1/messages "${RL[@]}" -d "$BODY")"
done
check "over-budget caller is shed with 429" "$(grep -q 429 <<<"$CODES" && echo 0 || echo 1)" "codes: $CODES"

H=$(curl -s -D- -o /dev/null -X POST http://127.0.0.1:8803/v1/messages "${RL[@]}" -d "$BODY")
check "429 carries Retry-After" "$(grep -qi '^retry-after' <<<"$H" && echo 0 || echo 1)" "$(head -c 160 <<<"$H")"

R=$(curl -s "http://127.0.0.1:8803/v1/models" -H 'x-api-key: t')
check "unmetered routes bypass the rate limit" "$(has 'claude-sonnet-4-6' "$R" && echo 0 || echo 1)" "$R"

# A client that hangs up must not leave the harness running or raise a 500.
curl -s -m 2 -X POST http://127.0.0.1:8803/v1/runs "${RL[@]}" \
  -d '{"messages":[{"role":"user","content":"Count slowly to fifty."}],"max_turns":3}' >/dev/null 2>&1 || true
sleep 2
check "client disconnect is not a server error" \
  "$(grep -qE '\] error .*(-> 5[0-9][0-9]|uncaught)' "$RL_LOG" && echo 1 || echo 0)" \
  "$(grep -E '\] error' "$RL_LOG" | tail -2)"

STATUS=$(node -e '
const net=require("net");const s=net.connect(8803,"127.0.0.1");
let out="";s.setTimeout(3000,()=>s.destroy());
s.on("connect",()=>s.write("GARBAGE / HTTP/9.9\r\n\r\n"));
s.on("data",d=>out+=d);s.on("close",()=>{console.log(out.split("\r\n")[0]||"");});
s.on("error",()=>console.log("ERR"));' 2>/dev/null)
check "malformed HTTP gets 400, not a crash" "$(grep -q '400' <<<"$STATUS" && echo 0 || echo 1)" "$STATUS"

curl -sf http://127.0.0.1:8803/health >/dev/null 2>&1
check "service survived all of the above" "$?" ""
kill "$RL_PID" 2>/dev/null

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || { echo "--- service log ---"; tail -30 "$LOG"; exit 1; }
