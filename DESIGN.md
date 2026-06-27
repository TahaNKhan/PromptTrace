# DESIGN — PromptTrace

## Architecture Overview

```
┌──────────────┐         ┌──────────────────────┐         ┌─────────────────────┐
│  AI CLI      │ ──HTTP──▶  PromptTrace         │ ──HTTPS──▶  api.minimax.io     │
│  (client)    │ ◀──SSE───  127.0.0.1:8080      │ ◀──SSE───  /anthropic/v1/... │
└──────────────┘         └──────────────────────┘         └─────────────────────┘
                                  │
                                  │ (append)
                                  ▼
                         system_prompt.txt
                         tools.jsonl
```

A single Node.js process hosts one Express HTTP server. Each inbound
request is parsed, logged, then forwarded to Anthropic via native
`fetch`. The upstream response body is piped back to the client using a
Web `ReadableStream` adapter so the proxy never holds the full body in
memory.

## Tech Stack

| Choice                | Rationale                                              |
| --------------------- | ------------------------------------------------------ |
| Node.js 18+           | Native `fetch`, `ReadableStream`, no transpile.        |
| ES Modules            | Required by the prompt; modern syntax.                 |
| `express`             | Battle-tested inbound HTTP, easy body parsing.         |
| Native `fetch`        | Avoids `node-fetch` / `axios` / `undici`; built-in SSE. |
| `node:fs/promises`    | Append-only log writes, no race conditions.           |

## Module Layout

```
prompttrace/           # project root
├── prompttrace.mjs    # Entry point: starts Express, wires routes
├── src/
│   ├── server.mjs     # Express app factory + listener
│   ├── forwarder.mjs  # fetch wrapper that streams upstream → client
│   ├── logger.mjs     # system_prompt.txt + tools.jsonl appenders
│   └── config.mjs     # defaults, config.json, env-var parsing, validation
├── test/
│   ├── config.test.mjs
│   ├── logger.test.mjs
│   └── forwarder.test.mjs
├── config.json        # upstream URL + optional overrides
├── package.json       # type: module, deps: express
├── README.md          # Run instructions, env-var table, TLS notes
├── REQUIREMENTS.md
├── DESIGN.md
└── TASKS.md
```

### `prompttrace.mjs`

Thin entry point. Reads config, creates server, listens, installs
process-level handlers (`uncaughtException`, `unhandledRejection`,
`SIGINT`).

### `src/config.mjs`

Pure function `loadConfig(env = process.env)` returning a frozen object:

```
{
  port:        number,
  host:        string,           // '127.0.0.1'
  upstreamUrl: string,           // 'https://api.anthropic.com'
  insecureTls: boolean,
  logDir:      string,           // process.cwd()
}
```

Validates that `PORT` is an integer in `[1, 65535]`. Logs a warning if
`INSECURE_TLS=1` is set.

### `src/logger.mjs`

Exports two functions:

- `logSystemPrompt({ requestId, system, timestamp })` — appends a
  separator block + the system prompt to `system_prompt.txt`.
- `logTools({ requestId, tools, timestamp })` — appends a single JSON
  object per request to `tools.jsonl`.

`system` may be a string, an array of content blocks, or missing. The
function normalizes it to a printable string. Files are opened with
`fs.open(path, 'a')` once per call — fine because request rate from a
single CLI is low. Errors from logging are caught and printed to
`stderr`; they never propagate.

### `src/forwarder.mjs`

Single export: `forwardRequest({ req, res, body, headers, requestId })`.

Flow:

1. Build upstream URL by stripping the local origin and prepending
   `config.upstreamUrl`.
2. Build `fetch` `init`:
   - `method` from `req.method`
   - `headers` = filtered copy of inbound headers — drop `host`,
     `content-length` (fetch sets it), `connection`. Keep
     `x-api-key`, `anthropic-version`, `authorization`, `user-agent`,
     `accept`, etc.
   - `body` = `Buffer.from(rawBody)` for non-GET/HEAD, else `undefined`.
   - `duplex: 'half'` is required by undici when streaming a body.
3. Call `fetch(upstreamUrl, init)` with `signal` = an `AbortController`
   tied to `req.on('close')` so a client disconnect cancels the upstream.
4. On response:
   - Set `res.status(response.status)`.
   - Copy response headers (drop hop-by-hop).
   - If the response body is a stream (`response.body` is a
     `ReadableStream`), pipe it via `Readable.fromWeb(response.body)`
     directly to `res`. Each chunk is written with `res.write` so it
     flushes immediately.
   - On stream error: log + destroy both sockets.
5. On `fetch` rejection (network error): respond `502 Bad Gateway` with
   a JSON error body.

### `src/server.mjs`

`createApp(config)` returns an Express app:

- `express.json({ limit: '50mb' })` — parse JSON for logging purposes
  only. The raw body is also captured using `express.raw({ type: '*/*',
  limit: '50mb' })` for forwarding. Because we need both, we use a
  custom verify callback that buffers the raw body and then
  re-attempts `JSON.parse` for logging.
- `app.post('/v1/messages', handler)` — the only logged route.
- `app.all('*', passthroughHandler)` — forwards any other path/method
  verbatim, without logging.
- `handler` does:
  1. `requestId = crypto.randomUUID()`
  2. Try `JSON.parse(rawBody)`. On failure → 400 + JSON error.
  3. Fire-and-forget `logSystemPrompt(...)` and `logTools(...)`.
  4. `await forwardRequest(...)`.
- `listen(app, port, host)` returns the `http.Server`.

## Data Flow — `/v1/messages`

```
client POST /v1/messages
  │
  ▼
express raw body parser (50 mb cap)
  │  rawBody = Buffer
  ▼
JSON.parse(rawBody)  ──fail──▶ 400 { error: "invalid json" }
  │
  ▼
logger.logSystemPrompt  (async, best-effort)
logger.logTools          (async, best-effort)
  │
  ▼
forwardRequest:
  headers ← filter inbound
  init = { method, headers, body: rawBody, duplex: 'half' }
  fetch(upstreamUrl, init)
  │
  ▼
response.body → Readable.fromWeb → res (streamed)
  │
  ▼
client receives SSE stream
```

## API Surface

The proxy itself exposes no documented API — it is a transparent
forwarder. Its **configuration** surface is the env-var table in the
README. Its **log-file surface** is:

- `system_prompt.txt` — human-readable, append-only.
- `tools.jsonl` — machine-readable, one JSON object per line.

## Key Algorithms

### Hop-by-hop header stripping

When forwarding both directions, these headers are removed:

- `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`,
  `te`, `trailers`, `transfer-encoding`, `upgrade`
- `host` (replaced with `api.anthropic.com` on the outbound request)
- `content-length` (recomputed by `fetch`)

### Client-disconnect cancellation

`res.on('close', () => { if (!res.writableEnded) controller.abort() })`
cancels the upstream `fetch` when the CLI goes away mid-stream.

**Important**: we do NOT use `req.on('close')`. In Node 18+ that event
fires as soon as the request body has been consumed (which happens
during JSON parsing via `express.json()`), BEFORE the response is sent
— registering on it would abort every single request immediately.
The correct surface is the response side: `res.on('close')` fires
when the response stream is closed, either because the client
disconnected (writableEnded still false) or because the upstream
finished (writableEnded true). The `writableEnded` check distinguishes
the two.

### Streaming flush

`res.write(chunk)` flushes per chunk in Node; we do **not** call
`res.end()` until the upstream stream ends or errors. We do **not** call
`res.writeHead()` after `res.status()` because Express already wrote
the headers via `res.status(...).set(...)`.

## State Management

The proxy holds no persistent state between requests. File handles are
opened, written, and closed per write. There is no in-memory cache.

## Concurrency Model

Single-process, single-threaded Node event loop. Concurrent requests are
handled by interleaving I/O on the event loop. There is no shared
mutable state between request handlers.

## Error Handling Strategy

| Failure mode                | Behavior                                              |
| --------------------------- | ----------------------------------------------------- |
| Malformed JSON body         | `400 { error: "invalid json" }`                       |
| Upstream network error      | `502 { error: "upstream unreachable", detail }`       |
| Upstream non-2xx            | Forward status + body verbatim                        |
| Client disconnect mid-call  | AbortController cancels upstream fetch                |
| Log file write failure      | Logged to stderr, request continues                   |
| Uncaught exception in route | 500 + JSON error; server stays up                     |

## Testing Strategy

- **Unit**: `src/logger.mjs` is pure I/O — testable with a temp dir.
- **Integration**: spin up the app in-process on an ephemeral port,
  stand up a mock upstream (`http.createServer`) that returns canned
  SSE chunks, and assert:
  - Logs are appended correctly.
  - Response is streamed (chunks arrive at client before the upstream
    finishes writing).
  - Malformed JSON → 400.
  - Client disconnect aborts upstream.
- The mock upstream runs on `127.0.0.1` with a self-signed cert? No —
  tests target the upstream fetch through a real local HTTP server and
  configure the proxy to forward to `http://127.0.0.1:<test-port>`,
  bypassing TLS for testability. (`INSECURE_TLS` is unrelated; it only
  governs the cert *verification* of the real Anthropic endpoint.)

## Deployment / Runtime

- `npm install` once.
- `node proxy.mjs` (or `npm start`).
- Set `ANTHROPIC_BASE_URL=http://localhost:8080` and
  `ANTHROPIC_AUTH_TOKEN=<real key>` (Claude Code uses the env var name
  `ANTHROPIC_AUTH_TOKEN` for the API key; the proxy forwards whatever
  the client sends).
- Logs accumulate next to the cwd.

## Security & Privacy

- Listens on `127.0.0.1` by default — not reachable from other hosts.
- Does not print `x-api-key` or any header values to stdout / logs.
- Does not write the full request body to disk.
- `INSECURE_TLS=1` is a footgun; the warning on startup is
  unconditional.

## Risks & Mitigations

| Risk                                                | Mitigation                                          |
| --------------------------------------------------- | --------------------------------------------------- |
| Buffering SSE breaks the CLI (timeouts).            | Use `Readable.fromWeb`, never `await response.text()`. |
| Hanging sockets on client disconnect.               | `AbortController` tied to `req` close.              |
| Log I/O blocking the event loop.                    | Append writes are short; failures are swallowed.    |
| Operator forgets to point CLI at proxy.             | README documents env vars explicitly.               |
| CLI rejects `http://localhost` due to TLS.          | README explains Node's `NODE_EXTRA_CA_CERTS` and `--use-system-ca`, and offers an opt-in to run the proxy on HTTPS with a self-signed cert (see README §"TLS"). |

## Implementation Order

1. `package.json` with `type: module` and `express` dep.
2. `src/config.mjs`.
3. `src/logger.mjs`.
4. `src/forwarder.mjs`.
5. `src/server.mjs`.
6. `proxy.mjs` entry point.
7. Tests.
8. README with run instructions.
