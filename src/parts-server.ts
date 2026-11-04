/** Serves the parts and atlas view (#348): the page, its bundle, the part and page images by index, and the sign-off. */
import { readFile } from 'node:fs/promises';
import { appRoot, buildWeb } from './build.ts';
import { accessGate } from './open-protocol.ts';
import { createLiveLifecycle, LIVE_PATH, type LiveExitInfo, type UpgradableServer } from './live-lifecycle.ts';
import { partsViewJson, readVerdict, saveVerdict, servedImage, type PartsViewPackage } from './parts-view.ts';

const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const BODY_LIMIT = 4 * 1024 * 1024;

async function bodyJson(req: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw new Error('Expected application/json');
  const text = await req.text();
  if (text.length > BODY_LIMIT) throw new Error('Verdict payload exceeds 4 MiB');
  return JSON.parse(text);
}

export interface PartsServerOptions { port?: number; capability?: string; exitOnClose?: boolean; graceMs?: number; unopenedTimeoutMs?: number; onClose?: (info: LiveExitInfo) => void | Promise<void>; log?: (line: string) => void }

export async function startPartsServer(pkg: PartsViewPackage, options: PartsServerOptions = {}) {
  const bundle = await buildWeb('parts');
  let rawStop: ((closeActiveConnections?: boolean) => void) | null = null;
  let saving = false;
  const live = createLiveLifecycle({ label: 'review parts', graceMs: options.graceMs, unopenedTimeoutMs: options.unopenedTimeoutMs, exitOnClose: options.exitOnClose, onClose: options.onClose, log: options.log, busy: () => saving, stopServer: () => { rawStop?.(true); } });
  const handle = async (req: Request, port: number | undefined, srv: UpgradableServer): Promise<Response | undefined> => {
    try {
      const url = new URL(req.url), origin = `http://127.0.0.1:${port}`;
      if (url.origin !== origin) return json({ error: 'Loopback host required' }, 403);
      const refused = accessGate(req, options.capability);
      if (refused) return refused;
      if (req.method === 'GET' && url.pathname === LIVE_PATH) {
        if (req.headers.get('origin') !== origin) return json({ error: 'Same-origin Origin required' }, 403);
        return live.upgrade(req, srv, headers);
      }
      live.onRequestStart(url.pathname);
      try {
        if (url.pathname === '/api/parts' && req.method === 'GET') return json(partsViewJson(pkg, await readVerdict(pkg)));
        if (url.pathname === '/api/parts/verdict' && req.method === 'POST') {
          if (req.headers.get('origin') !== origin) return json({ error: 'Same-origin Origin required' }, 403);
          saving = true;
          try { return json({ verdict: await saveVerdict(pkg, await bodyJson(req)) }); } finally { saving = false; }
        }
        const image = /^\/api\/parts\/(image|page)\/(\d+)$/.exec(url.pathname);
        if (image && (req.method === 'GET' || req.method === 'HEAD')) {
          const path = servedImage(pkg, image[1] as 'image' | 'page', Number(image[2]));
          if (!path) return json({ error: 'Not found' }, 404);
          const file = Bun.file(path);
          return new Response(req.method === 'HEAD' ? null : file, { headers: { ...headers, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Type': file.type || 'application/octet-stream' } });
        }
        if (url.pathname === '/parts.js') return new Response(req.method === 'HEAD' ? null : bundle, { headers: { ...headers, 'Content-Type': 'text/javascript' } });
        if (url.pathname === '/' || url.pathname === '/parts.html') return new Response(req.method === 'HEAD' ? null : await readFile(appRoot + 'web/parts.html'), { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
        if (url.pathname === '/parts.css') return new Response(req.method === 'HEAD' ? null : await readFile(appRoot + 'web/parts.css'), { headers: { ...headers, 'Content-Type': 'text/css' } });
        return json({ error: 'Not found' }, 404);
      } finally { live.onRequestEnd(url.pathname); }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Request failed';
      return json({ error: message }, message.startsWith('PARTS_VIEW_SOURCE_CHANGED') ? 409 : 400);
    }
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: options.port ?? 4317, websocket: live.websocket, async fetch(req, srv) { const res = await handle(req, srv.port, srv); return res as Response; } });
  rawStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => { live.stop(); return rawStop!(closeActiveConnections); }) as typeof server.stop;
  return Object.assign(server, { live });
}
