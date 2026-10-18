import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature} from '../web/camera-view.ts';
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
 const script=`function open(deps){const {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature}=deps;let zoom=1,referenceZoom=1,cameraCenter=null,referenceCenter=null,cameraSync=true,activeCamera='rig';const cameraFrames={},referenceSize={width:1920,height:1080},player={},assets={stage:{x:-300,y:80,width:200,height:600}};let fits=0;const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{clientWidth:id.startsWith('rig')?600:300,clientHeight:id.startsWith('rig')?400:800,hidden:false,checked:true,textContent:''});return nodes.get(id);};const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},fitCamera=()=>{fits++;};${source.slice(begin,end)};return {edge:()=>{referenceSize.width=2*Number.MAX_SAFE_INTEGER-1000;referenceCenter=null;},wheel:zoomViewport,pan:panCamera,sync:setCameraSync,zoom:zoomCamera,fit:fitActiveCamera,hide:target=>{el(target+'-pane').hidden=true;},state:()=>({sync:cameraSync,active:activeCamera,rig:{zoom,center:cameraCenter},reference:{zoom:referenceZoom,center:referenceCenter},rigSignature:cameraSignature(paneCamera('rig'),paneFrame('rig',true)),referenceSignature:cameraSignature(paneCamera('reference'),paneFrame('reference',true))})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={sync:boolean;active:string;rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};rigSignature:{zoom:number;pan:{x:number;y:number}};referenceSignature:{zoom:number;pan:{x:number;y:number}}};
 const app=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature}) as {edge():void;wheel(target:string,delta:number):void;pan(target:string,dx:number,dy:number):void;sync(value:boolean):void;zoom(value:number):void;fit():void;hide(target:string):void;state():State};
 app.wheel('reference',-1);expect(app.state()).toMatchObject({sync:true,active:'reference',rig:{zoom:1.1},reference:{zoom:1.1}});
 app.pan('rig',120,60);expect(app.state().rigSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.x).toBeCloseTo(.2,12);expect(app.state().referenceSignature.pan.y).toBeCloseTo(.15,12);expect(app.state().rig.center!.y).toBeGreaterThan(380);expect(app.state().reference.center!.y).toBeLessThan(540);
 app.sync(false);const prior=app.state().rig;app.wheel('reference',-1);app.pan('reference',30,-40);expect(app.state().rig).toEqual(prior);const ref=app.state().reference;app.zoom(1.25);expect(app.state().reference.zoom).toBeCloseTo(ref.zoom*1.25,12);expect(app.state().rig).toEqual(prior);
 app.sync(true);expect(app.state().rigSignature.zoom).toBe(app.state().referenceSignature.zoom);expect(app.state().rigSignature.pan.x).toBeCloseTo(app.state().referenceSignature.pan.x,12);app.fit();expect(app.state().rigSignature.pan).toEqual({x:0,y:0});expect(app.state().referenceSignature.pan).toEqual({x:0,y:0});
 app.sync(false);app.hide('reference');const hidden=app.state().reference;app.wheel('rig',-1);expect(app.state().reference).toEqual(hidden);for(let n=0;n<100;n++)app.wheel('rig',-1);expect(app.state().rig.zoom).toBe(8);for(let n=0;n<100;n++)app.wheel('rig',1);expect(app.state().rig.zoom).toBe(.25);
 const overflow=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature}) as typeof app;overflow.edge();const before=overflow.state();expect(()=>overflow.pan('rig',-65536,0)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(before);overflow.sync(false);overflow.pan('rig',-65536,0);const independent=overflow.state();expect(()=>overflow.sync(true)).toThrow('VIEW_CAMERA_RANGE');expect(overflow.state()).toEqual(independent);
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
 const script=`function open(deps){const {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}=deps;
 const cameras={a:{zoom:1,center:null},b:{zoom:1,center:null},reference:{zoom:1,center:null}},cameraFrames={},rigScales={a:1,b:1};let cameraSync=true,activeCamera='a',cameraRestoring=false,cameraLayout='',idleHeld=true,trace=null,seeking=false;const video={videoWidth:1920,videoHeight:1080,style:{},muted:true},players={a:{renderer:{syncPixelRatio(){}}},b:{renderer:{syncPixelRatio(){}}}},assets={a:{stage:{x:-300,y:80,width:200,height:600}},b:{stage:{x:-200,y:90,width:300,height:580}}};const nodes=new Map();const el=id=>{if(!nodes.has(id)){const size=id.startsWith('a-')?[600,400]:id.startsWith('b-')?[400,600]:[300,800];nodes.set(id,{clientWidth:size[0],clientHeight:size[1],style:{},dataset:{},checked:true,textContent:''});}return nodes.get(id);};const input=el,button=el,text=(id,value)=>{el(id).textContent=value;},redrawOverlays=()=>{},renderNumericView=()=>{},stop=()=>{},captureInputs=()=>({}),restoreInputs=()=>{},appearance=null,layers={images:true,mesh:false,bones:false},document={querySelectorAll:()=>[]},domain={start:0,end:2},data={animation:'idle',reference:{sha256:'reference'}};let saving=false,stripBusy=false;const localDraft=()=>false,requireCommonTime=()=>{};async function seekTo(time){trace={reference:time};}const inspectionBookmark=()=>({animation:'idle',time:null,theme:'dark',layers:{images:true,meshes:false,bones:false},selection:{reference:'reference'},view:numericView()});
 ${functions};fit();return {edge:()=>{video.videoWidth=2*Number.MAX_SAFE_INTEGER-1000;cameras.reference.center=null;},pan:panCamera,zoom:zoomCamera,sync:setCameraSync,fit:fitActiveCamera,remote:command=>applyControl(command,new AbortController().signal),restore:value=>restoreInspection(value,new AbortController().signal),bookmark:inspectionBookmark,state:()=>({view:numericView(),scales:{...rigScales},referenceTransform:video.style.transform,positions:{a:{...el('a-root').style},b:{...el('b-root').style}}}),signature:target=>cameraSignature(cameras[target],paneFrame(target))};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type State={view:import('../src/control.ts').ControlView;scales:{a:number;b:number};referenceTransform:string;positions:{a:{left:string;top:string};b:{left:string;top:string}}};
 const app=new Function('deps',code+';return open(deps);')({cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,dragSignature,zoomSignature,numericCamera,restoredZoom,restoreTransaction,syncStageLayout}) as {edge():void;pan(target:string,dx:number,dy:number):void;zoom(factor:number,target:string):void;sync(value:boolean):void;fit():void;remote(command:unknown):Promise<void>;restore(value:unknown):Promise<void>;bookmark():{view:State['view']};state():State;signature(target:string):{zoom:number;pan:{x:number;y:number}}};
 app.pan('reference',60,120);for(const target of ['a','b']){expect(app.signature(target).pan.x).toBeCloseTo(.2,12);expect(app.signature(target).pan.y).toBeCloseTo(.15,12);}expect(app.state().scales.a).not.toBe(app.state().scales.b);
 app.sync(false);const frozen=structuredClone(app.state().view.cameras);app.pan('b',40,-60);expect(app.state().view.cameras.a).toEqual(frozen.a);expect(app.state().view.cameras.reference).toEqual(frozen.reference);expect(app.state().view.cameras.b).not.toEqual(frozen.b);
 await app.remote({type:'camera',target:'a',zoom:2,pan:{x:120,y:80}});expect(app.signature('a').pan.x).toBeCloseTo(.2,12);expect(app.signature('b').zoom).toBe(1);const priorReference=app.state().view.cameras.reference;
 await app.remote({type:'camera',target:'rig',zoom:3,pan:{x:60,y:40}});expect(app.signature('a').zoom).toBe(3);expect(app.signature('b').zoom).toBe(3);expect(app.signature('a').pan.x).toBeCloseTo(app.signature('b').pan.x,12);expect(app.state().view.cameras.reference).toEqual(priorReference);
 app.pan('b',80,30);const bookmark=app.bookmark(),legacy={...bookmark,view:{...bookmark.view}};delete legacy.view.cameraSync;delete legacy.view.activeCamera;
 app.sync(true);expect(app.state().view.activeCamera).toBe('b');for(const target of ['a','reference'])expect(app.signature(target).pan.x).toBeCloseTo(app.signature('b').pan.x,12);
 await app.restore(legacy);expect(app.state().view.cameraSync).toBe(false);for(const target of ['a','b','reference'] as const){expect(app.state().view.cameras[target]!.center.x).toBeCloseTo(bookmark.view.cameras[target]!.center.x,10);expect(app.state().view.cameras[target]!.center.y).toBeCloseTo(bookmark.view.cameras[target]!.center.y,10);expect(app.state().view.cameras[target]!.zoom).toBeCloseTo(bookmark.view.cameras[target]!.zoom,10);}
 const before=app.state();const invalid={...legacy,view:{...legacy.view,cameras:{...legacy.view.cameras,b:{...legacy.view.cameras.b!,visible:{...legacy.view.cameras.b!.visible,width:1e12,height:1e12}}}}};await expect(app.restore(invalid)).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(before.view);
 app.sync(true);app.edge();const groupBefore=app.state().view;await expect(app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(groupBefore);
 app.sync(false);await app.remote({type:'camera',target:'a',zoom:1,pan:{x:-65536,y:0}});const offBefore=app.state().view;await expect(app.remote({type:'camera-sync',value:true})).rejects.toThrow('VIEW_CAMERA_RANGE');expect(app.state().view).toEqual(offBefore);
});
