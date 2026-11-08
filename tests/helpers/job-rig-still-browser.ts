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
type FocusSnapshot = {
    hasFocus: boolean; visibility: string; activeElement: unknown;
    timestamp: number; epochMs: number;
};
type ViewportIdentity = {
    initialPaneId: number | null; currentPaneId: number | null; samePane: boolean; paneConnected: boolean;
    initialRootId: number | null; currentRootId: number | null; sameRoot: boolean; rootConnected: boolean;
    initialWorkspaceId: number | null; currentWorkspaceId: number | null; sameWorkspace: boolean; workspaceConnected: boolean;
};
type CdpCommandTrace = {
    step: string; id: number | null; method: string; sessionId: string | null;
    payload: Record<string, unknown> | null;
    sendPerfMs: number; ackPerfMs: number; durationMs: number;
    sendEpochMs: number; ackEpochMs: number;
    status: 'ok' | 'error'; error?: string;
};
type PanSnapshot = {
    point: {x: number; y: number}; destination: {x: number; y: number};
    camera: {center: {x: number; y: number}; zoom: number};
    rect: {x: number; y: number; width: number; height: number};
    window: {width: number; height: number; visibility: string; hasFocus: boolean; activeElement: unknown};
    hasFocus: boolean; activeElement: unknown; viewportIdentity: ViewportIdentity;
    visible: boolean; hitInPane: boolean; destinationInPane: boolean; blocked: boolean;
    panning: boolean; captured: boolean; rootStyle: string | null; pressed: string | null;
};
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
            send: Send;
        }) {
            const {wait, show, edit, send} = helpers;
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
            async function panRig(): Promise<PanSnapshot> {
                // Observe trusted input, window/document focus, original viewport node identity and CDP mouse payloads without replacing product handlers.
                await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
                await page.evaluate(`(()=>{
                    if(Object.hasOwn(globalThis,'__jobStillPanProbe'))throw new Error('JOB_STILL_PAN_PROBE_ALREADY_ACTIVE');
                    const nodeIds=new WeakMap();let nextNodeId=1;
                    const idOf=n=>{
                        if(!n||(typeof n!=='object'&&typeof n!=='function'))return null;
                        let id=nodeIds.get(n);
                        if(!id){id=nextNodeId++;nodeIds.set(n,id);}
                        return id;
                    };
                    const pane=document.getElementById('rig-viewport'),root=document.getElementById('rig-root');
                    const workspace=document.querySelector('[data-job-workspace]');
                    const initialPaneId=idOf(pane),initialRootId=idOf(root),initialWorkspaceId=idOf(workspace);
                    const r=pane.getBoundingClientRect();
                    const point={x:r.x+r.width/2,y:r.y+r.height/2},destination={x:point.x+18,y:point.y+11};
                    const describe=n=>n===window?{kind:'window',id:'window'}:
                        n===document?{kind:'document',id:'document'}:
                        n instanceof Element?{kind:'element',nodeId:idOf(n),tag:n.tagName,id:n.id,className:n.getAttribute('class'),connected:n.isConnected}:
                        n instanceof Node?{kind:'node',nodeId:idOf(n),nodeName:n.nodeName,connected:n.isConnected}:null;
                    const events=[],focusEvents=[],mutations=[];let pointerId=null;
                    const focusState=()=>({
                        hasFocus:document.hasFocus(),
                        visibility:document.visibilityState,
                        activeElement:describe(document.activeElement),
                        timestamp:performance.now(),
                        epochMs:Date.now()
                    });
                    const viewportIdentity=()=>{
                        const currentPane=document.getElementById('rig-viewport'),currentRoot=document.getElementById('rig-root');
                        const currentWorkspace=document.querySelector('[data-job-workspace]');
                        return {
                            initialPaneId,currentPaneId:idOf(currentPane),samePane:currentPane===pane,paneConnected:!!pane?.isConnected,
                            initialRootId,currentRootId:idOf(currentRoot),sameRoot:currentRoot===root,rootConnected:!!root?.isConnected,
                            initialWorkspaceId,currentWorkspaceId:idOf(currentWorkspace),sameWorkspace:currentWorkspace===workspace,workspaceConnected:!!workspace?.isConnected
                        };
                    };
                    const snapshot=()=>{
                        const r=pane.getBoundingClientRect(),style=getComputedStyle(pane);
                        const hit=document.elementFromPoint(point.x,point.y),end=document.elementFromPoint(destination.x,destination.y);
                        const hasFocus=document.hasFocus(),activeElement=describe(document.activeElement);
                        return {point,destination,camera:JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig,
                            rect:r.toJSON(),window:{width:innerWidth,height:innerHeight,visibility:document.visibilityState,hasFocus,activeElement},
                            hasFocus,activeElement,viewportIdentity:viewportIdentity(),
                            visible:pane.isConnected&&document.visibilityState==='visible'&&style.display!=='none'&&style.visibility==='visible'&&
                                r.width>0&&r.height>0&&point.x>=0&&point.y>=0&&destination.x<innerWidth&&destination.y<innerHeight,
                            hit:describe(hit),destinationHit:describe(end),hitInPane:!!hit&&pane.contains(hit),destinationInPane:!!end&&pane.contains(end),
                            blocked:!!hit?.closest('button,input,select,textarea,a,[data-viewport-action],video[controls]'),
                            panning:pane.dataset.panning==='true',captured:pointerId!==null&&pane.hasPointerCapture(pointerId),
                            rootStyle:document.getElementById('rig-root').getAttribute('style'),
                            pressed:document.getElementById('job-play').getAttribute('aria-pressed')};
                    };
                    const trace=phase=>event=>{
                        if(event.type==='pointerdown')pointerId=event.pointerId;
                        events.push({kind:'pointer',type:event.type,phase,timestamp:performance.now(),epochMs:Date.now(),isTrusted:event.isTrusted,
                            pointerId:event.pointerId,pointerType:event.pointerType,isPrimary:event.isPrimary,
                            button:event.button,buttons:event.buttons,x:event.clientX,y:event.clientY,defaultPrevented:event.defaultPrevented,
                            hasFocus:document.hasFocus(),visibilityState:document.visibilityState,activeElement:describe(document.activeElement),
                            target:describe(event.target),path:event.composedPath().map(describe).filter(Boolean),
                            targetInPane:event.target instanceof Node&&pane.contains(event.target),sameTargetAsInitialPane:event.target===pane,state:snapshot()});
                    };
                    const traceFocus=(source,phase)=>event=>{
                        const entry={kind:'focus',source,type:event.type,phase,timestamp:performance.now(),epochMs:Date.now(),isTrusted:event.isTrusted,
                            targetKind:event.target===window?'window':event.target===document?'document':'element',
                            target:describe(event.target),relatedTarget:'relatedTarget' in event?describe(event.relatedTarget):null,
                            hasFocus:document.hasFocus(),visibilityState:document.visibilityState,activeElement:describe(document.activeElement),state:snapshot()};
                        focusEvents.push(entry);events.push(entry);
                    };
                    const observer=new MutationObserver(records=>{
                        for(const record of records){
                            if(record.type!=='childList')continue;
                            const removed=[...record.removedNodes].filter(n=>n instanceof Element);
                            const added=[...record.addedNodes].filter(n=>n instanceof Element);
                            if(removed.length===0&&added.length===0)continue;
                            const entry={kind:'mutation',timestamp:performance.now(),epochMs:Date.now(),
                                target:describe(record.target),removed:removed.map(describe),added:added.map(describe),
                                paneRemoved:removed.some(n=>n===pane||n.contains(pane)),
                                rootRemoved:removed.some(n=>n===root||(!!root&&n.contains(root))),
                                viewportIdentity:viewportIdentity(),hasFocus:document.hasFocus(),visibilityState:document.visibilityState};
                            mutations.push(entry);events.push(entry);
                        }
                    });
                    if(workspace)observer.observe(workspace,{childList:true,subtree:true});
                    else if(document.body)observer.observe(document.body,{childList:true,subtree:true});
                    const capture=trace('capture'),bubble=trace('bubble');
                    const winCapture=traceFocus('window','capture'),winBubble=traceFocus('window','bubble');
                    const docCapture=traceFocus('document','capture'),docBubble=traceFocus('document','bubble');
                    const types=['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture'];
                    const winFocusTypes=['focus','blur'],docFocusTypes=['visibilitychange','focusin','focusout'];
                    for(const type of types){document.addEventListener(type,capture,{capture:true,passive:true});document.addEventListener(type,bubble,{passive:true});}
                    for(const type of winFocusTypes){window.addEventListener(type,winCapture,{capture:true,passive:true});window.addEventListener(type,winBubble,{passive:true});}
                    for(const type of docFocusTypes){document.addEventListener(type,docCapture,{capture:true,passive:true});document.addEventListener(type,docBubble,{passive:true});}
                    globalThis.__jobStillPanProbe={snapshot,focusState,events,focusEvents,mutations,dispose(){
                        for(const type of types){document.removeEventListener(type,capture,true);document.removeEventListener(type,bubble);}
                        for(const type of winFocusTypes){window.removeEventListener(type,winCapture,true);window.removeEventListener(type,winBubble);}
                        for(const type of docFocusTypes){document.removeEventListener(type,docCapture,true);document.removeEventListener(type,docBubble);}
                        observer.disconnect();
                        try{return {timeOrigin:performance.timeOrigin,events,focusEvents,mutations,state:snapshot(),
                            restoration:{pointerListenersRemoved:true,focusListenersRemoved:true,mutationObserverDisconnected:true}};}
                        finally{delete globalThis.__jobStillPanProbe;}
                    }};
                })()`);
                const sample = () => page.evaluate<PanSnapshot>(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(globalThis.__jobStillPanProbe.snapshot()))))`);
                const readFocus = () => page.evaluate<FocusSnapshot>('globalThis.__jobStillPanProbe.focusState()');
                const cdpCommands: CdpCommandTrace[] = [];
                const originalWsSend = WebSocket.prototype.send;
                type WireSample = {id: number | null; method: string; sessionId: string | null; payload: Record<string, unknown>; sendPerfMs: number; sendEpochMs: number};
                let lastWire: WireSample | null = null;
                WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
                    if (typeof data === 'string') {
                        try {
                            const parsed = JSON.parse(data) as {id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string};
                            if (parsed.method === 'Input.dispatchMouseEvent' || parsed.method === 'Page.bringToFront') {
                                lastWire = {
                                    id: typeof parsed.id === 'number' ? parsed.id : null,
                                    method: parsed.method,
                                    sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
                                    payload: parsed.params ?? {},
                                    sendPerfMs: performance.now(),
                                    sendEpochMs: Date.now(),
                                };
                            }
                        } catch {}
                    }
                    return originalWsSend.call(this, data as never);
                };
                async function traceCdp<T>(step: string, expectedMethod: string, action: () => Promise<T>): Promise<T> {
                    lastWire = null;
                    const callPerfMs = performance.now(), callEpochMs = Date.now();
                    const pendingAction = action();
                    const wire = lastWire as WireSample | null;
                    lastWire = null;
                    try {
                        const result = await pendingAction;
                        const ackPerfMs = performance.now(), ackEpochMs = Date.now();
                        const sendPerfMs = wire?.sendPerfMs ?? callPerfMs;
                        cdpCommands.push({step, id: wire?.id ?? null, method: wire?.method ?? expectedMethod,
                            sessionId: wire?.sessionId ?? null, payload: wire?.payload ?? null,
                            sendPerfMs, ackPerfMs, durationMs: ackPerfMs - sendPerfMs,
                            sendEpochMs: wire?.sendEpochMs ?? callEpochMs, ackEpochMs, status: 'ok'});
                        return result;
                    } catch (error) {
                        const ackPerfMs = performance.now(), ackEpochMs = Date.now();
                        const sendPerfMs = wire?.sendPerfMs ?? callPerfMs;
                        cdpCommands.push({step, id: wire?.id ?? null, method: wire?.method ?? expectedMethod,
                            sessionId: wire?.sessionId ?? null, payload: wire?.payload ?? null,
                            sendPerfMs, ackPerfMs, durationMs: ackPerfMs - sendPerfMs,
                            sendEpochMs: wire?.sendEpochMs ?? callEpochMs, ackEpochMs, status: 'error',
                            error: error instanceof Error ? error.message : String(error)});
                        throw error;
                    }
                }
                let held = false;
                let before: PanSnapshot | undefined;
                let focusBeforeBringToFront: FocusSnapshot | null = null;
                let focusAfterBringToFront: FocusSnapshot | null = null;
                try {
                    await screenshot('pan-input-before');
                    focusBeforeBringToFront = await readFocus();
                    await traceCdp('bringToFront', 'Page.bringToFront', () => send('Page.bringToFront', {}));
                    focusAfterBringToFront = await readFocus();
                    before = await sample();
                    await record('pan-input-before', {...before, focusSetup: {beforeBringToFront: focusBeforeBringToFront, afterBringToFront: focusAfterBringToFront}});
                    assert.ok(before.visible && before.hitInPane && before.destinationInPane && !before.blocked,
                        new Error('JOB_STILL_PAN_TARGET_NOT_VISIBLE_OR_HITTABLE'));
                    assert.ok(before.viewportIdentity.samePane && before.viewportIdentity.paneConnected &&
                        before.viewportIdentity.sameRoot && before.viewportIdentity.rootConnected,
                        new Error('JOB_STILL_PAN_VIEWPORT_DISCONNECTED'));
                    assert.equal(before.hasFocus, true, 'owner document focused before pan gesture');
                    assert.equal(before.camera.zoom, 1);
                    assert.equal(before.pressed, 'false', 'paused pan refusal precondition');
                    held = true;
                    await traceCdp('mousePressed', 'Input.dispatchMouseEvent', () => page.mouse('mousePressed', before!.point.x, before!.point.y));
                    const down = await sample();
                    await record('pan-input-down', down);
                    assert.equal(await page.evaluate<boolean>(`globalThis.__jobStillPanProbe.events.some(event => event.type === 'pointerdown' && event.phase === 'bubble' && event.isTrusted && event.hasFocus === true && event.state.viewportIdentity.samePane === true && event.state.viewportIdentity.paneConnected === true)`),
                        true, 'owner document focused and original Rig viewport connected at pointerdown');
                    assert.equal(down.hasFocus, true, 'owner document focused after pointerdown');
                    assert.ok(down.viewportIdentity.samePane && down.viewportIdentity.paneConnected, new Error('JOB_STILL_PAN_VIEWPORT_REPLACED'));
                    assert.ok(down.panning && down.captured, new Error('JOB_STILL_PAN_POINTER_NOT_CAPTURED'));
                    assert.deepEqual(down.rect, before.rect, 'pan target geometry stays fixed after pointerdown');
                    await traceCdp('mouseMoved', 'Input.dispatchMouseEvent', () => page.mouse('mouseMoved', before!.destination.x, before!.destination.y));
                    const moved = await sample();
                    await record('pan-input-moved', moved);
                    assert.deepEqual(moved.rect, before.rect, 'pan target geometry stays fixed after pointermove');
                    assert.ok(moved.camera.center.x < before.camera.center.x && moved.camera.center.y > before.camera.center.y,
                        new Error('JOB_STILL_PAN_CAMERA_DID_NOT_MOVE'));
                    assert.equal(moved.camera.zoom, before.camera.zoom, 'pan preserves zoom');
                    assert.notEqual(moved.rootStyle, before.rootStyle, 'pan reaches the rendered Rig transform');
                    await traceCdp('mouseReleased', 'Input.dispatchMouseEvent', () => page.mouse('mouseReleased', before!.destination.x, before!.destination.y));
                    held = false;
                    const released = await sample();
                    await record('pan-input-released', released);
                    await screenshot('pan-input-released');
                    assert.equal(released.panning, false);
                    assert.equal(released.captured, false);
                    assert.deepEqual(released.camera, moved.camera, 'pan survives release and two animation frames');
                    const trace = await page.evaluate<{type: string; phase: string; isTrusted: boolean; targetInPane: boolean; buttons: number}[]>(
                        'globalThis.__jobStillPanProbe.events');
                    for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
                        assert.ok(trace.some(event => event.type === type && event.phase === 'bubble' && event.isTrusted && event.targetInPane &&
                            (type !== 'pointermove' || event.buttons === 1)), new Error('JOB_STILL_PAN_TRUSTED_EVENT_MISSING ' + type));
                    }
                    return released;
                } finally {
                    try {
                        if (held && before) {
                            await traceCdp('mouseReleasedFinally', 'Input.dispatchMouseEvent',
                                () => page.mouse('mouseReleased', before!.destination.x, before!.destination.y));
                        }
                    } finally {
                        WebSocket.prototype.send = originalWsSend;
                        const wsSendRestored = WebSocket.prototype.send === originalWsSend;
                        const final = await page.evaluate<Record<string, unknown>>(`globalThis.__jobStillPanProbe.dispose()`);
                        const probeDisposed = !(await page.evaluate<boolean>(`Object.hasOwn(globalThis,'__jobStillPanProbe')`));
                        await record('pan-input-trace', {
                            ...final,
                            focusSetup: {beforeBringToFront: focusBeforeBringToFront, afterBringToFront: focusAfterBringToFront},
                            cdpCommands,
                            restoration: {...(final.restoration as Record<string, unknown>), wsSendRestored, probeDisposed},
                        });
                        assert.equal(wsSendRestored, true, 'CDP WebSocket send wrapper restored');
                        assert.equal(probeDisposed, true, 'pan listeners and probe state disposed');
                    }
                }
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
            async function authority(act: JobRigReviewAct, publication: JobPublication, id: string, words: string, expectedPlaying = false) {
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
                assert.equal(capture.playing, expectedPlaying, expectedPlaying ? 'continuous playback active at capture' : 'paused seek-and-pause capture');
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
                pausedOracle: 'full-viewport screenshot compared at 0 tolerance against exported CLI PNG',
                movingOracle: 'synchronous HTMLCanvasElement.prototype.toBlob observation comparing displayed canonical bitmap == copied PNG == exported CLI PNG at 0 tolerance',
                unsupported: ['non-DPR-1', 'transformed/filtered/translucent ancestors', 'visible in-pane UI overlays',
                    'inside-Rig comparison compositor absent from current job UI'],
                playback: 'paused seek-and-pause plus continuous #job-play/#job-loop rAF playback (#559)'});
            const initialTransport = await page.evaluate<{animation: string; time: number; playDisabled: boolean;
                playPressed: string | null; playText: string | null; loopChecked: boolean; loopLabel: string | null;
                timeAfterTwoFrames: number}>(`new Promise(resolve => {
                const play = document.getElementById('job-play');
                const loop = document.getElementById('job-loop');
                const before = {
                    animation: document.getElementById('job-animation').value,
                    time: Number(document.getElementById('job-time').value),
                    playDisabled: play.disabled,
                    playPressed: play.getAttribute('aria-pressed'),
                    playText: play.textContent,
                    loopChecked: loop.checked,
                    loopLabel: loop.closest('label')?.querySelector('span')?.textContent ?? null,
                };
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    ...before,
                    timeAfterTwoFrames: Number(document.getElementById('job-time').value),
                })));
            })`);
            await record('initial-transport', initialTransport);
            assert.equal(initialTransport.animation, '');
            assert.equal(initialTransport.time, 0);
            assert.equal(initialTransport.timeAfterTwoFrames, 0);
            assert.equal(initialTransport.playDisabled, true);
            assert.equal(initialTransport.playPressed, 'false');
            assert.equal(initialTransport.playText, catalog.Play);
            assert.equal(initialTransport.loopChecked, true);
            assert.equal(initialTransport.loopLabel, catalog.Repeat);
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
                const beforeGesture = requests.length;
                let panned: PanSnapshot | undefined;
                if (kind === 'pan') panned = await panRig();
                else {
                    const point = await rigPoint();
                    await page.mouse('mousePressed', point.x, point.y);
                    await page.mouse('mouseReleased', point.x, point.y);
                }
                if (panned) {
                    const camera = await page.evaluate(`JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig`);
                    await record('pan-before-submit', {camera,expectedCamera:panned.camera,sentRequests:requests.length-beforeGesture});
                    assert.deepEqual(camera, panned.camera, 'established pan persists immediately before submission');
                    assert.equal(requests.length, beforeGesture, 'pan gesture sends no submission');
                }
                if (kind === 'zoom') await page.evaluate(`document.getElementById('zoom-in').click()`);
                if (kind === 'highlight' || kind === 'solo') {
                    await edit('#job-part', 'mesh');
                    if (kind === 'solo') await page.evaluate(`(()=>{const n=document.getElementById('job-solo');n.checked=true;n.dispatchEvent(new Event('change'))})()`);
                }
                const before = requests.length;
                const code = kind === 'pan' || kind === 'zoom' ? 'JOB_STILL_CAMERA_NOT_FIXED' : 'JOB_STILL_VIEW_UNSUPPORTED';
                try {
                    await click(pending.askId);
                    await wait(`${status(pending.askId)}.dataset.jobText===${JSON.stringify(code)}`, 'named ' + kind + ' refusal');
                    assert.equal(await page.evaluate(`${status(pending.askId)}.textContent`), catalog[code]);
                    assert.equal(requests.length, before);
                    assert.ok(!(await fixture.next()).events.some(event => event.type === 'act' && event.act.askId === pending.askId));
                } finally {
                    if (kind === 'pan') {
                        const outcome = await page.evaluate(`(()=>{const status=${status(pending.askId)};return {
                            code:status.dataset.jobText,text:status.textContent,
                            camera:JSON.parse(document.getElementById('view-coordinates').textContent).cameras.rig}})()`);
                        await record('pan-submit-outcome', {askId:pending.askId,expectedCode:code,sentRequests:requests.length-before,outcome});
                    }
                }
                await screenshot('refused-' + kind);
                await record('refused-' + kind, {code, visibleMessage: catalog[code], sentRequests: 0});
            }
            await defaultView();

            // #559: Continuous rAF playback, loop wrap, and mid-play verdict capture without pausing.
            await edit('#job-animation', 'inspect');
            await edit('#job-time', '0');
            const prePlay = await page.evaluate<{disabled: boolean; pressed: string | null; text: string | null;
                loopChecked: boolean; canonicalPng: string}>(`(()=>{
                const play=document.getElementById('job-play'),loop=document.getElementById('job-loop');
                loop.checked=true;loop.dispatchEvent(new Event('change'));
                const canvas=document.querySelector('[data-job-rig-presentation]');
                return {disabled:play.disabled,pressed:play.getAttribute('aria-pressed'),text:play.textContent,
                    loopChecked:loop.checked,canonicalPng:canvas.toDataURL('image/png')};})()`);
            assert.equal(prePlay.disabled, false);
            assert.equal(prePlay.pressed, 'false');
            assert.equal(prePlay.text, catalog.Play);
            assert.equal(prePlay.loopChecked, true);

            const midPlayWords = '  ' + language + ' mid-play-loop 원문\n';
            const midPlayAsk = await ask(publication, midPlayWords);
            await page.evaluate(`document.getElementById('job-play').click()`);
            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true' && Number(document.getElementById('job-time').value)>=0.6`, 'mid-play motion reaches >=0.6s');
            const beforeWrap = await page.evaluate<{time: number; pressed: string | null; text: string | null; canonicalPng: string}>(`(()=>{
                const play=document.getElementById('job-play'),canvas=document.querySelector('[data-job-rig-presentation]');
                return {time:Number(document.getElementById('job-time').value),pressed:play.getAttribute('aria-pressed'),
                    text:play.textContent,canonicalPng:canvas.toDataURL('image/png')};})()`);
            assert.equal(beforeWrap.pressed, 'true');
            assert.equal(beforeWrap.text, catalog.Pause);
            assert.ok(beforeWrap.time >= 0.6 && beforeWrap.time <= 1);
            assert.notEqual(beforeWrap.canonicalPng, prePlay.canonicalPng, 'real rAF motion renders different canonical pixels');

            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true' && Number(document.getElementById('job-time').value)>0 && Number(document.getElementById('job-time').value)<${JSON.stringify(beforeWrap.time - 0.2)}`, 'actual loop wrap decreases visible UI clock while playing');
            const afterWrap = await page.evaluate<{time: number; pressed: string | null; text: string | null}>(`(()=>{
                const play=document.getElementById('job-play');
                return {time:Number(document.getElementById('job-time').value),pressed:play.getAttribute('aria-pressed'),text:play.textContent};})()`);
            assert.equal(afterWrap.pressed, 'true');
            assert.equal(afterWrap.text, catalog.Pause);
            assert.ok(afterWrap.time > 0 && afterWrap.time < beforeWrap.time);

            await armStillObservation(page, midPlayAsk.askId);
            await page.evaluate(`(()=>{
                const s=globalThis.__jobStillObservation,realOriginal=s.original;
                globalThis.__midPlayRealOriginal=realOriginal;
                globalThis.__midPlayEncodingHeld=false;
                s.original=function(...args){
                    const play=document.getElementById('job-play');
                    globalThis.__midPlayEncodingHeld=true;
                    globalThis.__midPlayAtCapture={
                        time:Number(document.getElementById('job-time').value),
                        pressed:play.getAttribute('aria-pressed'),
                        text:play.textContent,
                    };
                    globalThis.__midPlayReleaseEncoding=()=>{s.original=realOriginal;return realOriginal.apply(this,args)};
                };
            })()`);
            let continuedWhileHeld: {atCapture: {time: number; pressed: string; text: string};
                afterTwoFrames: {time: number; pressed: string; text: string}};
            try {
                await click(midPlayAsk.askId);
                await wait('globalThis.__midPlayEncodingHeld===true', 'mid-play synchronous copy completed and encoder held');
                continuedWhileHeld = await page.evaluate<{atCapture: {time: number; pressed: string; text: string};
                    afterTwoFrames: {time: number; pressed: string; text: string}}>(`new Promise(resolve => {
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        const play=document.getElementById('job-play');
                        resolve({
                            atCapture: globalThis.__midPlayAtCapture,
                            afterTwoFrames: {
                                time: Number(document.getElementById('job-time').value),
                                pressed: play.getAttribute('aria-pressed'),
                                text: play.textContent,
                            },
                        });
                    }));
                })`);
                assert.equal(continuedWhileHeld.atCapture.pressed, 'true');
                assert.equal(continuedWhileHeld.atCapture.text, catalog.Pause);
                assert.equal(continuedWhileHeld.afterTwoFrames.pressed, 'true');
                assert.equal(continuedWhileHeld.afterTwoFrames.text, catalog.Pause);
                assert.notEqual(continuedWhileHeld.afterTwoFrames.time, continuedWhileHeld.atCapture.time, 'playback continues advancing while PNG encoding is held');
                await page.evaluate('globalThis.__midPlayReleaseEncoding()');
            } finally {
                await page.evaluate(`(()=>{if(globalThis.__jobStillObservation&&globalThis.__midPlayRealOriginal)globalThis.__jobStillObservation.original=globalThis.__midPlayRealOriginal})()`);
            }
            await wait(`${status(midPlayAsk.askId)}.dataset.jobText==='job.saved'`, 'saved mid-play-loop');
            const midPlayAct = await saved(midPlayAsk.askId);
            await authority(midPlayAct, publication, midPlayAsk.askId, midPlayWords, true);
            assert.equal(midPlayAct.still.animation, 'inspect');
            assert.ok(typeof midPlayAct.still.frame === 'number' && midPlayAct.still.frame >= 0 && midPlayAct.still.frame <= 1, 'wrapped visible frame within clip duration');
            const midPlayExported = await cli('mid-play-loop', midPlayAct);
            const midPlayRequest = requests.find(entry => entry.input.askId === midPlayAsk.askId)!;
            await persistStillObservation(page, output, 'mid-play-loop', midPlayAsk.askId, midPlayRequest.input.capture!, midPlayExported);
            await record('mid-play-loop', {beforeWrap: {time: beforeWrap.time, pressed: beforeWrap.pressed, text: beforeWrap.text},
                afterWrap, continuedWhileHeld, frame: midPlayAct.still.frame, playing: midPlayRequest.input.capture!.playing});

            // #559: Reply-loss while playing retains byte-exact first request across natural motion and manual seek.
            const midPlayRetryWords = '  ' + language + ' mid-play-retry 원문\n';
            const midPlayRetryAsk = await ask(publication, midPlayRetryWords);
            heldEvents = new Promise(resolve => {releaseEvents = resolve;});
            loseReply = true;
            await armStillObservation(page, midPlayRetryAsk.askId);
            await click(midPlayRetryAsk.askId);
            await wait(`${status(midPlayRetryAsk.askId)}.textContent.length>0 && !document.querySelector(${JSON.stringify(form(midPlayRetryAsk.askId))}).querySelector('fieldset').disabled`, 'mid-play committed reply lost');
            assert.ok(lostReply);
            const committedMidPlayRetry = await saved(midPlayRetryAsk.askId);
            const firstMidPlayRetryReq = requests.at(-1)!;
            assert.equal(firstMidPlayRetryReq.input.capture?.playing, true);
            await wait(`Number(document.getElementById('job-time').value)!==${JSON.stringify(firstMidPlayRetryReq.input.capture!.frame)}`, 'natural motion advances after first mid-play capture');
            await page.evaluate(`(()=>{
                const input=document.getElementById('job-time');
                input.focus();
                input.addEventListener('beforeinput',()=>{input.value=''},{once:true});
            })()`);
            await send('Input.insertText', {text: '0.375'});
            const typedWhilePlaying = await page.evaluate<{valueImmediate: string; valueAfterTwoFrames: string;
                pressedImmediate: string | null; pressedAfterTwoFrames: string | null;
                textImmediate: string | null; textAfterTwoFrames: string | null}>(`new Promise(resolve => {
                const input=document.getElementById('job-time'),play=document.getElementById('job-play');
                const valueImmediate=input.value,pressedImmediate=play.getAttribute('aria-pressed'),textImmediate=play.textContent;
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    valueImmediate,
                    valueAfterTwoFrames: input.value,
                    pressedImmediate,
                    pressedAfterTwoFrames: play.getAttribute('aria-pressed'),
                    textImmediate,
                    textAfterTwoFrames: play.textContent,
                })));
            })`);
            assert.equal(typedWhilePlaying.valueImmediate, '0.375');
            assert.equal(typedWhilePlaying.valueAfterTwoFrames, '0.375', 'rAF does not overwrite uncommitted #job-time typing');
            assert.equal(typedWhilePlaying.pressedImmediate, 'false', 'typing into #job-time immediately pauses playback');
            assert.equal(typedWhilePlaying.pressedAfterTwoFrames, 'false');
            assert.equal(typedWhilePlaying.textImmediate, catalog.Play);
            assert.equal(typedWhilePlaying.textAfterTwoFrames, catalog.Play);
            await page.evaluate(`(()=>{
                const input=document.getElementById('job-time');
                let changed=false;
                input.addEventListener('change',()=>{changed=true},{once:true});
                input.blur();
                if(!changed)input.dispatchEvent(new Event('change',{bubbles:true}));
            })()`);
            assert.equal(await page.evaluate(`Number(document.getElementById('job-time').value)`), 0.375);
            assert.equal(await page.evaluate(`document.getElementById('job-play').getAttribute('aria-pressed')`), 'false', 'manual seek pauses playback');
            await record('mid-play-time-input', typedWhilePlaying);
            await click(midPlayRetryAsk.askId);
            await wait(`${status(midPlayRetryAsk.askId)}.dataset.jobText==='job.saved'`, 'mid-play immutable retry saved');
            assert.equal(requests.at(-1)!.sha256, firstMidPlayRetryReq.sha256);
            const replayMidPlayRetry = await saved(midPlayRetryAsk.askId);
            assert.deepEqual(replayMidPlayRetry, committedMidPlayRetry);
            await authority(replayMidPlayRetry, publication, midPlayRetryAsk.askId, midPlayRetryWords, true);
            const midPlayRetryExported = await cli('mid-play-retry', replayMidPlayRetry);
            await persistStillObservation(page, output, 'mid-play-retry', midPlayRetryAsk.askId, firstMidPlayRetryReq.input.capture!, midPlayRetryExported);
            releaseEvents!(); heldEvents = undefined;

            // #559: Camera and selection refusals while playing send zero network posts.
            for (const kind of ['zoom', 'highlight'] as const) {
                await defaultView();
                await edit('#job-animation', 'inspect');
                await edit('#job-time', '0');
                await page.evaluate(`document.getElementById('job-play').click()`);
                await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true'`, 'playing before ' + kind + ' refusal');
                const pending = await ask(publication, 'refused playing ' + kind);
                if (kind === 'zoom') await page.evaluate(`document.getElementById('zoom-in').click()`);
                else await edit('#job-part', 'mesh');
                const before = requests.length;
                await click(pending.askId);
                const code = kind === 'zoom' ? 'JOB_STILL_CAMERA_NOT_FIXED' : 'JOB_STILL_VIEW_UNSUPPORTED';
                await wait(`${status(pending.askId)}.dataset.jobText===${JSON.stringify(code)}`, 'named playing ' + kind + ' refusal');
                assert.equal(await page.evaluate(`${status(pending.askId)}.textContent`), catalog[code]);
                assert.equal(await page.evaluate(`document.getElementById('job-play').getAttribute('aria-pressed')`), 'true');
                assert.equal(requests.length, before);
                assert.ok(!(await fixture.next()).events.some(event => event.type === 'act' && event.act.askId === pending.askId));
                await record('refused-playing-' + kind, {code, visibleMessage: catalog[code], sentRequests: 0, playing: true});
            }
            await defaultView();

            // #559: Toggle Repeat off at mid-clip deterministically seeks current visible time and finishes one-shot paused at exact duration.
            await edit('#job-animation', 'inspect');
            await edit('#job-time', '0');
            await page.evaluate(`(()=>{const loop=document.getElementById('job-loop');loop.checked=true;loop.dispatchEvent(new Event('change'));document.getElementById('job-play').click()})()`);
            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true' && Number(document.getElementById('job-time').value)>=0.15 && Number(document.getElementById('job-time').value)<=0.65`, 'mid-clip reached before Repeat toggle');
            const toggledMidClip = await page.evaluate<{timeAtToggle: number; pressedAfterToggle: string | null; loopChecked: boolean}>(`(()=>{
                const loop=document.getElementById('job-loop'),play=document.getElementById('job-play');
                loop.checked=false;loop.dispatchEvent(new Event('change'));
                return {timeAtToggle:Number(document.getElementById('job-time').value),pressedAfterToggle:play.getAttribute('aria-pressed'),loopChecked:loop.checked};})()`);
            assert.equal(toggledMidClip.loopChecked, false);
            assert.equal(toggledMidClip.pressedAfterToggle, 'true');
            assert.ok(toggledMidClip.timeAtToggle > 0 && toggledMidClip.timeAtToggle < 1);
            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='false' && Number(document.getElementById('job-time').value)===1`, 'one-shot finishes paused at exact duration');
            const oneShotEnd = await page.evaluate<{time: number; timeAfterTwoFrames: number; pressed: string | null; text: string | null}>(`new Promise(resolve => {
                const play=document.getElementById('job-play'),time=Number(document.getElementById('job-time').value);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    time,
                    timeAfterTwoFrames: Number(document.getElementById('job-time').value),
                    pressed: play.getAttribute('aria-pressed'),
                    text: play.textContent,
                })));
            })`);
            assert.equal(oneShotEnd.time, 1);
            assert.equal(oneShotEnd.timeAfterTwoFrames, 1);
            assert.equal(oneShotEnd.pressed, 'false');
            assert.equal(oneShotEnd.text, catalog.Play);
            const repeatReenabledAtEnd = await page.evaluate<{loopChecked: boolean; time: string; numericTime: number;
                timeAfterTwoFrames: number; pressed: string | null; text: string | null}>(`new Promise(resolve => {
                const loop=document.getElementById('job-loop'),play=document.getElementById('job-play'),clock=document.getElementById('job-time');
                loop.checked=true;loop.dispatchEvent(new Event('change'));
                const time=clock.value,numericTime=Number(clock.value);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    loopChecked: loop.checked,
                    time,
                    numericTime,
                    timeAfterTwoFrames: Number(clock.value),
                    pressed: play.getAttribute('aria-pressed'),
                    text: play.textContent,
                })));
            })`);
            assert.equal(repeatReenabledAtEnd.loopChecked, true);
            assert.equal(repeatReenabledAtEnd.time, '0');
            assert.equal(repeatReenabledAtEnd.numericTime, 0);
            assert.equal(repeatReenabledAtEnd.timeAfterTwoFrames, 0);
            assert.equal(repeatReenabledAtEnd.pressed, 'false');
            assert.equal(repeatReenabledAtEnd.text, catalog.Play);
            await edit('#job-time', '0.375');
            assert.equal(await page.evaluate(`document.getElementById('job-time').value`), '0.375');
            await edit('#job-time', '1');
            const manualSeekAtDuration = await page.evaluate<{loopChecked: boolean; time: string; numericTime: number;
                pressed: string | null; text: string | null}>(`(()=>{
                const loop=document.getElementById('job-loop'),play=document.getElementById('job-play'),clock=document.getElementById('job-time');
                return {loopChecked:loop.checked,time:clock.value,numericTime:Number(clock.value),
                    pressed:play.getAttribute('aria-pressed'),text:play.textContent};})()`);
            assert.equal(manualSeekAtDuration.loopChecked, true);
            assert.equal(manualSeekAtDuration.time, '0');
            assert.equal(manualSeekAtDuration.numericTime, 0);
            assert.equal(manualSeekAtDuration.pressed, 'false');
            assert.equal(manualSeekAtDuration.text, catalog.Play);
            await record('repeat-off-oneshot', {toggledMidClip, oneShotEnd, repeatReenabledAtEnd, manualSeekAtDuration});

            // #559: Source-compatible replacement while playing pauses outgoing playback and preserves animation/time/selection/camera.
            await edit('#job-animation', 'inspect');
            await edit('#job-time', '0.25');
            await edit('#job-part', 'mesh');
            await page.evaluate(`(()=>{document.getElementById('zoom-in').click();document.getElementById('job-play').click()})()`);
            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true'`, 'playing before source replacement');
            const priorPlayingPub = publication;
            publication = await fixture.publish('rig', 'rig-playing-replacement');
            await show(publication);
            const afterPlayingReplacement = await page.evaluate<{animation: string; part: string; zoom: number;
                pressed: string | null; text: string | null; time: number; timeAfterTwoFrames: number}>(`new Promise(resolve => {
                const play=document.getElementById('job-play');
                const view=JSON.parse(document.getElementById('view-coordinates').textContent);
                const time=Number(document.getElementById('job-time').value);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    animation: document.getElementById('job-animation').value,
                    part: document.getElementById('job-part').value,
                    zoom: view.cameras.rig.zoom,
                    pressed: play.getAttribute('aria-pressed'),
                    text: play.textContent,
                    time,
                    timeAfterTwoFrames: Number(document.getElementById('job-time').value),
                })));
            })`);
            assert.equal(afterPlayingReplacement.pressed, 'false');
            assert.equal(afterPlayingReplacement.text, catalog.Play);
            assert.equal(afterPlayingReplacement.animation, 'inspect');
            assert.equal(afterPlayingReplacement.part, 'mesh');
            assert.ok(afterPlayingReplacement.zoom > 1);
            assert.equal(afterPlayingReplacement.timeAfterTwoFrames, afterPlayingReplacement.time);
            await record('playing-source-replacement', {before: priorPlayingPub.source.sourceHash,
                after: publication.source.sourceHash, state: afterPlayingReplacement});
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
            await edit('#job-animation', 'inspect');
            await page.evaluate(`document.getElementById('job-play').click()`);
            await wait(`document.getElementById('job-play').getAttribute('aria-pressed')==='true'`, 'playing before explicit job close');
            await fixture.finish();
            await wait(`document.querySelector('.job-notice').textContent===${JSON.stringify(catalog['job.closed'])} && document.getElementById('job-play').getAttribute('aria-pressed')==='false'`, 'explicit job close stops playback');
            const afterClose = await page.evaluate<{notice: string | null; pressed: string | null; text: string | null;
                timeAtClose: number; timeAfterTwoFrames: number}>(`new Promise(resolve => {
                const play=document.getElementById('job-play'),clock=document.getElementById('job-time');
                const timeAtClose=Number(clock.value);
                requestAnimationFrame(() => requestAnimationFrame(() => resolve({
                    notice: document.querySelector('.job-notice')?.textContent ?? null,
                    pressed: play.getAttribute('aria-pressed'),
                    text: play.textContent,
                    timeAtClose,
                    timeAfterTwoFrames: Number(clock.value),
                })));
            })`);
            assert.equal(afterClose.notice, catalog['job.closed']);
            assert.equal(afterClose.pressed, 'false');
            assert.equal(afterClose.text, catalog.Play);
            assert.equal(afterClose.timeAfterTwoFrames, afterClose.timeAtClose);
            await record('closed-stops-playback', afterClose);
            await record('complete', {language, cases: ['setup', 'numeric-zero', 'numeric-375', 'setup-return', 'reply-loss-seek-retry',
                'pan', 'zoom', 'highlight', 'solo', 'mid-play-loop', 'mid-play-retry', 'refused-playing-zoom',
                'refused-playing-highlight', 'repeat-off-oneshot', 'playing-source-replacement',
                'encoding-source-replacement', 'negative-png-read'],
                movingPlaybackAcceptance: 'COVERED_559', consumerPairStaging: 'consumer-owned, CLI owns PNG only'});
            } finally {
                const restoration = await restoreStillOracle(page);
                await record('oracle-presentation-restored', restoration);
                assert.ok(restoration.restored, new Error('JOB_STILL_ORACLE_STYLE_RESTORE_FAILED'));
            }
        },
    };
}
