import { bindDomI18n, setLanguagePreference, setLinkLanguage } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { connectLiveWindow } from './live-connection.ts';
import { bindStageNav, type StagePartsState } from './stage-nav.ts';
import { parsePartsIssue, type PartsIssue } from '../src/parts-comment.ts';
import { mountPartsWorkspace, type PartsHost, type PartsSource, type PartsWorkspaceHandle, type ViewData } from './parts.ts';

export function bootPartsPage(): PartsWorkspaceHandle {
  const access = pageInstanceAccess();
  const url = typeof location !== 'undefined' ? new URL(location.href) : new URL('http://127.0.0.1/');
  const stageEmbedded = url.searchParams.get('stageEmbed') === '1';
  const stageSide = url.searchParams.get('side');
  let stageBuild = 'inspected';
  let stageRestore: StagePartsState | null = null;
  let currentView: ViewData | null = null;
  let receiveSource: () => void = () => {};
  const sourceReady = new Promise<void>(resolve => { receiveSource = resolve; });

  const stageHeaders = () => access.headers(stageEmbedded ? { 'X-Review-Stage-Build': stageBuild } : {});
  const partsApi = stageEmbedded
    ? (stageSide === 'a' || stageSide === 'b' ? `/api/compare/${stageSide}/stage-parts` : '/api/stage-parts')
    : '/api/parts';

  let workspace: PartsWorkspaceHandle | null = null;

  const onMessage = (event: MessageEvent) => {
    if (typeof location === 'undefined' || event.source !== parent || event.origin !== location.origin) return;
    const msg = event.data;
    if (msg?.type === 'review-stage-source' && (msg.buildId === 'inspected' || /^[a-f0-9]{64}$/.test(msg.buildId))) {
      stageBuild = msg.buildId;
      stageRestore = msg.state ?? null;
      receiveSource();
      return;
    }
    if (msg?.type === 'review-stage-language' && (msg.language === 'en' || msg.language === 'ko')) {
      setLinkLanguage(null);
      setLanguagePreference(msg.language);
      return;
    }
    if (msg?.type === 'review-stage-restore' && msg.state) {
      void workspace?.restore(msg.state);
      return;
    }
    if (msg?.type === 'review-stage-revalidate') {
      if (msg.buildId === 'inspected' || (typeof msg.buildId === 'string' && /^[a-f0-9]{64}$/.test(msg.buildId))) {
        stageBuild = msg.buildId;
      }
      void workspace?.revalidate(msg.buildId, msg.state);
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('message', onMessage);

  bindDomI18n(document);
  bindStageNav({ partsOnly: true, model: false });
  connectLiveWindow(access);

  const source: PartsSource = {
    async view(): Promise<ViewData> {
      if (stageEmbedded) await sourceReady;
      const res = await fetch(access.route(partsApi), { headers: stageHeaders() });
      const data = (await res.json()) as ViewData & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Save failed.');
      currentView = data;
      return data;
    },
    async image(part: string): Promise<Blob> {
      const item = currentView?.items.find(i => i.name === part);
      if (!item) throw new Error('PARTS_PAINT_FAILED');
      const res = await fetch(access.route(`${partsApi}/image/${item.index}`), { headers: stageHeaders() });
      if (!res.ok) throw new Error(stageEmbedded ? 'STAGE_DRAFT_CHANGED' : 'PARTS_PAINT_FAILED');
      return res.blob();
    },
    async page(name: string): Promise<Blob> {
      const page = currentView?.pages.find(p => p.name === name);
      if (!page) throw new Error('PARTS_PAINT_FAILED');
      const res = await fetch(access.route(`${partsApi}/page/${page.index}`), { headers: stageHeaders() });
      if (!res.ok) throw new Error(stageEmbedded ? 'STAGE_DRAFT_CHANGED' : 'PARTS_PAINT_FAILED');
      return res.blob();
    },
    async painting(): Promise<Blob | null> {
      const res = await fetch(access.route('/api/parts/painting'), { headers: stageHeaders() });
      if (!res.ok) return null;
      return res.blob();
    },
    async difference(part: string, threshold: number, footprints: boolean) {
      const item = currentView?.items.find(i => i.name === part);
      if (!item) throw new Error('PARTS_PAINT_FAILED');
      const res = await fetch(access.route(`${partsApi}/difference/${item.index}?threshold=${threshold}&footprints=${footprints}`), { headers: stageHeaders() });
      if (!res.ok) {
        const out = (await res.json()) as { error: string };
        throw new Error(out.error);
      }
      return {
        png: await res.blob(),
        count: Number(res.headers.get('X-Difference-Count') ?? 0),
        covered: Number(res.headers.get('X-Difference-Covered') ?? 0),
        compared: Number(res.headers.get('X-Difference-Compared') ?? 0),
      };
    },
    async crop(issue: PartsIssue): Promise<PartsIssue> {
      const res = await fetch(access.route('/api/parts/comment'), {
        method: 'POST',
        headers: access.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(issue),
      });
      const out = (await res.json()) as { comment: PartsIssue; error?: string };
      if (!res.ok) throw new Error(out.error);
      return parsePartsIssue(out.comment, true, true, false);
    },
  };

  const host: PartsHost = {
    locked(): boolean {
      return Boolean(currentView?.legacyVerdict?.readOnly) || (stageEmbedded && (!currentView?.joinedVerdictBinding || !access.capability || stageBuild !== 'inspected'));
    },
    changed(_issues: PartsIssue[]): void {},
  };

  const slots = {
    left: document.querySelector<HTMLElement>('.pv-list') ?? undefined,
    stage: document.querySelector<HTMLElement>('.pv-stage') ?? undefined,
    toolbar: document.querySelector<HTMLElement>('.pv-toolbar') ?? undefined,
    side: document.querySelector<HTMLElement>('.pv-side') ?? undefined,
  };

  const mounted = mountPartsWorkspace(slots, source, host, {
    stageEmbedded,
    stageSide,
    stageBuild,
    get initialRestore() { return stageRestore; },
    sourceReady,
    access,
    async saveVerdict(body) {
      const headers = stageEmbedded ? stageHeaders() : access.headers();
      headers.set('Content-Type', 'application/json');
      const res = await fetch(access.route(stageEmbedded ? `${partsApi}/verdict` : '/api/parts/verdict'), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const out = (await res.json()) as { error?: string; verdict?: { source: { sha256: string } } };
      return { ok: res.ok, ...out };
    },
  });
  workspace = {
    ...mounted,
    dispose(): void {
      if (typeof window !== 'undefined') window.removeEventListener('message', onMessage);
      mounted.dispose();
    },
  };
  return workspace;
}

if (typeof document !== 'undefined' && document.getElementById('parts-app')) void bootPartsPage();
