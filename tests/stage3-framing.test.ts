import {expect, test} from 'bun:test';
import {bounds, containment, displayReady, settled, assertPositiveFrame, assertPreRigRefusal, positiveFrameNames,
  probeLanguage, type FramingSample, type PreRigReadout} from './stage3-framing-browser.ts';
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
    expect(() => assertPositiveFrame(value, language === 'en' ? 'ko' : 'en')).toThrow('STAGE3_DISPLAYED_LANGUAGE');
    const failed = structuredClone(value); failed.renderer = catalog['Rendering failed'];
    expect(displayReady(failed)).toBe(false);
    const pending = structuredClone(value); pending.renderer = catalog['Not rendered'];
    expect(displayReady(pending)).toBe(false);
    expect(settled([value, structuredClone(value), structuredClone(value)])).toBe(true);
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
