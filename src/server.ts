// src/server.ts
//
// Builds the Express app. Two routes:
//   * POST /v1/messages  — parse JSON for logging, then forward.
//   * everything else    — forward verbatim, no logging.

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { logSystemPrompt, logTools } from './logger.js';
import { forwardRequest } from './forwarder.js';

export interface AppConfig {
  readonly upstreamUrl: string;
  readonly insecureTls: boolean;
  readonly logDir: string;
}

export interface ListenAddr {
  readonly port: number;
  readonly host: string;
}

type AsyncRequestHandler = (
  req: Request,
  res: Response,
) => Promise<void>;

/**
 * Wrap an async route handler so that rejected promises become 500
 * responses instead of unhandled promise rejections.
 */
function asyncRoute(handler: AsyncRequestHandler): express.RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write(
        `[prompttrace] uncaught route error: ${error.stack ?? error.message}\n`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', detail: error.message });
      } else {
        res.destroy(error);
      }
      void next;
    });
  };
}

/** Express types the raw body as `unknown` on `req` after our middleware. */
function rawBodyOf(req: Request): Buffer | undefined {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  if (raw instanceof Buffer) return raw;
  return undefined;
}

/**
 * Build the upstream URL by combining the configured upstream URL
 * (which may include a path) with the inbound path + query.
 *
 * The inbound path is whatever comes after the hostname on the
 * proxy listener — typically `/v1/messages` or `/v1/models`. We
 * forward it verbatim onto the configured upstream.
 */
function extractPathQuery(originalUrl: string): { path: string; query: string } {
  const qIdx = originalUrl.indexOf('?');
  if (qIdx === -1) {
    return { path: originalUrl, query: '' };
  }
  return {
    path: originalUrl.slice(0, qIdx),
    query: '?' + originalUrl.slice(qIdx + 1),
  };
}

/**
 * @param config  Proxy runtime config (only `upstreamUrl`,
 *                `insecureTls`, `logDir` are used here).
 */
export function createApp(config: AppConfig): Express {
  const app = express();
  // We capture the raw body ourselves for forwarding. The default
  // express.json() parser *consumes* the stream, so we use `verify`
  // to keep the buffer and skip parsing here — we parse in the
  // /v1/messages handler where we want rich error handling.
  app.use(
    express.json({
      limit: '50mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.post(
    '/v1/messages',
    asyncRoute(async (req, res) => {
      const requestId = randomUUID();
      const timestamp = new Date().toISOString();

      const rawBody = rawBodyOf(req);

      // Parse JSON defensively. The body might not be JSON — the CLI
      // could (in theory) hit this endpoint with something exotic.
      let parsed: unknown = null;
      if (rawBody && rawBody.length > 0) {
        try {
          parsed = JSON.parse(rawBody.toString('utf8'));
        } catch (err) {
          res.status(400).json({
            error: 'invalid_json',
            detail: (err as Error).message,
          });
          return;
        }
      }

      if (parsed !== null && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const payload = {
          requestId,
          timestamp,
          system: obj['system'],
          tools: obj['tools'],
          logDir: config.logDir,
        };
        // Fire and forget — logging must not block forwarding.
        Promise.all([logSystemPrompt(payload), logTools(payload)]).catch(
          (err: unknown) => {
            process.stderr.write(
              `[prompttrace] logger error: ${(err as Error).message}\n`,
            );
          },
        );
      }

      const { path, query } = extractPathQuery(req.originalUrl);

      // Forward to upstream. We pass the original raw body (Buffer)
      // untouched — the proxy is read-only on the payload (FR-7).
      await forwardRequest({
        upstreamOrigin: config.upstreamUrl,
        method: req.method,
        inboundPath: path,
        inboundQuery: query,
        headers: req.headers,
        rawBody: rawBody ?? null,
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
      const rawBody = rawBodyOf(req);
      const { path, query } = extractPathQuery(req.originalUrl);
      await forwardRequest({
        upstreamOrigin: config.upstreamUrl,
        method: req.method,
        inboundPath: path,
        inboundQuery: query,
        headers: req.headers,
        rawBody: rawBody ?? null,
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
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { type?: unknown; message?: unknown };
    if (e && e.type === 'entity.parse.failed') {
      res.status(400).json({
        error: 'invalid_json',
        detail: typeof e.message === 'string' ? e.message : 'malformed JSON',
      });
      return;
    }
    next(err);
  });

  return app;
}

/**
 * Start the app listening on the given address.
 */
export function listen(app: Express, addr: ListenAddr): Promise<Server> {
  return new Promise((resolveP) => {
    const server = app.listen(addr.port, addr.host, () => {
      resolveP(server);
    });
  });
}