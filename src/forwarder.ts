// src/forwarder.ts
//
// Streams a request from the inbound HTTP response (Express `req`/`res`)
// to an upstream URL and pipes the upstream response back to `res`.
//
// Important design points:
//   * The inbound body is consumed ONCE — we keep it as a Buffer that
//     was captured by the server's raw-body parser. We never re-parse
//     it here; the server has already done that for logging.
//   * The upstream response is streamed via `Readable.fromWeb`. We
//     MUST NOT `await response.text()` or `await response.json()` —
//     that would buffer the entire SSE stream and break the CLI.
//   * Client disconnect is detected via `res.on('close')` plus a
//     `writableEnded` check. We deliberately do NOT use
//     `req.on('close')`: in Node 18+ that event fires as soon as the
//     request body has been consumed (which happens during JSON
//     parsing), BEFORE the response is sent — using it would abort
//     every request immediately.
//   * Hop-by-hop headers are stripped in both directions.

import { Readable } from 'node:stream';
import type { Agent as HttpsAgent } from 'node:https';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { HOP_BY_HOP_HEADERS } from './config.js';

export interface ForwardRequestArgs {
  readonly upstreamOrigin: string;
  readonly method: string;
  readonly inboundPath: string;
  readonly inboundQuery: string;
  readonly headers: ExpressRequest['headers'];
  readonly rawBody: Buffer | null;
  readonly res: ExpressResponse;
  readonly insecureTls: boolean;
  readonly requestId: string;
}

/**
 * Build the upstream URL by combining the configured upstream origin
 * with the inbound path + query.
 */
export function buildUpstreamUrl(
  upstreamOrigin: string,
  inboundPath: string,
  inboundQuery = '',
): string {
  const origin = upstreamOrigin.replace(/\/+$/, '');
  const path = inboundPath.startsWith('/') ? inboundPath : `/${inboundPath}`;
  return `${origin}${path}${inboundQuery}`;
}

type HeaderValue = string | string[];
type FilteredHeaders = Record<string, HeaderValue>;

/**
 * Filter headers: lowercase keys, drop hop-by-hop, return a plain object.
 */
function filterRequestHeaders(
  inbound: ExpressRequest['headers'],
): FilteredHeaders {
  const out: FilteredHeaders = {};
  for (const [key, value] of Object.entries(inbound)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = value;
  }
  return out;
}

const HOP_BY_HOP = HOP_BY_HOP_HEADERS;

/**
 * Copy upstream response headers to the client, stripping hop-by-hop.
 */
function pipeResponseHeaders(
  upstreamHeaders: Headers,
  res: ExpressResponse,
): void {
  // undici's Headers is iterable as [string, string][].
  for (const [key, value] of upstreamHeaders as unknown as Iterable<readonly [string, string]>) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    // Native fetch transparently decompresses gzip and leaves the
    // Content-Encoding header in place. Strip it so the client sees
    // plain-text SSE.
    if (key.toLowerCase() === 'content-encoding') continue;
    res.setHeader(key, value);
  }
}

/**
 * Forward an inbound request to the upstream URL and stream the
 * response back to `res`.
 */
export async function forwardRequest(args: ForwardRequestArgs): Promise<void> {
  const {
    upstreamOrigin,
    method,
    inboundPath,
    inboundQuery,
    headers,
    rawBody,
    res,
    insecureTls,
    requestId,
  } = args;

  const url = buildUpstreamUrl(upstreamOrigin, inboundPath, inboundQuery);
  const filteredHeaders = filterRequestHeaders(headers);

  const controller = new AbortController();

  const baseInit: RequestInit = {
    method,
    headers: filteredHeaders as unknown as Headers,
    signal: controller.signal,
  };

  const hasBody =
    rawBody !== null && rawBody.length > 0 && method !== 'GET' && method !== 'HEAD';

  // undici requires `duplex: 'half'` whenever a streaming body is set;
  // a Buffer is fine, but the option is harmless and future-proof.
  // We cast through `any`-equivalent because the DOM-flavored
  // RequestInit doesn't know about `body` being a Buffer or about
  // `duplex`. Both are valid at runtime under undici.
  type UndiciInit = RequestInit & { body?: unknown; duplex?: 'half' | 'full' };
  const init: RequestInit = (
    hasBody
      ? { ...baseInit, body: rawBody, duplex: 'half' as const }
      : baseInit
  ) as UndiciInit as RequestInit;

  if (insecureTls) {
    // Disable cert verification. This is a last resort and triggers the
    // startup warning in config.ts.
    const { Agent } = await import('node:https');
    const agent = new Agent({ rejectUnauthorized: false });
    // `RequestInit` in @types/node doesn't expose `agent` directly —
    // it's an undici extension. Cast through unknown to attach it.
    (init as RequestInit & { agent: HttpsAgent }).agent = agent;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const error = err as Error;
    if (!res.headersSent) {
      const isAbort = error.name === 'AbortError';
      const detail = isAbort ? 'client_disconnected' : error.message;
      const status = isAbort ? 499 : 502;
      res.status(status).json({
        error: isAbort ? 'client_disconnected' : 'upstream_unreachable',
        detail,
      });
    } else {
      res.destroy(error);
    }
    return;
  }

  res.status(response.status);
  pipeResponseHeaders(response.headers, res);

  if (!response.body) {
    res.end();
    return;
  }

  // Client-disconnect detection: `res.on('close')` fires after the
  // response stream is closed — either because the client went away
  // (writableEnded still false) or because we ended normally
  // (writableEnded true). We only abort the upstream on the former.
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
      process.stderr.write(
        `[prompttrace] client disconnected mid-request — ${requestId}\n`,
      );
    }
  });

  const nodeStream = Readable.fromWeb(
    response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  nodeStream.pipe(res);

  await new Promise<void>((resolveP) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolveP();
    };
    nodeStream.on('end', finish);
    nodeStream.on('close', finish);
    nodeStream.on('error', (err: Error) => {
      process.stderr.write(
        `[prompttrace] upstream stream error — ${requestId}: ${err.message}\n`,
      );
      finish();
    });
    res.on('error', (err: Error) => {
      process.stderr.write(
        `[prompttrace] client socket error — ${requestId}: ${err.message}\n`,
      );
      finish();
    });
  });

  if (clientGone) return;
  if (!res.writableEnded) {
    res.end();
  }
}