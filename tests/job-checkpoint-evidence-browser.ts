/** Ordinary Nova orchestration for #629 and #606. Synthetic sealed evidence, never producer output.
 * Run after parent exact-commit GO with --lang en or --lang ko.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {JobCheckpointEvidence, JobCheckpointTable, NextValueV3, PlanContext} from '../src/job-contract.ts';
import {JOB_RECORD_READER_ID} from '../src/job-contract.ts';
import {startJobHost} from '../src/job-front.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader, makeSyntheticPngBytes,
    writeWorkspaceFile} from './helpers/job-record-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {inspectPartsViewportPng, type HalfOpenBox, type RgbaTuple} from './helpers/job-window-paint.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

/** Shared ordinary test input for preparation, DOM controls and browser orchestration. */
export function syntheticCheckpointEvidence(root: string, checkpointId = 'step_layout', planStepId = checkpointId) {
    const tiles = Array.from({length: 4}, (_, index) => ({id: `pair-${index}`,
        label: `Pair ${index} frame0 / worst <marked> 한글`,
        ...writeWorkspaceFile(root, `evidence/pair-${index}.png`, makeSyntheticPngBytes(20 + index, 100, 180))}));
    const table: JobCheckpointTable = {schema: 'rig-review-checkpoint-table/1',
        columns: ['Pair <raw>', 'Frame', 'Verdict', 'Accepted', 'Missing'],
        rows: Array.from({length: 103}, (_, index) => [`pair-${102 - index}`, index,
            index === 0 ? '<script>& 한글\nraw' : 'FAIL', index % 2 === 0, null])};
    const tableSeal = writeWorkspaceFile(root, 'evidence/table.json', JSON.stringify(table, null, 2) + '\n');
    const packet: JobCheckpointEvidence = {schema: 'rig-review-checkpoint-evidence/1', checkpointId, planStepId,
        tiles, table: {...tableSeal, label: 'All 103 rows <verbatim>'},
        routesText: '(i) accept openings\n(ii) repair\n(iii) stop',
        recommendationText: 'Prefer (ii)\nproducer FAIL remains FAIL'};
    return {packet, table, files: [...tiles.map(({path, sha256}) => ({path, sha256})), tableSeal]};
}

async function run() {
    const argument = (key: string) => {const i = Bun.argv.indexOf(key); return i < 0 ? undefined : Bun.argv[i + 1];};
    const language = argument('--lang') ?? 'en';
    assert.ok(language === 'en' || language === 'ko');
    const catalog = language === 'ko' ? koCatalog : enCatalog;
    const output = argument('--out') ?? `evidence/job-checkpoint-evidence-${language}`;
    await mkdir(output, {recursive: true});
    const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review629-browser-'));
    const root = join(scratch, 'plan');
    await mkdir(root);
    const text = {does:'  <mark>Exact does</mark> 한글 e\u0301\r\n',produces:'',bar:'  Exact bar\r\nsecond line ',rests_on:['bones','bones','']};
    const plan = createSyntheticPlanRecordWorkspace(root,{text});
    const evidence = syntheticCheckpointEvidence(root);
    const context: PlanContext = {...plan.context, checkpointEvidence: [evidence.packet],
        files: [...plan.files, ...evidence.files].sort((a, b) => a.path < b.path ? -1 : 1)};
    const beforePlanHashes = await jobInputHashes(root);
    const {reader} = createSyntheticRecordReader({onPlan: () => structuredClone(context)});
    let grant: {fetchCapability: string} | undefined;
    let planHost: Awaited<ReturnType<typeof startJobHost>> | undefined;
    let pkg: Awaited<ReturnType<typeof realJobWindowFixture>> | undefined;
    let page: InputCdpSession | undefined;
    let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
    let corruptTiles = false;
    let activeDecision: {host: Awaited<ReturnType<typeof startJobHost>>; schema: string;
        askId: string; publicationId: string; sourceHash: string; outcome: string; words: string; prefix: string} | undefined;
    let latestNext: ReturnType<typeof summarizeNext> | undefined;
    const browserErrors: Record<string, unknown>[] = [];
    const networkFailures: Record<string, unknown>[] = [];
    const uiResponses: Record<string, unknown>[] = [];
    const networkRequests = new Map<string, {url: string; method: string}>();
    const redact = (text: string) => text.replace(/#cap=[^\s"']+/g, '#cap=<redacted>');
    function summarizeNext(next: NextValueV3) {
        return {status: next.status, cursor: next.cursor, events: next.events.map(event => ({
            type: event.type, generation: event.generation, cursor: event.cursor,
            ...(event.type === 'act' ? {askId: event.act.askId, actId: event.act.actId, kind: event.act.kind} : {}),
            ...(event.type === 'pending' ? {askId: event.ask.askId, status: event.ask.status, subject: event.ask.subject} : {}),
        }))};
    }
    async function checkpointForm(askId: string) {
        return page!.evaluate<{exists: boolean; ready: boolean; askId: string | null; outcome: string | null;
            words: string | null; valid: boolean; fieldsetDisabled: boolean | null; submitDisabled: boolean | null;
            status: {key: string | null; text: string} | null; notice: {failed: string | null; text: string} | null;
            binding: string | null; controls: unknown[]}>(`(()=>{
            const f=document.querySelector('form[data-job-ask="${askId}"]');
            const fields=f?.querySelector('fieldset'), submit=f?.querySelector('button[type=submit]');
            const outcome=f?.querySelector('select[name=outcome]'), words=f?.querySelector('textarea[name=note]');
            const status=f?.querySelector('[role=status]'), notice=document.querySelector('.job-notice');
            return {exists:!!f, askId:f?.dataset.jobAsk??null,
                ready:!!fields&&!fields.disabled&&!!submit&&!submit.matches(':disabled')&&
                    !!outcome&&!outcome.matches(':disabled')&&!!words&&!words.matches(':disabled'),
                fieldsetDisabled:fields?.disabled??null, submitDisabled:submit?.matches(':disabled')??null,
                outcome:outcome?.value??null, words:words?.value??null, valid:f?.checkValidity()??false,
                status:status?{key:status.dataset.jobText??null,text:status.textContent}:null,
                notice:notice?{failed:notice.dataset.failed??null,text:notice.textContent}:null,
                binding:f?.querySelector('.job-source')?.textContent??null,
                controls:f?[...f.querySelectorAll('input[name],textarea[name],select[name],button[type=submit]')]
                    .map(n=>({tag:n.tagName,name:n.name,type:n.type,value:n.value,disabled:n.matches(':disabled'),
                        willValidate:n.willValidate,valid:n.validity.valid})):[]};})()`);
    }
    const observations: Record<string, unknown> = {provenance: 'synthetic four-tile / 103-row evidence, no producer execution'};
    async function until(check: () => Promise<boolean>, label: string) {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {if (await check()) return; await Bun.sleep(25);}
        throw new Error('CHECKPOINT_BROWSER_WAIT ' + label);
    }
    async function call(host: Awaited<ReturnType<typeof startJobHost>>, schema: string, body: object, token?: string) {
        const response = await fetch(`${host.origin}/jobs/${host.session.jobId}/api`, {method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + (token ?? host.session.hostCredentials().agent)},
            body: JSON.stringify({schema, jobId: host.session.jobId, requestId: randomUUID(), ...body})});
        const result = await response.json();
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.value;
    }
    async function inspect(host: Awaited<ReturnType<typeof startJobHost>>, schema: string,
        publication: {publicationId: string; source: {sourceHash: string; projectHash?: string | null}}, packet: JobCheckpointEvidence, prefix: string,
        fetchCapability: string) {
        const owner = new URL(host.ownerUrl);
        owner.searchParams.set('lang', language);
        const layoutObservations: unknown[] = [];
        observations[prefix + '-layout'] = layoutObservations;
        const narrow = {width: 1024, height: 768}, wide = {width: 1440, height: 900};
        const samples = [{...wide, phase:'initial'}, {...narrow, phase:'resize'},
            {...narrow, phase:'initial'}, {...wide, phase:'resize'}];
        for (const {phase, ...viewport} of samples) {
            await page!.setViewport(viewport.width, viewport.height);
            if (phase === 'initial') await page!.goto(owner.href);
            await until(() => page!.evaluate(`!!document.querySelector('[data-job-checkpoint-evidence]')`), prefix + ' evidence');
            const askId = await page!.evaluate<string>(`document.querySelector('[data-job-checkpoint-evidence]').closest('form').dataset.jobAsk`);
            await until(async () => (await checkpointForm(askId)).ready, prefix + ' layout checkpoint ready');
            await page!.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
            const layout = await page!.evaluate<any>(`(()=>{
                const inspection=document.querySelector('.job-inspection'), main=inspection.parentElement;
                const forms=inspection.querySelector('[data-job-forms]'), stage=inspection.querySelector('.job-stage');
                const evidence=forms.querySelector('[data-job-checkpoint-evidence]');
                const gallery=evidence.querySelector('section'), titles=[...gallery.querySelectorAll('figure h3')];
                const fourth=titles[3];
                fourth.scrollIntoView({block:'center',inline:'nearest'});
                const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
                const formsRect=rect(forms), galleryRect=rect(gallery), range=document.createRange();
                range.selectNodeContents(fourth);
                return {viewport:{width:innerWidth,height:innerHeight},askId:evidence.closest('form').dataset.jobAsk,
                    main:rect(main),inspection:rect(inspection),stage:rect(stage),forms:formsRect,
                    stageChildren:[...stage.children].map(child=>({id:child.id,className:child.className,
                        tag:child.tagName,visible:child.getClientRects().length>0,rect:rect(child),
                        clientHeight:child.clientHeight,scrollHeight:child.scrollHeight,
                        minHeight:getComputedStyle(child).minHeight,flex:getComputedStyle(child).flex})),
                    formsClientHeight:forms.clientHeight,
                    gallery:{...galleryRect,clientWidth:gallery.clientWidth,scrollWidth:gallery.scrollWidth,
                        clientHeight:gallery.clientHeight,scrollLeft:gallery.scrollLeft,clientLeft:gallery.clientLeft},
                    labels:titles.map(n=>n.textContent),fourthTitle:rect(fourth),
                    fourthTitleTextRects:[...range.getClientRects()].map(r=>({left:r.left,right:r.right,top:r.top,bottom:r.bottom})),
                    clip:{left:Math.max(formsRect.left+forms.clientLeft,galleryRect.left+gallery.clientLeft),
                        right:Math.min(formsRect.left+forms.clientLeft+forms.clientWidth,galleryRect.left+gallery.clientLeft+gallery.clientWidth),
                        top:Math.max(formsRect.top+forms.clientTop,galleryRect.top+gallery.clientTop),
                        bottom:Math.min(formsRect.top+forms.clientTop+forms.clientHeight,galleryRect.top+gallery.clientTop+gallery.clientHeight)}};
            })()`);
            layout.phase = phase;
            layout.sourceHash = publication.source.sourceHash;
            layout.recordSha256 = publication.source.projectHash;
            assert.ok(layout.recordSha256, prefix+' authenticated text record');
            layoutObservations.push(layout);
            assert.deepEqual(layout.viewport, viewport);
            assert.equal(layout.askId, askId);
            assert.ok(Math.abs(layout.inspection.bottom - layout.main.bottom) <= 1,
                prefix + ' inspection must fill main at ' + viewport.width);
            assert.ok(layout.formsClientHeight >= viewport.height * 0.5,
                prefix + ' forms must occupy at least half the viewport height at ' + viewport.width);
            if (prefix.startsWith('package-')) assert.ok(Math.abs(layout.stage.height - 250) <= 1, prefix + ' stage stays 250px');
            else assert.ok(layout.stage.right <= layout.forms.left + 1, prefix+' plan and forms stay beside each other');
            const requiredStageChildren = [
                {id: '', className: 'viewbar'}, {id: 'stage-layout', className: ''}, {id: '', className: 'job-transport'},
            ];
            for (const required of requiredStageChildren) {
                const child = layout.stageChildren.find((item: {id: string; className: string}) =>
                    required.id ? item.id === required.id : item.className.split(/\s+/).includes(required.className));
                assert.ok(child, prefix + ' required stage child exists at ' + viewport.width);
                if (prefix.startsWith('package-')) {
                    assert.equal(child.visible, true, prefix + ' package stage child must be visible');
                    assert.ok(child.rect.height > 0, prefix + ' package stage child has positive height');
                    if (!required.id) assert.ok(child.scrollHeight <= child.clientHeight,
                        prefix + ' controls must fit one row vertically');
                }
            }
            if (prefix.startsWith('package-')) {
                const pair = layout.stageChildren.find((child: {id: string}) => child.id === 'stage-layout');
                assert.ok(pair.rect.height >= Math.max(layout.stage.height * 0.6, 150),
                    prefix + ' render pair must occupy at least 60% of stage and 150px');
            }
            for (const child of layout.stageChildren) {
                if (!child.visible || !prefix.startsWith('package-')) continue;
                assert.ok(child.rect.top >= layout.stage.top && child.rect.bottom <= layout.stage.bottom,
                    prefix + ' stage child ' + (child.id || child.className || child.tag) +
                    ' must stay inside stage at ' + viewport.width);
                assert.ok(child.rect.bottom <= layout.forms.top,
                    prefix + ' stage child must not overlap forms at ' + viewport.width);
            }
            assert.deepEqual(layout.labels, packet.tiles.map(tile => tile.label));
            assert.ok(layout.gallery.scrollWidth <= layout.gallery.clientWidth + 1,
                prefix + ' wrapped checkpoint gallery must fit horizontally at ' + viewport.width);
            assert.ok(layout.fourthTitleTextRects.length > 0);
            for (const rect of layout.fourthTitleTextRects) {
                assert.ok(rect.left >= layout.clip.left - 1 && rect.right <= layout.clip.right + 1 &&
                    rect.top >= layout.clip.top - 1 && rect.bottom <= layout.clip.bottom + 1,
                    prefix + ' complete fourth-tile title must be accessible at ' + viewport.width);
            }
            if (prefix.startsWith('plan-')) {
                const sourceReachability = await page!.evaluate<any>(`(()=>{
                    const stage=document.querySelector('[data-job-plan-workspace]>.job-stage');
                    const record=stage.querySelector('[data-job-record="plan"]');
                    const disclosure=record.querySelector('details');
                    disclosure.open=true;
                    const pre=disclosure.querySelector('pre');
                    const source=JSON.parse(pre.textContent);
                    const lines=[...record.querySelectorAll('.job-source')].map(element=>{
                        element.scrollIntoView({block:'center',inline:'nearest'});
                        const range=document.createRange();range.selectNodeContents(element);
                        return {text:element.textContent,rects:[...range.getClientRects()].map(r=>({left:r.left,right:r.right})),
                            clientWidth:element.clientWidth,scrollWidth:element.scrollWidth};
                    });
                    const bounds=stage.getBoundingClientRect();
                    const result={sourceHash:source.sourceHash,lines,left:bounds.left,right:bounds.right,
                        clientWidth:stage.clientWidth,scrollWidth:stage.scrollWidth,opened:disclosure.open};
                    disclosure.open=false;
                    result.closed=!disclosure.open;
                    return result;
                })()`);
                assert.equal(sourceReachability.sourceHash,publication.source.sourceHash);
                assert.ok(sourceReachability.opened && sourceReachability.closed,prefix+' source disclosure opens and closes');
                assert.ok(sourceReachability.scrollWidth<=sourceReachability.clientWidth+1,prefix+' stage has no horizontal overflow');
                assert.ok(sourceReachability.lines.some((line:any)=>line.text.includes(publication.source.sourceHash)),
                    prefix+' complete source hash remains available');
                for (const line of sourceReachability.lines) {
                    assert.ok(line.scrollWidth<=line.clientWidth+1,prefix+' complete identity text wraps');
                    assert.ok(line.rects.every((rect:any)=>rect.left>=sourceReachability.left-1 && rect.right<=sourceReachability.right+1),
                        prefix+' complete identity text stays within stage');
                }
                layout.sourceReachability=sourceReachability;
            }
            let screenshot: Buffer | undefined;
            if (prefix.startsWith('package-')) {
                await until(async () => {
                    const paint = await page!.evaluate<any>(`(()=>{
                        const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,
                            bottom:r.bottom,width:r.width,height:r.height};};
                        return ['reference','rig'].map(target=>{
                            const pane=document.getElementById(target+'-viewport');
                            const image=pane.querySelector('#reference-content img');
                            const canonical=pane.querySelector('canvas[data-job-rig-presentation]');
                            const canvases=[...pane.querySelectorAll('canvas')].map(canvas=>({
                                canonical:canvas===canonical,width:canvas.width,height:canvas.height,rect:rect(canvas),
                                visibility:getComputedStyle(canvas).visibility,display:getComputedStyle(canvas).display}));
                            return {target,pane:rect(pane),canvases,devicePixelRatio,
                                sourceVisibility:target==='rig'?getComputedStyle(document.getElementById('rig-root')).visibility:null,
                                image:image?{width:image.naturalWidth,height:image.naturalHeight,
                                    complete:image.complete,rect:rect(image)}:null};
                        });
                    })()`);
                    screenshot = await page!.screenshot();
                    for (const pane of paint) {
                        const box: HalfOpenBox = [Math.ceil(pane.pane.left), Math.ceil(pane.pane.top),
                            Math.floor(pane.pane.right), Math.floor(pane.pane.bottom)];
                        const rgba: RgbaTuple = pane.target === 'reference' ? [239, 32, 32, 255] : [32, 220, 48, 255];
                        // The existing scanner counts exact supplied RGBA in backgroundPixels.
                        // Here that supplied color is the immutable fixture's red or green pixel.
                        const pixels = inspectPartsViewportPng(screenshot, {viewport, backgroundRgba: rgba,
                            leftROI: box, rightAdjacent: box});
                        assert.ok(pixels.supportedViewport && pixels.inBounds, prefix + ' paint ROI stays in viewport');
                        pane.fixtureRgba = rgba;
                        pane.matchedPixels = pixels.leftROI.backgroundPixels;
                    }
                    layout.paintAttempts = (layout.paintAttempts ?? 0) + 1;
                    layout.firstPaint ??= paint;
                    layout.paint = paint;
                    return paint.every((pane: any) => pane.matchedPixels > 0 &&
                        (pane.target === 'reference' ? pane.image?.complete && pane.image.width > 0 && pane.image.height > 0
                            : pane.sourceVisibility === 'hidden' && pane.canvases.some((canvas: any) =>
                                canvas.canonical && canvas.width > 0 && canvas.height > 0 &&
                                canvas.rect.width > 0 && canvas.rect.height > 0 &&
                                Math.abs(canvas.width - canvas.rect.width * pane.devicePixelRatio) <= 1 &&
                                Math.abs(canvas.height - canvas.rect.height * pane.devicePixelRatio) <= 1 &&
                                canvas.visibility === 'visible' && canvas.display !== 'none')));
                }, prefix + ' red reference and green rig pixels after ' + phase + ' ' + viewport.width);
                assert.ok(layout.paint.every((pane: any) => pane.matchedPixels > 0));
            }
            const capturePhase = '-' + phase;
            await writeFile(join(output, prefix + '-' + viewport.width + 'x' + viewport.height + capturePhase + '-layout.png'),
                screenshot ?? await page!.screenshot());
            layout.planFields = [];
            for (const field of ['does','produces','bar','rests_on']) {
                const fieldState = await page!.evaluate<any>(`(()=>{
                    const form=document.querySelector('form[data-job-ask="${askId}"]');
                    const value=form.querySelector('[data-job-plan-field="${field}"]');
                    const target=value.textContent.length?value:value.previousElementSibling;
                    target.scrollIntoView({block:'center',inline:'nearest'});
                    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
                    return {field:${JSON.stringify(field)},text:value.textContent,rests:[...value.querySelectorAll('li')].map(n=>n.textContent),
                        value:rect(value),target:rect(target),forms:rect(form.closest('[data-job-forms]')),
                        markupCount:value.querySelectorAll('mark,script').length,
                        label:value.previousElementSibling.textContent};
                })()`);
                assert.equal(fieldState.markupCount,0,prefix+' inert field '+field);
                assert.equal(fieldState.label,catalog['job.plan.'+field]);
                if (field==='rests_on') assert.deepEqual(fieldState.rests,text.rests_on);
                else assert.equal(fieldState.text,text[field as 'does'|'produces'|'bar']);
                assert.ok(fieldState.target.left>=fieldState.forms.left && fieldState.target.right<=fieldState.forms.right,
                    prefix+' field horizontally reachable '+field);
                assert.ok(fieldState.target.top>=fieldState.forms.top && fieldState.target.bottom<=fieldState.forms.bottom,
                    prefix+' field vertically reachable '+field);
                const fieldShot=await page!.screenshot();
                if (prefix.startsWith('package-')) {
                    fieldState.paint=layout.paint.map((pane:any)=>{
                        const box:HalfOpenBox=[Math.ceil(pane.pane.left),Math.ceil(pane.pane.top),Math.floor(pane.pane.right),Math.floor(pane.pane.bottom)];
                        const pixels=inspectPartsViewportPng(fieldShot,{viewport,backgroundRgba:pane.fixtureRgba,leftROI:box,rightAdjacent:box});
                        assert.ok(pixels.inBounds && pixels.leftROI.backgroundPixels>0,prefix+' context pixels with '+field);
                        return {target:pane.target,matchedPixels:pixels.leftROI.backgroundPixels};
                    });
                }
                layout.planFields.push(fieldState);
                await writeFile(join(output,prefix+'-'+viewport.width+'x'+viewport.height+capturePhase+'-'+field+'.png'),fieldShot);
            }

        }
        const snapshot = await page!.evaluate<any>(`(()=>{const s=document.querySelector('[data-job-checkpoint-evidence]');
            return {id:s.dataset.jobCheckpointEvidence, labels:[...s.querySelectorAll('figure h3')].map(n=>n.textContent),
            images:[...s.querySelectorAll('img')].map(n=>({complete:n.complete,width:n.naturalWidth})),
            columns:[...s.querySelectorAll('th')].map(n=>n.textContent),
            rows:[...s.querySelectorAll('tbody tr')].map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent)),
            texts:[...s.querySelectorAll('pre')].map(n=>n.textContent),
            recommendation:s.querySelector('[data-job-text="job.checkpointRecommendation"]').textContent,
            mapping:document.querySelector('[data-job-text="job.checkpointRouteMapping"]').textContent,
            scripts:s.querySelectorAll('script').length};})()`);
        assert.equal(snapshot.id, packet.checkpointId);
        assert.deepEqual(snapshot.labels, packet.tiles.map(tile => tile.label));
        assert.equal(snapshot.images.length, 4);
        assert.ok(snapshot.images.every((image: any) => image.complete && image.width > 0));
        assert.deepEqual(snapshot.columns, evidence.table.columns);
        assert.deepEqual(snapshot.rows, evidence.table.rows.map(row => row.map(String)));
        assert.deepEqual(snapshot.texts, [packet.routesText, packet.recommendationText]);
        assert.equal(snapshot.recommendation, catalog['job.checkpointRecommendation']);
        assert.equal(snapshot.mapping, catalog['job.checkpointRouteMapping']);
        assert.equal(snapshot.scripts, 0);
        observations[prefix + '-dom'] = snapshot;
        await page!.evaluate(`document.querySelector('[data-job-checkpoint-evidence] figure').scrollIntoView()`);
        await writeFile(join(output, prefix + '-gallery.png'), await page!.screenshot());
        await page!.evaluate(`document.querySelector('[data-job-checkpoint-table] tbody tr:last-child').scrollIntoView()`);
        await writeFile(join(output, prefix + '-row103.png'), await page!.screenshot());
        await page!.evaluate(`document.querySelector('[data-job-text="job.checkpointRecommendation"]').scrollIntoView()`);
        await writeFile(join(output, prefix + '-recommendation.png'), await page!.screenshot());
        for (const outcome of ['pass', 'fail']) {
            const asked = await call(host, schema, {verb: 'ask', expectedGeneration: host.session.status().generation,
                idempotencyKey: randomUUID(), publicationId: publication.publicationId,
                subject: {kind: 'checkpoint', checkpointId: packet.checkpointId,
                    ...(schema === 'rig-review/job-api@2' ? {planStepId: packet.planStepId} : {})}});
            const words = `  ${outcome} 한글 <owner>\nPass\n`;
            activeDecision = {host, schema, askId: asked.askId, publicationId: publication.publicationId,
                sourceHash: publication.source.sourceHash, outcome, words, prefix};
            latestNext = undefined;
            await until(async () => (await checkpointForm(asked.askId)).ready, prefix + ' ' + outcome + ' decision ready');
            await page!.evaluate(`(()=>{const f=document.querySelector('form[data-job-ask="${asked.askId}"]');
                f.querySelector('select[name=outcome]').value=${JSON.stringify(outcome)};
                f.querySelector('textarea[name=note]').value=${JSON.stringify(words)};
                f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
            // Reconnect preserves the source-bound owner draft before its ordinary UI submission.
            await page!.goto('about:blank');
            await page!.goto(owner.href);
            // updateForms enables this fieldset only after display acknowledgment and pending-ask readiness.
            await until(async () => (await checkpointForm(asked.askId)).ready, prefix + ' ' + outcome + ' reconnect ready');
            const restored = await checkpointForm(asked.askId);
            assert.equal(restored.askId, asked.askId);
            assert.equal(restored.ready, true);
            assert.equal(restored.outcome, outcome);
            assert.equal(restored.words, words);
            assert.equal(restored.valid, true);
            observations[prefix + '-' + outcome + '-ready'] = restored;
            await page!.evaluate(`document.querySelector('form[data-job-ask="${asked.askId}"]').requestSubmit()`);
            observations[prefix + '-' + outcome + '-submit'] = await checkpointForm(asked.askId);
            let act: any;
            await until(async () => {
                const next = await call(host, schema, {verb: 'next', after: null, waitMs: 0});
                latestNext = summarizeNext(next);
                act = next.events.find((event: any) => event.type === 'act' && event.act.askId === asked.askId)?.act;
                return !!act;
            }, 'finalized act');
            const fetched = await call(host, schema, {verb: 'fetch-act', actId: act.actId}, fetchCapability);
            assert.equal(fetched.source.sourceHash, publication.source.sourceHash);
            assert.deepEqual(fetched.value, {checkpointId: packet.checkpointId, planStepId: packet.planStepId, outcome, words});
            observations[prefix + '-' + outcome] = {actId: fetched.actId, sourceHash: fetched.source.sourceHash, value: fetched.value};
            activeDecision = undefined;
        }
        corruptTiles = true;
        await control!('Fetch.enable', {patterns: [{urlPattern: '*checkpoint-evidence/*/tiles/0', requestStage: 'Request'}]});
        await page!.goto('about:blank');
        await page!.goto(owner.href);
        await until(() => page!.evaluate(`document.body.textContent.includes('CHECKPOINT_EVIDENCE_HASH_MISMATCH')`), 'named hash refusal');
        assert.equal(await page!.evaluate(`document.querySelectorAll('[data-job-checkpoint-evidence]').length`), 0);
        await writeFile(join(output, prefix + '-hash-refusal.png'), await page!.screenshot());
        observations[prefix + '-hash-refusal'] = 'CHECKPOINT_EVIDENCE_HASH_MISMATCH';
        corruptTiles = false;
        await control!('Fetch.disable');
    }
    try {
        planHost = await startJobHost({root, stateDir: join(scratch, 'plan-state'), fingerprint: 'a'.repeat(64),
            reviewer: {id: 'synthetic-owner', role: 'owner'}, publicationMode: 'record-and-package',
            readRecordPublished: reader, recordReaderId: JOB_RECORD_READER_ID, bindingId: 'synthetic-checkpoint-writer/1',
            installWriterBinding: binding => {grant = binding;}});
        const publication = await call(planHost, 'rig-review/job-api@3', {verb: 'publish', expectedGeneration: 0,
            idempotencyKey: randomUUID(), freeze: {kind: 'producer-held', holdId: 'synthetic', record: plan.record}, result: plan.result});
        await call(planHost, 'rig-review/job-api@3', {verb: 'ask', expectedGeneration: 1,
            idempotencyKey: randomUUID(), publicationId: publication.publicationId,
            subject: {kind: 'checkpoint', checkpointId: evidence.packet.checkpointId}});
        page = await launchCdpSession(join(scratch, 'profile'), {onEvent: async (event, send) => {
            if (event.sessionId) control = send;
            const params = event.params ?? {};
            if (event.method === 'Runtime.exceptionThrown') {
                const details = params.exceptionDetails as {text?: string; exception?: {description?: string}};
                browserErrors.push({method: event.method, text: redact(details.text ?? ''),
                    description: redact(details.exception?.description ?? '')});
            }
            if (event.method === 'Runtime.consoleAPICalled' && params.type === 'error') {
                const args = params.args as {value?: unknown; description?: string}[];
                browserErrors.push({method: event.method,
                    text: args.map(arg => redact(String(arg.value ?? arg.description ?? ''))).join(' ')});
            }
            if (event.method === 'Network.requestWillBeSent') {
                const request = params.request as {url: string; method: string};
                networkRequests.set(params.requestId as string, {url: request.url.split(/[?#]/)[0]!, method: request.method});
            }
            if (event.method === 'Network.loadingFailed') networkFailures.push({
                ...networkRequests.get(params.requestId as string), requestId: params.requestId,
                errorText: params.errorText, canceled: params.canceled, blockedReason: params.blockedReason,
                corsErrorStatus: params.corsErrorStatus, type: params.type});
            if (event.method === 'Network.responseReceived') {
                const response = params.response as {url: string; status: number};
                const url = response.url.split(/[?#]/)[0]!;
                if (url.endsWith('/ui/displayed') || url.endsWith('/ui/acts'))
                    uiResponses.push({requestId: params.requestId, url, status: response.status});
            }
            if (event.method === 'Fetch.requestPaused') {
                const requestId = event.params!.requestId;
                if (corruptTiles) await send('Fetch.fulfillRequest', {requestId, responseCode: 200,
                    responseHeaders: [{name: 'Content-Type', value: 'image/png'}],
                    body: makeSyntheticPngBytes(255, 0, 0).toString('base64')});
                else await send('Fetch.continueRequest', {requestId});
            }
        }});
        await until(async () => !!control, 'CDP page session');
        await control!('Network.enable');
        await page.setViewport(1440, 900);
        assert.ok(grant);
        await inspect(planHost, 'rig-review/job-api@3', publication, evidence.packet, 'plan-' + language, grant.fetchCapability);
        let packageGrant: {fetchCapability: string} | undefined;
        pkg = await realJobWindowFixture({installWriterBinding: binding => {packageGrant = binding;}});
        const packagePlan = createSyntheticPlanRecordWorkspace(pkg.input.root,{steps:[{id:'step-one',hash:'1'.repeat(64)}],
            subjects:[{kind:'checkpoint',checkpointId:'step-one'}],text});
        pkg.input.setRecordPath('project.json');
        const packageEvidence = syntheticCheckpointEvidence(pkg.input.root, 'motion-card', 'step-one');
        const beforePackageHashes = await jobInputHashes(pkg.input.root);
        pkg.input.setContext({...pkg.input.getContext(), checkpointEvidence: [packageEvidence.packet],
            files: [...packagePlan.files,...packageEvidence.files].sort((a,b)=>a.path<b.path?-1:1),
            subjects: [{kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}]});
        const packagePublication = await pkg.publish();
        await call(pkg.host, 'rig-review/job-api@2', {verb: 'ask', expectedGeneration: pkg.host.session.status().generation,
            idempotencyKey: randomUUID(), publicationId: packagePublication.publicationId,
            subject: {kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}});
        assert.ok(packageGrant);
        await inspect(pkg.host, 'rig-review/job-api@2', packagePublication, packageEvidence.packet,
            'package-' + language, packageGrant.fetchCapability);
        assert.deepEqual(await jobInputHashes(root),beforePlanHashes,'record source bytes stay immutable');
        assert.deepEqual(await jobInputHashes(pkg.input.root),beforePackageHashes,'package source bytes stay immutable');
        observations['plan-text-provenance']={kind:'SYNTHETIC_REVIEW_RECORD_CHECKPOINT',fields:text,recordFiles:beforePlanHashes,packageFiles:beforePackageHashes};
        for (const [host, schema] of [[planHost, 'rig-review/job-api@3'], [pkg.host, 'rig-review/job-api@2']] as const)
            await call(host, schema, {verb: 'close', expectedGeneration: host.session.status().generation,
                idempotencyKey: randomUUID(), reason: 'synthetic checkpoint browser complete'});
        await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    } catch (error) {
        const failure: Record<string, unknown> = {error: redact(error instanceof Error ? error.message : String(error)), latestNext};
        if (activeDecision) {
            const {host, ...decision} = activeDecision;
            failure.activeDecision = decision;
            try {failure.form = await checkpointForm(decision.askId);}
            catch (diagnosticError) {failure.formError = redact(String(diagnosticError));}
            try {
                const status = host.session.status();
                failure.host = {jobId: status.jobId, generation: status.generation, status: status.status, cursor: status.cursor,
                    publicationId: status.publication?.publicationId, sourceHash: status.publication?.source.sourceHash,
                    pending: status.pending.map(ask => ({askId: ask.askId, publicationId: ask.publicationId,
                        status: ask.status, subject: ask.subject}))};
                failure.next = summarizeNext(await call(host, decision.schema, {verb: 'next', after: null, waitMs: 0}));
            } catch (diagnosticError) {failure.hostError = redact(String(diagnosticError));}
        }
        observations.failure = failure;
        observations.browserErrors = browserErrors;
        observations.networkFailures = networkFailures;
        observations.uiResponses = uiResponses;
        if (page) {
            try {await writeFile(join(output, 'failure.png'), await page.screenshot());}
            catch (diagnosticError) {failure.screenshotError = redact(String(diagnosticError));}
        }
        await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
        throw error;
    } finally {
        await page?.close();
        await pkg?.close();
        planHost?.stop();
        await rm(scratch, {recursive: true, force: true});
    }
}
if (import.meta.main) await run();
