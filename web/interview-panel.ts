import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { onLanguageChange, t } from './i18n.ts';
import type { InstanceAccess } from './instance-access.ts';
import { bindWorkspaceDrawer } from './workspace-layout.ts';

type Question = Omit<InterviewQuestion,'images'> & {images:{name:string;url:string}[]; saved:Picks|null};
type Ask = InterviewQuestion['set']['asks'][number];
type Pick = Picks['picks'][number];
/** Element factory: the stage interview translates with `t`; the job page tags `data-job-text` for its own relocalize. */
export type InterviewText = <K extends keyof HTMLElementTagNameMap>(tag: K, key?: string) => HTMLElementTagNameMap[K];
export const interviewErrors: Readonly<Record<string,string>> = {
  INTERVIEW_UNAVAILABLE:'INTERVIEW_UNAVAILABLE: No interview is attached to this inspection.',
  INTERVIEW_SOURCE_MISMATCH:'interview.mismatch',
  INTERVIEW_CHOICE_INVALID:'interview.invalid',
  INTERVIEW_CHOICE_CONSTRAINT:'interview.constraint',
  INTERVIEW_CHOICE_REQUIRED:'interview.required',
  INTERVIEW_CONTEXT_KIND_UNSUPPORTED:'INTERVIEW_CONTEXT_KIND_UNSUPPORTED',
  INTERVIEW_OPTIONS_INVALID:'interview.invalidOptions',
  INTERVIEW_OPTIONS_FILE:'interview.file',
  INTERVIEW_OPTIONS_STALE:'interview.stale',
  INTERVIEW_PICKS_OUTPUT:'interview.output',
};
function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  return el;
}
const translated: InterviewText = (tag, key) => element(tag, key === undefined ? undefined : t(key));
function errorKey(error: unknown) {
  return error instanceof Error ? interviewErrors[error.message] ?? 'interview.failed' : 'interview.failed';
}
async function request(access: InstanceAccess, path: string, body?: Picks) {
  const response = await fetch(access.route(path), body ? {
    method:'POST', headers:access.headers({'Content-Type':'application/json'}), body:JSON.stringify(body),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

/** The `rig-review/interview-picks@1` record exactly as the stage interview has always posted it (key order is the file's bytes). */
export function interviewPicksRecord(ref: Picks['set'], picks: readonly Pick[], note: string | undefined, at: string): Picks {
  return {schema:'rig-review/interview-picks@1', set:ref, picks:picks as Pick[], ...(note !== undefined ? {note} : {}), by:'user', at};
}
/** The job interview act value exactly as the job form has always submitted it. */
export function jobInterviewValue(questionId: string, asks: readonly Ask[], chosen: (ask: Ask) => {optionId: string; otherText: string},
    note: string): {questionId: string; selections: {itemId: string; optionId: string; otherText: string | null}[]; note: string} {
  return {questionId, selections:asks.map(ask => {
    const {optionId, otherText} = chosen(ask);
    return {itemId:ask.id, optionId, otherText:ask.options.find(option => option.id === optionId)?.kind === 'other' ? otherText : null};
  }), note};
}

/** One prompt as radio cards: label, effect, AI recommended badge and reason, inline Other text and the pending line.
 * Shared by the stage interview and the job interview; names let the job form keep its draft controls. */
export function interviewAskGroup(ask: Ask, options: {text?: InterviewText; name?: string; otherName?: string; pick?: Partial<Pick>;
    pendingHidden?: boolean; onPick?: (pick: Pick) => void; onOther?: (text: string) => void}): {group: HTMLFieldSetElement; value(): {optionId: string; otherText: string}} {
  const text = options.text ?? translated;
  const group = element('fieldset');
  group.className = 'interview-ask';
  group.append(element('legend', ask.prompt));
  const pick = options.pick;
  const other = element('textarea');
  if (options.otherName) other.name = options.otherName;
  other.setAttribute('aria-label', t('interview.other'));
  other.value = pick?.other_text ?? '';
  const kind = ask.options.find(option => option.id === pick?.option_id)?.kind;
  other.hidden = pick?.other_text === undefined && kind !== 'other';
  other.required = kind === 'other';
  other.oninput = () => options.onOther?.(other.value);
  const pending = text('p', kind === 'other' ? 'interview.otherPending' : 'interview.autoPending');
  pending.className = 'interview-pending';
  pending.hidden = options.pendingHidden ?? !(kind === 'auto' || kind === 'other');
  const radios = ask.options.map(option => {
    const label = element('label'); label.className = 'interview-option';
    const radio = element('input'); radio.type = 'radio'; radio.name = options.name ?? ask.id; radio.value = option.id;
    radio.required = true; radio.checked = option.id === pick?.option_id;
    radio.onchange = () => {
      if (!radio.checked) return;
      other.hidden = option.kind !== 'other';
      other.required = option.kind === 'other';
      pending.hidden = option.kind === 'value';
      const key = option.kind === 'other' ? 'interview.otherPending' : 'interview.autoPending';
      if (pending.dataset.jobText !== undefined) pending.dataset.jobText = key;
      pending.textContent = t(key);
      const next = {ask:ask.id, option_id:option.id};
      options.onPick?.(option.kind === 'other' ? {...next, other_text:other.value} : next);
    };
    label.append(radio, element('strong', option.label), element('span', option.effect));
    if (option.recommended) {
      const badge = text('b', 'interview.recommended'); badge.className = 'interview-recommended';
      label.dataset.recommended = '';
      label.append(badge, element('span', option.reason));
    }
    group.append(label);
    return radio;
  });
  group.append(other, pending);
  return {group, value:() => ({optionId:radios.find(radio => radio.checked)?.value ?? '', otherText:other.value})};
}

/** The modal's question list: "Answered n / total" and one button per question. */
export function interviewQuestionList(items: readonly {label: string; answered: boolean}[], selected: number,
    onSelect: ((index: number) => void) | null, disabled = false): HTMLElement {
  const nav = element('nav');
  nav.className = 'interview-questions';
  nav.setAttribute('aria-label', t('interview.question'));
  nav.append(element('p', t('interview.answered', [items.filter(item => item.answered).length, items.length])));
  const list = element('ol');
  items.forEach((item, index) => {
    const row = element('li');
    const button = element('button', item.label);
    button.type = 'button';
    button.className = 'interview-question';
    if (item.answered) button.dataset.answered = '';
    button.setAttribute('aria-current', String(index === selected));
    button.disabled = disabled || !onSelect;
    button.onclick = () => onSelect?.(index);
    row.append(button); list.append(row);
  });
  nav.append(list);
  return nav;
}

/** Create step 2 as a modal over the one review screen: the workspace drawer dialog (`bindWorkspaceDrawer`). */
export function interviewModal(options: {parent: HTMLElement; trigger: HTMLButtonElement; id: string; text?: InterviewText;
    onOpen?: () => void; onClose?: () => void}): {dialog: HTMLDialogElement; body: HTMLElement; open(): void; localize(): void; dispose(): void} {
  const text = options.text ?? translated;
  const dialog = element('dialog');
  dialog.className = 'workspace-drawer interview-modal';
  dialog.id = options.id;
  const header = element('div');
  header.className = 'sticky-header workspace-drawer-header';
  const title = text('h2', 'interview.title');
  const close = text('button', 'interview.close');
  close.type = 'button'; close.className = 'workspace-drawer-close';
  header.append(title, close);
  const body = element('div');
  body.className = 'interview-modal-body';
  dialog.append(header, body);
  options.parent.append(dialog);
  const unbind = bindWorkspaceDrawer({trigger:options.trigger, drawer:dialog, label:t('interview.title'), close});
  const opened = () => {if (dialog.open) options.onOpen?.();};
  const closed = () => options.onClose?.();
  options.trigger.addEventListener('click', opened);
  dialog.addEventListener('close', closed);
  return {dialog, body,
    open() {if (!dialog.open) options.trigger.click();},
    localize() {title.textContent = t('interview.title'); close.textContent = t('interview.close'); dialog.setAttribute('aria-label', t('interview.title'));},
    dispose() {
      unbind(); options.trigger.removeEventListener('click', opened); dialog.removeEventListener('close', closed); dialog.remove();
    }};
}

export async function mountInterview(host: HTMLElement, access: InstanceAccess) {
  let data: {questions:Question[];historical:HistoricalInterview[]; diagnostics?:InterviewDiagnostic[]; binding?:{projectHash:string;sourceHash:string;version?:number;draftId?:string}};
  try {data = await request(access, '/api/interview');}
  catch (error) {
    const render = () => {host.textContent = t(errorKey(error));};
    const unmount = onLanguageChange(render); render(); return unmount;
  }
  const {questions, historical:legacy} = data;
  const drafts = questions.map(question => {
    const saved = question.editable ? question.saved : null;
    return {
      picks:new Map(saved?.picks.map(pick => [pick.ask, pick])),
      note:saved?.note,
      image:0,
      status:saved ? 'interview.saved' : '',
      answered:question.editable ? Boolean(saved) : Boolean(question.answer),
    };
  });
  // The modal opens on the first question still waiting for explicit picks.
  let selected = Math.max(0, questions.findIndex((question, index) => question.editable && !drafts[index]!.answered));
  let busy = false;
  const render = () => {
    const joined = data.binding;
    const source = joined ? element('p', t(joined.draftId===undefined?'interview.joined':'interview.joinedDraft', [joined.draftId??String(joined.version), joined.projectHash, joined.sourceHash])) : null;
    if (source) source.className = 'interview-binding';
    const diagnostics = element('section');
    diagnostics.className = 'interview-diagnostics';
    diagnostics.setAttribute('role', 'status');
    for (const diagnostic of data.diagnostics ?? []) {
      const message = diagnostic.code === 'INTERVIEW_OPTIONS_STALE' ? 'interview.historicalIssue' : diagnostic.code;
      diagnostics.append(element('p', t(message)),
        element('code', [diagnostic.question, diagnostic.record, diagnostic.at, diagnostic.ref.path, diagnostic.ref.sha256].filter(Boolean).join(' · ')));
    }
    const archive = element('details');
    archive.append(element('summary', t('interview.legacy')));
    for (const answer of legacy) {
      const item = element('section');
      item.append(element('h3', answer.question), element('p', [answer.by,answer.at].filter(Boolean).join(' · ')),
        element('pre', answer.verbatim));
      if (answer.ref) item.append(element('code', answer.ref.path + ' · ' + answer.ref.sha256));
      if (answer.answer) item.append(element('pre', [answer.answer.by, answer.answer.at, answer.answer.source].filter(value => typeof value === 'string').join(' · ')));
      archive.append(item);
    }
    if (!questions.length) {
      host.replaceChildren(element('p', t('interview.empty')));
      if (source) host.prepend(source);
      host.append(diagnostics);
      if (legacy.length) {archive.open = true; host.append(archive);}
      return;
    }
    const question = questions[selected]!;
    const state = drafts[selected]!;
    const list = interviewQuestionList(questions.map((item, index) => ({
      label:item.set.question + ' · ' + item.set.id + (item.editable ? '' : ' · ' + t('interview.history')), answered:drafts[index]!.answered,
    })), selected, index => {selected = index; render();}, busy);

    const grid = element('div'); grid.className = 'interview-grid';
    const art = element('aside');
    art.append(element('h2', t(question.hasParts ? 'interview.parts' : 'interview.source')));
    if (!question.hasParts) art.append(element('p', t('interview.noParts')));
    if (question.partsUnavailable) art.append(element('p', t('interview.partsUnavailable')));
    const image = question.images[state.image];
    if (image) {
      const tabs = element('div');
      question.images.forEach((asset, index) => {
        const button = element('button', asset.name);
        button.type = 'button';
        button.setAttribute('aria-pressed', String(index === state.image));
        button.onclick = () => {state.image = index; render();};
        tabs.append(button);
      });
      const preview = element('img'); preview.alt = image.name; preview.src = access.route(image.url);
      const unavailable = element('p', t('interview.imageUnavailable'));
      unavailable.setAttribute('role','status');
      unavailable.hidden = true;
      preview.onerror = () => {preview.hidden = true; unavailable.hidden = false;};
      art.append(tabs, preview, unavailable);
    }

    const form = element('form');
    const fields = element('fieldset'); fields.disabled = !question.editable || !access.capability || busy;
    const provenance = element('p', t('interview.provenance', [question.set.drafted_by, question.set.drafted_at]));
    const binding = element('code', question.ref.path + ' · ' + question.ref.sha256);
    form.append(provenance, binding);
    if (question.answer) {
      form.append(element('pre', [question.answer.by, question.answer.at, question.answer.source].filter(value => typeof value === 'string').join(' · ')),
        element('pre', typeof question.answer.verbatim === 'string' ? question.answer.verbatim : ''));
    }
    const historical = question.answer?.choice as {picks?:Picks['picks'];note?:string} | undefined;
    const status = element('p'); status.setAttribute('role','status');
    const markUnsaved = () => {
      state.status = 'interview.unsaved';
      status.textContent = t(state.status);
    };
    for (const ask of question.set.asks) {
      const pick = state.picks.get(ask.id) ?? historical?.picks?.find(pick => pick.ask === ask.id);
      const kind = ask.options.find(option => option.id === pick?.option_id)?.kind;
      const autoResolved = !question.editable && Array.isArray((question.answer?.agent_decision as {fragments?:unknown}|undefined)?.fragments) &&
        ((question.answer!.agent_decision as {fragments:{ask:string}[]}).fragments).some(fragment => fragment.ask === ask.id);
      const {group} = interviewAskGroup(ask, {pick,
        pendingHidden:!(kind === 'auto' && !autoResolved || kind === 'other' && !(pick && 'other_fragment' in pick)),
        onPick:next => {state.picks.set(ask.id, next); markUnsaved();},
        onOther:text => {
          const previous = state.picks.get(ask.id);
          if (previous) {state.picks.set(ask.id, {...previous, other_text:text}); markUnsaved();}
        }});
      fields.append(group);
    }
    const noteLabel = element('label', t('interview.note'));
    const note = element('textarea');
    note.value = state.note ?? historical?.note ?? '';
    note.oninput = () => {state.note = note.value; markUnsaved();};
    noteLabel.append(note);
    fields.append(noteLabel);
    if (question.editable) {
      const submit = element('button', t('interview.save')); submit.type = 'submit'; submit.className = 'primary'; fields.append(submit);
    }
    status.textContent = state.status ? t(state.status) : t(!question.editable ? 'interview.history' : access.capability ? 'interview.choose' : 'interview.readOnly');
    form.append(fields, status);
    form.onsubmit = async event => {
      event.preventDefault();
      if (!question.editable || !access.capability || busy) return;
      const ordered = question.set.asks.map(ask => state.picks.get(ask.id));
      if (ordered.some(pick => !pick)) return;
      busy = true; fields.disabled = true;
      for (const button of list.querySelectorAll('button')) button.disabled = true;
      try {
        await request(access, '/api/interview/picks', interviewPicksRecord(question.ref, ordered as Pick[], state.note, new Date().toISOString()));
        state.status = 'interview.saved';
        state.answered = true;
      } catch (error) {state.status = errorKey(error);}
      finally {busy = false; render();}
    };
    grid.append(list, art, form); host.replaceChildren(grid);
    if (source) host.prepend(source);
    host.append(diagnostics);
    if (legacy.length) host.append(archive);
  };
  const unmount = onLanguageChange(render); render(); return unmount;
}
