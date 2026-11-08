import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import type {JobPublication, JobRigReviewAct, JobUISubmission} from '../../src/job-contract.ts';
import {JOB_API_SCHEMA} from '../../src/job-contract.ts';
import {enCatalog} from '../../web/catalog-en.ts';
import {koCatalog} from '../../web/catalog-ko.ts';
import type {CdpPageEvent, InputCdpSession} from '../parts-explorer-browser.ts';
import {jobInputHashes} from './job-api-fixture.ts';
import type {scriptedJobWindowFixture} from './job-window-fixture.ts';
import {admitStillOracle, armStillObservation, persistStillObservation, restoreStillOracle} from './job-still-observation.ts';

type Fixture = Awaited<ReturnType<typeof scriptedJobWindowFixture>>;
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type Submission = Extract<JobUISubmission, {kind: 'review-verdict'}>;
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const entry = fileURLToPath(new URL('../../src/entry.ts', import.meta.url));

/** Test-only faults surround the real front, UI, SQLite commit and consumer CLI. */
export function rigStillBrowserProbe(fixture: Fixture, output: string, language: 'en' | 'ko', observeOnly = false) {
    const requests: {sha256: string; input: Submission}[] = [];
    let loseReply = false;
    let lostReply = false;
    let releaseEvents: (() => void) | undefined;
    let heldEvents: Promise<void> | undefined;
    const subscribe = fixture.host.ports.subscribeJob.bind(fixture.host.ports);
    fixture.host.ports.subscribeJob = async function* (input) {
        for await (const event of subscribe(input)) {
            if (event.type === 'act' && heldEvents) await heldEvents;
            if (input.signal.aborted) return;
            yield event;
        }
    };
    const catalog = language === 'ko' ? koCatalog : enCatalog;
    async function record(name: string, value: unknown) {
        await writeFile(join(output, name + '.json'), JSON.stringify(value, null, 2));
        console.log('rig-still ' + language + ' ' + name);
    }
    return {
        async intercept(event: CdpPageEvent, send: Send): Promise<boolean> {
            if (event.method !== 'Fetch.requestPaused') return false;
            const params = event.params!;
            const request = params.request as {url: string; postData?: string};
            if (!request.url.endsWith('/ui/acts')) return false;
            if (params.responseStatusCode !== undefined) {
                if (loseReply) {
                    assert.equal(params.responseStatusCode, 200, 'reply loss follows a successful real commit');
                    loseReply = false;
                    lostReply = true;
                    await send('Fetch.failRequest', {requestId: params.requestId, errorReason: 'Failed'});
                } else await send('Fetch.continueRequest', {requestId: params.requestId});
                return true;
            }
            let raw = request.postData;
            if (raw === undefined) {
                const data = await send('Network.getRequestPostData', {requestId: params.networkId}) as {postData: string};
                raw = data.postData;
            }
            const input = JSON.parse(raw) as Submission;
            assert.equal(input.kind, 'review-verdict');
            assert.ok(input.capture);
            requests.push({sha256: hash(raw), input});
            // Never persist the UI capability or displayed nonce.
            await record('capture-requests', requests.map(({sha256, input}) => ({sha256,
                submissionId: input.submissionId, askId: input.askId, pageId: input.pageId,
                publicationId: input.publicationId, value: input.value,
                capture: {...input.capture, png: undefined, pngSha256: hash(Buffer.from(input.capture!.png.split(',')[1]!, 'base64'))}})));
            await send('Fetch.continueRequest', {requestId: params.requestId});
            return true;
        },
        dispose() {
            releaseEvents?.();
            fixture.host.ports.subscribeJob = subscribe;
        },
        async run(page: InputCdpSession, helpers: {
            wait(expression: string, what: string): Promise<void>;
            show(publication: JobPublication): Promise<void>;
            edit(selector: string, value: string): Promise<void>;
        }) {
            const {wait, show, edit} = helpers;
            try {
            const form = (id: string) => 'form[data-job-ask=' + JSON.stringify(id) + ']';
            const status = (id: string) => `document.querySelector(${JSON.stringify(form(id))}).querySelector('[role=status]')`;
            async function click(id: string) {
                await wait(`!!document.querySelector(${JSON.stringify(form(id))}) && !document.querySelector(${JSON.stringify(form(id))}).querySelector('fieldset').disabled`, 'enabled verdict');
                await page.evaluate(`document.querySelector(${JSON.stringify(form(id))}).querySelector('button[type=submit]').click()`);
            }
            async function ask(publication: JobPublication, words: string) {
                const pending = await fixture.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
                await wait(`!!document.querySelector(${JSON.stringify(form(pending.askId))})`, 'rig verdict form');
                await edit(form(pending.askId) + ' select[name=verdict]', 'approved');
                await edit(form(pending.askId) + ' textarea[name=note]', words);
                return pending;
            }
            async function rigPoint() {
                return page.evaluate<{x: number; y: number}>(`(()=>{const r=document.getElementById('rig-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
            }
            async function defaultView() {
                await edit('#job-part', '');
                await page.evaluate(`(()=>{const n=document.getElementById('job-solo');n.checked=false;n.dispatchEvent(new Event('change'));document.getElementById('rig-viewport').dispatchEvent(new Event('focusin',{bubbles:true}));document.getElementById('fit').click()})()`);
            }
            async function screenshot(name: string) {
                await writeFile(join(output, name + '.png'), await page.screenshot());
            }
            async function actualRaster(name: string) {
                const state = await page.evaluate<{connected: boolean; children: number; rasters: number;
                    animation: string; time: number; sourceHidden: boolean; greenPixels: number}>(`(()=>{
                    const root=document.getElementById('rig-root');
                    const pane=document.getElementById('rig-viewport');
                    const rasters=[...pane.querySelectorAll('[data-job-rig-presentation]')].filter(canvas=>{
                        const r=canvas.getBoundingClientRect(),s=getComputedStyle(canvas);
                        return canvas.width>0&&canvas.height>0&&r.width>0&&r.height>0&&s.visibility==='visible'&&s.display!=='none';
                    });
                    const data=rasters[0]?.getContext('2d').getImageData(0,0,rasters[0].width,rasters[0].height).data;
                    let greenPixels=0;
                    if(data)for(let i=0;i<data.length;i+=4)if(data[i+1]>data[i]&&data[i+1]>data[i+2])greenPixels++;
                    return {sourceHidden:getComputedStyle(root).visibility==='hidden',greenPixels,connected:!!root?.isConnected,children:root?.childElementCount??0,rasters:rasters.length,
                        animation:document.getElementById('job-animation').value,time:Number(document.getElementById('job-time').value)};})()`);
                await record(name + '-raster', state);
                assert.ok(state.connected && state.children > 0 && state.rasters === 1 && state.sourceHidden && state.greenPixels > 0,
                    new Error('JOB_STILL_BROWSER_RASTER_MISSING ' + JSON.stringify(state)));
                const shown = PNG.sync.read(await page.screenshot());
                const prior = await page.evaluate<string>(`(()=>{const canvas=document.querySelector('[data-job-rig-presentation]');const prior=canvas.style.visibility;canvas.style.visibility='hidden';return prior})()`);
                let hidden: PNG;
                try {hidden = PNG.sync.read(await page.screenshot());}
                finally {await page.evaluate(`document.querySelector('[data-job-rig-presentation]').style.visibility=${JSON.stringify(prior)}`);}
                assert.ok(!shown.data.equals(hidden.data), new Error('JOB_STILL_BROWSER_RASTER_EMPTY ' + name));
                return state;
            }
            async function pixels(name: string) {
                await record(name + '-admission', await admitStillOracle(page));
                const geometry = await page.evaluate<{dpr: number; x: number; y: number; width: number; height: number;
                    overlays: number; unsupported: string[]}>(`(()=>{
                    const pane=document.getElementById('rig-viewport'),r=pane.getBoundingClientRect();
                    const x=Math.ceil(r.left+pane.clientLeft),y=Math.ceil(r.top+pane.clientTop);
                    const unsupported=[];
                    for(let n=pane;n;n=n.parentElement){const s=getComputedStyle(n);if(s.transform!=='none'||s.filter!=='none'||s.opacity!=='1')unsupported.push(n.id||n.tagName)}
                    return {dpr:devicePixelRatio,x,y,width:Math.floor(r.left+pane.clientLeft+pane.clientWidth)-x,
                        height:Math.floor(r.top+pane.clientTop+pane.clientHeight)-y,
                        overlays:[...pane.querySelectorAll('canvas')].filter(n=>!document.getElementById('rig-root').contains(n)&&!n.hasAttribute('data-job-rig-presentation')&&n.width>0&&n.height>0&&getComputedStyle(n).visibility==='visible')
                            .reduce((count,n)=>{const c=n.getContext('2d');if(!c)return count+1;const d=c.getImageData(0,0,n.width,n.height).data;for(let i=3;i<d.length;i+=4)if(d[i])return count+1;return count},0),unsupported};})()`);
                assert.equal(geometry.dpr, 1, 'predeclared DPR 1 oracle');
                assert.deepEqual(geometry.unsupported, [], 'predeclared untransformed opaque viewport');
                assert.equal(geometry.overlays, 0, 'no UI overlay pixels admitted by the screenshot oracle');
                assert.ok(geometry.width > 0 && geometry.height > 0);
                const bytes = await page.screenshot({x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height});
                await writeFile(join(output, name + '-viewport.png'), bytes);
                await record(name + '-geometry', geometry);
                return PNG.sync.read(bytes);
            }
            async function compare(name: string, displayed: PNG, bytes: Buffer) {
                const exported = PNG.sync.read(bytes);
                assert.equal(exported.width, displayed.width);
                assert.equal(exported.height, displayed.height);
                let differentPixels = 0;
                const samples: unknown[] = [];
                for (let i = 0; i < displayed.data.length; i += 4) {
                    if (displayed.data.subarray(i, i + 4).equals(exported.data.subarray(i, i + 4))) continue;
                    differentPixels++;
                    if (samples.length < 16) samples.push({x: i / 4 % displayed.width, y: Math.floor(i / 4 / displayed.width),
                        displayed: [...displayed.data.subarray(i, i + 4)], exported: [...exported.data.subarray(i, i + 4)]});
                }
                await record(name + '-oracle', {width: exported.width, height: exported.height,
                    differentPixels, samples, tolerance: 0, region: 'every aligned Rig viewport RGBA pixel including background',
                    mode: observeOnly ? 'DIAGNOSTIC_ONLY' : 'ACCEPTANCE',
                    diagnosticOutcome: differentPixels === 0 ? 'EXACT_MATCH' : 'PIXEL_MISMATCH'});
                if (!observeOnly) assert.equal(differentPixels, 0, 'lossless actual displayed viewport equals exported PNG');
                return {differentPixels, tolerance: 0, diagnosticOutcome: differentPixels === 0 ? 'EXACT_MATCH' : 'PIXEL_MISMATCH'};
            }
            async function saved(id: string): Promise<JobRigReviewAct> {
                const events = (await fixture.next()).events;
                const event = events.find(event => event.type === 'act' && event.act.askId === id);
                assert.ok(event?.type === 'act' && event.act.schema === 'rig-review/act@3');
                return event.act;
            }
            async function cli(name: string, act: JobRigReviewAct, expectedExit = 0) {
                const directory = join(output, name + '-consumer');
                await mkdir(directory);
                const argv = [process.execPath, entry, 'session', 'fetch-act', fixture.locator, '--act', act.actId,
                    '--consumer-capability-stdin', '--still-out', directory];
                const child = Bun.spawn(argv, {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
                child.stdin.write(fixture.host.session.writerGrant().fetchCapability + '\n');
                child.stdin.end();
                const [stdout, stderr, exitCode] = await Promise.all([
                    new Response(child.stdout).arrayBuffer(), new Response(child.stderr).arrayBuffer(), child.exited]);
                const raw = Buffer.from(stdout);
                await writeFile(join(output, name + '.stdout.bin'), raw);
                await writeFile(join(output, name + '.stderr.bin'), Buffer.from(stderr));
                await record(name + '-cli', {argv, exitCode, stdoutBytes: raw.length, stdoutSha256: hash(raw),
                    stderrBytes: stderr.byteLength, stderrSha256: hash(Buffer.from(stderr))});
                assert.equal(exitCode, expectedExit);
                if (expectedExit !== 0) {
                    assert.equal(raw.length, 0);
                    assert.ok(Buffer.from(stderr).toString().includes('JOB_STILL_CAPTURE_FAILED'));
                    assert.deepEqual(await readdir(directory), []);
                    return Buffer.alloc(0);
                }
                assert.equal(stderr.byteLength, 0);
                const response = await fetch(fixture.locator + '/api', {method: 'POST',
                    headers: {'Content-Type': 'application/json', Accept: 'application/vnd.rig-review.act+json',
                        Authorization: 'Bearer ' + fixture.host.session.writerGrant().fetchCapability},
                    body: JSON.stringify({schema: JOB_API_SCHEMA, jobId: fixture.host.session.jobId,
                        requestId: randomUUID(), verb: 'fetch-act', actId: act.actId})});
                assert.equal(response.status, 200);
                assert.ok(raw.equals(Buffer.from(await response.arrayBuffer())), 'CLI preserves the exact negotiated daemon act bytes');
                // This consumer owns act.json and hashes the raw stdout itself.
                await writeFile(join(directory, 'act.json'), raw);
                assert.deepEqual(JSON.parse(raw.toString('utf8')), act);
                assert.ok(raw.equals(await readFile(join(directory, 'act.json'))));
                assert.equal(act.still.path, act.still.sha256 + '.png');
                const png = await readFile(join(directory, act.still.path));
                assert.equal(hash(png), act.still.sha256);
                return png;
            }
            async function authority(act: JobRigReviewAct, publication: JobPublication, id: string, words: string) {
                assert.equal(act.askId, id);
                assert.equal(act.publicationId, publication.publicationId);
                assert.deepEqual(act.source, publication.source);
                assert.equal(act.value.words, words);
                assert.equal(act.authority.actor, 'human');
                assert.equal(act.authority.channel, 'review-ui');
                assert.equal(act.still.camera, 'fixed');
                assert.equal(Object.hasOwn(act, 'sha256'), false);
                assert.equal(Object.hasOwn(act, 'manifest'), false);
                const request = requests.find(item => item.input.askId === id)!;
                assert.ok(request?.input.capture);
                const capture = request.input.capture;
                assert.equal(hash(Buffer.from(capture.png.split(',')[1]!, 'base64')), act.still.sha256);
                assert.equal(capture.binding.askId, id);
                assert.equal(capture.binding.publicationId, publication.publicationId);
                assert.equal(capture.binding.sourceHash, publication.source.sourceHash);
                assert.equal(capture.binding.pageId, request.input.pageId);
                assert.equal(capture.binding.instanceKey, publication.instanceKey);
                assert.ok(capture.binding.drawGeneration > 0 && capture.binding.playerGeneration >= 0);
                assert.equal(capture.playing, false, 'current job UI uses seek and pause');
            }

            let publication = await fixture.publish('rig');
            await show(publication);
            assert.equal(await page.evaluate('document.documentElement.lang'), language);
            assert.equal(await page.evaluate(`document.querySelector('.job-header select').value`), language);
            await defaultView();
            const sourceInputs = await jobInputHashes(fixture.input.root);
            await record('source-inputs-before', sourceInputs);
            await record('oracle-contract', {tolerance: 0, viewport: [1440, 960], dpr: 1,
                admitted: 'all whole device pixels inside the Rig client viewport, background included',
                excluded: 'border, fractional boundary pixels, hidden tool UI and labels',
                presentation: 'test-only overlay-free square frame, original inline styles restored in finally',
                unsupported: ['non-DPR-1', 'transformed/filtered/translucent ancestors', 'visible in-pane UI overlays',
                    'inside-Rig comparison compositor absent from current job UI', 'moving playback UI belongs to #559'],
                playback: 'actual job UI seek-and-pause, no production play loop'});
            await pixels('initial');
            // The pixel oracle must see the actual displayed Play canvas contribute pixels.
            await actualRaster('initial');

            let firstAct: JobRigReviewAct | undefined;
            for (const item of [{name: 'setup', animation: '', time: '0', frame: 'setup'},
                {name: 'numeric-zero', animation: 'inspect', time: '0', frame: 0},
                {name: 'numeric-375', animation: 'inspect', time: '0.375', frame: 0.375},
                {name: 'setup-return', animation: '', time: '0', frame: 'setup'}] as const) {
                await edit('#job-animation', item.animation);
                await edit('#job-time', item.time);
                const raster = await actualRaster(item.name);
                assert.equal(raster.animation, item.animation);
                assert.equal(raster.time, Number(item.time));
                const words = '  ' + language + ' ' + item.name + ' 원문\n';
                const pending = await ask(publication, words);
                const displayed = await pixels(item.name);
                await screenshot(item.name);
                await armStillObservation(page, pending.askId);
                await click(pending.askId);
                await wait(`${status(pending.askId)}.dataset.jobText==='job.saved'`, 'saved ' + item.name);
                const act = await saved(pending.askId);
                await authority(act, publication, pending.askId, words);
                assert.equal(act.still.frame, item.frame);
                if (item.animation) assert.equal(act.still.animation, item.animation);
                else assert.equal(Object.hasOwn(act.still, 'animation'), false);
                const exported = await cli(item.name, act);
                const request = requests.find(entry => entry.input.askId === pending.askId)!;
                await persistStillObservation(page, output, item.name, pending.askId, request.input.capture!, exported);
                const comparison = await compare(item.name, displayed, exported);
                assert.deepEqual(await jobInputHashes(fixture.input.root), sourceInputs);
                if (observeOnly) {
                    await record('source-inputs-after', await jobInputHashes(fixture.input.root));
                    await fixture.finish();
                    await record('observe-complete', {language, mode: 'DIAGNOSTIC_ONLY', productVerdict: 'NOT_EVALUATED',
                        stoppedAfter: 'setup', expectedPixelMismatchIsDiagnostic: true, comparison});
                    return;
                }
                firstAct ??= act;
            }

            await edit('#job-animation', 'inspect');
            await edit('#job-time', '0');
            const retryAsk = await ask(publication, '  immutable retry 원문\n');
            const retryPixels = await pixels('retry-first');
            heldEvents = new Promise(resolve => {releaseEvents = resolve;});
            loseReply = true;
            await click(retryAsk.askId);
            await wait(`${status(retryAsk.askId)}.textContent.length>0 && !document.querySelector(${JSON.stringify(form(retryAsk.askId))}).querySelector('fieldset').disabled`, 'committed reply lost');
            assert.ok(lostReply);
            const committed = await saved(retryAsk.askId);
            const firstRequest = requests.at(-1)!;
            await edit('#job-time', '0.375');
            const moved = await pixels('retry-seek');
            assert.ok(!moved.data.equals(retryPixels.data), 'seek actually changed displayed pixels before retry');
            await click(retryAsk.askId);
            await wait(`${status(retryAsk.askId)}.dataset.jobText==='job.saved'`, 'immutable retry saved');
            assert.equal(requests.at(-1)!.sha256, firstRequest.sha256);
            const replay = await saved(retryAsk.askId);
            assert.deepEqual(replay, committed);
            await authority(replay, publication, retryAsk.askId, '  immutable retry 원문\n');
            await compare('retry', retryPixels, await cli('retry', replay));
            releaseEvents!(); heldEvents = undefined;
            await screenshot('retry-success');

            for (const kind of ['pan', 'zoom', 'highlight', 'solo'] as const) {
                await defaultView();
                const pending = await ask(publication, 'refused ' + kind);
                const point = await rigPoint();
                await page.mouse('mousePressed', point.x, point.y);
                if (kind === 'pan') await page.mouse('mouseMoved', point.x + 18, point.y + 11);
                await page.mouse('mouseReleased', point.x + (kind === 'pan' ? 18 : 0), point.y + (kind === 'pan' ? 11 : 0));
                if (kind === 'zoom') await page.evaluate(`document.getElementById('zoom-in').click()`);
                if (kind === 'highlight' || kind === 'solo') {
                    await edit('#job-part', 'mesh');
                    if (kind === 'solo') await page.evaluate(`(()=>{const n=document.getElementById('job-solo');n.checked=true;n.dispatchEvent(new Event('change'))})()`);
                }
                const before = requests.length;
                await click(pending.askId);
                const code = kind === 'pan' || kind === 'zoom' ? 'JOB_STILL_CAMERA_NOT_FIXED' : 'JOB_STILL_VIEW_UNSUPPORTED';
                await wait(`${status(pending.askId)}.dataset.jobText===${JSON.stringify(code)}`, 'named ' + kind + ' refusal');
                assert.equal(await page.evaluate(`${status(pending.askId)}.textContent`), catalog[code]);
                assert.equal(requests.length, before);
                assert.ok(!(await fixture.next()).events.some(event => event.type === 'act' && event.act.askId === pending.askId));
                await screenshot('refused-' + kind);
                await record('refused-' + kind, {code, visibleMessage: catalog[code], sentRequests: 0});
            }
            await defaultView();

            const encodingAsk = await ask(publication, 'encoding old source');
            await page.evaluate(`(()=>{globalThis.__stillOldForm=document.querySelector(${JSON.stringify(form(encodingAsk.askId))});
                const original=HTMLCanvasElement.prototype.toBlob;globalThis.__stillEncodingHeld=false;
                HTMLCanvasElement.prototype.toBlob=function(...args){globalThis.__stillEncodingHeld=true;
                    globalThis.__stillReleaseEncoding=()=>{HTMLCanvasElement.prototype.toBlob=original;original.apply(this,args)}}})()`);
            const beforeEncoding = requests.length;
            await click(encodingAsk.askId);
            await wait('globalThis.__stillEncodingHeld===true', 'PNG encoder held after synchronous pixel copy');
            const prior = publication;
            publication = await fixture.publish('rig', 'rig-encoding-replacement');
            await show(publication);
            assert.notEqual(publication.source.sourceHash, prior.source.sourceHash);
            const changed = await jobInputHashes(fixture.input.root);
            assert.deepEqual(Object.keys(changed).filter(path => changed[path] !== sourceInputs[path]), ['out/review.json']);
            await page.evaluate('globalThis.__stillReleaseEncoding()');
            await wait(`globalThis.__stillOldForm.querySelector('[role=status]').textContent.includes('JOB_ACT_SOURCE_STALE')`, 'old encoding refuses after source replacement');
            assert.equal(requests.length, beforeEncoding);
            assert.ok(!(await fixture.next()).events.some(event => event.type === 'act' && event.act.askId === encodingAsk.askId));
            await record('encoding-source-replacement', {before: prior.source, after: publication.source,
                changedInputs: ['out/review.json'], sentRequests: 0, refusal: 'JOB_ACT_SOURCE_STALE'});
            await screenshot('source-replacement');

            // Auth and ordinary act lookup still execute before the declared PNG-read fault.
            const originalApi = fixture.host.ports.handleJobApi.bind(fixture.host.ports);
            let pngReadFaults = 0;
            fixture.host.ports.handleJobApi = async request => {
                const response = await originalApi(request);
                if (request.headers.get('accept') !== 'image/png' || !response.ok) return response;
                pngReadFaults++;
                return Response.json({ok: false, error: {code: 'JOB_STILL_CAPTURE_FAILED', message: 'Declared PNG read fault'}}, {status: 409});
            };
            try {await cli('negative-png-read', firstAct!, 1);}
            finally {fixture.host.ports.handleJobApi = originalApi;}
            assert.equal(pngReadFaults, 1);
            assert.deepEqual(await jobInputHashes(fixture.input.root), changed);
            await record('source-inputs-after', changed);
            await fixture.finish();
            await record('complete', {language, cases: ['setup', 'numeric-zero', 'numeric-375', 'setup-return', 'reply-loss-seek-retry',
                'pan', 'zoom', 'highlight', 'solo', 'encoding-source-replacement', 'negative-png-read'],
                movingPlaybackAcceptance: '#559', consumerPairStaging: 'consumer-owned, CLI owns PNG only'});
            } finally {
                const restoration = await restoreStillOracle(page);
                await record('oracle-presentation-restored', restoration);
                assert.ok(restoration.restored, new Error('JOB_STILL_ORACLE_STYLE_RESTORE_FAILED'));
            }
        },
    };
}
