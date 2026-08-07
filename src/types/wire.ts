/** Anthropic Messages API shapes — only the fields this service reads or emits. */

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  source?: unknown;
  [k: string]: unknown;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  [k: string]: unknown;
}

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: JsonSchema;
}

export interface MessagesRequest {
  model?: string;
  system?: string | ContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicToolDef[];
  stream?: boolean;
  max_tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface RunRequest extends MessagesRequest {
  /** Relative to the workspace root. */
  cwd?: string;
  session_id?: string;
  allowed_tools?: string[];
  max_turns?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export const asBlocks = (content: string | ContentBlock[]): ContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);

export function systemToText(system: MessagesRequest['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system.trim() || undefined;
  return (
    system
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n\n')
      .trim() || undefined
  );
}

export const messageId = (): string =>
  `msg_${Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`;
