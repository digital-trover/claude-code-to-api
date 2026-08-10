# Usage and operating terms

The MIT licence in `LICENSE` governs **this source code**. It says nothing about
the service this code talks to. Running it means using Anthropic's Claude, which
is governed by Anthropic's own terms — and the MIT licence cannot grant you rights
there.

This document sets out what the software does, what an operator is responsible
for, and where the real boundaries are.

> Not legal advice. The author is not a lawyer. Where this document describes
> Anthropic's requirements it is a summary written in good faith, and the
> authoritative sources are linked below. If your use is commercial or
> multi-tenant, read them yourself.

## Not affiliated with Anthropic

This is an independent project. It is not produced, endorsed, sponsored or
supported by Anthropic. "Claude", "Claude Code" and "Anthropic" are trademarks of
Anthropic PBC, used here only to describe what the software interoperates with —
nominative use, not a claim of affiliation.

If you fork or redistribute this, do not name the result in a way that implies it
is an Anthropic product.

## What the software does

It wraps the Claude Code headless harness behind an HTTP API, exposing two
surfaces: an Anthropic Messages API emulation, and an agent-run endpoint. It adds
no model, no inference and no capability of its own. Every request results in a
call to Anthropic's API, made by the Claude Code CLI, using a credential supplied
by the caller.

It stores no Claude credential. It transmits the caller's credential to Anthropic
and nowhere else.

## The credential rule

This is the part that matters most, and the easiest to get wrong.

**Each caller must supply their own Claude credential.** The service is built this
way deliberately: credentials arrive per request in `x-claude-token` and are never
read from the environment.

**Do not point other people's traffic at your own subscription.** A Claude
subscription is licensed for the subscriber's own use. Putting a service in front
of it so that other users' work runs on your account is outside what a personal
subscription permits, regardless of whether money changes hands. It also does not
work in practice: subscription rate limits are sized for one person at a keyboard
and collapse under concurrent load.

Two arrangements are sound:

| Arrangement | Credential |
|---|---|
| Your own automation, your own account | your subscription token |
| A platform serving several users | each user's own token, supplied per request |

The second is what the `x-claude-token` header and `scripts/connect.sh` exist for.
Isolating filesystems with one deployment per user does **not** substitute for
this — separate containers sharing one Claude account are still one account.

## If you operate this for others

You are handling other people's credentials. `sk-ant-oat…` tokens are bearer
credentials with no scoping: whoever holds one can use that subscription for
anything, for about a year.

Minimum obligations:

- **Encrypt at rest.** Never log them. This repository's test suite asserts the
  service log contains no raw `sk-ant-…` string; keep that property in whatever
  stores them.
- **Transport them over TLS only.** `scripts/connect.sh` refuses a non-https
  enrolment URL for this reason.
- **Offer disconnection**, and make clear that deleting your copy does not revoke
  the token at Anthropic — the user must do that in their own account settings.
- **Tell users what you do with it.** They are lending you access to their
  account; that belongs in your privacy policy, not in a footnote.
- **Do not use a user's credential for anything they did not ask for.** Their
  quota is theirs.

## What the Messages API emulation supports

`POST /v1/messages` speaks the Anthropic wire format. What it honours:

| Field | Behaviour |
|---|---|
| `model` | Honoured; falls back to the service `DEFAULT_MODEL` |
| `messages` | Full history each request — the endpoint is stateless. Text, image and document blocks all work |
| `system` | Honoured; replaces the harness system prompt |
| `tools` | Honoured. Deferred back to the caller rather than executed here |
| `stream` | Honoured, including incremental text deltas |
| `metadata` | Accepted and ignored |
| `max_tokens` | Accepted but **not enforced** — see below |

Also available: `GET /v1/models`, and `POST /v1/credentials/status` for checking a
credential without spending tokens.

## What it does not support

The harness generates on its own terms, so parts of the Messages API cannot be
reproduced. These are **rejected with 400** rather than accepted and ignored:

| Field | Why |
|---|---|
| `temperature` | Sampling is fixed by the harness |
| `top_p` | Sampling is fixed by the harness |
| `top_k` | Sampling is fixed by the harness |
| `stop_sequences` | The harness ends turns on its own |

Rejecting rather than ignoring is deliberate. A caller that sets a bound and is
quietly given something else is worse off than one told plainly that the bound
is unavailable — the same reason `count_tokens` returns 501 instead of guessing.

Accepted but **not honoured**, because refusing them would break conforming
clients:

| Field | Behaviour |
|---|---|
| `max_tokens` | Required by the Messages API, but the harness exposes no output limit, so a response may exceed it (measured: 16 requested, 452 produced). The service logs each overrun |
| `cache_control` | The harness manages prompt caching; markers have no effect |

Not implemented at all — these paths return 404: Batches (`/v1/messages/batches`),
the Files API. `POST /v1/messages/count_tokens` returns 501 with an explanation
rather than a guess.

## Agent mode executes arbitrary code

`POST /v1/runs` gives the model a shell with `bypassPermissions`. It will run
commands, install packages and write files. That is the feature, not a defect.

The service confines runs to a workspace directory and admits only an allowlist of
environment variables to the subprocess, so a run cannot read the host's secrets
or the token gating the API. Those are hardening measures inside a trust boundary
you still own:

- Run it in a container, not on a workstation with credentials lying around.
- Do not mount anything under the workspace that the caller should not reach.
- Restrict egress if the workload does not need open network access.
- Treat anyone with the service token as able to run code on that container.

## What this must not be used for

Anthropic's Usage Policy applies to every request this software makes, exactly as
if you had called the API directly. Routing a request through this service does
not change what is permitted. Prohibited uses under that policy remain prohibited
here.

Two things specific to this software:

- Do not use it to work around rate limits, quotas or account restrictions —
  by pooling accounts, rotating credentials, or otherwise.
- Do not present it as an Anthropic product or as an official API.

## Data

| Data | Where it goes |
|---|---|
| Prompts and responses | Anthropic, per your credential's terms |
| Session transcripts | `SESSION_DIR` on the instance |
| Files agent runs create | `WORKDIR` on the instance |
| Claude credentials | Held in memory for the request; never written to disk |
| Logs | Request line, status, redacted credential fingerprints |

Transcripts and workspace files persist until deleted. If you operate this for
others, they contain user content — retention and deletion are your
responsibility.

## No warranty

The software is provided as-is under the MIT licence, with no warranty of any
kind. It depends on the Claude Code CLI and the Agent SDK, whose behaviour can
change between releases in ways that break this service. Several behaviours it
relies on — deferred tool calls, session resume, harness overhead — were
established by testing against a specific version, not by contract.

## Authoritative sources

- Anthropic Usage Policy — <https://www.anthropic.com/legal/aup>
- Consumer Terms of Service — <https://www.anthropic.com/legal/consumer-terms>
- Commercial Terms of Service — <https://www.anthropic.com/legal/commercial-terms>
- Claude Code documentation — <https://code.claude.com/docs>

Where anything in this document conflicts with those, they govern.
