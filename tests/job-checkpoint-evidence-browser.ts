/** Ordinary Nova orchestration for #629. Synthetic sealed evidence, never producer output.
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
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
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
    const plan = createSyntheticPlanRecordWorkspace(root);
    const evidence = syntheticCheckpointEvidence(root);
    const context: PlanContext = {...plan.context, checkpointEvidence: [evidence.packet],
        files: [...plan.files, ...evidence.files].sort((a, b) => a.path < b.path ? -1 : 1)};
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
        publication: {publicationId: string; source: {sourceHash: string}}, packet: JobCheckpointEvidence, prefix: string,
        fetchCapability: string) {
        const owner = new URL(host.ownerUrl);
        owner.searchParams.set('lang', language);
        await page!.goto(owner.href);
        await until(() => page!.evaluate(`!!document.querySelector('[data-job-checkpoint-evidence]')`), prefix + ' evidence');
        const layoutObservations: unknown[] = [];
        observations[prefix + '-layout'] = layoutObservations;
        for (const viewport of [{width: 1024, height: 768}, {width: 1440, height: 900}]) {
            await page!.setViewport(viewport.width, viewport.height);
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
            layoutObservations.push(layout);
            assert.deepEqual(layout.viewport, viewport);
            assert.equal(layout.askId, askId);
            assert.ok(Math.abs(layout.inspection.bottom - layout.main.bottom) <= 1,
                prefix + ' inspection must fill main at ' + viewport.width);
            assert.ok(layout.formsClientHeight >= viewport.height * 0.5,
                prefix + ' forms must occupy at least half the viewport height at ' + viewport.width);
            assert.ok(Math.abs(layout.stage.height - 250) <= 1, prefix + ' stage stays 250px');
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
                }
            }
            for (const child of layout.stageChildren) {
                if (!child.visible) continue;
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
            await writeFile(join(output, prefix + '-' + viewport.width + 'x' + viewport.height + '-layout.png'), await page!.screenshot());
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
        const packageEvidence = syntheticCheckpointEvidence(pkg.input.root, 'motion-card', 'step-one');
        pkg.input.setContext({...pkg.input.getContext(), checkpointEvidence: [packageEvidence.packet],
            files: packageEvidence.files,
            subjects: [{kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}]});
        const packagePublication = await pkg.publish();
        await call(pkg.host, 'rig-review/job-api@2', {verb: 'ask', expectedGeneration: pkg.host.session.status().generation,
            idempotencyKey: randomUUID(), publicationId: packagePublication.publicationId,
            subject: {kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}});
        assert.ok(packageGrant);
        await inspect(pkg.host, 'rig-review/job-api@2', packagePublication, packageEvidence.packet,
            'package-' + language, packageGrant.fetchCapability);
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
