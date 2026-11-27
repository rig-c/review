import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import {jobFixture, syntheticJobParts, growJobRigFixture} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';
import {syntheticPinnedFeedback} from './helpers/job-pinned-comments.ts';
import {jobHash, parseCommentOnlyAct, createJobHostPorts, jobBodyLimit} from '../src/job-api.ts';
import {jobRawActMediaType} from '../src/job-contract.ts';
import {jobCropReferences, JobStore} from '../src/job-store.ts';
import {feedbackContextComments, feedbackItemComments} from '../src/stage-comment.ts';
import {partsIssueComments} from '../src/feedback-export.ts';
import {jobCommand} from '../src/job-cli.ts';
import {jobWindowEvents} from '../web/job-session.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
import {loadPartsView} from '../src/parts-view.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {JobSession} from '../src/job-session.ts';
import {createJobFront} from '../src/job-front.ts';
import {PNG} from 'pngjs';
import {encodeBookmark} from '../web/inspection-persistence.ts';

useTemporaryReviewState();
for (const unavailable of [false, true]) test(`#790 close then consume reaches the act and closure with crop ${unavailable ? 'unavailable' : 'retained'}`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  const front = createJobFront({origin: f.origin, ports: f.ports, resource: async () => ''});
  try {
    const publication = await f.publish(), page = await f.display(publication);
    const feedback = syntheticPinnedFeedback({...publication.source, model: publication.source.model!}, 1);
    const payload = {...page, expectedGeneration: f.session.status().generation, submissionId: 'comment-pins',
      kind: 'comments' as const, value: {comments: feedbackContextComments(feedback)}};
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    if (!saved.ok) throw new Error(saved.error.code);
    const grant = f.session.writerGrant().fetchCapability, hash = jobHash(JSON.stringify(saved.value));
    const close = await f.call({...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'close-after-comment', reason: 'synthetic test complete'});
    expect((await close.json()).ok).toBe(true);
    const access = {jobId: f.session.jobId, base: f.origin + '/jobs/' + f.session.jobId, capability: f.credentials.ui,
      route: (path: string) => f.origin + `/jobs/${f.session.jobId}/` + path,
      headers: () => new Headers({'X-Review-Capability': f.credentials.ui})};
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      if (unavailable && String(url).includes('/comment-crops/')) return new Response(null, {status: 503});
      return front.fetch(new Request(url, init));
    }) as typeof fetch;
    const events = [];
    for await (const event of jobWindowEvents(access, null, new AbortController().signal, fetcher)) events.push(event);
    expect(events.map(event => event.type)).toEqual(['published', 'act', 'closed']);
    const act = events.find(event => event.type === 'act');
    if (!act || act.type !== 'act') throw new Error('missing act');
    if (unavailable) {
      const crop = (act.act as any).value.comments[0].anchor.context.comment.crop;
      expect(crop.png).toBeNull();
      expect(crop.unavailable).toBe('COMMENT_CROP_STATE_UNAVAILABLE: stored crop cannot be read');
      expect(jobHash(JSON.stringify(saved.value))).toBe(hash);
    } else expect(jobHash(JSON.stringify(act.act))).toBe(hash);
    const crop = (feedback[0]!.context as any).comment.crop;
    const url = access.route('comment-crops/' + crop.sha256 + '.png');
    expect(jobHash(Buffer.from(await (await front.fetch(new Request(url, {headers: access.headers()})))!.arrayBuffer()))).toBe(crop.sha256);
    expect((await front.fetch(new Request(url)))!.status).toBe(403);
    expect((await front.fetch(new Request(url, {headers: {...Object.fromEntries(access.headers()), Origin: 'https://example.invalid'}})))!.status).toBe(403);
    const revoked = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId}, grant)).json();
    expect(revoked.error.code).toBe('JOB_CLOSED');
    const mutation = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) expect(mutation.error.code).toBe('JOB_CLOSED');
  } finally {front.stop(); await f.close();}
});

for (const count of [1, 3, 6, 12]) test(`#790 finalized ${count}-pin rig comments preserve exact full acts through every consumer`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const publication = await f.publish(), page = await f.display(publication);
    if (!publication.source.model) throw new Error('synthetic model missing');
    const feedback = syntheticPinnedFeedback({...publication.source, model: publication.source.model}, count);
    const payload = {...page, expectedGeneration: f.session.status().generation, submissionId: 'comment-pins',
      kind: 'comments' as const, value: {comments: feedbackContextComments(feedback)}};
    const oversized = Buffer.byteLength(JSON.stringify(payload)) > jobBodyLimit;
    expect(oversized).toBe(count > 1);
    // The authenticated port keeps the ordinary comment body limit. Import the larger synthetic rows
    // through the in-process seam to exercise persisted delivery without relaxing admission.
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    if (oversized) expect(saved).toMatchObject({ok: false, error: {code: 'JOB_BODY_LIMIT'}});
    else if (!saved.ok) throw new Error(saved.error.code + ': ' + saved.error.message);
    const stored = saved.ok ? saved.value : await f.session.commitUIAct(payload);
    const act = parseCommentOnlyAct(stored), raw = JSON.stringify(stored), hash = jobHash(raw);
    expect(act.value.comments.map(({context, ...comment}) => {
      expect(context).not.toHaveProperty('subject');
      return comment;
    })).toEqual(feedbackItemComments(feedback));
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
    expect(await f.session.commitUIAct(payload)).toEqual(stored);
    const chunks: Uint8Array[] = [];
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId], {
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
      hash, portResult: saved.ok ? 'ok' : saved.error.code, readers: ['fetch-act', 'export', 'next', 'raw', 'cli', 'browser-hydrated']}));
  } finally {await f.close();}
});

for (const count of [1, 6, 12]) test(`#790 ${count} pointed Parts comments respect the request limit and round-trip through readers`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const parts = await syntheticJobParts(f, {project: true, painting: true});
    await writeFile(join(f.root, 'out/parts.json'), JSON.stringify({rig_size: [30, 20], parts: [
      {name: 'body', x: 0, y: 0, w: 20, h: 20}, {name: 'head', x: 10, y: 0, w: 20, h: 20}]}));
    parts.manifest.sha256 = jobHash(await readFile(join(f.root, 'out/parts.json')));
    f.setContext({...f.getContext(), parts});
    const publication = await f.publish();
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
    const payload = {...page, expectedGeneration: f.session.status().generation, submissionId: 'parts-pins',
      kind: 'comments' as const, value: {comments: partsIssueComments(issues)}};
    const oversized = Buffer.byteLength(JSON.stringify(payload)) > jobBodyLimit;
    expect(oversized).toBe(count > 1);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
    if (oversized) expect(saved).toMatchObject({ok: false, error: {code: 'JOB_BODY_LIMIT'}});
    else if (!saved.ok) throw new Error(saved.error.code + ': ' + saved.error.message);
    const act = parseCommentOnlyAct(saved.ok ? saved.value : await f.session.commitUIAct(payload));
    const raw = JSON.stringify(act), hash = jobHash(raw);
    expect(act.value.comments).toEqual(payload.value.comments);
    expect(jobHash(f.session.readActExport(act.actId, false))).toBe(hash);
    const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: act.actId},
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
    await jobCommand(['fetch-act', f.origin + '/jobs/' + f.session.jobId, '--act', act.actId], {
      consumerCapability: f.session.writerGrant().fetchCapability,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => f.ports.handleJobApi(new Request(url, init))) as typeof fetch,
      writeBytes(bytes) {chunks.push(bytes.slice()); return bytes.length;},
    });
    expect(jobHash(Buffer.concat(chunks))).toBe(hash);
    console.log(JSON.stringify({kind: act.kind, count, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      actBytes: Buffer.byteLength(raw), eventBytes: Buffer.byteLength(JSON.stringify(event)),
      nextResponseBytes: Buffer.byteLength(nextText), nextCLIBytes: Buffer.byteLength(nextOutput[0]!),
      rawCLIBytes: Buffer.concat(chunks).length, browserEventBytes: Buffer.byteLength(jobCropReferences(event)),
      hash, portResult: saved.ok ? 'ok' : saved.error.code}));
  } finally {await f.close();}
});

test('#790 a large legacy direction request with image feedback reaches the disabled-kind verdict gate', async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  try {
    const {input, publication} = await rigStillInput(f);
    const feedback = syntheticPinnedFeedback({...publication.source, model: publication.source.model!}, 12);
    const {capture: _capture, ...withoutCapture} = input;
    const submission = {...withoutCapture, value: {stage: 'direction-review', verdict: 'changes-requested', words: '', feedback}};
    expect(Buffer.byteLength(JSON.stringify(submission))).toBeGreaterThan(1024 * 1024);
    const before = f.session.status();
    expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submission)))
      .toMatchObject({ok: false, error: {code: 'JOB_ACT_KIND_DISABLED'}});
    expect(f.session.status()).toEqual(before);
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


/** Legal ancillary padding makes the server-side encoded crop ceiling exact; no browser raster claim. */
function singleRegionPng(length: number): Buffer {
  const image = new PNG({width: 192, height: 193});
  let seed = 791;
  for (let i = 0; i < image.data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image.data[i] = i % 4 === 3 ? 255 : seed >>> 24;
  }
  const bytes = PNG.sync.write(image), chunk = Buffer.alloc(length - bytes.length, 120);
  chunk.writeUInt32BE(chunk.length - 12, 0); chunk.write('tEXt', 4); chunk.write('pad\0', 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return Buffer.concat([bytes.subarray(0, -12), chunk, bytes.subarray(-12)]);
}

// The already-written large-region regression retained when the broader measurement was withdrawn.
for (const scenario of [
  {pane: 'rig', text: 1, slots: 24, cropBytes: 149982},
  {pane: 'reference', text: 1, slots: 0, cropBytes: 149982},
  {pane: 'rig', text: 1000, slots: 24, cropBytes: 149982},
  {pane: 'reference', text: 1000, slots: 0, cropBytes: 149982},
] as const) test(`#790 single-region ${scenario.pane} text=${scenario.text} slots=${scenario.slots} crop=${scenario.cropBytes}`, async () => {
  const f = await jobFixture({scratchParent: process.env.TMPDIR});
  let front: ReturnType<typeof createJobFront> | undefined;
  let receivedHash = 'not-received';
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async request => {
    receivedHash = new URL(request.url).hash;
    return await front?.fetch(request) ?? new Response(null, {status: 404});
  }});
  const origin = server.url.origin;
  front = createJobFront({origin, ports: createJobHostPorts(f.session, origin), resource: async () => ''});
  try {
    await growJobRigFixture(f, 32, 32);
    const publication = await f.publish(), page = await f.display(publication);
    const [feedback] = syntheticPinnedFeedback({...publication.source, model: publication.source.model!}, 1);
    const row = feedback!, context = row.context as any, mark = context.comment;
    row.summary = '한'.repeat(scenario.text);
    mark.viewport = scenario.pane; mark.time = context.time = 0; mark.animation = context.animation = 'idle';
    mark.frame.index = context.frame = row.frameStart = row.frameEnd = 0;
    context.interval = {frameStart: 0, frameEnd: 0, inclusive: true};
    mark.screen = {x: 12, y: 12, width: 743, height: 746};
    mark.world = {x: -370, y: -370, width: 743 / .84, height: 746 / .84};
    mark.camera = {space: scenario.pane === 'rig' ? 'world' : 'image', center: {x: 0, y: 0}, zoom: .84,
      viewport: {width: 767, height: 770}, visible: {x: -383.5 / .84, y: -385 / .84, width: 767 / .84, height: 770 / .84}};
    const model = JSON.parse(await readFile(join(f.root, 'out/skeleton.model.json'), 'utf8'));
    mark.slots = scenario.pane === 'rig' ? model.slots.map((slot: {name: string}, i: number) =>
      ({slot: slot.name, z: model.slots.length - i - 1})) : [];
    if (mark.slots.length) row.target = {kind: 'slot', name: mark.slots[0].slot};
    mark.referenceId = 'original-painting'; mark.referenceHash = jobHash(await readFile(join(f.root, 'out/painting.png')));
    const bookmark = mark.bookmark;
    bookmark.time = 0; bookmark.animation = 'idle'; bookmark.view.activeCamera = scenario.pane;
    bookmark.view.cameras.rig = {...mark.camera, space: 'world'};
    bookmark.view.cameras.reference = {...mark.camera, space: 'image'};
    bookmark.selection = {inspector: 'playback', workspace: 'motion', mode: 'animate', view: scenario.pane,
      checkpoint: 'step-one', reference: 'original-painting', person: 'synthetic-owner', axis: {id: 'turn', value: .84}};
    let link = '', distance = Infinity;
    for (let length = 0; length <= 256; length++) {
      bookmark.selection.partSet = 's'.repeat(length);
      const candidate = encodeBookmark(bookmark);
      if (Math.abs(candidate.length - 2300) < distance) {link = candidate; distance = Math.abs(candidate.length - 2300);}
    }
    // Restore exactly the state represented by the selected ~2.3 KiB link.
    const binary = atob(link.slice(8).replaceAll('-', '+').replaceAll('_', '/'));
    mark.bookmark = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    const cropBytes = singleRegionPng(scenario.cropBytes), cropSha = jobHash(cropBytes);
    mark.crop = {path: `comment-crops/${cropSha}.png`, sha256: cropSha, png: 'data:image/png;base64,' + cropBytes.toString('base64'), width: 192, height: 193};
    const payload = {...page, expectedGeneration: f.session.status().generation, submissionId: 'single-region',
      kind: 'comments', value: {comments: feedbackContextComments([row])}};
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(jobBodyLimit);
    const response = await fetch(origin + `/jobs/${f.session.jobId}/ui/acts` + link, {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': f.credentials.ui}, body: JSON.stringify(payload)});
    const result = await response.json();
    expect(response.status).toBe(200);
    {
      expect(result.ok).toBe(true);
      const act = parseCommentOnlyAct(result.value);
      const [{context, ...comment}] = act.value.comments;
      expect([comment]).toEqual(feedbackItemComments([row]));
      expect(context).toMatchObject({mode: 'animate', tab: 'playback', region: mark.world,
        camera: mark.camera, frame: mark.frame});
      expect(JSON.parse(f.session.readActExport(result.value.actId, false).toString())).toEqual(result.value);
      expect(act).not.toHaveProperty('still');
    }
    expect(receivedHash).toBe('');
    expect(Object.hasOwn(mark, 'nativeCrop')).toBe(false);
    console.log('SINGLE_COMMENT_790 ' + JSON.stringify({runtime: 'candidate', pane: scenario.pane,
      commentCount: 1, slots: mark.slots.length, slotNameUnits: mark.slots[0]?.slot.length ?? 0, textUnits: row.summary.length,
      textBytes: Buffer.byteLength(row.summary), ratio: 2, paneCSS: [767, 770],
      cropPngBytes: cropBytes.length,
      cropChars: mark.crop.png.length, cropPixels: [192, 193], nativeCrop: 'absent', nativeCropBytes: 0,
      requestBytes: Buffer.byteLength(JSON.stringify(payload)), browserEventBytes: result.ok ? Buffer.byteLength(jobCropReferences({type: 'act', act: result.value, cursor: f.session.status().cursor, jobId: f.session.jobId, generation: f.session.status().generation})) : null,
      bookmarkBytes: Buffer.byteLength(JSON.stringify(mark.bookmark)), linkChars: link.length,
      slotsBytes: Buffer.byteLength(JSON.stringify(mark.slots)), selectionBytes: Buffer.byteLength(JSON.stringify(mark.bookmark.selection)),
      viewBytes: Buffer.byteLength(JSON.stringify(mark.bookmark.view)), contextBytesWithoutComment: Buffer.byteLength(JSON.stringify({...context, comment: undefined})),
      sourceBytes: result.ok ? Buffer.byteLength(JSON.stringify(result.value.source)) : null,
      status: response.status, code: result.error?.code ?? null}));
  } finally {front!.stop(); await server.stop(true); await f.close();}
});
