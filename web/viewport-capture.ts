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
export interface BackgroundLayer {rect:CaptureRect;color:string;image:string;size:string;position:string;clip?:CaptureRect}
export interface PixelLayer {image:CanvasImageSource;rect:CaptureRect;opacity:number}
export interface ViewportCapture {pane:HTMLElement;root?:HTMLElement;images:boolean;canvas?:HTMLCanvasElement;backend:CanvasBackend;nearest?:boolean;strictActualPixels?:boolean;includeOverlays?:boolean}
const transparent=(color:string)=>color==='transparent'||/^rgba\([^)]*,\s*0\s*\)$/.test(color);
const cssMatrix=(transform:string)=>transform==='none'?new DOMMatrix():new DOMMatrix(transform);
/** Read only this app's computed backgrounds, in their actual viewport coordinates. */
export function viewportBackground(pane:HTMLElement,strict=false):BackgroundLayer[]{
 const origin=pane.getBoundingClientRect(),x=origin.left+pane.clientLeft,y=origin.top+pane.clientTop,result:BackgroundLayer[]=[];
 for(let node:HTMLElement|null=pane;node;node=node.parentElement){
  const style=getComputedStyle(node),rect=node.getBoundingClientRect();
  let positioning={x:rect.left+node.clientLeft-x,y:rect.top+node.clientTop-y,width:node.clientWidth,height:node.clientHeight};
  let clip:CaptureRect|undefined;
  if(strict){
   if(style.transform!=='none')throw new Error('JOB_STILL_CAPTURE_FAILED');
   const number=(value:string)=>parseFloat(value)||0;
   const border={left:number(style.borderLeftWidth),right:number(style.borderRightWidth),top:number(style.borderTopWidth),bottom:number(style.borderBottomWidth)};
   const padding={left:number(style.paddingLeft),right:number(style.paddingRight),top:number(style.paddingTop),bottom:number(style.paddingBottom)};
   const borderBox={x:rect.left-x,y:rect.top-y,width:rect.width,height:rect.height};
   const paddingBox={x:borderBox.x+border.left,y:borderBox.y+border.top,width:borderBox.width-border.left-border.right,height:borderBox.height-border.top-border.bottom};
   const contentBox={x:paddingBox.x+padding.left,y:paddingBox.y+padding.top,width:paddingBox.width-padding.left-padding.right,height:paddingBox.height-padding.top-padding.bottom};
   const boxes={'border-box':borderBox,'padding-box':paddingBox,'content-box':contentBox};
   const originName=style.backgroundOrigin||'padding-box',clipName=style.backgroundClip||'border-box';
   if(!Object.hasOwn(boxes,originName)||!Object.hasOwn(boxes,clipName))throw new Error('JOB_STILL_CAPTURE_FAILED');
   positioning=boxes[originName as keyof typeof boxes];clip=boxes[clipName as keyof typeof boxes];
  }
  result.unshift({rect:positioning,color:style.backgroundColor,image:style.backgroundImage,size:style.backgroundSize,position:style.backgroundPosition,...(clip?{clip}:{})});
 }
 return result;
}
/** Rasterize a CSS hard-stop tile before repeating it. Coverage is sampled at device-pixel centres. */
function paintHardStopTile(ctx:CanvasRenderingContext2D,layer:BackgroundLayer,colors:string[],sx:number,sy:number,radius:number,ox:number,oy:number):void {
 const ratio=globalThis.devicePixelRatio||1,width=sx*ratio,height=sy*ratio;
 const stops=[...layer.image.matchAll(/\)\s+([\d.]+)px/g)].map(match=>Number(match[1]));
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>16384||height>16384||width*height>16777216||
   stops.length!==2||stops.some(stop=>stop!==radius)||!transparent(colors[1]!))throw new Error('JOB_STILL_CAPTURE_FAILED');
 const tile=document.createElement('canvas');tile.width=width;tile.height=height;
 const pixels=tile.getContext('2d');if(!pixels)throw new Error('JOB_STILL_CAPTURE_FAILED');
 pixels.fillStyle=colors[0]!;pixels.fillRect(0,0,width,height);
 const image=pixels.getImageData(0,0,width,height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  if(Math.hypot((x+.5)/ratio-sx/2,(y+.5)/ratio-sy/2)>radius)image.data.fill(0,(y*width+x)*4,(y*width+x+1)*4);
 }
 pixels.putImageData(image,0,0);
 const clip=layer.clip??layer.rect;
 const firstX=ox+Math.floor((clip.x-ox)/sx)*sx,firstY=oy+Math.floor((clip.y-oy)/sy)*sy;
 ctx.save();
 try{
  ctx.imageSmoothingEnabled=false;
  for(let y=firstY;y<clip.y+clip.height;y+=sy)for(let x=firstX;x<clip.x+clip.width;x+=sx)ctx.drawImage(tile,x,y,sx,sy);
 }finally{ctx.restore();}
}
/** These are the app's solid, stage-ellipse and grid backgrounds, not an HTML rasterizer. */
export function paintBackground(ctx:CanvasRenderingContext2D,layers:BackgroundLayer[],area:CaptureRect,strict=false):void {
 for(const layer of layers){
  if(strict){const clip=layer.clip??layer.rect;ctx.save();ctx.beginPath();ctx.rect(clip.x,clip.y,clip.width,clip.height);ctx.clip();}
  try{
  const r=layer.rect,fill=strict?(layer.clip??r):r;if(!transparent(layer.color)){ctx.fillStyle=layer.color;ctx.fillRect(fill.x,fill.y,fill.width,fill.height);}if(!layer.image||layer.image==='none')continue;
  const colors=layer.image.match(/rgba?\([^)]+\)|#[\da-f]+/gi)??[];if(!layer.image.startsWith('radial-gradient(')||colors.length!==2)throw new Error('COMMENT_BACKGROUND_UNAVAILABLE: unsupported viewport background');
  const sizes=layer.size.split(/\s+/).map(Number.parseFloat),radius=layer.image.match(/\)\s+([\d.]+)px/);
  if(radius&&sizes.length===2&&sizes.every(n=>Number.isFinite(n)&&n>0)){
   const [sx,sy]=sizes as [number,number],position=layer.position.split(/\s+/),offset=(v:string,extent:number,tile:number)=>v.endsWith('%')?(extent-tile)*parseFloat(v)/100:parseFloat(v);
   const ox=r.x+offset(position[0]??'0%',r.width,sx),oy=r.y+offset(position[1]??'0%',r.height,sy);
   if(strict){paintHardStopTile(ctx,layer,colors,sx,sy,Number(radius[1]),ox,oy);continue;}
   ctx.save();ctx.beginPath();ctx.rect(r.x,r.y,r.width,r.height);ctx.clip();ctx.fillStyle=colors[0]!;
   for(let y=oy+Math.floor((area.y-oy)/sy)*sy+sy/2;y<area.y+area.height+sy;y+=sy)for(let x=ox+Math.floor((area.x-ox)/sx)*sx+sx/2;x<area.x+area.width+sx;x+=sx){ctx.beginPath();ctx.arc(x,y,Number(radius[1]),0,Math.PI*2);ctx.fill();}ctx.restore();
  }else{
   const position=layer.image.match(/at\s+([\d.]+)%\s+([\d.]+)%/),end=layer.image.match(/([\d.]+)%\s*\)$/);if(!position||!end)throw new Error('COMMENT_BACKGROUND_UNAVAILABLE: unknown stage ellipse');
   const cx=r.width*Number(position[1])/100,cy=r.height*Number(position[2])/100,rx=Math.max(cx,r.width-cx)*Math.SQRT2,ry=Math.max(cy,r.height-cy)*Math.SQRT2;if(rx<=0||ry<=0)continue;
   ctx.save();ctx.translate(r.x+cx,r.y+cy);ctx.scale(rx,ry);const gradient=ctx.createRadialGradient(0,0,0,0,0,1);gradient.addColorStop(0,colors[0]!);gradient.addColorStop(Number(end[1])/100,colors[1]!);gradient.addColorStop(1,colors[1]!);ctx.fillStyle=gradient;ctx.fillRect(-cx/rx,-cy/ry,r.width/rx,r.height/ry);ctx.restore();
  }
  }finally{if(strict)ctx.restore();}
 }
}
export function paintViewportLayers(ctx:CanvasRenderingContext2D,area:CaptureRect,background:BackgroundLayer[],images:boolean,drawImages:()=>void,overlays:PixelLayer[],strict=false):void {
 ctx.save();ctx.beginPath();ctx.rect(area.x,area.y,area.width,area.height);ctx.clip();paintBackground(ctx,background,area,strict);if(images)drawImages();
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
 const r=root.getBoundingClientRect(),p=capture.pane.getBoundingClientRect(),rootMatrix=cssMatrix(getComputedStyle(root).transform);if(!rootMatrix.is2D||rootMatrix.b!==0||rootMatrix.c!==0||rootMatrix.a<=0||rootMatrix.d<=0||getComputedStyle(root).transformOrigin!=='0px 0px')return false;
 const plans=frame.order.map(row=>{const node=byZ.get(row.z)!,style=getComputedStyle(node);return {row,node,style,m:cssMatrix(style.transform),width:parseFloat(style.width),height:parseFloat(style.height)};});if(plans.some(p=>!p.m.is2D||![p.width,p.height].every(n=>Number.isFinite(n)&&n>0)))return false;
 if(capture.strictActualPixels&&plans.some(plan=>plan.node instanceof HTMLCanvasElement&&
   (plan.m.b!==0||plan.m.c!==0||plan.m.a<=0||plan.m.d<=0)))return false;
 for(const {row,node,style,m,width,height}of plans){
  ctx.save();if(row.clip){ctx.beginPath();if(row.clip.inverse)ctx.rect(0,0,camera.viewport.width,camera.viewport.height);for(let i=0;i<row.clip.polygon.length;i+=2){const at=projectMark({x:row.clip.polygon[i]!,y:row.clip.polygon[i+1]!},camera);if(i===0)ctx.moveTo(at.x,at.y);else ctx.lineTo(at.x,at.y);}ctx.closePath();ctx.clip(row.clip.inverse?'evenodd':'nonzero');}
  ctx.globalAlpha=Number(style.opacity);ctx.globalCompositeOperation=style.mixBlendMode==='plus-lighter'?'lighter':style.mixBlendMode==='normal'?'source-over':style.mixBlendMode as GlobalCompositeOperation;
  if(capture.strictActualPixels&&node instanceof HTMLCanvasElement){
   const rect=node.getBoundingClientRect();
   const origin={x:p.left+capture.pane.clientLeft,y:p.top+capture.pane.clientTop};
   const layer=getComputedStyle(root).transform==='none'&&style.transform==='none'
    ?displayedCanvasRect({x:rect.left,y:rect.top,width:rect.width,height:rect.height},origin,globalThis.devicePixelRatio||1)
    :{x:rect.left-origin.x,y:rect.top-origin.y,width:rect.width,height:rect.height};
   ctx.drawImage(node,layer.x,layer.y,layer.width,layer.height);
  }else{
   ctx.transform(rootMatrix.a*m.a,rootMatrix.d*m.b,rootMatrix.a*m.c,rootMatrix.d*m.d,r.left-p.left-capture.pane.clientLeft+rootMatrix.a*m.e,r.top-p.top-capture.pane.clientTop+rootMatrix.d*m.f);
   ctx.drawImage(node,0,0,width,height);
  }
  ctx.restore();
 }return true;
}
/** Shared off-screen rendering for inspection crops and fixed job evidence. */
export function paintPosedViewport(ctx:CanvasRenderingContext2D,posed:PosedFrame,assets:ModelAssets,
 camera:ControlNumericCamera,backend:CanvasBackend):void {
 if(backend==='canvas2d'&&posed.order.some(row=>row.tint.slice(0,3).some(c=>c!==1)||row.dark?.some(c=>c!==0)))throw new Error('COMMENT_CAPTURE_UNAVAILABLE: Canvas2D cannot reproduce active RGB/dark tint');
 const root=document.createElement('div'),renderer=new CanvasRenderer(root,assets.pageImages);
 try {
  renderer.backend=backend;renderer.viewport={...camera.visible};
  renderer.pixelRatio=camera.viewport.width/camera.visible.width;
  renderer.render(posed);ctx.drawImage(renderer.canvas,0,0,camera.viewport.width,camera.viewport.height);
 }finally{renderer.dispose();}
}
export function paintInspectionViewport(ctx:CanvasRenderingContext2D,area:MarkRegion,capture:ViewportCapture,pose:{camera:ControlNumericCamera;posed?:PosedFrame;assets?:ModelAssets;media?:HTMLVideoElement|HTMLImageElement}):void {
 if(capture.nearest)ctx.imageSmoothingEnabled=false;
  const overlays=capture.includeOverlays===false?[]:[...capture.pane.querySelectorAll<HTMLCanvasElement>('canvas')].filter(node=>!capture.root?.contains(node)&&node!==capture.canvas).map(node=>displayedPixels(node,capture.pane)).filter((v):v is PixelLayer=>v!==null);
 paintViewportLayers(ctx,area,viewportBackground(capture.pane,capture.strictActualPixels),capture.images,()=>{
   if(capture.canvas){if(capture.strictActualPixels&&getComputedStyle(capture.canvas).filter!=='none')throw new Error('JOB_STILL_CAPTURE_FAILED');const pixels=displayedPixels(capture.canvas,capture.pane,!capture.root?.contains(capture.canvas));if(pixels){ctx.save();ctx.globalAlpha=pixels.opacity;ctx.drawImage(pixels.image,pixels.rect.x,pixels.rect.y,pixels.rect.width,pixels.rect.height);ctx.restore();return;}}
  if(pose.posed&&pose.assets){if(displayedRig(ctx,capture,pose.posed,pose.camera))return;
   if(capture.strictActualPixels)throw new Error('JOB_STILL_CAPTURE_FAILED');
   paintPosedViewport(ctx,pose.posed,pose.assets,pose.camera,capture.backend);
   }else if(capture.strictActualPixels){throw new Error('JOB_STILL_CAPTURE_FAILED');
   }else if(pose.media){const media=pose.media,style=getComputedStyle(media),a=media.getBoundingClientRect(),b=capture.pane.getBoundingClientRect();if(!transparent(style.backgroundColor)){ctx.fillStyle=style.backgroundColor;ctx.fillRect(a.left-b.left-capture.pane.clientLeft,a.top-b.top-capture.pane.clientTop,a.width,a.height);}const w=media instanceof HTMLVideoElement?media.videoWidth:media.naturalWidth,h=media instanceof HTMLVideoElement?media.videoHeight:media.naturalHeight,first=projectMark({x:0,y:0},pose.camera),last=projectMark({x:w,y:h},pose.camera);ctx.drawImage(media,first.x,first.y,last.x-first.x,last.y-first.y);
  }else throw new Error('COMMENT_CROP_UNAVAILABLE: this viewport has no rendered pixels');
 },overlays,capture.strictActualPixels);
}


/** The committed normal Rig presentation, including every admitted background pixel. */
export interface JobRigPresentation {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  readonly ratio: number;
  readonly area: Readonly<CaptureRect>;
}

/** Compose during normal presentation. The caller mounts only a completed bitmap. */
export function presentJobRigViewport(capture: ViewportCapture,
  pose: {camera: ControlNumericCamera; posed?: PosedFrame; assets?: ModelAssets}): JobRigPresentation {
  const {pane} = capture;
  const rect = pane.getBoundingClientRect();
  const ratio = globalThis.devicePixelRatio || 1;
  const area = pixelAlignedCrop({x: 0, y: 0, width: pane.clientWidth, height: pane.clientHeight},
    {x: rect.left + pane.clientLeft, y: rect.top + pane.clientTop}, ratio);
  const width = Math.round(area.width * ratio);
  const height = Math.round(area.height * ratio);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 16777216) {
    throw new Error('JOB_STILL_CAPTURE_FAILED');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.className = 'job-rig-presentation';
  canvas.dataset.jobRigPresentation = '';
  canvas.style.left = `${area.x}px`;
  canvas.style.top = `${area.y}px`;
  canvas.style.width = `${width / ratio}px`;
  canvas.style.height = `${height / ratio}px`;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('JOB_STILL_CAPTURE_FAILED');
  context.scale(ratio, ratio);
  context.translate(-area.x, -area.y);
  paintInspectionViewport(context, area, {...capture, strictActualPixels: true, includeOverlays: false}, pose);
  return Object.freeze({canvas, width, height, ratio, area: Object.freeze(area)});
}
