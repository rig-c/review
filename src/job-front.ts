import {partsDifferenceResponse} from './parts-server.ts';
import {checkpointEvidenceMetadata, readCheckpointEvidenceBytes} from './job-checkpoint-evidence.ts';
/** Disjoint live-job routes. The backend receives the original authenticated Request. */
import { JOB_API_SCHEMA, JOB_ACT_SCHEMA, type JobErrorCode, type JobHostPorts, type JobId, type JobPublicationMode, type JobResult, type JobReviewerBinding } from './job-contract.ts';
import { createJobHostPorts, jobBody, jobHash, jobId, jobObject, jobPartsEnumeratorVersion } from './job-api.ts';
import { JobSession } from './job-session.ts';
import { assertJobRoot, assertRetainedSnapshotIntact, captureJobRoot, planTextMetadata, isRetainedRecordSource, type JobRootIdentity } from './job-source.ts';
import type { JobWorkerOptions } from './job-worker.ts';
import { JobError, JobStore } from './job-store.ts';
import { loadReview, safeFile, packagePath, type ReviewPackage } from './manifest.ts';
import { serveReference, assertReviewUnchanged } from './reference.ts';
import {preparePartsComment} from './parts-comment-crops.ts';
import { loadPartsView, partsViewJson, servedImage, type PartsViewPackage } from './parts-view.ts';
import { destinationDirectory, DestinationDirectoryError } from './destination-directory.ts';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, statSync, type Stats } from 'node:fs';
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { acquireClaim, readOpenStatus, releaseClaim, running, smallJson } from './open.ts';
import { WORKSPACE_BODY_LIMIT } from './open-workspace-contract.ts';
import { canonicalStatePath } from './state-dir.ts';
const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
interface CropFailureDiagnostic {
    field: string;
    expected: string | number[];
    received: string | number[];
}
function failure(code: string, status: number, diagnostic?: CropFailureDiagnostic, message = code): Response {
    return Response.json({ ok: false, error: { code, message, ...(diagnostic ? {diagnostic} : {}) } }, { status, headers });
}

/** Explain an existing rejection without returning body text, filesystem paths or PNG bytes. */
function cropFailureDiagnostic(error: unknown, raw: unknown): CropFailureDiagnostic {
    const message = error instanceof Error ? error.message : '';
    const invariants: Record<string, [string, string]> = {
        'PARTS_COMMENT_RIG_REGION: rig region must be exact placement plus image region': ['rigRegion', 'exact placement plus imageRegion'],
        'PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds original image': ['imageRegion', 'inside original image bounds'],
        'PARTS_COMMENT_OUT_OF_BOUNDS: region exceeds union of issue parts': ['rigRegion', 'inside union of bound parts'],
        'PARTS_CAMERA_RANGE: native zoom below fit/1 minimum': ['view.camera.zoom', 'at least min(fit, 1)'],
        'PARTS_CAMERA_RANGE: native scale or camera extent': ['view.camera', 'bounded positive zoom and viewport'],
        'PARTS_COMMENT_IMAGE_SIZE: original dimensions differ from placement': ['part.image.dimensions', 'equal retained placement dimensions'],
        'PARTS_COMMENT_CROP_INVALID: bounded content-addressed crop': ['crop', 'bounded content-addressed PNG metadata'],
        'COMMENT_CROP_INVALID: bounded content-addressed PNG required': ['crop', 'bounded content-addressed PNG'],
        'COMMENT_CROP_INVALID: expected noninterlaced 8-bit RGB/RGBA': ['crop.png.format', 'noninterlaced 8-bit RGB/RGBA'],
        'COMMENT_CROP_INVALID: truncated PNG chunk': ['crop.png.chunks', 'complete chunks'],
        'COMMENT_CROP_INVALID: PNG chunk length': ['crop.png.chunk.length', 'inside PNG byte bounds'],
        'COMMENT_CROP_INVALID: PNG chunk CRC': ['crop.png.chunk.crc', 'matching CRC'],
        'COMMENT_CROP_INVALID: static PNG required': ['crop.png.animation', 'static PNG'],
        'COMMENT_CROP_INVALID: PNG end': ['crop.png.end', 'final empty IEND'],
        'COMMENT_CROP_INVALID: PNG data/end missing': ['crop.png.data', 'IDAT and IEND present'],
        'COMMENT_CROP_INVALID: bounded PNG data decode': ['crop.png.data', 'bounded decodable scanlines'],
        'COMMENT_CROP_INVALID: PNG scanlines': ['crop.png.scanlines', 'exact dimensions and valid filters'],
        'COMMENT_CROP_PATH: existing crop is not the bound regular PNG': ['crop.storage', 'regular file with matching SHA-256'],
        'COMMENT_CROP_PATH: regular state directory required': ['crop.storage', 'regular state directory'],
    };
    // Inspect metadata only after the existing validator reports this exact invariant.
    if (message === 'COMMENT_CROP_INVALID: PNG signature, dimensions or SHA-256 differ' &&
        raw && typeof raw === 'object' && 'crop' in raw) {
        const crop = raw.crop as {png?: unknown; sha256?: unknown; width?: unknown; height?: unknown} | null;
        if (crop && typeof crop.png === 'string' && crop.png.length <= 200000 &&
            typeof crop.sha256 === 'string' && /^[a-f0-9]{64}$/.test(crop.sha256)) {
            const bytes = Buffer.from(crop.png.slice('data:image/png;base64,'.length), 'base64');
            const hash = jobHash(bytes);
            if (hash !== crop.sha256) return {field: 'crop.sha256', expected: crop.sha256, received: hash};
            if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
                typeof crop.width === 'number' && typeof crop.height === 'number' &&
                (crop.width !== bytes.readUInt32BE(16) || crop.height !== bytes.readUInt32BE(20))) {
                return {field: 'crop.dimensions', expected: [crop.width, crop.height],
                    received: [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]};
            }
        }
        return {field: 'crop.png.signature', expected: 'PNG signature and IHDR', received: 'invalid'};
    }
    const invariant = Object.hasOwn(invariants, message) ? invariants[message] : undefined;
    return invariant ? {field: invariant[0], expected: invariant[1], received: 'rejected by existing validator'} :
        {field: 'partsComment.prepare', expected: 'valid source-bound crop and writable evidence state', received: 'unclassified rejection'};
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
        const partsCrop = request.method === 'POST' &&
            /^publications\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/instances\/[a-f0-9]{64}\/api\/stage-parts\/comment$/.test(route);
        if (!read && !partsCrop)
            return failure('JOB_REQUEST_INVALID', 405);
        if (partsCrop && sentOrigin !== origin.origin) return failure('JOB_SAME_ORIGIN_REQUIRED', 403);
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
            return (await Bun.file(new URL('../web/styles.css', import.meta.url)).text()) +
                '\n@scope (.job-inspection[data-job-parts-workspace]) {\n' +
                (await Bun.file(new URL('../web/parts.css', import.meta.url)).text()) + '\n}';
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
export function retainedPublicationRoutes(session: JobSession) {
    const views = new Map<string, Promise<RetainedView>>();
    return async (jobId: string, publicationId: string, key: string, path: string, request: Request): Promise<Response> => {
        if (jobId !== session.jobId) return failure('JOB_UNKNOWN', 404);
        try {
            const crop = path === 'api/stage-parts/comment' && request.method === 'POST';
            if (crop) session.authorize('ui', request.headers.get('X-Review-Capability'));
            return await session.readPublicationResponse(publicationId, async retained => {
                const display = session.displayPublication(publicationId);
                if (key !== display.publication.instanceKey) return failure('JOB_DISPLAY_MISMATCH', 409);
                if (crop && session.status().publication?.publicationId !== publicationId)
                    return failure('JOB_ACT_SOURCE_STALE', 409);
                const json = (value: Record<string, unknown>) => {
                    const payload = path === 'api/review' ? planTextMetadata(retained, value) : value;
                    const body = JSON.stringify(payload);
                    return new Response(request.method === 'HEAD' ? null : body, {
                        headers: {...headers, 'Content-Type': 'application/json'},
                    });
                };
                const sealedFile = async (relativePath: string) => {
                    const seal = retained.seals.find(file => file.path === relativePath);
                    if (!seal) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                    const file = await safeFile(retained.snapshotRoot, relativePath);
                    return serveReference(request, file, seal.sha256, headers);
                };
                const evidenceRoute = /^api\/checkpoint-evidence\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(table|tiles\/(0|[1-9]\d*))$/.exec(path);
                if (evidenceRoute) {
                    const packet = retained.source.checkpointEvidence?.find(item => item.checkpointId === evidenceRoute[1]);
                    const isTable = evidenceRoute[2] === 'table';
                    const member = isTable ? packet?.table : packet?.tiles[Number(evidenceRoute[3])];
                    if (!member) return failure('JOB_SOURCE_UNRETAINABLE', 404);
                    readCheckpointEvidenceBytes(retained.snapshotRoot, member, isTable ? 256 * 1024 : 8 * 1024 * 1024);
                    return await sealedFile(member.path);
                }
                if (isRetainedRecordSource(retained)) {
                    if (path === 'api/review') {
                        return json({
                            ...checkpointEvidenceMetadata(retained.snapshotRoot, retained.source.checkpointEvidence),
                            recordSource: retained.source,
                            sourceHash: retained.source.sourceHash,
                            assetsBase: display.routes.assetsBase,
                            capabilities: {
                                playback: false,
                                interview: retained.questions.length > 0,
                                preRig: false,
                                modeling: false,
                                motion: false,
                                feedback: true,
                                audio: false,
                            },
                            feedbackCatalog: {slots: null},
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
                    return failure('JOB_REQUEST_INVALID', 404);
                }
                let pending = views.get(publicationId);
                if (!pending) {
                    pending = (async () => {
                        const review = await loadReview(retained.manifestPath);
                        const partsRoot = retained.source.parts
                            ? dirname(join(retained.snapshotRoot, retained.source.parts.manifest.path)) : null;
                        // Forward only retained producer files. Discovery never reads the live draft.
                        const retainedFile = (path: string) => retained.seals.some(file =>
                            file.path === relative(retained.snapshotRoot, path).split('\\').join('/')) ? path : undefined;
                        const rigRoot = review.handoff?.rig ?? partsRoot;
                        const parts = partsRoot ? await loadPartsView(partsRoot, {
                            rig: rigRoot ? retainedFile(join(rigRoot, 'rig.json')) : undefined,
                            meshReport: rigRoot ? retainedFile(join(rigRoot, 'mesh_report.json')) : undefined,
                            painting: review.handoff?.source ? retainedFile(review.handoff.source) : undefined,
                            paintingRoot: retained.snapshotRoot,
                        }) : null;
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
                if (retained.checkpointEvidencePackageHash !== undefined && retained.checkpointEvidencePackageHash !== review.sourceHash) {
                    throw new JobError('JOB_SOURCE_MISMATCH');
                }
                if (path === 'api/review') {
                    return json({
                        ...checkpointEvidenceMetadata(retained.snapshotRoot, retained.source.checkpointEvidence),
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
                        capabilities: {playback: !!review.manifest.model,
                            interview: retained.questions.length > 0 ||
                                (retained.interview?.records.length ?? 0) > 0 ||
                                (retained.interview?.diagnostics.length ?? 0) > 0,
                            preRig: retained.source.selector?.kind === 'draft', modeling: false, motion: false, feedback: true, audio: false},
                    });
                }
                if (path === 'api/interview') {
                    const interview = retained.interview !== undefined ? retained.interview : display.publication.interview;
                    return json({
                        questions: retained.questions.map(question => ({...question,
                            images: question.images.map((image, index) => ({name: image.name,
                                url: `/api/interview/image/${question.ref.sha256}/${index}`})),
                        })),
                        ...(interview === undefined ? {} : {interview}),
                    });
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
                if (crop) {
                    if (!parts) return failure('JOB_SOURCE_UNRETAINABLE', 409);
                    if (request.headers.get('origin') !== new URL(request.url).origin)
                        return failure('JOB_SAME_ORIGIN_REQUIRED', 403);
                    const raw = await jobBody(request);
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
                        (raw as {sourceHash?: unknown}).sourceHash !== retained.source.sourceHash)
                        return failure('JOB_ACT_SOURCE_STALE', 409);
                    // Preserve the exact displayed job identity through native evidence validation.
                    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals);
                    let comment;
                    try {
                        comment = await preparePartsComment(parts, raw, false, {sourceHash: retained.source.sourceHash});
                    } catch (error) {
                        if (error instanceof JobError ||
                            error instanceof Error && error.message.startsWith('PARTS_COMMENT_STALE_SOURCE:')) throw error;
                        return failure('JOB_SOURCE_MISMATCH', 409, cropFailureDiagnostic(error, raw));
                    }
                    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals);
                    if (session.status().publication?.publicationId !== publicationId)
                        return failure('JOB_ACT_SOURCE_STALE', 409);
                    return json({comment});
                }
                if (path === 'api/stage-parts') {
                    if (!parts) return failure('JOB_SOURCE_UNRETAINABLE', 409);
                    return json({...partsViewJson(parts, {verdict: null, stale: null}), sourceHash: retained.source.sourceHash,
                        inspectionSourceHash: retained.source.sourceHash, readOnly: true});
                }
                const difference = /^api\/stage-parts\/difference\/(0|[1-9]\d*)$/.exec(path);
                if (difference && request.method === 'GET') {
                    if (!parts) return failure('JOB_SOURCE_UNRETAINABLE', 409);
                    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);
                    const response = await partsDifferenceResponse(parts, Number(difference[1]), new URL(request.url).searchParams, headers);
                    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);
                    return response;
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
            });
        } catch (error) {
            const code = error instanceof JobError ? error.code :
                error instanceof Error && error.message.startsWith('PARTS_COMMENT_STALE_SOURCE:')
                    ? 'PARTS_COMMENT_STALE_SOURCE' : 'JOB_SOURCE_MISMATCH';
            const message = error instanceof JobError && /^(CHECKPOINT_EVIDENCE|PLAN_TEXT)_[A-Z_]+$/.test(error.message)
                ? error.message : error instanceof Error && /^PARTS_(DIFFERENCE_[A-Z_]+|COMPARISON_INVALID):/.test(error.message) ? error.message : undefined;
            return failure(code, errorStatus[code as JobErrorCode] ?? 409, undefined, message);
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
    /** Absent on older records or when adding it would exceed the 65,536-byte metadata limit. */
    listenerIncarnation?: string;
    /** Absent on older records whose hook identity cannot be established. */
    readerId?: string | null;
    bindingId?: string | null;
    /** Present when the host runs in record-and-package mode. */
    publicationMode?: JobPublicationMode;
    recordReaderId?: string | null;
}

export type JobHostListenerIncarnation = string;

export interface JobHostReuseBinding {
    readonly root: string;
    readonly stateDir: string;
    readonly fingerprint: string;
    readonly reviewer: JobReviewerBinding;
    readonly readerId: string | null;
    readonly bindingId: string | null;
    readonly partsEnumeratorId: string | null;
    readonly partsEnumeratorVersion: string | null;
    readonly apiSchema: typeof JOB_API_SCHEMA;
    readonly actSchema: typeof JOB_ACT_SCHEMA;
}

export interface JobHostReuseExpectation {
    readonly jobId: JobId;
    readonly origin: string;
    readonly listenerIncarnation: JobHostListenerIncarnation;
    readonly binding: JobHostReuseBinding;
}

export type JobHostAttachField =
    | 'jobId'
    | 'origin'
    | 'listenerIncarnation'
    | 'root'
    | 'stateDir'
    | 'fingerprint'
    | 'reviewer.id'
    | 'reviewer.role'
    | 'readerId'
    | 'bindingId'
    | 'partsEnumeratorId'
    | 'partsEnumeratorVersion'
    | 'apiSchema'
    | 'actSchema'
    | 'port';

export type JobHostAttachFailure =
    | {
        readonly code: 'JOB_HOST_ATTACH_REFUSED';
        readonly reason: 'missing' | 'closed' | 'incarnation-missing' | 'replaced' | 'read' | 'probe' | 'stopped' | 'race';
        readonly phase: 'input' | 'state' | 'record' | 'probe' | 'adoption' | 'acceptance';
    }
    | {
        readonly code: 'JOB_HOST_REUSE_MISMATCH';
        readonly field: JobHostAttachField;
        readonly expected: string | null;
        readonly actual: string | null;
    };

/** Callers declare stable hook semantics. Equal IDs permit reuse across processes. */
export interface JobHostOptions extends JobWorkerOptions {
    readonly readerId?: string;
    readonly bindingId?: string;
    readonly partsEnumeratorId?: string;
    readonly reuseOnly?: {
        readonly expected: JobHostReuseExpectation;
    };
}

type JobHostOptionName = 'readPublished' | 'installWriterBinding' | 'partsEnumerator' |
    'partsEnumeratorVersion' | 'apiSchema' | 'actSchema' | JobHostAttachField;

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

class JobHostAttachError extends Error {
    readonly code = 'JOB_HOST_ATTACH_REFUSED' as const;
    constructor(
        readonly reason: 'missing' | 'closed' | 'incarnation-missing' | 'replaced' | 'read' | 'probe' | 'stopped' | 'race',
        readonly phase: 'input' | 'state' | 'record' | 'probe' | 'adoption' | 'acceptance',
    ) {
        super(`JOB_HOST_ATTACH_REFUSED: ${reason} (${phase})`);
        this.name = 'JobHostAttachError';
    }
}

function reuseMismatch(field: JobHostAttachField, expected: string | null, actual: string | null):
    Error & {code: 'JOB_HOST_REUSE_MISMATCH'; field: JobHostAttachField; expected: string | null; actual: string | null} {
    return Object.assign(new Error(`JOB_HOST_REUSE_MISMATCH: ${field}`),
        {code: 'JOB_HOST_REUSE_MISMATCH' as const, field, expected, actual});
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
    readonly attachment: JobHostReuseExpectation | null;
    stop(): void;
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function parseJobHostListenerIncarnation(value: unknown): JobHostListenerIncarnation {
    if (typeof value !== 'string' || !UUID_V4_RE.test(value)) throw new JobError('JOB_REQUEST_INVALID');
    return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function exactKeys(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!isPlainObject(value)) throw new JobError('JOB_REQUEST_INVALID');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== allowed.length || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) {
        throw new JobError('JOB_REQUEST_INVALID');
    }
    return ownData(value);
}

function ownData(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) throw new JobError('JOB_REQUEST_INVALID');
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (typeof key !== 'string' || !('value' in descriptor)) throw new JobError('JOB_REQUEST_INVALID');
        Object.defineProperty(copy, key, {value: descriptor.value, enumerable: true, configurable: true, writable: true});
    }
    return copy;
}

function parseLoopbackOrigin(raw: unknown): {port: string; origin: string} {
    if (typeof raw !== 'string') throw new JobError('JOB_REQUEST_INVALID');
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(raw);
    if (!match || Number(match[1]) > 65535) throw new JobError('JOB_REQUEST_INVALID');
    return {port: match[1]!, origin: new URL(raw).origin};
}

function withinPath(root: string, target: string): boolean {
    const rel = relative(root, target);
    return !rel || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function freezeExpectation(value: JobHostReuseExpectation): JobHostReuseExpectation {
    const reviewer: JobReviewerBinding = Object.freeze({
        id: value.binding.reviewer.id,
        role: value.binding.reviewer.role,
    });
    const binding: JobHostReuseBinding = Object.freeze({
        root: value.binding.root,
        stateDir: value.binding.stateDir,
        fingerprint: value.binding.fingerprint,
        reviewer,
        readerId: value.binding.readerId,
        bindingId: value.binding.bindingId,
        partsEnumeratorId: value.binding.partsEnumeratorId,
        partsEnumeratorVersion: value.binding.partsEnumeratorVersion,
        apiSchema: value.binding.apiSchema,
        actSchema: value.binding.actSchema,
    });
    return Object.freeze({
        jobId: value.jobId,
        origin: value.origin,
        listenerIncarnation: value.listenerIncarnation,
        binding,
    });
}

export function jobHostIdentity(startup: JobHostOptions) {
    if (startup.publicationMode !== undefined && startup.publicationMode !== 'package-only' && startup.publicationMode !== 'record-and-package') {
        throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', 'readPublished', null, String(startup.publicationMode));
    }
    const isRecordMode = startup.publicationMode === 'record-and-package' || startup.readRecordPublished !== undefined;
    let readerId: string | null;
    let recordReaderId: string | null;
    let publicationMode: JobPublicationMode;
    if (isRecordMode) {
        if (startup.publicationMode === 'package-only') {
            throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', 'readPublished', 'package-only', startup.recordReaderId ?? startup.readerId);
        }
        if (typeof startup.readRecordPublished !== 'function') {
            throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', 'readPublished', null, startup.recordReaderId ?? startup.readerId);
        }
        if (startup.recordReaderId !== undefined) {
            recordReaderId = declaredHostId('readPublished', startup.readRecordPublished, startup.recordReaderId);
            readerId = declaredHostId('readPublished', startup.readPublished, startup.readerId);
        } else {
            recordReaderId = declaredHostId('readPublished', startup.readRecordPublished, startup.readerId);
            if (startup.readPublished !== undefined && typeof startup.readPublished !== 'function') {
                throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', 'readPublished', null, startup.readerId);
            }
            readerId = startup.readPublished ? recordReaderId : null;
        }
        publicationMode = 'record-and-package';
    } else {
        if (startup.recordReaderId !== undefined) {
            throw new JobHostOptionError('JOB_HOST_OPTION_ID_INVALID', 'readPublished', null, startup.recordReaderId);
        }
        readerId = declaredHostId('readPublished', startup.readPublished, startup.readerId);
        recordReaderId = null;
        publicationMode = 'package-only';
    }
    const bindingId = declaredHostId('installWriterBinding', startup.installWriterBinding, startup.bindingId);
    const partsEnumeratorId = declaredHostId('partsEnumerator', startup.partsEnumerator?.enumerate, startup.partsEnumeratorId);
    const partsEnumeratorVersion = startup.partsEnumerator?.version ?? null;
    return {readerId, bindingId, partsEnumeratorId, partsEnumeratorVersion, publicationMode, recordReaderId};
}

export async function installJobWriterBinding(session: JobSession, startup: JobHostOptions, origin: string): Promise<void> {
    try {await startup.installWriterBinding?.({...session.writerGrant(), origin});}
    catch {throw new JobError('JOB_AUTHORITY_REFUSED', 'Writer binding installation failed');}
}

export function assertJobHostCompatible(record: JobHostRecord, identity: ReturnType<typeof jobHostIdentity>): void {
    const recordMode: JobPublicationMode = record.publicationMode ?? 'package-only';
    const recordReaderId = record.recordReaderId ?? null;
    if (recordMode !== identity.publicationMode) {
        throw new JobHostOptionError(
            'JOB_HOST_REUSE_MISMATCH',
            'readPublished',
            recordReaderId ?? record.readerId ?? recordMode,
            identity.recordReaderId ?? identity.readerId ?? identity.publicationMode,
        );
    }
    if (recordReaderId !== identity.recordReaderId) {
        throw new JobHostOptionError('JOB_HOST_REUSE_MISMATCH', 'readPublished', recordReaderId, identity.recordReaderId);
    }
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

function buildAttachment(session: JobSession, origin: string, listenerIncarnation: string,
    identity: ReturnType<typeof jobHostIdentity>): JobHostReuseExpectation {
    const live = session.attestation();
    assertJobRoot(live.root);
    if (live.status !== 'active') throw new JobHostAttachError('closed', 'acceptance');
    return freezeExpectation({jobId: session.jobId, origin, listenerIncarnation, binding: {
        root: live.root.path, stateDir: live.stateDir, fingerprint: live.fingerprint,
        reviewer: live.reviewer,
        readerId: identity.readerId ?? identity.recordReaderId,
        bindingId: identity.bindingId,
        partsEnumeratorId: identity.partsEnumeratorId,
        partsEnumeratorVersion: identity.partsEnumeratorVersion,
        apiSchema: live.apiSchema, actSchema: live.actSchema,
    }});
}

type ObservedFileIdentity = {readonly dev: number; readonly ino: number};
type ObservedFiles = {readonly root: ObservedFileIdentity; readonly stateDir: ObservedFileIdentity;
    readonly store: ObservedFileIdentity; readonly record: ObservedFileIdentity};
const observedFields = ['root', 'stateDir', 'store', 'record'] as const;
function fileIdentity(info: ObservedFileIdentity): ObservedFileIdentity { return {dev: info.dev, ino: info.ino}; }
function sameFile(a: ObservedFileIdentity, b: ObservedFileIdentity): boolean {return a.dev === b.dev && a.ino === b.ino;}
function observeFiles(expected: JobHostReuseExpectation): ObservedFiles {
    const paths = {root: expected.binding.root, stateDir: expected.binding.stateDir,
        store: join(expected.binding.stateDir, 'jobs.sqlite'),
        record: join(expected.binding.stateDir, 'job-ui', expected.jobId + '.json')};
    const values = {} as Record<typeof observedFields[number], ObservedFileIdentity>;
    for (const key of observedFields) {
        const info = lstatSync(paths[key]);
        if (key === 'root') {if (!info.isDirectory()) throw new JobHostAttachError('replaced', 'acceptance');}
        else assertPrivateStat(info, key === 'stateDir', 'acceptance');
        values[key] = fileIdentity(info);
    }
    return values;
}
function parseObserved(raw: unknown): ObservedFiles {
    const input = exactKeys(raw, observedFields), output = {} as Record<typeof observedFields[number], ObservedFileIdentity>;
    for (const key of observedFields) {
        const item = exactKeys(input[key], ['dev', 'ino']);
        if (!Number.isSafeInteger(item.dev) || (item.dev as number) < 0 ||
            !Number.isSafeInteger(item.ino) || (item.ino as number) < 0) throw new JobError('JOB_REQUEST_INVALID');
        output[key] = {dev: item.dev as number, ino: item.ino as number};
    }
    return output;
}
function compareAttachment(expected: JobHostReuseExpectation, actual: JobHostReuseExpectation): void {
    for (const field of ['jobId', 'origin', 'listenerIncarnation'] as const) {
        if (expected[field] !== actual[field]) throw reuseMismatch(field, expected[field], actual[field]);
    }
    for (const field of ['root', 'stateDir', 'fingerprint'] as const) {
        if (expected.binding[field] !== actual.binding[field]) throw reuseMismatch(field, expected.binding[field], actual.binding[field]);
    }
    for (const field of ['id', 'role'] as const) {
        if (expected.binding.reviewer[field] !== actual.binding.reviewer[field]) {
            throw reuseMismatch(`reviewer.${field}`, expected.binding.reviewer[field], actual.binding.reviewer[field]);
        }
    }
    for (const field of ['readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion', 'apiSchema', 'actSchema'] as const) {
        if (expected.binding[field] !== actual.binding[field]) throw reuseMismatch(field, expected.binding[field], actual.binding[field]);
    }
}
function attachFailure(error: unknown): Response {
    if (error instanceof JobHostAttachError) return Response.json({ok: false,
        error: {code: error.code, reason: error.reason, phase: error.phase}},
        {status: error.reason === 'stopped' ? 503 : 409, headers});
    if ((error as {code?: string})?.code === 'JOB_HOST_REUSE_MISMATCH') {
        const {field, expected, actual} = error as Extract<JobHostAttachFailure, {field: unknown}>;
        return Response.json({ok: false, error: {code: 'JOB_HOST_REUSE_MISMATCH', field, expected, actual}}, {status: 409, headers});
    }
    const code = error instanceof JobError ? error.code : 'JOB_REQUEST_INVALID';
    return failure(code, code === 'JOB_BODY_LIMIT' ? 413 : ['JOB_CAPABILITY_REQUIRED', 'JOB_AUTHORITY_REFUSED'].includes(code) ? 403 : 400);
}

/** One live job request context. Its caller publishes it only after descriptor installation. */
export function createJobRequestContext(session: JobSession, startup: JobHostOptions, origin: string,
    identity: ReturnType<typeof jobHostIdentity>, resource = jobWindowResources(), hubIncarnation?: string,
    listenerIncarnation: string = hubIncarnation ?? randomUUID(), accepting: () => boolean = () => true) {
    const ports = createJobHostPorts(session, new URL(origin).origin);
    // This legacy GET projection and its property order are deliberately unchanged.
    const record: JobHostRecord = {
        schema: 'rig-review-job-host/1',
        apiSchema: JOB_API_SCHEMA,
        actSchema: JOB_ACT_SCHEMA,
        readerId: identity.readerId,
        bindingId: identity.bindingId,
        partsEnumeratorId: identity.partsEnumeratorId,
        partsEnumeratorVersion: identity.partsEnumeratorVersion,
        ...(identity.publicationMode === 'record-and-package' ? {
            publicationMode: identity.publicationMode,
            recordReaderId: identity.recordReaderId,
        } : {}),
        jobId: session.jobId,
        origin,
        fingerprint: startup.fingerprint,
        pid: process.pid,
    };
    const front = createJobFront({origin, ports, resource, hubIncarnation, publication: retainedPublicationRoutes(session)});
    let requests = 0, stopped = false, published = false;
    let captured: ObservedFiles;
    let descriptorBytes: string;
    const normalizedOrigin = new URL(origin).origin;
    function descriptor(): {readonly record: JobHostRecord; readonly hasIncarnation: boolean} {
        const withIncarnation = {...record, listenerIncarnation};
        if (Buffer.byteLength(JSON.stringify(withIncarnation)) <= WORKSPACE_BODY_LIMIT) return {record: withIncarnation, hasIncarnation: true};
        return {record: {...record}, hasIncarnation: false};
    }
    function attachment(): JobHostReuseExpectation | null {
        if (!published || stopped || !accepting() || !descriptor().hasIncarnation) return null;
        try {
            const value = buildAttachment(session, origin, listenerIncarnation, identity);
            return Buffer.byteLength(JSON.stringify({expected: value, observed: captured})) <= WORKSPACE_BODY_LIMIT &&
                Buffer.byteLength(JSON.stringify({ok: true, attachment: value, pid: process.pid})) <= WORKSPACE_BODY_LIMIT ? value : null;
        } catch {return null;}
    }
    return {
        ports, record, listenerIncarnation, descriptor, attachment,
        // Embedded owners already hold the binding; its public tuple remains available
        // even when a compact descriptor cannot carry strict transport metadata.
        ownerAttachment: () => buildAttachment(session, origin, listenerIncarnation, identity),
        publish() {
            if (!descriptor().hasIncarnation) {published = true; return;}
            const value = buildAttachment(session, origin, listenerIncarnation, identity);
            captured = observeFiles(value);
            descriptorBytes = readDescriptor(join(value.binding.stateDir, 'job-ui', value.jobId + '.json')).bytes;
            published = true;
        },
        get busy() {return requests > 0 || session.busy;},
        async fetch(request: Request): Promise<Response> {
            requests++;
            try {
                const url = new URL(request.url);
                if (url.pathname === `/jobs/${session.jobId}/host`) {
                    if (url.origin !== normalizedOrigin || url.search || request.headers.get('sec-fetch-site') === 'cross-site' ||
                        request.headers.get('origin') !== null && request.headers.get('origin') !== normalizedOrigin) return failure('JOB_REQUEST_INVALID', 403);
                    if (request.method === 'GET') {
                        try {session.authorize('ui', request.headers.get('X-Review-Capability'));}
                        catch {return failure('JOB_CAPABILITY_REQUIRED', 403);}
                        return Response.json(record, {headers});
                    }
                    if (request.method === 'POST') {
                        if (request.headers.get('origin') !== normalizedOrigin) return failure('JOB_SAME_ORIGIN_REQUIRED', 403);
                        try {
                            if (request.headers.get('content-type') !== 'application/json') throw new JobError('JOB_REQUEST_INVALID');
                            const body = exactKeys(await jobBody(request, WORKSPACE_BODY_LIMIT), ['expected', 'observed']);
                            const expected = parseReuseOnlyExpectation({expected: body.expected}), observed = parseObserved(body.observed);
                            const live = () => {if (stopped || !published || !accepting()) throw new JobHostAttachError('stopped', 'acceptance');
                                if (request.signal.aborted) throw new JobHostAttachError('probe', 'acceptance');};
                            live();
                            const payload = session.inspectAttach(() => {
                                live();
                                try {session.authorize('ui', request.headers.get('X-Review-Capability'));}
                                catch (error) {if (error instanceof JobError && error.code === 'JOB_CLOSED') throw new JobHostAttachError('closed', 'acceptance'); throw error;}
                                const actual = buildAttachment(session, origin, listenerIncarnation, identity);
                                compareAttachment(expected, actual);
                                if (!descriptor().hasIncarnation) throw new JobHostAttachError('incarnation-missing', 'acceptance');
                                const current = observeFiles(actual);
                                for (const key of observedFields) {
                                    if (!sameFile(current[key], captured[key]) || !sameFile(observed[key], captured[key])) throw new JobHostAttachError('replaced', 'acceptance');
                                }
                                const path = join(actual.binding.stateDir, 'job-ui', actual.jobId + '.json');
                                if (readDescriptor(path).bytes !== descriptorBytes) throw new JobHostAttachError('replaced', 'acceptance');
                                live();
                                const value = Object.freeze({ok: true as const, attachment: actual, pid: process.pid});
                                if (Buffer.byteLength(JSON.stringify(value)) > WORKSPACE_BODY_LIMIT) throw new JobError('JOB_BODY_LIMIT');
                                return value;
                            });
                            return Response.json(payload, {headers});
                        } catch (error) {
                            if (error instanceof JobError && ['JOB_STORAGE_FAILED', 'JOB_ROOT_REPLACED'].includes(error.code) ||
                                ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
                                return attachFailure(new JobHostAttachError('replaced', 'acceptance'));
                            }
                            return attachFailure(error);
                        }
                    }
                    return failure('JOB_REQUEST_INVALID', 403);
                }
                return await front.fetch(request) ?? failure('JOB_REQUEST_INVALID', 404);
            } finally {requests--;}
        },
        stop() {stopped = true; front.stop();},
    };
}

function readDescriptor(path: string): {value: Record<string, unknown>; bytes: string; info: Stats} {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = fstatSync(fd); assertPrivateStat(before, false, 'record');
        if (!before.size || before.size > WORKSPACE_BODY_LIMIT) throw new JobHostAttachError('read', 'record');
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count;}
        const after = fstatSync(fd);
        if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new JobHostAttachError('read', 'record');
        const bytes = new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(0, length)), value: unknown = JSON.parse(bytes);
        if (!isPlainObject(value)) throw new JobHostAttachError('read', 'record');
        return {value, bytes, info: before};
    } finally {closeSync(fd);}
}

interface StoredAttachJobData {
    apiSchema: string;
    actSchema: string;
    root: JobRootIdentity;
    fingerprint: string;
    reviewer: JobReviewerBinding;
    agentCapability: string;
    uiCapability: string;
    fetchCapability: string | null;
}

function parseReuseOnlyExpectation(rawReuseOnly: unknown, requireSchemas = true): JobHostReuseExpectation {
    const wrapper = exactKeys(rawReuseOnly, ['expected']);
    const exp = exactKeys(wrapper.expected, ['jobId', 'origin', 'listenerIncarnation', 'binding']);
    const bind = exactKeys(exp.binding, [
        'root', 'stateDir', 'fingerprint', 'reviewer',
        'readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion',
        'apiSchema', 'actSchema',
    ]);
    const rev = exactKeys(bind.reviewer, ['id', 'role']);
    const parsedJobId = jobId(exp.jobId);
    parseLoopbackOrigin(exp.origin);
    const incarnation = parseJobHostListenerIncarnation(exp.listenerIncarnation);
    if (typeof bind.root !== 'string' || !bind.root || bind.root.includes('\0') || !isAbsolute(bind.root) || join(bind.root) !== bind.root ||
        typeof bind.stateDir !== 'string' || !bind.stateDir || bind.stateDir.includes('\0') || !isAbsolute(bind.stateDir) || join(bind.stateDir) !== bind.stateDir ||
        typeof bind.fingerprint !== 'string' || !bind.fingerprint ||
        typeof rev.id !== 'string' || !rev.id ||
        (rev.role !== 'owner' && rev.role !== 'delegate')) {
        throw new JobError('JOB_REQUEST_INVALID');
    }
    for (const key of ['readerId', 'bindingId', 'partsEnumeratorId'] as const) {
        const val = bind[key];
        if (val !== null && (typeof val !== 'string' || !val)) {
            throw new JobError('JOB_REQUEST_INVALID');
        }
    }
    if (bind.partsEnumeratorId === null) {
        if (bind.partsEnumeratorVersion !== null) throw new JobError('JOB_REQUEST_INVALID');
    } else {
        if (typeof bind.partsEnumeratorVersion !== 'string' || !bind.partsEnumeratorVersion) {
            throw new JobError('JOB_REQUEST_INVALID');
        }
        try { jobPartsEnumeratorVersion(bind.partsEnumeratorVersion); }
        catch { throw new JobError('JOB_REQUEST_INVALID'); }
    }
    if (typeof bind.apiSchema !== 'string' || typeof bind.actSchema !== 'string' ||
        requireSchemas && (bind.apiSchema !== JOB_API_SCHEMA || bind.actSchema !== JOB_ACT_SCHEMA)) {
        throw new JobError('JOB_REQUEST_INVALID');
    }
    return freezeExpectation({
        jobId: parsedJobId,
        origin: exp.origin as string,
        listenerIncarnation: incarnation,
        binding: {
            root: bind.root,
            stateDir: bind.stateDir,
            fingerprint: bind.fingerprint,
            reviewer: { id: rev.id, role: rev.role },
            readerId: bind.readerId as string | null,
            bindingId: bind.bindingId as string | null,
            partsEnumeratorId: bind.partsEnumeratorId as string | null,
            partsEnumeratorVersion: bind.partsEnumeratorVersion as string | null,
            apiSchema: bind.apiSchema as typeof JOB_API_SCHEMA,
            actSchema: bind.actSchema as typeof JOB_ACT_SCHEMA,
        },
    });
}

function assertPrivateStat(info: Stats, directory: boolean, phase: 'state' | 'record' | 'adoption' | 'acceptance'): void {
    if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) ||
        (info.mode & 0o077) !== 0 || (!directory && info.nlink !== 1) ||
        (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw new JobHostAttachError('read', phase);
    }
}

function assertNoSqliteSidecars(sqliteFile: string, phase: 'state' | 'adoption'): void {
    for (const suffix of ['-journal', '-wal', '-shm']) {
        try {
            lstatSync(sqliteFile + suffix);
            throw new JobHostAttachError('read', phase);
        } catch (error) {
            if (error instanceof JobHostAttachError) throw error;
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new JobHostAttachError('read', phase);
            }
        }
    }
}

async function attachJobHost(options: JobHostOptions): Promise<JobOwnerHost> {
    // Step 1 (phase: 'input'): Validate reuseOnly and top-level options before any filesystem or store work.
    const expected = parseReuseOnlyExpectation(options.reuseOnly);
    const rootInput = options.root;
    const stateInput = options.stateDir;
    const fingerprint = options.fingerprint;
    if (typeof rootInput !== 'string' || !rootInput || rootInput.includes('\0') ||
        typeof stateInput !== 'string' || !stateInput || stateInput.includes('\0') ||
        typeof fingerprint !== 'string' || !fingerprint) {
        throw new JobError('JOB_REQUEST_INVALID');
    }
    if (!options.reviewer || typeof options.reviewer !== 'object' ||
        typeof options.reviewer.id !== 'string' || !options.reviewer.id ||
        !['owner', 'delegate'].includes(options.reviewer.role)) {
        throw new JobError('JOB_AUTHORITY_REFUSED');
    }
    const reviewerData = exactKeys(options.reviewer, ['id', 'role']);
    const reviewer: JobReviewerBinding = {id: reviewerData.id as string, role: reviewerData.role as JobReviewerBinding['role']};
    const port = options.port;
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) {
        throw new JobError('JOB_REQUEST_INVALID');
    }
    const identity = jobHostIdentity(options);
    if (options.partsEnumerator) jobPartsEnumeratorVersion(options.partsEnumerator.version);
    const sanitizedStartup: JobHostOptions = {
        root: rootInput,
        stateDir: stateInput,
        fingerprint,
        reviewer,
        ...(port !== undefined ? { port } : {}),
        ...(options.publicationMode !== undefined ? { publicationMode: options.publicationMode } : {}),
        ...(options.readPublished ? { readPublished: options.readPublished, readerId: identity.readerId! } : {}),
        ...(options.readRecordPublished ? {
            readRecordPublished: options.readRecordPublished,
            recordReaderId: identity.recordReaderId!,
            ...(options.readerId !== undefined && !options.readPublished ? { readerId: options.readerId } : {}),
        } : {}),
        ...(options.installWriterBinding ? { installWriterBinding: options.installWriterBinding, bindingId: identity.bindingId! } : {}),
        ...(options.partsEnumerator ? { partsEnumerator: {...options.partsEnumerator}, partsEnumeratorId: identity.partsEnumeratorId! } : {}),
        ...(options.afterSnapshot ? { afterSnapshot: options.afterSnapshot } : {}),
        ...(options.afterDirectorySync ? { afterDirectorySync: options.afterDirectorySync } : {}),
    };

    // Step 2 (phase: 'input' / 'state'): Canonical path resolution, disjointness, and options vs expected comparison.
    const root = captureJobRoot(rootInput);
    const stateCandidate = canonicalStatePath(stateInput);
    if (withinPath(root.path, stateCandidate)) {
        throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Job state must be outside the designated work root');
    }
    if (withinPath(stateCandidate, root.path)) {
        throw new JobError('JOB_SOURCE_UNRETAINABLE', 'The designated work root must be outside job state');
    }
    let state: string;
    try {
        state = destinationDirectory(stateInput, 'STATE_DIRECTORY_INVALID', false);
    } catch (error) {
        if (error instanceof DestinationDirectoryError) {
            const causeCode = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            if (causeCode === 'ENOENT') throw new JobHostAttachError('missing', 'state');
            throw new JobError('JOB_SOURCE_UNRETAINABLE', error.message);
        }
        throw error;
    }
    let stateInfo: Stats;
    let stateRealInfo: Stats;
    try {
        stateInfo = lstatSync(stateInput);
        stateRealInfo = statSync(state);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobHostAttachError('missing', 'state');
        throw new JobHostAttachError('read', 'state');
    }
    if (stateInfo.isSymbolicLink() || stateInfo.dev !== stateRealInfo.dev || stateInfo.ino !== stateRealInfo.ino) {
        throw new JobError('JOB_SOURCE_UNRETAINABLE', 'STATE_DIRECTORY_INVALID');
    }
    assertPrivateStat(stateInfo, true, 'state');

    if (root.path !== expected.binding.root) throw reuseMismatch('root', expected.binding.root, root.path);
    if (state !== expected.binding.stateDir) throw reuseMismatch('stateDir', expected.binding.stateDir, state);
    if (fingerprint !== expected.binding.fingerprint) throw reuseMismatch('fingerprint', expected.binding.fingerprint, fingerprint);
    if (reviewer.id !== expected.binding.reviewer.id) throw reuseMismatch('reviewer.id', expected.binding.reviewer.id, reviewer.id);
    if (reviewer.role !== expected.binding.reviewer.role) throw reuseMismatch('reviewer.role', expected.binding.reviewer.role, reviewer.role);
    const requestedBindingReaderId = identity.readerId ?? identity.recordReaderId;
    if (requestedBindingReaderId !== expected.binding.readerId) {
        throw reuseMismatch('readerId', expected.binding.readerId, requestedBindingReaderId);
    }
    if (identity.bindingId !== expected.binding.bindingId) throw reuseMismatch('bindingId', expected.binding.bindingId, identity.bindingId);
    if (identity.partsEnumeratorId !== expected.binding.partsEnumeratorId) {
        throw reuseMismatch('partsEnumeratorId', expected.binding.partsEnumeratorId, identity.partsEnumeratorId);
    }
    if (identity.partsEnumeratorVersion !== expected.binding.partsEnumeratorVersion) {
        throw reuseMismatch('partsEnumeratorVersion', expected.binding.partsEnumeratorVersion, identity.partsEnumeratorVersion);
    }
    const expectedPort = parseLoopbackOrigin(expected.origin).port;
    if (port !== undefined && String(port) !== expectedPort) {
        throw reuseMismatch('port', expectedPort, String(port));
    }

    // Step 3 (phase: 'state'): Read-only SQLite inspection without WAL/SHM/journal side effects.
    const sqliteFile = join(state, 'jobs.sqlite');
    let sqliteInfo: Stats;
    try {
        sqliteInfo = lstatSync(sqliteFile);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobHostAttachError('missing', 'state');
        throw new JobHostAttachError('read', 'state');
    }
    assertPrivateStat(sqliteInfo, false, 'state');
    assertNoSqliteSidecars(sqliteFile, 'state');

    const rootKey = jobHash(JSON.stringify([root.path, expected.binding.fingerprint]));
    let store: JobStore<StoredAttachJobData>;
    try {
        store = new JobStore<StoredAttachJobData>(state, { readonly: true });
    } catch {
        throw new JobHostAttachError('read', 'state');
    }
    let uiCapability: string, inspectedRevision: number;
    try {
        let row: ReturnType<JobStore<StoredAttachJobData>['get']>;
        try {
            row = store.inspect(() => store.get(expected.jobId));
        } catch (error) {
            if (error instanceof JobError && error.code === 'JOB_UNKNOWN') {
                throw new JobHostAttachError('missing', 'state');
            }
            throw new JobHostAttachError('read', 'state');
        }
        const data = row.data;
        if (!data || typeof data !== 'object' || !data.root || typeof data.root.path !== 'string' ||
            typeof data.fingerprint !== 'string' || typeof data.apiSchema !== 'string' || typeof data.actSchema !== 'string' || !data.reviewer ||
            typeof data.reviewer.id !== 'string' || typeof data.reviewer.role !== 'string') {
            throw new JobHostAttachError('read', 'state');
        }
        if (data.root.path !== expected.binding.root) throw reuseMismatch('root', expected.binding.root, data.root.path);
        if (data.fingerprint !== expected.binding.fingerprint) throw reuseMismatch('fingerprint', expected.binding.fingerprint, data.fingerprint);
        if (data.reviewer.id !== expected.binding.reviewer.id) throw reuseMismatch('reviewer.id', expected.binding.reviewer.id, data.reviewer.id);
        if (data.reviewer.role !== expected.binding.reviewer.role) throw reuseMismatch('reviewer.role', expected.binding.reviewer.role, data.reviewer.role);
        if (data.apiSchema !== expected.binding.apiSchema) {
            throw reuseMismatch('apiSchema', expected.binding.apiSchema, typeof data.apiSchema === 'string' ? data.apiSchema : null);
        }
        if (data.actSchema !== expected.binding.actSchema) {
            throw reuseMismatch('actSchema', expected.binding.actSchema, typeof data.actSchema === 'string' ? data.actSchema : null);
        }
        if (data.root.dev !== root.dev || data.root.ino !== root.ino) {
            throw new JobHostAttachError('replaced', 'state');
        }
        try { assertJobRoot(data.root); }
        catch { throw new JobHostAttachError('replaced', 'state'); }
        if (!row.active) throw new JobHostAttachError('closed', 'state');
        if (row.rootKey !== rootKey ||
            typeof data.uiCapability !== 'string' || !/^[a-f0-9]{64}$/.test(data.uiCapability) ||
            typeof data.agentCapability !== 'string' || !/^[a-f0-9]{64}$/.test(data.agentCapability)) {
            throw new JobHostAttachError('read', 'state');
        }
        uiCapability = data.uiCapability; inspectedRevision = row.revision;
    } finally {
        store.close();
    }

    // Step 4 (phase: 'record'): Verify job-ui/<jobId>.json metadata, fields, and PID liveness.
    const control = join(state, 'job-ui');
    let controlInfo: Stats;
    try {
        controlInfo = lstatSync(control);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobHostAttachError('missing', 'record');
        throw new JobHostAttachError('read', 'record');
    }
    assertPrivateStat(controlInfo, true, 'record');
    const recordPath = join(control, expected.jobId + '.json');
    let recordInfo: Stats;
    try {
        recordInfo = lstatSync(recordPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobHostAttachError('missing', 'record');
        throw new JobHostAttachError('read', 'record');
    }
    assertPrivateStat(recordInfo, false, 'record');
    if (recordInfo.size > WORKSPACE_BODY_LIMIT) throw new JobHostAttachError('read', 'record');
    let recordBytes: string, descriptor: Record<string, unknown>;
    try {
        const read = readDescriptor(recordPath);
        if (!sameFile(read.info, recordInfo)) throw new JobHostAttachError('replaced', 'record');
        recordBytes = read.bytes; descriptor = read.value;
    } catch (error) {
        if (error instanceof JobHostAttachError) throw error;
        throw new JobHostAttachError('read', 'record');
    }
    if (descriptor.schema !== 'rig-review-job-host/1' ||
        typeof descriptor.pid !== 'number' || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0 ||
        typeof descriptor.jobId !== 'string' || !descriptor.jobId ||
        typeof descriptor.origin !== 'string' || !descriptor.origin ||
        typeof descriptor.fingerprint !== 'string' || !descriptor.fingerprint) {
        throw new JobHostAttachError('read', 'record');
    }
    let descriptorOrigin: ReturnType<typeof parseLoopbackOrigin>;
    try { descriptorOrigin = parseLoopbackOrigin(descriptor.origin); }
    catch { throw new JobHostAttachError('read', 'record'); }
    if (descriptor.jobId !== expected.jobId) throw reuseMismatch('jobId', expected.jobId, descriptor.jobId);
    if (descriptor.origin !== expected.origin) throw reuseMismatch('origin', expected.origin, descriptor.origin);
    if (!Object.hasOwn(descriptor, 'listenerIncarnation') || descriptor.listenerIncarnation === undefined) {
        throw new JobHostAttachError('incarnation-missing', 'record');
    }
    if (typeof descriptor.listenerIncarnation !== 'string' || !UUID_V4_RE.test(descriptor.listenerIncarnation)) throw new JobHostAttachError('read', 'record');
    if (descriptor.listenerIncarnation !== expected.listenerIncarnation) {
        throw reuseMismatch('listenerIncarnation', expected.listenerIncarnation, descriptor.listenerIncarnation);
    }
    if (descriptor.fingerprint !== expected.binding.fingerprint) {
        throw reuseMismatch('fingerprint', expected.binding.fingerprint, descriptor.fingerprint);
    }
    const descriptorMode = Object.hasOwn(descriptor, 'publicationMode') ? descriptor.publicationMode : 'package-only';
    if (descriptorMode !== 'package-only' && descriptorMode !== 'record-and-package') {
        throw new JobHostAttachError('read', 'record');
    }
    const descriptorRecordReaderId = Object.hasOwn(descriptor, 'recordReaderId') ? descriptor.recordReaderId : null;
    if (descriptorRecordReaderId !== null && (typeof descriptorRecordReaderId !== 'string' || !descriptorRecordReaderId)) {
        throw new JobHostAttachError('read', 'record');
    }
    if (descriptorMode === 'package-only' && descriptorRecordReaderId !== null ||
        descriptorMode === 'record-and-package' && descriptorRecordReaderId === null) {
        throw new JobHostAttachError('read', 'record');
    }
    for (const field of ['readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion'] as const) {
        const val = descriptor[field];
        if (!Object.hasOwn(descriptor, field) || val !== null && (typeof val !== 'string' || !val)) {
            throw new JobHostAttachError('read', 'record');
        }
        const compareVal = field === 'readerId' ? (val ?? descriptorRecordReaderId) : val;
        if (compareVal !== expected.binding[field]) {
            throw reuseMismatch(field, expected.binding[field], (compareVal ?? null) as string | null);
        }
    }
    if (descriptorMode !== identity.publicationMode ||
        descriptor.readerId !== identity.readerId ||
        descriptorRecordReaderId !== identity.recordReaderId) {
        throw reuseMismatch(
            'readerId',
            (descriptor.readerId ?? descriptorRecordReaderId ?? descriptorMode) as string | null,
            identity.readerId ?? identity.recordReaderId ?? identity.publicationMode,
        );
    }
    for (const field of ['apiSchema', 'actSchema'] as const) {
        const val = descriptor[field];
        if (typeof val !== 'string' || !val) {
            throw new JobHostAttachError('read', 'record');
        }
        if (val !== expected.binding[field]) {
            throw reuseMismatch(field, expected.binding[field], (val ?? null) as string | null);
        }
    }
    if (port !== undefined && descriptorOrigin.port !== String(port)) {
        throw reuseMismatch('port', expectedPort, descriptorOrigin.port);
    }
    const descriptorPid = descriptor.pid;
    if (!running(descriptorPid)) throw new JobHostAttachError('probe', 'record');

    // Stage the exact job on its own readonly handle BEFORE the single final probe.
    let session: JobSession;
    try {session = JobSession.openReadOnly(sanitizedStartup, expected.jobId);}
    catch (error) {
        if (error instanceof JobError && error.code === 'JOB_CLOSED') throw new JobHostAttachError('closed', 'adoption');
        throw new JobHostAttachError('race', 'adoption');
    }
    try {
        const observed: ObservedFiles = {root: fileIdentity(root), stateDir: fileIdentity(stateInfo),
            store: fileIdentity(sqliteInfo), record: fileIdentity(recordInfo)};
        try {
            assertJobRoot(root);
            const current = observeFiles(expected);
            for (const field of observedFields) if (!sameFile(current[field], observed[field])) throw new JobHostAttachError('race', 'adoption');
            if (!sameFile(lstatSync(control), controlInfo) || readDescriptor(recordPath).bytes !== recordBytes) throw new JobHostAttachError('race', 'adoption');
            assertNoSqliteSidecars(sqliteFile, 'adoption');
            session.inspectAttach(() => {
                const live = session.attestation();
                if (live.revision !== inspectedRevision || session.hostCredentials().ui !== uiCapability) throw new JobHostAttachError('race', 'adoption');
                compareAttachment(expected, buildAttachment(session, expected.origin, expected.listenerIncarnation, identity));
            });
        } catch (error) {
            if (error instanceof JobHostAttachError) throw error;
            throw new JobHostAttachError('race', 'adoption');
        }
        const body = JSON.stringify({expected, observed});
        if (Buffer.byteLength(body) > WORKSPACE_BODY_LIMIT) throw new JobError('JOB_BODY_LIMIT');
        const start = performance.now();
        let response: Response, remote: unknown;
        try {
            response = await fetch(expected.origin + `/jobs/${expected.jobId}/host`, {
                method: 'POST', headers: {'Content-Type': 'application/json', Origin: new URL(expected.origin).origin,
                    'X-Review-Capability': uiCapability}, body, redirect: 'error', signal: AbortSignal.timeout(1500),
            });
            const remaining = 1500 - (performance.now() - start);
            if (remaining <= 0) {void response.body?.cancel(); throw new Error('deadline');}
            remote = await readOpenStatus(response, remaining);
        } catch {throw new JobHostAttachError('probe', 'probe');}
        if (!response.ok) {
            const refusal = validatedHostRefusal(remote, response.status);
            if (refusal) throw refusal;
            throw new JobHostAttachError('probe', 'probe');
        }
        if (!isPlainObject(remote)) throw new JobHostAttachError('read', 'probe');
        let actual: JobHostReuseExpectation;
        try {
            const success = exactKeys(remote, ['ok', 'attachment', 'pid']);
            if (success.ok !== true || success.pid !== descriptorPid) throw new JobHostAttachError('read', 'probe');
            if (isPlainObject(success.attachment) && !Object.hasOwn(success.attachment, 'listenerIncarnation')) {
                throw new JobHostAttachError('incarnation-missing', 'probe');
            }
            actual = parseReuseOnlyExpectation({expected: success.attachment}, false);
        } catch (error) {
            if (error instanceof JobHostAttachError) throw error;
            throw new JobHostAttachError('read', 'probe');
        }
        compareAttachment(expected, actual);
        // No filesystem work or new session adoption follows accepted validation.
        return {session, ports: createJobHostPorts(session, new URL(expected.origin).origin), origin: expected.origin,
            ownerUrl: expected.origin + `/jobs/${expected.jobId}/#cap=${uiCapability}`, reused: true,
            attachment: freezeExpectation(actual), stop: () => session.dispose()};
    } catch (error) {session.dispose(); throw error;}
}

function validatedHostRefusal(raw: unknown, status: number): Error | null {
    try {
        const value = exactKeys(raw, ['ok', 'error']); if (value.ok !== false) return null;
        if (!isPlainObject(value.error)) return null;
        if (value.error.code === 'JOB_HOST_ATTACH_REFUSED') {
            const item = exactKeys(value.error, ['code', 'reason', 'phase']);
            if (!['missing', 'closed', 'incarnation-missing', 'replaced', 'read', 'probe', 'stopped', 'race'].includes(item.reason as string) ||
                !['input', 'state', 'record', 'probe', 'adoption', 'acceptance'].includes(item.phase as string) ||
                status !== (item.reason === 'stopped' ? 503 : 409)) return null;
            return new JobHostAttachError(item.reason as JobHostAttachError['reason'], item.phase as JobHostAttachError['phase']);
        }
        if (value.error.code === 'JOB_HOST_REUSE_MISMATCH' && status === 409) {
            const item = exactKeys(value.error, ['code', 'field', 'expected', 'actual']);
            if (!['jobId', 'origin', 'listenerIncarnation', 'root', 'stateDir', 'fingerprint', 'reviewer.id', 'reviewer.role',
                'readerId', 'bindingId', 'partsEnumeratorId', 'partsEnumeratorVersion', 'apiSchema', 'actSchema', 'port'].includes(item.field as string) ||
                [item.expected, item.actual].some(v => v !== null && typeof v !== 'string')) return null;
            return reuseMismatch(item.field as JobHostAttachField, item.expected as string | null, item.actual as string | null);
        }
    } catch { /* A malformed failure is a transport refusal, never trusted host evidence. */ }
    return null;
}

function snapshotHostOptions(options: JobHostOptions): JobHostOptions {
    const copy = ownData(options);
    if (copy.reuseOnly !== undefined && Object.keys(copy).some(key => ![
        'root', 'stateDir', 'fingerprint', 'reviewer', 'publicationMode', 'readPublished', 'readerId',
        'readRecordPublished', 'recordReaderId', 'installWriterBinding',
        'bindingId', 'partsEnumerator', 'partsEnumeratorId', 'port', 'reuseOnly', 'afterSnapshot', 'afterDirectorySync',
    ].includes(key))) throw new JobError('JOB_REQUEST_INVALID');
    if (copy.partsEnumerator !== undefined) copy.partsEnumerator = {...exactKeys(copy.partsEnumerator, ['version', 'enumerate'])};
    if (copy.reviewer !== undefined) copyReviewer();
    function copyReviewer() {
        const data = ownData(copy.reviewer);
        Object.defineProperty(copy, 'reviewer', {value: {...data}, enumerable: true, configurable: true});
    }
    return copy as unknown as JobHostOptions;
}

function reuseOnlyDescriptor(value: object): PropertyDescriptor | undefined {
    for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, 'reuseOnly');
        if (descriptor) return descriptor;
    }
    return undefined;
}

/** Full standing owner host. #489 can publish this seam after its own contract review. */
export async function startJobHost(options: JobHostOptions): Promise<JobOwnerHost> {
    if (!options || typeof options !== 'object') throw new JobError('JOB_REQUEST_INVALID');
    const reuseOnly = reuseOnlyDescriptor(options);
    if (reuseOnly && !('value' in reuseOnly)) throw new JobError('JOB_REQUEST_INVALID');
    if (reuseOnly?.value !== undefined) return attachJobHost(snapshotHostOptions(options));
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
            const ports = createJobHostPorts(session, new URL(origin).origin);
            await installBinding(origin);
            // Preserve the GET decision. A separate explicit POST may supply complete attestation.
            let attachment: JobHostReuseExpectation | null = null;
            if (typeof acquired.row.listenerIncarnation === 'string' && UUID_V4_RE.test(acquired.row.listenerIncarnation)) {
                try {
                    const expected = buildAttachment(session, origin, acquired.row.listenerIncarnation, identity);
                    const attached = await attachJobHost({...startup, reviewer: expected.binding.reviewer, reuseOnly: {expected}});
                    attachment = attached.attachment; attached.stop();
                } catch { /* Added metadata never changes ordinary reuse's existing decision. */ }
            }
            return {session, ports, origin, ownerUrl: origin + `/jobs/${session.jobId}/#cap=${credentials.ui}`,
                reused: true, attachment, stop: () => session.dispose()};
        }
        claim = acquired.claim;
        let context: ReturnType<typeof createJobRequestContext>;
        const preferredPort = startup.port ?? previousPort;
        const server = Bun.serve({hostname: '127.0.0.1', port: preferredPort, idleTimeout: 0,
            fetch(request) {return context.fetch(request);},
        });
        const origin = `http://127.0.0.1:${server.port}`;
        context = createJobRequestContext(session, startup, origin, identity);
        const {ports} = context;
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
        const desc = context.descriptor();
        const temporary = recordPath + '.' + nonce + '.tmp';
        await writeFile(temporary, JSON.stringify(desc.record), {flag: 'wx', mode: 0o600});
        await rename(temporary, recordPath);
        context.publish();
        const attachment = context.attachment();
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
        return {session, ports, origin, ownerUrl: origin + `/jobs/${session.jobId}/#cap=${credentials.ui}`,
            reused: false, attachment, stop};
    } catch (error) {
        if (stop) stop(); else session.dispose();
        throw error;
    } finally {
        if (claim) await releaseClaim(claim, nonce);
    }
}
