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

test('actual hovered viewport wheel handler preserves the independent other camera and bounds its own zoom',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('function zoomViewport('),end=source.indexOf('function bind():',begin);if(begin<0||end<begin)throw new Error('wheel camera adapter missing');
 const script=`function open(){let zoom=2,referenceZoom=3,rigFits=0,referenceFits=0;const fitCamera=()=>{rigFits++;},referenceFit=()=>{referenceFits++;},renderNumericView=()=>{};${source.slice(begin,end)};return {wheel:zoomViewport,state:()=>({zoom,referenceZoom,rigFits,referenceFits})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script),app=new Function(code+';return open();')() as {wheel(target:'rig'|'reference',delta:number):void;state():{zoom:number;referenceZoom:number;rigFits:number;referenceFits:number}};
 app.wheel('reference',-1);expect(app.state()).toEqual({zoom:2,referenceZoom:3*1.1,rigFits:0,referenceFits:1});app.wheel('rig',1);expect(app.state()).toMatchObject({zoom:2/1.1,referenceZoom:3*1.1,rigFits:1,referenceFits:1});for(let n=0;n<100;n++)app.wheel('reference',-1);expect(app.state().referenceZoom).toBe(8);expect(app.state().zoom).toBe(2/1.1);for(let n=0;n<100;n++)app.wheel('rig',1);expect(app.state().zoom).toBe(.25);expect(app.state().referenceZoom).toBe(8);
});

test('actual single afterInputs rebuilds restored bone and slot target editability, catalog and hints',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('function renderFeedbackTargets('),end=source.indexOf('function renderFrameTransport()',begin),after=source.indexOf('afterInputs:()=>{'),afterEnd=source.indexOf(',onConflict:',after);if([begin,end,after,afterEnd].some(v=>v<0))throw new Error('single restored target action missing');
 const functions=source.slice(begin,end),afterInputs=source.slice(after+'afterInputs:'.length,afterEnd);
 const script=`function open(feedbackTargetNames){const fields={'feedback-target-kind':{value:''},'feedback-target-name':{value:'',disabled:false,readOnly:false},'audio-volume':{value:'1'}},names=[],hints={};const list={replaceChildren(){names.length=0;},append(item){names.push(item.value);}},input=id=>fields[id],select=input,el=()=>list,option=value=>({value}),text=(id,value)=>{hints[id]=value;},renderFeedbackRange=()=>{},data={feedbackCatalog:{rig:'actual-rig',bones:['root','elbow'],slots:['shirt'],animations:null,clock:null,clockAnimation:null}};${functions};const afterInputs=${afterInputs};renderFeedbackTargets(true);return {restore:(kind,name)=>{fields['feedback-target-kind'].value=kind;fields['feedback-target-name'].value=name;afterInputs();},state:()=>({field:{...fields['feedback-target-name']},names:[...names],hint:hints['feedback-target-hint']})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script),app=new Function('feedbackTargetNames',code+';return open(feedbackTargetNames);')(feedbackTargetNames) as {restore(kind:string,name:string):void;state():{field:{value:string;disabled:boolean;readOnly:boolean};names:string[];hint:string}};
 expect(app.state().field.disabled).toBe(true);app.restore('bone','elbow');expect(app.state()).toMatchObject({field:{value:'elbow',disabled:false,readOnly:false},names:['root','elbow']});expect(app.state().hint).toContain('2 targets');app.restore('bone','elb');expect(app.state()).toMatchObject({field:{value:'elb',disabled:false,readOnly:false},names:['root','elbow']});app.restore('slot','shirt');expect(app.state()).toMatchObject({field:{value:'shirt',disabled:false,readOnly:false},names:['shirt']});expect(app.state().hint).toContain('1 targets');app.restore('rig','actual-rig');expect(app.state().field).toEqual({value:'actual-rig',disabled:false,readOnly:true});
});

test('synchronous aspect refresh uses the same stable orientation as resize observation',()=>{const area={clientWidth:628,clientHeight:789,dataset:{orientation:'horizontal'}};expect(syncStageLayout(area)).toBe(true);expect(area.dataset.orientation).toBe('vertical');expect(syncStageLayout(area)).toBe(false);area.clientWidth=900;expect(syncStageLayout(area)).toBe(true);expect(area.dataset.orientation).toBe('horizontal');});
