/** Ordinary Nova browser test for the standing owner window. Run --lang en or --lang ko. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {rigStillBrowserProbe} from './helpers/job-rig-still-browser.ts';
import {interviewDiagnosticsBrowserProbe} from './helpers/job-interview-browser.ts';

const argument = (key: string) => {const index = Bun.argv.indexOf(key); return index < 0 ? undefined : Bun.argv[index + 1];};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko');
const observeStill = Bun.argv.includes('--rig-still-observe');
const onlyStill = Bun.argv.includes('--rig-still-only');
const onlyInterviewDiagnostics = Bun.argv.includes('--interview-diagnostics-only');
const onlyParts = Bun.argv.includes('--parts-only');
assert.ok([observeStill, onlyStill, onlyInterviewDiagnostics, onlyParts].filter(Boolean).length <= 1);
assert.ok(!observeStill || language === 'en', 'the diagnostic observation mode is EN only');
const output = argument('--out') ?? 'evidence/job-window-' + language;
await mkdir(output, {recursive: true});
const fixture = await scriptedJobWindowFixture();
const stillProbe = onlyStill || observeStill ? rigStillBrowserProbe(fixture, output, language, observeStill) : null;
const interviewProbe = onlyInterviewDiagnostics ? await interviewDiagnosticsBrowserProbe(fixture, output, language) : null;
const profile = await mkdtemp(join(tmpdir(), 'review-job-window-'));
const observations: Record<string, unknown> = {};
const navigation: {url: string; loaderId?: string}[] = [];
const browserEvents: unknown[] = [];
const resourceResponses: {requestId: string; url: string; status: number; mimeType: string}[] = [];
const completedResources = new Set<string>();
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
try {
    page = await launchCdpSession(profile, {async onEvent(event, send) {
        if (event.sessionId) control = send;
        if (event.method === 'Network.responseReceived') {
            const response = event.params!.response as {url: string; status: number; mimeType: string};
            if (response.url.startsWith(fixture.host.origin)) resourceResponses.push({
                requestId: event.params!.requestId as string, url: response.url,
                status: response.status, mimeType: response.mimeType,
            });
        }
        if (event.method === 'Network.loadingFinished') completedResources.add(event.params!.requestId as string);
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
    await control('Network.enable', stillProbe ? {maxPostDataSize: 12 * 1024 * 1024} : {});
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

        const issuePublication = await fixture.publish('parts', 'parts-issue');
        await show(issuePublication);
        const issueAsk = await fixture.ask(issuePublication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
        await wait(`!!document.querySelector('form[data-job-ask="${issueAsk.askId}"]')`, 'issue form');
        const issueInputs = await jobInputHashes(fixture.input.root);
        await checkpoints('parts-issue-fixture-hashes', {publicationId: issuePublication.publicationId,
            syntheticReader: 'job-window-fixture-reader/1', partsEnumerator: 'synthetic-job-window-parts/1', files: issueInputs});
        // Use the existing single-item gesture, independently of assembled issue support.
        await page.evaluate(`(()=>{document.querySelector('[data-pv-item="mesh"]').click();
            const assembled=document.querySelector('#pv-assemble');if(assembled.getAttribute('aria-pressed')==='true')assembled.click();
            document.querySelector('#native-one').click();for(let i=0;i<4;i++)document.querySelector('#zoom-in').click();
            document.querySelector('#stage-comment').click();})()`);
        const drag = await page.evaluate<{x: number; y: number; endX: number; endY: number}>(`(()=>{
            const pane=document.getElementById('rig-viewport').getBoundingClientRect(),m=new DOMMatrix(document.getElementById('rig-root').style.transform);
            return {x:pane.left+m.e+3*m.a,y:pane.top+m.f+3*m.a,endX:pane.left+m.e+12*m.a,endY:pane.top+m.f+12*m.a};})()`);
        await page.mouse('mouseMoved', drag.x, drag.y);
        await page.mouse('mousePressed', drag.x, drag.y);
        await page.mouse('mouseMoved', drag.endX, drag.endY);
        await page.mouse('mouseReleased', drag.endX, drag.endY);
        await wait(`!!document.querySelector('.stage-comment-composer input')`, 'single-item issue composer');
        await page.evaluate(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value='Visible boundary defect';form.requestSubmit();})()`);
        await wait(`!document.querySelector('.stage-comment-composer') && document.querySelectorAll('.stage-comment-pin').length===1`, 'source-bound crop accepted');
        await writeFile(join(output, 'single-item-issue.png'), await page.screenshot());
        await page.goto('about:blank');
        await page.goto(owner.href);
        await show(issuePublication);
        await wait(`document.querySelector('form[data-job-ask="${issueAsk.askId}"] button[type=submit]').textContent.includes('1')`, 'source-bound issue draft restored');
        await submit(issueAsk.askId);
        await wait(`document.querySelector('.job-notice').dataset.jobPartsState==='sent'`, 'changes requested');
        const issues = (await fixture.next()).events.filter(event => event.type === 'act' && event.act.publicationId === issuePublication.publicationId);
        assert.equal(issues.length, 1);
        const issueAct = issues[0];
        assert.ok(issueAct?.type === 'act' && issueAct.act.kind === 'parts-verdict' && issueAct.act.schema === 'rig-review/act@5');
        assert.equal(issueAct.act.value.verdict, 'changes-requested');
        assert.equal(issueAct.act.value.issues.length, 1);
        assert.deepEqual(issueAct.act.value.issues[0]!.parts.map(part => part.name), ['mesh']);
        assert.equal(issueAct.act.value.issues[0]!.sourceHash, issuePublication.source.sourceHash);
        assert.equal(issueAct.act.value.issues[0]!.view.mode, 'item');
        assert.ok(issueAct.act.value.issues[0]!.nativeCrop);
        assert.deepEqual(await jobInputHashes(fixture.input.root), issueInputs);
        await checkpoints('parts-single-item-issue-act', issueAct.act);
        await fixture.finish();
        await checkpoints('parts-complete', {language, createConsumerAcceptance: 'CREATE_380_AFTER_REVIEW_GREEN_MAIN'});
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
