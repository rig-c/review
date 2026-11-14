import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

// Execute the production act-bar renderer with the same host/DOM seams, without a browser.
const main=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
const start=main.indexOf('function renderAnswerControls():void {');
const end=main.indexOf('\nlet verdictSubmit:',start);
const renderer=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(start,end));
function harness(subjects:{kind:string;stage?:string}[],count=0,conflict=false){
 const control=()=>({hidden:false,disabled:false,title:'',textContent:'',onclick:null as null|((e:unknown)=>unknown),classList:{values:new Set<string>(),toggle(name:string,on:boolean){on?this.values.add(name):this.values.delete(name);}}});
 const save=control(),requestChanges=control(),rigAsk=control(),select=control(),label=control(),submit=control();
 let state:{kind:string;text:string}|null=null;const rigInspector={act:{hidden:true},actBar:{saveState:()=>state,setSaveState:(value:{kind:string;text:string})=>{state=value;}}};
 const calls:string[]=[],session={feedbackWarnings:[],status:'pending'};
 const env={host:{pendingSubjects:()=>subjects},pendingAnswers:subjects,saving:false,draftConflict:conflict,actReadOnly:null,readOnly:null,
  questionForms:[],session,rigInspector,recordComments:[],liveIssueCount:()=>count,partsAnswerBlocked:()=>false,requestChanges,rigAsk,
  recordDialog:{querySelector:(selector:string)=>selector==='fieldset:not(:disabled)'?{disabled:false}:null,querySelectorAll:()=>[submit]},
  button:()=>save,select:()=>select,document:{querySelector:()=>label},
  setSourceText:(node:any,text:string)=>node.textContent=text,setSourceAttribute:(node:any,key:string,value:string)=>node[key]=value,
  verdictSubmit:()=>calls.push(session.status),MouseEvent:class{constructor(public type:string){}}};
 const render=new Function('env',`with(env){${renderer};return renderAnswerControls;}`)(env);
 render();return {save,requestChanges,rigAsk,submit,session,calls,env,render,rigInspector};
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
for(const kind of ['signoff','interview-picks','checkpoint'])test('#809 '+kind+' has one answer opener and no redundant submit',()=>{
 const h=harness([{kind}]);expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);expect(h.rigAsk.hidden).toBe(false);expect(h.rigAsk.disabled).toBe(false);expect(h.rigAsk.classList.values.has('primary')).toBe(true);
 const mixed=harness([{kind:'review-verdict',stage:'rig-review'},{kind}]);expect(mixed.rigAsk.hidden).toBe(true);expect(mixed.submit.disabled).toBe(true);
});
test('#809 no pending ask has no emphasised action',()=>{
 const h=harness([]);expect(h.save.hidden).toBe(true);expect(h.rigAsk.hidden).toBe(true);expect(h.save.classList.values.size+h.rigAsk.classList.values.size).toBe(0);expect(h.rigInspector.act.hidden).toBe(true);
});
for(const kind of ['review-verdict','parts-verdict','signoff','interview-picks','checkpoint'])test('#825 restore conflict blocks all '+kind+' submitting controls',()=>{
 const h=harness([{kind}],3,true);expect(h.rigAsk.disabled).toBe(true);expect(h.submit.disabled).toBe(true);
 if(kind.endsWith('verdict')){expect(h.save.disabled).toBe(true);expect(h.requestChanges.disabled).toBe(true);}
});

test('#825 draft failure leads the live job state; saved answers use the act-bar saved label',()=>{
 const begin=main.indexOf('function renderDraftState(): void {'),end=main.indexOf('\nfunction renderProvenance',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 const states:any[]=[];
 const env={host:{reviewState:()=> 'Reviewing · 0 issues'},liveIssueCount:()=>0,saving:false,draftConflict:true,draftStatus:'Saved local draft was not restored: fixture.',answerSaved:false,actReadOnly:null,dirty:false,
  renderAnswerControls(){},rigInspector:{actBar:{setSaveState:(state:any)=>states.push(state)}}};
 const render=new Function('env',`with(env){${script};return renderDraftState;}`)(env);render();
 expect(states.at(-1).kind).toBe('failed');expect(states.at(-1).text).toBe('Saved draft could not be restored. Your draft has not been deleted. Download or discard it before submitting.');
 env.draftConflict=false;env.draftStatus='Local draft could not be saved: Draft exceeds 512 KiB. Export feedback before leaving.';render();expect(states.at(-1).text).toBe(env.draftStatus);
 env.answerSaved=true;render();expect(states.at(-1).text).toBe('Answer saved');
});

test('#833 live act reveals only after controls render and initialises the shared save state once',()=>{
 const h=harness([{kind:'interview-picks'}]);expect(h.rigInspector.act.hidden).toBe(false);
 const state=h.rigInspector.actBar.saveState();expect(state).toEqual({kind:'unsaved',text:'Not submitted'});
 h.render();expect(h.rigInspector.actBar.saveState()).toBe(state);
});

for(const item of [
 {name:'early live refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:true},
 {name:'footer-only refusal',host:{},error:true,footerOnly:true,hidden:true,reveal:false},
 {name:'ordinary loading message',host:{},error:false,footerOnly:false,hidden:true,reveal:false},
 {name:'standalone refusal',host:null,error:true,footerOnly:false,hidden:true,reveal:false},
 {name:'already rendered live refusal',host:{},error:true,footerOnly:false,hidden:false,reveal:false},
 {name:'completed live ask refusal',host:{},error:true,footerOnly:false,hidden:true,reveal:false,rendered:true},
])test('#833 '+item.name+' preserves refusal visibility without exposing legacy acts',()=>{
 const begin=main.indexOf('function message(value:'),end=main.indexOf('\nasync function api',begin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(begin,end));
 const node=()=>({hidden:false,title:'',textContent:'',classList:{toggle(){}}});
 const nodes={'message':node(),'review-message':node()},legacy=[node(),node(),node()];
 const act={hidden:item.hidden,querySelectorAll:()=>legacy};
 let rowReveals=0;
 const env={host:item.host,rigInspector:{act,answersRendered:item.rendered??false,syncActRow:()=>rowReveals++},el:(id:keyof typeof nodes)=>nodes[id],text:(id:keyof typeof nodes,value:string)=>{nodes[id].textContent=value;}};
 const message=new Function('env',`with(env){${script};return message;}`)(env);
 message('JOB_VISUAL_UNAVAILABLE',item.error,item.footerOnly,'source refusal');
 expect(nodes.message.textContent).toBe('JOB_VISUAL_UNAVAILABLE');
 expect(nodes['review-message'].textContent).toBe(item.footerOnly?'':'JOB_VISUAL_UNAVAILABLE');
 expect(act.hidden).toBe(item.reveal?false:item.hidden);expect(rowReveals).toBe(item.reveal?1:0);
 expect(legacy.map(control=>control.hidden)).toEqual(item.reveal?[true,true,true]:[false,false,false]);
});

test('#839 answered Question readback does not reveal completed answer controls or the act row',()=>{
 const h=harness([]);(h.env as any).questionForms=[{dataset:{interviewAnswered:'true'},querySelector:()=>({disabled:true}),querySelectorAll:()=>[]}];h.render();
 expect(h.rigAsk.hidden).toBe(true);expect(h.save.hidden).toBe(true);expect(h.requestChanges.hidden).toBe(true);expect(h.rigAsk.classList.values.has('primary')).toBe(false);expect(h.rigInspector.act.hidden).toBe(true);
});


for(const sample of [
 {name:'saved interview-only',record:true,subjects:[],saved:true,expected:'Answer saved'},
 {name:'pending interview',record:true,subjects:[{kind:'interview-picks'}],saved:false,expected:'Not submitted'},
 {name:'rig verdict after an interview answer',record:false,subjects:[{kind:'review-verdict',stage:'rig-review'}],saved:true,expected:'Not submitted'},
 {name:'parts verdict after an interview answer',record:false,subjects:[{kind:'parts-verdict'}],saved:true,expected:'Not submitted'},
 {name:'record host with a pending verdict',record:true,subjects:[{kind:'review-verdict',stage:'rig-review'}],saved:true,expected:'Not submitted'},
 {name:'saved interview with a pending checkpoint',record:true,subjects:[{kind:'checkpoint'}],saved:true,expected:'Not submitted'},
 {name:'saved interview with a footer refusal',record:true,subjects:[],saved:true,error:true,expected:'JOB_VISUAL_UNAVAILABLE'},
])test('#851 footer '+sample.name+' reads the production footer node',()=>{
 const begin=main.indexOf('function renderDraftState(): void {'),end=main.indexOf('\nfunction renderProvenance',begin);
 const messageBegin=main.indexOf('function message(value:'),messageEnd=main.indexOf('\nasync function api',messageBegin);
 const script=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(messageBegin,messageEnd)+'\n'+main.slice(begin,end));
 const footer={textContent:sample.error?'JOB_VISUAL_UNAVAILABLE':'Not submitted',title:'',classList:{error:!!sample.error,contains(name:string){return name==='error'&&this.error;},toggle(name:string,on:boolean){if(name==='error')this.error=on;}}};
 const nodes={message:footer,'review-message':{...footer,textContent:''},dirty:{...footer,textContent:'Not submitted'}};
 const env={host:{...(sample.record?{record:{hasPicture:true}}:{}),pendingSubjects:()=>sample.subjects,reviewState:()=> 'Reviewing'},pendingAnswers:sample.subjects,liveIssueCount:()=>0,saving:false,draftConflict:false,draftStatus:null,answerSaved:sample.saved,actReadOnly:null,dirty:false,renderAnswerControls(){},rigInspector:{actBar:{setSaveState(state:{text:string}){nodes.dirty.textContent=state.text;}},act:{hidden:false}},sourceTextContent:(node:{textContent:string})=>node.textContent,el:(id:keyof typeof nodes)=>nodes[id],text:(id:keyof typeof nodes,value:string)=>{nodes[id].textContent=value;}};
 const render=new Function('env',`with(env){${script};return renderDraftState;}`)(env);render();
 const footerText=()=>nodes.message.textContent;expect(footerText()).toBe(sample.expected);
});
