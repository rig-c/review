import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { onLanguageChange, t } from './i18n.ts';
import {textEntryFocused} from './view-controls.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
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
    if (option.kind !== 'value') radio.setAttribute('aria-label', t(option.kind === 'other' ? 'interview.otherChoice' : 'interview.delegateChoice') + ' · ' + option.label);
    label.append(radio, element('strong', option.label), element('span', option.effect));
    if (option.recommended) {
      const badge = element('b', t('interview.recommended'));
      badge.dataset.jobText = 'interview.recommended';
      label.append(badge, element('span', option.reason));
    }
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
    other.setAttribute('aria-label', t('interview.other'));
    ask.options.forEach((option,index) => {if (option.kind !== 'value') radios[index]!.setAttribute('aria-label',
      t(option.kind === 'other' ? 'interview.otherChoice' : 'interview.delegateChoice') + ' · ' + option.label);});
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

/** Progress follows complete retained answers, including explicit delegation picks. */
export function interviewAnswerState(set:InterviewQuestion['set'], ids:(string|undefined)[]):'unanswered'|'answered'|'delegated' {
  if (!set.asks.length || ids.length !== set.asks.length || ids.some(id => !id)) return 'unanswered';
  return set.asks.some((ask,index) => ask.options.some(option => option.id === ids[index] && option.kind === 'auto'))
    ? 'delegated' : 'answered';
}

/** Question titles and progress share the retained questionnaire order across callers. */
export function renderInterviewNavigation(questions: Pick<InterviewQuestion,'set'>[],
  states: ('unanswered'|'answered'|'delegated')[], selected:number, select:(index:number)=>void) {
  const sidebar = element('nav'); sidebar.className = 'interview-navigation';
  sidebar.setAttribute('aria-label', t('interview.question'));
  sidebar.append(element('p', t('interview.progress', [states.filter(state => state !== 'unanswered').length, questions.length])));
  const list = element('ol'); sidebar.append(list);
  questions.forEach((question, index) => {
    const button = element('button'); button.type = 'button';
    button.dataset.interviewQuestion = String(index);
    button.dataset.interviewSet = question.set.id;
    button.setAttribute('aria-current', index === selected ? 'step' : 'false');
    button.tabIndex = index === selected ? 0 : -1;
    const status = states[index] ?? 'unanswered';
    button.append(element('strong', question.set.asks[0]?.prompt ?? t('interview.question')),
      element('span', index === selected ? t('interview.currentState', [t('interview.' + status)]) : t('interview.' + status)));
    button.onclick = () => select(index);
    button.onkeydown = event => {
      const next = event.key === 'ArrowDown' ? (index + 1) % questions.length :
        event.key === 'ArrowUp' ? (index + questions.length - 1) % questions.length :
        event.key === 'Home' ? 0 : event.key === 'End' ? questions.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); select(next);
      sidebar.parentElement?.querySelector<HTMLButtonElement>('[data-interview-question="' + next + '"]')?.focus();
    };
    const row = element('li'); row.append(button); list.append(row);
  });
  return sidebar;
}

/** Mount one supplied image on the existing shared camera, gesture and resize controller. */
function questionImageViewport(viewport:HTMLElement, preview:HTMLImageElement, toolbar:HTMLElement) {
  const controls = new Map<string,HTMLElement>();
  for (const [id, key] of [['zoom-out','job.zoomOut'],['zoom-in','job.zoomIn'],['fit','Fit'],['native-one','1:1']]) {
    const button = element('button', t(key!)); button.type = 'button';
    button.dataset.interviewView = id; controls.set(id!,button); toolbar.append(button);
  }
  const zoom = element('output'); toolbar.append(zoom);
  const sync = element('input'); sync.type = 'checkbox'; controls.set('camera-sync',sync);
  controls.set('stage-layout',viewport);
  controls.set('rig-viewport',viewport); controls.set('rig-root',preview); controls.set('zoom-value',zoom);
  let initial = true;
  const camera = createPartsViewport({
    el:<T extends HTMLElement>(id:string) => controls.get(id) as T,
    canvas:preview, reference:() => null,
    frameSize:() => ({w:preview.naturalWidth,h:preview.naturalHeight}),
    panes:[{target:'rig',viewport,pane:viewport}], message:() => {},
    rendered:controller => {
      if (!controller.paneFrame('rig')) return;
      if (initial) {initial = false; controller.fitActiveCamera('rig');}
      viewport.dataset.interviewZoom = String(controller.paneCamera('rig').zoom);
    },
  });
  preview.style.width = preview.naturalWidth + 'px'; preview.style.height = preview.naturalHeight + 'px';
  const unbindControls = camera.bindControls();
  const unbindNavigation = camera.bindNavigation(undefined, () => viewport.isConnected);
  controls.get('native-one')!.onclick = () => camera.cameraAction(() => camera.updateCamera('rig',{zoom:1,pan:{x:0,y:0}}));
  const observer = camera.observeResize();
  camera.fitCamera();
  return () => {observer.disconnect(); unbindNavigation(); unbindControls(); toolbar.replaceChildren();};
}

/** Image selection reuses supplied previews or the standalone caller's routed URL. */
export function renderQuestionImages(images: {name:string; url?:string; preview?:HTMLImageElement}[],
  state: {image:number}, question?: Pick<InterviewQuestion,'set'>) {
  let activePreview:HTMLImageElement | undefined;
  let disposed = false;
  let disposeViewport:(() => void) | undefined;
  const art = Object.assign(element('section'), {dispose:() => {disposed = true; if (activePreview) {activePreview.onload = null; activePreview.onerror = null;} disposeViewport?.();}}); art.className = 'interview-images';
  art.tabIndex = 0;
  art.dataset.jobInterviewImages = '';
  const context = (question?.set as {context?:unknown} | undefined)?.context;
  const kind = context && typeof context === 'object' && !Array.isArray(context)
    ? (context as {kind?:unknown}).kind : undefined;
  if (typeof kind === 'string' && kind.trim()) art.dataset.jobInterviewContextKind = kind;
  const tabs = element('div'); tabs.className = 'interview-image-tabs';
  const viewport = element('div'); viewport.className = 'interview-image-preview';
  const toolbar = element('div'); toolbar.className = 'interview-image-controls';
  const unavailable = element('p', t('interview.imageUnavailable'));
  unavailable.dataset.jobText = 'interview.imageUnavailable';
  unavailable.setAttribute('role', 'status'); unavailable.hidden = true;
  const show = (index:number) => {
    const asset = images[index];
    if (!asset) return;
    if (activePreview) {activePreview.onload = null; activePreview.onerror = null;}
    disposeViewport?.(); disposeViewport = undefined; toolbar.replaceChildren();
    state.image = index;
    buttons.forEach((button, at) => button.setAttribute('aria-pressed', String(at === index)));
    const preview = asset.preview ? asset.preview.cloneNode(true) as HTMLImageElement : element('img');
    activePreview = preview; preview.alt = asset.name;
    if (!asset.preview && asset.url) preview.src = asset.url;
    preview.hidden = false; unavailable.hidden = true;
    preview.onerror = () => {disposeViewport?.(); disposeViewport = undefined; preview.hidden = true; unavailable.hidden = false;};
    viewport.replaceChildren(preview);
    const ready = () => {if (!disposed && preview.naturalWidth && preview.naturalHeight && preview.parentElement === viewport && !disposeViewport)
      disposeViewport = questionImageViewport(viewport, preview, toolbar);};
    preview.onload = ready; ready();
  };
  const buttons = images.map((asset, index) => {
    const button = element('button', asset.name); button.type = 'button';
    button.onclick = () => show(index); tabs.append(button); return button;
  });
  art.onkeydown = event => {
    if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || textEntryFocused(event.target)) return;
    if (/^[1-9]$/.test(event.key) && images[Number(event.key) - 1]) {
      event.preventDefault(); show(Number(event.key) - 1);
    }
  };
  art.append(tabs, toolbar, viewport, unavailable);
  if (images.length) show(Math.min(state.image, images.length - 1));
  else {
    const empty = element('p');
    empty.dataset.jobInterviewEmpty = '';
    art.append(empty);
  }
  localizeQuestionImages(art);
  return art;
}

/** Refresh only shared image labels, preserving the selected preview and owner state. */
export function localizeQuestionImages(art: HTMLElement) {
  art.setAttribute('aria-label', t('job.picks.context'));
  const empty = art.querySelector<HTMLElement>('[data-job-interview-empty]');
  if (empty) empty.textContent = t('job.picks.noImagesUnknown');
  for (const [id,key] of [['zoom-in','job.zoomIn'],['zoom-out','job.zoomOut'],['fit','Fit']]) {
    const button = art.querySelector<HTMLElement>('[data-interview-view=' + id + ']');
    if (button) button.textContent = t(key!);
  }
}

export async function mountInterview(host: HTMLElement, access: InstanceAccess, retained?: {question:Question; imagesAlreadyShown:boolean}) {
  let data: {questions:Question[];historical:HistoricalInterview[]; diagnostics?:InterviewDiagnostic[]; binding?:{projectHash:string;sourceHash:string;version?:number;draftId?:string}};
  try {data = retained ? {questions:[retained.question],historical:[]} : await request(access, '/api/interview');}
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
  let disposeImages:(() => void) | undefined;
  const render = () => {
    disposeImages?.();
    const joined = data.binding;
    const sourceLine = joined ? element('p', t(joined.draftId===undefined?'interview.joined':'interview.joinedDraft', [joined.draftId??String(joined.version), joined.projectHash, joined.sourceHash])) : null;
    const source = sourceLine ? element('details') : null;
    if (source && sourceLine) {source.className = 'interview-binding'; source.append(element('summary',t('job.binding')),sourceLine);}
    const diagnostics = element('details');
    diagnostics.append(element('summary', t('interview.details')));
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
      if (data.diagnostics?.length) host.append(diagnostics);
      if (legacy.length) {archive.open = true; host.append(archive);}
      return;
    }
    const question = questions[selected]!;
    const state = drafts[selected]!;
    const sidebar = element('div');
    const refreshSidebar = () => {
      const states = questions.map(item => {
        const persisted = item.saved?.picks ?? (item.answer?.choice as Picks | undefined)?.picks ?? [];
        return item.answer && !persisted.length ? 'answered' as const :
          interviewAnswerState(item.set,item.set.asks.map(ask => persisted.find(pick => pick.ask === ask.id)?.option_id));
      });
      sidebar.replaceChildren(renderInterviewNavigation(questions,states,selected,index => {
        if (busy) return; selected = index; render();
        host.querySelector<HTMLButtonElement>('[aria-current=step]')?.focus();
      }));
    };
    refreshSidebar();
    const grid = element('div'); grid.className = 'interview-grid';
    const art = element('aside');
    art.append(element('h2', t(question.hasParts ? 'interview.parts' : 'interview.source')));
    if (!question.hasParts) art.append(element('p', t('interview.noParts')));
    if (question.partsUnavailable) art.append(element('p', t('interview.partsUnavailable')));
    const images = renderQuestionImages(question.images.map(image => ({name:image.name, url:access.route(image.url)})), state, question);
    disposeImages = images.dispose; art.append(images);
    if (retained?.imagesAlreadyShown) images.dispose();

    const form = element('form');
    const fields = element('fieldset'); fields.disabled = !!retained || !question.editable || !access.capability || busy;
    const provenance = element('details');
    provenance.append(element('summary',t('interview.details')),element('p', t('interview.provenance', [question.set.drafted_by, question.set.drafted_at])));
    const binding = element('code', question.ref.path + ' · ' + question.ref.sha256);
    provenance.append(binding); form.append(provenance);
    if (question.answer) {
      provenance.append(element('pre', [question.answer.by, question.answer.at, question.answer.source].filter(value => typeof value === 'string').join(' · ')));
      form.append(element('pre', typeof question.answer.verbatim === 'string' ? question.answer.verbatim : ''));
    }
    const historical = question.answer?.choice as {picks?:Picks['picks'];note?:string} | undefined;
    const status = element('p'); status.setAttribute('role','status');
    const markUnsaved = () => {
      state.status = 'interview.unsaved';
      status.textContent = t(state.status); refreshSidebar();
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
    if (question.editable && !retained) {
      const submit = element('button', t('interview.save')); submit.type = 'submit'; fields.append(submit);
    }
    status.textContent = state.status ? t(state.status) : t(!question.editable ? 'interview.history' : retained ? 'interview.waitingQuestion' : access.capability ? 'interview.choose' : 'interview.readOnly');
    form.append(fields, status);
    form.onsubmit = async event => {
      event.preventDefault();
      if (retained || !question.editable || !access.capability || busy) return;
      const ordered = question.set.asks.map(ask => state.picks.get(ask.id));
      if (ordered.some(pick => !pick)) return;
      busy = true; fields.disabled = true;
      try {
        question.saved = await request(access, '/api/interview/picks', {
          schema:'rig-review/interview-picks@1', set:question.ref, picks:ordered as Picks['picks'],
          ...(state.note !== undefined ? {note:state.note} : {}), by:'user', at:new Date().toISOString(),
        });
        state.status = 'interview.saved';
      } catch (error) {state.status = errorKey(error);}
      finally {busy = false; render();}
    };
    if (!retained?.imagesAlreadyShown) grid.append(art);
    grid.append(form);
    const workspace = element('div'); workspace.className = 'interview-workspace';
    if (!retained) workspace.append(sidebar);
    else workspace.classList.add('interview-retained-question');
    workspace.append(grid); host.replaceChildren(workspace);
    if (source) host.prepend(source);
    if (data.diagnostics?.length) host.append(diagnostics);
    if (legacy.length) host.append(archive);
  };
  const unmount = onLanguageChange(render); render(); return () => {disposeImages?.(); unmount();};
}
