import { describe, expect, test } from 'bun:test';
import {prepareJobInspection, resolveJobPanels, jobPartsReviewState, jobPartsPainting, type JobInspectionMetadataV3, createJobWindow, createJobReferenceSelection, prepareJobForms, jobCheckpointContext, jobPublicationRoutes, jobWindowAccess, jobWindowEvents, startJobWindowEvents, jobWindowRefusal, type JobWindowState } from '../web/job-session.ts';
import { JOB_RECORD_ACT_SCHEMA, type DisplayPublicationV3, type JobDisplayPublication, type JobDisplayReceipt, type JobResult, type JobModelSourceBinding, type JobRigCapture, type PendingAskV3, type UISubmissionV3, type ActV3, type JobPartsVerdictAct, type RecordAct } from '../src/job-contract.ts';
import { buildRecordSource, parseRecordAct, parseRecordPublishedContext, parseRecordSource, recordInstanceKey } from '../src/job-api.ts';
import {createJobRigSubmission} from '../web/job-rig-capture.ts';
import { createJobWindowFixture, fixturePublication, fixtureAct } from './helpers/job-window-fixture.ts';
import {t} from '../web/i18n.ts';
import {jobHubMessageMatches, JOB_HUB_VISIBILITY, type JobHubBinding} from '../web/job-hub.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';

test('C4 panel parser shares one browser-safe implementation with manifest compatibility exports', async () => {
    const contract = await import('../src/job-contract.ts');
    const manifest = await import('../src/manifest.ts');
    expect(manifest.parsePanelComposition).toBe(contract.parsePanelComposition);
    expect(manifest.isPanelComponent).toBe(contract.isPanelComponent);
    expect(contract.isPanelComponent('parts.canvas')).toBe(true);
    expect(contract.isPanelComponent('future.component')).toBe(false);
    expect<unknown>(contract.parsePanelComposition({schema: contract.JOB_PANEL_COMPOSITION_SCHEMA,
        stage: ['future.component'], side: ['act.submit']})).toEqual({
        schema: contract.JOB_PANEL_COMPOSITION_SCHEMA, stage: ['future.component'], side: ['act.submit'],
    });
});

test('C4 job browser runtime graph excludes the server manifest and Node imports and rejects a planted edge', async () => {
    const entry = new URL('../web/job-session.ts', import.meta.url);
    const manifest = new URL('../src/manifest.ts', import.meta.url).href;
    const transpiler = new Bun.Transpiler({loader: 'ts', target: 'browser'});
    async function runtimeGraph(extraEntryImport = '') {
        const pending = [entry];
        const files = new Set<string>();
        const imports = new Set<string>();
        while (pending.length) {
            const file = pending.pop()!;
            if (files.has(file.href)) continue;
            files.add(file.href);
            if (!file.pathname.endsWith('.ts') && !file.pathname.endsWith('.js')) continue;
            const source = await Bun.file(file).text();
            const javascript = transpiler.transformSync(source + (file.href === entry.href ? extraEntryImport : ''));
            for (const dependency of transpiler.scan(javascript).imports) {
                imports.add(dependency.path);
                if (dependency.path.startsWith('.')) pending.push(new URL(dependency.path, file));
            }
        }
        return {files, imports};
    }
    function assertBrowserBoundary(graph: Awaited<ReturnType<typeof runtimeGraph>>) {
        expect(graph.files.has(manifest)).toBe(false);
        expect([...graph.imports].filter(path => path.startsWith('node:'))).toEqual([]);
    }
    const graph = await runtimeGraph();
    expect(graph.files.has(new URL('../src/job-contract.ts', import.meta.url).href)).toBe(true);
    expect(graph.files.has(new URL('../web/parts.ts', import.meta.url).href)).toBe(true);
    const contractSource = await Bun.file(new URL('../src/job-contract.ts', import.meta.url)).text();
    expect(transpiler.scan(transpiler.transformSync(contractSource)).imports).toEqual([]);
    assertBrowserBoundary(graph);
    const mutant = await runtimeGraph("\nvoid import('../src/manifest.ts');");
    expect(mutant.files.has(manifest)).toBe(true);
    expect([...mutant.imports]).toContain('node:fs/promises');
    expect(() => assertBrowserBoundary(mutant)).toThrow();
});

test('window refusals retain registered codes and bound arbitrary runtime prose', () => {
    expect(jobWindowRefusal(new Error('INTERVIEW_OPTIONS_STALE'))).toBe(t('INTERVIEW_OPTIONS_STALE'));
    expect(jobWindowRefusal(new Error('Unregistered runtime detail /private/path'))).toBe(t('JOB_WINDOW_FAILED'));
    expect(jobWindowRefusal(new Error('UNREGISTERED_MACHINE_CODE'), 'JOB_VISUAL_UNAVAILABLE')).toBe(t('JOB_VISUAL_UNAVAILABLE'));
    expect(jobWindowRefusal(null, 'JOB_ACT_INVALID')).toBe(t('JOB_ACT_INVALID'));
});
function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(done => { resolve = done; });
    return { promise, resolve };
}
describe('reference selection at the inspection time', () => {
    type Reference = {id: string; frameTime: number; seek(time: number, signal: AbortSignal): Promise<void>};
    function selection() {
        const state = {owner: {} as object | null, time: 0.75};
        let visible = {id: 'previous', frameTime: 0.75};
        const presented: string[] = [];
        const failures: unknown[] = [];
        const controls = createJobReferenceSelection<Reference>({current: () => state,
            present(value) {visible = {id: value.id, frameTime: value.frameTime}; presented.push(value.id);},
            refused(error) {failures.push(error);}});
        return {state, controls, presented, failures, visible: () => visible};
    }

    test('a delayed video is sought before replacing the previous coherent frame', async () => {
        const h = selection();
        const ready = deferred<void>();
        const times: number[] = [];
        const video: Reference = {id: 'video', frameTime: 0, async seek(time) {
            times.push(time); await ready.promise; this.frameTime = time;
        }};
        const selected = h.controls.select(video);
        expect(times).toEqual([0.75]);
        expect(h.visible()).toEqual({id: 'previous', frameTime: 0.75});
        ready.resolve();
        await selected;
        expect(h.visible()).toEqual({id: 'video', frameTime: 0.75});
    });

    test('a pose draws the current inspection time before presentation', async () => {
        const h = selection();
        const pose: Reference = {id: 'pose', frameTime: 0, async seek(time) {this.frameTime = time;}};
        await h.controls.select(pose);
        expect(h.visible()).toEqual({id: 'pose', frameTime: 0.75});
        expect(h.failures).toEqual([]);
    });

    test('an out-of-domain seek names the refusal and retains the previous reference', async () => {
        const h = selection();
        const previous = h.visible();
        const short: Reference = {id: 'short', frameTime: 0, async seek() {throw new Error('REFERENCE_OUT_OF_DOMAIN');}};
        await h.controls.select(short);
        expect(h.visible()).toEqual(previous);
        expect(h.presented).toEqual([]);
        expect(h.failures).toHaveLength(1);
        expect(jobWindowRefusal(h.failures[0])).toBe(t('REFERENCE_OUT_OF_DOMAIN'));
    });

    test('rapid selection suppresses an older successful seek and its late failure', async () => {
        const h = selection();
        const ready = deferred<void>();
        const observed: {signal?: AbortSignal} = {};
        const old: Reference = {id: 'old-video', frameTime: 0, async seek(time, signal) {
            observed.signal = signal; await ready.promise; this.frameTime = time;
        }};
        const oldRequest = h.controls.select(old);
        const latest: Reference = {id: 'latest-pose', frameTime: 0, async seek(time) {this.frameTime = time;}};
        await h.controls.select(latest);
        ready.resolve();
        await oldRequest;
        expect(observed.signal?.aborted).toBe(true);
        expect(h.presented).toEqual(['latest-pose']);
        expect(h.visible()).toEqual({id: 'latest-pose', frameTime: 0.75});
        const rejected = deferred<void>();
        const failing: Reference = {id: 'stale-failure', frameTime: 0, async seek() {
            await rejected.promise; throw new Error('REFERENCE_OUT_OF_DOMAIN');
        }};
        const failure = h.controls.select(failing);
        await h.controls.select(latest);
        rejected.resolve();
        await failure;
        expect(h.failures).toEqual([]);
    });

    test('a time change during seek is resolved at the latest time before presentation', async () => {
        const h = selection();
        const ready = deferred<void>();
        const times: number[] = [];
        const video: Reference = {id: 'video', frameTime: 0, async seek(time) {
            times.push(time); if (times.length === 1) await ready.promise; this.frameTime = time;
        }};
        const request = h.controls.select(video);
        h.state.time = 0.9;
        ready.resolve();
        await request;
        expect(times).toEqual([0.75, 0.9]);
        expect(h.visible()).toEqual({id: 'video', frameTime: 0.9});
    });

    test('publication replacement and explicit cancellation prevent late presentation', async () => {
        for (const replaceOwner of [true, false]) {
            const h = selection();
            const ready = deferred<void>();
            const video: Reference = {id: 'video', frameTime: 0, async seek(time) {
                await ready.promise; this.frameTime = time;
            }};
            const request = h.controls.select(video);
            if (replaceOwner) h.state.owner = {}; else h.controls.cancel();
            ready.resolve();
            await request;
            expect(h.presented).toEqual([]);
            expect(h.failures).toEqual([]);
        }
    });
});
function harness() {
    const fixture = createJobWindowFixture();
    const notices: JobWindowState[] = [];
    const disposed: string[] = [];
    const rollbacks: string[] = [];
    let live: {
        display: DisplayPublicationV3;
        draft: {
            words: string;
        };
    } | null = null;
    let preparation: ((display: DisplayPublicationV3, signal: AbortSignal) => Promise<void>) | null = null;
    let acknowledgment: (() => Promise<JobResult<JobDisplayReceipt>>) | null = null;
    let failCleanup = false;
    const request = (body: unknown) => new Request('http://127.0.0.1:4318/jobs/window-fixture/ui/displayed', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:4318' },
        body: JSON.stringify(body),
    });
    const window = createJobWindow({
        jobId: fixture.jobId, pageId: 'page-one',
        transport: {
            readPublication: publicationId => fixture.ports.readPublication(fixture.jobId, publicationId),
            acknowledge: body => acknowledgment?.() ?? fixture.ports.ackDisplayed(fixture.jobId, request(body)),
            submit: body => fixture.ports.commitUIAct(fixture.jobId, request(body)),
        },
        adapter: {
            async prepare(display, signal) { await preparation?.(display, signal); return display; },
            captureDraft: () => live?.draft.words ? live.draft : null,
            commit(display) {
                const previous = live;
                live = { display, draft: { words: '' } };
                return {
                    rollback() { rollbacks.push(display.publication.publicationId); live = previous; },
                    finalize() {
                        if (failCleanup)
                            throw new Error('planted cleanup failure');
                        if (previous)
                            disposed.push(previous.display.publication.publicationId);
                    },
                };
            },
            async painted() { },
            discard(display) { disposed.push(display.publication.publicationId); },
            changed(state) { notices.push(state); },
        },
    });
    return {
        fixture, window, notices, disposed, rollbacks,
        live: () => live,
        prepareWith(value: typeof preparation) { preparation = value; },
        acknowledgeWith(value: typeof acknowledgment) { acknowledgment = value; },
        failCleanup() { failCleanup = true; },
        async publish(index: number, source?: DisplayPublicationV3['publication']['source']) {
            const display: DisplayPublicationV3 = fixturePublication(index);
            if (source)
                Object.assign(display, { publication: { ...display.publication, source } });
            fixture.publish(display);
            window.event(fixture.events.at(-1)!);
            await window.settled();
            return display;
        },
    };
}

test('#557 window replays its exact attempted Rig request after an act event and refuses cloned or stale requests', async () => {
    const h = harness(), act = fixtureAct('review-verdict', 'original words');
    const display = await h.publish(1, act.source);
    const ask = {askId: act.askId, publicationId: display.publication.publicationId,
        subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const}, source: act.source, status: 'pending' as const};
    h.fixture.pending(ask, 2);
    h.window.event(h.fixture.events.at(-1)!);
    h.fixture.returnAct(act);
    const page = h.window.state().receipt!;
    const capture: JobRigCapture = {png: 'data:image/png;base64,Zmlyc3Q=', width: 2, height: 2,
        camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
        binding: {publicationId: page.publicationId, instanceKey: display.publication.instanceKey,
            sourceHash: display.publication.source.sourceHash, pageId: page.pageId, askId: ask.askId,
            drawGeneration: 1, playerGeneration: 1}};
    const input = await createJobRigSubmission().prepare({...page, askId: ask.askId, expectedGeneration: 2,
        submissionId: 'rig-attempt', kind: 'review-verdict',
        value: {stage: 'rig-review', verdict: 'approved', words: 'original words'}}, () => ({encode: async () => capture}));
    expect((await h.window.submit(input)).ok).toBe(true);
    h.window.event({type: 'act', jobId: h.fixture.jobId, cursor: 'rig-answered', generation: 3, act});
    expect((await h.window.submit(input)).ok).toBe(true);
    expect(h.fixture.submissions).toHaveLength(2);
    expect(h.fixture.submissions[0].body).toEqual(h.fixture.submissions[1].body);
    expect((await h.window.submit(structuredClone(input))).ok).toBe(false);
    await h.publish(2);
    expect((await h.window.submit(input)).ok).toBe(false);
    expect(h.fixture.submissions).toHaveLength(2);
});

test('#557 window rejects a source change during encoding before transport receives the frozen old capture', async () => {
    const h = harness(), act = fixtureAct('review-verdict');
    const display = await h.publish(1, act.source), page = h.window.state().receipt!;
    const ready = deferred<JobRigCapture>();
    const pending = createJobRigSubmission().prepare({...page, askId: act.askId, expectedGeneration: 1,
        submissionId: 'delayed-rig', kind: 'review-verdict', value: {stage: 'rig-review', verdict: 'approved', words: 'old source'}},
        () => ({encode: () => ready.promise}));
    await h.publish(2);
    ready.resolve({png: 'data:image/png;base64,Zmlyc3Q=', width: 2, height: 2,
        camera: 'fixed', framing: 'default', view: 'whole-rig', frame: 'setup', playing: false,
        binding: {publicationId: page.publicationId, instanceKey: display.publication.instanceKey,
            sourceHash: display.publication.source.sourceHash, pageId: page.pageId, askId: act.askId,
            drawGeneration: 1, playerGeneration: 1}});
    expect((await h.window.submit(await pending)).ok).toBe(false);
    expect(h.fixture.submissions).toHaveLength(0);
});
describe('job window on the frozen host ports', () => {
    test('the fake implements replay and abort through subscribeJob', async () => {
        const f = createJobWindowFixture();
        f.publish(fixturePublication(1));
        f.publish(fixturePublication(2));
        const controller = new AbortController();
        const stream = f.ports.subscribeJob({ jobId: f.jobId, after: '1', signal: controller.signal })[Symbol.asyncIterator]();
        expect((await stream.next()).value?.cursor).toBe('2');
        const waiting = stream.next();
        controller.abort();
        expect((await waiting).done).toBe(true);
        expect(await f.ports.jobLiveness(f.jobId)).toEqual({ ok: true, value: { active: true, busy: false } });
        f.close(3);
        expect(await f.ports.jobLiveness(f.jobId)).toEqual({ ok: true, value: { active: false, busy: false } });
    });
    test('three pinned publications commit and retire each old view after acknowledgment', async () => {
        const h = harness();
        await h.publish(1);
        await h.publish(2);
        await h.publish(3);
        expect(h.window.state().displayed?.publication.publicationId).toBe('publication-3');
        expect(h.window.state().previousLabel).toBe('Rig 2');
        expect(h.fixture.acknowledgments).toHaveLength(3);
        expect(h.disposed).toEqual(['publication-1', 'publication-2']);
        h.window.stop();
    });
    test('all preparation finishes before commit and display acknowledgment', async () => {
        const h = harness();
        await h.publish(1);
        const ready = deferred<void>();
        const entered = deferred<void>();
        h.prepareWith(async () => { entered.resolve(); await ready.promise; });
        const publishing = h.publish(2);
        await entered.promise;
        expect(h.live()?.display.publication.publicationId).toBe('publication-1');
        expect(h.fixture.acknowledgments).toHaveLength(1);
        // Capture is at commit, after these edits made while assets were preparing.
        h.live()!.draft.words = '  새 결과 준비 중에도 쓴 원문\n';
        ready.resolve();
        await publishing;
        expect(h.window.state().retainedDrafts).toEqual([{
                publicationId: 'publication-1', sourceHash: fixturePublication(1).publication.source.sourceHash,
                source: fixturePublication(1).publication.source,
                label: 'Rig 1', value: { words: '  새 결과 준비 중에도 쓴 원문\n' },
            }]);
    });
    test('a preparation failure keeps the old form, source and nonce', async () => {
        const h = harness();
        await h.publish(1);
        h.live()!.draft.words = 'original';
        const before = h.live();
        const receipt = h.window.state().receipt;
        h.prepareWith(async () => { throw new Error('ASSET_LOAD_FAILED'); });
        await h.publish(2);
        expect(h.live()).toBe(before);
        expect(h.window.state().receipt).toBe(receipt);
        expect(h.window.state().error).toBe('ASSET_LOAD_FAILED');
        expect(h.fixture.acknowledgments).toHaveLength(1);
        expect(h.window.state().retainedDrafts).toHaveLength(0);
    });
    test('a failed display acknowledgment rolls back atomically', async () => {
        const h = harness();
        await h.publish(1);
        const old = h.live();
        h.fixture.failAcknowledgment({ ok: false, error: { code: 'JOB_DISPLAY_MISMATCH', message: 'refused' } });
        await h.publish(2);
        expect(h.live()).toBe(old);
        expect(h.window.state().displayed?.publication.publicationId).toBe('publication-1');
        expect(h.window.state().receipt?.publicationId).toBe('publication-1');
        expect(h.rollbacks).toEqual(['publication-2']);
        expect(h.disposed).toEqual(['publication-2']);
    });
    test('a foreign page receipt cannot acknowledge the displayed source', async () => {
        const h = harness();
        h.acknowledgeWith(async () => ({ ok: true, value: {
                publicationId: 'publication-1', pageId: 'another-page', displayedNonce: 'foreign',
            } }));
        await h.publish(1);
        expect(h.live()).toBe(null);
        expect(h.window.state().receipt).toBe(null);
        expect(h.window.state().error).toBe('JOB_DISPLAY_MISMATCH');
    });
    test('an unavailable visual stops before preparing or acknowledging it', async () => {
        const h = harness();
        await h.publish(1);
        const candidate = fixturePublication(2);
        h.fixture.publish({ ...candidate, publication: { ...candidate.publication, visual: {
                    status: 'unavailable', code: 'REQUIRED_VISUAL_UNAVAILABLE',
                } } });
        h.window.event(h.fixture.events.at(-1)!);
        await h.window.settled();
        expect(h.live()?.display.publication.publicationId).toBe('publication-1');
        expect(h.window.state().error).toBe('REQUIRED_VISUAL_UNAVAILABLE');
        expect(h.fixture.acknowledgments).toHaveLength(1);
    });
    test('superseding a candidate during prepare discards it without acknowledgment', async () => {
        const h = harness();
        await h.publish(1);
        const entered = deferred<void>();
        h.prepareWith(async (display, signal) => {
            if (display.publication.publicationId !== 'publication-2')
                return;
            entered.resolve();
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        });
        const second = h.publish(2);
        await entered.promise;
        const third = h.publish(3);
        await Promise.all([second, third]);
        expect(h.fixture.acknowledgments.map(row => (row.body as {
            publicationId: string;
        }).publicationId)).toEqual(['publication-1', 'publication-3']);
        expect(h.live()?.display.publication.publicationId).toBe('publication-3');
        expect(h.disposed).toContain('publication-2');
    });
    test('pending questions arrive without replacing the document or current forms', async () => {
        const h = harness();
        const display = await h.publish(1);
        const live = h.live();
        h.fixture.pending({ askId: 'checkpoint-ask', publicationId: display.publication.publicationId,
            subject: { kind: 'checkpoint', checkpointId: 'silhouette' }, source: display.publication.source,
            status: 'pending' }, 2);
        h.window.event(h.fixture.events.at(-1)!);
        expect(h.live()).toBe(live);
        expect(h.window.state().generation).toBe(2);
        expect(h.window.state().pending[0]?.askId).toBe('checkpoint-ask');
        expect(h.fixture.acknowledgments).toHaveLength(1);
    });
    test('an old captured submission is refused before transport after a swap', async () => {
        const h = harness();
        await h.publish(1);
        const old = h.window.state().receipt!;
        await h.publish(2);
        const result = await h.window.submit({
            kind: 'checkpoint', publicationId: old.publicationId, pageId: old.pageId,
            displayedNonce: old.displayedNonce, expectedGeneration: 1, askId: 'old-ask',
            submissionId: 'one', value: { checkpointId: 'silhouette', outcome: 'pass', words: 'exact' },
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.error.code).toBe('JOB_ACT_SOURCE_STALE');
        expect(h.fixture.submissions).toHaveLength(0);
    });
});
import { createJobFront } from '../src/job-front.ts';
function frontHarness() {
    const fixture = createJobWindowFixture();
    const front = createJobFront({ origin: 'http://127.0.0.1:4318',
        ports: fixture.ports, resource: async (name) => name });
    const request = (path: string, init?: RequestInit) => new Request('http://127.0.0.1:4318/jobs/window-fixture/' + path, init);
    return { fixture, front, request };
}
describe('disjoint job front', () => {
    test('owner HTML permits only the default or one exact English/Korean language query', async () => {
        const h = frontHarness();
        for (const method of ['GET', 'HEAD']) {
            for (const query of ['', '?lang=en', '?lang=ko']) {
                const response = await h.front.fetch(h.request(query, {method}));
                expect(response?.status).toBe(200);
                expect(response?.headers.get('content-type')).toBe('text/html; charset=utf-8');
                expect(await response?.text()).toBe(method === 'HEAD' ? '' : 'index.html');
            }
            for (const query of ['?lang=', '?lang=ja', '?lang=EN', '?unknown=en', '?en',
                '?lang=en&lang=en', '?lang=en&lang=ko', '?lang=en&unknown=1',
                '?unknown=1&lang=ko', '?lang=%65n', '?%6cang=en', '?lang=en&']) {
                const response = await h.front.fetch(h.request(query, {method}));
                expect(response?.status).toBe(400);
            }
        }
    });
    test('language queries are rejected on resource, publication, event and mutation routes', async () => {
        const h = frontHarness();
        for (const route of ['job.js', 'styles.css', 'publications/publication-1',
            'publications/publication-1/instances/' + 'a'.repeat(64) + '/api/review', 'events', 'unknown']) {
            for (const query of ['?lang=en', '?lang=ko', '?unknown=1']) {
                expect((await h.front.fetch(h.request(route + query)))?.status).toBe(400);
            }
        }
        for (const route of ['api', 'ui/displayed', 'ui/acts']) {
            expect((await h.front.fetch(h.request(route + '?lang=en', {method: 'POST', body: '{}',
                headers: {Origin: 'http://127.0.0.1:4318', 'Content-Type': 'application/json'}})))?.status).toBe(405);
        }
        expect(h.fixture.apiRequests).toHaveLength(0);
        expect(h.fixture.acknowledgments).toHaveLength(0);
        expect(h.fixture.submissions).toHaveLength(0);
    });
    test('legacy paths fall through and job resources use a closed name set', async () => {
        const h = frontHarness();
        expect(await h.front.fetch(new Request('http://127.0.0.1:4318/instances/legacy/'))).toBe(null);
        expect(await (await h.front.fetch(h.request('')))?.text()).toBe('index.html');
        expect((await h.front.fetch(h.request('job.js')))?.status).toBe(200);
        expect((await h.front.fetch(h.request('unknown')))?.status).toBe(404);
        expect((await h.front.fetch(h.request('publications/%2f')))?.status).toBe(404);
    });
    test('UI mutations require the exact Origin and preserve the raw Request', async () => {
        const h = frontHarness();
        const body = JSON.stringify({ publicationId: 'publication-1', pageId: 'page' });
        const wrong = await h.front.fetch(h.request('ui/displayed', { method: 'POST', body,
            headers: { origin: 'http://attacker.example', 'content-type': 'application/json' } }));
        expect(wrong?.status).toBe(403);
        expect(h.fixture.acknowledgments).toHaveLength(0);
        const request = h.request('ui/displayed', { method: 'POST', body,
            headers: { origin: 'http://127.0.0.1:4318', 'content-type': 'application/json', 'X-Review-Capability': 'ui-only' } });
        const response = await h.front.fetch(request);
        expect(response?.status).toBe(200);
        expect(h.fixture.acknowledgments[0]?.request).toBe(request);
        expect(h.fixture.acknowledgments[0]?.request.headers.get('X-Review-Capability')).toBe('ui-only');
    });
    test('agent verbs stay on their own raw-request port', async () => {
        const h = frontHarness();
        const request = h.request('api', { method: 'POST', headers: { authorization: 'Bearer agent-fixture' }, body: '{}' });
        expect((await h.front.fetch(request))?.status).toBe(501);
        expect(h.fixture.apiRequests[0]).toBe(request);
        expect(h.fixture.acknowledgments).toHaveLength(0);
        expect(h.fixture.submissions).toHaveLength(0);
    });
    test('publication reads and event replay use the frozen ports', async () => {
        const h = frontHarness();
        const display = fixturePublication(1);
        h.fixture.publish(display);
        const publication = await h.front.fetch(h.request('publications/publication-1'));
        expect(await publication?.json()).toEqual({ ok: true, value: display });
        h.fixture.close(2);
        const response = await h.front.fetch(h.request('events'));
        const lines = (await response!.text()).trim().split('\n').map(line => JSON.parse(line));
        expect(lines.map(line => line.type)).toEqual(['published', 'closed']);
        expect((await h.front.fetch(h.request('events?after=1&after=2')))?.status).toBe(400);
        h.front.stop();
    });
});
describe('job browser transport boundaries', () => {
    test('a stable owner link consumes its capability once and scopes it by job', () => {
        const values = new Map<string, string>();
        const storage = { getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); } };
        let replaced = '';
        const capability = 'b'.repeat(64);
        const access = jobWindowAccess('http://127.0.0.1:4318/jobs/job-one/#cap=' + capability, storage, href => { replaced = href; });
        expect(replaced).toBe('http://127.0.0.1:4318/jobs/job-one/');
        expect(access.headers().get('X-Review-Capability')).toBe(capability);
        expect(access.route('ui/displayed')).toBe('/jobs/job-one/ui/displayed');
        expect(jobWindowAccess(replaced, storage, () => { }).capability).toBe(capability);
        expect(jobWindowAccess('http://127.0.0.1:4318/jobs/job-two/', storage, () => { }).capability).toBe(null);
        expect(() => access.route('../api')).toThrow('JOB_REQUEST_INVALID');
    });
    test('publication assets, forms and metadata resolve under the exact instance', () => {
        const display = fixturePublication(1);
        const routes = jobPublicationRoutes(display, 'http://127.0.0.1:4318');
        expect(routes.api('review')).toBe('http://127.0.0.1:4318' + display.routes.apiBase + 'review');
        expect(routes.asset('images/그림.png')).toContain('/images/%EA%B7%B8%EB%A6%BC.png');
        expect(() => routes.asset('../model.json')).toThrow('JOB_DISPLAY_MISMATCH');
        expect(() => routes.assertAsset('http://attacker.example' + display.routes.assetsBase + 'image.png')).toThrow('JOB_DISPLAY_MISMATCH');
        expect(() => jobPublicationRoutes({ ...display, routes: { ...display.routes, assetsBase: '/current/assets/' } }, 'http://127.0.0.1:4318')).toThrow('JOB_DISPLAY_MISMATCH');
        expect(() => jobPublicationRoutes({ ...display, routes: { ...display.routes, apiBase: display.routes.entry + '%2e%2e/api/' } }, 'http://127.0.0.1:4318')).toThrow('JOB_DISPLAY_MISMATCH');
    });
    test('the browser event reader preserves Unicode and only yields complete events', async () => {
        const h = frontHarness();
        const original = fixturePublication(1);
        h.fixture.publish({ ...original, publication: { ...original.publication, label: '부품 · 원문 😀' } });
        h.fixture.close(2);
        const access = jobWindowAccess('http://127.0.0.1:4318/jobs/window-fixture/', null, () => { });
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => (await h.front.fetch(new Request(new URL(String(input), 'http://127.0.0.1:4318'), init)))!) as typeof fetch;
        const events = [];
        for await (const event of jobWindowEvents(access, null, new AbortController().signal, fetcher))
            events.push(event);
        expect(events.map(event => event.type)).toEqual(['published', 'closed']);
        expect(events[0]).toMatchObject({ publication: { label: '부품 · 원문 😀' } });
        h.front.stop();
    });
});
test('superseding while an acknowledgment is in flight rolls back before the next commit', async () => {
    const h = harness();
    await h.publish(1);
    h.live()!.draft.words = 'old draft';
    const acknowledged = deferred<JobResult<JobDisplayReceipt>>();
    const entered = deferred<void>();
    h.acknowledgeWith(() => { entered.resolve(); return acknowledged.promise; });
    const second = h.publish(2);
    await entered.promise;
    expect(h.live()?.display.publication.publicationId).toBe('publication-2');
    expect(h.window.state().receipt?.publicationId).toBe('publication-1');
    const third = h.publish(3);
    h.acknowledgeWith(null);
    acknowledged.resolve({ ok: true, value: { publicationId: 'publication-2', pageId: 'page-one', displayedNonce: 'obsolete' } });
    await Promise.all([second, third]);
    expect(h.rollbacks).toEqual(['publication-2']);
    expect(h.window.state().displayed?.publication.publicationId).toBe('publication-3');
    expect(h.window.state().receipt?.publicationId).toBe('publication-3');
    expect(h.window.state().retainedDrafts[0]?.value).toEqual({ words: 'old draft' });
});
describe('C2 semantic fixture coverage', () => {
    for (const kind of ['interview-picks', 'checkpoint', 'parts-verdict', 'review-verdict', 'signoff'] as const) {
        test(kind + ' keeps the displayed plan/parts binding and accepts empty words', async () => {
            const h = harness();
            const act = fixtureAct(kind, '');
            await h.publish(1, act.source);
            h.fixture.returnAct(act);
            const receipt = h.window.state().receipt!;
            // The host resolves checkpoint planStepId from its validated ask, never from browser data.
            const value = act.kind === 'checkpoint' ? {
                checkpointId: act.value.checkpointId, outcome: act.value.outcome, words: act.value.words,
            } : act.value;
            const submission = {
                publicationId: receipt.publicationId, pageId: receipt.pageId, displayedNonce: receipt.displayedNonce,
                askId: act.askId, expectedGeneration: h.window.state().generation, submissionId: 'submission-' + kind,
                kind, value,
            } as import('../src/job-contract.ts').JobUISubmission;
            const result = await h.window.submit(submission);
            expect(result).toEqual({ ok: true, value: act });
            const sent = h.fixture.submissions[0]!.body as Record<string, unknown>;
            expect(sent).not.toHaveProperty('source');
            expect(sent).not.toHaveProperty('authority');
            expect(sent).not.toHaveProperty('reviewer');
            if (act.kind === 'checkpoint') {
                expect(sent.value).not.toHaveProperty('planStepId');
                expect(sent.value).not.toHaveProperty('stage');
                expect(act.value.words).toBe('');
            }
            else if (act.kind === 'interview-picks')
                expect(act.value.note).toBe('');
            else
                expect(act.value.words).toBe('');
            expect(act.authority.reviewer).toEqual({ id: 'fixture-owner', role: 'owner' });
            expect(act.source.plan).toEqual({ steps: [{ id: 'inspect-body', hash: 'b'.repeat(64) }] });
            expect(act.source.plan).not.toHaveProperty('revision');
            expect(act.source.parts!.images.map(image => image.path)).toEqual([
                'parts/alternate.png', 'parts/attachment.png', 'parts/base.png', 'parts/depth.png',
            ]);
        });
    }
    test('whitespace-only words and Other text remain byte-for-byte human text', () => {
        const words = '  \n\t ';
        const act = fixtureAct('interview-picks', words);
        if (act.kind !== 'interview-picks')
            throw new Error('fixture kind');
        expect(act.value.note).toBe(words);
        expect(act.value.selections[0]?.otherText).toBe('  원래 표현\n');
        const signoff = fixtureAct('signoff', words);
        if (signoff.kind !== 'signoff')
            throw new Error('fixture kind');
        expect(signoff.value.decision).toBe('approved');
        expect(signoff.value.words).toBe(words);
    });
});
test('a route descriptor with changed plan or referenced parts refuses despite equal model bytes', async () => {
    for (const component of ['plan', 'parts'] as const) {
        const h = harness();
        await h.publish(1);
        const display = fixturePublication(2);
        const source = fixtureAct('signoff').source;
        const published = { ...display, publication: { ...display.publication, source } };
        h.fixture.publish(published);
        const moved = structuredClone(published);
        if (component === 'plan') {
            Object.assign(moved.publication.source, { plan: { steps: [{ id: 'another-step', hash: '7'.repeat(64) }] } });
        }
        else {
            Object.assign(moved.publication.source, { parts: { ...source.parts!, images: source.parts!.images.slice(1) } });
        }
        h.fixture.publications.set(display.publication.publicationId, moved);
        h.window.event(h.fixture.events.at(-1)!);
        await h.window.settled();
        expect(h.window.state().error).toBe('JOB_DISPLAY_MISMATCH');
        expect(h.window.state().displayed?.publication.publicationId).toBe('publication-1');
        expect(h.fixture.acknowledgments).toHaveLength(1);
    }
});
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {syntheticCheckpointEvidence} from './job-checkpoint-evidence-browser.ts';
import {createSyntheticPlanRecordWorkspace} from './helpers/job-record-fixture.ts';
import { checkWebHardcodedStrings } from '../web/i18n.ts';
test('the new job web module passes the existing i18n scanner without exemptions', async () => {
    const content = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
    const result = checkWebHardcodedStrings([{ path: 'web/job-session.ts', content }], { exemptions: [] });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
});
test('a cleanup failure after acknowledgment cannot roll the screen back under the new nonce', async () => {
    const h = harness();
    await h.publish(1);
    h.failCleanup();
    await h.publish(2);
    expect(h.live()?.display.publication.publicationId).toBe('publication-2');
    expect(h.window.state().displayed?.publication.publicationId).toBe('publication-2');
    expect(h.window.state().receipt?.publicationId).toBe('publication-2');
    expect(h.window.state().error).toBe('JOB_WINDOW_CLEANUP_FAILED');
    expect(h.rollbacks).toEqual([]);
});
test('the new displayed source accepts a new verdict while the old draft keeps its full binding', async () => {
    const h = harness();
    const fixtureSource = fixtureAct('review-verdict').source;
    if (fixtureSource.subject === 'image-set') throw new Error('Expected model fixture source');
    const first: JobModelSourceBinding = fixtureSource;
    await h.publish(1, first);
    h.live()!.draft.words = '  original words\n';
    const second = { ...first, sourceHash: '6'.repeat(64), package: { ...first.package, revision: '2' },
        selector: { kind: 'rig' as const, version: 2 }, plan: { steps: [{ id: 'inspect-rebuild', hash: '5'.repeat(64) }] } };
    await h.publish(2, second);
    const old = h.window.state().retainedDrafts[0]!;
    expect(old.publicationId).toBe('publication-1');
    expect(old.sourceHash).toBe(first.sourceHash);
    expect(old.source).toEqual(first);
    expect(old.value).toEqual({ words: '  original words\n' });
    const act = { ...fixtureAct('review-verdict'), publicationId: 'publication-2', source: second } as import('../src/job-contract.ts').JobAct;
    h.fixture.returnAct(act);
    const receipt = h.window.state().receipt!;
    const result = await h.window.submit({ kind: 'review-verdict', publicationId: receipt.publicationId,
        pageId: receipt.pageId, displayedNonce: receipt.displayedNonce,
        expectedGeneration: h.window.state().generation, submissionId: 'new-verdict', askId: act.askId,
        value: { stage: 'rig-review', verdict: 'approved', words: '' } });
    expect(result).toEqual({ ok: true, value: act });
    expect(h.fixture.submissions[0]!.body).toMatchObject({ publicationId: 'publication-2', displayedNonce: receipt.displayedNonce });
    expect(h.window.state().retainedDrafts[0]).toEqual(old);
});

test('event decoding retains a multibyte character split across network chunks', async () => {
    const fixture = createJobWindowFixture();
    const display = fixturePublication(1);
    fixture.publish({ ...display, publication: { ...display.publication, label: '한😀' } });
    const bytes = new TextEncoder().encode(JSON.stringify(fixture.events[0]) + '\n');
    const split = bytes.indexOf(0xed) + 1;
    expect(split).toBeGreaterThan(0);
    const access = jobWindowAccess('http://127.0.0.1:4318/jobs/window-fixture/', null, () => {});
    const fetcher = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
        },
    }))) as unknown as typeof fetch;
    const received = [];
    for await (const event of jobWindowEvents(access, null, new AbortController().signal, fetcher)) received.push(event);
    expect(received[0]).toMatchObject({ publication: { label: '한😀' } });
});

describe('required forms before the visible commit', () => {
    test('a missing required form dependency preserves the old screen, nonce and editable draft', async () => {
        const h = harness();
        await h.publish(1);
        h.live()!.draft.words = '  original draft\n';
        const oldScreen = h.live();
        const oldReceipt = h.window.state().receipt;
        const source = fixtureAct('checkpoint').source;
        const ask: import('../src/job-contract.ts').JobPendingAsk = {
            askId: 'new-checkpoint', publicationId: 'publication-2', source, status: 'pending',
            subject: {kind: 'checkpoint', checkpointId: 'inspect-body'},
        };
        h.prepareWith(async display => {
            prepareJobForms(display, [ask], () => {
                throw new Error('JOB_VISUAL_UNAVAILABLE');
            });
        });
        await h.publish(2, source);
        expect(h.window.state().error).toBe('JOB_VISUAL_UNAVAILABLE');
        expect(h.live()).toBe(oldScreen);
        expect(h.live()!.draft.words).toBe('  original draft\n');
        expect(h.window.state().receipt).toBe(oldReceipt);
        expect(h.fixture.acknowledgments).toHaveLength(1);
        expect(h.window.state().retainedDrafts).toEqual([]);
        expect(h.rollbacks).toEqual([]);
    });

    test('the preflight validates every required pending form and the exact source binding', () => {
        const display = fixturePublication(1);
        const source = fixtureAct('checkpoint').source;
        const candidate = {...display, publication: {...display.publication, source}};
        const ask: import('../src/job-contract.ts').JobPendingAsk = {
            askId: 'checkpoint', publicationId: candidate.publication.publicationId,
            source, status: 'pending', subject: {kind: 'checkpoint', checkpointId: 'inspect-body'},
        };
        const calls: string[] = [];
        const prepared = prepareJobForms(candidate, [ask, {...ask, askId: 'answered', status: 'answered'}], item => {
            calls.push(item.askId);
            return jobCheckpointContext(item, []);
        });
        expect(calls).toEqual(['checkpoint']);
        expect(prepared.get('checkpoint')?.step.id).toBe('inspect-body');
        expect(() => prepareJobForms(candidate, [{...ask, source: {...source, plan: null}}], () => null))
            .toThrow('JOB_ACT_SOURCE_STALE');
    });
});

describe('C2 plan-bound checkpoint presentation', () => {
    const source = fixtureAct('checkpoint').source;
    const ask: import('../src/job-contract.ts').JobPendingAsk = {
        askId: 'checkpoint', publicationId: 'publication-1', source, status: 'pending',
        subject: {kind: 'checkpoint', checkpointId: 'inspect-body'},
    };

    test('a published plan step works without a legacy manifest checkpoint', () => {
        const context = jobCheckpointContext(ask, []);
        expect(context).toEqual({step: {id: 'inspect-body', hash: 'b'.repeat(64)}, title: 'inspect-body', note: ''});
        expect(context).not.toHaveProperty('stage');
    });

    test('an explicit published mapping can add optional legacy guidance', () => {
        const mapped = {...ask, subject: {kind: 'checkpoint' as const, checkpointId: 'silhouette', planStepId: 'inspect-body'}};
        const context = jobCheckpointContext(mapped, [{id: 'silhouette', title: 'Body outline', note: '  original guidance\n'}]);
        expect(context.step).toEqual({id: 'inspect-body', hash: 'b'.repeat(64)});
        expect(context.title).toBe('Body outline');
        expect(context.note).toBe('  original guidance\n');
        expect(context).not.toHaveProperty('stage');
    });

    test('legacy metadata cannot invent a missing plan mapping or missing plan source', () => {
        const unmapped = {...ask, subject: {kind: 'checkpoint' as const, checkpointId: 'silhouette'}};
        expect(() => jobCheckpointContext(unmapped, [{id: 'silhouette', title: 'Body outline'}])).toThrow('JOB_ASK_INVALID');
        expect(() => jobCheckpointContext({...ask, source: {...source, plan: null}}, [])).toThrow('JOB_ASK_INVALID');
        expect(() => jobCheckpointContext({...ask, subject: {kind: 'checkpoint', checkpointId: 'silhouette', planStepId: 'unknown'}}, []))
            .toThrow('JOB_ASK_INVALID');
    });
});

import {afterEach} from 'bun:test';
import {realJobWindowFixture} from './helpers/job-window-fixture.ts';
import {startJobHost, type JobHostOptions} from '../src/job-front.ts';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
const realWindows: Awaited<ReturnType<typeof realJobWindowFixture>>[] = [];
afterEach(async () => {for (const fixture of realWindows.splice(0)) await fixture.close();});
async function realWindow(options?: Parameters<typeof realJobWindowFixture>[0]) {
    const fixture = await realJobWindowFixture(options);
    realWindows.push(fixture);
    return fixture;
}

describe('the real standing owner host', () => {
    test('the actual owner document serves default, English and Korean links before app boot', async () => {
        const f = await realWindow();
        const owner = new URL(f.host.ownerUrl);
        for (const language of ['', 'en', 'ko']) {
            owner.search = language ? '?lang=' + language : '';
            const response = await fetch(owner);
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
            expect(await response.text()).toContain('<body data-job-window>');
        }
    });
    test('serves pinned retained metadata/assets at the actual origin and keeps the old publication readable', async () => {
        const f = await realWindow();
        const first = await f.publish();
        const descriptor = await (await fetch(f.locator + '/publications/' + first.publicationId)).json();
        expect(descriptor.ok).toBe(true);
        const paths = jobPublicationRoutes(descriptor.value, f.host.origin);
        const before = await jobInputHashes(f.input.root);
        const metadata = await (await fetch(paths.api('review'))).json();
        expect(metadata.sourceHash).toBe(first.source.sourceHash);
        expect(metadata.manifest.revision).toBe('1');
        const modelResponse = await fetch(paths.asset(metadata.manifest.model));
        expect(modelResponse.status).toBe(200);
        const bytes = await modelResponse.arrayBuffer();
        const expected = await readFile(join(f.input.root, 'out', metadata.manifest.model));
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(expected));
        expect(await jobInputHashes(f.input.root)).toEqual(before);
        const manifestPath = join(f.input.root, 'out/review.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        await writeFile(manifestPath, JSON.stringify({...manifest, revision: '2'}));
        const second = await f.publish();
        expect(second.source.sourceHash).not.toBe(first.source.sourceHash);
        expect((await (await fetch(paths.api('review'))).json()).manifest.revision).toBe('1');
        expect(await (await fetch(paths.asset(metadata.manifest.model))).arrayBuffer()).toEqual(bytes);
    });

    test('authenticates the unmodified UI Request on the real UI paths and commits a plan checkpoint', async () => {
        const f = await realWindow();
        const publication = await f.publish();
        const asked = await (await f.call({...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
            idempotencyKey: 'real-checkpoint', publicationId: publication.publicationId,
            subject: {kind: 'checkpoint', checkpointId: 'step-one'}})).json();
        expect(asked.ok).toBe(true);
        const body = {publicationId: publication.publicationId, pageId: 'real-page', sourceHash: publication.source.sourceHash};
        expect((await f.ui('displayed', body, 'http://127.0.0.1:1')).status).toBe(403);
        expect((await f.ui('displayed', body, f.host.origin, f.credentials.agent)).status).toBe(403);
        const ack = await (await f.ui('displayed', body)).json();
        expect(ack.ok).toBe(true);
        const original = await jobInputHashes(f.input.root);
        const saved = await (await f.ui('acts', {...ack.value, askId: asked.value.askId,
            expectedGeneration: f.host.session.status().generation, submissionId: 'real-save', kind: 'checkpoint',
            value: {checkpointId: 'step-one', outcome: 'pass', words: ''}})).json();
        expect(saved.ok).toBe(true);
        expect(saved.value.value).toEqual({checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass', words: ''});
        expect(saved.value.authority.reviewer).toEqual({id: 'declared-owner', role: 'owner'});
        expect(saved.value.source).toEqual(publication.source);
        expect(await jobInputHashes(f.input.root)).toEqual(original);
    });

    test('a producer record movement refuses publication and keeps the old retained view live', async () => {
        const f = await realWindow();
        const publication = await f.publish();
        const pending = await f.input.publishRequest();
        await writeFile(join(f.input.root, 'record.json'), '{"syntheticPublication":2}\n');
        const refused = await (await f.call(pending)).json();
        expect(refused.error.code).toBe('JOB_RECORD_MOVED');
        const next = await (await f.call({...f.input.base(), verb: 'next', after: null, waitMs: 0})).json();
        const published = next.value.events.filter((event: {type: string}) => event.type === 'published');
        expect(published).toHaveLength(1);
        expect(published[0].publication.publicationId).toBe(publication.publicationId);
        const descriptor = await (await fetch(f.locator + '/publications/' + publication.publicationId)).json();
        const metadata = await (await fetch(f.host.origin + descriptor.value.routes.apiBase + 'review')).json();
        expect(metadata.sourceHash).toBe(publication.source.sourceHash);
        expect((await fetch(f.host.ownerUrl)).status).toBe(200);
    });

    test('reopening the same active root returns the same standing owner link', async () => {
        const f = await realWindow();
        const reopened = await startJobHost(f.hostOptions);
        try {
            expect(reopened.reused).toBe(true);
            expect(reopened.ownerUrl).toBe(f.host.ownerUrl);
            expect(reopened.session.jobId).toBe(f.host.session.jobId);
            expect((await fetch(f.host.ownerUrl)).status).toBe(200);
        } finally {reopened.stop();}
        expect((await fetch(f.host.ownerUrl)).status).toBe(200);
    });

    test('managed startup installs the private writer binding at the owner origin on start and reuse', async () => {
        const bindings: {jobId: string; origin: string; fetchCapability: string}[] = [];
        const f = await realWindow({installWriterBinding: binding => {bindings.push(binding);}});
        expect(bindings).toHaveLength(1);
        expect(bindings[0].jobId).toBe(f.host.session.jobId);
        expect(bindings[0].origin).toBe(new URL(f.host.ownerUrl).origin);
        expect(bindings[0].fetchCapability).toMatch(/^[a-f0-9]{64}$/);
        expect(bindings[0].fetchCapability).not.toBe(f.credentials.agent);
        expect(bindings[0].fetchCapability).not.toBe(f.credentials.ui);
        const reopened = await startJobHost(f.hostOptions);
        try {
            expect(reopened.ownerUrl).toBe(f.host.ownerUrl);
            expect(bindings).toHaveLength(2);
            expect(bindings[1]).toEqual(bindings[0]);
            const response = await fetch(bindings[0].origin + '/jobs/' + bindings[0].jobId + '/api', {
                method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + bindings[0].fetchCapability},
                body: JSON.stringify({...f.input.base(), verb: 'fetch-act', actId: 'unknown-act'}),
            });
            expect((await response.json()).error.code).toBe('JOB_ACT_UNKNOWN');
        } finally {reopened.stop();}
    });

    test('a refused writer installation is named and a refused reuse preserves the running owner host', async () => {
        const rejected = () => {throw new Error('private writer callback detail');};
        await expect(realJobWindowFixture({installWriterBinding: rejected})).rejects.toMatchObject({code: 'JOB_AUTHORITY_REFUSED'});
        const f = await realWindow({installWriterBinding: () => {}});
        await expect(startJobHost({...f.hostOptions, installWriterBinding: rejected})).rejects.toMatchObject({code: 'JOB_AUTHORITY_REFUSED'});
        expect((await fetch(f.host.ownerUrl)).status).toBe(200);
    });

    test('a Create project without the producer reader keeps the named refusal at the real entry', async () => {
        const f = await realWindow({reader: false});
        await writeFile(join(f.input.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{}}\n');
        f.input.setRecordPath('project.json');
        const response = await (await f.call(await f.input.publishRequest())).json();
        expect(response.ok).toBe(false);
        expect(response.error.code).toBe('JOB_SOURCE_UNRETAINABLE');
        expect(response.error.message).toContain('CREATE_PUBLICATION_CONTRACT_UNAVAILABLE');
        expect(f.host.session.status().publication).toBe(null);
    });
});

describe('declared managed host hook identities', () => {
    async function startDeclared() {
        const input = await jobFixture();
        const options: JobHostOptions = {root: input.root, stateDir: input.state,
            fingerprint: 'f'.repeat(64), reviewer: {id: 'declared-owner', role: 'owner'},
            readPublished: async () => input.getContext(), readerId: 'window-reader/1',
            installWriterBinding: () => {}, bindingId: 'window-binding/1'};
        try {
            const host = await startJobHost(options);
            return {input, options, host, async close() {host.stop(); await input.close();}};
        } catch (error) {await input.close(); throw error;}
    }

    test('equal declared IDs reuse even when both function objects differ', async () => {
        const f = await startDeclared();
        let installed = false;
        try {
            const reused = await startJobHost({...f.options,
                readPublished: async () => f.input.getContext(),
                installWriterBinding: () => {installed = true;}});
            try {
                expect(reused.reused).toBe(true);
                expect(reused.ownerUrl).toBe(f.host.ownerUrl);
                expect(installed).toBe(true);
            } finally {reused.stop();}
        } finally {await f.close();}
    });

    test('different IDs and omitted hook pairs refuse by option and both IDs', async () => {
        const f = await startDeclared();
        let installed = false;
        try {
            for (const change of [
                {options: {readerId: 'window-reader/2'}, option: 'readPublished', listenerId: 'window-reader/1', requestedId: 'window-reader/2'},
                {options: {bindingId: 'window-binding/2'}, option: 'installWriterBinding', listenerId: 'window-binding/1', requestedId: 'window-binding/2'},
                {options: {readPublished: undefined, readerId: undefined}, option: 'readPublished', listenerId: 'window-reader/1', requestedId: null},
                {options: {installWriterBinding: undefined, bindingId: undefined}, option: 'installWriterBinding', listenerId: 'window-binding/1', requestedId: null},
            ]) {
                await expect(startJobHost({...f.options, installWriterBinding: () => {installed = true;}, ...change.options}))
                    .rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH', option: change.option,
                        listenerId: change.listenerId, requestedId: change.requestedId});
                expect(installed).toBe(false);
            }
            expect((await fetch(f.host.ownerUrl)).status).toBe(200);
        } finally {await f.close();}
    });

    test('a hook requires its own nonempty declared ID and an ID requires its hook', async () => {
        const input = await jobFixture();
        const base = {root: input.root, stateDir: input.state, fingerprint: 'f'.repeat(64),
            reviewer: {id: 'declared-owner', role: 'owner' as const}};
        try {
            for (const change of [
                {options: {readPublished: async () => input.getContext()}, option: 'readPublished'},
                {options: {installWriterBinding: () => {}}, option: 'installWriterBinding'},
                {options: {readPublished: async () => input.getContext(), readerId: ''}, option: 'readPublished'},
                {options: {installWriterBinding: () => {}, bindingId: ''}, option: 'installWriterBinding'},
                {options: {readerId: 'orphan-reader'}, option: 'readPublished'},
                {options: {bindingId: 'orphan-binding'}, option: 'installWriterBinding'},
            ]) {
                await expect(startJobHost({...base, ...change.options})).rejects.toMatchObject({
                    code: 'JOB_HOST_OPTION_ID_INVALID', option: change.option,
                });
            }
            const plain = await startJobHost(base);
            try {
                const reused = await startJobHost(base);
                try {expect(reused.ownerUrl).toBe(plain.ownerUrl);}
                finally {reused.stop();}
                await expect(startJobHost({...base, readPublished: async () => input.getContext(), readerId: 'new-reader'}))
                    .rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH', option: 'readPublished', listenerId: null, requestedId: 'new-reader'});
                await expect(startJobHost({...base, installWriterBinding: () => {}, bindingId: 'new-binding'}))
                    .rejects.toMatchObject({code: 'JOB_HOST_REUSE_MISMATCH', option: 'installWriterBinding', listenerId: null, requestedId: 'new-binding'});
            } finally {plain.stop();}
        } finally {await input.close();}
    });

    test('a separate process reuses equal declared IDs and refuses either changed ID', async () => {
        const f = await startDeclared();
        try {
            const {readPublished, installWriterBinding, ...data} = f.options;
            for (const changed of [{}, {readerId: 'cross-process-reader/2'}, {bindingId: 'cross-process-binding/2'}]) {
                const options = {...data, ...changed};
                const program = `import {startJobHost} from ${JSON.stringify(new URL('../src/job-front.ts', import.meta.url).href)};
                    try {
                        const host = await startJobHost({...${JSON.stringify(options)},
                            readPublished: async () => (${JSON.stringify(f.input.getContext())}), installWriterBinding: () => {}});
                        console.log(JSON.stringify({reused: host.reused, origin: host.origin, jobId: host.session.jobId}));
                        host.stop();
                    } catch (error) {
                        console.log(JSON.stringify({code: error.code, option: error.option,
                            listenerId: error.listenerId, requestedId: error.requestedId, message: error.message}));
                        process.exitCode = 1;
                    }`;
                const child = Bun.spawn([process.execPath, '-e', program], {stdout: 'pipe', stderr: 'pipe'});
                const [stdout, stderr, exit] = await Promise.all([
                    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
                ]);
                const value = JSON.parse(stdout);
                expect(stderr).toBe('');
                if ('readerId' in changed || 'bindingId' in changed) {
                    expect(exit).toBe(1);
                    expect(value.code).toBe('JOB_HOST_REUSE_MISMATCH');
                    expect(value.option).toBe('readerId' in changed ? 'readPublished' : 'installWriterBinding');
                    expect(value.listenerId).toBe('readerId' in changed ? f.options.readerId : f.options.bindingId);
                    expect(value.requestedId).toBe('readerId' in changed ? changed.readerId : changed.bindingId);
                    expect(value.message).toContain(JSON.stringify(value.listenerId));
                    expect(value.message).toContain(JSON.stringify(value.requestedId));
                } else {
                    expect(exit).toBe(0);
                    expect(value).toEqual({reused: true, origin: f.host.origin, jobId: f.host.session.jobId});
                }
            }
            expect((await fetch(f.host.ownerUrl)).status).toBe(200);
        } finally {await f.close();}
    });
});

test('an unrelated ask cannot locally stale a captured submission for the same displayed pending ask', async () => {
    const h = harness();
    const act = fixtureAct('checkpoint');
    await h.publish(1, act.source);
    h.fixture.returnAct(act);
    const original = {askId: act.askId, publicationId: act.publicationId, source: act.source,
        subject: {kind: 'checkpoint' as const, checkpointId: 'inspect-body'}, status: 'pending' as const};
    h.fixture.pending(original, 2);
    h.window.event(h.fixture.events.at(-1)!);
    const receipt = h.window.state().receipt!;
    const captured = {...receipt, askId: act.askId, expectedGeneration: 2, submissionId: 'captured-still-current',
        kind: 'checkpoint' as const, value: {checkpointId: 'inspect-body', outcome: 'pass' as const, words: ''}};
    h.fixture.pending({...original, askId: 'unrelated-question'}, 3);
    h.window.event(h.fixture.events.at(-1)!);
    expect(await h.window.submit(captured)).toEqual({ok: true, value: act});
    expect(h.fixture.submissions).toHaveLength(1);
    const future = await h.window.submit({...captured, expectedGeneration: 4, submissionId: 'future'});
    expect(future.ok).toBe(false);
    expect(h.fixture.submissions).toHaveLength(1);
});

describe('thin entry compatibility', () => {
    async function command(file: string, args: string[], extra: Record<string, string> = {}) {
        const child = Bun.spawn([process.execPath, file, ...args], {stdout: 'pipe', stderr: 'pipe',
            env: {...process.env, ...extra}});
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return {stdout, stderr, exit};
    }
    test('legacy argv output and exit behavior are identical through the dispatcher', async () => {
        for (const args of [['--help'], ['--version'], ['--', '--version'], ['check', 'examples/demo/review.json'], ['unknown-entry-input']]) {
            const legacy = await command('src/cli.ts', args);
            const entry = await command('src/entry.ts', args);
            expect(entry).toEqual(legacy);
        }
    });
    test('only the session namespace uses the new semantic command entry', async () => {
        const session = await command('src/entry.ts', ['session', '--help']);
        expect(session.exit).toBe(0);
        expect(session.stdout).toContain('session publish');
        const packageFile = JSON.parse(await readFile('package.json', 'utf8'));
        expect(packageFile.bin['rig-review']).toBe('src/entry.ts');
        expect(packageFile.scripts.review).toBe('bun src/entry.ts');
        const refused = await command('src/entry.ts', ['session', 'fetch-act', 'http://127.0.0.1:4318/jobs/one/']);
        expect(refused.exit).toBe(1);
        expect(refused.stderr).toContain('JOB_REQUEST_INVALID');
    });
});

import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';
import {readProject} from '../src/interview-project.ts';

test('the real host carries a genuine retained pending question and its ask-specific option binding', async () => {
    const f = await realWindow();
    await joinedVerdictFixture(f.input.root, '2-rigging-answers');
    const question = readProject(f.input.root).questions.find(item => item.editable)!;
    f.input.setRecordPath('project.json');
    const publication = await f.publish();
    const descriptor = await (await fetch(f.locator + '/publications/' + publication.publicationId)).json();
    const routes = jobPublicationRoutes(descriptor.value, f.host.origin);
    const metadata = await (await fetch(routes.api('interview'))).json();
    const shown = metadata.questions.find((item: {set: {id: string}}) => item.set.id === question.set.id);
    expect(shown).toBeDefined();
    expect(Object.hasOwn(shown, 'answer')).toBe(false);
    const asked = await (await f.call({...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'actual-interview', publicationId: publication.publicationId,
        subject: {kind: 'interview-picks', questionId: question.set.question, setId: question.set.id}})).json();
    expect(asked.ok).toBe(true);
    expect(prepareJobForms(descriptor.value, [asked.value], ask => ask.askId).size).toBe(1);
    expect(asked.value.source.optionSet).toEqual({id: question.set.id, sha256: question.ref.sha256});
    const ack = await (await f.ui('displayed', {publicationId: publication.publicationId,
        pageId: 'interview-page', sourceHash: publication.source.sourceHash})).json();
    const before = await jobInputHashes(f.input.root);
    const selections = question.set.asks.map(item => ({itemId: item.id,
        optionId: item.options.find(option => option.kind === 'value' && option.recommended)!.id, otherText: null}));
    const saved = await (await f.ui('acts', {...ack.value, askId: asked.value.askId, expectedGeneration: f.host.session.status().generation,
        submissionId: 'actual-interview-save', kind: 'interview-picks', value: {questionId: question.set.question, selections, note: '  원문\n'}})).json();
    expect(saved.ok).toBe(true);
    expect(saved.value.value.note).toBe('  원문\n');
    expect(saved.value.source.optionSet).toEqual(asked.value.source.optionSet);
    expect(await jobInputHashes(f.input.root)).toEqual(before);
});

test('explicit close ends the real job and a later open starts a fresh incarnation', async () => {
    const f = await realWindow();
    await f.publish();
    const closed = await (await f.call({...f.input.base(), verb: 'close', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'explicit-finish', reason: 'finished'})).json();
    expect(closed.ok).toBe(true);
    expect(f.host.session.status().status).toBe('closed');
    const fetchAct = await (await f.call({...f.input.base(), verb: 'fetch-act', actId: 'none'})).json();
    expect(fetchAct.error.code).toBe('JOB_CLOSED');
    const next = await startJobHost(f.hostOptions);
    try {
        expect(next.reused).toBe(false);
        expect(next.session.jobId).not.toBe(f.host.session.jobId);
        expect(next.ownerUrl).not.toBe(f.host.ownerUrl);
    } finally {next.stop();}
});

test('the real UI act stays valid across an unrelated ask while future generations refuse', async () => {
    const f = await realWindow();
    const publication = await f.publish();
    const ask = await (await f.call({...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'original-ask', publicationId: publication.publicationId,
        subject: {kind: 'checkpoint', checkpointId: 'step-one'}})).json();
    const displayed = await (await f.ui('displayed', {publicationId: publication.publicationId,
        pageId: 'generation-page', sourceHash: publication.source.sourceHash})).json();
    const captured = {...displayed.value, askId: ask.value.askId, expectedGeneration: f.host.session.status().generation,
        submissionId: 'generation-save', kind: 'checkpoint', value: {checkpointId: 'step-one', outcome: 'pass', words: ''}};
    const unrelated = await (await f.call({...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'unrelated-ask', publicationId: publication.publicationId,
        subject: {kind: 'signoff', stage: 'plan-approved'}})).json();
    expect(unrelated.ok).toBe(true);
    const saved = await (await f.ui('acts', captured)).json();
    expect(saved.ok).toBe(true);
    expect(saved.value.source).toEqual(publication.source);
    const future = await (await f.ui('acts', {...captured, submissionId: 'future-generation',
        expectedGeneration: f.host.session.status().generation + 1})).json();
    expect(future.error.code).toBe('JOB_GENERATION_STALE');
});

test('two actual owner event streams can cancel while the managed host remains available', async () => {
    const f = await realWindow();
    await f.publish();
    for (let attempt = 0; attempt < 2; attempt++) {
        const abort = new AbortController();
        const response = await fetch(f.locator + '/events', {signal: abort.signal});
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        abort.abort();
        await reader.cancel().catch(() => {});
    }
    await Bun.sleep(25);
    expect((await fetch(f.host.ownerUrl)).status).toBe(200);
    const next = await (await f.call({...f.input.base(), verb: 'next', after: null, waitMs: 0})).json();
    expect(next.ok).toBe(true);
});

test('the declared browser inputs publish parts, rig and direction through the real managed host', async () => {
    const f = await scriptedJobWindowFixture();
    try {
        const parts = await f.publish('parts');
        expect(parts.source.selector?.kind).toBe('draft');
        expect(parts.source.parts?.images).toHaveLength(1);
        const partsAsk = await f.ask(parts, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
        expect(partsAsk.status).toBe('pending');
        const rig = await f.publish('rig');
        expect(rig.source.selector).toEqual({kind: 'rig', version: 2});
        const interview = await f.ask(rig, {kind: 'interview-picks', questionId: f.question.set.question, setId: f.question.set.id});
        expect(interview.source.optionSet?.sha256).toBe(f.question.ref.sha256);
        const direction = await f.publish('direction');
        expect(direction.source.direction?.sha256).toMatch(/^[a-f0-9]{64}$/);
        const descriptor = await (await fetch(f.locator + '/publications/' + direction.publicationId)).json();
        const metadata = await (await fetch(f.host.origin + descriptor.value.routes.apiBase + 'review')).json();
        expect(metadata.direction.camera.space).toBe('rig-world-y-up');
        expect(metadata.capabilities.audio).toBe(false);
        expect(metadata.sourceHash).toBe(direction.source.sourceHash);
    } finally {await f.close();}
});

describe('hub member event subscription lifetime', () => {
    async function settled(predicate: () => boolean) {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (predicate()) return;
            await Bun.sleep(5);
        }
        throw new Error('event lifetime did not settle');
    }
    test('invisible bootstrap acknowledges before suspension, then replays hidden publication and close', async () => {
        const h = harness();
        const front = createJobFront({origin: 'http://127.0.0.1:4318', ports: h.fixture.ports, resource: async name => name});
        const stop = new AbortController();
        const requests: {after: string | null; signal: AbortSignal}[] = [];
        const failures: unknown[] = [];
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(new URL(String(input), 'http://127.0.0.1:4318'), init);
            requests.push({after: new URL(request.url).searchParams.get('after'), signal: request.signal});
            return (await front.fetch(request))!;
        }) as typeof fetch;
        const access = jobWindowAccess('http://127.0.0.1:4318/jobs/window-fixture/', null, () => {});
        const subscription = startJobWindowEvents({access, member: true, signal: stop.signal, fetcher,
            event: event => h.window.event(event), refused: error => failures.push(error)});
        try {
            h.fixture.publish(fixturePublication(1));
            await settled(() => !!h.window.state().receipt);
            expect(requests).toHaveLength(1);
            expect(requests[0]!.signal.aborted).toBe(false);
            h.live()!.draft.words = 'exact unsaved human words';
            subscription.displayed();
            await settled(() => requests[0]!.signal.aborted);
            expect(h.fixture.acknowledgments).toHaveLength(1);
            h.fixture.publish(fixturePublication(2));
            h.fixture.close(3);
            expect(h.window.state().closed).toBe(false);
            subscription.visibility(true);
            await subscription.done;
            await settled(() => h.window.state().displayed?.publication.publicationId === 'publication-2');
            expect(requests.map(value => value.after)).toEqual([null, '1']);
            expect(h.window.state().closed).toBe(true);
            expect(h.window.state().retainedDrafts[0]!.value).toEqual({words: 'exact unsaved human words'});
            expect(h.fixture.acknowledgments).toHaveLength(2);
            expect(failures).toEqual([]);
        } finally {stop.abort(); await subscription.done; h.window.stop(); front.stop();}
    });
    test('rapid hide/show drains the old reader and partial lines never advance the resume cursor', async () => {
        const fixture = createJobWindowFixture();
        fixture.publish(fixturePublication(1)); fixture.publish(fixturePublication(2));
        const act = {...fixtureAct('checkpoint'), publicationId: 'publication-2'};
        fixture.pending({askId: act.askId, publicationId: act.publicationId, source: act.source,
            status: 'pending', subject: {kind: 'checkpoint', checkpointId: 'inspect-body'}}, 3);
        fixture.events.push({jobId: fixture.jobId, generation: 4, cursor: '4', type: 'act', act});
        fixture.close(5);
        const stop = new AbortController(), access = jobWindowAccess('http://127.0.0.1:4318/jobs/window-fixture/', null, () => {});
        const requests: (string | null)[] = [], received: string[] = [], failures: unknown[] = [];
        let active = 0, maximumActive = 0, aborted = 0;
        const encoder = new TextEncoder();
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push(new URL(String(input), 'http://127.0.0.1:4318').searchParams.get('after'));
            active++; maximumActive = Math.max(maximumActive, active);
            const first = requests.length === 1;
            let finished = false;
            const finish = () => {if (!finished) {finished = true; active--;}};
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    if (first) {
                        controller.enqueue(encoder.encode(JSON.stringify(fixture.events[0]) + '\n' + JSON.stringify(fixture.events[1]).slice(0, 20)));
                        init!.signal!.addEventListener('abort', () => {aborted++; controller.error(new DOMException('Aborted', 'AbortError')); finish();}, {once: true});
                    } else {
                        controller.enqueue(encoder.encode(fixture.events.slice(1).map(event => JSON.stringify(event) + '\n').join('')));
                        controller.close(); finish();
                    }
                },
                cancel() {finish();},
            }));
        }) as typeof fetch;
        const subscription = startJobWindowEvents({access, member: true, signal: stop.signal, fetcher,
            event: event => received.push(event.cursor), refused: error => failures.push(error)});
        try {
            await settled(() => received.length === 1);
            subscription.visibility(true); subscription.displayed();
            subscription.visibility(false); subscription.visibility(true);
            await subscription.done;
            expect(requests).toEqual([null, '1']);
            expect(received).toEqual(['1', '2', '3', '4', '5']);
            expect(fixture.events.map(event => event.type)).toEqual(['published', 'published', 'pending', 'act', 'closed']);
            expect(maximumActive).toBe(1); expect(active).toBe(0);
            expect(aborted).toBe(1);
            expect(failures).toEqual([]);
        } finally {stop.abort(); await subscription.done;}
    });
    test('a validated published-null handshake completes bootstrap and hides/resumes before any acknowledgment', async () => {
        const h = frontHarness(), stop = new AbortController();
        const requests: {signal: AbortSignal; after: string | null}[] = [], received: string[] = [], failures: unknown[] = [];
        const origin = 'http://127.0.0.1:4318', owner = {} as Window;
        const binding: JobHubBinding = {incarnation: 'null-publication-incarnation', jobId: h.fixture.jobId,
            publicationId: null, sourceHash: null};
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(new URL(String(input), origin), init);
            requests.push({signal: request.signal, after: new URL(request.url).searchParams.get('after')});
            return (await h.front.fetch(request))!;
        }) as typeof fetch;
        const subscription = startJobWindowEvents({access: jobWindowAccess(origin + '/jobs/window-fixture/', null, () => {}),
            member: true, signal: stop.signal, fetcher, event: event => received.push(event.cursor), refused: error => failures.push(error)});
        const visibility = (visible: boolean, publicationId: string | null = null) => {
            const event = {origin, source: owner, data: {...binding, publicationId, schema: JOB_HUB_VISIBILITY, visible, language: 'en'}};
            if (jobHubMessageMatches(event, origin, owner, binding, 'visibility')) subscription.visibility(visible);
        };
        try {
            await settled(() => requests.length === 1);
            expect(received).toEqual([]); expect(h.fixture.acknowledgments).toHaveLength(0);
            visibility(true);
            visibility(false, 'wrong-publication');
            expect(requests[0]!.signal.aborted).toBe(false);
            visibility(false);
            await settled(() => requests[0]!.signal.aborted);
            h.fixture.publish(fixturePublication(1));
            expect(received).toEqual([]);
            visibility(true);
            await settled(() => received.length === 1);
            expect(requests.map(request => request.after)).toEqual([null, null]);
            expect(received).toEqual(['1']);
            h.fixture.close(2);
            await subscription.done;
            expect(received).toEqual(['1', '2']);
            expect(h.fixture.acknowledgments).toHaveLength(0);
            expect(failures).toEqual([]);
        } finally {stop.abort(); await subscription.done; h.front.stop();}
    });
    test('standalone keeps its persistent stream regardless of member lifecycle calls', async () => {
        const h = frontHarness(), stop = new AbortController();
        const requests: AbortSignal[] = [];
        const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(new URL(String(input), 'http://127.0.0.1:4318'), init);
            requests.push(request.signal); return (await h.front.fetch(request))!;
        }) as typeof fetch;
        const subscription = startJobWindowEvents({access: jobWindowAccess('http://127.0.0.1:4318/jobs/window-fixture/', null, () => {}),
            member: false, signal: stop.signal, fetcher, event: () => {}, refused: error => {throw error;}});
        try {
            await settled(() => requests.length === 1);
            subscription.displayed(); subscription.visibility(false);
            await Bun.sleep(10);
            expect(requests).toHaveLength(1); expect(requests[0]!.aborted).toBe(false);
        } finally {stop.abort(); await subscription.done; h.front.stop();}
        expect(requests[0]!.aborted).toBe(true);
    });
});

import type {RigPlayer} from '@rig-c/play';
import {createViewportController, createViewportState} from '../web/viewport-controller.ts';
import {createRigViewportProvider} from '../web/rig-viewport-provider.ts';
import {mountViewportPair} from '../web/viewport-pair.ts';
import * as i18nModule from '../web/i18n.ts';
import {recordJobRigDraw, freezeJobRigCapture, copyJobRigViewport, jobRigPixelPlacement} from '../web/job-rig-capture.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {JOB_HUB_READY} from '../web/job-hub.ts';
import {advancePlayback} from '../web/playback-clock.ts';
import {parseControlPart, parsePartIdentity, type ControlPart} from '../src/control.ts';
import {parseManifest} from '../src/manifest.ts';
import type {JobPreparedInspection} from '../web/job-session.ts';
import {RigOverlays} from '../web/rig-overlays.ts';
import {labelledControl, createViewControls, bindLayerShortcuts, describeLayerToggles, layerShortcuts} from '../web/view-controls.ts';
import {mountWorkspaceShell} from '../web/workspace-ui.ts';
import {SENTINELS} from '../web/parts-render.ts';
import {JOB_PLAN_TEXT_FIELDS, type JobPlanTextProjection} from '../src/job-contract.ts';

describe('#559 continuous Rig motion transport and mid-play verdict capture', () => {
    class RuntimeDomNode {
        id = '';
        className = '';
        title = '';
        hidden = false;
        disabled = false;
        checked = false;
        required = false;
        value = '';
        type = '';
        name = '';
        min = '';
        step = '';
        clientWidth = 640;
        clientHeight = 480;
        width = 64;
        height = 64;
        dataset: Record<string, string> = {};
        style: Record<string, string> = {};
        children: RuntimeDomNode[] = [];
        parentElement: RuntimeDomNode | null = null;
        canvasOps: string[] = [];
        onchange?: (event?: unknown) => unknown;
        onclick?: (event?: unknown) => unknown;
        oninput?: (event?: unknown) => unknown;
        onsubmit?: (event?: unknown) => unknown;
        private attributes = new Map<string, string>();
        private listeners = new Map<string, Set<(event: any) => void>>();
        private text = '';
        private pixels = new Uint8ClampedArray(64 * 64 * 4);
        readonly classList = {
            add: (...tokens: string[]) => {
                const set = new Set(this.className.split(/\s+/).filter(Boolean));
                for (const token of tokens) set.add(token);
                this.className = [...set].join(' ');
            },
        };
        constructor(readonly tagName: string) {
            this.pixels.fill(120);
        }
        get isConnected(): boolean { return true; }
        get firstElementChild(): RuntimeDomNode | null {
            return this.children.find(child => child.tagName !== '#text') ?? null;
        }
        get textContent(): string {
            return this.text + this.children.map(child => child.textContent).join('');
        }
        set textContent(value: string) {
            this.text = String(value);
            this.children = [];
        }
        append(...nodes: RuntimeDomNode[]) {
            for (const node of nodes) {
                if (node.parentElement) node.remove();
                node.parentElement = this;
                this.children.push(node);
            }
        }
        prepend(...nodes: RuntimeDomNode[]) {
            for (const node of nodes) {
                if (node.parentElement) node.remove();
                node.parentElement = this;
            }
            this.children.unshift(...nodes);
        }
        replaceChildren(...nodes: RuntimeDomNode[]) {
            for (const child of this.children) child.parentElement = null;
            this.children = [];
            this.append(...nodes);
        }
        replaceWith(node: RuntimeDomNode) {
            const parent = this.parentElement;
            if (!parent) return;
            const index = parent.children.indexOf(this);
            if (index >= 0) {
                node.parentElement = parent;
                parent.children.splice(index, 1, node);
            }
            this.parentElement = null;
        }
        remove() {
            if (this.parentElement) {
                this.parentElement.children = this.parentElement.children.filter(child => child !== this);
                this.parentElement = null;
            }
        }
        cloneNode(): RuntimeDomNode {
            const copy = new RuntimeDomNode(this.tagName);
            copy.id = this.id;
            copy.className = this.className;
            copy.text = this.text;
            return copy;
        }
        setAttribute(name: string, value: string) {
            this.attributes.set(name, value);
            if (name === 'id') this.id = value;
            else if (name === 'class') this.className = value;
            else if (name === 'title') this.title = value;
            else if (name === 'style') this.style.cssText = value;
            else if (name.startsWith('data-')) {
                const camel = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
                this.dataset[camel] = value;
            }
        }
        getAttribute(name: string): string | null {
            if (name === 'id') return this.id || null;
            if (name === 'class') return this.className || null;
            if (name === 'title') return this.title || this.attributes.get('title') || null;
            if (name === 'style') return this.attributes.get('style') ?? 'left: 0px; top: 0px; width: 64px; height: 64px;';
            return this.attributes.get(name) ?? null;
        }
        removeAttribute(name: string) {
            this.attributes.delete(name);
            if (name === 'title') this.title = '';
            if (name.startsWith('data-')) {
                const camel = name.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
                delete this.dataset[camel];
            }
        }
        hasAttribute(name: string): boolean {
            return this.getAttribute(name) !== null;
        }
        addEventListener(type: string, listener: (event: any) => void) {
            let set = this.listeners.get(type);
            if (!set) { set = new Set(); this.listeners.set(type, set); }
            set.add(listener);
        }
        removeEventListener(type: string, listener: (event: any) => void) {
            this.listeners.get(type)?.delete(listener);
        }
        dispatchEvent(event: {type: string; [key: string]: unknown}): boolean {
            for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
            if (event.type === 'change') this.onchange?.(event);
            if (event.type === 'input') this.oninput?.(event);
            if (event.type === 'click') this.onclick?.(event);
            if (event.type === 'submit') this.onsubmit?.(event);
            return true;
        }
        click() {
            if (this.disabled) return;
            if (this.tagName === 'input' && this.type === 'checkbox') {
                this.checked = !this.checked;
                this.onchange?.({type: 'change', target: this, preventDefault() {}});
                for (const listener of [...(this.listeners.get('change') ?? [])]) {
                    listener({type: 'change', target: this, preventDefault() {}});
                }
            }
            this.onclick?.({type: 'click', target: this, preventDefault() {}});
            for (const listener of [...(this.listeners.get('click') ?? [])]) {
                listener({type: 'click', target: this, preventDefault() {}});
            }
        }
        reportValidity(): boolean { return true; }
        pause() {}
        toJSON() { return {}; }
        getBoundingClientRect() {
            return {left: 0, top: 0, right: 64, bottom: 64, width: 64, height: 64, x: 0, y: 0};
        }
        getContext(kind: string) {
            if (kind !== '2d') return null;
            const owner = this;
            return {
                strokeStyle: '',
                fillStyle: '',
                lineWidth: 1,
                globalAlpha: 1,
                save() {},
                restore() {},
                setLineDash() {},
                setTransform() { owner.canvasOps.push('setTransform'); },
                clearRect(x: number, y: number, w: number, h: number) { owner.canvasOps.push(`clearRect:${x},${y},${w},${h}`); },
                beginPath() { owner.canvasOps.push('beginPath'); },
                moveTo(x: number, y: number) { owner.canvasOps.push(`moveTo:${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`); },
                lineTo(x: number, y: number) { owner.canvasOps.push(`lineTo:${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`); },
                stroke() { owner.canvasOps.push(`stroke:${this.strokeStyle}`); },
                arc(x: number, y: number, r: number) { owner.canvasOps.push(`arc:${Math.round(x * 100) / 100},${Math.round(y * 100) / 100},${r}`); },
                fill() { owner.canvasOps.push(`fill:${this.fillStyle}`); },
                getImageData(_x: number, _y: number, width: number, height: number) {
                    return {width, height, data: owner.pixels.slice(0, width * height * 4)};
                },
                putImageData(image: {data: Uint8ClampedArray}, _x: number, _y: number) {
                    owner.pixels.set(image.data.subarray(0, owner.pixels.length));
                },
            };
        }
        toBlob(callback: (blob: {size: number; png: string} | null) => void) {
            const tag = Buffer.from(`${this.pixels[0]}-${this.pixels[1]}-${this.width}x${this.height}`).toString('base64');
            callback({size: tag.length, png: 'data:image/png;base64,' + tag});
        }
        private matchesSingle(selector: string): boolean {
            if (selector.startsWith('#')) return this.id === selector.slice(1);
            if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
            const attrMatch = selector.match(/^([a-z0-9]*)\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/);
            if (attrMatch) {
                const [, tag, attr, dq, sq, raw] = attrMatch;
                if (tag && this.tagName !== tag) return false;
                const expected = dq ?? sq ?? raw;
                const actual = attr === 'name' ? (this.name || this.getAttribute('name'))
                    : attr === 'type' ? (this.type || this.getAttribute('type'))
                    : attr === 'role' ? this.getAttribute('role')
                    : attr!.startsWith('data-') ? this.dataset[attr!.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())]
                    : this.getAttribute(attr!);
                return expected === undefined ? actual !== undefined && actual !== null : actual === expected;
            }
            return this.tagName === selector;
        }
        matches(selector: string): boolean {
            return selector.split(',').some(part => this.matchesSingle(part.trim()));
        }
        closest(selector: string): RuntimeDomNode | null {
            for (let node: RuntimeDomNode | null = this; node; node = node.parentElement) {
                if (node.matches(selector)) return node;
            }
            return null;
        }
        querySelector(selector: string): RuntimeDomNode | null {
            return this.querySelectorAll(selector)[0] ?? null;
        }
        querySelectorAll(selector: string): RuntimeDomNode[] {
            const groups = selector.split(',').map(part => part.trim()).filter(Boolean);
            if (groups.length > 1) {
                const seen = new Set<RuntimeDomNode>();
                for (const group of groups) {
                    for (const item of this.querySelectorAll(group)) seen.add(item);
                }
                return [...seen];
            }
            const parts = selector.trim().split(/\s+/);
            const result: RuntimeDomNode[] = [];
            const walk = (root: RuntimeDomNode, index: number) => {
                for (const child of root.children) {
                    if (child.matchesSingle(parts[index]!)) {
                        if (index === parts.length - 1) result.push(child);
                        else walk(child, index + 1);
                    }
                    walk(child, index);
                }
            };
            walk(this, 0);
            return result;
        }
        set innerHTML(markup: string) {
            this.children = [];
            this.text = '';
            const stack: RuntimeDomNode[] = [this];
            for (const token of markup.matchAll(/<\/?([a-z][a-z0-9]*)([^>]*)>|([^<]+)/g)) {
                if (token[3]) {
                    const textNode = new RuntimeDomNode('#text');
                    textNode.textContent = token[3];
                    stack.at(-1)!.append(textNode);
                } else if (token[0].startsWith('</')) {
                    stack.pop();
                } else {
                    const element = new RuntimeDomNode(token[1]!);
                    for (const attribute of token[2]!.matchAll(/([a-z-]+)="([^"]*)"/g)) {
                        element.setAttribute(attribute[1]!, attribute[2]!);
                    }
                    element.hidden = /\bhidden\b/.test(token[2]!);
                    stack.at(-1)!.append(element);
                    stack.push(element);
                }
            }
        }
        setPixelSeed(seed: number) {
            this.pixels[0] = seed & 0xff;
            this.pixels[1] = (seed >> 8) & 0xff;
        }
    }

    function createPublicPlayerDouble(clips: readonly {name: string; duration: number}[] = [{name: 'inspect', duration: 0.5}]) {
        let current: string | null = null;
        let loop = true;
        let trackTime = 0;
        let paused = true;
        let composed = false;
        let clearedEmpty = false;
        let generation = 1;
        let disposed = false;
        const renderer = {syncPixelRatio() {}, meshBackendActive: '2d' as const};
        const history: string[] = [];
        let playCalls = 0;
        let pauseCalls = 0;
        let resumeCalls = 0;
        let seekCalls = 0;
        let advanceCalls = 0;
        let physicsEpoch = 0;
        const durationOf = (name: string | null) => clips.find(item => item.name === name)?.duration ?? 0;
        const player = {
            get generation() { return generation; },
            get current() { return current; },
            get time() { return trackTime; },
            get composed() { return composed; },
            get paused() { return paused; },
            get loop() { return loop; },
            get physicsEpoch() { return physicsEpoch; },
            get disposed() { return disposed; },
            slots: null as RigPlayer['slots'],
            renderer,
            history,
            counts: () => ({playCalls, pauseCalls, resumeCalls, seekCalls, advanceCalls, physicsEpoch}),
            bounds: () => ({x: 0, y: 0, width: 64, height: 64}),
            bone(name: string) {
                return {
                    x: name === 'head_b' ? 16 : 8,
                    y: name === 'head_b' ? 32 : 12,
                    a: 1, b: 0, c: 0, d: 1,
                    worldX: name === 'head_b' ? 16 : 8,
                    worldY: name === 'head_b' ? 32 : 12,
                    active: true,
                };
            },
            moved() {},
            clear(track = 0, _options?: {mix?: number}) {
                if (track === 0) {
                    current = null;
                    trackTime = 0;
                    composed = true;
                    clearedEmpty = true;
                    generation++;
                    physicsEpoch++;
                    history.push('clear');
                }
            },
            play(name: string, options?: {loop?: boolean}) {
                playCalls++;
                current = name;
                loop = options?.loop ?? true;
                trackTime = 0;
                paused = false;
                composed = false;
                clearedEmpty = false;
                generation++;
                physicsEpoch++; // play opens track at 0 with physics reset
                history.push(`play:${name}:loop=${loop}`);
            },
            pause() {
                pauseCalls++;
                paused = true;
                history.push('pause');
            },
            resume() {
                resumeCalls++;
                paused = false;
                history.push('resume');
            },
            seek(target: number) {
                if (composed || !current) throw new Error('SEEK_UNSUPPORTED');
                seekCalls++;
                trackTime = 0;
                const steps = Math.floor(target / (1 / 60));
                for (let i = 0; i < steps; i++) trackTime += 1 / 60;
                const rest = target - trackTime;
                if (rest > 0) trackTime += rest;
                generation++;
                physicsEpoch++; // seek replays from 0 in seekStep increments, resetting physics history to deterministic target state
                history.push(`seek:${Number(target.toFixed(6))}`);
            },
            advance(dt: number) {
                advanceCalls++;
                if (paused || !current || !(dt > 0)) return;
                trackTime += dt;
                generation++;
                history.push(`advance:${Number(dt.toFixed(6))}->${Number(trackTime.toFixed(6))}`);
            },
            draw() {
                history.push(`draw:${current ?? 'setup'}@${Number(trackTime.toFixed(6))}`);
            },
            entry(track = 0): ReturnType<RigPlayer['entry']> {
                if (track !== 0) return null;
                if (current === null) {
                    return clearedEmpty
                        ? {animation: null, loop: false, trackTime: 0, animationTime: 0, duration: 0, alpha: 1, additive: false}
                        : null;
                }
                const duration = durationOf(current);
                const animationTime = duration > 0
                    ? (loop ? trackTime % duration : Math.min(trackTime, duration))
                    : 0;
                return {animation: current, loop, trackTime, animationTime, duration, alpha: 1, additive: false};
            },
            dispose() {
                disposed = true;
                history.push('dispose');
            },
        };
        return player;
    }

    async function mountRuntimeSession(options?: {
        hub?: string;
        visible?: boolean;
        clips?: readonly {name: string; duration: number}[];
        interview?: JobPreparedInspection['interview'];
        planText?: JobPlanTextProjection;
        clipsFor?: (display: JobDisplayPublication) => readonly {name: string; duration: number}[];
        slotsFor?: (display: JobDisplayPublication) => readonly string[];
        slotIdentityFor?: (display: JobDisplayPublication, slot: string) => string;
        referencesFor?: (display: JobDisplayPublication) => readonly {id: string; label: string}[];
        localStore?: Map<string, string>;
        fixture?: ReturnType<typeof createJobWindowFixture>;
        pageId?: string;
        evidence?: ReturnType<typeof syntheticCheckpointEvidence>;
    }) {
        const source = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
        const start = source.indexOf('    const node = <Tag extends keyof HTMLElementTagNameMap>');
        const end = source.indexOf('    return () => { globalThis.removeEventListener(\'pagehide\', stop); stop(); };', start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const closureBody = source.slice(start, end) + '\nreturn {window, workspace, stop: () => { globalThis.removeEventListener(\'pagehide\', stop); stop(); }};';
        const transpiled = new Bun.Transpiler({loader: 'ts'}).transformSync(closureBody);

        const saved = new Map<string, PropertyDescriptor | undefined>();
        const setGlobal = (key: string, value: unknown) => {
            if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
            Object.defineProperty(globalThis, key, {configurable: true, writable: true, value});
        };

        const rafCallbacks = new Map<number, (now: number) => void>();
        let nextRafId = 1;
        let nowMs = 1000;
        const globalListeners = new Map<string, Set<(event: any) => void>>();
        const localStore = options?.localStore ?? new Map<string, string>();
        const setItemWrites: {key: string; value: string}[] = [];
        const parentMessages: unknown[] = [];
        const parentWindow = {postMessage(data: unknown) { parentMessages.push(data); }};

        class TestReader {
            result: string | null = null;
            onload?: () => void;
            onerror?: () => void;
            readAsDataURL(blob: {png: string}) {
                this.result = blob.png;
                this.onload?.();
            }
        }
        class NoopObserver {
            observe() {}
            disconnect() {}
        }

        setGlobal('HTMLElement', RuntimeDomNode);
        setGlobal('HTMLSelectElement', RuntimeDomNode);
        setGlobal('HTMLInputElement', RuntimeDomNode);
        setGlobal('HTMLTextAreaElement', RuntimeDomNode);
        setGlobal('HTMLFormElement', RuntimeDomNode);
        setGlobal('HTMLFieldSetElement', RuntimeDomNode);
        setGlobal('HTMLButtonElement', RuntimeDomNode);
        setGlobal('Element', RuntimeDomNode);
        setGlobal('FileReader', TestReader);
        setGlobal('ResizeObserver', NoopObserver);
        setGlobal('MutationObserver', NoopObserver);
        setGlobal('devicePixelRatio', 1);
        setGlobal('parent', parentWindow);
        setGlobal('location', {
            href: 'http://127.0.0.1:4318/jobs/window-fixture/' + (options?.hub ? '?hub=' + options.hub : ''),
            origin: 'http://127.0.0.1:4318',
        });
        setGlobal('localStorage', {
            get length() { return localStore.size; },
            key: (index: number) => [...localStore.keys()][index] ?? null,
            getItem: (key: string) => localStore.get(key) ?? null,
            setItem: (key: string, value: string) => {
                setItemWrites.push({key, value});
                localStore.set(key, value);
            },
        });
        const host = new RuntimeDomNode('div');
        const docNode = new RuntimeDomNode('document');
        docNode.append(host);
        setGlobal('window', globalThis);
        setGlobal('document', {
            documentElement: new RuntimeDomNode('html'),
            createElement: (tag: string) => new RuntimeDomNode(tag),
            createTextNode: (text: string) => { const n = new RuntimeDomNode('#text'); n.textContent = text; return n; },
            getElementById: (id: string) => docNode.querySelector('#' + id),
            addEventListener: (type: string, listener: (event: any) => void) => docNode.addEventListener(type, listener),
            removeEventListener: (type: string, listener: (event: any) => void) => docNode.removeEventListener(type, listener),
        });
        setGlobal('getComputedStyle', (node: RuntimeDomNode) => ({
            visibility: 'visible',
            display: node.hidden ? 'none' : 'block',
            opacity: '1',
            filter: 'none',
            perspective: 'none',
            transform: node.id === 'rig-root' ? 'matrix(1, 0, 0, 1, 0, 0)' : 'none',
            getPropertyValue: () => '#fff',
        }));
        setGlobal('matchMedia', () => ({addEventListener() {}, removeEventListener() {}}));
        setGlobal('requestAnimationFrame', (callback: (now: number) => void) => {
            const id = nextRafId++;
            rafCallbacks.set(id, callback);
            return id;
        });
        setGlobal('cancelAnimationFrame', (id: number) => {
            rafCallbacks.delete(id);
        });
        setGlobal('addEventListener', (type: string, listener: (event: any) => void) => {
            let set = globalListeners.get(type);
            if (!set) { set = new Set(); globalListeners.set(type, set); }
            set.add(listener);
        });
        setGlobal('removeEventListener', (type: string, listener: (event: any) => void) => {
            globalListeners.get(type)?.delete(listener);
        });

        const fixture = options?.fixture ?? createJobWindowFixture();
        const players: ReturnType<typeof createPublicPlayerDouble>[] = [];
        let failNextSubmit = false;
        const defaultClips = options?.clips ?? [{name: 'inspect', duration: 0.5}];

        const prepareJobInspection = async (display: JobDisplayPublication): Promise<JobPreparedInspection> => {
            const clips = options?.clipsFor ? options.clipsFor(display) : defaultClips;
            const slots = options?.slotsFor ? [...options.slotsFor(display)] : ['body', 'head'];
            const refDefs = options?.referencesFor ? options.referencesFor(display) : [{id: 'ref-1', label: 'Ref 1'}];
            const rigRoot = new RuntimeDomNode('div');
            rigRoot.id = 'rig-root';
            rigRoot.setAttribute('style', 'left: 0px; top: 0px; transform: scale(1);');
            let player = createPublicPlayerDouble(clips);
            players.push(player);
            let selectedSlot: {side: 'single'; slot: string; mode: 'context' | 'solo'} | null = null;
            let presentedGen: number | undefined = player.generation;
            let rigPresentation: JobPreparedInspection['rigPresentation'];
            const slotIdentity = (slot: string) => ({
                attachment: options?.slotIdentityFor ? options.slotIdentityFor(display, slot) : slot,
                skin: 'default',
                reason: null,
                set: null,
                activeSkin: null,
            });
            const fullOrder = [
                {
                    slot: 'body',
                    attachment: 'body_mesh',
                    kind: 'mesh' as const,
                    page: '0',
                    sequence: null,
                    vertices: [0, 0, 20, 0, 20, 20, 0, 20],
                    triangles: [0, 1, 2, 0, 2, 3],
                    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                    z: 0,
                    tint: [1, 1, 1, 1] as [number, number, number, number],
                },
                {
                    slot: 'head',
                    attachment: 'head_gen_mesh',
                    kind: 'mesh' as const,
                    page: '0',
                    sequence: null,
                    vertices: [10, 20, 30, 20, 20, 40],
                    triangles: [0, 1, 2],
                    uvs: [0, 0, 1, 0, 0.5, 1],
                    z: 1,
                    tint: [1, 1, 1, 1] as [number, number, number, number],
                },
            ];
            const inspection = {
                register() {},
                present() { presentedGen = player.generation; },
                frame: () => presentedGen === undefined ? undefined : ({
                    generation: presentedGen,
                    order: selectedSlot?.mode === 'solo'
                        ? fullOrder.filter(row => row.slot === selectedSlot!.slot)
                        : fullOrder,
                } as any),
                select(value: typeof selectedSlot) { selectedSlot = value; },
                value: (): ControlPart | null => selectedSlot
                    ? {side: selectedSlot.side, slot: selectedSlot.slot, mode: selectedSlot.mode, identity: slotIdentity(selectedSlot.slot)}
                    : null,
                observation: () => selectedSlot ? {slot: selectedSlot.slot, mode: selectedSlot.mode} : null,
                bounds: () => ({x: 0, y: 0, width: 64, height: 64}),
                assertIdentity(expected: ControlPart | null | undefined) {
                    if (!expected) return;
                    parseControlPart(expected);
                    if (!slots.includes(expected.slot)) {
                        throw new Error(`PART_UNAVAILABLE: ${expected.side} / ${expected.slot}`);
                    }
                    const actual = slotIdentity(expected.slot);
                    if (expected.identity && JSON.stringify(actual) !== JSON.stringify(parsePartIdentity(expected.identity))) {
                        throw new Error(`PART_IDENTITY_MISMATCH: ${expected.side} / ${expected.slot}`);
                    }
                },
            };
            const setupPose = (setup = true) => {
                rigPresentation?.canvas.remove();
                rigPresentation = undefined;
                if (setup) {
                    player.clear(0, {mix: 0});
                    player.draw();
                    inspection.present();
                } else if (player.composed) {
                    player.dispose();
                    player = createPublicPlayerDouble(clips);
                    players[players.length - 1] = player;
                    presentedGen = player.generation;
                }
            };
            setupPose(true);
            const pkgIdentity = 'package' in display.publication.source && display.publication.source.package
                ? display.publication.source.package
                : { id: 'record-plan-fixture', revision: String(display.publication.generation) };
            const references = refDefs.map(ref => ({
                id: ref.id,
                label: ref.label,
                element: new RuntimeDomNode('img') as unknown as HTMLImageElement,
                width: 64,
                height: 64,
                seek: async () => {},
            }));
            return {
                display,
                metadata: {
                    manifest: parseManifest({schema: 'rig-review/1', ...pkgIdentity,
                        title: 'Rig fixture', model: 'skeleton.model.json'}),
                    sourceHash: display.publication.source.sourceHash,
                    ...(options?.planText ? {planText:options.planText} : {}),
                    reviewedSource: {
                        packageRevision: pkgIdentity.revision,
                        viewerVersion: '2.4.6',
                        runtimeVersion: '1.23.0',
                        rig: {path: 'skeleton.model.json', sha256: 'a'.repeat(64)},
                        motion: null,
                    },
                    direction: {
                        schema: 'rig-review-direction-inspection/1',
                        camera: {space: 'rig-world-y-up'},
                    } as any,
                    capabilities: {playback: true, ...(options?.interview ? {interview: true} : {})},
                    feedbackCatalog: {slots, bones: ['root', 'head_b']},
                },
                interview: options?.interview ?? null,
                parts: null,
                partImages: new Map(),
                partPages: new Map(),
                interviewImages: new Map(),
                imageSetImages: [],
                ...(options?.evidence ? {checkpointEvidence: [{packet: options.evidence.packet, table: options.evidence.table,
                    images: options.evidence.packet.tiles.map(() => new RuntimeDomNode('img') as unknown as HTMLImageElement)}]} : {}),
                references,
                assets: {animations: clips, stage: {x: 0, y: 0, width: 64, height: 64}, dispose() {}} as any,
                rigRoot: rigRoot as unknown as HTMLElement,
                get rigPresentation() { return rigPresentation; },
                set rigPresentation(value) {
                    rigPresentation?.canvas.remove();
                    rigPresentation = value;
                },
                get player() { return player as unknown as RigPlayer; },
                get inspection() { return inspection as any; },
                setupPose,
                dispose() {
                    rigPresentation?.canvas.remove();
                    rigPresentation = undefined;
                    player.dispose();
                },
            };
        };

        const presentJobRigViewport = () => {
            const canvas = new RuntimeDomNode('canvas');
            canvas.width = 64;
            canvas.height = 64;
            canvas.setAttribute('data-job-rig-presentation', '');
            canvas.setAttribute('style', 'left: 0px; top: 0px; width: 64px; height: 64px;');
            const active = players.at(-1);
            canvas.setPixelSeed(Math.round((active?.time ?? 0) * 1000) + (active?.generation ?? 0) * 17);
            return {
                canvas: canvas as unknown as HTMLCanvasElement,
                width: 64,
                height: 64,
                ratio: 1,
                area: {x: 0, y: 0, width: 64, height: 64},
            };
        };

        const outgoingSubmits: {raw: string; body: any}[] = [];
        const request = (body: unknown) => new Request('http://127.0.0.1:4318/jobs/window-fixture/ui/displayed', {
            method: 'POST',
            headers: {'content-type': 'application/json', origin: 'http://127.0.0.1:4318'},
            body: JSON.stringify(body),
        });
        const transport = {
            readPublication: (id: string) => fixture.ports.readPublication(fixture.jobId, id),
            acknowledge: (body: unknown) => fixture.ports.ackDisplayed(fixture.jobId, request(body)),
            submit: async (body: unknown) => {
                const raw = JSON.stringify(body);
                outgoingSubmits.push({raw, body: JSON.parse(raw)});
                if (failNextSubmit) {
                    failNextSubmit = false;
                    throw new Error('Declared transport reply loss');
                }
                return fixture.ports.commitUIAct(fixture.jobId, request(body));
            },
        };
        const hubIncarnation = options?.hub ?? null;
        const hubVisible = options?.visible ?? !hubIncarnation;
        const access = {jobId: fixture.jobId, capability: 'c'.repeat(64)};
        const abort = new AbortController();
        class CanvasRenderer {}
        const assertJobAskSource = (ask: {source: {sourceHash: string}}, display: JobDisplayPublication) => {
            if (ask.source.sourceHash !== display.publication.source.sourceHash) throw new Error('JOB_ACT_SOURCE_STALE');
        };
        const startEvents = () => ({displayed() {}, visibility() {}, done: Promise.resolve()});

        const runner = new Function(
            'host', 'access', 'hubIncarnation', 'hubVisible', 'events', 'pageId', 'transport', 'abort',
            'i18n', 't', 'createViewportController', 'createViewportState', 'createRigViewportProvider', 'mountViewportPair', 'mountWorkspaceShell',
            'RigOverlays', 'labelledControl', 'createViewControls', 'bindLayerShortcuts', 'describeLayerToggles', 'layerShortcuts', 'SENTINELS',
            'createJobWindow', 'createJobReferenceSelection', 'prepareJobForms', 'jobCheckpointContext', 'jobWindowRefusal', 'jobPartsReviewState',
            'prepareJobInspection', 'startJobWindowEvents', 'assertJobAskSource', 'parseControlPart',
            'recordJobRigDraw', 'freezeJobRigCapture', 'copyJobRigViewport', 'createJobRigSubmission', 'jobRigPixelPlacement',
            'presentJobRigViewport', 'CanvasRenderer', 'enCatalog', 'koCatalog', 'JOB_HUB_READY', 'jobHubMessageMatches', 'advancePlayback', 'JOB_PLAN_TEXT_FIELDS',
            transpiled,
        );
        const mounted = runner(
            host, access, hubIncarnation, hubVisible, undefined, options?.pageId ?? 'page-one', transport, abort,
            i18nModule, i18nModule.t, createViewportController, createViewportState, createRigViewportProvider, mountViewportPair, mountWorkspaceShell,
            RigOverlays, labelledControl, createViewControls, bindLayerShortcuts, describeLayerToggles, layerShortcuts, SENTINELS,
            createJobWindow, createJobReferenceSelection, prepareJobForms, jobCheckpointContext, jobWindowRefusal, jobPartsReviewState,
            prepareJobInspection, startEvents, assertJobAskSource, parseControlPart,
            recordJobRigDraw, freezeJobRigCapture, copyJobRigViewport, createJobRigSubmission, jobRigPixelPlacement,
            presentJobRigViewport, CanvasRenderer, enCatalog, koCatalog, JOB_HUB_READY, jobHubMessageMatches, advancePlayback, JOB_PLAN_TEXT_FIELDS,
        ) as {window: ReturnType<typeof createJobWindow>; workspace: RuntimeDomNode; stop: () => void};

        async function drainPreparing() {
            for (let tick = 0; tick < 12 && mounted.window.state().preparing; tick++) {
                await Bun.sleep(1);
                if (rafCallbacks.size > 0) {
                    const entries = [...rafCallbacks.entries()];
                    rafCallbacks.clear();
                    for (const [, cb] of entries) cb(nowMs);
                }
            }
            await mounted.window.settled();
            expect(mounted.window.state().error).toBeNull();
        }

        return {
            fixture,
            localStore,
            setItemWrites,
            windowWrites: () => setItemWrites.filter(item => item.key.startsWith('rig-review-job-window/1:')),
            host,
            workspace: mounted.workspace,
            window: mounted.window,
            players,
            activePlayer: () => players.at(-1)!,
            parentWindow,
            outgoingSubmits,
            rafCount: () => rafCallbacks.size,
            rafIds: () => [...rafCallbacks.keys()],
            captureRafCallbacks: () => [...rafCallbacks.values()],
            stepRaf(elapsedMs = 1000 / 60) {
                nowMs += elapsedMs;
                const entries = [...rafCallbacks.entries()];
                rafCallbacks.clear();
                for (const [, cb] of entries) cb(nowMs);
            },
            failNextTransportSubmit() { failNextSubmit = true; },
            emitGlobal(type: string, event: Record<string, unknown> = {}) {
                docNode.dispatchEvent({type, ...event});
                for (const listener of [...(globalListeners.get(type) ?? [])]) listener({type, ...event});
            },
            async publishDisplay<Display extends DisplayPublicationV3>(display: Display): Promise<Display> {
                fixture.publish(display);
                mounted.window.event(fixture.events.at(-1)!);
                await drainPreparing();
                return display;
            },
            async publishRig(index: number, overrides?: {
                optionSet?: {id: string; sha256: string} | null;
                interview?: JobDisplayPublication['publication']['interview'];
            }) {
                const base = fixturePublication(index);
                if (base.publication.source.subject === 'image-set') {
                    throw new Error('Expected model source in rig fixture publication');
                }
                const display: JobDisplayPublication = {
                    ...base,
                    publication: {
                        ...base.publication,
                        ...(overrides?.interview === undefined ? {} : {interview: overrides.interview}),
                        source: {
                            ...base.publication.source,
                            selector: {kind: 'rig', version: 1},
                            ...(overrides?.optionSet === undefined ? {} : {optionSet: overrides.optionSet}),
                        },
                    },
                };
                return this.publishDisplay(display);
            },
            async replayPublication(display: JobDisplayPublication) {
                mounted.window.event({
                    jobId: fixture.jobId,
                    generation: display.publication.generation,
                    cursor: String(display.publication.generation),
                    type: 'published',
                    publication: display.publication,
                });
                await drainPreparing();
            },
            cleanup() {
                try { mounted.stop(); } finally {
                    for (const [key, descriptor] of saved) {
                        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                        else Reflect.deleteProperty(globalThis, key);
                    }
                }
            },
        };
    }

    test('#659 actual job labels retain localized span/control order and identity across language refresh', async () => {
        const preference = i18nModule.getLanguagePreference();
        const s = await mountRuntimeSession();
        try {
            const display = await s.publishRig(1);
            const ask: PendingAskV3 = {askId:'label-form',publicationId:display.publication.publicationId,
                source:display.publication.source,subject:{kind:'review-verdict',stage:'rig-review'},status:'pending'};
            s.fixture.pending(ask,2);
            s.window.event(s.fixture.events.at(-1)!);
            const form = s.workspace.querySelector('form[data-job-ask="label-form"]')!;
            expect(form).not.toBeNull();
            const input = s.workspace.querySelector('#job-time')!;
            const note = form.querySelector('textarea[name="note"]')!;
            expect(input).not.toBeNull();expect(note).not.toBeNull();
            const pairs = [{control:input,key:'job.time'},{control:note,key:'interview.note'}].map(({control,key}) => {
                const label = control.parentElement!;
                const span = label.children[0]!;
                expect(label.tagName).toBe('label');
                expect(span.tagName).toBe('span');
                expect(span.dataset.jobText).toBe(key);
                expect(label.children).toEqual([span,control]);
                return {control,key,label,span};
            });
            note.value = '  literal reviewer text 한글\n';
            for (const language of ['en','ko'] as const) {
                i18nModule.setLanguagePreference(language);
                for (const {control,key,label,span} of pairs) {
                    expect(span.textContent).toBe(i18nModule.t(key));
                    expect(label.children[0]).toBe(span);
                    expect(label.children[1]).toBe(control);
                }
                expect(s.workspace.querySelector('#job-time')!).toBe(input);
                expect(form.querySelector('textarea[name="note"]')!).toBe(note);
                expect(note.value).toBe('  literal reviewer text 한글\n');
            }
        } finally {
            s.cleanup();
            i18nModule.setLanguagePreference(preference);
        }
    });

    test('#559 runtime transport lifecycle: #job-play, #job-loop, single rAF, loop wrap, physics-reset loop toggle, and one-shot completion', async () => {
        const s = await mountRuntimeSession();
        try {
            const act = fixtureAct('review-verdict', 'wrapped endpoint check');
            if (act.schema !== 'rig-review/act@2' || act.kind !== 'review-verdict' || act.value.stage !== 'rig-review') {
                throw new Error('Expected review-verdict fixture act');
            }
            const display = await s.publishRig(1);
            const source = display.publication.source;
            if (source.subject === 'image-set' || source.selector?.kind !== 'rig' || !source.model) {
                throw new Error('Expected rig model source');
            }
            const ask = {
                askId: act.askId,
                publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(ask, 2);
            s.window.event(s.fixture.events.at(-1)!);
            s.fixture.returnAct({
                ...act,
                publicationId: display.publication.publicationId,
                source: {...source, selector: source.selector, model: source.model},
                value: act.value,
            });
            // Reached existing controls on initial Setup mount (no autoplay):
            const animationSelect = s.workspace.querySelector('#job-animation')!;
            const timeInput = s.workspace.querySelector('#job-time')!;
            expect(animationSelect).not.toBeNull();
            expect(timeInput).not.toBeNull();
            expect(animationSelect.value).toBe('');
            expect(timeInput.value).toBe('0');
            expect(s.activePlayer().current).toBeNull();
            expect(s.rafCount()).toBe(0);

            // Selecting an animation poses at 0s and pauses without starting rAF:
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const player = s.activePlayer();
            expect(player.current).toBe('inspect');
            expect(player.paused).toBe(true);
            expect(player.time).toBe(0);
            expect(s.rafCount()).toBe(0);

            // #559 transport controls required on .job-transport:
            const playButton = s.workspace.querySelector('#job-play')!;
            const loopInput = s.workspace.querySelector('#job-loop')!;
            expect(playButton).not.toBeNull();
            expect(loopInput).not.toBeNull();
            expect(playButton.disabled).toBe(false);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');
            expect(loopInput.type).toBe('checkbox');
            expect(loopInput.checked).toBe(true);

            // Start continuous playback: single rAF armed, player resumed:
            playButton.click();
            expect(player.paused).toBe(false);
            expect(playButton.dataset.jobText).toBe('Pause');
            expect(playButton.getAttribute('aria-pressed')).toBe('true');
            expect(s.rafCount()).toBe(1);

            // Advance past one full 0.5s loop (36 steps of 1/60s = 0.6s):
            s.stepRaf(0);
            for (let i = 0; i < 6; i++) s.stepRaf(100);
            expect(s.rafCount()).toBe(1);
            expect(player.time).toBeCloseTo(0.6, 5);
            expect(player.entry(0)?.animationTime).toBeCloseTo(0.1, 5);
            expect(Number(timeInput.value)).toBeCloseTo(0.1, 5);

            // Toggle loop off while playing: must explicitly reset physics via play(animation, {loop: false}) + seek(time) and keep playing:
            const epochBeforeLoopToggle = player.physicsEpoch;
            const playCallsBeforeToggle = player.counts().playCalls;
            const seekCallsBeforeToggle = player.counts().seekCalls;
            loopInput.checked = false;
            loopInput.dispatchEvent({type: 'change'});
            expect(player.loop).toBe(false);
            expect(player.paused).toBe(false);
            expect(player.counts().playCalls).toBe(playCallsBeforeToggle + 1);
            expect(player.counts().seekCalls).toBe(seekCallsBeforeToggle + 1);
            expect(player.physicsEpoch).toBeGreaterThan(epochBeforeLoopToggle);
            expect(player.entry(0)?.animationTime).toBeCloseTo(0.1, 5);
            expect(s.rafCount()).toBe(1);

            // Step remaining 0.4s to reach one-shot duration (0.5s): must auto-pause at duration and disarm rAF:
            for (let i = 0; i < 5; i++) s.stepRaf(100);
            expect(player.paused).toBe(true);
            expect(player.entry(0)?.animationTime).toBeCloseTo(0.5, 5);
            expect(Number(timeInput.value)).toBeCloseTo(0.5, 5);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');
            expect(s.rafCount()).toBe(0);

            // Toggle Repeat back on at paused one-shot endpoint (time === duration):
            // public entry(0).animationTime wraps to 0; visible #job-time and canonical capture frame must match wrapped 0, remaining paused without autoplay:
            loopInput.checked = true;
            loopInput.dispatchEvent({type: 'change'});
            expect(player.loop).toBe(true);
            expect(player.paused).toBe(true);
            expect(s.rafCount()).toBe(0);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');
            expect(player.entry(0)?.animationTime).toBe(0);
            expect(timeInput.value).toBe('0');
            expect(Number(timeInput.value)).toBe(player.entry(0)!.animationTime);

            const form = s.workspace.querySelector(`form[data-job-ask="${ask.askId}"]`)!;
            const verdictSelect = form.querySelector('select[name="verdict"]')!;
            const noteInput = form.querySelector('textarea[name="note"]')!;
            verdictSelect.value = 'approved';
            noteInput.value = 'wrapped endpoint check';
            form.dispatchEvent({type: 'input'});
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.outgoingSubmits[0]!.body.capture.playing).toBe(false);
            expect(s.outgoingSubmits[0]!.body.capture.animation).toBe('inspect');
            expect(s.outgoingSubmits[0]!.body.capture.frame).toBe(0);
        } finally {
            s.cleanup();
        }
    });

    test('#559 raw floating boundary time formats only the readout and preserves paused canonical capture and manual precision', async () => {
        const s = await mountRuntimeSession({clips: [{name: 'inspect', duration: 1}]});
        try {
            const act = fixtureAct('review-verdict', 'raw boundary capture');
            if (act.schema !== 'rig-review/act@2' || act.kind !== 'review-verdict' || act.value.stage !== 'rig-review') {
                throw new Error('Expected review-verdict fixture act');
            }
            const display = await s.publishRig(1);
            const source = display.publication.source;
            if (source.subject === 'image-set' || source.selector?.kind !== 'rig' || !source.model) {
                throw new Error('Expected rig model source');
            }
            const ask = {askId: act.askId, publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const}, source, status: 'pending' as const};
            s.fixture.pending(ask, 2);
            s.window.event(s.fixture.events.at(-1)!);
            s.fixture.returnAct({...act, publicationId: display.publication.publicationId,
                source: {...source, selector: source.selector, model: source.model}, value: act.value});
            const animationSelect = s.workspace.querySelector('#job-animation')!;
            const clock = s.workspace.querySelector('#job-time')!;
            const play = s.workspace.querySelector('#job-play')!;
            const repeat = s.workspace.querySelector('#job-loop')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const player = s.activePlayer();
            const residue = 1.3322676295501878e-15;
            const countsBefore = player.counts();
            play.click();
            s.stepRaf(0);
            for (let i = 0; i < 10; i++) s.stepRaf(100);
            expect(player.time).toBe(1 + residue);
            expect(player.entry(0)!.animationTime).toBe(residue);
            expect(player.counts().seekCalls).toBe(countsBefore.seekCalls);
            expect(player.physicsEpoch).toBe(countsBefore.physicsEpoch);
            expect(clock.value).toBe('0');
            play.click();
            const rawPaused = player.entry(0)!.animationTime;
            s.stepRaf(100);
            s.stepRaf(100);
            expect(player.entry(0)!.animationTime).toBe(rawPaused);
            expect(clock.value).toBe('0');
            expect(play.getAttribute('aria-pressed')).toBe('false');
            expect(play.dataset.jobText).toBe('Play');
            expect(player.paused).toBe(true);
            expect(s.rafCount()).toBe(0);

            // Re-enabling Repeat after a natural one-shot end replays the same public seek accumulation.
            repeat.checked = false;
            repeat.dispatchEvent({type: 'change'});
            play.click();
            s.stepRaf(0);
            for (let i = 0; i < 11; i++) s.stepRaf(100);
            expect(clock.value).toBe('1');
            repeat.checked = true;
            repeat.dispatchEvent({type: 'change'});
            expect(player.time).toBe(1 + residue);
            expect(player.entry(0)!.animationTime).toBe(residue);
            expect(clock.value).toBe('0');
            s.stepRaf(100);
            s.stepRaf(100);
            expect(clock.value).toBe('0');
            expect(player.entry(0)!.animationTime).toBe(residue);
            expect(player.paused).toBe(true);
            expect(play.getAttribute('aria-pressed')).toBe('false');
            expect(play.dataset.jobText).toBe('Play');
            const form = s.workspace.querySelector(`form[data-job-ask="${ask.askId}"]`)!;
            form.querySelector('select[name="verdict"]')!.value = 'approved';
            form.querySelector('textarea[name="note"]')!.value = 'raw boundary capture';
            form.dispatchEvent({type: 'input'});
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.outgoingSubmits[0]!.body.capture.frame).toBe(residue);
            expect(s.outgoingSubmits[0]!.body.capture.playing).toBe(false);
            expect(player.entry(0)!.animationTime).toBe(residue);

            clock.value = '1';
            clock.dispatchEvent({type: 'change'});
            expect(clock.value).toBe('0');
            expect(player.entry(0)!.animationTime).toBe(residue);
            expect(player.time).toBe(1 + residue);

            for (const value of ['0.123456789012345', String(residue), '0.999999999999999']) {
                clock.value = value;
                clock.dispatchEvent({type: 'change'});
                expect(clock.value).toBe(value);
                expect(Number(clock.value)).toBe(player.entry(0)!.animationTime);
                play.click();
                expect(clock.value).toBe(value);
                play.click();
                repeat.checked = false;
                repeat.dispatchEvent({type: 'change'});
                expect(clock.value).toBe(value);
                repeat.checked = true;
                repeat.dispatchEvent({type: 'change'});
                expect(clock.value).toBe(value);
            }
            animationSelect.value = '';
            animationSelect.dispatchEvent({type: 'change'});
            clock.value = String(residue);
            clock.dispatchEvent({type: 'change'});
            expect(clock.value).toBe(String(residue));
        } finally {
            s.cleanup();
        }
    });

    test('#559 runtime mid-play verdict capture without pause and byte-exact first request across motion, seek, play/pause, loop, camera, and part selection', async () => {
        const s = await mountRuntimeSession();
        try {
            const act = fixtureAct('review-verdict', '  원문 그대로\n');
            if (act.schema !== 'rig-review/act@2' || act.kind !== 'review-verdict' || act.value.stage !== 'rig-review') {
                throw new Error('Expected review-verdict fixture act');
            }
            const display = await s.publishRig(1);
            const source = display.publication.source;
            if (source.subject === 'image-set' || source.selector?.kind !== 'rig' || !source.model) {
                throw new Error('Expected rig model source');
            }
            const ask = {
                askId: act.askId,
                publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(ask, 2);
            s.window.event(s.fixture.events.at(-1)!);
            s.fixture.returnAct({
                ...act,
                publicationId: display.publication.publicationId,
                source: {...source, selector: source.selector, model: source.model},
                value: act.value,
            });

            const animationSelect = s.workspace.querySelector('#job-animation')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const player = s.activePlayer();

            const playButton = s.workspace.querySelector('#job-play')!;
            const loopInput = s.workspace.querySelector('#job-loop')!;
            expect(playButton).not.toBeNull();
            expect(loopInput).not.toBeNull();
            playButton.click();

            // Step across loop seam (0.6s unwrapped -> 0.1s wrapped visible animationTime):
            s.stepRaf(0);
            for (let i = 0; i < 6; i++) s.stepRaf(100);
            expect(player.time).toBeCloseTo(0.6, 5);
            expect(player.entry(0)?.animationTime).toBeCloseTo(0.1, 5);
            expect(player.paused).toBe(false);

            const form = s.workspace.querySelector(`form[data-job-ask="${ask.askId}"]`)!;
            const verdictSelect = form.querySelector('select[name="verdict"]')!;
            const noteInput = form.querySelector('textarea[name="note"]')!;
            verdictSelect.value = 'approved';
            noteInput.value = '  원문 그대로\n';
            form.dispatchEvent({type: 'input'});

            // First submit loses reply in transport while playback is active:
            const pausesBeforeCapture = player.counts().pauseCalls;
            s.failNextTransportSubmit();
            await form.onsubmit?.({preventDefault() {}});
            expect(player.counts().pauseCalls).toBe(pausesBeforeCapture); // No pause() during mid-play capture
            expect(player.paused).toBe(false);
            expect(s.rafCount()).toBe(1);
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.fixture.submissions).toHaveLength(0);
            const firstAttempt = s.outgoingSubmits[0]!;
            expect(firstAttempt.body.value.words).toBe('  원문 그대로\n');
            expect(firstAttempt.body.capture.playing).toBe(true);
            expect(firstAttempt.body.capture.animation).toBe('inspect');
            expect(firstAttempt.body.capture.frame).toBeCloseTo(0.1, 5);
            expect(typeof firstAttempt.body.capture.png).toBe('string');
            expect(firstAttempt.body.capture.png.length).toBeGreaterThan(0);
            expect(typeof firstAttempt.body.displayedNonce).toBe('string');
            expect(typeof firstAttempt.body.submissionId).toBe('string');
            expect(firstAttempt.body.expectedGeneration).toBe(2);

            // While form is unchanged, advance natural motion, manual seek, play/pause, toggle loop, pan/zoom camera, and select part:
            s.stepRaf(100);
            const timeInput = s.workspace.querySelector('#job-time')!;
            timeInput.value = '0.25';
            timeInput.dispatchEvent({type: 'change'});
            expect(player.paused).toBe(true);
            expect(s.rafCount()).toBe(0);
            playButton.click();
            expect(player.paused).toBe(false);
            playButton.click();
            expect(player.paused).toBe(true);
            loopInput.checked = false;
            loopInput.dispatchEvent({type: 'change'});
            s.workspace.querySelector('#zoom-in')!.click();
            const partSelect = s.workspace.querySelector('#job-part')!;
            partSelect.value = 'body';
            partSelect.dispatchEvent({type: 'change'});

            // Retry submit with unchanged form: must send byte-exact first mid-loop request without re-evaluating view guards:
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(2);
            const retryAttempt = s.outgoingSubmits[1]!;
            expect(retryAttempt.raw).toBe(firstAttempt.raw);
            expect(retryAttempt.body).toEqual(firstAttempt.body);
            expect(retryAttempt.body.capture.png).toBe(firstAttempt.body.capture.png);
            expect(retryAttempt.body.value.words).toBe(firstAttempt.body.value.words);
            expect(retryAttempt.body.displayedNonce).toBe(firstAttempt.body.displayedNonce);
            expect(retryAttempt.body.submissionId).toBe(firstAttempt.body.submissionId);
            expect(retryAttempt.body.expectedGeneration).toBe(firstAttempt.body.expectedGeneration);
            expect(s.fixture.submissions).toHaveLength(1);
            const committed = s.fixture.submissions[0]!.body as any;
            expect(committed).toEqual(firstAttempt.body);
        } finally {
            s.cleanup();
        }
    });

    test('#559 runtime cleanup and replacement ownership: source swap preserves compatible navigation, stale rAF never pauses replacement player, and hidden-hub/pagehide/unmount stop playback', async () => {
        const incarnation = '12345678-1234-1234-1234-123456789abc';
        const s = await mountRuntimeSession({hub: incarnation, visible: true});
        try {
            const first = await s.publishRig(1);
            const animationSelect = s.workspace.querySelector('#job-animation')!;
            const timeInput = s.workspace.querySelector('#job-time')!;
            const partSelect = s.workspace.querySelector('#job-part')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            timeInput.value = '0.25';
            timeInput.dispatchEvent({type: 'change'});
            partSelect.value = 'body';
            partSelect.dispatchEvent({type: 'change'});
            const player1 = s.activePlayer();
            expect(player1.current).toBe('inspect');
            expect(player1.time).toBeCloseTo(0.25, 5);
            expect(player1.paused).toBe(true);

            const playButton = s.workspace.querySelector('#job-play')!;
            expect(playButton).not.toBeNull();
            playButton.click();
            expect(player1.paused).toBe(false);
            expect(s.rafCount()).toBe(1);
            const staleCallbacks = s.captureRafCallbacks();
            expect(staleCallbacks).toHaveLength(1);

            // Replace source with compatible publication 2: stops rAF on outgoing player while preserving compatible navigation:
            const second = await s.publishRig(2);
            const player2 = s.activePlayer();
            expect(player1.disposed).toBe(true);
            expect(s.rafCount()).toBe(0);
            expect(s.workspace.querySelector('#job-animation')!.value).toBe('inspect');
            expect(Number(s.workspace.querySelector('#job-time')!.value)).toBeCloseTo(0.25, 5);
            expect(s.workspace.querySelector('#job-part')!.value).toBe('body');
            expect(player2.current).toBe('inspect');
            expect(player2.paused).toBe(true);

            // Start playback on replacement player2, then invoke the stale rAF callback from player1:
            s.workspace.querySelector('#job-play')!.click();
            expect(player2.paused).toBe(false);
            const pausesOnPlayer2 = player2.counts().pauseCalls;
            const advancesOnPlayer2 = player2.counts().advanceCalls;
            staleCallbacks[0]!(2000);
            expect(player2.paused).toBe(false);
            expect(player2.counts().pauseCalls).toBe(pausesOnPlayer2);
            expect(player2.counts().advanceCalls).toBe(advancesOnPlayer2);
            expect(s.rafCount()).toBe(1);

            // Hidden hub message cancels rAF and pauses player2:
            s.emitGlobal('message', {
                origin: 'http://127.0.0.1:4318',
                source: s.parentWindow,
                data: {
                    schema: JOB_HUB_VISIBILITY,
                    incarnation,
                    jobId: s.fixture.jobId,
                    publicationId: second.publication.publicationId,
                    sourceHash: second.publication.source.sourceHash,
                    visible: false,
                    language: 'en',
                },
            });
            expect(player2.paused).toBe(true);
            expect(s.rafCount()).toBe(0);

            // Restore hub visibility, resume play, advance motion, and deliver explicit standing-job close event through createJobWindow:
            s.emitGlobal('message', {
                origin: 'http://127.0.0.1:4318',
                source: s.parentWindow,
                data: {
                    schema: JOB_HUB_VISIBILITY,
                    incarnation,
                    jobId: s.fixture.jobId,
                    publicationId: second.publication.publicationId,
                    sourceHash: second.publication.source.sourceHash,
                    visible: true,
                    language: 'en',
                },
            });
            const play2 = s.workspace.querySelector('#job-play')!;
            const time2 = s.workspace.querySelector('#job-time')!;
            play2.click();
            expect(player2.paused).toBe(false);
            expect(s.rafCount()).toBe(1);
            s.stepRaf(0);
            s.stepRaf(100);
            const timeAtClose = player2.time;
            expect(timeAtClose).toBeGreaterThan(0);
            s.fixture.close(3);
            s.window.event(s.fixture.events.at(-1)!);
            expect(s.window.state().closed).toBe(true);
            expect(player2.paused).toBe(true);
            expect(s.rafCount()).toBe(0);
            expect(play2.dataset.jobText).toBe('Play');
            expect(play2.getAttribute('aria-pressed')).toBe('false');
            s.stepRaf(100);
            expect(player2.time).toBeCloseTo(timeAtClose, 5);
            expect(Number(time2.value)).toBeCloseTo(timeAtClose, 5);
            expect(player2.disposed).toBe(false);

            // Resume play on the retained read-only view and verify pagehide stops rAF and pauses/disposes player2:
            play2.click();
            expect(player2.paused).toBe(false);
            expect(s.rafCount()).toBe(1);
            s.emitGlobal('pagehide');
            expect(player2.paused).toBe(true);
            expect(s.rafCount()).toBe(0);
        } finally {
            s.cleanup();
        }
    });

    test('#559 runtime animation replacement while playing: switching clip or Setup cancels owned rAF, resets time to 0, and pauses without autoplay', async () => {
        const s = await mountRuntimeSession({
            clips: [
                {name: 'inspect', duration: 0.5},
                {name: 'second', duration: 0.75},
            ],
        });
        try {
            await s.publishRig(1);
            const animationSelect = s.workspace.querySelector('#job-animation')!;
            const timeInput = s.workspace.querySelector('#job-time')!;
            const playButton = s.workspace.querySelector('#job-play')!;

            // Select 'inspect' and start continuous playback:
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            playButton.click();
            expect(s.activePlayer().current).toBe('inspect');
            expect(s.activePlayer().paused).toBe(false);
            expect(s.rafCount()).toBe(1);

            // Advance 'inspect' motion so visible time > 0:
            s.stepRaf(0);
            s.stepRaf(200);
            expect(s.activePlayer().time).toBeGreaterThan(0);
            expect(Number(timeInput.value)).toBeGreaterThan(0);
            expect(s.rafCount()).toBe(1);
            expect(playButton.dataset.jobText).toBe('Pause');
            expect(playButton.getAttribute('aria-pressed')).toBe('true');

            // While 'inspect' is playing with one rAF, switch animation select to 'second':
            animationSelect.value = 'second';
            animationSelect.dispatchEvent({type: 'change'});
            const playerOnSecond = s.activePlayer();
            expect(s.rafCount()).toBe(0);
            expect(animationSelect.value).toBe('second');
            expect(timeInput.value).toBe('0');
            expect(playerOnSecond.current).toBe('second');
            expect(playerOnSecond.time).toBe(0);
            expect(playerOnSecond.entry(0)?.animation).toBe('second');
            expect(playerOnSecond.entry(0)?.animationTime).toBe(0);
            expect(playerOnSecond.paused).toBe(true);
            expect(playButton.disabled).toBe(false);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');

            // Verify old motion does not advance across subsequent rAF steps while paused on 'second':
            s.stepRaf(200);
            expect(s.rafCount()).toBe(0);
            expect(playerOnSecond.time).toBe(0);
            expect(timeInput.value).toBe('0');

            // Resume playback on 'second' and advance motion:
            playButton.click();
            expect(playerOnSecond.paused).toBe(false);
            expect(s.rafCount()).toBe(1);
            expect(playButton.dataset.jobText).toBe('Pause');
            expect(playButton.getAttribute('aria-pressed')).toBe('true');
            s.stepRaf(0);
            s.stepRaf(200);
            expect(playerOnSecond.time).toBeGreaterThan(0);
            expect(Number(timeInput.value)).toBeGreaterThan(0);
            expect(s.rafCount()).toBe(1);

            // While 'second' is playing, switch animation select back to Setup (''):
            animationSelect.value = '';
            animationSelect.dispatchEvent({type: 'change'});
            const playerOnSetup = s.activePlayer();
            expect(s.rafCount()).toBe(0);
            expect(animationSelect.value).toBe('');
            expect(timeInput.value).toBe('0');
            expect(playerOnSetup.current).toBeNull();
            expect(playerOnSetup.paused).toBe(true);
            expect(playerOnSetup.time).toBe(0);
            expect(playButton.disabled).toBe(true);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');

            // Verify no autoplay across subsequent rAF steps on Setup:
            s.stepRaf(200);
            expect(s.rafCount()).toBe(0);
            expect(playerOnSetup.current).toBeNull();
            expect(playerOnSetup.time).toBe(0);
            expect(timeInput.value).toBe('0');
        } finally {
            s.cleanup();
        }
    });

    test('#559 runtime time input while playing: typing into #job-time pauses owned rAF without overwriting typed text or resetting rigSubmission, and commits seek on change', async () => {
        const s = await mountRuntimeSession();
        try {
            const act = fixtureAct('review-verdict', 'check time input while playing');
            if (act.schema !== 'rig-review/act@2' || act.kind !== 'review-verdict' || act.value.stage !== 'rig-review') {
                throw new Error('Expected review-verdict fixture act');
            }
            const display = await s.publishRig(1);
            const source = display.publication.source;
            if (source.subject === 'image-set' || source.selector?.kind !== 'rig' || !source.model) {
                throw new Error('Expected rig model source');
            }
            const ask = {
                askId: act.askId,
                publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(ask, 2);
            s.window.event(s.fixture.events.at(-1)!);
            s.fixture.returnAct({
                ...act,
                publicationId: display.publication.publicationId,
                source: {...source, selector: source.selector, model: source.model},
                value: act.value,
            });

            const animationSelect = s.workspace.querySelector('#job-animation')!;
            const timeInput = s.workspace.querySelector('#job-time')!;
            const playButton = s.workspace.querySelector('#job-play')!;
            const form = s.workspace.querySelector(`form[data-job-ask="${ask.askId}"]`)!;
            const verdictSelect = form.querySelector('select[name="verdict"]')!;
            const noteInput = form.querySelector('textarea[name="note"]')!;

            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            playButton.click();
            expect(s.activePlayer().paused).toBe(false);
            expect(s.rafCount()).toBe(1);

            s.stepRaf(0);
            s.stepRaf(100);
            const pausedFrameTime = s.activePlayer().time;
            expect(pausedFrameTime).toBeCloseTo(0.1, 5);
            expect(Number(timeInput.value)).toBeCloseTo(0.1, 5);

            // Stage a failed submit so entry.rigSubmission holds an immutable first request:
            verdictSelect.value = 'approved';
            noteInput.value = 'check time input while playing';
            form.dispatchEvent({type: 'input'});
            s.failNextTransportSubmit();
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(1);
            const firstAttempt = s.outgoingSubmits[0]!;

            // User starts typing '0.375' into #job-time without change/blur:
            timeInput.value = '0.375';
            timeInput.dispatchEvent({type: 'input'});

            // Stepping mock rAF must NOT overwrite #job-time.value, and playback must already be paused:
            s.stepRaf(100);
            s.stepRaf(100);
            expect(timeInput.value).toBe('0.375');
            expect(s.rafCount()).toBe(0);
            expect(s.activePlayer().paused).toBe(true);
            expect(playButton.dataset.jobText).toBe('Play');
            expect(playButton.getAttribute('aria-pressed')).toBe('false');
            // Uncommitted input must not seek player before change:
            expect(s.activePlayer().time).toBeCloseTo(pausedFrameTime, 5);

            // Typing into #job-time must not reset entry.rigSubmission when form inputs are unchanged:
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(2);
            expect(s.outgoingSubmits[1]!.raw).toBe(firstAttempt.raw);

            // Committing #job-time via change seeks the paused player to 0.375:
            timeInput.dispatchEvent({type: 'change'});
            expect(timeInput.value).toBe('0.375');
            expect(s.activePlayer().time).toBeCloseTo(0.375, 5);
            expect(s.activePlayer().paused).toBe(true);
            expect(s.rafCount()).toBe(0);

            // Active-animation manual seek at exact duration (0.5) under Repeat=true synchronizes UI #job-time, public entry(0).animationTime and captured frame to 0:
            const loopCheckbox = s.workspace.querySelector('#job-loop')!;
            expect(loopCheckbox.checked).toBe(true);
            timeInput.value = '0.5';
            timeInput.dispatchEvent({type: 'change'});
            expect(s.activePlayer().entry(0)?.animationTime).toBe(0);
            expect(timeInput.value).toBe('0');
            expect(Number(timeInput.value)).toBe(s.activePlayer().entry(0)!.animationTime);
            expect(s.activePlayer().paused).toBe(true);
            expect(s.rafCount()).toBe(0);

            const askAtDuration = {
                askId: 'ask-seek-duration-loop',
                publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(askAtDuration, 3);
            s.window.event(s.fixture.events.at(-1)!);
            const formAtDuration = s.workspace.querySelector(`form[data-job-ask="${askAtDuration.askId}"]`)!;
            formAtDuration.querySelector('select[name="verdict"]')!.value = 'approved';
            formAtDuration.querySelector('textarea[name="note"]')!.value = 'seek duration under Repeat=true';
            formAtDuration.dispatchEvent({type: 'input'});
            s.failNextTransportSubmit();
            await formAtDuration.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(3);
            expect(s.outgoingSubmits[2]!.body.capture.frame).toBe(0);
            expect(s.outgoingSubmits[2]!.body.capture.animation).toBe('inspect');

            // Setup (animation === '') preserves reference-only time without wrapping:
            animationSelect.value = '';
            animationSelect.dispatchEvent({type: 'change'});
            timeInput.value = '1.25';
            timeInput.dispatchEvent({type: 'change'});
            expect(timeInput.value).toBe('1.25');
        } finally {
            s.cleanup();
        }
    });

    test('#606 shared plan text renders in checkpoint and record signoff forms with unchanged selects/drafts/words in EN/KO', async () => {
        const values = {does:'  <mark>literal</mark> 한글 e\u0301\r\n',produces:'',bar:' exact bar\n ',rests_on:['bones','bones','']};
        const record = {path:'project.json' as const,sha256:'a'.repeat(64)};
        const plan = {steps:[{id:'meshes',hash:'b'.repeat(64)}]};
        const projection: JobPlanTextProjection = {schema:'rig-review/job-plan-text@1',record,status:'projected',
            steps:[{...plan.steps[0]!,...values,issues:[]}]};
        const fixture = createJobWindowFixture();
        const store = new Map<string,string>();
        const words = '  exact owner 한글\n';
        let session: Awaited<ReturnType<typeof mountRuntimeSession>> | undefined;
        const preference = i18nModule.getLanguagePreference();
        try {
            session = await mountRuntimeSession({fixture,localStore:store,planText:projection});
            const display = fixturePublication();
            Object.assign(display.publication.source,{plan});
            await session.publishDisplay(display);
            const ask: PendingAskV3 = {askId:'plan-text-checkpoint',publicationId:display.publication.publicationId,
                source:display.publication.source,subject:{kind:'checkpoint',checkpointId:'alias',planStepId:'meshes'},status:'pending'};
            fixture.pending(ask,2);session.window.event(fixture.events.at(-1)!);
            const form = session.workspace.querySelector('form[data-job-ask="plan-text-checkpoint"]')!;
            for (const language of ['en','ko'] as const) {
                i18nModule.setLanguagePreference(language);
                expect(form.querySelector('[data-job-plan-field="does"]')!.textContent).toBe(values.does);
                expect(form.querySelector('[data-job-plan-field="produces"]')!.textContent).toBe('');
                expect(form.querySelector('[data-job-plan-field="bar"]')!.textContent).toBe(values.bar);
                expect(form.querySelector('[data-job-plan-field="rests_on"]')!.querySelectorAll('li').map(item=>item.textContent)).toEqual(values.rests_on);
                expect(form.querySelector('[data-job-text="job.plan.bar"]')!.textContent).toBe(i18nModule.t('job.plan.bar'));
                expect(form.querySelectorAll('mark')).toHaveLength(0);
            }
            const note = form.querySelector('textarea[name="note"]')!;
            const outcome = form.querySelector('select[name="outcome"]')!;
            expect(outcome.value).toBe('');
            note.value=words;outcome.value='fail';form.dispatchEvent({type:'input'});
            session.failNextTransportSubmit();await form.onsubmit?.({preventDefault(){}});
            expect(session.outgoingSubmits.at(-1)!.body.value).toEqual({checkpointId:'alias',outcome:'fail',words});
            session.cleanup();session=undefined;
            session=await mountRuntimeSession({fixture,localStore:store,planText:projection});
            await session.replayPublication(display);
            session.window.event(fixture.events.find(event=>event.type === 'pending')!);
            const restored=session.workspace.querySelector('form[data-job-ask="plan-text-checkpoint"]')!;
            expect(restored.querySelector('select[name="outcome"]')!.value).toBe('fail');
            expect(restored.querySelector('textarea[name="note"]')!.value).toBe(words);
            const recordDisplay: DisplayPublicationV3 = {...display,publication:{...display.publication,publicationId:'record-plan-text',generation:3,
                source:{sourceHash:'c'.repeat(64),projectHash:record.sha256,record,subject:'plan',selection:{kind:'plan'},
                    optionSet:null,optionSetFile:null,inputs:[],files:[record],plan,subjects:[{kind:'signoff',stage:'rigging-interview'}]}}};
            await session.publishDisplay(recordDisplay);
            const signoff: PendingAskV3={askId:'plan-text-signoff',publicationId:'record-plan-text',source:recordDisplay.publication.source,
                subject:{kind:'signoff',stage:'rigging-interview'},status:'pending'};
            fixture.pending(signoff,4);session.window.event(fixture.events.at(-1)!);
            expect(session.workspace.querySelector('[data-job-record="plan"]')!.textContent).toContain(values.bar);
            const signform=session.workspace.querySelector('form[data-job-ask="plan-text-signoff"]')!;
            expect(signform.textContent).toContain(values.does);
            signform.querySelector('textarea[name="note"]')!.value=words;
            session.failNextTransportSubmit();await signform.onsubmit?.({preventDefault(){}});
            expect(session.outgoingSubmits.at(-1)!.body.value).toEqual({stage:'rigging-interview',decision:'approved',words});
        } finally {session?.cleanup();i18nModule.setLanguagePreference(preference);}
    });

    test('#629 checkpoint gallery keeps 103 ordered scalar rows, EN/KO mapping, verbatim payload and reconnect draft', async () => {
        const root = await mkdtemp(join(tmpdir(), 'review629-dom-'));
        const evidence = syntheticCheckpointEvidence(root, 'motion-card', 'inspect-motion');
        const display = fixturePublication();
        Object.assign(display, {publication: {...display.publication, source: {...display.publication.source,
            plan: {steps: [{id: 'inspect-motion', hash: 'a'.repeat(64)}]}, checkpointEvidence: [evidence.packet]} as JobModelSourceBinding}});
        const fixture = createJobWindowFixture();
        const store = new Map<string, string>();
        const words = '  Pass 한글 <owner>\n원문\n';
        let session: Awaited<ReturnType<typeof mountRuntimeSession>> | undefined;
        try {
            session = await mountRuntimeSession({fixture, localStore: store, evidence});
            await session.publishDisplay(display);
            const ask: PendingAskV3 = {askId: 'evidence-checkpoint', publicationId: display.publication.publicationId,
                source: display.publication.source, subject: {kind: 'checkpoint', checkpointId: 'motion-card', planStepId: 'inspect-motion'}, status: 'pending'};
            fixture.pending(ask, 2); session.window.event(fixture.events.at(-1)!);
            const form = session.workspace.querySelector('form[data-job-ask="evidence-checkpoint"]')!;
            const section = form.querySelector('[data-job-checkpoint-evidence]')!;
            expect(section.querySelectorAll('figure').map(figure => figure.querySelector('h3')!.textContent))
                .toEqual(evidence.packet.tiles.map(tile => tile.label));
            expect(section.querySelectorAll('th').map(cell => cell.textContent)).toEqual([...evidence.table.columns]);
            expect(section.querySelectorAll('tbody')[0]!.querySelectorAll('tr').map(row => row.querySelectorAll('td').map(cell => cell.textContent)))
                .toEqual(evidence.table.rows.map(row => row.map(String)));
            expect(section.querySelectorAll('script')).toHaveLength(0);
            expect(section.querySelectorAll('pre').map(block => block.textContent)).toEqual([evidence.packet.routesText, evidence.packet.recommendationText]);
            const note = form.querySelector('textarea[name="note"]')!;
            const outcome = form.querySelector('select[name="outcome"]')!;
            note.value = words; outcome.value = 'fail'; form.dispatchEvent({type: 'input'});
            for (const lang of ['en', 'ko'] as const) {
                i18nModule.setLanguagePreference(lang);
                const catalog = lang === 'ko' ? koCatalog : enCatalog;
                expect(form.querySelector('[data-job-text="job.checkpointRouteMapping"]')!.textContent).toBe(catalog['job.checkpointRouteMapping']);
                expect(section.querySelector('[data-job-text="job.checkpointRecommendation"]')!.textContent).toBe(catalog['job.checkpointRecommendation']);
                expect(note.value).toBe(words);
                expect(section.querySelectorAll('pre').map(block => block.textContent)).toEqual([evidence.packet.routesText, evidence.packet.recommendationText]);
            }
            for (const value of ['pass', 'fail']) {
                outcome.value = value; form.dispatchEvent({type: 'input'});
                session.failNextTransportSubmit();
                await form.onsubmit?.({preventDefault() {}});
                expect(session.outgoingSubmits.at(-1)!.body.value).toEqual({checkpointId: 'motion-card', outcome: value, words});
                expect(session.outgoingSubmits.at(-1)!.body.value).not.toHaveProperty('planStepId');
            }
            session.cleanup(); session = undefined;
            session = await mountRuntimeSession({fixture, localStore: store, evidence});
            await session.replayPublication(display);
            session.window.event(fixture.events.find(event => event.type === 'pending')!);
            const restored = session.workspace.querySelector('form[data-job-ask="evidence-checkpoint"]')!;
            expect(restored.querySelector('textarea[name="note"]')!.value).toBe(words);
            expect(restored.querySelector('select[name="outcome"]')!.value).toBe('fail');
            expect(restored.querySelectorAll('tbody')[0]!.querySelectorAll('tr')).toHaveLength(103);
        } finally {
            session?.cleanup(); i18nModule.setLanguagePreference('en');
            await rm(root, {recursive: true, force: true});
        }
    });

    test('#629 absent evidence keeps legacy checkpoint controls and refuses a mismatched admitted plan mapping', async () => {
        const root = await mkdtemp(join(tmpdir(), 'review629-map-'));
        const evidence = syntheticCheckpointEvidence(root, 'motion-card', 'inspect-motion');
        for (const present of [false, true]) {
            const session = await mountRuntimeSession(present ? {evidence} : undefined);
            try {
                const display = fixturePublication();
                Object.assign(display, {publication: {...display.publication, source: {...display.publication.source,
                    plan: {steps: [{id: 'inspect-motion', hash: 'a'.repeat(64)}, {id: 'other', hash: 'b'.repeat(64)}]},
                    ...(present ? {checkpointEvidence: [evidence.packet]} : {})} as JobModelSourceBinding}});
                await session.publishDisplay(display);
                const ask: PendingAskV3 = {askId: 'mapping-check', publicationId: display.publication.publicationId,
                    source: display.publication.source, subject: {kind: 'checkpoint', checkpointId: 'motion-card',
                        planStepId: present ? 'other' : 'inspect-motion'}, status: 'pending'};
                session.fixture.pending(ask, 2); session.window.event(session.fixture.events.at(-1)!);
                expect(session.workspace.querySelector('[data-job-checkpoint-evidence]')).toBeNull();
                expect(session.workspace.querySelector('[data-job-text="job.checkpointRouteMapping"]')).toBeNull();
                if (present) expect(session.workspace.textContent).toContain('CHECKPOINT_EVIDENCE_INVALID');
                else expect(session.workspace.querySelector('select[name="outcome"]')).not.toBeNull();
            } finally {session.cleanup();}
        }
        await rm(root, {recursive: true, force: true});
    });

    test('#586 runtime reopen form renders declared reopen stage on an independently prepared PlanSource, submits {stage, words} with verbatim words to return reopen act@4, and refuses undeclared or package-only reopen asks', async () => {
        const s = await mountRuntimeSession();
        try {
            // 1. Package-only publication remains completely immutable and refuses a reopen ask with JOB_ASK_INVALID
            const pkgDisplay = await s.publishRig(1);
            const immutablePkgSourceSnapshot = structuredClone(pkgDisplay.publication.source);
            const packageReopenAsk: PendingAskV3 = {
                askId: 'ask-reopen-package',
                publicationId: pkgDisplay.publication.publicationId,
                subject: { kind: 'reopen', stage: 'plan-approved' },
                source: pkgDisplay.publication.source,
                status: 'pending',
            };
            s.fixture.pending(packageReopenAsk, 2);
            s.window.event(s.fixture.events.at(-1)!);
            expect(s.workspace.querySelector('form[data-job-ask="ask-reopen-package"]')).toBeNull();
            expect(pkgDisplay.publication.source).toEqual(immutablePkgSourceSnapshot);

            // 2. Independently prepare a valid PlanSource (validated via parseRecordPublishedContext + buildRecordSource + parseRecordSource)
            const recordIdentity = { path: 'project.json' as const, sha256: '1'.repeat(64) };
            const inputFile = { path: 'inputs/painting.png', sha256: '2'.repeat(64) };
            const planSelection = { kind: 'plan' as const };
            const planContext = parseRecordPublishedContext(
                {
                    label: 'Plan record — reopen inspection',
                    parts: {
                        name: '@rig-c/parts',
                        version: '2.25.1',
                        integrity: 'sha512-synthetic-parts-lock-integrity',
                    },
                    inputs: [inputFile],
                    files: [inputFile, recordIdentity],
                    plan: {
                        steps: [{ id: 'step_layout', hash: '3'.repeat(64) }],
                    },
                    subjects: [
                        { kind: 'checkpoint', checkpointId: 'step_layout' },
                        { kind: 'signoff', stage: 'plan-approved' },
                        { kind: 'reopen', stage: 'plan-approved' },
                        { kind: 'reopen', stage: 'design-interview' },
                    ],
                },
                planSelection,
                recordIdentity,
            );
            const planSource = parseRecordSource(
                buildRecordSource({
                    record: recordIdentity,
                    selection: planSelection,
                    context: planContext,
                }),
            );
            if (planSource.subject !== 'plan') {
                throw new Error('Expected validated PlanSource');
            }
            const instanceKey = recordInstanceKey('fp-window-reopen-plan', planSource.sourceHash);
            const recordPublicationId = 'publication-record-plan-2';
            const entryRoute = `/jobs/${s.fixture.jobId}/publications/${recordPublicationId}/instances/${instanceKey}/`;
            const recordDisplay: DisplayPublicationV3 = {
                publication: {
                    publicationId: recordPublicationId,
                    instanceKey,
                    generation: 3,
                    source: planSource,
                    label: planContext.label,
                    previousPublicationId: pkgDisplay.publication.publicationId,
                    visual: { status: 'available' },
                },
                routes: {
                    entry: entryRoute,
                    apiBase: `${entryRoute}api/`,
                    assetsBase: `${entryRoute}assets/`,
                },
            };
            await s.publishDisplay(recordDisplay);
            expect(s.window.state().displayed?.publication.publicationId).toBe(recordPublicationId);
            expect(s.window.state().displayed?.publication.source).toEqual(planSource);
            expect(pkgDisplay.publication.source).toEqual(immutablePkgSourceSnapshot);

            // 3. Declared reopen stage renders form with job.reopen submit button, submits exact {stage, words}, and receives validated reopen RecordAct (rig-review/act@4)
            const reopenAsk: PendingAskV3 = {
                askId: 'ask-reopen-declared',
                publicationId: recordPublicationId,
                subject: { kind: 'reopen', stage: 'plan-approved' },
                source: planSource,
                status: 'pending',
            };
            s.fixture.pending(reopenAsk, 4);
            s.window.event(s.fixture.events.at(-1)!);

            const form = s.workspace.querySelector('form[data-job-ask="ask-reopen-declared"]')!;
            expect(form).not.toBeNull();
            const submitButton = form.querySelector('button[type="submit"]')!;
            expect(submitButton.dataset.jobText).toBe('job.reopen');
            expect(submitButton.textContent).toBe(t('job.reopen'));

            const verbatimWords = '  reopen stage with verbatim spaces\n';
            const noteInput = form.querySelector('textarea[name="note"]')!;
            noteInput.value = verbatimWords;
            form.dispatchEvent({ type: 'input' });

            const expectedReopenAct: RecordAct = parseRecordAct({
                schema: JOB_RECORD_ACT_SCHEMA,
                actId: 'act-reopen-declared-1',
                jobId: s.fixture.jobId,
                askId: reopenAsk.askId,
                publicationId: recordPublicationId,
                kind: 'reopen',
                authority: {
                    actor: 'human',
                    channel: 'review-ui',
                    reviewer: { id: 'declared-owner', role: 'owner' },
                },
                at: '2026-11-09T10:00:00.000Z',
                source: planSource,
                value: {
                    stage: 'plan-approved',
                    words: verbatimWords,
                },
            });
            s.fixture.returnAct(expectedReopenAct);
            await form.onsubmit?.({ preventDefault() {} });
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.outgoingSubmits[0]!.body).toMatchObject({
                publicationId: recordPublicationId,
                askId: 'ask-reopen-declared',
                kind: 'reopen',
                value: {
                    stage: 'plan-approved',
                    words: verbatimWords,
                },
            });
            expect(s.outgoingSubmits[0]!.body).not.toHaveProperty('capture');
            const statusNode = form.querySelector('[role="status"]')!;
            expect(statusNode.dataset.jobText).toBe('job.saved');

            // 4. Undeclared reopen stage on the same PlanSource refuses with JOB_ASK_INVALID and does not mount a form
            const undeclaredAsk: PendingAskV3 = {
                askId: 'ask-reopen-undeclared',
                publicationId: recordPublicationId,
                subject: { kind: 'reopen', stage: 'post-interview' },
                source: planSource,
                status: 'pending',
            };
            s.fixture.pending(undeclaredAsk, 5);
            s.window.event(s.fixture.events.at(-1)!);
            expect(s.workspace.querySelector('form[data-job-ask="ask-reopen-undeclared"]')).toBeNull();
        } finally {
            s.cleanup();
        }
    });

    test('#555 runtime standing interview diagnostics render read-only history/issues, show non-blocking INTERVIEW_OPTIONS_SCENE_LEGACY on editable picks, and refuse mismatched publication.interview', async () => {
        const setSha = 'b'.repeat(64);
        const histSha = 'd'.repeat(64);
        const interviewEnvelope = {
            schema: 'rig-review/job-interview@1' as const,
            project: {path: 'project.json', sha256: 'e'.repeat(64)},
            evaluatedAt: '2026-11-08T12:00:10.000Z',
            records: [
                {
                    questionId: 'post_composition',
                    record: 'interview.post.items[2].pending_options',
                    setId: 'review551-scene-current',
                    ref: {path: 'evidence/interview/review551-scene-current.json', sha256: setSha},
                    observedSet: {path: 'evidence/interview/review551-scene-current.json', sha256: setSha},
                    timeKind: 'inspection' as const,
                    at: '2026-11-08T12:00:10.000Z',
                    original: null,
                },
                {
                    questionId: 'post_composition',
                    record: 'interview.post.items[2].history[0]',
                    setId: 'review551-scene-old',
                    ref: {path: 'evidence/interview/old.json', sha256: histSha},
                    observedSet: {path: 'evidence/interview/old.json', sha256: histSha},
                    timeKind: 'answer' as const,
                    at: '2026-11-06T01:00:00.000Z',
                    original: {
                        by: 'human',
                        at: '2026-11-06T01:00:00.000Z',
                        source: 'review',
                        verbatim: '이전 장면 답변 원문\nsecond line',
                    },
                },
            ],
            diagnostics: [
                {
                    record: 'interview.post.items[2].pending_options',
                    at: '2026-11-08T12:00:10.000Z',
                    code: 'INTERVIEW_OPTIONS_SCENE_LEGACY' as const,
                    severity: 'warning' as const,
                },
                {
                    record: 'interview.post.items[2].history[0]',
                    at: '2026-11-06T01:00:00.000Z',
                    code: 'INTERVIEW_OPTIONS_STALE' as const,
                    severity: 'error' as const,
                },
            ],
        };
        const s = await mountRuntimeSession({
            interview: {
                questions: [
                    {
                        ref: {path: 'evidence/interview/review551-scene-current.json', sha256: setSha},
                        editable: true,
                        hasParts: false,
                        images: [],
                        set: {
                            id: 'review551-scene-current',
                            stage: 'post-interview',
                            question: 'post_composition',
                            drafted_by: 'agent',
                            drafted_at: '2026-11-07T23:59:59.000Z',
                            assembly: {rule: 'single'},
                            asks: [
                                {
                                    id: 'framing',
                                    prompt: 'Choose composition',
                                    options: [
                                        {id: 'keep', kind: 'value', label: 'Keep', effect: 'Retain composition', recommended: true},
                                        {id: 'other', kind: 'other', label: 'Other', effect: 'Custom note', recommended: false},
                                    ],
                                },
                            ],
                        },
                    },
                ],
                interview: interviewEnvelope,
            },
        });
        try {
            const display = await s.publishRig(1, {
                optionSet: {id: 'review551-scene-current', sha256: setSha},
                interview: interviewEnvelope,
            });
            const diagSection = s.workspace.querySelector('[data-job-interview-diagnostics]')!;
            expect(diagSection).not.toBeNull();
            expect(diagSection.hidden).toBe(false);
            expect(diagSection.querySelectorAll('[data-job-interview-diagnostic]')).toHaveLength(2);
            expect(diagSection.querySelectorAll('[data-job-interview-record]')).toHaveLength(1);
            expect(diagSection.textContent).toContain('이전 장면 답변 원문');
            expect(diagSection.querySelectorAll('input,select,textarea,button,form')).toHaveLength(0);

            const source = display.publication.source;
            if (source.subject === 'image-set') throw new Error('Expected model source');
            const ask = {
                askId: 'ask-scene-legacy-picks',
                publicationId: display.publication.publicationId,
                subject: {kind: 'interview-picks' as const, questionId: 'post_composition', setId: 'review551-scene-current'},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(ask, 2);
            s.window.event(s.fixture.events.at(-1)!);
            const act = fixtureAct('interview-picks', 'legacy non-blocking note');
            if (act.kind !== 'interview-picks') throw new Error('Expected interview-picks act');
            s.fixture.returnAct({
                ...act,
                askId: ask.askId,
                publicationId: display.publication.publicationId,
                source: {...source, optionSet: {id: 'review551-scene-current', sha256: setSha}},
            });
            const form = s.workspace.querySelector(`form[data-job-ask="${ask.askId}"]`)!;
            expect(form).not.toBeNull();
            const warning = form.querySelector('[data-job-interview-warning="INTERVIEW_OPTIONS_SCENE_LEGACY"]')!;
            expect(warning).not.toBeNull();
            expect(warning.dataset.record).toBe('interview.post.items[2].pending_options');
            const pickSelect = form.querySelector('select[name="choice.framing"]')!;
            const noteInput = form.querySelector('textarea[name="note"]')!;
            pickSelect.value = 'keep';
            pickSelect.dispatchEvent({type: 'change'});
            noteInput.value = 'legacy non-blocking note';
            form.dispatchEvent({type: 'input'});
            await form.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.outgoingSubmits[0]!.body.kind).toBe('interview-picks');
            expect(s.outgoingSubmits[0]!.body.value).toEqual({
                questionId: 'post_composition',
                selections: [{itemId: 'framing', optionId: 'keep', otherText: null}],
                note: 'legacy non-blocking note',
            });

            // Mismatched publication.interview between event and readPublication refuses with JOB_DISPLAY_MISMATCH:
            const mismatched = fixturePublication(2);
            s.fixture.publish({...mismatched, publication: {...mismatched.publication, interview: null}});
            s.window.event({
                type: 'published',
                jobId: s.fixture.jobId,
                cursor: 'mismatch-cursor',
                generation: 3,
                publication: {...mismatched.publication, interview: interviewEnvelope},
            });
            await s.window.settled();
            expect(s.window.state().error).toBe('JOB_DISPLAY_MISMATCH');
            expect(s.window.state().displayed?.publication.publicationId).toBe(display.publication.publicationId);
        } finally {
            s.cleanup();
        }
    });

    test('#484 standing window in-place updates: preserves source-bound drafts, explicit changed-version notice, camera/time/part/panel state, and compatibility fallback', async () => {
        const s = await mountRuntimeSession({
            clipsFor: display => display.publication.publicationId === 'publication-3'
                ? [{name: 'inspect', duration: 0.1}]
                : [{name: 'inspect', duration: 0.5}],
            slotsFor: display => display.publication.publicationId === 'publication-3'
                ? ['head']
                : ['body', 'head'],
            referencesFor: () => [
                {id: 'ref-1', label: 'Ref 1'},
                {id: 'ref-2', label: 'Ref 2'},
            ],
        });
        try {
            const first = await s.publishRig(1);
            const firstSource = first.publication.source;
            if (firstSource.subject === 'image-set') throw new Error('Expected model source');
            const ask1 = {
                askId: 'ask-rig-1',
                publicationId: first.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source: firstSource,
                status: 'pending' as const,
            };
            s.fixture.pending(ask1, 2);
            s.window.event(s.fixture.events.at(-1)!);

            const notice = s.host.querySelector('.job-notice')!;
            expect(notice.textContent).toBe('Rig 1');

            // Configure camera, animation, time, loop, part + solo, reference, and panel on Rig 1:
            s.workspace.querySelector('#zoom-in')!.click();
            expect(s.workspace.querySelector('#zoom-value')!.textContent).toBe('125% · Rig');
            const animationSelect = s.workspace.querySelector('#job-animation')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const timeInput = s.workspace.querySelector('#job-time')!;
            timeInput.value = '0.25';
            timeInput.dispatchEvent({type: 'change'});
            const loopInput = s.workspace.querySelector('#job-loop')!;
            loopInput.checked = false;
            loopInput.dispatchEvent({type: 'change'});
            const partSelect = s.workspace.querySelector('#job-part')!;
            partSelect.value = 'body';
            partSelect.dispatchEvent({type: 'change'});
            const soloInput = s.workspace.querySelector('#job-solo')!;
            soloInput.checked = true;
            soloInput.dispatchEvent({type: 'change'});
            const refSelect = s.workspace.querySelector('#job-reference')!;
            refSelect.value = 'ref-2';
            refSelect.dispatchEvent({type: 'change'});
            await Bun.sleep(1);
            expect(s.workspace.querySelector('[data-job-direction]')!.hidden).toBe(false);

            // Edit draft on Rig 1:
            const form1 = s.workspace.querySelector(`form[data-job-ask="${ask1.askId}"]`)!;
            form1.querySelector('select[name="verdict"]')!.value = 'changes-requested';
            form1.querySelector('textarea[name="note"]')!.value = '  keep rig 1 draft bound to source 1\n';
            form1.dispatchEvent({type: 'input'});

            // In-place update to compatible Rig 2:
            const second = await s.publishRig(2);
            expect(notice.textContent).toBe('Updated from Rig 1 to Rig 2.');
            expect(s.workspace.querySelector('#zoom-value')!.textContent).toBe('125% · Rig');
            expect(s.workspace.querySelector('#job-animation')!.value).toBe('inspect');
            expect(Number(s.workspace.querySelector('#job-time')!.value)).toBeCloseTo(0.25, 5);
            expect(s.workspace.querySelector('#job-loop')!.checked).toBe(false);
            expect(s.workspace.querySelector('#job-part')!.value).toBe('body');
            expect(s.workspace.querySelector('#job-solo')!.checked).toBe(true);
            expect(s.workspace.querySelector('#job-reference')!.value).toBe('ref-2');
            expect(s.workspace.querySelector('#job-panel')).toBeNull();
            expect(s.workspace.querySelector('[data-job-direction]')!.hidden).toBe(false);
            expect(s.window.state().retainedDrafts).toEqual([{
                publicationId: 'publication-1',
                sourceHash: first.publication.source.sourceHash,
                source: first.publication.source,
                label: 'Rig 1',
                value: [{
                    askId: 'ask-rig-1',
                    value: {stage: 'rig-review', verdict: 'changes-requested', words: '  keep rig 1 draft bound to source 1\n'},
                }],
            }]);
            expect(s.workspace.querySelector('[data-job-history]')!.textContent).toContain(first.publication.source.sourceHash);

            // In-place update to incompatible Rig 3 (clip shorter than 0.25s and 'body' slot removed):
            await s.publishRig(3);
            expect(notice.textContent).toBe(
                'Updated from Rig 2 to Rig 3. · The previous selection is unavailable in this result.',
            );
            expect(s.workspace.querySelector('#zoom-value')!.textContent).toBe('125% · Rig');
            expect(s.workspace.querySelector('#job-animation')!.value).toBe('');
            expect(s.workspace.querySelector('#job-time')!.value).toBe('0');
            expect(s.workspace.querySelector('#job-part')!.value).toBe('');
            expect(s.workspace.querySelector('#job-panel')).toBeNull();
            expect(second.publication.publicationId).toBe('publication-2');
        } finally {
            s.cleanup();
        }
    });

    test('#484 standing window reconnect same job: restores camera/time/part/panel, active and retained drafts, and explicit changed-version notice across reconnects', async () => {
        const sharedStore = new Map<string, string>();
        const sharedFixture = createJobWindowFixture();
        const referencesFor = () => [
            {id: 'ref-1', label: 'Ref 1'},
            {id: 'ref-2', label: 'Ref 2'},
        ];

        const s1 = await mountRuntimeSession({localStore: sharedStore, fixture: sharedFixture, pageId: 'page-1', referencesFor});
        let firstDisplay: JobDisplayPublication;
        let secondDisplay: JobDisplayPublication;
        try {
            firstDisplay = await s1.publishRig(1);
            const firstSource = firstDisplay.publication.source;
            if (firstSource.subject === 'image-set') throw new Error('Expected model source');
            const ask1 = {
                askId: 'ask-reconnect-1',
                publicationId: firstDisplay.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source: firstSource,
                status: 'pending' as const,
            };
            s1.fixture.pending(ask1, 2);
            s1.window.event(s1.fixture.events.at(-1)!);

            s1.workspace.querySelector('#zoom-in')!.click();
            const animationSelect = s1.workspace.querySelector('#job-animation')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const timeInput = s1.workspace.querySelector('#job-time')!;
            timeInput.value = '0.25';
            timeInput.dispatchEvent({type: 'change'});
            const loopInput = s1.workspace.querySelector('#job-loop')!;
            loopInput.checked = false;
            loopInput.dispatchEvent({type: 'change'});
            const partSelect = s1.workspace.querySelector('#job-part')!;
            partSelect.value = 'body';
            partSelect.dispatchEvent({type: 'change'});
            const soloInput = s1.workspace.querySelector('#job-solo')!;
            soloInput.checked = true;
            soloInput.dispatchEvent({type: 'change'});
            const refSelect = s1.workspace.querySelector('#job-reference')!;
            refSelect.value = 'ref-2';
            refSelect.dispatchEvent({type: 'change'});
            await Bun.sleep(1);

            const form1 = s1.workspace.querySelector(`form[data-job-ask="${ask1.askId}"]`)!;
            form1.querySelector('select[name="verdict"]')!.value = 'changes-requested';
            form1.querySelector('textarea[name="note"]')!.value = '  draft from rig 1\n';
            form1.dispatchEvent({type: 'input'});

            secondDisplay = await s1.publishRig(2);
            const secondSource = secondDisplay.publication.source;
            if (secondSource.subject === 'image-set') throw new Error('Expected model source');
            const ask2 = {
                askId: 'ask-reconnect-2',
                publicationId: secondDisplay.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source: secondSource,
                status: 'pending' as const,
            };
            s1.fixture.pending(ask2, 4);
            s1.window.event(s1.fixture.events.at(-1)!);
            const form2 = s1.workspace.querySelector(`form[data-job-ask="${ask2.askId}"]`)!;
            form2.querySelector('select[name="verdict"]')!.value = 'approved';
            form2.querySelector('textarea[name="note"]')!.value = '  active draft on rig 2\n';
            form2.dispatchEvent({type: 'input'});
        } finally {
            s1.cleanup();
        }

        // Reconnect #1 to the same displayed publication (Rig 2):
        const s2 = await mountRuntimeSession({localStore: sharedStore, fixture: sharedFixture, pageId: 'page-2', referencesFor});
        try {
            await s2.replayPublication(secondDisplay!);
            const secondSource = secondDisplay!.publication.source;
            if (secondSource.subject === 'image-set') throw new Error('Expected model source');
            s2.window.event({
                jobId: sharedFixture.jobId,
                generation: 4,
                cursor: '4',
                type: 'pending',
                ask: {
                    askId: 'ask-reconnect-2',
                    publicationId: secondDisplay!.publication.publicationId,
                    subject: {kind: 'review-verdict', stage: 'rig-review'},
                    source: secondSource,
                    status: 'pending',
                },
            });

            expect(s2.host.querySelector('.job-notice')!.textContent).toBe('Updated from Rig 1 to Rig 2.');
            expect(s2.workspace.querySelector('#zoom-value')!.textContent).toBe('125% · Rig');
            expect(s2.workspace.querySelector('#job-animation')!.value).toBe('inspect');
            expect(Number(s2.workspace.querySelector('#job-time')!.value)).toBeCloseTo(0.25, 5);
            expect(s2.workspace.querySelector('#job-loop')!.checked).toBe(false);
            expect(s2.workspace.querySelector('#job-part')!.value).toBe('body');
            expect(s2.workspace.querySelector('#job-solo')!.checked).toBe(true);
            expect(s2.workspace.querySelector('#job-reference')!.value).toBe('ref-2');
            expect(s2.workspace.querySelector('#job-panel')).toBeNull();
            expect(s2.workspace.querySelector('[data-job-direction]')!.hidden).toBe(false);

            const restoredForm2 = s2.workspace.querySelector('form[data-job-ask="ask-reconnect-2"]')!;
            expect(restoredForm2.querySelector('select[name="verdict"]')!.value).toBe('approved');
            expect(restoredForm2.querySelector('textarea[name="note"]')!.value).toBe('  active draft on rig 2\n');
            expect(s2.window.state().retainedDrafts).toEqual([{
                publicationId: 'publication-1',
                sourceHash: firstDisplay!.publication.source.sourceHash,
                source: firstDisplay!.publication.source,
                label: 'Rig 1',
                value: [{
                    askId: 'ask-reconnect-1',
                    value: {stage: 'rig-review', verdict: 'changes-requested', words: '  draft from rig 1\n'},
                }],
            }]);
            expect(s2.workspace.querySelector('[data-job-history]')!.textContent).toContain(firstDisplay!.publication.source.sourceHash);
        } finally {
            s2.cleanup();
        }

        // Reconnect #2 after a new version (Rig 3) was published while the window was closed:
        const s3 = await mountRuntimeSession({localStore: sharedStore, fixture: sharedFixture, pageId: 'page-3', referencesFor});
        try {
            const thirdDisplay = await s3.publishRig(3);
            expect(thirdDisplay.publication.publicationId).toBe('publication-3');
            expect(s3.host.querySelector('.job-notice')!.textContent).toBe('Updated from Rig 2 to Rig 3.');
            expect(s3.workspace.querySelector('#zoom-value')!.textContent).toBe('125% · Rig');
            expect(s3.workspace.querySelector('#job-animation')!.value).toBe('inspect');
            expect(Number(s3.workspace.querySelector('#job-time')!.value)).toBeCloseTo(0.25, 5);
            expect(s3.workspace.querySelector('#job-loop')!.checked).toBe(false);
            expect(s3.workspace.querySelector('#job-part')!.value).toBe('body');
            expect(s3.workspace.querySelector('#job-solo')!.checked).toBe(true);
            expect(s3.workspace.querySelector('#job-reference')!.value).toBe('ref-2');
            expect(s3.workspace.querySelector('#job-panel')).toBeNull();
            expect(s3.window.state().retainedDrafts.map(item => item.publicationId)).toEqual(['publication-1', 'publication-2']);
            expect(s3.workspace.querySelector('[data-job-history]')!.textContent).toContain(firstDisplay!.publication.source.sourceHash);
            expect(s3.workspace.querySelector('[data-job-history]')!.textContent).toContain(secondDisplay!.publication.source.sourceHash);
        } finally {
            s3.cleanup();
        }
    });

    test('#484 standing window bounds playback state writes, flushes final time on pause/pagehide, validates ControlPart identity and finite camera fields, and isolates malformed draft entries', async () => {
        const sharedStore = new Map<string, string>();
        const sharedFixture = createJobWindowFixture();

        const s1 = await mountRuntimeSession({
            localStore: sharedStore,
            fixture: sharedFixture,
            pageId: 'page-bounded-1',
            clips: [{name: 'inspect', duration: 2}],
        });
        let firstDisplay: JobDisplayPublication;
        let secondDisplay: JobDisplayPublication;
        try {
            firstDisplay = await s1.publishRig(1);
            const firstSource = firstDisplay.publication.source;
            if (firstSource.subject === 'image-set') throw new Error('Expected model source');
            s1.fixture.pending({
                askId: 'ask-bounded-1',
                publicationId: firstDisplay.publication.publicationId,
                subject: {kind: 'review-verdict', stage: 'rig-review'},
                source: firstSource,
                status: 'pending',
            }, 2);
            s1.window.event(s1.fixture.events.at(-1)!);
            const form1 = s1.workspace.querySelector('form[data-job-ask="ask-bounded-1"]')!;
            form1.querySelector('select[name="verdict"]')!.value = 'changes-requested';
            form1.querySelector('textarea[name="note"]')!.value = 'valid retained draft on rig 1';
            form1.dispatchEvent({type: 'input'});

            secondDisplay = await s1.publishRig(2);
            const secondSource = secondDisplay.publication.source;
            if (secondSource.subject === 'image-set') throw new Error('Expected model source');
            s1.fixture.pending({
                askId: 'ask-bounded-2',
                publicationId: secondDisplay.publication.publicationId,
                subject: {kind: 'review-verdict', stage: 'rig-review'},
                source: secondSource,
                status: 'pending',
            }, 4);
            s1.window.event(s1.fixture.events.at(-1)!);
            const form2 = s1.workspace.querySelector('form[data-job-ask="ask-bounded-2"]')!;
            form2.querySelector('select[name="verdict"]')!.value = 'approved';
            form2.querySelector('textarea[name="note"]')!.value = 'valid active draft on rig 2';
            form2.dispatchEvent({type: 'input'});

            // Single zoom action writes window state once (not duplicated across renderControls + render):
            const writesBeforeZoom = s1.windowWrites().length;
            s1.workspace.querySelector('#zoom-in')!.click();
            expect(s1.windowWrites().length).toBe(writesBeforeZoom + 1);

            const animationSelect = s1.workspace.querySelector('#job-animation')!;
            animationSelect.value = 'inspect';
            animationSelect.dispatchEvent({type: 'change'});
            const partSelect = s1.workspace.querySelector('#job-part')!;
            partSelect.value = 'body';
            partSelect.dispatchEvent({type: 'change'});

            // Start continuous playback and step 30 frames (500ms < 1000ms debounce): 0 per-frame writes
            const playButton = s1.workspace.querySelector('#job-play')!;
            playButton.click();
            const writesAtPlayStart = s1.windowWrites().length;
            s1.stepRaf(0);
            for (let frame = 0; frame < 30; frame++) s1.stepRaf(1000 / 60);
            expect(s1.windowWrites().length).toBe(writesAtPlayStart);

            // Step another 35 frames (total > 1000ms elapsed): bounded to 1 periodic write across 65 frames
            for (let frame = 0; frame < 35; frame++) s1.stepRaf(1000 / 60);
            expect(s1.windowWrites().length).toBe(writesAtPlayStart + 1);

            // Step 12 more frames (< 1000ms since periodic write): still 0 additional writes until pause flushes final time
            for (let frame = 0; frame < 12; frame++) s1.stepRaf(1000 / 60);
            expect(s1.windowWrites().length).toBe(writesAtPlayStart + 1);
            playButton.click();
            const pausedTime = s1.activePlayer().time;
            expect(s1.windowWrites().length).toBe(writesAtPlayStart + 2);
            expect(JSON.parse(s1.windowWrites().at(-1)!.value).time).toBeCloseTo(pausedTime, 5);

            // Resume playback, advance 9 frames (< 1000ms), and emit pagehide: flushes exact final time immediately
            playButton.click();
            s1.stepRaf(0);
            for (let frame = 0; frame < 9; frame++) s1.stepRaf(1000 / 60);
            const finalTimeAtPagehide = s1.activePlayer().time;
            expect(finalTimeAtPagehide).toBeGreaterThan(pausedTime);
            const writesBeforePagehide = s1.windowWrites().length;
            s1.emitGlobal('pagehide');
            expect(s1.windowWrites().length).toBe(writesBeforePagehide + 1);
            const flushedPayload = JSON.parse(s1.windowWrites().at(-1)!.value);
            expect(flushedPayload.time).toBeCloseTo(finalTimeAtPagehide, 5);
            expect(flushedPayload.partIdentity).toEqual({
                side: 'single',
                slot: 'body',
                mode: 'context',
                identity: {attachment: 'body', skin: 'default', reason: null, set: null, activeSkin: null},
            });
        } finally {
            s1.cleanup();
        }

        // Plant malformed JSON and mismatched-source draft entries alongside the valid drafts:
        sharedStore.set('rig-review-job-draft/1:window-fixture:publication-corrupt:bad', '{not-valid-json');
        sharedStore.set('rig-review-job-draft/1:window-fixture:publication-mismatch:bad', JSON.stringify({
            publicationId: 'publication-mismatch',
            sourceHash: 'a'.repeat(64),
            source: {...firstDisplay!.publication.source, sourceHash: 'b'.repeat(64)},
            label: 'Mismatched source',
            forms: [{askId: 'ask-bad', value: {stage: 'rig-review', verdict: 'approved', words: 'spoof'}}],
        }));

        // Also corrupt saved camera zoom (out of bounds) and change slot attachment identity on reconnect:
        const windowKey = 'rig-review-job-window/1:window-fixture';
        const savedWindowRaw = JSON.parse(sharedStore.get(windowKey)!);
        savedWindowRaw.camera = {cameraSync: true, activeCamera: 'rig', zoom: -5, cameraCenter: {x: 'bad', y: 0}, referenceZoom: 99, referenceCenter: null};
        sharedStore.set(windowKey, JSON.stringify(savedWindowRaw));

        const s2 = await mountRuntimeSession({
            localStore: sharedStore,
            fixture: sharedFixture,
            pageId: 'page-bounded-2',
            clips: [{name: 'inspect', duration: 2}],
            slotIdentityFor: (_display, slot) => slot + '-rebuilt-incompatible',
        });
        try {
            await s2.replayPublication(secondDisplay!);
            const secondSource = secondDisplay!.publication.source;
            if (secondSource.subject === 'image-set') throw new Error('Expected model source');
            s2.window.event({
                jobId: sharedFixture.jobId,
                generation: 4,
                cursor: '4',
                type: 'pending',
                ask: {
                    askId: 'ask-bounded-2',
                    publicationId: secondDisplay!.publication.publicationId,
                    subject: {kind: 'review-verdict', stage: 'rig-review'},
                    source: secondSource,
                    status: 'pending',
                },
            });

            // Malformed camera falls back to usable default camera (100% · Rig), while mismatched partIdentity resets part selection with notice:
            expect(s2.workspace.querySelector('#zoom-value')!.textContent).toBe('100% · Rig');
            expect(s2.workspace.querySelector('#job-part')!.value).toBe('');
            expect(s2.host.querySelector('.job-notice')!.textContent).toBe(
                'Updated from Rig 1 to Rig 2. · The previous selection is unavailable in this result.',
            );
            // Flushed pagehide playback time is preserved on reconnect:
            expect(Number(s2.workspace.querySelector('#job-time')!.value)).toBeGreaterThan(0.5);

            // Valid retained and active drafts survive sibling malformed/mismatched localStorage entries with exact source binding:
            expect(s2.window.state().retainedDrafts).toEqual([{
                publicationId: 'publication-1',
                sourceHash: firstDisplay!.publication.source.sourceHash,
                source: firstDisplay!.publication.source,
                label: 'Rig 1',
                value: [{
                    askId: 'ask-bounded-1',
                    value: {stage: 'rig-review', verdict: 'changes-requested', words: 'valid retained draft on rig 1'},
                }],
            }]);
            const restoredForm2 = s2.workspace.querySelector('form[data-job-ask="ask-bounded-2"]')!;
            expect(restoredForm2.querySelector('select[name="verdict"]')!.value).toBe('approved');
            expect(restoredForm2.querySelector('textarea[name="note"]')!.value).toBe('valid active draft on rig 2');
        } finally {
            s2.cleanup();
        }

        // Plant a malformed ControlPart identity (null attachment without reason) alongside selectedPart='body':
        const savedMalformedPart = JSON.parse(sharedStore.get(windowKey)!);
        savedMalformedPart.selectedPart = 'body';
        savedMalformedPart.partMode = 'solo';
        savedMalformedPart.partIdentity = {
            side: 'single',
            slot: 'body',
            mode: 'solo',
            identity: {attachment: null, skin: null, reason: null, set: null, activeSkin: null},
        };
        savedMalformedPart.compatibilityNotice = false;
        sharedStore.set(windowKey, JSON.stringify(savedMalformedPart));

        const s3 = await mountRuntimeSession({
            localStore: sharedStore,
            fixture: sharedFixture,
            pageId: 'page-bounded-3',
            clips: [{name: 'inspect', duration: 2}],
        });
        try {
            await s3.replayPublication(secondDisplay!);
            expect(s3.workspace.querySelector('#job-part')!.value).toBe('');
            expect(s3.host.querySelector('.job-notice')!.textContent).toBe(
                'Updated from Rig 1 to Rig 2. · The previous selection is unavailable in this result.',
            );
        } finally {
            s3.cleanup();
        }
    });

    test('#630 compiled wire inspector adapter: layer controls, I/M/B shortcuts, textEntryFocused guard, checkpoint-only SENTINELS background, and still-capture invalidation', async () => {
        const s = await mountRuntimeSession();
        try {
            const base = fixturePublication(1);
            if (base.publication.source.subject === 'image-set') throw new Error('Expected model source');
            const display: JobDisplayPublication = {
                ...base,
                publication: {
                    ...base.publication,
                    source: {
                        ...base.publication.source,
                        selector: {kind: 'rig', version: 1},
                        plan: {
                            steps: [{id: 'meshes', hash: 'b'.repeat(64)}],
                        },
                    },
                },
            };
            await s.publishDisplay(display);
            const source = display.publication.source;
            if (source.subject === 'image-set') throw new Error('Expected model source');

            // 1. Default model representation starts unchanged (images: true, mesh: false, bones: false),
            // and both layer controls and background selector stay hidden/disabled on normal asks:
            const verdictAct = fixtureAct('review-verdict', 'verdict after wire check');
            if (verdictAct.schema !== 'rig-review/act@2' || verdictAct.kind !== 'review-verdict' || verdictAct.value.stage !== 'rig-review') {
                throw new Error('Expected review-verdict act');
            }
            const verdictAsk = {
                askId: 'ask-verdict-630',
                publicationId: display.publication.publicationId,
                subject: {kind: 'review-verdict' as const, stage: 'rig-review' as const},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(verdictAsk, 2);
            s.window.event(s.fixture.events.at(-1)!);

            const layerControls = s.workspace.querySelector('#layer-controls')!;
            const layerImages = s.workspace.querySelector('#layer-images')!;
            const layerMesh = s.workspace.querySelector('#layer-mesh')!;
            const layerBones = s.workspace.querySelector('#layer-bones')!;
            const overlayCanvas = s.workspace.querySelector('#rig-overlay')!;
            const rigViewport = s.workspace.querySelector('#rig-viewport')!;
            const bgField = s.workspace.querySelector('#job-background-field')!;
            const bgSelect = s.workspace.querySelector('#job-background')!;
            expect(layerControls).not.toBeNull();
            expect(layerControls.hidden).toBe(true);
            expect(layerImages.checked).toBe(true);
            expect(layerMesh.checked).toBe(false);
            expect(layerBones.checked).toBe(false);
            expect(layerImages.disabled).toBe(true);
            expect(layerMesh.disabled).toBe(true);
            expect(layerBones.disabled).toBe(true);
            expect(overlayCanvas).not.toBeNull();
            expect(overlayCanvas.getAttribute('aria-label')).toBe('Actual rig mesh and bone overlay');
            expect(rigViewport.getAttribute('tabindex')).toBe('-1');
            expect(bgField).not.toBeNull();
            expect(bgSelect).not.toBeNull();
            expect(bgField.hidden).toBe(true);
            expect(bgSelect.disabled).toBe(true);
            expect(rigViewport.style.backgroundColor ?? '').toBe('');
            expect(rigViewport.dataset.jobRigCanonical).toBe('');
            expect(rigViewport.querySelector('[data-job-rig-presentation]')).not.toBeNull();

            // Shortcuts I/M/B are inert while no checkpoint ask is pending:
            s.emitGlobal('keydown', {key: 'i', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'm', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'b', target: rigViewport, preventDefault() {}});
            expect(layerImages.checked).toBe(true);
            expect(layerMesh.checked).toBe(false);
            expect(layerBones.checked).toBe(false);

            // 2. Ask a meshes checkpoint: layer controls and Background selector become visible & enabled:
            const checkpointAsk = {
                askId: 'ask-meshes-630',
                publicationId: display.publication.publicationId,
                subject: {kind: 'checkpoint' as const, checkpointId: 'meshes', planStepId: 'meshes'},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(checkpointAsk, 3);
            s.window.event(s.fixture.events.at(-1)!);
            expect(layerControls.hidden).toBe(false);
            expect(layerImages.disabled).toBe(false);
            expect(layerMesh.disabled).toBe(false);
            expect(layerBones.disabled).toBe(false);
            expect(bgField.hidden).toBe(false);
            expect(bgSelect.disabled).toBe(false);
            expect(bgSelect.children.map(opt => opt.value)).toEqual(['', ...Object.keys(SENTINELS)]);

            // 3. Toggle Mesh edges (M) and Bone points (B): draws inline + generated mesh triangles and bone joints on #rig-overlay:
            overlayCanvas.canvasOps.length = 0;
            s.emitGlobal('keydown', {key: 'm', target: rigViewport, preventDefault() {}});
            expect(layerMesh.checked).toBe(true);
            expect(overlayCanvas.canvasOps.some(op => op.startsWith('stroke:'))).toBe(true);
            const fullRigMoveCount = overlayCanvas.canvasOps.filter(op => op.startsWith('moveTo:')).length;
            // body_mesh (5 unique edges) + head_gen_mesh (3 unique edges) = 8 unique edges * 2 strokes = 16 moveTo calls:
            expect(fullRigMoveCount).toBe(16);

            overlayCanvas.canvasOps.length = 0;
            s.emitGlobal('keydown', {key: 'b', target: rigViewport, preventDefault() {}});
            expect(layerBones.checked).toBe(true);
            expect(overlayCanvas.canvasOps.filter(op => op.startsWith('arc:'))).toHaveLength(2);

            // 4. Detail controls: selecting a part (#job-part) in solo (#job-solo) filters overlay mesh to that slot; zoom (#zoom-in) redraws overlay in alignment:
            const partSelect = s.workspace.querySelector('#job-part')!;
            const soloInput = s.workspace.querySelector('#job-solo')!;
            soloInput.checked = true;
            soloInput.dispatchEvent({type: 'change'});
            overlayCanvas.canvasOps.length = 0;
            partSelect.value = 'head';
            partSelect.dispatchEvent({type: 'change'});
            // head_gen_mesh alone (3 unique edges * 2 strokes = 6) + 4 selection box edges + 4 bone axis ticks = 14 moveTo calls:
            expect(overlayCanvas.canvasOps.filter(op => op.startsWith('moveTo:'))).toHaveLength(14);
            soloInput.checked = false;
            soloInput.dispatchEvent({type: 'change'});
            overlayCanvas.canvasOps.length = 0;
            partSelect.value = '';
            partSelect.dispatchEvent({type: 'change'});
            // Whole rig (16 mesh moveTo) + 4 bone axis ticks = 20 moveTo calls:
            expect(overlayCanvas.canvasOps.filter(op => op.startsWith('moveTo:'))).toHaveLength(20);

            overlayCanvas.canvasOps.length = 0;
            s.workspace.querySelector('#zoom-in')!.click();
            expect(overlayCanvas.canvasOps.filter(op => op.startsWith('moveTo:'))).toHaveLength(20);
            s.workspace.querySelector('#fit')!.click();

            // 5. Images off (I): hides #rig-root and removes .job-rig-presentation while keeping wire overlay visible:
            overlayCanvas.canvasOps.length = 0;
            s.emitGlobal('keydown', {key: 'i', target: rigViewport, preventDefault() {}});
            expect(layerImages.checked).toBe(false);
            expect(s.workspace.querySelector('#rig-root')!.style.visibility).toBe('hidden');
            expect(rigViewport.querySelector('[data-job-rig-presentation]')).toBeNull();
            expect(rigViewport.dataset.jobRigCanonical).toBeUndefined();
            expect(overlayCanvas.canvasOps.filter(op => op.startsWith('moveTo:'))).toHaveLength(20);

            // 6. Sentinel background (white and green): updates #rig-viewport background and invalidates canonical still capture:
            bgSelect.value = 'white';
            bgSelect.dispatchEvent({type: 'change'});
            expect(rigViewport.style.backgroundColor).toBe(SENTINELS.white);
            expect(rigViewport.querySelector('[data-job-rig-presentation]')).toBeNull();
            bgSelect.value = 'green';
            bgSelect.dispatchEvent({type: 'change'});
            expect(rigViewport.style.backgroundColor).toBe(SENTINELS.green);

            // 7. Canonical review-verdict still capture is refused while any overlay layer or non-default background is active:
            s.fixture.returnAct({
                ...verdictAct,
                askId: verdictAsk.askId,
                publicationId: display.publication.publicationId,
                source: {...source, selector: {kind: 'rig', version: 1}, model: source.model!},
                value: verdictAct.value,
            });
            const vForm = s.workspace.querySelector(`form[data-job-ask="${verdictAsk.askId}"]`)!;
            vForm.querySelector('select[name="verdict"]')!.value = 'approved';
            vForm.querySelector('textarea[name="note"]')!.value = 'verdict after wire check';
            vForm.dispatchEvent({type: 'input'});
            await vForm.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(0);
            expect(vForm.querySelector('[role="status"]')!.dataset.jobText).toBe('JOB_STILL_VIEW_UNSUPPORTED');

            // Restore layers (Images on, Mesh off, Bones off), but leave sentinel background on -> still refused:
            s.emitGlobal('keydown', {key: 'i', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'm', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'b', target: rigViewport, preventDefault() {}});
            expect(layerImages.checked).toBe(true);
            expect(layerMesh.checked).toBe(false);
            expect(layerBones.checked).toBe(false);
            vForm.dispatchEvent({type: 'input'});
            await vForm.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(0);
            expect(vForm.querySelector('[role="status"]')!.dataset.jobText).toBe('JOB_STILL_VIEW_UNSUPPORTED');

            // Re-enable wire + green background for checkpoint submission:
            s.emitGlobal('keydown', {key: 'i', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'm', target: rigViewport, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'b', target: rigViewport, preventDefault() {}});

            // 8. Typing I/M/B in checkpoint textarea[name="note"] must NOT toggle layers, and checkpoint submits verbatim words:
            const cpForm = s.workspace.querySelector(`form[data-job-ask="${checkpointAsk.askId}"]`)!;
            const cpNote = cpForm.querySelector('textarea[name="note"]')!;
            s.emitGlobal('keydown', {key: 'i', target: cpNote, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'm', target: cpNote, preventDefault() {}});
            s.emitGlobal('keydown', {key: 'b', target: cpNote, preventDefault() {}});
            expect(layerImages.checked).toBe(false);
            expect(layerMesh.checked).toBe(true);
            expect(layerBones.checked).toBe(true);

            const cpAct = fixtureAct('checkpoint', '  Inspecting I M B mesh seam verbatim\n');
            if (cpAct.kind !== 'checkpoint') throw new Error('Expected checkpoint act');
            s.fixture.returnAct({
                ...cpAct,
                askId: checkpointAsk.askId,
                publicationId: display.publication.publicationId,
                source: {...source, plan: source.plan!},
                value: {checkpointId: 'meshes', planStepId: 'meshes', outcome: 'pass', words: '  Inspecting I M B mesh seam verbatim\n'},
            });
            cpForm.querySelector('select[name="outcome"]')!.value = 'pass';
            cpNote.value = '  Inspecting I M B mesh seam verbatim\n';
            cpForm.dispatchEvent({type: 'input'});
            await cpForm.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(1);
            expect(s.outgoingSubmits[0]!.body.kind).toBe('checkpoint');
            expect(s.outgoingSubmits[0]!.body.value).toEqual({
                checkpointId: 'meshes',
                outcome: 'pass',
                words: '  Inspecting I M B mesh seam verbatim\n',
            });

            // 9. Transition 1 (Answering the pending checkpoint ask resets layers/background, hides/disables controls,
            // and restores canonical presentation for the remaining unrelated review-verdict ask):
            expect(layerControls.hidden).toBe(true);
            expect(layerImages.disabled).toBe(true);
            expect(layerImages.checked).toBe(true);
            expect(layerMesh.checked).toBe(false);
            expect(layerBones.checked).toBe(false);
            expect(bgField.hidden).toBe(true);
            expect(bgSelect.disabled).toBe(true);
            expect(rigViewport.style.backgroundColor ?? '').toBe('');
            expect(rigViewport.dataset.jobRigCanonical).toBe('');
            expect(rigViewport.querySelector('[data-job-rig-presentation]')).not.toBeNull();

            s.fixture.returnAct({
                ...verdictAct,
                askId: verdictAsk.askId,
                publicationId: display.publication.publicationId,
                source: {...source, selector: {kind: 'rig', version: 1}, model: source.model!},
                value: verdictAct.value,
            });
            vForm.dispatchEvent({type: 'input'});
            await vForm.onsubmit?.({preventDefault() {}});
            expect(s.outgoingSubmits).toHaveLength(2);
            expect(s.outgoingSubmits[1]!.body.kind).toBe('review-verdict');
            expect(s.outgoingSubmits[1]!.body.capture.view).toBe('whole-rig');

            // 10. Transition 2 (Publication swap while a checkpoint ask is pending with active wire/background resets state on the new publication):
            const checkpointAsk2 = {
                askId: 'ask-meshes-630-2',
                publicationId: display.publication.publicationId,
                subject: {kind: 'checkpoint' as const, checkpointId: 'meshes', planStepId: 'meshes'},
                source,
                status: 'pending' as const,
            };
            s.fixture.pending(checkpointAsk2, 4);
            s.window.event(s.fixture.events.at(-1)!);
            expect(layerControls.hidden).toBe(false);
            s.emitGlobal('keydown', {key: 'm', target: rigViewport, preventDefault() {}});
            bgSelect.value = 'magenta';
            bgSelect.dispatchEvent({type: 'change'});
            expect(layerMesh.checked).toBe(true);
            expect(rigViewport.style.backgroundColor).toBe(SENTINELS.magenta);

            const display2 = fixturePublication(2);
            await s.publishDisplay(display2);
            const rigViewport2 = s.workspace.querySelector('#rig-viewport')!;
            expect(s.workspace.querySelector('#layer-controls')!.hidden).toBe(true);
            expect(s.workspace.querySelector('#layer-images')!.disabled).toBe(true);
            expect(s.workspace.querySelector('#layer-images')!.checked).toBe(true);
            expect(s.workspace.querySelector('#layer-mesh')!.checked).toBe(false);
            expect(s.workspace.querySelector('#job-background-field')!.hidden).toBe(true);
            expect(rigViewport2.style.backgroundColor ?? '').toBe('');
            expect(rigViewport2.dataset.jobRigCanonical).toBe('');
            expect(rigViewport2.querySelector('[data-job-rig-presentation]')).not.toBeNull();
        } finally {
            s.cleanup();
        }
    });
});

describe('C4 shared parts host', () => {
    function partsMetadata(panels?: unknown) {
        return {manifest: {panels}, capabilities: {preRig: true, playback: false}} as unknown as JobInspectionMetadataV3;
    }
    function partsAct(verdict: 'approved' | 'changes-requested' = 'approved') {
        const base = fixtureAct('parts-verdict', '  source words\n');
        return {...base, schema: 'rig-review/act@5', value: {verdict, words: '  source words\n',
            issues: verdict === 'approved' ? [] : [{id: 'spatial-issue'}]}} as unknown as JobPartsVerdictAct;
    }
    async function partsHarness(withSignoff = true) {
        const h = harness();
        const act = partsAct();
        const display = await h.publish(1, act.source);
        const verdict = {askId: act.askId, publicationId: act.publicationId,
            subject: {kind: 'parts-verdict', draftId: 'draft-one'}, source: act.source, status: 'pending'} as PendingAskV3;
        const signoff = {...verdict, askId: 'parts-signoff', subject: {kind: 'signoff', stage: 'parts-review'}} as PendingAskV3;
        h.window.event({type: 'pending', jobId: 'window-fixture', generation: 2, cursor: '2', ask: verdict});
        if (withSignoff) h.window.event({type: 'pending', jobId: 'window-fixture', generation: 3, cursor: '3', ask: signoff});
        const input = {kind: 'parts-verdict', askId: act.askId, publicationId: act.publicationId,
            pageId: 'page-one', displayedNonce: h.window.state().receipt!.displayedNonce,
            expectedGeneration: h.window.state().generation, submissionId: 'parts-submit', value: act.value} as UISubmissionV3;
        return {...h, act, verdict, signoff, display, input};
    }
    const actEvent = (act: ActV3, generation = 4) => ({type: 'act' as const, jobId: 'window-fixture',
        generation, cursor: String(generation), act});

    test('C4 default, explicit, invalid and unknown panel declarations preserve the signed slots', () => {
        const source = fixturePublication().publication.source;
        const fallback = resolveJobPanels(partsMetadata(), source);
        expect(fallback.invalid).toBe(false);
        expect(fallback.composition).toEqual({schema: 'rig-review/panels@1', left: ['parts.list'],
            stage: ['parts.canvas'], toolbar: ['parts.layers'], side: ['parts.issues', 'act.submit']});
        const explicit = {...fallback.composition, toolbar: []};
        expect(resolveJobPanels(partsMetadata(explicit), source).composition).toEqual(explicit);
        for (const raw of [null, [], {}, {...explicit, schema: 'wrong'}, {...explicit, stage: []},
            {...explicit, stage: ['parts.canvas', 'rig.playback']}, {...explicit, side: ['act.submit', 'parts.issues']},
            {...explicit, left: [false]}]) {
            expect(resolveJobPanels(partsMetadata(raw), source)).toEqual({...fallback, invalid: true});
        }
        const unknown = {...explicit, left: ['future.component']};
        expect<unknown>(resolveJobPanels(partsMetadata(unknown), source)).toEqual({composition: unknown, invalid: false});
    });

    test('C4 painting is selected by declared identity, including a non-first painting role', () => {
        const source = fixtureAct('parts-verdict').source;
        const painting = {...source.parts!.images[0]!, role: 'painting', path: 'painting.png'};
        const display = fixturePublication();
        Object.assign(display.publication, {source: {...source, parts: {...source.parts, images: [...source.parts!.images, painting]}}});
        const reference = (id: string, label: string) => ({id, label}) as JobPreparedInspection['references'][number];
        const mask = reference('mask', 'figure_mask figure.png');
        const original = reference('original', 'painting painting.png');
        const declared = reference('declared', 'declared painting');
        const prepared = {display, metadata: partsMetadata(), references: [mask, original, declared]};
        expect(jobPartsPainting(prepared)).toBe(original);
        Object.assign(prepared.metadata, {sourcePainting: {id: 'declared'}});
        expect(jobPartsPainting(prepared)).toBe(declared);
        prepared.references = [mask, original];
        expect(jobPartsPainting(prepared)).toBeNull();
    });

    test('C4 zero issues sends verdict then signoff with the original words', async () => {
        const h = await partsHarness();
        const requests: UISubmissionV3[] = [];
        h.fixture.ports.commitUIAct = async (_job, request) => {
            const input = await request.json() as UISubmissionV3;
            requests.push(input);
            const act = input.kind === 'parts-verdict' ? h.act : {...fixtureAct('signoff'),
                askId: h.signoff.askId, source: h.act.source, value: input.value} as ActV3;
            return {ok: true, value: act};
        };
        expect((await h.window.submitParts(h.input, 'signoff-submit')).ok).toBe(true);
        expect(requests.map(input => input.kind)).toEqual(['parts-verdict', 'signoff']);
        expect(requests[1]!.value).toEqual({stage: 'parts-review', decision: 'approved', words: '  source words\n'});
        expect(h.window.state().pending.find(ask => ask.askId === h.act.askId)?.act).toEqual(h.act);
        expect(jobPartsReviewState(h.window.state().pending, h.act.publicationId)).toBe('approved');
    });

    test('C4 issues send only the registered verdict value', async () => {
        const h = await partsHarness(false);
        const act = partsAct('changes-requested');
        const requests: UISubmissionV3[] = [];
        h.fixture.ports.commitUIAct = async (_job, request) => {
            requests.push(await request.json() as UISubmissionV3);
            return {ok: true, value: act};
        };
        expect((await h.window.submitParts({...h.input, value: act.value} as UISubmissionV3, 'unused')).ok).toBe(true);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.value).toEqual(act.value);
        expect(jobPartsReviewState(h.window.state().pending, act.publicationId)).toBe('sent');
    });

    test('C4 first failure retries the verdict, second failure retries only the pending signoff', async () => {
        const h = await partsHarness();
        const requests: UISubmissionV3[] = [];
        let fail = 'parts-verdict';
        h.fixture.ports.commitUIAct = async (_job, request) => {
            const input = await request.json() as UISubmissionV3;
            requests.push(input);
            if (input.kind === fail) return {ok: false, error: {code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID'}};
            return {ok: true, value: input.kind === 'parts-verdict' ? h.act : {...fixtureAct('signoff'),
                askId: h.signoff.askId, source: h.act.source, value: input.value} as ActV3};
        };
        expect((await h.window.submitParts(h.input, 'signoff-submit')).ok).toBe(false);
        expect(jobPartsReviewState(h.window.state().pending, h.act.publicationId)).toBe('reviewing');
        fail = 'signoff';
        expect((await h.window.submitParts(h.input, 'signoff-submit')).ok).toBe(false);
        expect(jobPartsReviewState(h.window.state().pending, h.act.publicationId)).toBe('retry-signoff');
        fail = '';
        expect((await h.window.submitParts(h.input, 'signoff-submit')).ok).toBe(true);
        expect(requests.map(input => input.kind)).toEqual(['parts-verdict', 'parts-verdict', 'signoff', 'signoff']);
        expect(requests.slice(2).map(input => input.submissionId)).toEqual(['signoff-submit', 'signoff-submit']);
    });

    test('C4 act events and reconnect replay retain the finalized value and never fabricate a signoff', async () => {
        const h = await partsHarness();
        h.window.event(actEvent(h.act));
        h.window.event({type: 'pending', jobId: 'window-fixture', generation: 3, cursor: '3', ask: h.verdict});
        expect(h.window.state().pending.find(ask => ask.askId === h.act.askId)?.act).toEqual(h.act);
        expect(jobPartsReviewState(h.window.state().pending, h.act.publicationId)).toBe('retry-signoff');
        const reload = await partsHarness();
        reload.window.event(actEvent(h.act));
        expect(jobPartsReviewState(reload.window.state().pending, h.act.publicationId)).toBe('retry-signoff');
        const signoff = {...fixtureAct('signoff'), askId: h.signoff.askId, source: h.act.source,
            value: {stage: 'parts-review', decision: 'approved', words: ''}} as ActV3;
        reload.window.event(actEvent(signoff, 5));
        expect(jobPartsReviewState(reload.window.state().pending, h.act.publicationId)).toBe('approved');
        expect(jobPartsReviewState(reload.window.state().pending, 'publication-2')).toBe('reviewing');
        const legacy: ActV3 = {...h.act, schema: 'rig-review/act@2', value: {
            verdict: 'approved', words: h.act.value.words,
            parts: [{partId: 'body', part: {outcome: 'clean', note: ''}, mesh: {outcome: 'clean', note: ''}}],
        }};
        expect(jobPartsReviewState([{...h.verdict, status: 'answered', act: legacy}], h.act.publicationId)).toBe('reviewing');
    });

    test('C4 missing signoff and stale source are refused before another write', async () => {
        const h = await partsHarness(false);
        await expect(h.window.submitParts(h.input, 'signoff-submit')).rejects.toThrow('JOB_PARTS_SIGNOFF_MISSING');
        expect(h.fixture.submissions).toHaveLength(0);
        await h.publish(2);
        await expect(h.window.submitParts(h.input, 'signoff-submit')).rejects.toThrow('JOB_ACT_SOURCE_STALE');
        expect(h.fixture.submissions).toHaveLength(0);
    });

    test('C4 source mounts one workspace and removes duplicate parts controls', async () => {
        const source = await Bun.file(new URL('../web/job-session.ts', import.meta.url)).text();
        expect(source.match(/mountPartsWorkspace\(panel\.regions/g)).toHaveLength(1);
        expect(source).not.toContain("images.className = 'job-part-images'");
        expect(source).not.toContain("partOutcome.name = 'parts.'");
        expect(source).not.toContain("panels.id = 'job-panel'");
        expect(source).toContain("import('./parts.ts')");
        expect(source).toContain('return {...panel.output.value(), words: note.value}');
    });
});

test('C4 retained crop host enforces origin, capability, instance, current publication, source and body bounds', async () => {
    const fixture = await scriptedJobWindowFixture();
    try {
        const publication = await fixture.publish('parts');
        const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
        const endpoint = fixture.host.origin + descriptor.value.routes.apiBase + 'stage-parts/comment';
        const capability = fixture.host.session.hostCredentials().ui;
        const post = (body: string, origin: string | null, token: string | null, contentType = 'application/json', url = endpoint) => fetch(url, {
            method: 'POST', headers: {'Content-Type': contentType,
                ...(origin === null ? {} : {Origin: origin}), ...(token === null ? {} : {'X-Review-Capability': token})}, body,
        });
        expect((await post('{}', null, capability)).status).toBe(403);
        expect((await post('{}', 'http://attacker.example', capability)).status).toBe(403);
        expect((await post('{}', fixture.host.origin, null)).status).toBe(403);
        expect((await post('{}', fixture.host.origin, fixture.host.session.hostCredentials().agent)).status).toBe(403);
        const stale = await post(JSON.stringify({sourceHash: 'f'.repeat(64)}), fixture.host.origin, capability);
        expect(stale.status).toBe(409);
        expect((await stale.json()).error.code).toBe('JOB_ACT_SOURCE_STALE');
        expect((await post('{}', fixture.host.origin, capability, 'text/plain')).status).toBe(400);
        expect((await post(JSON.stringify({padding: 'x'.repeat(256 * 1024)}), fixture.host.origin, capability)).status).toBe(413);
        expect((await fetch(endpoint)).status).toBe(404);
        const otherKey = publication.instanceKey === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        const mismatchedInstance = await post('{}', fixture.host.origin, capability, 'application/json',
            endpoint.replace('/instances/' + publication.instanceKey + '/', '/instances/' + otherKey + '/'));
        expect(mismatchedInstance.status).toBe(409);
        expect((await mismatchedInstance.json()).error.code).toBe('JOB_DISPLAY_MISMATCH');
        const unknownPublication = await post('{}', fixture.host.origin, capability, 'application/json',
            endpoint.replace('/publications/' + publication.publicationId + '/', '/publications/missing-publication/'));
        expect(unknownPublication.status).toBe(404);
        expect((await unknownPublication.json()).error.code).toBe('JOB_PUBLICATION_UNKNOWN');
        await fixture.publish('parts', 'parts-new-current');
        const oldPublication = await post(JSON.stringify({sourceHash: publication.source.sourceHash}), fixture.host.origin, capability);
        expect(oldPublication.status).toBe(409);
        expect((await oldPublication.json()).error.code).toBe('JOB_ACT_SOURCE_STALE');
        // Read-only access to the prior immutable publication remains supported.
        expect((await fetch(fixture.host.origin + descriptor.value.routes.apiBase + 'review')).status).toBe(200);
    } finally {await fixture.close();}
});

test('C4 declared source painting preloads from its pinned route without fetching the synthetic manifest asset', async () => {
    const display = fixturePublication();
    Object.assign(display.publication, {source: {...display.publication.source, model: null}});
    const bytes = Uint8Array.from([1, 2, 3]);
    const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    const metadata = {
        manifest: parseManifest({schema: 'rig-review/1', id: 'window-fixture', revision: '1', title: 'Painting',
            references: [{id: 'source-painting', label: 'Original painting', type: 'image', path: '__review_source_painting__.png'}]}),
        sourceHash: display.publication.source.sourceHash,
        reviewedSource: {rig: null},
        sourcePainting: {id: 'source-painting', path: 'original.png', sha256: hash, url: '/review-painting'},
        capabilities: {playback: false}, feedbackCatalog: {slots: null},
    };
    const names = ['document', 'location', 'Image', 'fetch'] as const;
    const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const requested: string[] = [];
    class PreparedImage {
        naturalWidth = 1;
        naturalHeight = 1;
        src = '';
        async decode() {}
    }
    try {
        Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement: () => ({})}});
        Object.defineProperty(globalThis, 'location', {configurable: true, value: {origin: 'http://127.0.0.1:4318'}});
        Object.defineProperty(globalThis, 'Image', {configurable: true, value: PreparedImage});
        Object.defineProperty(globalThis, 'fetch', {configurable: true, value: async (url: string) => {
            requested.push(url);
            if (url.endsWith('/api/review')) return Response.json(metadata);
            if (url.endsWith('/review-painting')) return new Response(bytes);
            throw new Error('Unexpected asset route');
        }});
        const prepared = await prepareJobInspection(display, new AbortController().signal);
        expect(prepared.references.map(reference => reference.id)).toEqual(['source-painting']);
        expect(requested.filter(url => url.endsWith('/review-painting'))).toHaveLength(1);
        expect(requested.some(url => url.includes('__review_source_painting__'))).toBe(false);
        prepared.dispose();
    } finally {
        for (const [name, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    }
});

test('C4 native crop host retains the job source identity through the trusted server context', async () => {
    const {loadPartsView, verdictSource} = await import('../src/parts-view.ts');
    const {candidate} = await import('./helpers/parts-comments-package.ts');
    const {readPngCrop} = await import('../src/comment-crops.ts');
    const {PNG} = await import('pngjs');
    const fixture = await scriptedJobWindowFixture();
    const previousState = process.env.RIG_REVIEW_STATE_DIR;
    process.env.RIG_REVIEW_STATE_DIR = join(fixture.input.state, 'comment-state');
    try {
        const publication = await fixture.publish('parts');
        const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
        const endpoint = fixture.host.origin + descriptor.value.routes.apiBase + 'stage-parts/comment';
        const pkg = await loadPartsView(fixture.packageRoot);
        const part = pkg.items[0]!;
        const original = PNG.sync.read(await readFile(pkg.imagePaths[part.index]!));
        const sample = candidate(pkg);
        const issue = {...sample, sourceHash: publication.source.sourceHash,
            parts: [{name: part.name, imageHash: sample.parts[0]!.imageHash}],
            imageRegion: {x: 0, y: 0, width: 1, height: 1},
            rigRegion: {x: part.x, y: part.y, width: 1, height: 1},
        };
        const post = (value: unknown) => fetch(endpoint, {method: 'POST',
            headers: {'Content-Type': 'application/json', Origin: fixture.host.origin,
                'X-Review-Capability': fixture.host.session.hostCredentials().ui}, body: JSON.stringify(value)});
        expect(verdictSource(pkg).sha256).not.toBe(publication.source.sourceHash);
        const before = await jobInputHashes(fixture.input.root);
        const response = await post(issue);
        expect(response.status).toBe(200);
        const {comment} = await response.json();
        expect(comment.sourceHash).toBe(publication.source.sourceHash);
        expect(comment.parts).toEqual(issue.parts);
        expect(comment.crop).toEqual(issue.crop);
        const native = PNG.sync.read(await readPngCrop(comment.nativeCrop));
        expect([native.width, native.height]).toEqual([1, 1]);
        expect([...native.data]).toEqual([...original.data.subarray(0, 4)]);
        const refused = await post({...issue, sourceHash: verdictSource(pkg).sha256});
        expect(refused.status).toBe(409);
        expect((await refused.json()).error.code).toBe('JOB_ACT_SOURCE_STALE');
        const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
        const record = retained.seals.find(file => file.path === 'project.json')!;
        const recordPath = join(retained.snapshotRoot, record.path);
        const recordBytes = await readFile(recordPath);
        try {
            // This disposable retained-record mutant must be caught even after the parts view is cached.
            await writeFile(recordPath, Buffer.concat([recordBytes, Buffer.from('\n')]));
            const changed = await post(issue);
            expect(changed.status).toBe(409);
            expect((await changed.json()).error.code).toBe('JOB_SOURCE_UNRETAINABLE');
        } finally {
            await writeFile(recordPath, recordBytes);
            const restoredHash = new Bun.CryptoHasher('sha256').update(await readFile(recordPath)).digest('hex');
            expect(restoredHash).toBe(record.sha256);
            console.log('C4_SNAPSHOT_CONTROL ' + JSON.stringify({before: record.sha256, restored: restoredHash}));
        }
        expect(await jobInputHashes(fixture.input.root)).toEqual(before);
    } finally {
        if (previousState === undefined) delete process.env.RIG_REVIEW_STATE_DIR;
        else process.env.RIG_REVIEW_STATE_DIR = previousState;
        await fixture.close();
    }
});

describe('C4 async source and host ownership', () => {
    const roots: string[] = [];
    afterEach(async () => {
        const {rm} = await import('node:fs/promises');
        for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
    });
    // Exercise the production C4 adapter closures. Browser validation uses the shared C3 mount.
    async function adapters() {
        const [{parsePartsIssue}, {commentFixture, candidate}, {mkdtemp}, {tmpdir}] = await Promise.all([
            import('../src/parts-comment.ts'), import('./helpers/parts-comments-package.ts'),
            import('node:fs/promises'), import('node:os'),
        ]);
        const h = harness();
        let preparation!: AbortSignal;
        h.prepareWith(async (_display, signal) => {preparation = signal;});
        const display = await h.publish(1);
        const prepared = {display};
        const root = await mkdtemp(join(tmpdir(), 'review-c4-adapters-'));
        roots.push(root);
        const pkg = await commentFixture(root);
        const sample = candidate(pkg);
        const item = pkg.items[0]!;
        const issue = {...sample, sourceHash: display.publication.source.sourceHash,
            parts: [{name: item.name, imageHash: sample.parts[0]!.imageHash}],
            imageRegion: {x: 0, y: 0, width: 1, height: 1},
            rigRegion: {x: item.x, y: item.y, width: 1, height: 1}};
        const sourceText = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
        const mountStart = sourceText.indexOf('    async function mountJobParts(');
        const adapterStart = sourceText.indexOf('        const lifetime = new AbortController();', mountStart);
        const adapterEnd = sourceText.indexOf('        try {\n            mounted = mountPartsWorkspace(', adapterStart);
        const readyStart = sourceText.indexOf('            await Promise.race(', adapterEnd);
        const readyEnd = sourceText.indexOf(';', readyStart);
        const readyExpression = sourceText.slice(readyStart + '            await '.length, readyEnd);
        const paintStart = sourceText.indexOf('            await new Promise<void>((resolve, reject)', adapterEnd);
        const paintEnd = sourceText.indexOf('\n            if (signal.aborted)', paintStart);
        const paintExpression = sourceText.slice(paintStart + '            await '.length, paintEnd).trim().replace(/;$/, '');
        const finalizerStart = sourceText.indexOf('        } finally {', adapterEnd) + '        } finally {'.length;
        const finalizerEnd = sourceText.indexOf('\n        }', finalizerStart);
        const bytesStart = sourceText.indexOf('async function jobBytes(');
        const bytesEnd = sourceText.indexOf('async function jobDigest(', bytesStart);
        const jsonStart = sourceText.indexOf('async function jobJson<');
        const jsonEnd = sourceText.indexOf('function mediaReady(', jsonStart);
        expect(adapterStart).toBeGreaterThan(mountStart);
        expect(adapterEnd).toBeGreaterThan(adapterStart);
        expect(readyStart).toBeGreaterThan(adapterEnd);
        expect(paintStart).toBeGreaterThan(readyEnd);
        const panel: {issues: typeof issue[]; legacy: unknown; composition: {side: string[]}; output?: unknown; dispose?: () => void} = {
            issues: [issue], legacy: null, composition: {side: ['parts.issues', 'act.submit']},
        };
        const partsForm = {dirty: false, submissionId: 'original-parts-id'};
        const otherForm = {dirty: false, submissionId: 'original-other-id'};
        const forms = new Map([['parts-ask', partsForm], ['other-ask', otherForm]]);
        h.window.event({type: 'pending', jobId: 'window-fixture', generation: 2, cursor: '2', ask: {
            askId: 'parts-ask', publicationId: display.publication.publicationId,
            source: display.publication.source, status: 'pending', subject: {kind: 'parts-verdict', draftId: 'draft-one'},
        }});
        let saves = 0;
        const signals: AbortSignal[] = [];
        let fetcher = async (_url: string, init: RequestInit): Promise<Response> => {
            if (init.method === 'POST') return Response.json({error: {code: 'PARTS_COMMENT_UNAVAILABLE'}}, {status: 409});
            return Response.json({sourceHash: display.publication.source.sourceHash});
        };
        const fetchAdapter = (url: string, init: RequestInit) => {signals.push(init.signal as AbortSignal); return fetcher(url, init);};
        const frames = new Map<number, FrameRequestCallback>();
        let frameId = 0;
        const code = sourceText.slice(bytesStart, bytesEnd) + sourceText.slice(jsonStart, jsonEnd) +
            sourceText.slice(adapterStart, adapterEnd) + '\nreturn {source, host, lifetime, preparationCancelled,\n' +
            'finishPreparation() {' + sourceText.slice(finalizerStart, finalizerEnd) + '\n},\n' +
            'waitForPaint() {return ' + paintExpression + ';},\n' +
            'waitUntilReady(ready) {const mounted = {ready}; return ' + readyExpression + ';},\n' +
            'activate(value) {current = value;}};';
        const run = new Function('prepared', 'current', 'signal', 'panel', 'routes', 'painting', 'forms', 'window',
            'access', 'fetch', 'parsePartsIssue', 'saveDraft', 'jobPartsReviewState', 'requestAnimationFrame', 'cancelAnimationFrame',
            new Bun.Transpiler({loader: 'ts'}).transformSync(code));
        const probe = run(prepared, prepared, preparation, panel,
            jobPublicationRoutes(display, 'http://127.0.0.1:4318'), null, forms, h.window,
            {headers: (init: HeadersInit) => new Headers(init)}, fetchAdapter, parsePartsIssue, () => {saves++;}, jobPartsReviewState,
            (callback: FrameRequestCallback) => {frames.set(++frameId, callback); return frameId;},
            (id: number) => {frames.delete(id);}) as {
                source: import('../web/parts.ts').PartsSource;
                host: import('../web/parts.ts').PartsHost;
                lifetime: AbortController;
                preparationCancelled: Promise<never>;
                waitUntilReady(ready: Promise<void>): Promise<void>;
                finishPreparation(): void;
                waitForPaint(): Promise<void>;
                activate(value: object): void;
            };
        return {...h, probe, prepared, panel, partsForm, otherForm, signals, issue, preparation,
            saved: () => saves, frames,
            frame() {const first = frames.entries().next().value; if (first) {frames.delete(first[0]); first[1](0);}},
            fetchWith(value: typeof fetcher) {fetcher = value;}};
    }

    test('C4 failed replacement keeps the retained adapter usable after its preparation signal aborts', async () => {
        const h = await adapters();
        await h.probe.source.view();
        const painted = h.probe.waitForPaint();
        h.frame(); h.frame();
        await painted;
        h.probe.finishPreparation();
        h.prepareWith(async () => {throw new Error('JOB_PRELOAD_FAILED');});
        await h.publish(2);
        expect(h.preparation.aborted).toBe(true);
        expect(h.window.state().displayed?.publication.publicationId).toBe('publication-1');
        expect(h.probe.lifetime.signal.aborted).toBe(false);
        await expect(h.probe.source.view()).resolves.toMatchObject({sourceHash: h.issue.sourceHash});
        await expect(h.probe.source.crop(h.issue)).rejects.toThrow('PARTS_COMMENT_UNAVAILABLE');
        expect(h.signals.every(signal => signal === h.probe.lifetime.signal && !signal.aborted)).toBe(true);
        h.panel.dispose!();
    });

    test('C4 cancellation while preparing aborts the actual source request and settles readiness', async () => {
        const h = await adapters();
        h.fetchWith(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
        }));
        const refused = h.probe.source.view().catch(error => error);
        const readiness = h.probe.preparationCancelled.catch(error => error);
        h.prepareWith(async () => {throw new Error('JOB_PRELOAD_FAILED');});
        await h.publish(2);
        expect((await refused).message).toContain('Aborted');
        expect((await readiness).message).toBe('JOB_PRELOAD_CANCELLED');
        expect(h.probe.lifetime.signal.aborted).toBe(true);
        h.panel.dispose!();
    });

    test('C4 awaits the handle readiness contract after source loading and propagates its rejection', async () => {
        const text = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
        expect(text).toContain('await Promise.race([mounted.ready, preparationCancelled]);');
        const readyIndex = text.indexOf('await Promise.race([mounted.ready, preparationCancelled]);');
        const fitIndex = text.indexOf("panel.regions.main.querySelector<HTMLButtonElement>('#fit')?.click();", readyIndex);
        const paintIndex = text.indexOf('await new Promise<void>((resolve, reject)', readyIndex);
        expect(fitIndex).toBeGreaterThan(readyIndex);
        expect(fitIndex).toBeLessThan(paintIndex);
        const h = await adapters();
        await h.probe.source.view();
        const ready = deferred<void>();
        let settled = false;
        const waiting = h.probe.waitUntilReady(ready.promise).then(() => {settled = true;});
        await Promise.resolve();
        expect(settled).toBe(false);
        ready.resolve();
        await waiting;
        expect(settled).toBe(true);
        const failure = new Error('PARTS_PAINT_FAILED');
        await expect(h.probe.waitUntilReady(Promise.reject(failure))).rejects.toBe(failure);
        h.probe.finishPreparation();
        h.panel.dispose!();
    });

    test('C4 replacement cancels preparation while handle readiness is unresolved', async () => {
        const h = await adapters();
        await h.probe.source.view();
        const ready = deferred<void>();
        const waiting = h.probe.waitUntilReady(ready.promise).catch(error => error);
        h.prepareWith(async () => {throw new Error('JOB_PRELOAD_FAILED');});
        await h.publish(2);
        expect((await waiting).message).toBe('JOB_PRELOAD_CANCELLED');
        expect(h.probe.lifetime.signal.aborted).toBe(true);
        ready.resolve();
        expect(h.frames.size).toBe(0);
        h.panel.dispose!();
    });

    test('C4 cancellation between paint frames releases preparation without waiting for another frame', async () => {
        for (const deliveredFrames of [0, 1]) {
            const h = await adapters();
            await h.probe.source.view();
            const painted = h.probe.waitForPaint().catch(error => error);
            if (deliveredFrames) h.frame();
            h.prepareWith(async () => {throw new Error('JOB_PRELOAD_FAILED');});
            await h.publish(2);
            expect((await painted).message).toBe('JOB_PRELOAD_CANCELLED');
            expect(h.frames.size).toBe(0);
            h.probe.finishPreparation();
            h.panel.dispose!();
        }
    });

    test('C4 late callbacks from an inactive or disposed adapter leave current forms and output intact', async () => {
        const h = await adapters();
        h.probe.finishPreparation();
        const original = h.panel.issues;
        const output = {kind: 'parts-verdict' as const, value: () => ({verdict: 'approved' as const, issues: [], words: ''})};
        h.probe.activate({});
        h.probe.host.changed([]);
        h.probe.host.register(output);
        expect(h.panel.issues).toBe(original);
        expect(h.panel.output).toBeUndefined();
        expect(h.partsForm).toEqual({dirty: false, submissionId: 'original-parts-id'});
        expect(h.saved()).toBe(0);
        h.probe.activate(h.prepared);
        h.panel.dispose!();
        h.probe.host.changed([]);
        h.probe.host.register(output);
        expect(h.panel.issues).toBe(original);
        expect(h.panel.output).toBeUndefined();
        expect(h.partsForm).toEqual({dirty: false, submissionId: 'original-parts-id'});
        expect(h.probe.host.locked()).toBe('sent');
    });

    test('C4 active callbacks retain initial issues and dirty only the parts form', async () => {
        const h = await adapters();
        expect(h.probe.host.initial()).toBe(h.panel.issues);
        h.probe.finishPreparation();
        h.probe.host.changed([]);
        expect(h.panel.issues).toEqual([]);
        expect(h.partsForm.dirty).toBe(true);
        expect(h.partsForm.submissionId).not.toBe('original-parts-id');
        expect(h.otherForm).toEqual({dirty: false, submissionId: 'original-other-id'});
        expect(h.saved()).toBe(1);
        const output = {kind: 'parts-verdict' as const, value: () => ({verdict: 'approved' as const, issues: [], words: ''})};
        h.probe.host.register(output);
        expect(h.panel.output).toBe(output);
        h.panel.dispose!();
    });

    test('C4 a late crop reply is refused after owner replacement or disposal', async () => {
        for (const dispose of [false, true]) {
            const h = await adapters();
            h.probe.finishPreparation();
            const response = deferred<Response>();
            h.fetchWith(async () => response.promise);
            const refused = h.probe.source.crop(h.issue).catch(error => error);
            if (dispose) h.panel.dispose!(); else h.probe.activate({});
            response.resolve(Response.json({comment: h.issue}));
            expect((await refused).message).toBe('JOB_ACT_SOURCE_STALE');
            expect(h.partsForm.dirty).toBe(false);
            h.panel.dispose!();
        }
    });

    test('C4 disposal aborts an active crop once and refuses subsequent crop requests', async () => {
        const h = await adapters();
        h.probe.finishPreparation();
        let aborted = 0;
        h.fetchWith(async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => {aborted++; reject(new DOMException('Aborted', 'AbortError'));}, {once: true});
        }));
        const refused = h.probe.source.crop(h.issue).catch(error => error);
        h.panel.dispose!();
        h.panel.dispose!();
        expect((await refused).message).toContain('Aborted');
        expect(aborted).toBe(1);
        await expect(h.probe.source.crop(h.issue)).rejects.toThrow('JOB_ACT_SOURCE_STALE');
        expect(h.signals).toHaveLength(1);
    });
});

test('C4 base inspection resources are disposed even when workspace cleanup throws', async () => {
    const text = await readFile(new URL('../web/job-session.ts', import.meta.url), 'utf8');
    const start = text.indexOf('            prepared.dispose = () =>');
    const end = text.indexOf('\n', start);
    const prepared = {dispose() {}};
    let disposed = 0;
    new Function('prepared', 'panel', 'dispose', text.slice(start, end))(
        prepared, {dispose() {throw new Error('Declared cleanup failure');}}, () => {disposed++;});
    expect(() => prepared.dispose()).toThrow('Declared cleanup failure');
    expect(disposed).toBe(1);
});

for (const c5Parts of ['mesh', 'no-mesh'] as const) test('C5 ordinary job fixture retains public ' + c5Parts + ' assembly geometry and source painting', async () => {
    const fixture = await scriptedJobWindowFixture({c5Parts});
    try {
        const publication = await fixture.publish('parts', 'c5-' + c5Parts);
        const before = await jobInputHashes(fixture.input.root);
        const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
        expect(descriptor.ok).toBe(true);
        const response = await fetch(fixture.host.origin + descriptor.value.routes.apiBase + 'stage-parts');
        expect(response.status).toBe(200);
        const inventory = await response.json();
        expect(inventory.sourceHash).toBe(publication.source.sourceHash);
        expect(inventory.rigSize).toEqual([32, 24]);
        expect(inventory.items.map((item: {name: string}) => item.name)).toEqual(['body', 'front']);
        expect(inventory.items.map((item: {mesh?: unknown}) => Boolean(item.mesh))).toEqual([c5Parts === 'mesh', false]);
        expect(inventory.painting).toMatchObject({width: 32, height: 24});
        const review = await (await fetch(fixture.host.origin + descriptor.value.routes.apiBase + 'review')).json();
        expect(review.sourcePainting.sha256).toBe(inventory.painting.sha256);
        expect(publication.source.parts!.images.map(image => image.role)).toEqual(['part', 'part', 'painting']);
        const retained = fixture.host.session.retainedSourceV3(publication.publicationId);
        expect(retained.seals.some(file => file.path === 'out/rig.json')).toBe(c5Parts === 'mesh');
        expect(await jobInputHashes(fixture.input.root)).toEqual(before);
        console.log('C5_JOB_FIXTURE_SOURCE ' + JSON.stringify({fixture: c5Parts, files: before}));
    } finally {await fixture.close();}
});

test('#623: job stage-parts accepts a sealed source-only painting outside parts root inside retained snapshot, keeps Difference unavailable, and refuses unsealed painting inputs', async () => {
    const f = await realWindow();
    const {mkdir} = await import('node:fs/promises');
    const {createCanvas} = await import('@napi-rs/canvas');
    const {PNG} = await import('pngjs');
    const {jobHash} = await import('../src/job-api.ts');
    const packageRoot = join(f.input.root, 'out');
    const canvas = createCanvas(80, 64), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 80, 64);
    const paintingBytes = canvas.toBuffer('image/png');
    const paintingHash = jobHash(paintingBytes);

    const partBytes = await readFile(join(packageRoot, 'mesh.png'));
    const pixels = PNG.sync.read(partBytes);
    await mkdir(join(packageRoot, 'rig/parts'), {recursive: true});
    await writeFile(join(packageRoot, 'rig/parts/mesh.png'), partBytes);
    for (const [name, content] of [['rig.json', '{"skins":{}}'], ['motion.json', '{}'], ['mesh_report.json', '[]']] as const) {
        await writeFile(join(packageRoot, 'rig', name), content);
    }
    const partsManifestBytes = Buffer.from(JSON.stringify({
        rig_size: [80, 64], scale_rig_per_source: 1,
        parts: [{name: 'mesh', from: 'full:mesh', x: 0, y: 0, w: pixels.width, h: pixels.height}],
    }, null, 2) + '\n');
    await writeFile(join(packageRoot, 'rig/parts.json'), partsManifestBytes);
    await writeFile(join(packageRoot, 'config.json'), '{}\n');
    await writeFile(join(packageRoot, 'painting.png'), paintingBytes);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'review.json'), 'utf8'));
    await writeFile(join(packageRoot, 'review.json'), JSON.stringify({
        ...manifest,
        producer: {config: 'config.json', parts: 'rig', source: 'painting.png'},
    }, null, 2) + '\n');

    const partsIdentity = {
        enumeratorVersion: f.input.partsEnumerator.version,
        manifest: {path: 'out/rig/parts.json' as const, sha256: jobHash(partsManifestBytes)},
        images: [{path: 'parts/mesh.png' as const, role: 'part', sha256: jobHash(partBytes)}],
    };
    f.input.setPartsReferences(partsIdentity.images.map(({path, role}) => ({path, role})));
    f.input.setContext({
        ...f.input.getContext(),
        selector: {kind: 'draft', id: 'synthetic-parts'},
        parts: partsIdentity,
        partIds: ['mesh'],
        subjects: [{kind: 'parts-verdict', draftId: 'synthetic-parts'}],
    });
    await writeFile(join(f.input.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{}}\n');
    f.input.setRecordPath('project.json');

    const beforeHashes = await jobInputHashes(f.input.root);
    const publication = await f.publish();
    const descriptor = await (await fetch(f.locator + '/publications/' + publication.publicationId)).json();
    expect(descriptor.ok).toBe(true);
    const routes = jobPublicationRoutes(descriptor.value, f.host.origin);

    const stagePartsRes = await fetch(routes.api('stage-parts'));
    expect(stagePartsRes.status).toBe(200);
    const stageParts = await stagePartsRes.json();
    expect(stageParts.painting).toEqual({sha256: paintingHash, width: 80, height: 64});
    expect(stageParts.differenceAvailable).toBe(false);

    const reviewRes = await fetch(routes.api('review'));
    expect(reviewRes.status).toBe(200);
    const reviewMeta = await reviewRes.json();
    expect(reviewMeta.sourcePainting).toEqual({id: 'source-painting', path: 'painting.png', sha256: paintingHash, url: '/review-painting'});
    const paintingRes = await fetch(routes.instance('/review-painting'));
    expect(paintingRes.status).toBe(200);
    expect(new Uint8Array(await paintingRes.arrayBuffer())).toEqual(new Uint8Array(paintingBytes));

    // Overlay comment succeeds with the sealed painting, while Difference remains unavailable when painting_in_rig is absent.
    const cropBuffer = createCanvas(4, 4).toBuffer('image/png');
    const cropSha = jobHash(cropBuffer);
    const cropPng = 'data:image/png;base64,' + cropBuffer.toString('base64');
    const baseComment = {
        schema: 'rig-review-parts-comment/2',
        id: 'overlay-issue-1', summary: 'overlay check',
        sourceHash: publication.source.sourceHash,
        parts: [{name: 'mesh', imageHash: jobHash(partBytes)}],
        view: {
            mode: 'assembled',
            camera: {zoom: 1, center: {x: 10, y: 10}, viewport: {width: 80, height: 64}},
            cameraSync: false, referenceCamera: null, background: 'checker',
            alpha: true, footprints: false, mesh: false,
            comparison: {mode: 'overlay', opacity: 0.5},
        },
        rigRegion: {x: 0, y: 0, width: 2, height: 2}, imageRegion: null,
        crop: {path: `comment-crops/${cropSha}.png`, sha256: cropSha, width: 4, height: 4, png: cropPng},
        nativeCrop: null,
    };
    const overlayRes = await fetch(routes.api('stage-parts/comment'), {
        method: 'POST',
        headers: {Origin: f.host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui},
        body: JSON.stringify(baseComment),
    });
    expect(overlayRes.status).toBe(200);
    const overlayBody = await overlayRes.json();
    expect(overlayBody.comment.view.comparison).toEqual({mode: 'overlay', opacity: 0.5});

    const diffRes = await fetch(routes.api('stage-parts/comment'), {
        method: 'POST',
        headers: {Origin: f.host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui},
        body: JSON.stringify({
            ...baseComment,
            id: 'diff-issue-1', summary: 'diff check',
            view: {...baseComment.view, comparison: {mode: 'difference', opacity: 0.5, threshold: 8}},
        }),
    });
    expect(diffRes.status).toBe(409);
    expect((await diffRes.json()).error.code).toBe('JOB_SOURCE_MISMATCH');

    // Commit a nonempty Overlay issue through the normal job ask -> displayed -> ui/acts -> fetch-act cycle.
    const asked = await (await f.call({
        ...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'parts-verdict-ask-623', publicationId: publication.publicationId,
        subject: {kind: 'parts-verdict', draftId: 'synthetic-parts'},
    })).json();
    expect(asked.ok).toBe(true);
    const ack = await (await f.ui('displayed', {
        publicationId: publication.publicationId, pageId: 'parts-page-623', sourceHash: publication.source.sourceHash,
    })).json();
    expect(ack.ok).toBe(true);

    const submissionBody = {
        ...ack.value, askId: asked.value.askId,
        expectedGeneration: f.host.session.status().generation,
        submissionId: 'parts-verdict-submit-623',
        kind: 'parts-verdict',
        value: {verdict: 'changes-requested', issues: [overlayBody.comment], words: 'overlay alignment shift'},
    };
    const origReadPub = f.host.session.readPublicationResponse.bind(f.host.session);
    // Unsealed extra file in snapshotRoot or tampered painting seal during commitUIAct refuses at assertRetainedSnapshotIntact as JOB_ACT_SOURCE_STALE.
    f.host.session.readPublicationResponse = (pubId, reader) => origReadPub(pubId, retained =>
        'snapshotRoot' in retained
            ? reader({...retained, seals: retained.seals.filter(s => s.path !== 'out/painting.png')})
            : reader(retained));
    try {
        const unsealedCommit = await (await f.ui('acts', {...submissionBody, submissionId: 'unsealed-commit-623'})).json();
        expect(unsealedCommit).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
    } finally {
        f.host.session.readPublicationResponse = origReadPub;
    }
    f.host.session.readPublicationResponse = (pubId, reader) => origReadPub(pubId, retained =>
        'snapshotRoot' in retained
            ? reader({...retained, seals: retained.seals.map(s => s.path === 'out/painting.png' ? {...s, sha256: '0'.repeat(64)} : s)})
            : reader(retained));
    try {
        const tamperedCommit = await (await f.ui('acts', {...submissionBody, submissionId: 'tampered-commit-623'})).json();
        expect(tamperedCommit).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
    } finally {
        f.host.session.readPublicationResponse = origReadPub;
    }

    const committed = await (await f.ui('acts', submissionBody)).json();
    expect(committed).toMatchObject({
        ok: true,
        value: {
            kind: 'parts-verdict',
            askId: asked.value.askId,
            publicationId: publication.publicationId,
            value: {verdict: 'changes-requested', issues: [overlayBody.comment], words: 'overlay alignment shift'},
        },
    });
    const fetchedAct = await (await fetch(f.locator + '/api', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + f.host.session.writerGrant().fetchCapability},
        body: JSON.stringify({...f.input.base(), verb: 'fetch-act', actId: committed.value.actId}),
    })).json();
    expect(fetchedAct).toEqual({ok: true, value: committed.value, generation: f.host.session.status().generation,
        schema: 'rig-review/job-api@2', verb: 'fetch-act', jobId: f.host.session.jobId, requestId: expect.any(String)});

    // Unsealed refusal: if a forwarded file's seal sha256 does not match (or is unsealed in the seal loop), job-front refuses with JOB_SOURCE_UNRETAINABLE.
    const {retainedPublicationRoutes} = await import('../src/job-front.ts');
    const tamperedRoute = retainedPublicationRoutes(Object.create(f.host.session, {
        readPublicationResponse: {
            value: (pubId: string, reader: (retained: any) => Promise<Response>) =>
                f.host.session.readPublicationResponse(pubId, retained => {
                    if ('snapshotRoot' in retained) {
                        const tamperedSeals = retained.seals.map(s => s.path === 'out/painting.png' ? {...s, sha256: '0'.repeat(64)} : s);
                        return reader({...retained, seals: tamperedSeals});
                    }
                    return reader(retained);
                }),
        },
    }));
    const tamperedRes = await tamperedRoute(
        f.host.session.jobId, publication.publicationId, descriptor.value.publication.instanceKey,
        'api/stage-parts', new Request(routes.api('stage-parts')),
    );
    expect(tamperedRes.status).toBe(409);
    expect((await tamperedRes.json()).error.code).toBe('JOB_SOURCE_UNRETAINABLE');

    // And if out/painting.png is omitted from seals altogether, retainedFile does not forward it to loadPartsView and /review-painting is refused.
    const unsealedRoute = retainedPublicationRoutes(Object.create(f.host.session, {
        readPublicationResponse: {
            value: (pubId: string, reader: (retained: any) => Promise<Response>) =>
                f.host.session.readPublicationResponse(pubId, retained => {
                    if ('snapshotRoot' in retained) {
                        const filteredSeals = retained.seals.filter(s => s.path !== 'out/painting.png');
                        return reader({...retained, seals: filteredSeals});
                    }
                    return reader(retained);
                }),
        },
    }));
    const unsealedRes = await unsealedRoute(
        f.host.session.jobId, publication.publicationId, descriptor.value.publication.instanceKey,
        'api/stage-parts', new Request(routes.api('stage-parts')),
    );
    expect(unsealedRes.status).toBe(200);
    const unsealedStageParts = await unsealedRes.json();
    expect(unsealedStageParts.painting).toBeNull();
    const unsealedPaintingRoute = await unsealedRoute(
        f.host.session.jobId, publication.publicationId, descriptor.value.publication.instanceKey,
        'review-painting', new Request(routes.instance('/review-painting')),
    );
    expect(unsealedPaintingRoute.status).toBe(404);
    expect((await unsealedPaintingRoute.json()).error.code).toBe('JOB_SOURCE_UNRETAINABLE');

    expect(await jobInputHashes(f.input.root)).toEqual(beforeHashes);
});

test('#626: retained job publication with producer.config, producer.parts, producer.source and nested rig.json containing mixed inline and generator meshes serves 200 on api/review, api/stage-parts and review-painting while preserving seals and Difference boundary', async () => {
    const f = await realWindow();
    const {mkdir} = await import('node:fs/promises');
    const {createCanvas} = await import('@napi-rs/canvas');
    const {PNG} = await import('pngjs');
    const {jobHash} = await import('../src/job-api.ts');
    const packageRoot = join(f.input.root, 'out');
    const canvas = createCanvas(240, 160), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#336699'; ctx.fillRect(0, 0, 240, 160);
    const paintingBytes = canvas.toBuffer('image/png');
    const paintingHash = jobHash(paintingBytes);

    const partBytes = await readFile(join(packageRoot, 'mesh.png'));
    const pixels = PNG.sync.read(partBytes);
    const faceCanvas = createCanvas(112, 133), faceCtx = faceCanvas.getContext('2d');
    faceCtx.fillStyle = '#557799'; faceCtx.fillRect(0, 0, 112, 133);
    const faceBytes = faceCanvas.toBuffer('image/png');

    await mkdir(join(packageRoot, 'draft/parts'), {recursive: true});
    await mkdir(join(packageRoot, 'draft/rig/images'), {recursive: true});
    await writeFile(join(packageRoot, 'draft/parts/mesh.png'), partBytes);
    await writeFile(join(packageRoot, 'draft/rig/images/mesh.png'), partBytes);
    await writeFile(join(packageRoot, 'draft/parts/face.png'), faceBytes);

    const rigJsonContent = JSON.stringify({
        images: 'images',
        skins: {
            default: {
                mesh: {
                    mesh: {
                        type: 'mesh',
                        image: 'mesh.png',
                        width: pixels.width,
                        height: pixels.height,
                        uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                        triangles: [0, 1, 2, 0, 2, 3],
                    },
                },
                face: {
                    face: {
                        type: 'mesh',
                        image: 'face.png',
                        width: 112,
                        height: 133,
                        generator: {
                            kind: 'grid',
                            cols: 13,
                            rows: 16,
                            depth: {image: 'face_depth.png', near: 'white', zScale: 120},
                        },
                    },
                },
            },
        },
    }, null, 2) + '\n';
    const meshReportContent = JSON.stringify([
        {part: 'mesh', mode: 'lattice', vertices: 4, triangles: 2, art_coverage: 1, stray_cleared: 0},
        {part: 'face', mode: 'grid', vertices: 238, triangles: 416, art_coverage: 1, stray_cleared: 0},
    ], null, 2) + '\n';
    await writeFile(join(packageRoot, 'draft/rig/rig.json'), rigJsonContent);
    await writeFile(join(packageRoot, 'draft/rig/motion.json'), '{}\n');
    await writeFile(join(packageRoot, 'draft/rig/mesh_report.json'), meshReportContent);

    const partsManifestBytes = Buffer.from(JSON.stringify({
        rig_size: [240, 160], scale_rig_per_source: 1,
        parts: [
            {name: 'mesh', from: 'full:mesh', x: 0, y: 0, w: pixels.width, h: pixels.height},
            {name: 'face', from: 'full:face', x: 64, y: 12, w: 112, h: 133},
        ],
    }, null, 2) + '\n');
    await writeFile(join(packageRoot, 'draft/parts.json'), partsManifestBytes);
    await writeFile(join(packageRoot, 'config.json'), '{}\n');
    await writeFile(join(packageRoot, 'painting.png'), paintingBytes);
    const manifest = JSON.parse(await readFile(join(packageRoot, 'review.json'), 'utf8'));
    await writeFile(join(packageRoot, 'review.json'), JSON.stringify({
        ...manifest,
        producer: {config: 'config.json', parts: 'draft', source: 'painting.png'},
    }, null, 2) + '\n');

    const partsIdentity = {
        enumeratorVersion: f.input.partsEnumerator.version,
        manifest: {path: 'out/draft/parts.json' as const, sha256: jobHash(partsManifestBytes)},
        images: [
            {path: 'parts/mesh.png' as const, role: 'part', sha256: jobHash(partBytes)},
            {path: 'parts/face.png' as const, role: 'part', sha256: jobHash(faceBytes)},
        ],
    };
    f.input.setPartsReferences(partsIdentity.images.map(({path, role}) => ({path, role})));
    f.input.setContext({
        ...f.input.getContext(),
        selector: {kind: 'draft', id: 'synthetic-parts-626'},
        parts: partsIdentity,
        partIds: ['mesh', 'face'],
        subjects: [{kind: 'parts-verdict', draftId: 'synthetic-parts-626'}],
    });
    await writeFile(join(f.input.root, 'project.json'), '{"schema":"rig-create/project@0","interview":{}}\n');
    f.input.setRecordPath('project.json');

    const beforeHashes = await jobInputHashes(f.input.root);
    const publication = await f.publish();
    const descriptor = await (await fetch(f.locator + '/publications/' + publication.publicationId)).json();
    expect(descriptor.ok).toBe(true);
    const routes = jobPublicationRoutes(descriptor.value, f.host.origin);

    const reviewRes = await fetch(routes.api('review'));
    expect(reviewRes.status).toBe(200);
    const reviewMeta = await reviewRes.json();
    expect(reviewMeta.sourcePainting).toEqual({id: 'source-painting', path: 'painting.png', sha256: paintingHash, url: '/review-painting'});

    const stagePartsRes = await fetch(routes.api('stage-parts'));
    expect(stagePartsRes.status).toBe(200);
    const stageParts = await stagePartsRes.json();
    expect(stageParts.painting).toEqual({sha256: paintingHash, width: 240, height: 160});
    expect(stageParts.differenceAvailable).toBe(false);
    expect(stageParts.items.map((item: {name: string; mesh?: unknown; meshUnavailable?: string}) => ({
        name: item.name, hasMesh: Boolean(item.mesh), meshUnavailable: item.meshUnavailable,
    }))).toEqual([
        {name: 'mesh', hasMesh: true, meshUnavailable: undefined},
        {name: 'face', hasMesh: false, meshUnavailable: 'PARTS_MESH_GENERATED'},
    ]);
    expect(stageParts.items[0].mesh).toMatchObject({
        vertices: [0, 0, pixels.width, 0, pixels.width, pixels.height, 0, pixels.height],
        triangles: [0, 1, 2, 0, 2, 3],
        figures: {mode: 'lattice', vertices: 4, triangles: 2, art_coverage: 1, stray_cleared: 0},
    });

    const paintingRes = await fetch(routes.instance('/review-painting'));
    expect(paintingRes.status).toBe(200);
    const paintingBody = new Uint8Array(await paintingRes.arrayBuffer());
    expect(paintingBody).toEqual(new Uint8Array(paintingBytes));
    expect(jobHash(paintingBody)).toBe(paintingHash);

    const meshImageRes = await fetch(routes.api('stage-parts/image/0'));
    expect(meshImageRes.status).toBe(200);
    expect(new Uint8Array(await meshImageRes.arrayBuffer())).toEqual(new Uint8Array(partBytes));
    const faceImageRes = await fetch(routes.api('stage-parts/image/1'));
    expect(faceImageRes.status).toBe(200);
    expect(new Uint8Array(await faceImageRes.arrayBuffer())).toEqual(new Uint8Array(faceBytes));

    // Overlay comment on the generator-mesh part succeeds while Difference remains refused.
    const cropBuffer = createCanvas(4, 4).toBuffer('image/png');
    const cropSha = jobHash(cropBuffer);
    const cropPng = 'data:image/png;base64,' + cropBuffer.toString('base64');
    const faceOverlayComment = {
        schema: 'rig-review-parts-comment/2',
        id: 'face-overlay-626', summary: 'generator face part overlay check',
        sourceHash: publication.source.sourceHash,
        parts: [{name: 'face', imageHash: jobHash(faceBytes)}],
        view: {
            mode: 'item',
            camera: {zoom: 1, center: {x: 10, y: 10}, viewport: {width: 112, height: 133}},
            cameraSync: true, referenceCamera: {zoom: 1, center: {x: 10, y: 10}, viewport: {width: 112, height: 133}},
            background: 'checker', alpha: false, footprints: false, mesh: true,
            comparison: {mode: 'overlay', opacity: 0.5},
        },
        imageRegion: {x: 4, y: 5, width: 10, height: 12},
        rigRegion: {x: 68, y: 17, width: 10, height: 12},
        crop: {path: `comment-crops/${cropSha}.png`, sha256: cropSha, width: 4, height: 4, png: cropPng},
        nativeCrop: null,
    };
    const overlayRes = await fetch(routes.api('stage-parts/comment'), {
        method: 'POST',
        headers: {Origin: f.host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui},
        body: JSON.stringify(faceOverlayComment),
    });
    expect(overlayRes.status).toBe(200);
    const overlayBody = await overlayRes.json();
    expect(overlayBody.comment.parts).toEqual([{name: 'face', imageHash: jobHash(faceBytes)}]);

    const diffRes = await fetch(routes.api('stage-parts/comment'), {
        method: 'POST',
        headers: {Origin: f.host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui},
        body: JSON.stringify({
            ...faceOverlayComment,
            id: 'face-diff-626',
            view: {...faceOverlayComment.view, comparison: {mode: 'difference', opacity: 0.5, threshold: 8}},
        }),
    });
    expect(diffRes.status).toBe(409);
    expect((await diffRes.json()).error.code).toBe('JOB_SOURCE_MISMATCH');

    // Complete normal ask -> displayed -> ui/acts -> fetch-act cycle.
    const asked = await (await f.call({
        ...f.input.base(), verb: 'ask', expectedGeneration: f.host.session.status().generation,
        idempotencyKey: 'parts-verdict-ask-626', publicationId: publication.publicationId,
        subject: {kind: 'parts-verdict', draftId: 'synthetic-parts-626'},
    })).json();
    expect(asked.ok).toBe(true);
    const ack = await (await f.ui('displayed', {
        publicationId: publication.publicationId, pageId: 'parts-page-626', sourceHash: publication.source.sourceHash,
    })).json();
    expect(ack.ok).toBe(true);
    const committed = await (await f.ui('acts', {
        ...ack.value, askId: asked.value.askId,
        expectedGeneration: f.host.session.status().generation,
        submissionId: 'parts-verdict-submit-626',
        kind: 'parts-verdict',
        value: {verdict: 'changes-requested', issues: [overlayBody.comment], words: 'face generator part reviewed'},
    })).json();
    expect(committed).toMatchObject({
        ok: true,
        value: {
            kind: 'parts-verdict',
            askId: asked.value.askId,
            publicationId: publication.publicationId,
            value: {verdict: 'changes-requested', issues: [overlayBody.comment], words: 'face generator part reviewed'},
        },
    });

    expect(await jobInputHashes(f.input.root)).toEqual(beforeHashes);
});


describe('#629 sealed checkpoint preparation without browser or raster execution', () => {
    async function setup(kind: 'plan' | 'package' = 'plan', absent = false) {
        const root = await mkdtemp(join(tmpdir(), 'review629-prepare-'));
        const workspace = createSyntheticPlanRecordWorkspace(root);
        const evidence = syntheticCheckpointEvidence(root);
        const context = {...workspace.context, files: [...workspace.files, ...evidence.files].sort((a, b) => a.path < b.path ? -1 : 1),
            ...(absent ? {} : {checkpointEvidence: [evidence.packet]})};
        const recordSource = buildRecordSource({record: workspace.record, selection: workspace.result, context});
        const display: DisplayPublicationV3 = fixturePublication();
        const source = kind === 'plan' ? recordSource : {...display.publication.source, model: null,
            plan: context.plan, ...(absent ? {} : {checkpointEvidence: [evidence.packet]})} as JobModelSourceBinding;
        Object.assign(display, {publication: {...display.publication, source}});
        const projection = {...evidence.packet, tiles: evidence.packet.tiles.map((tile, index) => ({...tile,
            url: `/api/checkpoint-evidence/${evidence.packet.checkpointId}/tiles/${index}`})),
            table: {...evidence.packet.table, ...evidence.table, url: `/api/checkpoint-evidence/${evidence.packet.checkpointId}/table`}};
        const metadata: any = {sourceHash: source.sourceHash, capabilities: {playback: false}, feedbackCatalog: {slots: null},
            ...(kind === 'plan' ? {recordSource: source} : {
                manifest: parseManifest({schema: 'rig-review/1', id: 'window-fixture', revision: '1', title: 'Synthetic evidence'}),
                reviewedSource: {rig: null, motion: null, packageRevision: '1', viewerVersion: 'synthetic', runtimeVersion: 'synthetic'}}),
            ...(absent ? {} : {checkpointEvidence: [projection]})};
        const saved = new Map<string, PropertyDescriptor | undefined>();
        function replace(key: string, value: unknown) {
            saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
            Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
        }
        const images: FakeImage[] = [], created: string[] = [], revoked: string[] = [], requests: string[] = [];
        let hold = false;
        class FakeImage {
            src = ''; alt = ''; naturalWidth = 2; naturalHeight = 2;
            resolve!: () => void; reject!: (error: Error) => void;
            constructor() {images.push(this);}
            decode() {return hold ? new Promise<void>((resolve, reject) => {this.resolve = resolve; this.reject = reject;}) : Promise.resolve();}
        }
        const bytes = new Map<string, Uint8Array>();
        for (const [index, tile] of evidence.packet.tiles.entries()) bytes.set('/tiles/' + index, await readFile(join(root, tile.path)));
        bytes.set('/table', await readFile(join(root, evidence.packet.table.path)));
        replace('location', {origin: 'http://127.0.0.1:19484'});
        replace('document', {createElement: () => ({id: ''})});
        replace('Image', FakeImage);
        replace('fetch', async (input: string) => {
            requests.push(input);
            if (input.endsWith('/api/review')) return Response.json(metadata);
            const suffix = [...bytes.keys()].find(key => input.endsWith(key));
            if (!suffix) throw new Error('Unexpected synthetic asset request');
            return new Response(bytes.get(suffix)!.slice().buffer as ArrayBuffer);
        });
        const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = blob => {const url = originalCreate(blob); created.push(url); return url;};
        URL.revokeObjectURL = url => {revoked.push(url); originalRevoke(url);};
        return {display, source, metadata, evidence, bytes, requests, images, created, revoked,
            hold() {hold = true;},
            async close() {
                URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
                for (const [key, descriptor] of saved) {
                    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
                }
                await rm(root, {recursive: true, force: true});
            }};
    }
    async function until(check: () => boolean) {
        const deadline = Date.now() + 1000;
        while (!check() && Date.now() < deadline) await Bun.sleep(1);
        expect(check()).toBe(true);
    }
    for (const kind of ['plan', 'package'] as const) test('#629 ' + kind + ' authenticates ordered four tiles and all 103 rows before ready, disposal is idempotent', async () => {
        const f = await setup(kind); f.hold();
        try {
            let returned = false;
            const pending = prepareJobInspection(f.display, new AbortController().signal).then(value => {returned = true; return value;});
            await until(() => f.images.length === 4);
            for (const image of [...f.images].reverse().slice(0, 3)) image.resolve();
            await Bun.sleep(1); expect(returned).toBe(false);
            f.images[0]!.resolve();
            const ready = await pending;
            expect(ready.checkpointEvidence?.[0]?.images.map(image => image.alt)).toEqual(f.evidence.packet.tiles.map(tile => tile.label));
            expect(ready.checkpointEvidence?.[0]?.table).toEqual(f.evidence.table);
            expect(ready.checkpointEvidence?.[0]?.table.rows).toHaveLength(103);
            console.log('CHECKPOINT_EVIDENCE_SYNTHETIC_SEALS', JSON.stringify({kind, sourceHash: f.source.sourceHash, files: f.evidence.files, rows: 103}));
            expect(f.requests.every(url => url.startsWith('http://127.0.0.1:19484' + f.display.routes.apiBase))).toBe(true);
            ready.dispose(); ready.dispose();
            expect(f.revoked).toEqual(f.created);
        } finally {await f.close();}
    });
    for (const kind of ['plan','package'] as const) test('#606 '+kind+' real preparation checks plan metadata association while trusting daemon strings',async()=>{
        const f=await setup(kind);
        try {
            const rows=f.source.plan!.steps.map(step=>({...step,does:'exact\r\n',produces:'',bar:'bar',rests_on:['a','a'],issues:[]}));
            const projection:any={schema:'rig-review/job-plan-text@1',record:{path:'project.json',sha256:f.source.projectHash},status:'projected',steps:rows};
            (f.metadata as any).planText=projection;
            const ready=await prepareJobInspection(f.display,new AbortController().signal);
            expect(ready.metadata.planText).toEqual(projection);ready.dispose();
            projection.steps[0].bar='post-server type-valid mutation';
            const trusted=await prepareJobInspection(f.display,new AbortController().signal);
            expect(trusted.metadata.planText?.status).toBe('projected');trusted.dispose();
            for (const mutate of [
                (p:any)=>{p.record.sha256='0'.repeat(64);},
                (p:any)=>{p.steps.reverse();},
                (p:any)=>{p.steps[0].hash='0'.repeat(64);},
            ]) {
                const changed=structuredClone(projection);mutate(changed);(f.metadata as any).planText=changed;
                await expect(prepareJobInspection(f.display,new AbortController().signal)).rejects.toThrow('PLAN_TEXT_SOURCE_MISMATCH');
            }
            (f.metadata as any).planText={...projection,extra:true};
            await expect(prepareJobInspection(f.display,new AbortController().signal)).rejects.toThrow('PLAN_TEXT_METADATA_INVALID');
        } finally {await f.close();}
    });

    test('#629 missing evidence keeps legacy record preparation manifest-free without evidence fetch', async () => {
        const f = await setup('plan', true);
        try {
            const ready = await prepareJobInspection(f.display, new AbortController().signal);
            expect(ready.metadata.manifest).toBeUndefined();
            expect(ready.checkpointEvidence).toEqual([]);
            expect(f.requests).toHaveLength(1); ready.dispose();
        } finally {await f.close();}
    });
    test('#629 declaration metadata mutants refuse under unchanged publication sourceHash in both branches', async () => {
        for (const kind of ['plan', 'package'] as const) {
            const f = await setup(kind);
            const original = structuredClone(f.metadata.checkpointEvidence);
            try {
                for (const mutate of [
                    (p: any) => {p[0].tiles[0].label += '!';}, (p: any) => {p[0].tiles.reverse();},
                    (p: any) => {p[0].routesText += '!';}, (p: any) => {p[0].recommendationText += '!';},
                    (p: any) => {p[0].table.label += '!';}, (p: any) => {p[0].table.path += '!';},
                    (p: any) => {p[0].tiles[0].url = 'https://example.invalid/tile.png';},
                    (p: any) => {p[0].table.url = '/api/checkpoint-evidence/other/table';},
                    (p: any) => {p[0].planStepId = 'other';}, (p: any) => {p[0].checkpointId = 'other';},
                ]) {
                    f.metadata.checkpointEvidence = structuredClone(original); mutate(f.metadata.checkpointEvidence);
                    await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('CHECKPOINT_EVIDENCE_INVALID');
                }
                delete f.metadata.checkpointEvidence;
                await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('CHECKPOINT_EVIDENCE_INVALID');
                expect(f.images).toHaveLength(0);
            } finally {await f.close();}
        }
    });
    test('#629 undeclared injected metadata refuses instead of showing attachments', async () => {
        const f = await setup('plan', true);
        try {
            f.metadata.checkpointEvidence = [];
            await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('CHECKPOINT_EVIDENCE_INVALID');
        } finally {await f.close();}
    });
    test('#629 raw-table projection mutants refuse without changed sourceHash or raw bytes', async () => {
        const f = await setup(); const original = structuredClone(f.metadata.checkpointEvidence);
        try {
            for (const mutate of [
                (table: any) => {table.rows[0][2] = 'forged PASS';}, (table: any) => {table.rows.reverse();},
                (table: any) => {table.columns.reverse();}, (table: any) => {table.rows.pop();},
                (table: any) => {table.schema = 'changed';},
            ]) {
                f.metadata.checkpointEvidence = structuredClone(original); mutate(f.metadata.checkpointEvidence[0].table);
                await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('CHECKPOINT_EVIDENCE_TABLE_INVALID');
            }
            expect(f.images).toHaveLength(0);
        } finally {await f.close();}
    });
    for (const suffix of ['/table', '/tiles/0']) test('#629 raw seal mismatch refuses by name for ' + suffix, async () => {
        const f = await setup();
        try {
            f.bytes.set(suffix, new Uint8Array([1, 2, 3]));
            await expect(prepareJobInspection(f.display, new AbortController().signal)).rejects.toThrow('CHECKPOINT_EVIDENCE_HASH_MISMATCH');
            await Bun.sleep(1); expect([...f.revoked].sort()).toEqual([...f.created].sort());
        } finally {await f.close();}
    });
    test('#629 legacy image path preserves the original decoder rejection identity and message', async () => {
        const f = await setup('package', true); f.hold();
        const decoderError = new Error('Legacy decoder rejected the original image');
        decoderError.name = 'EncodingError';
        f.metadata.manifest.references = [{id: 'legacy-image', type: 'image',
            path: 'legacy/tiles/0', label: 'Legacy reference'}];
        try {
            const pending = prepareJobInspection(f.display, new AbortController().signal);
            const rejection = pending.then(() => null, error => error as Error);
            await until(() => f.images.length === 1);
            f.images[0]!.reject(decoderError);
            const error = await rejection;
            expect(error).toBe(decoderError);
            expect(error?.message).toBe(decoderError.message);
            expect(error?.name).toBe('EncodingError');
            expect(f.requests.some(url => url.includes('/checkpoint-evidence/'))).toBe(false);
            expect(f.revoked).toEqual(f.created);
        } finally {await f.close();}
    });
    test('#629 image decode failure and cancellation dispose every allocated URL', async () => {
        for (const cancel of [false, true]) {
            const f = await setup(); f.hold();
            try {
                const abort = new AbortController();
                const pending = prepareJobInspection(f.display, abort.signal);
                const refusal = pending.then(() => null, error => error as Error);
                await until(() => f.images.length === 4);
                if (cancel) abort.abort();
                else {f.images[0]!.reject(new Error('decoder refusal')); for (const image of f.images.slice(1)) image.resolve();}
                expect((await refusal)?.message).toBe(cancel ? 'JOB_PRELOAD_CANCELLED' : 'CHECKPOINT_EVIDENCE_PNG_INVALID');
                for (const image of f.images) image.resolve();
                await Bun.sleep(1); expect([...f.revoked].sort()).toEqual([...f.created].sort());
            } finally {await f.close();}
        }
    });
    test('#629 superseded real preparation never acknowledges stale tiles or leaks their URLs', async () => {
        const f = await setup(); f.hold();
        const acknowledged: string[] = [];
        let active: JobPreparedInspection | undefined;
        const next: DisplayPublicationV3 = {...f.display, publication: {...f.display.publication,
            publicationId: 'publication-2', generation: 2, previousPublicationId: f.display.publication.publicationId},
            routes: {entry: f.display.routes.entry.replace('publication-1', 'publication-2'),
                apiBase: f.display.routes.apiBase.replace('publication-1', 'publication-2'),
                assetsBase: f.display.routes.assetsBase.replace('publication-1', 'publication-2')}};
        const window = createJobWindow({jobId: 'window-fixture', pageId: 'evidence-page',
            transport: {readPublication: async id => ({ok: true, value: id === next.publication.publicationId ? next : f.display}),
                async acknowledge(input) {acknowledged.push(input.publicationId); return {ok: true, value: {...input, displayedNonce: 'nonce'}};},
                async submit() {throw new Error('Unused ordinary fixture submission');}},
            adapter: {prepare: prepareJobInspection, captureDraft: () => null,
                commit(prepared) {
                    const previous = active; active = prepared;
                    return {rollback() {active = previous;}, finalize() {previous?.dispose();}};
                }, painted: async () => {},
                discard: prepared => prepared.dispose(), changed() {}}});
        try {
            window.event({type: 'published', jobId: 'window-fixture', generation: 1, cursor: '1', publication: f.display.publication});
            await until(() => f.images.length === 4);
            window.event({type: 'published', jobId: 'window-fixture', generation: 2, cursor: '2', publication: next.publication});
            await until(() => f.images.length === 8);
            for (const image of f.images.slice(4)) image.resolve();
            await window.settled();
            expect(acknowledged).toEqual(['publication-2']);
            expect(window.state().displayed?.publication.publicationId).toBe('publication-2');
            for (const image of f.images.slice(0, 4)) image.resolve();
            await Bun.sleep(1);
            expect([...f.revoked].sort()).toEqual(f.created.slice(0, 4).sort());
            window.stop(); active?.dispose();
            expect([...f.revoked].sort()).toEqual([...f.created].sort());
        } finally {window.stop(); active?.dispose(); await f.close();}
    });
});
