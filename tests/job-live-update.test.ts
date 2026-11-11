import {afterEach,expect,test} from 'bun:test';
import {createJobRigScreen,type JobRigScreenPrepared} from '../web/job-rig-screen.ts';
import {rigHost,setRigHost,type RigHost,type RigHostScreen} from '../web/rig-host.ts';
import {fixturePublication,fixtureAct} from './helpers/job-window-fixture.ts';
import {parseManifest} from '../src/manifest.ts';
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
function harness(){
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
    suspend:()=>events.push('suspend '+name),resume:()=>events.push('resume '+name),dispose:()=>events.push('dispose '+name)};
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
 expect(fresh.sourceHash).toBe(b.review.sourceHash);expect(fresh.status).toBe('pending');expect(fresh.feedback).toEqual([]);expect(fresh.checkpoints).toEqual({});
 swap.rollback();expect(h.nodes()).toEqual(oldNodes);expect(rigHost()).toBe(oldHost);expect(h.view.mounted()).toBe(a);
 expect(h.events).toContain('resume 1');expect(h.events).not.toContain('dispose 1');
});
test('#743 failed candidate retains old result, routes, source, session and inspection bookmark',async()=>{
 const h=harness(),a=prepared(1);h.view.commit(a);await h.view.painted(a,new AbortController().signal);
 const oldNodes=h.nodes(),oldHost=rigHost(),before=await oldHost!.read('/api/session','GET');h.fail();const swap=h.view.commit(prepared(2));
 await expect(h.view.painted(prepared(2),new AbortController().signal)).rejects.toThrow('candidate load failed');swap.rollback();
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
 const {Transpiler}=await import('bun');const js=new Transpiler({loader:'ts'}).transformSync(body);
 for(const missing of [false,true]){
  let restored:any,notice=false,saves=0;
  const binding={mode:'single',sourceHash:'b'.repeat(64),rigs:['c'.repeat(64)]};
  const bookmark={binding:{...binding,sourceHash:'a'.repeat(64)},animation:'idle',time:.625,view:{cameras:{rig:{zoom:2,center:{x:12,y:34}},reference:null}},selection:{part:{side:'single',slot:'sleeve',mode:'solo',identity:{skin:'old-skin',attachment:'old-art'}},reference:'painting',partSet:'gone',axis:{id:'gone',value:1},turn:{schema:'rig-review-turn/1',values:{yaw:1}},person:'gone'}};
  const state=await new Function('host','partsOnly','parts','data','assets','inspectionBinding','restoreInspection','persistence','message','tr','player','turnPad','inspectionReferenceInfo',`let navigationMissing=false;${js};return restorePublicationNavigation().then(()=>navigationMissing);`)(
   {navigation:{subject:'rig',bookmark}},false,{validate(){if(missing)throw Error('missing');}},
   {manifest:{references:[{id:'painting'}],checkpoints:[],axes:[]}}, {animations:[{name:'idle'}]},()=>binding,async(value:any)=>{restored=value;},{save(){saves++;}},()=>{notice=true;},String,{sets:()=>[]},null,async()=>({people:[]}));
  expect(restored.binding).toEqual(binding);expect(bookmark.binding.sourceHash).toBe('a'.repeat(64));expect(restored.time).toBe(.625);expect(restored.view).toEqual(bookmark.view);expect(restored.selection.reference).toBe('painting');
  expect(restored.selection.part).toEqual(missing?null:{side:'single',slot:'sleeve',mode:'solo'});expect(restored.selection.part?.identity).toBeUndefined();expect(restored.selection.partSet).toBeNull();expect(restored.selection.axis).toBeNull();expect(restored.selection.person).toBeNull();expect(restored.selection.turn).toBeUndefined();expect(state).toBe(true);expect(notice).toBe(true);expect(saves).toBe(1);
 }
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
