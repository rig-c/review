import {expect,test} from 'bun:test';
import {createCanvas,DOMMatrix as TestDOMMatrix} from '@napi-rs/canvas';
import {readFileSync} from 'node:fs';
import {presentJobRigViewport,paintViewportLayers,paintInspectionViewport,paintBackground,viewportBackground,pixelAlignedCrop,displayedCanvasRect,type BackgroundLayer,type ViewportCapture} from '../web/viewport-capture.ts';
import type {ModelAssets,PosedFrame} from '@rig-c/play';
const background:BackgroundLayer[]=[{rect:{x:0,y:0,width:100,height:80},color:'rgb(233, 237, 246)',image:'none',size:'auto',position:'0% 0%'},{rect:{x:0,y:0,width:100,height:80},color:'rgba(0, 0, 0, 0)',image:'radial-gradient(rgba(0, 0, 0, 0.1) 0.7px, rgba(0, 0, 0, 0) 0.7px)',size:'22px 22px',position:'0% 0%'}];
const rgba=(ctx:any,x:number,y:number)=>[...ctx.getImageData(x,y,1,1).data];
test('untransformed viewport canvas copies the native snapped paint boundary, not a half-pixel blurred bitmap',()=>{
 const bitmap=createCanvas(20,20),ink=bitmap.getContext('2d');for(let y=0;y<20;y++){ink.fillStyle=y%2?'rgb(9,200,240)':'rgb(240,230,20)';ink.fillRect(0,y,20,1);}
 for(const ratio of [1,2])for(const origin of [{x:21,y:15},{x:21.5,y:15.25}]){
  const page=createCanvas(80*ratio,70*ratio),screen=page.getContext('2d');screen.scale(ratio,ratio);screen.drawImage(bitmap,Math.round(origin.x*ratio)/ratio,Math.round(origin.y*ratio)/ratio,20,20);
  const area=pixelAlignedCrop({x:2,y:2,width:8,height:8},origin,ratio),layer=displayedCanvasRect({...origin,width:20,height:20},origin,ratio),crop=createCanvas(Math.round(area.width*ratio),Math.round(area.height*ratio)),ctx=crop.getContext('2d');ctx.scale(ratio,ratio);ctx.translate(-area.x,-area.y);ctx.drawImage(bitmap,layer.x,layer.y,layer.width,layer.height);
  expect(Buffer.from(ctx.getImageData(0,0,crop.width,crop.height).data)).toEqual(Buffer.from(screen.getImageData(Math.round((origin.x+area.x)*ratio),Math.round((origin.y+area.y)*ratio),crop.width,crop.height).data));
 }
});
test('fractionally placed viewport crop matches actual page device pixels without a second screenshot interpolation',()=>{
 const image=createCanvas(20,20),ink=image.getContext('2d');for(let y=0;y<20;y++)for(let x=0;x<20;x++){ink.fillStyle=(x+y)%2?'rgb(9,200,240)':'rgb(240,230,20)';ink.fillRect(x,y,1,1);}
 for(const ratio of [1,2])for(const origin of [{x:21,y:15},{x:21.5,y:15.25}]){
  const page=createCanvas(80*ratio,70*ratio),screen=page.getContext('2d');screen.scale(ratio,ratio);screen.drawImage(image,origin.x,origin.y,20,20);
  const area=pixelAlignedCrop({x:2,y:2,width:8,height:8},origin,ratio),crop=createCanvas(Math.round(area.width*ratio),Math.round(area.height*ratio)),ctx=crop.getContext('2d');ctx.scale(ratio,ratio);ctx.translate(-area.x,-area.y);ctx.drawImage(image,0,0,20,20);
  const expected=screen.getImageData(Math.round((origin.x+area.x)*ratio),Math.round((origin.y+area.y)*ratio),crop.width,crop.height).data;
  expect(Buffer.from(ctx.getImageData(0,0,crop.width,crop.height).data)).toEqual(Buffer.from(expected));
 }
});
for(const mode of ['compare','main'])test(`${mode} comment hold preserves the already displayed pose and overlays without replaying a paused inspection`,async()=>{
 const source=readFileSync(new URL(`../web/${mode}.ts`,import.meta.url),'utf8'),body=source.match(/pause:async\(\)=>\{(.*?)\},\s*bookmark:/s)?.[1];expect(body).toBeDefined();
 for(const running of [false,true]){
  let drawnBoneY=40,held=false;const camera={x:2,y:3,zoom:1.5};
  const context:any={idleHeld:false,seekingControl:false,playing:running,time:.5,trace:{reference:.5},lastPresented:{time:.5},video:{paused:!running,readyState:4},player:{time:.5}};
  context.stop=context.pause=()=>{context.video.paused=true;context.playing=false;};
  context.seekTo=context.inspectControlTime=async()=>{drawnBoneY+=10;};
  context.turnPad={snapshot:()=>({held,values:{yaw:7.25}}),restore:(snapshot:any,redraw=true)=>{held=snapshot.held;if(redraw)drawnBoneY+=10;}};
  const hold=new Function('context',`with(context){return async()=>{${body}}}`)(context);await hold();
  expect(context.video.paused).toBe(true);expect(held).toBe(true);expect(camera).toEqual({x:2,y:3,zoom:1.5});
  // A still view is evidence already: replaying it changes history-dependent bone/overlay pixels.
  if(!running)expect(drawnBoneY).toBe(40);
 }
});
test('viewport crop uses inherited light pane pixels and anchored grid, not media black',()=>{
 const full=createCanvas(100,80),ctx=full.getContext('2d');paintViewportLayers(ctx as any,{x:0,y:0,width:100,height:80},background,false,()=>{throw Error('images disabled');},[]);expect(rgba(ctx,5,5)).toEqual([233,237,246,255]);expect(rgba(ctx,11,11)[0]).toBeLessThan(233);
 const crop=createCanvas(30,30),cut=crop.getContext('2d');cut.translate(-8,-6);paintViewportLayers(cut as any,{x:8,y:6,width:30,height:30},background,false,()=>{},[]);expect(Buffer.from(cut.getImageData(0,0,30,30).data)).toEqual(Buffer.from(ctx.getImageData(8,6,30,30).data));
});
test('Images off removes model pixels while actual mesh/bone overlay canvas pixels remain; Images on composes in shown order',()=>{
 const overlay=createCanvas(10,10),ink=overlay.getContext('2d');ink.fillStyle='rgb(12,200,25)';ink.fillRect(1,1,4,4);let imageDraws=0;
 const render=(images:boolean)=>{const canvas=createCanvas(100,80),ctx=canvas.getContext('2d');paintViewportLayers(ctx as any,{x:0,y:0,width:100,height:80},background,images,()=>{imageDraws++;ctx.fillStyle='rgb(220,40,20)';ctx.fillRect(1,1,70,70);},[{image:overlay as any,rect:{x:10,y:10,width:10,height:10},opacity:1}]);return ctx;};
 const hidden=render(false);expect(imageDraws).toBe(0);expect(rgba(hidden,5,5)).toEqual([233,237,246,255]);expect(rgba(hidden,12,12)).toEqual([12,200,25,255]);
 const shown=render(true);expect(imageDraws).toBe(1);expect(rgba(shown,5,5)).toEqual([220,40,20,255]);expect(rgba(shown,12,12)).toEqual([12,200,25,255]);
});

function copiedViewport(run:(capture:ViewportCapture,render:(includeOverlays?:boolean)=>{getContext(type:'2d'):unknown},filter:(value:string)=>void)=>void) {
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');
 const image=createCanvas(20,20),overlay=createCanvas(20,20);
 image.getContext('2d').fillStyle='rgb(240,20,10)';image.getContext('2d').fillRect(0,0,20,20);
 overlay.getContext('2d').fillStyle='rgb(10,240,20)';overlay.getContext('2d').fillRect(0,0,20,20);
 const rect=()=>({left:0,top:0,x:0,y:0,width:100,height:80});
 Object.assign(image,{getBoundingClientRect:()=>({...rect(),width:20,height:20})});
 Object.assign(overlay,{getBoundingClientRect:()=>({...rect(),width:20,height:20})});
 const pane={getBoundingClientRect:rect,clientLeft:0,clientTop:0,clientWidth:100,clientHeight:80,parentElement:null,
  querySelectorAll:()=>[overlay]} as unknown as HTMLElement;
 let filter='none';
 Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:(node:unknown)=>({
  display:'block',visibility:'visible',opacity:'1',transform:'none',filter,
  backgroundColor:node===pane?'rgb(233,237,246)':'transparent',backgroundImage:'none',backgroundSize:'auto',backgroundPosition:'0% 0%',
 })});
 const capture:ViewportCapture={pane,canvas:image as unknown as HTMLCanvasElement,images:true,backend:'canvas2d',strictActualPixels:true};
 const camera={space:'world' as const,center:{x:50,y:40},zoom:1,viewport:{width:100,height:80},visible:{x:0,y:0,width:100,height:80}};
 const render=(includeOverlays?:boolean)=>{const output=createCanvas(100,80);paintInspectionViewport(output.getContext('2d') as unknown as CanvasRenderingContext2D,
  {x:0,y:0,width:100,height:80},{...capture,includeOverlays},{camera});return output;};
 try{run(capture,render,value=>{filter=value;});}
 finally{if(descriptor)Object.defineProperty(globalThis,'getComputedStyle',descriptor);else Reflect.deleteProperty(globalThis,'getComputedStyle');}
}

test('#557 strict displayed canvas copies pixels/background while overlay exclusion preserves legacy defaults',()=>{
 copiedViewport((_capture,render)=>{
  const strict=render(false).getContext('2d'),legacy=render().getContext('2d');
  expect(rgba(strict,5,5)).toEqual([240,20,10,255]);
  expect(rgba(strict,60,60)).toEqual([233,237,246,255]);
  expect(rgba(legacy,5,5)).toEqual([10,240,20,255]);
 });
});

test('#557 strict actual pixels refuse unseen renderer fallback and filtered canvas',()=>{
 copiedViewport((capture,render,filter)=>{
  const canvas=createCanvas(100,80),context=canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  const camera={space:'world' as const,center:{x:50,y:40},zoom:1,viewport:{width:100,height:80},visible:{x:0,y:0,width:100,height:80}};
  expect(()=>paintInspectionViewport(context,{x:0,y:0,width:100,height:80},{...capture,canvas:undefined,includeOverlays:false},
   {camera,posed:{order:[],generation:1},assets:{} as ModelAssets})).toThrow('JOB_STILL_CAPTURE_FAILED');
  filter('blur(1px)');
  expect(()=>render(false)).toThrow('JOB_STILL_CAPTURE_FAILED');
 });
});

/** Synthetic page compositor control over the normal DOM-raster capture entry. */
function domRasterPlacement(run:(render:(strict:boolean,ratio:number,clip?:boolean,transform?:string)=>Buffer,
 expected:(strict:boolean,ratio:number,clip?:boolean,untransformed?:boolean)=>Buffer)=>void) {
 const keys=['getComputedStyle','DOMMatrix','HTMLCanvasElement','HTMLImageElement','devicePixelRatio'] as const;
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 const bitmap=createCanvas(20,20),ink=bitmap.getContext('2d');
 for(let y=0;y<20;y++){ink.fillStyle=y%2?'rgb(20,220,40)':'rgb(240,40,30)';ink.fillRect(0,y,20,1);}
 const paneRect={left:5.5,top:6.25,width:60,height:40};
 const canvasRect={left:28.875,top:16.5,width:19.75,height:19.5};
 Object.assign(bitmap,{getBoundingClientRect:()=>canvasRect});
 const pane={clientLeft:0,clientTop:0,clientWidth:60,clientHeight:40,parentElement:null,
  getBoundingClientRect:()=>paneRect,querySelectorAll:()=>[]};
 const root={children:[bitmap],getBoundingClientRect:()=>({left:20.25,top:10.25})};
 let transform='matrix(0.5,0,0,0.5,4.3125,3.125)';
 Object.defineProperty(globalThis,'DOMMatrix',{configurable:true,value:TestDOMMatrix});
 Object.defineProperty(globalThis,'HTMLCanvasElement',{configurable:true,value:bitmap.constructor});
 Object.defineProperty(globalThis,'HTMLImageElement',{configurable:true,value:class TestImage {}});
 Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:(node:unknown)=>({
  display:'block',visibility:'visible',opacity:node===bitmap?'0.65':'1',filter:'none',transformOrigin:'0px 0px',
  transform:node===root?(transform==='none'?'none':'matrix(2,0,0,2,0,0)'):node===bitmap?transform:'none',zIndex:'0',
  width:'20px',height:'20px',mixBlendMode:'multiply',backgroundColor:node===pane?'rgb(180,190,200)':'transparent',
  backgroundImage:'none',backgroundSize:'auto',backgroundPosition:'0% 0%',
 })});
 const frame=(clip:boolean):PosedFrame=>({generation:1,order:[{kind:'mesh',slot:'mesh',z:0,blend:'Normal',
  tint:[1,1,1,1],page:'mesh.png',pma:false,vertices:[0,0,20,0,20,20],uvs:[0,0,1,0,1,1],triangles:[0,1,2],sequence:0,
  ...(clip?{clip:{polygon:[25,15,35,15,35,25,25,25],inverse:false,convex:true}}:{})}]});
 const camera={space:'world' as const,center:{x:30,y:20},zoom:1,viewport:{width:60,height:40},visible:{x:0,y:0,width:60,height:40}};
 function render(strict:boolean,ratio:number,clip=false,matrix='matrix(0.5,0,0,0.5,4.3125,3.125)') {
  transform=matrix;
  Object.defineProperty(globalThis,'devicePixelRatio',{configurable:true,value:ratio});
  const area=pixelAlignedCrop({x:0,y:0,width:60,height:40},{x:5.5,y:6.25},ratio);
  const output=createCanvas(Math.round(area.width*ratio),Math.round(area.height*ratio)),context=output.getContext('2d');
  context.scale(ratio,ratio);context.translate(-area.x,-area.y);
  paintInspectionViewport(context as unknown as CanvasRenderingContext2D,area,
   {pane:pane as unknown as HTMLElement,root:root as unknown as HTMLElement,images:true,backend:'canvas2d',
    strictActualPixels:strict,includeOverlays:false},{camera,posed:frame(clip),assets:{} as ModelAssets});
  return Buffer.from(context.getImageData(0,0,output.width,output.height).data);
 }
 function expected(strict:boolean,ratio:number,clip=false,untransformed=false) {
  const page=createCanvas(100*ratio,80*ratio),context=page.getContext('2d');context.scale(ratio,ratio);
  context.fillStyle='rgb(180,190,200)';context.fillRect(0,0,100,80);
  if(clip){context.beginPath();context.rect(30.5,21.25,10,10);context.clip();}
  context.globalAlpha=.65;context.globalCompositeOperation='multiply';
  const x0=untransformed?Math.round(28.875*ratio)/ratio:28.875;
  const y0=untransformed?Math.round(16.5*ratio)/ratio:16.5;
  const width=untransformed?Math.round(48.625*ratio)/ratio-x0:strict?19.75:20;
  const height=untransformed?Math.round(36*ratio)/ratio-y0:strict?19.5:20;
  context.drawImage(bitmap,x0,y0,width,height);
  const x=Math.ceil(5.5*ratio),y=Math.ceil(6.25*ratio);
  return Buffer.from(context.getImageData(x,y,Math.floor(65.5*ratio)-x,Math.floor(46.25*ratio)-y).data);
 }
 try{run(render,expected);}
 finally{for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
}

test('#557 strict transformed DOM canvas preserves actual fractional rect at DPR 1 and 2 with clip/blend/opacity intact',()=>{
 domRasterPlacement((render,expected)=>{for(const ratio of [1,2])for(const clip of [false,true]){
  expect(render(true,ratio,clip)).toEqual(expected(true,ratio,clip));
 }});
});
test('#557 strict untransformed DOM canvas retains snapped device-edge semantics',()=>{
 domRasterPlacement((render,expected)=>{
  for(const ratio of [1,2])expect(render(true,ratio,false,'none')).toEqual(expected(true,ratio,false,true));
 });
});
test('#557 legacy DOM canvas retains its fractional matrix placement',()=>{
 domRasterPlacement((render,expected)=>{
  expect(render(false,1)).toEqual(expected(false,1));
  expect(render(false,1).equals(render(true,1))).toBe(false);
 });
});
test('#557 strict rotated or reflected DOM canvas refuses instead of transformed fallback',()=>{
 domRasterPlacement(render=>{
  for(const transform of ['matrix(0,1,-1,0,4.3125,3.125)','matrix(-0.5,0,0,0.5,4.3125,3.125)']){
   expect(()=>render(true,1,false,transform)).toThrow('JOB_STILL_CAPTURE_FAILED');
   expect(()=>render(false,1,false,transform)).not.toThrow();
  }
 });
});

test('#557 strict background uses recorded fractional CSS boxes while default keeps client dimensions',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'getComputedStyle');
 const stage={getBoundingClientRect:()=>({left:838.5,top:144,width:593.5,height:164}),clientLeft:1,clientTop:1,clientWidth:592,clientHeight:162,parentElement:null};
 const pane={getBoundingClientRect:()=>({left:839.5,top:145,width:591.5,height:162}),clientLeft:0,clientTop:0,clientWidth:592,clientHeight:162,parentElement:stage};
 Object.defineProperty(globalThis,'getComputedStyle',{configurable:true,value:(node:unknown)=>({
  transform:'none',borderLeftWidth:node===stage?'1px':'0px',borderRightWidth:node===stage?'1px':'0px',
  borderTopWidth:node===stage?'1px':'0px',borderBottomWidth:node===stage?'1px':'0px',
  paddingLeft:'0px',paddingRight:'0px',paddingTop:'0px',paddingBottom:'0px',backgroundOrigin:'padding-box',backgroundClip:'border-box',
  backgroundColor:'transparent',backgroundImage:'none',backgroundSize:'auto',backgroundPosition:'0% 0%',
 })});
 try{
  const strict=viewportBackground(pane as unknown as HTMLElement,true),legacy=viewportBackground(pane as unknown as HTMLElement);
  expect(strict.map(layer=>layer.rect.width)).toEqual([591.5,591.5]);
  expect(strict[0]!.rect).toEqual({x:0,y:0,width:591.5,height:162});
  expect(strict[0]!.clip).toEqual({x:-1,y:-1,width:593.5,height:164});
  expect(strict[0]!.rect.width/2).toBe(295.75);
  expect(legacy.map(layer=>layer.rect.width)).toEqual([592,592]);
  expect(legacy[0]).not.toHaveProperty('clip');
 }finally{if(descriptor)Object.defineProperty(globalThis,'getComputedStyle',descriptor);else Reflect.deleteProperty(globalThis,'getComputedStyle');}
});

test('#557 strict 22px hard-stop tile samples pixel centres without arc AA and preserves default painting',()=>{
 const keys=['document','DOMMatrix','devicePixelRatio'] as const;
 const descriptors=keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>createCanvas(1,1)}});
 Object.defineProperty(globalThis,'DOMMatrix',{configurable:true,value:TestDOMMatrix});
 const layers:BackgroundLayer[]=[{rect:{x:0,y:0,width:44,height:44},color:'rgb(233,237,246)',image:'none',size:'auto',position:'0% 0%'},
  {rect:{x:0,y:0,width:44,height:44},color:'transparent',image:'radial-gradient(rgba(127,139,166,0.2) 0.7px, rgba(0,0,0,0) 0.7px)',size:'22px 22px',position:'0% 0%'}];
 const count=(strict:boolean,ratio:number)=>{
  Object.defineProperty(globalThis,'devicePixelRatio',{configurable:true,value:ratio});
  const canvas=createCanvas(44*ratio,44*ratio),context=canvas.getContext('2d');context.scale(ratio,ratio);
  const smoothing=context.imageSmoothingEnabled;
  paintBackground(context as unknown as CanvasRenderingContext2D,layers,{x:0,y:0,width:44,height:44},strict);
  expect(context.imageSmoothingEnabled).toBe(smoothing);
  const data=context.getImageData(0,0,canvas.width,canvas.height).data;let changed=0;
  for(let i=0;i<data.length;i+=4)if(data[i]!==233||data[i+1]!==237||data[i+2]!==246||data[i+3]!==255)changed++;
  return changed;
 };
 try{
  expect(Math.hypot(.5,.5)).toBeGreaterThan(.7);
  expect(count(true,1)).toBe(0);
  expect(count(true,2)).toBe(16);
  expect(count(false,1)).toBeGreaterThan(0);
 }finally{for(const [key,descriptor]of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}}
});


for (const ratio of [1, 2]) {
 test(`#557 normal canonical presentation covers fractional viewport at DPR ${ratio} before capture`, () => {
  const keys = ['document', 'devicePixelRatio'] as const;
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {createElement() {
   return Object.assign(createCanvas(1, 1), {style: {}, dataset: {}});
  }}});
  Object.defineProperty(globalThis, 'devicePixelRatio', {configurable: true, value: ratio});
  try {
   copiedViewport((capture, _render, filter) => {
    capture.pane.getBoundingClientRect = () => ({left: 5.5, top: 6.25, width: 100, height: 80}) as DOMRect;
    const camera = {space: 'world' as const, center: {x: 50, y: 40}, zoom: 1,
     viewport: {width: 100, height: 80}, visible: {x: 0, y: 0, width: 100, height: 80}};
    const surface = presentJobRigViewport(capture, {camera});
    const area = pixelAlignedCrop({x: 0, y: 0, width: 100, height: 80}, {x: 5.5, y: 6.25}, ratio);
    expect(surface.area).toEqual(area);
    expect([surface.width, surface.height]).toEqual([Math.round(area.width * ratio), Math.round(area.height * ratio)]);
    expect(surface.canvas.style.left).toBe(`${area.x}px`);
    expect(surface.canvas.style.top).toBe(`${area.y}px`);
    expect(surface.canvas.style.width).toBe(`${surface.width / ratio}px`);
    const pixels = surface.canvas.getContext('2d')!;
    expect(rgba(pixels, surface.width - 1, surface.height - 1)).toEqual([233, 237, 246, 255]);
    filter('blur(1px)');
    expect(() => presentJobRigViewport(capture, {camera})).toThrow('JOB_STILL_CAPTURE_FAILED');
   });
  } finally {
   for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
   }
  }
 });
}

test('#772 gallery crop copies displayed DOM rasters through the shared compositor and refuses undecoded members',()=>{
 copiedViewport((capture,render)=>{
  const image=capture.canvas! as unknown as HTMLImageElement;
  Object.assign(image,{complete:true,naturalWidth:20,naturalHeight:20});
  capture.rasters=[image];delete capture.canvas;
  expect(rgba(render(false).getContext('2d'),5,5)).toEqual([240,20,10,255]);
  expect(rgba(render(false).getContext('2d'),60,60)).toEqual([233,237,246,255]);
  Object.assign(image,{complete:false});
  expect(()=>render(false)).toThrow('COMMENT_CROP_UNAVAILABLE: this viewport has no rendered pixels');
 });
});
