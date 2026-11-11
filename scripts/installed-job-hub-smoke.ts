/** Installed semantic hub proof. The consumer imports only the shipped public facade. */
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {jobInputHashes} from '../tests/helpers/job-api-fixture.ts';
import {redactCapability} from './redact.ts';

const consumerSource = String.raw`
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startJobHub, JOB_API_SCHEMA, JOB_ACT_SCHEMA, type JobHubOptions, type JobHubJobOptions,
 type JobHubJob, type JobOwnerHub, type JobPublishedContext, type JobAgentRequest,
 type JobApiResponse, type JobPublication, type JobPendingAsk} from '@rig-c/review/job-host';
export type PublicHubTypes = [JobHubOptions, JobHubJobOptions, JobHubJob, JobOwnerHub];
const root = process.argv[2]!;
const reviewer = {id: 'installed-hub-owner', role: 'owner' as const};
const options: JobHubOptions = {stateDir: join(root, 'state'), reviewer};
const jobs: JobHubJob[] = [], publications: JobPublication[] = [], asks: JobPendingAsk[] = [];
const bindings = new Map<string, {origin: string; fetchCapability: string}>();
const bindingCalls = new Map<string, number>();
const proofs: Record<string, unknown> = {};
function proof(name: string, value: unknown) {proofs[name] = value; console.log(JSON.stringify({name, value}));}
const context: JobPublishedContext = {selector: null, plan: {steps: [{id: 'installed-step', hash: '1'.repeat(64)}]},
 parts: null, subjects: [{kind: 'checkpoint', checkpointId: 'installed-step'}], partIds: [], files: []};
function designation(index: number): JobHubJobOptions {
 const input = join(root, 'input-' + index);
 return {root: input, fingerprint: 'f'.repeat(64), readerId: 'installed-hub-reader/1', bindingId: 'installed-hub-writer/1',
  readPublished: async value => {assert.equal(value.root, input); assert.equal(value.record.path, 'record.json'); return context;},
  installWriterBinding: value => {bindings.set(value.jobId, {origin: value.origin, fetchCapability: value.fetchCapability});
   bindingCalls.set(value.jobId, (bindingCalls.get(value.jobId) ?? 0) + 1);}};
}
let hub: JobOwnerHub | undefined;
async function ownerList() {
 const owner = new URL(hub!.ownerUrl);
 const response = await fetch(hub!.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': owner.hash.slice(5)}});
 assert.equal(response.status, 200);
 return response.json() as Promise<{jobs: {jobId: string; generation: number; status: string; pendingCount: number}[]}>;
}
async function api(job: JobHubJob, request: JobAgentRequest): Promise<JobApiResponse> {
 const response = await fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST',
  headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + job.session.hostCredentials().agent},
  body: JSON.stringify(request)});
 const value: JobApiResponse = await response.json();
 assert.equal(value.schema, JOB_API_SCHEMA); assert.equal(response.status, 200); assert.ok(value.ok);
 return value;
}
function base(job: JobHubJob) {return {schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: randomUUID()};}
async function inventory(name: string) {
 const listing = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']); assert.equal(listing.exitCode, 0);
 const rows = listing.stdout.toString().split('\n').flatMap(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  return match ? [{pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!}] : [];
 });
 const owned = new Set([process.pid]);
 for (let index = 0; index < rows.length; index++) for (const row of rows)
  if (owned.has(row.ppid) && row.pid !== listing.pid) owned.add(row.pid);
 const residents = rows.filter(row => owned.has(row.pid));
 const sockets = Bun.spawnSync(['lsof', '-nP', '-a', '-p', [...owned].join(','), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
 assert.equal(sockets.exitCode, 0);
 const listeners = sockets.stdout.toString().split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
 proof(name, {residents, listeners, harnessExcluded: true});
 assert.deepEqual(residents.map(row => row.pid), [process.pid]);
 assert.deepEqual(listeners, ['127.0.0.1:' + new URL(hub!.origin).port]);
}
async function resources() {
 const owner = new URL(hub!.ownerUrl), rows = [];
 for (const [path, type] of [[owner.pathname + owner.search, 'text/html'],
  ['/hub/styles.css', 'text/css'], ['/hub/main.js', 'text/javascript']]) {
  const response = await fetch(hub!.origin + path), body = await response.text();
  rows.push({path, status: response.status, type: response.headers.get('content-type'), bytes: body.length});
  assert.ok(response.ok && response.headers.get('content-type')?.includes(type!) && body.length > 0);
  if (type === 'text/html') assert.ok(body.includes('<div id="app"></div>'));
 }
 const selected = await fetch(hub!.origin + '/hub/api/jobs/' + jobs[0]!.session.jobId + '/open', {method: 'POST',
  headers: {Origin: hub!.origin, 'Content-Type': 'application/json', 'X-Review-Capability': owner.hash.slice(5)},
  body: JSON.stringify({schema: 'rig-review-job-hub/1', incarnation: owner.searchParams.get('workspace')})});
 assert.equal(selected.status, 200);
 const grant = await selected.json() as {entry: string; capability: string; jobId: string};
 assert.equal(grant.jobId, jobs[0]!.session.jobId); assert.ok(/^[a-f0-9]{64}$/.test(grant.capability));
 const landing = await fetch(hub!.origin + grant.entry + '&lang=en');
 const html = await landing.text(), csp = landing.headers.get('content-security-policy');
 assert.equal(landing.status, 200); assert.ok(html.includes('data-job-window')); assert.ok(csp?.includes("frame-ancestors 'self'"));
 const direct = await fetch(jobs[0]!.jobUrl.split('#')[0]); await direct.body?.cancel();
 assert.ok(direct.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
 for (const path of ['job.js', 'styles.css']) {
  const response = await fetch(hub!.origin + '/jobs/' + grant.jobId + '/' + path), body = await response.text();
  assert.ok(response.ok && body.length > 0); rows.push({path, status: response.status, type: response.headers.get('content-type'), bytes: body.length});
 }
 proof('packaged-resources', {rows, selectedStatus: selected.status, memberStatus: landing.status, memberCSP: csp,
  directCSP: direct.headers.get('content-security-policy'), capabilityShape: true});
}
try {
 assert.equal(JOB_API_SCHEMA, 'rig-review/job-api@2'); assert.equal(JOB_ACT_SCHEMA, 'rig-review/act@2');
 hub = await startJobHub(options);
 const owner = new URL(hub.ownerUrl); assert.equal(owner.pathname, '/hub/'); assert.ok(owner.searchParams.get('workspace'));
 for (let index = 0; index < 9; index++) {
  const job: JobHubJob = await hub.openJob(designation(index)); jobs.push(job);
  const record = await readFile(join(root, 'input-' + index, 'record.json'));
  const published = await api(job, {...base(job), verb: 'publish', expectedGeneration: 0, idempotencyKey: 'publish',
   result: {path: 'review.json', selector: null}, freeze: {kind: 'producer-held', holdId: 'installed-synthetic-held',
    record: {path: 'record.json', sha256: createHash('sha256').update(record).digest('hex')}}});
  assert.ok(published.verb === 'publish' && published.ok); publications.push(published.value);
  const asked = await api(job, {...base(job), verb: 'ask', expectedGeneration: published.generation, idempotencyKey: 'ask',
   publicationId: published.value.publicationId, subject: {kind: 'checkpoint', checkpointId: 'installed-step'}});
  assert.ok(asked.verb === 'ask' && asked.ok); asks.push(asked.value);
 }
 const list = await ownerList();
 proof('nine-independent', {jobs: list.jobs, uniqueJobs: new Set(jobs.map(job => job.session.jobId)).size,
  uniquePublications: new Set(publications.map(value => value.publicationId)).size,
  uniqueAsks: new Set(asks.map(value => value.askId)).size, uniqueWriterGrants: new Set([...bindings.values()].map(value => value.fetchCapability)).size});
 assert.equal(list.jobs.length, 9); assert.equal(new Set(jobs.map(job => job.session.jobId)).size, 9);
 assert.equal(new Set(publications.map(value => value.publicationId)).size, 9); assert.equal(new Set(asks.map(value => value.askId)).size, 9);
 assert.equal(new Set([...bindings.values()].map(value => value.fetchCapability)).size, 9);
 assert.ok(list.jobs.every(row => row.generation === 2 && row.pendingCount === 1));
 await inventory('nine-process-listener'); await resources();
 const reused = await hub.openJob(designation(0)); assert.ok(reused.reused); assert.equal(reused.session.jobId, jobs[0]!.session.jobId);
 assert.equal(hub.ownerUrl, owner.href);
 let mismatch = '';
 try {await hub.openJob({...designation(0), readerId: 'installed-hub-reader/changed'});}
 catch (error) {if (error && typeof error === 'object' && 'code' in error) mismatch = String(error.code); else throw error;}
 assert.equal(mismatch, 'JOB_HOST_REUSE_MISMATCH');
 proof('reuse-and-mismatch', {sameJob: true, sameOwnerURL: true, mismatch});
 const survivor = jobs[0]!.session.status();
 const closed = await api(jobs[8]!, {...base(jobs[8]!), verb: 'close', expectedGeneration: 2, idempotencyKey: 'close', reason: 'installed close-one control'});
 assert.ok(closed.verb === 'close' && closed.ok); assert.deepEqual(jobs[0]!.session.status(), survivor);
 assert.equal((await ownerList()).jobs.filter(row => row.status === 'active').length, 8);
 proof('close-one', {closedJob: jobs[8]!.session.jobId, othersActive: 8, otherPendingUnchanged: true});
 const oldURL = hub.ownerUrl, statuses = jobs.slice(0, 8).map(job => job.session.status());
 const credentials = jobs.slice(0, 8).map(job => job.session.hostCredentials());
 const writers = jobs.slice(0, 8).map(job => bindings.get(job.session.jobId)!.fetchCapability);
 const calls = jobs.slice(0, 8).map(job => bindingCalls.get(job.session.jobId)!);
 const oldOrigin = hub.origin;
 await hub.stop();
 let stopped = false; try {await fetch(oldOrigin + '/hub/api/jobs');} catch {stopped = true;}
 assert.ok(stopped, 'await stop removes its listener');
 hub = await startJobHub(options);
 for (let index = 0; index < 8; index++) {
  const restored: JobHubJob = await hub.openJob(designation(index));
  assert.equal(restored.session.jobId, statuses[index]!.jobId);
  assert.deepEqual(restored.session.status(), statuses[index]);
  assert.ok(JSON.stringify(restored.session.hostCredentials()) === JSON.stringify(credentials[index]), 'retained per-job grants');
  assert.ok(bindings.get(restored.session.jobId)!.fetchCapability === writers[index], 'retained writer grant');
  assert.equal(bindings.get(restored.session.jobId)!.origin, hub.origin);
  assert.equal(bindingCalls.get(restored.session.jobId), calls[index]! + 1);
  jobs[index] = restored;
 }
 const fresh = new URL(hub.ownerUrl), prior = new URL(oldURL);
 assert.notEqual(fresh.search, prior.search); assert.ok(fresh.hash !== prior.hash);
 const stale = await fetch(hub.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': prior.hash.slice(5)}});
 await stale.body?.cancel(); assert.equal(stale.status, 403);
 assert.equal((await ownerList()).jobs.length, 8);
 proof('restart', {oldOrigin, origin: hub.origin, activeJobIdsRetained: true, generationsPendingRetained: true,
  jobGrantsRetained: true, writerGrantsRetained: true, writerOriginsRefreshed: true, callbacksRegisteredAgain: 8,
  hubURLQueryAndGrantRotated: true, staleGrantStatus: stale.status, transportStopDidNotCloseJobs: true});
 await inventory('restart-process-listener');
} finally {await hub?.stop();}
proof('complete', {status: 'PASS', pid: process.pid, installedPublicSpecifier: '@rig-c/review/job-host',
 api: JOB_API_SCHEMA, act: JOB_ACT_SCHEMA, listenerStopped: true, noUIActsClaimed: true});
`;

export async function installedJobHubSmoke(options: {app: string; work: string; log(line: string): void; evidence?: string}) {
  const root = await realpath(await mkdtemp(join(options.work, 'installed-job-hub-')));
  const installedRoot = join(options.app, 'node_modules/@rig-c/review');
  const receipts: unknown[] = [];
  let child: Bun.Subprocess | undefined;
  async function save() {
    if (options.evidence) {
      await mkdir(options.evidence, {recursive: true});
      await writeFile(join(options.evidence, 'commands.json'), JSON.stringify(receipts, null, 2));
    }
  }
  async function run(command: string[]) {
    const running = Bun.spawn(command, {cwd: options.app, stdout: 'pipe', stderr: 'pipe'});
    child = running;
    const started = performance.now();
    const terminate = setTimeout(() => child?.kill('SIGTERM'), 180_000);
    const force = setTimeout(() => child?.kill('SIGKILL'), 185_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]);
      const receipt = {command, exit, elapsedSeconds: (performance.now() - started) / 1000,
        stdout: redactCapability(stdout), stderr: redactCapability(stderr)};
      receipts.push(receipt); await save();
      assert.equal(exit, 0, receipt.stderr || receipt.stdout);
      return receipt;
    } finally {clearTimeout(terminate); clearTimeout(force);}
  }
  try {
    const manifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@rig-c/review');
    const inputs = [];
    for (let index = 0; index < 9; index++) {
      const input = join(root, 'input-' + index); inputs.push(input);
      await cp(join(installedRoot, 'examples/demo'), input, {recursive: true});
      const path = join(input, 'review.json'), value = JSON.parse(await readFile(path, 'utf8'));
      value.id = 'installed-hub-' + index; value.revision = String(index + 1);
      await writeFile(path, JSON.stringify(value));
      await writeFile(join(input, 'record.json'), JSON.stringify({syntheticProducerRecord: index}) + '\n');
    }
    const before = await Promise.all(inputs.map(jobInputHashes));
    const consumer = join(options.app, 'installed-job-hub-consumer.ts');
    await writeFile(consumer, consumerSource);
    if (options.evidence) {
      await mkdir(options.evidence, {recursive: true});
      await writeFile(join(options.evidence, 'consumer.ts'), consumerSource);
    }
    await run([process.execPath, join(options.app, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM,DOM.Iterable',
      '--allowImportingTsExtensions', '--types', 'bun', consumer]);
    const runtime = await run([process.execPath, consumer, root]);
    const after = await Promise.all(inputs.map(jobInputHashes));
    assert.deepEqual(after, before);
    if (options.evidence) await writeFile(join(options.evidence, 'proof.json'), JSON.stringify({
      installed: {name: manifest.name, version: manifest.version, exports: manifest.exports}, inputHashes: {before, after},
      proofs: runtime.stdout.trim().split('\n').map(line => JSON.parse(line)),
    }, null, 2));
    options.log('ok   installed public semantic hub:9 independent jobs, one listener, packaged UI, reuse/close/restart; API@2/act@2; no UI-act claim');
  } finally {
    if (child && child.exitCode === null) {child.kill('SIGKILL'); await child.exited;}
    await rm(root, {recursive: true, force: true});
  }
}
