import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature} from '../web/camera-view.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import {test,expect} from 'bun:test';
import {stageOrientation,syncStageLayout,panCenter,idleAvailable,initialIdleAnimation,themePreference,automaticIdlePreview} from '../web/view-controls.ts';
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
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('async function inspectControlTime('),end=source.indexOf('function numericView(',begin);if(begin<0||end<begin)throw new Error('single decoded seek boundary missing');
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
 const script=`function open(video,hasPlayer){let time=.1,duration=2,controlledVideoSample=null,axisInspection=false;const player=hasPlayer?{time:.1,seek(value){this.time=value;},draw(){}}:null;let draws=0;const drawRig=action=>{action();draws++;},renderSequenceFrame=()=>{},renderTransport=()=>{},message=()=>{},errorText=error=>error instanceof Error?error.message:String(error);${functions};return {seek:target=>inspectControlTime(target,new AbortController().signal),state:()=>({time,pose:player?.time??null,draws}),abort:()=>{const controller=new AbortController();controller.abort();return inspectControlTime(.6,controller.signal);}};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type App={seek(value:number):Promise<void>;state():{time:number;pose:number|null;draws:number};abort():Promise<void>};
 for(const hasPlayer of [true,false]){
  const media=new Media(),app=new Function('video','hasPlayer',code+';return open(video,hasPlayer);')(media,hasPlayer) as App;
  await app.seek(.3);expect(app.state()).toMatchObject({time:.25,pose:hasPlayer ? .25 : null});expect(media.currentTime).toBe(.3);expect(media.pending).toBe(0);
  const requests=media.requests;await app.seek(.3);expect(media.requests).toBe(requests);expect(app.state().time).toBe(.25);expect(app.state().pose).toBe(hasPlayer ? .25 : null);
  await expect(app.seek(1)).rejects.toThrow('CONTROL_TIME_OUTSIDE_DOMAIN');expect(media.currentTime).toBe(.3);expect(app.state()).toMatchObject({time:.25,pose:hasPlayer ? .25 : null});expect(media.pending).toBe(0);
  await expect(app.abort()).rejects.toThrow('CONTROL_SUPERSEDED');expect(media.currentTime).toBe(.3);
  await app.seek(.75);expect(app.state()).toMatchObject({time:.75,pose:hasPlayer ? .75 : null});expect(media.pending).toBe(0);
 }
 // Source-only readback must use the acknowledged actual sample, not the
 // browser's requested currentTime (which can be between decoded frames).
 const observe=source.slice(source.indexOf('function controlState()'),source.indexOf('async function applyControl('));expect(observe).toContain('time:player?.time??time,');expect(observe).not.toContain('video?.currentTime');
});

test('actual single camera adapters synchronize normalized views by default, then preserve independent panes and active toolbar behavior',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('function paneFrame('),end=source.indexOf('function bind():',begin);if(begin<0||end<begin)throw new Error('camera adapter missing');
 const script=`function open(deps){const {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}=deps;let zoom=1,referenceZoom=1,cameraCenter=null,referenceCenter=null,cameraSync=true,activeCamera='rig';let selected=null,selectedBounds=null;const statuses=[];const parts={value:()=>selected,bounds:()=>selectedBounds},message=(value,error=false)=>{statuses.push({value,error});};const cameraFrames={},referenceSize={width:1920,height:1080},player={},assets={stage:{x:-300,y:80,width:200,height:600}};let fits=0;const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{clientWidth:id.startsWith('rig')?600:300,clientHeight:id.startsWith('rig')?400:800,hidden:false,checked:true,textContent:''});return nodes.get(id);};const workspace=null;const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},fitCamera=()=>{fits++;};${source.slice(begin,end)};return {edge:()=>{referenceSize.width=2*Number.MAX_SAFE_INTEGER-1000;referenceCenter=null;},wheel:zoomViewport,pan:panCamera,sync:setCameraSync,zoom:zoomCamera,fit:fitActiveCamera,part:(value,bounds)=>{selected=value;selectedBounds=bounds;},status:()=>statuses.at(-1),hide:target=>{el(target+'-pane').hidden=true;},state:()=>({sync:cameraSync,active:activeCamera,rig:{zoom,center:cameraCenter},reference:{zoom:referenceZoom,center:referenceCenter},rigSignature:cameraSignature(paneCamera('rig'),paneFrame('rig',true)),referenceSignature:cameraSignature(paneCamera('reference'),paneFrame('reference',true))})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={sync:boolean;active:string;rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};rigSignature:{zoom:number;pan:{x:number;y:number}};referenceSignature:{zoom:number;pan:{x:number;y:number}}};
 const app=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as {edge():void;wheel(target:string,delta:number):void;pan(target:string,dx:number,dy:number):void;sync(value:boolean):void;zoom(value:number):void;fit(target?:string):void;part(value:unknown,bounds:unknown):void;status():{value:string;error:boolean}|undefined;hide(target:string):void;state():State};
 app.wheel('reference',-1);expect(app.state()).toMatchObject({sync:true,active:'reference',rig:{zoom:1.1},reference:{zoom:1.1}});
 app.pan('rig',120,60);expect(app.state().rigSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.y).toBeCloseTo(.15,12);expect(app.state().rig.center!.y).toBeGreaterThan(380);expect(app.state().reference.center!.y).toBeLessThan(540);
 app.sync(false);const prior=app.state().rig;app.wheel('reference',-1);app.pan('reference',30,-40);expect(app.state().rig).toEqual(prior);const ref=app.state().reference;app.zoom(1.25);expect(app.state().reference.zoom).toBeCloseTo(ref.zoom*1.25,12);expect(app.state().rig).toEqual(prior);
 app.sync(true);expect(app.state().rigSignature.zoom).toBe(app.state().referenceSignature.zoom);expect(app.state().rigSignature.pan.x).toBeCloseTo(app.state().referenceSignature.pan.x,12);app.fit();expect(app.state().rigSignature.pan).toEqual({x:0,y:0});expect(app.state().referenceSignature.pan).toEqual({x:0,y:0});
 app.sync(false);app.hide('reference');const hidden=app.state().reference;app.wheel('rig',-1);expect(app.state().reference).toEqual(hidden);for(let n=0;n<100;n++)app.wheel('rig',-1);expect(app.state().rig.zoom).toBe(8);for(let n=0;n<100;n++)app.wheel('rig',1);expect(app.state().rig.zoom).toBe(.25);
 const selected=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as typeof app;selected.part({side:'single',slot:'mesh',mode:'context'},{x:-160,y:200,width:20,height:80});selected.fit('rig');expect(selected.state().rig.center!.x).toBeCloseTo(-150,10);expect(selected.state().rig.center!.y).toBeCloseTo(240,10);expect(selected.state().referenceSignature.pan.x).toBeCloseTo(selected.state().rigSignature.pan.x,10);selected.sync(false);const selectedRef=selected.state().reference;selected.part({side:'single',slot:'mesh',mode:'solo'},{x:-100,y:300,width:40,height:100});selected.fit('rig');expect(selected.state().reference).toEqual(selectedRef);const absent=selected.state();selected.part({side:'single',slot:'hidden',mode:'solo'},null);selected.fit('rig');expect(selected.state()).toEqual(absent);expect(selected.status()).toEqual({value:'PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',error:true});const refusal=selected.status();selected.zoom(1.1);expect(selected.status()).toEqual(refusal);const priorFailure=selected.state();selected.part({side:'single',slot:'extreme',mode:'solo'},{x:1e20,y:300,width:40,height:100});expect(()=>selected.fit('rig')).toThrow('VIEW_CAMERA_RANGE');expect(selected.state()).toEqual(priorFailure);expect(selected.status()).toEqual(refusal);selected.part({side:'single',slot:'mesh',mode:'solo'},{x:-100,y:300,width:40,height:100});selected.fit('rig');expect(selected.status()).toEqual({value:'Selected slot fitted.',error:false});
 const overflow=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature}) as typeof app;overflow.edge();const before=overflow.state();expect(()=>overflow.pan('rig',-65536,0)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(before);overflow.sync(false);overflow.pan('rig',-65536,0);const independent=overflow.state();expect(()=>overflow.sync(true)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(independent);
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
 const functions=slice('function unionBounds(','async function loadSide(')+slice('function sharedBox(','function redrawOverlays(')+slice('async function applyControl(','function numericView(')+slice('function numericView(','function renderNumericView(')+slice('async function restoreInspection(','async function setupPersistence(');
 const script=`function open(deps){const {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}=deps;
 const cameras={a:{zoom:1,center:null},b:{zoom:1,center:null},reference:{zoom:1,center:null}},cameraFrames={},rigScales={a:1,b:1};let cameraSync=true,activeCamera='a',cameraRestoring=false,cameraLayout='',idleHeld=true,trace=null,seeking=false;let selected=null,selectedBounds=null;const statuses=[];const parts={value:()=>selected,bounds:()=>selectedBounds,validate(){},select(value){selected=value;}},message=(value,error=false)=>{statuses.push({value,error});};const video={videoWidth:1920,videoHeight:1080,style:{},muted:true},players={a:{renderer:{syncPixelRatio(){}}},b:{renderer:{syncPixelRatio(){}}}},assets={a:{stage:{x:-300,y:80,width:200,height:600}},b:{stage:{x:-200,y:90,width:300,height:580}}};const nodes=new Map();const el=id=>{if(!nodes.has(id)){const size=id.startsWith('a-')?[600,400]:id.startsWith('b-')?[400,600]:[300,800];nodes.set(id,{clientWidth:size[0],clientHeight:size[1],style:{},dataset:{},checked:true,textContent:''});}return nodes.get(id);};const workspace=null;const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},redrawOverlays=()=>{},renderNumericView=()=>{},stop=()=>{},captureInputs=()=>({}),restoreInputs=()=>{},appearance=null,layers={images:true,mesh:false,bones:false},document={querySelectorAll:()=>[]},domain={start:0,end:2},data={animation:'idle',reference:{sha256:'reference'}};let saving=false,stripBusy=false;const localDraft=()=>false,requireCommonTime=()=>{};async function seekTo(time){trace={reference:time};}const inspectionBookmark=()=>({animation:'idle',time:null,theme:'dark',layers:{images:true,meshes:false,bones:false},selection:{reference:'reference'},view:numericView()});
 ${functions};fit();return {edge:()=>{video.videoWidth=2*Number.MAX_SAFE_INTEGER-1000;cameras.reference.center=null;},pan:panCamera,zoom:zoomCamera,sync:setCameraSync,fit:fitActiveCamera,part:(value,bounds)=>{selected=value;selectedBounds=bounds;},status:()=>statuses.at(-1),remote:command=>applyControl(command,new AbortController().signal),restore:value=>restoreInspection(value,new AbortController().signal),bookmark:inspectionBookmark,reflow:(width,height)=>{el('a-viewport').clientWidth=width;el('b-viewport').clientHeight=height;fit();},state:()=>({view:numericView(),scales:{...rigScales},referenceTransform:video.style.transform,positions:{a:{...el('a-root').style},b:{...el('b-root').style}}}),signature:target=>cameraSignature(cameras[target],paneFrame(target))};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={view:import('../src/control.ts').ControlView;scales:{a:number;b:number};referenceTransform:string;positions:{a:{left:string;top:string};b:{left:string;top:string}}};
 const app=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}) as {edge():void;pan(target:string,dx:number,dy:number):void;zoom(factor:number,target:string):void;sync(value:boolean):void;fit(target?:string):void;part(value:unknown,bounds:unknown):void;status():{value:string;error:boolean}|undefined;remote(command:unknown):Promise<void>;restore(value:unknown):Promise<void>;bookmark():{view:State['view']};reflow(width:number,height:number):void;state():State;signature(target:string):{zoom:number;pan:{x:number;y:number}}};
 app.pan('reference',60,120);for(const target of ['a','b']){expect(app.signature(target).pan.x).toBeCloseTo(.2,12);expect(app.signature(target).pan.y).toBeCloseTo(.15,12);}expect(app.state().scales.a).not.toBe(app.state().scales.b);
 app.sync(false);const frozen=structuredClone(app.state().view.cameras);app.pan('b',40,-60);expect(app.state().view.cameras.a).toEqual(frozen.a);expect(app.state().view.cameras.reference).toEqual(frozen.reference);expect(app.state().view.cameras.b).not.toEqual(frozen.b);
 await app.remote({type:'camera',target:'a',zoom:2,pan:{x:120,y:80}});expect(app.signature('a').pan.x).toBeCloseTo(.2,12);expect(app.signature('b').zoom).toBe(1);const priorReference=app.state().view.cameras.reference;
 await app.remote({type:'camera',target:'rig',zoom:3,pan:{x:60,y:40}});expect(app.signature('a').zoom).toBe(3);expect(app.signature('b').zoom).toBe(3);expect(app.signature('a').pan.x).toBeCloseTo(app.signature('b').pan.x,12);expect(app.state().view.cameras.reference).toEqual(priorReference);
 app.pan('b',80,30);const bookmark=app.bookmark(),legacy={...bookmark,view:{...bookmark.view}};delete legacy.view.cameraSync;delete legacy.view.activeCamera;
 app.sync(true);expect(app.state().view.activeCamera).toBe('b');for(const target of ['a','reference'])expect(app.signature(target).pan.x).toBeCloseTo(app.signature('b').pan.x,12);
 await app.restore(legacy);expect(app.state().view.cameraSync).toBe(false);for(const target of ['a','b','reference'] as const){expect(app.state().view.cameras[target]!.center.x).toBeCloseTo(bookmark.view.cameras[target]!.center.x,10);expect(app.state().view.cameras[target]!.center.y).toBeCloseTo(bookmark.view.cameras[target]!.center.y,10);expect(app.state().view.cameras[target]!.zoom).toBeCloseTo(bookmark.view.cameras[target]!.zoom,10);}
 app.part({side:'b',slot:'mesh',mode:'context'},{x:-150,y:200,width:30,height:90});app.sync(false);const fixedA=structuredClone(app.state().view.cameras.a),fixedRef=structuredClone(app.state().view.cameras.reference);app.fit('b');expect(app.state().view.cameras.b!.center.x).toBeCloseTo(-135,10);expect(app.state().view.cameras.b!.center.y).toBeCloseTo(245,10);expect(app.state().view.cameras.a).toEqual(fixedA);expect(app.state().view.cameras.reference).toEqual(fixedRef);app.sync(true);app.fit('b');expect(app.signature('a').pan.x).toBeCloseTo(app.signature('b').pan.x,10);expect(app.signature('reference').pan.y).toBeCloseTo(app.signature('b').pan.y,10);app.part({side:'b',slot:'hidden',mode:'solo'},null);const noBounds=app.state();app.fit('b');expect(app.state()).toEqual(noBounds);expect(app.status()).toEqual({value:'PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',error:true});const refusal=app.status();app.zoom(1.1,'b');expect(app.status()).toEqual(refusal);const failedState=app.state();app.part({side:'b',slot:'extreme',mode:'solo'},{x:1e20,y:200,width:30,height:90});expect(()=>app.fit('b')).toThrow('VIEW_CAMERA_RANGE');expect(app.state()).toEqual(failedState);expect(app.status()).toEqual(refusal);app.part({side:'b',slot:'mesh',mode:'solo'},{x:-150,y:200,width:30,height:90});app.fit('b');expect(app.status()).toEqual({value:'Selected slot fitted.',error:false});app.part(null,null);
 const divergent=app.bookmark();divergent.view.cameraSync=true;await app.restore(divergent);const heldCameras=structuredClone(app.state().view.cameras);app.reflow(641,617);for(const target of ['a','b','reference'] as const){expect(app.state().view.cameras[target]!.center).toEqual(heldCameras[target]!.center);expect(app.state().view.cameras[target]!.zoom).toBeCloseTo(heldCameras[target]!.zoom,12);}
 const before=app.state();const invalid={...legacy,view:{...legacy.view,cameras:{...legacy.view.cameras,b:{...legacy.view.cameras.b!,visible:{...legacy.view.cameras.b!.visible,width:1e12,height:1e12}}}}};await expect(app.restore(invalid)).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(before.view);
 app.sync(true);app.edge();const groupBefore=app.state().view;await expect(app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(groupBefore);
 app.sync(false);await app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}});const offBefore=app.state().view;await expect(app.remote({type:'camera-sync',value:true})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(offBefore);
});


test('appearance applies actual source or remote choices without saving a browser default',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindAppearance('),b=source.indexOf('export function syncStageLayout',a);
 const control=Object.assign(new EventTarget(),{value:''}),system=Object.assign(new EventTarget(),{matches:false}),document={documentElement:{dataset:{} as Record<string,string>}};
 let storageTouches=0;const storage={getItem(){storageTouches++;return 'system';},setItem(){storageTouches++;}};
 const fn=new Function('matchMedia','document','themePreference','localStorage',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b).replace('export function','function'))+';return bindAppearance;')(()=>system,document,themePreference,storage);
 const binding=fn(control,'dark');binding.set('light');expect(document.documentElement.dataset.theme).toBe('light');expect(control.value).toBe('light');binding.set('system');system.matches=true;system.dispatchEvent(new Event('change'));expect(document.documentElement.dataset.theme).toBe('light');expect(binding.get()).toBe('system');expect(storageTouches).toBe(0);binding.dispose();
});

test('tab coordinator captures before hide and restores after show without changing text-field arrows',async()=>{
 const source=await readFile(new URL('../web/view-controls.ts',import.meta.url),'utf8'),a=source.indexOf('export function bindInspectorTabs('),panels=[{dataset:{inspectorPanel:'view'},hidden:false},{dataset:{inspectorPanel:'rig'},hidden:true}],tabs=[{dataset:{inspector:'view'},setAttribute(){},tabIndex:0,focus(){}},{dataset:{inspector:'rig'},setAttribute(){},tabIndex:-1,focus(){}}];
 const trace:string[]=[],document={querySelectorAll:(selector:string)=>selector==='[data-inspector]'?tabs:panels};
 const bind=new Function('document',new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a).replace('export function','function'))+';return bindInspectorTabs;')(document);
 bind(()=>trace.push('after:'+panels.map(p=>p.hidden).join(',')),()=>trace.push('before:'+panels.map(p=>p.hidden).join(',')));
 (tabs[1] as unknown as {onclick:()=>void}).onclick();expect(trace).toEqual(['before:false,true','after:true,false']);
});

test('visible numeric readback omits hidden camera while the source bookmark retains its prior region',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),a=source.indexOf('function numericView('),b=source.indexOf('function renderNumericView(',a),script=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b));
 const saved={space:'image',center:{x:50,y:70},baseScale:2,width:300,height:400},fn=new Function('numericCamera',`const rigReady=true,referenceReady=true,cameraSync=false,activeCamera='rig';const paneFrame=(target,hidden)=>target==='reference'&&!hidden?null:{...saved,space:target==='rig'?'world':'image'};const saved=${JSON.stringify(saved)};const paneCamera=()=>({center:{x:51,y:73},zoom:2});${script};return numericView;`)(numericCamera);
 expect(fn(false).cameras.reference).toBeNull();expect(fn().cameras.reference.center).toEqual({x:51,y:73});
});

test('new video comparison waits for held-time decoded content and preserves the held rig on refusal or supersession',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),a=source.indexOf('async function showReference('),b=source.indexOf('function referenceFit(',a),c=source.indexOf('async function decodedControlTime('),d=source.indexOf('function numericView(',c);
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b)+source.slice(c,d));
 const script=`function open(held,videoDuration){
  let referenceGeneration=0,referenceAbort=null,referenceReady=false,referenceReason='',video=null,controlledVideoSample=null,referenceCenter=null,referenceSize=null,sequence=null,sequenceSvg=null,selectedPerson='',lastPoseFrame=-1,time=held,duration=20;const cameraFrames={},player={time:held},messages=[],nodes=new Map();
  class Media extends EventTarget {readyState=2;duration=videoDuration;videoWidth=360;videoHeight=720;position=0;requested=null;callback=null;pause(){}get currentTime(){return this.position;}set currentTime(value){this.position=value;this.requested=value;}requestVideoFrameCallback(callback){this.callback=callback;return 1;}cancelVideoFrameCallback(){this.callback=null;}finish(actual){this.dispatchEvent(new Event('seeked'));const callback=this.callback;this.callback=null;callback?.(0,{mediaTime:actual});}}
  const media=new Media(),el=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',replaceChildren(){},append(){}});return nodes.get(id);},text=(id,value)=>{el(id).textContent=value;},select=el,document={createElement:()=>media},data={manifest:{references:[{id:'clip',type:'video',label:'fixture',path:'fixture.mp4'}]}},referenceUrl=()=>'/fixture.mp4',renderSinglePresentation=()=>{},renderTransport=()=>{},message=value=>messages.push(value),errorText=error=>error.message;
  ${code}
  return {load:()=>showReference('clip'),first:()=>media.onloadeddata(),finish:actual=>media.finish(actual),supersede:()=>{referenceGeneration++;referenceAbort.abort();},state:()=>({ready:referenceReady,time,rigTime:player.time,requested:media.requested,actual:controlledVideoSample?.time??null,reason:referenceReason,info:el('reference-info').textContent,messages:[...messages]})};
 }`;
 type VideoHost={load():Promise<void>;first():Promise<void>;finish(actual:number):void;supersede():void;state():{ready:boolean;time:number;rigTime:number;requested:number|null;actual:number|null;reason:string;info:string;messages:string[]}};
 const open=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(script)+';return open;')() as (held:number,duration:number)=>VideoHost;
 const app=open(12,20),loading=app.load(),decoded=app.first();expect(app.state()).toMatchObject({ready:false,time:12,rigTime:12,requested:12,actual:null});app.finish(11.96);await decoded;await loading;expect(app.state()).toMatchObject({ready:true,time:12,rigTime:12,requested:12,actual:11.96});expect(app.state().info).toContain('decoded 11.9600');
 const short=open(12,5),refused=short.load();await short.first();await refused;expect(short.state()).toMatchObject({ready:false,time:12,rigTime:12,requested:null});expect(short.state().reason).toContain('outside 0–5');
 const stale=open(12,20),old=stale.load(),oldFrame=stale.first();stale.supersede();stale.finish(12);await oldFrame;await old;expect(stale.state()).toMatchObject({ready:false,time:12,rigTime:12,actual:null});
});
