// src/config.mjs
//
// Pure configuration loader. Resolves the proxy's runtime config from
// three sources, lowest to highest precedence:
//
//   1. Built-in DEFAULTS (hard-coded).
//   2. config.json on disk (path overridable via PROMPTTRACE_CONFIG).
//      Missing fields fall through to (1).
//   3. Environment variables — UPSTREAM_URL, PORT, HOST, INSECURE_TLS,
//      LOG_DIR. These win over the file.
//
// Reads only the parameters it knows about; unknown keys in the JSON
// are ignored. Throws on malformed input with a clear message.
//
// The proxy must never read process.env or the filesystem outside this
// module — that's how we keep config testable.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULTS = Object.freeze({
  port: 8080,
  host: '127.0.0.1',
  // Official Anthropic API. This is the conservative built-in default;
  // operators can override via config.json or the UPSTREAM_URL env var
  // to point at an Anthropic-compatible endpoint (e.g. MiniMax).
  upstreamUrl: 'https://api.anthropic.com',
  insecureTls: false,
  logDir: '.',
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** Known top-level keys. Unknown keys in config.json are ignored. */
const KNOWN_KEYS = new Set([
  'port',
  'host',
  'upstreamUrl',
  'insecureTls',
  'logDir',
]);

/**
 * Read and parse a JSON config file. Returns `null` if the file is
 * missing. Throws if it exists but cannot be parsed or has the wrong
 * shape.
 */
function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  // Filter to known keys so a typo like `upstremUrl` doesn't silently
  // get ignored as a default. (We don't error on unknown keys — that
  // would break forward-compat — but we do log it.)
  const out = {};
  const unknown = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN_KEYS.has(k)) {
      out[k] = v;
    } else {
      unknown.push(k);
    }
  }
  if (unknown.length > 0) {
    process.stderr.write(
      `[prompttrace] ignoring unknown keys in ${filePath}: ${unknown.join(', ')}\n`,
    );
  }
  return out;
}

/**
 * Coerce a JSON-loaded value into the runtime type. Mirrors the env-var
 * parsing rules in `loadConfig`.
 */
function coerce(key, value) {
  if (value === undefined || value === null) return undefined;
  switch (key) {
    case 'port': {
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(`config.json: port must be an integer, got ${JSON.stringify(value)}`);
      }
      return n;
    }
    case 'insecureTls':
      return Boolean(value);
    case 'host':
    case 'upstreamUrl':
    case 'logDir':
      if (typeof value !== 'string') {
        throw new Error(`config.json: ${key} must be a string, got ${typeof value}`);
      }
      return value;
    default:
      return value;
  }
}

function parsePort(raw) {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function parseBoolean(raw) {
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the proxy configuration from `env`, falling back to a JSON
 * file on disk and finally to built-in defaults.
 *
 * @param {NodeJS.ProcessEnv} [env]   process.env by default.
 * @param {string} [filePath]         config.json path. Defaults to
 *                                    `./config.json` next to the cwd,
 *                                    or `$PROMPTTRACE_CONFIG` if set.
 * @returns {Readonly<{
 *   port: number,
 *   host: string,
 *   upstreamUrl: string,
 *   insecureTls: boolean,
 *   logDir: string,
 *   configPath: string,
 *   sources: Record<string, 'default' | 'file' | 'env'>,
 * }>}
 */
export function loadConfig(env = process.env, filePath) {
  const resolvedFilePath =
    filePath !== undefined
      ? filePath
      : env.PROMPTTRACE_CONFIG
        ? resolve(env.PROMPTTRACE_CONFIG)
        : resolve(process.cwd(), 'config.json');

  const fromFile = readJsonFile(resolvedFilePath) ?? {};
  const fromFileResolved = {};
  for (const key of KNOWN_KEYS) {
    if (key in fromFile) {
      fromFileResolved[key] = coerce(key, fromFile[key]);
    }
  }

  // Sources: tracks where each value came from. Useful for debugging
  // ("why is it on port 9090?") and for the startup banner.
  const sources = {};

  // ---- port ----
  let port;
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsed = parsePort(env.PORT);
    if (parsed === null) {
      throw new Error(
        `Invalid PORT=${JSON.stringify(env.PORT)} — must be an integer in [1, 65535].`,
      );
    }
    port = parsed;
    sources.port = 'env';
  } else if (fromFileResolved.port !== undefined) {
    const n = Number(fromFileResolved.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(
        `config.json: port must be an integer in [1, 65535], got ${JSON.stringify(fromFileResolved.port)}`,
      );
    }
    port = n;
    sources.port = 'file';
  } else {
    port = DEFAULTS.port;
    sources.port = 'default';
  }

  // ---- host ----
  let host;
  if (env.HOST && env.HOST.length > 0) {
    host = env.HOST;
    sources.host = 'env';
  } else if (typeof fromFileResolved.host === 'string' && fromFileResolved.host.length > 0) {
    host = fromFileResolved.host;
    sources.host = 'file';
  } else {
    host = DEFAULTS.host;
    sources.host = 'default';
  }

  // ---- upstreamUrl ----
  let upstreamUrl;
  if (env.UPSTREAM_URL) {
    const parsed = parseUrl(env.UPSTREAM_URL);
    if (!parsed) {
      throw new Error(
        `Invalid UPSTREAM_URL=${JSON.stringify(env.UPSTREAM_URL)} — must be an http(s) URL.`,
      );
    }
    upstreamUrl = parsed;
    sources.upstreamUrl = 'env';
  } else if (typeof fromFileResolved.upstreamUrl === 'string') {
    const parsed = parseUrl(fromFileResolved.upstreamUrl);
    if (!parsed) {
      throw new Error(
        `config.json: upstreamUrl must be an http(s) URL, got ${JSON.stringify(fromFileResolved.upstreamUrl)}`,
      );
    }
    upstreamUrl = parsed;
    sources.upstreamUrl = 'file';
  } else {
    upstreamUrl = DEFAULTS.upstreamUrl;
    sources.upstreamUrl = 'default';
  }

  // ---- insecureTls ----
  let insecureTls;
  if (env.INSECURE_TLS !== undefined && env.INSECURE_TLS !== '') {
    insecureTls = parseBoolean(env.INSECURE_TLS);
    sources.insecureTls = 'env';
  } else if (typeof fromFileResolved.insecureTls === 'boolean') {
    insecureTls = fromFileResolved.insecureTls;
    sources.insecureTls = 'file';
  } else {
    insecureTls = DEFAULTS.insecureTls;
    sources.insecureTls = 'default';
  }

  // ---- logDir ----
  let logDir;
  if (env.LOG_DIR && env.LOG_DIR.length > 0) {
    logDir = resolve(env.LOG_DIR);
    sources.logDir = 'env';
  } else if (typeof fromFileResolved.logDir === 'string' && fromFileResolved.logDir.length > 0) {
    logDir = resolve(fromFileResolved.logDir);
    sources.logDir = 'file';
  } else {
    logDir = DEFAULTS.logDir;
    sources.logDir = 'default';
  }

  if (insecureTls) {
    process.stderr.write(
      '\n[prompttrace] WARNING: INSECURE_TLS — upstream TLS certificate verification is DISABLED.\n' +
        '[prompttrace] Use this only for debugging corporate MITM proxies. Never on production.\n\n',
    );
  }

  return Object.freeze({
    port,
    host,
    upstreamUrl,
    insecureTls,
    logDir,
    configPath: resolvedFilePath,
    sources: Object.freeze(sources),
  });
}

export { HOP_BY_HOP_HEADERS };