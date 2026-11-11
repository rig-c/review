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
  kindLabel: string;
  label: string;
  hash: string | null;
  answered?: boolean;
  onSelect(): void;
}

/** Shared shell, subject list (waiting + collapsed answered group), retained stage and C11 status bar. */
export function mountRetainedWorkspace(options: {root: HTMLElement; kind: 'hub' | 'owner'}) {
  const {root, kind} = options;
  root.dataset.retainedWorkspace = kind;
  const shell = mountWorkspaceShell({compatibility: kind === 'hub' ? 'legacyHubStep6' : 'legacyOwnerStep6'});
  const {header, title} = shell, notice = shell.status!, language = shell.language!;
  const list = panelMake('nav', {className: kind === 'hub' ? 'hub-list' : 'owner-list'});
  const stage = panelMake('main', {className: kind === 'hub' ? 'hub-stage' : 'owner-stage'});
  const source = panelMake('span', {className: ['status-source', 'retained-source-hash'].join(' ')});
  const statusBar = mountStatusBar({message: '', readouts: [], source});
  root.replaceChildren(header, list, stage, statusBar.footer);
  let answeredOpen = false;
  function setStatus(message: string, selectedHash?: string | null) {
    notice.textContent = message;
    statusBar.message.textContent = message;
    if (selectedHash !== undefined) source.textContent = selectedHash ?? '';
  }
  function makeButton(item: RetainedSubjectItem, selected: string | null) {
    const button = panelMake('button', {type: 'button'});
    for (const [name, value] of Object.entries(item.dataset)) button.dataset[name] = value;
    button.setAttribute('aria-pressed', String(item.key === selected));
    const kindNode = panelMake('span', {
      className: ['subject-row-kind', ...(kind === 'owner' ? ['owner-target-status'] : [])].join(' '),
      textContent: item.kindLabel,
    });
    const hashNode = panelMake('span', {
      className: 'subject-row-hash',
      textContent: item.hash ? item.hash.slice(0, 8) : '',
    });
    const labelNode = panelMake('span', {
      className: ['subject-row-label', ...(kind === 'owner' ? ['owner-target-title'] : [])].join(' '),
      textContent: item.label,
    });
    button.append(kindNode, hashNode, labelNode);
    button.onclick = item.onSelect;
    return button;
  }
  function render(view: {
    lang: string;
    heading: string;
    listLabel: string;
    languageLabel: string;
    englishLabel: string;
    koreanLabel: string;
    message: string;
    selected: string | null;
    selectedHash: string | null;
    answeredLabel?: (count: number) => string;
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
    setStatus(view.message, view.selectedHash);
    const waiting = view.items.filter(item => !item.answered);
    const answered = view.items.filter(item => item.answered);
    list.replaceChildren(...waiting.map(item => makeButton(item, view.selected)));
    if (answered.length > 0 && view.answeredLabel) {
      const details = panelMake('details', {className: 'subject-answered-group'}) as HTMLDetailsElement;
      details.open = answeredOpen;
      if (answeredOpen) details.setAttribute('open', '');
      const summary = panelMake('summary', {
        className: 'subject-answered-summary',
        textContent: view.answeredLabel(answered.length),
      });
      details.append(summary, ...answered.map(item => makeButton(item, view.selected)));
      details.addEventListener?.('toggle', () => {answeredOpen = details.open;});
      list.append(details);
    }
  }
  return {header, list, stage, footer: statusBar.footer, message: statusBar.message, source, language, setStatus, render};
}
