# TASKS — PromptTrace

Execution order. Each task lists its requirements, design sections,
acceptance criteria, and size. Reflects the current TypeScript
implementation — `.mjs` / JSDoc-typed sources are gone.

---

## T1. Bootstrap project + TypeScript toolchain

**Description**: Create `package.json` with `"type": "module"`,
`"main": "prompttrace.ts"`, an `npm start` script that runs via
`tsx`, runtime dep `express`, and dev deps `tsx`, `typescript`,
`@types/node`, `@types/express`. Add `tsconfig.json` with strict
flags (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `noUnusedLocals`,
`noUnusedParameters`), `module: NodeNext`, `moduleResolution: NodeNext`,
`resolveJsonModule`. Add a `.gitignore` for `node_modules`, `dist/`,
and the log files.

- Maps to: FR-1, NFR-4, NFR-5, FR-12
- Acceptance: `npm install` succeeds; `npx tsc --noEmit` exits 0 with no diagnostics; `tsx --test` runs all tests cleanly.
- Status: ✅ done

---

## T2. Config module

**Description**: Implement `src/config.ts` with `loadConfig()` that
reads `PORT`, `HOST`, `UPSTREAM_URL`, `INSECURE_TLS`, `LOG_DIR`, plus
`config.json` on disk (path overridable via `PROMPTTRACE_CONFIG`),
validates each, returns a frozen `Config`, and warns loudly on
`INSECURE_TLS=1`. Exports typed `Config`, `ConfigSources`,
`ConfigSource`, and `HOP_BY_HOP_HEADERS`. No `any`; uses
`unknown` + type guards on the JSON input.

- Maps to: FR-1, FR-10, NFR-5
- Acceptance: missing / invalid `PORT` is rejected with a clear message; defaults are sensible; precedence is `defaults → file → env`.
- Status: ✅ done

---

## T3. Logger module

**Description**: Implement `src/logger.ts` with typed `logSystemPrompt`
and `logTools`. Both take a payload `{ requestId, timestamp, … }` and
append to `system_prompt.txt` / `tools.jsonl`. Catches all I/O errors
and writes them to `stderr`. Normalizes `system` (string or array of
content blocks) to a printable string. Exports `normalizeSystem` and
`summarizeTools` as pure functions.

- Maps to: FR-4, FR-5, FR-9
- Acceptance: Two consecutive calls produce two clearly-separated blocks in `system_prompt.txt` and two JSON lines in `tools.jsonl`.
- Status: ✅ done

---

## T4. Forwarder module

**Description**: Implement `src/forwarder.ts` exporting typed
`forwardRequest(args: ForwardRequestArgs)`. Strips hop-by-hop headers,
calls native `fetch` with the raw body buffered as a `Buffer`, streams
the response back to `res` via `Readable.fromWeb`, aborts upstream on
client disconnect (`res.on('close')` + `writableEnded` check — NOT
`req.on('close')`, which fires prematurely in Node 18+), forwards
upstream non-2xx bodies verbatim, and returns 502 on network failure.
External-boundary casts (`Headers`, `BodyInit`, `ReadableStream`) are
narrowed through `unknown`; no `any`.

- Maps to: FR-2, FR-6, FR-7, FR-8, NFR-3
- Acceptance: a streamed upstream response reaches the client chunk-by-chunk; a closed client cancels the upstream fetch; an upstream 4xx/5xx body reaches the client unchanged.
- Status: ✅ done

---

## T5. Server module

**Description**: Implement `src/server.ts` with typed `createApp(config: AppConfig)` and
`listen(app, addr: ListenAddr)`. Mounts raw-body parsing via `express.json({ verify })`, the `/v1/messages` handler (parses JSON for logging only, fires loggers fire-and-forget, awaits forwarder), a passthrough `app.all('*')` for other paths, and a body-parser error handler that returns JSON 400 on malformed JSON. `AsyncRequestHandler` type wraps async routes with proper error propagation.

- Maps to: FR-3, FR-7, FR-12
- Acceptance: POST `/v1/messages` with valid JSON logs and forwards; malformed JSON returns 400 with JSON body; other routes forward without logging.
- Status: ✅ done

---

## T6. Entry point

**Description**: Implement `prompttrace.ts`. Loads config, creates
app, listens, installs `uncaughtException`, `unhandledRejection`, and
`SIGINT`/`SIGTERM` handlers that drain in-flight requests for 2 s
before exiting. Prints startup banner with per-field source attribution.

- Maps to: NFR-6, FR-12
- Acceptance: `npm start` boots, prints a startup banner with the listen address, exits cleanly on Ctrl-C.
- Status: ✅ done

---

## T7. Tests

**Description**: Add `test/*.test.ts` with `node:test` (no
third-party test runner). All sources are typed. Cover config loading
(env vars, file precedence, defaults, validation), logger
normalization, malformed-JSON 400, streamed upstream passthrough
(verifies chunks arrive non-buffered), header stripping, client
disconnect, x-api-key forwarding, and upstream URL path-prefix
preservation. Tests use an in-process mock upstream server bound to
an ephemeral port.

- Maps to: §2 of standing instructions
- Acceptance: `npm test` exits 0 with 42/42 tests passing.
- Status: ✅ done

---

## T8. README

**Description**: Write `README.md` covering install, run (npm start +
tsx), env-var table (`PORT`, `HOST`, `UPSTREAM_URL`, `INSECURE_TLS`,
`LOG_DIR`, `PROMPTTRACE_CONFIG`), `config.json` schema and precedence,
`ANTHROPIC_BASE_URL` setup for Claude Code, TLS troubleshooting
(`NODE_EXTRA_CA_CERTS`, `caddy` reverse-proxy), and a TypeScript
section explaining the strict-config + tsx workflow.

- Maps to: NFR-5, FR-10
- Acceptance: A new operator can install, run, and point Claude Code at the proxy using only the README.
- Status: ✅ done

---

## T9. (Future) Optional improvements

Not currently scheduled. Possible follow-ups:

- **Compiled `dist/` release pipeline.** Publish built JS to npm so
  consumers don't need a TypeScript toolchain. Would require a separate
  `tsconfig.build.json` that excludes `test/` and the entry's `tsx`-
  specific bits.
- **Live log rotation.** `system_prompt.txt` grows forever; a size or
  age cap would be nice for long-running sessions.
- **Structured request log.** Currently we only persist `system` and
  `tools`. A opt-in flag to log the full request body (with API keys
  redacted) would be useful for postmortems.