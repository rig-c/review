import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { onLanguageChange, t } from './i18n.ts';
import type { InstanceAccess } from './instance-access.ts';
import { bindWorkspaceSeparator } from './workspace-layout.ts';
import { createViewControls } from './view-controls.ts';
import {WorkspacePreferenceStore,panelBounds} from './workspace-preferences.ts';
import { createPartsViewport } from './parts-viewport-provider.ts';

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
    if(option.kind==='auto'){const badge=text('b','interview.delegate');badge.className='interview-delegate';label.append(badge);}
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

/**
 * The question's bound images in the shared native-image viewport (#708 return): the parts page's camera through
 * createPartsViewport and the shared control set in its fixed order (Zoom in, Zoom out, Fit, 1:1, View switch), where the
 * view switch picks the bound image. Control ids are dropped so the modal never shadows the page's own main view.
 */
export function interviewImageView(images: readonly {name: string; src: string}[], selected: number, onSelect: (index: number) => void, bottom?:HTMLElement) {
  const image = images[selected]!;
  const controls = createViewControls({layout:'rigStep1', viewSwitch:{currentMode:String(selected), groups:[{modes:images.map((asset, index) =>
    ({id:String(index), labelKey:asset.name, pressed:index === selected}))}], onChange:id => onSelect(Number(id))}});
  const sync = controls.syncLabel.querySelector('input')!;
  const named = new Map<string, HTMLElement>([['zoom-in', controls.zoomButtons[0]!], ['zoom-out', controls.zoomButtons[1]!],
    ['fit', controls.zoomButtons[2]!], ['native-one', controls.nativeOne!], ['zoom-value', controls.value], ['camera-sync', sync]]);
  const toolbar = controls.zoomGroup!;
  const viewport = element('div'); viewport.className = 'interview-viewport';
  const root = element('div'); root.className = 'interview-view-root';
  // A canvas starts at 300 x 150; the camera has no frame until the bound image has drawn.
  const canvas = element('canvas'); root.append(canvas); viewport.append(root);
  let loaded = false;
  const reference = element('div'); reference.hidden = true;
  for (const [id, node] of [['rig-viewport', viewport], ['rig-pane', viewport], ['stage-layout', viewport], ['rig-root', root],
    ['reference-viewport', reference], ['reference-pane', reference], ['reference-content', reference]] as const) named.set(id, node);
  for (const node of [toolbar, ...toolbar.querySelectorAll('[id]'), sync]) node.removeAttribute('id');
  const unavailable = element('p'); unavailable.setAttribute('role', 'status'); unavailable.hidden = true;
  const view = element('div'); view.className = 'interview-view'; view.append(toolbar, viewport, unavailable);
  const camera = createPartsViewport({el:<T extends HTMLElement>(id: string) => named.get(id) as T, canvas, message:() => {},
    reference:() => null, frameSize:target => target === 'rig' && loaded ? {w:canvas.width, h:canvas.height} : null});
  const localize = () => {
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-view]')) button.textContent = images[Number(button.dataset.view)]!.name;
    const summary = toolbar.querySelector('.view-menu summary');
    if (summary?.firstChild) summary.firstChild.textContent = t('View switch') + ' ';
    summary?.setAttribute('aria-label', t('View layout'));
    if (summary?.lastElementChild) summary.lastElementChild.textContent = image.name;
    for (const [button, key] of [[controls.zoomButtons[0]!, 'Zoom in'], [controls.zoomButtons[1]!, 'Zoom out']] as const) {
      button.textContent = t(key); button.setAttribute('aria-label', t(key));
    }
    unavailable.textContent = t('interview.imageUnavailable');
  };
  // Agent-authored part names stay verbatim; the controls' own words follow the shared catalogs.
  const unlocalize = onLanguageChange(() => {camera.renderCameraControls(); localize();}); localize();
  const disposers = [camera.bindControls(), camera.bindNavigation(), unlocalize];
  controls.nativeOne!.onclick = () => camera.cameraAction(() => camera.updateCamera('rig', {zoom:1, pan:{x:0, y:0}}));
  let fitted = false;
  const fit = () => {if (!fitted && loaded && camera.paneFrame('rig')) {fitted = true; camera.fitActiveCamera('rig');} else camera.fitCamera();};
  const resize = new ResizeObserver(fit); resize.observe(viewport);
  if(bottom){
    const preferences=new WorkspacePreferenceStore();let height:number=panelBounds.inspectorHeight.min;
    const separator=element('div');separator.className='workspace-separator interview-bottom-resize';
    view.append(separator,bottom);
    const range=()=>({min:panelBounds.inspectorHeight.min,max:Math.max(panelBounds.inspectorHeight.min,view.clientHeight-200),value:bottom.getBoundingClientRect().height,enabled:true});
    const apply=(value:number)=>{height=value;view.style.setProperty('--interview-answer-height',Math.min(range().max,Math.max(range().min,value))+'px');};
    const binding=bindWorkspaceSeparator({element:separator,panel:'inspectorHeight',controls:bottom.id,label:t('Resize Inspector'),range,desired:()=>height,resize:apply,commit:value=>preferences.update({panels:{inspectorHeight:value}})});
    const observer=new ResizeObserver(()=>{apply(height);binding.refresh();});observer.observe(view);
    disposers.push(()=>{observer.disconnect();binding.dispose();});apply(height);
  }
  const source = new Image();
  source.onload = () => {
    canvas.width = source.naturalWidth; canvas.height = source.naturalHeight; loaded = true;
    canvas.getContext('2d')?.drawImage(source, 0, 0); fit();
  };
  source.onerror = () => {viewport.hidden = true; unavailable.hidden = false;};
  source.alt = image.name; source.src = image.src;
  return {element:view, dispose() {source.onload=source.onerror=null;source.src='';resize.disconnect(); for (const dispose of disposers) dispose();}};
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
  let disposeView: (() => void) | undefined;
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
    disposeView?.(); disposeView = undefined;
    if (question.images[state.image]) {
      const view = interviewImageView(question.images.map(asset => ({name:asset.name, src:access.route(asset.url)})), state.image,
        index => {state.image = index; render();});
      disposeView = view.dispose;
      art.append(view.element);
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
  const unmount = onLanguageChange(render); render(); return () => {unmount(); disposeView?.();};
}
