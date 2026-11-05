import {expect,test} from 'bun:test';
import {createViewportController,createViewportState,type ViewportProvider} from '../web/viewport-controller.ts';
import {unprojectMark} from '../src/stage-comment.ts';
import {viewportPairMarkup,expandViewportPair,viewportPairPlaceholder} from '../web/viewport-pair.ts';
function host(){
 const nodes=new Map<string,any>();for(const target of ['rig','reference']){nodes.set(target+'-viewport',{clientWidth:640,clientHeight:480});nodes.set(target+'-pane',{hidden:false});}
 const state=createViewportState();let renders=0;
 const provider:ViewportProvider={el:(id:string)=>nodes.get(id),geometry:target=>({space:target==='rig'?'world':'image',box:{x:0,y:0,width:320,height:240},marginX:0,marginY:0}),layoutKey:()=>[...nodes.values()].map(n=>n.clientWidth??n.hidden).join(','),render:()=>{renders++;},renderControls:()=>{},selection:()=>({selected:false,bounds:null}),message:()=>{}};
 return {nodes,state,controller:createViewportController(provider,state),renders:()=>renders};
}
test('#387 provider boundary keeps cursor anchor, shared state and hidden frame behavior without a runtime model',()=>{
 const h=host(),c=h.controller;c.fitCamera();const point={x:113,y:207},before=unprojectMark(point,c.numericView().cameras.rig!);c.zoomViewport('rig',-1,point);const after=unprojectMark(point,c.numericView().cameras.rig!);expect(after.x).toBeCloseTo(before.x,12);expect(after.y).toBeCloseTo(before.y,12);expect(c.state).toBe(h.state);
 c.setCameraSync(false);const ref=structuredClone(c.paneCamera('reference'));c.panCamera('rig',64,-48);expect(c.paneCamera('reference')).toEqual(ref);const held=c.paneFrame('rig');h.nodes.get('rig-pane').hidden=true;expect(c.paneFrame('rig')).toBeNull();expect(c.paneFrame('rig',true)).toBe(held);expect(h.renders()).toBeGreaterThan(0);
});
test('#387 pair expansion preserves the exact subtree instead of maintaining another markup copy',()=>{const shell='<div id="stage-layout" class="stages">'+viewportPairPlaceholder+'</div>';expect(expandViewportPair(shell)).toBe('<div id="stage-layout" class="stages">'+viewportPairMarkup+'</div>');expect(viewportPairMarkup.match(/id="rig-viewport"/g)).toHaveLength(1);expect(viewportPairMarkup.match(/id="reference-viewport"/g)).toHaveLength(1);});

test('#382 native scale reaches exact 1, refuses beyond min(fit,1)..16, preserves cursor and retains rig limits',()=>{
 const h=host();const native=createViewportController({el:(id)=>h.nodes.get(id),nativeScale:true,geometry:()=>({space:'image',box:{x:0,y:0,width:12800,height:9600},marginX:0,marginY:0}),layoutKey:()=>'',render:()=>{},renderControls:()=>{},selection:()=>({selected:false,bounds:null}),message:()=>{}});
 native.fitActiveCamera('rig');expect(native.state.zoom).toBe(.05);expect(native.numericView().cameras.rig!.visible.width).toBe(12800);
 native.updateCamera('rig',{zoom:1,pan:{x:0,y:0}});expect(native.state.zoom).toBe(1);const at={x:171,y:232},before=unprojectMark(at,native.numericView().cameras.rig!);native.zoomCamera(2,'rig',at);const after=unprojectMark(at,native.numericView().cameras.rig!);expect(after.x).toBeCloseTo(before.x,10);expect(after.y).toBeCloseTo(before.y,10);
 expect(()=>native.updateCamera('rig',{zoom:.049,pan:{x:0,y:0}})).toThrow();expect(()=>native.writeCamera('rig',{zoom:16.01,center:null})).toThrow('PARTS_CAMERA_RANGE');expect(()=>native.zoomCamera(100,'rig')).toThrow('PARTS_CAMERA_RANGE');expect(native.state.zoom).toBe(2);
 h.controller.zoomCamera(100,'rig');expect(h.state.zoom).toBe(8);h.controller.zoomCamera(.0001,'rig');expect(h.state.zoom).toBe(.25);
});

test('#382 common two-pointer gesture anchors source point at moving pinch centre; capture mode blocks pan/pinch',()=>{
 const saved=new Map<string,unknown>();
 class Node {
  clientWidth=640;clientHeight=480;hidden=false;dataset:Record<string,string>={};captured=new Set<number>();handlers=new Map<string,Function[]>();
  addEventListener(k:string,f:Function){this.handlers.set(k,[...this.handlers.get(k)??[],f]);}removeEventListener(k:string,f:Function){this.handlers.set(k,(this.handlers.get(k)??[]).filter(x=>x!==f));}
  emit(k:string,v:Record<string,unknown>){for(const f of this.handlers.get(k)??[])f({target:this,button:0,isPrimary:true,preventDefault(){},...v});}
  closest(){return null;}querySelectorAll(){return [];}getBoundingClientRect(){return {left:10,top:20};}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);this.emit('lostpointercapture',{pointerId:id});}
 }
 const doc=new Node(),win=new Node();class Observer{observe(){}disconnect(){}}
 for(const [k,v]of Object.entries({document:doc,window:win,Element:Node,MutationObserver:Observer,ResizeObserver:Observer})){saved.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;}
 try{const h=host(),pane=new Node(),ref=new Node(),layout=new Node();h.nodes.set('rig-viewport',pane);h.nodes.set('reference-viewport',ref);h.nodes.set('stage-layout',layout);const c=h.controller;let enabled=true;const dispose=c.bindNavigation(undefined,()=>enabled);
 const point={x:200,y:170},source=unprojectMark(point,c.numericView().cameras.rig!);
 pane.emit('pointerdown',{pointerId:1,pointerType:'touch',clientX:160,clientY:190});pane.emit('pointerdown',{pointerId:2,pointerType:'touch',isPrimary:false,clientX:260,clientY:190});pane.emit('pointermove',{pointerId:2,pointerType:'touch',isPrimary:false,clientX:360,clientY:190});
 const after=unprojectMark({x:250,y:170},c.numericView().cameras.rig!);expect(after.x).toBeCloseTo(source.x,10);expect(after.y).toBeCloseTo(source.y,10);expect(c.state.zoom).toBe(2);
 pane.emit('pointerup',{pointerId:1,pointerType:'touch'});pane.emit('pointerup',{pointerId:2,pointerType:'touch'});expect(pane.captured.size).toBe(0);
 const before=structuredClone(c.paneCamera('rig'));enabled=false;pane.emit('pointerdown',{pointerId:3,pointerType:'touch',clientX:160,clientY:190});pane.emit('pointerdown',{pointerId:4,pointerType:'touch',isPrimary:false,clientX:260,clientY:190});pane.emit('pointermove',{pointerId:4,pointerType:'touch',clientX:460,clientY:190});expect(c.paneCamera('rig')).toEqual(before);dispose();
 }finally{for(const [k,v]of saved){if(v===undefined)delete(globalThis as any)[k];else(globalThis as any)[k]=v;}}
});
