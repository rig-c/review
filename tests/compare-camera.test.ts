import {expect,test} from 'bun:test';
import {CameraNode,openCompareCamera} from './helpers/compare-camera-687.ts';
import recorded from './fixtures/compare-camera-687.json';
import {decodeBookmark,encodeBookmark,type InspectionBookmark} from '../web/inspection-persistence.ts';

// Captured by executing HEAD's compare functions before their removal, not by
// evaluating the shared implementation. Columns and source identity accompany the data.
for(const row of recorded.rows)test(`#687 three-pane legacy numeric parity: ${row.name}`,async()=>{
 const app=await openCompareCamera();
 for(const [operation,...args] of row.ops){const method=app[operation as keyof typeof app] as Function;await method(...args);}
 const state=app.state();expect(state.view.cameraSync).toBe(row.sync);expect(state.view.activeCamera as string).toBe(row.active);
 expect(state.view.cameras.rig).toBeNull();
 for(const target of ['a','b','reference'] as const){
  const camera=state.view.cameras[target]!;
  const actual=[camera.zoom,camera.center.x,camera.center.y,camera.visible.x,camera.visible.y,camera.visible.width,camera.visible.height];
  actual.forEach((value,index)=>expect(value).toBeCloseTo(row.cameras[target][index]!,10));
  expect(camera.space).toBe(target==='reference'?'image':'world');
 }
 expect(state.scales).toEqual(row.scales);expect(state.referenceTransform).toBe(row.referenceTransform);
 expect(state.positions).toEqual(row.positions);
});

test('#687 first hidden A/B replay uses sibling dimensions, caches frames, and keeps dimension-only visibility',async()=>{
 for(const target of ['a','b'] as const){
  const app=await openCompareCamera(false),other=target==='a'?'b':'a',pane=app.nodes.get(target+'-pane')!,node=app.nodes.get(target+'-viewport')!;
  pane.hidden=true;node.clientWidth=0;node.clientHeight=0;
  expect(app.frame(target)).toBeNull();expect(app.viewport.state.cameraFrames[target]).toBeUndefined();
  const frame=app.frame(target,true)!;expect(frame).toEqual(app.frame(other)!);
  const sibling=app.nodes.get(other+'-viewport')!;sibling.clientWidth=0;sibling.clientHeight=0;
  expect(app.frame(target,true)).toBe(frame);
  node.clientWidth=600;node.clientHeight=400;expect(app.frame(target)).not.toBeNull();
  const reference=app.nodes.get('reference-viewport')!;reference.clientWidth=0;reference.clientHeight=0;
  expect(app.frame('reference',true)).toBeNull();
 }
});

test('#687 selected Fit retains compare margins, picked-mode suffix and reference relative transform without absolute positioning',async()=>{
 const app=await openCompareCamera();app.mode('setup','b');
 app.fit('b');expect(app.status()).toEqual({value:'View fitted on Build B (Second).',error:false});
 app.part({side:'b',slot:'mesh',mode:'context'},{x:-150,y:200,width:30,height:90});app.fit('b');
 expect(app.status()).toEqual({value:'Selected slot fitted on Build B (Second).',error:false});
 const selected=recorded.rows.find(row=>row.name==='selected-b')!;
 expect(app.state().view.cameras.b!.zoom).toBe(selected.cameras.b[0]!);
 expect(app.state().referenceTransform).toBe(selected.referenceTransform);
 // The provider never writes left/top on the relatively laid-out video.
 expect(app.nodes.has('reference-content')).toBe(false);
});

test('#687 URL restores all three divergent cameras exactly, including active pane and legacy sync defaults',async()=>{
 const app=await openCompareCamera();app.sync(false);app.pan('a',30,40);app.zoom(2,'b');app.pan('reference',-25,60);
 const binding={mode:'compare' as const,sourceHash:'a'.repeat(64),rigs:['b'.repeat(64),'c'.repeat(64)]};
 const bookmark={...app.bookmark(),schema:'rig-review-inspection/1',binding} as InspectionBookmark;
 const linked=decodeBookmark(encodeBookmark(bookmark),binding)!;
 app.sync(true);app.fit();await app.restore(linked);expect(app.state().view).toEqual(bookmark.view);
 delete linked.view.cameraSync;delete linked.view.activeCamera;await app.restore(linked);
 expect(app.state().view.cameraSync).toBe(false);expect(app.state().view.activeCamera).toBe('a');
 expect(app.state().view.cameras).toEqual(bookmark.view.cameras);
});

test('#687 three-pane unit scale uses the shared exact reciprocal and retains peer relative signatures',async()=>{
 const app=await openCompareCamera();
 for(const target of ['a','b','reference'] as const){
  app.viewport.unitScaleCamera(target);const camera=app.state().view.cameras[target]!;
  expect(camera.visible.width).toBeCloseTo(camera.viewport.width,10);
  expect(camera.visible.height).toBeCloseTo(camera.viewport.height,10);
  for(const peer of ['a','b','reference'])expect(app.signature(peer)).toEqual(app.signature(target));
 }
});

test('#687 compare bindings preserve pointer wheel, active buttons, drag carry, capture blocking and legacy absence of pinch',async()=>{
 const saved=new Map<string,PropertyDescriptor|undefined>();class Observer{observe(){}disconnect(){}}
 for(const [key,value] of Object.entries({document:new CameraNode(),window:new CameraNode(),Element:CameraNode,MutationObserver:Observer,ResizeObserver:Observer})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 try{
  const app=await openCompareCamera(),c=app.viewport;let enabled=true;const carried:{target:string;dx:number;dy:number}[]=[];
  const controls=c.bindControls(),navigation=c.bindNavigation(target=>target==='reference'?undefined:{threshold:4,move:(dx,dy)=>carried.push({target,dx,dy})},()=>enabled);
  const b=app.nodes.get('b-viewport')!;b.emit('wheel',{deltaY:-1,clientX:110,clientY:220});
  const expected=await openCompareCamera();expected.zoom(1.1,'b',{x:100,y:200});expect(app.state()).toEqual(expected.state());
  b.emit('focusin');app.nodes.get('zoom-in')!.onclick!();expected.zoom(1.25,'b');expect(app.state()).toEqual(expected.state());
  b.emit('pointerdown',{pointerId:1,pointerType:'mouse',clientX:100,clientY:200});b.emit('pointermove',{pointerId:1,pointerType:'mouse',clientX:140,clientY:180});b.emit('pointerup',{pointerId:1,pointerType:'mouse'});
  expect(carried).toEqual([{target:'b',dx:40,dy:-20}]);
  // Space-pan is covered by existing bindPan assertions; compare's plain drag carries.
  enabled=false;const held=app.state();b.emit('pointerdown',{pointerId:2,pointerType:'touch',clientX:100,clientY:200});b.emit('pointermove',{pointerId:2,pointerType:'touch',clientX:180,clientY:280});expect(app.state()).toEqual(held);
  enabled=true;b.emit('pointerdown',{pointerId:3,pointerType:'touch',clientX:100,clientY:200});b.emit('pointerdown',{pointerId:4,pointerType:'touch',isPrimary:false,clientX:200,clientY:200});
  const before=app.state();b.emit('pointermove',{pointerId:4,pointerType:'touch',isPrimary:false,clientX:400,clientY:200});expect(app.state()).toEqual(before);
  b.emit('pointerup',{pointerId:3,pointerType:'touch'});b.emit('pointerup',{pointerId:4,pointerType:'touch'});
  navigation();controls();expect(b.captured.size).toBe(0);expect(b.handlers.get('wheel')).toEqual([]);
 }finally{for(const [key,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});
