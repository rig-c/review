import {readOnlyReason} from '../web/instance-access.ts';
import {afterEach,expect,test} from 'bun:test';
import {createJobRigScreen,type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {rigHost,setRigHost,type RigHost,type RigHostScreen} from '../web/rig-host.ts';
import {fixturePublication,fixtureAct} from './helpers/job-window-fixture.ts';
import {parseManifest} from '../src/manifest.ts';
import {createJobWindow} from '../web/job-session.ts';
import {enCatalog} from '../web/catalog-en.ts';
import type {PendingAskV3,ActV3} from '../src/job-contract.ts';

const originalDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
afterEach(()=>{setRigHost(null);if(originalDocument)Object.defineProperty(globalThis,'document',originalDocument);else Reflect.deleteProperty(globalThis,'document');});
function prepared(index:number,parts=false):JobRigScreenPrepared {
 const display=fixturePublication(index),source=display.publication.source;
 return {jobRigScreen:true,display,entry:'http://127.0.0.1:4318'+display.routes.entry,checkpoints:new Set(),
  review:{manifest:parseManifest({schema:'rig-review/1',id:source.package.id,revision:source.package.revision,title:display.publication.label}),sourceHash:source.sourceHash,
   reviewedSource:{packageRevision:source.package.revision,viewerVersion:'test',runtimeVersion:'test',rig:source.model??null,motion:null}},
  ...(parts?{parts:{sourceHash:source.sourceHash,mode:'parts',items:[]} as never}:{})};
}
function harness(onResume?:()=>void|Promise<void>){
 let nodes:unknown[]=[{id:'old-root'}],fail=false,incompatible=false;
 const events:string[]=[],screens:RigHostScreen[]=[],hosts:RigHost[]=[];
 const bookmark={binding:{sourceHash:'a'.repeat(64)},time:.625,selection:{part:{slot:'sleeve',mode:'solo'},reference:'painting'},view:{cameras:{rig:{zoom:2,center:{x:12,y:34}}}}};
 const pending:(PendingAskV3&{act?:ActV3})[]=[];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{title:'A',createElement:()=>({id:''})}});
 const view=createJobRigScreen({host:{get childNodes(){return nodes;},classList:{remove(){}},replaceChildren(...next:unknown[]){nodes=next;}} as unknown as HTMLElement,
  pageId:'page',access:{capability:'fixture',headers:()=>new Headers()},window:{state:()=>({pending,receipt:null,generation:1,preparing:false,closed:false}),submit:async()=>{throw Error('not used');}},
  routes:display=>({entry:'http://127.0.0.1:4318'+display.routes.entry,api:path=>path}),refusal:String,
  translate:(key,values)=>{let text=enCatalog[key]??key;values?.forEach((v,i)=>text=text.replace('{'+i+'}',String(v)));return text;},
  async load(){
   const host=rigHost()!;hosts.push(host);const name=String(hosts.length);
   const screen:RigHostScreen={stage:()=>null,redraw(){},message:text=>events.push(text),pendingSubjects(){},
    navigation:()=>({subject:'rig',bookmark:structuredClone(bookmark) as never}),incompatible:()=>incompatible,
    suspend:()=>events.push('suspend '+name),resume:()=>{events.push('resume '+name);return onResume?.();},dispose:()=>events.push('dispose '+name)};
   if(fail){host.failed(new Error('candidate load failed'));return {dispose:()=>events.push('dispose candidate')};}
   screens.push(screen);host.attach(screen);host.displayed();return {dispose:screen.dispose};
  }});
 return {view,events,hosts,pending,bookmark,nodes:()=>nodes,fail:()=>{fail=true;},missing:()=>{incompatible=true;}};
}

test('#743 publication swaps in place and transports navigation only; ack failure restores old DOM and host binding',async()=>{
 const h=harness(),a=prepared(1),b=prepared(2);const first=h.view.commit(a);await h.view.painted(a,new AbortController().signal);first.finalize();
 const oldNodes=h.nodes(),oldHost=rigHost();const swap=h.view.commit(b);await h.view.painted(b,new AbortController().signal);
 expect(h.hosts[1]!.navigation).toEqual({subject:'rig',bookmark:h.bookmark} as never);
 expect(h.hosts[1]!.access.key).toBe(b.display.publication.instanceKey);
 const fresh=await h.hosts[1]!.read('/api/session','GET') as any;
 expect(fresh.sourceHash).toBe(b.review!.sourceHash);expect(fresh.status).toBe('pending');expect(fresh.feedback).toEqual([]);expect(fresh.checkpoints).toEqual({});
 await swap.rollback();expect(h.nodes()).toEqual(oldNodes);expect(rigHost()).toBe(oldHost);expect(h.view.mounted()).toBe(a);
 expect(h.events).toContain('resume 1');expect(h.events).not.toContain('dispose 1');
});
test('#743 failed candidate retains old result, routes, source, session and inspection bookmark',async()=>{
 const h=harness(),a=prepared(1);h.view.commit(a);await h.view.painted(a,new AbortController().signal);
 const oldNodes=h.nodes(),oldHost=rigHost(),before=await oldHost!.read('/api/session','GET');h.fail();const swap=h.view.commit(prepared(2));
 await expect(h.view.painted(prepared(2),new AbortController().signal)).rejects.toThrow('candidate load failed');await swap.rollback();
 expect(h.nodes()).toEqual(oldNodes);expect(rigHost()).toBe(oldHost);expect(await rigHost()!.read('/api/session','GET')).toEqual(before);
 expect(h.hosts[0]!.access.key).toBe(a.display.publication.instanceKey);expect(h.events).toContain('resume 1');expect(h.events).not.toContain('dispose 1');
 h.view.changed({pending:[],closed:false,error:'candidate load failed'});expect(h.events.at(-1)).toContain(enCatalog['job.failed']);
});
test('#743 successful swap disposes only prior screen and shows A to B plus missing selection in existing status',async()=>{
 const h=harness(),a=prepared(1),b=prepared(2);let tx=h.view.commit(a);await h.view.painted(a,new AbortController().signal);tx.finalize();
 tx=h.view.commit(b);await h.view.painted(b,new AbortController().signal);tx.finalize();h.missing();
 h.view.changed({pending:[],closed:false,preparing:false,previousLabel:'Rig 1',displayed:b.display});
 expect(h.events).toContain('dispose 1');expect(h.events).not.toContain('dispose 2');
 expect(h.events.at(-1)).toBe('Updated from Rig 1 to Rig 2. · '+enCatalog['job.incompatible']);
});
for(const parts of [true,false])test(`#743 all status phases follow ${parts?'parts':'rig'} verdict, independent of mode and other subject acts`,async()=>{
 const h=harness(),p=prepared(1,parts);h.view.commit(p);await h.view.painted(p,new AbortController().signal);const host=rigHost()!;
 const kind=parts?'parts-verdict':'review-verdict',other=parts?'review-verdict':'parts-verdict';
 const ask=(act:ActV3)=>({askId:'a',publicationId:p.display.publication.publicationId,subject:act.kind==='parts-verdict'?{kind:act.kind}:{kind:act.kind,stage:'rig-review'},status:'answered',act}) as never;
 h.pending.push(ask(fixtureAct(other)));expect(host.reviewState!(3,false)).toBe('Reviewing · 3 issues');expect(host.reviewState!(3,true)).toBe('Sending');
 const act=fixtureAct(kind) as any;act.value.verdict='changes-requested';h.pending.push(ask(act));expect(host.reviewState!(3,false)).toBe(enCatalog['job.parts.sent']!);
 act.value.verdict='approved';h.pending.splice(1,1,ask(act));expect(host.reviewState!(0,false)).toBe(enCatalog['job.review.approved']!);
 h.pending.push({...h.pending[1],status:'pending',act:undefined} as never);expect(host.reviewState!(2,false)).toBe('Reviewing · 2 issues');
 h.pending.splice(0,h.pending.length, {...ask(act) as any,publicationId:'other'});expect(host.reviewState!(1,false)).toBe('Reviewing · 1 issues');
});

test('#743 main caller rebinds only navigation; missing selection clears Solo and preserves camera/reference/time',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const body=main.slice(main.indexOf('async function restorePublicationNavigation()'),main.indexOf('function suspendScreen()'));
 const helperStart=main.indexOf('function inspectionTimeLimit(');expect(helperStart).toBeGreaterThan(0);
 const helper=main.slice(helperStart,main.indexOf('async function prepareInspection(',helperStart));
 const {Transpiler}=await import('bun');const js=new Transpiler({loader:'ts'}).transformSync(helper+body);
 for(const missing of [false,true]){
  let restored:any,notice=false,saves=0;
  const binding={mode:'single',sourceHash:'b'.repeat(64),rigs:['c'.repeat(64)]};
  const bookmark={binding:{...binding,sourceHash:'a'.repeat(64)},animation:'idle',time:.625,view:{cameras:{rig:{zoom:2,center:{x:12,y:34}},reference:null}},selection:{part:{side:'single',slot:'sleeve',mode:'solo',identity:{skin:'old-skin',attachment:'old-art'}},reference:'painting',partSet:'gone',axis:{id:'gone',value:1},turn:{schema:'rig-review-turn/1',values:{yaw:1}},person:'gone'}};
  const state=await new Function('host','partsOnly','parts','data','assets','inspectionBinding','restoreInspection','persistence','message','tr','player','turnPad','inspectionReferenceInfo',`const activeScene=()=>undefined;let navigationMissing=false;${js};return restorePublicationNavigation().then(()=>navigationMissing);`)(
   {navigation:{subject:'rig',bookmark}},false,{validate(){if(missing)throw Error('missing');}},
   {manifest:{references:[{id:'painting'}],checkpoints:[],axes:[]}}, {animations:[{name:'idle',duration:10}]},()=>binding,async(value:any)=>{restored=value;},{save(){saves++;}},()=>{notice=true;},String,{sets:()=>[]},null,async()=>({people:[],duration:null}));
  expect(restored.binding).toEqual(binding);expect(bookmark.binding.sourceHash).toBe('a'.repeat(64));expect(restored.time).toBe(.625);expect(restored.view).toEqual(bookmark.view);expect(restored.selection.reference).toBe('painting');
  expect(restored.selection.part).toEqual(missing?null:{side:'single',slot:'sleeve',mode:'solo'});expect(restored.selection.part?.identity).toBeUndefined();expect(restored.selection.partSet).toBeNull();expect(restored.selection.axis).toBeNull();expect(restored.selection.person).toBeNull();expect(restored.selection.turn).toBeUndefined();expect(state).toBe(true);expect(notice).toBe(true);expect(saves).toBe(1);
 }
});

for(const scenario of [
 {name:'same idle shortens from at least 8 seconds to 2',clip:2,referenceType:'image',referenceDuration:null,time:8,expected:0,missing:true},
 {name:'same idle remains 8 seconds and keeps endpoint',clip:8,referenceType:'image',referenceDuration:null,time:8,expected:8,missing:false},
 {name:'video reference is shorter than the clip',clip:10,referenceType:'video',referenceDuration:2,time:8,expected:0,missing:true},
 {name:'clip is shorter than the video reference',clip:2,referenceType:'video',referenceDuration:10,time:8,expected:0,missing:true},
 {name:'pose reference duration does not shorten a named clip',clip:10,referenceType:'pose',referenceDuration:2,time:8,expected:8,missing:false},
 {name:'no selected clip uses reference duration',clip:null,referenceType:'video',referenceDuration:2,time:8,expected:0,missing:true},
 {name:'null inspection time remains null',clip:2,referenceType:'video',referenceDuration:1,time:null,expected:null,missing:false},
 {name:'negative carried time resets before validation',clip:2,referenceType:'image',referenceDuration:null,time:-1,expected:0,missing:true},
 {name:'negative duration keeps the existing unbounded upper check',clip:-1,referenceType:'image',referenceDuration:null,time:8,expected:8,missing:false},
 {name:'implicit selected video uses the same reference minimum',clip:10,referenceType:'video',referenceDuration:2,time:8,expected:0,missing:true,implicitReference:true},
])test('#743 carried publication time: '+scenario.name,async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const restore=main.slice(main.indexOf('async function restorePublicationNavigation()'),main.indexOf('function suspendScreen()'));
 const prepare=main.slice(main.indexOf('async function prepareInspection('),main.indexOf('async function applyInspection('));
 const helperStart=main.indexOf('function inspectionTimeLimit(');
 expect(helperStart).toBeGreaterThan(0);
 const helper=main.slice(helperStart,main.indexOf('async function prepareInspection(',helperStart));
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(helper+prepare+restore);
 const binding={mode:'single',sourceHash:'b'.repeat(64),rigs:['c'.repeat(64)]};
 const bookmark={binding:{...binding,sourceHash:'a'.repeat(64)},animation:scenario.clip===null?null:'idle',time:scenario.time,
  view:{cameras:{rig:{zoom:2,center:{x:12,y:34}},reference:{zoom:3,center:{x:56,y:78}}}},
  selection:{part:{side:'single',slot:'sleeve',mode:'solo'},...scenario.implicitReference?{}:{reference:'reference'}}};
 const result:{restored?:any;notices:string[];saves:number}={notices:[],saves:0};
 const scope={host:{navigation:{subject:'rig',bookmark}},partsOnly:false,parts:{validate(){}},
  data:{manifest:{references:[{id:'reference',type:scenario.referenceType}],checkpoints:[],axes:[]}},
  assets:{animations:scenario.clip===null?[]:[{name:'idle',duration:scenario.clip}]},inspectionBinding:()=>binding,
  persistence:{save(){result.saves++;}},message:(value:string)=>result.notices.push(value),tr:String,
  player:{sets:()=>[]},turnPad:null,select:()=>({value:'reference'}),
  inspectionReferenceInfo:async()=>({width:100,height:100,duration:scenario.referenceDuration,people:[]}),result};
 // Execute the actual validator on the normalized bookmark: an out-of-range restore must reject the old implementation.
 const validate=await new Function('scope',`with(scope){const activeScene=()=>undefined;let navigationMissing=false;${js};async function restoreInspection(bookmark,signal){await prepareInspection(bookmark,signal);result.restored=structuredClone(bookmark);}return restorePublicationNavigation().then(()=>{result.missing=navigationMissing;return prepareInspection;});}`)(scope);
 if(scenario.missing)await expect(validate(bookmark,new AbortController().signal)).rejects.toThrow('Saved inspection time is outside the selected clip/reference');
 else await validate(bookmark,new AbortController().signal);
 expect(result.restored.time).toBe(scenario.expected);expect((result as any).missing).toBe(scenario.missing);
 expect(result.notices).toEqual(scenario.missing?['job.incompatible']:[]);expect(result.saves).toBe(1);
 expect(result.restored.animation).toBe(bookmark.animation);expect(result.restored.binding).toEqual(binding);
 expect(bookmark.binding.sourceHash).toBe('a'.repeat(64));expect(bookmark.time).toBe(scenario.time);
 expect(result.restored.selection).toEqual(bookmark.selection);expect(result.restored.view).toEqual(bookmark.view);
});

test('#743 parts caller keeps named selection, Solo, both numeric cameras and layout; a removed part clears only selection',async()=>{
 const source=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();const body=source.slice(source.indexOf('async function restorePublicationNavigation()'),source.indexOf('function suspendScreen()'));
 const {Transpiler}=await import('bun');const js=new Transpiler({loader:'ts'}).transformSync(body);
 for(const missing of [false,true]){
  const writes:any[]=[],selected:any[]=[],solo:any[]=[],camera={cameras:{rig:{center:{x:12,y:34},zoom:2},reference:{center:{x:56,y:78},zoom:3}},cameraSync:false};let paints=0;
  const result=await new Function('host','partsSubject','api','parts','viewport','renderLayout','fitCamera','message','tr',`let view='rig',navigationMissing=false;${js};return restorePublicationNavigation().then(()=>({view,navigationMissing}));`)(
   {navigation:{subject:'parts',part:'sleeve',solo:true,view:'compare',camera}},
   {select:(value:any)=>selected.push(value),isolate:(value:any)=>solo.push(value),paint:async()=>{paints++;}},async()=>({parts:{items:missing?[]:[{name:'sleeve'}]}}),{refreshImages(){}},
   {cancelFit(){},state:{},writeCamera:(target:any,value:any)=>writes.push([target,value])},()=>{},()=>{},()=>{},String);
  expect(selected).toEqual([missing?null:'sleeve']);expect(solo).toEqual([!missing]);expect(writes).toEqual([['rig',camera.cameras.rig],['reference',camera.cameras.reference]]);expect(paints).toBe(1);expect(result).toEqual({view:'compare',navigationMissing:missing});
 }
});

test('#743 rollback resume waits for workspace redocking and persistence before reporting ready',async()=>{
 const source=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();const body=source.slice(source.indexOf('async function resumeScreen()'),source.indexOf('function disposeScreen()'));
 const {Transpiler}=await import('bun');const js=new Transpiler({loader:'ts'}).transformSync(body);
 for(const recordWithoutPicture of [false,true]){
 const queue:Function[]=[],events:string[]=[],screenRoot={inert:false},document={body:{dataset:{ready:'true'} as Record<string,string>,removeAttribute(name:string){if(name==='data-ready')delete this.dataset.ready;}}};let docked=false;
 const resume=new Function('window','document','screenRoot','workspace','setupPersistence','requestAnimationFrame','tick','host',`let disposed=false,suspended=true,partsOnly=false,frameHandle=0;const publicEditor={};${js};return resumeScreen;`)(
  {},document,screenRoot,{settle(){return new Promise<void>(resolve=>queue.push(()=>{docked=true;events.push('docked');resolve();}));}},async()=>{if(!docked)throw Error('Missing UI element: feedback-target-name');events.push('persistence');},(fn:Function)=>{queue.push(fn);return queue.length;},()=>{},recordWithoutPicture?{record:{hasPicture:false}}:null);
 const done=resume();let complete=false;const completed=Promise.resolve(done).then(()=>{complete=true;});
 expect(document.body.dataset.ready).toBeUndefined();expect(screenRoot.inert).toBe(true);
 for(let i=0;i<6&&!complete;i++){for(const task of queue.splice(0))task();await Promise.resolve();}
 await completed;expect(events).toEqual(recordWithoutPicture?['docked']:['docked','persistence']);expect(document.body.dataset.ready).toBe('true');expect(screenRoot.inert).toBe(false);
 }
});

test('#743 scoped element lookup resolves only the mount root or its owned workspace portals',async()=>{
 const source=await Bun.file(new URL('../web/main.ts',import.meta.url)).text(),body=source.slice(source.indexOf('const el = <'),source.indexOf('const input ='));
 const {Transpiler}=await import('bun');const js=new Transpiler({loader:'ts'}).transformSync(body),own={id:'feedback-target-name'},other={id:'other-source-only'};
 const lookup=new Function('screenRoot','workspace','document',js+';return el;')({querySelector:()=>null},{element:(id:string)=>id===own.id?own:null},{getElementById:()=>other});
 expect(lookup(own.id)).toBe(own);expect(()=>lookup(other.id)).toThrow('Missing UI element: other-source-only');
});

test('#743 failed candidate painting awaits prior source resume before returning the load failure',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),h=harness(()=>gate),a=prepared(1);
 const first=h.view.commit(a);await h.view.painted(a,new AbortController().signal);first.finalize();
 h.fail();const transaction=h.view.commit(prepared(2));let complete=false;
 const failed=h.view.painted(prepared(2),new AbortController().signal).then(()=>{throw Error('expected refusal');},error=>{complete=true;return String(error);});
 for(let i=0;i<6;i++)await Promise.resolve();expect(h.events).toContain('resume 1');expect(complete).toBe(false);
 release();expect(await failed).toContain('candidate load failed');await transaction.rollback();expect(h.events.filter(value=>value==='resume 1')).toHaveLength(1);expect(h.view.mounted()).toBe(a);
});

test('#743 window replacement keeps preparing until asynchronous rollback restoration completes',async()=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),display=fixturePublication();
 const window=createJobWindow({jobId:'window-fixture',pageId:'page',transport:{readPublication:async()=>({ok:true,value:display}),acknowledge:async()=>({ok:false,error:{code:'JOB_DISPLAY_MISMATCH',message:'planted acknowledgment refusal'}}),submit:async()=>{throw Error('not used');}},
  adapter:{prepare:async()=>display,captureDraft:()=>null,commit:()=>({async rollback(){entered();await gate;},finalize(){}}),painted:async()=>{},discard(){},changed(){}}});
 const pending=window.replace(display.publication);await started;expect(window.state().preparing).toBe(true);release();await pending;expect(window.state().preparing).toBe(false);expect(window.state().error).toBe('JOB_DISPLAY_MISMATCH');window.stop();
});


test('#743 no-picture record attaches owned lifecycle only after asynchronous workspace readiness',async()=>{
 const source=await Bun.file(new URL('../web/main.ts',import.meta.url)).text();
 const body=source.slice(source.indexOf('async function startRecord('),source.indexOf('let recordDialog:'));
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(body),events:string[]=[],disposers:Function[]=[];
 let settle!:()=>void,attached:any;
 const commentButton={disabled:true},stageCommentButton={disabled:true};let commentsSetup=0;
 const document={body:{dataset:{} as Record<string,string>},querySelectorAll:()=>[]};
 const suspend=()=>{},resume=async()=>{},dispose=()=>{};
 const scope={document,host:{record:{label:'Plan',sourceHash:'a'.repeat(64),hasPicture:false},attach(screen:unknown){attached=screen;events.push('attached');},displayed(){expect(document.body.dataset.ready).toBe('true');events.push('displayed');}},
  readOnly:null,actReadOnly:null,access:{capability:"owner"},readOnlyReason,rigInput:null,referenceInput:null,parts:null,disposed:false,tr:String,
  bindWorkspace(){},bindInspector(){},renderLayout(){},text(){},message(){},el:()=>({hidden:false,children:[]}),
  restoreRecordComments(){},showRecordComments(){},setupComments(){commentsSetup++;},rigInspector:{comments:{button:commentButton}},button:()=>stageCommentButton,
  PartExplorer:class{},workspace:{settle:()=>new Promise<void>(resolve=>{settle=resolve;})},
  viewport:{observeResize:()=>({disconnect:()=>events.push('disconnected')})},viewDisposers:disposers,
  renderRecordForms(){},renderPendingSubjects(){},suspendScreen:suspend,resumeScreen:resume,disposeScreen:dispose};
 const run=new Function('scope',`with(scope){${js};return startRecord();}`);
 const pending=run(scope);expect(attached).toBeUndefined();expect(document.body.dataset.ready).toBeUndefined();
 settle();await pending;expect(events).toEqual(['attached','displayed']);
 expect(commentsSetup).toBe(1);expect(commentButton.disabled).toBe(false);expect(stageCommentButton.disabled).toBe(false);
 expect(attached.suspend).toBe(suspend);expect(attached.resume).toBe(resume);expect(attached.dispose).toBe(dispose);
 expect(attached.navigation).toBeUndefined();expect(attached.incompatible).toBeUndefined();expect(attached.recordForms).toBe(scope.renderRecordForms);
 for(const close of disposers)close();expect(events.at(-1)).toBe('disconnected');
});

test('#784 record comment restoration does not arm the unrelated package beforeunload gate',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text(),start=main.indexOf('function setupComments():void {');
 const prefix=main.slice(start+'function setupComments():void {'.length,main.indexOf(' comments=bindStageComments',start));
 for(const kind of ['record','direction'] as const){
  const rows:unknown[]=[],scope={host:{[kind]:{}},recordComments:rows,dirty:false,liveIssueCount:null as null|(()=>number),restoreRecordComments(){rows.push({summary:'retained point'});}};
  new Function('scope',`with(scope){${prefix}}`)(scope);
  expect(scope.liveIssueCount!()).toBe(1);expect(scope.dirty).toBe(kind==='direction');
 }
});

test('#784 reference video startup reuses media readiness without forcing a new control frame callback',async()=>{
 const main=await Bun.file(new URL('../web/main.ts',import.meta.url)).text(),start=main.indexOf('      if(!player&&video){');
 const body=main.slice(start,main.indexOf("      if(!player&&(data.manifest.model",start));
 const run=new Function('scope',`with(scope){return (async()=>{${new Bun.Transpiler({loader:'ts'}).transformSync(body)}})();}`);
 for(const ready of [0,2]){
  const calls:string[]=[],video={readyState:ready,seeking:ready===0,currentTime:0},scope={player:null,video,time:0,lifecycle:new AbortController(),referenceInput:{state:'pending'},waitReferenceMetadata:async()=>{calls.push('metadata');video.readyState=Math.max(1,video.readyState);},mediaReady:async(_video:unknown,event:string)=>{calls.push(event);if(event==='loadeddata')video.readyState=2;else video.seeking=false;},setReferenceInput(value:{state:string}){scope.referenceInput=value;}};
  await run(scope);expect(scope.referenceInput.state).toBe('loaded');expect(video.currentTime).toBe(0);expect(calls).toEqual(ready===0?['metadata','loadeddata','seeked']:['metadata']);
 }
});
