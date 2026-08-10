/**
 * Routing, admission control, and per-request wiring.
 *
 * Routes are matched from a table rather than an if-chain so `anonymous`,
 * `needsCredential` and `metered` are declared per route instead of being
 * re-checked by hand in every handler.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { ApiError, notFound, toApiError, unauthorized } from './http/errors.js';
import { sendError, sendJson } from './http/respond.js';
import { readJson } from './http/body.js';
import { authorized, presentedToken } from './http/auth.js';
import { ConcurrencyLimiter, RateLimiter } from './http/limits.js';
import { resolveCredential, type Credential } from './core/credentials.js';
import { Workspace } from './core/workspace.js';
import { createMessage } from './routes/messages.route.js';
import { createRun } from './routes/runs.route.js';
import { status, verify } from './routes/credentials.route.js';
import { countTokens, health, listModels, openapi, ready } from './routes/meta.route.js';
import { listWorkspace, readWorkspace } from './routes/workspace.route.js';

export interface RequestContext {
  cfg: Config;
  log: Logger;
  workspace: Workspace;
  /** Parsed body; `{}` for GETs. */
  body: unknown;
  /** The caller's Claude credential, or null in ambient mode. */
  credential: Credential | null;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  /** True once shutdown has begun and the instance is finishing in-flight work. */
  draining: boolean;
  /** Parsed query string. */
  query: URLSearchParams;
  /** Session to continue, from `x-session-id`. Verified against the credential. */
  sessionRef?: string;
  sendJson: typeof sendJson;
}

type Handler = (ctx: RequestContext, res: ServerResponse) => void | Promise<void>;

interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: Handler;
  /** Public routes skip the service token. */
  anonymous?: boolean;
  /** Routes that reach the harness need an upstream Claude credential. */
  needsCredential?: boolean;
  /** Routes that spawn a harness subprocess, and so consume a concurrency slot. */
  metered?: boolean;
}

const ROUTES: Route[] = [
  { method: 'GET', path: '/health', handler: health, anonymous: true },
  { method: 'GET', path: '/ready', handler: ready, anonymous: true },
  { method: 'GET', path: '/openapi.json', handler: openapi, anonymous: true },
  { method: 'GET', path: '/v1/models', handler: listModels },
  { method: 'POST', path: '/v1/credentials/verify', handler: verify },
  { method: 'POST', path: '/v1/credentials/status', handler: status, needsCredential: true },
  { method: 'POST', path: '/v1/messages/count_tokens', handler: countTokens },
  { method: 'POST', path: '/v1/messages', handler: createMessage, needsCredential: true, metered: true },
  { method: 'POST', path: '/v1/runs', handler: createRun, needsCredential: true, metered: true },
  { method: 'GET', path: '/v1/workspace/files', handler: listWorkspace },
  { method: 'GET', path: '/v1/workspace/raw', handler: readWorkspace },
];

const CREDENTIAL_REQUIRED =
  "x-claude-token is required: this service runs on the caller's Claude account and holds none of its own";

function match(method: string, path: string): Route {
  const route = ROUTES.find((r) => r.method === method && r.path === path);
  if (route) return route;

  // Distinguish "wrong verb" from "no such path" — a client bug versus a typo.
  if (ROUTES.some((r) => r.path === path)) throw notFound(`no route for ${method} ${path}`);
  throw notFound(`unknown path ${path}`);
}

export interface App {
  server: Server;
  /** Stops accepting work and waits for in-flight turns, up to the grace period. */
  shutdown: () => Promise<void>;
}

export function createApp(cfg: Config, log: Logger): App {
  const workspace = new Workspace(cfg.workdir);

  // Must exist and hold no stored login: it is what stops an invalid
  // caller-supplied token from silently falling back to the host's account.
  mkdirSync(cfg.sessionDir, { recursive: true });
  const turns = new ConcurrencyLimiter(cfg.maxConcurrentTurns, cfg.maxQueuedTurns, cfg.queueTimeoutMs);
  const rate = new RateLimiter(cfg.rateLimitPerMinute, cfg.rateLimitBurst);

  const sweeper = setInterval(() => rate.sweep(), 60_000);
  sweeper.unref();

  let draining = false;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const route = match(req.method ?? 'GET', path);

    // During shutdown, keep answering health checks so the orchestrator can see
    // the instance leave rotation, but take on no new work.
    if (draining && !route.anonymous) {
      throw new ApiError(503, 'overloaded_error', 'server is shutting down');
    }

    if (!route.anonymous && !authorized(req, cfg.authToken)) {
      throw unauthorized('invalid or missing service credentials');
    }

    const header = req.headers['x-claude-token'];
    const credential = resolveCredential(typeof header === 'string' ? header : undefined);
    if (route.needsCredential && !credential && !cfg.allowAmbientCredential) {
      throw unauthorized(CREDENTIAL_REQUIRED);
    }

    const body = route.method === 'POST' ? await readJson(req) : {};

    // Abort the turn when the client hangs up, so the harness stops spending
    // the caller's tokens on a response nobody will read.
    const disconnect = new AbortController();
    res.on('close', () => disconnect.abort());

    const ctx: RequestContext = {
      cfg,
      log,
      workspace,
      body,
      credential,
      signal: disconnect.signal,
      draining,
      query: url.searchParams,
      sessionRef: typeof req.headers['x-session-id'] === 'string' ? req.headers['x-session-id'] : undefined,
      sendJson,
    };

    if (!route.metered) return route.handler(ctx, res);

    // Rate limit before queueing: a caller over budget should be told so
    // immediately rather than occupying a queue slot to find out.
    rate.take(RateLimiter.keyFor(credential?.token, presentedToken(req) ?? 'anonymous'));

    const release = await turns.acquire();
    try {
      await route.handler(ctx, res);
    } finally {
      release();
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      // A client that hung up mid-turn is not a server fault.
      if (res.destroyed || (err as Error)?.name === 'AbortError') {
        log.debug(`${req.method} ${req.url} aborted by client`);
        if (!res.destroyed) res.end();
        return;
      }

      const api = err instanceof ApiError ? err : toApiError(err);
      log[api.status >= 500 && api.status !== 501 ? 'error' : 'debug'](
        `${req.method} ${req.url} -> ${api.status}`,
        api.message,
      );
      if (!res.headersSent) sendError(res, api);
      else res.end();
    });
  });

  // Malformed requests reach the socket, not the request handler.
  server.on('clientError', (err: Error, socket: Socket) => {
    log.debug(`client error: ${err.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  // Turns routinely sit on a model request for minutes; the 5m default would
  // cut them off mid-flight.
  server.requestTimeout = cfg.turnTimeoutMs + 30_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;

  async function shutdown(): Promise<void> {
    draining = true;
    clearInterval(sweeper);
    server.close();

    const deadline = Date.now() + cfg.shutdownGraceMs;
    while (turns.inFlight > 0 && Date.now() < deadline) {
      log.info(`waiting for ${turns.inFlight} in-flight turn(s)`);
      await new Promise((r) => setTimeout(r, 500));
    }
    if (turns.inFlight > 0) {
      log.error(`grace period expired with ${turns.inFlight} turn(s) still running`);
    }
  }

  return { server, shutdown };
}
