import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from './context.js';
import { childEnv } from './credentials.js';
import { buildPrompt, readPendingResults, type PendingResults } from './prompt.js';
import { verifySession } from '../types/session-ref.js';
import { addPrefix, buildBridge, deferHook } from './tools.js';
import { systemToText, type RunRequest } from '../types/wire.js';

/**
 * `tools: []` removes built-in tool schemas from the prompt; `disallowedTools`
 * only blocks execution and leaves them there. Measured on Sonnet 4.6 that is
 * ~2k vs ~17k prompt tokens per cold request.
 */
function buildOptions(
  req: RunRequest,
  ctx: TurnContext,
  resume: string | undefined,
  stream: boolean,
): Options {
  const { cfg, workspace, mode } = ctx;

  const opts: Options = {
    model: req.model ?? cfg.defaultModel,
    cwd: mode === 'run' ? workspace.resolve(req.cwd) : workspace.root,
    settingSources: [],
    includePartialMessages: stream,
    maxTurns: req.max_turns ?? (mode === 'run' ? 60 : 8),
  };

  const system = systemToText(req.system);
  if (system) opts.systemPrompt = system;
  if (resume) opts.resume = resume;

  // Injected per call rather than set on the service process, so a shared
  // instance cannot bleed one caller's credential into another's turn.
  // Always set, never inherited: the child must not see this process's own
  // secrets, and in agent mode it runs arbitrary commands that could read them.
  opts.env = childEnv(ctx.credential, cfg.sessionDir);

  if (mode === 'run') {
    opts.permissionMode = 'bypassPermissions';
    if (req.allowed_tools?.length) opts.allowedTools = req.allowed_tools;
  } else {
    // Provider emulation: strip the harness's own tools so the prompt carries
    // only what the caller declared.
    opts.tools = [];
    opts.thinking = { type: 'disabled' };
  }

  // Caller tools work in both modes. In agent mode they sit alongside the
  // harness toolset — the defer hook is scoped to the bridge prefix, so
  // built-ins still execute normally and only caller tools come back.
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    opts.mcpServers = { bridge: buildBridge(tools) };
    opts.hooks = deferHook;
    if (mode === 'messages') opts.allowedTools = tools.map((t) => addPrefix(t.name));
  }
  return opts;
}

export interface PreparedTurn {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Session being resumed, if any — used before the harness reports one. */
  seedSession: string;
}

/**
 * Resolve which session this turn continues.
 *
 * A reference can arrive three ways: inside a `tool_use.id` the caller echoed
 * back, in the `x-session-id` header, or as `session_id` in the body. All are
 * verified against the caller's credential, and one that does not verify is
 * treated as absent — a fresh session, never someone else's.
 */
function resolveSession(req: RunRequest, ctx: TurnContext, pending: PendingResults | null): string {
  const reference = pending?.sessionRef ?? ctx.sessionRef ?? req.session_id;
  if (!reference) return '';
  return verifySession(reference, ctx.credential?.token) ?? '';
}

export function prepareTurn(req: RunRequest, ctx: TurnContext, stream: boolean): PreparedTurn {
  // Both modes: a deferred tool is answered the same way regardless of whether
  // the harness also had tools of its own. Results whose ids are not ours fail
  // to unpack and fall through to the normal path.
  const pending = readPendingResults(req.messages);
  const resume = resolveSession(req, ctx, pending);

  return {
    options: buildOptions(req, ctx, resume || undefined, stream),
    prompt: buildPrompt(req.messages, pending, resume !== ''),
    seedSession: resume,
  };
}
