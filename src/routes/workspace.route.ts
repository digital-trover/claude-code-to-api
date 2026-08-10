import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../server.js';
import { listFiles, resolveReadable } from '../core/files.js';
import { badRequest } from '../http/errors.js';

/**
 * `GET /v1/workspace/files?prefix=&all=1`
 *
 * Manifest of the workspace. Dependency trees and build output are filtered
 * unless `all` is set.
 */
export async function listWorkspace(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const prefix = ctx.query.get('prefix') ?? undefined;
  const includeAll = ctx.query.get('all') === '1';

  ctx.sendJson(res, 200, await listFiles(ctx.workspace, prefix, { includeAll }));
}

/**
 * `GET /v1/workspace/raw?path=agent/graph.py`
 *
 * One file, streamed as raw bytes. Untranscoded on purpose: a caller that needs
 * base64 encodes what it receives, and binary survives intact.
 */
export async function readWorkspace(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const path = ctx.query.get('path');
  if (!path) throw badRequest('path: required query parameter');

  const file = await resolveReadable(ctx.workspace, path);

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    // Lets a client show progress and detect a truncated transfer.
    'content-length': String(file.size),
    'cache-control': 'no-store',
  });

  await pipeline(createReadStream(file.absolutePath), res);
}
