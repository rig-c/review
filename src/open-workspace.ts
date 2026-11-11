import {randomBytes, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile, unlink} from 'node:fs/promises';
import {appRoot, buildWeb} from './build.ts';
import {createReviewRequestContext} from './server.ts';
import {createCompareRequestContext} from './compare-server.ts';
import {createLiveLifecycle, type UpgradableServer} from './live-lifecycle.ts';
import {prepareOpenTarget} from './open.ts';
import {sameSecret} from './open-protocol.ts';
import {boundedBody, frontRoute, maximumUpstreamStreams} from './front.ts';
import {assertCompareUnchanged} from './compare.ts';
import {assertReviewUnchanged} from './reference.ts';
import {parseDesignation, parseRegistry, readPrivate, targetCapability, workspaceDirectory, workspaceError, writePrivate} from './open-workspace-state.ts';
import {WORKSPACE_BODY_LIMIT, WORKSPACE_REGISTRATION_QUEUE, WORKSPACE_SCHEMA, WORKSPACE_SOCKET_LIMIT,
  WORKSPACE_TARGET_LIMIT, WORKSPACE_TARGETS_SCHEMA, type WorkspaceDesignation, type WorkspaceList,
  type WorkspaceRecord, type WorkspaceStoredTarget, type WorkspaceTargetView} from './open-workspace-contract.ts';

type RequestContext = Awaited<ReturnType<typeof createReviewRequestContext>>;
interface Target {
  stored: WorkspaceStoredTarget;
  view: WorkspaceTargetView;
  context: RequestContext | null;
  check: (() => Promise<void>) | null;
}

const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
const json = (value: unknown, status = 200) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > WORKSPACE_BODY_LIMIT) throw workspaceError('WORKSPACE_BODY_LIMIT');
  return new Response(text, {status, headers: {...securityHeaders, 'Content-Type': 'application/json'}});
};
const refused = (code: string, status = 409) => json({error: code}, status);

export interface OpenWorkspaceOptions {
  stateDir: string;
  fingerprint: string;
  port: number;
  idleMs?: number;
  graceMs?: number;
}

/** One actual listener, with package contexts mounted in-process. */
export async function startOpenWorkspace(options: OpenWorkspaceOptions) {
  const directory = await workspaceDirectory(options.stateDir);
  const incarnation = randomUUID();
  const ownerCapability = randomBytes(32).toString('hex');
  const registrationCapability = randomBytes(32).toString('hex');
  let targets = new Map<string, Target>();
  let activeStreams = 0, registrations = 0, producing = false, accepting = true;
  let pending = Promise.resolve();
  let rawStop: ((close?: boolean) => void | Promise<void>) | undefined;
  let record: WorkspaceRecord;
  let stopPromise: Promise<void> | undefined;
  const bundles = new Map<'single' | 'compare', Promise<Blob>>();
  const ownerBundle = () => buildWeb('workspace');
  let ownerScript: Promise<Blob> | undefined;
  const busy = () => registrations > 0 || activeStreams > 0 || [...targets.values()].some(target => target.context?.busy());
  const live = createLiveLifecycle({label: 'review workspace', graceMs: options.graceMs,
    unopenedTimeoutMs: options.idleMs, busy, stopServer: () => stop(), log: line => console.error(line)});

  function list(): WorkspaceList {
    return {schema: WORKSPACE_SCHEMA, incarnation, targets: [...targets.values()].map(target => target.view)};
  }

  async function prepare(designation: WorkspaceDesignation): Promise<Target> {
    const prepared = await prepareOpenTarget(designation.inputs, {
      stateDir: options.stateDir, cwd: designation.cwd, viewOnly: designation.viewOnly,
    }, options.fingerprint);
    const loaded = prepared.package;
    if (prepared.key !== designation.key || loaded.contentHash !== designation.contentHash) throw workspaceError('WORKSPACE_SOURCE_CHANGED');
    const bundleMode=loaded.mode==='interview'?'single':loaded.mode;
    let bundle = bundles.get(bundleMode);
    if (!bundle) {bundle = buildWeb(bundleMode); bundles.set(bundleMode, bundle);}
    const controlToken = loaded.inputs.control ? randomUUID() : undefined;
    const contextOptions = {stateDir: options.stateDir, cwd: designation.cwd, lifecycle: live, bundle: await bundle,
      capability: targetCapability(ownerCapability, incarnation, designation.key),
      open: {key: designation.key, contentHash: designation.contentHash, nonce: incarnation, fingerprint: options.fingerprint},
      ...(controlToken ? {control: {token: controlToken, instanceKey: designation.key}} : {}),
    };
    const context = loaded.mode !== 'compare'
      ? await createReviewRequestContext(loaded.p, {...contextOptions, joined: loaded.joined,
        initialAnimation: loaded.selection?.name, viewOnly: designation.viewOnly})
      : await createCompareRequestContext(loaded.p, contextOptions);
    const check = () => loaded.mode === 'interview' ? loaded.joined.assertCurrent() : loaded.mode === 'single' ? assertReviewUnchanged(loaded.p) : assertCompareUnchanged(loaded.p);
    await check();
    return {stored: {designation, ...(controlToken ? {controlToken} : {})}, context, check,
      view: {key: designation.key, contentHash: designation.contentHash,
        title: (loaded.mode === 'interview' ? String(loaded.joined.opened.project.name??loaded.joined.opened.root.split('/').at(-1)) : loaded.mode === 'single' ? loaded.p.manifest.title : loaded.p.response.title).slice(0, 256),
        mode: loaded.mode==='interview'?'single' as const:loaded.mode, animation: loaded.selection?.name ?? null, viewOnly: designation.viewOnly, unavailable: null,
        entry: `/instances/${designation.key}/?input=${designation.contentHash}&handoff=${designation.key}&workspace=${incarnation}`}};
  }

  async function persist(next: Map<string, Target>) {
    await writePrivate(join(directory, 'targets.json'), {
      schema: WORKSPACE_TARGETS_SCHEMA, incarnation, targets: [...next.values()].map(target => target.stored),
    });
  }

  async function register(values: unknown) {
    if (!accepting) throw workspaceError('WORKSPACE_CLOSING');
    if (!Array.isArray(values) || !values.length || values.length > WORKSPACE_TARGET_LIMIT) throw workspaceError('WORKSPACE_REQUEST_INVALID');
    const designations = values.map(parseDesignation);
    const requested = new Set(designations.map(designation => designation.key));
    if (registrations >= WORKSPACE_REGISTRATION_QUEUE) throw workspaceError('WORKSPACE_BUSY');
    registrations++;
    const operation = pending.then(async () => {
      if (!accepting) throw workspaceError('WORKSPACE_CLOSING');
      const next = new Map(targets), created: Target[] = [];
      try {
        for (const designation of designations) {
          const current = next.get(designation.key);
          if (current) {
            if (JSON.stringify(current.stored.designation) !== JSON.stringify(designation)) throw workspaceError('WORKSPACE_TARGET_OPTIONS_MISMATCH');
            if (current.view.unavailable) throw workspaceError('WORKSPACE_SOURCE_CHANGED');
            await current.check?.();
            continue;
          }
          if (next.size >= WORKSPACE_TARGET_LIMIT) throw workspaceError('WORKSPACE_TARGET_LIMIT');
          const target = await prepare(designation);
          created.push(target); next.set(designation.key, target);
        }
        for (const [key, target] of next) {
          if (requested.has(key)) await target.check?.();
          else if (!target.view.unavailable) {
            try {await target.check?.();}
            catch {next.set(key, {...target, view: {...target.view, unavailable: 'WORKSPACE_SOURCE_CHANGED'}});}
          }
        }
        await persist(next);
        targets = next;
        live.rearmUnopened();
        return {schema: WORKSPACE_SCHEMA, incarnation, count: targets.size};
      } catch (error) {for (const target of created) target.context?.stop(); throw error;}
    });
    pending = operation.then(() => {}, () => {});
    try {return await operation;} finally {registrations--;}
  }

  function stream(response: Response, request: Request, release: () => void) {
    if (!response.body || request.method === 'HEAD') {release(); return response;}
    const reader = response.body.getReader();
    const abort = () => {release(); void reader.cancel().catch(() => {});};
    request.signal.addEventListener('abort', abort, {once: true});
    if (request.signal.aborted) abort();
    const done = () => {request.signal.removeEventListener('abort', abort); release();};
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {const next = await reader.read(); if (next.done) {done(); controller.close();} else controller.enqueue(next.value);}
        catch (error) {done(); controller.error(error);}
      },
      cancel(reason) {done(); return reader.cancel(reason);},
    }), {status: response.status, headers: response.headers});
  }

  async function route(request: Request, server: UpgradableServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.origin !== record.origin) return refused('WORKSPACE_LOOPBACK_REQUIRED', 403);
    const sentOrigin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || sentOrigin !== null && sentOrigin !== record.origin) {
      return refused('WORKSPACE_SAME_ORIGIN_REQUIRED', 403);
    }
    const launch = sameSecret(request.headers.get('authorization'), 'Bearer ' + registrationCapability);
    const owner = sameSecret(request.headers.get('X-Review-Capability'), ownerCapability);
    if (url.pathname === '/workspace/api/status') {
      if (request.method !== 'GET' || url.search || !launch) return refused('WORKSPACE_CAPABILITY_REQUIRED', 403);
      return json({schema: WORKSPACE_SCHEMA, incarnation, pid: process.pid, fingerprint: options.fingerprint, runtime: Bun.version});
    }
    if (url.pathname === '/workspace/api/register') {
      if (request.method !== 'POST' || url.search || !launch) return refused('WORKSPACE_CAPABILITY_REQUIRED', 403);
      const body: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await boundedBody(request, WORKSPACE_BODY_LIMIT)));
      if (!body || typeof body !== 'object' || Array.isArray(body)) return refused('WORKSPACE_REQUEST_INVALID', 400);
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(key => !['schema', 'incarnation', 'targets'].includes(key)) ||
          value.schema !== WORKSPACE_SCHEMA || value.incarnation !== incarnation) return refused('WORKSPACE_REQUEST_INVALID', 400);
      return json(await register(value.targets));
    }
    if (url.pathname === '/workspace/api/targets') {
      if (request.method !== 'GET' || url.search || !owner) return refused('WORKSPACE_CAPABILITY_REQUIRED', 403);
      return json(list());
    }
    if (url.pathname === '/workspace/live') {
      if (request.method !== 'GET' || url.search || sentOrigin !== record.origin) return refused('WORKSPACE_SAME_ORIGIN_REQUIRED', 403);
      if (live.connections >= WORKSPACE_SOCKET_LIMIT) return refused('WORKSPACE_BUSY', 503);
      return live.upgrade(request, server, securityHeaders);
    }
    if (['/', '/workspace.js', '/workspace.css', '/styles.css'].includes(url.pathname)) {
      if (!['GET', 'HEAD'].includes(request.method)) return refused('WORKSPACE_REQUEST_INVALID', 400);
      if (url.pathname === '/') {
        const keys = [...url.searchParams.keys()];
        if (new Set(keys).size !== keys.length || keys.some(key => !['workspace', 'lang'].includes(key)) ||
            url.searchParams.has('lang') && !['en', 'ko'].includes(url.searchParams.get('lang')!)) {
          return refused('WORKSPACE_REQUEST_INVALID', 400);
        }
        if (url.searchParams.has('workspace') && url.searchParams.get('workspace') !== incarnation) {
          return refused('WORKSPACE_HOST_MISMATCH', 409);
        }
      } else if (url.search && !['?lang=en', '?lang=ko'].includes(url.search)) {
        return refused('WORKSPACE_REQUEST_INVALID', 400);
      }
      const body = url.pathname === '/workspace.js' ? await (ownerScript ??= ownerBundle())
        : await readFile(appRoot + (url.pathname === '/' ? 'web/owner-workspace.html' : url.pathname === '/styles.css' ? 'web/styles.css' : 'web/owner-workspace.css'));
      return new Response(request.method === 'HEAD' ? null : body, {headers: {...securityHeaders,
        'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8'}});
    }
    const match = /^\/instances\/([a-f0-9]{64})(\/.*)$/.exec(url.pathname);
    const target = match && targets.get(match[1]!);
    if (!match || !target) return refused('WORKSPACE_TARGET_UNKNOWN', 404);
    if (!target.context) return refused(target.view.unavailable ?? 'WORKSPACE_TARGET_UNAVAILABLE');
    const path = match[2]!;
    const agentControl = path === '/api/control' || path === '/api/control/commands' || /^\/api\/control\/receipts\/[a-f0-9-]+$/.test(path);
    if (!frontRoute(target.view.mode, request.method, path) && !(agentControl && target.stored.controlToken)) return refused('WORKSPACE_ROUTE_REFUSED', 404);
    const landing = path === '/' || path === '/index.html';
    if (!landing && !!url.search) return refused('FRONT_QUERY_REFUSED', 400);
    if (request.method !== 'GET' && request.method !== 'HEAD' && sentOrigin !== record.origin) return refused('WORKSPACE_SAME_ORIGIN_REQUIRED', 403);
    if (path === '/api/live' && live.connections >= WORKSPACE_SOCKET_LIMIT) return refused('WORKSPACE_BUSY', 503);
    if (activeStreams >= maximumUpstreamStreams) return refused('WORKSPACE_BUSY', 503);
    const producerRequest = request.method === 'POST' && /^\/api\/(?:compare\/[ab]\/)?(?:rebuild|density-strip|bones-check|requirements|environment-check|readings|strip)(?:\/|$)/.test(path);
    if (producerRequest && (producing || [...targets.values()].some(row => row.context?.busy()))) return refused('WORKSPACE_BUSY', 503);
    if (producerRequest) producing = true;
    activeStreams++;
    let released = false;
    const release = () => {if (!released) {released = true; activeStreams--;}};
    try {
      const normalized = new URL(request.url); normalized.pathname = path;
      const inner = new Request(normalized, request);
      const upgrade: UpgradableServer = {upgrade(_inner, details) {return server.upgrade(request, details);}};
      const response = await target.context.handle(inner, Number(url.port), upgrade);
      if (!response) {release(); return undefined;}
      if ((path === '/api/review' || path === '/api/compare') && response.status === 409) target.view.unavailable = 'WORKSPACE_SOURCE_CHANGED';
      if ((path === '/' || path === '/index.html') && response.headers.get('Content-Type')?.startsWith('text/html')) {
        const policy = response.headers.get('Content-Security-Policy');
        if (policy) response.headers.set('Content-Security-Policy', policy.replace("frame-ancestors 'none'", "frame-ancestors 'self'"));
      }
      return stream(response, request, release);
    } catch (error) {release(); throw error;}
    finally {if (producerRequest) producing = false;}
  }

  function stop() {
    stopPromise ??= (async () => {
      accepting = false;
      await pending;
      live.stop();
      for (const target of targets.values()) target.context?.stop();
      await rawStop?.(true);
      const current = await readPrivate(join(directory, 'host.json'));
      if (current && (current as WorkspaceRecord).incarnation === incarnation) await unlink(join(directory, 'host.json'));
    })();
    return stopPromise;
  }

  try {
    const previous = await readPrivate(join(directory, 'targets.json'));
    if (previous) {
      for (const stored of parseRegistry(previous).targets) {
        try {targets.set(stored.designation.key, await prepare(stored.designation));}
        catch {
          targets.set(stored.designation.key, {stored, context: null, check: null, view: {
            key: stored.designation.key, contentHash: stored.designation.contentHash, title: stored.designation.inputs.input,
            mode: stored.designation.inputs.compare ? 'compare' : 'single', animation: stored.designation.inputs.animation ?? null,
            viewOnly: stored.designation.viewOnly, unavailable: 'WORKSPACE_SOURCE_CHANGED', entry: '',
          }});
        }
      }
    }
    const server = Bun.serve({hostname: '127.0.0.1', port: options.port, websocket: live.websocket,
      async fetch(request, server) {
        try {return await route(request, server) as Response;}
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message === 'FRONT_BODY_LIMIT') return refused('WORKSPACE_BODY_LIMIT', 413);
          if (message === 'FRONT_BODY_TIMEOUT') return refused('WORKSPACE_BODY_TIMEOUT', 408);
          if (message === 'FRONT_JSON_REQUIRED' || error instanceof SyntaxError) return refused('WORKSPACE_REQUEST_INVALID', 400);
          return refused(/^WORKSPACE_[A-Z_]+$/.test(message) ? message : 'WORKSPACE_REQUEST_REFUSED');
        }
      }});
    rawStop = server.stop.bind(server);
    record = {schema: WORKSPACE_SCHEMA, incarnation, pid: process.pid, uid: process.getuid?.() ?? 0,
      origin: `http://127.0.0.1:${server.port}`, installation: appRoot, fingerprint: options.fingerprint,
      runtime: Bun.version, registrationCapability, ownerCapability};
    await persist(targets);
    await writePrivate(join(directory, 'host.json'), record);
    return {record, live, stop};
  } catch (error) {
    await stop();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw workspaceError(`FRONT_PORT_BUSY: 127.0.0.1:${options.port} is held by another listener; use --direct (or set RIG_REVIEW_FRONT_PORT)`);
    throw error;
  }
}
