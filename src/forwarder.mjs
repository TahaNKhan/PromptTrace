// src/forwarder.mjs
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
import { HOP_BY_HOP_HEADERS } from './config.mjs';

/**
 * Build the upstream URL by combining the configured upstream origin
 * with the inbound path + query.
 *
 * @param {string} upstreamOrigin e.g. 'https://api.anthropic.com'
 * @param {string} inboundPath    e.g. '/v1/messages'
 * @param {string} [inboundQuery]  e.g. '?beta=foo'
 */
export function buildUpstreamUrl(upstreamOrigin, inboundPath, inboundQuery = '') {
  const origin = upstreamOrigin.replace(/\/+$/, '');
  const path = inboundPath.startsWith('/') ? inboundPath : `/${inboundPath}`;
  return `${origin}${path}${inboundQuery ?? ''}`;
}

/**
 * Filter headers: lowercase keys, drop hop-by-hop, return a plain object.
 *
 * @param {NodeJS.Dict<string | string[]>} inbound
 */
function filterRequestHeaders(inbound) {
  const out = {};
  for (const [key, value] of Object.entries(inbound)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = value;
  }
  return out;
}

/**
 * Copy upstream response headers to the client, stripping hop-by-hop.
 *
 * @param {Headers} upstreamHeaders
 * @param {import('express').Response} res
 */
function pipeResponseHeaders(upstreamHeaders, res) {
  for (const [key, value] of upstreamHeaders.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
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
 *
 * @param {{
 *   upstreamOrigin: string,
 *   method: string,
 *   inboundPath: string,
 *   inboundQuery: string,
 *   headers: NodeJS.Dict<string | string[]>,
 *   rawBody: Buffer | null,
 *   req: import('express').Request,
 *   res: import('express').Response,
 *   insecureTls: boolean,
 *   requestId: string,
 * }} args
 * @returns {Promise<void>} resolves when the stream finishes or fails.
 */
export async function forwardRequest(args) {
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

  /** @type {RequestInit} */
  const init = {
    method,
    headers: filteredHeaders,
    signal: controller.signal,
  };

  if (rawBody && rawBody.length > 0 && method !== 'GET' && method !== 'HEAD') {
    init.body = rawBody;
    // undici requires `duplex: 'half'` whenever a streaming body is set;
    // a Buffer is fine, but the option is harmless and future-proof.
    init.duplex = 'half';
  }

  if (insecureTls) {
    // Disable cert verification. This is a last resort and triggers the
    // startup warning in config.mjs.
    const { Agent } = await import('node:https');
    init.agent = new Agent({ rejectUnauthorized: false });
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    if (!res.headersSent) {
      const detail = err.name === 'AbortError' ? 'client_disconnected' : err.message;
      const status = err.name === 'AbortError' ? 499 : 502;
      res.status(status).json({
        error: err.name === 'AbortError' ? 'client_disconnected' : 'upstream_unreachable',
        detail,
      });
    } else {
      res.destroy(err);
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

  const nodeStream = Readable.fromWeb(response.body);
  nodeStream.pipe(res);

  await new Promise((resolveP) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolveP();
    };
    nodeStream.on('end', finish);
    nodeStream.on('close', finish);
    nodeStream.on('error', (err) => {
      process.stderr.write(
        `[prompttrace] upstream stream error — ${requestId}: ${err.message}\n`,
      );
      finish();
    });
    res.on('error', (err) => {
      process.stderr.write(
        `[prompttrace] client socket error — ${requestId}: ${err.message}\n`,
      );
      finish();
    });
  });

  // If the upstream finished but res was destroyed (e.g. the client
  // bailed after the last chunk), make sure we don't try to end it.
  if (clientGone) return;
  if (!res.writableEnded) {
    res.end();
  }
}