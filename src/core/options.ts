import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from './context.js';
import { childEnv } from './credentials.js';
import { buildPrompt, readPendingResults } from './prompt.js';
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
  const env = childEnv(ctx.credential, cfg.sessionDir);
  if (env) opts.env = env;

  if (mode === 'run') {
    opts.permissionMode = 'bypassPermissions';
    if (req.allowed_tools?.length) opts.allowedTools = req.allowed_tools;
    return opts;
  }

  opts.tools = [];
  opts.thinking = { type: 'disabled' };

  const tools = req.tools ?? [];
  if (tools.length > 0) {
    opts.mcpServers = { bridge: buildBridge(tools) };
    opts.allowedTools = tools.map((t) => addPrefix(t.name));
    opts.hooks = deferHook;
  }
  return opts;
}

export interface PreparedTurn {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Session we are resuming, if any — used before the harness reports one. */
  seedSession: string;
}

export function prepareTurn(req: RunRequest, ctx: TurnContext, stream: boolean): PreparedTurn {
  const pending = ctx.mode === 'messages' ? readPendingResults(req.messages) : null;
  const resume = pending?.sessionId ?? (ctx.mode === 'run' ? req.session_id : undefined);

  return {
    options: buildOptions(req, ctx, resume, stream),
    prompt: buildPrompt(req.messages, pending),
    seedSession: resume ?? '',
  };
}
