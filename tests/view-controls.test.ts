import {createViewportController,createViewportState} from '../web/viewport-controller.ts';
import {RigOverlays} from '../web/rig-overlays.ts';
import {createRigViewportProvider,type RigViewportHost} from '../web/rig-viewport-provider.ts';
import type {ModelAssets,PoseBounds,PosedFrame,RigPlayer,SlotFilter} from '@rig-c/play';
import {singleCameraWiring} from './helpers/viewport-387-wiring.ts';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature} from '../web/camera-view.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import {test,expect} from 'bun:test';
import {labelledControl,actionButton,stageOrientation,syncStageLayout,panCenter,idleAvailable,initialIdleAnimation,themePreference,automaticIdlePreview} from '../web/view-controls.ts';
test('orientation follows available center rectangle, with stable square tie',()=>{expect(stageOrientation(900,600)).toBe('horizontal');expect(stageOrientation(600,900)).toBe('vertical');expect(stageOrientation(600,600)).toBe('horizontal');});
test('pan preserves coordinate signs and scales independently of pose time',()=>{expect(panCenter({x:10,y:20},40,20,2,'world')).toEqual({x:-10,y:30});expect(panCenter({x:10,y:20},40,20,2,'image')).toEqual({x:-10,y:10});expect(panCenter({x:10,y:20},40,20,4,'world')).toEqual({x:0,y:25});expect(()=>panCenter({x:0,y:0},1,1,0,'world')).toThrow('positive scale');});
test('only actual exact idle can preview; explicit inspection wins startup',()=>{expect(idleAvailable(['idle','walk'],'walk')).toBe(false);expect(idleAvailable(['idle_variant'],'idle')).toBe(false);expect(idleAvailable(['idle'],'idle')).toBe(true);expect(initialIdleAnimation(['walk','idle'],'walk',false)).toBe('idle');expect(initialIdleAnimation(['walk','idle'],'walk',true)).toBe('walk');expect(initialIdleAnimation(['walk'],'walk',false)).toBe('walk');expect(initialIdleAnimation([],null,false)).toBe(null);});
test('appearance accepts only local supported choices',()=>{expect(themePreference('light')).toBe('light');expect(themePreference('dark')).toBe('dark');expect(themePreference('system')).toBe('system');expect(themePreference('other')).toBe('system');expect(themePreference(null)).toBe('system');});

test('real handoff automatic idle checkpoint previews; deep-link, timed or axis inspections hold',()=>{
 const point={id:'character',title:'Character',animation:'idle',time:0,workspace:'modeling' as const,camera:{zoom:1,x:20,y:30}};
 const manifest={references:[],axes:[],checkpoints:[point]};
 const initial=initialReviewSelection(manifest,null,undefined,'idle');
 expect(initial.checkpoint).toBe(point);
 expect(automaticIdlePreview(['idle'],'idle',initial.checkpoint,false)).toBe(true);
 const requested=initialReviewSelection(manifest,point.id,undefined,'idle');
 expect(automaticIdlePreview(['idle'],'idle',requested.checkpoint,true)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',{...point,time:.4},false)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',{...point,axis:{id:'look',value:0}},false)).toBe(false);
 expect(automaticIdlePreview(['idle','dance'],'dance',{...point,animation:'dance'},false)).toBe(false);
 expect(automaticIdlePreview(['idle'],'idle',undefined,false)).toBe(true);
 expect(automaticIdlePreview(['idle_variant'],'idle',undefined,false)).toBe(false);
});

// Source-extracted actual app adapters retain their orchestration; only browser
// event/media and UI hosts are substituted. Actual decoding is a browser gate.
import {readFile} from 'node:fs/promises';
import {feedbackTargetNames} from '../src/feedback-validation.ts';

interface PanHostEvent {
 type:string;target:PanHostElement;code?:string;pointerId?:number;isPrimary?:boolean;button?:number;buttons?:number;clientX?:number;clientY?:number;defaultPrevented:boolean;preventDefault():void;
}
class PanHostEvents {
 handlers=new Map<string,{listener:(event:PanHostEvent)=>void;capture:boolean}[]>();
 addEventListener(type:string,listener:(event:PanHostEvent)=>void,capture=false){const rows=this.handlers.get(type)??[];rows.push({listener,capture});this.handlers.set(type,rows);}
 removeEventListener(type:string,listener:(event:PanHostEvent)=>void){this.handlers.set(type,(this.handlers.get(type)??[]).filter(row=>row.listener!==listener));}
 emit(type:string,target:PanHostElement,values:Partial<PanHostEvent>={},captureOnly=false):PanHostEvent {
  const event:PanHostEvent={type,target,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...values};
  for(const row of [...this.handlers.get(type)??[]])if(!captureOnly||row.capture)row.listener(event);return event;
 }
}
class PanHostStyle {
 private values=new Map<string,{value:string;priority:string}>();
 getPropertyValue(name:string){return this.values.get(name)?.value??'';}
 getPropertyPriority(name:string){return this.values.get(name)?.priority??'';}
 setProperty(name:string,value:string,priority=''){this.values.set(name,{value,priority});}
 removeProperty(name:string){const value=this.getPropertyValue(name);this.values.delete(name);return value;}
}
class PanHostElement extends PanHostEvents {
 style=new PanHostStyle();dataset:Record<string,string>={};videos:PanHostElement[]=[];controls=true;captured=new Set<number>();parent:PanHostElement|null=null;
 constructor(readonly tagName:string){super();}
 closest(selector:string):PanHostElement|null {return selector.split(',').some(value=>value==='video[controls]'?this.tagName==='VIDEO'&&this.controls:value.toUpperCase()===this.tagName)?this:this.parent?.closest(selector)??null;}
 querySelectorAll(){return this.videos.filter(video=>video.controls);}
 setPointerCapture(id:number){this.captured.add(id);}
 hasPointerCapture(id:number){return this.captured.has(id);}
 releasePointerCapture(id:number){this.captured.delete(id);}
}
async function panHost(){
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),begin=source.indexOf('const panVideoOverrides='),end=source.indexOf('export function bindInspectorTabs(',begin);if(begin<0||end<begin)throw new Error('Pan lifecycle boundary missing');
 const window=new PanHostEvents(),document=new PanHostEvents(),body=new PanHostElement('BODY');
 class Observer {
  static active=new Set<Observer>();constructor(private changed:()=>void){}
  observe(){Observer.active.add(this);}disconnect(){Observer.active.delete(this);}
  static mutate(){for(const observer of [...Observer.active])observer.changed();}
 }
 const script=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(begin,end).replace('export function','function'));
 const bind=new Function('window','document','Element','MutationObserver',script+';return bindPan;')(window,document,PanHostElement,Observer) as (viewport:PanHostElement,move:(dx:number,dy:number)=>void,enabled?:()=>boolean)=>()=>void;
 const keyDown=(target=body)=>document.emit('keydown',target,{code:'Space'});
 const keyUp=(target=body)=>window.emit('keyup',target,{code:'Space'},true);
 // Native media swallows down/up before DOM dispatch unless hit testing is
 // redirected. This models the sealed trusted trace, not native rendering.
 const gesture=(viewport:PanHostElement,video:PanHostElement)=>{
  const redirected=video.style.getPropertyValue('pointer-events')==='none',target=redirected?viewport:video;
  if(redirected)viewport.emit('pointerdown',target,{pointerId:7,isPrimary:true,button:0,buttons:1,clientX:100,clientY:200});
  viewport.emit('pointermove',target,{pointerId:7,isPrimary:true,button:-1,buttons:1,clientX:136,clientY:220});
  if(redirected)viewport.emit('pointerup',target,{pointerId:7,isPrimary:true,button:0,buttons:0,clientX:136,clientY:220});
  return redirected;
 };
 return {bind,window,document,body,keyDown,keyUp,gesture,mutate:()=>Observer.mutate(),observers:()=>Observer.active.size};
}

test('Space redirects native video hit testing for a real pan lifecycle and restores exact inline controls state',async()=>{
 const host=await panHost(),viewport=new PanHostElement('DIV'),video=new PanHostElement('VIDEO'),moves:number[][]=[];viewport.videos=[video];video.style.setProperty('pointer-events','auto','important');
 const dispose=host.bind(viewport,(dx,dy)=>moves.push([dx,dy]));
 try{
  expect(host.gesture(viewport,video)).toBe(false);expect(moves).toEqual([]);expect(video.style.getPropertyValue('pointer-events')).toBe('auto');
  const key=host.keyDown();expect(key.defaultPrevented).toBe(true);expect(video.style.getPropertyValue('pointer-events')).toBe('none');expect(video.style.getPropertyPriority('pointer-events')).toBe('important');
  expect(host.gesture(viewport,video)).toBe(true);expect(moves).toEqual([[36,20]]);expect(viewport.hasPointerCapture(7)).toBe(false);expect(viewport.dataset.panning).toBeUndefined();
  // Keyup cleanup runs at window capture even if native video would eat bubbling.
  host.keyUp(video);expect(video.style.getPropertyValue('pointer-events')).toBe('auto');expect(video.style.getPropertyPriority('pointer-events')).toBe('important');expect(host.observers()).toBe(0);
  expect(host.gesture(viewport,video)).toBe(false);expect(moves).toEqual([[36,20]]);
  for(const tag of ['INPUT','TEXTAREA','SELECT','BUTTON']){expect(host.keyDown(new PanHostElement(tag)).defaultPrevented).toBe(false);expect(video.style.getPropertyValue('pointer-events')).toBe('auto');}
  viewport.emit('pointerdown',new PanHostElement('BUTTON'),{pointerId:8,isPrimary:true,button:0,clientX:0,clientY:0});expect(viewport.hasPointerCapture(8)).toBe(false);
  host.keyDown();viewport.emit('pointerdown',viewport,{pointerId:9,isPrimary:true,button:0,clientX:0,clientY:0});expect(viewport.hasPointerCapture(9)).toBe(true);
  host.window.emit('blur',host.body);expect(video.style.getPropertyValue('pointer-events')).toBe('auto');expect(viewport.hasPointerCapture(9)).toBe(false);expect(viewport.dataset.panning).toBeUndefined();expect(host.observers()).toBe(0);
 }finally{dispose();}
 expect(host.document.handlers.get('keydown')).toHaveLength(0);expect(host.window.handlers.get('keyup')).toHaveLength(0);
});

test('multiple pan binders and videos added, removed or replaced while Space is held never retain native-control overrides',async()=>{
 const host=await panHost(),a=new PanHostElement('DIV'),b=new PanHostElement('DIV'),old=new PanHostElement('VIDEO'),replacement=new PanHostElement('VIDEO');a.videos=[old];b.videos=[old];old.style.setProperty('pointer-events','visiblePainted');
 const disposeA=host.bind(a,()=>{}),disposeB=host.bind(b,()=>{});
 try{
  host.keyDown();expect(old.style.getPropertyValue('pointer-events')).toBe('none');expect(host.observers()).toBe(2);
  disposeA();expect(old.style.getPropertyValue('pointer-events')).toBe('none');expect(host.observers()).toBe(1);
  b.videos=[replacement];host.mutate();expect(old.style.getPropertyValue('pointer-events')).toBe('visiblePainted');expect(old.style.getPropertyPriority('pointer-events')).toBe('');expect(replacement.style.getPropertyValue('pointer-events')).toBe('none');
  replacement.controls=false;host.mutate();expect(replacement.style.getPropertyValue('pointer-events')).toBe('');
  replacement.controls=true;host.mutate();expect(replacement.style.getPropertyValue('pointer-events')).toBe('none');
  host.keyUp(replacement);expect(replacement.style.getPropertyValue('pointer-events')).toBe('');expect(host.observers()).toBe(0);
  host.keyDown();expect(replacement.style.getPropertyValue('pointer-events')).toBe('none');disposeB();expect(replacement.style.getPropertyValue('pointer-events')).toBe('');expect(host.observers()).toBe(0);
  const disabled=host.bind(b,()=>{throw new Error('Disabled pan must not move');},()=>false);try{expect(host.keyDown().defaultPrevented).toBe(false);expect(replacement.style.getPropertyValue('pointer-events')).toBe('');expect(host.gesture(b,replacement)).toBe(false);}finally{disabled();}
 }finally{disposeA();disposeB();}
});

test('actual single video inspection acknowledges decoded PTS, repeats that actual frame and rolls back a refused sample',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('async function inspectControlTime('),end=source.indexOf('function numericView()',begin);if(begin<0||end<begin)throw new Error('single decoded seek boundary missing');
 const functions=source.slice(begin,end);
 class Media extends EventTarget {
  readyState=2;duration=2;seeking=false;paused=true;position=.1;requests=0;private serial=0;private callbacks=new Map<number,VideoFrameRequestCallback>();
  actual=(target:number)=>target===.3?.25:target===1?2.1:target;
  get currentTime(){return this.position;}
  set currentTime(target:number){this.position=target;this.seeking=true;queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));for(const [id,callback]of this.callbacks){this.callbacks.delete(id);callback(0,{mediaTime:this.actual(target)} as VideoFrameCallbackMetadata);}});}
  requestVideoFrameCallback(callback:VideoFrameRequestCallback){this.requests++;const id=++this.serial;this.callbacks.set(id,callback);return id;}
  cancelVideoFrameCallback(id:number){this.callbacks.delete(id);}
  get pending(){return this.callbacks.size;}
 }
 const script=`function reposePreview(){}
function clipMoved(){}
function open(video,hasPlayer){let time=.1,duration=2,controlledVideoSample=null,axisInspection=false;const player=hasPlayer?{time:.1,seek(value){this.time=value;},draw(){}}:null;let draws=0;const drawRig=action=>{action();draws++;},renderSequenceFrame=()=>{},renderTransport=()=>{},message=()=>{},errorText=error=>error instanceof Error?error.message:String(error);${functions};return {seek:(target,preserveSeconds=false)=>inspectControlTime(target,new AbortController().signal,preserveSeconds),state:()=>({time,pose:player?.time??null,draws}),abort:()=>{const controller=new AbortController();controller.abort();return inspectControlTime(.6,controller.signal);}};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type App={seek(value:number,preserveSeconds?:boolean):Promise<void>;state():{time:number;pose:number|null;draws:number};abort():Promise<void>};
 for(const hasPlayer of [true,false]){
  const media=new Media(),app=new Function('video','hasPlayer',code+';return open(video,hasPlayer);')(media,hasPlayer) as App;
  await app.seek(.3);expect(app.state()).toMatchObject({time:.25,pose:hasPlayer ? .25 : null});expect(media.currentTime).toBe(.3);expect(media.pending).toBe(0);
  const requests=media.requests;await app.seek(.3);expect(media.requests).toBe(requests);expect(app.state().time).toBe(.25);expect(app.state().pose).toBe(hasPlayer ? .25 : null);
  await expect(app.seek(1)).rejects.toThrow('CONTROL_TIME_OUTSIDE_DOMAIN');expect(media.currentTime).toBe(.3);expect(app.state()).toMatchObject({time:.25,pose:hasPlayer ? .25 : null});expect(media.pending).toBe(0);
  await expect(app.abort()).rejects.toThrow('CONTROL_SUPERSEDED');expect(media.currentTime).toBe(.3);
  await app.seek(.75);expect(app.state()).toMatchObject({time:.75,pose:hasPlayer ? .75 : null});expect(media.pending).toBe(0);
  await app.seek(.3,true);expect(app.state()).toMatchObject({time:.3,pose:hasPlayer ? .3 : null});expect(media.currentTime).toBe(.3);
  // A seconds-only bookmark retains its exact seconds without relabelling the decoded PTS.
  await app.seek(.3);expect(app.state()).toMatchObject({time:.25,pose:hasPlayer ? .25 : null});expect(media.pending).toBe(0);
 }
 // Source-only readback must use the acknowledged actual sample, not the
 // browser's requested currentTime (which can be between decoded frames).
 const observe=source.slice(source.indexOf('function controlState()'),source.indexOf('async function applyControl('));expect(observe).toContain('animation:animation||null,time,');expect(observe).not.toContain('video?.currentTime');
});

test('actual single camera adapters synchronize normalized views by default, then preserve independent panes and active toolbar behavior',async()=>{
 const functions=singleCameraWiring;
 const script=`function open(deps){const {createViewportController,createViewportState,createRigViewportProvider,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}=deps;let zoom=1,referenceZoom=1,cameraCenter=null,referenceCenter=null,cameraSync=true,activeCamera='rig';let selected=null,selectedBounds=null;const statuses=[];const parts={value:()=>selected,bounds:()=>selectedBounds},message=(value,error=false)=>{statuses.push({value,error});};const cameraFrames={},referenceSize={width:1920,height:1080},player={},assets={stage:{x:-300,y:80,width:200,height:600}};let fits=0;const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{clientWidth:id.startsWith('rig')?600:300,clientHeight:id.startsWith('rig')?400:800,hidden:false,checked:true,textContent:''});return nodes.get(id);};const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},fitCamera=()=>{fits++;};${functions};return {edge:()=>{referenceSize.width=2*Number.MAX_SAFE_INTEGER-1000;referenceCenter=null;},wheel:zoomViewport,pan:panCamera,sync:setCameraSync,zoom:zoomCamera,fit:fitActiveCamera,part:(value,bounds)=>{selected=value;selectedBounds=bounds;},status:()=>statuses.at(-1),hide:target=>{el(target+'-pane').hidden=true;},state:()=>({sync:cameraSync,active:activeCamera,rig:{zoom,center:cameraCenter},reference:{zoom:referenceZoom,center:referenceCenter},rigSignature:cameraSignature(paneCamera('rig'),paneFrame('rig',true)),referenceSignature:cameraSignature(paneCamera('reference'),paneFrame('reference',true))})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={sync:boolean;active:string;rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};rigSignature:{zoom:number;pan:{x:number;y:number}};referenceSignature:{zoom:number;pan:{x:number;y:number}}};
 const app=new Function('deps',code+';return open(deps);')({createViewportController,createViewportState,createRigViewportProvider,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as {edge():void;wheel(target:string,delta:number):void;pan(target:string,dx:number,dy:number):void;sync(value:boolean):void;zoom(value:number):void;fit(target?:string):void;part(value:unknown,bounds:unknown):void;status():{value:string;error:boolean}|undefined;hide(target:string):void;state():State};
 app.wheel('reference',-1);expect(app.state()).toMatchObject({sync:true,active:'reference',rig:{zoom:1.1},reference:{zoom:1.1}});
 app.pan('rig',120,60);expect(app.state().rigSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.y).toBeCloseTo(.15,12);expect(app.state().rig.center!.y).toBeGreaterThan(380);expect(app.state().reference.center!.y).toBeLessThan(540);
 app.sync(false);const prior=app.state().rig;app.wheel('reference',-1);app.pan('reference',30,-40);expect(app.state().rig).toEqual(prior);const ref=app.state().reference;app.zoom(1.25);expect(app.state().reference.zoom).toBeCloseTo(ref.zoom*1.25,12);expect(app.state().rig).toEqual(prior);
 app.sync(true);expect(app.state().rigSignature.zoom).toBe(app.state().referenceSignature.zoom);expect(app.state().rigSignature.pan.x).toBeCloseTo(app.state().referenceSignature.pan.x,12);app.fit();expect(app.state().rigSignature.pan).toEqual({x:0,y:0});expect(app.state().referenceSignature.pan).toEqual({x:0,y:0});
 app.sync(false);app.hide('reference');const hidden=app.state().reference;app.wheel('rig',-1);expect(app.state().reference).toEqual(hidden);for(let n=0;n<100;n++)app.wheel('rig',-1);expect(app.state().rig.zoom).toBe(8);for(let n=0;n<100;n++)app.wheel('rig',1);expect(app.state().rig.zoom).toBe(.25);
 const selected=new Function('deps',code+';return open(deps);')({createViewportController,createViewportState,createRigViewportProvider,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as typeof app;selected.part({side:'single',slot:'mesh',mode:'context'},{x:-160,y:200,width:20,height:80});selected.fit('rig');expect(selected.state().rig.center!.x).toBeCloseTo(-150,10);expect(selected.state().rig.center!.y).toBeCloseTo(240,10);expect(selected.state().referenceSignature.pan.x).toBeCloseTo(selected.state().rigSignature.pan.x,10);selected.sync(false);const selectedRef=selected.state().reference;selected.part({side:'single',slot:'mesh',mode:'solo'},{x:-100,y:300,width:40,height:100});selected.fit('rig');expect(selected.state().reference).toEqual(selectedRef);const absent=selected.state();selected.part({side:'single',slot:'hidden',mode:'solo'},null);selected.fit('rig');expect(selected.state()).toEqual(absent);expect(selected.status()).toEqual({value:'PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',error:true});const refusal=selected.status();selected.zoom(1.1);expect(selected.status()).toEqual(refusal);const priorFailure=selected.state();selected.part({side:'single',slot:'extreme',mode:'solo'},{x:1e20,y:300,width:40,height:100});expect(()=>selected.fit('rig')).toThrow('VIEW_CAMERA_RANGE');expect(selected.state()).toEqual(priorFailure);expect(selected.status()).toEqual(refusal);selected.part({side:'single',slot:'mesh',mode:'solo'},{x:-100,y:300,width:40,height:100});selected.fit('rig');expect(selected.status()).toEqual({value:'Selected slot fitted.',error:false});
 const overflow=new Function('deps',code+';return open(deps);')({createViewportController,createViewportState,createRigViewportProvider,cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as typeof app;overflow.edge();const before=overflow.state();expect(()=>overflow.pan('rig',-65536,0)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(before);overflow.sync(false);overflow.pan('rig',-65536,0);const independent=overflow.state();expect(()=>overflow.sync(true)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(independent);
});

test('actual single afterInputs rebuilds restored bone and slot target editability, catalog and hints',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('function renderFeedbackTargets('),end=source.indexOf('function renderFrameTransport()',begin),after=source.indexOf('afterInputs:()=>{'),afterEnd=source.indexOf(',onConflict:',after);if([begin,end,after,afterEnd].some(v=>v<0))throw new Error('single restored target action missing');
 const functions=source.slice(begin,end),afterInputs=source.slice(after+'afterInputs:'.length,afterEnd);
 const script=`function open(feedbackTargetNames){const fields={'feedback-target-kind':{value:''},'feedback-target-name':{value:'',disabled:false,readOnly:false},'audio-volume':{value:'1'}},names=[],hints={};const list={replaceChildren(){names.length=0;},append(item){names.push(item.value);}},input=id=>fields[id],select=input,el=()=>list,option=value=>({value}),text=(id,value)=>{hints[id]=value;},renderFeedbackRange=()=>{},data={feedbackCatalog:{rig:'actual-rig',bones:['root','elbow'],slots:['shirt'],animations:null,clock:null,clockAnimation:null}};${functions};const afterInputs=${afterInputs};renderFeedbackTargets(true);return {restore:(kind,name)=>{fields['feedback-target-kind'].value=kind;fields['feedback-target-name'].value=name;afterInputs();},state:()=>({field:{...fields['feedback-target-name']},names:[...names],hint:hints['feedback-target-hint']})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script),app=new Function('feedbackTargetNames',code+';return open(feedbackTargetNames);')(feedbackTargetNames) as {restore(kind:string,name:string):void;state():{field:{value:string;disabled:boolean;readOnly:boolean};names:string[];hint:string}};
 expect(app.state().field.disabled).toBe(true);app.restore('bone','elbow');expect(app.state()).toMatchObject({field:{value:'elbow',disabled:false,readOnly:false},names:['root','elbow']});expect(app.state().hint).toContain('2 targets');app.restore('bone','elb');expect(app.state()).toMatchObject({field:{value:'elb',disabled:false,readOnly:false},names:['root','elbow']});app.restore('slot','shirt');expect(app.state()).toMatchObject({field:{value:'shirt',disabled:false,readOnly:false},names:['shirt']});expect(app.state().hint).toContain('1 targets');app.restore('rig','actual-rig');expect(app.state().field).toEqual({value:'actual-rig',disabled:false,readOnly:true});
});

test('synchronous aspect refresh uses the same stable orientation as resize observation',()=>{const area={clientWidth:628,clientHeight:789,dataset:{orientation:'horizontal'}};expect(syncStageLayout(area)).toBe(true);expect(area.dataset.orientation).toBe('vertical');expect(syncStageLayout(area)).toBe(false);area.clientWidth=900;expect(syncStageLayout(area)).toBe(true);expect(area.dataset.orientation).toBe('horizontal');});

import {numericCamera,restoredZoom,restoreTransaction} from '../web/inspection-persistence.ts';
test('actual compare camera adapters keep A/B/reference independent OFF, synchronize ON and restore divergent legacy regions',async()=>{
 const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const slice=(from:string,to:string)=>{const a=source.indexOf(from),b=source.indexOf(to,a);if(a<0||b<a)throw new Error('compare camera boundary missing');return source.slice(a,b);};
 const functions=slice('function unionBounds(','async function loadSide(')+slice('function sharedBox(','function redrawOverlays(')+slice('async function applyControl(','function numericView(')+slice('function numericView():','function renderNumericView(')+slice('async function restoreInspection(','async function setupPersistence(');
 const script=`function open(deps){const {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}=deps;
 const cameras={a:{zoom:1,center:null},b:{zoom:1,center:null},reference:{zoom:1,center:null}},cameraFrames={},rigScales={a:1,b:1};let turnPad=null;let cameraSync=true,activeCamera='a',cameraRestoring=false,cameraLayout='',idleHeld=true,trace=null,seeking=false;let selected=null,selectedBounds=null;const statuses=[];const parts={value:()=>selected,bounds:()=>selectedBounds,validate(){},select(value){selected=value;}},message=(value,error=false)=>{statuses.push({value,error});};const video={videoWidth:1920,videoHeight:1080,style:{},muted:true},players={a:{renderer:{syncPixelRatio(){}}},b:{renderer:{syncPixelRatio(){}}}},assets={a:{stage:{x:-300,y:80,width:200,height:600}},b:{stage:{x:-200,y:90,width:300,height:580}}};const nodes=new Map();const el=id=>{if(!nodes.has(id)){const size=id.startsWith('a-')?[600,400]:id.startsWith('b-')?[400,600]:[300,800];nodes.set(id,{clientWidth:size[0],clientHeight:size[1],style:{},dataset:{},checked:true,textContent:''});}return nodes.get(id);};const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},redrawOverlays=()=>{},renderNumericView=()=>{},stop=()=>{},captureInputs=()=>({}),restoreInputs=()=>{},appearance=null,layers={images:true,mesh:false,bones:false},document={querySelectorAll:()=>[]},domain={start:0,end:2},data={animation:'idle',reference:{sha256:'reference'}};let saving=false,stripBusy=false;const localDraft=()=>false,requireCommonTime=()=>{};async function seekTo(time){trace={reference:time};}const inspectionBookmark=()=>({animation:'idle',time:null,theme:'dark',layers:{images:true,meshes:false,bones:false},selection:{reference:'reference'},view:numericView()});
 ${functions};fit();return {edge:()=>{video.videoWidth=2*Number.MAX_SAFE_INTEGER-1000;cameras.reference.center=null;},pan:panCamera,zoom:zoomCamera,sync:setCameraSync,fit:fitActiveCamera,part:(value,bounds)=>{selected=value;selectedBounds=bounds;},status:()=>statuses.at(-1),remote:command=>applyControl(command,new AbortController().signal),restore:value=>restoreInspection(value,new AbortController().signal),bookmark:inspectionBookmark,state:()=>({view:numericView(),scales:{...rigScales},referenceTransform:video.style.transform,positions:{a:{...el('a-root').style},b:{...el('b-root').style}}}),signature:target=>cameraSignature(cameras[target],paneFrame(target))};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={view:import('../src/control.ts').ControlView;scales:{a:number;b:number};referenceTransform:string;positions:{a:{left:string;top:string};b:{left:string;top:string}}};
 const app=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}) as {edge():void;pan(target:string,dx:number,dy:number):void;zoom(factor:number,target:string):void;sync(value:boolean):void;fit(target?:string):void;part(value:unknown,bounds:unknown):void;status():{value:string;error:boolean}|undefined;remote(command:unknown):Promise<void>;restore(value:unknown):Promise<void>;bookmark():{view:State['view']};state():State;signature(target:string):{zoom:number;pan:{x:number;y:number}}};
 app.pan('reference',60,120);for(const target of ['a','b']){expect(app.signature(target).pan.x).toBeCloseTo(.2,12);expect(app.signature(target).pan.y).toBeCloseTo(.15,12);}expect(app.state().scales.a).not.toBe(app.state().scales.b);
 app.sync(false);const frozen=structuredClone(app.state().view.cameras);app.pan('b',40,-60);expect(app.state().view.cameras.a).toEqual(frozen.a);expect(app.state().view.cameras.reference).toEqual(frozen.reference);expect(app.state().view.cameras.b).not.toEqual(frozen.b);
 await app.remote({type:'camera',target:'a',zoom:2,pan:{x:120,y:80}});expect(app.signature('a').pan.x).toBeCloseTo(.2,12);expect(app.signature('b').zoom).toBe(1);const priorReference=app.state().view.cameras.reference;
 await app.remote({type:'camera',target:'rig',zoom:3,pan:{x:60,y:40}});expect(app.signature('a').zoom).toBe(3);expect(app.signature('b').zoom).toBe(3);expect(app.signature('a').pan.x).toBeCloseTo(app.signature('b').pan.x,12);expect(app.state().view.cameras.reference).toEqual(priorReference);
 app.pan('b',80,30);const bookmark=app.bookmark(),legacy={...bookmark,view:{...bookmark.view}};delete legacy.view.cameraSync;delete legacy.view.activeCamera;
 app.sync(true);expect(app.state().view.activeCamera).toBe('b');for(const target of ['a','reference'])expect(app.signature(target).pan.x).toBeCloseTo(app.signature('b').pan.x,12);
 await app.restore(legacy);expect(app.state().view.cameraSync).toBe(false);for(const target of ['a','b','reference'] as const){expect(app.state().view.cameras[target]!.center.x).toBeCloseTo(bookmark.view.cameras[target]!.center.x,10);expect(app.state().view.cameras[target]!.center.y).toBeCloseTo(bookmark.view.cameras[target]!.center.y,10);expect(app.state().view.cameras[target]!.zoom).toBeCloseTo(bookmark.view.cameras[target]!.zoom,10);}
 app.part({side:'b',slot:'mesh',mode:'context'},{x:-150,y:200,width:30,height:90});app.sync(false);const fixedA=structuredClone(app.state().view.cameras.a),fixedRef=structuredClone(app.state().view.cameras.reference);app.fit('b');expect(app.state().view.cameras.b!.center.x).toBeCloseTo(-135,10);expect(app.state().view.cameras.b!.center.y).toBeCloseTo(245,10);expect(app.state().view.cameras.a).toEqual(fixedA);expect(app.state().view.cameras.reference).toEqual(fixedRef);app.sync(true);app.fit('b');expect(app.signature('a').pan.x).toBeCloseTo(app.signature('b').pan.x,10);expect(app.signature('reference').pan.y).toBeCloseTo(app.signature('b').pan.y,10);app.part({side:'b',slot:'hidden',mode:'solo'},null);const noBounds=app.state();app.fit('b');expect(app.state()).toEqual(noBounds);expect(app.status()).toEqual({value:'PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',error:true});const refusal=app.status();app.zoom(1.1,'b');expect(app.status()).toEqual(refusal);const failedState=app.state();app.part({side:'b',slot:'extreme',mode:'solo'},{x:1e20,y:200,width:30,height:90});expect(()=>app.fit('b')).toThrow('VIEW_CAMERA_RANGE');expect(app.state()).toEqual(failedState);expect(app.status()).toEqual(refusal);app.part({side:'b',slot:'mesh',mode:'solo'},{x:-150,y:200,width:30,height:90});app.fit('b');expect(app.status()).toEqual({value:'Selected slot fitted.',error:false});app.part(null,null);
 const before=app.state();const invalid={...legacy,view:{...legacy.view,cameras:{...legacy.view.cameras,b:{...legacy.view.cameras.b!,visible:{...legacy.view.cameras.b!.visible,width:1e12,height:1e12}}}}};await expect(app.restore(invalid)).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(before.view);
 app.sync(true);app.edge();const groupBefore=app.state().view;await expect(app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(groupBefore);
 app.sync(false);await app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}});const offBefore=app.state().view;await expect(app.remote({type:'camera-sync',value:true})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(offBefore);
});

test('inspection appearance applies source or Settings choices without touching browser storage',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindAppearance('),b=source.indexOf('export function syncStageLayout',a);
 const control=Object.assign(new EventTarget(),{value:''}),system=Object.assign(new EventTarget(),{matches:false}),document={documentElement:{dataset:{} as Record<string,string>}};
 let storageTouches=0;const storage={getItem(){storageTouches++;return 'system';},setItem(){storageTouches++;}};
 const fn=new Function('matchMedia','document','themePreference','localStorage',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b).replace('export function','function'))+';return bindAppearance;')(()=>system,document,themePreference,storage);
 const binding=fn(control,'dark');expect(document.documentElement.dataset.theme).toBe('dark');binding.set('light');expect(document.documentElement.dataset.theme).toBe('light');expect(control.value).toBe('light');binding.set('system');system.matches=true;system.dispatchEvent(new Event('change'));expect(document.documentElement.dataset.theme).toBe('light');expect(binding.get()).toBe('system');expect(storageTouches).toBe(0);binding.dispose();
});

test('tab switching captures the old panel before hiding and restores after showing, by mouse and keyboard',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindInspectorTabs('),panels=[{dataset:{inspectorPanel:'view'},hidden:false},{dataset:{inspectorPanel:'rig'},hidden:true}],tabs=[{dataset:{inspector:'view'},setAttribute(){},tabIndex:0,focus(){}},{dataset:{inspector:'rig'},setAttribute(){},tabIndex:-1,focus(){}}];
 const trace:string[]=[],document={querySelectorAll:(selector:string)=>selector==='[data-inspector]'?tabs:selector==='[data-mode]'?[]:panels};
 const bind=new Function('document',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a).replace('export function','function'))+';return bindInspectorTabs;')(document);
 bind(()=>trace.push('after:'+panels.map(p=>p.hidden).join(',')),()=>trace.push('before:'+panels.map(p=>p.hidden).join(',')));
 (tabs[1] as unknown as {onclick:()=>void}).onclick();expect(trace).toEqual(['before:false,true','after:true,false']);
 const key=Object.assign(new Event('keydown',{cancelable:true}),{key:'ArrowLeft'});(tabs[1] as unknown as {onkeydown:(event:Event)=>void}).onkeydown(key);expect(key.defaultPrevented).toBe(true);expect(trace.slice(2)).toEqual(['before:true,false','after:false,true']);
});

test('the header mode switch and the inspector tabs change together from one selected section',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindInspectorTabs(');
 const node=(data:Record<string,string>,selected?:boolean)=>{const attrs=new Map<string,string>();if(selected!==undefined)attrs.set('aria-selected',String(selected));return {dataset:data,attrs,tabIndex:-1,hidden:false,setAttribute(k:string,v:string){attrs.set(k,v);},getAttribute(k:string){return attrs.get(k)??null;},focus(){}};};
 const tabs=['rig','playback','feedback'].map((name,i)=>node({inspector:name},i===0)),panels=['rig','playback','feedback'].map(name=>node({inspectorPanel:name})),modes=['rig','playback'].map(name=>node({mode:name}));
 const document={querySelectorAll:(selector:string)=>selector==='[data-inspector]'?tabs:selector==='[data-mode]'?modes:panels};
 const bind=new Function('document',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a).replace('export function','function'))+';return bindInspectorTabs;')(document);
 let changes=0;bind(()=>changes++);
 const pressed=()=>modes.map(m=>m.attrs.get('aria-pressed')),selected=()=>tabs.map(t=>t.attrs.get('aria-selected')),click=(item:object)=>(item as {onclick:()=>void}).onclick();
 expect(pressed()).toEqual(['true','false']);
 click(modes[1]!);expect(selected()).toEqual(['false','true','false']);expect(pressed()).toEqual(['false','true']);expect(panels.map(p=>p.hidden)).toEqual([true,false,true]);
 // Feedback is chosen in the inspector only; the header then shows neither mode pressed.
 click(tabs[2]!);expect(pressed()).toEqual(['false','false']);
 click(tabs[0]!);expect(pressed()).toEqual(['true','false']);expect(selected()).toEqual(['true','false','false']);
 const key=Object.assign(new Event('keydown',{cancelable:true}),{key:'ArrowRight'});(tabs[0] as unknown as {onkeydown:(event:Event)=>void}).onkeydown(key);expect(pressed()).toEqual(['false','true']);
 expect(changes).toBe(4);
});

test('a header toggle that is itself the section selector uses aria-pressed and no tab semantics',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindInspectorTabs(');
 const node=(data:Record<string,string>,pressed?:boolean)=>{const attrs=new Map<string,string>();if(pressed!==undefined)attrs.set('aria-pressed',String(pressed));return {dataset:data,attrs,tabIndex:-7,hidden:false,onkeydown:undefined as unknown,setAttribute(k:string,v:string){attrs.set(k,v);},getAttribute(k:string){return attrs.get(k)??null;},focus(){}};};
 const toggles=['rig','playback'].map((name,i)=>node({mode:name,inspector:name},i===0)),panels=['rig','playback'].map(name=>node({inspectorPanel:name}));
 const document={querySelectorAll:(selector:string)=>selector==='[data-inspector]'||selector==='[data-mode]'?toggles:panels};
 const bind=new Function('document',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a).replace('export function','function'))+';return bindInspectorTabs;')(document);
 let changes=0;bind(()=>changes++);(toggles[1] as unknown as {onclick:()=>void}).onclick();
 expect(toggles.map(t=>t.attrs.get('aria-pressed'))).toEqual(['false','true']);expect(toggles.some(t=>t.attrs.has('aria-selected'))).toBe(false);
 expect(panels.map(p=>p.hidden)).toEqual([true,false]);expect(toggles.map(t=>t.tabIndex)).toEqual([-7,-7]);expect(toggles.every(t=>t.onkeydown===undefined)).toBe(true);expect(changes).toBe(1);
});

import {bindLayerShortcuts,describeLayerToggles,layerShortcuts,textEntryFocused} from '../web/view-controls.ts';
/** A focusable element whose `closest` answers like the browser for the selectors the guard asks. */
function focusTarget(kind:'text'|'search'|'number'|'textarea'|'select'|'editable'|'checkbox'|'button'|'stage'){
 const input=['text','search','number','checkbox'].includes(kind)?{type:kind}:null;
 return {isContentEditable:kind==='editable',closest(selector:string){
  if(selector==='input')return input;
  if(selector.startsWith('textarea'))return kind==='textarea'||kind==='select'||kind==='editable'?this:null;
  return null;
 }};
}
function layerHost(){
 const changes:string[]=[],root=new EventTarget(),label=(id:string)=>({title:'',id});
 const inputs=Object.fromEntries(layerShortcuts.map(item=>{const owner=label(item.id);const input={id:item.id,checked:item.id==='layer-images',disabled:false,click(){this.checked=!this.checked;changes.push(item.id+':'+this.checked);},closest:(selector:string)=>selector==='label'?owner:null,owner};return [item.id,input];}));
 const host=Object.assign(root,{getElementById:(id:string)=>inputs[id]??null});
 const press=(key:string,target:unknown=focusTarget('stage'),extra:Record<string,unknown>={})=>{const event=Object.assign(new Event('keydown',{cancelable:true}),{key,repeat:false,ctrlKey:false,metaKey:false,altKey:false,...extra});Object.defineProperty(event,'target',{value:target});root.dispatchEvent(event);return event;};
 return {host,inputs,changes,press};
}

test('I, M and B toggle their actual layer checkbox; text entry, modifiers, repeats and disabled layers keep the key',()=>{
 const {host,inputs,changes,press}=layerHost();const dispose=bindLayerShortcuts(host as unknown as Document);
 expect(layerShortcuts.map(item=>[item.key,item.id])).toEqual([['i','layer-images'],['m','layer-mesh'],['b','layer-bones']]);
 expect(press('i').defaultPrevented).toBe(true);expect(inputs['layer-images']!.checked).toBe(false);
 press('M');expect(inputs['layer-mesh']!.checked).toBe(true);press('b',focusTarget('checkbox'));expect(inputs['layer-bones']!.checked).toBe(true);press('b',focusTarget('button'));expect(inputs['layer-bones']!.checked).toBe(false);
 expect(changes).toEqual(['layer-images:false','layer-mesh:true','layer-bones:true','layer-bones:false']);
 for(const kind of ['text','search','number','textarea','select','editable'] as const){const event=press('i',focusTarget(kind));expect(event.defaultPrevented).toBe(false);expect(textEntryFocused(focusTarget(kind))).toBe(true);}
 for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:true},{repeat:true}])press('m',focusTarget('stage'),extra);
 for(const key of [' ','Enter','ArrowLeft','x'])press(key);
 expect(changes.length).toBe(4);
 inputs['layer-mesh']!.disabled=true;expect(press('m').defaultPrevented).toBe(false);expect(inputs['layer-mesh']!.checked).toBe(true);
 dispose();press('i');expect(changes.length).toBe(4);
});

test('disabled layer toggles carry the footer reason as a tooltip; enabled ones name their key',()=>{
 const {host,inputs}=layerHost();inputs['layer-bones']!.disabled=true;describeLayerToggles(host,'No rig supplied');
 expect(layerShortcuts.map(item=>inputs[item.id]!.owner.title)).toEqual(['Images · key I','Mesh edges · key M','No rig supplied']);
});

test('the review page view bar holds the three layer toggles with matching shortcut attributes',async()=>{
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),bar=html.slice(html.indexOf('<div class="viewbar">'),html.indexOf('<div id="stage-layout"'));
 for(const item of layerShortcuts){const match=bar.match(new RegExp(`<label class="layer-toggle"[^>]*><input aria-keyshortcuts="([A-Z])" id="${item.id}"[^>]*><span>${item.label}</span>`));expect(match?.[1]).toBe(item.key.toUpperCase());}
 expect(html.match(/id="layer-(images|mesh|bones)"/g)?.length).toBe(3);
});

test('#279: view bar wraps without shrinking or clipping layer toggles and keeps refusal status out of flow',async()=>{
 const css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 const checkViewbarCss=(sheet:string)=>{
  const stripped=sheet.replace(/\/\*[\s\S]*?\*\//g,'');
  const rules=(sel:string)=>[...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter(m=>m[1]!.split(',').map(s=>s.trim()).includes(sel)).map(m=>m[2]!);
  const viewbar=rules('.viewbar'),layerToggles=rules('.viewbar>.layer-toggles'),refusal=rules('#stage-comment-refusal');
  const lastViewbar=viewbar.at(-1)??'',lastLayers=layerToggles.at(-1)??'',lastRefusal=refusal.at(-1)??'';
  const wraps=lastViewbar.includes('flex-wrap:wrap')&&!viewbar.some(r=>r.includes('flex-wrap:nowrap'));
  const layersUnclipped=lastLayers.includes('flex:none')&&!layerToggles.some(r=>r.includes('overflow:hidden')||/flex:\s*0\s+1/.test(r));
  const refusalOutOfFlow=lastRefusal.includes('position:absolute')&&lastRefusal.includes('clip-path:inset(50%)');
  return wraps&&layersUnclipped&&refusalOutOfFlow;
 };
 expect(checkViewbarCss(css)).toBe(true);
 // Planted pre-#279 rules must fail the gate.
 expect(checkViewbarCss(css.replace('.viewbar{flex-wrap:wrap;','.viewbar{flex-wrap:nowrap;'))).toBe(false);
 expect(checkViewbarCss(css.replace('.viewbar>.layer-toggles{flex:none}','.viewbar>.layer-toggles{flex:0 1 auto;overflow:hidden}'))).toBe(false);
 expect(checkViewbarCss(css.replaceAll('#stage-comment-refusal{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}','#stage-comment-refusal{flex:0 1 180px}'))).toBe(false);
});

test('#284: comment list CSS anchors below the view bar on both review and compare stylesheets; planted top:55px fails',async()=>{
 const styles=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 const compare=await readFile(new URL('../web/compare.css',import.meta.url),'utf8');
 const checkListAnchorCss=(sheet:string)=>{
  const stripped=sheet.replace(/\/\*[\s\S]*?\*\//g,'');
  const rules=(sel:string)=>[...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter(m=>m[1]!.split(',').map(s=>s.trim()).includes(sel)).map(m=>m[2]!);
  const viewbarAnchored=rules('.viewbar').some(r=>r.includes('anchor-name:--stage-comment-bar'))&&rules('.toolbar').some(r=>r.includes('anchor-name:--stage-comment-bar'));
  const listRules=rules('.stage-comment-list'),lastList=listRules.at(-1)??'';
  const listAnchored=lastList.includes('position-anchor:--stage-comment-bar')&&lastList.includes('top:calc(anchor(bottom,50px) + 5px)')&&!listRules.some(r=>/(?:^|;)top:\s*55px(?:;|$)/.test(r));
  return viewbarAnchored&&listAnchored;
 };
 expect(checkListAnchorCss(styles)).toBe(true);
 expect(checkListAnchorCss(compare)).toBe(true);
 expect(checkListAnchorCss(styles.replace('top:calc(anchor(bottom,50px) + 5px)','top:55px'))).toBe(false);
 expect(checkListAnchorCss(compare.replace('top:calc(anchor(bottom,50px) + 5px)','top:55px'))).toBe(false);
});

function rigFramingHarness(stage:PoseBounds|null,initialBounds:PoseBounds|null,factory= createRigViewportProvider) {
 const nodes=new Map<string,{clientWidth:number;clientHeight:number;hidden:boolean;checked:boolean;textContent:string;style:Record<string,string>}>();
 const node=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:575,clientHeight:436,hidden:false,checked:false,textContent:'',style:{}});return nodes.get(id)!;};
 let drawn=initialBounds,filtered=initialBounds,boundsReads=0,generation=0,selection:PoseBounds|null=null;
 let drawnFrame:PosedFrame|undefined={generation,order:[]};
 const newPlayer=()=>({slots:null as SlotFilter|null,get generation(){return generation;},
  bounds(this:{slots:SlotFilter|null}){boundsReads++;return this.slots===null?drawn:filtered;},renderer:{syncPixelRatio(){}}}) as unknown as RigPlayer;
 let player:RigPlayer|null=newPlayer(),assets={stage} as ModelAssets;
 const state=createViewportState();
 const host:RigViewportHost={
  el:<T extends HTMLElement=HTMLElement>(id:string)=>node(id) as unknown as T,
  player:()=>player,assets:()=>assets,referenceSize:()=>null,view:()=> 'rig',referenceGeneration:()=>1,
  parts:()=>({value:()=>selection?{slot:'lantern'}:null,bounds:()=>selection,frame:()=>drawnFrame}),
  text:(id,value)=>{node(id).textContent=value;},message:()=>{},redrawOverlay:()=>{},
 };
 const provider=factory(host,state),render=provider.render;
 // Replace only numeric DOM output. Camera math and physical root writes remain real.
 provider.render=controller=>render({...controller,renderNumericView:()=>{},renderCameraControls:()=>{}});
 const controller=createViewportController(provider,state);
 return {provider,controller,state,node,newPlayer,boundsReads:()=>boundsReads,
  source:()=>({player,assets}),use:(source:{player:RigPlayer|null;assets:ModelAssets})=>{player=source.player;assets=source.assets;drawnFrame={generation,order:[]};},
  pose:(value:PoseBounds|null)=>{drawn=value;generation++;},select:(value:PoseBounds|null)=>{selection=value;},
  render:(ready=true)=>{drawnFrame=ready?{generation,order:[]}:undefined;},
  filter:(value:PoseBounds|null)=>{filtered=value;player!.slots=['lantern'];generation++;},
  whole:()=>{player!.slots=null;generation++;},
 };
}

test('#496 one framing box encloses declared stage and initial drawn bounds in render, geometry and layout key',()=>{
 const h=rigFramingHarness({x:0,y:0,width:80,height:80},{x:-11,y:-11,width:22,height:22});
 const box={x:-11,y:-11,width:91,height:91};
 expect(h.provider.geometry('rig')?.box).toEqual(box);
 expect(h.provider.layoutKey()).toContain(JSON.stringify(box));
 h.controller.fitCamera();
 expect(h.state.displayedCenter).toEqual({x:34.5,y:34.5});
 const scale=Math.min((575-28)/91,(436-58)/91);
 expect(h.state.rigScale).toBe(scale);
 const top=parseFloat(h.node('rig-root').style.top!);
 expect(top-11*scale).toBeGreaterThanOrEqual(29);
 expect(top+11*scale).toBeLessThanOrEqual(436-29);
 expect(h.boundsReads()).toBe(1);
});

async function singleControlReadbackHarness(h:ReturnType<typeof rigFramingHarness>) {
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 const start=source.indexOf('function controlState()'),end=source.indexOf('async function inspectControlTime(',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const script=`function open(viewport,source){
  const {player,assets}=source,{paneFrame,updateCamera,fitActiveCamera,fitCamera,setCameraSync,numericView}=viewport;
  const parts=null,appearance=null,referenceSize=null,animation='idle',time=.25,duration=1,playing=false,video=null,persistence=null;
  const layers={images:true,mesh:false,bones:false},data={},saving=false,stripBusy=false;
  let seekingControl=false;
  const el=()=>({dataset:{orientation:'horizontal'}}),canRepeatIdle=()=>false,localDraft=()=>false;
  const layoutEligibility=()=>null,controlComparison=()=>({});
  ${source.slice(start,end)}
  return {observe:controlState,apply:command=>applyControl(command,new AbortController().signal)};
 }`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 return new Function('viewport','source',code+';return open(viewport,source);')(h.controller,h.source()) as {
  observe():import('../src/control.ts').ControlInspection;
  apply(command:import('../src/control.ts').ControlCommand):Promise<void>;
 };
}

test('#496 actual single control readback reports zero fitted pan and replays expanded-frame cameras without drift',async()=>{
 const h=rigFramingHarness({x:0,y:0,width:80,height:80},{x:-11,y:-11,width:22,height:22});
 const app=await singleControlReadbackHarness(h);
 h.controller.fitActiveCamera('rig');
 expect(h.state.cameraCenter).toEqual({x:34.5,y:34.5});
 expect(app.observe().cameras.rig!.pan).toEqual({x:0,y:0});
 for(const camera of [{zoom:1,pan:{x:0,y:0}},{zoom:1.75,pan:{x:47,y:-23}},{zoom:.8,pan:{x:-35,y:14}}]){
  await app.apply({type:'camera',target:'rig',...camera});
  const expected=h.controller.numericView().cameras.rig!;
  for(let replay=0;replay<3;replay++){
   const readback=app.observe();
   expect(readback.cameras.rig!.zoom).toBe(camera.zoom);
   expect(readback.cameras.rig!.pan.x).toBeCloseTo(camera.pan.x,10);
   expect(readback.cameras.rig!.pan.y).toBeCloseTo(camera.pan.y,10);
   expect(readback.animation).toBe('idle');expect(readback.time).toBe(.25);
   await app.apply({type:'camera',target:'rig',...readback.cameras.rig!});
   const actual=h.controller.numericView().cameras.rig!;
   expect(actual.center.x).toBeCloseTo(expected.center.x,10);
   expect(actual.center.y).toBeCloseTo(expected.center.y,10);
   expect(actual.zoom).toBe(expected.zoom);
   expect(actual.visible.width).toBeCloseTo(expected.visible.width,10);
   expect(actual.visible.height).toBeCloseTo(expected.visible.height,10);
  }
 }
});

test('#496 actual single control readback keeps no-stage live pose/filter and missing-player fallbacks',async()=>{
 const h=rigFramingHarness(null,{x:-20,y:-12,width:28,height:30}),app=await singleControlReadbackHarness(h);
 for(const bounds of [{x:-20,y:-12,width:28,height:30},{x:12,y:-40,width:40,height:60}]){
  h.pose(bounds);h.controller.fitActiveCamera('rig');
  expect(app.observe().cameras.rig!.pan).toEqual({x:0,y:0});
  h.filter({x:bounds.x+1,y:bounds.y+2,width:10,height:12});
  h.controller.fitCamera();
  const center={x:bounds.x+6,y:bounds.y+8},before=h.controller.numericView().cameras.rig!;
  const readback=app.observe().cameras.rig!;
  expect(readback.pan.x).toBeCloseTo((center.x-h.state.cameraCenter!.x)*h.state.rigScale,10);
  expect(readback.pan.y).toBeCloseTo((h.state.cameraCenter!.y-center.y)*h.state.rigScale,10);
  await app.apply({type:'camera',target:'rig',...readback});
  const after=h.controller.numericView().cameras.rig!;
  expect(after.center.x).toBeCloseTo(before.center.x,10);
  expect(after.center.y).toBeCloseTo(before.center.y,10);
  expect(after.visible.width).toBeCloseTo(before.visible.width,10);
  expect(after.visible.height).toBeCloseTo(before.visible.height,10);
  h.whole();
 }
 for(const stage of [null,{x:0,y:0,width:80,height:80}]){
  const absent=rigFramingHarness(stage,null);
  absent.use({...absent.source(),player:null});
  absent.state.cameraCenter={x:31,y:29};absent.state.zoom=2;absent.state.rigScale=2;
  const missing=await singleControlReadbackHarness(absent),observed=missing.observe();
  expect(observed.cameras.rig).toEqual({zoom:1,pan:stage?{x:18,y:-22}:{x:0,y:0}});
  expect(observed.view!.cameras.rig).toBeNull();expect(observed.capabilities.camera).toBe(false);
  await expect(missing.apply({type:'camera',target:'rig',zoom:1,pan:{x:0,y:0}})).rejects.toThrow('CONTROL_CAMERA_UNAVAILABLE');
 }
});

test('#496 absent stage preserves live pose/filter bounds, layout and camera fallback',()=>{
 const actual={x:-12,y:-15,width:24,height:30},h=rigFramingHarness(null,actual);
 expect(h.provider.geometry('rig')?.box).toBe(actual);
 h.controller.fitCamera();
 const key=h.provider.layoutKey(),scale=h.state.rigScale;
 const moved={x:-30,y:-40,width:60,height:80};h.pose(moved);
 expect(h.provider.geometry('rig')?.box).toBe(moved);
 expect(h.provider.layoutKey()).not.toBe(key);
 h.controller.fitCamera();expect(h.state.rigScale).not.toBe(scale);
 const filtered={x:-4,y:-5,width:8,height:10};h.filter(filtered);
 expect(h.provider.geometry('rig')?.box).toBe(filtered);
 h.controller.fitCamera();expect(h.state.displayedCenter).toEqual({x:0,y:0});
 h.whole();expect(h.provider.geometry('rig')?.box).toBe(moved);
 h.pose(null);expect(h.provider.geometry('rig')).toBeNull();
});

test('#496 degenerate stage/drawn bounds never seal an empty frame',()=>{
 for(const invalid of [null,{x:0,y:0,width:0,height:20},{x:0,y:0,width:20,height:0},{x:NaN,y:0,width:20,height:20},{x:0,y:0,width:Infinity,height:20}]){
  const pending=rigFramingHarness({x:0,y:0,width:80,height:80},invalid);
  expect(pending.provider.geometry('rig')?.box).toEqual({x:0,y:0,width:80,height:80});
  pending.pose({x:-10,y:-10,width:20,height:20});
  pending.render();
  expect(pending.provider.geometry('rig')?.box).toEqual({x:-10,y:-10,width:90,height:90});
  const absent=rigFramingHarness(invalid,null);
  expect(absent.provider.geometry('rig')).toBeNull();
  absent.pose({x:-10,y:-10,width:20,height:20});
  expect(absent.provider.geometry('rig')?.box).toEqual({x:-10,y:-10,width:20,height:20});
 }
});

test('#496 stage basis waits for a successful coherent unfiltered draw, then ignores later selection and animation',()=>{
 const stage={x:0,y:0,width:80,height:80},h=rigFramingHarness(stage,{x:-11,y:-11,width:22,height:22});
 h.render(false);
 expect(h.provider.geometry('rig')?.box).toEqual(stage);
 expect(h.boundsReads()).toBe(0);
 h.render();h.pose({x:-12,y:-12,width:24,height:24});
 expect(h.provider.geometry('rig')?.box).toEqual(stage);
 h.filter({x:-2,y:-2,width:4,height:4});h.render();
 expect(h.provider.geometry('rig')?.box).toEqual(stage);
 expect(h.boundsReads()).toBe(0);
 h.whole();h.render();
 expect(h.provider.geometry('rig')?.box).toEqual({x:-12,y:-12,width:92,height:92});
 h.filter({x:1,y:1,width:1,height:1});h.select({x:1,y:1,width:1,height:1});h.render();
 expect(h.provider.geometry('rig')?.box).toEqual({x:-12,y:-12,width:92,height:92});
 expect(h.boundsReads()).toBe(1);
});

test('#496 changing animation bounds keeps camera/layout/root stable; new players/assets invalidate the frame',()=>{
 const h=rigFramingHarness({x:0,y:0,width:80,height:80},{x:-11,y:-11,width:22,height:22});
 h.controller.fitCamera();
 const original=h.source(),box=h.provider.geometry('rig')!.box,key=h.provider.layoutKey();
 const view=h.controller.numericView(),root={...h.node('rig-root').style};
 for(const pose of [{x:-200,y:-300,width:400,height:600},{x:10,y:20,width:1,height:1},null]){
  h.pose(pose);h.controller.fitCamera();
  expect(h.provider.geometry('rig')?.box).toEqual(box);
  expect(h.provider.layoutKey()).toBe(key);
  expect(h.controller.numericView()).toEqual(view);
  expect(h.node('rig-root').style).toEqual(root);
 }
 expect(h.boundsReads()).toBe(1);
 h.pose({x:-30,y:-20,width:60,height:40});
 h.use({player:h.newPlayer(),assets:original.assets});
 expect(h.provider.geometry('rig')?.box).toEqual({x:-30,y:-20,width:110,height:100});
 h.use(original);
 expect(h.provider.geometry('rig')?.box).toEqual(box);
 h.use({player:original.player,assets:{stage:{x:0,y:0,width:100,height:100}} as ModelAssets});
 expect(h.provider.geometry('rig')?.box).toEqual({x:-30,y:-20,width:130,height:120});
});

test('#496 explicit camera and saved numeric coverage survive the expanded basis; selection Fit retains live part bounds',()=>{
 const stage={x:0,y:0,width:80,height:80},h=rigFramingHarness(stage,{x:-11,y:-11,width:22,height:22});
 const oldFrame=cameraFrame('world',stage,575,436,28,58)!;
 const saved=numericCamera('world',{x:17,y:23},2,oldFrame.baseScale*2,575,436)!;
 h.state.cameraRestoring=true;
 h.state.cameraCenter={...saved.center};
 const frame=h.controller.paneFrame('rig')!;
 h.state.zoom=restoredZoom(saved,frame.baseScale,575,436);
 h.controller.fitCamera();
 const restored=h.controller.numericView().cameras.rig!;
 expect(restored.center).toEqual(saved.center);
 expect(restored.visible.width).toBeCloseTo(saved.visible.width,10);
 expect(restored.visible.height).toBeCloseTo(saved.visible.height,10);
 const explicit={center:{...h.state.cameraCenter},zoom:h.state.zoom};
 h.pose({x:-200,y:-300,width:400,height:600});h.controller.fitCamera();
 expect({center:h.state.cameraCenter,zoom:h.state.zoom}).toEqual(explicit);
 h.state.cameraRestoring=false;
 h.select({x:-10,y:-10,width:30,height:40});h.controller.fitActiveCamera('rig');
 expect(h.state.cameraCenter!.x).toBeCloseTo(5,10);
 expect(h.state.cameraCenter!.y).toBeCloseTo(10,10);
 expect(h.state.rigScale).toBeCloseTo(Math.min((575-28)/30,(436-58)/40),10);
 h.select(null);h.controller.fitActiveCamera('rig');
 expect(h.state.zoom).toBe(1);
 expect(h.state.cameraCenter).toEqual({x:34.5,y:34.5});
});

test('#496 semantic window uses the shared stable frame through pose changes and publication rollback',async()=>{
 const source=await readFile(new URL('../web/job-session.ts',import.meta.url),'utf8');
 const start=source.indexOf('    function redrawOverlay('),end=source.indexOf('const canonicalControls',start);
 expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
 const script=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));
 const construct=new Function('deps',`const {el,current,reference,setText,notice,jobWindowRefusal,viewportState,createRigViewportProvider,overlays,layers,selectedPart}=deps;${script}return provider;`);
 let overlayReads=0;
 const h=rigFramingHarness({x:0,y:0,width:80,height:80},{x:-11,y:-11,width:22,height:22},(host,state)=>{
  const current={get player(){return host.player();},get assets(){return host.assets();},get inspection(){return host.parts();},
   rigRoot:host.el('rig-root'),metadata:{feedbackCatalog:{bones:[]}},display:{publication:{generation:1}}};
  // This numeric host has no Canvas2D surface; run the real overlay's unavailable-context path.
  const canvas={style:{pointerEvents:''},getContext:()=>{overlayReads++;return null;}} as unknown as HTMLCanvasElement;
  const overlays=new WeakMap([[current,new RigOverlays({canvas,rigRoot:current.rigRoot})]]);
  return construct({el:host.el,current,reference:host.referenceSize,setText:host.text,notice:{textContent:''},
   jobWindowRefusal:String,viewportState:state,createRigViewportProvider,overlays,
   layers:{images:true,mesh:false,bones:false,meshOpacity:.65},selectedPart:'',
  });
 });
 h.controller.fitCamera();
 const original=h.source(),box=h.provider.geometry('rig')!.box,key=h.provider.layoutKey(),view=h.controller.numericView();
 h.pose({x:-300,y:-400,width:600,height:800});h.controller.fitCamera();
 expect(h.provider.layoutKey()).toBe(key);
 expect(h.controller.numericView()).toEqual(view);
 h.use({player:h.newPlayer(),assets:{stage:{x:0,y:0,width:40,height:40}} as ModelAssets});
 expect(h.provider.geometry('rig')?.box).toEqual({x:-300,y:-400,width:600,height:800});
 h.use(original);h.controller.fitCamera();
 expect(h.provider.geometry('rig')?.box).toEqual(box);
 expect(h.controller.numericView()).toEqual(view);
 expect(overlayReads).toBeGreaterThan(0);
});


test('#658 literal actions preserve properties, handler identity, native Event/this and optional disabled setter order',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
 class Action extends EventTarget {
  writes:string[]=[];values:Record<string,unknown>={disabled:false};
  private handler:((this:EventTarget,event?:Event)=>void)|null=null;
  get type(){return this.values.type;}set type(value){this.writes.push('type');this.values.type=value;}
  get textContent(){return this.values.textContent;}set textContent(value){this.writes.push('textContent');this.values.textContent=value;}
  get disabled(){return this.values.disabled;}set disabled(value){this.writes.push('disabled');this.values.disabled=value;}
  get onclick(){return this.handler;}set onclick(value:((this:EventTarget,event?:Event)=>void)|null){this.writes.push('onclick');this.values.onclick=value;this.handler=value;if(value)this.addEventListener('click',value);}
  append(..._children:unknown[]){}
 }
 const created:Action[]=[];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(tag:string){expect(tag).toBe('button');const value=new Action();created.push(value);return value;}}});
 try{
  const seen:{receiver:unknown;event:unknown}[]=[];
  function click(this:EventTarget,event?:Event){seen.push({receiver:this,event});event?.preventDefault();}
  const actions=[actionButton('<literal> & action',click),actionButton('undefined',click,undefined),actionButton('enabled',click,false),actionButton('disabled',click,true)];
  expect(actions).toHaveLength(created.length);
  for(const [index,value] of actions.entries())expect(Object.is(value,created[index])).toBe(true);
  expect(actions.map(value=>value.type)).toEqual(['button','button','button','button']);
  expect(actions.map(value=>value.textContent)).toEqual(['<literal> & action','undefined','enabled','disabled']);
  expect(actions.map(value=>value.disabled)).toEqual([false,false,false,true]);
  expect(created.map(value=>value.writes)).toEqual([
   ['type','textContent','onclick'],['type','textContent','onclick'],
   ['type','textContent','disabled','onclick'],['type','textContent','disabled','onclick'],
  ]);
  for(const value of created)expect(value.onclick).toBe(click);
  const event=new Event('click',{cancelable:true});
  expect(actions[0]!.dispatchEvent(event)).toBe(false);
  expect(seen).toEqual([{receiver:actions[0],event}]);
  expect(event.defaultPrevented).toBe(true);
  created[1]!.onclick!.call(created[1]!);
  expect(seen[1]).toEqual({receiver:actions[1],event:undefined});
 }finally{if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');}
});


test('#659 labelledControl preserves literal trailing space and supplied Node identity in both orders',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
 const created:{tag:string;children:unknown[]}[]=[];
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement(tag:string){
  const element={tag,children:[] as unknown[],append(...children:unknown[]){this.children.push(...children);}};
  created.push(element);return element;
 }}});
 try{
  const control={} as HTMLElement,label={} as Node;
  const literal=labelledControl('Kind ',control);
  const nodeFirst=labelledControl(label,control);
  const controlFirst=labelledControl(label,control,true);
  expect(Object.is(literal,created[0])).toBe(true);
  expect(Object.is(nodeFirst,created[1])).toBe(true);
  expect(Object.is(controlFirst,created[2])).toBe(true);
  expect(created.map(item=>item.tag)).toEqual(['label','label','label']);
  expect(created[0]!.children).toEqual(['Kind ',control]);
  expect(created[0]!.children[1]).toBe(control);
  expect(created[1]!.children[0]).toBe(label);expect(created[1]!.children[1]).toBe(control);
  expect(created[2]!.children[0]).toBe(control);expect(created[2]!.children[1]).toBe(label);
 }finally{if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');}
});


test('#666 outer select, restore and disposal keep callback timing and current handler ownership',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindInspectorTabs(');
 const node=(id:string)=>{const attrs=new Map([['aria-selected',String(id==='rig')]]);return {dataset:{inspector:id},tabIndex:0,onclick:null as unknown,onkeydown:null as unknown,setAttribute(k:string,v:string){attrs.set(k,v);},getAttribute(k:string){return attrs.get(k)??null;},focus(){}};};
 const tabs=['rig','playback','feedback'].map(node),panels=tabs.map(t=>({dataset:{inspectorPanel:t.dataset.inspector},hidden:t.dataset.inspector!=='rig'}));
 const mode={dataset:{mode:'playback'},onclick:null as unknown,pressed:'',setAttribute(_k:string,v:string){this.pressed=v;}};
 const document={querySelectorAll:(selector:string)=>selector==='[data-inspector]'?tabs:selector==='[data-mode]'?[mode]:panels};
 const bind=new Function('document',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a).replace('export function','function'))+';return bindInspectorTabs;')(document);
 const trace:string[]=[],binding=bind(()=>trace.push('after:'+panels.map(p=>p.hidden)),()=>trace.push('before:'+panels.map(p=>p.hidden)));
 binding.select('playback');expect(trace).toEqual(['before:false,true,true','after:true,false,true']);expect(binding.state()).toBe('playback');
 binding.select('playback');expect(trace.length).toBe(4); // Outer same-tab clicks still notify.
 binding.restore('feedback');expect(trace.length).toBe(4);expect(binding.state()).toBe('feedback');expect(mode.pressed).toBe('false');expect(panels.map(p=>p.hidden)).toEqual([true,true,false]);
 binding.restore('missing');expect(binding.state()).toBe('feedback');
 const next=bind(()=>trace.push('next'));binding.dispose();(tabs[0]!.onclick as ()=>void)();expect(trace.at(-1)).toBe('next');
 next.dispose();expect(tabs.every(t=>t.onclick===null&&t.onkeydown===null)).toBe(true);expect(mode.onclick).toBeNull();
 next.select('playback');expect(panels.map(p=>p.hidden)).toEqual([false,true,true]);
});
