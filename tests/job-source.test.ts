import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, readFile, rename, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import {readFileSync, writeFileSync} from 'node:fs';
import { dirname, join } from 'node:path';
import {fileURLToPath} from 'node:url';
import {SCENE_CAMERA_REPORT_MAX_BYTES} from '@rig-c/play/composed-take';
import { JobSession } from '../src/job-session.ts';
import { jobFixture, jobInputHashes, syntheticJobParts } from './helpers/job-api-fixture.ts';
import { joinedVerdictFixture } from './helpers/joined-verdict-fixture.ts';
import { readProject } from '../src/interview-project.ts';
import {parseJobPartsIdentity} from '../src/job-source.ts';
import {parseCommentsAct} from '../src/job-host.ts';
import commentsLegacy from './fixtures/comments-contract-legacy.json';

test('#646 Parts pure identity decoder reuses the native manifest and reference grammar without an enumerator', () => {
  const old = JSON.parse(commentsLegacy.records['@5'].raw), original = old.source.parts;
  const parts = {...original, images: [
    {path: 'parts/e\u0301.png', role: 'depth', sha256: 'a'.repeat(64)},
    {path: 'parts/e\u0301.png', role: 'part', sha256: 'a'.repeat(64)},
    {path: 'parts/é.png', role: 'figure_mask', sha256: 'b'.repeat(64)},
  ]};
  expect(parseJobPartsIdentity(parts)).toEqual(parts);
  const act = {...old, schema: 'rig-review/act@6', source: {...old.source, parts}, value: {verdict: 'approved', comments: []}};
  expect(parseCommentsAct(act).source).toEqual(act.source);
  for (const bad of [
    {...parts, manifest: {...parts.manifest, path: 'parts/not-parts.json'}},
    {...parts, images: [{...parts.images[0], path: '../escape.png'}]},
    {...parts, images: [{...parts.images[0], role: 'x'.repeat(129)}]},
    {...parts, images: [{...parts.images[0], sha256: 'wrong'}]},
    {...parts, images: Array(4097).fill(parts.images[0])},
  ]) expect(() => parseCommentsAct({...act, source: {...act.source, parts: bad}})).toThrow('JOB_ACT_INVALID');
});

test('#646 Parts extraction preserves native version/manifest/row validation precedence', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f), context = f.getContext();
  const cases: [JobPartsIdentity, string, string][] = [
    [{...parts, enumeratorVersion: '2.25.2', manifest: {...parts.manifest, path: 'wrong.json'}},
      'JOB_SOURCE_UNRETAINABLE', 'PARTS_ENUMERATOR_VERSION_MISMATCH'],
    [{...parts, manifest: {...parts.manifest, path: 'wrong.json'}, images: []},
      'JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_PATH_REFUSED manifest'],
    [{...parts, manifest: {...parts.manifest, sha256: '0'.repeat(64)}, images: [{path: '../escape', role: 'part', sha256: 'bad'}]},
      'JOB_SOURCE_MISMATCH', 'PARTS_REFERENCE_HASH_MISMATCH manifest'],
  ];
  for (const [value, code, message] of cases) {
    f.setContext({...context, parts: value});
    const before = f.session.status();
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe(code);
    expect(result.error.message).toStartWith(message);
    expect(f.session.status()).toEqual(before);
  }
});

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture(options?: Parameters<typeof jobFixture>[0]) { const f = await jobFixture(options); fixtures.push(f); return f; }

test.each([1, 2])('#1316 a /%i report must be admitted before publication and is served from the retained seal', async (version) => {
  const f = await fixture();
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const path = 'producer-scene.json';
  const report: Record<string, unknown> = {spec: `spine-parts-scene-report/${version}`};
  let writeTake: ((loop: boolean) => Promise<void>) | undefined;
  if (version === 2) {
    const modelPath = join(f.root, 'out', manifest.model);
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    model.animations[0].name = 'idle';
    model.editorOrder.animations[model.editorOrder.animations.indexOf('inspect')] = 'idle';
    const modelBytes = JSON.stringify(model) + '\n';
    const sha256 = jobHash(modelBytes);
    await writeFile(modelPath, modelBytes);
    const {width, height} = model.stage;
    report.canvas = {width, height};
    report.camera = {backdrop: 'synthetic', fps: 12, model_sha256: sha256,
      coverage: {status: 'PASS', max_edge_overrun_px: 0, nonopaque_source_texels: 0, nonopaque_output_pixels: 0},
      tracks: {idle: {duration: 1, compiled_duration: 1, loop: true,
        keys: [{t: 0, pan: [0, 0], zoom: 1}, {t: 1, pan: [0, 0], zoom: 1}], frames: []}}};
    manifest.direction = 'direction.json';
    writeTake = loop => writeFile(join(f.root, 'out', manifest.direction), JSON.stringify({
      schema: 'rig-create/direction@3', rig: {version: 1}, model: {path: manifest.model, sha256}, take: {duration: 1, loop},
    }));
    await writeTake(false);
  }
  const bytes = JSON.stringify(report) + '\n';
  const sceneReport = {path, sha256: jobHash(bytes)};
  await writeFile(manifestPath, JSON.stringify({...manifest, sceneReport}));
  const missing = await (await f.call(await f.publishRequest())).json();
  expect(missing).toMatchObject({ok: false, generation: 0, error: {code: 'SCENE_REQUIRED'}});

  const liveReport = join(f.root, 'out', path);
  const alternate = 'alternate-scene.json';
  await writeFile(join(f.root, 'out', alternate), bytes);
  await symlink(alternate, liveReport);
  const linked = await (await f.call(await f.publishRequest())).json();
  expect(linked).toMatchObject({ok: false, generation: 0, error: {code: 'SCENE_SOURCE_MISMATCH'}});
  await unlink(liveReport);
  if (version === 1) {
    const oversized = Buffer.alloc(SCENE_CAMERA_REPORT_MAX_BYTES + 1, ' ');
    oversized.write(bytes);
    await writeFile(liveReport, oversized);
    await writeFile(manifestPath, JSON.stringify({...manifest, sceneReport: {path, sha256: jobHash(oversized)}}));
    const refusal = await (await f.call(await f.publishRequest())).json();
    expect(refusal).toMatchObject({ok: false, generation: 0, error: {code: 'SCENE_CAMERA_REPORT_TOO_LARGE'}});
    await writeFile(manifestPath, JSON.stringify({...manifest, sceneReport}));
  }
  await writeFile(liveReport, bytes);
  if (writeTake) {
    const mismatch = await (await f.call(await f.publishRequest())).json();
    expect(mismatch).toMatchObject({ok: false, generation: 0, error: {code: 'DIRECTION_TAKE_MISMATCH'}});
    await writeTake(true);
  }
  const publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  expect(retained.seals).toContainEqual({path: 'out/' + path, sha256: sceneReport.sha256});
  await writeFile(liveReport, 'changed after publication');
  await writeFile(join(retained.snapshotRoot, 'out/undeclared-scene.json'), bytes);
  const route = retainedPublicationRoutes(f.session);
  const fetch = (asset: string) => route(f.session.jobId, publication.publicationId, publication.instanceKey,
    asset, new Request(f.origin + '/' + asset));
  const metadata = await fetch('api/review');
  expect((await metadata.json()).manifest.sceneReport).toEqual(sceneReport);
  const reportResponse = await fetch('assets/' + path);
  expect(reportResponse.status).toBe(200);
  expect(await reportResponse.text()).toBe(bytes);
  expect((await fetch('assets/undeclared-scene.json')).status).toBe(404);
});

// A synthetic installed producer above each cwd exercises parser discovery, not
// arbitrary config discovery: the package's own handoff remains authoritative.
async function cwdProducer(base: string, includeMotion: boolean) {
  const dir = join(base, 'node_modules/@rig-c/parts');
  await mkdir(join(dir, 'src'), {recursive: true});
  await writeFile(join(dir, 'package.json'), JSON.stringify({name: '@rig-c/parts', version: '2.38.1'}));
  await writeFile(join(dir, 'src/config.ts'), `exports.configFileReferences = raw => ${includeMotion
    ? "[{at:'motion.animations_from',value:raw.motion.animations_from,set:()=>{}}]" : '[]'};`);
}

test('#915 publication and stored replay ignore the publisher cwd without rebinding neutral identities', async () => {
  const f = await fixture({plain: true}), cwd = process.cwd();
  const neutral = join(f.scratch, 'neutral'), producer = join(f.scratch, 'producer'), nested = join(producer, 'shell');
  await mkdir(neutral); await mkdir(nested, {recursive: true});
  await writeFile(join(f.root, 'config.json'), JSON.stringify({motion: {animations_from: 'clips.json'}}));
  await writeFile(join(f.root, 'clips.json'), '{}');
  await writeFile(join(producer, 'config.json'), '{}');
  await cwdProducer(f.root, true); await cwdProducer(producer, false);
  const {loadReview} = await import('../src/manifest.ts');
  try {
    process.chdir(neutral);
    const legacy = await loadReview(join(f.root, 'out'));
    const first = await f.publish();
    expect(first.source.sourceHash).toBe(legacy.sourceHash);
    process.chdir(f.root);
    const project = await f.publish();
    process.chdir(nested);
    const second = await f.publish();
    for (const value of [project, second]) {
      expect(value.source.sourceHash).toBe(first.source.sourceHash);
      expect(value.instanceKey).toBe(first.instanceKey);
    }
    expect(await f.ports.readPublication(f.session.jobId, first.publicationId)).toMatchObject({ok: true});
    f.session.dispose();
    const replay = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
      reviewer: {id: 'declared-owner', role: 'owner'}, partsEnumerator: f.partsEnumerator});
    try {
      expect(replay.status().publication?.source.sourceHash).toBe(first.source.sourceHash);
      await replay.readPublicationResponse(first.publicationId, async retained => {
        expect(retained.source.sourceHash).toBe(legacy.sourceHash);
        if (!retained.manifestPath) throw new Error('Expected retained package manifest');
        expect(await readFile(retained.manifestPath, 'utf8')).toContain('viewport-387-public');
        return new Response(null);
      });
    } finally { replay.dispose(); }
  } finally { process.chdir(cwd); }
});

async function createOwnInstallFixture(f: Awaited<ReturnType<typeof jobFixture>>) {
  const create = join(f.scratch, 'create'), modules = join(create, 'node_modules');
  const reviewInstall = join(modules, '@rig-c/review'), neutral = join(f.scratch, 'neutral');
  await mkdir(reviewInstall, {recursive: true}); await mkdir(neutral);
  // A disposable installed tree, not a source checkout: Create owns both dependencies.
  await cp(new URL('../src', import.meta.url), join(reviewInstall, 'src'), {recursive: true});
  await cp(new URL('../web', import.meta.url), join(reviewInstall, 'web'), {recursive: true});
  await cp(new URL('../package.json', import.meta.url), join(reviewInstall, 'package.json'));
  await mkdir(join(modules, '@napi-rs'), {recursive: true});
  for (const name of ['pngjs', '@rig-c/play', '@napi-rs/canvas']) {
    await symlink(fileURLToPath(new URL('../node_modules/' + name, import.meta.url)), join(modules, name));
  }
  await cwdProducer(create, false);
  await writeFile(join(modules, '@rig-c/parts/src/config.ts'),
    "exports.configFileReferences = raw => [{at:'assemble.edited_parts.receipts[0].file',value:'edited/torso.png',set:()=>{}}];");
  await mkdir(join(f.root, 'out/edited'));
  await writeFile(join(f.root, 'out/edited/torso.png'), await readFile(join(f.root, 'out/rigid.png')));
  await writeFile(join(f.root, 'out/config.json'), JSON.stringify({assemble: {
    edited_parts: {dir: 'edited', receipts: [{file: 'torso.png'}]},
  }}));
  return {modules, reviewInstall, neutral};
}

test('#915 Create own-install Parts resolves and seals config references from a neutral cwd', async () => {
  const f = await fixture({plain: true}), cwd = process.cwd();
  const {modules, reviewInstall, neutral} = await createOwnInstallFixture(f);
  const {findInstalledParts} = await import('../src/handoff.ts');
  expect(findInstalledParts([f.root])).toBeNull();
  const installed = await import(join(reviewInstall, 'src/manifest.ts'));
  const {JobSession: InstalledSession} = await import(join(reviewInstall, 'src/job-session.ts'));
  const {createJobHostPorts} = await import(join(reviewInstall, 'src/job-api.ts'));
  const session = new InstalledSession({root: f.root, stateDir: join(f.scratch, 'installed-state'),
    fingerprint: 'f'.repeat(64), reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    process.chdir(neutral);
    const review = await installed.loadJobReview(join(f.root, 'out'), f.root);
    expect(findInstalledParts(review.handoff.starts)).toBe(join(modules, '@rig-c/parts'));
    expect(review.reviewedSource.handoff.files.some((file: {path: string}) => file.path === 'edited/torso.png')).toBe(true);
    const ports = createJobHostPorts(session, f.origin), request = await f.publishRequest();
    const response = await ports.handleJobApi(new Request(`${f.origin}/jobs/${session.jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + session.hostCredentials().agent},
      body: JSON.stringify({...request, jobId: session.jobId}),
    }));
    const result = await response.json();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const retained = session.retainedSource(result.value.publicationId);
    expect(retained.seals.some((file: {path: string}) => file.path === 'out/edited/torso.png')).toBe(true);
  } finally { process.chdir(cwd); session.dispose(); }
});

test('#915 legacy neutral edited-receipt publication refuses a changed retained identity with detail', async () => {
  const f = await fixture({plain: true}), cwd = process.cwd();
  const {reviewInstall, neutral} = await createOwnInstallFixture(f);
  const manifestPath = join(reviewInstall, 'src/manifest.ts');
  const current = await readFile(manifestPath, 'utf8');
  // A synthetic old installation reproduces the old neutral-cwd lookup only.
  // The repository's sources and the retained inputs are never patched.
  const legacy = current.replace(
    "handoffStarts: [root, fileURLToPath(new URL('..', import.meta.url))]",
    'handoffStarts: []');
  expect(legacy).not.toBe(current);
  const request = await f.publishRequest();
  const script = `
    const {JobSession}=await import(${JSON.stringify(join(reviewInstall, 'src/job-session.ts'))});
    const {createJobHostPorts}=await import(${JSON.stringify(join(reviewInstall, 'src/job-api.ts'))});
    process.chdir(${JSON.stringify(neutral)});
    const session=new JobSession({root:${JSON.stringify(f.root)},stateDir:${JSON.stringify(join(f.scratch, 'legacy-state'))},
      fingerprint:'f'.repeat(64),reviewer:{id:'declared-owner',role:'owner'}});
    try {
      const origin=${JSON.stringify(f.origin)},ports=createJobHostPorts(session,origin);
      const result=await (await ports.handleJobApi(new Request(origin+'/jobs/'+session.jobId+'/api',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.hostCredentials().agent},
        body:JSON.stringify({...${JSON.stringify(request)},jobId:session.jobId})}))).json();
      if(!result.ok)throw new Error(JSON.stringify(result));
      console.log(JSON.stringify({jobId:session.jobId,publication:result.value}));
    }finally{session.dispose();}`;
  let child: ReturnType<typeof Bun.spawnSync>;
  await writeFile(manifestPath, legacy);
  try { child = Bun.spawnSync([process.execPath, '-e', script], {stdout: 'pipe', stderr: 'pipe'}); }
  finally { await writeFile(manifestPath, current); }
  expect(child.exitCode).toBe(0);
  if (!child.stdout) throw new Error('Expected captured legacy publication');
  const baseline = JSON.parse(child.stdout.toString());
  const {JobSession: InstalledSession} = await import(join(reviewInstall, 'src/job-session.ts'));
  const {retainedPublicationRoutes} = await import(join(reviewInstall, 'src/job-front.ts'));
  const session = new InstalledSession({root: f.root, stateDir: join(f.scratch, 'legacy-state'),
    fingerprint: 'f'.repeat(64), reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    process.chdir(neutral);
    const retained = session.retainedSource(baseline.publication.publicationId);
    expect(retained.seals.some((file: {path: string}) => file.path === 'out/edited/torso.png')).toBe(false);
    const response = await retainedPublicationRoutes(session)(baseline.jobId, baseline.publication.publicationId,
      baseline.publication.instanceKey, 'api/review', new Request(f.origin + '/api/review'));
    const result = await response.json();
    expect(response.status).toBe(409);
    expect(result.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
    expect(result.error.message).toContain(`requires stored ${baseline.publication.instanceKey}`);
    expect(result.error.message).toContain('(handoff config.json)');
    const found = result.error.message.match(/snapshot reload instanceKey ([a-f0-9]{64})/);
    expect(found).not.toBeNull();
    expect(found[1]).not.toBe(baseline.publication.instanceKey);
    expect(session.status().publication).toEqual(baseline.publication);
  } finally { process.chdir(cwd); session.dispose(); }
});

test('#915 snapshot refusal reaches CLI output with found/required hashes and handoff', async () => {
  const f = await fixture({plain: true, afterDirectorySync: path => {
    if (path.includes('/snapshots/') && !path.endsWith('/out')) {
      const manifest = join(path, 'out/review.json');
      const value = JSON.parse(readFileSync(manifest, 'utf8'));
      value.title = 'Synthetic snapshot drift';
      writeFileSync(manifest, JSON.stringify(value));
    }
  }});
  await writeFile(join(f.root, 'config.json'), '{}');
  const {loadReview} = await import('../src/manifest.ts');
  const live = await loadReview(join(f.root, 'out'), {cwd: f.root});
  const {jobCommand} = await import('../src/job-cli.ts');
  const {jobHash} = await import('../src/job-api.ts');
  const output: string[] = [], exit = process.exitCode;
  try {
    await jobCommand(['publish', `${f.origin}/jobs/${f.session.jobId}`, '--generation', '0', '--key', 'drift',
      '--result', 'out', '--freeze-hold', 'held', '--record', 'record.json', '--record-hash',
      jobHash(await readFile(join(f.root, 'record.json')))], {
      agentCapability: f.credentials.agent, write: value => output.push(value),
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) =>
        f.ports.handleJobApi(new Request(`${f.origin}/jobs/${f.session.jobId}/api`, init))) as typeof fetch,
    });
    const result = JSON.parse(output[0]);
    expect(process.exitCode).toBe(1);
    expect(result.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
    expect(result.error.message).toContain(`requires live ${live.sourceHash}`);
    expect(result.error.message).toContain('handoff snapshot ../config.json, live ../config.json');
    const found = result.error.message.match(/sourceHash ([a-f0-9]{64})/);
    expect(found).not.toBeNull();
    expect(found[1]).not.toBe(live.sourceHash);
    expect(f.session.status().generation).toBe(0);
  } finally { process.exitCode = exit ?? 0; }
});

test('source root containment refuses symlink inputs and state inside source before creating state', async () => {
  const f = await fixture();
  expect(() => new JobSession({ root: f.root, stateDir: join(f.root, 'forbidden-state'), fingerprint: 'f'.repeat(64),
    reviewer: { id: 'owner', role: 'owner' } })).toThrow('Job state must be outside');
  await symlink(f.state, join(f.root, 'escaped'));
  const request = await f.publishRequest();
  const response = await (await f.call({ ...request, result: { path: 'escaped', selector: null } })).json();
  expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toBeNull();
});

test('missing/partial record and changed original assets never publish', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'record.json'), '{');
  const incomplete = await (await f.call(await f.publishRequest())).json();
  expect(incomplete.error.code).toBe('JOB_RECORD_INCOMPLETE');
  const request = await f.publishRequest();
  await writeFile(join(f.root, 'record.json'), '{}');
  expect((await (await f.call(request)).json()).error.code).toBe('JOB_RECORD_MOVED');
  expect(f.session.status().generation).toBe(0);
});

test('Create input without the declared producer reader is named unavailable and cannot be disguised as an ordinary record', async () => {
  const f = await fixture();
  const project = { schema: 'rig-create/project@0', interview: {} };
  await writeFile(join(f.root, 'project.json'), JSON.stringify(project));
  const request = await f.publishRequest();
  expect((await (await f.call(request)).json()).error.code).toBe('JOB_FREEZE_REQUIRED');
  const plain = new JobSession({ root: f.root, stateDir: join(f.scratch, 'other-state'), fingerprint: 'e'.repeat(64),
    reviewer: { id: 'owner', role: 'owner' } });
  const { createJobHostPorts, jobHash } = await import('../src/job-api.ts');
  const origin = 'http://127.0.0.1:19485', ports = createJobHostPorts(plain, origin);
  const response = await ports.handleJobApi(new Request(origin + `/jobs/${plain.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + plain.hostCredentials().agent },
    body: JSON.stringify({ ...request, jobId: plain.jobId, freeze: { kind: 'producer-held', holdId: 'held',
      record: { path: 'project.json', sha256: jobHash(await readFile(join(f.root, 'project.json'))) } } }),
  }));
  const result = await response.json();
  expect(result.error).toEqual({ code: 'JOB_SOURCE_UNRETAINABLE', message: 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE' });
  plain.dispose();
});

test('root directory replacement refuses a later operation without altering the committed head', async () => {
  const f = await fixture(), publication = await f.publish();
  await rename(f.root, f.root + '-original');
  await mkdir(f.root);
  const result = await (await f.call({ ...f.base(), verb: 'close', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'replaced-root', reason: 'close' })).json();
  expect(result.error.code).toBe('JOB_ROOT_REPLACED');
  expect(f.session.status().publication).toEqual(publication);
});

test('C4 compares claimed paths to authoritative rows and resolves root or prefixed manifests', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { painting: true });
  const valid = await f.publish();
  expect(valid.source.parts).toEqual(parts);
  for (const path of ['rigid.png', 'wrong/painting_in_rig.png', 'parts/nested/image.png', 'parts/image.PNG']) {
    f.setContext({ ...f.getContext(), parts: { ...parts, images: [{ role: parts.images[0].role, path: path as typeof parts.images[number]['path'], sha256: parts.images[0].sha256 }] } });
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(f.session.status().publication).toEqual(valid);
  }
  await writeFile(join(f.root, 'parts.json'), await readFile(join(f.root, parts.manifest.path)));
  await writeFile(join(f.root, 'painting_in_rig.png'), await readFile(join(f.root, 'out/painting_in_rig.png')));
  f.setContext({ ...f.getContext(), parts: {
    enumeratorVersion: parts.enumeratorVersion,
    manifest: { path: 'parts.json', sha256: parts.manifest.sha256 },
    images: [{ path: 'painting_in_rig.png', role: 'painting', sha256: parts.images.find(image => image.path === 'painting_in_rig.png')!.sha256 }],
  } });
  f.setPartsReferences([{path: 'painting_in_rig.png', role: 'painting'}]);
  expect((await f.publish()).source.parts?.images[0].path).toBe('painting_in_rig.png');
});

test('changed or missing referenced painting refuses while unreferenced stale PNGs stay outside the binding', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { painting: true });
  const original = await f.publish();
  await writeFile(join(f.root, 'out/parts/unreferenced.png'), 'unreferenced stale bytes');
  const withExtra = await f.publish();
  expect(withExtra.source.sourceHash).toBe(original.source.sourceHash);
  expect(withExtra.instanceKey).toBe(original.instanceKey);
  expect(withExtra.source.parts).toEqual(parts);
  await writeFile(join(f.root, 'out/painting_in_rig.png'), 'changed referenced bytes');
  const changed = await (await f.call(await f.publishRequest())).json();
  expect(changed.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toEqual(withExtra);
  await unlink(join(f.root, 'out/painting_in_rig.png'));
  const missing = await (await f.call(await f.publishRequest())).json();
  expect(missing.error.code).toBe('JOB_SOURCE_MISMATCH');
  expect(f.session.status().publication).toEqual(withExtra);
});

test('new snapshot directory entries are synced from leaves through snapshots and its state parent', async () => {
  const synced: string[] = [];
  const f = await jobFixture({ afterDirectorySync: path => { synced.push(path); } });
  fixtures.push(f);
  const publication = await f.publish(), retained = f.session.retainedSource(publication.publicationId);
  expect(synced).toContain(retained.snapshotRoot);
  expect(synced).toContain(dirname(retained.snapshotRoot));
  expect(synced).toContain(f.state);
  expect(synced.indexOf(retained.snapshotRoot)).toBeLessThan(synced.indexOf(dirname(retained.snapshotRoot)));
  expect(synced.indexOf(dirname(retained.snapshotRoot))).toBeLessThan(synced.indexOf(f.state));
});

test('ordinary canonical Review work-root publishing needs no Create adapter', async () => {
  const f = await jobFixture({ plain: true });
  fixtures.push(f);
  const { loadReview } = await import('../src/manifest.ts');
  const expected = await loadReview(join(f.root, 'out'));
  const publication = await f.publish();
  expect(publication.source.sourceHash).toBe(expected.sourceHash);
  expect(publication.source.plan).toBeNull();
  expect(publication.source.parts).toBeNull();
  expect(publication.source.projectHash).toBeNull();
});

test('#1230 actual readProject pending questions publish while optional answer absence stays persistable; a fresh picks ask and submission refuse by name', async () => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  const opened = readProject(f.root), pending = opened.questions.find(question => question.editable)!;
  expect(pending).toBeDefined();
  expect(Object.hasOwn(pending, 'answer')).toBe(true);
  expect(pending.answer).toBeUndefined();
  const historical = opened.questions.find(question => question.answer !== undefined)!;
  expect(historical).toBeDefined();
  f.setRecordPath('project.json');
  // The pending sets are real reader output. Only the producer publication
  // adapter is synthetic, selecting the ordinary compiled fixture beside them.
  f.setContext({ ...f.getContext(), plan: null, subjects: [{ kind: 'interview-picks',
    questionId: pending.set.question, setId: pending.set.id }] });
  const before = await jobInputHashes(f.root);
  const published = await (await f.call(await f.publishRequest('real-pending'))).json();
  expect(published.error?.code ?? null).toBeNull();
  expect(published.ok).toBe(true);
  const retained = f.session.retainedSource(published.value.publicationId);
  const savedPending = retained.questions.find(question => question.set.id === pending.set.id)!;
  expect(Object.hasOwn(savedPending, 'answer')).toBe(false);
  expect(retained.questions.find(question => question.set.id === historical.set.id)?.answer).toEqual(historical.answer);
  const asked = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
    idempotencyKey: 'real-pending-ask', publicationId: published.value.publicationId,
    subject: { kind: 'interview-picks', questionId: pending.set.question, setId: pending.set.id } })).json();
  expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
  const page = await f.display(published.value);
  const selections = pending.set.asks.map(item => ({ itemId: item.id,
    optionId: item.options.find(option => option.kind === 'value' && option.recommended)!.id, otherText: null }));
  const note = '실제 pending 원문\nunchanged';
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: '00000000-0000-4000-8000-000000001230',
    expectedGeneration: f.session.status().generation, submissionId: 'real-pending-save',
    kind: 'interview-picks', value: { questionId: pending.set.question, selections, note } }));
  expect(saved).toMatchObject({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED' } });
  expect(await jobInputHashes(f.root)).toEqual(before);
});

import type {JobPartsEnumerator, JobPartsFileReference, JobPartsIdentity} from '../src/job-contract.ts';
import {jobHash} from '../src/job-api.ts';

// Runtime import of the approved dev-only public entry. Production Review has no Parts dependency.
const installedPartsEntry = '@rig-c/parts/src/parts.ts';
const installedParts = await import(installedPartsEntry);
const reviewManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  devDependencies: Record<string, string>;
};
const installedPartsPackage = JSON.parse(await readFile(new URL('../node_modules/@rig-c/parts/package.json', import.meta.url), 'utf8'));
const officialEnumerator: JobPartsEnumerator = {
  version: installedPartsPackage.version,
  enumerate: installedParts.partsFileReferences,
};

async function officialFixture() {
  const f = await fixture({partsEnumerator: officialEnumerator});
  const dir = join(f.root, 'standalone');
  await cp(new URL('./fixtures/job-parts-c4/standalone', import.meta.url), dir, {recursive: true});
  const references = officialEnumerator.enumerate(dir);
  const images = [];
  for (const reference of references) {
    images.push({...reference, sha256: jobHash(await readFile(join(dir, reference.path)))});
  }
  const parts: JobPartsIdentity = {enumeratorVersion: officialEnumerator.version,
    manifest: {path: 'standalone/parts.json', sha256: jobHash(await readFile(join(dir, 'parts.json')))}, images};
  f.setContext({...f.getContext(), parts});
  return {f, dir, references, parts};
}

test('C4 installed public enumeration binds five roles, shared roles and UTF-16 paths losslessly', async () => {
  expect(officialEnumerator.version).toBe(reviewManifest.devDependencies['@rig-c/parts']);
  const {f, references, parts} = await officialFixture();
  const before = await jobInputHashes(f.root);
  const publication = await f.publish();
  expect(publication.source.parts).toEqual(parts);
  expect(publication.source.parts!.images.map(({path, role}) => ({path, role}))).toEqual([...references]);
  expect(new Set(references.map(row => row.role))).toEqual(new Set(['part', 'alternate', 'depth', 'painting', 'figure_mask']));
  expect(references.filter(row => row.path === 'parts/body.png').map(row => row.role)).toEqual(['depth', 'part']);
  expect(references.filter(row => row.role === 'figure_mask')).toHaveLength(1);
  expect(references.findIndex(row => row.path === 'parts/𐀀.png')).toBeLessThan(references.findIndex(row => row.path === 'parts/\ue000.png'));
  const retained = f.session.retainedSource(publication.publicationId);
  expect(retained.seals.filter(row => row.path === 'standalone/parts/body.png')).toHaveLength(1);
  expect(retained.seals.some(row => row.path === 'standalone/render/figure_rig.png')).toBe(false);
  for (const row of parts.images) {
    expect(jobHash(await readFile(join(retained.snapshotRoot, 'standalone', row.path)))).toBe(row.sha256);
  }
  const expected = jobHash(JSON.stringify({schema: 'rig-review-job-source/2',
    packageSourceHash: (await (await import('../src/manifest.ts')).loadReview(join(f.root, 'out'))).sourceHash,
    record: retained.record, selector: publication.source.selector, plan: publication.source.plan,
    parts: publication.source.parts, files: retained.seals}));
  expect(publication.source.sourceHash).toBe(expected);
  await writeFile(join(f.root, 'standalone/unused.png'), 'unreferenced');
  const withExtra = await f.publish();
  expect(withExtra.source.sourceHash).toBe(publication.source.sourceHash);
  await unlink(join(f.root, 'standalone/unused.png'));
  expect(await jobInputHashes(f.root)).toEqual(before);
});

test('C4 standalone sibling removal names the official row even while render copy exists', async () => {
  const {f, dir, references} = await officialFixture();
  const original = await f.publish();
  const row = references.findIndex(reference => reference.role === 'figure_mask');
  const reference = references[row];
  await unlink(join(dir, reference.path));
  expect((await readFile(join(dir, 'render/figure_rig.png'))).length).toBeGreaterThan(0);
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error).toEqual({code: 'JOB_SOURCE_MISMATCH',
    message: `PARTS_REFERENCE_MISSING row=${row} role=${reference.role} path=${JSON.stringify(reference.path)}`});
  expect(f.session.status().publication).toEqual(original);
});

test('C4 claimed inventory mutations refuse against the untouched public array', async () => {
  const {f, parts} = await officialFixture();
  const original = await f.publish();
  const images = parts.images;
  const mutations = [images.slice(1), [...images, images[0]], [...images].reverse(),
    images.map((row, index) => index ? row : {...row, role: 'part'}),
    [...images.slice(0, 1), images[0], ...images.slice(1)],
    [...images.slice(0, 1), {...images[1], path: 'unused.png'}, ...images.slice(2)]];
  for (const changed of mutations) {
    f.setContext({...f.getContext(), parts: {...parts, images: changed}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(response.error.message).toStartWith('PARTS_REFERENCE_SET_MISMATCH row=');
    expect(f.session.status().publication).toEqual(original);
  }
});

test('C4 PNG decode, decoded allocation and raw-hash refusals keep the committed publication', async () => {
  const {f, dir, parts} = await officialFixture();
  const original = await f.publish();
  const path = 'figure_rig.png';
  const bytes = await readFile(join(dir, path));
  const oversized = Buffer.from(bytes);
  oversized.writeUInt32BE(0xffffffff, 16);
  oversized.writeUInt32BE(0xffffffff, 20);
  for (const [data, name] of [[Buffer.from('invalid PNG'), 'PARTS_REFERENCE_PNG_INVALID'],
    [bytes.subarray(0, 33), 'PARTS_REFERENCE_PNG_INVALID'], [oversized, 'PARTS_REFERENCE_LIMIT']] as const) {
    await writeFile(join(dir, path), data);
    f.setContext({...f.getContext(), parts: {...parts,
      images: parts.images.map(row => row.path === path ? {...row, sha256: jobHash(data)} : row)}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error.message).toStartWith(name + ' row=');
    expect(f.session.status().publication).toEqual(original);
  }
  await writeFile(join(dir, path), bytes);
  f.setContext({...f.getContext(), parts: {...parts,
    images: parts.images.map(row => row.path === path ? {...row, sha256: '0'.repeat(64)} : row)}});
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error.message).toStartWith('PARTS_REFERENCE_HASH_MISMATCH row=');
  expect(f.session.status().publication).toEqual(original);
});

test('C4 bounds paths without role, filename, ordering or duplicate reclassification', async () => {
  let references: readonly JobPartsFileReference[] = [];
  const f = await fixture({partsEnumerator: {version: '2.25.1', enumerate: () => references}});
  const parts = await syntheticJobParts(f);
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  await mkdir(join(f.root, 'out/arbitrary'));
  await writeFile(join(f.root, 'out/arbitrary/image.bin'), bytes);
  references = [{path: 'arbitrary/image.bin', role: 'producer-owned-role'},
    {path: 'arbitrary/image.bin', role: 'another-role'}];
  f.setContext({...f.getContext(), parts: {...parts, images: references.map(row => ({...row, sha256: jobHash(bytes)}))}});
  const original = await f.publish();
  expect(original.source.parts?.images.map(({path, role}) => ({path, role}))).toEqual([...references]);
  for (const path of ['../escape.png', '/absolute.png', 'parts//x.png', 'parts/./x.png',
    'parts/%2e.png', 'parts\\escape.png', 'https://example.invalid/x.png', 'parts/x?.png', 'parts/x#.png', 'parts/x\n.png']) {
    references = [{path, role: 'bounded-role'}];
    f.setContext({...f.getContext(), parts: {...parts, images: references.map(row => ({...row, sha256: jobHash(bytes)}))}});
    const response = await (await f.call(await f.publishRequest())).json();
    expect(response.error).toEqual({code: 'JOB_SOURCE_UNRETAINABLE', message: 'PARTS_REFERENCE_PATH_REFUSED row=0'});
    expect(f.session.status().publication).toEqual(original);
  }
});

test('C4 refuses symlink leaves, symlink parents, special paths and byte/row/role overflow', async () => {
  let references: readonly JobPartsFileReference[] = [];
  const f = await fixture({partsEnumerator: {version: '2.25.1', enumerate: () => references}});
  const parts = await syntheticJobParts(f);
  const data = await readFile(join(f.root, 'out/rigid.png'));
  const outside = join(f.scratch, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'image.png'), data);
  await symlink(join(outside, 'image.png'), join(f.root, 'out/parts/link.png'));
  await symlink(outside, join(f.root, 'out/link'));
  await mkdir(join(f.root, 'out/parts/directory.png'));
  async function refused(rows: readonly JobPartsFileReference[]) {
    references = rows;
    f.setContext({...f.getContext(), parts: {...parts, images: rows.map(row => ({...row, sha256: jobHash(data)}))}});
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.ok).toBe(false);
    expect(f.session.status().generation).toBe(0);
    return result.error;
  }
  for (const path of ['parts/link.png', 'link/image.png', 'parts/directory.png']) {
    expect((await refused([{path, role: 'part'}])).message).toStartWith('PARTS_REFERENCE_PATH_REFUSED row=0');
  }
  await truncate(join(f.root, 'out/parts/base.png'), 64 * 1024 * 1024 + 1);
  expect((await refused([{path: 'parts/base.png', role: 'part'}])).message).toStartWith('PARTS_REFERENCE_LIMIT row=0');
  for (const role of ['', 'x'.repeat(129), 'bad\nrole']) {
    expect((await refused([{path: 'parts/base.png', role}])).message).toBe('PARTS_REFERENCE_SET_MISMATCH row=0');
  }
  expect((await refused(Array.from({length: 4097}, () => ({path: 'parts/base.png', role: 'part'})))).message).toBe('PARTS_REFERENCE_LIMIT');
  f.setContext({...f.getContext(), parts: null, files: Array.from({length: 4096}, (_, i) => ({
    path: `extra/file-${i}.bin`, sha256: 'a'.repeat(64),
  }))});
  const overFilesResponse = await (await f.call(await f.publishRequest())).json();
  expect(overFilesResponse.ok).toBe(false);
  expect(overFilesResponse.error).toEqual({
    code: 'JOB_SOURCE_UNRETAINABLE',
    message: 'retained source files 4102 exceed the 4096-file limit',
  });
});

test('C4 preserves the public manifest reader refusal name', async () => {
  const {f, dir, parts} = await officialFixture();
  await writeFile(join(dir, 'parts.json'), '{');
  f.setContext({...f.getContext(), parts: {...parts, manifest: {...parts.manifest, sha256: jobHash('{')}}});
  const response = await (await f.call(await f.publishRequest())).json();
  expect(response.error).toEqual({code: 'JOB_SOURCE_MISMATCH', message: 'PARTS_ENUMERATION_REFUSED rule=PARTS_IS_JSON'});
  expect(f.session.status().generation).toBe(0);
});

// Literal release-8e1e3387 oracle from source copies frozen before projection edits.
// Provenance /tmp/review606-sol-implementation/ORACLE-03.test.ts and GOLDEN-03.json.
// Source/act strings are literals. IDs/time are fixed in the existing fixture helper.
const golden606 = {
  "samples": {
    "package-absent": {
      "sourceBytes": "{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null}",
      "preimage": "{\"schema\":\"rig-review-job-source/2\",\"packageSourceHash\":\"7e095240763ae30a8a592f2e5ae180b9a0900b1beed89777df89cdb07077f4e4\",\"record\":{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"files\":[{\"path\":\"out/mesh.png\",\"sha256\":\"3c53c17cafd9c4aebfadf42b20b379b35ff9a62099155c709789b16aa38b1287\"},{\"path\":\"out/report.json\",\"sha256\":\"75f2d38478ab548a713a638ba6ae7a7a31b5aac2c41c9fcbda3571716b7bf612\"},{\"path\":\"out/review.json\",\"sha256\":\"ae8c6771bf1d394e1c3e6d7351e017ec6475d1583af6af44c01ae6c85a6d0263\"},{\"path\":\"out/rigid.png\",\"sha256\":\"ae23847ba8cd901398cd2b9d5e0e3786871016235ac1ef2dd8e4bcb9ef655415\"},{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"}]}",
      "sourceHash": "1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42",
      "actBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null}",
      "replayActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"1e9ac4acf8a7990f836961be5f8820d614b4d3c0ada13b66bd2d821d6e4fba42\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "package-evidence": {
      "sourceBytes": "{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-source/2\",\"packageSourceHash\":\"7e095240763ae30a8a592f2e5ae180b9a0900b1beed89777df89cdb07077f4e4\",\"record\":{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"out/mesh.png\",\"sha256\":\"3c53c17cafd9c4aebfadf42b20b379b35ff9a62099155c709789b16aa38b1287\"},{\"path\":\"out/report.json\",\"sha256\":\"75f2d38478ab548a713a638ba6ae7a7a31b5aac2c41c9fcbda3571716b7bf612\"},{\"path\":\"out/review.json\",\"sha256\":\"ae8c6771bf1d394e1c3e6d7351e017ec6475d1583af6af44c01ae6c85a6d0263\"},{\"path\":\"out/rigid.png\",\"sha256\":\"ae23847ba8cd901398cd2b9d5e0e3786871016235ac1ef2dd8e4bcb9ef655415\"},{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},{\"path\":\"record.json\",\"sha256\":\"b45761628ca0e6dd626191dd4846b62b4e54b625a9920ea84800c18763125d0b\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "sourceHash": "e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439",
      "actBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@2\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"kind\":\"checkpoint\",\"source\":{\"sourceHash\":\"e57f8c867f7bbd902f2bf69c7f1cbc1e84318f62a40fc1a2921d0af626937439\",\"projectHash\":null,\"package\":{\"id\":\"viewport-387-public\",\"revision\":\"1\"},\"selector\":{\"kind\":\"rig\",\"version\":1},\"model\":{\"path\":\"out/skeleton.model.json\",\"sha256\":\"ae8a9ec6fa5f80272ca0b1c2f5e02f0c2929211f76cc1dfd4154d2ff2d226335\"},\"direction\":null,\"optionSet\":null,\"appliedResult\":null,\"plan\":{\"steps\":[{\"id\":\"step-one\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"}]},\"parts\":null,\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]},\"value\":{\"checkpointId\":\"step-one\",\"planStepId\":\"step-one\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "record-absent": {
      "sourceBytes": "{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-record-source/1\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"selection\":{\"kind\":\"plan\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}]}",
      "sourceHash": "5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785",
      "actBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"5d6307c490fb77e064b9c28ea7a2d2abac367e629dd943b5ae36ab1d6d9eb785\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    },
    "record-evidence": {
      "sourceBytes": "{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "preimage": "{\"schema\":\"rig-review-job-record-source/1\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"selection\":{\"kind\":\"plan\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}]}",
      "sourceHash": "329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2",
      "actBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"golden-job\",\"askId\":\"golden-ask\",\"publicationId\":\"golden-publication\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "durableSourceBytes": "{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]}",
      "replayActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}",
      "reopenedActBytes": "{\"schema\":\"rig-review/act@4\",\"actId\":\"12345678-1234-4abc-8def-123456789abc\",\"jobId\":\"12345678-1234-4abc-8def-123456789abc\",\"askId\":\"12345678-1234-4abc-8def-123456789abc\",\"publicationId\":\"12345678-1234-4abc-8def-123456789abc\",\"kind\":\"checkpoint\",\"authority\":{\"actor\":\"human\",\"channel\":\"review-ui\",\"reviewer\":{\"id\":\"owner\",\"role\":\"owner\"}},\"at\":\"2026-11-01T00:00:00.000Z\",\"source\":{\"sourceHash\":\"329e72791b8eb45e9f732a4bb377157bef4dfbf861d9573c95686ea7aab7faa2\",\"projectHash\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\",\"record\":{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"},\"inputs\":[{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"}],\"files\":[{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},{\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"},{\"path\":\"inputs/reference.png\",\"sha256\":\"3521306987ffe39409d60ad1be5c754bad7ba778d10542603afb071ff0a4bce6\"},{\"path\":\"inputs/spec.json\",\"sha256\":\"af8533d3a15c4f04463063a5044d001fbc5339043e0ea1dbcfdae98254fcfb00\"},{\"path\":\"plan/context-evidence.json\",\"sha256\":\"65f537c4c38b1ca3577737004a082ca518051cf9b37a96f7bfc255402a366669\"},{\"path\":\"project.json\",\"sha256\":\"d1e58b0ea47eae41f7db4d88efd10949ec7d4c0061b367e53a984a2e7b80b86d\"}],\"checkpointEvidence\":[{\"schema\":\"rig-review-checkpoint-evidence/1\",\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"tiles\":[{\"id\":\"tile\",\"label\":\"Exact tile\",\"path\":\"evidence/golden.png\",\"sha256\":\"cc5d7bbb27b20159048ed1e75986bc3f958320befe1244656054c68200ae56e6\"}],\"table\":{\"path\":\"evidence/golden.json\",\"sha256\":\"7b3024b50af3f2a7b6ade16bd9f78f8116989c0be7cc2bc9794b712f58d5e58a\"},\"routesText\":\"Pass or fail\",\"recommendationText\":\"Exact recommendation\"}],\"subject\":\"plan\",\"selection\":{\"kind\":\"plan\"},\"optionSet\":null,\"optionSetFile\":null,\"plan\":{\"steps\":[{\"id\":\"step_layout\",\"hash\":\"1111111111111111111111111111111111111111111111111111111111111111\"},{\"id\":\"step_weights\",\"hash\":\"2222222222222222222222222222222222222222222222222222222222222222\"}]},\"subjects\":[{\"kind\":\"checkpoint\",\"checkpointId\":\"step_layout\"},{\"kind\":\"checkpoint\",\"checkpointId\":\"step_weights\"},{\"kind\":\"signoff\",\"stage\":\"plan-approved\"},{\"kind\":\"signoff\",\"stage\":\"rigging-interview\"},{\"kind\":\"signoff\",\"stage\":\"post-interview\"}]},\"value\":{\"checkpointId\":\"step_layout\",\"planStepId\":\"step_layout\",\"outcome\":\"pass\",\"words\":\"  Exact 한글\\n\"}}"
    }
  },
  "publicExports": [
    "JOB_ACT_SCHEMA",
    "JOB_API_SCHEMA",
    "JOB_API_V3_SCHEMA",
    "JOB_CAPABILITIES",
    "JOB_CONSUMER_AUTH_MODE",
    "JOB_ENABLED_ACT_KINDS",
    "JOB_ERROR_CODES",
    "JOB_PARTS_ENUMERATOR_RANGE",
    "JOB_PLAN_BOUND_SIGNOFF_STAGES",
    "JOB_RECORD_ACT_SCHEMA",
    "JOB_RECORD_READER_ID",
    "JOB_RESERVED_ACT_KINDS",
    "parseRecordAct",
    "prepareJobRecordAct",
    "prepareJobRecordSource",
    "startJobHost",
    "startJobHub"
  ]
};

function act6From606(bytes: string): string {
  const act = JSON.parse(bytes);
  const {words, ...value} = act.value;
  return JSON.stringify({...act, schema: 'rig-review/act@6', value: {...value,
    comments: [{text: words, anchor: {checkpointId: value.checkpointId, planStepId: value.planStepId}}]}});
}

test('#606 literal package/record canonical, durable, replay and export compatibility in evidence/absence cases', async () => {
  const {collect606Canonical} = await import('./helpers/job-api-fixture.ts');
  const actual = await collect606Canonical();
  // Preserve every historical literal sample and the old export inventory; only
  // the approved facade changes affect the current export oracle.
  // #713: the package checkpoint writer now emits act@6. The frozen @2 literals stay above;
  // the expected package bytes are derived from them. Record samples keep act@4.
  const samples = Object.fromEntries(Object.entries(golden606.samples).map(([name, sample]) => [name,
    name.startsWith('package-') ? Object.fromEntries(Object.entries(sample).map(([key, bytes]) =>
      [key, /actbytes$/i.test(key) ? act6From606(bytes) : bytes])) as typeof sample : sample]));
  const expected = {...golden606, samples, publicExports: [...golden606.publicExports.filter(name => name !== 'startJobHub' && name !== 'prepareJobRecordAct'),
    'JOB_COMMENTS_ACT_SCHEMA', 'PARTS_COMMENTS_VERDICT_SCHEMA', 'REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA', 'REVIEW_COMMENTS_SESSION_SCHEMA',
    'parseCommentsAct', 'parseCommentsCompareSession', 'parseCommentsPartsVerdict', 'parseCommentsSession', 'projectComments', 'projectSelectedCommentsFeedback',
    'JOB_COMMENT_CONTEXT_ACT_SCHEMA', 'parseContextCommentsAct',
    'JOB_MESH_EDITS_ACT_SCHEMA', 'parseMeshEditsAct', 'JOB_PREVIOUS_DRAFT_SCHEMA', 'waitForJobAct',
    'JOB_CHEST_LANDMARKS_ACT_SCHEMA', 'parseChestLandmarksAct',
    'parseCheckpointEvidencePacket',
    'JOB_COMMENT_ONLY_ACT_SCHEMA', 'parseCommentOnlyAct',
  ].sort()};
  expect(actual).toEqual(expected);
  for (const [name, sample] of Object.entries(actual.samples)) {
    expect(sample.durableSourceBytes).toBe(sample.sourceBytes);
    expect(sample.replayActBytes).toBe(sample.durableActBytes);
    expect(sample.reopenedActBytes).toBe(sample.durableActBytes);
    const changed = structuredClone(actual);
    changed.samples[name]!.sourceHash = '0'.repeat(64);
    expect(() => expect(changed).toEqual(expected)).toThrow();
  }
});

import {retainedPublicationRoutes} from '../src/job-front.ts';
import {planTextMetadata, projectRetainedPlanText, isRetainedRecordSource} from '../src/job-source.ts';
import {parseJobPlanTextProjection, JOB_RECORD_READER_ID, type JobPlanTextProjection} from '../src/job-contract.ts';
import {jobPlanTextForSource} from '../web/job-session.ts';
import {createSyntheticPlanRecordWorkspace} from './helpers/job-record-fixture.ts';

const exact606 = {does:'  <mark>do</mark> 한글 e\u0301\r\n\t ', produces:'',bar:' bar\r\nvalue ',rests_on:['bones','bones','']};
async function textFixture606(kind:'package'|'record', change?:(project:any)=>void) {
  const f = await fixture();
  const synthetic = createSyntheticPlanRecordWorkspace(f.root);
  const project = JSON.parse(await readFile(join(f.root,'project.json'),'utf8'));
  Object.assign(project.plan.steps[0],exact606);
  Object.assign(project.plan.steps[1],exact606);
  change?.(project);
  const bytes = JSON.stringify(project);
  await writeFile(join(f.root,'project.json'),bytes);
  const record = {path:'project.json' as const,sha256:jobHash(bytes)};
  const context = {...synthetic.context,files:synthetic.files.map(file => file.path === 'project.json' ? record : file)};
  let session = f.session;
  let publication:any;
  if (kind === 'package') {
    f.setRecordPath('project.json');
    f.setContext({...f.getContext(),plan:{steps:[context.plan.steps[0]!]},files:context.files,
      subjects:[{kind:'checkpoint',checkpointId:'alias',planStepId:'step_layout'}]});
    publication = await f.publish();
  } else {
    session = new JobSession({root:f.root,stateDir:join(f.scratch,'record-state'),fingerprint:'record-text',
      reviewer:{id:'owner',role:'owner'},publicationMode:'record-and-package',recordReaderId:JOB_RECORD_READER_ID,
      readRecordPublished:(() => structuredClone(context)) as any});
    const {createJobHostPorts} = await import('../src/job-api.ts');
    const ports = createJobHostPorts(session,f.origin);
    const response = await ports.handleJobApi(new Request(f.origin+'/jobs/'+session.jobId+'/api',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+session.hostCredentials().agent},
      body:JSON.stringify({schema:'rig-review/job-api@3',jobId:session.jobId,requestId:'publish',verb:'publish',
        expectedGeneration:0,idempotencyKey:'publish',freeze:{kind:'producer-held',holdId:'held',record},result:{kind:'plan'}})}));
    const result = await response.json();
    expect(result.ok).toBe(true);
    publication = result.value;
  }
  const routes = retainedPublicationRoutes(session);
  const metadata = (method='GET') => routes(session.jobId,publication.publicationId,publication.instanceKey,'api/review',new Request(f.origin+'/api/review',{method}));
  return {f,session,publication,metadata,record,close:() => {if (session !== f.session) session.dispose();}};
}

test('#606 D1/D2 normal metadata authenticates retained project and preserves four fields, alias mapping and source bytes',async()=>{
  for (const kind of ['package','record'] as const) {
    const f = await textFixture606(kind);
    try {
      const retained = f.session.retainedSourceV3(f.publication.publicationId);
      const before = JSON.stringify(retained.source);
      await writeFile(join(f.f.root,'project.json'),'live record changed after publication');
      const response = await f.metadata();expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.planText.record).toEqual(f.record);
      expect(body.planText.steps).toHaveLength(kind === 'package' ? 1 : 2);
      expect(body.planText.steps[0]).toEqual({id:'step_layout',hash:'1'.repeat(64),...exact606,issues:[]});
      expect(Object.keys(body.planText.steps[0])).toEqual(['id','hash','does','produces','bar','rests_on','issues']);
      expect(JSON.stringify(retained.source)).toBe(before);
      expect(jobPlanTextForSource(body.planText,retained.source)).toEqual(body.planText);
      if (kind === 'package') {
        // #1229: jobCheckpointContext retired with the checkpoint form; plan step projection remains source-bound.
        expect(retained.source.plan?.steps[0]?.id).toBe('step_layout');
        expect(body.planText.steps.find((row:any)=>row.id===retained.source.plan!.steps[0]!.id&&row.hash===retained.source.plan!.steps[0]!.hash).bar).toBe(exact606.bar);
      } else expect(body.recordSource).toEqual(retained.source);
      const altered = structuredClone(body.planText);altered.steps[0].bar = 'type-valid post-server text';
      expect(jobPlanTextForSource(altered,retained.source)?.status).toBe('projected');
      for (const alter of [
        (x:any)=>{x.record.sha256='0'.repeat(64);},
        (x:any)=>{x.steps[0].hash='0'.repeat(64);},
        (x:any)=>{x.steps[0].id='another';},
      ]) {
        const wrong = structuredClone(body.planText);alter(wrong);
        expect(()=>jobPlanTextForSource(wrong,retained.source)).toThrow('PLAN_TEXT_SOURCE_MISMATCH');
      }
      await writeFile(join(retained.snapshotRoot,'project.json'),'tampered sealed record');
      const refused = await f.metadata();expect(refused.status).toBe(409);
      expect((await refused.json()).error.message).toBe('PLAN_TEXT_RECORD_HASH_MISMATCH');
      expect((await f.metadata('HEAD')).status).toBe(409);
    } finally {f.close();}
  }
});

test('#606 missing versus malformed fields and legacy mapping/limits stay explicit and source-bound',async()=>{
  const f = await textFixture606('record',project=>{
    delete project.plan.steps[0].produces;
    project.plan.steps[0].bar = null;
    project.plan.steps[0].rests_on = ['okay',2];
  });
  try {
    const retained = f.session.retainedSourceV3(f.publication.publicationId);
    const projection = projectRetainedPlanText(retained)!;
    expect(projection.status).toBe('projected');
    if (projection.status !== 'projected') throw new Error('Expected fields');
    expect(projection.steps[0]).toEqual({id:'step_layout',hash:'1'.repeat(64),does:exact606.does,issues:[
      {field:'produces',reason:'absent'},{field:'bar',reason:'invalid'},{field:'rests_on',reason:'invalid'}]});
    expect(parseJobPlanTextProjection(projection)).toEqual(projection);
    const invalid = structuredClone(projection) as any;
    invalid.steps[0].issues[0].field = 'bar';
    expect(()=>parseJobPlanTextProjection(invalid)).toThrow('PLAN_TEXT_METADATA_INVALID');
    expect(()=>projectRetainedPlanText({...retained,source:{...retained.source,projectHash:'0'.repeat(64)}} as any))
      .toThrow('PLAN_TEXT_RECORD_MISMATCH');
    const fullOverhead = Buffer.byteLength(JSON.stringify({payload:'',planText:projection}));
    const base = {payload:'x'.repeat(2*1024*1024 - fullOverhead + 1)};
    const fallback = planTextMetadata(retained,base) as any;
    expect(fallback.planText.reason).toBe('PLAN_TEXT_LIMIT');
    expect(Buffer.byteLength(JSON.stringify(fallback))).toBeLessThanOrEqual(2*1024*1024);
    const small = {...base,planText:{schema:'rig-review/job-plan-text@1',record:projection.record,status:'unavailable',reason:'PLAN_TEXT_LIMIT'}};
    const overhead = Buffer.byteLength(JSON.stringify(small))-base.payload.length;
    expect(Buffer.byteLength(JSON.stringify(planTextMetadata(retained,{payload:'x'.repeat(2*1024*1024-overhead)})))).toBe(2*1024*1024);
    expect(()=>planTextMetadata(retained,{payload:'x'.repeat(2*1024*1024-overhead+1)})).toThrow('PLAN_TEXT_LIMIT');
  } finally {f.close();}
  for (const [change,reason] of [
    [(p:any)=>{p.plan.steps[0].bar='x'.repeat(512*1024);},'PLAN_TEXT_LIMIT'],
    [(p:any)=>{p.plan.steps[0].rests_on=Array(4097).fill('a');},'field-limit'],
    [(p:any)=>{
      p.interview.waypoints = [{id:'a',prompts:[{text:'First?'},{text:'Second?'}]}];
      p.plan.steps[0].rests_on = Array(2049).fill('a');
    },'field-limit'],
  ] as const) {
    const f = await textFixture606('package',change);
    try {
      const body = await (await f.metadata()).json();
      if (reason === 'field-limit') expect(body.planText.steps[0].issues).toContainEqual({field:'rests_on',reason:'limit'});
      else expect(body.planText.reason).toBe(reason);
    } finally {f.close();}
  }
});

test('#606 explicit legacy absence and D1 mapping reasons preserve identities; parser keeps 4096 source identities',async()=>{
  for (const [change,reason] of [
    [(p:any)=>{delete p.plan;},'PLAN_TEXT_STEPS_ABSENT'],
    [(p:any)=>{p.plan=null;},'PLAN_TEXT_STEPS_INVALID'],
    [(p:any)=>{p.plan.steps='invalid';},'PLAN_TEXT_STEPS_INVALID'],
    [(p:any)=>{p.plan.steps[0].id='different';},'PLAN_TEXT_MAPPING_UNAVAILABLE'],
    [(p:any)=>{p.plan.steps.push(structuredClone(p.plan.steps[0]));},'PLAN_TEXT_MAPPING_UNAVAILABLE'],
  ] as const) {
    const f=await textFixture606('package',change);
    try {
      const before=JSON.stringify(f.publication.source);
      const body=await (await f.metadata()).json();
      expect(body.planText.reason).toBe(reason);
      expect(JSON.stringify(f.publication.source)).toBe(before);
    } finally {f.close();}
  }
  const f=await textFixture606('record');
  try {
    const retained=f.session.retainedSourceV3(f.publication.publicationId);
    expect(projectRetainedPlanText({...retained,record:{...retained.record!,path:'record.json'}} as any)).toMatchObject({status:'unavailable',reason:'PLAN_TEXT_RECORD_UNSUPPORTED'});
    expect(projectRetainedPlanText({...retained,record:null} as any)).toMatchObject({status:'unavailable',reason:'PLAN_TEXT_RECORD_UNAVAILABLE'});
    expect(projectRetainedPlanText({...retained,source:{...retained.source,plan:null}} as any)).toBeUndefined();
    expect(jobPlanTextForSource(undefined,retained.source)).toBeUndefined();
    const {buildRecordSource,parseRecordPublishedContext,parseRecordSource}=await import('../src/job-api.ts');
    if (!isRetainedRecordSource(retained)) throw new Error('Expected record');
    const steps=[...retained.source.plan!.steps,...Array.from({length:4094},(_,i)=>({id:'extra-'+i,hash:'d'.repeat(64)}))];
    const context={...retained.context,plan:{steps}};
    expect(parseRecordPublishedContext(context,{kind:'plan'},retained.record).plan!.steps).toHaveLength(4096);
    const source=buildRecordSource({record:retained.record,selection:{kind:'plan'},context:context as any});
    expect(parseRecordSource(source).plan!.steps).toHaveLength(4096);
    const tooMany={...context,plan:{steps:[...steps,{id:'extra-over-limit',hash:'d'.repeat(64)}]}};
    expect(()=>parseRecordPublishedContext(tooMany,{kind:'plan'},retained.record)).toThrow();
    expect(()=>parseRecordSource({...source,plan:tooMany.plan})).toThrow();
    const raw=JSON.parse(await readFile(join(f.f.root,'project.json'),'utf8'));
    raw.plan.steps.reverse();
    const bytes=JSON.stringify(raw), record={path:'project.json' as const,sha256:jobHash(bytes)};
    await writeFile(join(f.f.root,'project.json'),bytes);
    const {captureJobRoot,prepareJobRecordSource}=await import('../src/job-source.ts');
    const contextReordered={...retained.context,files:retained.context.files.map(file=>file.path==='project.json'?record:file)};
    await expect(prepareJobRecordSource({root:captureJobRoot(f.f.root),stateRoot:join(f.f.scratch,'reordered-state'),fingerprint:'reordered',
      request:{freeze:{kind:'producer-held',holdId:'held',record},result:{kind:'plan'}},
      readRecordPublished:(() => structuredClone(contextReordered)) as any})).rejects.toMatchObject({code:'JOB_SOURCE_MISMATCH'});
  } finally {f.close();}
});


test('#606 closed metadata grammar rejects malformed value/issue entries while retaining valid empty fields',()=>{
  const good:any={schema:'rig-review/job-plan-text@1',record:{path:'project.json',sha256:'a'.repeat(64)},status:'projected',
    steps:[{id:'step',hash:'b'.repeat(64),does:'',produces:' ',bar:'\r\n',rests_on:[],issues:[]}]};
  expect(parseJobPlanTextProjection(good)).toEqual(good);
  const withQuestions:any={...structuredClone(good),questions:{post_timing:'How long, does it loop, and where are the beats?'}};
  expect(parseJobPlanTextProjection(withQuestions)).toEqual(withQuestions);
  const multiple = structuredClone(withQuestions);
  multiple.questions.assemble = ['First?', 'Second?'];
  multiple.steps[0].rests_on = Array(2048).fill('assemble');
  expect(parseJobPlanTextProjection(multiple)).toEqual(multiple);
  multiple.steps[0].rests_on.push('assemble');
  expect(()=>parseJobPlanTextProjection(multiple)).toThrow('PLAN_TEXT_METADATA_INVALID');
  for (const mutate of [
    (p:any)=>{p.unknown=true;},
    (p:any)=>{p.record.path='other.json';},
    (p:any)=>{p.steps[0].unknown=true;},
    (p:any)=>{p.steps[0].bar=null;},
    (p:any)=>{delete p.steps[0].bar;},
    (p:any)=>{p.steps[0].rests_on=['a',null];},
    (p:any)=>{p.steps[0].rests_on=Array(4097).fill('a');},
    (p:any)=>{delete p.steps[0].bar;p.steps[0].issues=[{field:'bar',reason:['absent']}];},
    (p:any)=>{delete p.steps[0].bar;p.steps[0].issues=[{field:'bar',reason:'absent',extra:true}];},
    (p:any)=>{p.steps.push(structuredClone(p.steps[0]));},
    (p:any)=>{p.questions=null;},
    (p:any)=>{p.questions=[];},
    (p:any)=>{p.questions={'bad id':'text'};},
    (p:any)=>{p.questions={post_timing:123};},
    (p:any)=>{p.questions={assemble:['First?', ' ']};},
    (p:any)=>{p.questions={assemble:['First?', null]};},
    (p:any)=>{p.status='unavailable';delete p.steps;p.reason='PLAN_TEXT_LIMIT';p.questions={post_timing:'text'};},
  ]) {const bad=structuredClone(good);mutate(bad);expect(()=>parseJobPlanTextProjection(bad)).toThrow('PLAN_TEXT_METADATA_INVALID');}
});

test('#813 package projection excludes pending and unrelated option-set images and retains history', async () => {
  const f = await fixture();
  await joinedVerdictFixture(f.root, '2-rigging-answers');
  const questions = readProject(f.root).questions;
  const pending = questions.find(question => question.editable)!;
  f.setRecordPath('project.json');
  const routes = retainedPublicationRoutes(f.session);
  for (const includeInterview of [false, true]) {
    f.setContext({...f.getContext(), plan: null, subjects: includeInterview ? [{kind: 'interview-picks',
      questionId: pending.set.question, setId: pending.set.id}] : []});
    const published = await f.publish();
    const retained = f.session.retainedSource(published.publicationId);
    const before = JSON.stringify(retained.questions);
    const response = await routes(f.session.jobId, published.publicationId, published.instanceKey, 'api/interview',
      new Request(f.origin + '/api/interview'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.questions).toHaveLength(questions.length);
    for (const question of body.questions) {
      const original = questions.find(item => item.set.id === question.set.id)!;
      expect(question.images).toHaveLength(0);
      if (original.editable) expect(question.hasParts).toBe(false);
      expect(question.answer).toEqual(original.answer);
    }
    expect(JSON.stringify(retained.questions)).toBe(before);
  }
});
