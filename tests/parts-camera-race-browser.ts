import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {loadPartsView} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const TARGET_ROUTE = '/api/parts/image/1';
const EXPECTED = {x: 4, y: 5, zoom: 1.25};
const report: {
  status: string;
  expected: typeof EXPECTED;
  phase: string;
  observations: {lang: string; progress: Record<string, unknown>}[];
  controls?: Record<string, unknown>;
} = {status: 'running', expected: EXPECTED, phase: 'setup', observations: []};
const out = resolve(process.env.REVIEW464_CAMERA_ARTIFACTS ?? 'artifacts/parts-camera-race');
const require = (condition: unknown, name: string) => {
  if (!condition) throw Error(name);
};
const save = () => writeFile(join(out, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9;

async function wait(page: InputCdpSession, predicate: string, name: string) {
  const end = performance.now() + 10_000;
  do {
    if (await page.evaluate(predicate)) return;
    await Bun.sleep(20);
  } while (performance.now() < end);
  throw Error(name);
}

async function click(page: InputCdpSession, selector: string) {
  const p = await page.evaluate<{x: number; y: number}>(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target || target.disabled) throw Error('CONTROL_UNAVAILABLE');
    target.scrollIntoView({block:'nearest'});
    const {left, top, width, height} = target.getBoundingClientRect();
    if (width <= 0 || height <= 0) throw Error('CONTROL_HIDDEN');
    return {x:left + width/2, y:top + height/2};
  })()`);
  await page.mouse('mouseMoved', p.x, p.y);
  await page.mouse('mousePressed', p.x, p.y);
  await page.mouse('mouseReleased', p.x, p.y);
}

interface Sample {
  dimensions: [number, number];
  pixel: number[];
  viewport: {width: number; height: number};
  root: {left: number; top: number; transform: string};
  center: {x: number; y: number};
  zoom: number;
  selected: string | null;
  lang: string;
  caption: string;
  label: string;
  status: string;
  gate: unknown;
}

function sample(page: InputCdpSession, target: 'rig' | 'reference' = 'rig') {
  const isRig = target === 'rig';
  return page.evaluate<Sample>(`(() => {
    const canvas = document.getElementById(${JSON.stringify(isRig ? 'pv-canvas' : 'pv-reference')});
    const view = document.getElementById(${JSON.stringify(target + '-viewport')});
    const root = document.getElementById(${JSON.stringify(isRig ? 'rig-root' : 'reference-content')});
    const zoom = new DOMMatrix(root.style.transform).a;
    const left = parseFloat(root.style.left), top = parseFloat(root.style.top);
    return {
      dimensions:[canvas.width, canvas.height],
      pixel:canvas.width && canvas.height ? Array.from(canvas.getContext('2d').getImageData(3,3,1,1).data) : [],
      viewport:{width:view.clientWidth,height:view.clientHeight},
      root:{left,top,transform:root.style.transform},
      center:{x:(view.clientWidth/2-left)/zoom,y:(view.clientHeight/2-top)/zoom},
      zoom, selected:document.querySelector('[data-pv-item][aria-current=true]')?.dataset.pvItem ?? null,
      lang:document.documentElement.lang,
      caption:document.getElementById('pv-caption').textContent,
      label:document.getElementById('zoom-value').textContent,
      status:document.getElementById('pv-save-status').textContent,
      gate:window.__parts464Gate?.report() ?? null
    };
  })()`);
}

const INSTALL_GATE = `(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  if (!descriptor?.set) throw Error('IMAGE_SRC_SETTER_MISSING');
  let pending = null;
  const events = [], inputs = [], errors = [];
  const targetRoute = ${JSON.stringify(TARGET_ROUTE)};
  window.addEventListener('error', event => errors.push(String(event.message ?? event.type)));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  document.addEventListener('click', event => {
    const node = event.target.closest('[data-pv-item],#zoom-in');
    if (node) inputs.push({control:node.dataset.pvItem || node.id,trusted:event.isTrusted});
  }, true);
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    ...descriptor,
    set(value) {
      const url = new URL(String(value), location.href);
      if (url.origin !== location.origin || url.pathname !== targetRoute) {
        descriptor.set.call(this,value);
        return;
      }
      if (pending || events.length) throw Error('IMAGE_SRC_DUPLICATE');
      pending = {image:this,value};
      this.addEventListener('load', () => events.push({phase:'loaded', width:this.naturalWidth,height:this.naturalHeight}), {once:true});
      this.addEventListener('error', () => events.push({phase:'image-error'}), {once:true});
      events.push({phase:'held',route:url.pathname,rawSource:this.getAttribute('src')});
    }
  });
  window.__parts464Gate = {
    held:() => pending !== null,
    report:() => ({events, inputs, errors, pending:pending !== null}),
    release() {
      if (!pending) throw Error('IMAGE_SRC_RELEASE_WITHOUT_HOLD');
      const {image,value} = pending;
      pending = null;
      Object.defineProperty(HTMLImageElement.prototype,'src',descriptor);
      events.push({phase:'released',route:new URL(String(value),location.href).pathname});
      descriptor.set.call(image,value);
    }
  };
})()`;

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const pixelAt3 = (png: {width: number; data: Uint8Array}) => {
  const i = (3 * png.width + 3) * 4;
  return Array.from(png.data.subarray(i, i + 4));
};

async function afterPaint(page: InputCdpSession, action: string, canvas = 'pv-canvas') {
  // The native canvas dimension setter runs synchronously with the actual draw.
  await page.evaluate(`(() => {
    const node = document.getElementById(${JSON.stringify(canvas)});
    window.__parts464Painted = false;
    const observer = new MutationObserver(() => {
      observer.disconnect();
      window.__parts464Painted = true;
    });
    observer.observe(node, {attributes:true, attributeFilter:['height']});
  })()`);
  await click(page, action);
  await wait(page, 'window.__parts464Painted', 'PARTS_CONTROL_PAINT_TIMEOUT ' + action);
}

async function controls(page: InputCdpSession, url: string) {
  const painted = await sample(page);
  const at = await page.evaluate<{x: number; y: number; localX: number; localY: number}>(`(() => {
    const box = document.getElementById('rig-viewport').getBoundingClientRect();
    return {x:box.left+80,y:box.top+80,localX:80,localY:80};
  })()`);
  await page.mouse('mouseMoved', at.x, at.y);
  await page.mouse('mousePressed', at.x, at.y);
  await page.mouse('mouseMoved', at.x + 10, at.y - 5);
  await page.mouse('mouseReleased', at.x + 10, at.y - 5);
  const panned = await sample(page);
  require(equal(panned.center, {x:painted.center.x - 8, y:painted.center.y + 4}), 'PARTS_PAINTED_PAN');
  await click(page, '#zoom-in');
  const button = await sample(page);
  require(equal(button.center, panned.center) && button.zoom === 1.5625, 'PARTS_PAINTED_BUTTON_ZOOM');
  await page.mouse('mouseWheel', at.x, at.y, -100);
  const wheel = await sample(page);
  const anchor = (row: Sample) => ({
    x: row.center.x + (at.localX - row.viewport.width/2)/row.zoom,
    y: row.center.y + (at.localY - row.viewport.height/2)/row.zoom,
  });
  const beforeAnchor = anchor(button), afterAnchor = anchor(wheel);
  require(near(wheel.zoom, button.zoom * 1.1) && near(beforeAnchor.x, afterAnchor.x) &&
    near(beforeAnchor.y, afterAnchor.y), 'PARTS_PAINTED_CURSOR_ZOOM');
  await afterPaint(page, '[data-pv-item="front"]');
  const repainted = await sample(page);
  require(equal(repainted.center, wheel.center) && repainted.zoom === wheel.zoom, 'PARTS_SAME_SELECTION_CAMERA_LOST');

  await page.goto(url, 'en');
  await wait(page, `document.body.dataset.ready === 'true' && document.getElementById('pv-canvas').width === 20`, 'PARTS_STALE_CONTROL_BOOT');
  await page.evaluate(INSTALL_GATE);
  await click(page, '[data-pv-item="front"]');
  await wait(page, 'window.__parts464Gate.held()', 'PARTS_STALE_CONTROL_GATE');
  await click(page, '#zoom-in');
  await afterPaint(page, '[data-pv-item="body"]');
  await click(page, '#zoom-in');
  const beforeLate = await sample(page);
  await page.evaluate('window.__parts464Gate.release()');
  await wait(page, `window.__parts464Gate.report().events.some(event => event.phase === 'loaded')`, 'PARTS_STALE_CONTROL_RELEASE');
  const afterLate = await sample(page);
  require(equal(beforeLate.dimensions, [20,16]) && equal(beforeLate.center, {x:10,y:8}) &&
    beforeLate.zoom === 1.25 && equal(afterLate.dimensions, beforeLate.dimensions) &&
    equal(afterLate.pixel, beforeLate.pixel) && equal(afterLate.center, beforeLate.center) &&
    afterLate.zoom === beforeLate.zoom && afterLate.selected === 'body', 'PARTS_STALE_RASTER_MOVED_CAMERA');
  return {painted,panned,button,wheel,repainted,beforeLate,afterLate};
}

function requireMidpoint(row: Sample, dimensions: [number, number], name: string) {
  require(equal(row.dimensions, dimensions) &&
    equal(row.center, {x:dimensions[0]/2,y:dimensions[1]/2}) && row.zoom === 1.25,
  'PARTS_FRAME_PAINT_MISMATCH ' + name + ' ' + JSON.stringify(row));
}

async function comparisonFrames(page: InputCdpSession, dir: string) {
  await mkdir(dir);
  await writeDifferencePackage(dir);
  const pkg = await loadPartsView(dir, {painting:join(dir,'painting.png')});
  const server = await startPartsServer(pkg, {port:0, exitOnClose:false});
  try {
    await page.goto(`http://127.0.0.1:${server.port}/?lang=en`, 'en');
    await wait(page, `document.body.dataset.ready === 'true' && document.getElementById('pv-reference').width === 20`, 'PARTS_REFERENCE_FRAME_BOOT');
    const results = [];
    for (const [action, dims, target] of [
      ['[data-pv-item="body"]', [20,16], 'pv-reference'],
      ['[data-pv-item="front"]', [8,10], 'pv-reference'],
      ['[data-pv-comparison="overlay"]', [8,10], 'pv-reference'],
      ['[data-pv-comparison="difference"]', [8,10], 'pv-reference'],
      ['#pv-assemble', [32,24], 'pv-reference'],
    ] as const) {
      await afterPaint(page, action, target);
      await click(page, '#native-one');
      await click(page, '#zoom-in');
      const rig = await sample(page), reference = await sample(page,'reference');
      requireMidpoint(rig,[...dims],action);
      requireMidpoint(reference,[...dims],action + ':reference');
      results.push({action,rig,reference});
    }
    return results;
  } finally { server.stop(true); }
}

async function legacyAtlasFrames(page: InputCdpSession, dir: string) {
  await cp('examples/demo', dir, {recursive:true});
  const modelPath = join(dir,'skeleton.model.json');
  const model = JSON.parse(await readFile(modelPath,'utf8'));
  const atlas = model.pages[0];
  const original = atlas.regions[0];
  atlas.regions = [
    {...original,name:'fractional',x:0.5,y:1.25,width:8.75,height:6.5},
    {...original,name:'degenerate',x:atlas.width+4,y:0,width:8,height:5},
  ];
  await writeFile(modelPath,JSON.stringify(model));
  const pkg = await loadPartsView(dir);
  const server = await startPartsServer(pkg, {port:0, exitOnClose:false});
  try {
    await page.goto(`http://127.0.0.1:${server.port}/?lang=en`,'en');
    await wait(page,`document.body.dataset.ready === 'true' && document.getElementById('pv-canvas').width === 13`,'PARTS_ATLAS_FRAME_BOOT');
    await click(page,'#zoom-in');
    const fractional = await sample(page);
    requireMidpoint(fractional,[13,11],'fractional-region');
    await afterPaint(page,'[data-pv-item="degenerate"]');
    await click(page,'#zoom-in');
    const degenerate = await sample(page);
    // A zero-width crop still paints as zero-width and cannot accept a zoom.
    require(degenerate.dimensions[0] === 0 && degenerate.label === '1:1','PARTS_DEGENERATE_FRAME_ACCEPTED_ZOOM');
    await afterPaint(page,'[data-pv-view="page"]');
    await click(page,'#zoom-in');
    const fullPage = await sample(page);
    requireMidpoint(fullPage,[atlas.width,atlas.height],'full-page');
    return {fractional,degenerate,fullPage};
  } finally { server.stop(true); }
}

await mkdir(out, {recursive: true});
const root = await mkdtemp(join(tmpdir(), 'camera464-'));
let server: Awaited<ReturnType<typeof startPartsServer>> | undefined;
let page: InputCdpSession | undefined;
const settled: Sample[] = [];

try {
  const fixture = await writeComparisonPackage(root);
  const pkg = await loadPartsView(root);
  server = await startPartsServer(pkg, {
    port: 0, capability: 'a'.repeat(64), exitOnClose: false,
    graceMs: 600_000, unopenedTimeoutMs: 600_000,
  });
  page = await launchCdpSession(join(root, 'profile'), {sendDeadlineMs: 10_000});
  await page.setViewport(1440, 1000);
  for (const lang of ['en', 'ko'] as const) {
    report.phase = lang + ':boot';
    const progress: Record<string, unknown> = {};
    report.observations.push({lang, progress});
    await save();
    await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`, lang);
    await wait(page, `(() => {
      const c = document.getElementById('pv-canvas');
      return document.body.dataset.ready === 'true' && c.width === 20 && c.height === 16 &&
        document.getElementById('rig-root').style.transform !== '';
    })()`, 'PARTS_BODY_PAINT_TIMEOUT');
    const initial = await sample(page);
    progress.initial = initial;
    await save();
    require(initial.selected === 'body' && initial.lang === lang, 'PARTS_BOOT_IDENTITY');
    require(equal(initial.pixel, pixelAt3(fixture.part)), 'PARTS_BODY_PIXEL');

    report.phase = lang + ':held';
    await page.evaluate(INSTALL_GATE);
    await click(page, '[data-pv-item="front"]');
    await wait(page, 'window.__parts464Gate.held()', 'PARTS_IMAGE_GATE_TIMEOUT');
    const held = await sample(page);
    progress.held = held;
    await save();
    require(held.selected === 'front' && equal(held.dimensions, [20,16]), 'PARTS_HELD_FRAME');
    require(equal(held.pixel, initial.pixel), 'PARTS_HELD_PIXEL');

    report.phase = lang + ':zoomed-while-held';
    await click(page, '#zoom-in');
    const zoomed = await sample(page);
    progress.zoomed = zoomed;
    await save();
    require(equal(zoomed.dimensions, [20,16]) && equal(zoomed.pixel, initial.pixel), 'PARTS_ZOOM_GATE_LOST');
    await writeFile(join(out, lang + '-held.png'), await page.screenshot());

    report.phase = lang + ':released';
    await page.evaluate('window.__parts464Gate.release()');
    progress.released = await page.evaluate('window.__parts464Gate.report()');
    await save();
    await wait(page, `(() => {
      const c = document.getElementById('pv-canvas');
      return c.width === 8 && c.height === 10 &&
        window.__parts464Gate.report().events.some(e => e.phase === 'loaded');
    })()`, 'PARTS_FRONT_PAINT_TIMEOUT');
    const final = await sample(page);
    progress.settled = final;
    await save();
    require(final.selected === 'front' && final.lang === lang && final.status === '', 'PARTS_SETTLED_IDENTITY');
    require(equal(final.pixel, pixelAt3(fixture.cover)), 'PARTS_FRONT_PIXEL');
    require(equal(final.gate, {
      events:[
        {phase:'held',route:TARGET_ROUTE,rawSource:null},
        {phase:'released',route:TARGET_ROUTE},
        {phase:'loaded',width:8,height:10},
      ],
      inputs:[{control:'front',trusted:true},{control:'zoom-in',trusted:true}],
      errors:[], pending:false,
    }), 'PARTS_GATE_EVIDENCE');
    require(near(final.zoom, EXPECTED.zoom), 'PARTS_PENDING_ZOOM_SCALE');
    settled.push(final);
    await writeFile(join(out, lang + '-settled.png'), await page.screenshot());
    progress.screenshot = lang + '-settled.png';
    await save();
  }
  report.phase = 'aggregate';
  require(settled.every(row => near(row.center.x, EXPECTED.x) && near(row.center.y, EXPECTED.y)),
    'PARTS_PENDING_ZOOM_CENTER ' + JSON.stringify(settled.map(({lang, center, zoom}) => ({lang, center, zoom}))));
  for (const {lang,progress} of report.observations) {
    const zoomed = progress.zoomed as Sample, final = progress.settled as Sample;
    requireMidpoint(final,[8,10],lang);
    require(equal(zoomed.center,final.center) && zoomed.zoom === final.zoom,
      'PARTS_FRAME_PAINT_MISMATCH ' + lang + ':held-to-settled');
  }
  report.controls = {};
  report.phase = 'painted-and-stale-controls';
  report.controls.camera = await controls(page,`http://127.0.0.1:${server.port}/?lang=en`);
  await save();
  report.phase = 'comparison-frames';
  report.controls.comparison = await comparisonFrames(page,join(root,'comparison'));
  await save();
  report.phase = 'legacy-atlas-frames';
  report.controls.atlas = await legacyAtlasFrames(page,join(root,'atlas'));
  report.status = 'passed';
  await save();
} catch (error) {
  report.status = 'failed';
  await save();
  throw error;
} finally {
  await page?.close();
  server?.stop(true);
  await rm(root, {recursive:true,force:true});
}
