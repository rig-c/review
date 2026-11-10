/** Lane B's frozen-port fake. This proves window behavior, never backend authority. */
import { JOB_ACT_SCHEMA, JOB_PARTS_VERDICT_ACT_SCHEMA, JOB_API_SCHEMA } from '../../src/job-contract.ts';
import type { ActV3, DisplayPublicationV3, EventV3, JobAct, JobDisplayPublication, JobDisplayReceipt, JobEvent, JobHostPorts, JobPendingAsk, JobPublication, JobResult, JobSourceBinding, JobEnabledActKind, JobActValues, PendingAskV3, } from '../../src/job-contract.ts';
export function fixturePublication(index = 1): JobDisplayPublication {
    const hash = String(index).padStart(64, '0');
    const source: JobSourceBinding = {
        sourceHash: hash,
        projectHash: 'a'.repeat(64),
        package: { id: 'window-fixture', revision: String(index) },
        selector: { kind: 'rig', version: index },
        model: { path: 'build/skeleton.model.json', sha256: hash },
        direction: null,
        optionSet: null,
        appliedResult: null,
        plan: null,
        parts: null,
    };
    const publication: JobPublication = {
        publicationId: `publication-${index}`,
        instanceKey: hash,
        generation: index,
        source,
        label: `Rig ${index}`,
        previousPublicationId: index > 1 ? `publication-${index - 1}` : null,
        visual: { status: 'available' },
    };
    const entry = `/jobs/window-fixture/publications/${publication.publicationId}/instances/${hash}/`;
    return { publication, routes: { entry, apiBase: entry + 'api/', assetsBase: entry + 'assets/' } };
}
export function createJobWindowFixture(jobId = 'window-fixture') {
    const publications = new Map<string, DisplayPublicationV3>();
    const events: EventV3[] = [];
    const acknowledgments: {
        request: Request;
        body: unknown;
    }[] = [];
    const submissions: {
        request: Request;
        body: unknown;
    }[] = [];
    const apiRequests: Request[] = [];
    const listeners = new Set<() => void>();
    let active = true;
    let acknowledgeFailure: JobResult<JobDisplayReceipt> | null = null;
    let submittedAct: ActV3 | null = null;
    function append(event: EventV3): void {
        events.push(structuredClone(event));
        for (const listener of listeners)
            listener();
    }
    const ports: Omit<JobHostPorts, 'subscribeJob' | 'readPublication' | 'commitUIAct'> & {
        subscribeJob(options: { jobId: string; after: string | null; signal: AbortSignal }): AsyncIterable<EventV3>;
        readPublication(jobId: string, publicationId: string): Promise<JobResult<DisplayPublicationV3>>;
        commitUIAct(jobId: string, request: Request): Promise<JobResult<ActV3>>;
    } = {
        async handleJobApi(request) {
            apiRequests.push(request);
            return Response.json({ fixture: true }, { status: 501 });
        },
        async *subscribeJob({ jobId: requestedJob, after, signal }) {
            if (requestedJob !== jobId)
                return;
            let position = after === null ? 0 : events.findIndex(event => event.cursor === after) + 1;
            if (after !== null && position === 0)
                throw new Error('JOB_CURSOR_INVALID');
            while (!signal.aborted) {
                const event = events[position];
                if (event) {
                    position++;
                    yield structuredClone(event);
                    continue;
                }
                await new Promise<void>(resolve => {
                    const wake = () => {
                        listeners.delete(wake);
                        signal.removeEventListener('abort', wake);
                        resolve();
                    };
                    listeners.add(wake);
                    signal.addEventListener('abort', wake, { once: true });
                    if (signal.aborted || events[position])
                        wake();
                });
            }
        },
        async readPublication(requestedJob, publicationId) {
            const value = requestedJob === jobId ? publications.get(publicationId) : undefined;
            return value ? { ok: true, value: structuredClone(value) } : {
                ok: false, error: { code: 'JOB_PUBLICATION_UNKNOWN', message: 'Unknown fixture publication' },
            };
        },
        async commitUIAct(_jobId, request) {
            submissions.push({ request, body: await request.json() });
            return submittedAct ? { ok: true, value: structuredClone(submittedAct) } : {
                ok: false, error: { code: 'JOB_ACT_INVALID', message: 'No fixture act configured' },
            };
        },
        async ackDisplayed(_jobId, request) {
            const body = await request.json() as {
                publicationId: string;
                pageId: string;
            };
            acknowledgments.push({ request, body });
            return acknowledgeFailure ?? { ok: true, value: {
                    publicationId: body.publicationId, pageId: body.pageId,
                    displayedNonce: `nonce-${body.publicationId}-${body.pageId}`,
                } };
        },
        async jobLiveness(requestedJob) {
            return requestedJob === jobId ? { ok: true, value: { active, busy: false } } : {
                ok: false, error: { code: 'JOB_UNKNOWN', message: 'Unknown fixture job' },
            };
        },
    };
    return {
        jobId, ports: ports as JobHostPorts & typeof ports, publications, events, acknowledgments, submissions, apiRequests,
        publish(display: DisplayPublicationV3) {
            publications.set(display.publication.publicationId, structuredClone(display));
            append({ type: 'published', jobId, generation: display.publication.generation,
                cursor: String(events.length + 1), publication: display.publication });
        },
        pending(ask: PendingAskV3, generation: number) {
            append({ type: 'pending', jobId, generation, cursor: String(events.length + 1), ask });
        },
        close(generation: number) {
            active = false;
            append({ type: 'closed', jobId, generation, cursor: String(events.length + 1), reason: 'Explicit fixture close' });
        },
        failAcknowledgment(result: JobResult<JobDisplayReceipt> | null) { acknowledgeFailure = result; },
        returnAct(act: ActV3) { submittedAct = structuredClone(act); },
    };
}
/** C2 fixture sources carry the explicit producer-published identities verbatim. */
export function fixtureAct(kind: JobEnabledActKind, words = ''): JobAct {
    const source = {
        ...fixturePublication(1).publication.source,
        projectHash: 'a'.repeat(64),
        plan: { steps: [{ id: 'inspect-body', hash: 'b'.repeat(64) }] },
        parts: {
            enumeratorVersion: '2.25.1',
            manifest: { path: 'draft/parts.json' as const, sha256: 'c'.repeat(64) },
            images: [
                { path: 'parts/alternate.png' as const, role: 'alternate', sha256: 'd'.repeat(64) },
                { path: 'parts/attachment.png' as const, role: 'part', sha256: 'e'.repeat(64) },
                { path: 'parts/base.png' as const, role: 'part', sha256: 'f'.repeat(64) },
                { path: 'parts/depth.png' as const, role: 'depth', sha256: '9'.repeat(64) },
            ],
        },
        optionSet: { id: 'choices-one', sha256: '8'.repeat(64) },
    };
    const values: JobActValues = {
        'interview-picks': { questionId: 'shape', selections: [
                { itemId: 'body', optionId: 'other', otherText: '  원래 표현\n' },
            ], note: words },
        checkpoint: { checkpointId: 'silhouette', planStepId: 'inspect-body', outcome: 'pass', words },
        'parts-verdict': { verdict: 'approved', words, issues: [] },
        'review-verdict': { stage: 'rig-review', verdict: 'approved', words },
        signoff: { stage: 'plan-approved', decision: 'approved', words },
    };
    return {
        schema: kind === 'parts-verdict' ? JOB_PARTS_VERDICT_ACT_SCHEMA : JOB_ACT_SCHEMA, actId: 'act-' + kind, jobId: 'window-fixture', askId: 'ask-' + kind,
        publicationId: 'publication-1', kind, at: '2026-11-07T10:00:00.000Z',
        authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'fixture-owner', role: 'owner' } },
        source: { ...source, selector: kind === 'parts-verdict' ? { kind: 'draft', id: 'draft-one' } : { kind: 'rig', version: 1 } },
        value: values[kind],
    } as JobAct;
}

import {jobFixture} from './job-api-fixture.ts';
import {startJobHost} from '../../src/job-front.ts';

/** Normal full-host entry with explicitly synthetic, committed A fixture inputs. */
export async function realJobWindowFixture(options: {
    reader?: boolean;
    installWriterBinding?: Parameters<typeof startJobHost>[0]['installWriterBinding'];
} = {}) {
    const input = await jobFixture();
    const hostOptions = {root: input.root, stateDir: input.state, fingerprint: 'f'.repeat(64),
        reviewer: {id: 'declared-owner', role: 'owner' as const},
        partsEnumerator: input.partsEnumerator, partsEnumeratorId: 'synthetic-job-window-parts/1',
        installWriterBinding: options.installWriterBinding,
        ...(options.installWriterBinding ? {bindingId: 'job-window-fixture-binding/1'} : {}),
        ...(options.reader === false ? {} : {readPublished: async () => input.getContext(), readerId: 'job-window-fixture-reader/1'})};
    let host: Awaited<ReturnType<typeof startJobHost>>;
    try {host = await startJobHost(hostOptions);}
    catch (error) {await input.close(); throw error;}
    const locator = host.origin + '/jobs/' + host.session.jobId;
    const credentials = host.session.hostCredentials();
    async function call(value: unknown) {
        return fetch(locator + '/api', {method: 'POST', headers: {'Content-Type': 'application/json',
            Authorization: 'Bearer ' + credentials.agent}, body: JSON.stringify(value)});
    }
    async function publish() {
        const response = await call(await input.publishRequest());
        const result = await response.json();
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.value as import('../../src/job-contract.ts').JobPublication;
    }
    async function ui(path: 'displayed' | 'acts', value: unknown, origin = host.origin, capability = credentials.ui) {
        return fetch(locator + '/ui/' + path, {method: 'POST', headers: {'Content-Type': 'application/json',
            Origin: origin, 'X-Review-Capability': capability}, body: JSON.stringify(value)});
    }
    return {input, host, hostOptions, locator, credentials, call, publish, ui,
        async close() {host.stop(); await input.close();}};
}

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PNG} from 'pngjs';
import {jobHash} from '../../src/job-api.ts';
import {readProject} from '../../src/interview-project.ts';
import {joinedVerdictFixture} from './joined-verdict-fixture.ts';
import {PROBE_MP4_BASE64} from '../compare-mode-browser.ts';
import {writeComparisonPackage} from './parts-comparison-package.ts';

/** Declared synthetic visual/producer context over a real retained Create question.
 * It proves window transport, not Create #184 or Parts' enumerator/writer acceptance.
 */
export async function scriptedJobWindowFixture(options: {c5Parts?: 'mesh' | 'no-mesh'} = {}) {
    const f = await realJobWindowFixture();
    await joinedVerdictFixture(f.input.root, '2-rigging-answers');
    f.input.setRecordPath('project.json');
    const question = readProject(f.input.root).questions.find(item => item.editable)!;
    const packageRoot = join(f.input.root, 'out');
    const originalModel = JSON.parse(await readFile(join(packageRoot, 'skeleton.model.json'), 'utf8'));
    const originalManifest = JSON.parse(await readFile(join(packageRoot, 'review.json'), 'utf8'));
    await writeFile(join(packageRoot, 'timed-reference.mp4'), Buffer.from(PROBE_MP4_BASE64, 'base64'));
    await writeFile(join(packageRoot, 'timed-reference.pose.json'), JSON.stringify({
        spec: 'rig-pose-sequence/1', space: {units: 'picture-px', origin: 'top-left', y: 'down'},
        width: 64, height: 64, source: 'synthetic-job-window-timing',
        frames: [{t: 0, at: [12, 16]}, {t: 0.5, at: [48, 48]}].map(frame => ({
            t: frame.t, people: [{id: 'probe', joints: {point: {state: 'observed', at: frame.at, score: 1}}}],
        })),
    }));
    originalManifest.references.push(
        {id: 'timed-pose', type: 'pose', label: 'Synthetic timed pose', path: 'timed-reference.pose.json'},
        {id: 'timed-video', type: 'video', label: 'Existing timed video probe', path: 'timed-reference.mp4'},
    );
    const partBytes = await readFile(join(packageRoot, 'mesh.png'));
    const pixels = PNG.sync.read(partBytes);
    if (options.c5Parts) {
        await writeComparisonPackage(packageRoot, options.c5Parts === 'mesh');
        // The ordinary handoff loader discovers this public fixture's real painting beside its config.
        await writeFile(join(packageRoot, 'config.json'), JSON.stringify({key: 'synthetic-c5-parts'}));
    } else {
        await mkdir(join(packageRoot, 'parts'));
        await writeFile(join(packageRoot, 'parts/mesh.png'), partBytes);
        await writeFile(join(packageRoot, 'parts.json'), JSON.stringify({rig_size: [80, 64], scale_rig_per_source: 1,
            parts: [{name: 'mesh', from: 'full:mesh', x: 0, y: 0, w: pixels.width, h: pixels.height}]}));
    }
    const references = options.c5Parts ? [
        {path: 'parts/body.png', role: 'part'},
        {path: 'parts/front.png', role: 'part'},
        {path: 'painting.png', role: 'painting'},
    ] : [{path: 'parts/mesh.png', role: 'part'}];
    const images = await Promise.all(references.map(async image => ({...image,
        sha256: jobHash(await readFile(join(packageRoot, image.path)))})));
    const files = [...f.input.getContext().files];
    if (options.c5Parts === 'mesh') files.push({path: 'out/rig.json',
        sha256: jobHash(await readFile(join(packageRoot, 'rig.json')))});
    const context = {...f.input.getContext(), files,
        parts: {enumeratorVersion: f.input.partsEnumerator.version, manifest: {path: 'out/parts.json' as const,
            sha256: jobHash(await readFile(join(packageRoot, 'parts.json')))}, images},
        partIds: options.c5Parts ? ['body', 'front'] : ['mesh'],
        subjects: [...f.input.getContext().subjects, {kind: 'parts-verdict' as const, draftId: 'synthetic-parts'}],
    };
    f.input.setPartsReferences(context.parts.images.map(({path, role}) => ({path, role})));
    f.input.setContext(context);
    let generation = 0;
    let sequence = 0;
    async function agent(verb: 'publish' | 'ask' | 'next' | 'close', value: Record<string, unknown>) {
        const mutation = verb === 'next' ? {} : {expectedGeneration: generation, idempotencyKey: 'window-' + ++sequence};
        const response = await f.call({schema: JOB_API_SCHEMA, jobId: f.host.session.jobId,
            requestId: randomUUID(), verb, ...mutation, ...value});
        const result = await response.json();
        generation = result.generation;
        return result;
    }
    return {...f, question, packageRoot,
        async publish(stage: 'parts' | 'rig' | 'direction', revision: string = stage, options?: {stripShortAnimation?: boolean}) {
            await agent('next', {after: null, waitMs: 0});
            const model = structuredClone(originalModel);
            if (stage !== 'parts') model.bones.find((bone: {name: string}) => bone.name === 'mesh').x = options?.stripShortAnimation ? 20 : 19;
            if (options?.stripShortAnimation) {
                model.animations = model.animations.filter((item: {name: string}) => item.name !== 'short');
                if (model.editorOrder?.animations) {
                    model.editorOrder.animations = model.editorOrder.animations.filter((name: string) => name !== 'short');
                }
            }
            await writeFile(join(packageRoot, 'skeleton.model.json'), JSON.stringify(model));
            const manifest = {...originalManifest, title: 'Synthetic ' + revision, revision};
            const selector = stage === 'parts' ? {kind: 'draft' as const, id: 'synthetic-parts'} :
                stage === 'rig' ? {kind: 'rig' as const, version: 2} : {kind: 'post' as const, version: 3, rigVersion: 2};
            if (stage === 'direction') {
                const hash = jobHash(await readFile(join(packageRoot, 'skeleton.model.json')));
                await writeFile(join(packageRoot, 'direction.json'), JSON.stringify({schema: 'rig-create/direction@1',
                    rig: {version: 2, model: {path: 'skeleton.model.json', sha256: hash}},
                    take: {duration: 1, loop: true}, camera: {space: 'rig-world-y-up', keys: [
                        {time: 0, easing: 'hold', box: {x: 0, y: 0, width: 80, height: 64}},
                    ]}, timing: {keys: [{time: 0, source_time: 0, easing: 'linear'}, {time: 1, source_time: 1, easing: 'linear'}]}}));
                manifest.direction = 'direction.json';
            }
            await writeFile(join(packageRoot, 'review.json'), JSON.stringify(manifest));
            f.input.setContext({...f.input.getContext(), selector});
            const record = {path: 'project.json', sha256: jobHash(await readFile(join(f.input.root, 'project.json')))};
            const result = await agent('publish', {result: {path: 'out', selector},
                freeze: {kind: 'producer-held', holdId: 'scripted-window-held', record}});
            if (!result.ok) throw new Error(JSON.stringify(result));
            return result.value as JobPublication;
        },
        async ask(publication: JobPublication, subject: import('../../src/job-contract.ts').JobSubject) {
            await agent('next', {after: null, waitMs: 0});
            const result = await agent('ask', {publicationId: publication.publicationId, subject});
            if (!result.ok) throw new Error(JSON.stringify(result));
            return result.value as JobPendingAsk;
        },
        async next() {
            const result = await agent('next', {after: null, waitMs: 0});
            if (!result.ok) throw new Error(JSON.stringify(result));
            return result.value as import('../../src/job-contract.ts').JobNextValue;
        },
        async finish() {
            await agent('next', {after: null, waitMs: 0});
            const result = await agent('close', {reason: 'scripted window complete'});
            if (!result.ok) throw new Error(JSON.stringify(result));
        },
    };
}
