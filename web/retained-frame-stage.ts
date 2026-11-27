import {panelMake} from './view-controls.ts';
import {bindWorkspaceUI, mountStatusBar, mountWorkspaceShell} from './workspace-ui.ts';
import {t, unbindDomI18n} from './i18n.ts';
import {workspaceModeButtons, type WorkspaceMode, type WorkspaceModeState} from './workspace-visibility.ts';

/** Retains each child window and its draft; hosts supply only identity and protocol fields. */
export function createRetainedFrameStage<Entry extends {frame: HTMLIFrameElement}>(options: {
  stage: HTMLElement;
  limit(): number;
  key(entry: Entry): string;
  message(entry: Entry): object;
  language(): string;
  origin: string;
  visibilityOrder: 'before-state' | 'after-state';
  languageChange: 'selection' | 'visibility';
}) {
  const frames = new Map<string, Entry>();
  let selected: string | null = null, intent = 0, disposed = false;
  function visibility(entry: Entry) {
    entry.frame.contentWindow?.postMessage({...options.message(entry),
      visible: options.key(entry) === selected, language: options.language()}, options.origin);
  }
  function showSelection() {
    for (const entry of frames.values()) {
      if (options.visibilityOrder === 'before-state') visibility(entry);
      entry.frame.hidden = options.key(entry) !== selected;
      entry.frame.inert = entry.frame.hidden;
      entry.frame.setAttribute('aria-hidden', String(entry.frame.hidden));
      if (options.visibilityOrder === 'after-state') visibility(entry);
    }
  }
  return {
    get selected() {return selected;},
    get: (key: string) => frames.get(key),
    createFrame(title: string, src: string) {
      const frame = document.createElement('iframe'); frame.title = title; frame.hidden = true; frame.src = src;
      frame.setAttribute('translate', 'no');
      return frame;
    },
    atLimit: () => frames.size >= options.limit(),
    retain(entry: Entry) {frames.set(options.key(entry), entry); options.stage.append(entry.frame);},
    beginSelection: () => ++intent,
    isCurrent: (selection: number) => !disposed && selection === intent,
    select(key: string) {selected = key; showSelection();},
    visibility,
    languageChanged() {
      if (options.languageChange === 'selection') showSelection();
      else for (const entry of frames.values()) visibility(entry);
    },
    dispose() {disposed = true;},
  };
}

export interface RetainedSubjectItem {
  key: string;
  dataset: Readonly<Record<string, string>>;
  label: string;
  state: string;
  detail: string | null;
  onSelect(): void;
}

/** Compose retained targets with the shared header, side panel and status bar. */
export function mountRetainedWorkspace(options: {root: HTMLElement; kind: 'owner'}) {
  const {root, kind} = options;
  root.dataset.retainedWorkspace = kind;
  const shell = mountWorkspaceShell({compatibility: 'owner'});
  const {header, title} = shell, language = shell.language!, modeSwitch = shell.modeSwitch!;
  title.setAttribute('translate', 'no');
  const {footer, message} = mountStatusBar({message: '', readouts: []});
  const list = panelMake('nav', {className: 'owner-list'});
  const heading = panelMake('h2');
  const collapse = panelMake('button', {type: 'button', textContent: '‹'});
  collapse.setAttribute('aria-label', 'Review targets');
  const panelHeader = panelMake('div', {className: 'left-header'}, heading, collapse);
  panelHeader.classList.add('owner-targets-header');
  const left = panelMake('aside', {className: 'left-panel'}, panelHeader, list);
  const stage = panelMake('div', {className: 'owner-stage'});
  const main = panelMake('main', {}, stage);
  const layout = panelMake('div', {className: 'layout'}, left, main);
  root.replaceChildren(header, layout, footer);
  const ui = bindWorkspaceUI({root, regions: {left, stage, main, layout}, leftCollapse: collapse, changed: () => {}, defaultTheme: () => {}});
  const modes = workspaceModeButtons(modeSwitch);
  function renderModes(show: boolean, state?: readonly WorkspaceModeState[]) {
    modeSwitch.hidden = !show;
    for (const [index, button] of modes.entries()) {
      const mode = state?.[index];
      button.disabled = mode?.disabled ?? true;
      button.setAttribute('aria-pressed', String(mode?.pressed ?? false));
      for (const attribute of ['title', 'aria-description']) {
        if (mode?.title) button.setAttribute(attribute, mode.title);
        else button.removeAttribute(attribute);
      }
    }
  }
  function render(view: {
    lang: string;
    heading: string;
    listLabel: string;
    selected: string | null;
    items: readonly RetainedSubjectItem[];
  }) {
    document.documentElement.lang = view.lang;
    title.textContent = view.heading;
    document.title = view.heading || 'rig review';
    heading.textContent = t('Targets · {count}', {count: view.items.length});
    list.setAttribute('aria-label', view.listLabel);
    language.value = view.lang;
    list.replaceChildren();
    for (const item of view.items) {
      const button = panelMake('button', {type: 'button'});
      for (const [name, value] of Object.entries(item.dataset)) button.dataset[name] = value;
      button.setAttribute('aria-pressed', String(item.key === view.selected));
      const label = panelMake('span', {className: 'owner-target-title', textContent: item.label});
      label.setAttribute('translate', 'no');
      const state = panelMake('span', {className: 'owner-target-status', textContent: item.state});
      const detail = panelMake('span', {className: 'owner-target-animation', textContent: item.detail ?? ''});
      detail.setAttribute('translate', 'no');
      button.append(label, state, detail);
      button.onclick = item.onSelect;
      list.append(button);
    }
  }
  return {stage, language, message, render, renderModes,
    onMode(select: (mode: WorkspaceMode) => void) {
      for (const button of modes) button.onclick = () => select(button.dataset.mode as WorkspaceMode);
    },
    dispose() {
      for (const button of modes) button.onclick = null;
      ui.dispose(); unbindDomI18n();
    }};
}
