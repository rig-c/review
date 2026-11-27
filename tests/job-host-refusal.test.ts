import {expect, spyOn, test} from 'bun:test';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startJobHost, type JobHostOptions} from '../src/job-host.ts';
import {jobBodyLimit} from '../src/job-api.ts';
import {jobCaptureBodyLimit, jobStillByteLimit} from '../src/job-contract.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillInput} from './helpers/job-rig-still.ts';

const route = '/jobs/:jobId/ui/acts';
const privateText = 'synthetic private text 한글';
const oversized = JSON.stringify({text: privateText + 'x'.repeat(jobBodyLimit)});
const bytes = (body: string) => Buffer.byteLength(body);

for (const custom of [false, true]) test(`#817 oversized owner submit reports exactly once via ${custom ? 'hook' : 'stdout'}`, async () => {
    const f = await jobFixture();
    const events: unknown[] = [];
    const stdout = spyOn(console, 'log').mockImplementation(() => {});
    const host = await startJobHost({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner'}, port: 0,
        ...(custom ? {onRefusal: (event: unknown) => events.push(event)} : {})});
    try {
        const response = await fetch(host.origin + `/jobs/${host.session.jobId}/ui/acts`, {
            method: 'POST', headers: {Origin: host.origin, 'Content-Type': 'application/json',
                'X-Review-Capability': f.credentials.ui}, body: oversized,
        });
        expect(response.status).toBe(413);
        expect((await response.json()).error.code).toBe('JOB_BODY_LIMIT');
        const expected = {code: 'JOB_BODY_LIMIT', route, bytes: bytes(oversized), limit: jobBodyLimit};
        expect(events).toEqual(custom ? [expected] : []);
        expect(stdout.mock.calls).toEqual(custom ? [] : [[JSON.stringify(expected)]]);
        const output = JSON.stringify({events, calls: stdout.mock.calls});
        expect(output).not.toContain(privateText);
        expect(output).not.toContain(f.credentials.ui);
    } finally {
        host.stop();
        stdout.mockRestore();
        await f.close();
    }
});

test('#817 HTTP owner refusals preserve response and report sanitized metadata', async () => {
    const f = await jobFixture();
    type Refusal = Parameters<NonNullable<JobHostOptions['onRefusal']>>[0];
    const events: Refusal[] = [];
    const expected: Refusal[] = [];
    const host = await startJobHost({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner'}, port: 0, onRefusal(event) {
            events.push(event);
            throw new Error('observer failure');
        }});
    const url = host.origin + `/jobs/${host.session.jobId}/ui/acts`;
    const headers = {Origin: host.origin, 'Content-Type': 'application/json', 'X-Review-Capability': f.credentials.ui};
    const post = (path: string, body: string | undefined, overrides: Record<string, string> = {}) =>
        fetch(path, {method: 'POST', headers: {...headers, ...overrides}, body});
    async function refused(response: Promise<Response>, status: number, code: string, count: number, limit?: number) {
        const result = await response;
        expect(result.status).toBe(status);
        expect((await result.json()).error.code).toBe(code);
        expected.push({code, route, bytes: count, ...(limit === undefined ? {} : {limit})});
    }
    try {
        const text = JSON.stringify(privateText);
        await refused(post(url, text, {Origin: 'https://example.invalid'}), 403, 'JOB_SAME_ORIGIN_REQUIRED', 0);
        await refused(post(url, text, {'Sec-Fetch-Site': 'cross-site'}), 403, 'JOB_SAME_ORIGIN_REQUIRED', 0);
        const missingOrigin = {...headers} as Partial<typeof headers>;
        delete missingOrigin.Origin;
        await refused(fetch(url, {method: 'POST', headers: missingOrigin, body: text}), 403, 'JOB_SAME_ORIGIN_REQUIRED', 0);
        await refused(post(url + '?secret=' + f.credentials.ui, text), 405, 'JOB_REQUEST_INVALID', 0);
        await refused(post(url.replace(host.session.jobId, 'unknown-job'), text), 404, 'JOB_UNKNOWN', 0);
        await refused(post(url, text, {'X-Review-Capability': f.credentials.agent}), 403, 'JOB_CAPABILITY_REQUIRED', 0);
        await refused(post(url, text, {'Content-Type': 'text/plain'}), 400, 'JOB_REQUEST_INVALID', 0);
        await refused(post(url, undefined), 400, 'JOB_REQUEST_INVALID', 0);
        await refused(post(url, text + '{'), 400, 'JOB_REQUEST_INVALID', bytes(text) + 1);
        const mesh = JSON.stringify({value: {meshEdits: 'x'.repeat(jobBodyLimit)}});
        await refused(post(url, mesh), 413, 'JOB_BODY_LIMIT', bytes(mesh), jobBodyLimit);
        const capture = JSON.stringify({capture: 'x'.repeat(jobCaptureBodyLimit)});
        // This request is exactly one byte above the streaming cap.
        const overflow = capture.slice(0, jobCaptureBodyLimit + 1);
        await refused(post(url, overflow), 413, 'JOB_BODY_LIMIT', bytes(overflow), jobCaptureBodyLimit);

        const publication = await f.publish();
        // #1235: the sample act is the comment-only act@10; ask refusals use the rig verdict below.
        const page = await f.display(publication);
        const input = {...page, expectedGeneration: host.session.status().generation,
            submissionId: 'owner-submit', kind: 'comments', value: {comments: [{text: privateText}]}};
        const refuseAct = async (patch: object, code: string, status = 409) => {
            const body = JSON.stringify({...input, ...patch});
            await refused(post(url, body), status, code, bytes(body));
        };
        await refuseAct({kind: 'mesh-edit'}, 'JOB_ACT_KIND_DISABLED');
        await refuseAct({expectedGeneration: input.expectedGeneration + 1}, 'JOB_GENERATION_STALE');
        await refuseAct({displayedNonce: 'unknown-nonce'}, 'JOB_DISPLAY_MISMATCH');
        await refuseAct({value: {comments: []}}, 'JOB_ACT_INVALID');
        const manifestPath = join(f.root, 'out/review.json');
        const manifest = await readFile(manifestPath);
        try {
            await writeFile(manifestPath, JSON.stringify({...JSON.parse(manifest.toString()), revision: 'changed-source'}));
            await refuseAct({}, 'JOB_SOURCE_MISMATCH');
        } finally {
            await writeFile(manifestPath, manifest);
        }
        const previous = events.length;
        for (let i = 0; i < 2; i++) expect((await post(url, JSON.stringify(input))).status).toBe(200);
        expect((await post(url.replace('/ui/acts', '/ui/displayed'), '{}')).status).toBe(400);
        expect((await post(url.replace('/ui/acts', '/api'), '{}')).status).toBe(400);
        expect(events).toHaveLength(previous);
        await refuseAct({value: {comments: [{text: 'Changed'}]}}, 'JOB_IDEMPOTENCY_CONFLICT');
        await f.publish();
        await refuseAct({submissionId: 'stale-owner-submit'}, 'JOB_ACT_SOURCE_STALE');

        const rig = await rigStillInput(f);
        const beforeVerdicts = host.session.status();
        const {capture: _capture, ...withoutCapture} = rig.input;
        const largePng = 'data:image/png;base64,' + Buffer.alloc(jobStillByteLimit + 1).toString('base64');
        for (const submission of [
            rig.input,
            {...rig.input, capture: {...rig.input.capture, png: largePng}},
            {...withoutCapture, kind: 'parts-verdict', value: {verdict: 'approved', issues: [], words: privateText}},
        ]) {
            const body = JSON.stringify(submission);
            await refused(post(url, body), 409, 'JOB_ACT_KIND_DISABLED', bytes(body));
        }
        expect(host.session.status()).toEqual(beforeVerdicts);
        expect(JSON.stringify(events)).not.toContain(privateText);

        await f.call({...f.base(), verb: 'close', expectedGeneration: host.session.status().generation,
            idempotencyKey: 'close-job', reason: 'synthetic done'});
        await refused(post(url, JSON.stringify(input)), 409, 'JOB_CLOSED', 0);
        expect(events).toEqual(expected);
    } finally {
        host.stop();
        await f.close();
    }
});

test('#817 ordinary and strict reuse leave refusal reporting with the listener', async () => {
    const f = await jobFixture();
    const listenerEvents: unknown[] = [], attachingEvents: unknown[] = [];
    const options = {root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner' as const}};
    const listener = await startJobHost({...options, onRefusal: event => listenerEvents.push(event)});
    try {
        expect(listener.attachment).not.toBeNull();
        for (const reuseOnly of [undefined, {expected: listener.attachment!}]) {
            const attached = await startJobHost({...options, reuseOnly, onRefusal: event => attachingEvents.push(event)});
            try {
                expect(attached.reused).toBe(true);
                const response = await fetch(attached.origin + `/jobs/${attached.session.jobId}/ui/acts`, {
                    method: 'POST', headers: {Origin: attached.origin, 'Content-Type': 'application/json',
                        'X-Review-Capability': f.credentials.ui}, body: '{}',
                });
                expect(response.status).toBe(400);
                expect((await response.json()).error.code).toBe('JOB_REQUEST_INVALID');
            } finally {attached.stop();}
        }
        expect(listenerEvents).toEqual(Array(2).fill({code: 'JOB_REQUEST_INVALID', route, bytes: 2}));
        expect(attachingEvents).toEqual([]);
    } finally {
        listener.stop();
        await f.close();
    }
});
