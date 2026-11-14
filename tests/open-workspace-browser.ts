/** #511 ordinary Nova sample. Only synthetic strip-probe copies and normal source CLI launch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {PROBE_MP4_BASE64} from './compare-mode-browser.ts';
import {parseWorkspaceRecord, readPrivate} from '../src/open-workspace-state.ts';

const foreground = Bun.argv.includes('--foreground');
const singleEntry = Bun.argv.includes('--single-entry');
const foregroundDrains: Promise<{output: string; error?: unknown}>[] = [];
let foregroundOwner: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
const language = Bun.argv[Bun.argv.indexOf('--lang') + 1];
assert.ok(language === 'en' || language === 'ko');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const localized = (key: string) => catalog[key] ?? key;
const output = Bun.argv[Bun.argv.indexOf('--out') + 1] || 'evidence/open-workspace-' + language;
function navigationURL() {
  const url = new URL(ownerURL);
  url.searchParams.set('lang', language);
  return url.href;
}
await mkdir(output, {recursive: true});
const root = await mkdtemp(join(tmpdir(), 'review-owner-browser-'));
const inputs: string[] = [], children: Bun.Subprocess[] = [];
const observations: Record<string, unknown> = {};
let page: InputCdpSession | undefined, stateDir = join(root, 'state'), ownerURL = '';
let port = 0;
const events: unknown[] = [];
async function record(name: string, value: unknown) {
  observations[name] = value;
  await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2));
  console.log('owner-workspace ' + language.toUpperCase() + ' ' + name);
}
async function waitTelemetry(name: string) {
  const telemetry = await page!.evaluate(`(()=>{
    const publicURL=value=>{
      const url=new URL(value);url.hash='';
      for(const key of [...url.searchParams.keys()])if(/cap|token|secret/i.test(key))url.searchParams.delete(key);
      return url.href;
    };
    const inspect=(targetDocument,targetWindow)=>{
      const traceText=targetDocument.querySelector('#trace')?.textContent??'';
      let trace=null;try{trace=JSON.parse(traceText);}catch{}
      return {url:publicURL(targetWindow.location.href),locale:targetDocument.documentElement.lang,
        badges:[...targetDocument.querySelectorAll('#renderer-state,#a-renderer,#b-renderer')].map(node=>({id:node.id,text:node.textContent})),
        trace,canvasRects:[...targetDocument.querySelectorAll('#rig-root canvas,#a-root canvas,#b-root canvas,#pv-canvas')].map(canvas=>{
          const box=canvas.getBoundingClientRect();return {parent:canvas.parentElement?.id,width:canvas.width,height:canvas.height,
            rect:{x:box.x,y:box.y,width:box.width,height:box.height}};
        })};
    };
    const frames=[...document.querySelectorAll('.owner-stage>iframe')].slice(0,32).map(frame=>{
      try{
        const entry=inspect(frame.contentDocument,frame.contentWindow);
        const stage=frame.contentDocument.querySelector('.review-stage-panel iframe:not([hidden])');
        return {...entry,hidden:frame.hidden,stage:stage?inspect(stage.contentDocument,stage.contentWindow):null};
      }catch{return {unavailable:true,hidden:frame.hidden};}
    });
    return {owner:inspect(document,window),frames};
  })()`);
  await record('wait-telemetry-' + name, telemetry);
}
async function wait(expression: string, name: string) {
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      if (await page!.evaluate<boolean>(expression)) return;
      await Bun.sleep(50);
    }
    throw new Error('OWNER_BROWSER_WAIT ' + name);
  } catch (error) {
    await waitTelemetry(name).catch(() => record('wait-telemetry-' + name, {unavailable: true}));
    throw error;
  }
}

function frameExpression(index: number, expression: string) {
  return `(()=>{
    const ownerFrame=document.querySelectorAll('.owner-stage>iframe')[${index}];
    const childWindow=ownerFrame.contentWindow;
    const childDocument=ownerFrame.contentDocument;
    return (function(window,document){return (${expression});})(childWindow,childDocument);
  })()`;
}
function canvasExpression(index: number, expression: string, nestedStage: boolean) {
  if (!nestedStage) return frameExpression(index, expression);
  return frameExpression(index, `(()=>{
    const stageFrame=document.querySelector('.review-stage-panel iframe:not([hidden])');
    return (function(window,document){return (${expression});})(stageFrame.contentWindow,stageFrame.contentDocument);
  })()`);
}

async function inside<T>(index: number, expression: string): Promise<T> {
  return page!.evaluate<T>(frameExpression(index, expression));
}
async function clickInside(index: number, selector: string) {
  await inside(index, `document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function cli(args: string[], expected = 0) {
  const child = Bun.spawn([process.execPath, 'src/entry.ts', ...args], {stdout: 'pipe', stderr: 'pipe',
    env: {...process.env, RIG_REVIEW_STATE_DIR: stateDir, RIG_REVIEW_FRONT_PORT: String(port)}});
  children.push(child);
  const timeout = setTimeout(() => {child.kill('SIGTERM');}, 15000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await writeFile(join(output, 'cli-' + children.length + '.json'), JSON.stringify({args, exit, stdout, stderr}));
    if (expected === 0) assert.equal(exit, 0, 'normal CLI exit');
    else assert.notEqual(exit, 0, 'declared negative CLI exit');
    return {stdout, stderr, exit};
  } finally {clearTimeout(timeout);}
}
async function startForeground(args: string[]) {
  const child = Bun.spawn([process.execPath, 'src/entry.ts', ...args], {stdout: 'pipe', stderr: 'pipe',
    env: {...process.env, RIG_REVIEW_STATE_DIR: stateDir, RIG_REVIEW_FRONT_PORT: String(port)}});
  children.push(child); foregroundOwner = child;
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let stdout = '';
  const stderr = new Response(child.stderr).text().then(text => ({text, error: undefined as unknown}), error => ({text: '', error}));
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  try {
    while (!/Review ready: (\S+)/.test(stdout)) {
      const {value, done} = await reader.read();
      if (done) throw new Error('FOREGROUND_START: ' + (await stderr).text);
      stdout += decoder.decode(value, {stream: true});
    }
    const url = new URL(/Review ready: (\S+)/.exec(stdout)![1]!);
    const drained = (async () => {
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          stdout += decoder.decode(value, {stream: true});
        }
        stdout += decoder.decode();
        const errors = await stderr;
        await writeFile(join(output, 'foreground-cli.json'), JSON.stringify({args, stdout, stderr: errors.text, exit: await child.exited}));
        return {output: stdout, error: errors.error};
      } catch (error) {return {output: stdout, error};}
      finally {reader.releaseLock();}
    })();
    foregroundDrains.push(drained);
    return url;
  } finally {clearTimeout(timer);}
}
async function foregroundInventory() {
  const value = await readPrivate(join(stateDir, 'owner-workspace/host.json'));
  assert.ok(value);
  const host = parseWorkspaceRecord(value);
  assert.equal(host.pid, foregroundOwner!.pid);
  assert.equal(foregroundOwner!.exitCode, null);
  const processes = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']);
  assert.equal(processes.exitCode, 0);
  const residents = processes.stdout.toString().split('\n').filter(line => line.includes(root) && /src\/(?:entry|open-workspace-worker)\.ts/.test(line));
  assert.equal(residents.length, 1);
  const sockets = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(host.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
  assert.equal(sockets.exitCode, 0);
  const listeners = sockets.stdout.toString().split('\n').filter(line => line.startsWith('n'));
  assert.deepEqual(listeners, ['n127.0.0.1:' + port]);
  return {creatorPid: host.pid, residentBackendProcesses: residents.length, listeners: 1};
}
async function open(indices: number[]) {
  const args = ['open', ...indices.map(index => inputs[index]!), '--animation', 'inspect', '--view-only', '--control'];
  for (const [position, index] of indices.entries()) args.push('--animation-for', String(position + 1), 'synthetic-animation-' + (index + 1));
  const url = foreground && !ownerURL && indices.length === 9
    ? await startForeground(args.slice(1))
    : new URL((await cli(args)).stdout.trim());
  assert.equal(url.pathname, '/');
  if (ownerURL) assert.equal(url.href, ownerURL);
  else ownerURL = url.href;
}
async function choose(row: number, mounted: number) {
  await page!.evaluate(`document.querySelectorAll('.owner-list button')[${row}].click()`);
  await wait(`document.querySelectorAll('.owner-stage>iframe').length===${mounted} && document.querySelectorAll('.owner-list button')[${row}].getAttribute('aria-pressed')==='true'`, 'target selection ' + row);
}
async function ready(index: number, animation: string) {
  await wait(frameExpression(index, `!!document.querySelector('#animation-select') && document.querySelector('#animation-select').value===${JSON.stringify(animation)} && document.documentElement.lang===${JSON.stringify(language)} && !!document.querySelector('#rig-root canvas') && document.querySelector('#rig-root canvas').width>0 && document.querySelector('#rig-root canvas').height>0 && document.querySelector('#player-state')?.textContent===${JSON.stringify(localized('@rig-c/play · Actual rig'))}`), 'render ' + index);
}

/** Existing shown/hidden screenshot oracle, clipped to the real iframe viewport. */
async function capturePaint(index: number, canvasSelector = '#rig-root canvas', evidenceName = 'target-' + (index + 1), nestedStage = false) {
  const evaluateCanvas = <T>(expression: string) => page!.evaluate<T>(canvasExpression(index, expression, nestedStage));
  const rectangle = await page!.evaluate<{x: number; y: number; width: number; height: number}>(`(()=>{
    const ownerFrame=document.querySelectorAll('.owner-stage>iframe')[${index}];
    const frameRect=ownerFrame.getBoundingClientRect();
    const stageFrame=${nestedStage}?ownerFrame.contentDocument.querySelector('.review-stage-panel iframe:not([hidden])'):null;
    const stageRect=stageFrame?.getBoundingClientRect();
    const childDocument=stageFrame?stageFrame.contentDocument:ownerFrame.contentDocument;
    const childCanvas=childDocument.querySelector(${JSON.stringify(canvasSelector)});
    const canvasRect=childCanvas.getBoundingClientRect();
    const offsetX=frameRect.left+(stageRect?.left??0),offsetY=frameRect.top+(stageRect?.top??0);
    const left=Math.ceil(Math.max(0,frameRect.left,offsetX,offsetX+canvasRect.left));
    const top=Math.ceil(Math.max(0,frameRect.top,offsetY,offsetY+canvasRect.top));
    const right=Math.floor(Math.min(innerWidth,frameRect.right,offsetX+(stageRect?.width??frameRect.width),offsetX+canvasRect.right));
    const bottom=Math.floor(Math.min(innerHeight,frameRect.bottom,offsetY+(stageRect?.height??frameRect.height),offsetY+canvasRect.bottom));
    return {x:left,y:top,width:right-left,height:bottom-top};
  })()`);
  assert.ok(rectangle.width > 0 && rectangle.height > 0, 'actual canvas intersects iframe viewport');
  await evaluateCanvas(`new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))`);
  const shownBytes = await page!.screenshot(rectangle);
  const shown = PNG.sync.read(shownBytes);
  const previous = await evaluateCanvas<string>(`(()=>{const canvas=document.querySelector(${JSON.stringify(canvasSelector)});const previous=canvas.style.visibility;canvas.style.visibility='hidden';return previous;})()`);
  let hiddenBytes: Buffer;
  try {
    await evaluateCanvas(`new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))`);
    hiddenBytes = await page!.screenshot(rectangle);
  } finally {
    await evaluateCanvas(`document.querySelector(${JSON.stringify(canvasSelector)}).style.visibility=${JSON.stringify(previous)}`);
    await evaluateCanvas(`new Promise(resolve=>window.requestAnimationFrame(()=>window.requestAnimationFrame(resolve)))`);
  }
  const hidden = PNG.sync.read(hiddenBytes);
  assert.equal(hidden.width, shown.width); assert.equal(hidden.height, shown.height);
  let changedPixels = 0;
  for (let offset = 0; offset < shown.data.length; offset += 4) {
    if (!shown.data.subarray(offset, offset + 4).equals(hidden.data.subarray(offset, offset + 4))) changedPixels++;
  }
  await writeFile(join(output, evidenceName + '-shown.png'), shownBytes);
  await writeFile(join(output, evidenceName + '-hidden.png'), hiddenBytes);
  assert.ok(changedPixels > 0, 'actual Play canvas contributes visible pixels');
  return {rectangle, changedPixels, width: shown.width, height: shown.height};
}

// Removed embedded atlas oracle: #735 lines 8-11 / #741 replaces stage navigation.
// Existing main-viewport capturePaint assertions above retain actual source-rendered pixels.

async function control(index: number) {
  const result = await cli(['control', inputs[index]!, '--animation', 'synthetic-animation-' + (index + 1)]);
  return JSON.parse(result.stdout);
}
async function stopOwner() {
  const value = await readPrivate(join(stateDir, 'owner-workspace/host.json'));
  if (!value) return;
  const host = parseWorkspaceRecord(value);
  process.kill(host.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && await readPrivate(join(stateDir, 'owner-workspace/host.json'))) await Bun.sleep(25);
  assert.equal(await readPrivate(join(stateDir, 'owner-workspace/host.json')), null);
  if (foregroundOwner?.pid === host.pid) {
    assert.equal(await foregroundOwner.exited, 0);
    const drained = await foregroundDrains.at(-1)!;
    assert.equal(drained.error, undefined);
  }
  const reachable = await fetch(host.origin, {signal: AbortSignal.timeout(500)}).then(async response => {await response.body?.cancel(); return true;}, () => false);
  assert.equal(reachable, false);
  await record('cleanup-' + host.pid, {descriptorRemoved: true, listenerReachable: false});
}
let before: unknown;
try {
  const help = await cli(['open', '--help']);
  assert.ok(help.stdout.includes('rig-review open <dir>'));
  assert.ok(help.stdout.includes('[<dir> ...]') && help.stdout.includes('--animation-for'));
  await record('cli-help', {singleCompatibility: true, multiOperands: true, indexedAnimation: true});
  for (let index = 0; index < 33; index++) {
    const input = join(root, 'synthetic-' + (index + 1));
    await cp(join(import.meta.dir, 'fixtures/strip-probe'), input, {recursive: true});
    const path = join(input, 'build/skeleton.model.json');
    const model = JSON.parse(await readFile(path, 'utf8'));
    model.animations[0].name = 'synthetic-animation-' + (index + 1);
    model.editorOrder.animations[0] = model.animations[0].name;
    model.animations.push({...model.animations[0], name: 'pair-inspect'});
    model.editorOrder.animations.push('pair-inspect');
    await writeFile(path, JSON.stringify(model)); inputs.push(input);
  }
  await writeFile(join(inputs[0]!, 'browser-reference.mp4'), Buffer.from(PROBE_MP4_BASE64, 'base64'));
  before = await Promise.all(inputs.map(jobInputHashes));
  const allocation = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
  port = allocation.port!; await allocation.stop(true);
  await open(Array.from({length: 9}, (_, index) => index));
  if (foreground) {
    const initial = await foregroundInventory();
    await open([0]);
    const joined = await cli([inputs[0]!, inputs[1]!, '--animation', 'synthetic-animation-1',
      '--animation-for', '2', 'synthetic-animation-2', '--view-only', '--control']);
    assert.equal(joined.stdout.trim(), ownerURL);
    await record('foreground-entry', {...initial, afterJoin: await foregroundInventory(), sameOwnerURL: true, joinerExits: [0, joined.exit]});
  }
  page = await launchCdpSession(join(root, 'browser'), {browserArgs: singleEntry ? ['--single-process', '--no-zygote', '--num-raster-threads=1', '--js-flags=--max-old-space-size=1024'] : [], onEvent(event) {
    if (event.method === 'Runtime.exceptionThrown') events.push(event);
  }});
  await page.setViewport(1600, 1000); await page.goto(navigationURL(), language);
  await wait(`document.querySelectorAll('.owner-list button').length===9`, 'nine rows');
  const rows = await page.evaluate<string[]>(`[...document.querySelectorAll('.owner-target-status')].map(node=>node.textContent)`);
  assert.ok(rows.every(value => value === localized('Inspection only')));
  assert.equal(await page.evaluate(`document.querySelector('.owner-header select').getAttribute('aria-label')`), localized('Language'));
  assert.equal(await page.evaluate(`document.querySelector('.owner-header h1').textContent`), localized('Review workspace'));
  await record('nine-inspection-rows', rows);
  for (let index = 0; index < (singleEntry ? 2 : 9); index++) {
    await choose(index, index + 1); await ready(index, 'synthetic-animation-' + (index + 1));
    const rendered = await inside<any>(index, `(async()=>{const response=await fetch(new URL('api/review',window.location.href));const source=await response.json();return {animation:document.querySelector('#animation-select').value,renderer:document.querySelector('#renderer-state').textContent,canvasCount:document.querySelectorAll('#rig-root canvas').length,sourceHash:source.sourceHash,rigHash:source.reviewedSource.rig.sha256};})()`);
    const modelHash = createHash('sha256').update(await readFile(join(inputs[index]!, 'build/skeleton.model.json'))).digest('hex');
    assert.equal(rendered.rigHash, modelHash);
    assert.ok(rendered.renderer.length > 0, 'localized last-render observation is present');
    const paint = await capturePaint(index);
    await record('render-' + (index + 1), {...rendered, paint});
  }
  if (singleEntry) {
    const entry = await fetch(navigationURL().split('#')[0]);
    assert.equal(await entry.text(), await readFile(new URL('../web/index.html', import.meta.url), 'utf8'));
    const layout = await page.evaluate<any>(`(()=>{const app=document.getElementById('app'),stage=document.querySelector('.owner-stage').getBoundingClientRect();return {
      viewport:[innerWidth,innerHeight],children:[...app.children].map(n=>n.tagName),statuses:document.querySelectorAll('.owner-header [role=status]').length,
      footers:app.querySelectorAll('footer').length,bottom:stage.bottom,animations:[...document.querySelectorAll('.owner-target-animation')].map(n=>n.textContent)};})()`);
    assert.deepEqual(layout.viewport, [1600, 1000]);assert.deepEqual(layout.children, ['HEADER','NAV','MAIN']);
    assert.equal(layout.statuses, 1);assert.equal(layout.footers, 0);assert.equal(layout.bottom, 1000);
    assert.deepEqual(layout.animations, Array.from({length:9},(_,i)=>'synthetic-animation-'+(i+1)));
    await choose(0, 2);await clickInside(0,'#zoom-in');
    await inside(0, 'window.__owner734Document=document');
    const held=await inside(0, `document.querySelector('#view-coordinates').textContent`);
    await choose(1, 2);await choose(0, 2);
    assert.equal(await inside(0, 'window.__owner734Document===document'), true);
    assert.equal(await inside(0, `document.querySelector('#view-coordinates').textContent`), held);
    await writeFile(join(output,'owner-single-entry-'+language+'.png'),await page.screenshot());
    assert.deepEqual(await Promise.all(inputs.map(jobInputHashes)),before);assert.equal(events.length,0);
    await record('single-entry-layout',layout);
    await record('verdict',{status:'PASS',sample:'#734 single entry',language,viewport:[1600,1000],mainRigs:2,retainedFrameIdentity:true,cameraRetained:true,inputHashesUnchanged:true,
      boundary:'synthetic source CLI owner composition; legacy acceptance suite not run'});
  } else {
  await choose(0, 9);
  await clickInside(0, '[data-inspector="playback"]');
  await inside(0, `(()=>{const node=document.querySelector('#scrub');node.value='0.25';node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await clickInside(0, '[data-part-list] button');
  await clickInside(0, '[data-inspector="playback"]');
  await clickInside(0, '#zoom-in');
  await clickInside(0, '#stage-comment');
  const commentPoint=await page.evaluate<{x:number;y:number}>(`(()=>{const frame=document.querySelector('.owner-stage>iframe'),outer=frame.getBoundingClientRect(),r=frame.contentDocument.querySelector('#rig-viewport').getBoundingClientRect();return {x:outer.left+r.left+r.width/2,y:outer.top+r.top+r.height/2};})()`);
  await page.mouse('mousePressed',commentPoint.x,commentPoint.y);
  await page.mouse('mouseReleased',commentPoint.x,commentPoint.y);
  await wait(frameExpression(0, `!!document.querySelector('.stage-comment-composer input')`),'current comment composer');
  await inside(0, `(()=>{const node=document.querySelector('.stage-comment-composer input');node.value='Synthetic human unsaved note';node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
  await clickInside(0, '[data-inspector="playback"]');
  const snapshotExpression = `({animation:document.querySelector('#animation-select').value,time:document.querySelector('#scrub').value,zoom:document.querySelector('#zoom-value').textContent,part:document.querySelector('#selected-part').textContent,panel:document.querySelector('[data-inspector][aria-pressed="true"], [data-inspector][aria-selected="true"]')?.getAttribute('data-inspector'),note:document.querySelector('.stage-comment-composer input').value,source:document.querySelector('#provenance-rig').textContent})`;
  const saved = await inside(0, snapshotExpression);
  await record('retention-before', saved);
  // Exercise the public legacy control locator while the real frame is connected.
  await Bun.sleep(1200); const controlBefore = await control(0);
  assert.equal(controlBefore.pages.length, 1); assert.ok(controlBefore.pages[0].inspection.ready);
  assert.equal(controlBefore.pages[0].inspection.time, 0.25);
  assert.equal(controlBefore.pages[0].inspection.playing, false);
  assert.ok(controlBefore.pages[0].inspection.part?.slot, 'an actual part is selected');
  assert.notEqual(controlBefore.pages[0].inspection.cameras.rig.zoom, 1, 'custom camera is nondefault');
  assert.equal((saved as {panel: string}).panel, 'playback', 'a real current panel is retained');
  await record('control-before', controlBefore);
  await clickInside(0, '#play');
  await wait(frameExpression(0, `document.querySelector('#play').getAttribute('aria-label')===${JSON.stringify(localized('Pause'))}`), 'playing before hide');
  await choose(1, 9);
  await wait(frameExpression(0, `document.querySelector('#play').getAttribute('aria-label')===${JSON.stringify(localized('Play'))}`), 'inactive paused');
  const hidden = await page.evaluate<any>(`(()=>{const f=document.querySelector('.owner-stage>iframe'),s=getComputedStyle(f),r=f.getBoundingClientRect();return {display:s.display,visibility:s.visibility,width:r.width,height:r.height,childWidth:f.contentWindow.innerWidth,childHeight:f.contentWindow.innerHeight,paused:f.contentDocument.querySelector('#play').getAttribute('aria-label')===${JSON.stringify(localized('Play'))}};})()`);
  assert.equal(hidden.display, 'block'); assert.equal(hidden.visibility, 'hidden');
  assert.ok(hidden.width > 0 && hidden.height > 0 && hidden.childWidth > 0 && hidden.childHeight > 0 && hidden.paused);
  await record('inactive-computed-geometry', hidden);
  // Playback legitimately advances before pause. Retention compares the held state across selection.
  const held = await inside<any>(0, snapshotExpression);
  await Bun.sleep(250); assert.deepEqual(await inside(0, snapshotExpression), held);
  await choose(0, 9); assert.deepEqual(await inside(0, snapshotExpression), held);
  assert.equal(held.note, 'Synthetic human unsaved note');
  assert.equal(held.source, (saved as any).source); assert.equal(held.zoom, (saved as any).zoom);
  await record('retention-after', held);
  await Bun.sleep(1200);
  const controlAfter = await control(0);
  assert.deepEqual(controlAfter.pages[0].inspection.cameras, controlBefore.pages[0].inspection.cameras);
  assert.deepEqual(controlAfter.pages[0].inspection.part, controlBefore.pages[0].inspection.part);
  assert.equal(controlAfter.sourceHash, controlBefore.sourceHash);
  assert.equal(controlAfter.pages[0].inspection.playing, false);
  await record('control-after-retention', controlAfter);
  // #735:8-11 / #741 removed stage chips and the embedded atlas view; no replacement viewer.
  const geometry = await page.evaluate<any>(`(()=>{
    const rect=selector=>{
      const element=document.querySelector(selector),box=element.getBoundingClientRect();
      return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,width:box.width,height:box.height,
        scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,
        scrollHeight:element.scrollHeight,clientHeight:element.clientHeight};
    };
    const controlStyle=getComputedStyle(document.querySelector('.owner-header select'));
    return {rootFontPx:parseFloat(getComputedStyle(document.documentElement).fontSize),
      viewport:{width:innerWidth,height:innerHeight},header:rect('.owner-header'),
      title:rect('.owner-header h1'),hint:rect('.owner-status'),language:rect('.owner-header select'),
      controlStyle:{minWidth:controlStyle.minWidth,maxWidth:controlStyle.maxWidth,
        height:controlStyle.height,boxSizing:controlStyle.boxSizing}};
  })()`);
  await record('header-rects-' + language, geometry);
  const minimumWidth = geometry.rootFontPx * 6, maximumWidth = geometry.rootFontPx * 12;
  assert.ok(geometry.rootFontPx > 0);
  assert.ok(Math.abs(parseFloat(geometry.controlStyle.minWidth) - minimumWidth) < 0.1);
  assert.ok(Math.abs(parseFloat(geometry.controlStyle.maxWidth) - maximumWidth) < 0.1);
  assert.ok(geometry.language.width >= minimumWidth - 0.5 && geometry.language.width <= maximumWidth + 0.5);
  assert.ok(geometry.language.height >= 24 && geometry.language.height <= 64);
  for (const name of ['title', 'hint', 'language']) {
    const box = geometry[name];
    assert.ok(box.width > 0 && box.height > 0, name + ' has visible geometry');
    assert.ok(box.x >= geometry.header.x && box.right <= geometry.header.right, name + ' inside header');
    assert.ok(box.y >= geometry.header.y && box.bottom <= geometry.header.bottom, name + ' vertically inside header');
    assert.ok(box.x >= 0 && box.right <= geometry.viewport.width && box.y >= 0 && box.bottom <= geometry.viewport.height,
      name + ' inside viewport');
  }
  assert.ok(geometry.title.right <= geometry.hint.x && geometry.hint.right <= geometry.language.x, 'header controls do not overlap');
  for (const name of ['title', 'hint']) {
    assert.ok(geometry[name].scrollWidth <= geometry[name].clientWidth + 1, name + ' has no horizontal clipping');
    assert.ok(geometry[name].scrollHeight <= geometry[name].clientHeight + 1, name + ' has no vertical clipping');
  }
  await writeFile(join(output, 'owner-nine-' + language + '.png'), await page.screenshot());
  await page.evaluate(`window.__ownerDocumentIdentity=document.querySelector('#app')`);
  await open([9]);
  await wait(`document.querySelectorAll('.owner-list button').length===10`, 'new tenth row');
  assert.equal(await page.evaluate(`document.querySelectorAll('.owner-list button')[0].getAttribute('aria-pressed')`), 'true');
  await choose(9, 10); await ready(9, 'synthetic-animation-10');
  assert.ok(await page.evaluate(`window.__ownerDocumentIdentity===document.querySelector('#app')`));
  await record('tenth-selection', {noReload: true, noSelectionTheft: true, mounted: 10});
  await open(Array.from({length: 22}, (_, index) => index + 10));
  await wait(`document.querySelectorAll('.owner-list button').length===32`, 'admission 32');
  await choose(31, 11); await ready(10, 'synthetic-animation-32');
  const refused = await cli(['open', inputs[32]!, '--animation', 'synthetic-animation-33', '--view-only', '--control'], 1);
  assert.ok(refused.stderr.includes('WORKSPACE_TARGET_LIMIT'));
  assert.equal(await page.evaluate(`document.querySelectorAll('.owner-list button').length`), 32);
  await record('application-capacity', {admitted: 32, selectedTenth: true, selected32nd: true, mounted: 11, target33: 'WORKSPACE_TARGET_LIMIT', hardwareCapacityClaim: false});
  const negatives = await page.evaluate<any>(`(async()=>{const f=document.querySelector('.owner-stage>iframe'),u=new URL(f.src),base=u.pathname;const query=await fetch(base+'api/review?debug=1');const cap=await fetch('/workspace/api/targets');return {queryStatus:query.status,query:await query.json(),capStatus:cap.status,cap:await cap.json()};})()`);
  assert.equal(negatives.queryStatus, 400); assert.equal(negatives.query.error, 'FRONT_QUERY_REFUSED'); assert.equal(negatives.capStatus, 403);
  await record('declared-negative-controls', negatives);
  await writeFile(join(output, 'owner-32-' + language + '.png'), await page.screenshot());
  const priorOwner = new URL(ownerURL);
  const priorGrant = priorOwner.hash.slice(5);
  const priorList = await (await fetch(priorOwner.origin + '/workspace/api/targets', {
    headers: {'X-Review-Capability': priorGrant},
  })).json();
  await page.evaluate(`window.__restartDocument=document`);
  await stopOwner();
  ownerURL = '';
  await open([0]);
  const restartedOwner = new URL(ownerURL);
  assert.equal(restartedOwner.origin, priorOwner.origin);
  assert.notEqual(restartedOwner.searchParams.get('workspace'), priorOwner.searchParams.get('workspace'));
  assert.notEqual(restartedOwner.hash, priorOwner.hash);
  let restartedLoader: string | undefined;
  await page.goto(navigationURL(), language, navigation => {restartedLoader = navigation.loaderId;});
  assert.ok(restartedLoader, 'restart navigation replaces the document loader');
  assert.ok(await page.evaluate(`window.__restartDocument===undefined`), 'restart replaces the prior document identity');
  await wait(`document.querySelectorAll('.owner-list button').length===32`, 'restarted source list');
  const stale = await fetch(restartedOwner.origin + '/workspace/api/targets', {
    headers: {'X-Review-Capability': priorGrant},
  });
  assert.equal(stale.status, 403); await stale.body?.cancel();
  const fresh = await fetch(restartedOwner.origin + '/workspace/api/targets', {
    headers: {'X-Review-Capability': restartedOwner.hash.slice(5)},
  });
  assert.equal(fresh.status, 200);
  const restartedList = await fresh.json();
  const sources = (list: any) => list.targets.map((target: any) => ({key: target.key, contentHash: target.contentHash}));
  assert.deepEqual(sources(restartedList), sources(priorList));
  assert.equal(restartedList.incarnation, restartedOwner.searchParams.get('workspace'));
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.owner-list button')].map(button=>button.dataset.targetKey)`),
    restartedList.targets.map((target: any) => target.key));
  await open([0]);
  await record('same-tab-owner-restart', {newLoader: restartedLoader, documentReplaced: true,
    sameOrigin: true, queryChanged: true, grantChanged: true, staleGrantStatus: 403, freshGrantStatus: 200,
    sourcesRevalidated: restartedList.targets.length, repeatedOwnerURLEqual: true});
  await stopOwner();
  // A fresh own workspace admits a normal legacy compare designation through CLI.
  stateDir = join(root, 'compare-state'); ownerURL = '';
  const compared = await cli(['open', inputs[0]!, '--compare', inputs[1]!, '--reference', join(inputs[0]!, 'browser-reference.mp4'), '--animation', 'pair-inspect', '--view-only', '--control']);
  ownerURL = new URL(compared.stdout.trim()).href;
  await page.evaluate(`window.__comparePriorDocument=document`);
  let compareLoader: string | undefined;
  await page.goto(navigationURL(), language, navigation => {compareLoader = navigation.loaderId;});
  assert.ok(compareLoader);
  assert.ok(await page.evaluate(`window.__comparePriorDocument===undefined`));
  await wait(`document.querySelectorAll('.owner-list button').length===1 && !!document.querySelector('.owner-stage>iframe')`, 'compare owner');
  await wait(frameExpression(0, `(()=>{
    if(document.documentElement.lang!==${JSON.stringify(language)})return false;
    try{
      const video=document.querySelector('#reference-video'),trace=JSON.parse(document.querySelector('#trace').textContent);
      return video.readyState>=2 && video.videoWidth>0 && video.videoHeight>0 && !video.seeking &&
        trace.presentation.status==='drawn' && !!trace.presentation.lastDrawn &&
        ['a','b'].every(side=>trace.renderers[side].phase==='drawn' &&
          !!document.querySelector('#'+side+'-root canvas'));
    }catch{return false;}
  })()`), 'decoded reference and drawn pair');
  const renderObservations = await inside<any>(0, `(()=>{
    const trace=JSON.parse(document.querySelector('#trace').textContent);
    return {language:document.documentElement.lang,renderers:['a','b'].map(side=>({side,
      label:document.querySelector('#'+side+'-renderer').textContent,phase:trace.renderers[side].phase,
      kind:trace.renderers[side].raster.kind,backend:trace.renderers[side].raster.backend}))};
  })()`);
  assert.equal(renderObservations.language, language);
  assert.ok(renderObservations.renderers.every((renderer: any) => ['fresh', 'cached'].includes(renderer.kind)));
  await record('compare-render-observations', renderObservations);
  const pair = await inside<any>(0, `({animation:document.querySelector('#animation').textContent,reference:{readyState:document.querySelector('#reference-video').readyState,width:document.querySelector('#reference-video').videoWidth,height:document.querySelector('#reference-video').videoHeight,time:document.querySelector('#reference-video').currentTime},trace:JSON.parse(document.querySelector('#trace').textContent)})`);
  assert.ok(pair.animation.includes('pair-inspect'));
  const pairPaint = {a: await capturePaint(0, '#a-root canvas', 'compare-a'), b: await capturePaint(0, '#b-root canvas', 'compare-b')};
  await record('compare-decoded-paint', {...pair, paint: pairPaint});
  await record('compare-browser', await inside(0, `({title:document.title,renderers:[...document.querySelectorAll('[id*="renderer"]')].map(n=>({id:n.id,text:n.textContent}))})`));
  await clickInside(0, '[data-mode="rig"]');
  for (const side of ['a', 'b']) {
    await clickInside(0, '[data-mode="rig"]');
    await clickInside(0, '#mode-build-picker [data-build-side="' + side + '"]');
    await wait(frameExpression(0, `document.querySelector('#stage-layout').dataset.pickedSide===${JSON.stringify(side)}`), 'picked compare side ' + side);
    await clickInside(0, '[data-mode="playback"]');
    // Main pairPaint above retains both actual source canvas pixel checks (#735:8-11 / #741).
  }
  await writeFile(join(output, 'owner-compare-' + language + '.png'), await page.screenshot());
  assert.deepEqual(await Promise.all(inputs.map(jobInputHashes)), before);
  await record('input-immutability', {unchanged: true, targets: inputs.length});
  assert.equal(events.length, 0, 'unexpected browser exceptions');
  await record('verdict', {status: 'PASS', language, boundary: 'synthetic source CLI browser sample; installed and rigc gates pending'});
  }
} catch (error) {
  await record('verdict', {status: 'RED', error: error instanceof Error ? error.stack : String(error)});
  if (page) await writeFile(join(output, 'failure-' + language + '.png'), await page.screenshot()).catch(() => {});
  throw error;
} finally {
  await writeFile(join(output, 'browser-exceptions.json'), JSON.stringify(events, null, 2));
  if (before) await record('final-input-immutability', {unchanged: JSON.stringify(await Promise.all(inputs.map(jobInputHashes))) === JSON.stringify(before)});
  await page?.close();
  for (const child of children) if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}
  await stopOwner();
  for (const drained of foregroundDrains) assert.equal((await drained).error, undefined);
  await rm(root, {recursive: true, force: true});
}
