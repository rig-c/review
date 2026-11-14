/** #496 positive post-fix probe. Original baseline RED receipts remain separate. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

export type ProbeLanguage = 'en' | 'ko';
export const positiveFrameNames = ['setup-display-ready', 'animate-display-ready', 'roundtrip-display-ready',
  'roundtrip-later-250', 'roundtrip-later-1000'] as const;
export const restorationRectToleranceCssPx = .001;

export function probeLanguage(value: string | undefined): ProbeLanguage {
  const language = value ?? 'en';
  assert(language === 'en' || language === 'ko', 'STAGE3_PROBE_LANGUAGE');
  return language;
}

export interface Point {x: number; y: number}
export interface Rect {left: number; top: number; right: number; bottom: number}
export interface FramingSample {
  language: string;
  stage: string | null;
  refused: string | null;
  mode: string | null;
  panelHidden: boolean;
  usableModes: string[];
  playDisabled: boolean;
  lifecycle: {documentComplete: boolean; commentsBound: boolean; restoring: boolean};
  draft: string;
  renderer: string;
  held: {modelHash: string | null; inspectedHash: string | null; animation: string; time: number; playing: boolean; busy: boolean};
  camera: {center: Point; zoom: number; viewport: {width: number; height: number}; visible: {x: number; y: number; width: number; height: number}} | null;
  cameraSync: boolean;
  activeCamera: string | null;
  pane: Rect;
  clip: Rect;
  root: {left: string; top: string; transform: string; scale: number; origin: Point; style: string | null};
  posed: {slot: string; kind: string; tint: number[]; corners?: number[]; vertices?: number[]; clip?: unknown}[];
  world: Point[];
  projected: Point[];
  inspectionProjected: Point[];
  drawables: {tag: string; rect: Rect; transform: string; width: number; height: number}[];
}

export function bounds(points: readonly Point[]): Rect {
  assert(points.length > 0, 'STAGE3_GEOMETRY_MISSING');
  assert(points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), 'STAGE3_GEOMETRY_NONFINITE');
  return {left: Math.min(...points.map(point => point.x)), top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)), bottom: Math.max(...points.map(point => point.y))};
}

/** Geometry uses the full held frame, including points clipped by ancestors. */
export function containment(sample: Pick<FramingSample, 'projected' | 'clip'>) {
  const projected = bounds(sample.projected), clip = sample.clip;
  assert(clip.right > clip.left && clip.bottom > clip.top, 'STAGE3_PANE_UNAVAILABLE');
  const overflow = {left: Math.max(0, clip.left - projected.left), top: Math.max(0, clip.top - projected.top),
    right: Math.max(0, projected.right - clip.right), bottom: Math.max(0, projected.bottom - clip.bottom)};
  return {status: Object.values(overflow).some(value => value > .5) ? 'STAGE3_FULL_RIG_OUTSIDE_PANE' : 'STAGE3_FULL_RIG_CONTAINED', projected, clip, overflow};
}

export function displayReady(sample: FramingSample): boolean {
  const camera = sample.camera;
  const catalog = sample.language === 'ko' ? koCatalog : enCatalog;
  return (sample.language === 'en' || sample.language === 'ko') && sample.stage === '3' && sample.refused === null && sample.panelHidden &&
    !sample.playDisabled && !sample.held.playing && !sample.held.busy && !!sample.held.modelHash &&
    sample.lifecycle.documentComplete && sample.lifecycle.commentsBound && !sample.lifecycle.restoring &&
    !!sample.renderer && !sample.renderer.startsWith(catalog['Not rendered']) && !sample.renderer.startsWith(catalog['Rendering failed']) &&
    !!camera && Number.isFinite(camera.center.x) && Number.isFinite(camera.center.y) &&
    camera.zoom > 0 && camera.viewport.width > 0 && camera.viewport.height > 0 && sample.root.scale > 0 &&
    sample.clip.right > sample.clip.left && sample.clip.bottom > sample.clip.top &&
    sample.world.length > 0 && sample.drawables.length > 0;
}

export function assertPositiveFrame(sample: FramingSample, language: ProbeLanguage): void {
  assert.equal(sample.language, language, 'STAGE3_DISPLAYED_LANGUAGE');
  assert(displayReady(sample), 'STAGE3_DISPLAY_NOT_READY');
  assert.equal(containment(sample).status, 'STAGE3_FULL_RIG_CONTAINED', 'STAGE3_POST_FIX_CONTAINMENT');
  assert.deepEqual(containment(sample).overflow, {left: 0, top: 0, right: 0, bottom: 0}, 'STAGE3_POST_FIX_ZERO_OVERFLOW');
}

/** Only browser client rectangles have layout tolerance. Source and camera state stay exact. */
export function assertRestoredDisplay(actual: FramingSample, expected: FramingSample): void {
  const {pane: actualPane, clip: actualClip, root: actualRoot, drawables: actualDrawables, ...actualState} = actual;
  const {pane: expectedPane, clip: expectedClip, root: expectedRoot, drawables: expectedDrawables, ...expectedState} = expected;
  assert.deepEqual(actualState, expectedState, 'STAGE3_RESTORATION_EXACT_STATE');
  const {origin: actualOrigin, ...actualRootState} = actualRoot;
  const {origin: expectedOrigin, ...expectedRootState} = expectedRoot;
  assert.deepEqual(actualRootState, expectedRootState, 'STAGE3_RESTORATION_EXACT_ROOT');
  assert.equal(actualDrawables.length, expectedDrawables.length, 'STAGE3_RESTORATION_DRAWABLE_COUNT');
  const rectangles = [{actual: actualPane, expected: expectedPane, name: 'pane'}, {actual: actualClip, expected: expectedClip, name: 'clip'}];
  for (const [index, drawable] of actualDrawables.entries()) {
    const {rect: actualRect, ...actualDrawable} = drawable;
    const {rect: expectedRect, ...expectedDrawable} = expectedDrawables[index]!;
    assert.deepEqual(actualDrawable, expectedDrawable, 'STAGE3_RESTORATION_EXACT_DRAWABLE');
    rectangles.push({actual: actualRect, expected: expectedRect, name: `drawables[${index}]`});
  }
  const coordinate = (actual: number, expected: number, name: string) => {
    assert(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= restorationRectToleranceCssPx,
      'STAGE3_RESTORATION_RECT ' + name);
  };
  for (const rectangle of rectangles) for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    coordinate(rectangle.actual[edge], rectangle.expected[edge], rectangle.name + '.' + edge);
  }
  coordinate(actualOrigin.x, expectedOrigin.x, 'root.origin.x');
  coordinate(actualOrigin.y, expectedOrigin.y, 'root.origin.y');
}

interface AtomicRestorationPlant {
  expected: FramingSample; actual: FramingSample; restored: FramingSample;
  mode: 'translate' | 'computed-position'; translateSupported: boolean;
  originalStyle: string | null; appliedStyle: string | null; restoredStyle: string | null;
  computedBefore: {translate: string; transform: string; left: string; top: string; position: string};
  computedAfter: AtomicRestorationPlant['computedBefore'];
}

/** Serialized into one browser evaluation. Restoration runs even if the measurement throws. */
export function atomicRestorationPlant(slotNames: string[], read: (slots: string[]) => FramingSample): AtomicRestorationPlant {
  const drawable = document.querySelector<HTMLElement>('#rig-root img,#rig-root canvas')!;
  const styles = () => {
    const css = getComputedStyle(drawable);
    return {translate: css.translate, transform: css.transform, left: css.left, top: css.top, position: css.position};
  };
  const originalStyle = drawable.getAttribute('style'), expected = read(slotNames), computedBefore = styles();
  const translateSupported = CSS.supports('translate', '1px 0');
  const mode = translateSupported ? 'translate' : 'computed-position';
  let actual!: FramingSample, appliedStyle: string | null = null, computedAfter!: AtomicRestorationPlant['computedBefore'];
  try {
    if (translateSupported) drawable.style.translate = '1px 0';
    else {
      const left = Number.parseFloat(computedBefore.left);
      if (!Number.isFinite(left)) throw new Error('MUTANT_RESTORATION_POSITION_UNAVAILABLE');
      drawable.style.left = `${left + 1}px`;
    }
    actual = read(slotNames);
    appliedStyle = drawable.getAttribute('style');
    computedAfter = styles();
  } finally {
    if (originalStyle === null) drawable.removeAttribute('style');
    else drawable.setAttribute('style', originalStyle);
  }
  return {expected, actual, restored: read(slotNames), mode, translateSupported, originalStyle, appliedStyle,
    restoredStyle: drawable.getAttribute('style'), computedBefore, computedAfter};
}

export function restorationRectDisplacement(expected: FramingSample, actual: FramingSample) {
  const deltas = actual.drawables.map((drawable, index) => {
    const before = expected.drawables[index]!.rect, after = drawable.rect;
    return {left: after.left - before.left, top: after.top - before.top, right: after.right - before.right, bottom: after.bottom - before.bottom};
  });
  return {deltas, maximumCssPx: Math.max(0, ...deltas.flatMap(delta => Object.values(delta)).map(Math.abs))};
}

export interface PreRigReadout {
  language: string; stage: string | null; refused: string | null; status: string; statusVisible: boolean;
  modeSwitch: {hidden: boolean; display: string; rects: number};
  controls: {disabled: boolean; title: string | null; pressed: string | null; rects: number}[];
}

const preRigRefusal = 'RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.';

export function assertPreRigRefusal(readout: PreRigReadout, language: ProbeLanguage): void {
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  assert.equal(readout.language, language, 'STAGE3_PRE_RIG_LANGUAGE');
  assert.equal(readout.stage, '3', 'STAGE3_PRE_RIG_STAGE');
  assert.equal(readout.refused, 'true', 'STAGE3_PRE_RIG_GUARD');
  assert.equal(readout.status, catalog[preRigRefusal], 'STAGE3_PRE_RIG_REASON');
  assert.equal(readout.statusVisible, true, 'STAGE3_PRE_RIG_REASON_VISIBLE');
  assert.deepEqual(readout.modeSwitch, {hidden: true, display: 'none', rects: 0}, 'STAGE3_PRE_RIG_MODE_SWITCH');
  assert(readout.controls.length > 0, 'STAGE3_PRE_RIG_CONTROLS_MISSING');
  for (const control of readout.controls) {
    assert.equal(control.disabled, true, 'STAGE3_PRE_RIG_CONTROL_ENABLED');
    assert.equal(control.title, catalog[preRigRefusal], 'STAGE3_PRE_RIG_CONTROL_REASON');
    if (control.pressed !== null) assert.equal(control.pressed, 'false', 'STAGE3_PRE_RIG_CONTROL_PRESSED');
    assert.equal(control.rects, 0, 'STAGE3_PRE_RIG_CONTROL_VISIBLE');
  }
}

function readPreRigDisplay(): PreRigReadout {
  const status = document.querySelector<HTMLElement>('.review-stage-panel > [role=status]');
  const box = status?.getBoundingClientRect(), modeSwitch = document.querySelector<HTMLElement>('.mode-switch')!;
  return {language: document.documentElement.lang, stage: document.documentElement.dataset.inspectionStage ?? null,
    refused: document.documentElement.dataset.stageRefused ?? null, status: status?.textContent ?? '',
    statusVisible: !!status && !!box && box.width > 0 && box.height > 0 && getComputedStyle(status).visibility !== 'hidden',
    modeSwitch: {hidden: modeSwitch.hidden, display: getComputedStyle(modeSwitch).display, rects: modeSwitch.getClientRects().length},
    controls: [...document.querySelectorAll<HTMLButtonElement>('[data-mode],[data-inspector]')].map(button => ({
      disabled: button.disabled, title: button.getAttribute('title'), pressed: button.getAttribute('aria-pressed'), rects: button.getClientRects().length,
    })),
  };
}

export function settled(samples: readonly FramingSample[]): boolean {
  return samples.length >= 3 && samples.every(displayReady) &&
    samples.every(sample => JSON.stringify(sample) === JSON.stringify(samples[0]));
}

/** Runs inside the inspected page. Uses existing public inspection-only hooks. */
function readDisplay(slotNames: string[]): FramingSample {
  const editor = (window as unknown as {rigReviewEditor: {
    stage: () => FramingSample['held']; posed: (slot: string) => FramingSample['posed'][number] | null;
    screen: (x: number, y: number) => Point;
  }}).rigReviewEditor;
  const node = (id: string) => document.getElementById(id)!;
  const rectangle = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();
    return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom};
  };
  const paneNode = node('rig-viewport'), root = node('rig-root');
  const pane = rectangle(paneNode), clip = {...pane};
  clip.left = Math.max(clip.left, 0); clip.top = Math.max(clip.top, 0);
  clip.right = Math.min(clip.right, innerWidth); clip.bottom = Math.min(clip.bottom, innerHeight);
  for (let parent = paneNode.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent), box = rectangle(parent);
    if (/hidden|clip|auto|scroll/.test(css.overflowX)) {
      clip.left = Math.max(clip.left, box.left + parent.clientLeft);
      clip.right = Math.min(clip.right, box.left + parent.clientLeft + parent.clientWidth);
    }
    if (/hidden|clip|auto|scroll/.test(css.overflowY)) {
      clip.top = Math.max(clip.top, box.top + parent.clientTop);
      clip.bottom = Math.min(clip.bottom, box.top + parent.clientTop + parent.clientHeight);
    }
  }
  const posed = slotNames.map(slot => editor.posed(slot)).filter((slot): slot is NonNullable<typeof slot> => slot !== null);
  const world: Point[] = [];
  for (const slot of posed) {
    if (slot.tint[3] === 0) continue;
    const coordinates = slot.kind === 'region' ? slot.corners! : slot.vertices!;
    for (let i = 0; i < coordinates.length; i += 2) world.push({x: coordinates[i]!, y: coordinates[i + 1]!});
  }
  const view = JSON.parse(node('view-coordinates').textContent || '{}');
  const rootBox = rectangle(root);
  const scale = new DOMMatrix(root.style.transform).a;
  return {
    language: document.documentElement.lang, stage: document.documentElement.dataset.inspectionStage ?? null,
    refused: document.documentElement.dataset.stageRefused ?? null,
    mode: document.querySelector<HTMLElement>('[data-mode][aria-pressed="true"]')?.dataset.mode ?? null,
    panelHidden: (document.querySelector('.review-stage-panel') as HTMLElement).hidden,
    usableModes: [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')].filter(button => !button.disabled && button.getClientRects().length > 0).map(button => button.dataset.mode!),
    playDisabled: (node('play') as HTMLButtonElement).disabled,
    // setupComments runs after the awaited initial persistence restoration in start().
    lifecycle: {documentComplete: document.readyState === 'complete', commentsBound: !!node('stage-comment-list'), restoring: document.body.inert},
    draft: node('draft-state').textContent ?? '', renderer: node('renderer-state').textContent ?? '',
    held: editor.stage(), camera: view.cameras?.rig ?? null, cameraSync: view.cameraSync, activeCamera: view.activeCamera ?? null,
    pane, clip, root: {left: root.style.left, top: root.style.top, transform: root.style.transform,
      scale, origin: {x: rootBox.left, y: rootBox.top}, style: root.getAttribute('style')},
    posed, world, projected: world.map(point => ({x: rootBox.left + point.x * scale, y: rootBox.top - point.y * scale})),
    inspectionProjected: world.map(point => editor.screen(point.x, point.y)),
    drawables: [...root.querySelectorAll<HTMLCanvasElement | HTMLImageElement>('canvas,img')].filter(element => getComputedStyle(element).display !== 'none').map(element => ({
      tag: element.tagName, rect: rectangle(element), transform: element.style.transform,
      width: element.width, height: element.height,
    })),
  };
}

/** Independent of readDisplay so a partially initialized page remains diagnosable. */
function readFailureDom() {
  const ids = ['play', 'draft-state', 'dirty', 'message', 'player-state', 'renderer-state', 'stage-comment-list',
    'rig-pane', 'rig-viewport', 'rig-root', 'view-coordinates', 'rig-empty'];
  const elements = ids.map(id => {
    const element = document.getElementById(id);
    if (!element) return {id, missing: true};
    const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
    return {id, text: element.textContent?.slice(0, 8000), hidden: element.hidden,
      disabled: 'disabled' in element ? element.disabled : null, style: element.getAttribute('style'),
      rect: {left: rect.left, top: rect.top, width: rect.width, height: rect.height}, display: css.display, visibility: css.visibility};
  });
  let held: unknown;
  try {held = (window as unknown as {rigReviewEditor?: {stage(): unknown}}).rigReviewEditor?.stage();}
  catch (error) {held = {error: String(error)};}
  const html = document.documentElement.outerHTML;
  return {readyState: document.readyState, language: document.documentElement.lang, pathname: location.pathname,
    inspectionStage: document.documentElement.dataset.inspectionStage, bodyInert: document.body?.inert,
    viewport: {width: innerWidth, height: innerHeight}, held, elements,
    html: html.slice(0, 200000), htmlTruncated: html.length > 200000};
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fileHashes(directory: string, prefix = ''): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of (await readdir(join(directory, prefix), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(hashes, await fileHashes(directory, path + '/'));
    else {assert(entry.isFile(), 'STAGE3_NONREGULAR_INPUT ' + path); hashes[path] = sha256(await readFile(join(directory, path)));}
  }
  return hashes;
}

export async function runPostFixProbe(language: ProbeLanguage): Promise<void> {
  const {launchCdpSession} = await import('./parts-explorer-browser.ts');
  const {openReview, readRecord, running} = await import('../src/open.ts');
  const {withDeadline} = await import('./helpers/walk-deadline.ts');
  const {joinedVerdictFixture} = await import('./helpers/joined-verdict-fixture.ts');
  const started = performance.now();
  const out = process.env.RV496_ARTIFACTS ?? 'artifacts/stage3-framing-postfix-' + language;
  await mkdir(out, {recursive: true});
  const root = await mkdtemp(join(await realpath(tmpdir()), 'review496-'));
  let page: InputCdpSession | undefined;
  const workers: NonNullable<Awaited<ReturnType<typeof readRecord>>>[] = [];
  const stateDir = join(root, 'state'), controlDir = join(stateDir, 'open');
  const diagnostics: {method: string; atMs: number; parameters: string; truncated: boolean}[] = [];
  let droppedDiagnostics = 0;
  const report: Record<string, unknown> = {
    language, purpose: 'POST_FIX_POSITIVE', status: 'PENDING',
    declaredPositive: 'STAGE3_FULL_RIG_CONTAINMENT_POST_FIX', expectedFrameNames: positiveFrameNames,
    declaredMutants: ['MUTANT_CAMERA_Y_BELOW_PANE', 'MUTANT_OVERSIZED_ZOOM', 'MUTANT_UNSETTLED_VIEWPORT', 'MUTANT_RESTORATION_RECT_SHIFT'],
    restorationPolicy: {rectToleranceCssPx: restorationRectToleranceCssPx, positiveOverflowToleranceCssPx: 0,
      exact: ['root style attribute and transform', 'camera', 'pose and source binding', 'non-client-rectangle state'],
      priorRed: {runId: '20261107T213104Z-4a9048e7e2e14e4eb9704e89cd442bda', status: 'UNEXPECTED_RED',
        resultSha256: 'b78ce4e11e7e6b6475510e3095f9ab555f3d2180f61ededf40f205a92588a568',
        observedMaximumClientRectDeltaCssPx: .00006103515625},
      priorPlantRed: {runId: '20261107T213621Z-5f7faefa8fb94c809fd6e7aa667e42e7', status: 'UNEXPECTED_RED',
        resultSha256: 'b80625b3183cfc7cd29e423aad0961039547c99628f4ef76d915293bad0c20c2',
        intendedLocalCssPx: .01, observedClientRectShiftCssPx: 0}},
    declaredReady: 'complete document, comments bound after initial persistence restoration, body not inert, successful renderer, numeric camera, paused held pose, positive clipped pane, three identical consecutive animation-frame observations',
    laterObservationDelaysMs: [250, 1000],
  };
  const observations: {name: string; sampledAtMs: number; sample: FramingSample; containment: ReturnType<typeof containment>; screenshot: {path: string; sha256: string}}[] = [];
  report.observations = observations;
  const saveReport = () => writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  let unexpected: unknown;
  try {
    const originalHashes = await fileHashes('examples/demo');
    report.originalInputHashes = originalHashes;
    const demo = join(root, 'demo');
    await cp('examples/demo', demo, {recursive: true, errorOnExist: true, force: false});
    assert.deepEqual(await fileHashes(demo), originalHashes, 'STAGE3_COPY_CHANGED');
    const model = JSON.parse(await readFile(join(demo, 'skeleton.model.json'), 'utf8')) as {stage: unknown; slots: {name: string}[]};
    report.model = model;
    await writeFile(join(out, 'original-model.json'), await readFile(join(demo, 'skeleton.model.json')));
    const slots = model.slots.map(slot => slot.name);
    page = await launchCdpSession(join(root, 'browser'), {sendDeadlineMs: 2000, onEvent: event => {
      if (!['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(event.method)) return;
      const parameters = JSON.stringify(event.params ?? {});
      diagnostics.push({method: event.method, atMs: performance.now() - started, parameters: parameters.slice(0, 8000), truncated: parameters.length > 8000});
      if (diagnostics.length > 100) {diagnostics.shift(); droppedDiagnostics++;}
    }});
    const browser = page;
    await browser.setViewport(1440, 1000);
    const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response()});
    const frontPort = probe.port!; probe.stop(true);
    const launchOptions = {stateDir, direct: true, idleMs: 15000, graceMs: 400};
    const claimWorker = async (opened: Awaited<ReturnType<typeof openReview>>) => {
      assert.equal(opened.reused, false, 'STAGE3_WORKER_REUSED');
      const key = new URL(opened.url).searchParams.get('handoff')!;
      const worker = await readRecord(join(controlDir, key + '.json'), key);
      assert(worker && worker.nonce === opened.nonce, 'STAGE3_WORKER_IDENTITY');
      workers.push(worker);

    };
    const opened = await openReview({input: join(demo, 'review.json'), viewOnly: true}, launchOptions);
    await claimWorker(opened);
    const url = new URL(opened.url); url.searchParams.set('lang', language);
    await browser.goto(url.href, language);
    const wait = async (expression: string) => {
      report.waitingFor = expression;
      return withDeadline('STAGE3_BROWSER_READY', 15000, async signal => {
        while (!signal.aborted) {if (await browser.evaluate<boolean>(expression)) return; await Bun.sleep(25);}
      });
    };
    await wait(`document.documentElement.lang===${JSON.stringify(language)}&&document.readyState==='complete'&&Boolean(document.querySelector('[data-review-stage="3"]'))&&!document.getElementById('play').disabled&&Boolean(document.getElementById('stage-comment-list'))&&!document.body.inert&&Boolean(window.rigReviewEditor?.stage().modelHash)`);
    await browser.evaluate(`if(document.getElementById('play').textContent!=='▶')document.getElementById('play').click()`);
    const sample = () => browser.evaluate<FramingSample>(`(${readDisplay.toString()})(${JSON.stringify(slots)})`);
    const stable = async () => {
      const recent: FramingSample[] = [];
      report.waitingFor = 'STAGE3_DISPLAY_UNSETTLED';
      await withDeadline('STAGE3_DISPLAY_UNSETTLED', 15000, async signal => {
        while (!signal.aborted) {
          await browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))');
          recent.push(await sample());
          if (recent.length > 3) recent.shift();
          report.lastSamples = [...recent];
          if (settled(recent)) return;
        }
      });
      return recent[2]!;
    };
    const capture = async (name: string, current: FramingSample) => {
      assert.equal(current.held.modelHash, originalHashes['skeleton.model.json'], 'STAGE3_DISPLAYED_MODEL_HASH');
      assert.deepEqual(current.usableModes, ['rig', 'playback'], 'STAGE3_SUPPORTED_MODES');
      assert(current.posed.every(slot => !slot.clip), 'STAGE3_UNDECLARED_CLIP_GEOMETRY');
      const rendered = bounds(current.drawables.flatMap(item => [{x: item.rect.left, y: item.rect.top}, {x: item.rect.right, y: item.rect.bottom}]));
      const projected = bounds(current.projected);
      for (const edge of ['left', 'right', 'top', 'bottom'] as const) assert(Math.abs(rendered[edge] - projected[edge]) < .25, 'STAGE3_DOM_POSE_DISAGREEMENT ' + edge);
      current.projected.forEach((point, i) => {
        const inspection = current.inspectionProjected[i]!;
        assert(Math.abs(point.x - inspection.x) < .25 && Math.abs(point.y - inspection.y) < .25, 'STAGE3_INSPECTION_PROJECTION_DISAGREEMENT');
      });
      const bytes = await browser.screenshot(), path = `${language}-${name}.png`;
      await writeFile(join(out, path), bytes);
      const row = {name, sampledAtMs: performance.now() - started, sample: current, containment: containment(current), screenshot: {path, sha256: sha256(bytes)}};
      observations.push(row);
      await saveReport();
      assertPositiveFrame(current, language);
    };
    const setup = await stable();
    assert.equal(setup.mode, 'rig', 'STAGE3_SETUP_NOT_SELECTED');
    await capture(positiveFrameNames[0], setup);
    await browser.evaluate(`document.querySelector('[data-mode="playback"]').click()`);
    const animate = await stable();
    assert.equal(animate.mode, 'playback', 'STAGE3_ANIMATE_NOT_SELECTED');
    await capture(positiveFrameNames[1], animate);
    await browser.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
    assert.equal(await browser.evaluate(`getComputedStyle(document.querySelector('.mode-switch')).display`), 'none');
    await wait(`document.querySelector('.review-stage-panel iframe')?.contentDocument?.body?.dataset.ready==='true'`);
    await browser.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
    const returned = await stable();
    assert.equal(returned.mode, 'playback', 'STAGE3_ANIMATE_NOT_RETAINED');
    await capture(positiveFrameNames[2], returned);
    for (const delay of [250, 1000]) {
      await Bun.sleep(delay);
      await capture('roundtrip-later-' + delay, await stable());
    }
    assert.deepEqual(observations.map(row => row.name), [...positiveFrameNames], 'STAGE3_POSITIVE_FRAME_SEQUENCE');
    report.positive = observations.map(row => ({name: row.name, worldBounds: bounds(row.sample.world), ...row.containment}));
    const roundtrip = observations[2]!.sample;
    for (const row of observations.slice(3)) {
      assert.deepEqual(row.sample.held, roundtrip.held, 'STAGE3_LATER_HELD_POSE_CHANGED');
      assert.deepEqual(row.sample.camera, roundtrip.camera, 'STAGE3_LATER_CAMERA_CHANGED');
      assert.deepEqual(row.sample.projected, roundtrip.projected, 'STAGE3_LATER_PROJECTION_CHANGED');
    }

    // Declared temporary DOM controls begin only after all untouched positive captures.
    const original = await sample();
    const center = bounds(original.world), savedStyle = original.root.style;
    const worldWidth = center.right - center.left, worldHeight = center.bottom - center.top;
    const positiveScale = Math.min((original.clip.right - original.clip.left) / worldWidth, (original.clip.bottom - original.clip.top) / worldHeight) * .7;
    const worldCenter = {x: (center.left + center.right) / 2, y: (center.top + center.bottom) / 2};
    const screenCenter = {x: (original.clip.left + original.clip.right) / 2, y: (original.clip.top + original.clip.bottom) / 2};
    const scratchCamera = async (scale: number, down: number) => browser.evaluate(`(()=>{const root=document.getElementById('rig-root'),pane=document.getElementById('rig-viewport').getBoundingClientRect();root.style.left=(${screenCenter.x}-pane.left-${worldCenter.x}*${scale})+'px';root.style.top=(${screenCenter.y}-pane.top+${worldCenter.y}*${scale}+${down})+'px';root.style.transform='scale(${scale})';})()`);
    const controls: Record<string, unknown> = {};
    report.controls = controls;
    let restored: FramingSample | undefined;
    try {
      await scratchCamera(positiveScale, 0);
      const positive = await sample();
      controls.positiveScratchOnly = {...containment(positive), sample: positive};
      await saveReport();
      assert.equal(containment(positive).status, 'STAGE3_FULL_RIG_CONTAINED', 'STAGE3_POSITIVE_CONTROL');
      await scratchCamera(positiveScale, original.clip.bottom - original.clip.top);
      const below = await sample();
      controls.MUTANT_CAMERA_Y_BELOW_PANE = {...containment(below), sample: below};
      await saveReport();
      assert(containment(below).overflow.bottom > 0, 'MUTANT_CAMERA_Y_NOT_DETECTED');
      await scratchCamera(positiveScale * 4, 0);
      const zoom = await sample();
      controls.MUTANT_OVERSIZED_ZOOM = {...containment(zoom), sample: zoom};
      await saveReport();
      assert.equal(containment(zoom).status, 'STAGE3_FULL_RIG_OUTSIDE_PANE', 'MUTANT_ZOOM_NOT_DETECTED');
      controls.MUTANT_UNSETTLED_VIEWPORT = {status: 'STAGE3_DISPLAY_UNSETTLED', samples: [positive, below, zoom]};
      await saveReport();
      assert.equal(settled([positive, below, zoom]), false, 'MUTANT_UNSETTLED_NOT_DETECTED');
    } finally {
      await browser.evaluate(`(()=>{const root=document.getElementById('rig-root');const style=${JSON.stringify(savedStyle)};if(style===null)root.removeAttribute('style');else root.setAttribute('style',style);})()`);
      restored = await sample();
      report.restoration = {expected: original, actual: restored, rectToleranceCssPx: restorationRectToleranceCssPx};
      await saveReport();
    }
    assertRestoredDisplay(restored!, original);
    report.domRestored = true;
    await saveReport();

    // Apply, measure and restore atomically, before a renderer task can rewrite the drawable.
    const plant = await browser.evaluate<AtomicRestorationPlant>(`(${atomicRestorationPlant.toString()})(${JSON.stringify(slots)},${readDisplay.toString()})`);
    const shiftControl = {...plant, localShiftCssPx: 1, rectToleranceCssPx: restorationRectToleranceCssPx};
    controls.MUTANT_RESTORATION_RECT_SHIFT = shiftControl;
    report.restorationAfterShift = {expected: plant.expected, actual: plant.restored, rectToleranceCssPx: restorationRectToleranceCssPx};
    await saveReport();
    const displacement = restorationRectDisplacement(plant.expected, plant.actual);
    Object.assign(shiftControl, displacement);
    await saveReport();
    assert(displacement.maximumCssPx > restorationRectToleranceCssPx, 'MUTANT_RESTORATION_SHIFT_NOT_APPLIED');
    assert.throws(() => assertRestoredDisplay(plant.actual, plant.expected), /STAGE3_RESTORATION_RECT/, 'MUTANT_RESTORATION_SHIFT_NOT_DETECTED');
    assert.equal(plant.restoredStyle, plant.originalStyle, 'MUTANT_RESTORATION_STYLE_NOT_RESTORED');
    assertRestoredDisplay(plant.restored, plant.expected);
    report.restorationShiftDetected = true;

    // The pre-rig refusal remains a normal navigation check with no submission.
    const fixtureRoot = join(root, 'pre-rig');
    const fixture = await joinedVerdictFixture(fixtureRoot);
    const preRigHashes = await fileHashes(fixtureRoot);
    const openedPreRig = await openReview({input: fixture.input, project: fixture.project}, launchOptions);
    await claimWorker(openedPreRig);
    const preRigUrl = new URL(openedPreRig.url); preRigUrl.searchParams.set('lang', language);
    await browser.goto(preRigUrl.href, language);
    const frame = `document.querySelector('.review-stage-panel iframe:not([hidden]):not(.review-interview-frame)')`;
    await wait(`${frame}?.contentDocument?.body?.dataset.ready==='true'`);
    assert.equal(await browser.evaluate('document.documentElement.dataset.inspectionStage'), '1', 'STAGE3_PRE_RIG_INITIAL_STAGE');
    assert.equal(await browser.evaluate(`${frame}?.contentDocument?.documentElement.lang`), language, 'STAGE3_PRE_RIG_FRAME_LANGUAGE');
    await browser.evaluate(`document.querySelector('[data-review-stage="3"]').click()`);
    const refused = await browser.evaluate<PreRigReadout>(`(${readPreRigDisplay.toString()})()`);
    report.preRig = {refused, originalInputHashes: preRigHashes};
    assertPreRigRefusal(refused, language);
    const refusedBytes = await browser.screenshot(), refusedPath = `${language}-pre-rig-stage3-refused.png`;
    await writeFile(join(out, refusedPath), refusedBytes);
    report.preRigScreenshot = {path: refusedPath, sha256: sha256(refusedBytes)};
    await browser.evaluate(`document.querySelector('[data-review-stage="1"]').click()`);
    await wait(`${frame}?.contentDocument?.body?.dataset.ready==='true'`);
    assert.equal(await browser.evaluate('document.documentElement.dataset.inspectionStage'), '1', 'STAGE3_PRE_RIG_RETURN_STAGE');
    await fixture.assertFixture();
    assert.deepEqual(await fileHashes(fixtureRoot), preRigHashes, 'STAGE3_PRE_RIG_SOURCE_CHANGED');
    report.preRigReturnedToStage1 = true;
    assert.deepEqual(await fileHashes('examples/demo'), originalHashes, 'STAGE3_ORIGINAL_SOURCE_CHANGED');
    assert.deepEqual(await fileHashes(demo), originalHashes, 'STAGE3_COPIED_SOURCE_CHANGED');
    report.sourceUnchanged = true;
    report.status = 'POST_FIX_POSITIVE_PASS';
    process.exitCode = 0;
  } catch (error) {
    unexpected = error;
    report.status = 'UNEXPECTED_RED';
    report.error = error instanceof Error ? {message: error.message, stack: error.stack} : String(error);
    process.exitCode = 2;
  } finally {
    // Diagnostics precede browser close and source cleanup, including on a readiness timeout.
    if (unexpected && page) {
      try {
        const snapshot = await withDeadline('STAGE3_FAILURE_DOM_CAPTURE', 3000, () => page!.evaluate(`(${readFailureDom.toString()})()`));
        await writeFile(join(out, 'failure-dom.json'), JSON.stringify(snapshot, null, 2) + '\n');
        report.failureDom = 'failure-dom.json';
      } catch (error) {report.failureDomError = String(error);}
      try {
        const screenshot = await withDeadline('STAGE3_FAILURE_SCREENSHOT', 3000, () => page!.screenshot());
        await writeFile(join(out, 'failure.png'), screenshot);
        report.failureScreenshot = {path: 'failure.png', sha256: sha256(screenshot)};
      } catch (error) {report.failureScreenshotError = String(error);}
    }
    await writeFile(join(out, 'browser-diagnostics.json'), JSON.stringify({events: diagnostics, dropped: droppedDiagnostics}, null, 2) + '\n');
    report.browserDiagnostics = 'browser-diagnostics.json';
    await page?.close();
    try {
      for (const worker of workers) await withDeadline('STAGE3_WORKER_EXIT', 7000, async signal => {
        while (!signal.aborted && (await readRecord(join(controlDir, worker.key + '.json'), worker.key) || running(worker.pid))) await Bun.sleep(25);
      });
      report.cleanup = {browserClosed: true, workerExited: workers.every(worker => !running(worker.pid)),
        workers: workers.map(worker => ({key: worker.key, pid: worker.pid, processExited: !running(worker.pid)})), frontExited: null};
      await rm(root, {recursive: true, force: true});
    } catch (error) {
      report.cleanupError = String(error); report.status = 'UNEXPECTED_RED'; process.exitCode = 2;
    }
    report.elapsedMs = performance.now() - started;
    await saveReport();
    console.log(JSON.stringify({status: report.status, elapsedMs: report.elapsedMs, artifacts: out}));
    if (unexpected) console.error(unexpected);
  }
}

if (import.meta.main) await runPostFixProbe(probeLanguage(process.env.RV496_LANG));
