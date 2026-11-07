/** Ordinary Nova sample. Synthetic inputs and answers travel through the normal two-job hub UI. */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {startJobHub, assertJobImageSetCapability, JOB_API_SCHEMA, JOB_ACT_SCHEMA,
  type JobOwnerHub, type JobHubJob, type JobPublication, type JobPendingAsk,
  type JobAct, type JobPublishedContext, type JobImageSetInput} from '@rig-c/review/job-host';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {JOB_HUB_VISIBILITY} from '../web/job-hub.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const argument = (key: string) => {const index = Bun.argv.indexOf(key); return index < 0 ? undefined : Bun.argv[index + 1];};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = argument('--out') ?? 'evidence/job-image-set-' + language;
await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-images-'));
const profile = join(scratch, 'chrome'), stateDir = join(scratch, 'state');
const inputs: Awaited<ReturnType<typeof jobFixture>>[] = [];
const jobs: JobHubJob[] = [];
const grants = new Map<string, string>(), generations: number[] = [];
const observations: Record<string, unknown> = {}, exceptions: unknown[] = [], observerErrors: string[] = [];
const acknowledgments: {publicationId: string; body: unknown; visual: any; screenshot: string; atMs: number}[] = [];
const uiSubmissions: {jobId: string; body: any; atMs: number}[] = [];
const secrets = new Set<string>();
const imageRequests = new Map<string, Set<number>>();
const colors = [[220, 36, 36, 255], [36, 80, 220, 255], [36, 180, 70, 255]];
const names = ['원본 Source', 'Candidate 후보', 'Reference 참조', 'Twin 후보'];
const words = '  Overall EN 검토\n  ';
const candidateWords = '  Keep this 후보\n원본 그대로  ';
const referenceWords = ' \n메모 reference  ';
const retainedWords = '  retain old draft 교체  ';
const started = performance.now();
let hub: JobOwnerHub | undefined, page: InputCdpSession | undefined;
let control: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
let hashFailurePublication: string | null = null;
let before: Record<string, string>[] | undefined;
let failure: unknown;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function safe(value: unknown) {
  let text = JSON.stringify(value, (key, value) => /^(displayedNonce|capability|fetchCapability|agentCapability)$/.test(key)
    ? '<redacted>' : value, 2).replace(/#cap=[^\s'"<>]+/g, '#cap=<redacted>');
  for (const secret of secrets) text = text.replaceAll(secret, '<redacted>');
  return text;
}
async function record(name: string, value: unknown) {
  observations[name] = value;
  await writeFile(join(output, 'observations.json'), safe(observations));
  console.log('image-set ' + language.toUpperCase() + ' ' + name);
}
function frame(index: number, expression: string) {
  return `(()=>{const owner=[...document.querySelectorAll('.hub-stage>iframe')].find(element=>
    new URL(element.src).pathname===${JSON.stringify('/jobs/' + jobs[index]!.session.jobId + '/')});
    if(!owner||!owner.contentDocument)return null;
    return (function(window,document,owner){return (${expression});})(owner.contentWindow,owner.contentDocument,owner);})()`;
}
async function inside<T = any>(index: number, expression: string): Promise<T> {return page!.evaluate<T>(frame(index, expression));}
async function diagnostic(name: string) {
  if (!page) return;
  await record(name, await page.evaluate(`(()=>({locale:document.documentElement.lang,status:document.querySelector('.hub-status')?.textContent,
    jobs:[...document.querySelectorAll('.hub-list button')].map(button=>({id:button.dataset.jobId,text:button.textContent,selected:button.getAttribute('aria-pressed')})),
    frames:[...document.querySelectorAll('.hub-stage>iframe')].map(owner=>({path:new URL(owner.src).pathname,hidden:owner.hidden,
      visible:owner.contentDocument?.body.dataset.hubVisible,notice:owner.contentDocument?.querySelector('.job-notice')?.textContent,
      failed:owner.contentDocument?.querySelector('.job-notice')?.dataset.failed,body:owner.contentDocument?.body.innerText}))}))()`));
}
async function until(check: () => Promise<boolean> | boolean, name: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  await diagnostic('timeout-' + name);
  throw new Error('IMAGE_SET_BROWSER_WAIT ' + name);
}
async function agent(index: number, verb: string, value: Record<string, unknown>, expectedError?: string) {
  const job = jobs[index]!;
  const response = await fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + job.session.hostCredentials().agent},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: randomUUID(), verb,
      ...(verb === 'next' ? {} : {expectedGeneration: generations[index] ?? 0, idempotencyKey: randomUUID()}), ...value})});
  const body = await response.json();
  generations[index] = body.generation;
  await record('agent-' + index + '-' + verb + '-' + Object.keys(observations).length, {status: response.status, body});
  assert.equal(body.schema, JOB_API_SCHEMA);
  if (expectedError) {assert.equal(body.ok, false); assert.equal(body.error.code, expectedError);}
  else {assert.equal(response.status, 200); assert.equal(body.ok, true);}
  return body.value;
}
async function next(index: number) {return agent(index, 'next', {after: null, waitMs: 0});}
async function publish(index: number, resultPath = 'out', recordPath = 'record.json') {
  const input = inputs[index]!;
  const selector = index ? input.getContext().selector : null;
  const publication = await agent(index, 'publish', {result: {path: resultPath, selector}, freeze: {
    kind: 'producer-held', holdId: 'synthetic-held-' + resultPath,
    record: {path: recordPath, sha256: hash(await readFile(join(input.root, recordPath)))}}}) as JobPublication;
  return publication;
}
async function ask(index: number, publication: JobPublication) {
  const discovery = await next(index);
  if (!index) assertJobImageSetCapability(discovery.capabilities);
  return agent(index, 'ask', {publicationId: publication.publicationId,
    subject: {kind: 'review-verdict', stage: index ? 'rig-review' : 'image-review'}}) as Promise<JobPendingAsk>;
}
async function select(index: number) {
  await until(() => page!.evaluate<boolean>(`!!document.querySelector('.hub-list button[data-job-id="${jobs[index]!.session.jobId}"]')`), 'hub-row-' + index);
  await page!.evaluate(`document.querySelector('.hub-list button[data-job-id="${jobs[index]!.session.jobId}"]').click()`);
  await until(() => inside<boolean>(index, `!owner.hidden&&document.body.dataset.hubVisible==='true'&&document.documentElement.lang===${JSON.stringify(language)}`), 'selected-' + index);
}
async function ready(index: number, publication: JobPublication, ask: JobPendingAsk) {
  await until(() => inside<boolean>(index, `document.querySelector('.job-notice')?.dataset.failed==='false'&&
    document.querySelector('.job-notice')?.textContent.includes(${JSON.stringify(publication.label)})&&
    !!document.querySelector('form[data-job-ask="${ask.askId}"]')&&!document.querySelector('form[data-job-ask="${ask.askId}"]>fieldset').disabled`), 'ready-' + publication.publicationId);
}
async function edit(index: number, ask: JobPendingAsk, name: string, value: string) {
  await inside(index, `(()=>{const input=document.querySelector('form[data-job-ask="${ask.askId}"] [name="${name}"]');
    input.value=${JSON.stringify(value)};input.dispatchEvent(new window.Event('input',{bubbles:true}));
    input.dispatchEvent(new window.Event('change',{bubbles:true}));})()`);
}
async function submitAndFetch(index: number, ask: JobPendingAsk) {
  await inside(index, `document.querySelector('form[data-job-ask="${ask.askId}"] button[type="submit"]').click()`);
  let act: JobAct | undefined;
  await until(async () => {
    const value = await next(index);
    act = value.events.find((event: {type: string; act?: JobAct}) => event.type === 'act' && event.act?.askId === ask.askId)?.act;
    return !!act;
  }, 'ui-act-' + ask.askId);
  await record('human-ui-act-' + ask.askId, {act, matchingUIRequests: uiSubmissions.filter(entry => entry.body.askId === ask.askId)});
  assert.ok(uiSubmissions.some(entry => entry.body.askId === ask.askId));
  assert.equal(act!.authority.actor, 'human'); assert.equal(act!.authority.channel, 'review-ui');
  assert.equal(act!.schema, JOB_ACT_SCHEMA);
  const job = jobs[index]!;
  const response = await fetch(job.origin + '/jobs/' + job.session.jobId + '/api', {method: 'POST',
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + grants.get(job.session.jobId)},
    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: job.session.jobId, requestId: randomUUID(), verb: 'fetch-act', actId: act!.actId})});
  const fetched = await response.json();
  await record('consumer-fetch-' + ask.askId, {status: response.status, body: fetched});
  assert.equal(response.status, 200); assert.equal(fetched.schema, JOB_API_SCHEMA); assert.deepEqual(fetched.value, act);
  return act!;
}
async function imageSnapshot() {
  return inside(0, `(()=>({locale:document.documentElement.lang,visible:document.body.dataset.hubVisible,hidden:owner.hidden,
    source:JSON.parse(document.querySelector('.job-sidebar details pre').textContent),
    digest:document.querySelector('.job-stage>p code')?.textContent,
    rows:[...document.querySelectorAll('[data-job-image-set]>figure')].map(figure=>{const image=figure.querySelector('img'),r=image.getBoundingClientRect(),f=owner.getBoundingClientRect();
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;canvas.getContext('2d').drawImage(image,0,0,1,1);
      return {name:figure.dataset.imageName,role:figure.querySelector('p')?.textContent,hash:figure.querySelector('code')?.textContent,
        duplicate:figure.textContent.includes(${JSON.stringify(catalog['job.identicalImages'])}),decoded:image.complete&&image.naturalWidth>0,
        x:r.left,y:r.top,width:r.width,height:r.height,centerX:f.left+r.left+r.width/2,centerY:f.top+r.top+r.height/2,
        decodedPixel:[...canvas.getContext('2d').getImageData(0,0,1,1).data]};})}))()`);
}
async function verifyPaint(publication: JobPublication, name: string) {
  const value = await imageSnapshot();
  const screenshot = await page!.screenshot();
  await writeFile(join(output, name + '.png'), screenshot);
  const pixels = PNG.sync.read(screenshot);
  const painted = value.rows.map((row: {centerX: number; centerY: number}) => {
    const x = Math.floor(row.centerX), y = Math.floor(row.centerY);
    return {x, y, rgba: [...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4)]};
  });
  const ack = acknowledgments.find(entry => entry.publicationId === publication.publicationId);
  const beforeAck = ack ? PNG.sync.read(await readFile(join(output, ack.screenshot))) : null;
  const beforeAckPainted = beforeAck ? ack!.visual.rows.map((row: {centerX: number; centerY: number}) => {
    const x = Math.floor(row.centerX), y = Math.floor(row.centerY);
    return [...beforeAck.data.subarray((y * beforeAck.width + x) * 4, (y * beforeAck.width + x) * 4 + 4)];
  }) : null;
  await record(name, {value, painted, beforeAckPainted, screenshot: name + '.png', screenshotSha256: hash(screenshot), acknowledgments});
  assert.deepEqual(value.source, publication.source); assert.equal(value.source.subject, 'image-set');
  assert.equal(Object.hasOwn(value.source, 'model'), false); assert.equal(Object.hasOwn(value.source, 'selector'), false);
  assert.equal(value.digest, value.source.imageSetDigest); assert.deepEqual(value.rows.map((row: {name: string}) => row.name), names);
  assert.deepEqual(value.rows.map((row: {role: string}) => row.role), [catalog['job.imageRole.source'],
    catalog['job.imageRole.candidate'], catalog['job.imageRole.reference'], catalog['job.imageRole.candidate']]);
  assert.deepEqual(value.rows.map((row: {hash: string}) => row.hash), value.source.imageSet.images.map((image: {sha256: string}) => image.sha256));
  assert.equal(value.digest, hash(JSON.stringify(value.source.imageSet.images.map(({role, name, sha256}: {role: string; name: string; sha256: string}) => ({role, name, sha256})))));
  assert.deepEqual(value.source.duplicateHashes, [{names: [names[1], names[3]], sha256: value.source.imageSet.images[1].sha256}]);
  assert.deepEqual(value.rows.map((row: {duplicate: boolean}) => row.duplicate), [false, true, false, true]);
  assert.deepEqual(value.rows.map((row: {decodedPixel: number[]}) => row.decodedPixel), [colors[0], colors[1], colors[2], colors[1]]);
  assert.deepEqual(painted.map((row: {rgba: number[]}) => row.rgba), [colors[0], colors[1], colors[2], colors[1]]);
  assert.ok(value.rows.every((row: {decoded: boolean; width: number; height: number}) => row.decoded && row.width > 0 && row.height > 0));
  assert.ok(value.rows.every((row: {x: number}, index: number) => !index || row.x > value.rows[index - 1].x));
  assert.deepEqual(beforeAckPainted, [colors[0], colors[1], colors[2], colors[1]]);
  assert.ok(ack);
  assert.equal((ack.body as {sourceHash: string}).sourceHash, publication.source.sourceHash);
  assert.deepEqual(ack.visual.source, publication.source); assert.equal(ack.visual.rows.length, 4); assert.ok(ack.visual.rows.every((row: {decoded: boolean}) => row.decoded));
}
async function failedPublication(publication: JobPublication, ask: JobPendingAsk, name: string) {
  await until(async () => imageRequests.get(publication.publicationId)?.size === 4 &&
    await inside<boolean>(0, `document.querySelector('.job-notice')?.dataset.failed==='true'`), name);
  const value = await inside(0, `(()=>({notice:document.querySelector('.job-notice').textContent,
    candidateForm:!!document.querySelector('form[data-job-ask="${ask.askId}"]'),
    enabledForms:[...document.querySelectorAll('[data-job-forms] form>fieldset')].filter(fields=>!fields.disabled).length,
    draft:document.querySelector('textarea[name="note"]')?.value,
    source:JSON.parse(document.querySelector('.job-sidebar details pre').textContent)}))()`);
  await record(name, {publication, ask, value, imageRowsRequested: [...imageRequests.get(publication.publicationId) ?? []], ackCount: acknowledgments.filter(entry => entry.publicationId === publication.publicationId).length});
  assert.equal(acknowledgments.filter(entry => entry.publicationId === publication.publicationId).length, 0);
  assert.equal(value.candidateForm, false); assert.equal(value.enabledForms, 0); assert.equal(value.draft, retainedWords);
}

try {
  inputs.push(await jobFixture(), await jobFixture());
  const imageInput = inputs[0]!, contexts = new Map<string, JobPublishedContext>();
  await mkdir(join(imageInput.root, 'plates'));
  const images: JobImageSetInput['images'][number][] = [];
  for (let index = 0; index < 4; index++) {
    const png = new PNG({width: 128, height: 96}), color = colors[index === 3 ? 1 : index]!;
    for (let offset = 0; offset < png.data.length; offset += 4) png.data.set(color, offset);
    const bytes = PNG.sync.write(png), path = 'plates/image-' + index + '.png';
    await writeFile(join(imageInput.root, path), bytes);
    images.push({role: index === 0 ? 'source' : index === 2 ? 'reference' : 'candidate', name: names[index]!, path, sha256: hash(bytes)});
  }
  await writeFile(join(imageInput.root, 'plates/decode-failure.png'), 'declared synthetic undecodable image bytes');
  for (const phase of ['out', 'out-next', 'out-hash', 'out-decode', 'out-recovery']) {
    const index = ['out', 'out-next', 'out-hash', 'out-decode', 'out-recovery'].indexOf(phase);
    await mkdir(join(imageInput.root, phase), {recursive: true});
    await writeFile(join(imageInput.root, phase, 'review.json'), JSON.stringify({schema: 'rig-review/1',
      id: 'synthetic-image-set', title: 'Synthetic image comparison ' + (index + 1), revision: String(index + 1), references: []}));
    const recordPath = phase + '-record.json';
    await writeFile(join(imageInput.root, recordPath), JSON.stringify({syntheticPublication: phase}));
    contexts.set(recordPath, {selector: null, plan: null, parts: null, subjects: [], partIds: [], files: [],
      imageSet: {purpose: 'plate-adoption', images: phase === 'out-decode' ? images.map((image, row) => row === 1
        ? {role: image.role, name: image.name, path: 'plates/decode-failure.png'} : image) : images}});
  }
  before = await Promise.all(inputs.map(input => jobInputHashes(input.root)));
  hub = await startJobHub({stateDir, reviewer: {id: 'declared-owner', role: 'owner'}, port: 0});
  secrets.add(new URL(hub.ownerUrl).hash.slice(5));
  for (const [index, input] of inputs.entries()) {
    const job = await hub.openJob({root: input.root, fingerprint: 'f'.repeat(64),
      readerId: index ? 'synthetic-model-reader/1' : 'synthetic-image-reader/1',
      readPublished: async ({record}) => {
        const context = index ? input.getContext() : contexts.get(record.path);
        if (!context) throw new Error('Undeclared synthetic publication');
        return context;
      }, bindingId: 'synthetic-image-probe-writer/1',
      installWriterBinding: binding => {grants.set(binding.jobId, binding.fetchCapability); secrets.add(binding.fetchCapability);}});
    jobs.push(job); for (const secret of Object.values(job.session.hostCredentials())) secrets.add(secret);
  }
  const first = await publish(0, 'out', 'out-record.json'), imageAsk = await ask(0, first);
  const model = await publish(1), modelAsk = await ask(1, model);
  await record('setup', {language, jobs: jobs.map(job => job.session.jobId), colors, names, modelSource: model.source,
    contractOldSha256: '03992407a81719c782905855c7d4c6b1795e86103f597f70ee4aeb9218fe65b5',
    contractNewSha256: hash(await readFile(new URL('../src/job-contract.ts', import.meta.url)))});
  page = await launchCdpSession(profile, {sendDeadlineMs: 20000, async onEvent(event, send) {
    if (event.sessionId) control = send;
    if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params);
    if (event.method !== 'Fetch.requestPaused') return;
    const requestId = event.params!.requestId, request = event.params!.request as {url: string; postData?: string};
    try {
      const imageRequest = /\/publications\/([^/]+)\/instances\/[^/]+\/api\/image-set\/(\d+)$/.exec(request.url);
      if (imageRequest) {
        const rows = imageRequests.get(imageRequest[1]!) ?? new Set<number>();
        rows.add(Number(imageRequest[2])); imageRequests.set(imageRequest[1]!, rows);
        await record('image-request-' + imageRequest[1] + '-' + imageRequest[2], {url: request.url});
      }
      if (hashFailurePublication === 'pending' && request.url.includes('/jobs/' + jobs[0]!.session.jobId + '/') &&
          request.url.endsWith('/api/review')) {
        hashFailurePublication = request.url.split('/publications/')[1]!.split('/')[0]!;
        await record('hash-control-bound-to-publication', {publicationId: hashFailurePublication, url: request.url});
      }
      if (request.url.includes('/publications/' + hashFailurePublication + '/') && request.url.endsWith('/api/image-set/1')) {
        hashFailurePublication = null;
        const wrongBytes = await readFile(join(inputs[0]!.root, 'plates/image-0.png'));
        await record('injected-image-hash-mismatch', {url: request.url, actualBodySha256: hash(wrongBytes)});
        await send('Fetch.fulfillRequest', {requestId, responseCode: 200,
          responseHeaders: [{name: 'Content-Type', value: 'image/png'}], body: wrongBytes.toString('base64')});
        return;
      }
      if (request.url.endsWith('/ui/displayed')) {
        const body = JSON.parse(request.postData ?? '{}');
        const index = request.url.includes('/jobs/' + jobs[0]!.session.jobId + '/') ? 0 : 1;
        const visual = index ? await inside(1, `({source:JSON.parse(document.querySelector('.job-sidebar details pre').textContent)})`) : await imageSnapshot();
        const screenshot = 'before-ack-' + body.publicationId + '.png';
        await writeFile(join(output, screenshot), await page!.screenshot());
        acknowledgments.push({publicationId: body.publicationId, body, visual, screenshot, atMs: performance.now() - started});
        await record('before-display-ack-' + body.publicationId, acknowledgments.at(-1));
      }
      if (request.url.endsWith('/ui/acts')) {
        const body = JSON.parse(request.postData ?? '{}');
        uiSubmissions.push({jobId: request.url.split('/jobs/')[1]!.split('/')[0]!, body, atMs: performance.now() - started});
        await record('normal-form-request-' + uiSubmissions.length, uiSubmissions.at(-1));
      }
    } catch (error) {
      observerErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
      await record('observer-error', {observerErrors, url: request.url});
    }
    await send('Fetch.continueRequest', {requestId});
  }});
  await page.setViewport(1920, 1080);
  await until(() => !!control, 'cdp-control');
  await control!('Network.enable');
  await control!('Fetch.enable', {patterns: [
    {urlPattern: hub.origin + '/jobs/*/publications/*/instances/*/api/image-set/*'},
    {urlPattern: hub.origin + '/jobs/*/ui/displayed'}, {urlPattern: hub.origin + '/jobs/*/ui/acts'}]});
  const owner = new URL(hub.ownerUrl); owner.searchParams.set('lang', language);
  await page.goto(owner.href, language);
  await select(0); await ready(0, first, imageAsk); await verifyPaint(first, 'initial-image-paint');
  await inside(0, `window.__imageSetProbeToken=${JSON.stringify(randomUUID())}`);
  const frameToken = await inside(0, 'window.__imageSetProbeToken');
  await edit(0, imageAsk, 'note', words); await edit(0, imageAsk, 'image-note-1', candidateWords);
  await edit(0, imageAsk, 'image-note-2', referenceWords);
  await select(1); await ready(1, model, modelAsk);
  const hidden = await inside(0, `({hidden:owner.hidden,inert:owner.inert,visible:document.body.dataset.hubVisible,token:window.__imageSetProbeToken})`);
  await record('retained-hidden-image-frame', hidden);
  assert.equal(hidden.hidden, true); assert.equal(hidden.inert, true); assert.equal(hidden.visible, 'false'); assert.equal(hidden.token, frameToken);
  const visibility = {schema: JOB_HUB_VISIBILITY, incarnation: new URL(hub.ownerUrl).searchParams.get('workspace'),
    jobId: jobs[0]!.session.jobId, publicationId: first.publicationId, sourceHash: first.source.sourceHash,
    visible: true, language: language === 'en' ? 'ko' : 'en'};
  await inside(0, `(()=>{window.__imageVisibilityViolations=[];window.__imageVisibilityObserver=new window.MutationObserver(()=>{
    if(document.body.dataset.hubVisible!=='false'||document.documentElement.lang!==${JSON.stringify(language)})
      window.__imageVisibilityViolations.push({visible:document.body.dataset.hubVisible,language:document.documentElement.lang});});
    window.__imageVisibilityObserver.observe(document.body,{attributes:true,attributeFilter:['data-hub-visible']});
    window.__imageVisibilityObserver.observe(document.documentElement,{attributes:true,attributeFilter:['lang']});})()`);
  for (const change of [{incarnation: randomUUID()}, {jobId: jobs[1]!.session.jobId}, {publicationId: randomUUID()}, {sourceHash: '0'.repeat(64)}]) {
    await page.evaluate(`document.querySelector('iframe[src*="/jobs/${jobs[0]!.session.jobId}/"]').contentWindow.postMessage(${JSON.stringify({...visibility, ...change})},location.origin)`);
  }
  await inside(0, `window.dispatchEvent(new window.MessageEvent('message',{origin:'http://127.0.0.1:1',source:window.parent,data:${JSON.stringify(visibility)}}))`);
  await page.evaluate(`(()=>{const a=document.querySelector('iframe[src*="/jobs/${jobs[0]!.session.jobId}/"]').contentWindow,
    b=document.querySelector('iframe[src*="/jobs/${jobs[1]!.session.jobId}/"]').contentWindow;
    a.dispatchEvent(new a.MessageEvent('message',{origin:location.origin,source:b,data:${JSON.stringify(visibility)}}));
    return new Promise(resolve=>{const done=event=>{if(event.data?.imageProbeBarrier!==true)return;a.removeEventListener('message',done);resolve();};
      a.addEventListener('message',done);a.postMessage({imageProbeBarrier:true},location.origin);});})()`);
  const invalidVisibility = await inside(0, `window.__imageVisibilityObserver.disconnect(),({violations:window.__imageVisibilityViolations,hidden:owner.hidden,visible:document.body.dataset.hubVisible,locale:document.documentElement.lang})`);
  await record('source-bound-visibility-refusals', {invalidVisibility, syntheticWrongSender: true});
  assert.deepEqual(invalidVisibility.violations, []); assert.equal(invalidVisibility.visible, 'false');
  await edit(1, modelAsk, 'note', 'exact verdict'); await edit(1, modelAsk, 'verdict', 'approved');
  const modelAct = await submitAndFetch(1, modelAsk);
  const baseline = await Bun.file(new URL('./fixtures/job-image-set/model-branch.json', import.meta.url)).text();
  const modelBytes = JSON.stringify({publicationSource: model.source, askSource: modelAsk.source, source: modelAct.source, value: modelAct.value});
  await record('model-source-value-byte-parity', {beforeSha256: hash(baseline), afterSha256: hash(modelBytes), equal: baseline === modelBytes});
  assert.equal(modelBytes, baseline);
  await select(0); await ready(0, first, imageAsk);
  const restored = await inside(0, `({token:window.__imageSetProbeToken,words:document.querySelector('textarea[name="note"]').value,
    candidate:document.querySelector('textarea[name="image-note-1"]').value,reference:document.querySelector('textarea[name="image-note-2"]').value})`);
  await record('normal-hub-draft-restoration', restored);
  assert.deepEqual(restored, {token: frameToken, words, candidate: candidateWords, reference: referenceWords});
  await edit(0, imageAsk, 'verdict', 'approved');
  const imageAct = await submitAndFetch(0, imageAsk);
  await record('exact-image-words-and-source', imageAct);
  assert.deepEqual(imageAct.source, first.source);
  assert.deepEqual(imageAct.value, {stage: 'image-review', verdict: 'approved', words,
    imageNotes: [{name: names[1], words: candidateWords}, {name: names[2], words: referenceWords}]});
  const replacement = await publish(0, 'out-next', 'out-next-record.json'), replacementAsk = await ask(0, replacement);
  await ready(0, replacement, replacementAsk); await verifyPaint(replacement, 'replacement-image-paint');
  await agent(0, 'ask', {publicationId: first.publicationId, subject: {kind: 'review-verdict', stage: 'image-review'}}, 'JOB_ACT_SOURCE_STALE');
  await edit(0, replacementAsk, 'note', retainedWords);
  // Bind the declared response mutant to the next image publication's metadata request.
  hashFailurePublication = 'pending';
  await control!('Fetch.enable', {patterns: [
    {urlPattern: hub.origin + '/jobs/*/publications/*/instances/*/api/review'},
    {urlPattern: hub.origin + '/jobs/*/publications/*/instances/*/api/image-set/*'},
    {urlPattern: hub.origin + '/jobs/*/ui/displayed'}, {urlPattern: hub.origin + '/jobs/*/ui/acts'}]});
  const badHash = await publish(0, 'out-hash', 'out-hash-record.json');
  const badHashAsk = await ask(0, badHash);
  await failedPublication(badHash, badHashAsk, 'hash-mismatch-no-ack');
  await select(1);
  const survivorAsk = await ask(1, model); await ready(1, model, survivorAsk);
  await edit(1, survivorAsk, 'note', 'exact verdict'); await edit(1, survivorAsk, 'verdict', 'approved');
  const survivorAct = await submitAndFetch(1, survivorAsk);
  await record('surviving-model-job', {sourceUnchanged: JSON.stringify(survivorAct.source) === JSON.stringify(modelAct.source), value: survivorAct.value});
  assert.deepEqual(survivorAct.source, modelAct.source); assert.deepEqual(survivorAct.value, modelAct.value);
  const badDecode = await publish(0, 'out-decode', 'out-decode-record.json'), badDecodeAsk = await ask(0, badDecode);
  await select(0); await failedPublication(badDecode, badDecodeAsk, 'decode-failure-no-ack');
  const recovery = await publish(0, 'out-recovery', 'out-recovery-record.json'), recoveryAsk = await ask(0, recovery);
  await ready(0, recovery, recoveryAsk); await verifyPaint(recovery, 'recovered-image-paint');
  const history = await inside<string>(0, `document.querySelector('[data-job-history]').textContent`);
  await record('source-bound-retained-draft-history', {history, oldSourceHash: replacement.source.sourceHash});
  assert.ok(history.includes(retainedWords)); assert.ok(history.includes(replacement.source.sourceHash));
  await record('browser-errors-before-assert', {exceptions, observerErrors});
  assert.deepEqual(exceptions, []); assert.deepEqual(observerErrors, []);
} catch (error) {
  failure = error;
  await diagnostic('failure-diagnostics').catch(error => observerErrors.push(String(error)));
  if (page) await writeFile(join(output, 'failure.png'), await page.screenshot()).catch(() => {});
  await record('failure', {error: error instanceof Error ? error.stack : String(error), exceptions, observerErrors});
} finally {
  if (before) {
    const after = await Promise.all(inputs.map(input => jobInputHashes(input.root)));
    await record('input-immutability', {before, after, unchanged: JSON.stringify(before) === JSON.stringify(after)});
    if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= new Error('INPUT_CHANGED');
  }
  await page?.close();
  for (const [index, job] of jobs.entries()) {
    if (job.session.status().status === 'active') await agent(index, 'close', {reason: 'synthetic image UI probe complete'}).catch(error => {failure ??= error;});
  }
  await hub?.stop();
  const processes = () => Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']).stdout.toString().split('\n')
    .filter(line => line.includes(profile) && /chrome|chromium/.test(line));
  for (const line of processes()) {
    try {process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGTERM');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error;}
  }
  const deadline = Date.now() + 5000;
  while (processes().length && Date.now() < deadline) await Bun.sleep(25);
  const remaining = processes();
  const descriptorRemoved = !await Bun.file(join(stateDir, 'job-hub/host.json')).exists();
  await record('cleanup', {ownedChromeRemaining: remaining.length, descriptorRemoved});
  if (remaining.length || !descriptorRemoved) failure ??= new Error('OWNED_CLEANUP_FAILED');
  for (const input of inputs) await input.close();
  await rm(scratch, {recursive: true, force: true});
  await record('verdict', {status: failure ? 'RED' : 'PASS', language, elapsedMs: performance.now() - started,
    uiActs: uiSubmissions.length, jobs: jobs.length, boundary: 'synthetic normal hub UI with direct writer fetch; installed-candidate runtime remains CP5'});
}
if (failure) throw failure;
