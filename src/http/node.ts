import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Logger } from '../logger.js';
import type { HttpApp } from './app.js';

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method ?? 'GET',
    headers,
    signal,
    ...(hasBody && { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' }),
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  // Stream chunk by chunk so server-sent events reach the client as they happen.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
}

/** Serves a fetch-style app on node:http. */
export function serveHttp(
  app: HttpApp,
  opts: { host: string; port: number; logger: Logger },
): Promise<Server> {
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    app
      .fetch(toRequest(req, controller.signal))
      .then((response) => writeResponse(res, response))
      .catch((err) => {
        opts.logger.error('http adapter error', {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"server_error"}');
      });
  });
  // Slow-client protections.
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  return new Promise((resolve) => server.listen(opts.port, opts.host, () => resolve(server)));
}
