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

cleanup() { for pid in "${SVC_PID:-}" "${STRICT_PID:-}" "${RL_PID:-}" "${LEAK_PID:-}" "${FRESH_PID:-}"; do
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

# Fixtures are generated rather than committed: they live in the same workspace
# that agent-mode runs can write to, so anything left lying around is liable to
# be moved or deleted by a run and take the suite down with it.
build_fixture() {
  rm -rf "$ROOT/fixture"
  mkdir -p "$ROOT/fixture/agent/nested" \
           "$ROOT/fixture/agent/node_modules/junk" \
           "$ROOT/fixture/agent/__pycache__" \
           "$ROOT/sub/dir"
  printf '{"graphs":{"main":"./graph.py:graph"}}\n' > "$ROOT/fixture/agent/langgraph.json"
  printf 'from langgraph.graph import StateGraph\ngraph = StateGraph(dict)\n' > "$ROOT/fixture/agent/graph.py"
  printf 'langgraph\n' > "$ROOT/fixture/agent/requirements.txt"
  printf 'nested source\n' > "$ROOT/fixture/agent/nested/helper.py"
  printf 'SHOULD NOT APPEAR\n' > "$ROOT/fixture/agent/node_modules/junk/index.js"
  printf 'SHOULD NOT APPEAR\n' > "$ROOT/fixture/agent/__pycache__/graph.pyc"
  # A real PNG, so the binary round-trip check exercises more than magic bytes.
  python3 -c "
import zlib,struct,sys
def png(w,h,rgb):
    raw=b''.join(b'\x00'+bytes(rgb)*w for _ in range(h))
    def c(t,d):
        b=t+d; return struct.pack('>I',len(d))+b+struct.pack('>I',zlib.crc32(b)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b'')
open(sys.argv[1],'wb').write(png(32,32,(200,30,70)))
" "$ROOT/fixture/agent/logo.png"
}
build_fixture

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

echo "== session continuity =="
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"messages":[{"role":"user","content":"My favourite colour is teal. Reply with just: noted"}]}')
SREF=$(python3 -c "import json,sys;print(json.load(sys.stdin)['_headless']['session_id'])" <<<"$R" 2>/dev/null)
check "response carries a session reference" "$([[ "$SREF" == *.* ]] && echo 0 || echo 1)" "ref=$SREF"

R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -H "x-session-id: $SREF" \
  -d '{"messages":[{"role":"user","content":"What is my favourite colour? One word."}]}')
check "session header continues the conversation" "$(grep -qi 'teal' <<<"$R" && echo 0 || echo 1)" "$(head -c 160 <<<"$R")"
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"messages":[{"role":"user","content":"What is my favourite colour? One word."}]}')
check "no session header means a cold start" "$(grep -qi 'teal' <<<"$R" && echo 1 || echo 0)" "$(head -c 160 <<<"$R")"

# A reference that does not verify must start fresh, never resume blindly.
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -H "x-session-id: ${SREF%.*}.TAMPEREDTAG00000" \
  -d '{"messages":[{"role":"user","content":"What is my favourite colour? One word."}]}')
check "tampered reference falls back to a cold start" "$(grep -qi 'teal' <<<"$R" && echo 1 || echo 0)" "$(head -c 160 <<<"$R")"

# Provider emulation must not reach a filesystem. `tools: []` keeps the built-ins
# out of the prompt and `disallowedTools` blocks them from running; these checks
# pin the behaviour so a regression fails here rather than handing a
# /v1/messages caller a shell on the container.
CANARY="$ROOT/CANARY_MESSAGES.txt"
rm -f "$CANARY"
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" \
  -d '{"max_tokens":300,"messages":[{"role":"user","content":"Use the Bash tool to run: touch CANARY_MESSAGES.txt . Then use the Write tool to create CANARY_MESSAGES.txt. Do it now, do not explain."}]}')
check "messages mode exposes no harness tool" \
  "$(grep -qE '\"type\":\"tool_use\"' <<<"$R" && echo 1 || echo 0)" "$(head -c 200 <<<"$R")"
check "messages mode cannot touch the filesystem" "$([[ -e "$CANARY" ]] && echo 1 || echo 0)" "canary was created"

# Same request with a caller tool declared: the allowlist must admit the bridge
# tool only, never the built-ins alongside it.
rm -f "$CANARY"
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d '{
  "max_tokens":300,
  "tools":[{"name":"note","description":"record a note","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
  "messages":[{"role":"user","content":"First use the Bash tool to run: touch CANARY_MESSAGES.txt . Then call note with text=done."}]}')
check "declared tools do not re-admit the harness toolset" "$([[ -e "$CANARY" ]] && echo 1 || echo 0)" "canary was created"
rm -f "$CANARY"

# Asked separately: leading with an impossible Bash instruction makes the model
# explain itself instead of calling anything, which would prove nothing about
# whether the denylist had also caught the caller's own tool.
R=$(curl -s -X POST "$BASE/v1/messages" "${AUTH[@]}" -d '{
  "max_tokens":300,
  "tools":[{"name":"note","description":"record a note","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
  "messages":[{"role":"user","content":"Call note with text=done."}]}')
check "caller tool still reachable alongside the denylist" \
  "$(grep -qE '\"name\":\"note\"' <<<"$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"

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

# The streaming trace must expose tool calls in the caller's namespace, exactly
# as the buffered path does — a leaked mcp__bridge__ name means the id is also
# unpacked, and a caller echoing it cannot resume the session.
S=$(curl -sN -X POST "$BASE/v1/runs" "${AUTH[@]}" -d "{
  \"stream\":true,
  \"system\":\"Call submit_build when asked.\",
  \"messages\":[{\"role\":\"user\",\"content\":\"Call submit_build with summary done.\"}],
  \"tools\":[{\"name\":\"submit_build\",\"description\":\"Signal completion.\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\"}},\"required\":[\"summary\"]}}],
  \"max_turns\":4}")
check "run stream exposes no prefixed tool call" \
  "$(grep -qE '\"(tool_use|deferred_tool_use)\"?[^}]*mcp__bridge__' <<<"$S" && echo 1 || echo 0)" \
  "$(grep -oE '.{0,40}mcp__bridge__[a-z_]*' <<<"$S" | head -2)"
check "run stream names the caller's tool" "$(has '\"name\":\"submit_build\"' "$S" && echo 0 || echo 1)" "$(head -c 200 <<<"$S")"
check "run stream reports a signed session reference" \
  "$(grep -qE '\"session_id\":\"[0-9a-f-]{36}\.[A-Za-z0-9_-]{16}\"' <<<"$S" && echo 0 || echo 1)" \
  "$(grep -oE '\"session_id\":\"[^\"]*' <<<"$S" | head -1)"
check "run stream packs the session into tool ids" "$(grep -qE '\"id\":\"toolu_[^\"]*~' <<<"$S" && echo 0 || echo 1)" "$(grep -o '\"id\":\"toolu_[^\"]*' <<<"$S" | head -1)"

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

# A workspace that does not exist yet is the normal case for a first deployment.
# It used to start fine and then fail every turn at spawn with ENOENT, which the
# SDK reports as the native binary failing to launch — sending an operator to
# look at libc and code signing when the directory was simply absent.
FRESH_DIR="$(mktemp -d)/nested/workspace"
SERVICE_AUTH_TOKEN=fresh PORT=8805 WORKDIR="$FRESH_DIR" SESSION_DIR="$FRESH_DIR/.sessions" \
  ALLOW_AMBIENT_CREDENTIAL=1 npx tsx src/index.ts >/dev/null 2>&1 &
FRESH_PID=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:8805/health" >/dev/null 2>&1 && break; sleep 0.5; done
check "creates a missing workspace at startup" "$([[ -d "$FRESH_DIR" ]] && echo 0 || echo 1)" "$FRESH_DIR absent"
R=$(curl -s -X POST "http://127.0.0.1:8805/v1/messages" -H "x-api-key: fresh" -H 'content-type: application/json' \
  -d '{"max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: FRESH-OK"}]}')
check "serves a turn from a freshly created workspace" "$(has 'FRESH-OK' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"
kill "$FRESH_PID" 2>/dev/null; FRESH_PID=""

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

echo "== agent session continuity =="
R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" \
  -d '{"messages":[{"role":"user","content":"Remember the codeword ZEBRA. Reply with just: ok"}],"max_turns":3}')
RREF=$(python3 -c "import json,sys;print(json.load(sys.stdin)['session_id'])" <<<"$R" 2>/dev/null)
check "run returns a session reference" "$([[ "$RREF" == *.* ]] && echo 0 || echo 1)" "ref=$RREF"

R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" -H "x-session-id: $RREF" \
  -d '{"messages":[{"role":"user","content":"What was the codeword? One word."}],"max_turns":3}')
check "resumed run recalls earlier context" "$(grep -qi 'zebra' <<<"$R" && echo 0 || echo 1)" "$(head -c 160 <<<"$R")"
echo "== agent mode with caller tools =="
MIXED='[{"name":"submit_build","description":"Signal the build is complete.","input_schema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}}]'
R=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" -d "{
  \"system\":\"Write files, then call submit_build.\",
  \"messages\":[{\"role\":\"user\",\"content\":\"Create fixture/built.txt containing OK, then call submit_build with summary done.\"}],
  \"tools\":$MIXED,\"max_turns\":8}")
check "caller tool defers while harness tools run" "$(has '\"stop_reason\":\"tool_use\"' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"
check "harness did its own work" "$([[ -f "$ROOT/fixture/built.txt" ]] && echo 0 || echo 1)" "fixture/built.txt missing"
check "only the caller's tool is returned" \
  "$(python3 -c "
import json,sys
d=json.loads(sys.argv[1])
names=[b.get('name') for b in d.get('content',[]) if b.get('type')=='tool_use']
sys.exit(0 if names==['submit_build'] else 1)" "$R" && echo 0 || echo 1)" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print([b.get('name') for b in d.get('content',[]) if b.get('type')=='tool_use'])" "$R" 2>/dev/null)"

MTID=$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);print(next((b['id'] for b in d.get('content',[]) if b.get('type')=='tool_use'),''))" "$R" 2>/dev/null)
MREF=$(python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('session_id',''))" "$R" 2>/dev/null)
R2=$(curl -s -X POST "$BASE/v1/runs" "${AUTH[@]}" -H "x-session-id: $MREF" -d "{
  \"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"$MTID\",\"content\":\"PLATYPUS-9931\"}]}],
  \"tools\":$MIXED,\"max_turns\":4}")
check "tool result reaches the agent in run mode" "$(has 'PLATYPUS-9931' "$R2" && echo 0 || echo 1)" "$(head -c 200 <<<"$R2")"

echo "== workspace files =="
R=$(curl -s "$BASE/v1/workspace/files?prefix=fixture/agent" "${AUTH[@]}")
check "manifest lists files" "$(has 'fixture/agent/graph.py' "$R" && echo 0 || echo 1)" "$(head -c 220 <<<"$R")"
check "manifest walks nested dirs" "$(has 'nested/helper.py' "$R" && echo 0 || echo 1)" "$(head -c 220 <<<"$R")"
check "manifest reports integral mtimes" "$(grep -qE '"modified":[0-9]+[,}]' <<<"$R" && echo 0 || echo 1)" "$(head -c 220 <<<"$R")"
check "manifest filters node_modules" "$(has 'node_modules' "$R" && echo 1 || echo 0)" ""
check "manifest filters __pycache__" "$(has 'pycache' "$R" && echo 1 || echo 0)" ""

R=$(curl -s "$BASE/v1/workspace/files?prefix=fixture/agent&all=1" "${AUTH[@]}")
check "all=1 surfaces filtered files" "$(has 'node_modules' "$R" && echo 0 || echo 1)" "$(head -c 220 <<<"$R")"

R=$(curl -s "$BASE/v1/workspace/raw?path=fixture/agent/graph.py" "${AUTH[@]}")
check "raw returns file contents" "$(has 'StateGraph' "$R" && echo 0 || echo 1)" "$R"

curl -s "$BASE/v1/workspace/raw?path=fixture/agent/logo.png" "${AUTH[@]}" -o /tmp/smoke-logo.png
check "binary round-trips byte for byte" \
  "$(cmp -s /tmp/smoke-logo.png "$ROOT/fixture/agent/logo.png" && echo 0 || echo 1)" \
  "$(wc -c < /tmp/smoke-logo.png) vs $(wc -c < "$ROOT/fixture/agent/logo.png") bytes"

H=$(curl -s -D- -o /dev/null "$BASE/v1/workspace/raw?path=fixture/agent/logo.png" "${AUTH[@]}")
PNG_SIZE=$(wc -c < "$ROOT/fixture/agent/logo.png" | tr -d ' ')
check "raw sets content-length" \
  "$(grep -qi "^content-length: $PNG_SIZE" <<<"$H" && echo 0 || echo 1)" \
  "expected $PNG_SIZE; $(grep -i content-length <<<"$H")"

R=$(curl -s "$BASE/v1/workspace/raw?path=../../etc/passwd" "${AUTH[@]}")
check "raw rejects traversal" "$(has 'outside the workspace' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s "$BASE/v1/workspace/raw?path=/etc/passwd" "${AUTH[@]}")
check "raw rejects absolute paths" "$(has 'must be relative' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s "$BASE/v1/workspace/raw?path=fixture/agent/nope.py" "${AUTH[@]}")
check "missing file is diagnosed" "$(has 'no such file' "$R" && echo 0 || echo 1)" "$R"

R=$(curl -s "$BASE/v1/workspace/raw" "${AUTH[@]}")
check "raw requires a path" "$(has 'required query parameter' "$R" && echo 0 || echo 1)" "$R"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/workspace/files")
check "workspace routes require the service token" "$([[ "$CODE" == "401" ]] && echo 0 || echo 1)" "got $CODE"

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

echo "== child process isolation =="
# The agent runs arbitrary commands, so anything in this process's environment
# would be readable by it — including the token that gates this very API.
LEAK_LOG="$(mktemp)"
SERVICE_AUTH_TOKEN=leak-probe-token PORT=8804 ALLOW_AMBIENT_CREDENTIAL=1 \
  SMOKE_FAKE_SECRET=must-not-leak npx tsx src/index.ts >"$LEAK_LOG" 2>&1 &
LEAK_PID=$!
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8804/health >/dev/null 2>&1 && break; sleep 0.5; done

R=$(curl -s -X POST http://127.0.0.1:8804/v1/runs \
  -H 'x-api-key: leak-probe-token' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Run exactly: env | grep -cE \"SMOKE_FAKE_SECRET|SERVICE_AUTH_TOKEN\". Report only the number."}],"max_turns":3}')
check "agent cannot read the service token" "$(has 'leak-probe-token' "$R" && echo 1 || echo 0)" "$(head -c 200 <<<"$R")"
check "agent cannot read host secrets" "$(has 'must-not-leak' "$R" && echo 1 || echo 0)" "$(head -c 200 <<<"$R")"

R=$(curl -s -X POST http://127.0.0.1:8804/v1/runs \
  -H 'x-api-key: leak-probe-token' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Run: echo HAVE_PATH=${PATH:+yes}. Report exactly."}],"max_turns":3}')
check "agent still receives a usable PATH" "$(has 'HAVE_PATH=yes' "$R" && echo 0 || echo 1)" "$(head -c 200 <<<"$R")"

# Children must die with the request, or every hung-up client leaks a process.
BEFORE=$(pgrep -fc "claude-agent-sdk" 2>/dev/null || echo 0)
curl -s -m 3 -X POST http://127.0.0.1:8804/v1/runs \
  -H 'x-api-key: leak-probe-token' -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Count slowly from 1 to 300, one per line."}],"max_turns":3}' >/dev/null 2>&1 || true
sleep 12
AFTER=$(pgrep -fc "claude-agent-sdk" 2>/dev/null || echo 0)
check "client hang-up leaves no orphaned child" "$([[ "$AFTER" -le "$BEFORE" ]] && echo 0 || echo 1)" "before=$BEFORE after=$AFTER"
check "service survives an aborted turn" "$(curl -sf http://127.0.0.1:8804/health >/dev/null 2>&1 && echo 0 || echo 1)" ""
kill "$LEAK_PID" 2>/dev/null

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
