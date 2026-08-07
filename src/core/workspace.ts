import { statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Confines agent runs to a single directory tree.
 *
 * `/v1/runs` executes arbitrary commands, so without this a caller-supplied
 * `cwd` reaches the whole container filesystem.
 */
export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve a caller-supplied path inside the workspace.
   *
   * Absolute paths are rejected rather than reinterpreted: silently rewriting
   * `/etc` to `<root>/etc` keeps the caller contained but hands them a
   * different directory than they named. Traversal is caught on the resolved
   * path, since `resolve()` collapses `..` first.
   *
   * Checks the path, not the inode — a symlink inside the workspace pointing
   * out of it will pass, so mount nothing sensitive underneath.
   */
  resolve(requested?: string): string {
    if (!requested) return this.root;

    if (isAbsolute(requested) || /^[/\\]/.test(requested)) {
      throw new Error(`cwd: must be relative to the workspace (got ${requested})`);
    }

    const target = resolve(this.root, requested);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`cwd: resolves outside the workspace (${requested})`);
    }

    // The harness reports a missing cwd as a native-binary launch failure,
    // which sends the reader looking at libc versions instead of their path.
    let stats;
    try {
      stats = statSync(target);
    } catch {
      throw new Error(`cwd: no such directory in the workspace (${requested})`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`cwd: not a directory (${requested})`);
    }

    return target;
  }
}
