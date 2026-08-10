import { statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Confines agent runs and file reads to a single directory tree.
 *
 * `/v1/runs` executes arbitrary commands and the workspace routes hand files
 * back out, so without this a caller-supplied path reaches the whole container
 * filesystem — including the credential in the process environment.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Map a caller-supplied path into the workspace, or reject it.
   *
   * Absolute paths are rejected rather than reinterpreted: silently rewriting
   * `/etc` to `<root>/etc` keeps the caller contained but hands them a
   * different path than they named. Traversal is caught on the *resolved*
   * path, since `resolve()` collapses `..` before we could match on it.
   *
   * This checks the path, not the inode — a symlink inside the workspace
   * pointing out of it would pass, so mount nothing sensitive underneath and
   * do not follow symlinks when walking.
   */
  private contain(requested: string, field: string): string {
    if (isAbsolute(requested) || /^[/\\]/.test(requested)) {
      throw new Error(`${field}: must be relative to the workspace (got ${requested})`);
    }

    const target = resolve(this.root, requested);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`${field}: resolves outside the workspace (${requested})`);
    }
    return target;
  }

  /** Resolve a directory that must already exist. Used for a run's `cwd`. */
  resolve(requested?: string): string {
    if (!requested) return this.root;
    const target = this.contain(requested, 'cwd');

    // The harness reports a missing cwd as a native-binary launch failure,
    // which sends the reader looking at libc versions instead of their path.
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new Error(`cwd: no such directory in the workspace (${requested})`);
    }
    if (!stats.isDirectory()) throw new Error(`cwd: not a directory (${requested})`);

    return target;
  }

  /** Resolve a file path. Existence is the caller's to check and report. */
  resolveFile(requested: string): string {
    return this.contain(requested, 'path');
  }
}
