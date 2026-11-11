import {expect, test} from 'bun:test';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startOpenWorkspace} from '../src/open-workspace.ts';
import {controlReview, openFingerprint, prepareOpenTarget} from '../src/open.ts';
import {parseWorkspaceRecord, probeWorkspace, targetCapability, workspaceDirectory, writePrivate} from '../src/open-workspace-state.ts';
import {WORKSPACE_SCHEMA, WORKSPACE_TARGET_LIMIT, type WorkspaceDesignation, type WorkspaceList} from '../src/open-workspace-contract.ts';
import {loadReview} from '../src/manifest.ts';
import {sessionFile} from '../src/session.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-workspace-'));
  const stateDir = join(root, 'state'), a = join(root, 'a'), b = join(root, 'b'), c = join(root, 'c');
  await cp(join(import.meta.dir, 'fixtures/strip-probe'), a, {recursive: true});
  await cp(a, b, {recursive: true}); await cp(a, c, {recursive: true});
  const fingerprint = await openFingerprint();
  async function designation(input: string, compare?: string, control = false): Promise<WorkspaceDesignation> {
    const prepared = await prepareOpenTarget({input, animation: 'inspect', viewOnly: true, control,
      ...(compare ? {compare, reference: join(a, 'reference.mov')} : {})}, {stateDir}, fingerprint);
    return {key: prepared.key, contentHash: prepared.package.contentHash, cwd: prepared.cwd,
      viewOnly: true, inputs: {...prepared.package.inputs, viewOnly: true}};
  }
  return {root, stateDir, a, b, c, fingerprint, designation, close: () => rm(root, {recursive: true, force: true})};
}

async function ownerList(host: Awaited<ReturnType<typeof startOpenWorkspace>>): Promise<WorkspaceList> {
  const response = await fetch(host.record.origin + '/workspace/api/targets', {
    headers: {'X-Review-Capability': host.record.ownerCapability}, signal: AbortSignal.timeout(3000),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function register(host: Awaited<ReturnType<typeof startOpenWorkspace>>, targets: WorkspaceDesignation[], token = host.record.registrationCapability) {
  return fetch(host.record.origin + '/workspace/api/register', {method: 'POST', signal: AbortSignal.timeout(5000),
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify({schema: WORKSPACE_SCHEMA, incarnation: host.record.incarnation, targets})});
}

test('workspace registers single/compare contexts atomically and separates launcher, owner and target authority', async () => {
  const f = await fixture();
  const before = await Promise.all([f.a, f.b, f.c].map(jobInputHashes));
  const a = await f.designation(f.a), b = await f.designation(f.b), c = await f.designation(f.c);
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  try {
    expect((await register(host, [a, b])).status).toBe(200);
    expect((await register(host, [a])).status).toBe(200);
    let list = await ownerList(host); expect(list.targets).toHaveLength(2);
    expect(list.targets.every(target => target.viewOnly)).toBe(true);
    expect(list.targets.every(target => !('act' in target) && !('pending' in target))).toBe(true);
    expect((await fetch(host.record.origin + '/workspace/api/targets')).status).toBe(403);
    expect((await register(host, [c], host.record.ownerCapability)).status).toBe(403);
    const snapshot = await readFile(join(f.stateDir, 'owner-workspace/targets.json'));
    expect((await register(host, [c, {...a, key: '0'.repeat(64)}])).status).toBe(409);
    expect(await readFile(join(f.stateDir, 'owner-workspace/targets.json'))).toEqual(snapshot);
    expect((await ownerList(host)).targets).toHaveLength(2);
    const path = (key: string, route: string) => host.record.origin + '/instances/' + key + route;
    const cap = (key: string) => targetCapability(host.record.ownerCapability, host.record.incarnation, key);
    const session = await (await fetch(path(b.key, '/api/session'))).json();
    expect((await fetch(path(b.key, '/api/session'), {method: 'PUT', headers: {
      Origin: host.record.origin, 'Content-Type': 'application/json', 'X-Review-Capability': cap(a.key),
    }, body: JSON.stringify(session)})).status).toBe(403);
    expect((await fetch(path(b.key, '/api/session'), {method: 'PUT', headers: {
      Origin: 'http://foreign.test', 'Content-Type': 'application/json', 'X-Review-Capability': cap(b.key),
    }, body: JSON.stringify(session)})).status).toBe(403);
    expect((await fetch(path(b.key, '/api/session'), {method: 'PUT', headers: {
      Origin: host.record.origin, 'Content-Type': 'application/json', 'X-Review-Capability': cap(b.key),
    }, body: JSON.stringify({...session, status: 'changes-requested'})})).status).toBe(200);
    expect((await (await fetch(path(a.key, '/api/session'))).json()).updatedAt).toBeNull();
    const asset = await fetch(path(a.key, '/assets/build/skeleton.model.json'), {headers: {Range: 'bytes=0-9'}});
    expect(asset.status).toBe(206); expect((await asset.arrayBuffer()).byteLength).toBe(10);
    expect(asset.headers.get('Content-Security-Policy')).toBe("default-src 'none'; script-src 'none'; sandbox");
    const entry = await fetch(host.record.origin + list.targets[0]!.entry);
    expect(entry.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    await entry.body?.cancel();
    const comparison = await f.designation(f.a, f.b);
    expect((await register(host, [comparison])).status).toBe(200);
    expect((await fetch(path(comparison.key, '/api/compare'))).status).toBe(200);
    list = await ownerList(host); expect(list.targets).toHaveLength(3);
    const oversized = await fetch(host.record.origin + '/workspace/api/register', {method: 'POST',
      headers: {Authorization: 'Bearer ' + host.record.registrationCapability, 'Content-Type': 'application/json'},
      body: JSON.stringify({padding: 'x'.repeat(65536)})});
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({error: 'WORKSPACE_BODY_LIMIT'});
    expect(await Promise.all([f.a, f.b, f.c].map(jobInputHashes))).toEqual(before);
  } finally {await host.stop(); await f.close();}
});

test('workspace restart keeps designations and source identities while rotating incarnation and capabilities', async () => {
  const f = await fixture(), a = await f.designation(f.a, undefined, true);
  const first = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  let second: Awaited<ReturnType<typeof startOpenWorkspace>> | undefined;
  try {
    expect((await register(first, [a])).status).toBe(200);
    const state = await controlReview({input: f.a, animation: 'inspect'}, {stateDir: f.stateDir}) as {instanceKey: string};
    expect(state.instanceKey).toBe(a.key);
    await Promise.all([first.stop(), first.stop()]);
    second = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: Number(new URL(first.record.origin).port)});
    expect(second.record.origin).toBe(first.record.origin);
    expect(second.record.incarnation).not.toBe(first.record.incarnation);
    expect(second.record.ownerCapability).not.toBe(first.record.ownerCapability);
    const staleLanding = await fetch(second.record.origin + '/?workspace=' + first.record.incarnation);
    expect(staleLanding.status).toBe(409); expect(await staleLanding.json()).toEqual({error: 'WORKSPACE_HOST_MISMATCH'});
    const freshLanding = await fetch(second.record.origin + '/?workspace=' + second.record.incarnation);
    expect(freshLanding.status).toBe(200); await freshLanding.body?.cancel();
    expect((await ownerList(second)).targets[0]!.key).toBe(a.key);
    expect((await fetch(second.record.origin + '/workspace/api/targets', {
      headers: {'X-Review-Capability': first.record.ownerCapability},
    })).status).toBe(403);
    expect((await probeWorkspace(join(f.stateDir, 'owner-workspace'), f.fingerprint))?.pid).toBe(process.pid);
  } finally {await first.stop(); await second?.stop(); await f.close();}
});

test('owner landing accepts compatible roots and only the current unique incarnation query', async () => {
  const f = await fixture();
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  try {
    const identity = host.record.incarnation;
    for (const query of ['', '?lang=en', '?lang=ko', '?workspace=' + identity,
      '?workspace=' + identity + '&lang=en', '?lang=ko&workspace=' + identity,
      '?%77orkspace=' + identity + '&lang=%65n', '?workspace=' + identity + '&']) {
      // Fragments are client-side; fetching these forms pins document delivery only.
      for (const hash of ['', '#cap=' + 'c'.repeat(64), '#review=' + 'd'.repeat(64)]) {
        const response = await fetch(host.record.origin + '/' + query + hash);
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        await response.body?.cancel();
      }
    }
    for (const query of ['?workspace=' + identity + '&workspace=' + identity, '?lang=en&lang=en',
      '?workspace=' + identity + '&extra=1', '?workspace=' + identity + '&lang=fr',
      '?lang=', '?lang=EN', '?lang=en&lang=ko', '?cap=secret', '?review=secret']) {
      const response = await fetch(host.record.origin + '/' + query);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({error: 'WORKSPACE_REQUEST_INVALID'});
    }
    const stale = await fetch(host.record.origin + '/?workspace=00000000-0000-0000-0000-000000000000');
    expect(stale.status).toBe(409); expect(await stale.json()).toEqual({error: 'WORKSPACE_HOST_MISMATCH'});
    for (const path of ['/workspace.js', '/workspace.css', '/styles.css', '/workspace/api/targets']) {
      const response = await fetch(host.record.origin + path + '?workspace=' + identity, {
        headers: {'X-Review-Capability': host.record.ownerCapability},
      });
      expect(response.status).toBe(path === '/workspace/api/targets' ? 403 : 400);
      await response.body?.cancel();
    }
    expect((await fetch(host.record.origin + '/workspace/api/targets')).status).toBe(403);
  } finally {await host.stop(); await f.close();}
});

test('changed unrelated targets become unavailable without blocking new registrations or rebinding saved feedback', async () => {
  const f = await fixture();
  const a = await f.designation(f.a), b = await f.designation(f.b), c = await f.designation(f.c);
  const original = await loadReview(f.a);
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  try {
    expect((await register(host, [a])).status).toBe(200);
    const sessionURL = host.record.origin + '/instances/' + a.key + '/api/session';
    const session = await (await fetch(sessionURL)).json();
    expect((await fetch(sessionURL, {method: 'PUT', headers: {Origin: host.record.origin,
      'Content-Type': 'application/json', 'X-Review-Capability': targetCapability(host.record.ownerCapability, host.record.incarnation, a.key)},
      body: JSON.stringify({...session, status: 'changes-requested'})})).status).toBe(200);
    const feedback = sessionFile(original, f.stateDir), saved = await readFile(feedback);
    const motion = join(f.a, 'motion.json');
    await writeFile(motion, (await readFile(motion, 'utf8')) + '\n');
    expect((await register(host, [c])).status).toBe(200);
    const list = await ownerList(host);
    const old = list.targets.find(target => target.key === a.key)!;
    expect(old.contentHash).toBe(a.contentHash);
    expect(old.unavailable).toBe('WORKSPACE_SOURCE_CHANGED');
    expect(list.targets.find(target => target.key === c.key)?.unavailable).toBeNull();
    expect(await readFile(feedback)).toEqual(saved);
    const fresh = await (await fetch(host.record.origin + '/instances/' + c.key + '/api/session')).json();
    expect(fresh.sourceHash).toBe(c.contentHash);
    expect(fresh.updatedAt).toBeNull();
    const snapshot = await readFile(join(f.stateDir, 'owner-workspace/targets.json'));
    expect((await register(host, [b, {...c, key: '0'.repeat(64)}])).status).toBe(409);
    expect(await readFile(join(f.stateDir, 'owner-workspace/targets.json'))).toEqual(snapshot);
    expect((await ownerList(host)).targets.map(target => target.key)).toEqual([a.key, c.key]);
    expect(await readFile(feedback)).toEqual(saved);
  } finally {await host.stop(); await f.close();}
});

test('workspace reuses legacy stage-frame and nonlanding query policy while preserving landing options', async () => {
  const f = await fixture();
  const a = await f.designation(f.a), comparison = await f.designation(f.a, f.b);
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  try {
    expect((await register(host, [a, comparison])).status).toBe(200);
    const queryRefused = async (key: string, path: string) => {
      const response = await fetch(host.record.origin + '/instances/' + key + path);
      expect(response.status).toBe(400); expect(await response.json()).toEqual({error: 'FRONT_QUERY_REFUSED'});
    };
    for (const path of ['/api/review?debug=1', '/assets/build/skeleton.model.json?lang=ko', '/main.js?input=extra',
      '/stage-parts.html', '/stage-parts.html?stageEmbed=1', '/stage-parts.html?stageEmbed=1&lang=en&side=a',
      '/stage-parts.html?stageEmbed=1&lang=en&lang=ko', '/stage-interview.html?stageEmbed=1&lang=ko&extra=1']) {
      await queryRefused(a.key, path);
    }
    for (const path of ['/api/compare?debug=1', '/stage-parts.html?stageEmbed=1&lang=en',
      '/stage-parts.html?stageEmbed=1&lang=ko&side=a&extra=1']) await queryRefused(comparison.key, path);
    for (const [key, sides] of [[a.key, ['']], [comparison.key, ['&side=a', '&side=b']]] as const) {
      for (const page of ['stage-parts.html', 'stage-interview.html']) {
        for (const lang of ['en', 'ko']) for (const side of sides) {
          for (const hash of ['', '#cap=' + 'c'.repeat(64), '#review=' + 'd'.repeat(64)]) {
            const response = await fetch(host.record.origin + '/instances/' + key + '/' + page +
              '?stageEmbed=1&lang=' + lang + side + hash);
            expect(response.status).toBe(page === 'stage-interview.html' ? 404 : 200);
            if (page === 'stage-parts.html') expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
            await response.body?.cancel();
          }
        }
        const side = key === comparison.key ? '&side=a' : '';
        for (const query of ['', '?stageEmbed=1', '?stageEmbed=0&lang=en' + side,
          '?stageEmbed=1&lang=fr' + side, '?stageEmbed=1&lang=en&lang=ko' + side,
          '?stageEmbed=1&stageEmbed=1&lang=en' + side, '?stageEmbed=1&lang=en&side=c',
          '?stageEmbed=1&lang=en&side=a&side=b', '?stageEmbed=1&lang=en&cap=secret' + side,
          '?stageEmbed=1&lang=en&review=secret' + side,
          key === comparison.key ? '?stageEmbed=1&lang=en' : '?stageEmbed=1&lang=en&side=a']) {
          if (page === 'stage-interview.html' && key === comparison.key) {
            const response = await fetch(host.record.origin + '/instances/' + key + '/' + page + query);
            expect(response.status).toBe(404); await response.body?.cancel();
          } else await queryRefused(key, '/' + page + query);
        }
      }
    }
    for (const target of (await ownerList(host)).targets) {
      const url = new URL(target.entry, host.record.origin);
      url.searchParams.set('lang', 'ko'); url.searchParams.set('checkpoint', 'silhouette');
      const response = await fetch(url);
      expect(response.status).toBe(200); await response.body?.cancel();
      url.pathname += 'index.html';
      const indexed = await fetch(url); expect(indexed.status).toBe(200); await indexed.body?.cancel();
    }
  } finally {await host.stop(); await f.close();}
});

test('application admission and inspection routes support 32 targets and refuse target 33 atomically', async () => {
  const f = await fixture();
  const designations: WorkspaceDesignation[] = [];
  expect(WORKSPACE_TARGET_LIMIT).toBe(32);
  for (let index = 0; index <= WORKSPACE_TARGET_LIMIT; index++) {
    const input = join(f.root, 'capacity-' + index);
    await cp(f.a, input, {recursive: true}); designations.push(await f.designation(input));
  }
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0});
  try {
    expect((await register(host, designations.slice(0, WORKSPACE_TARGET_LIMIT))).status).toBe(200);
    const list = await ownerList(host); expect(list.targets).toHaveLength(WORKSPACE_TARGET_LIMIT);
    expect(list.targets.every(target => !!target.entry && target.unavailable === null)).toBe(true);
    const tenth = await fetch(host.record.origin + list.targets[9]!.entry);
    expect(tenth.status).toBe(200); await tenth.body?.cancel();
    const last = await fetch(host.record.origin + list.targets[31]!.entry);
    expect(last.status).toBe(200); await last.body?.cancel();
    const snapshot = await readFile(join(f.stateDir, 'owner-workspace/targets.json'));
    const overflow = await register(host, [designations[WORKSPACE_TARGET_LIMIT]!]);
    expect(overflow.status).toBe(409); expect(await overflow.json()).toEqual({error: 'WORKSPACE_TARGET_LIMIT'});
    expect(await readFile(join(f.stateDir, 'owner-workspace/targets.json'))).toEqual(snapshot);
    expect((await ownerList(host)).targets.map(target => target.key)).toEqual(list.targets.map(target => target.key));
  } finally {await host.stop(); await f.close();}
}, 30000);

test('a live unresponsive descriptor refuses attach without deleting state or treating its PID as dead', async () => {
  const f = await fixture();
  const directory = await workspaceDirectory(f.stateDir);
  const silent = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('', {status: 503})});
  const record = parseWorkspaceRecord({schema: WORKSPACE_SCHEMA, incarnation: crypto.randomUUID(), pid: process.pid,
    uid: process.getuid?.() ?? 0, origin: `http://127.0.0.1:${silent.port}`, installation: new URL('../', import.meta.url).pathname,
    fingerprint: f.fingerprint, runtime: Bun.version, registrationCapability: 'a'.repeat(64), ownerCapability: 'b'.repeat(64)});
  try {
    await writePrivate(join(directory, 'host.json'), record);
    const before = await readFile(join(directory, 'host.json'));
    await expect(probeWorkspace(directory, f.fingerprint)).rejects.toThrow('WORKSPACE_HOST_UNRESPONSIVE');
    expect(await readFile(join(directory, 'host.json'))).toEqual(before);
    await expect(probeWorkspace(directory, '0'.repeat(64))).rejects.toThrow('WORKSPACE_HOST_MISMATCH');
  } finally {await silent.stop(true); await f.close();}
});

test('busy workspace ports refuse by name and leave the existing listener usable', async () => {
  const f = await fixture();
  const holder = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('owned test listener')});
  try {
    await expect(startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: holder.port!}))
      .rejects.toThrow(`FRONT_PORT_BUSY: 127.0.0.1:${holder.port} is held by another listener; use --direct (or set RIG_REVIEW_FRONT_PORT)`);
    expect(await (await fetch(`http://127.0.0.1:${holder.port}`)).text()).toBe('owned test listener');
  } finally {await holder.stop(true); await f.close();}
});

test('one workspace lifecycle keeps unselected target contexts alive and preserves target WebSocket data', async () => {
  const f = await fixture();
  const a = await f.designation(f.a), b = await f.designation(f.b);
  const host = await startOpenWorkspace({stateDir: f.stateDir, fingerprint: f.fingerprint, port: 0, idleMs: 1000, graceMs: 100});
  let socket: WebSocket | undefined;
  try {
    expect((await register(host, [a, b])).status).toBe(200);
    socket = new WebSocket(host.record.origin.replace('http:', 'ws:') + '/instances/' + a.key + '/api/live',
      {headers: {Origin: host.record.origin}} as unknown as string[]);
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic workspace socket timeout')), 3000);
      socket!.onmessage = event => {clearTimeout(timer); resolve(String(event.data));};
      socket!.onerror = () => {clearTimeout(timer); reject(new Error('Synthetic workspace socket failed'));};
    });
    expect(JSON.parse(first)).toEqual({type: 'live', key: a.key});
    expect(host.live.connections).toBe(1);
    await Bun.sleep(1200);
    expect((await fetch(host.record.origin + '/instances/' + b.key + '/api/review')).status).toBe(200);
    expect((await ownerList(host)).targets).toHaveLength(2);
  } finally {socket?.close(); await host.stop(); await f.close();}
});
