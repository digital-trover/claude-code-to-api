/**
 * Entry point. Loads config, starts the server, handles shutdown.
 *
 * Upstream Claude credentials arrive per request in `x-claude-token`; the
 * service stores none, so a compromised instance costs no accounts.
 */
import { mkdir } from 'node:fs/promises';
import { loadConfig, startupWarnings } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);

for (const warning of startupWarnings(cfg)) log.error(warning);

/**
 * Both directories must exist before the first turn.
 *
 * The workspace is the spawned harness's working directory: a missing one makes
 * every turn fail at `spawn` with ENOENT, which the SDK reports as the native
 * binary failing to launch — sending you to look at libc and code signing when
 * the directory simply is not there. The session directory must exist and hold
 * no stored login, since that is what stops an invalid caller-supplied token
 * from silently falling back to this host's own account.
 *
 * Created here rather than in `createApp` so a permission failure stops the
 * process instead of surfacing once per request.
 */
for (const dir of [cfg.workdir, cfg.sessionDir]) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    log.error(`cannot create ${dir}: ${String(e)}`);
    process.exit(1);
  }
}

const { server, shutdown } = createApp(cfg, log);

/**
 * A rejected promise outside a request — a detached generator, a stray timer —
 * would otherwise terminate the process on modern Node and drop every in-flight
 * turn. Log it and keep serving; the per-request handler covers anything that
 * belongs to a caller.
 */
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', reason instanceof Error ? reason.stack : reason);
});

let closing = false;

async function stop(reason: string, code: number): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`${reason} — draining (grace ${cfg.shutdownGraceMs}ms)`);
  try {
    await shutdown();
  } catch (err) {
    log.error('shutdown failed', err);
  }
  process.exit(code);
}

/**
 * Errors that belong to one connection or one child process, not to the
 * service. A turn spawns a `claude` subprocess and streams to a client that may
 * hang up at any moment, so these arrive routinely and asynchronously — often
 * from a stream with no listener attached, which lands here rather than in the
 * request handler. Killing the process over one of them would drop every other
 * in-flight turn.
 */
const TRANSIENT_ERRORS = new Set([
  'EPIPE',
  'ECONNRESET',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'ABORT_ERR',
]);

const isTransient = (err: Error): boolean =>
  TRANSIENT_ERRORS.has((err as NodeJS.ErrnoException).code ?? '') || err.name === 'AbortError';

/**
 * Anything else leaves the process in an unknown state, so the only safe move
 * is to drain and exit — draining first so in-flight turns are not silently
 * lost, which matters when each one is spending someone's money.
 */
process.on('uncaughtException', (err) => {
  if (isTransient(err)) {
    log.error(`transient error, continuing: ${err.message}`);
    return;
  }
  log.error('uncaught exception', err.stack ?? err.message);
  void stop('fatal error', 1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stop(`${signal} received`, 0));
}

server.listen(cfg.port, cfg.host, () => {
  log.info(
    `listening on http://${cfg.host}:${cfg.port} ` +
      `(model=${cfg.defaultModel}, concurrency=${cfg.maxConcurrentTurns}, ` +
      `rate=${cfg.rateLimitPerMinute || 'off'}/min)`,
  );
});
