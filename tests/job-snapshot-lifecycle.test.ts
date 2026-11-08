import {afterEach, expect, spyOn, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {JobError, JobStore} from '../src/job-store.ts';
import type {JobCloseRequest} from '../src/job-contract.ts';
import {JobSession} from '../src/job-session.ts';
import {jobSnapshotHash} from '../src/job-source.ts';
import {createJobRequestContext, jobHostIdentity} from '../src/job-front.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const value = await jobFixture();
  fixtures.push(value);
  return value;
}
function closeRequest(f: Awaited<ReturnType<typeof fixture>>): JobCloseRequest {
  return {...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'lifecycle-close', reason: 'explicit lifecycle control'};
}
function stored(f: Awaited<ReturnType<typeof fixture>>) {
  const database = new Database(join(f.state, 'jobs.sqlite'));
  try {
    return database.query<{document: string; active: number; revision: number}, [string]>(
      'SELECT document,active,revision FROM jobs WHERE job_id=?').get(f.session.jobId)!;
  } finally { database.close(); }
}

for (const scenario of ['exact', 'nested', 'ancestor', 'source-alias', 'state-alias', 'direct-symlink']) {
  test(`stage4 managed state ${scenario} refuses before job admission`, async () => {
    const f = await fixture(), nested = join(f.state, 'private-source'), alias = join(f.scratch, 'state-alias');
    await mkdir(nested);
    await symlink(f.state, alias, 'dir');
    const roots: Record<string, string> = {
      exact: f.state, nested, ancestor: f.scratch,
      'source-alias': join(alias, 'private-source'), 'state-alias': nested, 'direct-symlink': alias,
    };
    const admission = spyOn(JobStore.prototype, 'open');
    let session: JobSession | undefined, code: string | undefined;
    try {
      try {
        session = new JobSession({root: roots[scenario], stateDir: scenario === 'state-alias' ? alias : f.state,
          fingerprint: 'stage4-' + scenario, reviewer: {id: 'declared-owner', role: 'owner'}});
      } catch (error) {code = (error as JobError).code;}
      const admissions = admission.mock.calls.length;
      console.log(JSON.stringify({control: 'STAGE4_BOUNDARY', scenario, code: code ?? null, admissions}));
      expect(code).toBe(scenario === 'direct-symlink' ? 'JOB_ROOT_REPLACED' : 'JOB_SOURCE_UNRETAINABLE');
      expect(admissions).toBe(0);
      expect(stored(f).active).toBe(1);
    } finally {session?.dispose(); admission.mockRestore();}
  });
}

test('stage4 managed state sibling source is admitted with literal path boundaries', async () => {
  const f = await fixture(), root = f.state + '-sibling';
  await mkdir(root);
  const session = new JobSession({root, stateDir: f.state, fingerprint: 'stage4-sibling',
    reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    expect(session.jobId).not.toBe(f.session.jobId);
    expect(session.status().status).toBe('active');
    expect(f.session.status().status).toBe('active');
  } finally {session.dispose();}
});

for (const scenario of ['exact', 'nested']) {
  test(`stage4 snapshot ${scenario} source refuses B admission before A closes`, async () => {
    const f = await fixture(), publication = await f.publish();
    const retained = f.session.retainedSource(publication.publicationId);
    const bytes = await readFile(retained.manifestPath);
    const root = scenario === 'exact' ? retained.snapshotRoot : join(retained.snapshotRoot, 'out');
    const admission = spyOn(JobStore.prototype, 'open');
    let session: JobSession | undefined, code: string | undefined;
    try {
      try {
        session = new JobSession({root, stateDir: f.state, fingerprint: 'stage4-snapshot-' + scenario,
          reviewer: {id: 'declared-owner', role: 'owner'}});
      } catch (error) {code = (error as JobError).code;}
      const admissions = admission.mock.calls.length;
      console.log(JSON.stringify({control: 'STAGE4_BOUNDARY', scenario: 'snapshot-' + scenario,
        code: code ?? null, admissions}));
      expect(code).toBe('JOB_SOURCE_UNRETAINABLE');
      expect(admissions).toBe(0);
      expect(await readFile(retained.manifestPath)).toEqual(bytes);
      expect((await (await f.call(closeRequest(f))).json()).ok).toBe(true);
      await expect(readFile(retained.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {session?.dispose(); admission.mockRestore();}
  });
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function readCount(f: Awaited<ReturnType<typeof fixture>>): number {
  const database = new Database(join(f.state, 'jobs.sqlite'));
  try {
    return database.query<{count: number}, [string]>(
      'SELECT count(*) AS count FROM job_snapshot_reads WHERE job_id=?').get(f.session.jobId)!.count;
  } finally { database.close(); }
}

async function gatedCloser(options: ConstructorParameters<typeof JobSession>[0],
  request: JobCloseRequest, legacy: boolean) {
  const script = `
    import {readSync, writeSync} from 'node:fs';
    import {randomUUID} from 'node:crypto';
    const input = JSON.parse(process.env.REVIEW_STAGE3_INPUT);
    const {JobStore} = await import(input.store);
    const {JobSession} = await import(input.session);
    const {requestDigest} = await import(input.api);
    const session = new JobSession(input.options);
    const gate = () => {
      writeSync(1, 'READY\\n');
      if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('CONTROL_GATE_CLOSED');
    };
    const seal = JobStore.prototype.sealClose;
    JobStore.prototype.sealClose = function(...args) {gate(); return seal.apply(this, args);};
    async function run() {
      if (!input.legacy) return session.execute(input.request, new AbortController().signal);
      gate();
      const store = new JobStore(input.options.stateDir);
      let value;
      try {
        const current = store.get(session.jobId);
        store.update(session.jobId, current.revision, fresh => {
          const data = fresh.data;
          data.generation++;
          data.fetchCapability = null;
          data.pages = {};
          const event = {type:'closed', reason:input.request.reason, cursor:randomUUID(),
            jobId:session.jobId, generation:data.generation};
          data.events.push(event);
          value = {status:'closed', cursor:event.cursor};
          const {requestId, ...semantic} = input.request;
          data.replays['agent:' + input.request.idempotencyKey] = {digest:requestDigest(semantic), value};
          return {data, active:false};
        });
        return value;
      } finally {store.close();}
    }
    const result = await run().then(value => ({value}), error => ({code:error.code, message:error.message}));
    writeSync(1, 'RESULT ' + JSON.stringify(result) + '\\n');
    session.dispose();
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: {...process.env, REVIEW_STAGE3_INPUT: JSON.stringify({options, request, legacy,
      store: new URL('../src/job-store.ts', import.meta.url).href,
      session: new URL('../src/job-session.ts', import.meta.url).href,
      api: new URL('../src/job-api.ts', import.meta.url).href})},
  });
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let output = '', released = false;
  while (!output.includes('READY\n')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('CONTROL_READY_MISSING ' + output);
    output += decoder.decode(chunk.value, {stream: true});
  }
  return {
    release() {child.stdin.write('x'); child.stdin.end();},
    async result() {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += decoder.decode(chunk.value, {stream: true});
      }
      reader.releaseLock();
      released = true;
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stderr).text()).toBe('');
      const line = output.split('\n').find(line => line.startsWith('RESULT '));
      if (!line) throw new Error('CONTROL_RESULT_MISSING ' + output);
      return JSON.parse(line.slice(7));
    },
    async stop() {
      if (child.exitCode === null) child.kill();
      await child.exited;
      if (!released) {await reader.cancel(); reader.releaseLock();}
    },
  };
}

for (const scenario of ['same', 'conflict', 'different-key', 'legacy']) {
  test(`stage3 close ${scenario} resolves durable replay before CAS across gated processes`, async () => {
    const f = await fixture(), request = closeRequest(f);
    const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner' as const}};
    const competing = {...request,
      ...(scenario === 'conflict' ? {reason: 'different close payload'} : {}),
      ...(scenario === 'different-key' ? {idempotencyKey: 'different-close-key'} : {})};
    const a = await gatedCloser(options, competing, false);
    let b: Awaited<ReturnType<typeof gatedCloser>> | undefined;
    try {
      b = await gatedCloser(options, request, scenario === 'legacy');
      b.release();
      const winner = await b.result(), sealed = stored(f);
      expect(winner.code).toBeUndefined();
      a.release();
      const loser = await a.result();
      console.log(JSON.stringify({control: 'STAGE3_CLOSE_' + scenario.toUpperCase(), winner, loser}));
      if (scenario === 'conflict') expect(loser.code).toBe('JOB_IDEMPOTENCY_CONFLICT');
      else if (scenario === 'different-key') expect(loser.code).toBe('JOB_GENERATION_STALE');
      else expect(loser).toEqual(winner);
      expect(stored(f)).toEqual(sealed);
      expect(sealed.active).toBe(0);
      expect(sealed.revision).toBe(1);
      expect(f.session.status().generation).toBe(1);
      expect(() => f.session.writerGrant()).toThrow('JOB_CLOSED');
      const database = new Database(join(f.state, 'jobs.sqlite'));
      try {
        expect(database.query<{count: number}, [string]>(
          'SELECT count(*) AS count FROM job_closures WHERE job_id=?').get(f.session.jobId)!.count)
          .toBe(scenario === 'legacy' ? 0 : 1);
      } finally {database.close();}
    } finally {await a.stop(); await b?.stop();}
  });
}

for (const ending of ['eof', 'cancel', 'dispose-eof', 'dispose-cancel']) {
  test(`stage3 stream ${ending} succeeds while unrelated ownership cleanup stays observable and retryable`, async () => {
    const f = await fixture(), a = await f.publish();
    const retainedA = f.session.retainedSource(a.publicationId);
    const bytes = await readFile(join(retainedA.snapshotRoot, 'out/rigid.png'));
    const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner' as const}};
    const context = createJobRequestContext(f.session, options, f.origin, jobHostIdentity(options), async () => '');
    const display = f.session.displayPublication(a.publicationId);
    const response = await context.fetch(new Request(f.origin + display.routes.assetsBase + 'rigid.png'));
    expect(response.status).toBe(200);
    const b = await f.publish(), retainedB = f.session.retainedSource(b.publicationId);
    const originalB = await readFile(retainedB.manifestPath), parked = retainedB.snapshotRoot + '-stage3';
    const closer = new JobSession(options), request = closeRequest(f);
    const close = () => closer.execute(request, new AbortController().signal).then(
      value => ({value}), error => ({code: error.code, message: error.message}));
    await rename(retainedB.snapshotRoot, parked);
    await mkdir(retainedB.snapshotRoot, {mode: 0o700});
    await writeFile(join(retainedB.snapshotRoot, 'preserve'), 'replacement bytes');
    try {
      const closed = await close();
      expect('code' in closed && closed.code).toBe('JOB_SOURCE_UNRETAINABLE');
      if (ending.startsWith('dispose')) f.session.dispose();
      const body = await (ending.endsWith('cancel') ? response.body!.cancel().then(() => Buffer.alloc(0)) : response.arrayBuffer().then(value => Buffer.from(value)))
        .then(value => ({value, code: null}), error => ({value: null, code: error.code, message: error.message}));
      const retried = await close();
      console.log(JSON.stringify({control: 'STAGE3_EOF_UNRELATED', ending,
        close: closed, body: {code: body.code, bytes: body.value?.length}, retry: retried}));
      expect(body.code).toBeNull();
      if (!ending.endsWith('cancel')) expect(body.value).toEqual(bytes);
      expect(readCount(f)).toBe(0);
      expect('code' in retried && retried.code).toBe('JOB_SOURCE_UNRETAINABLE');
      expect(await readFile(join(parked, 'out/review.json'))).toEqual(originalB);
      expect(await readFile(join(retainedB.snapshotRoot, 'preserve'), 'utf8')).toBe('replacement bytes');
      await rm(retainedB.snapshotRoot, {recursive: true});
      await rename(parked, retainedB.snapshotRoot);
      expect('code' in await close()).toBe(false);
      await expect(readFile(retainedB.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await response.body?.cancel().catch(() => {});
      context.stop(); closer.dispose();
      try {
        await readFile(join(parked, 'out/review.json'));
        await rm(retainedB.snapshotRoot, {recursive: true, force: true});
        await rename(parked, retainedB.snapshotRoot);
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
  });
}

test('stage3 count bookkeeping failure stays visible and preserves bytes after proven file EOF', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const response = await f.session.readPublicationResponse(publication.publicationId, async () => new Response('valid bytes'));
  expect((await (await f.call(closeRequest(f))).json()).ok).toBe(true);
  const fault = spyOn(JobStore.prototype, 'endSnapshotRead').mockImplementation(() => {
    throw new JobError('JOB_STORAGE_FAILED', 'CONTROL_COUNT_WRITE_FAILED');
  });
  try {
    await expect(response.text()).rejects.toMatchObject({code: 'JOB_STORAGE_FAILED', message: 'CONTROL_COUNT_WRITE_FAILED'});
    expect(readCount(f)).toBe(1);
    expect(await readFile(retained.manifestPath)).toBeInstanceOf(Buffer);
  } finally {fault.mockRestore();}
});

test('stage3 real stream failure stays visible and an unproven cancellation preserves its count', async () => {
  const f = await fixture(), publication = await f.publish();
  const response = await f.session.readPublicationResponse(publication.publicationId, async () =>
    new Response(new ReadableStream<Uint8Array>({start(controller) {controller.error(new Error('CONTROL_READ_FAILED'));}})));
  await expect(response.arrayBuffer()).rejects.toThrow('CONTROL_READ_FAILED');
  expect(readCount(f)).toBe(1);
});

for (const rejected of [false, true]) {
  test(`stage2 P1 ${rejected ? 'rejected' : 'delayed'} cancellation preserves the durable read until proven completion`, async () => {
    const f = await fixture(), publication = await f.publish();
    const retained = f.session.retainedSource(publication.publicationId);
    const entered = deferred<void>(), gate = deferred<void>(), pulling = deferred<void>();
    const response = await f.session.readPublicationResponse(publication.publicationId, async () =>
      new Response(new ReadableStream<Uint8Array>({
        pull() {pulling.resolve();},
        cancel() {entered.resolve(); return gate.promise;},
      }, {highWaterMark: 0})));
    const reader = response.body!.getReader(), pending = reader.read();
    await pulling.promise;
    expect((await (await f.call(closeRequest(f))).json()).ok).toBe(true);
    const cancellation = reader.cancel('controlled pending cancellation').then(
      () => ({error: null}), error => ({error: String(error)}));
    await entered.promise;
    expect((await pending).done).toBe(true);
    await Promise.resolve();
    const beforeCount = readCount(f);
    const beforeBytes = await readFile(retained.manifestPath).then(() => true, () => false);
    if (rejected) gate.reject(new Error('CONTROL_CANCEL_UNPROVEN'));
    else gate.resolve();
    const result = await cancellation;
    const afterCount = readCount(f);
    const afterBytes = await readFile(retained.manifestPath).then(() => true, () => false);
    console.log(JSON.stringify({control: rejected ? 'STAGE2_CANCEL_REJECT' : 'STAGE2_CANCEL_DELAY',
      beforeCount, beforeBytes, afterCount, afterBytes, result}));
    if (rejected) {
      expect(result.error).toContain('CONTROL_CANCEL_UNPROVEN');
      expect(afterCount).toBe(1);
      expect(afterBytes).toBe(true);
    } else {
      expect(beforeCount).toBe(1);
      expect(beforeBytes).toBe(true);
      expect(result.error).toBeNull();
      expect(afterCount).toBe(0);
      expect(afterBytes).toBe(false);
    }
  });
}

test('stage2 P2 replay close keeps the store alive through two removals while disposed', async () => {
  const f = await fixture(), first = await f.publish(), second = await f.publish();
  const publications = [first, second].map(publication => ({publication,
    retained: f.session.retainedSource(publication.publicationId)}));
  const store = new JobStore(f.state);
  const reads = publications.map(({publication, retained}) => store.beginSnapshotRead(f.session.jobId,
    publication.publicationId, jobSnapshotHash(retained.seals), retained.snapshotRoot));
  const request = closeRequest(f);
  try {
    expect((await (await f.call(request)).json()).ok).toBe(true);
    for (const read of reads) store.endSnapshotRead(read);
    const replay = f.session.execute(request, new AbortController().signal).then(
      value => ({value, error: null}), error => ({value: null, error: String(error)}));
    f.session.dispose();
    const result = await replay;
    console.log(JSON.stringify({control: 'STAGE2_REPLAY_DISPOSE', result}));
    expect(result.error).toBeNull();
    for (const {retained} of publications) {
      await expect(readFile(retained.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
    }
  } finally { store.close(); }
});

for (const replacement of ['missing', 'symlink', 'dangling']) {
test(`stage2 P2 duplicate removal checks ${replacement} between lstat and realpath`, async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const target = join(f.scratch, 'unowned-target');
  if (replacement === 'symlink') {
    await mkdir(target);
    await writeFile(join(target, 'preserve'), 'unowned bytes');
  }
  const script = `
    import {mock} from 'bun:test';
    import * as fs from 'node:fs';
    const original = {...fs};
    const input = JSON.parse(await Bun.stdin.text());
    let removed = false;
    mock.module('node:fs', () => ({...original, realpathSync(path, ...args) {
      if (path === input.snapshot.snapshotRoot && !removed) {
        const child = Bun.spawnSync([process.execPath, '-e',
          'import {rmSync} from "node:fs"; rmSync(Bun.argv[Bun.argv.length-1], {recursive:true});', path]);
        if (child.exitCode !== 0) throw new Error('CONTROL_REMOVER_FAILED');
        if (input.replacement) original.symlinkSync(input.replacement, path);
        removed = true;
      }
      return original.realpathSync(path, ...args);
    }}));
    const {removeOwnedJobSnapshot} = await import(input.module);
    const result = await removeOwnedJobSnapshot(input.state, input.snapshot).then(
      () => ({error:null}), error => ({error:String(error), code:error.code}));
    console.log(JSON.stringify({control:'STAGE2_DUPLICATE_REMOVE', removed, result}));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
  child.stdin.write(JSON.stringify({state: f.state, replacement: replacement === 'missing' ? null : target,
    snapshot: {snapshotRoot: retained.snapshotRoot,
    ...retained.snapshotIdentity!}, module: new URL('../src/job-source.ts', import.meta.url).href}));
  child.stdin.end();
  const [exit, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0);
  expect(stderr).toBe('');
  const result = JSON.parse(stdout);
  console.log(JSON.stringify(result));
  expect(result.removed).toBe(true);
  if (replacement === 'missing') expect(result.result.error).toBeNull();
  else expect(result.result.code).toBe('JOB_SOURCE_UNRETAINABLE');
  if (replacement === 'symlink') expect(await readFile(join(target, 'preserve'), 'utf8')).toBe('unowned bytes');
});
}

test('private snapshot hash preserves ordered seals, fixed keys and literal Unicode', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const seals = [{sha256: a, path: '각/é.png'}, {path: 'é.png', sha256: b}];
  const literal = `[{"path":"각/é.png","sha256":"${a}"},{"path":"é.png","sha256":"${b}"}]`;
  expect(jobSnapshotHash(seals)).toBe(createHash('sha256').update(literal, 'utf8').digest('hex'));
  expect(jobSnapshotHash([...seals].reverse())).not.toBe(jobSnapshotHash(seals));
  expect(jobSnapshotHash([{path: '각/é.png', sha256: a}, seals[1]])).not.toBe(jobSnapshotHash(seals));
});

test('planted reclaim refuses every open publication including superseded, pending and displayed roots without changing bytes', async () => {
  const f = await fixture(), first = await f.publish();
  const retained = f.session.retainedSource(first.publicationId);
  const before = await readFile(retained.manifestPath);
  await f.ask(first, {kind: 'checkpoint', checkpointId: 'step-one'});
  await f.display(first);
  await expect(f.session.reclaimSnapshot(first.publicationId, jobSnapshotHash(retained.seals)))
    .rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE', message: 'JOB_SNAPSHOT_PINNED'});
  await f.publish();
  await expect(f.session.reclaimSnapshot(first.publicationId, jobSnapshotHash(retained.seals)))
    .rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE', message: 'JOB_SNAPSHOT_PINNED'});
  expect(await readFile(retained.manifestPath)).toEqual(before);
  const store = new JobStore(f.state);
  try { expect(store.snapshotTombstone(f.session.jobId, first.publicationId)).toBeNull(); }
  finally { store.close(); }
});

test('finalized consumer acts permanently pin exact sealed bytes and original replay values through close', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const before = await Promise.all(retained.seals.map(seal => readFile(join(retained.snapshotRoot, seal.path))));
  const ask = await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication);
  const submission = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'preserved-act', kind: 'checkpoint',
    value: {checkpointId: 'step-one', outcome: 'fail', words: '  exact\nwords  '}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error('Expected finalized act');
  const grant = f.session.writerGrant();
  const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId}, grant.fetchCapability)).json();
  expect(JSON.stringify(fetched.value)).toBe(JSON.stringify(saved.value));
  const original = stored(f).document;
  const request = closeRequest(f);
  expect((await (await f.call(request)).json()).ok).toBe(true);
  expect(stored(f).document).toBe(original);
  await expect(f.session.reclaimSnapshot(publication.publicationId, jobSnapshotHash(retained.seals)))
    .rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE', message: 'JOB_SNAPSHOT_PINNED'});
  for (const [index, seal] of retained.seals.entries()) {
    expect(await readFile(join(retained.snapshotRoot, seal.path))).toEqual(before[index]);
  }
  const replay = await f.session.commitUIAct(submission);
  expect(JSON.stringify(replay)).toBe(JSON.stringify(saved.value));
  const revoked = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId}, grant.fetchCapability)).json();
  expect(revoked.error.code).toBe('JOB_CLOSED');
  expect(() => f.session.retainedSource(publication.publicationId)).toThrow('JOB_CLOSED');
  expect(() => f.session.displayPublication(publication.publicationId)).toThrow('JOB_CLOSED');
  expect((await (await f.call(request)).json()).ok).toBe(true);
  const next = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  expect(next.value.events.filter((event: {type: string}) => event.type === 'closed')).toHaveLength(1);
});

test('exactly 16MiB historical document closes atomically, revokes capability and invalidates asks/pages without rewriting history', async () => {
  const f = await fixture(), publication = await f.publish();
  await f.ask(publication, {kind: 'checkpoint', checkpointId: 'step-one'});
  const page = await f.display(publication), grant = f.session.writerGrant();
  const database = new Database(join(f.state, 'jobs.sqlite'));
  const data = {...JSON.parse(stored(f).document), lifecyclePadding: ''};
  data.lifecyclePadding = 'x'.repeat(16 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(data)));
  const full = JSON.stringify(data);
  expect(Buffer.byteLength(full)).toBe(16 * 1024 * 1024);
  database.query('UPDATE jobs SET document=? WHERE job_id=?').run(full, f.session.jobId);
  const before = stored(f), request = closeRequest(f);
  try {
    const closed = await (await f.call(request)).json();
    expect(closed.ok).toBe(true);
    const after = stored(f);
    expect(after.document).toBe(full);
    expect(after.active).toBe(0);
    expect(after.revision).toBe(before.revision + 1);
    expect(database.query<{count: number}, [string]>(
      'SELECT count(*) AS count FROM job_closures WHERE job_id=?').get(f.session.jobId)!.count).toBe(1);
    expect(f.session.status().pending).toEqual([]);
    expect(() => f.session.ackDisplayed({...page, sourceHash: publication.source.sourceHash})).toThrow('JOB_CLOSED');
    const revoked = await (await f.call({...f.base(), verb: 'fetch-act', actId: 'any'}, grant.fetchCapability)).json();
    expect(revoked.error.code).toBe('JOB_CLOSED');
    const replay = await (await f.call(request)).json();
    expect(replay.value).toEqual(closed.value);
    expect(stored(f).document).toBe(full);
  } finally { database.close(); }
});

test('legacy documents and publication replay remain byte-identical while unknown legacy ownership preserves snapshots', async () => {
  const f = await fixture(), publish = await f.publishRequest('legacy-publication');
  const published = await (await f.call(publish)).json();
  expect(published.ok).toBe(true);
  const publication = published.value, retained = f.session.retainedSource(publication.publicationId);
  const database = new Database(join(f.state, 'jobs.sqlite'));
  try {
    const data = JSON.parse(stored(f).document);
    delete data.publications[publication.publicationId].retained.snapshotIdentity;
    const legacy = JSON.stringify(data), replays = JSON.stringify(data.replays);
    database.query('UPDATE jobs SET document=? WHERE job_id=?').run(legacy, f.session.jobId);
    database.query('DELETE FROM job_snapshot_owners WHERE job_id=?').run(f.session.jobId);
    expect((await (await f.call(closeRequest(f))).json()).ok).toBe(true);
    expect(stored(f).document).toBe(legacy);
    expect(JSON.stringify(JSON.parse(stored(f).document).replays)).toBe(replays);
    const replay = await (await f.call(publish)).json();
    expect(JSON.stringify(replay.value)).toBe(JSON.stringify(publication));
    expect(await readFile(retained.manifestPath)).toBeInstanceOf(Buffer);
    const store = new JobStore(f.state);
    try { expect(store.snapshotTombstone(f.session.jobId, publication.publicationId)).toBeNull(); }
    finally { store.close(); }
  } finally { database.close(); }
});

test('an actual front file response pins bytes across a second session close until its complete body is consumed', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const file = join(retained.snapshotRoot, 'out/rigid.png'), before = await readFile(file);
  const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner' as const}};
  const context = createJobRequestContext(f.session, options, f.origin, jobHostIdentity(options), async () => '');
  const display = f.session.displayPublication(publication.publicationId);
  const response = await context.fetch(new Request(f.origin + display.routes.assetsBase + 'rigid.png'));
  expect(response.status).toBe(200);
  const second = new JobSession(options);
  const request = closeRequest(f);
  try {
    await second.execute({...request, verb: 'close'}, new AbortController().signal);
    expect(await readFile(file)).toEqual(before);
    expect(f.session.busy).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(before);
    expect(f.session.busy).toBe(false);
    await expect(readFile(file)).rejects.toMatchObject({code: 'ENOENT'});
    const store = new JobStore(f.state);
    try {
      const tombstone = store.snapshotTombstone(f.session.jobId, publication.publicationId)!;
      expect(tombstone).toMatchObject({publicationId: publication.publicationId,
        snapshotHash: jobSnapshotHash(retained.seals), reason: 'closed'});
      expect(Number.isFinite(Date.parse(tombstone.reclaimedAt))).toBe(true);
      expect(() => store.beginSnapshotRead(f.session.jobId, publication.publicationId,
        tombstone.snapshotHash, retained.snapshotRoot)).toThrow('JOB_SNAPSHOT_RECLAIMED');
      await second.execute({...request, verb: 'close'}, new AbortController().signal);
      expect(store.snapshotTombstone(f.session.jobId, publication.publicationId)).toEqual(tombstone);
    } finally { store.close(); }
  } finally { context.stop(); second.dispose(); }
});

test('cancel explicitly drains a response and permits reclamation, including disposal during the read', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  let cancelled = false;
  const response = await f.session.readPublicationResponse(publication.publicationId, async () =>
    new Response(new ReadableStream<Uint8Array>({cancel() {cancelled = true;}})));
  expect((await (await f.call(closeRequest(f))).json()).ok).toBe(true);
  f.session.dispose();
  expect(await readFile(retained.manifestPath)).toBeInstanceOf(Buffer);
  await response.body!.cancel();
  expect(cancelled).toBe(true);
  await expect(readFile(retained.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
});

test('only explicit read completion drains a durable count and unknown old preparations never expire', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId), store = new JobStore(f.state);
  const orphan = join(f.state, 'snapshots', randomUUID());
  await mkdir(orphan, {mode: 0o700});
  await writeFile(join(orphan, 'unclaimed'), 'unknown preparation');
  await utimes(orphan, new Date(0), new Date(0));
  const readId = store.beginSnapshotRead(f.session.jobId, publication.publicationId,
    jobSnapshotHash(retained.seals), retained.snapshotRoot);
  const request = closeRequest(f);
  try {
    expect((await (await f.call(request)).json()).ok).toBe(true);
    expect(await readFile(retained.manifestPath)).toBeInstanceOf(Buffer);
    await expect(f.session.reclaimSnapshot(publication.publicationId, jobSnapshotHash(retained.seals)))
      .rejects.toMatchObject({code: 'JOB_SOURCE_UNRETAINABLE', message: 'JOB_SNAPSHOT_PINNED'});
    expect(await readFile(join(orphan, 'unclaimed'), 'utf8')).toBe('unknown preparation');
    store.endSnapshotRead(readId);
    expect((await (await f.call(request)).json()).ok).toBe(true);
    await expect(readFile(retained.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(join(orphan, 'unclaimed'), 'utf8')).toBe('unknown preparation');
  } finally { store.close(); }
});

test('a replaced scratch directory refuses removal after durable close and a restored-owner retry keeps its tombstone immutable', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId), parked = retained.snapshotRoot + '-parked';
  const request = closeRequest(f), grant = f.session.writerGrant();
  await rename(retained.snapshotRoot, parked);
  await mkdir(retained.snapshotRoot, {mode: 0o700});
  try {
    const refused = await (await f.call(request)).json();
    expect(refused.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
    expect(f.session.status().status).toBe('closed');
    const revoked = await (await f.call({...f.base(), verb: 'fetch-act', actId: 'any'}, grant.fetchCapability)).json();
    expect(revoked.error.code).toBe('JOB_CLOSED');
    const store = new JobStore(f.state);
    try {
      const tombstone = store.snapshotTombstone(f.session.jobId, publication.publicationId);
      await rm(retained.snapshotRoot, {recursive: true});
      await rename(parked, retained.snapshotRoot);
      expect((await (await f.call(request)).json()).ok).toBe(true);
      expect(store.snapshotTombstone(f.session.jobId, publication.publicationId)).toEqual(tombstone);
      await expect(readFile(retained.manifestPath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally { store.close(); }
  } finally {
    // Restore the planted ownership replacement before fixture disposal if an assertion fails.
    try {
      await readFile(join(parked, 'out/review.json'));
      await rm(retained.snapshotRoot, {recursive: true, force: true});
      await rename(parked, retained.snapshotRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
});
