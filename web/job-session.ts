import {mountWorkspaceShell} from './workspace-ui.ts';
/** Live job window transactions. Every form remains bound to its displayed publication. */
import { parseControlPart, type ControlPart } from '../src/control.ts';
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
import {JOB_HUB_READY, jobHubMessageMatches, type JobHubBinding} from './job-hub.ts';
import {recordJobRigDraw, jobRigDrawState, presentJobRigStage,
    type JobRigDraw, type JobRigDrawState} from './job-rig-capture.ts';
import {advancePlayback} from './playback-clock.ts';
import {createJobRigScreen, isJobRigScreen, type JobRigScreenPrepared} from './job-rig-screen.ts';
import type {JobRigPresentation} from './viewport-capture.ts';
import {labelledControl,createViewControls} from './view-controls.ts';
import {createInterviewForm,interviewPicksRecord,interviewRecords,interviewErrors,type InterviewDisplayQuestion} from './interview-panel.ts';
import {SENTINELS} from './parts-render.ts';
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
    rollback(): void;
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
    readonly previousLabel: string | null;
    readonly pending: readonly JobWindowAsk[];
    readonly retainedDrafts: readonly JobRetainedDraft[];
}
function unwrap<Value>(result: JobResult<Value>): Value {
    if (!result.ok)
        throw new Error(result.error.code);
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
    error = null;
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
    function replace(publication: PublicationV3): Promise<void> {
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
                if (publication.visual.status !== 'available' && !isRecordSource(publication.source))
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
    async function submitParts(input: UISubmissionV3, signoffSubmissionId: string): Promise<JobResult<ActV3>> {
        const publicationId = input.publicationId;
        const ask = pending.get(input.askId);
        if (!displayed || displayed.publication.publicationId !== publicationId || !ask ||
            ask.subject.kind !== 'parts-verdict') throw new Error('JOB_ACT_SOURCE_STALE');
        assertJobAskSource(ask, displayed);
        const previous = ask.act;
        // An act@6 verdict's note is its one general comment; the signoff resends it.
        const value = (previous?.kind !== 'parts-verdict' ? input.value : previous.schema !== JOB_COMMENTS_ACT_SCHEMA ? previous.value :
            {verdict: previous.value.verdict, words: previous.value.comments.find(comment => !comment.anchor)?.text ?? ''}) as Pick<PartsVerdictValue, 'verdict' | 'words'>;
        const signoff = [...pending.values()].find(item => item.publicationId === publicationId &&
            item.subject.kind === 'signoff' && item.subject.stage === 'parts-review' && item.status === 'pending');
        if (value.verdict === 'approved' && !signoff) throw new Error('JOB_PARTS_SIGNOFF_MISSING');
        let result: JobResult<ActV3>;
        if (ask.status === 'pending') {
            result = await submit(input);
            if (!result.ok) return result;
        } else {
            if (!previous || previous.kind !== 'parts-verdict' || (previous.schema !== JOB_PARTS_VERDICT_ACT_SCHEMA && previous.schema !== JOB_COMMENTS_ACT_SCHEMA) ||
                value.verdict !== 'approved') throw new Error('JOB_ACT_SOURCE_STALE');
            result = {ok: true, value: previous};
        }
        if (value.verdict !== 'approved') return result;
        // Recheck after the first durable write. A replacement never inherits this signoff.
        const latest = state();
        if (latest.displayed?.publication.publicationId !== publicationId || !latest.receipt || !signoff)
            throw new Error('JOB_ACT_SOURCE_STALE');
        assertJobAskSource(signoff, latest.displayed);
        return submit({kind: 'signoff', publicationId, pageId: input.pageId, askId: signoff.askId,
            expectedGeneration: latest.generation, displayedNonce: latest.receipt.displayedNonce,
            submissionId: signoffSubmissionId,
            value: {stage: 'parts-review', decision: 'approved', words: value.words}});
    }
    return {
        event, replace, submit, submitParts, state, refresh: changed,
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
                    throw new Error('JOB_BODY_LIMIT');
                const event = JSON.parse(buffered.slice(0, newline)) as EventV3;
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
    event(value: EventV3): void;
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
    const stage: PanelComponent = source.subject === 'image-set' ? 'images.set' :
        isRecordSource(source) ? source.subject === 'plan' ? 'plan.body' : 'interview.picks' :
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
    interviewImages: Map<string, HTMLImageElement>;
    imageSetImages?: readonly HTMLImageElement[];
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
export async function prepareJobInspection(display: DisplayPublicationV3, signal: AbortSignal): Promise<JobPreparedInspection> {
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
        const parts = metadata.capabilities.preRig ? await jobJson<JobPartsInventory>(routes.api('stage-parts'), signal) : null;
        if (metadata.sourceHash !== publishedSource.sourceHash || parts && parts.sourceHash !== publishedSource.sourceHash)
            throw new Error('JOB_SOURCE_MISMATCH');
        const references: JobReferenceView[] = [];
        const partImages = new Map<string, HTMLImageElement>();
        const interviewImages = new Map<string, HTMLImageElement>();
        const partPages = new Map<number, HTMLImageElement>();
        const preload: Promise<void>[] = [];
        const imageSetImages: HTMLImageElement[] = [];
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
        if (source.subject === 'image-set') {
            if (metadata.sourceHash !== source.sourceHash || metadata.manifest?.model)
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
        for (const reference of metadata.manifest?.references ?? []) {
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
        for (const page of parts?.pages ?? []) {
            preload.push(image(routes.api('stage-parts/page/' + page.index))
                .then(element => { partPages.set(page.index, element); }));
        }
        for (const question of interview?.questions ?? [])
            for (const asset of question.images) {
                preload.push(image(routes.instance(asset.url)).then(element => { element.alt = asset.name; interviewImages.set(asset.url, element); }));
            }
        const preloaded = await Promise.allSettled(preload);
        const failed = preloaded.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        if (metadata.manifest?.model) {
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
        if (!isRecordSource(source) && !player && !references.length && !partImages.size && !imageSetImages.length && !checkpointEvidence.length)
            throw new Error('JOB_VISUAL_UNAVAILABLE');
        if (signal.aborted)
            throw new Error('JOB_PRELOAD_CANCELLED');
        // Preloads can finish out of order. Restore the producer's declared display order.
        const order = [metadata.sourcePainting?.id, ...(metadata.manifest?.references.map(reference => reference.id) ?? [])];
        references.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        return {
            display, metadata, interview, parts, partImages, partPages, interviewImages, imageSetImages, checkpointEvidence, references, assets, rigRoot,
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
    form: HTMLFormElement;
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
    function textArea(parent: HTMLElement, key: string, name = 'note'): HTMLTextAreaElement {
        const input = node('textarea');
        input.name = name;
        parent.append(inputLabel(key, input));
        return input;
    }
    function imageGallery(images: readonly {name: string; sha256: string; element?: HTMLImageElement;
        role?: string; duplicate?: boolean}[]): HTMLElement {
        const gallery = node('section');
        gallery.style.display = 'grid';
        gallery.style.gridAutoFlow = 'column';
        gallery.style.gridAutoColumns = 'minmax(180px, 1fr)';
        gallery.style.gap = '16px';
        gallery.style.overflow = 'auto';
        gallery.style.minHeight = '0';
        gallery.style.flex = '1';
        for (const image of images) {
            const element = image.element;
            if (!element) throw new Error('JOB_VISUAL_UNAVAILABLE');
            const figure = node('figure');
            figure.style.margin = '0';
            figure.style.minWidth = '0';
            figure.dataset.imageName = image.name;
            const name = node('h3');
            name.textContent = image.name;
            name.style.overflowWrap = 'anywhere';
            const role = image.role ? node('p', 'job.imageRole.' + image.role) : node('p');
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
            if (image.duplicate)
                figure.append(node('p', 'job.identicalImages'));
            gallery.append(figure);
        }
        return gallery;
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
            title.textContent = step.id;
            const hash = node('code');
            hash.className = 'job-source';
            hash.textContent = step.hash;
            details.append(title, hash);
            const row = projection?.status === 'projected' ? projection.steps.find(row => row.id === step.id && row.hash === step.hash) : undefined;
            if (row) {
                const fields = node('dl');
                for (const field of JOB_PLAN_TEXT_FIELDS) {
                    const term = node('dt', 'job.plan.' + field);
                    const value = node('dd');
                    value.dataset.jobPlanField = field;
                    const issue = row.issues.find(issue => issue.field === field);
                    if (issue) value.append(node('span', 'job.plan.field.' + issue.reason));
                    else if (field === 'rests_on') {
                        const rests = node('ul');
                        for (const text of row.rests_on!) {const rest = node('li'); rest.textContent = text; rests.append(rest);}
                        value.append(rests);
                    } else value.textContent = row[field]!;
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
    return {inputLabel, selectValues, textArea, imageGallery, planTextList};
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
        const {node, translate: t, helpers: {textArea, selectValues, imageGallery, planTextList, assertJobAskSource, jobCheckpointContext},
            draftStorage, localDraftKey, saveDraft, window, access, pageId} = deps;
        if (ask.publicationId !== prepared.display.publication.publicationId)
            throw new Error('JOB_DISPLAY_MISMATCH');
        assertJobAskSource(ask, prepared.display);
        // Rig verdicts belong to the shared screen; unsupported combinations have no job-window form.
        if (ask.subject.kind === 'review-verdict' && ask.subject.stage === 'rig-review')
            throw new Error('JOB_ACT_KIND_DISABLED');
        const form = node('form');
        form.dataset.jobAsk = ask.askId;
        const fields = node('fieldset');
        form.append(fields);
        const source = node('p');
        source.className = 'job-source';
        source.textContent = prepared.display.publication.label + ' · ' + ask.source.sourceHash;
        fields.append(source);
        const note = ask.subject.kind==='interview-picks'?{value:'',parentElement:null}:textArea(fields, 'interview.note');
        let read: () => UISubmissionV3['value'];
        let submitKey = 'Submit review';
        const subject = ask.subject;
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
                images:question.images.map(image=>{const visual=prepared.interviewImages.get(image.url);if(!visual)throw new Error('JOB_VISUAL_UNAVAILABLE');return {name:image.name,src:visual.src};}),answered:ask.status==='answered'});
            disposeInterview=interviewForm.dispose;read=interviewForm.read;
            submitKey = 'interview.save';
        }
        else if (subject.kind === 'checkpoint') {
            const checkpoint = jobCheckpointContext(ask, prepared.metadata.manifest?.checkpoints ?? []);
            const heading = node('h3');
            heading.textContent = checkpoint.title;
            fields.prepend(heading);
            const guidance = node('p');
            guidance.textContent = checkpoint.note;
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
                    sha256: tile.sha256, element: evidence.images[index]?.cloneNode(true) as HTMLImageElement}))));
                const tableHost = node('div');
                tableHost.style.overflow = 'auto';
                tableHost.style.maxHeight = '50dvh';
                const table = node('table');
                table.dataset.jobCheckpointTable = '';
                const caption = node('caption', 'job.checkpointTable');
                if (evidence.packet.table.label !== undefined) {
                    delete caption.dataset.jobText;
                    caption.textContent = evidence.packet.table.label;
                }
                const head = node('thead');
                const columns = node('tr');
                for (const column of evidence.table.columns) {
                    const cell = node('th');
                    cell.scope = 'col';
                    cell.textContent = column;
                    columns.append(cell);
                }
                head.append(columns);
                const body = node('tbody');
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
                const recommendation = node('pre');
                recommendation.textContent = evidence.packet.recommendationText;
                section.append(tableHost, node('h4', 'job.checkpointRoutes'), routes,
                    node('h4', 'job.checkpointRecommendation'), recommendation);
                fields.append(section, node('p', 'job.checkpointRouteMapping'));
            }
            const outcome = selectValues(['', 'pass', 'fail'], ['Pending', 'Pass', 'job.fail']);
            outcome.required = true;
            outcome.name = 'outcome';
            fields.append(outcome, note.parentElement!);
            read = () => ({ checkpointId: subject.checkpointId, outcome: outcome.value as 'pass' | 'fail', words: note.value });
            submitKey = 'job.saveCheckpoint';
        }
        else if(subject.kind==='parts-verdict')throw new Error('JOB_PANEL_UNAVAILABLE');
        else if (subject.kind === 'review-verdict' && (subject.stage === 'image-review' || subject.stage === 'direction-review')) {
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
            if (ask.source.plan) fields.append(planTextList(ask.source.plan, prepared.metadata.planText), note.parentElement!);
            read = () => ({ stage: subject.stage, decision: 'approved', words: note.value });
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
            const stage = node('p');
            stage.textContent = subject.stage;
            fields.append(stage);
            read = () => ({ stage: subject.stage, words: note.value });
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
        form.onsubmit = async (event) => {
            event.preventDefault();
            const state = window.state();
            const receipt = state.receipt;
            if (!receipt || state.preparing || state.closed || !access.capability || !form.reportValidity())
                return;
            try {
                const input = { kind: subject.kind, publicationId: ask.publicationId,
                    askId: ask.askId, pageId, displayedNonce: receipt.displayedNonce,
                    expectedGeneration: state.generation, submissionId: entry.submissionId, value: read() } as UISubmissionV3;
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
                images:question.images.map(image=>({name:image.name,src:access.route(image.url)})),
                questions:()=>data.questions.map((item,i)=>({label:item.set.question+' · '+item.set.id+(item.editable?'':' · '+t('interview.history')),answered:forms.get(i)?.form.dataset.interviewAnswered==='true'||Boolean(item.saved||item.answer)})),
                selected:index,onSelect:show,diagnostics:data.diagnostics,historical:data.historical});
            const answer=entry;
            entry.fieldset.disabled=!question.editable||!access.capability;
            entry.form.onsubmit=async event=>{
                event.preventDefault();if(!question.editable||!access.capability||entry!.fieldset.disabled||!entry!.form.reportValidity())return;
                answer.fieldset.disabled=true;
                try{
                    const value=answer.read(),picks=value.selections.map(selection=>({ask:selection.itemId,option_id:selection.optionId,...(selection.otherText!==null?{other_text:selection.otherText}:{})}));
                    await request('/api/interview/picks',interviewPicksRecord(question.ref,picks,'',new Date().toISOString()));
                    question.saved=interviewPicksRecord(question.ref,picks,'',new Date().toISOString());answer.form.dataset.interviewAnswered='true';answer.status.dataset.jobText='interview.saved';answer.status.textContent=t('interview.saved');answer.form.dispatchEvent(new Event('change'));
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
    const drafts=createJobFormDrafts({jobId:access.jobId,current:()=>rigScreen.mounted()?.record?.inspection??null,forms:()=>rigScreen.mounted()?.record?.forms??emptyForms,storage:()=>localStorage});
    const transport=createJobWindowTransport(access);
    let events:ReturnType<typeof startJobWindowEvents>|undefined,legacyStop:(()=>void)|undefined,stopped=false,fallingBack=false;
    const dependencies:JobFormDependencies={node,translate:t,helpers:{...helpers,assertJobAskSource,jobCheckpointContext},draftStorage:()=>localStorage,...drafts,access,pageId,
        window:{state:()=>window.state(),submit:input=>window.submit(input)}};
    const rigScreen=createJobRigScreen({host,pageId,access,translate:t,refusal:jobWindowRefusal,formDependencies:dependencies,
        window:{state:()=>window.state(),submit:input=>window.submit(input)},readPublication:(id,signal)=>transport.readPublication(id,signal),
        routes:display=>jobPublicationRoutes(display,location.origin),load:()=>import('./main.ts')});
    let bootstrapNotice:HTMLElement|null=null;
    const report=(error:unknown,fallback?:string)=>{if(rigScreen.mounted()){rigScreen.report(error,fallback);return;}if(!bootstrapNotice){bootstrapNotice=node('p');bootstrapNotice.setAttribute('role','status');host.append(bootstrapNotice);}bootstrapNotice.textContent=jobWindowRefusal(error,fallback);};
    const window=createJobWindow<JobRigScreenPrepared|null>({jobId:access.jobId,pageId,transport,adapter:{
        async prepare(display,signal){if(rigScreen.mounted()){location.reload();return new Promise<never>(()=>{});}return rigScreen.prepare(display,signal);},
        captureDraft(){drafts.saveDraft();const forms=rigScreen.mounted()?.record?.forms;const dirty=forms?[...forms].filter(([,entry])=>entry.dirty):[];return dirty.length?dirty.map(([askId,entry])=>({askId,value:entry.read()})):null;},
        commit:prepared=>prepared?rigScreen.commit(prepared):{rollback(){},finalize(){}},
        async painted(prepared,signal){if(prepared)await rigScreen.painted(prepared,signal);else{if(stopped||fallingBack||signal.aborted)return;fallingBack=true;abort.abort();window.stop();await events?.done;if(!stopped){const dispose=await mountJobSession(host,true,access);if(stopped)dispose();else legacyStop=dispose;}}},
        discard:prepared=>{for(const entry of prepared?.record?.forms.values()??[])entry.dispose?.();prepared?.record?.inspection.dispose();},
        changed(state){rigScreen.changed(state);if(state.error)report(state.error);if(state.receipt&&!state.preparing)events?.displayed();},
    }});
    const hub=new URL(location.href).searchParams.get('hub');
    const binding=()=>({jobId:access.jobId,incarnation:hub!,publicationId:window.state().displayed?.publication.publicationId??null,sourceHash:window.state().displayed?.publication.source.sourceHash??null});
    const visibility=(event:MessageEvent)=>{if(!hub||!jobHubMessageMatches(event,location.origin,globalThis.parent,binding(),'visibility'))return;events?.visibility(event.data.visible);i18n.setLinkLanguage(null);i18n.setLanguagePreference(event.data.language);};
    if(hub)globalThis.addEventListener('message',visibility);
    const localize=i18n.onLanguageChange(()=>{for(const element of host.querySelectorAll<HTMLElement>('[data-job-text]'))element.textContent=t(element.dataset.jobText!);for(const form of host.querySelectorAll('form.interview-answer'))form.dispatchEvent(new Event('job-form-language'));});
    events=startJobWindowEvents({access,signal:abort.signal,member:!!hub,event:event=>{window.event(event);if(hub)globalThis.parent.postMessage({...binding(),schema:JOB_HUB_READY},location.origin);},refused:error=>report(error,'JOB_STREAM_FAILED')});
    const stop=()=>{if(stopped)return;stopped=true;drafts.saveDraft();abort.abort();window.stop();for(const entry of rigScreen.mounted()?.record?.forms.values()??[])entry.dispose?.();rigScreen.mounted()?.record?.inspection.dispose();localize();legacyStop?.();globalThis.removeEventListener('message',visibility);globalThis.removeEventListener('pagehide',stop);};
    globalThis.addEventListener('pagehide',stop,{once:true});return stop;
}

/** Browser mount is explicit so importing transaction helpers never starts an app. */
/** `inherited` keeps the capability the one-screen mount already took off the URL (it may live only in memory). */
export async function mountJobSession(host: HTMLElement, legacy=false, inherited?: JobWindowAccess): Promise<() => void> {
    if(!legacy)return mountJobScreen(host);
    const [{ createViewportController, createViewportState }, { createRigViewportProvider }, { mountViewportPair }, { RigOverlays }, { bindLayerShortcuts, describeLayerToggles, createRigLayerControls }, i18n] = await Promise.all([
        import('./viewport-controller.ts'), import('./rig-viewport-provider.ts'),
        import('./viewport-pair.ts'), import('./rig-overlays.ts'), import('./view-controls.ts'), import('./i18n.ts'),
    ]);
    let storage: Storage | null = null;
    try {
        storage = sessionStorage;
    }
    catch { /* Capability stays in memory. */ }
    const access = inherited ?? jobWindowAccess(location.href, storage, href => history.replaceState(history.state, '', href));
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
    const formHelpers = prepareJobForms.helpers(node, t);
    const {inputLabel, selectValues, imageGallery, planTextList} = formHelpers;
    const shell = mountWorkspaceShell({compatibility: 'legacyJobStep5', title: t('job.title')});
    const {header, title} = shell, languages = shell.language!;
    languages.value = i18n.getLanguage();
    languages.setAttribute('aria-label', t('interview.language'));
    languages.onchange = () => { i18n.setLinkLanguage(null); i18n.setLanguagePreference(languages.value === 'ko' ? 'ko' : 'en'); };
    const notice = node('p', 'job.waiting');
    notice.className = 'job-notice';
    notice.setAttribute('role', 'status');
    const workspace = node('main');
    host.classList.add('job-window');
    host.replaceChildren(header, notice, workspace);
    let current: JobPreparedInspection | null = null;
    let currentElement: HTMLElement | null = null;
    type SavedCameraState = Pick<
        ReturnType<typeof createViewportState>,
        'cameraSync' | 'activeCamera' | 'zoom' | 'cameraCenter' | 'referenceZoom' | 'referenceCenter'
    >;
    type SavedJobWindowState = {
        publicationId: string;
        label: string;
        sourceHash: string;
        previousLabel: string | null;
        compatibilityNotice?: boolean;
        animation?: string;
        time?: number;
        loop?: boolean;
        selectedPart?: string;
        partMode?: 'context' | 'solo';
        selectedReference?: string;
        panel?: string;
        partIdentity?: unknown;
        camera?: unknown;
    };
    const parseSavedPoint = (raw: unknown): { x: number; y: number } | null | undefined => {
        if (raw === null) return null;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
        const point = raw as Record<string, unknown>;
        return typeof point.x === 'number' && Number.isFinite(point.x) &&
            typeof point.y === 'number' && Number.isFinite(point.y)
            ? { x: point.x, y: point.y }
            : undefined;
    };
    const parseSavedCamera = (raw: unknown): SavedCameraState | null => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const value = raw as Record<string, unknown>;
        const cameraCenter = parseSavedPoint(value.cameraCenter);
        const referenceCenter = parseSavedPoint(value.referenceCenter);
        if (typeof value.cameraSync !== 'boolean' ||
            (value.activeCamera !== 'rig' && value.activeCamera !== 'reference') ||
            typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom < 0.25 || value.zoom > 8 ||
            typeof value.referenceZoom !== 'number' || !Number.isFinite(value.referenceZoom) || value.referenceZoom < 0.25 || value.referenceZoom > 8 ||
            cameraCenter === undefined || referenceCenter === undefined) {
            return null;
        }
        return {
            cameraSync: value.cameraSync,
            activeCamera: value.activeCamera,
            zoom: value.zoom,
            cameraCenter,
            referenceZoom: value.referenceZoom,
            referenceCenter,
        };
    };
    const parseSavedPartIdentity = (raw: unknown): ControlPart | null => {
        try {
            return parseControlPart(raw);
        }
        catch {
            return null;
        }
    };
    const parseSavedDraftRecord = (raw: unknown): JobRetainedDraft | null => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const draft = raw as Record<string, unknown>;
        if (!Array.isArray(draft.forms) || !draft.forms.length ||
            typeof draft.publicationId !== 'string' || !draft.publicationId ||
            typeof draft.sourceHash !== 'string' || !draft.sourceHash ||
            typeof draft.label !== 'string' || !draft.label ||
            !draft.source || typeof draft.source !== 'object' || Array.isArray(draft.source) ||
            (draft.source as { sourceHash?: unknown }).sourceHash !== draft.sourceHash) {
            return null;
        }
        const forms = draft.forms.filter((item: unknown): item is { askId: string; value: unknown } =>
            !!item && typeof item === 'object' && !Array.isArray(item) &&
            typeof (item as { askId?: unknown }).askId === 'string' && !!(item as { askId: string }).askId);
        if (!forms.length) return null;
        return {
            publicationId: draft.publicationId,
            sourceHash: draft.sourceHash,
            source: draft.source as SourceV3,
            label: draft.label,
            value: forms.map(item => ({ askId: item.askId, value: item.value })),
        };
    };
    const localWindowKey = 'rig-review-job-window/1:' + access.jobId;
    let savedWindow: SavedJobWindowState | null = null;
    try {
        const parsed = JSON.parse(localStorage.getItem(localWindowKey) ?? 'null');
        if (parsed && typeof parsed.publicationId === 'string' && typeof parsed.label === 'string' &&
            typeof parsed.sourceHash === 'string') {
            savedWindow = parsed as SavedJobWindowState;
        }
    }
    catch { /* Invalid saved window state falls back to defaults. */ }
    const initialRetainedDrafts: JobRetainedDraft[] = [];
    try {
        const draftPrefix = 'rig-review-job-draft/1:' + access.jobId + ':';
        for (let index = 0; index < localStorage.length; index++) {
            const key = localStorage.key(index);
            if (!key?.startsWith(draftPrefix)) continue;
            try {
                const parsedDraft = parseSavedDraftRecord(JSON.parse(localStorage.getItem(key) ?? 'null'));
                if (parsedDraft) initialRetainedDrafts.push(parsedDraft);
            }
            catch { /* Ignore malformed draft entries without dropping sibling drafts. */ }
        }
    }
    catch { /* In-memory standing state remains active when storage is unavailable. */ }
    const previousDisplayed = savedWindow ? {
        publicationId: savedWindow.publicationId,
        label: savedWindow.label,
        previousLabel: typeof savedWindow.previousLabel === 'string' ? savedWindow.previousLabel : null,
    } : null;
    let animation = typeof savedWindow?.animation === 'string' ? savedWindow.animation : '';
    let time = typeof savedWindow?.time === 'number' && Number.isFinite(savedWindow.time) && savedWindow.time >= 0
        ? savedWindow.time : 0;
    let playing = false;
    let loop = typeof savedWindow?.loop === 'boolean' ? savedWindow.loop : true;
    let playbackCarry = 0;
    let rafHandle = 0;
    let lastFrameTime = 0;
    let inPlaybackStep = false;
    let lastRunningSaveMs: number | null = null;
    let lastSavedWindowJson: string | null = null;
    let selectedPart = typeof savedWindow?.selectedPart === 'string' ? savedWindow.selectedPart : '';
    let partMode: 'context' | 'solo' = savedWindow?.partMode === 'solo' ? 'solo' : 'context';
    let selectedReference = typeof savedWindow?.selectedReference === 'string' ? savedWindow.selectedReference : '';
    let panel = typeof savedWindow?.panel === 'string' && ['1', '2', '3', '4'].includes(savedWindow.panel)
        ? savedWindow.panel : '3';
    let restoredPartIdentity: ControlPart | null = parseSavedPartIdentity(savedWindow?.partIdentity);
    let restoredCamera: SavedCameraState | null = parseSavedCamera(savedWindow?.camera);
    let compatibilityNotice = Boolean(savedWindow?.compatibilityNotice);
    type PreparedWindow = JobPreparedInspection & {
        element: HTMLElement;
        forms: Map<string, JobForm>;
    };
    const forms = new Map<string, JobForm>();
    const drawn = new WeakMap<JobPreparedInspection, JobRigDraw>();
    const overlays = new WeakMap<JobPreparedInspection, InstanceType<typeof RigOverlays>>();
    const layers = { images: true, mesh: false, bones: false, meshOpacity: 0.65 };
    let stageBackground = '';
    let drawGeneration = 0;
    const viewportState = createViewportState();
    if (restoredCamera) {
        Object.assign(viewportState, restoredCamera, { cameraRestoring: false });
    }
    function saveWindowState(nowMs?: number): void {
        if (!current)
            return;
        if (inPlaybackStep && nowMs === undefined)
            return;
        const state = window.state();
        if (state.displayed?.publication.publicationId !== current.display.publication.publicationId)
            return;
        if (nowMs !== undefined) {
            if (lastRunningSaveMs === null) {
                lastRunningSaveMs = nowMs;
                return;
            }
            if (nowMs - lastRunningSaveMs < 1000)
                return;
            lastRunningSaveMs = nowMs;
        }
        try {
            const serialized = JSON.stringify({
                publicationId: current.display.publication.publicationId,
                label: current.display.publication.label,
                sourceHash: current.display.publication.source.sourceHash,
                previousLabel: state.previousLabel,
                compatibilityNotice,
                animation,
                time,
                loop,
                selectedPart,
                partMode,
                selectedReference,
                panel,
                partIdentity: current.inspection?.value() ?? null,
                camera: {
                    cameraSync: viewportState.cameraSync,
                    activeCamera: viewportState.activeCamera,
                    zoom: viewportState.zoom,
                    cameraCenter: viewportState.cameraCenter
                        ? { x: viewportState.cameraCenter.x, y: viewportState.cameraCenter.y } : null,
                    referenceZoom: viewportState.referenceZoom,
                    referenceCenter: viewportState.referenceCenter
                        ? { x: viewportState.referenceCenter.x, y: viewportState.referenceCenter.y } : null,
                },
            });
            if (serialized === lastSavedWindowJson)
                return;
            localStorage.setItem(localWindowKey, serialized);
            lastSavedWindowJson = serialized;
        }
        catch { /* Standing state stays in memory when storage is unavailable. */ }
    }
    const el = <Element extends HTMLElement = HTMLElement>(id: string): Element => {
        const element = workspace.querySelector<HTMLElement>('#' + id);
        if (!element)
            throw new Error('JOB_WINDOW_ELEMENT_MISSING');
        return element as Element;
    };
    const reference = () => current?.references.find(item => item.id === selectedReference) ?? null;
    const setText = (id: string, value: string) => { const element = workspace.querySelector('#' + id); if (element)
        element.textContent = i18n.tr(value); };
    function redrawOverlay(fresh: boolean): void {
        const owner = current, overlay = owner ? overlays.get(owner) : undefined;
        if (!owner || !overlay) return;
        const root = owner.rigRoot, scale = viewportState.rigScale;
        const left = parseFloat(root.style.left) || 0, top = parseFloat(root.style.top) || 0;
        const project = (x: number, y: number) => ({ x: left + x * scale, y: top - y * scale });
        const bones = (owner.metadata.feedbackCatalog.bones ?? []).map(name => ({ name }));
        const frame = owner.inspection?.frame('single');
        const selectedSlot = selectedPart || null;
        const snap = fresh
            ? overlay.refresh({ player: owner.player, bones, frame, selectedSlot, project, settings: layers })
            : overlay.redraw({ project, settings: layers });
        if (!fresh && snap.needsCapture && owner.player) {
            overlay.refresh({ player: owner.player, bones, frame, selectedSlot, project, settings: layers });
        }
    }
    const provider = createRigViewportProvider({
        el, player: () => current?.player ?? null, assets: () => current?.assets ?? null,
        referenceSize: () => reference(), view: () => 'compare', referenceGeneration: () => current?.display.publication.generation ?? 0,
        parts: () => current?.inspection ?? null, text: setText,
        message: value => { notice.textContent = jobWindowRefusal(value); }, redrawOverlay: fresh => redrawOverlay(fresh),
    }, viewportState);
    const canonicalControls = provider.renderControls;
    provider.renderControls = controller => {
        canonicalControls(controller);
        const fit = el('fit');
        fit.textContent = t(fit.textContent ?? 'Fit');
        saveWindowState();
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
        return jobRigDrawState({pane: el('rig-viewport'), paneHidden: el('rig-pane').hidden, root: owner.rigRoot, player,
            presentation: owner.rigPresentation, frameGeneration: owner.inspection?.frame('single')?.generation,
            camera: viewport.numericView().cameras.rig, frame: viewport.paneFrame('rig'),
            source: {pageId, publicationId: owner.display.publication.publicationId,
                instanceKey: owner.display.publication.instanceKey, sourceHash: owner.display.publication.source.sourceHash},
            wholeRig: !selectedPart && !owner.inspection?.value() && player.slots === null &&
                layers.images && !layers.mesh && !layers.bones && !stageBackground,
            playing});
    }
    function rememberDraw(): void {
        const owner = current;
        if (!owner) return;
        try {
            const pane = el('rig-viewport');
            const bg = SENTINELS[stageBackground] ?? '';
            pane.style.backgroundColor = bg;
            pane.style.backgroundImage = bg ? 'none' : '';
            if (!layers.images || layers.mesh || layers.bones || bg) {
                drawn.delete(owner);
                owner.rigPresentation = undefined;
                delete pane.dataset.jobRigCanonical;
                owner.rigRoot.style.visibility = layers.images ? 'visible' : 'hidden';
                return;
            }
            owner.rigRoot.style.visibility = '';
            const player = owner.player;
            const posed = owner.inspection?.frame('single');
            const camera = viewport.numericView().cameras.rig;
            if (!hubVisible || !player || !owner.assets || !posed || !camera) {
                throw new Error('JOB_STILL_CAPTURE_FAILED');
            }
            const presentation = presentJobRigStage({pane, root: owner.rigRoot, player, camera, posed, assets: owner.assets});
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
        if (owner === current) redrawOverlay(true);
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
        lastRunningSaveMs = null;
        targetPlayer?.pause();
        syncTransportControls();
        saveWindowState();
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
    function playbackTimeLabel(duration: number, trackTime: number): string {
        // A one-second 1/60 replay leaves six epsilons after modulo. Limit display snapping
        // to eight duration-scaled epsilons. The public time and captured frame stay raw.
        if (trackTime < duration) return String(time);
        const residue = 8 * Number.EPSILON * duration;
        if (time <= residue) return '0';
        if (duration - time <= residue) return String(duration);
        return String(time);
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
        if (clock) clock.value = playbackTimeLabel(clip.duration, activeEntry.trackTime);
        inPlaybackStep = true;
        try {
            syncTransportControls();
            presentCurrentFrame(expectedOwner);
        }
        finally {
            inPlaybackStep = false;
        }
        if (playing) {
            saveWindowState(now);
        } else {
            lastRunningSaveMs = null;
            saveWindowState();
        }
        if (playing && current === expectedOwner && current.player === expectedPlayer && hubVisible) {
            armPlayback(expectedOwner, expectedPlayer);
        }
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
    const {localDraftKey,saveDraft}=prepareJobForms.drafts({jobId:access.jobId,current:()=>current,forms:()=>forms,storage:()=>localStorage});
    function updateForms(state: JobWindowState): void {
        if (!current)
            return;
        const host = workspace.querySelector<HTMLElement>('[data-job-forms]');
        if (!host)
            return;
        for(const ask of state.pending){
            if(ask.publicationId!==current.display.publication.publicationId||ask.subject.kind==='parts-verdict'||ask.subject.kind==='interview-picks')continue;
            let entry=forms.get(ask.askId);
            if(!entry&&ask.status==='pending'){
                try{entry=prepareJobForms.formFor(ask,current,formDependencies);forms.set(ask.askId,entry);host.append(entry.form);}
                catch(error){const refusal=node('p');refusal.textContent=jobWindowRefusal(error,'JOB_ASK_INVALID');host.append(refusal);}
            }
            if(entry)entry.fieldset.disabled=entry.submitting||ask.status!=='pending'||state.preparing||state.closed||!state.receipt||!access.capability;
        }
        const hasCheckpointAsk = Boolean(current.player) && state.pending.some(
            ask => ask.publicationId === current!.display.publication.publicationId &&
                ask.status === 'pending' && ask.subject.kind === 'checkpoint',
        );
        const layerSet = workspace.querySelector<HTMLElement>('#layer-controls');
        const bgField = workspace.querySelector<HTMLElement>('#job-background-field');
        const bgSelect = workspace.querySelector<HTMLSelectElement>('#job-background');
        const hadNonDefaultView = !layers.images || layers.mesh || layers.bones || Boolean(stageBackground);
        if (!hasCheckpointAsk && hadNonDefaultView) {
            layers.images = true;
            layers.mesh = false;
            layers.bones = false;
            stageBackground = '';
        }
        if (layerSet) {
            layerSet.hidden = !hasCheckpointAsk;
            for (const [id, key] of [['layer-images', 'images'], ['layer-mesh', 'mesh'], ['layer-bones', 'bones']] as const) {
                const box = layerSet.querySelector<HTMLInputElement>('#' + id);
                if (box) {
                    box.disabled = !hasCheckpointAsk;
                    box.checked = layers[key];
                }
            }
            describeLayerToggles({ getElementById: id => layerSet.querySelector('#' + id) }, t('No rig supplied'));
            for (const label of layerSet.querySelectorAll<HTMLElement>('.layer-toggle')) label.title = i18n.tr(label.title);
        }
        if (bgField && bgSelect) {
            bgField.hidden = !hasCheckpointAsk;
            bgSelect.disabled = !hasCheckpointAsk;
            bgSelect.value = stageBackground;
        }
        if (!hasCheckpointAsk && hadNonDefaultView) {
            redrawOverlay(true);
            rememberDraw();
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
        parts.disabled = !prepared.metadata.manifest?.model || prepared.metadata.feedbackCatalog.slots === null;
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
        const stage = node('section');
        stage.className = 'job-stage';
        const controls = node('div');
        controls.className = 'viewbar';
        const layerSet = createRigLayerControls({jobText: true, translate: t});
        layerSet.hidden = true;
        for (const keyName of ['images', 'mesh', 'bones'] as const) {
            const box = layerSet.querySelector<HTMLInputElement>('#layer-' + keyName)!;
            box.checked = layers[keyName];
            box.disabled = true;
            box.onchange = () => {
                layers[keyName] = box.checked;
                if (current === prepared) {
                    redrawOverlay(true);
                    rememberDraw();
                }
            };
        }
        describeLayerToggles({ getElementById: id => layerSet.querySelector('#' + id) }, t('No rig supplied'));
        for (const label of layerSet.querySelectorAll<HTMLElement>('.layer-toggle')) label.title = i18n.tr(label.title);
        const sentinelKeys = Object.keys(SENTINELS);
        const bgSelect = selectValues(['', ...sentinelKeys], ['Rig', ...sentinelKeys.map(k => k[0]!.toUpperCase() + k.slice(1))]);
        bgSelect.id = 'job-background';
        bgSelect.value = stageBackground;
        bgSelect.disabled = true;
        bgSelect.onchange = () => {
            stageBackground = Object.hasOwn(SENTINELS, bgSelect.value) ? bgSelect.value : '';
            bgSelect.value = stageBackground;
            if (current === prepared) {
                redrawOverlay(false);
                rememberDraw();
            }
        };
        const bgField = inputLabel('Background', bgSelect);
        bgField.id = 'job-background-field';
        bgField.hidden = true;
        controls.append(layerSet, bgField);
        const viewControls = createViewControls({layout:'legacyCompiledJobStep5', inputLabel});
        controls.append(...viewControls.zoomButtons, viewControls.syncLabel, viewControls.value);
        const pair = node('div');
        pair.id = 'stage-layout';
        mountViewportPair(pair);
        for (const id of ['idle-handles', 'rig-fields-stage'])
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
        const rigViewport = pair.querySelector<HTMLElement>('#rig-viewport');
        if (rigViewport) {
            rigViewport.setAttribute('tabindex', '-1');
            rigViewport.addEventListener('pointerdown', () => rigViewport.focus?.());
        }
        pair.querySelector('#rig-root')!.replaceWith(prepared.rigRoot);
        const overlayCanvas = pair.querySelector<HTMLCanvasElement>('#rig-overlay');
        if (overlayCanvas) {
            overlayCanvas.setAttribute('aria-label', t('Actual rig mesh and bone overlay'));
            const instance = new RigOverlays({ canvas: overlayCanvas, rigRoot: prepared.rigRoot });
            overlays.set(prepared, instance);
            const prevDispose = prepared.dispose;
            prepared.dispose = () => { try { instance.dispose(); } finally { prevDispose(); } };
        }
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
            lastRunningSaveMs = null;
            const clockInput = workspace.querySelector<HTMLInputElement>('#job-time');
            if (clockInput) clockInput.value = playbackTimeLabel(clip.duration, current.player.time);
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
                if (clockInput) clockInput.value = playbackTimeLabel(clip.duration, activeEntry.trackTime);
                if (!playing) current.player.pause();
                syncTransportControls();
                presentCurrentFrame(current);
                saveWindowState();
                if (playing && hubVisible) armPlayback(current, current.player);
            } else {
                syncTransportControls();
                saveWindowState();
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
        transport.append(clips, playButton, inputLabel('Repeat', loopInput), inputLabel('job.time', clock));
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
            const gallery = imageGallery(source.imageSet.images.map((image, index) => ({...image,
                element: prepared.imageSetImages?.[index],
                duplicate: source.duplicateHashes.some(group => group.names.includes(image.name))})));
            gallery.dataset.jobImageSet = '';
            stage.prepend(heading, digest, gallery);
            controls.hidden = pair.hidden = transport.hidden = true;
            controls.style.display = pair.style.display = transport.style.display = 'none';
            for (const child of sidebar.children) {
                if (child instanceof HTMLElement && child !== identity && child !== binding) child.hidden = true;
            }
        }
        else if (source.subject === 'option-set' || source.subject === 'plan') {
            const summary = node('section');
            summary.dataset.jobRecord = source.subject;
            const recordLine = node('p');
            recordLine.className = 'job-source';
            recordLine.textContent = source.record.path + ' · ' + source.record.sha256;
            summary.append(recordLine);
            if (source.subject === 'option-set') {
                const optionLine = node('p');
                optionLine.className = 'job-source';
                optionLine.textContent = source.selection.questionId + ' · ' + source.optionSet.id + ' · ' + source.optionSetFile.path + ' · ' + source.optionSet.sha256;
                summary.append(optionLine);
            }
            else {
                root.dataset.jobPlanWorkspace = '';
                summary.append(identity, binding, planTextList(source.plan, prepared.metadata.planText));
            }
            stage.prepend(summary);
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
        const interviewDiagnostics = node('section');
        interviewDiagnostics.className = 'job-interview-diagnostics';
        interviewDiagnostics.dataset.jobInterviewDiagnostics = '';
        const interviewState = prepared.interview?.interview ?? prepared.display.publication.interview ?? null;
        if (interviewState && (interviewState.diagnostics.length > 0 || interviewState.records.some(record => record.timeKind !== 'inspection'))) {
            interviewDiagnostics.append(node('h3', 'interview.history'));
            for (const diagnostic of interviewState.diagnostics) {
                const item = node('div');
                item.dataset.jobInterviewDiagnostic = diagnostic.code;
                item.dataset.severity = diagnostic.severity;
                item.dataset.record = diagnostic.record;
                const summary = node('p', diagnostic.code);
                const detail = node('pre');
                detail.className = 'job-source';
                detail.textContent = JSON.stringify(diagnostic, null, 2);
                item.append(summary, detail);
                interviewDiagnostics.append(item);
            }
            for (const record of interviewState.records) {
                if (record.timeKind === 'inspection') continue;
                const item = node('div');
                item.dataset.jobInterviewRecord = record.record;
                item.dataset.timeKind = record.timeKind;
                const detail = node('pre');
                detail.className = 'job-source';
                detail.textContent = JSON.stringify(record, null, 2);
                item.append(detail);
                interviewDiagnostics.append(item);
            }
        }
        else {
            interviewDiagnostics.hidden = true;
        }
        const history = node('div');
        history.className = 'job-history';
        history.dataset.jobHistory = '';
        formsHost.append(direction, interviewDiagnostics, history);
        root.append(sidebar, stage, formsHost);
        return root;
    }
    function selectPart(): void {
        if (!current?.inspection)
            return;
        drawn.delete(current);
        current.rigPresentation = undefined;
        current.inspection.select(selectedPart ? { side: 'single', slot: selectedPart, mode: partMode } : null);
        redrawOverlay(true);
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
        if (direction) direction.hidden = !current?.metadata.direction;
        saveWindowState();
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
                const seekAtLoopEnd = loop && time === clip?.duration;
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
                clock.value = seekAtLoopEnd ? '0' : String(time);
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
    // #709: a rig publication opens the one review screen; the job window keeps every other subject.
    const formDependencies: JobFormDependencies = {
        node, translate: t, helpers: {...formHelpers, assertJobAskSource, jobCheckpointContext},
        draftStorage: () => localStorage, localDraftKey, saveDraft, access, pageId,
        window: {state: () => window.state(), submit: input => window.submit(input)},
    };
    const rigScreen = createJobRigScreen({host, pageId, access, translate: t, refusal: jobWindowRefusal, legacyRecords:true,
        window: {state: () => window.state(), submit: input => window.submit(input)},
        routes: display => jobPublicationRoutes(display, location.origin), load: () => import('./main.ts')});
    const window = createJobWindow({ jobId: access.jobId, pageId, transport,
        previousDisplayed, initialRetainedDrafts,
        adapter: {
            async prepare(display, signal): Promise<PreparedWindow | JobRigScreenPrepared> {
                // The rig composition cannot be unmounted in place: another publication reopens the page on its route.
                if (rigScreen.mounted()) { location.reload(); return new Promise<never>(() => {}); }
                const rig = await rigScreen.prepare(display, signal);
                if (rig && current) { location.reload(); return new Promise<never>(() => {}); }
                if (rig) return rig;
                const inspection = await prepareJobInspection(display, signal);
                try {
                    const element = build(inspection);
                    const asks = window.state().pending;
                    const preparedForms = prepareJobForms(display, asks, ask => prepareJobForms.formFor(ask, inspection, formDependencies));
                    return Object.assign(inspection, { element, forms: preparedForms });
                }
                catch (error) {
                    inspection.dispose();
                    throw error;
                }
            },
            captureDraft() { if (rigScreen.mounted()) return null; saveDraft(); const dirty = [...forms].filter(([, item]) => item.dirty); return dirty.length ? dirty.map(([askId, item]) => ({ askId, value: item.read() })) : null; },
            commit(prepared, display) {
                if (isJobRigScreen(prepared)) { unbindLayerShortcuts(); return rigScreen.commit(prepared); }
                // Pending asks can arrive while assets load. Finish their forms before the visible replacement.
                const asks = window.state().pending;
                const nextForms = prepareJobForms(display, asks,
                    ask => prepared.forms.get(ask.askId) ?? prepareJobForms.formFor(ask, prepared, formDependencies));
                const root = prepared.element;
                const formHost = root.querySelector<HTMLElement>('[data-job-forms]');
                if (!formHost) throw new Error('JOB_WINDOW_ELEMENT_MISSING');
                for (const entry of nextForms.values()) formHost.append(entry.form);
                referenceSelection.cancel();
                const previous = current;
                stopPlayback(previous?.player);
                const previousElement = currentElement;
                const previousForms = new Map(forms);
                const restoringCamera = Boolean(previous || restoredCamera);
                const navigation = { animation, time, loop, selectedPart, partMode, selectedReference, panel,
                    layers: { images: layers.images, mesh: layers.mesh, bones: layers.bones }, stageBackground,
                    partIdentity: previous ? (previous.inspection?.value() ?? null) : restoredPartIdentity,
                    camera: structuredClone(viewportState) };
                compatibilityNotice = Boolean(!previous &&
                    savedWindow?.publicationId === display.publication.publicationId &&
                    savedWindow.compatibilityNotice);
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
                    loop = navigation.loop;
                    selectedPart = navigation.selectedPart;
                    partMode = navigation.partMode;
                    selectedReference = navigation.selectedReference;
                    panel = navigation.panel;
                    Object.assign(layers, navigation.layers);
                    stageBackground = navigation.stageBackground;
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
                    el<HTMLInputElement>('job-loop').checked = loop;
                    layers.images = true;
                    layers.mesh = false;
                    layers.bones = false;
                    stageBackground = '';
                    for (const [id, key] of [['layer-images', 'images'], ['layer-mesh', 'mesh'], ['layer-bones', 'bones']] as const) {
                        el<HTMLInputElement>(id).checked = layers[key];
                    }
                    el('rig-empty').hidden = !!prepared.player;
                    Object.assign(viewportState, navigation.camera, { cameraRestoring: restoringCamera });
                    showReference();
                    pose(false);
                    if (selectedPart) {
                        try {
                            if (!navigation.partIdentity || navigation.partIdentity.slot !== selectedPart) {
                                throw new Error('PART_IDENTITY_UNAVAILABLE');
                            }
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
                            restoredPartIdentity = null;
                            restoredCamera = null;
                            savedWindow = null;
                            unbindNavigation?.();
                            resize?.disconnect();
                            unbindNavigation = nextUnbind;
                            resize = nextResize;
                            previous?.dispose();
                            title.textContent = display.publication.source.package?.id ?? display.publication.label;
                        },
                    };
                }
                catch (error) {
                    rollback();
                    throw error;
                }
            },
            async painted(prepared, signal) {
                if (isJobRigScreen(prepared)) return rigScreen.painted(prepared, signal);
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
            discard(prepared) { if (!isJobRigScreen(prepared)) prepared.dispose(); },
            changed(state) {
                if (rigScreen.mounted()) {
                    rigScreen.changed(state); announceHubFrame();
                    if (state.receipt && !state.preparing) events?.displayed();
                    return;
                }
                notice.dataset.failed = String(!!state.error);
                if (state.error)
                    notice.textContent = state.displayed && state.error !== 'JOB_WINDOW_CLEANUP_FAILED'
                        ? t('job.failed') + ' · ' + jobWindowRefusal(state.error) : jobWindowRefusal(state.error);
                else if (state.closed)
                    notice.textContent = t('job.closed');
                else if (state.preparing)
                    notice.textContent = t('job.preparing');
                else if (state.displayed) {
                    delete notice.dataset.jobPartsState;
                    notice.textContent = state.previousLabel
                        ? t('job.updated', [state.previousLabel, state.displayed.publication.label]) : state.displayed.publication.label;
                    if (compatibilityNotice)
                        notice.textContent += ' · ' + t('job.incompatible');
                }
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
                            try {
                                const parsedDraft = parseSavedDraftRecord(JSON.parse(localStorage.getItem(key) ?? 'null'));
                                if (!parsedDraft || parsedDraft.publicationId === state.displayed?.publication.publicationId)
                                    continue;
                                retained.set(parsedDraft.publicationId, parsedDraft);
                            }
                            catch { /* Ignore malformed draft entries without dropping sibling drafts. */ }
                        }
                    }
                    catch { /* In-memory retained evidence remains available. */ }
                    history.textContent = [...retained.values()].map(draft => t('job.retained', [draft.label]) + '\n' + draft.sourceHash + '\n' + JSON.stringify(draft.value, null, 2)).join('\n');
                }
                saveWindowState();
                pauseHiddenHubFrame(); announceHubFrame();
                if (state.receipt && !state.preparing) events?.displayed();
            },
        } });
    const unbindLayerShortcuts = bindLayerShortcuts(document);
    const localize = i18n.onLanguageChange(() => {
        for (const element of host.querySelectorAll<HTMLElement>('[data-job-text]'))
            element.textContent = t(element.dataset.jobText!);
        languages.setAttribute('aria-label', t('interview.language'));
        if (current) {
            workspace.querySelector('#rig-overlay')?.setAttribute('aria-label', t('Actual rig mesh and bone overlay'));
            describeLayerToggles({ getElementById: id => workspace.querySelector('#' + id) }, t('No rig supplied'));
            for (const label of workspace.querySelectorAll<HTMLElement>('.layer-toggle')) label.title = i18n.tr(label.title);
            viewport.renderCameraControls();
        }
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
        saveWindowState();
        referenceSelection.cancel();
        abort.abort();
        window.stop();
        localize();
        unbindLayerShortcuts();
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
