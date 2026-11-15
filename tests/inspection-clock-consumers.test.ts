import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {applyAnimationOps,parseAnimationSourceOp} from '../src/animation-ops.ts';
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
