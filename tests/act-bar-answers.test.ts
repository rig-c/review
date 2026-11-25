import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

// Execute the production act-bar renderer with the same host/DOM seams, without a browser.
const main=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
const start=main.indexOf('function renderAnswerControls():void {');
const end=main.indexOf('\nlet verdictSubmit:',start);
const rowStart=main.indexOf('function syncJobActRow('),rowEnd=main.indexOf('function setJobProgress(',rowStart);
const renderer=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(rowStart,rowEnd)+main.slice(start,end));
function harness(subjects:{kind:string;stage?:string}[],count=0,conflict=false){
 const control=()=>({hidden:false,disabled:false,title:'',textContent:'',onclick:null as null|((e:unknown)=>unknown),attributes:new Map<string,string>(),setAttribute(name:string,value:string){this.attributes.set(name,value);},removeAttribute(name:string){this.attributes.delete(name);},classList:{values:new Set<string>(),toggle(name:string,on:boolean){on?this.values.add(name):this.values.delete(name);}}});
 const save=control(),requestChanges=control(),rigAsk=control(),recordAsk=control(),select=control(),label=control(),submit=control();
 const requestChangesReason={...control(),id:'request-changes-reason'};
 let state:{kind:string;text:string}|null=null;const rigInspector={act:{hidden:true},actBar:{saveState:()=>state,setSaveState:(value:{kind:string;text:string})=>{state=value;}}};
 const calls:string[]=[],session={feedbackWarnings:[] as {id:string}[],status:'pending'};
 const env={host:{pendingSubjects:()=>subjects,unavailable:false,canSubmitMeshEdits:()=>false,jobClosed:()=>false},pendingAnswers:subjects,firstPublicationPrompt:false,jobProgress:null as object|null,saving:false,draftConflict:conflict,actReadOnly:null as string|null,readOnly:null as string|null,
  session,rigInspector,recordComments:[],liveIssueCount:()=>count,partsAnswerBlocked:()=>false,requestChanges,requestChangesReason,rigAsk,recordAsk,
  recordPanel:{querySelector:(selector:string)=>selector==='form[data-job-ask] fieldset:not(:disabled)'?{disabled:false}:null,querySelectorAll:()=>[submit]},
  button:()=>save,select:()=>select,document:{querySelector:()=>label},el:()=>({classList:{contains:()=>false}}),
  setSourceText:(node:any,text:string)=>node.textContent=text,setSourceAttribute:(node:any,key:string,value:string)=>node[key]=value,
  verdictSubmit:()=>calls.push(session.status),MouseEvent:class{constructor(public type:string){}}};
 const render=new Function('env',`with(env){${renderer};return renderAnswerControls;}`)(env);
 render();return {save,requestChanges,requestChangesReason,rigAsk,recordAsk,submit,session,calls,env,render,rigInspector};
}
for(const stage of ['rig-review','direction-review'])test('#809 '+stage+' directly submits the selected answer and requires a comment for changes',()=>{
 const h=harness([{kind:'review-verdict',stage}]);
 expect(h.save.hidden).toBe(false);expect(h.save.disabled).toBe(false);expect(h.requestChanges.disabled).toBe(true);expect(h.requestChanges.title).toBe('Add a comment where changes are needed.');
 h.save.onclick!({});expect(h.calls).toEqual(['approved']);
 h.env.liveIssueCount=()=>3;h.render();expect(h.requestChanges.disabled).toBe(false);
 h.requestChanges.onclick!({});expect(h.calls).toEqual(['approved','changes-requested']);
});
test('#809 parts preserves the existing issue-derived verdict contract',()=>{
 const h=harness([{kind:'parts-verdict'}]);expect(h.save.disabled).toBe(false);expect(h.requestChanges.disabled).toBe(true);
 h.env.liveIssueCount=()=>1;h.render();expect(h.save.disabled).toBe(true);expect(h.save.title).toBe('Remove the flagged parts comments before approving.');expect(h.requestChanges.disabled).toBe(false);
});
test('#1159 shows the existing reason only while missing changes blocks a visible verdict',()=>{
 const h=harness([{kind:'review-verdict',stage:'rig-review'}]);
 const {env,requestChanges,requestChangesReason,render}=h;
 expect(requestChangesReason.hidden).toBe(false);
 expect(requestChangesReason.textContent).toBe(requestChanges.title);
 expect(requestChanges.attributes.get('aria-describedby')).toBe(requestChangesReason.id);
 const blockedStates:Partial<typeof env>[]=[
  {saving:true},{draftConflict:true},{actReadOnly:'Job closed'},{readOnly:'Read only'},
  {host:{...env.host,unavailable:true}},{host:{...env.host,jobClosed:()=>true}},
  {session:{...env.session,feedbackWarnings:[{id:'invalid'}]}},
  {firstPublicationPrompt:true},
 ];
 for(const state of blockedStates){
  const previous={...env};
  Object.assign(env,state);render();
  expect(requestChangesReason.hidden).toBe(true);
  expect(requestChanges.attributes.has('aria-describedby')).toBe(false);
  Object.assign(env,previous);render();
  expect(requestChangesReason.hidden).toBe(false);
 }
 env.host.canSubmitMeshEdits=()=>true;render();
 expect(requestChanges.disabled).toBe(false);
 expect(requestChangesReason.hidden).toBe(true);
 env.host.pendingSubjects=()=>[];render();
 expect(requestChanges.hidden).toBe(true);
 expect(requestChangesReason.hidden).toBe(true);
 const parts=harness([{kind:'parts-verdict'}]);
 parts.env.partsAnswerBlocked=()=>true;parts.render();
 expect(parts.requestChanges.disabled).toBe(true);
 expect(parts.requestChangesReason.hidden).toBe(true);
});
for(const kind of ['checkpoint'])test('#809 '+kind+' has one answer opener and no redundant submit',()=>{
 const h=harness([{kind}]);expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);expect(h.rigAsk.hidden).toBe(false);expect(h.rigAsk.disabled).toBe(false);expect(h.rigAsk.classList.values.has('primary')).toBe(true);
 const mixed=harness([{kind:'review-verdict',stage:'rig-review'},{kind}]);expect(mixed.rigAsk.hidden).toBe(true);expect(mixed.submit.disabled).toBe(true);
});
test('#809 no pending ask has no emphasised action',()=>{
 const h=harness([]);expect(h.save.hidden).toBe(true);expect(h.rigAsk.hidden).toBe(true);expect(h.save.classList.values.size+h.rigAsk.classList.values.size).toBe(0);expect(h.rigInspector.act.hidden).toBe(true);
});
test('#987 progress reveals the act row with the existing actions hidden',()=>{
 const h=harness([]);h.env.jobProgress={};h.render();
 expect(h.rigInspector.act.hidden).toBe(false);
 expect([h.save,h.requestChanges,h.rigAsk].every(control=>control.hidden)).toBe(true);
 h.env.jobProgress=null;h.render();expect(h.rigInspector.act.hidden).toBe(true);
});
for(const kind of ['review-verdict','parts-verdict','checkpoint'])test('#825 restore conflict blocks all '+kind+' submitting controls',()=>{
 const h=harness([{kind}],3,true);expect(h.rigAsk.disabled).toBe(true);expect(h.submit.disabled).toBe(true);
 if(kind.endsWith('verdict')){expect(h.save.disabled).toBe(true);expect(h.requestChanges.disabled).toBe(true);}
});

test('#825 draft failure leads the live job state; saved sessions use the act-bar saved label',()=>{
 const begin=main.indexOf('function renderDraftState(): void {'),end=main.indexOf('\nfunction renderProvenance',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 const states:any[]=[];
 const env={host:{reviewState:()=> 'Reviewing · 0 issues'},liveIssueCount:()=>0,saving:false,draftConflict:true,draftStatus:'Saved local draft was not restored: fixture.',actReadOnly:null,dirty:false,partsOnly:false,verdictSubmit:null,session:{updatedAt:'2026-11-20T00:00:00.000Z',feedbackWarnings:[]},
  renderAnswerControls(){},rigInspector:{actBar:{setSaveState:(state:any)=>states.push(state)}}};
 const render=new Function('env',`with(env){${script};return renderDraftState;}`)(env);render();
 expect(states.at(-1).kind).toBe('failed');expect(states.at(-1).text).toBe('Saved draft could not be restored. Your draft has not been deleted. Download or discard it before submitting.');
 env.draftConflict=false;env.draftStatus='Local draft could not be saved: Draft exceeds 512 KiB. Export feedback before leaving.';render();expect(states.at(-1).text).toBe(env.draftStatus);
 (env as any).draftStatus=null;(env as any).host=null;render();expect(states.at(-1)).toEqual({kind:'saved',text:'Submitted'});
});

test('#833 live act reveals only after controls render and initialises the shared save state once',()=>{
 const h=harness([{kind:'checkpoint'}]);expect(h.rigInspector.act.hidden).toBe(false);
 const state=h.rigInspector.actBar.saveState();expect(state).toEqual({kind:'unsaved',text:'Not submitted'});
 h.render();expect(h.rigInspector.actBar.saveState()).toBe(state);
});

for(const item of [
 {name:'early live refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:true},
 {name:'footer-only flag on a refusal',host:{},error:true,footerOnly:true,hidden:true,reveal:true},
 {name:'ordinary loading message',host:{},error:false,footerOnly:false,hidden:true,reveal:false},
 {name:'standalone refusal',host:null,error:true,footerOnly:false,hidden:true,reveal:true},
 {name:'already rendered live refusal',host:{},error:true,footerOnly:false,hidden:false,reveal:false},
 {name:'completed live ask refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:true,rendered:true},
])test('#833 '+item.name+' preserves refusal visibility without exposing legacy acts',()=>{
 const begin=main.indexOf('function message(value:'),end=main.indexOf('\nasync function api',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 const node=()=>({hidden:false,title:'',textContent:'',classList:{contains:()=>false,toggle(){}}});
 const nodes={'message':node(),'review-message':node()},legacy=[node(),node(),node()];
 const act={hidden:item.hidden,querySelectorAll:()=>legacy};
 let rowReveals=0;
 const env={host:item.host,rigInspector:{act,answersRendered:item.rendered??false,syncActRow:()=>rowReveals++},el:(id:keyof typeof nodes)=>nodes[id],text:(id:keyof typeof nodes,value:string)=>{nodes[id].textContent=value;}};
 const message=new Function('env',`with(env){${script};return message;}`)(env);
 message('JOB_VISUAL_UNAVAILABLE',item.error,item.footerOnly,'source refusal');
 expect(nodes.message.textContent).toBe(item.error?'':'JOB_VISUAL_UNAVAILABLE');
 expect(nodes['review-message'].textContent).toBe('JOB_VISUAL_UNAVAILABLE');
 expect(act.hidden).toBe(item.reveal?false:item.hidden);expect(rowReveals).toBe(item.reveal?1:0);
 expect(legacy.map(control=>control.hidden)).toEqual(item.reveal&&!item.rendered?[true,true,true]:[false,false,false]);
});

// A first publication with no ask must not invent an answer or emphasise a verdict.
test('#904 first publication keeps its waiting row until an actual subject arrives',()=>{
 const h=harness([]);h.env.firstPublicationPrompt=true;h.render();
 expect(h.rigInspector.act.hidden).toBe(false);expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);expect(h.rigAsk.hidden).toBe(true);
 expect(h.save.classList.values.has('primary')).toBe(false);expect(h.requestChanges.classList.values.has('primary')).toBe(false);
});

for(const kind of ['review-verdict','parts-verdict','checkpoint'])test('#904 synchronous reveal prepares '+kind+' labels and keeps pending controls hidden under the waiting prompt',()=>{
 const h=harness([{kind,stage:'rig-review'}]);h.rigInspector.act.hidden=false;
 const controls=[['save',h.save],['request-changes',h.requestChanges],['workspace-pending-ask',h.rigAsk]] as const;
 const reveals:{id:string;text:string;disabled:boolean}[]=[];
 for(const [id,node]of controls){
  let hidden=true;
  Object.defineProperty(node,'hidden',{configurable:true,get:()=>hidden,set(value:boolean){hidden=value;if(!value)reveals.push({id,text:node.textContent,disabled:node.disabled});}});
 }
 h.save.textContent='Submit review';h.requestChanges.textContent='';h.rigAsk.textContent='';
 h.env.firstPublicationPrompt=true;h.render();
 expect(reveals).toEqual([]);expect(controls.every(([,node])=>node.hidden)).toBe(true);
 // Execute the real renderer from the legacy initial labels after the actual subject has been written.
 h.save.textContent='Submit review';h.requestChanges.textContent='';h.rigAsk.textContent='';
 h.env.firstPublicationPrompt=false;h.render();
 const verdict=kind.endsWith('verdict');
 expect(reveals).toEqual(verdict?[{id:'save',text:'Approve',disabled:false},{id:'request-changes',text:'Request changes',disabled:true}]:
  [{id:'workspace-pending-ask',text:'Review…',disabled:false}]);
});

test('#1228 a pending signoff subject opens no answer control and shows neither Approve… nor the stage-approval headline',()=>{
 const h=harness([{kind:'signoff',stage:'plan-approved'}]);
 expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);
 expect(h.rigAsk.hidden).toBe(true);expect(h.recordAsk.hidden).toBe(true);
 expect(h.rigAsk.textContent).not.toBe('Approve…');expect(h.recordAsk.textContent).not.toBe('Approve…');
 // Once isPendingOwnerAsk filters signoff out of pendingSubjects(), the act row stays hidden too.
 const filtered=harness([]);
 expect(filtered.rigInspector.act.hidden).toBe(true);
 const begin=main.indexOf('function renderPendingSubjects('),end=main.indexOf('\nfunction syncJobActRow(',begin);
 const headlines:string[]=[];
 const scope={partsSubject:null,partsOnly:false,host:null,pendingAnswers:[] as {kind:string;stage?:string}[],firstPublicationPrompt:false,
  renderAskHeadline:(value:string)=>headlines.push(value),renderDraftState(){}};
 const renderSubjects=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end))};return renderPendingSubjects;}`)(scope);
 renderSubjects([{kind:'signoff',stage:'plan-approved'}]);
 expect(headlines).toEqual(['Nothing is waiting for your answer.']);
});

test('#1230 a pending interview-picks subject opens no answer control and shows neither the removed opener nor the question headline',()=>{
 const h=harness([{kind:'interview-picks'}]);
 expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);
 expect(h.rigAsk.hidden).toBe(true);expect(h.recordAsk.hidden).toBe(true);
 expect(h.rigAsk.textContent).not.toBe('Answer'+'\u2026');expect(h.recordAsk.textContent).not.toBe('Answer'+'\u2026');
 expect(h.rigInspector.actBar.saveState()).toBeNull();
 // Once isPendingOwnerAsk filters interview-picks out of pendingSubjects(), the act row stays hidden without a record prompt.
 const filtered=harness([]);
 expect(filtered.rigInspector.act.hidden).toBe(true);
 const begin=main.indexOf('function renderPendingSubjects('),end=main.indexOf('\nfunction syncJobActRow(',begin);
 const headlines:string[]=[];
 const scope={partsSubject:null,partsOnly:false,host:null,pendingAnswers:[] as {kind:string;stage?:string}[],firstPublicationPrompt:false,
  renderAskHeadline:(value:string)=>headlines.push(value),renderDraftState(){}};
 const renderSubjects=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end))};return renderPendingSubjects;}`)(scope);
 renderSubjects([{kind:'interview-picks'}]);
 expect(headlines).toEqual(['Nothing is waiting for your answer.']);
});
