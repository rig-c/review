import {expect, test} from 'bun:test';
import {bounds, containment, displayReady, settled, assertPositiveFrame, assertPreRigRefusal, positiveFrameNames,
  probeLanguage, assertRestoredDisplay, restorationRectToleranceCssPx, atomicRestorationPlant, restorationRectDisplacement,
  type FramingSample, type PreRigReadout} from './stage3-framing-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

function sample(): FramingSample {
  return {
    language: 'en', stage: '3', refused: null, mode: 'rig', panelHidden: true,
    usableModes: ['rig', 'playback'], playDisabled: false, draft: '', renderer: 'No mesh · DOM images',
    lifecycle: {documentComplete: true, commentsBound: true, restoring: false},
    held: {modelHash: 'a'.repeat(64), inspectedHash: 'a'.repeat(64), animation: 'idle', time: .2, playing: false, busy: false},
    camera: {center: {x: 0, y: 0}, zoom: 1, viewport: {width: 400, height: 400}, visible: {x: -200, y: -200, width: 400, height: 400}}, cameraSync: true, activeCamera: 'rig',
    pane: {left: 100, top: 100, right: 500, bottom: 500}, clip: {left: 100, top: 100, right: 500, bottom: 500},
    root: {left: '200px', top: '200px', transform: 'scale(1)', scale: 1, origin: {x: 200, y: 200}, style: ''},
    posed: [{slot: 'body', kind: 'region', tint: [1, 1, 1, 1], corners: [-10, -10, -10, 10, 10, 10, 10, -10]}],
    world: [{x: -10, y: -10}, {x: 10, y: 10}], projected: [{x: 200, y: 200}, {x: 300, y: 300}],
    inspectionProjected: [{x: 200, y: 200}, {x: 300, y: 300}],
    drawables: [{tag: 'IMG', rect: {left: 200, top: 200, right: 300, bottom: 300}, transform: '', width: 20, height: 20}],
  };
}

test('STAGE3_FULL_RIG_CONTAINMENT uses every held point and the actually clipped pane', () => {
  const value = sample();
  expect(containment(value).status).toBe('STAGE3_FULL_RIG_CONTAINED');
  value.projected.push({x: 250, y: 510});
  expect(containment(value)).toMatchObject({status: 'STAGE3_FULL_RIG_OUTSIDE_PANE', overflow: {bottom: 10}});
  value.projected.pop(); value.clip.bottom = 280;
  expect(containment(value).overflow.bottom).toBe(20);
  expect(() => bounds([])).toThrow('STAGE3_GEOMETRY_MISSING');
  expect(() => bounds([{x: NaN, y: 0}])).toThrow('STAGE3_GEOMETRY_NONFINITE');
});

test('MUTANT_CAMERA_Y_BELOW_PANE and MUTANT_OVERSIZED_ZOOM are detected independently', () => {
  const below = sample(); below.projected = below.projected.map(point => ({...point, y: point.y + 400}));
  expect(containment(below).overflow.bottom).toBe(200);
  const zoom = sample(); zoom.projected = [{x: -100, y: -100}, {x: 700, y: 700}];
  expect(containment(zoom)).toMatchObject({status: 'STAGE3_FULL_RIG_OUTSIDE_PANE', overflow: {left: 200, top: 200, right: 200, bottom: 200}});
});

test('STAGE3_DISPLAY_READY requires a paused drawable model and three stable frame observations', () => {
  const value = sample();
  expect(displayReady(value)).toBe(true);
  expect(settled([value, structuredClone(value), structuredClone(value)])).toBe(true);
  expect(settled([value, value])).toBe(false);
  const moved = structuredClone(value); moved.root.top = '201px';
  expect(settled([value, value, moved])).toBe(false);
  const playing = structuredClone(value); playing.held.playing = true;
  expect(displayReady(playing)).toBe(false);
  const restoring = structuredClone(value); restoring.lifecycle.restoring = true;
  expect(displayReady(restoring)).toBe(false);
  const refused = structuredClone(value); refused.refused = 'true';
  expect(displayReady(refused)).toBe(false);
  const empty = structuredClone(value); empty.drawables = [];
  expect(displayReady(empty)).toBe(false);
});

test('fresh successful initialization permits empty draft status and requires actual lifecycle/camera/renderer', () => {
  const value = sample();
  expect(value.draft).toBe('');
  expect(displayReady(value)).toBe(true);
  const pending = structuredClone(value); pending.lifecycle.commentsBound = false;
  expect(displayReady(pending)).toBe(false);
  const loading = structuredClone(value); loading.lifecycle.documentComplete = false;
  expect(displayReady(loading)).toBe(false);
  const failed = structuredClone(value); failed.renderer = 'Rendering failed';
  expect(displayReady(failed)).toBe(false);
  const noCamera = structuredClone(value); noCamera.camera = null;
  expect(displayReady(noCamera)).toBe(false);
});

test('post-fix probe selects one explicit supported locale and five positive frame names', () => {
  expect(probeLanguage(undefined)).toBe('en');
  expect(probeLanguage('en')).toBe('en');
  expect(probeLanguage('ko')).toBe('ko');
  expect(() => probeLanguage('ja')).toThrow('STAGE3_PROBE_LANGUAGE');
  expect(positiveFrameNames).toEqual(['setup-display-ready', 'animate-display-ready', 'roundtrip-display-ready',
    'roundtrip-later-250', 'roundtrip-later-1000']);
});

test('EN and KO positive containment reject clipping while retaining the existing planted-control oracle', () => {
  for (const language of ['en', 'ko'] as const) {
    const value = sample(), catalog = language === 'ko' ? koCatalog : enCatalog;
    value.language = language; value.renderer = catalog['No mesh · DOM images'];
    for (const name of positiveFrameNames) {
      expect(name.length).toBeGreaterThan(0);
      expect(() => assertPositiveFrame(value, language)).not.toThrow();
    }
    const below = structuredClone(value); below.projected.push({x: 200, y: 510});
    expect(() => assertPositiveFrame(below, language)).toThrow('STAGE3_POST_FIX_CONTAINMENT');
    const tinyOverflow = structuredClone(value); tinyOverflow.projected.push({x: 200, y: 500.0001});
    expect(() => assertPositiveFrame(tinyOverflow, language)).toThrow('STAGE3_POST_FIX_ZERO_OVERFLOW');
    expect(() => assertPositiveFrame(value, language === 'en' ? 'ko' : 'en')).toThrow('STAGE3_DISPLAYED_LANGUAGE');
    const failed = structuredClone(value); failed.renderer = catalog['Rendering failed'];
    expect(displayReady(failed)).toBe(false);
    const pending = structuredClone(value); pending.renderer = catalog['Not rendered'];
    expect(displayReady(pending)).toBe(false);
    expect(settled([value, structuredClone(value), structuredClone(value)])).toBe(true);
  }
});

test('restoration permits only declared client-rectangle rounding and detects a planted shift above tolerance', () => {
  const expected = sample(), rounded = structuredClone(expected);
  rounded.drawables[0]!.rect.left += .00006103515625;
  rounded.drawables[0]!.rect.top += .000030517578125;
  expect(restorationRectToleranceCssPx).toBe(.001);
  expect(() => assertRestoredDisplay(rounded, expected)).not.toThrow();
  const shifted = structuredClone(expected); shifted.drawables[0]!.rect.left += .002;
  expect(() => assertRestoredDisplay(shifted, expected)).toThrow('STAGE3_RESTORATION_RECT');
  const nonfinite = structuredClone(expected); nonfinite.drawables[0]!.rect.left = NaN;
  expect(() => assertRestoredDisplay(nonfinite, expected)).toThrow('STAGE3_RESTORATION_RECT');
});

test('restoration keeps root style, camera, posed geometry, source and drawable identity exact', () => {
  const expected = sample();
  const root = structuredClone(expected); root.root.style = 'transform:scale(1.000000000001)';
  expect(() => assertRestoredDisplay(root, expected)).toThrow('STAGE3_RESTORATION_EXACT_ROOT');
  const camera = structuredClone(expected); camera.camera!.center.x += 1e-12;
  expect(() => assertRestoredDisplay(camera, expected)).toThrow('STAGE3_RESTORATION_EXACT_STATE');
  const pose = structuredClone(expected); pose.posed[0]!.corners![0]! += 1e-12;
  expect(() => assertRestoredDisplay(pose, expected)).toThrow('STAGE3_RESTORATION_EXACT_STATE');
  const source = structuredClone(expected); source.held.modelHash = 'b'.repeat(64);
  expect(() => assertRestoredDisplay(source, expected)).toThrow('STAGE3_RESTORATION_EXACT_STATE');
  const drawable = structuredClone(expected); drawable.drawables[0]!.transform = 'matrix(1,0,0,1,1,0)';
  expect(() => assertRestoredDisplay(drawable, expected)).toThrow('STAGE3_RESTORATION_EXACT_DRAWABLE');
});

test('atomic restoration plant measures translate or computed-position fallback and restores exact original style', () => {
  const globals = ['document', 'CSS', 'getComputedStyle'] as const;
  const saved = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  try {
    for (const supported of [true, false]) {
      const style: Record<string, string> = {left: '0px', transform: 'matrix(1,0,0,1,0,0)'};
      const drawable = {style, getAttribute: (): string | null => JSON.stringify(style),
        setAttribute: (_name: string, value: string) => {for (const name of Object.keys(style)) delete style[name]; Object.assign(style, JSON.parse(value));},
        removeAttribute: () => {for (const name of Object.keys(style)) delete style[name];},
      };
      Object.defineProperty(globalThis, 'document', {configurable: true, value: {querySelector: () => drawable}});
      Object.defineProperty(globalThis, 'CSS', {configurable: true, value: {supports: () => supported}});
      Object.defineProperty(globalThis, 'getComputedStyle', {configurable: true, value: () => ({
        translate: style.translate ?? 'none', transform: style.transform, left: style.left, top: '0px', position: 'absolute',
      })});
      const measured: number[] = [];
      const read = () => {
        const value = sample(), shift = (style.translate === '1px 0' ? 1 : Number.parseFloat(style.left ?? '0')) * 4;
        value.drawables[0]!.rect.left += shift; value.drawables[0]!.rect.right += shift;
        measured.push(shift); return value;
      };
      const plant = atomicRestorationPlant(['body'], read);
      expect(measured).toEqual([0, 4, 0]);
      expect(plant.mode).toBe(supported ? 'translate' : 'computed-position');
      expect(plant.restoredStyle).toBe(plant.originalStyle);
      expect(plant.computedAfter.transform).toBe(plant.computedBefore.transform);
      expect(restorationRectDisplacement(plant.expected, plant.actual).maximumCssPx).toBe(4);
      expect(() => assertRestoredDisplay(plant.actual, plant.expected)).toThrow('STAGE3_RESTORATION_RECT');
      expect(() => assertRestoredDisplay(plant.restored, plant.expected)).not.toThrow();
      let reads = 0;
      expect(() => atomicRestorationPlant(['body'], () => {
        if (++reads === 2) throw new Error('PLANTED_MEASUREMENT_ERROR');
        return sample();
      })).toThrow('PLANTED_MEASUREMENT_ERROR');
      expect(drawable.getAttribute()).toBe(plant.originalStyle);
    }
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('pre-rig refusal requires the existing localized reason and disables every mode control in EN and KO', () => {
  for (const language of ['en', 'ko'] as const) {
    const catalog = language === 'ko' ? koCatalog : enCatalog;
    const reason = catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.'];
    const refused: PreRigReadout = {language, stage: '3', refused: 'true', status: reason, statusVisible: true,
      modeSwitch: {hidden: true, display: 'none', rects: 0},
      controls: [{disabled: true, title: reason, pressed: 'false', rects: 0}],
    };
    expect(() => assertPreRigRefusal(refused, language)).not.toThrow();
    const exposed = structuredClone(refused); exposed.controls[0]!.disabled = false;
    expect(() => assertPreRigRefusal(exposed, language)).toThrow('STAGE3_PRE_RIG_CONTROL_ENABLED');
    const fabricated = structuredClone(refused); fabricated.status = 'Unknown refusal';
    expect(() => assertPreRigRefusal(fabricated, language)).toThrow('STAGE3_PRE_RIG_REASON');
  }
});
