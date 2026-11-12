import {panelMake} from './view-controls.ts';
import {mountStatusBar, mountWorkspaceShell} from './workspace-ui.ts';

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

/** Shared composition preserves each host's original header status, rows and retained stage. */
export function mountRetainedWorkspace(options: {root: HTMLElement; kind: 'owner'}) {
  const {root, kind} = options;
  root.dataset.retainedWorkspace = kind;
  const shell = mountWorkspaceShell({compatibility: 'legacyOwnerStep6'});
  const {header, title} = shell, language = shell.language!;
  const {message} = mountStatusBar({placement: 'inline', message: shell.status!});
  const list = panelMake('nav', {className: 'owner-list'});
  const stage = panelMake('main', {className: 'owner-stage'});
  root.replaceChildren(header, list, stage);
  function render(view: {
    lang: string;
    heading: string;
    listLabel: string;
    languageLabel: string;
    englishLabel: string;
    koreanLabel: string;
    message?: string;
    selected: string | null;
    items: readonly RetainedSubjectItem[];
  }) {
    document.documentElement.lang = view.lang;
    title.textContent = view.heading;
    document.title = view.heading;
    list.setAttribute('aria-label', view.listLabel);
    language.setAttribute('aria-label', view.languageLabel);
    language.options[0]!.textContent = view.englishLabel;
    language.options[1]!.textContent = view.koreanLabel;
    language.value = view.lang;
    if (view.message !== undefined) message.textContent = view.message;
    list.replaceChildren();
    for (const item of view.items) {
      const button = panelMake('button', {type: 'button'});
      for (const [name, value] of Object.entries(item.dataset)) button.dataset[name] = value;
      button.setAttribute('aria-pressed', String(item.key === view.selected));
      const label = panelMake('span', {textContent: item.label});
      label.className = 'owner-target-title';
      const state = panelMake('span', {className: 'owner-target-status', textContent: item.state});
      const detail = panelMake('span', {className: 'owner-target-animation', textContent: item.detail ?? ''});
      button.append(label, state, detail);
      button.onclick = item.onSelect;
      list.append(button);
    }
  }
  return {list, stage, language, message, render};
}
