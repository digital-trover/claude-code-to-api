/**
 * Entry point. Loads config, starts the server, handles shutdown.
 *
 * Upstream Claude credentials arrive per request in `x-claude-token`; the
 * service stores none, so a compromised instance costs no accounts.
 */
import { loadConfig, startupWarnings } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './server.js';

const cfg = loadConfig();
const log = createLogger(cfg.logLevel);

for (const warning of startupWarnings(cfg)) log.error(warning);

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
 * An uncaught exception leaves the process in an unknown state, so the only
 * safe move is to drain and exit — but draining first means in-flight turns
 * are not silently lost, which matters when each one is spending real money.
 */
process.on('uncaughtException', (err) => {
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
