/** Bounded ordinary Nova semantic hub sample. Every input and UI answer is synthetic. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {startJobHub, JOB_API_SCHEMA, JOB_ACT_SCHEMA, type JobOwnerHub, type JobHubJob,
  type JobPublication, type JobPendingAsk, type JobAct, type JobResult} from '@rig-c/review/job-host';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {JOB_HUB_VISIBILITY} from '../web/job-hub.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const argument = (key: string) => {const index = Bun.argv.indexOf(key); return index < 0 ? undefined : Bun.argv[index + 1];};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko', 'declared paired sample language');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = argument('--out') ?? 'evidence/job-hub-' + language;
await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-hub-browser-'));
const stateDir = join(scratch, 'state'), profile = join(scratch, 'chrome');
const inputs: Awaited<ReturnType<typeof jobFixture>>[] = [];
const jobs: JobHubJob[] = [], publications: JobPublication[] = [], asks: JobPendingAsk[] = [];
const writerGrants = new Map<string, string>(), generations: number[] = [], secrets = new Set<string>();
const observations: Record<string, unknown> = {}, exceptions: unknown[] = [], observerErrors: string[] = [];
const scripts = new Map<string, {jobId: string; variable: string}>();
const observers = new Map<string, {contextId: number; scriptId: string; line: number}>();
const debugObservations: unknown[] = [];
const commands: {probeCommandId: number; method: string; kind: string; expressionHash?: string; startMs: number; endMs?: number; error?: string}[] = [];
const breakpoints = new Map<string, {id: string; paused: boolean; captured: boolean; removed: boolean; resumed: boolean}>();
type NetworkRequest = {requestId: string; sessionId?: string; url: string; startedMs: number;
  responseMs?: number; protocol?: string; status?: number; connectionId?: number;
  timing?: unknown; finishedMs?: number; failedMs?: number; errorText?: string};
type NetworkStreamSet = {phase: string; atMs: number; method: string; requestId: string;
  outstandingStreamIds: string[]; pendingHeaderStreamIds: string[];
  responseConfirmedStreams: {requestId: string; protocol: string; connectionId: number | string}[];
  activeConnectionIds: (number | undefined)[]};
const networkEvents: unknown[] = [], networkSets: NetworkStreamSet[] = [];
const networkRequests = new Map<string, NetworkRequest>();
let networkPhase = 'positive', positiveMaximumStreams = 0;
function activeStreams() {
  return [...networkRequests.values()].filter(request => /\/jobs\/[^/]+\/events(?:\?|$)/.test(request.url) &&
    request.finishedMs === undefined && request.failedMs === undefined);
}
function confirmedStreams() {
  return activeStreams().filter(request => request.responseMs !== undefined);
}
function networkEvent(event: {method: string; params?: Record<string, unknown>; sessionId?: string}) {
  if (!event.method.startsWith('Network.')) return;
  const atMs = performance.now() - started;
  networkEvents.push({phase: networkPhase, atMs, ...event});
  const params = event.params ?? {}, requestId = String(params.requestId ?? '');
  const key = (event.sessionId ?? '') + ':' + requestId;
  if (event.method === 'Network.requestWillBeSent') {
    const request = params.request as {url: string};
    networkRequests.set(key, {requestId, sessionId: event.sessionId, url: request.url, startedMs: atMs});
  }
  const request = networkRequests.get(key);
  if (request && event.method === 'Network.responseReceived') {
    const response = params.response as {protocol: string; status: number; connectionId: number; timing?: unknown};
    Object.assign(request, {responseMs: atMs, protocol: response.protocol, status: response.status,
      connectionId: response.connectionId, timing: response.timing});
  }
  if (request && event.method === 'Network.loadingFinished') request.finishedMs = atMs;
  if (request && event.method === 'Network.loadingFailed') Object.assign(request, {failedMs: atMs, errorText: params.errorText});
  if (['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'].includes(event.method)) {
    const streams = activeStreams();
    networkSets.push({phase: networkPhase, atMs, method: event.method, requestId,
      outstandingStreamIds: streams.map(value => value.requestId),
      pendingHeaderStreamIds: streams.filter(value => value.responseMs === undefined).map(value => value.requestId),
      responseConfirmedStreams: confirmedStreams().map(value => ({requestId: value.requestId, protocol: value.protocol ?? 'unknown', connectionId: value.connectionId ?? 'unknown'})),
      activeConnectionIds: [...new Set([...networkRequests.values()].filter(value => value.responseMs !== undefined &&
        value.finishedMs === undefined && value.failedMs === undefined).map(value => value.connectionId))]});
    if (networkPhase === 'positive') positiveMaximumStreams = Math.max(positiveMaximumStreams, streams.length);
  }
}
async function networkReceipt(name: string) {
  await writeFile(join(output, 'network-events.json'), safe(networkEvents));
  await writeFile(join(output, 'network-stream-sets.json'), safe(networkSets));
  await record(name, {phase: networkPhase, positiveMaximumStreams, outstandingStreams: activeStreams().map(request =>
    ({...request, protocol: request.protocol ?? 'unknown', connectionId: request.connectionId ?? 'unknown'})),
    pendingHeaderStreams: activeStreams().filter(request => request.responseMs === undefined),
    responseConfirmedStreams: confirmedStreams(), requests: [...networkRequests.values()]});
}
/** HQ7048d190 replaces the strict outstanding-one bar with bounded handover headroom. */
async function checkPositiveStreamBar(name: string) {
  const samples = networkSets.filter(sample => sample.phase === 'positive');
  const handovers = samples.filter(sample => sample.method === 'Network.requestWillBeSent' && sample.outstandingStreamIds.length > 1)
    .map(sample => {
      const outgoing = [...networkRequests.values()].filter(request => sample.outstandingStreamIds.includes(request.requestId) &&
        request.requestId !== sample.requestId).sort((left, right) => left.startedMs - right.startedMs)[0]!;
      const ended = outgoing.finishedMs ?? outgoing.failedMs;
      return {incomingRequestId: sample.requestId, outgoingRequestId: outgoing.requestId, startedMs: sample.atMs,
        endedMs: ended ?? null, durationMs: ended === undefined ? null : ended - sample.atMs,
        outcome: outgoing.finishedMs !== undefined ? 'finished' : outgoing.failedMs !== undefined ? outgoing.errorText ?? 'failed' : 'pending',
        outgoing};
    });
  const steadyMaximumConfirmed = Math.max(0, ...samples.filter(sample => sample.outstandingStreamIds.length <= 1)
    .map(sample => sample.responseConfirmedStreams.length));
  await record(name, {hqRuling: '7048d190-b63b-4145-8948-75fdb1f4ea0e',
    replacedBar: 'strict outstanding event requests <=1 including handovers',
    reason: 'bounded handover headroom remains below the six-origin connection ceiling; original RED preserved',
    steadyMaximumConfirmed, maximumOutstanding: positiveMaximumStreams, handovers});
  assert.ok(steadyMaximumConfirmed <= 1, 'steady response-confirmed event streams <=1');
  assert.ok(positiveMaximumStreams <= 2, 'all outstanding event requests including headerless <=2');
  for (const handover of handovers) {
    assert.ok(handover.durationMs !== null && handover.durationMs >= 0 && handover.durationMs <= 50,
      'each outgoing handover request terminates within50ms');
    assert.ok(handover.outcome === 'finished' || handover.outcome === 'net::ERR_ABORTED',
      'outgoing handover request finishes or aborts');
  }
}
let commandSequence = 0, promiseSequence = 0;
let hub: JobOwnerHub | undefined, page: InputCdpSession | undefined;
let send: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
let before: Record<string, string>[] | undefined;
const started = performance.now();
function safe(value: unknown) {
  let text = JSON.stringify(value, null, 2).replace(/#cap=[^\s'"<>]+/g, '#cap=<redacted>');
  for (const secret of secrets) text = text.replaceAll(secret, '<redacted>');
  return text;
}
async function record(name: string, value: unknown) {
  observations[name] = value;
  await writeFile(join(output, 'observations.json'), safe(observations));
  console.log('job-hub ' + language.toUpperCase() + ' ' + name);
}
function frameExpression(index: number, expression: string) {
  const path = '/jobs/' + jobs[index]!.session.jobId + '/';
  return `(()=>{
    const ownerFrame=[...document.querySelectorAll('.hub-stage>iframe')].find(frame=>new URL(frame.src).pathname===${JSON.stringify(path)});
    if(!ownerFrame)return null;
    const childWindow=ownerFrame.contentWindow,childDocument=ownerFrame.contentDocument;
    return (function(window,document){return (${expression});})(childWindow,childDocument);
  })()`;
}
type ProbeSend = NonNullable<typeof send>;
async function command(method: string, params: Record<string, unknown>, kind: string, request: ProbeSend = send!) {
  const entry = {probeCommandId: ++commandSequence, method, kind, startMs: performance.now() - started,
    ...(typeof params.expression === 'string' ? {expressionHash: createHash('sha256').update(params.expression).digest('hex')} : {})};
  commands.push(entry);
  try {return await request(method, params);}
  catch (error) {Object.assign(entry, {error: String(error)}); throw error;}
  finally {Object.assign(entry, {endMs: performance.now() - started});}
}
interface Evaluation {
  result?: {type?: string; subtype?: string; value?: unknown};
  exceptionDetails?: {text?: string; exception?: {description?: string}};
}
function evaluationValue<T>(result: Evaluation): T {
  if (result.exceptionDetails) throw new Error('PROBE_EVALUATION: ' +
    (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result?.value as T;
}
async function evaluateSync<T = unknown>(expression: string, kind = 'owner-sync'): Promise<T> {
  const result = await command('Runtime.evaluate', {expression, awaitPromise: false, returnByValue: true}, kind) as Evaluation;
  assert.notEqual(result.result?.subtype, 'promise', 'synchronous evaluation must not return a Promise');
  return evaluationValue<T>(result);
}
async function evaluateAsync<T = unknown>(expression: string, kind = 'owner-async'): Promise<T> {
  const slot = '__jobHubProbePromise' + ++promiseSequence;
  try {
    await evaluateSync(`globalThis[${JSON.stringify(slot)}]=Promise.resolve(${expression});void 0`, kind + '-pin');
    const result = await command('Runtime.evaluate', {expression: `globalThis[${JSON.stringify(slot)}]`,
      awaitPromise: true, returnByValue: true}, kind + '-await') as Evaluation;
    return evaluationValue<T>(result);
  } finally {
    await evaluateSync(`delete globalThis[${JSON.stringify(slot)}]`, kind + '-release')
      .catch(error => {observerErrors.push('Promise slot cleanup ' + String(error));});
  }
}
async function inside<T = unknown>(index: number, expression: string): Promise<T> {
  return evaluateSync<T>(frameExpression(index, expression), 'frame-sync-' + index);
}
async function insideAsync<T = unknown>(index: number, expression: string): Promise<T> {
  return evaluateAsync<T>(frameExpression(index, expression), 'frame-async-' + index);
}
async function telemetry(name: string) {
  if (!page) return;
  const value = await evaluateSync(`(()=>{
    const url=new URL(location.href);url.hash='';
    return {url:url.href,locale:document.documentElement.lang,status:document.querySelector('.hub-status')?.textContent,
      rows:[...document.querySelectorAll('.hub-list button')].map(button=>({jobId:button.dataset.jobId,selected:button.getAttribute('aria-pressed'),text:button.textContent})),
      frames:[...document.querySelectorAll('.hub-stage>iframe')].map(frame=>{
        const d=frame.contentDocument,w=frame.contentWindow,r=frame.getBoundingClientRect(),style=getComputedStyle(frame);
        const url=new URL(w.location.href);url.hash='';
        return {url:url.href,hidden:frame.hidden,display:style.display,visibility:style.visibility,width:r.width,height:r.height,
          locale:d.documentElement.lang,notice:d.querySelector('.job-notice')?.textContent,failed:d.querySelector('.job-notice')?.dataset.failed,
          hubVisible:d.body.dataset.hubVisible,rigElementCount:d.querySelectorAll('#rig-root img,#rig-root canvas').length,canvas:[...d.querySelectorAll('#rig-root canvas')].map(c=>({width:c.width,height:c.height})),
          time:d.querySelector('#job-time')?.value,part:d.querySelector('#job-part')?.value,
          runtime:w.__jobHubProbePlayer?{current:w.__jobHubProbePlayer.current,time:w.__jobHubProbePlayer.time,
            pausedDiagnostic:w.__jobHubProbePlayer.paused,renderer:w.__jobHubProbePlayer.renderer.constructor.name,
            mode:w.__jobHubProbePlayer.mode,backend:w.__jobHubProbePlayer.renderer.meshBackendActive??w.__jobHubProbePlayer.renderer.backendActive??null}:null};
      })};
  })()`);
  await networkReceipt('network-telemetry-' + name);
  await record('telemetry-' + name, {value, observerErrors, debugObservations, commands});
}
async function until(check: () => Promise<boolean> | boolean, name: string) {
  const deadline = Date.now() + 20000;
  try {
    while (Date.now() < deadline) {
      assert.deepEqual(observerErrors, [], 'CDP observer errors');
      if (await check()) return;
      await Bun.sleep(25);
    }
    throw new Error('JOB_HUB_BROWSER_WAIT ' + name);
  } catch (error) {await telemetry(name).catch(() => {}); throw error;}
}
async function wait(expression: string, name: string) {await until(() => evaluateSync<boolean>(expression), name);}
async function edit(index: number, selector: string, value: string) {
  await inside(index, `(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};
    node.dispatchEvent(new window.Event('input',{bubbles:true}));node.dispatchEvent(new window.Event('change',{bubbles:true}));})()`);
}
async function agent(index: number, verb: 'publish' | 'ask' | 'next' | 'close', value: Record<string, unknown>) {
  const job = jobs[index]!;
  const mutation = verb === 'next' ? {} : {expectedGeneration: generations[index] ?? 0, idempotencyKey: randomUUID()};
  const response = await fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + job.session.hostCredentials().agent},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: randomUUID(), verb, ...mutation, ...value})});
  const body = await response.json();
  assert.equal(body.schema, JOB_API_SCHEMA); assert.equal(body.ok, true, safe(body));
  generations[index] = body.generation;
  return body.value;
}
async function next(index: number) {return agent(index, 'next', {after: null, waitMs: 0});}
async function publish(index: number, alternate = false) {
  await next(index);
  const request = await inputs[index]!.publishRequest();
  assert.ok(request.verb === 'publish');
  const publication = await agent(index, 'publish', {result: alternate ? {path: 'out-next', selector: {kind: 'rig', version: 2}} : request.result,
    freeze: request.freeze}) as JobPublication;
  publications[index] = publication; return publication;
}
async function ask(index: number) {
  await next(index);
  const value = await agent(index, 'ask', {publicationId: publications[index]!.publicationId,
    subject: {kind: 'checkpoint', checkpointId: 'step-one'}}) as JobPendingAsk;
  asks[index] = value; return value;
}
async function register(index: number) {
  const input = inputs[index]!;
  const job = await hub!.openJob({root: input.root, fingerprint: 'f'.repeat(64),
    readPublished: async request => ({...input.getContext(), selector: request.result.path === 'out-next'
      ? {kind: 'rig' as const, version: 2} : {kind: 'rig' as const, version: 1}}), readerId: 'synthetic-hub-browser-reader/1',
    partsEnumerator: input.partsEnumerator, partsEnumeratorId: 'synthetic-hub-browser-parts/1',
    installWriterBinding: binding => {writerGrants.set(binding.jobId, binding.fetchCapability); secrets.add(binding.fetchCapability);},
    bindingId: 'synthetic-hub-browser-writer/1'});
  jobs[index] = job;
  for (const token of Object.values(job.session.hostCredentials())) secrets.add(token);
  return job;
}
async function ownerList(token = new URL(hub!.ownerUrl).hash.slice(5)) {
  const response = await fetch(hub!.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': token}});
  assert.equal(response.status, 200); return response.json();
}
function ownerURL() {const url = new URL(hub!.ownerUrl); url.searchParams.set('lang', language); return url.href;}
async function choose(index: number) {
  const id = jobs[index]!.session.jobId;
  await evaluateSync(`document.querySelector('.hub-list button[data-job-id="${id}"]').click()`);
  await wait(`document.querySelector('.hub-list button[data-job-id="${id}"]')?.getAttribute('aria-pressed')==='true' &&
    [...document.querySelectorAll('.hub-stage>iframe')].some(frame=>new URL(frame.src).pathname==='/jobs/${id}/'&&!frame.hidden)`, 'select-' + index);
}
async function ready(index: number) {
  const form = 'form[data-job-ask="' + asks[index]!.askId + '"]';
  await wait(frameExpression(index, `!!document.querySelector('#job-animation option[value=inspect]') &&
    !!document.querySelector(${JSON.stringify(form)}) && !document.querySelector(${JSON.stringify(form)}).querySelector('fieldset').disabled &&
    document.querySelector('.job-notice')?.dataset.failed==='false' &&
    document.querySelector('.job-notice')?.textContent.includes(${JSON.stringify(publications[index]!.label)}) && document.documentElement.lang===${JSON.stringify(language)}`), 'display-ack-' + index);
  const copy = await inside<{language: string; save: string | null; note: string | null}>(index, `(()=>{
    const form=document.querySelector(${JSON.stringify(form)});
    return {language:document.documentElement.lang,save:form.querySelector('button[type=submit]').textContent,
      note:form.querySelector('[data-job-text="interview.note"]').textContent};})()`);
  await record('localized-form-' + (index + 1), copy);
  assert.equal(copy.language, language); assert.equal(copy.save, catalog['job.saveCheckpoint']);
  assert.equal(copy.note, catalog['interview.note']);
  const jobId = jobs[index]!.session.jobId;
  await until(() => observers.has(jobId), 'observer-' + index);
  const observer = observers.get(jobId)!;
  const installed = await command('Debugger.setBreakpoint', {location: {scriptId: observer.scriptId, lineNumber: observer.line}},
    'one-shot-install-' + index) as {breakpointId: string};
  const arm = {id: installed.breakpointId, paused: false, captured: false, removed: false, resumed: false};
  breakpoints.set(observer.scriptId, arm);
  try {
    await edit(index, '#job-animation', 'inspect');
    await until(() => arm.captured && arm.removed && arm.resumed, 'one-shot-complete-' + index);
  } finally {
    if (!arm.removed) await command('Debugger.removeBreakpoint', {breakpointId: arm.id}, 'one-shot-finally-remove-' + index);
    if (arm.paused && !arm.resumed) await command('Debugger.resume', {}, 'one-shot-finally-resume-' + index);
    breakpoints.delete(observer.scriptId);
  }
  await wait(frameExpression(index, `!!window.__jobHubProbePlayer && window.__jobHubProbePlayer.current==='inspect' &&
    window.__jobHubProbePlayer.paused===true && [...document.querySelectorAll('#rig-root img,#rig-root canvas')].some(element=>{
      const rect=element.getBoundingClientRect(),style=window.getComputedStyle(element);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0&&
        (element.tagName==='IMG'?element.complete&&element.naturalWidth>0:element.width>0&&element.height>0);
    })`), 'drawn-rig-' + index);
}
async function snapshot(index: number) {
  return inside<any>(index, `(()=>{const view=JSON.parse(document.querySelector('#view-coordinates').textContent),p=window.__jobHubProbePlayer;
    return {cameras:{rig:{center:view.cameras.rig.center,zoom:view.cameras.rig.zoom},reference:{center:view.cameras.reference.center,zoom:view.cameras.reference.zoom}},
      sync:view.cameraSync,time:document.querySelector('#job-time').value,part:document.querySelector('#job-part').value,
      panel:document.querySelector('#job-panel').value,partObservation:JSON.parse(document.querySelector('#job-part-observation').textContent||'null'),
      current:p?.current,playerTime:p?.time,pausedDiagnostic:p?.paused,renderer:p?.renderer.constructor.name,mode:p?.mode,backend:p?.renderer.meshBackendActive??p?.renderer.backendActive??null};})()`);
}
async function paint(index: number, name: string) {
  const clip = await evaluateSync<{x: number; y: number; width: number; height: number}>(`(()=>{
    const frame=[...document.querySelectorAll('.hub-stage>iframe')].find(frame=>new URL(frame.src).pathname==='/jobs/${jobs[index]!.session.jobId}/');
    const f=frame.getBoundingClientRect(),d=frame.contentDocument,w=frame.contentWindow,v=d.querySelector('#rig-viewport').getBoundingClientRect();
    const views=[...d.querySelectorAll('#rig-root img,#rig-root canvas')].filter(element=>{
      const r=element.getBoundingClientRect(),style=w.getComputedStyle(element);
      return r.width>0&&r.height>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0;
    }).map(element=>element.getBoundingClientRect());
    const left=Math.ceil(Math.max(0,f.left,f.left+v.left,f.left+Math.min(...views.map(r=>r.left))));
    const top=Math.ceil(Math.max(0,f.top,f.top+v.top,f.top+Math.min(...views.map(r=>r.top))));
    const right=Math.floor(Math.min(innerWidth,f.right,f.left+v.right,f.left+Math.max(...views.map(r=>r.right))));
    const bottom=Math.floor(Math.min(innerHeight,f.bottom,f.top+v.bottom,f.top+Math.max(...views.map(r=>r.bottom))));
    return {x:left,y:top,width:right-left,height:bottom-top};})()`);
  await record(name + '-clip', clip); assert.ok(clip.width > 0 && clip.height > 0);
  await evaluateAsync('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', 'paint-compositor');
  const shownBytes = await page!.screenshot(clip), shown = PNG.sync.read(shownBytes);
  const previous = await inside<string>(index, `(()=>{const c=document.querySelector('#rig-root'),old=c.style.visibility;c.style.visibility='hidden';return old;})()`);
  let hidden: PNG;
  try {
    await evaluateAsync('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', 'paint-compositor');
    hidden = PNG.sync.read(await page!.screenshot(clip));
  } finally {await inside(index, `document.querySelector('#rig-root').style.visibility=${JSON.stringify(previous)}`);}
  let changedPixels = 0;
  for (let offset = 0; offset < shown.data.length; offset += 4) if (!shown.data.subarray(offset, offset + 4).equals(hidden!.data.subarray(offset, offset + 4))) changedPixels++;
  const runtime = await snapshot(index);
  const renderer = await inside(index, `(()=>{const r=window.__jobHubProbePlayer.renderer;return {
    mode:window.__jobHubProbePlayer.mode,kind:r.constructor.name,meshBackendActive:r.meshBackendActive??null,
    backendActive:r.backendActive??null,meshCount:r.meshCount??null,meshReuseCount:r.meshReuseCount??null,
    framesReused:r.framesReused??null,views:[...document.querySelectorAll('#rig-root img,#rig-root canvas')].map(element=>{
      const rect=element.getBoundingClientRect();return {tag:element.tagName,width:rect.width,height:rect.height};})};})()`);
  await record(name, {clip, changedPixels, runtime, renderer});
  assert.ok(changedPixels > 0, 'the actual rig renderer subtree contributes visible paint');
  assert.equal(runtime.pausedDiagnostic, true);
  assert.ok(['DomRenderer', 'CanvasRenderer'].includes(runtime.renderer));
  assert.ok(['canvas2d', 'webgl'].includes(runtime.backend));
  await writeFile(join(output, name + '.png'), shownBytes);
}
async function header() {
  const value = await evaluateSync<any>(`(()=>{const rect=selector=>{const el=document.querySelector(selector),r=el.getBoundingClientRect();
    return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};};
    const style=getComputedStyle(document.querySelector('.hub-header select'));
    return {rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),viewport:{width:innerWidth,height:innerHeight},
      titleText:document.querySelector('.hub-header h1').textContent,hintText:document.querySelector('.hub-status').textContent,
      languageAria:document.querySelector('.hub-header select').getAttribute('aria-label'),language:document.documentElement.lang,
      selectedLanguage:document.querySelector('.hub-header select').value,controlStyle:{minWidth:style.minWidth,maxWidth:style.maxWidth},
      header:rect('.hub-header'),title:rect('.hub-header h1'),hint:rect('.hub-status'),control:rect('.hub-header select')};})()`);
  await record('header-geometry', value);
  assert.equal(value.language, language); assert.equal(value.selectedLanguage, language); assert.equal(value.titleText, catalog['job.hubTitle']);
  assert.equal(value.hintText, catalog['job.hubHint']); assert.equal(value.languageAria, catalog['interview.language']);
  assert.ok(value.header.height > 0 && value.header.height <= 80);
  assert.ok(value.control.width >= value.rootFont * 6 && value.control.width <= value.rootFont * 12);
  assert.ok(value.control.height >= 24 && value.control.height <= 64);
  for (const name of ['title', 'hint', 'control']) {
    const r = value[name]; assert.ok(r.x >= 0 && r.right <= value.viewport.width && r.y >= 0 && r.bottom <= value.viewport.height);
    assert.ok(r.height > 0 && r.width > 0); assert.ok(r.scrollWidth <= r.clientWidth + 1);
  }
  assert.ok(value.title.right <= value.hint.x && value.hint.right <= value.control.x);
}
async function inventory(name: string) {
  const processes = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']); assert.equal(processes.exitCode, 0);
  const rows = processes.stdout.toString().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(row => ({pid: Number(row![1]), ppid: Number(row![2]), command: row![3]!}));
  const review = rows.filter(row => row.pid === process.pid || /(?:^|\/)bun\s/.test(row.command) &&
    (row.command.includes('tests/job-hub-browser.ts') || row.command.includes(scratch) && /job-(?:worker|front|hub)/.test(row.command)));
  const sockets = Bun.spawnSync(['lsof', '-nP', '-a', '-p', String(process.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']); assert.equal(sockets.exitCode, 0);
  const listeners = sockets.stdout.toString().split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  const chrome = rows.filter(row => row.command.includes(profile) && /chrome|chromium/.test(row.command)).map(row => row.pid);
  await record(name, {review, listeners, excludedOwnedChromePids: chrome, jobs: (await ownerList()).jobs.length,
    ownerURLWithoutCapability: hub!.ownerUrl.split('#')[0]});
  assert.deepEqual(review.map(row => row.pid), [process.pid]); assert.deepEqual(listeners, ['127.0.0.1:' + new URL(hub!.origin).port]);
}
async function drainMessages(index: number) {
  await evaluateAsync(`(()=>{const target=[...document.querySelectorAll('.hub-stage>iframe')].find(frame=>new URL(frame.src).pathname==='/jobs/${jobs[index]!.session.jobId}/').contentWindow;
    return new Promise(resolve=>{const id=${JSON.stringify(randomUUID())};const finish=event=>{if(event.data?.probeBarrier!==id)return;target.removeEventListener('message',finish);resolve();};
      target.addEventListener('message',finish);target.postMessage({probeBarrier:id},location.origin);});})()`);
}
async function visibilityNegatives() {
  const a = jobs[0]!.session.jobId, b = jobs[1]!.session.jobId, publication = publications[0]!;
  const binding = {schema: JOB_HUB_VISIBILITY, incarnation: new URL(hub!.ownerUrl).searchParams.get('workspace'), jobId: a,
    publicationId: publication.publicationId, sourceHash: publication.source.sourceHash, visible: true, language: language === 'en' ? 'ko' : 'en'};
  await inside(0, `(()=>{window.__hubInvalidVisibility=[];window.__hubInvalidObserver=new window.MutationObserver(()=>{
    if(document.body.dataset.hubVisible==='true'||document.documentElement.lang!==${JSON.stringify(language)})window.__hubInvalidVisibility.push({visible:document.body.dataset.hubVisible,language:document.documentElement.lang});});
    window.__hubInvalidObserver.observe(document.body,{attributes:true,attributeFilter:['data-hub-visible']});
    window.__hubInvalidObserver.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});})()`);
  const before = await snapshot(0);
  for (const change of [{incarnation: randomUUID()}, {jobId: b}, {publicationId: randomUUID()}, {sourceHash: '0'.repeat(64)}]) {
    await evaluateSync(`(()=>{const frame=[...document.querySelectorAll('.hub-stage>iframe')].find(frame=>new URL(frame.src).pathname==='/jobs/${a}/');
      frame.contentWindow.postMessage(${JSON.stringify({...binding, ...change})},location.origin);})()`);
  }
  const observer = observers.get(b)!;
  const wrongWindow = await command('Runtime.evaluate', {contextId: observer.contextId,
    expression: `parent.document.querySelector('iframe[src*="/jobs/${a}/"]').contentWindow.postMessage(${JSON.stringify(binding)},location.origin)`, awaitPromise: false, returnByValue: true}, 'wrong-sibling-sender') as {exceptionDetails?: unknown};
  assert.equal(wrongWindow.exceptionDetails, undefined);
  await inside(0, `window.dispatchEvent(new window.MessageEvent('message',{origin:'http://127.0.0.1:1',source:window.parent,data:${JSON.stringify(binding)}}))`);
  await drainMessages(0);
  const violations = await inside(0, `window.__hubInvalidObserver.disconnect(),window.__hubInvalidVisibility`);
  await record('visibility-negative-controls', {before, after: await snapshot(0), violations,
    cases: ['incarnation', 'job', 'publication', 'source hash', 'actual sibling sender window', 'synthetic wrong-origin envelope']});
  assert.deepEqual(violations, []); assert.deepEqual(await snapshot(0), before);
}
try {
  for (let index = 0; index < 10; index++) {
    const input = await jobFixture(); inputs.push(input);
    const packageRoot = join(input.root, 'out'), manifestPath = join(packageRoot, 'review.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.id = 'synthetic-hub-' + (index + 1); manifest.title = 'Synthetic hub job ' + (index + 1); manifest.revision = '1';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const modelPath = join(packageRoot, 'skeleton.model.json'), model = JSON.parse(await readFile(modelPath, 'utf8'));
    model.bones.find((bone: {name: string}) => bone.name === 'mesh').x += index;
    await writeFile(modelPath, JSON.stringify(model));
    const alternate = join(input.root, 'out-next'); await cp(packageRoot, alternate, {recursive: true});
    await writeFile(join(alternate, 'review.json'), JSON.stringify({...manifest, title: manifest.title + ' next', revision: '2'}));
    model.bones.find((bone: {name: string}) => bone.name === 'mesh').x += 11;
    await writeFile(join(alternate, 'skeleton.model.json'), JSON.stringify(model));
  }
  before = await Promise.all(inputs.map(input => jobInputHashes(input.root)));
  hub = await startJobHub({stateDir, reviewer: {id: 'declared-owner', role: 'owner'}});
  secrets.add(new URL(hub.ownerUrl).hash.slice(5));
  for (let index = 0; index < 9; index++) {await register(index); await publish(index); await ask(index);}
  const initial = await ownerList();
  await record('initial-nine', {jobs: initial.jobs, distinctJobIds: new Set(initial.jobs.map((job: {jobId: string}) => job.jobId)).size,
    writerGrantCount: writerGrants.size, generations});
  assert.equal(initial.jobs.length, 9); assert.equal(new Set(jobs.map(job => job.session.jobId)).size, 9);
  assert.deepEqual(initial.jobs.map((job: {pendingCount: number; generation: number}) => [job.pendingCount, job.generation]), Array.from({length: 9}, () => [1, 2]));
  await inventory('initial-process-listener');
  page = await launchCdpSession(profile, {async onEvent(event, request) {
    if (event.sessionId) send = request;
    networkEvent(event);
    if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params);
    if (event.method === 'Debugger.scriptParsed') {
      const parsed = event.params as {url: string; scriptId: string; executionContextId: number};
      const match = /\/jobs\/([^/]+)\/job\.js$/.exec(parsed.url);
      if (match) {
        try {
          const result = await command('Debugger.getScriptSource', {scriptId: parsed.scriptId}, 'passive-script-source', request) as {scriptSource: string};
          const lines = result.scriptSource.split('\n');
          const locations = lines.flatMap((line, lineNumber) => {
            const value = /\b(\w+)\.player\.pause\(\)/.exec(line);
            return value ? [{line: lineNumber, variable: value[1]!}] : [];
          });
          assert.equal(locations.length, 1, 'one frozen job pose pause boundary');
          const location = locations[0]!;
          scripts.set(parsed.scriptId, {jobId: match[1]!, variable: location.variable});
          observers.set(match[1]!, {contextId: parsed.executionContextId, scriptId: parsed.scriptId, line: location.line});
          debugObservations.push({jobId: match[1], scriptSHA256: createHash('sha256').update(result.scriptSource).digest('hex'),
            poseLine: location.line, variable: location.variable});
        } catch (error) {observerErrors.push(String(error));}
      }
    }
    if (event.method === 'Debugger.paused') {
      const frame = (event.params!.callFrames as {callFrameId: string; location: {scriptId: string}}[])[0]!;
      const boundary = scripts.get(frame.location.scriptId), arm = breakpoints.get(frame.location.scriptId);
      if (arm) arm.paused = true;
      debugObservations.push({phase: 'paused', jobId: boundary?.jobId, atMs: performance.now() - started});
      try {
        assert.ok(boundary && arm, 'only an explicitly armed one-shot may pause');
        const result = await command('Debugger.evaluateOnCallFrame', {callFrameId: frame.callFrameId,
          expression: `globalThis.__jobHubProbePlayer=${boundary.variable}.player;({renderer:${boundary.variable}.player.renderer.constructor.name})`,
          returnByValue: true}, 'one-shot-capture', request) as {exceptionDetails?: unknown};
        assert.equal(result.exceptionDetails, undefined, 'read-only pinned player observation');
        arm.captured = true;
        await command('Debugger.removeBreakpoint', {breakpointId: arm.id}, 'one-shot-remove', request);
        arm.removed = true;
      } catch (error) {observerErrors.push(String(error));}
      finally {
        await command('Debugger.resume', {}, 'one-shot-resume', request).then(() => {if (arm) arm.resumed = true;})
          .catch(error => {observerErrors.push(String(error));});
        debugObservations.push({phase: 'resumed', jobId: boundary?.jobId, atMs: performance.now() - started});
      }
    }
  }});
  await until(() => !!send, 'CDP-session');
  await command('Debugger.enable', {}, 'enable-observation'); await command('Network.enable', {}, 'enable-network');
  await page.setViewport(1440, 960); await page.goto(ownerURL(), language);
  await wait(`document.querySelectorAll('.hub-list button').length===9`, 'nine-owner-rows');
  await header();
  await evaluateSync('globalThis.__hubProbeOwnerDocument=document');
  for (let index = 0; index < 9; index++) {
    await choose(index); await ready(index);
    const publication = publications[index]!;
    const route = jobs[index]!.session.displayPublication(publication.publicationId).routes.apiBase + 'review';
    const identity = await insideAsync<any>(index, `(async()=>{const response=await window.fetch(${JSON.stringify(route)});const metadata=await response.json();
      return {status:response.status,id:metadata.manifest.id,revision:metadata.manifest.revision,sourceHash:metadata.sourceHash,
        modelHash:metadata.reviewedSource.rig?.sha256,rigElementCount:document.querySelectorAll('#rig-root img,#rig-root canvas').length,
        canvasCount:document.querySelectorAll('#rig-root canvas').length,imageCount:document.querySelectorAll('#rig-root img').length};})()`);
    await record('source-' + (index + 1), identity);
    assert.equal(identity.status, 200); assert.equal(identity.id, 'synthetic-hub-' + (index + 1));
    assert.equal(identity.sourceHash, publication.source.sourceHash);
    assert.equal(identity.modelHash, before[index]!['out/skeleton.model.json']); assert.ok(identity.rigElementCount > 0);
    await paint(index, 'rig-' + (index + 1));
  }
  await networkReceipt('network-positive-nine');
  await checkPositiveStreamBar('network-bar-nine');
  assert.ok([...networkRequests.values()].some(request => request.protocol === 'http/1.1'));
  assert.ok([...networkRequests.values()].filter(request => /\/events(?:\?|$)/.test(request.url)).every(request =>
    request.responseMs === undefined || request.protocol === 'http/1.1'), 'event streams are measured HTTP/1.1');
  await inventory('nine-render-process-listener');
  await choose(0);
  await edit(0, '#job-part', 'mesh'); await edit(0, '#job-animation', 'inspect'); await edit(0, '#job-time', '0.25'); await edit(0, '#job-panel', '4');
  const fitted = await snapshot(0);
  await inside(0, `(()=>{const sync=document.querySelector('#camera-sync');sync.checked=false;sync.dispatchEvent(new window.Event('change'));
    document.querySelector('#zoom-out').click();})()`);
  const words = '  synthetic unsaved human text\n원문 stays exact  ';
  const noteSelector = 'form[data-job-ask="' + asks[0]!.askId + '"] textarea[name=note]';
  await edit(0, noteSelector, words);
  await inside(0, 'window.__hubProbeFrameDocument=document');
  const retained = await snapshot(0);
  await record('retention-before', {fitted, retained, words});
  assert.notDeepEqual(retained.cameras, fitted.cameras); assert.equal(retained.time, '0.25'); assert.equal(retained.playerTime, 0.25);
  assert.equal(retained.part, 'mesh'); assert.equal(retained.panel, '4'); assert.ok(retained.partObservation?.drawn);
  assert.ok(retained.partObservation.activeAttachment); assert.equal(retained.pausedDiagnostic, true);
  await choose(1);
  await wait(frameExpression(0, `document.body.dataset.hubVisible==='false'`), 'inactive-pause');
  const inactive = await evaluateSync<any>(`(()=>{const frame=[...document.querySelectorAll('.hub-stage>iframe')].find(f=>new URL(f.src).pathname==='/jobs/${jobs[0]!.session.jobId}/');
    const r=frame.getBoundingClientRect(),s=getComputedStyle(frame),w=frame.contentWindow;
    return {hidden:frame.hidden,inert:frame.inert,display:s.display,visibility:s.visibility,width:r.width,height:r.height,
      childWidth:w.innerWidth,childHeight:w.innerHeight,pausedDiagnostic:w.__jobHubProbePlayer.paused,time:w.__jobHubProbePlayer.time};})()`);
  await record('inactive-geometry-pause', inactive);
  assert.equal(inactive.hidden, true); assert.equal(inactive.inert, true); assert.equal(inactive.display, 'block'); assert.equal(inactive.visibility, 'hidden');
  assert.ok(inactive.width > 0 && inactive.height > 0 && inactive.childWidth > 0 && inactive.childHeight > 0);
  assert.equal(inactive.pausedDiagnostic, true); assert.equal(inactive.time, 0.25);
  await visibilityNegatives();
  await choose(0); await wait(frameExpression(0, `document.body.dataset.hubVisible==='true'`), 'return-visible');
  const returned = await snapshot(0); await record('retention-after', returned);
  assert.deepEqual(returned, retained); assert.equal(await inside(0, `document.querySelector(${JSON.stringify(noteSelector)}).value`), words);
  assert.equal(await inside(0, 'window.__hubProbeFrameDocument===document'), true);
  await writeFile(join(output, 'owner-retention.png'), await page.screenshot());
  const acts: JobAct[] = [];
  for (let index = 0; index < 9; index++) {
    await choose(index);
    const form = 'form[data-job-ask="' + asks[index]!.askId + '"]';
    await wait(frameExpression(index, `!!document.querySelector(${JSON.stringify(form)})&&!document.querySelector(${JSON.stringify(form)}).querySelector('fieldset').disabled`), 'answer-form-' + index);
    const answerWords = index === 0 ? words : 'synthetic UI answer ' + (index + 1);
    await edit(index, form + ' select[name=outcome]', 'pass'); await edit(index, form + ' textarea[name=note]', answerWords);
    await inside(index, `document.querySelector(${JSON.stringify(form)}).querySelector('button[type=submit]').click()`);
    await wait(frameExpression(index, `document.querySelector(${JSON.stringify(form)}).querySelector('fieldset').disabled&&
      document.querySelector(${JSON.stringify(form)}).querySelector('[role=status]').textContent===${JSON.stringify(catalog['job.saved'])}`), 'answered-' + index);
    const events = await next(index);
    const act = events.events.find((event: {type: string; act?: JobAct}) => event.type === 'act' && event.act?.askId === asks[index]!.askId)?.act as JobAct;
    assert.ok(act); assert.equal(act.schema, JOB_ACT_SCHEMA); assert.equal(act.jobId, jobs[index]!.session.jobId);
    assert.ok(act.kind === 'checkpoint'); assert.equal(act.value.words, answerWords); assert.deepEqual(act.source, publications[index]!.source);
    assert.equal(act.authority.actor, 'human'); assert.equal(act.authority.channel, 'review-ui');
    const fetched: Response = await fetch(hub.origin + '/jobs/' + act.jobId + '/api', {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + writerGrants.get(act.jobId)},
      body: JSON.stringify({schema: JOB_API_SCHEMA, verb: 'fetch-act', jobId: act.jobId, actId: act.actId, requestId: randomUUID()})});
    const result: JobResult<JobAct> = await fetched.json(); assert.ok(result.ok); assert.deepEqual(result.value, act); acts.push(act);
    await record('human-act-' + (index + 1), act);
  }
  assert.equal(new Set(acts.map(act => act.actId)).size, 9); assert.deepEqual(generations.slice(0, 9), Array(9).fill(3));
  await choose(0);
  await next(8); await agent(8, 'close', {reason: 'synthetic close-one control'});
  await wait(`document.querySelector('.hub-list button[data-job-id="${jobs[8]!.session.jobId}"]').textContent.includes(${JSON.stringify(catalog['job.hubClosed'])})`, 'close-one-row');
  assert.equal(jobs[0]!.session.status().status, 'active'); assert.equal(jobs[1]!.session.status().status, 'active');
  await record('close-one', {closed: jobs[8]!.session.jobId, otherActive: jobs.filter((_, index) => index !== 8).map(job => job.session.status().jobId)});
  await register(9); await publish(9); await ask(9);
  await wait(`document.querySelectorAll('.hub-list button').length===10`, 'tenth-row');
  assert.equal(await evaluateSync(`document.querySelector('.hub-list button[data-job-id="${jobs[0]!.session.jobId}"]').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluateSync('globalThis.__hubProbeOwnerDocument===document'), true);
  await choose(9); await ready(9); await paint(9, 'rig-10');
  await record('tenth-target', {rows: 10, noReload: true, selectionRetainedOnAdd: true,
    mounted: await evaluateSync(`document.querySelectorAll('.hub-stage>iframe').length`)});
  await ask(0); await ask(1);
  const unaffected = jobs[1]!.session.status(), prior = publications[0]!;
  await publish(0, true);
  assert.deepEqual(jobs[1]!.session.status(), unaffected); assert.equal(jobs[0]!.session.status().pending.length, 0);
  await ask(0); await choose(0); await ready(0);
  assert.notEqual(publications[0]!.source.sourceHash, prior.source.sourceHash);
  const changed = await insideAsync<any>(0, `(async()=>{const response=await window.fetch(${JSON.stringify(jobs[0]!.session.displayPublication(publications[0]!.publicationId).routes.apiBase + 'review')});return response.json();})()`);
  assert.equal(changed.sourceHash, publications[0]!.source.sourceHash); assert.equal(changed.reviewedSource.rig.sha256, before[0]!['out-next/skeleton.model.json']);
  await record('one-job-publication', {previous: prior, current: publications[0], otherPendingUnchanged: unaffected});
  await inventory('ten-process-listener');
  const activeIndices = [0, 1, 2, 3, 4, 5, 6, 7, 9];
  const oldOwner = new URL(hub.ownerUrl), oldIds = activeIndices.map(index => jobs[index]!.session.jobId);
  const oldWriterGrants = oldIds.map(id => writerGrants.get(id));
  const oldStatuses = activeIndices.map(index => jobs[index]!.session.status());
  await evaluateSync('globalThis.__hubProbeRestartDocument=document');
  await hub.stop();
  hub = await startJobHub({stateDir, port: Number(oldOwner.port), reviewer: {id: 'declared-owner', role: 'owner'}});
  secrets.add(new URL(hub.ownerUrl).hash.slice(5));
  for (const index of activeIndices) await register(index);
  assert.deepEqual(activeIndices.map(index => jobs[index]!.session.jobId), oldIds);
  assert.deepEqual(oldIds.map(id => writerGrants.get(id)), oldWriterGrants);
  assert.deepEqual(activeIndices.map(index => jobs[index]!.session.status()), oldStatuses);
  const freshOwner = new URL(hub.ownerUrl);
  assert.equal(freshOwner.origin, oldOwner.origin); assert.notEqual(freshOwner.search, oldOwner.search); assert.notEqual(freshOwner.hash, oldOwner.hash);
  const stale = await fetch(hub.origin + '/hub/api/jobs', {headers: {'X-Review-Capability': oldOwner.hash.slice(5)}});
  assert.equal(stale.status, 403); await stale.body?.cancel();
  let loaderId: string | undefined;
  await page.goto(ownerURL(), language, navigation => {loaderId = navigation.loaderId;});
  await wait(`document.querySelectorAll('.hub-list button').length===9`, 'restart-nine-rows');
  assert.ok(loaderId); assert.equal(await evaluateSync('globalThis.__hubProbeRestartDocument===undefined'), true);
  const list = await ownerList(); assert.deepEqual(list.jobs.map((job: {jobId: string}) => job.jobId), oldIds);
  assert.equal(list.jobs[0].publication.sourceHash, publications[0]!.source.sourceHash);
  await choose(0); await ready(0); await paint(0, 'restart-rig');
  await record('same-tab-restart', {loaderId, documentReplaced: true, hubGrantRotated: true, staleGrantStatus: 403,
    activeJobIdsRetained: oldIds, writerGrantsRetained: true, statusesRetained: true, freshSource: list.jobs[0].publication});
  await inventory('restart-process-listener');
  await writeFile(join(output, 'owner-final.png'), await page.screenshot());
  await networkReceipt('network-positive-complete');
  await checkPositiveStreamBar('network-bar-complete');
  networkPhase = 'planted-drain';
  // Only after all retained-frame positive gates: destroy owned frame documents to stop normal subscriptions.
  await evaluateSync(`(()=>{for(const frame of document.querySelectorAll('.hub-stage>iframe'))frame.remove();})()`);
  await until(() => activeStreams().length === 0, 'planted-normal-streams-drained');
  await networkReceipt('network-planted-baseline');
  networkPhase = 'planted-hold-six';
  const controlRoute = '/jobs/' + jobs[0]!.session.jobId + '/events';
  const controlCapability = jobs[0]!.session.hostCredentials().ui;
  try {
    await evaluateSync(`(()=>{
      const state={controllers:[],responses:[],errors:[],headers:0,seventh:{done:false}};
      globalThis.__hubNetworkControl=state;
      for(let index=0;index<6;index++){
        const controller=new AbortController();state.controllers.push(controller);
        window.fetch(${JSON.stringify(controlRoute)},{cache:'no-store',signal:controller.signal,
          headers:{'X-Review-Capability':${JSON.stringify(controlCapability)},'X-Probe-Request':'held-'+index}})
          .then(response=>{state.responses.push(response);state.headers++;})
          .catch(error=>{state.errors.push(String(error));});
      }
    })()`);
    await wait('globalThis.__hubNetworkControl.headers===6', 'six-held-response-headers');
    await until(() => confirmedStreams().length === 6, 'six-real-live-event-streams');
    await networkReceipt('network-held-six');
    assert.equal(activeStreams().length, 6);
    assert.ok(confirmedStreams().every(request => request.protocol === 'http/1.1' && request.status === 200));
    assert.equal(new Set(confirmedStreams().map(request => request.connectionId)).size, 6);
    networkPhase = 'planted-block-seven';
    await evaluateSync(`(()=>{
      const state=globalThis.__hubNetworkControl,controller=new AbortController();state.controllers.push(controller);
      state.seventh.started=performance.now();
      window.fetch('/hub/api/jobs',{cache:'no-store',signal:controller.signal,
        headers:{'X-Review-Capability':${JSON.stringify(new URL(hub.ownerUrl).hash.slice(5))},'X-Probe-Request':'seventh'}})
        .then(async response=>{state.seventh.status=response.status;state.seventh.body=await response.json();state.seventh.done=true;state.seventh.finished=performance.now();})
        .catch(error=>{state.seventh.error=String(error);state.seventh.done=true;});
    })()`);
    // A declared 750ms negative-control observation window, never a positive readiness delay.
    await Bun.sleep(750);
    const blocked = await evaluateSync<{done: boolean; elapsedMs: number}>(`(()=>{const state=globalThis.__hubNetworkControl;
      return {done:state.seventh.done,elapsedMs:performance.now()-state.seventh.started};})()`);
    await networkReceipt('network-seventh-blocked');
    await record('planted-seventh-pending', blocked);
    assert.equal(blocked.done, false); assert.ok(blocked.elapsedMs >= 750);
    networkPhase = 'planted-release-one';
    await evaluateSync('globalThis.__hubNetworkControl.controllers[0].abort()');
    await wait('globalThis.__hubNetworkControl.seventh.done', 'seventh-completes-after-one-release');
    const completed = await evaluateSync<{status: number; error?: string; jobs: number; elapsedMs: number}>(`(()=>{
      const value=globalThis.__hubNetworkControl.seventh;
      return {status:value.status,error:value.error,jobs:value.body?.jobs?.length,elapsedMs:value.finished-value.started};})()`);
    await networkReceipt('network-seventh-resumed');
    await record('planted-seventh-completed', completed);
    assert.equal(completed.status, 200); assert.equal(completed.error, undefined); assert.equal(completed.jobs, 9);
  } finally {
    await evaluateSync(`(()=>{const state=globalThis.__hubNetworkControl;
      for(const controller of state?.controllers??[])controller.abort();
      for(const response of state?.responses??[])void response.body?.cancel().catch(()=>{});
      delete globalThis.__hubNetworkControl;
    })()`);
    await until(() => activeStreams().length === 0, 'planted-all-streams-drained');
    await networkReceipt('network-planted-cleanup');
  }

  assert.deepEqual(await Promise.all(inputs.map(input => jobInputHashes(input.root))), before);
  assert.deepEqual(exceptions, []); assert.deepEqual(observerErrors, []);
  await record('verdict', {status: 'PASS', language, elapsedMs: performance.now() - started, registeredInitial: 9,
    actualPaints: 11, independentUIActsFetched: acts.length, inputHashesUnchanged: true,
    pausedBoundary: 'read-only pinned Play instance diagnostic, paused is an internal field; renderer/backend/time are public observations',
    capacityBoundary: '10 mounted frames inspected; application32/+1 belongs to prior backend proof; no hardware capacity claim'});
} catch (error) {
  await telemetry('failure').catch(() => {});
  if (page) await writeFile(join(output, 'failure.png'), await page.screenshot()).catch(() => {});
  await record('verdict', {status: 'RED', error: error instanceof Error ? error.stack : String(error), elapsedMs: performance.now() - started});
  throw error;
} finally {
  await writeFile(join(output, 'browser-exceptions.json'), safe({exceptions, observerErrors, debugObservations}));
  await writeFile(join(output, 'cdp-commands.json'), safe(commands));
  await networkReceipt('network-final');
  if (before) await record('final-input-immutability', {unchanged: JSON.stringify(await Promise.all(inputs.map(input => jobInputHashes(input.root)))) === JSON.stringify(before)});
  await page?.close(); await hub?.stop();
  const processes = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']);
  const ownedChrome = processes.stdout.toString().split('\n').filter(line => line.includes(profile) && /chrome|chromium/.test(line));
  for (const line of ownedChrome) {
    const pid = Number(line.trim().split(/\s+/)[0]);
    try {process.kill(pid, 'SIGTERM');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
  }
  const deadline = Date.now() + 5000;
  let remaining: string[] = [];
  do {
    remaining = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']).stdout.toString().split('\n').filter(line => line.includes(profile) && /chrome|chromium/.test(line));
    if (remaining.length) await Bun.sleep(25);
  } while (remaining.length && Date.now() < deadline);
  await record('cleanup', {ownedChromeRemaining: remaining.length,
    descriptorRemoved: !await Bun.file(join(stateDir, 'job-hub/host.json')).exists()});
  assert.equal(remaining.length, 0);
  for (const input of inputs) await input.close();
  await rm(scratch, {recursive: true, force: true});
}
