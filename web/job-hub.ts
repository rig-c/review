import {createRetainedFrameStage, mountRetainedWorkspace} from './retained-frame-stage.ts';
import {hashCapabilityAccess} from './instance-access.ts';
/** Owner-only subject selection. Each retained frame owns its existing review window and draft. */
import type {JobHubList, JobHubRow, JobHubSubjectKind} from '../src/job-hub.ts';

const subjectKindSet: Readonly<Record<JobHubSubjectKind, true>> = {
  parts: true, interview: true, rig: true, direction: true, 'image-set': true,
  checkpoint: true, signoff: true, reopen: true, plan: true, package: true,
};

export const JOB_HUB_READY = 'rig-review-job-hub-ready/1';
export const JOB_HUB_VISIBILITY = 'rig-review-job-hub-visibility/1';
export interface JobHubBinding {
  incarnation: string;
  jobId: string;
  publicationId: string | null;
  sourceHash: string | null;
}
export function jobHubMessageMatches(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
  origin: string, source: MessageEventSource | null, binding: JobHubBinding, kind: 'ready' | 'visibility'): boolean {
  if (!source || event.origin !== origin || event.source !== source || !event.data || typeof event.data !== 'object') return false;
  const value = event.data;
  const keys = ['schema', 'incarnation', 'jobId', 'publicationId', 'sourceHash', ...(kind === 'visibility' ? ['visible', 'language'] : [])];
  return !Object.keys(value).some(key => !keys.includes(key)) &&
    value.schema === (kind === 'ready' ? JOB_HUB_READY : JOB_HUB_VISIBILITY) &&
    value.incarnation === binding.incarnation && value.jobId === binding.jobId &&
    value.publicationId === binding.publicationId && value.sourceHash === binding.sourceHash &&
    (binding.publicationId === null && binding.sourceHash === null ||
      typeof binding.publicationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binding.publicationId) &&
      typeof binding.sourceHash === 'string' && /^[a-f0-9]{64}$/.test(binding.sourceHash)) &&
    (kind === 'ready' || typeof value.visible === 'boolean' && ['en', 'ko'].includes(value.language));
}
export function checkedJobHubLocation(href: string) {
  const url = new URL(href), incarnation = url.searchParams.get('workspace');
  if (url.pathname !== '/hub/' || !incarnation || !/^[a-f0-9-]{36}$/.test(incarnation) ||
      [...url.searchParams.keys()].some(key => !['workspace', 'lang'].includes(key) || url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.has('lang') && !['en', 'ko'].includes(url.searchParams.get('lang')!)) throw new Error('JOB_REQUEST_INVALID');
  return {url, incarnation};
}

export function checkedJobHubList(value: JobHubList, incarnation: string): JobHubList {
  if (value?.schema !== 'rig-review-job-hub/1' || value.incarnation !== incarnation ||
      !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 32 ||
      !Array.isArray(value.jobs) || value.jobs.length > value.limit) throw new Error('JOB_HUB_STATE_INVALID');
  const ids = new Set<string>();
  for (const job of value.jobs) {
    if (!job || typeof job.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.jobId) || ids.has(job.jobId) ||
        !['active', 'closed'].includes(job.status) || !Number.isSafeInteger(job.generation) || job.generation < 0 ||
        !Number.isSafeInteger(job.pendingCount) || job.pendingCount < 0 ||
        job.subjectKind !== undefined && !Object.hasOwn(subjectKindSet, job.subjectKind) ||
        job.answered !== undefined && typeof job.answered !== 'boolean' || job.publication !== null &&
        (!job.publication || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(job.publication.publicationId) ||
          !/^[a-f0-9]{64}$/.test(job.publication.instanceKey) || !/^[a-f0-9]{64}$/.test(job.publication.sourceHash) ||
          typeof job.publication.label !== 'string' || job.publication.label.length > 512)) throw new Error('JOB_HUB_STATE_INVALID');
    ids.add(job.jobId);
  }
  return value;
}

export async function mountJobHub(root: HTMLElement): Promise<() => void> {
  const i18n = await import('./i18n.ts');
  const {t, getLanguage} = i18n;
  let storage: Storage | null = null;
  try {storage = sessionStorage;} catch { /* Memory-only access. */ }
  const {url: locationURL, incarnation} = checkedJobHubLocation(location.href);
  const capability = hashCapabilityAccess(locationURL, 'rig-review-job-hub/1:' + locationURL.origin + ':' + incarnation,
    () => storage, href => history.replaceState(history.state, '', href), {strip: 'always-after-storage', storedValue: 'validate', fallback: ''});
  const access = {incarnation, capability};
  const requestedLanguage = new URL(location.href).searchParams.get('lang');
  if (requestedLanguage === 'en' || requestedLanguage === 'ko') i18n.setLanguagePreference(requestedLanguage);
  const workspace = mountRetainedWorkspace({root, kind: 'hub'});
  const {stage, language} = workspace;
  type Frame = {frame: HTMLIFrameElement; row: JobHubRow; binding: JobHubBinding; announced?: JobHubBinding};
  const cancellation = new AbortController();
  let current: JobHubList | null = null, disposed = false;
  let status = 'job.hubHint', timer: ReturnType<typeof setTimeout> | undefined;
  const binding = (row: JobHubRow): JobHubBinding => ({incarnation: access.incarnation, jobId: row.jobId,
    publicationId: row.publication?.publicationId ?? null, sourceHash: row.publication?.sourceHash ?? null});
  const retained = createRetainedFrameStage<Frame>({stage, limit: () => current!.limit, key: entry => entry.row.jobId,
    message: entry => ({...entry.binding, schema: JOB_HUB_VISIBILITY}), language: getLanguage, origin: location.origin,
    visibilityOrder: 'after-state', languageChange: 'selection'});
  function render() {
    const selectedRow = current?.jobs.find(row => row.jobId === retained.selected) ?? null;
    workspace.render({
      lang: getLanguage(),
      heading: t('job.hubTitle'),
      listLabel: t('job.hubJobs'),
      languageLabel: t('interview.language'),
      englishLabel: t('English'),
      koreanLabel: t('Korean'),
      message: t(status),
      selected: retained.selected,
      selectedHash: selectedRow?.publication?.sourceHash ?? null,
      answeredLabel: count => t('hub.answeredGroup', [count]),
      items: (current?.jobs ?? []).map(row => {
        const kindKey: JobHubSubjectKind = row.subjectKind ?? 'package';
        return {
          key: row.jobId,
          dataset: {
            jobId: row.jobId,
            subjectKind: kindKey,
            subjectState: row.status === 'closed' ? 'closed' : row.answered ? 'answered' : 'waiting',
          },
          kindLabel: t('hub.kind.' + kindKey),
          label: row.publication?.label || t('hub.unpublished'),
          hash: row.publication?.sourceHash ?? null,
          answered: row.status === 'closed' || Boolean(row.answered),
          onSelect: () => {void select(row).catch(() => {status = 'JOB_HUB_REQUEST_REFUSED'; render();});},
        };
      }),
    });
  }
  async function select(row: JobHubRow) {
    const selection = retained.beginSelection();
    let entry = retained.get(row.jobId);
    if (!entry && row.status === 'closed') {
      status = 'job.hubClosed'; retained.select(row.jobId); render(); return;
    }
    if (!entry) {
      if (!current || retained.atLimit()) throw new Error('JOB_HUB_LIMIT');
      const response = await fetch('/hub/api/jobs/' + row.jobId + '/open', {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Review-Capability': access.capability},
        body: JSON.stringify({schema: 'rig-review-job-hub/1', incarnation: access.incarnation}),
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)])});
      const grant = await response.json();
      if (!response.ok) throw new Error('JOB_HUB_REQUEST_REFUSED');
      if (!retained.isCurrent(selection)) return;
      if (grant.schema !== 'rig-review-job-hub/1' || grant.incarnation !== access.incarnation || grant.jobId !== row.jobId ||
          grant.entry !== '/jobs/' + row.jobId + '/?hub=' + access.incarnation || !/^[a-f0-9]{64}$/.test(grant.capability)) throw new Error('JOB_HUB_STATE_INVALID');
      const url = new URL(grant.entry, location.origin); url.searchParams.set('lang', getLanguage()); url.hash = 'cap=' + grant.capability;
      const frame = retained.createFrame(row.publication?.label || t('hub.unpublished'), url.href);
      entry = {frame, row, binding: {...binding(row), publicationId: null, sourceHash: null}};
      retained.retain(entry);
    }
    status = 'job.hubHint'; retained.select(row.jobId); render();
  }
  function ready(event: MessageEvent) {
    const entry = retained.get(event.data?.jobId);
    if (!entry || !current) return;
    const candidate: JobHubBinding = {incarnation: access.incarnation, jobId: entry.row.jobId,
      publicationId: event.data?.publicationId, sourceHash: event.data?.sourceHash};
    if (!jobHubMessageMatches(event, location.origin, entry.frame.contentWindow, candidate, 'ready')) return;
    entry.announced = candidate;
    if (jobHubMessageMatches(event, location.origin, entry.frame.contentWindow, binding(entry.row), 'ready')) {
      entry.binding = candidate; retained.visibility(entry);
    }
  }
  async function refresh() {
    try {
      const response = await fetch('/hub/api/jobs', {headers: {'X-Review-Capability': access.capability},
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)])});
      if (!response.ok) throw new Error('JOB_HUB_REQUEST_REFUSED');
      current = checkedJobHubList(await response.json(), access.incarnation);
      for (const row of current.jobs) {
        const entry = retained.get(row.jobId);
        if (!entry) continue;
        entry.row = row;
        if (entry.announced && JSON.stringify(entry.announced) === JSON.stringify(binding(row))) entry.binding = entry.announced;
        retained.visibility(entry);
      }
      render();
      if (!retained.selected && current.jobs.length) {
        const initial = current.jobs.find(row => row.status === 'active' && !row.answered) ?? current.jobs[0]!;
        await select(initial);
      }
    } catch {if (!disposed) {status = 'JOB_HUB_REQUEST_REFUSED'; render();}}
    finally {if (!disposed) timer = setTimeout(() => {void refresh();}, 1000);}
  }
  language.onchange = () => {i18n.setLinkLanguage(null); i18n.setLanguagePreference(language.value === 'ko' ? 'ko' : 'en');};
  const unlocalize = i18n.onLanguageChange(() => {render(); retained.languageChanged();});
  globalThis.addEventListener('message', ready);
  const stop = () => {
    if (disposed) return;
    disposed = true; retained.dispose(); clearTimeout(timer); cancellation.abort(); unlocalize();
    globalThis.removeEventListener('message', ready); globalThis.removeEventListener('pagehide', stop);
  };
  globalThis.addEventListener('pagehide', stop, {once: true});
  render(); void refresh(); return stop;
}
if (typeof document !== 'undefined' && typeof location !== 'undefined' && location.pathname === '/hub/') {
  const root = document.getElementById('app');
  if (root && !root.childElementCount) {
    void mountJobHub(root).catch(async () => {
      const {t} = await import('./i18n.ts');
      root.textContent = t('JOB_HUB_REQUEST_REFUSED');
    });
  }
}
