import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

// Execute the production act-bar renderer with the same host/DOM seams, without a browser.
const main=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
const start=main.indexOf('function renderAnswerControls():void {');
const end=main.indexOf('async function restorePublicationNavigation(',start);
const rowStart=main.indexOf('function renderPendingSubjects('),rowEnd=main.indexOf('function setJobProgress(',rowStart);
if(start<0||end<=start||rowStart<0||rowEnd<=rowStart)throw new Error('ACT_BAR_SOURCE_ANCHOR');
const renderer=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(rowStart,rowEnd)+main.slice(start,end));
function harness(commenting=true) {
 const control=()=>({hidden:false,disabled:false,classList:{values:new Set<string>(),toggle(name:string,on:boolean){on?this.values.add(name):this.values.delete(name);}}});
 const rigAsk=control(),sendComments=control();
 const rigInspector={act:{hidden:true},comments:{panel:{querySelector:()=>null}}};
 const headlines:string[]=[];
 const env={
  host:{unavailable:false,jobClosed:()=>false},pendingAnswers:[] as {kind:string;stage?:string}[],
  firstPublicationPrompt:false,jobProgress:null as object|null,saving:false,draftConflict:false,
  actReadOnly:null as string|null,readOnly:null as string|null,partsOnly:false,partsSubject:{hasPendingComment:()=>false},
  rigInput:{state:'loaded'},comments:{hasPendingComment:()=>false},
  rigInspector,rigAsk,sendComments,
  el:()=>({classList:{contains:()=>false}}),commentHost:()=>commenting,hasUnsentContent:()=>false,
  renderAskHeadline:(value:string)=>headlines.push(value),
  renderDraftState:()=>api.render(),
 };
 const api=new Function('env',`with(env){${renderer};return {render:renderAnswerControls,subjects:renderPendingSubjects};}`)(env) as {
  render():void;subjects(subjects:typeof env.pendingAnswers):void;
 };
 api.render();
 return {rigAsk,sendComments,env,headlines,rigInspector,...api};
}
for(const subject of [
 {kind:'review-verdict',stage:'rig-review'},
 {kind:'review-verdict',stage:'direction-review'},
 {kind:'parts-verdict'},
])test('#1232 hides historical '+subject.kind+' controls and uses the no-ask Send comments state',()=>{
 const h=harness();
 h.subjects([subject]);
 expect(h.headlines).toEqual(["We're looking at the work together. Leave your thoughts as comments."]);
 expect(h.env.pendingAnswers).toEqual([]);
 expect(h.rigAsk.hidden).toBe(true);
 expect(h.sendComments.hidden).toBe(false);
 expect(h.sendComments.classList.values.has('primary')).toBe(true);
 expect(h.sendComments.disabled).toBe(true);
 h.env.hasUnsentContent=()=>true;h.render();expect(h.sendComments.disabled).toBe(false);
});
test('#1232 Send comments is gated while loading, saving, read-only, blocked or closed',()=>{
 const {env,sendComments,render}=harness();
 env.hasUnsentContent=()=>true;
 const blockedStates:Partial<typeof env>[]=[
  {saving:true},{draftConflict:true},{actReadOnly:'Job closed'},{readOnly:'Read only'},
  {host:{...env.host,unavailable:true}},{partsOnly:true,rigInput:{state:'pending'}},
 ];
 for(const state of blockedStates){
  const previous={...env};
  Object.assign(env,state);render();expect(sendComments.disabled).toBe(true);
  Object.assign(env,previous);render();expect(sendComments.disabled).toBe(false);
 }
 env.host.jobClosed=()=>true;render();expect(sendComments.hidden).toBe(true);
});
test('#1232 a pending composer can enable Send comments on rig and parts',()=>{
 const h=harness();
 h.env.comments.hasPendingComment=()=>true;h.render();expect(h.sendComments.disabled).toBe(false);
 h.env.partsOnly=true;h.render();expect(h.sendComments.disabled).toBe(true);
 h.env.partsSubject.hasPendingComment=()=>true;h.render();expect(h.sendComments.disabled).toBe(false);
});
test('#987 and #904 progress and first-publication waiting show the row with no answer controls',()=>{
 const h=harness(false);
 expect(h.rigInspector.act.hidden).toBe(true);
 h.env.jobProgress={};h.render();expect(h.rigInspector.act.hidden).toBe(false);
 for(const control of [h.rigAsk,h.sendComments])expect(control.hidden).toBe(true);
 h.env.jobProgress=null;h.env.firstPublicationPrompt=true;h.render();
 expect(h.rigInspector.act.hidden).toBe(false);expect(h.rigAsk.hidden).toBe(true);
 expect(h.sendComments.hidden).toBe(true);
});

function draftStateRenderer(env:object):()=>void {
 const begin=main.indexOf('function renderDraftState(): void {'),end=main.indexOf('\nfunction renderProvenance',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 return new Function('env',`with(env){${script};return renderDraftState;}`)(env);
}

test('#825 draft failure leads the live job state; saved sessions use the act-bar saved label',()=>{
 const states:any[]=[];
 const env={host:{},saving:false,draftConflict:true,draftStatus:'Saved local draft was not restored: fixture.',actReadOnly:null,dirty:false,partsOnly:false,session:{updatedAt:'2026-11-20T00:00:00.000Z',feedbackWarnings:[]},
  renderAnswerControls(){},rigInspector:{actBar:{setSaveState:(state:any)=>states.push(state)}}};
 const render=draftStateRenderer(env);render();
 expect(states.at(-1).kind).toBe('failed');expect(states.at(-1).text).toBe('Saved draft could not be restored. Your draft has not been deleted. Download or discard it before submitting.');
 env.draftConflict=false;env.draftStatus='Local draft could not be saved: Draft exceeds 512 KiB. Export feedback before leaving.';render();expect(states.at(-1).text).toBe(env.draftStatus);
 (env as any).draftStatus=null;(env as any).host=null;render();expect(states.at(-1)).toEqual({kind:'saved',text:'Submitted'});
});

test.each([
 {name:'standalone package',host:null,showsRefusal:true},
 {name:'live job',host:{},showsRefusal:false},
])('#1232 $name keeps the inspection restore refusal precedence from main',({host,showsRefusal})=>{
 const draftStatus='Inspection was not restored: Saved inspection time is outside the selected clip/reference';
 const states:{kind:string;text:string}[]=[];
 draftStateRenderer({host,draftStatus,saving:false,draftConflict:false,actReadOnly:null,dirty:false,
  renderAnswerControls(){},commentHost:()=>true,hasUnsentContent:()=>false,
  commentSendState:null,session:{updatedAt:null},sentAloneRows:()=>({}),
  rigInspector:{actBar:{setSaveState:(state:{kind:string;text:string})=>states.push(state)}},
 })();
 expect(states).toEqual([showsRefusal?{kind:'saved',text:draftStatus}:{kind:'unsaved',text:'Not submitted'}]);
});

test('#833 revealing the live act row from initial markup keeps the retired ask opener hidden',()=>{
 const h=harness();
 h.rigAsk.hidden=false;
 h.rigInspector.act.hidden=true;
 h.render();
 expect(h.rigAsk.hidden).toBe(true);
 expect(h.rigInspector.act.hidden).toBe(false);
 expect(h.sendComments.disabled).toBe(true);
});

for(const item of [
 {name:'early live refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:true},
 {name:'footer-only flag on a refusal',host:{},error:true,footerOnly:true,hidden:true,reveal:true},
 {name:'ordinary loading message',host:{},error:false,footerOnly:false,hidden:true,reveal:false},
 {name:'standalone refusal',host:null,error:true,footerOnly:false,hidden:true,reveal:true},
 {name:'already rendered live refusal',host:{},error:true,footerOnly:false,hidden:false,reveal:false},
 {name:'completed live ask refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:true,rendered:true},
])test('#833 '+item.name+' preserves refusal visibility',()=>{
 const begin=main.indexOf('function message(value:'),end=main.indexOf('\nasync function api',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 const node=()=>({hidden:false,title:'',textContent:'',classList:{contains:()=>false,toggle(){}}});
 const nodes={'message':node(),'review-message':node()};
 const act={hidden:item.hidden};
 let rowReveals=0;
 const env={host:item.host,rigInspector:{act,answersRendered:item.rendered??false,syncActRow:()=>rowReveals++},el:(id:keyof typeof nodes)=>nodes[id],text:(id:keyof typeof nodes,value:string)=>{nodes[id].textContent=value;}};
 const message=new Function('env',`with(env){${script};return message;}`)(env);
 message('JOB_VISUAL_UNAVAILABLE',item.error,item.footerOnly,'source refusal');
 expect(nodes.message.textContent).toBe(item.error?'':'JOB_VISUAL_UNAVAILABLE');
 expect(nodes['review-message'].textContent).toBe('JOB_VISUAL_UNAVAILABLE');
 expect(act.hidden).toBe(item.reveal?false:item.hidden);expect(rowReveals).toBe(item.reveal?1:0);
});

for(const subject of [{kind:'signoff',stage:'plan-approved'},{kind:'checkpoint'},{kind:'interview-picks'}]){
 test('#1230 and #1232 retired '+subject.kind+' has no answer opener or question headline',()=>{
  const h=harness(false);h.subjects([subject]);
  expect(h.rigAsk.hidden).toBe(true);expect(h.sendComments.hidden).toBe(true);
  expect(h.headlines).toEqual(['Nothing is waiting for your answer.']);
 });
}
