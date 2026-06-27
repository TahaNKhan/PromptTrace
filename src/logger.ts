// src/logger.ts
//
// Append-only log writers for system prompts and tool definitions.
//
// Design notes:
//   * Files are opened/closed per write — fine because request volume
//     from a single CLI is low (single-digit per minute at worst).
//   * Errors are swallowed and reported to stderr; logging must never
//     break the proxy.
//   * `normalizeSystem` handles both string and array-of-content-blocks
//     shapes, because Anthropic allows either.

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SYSTEM_LOG = 'system_prompt.txt';
const TOOLS_LOG = 'tools.jsonl';

export interface ToolSummary {
  readonly name: string;
  readonly description: string;
}

export interface SystemPromptPayload {
  readonly requestId: string;
  readonly timestamp: string;
  readonly system: unknown;
  readonly logDir?: string;
}

export interface ToolsPayload {
  readonly requestId: string;
  readonly timestamp: string;
  readonly tools: unknown;
  readonly logDir?: string;
}

/** A single content block as Anthropic may deliver it. */
interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly [key: string]: unknown;
}

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The Anthropic `system` field may be either a string or an array of
 * content blocks (text / image). Reduce both to a printable string.
 */
export function normalizeSystem(system: unknown): string {
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;

  if (Array.isArray(system)) {
    return system
      .map((block): string => {
        if (typeof block === 'string') return block;
        if (isContentBlock(block)) {
          // Content blocks look like { type: 'text', text: '...' } or
          // { type: 'image', source: {...} }. We only print text blocks.
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          const typeName = typeof block.type === 'string' ? block.type : 'unknown';
          return `[${typeName} block omitted]`;
        }
        return '';
      })
      .join('\n');
  }

  if (isContentBlock(system)) {
    // Single object shape (rare) — serialize for the human reader.
    return JSON.stringify(system, null, 2);
  }

  return String(system);
}

/**
 * Extract `{ name, description }` for each tool definition. Defensive:
 * malformed entries produce an empty string rather than throwing.
 */
export function summarizeTools(tools: unknown): ToolSummary[] {
  if (!Array.isArray(tools)) return [];
  const out: ToolSummary[] = [];
  for (const t of tools) {
    if (!isContentBlock(t)) {
      out.push({ name: '<unnamed>', description: '' });
      continue;
    }
    const name = typeof t.name === 'string' ? t.name : '<unnamed>';
    const description = typeof t.description === 'string' ? t.description : '';
    out.push({ name, description });
  }
  return out;
}

function separator(timestamp: string, requestId: string): string {
  return `\n${'='.repeat(72)}\n[${timestamp}] request=${requestId}\n${'='.repeat(72)}\n`;
}

/**
 * Append the system prompt (if any) to system_prompt.txt and print a
 * short header + the prompt to stdout.
 */
export async function logSystemPrompt(payload: SystemPromptPayload): Promise<void> {
  const text = normalizeSystem(payload.system);
  if (text.length === 0) return;

  const dir = payload.logDir ?? process.cwd();
  const filePath = resolve(dir, SYSTEM_LOG);

  const block =
    separator(payload.timestamp, payload.requestId) + text + '\n';

  process.stdout.write(
    `[prompttrace] system prompt (${text.length} chars) — request ${payload.requestId}\n`,
  );

  try {
    await appendFile(filePath, block, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[prompttrace] failed to write system_prompt.txt: ${(err as Error).message}\n`,
    );
  }
}

/**
 * Append one JSON object per request to tools.jsonl. Each entry has
 * `timestamp`, `requestId`, and `tools: [{ name, description }]`.
 */
export async function logTools(payload: ToolsPayload): Promise<void> {
  const summarized = summarizeTools(payload.tools);
  if (summarized.length === 0) return;

  const dir = payload.logDir ?? process.cwd();
  const filePath = resolve(dir, TOOLS_LOG);

  const entry = JSON.stringify({
    timestamp: payload.timestamp,
    requestId: payload.requestId,
    tools: summarized,
  });

  const names = summarized.map((t) => t.name).join(', ');
  process.stdout.write(
    `[prompttrace] tools (${summarized.length}) — request ${payload.requestId}: ${names}\n`,
  );

  try {
    await appendFile(filePath, entry + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `[prompttrace] failed to write tools.jsonl: ${(err as Error).message}\n`,
    );
  }
}