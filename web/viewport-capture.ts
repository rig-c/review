/** Pixel composition for the inspection viewport; no DOM serialization or screenshot API. */
import {CanvasRenderer,type CanvasBackend,type ModelAssets,type PosedFrame} from '@rig-c/play';
import type {ControlNumericCamera} from '../src/control.ts';
import {projectMark,type MarkRegion} from '../src/stage-comment.ts';
export interface CaptureRect {x:number;y:number;width:number;height:number}
/** Untransformed replaced canvases are painted at snapped device-pixel edges by the page compositor. */
export function displayedCanvasRect(rect:CaptureRect,origin:{x:number;y:number},ratio=1):CaptureRect{
 const x=Math.round(rect.x*ratio)/ratio,y=Math.round(rect.y*ratio)/ratio;
 return {x:x-origin.x,y:y-origin.y,width:Math.round((rect.x+rect.width)*ratio)/ratio-x,height:Math.round((rect.y+rect.height)*ratio)/ratio-y};
}
/** Keep whole displayed device pixels. Fractional CSS pane placement must not resample an already composited screenshot again. */
export function pixelAlignedCrop(area:CaptureRect,origin:{x:number;y:number},ratio=1):CaptureRect{
 const x=Math.ceil((origin.x+area.x)*ratio)/ratio-origin.x,y=Math.ceil((origin.y+area.y)*ratio)/ratio-origin.y;
 return {x,y,width:Math.max(0,Math.floor((origin.x+area.x+area.width)*ratio)/ratio-origin.x-x),height:Math.max(0,Math.floor((origin.y+area.y+area.height)*ratio)/ratio-origin.y-y)};
}
export interface BackgroundLayer {rect:CaptureRect;color:string;image:string;size:string;position:string}
export interface PixelLayer {image:CanvasImageSource;rect:CaptureRect;opacity:number}
export interface ViewportCapture {pane:HTMLElement;root?:HTMLElement;images:boolean;canvas?:HTMLCanvasElement;backend:CanvasBackend}
const transparent=(color:string)=>color==='transparent'||/^rgba\([^)]*,\s*0\s*\)$/.test(color);
/** Read only this app's computed backgrounds, in their actual viewport coordinates. */
export function viewportBackground(pane:HTMLElement):BackgroundLayer[]{
 const origin=pane.getBoundingClientRect(),x=origin.left+pane.clientLeft,y=origin.top+pane.clientTop,result:BackgroundLayer[]=[];
 for(let node:HTMLElement|null=pane;node;node=node.parentElement){const style=getComputedStyle(node),rect=node.getBoundingClientRect();result.unshift({rect:{x:rect.left+node.clientLeft-x,y:rect.top+node.clientTop-y,width:node.clientWidth,height:node.clientHeight},color:style.backgroundColor,image:style.backgroundImage,size:style.backgroundSize,position:style.backgroundPosition});}
 return result;
}
/** These are the app's solid, stage-ellipse and grid backgrounds, not an HTML rasterizer. */
export function paintBackground(ctx:CanvasRenderingContext2D,layers:BackgroundLayer[],area:CaptureRect):void {
 for(const layer of layers){const r=layer.rect;if(!transparent(layer.color)){ctx.fillStyle=layer.color;ctx.fillRect(r.x,r.y,r.width,r.height);}if(!layer.image||layer.image==='none')continue;
  const colors=layer.image.match(/rgba?\([^)]+\)|#[\da-f]+/gi)??[];if(!layer.image.startsWith('radial-gradient(')||colors.length!==2)throw new Error('COMMENT_BACKGROUND_UNAVAILABLE: unsupported viewport background');
  const sizes=layer.size.split(/\s+/).map(Number.parseFloat),radius=layer.image.match(/\)\s+([\d.]+)px/);
  if(radius&&sizes.length===2&&sizes.every(n=>Number.isFinite(n)&&n>0)){
   const [sx,sy]=sizes as [number,number],position=layer.position.split(/\s+/),offset=(v:string,extent:number,tile:number)=>v.endsWith('%')?(extent-tile)*parseFloat(v)/100:parseFloat(v);
   const ox=r.x+offset(position[0]??'0%',r.width,sx),oy=r.y+offset(position[1]??'0%',r.height,sy);ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.width,r.height);ctx.clip();ctx.fillStyle=colors[0]!;
   for(let y=oy+Math.floor((area.y-oy)/sy)*sy+sy/2;y<area.y+area.height+sy;y+=sy)for(let x=ox+Math.floor((area.x-ox)/sx)*sx+sx/2;x<area.x+area.width+sx;x+=sx){ctx.beginPath();ctx.arc(x,y,Number(radius[1]),0,Math.PI*2);ctx.fill();}ctx.restore();
  }else{
   const position=layer.image.match(/at\s+([\d.]+)%\s+([\d.]+)%/),end=layer.image.match(/([\d.]+)%\s*\)$/);if(!position||!end)throw new Error('COMMENT_BACKGROUND_UNAVAILABLE: unknown stage ellipse');
   const cx=r.width*Number(position[1])/100,cy=r.height*Number(position[2])/100,rx=Math.max(cx,r.width-cx)*Math.SQRT2,ry=Math.max(cy,r.height-cy)*Math.SQRT2;if(rx<=0||ry<=0)continue;
   ctx.save();ctx.translate(r.x+cx,r.y+cy);ctx.scale(rx,ry);const gradient=ctx.createRadialGradient(0,0,0,0,0,1);gradient.addColorStop(0,colors[0]!);gradient.addColorStop(Number(end[1])/100,colors[1]!);gradient.addColorStop(1,colors[1]!);ctx.fillStyle=gradient;ctx.fillRect(-cx/rx,-cy/ry,r.width/rx,r.height/ry);ctx.restore();
  }
 }
}
export function paintViewportLayers(ctx:CanvasRenderingContext2D,area:CaptureRect,background:BackgroundLayer[],images:boolean,drawImages:()=>void,overlays:PixelLayer[]):void {
 ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.width,area.height);ctx.clip();paintBackground(ctx,background,area);if(images)drawImages();
 for(const layer of overlays){ctx.save();ctx.globalAlpha=layer.opacity;ctx.drawImage(layer.image,layer.rect.x,layer.rect.y,layer.rect.width,layer.rect.height);ctx.restore();}ctx.restore();
}
function displayedPixels(canvas:HTMLCanvasElement,pane:HTMLElement,snap=true):PixelLayer|null {
 const style=getComputedStyle(canvas);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)return null;const a=canvas.getBoundingClientRect(),b=pane.getBoundingClientRect(),origin={x:b.left+pane.clientLeft,y:b.top+pane.clientTop};return {image:canvas,rect:snap&&style.transform==='none'?displayedCanvasRect({x:a.left,y:a.top,width:a.width,height:a.height},origin,globalThis.devicePixelRatio||1):{x:a.left-origin.x,y:a.top-origin.y,width:a.width,height:a.height},opacity:Number(style.opacity)};
}
/** Copy only unambiguous, normal-filter DOM rasters whose z matches the public held frame.
 * CSS transforms are read from the actual displayed elements; no private player fields. */
function displayedRig(ctx:CanvasRenderingContext2D,capture:ViewportCapture,frame:PosedFrame,camera:ControlNumericCamera):boolean {
 const root=capture.root;if(!root)return false;const children=[...root.children].filter((n):n is HTMLImageElement|HTMLCanvasElement=>n instanceof HTMLImageElement||n instanceof HTMLCanvasElement).filter(n=>getComputedStyle(n).display!=='none');
 const byZ=new Map<number,HTMLImageElement|HTMLCanvasElement>();for(const node of children){const style=getComputedStyle(node),z=Number(style.zIndex);if(style.filter!=='none'||style.transformOrigin!=='0px 0px'||!Number.isSafeInteger(z)||byZ.has(z))return false;byZ.set(z,node);}
 if(children.length!==frame.order.length||frame.order.some(row=>!byZ.has(row.z)))return false;
 const r=root.getBoundingClientRect(),p=capture.pane.getBoundingClientRect(),rootMatrix=new DOMMatrix(getComputedStyle(root).transform);if(!rootMatrix.is2D||rootMatrix.b!==0||rootMatrix.c!==0||rootMatrix.a<=0||rootMatrix.d<=0||getComputedStyle(root).transformOrigin!=='0px 0px')return false;
 const plans=frame.order.map(row=>{const node=byZ.get(row.z)!,style=getComputedStyle(node);return {row,node,style,m:new DOMMatrix(style.transform),width:parseFloat(style.width),height:parseFloat(style.height)};});if(plans.some(p=>!p.m.is2D||![p.width,p.height].every(n=>Number.isFinite(n)&&n>0)))return false;
 for(const {row,node,style,m,width,height}of plans){
  ctx.save();if(row.clip){ctx.beginPath();if(row.clip.inverse)ctx.rect(0,0,camera.viewport.width,camera.viewport.height);for(let i=0;i<row.clip.polygon.length;i+=2){const at=projectMark({x:row.clip.polygon[i]!,y:row.clip.polygon[i+1]!},camera);if(i===0)ctx.moveTo(at.x,at.y);else ctx.lineTo(at.x,at.y);}ctx.closePath();ctx.clip(row.clip.inverse?'evenodd':'nonzero');}
  ctx.globalAlpha=Number(style.opacity);ctx.globalCompositeOperation=style.mixBlendMode==='plus-lighter'?'lighter':style.mixBlendMode==='normal'?'source-over':style.mixBlendMode as GlobalCompositeOperation;
  ctx.transform(rootMatrix.a*m.a,rootMatrix.d*m.b,rootMatrix.a*m.c,rootMatrix.d*m.d,r.left-p.left-capture.pane.clientLeft+rootMatrix.a*m.e,r.top-p.top-capture.pane.clientTop+rootMatrix.d*m.f);ctx.drawImage(node,0,0,width,height);ctx.restore();
 }return true;
}
export function paintInspectionViewport(ctx:CanvasRenderingContext2D,area:MarkRegion,capture:ViewportCapture,pose:{camera:ControlNumericCamera;posed?:PosedFrame;assets?:ModelAssets;media?:HTMLVideoElement|HTMLImageElement}):void {
 const overlays=[...capture.pane.querySelectorAll<HTMLCanvasElement>('canvas')].filter(node=>!capture.root?.contains(node)&&node!==capture.canvas).map(node=>displayedPixels(node,capture.pane)).filter((v):v is PixelLayer=>v!==null);
 paintViewportLayers(ctx,area,viewportBackground(capture.pane),capture.images,()=>{
  if(capture.canvas){const pixels=displayedPixels(capture.canvas,capture.pane,!capture.root?.contains(capture.canvas));if(pixels){ctx.save();ctx.globalAlpha=pixels.opacity;ctx.drawImage(pixels.image,pixels.rect.x,pixels.rect.y,pixels.rect.width,pixels.rect.height);ctx.restore();return;}}
  if(pose.posed&&pose.assets){if(displayedRig(ctx,capture,pose.posed,pose.camera))return;
   if(capture.backend==='canvas2d'&&pose.posed.order.some(row=>row.tint.slice(0,3).some(c=>c!==1)||row.dark?.some(c=>c!==0)))throw new Error('COMMENT_CAPTURE_UNAVAILABLE: Canvas2D cannot reproduce active RGB/dark tint');
   const root=document.createElement('div'),renderer=new CanvasRenderer(root,pose.assets.pageImages);try{renderer.backend=capture.backend;renderer.viewport={...pose.camera.visible};renderer.pixelRatio=pose.camera.viewport.width/pose.camera.visible.width;renderer.render(pose.posed);ctx.drawImage(renderer.canvas,0,0,pose.camera.viewport.width,pose.camera.viewport.height);}finally{renderer.dispose();}
  }else if(pose.media){const media=pose.media,style=getComputedStyle(media),a=media.getBoundingClientRect(),b=capture.pane.getBoundingClientRect();if(!transparent(style.backgroundColor)){ctx.fillStyle=style.backgroundColor;ctx.fillRect(a.left-b.left-capture.pane.clientLeft,a.top-b.top-capture.pane.clientTop,a.width,a.height);}const w=media instanceof HTMLVideoElement?media.videoWidth:media.naturalWidth,h=media instanceof HTMLVideoElement?media.videoHeight:media.naturalHeight,first=projectMark({x:0,y:0},pose.camera),last=projectMark({x:w,y:h},pose.camera);ctx.drawImage(media,first.x,first.y,last.x-first.x,last.y-first.y);
  }else throw new Error('COMMENT_CROP_UNAVAILABLE: this viewport has no rendered pixels');
 },overlays);
}
