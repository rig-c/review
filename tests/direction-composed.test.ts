/** #933: rig-create/direction@3, a composed take played as the model's own idle. Public synthetic fixtures only. */
import {afterAll, expect, test} from 'bun:test';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RigPlayer} from '@rig-c/play';
import {readDirectionInspection, type DirectionInspection} from '../src/direction-inspection.ts';
import {loadReview} from '../src/manifest.ts';
import {advancePlayback, cueDue} from '../web/playback-clock.ts';
import * as scene from '../web/scene-plates.ts';
import {idleAvailable} from '../web/view-controls.ts';
import {bindDirectionPanel, directionRows, directionSummary, type DirectionView} from '../web/direction-panel.ts';
import {setLanguagePreference, t} from '../web/i18n.ts';
import {loadSetupAssets, setupRoot} from './helpers/setup-mesh.ts';
import {directionPhysicsModel} from './helpers/direction-playback.ts';

const fixture = 'tests/fixtures/direction-inspection';
const modelPath = 'derived/review/v1/out/check/build/skeleton.model.json';
const modelSha = '63190ec6746bafbc73847fa6c6905b5811cc0adb41897dfed923fe802e4dc261';
const file = {path: 'evidence/direction/v2.json', sha256: 'c'.repeat(64)};
const model = {path: modelPath, sha256: modelSha};
/** The contract's closed @3 shape; compose, acceptance and citations are Create's and are not read here. */
const composedDoc = (take = {duration: 4, loop: true}) => ({
  schema: 'rig-create/direction@3',
  rig: {version: 1, acceptance: {signoff: {}, verdict: {}, review_package: {}}},
  compose: {scene: {path: 'evidence/compose-src/v2/scene.json', sha256: 'd'.repeat(64)}, out: 'outputs/v2/compose'},
  model,
  take,
  citations: {camera: 'quoted', timing: 'quoted', composition: 'quoted'},
});
const temps: string[] = [];
afterAll(async () => { for (const dir of temps) await rm(dir, {recursive: true, force: true}); });

test('#933 reads direction@3 from the top-level model and its take only', () => {
  const inspected = readDirectionInspection(composedDoc(), file, model);
  expect(inspected).toEqual({file, model, rigVersion: 1, composed: true,
    camera: {space: 'rig-world-y-up', keys: []}, take: {duration: 4, loop: true}, timing: []});
  expect(inspected.scene).toBeUndefined();
  // @3 never reads rig.model, camera, timing or scene, even when a stray one is present.
  const stray = {...composedDoc(), rig: {version: 1, model: {path: 'other.model.json', sha256: '0'.repeat(64)}},
    camera: {space: 'other'}, timing: {keys: []}, scene: {n: 1, path: 'evidence/scene/s1.json', sha256: 'e'.repeat(64)}};
  expect(readDirectionInspection(stray, file, model)).toEqual(inspected);
  expect(() => readDirectionInspection({...composedDoc(), take: {duration: 0, loop: true}}, file, model)).toThrow('DIRECTION_SCHEMA');
  expect(() => readDirectionInspection({...composedDoc(), take: {duration: 4}}, file, model)).toThrow('DIRECTION_SCHEMA');
});

test('#933 refuses an @3 model that is not the inspected model, by name', () => {
  const doc = composedDoc();
  for (const inspected of [null, {...model, sha256: '0'.repeat(64)}, {...model, path: 'other.model.json'}])
    expect(() => readDirectionInspection(doc, file, inspected)).toThrow('DIRECTION_MODEL_MISMATCH');
  // An @3 document carrying only the @1/@2 rig.model binding is not an @3 document.
  const {model: _, ...legacy} = doc;
  expect(() => readDirectionInspection({...legacy, rig: {version: 1, model}}, file, model)).toThrow('DIRECTION_SCHEMA');
});

async function composedPackage(manifest?: (value: Record<string, unknown>) => void) {
  const root = await mkdtemp(join(tmpdir(), 'review-direction-at3-'));
  temps.push(root);
  await cp(fixture, root, {recursive: true});
  await writeFile(join(root, file.path), JSON.stringify(composedDoc(), null, 2));
  if (manifest) {
    const value = JSON.parse(await readFile(join(root, 'review.json'), 'utf8'));
    manifest(value);
    await writeFile(join(root, 'review.json'), JSON.stringify(value, null, 2));
  }
  return root;
}

test('#933 an @3 post without plates opens without reaching the scene reader', async () => {
  const pkg = await loadReview(await composedPackage());
  expect(pkg.scene).toBeUndefined();
  expect(pkg.direction?.composed).toBe(true);
  expect(pkg.direction?.model).toEqual(model);
  expect(pkg.direction?.take).toEqual({duration: 4, loop: true});
  // A scene declared beside an @3 document is refused at the binding, before any scene bytes are parsed.
  const declared = await composedPackage(value => { value.scene = 'evidence/direction/scene.json'; });
  await writeFile(join(declared, 'evidence/direction/scene.json'), 'not json: the scene reader would refuse this differently');
  await expect(loadReview(declared)).rejects.toThrow('SCENE_SOURCE_MISMATCH: evidence/direction/scene.json');
});

// Execute the actual workspace transport, with main.ts's own activeScene and canRepeatIdle for an @3 post.
const main = await readFile(new URL('../web/main.ts', import.meta.url), 'utf8');
const transpiler = new Bun.Transpiler({loader: 'ts'});
function workspace(player: RigPlayer, direction: DirectionInspection, duration: number) {
  const pick = (from: string, to: string) => main.slice(main.indexOf(from), main.indexOf(to));
  const source = [pick('const activeScene=', '\nconst sceneBox='), pick('function tickPlaying(', '\nfunction configureTurnPad('),
    pick('function canRepeatIdle()', '\nfunction renderIdle(')].join('\n');
  const noop = () => {};
  const scope = {...scene, advancePlayback, cueDue, idleAvailable, player, time: 0, duration, playbackCarry: 0, lastFrame: 1000, idleHeld: false,
    video: null, sceneComposite: undefined, stageSource: null, inspectedModel: null, data: {direction}, assets: {animations: [{name: 'idle'}]},
    animation: 'idle', axisInspection: null, stopAudio: noop, clipMoved: noop, stepEnvironment: noop, drawRig: (action: () => void) => action(),
    input: (id: string) => ({checked: id === 'idle-repeat'}), renderSequenceFrame: noop, renderTransport: noop, pause: noop,
    message: (value: string) => { throw Error(value); }, errorText: String, activeCues: () => []};
  const run = new Function('scope', `with(scope){${transpiler.transformSync(source)};return {tickPlaying,activeScene,canRepeatIdle};}`)(scope);
  return {...run, state: scope} as {tickPlaying(now: number): void; activeScene(): unknown; canRepeatIdle(): boolean; state: typeof scope};
}
const vertices = (player: RigPlayer) => {
  const mesh = player.posedFrame().order[0]!;
  if (mesh.kind !== 'mesh') throw Error('Expected fixture mesh');
  return [...mesh.vertices];
};
const jumps = (a: number[], b: number[]) => a.filter((_, i) => i % 2 === 0).map((_, v) => Math.hypot(a[v * 2]! - b[v * 2]!, a[v * 2 + 1]! - b[v * 2 + 1]!));

test('#933 direction@3 plays idle looping at the model stage and carries physics across the loop seam', async () => {
  const doc = await directionPhysicsModel();
  doc.animations[0].name = 'idle';
  doc.editorOrder.animations = ['idle'];
  const clip = doc.animations[0].duration as number;
  const direction = readDirectionInspection({...composedDoc({duration: clip, loop: true}), model: {path: 'skeleton.model.json', sha256: 'b'.repeat(64)}},
    file, {path: 'skeleton.model.json', sha256: 'b'.repeat(64)});
  const loaded = await loadSetupAssets(doc);
  try {
    const player = new RigPlayer(setupRoot(), loaded.assets, {mode: 'canvas'});
    try {
      const rig = workspace(player, direction, clip);
      // No scene composite: the take never enters the scene path (takeSample/advanceTake), and repeat is the ordinary idle repeat.
      expect(rig.activeScene()).toBeUndefined();
      expect(rig.canRepeatIdle()).toBe(true);
      player.play('idle', {loop: true});
      const advanced: number[] = [], seeks: number[] = [];
      const advance = player.advance.bind(player), seek = player.seek.bind(player);
      player.advance = step => { advanced.push(step); advance(step); };
      player.seek = value => { seeks.push(value); seek(value); };
      let previous = vertices(player), inside = 0;
      const wraps: number[][] = [];
      for (let frame = 1; wraps.length < 2 && frame <= 1000; frame++) {
        const before = rig.state.time;
        rig.tickPlaying(1000 + frame * 1000 / 60);
        const now = vertices(player), delta = jumps(now, previous);
        if (rig.state.time < before) wraps.push(delta); else inside = Math.max(inside, ...delta);
        previous = now;
      }
      console.log('DIRECTION_AT3_LOOP_VERTICES', JSON.stringify({inside, wraps, seeks: seeks.length, advances: advanced.length}));
      expect(wraps.length).toBe(2);
      expect(inside).toBeGreaterThan(0);
      // The #930 bound: a seam fits the largest ordinary single-frame vertex move in this same trajectory.
      for (const seam of wraps) for (const jump of seam) expect(jump).toBeLessThanOrEqual(inside + 1e-9);
      expect(seeks).toEqual([]);
      expect(player.entry(0)!.animation).toBe('idle');
    } finally { player.dispose(); }
  } finally { loaded.dispose(); }
});

/** Just enough DOM for the panel's own refresh, so the rows it actually builds are read. */
class Node {
  children: Node[] = []; textContent = ''; hidden = false; open = false; id = ''; value = ''; attributes: Record<string, string> = {};
  onchange: (() => void) | null = null;
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.children = nodes; }
  before(..._: Node[]) {}
  remove() {}
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  find(id: string): Node | undefined { return this.id === id ? this : this.children.map(child => child.find(id)).find(Boolean); }
  all(tag: string): Node[] { return [...(this.tag === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))]; }
}

test('#933 the @3 panel shows the short title and only the remaining rows, in EN and KO', async () => {
  const pkg = await loadReview(await composedPackage());
  const joined = {postVersion: 3, projectHash: 'p'.repeat(64), packageSourceHash: 's'.repeat(64), packageRoot: 'outputs/v3/compose', projectModel: model};
  const view: DirectionView = {model: {...model, inspected: true}, revision: pkg.manifest.revision, sourceHash: pkg.sourceHash,
    runtime: pkg.reviewedSource.runtimeVersion, dials: pkg.feedbackCatalog.turnDials!, sets: [], authored: {...pkg.direction!, joined, take: {duration: 8, loop: true}}};
  expect(directionRows(view).map(row => row.key)).toEqual(['direction.inspected', 'direction.package', 'direction.turn',
    'direction.depthUnavailable', 'direction.setsUnavailable', 'direction.authored', 'direction.joined']);
  // Hidden for @3 even with a scratch model on stage, where @1/@2 still list both camera rows.
  expect(directionRows({...view, model: {...model, inspected: false}}).map(row => row.key)).not.toContain('direction.runtimeCameraUnavailable');
  const created: Node[] = [];
  const previous = (globalThis as {document?: unknown}).document;
  (globalThis as {document?: unknown}).document = {createElement: (tag: string) => { const node = new Node(tag); created.push(node); return node; }};
  try {
    const panel = bindDirectionPanel(new Node('div') as unknown as HTMLElement, () => view, () => {});
    const host = created.find(node => node.id === 'direction-panel')!;
    const expected = {
      en: {title: 'Direction v3 · 8 s · loop', hidden: ['Plain rig view', 'CAMERA_PLAYBACK_UNAVAILABLE', 'CAMERA_APPLY_UNSUPPORTED']},
      ko: {title: '연출 v3 · 8초 · 반복', hidden: ['인물만 표시', 'CAMERA_PLAYBACK_UNAVAILABLE', 'CAMERA_APPLY_UNSUPPORTED']},
    } as const;
    for (const language of ['en', 'ko'] as const) {
      setLanguagePreference(language);
      panel.show(true);
      const title = host.all('summary')[0]!.textContent;
      const rows = host.all('li').map(row => row.textContent);
      console.log('DIRECTION_AT3_PANEL', JSON.stringify({language, title, rows}));
      expect(title).toBe(expected[language].title);
      expect(rows).toEqual(directionRows(view).map(row => t(row.key, row.values, language)));
      expect(rows).toHaveLength(7);
      for (const text of expected[language].hidden) expect(rows.join('\n')).not.toContain(text);
      expect(rows.join('\n')).toContain(modelSha);
      expect(created.find(node => node.id === 'direction-authored-keys')!.hidden).toBe(true);
      expect(directionSummary(view, language)).toBe(expected[language].title);
    }
    panel.dispose();
  } finally {
    setLanguagePreference('en');
    (globalThis as {document?: unknown}).document = previous;
  }
});
