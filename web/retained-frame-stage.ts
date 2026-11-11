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
