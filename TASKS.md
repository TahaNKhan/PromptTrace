# TASKS — PromptTrace

Execution order. Each task lists its requirements, design sections,
acceptance criteria, and size.

---

## T1. Bootstrap project

**Description**: Create `package.json` with `"type": "module"`,
`"main": "proxy.mjs"`, an `npm start` script, and a single runtime
dep `express`. Add a `.gitignore` for `node_modules` and the log files.

- Maps to: FR-1, NFR-4, NFR-5
- Acceptance: `npm install` succeeds; `node -e "import('./proxy.mjs')"` does not throw a syntax error.
- Estimate: S

---

## T2. Config module

**Description**: Implement `src/config.mjs` with `loadConfig()` that
reads `PORT`, `HOST`, `UPSTREAM_URL`, `INSECURE_TLS`, validates them,
returns a frozen object, and warns loudly on `INSECURE_TLS=1`.

- Maps to: FR-1, FR-10, NFR-5
- Acceptance: missing / invalid `PORT` is rejected with a clear message; defaults are sensible.
- Estimate: S

---

## T3. Logger module

**Description**: Implement `src/logger.mjs` with `logSystemPrompt` and
`logTools`. Both functions take a payload `{ requestId, timestamp, … }`
and append to `system_prompt.txt` / `tools.jsonl`. Catches all I/O
errors and writes them to `stderr`. Normalizes `system` to a printable
string.

- Maps to: FR-4, FR-5, FR-9
- Acceptance: Two consecutive calls produce two clearly-separated blocks in `system_prompt.txt` and two JSON lines in `tools.jsonl`.
- Estimate: S

---

## T4. Forwarder module

**Description**: Implement `src/forwarder.mjs` exporting
`forwardRequest`. Strips hop-by-hop headers, calls native `fetch` with
the raw body buffered as a `Buffer`, streams the response back to
`res` via `Readable.fromWeb`, aborts upstream on client disconnect,
forwards upstream non-2xx bodies verbatim, and returns 502 on network
failure.

- Maps to: FR-2, FR-6, FR-7, FR-8, NFR-3
- Acceptance: a streamed upstream response reaches the client chunk-by-chunk; a closed client cancels the upstream fetch; an upstream 4xx/5xx body reaches the client unchanged.
- Estimate: M

---

## T5. Server module

**Description**: Implement `src/server.mjs` with `createApp(config)` and
`listen(app, port, host)`. Mounts raw-body parsing on all routes,
mounts the `/v1/messages` handler, and a passthrough `app.all('*')` for
other paths. The handler parses JSON for logging only, fires loggers
without awaiting, then awaits forwarder.

- Maps to: FR-3, FR-7, FR-12
- Acceptance: POST `/v1/messages` with valid JSON logs and forwards; malformed JSON returns 400; other routes forward without logging.
- Estimate: M

---

## T6. Entry point

**Description**: Implement `proxy.mjs`. Loads config, creates app,
listens, installs `uncaughtException`, `unhandledRejection`, and
`SIGINT` handlers that drain in-flight requests for 2 s before exiting.

- Maps to: NFR-6, FR-12
- Acceptance: `node proxy.mjs` boots, prints a startup banner with the listen address, exits cleanly on Ctrl-C.
- Estimate: S

---

## T7. Tests

**Description**: Add `test/` with `node:test` (no third-party test
runner). Cover logger normalization, malformed-JSON 400, streamed
upstream passthrough, header stripping, and client-disconnect
cancellation. Tests use an in-process mock upstream server bound to
an ephemeral port; the proxy is configured to forward to it.

- Maps to: §2 of standing instructions
- Acceptance: `npm test` exits 0 with all tests passing.
- Estimate: M

---

## T8. README

**Description**: Write `README.md` covering install, run, env-var
table (`PORT`, `HOST`, `UPSTREAM_URL`, `INSECURE_TLS`,
`ANTHROPIC_BASE_URL` setup for Claude Code), TLS troubleshooting
(`NODE_EXTRA_CA_CERTS`, `--use-system-ca`), and an example session
showing log output.

- Maps to: NFR-5, FR-10
- Acceptance: A new operator can install, run, and point Claude Code at the proxy using only the README.
- Estimate: S
