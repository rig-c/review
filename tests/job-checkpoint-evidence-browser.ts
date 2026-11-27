/** Ordinary Nova orchestration for #629 and #606. Synthetic sealed evidence, never producer output.
 * #1229: converted from the retired checkpoint Pass/Fail form and outcome submission loop to verifying retained
 * checkpointEvidence API/seal routes, fresh checkpoint ask refusals (JOB_REQUEST_INVALID), no-ask comment survival + act@10
 * submission, historical checkpoint act consumer fetch-act readback, and corrupt tile hash refusal.
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {JobCheckpointEvidence, JobCheckpointTable, NextValueV3, PlanContext} from '../src/job-contract.ts';
import {checkpointNoteComments, projectComments} from '../src/stage-comment.ts';
import {JOB_COMMENT_ONLY_ACT_SCHEMA, JOB_RECORD_READER_ID} from '../src/job-contract.ts';
import {parseCommentOnlyAct} from '../src/job-api.ts';
import {startJobHost} from '../src/job-front.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader, makeSyntheticPngBytes,
    writeWorkspaceFile} from './helpers/job-record-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {seedHistoricalCheckpointAct} from './helpers/historical-checkpoint-act.ts';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {inspectPartsViewportPng, type HalfOpenBox, type RgbaTuple} from './helpers/job-window-paint.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
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
    let expectedDeparture: URL | undefined;
    let latestNext: ReturnType<typeof summarizeNext> | undefined;
    const browserErrors: Record<string, unknown>[] = [];
    const networkFailures: Record<string, unknown>[] = [];
    const uiResponses: Record<string, unknown>[] = [];
    const networkRequests = new Map<string, {url: string; method: string}>();
    const redact = (text: string) => text.replace(/#cap=[^\s"']+/g, '#cap=<redacted>');
    function summarizeNext(next: NextValueV3) {
        return {status: next.status, cursor: next.cursor, events: next.events.map(event => ({
            type: event.type, generation: event.generation, cursor: event.cursor,
            ...(event.type === 'act' ? {actId: event.act.actId, kind: event.act.kind} : {}),
            ...(event.type === 'pending' ? {askId: event.ask.askId, status: event.ask.status, subject: event.ask.subject} : {}),
        }))};
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
    async function expectCheckpointAskRefused(host: Awaited<ReturnType<typeof startJobHost>>, schema: string, publicationId: string, packet: JobCheckpointEvidence) {
        const response = await fetch(`${host.origin}/jobs/${host.session.jobId}/api`, {method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + host.session.hostCredentials().agent},
            body: JSON.stringify({schema, jobId: host.session.jobId, requestId: randomUUID(), verb: 'ask',
                expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), publicationId,
                subject: {kind: 'checkpoint', checkpointId: packet.checkpointId,
                    ...(schema === 'rig-review/job-api@2' ? {planStepId: packet.planStepId} : {})}})});
        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.ok, false, JSON.stringify(body));
        assert.equal(body.error.code, 'JOB_REQUEST_INVALID');
        assert.equal(body.error.message, 'Unknown job verb: ask');
    }
    async function inspect(host: Awaited<ReturnType<typeof startJobHost>>, schema: string,
        publication: {publicationId: string; source: {sourceHash: string; projectHash?: string | null}}, packet: JobCheckpointEvidence, prefix: string,
        fetchCapability: string) {
        await expectCheckpointAskRefused(host, schema, publication.publicationId, packet);
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
            await until(() => page!.evaluate<boolean>(`document.body.dataset.ready==='true'&&!!document.getElementById('send-comments')&&!document.getElementById('send-comments').hidden`), prefix + ' ready');
            const layout = await page!.evaluate<any>(`(()=>{
              const panel=document.querySelector('#workspace-communication');
              const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
              return {viewport:{width:innerWidth,height:innerHeight},panel:rect(panel),forms:document.querySelectorAll('form[data-job-ask]').length,
                retiredRecordDomCount:document.querySelectorAll('[id="job-record-asks"],[id="workspace-pending-record-ask"]').length,
                legacy:document.querySelectorAll('.job-inspection,[data-job-forms],[data-job-plan-workspace]').length,
                scripts:document.querySelectorAll('#workspace-communication script').length};
            })()`);
            layout.phase=phase;layout.sourceHash=publication.source.sourceHash;layout.recordSha256=publication.source.projectHash;
            layoutObservations.push(layout);assert.deepEqual(layout.viewport,viewport);
            assert.equal(layout.forms,0,prefix+' no checkpoint form mounted');
            assert.equal(layout.retiredRecordDomCount,0,prefix+' retired checkpoint DOM absent');
            assert.equal(layout.legacy,0);assert.equal(layout.scripts,0);assert.ok(layout.recordSha256,prefix+' authenticated text record');
            assert.ok(layout.panel.left>=0&&layout.panel.top>=0&&layout.panel.right<=viewport.width,prefix+' communication panel is bounded');
            let screenshot:Uint8Array|undefined;
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
                            : pane.canvases.some((canvas: any) =>
                                canvas.width > 0 && canvas.height > 0 &&
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
        }
        const display=host.session.displayPublication(publication.publicationId);
        const base=`${host.origin}/jobs/${host.session.jobId}/publications/${publication.publicationId}/instances/${display.publication.instanceKey}`;
        const response=await fetch(base+'/api/review');assert.equal(response.status,200);
        const metadata=await response.json();
        const retained=metadata.checkpointEvidence.find((entry:JobCheckpointEvidence)=>entry.checkpointId===packet.checkpointId);
        assert.ok(retained,prefix+' retained checkpoint packet');
        assert.equal(metadata.sourceHash,publication.source.sourceHash);
        assert.deepEqual(display.publication.source.checkpointEvidence?.find(entry=>entry.checkpointId===packet.checkpointId),packet);
        assert.equal(retained.planStepId,packet.planStepId);
        assert.deepEqual(retained.tiles.map(({url,...tile}:any)=>tile),packet.tiles);
        assert.equal(retained.table.path,packet.table.path);assert.equal(retained.table.sha256,packet.table.sha256);
        assert.deepEqual(retained.table.columns,evidence.table.columns);assert.deepEqual(retained.table.rows,evidence.table.rows);
        assert.equal(retained.routesText,packet.routesText);assert.equal(retained.recommendationText,packet.recommendationText);
        if (metadata.planText?.status === 'projected') {
            const stepRow = metadata.planText.steps.find((row: {id: string}) => row.id === packet.planStepId);
            assert.ok(stepRow, prefix + ' projected planText step');
            assert.equal(stepRow.does, text.does);
            assert.equal(stepRow.bar, text.bar);
            assert.deepEqual(stepRow.rests_on, text.rests_on);
        }
        for(const file of [...retained.tiles,retained.table]){
            const raw=await fetch(base+file.url);assert.equal(raw.status,200);
            const bytes=Buffer.from(await raw.arrayBuffer());
            assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,prefix+' immutable evidence member');
        }
        assert.equal(await page!.evaluate(`document.querySelectorAll('[data-job-checkpoint-evidence]').length`),0,'retired evidence grid is absent');

        // #1229: leave a comment, verify it survives reconnect, and submit via Send comments (act@10).
        const words = `comment 한글 <owner> ${prefix}`;
        await page!.evaluate(`document.querySelector('[data-comment-general]').click()`);
        await until(()=>page!.evaluate(`!!document.querySelector('.stage-comment-composer input')`),'existing comment composer');
        await page!.evaluate(`(()=>{const composer=document.querySelector('.stage-comment-composer');composer.querySelector('input').value=${JSON.stringify(words)};composer.requestSubmit();})()`);
        await until(()=>page!.evaluate(`!document.querySelector('.stage-comment-composer')`),'existing comment saved');
        expectedDeparture = owner;
        try {await page!.goto('about:blank');} finally {expectedDeparture = undefined;}
        await page!.goto(owner.href);
        await until(() => page!.evaluate<boolean>(`document.body.dataset.ready==='true'&&Array.from(document.querySelectorAll('.stage-comment-summary'),n=>n.textContent??'').some(t=>t.includes(${JSON.stringify(words)}))`), prefix + ' saved comment restored');
        await click(page!, '#send-comments');
        let commentAct: any;
        await until(async () => {
            const next = await call(host, schema, {verb: 'next', after: null, waitMs: 0});
            latestNext = summarizeNext(next);
            commentAct = next.events.find((event: any) => event.type === 'act' && event.act.kind === 'comments')?.act;
            return !!commentAct;
        }, 'comment-only act');
        assert.equal(commentAct.schema, JOB_COMMENT_ONLY_ACT_SCHEMA);
        const parsedCommentAct = parseCommentOnlyAct(commentAct);
        assert.equal(parsedCommentAct.source.sourceHash, publication.source.sourceHash);
        assert.deepEqual(parsedCommentAct.value.comments.map(c => c.text), [words]);
        observations[prefix + '-comments-act'] = {actId: parsedCommentAct.actId, sourceHash: parsedCommentAct.source.sourceHash};

        // #1229: historical checkpoint acts (pass and fail) remain readable via consumer fetch-act.
        for (const outcome of ['pass', 'fail'] as const) {
            const note = `${outcome} 한글 <owner>`;
            const projected = projectComments([{text: note}]);
            const seeded = seedHistoricalCheckpointAct(host.session, {
                publicationId: publication.publicationId,
                pageId: 'historical-page-' + outcome,
                displayedNonce: 'historical-nonce-' + outcome,
                expectedGeneration: host.session.status().generation,
                submissionId: 'historical-sub-' + outcome,
                checkpointId: packet.checkpointId,
                planStepId: packet.planStepId,
                value: {checkpointId: packet.checkpointId, outcome, words: projected},
            });
            const fetched = await call(host, schema, {verb: 'fetch-act', actId: seeded.actId}, fetchCapability);
            assert.equal(fetched.source.sourceHash, publication.source.sourceHash);
            assert.equal(fetched.value.checkpointId, packet.checkpointId);
            assert.equal(fetched.value.planStepId, packet.planStepId);
            assert.equal(fetched.value.outcome, outcome);
            if ('comments' in fetched.value) {
                const comments = checkpointNoteComments({checkpointId: packet.checkpointId, planStepId: packet.planStepId, note: projected});
                assert.deepEqual(fetched.value.comments, comments);
                assert.equal(projectComments(fetched.value.comments), projectComments(comments));
            } else assert.equal(fetched.value.words, projected);
            observations[prefix + '-historical-' + outcome] = {actId: fetched.actId, sourceHash: fetched.source.sourceHash, value: fetched.value};
        }

        corruptTiles = true;
        await control!('Fetch.enable', {patterns: [{urlPattern: '*checkpoint-evidence/*/tiles/0', requestStage: 'Request'}]});
        expectedDeparture = owner;
        try {await page!.goto('about:blank');} finally {expectedDeparture = undefined;}
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
        page = await launchCdpSession(join(scratch, 'profile'), {sendDeadlineMs: 15_000, onEvent: async (event, send) => {
            if (event.sessionId) control = send;
            const params = event.params ?? {};
            if (event.method === 'Page.javascriptDialogOpening') {
                const url = new URL(String(params.url));
                assert.equal(params.type, 'beforeunload', 'only the dirty-comment reconnect departure is expected');
                assert.ok(expectedDeparture && url.origin === expectedDeparture.origin && url.pathname === expectedDeparture.pathname);
                await send('Page.handleJavaScriptDialog', {accept: true});
            }
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
        // Declare a pair on the package packet so prepareJobInspection verifies sealed tile hashes for pin replay without mounting the pair view.
        const pairedPackagePacket: JobCheckpointEvidence = {...packageEvidence.packet,
            pair: {before: {id: packageEvidence.packet.tiles[0]!.id, sha256: packageEvidence.packet.tiles[0]!.sha256},
                after: {id: packageEvidence.packet.tiles[1]!.id, sha256: packageEvidence.packet.tiles[1]!.sha256}}};
        const beforePackageHashes = await jobInputHashes(pkg.input.root);
        pkg.input.setContext({...pkg.input.getContext(), checkpointEvidence: [pairedPackagePacket],
            files: [...packagePlan.files,...packageEvidence.files].sort((a,b)=>a.path<b.path?-1:1),
            subjects: [{kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'step-one'}]});
        const packagePublication = await pkg.publish();
        assert.ok(packageGrant);
        await inspect(pkg.host, 'rig-review/job-api@2', packagePublication, pairedPackagePacket,
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
        observations.failure = failure;
        observations.browserErrors = browserErrors;
        observations.networkFailures = networkFailures;
        observations.uiResponses = uiResponses;
        if (page) {
            try {await writeFile(join(output, 'failure.png'), await page.screenshot());} catch {}
        }
        await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
        throw error;
    } finally {
        try {await page?.close();}
        finally {
            try {planHost?.stop();}
            finally {
                try {await pkg?.close();}
                finally {await rm(scratch, {recursive: true, force: true});}
            }
        }
    }
}

if (import.meta.main) await run();
