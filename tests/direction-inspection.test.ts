import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview, parseManifest } from '../src/manifest.ts';
import { assertReviewUnchanged } from '../src/reference.ts';
import { startServer } from '../src/server.ts';
import { freshSession } from '../src/session.ts';
import { verifyCompiledModel } from '../src/strip-render.ts';
import { directionRows } from '../web/direction-panel.ts';
import { t } from '../web/i18n.ts';
import { stageReason } from '../web/stage-nav.ts';

const fixture = 'tests/fixtures/direction-inspection';
const expected = {
  'derived/review/v1/out/check/build/skeleton.model.json': '63190ec6746bafbc73847fa6c6905b5811cc0adb41897dfed923fe802e4dc261',
  'derived/review/v1/out/check/build/rectangle.png': '6030af0b8c57d0f6f3a25cf417b7d4fb3b442c1e0a4f441e4918623db571e511',
  'evidence/direction/v2.json': '9bec50f753d4790ee0d9dde824a612126ed37e7b0e63d393505ac836118c50a4',
};

test('pinned Create output loads in published Play and reports only its actual direction capabilities', async () => {
  const pkg = await loadReview(fixture);
  await verifyCompiledModel(pkg.root, pkg.manifest.model, 'turn');
  expect(stageReason(4, true, true)).toBeNull();
  expect(pkg.feedbackCatalog.turnDials?.map(d => d.axis)).toEqual(['yaw']);
  const rig = pkg.reviewedSource.rig!;
  expect(rig.sha256).toBe(expected['derived/review/v1/out/check/build/skeleton.model.json']);
  expect(pkg.direction?.camera.keys.map(k => k.time)).toEqual([0, 4]);
  expect(pkg.direction?.camera.keys[1]?.box).toEqual({ x: -18, y: 4, width: 36, height: 72 });
  const view = {
    model: { ...rig, inspected: true }, revision: pkg.manifest.revision, sourceHash: pkg.sourceHash,
    runtime: pkg.reviewedSource.runtimeVersion, dials: pkg.feedbackCatalog.turnDials!, sets: [], authored: pkg.direction,
  };
  const rows = directionRows(view);
  for (const lang of ['en', 'ko'] as const) {
    const labels = rows.map(row => t(row.key, row.values, lang));
    expect(labels.join('\n')).toContain('yaw');
    expect(labels.join('\n')).toContain(rig.sha256);
    expect(labels.join('\n')).toContain(pkg.direction!.file.sha256);
    for (const code of ['DEPTH_UNAVAILABLE', 'SETS_UNAVAILABLE', 'CAMERA_PLAYBACK_UNAVAILABLE', 'CAMERA_APPLY_UNSUPPORTED'])
      expect(labels.join('\n')).toContain(code);
    expect(labels.some(label => label.startsWith('direction.'))).toBe(false);
  }
  expect(directionRows({ ...view, model: { ...view.model, inspected: false } }).map(row => row.key))
    .toContain('direction.authoredUnavailable');
  expect(stageReason(4, false, true)).toBeNull();
  const referenceOnly = directionRows({ ...view, model: null, dials: [], sets: [], authored: undefined });
  expect(referenceOnly.map(row => row.key)).toEqual([
    'direction.modelUnavailable', 'direction.package', 'direction.turnUnavailable',
    'direction.depthUnavailable', 'direction.setsUnavailable', 'direction.authoredUnavailable',
    'direction.runtimeCameraUnavailable', 'direction.cameraApplyUnavailable',
  ]);
  expect(freshSession(pkg).status).toBe('pending');
  for (const [path, sha256] of Object.entries(expected))
    expect(createHash('sha256').update(await readFile(join(fixture, path))).digest('hex'), path).toBe(sha256);
});

test('direction metadata is package-contained, model-bound and part of the rechecked source identity', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'direction-inspection-'));
  try {
    const root = join(temp, 'package');
    await cp(fixture, root, { recursive: true });
    const pkg = await loadReview(root);
    const dirFile = join(root, pkg.manifest.direction!);
    const original = await readFile(dirFile, 'utf8');
    await writeFile(dirFile, original + '\n');
    expect((await loadReview(root)).sourceHash).not.toBe(pkg.sourceHash);
    await expect(assertReviewUnchanged(pkg)).rejects.toThrow('Package inputs changed');

    const doc = JSON.parse(original);
    doc.rig.model.sha256 = '0'.repeat(64);
    await writeFile(dirFile, JSON.stringify(doc));
    await expect(loadReview(root)).rejects.toThrow('DIRECTION_MODEL_MISMATCH');
    await writeFile(dirFile, ' '.repeat(256 * 1024 + 1));
    await expect(loadReview(root)).rejects.toThrow('DIRECTION_SIZE');

    const outside = join(temp, 'outside.json');
    await writeFile(outside, original);
    await rm(dirFile);
    await symlink(outside, dirFile);
    await expect(loadReview(root)).rejects.toThrow('symlinks may not escape');
    for (const field of ['direction', 'sets'])
      expect(() => parseManifest({ ...pkg.manifest, [field]: '../outside.json' })).toThrow('literal relative path');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('the single-package API binds declared attachment sets and direction to the inspected model', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'direction-sets-'));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const root = join(temp, 'package');
    await cp(fixture, root, { recursive: true });
    const path = join(root, 'review.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    const sets = JSON.stringify({ spec: 'rig-parts-sets/1', sets: { 'hide-rectangle': { slots: {}, hides: ['rectangle'] } } });
    await writeFile(path, JSON.stringify({ ...manifest, sets: 'sets.json' }));
    await writeFile(join(root, 'sets.json'), sets);
    const pkg = await loadReview(root);
    await verifyCompiledModel(pkg.root, pkg.manifest.model, 'turn', pkg.manifest.sets);
    server = await startServer(pkg, { port: 0, stateDir: join(temp, 'state'), viewOnly: true });
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(origin + '/api/review');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.direction).toEqual(pkg.direction);
    expect(body.setsHash).toBe(createHash('sha256').update(sets).digest('hex'));
    expect(await (await fetch(origin + '/assets/sets.json')).text()).toBe(sets);
    expect((await (await fetch(origin + '/api/session')).json()).status).toBe('pending');
    await writeFile(join(root, 'sets.json'), sets + '\n');
    expect((await fetch(origin + '/api/review')).status).toBe(409);
  } finally {
    server?.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
});
