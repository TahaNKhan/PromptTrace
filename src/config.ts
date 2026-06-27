// src/config.ts
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

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly upstreamUrl: string;
  readonly insecureTls: boolean;
  readonly logDir: string;
  readonly configPath: string;
  readonly sources: Readonly<ConfigSources>;
}

export interface ConfigSources {
  readonly port: ConfigSource;
  readonly host: ConfigSource;
  readonly upstreamUrl: ConfigSource;
  readonly insecureTls: ConfigSource;
  readonly logDir: ConfigSource;
}

export type ConfigSource = 'default' | 'file' | 'env';

type KnownKey = keyof ConfigSources;

const KNOWN_KEYS: ReadonlySet<KnownKey> = new Set([
  'port',
  'host',
  'upstreamUrl',
  'insecureTls',
  'logDir',
]);

const DEFAULTS: Omit<Config, 'configPath' | 'sources'> = {
  port: 8080,
  host: '127.0.0.1',
  // Official Anthropic API. This is the conservative built-in default;
  // operators can override via config.json or the UPSTREAM_URL env var
  // to point at an Anthropic-compatible endpoint (e.g. MiniMax).
  upstreamUrl: 'https://api.anthropic.com',
  insecureTls: false,
  logDir: '.',
};

export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
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

type JsonObject = Readonly<Record<string, unknown>>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and parse a JSON config file. Returns `null` if the file is
 * missing. Throws if it exists but cannot be parsed or has the wrong
 * shape.
 */
function readJsonFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) return null;
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN_KEYS.has(k as KnownKey)) {
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

/** Resolved value of a single config field, after coercion. */
type Coerced =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'string'; readonly value: string };

function coerce(key: KnownKey, value: unknown): Coerced {
  if (value === undefined || value === null) {
    throw new Error(`config.json: ${key} cannot be null or undefined`);
  }
  switch (key) {
    case 'port': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n)) {
        throw new Error(
          `config.json: port must be an integer, got ${JSON.stringify(value)}`,
        );
      }
      return { kind: 'number', value: n };
    }
    case 'insecureTls':
      return { kind: 'boolean', value: Boolean(value) };
    case 'host':
    case 'upstreamUrl':
    case 'logDir':
      if (typeof value !== 'string') {
        throw new Error(
          `config.json: ${key} must be a string, got ${typeof value}`,
        );
      }
      return { kind: 'string', value };
    default: {
      // Exhaustiveness check — TS will error here if a new key is added
      // without a case.
      const _exhaustive: never = key;
      throw new Error(`Unknown config key: ${String(_exhaustive)}`);
    }
  }
}

function parsePort(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function parseBoolean(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function parseUrl(raw: string): string | null {
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
 * @param env       process.env by default.
 * @param filePath  config.json path. Defaults to `./config.json` next
 *                  to the cwd, or `$PROMPTTRACE_CONFIG` if set.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  filePath?: string,
): Config {
  const resolvedFilePath =
    filePath !== undefined
      ? filePath
      : env.PROMPTTRACE_CONFIG !== undefined && env.PROMPTTRACE_CONFIG !== ''
        ? resolve(env.PROMPTTRACE_CONFIG)
        : resolve(process.cwd(), 'config.json');

  const fromFile = readJsonFile(resolvedFilePath) ?? {};
  const fromFileResolved: Partial<Record<KnownKey, Coerced>> = {};
  for (const key of KNOWN_KEYS) {
    const raw = fromFile[key];
    if (raw !== undefined) {
      fromFileResolved[key] = coerce(key, raw);
    }
  }

  const sources: Record<KnownKey, ConfigSource> = {
    port: 'default',
    host: 'default',
    upstreamUrl: 'default',
    insecureTls: 'default',
    logDir: 'default',
  };

  // ---- port ----
  let port: number;
  const envPort = parsePort(env.PORT);
  if (envPort !== undefined && envPort !== null) {
    port = envPort;
    sources.port = 'env';
  } else if (envPort === null) {
    throw new Error(
      `Invalid PORT=${JSON.stringify(env.PORT)} — must be an integer in [1, 65535].`,
    );
  } else {
    const fileValue = fromFileResolved.port;
    if (fileValue !== undefined && fileValue.kind === 'number') {
      if (fileValue.value < 1 || fileValue.value > 65535) {
        throw new Error(
          `config.json: port must be an integer in [1, 65535], got ${fileValue.value}`,
        );
      }
      port = fileValue.value;
      sources.port = 'file';
    } else {
      port = DEFAULTS.port;
      sources.port = 'default';
    }
  }

  // ---- host ----
  let host: string;
  if (env.HOST !== undefined && env.HOST.length > 0) {
    host = env.HOST;
    sources.host = 'env';
  } else {
    const fileValue = fromFileResolved.host;
    if (fileValue !== undefined && fileValue.kind === 'string' && fileValue.value.length > 0) {
      host = fileValue.value;
      sources.host = 'file';
    } else {
      host = DEFAULTS.host;
      sources.host = 'default';
    }
  }

  // ---- upstreamUrl ----
  let upstreamUrl: string;
  if (env.UPSTREAM_URL !== undefined && env.UPSTREAM_URL !== '') {
    const parsed = parseUrl(env.UPSTREAM_URL);
    if (parsed === null) {
      throw new Error(
        `Invalid UPSTREAM_URL=${JSON.stringify(env.UPSTREAM_URL)} — must be an http(s) URL.`,
      );
    }
    upstreamUrl = parsed;
    sources.upstreamUrl = 'env';
  } else {
    const fileValue = fromFileResolved.upstreamUrl;
    if (fileValue !== undefined && fileValue.kind === 'string') {
      const parsed = parseUrl(fileValue.value);
      if (parsed === null) {
        throw new Error(
          `config.json: upstreamUrl must be an http(s) URL, got ${JSON.stringify(fileValue.value)}`,
        );
      }
      upstreamUrl = parsed;
      sources.upstreamUrl = 'file';
    } else {
      upstreamUrl = DEFAULTS.upstreamUrl;
      sources.upstreamUrl = 'default';
    }
  }

  // ---- insecureTls ----
  let insecureTls: boolean;
  if (env.INSECURE_TLS !== undefined && env.INSECURE_TLS !== '') {
    insecureTls = parseBoolean(env.INSECURE_TLS);
    sources.insecureTls = 'env';
  } else {
    const fileValue = fromFileResolved.insecureTls;
    if (fileValue !== undefined && fileValue.kind === 'boolean') {
      insecureTls = fileValue.value;
      sources.insecureTls = 'file';
    } else {
      insecureTls = DEFAULTS.insecureTls;
      sources.insecureTls = 'default';
    }
  }

  // ---- logDir ----
  let logDir: string;
  if (env.LOG_DIR !== undefined && env.LOG_DIR.length > 0) {
    logDir = resolve(env.LOG_DIR);
    sources.logDir = 'env';
  } else {
    const fileValue = fromFileResolved.logDir;
    if (fileValue !== undefined && fileValue.kind === 'string' && fileValue.value.length > 0) {
      logDir = resolve(fileValue.value);
      sources.logDir = 'file';
    } else {
      logDir = DEFAULTS.logDir;
      sources.logDir = 'default';
    }
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