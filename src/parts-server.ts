/** Serves the parts and atlas view (#348): the page, its bundle, the part and page images by index, and the sign-off. */
import { PNG } from 'pngjs';
import { readFile } from 'node:fs/promises';
import { appRoot, buildWeb, setupEntryHtml } from './build.ts';
import { accessGate } from './open-protocol.ts';
import { createLiveLifecycle, LIVE_PATH, type LiveExitInfo, type UpgradableServer } from './live-lifecycle.ts';
import {preparePartsComment} from './parts-comment-crops.ts';
import {serveReference} from './reference.ts';
import { partsDifference, partsViewJson, exportPartsVerdict, assertPartsUnchanged, readVerdict, saveVerdictWithReceipt, servedImage, type PartsViewPackage, type PartsSaveReceipt } from './parts-view.ts';

const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const BODY_LIMIT = 4 * 1024 * 1024;

async function bodyJson(req: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type') ?? '')) throw new Error('Expected application/json');
  const reader = req.body?.getReader();
  if (!reader) return JSON.parse('');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) {
        await reader.cancel().catch(() => {});
        throw new Error('Verdict payload exceeds 4 MiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

export interface PartsSavedEvent extends PartsSaveReceipt { saveCount: number }
export interface PartsServerOptions {
  port?: number; capability?: string; exitOnClose?: boolean; graceMs?: number; unopenedTimeoutMs?: number;
  onClose?: (info: LiveExitInfo) => void | Promise<void>; log?: (line: string) => void;
  by?: string;
  onSaved?: (event: PartsSavedEvent) => Promise<void>;
  onNotifyFailure?: (error: Error) => void;
  onWriteFailure?: (error: Error) => void;
}

export async function startPartsServer(pkg: PartsViewPackage, options: PartsServerOptions = {}) {
  const by = options.by;
  if (by !== undefined && (typeof by !== 'string' || !by.trim())) throw new Error('PARTS_VERDICT_INVALID: reviewer name must be nonblank');
  const bundle = await buildWeb();
  const page = await setupEntryHtml('parts');
  let rawStop: ((closeActiveConnections?: boolean) => void) | null = null;
  let pendingSaves = 0, saveCount = 0;
  let saveQueue: Promise<void> = Promise.resolve();
  let closing = false;
  let notifyFailure: Error | null = null;
  const live = createLiveLifecycle({ label: 'review parts', graceMs: options.graceMs, unopenedTimeoutMs: options.unopenedTimeoutMs, exitOnClose: options.exitOnClose, onClose: options.onClose, log: options.log, busy: () => pendingSaves > 0, stopServer: () => { rawStop?.(true); } });
  const save = (req: Request) => {
    if (closing) throw new Error('PARTS_VERDICT_WRITE_FAILED: server is closing');
    pendingSaves++;
    const result = saveQueue.then(async () => {
      if (notifyFailure) throw notifyFailure;
      if (saveCount === Number.MAX_SAFE_INTEGER) throw new Error('PARTS_VERDICT_WRITE_FAILED: save count exhausted');
      const {verdict, receipt} = await saveVerdictWithReceipt(pkg, await bodyJson(req), undefined, by);
      const event = {...receipt, saveCount: ++saveCount};
      try { await options.onSaved?.(event); }
      catch (error) {
        notifyFailure = new Error('PARTS_VERDICT_NOTIFY_FAILED: durable save notification failed', {cause: error});
        options.onNotifyFailure?.(notifyFailure);
        throw notifyFailure;
      }
      return verdict;
    });
    saveQueue = result.then(() => {}, error => {
      if (error instanceof Error && error.message.startsWith('PARTS_VERDICT_WRITE_FAILED:')) options.onWriteFailure?.(error);
    }).finally(() => { pendingSaves--; });
    return result;
  };
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
        // A parts subject has its own identity and verdict; never synthesize a rig manifest or session.
        if (req.method === 'GET' && ['/api/review','/api/session','/api/access'].includes(url.pathname)) {
          await assertPartsUnchanged(pkg);
          if(url.pathname==='/api/access')return json({capabilityRequired:!!options.capability,control:false});
          const saved=await readVerdict(pkg);
          if(url.pathname==='/api/session')return json({subject:'parts',issues:saved.verdict?.issues??saved.legacy?.issues??[]});
          return json({subject:'parts',parts:partsViewJson(pkg,saved)});
        }
        if (url.pathname === '/api/parts' && req.method === 'GET'){await assertPartsUnchanged(pkg);return json(partsViewJson(pkg,await readVerdict(pkg)));}
        if(url.pathname==='/api/parts/comment'&&req.method==='POST'){if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);await assertPartsUnchanged(pkg);return json({comment:await preparePartsComment(pkg,await bodyJson(req))});}
        if(url.pathname==='/api/parts/export'&&req.method==='GET'){await assertPartsUnchanged(pkg);const saved=await readVerdict(pkg);if(!saved.verdict)return json({error:'PARTS_VERDICT_UNAVAILABLE: save a verdict first'},409);return new Response(exportPartsVerdict(saved.verdict,url.searchParams.get('format')==='issue'?'issue':'json'),{headers:{...headers,'Content-Type':url.searchParams.get('format')==='issue'?'text/markdown':'application/json'}});}
        if (url.pathname === '/api/parts/verdict' && req.method === 'POST') {
          if (req.headers.get('origin') !== origin) return json({ error: 'Same-origin Origin required' }, 403);
          return json({ verdict: await save(req) });
        }
        if(url.pathname==='/api/parts/painting'&&req.method==='GET'){if(!pkg.painting)return json({error:'PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting'},404);return serveReference(req,pkg.painting.abs,pkg.painting.sha256,headers);}
        const difference=/^\/api\/parts\/difference\/(\d+)$/.exec(url.pathname);
        if(difference&&req.method==='GET'){
          const t=url.searchParams.get('threshold'),f=url.searchParams.get('footprints');
          if(!t||!/^\d{1,3}$/.test(t)||!['true','false'].includes(f??''))throw new Error('PARTS_COMPARISON_INVALID: threshold and footprints required');
          const r=await partsDifference(pkg,Number(difference[1]),Number(t),f==='true');
          const png=new PNG({width:r.width,height:r.height});png.data=Buffer.from(r.data);
          return new Response(new Uint8Array(PNG.sync.write(png)),{headers:{...headers,'Content-Type':'image/png','X-Difference-Count':String(r.count),'X-Difference-Covered':String(r.covered),'X-Difference-Compared':String(r.compared)}});
        }
        const image = /^\/api\/parts\/(image|page)\/(\d+)$/.exec(url.pathname);
        if (image && (req.method === 'GET' || req.method === 'HEAD')) {
          const path = servedImage(pkg, image[1] as 'image' | 'page', Number(image[2]));
          if (!path) return json({ error: 'Not found' }, 404);
          const pinned=pkg.files.find(f=>f.abs===path);if(!pinned)return json({error:'PARTS_IMAGE_UNBOUND'},409);return serveReference(req,path,pinned.sha256,headers);

        }
        const read=req.method==='GET'||req.method==='HEAD';
        if(read&&url.pathname==='/parts.html')return new Response(null,{status:302,headers:{...headers,Location:'/'+url.search}});
        if(read&&url.pathname==='/main.js')return new Response(req.method==='HEAD'?null:bundle,{headers:{...headers,'Content-Type':'text/javascript'}});
        if(read&&(url.pathname==='/'||url.pathname==='/index.html'))return new Response(req.method==='HEAD'?null:page,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
        if(read&&url.pathname==='/styles.css')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/styles.css'),{headers:{...headers,'Content-Type':'text/css'}});
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
  const shutdown = async () => {
    closing = true;
    await saveQueue;
    live.stop();
    await server.stop(false);
  };
  return Object.assign(server, { live, shutdown });
}
