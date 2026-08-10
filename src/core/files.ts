/**
 * Reading the workspace.
 *
 * Two primitives: a manifest of paths, and one file's raw bytes. Contents are
 * never inlined or transcoded — a caller that needs base64 encodes what it
 * received, which is also the only way binary files survive intact.
 *
 * Read-only and pull-based, so nothing that writes elsewhere needs a credential
 * inside the workspace where untrusted agent code runs.
 */
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { Workspace } from './workspace.js';

/**
 * Dependency trees and build output. Filtered by default because a workspace
 * that has run `npm install` holds tens of thousands of files, which would
 * exhaust the walk limit before reaching anything the agent wrote. `includeAll`
 * turns this off rather than leaving files silently unreachable.
 */
const NOISE_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.next',
  '.turbo',
  'dist',
  'build',
  '.claude-sessions',
]);

const NOISE_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const NOISE_EXTENSIONS = ['.pyc', '.pyo', '.class', '.o', '.so'];

const isNoise = (name: string): boolean =>
  NOISE_DIRS.has(name) || NOISE_FILES.has(name) || NOISE_EXTENSIONS.some((e) => name.endsWith(e));

/** Bounds the walk so an unexpectedly large tree cannot stall a request. */
export const MAX_FILES = 2_000;

export interface WorkspaceFile {
  /** Workspace-relative and forward-slashed, so it is portable as-is. */
  path: string;
  size: number;
  /** Epoch millis, integral — `mtimeMs` is fractional and leaks noise into the API. */
  modified: number;
}

export interface FileListing {
  files: WorkspaceFile[];
  /** True when the walk hit the limit, so the manifest is incomplete. */
  truncated: boolean;
}

const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));

export interface ListOptions {
  includeAll?: boolean;
  limit?: number;
}

/**
 * Manifest of files under `prefix`.
 *
 * Sizes are collected during the walk rather than in a second pass: statting
 * afterwards would either serialise over every file or open thousands of
 * descriptors at once.
 */
export async function listFiles(
  workspace: Workspace,
  prefix?: string,
  options: ListOptions = {},
): Promise<FileListing> {
  const root = await workspace.resolve(prefix);
  const limit = options.limit ?? MAX_FILES;
  const includeAll = options.includeAll === true;

  const files: WorkspaceFile[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (truncated) return;
      if (!includeAll && isNoise(entry.name)) continue;

      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        const info = await stat(full);
        files.push({
          path: toPosix(relative(workspace.root, full)),
          size: info.size,
          modified: Math.floor(info.mtimeMs),
        });
      }
      // Symlinks are skipped: following one could surface a file from outside
      // the workspace, which is the boundary this surface rests on.
    }
  }

  await walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { files, truncated };
}

export interface ReadableFile {
  absolutePath: string;
  size: number;
}

/** Locate one file, once it is known to exist inside the workspace. */
export async function resolveReadable(
  workspace: Workspace,
  path: string,
): Promise<ReadableFile> {
  const absolutePath = workspace.resolveFile(path);

  const info = await stat(absolutePath).catch(() => {
    throw new Error(`path: no such file in the workspace (${path})`);
  });
  if (!info.isFile()) throw new Error(`path: not a file (${path})`);

  return { absolutePath, size: info.size };
}
