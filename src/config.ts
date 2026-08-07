import { resolve } from 'node:path';

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export type LogLevel = 'debug' | 'info' | 'error';

export interface Config {
  host: string;
  port: number;
  /** Gates access to this service. Empty disables auth — only safe on loopback. */
  authToken: string;
  defaultModel: string;
  workdir: string;
  /**
   * Where the harness keeps session transcripts. Service-owned and free of any
   * stored login, which is what forces a caller-supplied token to be used.
   */
  sessionDir: string;
  /** Headless has no timeout of its own. */
  turnTimeoutMs: number;
  /**
   * Let requests without `x-claude-token` fall back to the host's own `claude`
   * login. Local development only; a container has no such login, so production
   * fails closed regardless.
   */
  allowAmbientCredential: boolean;
  /** Concurrent harness turns. Each is a subprocess, so this bounds memory. */
  maxConcurrentTurns: number;
  /** Requests parked waiting for a slot before the service sheds load. */
  maxQueuedTurns: number;
  queueTimeoutMs: number;
  /** Per-caller request budget. 0 disables. */
  rateLimitPerMinute: number;
  rateLimitBurst: number;
  /** Grace period for in-flight turns during shutdown. */
  shutdownGraceMs: number;
  logLevel: LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const level = env.LOG_LEVEL;
  return {
    host: env.HOST ?? '127.0.0.1',
    port: num(env.PORT, 8787),
    authToken: env.SERVICE_AUTH_TOKEN ?? '',
    defaultModel: env.DEFAULT_MODEL ?? 'claude-sonnet-4-6',
    workdir: env.WORKDIR ?? process.cwd(),
    sessionDir: env.SESSION_DIR ?? resolve(env.WORKDIR ?? process.cwd(), '.claude-sessions'),
    turnTimeoutMs: num(env.TURN_TIMEOUT_MS, 10 * 60_000),
    allowAmbientCredential: env.ALLOW_AMBIENT_CREDENTIAL === '1',
    maxConcurrentTurns: num(env.MAX_CONCURRENT_TURNS, 4),
    maxQueuedTurns: num(env.MAX_QUEUED_TURNS, 16),
    queueTimeoutMs: num(env.QUEUE_TIMEOUT_MS, 30_000),
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 60) || 0,
    rateLimitBurst: num(env.RATE_LIMIT_BURST, 20),
    shutdownGraceMs: num(env.SHUTDOWN_GRACE_MS, 30_000),
    logLevel: level === 'debug' || level === 'error' ? level : 'info',
  };
}

const CREDENTIAL_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

export function startupWarnings(cfg: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];

  // A credential in the environment is what this service exists to avoid: it
  // would be used for callers who supplied no token of their own.
  for (const name of CREDENTIAL_VARS) {
    if (env[name]) {
      warnings.push(
        `${name} is set in this process. Credentials belong in the per-request x-claude-token ` +
          'header; remove it so no caller can run on an account that is not theirs.',
      );
    }
  }

  if (cfg.allowAmbientCredential) {
    warnings.push(
      "ALLOW_AMBIENT_CREDENTIAL=1 — requests without x-claude-token run on this host's own " +
        '`claude` login. Local development only.',
    );
  }

  if (!cfg.authToken && cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    warnings.push(
      'SERVICE_AUTH_TOKEN is unset while bound to a non-loopback address — the service is open.',
    );
  }

  return warnings;
}
