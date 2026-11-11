import {mountWorkspaceShell} from './workspace-ui.ts';
import {createRetainedFrameStage} from './retained-frame-stage.ts';
import {hashCapabilityAccess} from './instance-access.ts';
import {WORKSPACE_TARGET_LIMIT, WORKSPACE_READY_SCHEMA, WORKSPACE_SCHEMA, WORKSPACE_TARGET_DOMAIN, WORKSPACE_VISIBILITY_SCHEMA,
  type WorkspaceList, type WorkspaceTargetView} from '../src/open-workspace-contract.ts';
import {getLanguage, onLanguageChange, setLanguagePreference, setLinkLanguage, tr} from './i18n.ts';
import {connectLiveWindow} from './live-connection.ts';

export function mountOwnerWorkspace(root: HTMLElement): () => void {
  const shell = mountWorkspaceShell({compatibility: 'legacyOwnerStep6'});
  const {header} = shell, heading = shell.title, status = shell.status!, language = shell.language!;
  const list = document.createElement('nav'); list.className = 'owner-list';
  const stage = document.createElement('main'); stage.className = 'owner-stage';
  root.append(header, list, stage);
  let current: WorkspaceList | null = null, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  const retained = createRetainedFrameStage<{frame: HTMLIFrameElement; target: WorkspaceTargetView}>({
    stage, limit: () => WORKSPACE_TARGET_LIMIT, key: entry => entry.target.key,
    message: entry => ({schema: WORKSPACE_VISIBILITY_SCHEMA,
      incarnation: current?.incarnation, key: entry.target.key, sourceHash: entry.target.contentHash}),
    language: getLanguage, origin: location.origin, visibilityOrder: 'before-state', languageChange: 'visibility',
  });
  const capability = hashCapabilityAccess(new URL(location.href), 'rig-review-owner-workspace/1:' + location.origin,
    () => sessionStorage, href => history.replaceState(history.state, '', href), {strip: 'always-after-storage', storedValue: 'preserve', fallback: ''});

  function text() {
    document.documentElement.lang = getLanguage();
    heading.textContent = tr('Review workspace'); document.title = tr('Review workspace');
    list.setAttribute('aria-label', tr('Review targets'));
    language.setAttribute('aria-label', tr('Language'));
    language.options[0]!.textContent = tr('English'); language.options[1]!.textContent = tr('Korean');
    language.value = getLanguage();
  }

  async function grant(key: string) {
    const encoder = new TextEncoder();
    const secret = await crypto.subtle.importKey('raw', encoder.encode(capability), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(WORKSPACE_TARGET_DOMAIN + '\0' + current!.incarnation + '\0' + key));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function select(target: WorkspaceTargetView) {
    const intent = retained.beginSelection();
    if (target.unavailable) {status.textContent = tr(target.unavailable); return;}
    let entry = retained.get(target.key);
    if (!entry) {
      if (retained.atLimit()) {status.textContent = tr('WORKSPACE_TARGET_LIMIT'); return;}
      const token = await grant(target.key);
      if (!retained.isCurrent(intent)) return;
      const frame = retained.createFrame(target.title, target.entry + '&lang=' + getLanguage() + '#cap=' + token);
      entry = {frame, target}; retained.retain(entry);
    }
    retained.select(target.key);
    render();
  }

  function render() {
    text(); list.replaceChildren();
    for (const target of current?.targets ?? []) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.targetKey = target.key; button.setAttribute('aria-pressed', String(target.key === retained.selected));
      const title = document.createElement('span'); title.className = 'owner-target-title'; title.textContent = target.title;
      const state = document.createElement('span'); state.className = 'owner-target-status';
      state.textContent = tr(target.unavailable ?? (target.viewOnly ? 'Inspection only' : 'Review target'));
      const animation = document.createElement('span'); animation.className = 'owner-target-animation'; animation.textContent = target.animation;
      button.append(title, state, animation); button.onclick = () => {void select(target).catch(() => {status.textContent = tr('WORKSPACE_REQUEST_REFUSED');});};
      list.append(button);
    }
  }

  async function refresh() {
    try {
      if (!capability) {status.textContent = tr('WORKSPACE_CAPABILITY_REQUIRED'); return;}
      const response = await fetch('/workspace/api/targets', {
        headers: {'X-Review-Capability': capability}, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
      });
      const value = await response.json() as WorkspaceList & {error?: string};
      if (!response.ok) {status.textContent = tr(value.error ?? 'WORKSPACE_REQUEST_REFUSED'); return;}
      if (value.schema !== WORKSPACE_SCHEMA || !Array.isArray(value.targets) || value.targets.length > WORKSPACE_TARGET_LIMIT ||
          current && current.incarnation !== value.incarnation) {status.textContent = tr('WORKSPACE_HOST_MISMATCH'); return;}
      const changed = JSON.stringify(value) !== JSON.stringify(current);
      if (!current) status.textContent = tr('Select a target. Drafts stay with their original source.');
      current = value;
      if (changed) render();
      if (!retained.selected && value.targets[0]) await select(value.targets[0]);
    } catch {if (!disposed) status.textContent = tr('WORKSPACE_REQUEST_REFUSED');}
    finally {if (!disposed) timer = setTimeout(() => {void refresh();}, 1000);}
  }

  function ready(event: MessageEvent) {
    if (event.origin !== location.origin || !current || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.schema !== WORKSPACE_READY_SCHEMA || value.incarnation !== current.incarnation) return;
    const entry = retained.get(value.key);
    if (entry && entry.frame.contentWindow === event.source && entry.target.contentHash === value.sourceHash) retained.visibility(entry);
  }
  window.addEventListener('message', ready);
  language.onchange = () => {setLinkLanguage(null); setLanguagePreference(language.value === 'ko' ? 'ko' : 'en');};
  const unlocalize = onLanguageChange(() => {render(); retained.languageChanged();});
  const disconnect = connectLiveWindow({route: () => '/workspace/live'});
  const stop = () => {
    if (disposed) return;
    disposed = true; retained.dispose(); clearTimeout(timer); cancellation.abort(); disconnect(); unlocalize();
    window.removeEventListener('message', ready); window.removeEventListener('pagehide', stop);
  };
  window.addEventListener('pagehide', stop, {once: true});
  text();
  void refresh();
  return stop;
}

if (typeof document !== 'undefined') {
  const root = document.getElementById('owner-workspace');
  if (root) mountOwnerWorkspace(root);
}
