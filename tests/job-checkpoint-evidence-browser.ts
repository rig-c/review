/** Ordinary Nova orchestration for #629. Synthetic sealed evidence, never producer output.
 * Run after parent exact-commit GO with --lang en or --lang ko.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {JobCheckpointEvidence, JobCheckpointTable, PlanContext} from '../src/job-contract.ts';
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
            await until(() => page!.evaluate(`!!document.querySelector('form[data-job-ask="${asked.askId}"] select[name=outcome]')`), 'decision form');
            await page!.evaluate(`(()=>{const f=document.querySelector('form[data-job-ask="${asked.askId}"]');
                f.querySelector('select[name=outcome]').value=${JSON.stringify(outcome)};
                f.querySelector('textarea[name=note]').value=${JSON.stringify(words)};
                f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
            // Reconnect preserves the source-bound owner draft before its ordinary UI submission.
            await page!.goto('about:blank');
            await page!.goto(owner.href);
            await until(() => page!.evaluate(`document.querySelector('form[data-job-ask="${asked.askId}"] textarea[name=note]')?.value===${JSON.stringify(words)}`), 'restored words');
            await page!.evaluate(`document.querySelector('form[data-job-ask="${asked.askId}"]').requestSubmit()`);
            let act: any;
            await until(async () => {
                const next = await call(host, schema, {verb: 'next', after: null, waitMs: 0});
                act = next.events.find((event: any) => event.type === 'act' && event.act.askId === asked.askId)?.act;
                return !!act;
            }, 'finalized act');
            const fetched = await call(host, schema, {verb: 'fetch-act', actId: act.actId}, fetchCapability);
            assert.equal(fetched.source.sourceHash, publication.source.sourceHash);
            assert.deepEqual(fetched.value, {checkpointId: packet.checkpointId, planStepId: packet.planStepId, outcome, words});
            observations[prefix + '-' + outcome] = {actId: fetched.actId, sourceHash: fetched.source.sourceHash, value: fetched.value};
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
            if (event.method === 'Fetch.requestPaused') {
                const requestId = event.params!.requestId;
                if (corruptTiles) await send('Fetch.fulfillRequest', {requestId, responseCode: 200,
                    responseHeaders: [{name: 'Content-Type', value: 'image/png'}],
                    body: makeSyntheticPngBytes(255, 0, 0).toString('base64')});
                else await send('Fetch.continueRequest', {requestId});
            }
        }});
        await page.setViewport(1440, 1000);
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
        await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
        if (page) await writeFile(join(output, 'failure.png'), await page.screenshot());
        throw error;
    } finally {
        await page?.close();
        await pkg?.close();
        planHost?.stop();
        await rm(scratch, {recursive: true, force: true});
    }
}
if (import.meta.main) await run();
