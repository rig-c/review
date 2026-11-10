import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { onLanguageChange, t } from './i18n.ts';
import type { InstanceAccess } from './instance-access.ts';

type Question = Omit<InterviewQuestion,'images'> & {images:{name:string;url:string}[]; saved:Picks|null};
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

type InterviewAsk = InterviewQuestion['set']['asks'][number];
type InterviewPick = Picks['picks'][number];

/** Shared native ask controls. Transport and source binding stay with each caller. */
export function renderAskGroup(ask: InterviewAsk, pick: InterviewPick | undefined,
  onChange: (pick: InterviewPick) => void,
  settings: {name?:string; otherName?:string; autoResolved?:boolean; otherResolved?:boolean} = {}) {
  const group = element('fieldset');
  group.className = 'interview-ask';
  group.append(element('legend', ask.prompt));
  const other = element('textarea');
  other.name = settings.otherName ?? 'other.' + ask.id;
  other.setAttribute('aria-label', t('interview.other'));
  other.value = pick?.other_text ?? '';
  const pending = element('p');
  pending.setAttribute('role', 'status');
  const radios = ask.options.map(option => {
    const label = element('label'); label.className = 'interview-option';
    const radio = element('input');
    radio.type = 'radio'; radio.name = settings.name ?? ask.id; radio.value = option.id;
    radio.required = true; radio.checked = option.id === pick?.option_id;
    label.append(radio, element('strong', option.label), element('span', option.effect));
    if (option.recommended) label.append(element('b', t('interview.recommended')), element('span', option.reason));
    group.append(label);
    if (option.kind === 'other') group.append(other, pending);
    return radio;
  });
  const read = (): InterviewPick => {
    const option = ask.options.find((_, index) => radios[index]!.checked);
    return {ask:ask.id, option_id:option?.id ?? '',
      ...(option?.kind === 'other' ? {other_text:other.value} : {})};
  };
  const sync = () => {
    const selected = read();
    const kind = ask.options.find(option => option.id === selected.option_id)?.kind;
    other.hidden = kind !== 'other'; other.required = kind === 'other';
    pending.hidden = !(kind === 'auto' && !settings.autoResolved || kind === 'other' && !settings.otherResolved);
    pending.textContent = t(kind === 'other' ? 'interview.otherPending' : 'interview.autoPending');
  };
  for (const radio of radios) radio.onchange = () => {sync(); onChange(read());};
  other.oninput = () => onChange(read());
  sync();
  return {group, radios, other, read, sync};
}

/** The retained set's value-only tuple rule, evaluated against each candidate. */
export function refreshInterviewConstraints(set: InterviewQuestion['set'], groups: ReturnType<typeof renderAskGroup>[]) {
  groups.forEach((group, askIndex) => {
    group.radios.forEach((radio, optionIndex) => {
      const candidate = set.asks[askIndex]!.options[optionIndex]!;
      const disallowed = (set.constraints ?? []).some(constraint => {
        if (!constraint.asks.includes(set.asks[askIndex]!.id)) return false;
        const tuple = constraint.asks.map(id => {
          const index = set.asks.findIndex(ask => ask.id === id);
          return index === askIndex ? candidate : set.asks[index]!.options.find(option => option.id === groups[index]!.read().option_id);
        });
        return tuple.every(option => option?.kind === 'value') &&
          !constraint.allowed.some(allowed => allowed.every((id, index) => id === tuple[index]?.id));
      });
      radio.disabled = disallowed;
      radio.title = disallowed ? t('job.picks.notAllowed') : '';
    });
  });
}

/** Image selection reuses supplied previews or the standalone caller's routed URL. */
export function renderQuestionImages(images: {name:string; url?:string; preview?:HTMLImageElement}[],
  state: {image:number}, emptyText?:string) {
  const art = element('section'); art.className = 'interview-images';
  art.tabIndex = 0;
  art.setAttribute('aria-label', t('job.picks.context'));
  const tabs = element('div'); tabs.className = 'interview-image-tabs';
  const viewport = element('div'); viewport.className = 'interview-image-preview';
  const unavailable = element('p', t('interview.imageUnavailable'));
  unavailable.setAttribute('role', 'status'); unavailable.hidden = true;
  const show = (index:number) => {
    const asset = images[index];
    if (!asset) return;
    state.image = index;
    buttons.forEach((button, at) => button.setAttribute('aria-pressed', String(at === index)));
    const preview = asset.preview ? asset.preview.cloneNode(true) as HTMLImageElement : element('img');
    preview.alt = asset.name;
    if (!asset.preview && asset.url) preview.src = asset.url;
    preview.hidden = false; unavailable.hidden = true;
    preview.onerror = () => {preview.hidden = true; unavailable.hidden = false;};
    viewport.replaceChildren(preview);
  };
  const buttons = images.map((asset, index) => {
    const button = element('button', asset.name); button.type = 'button';
    button.onclick = () => show(index); tabs.append(button); return button;
  });
  art.onkeydown = event => {
    if (/^[1-9]$/.test(event.key) && images[Number(event.key) - 1]) {
      event.preventDefault(); show(Number(event.key) - 1);
    }
  };
  art.append(tabs, viewport, unavailable);
  if (images.length) show(Math.min(state.image, images.length - 1));
  else if (emptyText) art.append(element('p', emptyText));
  return art;
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
    };
  });
  let selected = 0;
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
    const picker = element('select');
    picker.setAttribute('aria-label', t('interview.question'));
    questions.forEach((item, index) => {
      const entry = element('option', item.set.question + ' · ' + item.set.id + (item.editable ? '' : ' · ' + t('interview.history')));
      entry.value = String(index); picker.append(entry);
    });
    picker.value = String(selected);
    picker.disabled = busy;
    picker.onchange = () => {selected = Number(picker.value); render();};

    const grid = element('div'); grid.className = 'interview-grid';
    const art = element('aside');
    art.append(element('h2', t(question.hasParts ? 'interview.parts' : 'interview.source')));
    if (!question.hasParts) art.append(element('p', t('interview.noParts')));
    if (question.partsUnavailable) art.append(element('p', t('interview.partsUnavailable')));
    art.append(renderQuestionImages(question.images.map(image => ({name:image.name, url:access.route(image.url)})), state));

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
    const groups = question.set.asks.map(ask => {
      const pick = state.picks.get(ask.id) ?? historical?.picks?.find(pick => pick.ask === ask.id);
      const autoResolved = !question.editable && Array.isArray((question.answer?.agent_decision as {fragments?:unknown}|undefined)?.fragments) &&
        ((question.answer!.agent_decision as {fragments:{ask:string}[]}).fragments).some(fragment => fragment.ask === ask.id);
      const group = renderAskGroup(ask, pick, next => {
        state.picks.set(ask.id, next); markUnsaved(); refreshInterviewConstraints(question.set, groups);
      }, {autoResolved, otherResolved:!!pick && 'other_fragment' in pick});
      fields.append(group.group);
      return group;
    });
    refreshInterviewConstraints(question.set, groups);
    const noteLabel = element('label', t('interview.note'));
    const note = element('textarea');
    note.value = state.note ?? historical?.note ?? '';
    note.oninput = () => {state.note = note.value; markUnsaved();};
    noteLabel.append(note);
    fields.append(noteLabel);
    if (question.editable) {
      const submit = element('button', t('interview.save')); submit.type = 'submit'; fields.append(submit);
    }
    status.textContent = state.status ? t(state.status) : t(!question.editable ? 'interview.history' : access.capability ? 'interview.choose' : 'interview.readOnly');
    form.append(fields, status);
    form.onsubmit = async event => {
      event.preventDefault();
      if (!question.editable || !access.capability || busy) return;
      const ordered = question.set.asks.map(ask => state.picks.get(ask.id));
      if (ordered.some(pick => !pick)) return;
      busy = true; fields.disabled = true; picker.disabled = true;
      try {
        await request(access, '/api/interview/picks', {
          schema:'rig-review/interview-picks@1', set:question.ref, picks:ordered as Picks['picks'],
          ...(state.note !== undefined ? {note:state.note} : {}), by:'user', at:new Date().toISOString(),
        });
        state.status = 'interview.saved';
      } catch (error) {state.status = errorKey(error);}
      finally {busy = false; render();}
    };
    grid.append(art, form); host.replaceChildren(picker, grid);
    if (source) host.prepend(source);
    host.append(diagnostics);
    if (legacy.length) host.append(archive);
  };
  const unmount = onLanguageChange(render); render(); return unmount;
}
