# REQUIREMENTS — PromptTrace

## Purpose

A local reverse proxy that sits between an AI CLI tool (e.g. Claude Code) and
`https://api.anthropic.com`. It intercepts `POST /v1/messages` requests, logs
the `system` prompt and tool definitions to local files / console, and
forwards the request to the official Anthropic API while streaming the
Server-Sent Events response back to the CLI unmodified.

This is intended for **observability and debugging of AI CLI behavior**, not
for modifying traffic. Logs stay on the local machine.

## Users / Actors

- **Operator (developer)** — runs the proxy locally, points their CLI at it,
  inspects logs after the fact.
- **CLI client** — an Anthropic-compatible client (Claude Code, aider, etc.)
  that sends `POST /v1/messages` with an `x-api-key` header.

## User Stories

1. As an operator, I run `npm start` (or `npx tsx prompttrace.ts`) and see "listening on 8080".
2. As an operator, I set `ANTHROPIC_BASE_URL=http://localhost:8080` in my
   shell, then launch the CLI. The CLI makes a request to the proxy.
3. As an operator, I see the `system` prompt printed to stdout **and**
   appended to `system_prompt.txt`.
4. As an operator, I see a summary of every tool definition (name +
   description) printed to stdout and appended to `tools.jsonl`.
5. As an operator, the CLI receives a streamed response with no extra
   latency from buffering.
6. As an operator, if the upstream call fails, I see a clear error in the
   proxy log and the CLI receives a meaningful HTTP error (not a hung
   socket).

## Functional Requirements

1. **FR-1** The proxy listens on `127.0.0.1:8080` by default. Port is
   overridable via `PORT` env var.
2. **FR-2** It accepts `POST /v1/messages` and forwards it verbatim to
   `https://api.anthropic.com/v1/messages`, preserving the request body,
   `x-api-key`, `anthropic-version`, and any other Anthropic-specific
   headers.
3. **FR-3** It parses the incoming JSON body. If parsing fails, it returns
   `400 Bad Request` with a JSON error body.
4. **FR-4** If the body contains a `system` field (string or array of
   content blocks), it is written to `system_prompt.txt` and printed to
   stdout. Each request is preceded by a separator with a UTC timestamp and
   request ID.
5. **FR-5** If the body contains a `tools` field (array of tool
   definitions), the proxy extracts `name` and `description` for each tool
   and appends one JSON object per request to `tools.jsonl`.
6. **FR-6** The upstream response is streamed back to the client
   character-by-character (or chunk-by-chunk). The proxy must not buffer
   the full response before flushing.
7. **FR-7** The proxy is **read-only** on the request body: it logs but
   does not mutate headers, the URL path, query parameters, or the JSON
   body before forwarding.
8. **FR-8** On upstream error (network failure, non-2xx status), the proxy
   logs the status / error and pipes the upstream response body to the
   client (for non-2xx the upstream body is forwarded as-is).
9. **FR-9** All log files are written to the current working directory and
   are append-only. The proxy never deletes or truncates its own log
   files.
10. **FR-10** The proxy supports TLS verification of the upstream
    `api.anthropic.com` certificate. Operators can disable verification
    with `INSECURE_TLS=1` for environments that MITM the connection
    (corporate proxies with a custom CA). When verification is disabled
    the proxy logs a loud warning on startup.
11. **FR-11** The proxy uses Node.js native `fetch` (Node 18+) to forward
    requests. No third-party HTTP client is required.
12. **FR-12** The proxy runs as a single Node.js process, is written in
    TypeScript (`"type": "module"`), and runs directly via `tsx` with no
    compile step in the dev path.

## Non-Functional Requirements

- **NFR-1 Startup time** < 200 ms.
- **NFR-2 Memory** < 50 MB idle.
- **NFR-3 Stream latency overhead** < 10 ms p50 added to first byte.
- **NFR-4 Single dependency**: `express` for the inbound HTTP server. No
  client SDK, no logger library.
- **NFR-5 Windows / macOS / Linux** support. Code uses platform-neutral
  APIs only.
- **NFR-6 Crash safety**: an uncaught exception in a request handler must
  not take down the whole server.

## Out of Scope

- Modifying or redacting the request body before forwarding.
- Caching responses.
- Recording full request/response bodies (only `system` and tool metadata
  are persisted).
- Authentication of clients connecting to the proxy. The proxy is
  intended to be bound to loopback only.
- Supporting non-`/v1/messages` Anthropic endpoints. The proxy forwards any
  non-matching path verbatim, but logging only applies to `/v1/messages`.

## Constraints & Assumptions

- Node.js **18.17+** is required for native `fetch` with streaming bodies.
- The CLI is expected to send `Authorization: Bearer …` **or**
  `x-api-key: …`. Both are forwarded unchanged.
- The operator is responsible for not running this on a multi-user host.
  The proxy binds to loopback by default.
- File I/O is append-only and best-effort: a logging failure must not
  crash the proxy or break the upstream call.

## Acceptance Criteria

- `npm start` (or `tsx prompttrace.ts`) boots, prints "listening on 8080", and stays running.
- A `curl` request to `http://127.0.0.1:8080/v1/messages` with a valid
  body produces a `system_prompt.txt` line and a `tools.jsonl` entry,
  and forwards the response to `curl`.
- The CLI (Claude Code) with `ANTHROPIC_BASE_URL=http://localhost:8080`
  can complete a streamed request end-to-end with no observable
  difference from a direct connection.
- Killing the upstream connection mid-stream results in a logged error
  and a closed client socket — never a hung proxy.

## Open Questions

None at project kickoff. Decisions deferred to `DESIGN.md`.
