// test/config.test.mjs
//
// Unit tests for src/config.mjs.
//
// All tests pass an explicit `filePath` so the test is deterministic
// regardless of whether config.json happens to exist in the cwd.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, HOP_BY_HOP_HEADERS } from '../src/config.mjs';

// Path guaranteed not to exist on any platform. Used by tests that
// want to exercise the "no config.json" path.
const NO_FILE = '__prompttrace_test_no_such_file__.json';

describe('loadConfig — env vars and defaults', () => {
  it('returns built-in defaults when env is empty and no file exists', () => {
    const cfg = loadConfig({}, NO_FILE);
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.host, '127.0.0.1');
    // Built-in default is the official Anthropic endpoint.
    assert.equal(cfg.upstreamUrl, 'https://api.anthropic.com');
    assert.equal(cfg.insecureTls, false);
    assert.equal(cfg.sources.upstreamUrl, 'default');
    assert.equal(cfg.sources.port, 'default');
    assert.equal(cfg.sources.host, 'default');
    assert.equal(cfg.sources.logDir, 'default');
  });

  it('parses a custom PORT', () => {
    const cfg = loadConfig({ PORT: '9999' }, NO_FILE);
    assert.equal(cfg.port, 9999);
    assert.equal(cfg.sources.port, 'env');
  });

  it('rejects an out-of-range PORT', () => {
    assert.throws(() => loadConfig({ PORT: '0' }, NO_FILE), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }, NO_FILE), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: 'abc' }, NO_FILE), /Invalid PORT/);
  });

  it('parses a custom HOST', () => {
    const cfg = loadConfig({ HOST: '0.0.0.0' }, NO_FILE);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.sources.host, 'env');
  });

  it('parses a custom upstream URL and preserves its path prefix', () => {
    const cfg = loadConfig(
      { UPSTREAM_URL: 'https://staging.example.com/foo' },
      NO_FILE,
    );
    assert.equal(cfg.upstreamUrl, 'https://staging.example.com/foo');
    assert.equal(cfg.sources.upstreamUrl, 'env');
  });

  it('strips a trailing slash on the upstream URL', () => {
    const cfg = loadConfig(
      { UPSTREAM_URL: 'https://api.minimax.io/anthropic/' },
      NO_FILE,
    );
    assert.equal(cfg.upstreamUrl, 'https://api.minimax.io/anthropic');
  });

  it('rejects an invalid upstream URL', () => {
    assert.throws(
      () => loadConfig({ UPSTREAM_URL: 'ftp://x' }, NO_FILE),
      /Invalid UPSTREAM_URL/,
    );
    assert.throws(
      () => loadConfig({ UPSTREAM_URL: 'not a url' }, NO_FILE),
      /Invalid UPSTREAM_URL/,
    );
  });

  it('parses INSECURE_TLS=1', () => {
    const cfg = loadConfig({ INSECURE_TLS: '1' }, NO_FILE);
    assert.equal(cfg.insecureTls, true);
    assert.equal(cfg.sources.insecureTls, 'env');
  });

  it('returns a frozen object', () => {
    const cfg = loadConfig({}, NO_FILE);
    assert.throws(() => {
      cfg.port = 1234;
    }, /Cannot assign to read only property/);
  });
});

describe('loadConfig — config.json file', () => {
  /** @type {string} */
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'prompttrace-cfg-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads upstreamUrl from config.json', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, JSON.stringify({ upstreamUrl: 'https://other.example.com/v1' }), 'utf8');
    const cfg = loadConfig({}, file);
    assert.equal(cfg.upstreamUrl, 'https://other.example.com/v1');
    assert.equal(cfg.sources.upstreamUrl, 'file');
  });

  it('reads all supported fields from config.json', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(
      file,
      JSON.stringify({
        upstreamUrl: 'https://api.example.com/x',
        port: 9090,
        host: '0.0.0.0',
        insecureTls: true,
        logDir: dir,
      }),
      'utf8',
    );
    const cfg = loadConfig({}, file);
    assert.equal(cfg.upstreamUrl, 'https://api.example.com/x');
    assert.equal(cfg.port, 9090);
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.insecureTls, true);
    assert.equal(cfg.logDir, dir);
    assert.equal(cfg.sources.upstreamUrl, 'file');
    assert.equal(cfg.sources.port, 'file');
  });

  it('env vars override config.json values', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(
      file,
      JSON.stringify({ port: 9090, upstreamUrl: 'https://from-file.com/' }),
      'utf8',
    );
    const cfg = loadConfig(
      { PORT: '7000', UPSTREAM_URL: 'https://from-env.com/' },
      file,
    );
    assert.equal(cfg.port, 7000);
    assert.equal(cfg.sources.port, 'env');
    assert.equal(cfg.upstreamUrl, 'https://from-env.com');
    assert.equal(cfg.sources.upstreamUrl, 'env');
  });

  it('falls back to defaults for missing keys in config.json', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, JSON.stringify({ port: 9090 }), 'utf8');
    const cfg = loadConfig({}, file);
    assert.equal(cfg.port, 9090);
    assert.equal(cfg.sources.port, 'file');
    assert.equal(cfg.upstreamUrl, 'https://api.anthropic.com');
    assert.equal(cfg.sources.upstreamUrl, 'default');
  });

  it('throws on invalid JSON', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '{not valid', 'utf8');
    assert.throws(() => loadConfig({}, file), /Invalid JSON/);
  });

  it('throws when the file is not a JSON object', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, '"a string"', 'utf8');
    assert.throws(() => loadConfig({}, file), /must contain a JSON object/);
  });

  it('throws on out-of-range port in config.json', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, JSON.stringify({ port: 999999 }), 'utf8');
    assert.throws(() => loadConfig({}, file), /port must be an integer/);
  });

  it('throws on invalid upstreamUrl in config.json', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(file, JSON.stringify({ upstreamUrl: 'ftp://x' }), 'utf8');
    assert.throws(() => loadConfig({}, file), /upstreamUrl must be/);
  });

  it('ignores unknown keys (forward-compat)', async () => {
    const file = join(dir, 'cfg.json');
    await writeFile(
      file,
      JSON.stringify({ upstreamUrl: 'https://api.example.com', futureKey: 'foo' }),
      'utf8',
    );
    // Should not throw — unknown keys are warned, not rejected.
    const cfg = loadConfig({}, file);
    assert.equal(cfg.upstreamUrl, 'https://api.example.com');
  });

  it('PROMPTTRACE_CONFIG env var picks the file path', async () => {
    const file = join(dir, 'alt.json');
    await writeFile(file, JSON.stringify({ port: 7070 }), 'utf8');
    // Pass no filePath — env var is the only signal to where the
    // file lives. (Explicit `filePath` arg always wins over the env.)
    const cfg = loadConfig({ PROMPTTRACE_CONFIG: file });
    assert.equal(cfg.port, 7070);
    assert.equal(cfg.configPath, file);
  });
});

describe('HOP_BY_HOP_HEADERS', () => {
  it('includes connection and host', () => {
    assert.ok(HOP_BY_HOP_HEADERS.has('connection'));
    assert.ok(HOP_BY_HOP_HEADERS.has('host'));
    assert.ok(HOP_BY_HOP_HEADERS.has('content-length'));
  });
});