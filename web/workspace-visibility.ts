import {WORKSPACE_READY_SCHEMA, WORKSPACE_VISIBILITY_SCHEMA} from '../src/open-workspace-contract.ts';
import {setLanguagePreference, setLinkLanguage} from './i18n.ts';

export const WORKSPACE_MODE_STATE_SCHEMA = 'rig-review-workspace-mode-state/1';
export const WORKSPACE_MODE_REQUEST_SCHEMA = 'rig-review-workspace-mode-request/1';
export const WORKSPACE_LANGUAGE_CHOICE_SCHEMA = 'rig-review-workspace-language-choice/1';
export const workspaceModes = ['rig', 'playback', 'compare'] as const;
export type WorkspaceMode = typeof workspaceModes[number];
export type WorkspaceModeState = {pressed: boolean; disabled: boolean; title: string | null};

export function workspaceModeButtons(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>('button')].filter(button => workspaceModes.some(mode => mode === button.dataset.mode));
}

/** Same-origin shipped frames still validate the exact parent and displayed source. */
export function bindWorkspaceVisibility(binding: {key: string; sourceHash: string; pause(): void; modeSwitch?: HTMLElement}) {
  const incarnation = new URL(location.href).searchParams.get('workspace');
  if (parent === window || !incarnation) return;
  const identity = {incarnation, key: binding.key, sourceHash: binding.sourceHash};
  const buttons = binding.modeSwitch ? workspaceModeButtons(binding.modeSwitch) : [];
  const comparePicker = location.pathname === `/instances/${binding.key}/` &&
    window.frameElement?.getAttribute('data-workspace-locale') === 'legacy-compare'
    ? document.getElementById('settings-language') as HTMLSelectElement | null : null;
  let visible = false, reported = '';
  const chooseLanguage = () => {
    const language = comparePicker?.value;
    if (visible && (language === 'en' || language === 'ko')) {
      parent.postMessage({schema: WORKSPACE_LANGUAGE_CHOICE_SCHEMA, ...identity, language}, location.origin);
    }
  };
  // Read the explicit selection before the existing Settings handler persists and re-renders it.
  comparePicker?.addEventListener('change', chooseLanguage, true);
  const reportMode = () => {
    const modes = buttons.map(button => ({pressed: button.getAttribute('aria-pressed') === 'true',
      disabled: button.disabled, title: button.getAttribute('aria-description') ?? button.getAttribute('title')}));
    const snapshot = JSON.stringify(modes);
    if (snapshot === reported) return;
    reported = snapshot;
    parent.postMessage({schema: WORKSPACE_MODE_STATE_SCHEMA, ...identity, modes}, location.origin);
  };
  const observer = binding.modeSwitch && new MutationObserver(reportMode);
  if (observer) for (const button of buttons) observer.observe(button, {attributes: true,
    attributeFilter: ['aria-pressed', 'aria-description', 'disabled', 'title']});
  const receive = (event: MessageEvent) => {
    if (event.origin !== location.origin || event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const value = event.data;
    if (value.incarnation !== incarnation || value.key !== binding.key || value.sourceHash !== binding.sourceHash) return;
    if (value.schema === WORKSPACE_MODE_REQUEST_SCHEMA) {
      if (visible) buttons.find(button => !button.disabled && button.dataset.mode === value.mode)?.click();
      return;
    }
    if (value.schema !== WORKSPACE_VISIBILITY_SCHEMA || typeof value.visible !== 'boolean') return;
    visible = value.visible;
    if (!visible) binding.pause();
    if (value.language === 'en' || value.language === 'ko') {
      setLinkLanguage(binding.modeSwitch || comparePicker ? value.language : null);
      setLanguagePreference(value.language);
      if (comparePicker) comparePicker.value = value.language;
    }
  };
  window.addEventListener('message', receive);
  const stop = () => {
    observer?.disconnect(); comparePicker?.removeEventListener('change', chooseLanguage, true);
    window.removeEventListener('message', receive); window.removeEventListener('pagehide', stop);
  };
  window.addEventListener('pagehide', stop, {once: true});
  parent.postMessage({schema: WORKSPACE_READY_SCHEMA, ...identity}, location.origin);
  if (buttons.length) reportMode();
  return stop;
}
