import type { Config } from '../config.js';
import type { Credential } from './credentials.js';
import type { Workspace } from './workspace.js';

export type Mode = 'messages' | 'run';

export interface TurnContext {
  /** 'messages' emulates a provider; 'run' lets the harness keep its own tools. */
  mode: Mode;
  cfg: Config;
  workspace: Workspace;
  /** Whose Claude account this runs on. Null falls back to the host's own login. */
  credential: Credential | null;
  /** Session to continue, from the `x-session-id` header. Verified before use. */
  sessionRef?: string;
  /**
   * Aborted when the client disconnects. Without this a hung-up request leaves
   * the harness running and billing the caller for output nobody receives.
   */
  signal?: AbortSignal;
}
