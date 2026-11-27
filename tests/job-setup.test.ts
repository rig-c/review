import {takeSample} from '../web/scene-plates.ts';
import type {DirectionInspection} from '../src/direction-inspection.ts';
import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {RigPlayer} from '@rig-c/play';
import {applyDomI18n,setLanguagePreference,setSourceText} from '../web/i18n.ts';
import {PartInspection,partCatalog} from '../web/part-selection.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';

const main=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
function fragment(start:string,end:string){const a=main.indexOf(start),b=main.indexOf(end,a);expect(a).toBeGreaterThanOrEqual(0);expect(b).toBeGreaterThan(a);return main.slice(a,b);}
const lifecycle=fragment('function createInspectionPlayer(', 'async function initPlayer(');
const controls=fragment('function chooseAnimation(', 'function stopAudio()');
const idle=fragment('function canRepeatIdle(', 'async function playPreview(');
const setup=fragment(" else if(player){restartSetupPlayer(true);",' if(selection.axis)');

/** Execute the shared screen's actual transport over the published player and native canvas. */
async function screen(visible=true,direction?:DirectionInspection){
 const doc=JSON.parse(readFileSync(new URL('./fixtures/strip-probe/build/skeleton.model.json',import.meta.url),'utf8'));
 if(!visible){doc.slots=[];for(const skin of doc.editorOrder.skins)skin.slots=[];for(const skin of doc.skins)skin.attachments={};}
 const loaded=await loadSetupAssets(doc),root=setupRoot(),player=new RigPlayer(root,loaded.assets,{mode:'canvas'});
 const parts=new PartInspection();parts.register('single',partCatalog(doc,doc.slots.map((s:{name:string})=>s.name)),player);
 const source={publicationId:'publication-1',instanceKey:'instance-1',sourceHash:'a'.repeat(64),pageId:'page-1'};
 const drawTimes:number[]=[];
 const camera={center:{x:20,y:20},zoom:2},clock={value:''},nodes=new Map<string,{hidden:boolean;value:string}>();
 const scope={player,assets:loaded.assets,source,camera,parts,RigPlayer,ModelAssets:undefined,partModel:doc,inspectionSourceState:'ready',data:{feedbackCatalog:{slots:doc.slots.map((s:{name:string})=>s.name)}},partCatalog,PartThumbnails:class{},pageRegionTable:()=>({}),readSetupChest:()=>null,setupChestWorld:null,animation:'',time:0,duration:0,axisInspection:false,rigDifference:null,video:null,repeat:true,
  pause(){player.pause();},clipMoved(){},leaveRigDifference(){},renderLayout(){},
  el(id:string){if(id==='rig-root')return root as never;if(!nodes.has(id))nodes.set(id,{hidden:false,value:''});return nodes.get(id)!;},select(id:string){return this.el(id);},
  activeScene:()=>direction,takeSample,
  clipDuration(name:string){return loaded.assets.animations.find(a=>a.name===name)?.duration??0;},canRepeatIdle(){return scope.repeat;},
  drawRig(action:()=>void){action();drawTimes.push(scope.player.entry(0)?.animationTime??0);parts.present('single');},refreshAnimationInspection(){},renderTransport(){clock.value=String(scope.time);},renderCues(){},renderIdle(){},renderSequenceFrame(){},text(){},message(){},rendererStatus(){return {label:''};},errorText:String};
 const code=new Bun.Transpiler({loader:'ts'}).transformSync(lifecycle+'\n'+controls+'\n'+fragment('async function inspectControlTime(', 'async function decodedControlTime('));
 const transport=new Function('scope',`with(scope){${code};return {chooseAnimation,seek,inspectControlTime};}`)(scope) as {chooseAnimation(name:string):void;seek(time:number):void;inspectControlTime(time:number,signal:AbortSignal):Promise<void>};
 const reset=new Function('scope',`with(scope){${code};${new Bun.Transpiler({loader:'ts'}).transformSync('if(false){}'+setup)};drawRig(()=>player.draw());renderTransport();}`);
 function at(animation:string,time:number){if(animation){if(scope.animation!==animation)transport.chooseAnimation(animation);}else reset(scope);transport.seek(time);}
 at('',0);
 return {scope,drawTimes,open:(name:string)=>transport.chooseAnimation(name),get player(){return scope.player;},parts,root,source,camera,clock,at,restoreTime:(time:number)=>transport.inspectControlTime(time,new AbortController().signal),close(){scope.player.dispose();loaded.dispose();}};
}

test('#557 shared Setup holds a public null-animation pose before inspection',async()=>{
 const h=await screen();try{expect(h.player.current).toBeNull();expect(h.player.entry(0)?.animation).toBeNull();expect(h.parts.frame('single')).toEqual(h.player.posedFrame());expect(h.player.posedFrame().order.length).toBeGreaterThan(0);}finally{h.close();}
});
test('#796 setup → animation → Setup → animation retains source, camera and selection with the correct public pose/time',async()=>{
 const h=await screen();try{
  const source=h.source,camera=structuredClone(h.camera);h.parts.select({side:'single',slot:'mesh',mode:'context'});const selection=structuredClone(h.parts.value());
  for(const [animation,time]of [['inspect',0],['inspect',.375],['',0],['inspect',.625]] as const){
   h.at(animation,time);const identity=h.scope.player;expect(h.scope.source).toBe(source);expect(h.camera).toEqual(camera);
   expect(identity.current).toBe(animation||null);expect(identity.entry(0)?.animationTime??0).toBe(time);
   expect(h.scope.time).toBe(time);expect(h.clock.value).toBe(String(time));
   expect(h.parts.frame('single')).toEqual(identity.posedFrame());expect(h.parts.value()).toEqual(selection);
  }
 }finally{h.close();}
});
test('#557 shared Setup retains valid models with no visible attachment',async()=>{
 const h=await screen(false);try{
  expect(h.player.current).toBeNull();expect(h.player.time).toBe(0);
  expect(h.player.posedFrame().order).toEqual([]);expect(h.parts.frame('single')?.order).toEqual([]);
 }finally{h.close();}
});
test('#796 context and solo preserve the public whole pose and the selected inspection frame',async()=>{
 const h=await screen();try{
  h.at('inspect',.375);
  const whole=structuredClone(h.player.posedFrame(null)),slot=h.player.slotIdentity().slots[0]!.slot;
  const camera=structuredClone(h.camera),generation=h.player.generation;
  for(const mode of ['context','solo']as const){
   h.parts.select({side:'single',slot,mode});
   expect(h.parts.value()).toMatchObject({side:'single',slot,mode});
   expect(h.parts.frame('single')?.order).toEqual(mode==='solo'?whole.order.filter(row=>row.slot===slot):whole.order);
   expect(h.player.posedFrame(null)).toEqual(whole);expect(h.player.generation).toBe(generation);
   expect(h.player.entry(0)?.animationTime).toBe(.375);expect(h.camera).toEqual(camera);
  }
 }finally{h.close();}
});
test('#557 shared Setup clears the animated pose on the same public player',async()=>{
 const h=await screen();try{h.at('inspect',.375);const animated=structuredClone(h.player.posedFrame());h.at('',0);expect(h.player.current).toBeNull();expect(h.player.time).toBe(0);expect(h.player.posedFrame()).not.toEqual(animated);expect(h.parts.frame('single')).toEqual(h.player.posedFrame());}finally{h.close();}
});
test('#796 Repeat-end UI endpoint, public wrapped frame agree by loop phase; Setup keeps reference-only seconds',async()=>{
 const h=await screen();try{
  for(const repeat of [true,false]){h.scope.repeat=repeat;h.at('',0);h.at('inspect',1);const actual=h.player.entry(0)!.animationTime;
   expect(h.clock.value).toBe('1');expect(h.scope.time).toBe(1);expect(h.player.current).toBe('inspect');expect(actual).toBeCloseTo(repeat?0:1,12);
   expect(repeat?h.scope.time%h.scope.duration:h.scope.time).toBeCloseTo(actual,12);
  }
  h.at('',1.25);expect(h.scope.time).toBe(1.25);expect(h.clock.value).toBe('1.25');expect(h.player.current).toBeNull();expect(h.player.time).toBe(0);expect(h.parts.frame('single')).toEqual(h.player.posedFrame());
 }finally{h.close();}
});

test('#796 restored Setup retains numeric reference seconds without seeking a cleared rig track',async()=>{
 const h=await screen();try{await h.restoreTime(1.25);expect(h.scope.time).toBe(1.25);expect(h.clock.value).toBe('1.25');expect(h.player.current).toBeNull();expect(h.player.time).toBe(0);expect(h.parts.frame('single')).toEqual(h.player.posedFrame());h.at('inspect',.375);expect(h.player.entry(0)!.animationTime).toBe(.375);}finally{h.close();}
});


test('#799 the first scene draw uses a nonzero mapped source start while take time stays zero',async()=>{
 const direction:DirectionInspection={file:{path:'direction.json',sha256:'a'.repeat(64)},model:{path:'skeleton.model.json',sha256:'b'.repeat(64)},rigVersion:1,
  camera:{space:'rig-world-y-up',keys:[{time:0,easing:'hold',box:{x:0,y:0,width:80,height:64}}]},
  take:{duration:8,loop:true},timing:[{time:0,source_time:.5,easing:'linear'},{time:8,source_time:2,easing:'hold'}]};
 const h=await screen(true,direction);try{
  h.drawTimes.length=0;h.open('inspect');
  expect(h.scope.time).toBe(0);expect(h.clock.value).toBe('0');
  expect(h.drawTimes).toEqual([.5]);expect(h.player.entry(0)!.animationTime).toBe(.5);
  const initial=structuredClone(h.player.posedFrame());
  expect(h.parts.frame('single')?.order).toEqual(initial.order);
  h.at('inspect',1);h.at('inspect',0);
  expect(h.player.posedFrame().order).toEqual(initial.order);
  expect(h.parts.frame('single')?.order).toEqual(initial.order);
  expect(h.player.entry(0)!.animationTime).toBe(.5);expect(h.scope.time).toBe(0);
 }finally{h.close();}
});

test('#841 and #1090 label repeating direction and standalone clips by name in EN and KO',()=>{
 const direction:DirectionInspection={file:{path:'direction.json',sha256:'a'.repeat(64)},model:{path:'skeleton.model.json',sha256:'b'.repeat(64)},rigVersion:1,
  camera:{space:'rig-world-y-up',keys:[{time:0,easing:'hold',box:{x:0,y:0,width:80,height:64}}]},
  take:{duration:4,loop:true},timing:[{time:0,source_time:0,easing:'linear'},{time:4,source_time:2,easing:'hold'}]};
 const textNode:{nodeType:3;nodeValue:string;parentElement:unknown}={nodeType:3,nodeValue:'',parentElement:null};
 const idleStateEl={id:'idle-state',tagName:'SPAN',childNodes:[textNode],getAttribute:()=>null,ownerDocument:{createTreeWalker:()=>{let done=false;return {nextNode:()=>done?null:(done=true,textNode)};}},get textContent(){return textNode.nodeValue;},set textContent(v:string){textNode.nodeValue=v;}} as unknown as Element;
 textNode.parentElement=idleStateEl;
 const rendered=(lang:'en'|'ko')=>{setLanguagePreference(lang);applyDomI18n(idleStateEl);return idleStateEl.textContent;};
 let scene:DirectionInspection|undefined=direction;
 const scope={
  player:{},
  assets:{animations:[{name:'idle',duration:2},{name:'look_around',duration:2}]},
  data:{manifest:{animations:[{id:'idle',label:'Idle'},{id:'look_around',label:'Look around'}] as {id:string;label?:string}[]}},
  animation:'look_around',
  duration:2,
  axisInspection:false,
  activeScene:()=>scene,
  input:()=>({checked:true}),
  text:(id:string,value:string)=>{if(id==='idle-state')setSourceText(idleStateEl,value);},
 };
 const run=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(idle)};return {canRepeatIdle,renderIdle};}`)(scope) as {canRepeatIdle():boolean;renderIdle():void};
 try{
  run.renderIdle();
  expect(rendered('en')).toBe('Look around · repeating');
  expect(rendered('ko')).toBe('Look around · 반복 재생 중');

  scope.data.manifest.animations=[{id:'idle',label:'Idle'}];
  run.renderIdle();
  expect(rendered('en')).toBe('look_around · repeating');
  expect(rendered('ko')).toBe('look_around · 반복 재생 중');

  scope.animation='idle';
  run.renderIdle();
  expect(rendered('en')).toBe('Actual idle · repeat enabled');
  expect(rendered('ko')).toBe('실제 아이들 · 반복 활성화됨');

  scene=undefined;
  run.renderIdle();
  expect(rendered('en')).toBe('Actual idle · repeat enabled');
  expect(rendered('ko')).toBe('실제 아이들 · 반복 활성화됨');

  scope.animation='look_around';
  run.renderIdle();
  expect(rendered('en')).toBe('look_around · repeating');
  expect(rendered('ko')).toBe('look_around · 반복 재생 중');

  scope.animation='missing';
  expect(run.canRepeatIdle()).toBe(false);
  run.renderIdle();
  expect(rendered('en')).toBe('Non-idle inspection · no automatic playback');
  expect(rendered('ko')).toBe('비아이들 점검 · 자동 재생 안 함');
 }finally{setLanguagePreference('system');}
});
