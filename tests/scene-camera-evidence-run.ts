/** Review #1316. Run on Nova with the frozen public Play fixture and independent Parts/Core raster receipts. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {playBuildConditions} from '../src/build.ts';
import {resolvedCropPath, validateCommentCrop} from '../src/comment-crops.ts';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import type {ReviewSession} from '../src/session.ts';
import {parseStageComment, type StageComment} from '../src/stage-comment.ts';
import {parseBookmark} from '../web/inspection-persistence.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {compareSceneCameraPixels, displayPixels, near, readSceneCameraInputs, sha256, writeSceneCameraPackage,
  type Point, type Rect, type Sample, type Stage} from './helpers/scene-camera-evidence.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

function arg(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index < 0 ? fallback : Bun.argv[index + 1];
  assert.ok(value && !value.startsWith('--'), `${name} requires a directory`);
  return resolve(value);
}

const fixture = arg('--fixture', Bun.env.REVIEW_1316_PLAY_FIXTURES);
const producerPngs = arg('--producer-pngs', Bun.env.REVIEW_1316_PRODUCER);
const out = arg('--out', 'artifacts/review-1316-scene-camera');
await mkdir(out, {recursive: true});
const scratch = await mkdtemp(join(tmpdir(), 'review-scene-camera-'));

type Reading = {
  time: number; duration: number; compiled: number | null; trackTime: number | null;
  playing: boolean; animation: string; modelHash: string; language: string; dpr: number;
  phase: {authored: number; compiled: number; zoom: number; view: Rect} | null;
  canvas: Rect | null; pane: Rect; slots: {slot: string; points: number[]}[];
};
type SavedMark = {id: string; comment: unknown};
type Wrap = {before: Reading; after: Reading};
const key = 'window.__reviewSceneCamera';
const probe = `
const readSceneCameraEvidence = () => {
  const pane = el('rig-viewport'), rect = pane.getBoundingClientRect();
  const drawn = drawnSceneCamera;
  const entry = player?.entry(0);
  const canvas = drawn?.canvas.getBoundingClientRect();
  return {
    time, duration, compiled: entry?.animationTime ?? null, trackTime: entry?.trackTime ?? null,
    playing, animation, modelHash: stageModelHash, language: document.documentElement.lang, dpr: devicePixelRatio,
    phase: drawn ? {authored: drawn.frame.authoredSeconds, compiled: drawn.frame.compiledSeconds,
      zoom: drawn.frame.zoom, view: drawn.frame.viewWorld} : null,
    canvas: canvas?.toJSON() ?? null,
    pane: {x: rect.left + pane.clientLeft, y: rect.top + pane.clientTop, width: pane.clientWidth, height: pane.clientHeight},
    slots: drawn?.pose.order.map(row => ({slot: row.slot, points: Array.from(row.kind === 'mesh' ? row.vertices : row.corners)})) ?? [],
  };
};
let observedSceneCameraWrap = null, watchSceneCameraWrap = false;
const originalSceneCameraTick = tickPlaying;
tickPlaying = (now, useReference) => {
  const before = watchSceneCameraWrap && time > duration - .2 ? readSceneCameraEvidence() : null;
  originalSceneCameraTick(now, useReference);
  if (before && time < before.time) {
    observedSceneCameraWrap = {before, after: readSceneCameraEvidence()};
    watchSceneCameraWrap = false;
  }
};
Object.assign(window, {__reviewSceneCamera: {
  read: readSceneCameraEvidence,
  ready: () => !!player?.current && !!comments && !persistence?.restoring() && el('rig-empty').hidden,
  comment: summary => {
    const row = session?.feedback.find(row => row.summary === summary);
    return row ? {id: row.id, comment: row.context.comment} : null;
  },
  armWrap: () => { observedSceneCameraWrap = null; watchSceneCameraWrap = true; },
  wrap: () => observedSceneCameraWrap,
}});
`;

const observations: Record<string, unknown>[] = [];
const errors: unknown[] = [];
let page: InputCdpSession | undefined;
let operation = 'prepare inputs';

function json(path: string, value: unknown) {
  return writeFile(join(out, path), JSON.stringify(value, null, 2) + '\n');
}

async function wait(page: InputCdpSession, expression: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.evaluate<boolean>(expression)) return;
    await Bun.sleep(40);
  }
  throw new Error(`SCENE_CAMERA_BROWSER_WAIT: ${expression}`);
}

const reading = (page: InputCdpSession) => page.evaluate<Reading>(`${key}.read()`);
const settle = (page: InputCdpSession) => page.evaluate('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');

async function scrub(page: InputCdpSession, seconds: number) {
  await page.evaluate(`(() => {
    const input = document.getElementById('scrub');
    input.value = ${JSON.stringify(String(seconds))};
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await settle(page);
  const state = await reading(page);
  assert.equal(state.playing, false);
  near(state.time, seconds, 1e-10, 'authored transport time');
  return state;
}

async function choose(page: InputCdpSession, animation: string) {
  await page.evaluate(`(() => {
    const input = document.getElementById('animation-select');
    input.value = ${JSON.stringify(animation)};
    if (input.value !== ${JSON.stringify(animation)}) throw new Error('Animation option missing');
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await settle(page);
}

function outputPoint(stage: Stage, sample: Sample, x: number, y: number): Point {
  const [left, top] = sample.view;
  return {x: (x - stage.x - left) * sample.zoom, y: (stage.y + stage.height - y - top) * sample.zoom};
}

function checkGeometry(state: Reading, stage: Stage, sample: Sample, label: string) {
  assert.ok(state.phase && state.canvas, label + ' authored draw');
  near(state.phase.authored, sample.authored_time, 1e-9, label + ' held authored phase');
  near(state.phase.compiled, sample.compiled_time, 1e-9, label + ' held compiled phase');
  near(state.compiled ?? NaN, sample.compiled_time, 1e-8, label + ' pose phase');
  near(state.phase.zoom, sample.zoom, 1e-6, label + ' zoom');
  const [left, top, right, bottom] = sample.view;
  const expectedView: Rect = {x: stage.x + left, y: stage.y + stage.height - bottom,
    width: right - left, height: bottom - top};
  for (const axis of ['x', 'y', 'width', 'height'] as const)
    near(state.phase.view[axis], expectedView[axis], .001, label + ' camera window ' + axis);
  near(state.canvas.width / state.canvas.height, stage.width / stage.height, .001, label + ' authored output aspect');
  const project = ({points}: Reading['slots'][number]) => Array.from({length: points.length / 2}, (_, i) =>
    outputPoint(stage, sample, points[2 * i]!, points[2 * i + 1]!));
  const actor = state.slots.filter(row => row.slot.startsWith('actor:')).flatMap(project);
  assert.ok(actor.length > 0, label + ' figure');
  const xs = actor.map(point => point.x), ys = actor.map(point => point.y);
  const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const expected = sample.figures.find(item => item.id === 'actor')?.bounds;
  assert.ok(expected);
  bounds.forEach((value, i) => near(value, expected[i]!, .001, label + ' projected actor bounds'));
  const backdrop = state.slots.find(row => row.slot === 'backdrop');
  assert.ok(backdrop);
  const projected = project(backdrop);
  assert.equal(projected.length, 4);
  for (const [x, y] of sample.backdrop_quad) {
    const target = [(x - sample.view[0]) * sample.zoom, (y - sample.view[1]) * sample.zoom];
    near(Math.min(...projected.map(point => Math.hypot(point.x - target[0]!, point.y - target[1]!))), 0, .001,
      label + ' projected moving backdrop vertex');
  }
  return {bounds, backdrop: projected};
}

async function gesture(page: InputCdpSession, a: Point, b = a) {
  await page.mouse('mouseMoved', a.x, a.y);
  await page.mouse('mousePressed', a.x, a.y);
  if (a !== b) await page.mouse('mouseMoved', b.x, b.y);
  await page.mouse('mouseReleased', b.x, b.y);
  await settle(page);
}

function cropReference(screenshot: PNG, pane: Rect, mark: StageComment, crop: PNG) {
  // DPR 1 and a point give the existing 24 CSS px context on each side. Omit the mark's painted outline.
  const x = Math.ceil(pane.x + Math.max(0, Math.floor(mark.screen.x - 24)));
  const y = Math.ceil(pane.y + Math.max(0, Math.floor(mark.screen.y - 24)));
  const reference = displayPixels(screenshot, {x, y, width: crop.width, height: crop.height}, crop.width, crop.height);
  const point = {x: pane.x + mark.screen.x - x, y: pane.y + mark.screen.y - y};
  // Mask only the known local annotation. This excludes the label stroke from both rasters.
  for (let py = 0; py < crop.height; py++) for (let px = 0; px < crop.width; px++) {
    if (Math.abs(px - point.x) > 7 || Math.abs(py - point.y) > 7) continue;
    const offset = (py * crop.width + px) * 4;
    crop.data.copy(reference.data, offset, offset, offset + 4);
  }
  return reference;
}

async function checkComment(page: InputCdpSession, language: 'en' | 'ko', stage: Stage, sample: Sample,
  sourceHash: string, origin: string, stateDir: string) {
  await scrub(page, sample.authored_time);
  // Leave visible margins on all sides for the outside-clip gesture after zoom and pan.
  await click(page, '#zoom-out');
  await click(page, '#zoom-out');
  const original = await reading(page);
  assert.ok(original.canvas);
  await click(page, '#zoom-in');
  const zoomed = await reading(page);
  assert.ok(zoomed.canvas && zoomed.canvas.width > original.canvas.width);
  const middle = {x: zoomed.pane.x + zoomed.pane.width / 2, y: zoomed.pane.y + zoomed.pane.height / 2};
  const space = (type: 'keydown' | 'keyup') => page.evaluate(
    `document.dispatchEvent(new KeyboardEvent('${type}', {code:'Space', bubbles:true}))`);
  await space('keydown');
  try {await gesture(page, middle, {x: middle.x + 23, y: middle.y + 11});}
  finally {await space('keyup');}
  const panned = await reading(page);
  assert.ok(panned.canvas);
  near(panned.canvas.x - zoomed.canvas.x, 23, .6, 'inspection pan x');
  near(panned.canvas.y - zoomed.canvas.y, 11, .6, 'inspection pan y');
  await click(page, '#stage-comment');
  await settle(page);
  const captured = await reading(page);
  const box = captured.canvas;
  assert.ok(box);
  const point = {x: Math.round(box.x + box.width * .5), y: Math.round(box.y + box.height * .5)};
  const screenshot = await page.screenshot();
  await writeFile(join(out, `${language}-pin-before.png`), screenshot);
  const margin = {x: Math.round(box.x - 8), y: point.y};
  assert.ok(margin.x > captured.pane.x + 1, 'left authored clip margin must be inside the pane');
  await gesture(page, margin);
  assert.equal(await page.evaluate<boolean>("!!document.querySelector('.stage-comment-composer')"), false,
    'outside the authored output must refuse capture');

  await gesture(page, point);
  await wait(page, "!!document.querySelector('.stage-comment-composer input')");
  const summary = language === 'ko' ? '공개 예제 카메라 핀' : 'Public example camera pin';
  await page.evaluate(`(() => {
    const form = document.querySelector('.stage-comment-composer');
    form.querySelector('input').value = ${JSON.stringify(summary)};
    form.requestSubmit();
  })()`);
  const find = `${key}.comment(${JSON.stringify(summary)})`;
  await wait(page, `!!${find} && !document.querySelector('.stage-comment-composer')`);
  const saved = await page.evaluate<SavedMark>(find);
  await json(`${language}-pin.json`, saved);
  const mark = parseStageComment(saved.comment);
  assert.deepEqual([mark.viewport, mark.animation, mark.frame, mark.sourceHash, mark.modelHash, mark.camera.space],
    ['rig', 'idle', null, sourceHash, captured.modelHash, 'world']);
  assert.ok(mark.timeBasis, 'camera coverage cannot supply a producer frame index');
  near(mark.time, sample.authored_time, 1e-9, 'comment held time');
  near(mark.screen.x, point.x - captured.pane.x, .6, 'comment pane x');
  near(mark.screen.y, point.y - captured.pane.y, .6, 'comment pane y');
  const unproject = (pixel: Point): Point => ({
    x: stage.x + sample.view[0] + (pixel.x - box.x) * stage.width / box.width / sample.zoom,
    y: stage.y + stage.height - sample.view[1] - (pixel.y - box.y) * stage.height / box.height / sample.zoom,
  });
  const world = unproject(point);
  const camera = mark.camera;
  near(mark.world.x, world.x, .2, 'saved world x');
  near(mark.world.y, world.y, .2, 'saved world y');
  const center = unproject({x: captured.pane.x + captured.pane.width / 2, y: captured.pane.y + captured.pane.height / 2});
  near(camera.center.x, center.x, .2, 'pane centre world x');
  near(camera.center.y, center.y, .2, 'pane centre world y');
  near(camera.visible.width / camera.visible.height, camera.viewport.width / camera.viewport.height, 1e-8, 'whole pane aspect');
  near(camera.viewport.width / camera.visible.width, box.width / stage.width * sample.zoom, .002, 'composed scale');
  const bookmark = parseBookmark(mark.bookmark);
  const inspection = bookmark.view.cameras.rig;
  assert.ok(inspection);
  near(camera.zoom, inspection.zoom, 1e-8, 'stored inspection zoom');
  assert.ok(mark.slots.some(row => row.slot === 'backdrop') && mark.slots.some(row => row.slot.startsWith('actor:')));
  const bytes = validateCommentCrop(mark);
  await writeFile(join(out, `${language}-crop.png`), bytes);
  const crop = PNG.sync.read(bytes);
  assert.ok(crop.width >= 46 && crop.height >= 46, 'native point crop with context');
  const reference = cropReference(PNG.sync.read(screenshot), captured.pane, mark, crop);
  await writeFile(join(out, `${language}-crop-screen.png`), PNG.sync.write(reference));
  const {difference, ...comparison} = compareSceneCameraPixels(crop, reference);
  await writeFile(join(out, `${language}-crop-diff.png`), PNG.sync.write(difference));
  observations.push({language, mark: saved.id, original, zoomed, panned, captured, comparison});
  assert.ok(comparison.stable >= 100 && comparison.matching / comparison.stable >= .98,
    'stored crop must match the held compositor away from antialiasing and the annotation');

  await wait(page, "!document.getElementById('request-changes').disabled");
  await click(page, '#request-changes');
  await wait(page, `fetch('/api/session').then(r => r.json()).then(s => s.feedback.some(row => row.id === ${JSON.stringify(saved.id)}))`);
  const response = await fetch(origin + '/api/session');
  assert.equal(response.status, 200);
  const persisted = await response.json() as ReviewSession;
  assert.equal(persisted.status, 'changes-requested');
  const row = persisted.feedback.find(entry => entry.id === saved.id);
  assert.ok(row);
  const persistedMark = parseStageComment((row.context as {comment?: unknown} | undefined)?.comment);
  assert.deepEqual(persistedMark, mark, 'the local session preserves the pin and stored evidence');
  assert.deepEqual(await readFile(resolvedCropPath(mark.crop.path, stateDir)), bytes, 'stored PNG matches the captured bytes');

  await scrub(page, 2);
  await click(page, '#fit');
  const selector = `[data-comment-id="${saved.id}"] .stage-comment-summary`;
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await wait(page, `!!document.querySelector('.stage-comment-composer') &&
    [...document.querySelectorAll('.stage-comment-pin')].some(node => node.title === ${JSON.stringify(summary)})`);
  await settle(page);
  const replayed = await reading(page);
  assert.ok(replayed.canvas);
  near(replayed.phase?.authored ?? NaN, sample.authored_time, 1e-9, 'pin replay phase');
  for (const axis of ['x', 'y', 'width', 'height'] as const) near(replayed.canvas[axis], box[axis], .6, 'pin replay canvas ' + axis);
  const pin = await page.evaluate<Point>(`(() => {
    const node = Array.from(document.querySelectorAll('.stage-comment-pin')).find(n => n.title === ${JSON.stringify(summary)});
    const rect = node.getBoundingClientRect();
    return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  })()`);
  near(pin.x, point.x, .75, 'repainted pin x');
  near(pin.y, point.y, .75, 'repainted pin y');
  await writeFile(join(out, `${language}-pin-replay.png`), await page.screenshot());
}

try {
  const input = await readSceneCameraInputs(fixture, producerPngs);
  const bundle = await Bun.build({entrypoints: ['web/main.ts'], target: 'browser', format: 'esm',
    conditions: playBuildConditions(), plugins: [{name: 'scene-camera-observation', setup(build) {
      build.onLoad({filter: /web[/\\]main\.ts$/}, async ({path}) => ({
        loader: 'ts', contents: instrumentRigMount(await readFile(path, 'utf8'), probe),
      }));
    }}],
  });
  assert.ok(bundle.success && bundle.outputs[0], bundle.logs.map(log => log.message).join('\n'));
  await json('provenance.json', {fixture: input.hashes, producer: input.receipt,
    reviewBundleSha256: sha256(new Uint8Array(await bundle.outputs[0].arrayBuffer())),
    playEntry: Bun.resolveSync('@rig-c/play/composed-take', process.cwd())});
  for (const {row, png} of input.frames) await writeFile(join(out, 'parts-' + row.path), png);
  const stage = input.packed.stage;
  const roots = {direction: join(scratch, 'direction'), rig: join(scratch, 'rig'), legacy: join(scratch, 'legacy')};
  for (const kind of ['direction', 'rig', 'legacy'] as const) await writeSceneCameraPackage(roots[kind], fixture, kind);

  page = await launchCdpSession(join(scratch, 'profile'), {sendDeadlineMs: 30000, browserArgs: ['--renderer-process-limit=2'],
    onEvent(event) {if (event.method === 'Runtime.exceptionThrown') errors.push(event.params);},
  });
  await page.setViewport(1600, 1040);
  for (const language of ['en', 'ko'] as const) {
    let untracked: PNG | undefined;
    for (const kind of ['direction', 'rig', 'legacy'] as const) {
      operation = `${language} ${kind} open`;
      const pkg = await loadReview(roots[kind]);
      const stateDir = join(scratch, 'state-' + language + '-' + kind);
      const context = await createReviewRequestContext(pkg, {port: 0, bundle: bundle.outputs[0],
        stateDir, initialAnimation: kind === 'direction' ? 'idle' : 'shot'});
      const server = Bun.serve({hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
        async fetch(request, listener) {return (await context.handle(request, listener.port, listener))!;},
      });
      try {
        const origin = `http://127.0.0.1:${server.port}`;
        await page.goto(`${origin}/?lang=${language}`, language);
        await wait(page, `${key}?.ready()`);
        assert.equal((await reading(page)).modelHash, input.camera.model_sha256);
        await page.evaluate("document.querySelector('[data-mode=playback]').click()");
        await wait(page, "!document.getElementById('scrub').disabled");
        await click(page, '#fit');
        if (kind === 'direction') {
          for (const {row, sample, pixels} of input.frames) {
            operation = `${language} Parts raster ${row.path}`;
            const state = await scrub(page, sample.authored_time);
            assert.deepEqual([state.animation, state.language, state.dpr], ['idle', language, 1]);
            const geometry = checkGeometry(state, stage, sample, operation);
            const screenshot = await page.screenshot();
            await writeFile(join(out, `${language}-review-${row.path}`), screenshot);
            const actual = displayPixels(PNG.sync.read(screenshot), state.canvas!, stage.width, stage.height);
            const {difference, ...comparison} = compareSceneCameraPixels(actual, pixels);
            await writeFile(join(out, `${language}-output-${row.path}`), PNG.sync.write(actual));
            await writeFile(join(out, `${language}-diff-${row.path}`), PNG.sync.write(difference));
            observations.push({operation, sourceHash: pkg.sourceHash, state, geometry, comparison});
            assert.ok(comparison.stable > 1000 && comparison.matching / comparison.stable >= .98, operation);
          }
          const idle = input.offGrid.tracks.idle.samples;
          for (const label of ['named-open-between-rows', 'step-hold', 'step-jump', 'before-seam', 'unwrapped-end']) {
            operation = `${language} idle ${label}`;
            const sample = idle[label]!;
            const state = await scrub(page, sample.authored_time);
            observations.push({operation, state, geometry: checkGeometry(state, stage, sample, operation)});
          }
          operation = `${language} live loop seam`;
          await scrub(page, 3.9);
          await page.evaluate(`${key}.armWrap()`);
          await click(page, '#play');
          await wait(page, `!!${key}.wrap()`);
          await click(page, '#play');
          const wrap = await page.evaluate<Wrap>(`${key}.wrap()`);
          observations.push({operation, wrap});
          assert.ok(wrap.before.phase && wrap.after.phase && wrap.before.trackTime !== null && wrap.after.trackTime !== null);
          assert.ok(wrap.before.phase.authored > 3.8 && wrap.after.phase.authored < .2);
          assert.ok(wrap.after.trackTime > wrap.before.trackTime, 'live repeat keeps the unwrapped compiled transport');
          operation = `${language} pin/crop/replay`;
          await checkComment(page, language, stage, input.frames[1]!.sample, pkg.sourceHash, origin, stateDir);
        } else {
          if (kind === 'rig') {
            for (const label of ['moving-model-key', 'named-open-between-rows', 'unwrapped-end']) {
              operation = `${language} shot ${label}`;
              const sample = input.offGrid.tracks.shot.samples[label]!;
              const state = await scrub(page, sample.authored_time);
              assert.deepEqual([state.animation, state.duration], ['shot', input.camera.tracks.shot.duration]);
              observations.push({operation, state, geometry: checkGeometry(state, stage, sample, operation)});
              assert.ok(Math.abs((state.phase?.compiled ?? NaN) - state.time) > 1e-8, 'compiled clock must differ');
            }
          }
          operation = `${language} ${kind} untracked clip`;
          await choose(page, 'actor:body_turn');
          const state = await scrub(page, .5);
          assert.equal(state.animation, 'actor:body_turn');
          assert.equal(state.phase, null);
          await click(page, '#fit');
          await settle(page);
          const screenshot = await page.screenshot();
          await writeFile(join(out, `${language}-${kind}-untracked.png`), screenshot);
          const pane = (await reading(page)).pane;
          const capture = displayPixels(PNG.sync.read(screenshot), pane, Math.round(pane.width), Math.round(pane.height));
          if (kind === 'rig') untracked = capture;
          else {
            assert.ok(untracked);
            assert.deepEqual([capture.width, capture.height], [untracked.width, untracked.height]);
            assert.ok(capture.data.equals(untracked.data), 'untracked take must paint the model-only view');
          }
          observations.push({operation, sourceHash: pkg.sourceHash, state});
        }
      } finally {
        context.stop();
        server.stop(true);
      }
      await json('report.json', {observations, errors});
    }
  }
  assert.deepEqual(errors, []);
  console.log('SCENE_CAMERA_BROWSER_PASS', JSON.stringify({languages: 2, producerRasters: input.frames.length * 2, observations: observations.length}));
} catch (error) {
  await json('failure.json', {operation, error: String(error), observations, errors,
    body: await page?.evaluate('document.body.innerText').catch(() => null)});
  const screenshot = await page?.screenshot().catch(() => null);
  if (screenshot) await writeFile(join(out, 'failure.png'), screenshot);
  throw error;
} finally {
  try {await page?.close();}
  finally {await rm(scratch, {recursive: true, force: true});}
}
