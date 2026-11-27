import {createRetainedFrameStage, mountRetainedWorkspace} from './retained-frame-stage.ts';
import {hashCapabilityAccess} from './instance-access.ts';
import {WORKSPACE_TARGET_LIMIT, WORKSPACE_READY_SCHEMA, WORKSPACE_SCHEMA, WORKSPACE_TARGET_DOMAIN, WORKSPACE_VISIBILITY_SCHEMA,
  type WorkspaceList, type WorkspaceTargetView} from '../src/open-workspace-contract.ts';
import {getLanguage, onLanguageChange, setLanguagePreference, setLinkLanguage, tr} from './i18n.ts';
import {connectLiveWindow} from './live-connection.ts';
import {WORKSPACE_MODE_REQUEST_SCHEMA, WORKSPACE_MODE_STATE_SCHEMA, workspaceModes, type WorkspaceModeState} from './workspace-visibility.ts';

export function mountOwnerWorkspace(root: HTMLElement): () => void {
  const workspace = mountRetainedWorkspace({root, kind: 'owner'});
  const {stage, language, message: status} = workspace;
  let current: WorkspaceList | null = null, disposed = false, notice = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = new AbortController();
  const identity = (target: WorkspaceTargetView) => ({incarnation: current?.incarnation, key: target.key, sourceHash: target.contentHash});
  const retained = createRetainedFrameStage<{frame: HTMLIFrameElement; target: WorkspaceTargetView; modes?: WorkspaceModeState[]}>({
    stage, limit: () => WORKSPACE_TARGET_LIMIT, key: entry => entry.target.key,
    message: entry => ({schema: WORKSPACE_VISIBILITY_SCHEMA, ...identity(entry.target)}),
    language: getLanguage, origin: location.origin, visibilityOrder: 'before-state', languageChange: 'visibility',
  });
  const capability = hashCapabilityAccess(new URL(location.href), 'rig-review-owner-workspace/1:' + location.origin,
    () => sessionStorage, href => history.replaceState(history.state, '', href), {strip: 'always-after-storage', storedValue: 'preserve', fallback: ''});
  const hint = 'Select a target. Drafts stay with their original source.';
  const showNotice = (message: string) => {notice = message; status.textContent = tr(message);};

  async function grant(key: string) {
    const encoder = new TextEncoder();
    const secret = await crypto.subtle.importKey('raw', encoder.encode(capability), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', secret, encoder.encode(WORKSPACE_TARGET_DOMAIN + '\0' + current!.incarnation + '\0' + key));
    return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async function select(target: WorkspaceTargetView) {
    if (disposed) return;
    const intent = retained.beginSelection();
    if (target.unavailable) {showNotice(target.unavailable); return;}
    let entry = retained.get(target.key);
    if (!entry) {
      if (retained.atLimit()) {showNotice('WORKSPACE_TARGET_LIMIT'); return;}
      const token = await grant(target.key);
      if (!retained.isCurrent(intent)) return;
      const frame = retained.createFrame(target.title, target.entry + '&lang=' + getLanguage() + '#cap=' + token);
      // #655 slice 4 / #1213 owns legacy Compare chrome, including its build picker and feedback actions.
      if (target.mode !== 'compare') frame.dataset.stageEmbed = 'owner';
      entry = {frame, target}; retained.retain(entry);
    }
    retained.select(target.key);
    showNotice(hint);
    render();
  }

  const selected = () => retained.get(retained.selected ?? '');
  function renderModes() {
    const entry = selected();
    workspace.renderModes(entry?.frame.dataset.stageEmbed === 'owner', entry?.modes);
  }
  function render() {
    renderModes();
    status.textContent = tr(notice);
    workspace.render({
      lang: getLanguage(), heading: selected()?.target.title ?? '', listLabel: tr('Review targets'),
      selected: retained.selected,
      items: (current?.targets ?? []).map(target => ({
        key: target.key, dataset: {targetKey: target.key}, label: target.title,
        state: tr(target.unavailable ?? (target.viewOnly ? 'Inspection only' : 'Review target')),
        detail: target.animation,
        onSelect: () => {void select(target).catch(() => {showNotice('WORKSPACE_REQUEST_REFUSED');});},
      })),
    });
  }

  async function refresh() {
    try {
      if (!capability) {showNotice('WORKSPACE_CAPABILITY_REQUIRED'); return;}
      const response = await fetch('/workspace/api/targets', {
        headers: {'X-Review-Capability': capability}, signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(5000)]),
      });
      const value = await response.json() as WorkspaceList & {error?: string};
      if (!response.ok) {showNotice(value.error ?? 'WORKSPACE_REQUEST_REFUSED'); return;}
      if (value.schema !== WORKSPACE_SCHEMA || !Array.isArray(value.targets) || value.targets.length > WORKSPACE_TARGET_LIMIT ||
          current && current.incarnation !== value.incarnation) {showNotice('WORKSPACE_HOST_MISMATCH'); return;}
      const changed = JSON.stringify(value) !== JSON.stringify(current);
      if (!current) showNotice(hint);
      current = value;
      if (changed) render();
      if (!retained.selected && value.targets[0]) await select(value.targets[0]);
    } catch {if (!disposed) showNotice('WORKSPACE_REQUEST_REFUSED');}
    finally {if (!disposed) timer = setTimeout(() => {void refresh();}, 1000);}
  }

  function receive(event: MessageEvent) {
    if (event.origin !== location.origin || !current || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.incarnation !== current.incarnation || typeof value.key !== 'string') return;
    const entry = retained.get(value.key);
    if (!entry || !event.source || entry.frame.contentWindow !== event.source || entry.target.contentHash !== value.sourceHash) return;
    if (value.schema === WORKSPACE_READY_SCHEMA) {retained.visibility(entry); return;}
    const modes: unknown = value.modes;
    if (value.schema !== WORKSPACE_MODE_STATE_SCHEMA || entry.frame.dataset.stageEmbed !== 'owner' ||
        !Array.isArray(modes) || modes.length !== workspaceModes.length ||
        !workspaceModes.every((_, index) => {
          const mode = modes[index];
          return mode && typeof mode.pressed === 'boolean' && typeof mode.disabled === 'boolean' &&
            (mode.title === null || typeof mode.title === 'string' && mode.title.length <= 512);
        }) ||
        modes.filter(mode => mode.pressed).length > 1) return;
    entry.modes = modes;
    if (entry === selected()) renderModes();
  }
  window.addEventListener('message', receive);
  workspace.onMode(mode => {
    const entry = selected();
    if (entry?.modes?.[workspaceModes.indexOf(mode)]?.disabled === false) {
      entry.frame.contentWindow?.postMessage({schema: WORKSPACE_MODE_REQUEST_SCHEMA, ...identity(entry.target), mode}, location.origin);
    }
  });
  language.onchange = () => {setLinkLanguage(null); setLanguagePreference(language.value === 'ko' ? 'ko' : 'en');};
  const unlocalize = onLanguageChange(() => {render(); retained.languageChanged();});
  const disconnect = connectLiveWindow({route: () => '/workspace/live'});
  const stop = () => {
    if (disposed) return;
    disposed = true; retained.dispose(); workspace.dispose(); clearTimeout(timer); cancellation.abort(); disconnect(); unlocalize();
    language.onchange = null;
    window.removeEventListener('message', receive); window.removeEventListener('pagehide', stop);
  };
  window.addEventListener('pagehide', stop, {once: true});
  render();
  void refresh();
  return stop;
}
