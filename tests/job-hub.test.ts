import {afterEach, expect, test} from 'bun:test';
import {mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startJobHub, startJobHost, JOB_API_SCHEMA, JOB_ACT_SCHEMA,
  type JobHubJob, type JobHubJobOptions, type JobOwnerHub, type JobPublication} from '../src/job-host.ts';
import {JOB_COMMENTS_ACT_SCHEMA} from '../src/job-contract.ts';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {redactCapability} from '../scripts/redact.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const hubs: JobOwnerHub[] = [];
const reviewer = {id: 'declared-owner', role: 'owner' as const};
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture() {
  const value = await jobFixture(); fixtures.push(value); return value;
}
async function hub(stateDir: string, port = 0) {
  const value = await startJobHub({stateDir, port, reviewer}); hubs.push(value); return value;
}
function designation(f: Awaited<ReturnType<typeof jobFixture>>): JobHubJobOptions {
  return {root: f.root, fingerprint: 'f'.repeat(64), readPublished: async () => f.getContext(), readerId: 'synthetic-hub-reader/1'};
}
async function list(h: JobOwnerHub) {
  const url = new URL(h.ownerUrl);
  const response = await fetch(h.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': url.hash.slice(5)}});
  expect(response.status).toBe(200); return response.json();
}
async function api(job: JobHubJob, body: Record<string, unknown>, token = job.session.hostCredentials().agent) {
  return fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: 'synthetic-request', ...body})});
}
async function publish(f: Awaited<ReturnType<typeof jobFixture>>, job: JobHubJob): Promise<JobPublication> {
  const request = await f.publishRequest();
  const response = await api(job, {...request, jobId: job.session.jobId, expectedGeneration: job.session.status().generation});
  const value = await response.json(); expect(value.ok).toBe(true); return value.value;
}
async function ask(job: JobHubJob, publication: JobPublication, key = 'ask-one') {
  const response = await api(job, {verb: 'ask', expectedGeneration: job.session.status().generation, idempotencyKey: key,
    publicationId: publication.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step-one'}});
  const value = await response.json(); expect(value.ok).toBe(true); return value.value;
}
async function ui(job: JobHubJob, route: string, body: unknown, token = job.session.hostCredentials().ui) {
  return fetch(job.origin + '/jobs/' + job.session.jobId + '/ui/' + route, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: job.origin, 'X-Review-Capability': token}, body: JSON.stringify(body)});
}

test('#557 backend real hub HTTP keeps capture, raw act and PNG bound to its job and consumer grant', async () => {
  const f = await fixture();
  const h = await hub(join(f.scratch, 'hub-still'));
  const job = await h.openJob(designation(f));
  const publication = await publish(f, job);
  const asked = await api(job, {verb: 'ask', expectedGeneration: job.session.status().generation,
    idempotencyKey: '557-hub-rig', publicationId: publication.publicationId,
    subject: {kind: 'review-verdict', stage: 'rig-review'}});
  const askValue = await asked.json();
  expect(askValue.ok).toBe(true);
  const displayed = await ui(job, 'displayed', {publicationId: publication.publicationId,
    pageId: 'hub-page', sourceHash: publication.source.sourceHash});
  const receipt = await displayed.json();
  expect(receipt.ok).toBe(true);
  const {capture, bytes} = rigStillCapture(publication, askValue.value, receipt.value);
  const submitted = await ui(job, 'acts', {...receipt.value, askId: askValue.value.askId,
    expectedGeneration: job.session.status().generation, submissionId: '557-hub-submit', kind: 'review-verdict',
    value: {stage: 'rig-review', verdict: 'approved', words: 'hub exact words'}, capture});
  expect(submitted.status).toBe(200);
  const saved = await submitted.json();
  expect(saved.ok).toBe(true);
  expect(saved.value.schema).toBe('rig-review/act@6');
  for (const accept of ['application/vnd.rig-review.act+json', 'image/png']) {
    const response = await fetch(job.origin + `/jobs/${job.session.jobId}/api`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: accept,
        Authorization: 'Bearer ' + job.session.writerGrant().fetchCapability},
      body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: '557-hub-fetch',
        verb: 'fetch-act', actId: saved.value.actId})});
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(accept === 'image/png' ? bytes : Buffer.from(JSON.stringify(saved.value)))).toBe(true);
  }
});

test('one embedded listener owns nine independent jobs, asks, generations and finalized acts', async () => {
  const inputs = await Promise.all(Array.from({length: 9}, () => fixture()));
  for (const [index, f] of inputs.entries()) {
    const path = join(f.root, 'out/review.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.id = 'synthetic-hub-' + index; manifest.revision = String(index + 1);
    await writeFile(path, JSON.stringify(manifest));
  }
  const before = await Promise.all(inputs.map(f => jobInputHashes(f.root)));
  const h = await hub(inputs[0]!.state), jobs: JobHubJob[] = [], publications: JobPublication[] = [], asks = [];
  const grants: string[] = [];
  for (const f of inputs) {
    const job = await h.openJob({...designation(f), installWriterBinding: value => {grants.push(value.fetchCapability);}, bindingId: 'writer/1'});
    jobs.push(job); const publication = await publish(f, job); publications.push(publication); asks.push(await ask(job, publication));
  }
  expect(new Set(jobs.map(job => job.session.jobId)).size).toBe(9);
  expect(new Set(grants).size).toBe(9);
  expect(new Set(jobs.flatMap(job => Object.values(job.session.hostCredentials()))).size).toBe(18);
  expect((await list(h)).jobs.map((row: {generation: number; pendingCount: number; subjectKind?: string; answered?: boolean}) => [row.generation, row.pendingCount, row.subjectKind, row.answered]))
    .toEqual(Array.from({length: 9}, () => [2, 1, 'checkpoint', false]));
  const acts = [];
  for (const [index, job] of jobs.entries()) {
    const publication = publications[index]!;
    const displayed = await (await ui(job, 'displayed', {publicationId: publication.publicationId,
      pageId: 'synthetic-page', sourceHash: publication.source.sourceHash})).json();
    expect(displayed.ok).toBe(true);
    const response = await ui(job, 'acts', {...displayed.value, askId: asks[index].askId,
      expectedGeneration: job.session.status().generation, submissionId: 'synthetic-save', kind: 'checkpoint',
      value: {checkpointId: 'step-one', outcome: 'pass', words: 'synthetic human UI transport fixture'}});
    const act = await response.json(); expect(act.ok).toBe(true);
    expect(act.value.schema).toBe(JOB_COMMENTS_ACT_SCHEMA);
    expect(act.value.authority.reviewer).toEqual(reviewer);
    expect(act.value.jobId).toBe(job.session.jobId); acts.push(act.value);
    const fetched = await api(job, {verb: 'fetch-act', actId: act.value.actId}, grants[index]);
    expect((await fetched.json()).value).toEqual(act.value);
  }
  expect(new Set(acts.map(act => act.actId)).size).toBe(9);
  expect(jobs.map(job => job.session.status().generation)).toEqual(Array(9).fill(3));
  expect((await list(h)).jobs.map((row: {answered?: boolean}) => row.answered)).toEqual(Array(9).fill(true));
  expect((await api(jobs[1]!, {verb: 'next', after: null, waitMs: 0}, jobs[0]!.session.hostCredentials().agent)).status).toBe(403);
  expect((await ui(jobs[1]!, 'displayed', {}, jobs[0]!.session.hostCredentials().ui)).status).toBe(403);
  expect((await api(jobs[1]!, {verb: 'fetch-act', actId: acts[1].actId}, grants[0])).status).toBe(403);
  const foreignCursor = jobs[0]!.session.status().cursor;
  expect((await (await api(jobs[1]!, {verb: 'next', after: foreignCursor, waitMs: 0})).json()).error.code).toBe('JOB_CURSOR_INVALID');
  await ask(jobs[0]!, publications[0]!, 'second-ask'); await ask(jobs[1]!, publications[1]!, 'second-ask');
  await publish(inputs[0]!, jobs[0]!);
  expect(jobs[0]!.session.status().pending).toHaveLength(0);
  expect(jobs[1]!.session.status().pending).toHaveLength(1);
  const closed = await api(jobs[0]!, {verb: 'close', expectedGeneration: jobs[0]!.session.status().generation,
    idempotencyKey: 'close-one', reason: 'synthetic control'});
  expect((await closed.json()).ok).toBe(true); await Bun.sleep(300);
  expect((await list(h)).jobs).toHaveLength(9);
  expect(jobs[1]!.session.status().status).toBe('active');
  expect((await api(jobs[0]!, {verb: 'fetch-act', actId: acts[0].actId}, grants[0])).status).not.toBe(200);
  const sockets = Bun.spawnSync([Bun.which('lsof') ?? '/usr/sbin/lsof', '-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
  expect(sockets.exitCode).toBe(0);
  expect(sockets.stdout.toString().split('\n').filter(line => line.startsWith('n'))).toEqual(['n127.0.0.1:' + new URL(h.origin).port]);
  const record = JSON.parse(await readFile(join(inputs[0]!.state, 'job-hub/host.json'), 'utf8'));
  expect(record.pid).toBe(process.pid);
  expect(await Promise.all(inputs.map(f => jobInputHashes(f.root)))).toEqual(before);
  console.log(JSON.stringify({proof: 'embedded-semantic-nine', residentBackendPid: process.pid, listeners: 1,
    jobs: 9, independentAsks: 9, finalizedActs: 9, sourceInputsUnchanged: true, ownerUI: 'CP2_PENDING'}));
}, 30000);

test('writer binding failure hides the candidate and retries/concurrent matching opens preserve callback ownership', async () => {
  const f = await fixture(), h = await hub(f.state); let rejected = true, installs = 0, reads = 0;
  const options = {...designation(f), readPublished: async () => {reads++; return f.getContext();},
    installWriterBinding: () => {installs++; if (rejected) throw new Error('private adapter detail');}, bindingId: 'writer/1'};
  await expect(h.openJob(options)).rejects.toMatchObject({code: 'JOB_AUTHORITY_REFUSED'});
  expect((await list(h)).jobs).toEqual([]);
  rejected = false;
  const [first, second] = await Promise.all([h.openJob(options), h.openJob({...options,
    readPublished: async () => {throw new Error('replacement callback must not run');}})]);
  expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(first.session).toBe(second.session);
  expect(installs).toBe(3); await publish(f, second); expect(reads).toBe(1);
  await expect(h.openJob({...options, readerId: 'changed-reader'})).rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH'});
  expect(installs).toBe(3); expect((await list(h)).jobs).toHaveLength(1);
  const response = await fetch(h.origin + '/hub/api/jobs'); expect(response.status).toBe(403);
  const ownerPage = await fetch(h.ownerUrl);
  expect(ownerPage.status).toBe(200); expect(await ownerPage.text()).toContain('<div id="app"></div>');
  for (const [asset, mime] of [['/hub/styles.css', 'text/css'], ['/hub/main.js', 'text/javascript']] as const) {
    const res = await fetch(h.origin + asset);
    expect(res.status).toBe(200); expect(res.headers.get('Content-Type')).toContain(mime);
    expect((await res.text()).length).toBeGreaterThan(0);
  }
  const headers = {'X-Review-Capability': new URL(h.ownerUrl).hash.slice(5)};
  expect((await fetch(h.origin + '/hub/api/jobs?unknown=1', {headers})).status).toBe(400);
  expect((await fetch(h.origin + '/hub/api/jobs', {headers: {...headers, Origin: 'http://127.0.0.1:1'}})).status).toBe(403);
  expect((await fetch(h.origin + '/hub/api/jobs', {method: 'POST', headers})).status).toBe(400);
});

test('existing matching host reuse works locally and in a separate process without another listener', async () => {
  const f = await fixture(), h = await hub(f.state), options = designation(f), job = await h.openJob(options);
  const local = await startJobHost({...options, stateDir: f.state, reviewer});
  expect(local.reused).toBe(true); expect(local.origin).toBe(h.origin); local.stop();
  const snapshot = f.getContext();
  const code = `import {startJobHost} from ${JSON.stringify(new URL('../src/job-host.ts', import.meta.url).pathname)};
    const host=await startJobHost({...${JSON.stringify({root: f.root, fingerprint: options.fingerprint, stateDir: f.state, reviewer, readerId: options.readerId})},
      readPublished:async()=>(${JSON.stringify(snapshot)})});
    console.log(JSON.stringify({reused:host.reused,origin:host.origin,jobId:host.session.jobId}));host.stop();`;
  const child = Bun.spawn([process.execPath, '-e', code], {stdout: 'pipe', stderr: 'pipe'});
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const secrets = [...Object.values(job.session.hostCredentials()), job.session.writerGrant().fetchCapability,
      new URL(h.ownerUrl).hash.slice(5)];
    function safeChildText(text: string): string {
      let safe = redactCapability(text);
      for (const secret of secrets) safe = safe.replaceAll(secret, '<redacted>');
      return safe;
    }
    const receipt = {code: safeChildText(code), stdout: safeChildText(stdout), stderr: safeChildText(stderr), exit};
    const evidence = process.env.RIG_REVIEW_JOB_HUB_EVIDENCE;
    if (evidence) {
      await mkdir(evidence, {recursive: true});
      await writeFile(join(evidence, 'matching-reuse-child.json'), JSON.stringify(receipt, null, 2));
    }
    console.log(JSON.stringify({proof: 'matching-reuse-child', ...receipt}));
    expect(exit, receipt.stderr).toBe(0); expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({reused: true, origin: h.origin, jobId: job.session.jobId});
  } finally {clearTimeout(timer); if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}}
  expect((await list(h)).jobs).toHaveLength(1);
});

test('active external listeners and live unresponsive descriptors refuse without takeover', async () => {
  const f = await fixture(), options = designation(f);
  const external = await startJobHost({...options, stateDir: f.state, reviewer});
  const h = await hub(f.state);
  try {
    await expect(h.openJob(options)).rejects.toMatchObject({code: 'JOB_HUB_EXTERNAL_HOST'});
    expect((await fetch(external.ownerUrl)).status).toBe(200);
    expect((await list(h)).jobs).toEqual([]);
  } finally {external.stop();}
  const path = join(f.state, 'job-ui', external.session.jobId + '.json');
  const original = JSON.parse(await readFile(path, 'utf8'));
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => {finish = resolve;});
  const stalled = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch() {await waiting; return new Response('');}});
  const planted = JSON.stringify({...original, origin: 'http://127.0.0.1:' + stalled.port});
  await writeFile(path, planted, {mode: 0o600});
  try {
    await expect(h.openJob(options)).rejects.toMatchObject({code: 'JOB_HUB_HOST_UNRESPONSIVE'});
    expect(await readFile(path, 'utf8')).toBe(planted); expect((await list(h)).jobs).toEqual([]);
  } finally {finish(); await stalled.stop(true); await unlink(path);}
  expect((await h.openJob(options)).reused).toBe(false);
  await expect(startJobHub({stateDir: f.state, reviewer})).rejects.toMatchObject({code: 'JOB_HUB_ALREADY_RUNNING'});
});

test('hub stop drains retained publication work and restart preserves active identity without semantic close', async () => {
  const f = await fixture(), h = await hub(f.state); let entered!: () => void, release!: () => void;
  const enteredSnapshot = new Promise<void>(resolve => {entered = resolve;});
  const pendingSnapshot = new Promise<void>(resolve => {release = resolve;});
  const job = await h.openJob({...designation(f), afterSnapshot: async () => {entered(); await pendingSnapshot;}});
  const grant = job.session.writerGrant();
  const publishing = publish(f, job); await enteredSnapshot;
  let stopped = false; const stopping = h.stop().then(() => {stopped = true;});
  try {
    await Bun.sleep(20); expect(stopped).toBe(false);
    expect((await fetch(h.origin + '/hub/api/jobs')).status).toBe(503);
  } finally {release();}
  const publication = await publishing; await stopping;
  expect(await Bun.file(join(f.state, 'job-hub/host.json')).exists()).toBe(false);
  expect(await Bun.file(join(f.state, 'job-ui', job.session.jobId + '.json')).exists()).toBe(false);
  const next = await hub(f.state, Number(new URL(h.origin).port)), reopened = await next.openJob(designation(f));
  expect(next.ownerUrl).not.toBe(h.ownerUrl);
  expect(reopened.session.jobId).toBe(job.session.jobId);
  expect(reopened.session.status()).toMatchObject({status: 'active', publication});
  expect(reopened.session.writerGrant()).toEqual(grant);
  await expect(h.openJob(designation(f))).rejects.toMatchObject({code: 'JOB_HUB_CLOSED'});
});


test('hub application admission permits 32 contexts and refuses the next before creating state', async () => {
  const f = await fixture(), h = await hub(f.state), options = designation(f);
  for (let index = 0; index < 32; index++) await h.openJob({...options, fingerprint: 'synthetic-' + index});
  expect((await list(h)).jobs).toHaveLength(32);
  const before = await readFile(join(f.state, 'jobs.sqlite'));
  await expect(h.openJob({...options, fingerprint: 'synthetic-33'})).rejects.toMatchObject({code: 'JOB_HUB_LIMIT'});
  expect(await readFile(join(f.state, 'jobs.sqlite'))).toEqual(before);
  expect((await h.openJob({...options, fingerprint: 'synthetic-0'})).reused).toBe(true);
});

test('#563 strict startJobHost reuseOnly attaches to an active hub-owned job while hub.openJob rejects reuseOnly', async () => {
  const f = await fixture(), h = await hub(f.state), options = designation(f);
  let installs = 0;
  const job = await h.openJob({...options, installWriterBinding: () => { installs++; }, bindingId: 'hub-writer/1'});
  expect(installs).toBe(1);

  const hubHostRes = await fetch(h.origin + '/hub/host', {
    headers: {'X-Review-Capability': new URL(h.ownerUrl).hash.slice(5)},
  });
  expect(hubHostRes.status).toBe(200);
  const hubHostJson = await hubHostRes.json() as Record<string, unknown>;
  expect(Object.keys(hubHostJson).sort()).toEqual([
    'actSchema', 'apiSchema', 'capabilities', 'incarnation', 'origin', 'pid', 'schema',
  ]);

  const ordinary = await startJobHost({
    ...options,
    stateDir: f.state,
    reviewer,
    installWriterBinding: () => { installs++; },
    bindingId: 'hub-writer/1',
  });
  expect(ordinary.reused).toBe(true);
  expect(ordinary.attachment).not.toBeNull();
  expect(installs).toBe(2);
  const expected = ordinary.attachment!;
  ordinary.stop();

  const strictAttached = await startJobHost({
    ...options,
    stateDir: f.state,
    reviewer,
    installWriterBinding: () => { installs++; },
    bindingId: 'hub-writer/1',
    reuseOnly: {expected},
  });
  expect(strictAttached.reused).toBe(true);
  expect(strictAttached.origin).toBe(h.origin);
  expect(strictAttached.session.jobId).toBe(job.session.jobId);
  expect(strictAttached.attachment).toEqual(expected);
  expect(installs).toBe(2);
  strictAttached.stop();

  await expect(h.openJob({...options, ...({reuseOnly: {expected}} as unknown as JobHubJobOptions)}))
    .rejects.toMatchObject({code: 'JOB_REQUEST_INVALID'});
});
