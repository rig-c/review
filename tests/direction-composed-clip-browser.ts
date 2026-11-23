/** Review #1145. Measure the displayed pixels of a synthetic direction@3 model. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {PNG} from 'pngjs';
import {buildWeb} from '../src/build.ts';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

type Stage = {x: number; y: number; width: number; height: number};
type Rect = {left: number; top: number; right: number; bottom: number};
type StageReadback = {
  pane: Rect;
  scale: number;
  devicePixelRatio: number;
  state: {
    modelHash: string | null;
    time: number;
    playing: boolean;
    animation: string;
  };
  actorLeft: number;
  edges: Rect;
};
const actor = 'actor';
const color = Buffer.from([239, 16, 191, 255]);
const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');
const duration = 4;
const actorWidth = 128;
// Create #905, example-composed-clip/inputs/scene.json: canvas_clip, 96×128, offset [-16, 0].
// Parts centers the stage at x=0. The actor's left is a further 16 units to the left.
const integerStage = {x: -48, y: 0, width: 96, height: 128};
const actorLeft = integerStage.x - 16;
// All four edges are 7/8 of a world unit inside the outward-rounded raster.
const fractionalStage = {x: -47.125, y: .875, width: 96.25, height: 128.25};
const fixtures = [
  {name: 'integer', stage: integerStage, fractional: false, composed: true},
  {name: 'fractional', stage: fractionalStage, fractional: true, composed: true},
  {name: 'ordinary-rig', stage: fractionalStage, fractional: true, composed: false},
] as const;

function syntheticModel(stage: Stage, fractional: boolean) {
  const height = fractional ? 144 : integerStage.height;
  const atlas = {width: actorWidth, height, offsetX: 0, offsetY: 0, originalWidth: actorWidth, originalHeight: height};
  const constraints = {ik: [], transform: [], path: [], physics: [], slider: []};
  return {
    spec: 'rigc-compiled/3', referenceScale: 100, stage,
    bones: [{name: 'root'}, {name: actor, parent: 'root', x: actorLeft + actorWidth / 2, y: integerStage.height / 2}],
    slots: [{name: actor, bone: actor, setup: actor}],
    skins: [{name: 'default', bones: [], constraints, attachments: {
      [actor]: {[actor]: {kind: 'region', path: actor, width: actorWidth, height, atlas}},
    }}],
    constraints: [], events: [],
    animations: [{name: 'idle', duration, bones: [{name: actor, timelines: [{name: 'translatex', keys: [
      {time: 0, value: 0}, {time: 2, value: 8}, {time: duration, value: 0},
    ]}]}], slots: [], constraints, attachments: [], drawOrder: [], events: []}],
    editorOrder: {skins: [{name: 'default', slots: [actor]}], animations: ['idle']},
    images: [], pageGrids: [], droppedStates: [], absentParts: [], meshBones: [], meshes: [],
    physics: [], deformTransforms: [], trackDerivations: [], rig: {},
    pages: [{name: 'actor.png', width: actorWidth, height, pma: false, scale: null,
      regions: [{name: actor, x: 0, y: 0, ...atlas, degrees: 0, index: 0}]}],
    spine: {sha256: sha256('Review #1145 synthetic model')},
  };
}

async function writePackage(root: string, fixture: typeof fixtures[number]) {
  await mkdir(root);
  const doc = syntheticModel(fixture.stage, fixture.fractional);
  const image = new PNG({width: doc.pages[0]!.width, height: doc.pages[0]!.height});
  image.data.fill(color);
  const bytes = JSON.stringify(doc);
  const model = {path: 'skeleton.model.json', sha256: sha256(bytes)};
  await writeFile(join(root, 'actor.png'), PNG.sync.write(image));
  await writeFile(join(root, model.path), bytes);
  if (fixture.composed) {
    await writeFile(join(root, 'direction.json'), JSON.stringify({
      schema: 'rig-create/direction@3', rig: {version: 1, acceptance: {signoff: {}, verdict: {}, review_package: {}}},
      compose: {out: 'outputs/v1/compose'}, model, take: {duration, loop: true},
      citations: {camera: 'synthetic', timing: 'synthetic', composition: 'synthetic'},
    }));
  }
  await writeFile(join(root, 'review.json'), JSON.stringify({
    schema: 'rig-review/1', id: fixture.name, title: 'Synthetic clip regression', revision: '1', model: model.path,
    animations: [{id: 'idle', label: 'Idle'}],
    checkpoints: [{id: 'hold', title: 'Hold the first frame', animation: 'idle', time: 0}],
    ...(fixture.composed ? {direction: 'direction.json'} : {}),
  }));
  const loaded = await loadReview(root);
  assert.equal(loaded.direction?.composed ?? false, fixture.composed);
  assert.equal(loaded.scene, undefined);
  return {loaded, model};
}

// Serialized into Chromium. Project authored world coordinates using the displayed DOM transform.
async function readStage(stage: Stage, slot: string): Promise<StageReadback> {
  await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  const editor = (window as unknown as {rigReviewEditor: {
    stage(): StageReadback['state'];
    posed(slot: string): {corners: number[]};
  }}).rigReviewEditor;
  const root = document.getElementById('rig-root')!;
  const pane = document.getElementById('rig-viewport')!.getBoundingClientRect().toJSON() as Rect;
  const {left, top} = root.getBoundingClientRect();
  const scale = new DOMMatrixReadOnly(getComputedStyle(root).transform).a;
  return {
    pane, scale, devicePixelRatio, state: editor.stage(), actorLeft: Math.min(...editor.posed(slot).corners.filter((_, i) => i % 2 === 0)),
    edges: {
      left: left + stage.x * scale, right: left + (stage.x + stage.width) * scale,
      top: top - (stage.y + stage.height) * scale, bottom: top - stage.y * scale,
    },
  };
}

const edges = ['left', 'right', 'top', 'bottom'] as const;
function countPixels(png: PNG, sample: StageReadback, edge: typeof edges[number], min: number, max: number) {
  const vertical = edge === 'left' || edge === 'right';
  const dpr = sample.devicePixelRatio;
  const boundary = sample.edges[edge] * dpr;
  const middle = (vertical ? sample.edges.top + sample.edges.bottom : sample.edges.left + sample.edges.right) * dpr / 2;
  const sign = edge === 'left' || edge === 'top' ? -1 : 1;
  const start = boundary + sign * min, end = boundary + sign * max;
  let candidates = 0, colored = 0;
  for (let along = Math.floor(Math.min(start, end)); along <= Math.ceil(Math.max(start, end)); along++) {
    const distance = (along + .5 - boundary) * sign;
    if (distance < min || distance > max) continue;
    for (let across = Math.floor(middle) - 12; across < Math.floor(middle) + 12; across++) {
      const x = vertical ? along : across, y = vertical ? across : along;
      const {left, top, right, bottom} = sample.pane;
      if (x < 0 || y < 0 || x >= png.width || y >= png.height ||
          x / dpr <= left || x / dpr >= right || y / dpr <= top || y / dpr >= bottom) continue;
      candidates++;
      const pixel = (y * png.width + x) * 4;
      if (png.data[pixel]! > 210 && png.data[pixel + 1]! < 45 && png.data[pixel + 2]! > 155) colored++;
    }
  }
  return {candidates, colored};
}

function argument(flag: string): string | undefined {
  const index = Bun.argv.indexOf(flag);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

const output = resolve(argument('--out') ?? 'artifacts/direction-composed-clip-1145');
// Point --bundle at a frozen baseline JavaScript build to plant without touching the shared source.
const suppliedBundle = argument('--bundle');
await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(output, 'scratch-'));
let page: InputCdpSession | undefined;
const errors: unknown[] = [];
const observations: unknown[] = [];
const failures: string[] = [];
let bundleHash: string | undefined;
try {
  const bundle = suppliedBundle ? Bun.file(resolve(suppliedBundle)) : await buildWeb();
  bundleHash = sha256(new Uint8Array(await bundle.arrayBuffer()));
  page = await launchCdpSession(join(scratch, 'profile'), {sendDeadlineMs: 30000, onEvent(event) {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params);
  }});
  let fractionalHash: string | undefined;
  for (const fixture of fixtures) {
    // Keep 1:1 within the camera's supported zoom range and give fractional probes more screen pixels.
    await page.setViewport(1600, fixture.fractional ? 1200 : 1100);
    const {loaded, model} = await writePackage(join(scratch, fixture.name), fixture);
    if (fixture.name === 'fractional') fractionalHash = model.sha256;
    if (fixture.name === 'ordinary-rig') assert.equal(model.sha256, fractionalHash, 'same model in the unclipped control');
    const context = await createReviewRequestContext(loaded, {
      port: 0, bundle, viewOnly: true, stateDir: join(scratch, 'state-' + fixture.name),
    });
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, websocket: context.live.websocket,
      async fetch(request, srv) {return (await context.handle(request, srv.port, srv))!;},
    });
    try {
      await page.goto(`http://127.0.0.1:${server.port}/?lang=en&checkpoint=hold`);
      const ready = `window.rigReviewEditor?.posed('${actor}')?.corners?.length === 8 && document.querySelector('#rig-empty')?.hidden === true`;
      const deadline = Date.now() + 15000;
      while (!await page.evaluate<boolean>(ready)) {
        if (Date.now() >= deadline) throw new Error('Rig did not draw: ' + await page.evaluate('document.body.innerText'));
        await Bun.sleep(50);
      }
      await page.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
      const visits = fixture.name === 'integer' ? [{zoom: 'fit', time: 0}, {zoom: 'native-one', time: 2}]
        : [{zoom: 'fit', time: 2}];
      for (const {zoom, time} of visits) {
        const name = `${fixture.name}-${zoom}`;
        await page.evaluate(`(() => {
          const scrub = document.querySelector('#scrub');
          scrub.value = '${time}';
          scrub.dispatchEvent(new Event('input', {bubbles: true}));
          document.getElementById('${zoom}').click();
        })()`);
        const sample: StageReadback = await page.evaluate<StageReadback>(`(${readStage})(${JSON.stringify(fixture.stage)}, '${actor}')`);
        const {modelHash, time: shownTime, animation, playing} = sample.state;
        assert.deepEqual({modelHash, time: shownTime, animation, playing}, {modelHash: model.sha256, time, animation: 'idle', playing: false}, name);
        const expectedActorLeft = actorLeft + (time === 2 ? 8 : 0);
        assert.ok(Math.abs(sample.actorLeft - expectedActorLeft) < .001,
          `${name} full posed actor: expected ${expectedActorLeft}, got ${sample.actorLeft}`);
        if (zoom === 'native-one') assert.ok(Math.abs(sample.scale - 1) < .001, name + ' native scale: ' + sample.scale);
        const screenshot = await page.screenshot();
        await writeFile(join(output, name + '.png'), screenshot);
        const png = PNG.sync.read(screenshot);
        const measured = (fixture.fractional ? edges : ['left', 'right'] as const).map(edge => {
          const inside = countPixels(png, sample, edge, -4, -1);
          // Sample within the rounded-only strip so a raster pinned without an exact clip still fails.
          const outside = countPixels(png, sample, edge, 1, fixture.fractional ? .875 * sample.scale * sample.devicePixelRatio - 1 : 5);
          assert.ok(inside.candidates > 0 && outside.candidates > 0, name + ' visible ' + edge + ' probe');
          if (inside.colored !== inside.candidates) failures.push(`${name} ${edge}: actor missing inside`);
          if (fixture.composed ? outside.colored !== 0 : outside.colored !== outside.candidates) {
            failures.push(`${name} ${edge}: ${outside.colored}/${outside.candidates} actor pixels outside`);
          }
          return {edge, inside, outside};
        });
        const observation = {name, stage: fixture.stage, sample, measured};
        observations.push(observation);
        console.log('DIRECTION_COMPOSED_CLIP', JSON.stringify(observation));
      }
    } finally {
      context.stop();
      server.stop(true);
    }
  }
  assert.deepEqual(errors, [], 'uncaught browser exceptions');
  assert.deepEqual(failures, [], 'DIRECTION_COMPOSED_STAGE_CLIP');
} catch (error) {
  await writeFile(join(output, 'failure.txt'), String(error) + '\n');
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({bundleHash, observations, failures, errors}, null, 2) + '\n');
  await page?.close();
  await rm(scratch, {recursive: true, force: true});
}
