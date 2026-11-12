import {afterEach, expect, test} from 'bun:test';
import {startJobHub, startJobHost, JOB_API_SCHEMA, type JobOwnerHub, type JobHubJob} from '../src/job-host.ts';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {jobBodyLimit} from '../src/job-api.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [], hubs: JobOwnerHub[] = [];
const reviewer = {id: 'declared-owner', role: 'owner' as const};
afterEach(async () => {for (const h of hubs.splice(0)) await h.stop(); for (const f of fixtures.splice(0)) await f.close();});
async function fixture() {const f = await jobFixture(); fixtures.push(f); return f;}
async function setup() {
  const first = await fixture(), second = await fixture();
  const h = await startJobHub({stateDir: first.state, reviewer}); hubs.push(h);
  const options = (f: typeof first) => ({root: f.root, fingerprint: 'f'.repeat(64), readPublished: async () => f.getContext(), readerId: 'security-reader/1'});
  const a = await h.openJob(options(first)), b = await h.openJob(options(second));
  const owner = new URL(h.ownerUrl), incarnation = owner.searchParams.get('workspace')!, capability = owner.hash.slice(5);
  async function open(jobId = a.session.jobId, changes: {body?: string; token?: string; origin?: string | null; query?: string} = {}) {
    return fetch(h.origin + '/hub/api/jobs/' + jobId + '/open' + (changes.query ?? ''), {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Review-Capability': changes.token ?? capability,
        ...(changes.origin === null ? {} : {Origin: changes.origin ?? h.origin})},
      body: changes.body ?? JSON.stringify({schema: 'rig-review-job-hub/1', incarnation})});
  }
  return {first, second, h, a, b, options, owner, incarnation, capability, open};
}
async function list(h: JobOwnerHub, token: string) {
  const response = await fetch(h.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': token}});
  expect(response.status).toBe(200); return response.json();
}
async function api(job: JobHubJob, value: Record<string, unknown>) {
  return fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + job.session.hostCredentials().agent},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: 'security-request', ...value})});
}

test('owner list stays source-bound while selected bootstrap grants only that live job UI access', async () => {
  const f = await setup(), before = await jobInputHashes(f.first.root);
  const publication = await (await api(f.a, {...await f.first.publishRequest(), jobId: f.a.session.jobId})).json(); expect(publication.ok).toBe(true);
  expect((await api(f.a, {verb: 'ask', expectedGeneration: 1, idempotencyKey: 'pending',
    publicationId: publication.value.publicationId, subject: {kind: 'checkpoint', checkpointId: 'step-one'}})).status).toBe(200);
  const current = await list(f.h, f.capability);
  expect(current.limit).toBe(32);
  expect(current.jobs[0]).toMatchObject({jobId: f.a.session.jobId, generation: 2, pendingCount: 1,
    publication: {publicationId: publication.value.publicationId, sourceHash: publication.value.source.sourceHash}});
  const serialized = JSON.stringify(current);
  for (const secret of [f.first.root, f.second.root, ...Object.values(f.a.session.hostCredentials()), f.a.session.writerGrant().fetchCapability]) expect(serialized).not.toContain(secret);
  const selected = await f.open(), grant = await selected.json(); expect(selected.status).toBe(200);
  expect(grant.capability).toBe(f.a.session.hostCredentials().ui);
  expect(grant.entry).toBe('/jobs/' + f.a.session.jobId + '/?hub=' + f.incarnation);
  expect(JSON.stringify(grant)).not.toContain(f.a.session.writerGrant().fetchCapability);
  expect(JSON.stringify(grant)).not.toContain(f.first.root);
  for (const token of [...Object.values(f.a.session.hostCredentials()), f.a.session.writerGrant().fetchCapability]) expect((await f.open(undefined, {token})).status).toBe(403);
  expect((await f.open('unknown-job')).status).toBe(404);
  for (const origin of [null, 'http://127.0.0.1:1']) expect((await f.open(undefined, {origin})).status).toBe(403);
  expect((await f.open(undefined, {query: '?debug=1'})).status).toBe(400);
  expect((await f.open(undefined, {body: JSON.stringify({schema: current.schema, incarnation: 'other'})})).status).toBe(400);
  expect((await f.open(undefined, {body: JSON.stringify({schema: current.schema, incarnation: f.incarnation, root: f.first.root})})).status).toBe(400);
  expect((await f.open(undefined, {body: 'x'.repeat(jobBodyLimit + 1)})).status).toBe(413);
  const crossJob = await fetch(f.h.origin + '/jobs/' + f.b.session.jobId + '/ui/displayed', {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: f.h.origin, 'X-Review-Capability': grant.capability}, body: '{}'});
  expect(crossJob.status).toBe(403);
  expect(await jobInputHashes(f.first.root)).toEqual(before);
});

test('member embedding grants frame ancestors only to its validated landing query and keeps other queries closed', async () => {
  const f = await setup(), grant = await (await f.open()).json(), base = f.h.origin + '/jobs/' + f.a.session.jobId + '/';
  for (const query of ['', '?lang=en', '?lang=ko']) {
    const response = await fetch(base + query); expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'"); await response.body?.cancel();
  }
  for (const query of ['?hub=' + f.incarnation, '?hub=' + f.incarnation + '&lang=ko', '?lang=en&hub=' + f.incarnation]) {
    const response = await fetch(base + query); expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'"); await response.body?.cancel();
  }
  for (const suffix of ['?hub=other', '?hub=' + f.incarnation + '&hub=' + f.incarnation,
    '?hub=' + f.incarnation + '&lang=en&lang=ko', '?hub=' + f.incarnation + '&extra=1', '?hub=' + f.incarnation + '&lang=other',
    'main.js?hub=' + f.incarnation, 'styles.css?lang=en', 'publications/unknown?hub=' + f.incarnation,
    'publications/unknown/instances/' + 'a'.repeat(64) + '/assets/model.json?hub=' + f.incarnation]) {
    const response = await fetch(base + suffix); expect(response.status).toBe(400); await response.body?.cancel();
  }
  const directInput = await fixture();
  const direct = await startJobHost({...f.options(directInput), stateDir: directInput.state, reviewer});
  try {expect((await fetch(direct.origin + '/jobs/' + direct.session.jobId + '/?hub=' + f.incarnation)).status).toBe(400);}
  finally {direct.stop();}
  // Hash credentials are not sent over HTTP and cannot grant API authority.
  for (const query of ['?workspace=' + f.incarnation, '?workspace=' + f.incarnation + '&lang=en',
    '?lang=ko&workspace=' + f.incarnation, '?%77orkspace=' + f.incarnation + '&lang=%65n',
    '?workspace=' + f.incarnation + '&']) {
    for (const hash of ['', '#cap=' + f.capability, '#review=' + f.capability]) {
      const response = await fetch(f.h.origin + '/hub/' + query + hash);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      await response.body?.cancel();
    }
  }
  for (const hash of ['#cap=' + f.capability, '#review=' + f.capability]) {
    expect((await fetch(f.h.origin + '/hub/api/jobs' + hash)).status).toBe(403);
    for (const query of ['', '?lang=en', '?hub=' + f.incarnation + '&lang=ko']) {
      const response = await fetch(base + query + hash);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      await response.body?.cancel();
    }
  }
  const owner = await fetch(f.h.ownerUrl); expect(owner.status).toBe(200); const html = await owner.text(); expect(html).toContain('<div id="app"></div>');
  expect(html).not.toContain(grant.capability);
  for (const query of ['', '?lang=en', '?lang=ko', '?workspace=',
    '?workspace=' + f.incarnation + '&lang=', '?workspace=' + f.incarnation + '&lang=EN',
    '?workspace=' + f.incarnation + '&lang=en&lang=ko', '?workspace=' + f.incarnation + '&cap=secret',
    '?workspace=' + f.incarnation + '&review=secret', '?workspace=other', '?workspace=' + f.incarnation + '&workspace=' + f.incarnation, '?workspace=' + f.incarnation + '&extra=1']) {
    expect((await fetch(f.h.origin + '/hub/' + query)).status).toBe(400);
  }
  expect((await fetch(f.h.origin + '/hub/styles.css?debug=1')).status).toBe(400);
  expect((await fetch(f.h.origin + '/hub/main.js?debug=1')).status).toBe(400);
});

test('closed jobs remain factual list entries and restart changes the owner document/grant incarnation', async () => {
  const f = await setup();
  expect((await api(f.a, {verb: 'close', expectedGeneration: 0, idempotencyKey: 'close', reason: 'synthetic close'})).status).toBe(200);
  expect((await f.open()).status).toBe(409);
  expect((await list(f.h, f.capability)).jobs.map((row: {status: string}) => row.status)).toEqual(['closed', 'active']);
  expect((await f.open(f.b.session.jobId)).status).toBe(200);
  await f.h.stop();
  const next = await startJobHub({stateDir: f.first.state, port: Number(f.owner.port), reviewer}); hubs.push(next);
  expect(next.origin).toBe(f.h.origin);
  const owner = new URL(next.ownerUrl); expect(owner.search).not.toBe(f.owner.search); expect(owner.hash).not.toBe(f.owner.hash);
  expect((await fetch(f.h.ownerUrl)).status).toBe(400);
  expect((await fetch(next.ownerUrl)).status).toBe(200);
  expect((await fetch(next.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': f.capability}})).status).toBe(403);
});

test('a cancelled incomplete selected-bootstrap body does not change membership or strand shutdown', async () => {
  const f = await setup(), controller = new AbortController();
  let started!: () => void;
  const sending = new Promise<void>(resolve => {started = resolve;});
  const body = new ReadableStream<Uint8Array>({start(stream) {stream.enqueue(new TextEncoder().encode('{')); started();}});
  const pending = fetch(f.h.origin + '/hub/api/jobs/' + f.a.session.jobId + '/open', {method: 'POST', body,
    headers: {'Content-Type': 'application/json', Origin: f.h.origin, 'X-Review-Capability': f.capability}, signal: controller.signal})
    .then(response => response.body?.cancel(), error => error.name);
  await sending; controller.abort(); expect(await pending).toBe('AbortError');
  expect((await list(f.h, f.capability)).jobs).toHaveLength(2);
  await f.h.stop();
});
