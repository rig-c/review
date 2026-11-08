import type { HistoricalInterview, InterviewQuestion } from '../src/interview-project.ts';
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

export async function mountInterview(host: HTMLElement, access: InstanceAccess) {
  let data: {questions:Question[];historical:HistoricalInterview[]; binding?:{projectHash:string;sourceHash:string;version?:number;draftId?:string}};
  try {data = await request(access, '/api/interview');}
  catch (error) {
    const render = () => {host.textContent = t(errorKey(error));};
    onLanguageChange(render); render(); return;
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
    const archive = element('details');
    archive.append(element('summary', t('interview.legacy')));
    for (const answer of legacy) {
      const item = element('section');
      item.append(element('h3', answer.question), element('p', [answer.by,answer.at].filter(Boolean).join(' · ')),
        element('pre', answer.verbatim));
      archive.append(item);
    }
    if (!questions.length) {
      host.replaceChildren(element('p', t('interview.empty')));
      if (source) host.prepend(source);
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
    const historical = question.answer?.choice as {picks?:Picks['picks'];note?:string} | undefined;
    const status = element('p'); status.setAttribute('role','status');
    const markUnsaved = () => {
      state.status = 'interview.unsaved';
      status.textContent = t(state.status);
    };
    for (const ask of question.set.asks) {
      const group = element('fieldset');
      group.append(element('legend', ask.prompt));
      const pick = state.picks.get(ask.id) ?? historical?.picks?.find(pick => pick.ask === ask.id);
      const other = element('textarea');
      other.setAttribute('aria-label', t('interview.other'));
      other.value = pick?.other_text ?? '';
      other.hidden = pick?.other_text === undefined && !ask.options.some(option => option.id === pick?.option_id && option.kind === 'other');
      other.oninput = () => {
        const previous = state.picks.get(ask.id);
        if (previous) {state.picks.set(ask.id, {...previous, other_text:other.value}); markUnsaved();}
      };
      for (const option of ask.options) {
        const label = element('label'); label.className = 'interview-option';
        const radio = element('input'); radio.type = 'radio'; radio.name = ask.id; radio.value = option.id;
        radio.required = true; radio.checked = option.id === pick?.option_id;
        radio.onchange = () => {
          const next = {ask:ask.id, option_id:option.id};
          state.picks.set(ask.id, option.kind === 'other' ? {...next, other_text:other.value} : next);
          markUnsaved();
          other.hidden = option.kind !== 'other';
          other.required = option.kind === 'other';
          pending.hidden = option.kind === 'value';
          pending.textContent = t(option.kind === 'other' ? 'interview.otherPending' : 'interview.autoPending');
        };
        label.append(radio, element('strong', option.label), element('span', option.effect));
        if (option.recommended) label.append(element('b', t('interview.recommended')), element('span', option.reason));
        group.append(label);
      }
      const kind = ask.options.find(option => option.id === pick?.option_id)?.kind;
      const autoResolved = !question.editable && Array.isArray((question.answer?.agent_decision as {fragments?:unknown}|undefined)?.fragments) &&
        ((question.answer!.agent_decision as {fragments:{ask:string}[]}).fragments).some(fragment => fragment.ask === ask.id);
      const pending = element('p', t(kind === 'other' ? 'interview.otherPending' : 'interview.autoPending'));
      pending.hidden = !(kind === 'auto' && !autoResolved || kind === 'other' && !(pick && 'other_fragment' in pick));
      other.required = kind === 'other';
      group.append(other, pending);
      fields.append(group);
    }
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
    if (legacy.length) host.append(archive);
  };
  onLanguageChange(render); render();
}
