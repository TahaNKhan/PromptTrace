#!/usr/bin/env node
// prompttrace.mjs — entry point.
//
// Usage:
//   node prompttrace.mjs
//
// Env vars (see README.md for the full table):
//   PORT              default 8080
//   HOST              default 127.0.0.1
//   UPSTREAM_URL      default https://api.minimax.io/anthropic
//   INSECURE_TLS      default 0 — set to 1 to skip upstream cert verification
//   PROMPTTRACE_CONFIG  path to a non-default config.json

import process from 'node:process';
import { loadConfig } from './src/config.mjs';
import { createApp, listen } from './src/server.mjs';

async function main() {
  const config = loadConfig();
  const app = createApp(config);

  const server = await listen(app, { port: config.port, host: config.host });

  const configLoaded =
    config.sources.upstreamUrl !== 'default' ||
    config.sources.port !== 'default' ||
    config.sources.host !== 'default' ||
    config.sources.logDir !== 'default';

  process.stdout.write(
    `\n[prompttrace] listening on http://${config.host}:${config.port}\n` +
      `[prompttrace] forwarding to ${config.upstreamUrl}\n` +
      `[prompttrace] logs: ${config.logDir}/system_prompt.txt, ${config.logDir}/tools.jsonl\n` +
      (configLoaded
        ? `[prompttrace] config: ${config.configPath} ` +
          `(upstreamUrl=${config.sources.upstreamUrl}, port=${config.sources.port}, ` +
          `host=${config.sources.host}, logDir=${config.sources.logDir})\n`
        : `[prompttrace] config: using built-in defaults (no config.json found)\n`) +
      `\n[prompttrace] point your CLI here with:\n` +
      `  ANTHROPIC_BASE_URL=http://localhost:${config.port}\n\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[prompttrace] received ${signal}, shutting down…\n`);
    // Stop accepting new connections; let in-flight requests finish for
    // up to 2 s, then force-close.
    server.close((err) => {
      if (err) {
        process.stderr.write(`[prompttrace] close error: ${err.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    });
    setTimeout(() => {
      process.stderr.write('[prompttrace] shutdown timeout — forcing exit\n');
      process.exit(1);
    }, 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    process.stderr.write(
      `[prompttrace] uncaughtException: ${err.stack ?? err.message}\n`,
    );
    // Don't exit — a single bad request shouldn't take the whole proxy down.
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[prompttrace] unhandledRejection: ${
        reason instanceof Error ? reason.stack : String(reason)
      }\n`,
    );
  });
}

main().catch((err) => {
  process.stderr.write(`[prompttrace] fatal: ${err.stack ?? err.message}\n`);
  process.exit(1);
});