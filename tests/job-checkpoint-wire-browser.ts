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
import {SENTINELS} from '../web/parts-render.ts';
import type {JobNextValue, JobPendingAsk, JobSubject} from '../src/job-contract.ts';
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
    await wait(
        `!!document.querySelector('#job-time') && document.querySelector('.job-notice')?.textContent.includes(${JSON.stringify(rig.label)}) && document.querySelector('.job-notice')?.dataset.failed==='false'`,
        'display ' + rig.label,
    );

    // 1. Normal ask (review-verdict only, no checkpoint ask yet): layer controls and Background selector stay hidden & disabled
    const verdictAsk = await ask(rig, {kind: 'review-verdict', stage: 'rig-review'});
    await wait(`!!document.querySelector('form[data-job-ask="${verdictAsk.askId}"]')`, 'verdict form');

    await page.evaluate(`document.getElementById('rig-viewport').focus()`);
    await pressKey('i');
    await pressKey('m');
    await pressKey('b');

    const initialState = await page.evaluate<{
        activeElementId: string | null;
        viewportTabIndex: string | null;
        layerControlsHidden: boolean;
        layerInputsDisabled: boolean;
        imagesChecked: boolean;
        meshChecked: boolean;
        bonesChecked: boolean;
        bgFieldHidden: boolean;
        bgDisabled: boolean;
        bgValue: string;
        hasCanonicalMarker: boolean;
        canonicalValue: string | null;
        hasPresentation: boolean;
        overlayNonZeroAlpha: number;
        layerTitles: string[];
    }>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        const overlay = document.getElementById('rig-overlay');
        const ctx = overlay.getContext('2d');
        const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
        let nonZero = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonZero++;
        return {
            activeElementId: document.activeElement?.id ?? null,
            viewportTabIndex: vp.getAttribute('tabindex'),
            layerControlsHidden: document.getElementById('layer-controls').hidden,
            layerInputsDisabled: ['layer-images', 'layer-mesh', 'layer-bones'].every(id => document.getElementById(id).disabled),
            imagesChecked: document.getElementById('layer-images').checked,
            meshChecked: document.getElementById('layer-mesh').checked,
            bonesChecked: document.getElementById('layer-bones').checked,
            bgFieldHidden: document.getElementById('job-background-field').hidden,
            bgDisabled: document.getElementById('job-background').disabled,
            bgValue: document.getElementById('job-background').value,
            hasCanonicalMarker: vp.hasAttribute('data-job-rig-canonical'),
            canonicalValue: vp.dataset.jobRigCanonical ?? null,
            hasPresentation: !!document.querySelector('[data-job-rig-presentation]'),
            overlayNonZeroAlpha: nonZero,
            layerTitles: Array.from(document.querySelectorAll('#layer-controls .layer-toggle'), el => el.title),
        };
    })()`);
    assert.equal(initialState.activeElementId, 'rig-viewport');
    assert.equal(initialState.viewportTabIndex, '-1');
    assert.equal(initialState.layerControlsHidden, true, 'Layer controls stay hidden on normal asks');
    assert.equal(initialState.layerInputsDisabled, true, 'Layer checkboxes stay disabled on normal asks so I/M/B are inert');
    assert.equal(initialState.imagesChecked, true);
    assert.equal(initialState.meshChecked, false);
    assert.equal(initialState.bonesChecked, false);
    assert.equal(initialState.bgFieldHidden, true, 'Background selector stays hidden on normal asks');
    assert.equal(initialState.bgDisabled, true, 'Background selector stays disabled on normal asks');
    assert.equal(initialState.bgValue, '');
    assert.equal(initialState.hasCanonicalMarker, true);
    assert.equal(initialState.canonicalValue, '');
    assert.equal(initialState.hasPresentation, true);
    assert.equal(initialState.overlayNonZeroAlpha, 0);
    await record('initial-default-state', initialState);

    // 2. Meshes checkpoint ask reveals & enables Layer controls and Background selector with existing SENTINELS options
    const cpAsk = await ask(rig, {kind: 'checkpoint', checkpointId: 'meshes', planStepId: 'inspect-body'});
    await wait(`!!document.querySelector('form[data-job-ask="${cpAsk.askId}"]')`, 'meshes checkpoint form');

    const cpState = await page.evaluate<{
        layerControlsHidden: boolean;
        layerInputsDisabled: boolean;
        bgFieldHidden: boolean;
        bgDisabled: boolean;
        bgOptions: {value: string; text: string}[];
        bgLabel: string;
        layerTitles: string[];
    }>(`(()=>{
        const field = document.getElementById('job-background-field');
        const select = document.getElementById('job-background');
        return {
            layerControlsHidden: document.getElementById('layer-controls').hidden,
            layerInputsDisabled: ['layer-images', 'layer-mesh', 'layer-bones'].some(id => document.getElementById(id).disabled),
            bgFieldHidden: field.hidden,
            bgDisabled: select.disabled,
            bgOptions: Array.from(select.options, opt => ({value: opt.value, text: opt.textContent})),
            bgLabel: field.querySelector('span')?.textContent ?? '',
            layerTitles: Array.from(document.querySelectorAll('#layer-controls .layer-toggle'), el => el.title),
        };
    })()`);
    assert.equal(cpState.layerControlsHidden, false, 'Layer controls are visible at meshes checkpoint');
    assert.equal(cpState.layerInputsDisabled, false, 'Layer checkboxes are enabled at meshes checkpoint');
    assert.equal(cpState.bgFieldHidden, false, 'Background selector is visible at meshes checkpoint');
    assert.equal(cpState.bgDisabled, false, 'Background selector is enabled at meshes checkpoint');
    assert.deepEqual(cpState.bgOptions.map(o => o.value), ['', ...Object.keys(SENTINELS)]);
    assert.equal(cpState.bgLabel, catalog['Background']);
    assert.deepEqual(
        cpState.layerTitles,
        ([['Images', 'I'], ['Mesh edges', 'M'], ['Bone points', 'B']] as const).map(([label, key]) =>
            catalog['{0} · key {1}'].replace('{0}', catalog[label]).replace('{1}', key)),
    );
    await record('checkpoint-controls-revealed', cpState);

    // 3. Toggle Mesh edges (M) and Bone points (B) via real keyboard shortcuts while #rig-viewport is focused
    await page.evaluate(`document.getElementById('rig-viewport').focus()`);
    await pressKey('m');
    await pressKey('b');
    await wait(`document.getElementById('layer-mesh').checked && document.getElementById('layer-bones').checked`, 'M and B shortcuts toggled');

    const readOverlayAlignment = () =>
        page!.evaluate<{
            activeElementId: string | null;
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
            hasCanonicalMarker: boolean;
            canonicalValue: string | null;
            hasPresentation: boolean;
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
                hasCanonicalMarker: vp.hasAttribute('data-job-rig-canonical'),
                canonicalValue: vp.dataset.jobRigCanonical ?? null,
                hasPresentation: !!document.querySelector('[data-job-rig-presentation]'),
            };
        })()`);

    const overlayStats = await readOverlayAlignment();
    assert.equal(overlayStats.activeElementId, 'rig-viewport');
    assert.ok(overlayStats.leftHalfPixels > 20, 'synthetic generated-kind mesh slot (rigid, left side) and bone points are drawn on #rig-overlay');
    assert.ok(overlayStats.rightHalfPixels > 20, 'inline mesh slot (mesh, right side) and bone points are drawn on #rig-overlay');
    assert.equal(overlayStats.hasCanonicalMarker, false, 'overlay removes canonical still capture marker attribute');
    assert.equal(overlayStats.canonicalValue, null, 'overlay clears dataset.jobRigCanonical');
    assert.equal(overlayStats.hasPresentation, false, 'opaque presentation canvas is removed while overlay is active');
    await record('overlay-mesh-and-bones-drawn', overlayStats);

    // 3b. Camera pan & fit alignment: focus <select id="job-background"> first, then drag #rig-viewport
    // to prove pointer interaction moves focus to #rig-viewport and rigProject tracks live pan/fit transforms.
    await page.evaluate(`document.getElementById('job-background').focus()`);
    assert.equal(await page.evaluate<string | null>(`document.activeElement?.id ?? null`), 'job-background');
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
    assert.equal(pannedStats.activeElementId, 'rig-viewport', 'pointerdown on #rig-viewport moves focus out of <select>');
    assert.ok(deltaRootLeft > 20 && deltaRootTop > 12, 'dragging #rig-viewport pans #rig-root');
    assert.ok(Math.abs(deltaCentroidX - deltaRootLeft) < 3, 'wire overlay X centroid tracks live pan transform');
    assert.ok(Math.abs(deltaCentroidY - deltaRootTop) < 3, 'wire overlay Y centroid tracks live pan transform');

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
    await edit('#job-part', 'mesh');
    await page.evaluate(`(()=>{const solo=document.getElementById('job-solo');solo.checked=true;solo.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await page.evaluate(`document.getElementById('zoom-in').click()`);
    const soloStats = await page.evaluate<{part: string; solo: boolean; totalPixels: number}>(`(()=>{
        const overlay = document.getElementById('rig-overlay');
        const data = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
        let totalPixels = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) totalPixels++;
        return {
            part: document.getElementById('job-part').value,
            solo: document.getElementById('job-solo').checked,
            totalPixels,
        };
    })()`);
    assert.equal(soloStats.part, 'mesh');
    assert.equal(soloStats.solo, true);
    assert.ok(soloStats.totalPixels > 20);
    await record('detail-controls-solo-zoom', soloStats);

    // Restore whole-rig framing for full wire inspection on white & sentinel backgrounds:
    await page.evaluate(`(()=>{const solo=document.getElementById('job-solo');solo.checked=false;solo.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await edit('#job-part', '');
    await page.evaluate(`document.getElementById('fit').click()`);

    // 5. Images off (I) + White and Green sentinel backgrounds
    await page.evaluate(`document.getElementById('rig-viewport').focus()`);
    await pressKey('i');
    await wait(`!document.getElementById('layer-images').checked`, 'I shortcut toggled Images off');
    await edit('#job-background', 'white');
    const whiteState = await page.evaluate<{
        imagesChecked: boolean;
        rigRootVisibility: string;
        viewportBg: string;
        computedBg: string;
    }>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        return {
            imagesChecked: document.getElementById('layer-images').checked,
            rigRootVisibility: document.getElementById('rig-root').style.visibility,
            viewportBg: vp.style.backgroundColor,
            computedBg: getComputedStyle(vp).backgroundColor,
        };
    })()`);
    assert.equal(whiteState.imagesChecked, false);
    assert.equal(whiteState.rigRootVisibility, 'hidden');
    assert.equal(whiteState.computedBg, 'rgb(255, 255, 255)');
    await writeFile(join(output, `wire-white-${language}.png`), await page.screenshot());
    await record('wire-white-background', whiteState);

    await edit('#job-background', 'green');
    const greenState = await page.evaluate<{computedBg: string}>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        return {computedBg: getComputedStyle(vp).backgroundColor};
    })()`);
    assert.equal(greenState.computedBg, 'rgb(0, 255, 0)');
    await writeFile(join(output, `wire-green-${language}.png`), await page.screenshot());
    await record('wire-green-background', greenState);

    // 6. Canonical review-verdict still capture is refused while checkpoint ask is pending and wire/background are active
    await edit(`form[data-job-ask="${verdictAsk.askId}"] select[name="verdict"]`, 'approved');
    await edit(`form[data-job-ask="${verdictAsk.askId}"] textarea[name="note"]`, 'verdict while wire active');
    await page.evaluate(`document.querySelector('form[data-job-ask="${verdictAsk.askId}"] button[type="submit"]').click()`);
    await wait(
        `document.querySelector('form[data-job-ask="${verdictAsk.askId}"] [role="status"]')?.dataset.jobText === 'JOB_STILL_VIEW_UNSUPPORTED'`,
        'verdict refused while non-default layers/background active',
    );
    const refusalText = await page.evaluate<string>(
        `document.querySelector('form[data-job-ask="${verdictAsk.askId}"] [role="status"]').textContent`,
    );
    assert.equal(refusalText, catalog['JOB_STILL_VIEW_UNSUPPORTED']);
    await record('still-capture-refused-on-non-default-view', {refusalText});

    // 7. textEntryFocused guard: typing I/M/B in checkpoint textarea[name="note"] does NOT toggle layers
    const noteSelector = `form[data-job-ask="${cpAsk.askId}"] textarea[name="note"]`;
    await page.evaluate(`document.querySelector(${JSON.stringify(noteSelector)}).focus()`);
    await pressKey('i');
    await pressKey('m');
    await pressKey('b');
    const afterNoteKeys = await page.evaluate<{
        imagesChecked: boolean;
        meshChecked: boolean;
        bonesChecked: boolean;
    }>(`(()=>({
        imagesChecked: document.getElementById('layer-images').checked,
        meshChecked: document.getElementById('layer-mesh').checked,
        bonesChecked: document.getElementById('layer-bones').checked,
    }))()`);
    assert.equal(afterNoteKeys.imagesChecked, false, 'typing i in note must not toggle Images');
    assert.equal(afterNoteKeys.meshChecked, true, 'typing m in note must not toggle Mesh');
    assert.equal(afterNoteKeys.bonesChecked, true, 'typing b in note must not toggle Bones');

    // Submit checkpoint with pass and verbatim words
    const verbatimWords = '  Inspecting I M B mesh seam verbatim\n';
    await edit(`form[data-job-ask="${cpAsk.askId}"] select[name="outcome"]`, 'pass');
    await edit(noteSelector, verbatimWords);
    await page.evaluate(`document.querySelector('form[data-job-ask="${cpAsk.askId}"] button[type="submit"]').click()`);
    await wait(
        `document.querySelector('form[data-job-ask="${cpAsk.askId}"] [role="status"]')?.dataset.jobText === 'job.saved'`,
        'checkpoint saved',
    );
    const cpEvents = await nextEvents();
    const cpActEvent = cpEvents.events.find(e => e.type === 'act' && e.act.askId === cpAsk.askId);
    assert.ok(cpActEvent?.type === 'act' && cpActEvent.act.kind === 'checkpoint');
    assert.deepEqual(cpActEvent.act.value, {
        checkpointId: 'meshes',
        planStepId: 'inspect-body',
        outcome: 'pass',
        words: verbatimWords,
    });
    await record('checkpoint-act-committed', cpActEvent.act);

    // Transition 1: once the checkpoint ask is answered and only review-verdict remains pending,
    // updateForms automatically resets layers/background to canonical defaults and hides/disables checkpoint controls.
    await wait(
        `document.getElementById('layer-controls').hidden && document.getElementById('job-background-field').hidden && document.getElementById('rig-viewport').hasAttribute('data-job-rig-canonical') && !!document.querySelector('[data-job-rig-presentation]')`,
        'auto-reset to canonical view after checkpoint ask answered',
    );
    const postCheckpointReset = await page.evaluate<{
        layerControlsHidden: boolean;
        layerInputsDisabled: boolean;
        imagesChecked: boolean;
        meshChecked: boolean;
        bonesChecked: boolean;
        bgFieldHidden: boolean;
        bgDisabled: boolean;
        bgValue: string;
        viewportBg: string;
        hasCanonicalMarker: boolean;
        canonicalValue: string | null;
        hasPresentation: boolean;
        overlayNonZeroAlpha: number;
    }>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        const overlay = document.getElementById('rig-overlay');
        const data = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
        let nonZero = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonZero++;
        return {
            layerControlsHidden: document.getElementById('layer-controls').hidden,
            layerInputsDisabled: ['layer-images', 'layer-mesh', 'layer-bones'].every(id => document.getElementById(id).disabled),
            imagesChecked: document.getElementById('layer-images').checked,
            meshChecked: document.getElementById('layer-mesh').checked,
            bonesChecked: document.getElementById('layer-bones').checked,
            bgFieldHidden: document.getElementById('job-background-field').hidden,
            bgDisabled: document.getElementById('job-background').disabled,
            bgValue: document.getElementById('job-background').value,
            viewportBg: vp.style.backgroundColor,
            hasCanonicalMarker: vp.hasAttribute('data-job-rig-canonical'),
            canonicalValue: vp.dataset.jobRigCanonical ?? null,
            hasPresentation: !!document.querySelector('[data-job-rig-presentation]'),
            overlayNonZeroAlpha: nonZero,
        };
    })()`);
    assert.equal(postCheckpointReset.layerControlsHidden, true);
    assert.equal(postCheckpointReset.layerInputsDisabled, true);
    assert.equal(postCheckpointReset.imagesChecked, true);
    assert.equal(postCheckpointReset.meshChecked, false);
    assert.equal(postCheckpointReset.bonesChecked, false);
    assert.equal(postCheckpointReset.bgFieldHidden, true);
    assert.equal(postCheckpointReset.bgDisabled, true);
    assert.equal(postCheckpointReset.bgValue, '');
    assert.equal(postCheckpointReset.viewportBg, '');
    assert.equal(postCheckpointReset.hasCanonicalMarker, true);
    assert.equal(postCheckpointReset.canonicalValue, '');
    assert.equal(postCheckpointReset.hasPresentation, true);
    assert.equal(postCheckpointReset.overlayNonZeroAlpha, 0);
    await record('transition-1-auto-reset-after-checkpoint', postCheckpointReset);

    // Submit review-verdict directly without manual key toggles now that canonical view auto-restored
    await edit(`form[data-job-ask="${verdictAsk.askId}"] textarea[name="note"]`, '  restored canonical verdict\n');
    await page.evaluate(`document.querySelector('form[data-job-ask="${verdictAsk.askId}"] button[type="submit"]').click()`);
    await wait(
        `document.querySelector('form[data-job-ask="${verdictAsk.askId}"] [role="status"]')?.dataset.jobText === 'job.saved'`,
        'canonical verdict saved after auto-reset',
    );
    const verdictEvents = await nextEvents();
    const verdictActEvent = verdictEvents.events.find(e => e.type === 'act' && e.act.askId === verdictAsk.askId);
    assert.ok(verdictActEvent?.type === 'act' && verdictActEvent.act.kind === 'review-verdict' && verdictActEvent.act.schema === 'rig-review/act@3');
    assert.equal(verdictActEvent.act.still.camera, 'fixed');
    assert.equal((verdictActEvent.act.value as {words: string}).words, '  restored canonical verdict\n');
    await record('canonical-verdict-committed', {
        actId: verdictActEvent.act.actId,
        schema: verdictActEvent.act.schema,
        still: verdictActEvent.act.still,
    });

    // 8. Reconnect and publication transition (Transition 2): overlay disposal and no stale draw
    const cpAsk2 = await ask(rig, {kind: 'checkpoint', checkpointId: 'step-one', planStepId: 'step-one'});
    await wait(`!!document.querySelector('form[data-job-ask="${cpAsk2.askId}"]') && !document.getElementById('layer-controls').hidden`, 'second checkpoint form');
    await page.evaluate(`document.getElementById('rig-viewport').focus()`);
    await pressKey('m');
    await edit('#job-background', 'magenta');
    await wait(`document.getElementById('layer-mesh').checked && document.getElementById('job-background').value === 'magenta'`, 'mesh and magenta active before reconnect');

    // Page reconnect (about:blank -> owner.href)
    await page.goto('about:blank');
    await page.goto(owner.href);
    await wait(
        `!!document.querySelector('#job-time') && !!document.querySelector('form[data-job-ask="${cpAsk2.askId}"]') && !document.getElementById('layer-controls').hidden`,
        'reconnected with pending checkpoint ask',
    );
    const reconnectedState = await page.evaluate<{
        layerControlsHidden: boolean;
        bgFieldHidden: boolean;
        imagesChecked: boolean;
        meshChecked: boolean;
        bonesChecked: boolean;
        bgValue: string;
        hasCanonicalMarker: boolean;
        canonicalValue: string | null;
    }>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        return {
            layerControlsHidden: document.getElementById('layer-controls').hidden,
            bgFieldHidden: document.getElementById('job-background-field').hidden,
            imagesChecked: document.getElementById('layer-images').checked,
            meshChecked: document.getElementById('layer-mesh').checked,
            bonesChecked: document.getElementById('layer-bones').checked,
            bgValue: document.getElementById('job-background').value,
            hasCanonicalMarker: vp.hasAttribute('data-job-rig-canonical'),
            canonicalValue: vp.dataset.jobRigCanonical ?? null,
        };
    })()`);
    assert.equal(reconnectedState.layerControlsHidden, false);
    assert.equal(reconnectedState.bgFieldHidden, false);
    assert.equal(reconnectedState.imagesChecked, true);
    assert.equal(reconnectedState.meshChecked, false);
    assert.equal(reconnectedState.bonesChecked, false);
    assert.equal(reconnectedState.bgValue, '');
    assert.equal(reconnectedState.hasCanonicalMarker, true);
    assert.equal(reconnectedState.canonicalValue, '');
    await record('reconnected-checkpoint-state', reconnectedState);

    // Activate wire + magenta background again, then publish a new rig publication (Transition 2)
    await page.evaluate(`document.getElementById('rig-viewport').focus()`);
    await pressKey('m');
    await pressKey('b');
    await edit('#job-background', 'magenta');
    await wait(`document.getElementById('layer-mesh').checked && document.getElementById('layer-bones').checked`, 'wire active before publication swap');

    fixture.input.setContext({
        ...fixture.input.getContext(),
        selector: {kind: 'rig', version: 2},
    });
    const rig2 = await fixture.publish();
    await wait(
        `!document.querySelector('form[data-job-ask="${cpAsk2.askId}"]') && document.getElementById('layer-controls')?.hidden === true`,
        'display second publication ' + rig2.publicationId,
    );
    const postPublicationSwap = await page.evaluate<{
        layerControlsHidden: boolean;
        layerInputsDisabled: boolean;
        imagesChecked: boolean;
        meshChecked: boolean;
        bonesChecked: boolean;
        bgFieldHidden: boolean;
        bgDisabled: boolean;
        bgValue: string;
        viewportBg: string;
        hasCanonicalMarker: boolean;
        canonicalValue: string | null;
        hasPresentation: boolean;
        overlayNonZeroAlpha: number;
    }>(`(()=>{
        const vp = document.getElementById('rig-viewport');
        const overlay = document.getElementById('rig-overlay');
        const data = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
        let nonZero = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonZero++;
        return {
            layerControlsHidden: document.getElementById('layer-controls').hidden,
            layerInputsDisabled: ['layer-images', 'layer-mesh', 'layer-bones'].every(id => document.getElementById(id).disabled),
            imagesChecked: document.getElementById('layer-images').checked,
            meshChecked: document.getElementById('layer-mesh').checked,
            bonesChecked: document.getElementById('layer-bones').checked,
            bgFieldHidden: document.getElementById('job-background-field').hidden,
            bgDisabled: document.getElementById('job-background').disabled,
            bgValue: document.getElementById('job-background').value,
            viewportBg: vp.style.backgroundColor,
            hasCanonicalMarker: vp.hasAttribute('data-job-rig-canonical'),
            canonicalValue: vp.dataset.jobRigCanonical ?? null,
            hasPresentation: !!document.querySelector('[data-job-rig-presentation]'),
            overlayNonZeroAlpha: nonZero,
        };
    })()`);
    assert.equal(postPublicationSwap.layerControlsHidden, true);
    assert.equal(postPublicationSwap.layerInputsDisabled, true);
    assert.equal(postPublicationSwap.imagesChecked, true);
    assert.equal(postPublicationSwap.meshChecked, false);
    assert.equal(postPublicationSwap.bonesChecked, false);
    assert.equal(postPublicationSwap.bgFieldHidden, true);
    assert.equal(postPublicationSwap.bgDisabled, true);
    assert.equal(postPublicationSwap.bgValue, '');
    assert.equal(postPublicationSwap.viewportBg, '');
    assert.equal(postPublicationSwap.hasCanonicalMarker, true);
    assert.equal(postPublicationSwap.canonicalValue, '');
    assert.equal(postPublicationSwap.hasPresentation, true);
    assert.equal(postPublicationSwap.overlayNonZeroAlpha, 0, 'no stale overlay draw after publication swap');
    await record('transition-2-publication-swap-clean-reset', postPublicationSwap);

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
