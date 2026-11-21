import type { HistoricalInterview, InterviewQuestion, InterviewDiagnostic } from '../src/interview-project.ts';
import type { Picks } from '../src/interview-picks.ts';
import { t } from './i18n.ts';

/** The active image-question form is mounted only while it owns the main reference pane. */
export function hasTransientQuestionImage(root:{querySelector(selector:string):Element|null}=document):boolean {
  return root.querySelector('#workspace-interview-answer[data-question-image-active=true] [data-interview-main]')!==null;
}

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
function element<K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, factory?:InterviewText): HTMLElementTagNameMap[K] {
  const el = factory?factory(tag):document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  return el;
}
const translated: InterviewText = (tag, key) => element(tag, key === undefined ? undefined : t(key));
function preserveScrollAndFocus(anchor: HTMLElement, mutate: () => void): void {
  const active = typeof HTMLElement !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const scrolls: [HTMLElement, number, number][] = [];
  for (let node: HTMLElement | null = anchor; node; node = node.parentElement) scrolls.push([node, node.scrollTop, node.scrollLeft]);
  mutate();
  for (const [node, top, left] of scrolls) {if (node.scrollTop !== top) node.scrollTop = top; if (node.scrollLeft !== left) node.scrollLeft = left;}
  if (active?.isConnected && document.activeElement !== active) active.focus({preventScroll:true});
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
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,content?:string)=>element(tag,content,options.text);
  const group = make('fieldset');
  group.className = 'interview-ask';
  group.append(make('legend', ask.prompt));
  const pick = options.pick;
  const other = make('textarea');
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
    const label = make('label'); label.className = 'interview-option';
    const radio = make('input'); radio.type = 'radio'; radio.name = options.name ?? ask.id; radio.value = option.id;
    radio.required = true; radio.checked = option.id === pick?.option_id;
    radio.onchange = () => preserveScrollAndFocus(group, () => {
      if (!radio.checked) return;
      other.hidden = option.kind !== 'other';
      other.required = option.kind === 'other';
      pending.hidden = option.kind === 'value';
      const key = option.kind === 'other' ? 'interview.otherPending' : 'interview.autoPending';
      if (pending.dataset.jobText !== undefined) pending.dataset.jobText = key;
      pending.textContent = t(key);
      const next = {ask:ask.id, option_id:option.id};
      options.onPick?.(option.kind === 'other' ? {...next, other_text:other.value} : next);
    });
    label.append(radio, make('strong', option.label), make('span', option.effect));
    if(option.kind==='auto'){const badge=text('b','interview.delegate');badge.className='interview-delegate';label.append(badge);}
    if (option.recommended) {
      const badge = text('b', 'interview.recommended'); badge.className = 'interview-recommended';
      label.dataset.recommended = '';
      label.append(badge, make('span', option.reason));
    }
    group.append(label);
    return radio;
  });
  group.append(other, pending);
  return {group, value:() => ({optionId:radios.find(radio => radio.checked)?.value ?? '', otherText:other.value})};
}

/** The modal's question list: "Answered n / total" and one button per question. */
export function interviewQuestionList(items: readonly {label: string; answered: boolean}[], selected: number,
    onSelect: ((index: number) => void) | null, disabled = false, factory?:InterviewText): HTMLElement {
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,content?:string)=>element(tag,content,factory);
  const nav = make('nav');
  nav.className = 'interview-questions';
  nav.setAttribute('aria-label', t('interview.question'));
  nav.append(make('p', t('interview.answered', [items.filter(item => item.answered).length, items.length])));
  const list = make('ol');
  items.forEach((item, index) => {
    const row = make('li');
    const button = make('button', item.label);
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

/** Real interview API rows shared by job publications and joined project inspection. */
export type InterviewDisplayQuestion = Omit<InterviewQuestion,'images'> & {images:{name:string;url:string}[];saved?:Picks|null};

/** Read-only diagnostics and verbatim historical records, independent of submission transport. */
export function interviewRecords(diagnostics:readonly InterviewDiagnostic[]=[],historical:readonly HistoricalInterview[]=[],factory?:InterviewText):HTMLElement {
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,content?:string)=>element(tag,content,factory);
  const records=make('div');records.className='interview-records';
  const notices=make('section');notices.className='interview-diagnostics';notices.setAttribute('role','status');
  for(const diagnostic of diagnostics){
    notices.append(make('p',t(diagnostic.code==='INTERVIEW_OPTIONS_STALE'?'interview.historicalIssue':diagnostic.code)),
      make('code',[diagnostic.question,diagnostic.record,diagnostic.at,diagnostic.ref.path,diagnostic.ref.sha256].filter(Boolean).join(' · ')));
  }
  records.append(notices);
  if(historical.length){
    const archive=make('details');archive.append(make('summary',t('interview.legacy')));
    for(const answer of historical){const row=make('section');row.append(make('h3',answer.question),make('p',[answer.by,answer.at].filter(Boolean).join(' · ')),make('pre',answer.verbatim));if(answer.ref)row.append(make('code',answer.ref.path+' · '+answer.ref.sha256));if(answer.answer)row.append(make('pre',[answer.answer.by,answer.answer.at,answer.answer.source].filter(value=>typeof value==='string').join(' · ')));archive.append(row);}
    records.append(archive);
  }
  return records;
}

/** The question list and survey form. Hosts supply source data and submit transport. */
export function createInterviewForm(options:{question:InterviewDisplayQuestion;id:string;node?:InterviewText;form?:HTMLFormElement;fieldset?:HTMLFieldSetElement;source?:HTMLElement;
    mainView?:boolean;images:readonly {name:string;src:string}[];questions?:readonly {label:string;answered:boolean}[]|(()=>readonly {label:string;answered:boolean}[]);selected?:number;onSelect?:(index:number)=>void;answered?:boolean;
    diagnostics?:readonly InterviewDiagnostic[];historical?:readonly HistoricalInterview[];
    /** #1004: a control kept at the top of the question list (the job page's one submit for several sets). */
    listAction?:HTMLElement}) {
  const question=options.question,copy=new Map<HTMLElement,string>();
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K,content?:string)=>element(tag,content,options.node);
  const node:InterviewText=(tag,key)=>{const result=options.node?options.node(tag,key):element(tag,key===undefined?undefined:t(key));if(key!==undefined)copy.set(result,key);return result;};
  const form=options.form??make('form'),fields=options.fieldset??make('fieldset');
  if(!options.fieldset)form.append(fields);
  const joined=options.id.startsWith('joined-interview-');
  form.setAttribute('translate','no');
  form.className='interview-answer interview-grid';form.dataset.interviewAnswered=String(options.answered??Boolean((joined&&question.saved)||question.answer));
  fields.className='interview-answer-fields';fields.id=options.id;fields.disabled=!question.editable;
  const heading=make('h3',question.set.question);fields.append(heading);
  const historical=question.answer?.choice as {picks?:Picks['picks'];note?:string}|undefined;
  const retainedNote=question.saved?.note??historical?.note;
  const answers=question.set.asks.map(item=>{
    const pick=question.saved?.picks.find(value=>value.ask===item.id)??historical?.picks?.find(value=>value.ask===item.id);
    const kind=item.options.find(option=>option.id===pick?.option_id)?.kind;
    const fragments=(question.answer?.agent_decision as {fragments?:unknown}|undefined)?.fragments;
    const autoResolved=!question.editable&&Array.isArray(fragments)&&fragments.some(fragment=>fragment?.ask===item.id);
    const pendingHidden=!(kind==='auto'&&!autoResolved||kind==='other'&&!(pick&&'other_fragment' in pick));
    const answer=interviewAskGroup(item,{text:node,name:'choice.'+item.id,otherName:'other.'+item.id,pick,pendingHidden});
    fields.append(answer.group);return {item,answer};
  });
  const noteId=options.id+'-note',noteLabel=node('label','interview.noteLabel'),noteInput=make('textarea'),noteView=make('pre');
  noteLabel.htmlFor=noteId;noteLabel.setAttribute('for',noteId);
  noteInput.id=noteId;noteInput.setAttribute('id',noteId);noteInput.name='note';noteInput.setAttribute('name','note');
  noteInput.maxLength=10000;noteInput.setAttribute('maxlength','10000');noteInput.value=retainedNote??'';
  noteView.className='interview-note';
  const readOnly=()=>!question.editable||joined||form.dataset.interviewAnswered==='true',editableOnInit=!readOnly();
  if(editableOnInit)fields.append(noteLabel,noteInput);
  else if(retainedNote){noteView.textContent=retainedNote;fields.append(noteView);}
  const context=make('div');context.id=options.id+'-source';context.className='interview-image-context';
  if(options.source)context.append(options.source);
  context.append(node('h2',question.hasParts?'interview.parts':'interview.source'));
  if(!question.hasParts)context.append(node('p','interview.noParts'));
  if(question.partsUnavailable)context.append(node('p','interview.partsUnavailable'));
  const provenance=make('p'),binding=make('code',question.ref.path+' · '+question.ref.sha256);context.append(provenance,binding);
  if(question.answer)context.append(make('pre',[question.answer.by,question.answer.at,question.answer.source].filter(value=>typeof value==='string').join(' · ')),make('pre',typeof question.answer.verbatim==='string'?question.answer.verbatim:''));
  if(options.mainView){form.dataset.interviewMain='';Object.assign(form,{interviewImages:options.images});}
  let list:HTMLElement|undefined,records:HTMLElement|undefined;
  const refresh=()=>preserveScrollAndFocus(fields,()=>{
    submit.hidden=!question.editable||form.dataset.interviewAnswered==='true';
    noteInput.placeholder=t('interview.notePlaceholder');noteInput.setAttribute('placeholder',noteInput.placeholder);
    if(readOnly()&&noteInput.parentElement){
      noteLabel.remove();
      if(noteInput.value){noteView.textContent=noteInput.value;if(typeof noteInput.replaceWith==='function')noteInput.replaceWith(noteView);else{noteInput.remove();fields.append(noteView);}}
      else noteInput.remove();
    }
    provenance.textContent=t('interview.provenance',[question.set.drafted_by,question.set.drafted_at]);
    const questions=typeof options.questions==='function'?options.questions():options.questions;
    const items=questions?.map((item,index)=>({...item,answered:index===(options.selected??0)&&!options.listAction?form.dataset.interviewAnswered==='true':item.answered}))??[{label:question.set.question+' · '+question.set.id,answered:form.dataset.interviewAnswered==='true'}];
    const listTop=list?.scrollTop??0,listLeft=list?.scrollLeft??0;
    const next=interviewQuestionList(items,options.selected??0,options.onSelect??(()=>{}),false,options.node);if(options.listAction)next.prepend(options.listAction);list?.remove();form.prepend(next);next.scrollTop=listTop;next.scrollLeft=listLeft;list=next;
    records?.remove();records=interviewRecords(options.diagnostics,options.historical,options.node);context.append(records);
  });
  const submit=node('button','interview.save');submit.type='submit';submit.hidden=!question.editable;
  const status=node('p',!question.editable?'interview.history':question.saved?'interview.saved':'interview.choose');status.setAttribute('role','status');form.append(status);
  const localize=()=>{for(const [item,key]of copy)item.textContent=t(item.dataset.jobText??key);refresh();};
  const dispose=()=>{form.removeEventListener('input',refresh);form.removeEventListener('change',refresh);form.removeEventListener('job-form-language',localize);};
  form.addEventListener('input',refresh);form.addEventListener('change',refresh);form.addEventListener('job-form-language',localize);
  try{fields.append(context,submit);refresh();}catch(error){dispose();throw error;}
  return {form,fieldset:fields,submit,status,retainedNote,
    read:()=>jobInterviewValue(question.set.question,question.set.asks,item=>answers.find(answer=>answer.item===item)!.answer.value(),editableOnInit?noteInput.value:(retainedNote??'')),
    localize,dispose,refresh};
}
