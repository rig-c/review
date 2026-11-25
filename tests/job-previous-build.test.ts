import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {cp, mkdir, readFile, stat, symlink, truncate, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createJobHostPorts, jobHash} from '../src/job-api.ts';
import {JOB_PREVIOUS_BUILD_SCHEMA, type JobPreviousBuild, type JobPublication} from '../src/job-contract.ts';
import {createJobFront, retainedPublicationRoutes} from '../src/job-front.ts';
import {JobSession} from '../src/job-session.ts';
import {loadReview, previousBuildByteLimit, previousBuildFiles} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

type Fixture = Awaited<ReturnType<typeof jobFixture>>;
const fixtures: Fixture[] = [];
const invalid = 'JOB_PREVIOUS_BUILD_INVALID';
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});

async function fixture(kind: 'rig' | 'post' = 'rig') {
  const f = await jobFixture();
  fixtures.push(f);
  const packageRoot = join(f.root, 'out');
  const modelBytes = await readFile(join(packageRoot, 'skeleton.model.json'));
  const pageBytes = await readFile(join(packageRoot, 'rigid.png'));
  if (kind === 'post') {
    await cp(new URL('./fixtures/direction-inspection', import.meta.url), packageRoot, {recursive: true});
    f.setContext({...f.getContext(), selector: {kind, version: 2, rigVersion: 1}});
  }
  await mkdir(join(packageRoot, 'prior/build'), {recursive: true});
  const manifestPath = join(packageRoot, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const seal = async (path: string, bytes: string | Buffer) => {
    await writeFile(join(packageRoot, path), bytes);
    return {path, sha256: jobHash(bytes)};
  };
  const model = await seal('prior/build/old.model.json', modelBytes);
  const atlas = await seal('prior/build/old.atlas', 'synthetic sealed atlas\n');
  const pages = await Promise.all(JSON.parse(modelBytes.toString()).pages.map(({name}: {name: string}) =>
    seal('prior/build/' + name, pageBytes)));
  await seal('prior/build/undeclared.png', pageBytes);
  const build: JobPreviousBuild = {schema: JOB_PREVIOUS_BUILD_SCHEMA, label: '  버전 1  ', currentLabel: 'Current · two',
    model, atlas, pages, clipMap: {inspect: 'inspect'}};
  const files = previousBuildFiles(build).map(file => ({...file, path: 'out/' + file.path}));
  return {f, packageRoot, manifestPath, manifest, build, files};
}

function jobRead(f: Fixture, publication: JobPublication, session = f.session) {
  const {apiBase, assetsBase} = session.displayPublication(publication.publicationId).routes;
  const front = createJobFront({origin: f.origin, ports: createJobHostPorts(session, f.origin), publication: retainedPublicationRoutes(session),
    resource: async () => ''});
  return {
    metadata: () => front.fetch(new Request(f.origin + apiBase + 'review')),
    asset: (path: string, init?: RequestInit) => front.fetch(new Request(f.origin + assetsBase + path, init)),
  };
}

test.each(['rig', 'post'] as const)('job %s retains one sealed prior build across source movement and restart', async kind => {
  const {f, packageRoot, build, files} = await fixture(kind);
  const baseline = await f.publish();
  const baselineBytes = await (await jobRead(f, baseline).metadata())!.text();
  expect(JSON.parse(baselineBytes).manifest).not.toHaveProperty('previousBuild');
  expect((await jobRead(f, baseline).asset(build.model.path))!.status).toBe(404);

  f.setContext({...f.getContext(), previousBuild: build, files});
  const publish = await f.publishRequest('sealed-prior-publish');
  const published = await f.call(publish);
  const publicationBytes = await published.text();
  const {value: publication} = JSON.parse(publicationBytes) as {value: JobPublication};
  expect(published.status).toBe(200);
  expect(publication.source.sourceHash).not.toBe(baseline.source.sourceHash);
  expect(publication.source.package).toEqual(baseline.source.package);
  expect(publication.source).not.toHaveProperty('previousBuild');
  const read = jobRead(f, publication);
  expect(await (await read.metadata())!.json()).toMatchObject({manifest: {previousBuild: build}});
  for (const file of previousBuildFiles(build)) {
    const response = (await read.asset(file.path))!;
    expect(response.status).toBe(200);
    expect(jobHash(new Uint8Array(await response.arrayBuffer()))).toBe(file.sha256);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    const cached = (await read.asset(file.path, {headers: {'If-None-Match': `"${file.sha256}"`}}))!;
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
  }
  expect((await read.asset('prior/build/undeclared.png'))!.status).toBe(404);
  expect((await read.asset(build.model.path, {method: 'PUT'}))!.status).toBe(405);

  // #1235: the sample act is the comment-only act@10; its source is the publication's, without the prior build.
  const page = await f.display(publication);
  const submit = {...page, expectedGeneration: f.session.status().generation,
    submissionId: 'current-only', kind: 'comments', value: {comments: [{text: 'Current only'}]}};
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(submit));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  expect(result.value.source.sourceHash).toBe(publication.source.sourceHash);
  expect(result.value.source).not.toHaveProperty('previousBuild');

  await writeFile(join(packageRoot, build.model.path), 'changed producer source');
  f.session.dispose();
  const reopened = new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}});
  try {
    const historical = jobRead(f, publication, reopened);
    expect(await (await historical.metadata())!.json()).toMatchObject({manifest: {previousBuild: build}});
    expect(jobHash(new Uint8Array(await (await historical.asset(build.model.path))!.arrayBuffer()))).toBe(build.model.sha256);
    expect(await (await jobRead(f, baseline, reopened).metadata())!.text()).toBe(baselineBytes);
    const ports = createJobHostPorts(reopened, f.origin);
    const replay = await ports.handleJobApi(new Request(f.origin + `/jobs/${reopened.jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + f.credentials.agent},
      body: JSON.stringify(publish),
    }));
    expect(replay.status).toBe(200);
    expect(JSON.stringify((await replay.json()).value)).toBe(JSON.stringify(publication));
    const actReplay = await ports.commitUIAct(reopened.jobId, f.uiRequest(submit));
    expect(actReplay.ok && JSON.stringify(actReplay.value)).toBe(JSON.stringify(result.value));
    const retained = reopened.retainedSource(publication.publicationId);
    await writeFile(join(retained.snapshotRoot, 'out', build.model.path), 'changed retained source');
    const stale = (await historical.asset(build.model.path))!;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({error: {code: invalid, message: expect.stringContaining(build.model.path)}});
    await truncate(join(retained.snapshotRoot, 'out', build.model.path), previousBuildByteLimit + 1);
    const tooLarge = (await historical.asset(build.model.path))!;
    expect(tooLarge.status).toBe(409);
    expect(await tooLarge.json()).toMatchObject({error: {code: invalid, message: expect.stringContaining(
      `asset bytes found=${previousBuildByteLimit + 1} limit=${previousBuildByteLimit}`),
    }});

    const db = new Database(join(f.state, 'jobs.sqlite'));
    try {
      const {document} = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(reopened.jobId)!;
      const row = JSON.parse(document);
      row.publications[publication.publicationId].retained.previousBuild.currentLabel = 'Tampered';
      db.query('UPDATE jobs SET document=? WHERE job_id=?').run(JSON.stringify(row), reopened.jobId);
      expect(() => reopened.status()).toThrow('JOB_SOURCE_MISMATCH');
    } finally {db.close();}
  } finally {reopened.dispose();}
});

test('standalone metadata and asset route use the same declaration and keep the absent form', async () => {
  const {f, packageRoot, manifestPath, manifest, build} = await fixture();
  const baseline = await loadReview(manifestPath);
  expect(baseline.manifest).not.toHaveProperty('previousBuild');
  const request = (path: string, init?: RequestInit) => new Request(f.origin + path, init);
  const open = {key: 'key', contentHash: 'hash', nonce: 'synthetic-nonce', fingerprint: 'fingerprint'};
  const serve = async (p: typeof baseline) => {
    const context = await createReviewRequestContext(p, {bundle: new Blob(), stateDir: f.state, open});
    return {handle: (req: Request) => context.handle(req, 19484, {} as never), stop: () => context.stop()};
  };
  const absent = await serve(baseline);
  try {
    expect((await (await absent.handle(request('/api/review')))!.json()).manifest).not.toHaveProperty('previousBuild');
    expect((await absent.handle(request('/assets/' + build.model.path)))!.status).toBe(404);
  } finally {absent.stop();}
  const previousBuild = {...build, clipMap: {}};
  await writeFile(manifestPath, JSON.stringify({...manifest, previousBuild}));
  const loaded = await loadReview(manifestPath);
  expect(loaded.sourceHash).not.toBe(baseline.sourceHash);
  expect(loaded.reviewedSource).toEqual(baseline.reviewedSource);
  const server = await serve(loaded);
  try {
    const metadata = (await server.handle(request('/api/review')))!;
    expect(await metadata.json()).toMatchObject({manifest: {revision: manifest.revision, previousBuild}});
    for (const file of previousBuildFiles(build)) {
      const asset = (await server.handle(request('/assets/' + file.path)))!;
      expect(asset.status).toBe(200);
      expect(jobHash(new Uint8Array(await asset.arrayBuffer()))).toBe(file.sha256);
      const head = (await server.handle(request('/assets/' + file.path, {method: 'HEAD'})))!;
      expect(head.headers.get('Content-Length')).toBe(asset.headers.get('Content-Length'));
      expect(await head.text()).toBe('');
    }
    expect((await server.handle(request('/assets/prior/build/undeclared.png')))!.status).toBe(404);
    await writeFile(join(packageRoot, build.atlas.path), 'changed atlas');
    const stale = (await server.handle(request('/assets/' + build.atlas.path)))!;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({error: invalid, detail: expect.stringContaining(build.atlas.path)});
    const oversized = previousBuildByteLimit + 1;
    await truncate(join(packageRoot, build.atlas.path), oversized);
    const asset = (await server.handle(request('/assets/' + build.atlas.path)))!;
    expect(asset.status).toBe(409);
    expect(await asset.json()).toEqual({error: invalid, detail: expect.stringContaining(
      `asset bytes found=${oversized} limit=${previousBuildByteLimit}`)});
    const modelSize = (await stat(join(packageRoot, build.model.path))).size;
    for (const path of ['/api/review', '/api/session', '/api/open-status']) {
      const response = (await server.handle(request(path, {headers: {Authorization: 'Bearer ' + open.nonce}})))!;
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error).toBe(invalid);
      expect(body.detail).toContain(`closure bytes through asset found=${modelSize + oversized} limit=${previousBuildByteLimit}`);
      expect(body.detail).toContain(build.atlas.path);
      expect(body.detail).not.toContain(packageRoot);
      if (path === '/api/open-status') expect(body).toMatchObject({schema: 'rig-review-open-status/1', ready: false});
    }
  } finally {server.stop();}
});

test.each([
  'path escape', 'absolute declaration path', 'hash mismatch', 'missing map', 'overlong label', 'overlong current label',
  'overlong clip key', 'overlong clip value', 'overlong path', 'too many clips', 'too many declared pages',
  'oversized declaration', 'missing page', 'missing atlas', 'extra page', 'symlink escape', 'runtime path escape',
  'too many runtime pages', 'oversized closure',
] as const)('both loaders refuse %s by name', async failure => {
  const {f, packageRoot, manifestPath, manifest, build, files} = await fixture();
  const planted: Record<string, unknown> = {...build};
  let detail: string | undefined;
  if (failure === 'path escape') planted.model = {...build.model, path: '../outside.model.json'};
  if (failure === 'absolute declaration path') planted.model = {...build.model, path: join(f.root, 'outside.model.json')};
  if (failure === 'hash mismatch') {
    await writeFile(join(packageRoot, build.model.path), 'different bytes');
    detail = `hash mismatch path="${build.model.path}"`;
  }
  if (failure === 'missing map') delete planted.clipMap;
  if (failure === 'overlong label') {
    planted.label = '한'.repeat(43);
    detail = 'label UTF-8 bytes found=129 limit=128';
  }
  if (failure === 'overlong current label') {
    planted.currentLabel = 'A'.repeat(129);
    detail = 'currentLabel UTF-8 bytes found=129 limit=128';
  }
  if (failure === 'overlong clip key') {
    planted.clipMap = {['한'.repeat(43)]: 'inspect'};
    detail = 'clipMap key UTF-8 bytes found=129 limit=128';
  }
  if (failure === 'overlong clip value') {
    planted.clipMap = {inspect: 'A'.repeat(129)};
    detail = 'clipMap value UTF-8 bytes found=129 limit=128';
  }
  if (failure === 'overlong path') {
    planted.model = {...build.model, path: 'x'.repeat(4086) + '.model.json'};
    detail = 'model.path code units found=4097 limit=4096';
  }
  if (failure === 'too many clips') {
    planted.clipMap = Object.fromEntries(Array.from({length: 257}, (_, index) => ['clip-' + index, 'inspect']));
    detail = 'clipMap entries found=257 limit=256';
  }
  if (failure === 'too many declared pages') {
    planted.pages = Array.from({length: 65}, (_, index) => ({...build.pages[0], path: `page-${index}.png`}));
    detail = 'pages count found=65 limit=64';
  }
  if (failure === 'oversized declaration') {
    planted.pages = Array.from({length: 64}, (_, index) => ({...build.pages[0], path: `${'x'.repeat(1024)}-${index}.png`}));
    detail = `declaration bytes found=${Buffer.byteLength(JSON.stringify(planted))} limit=65536`;
  }
  if (failure === 'oversized closure') {
    await truncate(join(packageRoot, build.atlas.path), previousBuildByteLimit);
    const modelSize = (await stat(join(packageRoot, build.model.path))).size;
    detail = `closure bytes through asset found=${modelSize + previousBuildByteLimit} limit=${previousBuildByteLimit}`;
  }
  if (failure === 'missing page') planted.pages = build.pages.slice(1);
  if (failure === 'missing atlas') delete planted.atlas;
  if (failure === 'extra page') {
    const path = 'prior/build/undeclared.png', sha256 = jobHash(await readFile(join(packageRoot, path)));
    planted.pages = [...build.pages, {path, sha256}];
    files.push({path: 'out/' + path, sha256});
  }
  if (failure === 'symlink escape') {
    const outside = join(f.root, 'outside.model.json');
    await cp(join(packageRoot, build.model.path), outside);
    const path = 'prior/build/linked.model.json';
    await symlink(outside, join(packageRoot, path));
    planted.model = {...build.model, path};
    files.push({path: 'out/' + path, sha256: build.model.sha256});
    detail = `asset unavailable or outside package path="${path}"`;
  }
  if (failure === 'runtime path escape' || failure === 'too many runtime pages') {
    const path = join(packageRoot, build.model.path), model = JSON.parse(await readFile(path, 'utf8'));
    if (failure === 'runtime path escape') {
      model.pages[0].name = '../../../escape.png';
      detail = `invalid compiled model or runtime page path="${build.model.path}"`;
    } else {
      model.pages = Array.from({length: 65}, (_, index) => ({name: `page-${index}.png`}));
      detail = 'model pages count found=65 limit=64';
    }
    const encoded = JSON.stringify(model), sha256 = jobHash(encoded);
    await writeFile(path, encoded);
    planted.model = {...build.model, sha256};
    files[0] = {...files[0], sha256};
  }
  f.setContext({...f.getContext(), previousBuild: planted as unknown as JobPreviousBuild, files});
  const response = await f.call(await f.publishRequest());
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toMatchObject({ok: false, generation: 0, error: {code: invalid}});
  expect(body.error.message).not.toContain(f.root);
  if (detail) expect(body.error.message).toContain(detail);
  await writeFile(manifestPath, JSON.stringify({...manifest, previousBuild: planted}));
  await expect(loadReview(manifestPath)).rejects.toMatchObject({code: invalid, message: body.error.message});
});

test('job requires the trusted root-relative seals and matching manifest declaration', async () => {
  const {f, manifest, manifestPath, build, files} = await fixture();
  for (const malformed of [files.filter(file => !file.path.endsWith('.atlas')), previousBuildFiles(build)]) {
    f.setContext({...f.getContext(), previousBuild: build, files: malformed});
    const response = await f.call(await f.publishRequest());
    expect(await response.json()).toMatchObject({ok: false, generation: 0, error: {code: invalid}});
  }
  await writeFile(manifestPath, JSON.stringify({...manifest, previousBuild: {...build, currentLabel: 'Different'}}));
  f.setContext({...f.getContext(), previousBuild: build, files});
  const response = await f.call(await f.publishRequest());
  expect(await response.json()).toMatchObject({ok: false, generation: 0, error: {code: invalid}});
  await writeFile(manifestPath, JSON.stringify({...manifest, previousBuild: build}));
  const publication = await f.publish();
  expect(await (await jobRead(f, publication).metadata())!.json()).toMatchObject({manifest: {previousBuild: build}});
});

test('job draft and uncompiled standalone package reject a previous build', async () => {
  const {f, manifest, manifestPath, build, files} = await fixture();
  f.setContext({...f.getContext(), selector: {kind: 'draft', id: 'synthetic-draft'}, previousBuild: build, files});
  const response = await f.call(await f.publishRequest());
  expect(await response.json()).toMatchObject({ok: false, generation: 0, error: {code: invalid}});
  await writeFile(manifestPath, JSON.stringify({...manifest, model: undefined, previousBuild: build}));
  await expect(loadReview(manifestPath)).rejects.toThrow(invalid);
});
