import {checkpointEvidencePair} from '../src/checkpoint-evidence-packet.ts';
/** Live job window transactions. Every form remains bound to its displayed publication. */
import type {
    ActV3,
    DisplayPublicationV3,
    EventV3,
    JobDisplayReceipt,
    JobCheckpointEvidence,
    JobCheckpointTable,
    JobInterviewDiagnostics,
    JobProgressLineV3,
    JobProgressV3,
    JobResult,
    PendingAskV3,
    JobPanelComposition,
    PanelComponent,
    PanelSlot,
    PublicationV3,
    RecordSource,
    SourceV3,
    UISubmissionV3,
} from '../src/job-contract.ts';
import {enCatalog} from './catalog-en.ts';
import {koCatalog} from './catalog-ko.ts';
import {t,onLanguageChange} from './i18n.ts';
import {hashCapabilityAccess, type InstanceAccess} from './instance-access.ts';
import {JOB_PLAN_TEXT_FIELDS, parseJobPlanTextProjection, type JobPlanTextProjection} from '../src/job-contract.ts';
import {createJobRigScreen, type JobRigScreenPrepared} from './job-rig-screen.ts';
import {labelledControl} from './view-controls.ts';
import {JOB_ACT_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_ENABLED_ACT_KINDS, JOB_PANEL_COMPOSITION_SCHEMA, JOB_RECORD_ACT_SCHEMA, parsePanelComposition} from '../src/job-contract.ts';

/** Imported runtimes may throw arbitrary prose. Only registered refusal copy reaches the window. */
export function jobWindowRefusal(error: unknown, fallback = 'JOB_WINDOW_FAILED'): string {
    const message = error instanceof Error ? error.message : error;
    if (typeof message === 'string' &&
        Object.hasOwn(enCatalog, message) && Object.hasOwn(koCatalog, message)) {
        return t(message);
    }
    console.error('[job-window]', fallback, error);
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
    readonly failure?: unknown;
    readonly previousLabel: string | null;
    readonly pending: readonly JobWindowAsk[];
    readonly recordReceiptAskId?: string;
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
function isRecordAnswer(kind: string): boolean {
    return kind === 'signoff' || kind === 'checkpoint';
}
export function isPendingOwnerAsk(ask: PendingAskV3): boolean {
    return ask.status === 'pending' && ask.subject.kind !== 'signoff' && ask.subject.kind !== 'checkpoint' &&
        ask.subject.kind !== 'interview-picks' && JOB_ENABLED_ACT_KINDS.some(kind => kind === ask.subject.kind);
}
/** Match the finalized envelope to the displayed ask. Record acts omit the display-only direction summary. */
export function matchesJobRecordAct(ask: PendingAskV3, act: ActV3 | undefined, jobId: string | undefined, submission?: UISubmissionV3): boolean {
    if (!act || !jobId || act.jobId !== jobId || act.askId !== ask.askId || act.publicationId !== ask.publicationId ||
        typeof act.actId !== 'string' || !act.actId || !Number.isFinite(Date.parse(act.at)) ||
        act.authority?.actor !== 'human' || act.authority.channel !== 'review-ui' || !act.source || !act.value) return false;
    const reviewer = act.authority.reviewer;
    if (typeof reviewer?.id !== 'string' || !reviewer.id || (reviewer.role !== 'owner' && reviewer.role !== 'delegate')) return false;
    const source = ask.source;
    if (source.subject === 'plan') {
        const {directionReview: _summary, ...binding} = source;
        if (act.schema !== JOB_RECORD_ACT_SCHEMA || sourceSnapshot(act.source) !== sourceSnapshot(binding)) return false;
    } else if ((act.schema !== JOB_ACT_SCHEMA && act.schema !== JOB_COMMENTS_ACT_SCHEMA && act.schema !== JOB_COMMENT_CONTEXT_ACT_SCHEMA) ||
        sourceSnapshot(act.source) !== sourceSnapshot(source)) return false;
    const subject = ask.subject;
    if (subject.kind === 'signoff' && act.kind === 'signoff') return act.value.stage === subject.stage && act.value.decision === 'approved';
    return subject.kind === 'checkpoint' && act.kind === 'checkpoint' && act.value.checkpointId === subject.checkpointId &&
        act.value.planStepId === (('planStepId' in subject ? subject.planStepId : undefined) ?? subject.checkpointId) &&
        (act.value.outcome === 'pass' || act.value.outcome === 'fail') &&
        (submission?.kind !== 'checkpoint' || act.value.outcome === submission.value.outcome);
}
function assertJobAskSource(ask: PendingAskV3, display: DisplayPublicationV3): void {
    const source: SourceV3 = ask.subject.kind === 'interview-picks' &&
        !isRecordSource(display.publication.source) && !isRecordSource(ask.source)
        ? { ...ask.source, optionSet: display.publication.source.optionSet }
        : ask.source;
    if (sourceSnapshot(source) !== sourceSnapshot(display.publication.source)) {
        throw new Error('JOB_ACT_SOURCE_STALE');
    }
    const optionSet = askOptionSet(ask);
    if (ask.subject.kind === 'interview-picks' &&
        (optionSet?.id !== ask.subject.setId || !/^[a-f0-9]{64}$/.test(optionSet.sha256))) {
        throw new Error('JOB_ACT_SOURCE_STALE');
    }
}
/** #1004: the set an interview ask binds: its own `optionSets` row on a several-set publication, else the one set. */
function askOptionSet(ask: PendingAskV3): {id: string; sha256: string} | null {
    const subject = ask.subject, rows = 'optionSets' in ask.source ? ask.source.optionSets : undefined;
    if (subject.kind !== 'interview-picks') return null;
    return rows?.find(row => row.questionId === subject.questionId && row.setId === subject.setId)?.optionSet ?? ask.source.optionSet ?? null;
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
    const recordAttempts = new Map<string, UISubmissionV3>();
    const retainedDrafts: JobRetainedDraft[] = [];
    let initialDrafts: readonly JobRetainedDraft[] | null = options.initialRetainedDrafts
        ? [...options.initialRetainedDrafts] : null;
    let generation = 0;
    let latestAskGeneration = 0;
    let recordReceiptAskId: string | undefined;
    let displayed: DisplayPublicationV3 | null = null;
    let receipt: JobDisplayReceipt | null = null;
    let preparing = false;
    let closed = false;
    let error: string | null;
    let errorOrigin: string | undefined;
    let failure: unknown;
    error = null;
    let previousLabel: string | null = null;
    let intent = 0;
    let stopped = false;
    let controller: AbortController | null = null;
    let queue = Promise.resolve();
    function state(): JobWindowState {
        return {
            generation, displayed, receipt, preparing, closed, error, previousLabel, ...(errorOrigin ? {errorOrigin} : {}), ...(failure !== undefined ? {failure} : {}),
            pending: [...pending.values()], retainedDrafts: [...retainedDrafts],
            ...(recordReceiptAskId !== undefined ? {recordReceiptAskId} : {}),
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
        failure = undefined;
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
            catch (caught) {
                if (revision === intent && !stopped) {
                    error = caught instanceof Error ? caught.message : 'JOB_DISPLAY_MISMATCH';
                    failure = caught instanceof Error ? caught : undefined;
                    errorOrigin = caught instanceof Error && typeof caught.cause === 'string' ? caught.cause : undefined;
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
    function settleRecordAsk(ask: JobWindowAsk, act: ActV3, observedGeneration = recordAttempts.get(ask.askId)?.expectedGeneration): void {
        pending.set(ask.askId, {...ask, status: 'answered', act});
        recordAttempts.delete(ask.askId);
        // A newer request owns the row even if an older request finalizes later.
        if (observedGeneration !== undefined && observedGeneration < latestAskGeneration) return;
        if ([...pending.values()].some(other => other.publicationId === ask.publicationId && isPendingOwnerAsk(other))) return;
        recordReceiptAskId = ask.askId;
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
            if (!previous && isPendingOwnerAsk(value.ask)) {
                latestAskGeneration = Math.max(latestAskGeneration, value.generation);
                recordReceiptAskId = undefined;
            }
            pending.set(value.ask.askId, previous?.act ? {...value.ask, status: 'answered', act: previous.act} : value.ask);
        }
        else if (value.type === 'act') {
            const ask = value.act.askId === undefined ? undefined : pending.get(value.act.askId);
            if (ask && !isRecordAnswer(ask.subject.kind) && !isRecordAnswer(value.act.kind))
                pending.set(ask.askId, { ...ask, status: 'answered', act: value.act });
            else if (ask && !ask.act && matchesJobRecordAct(ask, value.act, options.jobId))
                settleRecordAsk(ask, value.act);
        }
        else if (value.type === 'closed') {
            closed = true;
        }
        changed();
    }
    async function submit(input: UISubmissionV3): Promise<JobResult<ActV3>> {
        if (closed || stopped)
            return { ok: false, error: { code: 'JOB_CLOSED', message: 'JOB_CLOSED' } };
        // #1226: a comment-only submission answers no ask; the page receipt is its whole binding.
        const ask = input.kind === 'comments' ? undefined : pending.get(input.askId);
        if (preparing || !displayed || !receipt ||
            input.publicationId !== displayed.publication.publicationId ||
            input.pageId !== pageId || input.displayedNonce !== receipt.displayedNonce ||
            input.expectedGeneration > generation ||
            ask && (ask.status !== 'pending' || ask.publicationId !== input.publicationId || ask.subject.kind !== input.kind)) {
            return { ok: false, error: { code: 'JOB_ACT_SOURCE_STALE', message: 'JOB_ACT_SOURCE_STALE' } };
        }
        // The backend authenticates the actual Request and validates the semantic value.
        const record = isRecordAnswer(input.kind);
        if (record && ask) recordAttempts.set(ask.askId, input);
        const result = await transport.submit(input);
        if (input.kind === 'comments') return result;
        if (!result.ok && recordAttempts.get(input.askId) === input) recordAttempts.delete(input.askId);
        const current = pending.get(input.askId);
        // Keep the transport result for existing callers. Only a matching record act settles the local ask.
        if (!stopped && result.ok && current && (!record ||
            !current.act && matchesJobRecordAct(current, result.value, options.jobId, input))) {
            if (record) settleRecordAsk(current, result.value, input.expectedGeneration);
            else pending.set(current.askId, {...current, status: 'answered', act: result.value});
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
    const capability = hashCapabilityAccess(url, slot, () => storage, replace, {
        strip: 'cap-before-storage', storedValue: 'validate', fallback: null,
    });
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
/** A cursorless snapshot belongs to the page stream, alongside the replayable job events. */
function validateJobProgressLine(line: JobProgressLineV3, jobId: string): void {
    if (line.jobId !== jobId || 'cursor' in line || typeof line.now !== 'string' || !Number.isFinite(Date.parse(line.now)))
        throw new Error('JOB_STREAM_FAILED');
    const value = line.progress;
    if (value === null) return;
    if (!value || !Number.isSafeInteger(value.seq) || value.seq < 1 ||
        !Number.isSafeInteger(value.generation) || value.generation < 0 ||
        !['ingest', 'build', 'measure', 'publish', 'other'].includes(value.phase) ||
        typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)))
        throw new Error('JOB_STREAM_FAILED');
    const {text, step} = value;
    if (text !== undefined && (typeof text !== 'string' || text.length > 120 || /[\x00-\x1f\x7f\u0085\u2028\u2029]/u.test(text)))
        throw new Error('JOB_STREAM_FAILED');
    if (step !== undefined && (!step || !Number.isSafeInteger(step.i) || !Number.isSafeInteger(step.n) ||
        step.i < 1 || step.i > step.n || step.n > 1000))
        throw new Error('JOB_STREAM_FAILED');
}
/** Bounded newline events. Reconnects resume after the last fully parsed event. */
export async function* jobWindowEvents(access: JobWindowAccess, after: string | null, signal: AbortSignal, fetcher: typeof fetch = fetch, connected?: () => void, progress?: (line: JobProgressLineV3) => void): AsyncGenerator<EventV3> {
    const path = 'events' + (after === null ? '' : '?after=' + encodeURIComponent(after));
    const response = await fetcher(access.route(path), { signal, headers: access.headers() });
    if (!response.ok || !response.body)
        throw new Error('JOB_STREAM_FAILED');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    const limit = 1024 * 1024;
    try {
        if (!signal.aborted) connected?.();
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
                const event = JSON.parse(buffered.slice(0, newline)) as EventV3 | JobProgressLineV3;
                buffered = buffered.slice(newline + 1);
                if (event?.type === 'progress') {
                    validateJobProgressLine(event, access.jobId);
                    if (!signal.aborted) progress?.(event);
                    newline = buffered.indexOf('\n');
                    continue;
                }
                if (!event || event.jobId !== access.jobId || typeof event.cursor !== 'string' ||
                    !Number.isSafeInteger(event.generation) || event.generation < 0 ||
                    !['published', 'pending', 'act', 'closed'].includes(event.type))
                    throw new Error('JOB_STREAM_FAILED');
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
    progress?(value: JobProgressV3 | null): void;
    refused(error: unknown): void;
    connected?(): void;
    fetcher?: typeof fetch;
}) {
    let cursor: string | null = null;
    const progressState: {latest: JobProgressV3 | null} = {latest: null};
    let replayGeneration = 0;
    let progressGenerationFloor = 0;
    function deliverProgress(value: JobProgressV3 | null): void {
        if (value && value.generation < progressGenerationFloor) return;
        progressState.latest = value;
        options.progress?.(value);
    }
    let reader: AbortController | null = null;
    let wake: (() => void) | null = null;
    let failed = false;
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
                const replay: {progress: JobProgressV3 | null} = {progress: null};
                reader = current;
                try {
                    for await (const event of jobWindowEvents(options.access, cursor, current.signal, options.fetcher, () => {
                        if (failed && !current.signal.aborted && !options.signal.aborted) {
                            failed = false;
                            options.connected?.();
                        }
                    }, ({progress}) => {
                        // Restore durable asks before rendering a connect snapshot taken after those asks.
                        replay.progress = progress && progress.generation > replayGeneration ? progress : null;
                        if (!replay.progress) deliverProgress(progress);
                    })) {
                        if (event.type !== 'act') {
                            progressGenerationFloor = Math.max(progressGenerationFloor, event.generation);
                            const latestProgress = progressState.latest;
                            if (latestProgress && (event.type === 'closed' || latestProgress.generation < progressGenerationFloor))
                                deliverProgress(null);
                        }
                        // Only complete, delivered events advance replay, including a final event racing hide.
                        options.event(event);
                        cursor = event.cursor;
                        if (event.type === 'closed') return;
                        replayGeneration = Math.max(replayGeneration, event.generation);
                        if (replay.progress && replay.progress.generation <= replayGeneration) {
                            deliverProgress(replay.progress);
                            replay.progress = null;
                        }
                    }
                } catch (error) {
                    if (!current.signal.aborted && !options.signal.aborted) {
                        failed = true;
                        options.refused(error);
                    }
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
import type { SceneInspection } from '../src/scene-inspection.ts';
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
    assetsBase?: string;
    setsHash?: string;
    initialAnimation?: string | null;
    direction?: DirectionInspection;
    scene?: SceneInspection;
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
export interface JobRecordInspectionMetadata extends Omit<JobInspectionMetadata, 'recordSource' | 'manifest' | 'reviewedSource'> {
    recordSource: RecordSource;
    manifest?: ReviewManifest;
    reviewedSource?: ReviewedSource;
}
export type JobInspectionMetadataV3 = JobInspectionMetadata | JobRecordInspectionMetadata;
type JobInterview = {
    questions: (Omit<InterviewQuestion, 'images' | 'set'> & {
        set: InterviewQuestion['set'] & {context?: {kind?: unknown; rig_version?: unknown}};
        images: {
            name: string;
            url: string;
            /** #1048: the sealed `files` entry, present on a record publication only. */
            path?: string;
            sha256?: string;
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
    /** #983: the record plan's declared picture, hash-checked and decoded; the record screen draws it first.
     * #1048: `path` and `sha256` are the sealed `files` entry, never a browser digest; pins name the picture by them. */
    planPicture?: {name: string; src: string; path: string; sha256: string};
    assets: ModelAssets | null;
    player: RigPlayer | null;
    rigRoot: HTMLElement;
    inspection: PartInspection | null;
    setupPose(setup?: boolean): void;
    dispose(): void;
}
/** One request per resource per preparation (#1050). Every caller in one preparation passes the same signal; a
 * later preparation (a republish, a reload) brings a new signal and so a new request. The URL carries the
 * publication id and instance key, so a republished resource never shares an older promise. */
const jobBytesBySignal = new WeakMap<AbortSignal, Map<string, Promise<Uint8Array<ArrayBuffer>>>>();
async function jobBytes(url: string, signal: AbortSignal, maximum: number, refusal?: { status: number; code: string }): Promise<Uint8Array<ArrayBuffer>> {
    let shared = jobBytesBySignal.get(signal);
    if (!shared) jobBytesBySignal.set(signal, shared = new Map());
    const key = `${url}\n${maximum}\n${refusal ? `${refusal.status}:${refusal.code}` : ''}`;
    let pending = shared.get(key);
    if (!pending) shared.set(key, pending = readJobBytes(url, signal, maximum, refusal));
    return (await pending).slice();
}
async function readJobBytes(url: string, signal: AbortSignal, maximum: number, refusal?: { status: number; code: string }): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error(response.status === refusal?.status ? refusal.code : 'JOB_PRELOAD_FAILED');
    }
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
export async function jobJson<Value>(url: string, signal: AbortSignal, refusal?: { status: number; code: string }): Promise<Value> {
    const bytes = await jobBytes(url, signal, 2 * 1024 * 1024, refusal);
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
    const record = isRecordSource(publishedSource);
    const recordRig = record && (metadata.manifest !== undefined || metadata.reviewedSource !== undefined);
    if (record) {
        if (!metadata.recordSource || !metadata.capabilities || (!recordRig && metadata.capabilities.playback) ||
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
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
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
        const interview = metadata.capabilities.interview ? await jobJson<JobInterview>(routes.api('interview'), signal, {status: 409, code: 'JOB_SOURCE_UNRETAINABLE'}) : null;
        if (recordRig) {
            const {manifest, reviewedSource} = metadata;
            const model = reviewedSource?.rig;
            if (publishedSource.subject !== 'option-set' || metadata.assetsBase !== display.routes.assetsBase ||
                metadata.capabilities.playback !== true || metadata.capabilities.interview !== true || metadata.capabilities.preRig ||
                !manifest || manifest.schema !== 'rig-review/1' || !reviewedSource || !model || model.path !== 'build/skeleton.model.json' ||
                manifest.model !== model.path || reviewedSource.packageRevision !== manifest.revision ||
                reviewedSource.motion !== null || reviewedSource.handoff !== undefined || metadata.initialAnimation != null ||
                metadata.direction || metadata.scene || metadata.sourcePainting || metadata.setsHash ||
                manifest.motion || manifest.sets || manifest.direction || manifest.scene || manifest.producer ||
                [manifest.references, manifest.checkpoints, manifest.authoring, manifest.axes, manifest.audio?.clips, manifest.audio?.cues]
                    .some(rows => !Array.isArray(rows) || rows.length !== 0) ||
                !Array.isArray(interview?.questions) || interview.questions.length === 0) {
                throw new Error('JOB_DISPLAY_MISMATCH');
            }
            const {selection, optionSets, optionSetFile} = publishedSource;
            const bindings = selection.sets ? optionSets
                : [{questionId: selection.questionId, setId: selection.setId, optionSetFile}];
            if (!bindings || bindings.length !== (selection.sets?.length ?? 1) || interview.questions.length !== bindings.length) {
                throw new Error('JOB_DISPLAY_MISMATCH');
            }
            // The retained viewer uses the first published set's rig. Every question must bind to that same version.
            let rigVersion: number | undefined;
            for (const binding of bindings) {
                const question = interview.questions.find(row =>
                    row?.set?.question === binding.questionId && row.set?.id === binding.setId);
                const context = question?.set?.context;
                if (!question?.set || question.set.stage !== 'post-interview' || question.editable !== true ||
                    sourceSnapshot(question.ref) !== sourceSnapshot(binding.optionSetFile) || question.missingPicture !== undefined ||
                    question.hasParts || question.scenePicture || !Array.isArray(question.images) || question.images.length ||
                    !context || context.kind !== 'rig' || typeof context.rig_version !== 'number' ||
                    !Number.isSafeInteger(context.rig_version) || context.rig_version < 1 ||
                    (rigVersion !== undefined && context.rig_version !== rigVersion) ||
                    !publishedSource.files.some(file =>
                        file.path === `derived/review/v${context.rig_version}/out/check/${model.path}` && file.sha256 === model.sha256)) {
                    throw new Error('JOB_DISPLAY_MISMATCH');
                }
                rigVersion = context.rig_version;
            }
        }
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
            checkpointEvidencePair(packet);
            const projection = metadata.checkpointEvidence?.[index];
            const tableUrl = `/api/checkpoint-evidence/${packet.checkpointId}/table`;
            // #1229: the pair is an ordinary comparison; a record packet names its plan step as its checkpoint.
            if (!projection?.table || !source.plan?.steps.some(step => step.id === packet.planStepId) ||
                source.subject === 'plan' && packet.planStepId !== packet.checkpointId ||
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
        let planPicture: {name: string; src: string; path: string; sha256: string} | undefined;
        const declaredPlanPicture = record && publishedSource.subject === 'plan' ? publishedSource.planPicture : undefined;
        if (preloadVisuals && declaredPlanPicture) {
            preload.push(image(routes.api('plan-picture'), declaredPlanPicture.sha256).then(element => {
                planPicture = {name: declaredPlanPicture.path.split('/').at(-1)!, src: element.src,
                    path: declaredPlanPicture.path, sha256: declaredPlanPicture.sha256};
            }));
        }
        const preloaded = await Promise.allSettled(preload);
        const failed = preloaded.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
        // A record's bound rig is drawn by the shared workspace. This inspection prepares its forms.
        if (!formsOnly && !recordRig && metadata.manifest?.model) {
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
            ...(planPicture ? {planPicture} : {}),
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
                        const rests = node('ul'), questions = projection?.status === 'projected' ? projection.questions : undefined;
                        for (const text of row.rests_on!) {
                            const question = questions && Object.hasOwn(questions, text) ? questions[text] : undefined;
                            const dependency = question === undefined ? plan.steps.find(step => step.id === text) : undefined;
                            const labels = typeof question === 'string' || question === undefined ? [question] : question;
                            for (const label of labels) {
                                const rest = node('li', label === '' ? 'job.plan.field.absent' : undefined);
                                if (dependency) planStepText(rest, dependency, projection);
                                else {
                                    if (label !== '') rest.textContent = label ?? text;
                                    rest.setAttribute('translate', 'no');
                                }
                                if (label !== undefined || dependency) rest.title = text;
                                rests.append(rest);
                            }
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
    function formFor(ask: JobWindowAsk, prepared: JobPreparedInspection, deps: JobFormDependencies): JobForm {
        const {helpers: {assertJobAskSource}} = deps;
        if (ask.publicationId !== prepared.display.publication.publicationId)
            throw new Error('JOB_DISPLAY_MISMATCH');
        assertJobAskSource(ask, prepared.display);
        throw new Error('JOB_ACT_KIND_DISABLED');
    }
export {formFor};

// Keep the form dependencies available through the existing preparation seam as well as named exports.
prepareJobForms.formFor = formFor;
prepareJobForms.helpers = createJobFormHelpers;

/** The original source-bound draft storage, shared by the legacy and single-screen hosts. */
export function jobSourceDraftId(source: SourceV3): string {
    if ('record' in source)
        return source.subject === 'option-set' ? source.selection.questionId + ':' + source.selection.setId : 'plan';
    if (source.selector?.kind === 'draft')
        return source.selector.id;
    if (source.selector?.kind === 'rig')
        return source.package.id + ':rig:' + source.selector.version;
    if (source.selector?.kind === 'post')
        return source.package.id + ':post:' + source.selector.version + ':' + source.selector.rigVersion;
    if (source.selector?.kind === 'current')
        return source.package.id + ':current:' + source.selector.output + ':' + source.selector.record;
    return source.package.id;
}

export function createJobFormDrafts(options:{jobId:string;current():JobPreparedInspection|null;forms():ReadonlyMap<string,JobForm>;storage():Pick<Storage,'setItem'>}) {
    function localDraftKey(display: DisplayPublicationV3): string {
        return 'rig-review-job-draft/1:' + options.jobId + ':' + jobSourceDraftId(display.publication.source) + ':' + display.publication.source.sourceHash;
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
    const dependencies:JobFormDependencies={node,translate:t,helpers:{...helpers,assertJobAskSource},draftStorage:()=>localStorage,...drafts,access,pageId,
        window:{state:()=>window.state(),submit:input=>window.submit(input)}};
    const rigScreen=createJobRigScreen({host,pageId,access,translate:(key,values)=>i18n.t(key,values,'en'),refusal:jobWindowRefusal,formDependencies:dependencies,
        window:{state:()=>window.state(),submit:input=>window.submit(input)},readPublication:(id,signal)=>transport.readPublication(id,signal),
        routes:display=>jobPublicationRoutes(display,location.origin),load:async()=>(await import('./main.ts')).mountRigScreen()});
    let bootstrapNotice:HTMLElement|null=null,bootstrapStream=false,bootstrapPrior:{text:string;title:string}|null=null;
    const report=(failure:unknown,fallback?:string)=>{
        const reason=failure instanceof Error?failure.message:failure;
        const error=!access.capability&&reason==='JOB_CAPABILITY_REQUIRED'?'JOB_CAPABILITY_LINK_LOST':failure;
        const stream=fallback==='JOB_STREAM_FAILED';if(rigScreen.mounted()){rigScreen.report(error,fallback);return;}if(!bootstrapNotice){bootstrapNotice=node('p');bootstrapNotice.setAttribute('role','status');bootstrapNotice.setAttribute('translate','no');host.prepend(bootstrapNotice);}const text=jobWindowRefusal(error,fallback),code=error instanceof Error?error.message:error,title=typeof code==='string'&&/^[A-Z][A-Z0-9_]*$/.test(code)&&Object.hasOwn(enCatalog,code)&&Object.hasOwn(koCatalog,code)?code:fallback??'JOB_WINDOW_FAILED';if(stream)bootstrapStream=true;else{bootstrapStream=false;bootstrapPrior={text,title};}bootstrapNotice.textContent=text;bootstrapNotice.title=title;};
    const clear=()=>{rigScreen.clearReport?.();if(!bootstrapStream)return;bootstrapStream=false;if(bootstrapPrior&&bootstrapNotice){bootstrapNotice.textContent=bootstrapPrior.text;bootstrapNotice.title=bootstrapPrior.title;return;}if(bootstrapNotice){bootstrapNotice.textContent='';bootstrapNotice.title='';bootstrapNotice.remove?.();bootstrapNotice=null;}};
    const window=createJobWindow<JobRigScreenPrepared|null>({jobId:access.jobId,pageId,transport,adapter:{
        async prepare(display,signal){return rigScreen.prepare(display,signal);},
        captureDraft(){drafts.saveDraft();const forms=modalState()?.forms;const dirty=forms?[...forms].filter(([,entry])=>entry.dirty):[];return dirty.length?dirty.map(([askId,entry])=>({askId,value:entry.read()})):null;},
        commit:prepared=>prepared?rigScreen.commit(prepared):{rollback(){},finalize(){}},
        async painted(prepared,signal){if(stopped||signal.aborted)return;if(prepared)await rigScreen.painted(prepared,signal);},
        discard:prepared=>{const modal=prepared?.record??prepared?.modals;for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();},
        changed(state){rigScreen.changed(state);if(!state.error&&rigScreen.mounted())bootstrapPrior=null;if(state.error&&(!rigScreen.mounted()||rigScreen.mounted()?.record))report(state.failure??state.error);},
    }});
    const localize=i18n.onLanguageChange(()=>{for(const element of host.querySelectorAll<HTMLElement>('[data-job-text]'))element.textContent=t(element.dataset.jobText!);});
    await rigScreen.waiting();
    startJobWindowEvents({access,signal:abort.signal,event:event=>window.event(event),progress:value=>rigScreen.progress(value),refused:error=>report(error,'JOB_STREAM_FAILED'),connected:clear});
    const stop=()=>{if(stopped)return;stopped=true;drafts.saveDraft();abort.abort();window.stop();const modal=modalState();for(const entry of modal?.forms.values()??[])entry.dispose?.();modal?.inspection.dispose();localize();globalThis.removeEventListener('pagehide',stop);};
    globalThis.addEventListener('pagehide',stop,{once:true});return stop;
}
