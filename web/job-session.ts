/** Live job window transactions. Every form remains bound to its displayed publication. */
import type {
    ActV3,
    DisplayPublicationV3,
    EventV3,
    JobDisplayReceipt,
    JobCheckpointEvidence,
    JobCheckpointTable,
    JobInterviewDiagnostics,
    JobResult,
    PendingAskV3,
    JobPanelComposition,
    PanelComponent,
    PanelSlot,
    PartsVerdictValue,
    PublicationV3,
    RecordSource,
    SourceV3,
    UISubmissionV3,
} from '../src/job-contract.ts';
import {enCatalog} from './catalog-en.ts';
import {koCatalog} from './catalog-ko.ts';
import {t,onLanguageChange} from './i18n.ts';
import type {InstanceAccess} from './instance-access.ts';
import {JOB_PLAN_TEXT_FIELDS, parseJobPlanTextProjection, type JobPlanTextProjection} from '../src/job-contract.ts';
import {createJobRigScreen, type JobRigScreenPrepared} from './job-rig-screen.ts';
import type {JobRigPresentation} from './viewport-capture.ts';
import {labelledControl} from './view-controls.ts';
import {createInterviewForm,interviewPicksRecord,interviewRecords,interviewErrors,type InterviewDisplayQuestion} from './interview-panel.ts';
import {JOB_COMMENTS_ACT_SCHEMA, JOB_PANEL_COMPOSITION_SCHEMA, JOB_PARTS_VERDICT_ACT_SCHEMA, parsePanelComposition} from '../src/job-contract.ts';
import type {PartsIssue} from '../src/parts-comment.ts';

/** Imported runtimes may throw arbitrary prose. Only registered refusal copy reaches the window. */
export function jobWindowRefusal(error: unknown, fallback = 'JOB_WINDOW_FAILED'): string {
    const message = error instanceof Error ? error.message : error;
    if (typeof message === 'string' &&
        Object.hasOwn(enCatalog, message) && Object.hasOwn(koCatalog, message)) {
        return t(message);
    }
    return t(fallback);
}
/** Submission copy and its diagnostic title share the existing catalog refusal registry. */
export function jobSubmissionRefusal(error: unknown): {code: string; text: string; title: string} {
    const message = error instanceof Error ? error.message : error;
    const code = typeof message === 'string' && /^JOB_[A-Z_]+$/.test(message) ? message : 'JOB_ACT_INVALID';
    const key = 'job.submit.' + code;
    const reason = Object.hasOwn(enCatalog, key) && Object.hasOwn(koCatalog, key) ? key : 'job.submit.refused';
    const origin = error instanceof Error && typeof error.cause === 'string' ? error.cause : 'client: submission';
    const title = code + ' · ' + origin;
    if (code === 'JOB_BODY_LIMIT' || reason === 'job.submit.refused') console.warn(title);
    return {code, title, text: t('Review was not submitted: {0}', [t(reason)])};
}
export interface JobWindowTransport {
    readPublication(publicationId: string, signal?: AbortSignal): Promise<JobResult<DisplayPublicationV3>>;
    acknowledge(input: {
        publicationId: string;
        pageId: string;
        sourceHash: string;
    }, signal: AbortSignal): Promise<JobResult<JobDisplayReceipt>>;
    submit(input: UISubmissionV3): Promise<JobResult<ActV3>>;
}
export interface JobPreparedCommit {
    /** Restore the previous view, including its original forms and route bindings. */
    rollback(): void | Promise<void>;
    /** Dispose the old view only after the new displayed nonce is acknowledged. */
    finalize(): void;
}
export interface JobWindowAdapter<Prepared> {
    /** Resolve assets, metadata, forms and publication-pinned routes before returning. */
    prepare(display: DisplayPublicationV3, signal: AbortSignal): Promise<Prepared>;
    /** Called immediately before commit, so edits made during preloading are retained. */
    captureDraft(): unknown | null;
    commit(prepared: Prepared, display: DisplayPublicationV3): JobPreparedCommit;
    painted(prepared: Prepared, signal: AbortSignal): Promise<void>;
    discard(prepared: Prepared): void;
    changed(state: JobWindowState): void;
}
export interface JobRetainedDraft {
    readonly publicationId: string;
    readonly sourceHash: string;
    readonly source?: SourceV3;
    readonly label: string;
    readonly value: unknown;
}
export type JobWindowAsk = PendingAskV3 & {readonly act?: ActV3};
export interface JobWindowState {
    readonly generation: number;
    readonly displayed: DisplayPublicationV3 | null;
    readonly receipt: JobDisplayReceipt | null;
    readonly preparing: boolean;
    readonly closed: boolean;
    readonly error: string | null;
    readonly errorOrigin?: string;
    readonly previousLabel: string | null;
    readonly pending: readonly JobWindowAsk[];
    readonly retainedDrafts: readonly JobRetainedDraft[];
}
function unwrap<Value>(result: JobResult<Value>): Value {
    if (!result.ok)
        throw new Error(result.error.code, {cause: (result.error as {cause?: unknown}).cause});
    return result.value;
}
function isRecordSource(source: SourceV3): source is RecordSource {
    return source.subject === 'option-set' || source.subject === 'plan';
}
function sourceSnapshot(source: unknown): string {
    return JSON.stringify(source, (_key, value: unknown) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value))
            return value;
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    });
}
function assertJobAskSource(ask: PendingAskV3, display: DisplayPublicationV3): void {
    const source: SourceV3 = ask.subject.kind === 'interview-picks' &&
        !isRecordSource(display.publication.source) && !isRecordSource(ask.source)
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
    display: DisplayPublicationV3,
    asks: readonly PendingAskV3[],
    prepare: (ask: PendingAskV3) => Form,
): Map<string, Form> {
    const prepared = new Map<string, Form>();
    for (const ask of asks) {
        if (ask.publicationId !== display.publication.publicationId || ask.status !== 'pending') continue;
        assertJobAskSource(ask, display);
        prepared.set(ask.askId, prepare(ask));
    }
    return prepared;
}

/** Association checks for normal daemon-authoritative plan text metadata. */
export function jobPlanTextForSource(value: unknown, source: SourceV3): JobPlanTextProjection | undefined {
    if (value === undefined) return undefined;
    const projection = parseJobPlanTextProjection(value);
    const mismatch = () => {throw new Error('PLAN_TEXT_SOURCE_MISMATCH');};
    if (!source.plan) return mismatch();
    if (projection.record && (projection.record.sha256 !== source.projectHash ||
        isRecordSource(source) && (source.record.path !== projection.record.path ||
            source.record.sha256 !== projection.record.sha256 ||
            !source.files.some(file => file.path === projection.record!.path && file.sha256 === projection.record!.sha256))))
        return mismatch();
    if (projection.status === 'projected' && (projection.steps.length !== source.plan.steps.length ||
        projection.steps.some((row, index) => row.id !== source.plan!.steps[index]?.id || row.hash !== source.plan!.steps[index]?.hash)))
        return mismatch();
    return projection;
}

/** C2 publishes the plan mapping in the ask. Legacy checkpoint metadata is optional guidance. */
export function jobCheckpointContext(
    ask: PendingAskV3,
    checkpoints: readonly Pick<Checkpoint, 'id' | 'title' | 'note'>[],
) {
    if (ask.subject.kind !== 'checkpoint') throw new Error('JOB_ASK_INVALID');
    const checkpointId = ask.subject.checkpointId;
    const planStepId = ('planStepId' in ask.subject ? ask.subject.planStepId : undefined) ?? checkpointId;
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
    previousDisplayed?: {
        readonly publicationId: string;
        readonly label: string;
        readonly previousLabel: string | null;
    } | null;
    initialRetainedDrafts?: readonly JobRetainedDraft[];
}) {
    const { transport, adapter, pageId } = options;
    const pending = new Map<string, JobWindowAsk>();
    const rigAttempts = new WeakSet<UISubmissionV3>();
    const retainedDrafts: JobRetainedDraft[] = [];
    let initialDrafts: readonly JobRetainedDraft[] | null = options.initialRetainedDrafts
        ? [...options.initialRetainedDrafts] : null;
    let generation = 0;
    let displayed: DisplayPublicationV3 | null = null;
    let receipt: JobDisplayReceipt | null = null;
    let preparing = false;
    let closed = false;
    let error: string | null;
    let errorOrigin: string | undefined;
    error = null;
    let previousLabel: string | null = null;
    let intent = 0;
    let stopped = false;
    let controller: AbortController | null = null;
    let queue = Promise.resolve();
    function state(): JobWindowState {
        return {
            generation, displayed, receipt, preparing, closed, error, previousLabel, ...(errorOrigin ? {errorOrigin} : {}),
            pending: [...pending.values()], retainedDrafts: [...retainedDrafts],
        };
    }
    function changed(): void { adapter.changed(state()); }
    function replace(publication: PublicationV3): Promise<void> {
        if (stopped)
            return Promise.resolve();
        const revision = ++intent;
        controller?.abort();
        const abort = new AbortController();
        controller = abort;
        preparing = true;
        error = null;
        errorOrigin = undefined;
        changed();
        queue = queue.then(async () => {
            if (revision !== intent || stopped)
                return;
            let prepared: Prepared | undefined;
            let committed: JobPreparedCommit | undefined;
            try {
                if (publication.visual.status !== 'available' && !isRecordSource(publication.source) &&
                    (publication.source.model||publication.source.parts))
                    throw new Error(publication.visual.code);
                const candidate = unwrap(await transport.readPublication(publication.publicationId, abort.signal));
                if (candidate.publication.publicationId !== publication.publicationId ||
                    candidate.publication.source.sourceHash !== publication.source.sourceHash ||
                    candidate.publication.instanceKey !== publication.instanceKey ||
                    candidate.publication.generation !== publication.generation ||
                    sourceSnapshot(candidate.publication.source) !== sourceSnapshot(publication.source) ||
                    (publication.interview !== undefined &&
                        sourceSnapshot(candidate.publication.interview) !== sourceSnapshot(publication.interview))) {
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
                if (initialDrafts) {
                    for (const item of initialDrafts) {
                        if (item.publicationId !== candidate.publication.publicationId &&
                            !retainedDrafts.some(existing => existing.publicationId === item.publicationId)) {
                            retainedDrafts.push(structuredClone(item));
                        }
                    }
                    initialDrafts = null;
                }
                for (let index = retainedDrafts.length - 1; index >= 0; index--) {
                    if (retainedDrafts[index]?.publicationId === candidate.publication.publicationId)
                        retainedDrafts.splice(index, 1);
                }
                if (displayed && draft !== null) {
                    const nextDraft: JobRetainedDraft = {
                        publicationId: displayed.publication.publicationId,
                        sourceHash: displayed.publication.source.sourceHash,
                        source: structuredClone(displayed.publication.source),
                        label: displayed.publication.label,
                        value: structuredClone(draft),
                    };
                    const existing = retainedDrafts.findIndex(item => item.publicationId === nextDraft.publicationId);
                    if (existing >= 0) retainedDrafts[existing] = nextDraft;
                    else retainedDrafts.push(nextDraft);
                }
                if (displayed) {
                    previousLabel = displayed.publication.label;
                }
                else if (options.previousDisplayed) {
                    previousLabel = options.previousDisplayed.publicationId === candidate.publication.publicationId
                        ? options.previousDisplayed.previousLabel
                        : options.previousDisplayed.label;
                }
                else {
                    previousLabel = null;
                }
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
                if (revision === intent && !stopped) {
                    error = failure instanceof Error ? failure.message : 'JOB_DISPLAY_MISMATCH';
                    errorOrigin = failure instanceof Error && typeof failure.cause === 'string' ? failure.cause : undefined;
                }
            }
            finally {
                await committed?.rollback();
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
    function event(value: EventV3): void {
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
            const previous = pending.get(value.ask.askId);
            pending.set(value.ask.askId, previous?.act ? {...value.ask, status: 'answered', act: previous.act} : value.ask);
        }
        else if (value.type === 'act') {
            const ask = pending.get(value.act.askId);
            if (ask)
                pending.set(ask.askId, { ...ask, status: 'answered', act: value.act });
        }
        else if (value.type === 'closed') {
            closed = true;
        }
        changed();
    }
    async function submit(input: UISubmissionV3): Promise<JobResult<ActV3>> {
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
        const result = await transport.submit(input);
        if (result.ok && ask) {
            pending.set(ask.askId, {...ask, status: 'answered', act: result.value});
            changed();
        }
        return result;
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
export function jobPublicationRoutes(display: DisplayPublicationV3, origin: string) {
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
        jobId: match[1]!,
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
        if (!value.ok) Object.defineProperty(value.error, 'cause', {value:
            `${init?.method ?? 'GET'} ${new URL(access.route(path), 'http://127.0.0.1').pathname} · ${typeof init?.body === 'string' ? new TextEncoder().encode(init.body).byteLength : 0} bytes · HTTP ${response.status}`});
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
export async function* jobWindowEvents(access: JobWindowAccess, after: string | null, signal: AbortSignal, fetcher: typeof fetch = fetch): AsyncGenerator<EventV3> {
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
                    throw new Error('JOB_BODY_LIMIT', {cause: 'client: event stream'});
                const event = JSON.parse(buffered.slice(0, newline)) as EventV3;
                if (!event || event.jobId !== access.jobId || typeof event.cursor !== 'string' ||
                    !Number.isSafeInteger(event.generation) || event.generation < 0 ||
                    !['published', 'pending', 'act', 'closed'].includes(event.type))
                    throw new Error('JOB_STREAM_FAILED');
                buffered = buffered.slice(newline + 1);
                const crops = new Map<string, {owner: Record<string, unknown>; key: string}[]>();
                const packed = event as EventV3 & {_jobCommentCrops?: [string[], string][]};
                for (const [path, sha256] of packed._jobCommentCrops ?? []) {
                    if (!Array.isArray(path) || !path.every(key => typeof key === 'string') || path.at(-1) !== 'png' ||
                        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('JOB_STREAM_FAILED');
                    let owner: any = event;
                    for (const key of path.slice(0, -1)) {
                        if (!owner || typeof owner !== 'object' || !Object.hasOwn(owner, key)) throw new Error('JOB_STREAM_FAILED');
                        owner = owner[key];
                    }
                    if (owner?.png !== 'job-crop:' + sha256 || owner.sha256 !== sha256 ||
                        owner.path !== `comment-crops/${sha256}.png`) throw new Error('JOB_STREAM_FAILED');
                    const reference = 'job-crop:' + sha256, refs = crops.get(reference) ?? [];
                    refs.push({owner, key: 'png'}); crops.set(reference, refs);
                }
                delete packed._jobCommentCrops;
                for (const [reference, refs] of crops) {
                    try {
                        const crop = await fetcher(access.route('comment-crops/' + reference.slice(9) + '.png'),
                            {signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]), headers: access.headers()});
                        if (!crop.ok) throw new Error('JOB_STREAM_FAILED');
                        const bytes = new Uint8Array(await crop.arrayBuffer());
                        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
                            byte => byte.toString(16).padStart(2, '0')).join('');
                        if (digest !== reference.slice(9)) throw new Error('JOB_STREAM_FAILED');
                        let binary = '';
                        for (const byte of bytes) binary += String.fromCharCode(byte);
                        for (const ref of refs) ref.owner[ref.key] = 'data:image/png;base64,' + btoa(binary);
                    } catch {
                        if (signal.aborted) return;
                        // A missing image is local presentation state, never a reason to replay an immutable act forever.
                        for (const ref of refs) {
                            ref.owner[ref.key] = null;
                            ref.owner.unavailable = 'COMMENT_CROP_STATE_UNAVAILABLE: stored crop cannot be read';
                        }
                    }
                }
                yield event;
                newline = buffered.indexOf('\n');
            }
            if (buffered.length > limit)
                throw new Error('JOB_BODY_LIMIT', {cause: 'client: event stream'});
        }
    }
    finally {
        void reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/** One persistent reader per window, resumed from the last delivered cursor. */
export function startJobWindowEvents(options: {
    access: JobWindowAccess;
    signal: AbortSignal;
    event(value: EventV3): void;
    refused(error: unknown): void;
    fetcher?: typeof fetch;
}) {
    let cursor: string | null = null;
    let reader: AbortController | null = null;
    let wake: (() => void) | null = null;
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
                if (!options.signal.aborted && !current.signal.aborted) await wait(500);
            }
        } finally { options.signal.removeEventListener('abort', stopped); }
    })();
    return {
        done,
    };
}
import type { ModelAssets, RigPlayer } from '@rig-c/play';
import type { PartInspection } from './part-selection.ts';
import type { Checkpoint, ReviewManifest, ReviewedSource } from '../src/manifest.ts';
import type { DirectionInspection } from '../src/direction-inspection.ts';
import type { FeedbackCatalog } from '../src/feedback-validation.ts';
import type { InterviewQuestion } from '../src/interview-project.ts';
type JobCheckpointEvidenceMetadata = Omit<JobCheckpointEvidence, 'tiles' | 'table'> & {
    tiles: readonly (JobCheckpointEvidence['tiles'][number] & {url: string})[];
    table: JobCheckpointEvidence['table'] & JobCheckpointTable & {url: string};
};
export interface JobInspectionMetadata {
    checkpointEvidence?: readonly JobCheckpointEvidenceMetadata[];
    planText?: JobPlanTextProjection;
    manifest: ReviewManifest;
    recordSource?: undefined;
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
    feedbackCatalog: Pick<FeedbackCatalog, 'slots'> & Partial<Pick<FeedbackCatalog, 'bones'>>;
}
export interface JobRecordInspectionMetadata {
    checkpointEvidence?: readonly JobCheckpointEvidenceMetadata[];
    planText?: JobPlanTextProjection;
    manifest?: undefined;
    recordSource: RecordSource;
    sourceHash: string;
    reviewedSource?: undefined;
    setsHash?: undefined;
    initialAnimation?: null;
    direction?: undefined;
    referenceHashes?: undefined;
    sourcePainting?: undefined;
    capabilities: {
        interview?: boolean;
        preRig?: boolean;
        playback: boolean;
    };
    feedbackCatalog: Pick<FeedbackCatalog, 'slots'> & Partial<Pick<FeedbackCatalog, 'bones'>>;
}
export type JobInspectionMetadataV3 = JobInspectionMetadata | JobRecordInspectionMetadata;
type JobInterview = {
    questions: (Omit<InterviewQuestion, 'images'> & {
        images: {
            name: string;
            url: string;
        }[];
    })[];
    interview?: JobInterviewDiagnostics | null;
};
type JobPartsInventory = import('./parts-viewport-provider.ts').PartsSubjectData;
interface JobReferenceView {
    id: string;
    label: string;
    element: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement;
    width: number;
    height: number;
    seek(time: number, signal: AbortSignal): Promise<void>;
}

/** Read composition at the host boundary. Unknown IDs remain local to their slot. */
export function resolveJobPanels(metadata: JobInspectionMetadataV3, source: SourceV3) {
    const parts: JobPanelComposition = {schema: JOB_PANEL_COMPOSITION_SCHEMA, left: ['parts.list'],
        stage: ['parts.canvas'], toolbar: ['parts.layers'], side: ['parts.issues', 'act.submit']};
    const stage: PanelComponent = isRecordSource(source) ? source.subject === 'plan' ? 'plan.body' : 'interview.picks' :
        source.direction ? 'scene.composite' : 'rig.playback';
    const fallback: JobPanelComposition = metadata.capabilities.preRig ? parts :
        {schema: JOB_PANEL_COMPOSITION_SCHEMA, stage: [stage], side: ['act.submit']};
    const raw: unknown = metadata.manifest?.panels;
    if (raw === undefined) return {composition: fallback, invalid: false};
    try { return {composition: parsePanelComposition(raw), invalid: false}; }
    catch { return {composition: fallback, invalid: true}; }
}

/** Derived only from finalized asks, including cursor replay after reload. */
export function jobPartsReviewState(asks: readonly JobWindowAsk[], publicationId: string) {
    const bound = asks.filter(ask => ask.publicationId === publicationId);
    const verdict = bound.filter(ask => ask.subject.kind === 'parts-verdict').at(-1);
    const act = verdict?.act;
    if (act?.kind !== 'parts-verdict' || (act.schema !== JOB_PARTS_VERDICT_ACT_SCHEMA && act.schema !== JOB_COMMENTS_ACT_SCHEMA)) return 'reviewing';
    if (act.value.verdict === 'changes-requested') return 'sent';
    const approved = bound.some(ask => ask.subject.kind === 'signoff' && ask.subject.stage === 'parts-review' &&
        ask.act?.kind === 'signoff' && ask.act.value.decision === 'approved');
    return approved ? 'approved' : 'retry-signoff';
}

/** A declared painting identity takes precedence over manifest reference order. */
export function jobPartsPainting(prepared: Pick<JobPreparedInspection, 'metadata' | 'display' | 'references'>) {
    const declared = prepared.metadata.sourcePainting;
    if (declared) return prepared.references.find(reference => reference.id === declared.id) ?? null;
    const source = prepared.display.publication.source;
    if (isRecordSource(source)) return null;
    const painting = source.parts?.images.find(image => image.role === 'painting');
    return painting ? prepared.references.find(reference => reference.label === painting.role + ' ' + painting.path) ?? null : null;
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
    display: DisplayPublicationV3;
    metadata: JobInspectionMetadataV3;
    interview: JobInterview | null;
    parts: JobPartsInventory | null;
    partImages: Map<string, HTMLImageElement>;
    partPages?: Map<number, HTMLImageElement>;
    checkpointEvidence?: readonly {
        packet: JobCheckpointEvidence;
        table: JobCheckpointTable;
        images: readonly HTMLImageElement[];
    }[];
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
                throw new Error('JOB_BODY_LIMIT', {cause: 'client: preload'});
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
export function mediaReady(media: HTMLVideoElement, name: 'loadeddata' | 'seeked', signal: AbortSignal): Promise<void> {
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
/** Prepare off-stage; modal-only callers may skip workspace visuals, never checkpoint evidence. */
export async function prepareJobInspection(display: DisplayPublicationV3, signal: AbortSignal, formsOnly=false, preloadVisuals=true): Promise<JobPreparedInspection> {
    const routes = jobPublicationRoutes(display, location.origin);
    const metadata = await jobJson<JobInspectionMetadataV3>(routes.api('review'), signal);
    const publishedSource = display.publication.source;
    if (isRecordSource(publishedSource)) {
        if (!metadata.recordSource || metadata.manifest !== undefined || metadata.reviewedSource !== undefined ||
            metadata.sourceHash !== publishedSource.sourceHash ||
            sourceSnapshot(metadata.recordSource) !== sourceSnapshot(publishedSource)) {
            throw new Error('JOB_DISPLAY_MISMATCH');
        }
    }
    else if (!metadata.manifest || !metadata.reviewedSource ||
        metadata.manifest.id !== publishedSource.package.id ||
        metadata.manifest.revision !== publishedSource.package.revision ||
        (metadata.reviewedSource.rig?.sha256 ?? null) !== (publishedSource.model?.sha256 ?? null)) {
        throw new Error('JOB_DISPLAY_MISMATCH');
    }
    const objectUrls: string[] = [];
    const media: HTMLVideoElement[] = [];
    if (metadata.planText !== undefined) metadata.planText = jobPlanTextForSource(metadata.planText, publishedSource);
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
    async function visualBytes(url: string, hash?: string, maximum = 128 * 1024 * 1024,
        hashRefusal = 'JOB_SOURCE_MISMATCH') {
        const bytes = await jobBytes(url, signal, maximum);
        if (hash && await jobDigest(bytes) !== hash)
            throw new Error(hashRefusal);
        if (disposed || signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
        return bytes;
    }
    async function image(url: string, hash?: string, evidence = false): Promise<HTMLImageElement> {
        const bytes = await visualBytes(url, hash, evidence ? 8 * 1024 * 1024 : undefined,
            evidence ? 'CHECKPOINT_EVIDENCE_HASH_MISMATCH' : undefined);
        if (disposed || signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
        const blob = URL.createObjectURL(new Blob([bytes.slice().buffer]));
        objectUrls.push(blob);
        const image = new Image();
        image.src = blob;
        let cancel: () => void = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(new Error('JOB_PRELOAD_CANCELLED'));
            signal.addEventListener('abort', cancel, {once: true});
            if (signal.aborted) cancel();
        });
        try {
            await Promise.race([image.decode().catch(error => {
                if (evidence) throw new Error('CHECKPOINT_EVIDENCE_PNG_INVALID');
                throw error;
            }), cancelled]);
            if (disposed || signal.aborted) throw new Error('JOB_PRELOAD_CANCELLED');
            if (!image.naturalWidth || !image.naturalHeight)
                throw new Error(evidence ? 'CHECKPOINT_EVIDENCE_PNG_INVALID' : 'JOB_VISUAL_UNAVAILABLE');
            return image;
        } finally {
            signal.removeEventListener('abort', cancel);
        }
    }
    try {
        const interview = metadata.capabilities.interview ? await jobJson<JobInterview>(routes.api('interview'), signal) : null;
        if (interview?.interview !== undefined && display.publication.interview !== undefined &&
            sourceSnapshot(interview.interview) !== sourceSnapshot(display.publication.interview)) {
            throw new Error('JOB_DISPLAY_MISMATCH');
        }
        const parts = metadata.capabilities.preRig && 'parts' in publishedSource && publishedSource.parts ? await jobJson<JobPartsInventory>(routes.api('stage-parts'), signal) : null;
        if (metadata.sourceHash !== publishedSource.sourceHash || parts && parts.sourceHash !== publishedSource.sourceHash)
            throw new Error('JOB_SOURCE_MISMATCH');
        const references: JobReferenceView[] = [];
        const partImages = new Map<string, HTMLImageElement>();
        const partPages = new Map<number, HTMLImageElement>();
        const preload: Promise<void>[] = [];
        const source = display.publication.source;
        const checkpointEvidence: NonNullable<JobPreparedInspection['checkpointEvidence']>[number][] = [];
        if (Object.hasOwn(metadata, 'checkpointEvidence') !== Object.hasOwn(source, 'checkpointEvidence') ||
            source.checkpointEvidence !== undefined && (!Array.isArray(metadata.checkpointEvidence) ||
                metadata.checkpointEvidence.length !== source.checkpointEvidence.length)) {
            throw new Error('CHECKPOINT_EVIDENCE_INVALID');
        }
        for (const [index, packet] of (source.checkpointEvidence ?? []).entries()) {
            const projection = metadata.checkpointEvidence?.[index];
            const tableUrl = `/api/checkpoint-evidence/${packet.checkpointId}/table`;
            if (!projection?.table || !source.plan?.steps.some(step => step.id === packet.planStepId) ||
                source.subject === 'plan' && !source.subjects.some(subject => subject.kind === 'checkpoint' &&
                    subject.checkpointId === packet.checkpointId && packet.planStepId === packet.checkpointId) ||
                sourceSnapshot(projection) !== sourceSnapshot({...packet,
                    tiles: packet.tiles.map((tile, tileIndex) => ({...tile,
                        url: `/api/checkpoint-evidence/${packet.checkpointId}/tiles/${tileIndex}`})),
                    table: {...packet.table, url: tableUrl, schema: projection.table.schema,
                        columns: projection.table.columns, rows: projection.table.rows}})) {
                throw new Error('CHECKPOINT_EVIDENCE_INVALID');
            }
        }
        for (const [index, packet] of (source.checkpointEvidence ?? []).entries()) {
            preload.push((async () => {
                const bytes = await visualBytes(routes.api(`checkpoint-evidence/${packet.checkpointId}/table`),
                    packet.table.sha256, 256 * 1024, 'CHECKPOINT_EVIDENCE_HASH_MISMATCH');
                let table: JobCheckpointTable;
                try {
                    table = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
                    const projection = metadata.checkpointEvidence![index]!.table;
                    if (sourceSnapshot(table) !== sourceSnapshot({schema: projection.schema,
                        columns: projection.columns, rows: projection.rows})) throw new Error();
                } catch {
                    throw new Error('CHECKPOINT_EVIDENCE_TABLE_INVALID');
                }
                const images = await Promise.all(packet.tiles.map(async (tile, tileIndex) => {
                    const element = await image(routes.api(`checkpoint-evidence/${packet.checkpointId}/tiles/${tileIndex}`),
                        tile.sha256, true);
                    element.alt = tile.label;
                    return element;
                }));
                checkpointEvidence[index] = {packet, table, images};
            })());
        }
        for (const reference of preloadVisuals ? metadata.manifest?.references ?? [] : []) {
            if (reference.id === metadata.sourcePainting?.id) continue;
            preload.push((async () => {
                if (reference.type === 'image') {
                    const painting = !isRecordSource(source) ? source.parts?.images.find(entry =>
                        entry.role === 'painting' && reference.label === entry.role + ' ' + entry.path) : null;
                    const element = await image(routes.asset(reference.path), painting?.sha256 ?? metadata.referenceHashes?.[reference.id]);
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
        if (preloadVisuals && metadata.sourcePainting) {
            const source = metadata.sourcePainting;
            preload.push(image(routes.instance(source.url), source.sha256).then(element => {
                element.alt = source.path;
                references.push({ id: source.id, label: source.path, element,
                    width: element.naturalWidth, height: element.naturalHeight, seek: async () => { } });
            }));
        }
        for (const part of preloadVisuals ? parts?.items ?? [] : []) {
            preload.push(image(routes.api('stage-parts/image/' + part.index), part.imageHash)
                .then(element => { element.alt = part.name; partImages.set(part.name, element); }));
        }
        for (const page of preloadVisuals ? parts?.pages ?? [] : []) {
            preload.push(image(routes.api('stage-parts/page/' + page.index))
                .then(element => { partPages.set(page.index, element); }));
        }
        const preloaded = await Promise.allSettled(preload);
        const failed = preloaded.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        if (!formsOnly && metadata.manifest?.model) {
            const runtime = await import('@rig-c/play');
            const modelUrl = routes.asset(metadata.manifest.model);
            const modelHash = metadata.reviewedSource!.rig!.sha256;
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
        if (!formsOnly && !isRecordSource(source) && !player && !references.length && !partImages.size && !checkpointEvidence.length)
            throw new Error('JOB_VISUAL_UNAVAILABLE');
        if (signal.aborted)
            throw new Error('JOB_PRELOAD_CANCELLED');
        // Preloads can finish out of order. Restore the producer's declared display order.
        const order = [metadata.sourcePainting?.id, ...(metadata.manifest?.references.map(reference => reference.id) ?? [])];
        references.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        return {
            display, metadata, interview, parts, partImages, partPages, checkpointEvidence, references, assets, rigRoot,
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
export type JobForm = {
    form: HTMLFormElement & {commentWords?:()=>string};
    fieldset: HTMLFieldSetElement;
    read: () => UISubmissionV3['value'];
    submissionId: string;
    dirty: boolean;
    submitting: boolean;
    dispose?():void;
};

type JobFormNode = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, key?: string) => HTMLElementTagNameMap[Tag];

/** Existing form and inspection helpers, without a workspace mount. */
export function createJobFormHelpers(node: JobFormNode, t: typeof import('./i18n.ts').t) {
    function inputLabel(key: string, input: HTMLElement): HTMLElement {
        return labelledControl(node('span', key), input);
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
    function imageGallery(images: readonly {name: string; sha256: string; element?: HTMLImageElement;
        role?: string; duplicate?: boolean}[], titleOnly = false, native = false): HTMLElement {
        const gallery = node('section');
        gallery.style.display = 'grid';
        gallery.style.gridAutoFlow = 'column';
        gallery.style.gridAutoColumns = 'minmax(180px, 1fr)';
        gallery.style.gap = '16px';
        gallery.style.overflow = 'auto';
        gallery.style.minHeight = '0';
        gallery.style.flex = '1';
        if(native){gallery.style.gridAutoColumns='max-content';gallery.style.overflow='visible';gallery.style.width='max-content';gallery.style.color='var(--rv-stage-fg)';}
        for (const image of images) {
            const element = image.element;
            if (!element) throw new Error('JOB_VISUAL_UNAVAILABLE');
            const figure = node('figure');
            figure.style.margin = '0';
            figure.style.minWidth = '0';
            figure.dataset.imageName = image.name;
            const name = node('h3');
            name.textContent = image.name;
            name.setAttribute('translate', 'no');
            name.style.overflowWrap = 'anywhere';
            const role = image.role ? node('p', 'job.imageRole.' + image.role) : node('p');
            const hash = node('code');
            hash.className = 'job-source';
            hash.style.display = 'block';
            hash.style.overflowWrap = 'anywhere';
            if (titleOnly || native) hash.title = image.sha256;
            else hash.textContent = image.sha256;
            element.style.width = '100%';
            element.style.height = 'auto';
            element.style.maxHeight = '70vh';
            element.style.objectFit = 'contain';
            if(native){element.style.width=element.naturalWidth+'px';element.style.maxHeight='none';figure.style.width=element.naturalWidth+'px';}
            if(native){figure.title=image.sha256;figure.append(name,element);}else figure.append(name, role, element, hash);
            if (image.duplicate)
                figure.append(node('p', 'job.identicalImages'));
            gallery.append(figure);
        }
        return gallery;
    }
    function planStepText(element: HTMLElement, step: NonNullable<SourceV3['plan']>['steps'][number],
        projection: JobPlanTextProjection | undefined): void {
        const row = projection?.status === 'projected' ? projection.steps.find(row => row.id === step.id && row.hash === step.hash) : undefined;
        const key = row?.does === undefined ? 'job.plan.field.' + (row?.issues.find(issue => issue.field === 'does')?.reason ?? 'absent') : undefined;
        // Producer identities stay raw; absence keys still follow the job form's own language binding.
        element.setAttribute('translate', 'no');
        if (key) element.dataset.jobText = key;
        else delete element.dataset.jobText;
        element.textContent = key ? t(key) : row!.does!;
    }
    function planTextList(plan: NonNullable<SourceV3['plan']>, projection: JobPlanTextProjection | undefined,
        selectedId?: string): HTMLElement {
        const section = node('section');
        section.className = 'job-plan-text';
        if (!projection || projection.status === 'unavailable') {
            section.append(node('p', 'job.plan.noText'));
            if (projection) section.append(node('p', projection.reason));
        }
        const list = node('ol');
        list.className = 'job-plan-steps';
        for (const step of plan.steps) {
            if (selectedId !== undefined && step.id !== selectedId) continue;
            const item = node('li');
            item.dataset.jobPlanStep = step.id;
            const details = node('details');
            details.open = true;
            const title = node('summary');
            planStepText(title, step, projection);
            title.title = step.id + ' · ' + step.hash;
            details.append(title);
            const row = projection?.status === 'projected' ? projection.steps.find(row => row.id === step.id && row.hash === step.hash) : undefined;
            if (row) {
                const fields = node('dl');
                for (const field of JOB_PLAN_TEXT_FIELDS) {
                    if (field === 'does') continue;
                    const term = node('dt', 'job.plan.' + field);
                    const value = node('dd');
                    value.dataset.jobPlanField = field;
                    const issue = row.issues.find(issue => issue.field === field);
                    if (issue) value.append(node('span', 'job.plan.field.' + issue.reason));
                    else if (field === 'rests_on') {
                        const rests = node('ul');
                        for (const text of row.rests_on!) {
                            const rest = node('li'), dependency = plan.steps.find(step => step.id === text);
                            if (dependency) {planStepText(rest, dependency, projection); rest.title = text;}
                            else {rest.textContent = text; rest.setAttribute('translate', 'no');}
                            rests.append(rest);
                        }
                        value.append(rests);
                    } else {value.textContent = row[field]!; value.setAttribute('translate', 'no');}
                    fields.append(term, value);
                }
                details.append(fields);
            }
            item.append(details); list.append(item);
        }
        list.addEventListener('keydown', event => {
            const key = event as KeyboardEvent;
            if (!['ArrowUp', 'ArrowDown'].includes(key.key) || !(key.target instanceof HTMLElement) || key.target.tagName !== 'SUMMARY') return;
            const summaries = [...list.querySelectorAll<HTMLElement>('summary')];
            const index = summaries.indexOf(key.target);
            const next = summaries[index + (key.key === 'ArrowDown' ? 1 : -1)];
            if (next) {key.preventDefault(); next.focus();}
        });
        section.append(list);
        return section;
    }
    return {inputLabel, selectValues, imageGallery, planTextList, planStepText};
}

/** The answer builder owns no page shell, transport or draft collection. */
export interface JobFormDependencies {
    node: JobFormNode;
    translate: typeof import('./i18n.ts').t;
    helpers: ReturnType<typeof createJobFormHelpers> & {
        assertJobAskSource: typeof assertJobAskSource;
        jobCheckpointContext: typeof jobCheckpointContext;
    };
    draftStorage(): Pick<Storage, 'getItem'>;
    localDraftKey(display: DisplayPublicationV3): string;
    saveDraft(): void;
    window: {
        state(): Pick<JobWindowState, 'receipt' | 'preparing' | 'closed' | 'generation' | 'pending'>;
        submit(input: UISubmissionV3): Promise<JobResult<ActV3>>;
    };
    access: Pick<JobWindowAccess, 'capability'>;
    pageId: string;
}

/** Build the existing answer form with explicit host dependencies. */
    function formFor(ask: PendingAskV3, prepared: JobPreparedInspection, deps: JobFormDependencies): JobForm {
        const {node, translate: t, helpers: {selectValues, imageGallery, planTextList, planStepText, assertJobAskSource, jobCheckpointContext},
            draftStorage, localDraftKey, saveDraft, window, access, pageId} = deps;
        if (ask.publicationId !== prepared.display.publication.publicationId)
            throw new Error('JOB_DISPLAY_MISMATCH');
        assertJobAskSource(ask, prepared.display);
        // Rig verdicts belong to the shared screen; unsupported combinations have no job-window form.
        if (ask.subject.kind === 'review-verdict' && ask.subject.stage === 'rig-review')
            throw new Error('JOB_ACT_KIND_DISABLED');
        const form = node('form') as JobForm['form'];
        form.dataset.jobAsk = ask.askId;
        form.dataset.jobPublication = ask.publicationId;
        const fields = node('fieldset');
        form.append(fields);
        const source = node('p');
        source.className = 'job-source';
        source.textContent = ask.subject.kind === 'review-verdict'
            ? prepared.display.publication.label + ' · ' + ask.source.sourceHash : prepared.display.publication.label;
        if (ask.subject.kind !== 'review-verdict') {source.title = ask.source.sourceHash; source.setAttribute('translate', 'no');}
        fields.append(source);
        const subject = ask.subject;
        if(subject.kind==='review-verdict')throw new Error('JOB_ACT_KIND_DISABLED');
        const commentOnly = subject.kind === 'checkpoint' || subject.kind === 'signoff' || subject.kind === 'reopen';
        if(commentOnly)fields.append(node('p','job.commentsFromWorkspace'));
        let retainedCommentWords='';
        const commentWords=()=>form.commentWords?.()??retainedCommentWords;
        let read: () => UISubmissionV3['value'];
        let submitKey = 'Submit review';
        let disposeInterview:(()=>void)|undefined;
        let interviewForm:ReturnType<typeof createInterviewForm>|undefined;
        if (subject.kind === 'interview-picks') {
            const question = prepared.interview?.questions.find(item => item.set.id === subject.setId && item.set.question === subject.questionId);
            if (!question || !question.editable) throw new Error('JOB_ASK_INVALID');
            if (question.ref.sha256 !== ask.source.optionSet?.sha256) throw new Error('JOB_ACT_SOURCE_STALE');
            const interviewState = prepared.interview?.interview ?? prepared.display.publication.interview ?? null;
            const inspectionRecord = interviewState?.records.find(
                item => item.timeKind === 'inspection' &&
                    item.questionId === subject.questionId &&
                    item.setId === subject.setId &&
                    item.record.endsWith('.pending_options'),
            );
            const legacyDiagnostic = inspectionRecord
                ? interviewState?.diagnostics.find(
                    item => item.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY' &&
                        item.record === inspectionRecord.record &&
                        item.at === inspectionRecord.at,
                )
                : undefined;
            if (legacyDiagnostic) {
                const legacyNotice = node('p', 'INTERVIEW_OPTIONS_SCENE_LEGACY');
                legacyNotice.dataset.jobInterviewWarning = legacyDiagnostic.code;
                legacyNotice.dataset.record = legacyDiagnostic.record;
                fields.prepend(legacyNotice);
            }
            interviewForm=createInterviewForm({question,id:'interview-answer-'+ask.askId,node,form,fieldset:fields,source,
                mainView:true,images:question.images.map(image=>({name:image.name,src:jobPublicationRoutes(prepared.display,location.origin).instance(image.url)})),answered:ask.status==='answered'});
            disposeInterview=interviewForm.dispose;read=interviewForm.read;
            submitKey = 'interview.save';
        }
        else if (subject.kind === 'checkpoint') {
            const checkpoint = jobCheckpointContext(ask, prepared.metadata.manifest?.checkpoints ?? []);
            const heading = node('h3');
            heading.textContent = checkpoint.title;
            heading.title = subject.checkpointId;
            heading.setAttribute('translate', 'no');
            if (prepared.metadata.manifest?.checkpoints.find(item => item.id === subject.checkpointId)?.title == null)
                planStepText(heading, checkpoint.step, prepared.metadata.planText);
            fields.prepend(heading);
            const guidance = node('p');
            guidance.textContent = checkpoint.note;
            guidance.setAttribute('translate', 'no');
            fields.append(guidance, planTextList(ask.source.plan!, prepared.metadata.planText, checkpoint.step.id));
            const evidence = prepared.checkpointEvidence?.find(item => item.packet.checkpointId === subject.checkpointId);
            const declared = ask.source.checkpointEvidence?.find(item => item.checkpointId === subject.checkpointId);
            if (Boolean(declared) !== Boolean(evidence) || evidence &&
                (JSON.stringify(evidence.packet) !== JSON.stringify(declared) || evidence.packet.planStepId !== checkpoint.step.id)) {
                throw new Error('CHECKPOINT_EVIDENCE_INVALID');
            }
            if (evidence) {
                const section = node('section');
                section.dataset.jobCheckpointEvidence = subject.checkpointId;
                section.append(node('h4', 'job.checkpointEvidence'));
                section.append(imageGallery(evidence.packet.tiles.map((tile, index) => ({name: tile.label,
                    sha256: tile.sha256, element: evidence.images[index]?.cloneNode(true) as HTMLImageElement})), true));
                const tableHost = node('div');
                tableHost.style.overflow = 'auto';
                tableHost.style.maxHeight = '50dvh';
                const table = node('table');
                table.dataset.jobCheckpointTable = '';
                const caption = node('caption', 'job.checkpointTable');
                if (evidence.packet.table.label !== undefined) {
                    delete caption.dataset.jobText;
                    caption.textContent = evidence.packet.table.label;
                    caption.setAttribute('translate', 'no');
                }
                const head = node('thead');
                head.setAttribute('translate', 'no');
                const columns = node('tr');
                for (const column of evidence.table.columns) {
                    const cell = node('th');
                    cell.scope = 'col';
                    cell.textContent = column;
                    columns.append(cell);
                }
                head.append(columns);
                const body = node('tbody');
                body.setAttribute('translate', 'no');
                for (const row of evidence.table.rows) {
                    const cells = node('tr');
                    for (const value of row) {
                        const cell = node('td');
                        cell.textContent = String(value);
                        cells.append(cell);
                    }
                    body.append(cells);
                }
                table.append(caption, head, body);
                tableHost.append(table);
                const routes = node('pre');
                routes.textContent = evidence.packet.routesText;
                routes.setAttribute('translate', 'no');
                const recommendation = node('pre');
                recommendation.textContent = evidence.packet.recommendationText;
                recommendation.setAttribute('translate', 'no');
                section.append(tableHost, node('h4', 'job.checkpointRoutes'), routes,
                    node('h4', 'job.checkpointRecommendation'), recommendation);
                fields.append(section, node('p', 'job.checkpointRouteMapping'));
            }
            const outcome = selectValues(['', 'pass', 'fail'], ['Pending', 'Pass', 'job.fail']);
            outcome.required = true;
            outcome.name = 'outcome';
            fields.append(outcome);
            read = () => ({ checkpointId: subject.checkpointId, outcome: outcome.value as 'pass' | 'fail', words: commentWords() });
            submitKey = 'job.saveCheckpoint';
        }
        else if(subject.kind==='parts-verdict')throw new Error('JOB_ACT_KIND_DISABLED');
        else if (subject.kind === 'signoff') {
            fields.title = subject.stage;
            if (ask.source.plan) fields.append(planTextList(ask.source.plan, prepared.metadata.planText));
            read = () => ({ stage: subject.stage, decision: 'approved', words: commentWords() });
            submitKey = 'job.signoff';
        }
        else if (subject.kind === 'reopen') {
            if (
                !('record' in ask.source) ||
                ask.source.subject !== 'plan' ||
                typeof subject.stage !== 'string' ||
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(subject.stage) ||
                !ask.source.subjects.some(candidate => candidate.kind === 'reopen' && candidate.stage === subject.stage)
            ) {
                throw new Error('JOB_ASK_INVALID');
            }
            fields.title = subject.stage;
            read = () => ({ stage: subject.stage, words: commentWords() });
            submitKey = 'job.reopen';
        }
        else {
            throw new Error('JOB_ACT_KIND_DISABLED');
        }
        const submit = interviewForm?.submit??node('button', submitKey);
        submit.type = 'submit';
        fields.append(submit);
        const status = interviewForm?.status??node('p');
        status.setAttribute('role', 'status');
        form.append(status);
        const entry: JobForm = { form, fieldset: fields, read, submissionId: crypto.randomUUID(), dirty: false,
            submitting: false, ...(disposeInterview?{dispose:disposeInterview}:{}) };
        if(disposeInterview)form.addEventListener('job-form-dispose',disposeInterview);
        try {
            const saved = JSON.parse(draftStorage().getItem(localDraftKey(prepared.display)) ?? 'null');
            if (saved?.publicationId === prepared.display.publication.publicationId &&
                saved?.sourceHash === prepared.display.publication.source.sourceHash) {
                assertJobAskSource({...ask, source: saved.source}, prepared.display);
                const original = saved.forms?.find((item: {
                    askId: string;
                }) => item.askId === ask.askId);
                if(commentOnly&&typeof original?.value?.words==='string'&&original.value.words.length<=10000)retainedCommentWords=original.value.words;
                for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')) {
                    const restored = original?.controls?.find((item: {
                        name: string;
                        value: string;
                    }) => item.name === input.name);
                    if (restored && typeof restored.value === 'string') {
                        if(input instanceof HTMLInputElement&&input.type==='radio'){
                            input.checked=input.value===restored.value;
                            if(input.checked)input.dispatchEvent(new Event('change'));
                        }else{
                            input.value = restored.value;
                            if (input instanceof HTMLSelectElement)input.dispatchEvent(new Event('change'));
                        }
                    }
                }
                entry.dirty = !!original;
                if(subject.kind==='interview-picks')form.dispatchEvent(new Event('change'));
            }
        }
        catch { /* Invalid or unavailable local drafts grant no submission authority. */ }
        form.oninput = () => { entry.dirty = true; entry.submissionId = crypto.randomUUID(); saveDraft(); };
        let attemptedValue:string|undefined;
        form.onsubmit = async (event) => {
            event.preventDefault();
            const state = window.state();
            const receipt = state.receipt;
            if (!receipt || state.preparing || state.closed || !access.capability || !form.reportValidity())
                return;
            try {
                const value=read(),key=JSON.stringify(value);
                if(commentOnly&&attemptedValue!==undefined&&attemptedValue!==key)entry.submissionId=crypto.randomUUID();
                attemptedValue=key;
                const input = { kind: subject.kind, publicationId: ask.publicationId,
                    askId: ask.askId, pageId, displayedNonce: receipt.displayedNonce,
                    expectedGeneration: state.generation, submissionId: entry.submissionId, value } as UISubmissionV3;
                const activeAsk = state.pending.find(item => item.askId === ask.askId);
                if (!activeAsk) throw new Error('JOB_ASK_INVALID');
                entry.submitting = true;
                fields.disabled = true;
                const frozen = await Promise.resolve(input);
                if (entry.submissionId !== frozen.submissionId) throw new Error('JOB_STILL_BINDING_MISMATCH');
                const result = await window.submit(frozen);
                if (!result.ok)
                    throw new Error(result.error.code);
                entry.submitting = false;
                entry.dirty = false;
                status.dataset.jobText = 'job.saved';
                status.textContent = t('job.saved');
                if(subject.kind==='interview-picks'){form.dataset.interviewAnswered='true';form.dispatchEvent(new Event('change'));}
                saveDraft();
            }
            catch (error) {
                entry.submitting = false;
                status.dataset.jobText = error instanceof Error && Object.hasOwn(enCatalog, error.message) && Object.hasOwn(koCatalog, error.message)
                    ? error.message : 'JOB_ACT_INVALID';
                status.textContent = jobWindowRefusal(error, 'JOB_ACT_INVALID');
                fields.disabled = false;
            }
        };
        return entry;
    }
export {formFor};

// Keep the form dependencies available through the existing preparation seam as well as named exports.
prepareJobForms.formFor = formFor;
prepareJobForms.helpers = createJobFormHelpers;

/** The original source-bound draft storage, shared by the legacy and single-screen hosts. */
/** Joined inspection uses real API rows and the same answer builder; no job identities or acts are synthesized. */
export async function joinedInterviewForms(access:InstanceAccess,present:(forms:readonly HTMLElement[])=>void):Promise<()=>void> {
    const request=async(path:string,body?:unknown)=>{
        const response=await fetch(access.route(path),body?{method:'POST',headers:access.headers({'Content-Type':'application/json'}),body:JSON.stringify(body)}:undefined);
        const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
    };
    const data=await request('/api/interview') as {questions:InterviewDisplayQuestion[];diagnostics?:import('../src/interview-project.ts').InterviewDiagnostic[];historical?:import('../src/interview-project.ts').HistoricalInterview[]};
    const forms=new Map<number,ReturnType<typeof createInterviewForm>>();
    let selected=Math.max(0,data.questions.findIndex(question=>question.editable&&!question.saved)),disposed=false;
    const node:JobFormNode=(tag,key)=>{const item=document.createElement(tag);if(key){item.dataset.jobText=key;item.textContent=t(key);}return item;};
    const show=(index:number)=>{
        if(disposed)return;selected=index;
        const question=data.questions[index];
        if(!question){const empty=node('section');empty.append(node('p','interview.empty'),interviewRecords(data.diagnostics,data.historical));present([empty]);return;}
        let entry=forms.get(index);
        if(!entry){
            entry=createInterviewForm({question,id:'joined-interview-'+question.ref.sha256,node,
                mainView:true,images:question.images.map(image=>({name:image.name,src:access.route(image.url)})),
                questions:()=>data.questions.map((item,i)=>({label:item.set.question+' · '+item.set.id+(item.editable?'':' · '+t('interview.history')),answered:forms.get(i)?.form.dataset.interviewAnswered==='true'||Boolean(item.saved||item.answer)})),
                selected:index,onSelect:show,diagnostics:data.diagnostics,historical:data.historical});
            const answer=entry;
            entry.fieldset.disabled=!question.editable||!access.capability;
            entry.form.onsubmit=async event=>{
                event.preventDefault();if(!question.editable||!access.capability||entry!.fieldset.disabled||!entry!.form.reportValidity())return;
                answer.fieldset.disabled=true;
                try{
                    const value=answer.read(),picks=value.selections.map(selection=>({ask:selection.itemId,option_id:selection.optionId,...(selection.otherText!==null?{other_text:selection.otherText}:{})}));
                    const record=interviewPicksRecord(question.ref,picks,answer.retainedNote,new Date().toISOString());
                    await request('/api/interview/picks',record);
                    question.saved=record;answer.form.dataset.interviewAnswered='true';answer.status.dataset.jobText='interview.saved';answer.status.textContent=t('interview.saved');answer.form.dispatchEvent(new Event('change'));
                }catch(error){const code=error instanceof Error?error.message.split(':')[0]:'';answer.status.dataset.jobText=interviewErrors[code]??'interview.failed';answer.status.textContent=t(answer.status.dataset.jobText);}
                finally{answer.fieldset.disabled=!question.editable||!access.capability;}
            };
            forms.set(index,entry);
        }
        entry.form.dispatchEvent(new Event('change'));present([entry.form]);
    };
    const localize=()=>{for(const entry of forms.values())entry.localize();};
    try{show(selected);}catch(error){for(const entry of forms.values())entry.dispose();throw error;}
    const off=onLanguageChange(localize);
    return ()=>{disposed=true;off();for(const entry of forms.values())entry.dispose();forms.clear();};
}

export function createJobFormDrafts(options:{jobId:string;current():JobPreparedInspection|null;forms():ReadonlyMap<string,JobForm>;storage():Pick<Storage,'setItem'>}) {
    function localDraftKey(display: DisplayPublicationV3): string {
        return 'rig-review-job-draft/1:' + options.jobId + ':' + display.publication.publicationId + ':' + display.publication.source.sourceHash;
    }
    function saveDraft(): void {
        const current=options.current(),forms=options.forms();
        if (!current)
            return;
        try {
            options.storage().setItem(localDraftKey(current.display), JSON.stringify({
                publicationId: current.display.publication.publicationId,
                sourceHash: current.display.publication.source.sourceHash,
                source: current.display.publication.source,
                label: current.display.publication.label,
                forms: [...forms].filter(([, item]) => item.dirty).map(([askId, item]) => ({
                    askId, value: item.read(),
                    controls: [...item.form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input[name],textarea[name],select[name]')]
                        .filter(input=>!(input instanceof HTMLInputElement&&input.type==='radio')||input.checked)
                        .map(input => ({ name: input.name, value: input.value })),
                })),
            }));
        }
        catch { /* The in-memory retained draft remains source-bound. */ }
    }
    return {localDraftKey,saveDraft};
}
prepareJobForms.drafts=createJobFormDrafts;

/** Host supported publications through the existing transaction/stream modules before mounting any screen. */
export async function mountJobScreen(host:HTMLElement):Promise<()=>void> {
    let storage:Storage|null=null;try{storage=sessionStorage;}catch{/* Keep the capability in memory. */}
    const access=jobWindowAccess(location.href,storage,href=>history.replaceState(history.state,'',href)),pageId=crypto.randomUUID(),abort=new AbortController();
    const language=new URL(location.href).searchParams.get('lang');
    const i18n=await import('./i18n.ts');if(language==='en'||language==='ko')i18n.setLanguagePreference(language);
    const node=<Tag extends keyof HTMLElementTagNameMap>(tag:Tag,key?:string)=>{const value=document.createElement(tag);if(key){value.dataset.jobText=key;value.textContent=t(key);}return value;};
    const helpers=createJobFormHelpers(node,t),emptyForms=new Map<string,JobForm>();
    const modalState=()=>{const prepared=rigScreen.mounted();return prepared?.record??prepared?.modals;};
    const drafts=createJobFormDrafts({jobId:access.jobId,current:()=>modalState()?.inspection??null,forms:()=>modalState()?.forms??emptyForms,storage:()=>localStorage});
    const transport=createJobWindowTransport(access);
    let stopped=false;
    const dependencies:JobFormDependencies={node,translate:t,helpers:{...helpers,assertJobAskSource,jobCheckpointContext},draftStorage:()=>localStorage,...drafts,access,pageId,
        window:{state:()=>window.state(),submit:input=>window.submit(input)}};
    const rigScreen=createJobRigScreen({host,pageId,access,translate:(key,values)=>i18n.t(key,values,'en'),refusal:jobWindowRefusal,formDependencies:dependencies,
        window:{state:()=>window.state(),submit:input=>window.submit(input)},readPublication:(id,signal)=>transport.readPublication(id,signal),
        routes:display=>jobPublicationRoutes(display,location.origin),load:async()=>(await import('./main.ts')).mountRigScreen()});
    let bootstrapNotice:HTMLElement|null=null;
    const report=(error:unknown,fallback?:string)=>{if(rigScreen.mounted()){rigScreen.report(error,fallback);return;}if(!bootstrapNotice){bootstrapNotice=node('p');bootstrapNotice.setAttribute('role','status');host.append(bootstrapNotice);}bootstrapNotice.textContent=jobWindowRefusal(error,fallback);};
    const window=createJobWindow<JobRigScreenPrepared|null>({jobId:access.jobId,pageId,transport,adapter:{
        async prepare(display,signal){return rigScreen.prepare(display,signal);},
        captureDraft(){drafts.saveDraft();const forms=modalState()?.forms;const dirty=forms?[...forms].filter(([,entry])=>entry.dirty):[];return dirty.length?dirty.map(([askId,entry])=>({askId,value:entry.read()})):null;},
        commit:prepared=>prepared?rigScreen.commit(prepared):{rollback(){},finalize(){}},
        async painted(prepared,signal){if(stopped||signal.aborted)return;if(prepared)await rigScreen.painted(prepared,signal);},
        discard:prepared=>{const modal=prepared?.record??prepared?.modals;for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();},
        changed(state){rigScreen.changed(state);if(state.error&&(!rigScreen.mounted()||rigScreen.mounted()?.record))report(state.error);},
    }});
    const localize=i18n.onLanguageChange(()=>{for(const element of host.querySelectorAll<HTMLElement>('[data-job-text]'))element.textContent=t(element.dataset.jobText!);for(const form of host.querySelectorAll('form.interview-answer'))form.dispatchEvent(new Event('job-form-language'));});
    startJobWindowEvents({access,signal:abort.signal,event:event=>window.event(event),refused:error=>report(error,'JOB_STREAM_FAILED')});
    const stop=()=>{if(stopped)return;stopped=true;drafts.saveDraft();abort.abort();window.stop();const modal=modalState();for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();localize();globalThis.removeEventListener('pagehide',stop);};
    globalThis.addEventListener('pagehide',stop,{once:true});return stop;
}
