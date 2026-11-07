import {expect, test} from 'bun:test';
import {cp, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {loadCompare} from '../src/compare.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {createCompareRequestContext} from '../src/compare-server.ts';
import {createLiveLifecycle, type UpgradableServer} from '../src/live-lifecycle.ts';

const port = 19481;
const origin = `http://127.0.0.1:${port}`;
const capability = 'a'.repeat(64);
const unusedUpgrade: UpgradableServer = {upgrade() {throw new Error('Unexpected WebSocket upgrade');}};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-context-'));
  const a = join(root, 'a'), b = join(root, 'b');
  try {
    await cp(join(import.meta.dir, 'fixtures/strip-probe'), a, {recursive: true});
    await cp(a, b, {recursive: true});
    const single = await loadReview(a);
    const compare = await loadCompare({a, b, reference: join(a, 'reference.mov'), animation: 'inspect'});
    return {root, a, b, single, compare, stateDir: join(root, 'state'),
      async close() {await rm(root, {recursive: true, force: true});}};
  } catch (error) {
    await rm(root, {recursive: true, force: true});
    throw error;
  }
}

test('no-listener single and compare contexts retain route, origin, capability and asset checks', async () => {
  const f = await fixture();
  const contexts: {stop(): void}[] = [];
  const inputPaths = [join(f.a, 'motion.json'), join(f.b, 'motion.json'), join(f.a, 'reference.mov')];
  const before = await Promise.all(inputPaths.map(path => readFile(path)));
  try {
    const single = await createReviewRequestContext(f.single, {
      stateDir: f.stateDir, capability, bundle: new Blob(['synthetic single bundle']),
    });
    contexts.push(single);
    const compare = await createCompareRequestContext(f.compare, {
      stateDir: f.stateDir, capability, bundle: new Blob(['synthetic compare bundle']),
    });
    contexts.push(compare);
    for (const entry of [
      {context: single, metadata: '/api/review', session: '/api/session', asset: '/assets/build/skeleton.model.json', bundle: 'synthetic single bundle'},
      {context: compare, metadata: '/api/compare', session: '/api/compare/session', asset: '/compare-assets/a/build/skeleton.model.json', bundle: 'synthetic compare bundle'},
    ]) {
      const request = (path: string, init?: RequestInit) => entry.context.handle(new Request(origin + path, init), port, unusedUpgrade);
      expect((await request(entry.metadata))?.status).toBe(200);
      expect((await request(entry.session))?.status).toBe(200);
      expect(await (await request('/main.js'))?.text()).toBe(entry.bundle);
      expect((await request('/'))?.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      const asset = await request(entry.asset, {headers: {Range: 'bytes=0-9'}});
      expect(asset?.status).toBe(206);
      expect((await asset?.arrayBuffer())?.byteLength).toBe(10);
      expect(asset?.headers.get('Content-Security-Policy')).toBe("default-src 'none'; script-src 'none'; sandbox");
      expect((await entry.context.handle(new Request('http://localhost:' + port + entry.metadata), port, unusedUpgrade))?.status).toBe(403);
      expect((await request(entry.session, {method: 'PUT', headers: {'Content-Type': 'application/json', Origin: origin}, body: '{}'}))?.status).toBe(403);
      expect((await request(entry.session, {method: 'PUT', headers: {'Content-Type': 'application/json', Origin: 'http://foreign.test', 'X-Review-Capability': capability}, body: '{}'}))?.status).toBe(403);
      expect(entry.context.busy()).toBe(false);
    }
    expect(await Promise.all(inputPaths.map(path => readFile(path)))).toEqual(before);
  } finally {
    for (const context of contexts) context.stop();
    await f.close();
  }
});

test('shared lifecycle stays caller-owned and upgrade receives the original Request and socket data', async () => {
  const f = await fixture();
  const lifecycle = createLiveLifecycle({unopenedTimeoutMs: 10000});
  const socket = lifecycle.attachSocket();
  const contexts: {stop(): void}[] = [];
  try {
    const singleKey = '1'.repeat(64), compareKey = '2'.repeat(64);
    const identity = {nonce: 'synthetic-context-nonce', fingerprint: 'f'.repeat(64)};
    const single = await createReviewRequestContext(f.single, {
      stateDir: f.stateDir, lifecycle, bundle: new Blob(),
      open: {...identity, key: singleKey, contentHash: f.single.sourceHash},
    });
    contexts.push(single);
    const compare = await createCompareRequestContext(f.compare, {
      stateDir: f.stateDir, lifecycle, bundle: new Blob(),
      open: {...identity, key: compareKey, contentHash: f.compare.response.sourceHash},
    });
    contexts.push(compare);
    expect(single.live).toBe(lifecycle);
    expect(compare.live).toBe(lifecycle);
    for (const {context, key} of [{context: single, key: singleKey}, {context: compare, key: compareKey}]) {
      const request = new Request(origin + '/api/live', {headers: {Origin: origin, Upgrade: 'websocket'}});
      let upgrades = 0;
      const server: UpgradableServer = {upgrade(actual, options) {
        upgrades++;
        expect(actual).toBe(request);
        expect(options.data).toEqual({key});
        return true;
      }};
      expect(await context.handle(request, port, server)).toBeUndefined();
      expect(upgrades).toBe(1);
      context.stop();
      expect(lifecycle.connections).toBe(1);
      expect(lifecycle.rearmUnopened()).toBe(true);
    }
  } finally {
    for (const context of contexts) context.stop();
    socket.close();
    lifecycle.stop();
    await f.close();
  }
});

test('stopping an owned context disposes its lifecycle without stopping a listener', async () => {
  const f = await fixture();
  let listenerStops = 0;
  const contexts: Awaited<ReturnType<typeof createReviewRequestContext>>[] = [];
  try {
    const options = {stateDir: f.stateDir, bundle: new Blob(), stopServer() {listenerStops++;}};
    contexts.push(await createReviewRequestContext(f.single, options));
    contexts.push(await createCompareRequestContext(f.compare, options));
    for (const context of contexts) {
      context.stop();
      context.stop();
      expect(await context.live.exited).toBeNull();
      expect(context.live.rearmUnopened()).toBe(false);
    }
    expect(listenerStops).toBe(0);
  } finally {
    for (const context of contexts) context.stop();
    await f.close();
  }
});
