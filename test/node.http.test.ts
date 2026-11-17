import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { HttpApp } from '../src/http/app.js';
import { serveHttp } from '../src/http/node.js';
import { createLogger } from '../src/logger.js';

/** Real sockets: these tests exercise the node:http adapter that production runs on. */

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

const errors: string[] = [];
const logger = createLogger({
  level: 'error',
  redact: (s) => s,
  write: (l) => errors.push(l),
});

async function start(app: HttpApp) {
  const server = await serveHttp(app, { host: '127.0.0.1', port: 0, logger });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

const appOf = (fetch: HttpApp['fetch']): HttpApp => ({ fetch, close: async () => {} });

describe('serveHttp over a real socket', () => {
  it('translates requests: method, path, headers and body reach the app', async () => {
    let seen: { method: string; url: string; headers: Headers; body: string } | undefined;
    const { base } = await start(
      appOf(async (req) => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: await req.text() };
        return Response.json({ ok: true }, { status: 201, headers: { 'x-extra': 'yes' } });
      }),
    );
    const res = await fetch(`${base}/mcp?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer abc', 'x-multi': 'a' },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-extra')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
    expect(seen?.method).toBe('POST');
    expect(new URL(seen?.url ?? '').pathname + new URL(seen?.url ?? '').search).toBe('/mcp?x=1');
    expect(seen?.headers.get('authorization')).toBe('Bearer abc');
    expect(seen?.body).toBe('{"hello":"world"}');
  });

  it('serves GET without a body and responses without a body', async () => {
    const { base } = await start(
      appOf(async (req) => {
        expect(req.method).toBe('GET');
        return new Response(null, { status: 204 });
      }),
    );
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('joins repeated request headers', async () => {
    let value: string | null = null;
    const { base } = await start(
      appOf(async (req) => {
        value = req.headers.get('accept');
        return new Response('ok');
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const r = httpRequest(
        `${base}/`,
        { headers: { Accept: ['text/plain', 'application/json'] } },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      r.on('error', reject);
      r.end();
    });
    expect(value).toContain('text/plain');
  });

  it('streams response chunks as they are produced', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { base } = await start(
      appOf(async () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('event: first\n\n'));
            await gate; // the second chunk only exists after the client saw the first
            controller.enqueue(new TextEncoder().encode('event: second\n\n'));
            controller.close();
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    const res = await fetch(`${base}/stream`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('event: first\n\n');
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('event: second\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('aborts the app request when the client disconnects mid-stream', async () => {
    let aborted: () => void = () => {};
    const sawAbort = new Promise<void>((r) => (aborted = r));
    const { base } = await start(
      appOf(async (req) => {
        req.signal.addEventListener('abort', () => aborted());
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('hello\n'));
            // never closes: the client has to hang up
          },
        });
        return new Response(body);
      }),
    );
    const controller = new AbortController();
    const res = await fetch(`${base}/slow`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    controller.abort();
    await expect(sawAbort).resolves.toBeUndefined();
  });

  it('answers 500 and logs when the app throws', async () => {
    errors.length = 0;
    const { base } = await start(
      appOf(async () => {
        throw new Error('boom');
      }),
    );
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(errors.join('')).toContain('http adapter error');
    expect(errors.join('')).toContain('boom');
  });

  it('survives the app throwing a non-Error and keeps serving', async () => {
    errors.length = 0;
    let calls = 0;
    const { base } = await start(
      appOf(async () => {
        calls++;
        if (calls === 1) throw 'plain string';
        return new Response('fine');
      }),
    );
    expect((await fetch(`${base}/`)).status).toBe(500);
    expect(errors.join('')).toContain('plain string');
    expect(await (await fetch(`${base}/`)).text()).toBe('fine');
  });

  it('sets slow-client protections', async () => {
    const { server } = await start(appOf(async () => new Response('ok')));
    expect(server.headersTimeout).toBe(30_000);
    expect(server.requestTimeout).toBe(300_000);
  });

  it('serves a real MCP client end to end through the adapter', async () => {
    // A minimal MCP-over-HTTP app is covered by test/http.integration.test.ts; here we only
    // prove the adapter carries a real Streamable HTTP client's traffic (POST + SSE) intact.
    const { createMcpHandler, McpServer } = await import('@modelcontextprotocol/server');
    const { z } = await import('zod');
    const handler = createMcpHandler(() => {
      const s = new McpServer(
        { name: 'adapter-test', version: '1' },
        { capabilities: { tools: {} } },
      );
      s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `echo:${text}` }],
      }));
      return s;
    });
    const { base } = await start(appOf((req) => handler.fetch(req)));
    const client = new Client({ name: 'real-socket-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/`)));
    clients.push(client);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['echo']);
    const r = (await client.callTool({ name: 'echo', arguments: { text: 'hi' } })) as {
      content: { text: string }[];
    };
    expect(r.content[0]?.text).toBe('echo:hi');
  });
});
