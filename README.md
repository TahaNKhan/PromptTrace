# PromptTrace

A small, local reverse proxy that sits between an AI CLI tool
(Claude Code, aider, anything that speaks Anthropic's `POST /v1/messages`)
and an Anthropic-compatible API.

The **built-in default upstream** is `https://api.anthropic.com` (the
official Anthropic API). The shipped `config.json` overrides this to
`https://api.minimax.io/anthropic` to match the local Claude Code
install — change it to suit your setup.

It logs the **system prompt** and the **tool definitions** of every
request to local files, and forwards the full SSE stream back to the
CLI without buffering.

> Use case: debugging what prompts / tools an AI CLI sends to its
> upstream API without modifying traffic. Logs stay on the local machine.

## Install

```sh
npm install
```

That installs the one runtime dependency (`express`) and the dev
toolchain (`tsx`, `typescript`, `@types/node`, `@types/express`).

## Run

```sh
npm start
# or:
npx tsx prompttrace.ts
```

The proxy runs directly from TypeScript via `tsx` — no separate
build step required. If you'd rather compile to JS first:

```sh
npm run build     # writes dist/
node dist/prompttrace.js
```

You'll see (assuming the shipped `config.json`):

```
[prompttrace] listening on http://127.0.0.1:8080
[prompttrace] forwarding to https://api.minimax.io/anthropic
[prompttrace] logs: ./system_prompt.txt, ./tools.jsonl

[prompttrace] point your CLI here with:
  ANTHROPIC_BASE_URL=http://localhost:8080
```

Press `Ctrl-C` to stop.

If `config.json` is missing, the proxy falls back to the built-in
default `https://api.anthropic.com`.

## Point Claude Code at the proxy

The shipped `config.json` points the proxy at the **MiniMax
Anthropic-compatible endpoint** (`https://api.minimax.io/anthropic`),
which is what the local Claude Code install uses by default
(see `~/.claude/settings.json` → `ANTHROPIC_BASE_URL`). If you'd
rather talk to `api.anthropic.com` directly, edit `config.json` (or
delete it — the built-in default is the official endpoint).

To use it:

1. Start the proxy:
   ```sh
   npm start
   ```
2. In another shell (or by editing `~/.claude/settings.json`), point
   Claude Code at the proxy:
   ```sh
   export ANTHROPIC_BASE_URL=http://localhost:8080
   claude
   ```
   The `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` is picked
   up automatically; the proxy forwards it unchanged.

3. Watch `system_prompt.txt` and `tools.jsonl` accumulate in the
   directory you started the proxy from.

## Configuration

Config is resolved from three sources, lowest to highest precedence:

1. **Built-in defaults** (hard-coded in `src/config.mjs`)
2. **`config.json`** at the project root, or at the path given by
   `PROMPTTRACE_CONFIG`. Missing fields fall through to the defaults.
3. **Environment variables** — these override everything.

On startup the proxy prints which source supplied each value, e.g.:

```
[prompttrace] config: ./config.json (upstreamUrl=file, port=file, host=file, logDir=file)
```

### `config.json` schema

The shipped file:

```json
{
  "upstreamUrl": "https://api.minimax.io/anthropic",
  "port": 8080,
  "host": "127.0.0.1",
  "insecureTls": false,
  "logDir": "."
}
```

The built-in default (used when `config.json` is absent) is
`https://api.anthropic.com`.

| Field         | Type      | Notes                                                                       |
| ------------- | --------- | --------------------------------------------------------------------------- |
| `upstreamUrl` | string    | Base URL where requests are forwarded. The inbound path is appended, so `/v1/messages` becomes `/anthropic/v1/messages` (or `/v1/messages` when pointing at `api.anthropic.com`). |
| `port`        | integer   | Inbound port.                                                               |
| `host`        | string    | Loopback by default; set to `0.0.0.0` to expose on the network.             |
| `insecureTls` | boolean   | `true` skips upstream cert verification. Loud warning printed on startup.   |
| `logDir`      | string    | Directory where `system_prompt.txt` and `tools.jsonl` are written.          |

Unknown keys are warned and ignored.

### Env var overrides

| Env var              | Overrides       | Notes                                            |
| -------------------- | --------------- | ------------------------------------------------ |
| `UPSTREAM_URL`       | `upstreamUrl`   | http/https URL                                   |
| `PORT`               | `port`          | Integer in `[1, 65535]`                          |
| `HOST`               | `host`          |                                                  |
| `INSECURE_TLS`       | `insecureTls`   | Set to `1` to enable                             |
| `LOG_DIR`            | `logDir`        | Absolute or relative path                        |
| `PROMPTTRACE_CONFIG` | (config path)   | Use a non-default `config.json` location         |

## What gets logged

For every `POST /v1/messages` request the proxy extracts:

- **`system`** — the system prompt. May be a string or an array of
  content blocks; only `text` blocks are written verbatim.
- **`tools`** — the array of tool definitions; only `name` and
  `description` are recorded.

Everything else (the user messages, the API key, the response) is
forwarded verbatim and **not** persisted.

## Streaming

Anthropic's `/v1/messages` returns Server-Sent Events. The proxy pipes
the upstream response straight to the client via Node's
`Readable.fromWeb`, so chunks reach your CLI as soon as they leave
Anthropic. There is no buffering, no `await response.text()`, no
transformation.

If the CLI disconnects mid-request, the upstream `fetch` is aborted —
you don't pay for a response you won't read.

## TLS / "connection refused" / "self-signed certificate"

The proxy talks to the upstream over HTTPS using the system
trust store, so outbound TLS verification is on by default. If your
environment uses a custom CA (corporate proxy, mitmproxy, Zscaler):

```sh
export NODE_EXTRA_CA_CERTS=/path/to/your-ca.pem
npm start
```

Node will trust that CA in addition to the system roots.

If your CLI refuses to talk to `http://localhost:8080` because it
expects HTTPS (some clients enforce this for safety), front the
proxy with `caddy` or `nginx` reverse-proxying to `127.0.0.1:8080`.
Example `caddy` snippet:

```
localhost:8443 {
  reverse_proxy 127.0.0.1:8080
  tls internal
}
```

Then set `ANTHROPIC_BASE_URL=https://localhost:8443`.

If you can't use a sidecar TLS terminator, set `INSECURE_TLS=1` for
**upstream** cert problems only — it does **not** affect the inbound
listener.

## Development

```sh
npm test            # runs tsx --test on test/*.test.ts
npm run typecheck   # strict tsc --noEmit
npm run build       # compiles to dist/
```

## Project layout

```
prompttrace.ts             # entry point
src/
  config.ts                # defaults + config.json + env-var merging
  logger.ts                # system_prompt.txt + tools.jsonl writers
  forwarder.ts             # fetch + SSE streaming
  server.ts                # Express app factory
test/
  config.test.ts
  logger.test.ts
  forwarder.test.ts
config.json                # upstream URL + optional overrides
tsconfig.json              # strict TS config (see below)
REQUIREMENTS.md
DESIGN.md
TASKS.md
```

## TypeScript

The project is strict TypeScript with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and zero `any`. `tsx` runs the source
directly; `npm run typecheck` enforces the rules in CI; `npm run build`
emits plain JS to `dist/` for users who don't want a TS toolchain.

## License

MIT.