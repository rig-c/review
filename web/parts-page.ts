import { bindDomI18n, unbindDomI18n, onLanguageChange, setLanguagePreference, setLinkLanguage, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { connectLiveWindow } from './live-connection.ts';
import { bindStageNav, type StagePartsState, type StagePartsWindow } from './stage-nav.ts';
import { parsePartsIssue } from '../src/parts-comment.ts';
import { mountPartsWorkspace, type PanelOutput, type PartsHost, type PartsSource, type PartsWorkspaceHandle, type ViewData } from './parts.ts';

/** Standalone and joined-stage transport for the shared parts workspace. */
export function bootPartsPage(): PartsWorkspaceHandle {
  const access = pageInstanceAccess();
  const url = new URL(location.href);
  const embedded = url.searchParams.get('stageEmbed') === '1';
  const side = url.searchParams.get('side');
  const partsApi = embedded
    ? (side === 'a' || side === 'b' ? `/api/compare/${side}/stage-parts` : '/api/stage-parts')
    : '/api/parts';
  let build = 'inspected';
  let restore: StagePartsState | null = null;
  let currentView: ViewData | null = null;
  let output: PanelOutput | null = null;
  let busy = false;
  let disposed = false;
  let workspace: PartsWorkspaceHandle | null = null;
  let receiveSource!: () => void;
  const sourceReady = new Promise<void>(resolve => { receiveSource = resolve; });
  const disposers: (() => void)[] = [];
  const objectUrls = new Set<string>();
  const pendingImages = new Set<() => void>();
  const required = <T extends HTMLElement>(selector: string): T => {
    const node = document.querySelector<T>(selector);
    if (!node) throw new Error(`PARTS_WORKSPACE_NODE_REQUIRED: ${selector}`);
    return node;
  };
  const slots = {
    left: required('.pv-list'), stage: required('[data-parts-stage]'),
    toolbar: required('.pv-toolbar'), side: required('.pv-side'),
  };
  const actions = required('#parts-actions');
  const headers = () => access.headers(embedded ? {'X-Review-Stage-Build': build} : {});
  const request = async (path: string): Promise<Response> => {
    const response = await fetch(access.route(path), {headers: headers()});
    if (!response.ok) {
      const value = await response.json() as {error?: string};
      throw new Error(value.error ?? 'PARTS_PAINT_FAILED');
    }
    return response;
  };
  const image = async (path: string): Promise<HTMLImageElement> => {
    const response = await request(path);
    if (disposed) throw new Error('PARTS_PAINT_FAILED');
    const blob = await response.blob();
    if (disposed) throw new Error('PARTS_PAINT_FAILED');
    return new Promise((resolve, reject) => {
      const node = document.createElement('img');
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.add(objectUrl);
      const cleanup = () => {
        node.onload = null; node.onerror = null;
        URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl); pendingImages.delete(cancel);
      };
      const cancel = () => { cleanup(); node.removeAttribute('src'); reject(new Error('PARTS_PAINT_FAILED')); };
      pendingImages.add(cancel);
      node.onload = () => { cleanup(); resolve(node); };
      node.onerror = () => { cleanup(); reject(new Error('PARTS_PAINT_FAILED')); };
      node.src = objectUrl;
    });
  };
  const source: PartsSource = {
    async view() {
      if (embedded) await sourceReady;
      if (disposed) throw new Error('PARTS_PAINT_FAILED');
      const requestedBuild = build;
      const data = await (await request(partsApi)).json() as ViewData;
      if (disposed) throw new Error('PARTS_PAINT_FAILED');
      if (requestedBuild !== build) throw new Error('STAGE_DRAFT_CHANGED');
      currentView = data;
      document.title = data.title;
      required('#pv-title').textContent = data.title;
      required('#pv-mode').textContent = t(data.mode === 'parts' ? 'Parts package, before rigging' : 'Atlas of a built rig');
      return data;
    },
    image: index => image(`${partsApi}/image/${index}`),
    page: index => image(`${partsApi}/page/${index}`),
    painting: () => currentView?.painting ? image('/api/parts/painting') : null,
    difference: (index, threshold, footprints) => request(`${partsApi}/difference/${index}?threshold=${threshold}&footprints=${footprints}`),
    async crop(issue) {
      const response = await fetch(access.route('/api/parts/comment'), {
        method: 'POST', headers: access.headers({'Content-Type': 'application/json'}), body: JSON.stringify(issue),
      });
      const value = await response.json() as {comment: unknown; error?: string};
      if (!response.ok) throw new Error(value.error ?? 'PARTS_COMMENT_UNAVAILABLE: original part image required');
      return parsePartsIssue(value.comment, true, true, false);
    },
  };
  const host: PartsHost = {
    initial: () => currentView?.verdict?.issues ?? currentView?.legacyVerdict?.issues ??
      (currentView?.verdict?.comments ?? []).map(issue => parsePartsIssue(issue, true, true, false)),
    changed() {},
    register(value) { output = value; },
    locked: () => busy || currentView?.legacyVerdict?.readOnly ||
      embedded && (!currentView?.joinedVerdictBinding || !access.capability || build !== 'inspected') ? 'sent' : 'open',
  };
  const save = async () => {
    if (!currentView || !output || host.locked() !== 'open') return;
    const status = required('#pv-save-status');
    const button = required<HTMLButtonElement>('#pv-save');
    busy = true; button.disabled = true;
    try {
      const value = output.value();
      if (!('issues' in value) || !('verdict' in value)) throw new Error('PARTS_VERDICT_INVALID');
      const body = {status: value.verdict, issues: value.issues,
        ...(embedded ? {binding: currentView.joinedVerdictBinding} : {})};
      const writeHeaders = headers(); writeHeaders.set('Content-Type', 'application/json');
      const response = await fetch(access.route(`${partsApi}/verdict`), {
        method: 'POST', headers: writeHeaders, body: JSON.stringify(body),
      });
      const result = await response.json() as {error?: string; verdict?: {source: {sha256: string}}};
      if (disposed) return;
      status.textContent = response.ok
        ? t('Saved {file}: source {hash}.', {file: currentView.verdictFile, hash: result.verdict!.source.sha256.slice(0, 12)})
        : t(result.error ?? 'Save failed.');
      status.dataset.result = response.ok ? 'saved' : 'refused';
    } catch {
      if (!disposed) {status.textContent = t('Save failed.'); status.dataset.result = 'refused';}
    } finally {
      busy = false;
      if (!disposed) button.disabled = host.locked() !== 'open';
    }
  };
  const exportVerdict = async (format: 'json' | 'issue') => {
    const data = currentView;
    if (!data) return;
    try {
      const response = await request(embedded ? `${partsApi}/export/${format}` : `/api/parts/export?format=${format}`);
      const value = await response.text();
      if (disposed) return;
      const objectUrl = URL.createObjectURL(new Blob([value], {type: format === 'json' ? 'application/json' : 'text/markdown'}));
      objectUrls.add(objectUrl);
      const anchor = document.createElement('a'); anchor.href = objectUrl;
      anchor.download = embedded ? (format === 'json' ? data.verdictFile : data.verdictFile.replace(/\.json$/, '.md'))
        : format === 'json' ? 'parts-review-export.json' : 'parts-review-export.md';
      anchor.click();
      const timer = setTimeout(() => {URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl);}, 1000);
      disposers.push(() => clearTimeout(timer));
    } catch (error) {
      if (!disposed) required('#pv-save-status').textContent = t(error instanceof Error ? error.message : 'Save failed.');
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type === 'review-stage-source' && (message.buildId === 'inspected' || /^[a-f0-9]{64}$/.test(message.buildId))) {
      build = message.buildId; restore = message.state ?? null; receiveSource();
    } else if (message?.type === 'review-stage-language' && (message.language === 'en' || message.language === 'ko')) {
      setLinkLanguage(null); setLanguagePreference(message.language);
    } else if (message?.type === 'review-stage-restore' && message.state) {
      void workspace?.restore(message.state);
    } else if (message?.type === 'review-stage-revalidate') {
      if (message.buildId === 'inspected' || typeof message.buildId === 'string' && /^[a-f0-9]{64}$/.test(message.buildId)) build = message.buildId;
      void workspace?.revalidate(message.state).then(syncActions);
    }
  };
  const correction = (event: Event) => parent.postMessage((event as CustomEvent).detail, location.origin);
  window.addEventListener('message', onMessage); disposers.push(() => window.removeEventListener('message', onMessage));
  slots.stage.addEventListener('parts-correction', correction); disposers.push(() => slots.stage.removeEventListener('parts-correction', correction));
  bindDomI18n(document); disposers.push(unbindDomI18n);
  disposers.push(bindStageNav({partsOnly: true, model: false}));
  disposers.push(connectLiveWindow(access));
  const syncActions = () => {
    actions.hidden = embedded && !currentView?.joinedVerdictBinding;
    required<HTMLButtonElement>('#pv-save').disabled = host.locked() !== 'open';
  };
  const mounted = mountPartsWorkspace(slots, source, host, {defaultView: 'item', embedded});
  actions.replaceChildren(); actions.classList.add('pv-verdict');
  for (const [id, label, action] of [
    ['pv-save', 'Save sign-off', save],
    ['pv-export-json', 'Export JSON', () => exportVerdict('json')],
    ['pv-export-issue', 'Export issue', () => exportVerdict('issue')],
  ] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.id = id; button.textContent = t(label);
    button.onclick = () => {void action();}; actions.append(button);
    disposers.push(onLanguageChange(() => {button.textContent = t(label);}));
  }
  if (embedded) required('.pv-top').hidden = true;
  const ready = mounted.ready.then(async () => {
    if (disposed) return;
    if (restore) await mounted.restore(restore);
    syncActions(); document.body.dataset.ready = 'true';
  });
  void ready.catch(error => {
    if (disposed) return;
    const status = required('#pv-load'); status.dataset.result = 'refused';
    status.textContent = t(error instanceof Error ? error.message : 'PARTS_PAINT_FAILED');
  });
  const stageApi = {snapshot: () => mounted.snapshot()};
  if (embedded) (window as StagePartsWindow).rigReviewStageParts = stageApi;
  workspace = {...mounted, ready, dispose() {
    if (disposed) return;
    disposed = true; receiveSource();
    mounted.dispose();
    for (const dispose of disposers.splice(0)) dispose();
    for (const cancel of pendingImages) cancel();
    for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    objectUrls.clear(); actions.replaceChildren();
    if ((window as StagePartsWindow).rigReviewStageParts === stageApi) delete (window as StagePartsWindow).rigReviewStageParts;
  }};
  return workspace;
}

if (typeof document !== 'undefined' && document.getElementById('parts-app')) void bootPartsPage();
