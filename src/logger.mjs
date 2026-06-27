// src/logger.mjs
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

/**
 * The Anthropic `system` field may be either a string or an array of
 * content blocks (text / image). Reduce both to a printable string.
 *
 * @param {unknown} system
 * @returns {string}
 */
export function normalizeSystem(system) {
  if (system === undefined || system === null) return '';
  if (typeof system === 'string') return system;

  if (Array.isArray(system)) {
    return system
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block === 'object') {
          // Content blocks look like { type: 'text', text: '...' } or
          // { type: 'image', source: {...} }. We only print text blocks.
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          return `[${block.type ?? 'unknown'} block omitted]`;
        }
        return '';
      })
      .join('\n');
  }

  if (typeof system === 'object') {
    // Single object shape (rare) — serialize for the human reader.
    return JSON.stringify(system, null, 2);
  }

  return String(system);
}

/**
 * Extract `{ name, description }` for each tool definition. Defensive:
 * malformed entries produce an empty string rather than throwing.
 *
 * @param {unknown} tools
 * @returns {Array<{ name: string, description: string }>}
 */
export function summarizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => {
    const name = t && typeof t === 'object' && typeof t.name === 'string'
      ? t.name
      : '<unnamed>';
    const description = t && typeof t === 'object' && typeof t.description === 'string'
      ? t.description
      : '';
    return { name, description };
  });
}

function separator(timestamp, requestId) {
  return `\n${'='.repeat(72)}\n[${timestamp}] request=${requestId}\n${'='.repeat(72)}\n`;
}

/**
 * Append the system prompt (if any) to system_prompt.txt and print a
 * short header + the prompt to stdout.
 *
 * @param {{ requestId: string, timestamp: string, system: unknown, logDir?: string }} payload
 */
export async function logSystemPrompt(payload) {
  const text = normalizeSystem(payload.system);
  if (text.length === 0) return; // nothing to log

  const dir = payload.logDir ?? process.cwd();
  const filePath = resolve(dir, SYSTEM_LOG);

  const block =
    separator(payload.timestamp, payload.requestId) + text + '\n';

  // Best-effort console output.
  process.stdout.write(`[prompttrace] system prompt (${text.length} chars) — request ${payload.requestId}\n`);

  try {
    await appendFile(filePath, block, 'utf8');
  } catch (err) {
    process.stderr.write(
      `[prompttrace] failed to write system_prompt.txt: ${err.message}\n`,
    );
  }
}

/**
 * Append one JSON object per request to tools.jsonl. Each entry has
 * `timestamp`, `requestId`, and `tools: [{ name, description }]`.
 *
 * @param {{ requestId: string, timestamp: string, tools: unknown, logDir?: string }} payload
 */
export async function logTools(payload) {
  const summarized = summarizeTools(payload.tools);
  if (summarized.length === 0) return;

  const dir = payload.logDir ?? process.cwd();
  const filePath = resolve(dir, TOOLS_LOG);

  const entry = JSON.stringify({
    timestamp: payload.timestamp,
    requestId: payload.requestId,
    tools: summarized,
  });

  process.stdout.write(
    `[prompttrace] tools (${summarized.length}) — request ${payload.requestId}: ` +
      summarized.map((t) => t.name).join(', ') +
      '\n',
  );

  try {
    await appendFile(filePath, entry + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `[prompttrace] failed to write tools.jsonl: ${err.message}\n`,
    );
  }
}