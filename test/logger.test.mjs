// test/logger.test.mjs
//
// Unit tests for src/logger.mjs. No fixtures on disk — we point the
// logger at a temp dir per test.

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeSystem, summarizeTools, logSystemPrompt, logTools } from '../src/logger.mjs';

describe('normalizeSystem', () => {
  it('returns "" for null / undefined', () => {
    assert.equal(normalizeSystem(null), '');
    assert.equal(normalizeSystem(undefined), '');
  });

  it('passes strings through unchanged', () => {
    assert.equal(normalizeSystem('hello'), 'hello');
  });

  it('joins text content blocks with newlines', () => {
    const result = normalizeSystem([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
    assert.equal(result, 'first\nsecond');
  });

  it('skips non-text content blocks with a placeholder', () => {
    const result = normalizeSystem([
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
      { type: 'text', text: 'after' },
    ]);
    assert.equal(result, 'before\n[image block omitted]\nafter');
  });

  it('serializes unknown object shapes', () => {
    const result = normalizeSystem({ type: 'custom', payload: 42 });
    assert.equal(result, '{\n  "type": "custom",\n  "payload": 42\n}');
  });
});

describe('summarizeTools', () => {
  it('returns [] for non-array input', () => {
    assert.deepEqual(summarizeTools(null), []);
    assert.deepEqual(summarizeTools('nope'), []);
    assert.deepEqual(summarizeTools({}), []);
  });

  it('extracts name and description', () => {
    const result = summarizeTools([
      { name: 'Read', description: 'Read a file' },
      { name: 'Write', description: '' },
    ]);
    assert.deepEqual(result, [
      { name: 'Read', description: 'Read a file' },
      { name: 'Write', description: '' },
    ]);
  });

  it('uses <unnamed> for entries without a name', () => {
    const result = summarizeTools([{ description: 'no name' }, null]);
    assert.equal(result[0].name, '<unnamed>');
    assert.equal(result[1].name, '<unnamed>');
  });
});

describe('logSystemPrompt + logTools', () => {
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompttrace-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean log files between tests so we can assert exact contents.
    await rm(join(dir, 'system_prompt.txt'), { force: true });
    await rm(join(dir, 'tools.jsonl'), { force: true });
  });

  it('writes system prompt to system_prompt.txt', async () => {
    await logSystemPrompt({
      requestId: 'req-1',
      timestamp: '2026-06-26T00:00:00.000Z',
      system: 'You are Claude.',
      logDir: dir,
    });
    const file = await readFile(join(dir, 'system_prompt.txt'), 'utf8');
    assert.match(file, /\[2026-06-26T00:00:00\.000Z\] request=req-1/);
    assert.match(file, /You are Claude\./);
  });

  it('writes one JSON line per request to tools.jsonl', async () => {
    await logTools({
      requestId: 'req-1',
      timestamp: '2026-06-26T00:00:00.000Z',
      tools: [{ name: 'Read', description: 'Read a file' }],
      logDir: dir,
    });
    await logTools({
      requestId: 'req-2',
      timestamp: '2026-06-26T00:00:01.000Z',
      tools: [
        { name: 'Write', description: 'Write a file' },
        { name: 'Bash', description: '' },
      ],
      logDir: dir,
    });
    const file = await readFile(join(dir, 'tools.jsonl'), 'utf8');
    const lines = file.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0].tools, [{ name: 'Read', description: 'Read a file' }]);
    assert.equal(lines[1].tools.length, 2);
    assert.equal(lines[1].tools[0].name, 'Write');
  });

  it('appends, never overwrites', async () => {
    await logSystemPrompt({
      requestId: 'r1',
      timestamp: '2026-06-26T00:00:00.000Z',
      system: 'first',
      logDir: dir,
    });
    await logSystemPrompt({
      requestId: 'r2',
      timestamp: '2026-06-26T00:00:01.000Z',
      system: 'second',
      logDir: dir,
    });
    const file = await readFile(join(dir, 'system_prompt.txt'), 'utf8');
    const occurrences = (file.match(/request=/g) ?? []).length;
    assert.equal(occurrences, 2);
    assert.match(file, /first/);
    assert.match(file, /second/);
  });

  it('no-op when system is missing', async () => {
    await logSystemPrompt({
      requestId: 'r1',
      timestamp: '2026-06-26T00:00:00.000Z',
      system: undefined,
      logDir: dir,
    });
    await assert.rejects(
      readFile(join(dir, 'system_prompt.txt'), 'utf8'),
      /ENOENT/,
    );
  });

  it('no-op when tools is empty', async () => {
    await logTools({
      requestId: 'r1',
      timestamp: '2026-06-26T00:00:00.000Z',
      tools: [],
      logDir: dir,
    });
    await assert.rejects(
      readFile(join(dir, 'tools.jsonl'), 'utf8'),
      /ENOENT/,
    );
  });
});