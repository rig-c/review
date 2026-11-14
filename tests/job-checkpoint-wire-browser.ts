/** Dedicated ordinary Nova browser verification for #630 compiled wire inspector at meshes checkpoints.
 * Fixture provenance: synthetic compiled inline/generated-kind geometry (manually augmented JSON on
 * tests/fixtures/viewport-387/package, not a producer run or actual v15 proof).
 * Run: bun run tests/job-checkpoint-wire-browser.ts --lang en (or --lang ko)
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import type {JobNextValue, JobPendingAsk, JobSubject} from '../src/job-contract.ts';
import {projectComments,feedbackItemComments,parseStageComment} from '../src/stage-comment.ts';
import type {Feedback} from '../src/session.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const FIXTURE_PROVENANCE =
    'synthetic compiled inline/generated-kind geometry (manually augmented JSON on tests/fixtures/viewport-387/package, not a producer run or actual v15 proof)';

const argument = (key: string) => {
    const index = Bun.argv.indexOf(key);
    return index < 0 ? undefined : Bun.argv[index + 1];
};
const language = argument('--lang') ?? 'en';
assert.ok(language === 'en' || language === 'ko');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = argument('--out') ?? 'evidence/job-checkpoint-wire-' + language;
await mkdir(output, {recursive: true});

const fixture = await realJobWindowFixture();
const packageRoot = join(fixture.input.root, 'out');
const profile = await mkdtemp(join(tmpdir(), 'review-job-wire-630-'));
const observations: Record<string, unknown> = {};
const browserEvents: unknown[] = [];
let page: InputCdpSession | null = null;
let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;

async function pressKey(key: 'i' | 'm' | 'b') {
    const codes = {
        i: {code: 'KeyI', windowsVirtualKeyCode: 73},
        m: {code: 'KeyM', windowsVirtualKeyCode: 77},
        b: {code: 'KeyB', windowsVirtualKeyCode: 66},
    };
    assert.ok(control);
    await control('Input.dispatchKeyEvent', {type: 'keyDown', key, text: key, ...codes[key]});
    await control('Input.dispatchKeyEvent', {type: 'keyUp', key, ...codes[key]});
}

async function dragMouse(fromX: number, fromY: number, toX: number, toY: number) {
    assert.ok(control);
    await control('Input.dispatchMouseEvent', {type: 'mouseMoved', x: fromX, y: fromY, button: 'none', buttons: 0});
    await control('Input.dispatchMouseEvent', {type: 'mousePressed', x: fromX, y: fromY, button: 'left', buttons: 1, clickCount: 1});
    await control('Input.dispatchMouseEvent', {type: 'mouseMoved', x: toX, y: toY, button: 'left', buttons: 1});
    await control('Input.dispatchMouseEvent', {type: 'mouseReleased', x: toX, y: toY, button: 'left', buttons: 0, clickCount: 1});
}

async function ask(publication: {publicationId: string}, subject: JobSubject): Promise<JobPendingAsk> {
    const res = await fixture.call({
        ...fixture.input.base(),
        verb: 'ask',
        expectedGeneration: fixture.host.session.status().generation,
        idempotencyKey: 'ask-' + randomUUID(),
        publicationId: publication.publicationId,
        subject,
    });
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.value as JobPendingAsk;
}

async function nextEvents(): Promise<JobNextValue> {
    const res = await fixture.call({
        ...fixture.input.base(),
        verb: 'next',
        after: null,
        waitMs: 0,
    });
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    return body.value as JobNextValue;
}

async function finishJob(): Promise<void> {
    const res = await fixture.call({
        ...fixture.input.base(),
        verb: 'close',
        expectedGeneration: fixture.host.session.status().generation,
        idempotencyKey: 'close-' + randomUUID(),
        reason: 'job-checkpoint-wire complete',
    });
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
}

async function record(name: string, value: unknown) {
    observations[name] = value;
    await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2));
    console.log('job-checkpoint-wire ' + language + ' ' + name);
}

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(25);
    }
    throw new Error('JOB_WIRE_WAIT_FAILED ' + what);
}

async function wait(expression: string, what: string): Promise<void> {
    await until(() => page!.evaluate<boolean>(expression), what);
}

async function edit(selector: string, value: string) {
    await page!.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}

try {
    await record('fixture-provenance', FIXTURE_PROVENANCE);

    // Augment the compiled model with synthetic compiled inline/generated-kind geometry
    // (manually augmented JSON on tests/fixtures/viewport-387/package, not a producer run or actual v15 proof).
    const modelPath = join(packageRoot, 'skeleton.model.json');
    const manifestPath = join(packageRoot, 'review.json');
    const model = JSON.parse(await readFile(modelPath, 'utf8'));
    model.slots.unshift({name: 'rigid', bone: 'rigid', setup: 'rigid'});
    model.skins[0].attachments.rigid = {
        rigid: {
            kind: 'mesh',
            path: 'rigid',
            uvs: [0, 1, 0, 0, 1, 0],
            triangles: [0, 1, 2],
            vertices: {weighted: false, xy: [-8, -8, -8, 8, 8, 8]},
            hull: 3,
            edges: [0, 2, 2, 4, 4, 0],
            width: 16,
            height: 16,
        },
    };
    model.editorOrder.skins[0].slots = ['rigid', 'mesh'];
    model.meshBones = ['rigid', 'mesh'];
    model.meshes = [
        {
            slot: 'rigid',
            kind: 'generated',
            attachments: ['rigid'],
            vertices: 3,
            triangles: 1,
            bones: ['rigid'],
            coverage: 1,
            overshoot: 0,
        },
        ...model.meshes,
    ];
    model.rig.meshKinds.rigid = 'generated';
    model.rig.meshDeclaredBones.rigid = ['rigid'];
    await writeFile(modelPath, JSON.stringify(model));

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.checkpoints = [
        ...(manifest.checkpoints ?? []),
        {
            id: 'meshes',
            title: 'Meshes',
            note: 'Verify inline and generated mesh triangles and bone points',
            planStep: 'inspect-body',
        },
        {
            id: 'step-one',
            title: 'Step One',
            note: 'Second checkpoint for reconnect and publication swap verification',
            planStep: 'step-one',
        },
    ];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const prevContext = fixture.input.getContext();
    fixture.input.setContext({
        ...prevContext,
        plan: {
            steps: [
                {id: 'inspect-body', hash: 'b'.repeat(64)},
                {id: 'step-one', hash: '1'.repeat(64)},
            ],
        },
        partIds: ['rigid', 'mesh'],
        subjects: [
            {kind: 'checkpoint', checkpointId: 'meshes', planStepId: 'inspect-body'},
            {kind: 'checkpoint', checkpointId: 'step-one', planStepId: 'step-one'},
            {kind: 'review-verdict', stage: 'rig-review'},
        ],
    });

    page = await launchCdpSession(profile, {
        async onEvent(event, send) {
            if (event.sessionId) control = send;
            if (event.method === 'Runtime.exceptionThrown' || event.method === 'Network.loadingFailed') {
                browserEvents.push(event);
            }
        },
    });
    await page.setViewport(1440, 960);
    const owner = new URL(fixture.host.ownerUrl);
    owner.searchParams.set('lang', language);
    await page.goto(owner.href);

    const immutableInputs = await jobInputHashes(fixture.input.root);
    const rig = await fixture.publish();
    await wait(`document.getElementById('package-title')?.textContent===${JSON.stringify(rig.label)}&&!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#stage-comment-list')`, 'shared rig display');
    const sharedLayers=()=>page!.evaluate<{visible:boolean;enabled:boolean;images:boolean;mesh:boolean;bones:boolean;overlayPixels:number}>(`(()=>{
      const field=document.getElementById('layer-controls'),box=field.getBoundingClientRect(),overlay=document.getElementById('rig-overlay');
      const pixels=overlay.getContext('2d').getImageData(0,0,overlay.width,overlay.height).data;
      return {visible:!field.hidden&&getComputedStyle(field).display!=='none'&&box.width>0&&box.height>0,
        enabled:['layer-images','layer-mesh','layer-bones'].every(id=>!document.getElementById(id).disabled),
        images:document.getElementById('layer-images').checked,mesh:document.getElementById('layer-mesh').checked,bones:document.getElementById('layer-bones').checked,
        overlayPixels:pixels.filter((value,index)=>index%4===3&&value>0).length};})()`);
    const initialState=await sharedLayers();
    // #768:5-7 / #796: shared-shell availability replaces the deleted ask-only hidden/disabled gate.
    assert.equal(initialState.visible,true);assert.equal(initialState.enabled,true);
    assert.equal(initialState.images,true);assert.equal(initialState.mesh,false);assert.equal(initialState.bones,false);
    assert.equal(initialState.overlayPixels,0,'initial shared overlay is empty');
    await record('initial-shared-layer-state',initialState);
    // #768:5-7 / #796 (368ffec): legacy ask-only layer gate and Background widget are deleted.
    const cpAsk = await ask(rig, {kind: 'checkpoint', checkpointId: 'meshes', planStepId: 'inspect-body'});
    await wait(`!!document.querySelector('form[data-job-ask="${cpAsk.askId}"] fieldset:not(:disabled)')`, 'meshes checkpoint form');
    const cpState = await page.evaluate<{disabled:boolean;titles:string[]}>(`({disabled:['layer-images','layer-mesh','layer-bones'].some(id=>document.getElementById(id).disabled),titles:[...document.querySelectorAll('#layer-controls .layer-toggle')].map(el=>el.title)})`);
    assert.equal(cpState.disabled,false,'shared layer checkboxes are enabled');
    assert.equal((await sharedLayers()).visible,true,'checkpoint shared layer controls are visible');
    assert.deepEqual(cpState.titles,([['Images','I'],['Mesh edges','M'],['Bone points','B']] as const).map(([label,key])=>catalog['{0} · key {1}'].replace('{0}',catalog[label]).replace('{1}',key)));
    await record('shared-checkpoint-controls',cpState);
    await click(page,'[data-mode="rig"]');
    await click(page,'#rig-viewport');
    // b433 / #796/#798: delete legacy tabindex attribute equality only; real keyboard/focus/geometry assertions remain.
    await pressKey('m');await pressKey('b');
    await wait(`document.getElementById('layer-mesh').checked&&document.getElementById('layer-bones').checked`,'M/B shared shortcuts');

    const readOverlayAlignment = () =>
        page!.evaluate<{
            activeElementId: string | null;
            textEntryFocused: boolean;
            width: number;
            height: number;
            leftHalfPixels: number;
            rightHalfPixels: number;
            totalPixels: number;
            centroidX: number;
            centroidY: number;
            rootLeft: number;
            rootTop: number;
            viewportCenterX: number;
            viewportCenterY: number;
        }>(`(()=>{
            const vp = document.getElementById('rig-viewport');
            const rect = vp.getBoundingClientRect();
            const root = document.getElementById('rig-root');
            const overlay = document.getElementById('rig-overlay');
            const ctx = overlay.getContext('2d');
            const {width, height} = overlay;
            const data = ctx.getImageData(0, 0, width, height).data;
            let leftHalfPixels = 0;
            let rightHalfPixels = 0;
            let sumX = 0;
            let sumY = 0;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const a = data[(y * width + x) * 4 + 3];
                    if (a > 0) {
                        if (x < width / 2) leftHalfPixels++;
                        else rightHalfPixels++;
                        sumX += x;
                        sumY += y;
                    }
                }
            }
            const dpr = window.devicePixelRatio || 1;
            const totalPixels = leftHalfPixels + rightHalfPixels;
            return {
                activeElementId: document.activeElement?.id ?? null,
                textEntryFocused: !!document.activeElement && (
                    document.activeElement.matches('textarea,select') || document.activeElement.isContentEditable ||
                    (document.activeElement.tagName === 'INPUT' && !['checkbox','radio','button','submit','reset','range','color','file','image'].includes(document.activeElement.type))
                ),
                width,
                height,
                leftHalfPixels,
                rightHalfPixels,
                totalPixels,
                centroidX: totalPixels > 0 ? sumX / totalPixels / dpr : 0,
                centroidY: totalPixels > 0 ? sumY / totalPixels / dpr : 0,
                rootLeft: Number.parseFloat(root.style.left || '0'),
                rootTop: Number.parseFloat(root.style.top || '0'),
                viewportCenterX: Math.round(rect.left + rect.width / 2),
                viewportCenterY: Math.round(rect.top + rect.height / 2),
            };
        })()`);

    const overlayStats = await readOverlayAlignment();
    // 305941 / #796/#798: document-bound shortcuts (web/view-controls.ts:84-97), not a focusable viewport ID.
    assert.equal(overlayStats.textEntryFocused, false, 'M/B shortcuts run outside text/select/textarea entry');
    assert.ok(overlayStats.leftHalfPixels > 20, 'synthetic generated-kind mesh slot (rigid, left side) and bone points are drawn on #rig-overlay');
    assert.ok(overlayStats.rightHalfPixels > 20, 'inline mesh slot (mesh, right side) and bone points are drawn on #rig-overlay');
    // #768:5-7 / #796: removed automatic canonical marker/presentation assertions.
    await record('overlay-mesh-and-bones-drawn', overlayStats);

    // 3b. Camera pan & fit alignment: open Settings and focus its real Theme selector first, then drag #rig-viewport
    // to prove pointer interaction leaves text entry and rigProject tracks live pan/fit transforms.
    const focusBaseline=await page.evaluate(`({mode:document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode,time:document.getElementById('scrub').value})`);
    if(!await page.evaluate(`document.getElementById('settings-toggle').getAttribute('aria-expanded')==='true'`))await click(page,'#settings-toggle');
    await wait(`!document.getElementById('settings-body').hidden&&document.getElementById('settings-theme').getClientRects().length>0`,'visible shared Settings select');
    await click(page,'#settings-theme');
    assert.ok(control);
    await control('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await control('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await page.evaluate<string | null>(`document.activeElement?.id ?? null`), 'settings-theme');
    assert.equal((await readOverlayAlignment()).textEntryFocused,true,'deliberate visible select focus before viewport pointer drag');
    await dragMouse(
        overlayStats.viewportCenterX,
        overlayStats.viewportCenterY,
        overlayStats.viewportCenterX + 36,
        overlayStats.viewportCenterY + 24,
    );
    const pannedStats = await readOverlayAlignment();
    const deltaRootLeft = pannedStats.rootLeft - overlayStats.rootLeft;
    const deltaRootTop = pannedStats.rootTop - overlayStats.rootTop;
    const deltaCentroidX = pannedStats.centroidX - overlayStats.centroidX;
    const deltaCentroidY = pannedStats.centroidY - overlayStats.centroidY;
    assert.equal(pannedStats.textEntryFocused, false, 'pointerdown on #rig-viewport leaves text/select/textarea entry');
    assert.ok(deltaRootLeft > 20 && deltaRootTop > 12, 'dragging #rig-viewport pans #rig-root');
    assert.ok(Math.abs(deltaCentroidX - deltaRootLeft) < 3, 'wire overlay X centroid tracks live pan transform');
    assert.ok(Math.abs(deltaCentroidY - deltaRootTop) < 3, 'wire overlay Y centroid tracks live pan transform');
    // Real M key effect after leaving the select: checkbox AND rendered overlay must change, then restore.
    await pressKey('m');
    await wait(`!document.getElementById('layer-mesh').checked`,'M disables mesh after viewport focus');
    let meshOff=await readOverlayAlignment();
    await until(async()=>{meshOff=await readOverlayAlignment();return meshOff.totalPixels<pannedStats.totalPixels;},'M changes actual mesh overlay after pointer drag');
    assert.ok(meshOff.totalPixels>0,'bone overlay remains while mesh is off');
    await pressKey('m');
    await wait(`document.getElementById('layer-mesh').checked`,'M restores mesh after viewport focus');
    await until(async()=>(await readOverlayAlignment()).totalPixels>meshOff.totalPixels,'M restores actual mesh overlay');
    assert.deepEqual(await page.evaluate(`({mode:document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode,time:document.getElementById('scrub').value})`),focusBaseline,'focus/keyboard probe preserves mode and inspected time');

    await page.evaluate(`document.getElementById('fit').click()`);
    const refittedStats = await readOverlayAlignment();
    assert.ok(Math.abs(refittedStats.rootLeft - overlayStats.rootLeft) < 1, '#fit restores #rig-root X');
    assert.ok(Math.abs(refittedStats.rootTop - overlayStats.rootTop) < 1, '#fit restores #rig-root Y');
    assert.ok(Math.abs(refittedStats.centroidX - overlayStats.centroidX) < 1.5, '#fit restores wire overlay X centroid');
    assert.ok(Math.abs(refittedStats.centroidY - overlayStats.centroidY) < 1.5, '#fit restores wire overlay Y centroid');
    await record('camera-pan-and-fit-alignment', {
        before: {rootLeft: overlayStats.rootLeft, rootTop: overlayStats.rootTop, centroidX: overlayStats.centroidX, centroidY: overlayStats.centroidY},
        panned: {rootLeft: pannedStats.rootLeft, rootTop: pannedStats.rootTop, centroidX: pannedStats.centroidX, centroidY: pannedStats.centroidY},
        refitted: {rootLeft: refittedStats.rootLeft, rootTop: refittedStats.rootTop, centroidX: refittedStats.centroidX, centroidY: refittedStats.centroidY},
    });

    // 4. Detail controls: part selection + solo + zoom/fit
    await click(page,'[data-part-list] button[data-slot="mesh"]');
    await page.evaluate(`(()=>{const solo=document.querySelector('[data-part-solo]');solo.checked=true;solo.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.evaluate(`document.getElementById('zoom-in').click()`);
    const soloStats = await page.evaluate<{part: string; solo: boolean; totalPixels: number}>(`(()=>{
        const overlay = document.getElementById('rig-overlay');
        const data = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
        let totalPixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) totalPixels++;
        return {
            part: document.querySelector('[data-part-list] button[aria-pressed="true"]').dataset.slot,
            solo: document.querySelector('[data-part-solo]').checked,
            totalPixels,
        };
    })()`);
    assert.equal(soloStats.part, 'mesh');
    assert.equal(soloStats.solo, true);
    assert.ok(soloStats.totalPixels > 20);
    await record('detail-controls-solo-zoom', soloStats);

    // Restore whole-rig framing for full wire inspection on white & sentinel backgrounds:
    await page.evaluate(`(()=>{const solo=document.querySelector('[data-part-solo]');solo.checked=false;solo.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click(page,'[data-part-whole]');
    await page.evaluate(`document.getElementById('fit').click()`);

    // #796 / 368ffec and #768:5-7: delete Background and old display-screenshot refusal/reset assertions.
    // Non-whole-rig rejection remains at ACT layer: tests/job-act.test.ts:566, src/job-act.ts:174.
    // Current web/job-rig-capture.ts:199 captures whole rig independently of display selection.
    // Keep the real Images shortcut and text-entry protection on the current comment composer.
    await click(page,'#rig-viewport');await pressKey('i');
    await wait(`!document.getElementById('layer-images').checked`,'Images shortcut off');
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('rig-root')).visibility`),'hidden');
    await pressKey('i');
    await click(page,'#stage-comment');
    const point=await page.evaluate<{x:number;y:number}>(`(()=>{const r=document.getElementById('rig-viewport').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    await control!('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await control!('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await wait(`!!document.querySelector('.stage-comment-composer input')`,'current comment composer');
    await click(page,'.stage-comment-composer input');
    await pressKey('i');await pressKey('m');await pressKey('b');
    const afterNoteKeys=await page.evaluate(`({imagesChecked:document.getElementById('layer-images').checked,meshChecked:document.getElementById('layer-mesh').checked,bonesChecked:document.getElementById('layer-bones').checked})`);
    assert.deepEqual(afterNoteKeys,{imagesChecked:true,meshChecked:true,bonesChecked:true},'typing I/M/B in comment must not toggle layers');
    // R2 removes new Note input/verbatim note projection. Save through the existing Comments contract.
    assert.equal(await page.evaluate(`document.querySelectorAll('textarea[name="note"]').length`),0);
    const commentText='Inspecting I M B mesh seam · 원문';
    await edit('.stage-comment-composer input',commentText);
    await page.evaluate(`document.querySelector('.stage-comment-composer').requestSubmit()`);
    await wait(`!document.querySelector('.stage-comment-composer')`,'comment saved');
    // Fixed human input plus the persisted source-bound anchor, as in direction-screen.
    // Read draft data only, never form.commentWords() or a finalized act as the expected result.
    await wait(`Object.entries(localStorage).some(([key,value])=>key.startsWith('rig-review-draft/1:')&&JSON.parse(value).session?.feedback?.some(row=>row.summary===${JSON.stringify(commentText)}))`,'source-bound comment draft');
    const comment=await page.evaluate<Feedback>(`(async()=>{
      const drafts=Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-draft/1:'));
      const entry=drafts.find(([,value])=>JSON.parse(value).session?.feedback?.some(row=>row.summary===${JSON.stringify(commentText)}));
      const [key,raw]=entry,draft=JSON.parse(raw),row=draft.session.feedback.find(row=>row.summary===${JSON.stringify(commentText)});
      const crop=row.context.comment.crop;
      if(crop.png.startsWith('draft-crop:')){
        const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('rig-review-inspection-drafts');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
        try{
          const blob=await new Promise((resolve,reject)=>{const request=db.transaction('crops').objectStore('crops').get([key,row.id,crop.sha256]);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
          crop.png=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
        }finally{db.close();}
      }
      return row;
    })()`);
    assert.equal(comment.summary,commentText);
    const mark=parseStageComment((comment.context as {comment:unknown}).comment);
    assert.equal(mark.mode,'setup');
    assert.ok(mark.crop.png.startsWith('data:image/png;base64,'));
    const expectedCommentWords=projectComments(feedbackItemComments([{...comment,summary:commentText}]));
    await click(page,'#workspace-pending-ask');
    await wait(`!!document.querySelector('#job-record-asks[open]')`,'checkpoint dialog');
    await click(page,`form[data-job-ask="${cpAsk.askId}"] button[type="submit"]`);
    await wait(`document.querySelector('form[data-job-ask="${cpAsk.askId}"] [role="status"]')?.dataset.jobText==='job.saved'`,'checkpoint saved');
    const cpEvents=await nextEvents(),cpActEvent=cpEvents.events.find(e=>e.type==='act'&&e.act.askId===cpAsk.askId);
    assert.ok(cpActEvent?.type==='act'&&cpActEvent.act.kind==='checkpoint');
    assert.deepEqual(cpActEvent.act.value,{checkpointId:'meshes',planStepId:'inspect-body',outcome:'pass',words:expectedCommentWords});
    assert.equal(cpActEvent.act.source.sourceHash,rig.source.sourceHash);
    await record('checkpoint-act-committed',cpActEvent.act);
    // Explicit human restoration replaces the deleted automatic reset; fixed evidence remains checked.
    await click(page,'.layer-toggle:has(#layer-mesh)');await click(page,'.layer-toggle:has(#layer-bones)');await click(page,'#fit');
    const verdictAsk=await ask(rig,{kind:'review-verdict',stage:'rig-review'});
    const verdictLayers=await sharedLayers();assert.equal(verdictLayers.visible,true);assert.equal(verdictLayers.enabled,true);
    await wait(`!document.getElementById('save').hidden&&!document.getElementById('save').disabled`,'direct verdict');
    await click(page,'#save');
    let verdictActEvent:Extract<JobNextValue['events'][number],{type:'act'}>|undefined;
    await until(async()=>{verdictActEvent=(await nextEvents()).events.find((e):e is Extract<JobNextValue['events'][number],{type:'act'}>=>e.type==='act'&&e.act.askId===verdictAsk.askId);return !!verdictActEvent;},'verdict act');
    assert.ok(verdictActEvent?.act.kind==='review-verdict'&&verdictActEvent.act.schema==='rig-review/act@3');
    assert.equal(verdictActEvent.act.still.camera,'fixed');
    assert.equal(verdictActEvent.act.source.sourceHash,rig.source.sourceHash);
    assert.equal((verdictActEvent.act.value as {words:string}).words,expectedCommentWords);
    await record('canonical-verdict-committed',verdictActEvent.act);

    // Reconnect and new publication still exercise the shared overlay and actual source binding.
    const cpAsk2=await ask(rig,{kind:'checkpoint',checkpointId:'step-one',planStepId:'step-one'});
    await wait(`!!document.querySelector('form[data-job-ask="${cpAsk2.askId}"]')`,'second checkpoint form');
    await click(page,'#rig-viewport');await pressKey('m');
    await wait(`document.getElementById('layer-mesh').checked`,'wire active before reconnect');
    await page.goto('about:blank');await page.goto(owner.href);
    await wait(`!!document.querySelector('#scrub')&&!!document.querySelector('form[data-job-ask="${cpAsk2.askId}"] fieldset:not(:disabled)')`,'reconnected checkpoint');
    assert.equal(await page.evaluate(`document.querySelector('form[data-job-ask="${cpAsk2.askId}"] .job-source').title`),rig.source.sourceHash);
    const reconnectLayers=await sharedLayers();
    assert.equal(reconnectLayers.visible,true,'reconnect keeps shared controls visible');assert.equal(reconnectLayers.enabled,true,'reconnect shared controls enabled');
    await record('reconnected-checkpoint-state',{layers:reconnectLayers,geometry:await readOverlayAlignment()});
    await page.evaluate(`(()=>{for(const id of ['layer-mesh','layer-bones']){const input=document.getElementById(id);if(!input.checked)input.click();}})()`);
    await wait(`document.getElementById('layer-mesh').checked&&document.getElementById('layer-bones').checked`,'wire active before publication swap');
    fixture.input.setContext({...fixture.input.getContext(),selector:{kind:'rig',version:2}});
    const rig2=await fixture.publish();
    await wait(`!document.querySelector('form[data-job-ask="${cpAsk2.askId}"]')&&JSON.parse(document.getElementById('provenance-full').textContent).sourceHash===${JSON.stringify(rig2.source.sourceHash)}`,'new publication source');
    await page.evaluate(`(()=>{for(const id of ['layer-mesh','layer-bones']){const input=document.getElementById(id);if(input.checked)input.click();}})()`);
    const postPublicationSwap=await readOverlayAlignment();
    assert.equal(postPublicationSwap.totalPixels,0,'no stale overlay after explicit shared layer reset on new publication');
    await record('publication-swap-overlay-disposal',postPublicationSwap);

    assert.deepEqual(await jobInputHashes(fixture.input.root), immutableInputs);
    assert.equal(browserEvents.length, 0, 'zero browser runtime exceptions or network loading failures');
    await finishJob();
    await record('complete', {language, status: 'ok'});
} finally {
    await writeFile(join(output, 'browser-events.json'), JSON.stringify(browserEvents).replace(/#cap=[a-f0-9]{64}/g, '#cap=REDACTED'));
    if (page) await page.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
}
