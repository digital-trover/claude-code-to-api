#!/usr/bin/env bash
#
# Link a Claude subscription to a platform, without the token passing through a
# clipboard, a chat window, or shell history.
#
#   ./connect.sh https://your-platform/claude/connect/7Q2K-9WXT
#
# The platform generates that URL, single-use and short-lived, and identifies
# the account from it. There is no third-party OAuth flow for Claude
# subscriptions — no client to register, no redirect to authorise against — so
# `claude setup-token` is the supported handoff and it is interactive by design.
# What this removes is the copy-paste, not the browser step.
set -euo pipefail

URL="${1:-}"

if [[ -z "$URL" || "$URL" == -h || "$URL" == --help ]]; then
  echo "Usage: connect.sh <connect-url>" >&2
  echo "  The URL comes from your platform and already carries your enrolment code." >&2
  exit 2
fi

# A bearer token over plaintext is a leaked token.
[[ "$URL" == https://* ]] || { echo "error: the URL must be https" >&2; exit 1; }

command -v claude >/dev/null || {
  echo "error: the 'claude' CLI is not installed — see https://claude.com/claude-code" >&2
  exit 1
}

echo "Opening your browser to authorise. This uses your own Claude subscription." >&2
OUTPUT="$(claude setup-token 2>&1)" || {
  echo "error: claude setup-token failed" >&2
  exit 1
}

# setup-token prints prose around the value, so it is matched by shape. The
# token charset excludes quotes and backslashes, so it needs no JSON escaping.
TOKEN="$(grep -oE 'sk-ant-[A-Za-z0-9_-]{20,}' <<<"$OUTPUT" | head -1 || true)"
unset OUTPUT
[[ -n "$TOKEN" ]] || { echo "error: no token found in the setup-token output" >&2; exit 1; }

# Sent on stdin, never as an argument, where any local process could read it
# from the process table.
STATUS="$(printf '{"token":"%s"}' "$TOKEN" |
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$URL" \
    -H 'content-type: application/json' --data-binary @-)"
unset TOKEN

case "$STATUS" in
  2*) echo "Connected." >&2 ;;
  4*) echo "error: the platform rejected this (HTTP $STATUS) — the link may have expired." >&2; exit 1 ;;
  *)  echo "error: enrolment failed (HTTP $STATUS)." >&2; exit 1 ;;
esac
