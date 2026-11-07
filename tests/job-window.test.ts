import { describe, expect, test } from 'bun:test';
import { createJobWindow, createJobReferenceSelection, prepareJobForms, jobCheckpointContext, jobPublicationRoutes, jobWindowAccess, jobWindowEvents, jobWindowRefusal, type JobWindowState } from '../web/job-session.ts';
import type { JobDisplayPublication, JobDisplayReceipt, JobResult } from '../src/job-contract.ts';
import { createJobWindowFixture, fixturePublication, fixtureAct } from './helpers/job-window-fixture.ts';
import {t} from '../web/i18n.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';

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
        display: JobDisplayPublication;
        draft: {
            words: string;
        };
    } | null = null;
    let preparation: ((display: JobDisplayPublication, signal: AbortSignal) => Promise<void>) | null = null;
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
        async publish(index: number, source?: JobDisplayPublication['publication']['source']) {
            const display = fixturePublication(index);
            if (source)
                Object.assign(display, { publication: { ...display.publication, source } });
            fixture.publish(display);
            window.event(fixture.events.at(-1)!);
            await window.settled();
            return display;
        },
    };
}
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
                'draft/parts/alternate.png', 'draft/parts/attachment.png', 'draft/parts/base.png', 'draft/parts/depth.png',
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
import { readFile } from 'node:fs/promises';
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
    const first = fixtureAct('review-verdict').source;
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
