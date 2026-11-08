/** Live job window transactions. Every form remains bound to its displayed publication. */
import type { JobAct, JobDisplayPublication, JobDisplayReceipt, JobEvent, JobPendingAsk, JobPublication, JobResult, JobUISubmission, JobSourceBinding, } from '../src/job-contract.ts';
import {enCatalog} from './catalog-en.ts';
import {koCatalog} from './catalog-ko.ts';
import {t} from './i18n.ts';
import {JOB_HUB_READY, jobHubMessageMatches, type JobHubBinding} from './job-hub.ts';
import {recordJobRigDraw, freezeJobRigCapture, copyJobRigViewport, createJobRigSubmission, jobRigPixelPlacement,
    type JobRigDraw, type JobRigDrawState} from './job-rig-capture.ts';
import {advancePlayback} from './playback-clock.ts';
import {presentJobRigViewport, type JobRigPresentation} from './viewport-capture.ts';
import {CanvasRenderer} from '@rig-c/play';

/** Imported runtimes may throw arbitrary prose. Only registered refusal copy reaches the window. */
export function jobWindowRefusal(error: unknown, fallback = 'JOB_WINDOW_FAILED'): string {
    const message = error instanceof Error ? error.message : error;
    if (typeof message === 'string' &&
        Object.hasOwn(enCatalog, message) && Object.hasOwn(koCatalog, message)) {
        return t(message);
    }
    return t(fallback);
}
export interface JobWindowTransport {
    readPublication(publicationId: string, signal?: AbortSignal): Promise<JobResult<JobDisplayPublication>>;
    acknowledge(input: {
        publicationId: string;
        pageId: string;
        sourceHash: string;
    }, signal: AbortSignal): Promise<JobResult<JobDisplayReceipt>>;
    submit(input: JobUISubmission): Promise<JobResult<JobAct>>;
}
export interface JobPreparedCommit {
    /** Restore the previous view, including its original forms and route bindings. */
    rollback(): void;
    /** Dispose the old view only after the new displayed nonce is acknowledged. */
    finalize(): void;
}
export interface JobWindowAdapter<Prepared> {
    /** Resolve assets, metadata, forms and publication-pinned routes before returning. */
    prepare(display: JobDisplayPublication, signal: AbortSignal): Promise<Prepared>;
    /** Called immediately before commit, so edits made during preloading are retained. */
    captureDraft(): unknown | null;
    commit(prepared: Prepared, display: JobDisplayPublication): JobPreparedCommit;
    painted(prepared: Prepared, signal: AbortSignal): Promise<void>;
    discard(prepared: Prepared): void;
    changed(state: JobWindowState): void;
}
export interface JobRetainedDraft {
    readonly publicationId: string;
    readonly sourceHash: string;
    readonly source?: JobSourceBinding;
    readonly label: string;
    readonly value: unknown;
}
export interface JobWindowState {
    readonly generation: number;
    readonly displayed: JobDisplayPublication | null;
    readonly receipt: JobDisplayReceipt | null;
    readonly preparing: boolean;
    readonly closed: boolean;
    readonly error: string | null;
    readonly previousLabel: string | null;
    readonly pending: readonly JobPendingAsk[];
    readonly retainedDrafts: readonly JobRetainedDraft[];
}
function unwrap<Value>(result: JobResult<Value>): Value {
    if (!result.ok)
        throw new Error(result.error.code);
    return result.value;
}
function sourceSnapshot(source: JobSourceBinding): string {
    return JSON.stringify(source, (_key, value: unknown) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return value;
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    });
}
function assertJobAskSource(ask: JobPendingAsk, display: JobDisplayPublication): void {
    const source = ask.subject.kind === 'interview-picks'
        ? { ...ask.source, optionSet: display.publication.source.optionSet }
        : ask.source;
    if (sourceSnapshot(source) !== sourceSnapshot(display.publication.source)) {
        throw new Error('JOB_ACT_SOURCE_STALE');
    }
    if (ask.subject.kind === 'interview-picks' &&
        (ask.source.optionSet?.id !== ask.subject.setId || !/^[a-f0-9]{64}$/.test(ask.source.optionSet.sha256))) {
        throw new Error('JOB_ACT_SOURCE_STALE');
    }
}

/** Build pending form dependencies off-stage. A failure rejects the candidate before it is displayed. */
export function prepareJobForms<Form>(
    display: JobDisplayPublication,
    asks: readonly JobPendingAsk[],
    prepare: (ask: JobPendingAsk) => Form,
): Map<string, Form> {
    const prepared = new Map<string, Form>();
    for (const ask of asks) {
        if (ask.publicationId !== display.publication.publicationId || ask.status !== 'pending') continue;
        assertJobAskSource(ask, display);
        prepared.set(ask.askId, prepare(ask));
    }
    return prepared;
}

/** C2 publishes the plan mapping in the ask. Legacy checkpoint metadata is optional guidance. */
export function jobCheckpointContext(
    ask: JobPendingAsk,
    checkpoints: readonly Pick<Checkpoint, 'id' | 'title' | 'note'>[],
) {
    if (ask.subject.kind !== 'checkpoint') throw new Error('JOB_ASK_INVALID');
    const checkpointId = ask.subject.checkpointId;
    const planStepId = ask.subject.planStepId ?? checkpointId;
    const step = ask.source.plan?.steps.find(item => item.id === planStepId);
    if (!step) throw new Error('JOB_ASK_INVALID');
    const checkpoint = checkpoints.find(item => item.id === checkpointId);
    return {
        step,
        title: checkpoint?.title ?? checkpointId,
        note: checkpoint?.note ?? '',
    };
}

/** No network, DOM or storage is accessed until the supplied adapter does so. */
export function createJobWindow<Prepared>(options: {
    jobId: string;
    pageId: string;
    transport: JobWindowTransport;
    adapter: JobWindowAdapter<Prepared>;
}) {
    const { transport, adapter, pageId } = options;
    const pending = new Map<string, JobPendingAsk>();
    const rigAttempts = new WeakSet<JobUISubmission>();
    const retainedDrafts: JobRetainedDraft[] = [];
    let generation = 0;
    let displayed: JobDisplayPublication | null = null;
    let receipt: JobDisplayReceipt | null = null;
    let preparing = false;
    let closed = false;
    let error: string | null = null;
    let previousLabel: string | null = null;
    let intent = 0;
    let stopped = false;
    let controller: AbortController | null = null;
    let queue = Promise.resolve();
    function state(): JobWindowState {
        return {
            generation, displayed, receipt, preparing, closed, error, previousLabel,
            pending: [...pending.values()], retainedDrafts: [...retainedDrafts],
        };
    }
    function changed(): void { adapter.changed(state()); }
    function replace(publication: JobPublication): Promise<void> {
        if (stopped)
            return Promise.resolve();
        const revision = ++intent;
        controller?.abort();
        const abort = new AbortController();
        controller = abort;
        preparing = true;
        error = null;
        changed();
        queue = queue.then(async () => {
            if (revision !== intent || stopped)
                return;
            let prepared: Prepared | undefined;
            let committed: JobPreparedCommit | undefined;
            try {
                if (publication.visual.status !== 'available')
                    throw new Error(publication.visual.code);
                const candidate = unwrap(await transport.readPublication(publication.publicationId, abort.signal));
                if (candidate.publication.publicationId !== publication.publicationId ||
                    candidate.publication.source.sourceHash !== publication.source.sourceHash ||
                    candidate.publication.instanceKey !== publication.instanceKey ||
                    candidate.publication.generation !== publication.generation ||
                    sourceSnapshot(candidate.publication.source) !== sourceSnapshot(publication.source)) {
                    throw new Error('JOB_DISPLAY_MISMATCH');
                }
                prepared = await adapter.prepare(candidate, abort.signal);
                if (revision !== intent || stopped)
                    return;
                const draft = adapter.captureDraft();
                committed = adapter.commit(prepared, candidate);
                await adapter.painted(prepared, abort.signal);
                if (revision !== intent || stopped)
                    return;
                const acknowledged = unwrap(await transport.acknowledge({
                    publicationId: publication.publicationId, pageId,
                    sourceHash: publication.source.sourceHash,
                }, abort.signal));
                if (revision !== intent || stopped)
                    return;
                if (acknowledged.publicationId !== publication.publicationId ||
                    acknowledged.pageId !== pageId || !acknowledged.displayedNonce) {
                    throw new Error('JOB_DISPLAY_MISMATCH');
                }
                if (displayed && draft !== null) {
                    retainedDrafts.push({
                        publicationId: displayed.publication.publicationId,
                        sourceHash: displayed.publication.source.sourceHash,
                        source: structuredClone(displayed.publication.source),
                        label: displayed.publication.label,
                        value: structuredClone(draft),
                    });
                }
                previousLabel = displayed?.publication.label ?? null;
                displayed = candidate;
                receipt = acknowledged;
                const cleanup = committed;
                committed = undefined;
                prepared = undefined;
                try {
                    cleanup.finalize();
                }
                catch {
                    error = 'JOB_WINDOW_CLEANUP_FAILED';
                }
            }
            catch (failure) {
                if (revision === intent && !stopped)
                    error = failure instanceof Error ? failure.message : 'JOB_DISPLAY_MISMATCH';
            }
            finally {
                committed?.rollback();
                if (prepared !== undefined)
                    adapter.discard(prepared);
                if (revision === intent) {
                    preparing = false;
                    changed();
                }
            }
        });
        return queue;
    }
    function event(value: JobEvent): void {
        if (stopped || value.jobId !== options.jobId)
            return;
        generation = Math.max(generation, value.generation);
        if (value.type === 'published') {
            for (const [id, ask] of pending) {
                if (ask.status === 'pending' && ask.publicationId !== value.publication.publicationId) {
                    pending.set(id, { ...ask, status: 'superseded' });
                }
            }
            if (value.publication.publicationId !== displayed?.publication.publicationId)
                void replace(value.publication);
        }
        else if (value.type === 'pending') {
            pending.set(value.ask.askId, value.ask);
        }
        else if (value.type === 'act') {
            const ask = pending.get(value.act.askId);
            if (ask)
                pending.set(ask.askId, { ...ask, status: 'answered' });
        }
        else if (value.type === 'closed') {
            closed = true;
        }
        changed();
    }
    async function submit(input: JobUISubmission): Promise<JobResult<JobAct>> {
        if (closed)
            return { ok: false, error: { code: 'JOB_CLOSED', message: 'JOB_CLOSED' } };
        const ask = pending.get(input.askId);
        const retry = input.capture !== undefined && rigAttempts.has(input);
        if (preparing || !displayed || !receipt ||
            input.publicationId !== displayed.publication.publicationId ||
            input.pageId !== pageId || input.displayedNonce !== receipt.displayedNonce ||
            input.expectedGeneration > generation ||
            ask && (ask.status !== 'pending' && !retry || ask.publicationId !== input.publicationId || ask.subject.kind !== input.kind)) {
            return { ok: false, error: { code: 'JOB_ACT_SOURCE_STALE', message: 'JOB_ACT_SOURCE_STALE' } };
        }
        // The backend authenticates the actual Request and validates the semantic value.
        if (input.capture !== undefined) rigAttempts.add(input);
        return transport.submit(input);
    }
    return {
        event, replace, submit, state, refresh: changed,
        settled: () => queue,
        stop() { stopped = true; ++intent; controller?.abort(); },
    };
}
export interface JobWindowAccess {
    readonly jobId: string;
    readonly base: string;
    readonly capability: string | null;
    route(path: string): string;
    headers(init?: HeadersInit): Headers;
}
/** The owner capability stays in this page's memory and its own job-scoped tab slot. */
export function jobWindowAccess(href: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null, replace: (href: string) => void): JobWindowAccess {
    const url = new URL(href);
    const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/$/.exec(url.pathname);
    if (!match)
        throw new Error('JOB_REQUEST_INVALID');
    const jobId = match[1]!;
    const base = url.pathname;
    const slot = 'rig-review-job-capability/1:' + jobId;
    let capability: string | null = null;
    if (url.hash.startsWith('#cap=')) {
        const value = url.hash.slice(5);
        if (/^[a-f0-9]{64}$/.test(value))
            capability = value;
        url.hash = '';
        replace(url.href);
        try {
            if (capability)
                storage?.setItem(slot, capability);
        }
        catch { /* Memory-only capability when storage is denied. */ }
    }
    if (!capability) {
        try {
            const saved = storage?.getItem(slot);
            if (saved && /^[a-f0-9]{64}$/.test(saved))
                capability = saved;
        }
        catch { /* A copied link remains read-only. */ }
    }
    return {
        jobId, base, capability,
        route(path) {
            if (path.startsWith('/') || /[\\\x00-\x20]/.test(path) || path.split('?')[0]!.split('/').some(part => part === '..' || part === '.')) {
                throw new Error('JOB_REQUEST_INVALID');
            }
            return base + path;
        },
        headers(init) {
            const headers = new Headers(init);
            if (capability)
                headers.set('X-Review-Capability', capability);
            return headers;
        },
    };
}
/** Resolve only the publication's explicit immutable instance routes. */
export function jobPublicationRoutes(display: JobDisplayPublication, origin: string) {
    const key = display.publication.instanceKey;
    if (!/^[a-f0-9]{64}$/.test(key))
        throw new Error('JOB_DISPLAY_MISMATCH');
    const match = /^\/jobs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/publications\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/instances\/([a-f0-9]{64})\/$/.exec(display.routes.entry);
    if (!match || match[2] !== display.publication.publicationId || match[3] !== key) {
        throw new Error('JOB_DISPLAY_MISMATCH');
    }
    const prefix = display.routes.entry;
    function checked(path: string): URL {
        if (!path.startsWith(prefix) || /[\\?#]/.test(path) || /%(?:2e|2f|5c)/i.test(path)) {
            throw new Error('JOB_DISPLAY_MISMATCH');
        }
        const url = new URL(path, origin);
        if (url.origin !== origin || !url.pathname.startsWith(prefix))
            throw new Error('JOB_DISPLAY_MISMATCH');
        return url;
    }
    const entry = checked(display.routes.entry);
    const apiBase = checked(display.routes.apiBase);
    const assetsBase = checked(display.routes.assetsBase);
    if (!entry.pathname.endsWith('/') || !apiBase.pathname.endsWith('/') || !assetsBase.pathname.endsWith('/')) {
        throw new Error('JOB_DISPLAY_MISMATCH');
    }
    return {
        entry: entry.href,
        api(path: string) {
            if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(path) || path.includes('..'))
                throw new Error('JOB_DISPLAY_MISMATCH');
            return checked(apiBase.pathname + path).href;
        },
        asset(path: string) {
            if (!path || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/.test(path)) {
                throw new Error('JOB_DISPLAY_MISMATCH');
            }
            return checked(assetsBase.pathname + path.split('/').map(encodeURIComponent).join('/')).href;
        },
        instance(path: string) {
            if (!path.startsWith('/') || path.startsWith('//'))
                throw new Error('JOB_DISPLAY_MISMATCH');
            return checked(prefix + path.slice(1)).href;
        },
        assertAsset(url: string): string {
            const requested = new URL(url);
            const value = checked(requested.pathname);
            if (requested.origin !== origin || requested.search || requested.hash || requested.username || requested.password ||
                !value.pathname.startsWith(assetsBase.pathname)) {
                throw new Error('JOB_DISPLAY_MISMATCH');
            }
            return value.href;
        },
    };
}
/** Raw UI-only mutations stay separate from the agent API. No capability is put in a URL. */
export function createJobWindowTransport(access: JobWindowAccess, fetcher: typeof fetch = fetch): JobWindowTransport {
    async function read<Value>(path: string, init?: RequestInit): Promise<JobResult<Value>> {
        const response = await fetcher(access.route(path), { ...init, headers: access.headers(init?.headers) });
        const value = await response.json() as JobResult<Value>;
        if (typeof value?.ok !== 'boolean')
            throw new Error('JOB_REQUEST_INVALID');
        if (!response.ok && value.ok)
            throw new Error('JOB_REQUEST_INVALID');
        return value;
    }
    function post<Value>(path: string, body: unknown, signal?: AbortSignal) {
        return read<Value>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    }
    return {
        readPublication: (id, signal) => read('publications/' + encodeURIComponent(id), { signal }),
        acknowledge: (body, signal) => post('ui/displayed', body, signal),
        submit: body => post('ui/acts', body),
    };
}
/** Bounded newline events. Reconnects resume after the last fully parsed event. */
export async function* jobWindowEvents(access: JobWindowAccess, after: string | null, signal: AbortSignal, fetcher: typeof fetch = fetch): AsyncGenerator<JobEvent> {
    const path = 'events' + (after === null ? '' : '?after=' + encodeURIComponent(after));
    const response = await fetcher(access.route(path), { signal, headers: access.headers() });
    if (!response.ok || !response.body)
        throw new Error('JOB_STREAM_FAILED');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    const limit = 1024 * 1024;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) {
                buffered += decoder.decode();
                if (buffered.length)
                    throw new Error('JOB_STREAM_INCOMPLETE');
                return;
            }
            buffered += decoder.decode(next.value, { stream: true });
            let newline = buffered.indexOf('\n');
            while (newline >= 0) {
                if (newline > limit)
                    throw new Error('JOB_BODY_LIMIT');
                const event = JSON.parse(buffered.slice(0, newline)) as JobEvent;
                if (!event || event.jobId !== access.jobId || typeof event.cursor !== 'string' ||
                    !Number.isSafeInteger(event.generation) || event.generation < 0 ||
                    !['published', 'pending', 'act', 'closed'].includes(event.type))
                    throw new Error('JOB_STREAM_FAILED');
                buffered = buffered.slice(newline + 1);
                yield event;
                newline = buffered.indexOf('\n');
            }
            if (buffered.length > limit)
                throw new Error('JOB_BODY_LIMIT');
        }
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** One reader per window. Hub members bootstrap before visibility can suspend transport. */
export function startJobWindowEvents(options: {
    access: JobWindowAccess;
    signal: AbortSignal;
    member: boolean;
    event(value: JobEvent): void;
    refused(error: unknown): void;
    fetcher?: typeof fetch;
}) {
    let bootstrap = options.member;
    let visible = !options.member;
    let cursor: string | null = null;
    let reader: AbortController | null = null;
    let wake: (() => void) | null = null;
    const enabled = () => bootstrap || visible;
    function changed() {
        if (!enabled()) reader?.abort();
        wake?.();
    }
    const stopped = () => { reader?.abort(); wake?.(); };
    options.signal.addEventListener('abort', stopped, {once: true});
    function wait(milliseconds?: number): Promise<void> {
        return new Promise(resolve => {
            const timer = milliseconds === undefined ? undefined : setTimeout(finish, milliseconds);
            function finish() { clearTimeout(timer); wake = null; resolve(); }
            wake = finish;
            if (options.signal.aborted) finish();
        });
    }
    const done = (async () => {
        try {
            while (!options.signal.aborted) {
                if (!enabled()) { await wait(); continue; }
                const current = new AbortController();
                reader = current;
                try {
                    for await (const event of jobWindowEvents(options.access, cursor, current.signal, options.fetcher)) {
                        // Only complete, delivered events advance replay, including a final event racing hide.
                        options.event(event);
                        cursor = event.cursor;
                        if (event.type === 'closed') return;
                    }
                } catch (error) {
                    if (!current.signal.aborted && !options.signal.aborted) options.refused(error);
                } finally { reader = null; }
                if (!options.signal.aborted && enabled() && !current.signal.aborted) await wait(500);
            }
        } finally { options.signal.removeEventListener('abort', stopped); }
    })();
    return {
        done,
        visibility(value: boolean) { if (options.member) { bootstrap = false; visible = value; changed(); } },
        displayed() { if (options.member) { bootstrap = false; changed(); } },
    };
}
import type { ModelAssets, RigPlayer } from '@rig-c/play';
import type { PartInspection } from './part-selection.ts';
import type { Checkpoint, ReviewManifest, ReviewedSource } from '../src/manifest.ts';
import type { DirectionInspection } from '../src/direction-inspection.ts';
import type { FeedbackCatalog } from '../src/feedback-validation.ts';
import type { InterviewQuestion } from '../src/interview-project.ts';
export interface JobInspectionMetadata {
    manifest: ReviewManifest;
    sourceHash: string;
    reviewedSource: ReviewedSource;
    setsHash?: string;
    initialAnimation?: string | null;
    direction?: DirectionInspection;
    referenceHashes?: Record<string, string>;
    sourcePainting?: {
        id: string;
        path: string;
        sha256: string;
        url: string;
    };
    capabilities: {
        interview?: boolean;
        preRig?: boolean;
        playback: boolean;
    };
    feedbackCatalog: Pick<FeedbackCatalog, 'slots'>;
}
type JobInterview = {
    questions: (Omit<InterviewQuestion, 'images'> & {
        images: {
            name: string;
            url: string;
        }[];
    })[];
};
interface JobPartsInventory {
    sourceHash: string;
    rigSize: [
        number,
        number
    ] | null;
    items: {
        name: string;
        index: number;
        x: number;
        y: number;
        w: number;
        h: number;
        imageHash?: string;
    }[];
}
interface JobReferenceView {
    id: string;
    label: string;
    element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
    width: number;
    height: number;
    seek(time: number, signal: AbortSignal): Promise<void>;
}

/** A reference stays off-stage until its seek matches the latest inspection time. */
export function createJobReferenceSelection<Reference extends Pick<JobReferenceView, 'seek'>>(options: {
    current(): {owner: object | null; time: number};
    present(reference: Reference): void;
    refused(error: unknown): void;
}) {
    let intent = 0;
    let controller: AbortController | null = null;
    function cancel(): void {
        intent++;
        controller?.abort();
        controller = null;
    }
    async function select(reference: Reference): Promise<void> {
        cancel();
        const revision = intent;
        const owner = options.current().owner;
        if (!owner) return;
        const abort = new AbortController();
        controller = abort;
        let time = options.current().time;
        try {
            for (;;) {
                await reference.seek(time, abort.signal);
                const latest = options.current();
                if (abort.signal.aborted || revision !== intent || latest.owner !== owner) return;
                if (latest.time !== time) {
                    time = latest.time;
                    continue;
                }
                options.present(reference);
                return;
            }
        } catch (error) {
            if (!abort.signal.aborted && revision === intent && options.current().owner === owner)
                options.refused(error);
        }
    }
    return {select, cancel};
}

export interface JobPreparedInspection {
    display: JobDisplayPublication;
    metadata: JobInspectionMetadata;
    interview: JobInterview | null;
    parts: JobPartsInventory | null;
    partImages: Map<string, HTMLImageElement>;
    interviewImages: Map<string, HTMLImageElement>;
    imageSetImages?: readonly HTMLImageElement[];
    references: JobReferenceView[];
    assets: ModelAssets | null;
    player: RigPlayer | null;
    rigRoot: HTMLElement;
    rigPresentation?: JobRigPresentation;
    inspection: PartInspection | null;
    setupPose(setup?: boolean): void;
    dispose(): void;
}
async function jobBytes(url: string, signal: AbortSignal, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body)
        throw new Error('JOB_PRELOAD_FAILED');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done)
                break;
            size += next.value.length;
            if (size > maximum)
                throw new Error('JOB_BODY_LIMIT');
            chunks.push(next.value);
        }
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}
async function jobDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
}
async function jobJson<Value>(url: string, signal: AbortSignal): Promise<Value> {
    const bytes = await jobBytes(url, signal, 2 * 1024 * 1024);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Value;
}
function mediaReady(media: HTMLVideoElement, name: 'loadeddata' | 'seeked', signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
            clearTimeout(timer);
            media.removeEventListener(name, loaded);
            media.removeEventListener('error', failed);
            signal.removeEventListener('abort', failed);
            if (error)
                reject(error);
            else
                resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error('JOB_VISUAL_UNAVAILABLE'));
        const timer = setTimeout(failed, 10000);
        media.addEventListener(name, loaded, { once: true });
        media.addEventListener('error', failed, { once: true });
        signal.addEventListener('abort', failed, { once: true });
        if (signal.aborted)
            failed();
    });
}
/** Prepare the real published Play model, references and every form dependency off-stage. */
export async function prepareJobInspection(display: JobDisplayPublication, signal: AbortSignal): Promise<JobPreparedInspection> {
    const routes = jobPublicationRoutes(display, location.origin);
    const metadata = await jobJson<JobInspectionMetadata>(routes.api('review'), signal);
    if (metadata.manifest.id !== display.publication.source.package.id ||
        metadata.manifest.revision !== display.publication.source.package.revision ||
        (metadata.reviewedSource.rig?.sha256 ?? null) !== (display.publication.source.model?.sha256 ?? null)) {
        throw new Error('JOB_DISPLAY_MISMATCH');
    }
    const objectUrls: string[] = [];
    const media: HTMLVideoElement[] = [];
    const rigRoot = document.createElement('div');
    rigRoot.id = 'rig-root';
    let assets: ModelAssets | null = null;
    let player: RigPlayer | null = null;
    let inspection: PartInspection | null = null;
    let resetToSetup: (setup?: boolean) => void = () => {};
    let rigPresentation: JobRigPresentation | undefined;
    function clearRigPresentation(): void {
        rigPresentation?.canvas.parentElement?.removeAttribute('data-job-rig-canonical');
        rigPresentation?.canvas.remove();
        rigPresentation = undefined;
    }
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        clearRigPresentation();
        for (const video of media) {
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        player?.dispose();
        assets?.dispose();
        for (const url of objectUrls)
            URL.revokeObjectURL(url);
    };
    async function visualBytes(url: string, hash?: string) {
        const bytes = await jobBytes(url, signal, 128 * 1024 * 1024);
        if (hash && await jobDigest(bytes) !== hash)
            throw new Error('JOB_SOURCE_MISMATCH');
        return bytes;
    }
    async function image(url: string, hash?: string): Promise<HTMLImageElement> {
        const bytes = await visualBytes(url, hash);
        const blob = URL.createObjectURL(new Blob([bytes.slice().buffer]));
        objectUrls.push(blob);
        const image = new Image();
        image.src = blob;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight || signal.aborted)
            throw new Error('JOB_VISUAL_UNAVAILABLE');
        return image;
    }
    try {
        const interview = metadata.capabilities.interview ? await jobJson<JobInterview>(routes.api('interview'), signal) : null;
        const parts = metadata.capabilities.preRig ? await jobJson<JobPartsInventory>(routes.api('stage-parts'), signal) : null;
        const references: JobReferenceView[] = [];
        const partImages = new Map<string, HTMLImageElement>();
        const interviewImages = new Map<string, HTMLImageElement>();
        const preload: Promise<void>[] = [];
        const imageSetImages: HTMLImageElement[] = [];
        const source = display.publication.source;
        if (source.subject === 'image-set') {
            if (metadata.sourceHash !== source.sourceHash || metadata.manifest.model)
                throw new Error('JOB_DISPLAY_MISMATCH');
            const canonical = source.imageSet.images.map(({role, name, sha256}) => ({role, name, sha256}));
            if (source.imageSet.images.length < 2 || source.imageSet.images.length > 8 ||
                await jobDigest(new TextEncoder().encode(JSON.stringify(canonical))) !== source.imageSetDigest)
                throw new Error('JOB_SOURCE_MISMATCH');
            for (const [index, entry] of source.imageSet.images.entries()) {
                preload.push(image(routes.api('image-set/' + index), entry.sha256).then(element => {
                    element.alt = entry.name;
                    imageSetImages[index] = element;
                }));
            }
        }
        for (const reference of metadata.manifest.references) {
            preload.push((async () => {
                if (reference.type === 'image') {
                    const element = await image(routes.asset(reference.path), metadata.referenceHashes?.[reference.id]);
                    element.alt = reference.label;
                    references.push({ id: reference.id, label: reference.label, element,
                        width: element.naturalWidth, height: element.naturalHeight, seek: async () => { } });
                }
                else if (reference.type === 'video') {
                    const bytes = await visualBytes(routes.asset(reference.path), metadata.referenceHashes?.[reference.id]);
                    const element = document.createElement('video');
                    media.push(element);
                    const blob = URL.createObjectURL(new Blob([bytes.slice().buffer]));
                    objectUrls.push(blob);
                    element.preload = 'auto';
                    element.muted = true;
                    element.playsInline = true;
                    const ready = mediaReady(element, 'loadeddata', signal);
                    element.src = blob;
                    await ready;
                    references.push({ id: reference.id, label: reference.label, element,
                        width: element.videoWidth, height: element.videoHeight,
                        async seek(time, abort) {
                            if (!Number.isFinite(time) || time < 0 || time > element.duration)
                                throw new Error('REFERENCE_OUT_OF_DOMAIN');
                            if (element.currentTime === time && element.readyState >= 2 && !element.seeking)
                                return;
                            const ready = mediaReady(element, 'seeked', abort);
                            element.currentTime = time;
                            await ready;
                            while (element.seeking) await mediaReady(element, 'seeked', abort);
                        } });
                }
                else {
                    // Pose references retain their own declared points. No inferred rig mapping.
                    const bytes = await visualBytes(routes.asset(reference.path), metadata.referenceHashes?.[reference.id]);
                    const pose = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    const element = document.createElement('canvas');
                    if (!Number.isSafeInteger(pose.width) || !Number.isSafeInteger(pose.height) || pose.width <= 0 || pose.height <= 0) {
                        throw new Error('JOB_VISUAL_UNAVAILABLE');
                    }
                    element.width = pose.width;
                    element.height = pose.height;
                    const context = element.getContext('2d');
                    if (!context)
                        throw new Error('JOB_VISUAL_UNAVAILABLE');
                    const draw = async (time: number) => {
                        context.clearRect(0, 0, element.width, element.height);
                        context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg-strong');
                        if (pose.spec === 'rig-pose-sequence/1') {
                            const frames = pose.frames as {
                                t: number;
                                people: {
                                    joints: Record<string, {
                                        at?: [
                                            number,
                                            number
                                        ];
                                    }>;
                                }[];
                            }[];
                            const first = frames[0]?.t;
                            const frame = frames.filter(frame => frame.t - first <= time).at(-1);
                            if (!frame || time > frames.at(-1)!.t - first)
                                throw new Error('REFERENCE_OUT_OF_DOMAIN');
                            for (const person of frame.people)
                                for (const [name, joint] of Object.entries(person.joints)) {
                                    if (!joint.at)
                                        continue;
                                    context.beginPath();
                                    context.arc(joint.at[0], joint.at[1], 3, 0, Math.PI * 2);
                                    context.fill();
                                    context.fillText(name, joint.at[0] + 4, joint.at[1]);
                                }
                        }
                        else if (pose.schema === 'rig-review-pose/1') {
                            for (const joint of pose.joints as {
                                id: string;
                                x: number;
                                y: number;
                            }[]) {
                                context.beginPath();
                                context.arc(joint.x, joint.y, 3, 0, Math.PI * 2);
                                context.fill();
                                context.fillText(joint.id, joint.x + 4, joint.y);
                            }
                        }
                        else
                            throw new Error('JOB_VISUAL_UNAVAILABLE');
                    };
                    await draw(0);
                    references.push({ id: reference.id, label: reference.label, element,
                        width: element.width, height: element.height, seek: draw });
                }
            })());
        }
        if (metadata.sourcePainting) {
            const source = metadata.sourcePainting;
            preload.push(image(routes.instance(source.url), source.sha256).then(element => {
                element.alt = source.path;
                references.push({ id: source.id, label: source.path, element,
                    width: element.naturalWidth, height: element.naturalHeight, seek: async () => { } });
            }));
        }
        for (const part of parts?.items ?? []) {
            preload.push(image(routes.api('stage-parts/image/' + part.index), part.imageHash)
                .then(element => { element.alt = part.name; partImages.set(part.name, element); }));
        }
        for (const question of interview?.questions ?? [])
            for (const asset of question.images) {
                preload.push(image(routes.instance(asset.url)).then(element => { element.alt = asset.name; interviewImages.set(asset.url, element); }));
            }
        const preloaded = await Promise.allSettled(preload);
        const failed = preloaded.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        if (metadata.manifest.model) {
            const runtime = await import('@rig-c/play');
            const modelUrl = routes.asset(metadata.manifest.model);
            const modelHash = metadata.reviewedSource.rig!.sha256;
            const setsUrl = metadata.manifest.sets ? routes.asset(metadata.manifest.sets) : null;
            const checkedFetch = new Proxy(fetch, { apply: async (_target, _receiver, args: Parameters<typeof fetch>) => {
                    const url = String(args[0]);
                    const expected = url === modelUrl ? modelHash : url === setsUrl ? metadata.setsHash : null;
                    if (!expected)
                        throw new Error('JOB_SOURCE_MISMATCH');
                    const bytes = await visualBytes(url, expected);
                    return new Response(bytes);
                } });
            assets = await runtime.loadModel({ modelUrl, setsUrl, fetch: checkedFetch,
                resolvePage: (name, url) => routes.assertAsset(new URL(name, url).href) });
            const loadedAssets = assets;
            const parts = await import('./part-selection.ts');
            const catalog = await parts.loadPartModel(modelUrl, modelHash, metadata.feedbackCatalog.slots ?? [], checkedFetch);
            resetToSetup = (setup = true) => {
                clearRigPresentation();
                player?.dispose();
                player = new runtime.RigPlayer(rigRoot, loadedAssets);
                inspection = new parts.PartInspection();
                inspection.register('single', catalog.entries, player);
                if (setup) {
                    player.clear(0, {mix: 0});
                    player.draw();
                    inspection.present('single');
                }
            };
            resetToSetup();
        }
        if (!player && !references.length && !partImages.size && !imageSetImages.length)
            throw new Error('JOB_VISUAL_UNAVAILABLE');
        if (signal.aborted)
            throw new Error('JOB_PRELOAD_CANCELLED');
        // Preloads can finish out of order. Restore the producer's declared display order.
        const order = [metadata.sourcePainting?.id, ...metadata.manifest.references.map(reference => reference.id)];
        references.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        return {
            display, metadata, interview, parts, partImages, interviewImages, imageSetImages, references, assets, rigRoot,
            get rigPresentation() { return rigPresentation; },
            set rigPresentation(value) {
                clearRigPresentation();
                rigPresentation = value;
            },
            get player() { return player; },
            get inspection() { return inspection; },
            setupPose: (setup = true) => resetToSetup(setup),
            dispose,
        };
    }
    catch (error) {
        dispose();
        throw error;
    }
}
/** Browser mount is explicit so importing transaction helpers never starts an app. */
export async function mountJobSession(host: HTMLElement): Promise<() => void> {
    const [{ createViewportController, createViewportState }, { createRigViewportProvider }, { mountViewportPair }, i18n] = await Promise.all([
        import('./viewport-controller.ts'), import('./rig-viewport-provider.ts'),
        import('./viewport-pair.ts'), import('./i18n.ts'),
    ]);
    let storage: Storage | null = null;
    try {
        storage = sessionStorage;
    }
    catch { /* Capability stays in memory. */ }
    const access = jobWindowAccess(location.href, storage, href => history.replaceState(history.state, '', href));
    const hubIncarnation = new URL(location.href).searchParams.get('hub');
    let hubVisible = !hubIncarnation;
    let events: ReturnType<typeof startJobWindowEvents> | undefined;
    const pageId = crypto.randomUUID();
    const transport = createJobWindowTransport(access);
    const abort = new AbortController();
    const language = new URL(location.href).searchParams.get('lang');
    if (language === 'en' || language === 'ko')
        i18n.setLanguagePreference(language);
    const t = i18n.t;
    const node = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, key?: string) => {
        const value = document.createElement(tag);
        if (key) {
            value.dataset.jobText = key;
            value.textContent = t(key);
        }
        return value;
    };
    const title = node('h1', 'job.title');
    const languages = node('select');
    for (const value of ['en', 'ko']) {
        const option = node('option');
        option.value = value;
        option.textContent = value;
        languages.append(option);
    }
    languages.value = i18n.getLanguage();
    languages.setAttribute('aria-label', t('interview.language'));
    languages.onchange = () => { i18n.setLinkLanguage(null); i18n.setLanguagePreference(languages.value === 'ko' ? 'ko' : 'en'); };
    const header = node('header');
    header.className = 'job-header';
    header.append(title, languages);
    const notice = node('p', 'job.waiting');
    notice.className = 'job-notice';
    notice.setAttribute('role', 'status');
    const workspace = node('main');
    host.classList.add('job-window');
    host.replaceChildren(header, notice, workspace);
    let current: JobPreparedInspection | null = null;
    let currentElement: HTMLElement | null = null;
    let animation = '';
    let time = 0;
    let playing = false;
    let loop = true;
    let playbackCarry = 0;
    let rafHandle = 0;
    let lastFrameTime = 0;
    let selectedPart = '';
    let partMode: 'context' | 'solo' = 'context';
    let selectedReference = '';
    let panel = '3';
    let compatibilityNotice = false;
    type JobForm = {
        form: HTMLFormElement;
        fieldset: HTMLFieldSetElement;
        read: () => JobUISubmission['value'];
        submissionId: string;
        dirty: boolean;
        rigSubmission: ReturnType<typeof createJobRigSubmission>;
    };
    type PreparedWindow = JobPreparedInspection & {
        element: HTMLElement;
        forms: Map<string, JobForm>;
    };
    const forms = new Map<string, JobForm>();
    const drawn = new WeakMap<JobPreparedInspection, JobRigDraw>();
    let drawGeneration = 0;
    const viewportState = createViewportState();
    const el = <Element extends HTMLElement = HTMLElement>(id: string): Element => {
        const element = workspace.querySelector<HTMLElement>('#' + id);
        if (!element)
            throw new Error('JOB_WINDOW_ELEMENT_MISSING');
        return element as Element;
    };
    const reference = () => current?.references.find(item => item.id === selectedReference) ?? null;
    const setText = (id: string, value: string) => { const element = workspace.querySelector('#' + id); if (element)
        element.textContent = i18n.tr(value); };
    const provider = createRigViewportProvider({
        el, player: () => current?.player ?? null, assets: () => current?.assets ?? null,
        referenceSize: () => reference(), view: () => 'compare', referenceGeneration: () => current?.display.publication.generation ?? 0,
        parts: () => current?.inspection ?? null, text: setText,
        message: value => { notice.textContent = jobWindowRefusal(value); }, redrawOverlay: () => { },
    }, viewportState);
    const canonicalControls = provider.renderControls;
    provider.renderControls = controller => {
        canonicalControls(controller);
        const fit = el('fit');
        fit.textContent = t(fit.textContent ?? 'Fit');
    };
    const viewport = createViewportController(provider, viewportState);
    const renderViewport = provider.render;
    provider.render = controller => {
        try {renderViewport(controller); rememberDraw();}
        catch (error) {
            if (current) {
                drawn.delete(current);
                current.rigPresentation = undefined;
            }
            throw error;
        }
    };
    function rigDrawState(): JobRigDrawState {
        const owner = current, player = owner?.player;
        if (!owner || !player || !hubVisible) throw new Error('JOB_STILL_CAPTURE_FAILED');
        const pane = el('rig-viewport'), root = owner.rigRoot, rect = pane.getBoundingClientRect();
        const ratio = globalThis.devicePixelRatio || 1;
        const frame = viewport.paneFrame('rig'), camera = viewport.numericView().cameras.rig;
        if (!frame || !camera || !pane.isConnected || !root.isConnected || el('rig-pane').hidden ||
            rect.width <= 0 || rect.height <= 0) throw new Error('JOB_STILL_CAPTURE_FAILED');
        const style = getComputedStyle(root), paneStyle = getComputedStyle(pane);
        const plain = style.filter === 'none' && style.perspective === 'none' && style.opacity === '1' &&
            paneStyle.filter === 'none' && paneStyle.transform === 'none' && paneStyle.perspective === 'none' && paneStyle.opacity === '1';
        const presentation = owner.rigPresentation;
        const canvas = presentation?.canvas;
        const pixels = canvas?.getBoundingClientRect();
        const canvasStyle = canvas ? getComputedStyle(canvas) : null;
        if (canvas && (!canvas.isConnected || canvasStyle?.visibility !== 'visible' ||
            canvasStyle.display === 'none' || canvasStyle.opacity !== '1' || canvasStyle.filter !== 'none' ||
            canvasStyle.transform !== 'none')) throw new Error('JOB_STILL_CAPTURE_FAILED');
        return {player, presentation, frameGeneration: owner.inspection?.frame('single')?.generation,
            source: {pageId, publicationId: owner.display.publication.publicationId,
                instanceKey: owner.display.publication.instanceKey, sourceHash: owner.display.publication.source.sourceHash},
            layout: JSON.stringify([
                pane.clientWidth, pane.clientHeight, rect.width, rect.height, ratio,
                root.getAttribute('style'), style.transform, camera, presentation?.area, presentation?.ratio,
                pixels ? jobRigPixelPlacement(rect, pixels, ratio) : null,
                pixels?.width, pixels?.height, canvas?.width, canvas?.height, canvas?.getAttribute('style'),
            ]),
            defaultCamera: plain && camera.zoom === 1 && camera.center.x === frame.center.x && camera.center.y === frame.center.y,
            wholeRig: !selectedPart && !owner.inspection?.value() && player.slots === null,
            playing};
    }
    function rememberDraw(): void {
        const owner = current;
        if (!owner) return;
        try {
            const player = owner.player;
            const posed = owner.inspection?.frame('single');
            const camera = viewport.numericView().cameras.rig;
            if (!hubVisible || !player || !owner.assets || !posed || !camera) {
                throw new Error('JOB_STILL_CAPTURE_FAILED');
            }
            const renderer = player.renderer;
            const pane = el('rig-viewport');
            const presentation = presentJobRigViewport({pane, root: owner.rigRoot, images: true,
                canvas: renderer instanceof CanvasRenderer ? renderer.canvas : undefined,
                backend: renderer instanceof CanvasRenderer ? renderer.backendActive : renderer.meshBackendActive},
                {camera, posed, assets: owner.assets});
            pane.append(presentation.canvas);
            owner.rigPresentation = presentation;
            pane.dataset.jobRigCanonical = '';
            drawn.set(owner, recordJobRigDraw(rigDrawState(), ++drawGeneration));
        } catch {
            drawn.delete(owner);
            owner.rigPresentation = undefined;
        }
    }
    function drawInspection(owner: JobPreparedInspection): void {
        drawn.delete(owner);
        owner.rigPresentation = undefined;
        owner.player?.draw();
        owner.inspection?.present('single');
    }
    function syncTransportControls(): void {
        const playBtn = workspace.querySelector<HTMLButtonElement>('#job-play');
        if (playBtn) {
            const clip = current?.assets?.animations.find(item => item.name === animation);
            playBtn.disabled = !animation || !clip || !(clip.duration > 0) || !current?.player;
            const key = playing ? 'Pause' : 'Play';
            playBtn.dataset.jobText = key;
            playBtn.textContent = t(key);
            playBtn.setAttribute('aria-pressed', String(playing));
        }
        const loopInput = workspace.querySelector<HTMLInputElement>('#job-loop');
        if (loopInput) loopInput.checked = loop;
    }
    function stopPlayback(targetPlayer = current?.player): void {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        }
        playing = false;
        playbackCarry = 0;
        lastFrameTime = 0;
        targetPlayer?.pause();
        syncTransportControls();
    }
    function presentCurrentFrame(owner: JobPreparedInspection): void {
        if (!owner.player) return;
        drawInspection(owner);
        owner.inspection?.select(selectedPart ? { side: 'single', slot: selectedPart, mode: partMode } : null);
        setText('job-part-observation', selectedPart ? JSON.stringify(owner.inspection?.observation(), null, 2) : '');
        viewport.fitCamera();
    }
    function armPlayback(expectedOwner: JobPreparedInspection, expectedPlayer: RigPlayer): void {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        }
        const handle = requestAnimationFrame(now => stepPlayback(handle, expectedOwner, expectedPlayer, now));
        rafHandle = handle;
    }
    function stepPlayback(handle: number, expectedOwner: JobPreparedInspection, expectedPlayer: RigPlayer, now: number): void {
        if (current !== expectedOwner || current?.player !== expectedPlayer) {
            expectedPlayer.pause();
            return;
        }
        if (handle !== rafHandle) return;
        rafHandle = 0;
        const clip = expectedOwner.assets?.animations.find(item => item.name === animation);
        if (!playing || !hubVisible || !animation || !clip || !(clip.duration > 0)) {
            stopPlayback(expectedPlayer);
            return;
        }
        const dt = lastFrameTime > 0 ? Math.min(Math.max(0, (now - lastFrameTime) / 1000), 0.1) : 0;
        lastFrameTime = now;
        const next = advancePlayback({ time, duration: clip.duration, carry: playbackCarry, elapsed: dt, repeat: loop });
        for (const step of next.steps) expectedPlayer.advance(step);
        const activeEntry = expectedPlayer.entry(0);
        if (!activeEntry || activeEntry.animation !== animation || activeEntry.loop !== loop ||
            !Number.isFinite(activeEntry.animationTime) || activeEntry.animationTime < 0 ||
            activeEntry.animationTime > activeEntry.duration) {
            stopPlayback(expectedPlayer);
            return;
        }
        playbackCarry = next.carry;
        if (next.ended) {
            playing = false;
            playbackCarry = 0;
            lastFrameTime = 0;
            expectedPlayer.pause();
            time = clip.duration;
        } else {
            time = activeEntry.animationTime;
        }
        const clock = workspace.querySelector<HTMLInputElement>('#job-time');
        if (clock) clock.value = String(time);
        syncTransportControls();
        presentCurrentFrame(expectedOwner);
        if (playing && current === expectedOwner && current.player === expectedPlayer && hubVisible) {
            armPlayback(expectedOwner, expectedPlayer);
        }
    }
    function copyRigVerdict(ask: JobPendingAsk, owner: JobPreparedInspection) {
        if (owner !== current || ask.publicationId !== owner.display.publication.publicationId) {
            throw new Error('JOB_STILL_BINDING_MISMATCH');
        }
        assertJobAskSource(ask, owner.display);
        return freezeJobRigCapture(drawn.get(owner), rigDrawState(), ask.askId, () => {
            if (!owner.rigPresentation) throw new Error('JOB_STILL_CAPTURE_FAILED');
            return copyJobRigViewport(owner.rigPresentation);
        });
    }
    const referenceSelection = createJobReferenceSelection<JobReferenceView>({
        current: () => ({owner: current, time}),
        present(value) {
            const previous = selectedReference;
            const camera = structuredClone(viewportState);
            selectedReference = value.id;
            try {
                showReference();
                el<HTMLSelectElement>('job-reference').value = value.id;
                viewport.fitCamera();
            } catch (error) {
                selectedReference = previous;
                Object.assign(viewportState, camera);
                showReference();
                el<HTMLSelectElement>('job-reference').value = previous;
                viewport.fitCamera();
                throw error;
            }
        },
        refused(error) {
            el<HTMLSelectElement>('job-reference').value = selectedReference;
            notice.textContent = jobWindowRefusal(error, 'JOB_VISUAL_UNAVAILABLE');
        },
    });
    let unbindNavigation: (() => void) | null = null;
    let resize: ResizeObserver | null = null;
    function localDraftKey(display: JobDisplayPublication): string {
        return 'rig-review-job-draft/1:' + access.jobId + ':' + display.publication.publicationId + ':' + display.publication.source.sourceHash;
    }
    function saveDraft(): void {
        if (!current)
            return;
        try {
            localStorage.setItem(localDraftKey(current.display), JSON.stringify({
                publicationId: current.display.publication.publicationId,
                sourceHash: current.display.publication.source.sourceHash,
                source: current.display.publication.source,
                label: current.display.publication.label,
                forms: [...forms].filter(([, item]) => item.dirty).map(([askId, item]) => ({
                    askId, value: item.read(),
                    controls: [...item.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')]
                        .map(input => ({ name: input.name, value: input.value })),
                })),
            }));
        }
        catch { /* The in-memory retained draft remains source-bound. */ }
    }
    function inputLabel(key: string, input: HTMLElement): HTMLElement {
        const label = node('label');
        label.append(node('span', key), input);
        return label;
    }
    function selectValues(values: readonly string[], labels: readonly string[]): HTMLSelectElement {
        const select = node('select');
        values.forEach((value, index) => {
            const option = node('option', labels[index]);
            option.value = value;
            select.append(option);
        });
        return select;
    }
    function textArea(parent: HTMLElement, key: string, name = 'note'): HTMLTextAreaElement {
        const input = node('textarea');
        input.name = name;
        parent.append(inputLabel(key, input));
        return input;
    }
    function formFor(ask: JobPendingAsk, prepared: JobPreparedInspection): JobForm {
        if (ask.publicationId !== prepared.display.publication.publicationId)
            throw new Error('JOB_DISPLAY_MISMATCH');
        assertJobAskSource(ask, prepared.display);
        const form = node('form');
        form.dataset.jobAsk = ask.askId;
        const fields = node('fieldset');
        form.append(fields);
        const source = node('p');
        source.className = 'job-source';
        source.textContent = prepared.display.publication.label + ' · ' + ask.source.sourceHash;
        fields.append(source);
        const note = textArea(fields, 'interview.note');
        let read: () => JobUISubmission['value'];
        let submitKey = 'Submit review';
        const subject = ask.subject;
        if (subject.kind === 'interview-picks') {
            const question = prepared.interview?.questions.find(item => item.set.id === subject.setId && item.set.question === subject.questionId);
            if (!question || !question.editable) throw new Error('JOB_ASK_INVALID');
            if (question.ref.sha256 !== ask.source.optionSet?.sha256) throw new Error('JOB_ACT_SOURCE_STALE');
            const heading = node('h3');
            heading.textContent = question.set.question;
            fields.prepend(heading);
            const answers = question.set.asks.map(item => {
                const group = node('fieldset');
                const legend = node('legend');
                legend.textContent = item.prompt;
                group.append(legend);
                const pick = node('select');
                pick.required = true;
                pick.name = 'choice.' + item.id;
                const empty = node('option', 'job.choose');
                empty.value = '';
                pick.append(empty);
                for (const choice of item.options) {
                    const option = node('option');
                    option.value = choice.id;
                    option.textContent = choice.label + ' · ' + choice.effect;
                    pick.append(option);
                }
                const other = node('textarea');
                other.hidden = true;
                other.name = 'other.' + item.id;
                const warning = node('p');
                warning.hidden = true;
                pick.onchange = () => {
                    const choice = item.options.find(option => option.id === pick.value);
                    other.hidden = choice?.kind !== 'other';
                    other.required = choice?.kind === 'other';
                    warning.hidden = choice?.kind === 'value';
                    warning.textContent = t(choice?.kind === 'other' ? 'interview.otherPending' : 'interview.autoPending');
                };
                group.append(pick, other, warning);
                fields.append(group);
                return { item, pick, other };
            });
            for (const image of question.images) {
                const visual = prepared.interviewImages.get(image.url);
                if (!visual)
                    throw new Error('JOB_VISUAL_UNAVAILABLE');
                fields.append(visual.cloneNode(true));
            }
            read = () => ({ questionId: subject.questionId,
                selections: answers.map(({ item, pick, other }) => ({ itemId: item.id, optionId: pick.value,
                    otherText: item.options.find(option => option.id === pick.value)?.kind === 'other' ? other.value : null })), note: note.value });
            submitKey = 'interview.save';
        }
        else if (subject.kind === 'checkpoint') {
            const checkpoint = jobCheckpointContext(ask, prepared.metadata.manifest.checkpoints);
            const heading = node('h3');
            heading.textContent = checkpoint.title;
            fields.prepend(heading);
            const guidance = node('p');
            guidance.textContent = checkpoint.note;
            const planStep = node('p');
            planStep.className = 'job-source';
            planStep.textContent = checkpoint.step.id + ' · ' + checkpoint.step.hash;
            fields.append(planStep, guidance);
            const outcome = selectValues(['', 'pass', 'fail'], ['Pending', 'Pass', 'job.fail']);
            outcome.required = true;
            outcome.name = 'outcome';
            fields.append(outcome);
            read = () => ({ checkpointId: subject.checkpointId, outcome: outcome.value as 'pass' | 'fail', words: note.value });
            submitKey = 'job.saveCheckpoint';
        }
        else if (subject.kind === 'parts-verdict') {
            if (!prepared.parts)
                throw new Error('JOB_ASK_INVALID');
            const verdict = selectValues(['pending', 'approved', 'changes-requested'], ['Pending', 'Approved', 'Changes requested']);
            verdict.name = 'verdict';
            fields.append(verdict);
            const parts = prepared.parts.items.map(part => {
                const group = node('fieldset');
                const legend = node('legend');
                legend.textContent = part.name;
                group.append(legend);
                const partOutcome = selectValues(['pending', 'clean', 'flagged'], ['Pending', 'Clean', 'Flagged']);
                const meshOutcome = selectValues(['pending', 'clean', 'flagged'], ['Pending', 'Clean', 'Flagged']);
                partOutcome.name = 'parts.' + part.name + '.outcome';
                meshOutcome.name = 'mesh.' + part.name + '.outcome';
                group.append(inputLabel('Parts', partOutcome));
                const partNote = textArea(group, 'Note', 'parts.' + part.name + '.note');
                group.append(inputLabel('Mesh', meshOutcome));
                const meshNote = textArea(group, 'Note', 'mesh.' + part.name + '.note');
                fields.append(group);
                return { partId: part.name, partOutcome, meshOutcome, partNote, meshNote };
            });
            read = () => ({ verdict: verdict.value as 'pending' | 'approved' | 'changes-requested', words: note.value,
                parts: parts.map(part => ({ partId: part.partId,
                    part: { outcome: part.partOutcome.value as 'pending' | 'clean' | 'flagged', note: part.partNote.value },
                    mesh: { outcome: part.meshOutcome.value as 'pending' | 'clean' | 'flagged', note: part.meshNote.value } })) });
            submitKey = 'job.savePartsVerdict';
        }
        else if (subject.kind === 'review-verdict') {
            const verdict = selectValues(['pending', 'approved', 'changes-requested'], ['Pending', 'Approved', 'Changes requested']);
            verdict.name = 'verdict';
            fields.append(verdict);
            const stage = subject.stage;
            if (stage === 'image-review') {
                const source = ask.source;
                if (source.subject !== 'image-set') throw new Error('JOB_ACT_SOURCE_STALE');
                const imageNotes = source.imageSet.images.map((image, index) => {
                    const group = node('fieldset');
                    const name = node('legend');
                    name.textContent = image.name;
                    group.append(name);
                    fields.append(group);
                    return {name: image.name, input: textArea(group, 'job.imageNote', 'image-note-' + index)};
                });
                read = () => {
                    const notes = imageNotes.filter(note => note.input.value !== '')
                        .map(note => ({name: note.name, words: note.input.value}));
                    return {stage, verdict: verdict.value as 'pending' | 'approved' | 'changes-requested', words: note.value,
                        ...(notes.length ? {imageNotes: notes} : {})};
                };
            } else {
                read = () => ({ stage, verdict: verdict.value as 'pending' | 'approved' | 'changes-requested', words: note.value });
            }
        }
        else if (subject.kind === 'signoff') {
            const stage = node('p');
            stage.textContent = subject.stage;
            fields.append(stage);
            read = () => ({ stage: subject.stage, decision: 'approved', words: note.value });
            submitKey = 'job.signoff';
        }
        else {
            throw new Error('JOB_ACT_KIND_DISABLED');
        }
        const submit = node('button', submitKey);
        submit.type = 'submit';
        fields.append(submit);
        const status = node('p');
        status.setAttribute('role', 'status');
        form.append(status);
        const entry: JobForm = { form, fieldset: fields, read, submissionId: crypto.randomUUID(), dirty: false,
            rigSubmission: createJobRigSubmission() };
        try {
            const saved = JSON.parse(localStorage.getItem(localDraftKey(prepared.display)) ?? 'null');
            if (saved?.publicationId === prepared.display.publication.publicationId &&
                saved?.sourceHash === prepared.display.publication.source.sourceHash) {
                const original = saved.forms?.find((item: {
                    askId: string;
                }) => item.askId === ask.askId);
                for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')) {
                    const restored = original?.controls?.find((item: {
                        name: string;
                        value: string;
                    }) => item.name === input.name);
                    if (restored && typeof restored.value === 'string') {
                        input.value = restored.value;
                        if (input instanceof HTMLSelectElement)
                            input.dispatchEvent(new Event('change'));
                    }
                }
                entry.dirty = !!original;
            }
        }
        catch { /* Invalid or unavailable local drafts grant no submission authority. */ }
        form.oninput = () => { entry.dirty = true; entry.submissionId = crypto.randomUUID(); entry.rigSubmission.reset(); saveDraft(); };
        form.onsubmit = async (event) => {
            event.preventDefault();
            const state = window.state();
            const receipt = state.receipt;
            if (!receipt || state.preparing || state.closed || !access.capability || !form.reportValidity())
                return;
            try {
                const input = { kind: subject.kind, publicationId: ask.publicationId,
                    askId: ask.askId, pageId, displayedNonce: receipt.displayedNonce,
                    expectedGeneration: state.generation, submissionId: entry.submissionId, value: read() } as JobUISubmission;
                const activeAsk = state.pending.find(item => item.askId === ask.askId);
                if (!activeAsk) throw new Error('JOB_ASK_INVALID');
                const pending = subject.kind === 'review-verdict' && subject.stage === 'rig-review'
                    ? entry.rigSubmission.prepare(input, () => copyRigVerdict(activeAsk, prepared)) : Promise.resolve(input);
                fields.disabled = true;
                const frozen = await pending;
                if (entry.submissionId !== frozen.submissionId) throw new Error('JOB_STILL_BINDING_MISMATCH');
                const result = await window.submit(frozen);
                if (!result.ok)
                    throw new Error(result.error.code);
                entry.dirty = false;
                entry.rigSubmission.reset();
                status.dataset.jobText = 'job.saved';
                status.textContent = t('job.saved');
                saveDraft();
            }
            catch (error) {
                status.dataset.jobText = error instanceof Error && Object.hasOwn(enCatalog, error.message) && Object.hasOwn(koCatalog, error.message)
                    ? error.message : 'JOB_ACT_INVALID';
                status.textContent = jobWindowRefusal(error, 'JOB_ACT_INVALID');
                fields.disabled = false;
            }
        };
        return entry;
    }
    function updateForms(state: JobWindowState): void {
        if (!current)
            return;
        const host = workspace.querySelector<HTMLElement>('[data-job-forms]');
        if (!host)
            return;
        for (const ask of state.pending) {
            if (ask.publicationId !== current.display.publication.publicationId)
                continue;
            let entry = forms.get(ask.askId);
            if (!entry && ask.status === 'pending') {
                try {
                    entry = formFor(ask, current);
                    forms.set(ask.askId, entry);
                    host.append(entry.form);
                }
                catch (error) {
                    const refusal = node('p');
                    refusal.textContent = jobWindowRefusal(error, 'JOB_ASK_INVALID');
                    host.append(refusal);
                }
            }
            if (entry)
                entry.fieldset.disabled = ask.status !== 'pending' || state.preparing || state.closed || !state.receipt || !access.capability;
        }
    }
    function build(prepared: JobPreparedInspection): HTMLElement {
        const root = node('div');
        root.className = 'job-inspection';
        const sidebar = node('section');
        sidebar.className = 'job-sidebar';
        const identity = node('p');
        identity.className = 'job-source';
        identity.textContent = prepared.display.publication.label + '\n' + prepared.display.publication.source.sourceHash;
        sidebar.append(identity);
        const binding = node('details');
        const bindingTitle = node('summary', 'job.binding');
        const sourceBinding = node('pre');
        sourceBinding.className = 'job-source';
        sourceBinding.textContent = JSON.stringify(prepared.display.publication.source, null, 2);
        binding.append(bindingTitle, sourceBinding);
        sidebar.append(binding);
        const parts = node('select');
        parts.id = 'job-part';
        parts.disabled = !prepared.metadata.manifest.model || prepared.metadata.feedbackCatalog.slots === null;
        const whole = node('option', 'job.wholeRig');
        whole.value = '';
        parts.append(whole);
        for (const slot of prepared.metadata.feedbackCatalog.slots ?? []) {
            const option = node('option');
            option.value = slot;
            option.textContent = slot;
            parts.append(option);
        }
        parts.onchange = () => { selectedPart = parts.value; selectPart(); };
        sidebar.append(inputLabel('Parts', parts));
        const solo = node('input');
        solo.type = 'checkbox';
        solo.id = 'job-solo';
        solo.onchange = () => { partMode = solo.checked ? 'solo' : 'context'; selectPart(); };
        sidebar.append(inputLabel('Solo', solo));
        const observation = node('pre');
        observation.id = 'job-part-observation';
        observation.className = 'job-source';
        sidebar.append(observation);
        const referenceSelect = node('select');
        referenceSelect.id = 'job-reference';
        for (const reference of prepared.references) {
            const option = node('option');
            option.value = reference.id;
            option.textContent = reference.label;
            referenceSelect.append(option);
        }
        referenceSelect.onchange = () => {
            const next = prepared.references.find(item => item.id === referenceSelect.value);
            if (current === prepared && next) void referenceSelection.select(next);
        };
        sidebar.append(inputLabel('Reference', referenceSelect));
        const images = node('div');
        images.className = 'job-part-images';
        for (const [name, image] of prepared.partImages) {
            const label = node('label');
            const title = node('span');
            title.textContent = name;
            label.append(title, image);
            images.append(label);
        }
        sidebar.append(images);
        const stage = node('section');
        stage.className = 'job-stage';
        const controls = node('div');
        controls.className = 'viewbar';
        for (const [id, key] of [['zoom-in', 'job.zoomIn'], ['zoom-out', 'job.zoomOut'], ['fit', 'Fit']]) {
            const button = node('button', key);
            button.id = id!;
            button.type = 'button';
            controls.append(button);
        }
        const sync = node('input');
        sync.id = 'camera-sync';
        sync.type = 'checkbox';
        controls.append(inputLabel('job.cameraSync', sync));
        const zoom = node('span');
        zoom.id = 'zoom-value';
        controls.append(zoom);
        const pair = node('div');
        pair.id = 'stage-layout';
        mountViewportPair(pair);
        for (const id of ['rig-overlay', 'idle-handles', 'rig-fields-stage'])
            pair.querySelector('#' + id)?.remove();
        for (const [id, key] of [['reference-label', 'Reference'], ['rig-label', 'Generated rig · read only'],
            ['reference-empty', 'No reference supplied.'], ['rig-empty', 'No compiled model supplied.']]) {
            const label = pair.querySelector<HTMLElement>('#' + id);
            if (label) {
                label.dataset.jobText = key;
                label.textContent = t(key!);
            }
        }
        pair.querySelector('#reference-pane')?.setAttribute('aria-label', t('Reference'));
        pair.querySelector('#rig-pane')?.setAttribute('aria-label', t('Rig'));
        pair.querySelector('#rig-root')!.replaceWith(prepared.rigRoot);
        const transport = node('div');
        transport.className = 'job-transport';
        const clips = node('select');
        clips.id = 'job-animation';
        const setup = node('option', 'Setup');
        setup.value = '';
        clips.append(setup);
        for (const clip of prepared.assets?.animations ?? []) {
            const option = node('option');
            option.value = clip.name;
            option.textContent = clip.name;
            clips.append(option);
        }
        clips.onchange = () => { stopPlayback(); animation = clips.value; time = 0; pose(); };
        const playButton = node('button', 'Play');
        playButton.id = 'job-play';
        playButton.type = 'button';
        playButton.setAttribute('aria-pressed', 'false');
        playButton.disabled = true;
        playButton.onclick = () => {
            const clip = current?.assets?.animations.find(item => item.name === animation);
            if (!current?.player || !animation || !clip || !(clip.duration > 0)) {
                stopPlayback();
                return;
            }
            if (playing) {
                stopPlayback();
                presentCurrentFrame(current);
                return;
            }
            if (current.player.composed) current.setupPose(false);
            if (!loop && time >= clip.duration) {
                time = 0;
                current.player.play(animation, { loop });
            } else if (current.player.current !== animation) {
                current.player.play(animation, { loop });
                if (time > 0) current.player.seek(time);
            } else {
                current.player.resume();
            }
            playing = true;
            playbackCarry = 0;
            lastFrameTime = 0;
            const clockInput = workspace.querySelector<HTMLInputElement>('#job-time');
            if (clockInput) clockInput.value = String(time);
            syncTransportControls();
            presentCurrentFrame(current);
            if (hubVisible) armPlayback(current, current.player);
        };
        const loopInput = node('input');
        loopInput.id = 'job-loop';
        loopInput.type = 'checkbox';
        loopInput.checked = loop;
        loopInput.onchange = () => {
            loop = loopInput.checked;
            playbackCarry = 0;
            lastFrameTime = 0;
            const clip = current?.assets?.animations.find(item => item.name === animation);
            if (current?.player && animation && clip) {
                if (current.player.composed) current.setupPose(false);
                current.player.play(animation, { loop });
                if (time > 0) current.player.seek(time);
                const activeEntry = current.player.entry(0);
                if (!activeEntry || activeEntry.animation !== animation || activeEntry.loop !== loop ||
                    !Number.isFinite(activeEntry.animationTime) || activeEntry.animationTime < 0 ||
                    activeEntry.animationTime > activeEntry.duration) {
                    stopPlayback(current.player);
                    return;
                }
                time = activeEntry.animationTime;
                const clockInput = workspace.querySelector<HTMLInputElement>('#job-time');
                if (clockInput) clockInput.value = String(time);
                if (!playing) current.player.pause();
                syncTransportControls();
                presentCurrentFrame(current);
                if (playing && hubVisible) armPlayback(current, current.player);
            } else {
                syncTransportControls();
            }
        };
        const clock = node('input');
        clock.id = 'job-time';
        clock.type = 'number';
        clock.min = '0';
        clock.step = '0.001';
        clock.oninput = () => {
            if (!playing) return;
            stopPlayback();
            if (current) presentCurrentFrame(current);
        };
        clock.onchange = () => {
            const value = Number(clock.value);
            const duration = current?.assets?.animations.find(clip => clip.name === animation)?.duration;
            if (!Number.isFinite(value) || value < 0 || duration !== undefined && value > duration) {
                clock.value = String(time);
                notice.textContent = t('KEY_TIME_OUT_OF_DOMAIN');
                return;
            }
            stopPlayback();
            time = value;
            pose();
        };
        const panels = selectValues(['1', '2', '3', '4'], ['1 Parts + mesh', '2 Interview', '3 Rig + animation', '4 Direction']);
        panels.id = 'job-panel';
        panels.onchange = () => { panel = panels.value; showPanel(); };
        transport.append(clips, playButton, inputLabel('Repeat', loopInput), inputLabel('job.time', clock), panels);
        const numeric = node('pre');
        numeric.id = 'view-coordinates';
        numeric.hidden = true;
        const coordinates = node('span');
        coordinates.id = 'coordinates';
        coordinates.hidden = true;
        stage.append(controls, pair, transport, numeric, coordinates);
        const source = prepared.display.publication.source;
        if (source.subject === 'image-set') {
            const heading = node('h2', 'job.imageSetTitle');
            const digest = node('p');
            digest.className = 'job-source';
            digest.style.overflowWrap = 'anywhere';
            const digestLabel = node('span', 'job.imageSetDigest');
            const digestValue = node('code');
            digestValue.textContent = source.imageSetDigest;
            digest.append(digestLabel, document.createTextNode(' '), digestValue);
            const gallery = node('section');
            gallery.dataset.jobImageSet = '';
            gallery.style.display = 'grid';
            gallery.style.gridAutoFlow = 'column';
            gallery.style.gridAutoColumns = 'minmax(180px, 1fr)';
            gallery.style.gap = '16px';
            gallery.style.overflow = 'auto';
            gallery.style.minHeight = '0';
            gallery.style.flex = '1';
            for (const [index, image] of source.imageSet.images.entries()) {
                const element = prepared.imageSetImages?.[index];
                if (!element) throw new Error('JOB_VISUAL_UNAVAILABLE');
                const figure = node('figure');
                figure.style.margin = '0';
                figure.style.minWidth = '0';
                figure.dataset.imageName = image.name;
                const name = node('h3');
                name.textContent = image.name;
                name.style.overflowWrap = 'anywhere';
                const role = node('p', 'job.imageRole.' + image.role);
                const hash = node('code');
                hash.className = 'job-source';
                hash.style.display = 'block';
                hash.style.overflowWrap = 'anywhere';
                hash.textContent = image.sha256;
                element.style.width = '100%';
                element.style.height = 'auto';
                element.style.maxHeight = '70vh';
                element.style.objectFit = 'contain';
                figure.append(name, role, element, hash);
                if (source.duplicateHashes.some(group => group.names.includes(image.name)))
                    figure.append(node('p', 'job.identicalImages'));
                gallery.append(figure);
            }
            stage.prepend(heading, digest, gallery);
            controls.hidden = pair.hidden = transport.hidden = true;
            controls.style.display = pair.style.display = transport.style.display = 'none';
            for (const child of sidebar.children) {
                if (child instanceof HTMLElement && child !== identity && child !== binding) child.hidden = true;
            }
        }
        const formsHost = node('section');
        formsHost.className = 'job-forms';
        formsHost.dataset.jobForms = '';
        const heading = node('h2', 'job.pending');
        formsHost.append(heading);
        const direction = node('pre');
        direction.className = 'job-direction';
        direction.dataset.jobDirection = '';
        if (prepared.metadata.direction)
            direction.textContent = t('job.metadata') + '\n' + JSON.stringify(prepared.metadata.direction, null, 2);
        const history = node('div');
        history.className = 'job-history';
        history.dataset.jobHistory = '';
        formsHost.append(direction, history);
        root.append(sidebar, stage, formsHost);
        return root;
    }
    function selectPart(): void {
        if (!current?.inspection)
            return;
        drawn.delete(current);
        current.rigPresentation = undefined;
        current.inspection.select(selectedPart ? { side: 'single', slot: selectedPart, mode: partMode } : null);
        rememberDraw();
        setText('job-part-observation', selectedPart ? JSON.stringify(current.inspection.observation(), null, 2) : '');
        viewport.renderCameraControls();
    }
    function showReference(): void {
        const value = reference();
        el('reference-content').replaceChildren(...(value ? [value.element] : []));
        el('reference-empty').hidden = !!value;
    }
    function showPanel(): void {
        const direction = workspace.querySelector<HTMLElement>('[data-job-direction]');
        if (direction)
            direction.hidden = panel !== '4';
        for (const [askId, entry] of forms) {
            const ask = window.state().pending.find(item => item.askId === askId);
            entry.form.hidden = current?.display.publication.source.subject !== 'image-set' &&
                panel === '2' && ask?.subject.kind !== 'interview-picks';
        }
    }
    function pose(seekReference = true): void {
        if (!current)
            return;
        const clip = current.assets?.animations.find(item => item.name === animation);
        const clock = el<HTMLInputElement>('job-time');
        clock.value = String(time);
        if (animation && (!clip || time > clip.duration)) {
            notice.textContent = t('KEY_TIME_OUT_OF_DOMAIN');
            return;
        }
        if (!animation && current.player?.current) current.setupPose();
        // Setup uses an empty composed track. Animation seek needs a fresh single track.
        if (animation && current.player?.composed) current.setupPose(false);
        if (current.player) {
            drawn.delete(current);
            current.rigPresentation = undefined;
            if (animation && (current.player.current !== animation || current.player.entry(0)?.loop !== loop))
                current.player.play(animation, { loop });
            if (animation) {
                current.player.seek(time);
                const activeEntry = current.player.entry(0);
                if (!activeEntry || activeEntry.animation !== animation || activeEntry.loop !== loop ||
                    !Number.isFinite(activeEntry.animationTime) || activeEntry.animationTime < 0 ||
                    activeEntry.animationTime > activeEntry.duration) {
                    current.player.pause();
                    notice.textContent = t('JOB_VISUAL_UNAVAILABLE');
                    return;
                }
                time = activeEntry.animationTime;
                clock.value = String(time);
            }
            current.player.pause();
            drawInspection(current);
            current.inspection?.select(selectedPart ? { side: 'single', slot: selectedPart, mode: partMode } : null);
            setText('job-part-observation', selectedPart ? JSON.stringify(current.inspection?.observation(), null, 2) : '');
        }
        syncTransportControls();
        if (seekReference) {
            const value = reference();
            const owner = current;
            const at = time;
            void value?.seek(at, abort.signal).catch(error => {
                if (current === owner && reference() === value && time === at)
                    notice.textContent = jobWindowRefusal(error, 'JOB_VISUAL_UNAVAILABLE');
            });
        }
        viewport.fitCamera();
    }
    function hubBinding(): JobHubBinding {
        return {incarnation: hubIncarnation!, jobId: access.jobId,
            publicationId: current?.display.publication.publicationId ?? null,
            sourceHash: current?.display.publication.source.sourceHash ?? null};
    }
    function pauseHiddenHubFrame(): void {
        if (hubVisible) return;
        stopPlayback();
        for (const video of workspace.querySelectorAll('video')) video.pause();
    }
    function announceHubFrame(): void {
        if (hubIncarnation) globalThis.parent.postMessage({...hubBinding(), schema: JOB_HUB_READY}, location.origin);
    }
    const window = createJobWindow({ jobId: access.jobId, pageId, transport, adapter: {
            async prepare(display, signal): Promise<PreparedWindow> {
                const inspection = await prepareJobInspection(display, signal);
                try {
                    const element = build(inspection);
                    const preparedForms = prepareJobForms(display, window.state().pending, ask => formFor(ask, inspection));
                    return Object.assign(inspection, { element, forms: preparedForms });
                }
                catch (error) {
                    inspection.dispose();
                    throw error;
                }
            },
            captureDraft() { saveDraft(); const dirty = [...forms].filter(([, item]) => item.dirty); return dirty.length ? dirty.map(([askId, item]) => ({ askId, value: item.read() })) : null; },
            commit(prepared, display) {
                // Pending asks can arrive while assets load. Finish their forms before the visible replacement.
                const nextForms = prepareJobForms(display, window.state().pending,
                    ask => prepared.forms.get(ask.askId) ?? formFor(ask, prepared));
                const root = prepared.element;
                const formHost = root.querySelector<HTMLElement>('[data-job-forms]');
                if (!formHost) throw new Error('JOB_WINDOW_ELEMENT_MISSING');
                for (const entry of nextForms.values()) formHost.append(entry.form);
                referenceSelection.cancel();
                const previous = current;
                stopPlayback(previous?.player);
                const previousElement = currentElement;
                const previousForms = new Map(forms);
                const navigation = { animation, time, selectedPart, partMode, selectedReference, panel,
                    partIdentity: current?.inspection?.value(), camera: structuredClone(viewportState) };
                compatibilityNotice = false;
                if (animation && !prepared.assets?.animations.some(item => item.name === animation && time <= item.duration)) {
                    animation = '';
                    time = 0;
                    compatibilityNotice = true;
                }
                if (selectedPart && !(prepared.metadata.feedbackCatalog.slots ?? []).includes(selectedPart)) {
                    selectedPart = '';
                    compatibilityNotice = true;
                }
                if (!prepared.references.some(item => item.id === selectedReference))
                    selectedReference = prepared.references[0]?.id ?? '';
                let nextUnbind: (() => void) | null = null;
                let nextResize: ResizeObserver | null = null;
                const rollback = () => {
                    stopPlayback(prepared.player);
                    nextUnbind?.();
                    nextResize?.disconnect();
                    current = previous;
                    currentElement = previousElement;
                    animation = navigation.animation;
                    time = navigation.time;
                    selectedPart = navigation.selectedPart;
                    partMode = navigation.partMode;
                    selectedReference = navigation.selectedReference;
                    panel = navigation.panel;
                    forms.clear();
                    for (const [id, item] of previousForms)
                        forms.set(id, item);
                    workspace.replaceChildren(...(previousElement ? [previousElement] : []));
                    Object.assign(viewportState, navigation.camera);
                    if (current) {
                        el<HTMLSelectElement>('job-reference').value = selectedReference;
                        syncTransportControls();
                        viewport.fitCamera();
                    }
                };
                try {
                    current = prepared;
                    currentElement = root;
                    forms.clear();
                    for (const [id, entry] of nextForms) forms.set(id, entry);
                    workspace.replaceChildren(root);
                    el<HTMLSelectElement>('job-part').value = selectedPart;
                    el<HTMLInputElement>('job-solo').checked = partMode === 'solo';
                    el<HTMLSelectElement>('job-reference').value = selectedReference;
                    el<HTMLSelectElement>('job-animation').value = animation;
                    el<HTMLSelectElement>('job-panel').value = panel;
                    el('rig-empty').hidden = !!prepared.player;
                    Object.assign(viewportState, navigation.camera, { cameraRestoring: true });
                    showReference();
                    pose(false);
                    if (selectedPart) {
                        try {
                            prepared.inspection?.assertIdentity(navigation.partIdentity);
                        }
                        catch {
                            selectedPart = '';
                            compatibilityNotice = true;
                            el<HTMLSelectElement>('job-part').value = '';
                        }
                    }
                    selectPart();
                    viewportState.cameraRestoring = false;
                    updateForms(window.state());
                    showPanel();
                    viewport.bindControls();
                    nextUnbind = viewport.bindNavigation();
                    nextResize = viewport.observeResize();
                    return {
                        rollback,
                        finalize() {
                            unbindNavigation?.();
                            resize?.disconnect();
                            unbindNavigation = nextUnbind;
                            resize = nextResize;
                            previous?.dispose();
                            title.textContent = display.publication.source.package.id;
                        },
                    };
                }
                catch (error) {
                    rollback();
                    throw error;
                }
            },
            async painted(prepared, signal) {
                for (const image of prepared.imageSetImages ?? []) {
                    if (!image.isConnected || !image.complete || !image.naturalWidth || !image.naturalHeight)
                        throw new Error('JOB_VISUAL_UNAVAILABLE');
                }
                await reference()?.seek(time, signal);
                if (prepared.player) {
                    drawInspection(prepared);
                    rememberDraw();
                }
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                if (signal.aborted)
                    throw new Error('JOB_PRELOAD_CANCELLED');
            },
            discard(prepared) { prepared.dispose(); },
            changed(state) {
                notice.dataset.failed = String(!!state.error);
                if (state.error)
                    notice.textContent = state.displayed && state.error !== 'JOB_WINDOW_CLEANUP_FAILED'
                        ? t('job.failed') + ' · ' + jobWindowRefusal(state.error) : jobWindowRefusal(state.error);
                else if (state.closed)
                    notice.textContent = t('job.closed');
                else if (state.preparing)
                    notice.textContent = t('job.preparing');
                else if (state.displayed)
                    notice.textContent = state.previousLabel
                        ? t('job.updated', [state.previousLabel, state.displayed.publication.label]) : state.displayed.publication.label;
                if (compatibilityNotice)
                    notice.textContent += ' · ' + t('job.incompatible');
                if (state.closed) {
                    const wasPlaying = playing;
                    stopPlayback();
                    if (wasPlaying && current) presentCurrentFrame(current);
                }
                updateForms(state);
                if (current)
                    showPanel();
                const history = workspace.querySelector<HTMLElement>('[data-job-history]');
                if (history) {
                    const retained = new Map(state.retainedDrafts.map(draft => [draft.publicationId, draft]));
                    try {
                        const prefix = 'rig-review-job-draft/1:' + access.jobId + ':';
                        for (let index = 0; index < localStorage.length; index++) {
                            const key = localStorage.key(index);
                            if (!key?.startsWith(prefix))
                                continue;
                            const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
                            if (!saved?.forms?.length || saved.publicationId === state.displayed?.publication.publicationId)
                                continue;
                            if (typeof saved.publicationId !== 'string' || typeof saved.sourceHash !== 'string' || typeof saved.label !== 'string')
                                continue;
                            retained.set(saved.publicationId, { publicationId: saved.publicationId, sourceHash: saved.sourceHash,
                                source: saved.source, label: saved.label, value: saved.forms });
                        }
                    }
                    catch { /* In-memory retained evidence remains available. */ }
                    history.textContent = [...retained.values()].map(draft => t('job.retained', [draft.label]) + '\n' + draft.sourceHash + '\n' + JSON.stringify(draft.value, null, 2)).join('\n');
                }
                pauseHiddenHubFrame(); announceHubFrame();
                if (state.receipt && !state.preparing) events?.displayed();
            },
        } });
    const localize = i18n.onLanguageChange(() => {
        for (const element of host.querySelectorAll<HTMLElement>('[data-job-text]'))
            element.textContent = t(element.dataset.jobText!);
        languages.setAttribute('aria-label', t('interview.language'));
        if (current)
            viewport.renderCameraControls();
        window.refresh();
    });
    const hubVisibility = (event: MessageEvent) => {
        if (!hubIncarnation || !jobHubMessageMatches(event, location.origin, globalThis.parent, hubBinding(), 'visibility')) return;
        hubVisible = event.data.visible;
        host.dataset.hubVisible = String(hubVisible);
        events?.visibility(hubVisible);
        if (event.data.language !== i18n.getLanguage()) {
            i18n.setLinkLanguage(null); i18n.setLanguagePreference(event.data.language);
        }
        pauseHiddenHubFrame();
        if (current && !hubVisible) {
            drawn.delete(current);
            current.rigPresentation = undefined;
        }
        if (hubVisible && current?.player) {drawInspection(current); rememberDraw();}
    };
    if (hubIncarnation) {globalThis.addEventListener('message', hubVisibility); announceHubFrame();}
    events = startJobWindowEvents({access, signal: abort.signal, member: !!hubIncarnation,
        event: event => window.event(event),
        refused: error => {notice.textContent = jobWindowRefusal(error, 'JOB_STREAM_FAILED');},
    });
    let resolution: MediaQueryList | undefined;
    const resolutionChanged = () => {
        resolution?.removeEventListener('change', resolutionChanged);
        resolution = globalThis.matchMedia(`(resolution:${globalThis.devicePixelRatio || 1}dppx)`);
        resolution.addEventListener('change', resolutionChanged);
        if (current) {
            drawn.delete(current);
            current.rigPresentation = undefined;
            viewport.fitCamera();
        }
    };
    resolutionChanged();
    const stop = () => {
        stopPlayback();
        resolution?.removeEventListener('change', resolutionChanged);
        globalThis.removeEventListener('message', hubVisibility);
        saveDraft();
        referenceSelection.cancel();
        abort.abort();
        window.stop();
        localize();
        unbindNavigation?.();
        resize?.disconnect();
        current?.dispose();
    };
    globalThis.addEventListener('pagehide', stop, { once: true });
    return () => { globalThis.removeEventListener('pagehide', stop); stop(); };
}
if (typeof document !== 'undefined' && document.body?.hasAttribute('data-job-window')) {
    void mountJobSession(document.body).catch(error => {
        const status = document.createElement('p');
        status.setAttribute('role', 'alert');
        status.textContent = jobWindowRefusal(error);
        document.body.append(status);
    });
}
