// src/server.mjs
//
// Builds the Express app. Two routes:
//   * POST /v1/messages  — parse JSON for logging, then forward.
//   * everything else    — forward verbatim, no logging.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { logSystemPrompt, logTools } from './logger.mjs';
import { forwardRequest } from './forwarder.mjs';

/**
 * Wrap an async route handler so that rejected promises become 500
 * responses instead of unhandled promise rejections.
 */
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      process.stderr.write(
        `[prompttrace] uncaught route error: ${err.stack ?? err.message}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', detail: err.message });
      } else {
        res.destroy(err);
      }
    });
  };
}

/**
 * @param {{
 *   upstreamUrl: string,
 *   insecureTls: boolean,
 * }} config
 */
export function createApp(config) {
  const app = express();
  // We capture the raw body ourselves for forwarding. The default
  // express.json() parser *consumes* the stream, so we use `verify`
  // to keep the buffer and skip parsing here — we parse in the
  // /v1/messages handler where we want rich error handling.
  app.use(
    express.json({
      limit: '50mb',
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    }),
  );

  app.post(
    '/v1/messages',
    asyncRoute(async (req, res) => {
      const requestId = randomUUID();
      const timestamp = new Date().toISOString();

      const rawBody = /** @type {Buffer | undefined} */ (req.rawBody);

      // Parse JSON defensively. The body might not be JSON — the CLI
      // could (in theory) hit this endpoint with something exotic.
      let parsed = null;
      if (rawBody && rawBody.length > 0) {
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch (err) {
          res.status(400).json({
            error: 'invalid_json',
            detail: err.message,
          });
          return;
        }
      }

      if (parsed && typeof parsed === 'object') {
        const payload = {
          requestId,
          timestamp,
          system: parsed.system,
          tools: parsed.tools,
          logDir: config.logDir,
        };
        // Fire and forget — logging must not block forwarding.
        Promise.all([logSystemPrompt(payload), logTools(payload)]).catch(
          (err) => {
            process.stderr.write(
              `[prompttrace] logger error: ${err.message}\n`,
            );
          },
        );
      }

      // Forward to upstream. We pass the original raw body (Buffer)
      // untouched — the proxy is read-only on the payload (FR-7).
      await forwardRequest({
        upstreamOrigin: config.upstreamUrl,
        method: req.method,
        inboundPath: req.path,
        inboundQuery: req.originalUrl.includes('?')
          ? '?' + req.originalUrl.split('?').slice(1).join('?')
          : '',
        headers: req.headers,
        rawBody: rawBody ?? null,
        req,
        res,
        insecureTls: config.insecureTls,
        requestId,
      });
    }),
  );

  // Catch-all passthrough: forward anything that isn't POST /v1/messages
  // verbatim, no logging. This keeps the proxy from breaking other
  // Anthropic endpoints (e.g. /v1/models, /v1/messages/batches).
  app.all(
    '*',
    asyncRoute(async (req, res) => {
      const requestId = randomUUID();
      const rawBody = /** @type {Buffer | undefined} */ (req.rawBody);
      await forwardRequest({
        upstreamOrigin: config.upstreamUrl,
        method: req.method,
        inboundPath: req.path,
        inboundQuery: req.originalUrl.includes('?')
          ? '?' + req.originalUrl.split('?').slice(1).join('?')
          : '',
        headers: req.headers,
        rawBody: rawBody ?? null,
        req,
        res,
        insecureTls: config.insecureTls,
        requestId,
      });
    }),
  );

  // Body-parser error handler: express.json() throws a SyntaxError on
  // malformed JSON. We catch it here and return a JSON 400 instead of
  // Express's default HTML error page. Anything else falls through to
  // Express's default handler.
  app.use((err, _req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      res.status(400).json({
        error: 'invalid_json',
        detail: err.message,
      });
      return;
    }
    next(err);
  });

  return app;
}

/**
 * @param {import('express').Express} app
 * @param {{ port: number, host: string }} addr
 */
export function listen(app, addr) {
  return new Promise((resolveP) => {
    const server = app.listen(addr.port, addr.host, () => {
      resolveP(server);
    });
  });
}