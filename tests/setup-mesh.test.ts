import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {RigPlayer,readSetupMesh,type ModelAssets} from '@rig-c/play';
import {meshWeights} from '../src/weights.ts';
import {meshEditSource} from '../web/mesh-editor.ts';
import {readSetupPose} from '../web/setup-pose.ts';
import {setupPoseMesh} from '../web/weights-view.ts';
import {loadSetupAssets,setupRoot} from './helpers/setup-mesh.ts';

/** Hand-written compiled document: no generated expectations or local skinning evaluator. */
function fixture(){
 const base={kind:'mesh',path:'mesh',vertices:{weighted:false,xy:[3,0,0,0,0,4]},uvs:[0,0,1,0,0,1],triangles:[0,1,2],hull:3};
 const linked={kind:'linkedmesh',path:'mesh',skin:'default',slot:'s',source:'base',timelines:true};
 return {spec:'rigc-compiled/3',referenceScale:100,stage:null,
  bones:[{name:'root'},{name:'a',parent:'root',x:5,y:7},{name:'b',parent:'root',x:-1,y:2},{name:'sleep',parent:'root',x:50,skinRequired:true}],
  slots:[{name:'s',bone:'a',setup:'base' as string|null},{name:'t',bone:'b',setup:'linked' as string|null},{name:'sleeping',bone:'sleep',setup:'base' as string|null}],
  skins:[{name:'default',bones:['sleep'],constraints:{},attachments:{s:{base,alternate:structuredClone(base),linked,independent:{...linked,timelines:false}},t:{linked},sleeping:{base}} as Record<string,Record<string,Record<string,unknown>>>}],
  constraints:[] as Record<string,unknown>[],events:[],animations:[] as Record<string,unknown>[],
  editorOrder:{skins:[{name:'default',slots:['s','t','sleeping']}],animations:[] as string[]},images:[],pageGrids:[],droppedStates:[],absentParts:[],meshBones:{},meshes:{},physics:[],deformTransforms:[],trackDerivations:[],rig:{},pages:JSON.parse(readFileSync(new URL('./fixtures/strip-probe/build/skeleton.model.json',import.meta.url),'utf8')).pages.filter((p:{name:string})=>p.name==='mesh.png'),spine:{sha256:'0'.repeat(64)}};
}
const mapping={available:true as const,crop:{w:20,h:20},toWorld:(x:number,y:number)=>({x:x-10,y:20-y}),basis:'literal'};
function consumers(model:unknown,assets:ModelAssets,slot='s',skin?:string){
 const weights=setupPoseMesh(assets,model,slot,setupRoot(),'canvas',skin);
 if(!weights.ok)throw new Error(weights.code);
 const pose=readSetupPose(assets,slot,setupRoot(),'canvas',skin);
 if(!pose.identity)throw new Error('Expected public setup identity');
 const api=readSetupMesh(assets,{slot,attachment:pose.identity.attachment,skin:pose.skin});
 expect(weights.mesh.vertices).toEqual(api.vertices);expect(weights.mesh.triangles).toEqual(api.triangles);expect(weights.mesh.hull).toBe(api.hull);
 expect(weights.mesh.identity).toEqual({skin:api.skin,attachment:api.attachment});
 const edit=meshEditSource({slot,model,pose:()=>pose,mapping});
 return {weights,edit,api,pose};
}
function deform(model:ReturnType<typeof fixture>,switchTo?:string|null){
 model.animations=[{name:'deform',duration:1,bones:[],slots:switchTo===undefined?[]:[{name:'s',timelines:[{name:'attachment',keys:[{time:0,name:switchTo}]}]}],
  constraints:{ik:[],transform:[],path:[],physics:[],slider:[]},
  attachments:[{name:'default',slots:[{name:'s',attachments:[{name:'base',deform:[{time:0,vertices:[1,2]},{time:1,vertices:[3,4]}]}]}]}],drawOrder:[],events:[]}];
 model.editorOrder.animations=['deform'];
 model.constraints=[{kind:'slider',name:'dial',declaredIn:'rig',animation:'deform',time:.5}];
}

test('literal setup-slider deform reaches both views exactly; unselected mesh and linked targets retain stored geometry',async()=>{
 const model=fixture();deform(model);const before=JSON.stringify(model),{assets,dispose}=await loadSetupAssets(model);
 try{
  const {api,edit,weights}=consumers(model,assets);
  // First vertex moves by the slider's interpolated [2,3]; the literals retain every output bit.
  expect(api.vertices).toEqual([9.999999698333657,9.999999999999996,4.9999998375642765,6.999999999999998,4.99999965192345,10.999999999999996]);
  if(!edit.ok)throw new Error(edit.code);
  expect(edit.world).toEqual(api.vertices);expect(edit.source.triangles).toEqual(api.triangles);expect(edit.source.hull).toBe(api.hull);
  expect(edit.source.vertices).toEqual(api.vertices.reduce<number[][]>((rows,_,i,xy)=>{if(i%2===0)rows.push([xy[i]!+10,20-xy[i+1]!]);return rows;},[]));
  expect(weights.weights.vertices[0]).toEqual([{bone:'a',x:3,y:0,weight:1}]);
  for(const attachment of ['alternate','linked','independent'])expect(readSetupMesh(assets,{slot:'s',attachment}).vertices).toEqual([7.9999998375642765,6.999999999999998,4.9999998375642765,6.999999999999998,4.99999965192345,10.999999999999996]);
  expect(JSON.stringify(model)).toBe(before);
 }finally{dispose();}
});

test('selected linked mesh follows public setup deform and timelines policy; Edit Mesh still refuses its source alias',async()=>{
 for(const timelines of [true,false]){
  const model=fixture();model.slots[0]!.setup='linked';model.skins[0]!.attachments.s!.linked!.timelines=timelines;deform(model);
  const {assets,dispose}=await loadSetupAssets(model);
  try{
   const {weights,api,edit}=consumers(model,assets);expect(api.attachment).toBe('linked');
   expect(api.vertices[0]).toBe(timelines?9.999999698333657:7.9999998375642765);
   expect(weights.weights.source).toEqual({skin:'default',slot:'s',attachment:'base'});
   expect(edit).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_NO_MESH s: .*linked mesh/)});
  }finally{dispose();}
 }
});

test('setup-slider attachment selection is read from public identity, not the slot setup key',async()=>{
 const model=fixture();deform(model,'alternate');const {assets,dispose}=await loadSetupAssets(model);
 try{
  const {api,pose,edit}=consumers(model,assets);expect(model.slots[0]!.setup).toBe('base');expect(pose.identity).toEqual({skin:'default',attachment:'alternate'});
  expect(api.attachment).toBe('alternate');if(!edit.ok)throw new Error(edit.code);expect(edit.source.attachment).toBe('alternate');expect(edit.world).toEqual(api.vertices);
 }finally{dispose();}
});

test('fresh no-skin differs from named default activation; supplying table never becomes requested skin',async()=>{
 const model=fixture();model.skins[0]!.attachments.s!.base!.vertices={weighted:true,bindings:[[{bone:'a',x:3,y:0,weight:.25},{bone:'sleep',x:9,y:0,weight:.75}],[{bone:'a',x:.1,y:.3,weight:1}],[{bone:'a',x:0,y:4,weight:1}]]};
 model.skins.push({name:'named',bones:['sleep'],constraints:{},attachments:{}});model.editorOrder.skins.push({name:'named',slots:[]});
 const {assets,dispose}=await loadSetupAssets(model);
 try{
  const fresh=consumers(model,assets),namedDefault=consumers(model,assets,'s','default'),fallback=consumers(model,assets,'s','named');
  expect(fresh.pose.skin).toBeNull();expect(fresh.api.skin).toBe('default');expect(fresh.pose.identity!.skin).toBe('default');
  expect(fresh.api.vertices).toEqual(readSetupMesh(assets,{slot:'s',attachment:'base',skin:null}).vertices);
  expect(fresh.api.vertices).not.toEqual(namedDefault.api.vertices);expect(namedDefault.api.vertices).toEqual(fallback.api.vertices);
  expect(fallback.pose.skin).toBe('named');expect(fallback.api.skin).toBe('default');expect(fallback.weights.weights.skin).toBe('default');
  for(const row of [fresh,namedDefault,fallback]){if(!row.edit.ok)throw new Error(row.edit.code);expect(row.edit.world).toEqual(row.api.vertices);expect(row.edit.source.skin).toBe('default');}
  expect(fresh.weights.weights.vertices[0]).toEqual([{bone:'a',x:3,y:0,weight:.25},{bone:'sleep',x:9,y:0,weight:.75}]);
 }finally{dispose();}
});

test('linked mesh preserves source metadata and queried-slot bone in Weights, with named Edit Mesh refusal',async()=>{
 const model=fixture(),{assets,dispose}=await loadSetupAssets(model);
 try{
  const {weights,api,edit}=consumers(model,assets,'t');expect(api).toMatchObject({slot:'t',attachment:'linked',skin:'default',triangles:[0,1,2],hull:3});
  expect(weights.weights).toMatchObject({slot:'t',source:{skin:'default',slot:'s',attachment:'base'},bones:['b']});
  expect(weights.weights.vertices[0]).toEqual([{bone:'b',x:3,y:0,weight:1}]);
  expect(edit).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_NO_MESH t: .*linked mesh of s \/ base/)});
 }finally{dispose();}
});

test('hidden, no-attachment and setup-slider null stay unavailable without guessing a declared mesh',async()=>{
 for(const nullSlider of [false,true]){
  const model=fixture();if(nullSlider)deform(model,null);else model.slots[0]!.setup=null;
  const {assets,dispose}=await loadSetupAssets(model);
  try{
   for(const [slot,reason] of [['s','no-attachment'],['sleeping','hidden']] as const){
    const pose=readSetupPose(assets,slot,setupRoot(),'canvas');expect(pose.identity).toBeNull();expect(pose.reason).toBe(reason);expect(pose.readMesh()).toBeNull();
    expect(setupPoseMesh(assets,model,slot,setupRoot(),'canvas')).toMatchObject({ok:false,code:expect.stringMatching(new RegExp(`^WEIGHTS_NO_MESH ${slot}:`))});
    expect(meshEditSource({slot,model,pose:()=>pose,mapping})).toMatchObject({ok:false,code:expect.stringMatching(new RegExp(`^MESH_EDIT_NO_MESH ${slot}:`))});
   }
  }finally{dispose();}
 }
});

test('consumer reads never change an existing player time, generation, identity or frame; public arrays are detached',async()=>{
 const model=fixture();deform(model);const {assets,dispose}=await loadSetupAssets(model),stage=new RigPlayer(setupRoot(),assets,{mode:'canvas'});
 try{
  stage.play('deform');stage.seek(.75);const before={time:stage.time,generation:stage.generation,identity:stage.slotIdentity(),frame:stage.posedFrame()},bytes=JSON.stringify(assets.document);
  const {api,edit}=consumers(model,assets);if(!edit.ok)throw new Error(edit.code);
  api.vertices[0]=123;api.triangles[0]=2;const again=consumers(model,assets);expect(again.api.vertices[0]).toBe(9.999999698333657);expect(again.api.triangles).toEqual([0,1,2]);
  expect({time:stage.time,generation:stage.generation,identity:stage.slotIdentity(),frame:stage.posedFrame()}).toEqual(before);expect(JSON.stringify(assets.document)).toBe(bytes);
 }finally{stage.dispose();dispose();}
});

test('stored invalid data and public missing/non-mesh/skin/ambiguity/non-finite errors remain named',async()=>{
 const model=fixture();model.skins.push({name:'named',bones:[],constraints:{},attachments:{s:{base:{...model.skins[0]!.attachments.s!.base!,hull:2}}}});
 model.editorOrder.skins.push({name:'named',slots:['s']});
 model.skins[0]!.attachments.s!.region={kind:'region',path:'mesh',width:20,height:20,atlas:{width:20,height:20,offsetX:0,offsetY:0,originalWidth:20,originalHeight:20}};
 const {assets,dispose}=await loadSetupAssets(model);
 try{
  expect(()=>readSetupMesh(assets,{slot:'s',attachment:'region'})).toThrow('not a mesh');
  expect(()=>readSetupMesh(assets,{slot:'missing',attachment:'base'})).toThrow('no such slot');
  expect(()=>readSetupMesh(assets,{slot:'s',attachment:'missing'})).toThrow('no such attachment');
  expect(()=>readSetupMesh(assets,{slot:'s',attachment:'base',skin:'missing'})).toThrow('no such skin');
  expect(()=>readSetupMesh(assets,{slot:'s',attachment:'base',skin:'all'})).toThrow('choose a named skin');
  const invalid=structuredClone(model);invalid.skins[0]!.attachments.s!.base!.vertices={weighted:true,bindings:[[{bone:'absent',x:0,y:0,weight:1}]]};
  expect(meshWeights(invalid,'s',{skin:'default',attachment:'base'})).toMatchObject({ok:false,code:expect.stringContaining('WEIGHTS_MODEL_INVALID: s / base bindings[0]')});
 }finally{dispose();}
 const overflow=fixture();overflow.bones[1]!.x=1e308;overflow.skins[0]!.attachments.s!.base!.vertices={weighted:false,xy:[1e308,0,0,0,0,4]};const loaded=await loadSetupAssets(overflow);
 try{
  expect(setupPoseMesh(loaded.assets,overflow,'s',setupRoot(),'canvas')).toMatchObject({ok:false,code:expect.stringMatching(/^WEIGHTS_RIG_UNAVAILABLE: .*non-finite/)});
  expect(meshEditSource({slot:'s',model:overflow,pose:slot=>readSetupPose(loaded.assets,slot,setupRoot(),'canvas'),mapping})).toMatchObject({ok:false,code:expect.stringMatching(/^MESH_EDIT_RIG_UNAVAILABLE: .*non-finite/)});
 }finally{loaded.dispose();}
});
