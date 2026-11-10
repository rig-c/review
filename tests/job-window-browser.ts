/** Ordinary Nova browser test for the standing owner window. Run --lang en or --lang ko. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {rigStillBrowserProbe} from './helpers/job-rig-still-browser.ts';
import {interviewDiagnosticsBrowserProbe} from './helpers/job-interview-browser.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {readPngCrop} from '../src/comment-crops.ts';
import {withDeadline} from './helpers/walk-deadline.ts';

const argument = (key: string) => {const index = Bun.argv.indexOf(key); return index < 0 ? undefined : Bun.argv[index + 1];};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko');
const observeStill = Bun.argv.includes('--rig-still-observe');
const onlyStill = Bun.argv.includes('--rig-still-only');
const onlyInterviewDiagnostics = Bun.argv.includes('--interview-diagnostics-only');
const onlyParts = Bun.argv.includes('--parts-only');
const onlyIssueFlow = Bun.argv.includes('--parts-issue-only');
const onlyC5Parts = Bun.argv.includes('--c5-parts-only');
const c5Parts = argument('--parts-fixture') ?? 'mesh';
assert.ok(c5Parts === 'mesh' || c5Parts === 'no-mesh');
assert.ok([observeStill, onlyStill, onlyInterviewDiagnostics, onlyParts, onlyIssueFlow, onlyC5Parts].filter(Boolean).length <= 1);
assert.ok(!observeStill || language === 'en', 'the diagnostic observation mode is EN only');
const output = argument('--out') ?? 'evidence/job-window-' + language;
await mkdir(output, {recursive: true});
const fixture = await scriptedJobWindowFixture(onlyC5Parts ? {c5Parts} : {});
const stillProbe = onlyStill || observeStill ? rigStillBrowserProbe(fixture, output, language, observeStill) : null;
const interviewProbe = onlyInterviewDiagnostics ? await interviewDiagnosticsBrowserProbe(fixture, output, language) : null;
const profile = await mkdtemp(join(tmpdir(), 'review-job-window-'));
const observations: Record<string, unknown> = {};
const navigation: {url: string; loaderId?: string}[] = [];
const browserEvents: unknown[] = [];
const resourceResponses: {requestId: string; url: string; status: number; mimeType: string}[] = [];
const completedResources = new Set<string>();
const cropCaptures = new Map<string, {prefix: string; request: Promise<void>;
    response?: Promise<{status: number; body: {error?: unknown}}>}>();
let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
type PlantedFailure = 'prepare' | 'acknowledge' | null;
let plantedFailure: PlantedFailure = null;
let injectedFailure: PlantedFailure = null;
let page: InputCdpSession | null = null;
let partsFailure: 'parts-verdict' | 'signoff' | null = null;
const checkpoints = async (name: string, value: unknown) => {
    observations[name] = value;
    await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2));
    console.log('job-window ' + language + ' ' + name);
};
async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
        if (await check()) return;
        await Bun.sleep(25);
    }
    throw new Error('JOB_WINDOW_WAIT_FAILED ' + what);
}
async function wait(expression: string, what: string): Promise<void> {
    await until(() => page!.evaluate<boolean>(expression), what);
}
async function show(publication: {label: string; source?: {sourceHash: string}}) {
    const hashCheck = publication.source?.sourceHash
        ? ` && document.querySelector('.job-source')?.textContent.includes(${JSON.stringify(publication.source.sourceHash)})`
        : '';
    await wait(`(!!document.querySelector('#job-time') || !!document.querySelector('[data-job-parts-workspace] #pv-canvas')) && document.querySelector('.job-notice')?.textContent.includes(${JSON.stringify(publication.label)}) && document.querySelector('.job-notice')?.dataset.failed==='false'${hashCheck}`, 'display ' + publication.label);
}
async function edit(selector: string, value: string) {
    await page!.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function snapshot() {
    return page!.evaluate<{cameras: {rig: {center: unknown; zoom: number}; reference: {center: unknown; zoom: number}}; sync: boolean; time: string; part: string}>(`(()=>{const view=JSON.parse(document.getElementById('view-coordinates').textContent);return {cameras:{rig:{center:view.cameras.rig.center,zoom:view.cameras.rig.zoom},reference:{center:view.cameras.reference.center,zoom:view.cameras.reference.zoom}},sync:view.cameraSync,time:document.getElementById('job-time')?.value ?? '0',part:document.getElementById('job-part')?.value ?? document.querySelector('#pv-items [aria-current=true] .pv-name')?.textContent ?? ''}})()`);
}
async function verifyTimedReferences() {
    await edit('#job-animation', 'inspect');
    await edit('#job-time', '0.5');
    await edit('#job-reference', 'timed-pose');
    await wait(`document.querySelector('#reference-content > canvas') && document.getElementById('job-reference').value==='timed-pose'`, 'timed pose mounted');
    const pose = await page!.evaluate<{time: number; firstFrameAlpha: number; selectedFrameAlpha: number}>(`(()=>{
        const context=document.querySelector('#reference-content > canvas').getContext('2d');
        return {time:Number(document.getElementById('job-time').value),
            firstFrameAlpha:context.getImageData(12,16,1,1).data[3],selectedFrameAlpha:context.getImageData(48,48,1,1).data[3]};})()`);
    assert.equal(pose.time, 0.5);
    assert.equal(pose.firstFrameAlpha, 0);
    assert.ok(pose.selectedFrameAlpha > 0, 'the selected pose draws its nonzero-time frame');
    await checkpoints('timed-pose-selection', pose);

    await edit('#job-reference', 'timed-video');
    await wait(`(()=>{const video=document.querySelector('#reference-content > video');return video && !video.seeking && video.readyState>=2 && video.currentTime===0.5})()`, 'timed video mounted');
    const video = await page!.evaluate<{time: number; currentTime: number; duration: number; seeking: boolean; readyState: number; reference: string}>(`(()=>{
        const video=document.querySelector('#reference-content > video');
        return {time:Number(document.getElementById('job-time').value),currentTime:video.currentTime,
            duration:video.duration,seeking:video.seeking,readyState:video.readyState,reference:document.getElementById('job-reference').value};})()`);
    assert.equal(video.currentTime, video.time);
    assert.equal(video.currentTime, 0.5);
    assert.equal(video.reference, 'timed-video');
    assert.ok(video.duration >= 0.5 && Number.isFinite(video.duration));
    assert.equal(video.seeking, false);
    assert.ok(video.readyState >= 2);
    await checkpoints('timed-video-selection', video);

    for (const probe of [
        {id: 'timed-pose', animation: 'inspect', time: 0.75},
        {id: 'timed-video', animation: '', time: video.duration + 0.25},
    ]) {
        await edit('#job-reference', 'raster');
        await wait(`!!document.querySelector('#reference-content > img')`, 'prior image restored');
        await edit('#job-animation', probe.animation);
        await edit('#job-time', String(probe.time));
        const before = await snapshot();
        await page!.evaluate(`globalThis.__jobWindowPriorReference=document.querySelector('#reference-content').firstElementChild`);
        await edit('#job-reference', probe.id);
        await wait(`document.getElementById('job-reference').value==='raster' && document.querySelector('.job-notice').textContent.includes('REFERENCE_OUT_OF_DOMAIN')`, 'out-of-domain ' + probe.id);
        assert.ok(await page!.evaluate<boolean>(`document.querySelector('#reference-content').firstElementChild===globalThis.__jobWindowPriorReference`));
        const after = await snapshot();
        assert.deepEqual(after, before);
        const refusal = await page!.evaluate<string>(`document.querySelector('.job-notice').textContent`);
        await checkpoints(probe.id + '-out-of-domain', {before, after, refusal, priorReference: 'raster'});
    }
    await edit('#job-animation', 'inspect');
    await edit('#job-time', '0.5');
}
async function submit(askId: string) {
    const selector = 'form[data-job-ask=' + JSON.stringify(askId) + ']';
    await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).querySelector('fieldset').disabled`, 'enabled form');
    await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelector('button[type=submit]').click()`);
    await wait(`document.querySelector(${JSON.stringify(selector)}).querySelector('fieldset').disabled && document.querySelector(${JSON.stringify(selector)}).querySelector('[role=status]').textContent.length>0`, 'saved act');
}
async function assertOldView(snapshotBefore: Awaited<ReturnType<typeof snapshot>>, draftAskId: string) {
    await wait(`document.querySelector('.job-notice')?.dataset.failed==='true'`, 'expected refused update');
    assert.deepEqual(await snapshot(), snapshotBefore);
    assert.equal(await page!.evaluate(`document.querySelector('form[data-job-ask="${draftAskId}"] textarea[name=note]').value`), '  old-source draft\n원문');
}
async function assertHeaderGeometry(name: string) {
    type Box = {x: number; right: number; width: number; height: number; visible: boolean};
    const geometry = await page!.evaluate<{viewport: {width: number; height: number}; language: string;
        titleText: string; selectedLanguage: string; header: Box; title: Box; control: Box}>(`(()=>{
        const box=selector=>{
            const element=document.querySelector(selector),rect=element.getBoundingClientRect(),style=getComputedStyle(element);
            return {x:rect.x,right:rect.right,width:rect.width,height:rect.height,
                visible:element.getClientRects().length>0&&style.display!=='none'&&style.visibility==='visible'&&Number(style.opacity)>0};
        };
        return {viewport:{width:innerWidth,height:innerHeight},language:document.documentElement.lang,
            titleText:document.querySelector('.job-header h1').textContent,
            selectedLanguage:document.querySelector('.job-header select').value,
            header:box('.job-header'),title:box('.job-header h1'),control:box('.job-header select')};})()`);
    await checkpoints(name + '-header', geometry);
    assert.deepEqual(geometry.viewport, {width: 1440, height: 960});
    assert.equal(geometry.language, language);
    assert.equal(geometry.selectedLanguage, language);
    assert.ok(geometry.header.visible && geometry.title.visible && geometry.control.visible);
    assert.ok(geometry.titleText.trim().length > 0);
    assert.ok(geometry.header.height > 0 && geometry.header.height <= 80, 'the owner header stays compact');
    assert.ok(geometry.title.width >= geometry.viewport.width / 2, 'the title has meaningful horizontal width');
    assert.ok(geometry.title.height > 0 && geometry.title.height <= 40);
    assert.ok(geometry.control.width >= 40 && geometry.control.width <= 200, 'the language selector stays compact');
    assert.ok(geometry.control.height >= 24 && geometry.control.height <= 64);
    assert.ok(geometry.title.x >= geometry.header.x && geometry.title.right <= geometry.control.x);
    assert.ok(geometry.control.right <= geometry.viewport.width);
}
async function assertPersistentIssues(count: number, checkpoint: string, summary = 'Visible boundary defect') {
    const state = await page!.evaluate<{visible: boolean; rightSide: boolean; rows: number; text: string; capture: string; listRect: unknown; stageRect: unknown; view: unknown}>(`(()=>{
        const list=document.querySelector('[data-job-parts-workspace] .job-forms #stage-comment-list');
        const stage=document.querySelector('[data-job-parts-workspace] .job-stage');
        if(!list||!stage)return {visible:false,rightSide:false,rows:-1,text:'',capture:'',listRect:null,stageRect:null,view:null};
        const box=list.getBoundingClientRect(),stageBox=stage.getBoundingClientRect(),style=getComputedStyle(list);
        return {visible:!list.hidden&&box.width>0&&box.height>0&&style.display!=='none'&&style.visibility!=='hidden',
            rightSide:box.left>=stageBox.right-1&&box.right<=innerWidth+1,
            rows:list.querySelectorAll('.stage-comment-item').length,text:list.textContent,
            listRect:box.toJSON(),stageRect:stageBox.toJSON(),view:{width:innerWidth,height:innerHeight},
            capture:document.querySelector('#stage-comment').getAttribute('aria-pressed')};})()`);
    await checkpoints(checkpoint, state);
    assert.equal(state.visible, true, 'the shared issue list stays visible in the side slot');
    assert.equal(state.rightSide, true, 'JOB_PARTS_RIGHT_COLUMN: the issue list occupies the right pane');
    assert.equal(state.rows, count);
    const catalog = language === 'ko' ? koCatalog : enCatalog;
    assert.ok(state.text.includes(catalog['Issues']));
    assert.ok(state.text.includes(count ? summary : catalog['No issues yet.']));
    return state;
}
async function assertPartsLayout(checkpoint: string, expectedFrame = {width: 80, height: 64}) {
    type Box = {left: number; top: number; right: number; bottom: number; width: number; height: number};
    const geometry = await page!.evaluate<{
        viewport: {width: number; height: number}; boxes: Record<string, Box>;
        canvas: {intrinsicWidth: number; intrinsicHeight: number; clientRect: Box; zoom: number};
        referenceAbsence: string | null;
    }>(`(()=>{
        const selectors={header:'.job-header',notice:'.job-notice',workspace:'body.job-window > main',
            grid:'[data-job-parts-workspace]',stage:'.job-stage',forms:'.job-forms',toolbar:'.pv-toolbar',
            pair:'#stage-layout',rigPane:'#rig-pane',referencePane:'#reference-pane',
            rigViewport:'#rig-viewport',referenceViewport:'#reference-viewport',rigRoot:'#rig-root'};
        const boxes=Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,document.querySelector(selector).getBoundingClientRect().toJSON()]));
        const canvas=document.querySelector('#pv-canvas'),absence=document.querySelector('#reference-empty');
        return {viewport:{width:innerWidth,height:innerHeight},boxes,
            canvas:{intrinsicWidth:canvas.width,intrinsicHeight:canvas.height,clientRect:canvas.getBoundingClientRect().toJSON(),zoom:new DOMMatrix(document.querySelector('#rig-root').style.transform).a},
            referenceAbsence:absence&&!absence.hidden?absence.textContent:null};})()`);
    await checkpoints(checkpoint, geometry);
    const {viewport, boxes, canvas} = geometry;
    assert.ok(boxes.forms!.left >= boxes.stage!.right - 1 && boxes.forms!.right <= viewport.width + 1,
        'JOB_PARTS_RIGHT_COLUMN: forms occupy the right column');
    assert.ok(Math.abs(boxes.workspace!.bottom - viewport.height) <= 2 &&
        Math.abs(boxes.grid!.bottom - viewport.height) <= 2 &&
        Math.abs(boxes.grid!.top - boxes.workspace!.top) <= 2,
        'JOB_PARTS_VIEWPORT_FILL: workspace and grid consume available viewport height');
    assert.ok(Math.abs(boxes.stage!.height - boxes.grid!.height) <= 2 &&
        boxes.pair!.height >= boxes.stage!.height * 0.65,
        'JOB_PARTS_STAGE_ALLOCATION: the stage and pair receive the freed height');
    for (const name of ['rigViewport', 'referenceViewport']) {
        assert.ok(boxes[name]!.height >= boxes.pair!.height - 24 && boxes[name]!.width >= boxes.pair!.width * 0.35,
            'JOB_PARTS_PANE_ALLOCATION: ' + name + ' receives the available pair area');
    }
    assert.equal(canvas.intrinsicWidth, expectedFrame.width, 'JOB_PARTS_SOURCE_PIXELS: assembled buffer width');
    assert.equal(canvas.intrinsicHeight, expectedFrame.height, 'JOB_PARTS_SOURCE_PIXELS: assembled buffer height');
    assert.ok(canvas.zoom > 1, 'JOB_PARTS_INITIAL_FIT: the small fixture uses the existing Fit camera');
    assert.ok(Math.abs(canvas.clientRect.width - canvas.intrinsicWidth * canvas.zoom) <= 1,
        'JOB_PARTS_DISPLAY_SCALE: client size records camera zoom separately from source pixels');
    await writeFile(join(output, checkpoint + '.png'), await page!.screenshot());
}
async function capturePaint(name: string) {
    await assertHeaderGeometry(name);
    const pickCanvas = 'document.querySelector("#pv-canvas") ?? document.querySelector("#rig-viewport[data-job-rig-canonical] > canvas[data-job-rig-presentation]") ?? document.querySelector("#rig-root canvas")';
    const rectangle = await page!.evaluate<{x: number; y: number; width: number; height: number}>(`(()=>{const canvas=${pickCanvas};const r=canvas.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    assert.ok(rectangle.width > 0 && rectangle.height > 0);
    const shown = PNG.sync.read(await page!.screenshot(rectangle));
    const previous = await page!.evaluate<string>(`(()=>{const canvas=${pickCanvas};const value=canvas.style.visibility;canvas.style.visibility='hidden';return value})()`);
    let hidden: PNG;
    try {hidden = PNG.sync.read(await page!.screenshot(rectangle));}
    finally {await page!.evaluate(`(${pickCanvas}).style.visibility=${JSON.stringify(previous)}`);}
    let changedPixels = 0;
    for (let offset = 0; offset < shown.data.length; offset += 4) {
        if (!shown.data.subarray(offset, offset + 4).equals(hidden.data.subarray(offset, offset + 4))) changedPixels++;
    }
    assert.ok(changedPixels > 0, 'the actual shared workspace canvas contributes visible pixels');
    await checkpoints(name + '-paint', {rectangle, changedPixels, width: shown.width, height: shown.height});
    const fullScreenshot = await page!.screenshot();
    await writeFile(join(output, name + '.png'), fullScreenshot);
    if (name === 'parts') {
        const shared = await page!.evaluate(`(()=>({workspace:document.querySelectorAll('[data-job-parts-workspace]').length,
            canvas:document.querySelectorAll('#pv-canvas').length,
            deadControls:document.querySelectorAll('#job-part,#job-solo,#job-part-observation,#job-panel,.job-part-images,.job-transport').length}))()`);
        await checkpoints('shared-parts-workspace', shared);
        assert.deepEqual(shared, {workspace: 1, canvas: 1, deadControls: 0});
    }
}
async function captureFailure(error: unknown) {
    await Promise.allSettled([...cropCaptures.values()].map(async capture => {
        await capture.request;
        if (capture.response) await capture.response;
    }));
    const captureErrors: string[] = [];
    const redact = (value: string) => value.replace(/#cap=[a-f0-9]{64}/gi, '#cap=REDACTED');
    const failure = {message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined, captureErrors};
    if (page) {
        try {
            const {html, ...state} = await page.evaluate<{html: string; url: string; title: string;
                readyState: string; notice: unknown; alerts: string[]; bodyText: string}>(`(()=>{
                const notice=document.querySelector('.job-notice');
                return {html:document.documentElement.outerHTML,url:location.href,title:document.title,
                    readyState:document.readyState,notice:notice?{text:notice.textContent,failed:notice.dataset.failed}:null,
                    alerts:[...document.querySelectorAll('[role=alert]')].map(node=>node.textContent),
                    bodyText:document.body.innerText};})()`);
            await writeFile(join(output, 'failure-dom.html'), redact(html));
            await writeFile(join(output, 'failure-state.json'), redact(JSON.stringify(state, null, 2)));
        } catch (captureError) {captureErrors.push('DOM ' + String(captureError));}
        try {await writeFile(join(output, 'failure.png'), await page.screenshot());}
        catch (captureError) {captureErrors.push('Screenshot ' + String(captureError));}
    }
    const responses = [];
    for (const resource of resourceResponses) {
        const entry: typeof resource & {body?: string; truncated?: boolean; bodyUnavailable?: string} = {...resource};
        if (control && completedResources.has(resource.requestId) &&
            (resource.mimeType.includes('json') || resource.status >= 400)) {
            try {
                const response = await control('Network.getResponseBody', {requestId: resource.requestId}) as {body: string; base64Encoded: boolean};
                const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
                entry.body = body.slice(0, 64_000);
                entry.truncated = body.length > 64_000;
            } catch (captureError) {entry.bodyUnavailable = String(captureError);}
        }
        responses.push(entry);
    }
    await writeFile(join(output, 'failure-responses.json'), redact(JSON.stringify(responses, null, 2)));
    await writeFile(join(output, 'failure.json'), redact(JSON.stringify(failure, null, 2)));
}
async function captureCropRequest(prefix: string, requestId: string, request: {url: string; postData?: string},
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    const postData = request.postData ?? (await send('Network.getRequestPostData', {requestId}) as {postData: string}).postData;
    const input = JSON.parse(postData) as PartsIssue;
    const {summary, crop, ...issue} = input;
    const {png, ...metadata} = crop;
    assert.ok(png === undefined || typeof png === 'string' && png.startsWith('data:image/png;base64,'), 'CROP_CAPTURE_PNG_REQUIRED');
    const bytes = png === undefined ? await readPngCrop(metadata) : Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
    const file = prefix + '.png';
    await writeFile(join(output, file), bytes);
    await writeFile(join(output, prefix + '-request.json'), JSON.stringify({language, requestId,
        method: 'POST', route: new URL(request.url).pathname,
        requestBodySha256: new Bun.CryptoHasher('sha256').update(postData).digest('hex'),
        requestBodyBytes: Buffer.byteLength(postData), summaryLength: summary.length,
        issue: {...issue, crop: metadata}, actualCrop: {file, bytes: bytes.length,
            sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
            ihdrDimensions: bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
                ? {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)} : null}}, null, 2));
}
async function waitForPartsPaint(phase: string) {
    const state = await page!.evaluate<{paint: string; ariaBusy: string; disabled: boolean; status: string; controlText: string; referenceAbsence: string | null}>(`new Promise((resolve,reject)=>{
        const stage=document.querySelector('[data-job-parts-workspace] [data-parts-paint-state]');
        const control=document.querySelector('#stage-comment'),status=document.querySelector('#pv-save-status');
        if(!stage||!control||!status)throw new Error('PARTS_PAINT_READINESS_SIGNAL_MISSING');
        const inspect=()=>{
            const paint=stage.dataset.partsPaintState;
            if(paint==='failed'||paint==='disposed'){observer.disconnect();reject(new Error('PARTS_PAINT_'+paint.toUpperCase()+': '+status.textContent));return;}
            if(paint==='ready'&&stage.getAttribute('aria-busy')==='false'&&!control.disabled){
                observer.disconnect();const absent=document.querySelector('#reference-empty');
                resolve({paint,ariaBusy:stage.getAttribute('aria-busy'),disabled:control.disabled,status:status.textContent,controlText:control.textContent,
                    referenceAbsence:absent&&!absent.hidden?absent.textContent:null});
            }
        };
        const observer=new MutationObserver(inspect);
        observer.observe(stage,{attributes:true});observer.observe(control,{attributes:true});inspect();
    })`);
    await checkpoints('parts-ready-' + phase, state);
    assert.equal(state.status.includes('COMMENT_BUSY'), false,
        'PARTS_READY_COMMENT_BUSY_PRODUCT_FAILURE: owner UI still reports COMMENT_BUSY after current paint readiness');
}
async function partsIssueFlow(owner: URL) {
    const browser = page;
    assert.ok(browser);
        const issuePublication = await fixture.publish('parts', 'parts-issue');
        await show(issuePublication);
        const issueAsk = await fixture.ask(issuePublication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
        await wait(`!!document.querySelector('form[data-job-ask="${issueAsk.askId}"]')`, 'issue form');
        const issueInputs = await jobInputHashes(fixture.input.root);
        await checkpoints('parts-issue-fixture-hashes', {publicationId: issuePublication.publicationId,
            syntheticReader: 'job-window-fixture-reader/1', partsEnumerator: 'synthetic-job-window-parts/1', files: issueInputs});
        // Wait on the same mount state that disables the owner's visible C control.
        await browser.evaluate(`(()=>{document.querySelector('[data-pv-item="mesh"]').click();
            const assembled=document.querySelector('#pv-assemble');if(assembled.getAttribute('aria-pressed')==='true')assembled.click();
            document.querySelector('#native-one').click();for(let i=0;i<4;i++)document.querySelector('#zoom-in').click();})()`);
        await waitForPartsPaint('issue-item-and-zoom');
        await browser.evaluate(`document.querySelector('#stage-comment').click()`);
        assert.equal(await browser.evaluate(`document.querySelector('#stage-comment').getAttribute('aria-pressed')`), 'true',
            'PARTS_CAPTURE_AFTER_READY_PRODUCT_FAILURE: C remains inactive after owner-visible readiness');
        assert.equal(await browser.evaluate(`document.querySelector('#pv-save-status').textContent.includes('COMMENT_BUSY')`), false,
            'PARTS_CAPTURE_AFTER_READY_PRODUCT_FAILURE: COMMENT_BUSY after owner-visible readiness');
        const drag = await browser.evaluate<{x: number; y: number; endX: number; endY: number}>(`(()=>{
            const canvas=document.getElementById('pv-canvas'),rect=canvas.getBoundingClientRect();
            const scaleX=rect.width/canvas.width,scaleY=rect.height/canvas.height;
            return {x:rect.left+3*scaleX,y:rect.top+3*scaleY,endX:rect.left+12*scaleX,endY:rect.top+12*scaleY,
                canvasRect:rect.toJSON(),nativeWidth:canvas.width,nativeHeight:canvas.height,nativeStart:[3,3],nativeEnd:[12,12],scaleX,scaleY};})()`);
        await checkpoints('parts-issue-native-drag', drag);
        await browser.mouse('mouseMoved', drag.x, drag.y);
        await browser.mouse('mousePressed', drag.x, drag.y);
        await browser.mouse('mouseMoved', drag.endX, drag.endY);
        await browser.mouse('mouseReleased', drag.endX, drag.endY);
        await wait(`!!document.querySelector('.stage-comment-composer input')`, 'single-item issue composer');
        const priorCrops = cropCaptures.size;
        await browser.evaluate(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Visible boundary defect';form.requestSubmit();})()`);
        if (onlyIssueFlow) {
            await until(() => cropCaptures.size > priorCrops, 'crop request captured');
            const capture = [...cropCaptures.values()].at(-1)!;
            await until(() => capture.response !== undefined, 'crop response captured');
            const response = await capture.response!;
            await checkpoints('parts-crop-response', {status: response.status, request: capture.prefix + '-request.json',
                png: capture.prefix + '.png', response: capture.prefix + '-response.json', error: response.body.error});
            assert.equal(response.status, 200, 'JOB_PARTS_CROP_REJECTED ' + JSON.stringify(response.body.error));
        }
        await wait(`!document.querySelector('.stage-comment-composer') && document.querySelectorAll('.stage-comment-pin').length===1`, 'source-bound crop accepted');
        await browser.evaluate(`(()=>{const toggle=document.querySelector('#stage-comment');if(toggle.getAttribute('aria-pressed')==='true')toggle.click();})()`);
        assert.equal((await assertPersistentIssues(1, 'parts-right-issues-one-capture-off')).capture, 'false');
        await writeFile(join(output, 'single-item-issue.png'), await browser.screenshot());
        await browser.goto('about:blank');
        await browser.goto(owner.href);
        await show(issuePublication);
        await wait(`document.querySelector('form[data-job-ask="${issueAsk.askId}"] button[type=submit]').textContent.includes('1')`, 'source-bound issue draft restored');
        await assertPersistentIssues(1, 'parts-right-issues-one-reconnect');
        await submit(issueAsk.askId);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='sent'`, 'changes requested');
        const issues = (await fixture.next()).events.filter(event => event.type === 'act' && event.act.publicationId === issuePublication.publicationId);
        assert.equal(issues.length, 1);
        const issueAct = issues[0];
        assert.ok(issueAct?.type === 'act' && issueAct.act.kind === 'parts-verdict' && issueAct.act.schema === 'rig-review/act@5');
        assert.equal(issueAct.act.value.verdict, 'changes-requested');
        assert.equal(issueAct.act.value.issues.length, 1);
        const savedIssue = issueAct.act.value.issues[0]!;
        assert.deepEqual(savedIssue.parts.map(part => part.name), ['mesh']);
        assert.equal(savedIssue.sourceHash, issuePublication.source.sourceHash);
        assert.equal(savedIssue.view.mode, 'item');
        assert.deepEqual(savedIssue.imageRegion, {x: 2, y: 2, width: 10, height: 10});
        assert.deepEqual(savedIssue.rigRegion, {x: 2, y: 2, width: 10, height: 10});
        assert.ok(savedIssue.nativeCrop);
        const nativePng = PNG.sync.read(await readPngCrop(savedIssue.nativeCrop));
        assert.deepEqual({width: nativePng.width, height: nativePng.height}, {width: 10, height: 10});
        const sourceMesh = PNG.sync.read(await readFile(join(fixture.input.root, 'out/parts/mesh.png')));
        const expectedRgba = new Uint8Array(10 * 10 * 4);
        for (let y = 0; y < 10; y += 1) {
            const start = ((y + 2) * sourceMesh.width + 2) * 4;
            expectedRgba.set(sourceMesh.data.subarray(start, start + 10 * 4), y * 10 * 4);
        }
        assert.deepEqual(new Uint8Array(nativePng.data), expectedRgba);
        assert.deepEqual(await jobInputHashes(fixture.input.root), issueInputs);
        await checkpoints('parts-single-item-issue-act', issueAct.act);
        await fixture.finish();
        await checkpoints('parts-complete', {language, createConsumerAcceptance: 'CREATE_380_AFTER_REVIEW_GREEN_MAIN'});
}

async function c5Click(selector: string) {
    const at = await page!.evaluate<{x: number; y: number}>(`(()=>{
        const element=document.querySelector(${JSON.stringify(selector)});
        if(!element)throw new Error('C5_CONTROL_MISSING '+${JSON.stringify(selector)});
        element.scrollIntoView({block:'nearest'});const box=element.getBoundingClientRect();
        if(!box.width||!box.height)throw new Error('C5_CONTROL_HIDDEN');
        return {x:box.left+box.width/2,y:box.top+box.height/2};})()`);
    await page!.mouse('mouseMoved', at.x, at.y);
    await page!.mouse('mousePressed', at.x, at.y);
    await page!.mouse('mouseReleased', at.x, at.y);
}
async function c5Key(key: 'p' | 'Escape' | 'Enter', type: 'keyDown' | 'keyUp' = 'keyDown') {
    const codes = {p: {code: 'KeyP', windowsVirtualKeyCode: 80},
        Escape: {code: 'Escape', windowsVirtualKeyCode: 27}, Enter: {code: 'Enter', windowsVirtualKeyCode: 13}};
    assert.ok(control);
    await control('Input.dispatchKeyEvent', {type, key, ...codes[key],
        ...(type === 'keyDown' && key !== 'Escape' ? {text: key === 'Enter' ? '\r' : key} : {})});
}
async function c5Point(x: number, y: number) {
    return page!.evaluate<{x: number; y: number}>(`(()=>{
        const canvas=document.querySelector('#pv-canvas'),box=canvas.getBoundingClientRect();
        return {x:box.left+${x}*box.width/canvas.width,y:box.top+${y}*box.height/canvas.height};})()`);
}
async function c5Capture(name: string) {
    const data = await page!.evaluate<{png: string; selected: string | null; assembled: string | null; mesh: boolean}>(`({
        png:document.querySelector('#pv-canvas').toDataURL(),
        selected:document.querySelector('#pv-items [aria-current="true"]')?.dataset.pvItem??null,
        assembled:document.querySelector('#pv-assemble').getAttribute('aria-pressed'),
        mesh:document.querySelector('#pv-mesh-control input').checked})`);
    const bytes = Buffer.from(data.png.split(',')[1]!, 'base64'), decoded = PNG.sync.read(bytes);
    const {png: _inlinePng, ...view} = data;
    await writeFile(join(output, name + '-canvas.png'), bytes);
    await writeFile(join(output, name + '.png'), await page!.screenshot());
    const result = {...view, pngSha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
        rgbaSha256: new Bun.CryptoHasher('sha256').update(decoded.data).digest('hex'),
        width: decoded.width, height: decoded.height};
    await checkpoints(name, result);
    return result;
}
async function c5PartsFlow(owner: URL) {
    assert.ok(page && control);
    const publication = await fixture.publish('parts', 'c5-' + c5Parts + '-' + language);
    await show(publication);
    const ask = await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    await wait(`!!document.querySelector('form[data-job-ask="${ask.askId}"]')`, 'C5 parts form');
    await waitForPartsPaint('c5-initial');
    const inputs = await jobInputHashes(fixture.input.root);
    const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
    const snapshotInputs = await jobInputHashes(retained.snapshotRoot);
    await checkpoints('c5-source-hashes', {publicationId: publication.publicationId,
        sourceHash: publication.source.sourceHash, files: inputs, retainedFiles: snapshotInputs,
        fixture: c5Parts, reader: 'job-window-fixture-reader/1', enumerator: 'synthetic-job-window-parts/1'});
    await assertPartsLayout('c5-initial-layout', {width: 32, height: 24});
    await assertPersistentIssues(0, 'c5-inline-empty');
    assert.equal(await page.evaluate(`document.querySelector('#pv-bg').value`), 'checker');
    assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').disabled`), false);
    if (c5Parts === 'mesh') {
        assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').checked`), false);
        await c5Click('#pv-mesh-control input');await waitForPartsPaint('c5-mesh-on');
    } else {
        assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').checked`), true);
        const label = await page.evaluate<string>(`document.querySelector('#pv-mesh-control').textContent`);
        const reason = await page.evaluate<string>(`document.querySelector('#pv-mesh-panel p').textContent`);
        const catalog = language === 'ko' ? koCatalog : enCatalog;
        assert.ok(label.includes('0/2'));assert.equal(reason, catalog['No mesh geometry is available for this draft.']);
        await checkpoints('c5-no-mesh-copy', {label, reason});
    }
    const beforeToggle = await c5Capture('c5-mesh-on');
    await c5Click('#pv-mesh-control input');await waitForPartsPaint('c5-mesh-off');
    const afterToggle = await c5Capture('c5-mesh-off');
    if (c5Parts === 'mesh') assert.notEqual(afterToggle.rgbaSha256, beforeToggle.rgbaSha256);
    else assert.equal(afterToggle.rgbaSha256, beforeToggle.rgbaSha256);
    await c5Click('#pv-mesh-control input');await waitForPartsPaint('c5-mesh-restored');
    await c5Click('[data-pv-comparison="overlay"]');await waitForPartsPaint('c5-overlay');
    assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').disabled`), false);
    assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').checked`), true);
    const overlay = await c5Capture('c5-overlay-mesh');
    await c5Click('#pv-mesh-control input');await waitForPartsPaint('c5-overlay-mesh-off');
    const overlayOff = await c5Capture('c5-overlay-no-mesh');
    if (c5Parts === 'mesh') assert.notEqual(overlayOff.rgbaSha256, overlay.rgbaSha256);
    else assert.equal(overlayOff.rgbaSha256, overlay.rgbaSha256);
    await c5Click('#pv-mesh-control input');await waitForPartsPaint('c5-overlay-mesh-restored');
    assert.equal((await c5Capture('c5-overlay-restored')).rgbaSha256, overlay.rgbaSha256);
    await c5Click('[data-pv-comparison="part"]');await waitForPartsPaint('c5-overlay-exit');
    const hover = await c5Point(15, 9);await page.mouse('mouseMoved', hover.x, hover.y);
    await wait(`document.querySelector('[data-assembly-hover="front"] span')?.textContent==='front'`, 'C5 frontmost hover');
    await c5Capture('c5-hover');
    await control('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 2, ...hover});
    await control('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 2, ...hover});
    await wait(`document.querySelector('#pv-assemble').getAttribute('aria-pressed')==='false'`, 'C5 native double-click');
    await waitForPartsPaint('c5-item');
    assert.equal(await page.evaluate(`document.querySelector('#pv-items [aria-current="true"]').dataset.pvItem`), 'front');
    assert.equal(await page.evaluate(`document.querySelector('#pv-mesh-control input').checked`), true);
    await page.evaluate(`(()=>{document.querySelector('#rig-viewport').focus();window.__c5Input=[];window.__c5Visibility=[];
        document.addEventListener('keydown',event=>window.__c5Input.push({type:event.type,key:event.key,trusted:event.isTrusted}));
        window.addEventListener('blur',event=>window.__c5Input.push({type:'blur',trusted:event.isTrusted}));
        const record=event=>window.__c5Visibility.push({type:event.type,trusted:event.isTrusted,
            wallMs:Date.now(),monotonicMs:performance.now(),visibility:document.visibilityState,
            focused:document.hasFocus(),activeElement:document.activeElement?.id});
        document.addEventListener('visibilitychange',record);
        window.addEventListener('blur',record);window.addEventListener('focus',record);})()`);
    await c5Key('Escape');await c5Key('Escape', 'keyUp');
    await wait(`document.querySelector('#pv-assemble').getAttribute('aria-pressed')==='true'`, 'C5 Escape with persistent list');
    await waitForPartsPaint('c5-assembled');
    await assertPersistentIssues(0, 'c5-inline-after-escape');
    const retainedView = await c5Capture('c5-retained-view');
    await c5Key('p');
    await wait(`document.querySelector('#stage-comment').disabled&&document.querySelector('[data-parts-paint-state]').dataset.partsPaintState==='ready'`, 'C5 P hold rendered');
    assert.equal(await page.evaluate(`document.querySelector('#pv-canvas').toDataURL()===document.querySelector('#pv-reference').toDataURL()`), true,
        'P hold shows the actual original painting at 100 percent');
    await c5Capture('c5-painting-hold');
    await c5Key('p', 'keyUp');await waitForPartsPaint('c5-P-release');
    assert.equal((await c5Capture('c5-painting-release')).rgbaSha256, retainedView.rgbaSha256);
    await c5Key('p');
    await wait(`document.querySelector('#stage-comment').disabled`, 'C5 second P hold');
    const target = await control('Target.getTargetInfo') as {targetInfo: {targetId: string}};
    const other = await control('Target.createTarget', {url: 'about:blank'}) as {targetId: string};
    try {
        await control('Target.activateTarget', {targetId: other.targetId});
        await wait(`document.visibilityState==='hidden'&&window.__c5Visibility.some(event=>event.type==='visibilitychange'&&event.visibility==='hidden'&&event.trusted)`,
            'C5 native target visibility hidden');
        await withDeadline('C5_PARTS_NATIVE_HIDDEN_READY', 20_000, () => waitForPartsPaint('c5-P-native-hidden'));
        await checkpoints('c5-native-visibility-hidden', await page.evaluate(`({visibility:document.visibilityState,
            focused:document.hasFocus(),events:window.__c5Visibility})`));
        assert.equal((await c5Capture('c5-painting-hidden')).rgbaSha256, retainedView.rgbaSha256);
    } finally {
        await control('Target.activateTarget', {targetId: target.targetInfo.targetId});
        await control('Target.closeTarget', {targetId: other.targetId});
        await c5Key('p', 'keyUp');
    }
    await wait(`document.visibilityState==='visible'&&window.__c5Visibility.some(event=>event.type==='visibilitychange'&&event.visibility==='visible'&&event.trusted)`,
        'C5 native target visibility restored');
    await withDeadline('C5_PARTS_NATIVE_VISIBLE_READY', 20_000, () => waitForPartsPaint('c5-P-native-visible'));
    await checkpoints('c5-native-visibility-restored', await page.evaluate(`({visibility:document.visibilityState,
        focused:document.hasFocus(),events:window.__c5Visibility})`));
    await page.evaluate(`document.querySelector('#rig-viewport').focus()`);
    await c5Click('#stage-comment');
    const start = await c5Point(12.2, 7.2), end = await c5Point(19.8, 14.8);
    await checkpoints('c5-native-drag', {start, end, nativeStart: [12.2, 7.2], nativeEnd: [19.8, 14.8]});
    await page.mouse('mouseMoved', start.x, start.y);await page.mouse('mousePressed', start.x, start.y);
    await page.mouse('mouseMoved', end.x, end.y);await page.mouse('mouseReleased', end.x, end.y);
    await wait(`!!document.querySelector('.stage-comment-composer input')`, 'C5 real assembled composer');
    assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('.stage-comment-parts [aria-pressed="true"]'),node=>node.textContent)`), ['body', 'front']);
    await c5Click('.stage-comment-composer input');
    const beforeTextP = await c5Capture('c5-before-text-P');
    await c5Key('p');await c5Key('p', 'keyUp');
    assert.equal((await c5Capture('c5-after-text-P')).rgbaSha256, beforeTextP.rgbaSha256);
    assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').value`), 'p');
    const summary = 'Visible boundary defect · C5 ' + language;
    await edit('.stage-comment-composer input', summary);
    await c5Key('Enter');await c5Key('Enter', 'keyUp');
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-item').length===1`, 'C5 real crop accepted');
    await c5Key('Escape');await c5Key('Escape', 'keyUp');
    await assertPersistentIssues(1, 'c5-inline-one', summary);
    await c5Click('.stage-comment-summary');
    await wait(`!!document.querySelector('.stage-comment-composer input')`, 'C5 seam restore');
    assert.equal(await page.evaluate(`document.querySelectorAll('[data-assembly-outline]').length`), 2);
    await c5Capture('c5-restored-seam');
    const priorRequests = cropCaptures.size;
    await c5Click('.stage-comment-parts [data-comment-part="body"]');
    await c5Click('.stage-comment-composer input');await edit('.stage-comment-composer input', 'Invalid narrowed seam');
    await c5Key('Enter');await c5Key('Enter', 'keyUp');
    await wait(`document.querySelector('.stage-comment-composer [role=alert]')?.textContent.includes('PARTS_COMMENT_OUT_OF_BOUNDS')`, 'C5 invalid chip edit');
    assert.equal(await page.evaluate(`document.querySelector('.stage-comment-summary').textContent.includes(${JSON.stringify(summary)})`), true);
    assert.equal(cropCaptures.size, priorRequests, 'invalid region is rejected before crop transport');
    await c5Capture('c5-atomic-edit-refusal');
    await c5Click('.stage-comment-parts [data-comment-part="body"]');await c5Click('.stage-comment-composer input');
    const edited = 'Validated seam · C5 ' + language;
    await edit('.stage-comment-composer input', edited);await c5Key('Enter');await c5Key('Enter', 'keyUp');
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelector('.stage-comment-summary').textContent.includes(${JSON.stringify(edited)})`, 'C5 validated chip edit');
    const trustedInput = await page.evaluate<{type: string; key?: string; trusted: boolean}[]>(`window.__c5Input`);
    const visibilityEvents = await page.evaluate<{type: string; visibility: string; trusted: boolean}[]>(`window.__c5Visibility`);
    assert.ok(visibilityEvents.some(event => event.type === 'visibilitychange' && event.visibility === 'hidden'));
    assert.ok(visibilityEvents.some(event => event.type === 'visibilitychange' && event.visibility === 'visible'));
    assert.ok(visibilityEvents.every(event => event.trusted));
    await checkpoints('c5-native-visibility-events', visibilityEvents);
    assert.ok(trustedInput.some(event => event.key === 'p') && trustedInput.some(event => event.key === 'Escape'));
    assert.ok(trustedInput.every(event => event.trusted));
    await checkpoints('c5-trusted-input', trustedInput);
    await page.goto('about:blank');await page.goto(owner.href);await show(publication);
    await waitForPartsPaint('c5-draft-reconnect');await assertPersistentIssues(1, 'c5-draft-restored', edited);
    await c5Click(`form[data-job-ask="${ask.askId}"] button[type=submit]`);
    await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='sent'`, 'C5 actual job act submitted');
    const events = await fixture.next();
    const acts = events.events.filter(event => event.type === 'act' && event.act.publicationId === publication.publicationId);
    assert.equal(acts.length, 1);
    const event = acts[0];assert.ok(event?.type === 'act' && event.act.kind === 'parts-verdict' && event.act.schema === 'rig-review/act@5');
    const issue = event.act.value.issues[0]!;
    assert.equal(event.act.value.verdict, 'changes-requested');assert.equal(event.act.value.issues.length, 1);
    assert.equal(issue.summary, edited);assert.deepEqual(issue.parts.map(part => part.name), ['body', 'front']);
    assert.equal(issue.sourceHash, publication.source.sourceHash);assert.equal(event.act.source.sourceHash, publication.source.sourceHash);
    assert.equal(issue.view.mode, 'assembled');assert.equal(issue.imageRegion, null);assert.equal(issue.nativeCrop, null);
    assert.deepEqual(issue.rigRegion, {x: 12, y: 7, width: 8, height: 8});
    for (const part of issue.parts) assert.equal(part.imageHash, publication.source.parts!.images.find(image => image.role === 'part' && image.path === 'parts/' + part.name + '.png')!.sha256);
    const crop = await readPngCrop(issue.crop), decoded = PNG.sync.read(crop);
    assert.equal(new Bun.CryptoHasher('sha256').update(crop).digest('hex'), issue.crop.sha256);
    assert.deepEqual([decoded.width, decoded.height], [issue.crop.width, issue.crop.height]);
    await writeFile(join(output, 'c5-finalized-crop.png'), crop);
    await checkpoints('c5-finalized-act', event.act);
    await page.goto('about:blank');await page.goto(owner.href);await show(publication);
    await waitForPartsPaint('c5-act-reconnect');await assertPersistentIssues(1, 'c5-act-restored', edited);
    await c5Click('.stage-comment-summary');await wait(`!!document.querySelector('.stage-comment-composer input')`, 'C5 readonly finalized issue');
    assert.equal(await page.evaluate(`document.querySelector('.stage-comment-composer input').readOnly`), true);
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.stage-comment-parts button')).every(button=>button.disabled)`), true);
    await c5Capture('c5-finalized-readonly');
    const replay = (await fixture.next()).events.find(item => item.type === 'act' && item.act.actId === event.act.actId);
    assert.ok(replay?.type === 'act');assert.deepEqual(replay.act, event.act);
    assert.deepEqual(await jobInputHashes(fixture.input.root), inputs);
    assert.deepEqual(await jobInputHashes(retained.snapshotRoot), snapshotInputs);
    assert.equal(cropCaptures.size, 2, 'one creation and one validated chip edit use the crop route');
    for (const capture of cropCaptures.values()) {
        await capture.request;await until(() => Boolean(capture.response), 'C5 crop response evidence');
        const response = await capture.response!;assert.equal(response.status, 200);
        const request = JSON.parse(await readFile(join(output, capture.prefix + '-request.json'), 'utf8'));
        assert.equal(request.issue.sourceHash, publication.source.sourceHash);
        assert.equal(request.actualCrop.sha256, request.issue.crop.sha256);
        assert.deepEqual(request.issue.parts.map((part: {name: string}) => part.name), ['body', 'front']);
    }
    await checkpoints('c5-complete', {language, fixture: c5Parts, sourceHash: publication.source.sourceHash,
        strictLiveInputHashes: inputs, strictRetainedInputHashes: snapshotInputs, cropRequests: cropCaptures.size,
        actId: event.act.actId, schema: event.act.schema, browserProof: 'actual job owner window'});
    await fixture.finish();
}

try {
    page = await launchCdpSession(profile, {async onEvent(event, send) {
        if (event.sessionId) control = send;
        if ((onlyIssueFlow || onlyC5Parts) && event.method === 'Network.requestWillBeSent') {
            const request = event.params!.request as {url: string; method: string; postData?: string};
            if (request.method === 'POST' && request.url.startsWith(fixture.host.origin + '/jobs/') &&
                request.url.endsWith('/api/stage-parts/comment')) {
                const requestId = event.params!.requestId as string;
                const prefix = 'crop-' + (cropCaptures.size + 1);
                cropCaptures.set(requestId, {prefix, request: captureCropRequest(prefix, requestId, request, send)});
                await cropCaptures.get(requestId)!.request;
            }
        }
        if (event.method === 'Network.responseReceived') {
            const response = event.params!.response as {url: string; status: number; mimeType: string};
            if (response.url.startsWith(fixture.host.origin)) resourceResponses.push({
                requestId: event.params!.requestId as string, url: response.url,
                status: response.status, mimeType: response.mimeType,
            });
        }
        if (event.method === 'Network.loadingFinished') {
            const requestId = event.params!.requestId as string;
            completedResources.add(requestId);
            const capture = cropCaptures.get(requestId);
            if (capture) {
                capture.response = capture.request.then(async () => {
                    const resource = resourceResponses.find(response => response.requestId === requestId);
                    assert.ok(resource, 'CROP_CAPTURE_RESPONSE_REQUIRED');
                    const response = await send('Network.getResponseBody', {requestId}) as {body: string; base64Encoded: boolean};
                    const text = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body;
                    const body = JSON.parse(text) as {error?: unknown};
                    await writeFile(join(output, capture.prefix + '-response.json'), JSON.stringify({requestId,
                        status: resource.status, mimeType: resource.mimeType,
                        responseBodySha256: new Bun.CryptoHasher('sha256').update(text).digest('hex'), body}, null, 2));
                    return {status: resource.status, body};
                });
                await capture.response;
            }
        }
        if (event.method === 'Fetch.requestPaused') {
            if (await stillProbe?.intercept(event, send)) return;
            const requestId = event.params!.requestId;
            const request = event.params!.request as {url: string; postData?: string};
            if (partsFailure && request.url.endsWith('/ui/acts') &&
                JSON.parse(request.postData ?? '{}').kind === partsFailure) {
                partsFailure = null;
                await send('Fetch.fulfillRequest', {requestId, responseCode: 409,
                    responseHeaders: [{name: 'Content-Type', value: 'application/json'}],
                    body: Buffer.from(JSON.stringify({ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}})).toString('base64')});
                return;
            }
            const failure = plantedFailure;
            if (failure === 'prepare' && request.url.endsWith('/api/review')) {
                plantedFailure = null;
                injectedFailure = failure;
                await send('Fetch.failRequest', {requestId, errorReason: 'Failed'});
            } else if (failure === 'acknowledge' && request.url.endsWith('/ui/displayed')) {
                plantedFailure = null;
                injectedFailure = failure;
                await send('Fetch.fulfillRequest', {requestId, responseCode: 409,
                    responseHeaders: [{name: 'Content-Type', value: 'application/json'}],
                    body: Buffer.from(JSON.stringify({ok: false, error: {code: 'JOB_DISPLAY_MISMATCH', message: 'Declared display acknowledgment control'}})).toString('base64')});
            } else await send('Fetch.continueRequest', {requestId});
            return;
        }
        if (event.method === 'Runtime.exceptionThrown' || event.method === 'Network.loadingFailed')
            browserEvents.push(event);
        if (event.method !== 'Page.frameNavigated') return;
        const frame = event.params?.frame as {parentId?: string; url?: string; loaderId?: string} | undefined;
        if (frame && !frame.parentId && frame.url?.startsWith(fixture.host.origin)) {
            navigation.push({url: frame.url.replace(/#cap=[a-f0-9]{64}/g, '#cap=REDACTED'), loaderId: frame.loaderId});
        }
    }});
    await page.setViewport(1440, 960);
    assert.ok(control);
    await control('Network.enable', stillProbe ? {maxPostDataSize: 12 * 1024 * 1024} :
        onlyIssueFlow || onlyC5Parts ? {maxPostDataSize: 256 * 1024} : {});
    await control('Fetch.enable', {patterns: [
        {urlPattern: fixture.host.origin + '/jobs/*/publications/*/instances/*/api/review'},
        {urlPattern: fixture.host.origin + '/jobs/*/ui/displayed'},
        ...(!stillProbe ? [{urlPattern: fixture.host.origin + '/jobs/*/ui/acts'}] : []),
        ...(stillProbe ? [
            {urlPattern: fixture.host.origin + '/jobs/*/ui/acts', requestStage: 'Request'},
            {urlPattern: fixture.host.origin + '/jobs/*/ui/acts', requestStage: 'Response'},
        ] : []),
    ]});
    const owner = new URL(fixture.host.ownerUrl); owner.searchParams.set('lang', language);
    await page.goto(owner.href);
    const sentinel = await page.evaluate<string>('globalThis.__jobWindowDocument = crypto.randomUUID()');
    if (stillProbe) {
        await stillProbe.run(page, {wait, show, edit, send: control!});
        assert.equal(await page.evaluate('globalThis.__jobWindowDocument'), sentinel);
        assert.equal(navigation.length, 1);
    } else if (interviewProbe) {
        await interviewProbe.run(page, {wait, show, edit, submit, checkpoints, send: control!});
        assert.equal(await page.evaluate('globalThis.__jobWindowDocument'), sentinel);
        assert.equal(navigation.length, 1);
    } else if (onlyC5Parts) {
        await c5PartsFlow(owner);
    } else if (onlyIssueFlow) {
        await partsIssueFlow(owner);
    } else {
    const first = await fixture.publish('parts');
    await show(first);
    const firstPaint = await page.evaluate<{width: number; height: number; assembled: string}>(`(()=>{
        const canvas=document.querySelector('[data-job-parts-workspace] #pv-canvas');
        return {width:canvas.width,height:canvas.height,assembled:document.querySelector('#pv-assemble').getAttribute('aria-pressed')};})()`);
    assert.ok(firstPaint.width > 1 && firstPaint.height > 1, 'the acknowledged shared mount has painted its initial image');
    assert.equal(firstPaint.assembled, 'true');
    await checkpoints('parts-initial-paint', {publicationId: first.publicationId, sourceHash: first.source.sourceHash,
        ...firstPaint, fixture: 'public viewport-387 package with declared synthetic job metadata'});
    fixture.input.setContext({...fixture.input.getContext(), subjects: [...fixture.input.getContext().subjects,
        {kind: 'signoff', stage: 'parts-review'}]});
    // Publish the updated semantic ask declaration through the ordinary agent command.
    const partsPublication = await fixture.publish('parts', 'parts-submit');
    await show(partsPublication);
    const approvedParts = await fixture.ask(partsPublication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    const partsSignoff = await fixture.ask(partsPublication, {kind: 'signoff', stage: 'parts-review'});
    await wait(`!!document.querySelector('form[data-job-ask="${approvedParts.askId}"]')`, 'shared parts submit');
    assert.equal(await page.evaluate(`document.querySelectorAll('select[name^="parts."],select[name^="mesh."],form[data-job-ask="${partsSignoff.askId}"]').length`), 0);
    const partsInputs = await jobInputHashes(fixture.input.root);
    await checkpoints('parts-public-fixture-hashes', {publicationId: partsPublication.publicationId,
        syntheticReader: 'job-window-fixture-reader/1', partsEnumerator: 'synthetic-job-window-parts/1', files: partsInputs});
    await assertPartsLayout('parts-initial-layout');
    assert.equal((await assertPersistentIssues(0, 'parts-right-issues-zero')).capture, 'false');
    await page.evaluate(`document.querySelector('#pv-assemble').click()`);
    await wait(`document.querySelector('#pv-assemble').getAttribute('aria-pressed')==='false' && document.querySelector('#stage-comment-refusal').hidden`, 'item view available for C capture');
    await page.evaluate(`document.querySelector('#stage-comment').click()`);
    assert.equal((await assertPersistentIssues(0, 'parts-right-issues-zero-capture-on')).capture, 'true');
    await page.evaluate(`document.querySelector('#stage-comment').click()`);
    assert.equal((await assertPersistentIssues(0, 'parts-right-issues-zero-capture-off')).capture, 'false');
    await page.evaluate(`document.querySelector('#pv-assemble').click()`);
    await wait(`document.querySelector('#pv-assemble').getAttribute('aria-pressed')==='true' && document.querySelector('#pv-canvas').width===80 && document.querySelector('#pv-canvas').height===64`, 'assembled default restored for approval');
    await page.evaluate(`document.querySelector('#fit').click()`);
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await assertPartsLayout('parts-approval-layout');
    await capturePaint('parts');
    await submit(approvedParts.askId);
    await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='approved'`, 'parts approved');
    assert.deepEqual(await jobInputHashes(fixture.input.root), partsInputs);
    const partsEvents = await fixture.next();
    const partsAct = partsEvents.events.find(event => event.type === 'act' && event.act.askId === approvedParts.askId);
    assert.ok(partsAct?.type === 'act' && partsAct.act.kind === 'parts-verdict');
    assert.equal(partsAct.act.source.sourceHash, partsPublication.source.sourceHash);
    assert.equal(partsAct.act.schema, 'rig-review/act@5');
    assert.deepEqual(partsAct.act.value.issues, []);
    const submitted = partsEvents.events.filter(event => event.type === 'act' &&
        (event.act.askId === approvedParts.askId || event.act.askId === partsSignoff.askId));
    assert.deepEqual(submitted.map(event => event.type === 'act' && event.act.kind), ['parts-verdict', 'signoff']);
    await checkpoints('parts-act', partsAct.act);
    // Reconnect reconstructs approval from the ordinary event stream.
    await page.goto('about:blank');
    await page.goto(owner.href);
    await show(partsPublication);
    await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='approved'`, 'parts approval replay');
    await checkpoints('parts-reconnect-approved', {publicationId: partsPublication.publicationId});
    if (onlyParts) {
        const retryPublication = await fixture.publish('parts', 'parts-retry');
        await show(retryPublication);
        const retryVerdict = await fixture.ask(retryPublication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
        const retrySignoff = await fixture.ask(retryPublication, {kind: 'signoff', stage: 'parts-review'});
        const retrySelector = `form[data-job-ask="${retryVerdict.askId}"] button[type=submit]`;
        await wait(`!!document.querySelector(${JSON.stringify(retrySelector)}) && !document.querySelector(${JSON.stringify(retrySelector)}).disabled`, 'retry form');
        partsFailure = 'parts-verdict';
        await page.evaluate(`document.querySelector(${JSON.stringify(retrySelector)}).click()`);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='reviewing' && document.querySelector('form[data-job-ask="${retryVerdict.askId}"] [role=status]').textContent.includes('JOB_ACT_INVALID')`, 'first-write refusal');
        assert.equal((await fixture.next()).events.filter(event => event.type === 'act' && event.act.askId === retryVerdict.askId).length, 0);
        partsFailure = 'signoff';
        await page.evaluate(`document.querySelector(${JSON.stringify(retrySelector)}).click()`);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='retry-signoff'`, 'signoff-only retry state');
        await writeFile(join(output, 'retry-signoff.png'), await page.screenshot());
        await page.goto('about:blank');
        await page.goto(owner.href);
        await show(retryPublication);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='retry-signoff'`, 'retry state replay');
        await submit(retryVerdict.askId);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='approved'`, 'signoff retry approved');
        const retryActs = (await fixture.next()).events.filter(event => event.type === 'act' &&
            (event.act.askId === retryVerdict.askId || event.act.askId === retrySignoff.askId));
        assert.deepEqual(retryActs.map(event => event.type === 'act' && event.act.kind), ['parts-verdict', 'signoff']);
        await checkpoints('parts-retry-acts', retryActs);

        await partsIssueFlow(owner);
    } else {
    const draftPublication = await fixture.publish('parts', 'parts-draft');
    await show(draftPublication);
    const parts = await fixture.ask(draftPublication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    await wait(`!!document.querySelector('form[data-job-ask="${parts.askId}"]')`, 'parts draft');
    await edit(`form[data-job-ask="${parts.askId}"] textarea[name=note]`, '  old-source draft\n원문');
    const before = await snapshot();
    await checkpoints('before-update', before);
    await capturePaint('parts');

    plantedFailure = 'prepare';
    const failedPrepare = await fixture.publish('rig');
    await until(() => injectedFailure === 'prepare', 'prepare control intercepted');
    await assertOldView(before, parts.askId);
    assert.equal(injectedFailure, 'prepare');
    await checkpoints('expected-prepare-refusal', {publicationId: failedPrepare.publicationId, before, after: await snapshot()});
    plantedFailure = 'acknowledge';
    const failedAcknowledge = await fixture.publish('rig');
    await until(() => injectedFailure === 'acknowledge', 'acknowledgment control intercepted');
    await assertOldView(before, parts.askId);
    assert.equal(injectedFailure, 'acknowledge');
    await checkpoints('expected-acknowledgment-refusal', {publicationId: failedAcknowledge.publicationId, before, after: await snapshot()});
    const rig = await fixture.publish('rig');
    await show(rig);
    const after = await snapshot();
    await verifyTimedReferences();
    await checkpoints('parts-to-rig', {before, after});
    assert.equal(navigation.length, 2);
    await wait(`document.querySelector('[data-job-history]')?.textContent.includes('old-source draft')`, 'retained old draft');
    // The restoration above remains covered. A new Rig verdict requires whole/default framing.
    await edit('#job-part', '');
    await page.evaluate(`(()=>{document.getElementById('rig-viewport').dispatchEvent(new Event('focusin',{bubbles:true}));document.getElementById('fit').click()})()`);
    const verdictView = await snapshot();
    const review = await fixture.ask(rig, {kind: 'review-verdict', stage: 'rig-review'});
    await wait(`!!document.querySelector('form[data-job-ask="${review.askId}"]')`, 'new verdict');
    await edit(`form[data-job-ask="${review.askId}"] select[name=verdict]`, 'approved');
    await edit(`form[data-job-ask="${review.askId}"] textarea[name=note]`, '  new-source verdict\n');
    const immutable = await jobInputHashes(fixture.input.root);
    await submit(review.askId);
    let events = await fixture.next();
    const verdict = events.events.find(event => event.type === 'act' && event.act.kind === 'review-verdict');
    assert.ok(verdict?.type === 'act');
    assert.equal(verdict.act.schema, 'rig-review/act@3');
    assert.ok(verdict.act.schema === 'rig-review/act@3');
    assert.equal(verdict.act.still.camera, 'fixed');
    assert.equal(verdict.act.still.frame, 0.5);
    assert.equal(verdict.act.still.animation, 'inspect');
    assert.equal(verdict.act.still.path, verdict.act.still.sha256 + '.png');
    assert.equal(verdict.act.source.sourceHash, rig.source.sourceHash);
    assert.equal((verdict.act.value as {words: string}).words, '  new-source verdict\n');
    assert.deepEqual(await jobInputHashes(fixture.input.root), immutable);
    await checkpoints('rig-update', {before, after, publication: rig, verdict: verdict.act, navigation});
    await capturePaint('rig');

    const pending = await fixture.ask(rig, {kind: 'interview-picks', questionId: fixture.question.set.question, setId: fixture.question.set.id});
    await wait(`!!document.querySelector('form[data-job-ask="${pending.askId}"]')`, 'pending interview');
    for (const item of fixture.question.set.asks) {
        const option = item.options.find(option => option.kind === 'value' && option.recommended)!;
        await edit(`form[data-job-ask="${pending.askId}"] select[name="choice.${item.id}"]`, option.id);
    }
    await edit(`form[data-job-ask="${pending.askId}"] textarea[name=note]`, '  interview words\n');
    await submit(pending.askId);
    const checkpoint = await fixture.ask(rig, {kind: 'checkpoint', checkpointId: 'step-one'});
    await wait(`!!document.querySelector('form[data-job-ask="${checkpoint.askId}"]')`, 'plan checkpoint');
    await edit(`form[data-job-ask="${checkpoint.askId}"] select[name=outcome]`, 'pass');
    await submit(checkpoint.askId);
    const signoff = await fixture.ask(rig, {kind: 'signoff', stage: 'plan-approved'});
    await wait(`!!document.querySelector('form[data-job-ask="${signoff.askId}"]')`, 'separate signoff');
    await submit(signoff.askId);
    events = await fixture.next();
    const finalized = events.events.flatMap(event => event.type === 'act' ? [event.act] : []);
    assert.deepEqual(finalized.map(act => act.kind).sort(), ['checkpoint', 'interview-picks', 'parts-verdict', 'review-verdict', 'signoff', 'signoff']);
    assert.ok(finalized.every(act => act.authority.actor === 'human' && act.authority.channel === 'review-ui'));
    const checkpointAct = finalized.find(act => act.kind === 'checkpoint')!;
    assert.ok(checkpointAct.kind === 'checkpoint');
    assert.equal(checkpointAct.value.words, '');
    assert.deepEqual(checkpointAct.source.plan, rig.source.plan);
    assert.deepEqual(await jobInputHashes(fixture.input.root), immutable);
    await checkpoints('five-ui-acts', finalized);

    const direction = await fixture.publish('direction');
    await show(direction);
    assert.deepEqual(await snapshot(), verdictView);
    assert.equal(navigation.length, 2);
    await edit('#job-animation', 'short');
    await edit('#job-time', '0.75');
    await page.evaluate(`document.getElementById('zoom-in').click()`);
    const directionDraftAsk = await fixture.ask(direction, {kind: 'checkpoint', checkpointId: 'step-one'});
    await wait(`!!document.querySelector('form[data-job-ask="${directionDraftAsk.askId}"]')`, 'direction draft form');
    await edit(`form[data-job-ask="${directionDraftAsk.askId}"] select[name=outcome]`, 'fail');
    await edit(`form[data-job-ask="${directionDraftAsk.askId}"] textarea[name=note]`, '  active draft across reconnect\n');
    await wait(`!document.querySelector('[data-job-direction]').hidden && document.querySelector('[data-job-direction]').textContent.includes('rig-world-y-up')`, 'direction metadata');
    const beforeReconnect = await snapshot();
    await capturePaint('direction');
    events = await fixture.next();
    await checkpoints('direction-update', {publication: direction, beforeReconnect, events, navigation});
    // Leave the last owner document. The job must remain active without a connected owner tab.
    await page.goto('about:blank');
    assert.notEqual((await fixture.next()).status, 'closed');
    await page.goto(owner.href);
    await show(direction);
    const afterReconnect = await snapshot();
    assert.deepEqual(afterReconnect, beforeReconnect);
    assert.equal(await page.evaluate(`document.getElementById('job-animation').value`), 'short');
    assert.equal(await page.evaluate(`document.querySelector('form[data-job-ask="${directionDraftAsk.askId}"] textarea[name=note]')?.value`), '  active draft across reconnect\n');
    assert.ok(await page.evaluate<boolean>(`document.querySelector('.job-notice').textContent.includes(${JSON.stringify(rig.label)}) && document.querySelector('.job-notice').textContent.includes(${JSON.stringify(direction.label)})`));
    assert.ok(await page.evaluate<boolean>(`document.querySelector('[data-job-history]').textContent.includes('old-source draft') && document.querySelector('[data-job-history]').textContent.includes(${JSON.stringify(draftPublication.source.sourceHash)})`));
    await checkpoints('reopened-same-job', {jobId: fixture.host.session.jobId, publicationId: direction.publicationId, afterReconnect});

    // Sequential update #3 (incompatible selection): removes 'short' animation while preserving camera/panel and source-bound drafts in place.
    const postReconnectSentinel = await page.evaluate<string>('globalThis.__jobWindowPostReconnect = crypto.randomUUID()');
    const incompatible = await fixture.publish('direction', 'direction-incompatible', {stripShortAnimation: true});
    await show(incompatible);
    assert.equal(await page.evaluate('globalThis.__jobWindowPostReconnect'), postReconnectSentinel);
    assert.equal(navigation.length, 3);
    const afterIncompatible = await snapshot();
    assert.deepEqual(afterIncompatible.cameras, beforeReconnect.cameras);
    assert.equal(await page.evaluate(`document.querySelector('#job-panel')`), null);
    assert.equal(await page.evaluate(`document.getElementById('job-animation').value`), '');
    assert.equal(afterIncompatible.time, '0');
    const expectedIncompatibleNotice = language === 'ko'
        ? '이 결과에서 이전 선택 항목을 사용할 수 없습니다.'
        : 'The previous selection is unavailable in this result.';
    assert.ok(await page.evaluate<boolean>(`document.querySelector('.job-notice').textContent.includes(${JSON.stringify(expectedIncompatibleNotice)})`));
    assert.ok(await page.evaluate<boolean>(`document.querySelector('[data-job-history]').textContent.includes('old-source draft') && document.querySelector('[data-job-history]').textContent.includes('active draft across reconnect') && document.querySelector('[data-job-history]').textContent.includes(${JSON.stringify(draftPublication.source.sourceHash)}) && document.querySelector('[data-job-history]').textContent.includes(${JSON.stringify(direction.source.sourceHash)})`));
    await checkpoints('incompatible-update', {publication: incompatible, afterIncompatible, navigation});

    await fixture.finish();
    await wait(`document.querySelector('.job-notice').textContent.includes(${JSON.stringify(language === 'ko' ? '명시적으로 종료' : 'explicitly closed')})`, 'explicit close');
    await checkpoints('complete', {language, metadataOnly: true, createWriterReadback: 'PENDING_CREATE_182_184', separateUID: 'PARENT_A_GATE'});
    }
    }
} catch (error) {
    try {await captureFailure(error);}
    catch (captureError) {console.error('JOB_WINDOW_DIAGNOSTIC_FAILED', String(captureError));}
    throw error;
} finally {
    stillProbe?.dispose();
    await writeFile(join(output, 'browser-events.json'), JSON.stringify(browserEvents).replace(/#cap=[a-f0-9]{64}/g, '#cap=REDACTED'));
    if (page) await page.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
}
