import {createViewportController,createViewportState} from '../web/viewport-controller.ts';
import {createRigViewportProvider} from '../web/rig-viewport-provider.ts';
import {singleRestoreWiring} from './helpers/viewport-387-wiring.ts';
import {PartInspection} from '../web/part-selection.ts';
import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {syncStageLayout} from '../web/view-controls.ts';
import {openGate} from '../src/open-protocol.ts';
import type {Json} from '../src/manifest.ts';
import {serializableView,encodeBookmark,decodeBookmark,parseBookmark,numericCamera,restoredZoom,InspectionDraftStore,sessionFingerprint,recoverSession,inspectionLink,restoreTransaction,type InspectionBinding,type InspectionBookmark,type LocalInspectionDraft} from '../web/inspection-persistence.ts';
const binding:InspectionBinding={mode:'single',sourceHash:'a'.repeat(64),rigs:['b'.repeat(64)]};
const camera=numericCamera('world',{x:10,y:20},2,2,800,600)!;
const bookmark=():InspectionBookmark=>({schema:'rig-review-inspection/1',binding,animation:'idle',time:.5,theme:'light',layers:{images:true,meshes:true,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{workspace:'modeling',view:'rig',reference:'original',checkpoint:null,person:'사람',inspector:'rig',partSet:null,axis:null}});
class MemoryStorage implements Storage {
 values=new Map<string,string>();get length(){return this.values.size;}getItem(k:string){return this.values.get(k)??null;}setItem(k:string,v:string){this.values.set(k,v);}removeItem(k:string){this.values.delete(k);}key(i:number){return [...this.values.keys()][i]??null;}clear(){throw new Error('Global storage clear is forbidden');}
}
const baseline={id:'rig',revision:'1',sourceHash:binding.sourceHash,status:'pending',feedback:[],feedbackWarnings:[],updatedAt:null,reviewedSource:{rig:{sha256:'b'.repeat(64)}}};
const draft=():LocalInspectionDraft=>({schema:'rig-review-local-draft/1',sourceHash:binding.sourceHash,baseline:'c'.repeat(64),savedAt:'2026-10-18T08:00:00.000Z',reviewDirty:true,bookmark:bookmark(),inputs:{'feedback-summary':{value:'Keep this unadded text'},'feedback-start':{value:'12'},'feedback-end':{value:'18'},'review-status':{value:'approved'},'radio:outcome:fail':{value:'fail',checked:true}},session:{...baseline,status:'approved'},ui:{reportPage:2}});
test('public numeric view link roundtrips Unicode selection and exact source identity without feedback or capabilities',()=>{const link=encodeBookmark(bookmark()),value=decodeBookmark(link,binding)!;expect(value).toEqual(bookmark());expect(JSON.stringify(value)).not.toContain('feedback-summary');expect(decodeBookmark('',binding)).toBe(null);expect(()=>decodeBookmark(link,{...binding,sourceHash:'d'.repeat(64)})).toThrow('VIEW_SOURCE_CHANGED');expect(()=>decodeBookmark(link,{...binding,rigs:['e'.repeat(64)]})).toThrow('VIEW_SOURCE_CHANGED');});
test('view parser refuses unknown fields, malformed/nonfinite geometry, invalid versions and excessive fragments',()=>{expect(()=>parseBookmark({...bookmark(),token:'secret'})).toThrow('unknown field');expect(()=>parseBookmark({...bookmark(),time:Infinity})).toThrow('finite');expect(()=>parseBookmark({...bookmark(),schema:'other'})).toThrow('version');expect(()=>parseBookmark({...bookmark(),view:{...bookmark().view,cameras:{...bookmark().view.cameras,rig:{...camera,visible:{x:0,y:0,width:0,height:2}}}}})).toThrow();expect(()=>decodeBookmark('#review='+'a'.repeat(17000),binding)).toThrow('16 KiB');expect(()=>decodeBookmark('#review=??',binding)).toThrow('encoding');});
test('source-bound camera modes and divergent A/B regions roundtrip while legacy bookmarks stay parseable',()=>{
 const original=bookmark();expect(parseBookmark(original).view.cameraSync).toBeUndefined();
 const linked={...original,view:{...original.view,cameraSync:true,activeCamera:'reference' as const}};expect(decodeBookmark(encodeBookmark(linked),binding)?.view).toEqual(linked.view);
 const compareBinding:InspectionBinding={...binding,mode:'compare',rigs:['b'.repeat(64),'c'.repeat(64)]};
 const compare:InspectionBookmark={...original,binding:compareBinding,view:{schema:'rig-review-view/1',cameraSync:false,activeCamera:'b',cameras:{rig:null,a:camera,b:numericCamera('world',{x:-40,y:180},3,4,400,700),reference:null}}};
 expect(decodeBookmark(encodeBookmark(compare),compareBinding)?.view).toEqual(compare.view);
 expect(()=>parseBookmark({...original,view:{...original.view,activeCamera:'a'}})).toThrow('review mode');expect(()=>parseBookmark({...compare,view:{...compare.view,activeCamera:'rig'}})).toThrow('review mode');
});
test('feedback camera context is typed inert JSON with complete independent views and no shared references',()=>{
 const view:import('../src/control.ts').ControlView={schema:'rig-review-view/1',cameraSync:false,activeCamera:'b',cameras:{rig:null,a:camera,b:numericCamera('world',{x:-40,y:180},3,4,400,700),reference:numericCamera('image',{x:960,y:540},1,1,300,800)}};
 const stored:Json={...serializableView(view),theme:'light',layers:{images:true,mesh:true,bones:false,meshOpacity:.65}};
 expect(JSON.parse(JSON.stringify(stored))).toEqual({...view,theme:'light',layers:{images:true,mesh:true,bones:false,meshOpacity:.65}});
 view.cameras.a!.center.x=500;expect(JSON.parse(JSON.stringify(stored)).cameras.a.center.x).toBe(10);view.cameras.a!.center.x=10;
 const legacy=serializableView(bookmark().view);expect(Object.hasOwn(legacy,'cameraSync')).toBe(false);expect(Object.hasOwn(legacy,'activeCamera')).toBe(false);
});
test('numeric region restores source coverage in a changed aspect rather than replaying pixel pan',()=>{expect(camera.center).toEqual({x:10,y:20});expect(camera.visible).toEqual({x:-190,y:-130,width:400,height:300});const zoom=restoredZoom(camera,1,400,900);expect(zoom).toBe(1);const changed=numericCamera('world',camera.center,zoom,1,400,900)!;expect(changed.center).toEqual(camera.center);expect(changed.visible.width).toBe(400);expect(changed.visible.height).toBe(900);expect(()=>restoredZoom(camera,100,400,900)).toThrow('VIEW_CAMERA_RANGE');expect(numericCamera('image',{x:0,y:0},1,1,0,10)).toBe(null);});
test('same-pane bookmark preserves exact saved numeric zoom without a reciprocal roundtrip',()=>{
 const base=Math.min((755-24)/1024,(522-56)/1536),zoom=.9999999999999999,c=numericCamera('image',{x:512,y:768},zoom,base*zoom,755,522)!;
 expect(restoredZoom(c,base,755,522)).toBe(zoom);
 expect(numericCamera('image',c.center,restoredZoom(c,base,755,522),base*zoom,755,522)).toEqual(c);
});
test('all unsent form text/status/radio and feedback session remain local; exact baseline fingerprint detects a newer submission',async()=>{const storage=new MemoryStorage(),warnings:string[]=[],store=new InspectionDraftStore('single:rig',binding,s=>warnings.push(s),storage),value=draft();expect(store.write(value)).toBe(true);expect(store.read()).toEqual(value);expect(recoverSession(value.session,baseline)?.status).toBe('approved');expect(baseline.status).toBe('pending');expect(recoverSession({...value.session as object,sourceHash:'f'.repeat(64)},baseline)).toBe(null);const before=await sessionFingerprint(baseline),after=await sessionFingerprint({...baseline,updatedAt:'2026-10-18T09:00:00Z'});expect(before).not.toBe(after);expect(warnings).toEqual([]);});
test('opening another source of the same scope deletes nothing, preserving unrelated local data',()=>{const storage=new MemoryStorage(),first=new InspectionDraftStore('single:rig',binding,()=>{},storage);first.write(draft());storage.setItem('unrelated','keep');const other=new InspectionDraftStore('single:other',binding,()=>{},storage);other.write(draft());const changed=new InspectionDraftStore('single:rig',{...binding,sourceHash:'d'.repeat(64)},()=>{},storage);expect(changed.read()).toBe(null);expect(storage.getItem(first.key)).not.toBe(null);expect(storage.getItem(other.key)).not.toBe(null);expect(storage.getItem('unrelated')).toBe('keep');});
test('corrupt local storage stays downloadable and cannot be silently overwritten; storage denial is visible',()=>{const storage=new MemoryStorage(),warnings:string[]=[],store=new InspectionDraftStore('single:rig',binding,s=>warnings.push(s),storage);storage.setItem(store.key,'{broken');expect(store.read()).toBe(null);expect(store.recovery()).toBe('{broken');expect(store.write(draft())).toBe(false);expect(storage.getItem(store.key)).toBe('{broken');expect(warnings[0]).toContain('remains in storage');store.clear();expect(store.write(draft())).toBe(true);const denied:Storage={length:0,getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');},key(){throw new Error('denied');},clear(){throw new Error('Global clear is forbidden');}};new InspectionDraftStore('denied',binding,s=>warnings.push(s),denied);expect(warnings.at(-1)).toContain('unavailable');});

test('actual fixed-instance landing gate accepts copied view links while arbitrary query capabilities are excluded',()=>{
 const identity={contentHash:'a'.repeat(64),key:'b'.repeat(64),nonce:'private capability',fingerprint:'c'.repeat(64)};
 const current=`http://127.0.0.1:1234/?input=${identity.contentHash}&handoff=${identity.key}&token=secret&checkpoint=old`;
 const copied=inspectionLink(current,bookmark());expect(openGate(new Request(copied),identity)).toBe(null);expect(copied.searchParams.size).toBe(2);expect(copied.href).not.toContain('secret');expect(copied.searchParams.has('checkpoint')).toBe(false);expect(decodeBookmark(copied.hash,binding)).toEqual(bookmark());
 expect(openGate(new Request('http://127.0.0.1:1234/'+copied.hash),identity)?.status).toBe(409);
 expect(()=>inspectionLink(current+'&input=bad',bookmark())).toThrow('binding');expect(()=>inspectionLink('http://localhost/?input=secret',bookmark())).toThrow('binding');
});

test('actual single restore adapter rejects unavailable selections before mutation and rolls back a runtime seek failure',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const slice=(from:string,to:string)=>{const a=source.indexOf(from),b=source.indexOf(to,a);if(a<0||b<a)throw new Error('inspection adapter boundary missing');return source.slice(a,b);};
 const functions=slice('async function restoreInspection(','/** Read the SELECTED reference')+slice('function inspectionTimeLimit(','async function waitReferenceMetadata(')+singleRestoreWiring;
 const script=`function open(deps){const {createViewportController,createViewportState,createRigViewportProvider,initial,restoreTransaction,restoredZoom,hasSets,crossLayout,syncStageLayout,parts}=deps;const requestAnimationFrame=fn=>{queueMicrotask(()=>fn(0));return 1;};let turnPad=null;let cameraSync=false,activeCamera='rig',cameraRestoring=false,cameraLayout='',view='compare',referenceGeneration=0;let actual=structuredClone(initial),cameraCenter={...initial.view.cameras.rig.center},zoom=2,rigScale=2,referenceScale=1,referenceZoom=1,referenceCenter=null,referenceSize={width:crossLayout?800:100,height:crossLayout?2284:100},video=null,checkpoint=undefined,selectedPerson=initial.selection.person,lastPoseFrame=-1,part='',fails=false,applied=0;const setCalls=[];const controls=new Map();function el(id){if(!controls.has(id))controls.set(id,{value:id==='reference-select'?'original':'',checked:false,style:{},dataset:{orientation:'horizontal'},get clientWidth(){return id==='stage-layout'?crossLayout?628:800:crossLayout?el('stage-layout').dataset.orientation==='vertical'?612:302:800;},get clientHeight(){return id==='stage-layout'?crossLayout?789:600:crossLayout?el('stage-layout').dataset.orientation==='vertical'?382:773:600;}});return controls.get(id);}const input=el,select=el;const data={manifest:{references:[{id:'original',type:'pose'},{id:'large',type:'image'}],checkpoints:[],axes:[]}},assets={stage:{x:0,y:0,width:crossLayout?800:772,height:crossLayout?2284:542},animations:[{name:'idle',duration:2},{name:'other',duration:2}]},player={renderer:{syncPixelRatio(){}},sets:()=>hasSets?[{name:'alternate'}]:[],setSet:value=>{if(!hasSets)throw new Error('cannot setSet: model has no sets.json');setCalls.push(value);part=value??'';}};function inspectionBookmark(){return {...structuredClone(actual),view:{...actual.view,cameras:{...actual.view.cameras,rig:{...actual.view.cameras.rig,center:{...cameraCenter},zoom}}},selection:{...actual.selection,reference:select('reference-select').value,person:selectedPerson,partSet:part,part:parts?.value()??null}};}const captureInputs=()=>Object.fromEntries([...controls].map(([id,v])=>[id,{value:v.value,checked:v.checked}])),restoreInputs=values=>{for(const [id,v]of Object.entries(values))Object.assign(el(id),v);};const text=()=>{},renderNumericView=()=>{},renderCameraControls=()=>{},paneFrame=()=>true,alignCameras=()=>{};const pause=()=>{},renderFeedbackRange=()=>{},renderCheckpoint=()=>{},renderCheckpoints=()=>{},renderSequenceFrame=()=>{},renderTransport=()=>{},redrawOverlay=()=>{},showInspector=()=>{},chooseAxis=()=>{},applyAxis=()=>{};function chooseAnimation(name){actual.animation=name;}function setWorkspace(value){actual.selection.workspace=value;}function setView(value){actual.selection.view=value;}const appearance={set:value=>{actual.theme=value;}},layers={images:true,mesh:false,bones:false};async function inspectionReferenceInfo(id){return id==='large'?{width:10000,height:10000,duration:null,people:[]}:{width:crossLayout?800:100,height:crossLayout?2284:100,duration:2,people:['사람']};}async function showReference(id){actual.selection.reference=id;referenceSize=id==='large'?{width:10000,height:10000}:{width:crossLayout?800:100,height:crossLayout?2284:100};}const drawRig=action=>action();player.draw=()=>{};async function inspectControlTime(value){applied++;actual.time=value;if(fails&&value===1){fails=false;throw new Error('decoder refused');}}${functions};return {restore:value=>restoreInspection(value,new AbortController().signal),fail:()=>{fails=true;},state:()=>({bookmark:inspectionBookmark(),part,preset:select('part-set').value,applied,setCalls:[...setCalls],scale:rigScale,referenceZoom,referenceScale,orientation:el('stage-layout').dataset.orientation}),preset:()=>select('part-set').value};}`;
 const compiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type App={restore(value:InspectionBookmark):Promise<void>;fail():void;state():{bookmark:InspectionBookmark;part:string;preset:string;applied:number;setCalls:(string|null)[];scale:number;referenceZoom:number;referenceScale:number;orientation:string}};
 const initial=bookmark();initial.selection.partSet='';
 const open=(hasSets=true,crossLayout=false)=>{const parts=new PartInspection();parts.register('single',[{slot:'actual-slot',bone:'root',setup:null,declarations:[]}],{generation:0,skin:undefined,set:null,slotIdentity:()=>({generation:0,set:null,sets:[],skin:null,slots:[{slot:'actual-slot',z:0,attachment:null,skin:null,reason:'no-attachment'}]}),posedFrame:()=>({generation:0,order:[]}),renderer:{render(){}}});parts.present('single');return new Function('deps',compiled+';return open(deps);')({createViewportController,createViewportState,createRigViewportProvider,initial,restoreTransaction,restoredZoom,hasSets,crossLayout,syncStageLayout,parts}) as App;};
 for(const changes of [{person:'missing'},{partSet:'missing'}]){const app=open(),before=app.state();await expect(app.restore({...initial,animation:'other',time:1,selection:{...initial.selection,...changes}})).rejects.toThrow('absent');expect(app.state()).toEqual(before);}
 const badPart=open(),beforePart=badPart.state();await expect(badPart.restore({...initial,selection:{...initial.selection,part:{side:'single',slot:'unknown',mode:'solo'}}})).rejects.toThrow('PART_UNAVAILABLE');expect(badPart.state()).toEqual(beforePart);
 const selectedPart=open();await selectedPart.restore({...initial,selection:{...initial.selection,part:{side:'single',slot:'actual-slot',mode:'solo'}}});expect(selectedPart.state().bookmark.selection.part).toMatchObject({side:'single',slot:'actual-slot',mode:'solo',identity:{attachment:null,skin:null,reason:'no-attachment'}});selectedPart.fail();await expect(selectedPart.restore({...initial,time:1,selection:{...initial.selection,part:null}})).rejects.toThrow('decoder refused');expect(selectedPart.state().bookmark.selection.part?.slot).toBe('actual-slot');
 const mismatched=open(),beforeMismatch=mismatched.state();await expect(mismatched.restore({...initial,time:1,selection:{...initial.selection,part:{side:'single',slot:'actual-slot',mode:'solo',identity:{attachment:'old-key',skin:'old-skin',reason:null,set:null,activeSkin:null}}}})).rejects.toThrow('PART_IDENTITY_MISMATCH');expect(mismatched.state().bookmark).toEqual(beforeMismatch.bookmark);
 const outside=open(),beforeTime=outside.state();await expect(outside.restore({...initial,time:3})).rejects.toThrow('outside');expect(outside.state()).toEqual(beforeTime);
 const cameraApp=open(),beforeCamera=cameraApp.state(),referenceCamera=numericCamera('image',{x:50,y:50},1,8,800,600)!;
 await expect(cameraApp.restore({...initial,animation:'other',time:1,selection:{...initial.selection,reference:'large',person:null},view:{...initial.view,cameras:{...initial.view.cameras,reference:referenceCamera}}})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(cameraApp.state().bookmark).toEqual(beforeCamera.bookmark);expect(cameraApp.state()).toMatchObject({part:beforeCamera.part,preset:beforeCamera.preset});
 const runtime=open(),before=runtime.state().bookmark;runtime.fail();await expect(runtime.restore({...initial,animation:'other',time:1})).rejects.toThrow('decoder refused');expect(runtime.state().bookmark).toEqual(before);
 const positive=open();await positive.restore({...initial,animation:'other',time:1,selection:{...initial.selection,partSet:'alternate'}});expect(positive.state()).toMatchObject({part:'alternate',preset:'alternate',bookmark:{animation:'other',time:1}});
 const noSets=open(false);await noSets.restore({...initial,selection:{...initial.selection,partSet:null}});expect(noSets.state()).toMatchObject({part:'',preset:'',setCalls:[]});await expect(noSets.restore({...initial,selection:{...initial.selection,partSet:'alternate'}})).rejects.toThrow('Saved part preset is absent');expect(noSets.state().setCalls).toEqual([]);
 await positive.restore({...initial,selection:{...initial.selection,partSet:null}});expect(positive.state()).toMatchObject({part:'',preset:'',setCalls:['alternate',null]});
 const cross=open(false,true),region={...initial,selection:{...initial.selection,partSet:null},view:{...initial.view,cameras:{...initial.view.cameras,rig:numericCamera('world',{x:0,y:1142},1,702/4786.173134328358,702,393),reference:numericCamera('image',{x:400,y:1142},1,702/4757.768545994066,702,393)}}};
 expect(()=>restoredZoom(region.view.cameras.rig!,Math.min((302-28)/800,(773-58)/2284),302,773)).toThrow('VIEW_CAMERA_RANGE');await cross.restore(region);expect(cross.state().orientation).toBe('vertical');expect(cross.state().bookmark.view.cameras.rig?.zoom).toBeCloseTo(.9013928458372903,12);expect(cross.state().bookmark.view.cameras.rig?.center).toEqual({x:0,y:1142});const visible=numericCamera('world',{x:0,y:1142},cross.state().bookmark.view.cameras.rig!.zoom,cross.state().scale,612,382)!;expect(visible.visible.width).toBeCloseTo(region.view.cameras.rig!.visible.width,8);expect(visible.visible.height).toBeGreaterThanOrEqual(region.view.cameras.rig!.visible.height);expect(cross.state().referenceZoom).toBeCloseTo(.9012112631744532,12);const referenceVisible=numericCamera('image',{x:400,y:1142},cross.state().referenceZoom,cross.state().referenceScale,612,382)!;expect(referenceVisible.visible.width).toBeCloseTo(region.view.cameras.reference!.visible.width,8);expect(referenceVisible.visible.height).toBeGreaterThanOrEqual(region.view.cameras.reference!.visible.height);
});

async function openFormCoordinator(saved:LocalInspectionDraft,explicit:InspectionBookmark|null){
 const source=await readFile(new URL('../web/inspection-persistence.ts',import.meta.url),'utf8'),compare=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const controls=(await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8')).split('export type ThemePreference')[0]!.replaceAll('export const','const');
 const inputs=source.slice(source.indexOf('export function captureInputs('),source.indexOf('function parseInputs(')).replaceAll('export function','function');
 const connect=source.slice(source.indexOf('export async function connectInspectionPersistence')).replace('export async function','async function');
 const ids=source.slice(source.indexOf('const viewInputIds='),source.indexOf('/** Restore once'));
 const begin=compare.indexOf('afterInputs:()=>{'),end=compare.indexOf(',onConflict:',begin);if(begin<0||end<begin)throw new Error('compare restored-input action missing');
 const action=compare.slice(begin+'afterInputs:'.length,end);
 const script=`async function open(deps){const {InspectionDraftStore:Base,storage,saved,explicit,baseline,binding,bookmark,sessionFingerprint,recoverSession,decodeBookmark,encodeBookmark,parseBookmark,inspectionLink,restoreTransaction}=deps;
 class HTMLInputElement{hasAttribute(name){return name==='data-app-preference'&&this.id.startsWith('settings-');}constructor(id,type,value,checked=false){Object.assign(this,{id,type,value,checked,name:''});}}class HTMLSelectElement{hasAttribute(name){return name==='data-app-preference'&&this.id.startsWith('settings-');}constructor(id,value,values){this.id=id;this.value=value;this.options=values.map(value=>({value}));}}class HTMLTextAreaElement{}
 const nodes=[new HTMLInputElement('settings-sync','checkbox','on',false),new HTMLInputElement('camera-sync','checkbox','on',false),new HTMLInputElement('reference-audio','checkbox','on',false),new HTMLSelectElement('part-set','','alternate old'.split(' ')),new HTMLInputElement('target-name','text','server target'),new HTMLSelectElement('status','pending',['pending','approved'])],video={muted:true},CSS={escape:value=>value};
 const notice={children:[],replaceChildren(){this.children=[];},append(button){this.children.push(button);}},document={hidden:false,body:{inert:false},getElementById:id=>id==='draft-recovery'?notice:null,querySelectorAll:()=>nodes,querySelector:selector=>nodes.find(n=>'#'+n.id===selector),createElement:()=>({type:'',textContent:'',onclick:null,append(){}})};
 const window=new EventTarget(),location={href:'http://127.0.0.1:1234/',hash:explicit?encodeBookmark(explicit):''},history={replaceState(_state,_unused,value){const url=new URL(value);location.href=url.href;location.hash=url.hash;}},navigator={clipboard:{writeText:async()=>{}}};
 const InspectionDraftStore=class extends Base{constructor(scope,binding,warn){super(scope,binding,warn,storage);}};
 new InspectionDraftStore('single:rig',binding,()=>{}).write(saved);
 let current=structuredClone(baseline),dirty=false,conflict=false,restores=0,preset='',displayedTime=null;const held=new Map(),calls=[];const messages=[],input=id=>nodes.find(n=>n.id===id),renderFeedbackSelection=()=>{};
 const afterInputs=${action};
 ${controls}\n${ids}\n${inputs}\n${connect}
 const connection=await connectInspectionPersistence({scope:'single:rig',binding,baseline,session:()=>current,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{current=value;dirty=isDirty;restores++;},bookmark:()=>{const value=explicit??bookmark;return {...value,time:displayedTime??value.time,selection:{...value.selection,partSet:preset}};},restoreBookmark:async(value,signal)=>{await restoreTransaction(async()=>{},()=>({preset,displayedTime}),async()=>{calls.push(value.time);preset=value.selection.partSet??'';input('part-set').value=preset;input('camera-sync').checked=value.view.cameraSync??false;const gate=held.get(value.time);if(gate)await gate.promise;if(signal.aborted)throw new Error('RESTORE_SUPERSEDED');displayedTime=value.time;},async previous=>{preset=previous.preset;displayedTime=previous.displayedTime;input('part-set').value=preset;});},ui:()=>({}),restoreUI:()=>{},afterInputs,onConflict:value=>{conflict=value;},onStatus:value=>messages.push(value)});
 return {connection,savedFields:()=>Object.keys(JSON.parse(storage.getItem('rig-review-draft/1:single:rig:'+binding.sourceHash)).inputs),url:()=>location.href,state:()=>({current,dirty,conflict,restores,preset,presetWidget:input('part-set').value,settingsSync:input('settings-sync').checked,syncWidget:input('camera-sync').checked,muted:video.muted,audioChecked:input('reference-audio').checked,displayedTime,inert:document.body.inert,calls:[...calls],target:input('target-name').value}),hold:time=>{let release;const promise=new Promise(resolve=>release=resolve);held.set(time,{promise,release});},release:time=>held.get(time).release(),navigate:(value,event='hashchange')=>{location.hash=typeof value==='string'?value:encodeBookmark(value);location.href='http://127.0.0.1:1234/'+location.hash;window.dispatchEvent(new Event(event));},buttons:()=>notice.children.map(b=>b.textContent),click:label=>{const b=notice.children.find(b=>b.textContent===label);if(!b)throw new Error('missing recovery action');b.onclick();},messages};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script),storage=new MemoryStorage();
 return await new Function('deps',code+';return open(deps);')({InspectionDraftStore,storage,saved,explicit,baseline,binding,bookmark:bookmark(),sessionFingerprint,recoverSession,decodeBookmark,encodeBookmark,parseBookmark,inspectionLink,restoreTransaction}) as {connection:{dispose():void;save():void;restoring():boolean};savedFields():string[];url():string;navigate(value:InspectionBookmark|string,event?:string):void;hold(time:number):void;release(time:number):void;state():{current:typeof baseline;dirty:boolean;conflict:boolean;restores:number;preset:string;presetWidget:string;settingsSync:boolean;syncWidget:boolean;muted:boolean;audioChecked:boolean;displayedTime:number|null;inert:boolean;calls:number[];target:string};buttons():string[];click(label:string):void;messages:string[]};
}

test('valid draft with incompatible session offers scoped discard, retains server baseline and unblocks submission',async()=>{
 const saved=draft();saved.session={...baseline,id:'different',status:'approved'};
 const explicit=bookmark();explicit.selection.partSet='alternate';const app=await openFormCoordinator(saved,explicit);
 try{expect(app.state()).toMatchObject({conflict:true,restores:0,current:baseline,preset:'alternate',presetWidget:'alternate'});expect(app.buttons()).toContain('Download saved local draft');expect(app.buttons()).toContain('Discard conflicting local draft');expect(app.buttons()).not.toContain('Recover local draft as pending');app.click('Discard conflicting local draft');expect(app.state()).toMatchObject({conflict:false,dirty:false,current:baseline,preset:'alternate',presetWidget:'alternate'});expect(app.messages.at(-1)).toContain('submitted review retained');}finally{app.connection.dispose();}
});

test('restored audio checkbox applies actual media mute while explicit URL preset owns both actual selection and widget',async()=>{
 const saved=draft();saved.baseline=await sessionFingerprint(baseline);saved.reviewDirty=false;saved.session=baseline;saved.inputs={'reference-audio':{value:'on',checked:true},'part-set':{value:'old'},'camera-sync':{value:'on',checked:false}};
 const explicit=bookmark();explicit.view.cameraSync=true;explicit.selection.partSet='alternate';const app=await openFormCoordinator(saved,explicit);
 try{expect(app.state()).toMatchObject({syncWidget:true,audioChecked:true,muted:false,preset:'alternate',presetWidget:'alternate',restores:0});}finally{app.connection.dispose();}
});

test('same-document hash/popstate restores preserve local decisions, suspend autosave and settle only the latest transactional view',async()=>{
 const saved=draft();saved.baseline=await sessionFingerprint(baseline);saved.inputs={'target-name':{value:'unadded feedback target'},status:{value:'approved'}};
 const app=await openFormCoordinator(saved,null),flush=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
 const first=bookmark();first.time=.75;first.selection.partSet='alternate';const last=bookmark();last.time=1;last.selection.partSet='old';
 try{
  expect(app.state()).toMatchObject({current:{status:'approved'},dirty:true,restores:1,target:'unadded feedback target'});
  app.hold(.75);app.navigate(first);await flush();expect(app.connection.restoring()).toBe(true);expect(app.state().inert).toBe(true);const requested=app.url();app.connection.save();expect(app.url()).toBe(requested);
  app.navigate(last,'popstate');await flush();expect(app.state().calls).toEqual([.5,.75]);app.release(.75);await flush();await flush();
  expect(app.connection.restoring()).toBe(false);expect(app.state()).toMatchObject({displayedTime:1,preset:'old',presetWidget:'old',inert:false,current:{status:'approved'},dirty:true,restores:1,target:'unadded feedback target'});expect(app.state().calls).toEqual([.5,.75,1]);expect(decodeBookmark(new URL(app.url()).hash,binding)?.time).toBe(1);
  app.navigate(last);await flush();expect(app.state().calls).toEqual([.5,.75,1]);
  const before=app.state();app.navigate({...first,binding:{...binding,sourceHash:'d'.repeat(64)}});await flush();expect(app.state()).toEqual(before);expect(app.messages.at(-1)).toContain('VIEW_SOURCE_CHANGED');
  app.navigate('#review=??');await flush();expect(app.state()).toEqual(before);expect(app.messages.at(-1)).toContain('encoding');
  app.connection.dispose();app.navigate(first);await flush();expect(app.state()).toEqual(before);
 }finally{app.connection.dispose();}
});

test('invalid navigation cancels an unfinished link transaction without applying a fallback draft or leaving controls locked',async()=>{
 const saved=draft();saved.baseline=await sessionFingerprint(baseline);saved.reviewDirty=false;saved.session=baseline;
 const app=await openFormCoordinator(saved,null),flush=()=>new Promise<void>(resolve=>setTimeout(resolve,0)),next=bookmark();next.time=.75;next.selection.partSet='alternate';
 try{const previous=app.state();app.hold(.75);app.navigate(next);await flush();expect(app.connection.restoring()).toBe(true);app.navigate('#review=invalid!');app.release(.75);await flush();await flush();expect(app.connection.restoring()).toBe(false);expect(app.state()).toMatchObject({displayedTime:previous.displayedTime,preset:previous.preset,presetWidget:previous.presetWidget,current:baseline,inert:false,restores:0});expect(app.state().calls).toEqual([.5,.75]);}finally{app.connection.dispose();}
});

test('part link selection is side-bound and closed; legacy links retain Whole rig',()=>{
 const selected=bookmark();selected.selection.part={side:'single',slot:'actual.slot',mode:'solo'};expect(decodeBookmark(encodeBookmark(selected),binding)?.selection.part).toEqual(selected.selection.part);
 expect(parseBookmark(bookmark()).selection.part).toBeUndefined();
 for(const part of [{side:'a',slot:'actual.slot',mode:'solo'},{side:'single',slot:'actual.slot',mode:'apply'},{side:'single',slot:'actual.slot',mode:'solo',path:'escape'}])expect(()=>parseBookmark({...selected,selection:{part}})).toThrow();
 const compare={...selected,binding:{mode:'compare',sourceHash:binding.sourceHash,rigs:[...binding.rigs,...binding.rigs]},selection:{part:{side:'b',slot:'actual.slot',mode:'context'}}};expect(parseBookmark(compare).selection.part?.side).toBe('b');expect(()=>parseBookmark({...compare,selection:{part:selected.selection.part}})).toThrow('side unavailable');
});


test('source-bound links retain exact owning identity and null reasons without persisting generation',()=>{
 const value=bookmark();value.selection.part={side:'single',slot:'s',mode:'solo',identity:{attachment:'linked-key',skin:'owning',reason:null,set:'wink',activeSkin:'active'}};expect(decodeBookmark(encodeBookmark(value),binding)?.selection.part).toEqual(value.selection.part);
 const hidden={...value,selection:{...value.selection,part:{...value.selection.part,identity:{attachment:null,skin:null,reason:'timeline-null' as const,set:null,activeSkin:null}}}};expect(decodeBookmark(encodeBookmark(hidden),binding)?.selection.part?.identity?.reason).toBe('timeline-null');
 expect(()=>parseBookmark({...value,selection:{part:{...value.selection.part,identity:{...value.selection.part!.identity,generation:11}}}})).toThrow('unknown field');
});

test('browser Settings are neither saved into nor restored from a source draft',async()=>{
 const saved=draft();saved.baseline=await sessionFingerprint(baseline);saved.session=baseline;saved.reviewDirty=false;saved.inputs['settings-sync']={value:'on',checked:true};
 const app=await openFormCoordinator(saved,null);try{expect(app.state().settingsSync).toBe(false);app.connection.save();expect(app.savedFields()).not.toContain('settings-sync');expect(app.savedFields()).toContain('camera-sync');}finally{app.connection.dispose();}
});

test('two revisions of one manifest id keep both drafts on one origin',()=>{
 const storage=new MemoryStorage(),revised:InspectionBinding={...binding,sourceHash:'d'.repeat(64)};
 const first=new InspectionDraftStore('single:rig:'+binding.sourceHash,binding,()=>{},storage),second=new InspectionDraftStore('single:rig:'+revised.sourceHash,revised,()=>{},storage);
 const one=draft(),two={...draft(),sourceHash:revised.sourceHash,bookmark:{...bookmark(),binding:revised},inputs:{'feedback-summary':{value:'Second revision note'}}};
 expect(first.write(one)).toBe(true);expect(second.write(two)).toBe(true);expect(first.key).not.toBe(second.key);
 expect(new InspectionDraftStore('single:rig:'+binding.sourceHash,binding,()=>{},storage).read()?.inputs).toEqual(one.inputs);
 expect(new InspectionDraftStore('single:rig:'+revised.sourceHash,revised,()=>{},storage).read()?.inputs).toEqual(two.inputs);
});
test('least-recently-written drafts beyond 32 are evicted, but never one written in the last 24 hours',()=>{
 const storage=new MemoryStorage(),day=24*60*60*1000,start=Date.parse('2026-10-01T00:00:00Z');let clock=start;const store=(n:number)=>new InspectionDraftStore('single:rig'+n,binding,()=>{},storage,()=>clock);
 for(let n=0;n<30;n++){clock=start+n*1000;store(n).write(draft());}
 clock=start+3*day;for(let n=30;n<40;n++){clock+=1000;store(n).write(draft());}
 const kept=(s:MemoryStorage)=>[...s.values.keys()].filter(k=>k.startsWith('rig-review-draft/1:'));
 expect(kept(storage)).toHaveLength(32);for(let n=0;n<8;n++)expect(storage.getItem(store(n).key)).toBeNull();for(let n=8;n<40;n++)expect(storage.getItem(store(n).key)).not.toBeNull();
 // All 40 written within 24 h: none is evicted, even beyond the limit.
 const fresh=new MemoryStorage();clock=start;for(let n=0;n<40;n++){clock+=60000;new InspectionDraftStore('single:recent'+n,binding,()=>{},fresh,()=>clock).write(draft());}expect(kept(fresh)).toHaveLength(40);
 // Rewriting an old scope makes it recent, so the next eviction takes the following oldest instead.
 clock+=3*day;store(8).write(draft());clock+=1000;store(40).write(draft());expect(storage.getItem(store(8).key)).not.toBeNull();expect(storage.getItem(store(9).key)).toBeNull();expect(kept(storage)).toHaveLength(32);
});

test('the active Inspector block per section roundtrips through the stored local draft and nothing else is added',async()=>{
 const {activeBlocksUI,restoreActiveBlocksUI}=await import('../web/inspector-blocks.ts');
 const storage=new MemoryStorage(),store=new InspectionDraftStore('single:rig',binding,()=>{},storage),value=draft();
 value.ui={...value.ui,...activeBlocksUI({rig:'chest-regions',playback:'physics-panel'})};expect(store.write(value)).toBe(true);
 const read=store.read()!;expect(restoreActiveBlocksUI(read.ui)).toEqual({rig:'chest-regions',playback:'physics-panel'});
 expect(Object.keys(read.ui).filter(key=>!Object.hasOwn(draft().ui,key))).toEqual(['inspectorBlocks']);expect(read.bookmark).toEqual(draft().bookmark);
});

const singleSession=(viewer='0.2.0',runtime='0.3.0')=>({
 id:'rig',revision:'1',sourceHash:binding.sourceHash,status:'pending',
 checkpoints:{idle:{outcome:'pending',note:''}},feedback:[] as unknown[],feedbackWarnings:[] as unknown[],updatedAt:null as string|null,
 reviewedSource:{packageRevision:'1',rig:{path:'rig.json',sha256:'b'.repeat(64)},motion:{path:'motion.json',sha256:'e'.repeat(64)},viewerVersion:viewer,runtimeVersion:runtime},
 referenceBinding:null,
});
async function compareSession(viewer='0.2.0',runtime='0.3.0'){
 const side=(id:string,rig:string)=>({id,revision:'1',sourceHash:rig,reviewedSource:{packageRevision:'1',rig:{path:'rig.json',sha256:rig},motion:{path:'motion.json',sha256:'e'.repeat(64)},viewerVersion:viewer,runtimeVersion:runtime}});
 const compareBinding={schema:'rig-review-compare/1' as const,a:side('rig-a','b'.repeat(64)),b:side('rig-b','c'.repeat(64)),reference:{path:'ref.mp4',name:'ref.mp4',sha256:'f'.repeat(64)},animation:'idle'};
 const sourceHash=await sessionFingerprint(compareBinding);
 return {id:`compare-${sourceHash.slice(0,16)}`,revision:'1:1',sourceHash,binding:compareBinding,status:'pending',feedback:[] as unknown[],feedbackWarnings:[] as unknown[],updatedAt:null as string|null};
}
const feedbackItem=(summary='Left sleeve clips at peak')=>({id:'f-1',frameStart:2,frameEnd:6,target:{kind:'slot',name:'sleeve_l'},category:'defect',summary,context:{animation:'idle'}});

async function openDraftReopenScenario(opts:{
 mode:'single'|'compare';
 saved:LocalInspectionDraft;
 savedBinding?:InspectionBinding;
 currentBaseline:Record<string,unknown>;
 currentBinding:InspectionBinding;
 legacyMain?:boolean;
}){
 const source=await readFile(new URL('../web/inspection-persistence.ts',import.meta.url),'utf8');
 const controls=(await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8')).split('export type ThemePreference')[0]!.replaceAll('export const','const');
 const inputs=source.slice(source.indexOf('export function captureInputs('),source.indexOf('function parseInputs(')).replaceAll('export function','function');
 let connect=source.slice(source.indexOf('export async function connectInspectionPersistence')).replace('export async function','async function');
 const ids=source.slice(source.indexOf('const viewInputIds='),source.indexOf('/** Restore once'));
 if(opts.legacyMain){
  connect=connect
   .replace("let draft=store.read(session=>recoverSession(session,adapter.baseline)!==null);","const draft=store.read();")
   .replace("const notices=[document.getElementById('draft-recovery'),document.getElementById('review-draft-recovery')].filter((node):node is HTMLElement=>node!==null);","const notices=[document.getElementById('draft-recovery')].filter((node):node is HTMLElement=>node!==null);")
   .replace("const prior=recovered?recoverSession(adapter.baseline,draft.session as T):null;\n  sameBaseline=draft.baseline===baseline||(prior!==null&&draft.baseline===await sessionFingerprint(prior));\n  if(!draft.reviewDirty&&(!sameBaseline||!recovered||draft.baseline!==baseline)){store.clear();draft=null;recovered=null;}","sameBaseline=draft.baseline===baseline;")
   .replace("status(recovered?'Saved local draft conflicts with the current submitted review. Server status is unchanged; download it or explicitly recover as pending.':'Saved local draft conflicts with the current submitted review. Server status is unchanged; download or discard it.');","status('Saved local draft conflicts with the current submitted review. Server status is unchanged; download it or explicitly recover as pending.');");
 }
 const legacyRecover=(value:unknown,base:typeof baseline):typeof baseline|null=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;const o=value as Record<string,unknown>;for(const key of Object.keys(o))if(!Object.keys(base).includes(key))return null;
  for(const k of ['id','revision','sourceHash','reviewedSource','referenceBinding','binding'])if(JSON.stringify(o[k])!==JSON.stringify((base as Record<string,unknown>)[k]))return null;
  return recoverSession(value,base);
 };
 const scope=opts.mode==='single'?`single:rig:${opts.currentBinding.sourceHash}`:`compare:rig-a:${'b'.repeat(64)}:rig-b:${'c'.repeat(64)}`;
 const storage=new MemoryStorage();
 new InspectionDraftStore(scope,opts.savedBinding??opts.currentBinding,()=>{},storage).write(opts.saved);
 const script=`async function open(deps){const {InspectionDraftStore:Base,storage,scope,currentBaseline,currentBinding,bookmark,sessionFingerprint,recoverSession,decodeBookmark,encodeBookmark,parseBookmark,inspectionLink,restoreTransaction,mode}=deps;
 class HTMLInputElement{hasAttribute(name){return name==='data-app-preference'&&this.id.startsWith('settings-');}constructor(id,type,value,checked=false){Object.assign(this,{id,type,value,checked,name:''});}}class HTMLSelectElement{hasAttribute(name){return name==='data-app-preference'&&this.id.startsWith('settings-');}constructor(id,value,values){this.id=id;this.value=value;this.options=values.map(value=>({value}));}}class HTMLTextAreaElement{hasAttribute(){return false;}constructor(id,value=''){this.id=id;this.value=value;}}
 const nodes=[new HTMLSelectElement('review-status',currentBaseline.status,['pending','approved','changes-requested']),new HTMLSelectElement('status',currentBaseline.status,['pending','approved','changes-requested']),new HTMLTextAreaElement('checkpoint-note',''),new HTMLInputElement('feedback-summary','text',''),new HTMLInputElement('summary','text','')];
 const statusNotice={children:[],replaceChildren(){this.children=[];},append(button){this.children.push(button);}};
 const dialogNotice={children:[],replaceChildren(){this.children=[];},append(button){this.children.push(button);}};
 const downloads=[];const blobs=new Map();
 const URL=class extends globalThis.URL{static createObjectURL(blob){const u='blob:draft-'+blobs.size;blobs.set(u,blob);return u;}static revokeObjectURL(){}};
 const document={hidden:false,body:{inert:false},getElementById:id=>id==='draft-recovery'?statusNotice:id==='review-draft-recovery'&&mode==='single'?dialogNotice:null,querySelectorAll:()=>nodes,querySelector:selector=>nodes.find(n=>'#'+n.id===selector),createElement:tag=>tag==='a'?{href:'',download:'',click(){downloads.push({download:this.download,blob:blobs.get(this.href)});}}:{type:'',textContent:'',onclick:null,append(){}}};
 const window=new EventTarget(),location={href:'http://127.0.0.1:1234/',hash:''},history={replaceState(_state,_unused,value){const url=new globalThis.URL(value);location.href=url.href;location.hash=url.hash;}},navigator={clipboard:{writeText:async()=>{}}},CSS={escape:v=>v};
 const InspectionDraftStore=class extends Base{constructor(s,b,warn){super(s,b,warn,storage);}};
 let current=structuredClone(currentBaseline),dirty=false,conflict=false,restores=0,statusText='',dialogStatusText='';const messages=[];
 const statusSelect=()=>nodes.find(n=>n.id===(mode==='single'?'review-status':'status'));
 ${controls}\n${ids}\n${inputs}\n${connect}
 const connection=await connectInspectionPersistence({scope,binding:currentBinding,baseline:currentBaseline,session:()=>current,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{current=value;dirty=isDirty;statusSelect().value=current.status;restores++;},bookmark:()=>({...bookmark,binding:currentBinding}),restoreBookmark:async()=>{},ui:()=>({}),restoreUI:()=>{},afterInputs:()=>{},onConflict:value=>{conflict=value;},onStatus:value=>{statusText=value;dialogStatusText=value;messages.push(value);}});
 return {
  connection,storage,
  state:()=>({current,dirty,conflict,restores,statusWidget:statusSelect().value,statusText,dialogStatusText,messages:[...messages],draftKeys:[...storage.values.keys()].filter(k=>k.startsWith('rig-review-draft/1:'))}),
  statusButtons:()=>statusNotice.children.map(b=>b.textContent),
  actionNodes:()=>({status:statusNotice.children,dialog:dialogNotice.children}),
  dialogButtons:()=>mode==='single'?dialogNotice.children.map(b=>b.textContent):statusNotice.children.map(b=>b.textContent),
  clickInDialog:label=>{const list=mode==='single'?dialogNotice.children:statusNotice.children,b=list.find(x=>x.textContent===label);if(!b)throw new Error('missing dialog recovery action: '+label);b.onclick();},
  downloads:async()=>Promise.all(downloads.map(async d=>({download:d.download,text:await d.blob.text()}))),
  submit:async()=>{if(conflict)throw new Error('Resolve the saved local draft conflict before submitting.');const saved={...structuredClone(current),updatedAt:'2026-11-02T00:00:00.000Z'};current=saved;dirty=false;await connection.submitted(saved);return saved;}
 };}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 return await new Function('deps',code+';return open(deps);')({
  InspectionDraftStore,storage,scope,currentBaseline:opts.currentBaseline,currentBinding:opts.currentBinding,bookmark:bookmark(),
  sessionFingerprint,recoverSession:opts.legacyMain?legacyRecover:recoverSession,decodeBookmark,encodeBookmark,parseBookmark,inspectionLink,restoreTransaction,mode:opts.mode,
 }) as {
  connection:{dispose():void;save():void};
  storage:MemoryStorage;
  state():{current:Record<string,any>;dirty:boolean;conflict:boolean;restores:number;statusWidget:string;statusText:string;dialogStatusText:string;messages:string[];draftKeys:string[]};
  actionNodes():{status:HTMLButtonElement[];dialog:HTMLButtonElement[]};
  statusButtons():string[];
  dialogButtons():string[];
  clickInDialog(label:string):void;
  downloads():Promise<{download:string;text:string}[]>;
  submit():Promise<Record<string,any>>;
 };
}

test('#301 Bar 1: reopen after a version change with a clean draft drops it quietly, shows no banner, restores no stale status and submits cleanly in single and compare',async()=>{
 // Single mode: v0.1.0 -> v0.2.0 with a clean draft carrying a stale status in session/inputs
 const oldSingle=singleSession('0.1.0','0.2.0'),newSingle=singleSession('0.2.0','0.3.0');
 const cleanSingleDraft:LocalInspectionDraft={...draft(),baseline:await sessionFingerprint(oldSingle),reviewDirty:false,inputs:{'review-status':{value:'approved'},'checkpoint-note':{value:'stale note'},'radio:outcome:fail':{value:'fail',checked:true}},session:{...oldSingle,status:'approved'}};
 const singleApp=await openDraftReopenScenario({mode:'single',saved:cleanSingleDraft,currentBaseline:newSingle,currentBinding:binding});
 try{
  expect(singleApp.state()).toMatchObject({conflict:false,dirty:false,restores:0,statusWidget:'pending',statusText:'',dialogStatusText:'',messages:[],draftKeys:[]});
  expect(singleApp.state().current.status).toBe('pending');
  expect(singleApp.statusButtons()).toEqual([]);expect(singleApp.dialogButtons()).toEqual([]);
  const submitted=await singleApp.submit();
  expect(submitted.reviewedSource).toEqual(newSingle.reviewedSource);
 }finally{singleApp.connection.dispose();}

 // Compare mode: v0.1.0 -> v0.2.0 (where CompareBinding and sourceHash also change with tool versions)
 const oldCompare=await compareSession('0.1.0','0.2.0'),newCompare=await compareSession('0.2.0','0.3.0');
 const oldCompareBinding:InspectionBinding={mode:'compare',sourceHash:oldCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const newCompareBinding:InspectionBinding={mode:'compare',sourceHash:newCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const cleanCompareBookmark:InspectionBookmark={...bookmark(),binding:oldCompareBinding,selection:{...bookmark().selection,part:undefined,mode:'compare'}};
 const cleanCompareDraft:LocalInspectionDraft={...draft(),sourceHash:oldCompare.sourceHash,baseline:await sessionFingerprint(oldCompare),reviewDirty:false,bookmark:cleanCompareBookmark,inputs:{status:{value:'approved'}},session:{...oldCompare,status:'approved'}};
 const compareApp=await openDraftReopenScenario({mode:'compare',saved:cleanCompareDraft,savedBinding:oldCompareBinding,currentBaseline:newCompare,currentBinding:newCompareBinding});
 try{
  expect(compareApp.state()).toMatchObject({conflict:false,dirty:false,restores:0,statusWidget:'pending',statusText:'',messages:[],draftKeys:[]});
  expect(compareApp.state().current.status).toBe('pending');
  expect(compareApp.dialogButtons()).toEqual([]);
  const submitted=await compareApp.submit();
  expect(submitted.binding).toEqual(newCompare.binding);
 }finally{compareApp.connection.dispose();}
});

test('#301 Bar 2: reopen after a version change with unsaved feedback recovers feedback with the current reviewedSource/binding and submits cleanly in single and compare',async()=>{
 // Single mode: unsaved feedback across version upgrade
 const oldSingle=singleSession('0.1.0','0.2.0'),newSingle=singleSession('0.2.0','0.3.0'),item=feedbackItem();
 const dirtySingleDraft:LocalInspectionDraft={...draft(),baseline:await sessionFingerprint(oldSingle),reviewDirty:true,inputs:{'review-status':{value:'changes-requested'}},session:{...oldSingle,status:'changes-requested',feedback:[item]}};
 const singleApp=await openDraftReopenScenario({mode:'single',saved:dirtySingleDraft,currentBaseline:newSingle,currentBinding:binding});
 try{
  expect(singleApp.state()).toMatchObject({conflict:false,dirty:true,restores:1,statusWidget:'changes-requested',statusText:'Restored local draft · not submitted'});
  expect(singleApp.state().current.feedback).toEqual([item]);
  expect(singleApp.state().current.reviewedSource).toEqual(newSingle.reviewedSource);
  const submitted=await singleApp.submit();
  expect(submitted.feedback).toEqual([item]);
  expect(submitted.reviewedSource).toEqual(newSingle.reviewedSource);
 }finally{singleApp.connection.dispose();}

 // Compare mode: unsaved feedback across version upgrade (including CompareBinding sourceHash rebind)
 const oldCompare=await compareSession('0.1.0','0.2.0'),newCompare=await compareSession('0.2.0','0.3.0'),compareItem={...feedbackItem('B rig lags reference'),side:'b'};
 const oldCompareBinding:InspectionBinding={mode:'compare',sourceHash:oldCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const newCompareBinding:InspectionBinding={mode:'compare',sourceHash:newCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const compareBookmark:InspectionBookmark={...bookmark(),binding:oldCompareBinding,selection:{...bookmark().selection,part:undefined,mode:'compare'}};
 const dirtyCompareDraft:LocalInspectionDraft={...draft(),sourceHash:oldCompare.sourceHash,baseline:await sessionFingerprint(oldCompare),reviewDirty:true,bookmark:compareBookmark,inputs:{status:{value:'changes-requested'}},session:{...oldCompare,status:'changes-requested',feedback:[compareItem]}};
 const compareApp=await openDraftReopenScenario({mode:'compare',saved:dirtyCompareDraft,savedBinding:oldCompareBinding,currentBaseline:newCompare,currentBinding:newCompareBinding});
 try{
  expect(compareApp.state()).toMatchObject({conflict:false,dirty:true,restores:1,statusWidget:'changes-requested',statusText:'Restored local draft · not submitted',draftKeys:[`rig-review-draft/1:compare:rig-a:${'b'.repeat(64)}:rig-b:${'c'.repeat(64)}:${newCompare.sourceHash}`]});
  expect(compareApp.state().current.feedback).toEqual([compareItem]);
  expect(compareApp.state().current.binding).toEqual(newCompare.binding);
  expect(compareApp.state().current.id).toBe(newCompare.id);
  expect(compareApp.state().current.sourceHash).toBe(newCompare.sourceHash);
  const submitted=await compareApp.submit();
  expect(submitted.feedback).toEqual([compareItem]);
  expect(submitted.binding).toEqual(newCompare.binding);
 }finally{compareApp.connection.dispose();}
});

test('#301 Bar 3 & Bar 4: real conflict refuses submit, exposes download/recover/discard inside the dialog in single and compare, and omits recover from the banner when unrecoverable',async()=>{
 const oldSingle=singleSession('0.1.0','0.2.0'),submittedSingle={...singleSession('0.2.0','0.3.0'),status:'approved',updatedAt:'2026-11-01T12:00:00.000Z'},item=feedbackItem();
 const conflictingSingleDraft:LocalInspectionDraft={...draft(),baseline:await sessionFingerprint(oldSingle),reviewDirty:true,inputs:{'review-status':{value:'changes-requested'}},session:{...oldSingle,status:'changes-requested',feedback:[item]}};

 // 1) Recoverable real conflict (including across tool upgrade): Download + Recover as pending + Discard all in dialog
 const recoverApp=await openDraftReopenScenario({mode:'single',saved:conflictingSingleDraft,currentBaseline:submittedSingle,currentBinding:binding});
 try{
  expect(recoverApp.state().conflict).toBe(true);
  await expect(recoverApp.submit()).rejects.toThrow('Resolve the saved local draft conflict before submitting.');
  expect(recoverApp.dialogButtons()).toEqual(['Download saved local draft','Recover local draft as pending','Discard conflicting local draft']);
  const actions=recoverApp.actionNodes();expect(actions.status).toHaveLength(3);expect(actions.dialog).toHaveLength(3);
  for(let i=0;i<actions.status.length;i++){expect(actions.status[i]).not.toBe(actions.dialog[i]);expect(actions.status[i]!.type).toBe('button');expect(actions.dialog[i]!.type).toBe('button');expect(actions.status[i]!.onclick).toBe(actions.dialog[i]!.onclick);}
  expect(recoverApp.statusButtons()).toEqual(['Download saved local draft','Recover local draft as pending','Discard conflicting local draft']);
  expect(recoverApp.state().dialogStatusText).toBe('Saved local draft conflicts with the current submitted review. Server status is unchanged; download it or explicitly recover as pending.');
  recoverApp.clickInDialog('Download saved local draft');
  const downloaded=await recoverApp.downloads();
  expect(downloaded).toHaveLength(1);expect(downloaded[0]!.download).toBe('review-local-draft.json');expect(JSON.parse(downloaded[0]!.text).session.feedback).toEqual([item]);
  recoverApp.clickInDialog('Recover local draft as pending');
  expect(recoverApp.state()).toMatchObject({conflict:false,dirty:true,statusWidget:'pending',dialogStatusText:'Recovered local draft as pending · not submitted'});
  expect(recoverApp.dialogButtons()).toEqual([]);expect(recoverApp.statusButtons()).toEqual([]);
  expect(recoverApp.state().current.feedback).toEqual([item]);
  expect(recoverApp.state().current.reviewedSource).toEqual(submittedSingle.reviewedSource);
  const savedAfterRecover=await recoverApp.submit();
  expect(savedAfterRecover.feedback).toEqual([item]);expect(savedAfterRecover.reviewedSource).toEqual(submittedSingle.reviewedSource);
 }finally{recoverApp.connection.dispose();}

 // 2) Discard from inside the dialog on a real conflict
 const discardApp=await openDraftReopenScenario({mode:'single',saved:conflictingSingleDraft,currentBaseline:submittedSingle,currentBinding:binding});
 try{
  expect(discardApp.state().conflict).toBe(true);
  discardApp.clickInDialog('Discard conflicting local draft');
  expect(discardApp.state()).toMatchObject({conflict:false,dirty:false,statusWidget:'approved',dialogStatusText:'Local draft discarded · current submitted review retained.'});
  expect(discardApp.dialogButtons()).toEqual([]);expect(discardApp.statusButtons()).toEqual([]);
  const savedAfterDiscard=await discardApp.submit();
  expect(savedAfterDiscard.status).toBe('approved');expect(savedAfterDiscard.feedback).toEqual([]);
 }finally{discardApp.connection.dispose();}

 // 3) Compare mode real conflict: Download, Recover as pending, and Discard work
 const oldCompare=await compareSession('0.1.0','0.2.0'),submittedCompare={...(await compareSession('0.2.0','0.3.0')),status:'approved',updatedAt:'2026-11-01T12:00:00.000Z'},compareItem={...feedbackItem('Compare conflict item'),side:'a'};
 const oldCompareBinding:InspectionBinding={mode:'compare',sourceHash:oldCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const newCompareBinding:InspectionBinding={mode:'compare',sourceHash:submittedCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const compareBookmark:InspectionBookmark={...bookmark(),binding:oldCompareBinding,selection:{...bookmark().selection,part:undefined,mode:'compare'}};
 const conflictingCompareDraft:LocalInspectionDraft={...draft(),sourceHash:oldCompare.sourceHash,baseline:await sessionFingerprint(oldCompare),reviewDirty:true,bookmark:compareBookmark,inputs:{status:{value:'changes-requested'}},session:{...oldCompare,status:'changes-requested',feedback:[compareItem]}};
 const compareConflictApp=await openDraftReopenScenario({mode:'compare',saved:conflictingCompareDraft,savedBinding:oldCompareBinding,currentBaseline:submittedCompare,currentBinding:newCompareBinding});
 try{
  expect(compareConflictApp.state().conflict).toBe(true);
  await expect(compareConflictApp.submit()).rejects.toThrow('Resolve the saved local draft conflict before submitting.');
  expect(compareConflictApp.dialogButtons()).toEqual(['Download saved local draft','Recover local draft as pending','Discard conflicting local draft']);
  compareConflictApp.clickInDialog('Download saved local draft');
  expect((await compareConflictApp.downloads())).toHaveLength(1);
  compareConflictApp.clickInDialog('Recover local draft as pending');
  expect(compareConflictApp.state()).toMatchObject({conflict:false,dirty:true,statusWidget:'pending'});
  expect(compareConflictApp.state().current.feedback).toEqual([compareItem]);
  expect(compareConflictApp.state().current.binding).toEqual(submittedCompare.binding);
  await compareConflictApp.submit();
 }finally{compareConflictApp.connection.dispose();}

 // 4) Bar 4: Unrecoverable conflict (session cannot be recovered) never mentions "recover as pending" in the banner
 const unrecoverableDraft:LocalInspectionDraft={...conflictingSingleDraft,session:{...oldSingle,id:'other-package',status:'changes-requested',feedback:[item]}};
 const unrecoverableApp=await openDraftReopenScenario({mode:'single',saved:unrecoverableDraft,currentBaseline:submittedSingle,currentBinding:binding});
 try{
  expect(unrecoverableApp.state().conflict).toBe(true);
  expect(unrecoverableApp.dialogButtons()).toEqual(['Download saved local draft','Discard conflicting local draft']);
  expect(unrecoverableApp.state().dialogStatusText).toBe('Saved local draft conflicts with the current submitted review. Server status is unchanged; download or discard it.');
  expect(unrecoverableApp.state().dialogStatusText).not.toContain('recover as pending');
 }finally{unrecoverableApp.connection.dispose();}
});

test('#301 Bar 5: single and compare conflict banners and recovery buttons translate cleanly in English and Korean and round-trip without untranslated strings',async()=>{
 const {tr,classifyKoreanDomString}=await import('../web/i18n.ts');
 const {enCatalog}=await import('../web/catalog-en.ts');
 const {koCatalog}=await import('../web/catalog-ko.ts');
 const lines=[
  'Saved local draft conflicts with the current submitted review. Server status is unchanged; download it or explicitly recover as pending.',
  'Saved local draft conflicts with the current submitted review. Server status is unchanged; download or discard it.',
  'Restored local draft · not submitted',
  'Recovered local draft as pending · not submitted',
  'Local draft discarded · current submitted review retained.',
  'Download saved local draft',
  'Recover local draft as pending',
  'Discard conflicting local draft',
  'Discard unusable local draft',
 ];
 for(const line of lines){
  expect(enCatalog[line]).toBe(line);
  const ko=tr(line,'ko');
  expect(ko).toBe(koCatalog[line]);
  expect(ko).not.toBe(line);
  expect(classifyKoreanDomString(ko)).toBe('ok');
 }
});

test('#301 Bar 6: planted legacy-main controls fail every new #301 bar',async()=>{
 const oldSingle=singleSession('0.1.0','0.2.0'),newSingle=singleSession('0.2.0','0.3.0'),item=feedbackItem();

 // Control 1 (Bar 1 on today's main): clean draft after version upgrade falsely conflicts, shows banner, and blocks submit
 const cleanSingleDraft:LocalInspectionDraft={...draft(),baseline:await sessionFingerprint(oldSingle),reviewDirty:false,inputs:{'review-status':{value:'approved'}},session:{...oldSingle,status:'approved'}};
 const legacyClean=await openDraftReopenScenario({mode:'single',saved:cleanSingleDraft,currentBaseline:newSingle,currentBinding:binding,legacyMain:true});
 try{
  expect(legacyClean.state().conflict).toBe(true); // fails Bar 1 (conflict is false on fix)
  expect(legacyClean.state().statusText).toContain('explicitly recover as pending'); // fails Bar 1 (no banner) and Bar 4 (offers absent button)
  expect(legacyClean.statusButtons()).not.toContain('Recover local draft as pending');
  await expect(legacyClean.submit()).rejects.toThrow('Resolve the saved local draft conflict');
 }finally{legacyClean.connection.dispose();}

 // Control 2 (Bar 2 on today's main): unsaved feedback after version upgrade fails recoverSession in single and is lost in compare
 const dirtySingleDraft:LocalInspectionDraft={...draft(),baseline:await sessionFingerprint(oldSingle),reviewDirty:true,session:{...oldSingle,status:'changes-requested',feedback:[item]}};
 const legacyDirtySingle=await openDraftReopenScenario({mode:'single',saved:dirtySingleDraft,currentBaseline:newSingle,currentBinding:binding,legacyMain:true});
 try{
  expect(legacyDirtySingle.state().conflict).toBe(true); // fails Bar 2
  expect(legacyDirtySingle.state().current.feedback).toEqual([]); // feedback not recovered
  expect(legacyDirtySingle.statusButtons()).not.toContain('Recover local draft as pending'); // cannot even recover manually!
 }finally{legacyDirtySingle.connection.dispose();}

 const oldCompare=await compareSession('0.1.0','0.2.0'),newCompare=await compareSession('0.2.0','0.3.0'),compareItem={...feedbackItem('Lost on legacy compare'),side:'a'};
 const oldCompareBinding:InspectionBinding={mode:'compare',sourceHash:oldCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const newCompareBinding:InspectionBinding={mode:'compare',sourceHash:newCompare.sourceHash,rigs:['b'.repeat(64),'c'.repeat(64)]};
 const compareBookmark:InspectionBookmark={...bookmark(),binding:oldCompareBinding,selection:{...bookmark().selection,part:undefined,mode:'compare'}};
 const dirtyCompareDraft:LocalInspectionDraft={...draft(),sourceHash:oldCompare.sourceHash,baseline:await sessionFingerprint(oldCompare),reviewDirty:true,bookmark:compareBookmark,session:{...oldCompare,status:'changes-requested',feedback:[compareItem]}};
 const legacyDirtyCompare=await openDraftReopenScenario({mode:'compare',saved:dirtyCompareDraft,savedBinding:oldCompareBinding,currentBaseline:newCompare,currentBinding:newCompareBinding,legacyMain:true});
 try{
  expect(legacyDirtyCompare.state().current.feedback).toEqual([]); // fails Bar 2: unsaved compare feedback silently orphaned on upgrade
 }finally{legacyDirtyCompare.connection.dispose();}

 // Control 3 (Bar 3 & Bar 4 on today's main): review dialog has no recovery buttons, and unrecoverable conflict banner still says "recover as pending"
 const submittedSingle={...newSingle,status:'approved',updatedAt:'2026-11-01T12:00:00.000Z'};
 const legacyConflict=await openDraftReopenScenario({mode:'single',saved:{...dirtySingleDraft,session:{...newSingle,status:'changes-requested',feedback:[item]}},currentBaseline:submittedSingle,currentBinding:binding,legacyMain:true});
 try{
  expect(legacyConflict.dialogButtons()).toEqual([]); // fails Bar 3: no recovery controls inside #review-dialog
 }finally{legacyConflict.connection.dispose();}
});
