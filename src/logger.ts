import type { LogLevel } from './config.js';

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, error: 2 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/** Writes to stderr so SSE bodies on stdout stay clean. */
export function createLogger(level: LogLevel): Logger {
  const emit = (at: LogLevel, msg: string, extra?: unknown): void => {
    if (RANK[at] < RANK[level]) return;
    const line = `[${new Date().toISOString()}] ${at} ${msg}`;
    if (extra !== undefined) console.error(line, extra);
    else console.error(line);
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    error: (m, e) => emit('error', m, e),
  };
}
