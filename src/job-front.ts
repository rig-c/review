/** Disjoint live-job routes. The backend receives the original authenticated Request. */
import { JOB_API_SCHEMA, JOB_ACT_SCHEMA, type JobErrorCode, type JobHostPorts, type JobResult } from './job-contract.ts';
import { createJobHostPorts } from './job-api.ts';
import { JobSession } from './job-session.ts';
import type { JobWorkerOptions } from './job-worker.ts';
import { JobError } from './job-store.ts';
import { loadReview, safeFile, packagePath, type ReviewPackage } from './manifest.ts';
import { serveReference, assertReviewUnchanged } from './reference.ts';
import { loadPartsView, partsViewJson, servedImage, type PartsViewPackage } from './parts-view.ts';
import { dirname, join, relative } from 'node:path';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { acquireClaim, releaseClaim, running, smallJson } from './open.ts';
import { canonicalStatePath } from './state-dir.ts';
const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
function failure(code: string, status: number): Response {
    return Response.json({ ok: false, error: { code, message: code } }, { status, headers });
}
const errorStatus: Partial<Record<JobErrorCode, number>> = {
    JOB_REQUEST_INVALID: 400,
    JOB_BODY_LIMIT: 413,
    JOB_LOOPBACK_REQUIRED: 403,
    JOB_SAME_ORIGIN_REQUIRED: 403,
    JOB_CAPABILITY_REQUIRED: 403,
    JOB_AUTHORITY_REFUSED: 403,
    JOB_UNKNOWN: 404,
    JOB_PUBLICATION_UNKNOWN: 404,
    JOB_ACT_UNKNOWN: 404,
};
function result<Value>(value: JobResult<Value>): Response {
    const status = value.ok ? 200 : errorStatus[value.error.code] ?? 409;
    return Response.json(value, { status, headers });
}
/** A host supplies only shipped web resources. No request becomes a filesystem path. */
export function createJobFront(options: {
    origin: string;
    ports: JobHostPorts;
    hubIncarnation?: string;
    resource: (name: 'index.html' | 'job.js' | 'styles.css') => Promise<BodyInit>;
    publication?: (jobId: string, publicationId: string, instanceKey: string, path: string, request: Request) => Promise<Response>;
}) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
        throw new Error('JOB_LOOPBACK_REQUIRED');
    }
    const streams = new Set<AbortController>();
    async function fetchJob(request: Request): Promise<Response | null> {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/jobs/'))
            return null;
        if (url.origin !== origin.origin)
            return failure('JOB_LOOPBACK_REQUIRED', 403);
        const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(.*)$/.exec(url.pathname);
        if (!match)
            return failure('JOB_REQUEST_INVALID', 404);
        const jobId = match[1]!;
        const route = match[2]!;
        const sentOrigin = request.headers.get('origin');
        if (request.headers.get('sec-fetch-site') === 'cross-site' || sentOrigin !== null && sentOrigin !== origin.origin) {
            return failure('JOB_SAME_ORIGIN_REQUIRED', 403);
        }
        const read = request.method === 'GET' || request.method === 'HEAD';
        if (['api', 'ui/displayed', 'ui/acts'].includes(route)) {
            if (request.method !== 'POST' || url.search)
                return failure('JOB_REQUEST_INVALID', 405);
            if (route !== 'api' && sentOrigin !== origin.origin)
                return failure('JOB_SAME_ORIGIN_REQUIRED', 403);
            // Each method owns streaming size bounds and actual capability authentication.
            // A bearer agent request never gets reclassified as an authenticated UI act.
            if (route === 'api')
                return options.ports.handleJobApi(request);
            if (route === 'ui/displayed')
                return result(await options.ports.ackDisplayed(jobId, request));
            return result(await options.ports.commitUIAct(jobId, request));
        }
        if (!read)
            return failure('JOB_REQUEST_INVALID', 405);
        const liveness = await options.ports.jobLiveness(jobId);
        if (!liveness.ok)
            return result(liveness);
        if (route === 'events' && request.method === 'GET') {
            const keys = [...url.searchParams.keys()];
            if (keys.length > 1 || keys.some(key => key !== 'after'))
                return failure('JOB_CURSOR_INVALID', 400);
            const after = url.searchParams.get('after');
            if (after !== null && (!after || after.length > 256))
                return failure('JOB_CURSOR_INVALID', 400);
            const abort = new AbortController();
            streams.add(abort);
            const stop = () => { abort.abort(); streams.delete(abort); request.signal.removeEventListener('abort', stop); };
            request.signal.addEventListener('abort', stop, { once: true });
            if (request.signal.aborted)
                stop();
            const iterator = options.ports.subscribeJob({ jobId, after, signal: abort.signal })[Symbol.asyncIterator]();
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const next = await iterator.next();
                        if (next.done) {
                            stop();
                            controller.close();
                        }
                        else {
                            controller.enqueue(encoder.encode(JSON.stringify(next.value) + '\n'));
                            if (next.value.type === 'closed') {
                                stop();
                                controller.close();
                                await iterator.return?.();
                            }
                        }
                    }
                    catch {
                        stop();
                        controller.error(new Error('JOB_STREAM_FAILED'));
                    }
                },
                async cancel() { stop(); await iterator.return?.(); },
            });
            return new Response(body, { headers: { ...headers, 'Content-Type': 'application/x-ndjson' } });
        }
        const embedded = route === '' && url.searchParams.has('hub');
        if (embedded) {
            if (!options.hubIncarnation || url.searchParams.get('hub') !== options.hubIncarnation ||
                [...url.searchParams.keys()].some(key => !['hub', 'lang'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
                url.searchParams.has('lang') && !['en', 'ko'].includes(url.searchParams.get('lang')!)) {
                return failure('JOB_REQUEST_INVALID', 400);
            }
        } else if (url.search && !(route === '' && ['?lang=en', '?lang=ko'].includes(url.search))) {
            return failure('JOB_REQUEST_INVALID', 400);
        }
        const instance = /^publications\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/instances\/([a-f0-9]{64})\/(.*)$/.exec(route);
        if (instance && options.publication) {
            return options.publication(jobId, instance[1]!, instance[2]!, instance[3]!, request);
        }
        const publication = /^publications\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(route);
        if (publication)
            return result(await options.ports.readPublication(jobId, publication[1]!));
        const name = route === '' ? 'index.html' : route === 'job.js' ? 'job.js' : route === 'styles.css' ? 'styles.css' : null;
        if (!name)
            return failure('JOB_REQUEST_INVALID', 404);
        const type = name === 'index.html' ? 'text/html; charset=utf-8' : name === 'job.js' ? 'text/javascript' : 'text/css';
        return new Response(request.method === 'HEAD' ? null : await options.resource(name), {
            headers: { ...headers, 'Content-Type': type, ...(embedded ? {
                'Content-Security-Policy': headers['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
            } : {}) },
        });
    }
    return {
        fetch: fetchJob,
        stop() { for (const stream of streams)
            stream.abort(); streams.clear(); },
    };
}
/** Installed files are fixed here. A job request never selects a local pathname. */
export function jobWindowResources() {
    let bundle: Promise<Blob> | null = null;
    return async (name: 'index.html' | 'job.js' | 'styles.css'): Promise<BodyInit> => {
        if (name === 'index.html') {
            return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                '<title>rig-review</title><link rel="stylesheet" href="styles.css"></head>' +
                '<body data-job-window><script type="module" src="job.js"></script></body></html>';
        }
        if (name === 'styles.css')
            return Bun.file(new URL('../web/styles.css', import.meta.url));
        bundle ??= buildJobWindow();
        return bundle;
    };
}
export async function buildJobWindow(): Promise<Blob> {
    const source = new URL('../web/job-session.ts', import.meta.url).pathname;
    const result = await Bun.build({ entrypoints: [source], target: 'browser', format: 'esm', minify: false });
    if (!result.success)
        throw new Error(result.logs.map(log => log.message).join('\n'));
    const output = result.outputs.find(output => output.path.endsWith('.js'));
    if (!output)
        throw new Error('JOB_WINDOW_BUNDLE_MISSING');
    return output;
}

interface RetainedView {
    review: ReviewPackage;
    parts: PartsViewPackage | null;
}

/** The host reads only the committed retained snapshot and its sealed file inventory. */
function retainedPublicationRoutes(session: JobSession) {
    const views = new Map<string, Promise<RetainedView>>();
    return async (jobId: string, publicationId: string, key: string, path: string, request: Request): Promise<Response> => {
        if (jobId !== session.jobId) return failure('JOB_UNKNOWN', 404);
        try {
            const display = session.displayPublication(publicationId);
            if (key !== display.publication.instanceKey) return failure('JOB_DISPLAY_MISMATCH', 409);
            const retained = session.retainedSource(publicationId);
            let pending = views.get(publicationId);
            if (!pending) {
                pending = (async () => {
                    const review = await loadReview(retained.manifestPath);
                    const parts = retained.source.parts
                        ? await loadPartsView(dirname(join(retained.snapshotRoot, retained.source.parts.manifest.path)))
                        : null;
                    if (parts) {
                        if (parts.items.length !== retained.partIds.length || parts.items.some(item => !retained.partIds.includes(item.name))) {
                            throw new JobError('JOB_SOURCE_MISMATCH');
                        }
                        for (const file of [...parts.files, ...parts.flagFiles]) {
                            const path = relative(retained.snapshotRoot, file.abs).split('\\').join('/');
                            if (!retained.seals.some(seal => seal.path === path && seal.sha256 === file.sha256)) {
                                throw new JobError('JOB_SOURCE_UNRETAINABLE');
                            }
                        }
                    }
                    return {review, parts};
                })();
                views.set(publicationId, pending);
            }
            const {review, parts} = await pending;
            await assertReviewUnchanged(review);
            const json = (value: unknown) => new Response(request.method === 'HEAD' ? null : JSON.stringify(value), {
                headers: {...headers, 'Content-Type': 'application/json'},
            });
            const sealedFile = async (relativePath: string) => {
                const seal = retained.seals.find(file => file.path === relativePath);
                if (!seal) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                const file = await safeFile(retained.snapshotRoot, relativePath);
                return serveReference(request, file, seal.sha256, headers);
            };
            if (path === 'api/review') {
                return json({
                    manifest: review.manifest,
                    sourceHash: retained.source.sourceHash,
                    reviewedSource: review.reviewedSource,
                    initialAnimation: null,
                    setsHash: review.setsHash,
                    direction: review.direction,
                    referenceHashes: review.referenceHashes,
                    sourcePainting: review.sourcePainting && {...review.sourcePainting, url: '/review-painting'},
                    feedbackCatalog: review.feedbackCatalog,
                    assetsBase: display.routes.assetsBase,
                    capabilities: {playback: !!review.manifest.model, interview: retained.questions.length > 0,
                        preRig: retained.source.selector?.kind === 'draft', modeling: false, motion: false, feedback: true, audio: false},
                });
            }
            if (path === 'api/interview') {
                return json({questions: retained.questions.map(question => ({...question,
                    images: question.images.map((image, index) => ({name: image.name,
                        url: `/api/interview/image/${question.ref.sha256}/${index}`})),
                }))});
            }
            const interview = /^api\/interview\/image\/([a-f0-9]{64})\/(0|[1-9]\d*)$/.exec(path);
            if (interview) {
                const image = retained.questions.find(question => question.ref.sha256 === interview[1])?.images[Number(interview[2])];
                if (!image) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                return await sealedFile(image.ref.path);
            }
            const imageSetImage = /^api\/image-set\/(0|[1-9]\d*)$/.exec(path);
            if (imageSetImage && retained.source.subject === 'image-set') {
                const image = retained.source.imageSet.images[Number(imageSetImage[1])];
                if (!image) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                return await sealedFile(image.path);
            }
            if (path === 'api/stage-parts') {
                if (!parts) return failure('JOB_SOURCE_UNRETAINABLE', 409);
                return json({...partsViewJson(parts, {verdict: null, stale: null}), sourceHash: retained.source.sourceHash,
                    inspectionSourceHash: retained.source.sourceHash, readOnly: true});
            }
            const part = /^api\/stage-parts\/(image|page)\/(0|[1-9]\d*)$/.exec(path);
            if (part && parts) {
                const file = servedImage(parts, part[1] as 'image' | 'page', Number(part[2]));
                if (!file) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                return await sealedFile(relative(retained.snapshotRoot, file).split('\\').join('/'));
            }
            if (path === 'review-painting' && review.sourcePainting && review.handoff?.source) {
                return await sealedFile(relative(retained.snapshotRoot, review.handoff.source).split('\\').join('/'));
            }
            if (path.startsWith('assets/')) {
                const asset = packagePath(decodeURIComponent(path.slice('assets/'.length)));
                if (!review.files.has(asset)) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                return await sealedFile(relative(retained.snapshotRoot, join(review.root, asset)).split('\\').join('/'));
            }
            return failure('JOB_REQUEST_INVALID', 404);
        } catch (error) {
            return failure(error instanceof JobError ? error.code : 'JOB_SOURCE_MISMATCH', 409);
        }
    };
}

export interface JobHostRecord {
    schema: 'rig-review-job-host/1';
    apiSchema: typeof JOB_API_SCHEMA;
    actSchema: typeof JOB_ACT_SCHEMA;
    partsEnumeratorId: string | null;
    partsEnumeratorVersion: string | null;
    jobId: string;
    origin: string;
    fingerprint: string;
    pid: number;
    /** Absent on older records whose hook identity cannot be established. */
    readerId?: string | null;
    bindingId?: string | null;
}

/** Callers declare stable hook semantics. Equal IDs permit reuse across processes. */
export interface JobHostOptions extends JobWorkerOptions {
    readonly readerId?: string;
    readonly bindingId?: string;
    readonly partsEnumeratorId?: string;
}

type JobHostOptionName = 'readPublished' | 'installWriterBinding' | 'partsEnumerator' |
    'partsEnumeratorVersion' | 'apiSchema' | 'actSchema';

class JobHostOptionError extends Error {
    constructor(
        readonly code: 'JOB_HOST_OPTION_ID_INVALID' | 'JOB_HOST_REUSE_MISMATCH',
        readonly option: JobHostOptionName,
        readonly listenerId: string | null | undefined,
        readonly requestedId: string | null | undefined,
    ) {
        const previous = JSON.stringify(listenerId) ?? '<unrecorded>';
        const requested = JSON.stringify(requestedId) ?? '<unrecorded>';
        super(`${code}: ${option} (listener=${previous}, requested=${requested})`);
        this.name = 'JobHostOptionError';
    }
}

function declaredHostId(option: JobHostOptionName, hook: unknown, id: string | undefined): string | null {
    if (hook === undefined && id === undefined) return null;
    if (typeof hook !== 'function' || typeof id !== 'string' || id.length === 0) {
        throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', option, null, id);
    }
    return id;
}

export interface JobOwnerHost {
    readonly session: JobSession;
    readonly ports: JobHostPorts;
    readonly origin: string;
    readonly ownerUrl: string;
    readonly reused: boolean;
    stop(): void;
}

export function jobHostIdentity(startup: JobHostOptions) {
    const readerId = declaredHostId('readPublished', startup.readPublished, startup.readerId);
    const bindingId = declaredHostId('installWriterBinding', startup.installWriterBinding, startup.bindingId);
    const partsEnumeratorId = declaredHostId('partsEnumerator', startup.partsEnumerator?.enumerate, startup.partsEnumeratorId);
    const partsEnumeratorVersion = startup.partsEnumerator?.version ?? null;
    return {readerId, bindingId, partsEnumeratorId, partsEnumeratorVersion};
}

export async function installJobWriterBinding(session: JobSession, startup: JobHostOptions, origin: string): Promise<void> {
    try {await startup.installWriterBinding?.({...session.writerGrant(), origin});}
    catch {throw new JobError('JOB_AUTHORITY_REFUSED', 'Writer binding installation failed');}
}

export function assertJobHostCompatible(record: JobHostRecord, identity: ReturnType<typeof jobHostIdentity>): void {
    for (const [option, actual, requested] of [
        ['readPublished', record.readerId, identity.readerId],
        ['installWriterBinding', record.bindingId, identity.bindingId],
        ['partsEnumerator', record.partsEnumeratorId, identity.partsEnumeratorId],
        ['partsEnumeratorVersion', record.partsEnumeratorVersion, identity.partsEnumeratorVersion],
        ['apiSchema', record.apiSchema, JOB_API_SCHEMA],
        ['actSchema', record.actSchema, JOB_ACT_SCHEMA],
    ] as const) {
        if (actual !== requested) {
            throw new JobHostOptionError('JOB_HOST_REUSE_MISMATCH', option, actual, requested);
        }
    }
}

/** One live job request context. Its caller owns the listener and session lifetime. */
export function createJobRequestContext(session: JobSession, startup: JobHostOptions, origin: string,
    identity: ReturnType<typeof jobHostIdentity>, resource = jobWindowResources(), hubIncarnation?: string) {
    const ports = createJobHostPorts(session, origin);
    const record: JobHostRecord = {schema: 'rig-review-job-host/1', apiSchema: JOB_API_SCHEMA, actSchema: JOB_ACT_SCHEMA,
        ...identity, jobId: session.jobId, origin, fingerprint: startup.fingerprint, pid: process.pid};
    const front = createJobFront({origin, ports, resource, hubIncarnation, publication: retainedPublicationRoutes(session)});
    let requests = 0;
    return {
        ports, record,
        get busy() {return requests > 0 || session.busy;},
        async fetch(request: Request): Promise<Response> {
            requests++;
            try {
                const url = new URL(request.url);
                if (url.pathname === `/jobs/${session.jobId}/host`) {
                    if (url.origin !== origin || request.method !== 'GET' || url.search ||
                        request.headers.get('sec-fetch-site') === 'cross-site' ||
                        request.headers.get('origin') !== null && request.headers.get('origin') !== origin) return failure('JOB_REQUEST_INVALID', 403);
                    try {session.authorize('ui', request.headers.get('X-Review-Capability'));}
                    catch {return failure('JOB_CAPABILITY_REQUIRED', 403);}
                    return Response.json(record, {headers});
                }
                return await front.fetch(request) ?? failure('JOB_REQUEST_INVALID', 404);
            } finally {requests--;}
        },
        stop() {front.stop();},
    };
}

/** Full standing owner host. #489 can publish this seam after its own contract review. */
export async function startJobHost(options: JobHostOptions): Promise<JobOwnerHost> {
    const startup = {...options};
    const identity = jobHostIdentity(startup);
    const session = new JobSession(startup);
    const installBinding = (origin: string) => installJobWriterBinding(session, startup, origin);
    const credentials = session.hostCredentials();
    const control = join(canonicalStatePath(startup.stateDir), 'job-ui');
    await mkdir(control, {recursive: true, mode: 0o700}).catch(error => {session.dispose(); throw error;});
    const recordPath = join(control, session.jobId + '.json');
    let previousPort = 0;
    const reuse = async (): Promise<JobHostRecord | null> => {
        try {
            const info = await lstat(recordPath);
            if (!info.isFile() || (info.mode & 0o077) !== 0) throw new JobError('JOB_AUTHORITY_REFUSED');
            const row = await smallJson(recordPath) as JobHostRecord;
            const origin = new URL(row.origin);
            if (row.schema !== 'rig-review-job-host/1' || row.jobId !== session.jobId || row.fingerprint !== startup.fingerprint ||
                origin.origin !== row.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
                !Number.isSafeInteger(row.pid) || row.pid <= 0) throw new JobError('JOB_STORAGE_FAILED');
            previousPort = Number(origin.port);
            if (!running(row.pid)) return null;
            const response = await fetch(row.origin + `/jobs/${session.jobId}/host`, {
                headers: {'X-Review-Capability': credentials.ui}, redirect: 'error', signal: AbortSignal.timeout(1500),
            }).catch(() => null);
            if (!response?.ok) {void response?.body?.cancel(); return null;}
            const value = await response.json() as JobHostRecord;
            if (value.schema !== row.schema || value.jobId !== row.jobId || value.fingerprint !== row.fingerprint) return null;
            assertJobHostCompatible(row, identity);
            assertJobHostCompatible(value, identity);
            return row;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
    };
    const nonce = randomUUID();
    let claim: string | null = null;
    let stop: (() => void) | null = null;
    try {
        const ready = await reuse();
        const acquired = ready ? {row: ready} : await acquireClaim(control, 'job-' + session.jobId, nonce, reuse,
            performance.now() + 20_000, 'JOB_STORAGE_FAILED');
        if ('row' in acquired) {
            const origin = acquired.row.origin;
            const ports = createJobHostPorts(session, origin);
            await installBinding(origin);
            return {session, ports, origin, ownerUrl: origin + `/jobs/${session.jobId}/#cap=${credentials.ui}`,
                reused: true, stop: () => session.dispose()};
        }
        claim = acquired.claim;
        let context: ReturnType<typeof createJobRequestContext>;
        const preferredPort = startup.port ?? previousPort;
        const server = Bun.serve({hostname: '127.0.0.1', port: preferredPort, idleTimeout: 0,
            fetch(request) {return context.fetch(request);},
        });
        const origin = `http://127.0.0.1:${server.port}`;
        context = createJobRequestContext(session, startup, origin, identity);
        const {ports, record} = context;
        const closed = new AbortController();
        let stopped = false;
        stop = () => {
            if (stopped) return;
            stopped = true;
            closed.abort();
            context.stop();
            server.stop(true);
            session.dispose();
        };
        await installBinding(origin);
        const temporary = recordPath + '.' + nonce + '.tmp';
        await writeFile(temporary, JSON.stringify(record), {flag: 'wx', mode: 0o600});
        await rename(temporary, recordPath);
        void (async () => {
            try {
                for await (const event of session.subscribe({jobId: session.jobId, after: null, signal: closed.signal})) {
                    if (event.type === 'closed') {
                        while (session.busy && !closed.signal.aborted) await Bun.sleep(25);
                        if (!closed.signal.aborted) setTimeout(() => stop?.(), 250);
                        return;
                    }
                }
            } catch { /* Shutdown aborts the subscription. */ }
        })();
        return {session, ports, origin, ownerUrl: origin + `/jobs/${session.jobId}/#cap=${credentials.ui}`, reused: false, stop};
    } catch (error) {
        if (stop) stop(); else session.dispose();
        throw error;
    } finally {
        if (claim) await releaseClaim(claim, nonce);
    }
}
