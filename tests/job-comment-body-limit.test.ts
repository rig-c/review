import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {syntheticPinnedFeedback} from './helpers/job-pinned-comments.ts';
import {jobHash, parseCommentsAct} from '../src/job-api.ts';
import {jobRawActMediaType} from '../src/job-contract.ts';
import {jobCropReferences, JobStore} from '../src/job-store.ts';
import {feedbackItemComments} from '../src/stage-comment.ts';
import {jobCommand} from '../src/job-cli.ts';
import {jobWindowEvents} from '../web/job-session.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {JobSession} from '../src/job-session.ts';
import {bindJobAsk, finalizeJobAct} from '../src/job-act.ts';
import type {JobPendingAsk, JobUISubmission} from '../src/job-contract.ts';
import {createJobFront} from '../src/job-front.ts';

useTemporaryReviewState();
for (const count of [1, 3, 6, 12]) test(`#790 finalized ${count}-pin rig verdict preserves exact full acts through every consumer`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const {input, publication} = await rigStillInput(f);
    if (!publication.source.model) throw new Error('synthetic model missing');
    const feedback = syntheticPinnedFeedback({...publication.source, model: publication.source.model}, count);
    const payload = {...input, value: {stage: 'rig-review', verdict: 'changes-requested', words: '', feedback}};
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    if (!saved.ok) throw new Error(saved.error.code + ': ' + saved.error.message);
    const act = parseCommentsAct(saved.value), raw = JSON.stringify(saved.value), hash = jobHash(raw);
    expect(act.value.comments).toEqual(feedbackItemComments(feedback));
    const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: act.actId},
      f.session.writerGrant().fetchCapability)).json();
    expect(jobHash(JSON.stringify(fetched.value))).toBe(hash);
    expect(jobHash(f.session.readActExport(act.actId, false))).toBe(hash);
    const nextResponse = await f.call({...f.base(), verb: 'next', after: null, waitMs: 0});
    const nextText = await nextResponse.text(), next = JSON.parse(nextText);
    const event = next.value.events.find((event: {type: string}) => event.type === 'act');
    expect(jobHash(JSON.stringify(event.act))).toBe(hash);
    const nextOutput: string[] = [];
    await jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--wait-ms', '0'], {
      agentCapability: f.credentials.agent, write: text => {nextOutput.push(text);},
      fetch: (async (url: string | URL | Request, init?: RequestInit) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
    });
    expect(jobHash(JSON.stringify(JSON.parse(nextOutput[0]!).value.events.find((entry: {type: string}) => entry.type === 'act').act))).toBe(hash);

    const rawRequest = new Request(f.origin + `/jobs/${f.session.jobId}/api`, {method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: jobRawActMediaType,
        Authorization: 'Bearer ' + f.session.writerGrant().fetchCapability},
      body: JSON.stringify({...f.base(), verb: 'fetch-act', actId: act.actId})});
    expect(jobHash(await (await f.ports.handleJobApi(rawRequest)).text())).toBe(hash);
    const state = f.session.attestation().stateDir;
    const db = new Database(join(state, 'jobs.sqlite'), {readonly: true});
    try {
      expect(db.query('SELECT count(*) AS n FROM job_comment_crops').get()).toEqual({n: 1});
      const document = db.query<{document: string}, []>('SELECT document FROM jobs').get()!.document;
      expect(document).not.toContain('data:image/png;base64,');
      expect(document).toContain('job-crop:');
    } finally {db.close();}
    const stream = jobCropReferences(event) + '\n';
    const crop = (feedback[0]!.context as unknown as {comment: {crop: {png: string; sha256: string}}}).comment.crop;
    const access = {jobId: f.session.jobId, base: f.origin + '/jobs/' + f.session.jobId, capability: f.credentials.ui, route: (path: string) => f.origin + `/jobs/${f.session.jobId}/` + path,
      headers: () => new Headers({'X-Review-Capability': f.credentials.ui})};
    const front = createJobFront({origin: f.origin, ports: f.ports, resource: async () => ''});
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/events')) return new Response(stream);
      return front.fetch(new Request(url, init));
    }) as typeof fetch;
    for await (const restored of jobWindowEvents(access, null, new AbortController().signal, fetcher)) {
      expect(restored.type).toBe('act');
      expect(jobHash(JSON.stringify((restored as typeof event).act))).toBe(hash);
    }
    if (count === 12) {
      const url = access.route('comment-crops/' + crop.sha256 + '.png');
      expect((await front.fetch(new Request(url)))!.status).toBe(403);
      expect((await front.fetch(new Request(url, {headers: {...Object.fromEntries(access.headers()),
        Origin: 'https://example.invalid'}})))!.status).toBe(403);
      const unknown = await front.fetch(new Request(access.route('comment-crops/' + '0'.repeat(64) + '.png'),
        {headers: access.headers()}));
      expect(unknown!.status).toBe(409);
    }
    front.stop();
    expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload)))).toEqual(saved);
    // CLI raw-act output exercises its actual 512 KiB predecessor boundary.
    const chunks: Uint8Array[] = [];
    await mkdir(join(f.scratch, 'still'));
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId, '--still-out', join(f.scratch, 'still')], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(bytes) {chunks.push(bytes.slice()); return bytes.length;},
    });
    expect(jobHash(Buffer.concat(chunks))).toBe(hash);
    const reopened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner'}});
    try {expect(jobHash(reopened.readActExport(act.actId, false))).toBe(hash);}
    finally {reopened.dispose();}
    console.log(JSON.stringify({count, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      actBytes: Buffer.byteLength(raw), eventBytes: Buffer.byteLength(JSON.stringify(event)),
      nextResponseBytes: Buffer.byteLength(nextText), nextCLIBytes: Buffer.byteLength(nextOutput[0]!),
      rawCLIBytes: Buffer.concat(chunks).length, browserEventBytes: Buffer.byteLength(stream), inlineCropChars: crop.png.length,
      hash, status: 200, ports: ['fetch-act', 'export', 'next', 'raw', 'cli', 'browser-hydrated']}));
  } finally {await f.close();}
});

for (const count of [1, 6, 12]) test(`#790 ${count} pointed parts comments pass the authenticated non-capture request and event boundaries`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const parts = await syntheticJobParts(f, {project: true, painting: true});
    await writeFile(join(f.root, 'out/parts.json'), JSON.stringify({rig_size: [30, 20], parts: [
      {name: 'body', x: 0, y: 0, w: 20, h: 20}, {name: 'head', x: 10, y: 0, w: 20, h: 20}]}));
    parts.manifest.sha256 = jobHash(await readFile(join(f.root, 'out/parts.json')));
    f.setContext({...f.getContext(), parts});
    const publication = await f.publish(), ask = await f.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-draft'});
    const page = await f.display(publication), retained = f.session.retainedSource(publication.publicationId);
    const pkg = await loadPartsView(join(retained.snapshotRoot, 'out'));
    const crop = (syntheticPinnedFeedback({sourceHash: publication.source.sourceHash,
      package: publication.source.package, model: {sha256: 'a'.repeat(64)}}, 1)[0]!.context as unknown as
      {comment: {crop: {path: string; sha256: string; png: string; width: number; height: number}}}).comment.crop;
    const prepared = await preparePartsComment(pkg, {schema: 'rig-review-parts-comment/2', id: 'assembled-0',
      summary: 'Synthetic overlap', parts: ['body', 'head'].map(name => ({name,
        imageHash: parts.images.find(image => image.path === `parts/${name}.png`)!.sha256})),
      sourceHash: publication.source.sourceHash, rigRegion: {x: 1, y: 2, width: 3, height: 4}, imageRegion: null,
      view: {mode: 'assembled', cameraSync: false, referenceCamera: null,
        camera: {zoom: 1, center: {x: 10, y: 10}, viewport: {width: 100, height: 100}},
        background: 'checker', alpha: false, footprints: true, mesh: false}, crop, nativeCrop: null},
      false, {sourceHash: publication.source.sourceHash});
    const issues = Array.from({length: count}, (_, i) => ({...structuredClone(prepared), id: 'assembled-' + i}));
    const payload = {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: 'parts-pins', kind: 'parts-verdict', value: {verdict: 'changes-requested', words: '', issues}};
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    if (!saved.ok) throw new Error(saved.error.code + ': ' + saved.error.message);
    const raw = JSON.stringify(saved.value), hash = jobHash(raw);
    expect(parseCommentsAct(saved.value).value.comments).toEqual(issues.map(({summary, ...anchor}) => ({text: summary, anchor})));
    expect(jobHash(f.session.readActExport(saved.value.actId, false))).toBe(hash);
    const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId},
      f.session.writerGrant().fetchCapability)).json();
    expect(jobHash(JSON.stringify(fetched.value))).toBe(hash);
    const nextResponse = await f.call({...f.base(), verb: 'next', after: null, waitMs: 0});
    const nextText = await nextResponse.text(), next = JSON.parse(nextText);
    const event = next.value.events.find((event: {type: string}) => event.type === 'act');
    expect(jobHash(JSON.stringify(event.act))).toBe(hash);
    const nextOutput: string[] = [];
    await jobCommand(['next', f.origin + '/jobs/' + f.session.jobId, '--wait-ms', '0'], {
      agentCapability: f.credentials.agent, write: text => {nextOutput.push(text);},
      fetch: (async (url: string | URL | Request, init?: RequestInit) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
    });
    expect(jobHash(JSON.stringify(JSON.parse(nextOutput[0]!).value.events.find((entry: {type: string}) => entry.type === 'act').act))).toBe(hash);

    const chunks: Uint8Array[] = [];
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', saved.value.actId], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(bytes) {chunks.push(bytes.slice()); return bytes.length;},
    });
    expect(jobHash(Buffer.concat(chunks))).toBe(hash);
    console.log(JSON.stringify({kind: 'parts-verdict', count, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      actBytes: Buffer.byteLength(raw), eventBytes: Buffer.byteLength(JSON.stringify(event)),
      nextResponseBytes: Buffer.byteLength(nextText), nextCLIBytes: Buffer.byteLength(nextOutput[0]!),
      rawCLIBytes: Buffer.concat(chunks).length, browserEventBytes: Buffer.byteLength(jobCropReferences(event)), hash, status: 200}));
  } finally {await f.close();}
});

test('#790 direction verdict retains its closed no-image-comment submission at 12-pin size', async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const {input, publication} = await rigStillInput(f);
    const feedback = syntheticPinnedFeedback({...publication.source, model: publication.source.model!}, 12);
    const base = f.session.retainedSource(publication.publicationId);
    const retained = {...base, source: {...base.source, selector: {kind: 'post' as const, version: 2, rigVersion: 1},
      direction: {path: 'out/direction.json', sha256: 'd'.repeat(64)}}} as typeof base;
    const subject = {kind: 'review-verdict', stage: 'direction-review'} as const;
    const ask: JobPendingAsk = {askId: input.askId, publicationId: publication.publicationId, subject,
      source: bindJobAsk(subject, retained), status: 'pending'};
    const {capture: _capture, ...withoutCapture} = input;
    const submission = {...withoutCapture, value: {stage: 'direction-review', verdict: 'changes-requested',
      words: '', feedback}} as unknown as JobUISubmission;
    expect(Buffer.byteLength(JSON.stringify(submission))).toBeGreaterThan(1024 * 1024);
    expect(() => finalizeJobAct({jobId: f.session.jobId, submission, ask, retained,
      reviewer: {id: 'declared-owner', role: 'owner'}})).toThrow('JOB_REQUEST_INVALID');
  } finally {await f.close();}
});

test('#790 crop storage preserves literal marker-shaped data and rolls blobs back with refused state', async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  const store = new JobStore<Record<string, unknown>>(join(f.scratch, 'crop-store'));
  try {
    const row = syntheticPinnedFeedback({sourceHash: 'a'.repeat(64), package: {id: 'synthetic'},
      model: {sha256: 'b'.repeat(64)}}, 1)[0]!;
    const crop = (row.context as unknown as {comment: {crop: Record<string, unknown>}}).comment.crop;
    const opened = store.open('synthetic', () => ({}));
    expect(() => store.update(opened.jobId, null, () => ({data: {crop, invalid: undefined}}))).toThrow('JOB_STORAGE_FAILED');
    const db = new Database(join(f.scratch, 'crop-store/jobs.sqlite'), {readonly: true});
    try {expect(db.query('SELECT count(*) AS n FROM job_comment_crops').get()).toEqual({n: 0});}
    finally {db.close();}
    const data = {crop, literal: {...crop, png: 'job-crop:' + crop.sha256}};
    store.update(opened.jobId, null, () => ({data}));
    expect(store.get(opened.jobId).data).toEqual(data);
  } finally {store.close(); await f.close();}
});
