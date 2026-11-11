import {clickPartsViewControl} from './helpers/parts-view-shots.ts';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {assertPartsUnchanged, loadPartsView} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {launchCdpSession, type CdpPageEvent, type InputCdpSession} from './parts-explorer-browser.ts';

const TARGET_ROUTE = '/api/parts/image/1';
const EXPECTED = {x: 4, y: 5, zoom: 1.25};
const GATE_BOUNDARY = 'pending-source-response-delivery';
const report: {
  status: string;
  boundary: typeof GATE_BOUNDARY;
  expected: typeof EXPECTED;
  phase: string;
  observations: {lang: string; progress: Record<string, unknown>}[];
  controls?: Record<string, unknown>;
  failure?: {message: string; sample?: Sample; captureError?: string};
} = {status: 'running', boundary: GATE_BOUNDARY, expected: EXPECTED, phase: 'setup', observations: []};
const out = resolve(process.env.REVIEW464_CAMERA_ARTIFACTS ?? 'artifacts/parts-camera-race');
const require = (condition: unknown, name: string) => {
  if (!condition) throw Error(name);
};
const save = () => writeFile(join(out, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');

async function wait(page: InputCdpSession, predicate: string, name: string) {
  const end = performance.now() + 10_000;
  do {
    if (await page.evaluate(predicate)) return;
    await Bun.sleep(20);
  } while (performance.now() < end);
  throw Error(name);
}

async function click(page: InputCdpSession, selector: string) {await clickPartsViewControl(page,selector);}

interface Camera {x:number;y:number;zoom:number}
interface RootStyle {left:string;top:string;transform:string}
interface Sample {
  dimensions: [number, number];
  pixel: number[];
  viewport: {width: number; height: number};
  root: RootStyle;
  inverseCenter: {x: number; y: number};
  zoom: number;
  expected: {camera:Camera;root:RootStyle;zoom:number} | null;
  plants: {centre:RootStyle;unit:number;zoom:number} | null;
  wheelInput: {x:number;y:number;deltaY:number;trusted:boolean} | null;
  selected: string | null;
  lang: string;
  caption: string;
  label: string;
  status: string;
  gate: unknown;
}

function sample(page: InputCdpSession, expected:Camera|null=null, target: 'rig' | 'reference' = 'rig',
    options:{wheel?:boolean;plants?:boolean}={}) {
  const isRig = target === 'rig';
  return page.evaluate<Sample>(`(() => {
    const canvas = document.getElementById(${JSON.stringify(isRig ? 'pv-canvas' : 'pv-reference')});
    const view = document.getElementById(${JSON.stringify(target + '-viewport')});
    const root = document.getElementById(${JSON.stringify(isRig ? 'rig-root' : 'reference-content')});
    const viewport = {width:view.clientWidth,height:view.clientHeight};
    const css = style => ({left:style.left,top:style.top,transform:style.transform});
    const serialized = css(root.style);
    const zoom = new DOMMatrix(serialized.transform).a;
    const expectedCamera = ${JSON.stringify(expected)};
    const {wheel,plants:plantControls} = ${JSON.stringify(options)};
    const wheelInput = wheel ? window.__parts464Wheel ?? null : null;
    const detached = document.createElement('div').style;
    const project = camera => {
      detached.left = (viewport.width/2-camera.x*camera.zoom)+'px';
      detached.top = (viewport.height/2-camera.y*camera.zoom)+'px';
      detached.transform = 'scale('+camera.zoom+')';
      return css(detached);
    };
    if (wheelInput && expectedCamera) {
      const oldZoom = expectedCamera.zoom;
      expectedCamera.zoom *= 1.1;
      const anchorFactor = 1/oldZoom-1/expectedCamera.zoom;
      expectedCamera.x += (wheelInput.x-viewport.width/2)*anchorFactor;
      expectedCamera.y += (wheelInput.y-viewport.height/2)*anchorFactor;
    }
    const expectedRoot = expectedCamera ? project(expectedCamera) : null;
    let plants = null;
    if (plantControls && expectedRoot) {
      // Move the expected projection by one unit of its serialized decimal place.
      const unit = 10 ** -(expectedRoot.top.match(/\\.(\\d+)px$/)?.[1].length ?? 0);
      const wrongTop = parseFloat(expectedRoot.top)+unit;
      const wrongY = (viewport.height/2-wrongTop)/expectedCamera.zoom;
      const centre = project({...expectedCamera,y:wrongY});
      const wrongZoom = project({...expectedCamera,zoom:expectedCamera.zoom*1.25});
      plants = {centre,unit,zoom:new DOMMatrix(wrongZoom.transform).a};
    }
    return {
      dimensions:[canvas.width, canvas.height],
      pixel:canvas.width && canvas.height ? Array.from(canvas.getContext('2d').getImageData(3,3,1,1).data) : [],
      viewport,
      root:serialized,
      inverseCenter:{x:(viewport.width/2-parseFloat(serialized.left))/zoom,y:(viewport.height/2-parseFloat(serialized.top))/zoom},
      expected:expectedRoot ? {camera:expectedCamera,root:expectedRoot,zoom:new DOMMatrix(expectedRoot.transform).a} : null,
      plants,
      wheelInput,
      zoom, selected:document.querySelector('[data-pv-item][aria-current=true]')?.dataset.pvItem ?? null,
      lang:document.documentElement.lang,
      caption:document.getElementById('pv-caption').textContent,
      label:document.getElementById('zoom-value').textContent,
      status:document.getElementById('parts-save-status').textContent,
      gate:window.__parts464Gate?.report() ?? null
    };
  })()`);
}

// Observe genuine decode completion without withholding or rewriting img.src.
const INSTALL_GATE_OBSERVERS = `(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
  if (!descriptor?.set) throw Error('IMAGE_OBSERVER_SETTER_MISSING');
  const events = [], inputs = [], errors = [];
  const gate = window.__parts464Gate = {
    boundary:${JSON.stringify(GATE_BOUNDARY)}, pending:false, events,
    held:() => gate.pending,
    report:() => ({boundary:gate.boundary,events,inputs,errors,pending:gate.pending})
  };
  window.addEventListener('error', event => errors.push(String(event.message ?? event.type)));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  document.addEventListener('click', event => {
    const node = event.target.closest('[data-pv-item],#zoom-in');
    if (node) inputs.push({control:node.dataset.pvItem || node.id,trusted:event.isTrusted});
  }, true);
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    ...descriptor,
    set(value) {
      if (new URL(String(value), location.href).protocol === 'blob:') {
        this.addEventListener('load', () => {
          if (this.naturalWidth !== 8 || this.naturalHeight !== 10 ||
              !events.some(event => event.phase === 'released')) return;
          events.push({phase:'loaded',width:this.naturalWidth,height:this.naturalHeight});
          Object.defineProperty(HTMLImageElement.prototype,'src',descriptor);
        }, {once:true});
        this.addEventListener('error', () => events.push({phase:'image-error'}), {once:true});
      }
      descriptor.set.call(this,value);
    }
  });
})()`;

type SendCdp = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
let sendCdp: SendCdp | undefined;
let sourceTarget = '';
let sourceArmed = false;
let pendingSourceResponse: {requestId: string; send: SendCdp} | null = null;

async function sourceResponseEvent(event: CdpPageEvent, send: SendCdp): Promise<void> {
  if (event.sessionId) sendCdp = send;
  if (event.method !== 'Fetch.requestPaused') return;
  const params = event.params!;
  const requestId = params.requestId as string;
  const request = params.request as {url: string};
  if (!sourceArmed || request.url !== sourceTarget) {
    await send('Fetch.continueRequest', {requestId});
    return;
  }
  require(!pendingSourceResponse, 'PARTS_SOURCE_RESPONSE_DUPLICATE');
  require(params.responseStatusCode === 200, 'PARTS_SOURCE_RESPONSE_STATUS ' + params.responseStatusCode);
  pendingSourceResponse = {requestId, send};
  await page!.evaluate(`(() => {
    const gate = window.__parts464Gate;
    gate.pending = true;
    gate.events.push({phase:'held',route:${JSON.stringify(TARGET_ROUTE)},status:200});
  })()`);
}

async function armSourceResponse(page: InputCdpSession, url: string) {
  require(!pendingSourceResponse, 'PARTS_SOURCE_RESPONSE_STILL_HELD');
  await page.evaluate(INSTALL_GATE_OBSERVERS);
  sourceTarget = new URL(TARGET_ROUTE, url).href;
  sourceArmed = true;
  require(sendCdp, 'PARTS_SOURCE_RESPONSE_SESSION_MISSING');
  await sendCdp!('Fetch.enable', {patterns:[{urlPattern:sourceTarget,requestStage:'Response'}]});
}

async function releaseSourceResponse(page: InputCdpSession) {
  const held = pendingSourceResponse;
  require(held, 'PARTS_SOURCE_RESPONSE_RELEASE_WITHOUT_HOLD');
  sourceArmed = false;
  await page.evaluate(`(() => {
    const gate = window.__parts464Gate;
    gate.pending = false;
    gate.events.push({phase:'released',route:${JSON.stringify(TARGET_ROUTE)}});
  })()`);
  await held!.send('Fetch.continueRequest', {requestId:held!.requestId});
  pendingSourceResponse = null;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const midpoint = (dimensions:readonly [number,number], zoom=1.25):Camera =>
  ({x:dimensions[0]/2,y:dimensions[1]/2,zoom});
const matchesZoom = (row:Sample,zoom:number) => row.zoom===zoom;
const matchesCamera = (row:Sample) => row.expected!==null &&
  matchesZoom(row,row.expected.zoom) && equal(row.root,row.expected.root);
async function record(rows:Record<string,unknown>,key:string,value:unknown) {
  rows[key]=value;
  await save();
}
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

async function controls(page: InputCdpSession, url: string, rows:Record<string,unknown>) {
  const painted = await sample(page,EXPECTED);
  await record(rows,'painted',painted);
  requireMidpoint(painted,[8,10],'painted-control-start');
  const at = await page.evaluate<{x:number;y:number}>(`(() => {
    const view = document.getElementById('rig-viewport');
    const box = view.getBoundingClientRect();
    view.addEventListener('wheel',event=>{
      const rect = view.getBoundingClientRect();
      window.__parts464Wheel = {x:event.clientX-rect.left,y:event.clientY-rect.top,
        deltaY:event.deltaY,trusted:event.isTrusted};
    },{capture:true,once:true});
    return {x:box.left+80,y:box.top+80};
  })()`);
  await page.mouse('mouseMoved', at.x, at.y);
  await page.mouse('mousePressed', at.x, at.y);
  await page.mouse('mouseMoved', at.x + 10, at.y - 5);
  await page.mouse('mouseReleased', at.x + 10, at.y - 5);
  const pan = {x:EXPECTED.x-10/EXPECTED.zoom,y:EXPECTED.y+5/EXPECTED.zoom,zoom:EXPECTED.zoom};
  const panned = await sample(page,pan);
  await record(rows,'panned',panned);
  require(matchesCamera(panned), 'PARTS_PAINTED_PAN');
  await click(page, '#zoom-in');
  const buttonCamera = {...pan,zoom:pan.zoom*1.25};
  const button = await sample(page,buttonCamera,'rig',{plants:true});
  await record(rows,'button',button);
  require(matchesCamera(button), 'PARTS_PAINTED_BUTTON_ZOOM');
  const plants = button.plants!;
  require(plants.centre.left===button.root.left &&
    plants.centre.transform===button.root.transform &&
    !matchesCamera({...button,expected:{...button.expected!,root:plants.centre}}) &&
    !matchesZoom(button,plants.zoom),
  'PARTS_CSS_ORACLE_PLANT_NOT_REJECTED');
  await page.mouse('mouseWheel', at.x, at.y, -100);
  const wheel = await sample(page,buttonCamera,'rig',{wheel:true});
  await record(rows,'wheel',wheel);
  require(wheel.wheelInput?.trusted && wheel.wheelInput.deltaY===-100 && matchesCamera(wheel),
    'PARTS_PAINTED_CURSOR_ZOOM');
  await afterPaint(page, '[data-pv-item="front"]');
  const repainted = await sample(page,wheel.expected!.camera);
  await record(rows,'repainted',repainted);
  require(matchesCamera(repainted) && equal(repainted.root,wheel.root), 'PARTS_SAME_SELECTION_CAMERA_LOST');

  await page.goto(url, 'en');
  await wait(page, `document.body.dataset.ready === 'true' && document.getElementById('pv-canvas').width === 20`, 'PARTS_STALE_CONTROL_BOOT');
  await armSourceResponse(page, url);
  await click(page, '[data-pv-item="front"]');
  await wait(page, 'window.__parts464Gate.held()', 'PARTS_STALE_CONTROL_GATE');
  await click(page, '#zoom-in');
  await afterPaint(page, '[data-pv-item="body"]');
  await click(page, '#zoom-in');
  const bodyCamera=midpoint([20,16]);
  const beforeLate = await sample(page,bodyCamera);
  await record(rows,'beforeLate',beforeLate);
  await releaseSourceResponse(page);
  await wait(page, `window.__parts464Gate.report().events.some(event => event.phase === 'loaded')`, 'PARTS_STALE_CONTROL_RELEASE');
  const afterLate = await sample(page,bodyCamera);
  await record(rows,'afterLate',afterLate);
  require(equal(beforeLate.dimensions, [20,16]) && matchesCamera(beforeLate) &&
    equal(afterLate.dimensions, beforeLate.dimensions) && equal(afterLate.pixel, beforeLate.pixel) &&
    matchesCamera(afterLate) && equal(afterLate.root,beforeLate.root) &&
    afterLate.selected === 'body', 'PARTS_STALE_RASTER_MOVED_CAMERA');
}

function requireMidpoint(row: Sample, dimensions: readonly [number, number], name: string) {
  require(equal(row.dimensions, dimensions) && matchesCamera(row),
  'PARTS_PAINTED_VIEW_MISMATCH ' + name + ' ' + JSON.stringify(row));
}

async function comparisonFrames(page: InputCdpSession, dir: string, rows:Record<string,unknown>) {
  await mkdir(dir);
  await writeDifferencePackage(dir);
  const pkg = await loadPartsView(dir, {painting:join(dir,'painting.png')});
  const server = await startPartsServer(pkg, {port:0, exitOnClose:false});
  try {
    await page.goto(`http://127.0.0.1:${server.port}/?lang=en`, 'en');
    await wait(page, `document.body.dataset.ready === 'true' && document.getElementById('pv-reference').width === 20`, 'PARTS_REFERENCE_FRAME_BOOT');
    for (const [action, dims, target] of [
      ['[data-pv-item="body"]', [20,16], 'pv-reference'],
      ['[data-pv-item="front"]', [8,10], 'pv-reference'],
      ['[data-view="overlay"]', [8,10], 'pv-reference'],
      ['[data-view="difference"]', [8,10], 'pv-reference'],
      ['[data-view=assembled]', [32,24], 'pv-reference'],
    ] as const) {
      await afterPaint(page, action, target);
      await click(page, '#native-one');
      await click(page, '#zoom-in');
      const camera = midpoint(dims);
      const rig = await sample(page,camera), reference = await sample(page,camera,'reference');
      await record(rows,action,{rig,reference});
      requireMidpoint(rig,dims,action);
      requireMidpoint(reference,dims,action + ':reference');
    }
    await assertPartsUnchanged(pkg);
  } finally { server.stop(true); }
}

async function legacyAtlasFrames(page: InputCdpSession, dir: string, rows:Record<string,unknown>) {
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
    const fractional = await sample(page,midpoint([13,11]));
    await record(rows,'fractional',fractional);
    requireMidpoint(fractional,[13,11],'fractional-region');
    await afterPaint(page,'[data-pv-item="degenerate"]');
    await click(page,'#zoom-in');
    const degenerate = await sample(page);
    await record(rows,'degenerate',degenerate);
    // A zero-width crop still paints as zero-width and cannot accept a zoom.
    require(degenerate.dimensions[0] === 0 && degenerate.label === '1:1','PARTS_DEGENERATE_FRAME_ACCEPTED_ZOOM');
    await afterPaint(page,'[data-view="page"]');
    await click(page,'#zoom-in');
    const dimensions:[number,number] = [atlas.width,atlas.height];
    const fullPage = await sample(page,midpoint(dimensions));
    await record(rows,'fullPage',fullPage);
    requireMidpoint(fullPage,dimensions,'full-page');
    await assertPartsUnchanged(pkg);
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
  page = await launchCdpSession(join(root, 'profile'), {sendDeadlineMs: 10_000, onEvent: sourceResponseEvent});
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
    await armSourceResponse(page, `http://127.0.0.1:${server.port}/`);
    await click(page, '[data-pv-item="front"]');
    await wait(page, 'window.__parts464Gate.held()', 'PARTS_IMAGE_GATE_TIMEOUT');
    const held = await sample(page);
    progress.held = held;
    await save();
    require(held.selected === 'front' && equal(held.dimensions, [20,16]), 'PARTS_HELD_FRAME');
    require(equal(held.pixel, initial.pixel), 'PARTS_HELD_PIXEL');

    report.phase = lang + ':zoomed-while-held';
    await click(page, '#zoom-in');
    const zoomed = await sample(page,EXPECTED);
    progress.zoomed = zoomed;
    await save();
    require(equal(zoomed.dimensions, [20,16]) && equal(zoomed.pixel, initial.pixel), 'PARTS_ZOOM_GATE_LOST');
    await writeFile(join(out, lang + '-held.png'), await page.screenshot());

    report.phase = lang + ':released';
    await releaseSourceResponse(page);
    progress.released = await page.evaluate('window.__parts464Gate.report()');
    await save();
    await wait(page, `(() => {
      const c = document.getElementById('pv-canvas');
      return c.width === 8 && c.height === 10 &&
        window.__parts464Gate.report().events.some(e => e.phase === 'loaded');
    })()`, 'PARTS_FRONT_PAINT_TIMEOUT');
    const final = await sample(page,EXPECTED);
    progress.settled = final;
    await save();
    require(final.selected === 'front' && final.lang === lang && final.status === '', 'PARTS_SETTLED_IDENTITY');
    require(equal(final.pixel, pixelAt3(fixture.cover)), 'PARTS_FRONT_PIXEL');
    require(equal(final.gate, {
      boundary:GATE_BOUNDARY,
      events:[
        {phase:'held',route:TARGET_ROUTE,status:200},
        {phase:'released',route:TARGET_ROUTE},
        {phase:'loaded',width:8,height:10},
      ],
      inputs:[{control:'front',trusted:true},{control:'zoom-in',trusted:true}],
      errors:[], pending:false,
    }), 'PARTS_GATE_EVIDENCE');
    require(matchesZoom(final,EXPECTED.zoom), 'PARTS_PENDING_ZOOM_SCALE');
    settled.push(final);
    await writeFile(join(out, lang + '-settled.png'), await page.screenshot());
    progress.screenshot = lang + '-settled.png';
    await save();
  }
  report.phase = 'aggregate';
  require(settled.every(matchesCamera),
    'PARTS_PENDING_ZOOM_CENTER ' + JSON.stringify(settled.map(({lang, root, expected}) => ({lang, root, expected}))));
  for (const {lang,progress} of report.observations) {
    const zoomed = progress.zoomed as Sample, final = progress.settled as Sample;
    requireMidpoint(final,[8,10],lang);
    require(matchesCamera(zoomed) && equal(zoomed.root,final.root),
      'PARTS_HELD_CAMERA_MISMATCH ' + lang + ':held-to-settled');
  }
  const camera={},comparison={},atlas={};
  report.controls = {camera,comparison,atlas};
  report.phase = 'painted-and-stale-controls';
  await controls(page,`http://127.0.0.1:${server.port}/?lang=en`,camera);
  await save();
  report.phase = 'comparison-frames';
  await comparisonFrames(page,join(root,'comparison'),comparison);
  await save();
  report.phase = 'legacy-atlas-frames';
  await legacyAtlasFrames(page,join(root,'atlas'),atlas);
  await assertPartsUnchanged(pkg);
  report.status = 'passed';
  await save();
} catch (error) {
  report.status = 'failed';
  report.failure = {message:error instanceof Error ? error.message : String(error)};
  if (page) {
    try { report.failure.sample = await sample(page); }
    catch (captureError) { report.failure.captureError = String(captureError); }
  }
  await save();
  throw error;
} finally {
  await page?.close();
  server?.stop(true);
  await rm(root, {recursive:true,force:true});
}
