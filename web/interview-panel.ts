import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { onLanguageChange, t } from './i18n.ts';
import { bindWorkspaceSeparator } from './workspace-layout.ts';
import { createViewControls } from './view-controls.ts';
import {WorkspacePreferenceStore,panelBounds} from './workspace-preferences.ts';
import { createPartsViewport } from './parts-viewport-provider.ts';

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

/** Real interview API rows shared by job publications and joined project inspection. */
export type InterviewDisplayQuestion = Omit<InterviewQuestion,'images'> & {images:{name:string;url:string}[];saved?:Picks|null};

/** Read-only diagnostics and verbatim historical records, independent of submission transport. */
export function interviewRecords(diagnostics:readonly InterviewDiagnostic[]=[],historical:readonly HistoricalInterview[]=[]):HTMLElement {
  const records=element('div');records.className='interview-records';
  const notices=element('section');notices.className='interview-diagnostics';notices.setAttribute('role','status');
  for(const diagnostic of diagnostics){
    notices.append(element('p',t(diagnostic.code==='INTERVIEW_OPTIONS_STALE'?'interview.historicalIssue':diagnostic.code)),
      element('code',[diagnostic.question,diagnostic.record,diagnostic.at,diagnostic.ref.path,diagnostic.ref.sha256].filter(Boolean).join(' · ')));
  }
  records.append(notices);
  if(historical.length){
    const archive=element('details');archive.append(element('summary',t('interview.legacy')));
    for(const answer of historical){const row=element('section');row.append(element('h3',answer.question),element('p',[answer.by,answer.at].filter(Boolean).join(' · ')),element('pre',answer.verbatim));if(answer.ref)row.append(element('code',answer.ref.path+' · '+answer.ref.sha256));if(answer.answer)row.append(element('pre',[answer.answer.by,answer.answer.at,answer.answer.source].filter(value=>typeof value==='string').join(' · ')));archive.append(row);}
    records.append(archive);
  }
  return records;
}

/** B's list | image | survey builder. Hosts supply genuine source data and their own submit transport. */
export function createInterviewForm(options:{question:InterviewDisplayQuestion;id:string;node?:InterviewText;form?:HTMLFormElement;fieldset?:HTMLFieldSetElement;source?:HTMLElement;
    images:readonly {name:string;src:string}[];questions?:readonly {label:string;answered:boolean}[]|(()=>readonly {label:string;answered:boolean}[]);selected?:number;onSelect?:(index:number)=>void;answered?:boolean;
    diagnostics?:readonly InterviewDiagnostic[];historical?:readonly HistoricalInterview[]}) {
  const question=options.question,copy=new Map<HTMLElement,string>();
  const node:InterviewText=(tag,key)=>{const result=options.node?options.node(tag,key):element(tag,key===undefined?undefined:t(key));if(key!==undefined)copy.set(result,key);return result;};
  const form=options.form??element('form'),fields=options.fieldset??element('fieldset');
  if(!options.fieldset)form.append(fields);
  form.className='interview-answer interview-grid';form.dataset.interviewAnswered=String(options.answered??Boolean(question.saved||question.answer));
  fields.className='interview-answer-fields';fields.id=options.id;fields.disabled=!question.editable;
  const heading=element('h3',question.set.question);fields.append(heading);
  const historical=question.answer?.choice as {picks?:Picks['picks']}|undefined;
  const answers=question.set.asks.map(item=>{const pick=question.saved?.picks.find(value=>value.ask===item.id)??historical?.picks?.find(value=>value.ask===item.id);const answer=interviewAskGroup(item,{text:node,name:'choice.'+item.id,otherName:'other.'+item.id,pick});fields.append(answer.group);return {item,answer};});
  const context=element('div');context.id=options.id+'-source';context.className='interview-image-context';
  if(options.source)context.append(options.source);
  context.append(node('h2',question.hasParts?'interview.parts':'interview.source'));
  if(!question.hasParts)context.append(node('p','interview.noParts'));
  if(question.partsUnavailable)context.append(node('p','interview.partsUnavailable'));
  const provenance=element('p'),binding=element('code',question.ref.path+' · '+question.ref.sha256);context.append(provenance,binding);
  if(question.answer)context.append(element('pre',[question.answer.by,question.answer.at,question.answer.source].filter(value=>typeof value==='string').join(' · ')),element('pre',typeof question.answer.verbatim==='string'?question.answer.verbatim:''));
  const art=element('aside');art.className='interview-art';form.prepend(art);
  let view:ReturnType<typeof interviewImageView>|undefined,list:HTMLElement|undefined,records:HTMLElement|undefined;
  const showImage=(index:number)=>{view?.dispose();view?.element.remove();view=interviewImageView(options.images,index,showImage,context);art.append(view.element);};
  if(options.images.length)showImage(0);else art.append(context);
  const refresh=()=>{
    provenance.textContent=t('interview.provenance',[question.set.drafted_by,question.set.drafted_at]);
    const questions=typeof options.questions==='function'?options.questions():options.questions;
    const items=questions?.map((item,index)=>({...item,answered:index===(options.selected??0)?form.dataset.interviewAnswered==='true':item.answered}))??[{label:question.set.question+' · '+question.set.id,answered:form.dataset.interviewAnswered==='true'}];
    const next=interviewQuestionList(items,options.selected??0,options.onSelect??(()=>{}));list?.remove();form.prepend(next);list=next;
    records?.remove();records=interviewRecords(options.diagnostics,options.historical);context.append(records);
  };
  const submit=node('button','interview.save');submit.type='submit';submit.hidden=!question.editable;fields.append(submit);
  const status=node('p',!question.editable?'interview.history':question.saved?'interview.saved':'interview.choose');status.setAttribute('role','status');form.append(status);
  const localize=()=>{for(const [item,key]of copy)item.textContent=t(item.dataset.jobText??key);refresh();};
  const off=onLanguageChange(localize);form.addEventListener('input',refresh);form.addEventListener('change',refresh);form.addEventListener('job-form-language',localize);refresh();
  return {form,fieldset:fields,submit,status,
    read:()=>jobInterviewValue(question.set.question,question.set.asks,item=>answers.find(answer=>answer.item===item)!.answer.value(),''),
    dispose(){view?.dispose();off();form.removeEventListener('input',refresh);form.removeEventListener('change',refresh);form.removeEventListener('job-form-language',localize);}};
}
