import {expect,test} from 'bun:test';
import {createCanvas} from '@napi-rs/canvas';
import {readFileSync} from 'node:fs';
import {paintViewportLayers,pixelAlignedCrop,displayedCanvasRect,type BackgroundLayer} from '../web/viewport-capture.ts';
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
