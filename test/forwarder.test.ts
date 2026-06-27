// test/forwarder.test.ts
//
// Integration tests for the full request path. We stand up:
//   * a real upstream HTTP server on an ephemeral port (mock Anthropic)
//   * the proxy's Express app, configured to forward to it
// then make HTTP requests against the proxy and assert behavior.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, listen } from '../src/server.js';

interface MockHandlerArgs {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  recordChunk: (chunk: string) => void;
}

type MockHandler = (args: MockHandlerArgs) => Promise<void> | void;

interface MockUpstream {
  port: number;
  server: http.Server;
  chunks: string[];
  timings: number[];
}

function startMockUpstream(handler: MockHandler): Promise<MockUpstream> {
  return new Promise((resolveP) => {
    const chunks: string[] = [];
    const timings: number[] = [];
    const server = http.createServer((req, res) => {
      const buffers: Buffer[] = [];
      req.on('data', (c: Buffer) => buffers.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(buffers);
        void handler({
          req,
          res,
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers,
          rawBody,
          recordChunk: (chunk: string) => {
            chunks.push(chunk);
            timings.push(Date.now());
          },
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolveP({ port: (addr as AddressInfo).port, server, chunks, timings });
    });
  });
}

interface GetResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  chunks: Buffer[];
  timings: number[];
}

function get(url: string): Promise<GetResponse> {
  return new Promise((resolveP, rejectP) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        const timings: number[] = [];
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          timings.push(Date.now());
        });
        res.on('end', () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            chunks,
            timings,
          });
        });
        res.on('error', rejectP);
      })
      .on('error', rejectP);
  });
}

interface PostResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  chunks: Buffer[];
  timings: number[];
}

function post(
  url: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<PostResponse> {
  return new Promise((resolveP, rejectP) => {
    const data = typeof body === 'string' ? Buffer.from(body) : body;
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-length': data.length,
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const timings: number[] = [];
        res.on('data', (c: Buffer) => {
          chunks.push(c);
          timings.push(Date.now());
        });
        res.on('end', () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            chunks,
            timings,
          });
        });
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    req.write(data);
    req.end();
  });
}

describe('proxy integration', () => {
  let upstream: http.Server;
  let upstreamPort = 0;
  let proxyServer: http.Server;
  let proxyPort = 0;
  let logDir = '';

  before(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'prompttrace-int-'));
    const mock = await startMockUpstream(({ res, recordChunk }) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      // Synchronous-style sequencing with awaits.
      void (async () => {
        for (let i = 0; i < 3; i++) {
          await new Promise<void>((r) => setTimeout(r, 25));
          const chunk = `event: ping\ndata: ${i}\n\n`;
          res.write(chunk);
          recordChunk(chunk);
        }
        res.end();
      })();
    });
    upstream = mock.server;
    upstreamPort = mock.port;

    const app = createApp({
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      insecureTls: false,
      logDir,
    });
    proxyServer = await listen(app, { port: 0, host: '127.0.0.1' });
    const addr = proxyServer.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('failed to bind proxy');
    }
    proxyPort = (addr as AddressInfo).port;
  });

  after(async () => {
    proxyServer.close();
    upstream.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('streams chunks back to client (no buffering)', async () => {
    const t0 = Date.now();
    const res = await post(
      `http://127.0.0.1:${proxyPort}/v1/messages`,
      '{}',
      { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    );
    const totalElapsed = Date.now() - t0;

    assert.equal(res.status, 200);
    assert.match(res.body, /data: 0/);
    assert.match(res.body, /data: 1/);
    assert.match(res.body, /data: 2/);

    assert.ok(res.chunks.length >= 3, 'client should receive ≥3 chunks');
    if (res.chunks.length >= 2 && res.timings[0] !== undefined && res.timings[1] !== undefined) {
      const gap = res.timings[1] - res.timings[0];
      assert.ok(gap >= 5, `expected a gap between chunks, got ${gap}ms`);
    }
    assert.ok(totalElapsed >= 60, `expected ≥60ms total, got ${totalElapsed}ms`);
  });

  it('forwards system prompt to system_prompt.txt', async () => {
    const body = JSON.stringify({
      model: 'claude-test',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await post(`http://127.0.0.1:${proxyPort}/v1/messages`, body, {
      'content-type': 'application/json',
      'x-api-key': 'test-key',
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    const file = await readFile(join(logDir, 'system_prompt.txt'), 'utf8');
    assert.match(file, /You are a helpful assistant\./);
  });

  it('forwards tool definitions to tools.jsonl', async () => {
    const body = JSON.stringify({
      model: 'claude-test',
      system: 'tools test',
      tools: [
        { name: 'Read', description: 'Read a file', input_schema: {} },
        { name: 'Write', description: 'Write a file', input_schema: {} },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    await post(`http://127.0.0.1:${proxyPort}/v1/messages`, body, {
      'content-type': 'application/json',
      'x-api-key': 'test-key',
    });
    await new Promise<void>((r) => setTimeout(r, 50));
    const file = await readFile(join(logDir, 'tools.jsonl'), 'utf8');
    const lines = file.trim().split('\n').map((l) => JSON.parse(l) as unknown);
    const last = lines[lines.length - 1] as { tools: Array<{ name: string }> };
    assert.equal(last.tools.length, 2);
    assert.equal(last.tools[0]?.name, 'Read');
    assert.equal(last.tools[1]?.name, 'Write');
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await post(
      `http://127.0.0.1:${proxyPort}/v1/messages`,
      'not valid json{',
      { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    );
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body) as { error: string };
    assert.equal(parsed.error, 'invalid_json');
  });

  it('forwards x-api-key header to upstream', async () => {
    let observedKey: string | string[] | undefined = undefined;
    const capture = await startMockUpstream(({ res, headers }) => {
      observedKey = headers['x-api-key'];
      res.writeHead(204);
      res.end();
    });
    try {
      const localApp = createApp({
        upstreamUrl: `http://127.0.0.1:${capture.port}`,
        insecureTls: false,
        logDir,
      });
      const localServer = await listen(localApp, { port: 0, host: '127.0.0.1' });
      const localAddr = localServer.address();
      if (localAddr === null || typeof localAddr === 'string') {
        throw new Error('failed to bind local proxy');
      }
      const localPort = (localAddr as AddressInfo).port;
      try {
        await post(`http://127.0.0.1:${localPort}/v1/messages`, '{}', {
          'content-type': 'application/json',
          'x-api-key': 'sk-test-12345',
        });
        assert.equal(observedKey, 'sk-test-12345');
      } finally {
        localServer.close();
      }
    } finally {
      capture.server.close();
    }
  });

  it('preserves the upstream URL path prefix (e.g. /anthropic)', async () => {
    let observedUrl: string | undefined = undefined;
    const capture = await startMockUpstream(({ res, url }) => {
      observedUrl = url;
      res.writeHead(200);
      res.end('ok');
    });
    try {
      const localApp = createApp({
        upstreamUrl: `http://127.0.0.1:${capture.port}/anthropic`,
        insecureTls: false,
        logDir,
      });
      const localServer = await listen(localApp, { port: 0, host: '127.0.0.1' });
      const localAddr = localServer.address();
      if (localAddr === null || typeof localAddr === 'string') {
        throw new Error('failed to bind local proxy');
      }
      const localPort = (localAddr as AddressInfo).port;
      try {
        await post(`http://127.0.0.1:${localPort}/v1/messages`, '{}', {
          'content-type': 'application/json',
          'x-api-key': 'sk-test',
        });
        assert.equal(observedUrl, '/anthropic/v1/messages');
      } finally {
        localServer.close();
      }
    } finally {
      capture.server.close();
    }
  });

  it('forwards non-/v1/messages paths verbatim (no logging)', async () => {
    const res = await get(`http://127.0.0.1:${proxyPort}/v1/models`);
    assert.equal(res.status, 200);
    assert.match(res.body, /data: 0/);
  });

  it('returns 502 when upstream is unreachable', async () => {
    const localApp = createApp({
      upstreamUrl: 'http://127.0.0.1:1',
      insecureTls: false,
      logDir,
    });
    const localServer = await listen(localApp, { port: 0, host: '127.0.0.1' });
    const localAddr = localServer.address();
    if (localAddr === null || typeof localAddr === 'string') {
      throw new Error('failed to bind local proxy');
    }
    const localPort = (localAddr as AddressInfo).port;
    try {
      const res = await post(`http://127.0.0.1:${localPort}/v1/messages`, '{}', {
        'content-type': 'application/json',
        'x-api-key': 'test-key',
      });
      assert.equal(res.status, 502);
      const parsed = JSON.parse(res.body) as { error: string };
      assert.equal(parsed.error, 'upstream_unreachable');
    } finally {
      localServer.close();
    }
  });

  it('forwards upstream non-2xx body unchanged', async () => {
    const mock = await startMockUpstream(({ res }) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    try {
      const localApp = createApp({
        upstreamUrl: `http://127.0.0.1:${mock.port}`,
        insecureTls: false,
        logDir,
      });
      const localServer = await listen(localApp, { port: 0, host: '127.0.0.1' });
      const localAddr = localServer.address();
      if (localAddr === null || typeof localAddr === 'string') {
        throw new Error('failed to bind local proxy');
      }
      const localPort = (localAddr as AddressInfo).port;
      try {
        const res = await post(`http://127.0.0.1:${localPort}/v1/messages`, '{}', {
          'content-type': 'application/json',
          'x-api-key': 'wrong',
        });
        assert.equal(res.status, 401);
        const parsed = JSON.parse(res.body) as { error: string };
        assert.equal(parsed.error, 'unauthorized');
      } finally {
        localServer.close();
      }
    } finally {
      mock.server.close();
    }
  });
});