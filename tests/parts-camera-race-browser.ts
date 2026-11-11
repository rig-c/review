import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {assertPartsUnchanged, loadPartsView} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {launchCdpSession, type CdpPageEvent, type InputCdpSession} from './parts-explorer-browser.ts';

const TARGET_ROUTE = '/api/parts/image/1';
const EXPECTED = {x: 10, y: 8, zoom: 1.25};
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
    const canvas = ${isRig ? "document.getElementById('parts-canvas')" : "document.querySelector('#reference-content canvas')"};
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
      zoom, selected:document.querySelector('[data-part-list] button[aria-pressed=true]')?.dataset.slot ?? null,
      lang:document.documentElement.lang,
      caption:document.getElementById('rig-label').textContent,
      label:document.getElementById('zoom-value').textContent,
      status:document.getElementById('dirty').textContent,
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
    const node = event.target.closest('[data-part-list] button,#zoom-in');
    if (node) inputs.push({control:node.dataset.slot || node.id,trusted:event.isTrusted});
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

async function afterPaint(page: InputCdpSession, action: string, canvas = 'parts-canvas') {
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


// Atlas Region/Pages and automatic per-item reference cropping were not picked for U3.
// Preserve pending-source, stale-raster, source-binding, exact camera and planted CSS oracles here.
await mkdir(out,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'camera737-'));
let server:Awaited<ReturnType<typeof startPartsServer>>|undefined;
let page:InputCdpSession|undefined;
try{
 const fixture=await writeComparisonPackage(root),pkg=await loadPartsView(root);
 server=await startPartsServer(pkg,{port:0,exitOnClose:false,graceMs:600000,unopenedTimeoutMs:600000});
 page=await launchCdpSession(join(root,'profile'),{sendDeadlineMs:10000,onEvent:sourceResponseEvent});await page.setViewport(1600,1000);
 for(const lang of ['en','ko']as const){
  report.phase=lang+':pending-source';const progress:Record<string,unknown>={};report.observations.push({lang,progress});
  await page.goto('about:blank');await armSourceResponse(page,`http://127.0.0.1:${server.port}/`);
  const installed=await sendCdp!('Page.addScriptToEvaluateOnNewDocument',{source:INSTALL_GATE_OBSERVERS}) as {identifier:string};
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`,lang);
  await wait(page,'window.__parts464Gate?.held()','PARTS_SOURCE_PENDING');
  await click(page,'[data-part-list] button[data-slot="body"]');await click(page,'#part-solo');
  await wait(page,`document.getElementById('parts-canvas').width===20&&document.getElementById('stage-layout').getAttribute('aria-busy')==='false'`,'PARTS_BODY_WHILE_FRONT_PENDING');
  await click(page,'#native-one');await click(page,'#zoom-in');
  const expected=midpoint([20,16]),body=await sample(page,expected);require(matchesCamera(body),'PARTS_NATIVE_BODY_CAMERA');require(equal(body.pixel,pixelAt3(fixture.part)),'PARTS_BODY_PIXEL');
  await click(page,'[data-part-list] button[data-slot="front"]');
  const held=await sample(page,expected);require(equal(held.pixel,body.pixel)&&matchesCamera(held),'PARTS_HELD_PIXEL_CAMERA');
  await click(page,'#zoom-in');
  await afterPaint(page,'[data-part-list] button[data-slot="body"]');
  const before=await sample(page,{...expected,zoom:expected.zoom*1.25});require(matchesCamera(before),'PARTS_PENDING_INPUT_CAMERA');
  Object.assign(progress,{body,held,before});await save();
  await releaseSourceResponse(page);
  await wait(page,`document.body.dataset.ready==='true'&&window.__parts464Gate.report().events.some(e=>e.phase==='loaded')`,'PARTS_STALE_SOURCE_RELEASE');
  const after=await sample(page,before.expected!.camera);progress.after=after;await save();require(matchesCamera(after)&&equal(after.root,before.root)&&equal(after.pixel,before.pixel)&&after.selected==='body','PARTS_STALE_RASTER_CAMERA');
  require((after.gate as {errors:unknown[]}).errors.length===0,'PARTS_ASYNC_ERRORS');
  await afterPaint(page,'[data-part-list] button[data-slot="front"]');
  const front=await sample(page,after.expected!.camera);require(equal(front.dimensions,[8,10])&&equal(front.pixel,pixelAt3(fixture.cover))&&matchesCamera(front),'PARTS_CURRENT_FRONT_CAMERA');
  const at=await page.evaluate<{x:number;y:number}>(`(()=>{const view=document.getElementById('rig-viewport'),r=view.getBoundingClientRect();view.addEventListener('wheel',event=>{const q=view.getBoundingClientRect();window.__parts464Wheel={x:event.clientX-q.left,y:event.clientY-q.top,deltaY:event.deltaY,trusted:event.isTrusted}},{capture:true,once:true});return {x:r.left+80,y:r.top+80}})()`);
  await page.mouse('mouseMoved',at.x,at.y);await page.mouse('mousePressed',at.x,at.y);await page.mouse('mouseMoved',at.x+10,at.y-5);await page.mouse('mouseReleased',at.x+10,at.y-5);
  const camera=front.expected!.camera,pan={x:camera.x-10/camera.zoom,y:camera.y+5/camera.zoom,zoom:camera.zoom};const panned=await sample(page,pan);require(matchesCamera(panned),'PARTS_PAN');
  await click(page,'#zoom-in');const buttonCamera={...pan,zoom:pan.zoom*1.25},button=await sample(page,buttonCamera,'rig',{plants:true});require(matchesCamera(button),'PARTS_BUTTON_ZOOM');require(!matchesCamera({...button,expected:{...button.expected!,root:button.plants!.centre}})&&!matchesZoom(button,button.plants!.zoom),'PARTS_CSS_PLANT');
  await page.mouse('mouseWheel',at.x,at.y,-100);const wheel=await sample(page,buttonCamera,'rig',{wheel:true});require(wheel.wheelInput?.trusted&&matchesCamera(wheel),'PARTS_CURSOR_WHEEL');
  Object.assign(progress,{body,held,before,after,front,panned,button,wheel});await writeFile(join(out,lang+'-settled.png'),await page.screenshot());await save();
  await sendCdp!('Page.removeScriptToEvaluateOnNewDocument',{identifier:installed.identifier});
 }
 report.phase='comparison-frames';const dir=join(root,'comparison');await mkdir(dir);await writeDifferencePackage(dir,true);const comparison=await loadPartsView(dir,{painting:join(dir,'painting.png')}),pair=await startPartsServer(comparison,{port:0,exitOnClose:false});
 try{
  await page.goto(`http://127.0.0.1:${pair.port}/?lang=en`);await wait(page,`document.body.dataset.ready==='true'`,'PARTS_COMPARISON_READY');
  const states=[];for(const mode of ['rig','reference','difference','compare']){await click(page,'#view-menu summary');await click(page,'[data-view="'+mode+'"]');await wait(page,`document.getElementById('stage-layout').getAttribute('aria-busy')==='false'`,'PARTS_VIEW_PAINT');await click(page,'#native-one');const active=mode==='reference'?'reference':'rig';const row=await sample(page,null,active);require(row.zoom===1,'PARTS_NATIVE_COMPARISON');states.push({mode,row});}
  report.controls={states,retired:['Atlas Region/Pages','per-item reference auto-follow/crop']};await assertPartsUnchanged(comparison);
 }finally{pair.stop(true);}
 await assertPartsUnchanged(pkg);report.status='passed';await save();
}catch(error){report.status='failed';report.failure={message:String(error)};if(page)try{report.failure.sample=await sample(page);}catch(e){report.failure.captureError=String(e);}await save();throw error;}
finally{await releaseSourceResponse(page!).catch(()=>{});await page?.close();server?.stop(true);await rm(root,{recursive:true,force:true});}
