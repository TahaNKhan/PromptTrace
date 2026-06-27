#!/usr/bin/env node
// prompttrace.ts — entry point.
//
// Usage:
//   npx tsx prompttrace.ts
//
// Env vars (see README.md for the full table):
//   PORT                default 8080
//   HOST                default 127.0.0.1
//   UPSTREAM_URL        default https://api.anthropic.com
//   INSECURE_TLS        default 0 — set to 1 to skip upstream cert verification
//   PROMPTTRACE_CONFIG  path to a non-default config.json

import process from 'node:process';
import type { Server } from 'node:http';
import { loadConfig } from './src/config.js';
import { createApp, listen } from './src/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);

  const server: Server = await listen(app, { port: config.port, host: config.host });

  const configLoaded =
    config.sources.upstreamUrl !== 'default' ||
    config.sources.port !== 'default' ||
    config.sources.host !== 'default' ||
    config.sources.logDir !== 'default';

  const banner =
    `\n[prompttrace] listening on http://${config.host}:${config.port}\n` +
    `[prompttrace] forwarding to ${config.upstreamUrl}\n` +
    `[prompttrace] logs: ${config.logDir}/system_prompt.txt, ${config.logDir}/tools.jsonl\n` +
    (configLoaded
      ? `[prompttrace] config: ${config.configPath} ` +
        `(upstreamUrl=${config.sources.upstreamUrl}, port=${config.sources.port}, ` +
        `host=${config.sources.host}, logDir=${config.sources.logDir})\n`
      : `[prompttrace] config: using built-in defaults (no config.json found)\n`) +
    `\n[prompttrace] point your CLI here with:\n` +
    `  ANTHROPIC_BASE_URL=http://localhost:${config.port}\n\n`;
  process.stdout.write(banner);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n[prompttrace] received ${signal}, shutting down…\n`);
    server.close((err: Error | undefined) => {
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

  process.on('uncaughtException', (err: Error) => {
    process.stderr.write(
      `[prompttrace] uncaughtException: ${err.stack ?? err.message}\n`,
    );
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const message =
      reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`[prompttrace] unhandledRejection: ${message}\n`);
  });
}

main().catch((err: unknown) => {
  const error = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(`[prompttrace] fatal: ${error.stack ?? error.message}\n`);
  process.exit(1);
});