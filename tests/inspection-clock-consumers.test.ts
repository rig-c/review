import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {applyAnimationOps,parseAnimationSourceOp} from '../src/animation-ops.ts';
import {createViewportController,createViewportState} from '../web/viewport-controller.ts';
import {createRigViewportProvider} from '../web/rig-viewport-provider.ts';
import {PartInspection,partCatalog} from '../web/part-selection.ts';
const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
// Execute the actual consumer body with distinct clocks, without importing the page's startup side effects.
const refresh=main.slice(main.indexOf('function refreshAnimationInspection()'),main.indexOf('\nlet overlays:'));
test('inspection panel consumes shown time while the accumulated runtime remains untouched',()=>{
 for(const shown of [0,.375,1]){
  const updates:number[]=[],player={time:4.375,current:'pulse'};
  const panel={update:(t:number)=>updates.push(t),model:()=>{},unavailable:()=>{}};
  new Function('animationPanel','player','time','duration','partModel','inspectionSourceState',refresh+';refreshAnimationInspection();')(panel,player,shown,1,{},'ready');
  expect(updates).toEqual([shown,shown]);expect(player.time).toBe(4.375);
 }
});
test('scratch replacement snapshots inspected time before pause/load and retains bounded seek semantics',()=>{
 const swap=main.slice(main.indexOf('async function swapRig('),main.indexOf('\n/**\n * Mesh Apply'));
 const expression=swap.match(/keepTime=([^,]+),wasPlaying/)![1]!;
 const player={time:4.375};expect(new Function('player','time','return '+expression)(player,.375)).toBe(.375);
 expect(player.time).toBe(4.375);expect(swap).toContain("seek(keepTime,{kind:'reload'})");
});

test('actual in-place swap keeps matching-canvas zoom/pan, refits a changed canvas and silently clears a removed part',async()=>{
 const swap=main.slice(main.indexOf('async function swapRig('),main.indexOf('\n/**\n * Mesh Apply'));
 const stage={x:-10,y:20,width:100,height:200};
 const entries=partCatalog({slots:[{name:'torso',bone:'root',setup:'body'}],skins:[{name:'default',attachments:{torso:{body:{kind:'region',path:'body'}}}}]},['torso']);
 for(const removed of [false,true])for(const resized of [false,true]){
  const parts=new PartInspection();parts.register('single',entries,{} as any);parts.select({side:'single',slot:'torso',mode:'solo'});
  const cameras={rig:{zoom:1.46,center:{x:17,y:-23}},reference:{zoom:2,center:{x:31,y:45}}},before=structuredClone(cameras),messages:unknown[]=[];
  let fits=0;const state={cameraRestoring:false};
  const viewport={state,cancelFit(){},paneCamera:(target:keyof typeof cameras)=>cameras[target],writeCamera:(target:keyof typeof cameras,value:any)=>{cameras[target]=value;},requestFit(){fits++;cameras.rig={zoom:1,center:{x:40,y:120}};}};
  const next={stage:{...stage,width:resized?101:100},animations:[],dispose(){}};
  const deps={parts,viewport,next,messages,entries:removed?[]:entries,stage};
  const body=`return (async()=>{
   const {parts,viewport,next,messages,entries,stage}=deps;
   const viewportProvider={geometry:()=>({box:stage})},rebuildFramingBoxes=new WeakMap();
   let stageCorrectionRebinding=0,inspectionSourceState='ready',partModel=null,setupChestWorld=null,stageModelHash=null,stageSource=null,stageDocumentSet=false;
   let player={dispose(){},draw(){}},assets={stage,dispose(){}},animation='',time=.375,playing=false,duration=1;
   const physicsPanel=null,weightsView=null,meshEditor=null,directionPanel=null,idlePanel=null;
   const data={feedbackCatalog:{slots:[]},manifest:{animations:[]}},location={origin:'http://local'};
   const select=()=>({disabled:true,value:'',replaceChildren(){}}),el=()=>({});
   const stageLoadInputs=()=>({}),loadModel=async()=>next,createInspectionPlayer=()=>({dispose(){},draw(){}}),readSetupChest=()=>null;
   const refreshAnimationInspection=()=>{},pause=()=>{},configureTurnPad=()=>{},pageRegionTable=()=>({}),PartThumbnails=class{};
   const loadPartModel=async()=>({model:{},entries}),configurePartSets=()=>{},environmentApplied=()=>false;
   const keptAnimation=()=>false,drawRig=(fn)=>fn(),renderTransport=()=>{},renderCues=()=>{},renderIdle=()=>{};
   const updateChestMapping=()=>{},fitCamera=()=>{},loadModelDocument=async()=>({ok:false}),playPreview=()=>{},message=(...args)=>messages.push(args);
   ${swap}
   await swapRig('http://local/model','/', 'hash');return {selection:parts.value(),restoring:viewport.state.cameraRestoring};
  })();`;
  const result=await new Function('deps',new Bun.Transpiler({loader:'ts'}).transformSync(body))(deps);
  expect(result.selection).toEqual(removed?null:{side:'single',slot:'torso',mode:'solo'});
  expect(messages).toEqual([]);expect(result.restoring).toBe(false);expect(fits).toBe(resized?1:0);
  expect(cameras).toEqual(resized?{...before,rig:{zoom:1,center:{x:40,y:120}}}:before);
 }
});

// Supplied operations are a separate boundary: neither reader may normalize invalid input.
test('invalid supplied operation and serialized operation record keep their time refusals',()=>{
 const source=JSON.stringify({spec:'rigc-motion/1',animations:{pulse:{duration:1,tracks:[{bone:'chest',property:'rotate',keys:[{t:0,v:[0]},{t:1,v:[15]}]}]}}});
 const op={op:'insert_key' as const,animation:'pulse',track:0,time:-1,value:[2]};
 expect(()=>applyAnimationOps(source,[op])).toThrow('ANIMATION_KEY_TIME_INVALID');
 expect(()=>parseAnimationSourceOp(JSON.parse(JSON.stringify(op)),'draft.ops[0]')).toThrow('draft.ops[0].time: expected finite number >= 0');
});


test('#858 actual swap preserves the entire numeric camera when equal-stage builds have different first drawn bounds',async()=>{
 const swap=main.slice(main.indexOf('async function swapRig('),main.indexOf('\n/**\n * Mesh Apply'));
 // Keep the actual provider construction and framing callback from main, including future fixes.
 const wiringStart=main.includes('const viewportProvider=')?'const viewportProvider=':'const viewport=createViewportController(';
 const wiring=main.slice(main.indexOf(wiringStart),main.indexOf('const {fitCamera,paneFrame,'));
 const framingDeclaration=main.match(/const rebuildFramingBoxes=[^;]+;/)?.[0]??'';
 const run=async(resized:boolean,removed:boolean)=>{
  const body=`return (async()=>{
   const {createViewportController,createViewportState,createRigViewportProvider,resized,removed}=deps;
   const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{clientWidth:1158,clientHeight:471,hidden:false,style:{}});return nodes.get(id);};
   const stage={x:0,y:0,width:80,height:80};let bounds={x:-11,y:-11,width:22,height:22};
   const newPlayer=()=>({dispose(){},draw(){},slots:null,generation:0,bounds:()=>bounds,renderer:{syncPixelRatio(){}}});
   let player=newPlayer(),assets={stage,animations:[],dispose(){}},animation='',time=.375,playing=false,duration=1;
   let selected={side:'single',slot:'torso',mode:'solo'};
   const parts={value:()=>selected,frame:()=>({generation:0,order:[]}),bounds:()=>null,register(){},restoreSelection(value){selected=removed?null:value;}};
   const partsOnly=false,sceneBox=()=>null,referenceSize=null,referenceGeneration=0,view='rig',rigRaster=undefined;
   const text=()=>{},message=()=>{},redrawOverlay=()=>{},viewportState=createViewportState();
   ${framingDeclaration}
   ${wiring}
   const {fitCamera}=viewport;viewport.renderNumericView=()=>{};
   viewport.state.cameraSync=false;viewport.writeCamera('rig',{zoom:1.8292681684438339,center:{x:17,y:23}});fitCamera();
   const before=structuredClone(viewport.numericView().cameras.rig),beforeFrame={...viewport.paneFrame('rig')};
   let stageCorrectionRebinding=0,inspectionSourceState='ready',partModel=null,setupChestWorld=null,stageModelHash=null,stageSource=null,stageDocumentSet=false;
   const physicsPanel=null,weightsView=null,meshEditor=null,directionPanel=null,idlePanel=null;
   const data={feedbackCatalog:{slots:[]},manifest:{animations:[]}},location={origin:'http://local'};
   const select=()=>({disabled:true,value:'',replaceChildren(){}});
   const next={stage:{...stage,width:resized?81:80},animations:[],dispose(){}};
   const stageLoadInputs=()=>({}),loadModel=async()=>next,createInspectionPlayer=()=>{bounds={x:-30,y:-20,width:60,height:40};return newPlayer();},readSetupChest=()=>null;
   const refreshAnimationInspection=()=>{},pause=()=>{},configureTurnPad=()=>{},pageRegionTable=()=>({}),PartThumbnails=class{};
   const loadPartModel=async()=>({model:{},entries:[]}),configurePartSets=()=>{},environmentApplied=()=>false;
   const keptAnimation=()=>false,drawRig=fn=>fn(),renderTransport=()=>{},renderCues=()=>{},renderIdle=()=>{};
   const updateChestMapping=()=>{},loadModelDocument=async()=>({ok:false}),playPreview=()=>{};
   ${swap}
   await swapRig('http://local/model','/', 'hash');
   const after=viewport.numericView().cameras.rig;
   // Simulate a later observer render and an even larger animated pose: neither may change retained framing.
   bounds={x:-300,y:-200,width:600,height:400};fitCamera();
   return {before,after,later:viewport.numericView().cameras.rig,beforeFrame,afterFrame:viewport.paneFrame('rig'),selected,restoring:viewport.state.cameraRestoring};
  })();`;
  return new Function('deps',new Bun.Transpiler({loader:'ts'}).transformSync(body))({createViewportController,createViewportState,createRigViewportProvider,resized,removed});
 };
 for(const removed of [false,true]){
  const result=await run(false,removed);console.log('CAMERA_SWAP_EQUAL_STAGE '+JSON.stringify(result));
  expect(result.after).toEqual(result.before);expect(result.later).toEqual(result.before);
  expect(result.afterFrame.baseScale).toBe(result.beforeFrame.baseScale);
  expect(result.selected).toEqual(removed?null:{side:'single',slot:'torso',mode:'solo'});expect(result.restoring).toBe(false);
 }
 const changed=await run(true,false);
 expect(changed.after.zoom).toBe(1);expect(changed.after).not.toEqual(changed.before);
});
