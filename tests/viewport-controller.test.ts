import {expect,test} from 'bun:test';
import {createViewportController,createViewportState,type ViewportProvider} from '../web/viewport-controller.ts';
import {projectMark,unprojectMark} from '../src/stage-comment.ts';
import {viewportPairMarkup,expandViewportPair,viewportPairPlaceholder} from '../web/viewport-pair.ts';
import {createPartsViewport} from '../web/parts-viewport-provider.ts';
import {createRigViewportProvider,type RigViewportHost} from '../web/rig-viewport-provider.ts';
function host(){
 const nodes=new Map<string,any>();for(const target of ['rig','reference']){nodes.set(target+'-viewport',{clientWidth:640,clientHeight:480});nodes.set(target+'-pane',{hidden:false});}
 const state=createViewportState();let renders=0;
 const provider:ViewportProvider={el:(id:string)=>nodes.get(id),geometry:target=>({space:target==='rig'?'world':'image',box:{x:0,y:0,width:320,height:240},marginX:0,marginY:0}),layoutKey:()=>[...nodes.values()].map(n=>n.clientWidth??n.hidden).join(','),render:()=>{renders++;},renderControls:()=>{},selection:()=>({selected:false,bounds:null}),message:()=>{}};
 return {nodes,state,provider,controller:createViewportController(provider,state),renders:()=>renders};
}

test('#671 unit scale centers the active target in pane units and retains relative sync',()=>{
 const h=host(),c=h.controller;
 h.provider.geometry=target=>({space:target==='rig'?'world':'image',box:{x:0,y:0,width:target==='rig'?320:1280,height:target==='rig'?240:960},marginX:0,marginY:0});
 c.panCamera('rig',64,-48);c.unitScaleCamera('rig');
 const rig=c.numericView().cameras.rig!,reference=c.numericView().cameras.reference!;
 expect(h.state.zoom).toBe(.5);expect(h.state.referenceZoom).toBe(.5);
 expect(rig.center).toEqual({x:160,y:120});expect(reference.center).toEqual({x:640,y:480});
 expect(rig.visible.width).toBe(640);expect(reference.visible.width).toBe(2560);
 // CSS pixels, independent of backing-store pixel ratio; only the active pane is unit scale.
 const a=projectMark({x:160,y:120},rig),b=projectMark({x:161,y:121},rig);
 expect(b.x-a.x).toBe(1);expect(b.y-a.y).toBe(-1);
 c.activateCamera('reference');c.unitScaleCamera();
 expect(c.state.activeCamera).toBe('reference');expect(c.state.referenceZoom).toBe(2);
 expect(c.numericView().cameras.reference!.visible.width).toBe(640);
 expect(c.numericView().cameras.rig!.visible.width).toBe(160);
 c.setCameraSync(false);const held=structuredClone(c.paneCamera('rig'));
 c.panCamera('reference',20,30);c.unitScaleCamera('reference');
 expect(c.paneCamera('rig')).toEqual(held);
 expect(c.numericView().cameras.reference!.center).toEqual({x:640,y:480});
});

test('#671 exact reciprocal accepts public endpoints and refuses outside them without camera mutation',()=>{
 for(const baseScale of [.125,4,.124,4.01]){
  const h=host(),c=h.controller;
  h.provider.geometry=()=>({space:'world',box:{x:0,y:0,width:640/baseScale,height:480/baseScale},marginX:0,marginY:0});
  c.state.cameraSync=false;c.state.zoom=2;c.state.cameraCenter={x:12,y:34};
  const before=structuredClone({rig:c.paneCamera('rig'),reference:c.paneCamera('reference'),active:c.state.activeCamera});
  if(baseScale===.125||baseScale===4){c.unitScaleCamera('rig');expect(c.state.zoom).toBe(1/baseScale);expect(c.numericView().cameras.rig!.visible.width).toBe(640);}
  else{
   expect(()=>c.unitScaleCamera('rig')).toThrow('VIEW_CAMERA_RANGE');
   expect({rig:c.paneCamera('rig'),reference:c.paneCamera('reference'),active:c.state.activeCamera}).toEqual(before);
   expect(h.renders()).toBe(0);
  }
 }
});

test('#671 unavailable and cached hidden panes refuse; default may select the other visible pane',()=>{
 const h=host(),c=h.controller;c.fitCamera();const before=structuredClone(c.paneCamera('rig'));
 h.nodes.get('rig-pane').hidden=true;
 expect(c.paneFrame('rig',true)).not.toBeNull();
 expect(()=>c.unitScaleCamera('rig')).toThrow('CONTROL_CAMERA_UNAVAILABLE');
 expect(c.paneCamera('rig')).toEqual(before);
 c.unitScaleCamera();expect(c.state.activeCamera).toBe('reference');expect(c.state.referenceZoom).toBe(.5);
 h.nodes.get('reference-viewport').clientWidth=0;
 expect(()=>c.unitScaleCamera()).toThrow('CONTROL_CAMERA_UNAVAILABLE');
 expect(()=>c.unitScaleCamera(null)).toThrow('CONTROL_CAMERA_UNAVAILABLE');
 h.nodes.get('rig-pane').hidden=false;h.provider.geometry=()=>null;
 expect(()=>c.unitScaleCamera('rig')).toThrow('CONTROL_CAMERA_UNAVAILABLE');
});

test('#671 synchronized invalid peer refuses atomically before active camera assignment',()=>{
 const h=host(),c=h.controller;
 h.nodes.get('reference-viewport').clientWidth=65537;
 c.state.activeCamera='reference';c.state.cameraCenter={x:13,y:17};c.state.zoom=2;
 const before=structuredClone(c.state);
 expect(()=>c.unitScaleCamera('rig')).toThrow('VIEW_CAMERA_RANGE');
 expect(c.paneCamera('rig')).toEqual({zoom:before.zoom,center:before.cameraCenter});
 expect(c.paneCamera('reference')).toEqual({zoom:before.referenceZoom,center:before.referenceCenter});
 expect(String(c.state.activeCamera)).toBe(before.activeCamera);expect(h.renders()).toBe(0);
 c.state.cameraSync=false;c.unitScaleCamera('rig');expect(c.state.zoom).toBe(.5);
});

test('#671 native-image unit scale retains centered native-one and its existing range',()=>{
 const h=host(),c=createViewportController({...h.provider,nativeScale:true});
 c.updateCamera('rig',{zoom:3,pan:{x:.2,y:-.1}});c.unitScaleCamera('rig');
 expect(c.state.zoom).toBe(1);expect(c.state.referenceZoom).toBe(1);
 expect(c.numericView().cameras.rig!.center).toEqual({x:160,y:120});
 expect(c.numericView().cameras.rig!.visible.width).toBe(640);
 expect(()=>c.writeCamera('rig',{zoom:17,center:null})).toThrow('PARTS_CAMERA_RANGE');
});

test('#671 rig provider renders the same frame scale as numeric cameras for rig and reference',()=>{
 const nodes=new Map<string,any>();
 const el:RigViewportHost['el']=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:640,clientHeight:480,hidden:false,style:{}});return nodes.get(id);};
 const assets={stage:{x:-160,y:0,width:320,height:240}};
 const player={bounds:()=>assets.stage,renderer:{syncPixelRatio(){}},slots:null};
 const state=createViewportState();
 const provider=createRigViewportProvider({el,player:()=>player as any,assets:()=>assets as any,
  referenceSize:()=>({width:1280,height:960}),view:()=> 'both',referenceGeneration:()=>0,parts:()=>null,
  text:()=>{},message:()=>{},redrawOverlay:()=>{}},state);
 const c=createViewportController(provider,state);expect(provider.nativeScale).toBeUndefined();
 // Exercise provider transforms without mounting the optional numeric text node.
 c.renderNumericView=()=>{};
 c.fitCamera();expect(state.zoom).toBe(1);expect(state.referenceZoom).toBe(1);
 for(const target of ['rig','reference'] as const){
  c.unitScaleCamera(target);const frame=c.paneFrame(target)!,camera=c.numericView().cameras[target]!;
  expect(c.paneCamera(target).zoom).toBe(1/frame.baseScale);
  expect(camera.visible.width).toBeCloseTo(640,10);
  expect(target==='rig'?state.rigScale:state.referenceScale).toBeCloseTo(1,12);
  expect(el(target==='rig'?'rig-root':'reference-content').style.transform).toBe(`scale(${frame.baseScale*c.paneCamera(target).zoom})`);
 }
 // Tiny panes retain the legacy final render floor; unavailable unit scale still refuses without camera mutation.
 c.state.cameraSync=false;nodes.get('rig-viewport').clientWidth=20;nodes.get('rig-viewport').clientHeight=20;
 c.fitCamera();expect(state.rigScale).toBe(.001);
 const before=c.paneCamera('rig');expect(()=>c.unitScaleCamera('rig')).toThrow('VIEW_CAMERA_RANGE');
 expect(c.paneCamera('rig')).toEqual(before);
});
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

test('#384 delayed original reference size realigns the canonical pair before any camera gesture',()=>{
 const nodes=new Map<string,any>();const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:450,clientHeight:842,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const canvas={width:590,height:457},reference={width:300,height:150};
 const c=createPartsViewport({el,canvas:canvas as HTMLCanvasElement,reference:()=>reference as HTMLCanvasElement,frameSize:()=>null,message:()=>{}});c.state.cameraSync=true;c.fitCamera();
 expect(c.numericView().cameras.reference!.center).toEqual({x:150,y:75});
 reference.width=590;reference.height=457;c.fitCamera();
 expect(c.numericView().cameras.reference!.center).toEqual(c.numericView().cameras.rig!.center);
 expect(c.numericView().cameras.reference!.center).toEqual({x:295,y:228.5});
});

test('#464 pending parts zoom uses the selected frame and preserves explicit painted camera state',()=>{
 const nodes=new Map<string,any>();
 const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:450,clientHeight:800,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const canvas={width:20,height:16},reference={width:20,height:16};
 let selected={w:20,h:16};
 const c=createPartsViewport({el,canvas:canvas as HTMLCanvasElement,reference:()=>reference as HTMLCanvasElement,frameSize:()=>selected,message:()=>{}});
 c.state.cameraSync=true;c.fitCamera();
 selected={w:8,h:10};
 c.writeCamera('rig',{zoom:1,center:null});c.writeCamera('reference',{zoom:1,center:null});
 c.zoomCamera(1.25);
 const expected={zoom:1.25,center:{x:4,y:5}};
 expect(c.paneCamera('rig')).toEqual(expected);
 expect(c.paneCamera('reference')).toEqual(expected);
 expect(canvas).toEqual({width:20,height:16});
 Object.assign(canvas,{width:8,height:10});Object.assign(reference,canvas);c.fitCamera();
 expect(c.paneCamera('rig')).toEqual(expected);
 c.panCamera('rig',5,-5);
 c.zoomCamera(1.25);
 expect(c.paneCamera('rig')).toEqual({zoom:1.5625,center:{x:0,y:9}});
 c.fitCamera();
 expect(c.paneCamera('rig')).toEqual({zoom:1.5625,center:{x:0,y:9}});
});

test('#613 stage-only resize after first paint keeps displayed parts roots and exported cameras aligned before and after ResizeObserver', () => {
 const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
 const observed: unknown[] = [];
 let resize!: () => void;
 let disconnected = false;
 class Observer {
  constructor(callback: () => void) { resize = callback; }
  observe(node: unknown) { observed.push(node); }
  disconnect() { disconnected = true; }
 }
 Object.defineProperty(globalThis, 'ResizeObserver', {configurable: true, value: Observer});
 const nodes = new Map<string, any>();
 const el = (id: string) => {
  if (!nodes.has(id)) nodes.set(id, {clientWidth: 437, clientHeight: 722, hidden: false, style: {}, setAttribute() {}});
  return nodes.get(id);
 };
 let wrapDuringControls = false;
 Object.defineProperty(el('fit'), 'textContent', {set() {
  if (wrapDuringControls) { wrapDuringControls = false; el('rig-viewport').clientHeight -= 27; }
 }});
 const controller = createPartsViewport({el, canvas: {width: 20, height: 20} as HTMLCanvasElement,
  reference: () => null, frameSize: target => target === 'rig' ? {w: 20, h: 20} : null, message() {}});
 let observer: ResizeObserver | undefined;
 try {
  controller.writeCamera('rig', {zoom: 2.44140625, center: {x: 10, y: 10}});
  controller.fitCamera();
  observer = controller.observeResize();
  expect(observed).toContain(el('rig-viewport'));
  expect(observed).toContain(el('reference-viewport'));
  const verify = () => {
   const camera = controller.numericView().cameras.rig!;
   const origin = projectMark({x: 0, y: 0}, camera);
   expect(camera.viewport.height).toBe(el('rig-viewport').clientHeight);
   expect(parseFloat(el('rig-root').style.top)).toBeCloseTo(origin.y, 10);
   expect(parseFloat(el('rig-root').style.left)).toBeCloseTo(origin.x, 10);
   expect(unprojectMark({x: origin.x + 3 * camera.zoom, y: origin.y + 3 * camera.zoom}, camera).y).toBeCloseTo(3, 10);
   return {height: camera.viewport.height, rootTop: parseFloat(el('rig-root').style.top)};
  };
  const before = verify();
  // No window resize. A wrapped toolbar changes only the mounted pane.
  el('rig-viewport').clientHeight = 695;
  const beforeObserver = verify();
  el('rig-viewport').clientHeight = 722;
  const expandedBeforeObserver = verify();
  // The retained KO root was rendered for 695px while its exported camera used 722px.
  const oldOrigin = {x: 437 / 2 - 10 * 2.44140625, y: 695 / 2 - 10 * 2.44140625};
  const staleNative = unprojectMark({x: oldOrigin.x + 3 * 2.44140625, y: oldOrigin.y + 3 * 2.44140625},
   controller.numericView().cameras.rig!);
  expect(Math.floor(staleNative.y)).toBe(-3);
  resize();
  expect(el('rig-root').style.top).toBe(`${722 / 2 - 10 * 2.44140625}px`);
  verify();
  // A translated control can also change geometry inside the render itself.
  wrapDuringControls = true;
  controller.fitCamera();
  expect(el('rig-root').style.top).toBe(`${695 / 2 - 10 * 2.44140625}px`);
  const afterControlWrap = verify();
  console.log('PARTS_STAGE_RESIZE ' + JSON.stringify({before, beforeObserver, expandedBeforeObserver,
   capturedGeometryStaleNativeY: staleNative.y, capturedGeometrySnappedY: Math.floor(staleNative.y),
   afterControlWrap, windowResize: false}));
 } finally {
  observer?.disconnect();
  if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
 }
 expect(disconnected).toBe(true);
});


test('#671 compiled provider retains the final rendered scale floor below the raw fit floor',()=>{
 const nodes=new Map<string,any>();
 const el:RigViewportHost['el']=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:640,clientHeight:480,hidden:false,style:{}});return nodes.get(id);};
 const assets={stage:{x:-612000,y:0,width:1224000,height:844000}};
 const player={bounds:()=>assets.stage,renderer:{syncPixelRatio(){}},slots:null};
 const state=createViewportState();state.cameraSync=false;state.zoom=.25;state.referenceZoom=.25;
 const provider=createRigViewportProvider({el,player:()=>player as any,assets:()=>assets as any,
  referenceSize:()=>({width:1232000,height:848000}),view:()=> 'both',referenceGeneration:()=>0,parts:()=>null,
  text:()=>{},message:()=>{},redrawOverlay:()=>{}},state);
 const controller=createViewportController(provider,state);controller.renderNumericView=()=>{};
 provider.render(controller);
 // Both panes have a positive raw fit of .0005. The actual shared provider, not a formula surrogate, renders the final floor.
 expect(el('rig-root').style.transform).toBe('scale(0.001)');
 expect(el('reference-content').style.transform).toBe('scale(0.001)');
 expect(state.rigScale).toBe(.001);expect(state.referenceScale).toBe(.001);
 expect(el('fit').textContent).toBe('Fit active');
});

test('#706 requestFit lands once the pane is measured, refits on a later layout, and yields to any camera write',()=>{
 for(const native of [false,true]){
  const h=host(),c=h.controller,rig=h.nodes.get('rig-viewport'),reference=h.nodes.get('reference-viewport');
  h.provider.nativeScale=native;c.state.cameraSync=false;
  const fit=()=>native?Math.min(16,(rig.clientWidth)/320,(rig.clientHeight)/240):1;
  // Not measured yet: the Fit is owed, the camera is left alone (a stale 24% stays until the pane has a size).
  rig.clientWidth=0;reference.clientWidth=0;c.state.zoom=.24;c.requestFit();
  expect(c.paneCamera('rig').zoom).toBe(.24);
  rig.clientWidth=640;reference.clientWidth=640;c.fitCamera();
  expect(c.paneCamera('rig').zoom).toBe(fit());
  // The layout settles later: the camera nobody moved is fitted again.
  rig.clientWidth=900;rig.clientHeight=700;c.fitCamera();
  expect(c.paneCamera('rig').zoom).toBe(fit());
  // A person zooms: a later layout keeps their camera.
  c.zoomCamera(1/1.25,'rig');const moved=c.paneCamera('rig').zoom;expect(moved).not.toBe(fit());
  rig.clientWidth=700;rig.clientHeight=500;c.fitCamera();
  expect(c.paneCamera('rig').zoom).toBe(moved);
  // A restore that sets the camera itself cancels an owed Fit.
  c.requestFit();rig.clientWidth=0;c.cancelFit();c.writeCamera('rig',{zoom:.5,center:null});rig.clientWidth=640;c.fitCamera();
  expect(c.paneCamera('rig').zoom).toBe(.5);
 }
});

test('#706 a held Fit fits each synchronized native pane to its own frame without a range refusal',()=>{
 const h=host(),c=h.controller,rig=h.nodes.get('rig-viewport'),reference=h.nodes.get('reference-viewport');
 h.provider.nativeScale=true;c.state.cameraSync=true;
 // A pane one pixel shorter fits slightly smaller: aligning the other pane's Fit into it would be under its range.
 rig.clientWidth=495;rig.clientHeight=139;reference.clientWidth=495;reference.clientHeight=138;
 h.provider.geometry=()=>({space:'image',box:{x:0,y:0,width:846,height:862},marginX:24,marginY:24});
 expect(()=>c.requestFit()).not.toThrow();
 expect(c.paneCamera('rig').zoom).toBe((139-24)/862);expect(c.paneCamera('reference').zoom).toBe((138-24)/862);
 reference.clientWidth=496;reference.clientHeight=140;expect(()=>c.fitCamera()).not.toThrow();
 expect(c.paneCamera('reference').zoom).toBe((140-24)/862);
});


test('#737 pending parts Fit ignores zero-size entry canvases, settles on real art, and retains later camera actions',()=>{
 const nodes=new Map<string,any>();const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:450,clientHeight:800,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const canvas={width:0,height:0};let drawn:{w:number;h:number}|null=null;
 const c=createPartsViewport({el,canvas:canvas as HTMLCanvasElement,reference:()=>null,frameSize:()=>drawn,message:()=>{}});c.state.cameraSync=false;
 c.requestFit();c.fitCamera();expect(c.paneFrame('rig')).toBeNull();expect(c.numericView().cameras.rig).toBeNull();expect(c.state.zoom).toBe(1);
 drawn={w:1920,h:1080};Object.assign(canvas,{width:1920,height:1080});c.fitCamera();
 expect(c.paneCamera('rig')).toEqual({zoom:(450-24)/1920,center:{x:960,y:540}});
 c.unitScaleCamera('rig');c.zoomCamera(1.25,'rig');const actual=structuredClone(c.paneCamera('rig'));
 // A late initial promise changes neither geometry nor explicit camera; resize delivery must retain it.
 c.fitCamera();expect(c.paneCamera('rig')).toEqual(actual);expect(actual.zoom).toBe(1.25);
});

test('#737 explicit native Fit followed by wider Reference layout must not refuse the camera',()=>{
 const nodes=new Map<string,any>();const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:655,clientHeight:471,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 const canvas={width:1920,height:1080},reference={...canvas};
 const c=createPartsViewport({el,canvas:canvas as HTMLCanvasElement,reference:()=>reference as HTMLCanvasElement,frameSize:()=>({w:1920,h:1080}),message:()=>{}});c.state.cameraSync=true;c.requestFit();c.fitActiveCamera('rig');
 const before=structuredClone(c.paneCamera('reference'));expect(before.zoom).toBe((655-24)/1920);
 el('rig-pane').hidden=true;el('rig-viewport').clientWidth=0;el('reference-viewport').clientWidth=1318;
 console.log('U3_LAYOUT_RANGE_INPUT',JSON.stringify({before,minimumAfter:Math.min((1318-24)/1920,(471-24)/1080),cameraSync:c.state.cameraSync}));
 expect(()=>c.fitCamera()).not.toThrow();
 expect(c.paneCamera('reference')).toEqual({zoom:(471-24)/1080,center:before.center});
});

test('#737 sync native relayout admits a camera when visible peers have unequal fit scales',()=>{
 const nodes=new Map<string,any>();const el=(id:string)=>{if(!nodes.has(id))nodes.set(id,{clientWidth:1318,clientHeight:471,hidden:false,style:{},setAttribute(){}});return nodes.get(id);};
 el('rig-pane').hidden=true;el('rig-viewport').clientWidth=0;
 const c=createPartsViewport({el,canvas:{width:1920,height:1080}as HTMLCanvasElement,reference:()=>({width:3840,height:2160})as HTMLCanvasElement,frameSize:t=>t==='rig'?{w:1920,h:1080}:{w:3840,h:2160},message:()=>{}});c.state.cameraSync=true;c.requestFit();c.fitActiveCamera('reference');
 const before=structuredClone(c.paneCamera('reference'));expect(before.zoom).toBe((471-24)/2160);
 el('rig-pane').hidden=false;el('rig-viewport').clientWidth=655;el('reference-viewport').clientWidth=655;
 console.log('U3_UNEQUAL_NATIVE_RELAYOUT',JSON.stringify({before,minimumRigAfter:(655-24)/1920,minimumReferenceAfter:(655-24)/3840}));
 expect(()=>c.fitCamera()).not.toThrow();
 expect(c.paneCamera('reference')).toEqual({zoom:(655-24)/1920,center:before.center});expect(c.paneCamera('rig')).toEqual({zoom:(655-24)/1920,center:{x:960,y:540}});
});
