import {loadViewportImage} from './parts-viewport-provider.ts';
import {t} from './i18n.ts';
import {CanvasRenderer,type RigPlayer} from '@rig-c/play';
import type {SceneInspection,SceneBox} from '../src/scene-inspection.ts';
import type {DirectionInspection} from '../src/direction-inspection.ts';
type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;

type Plate = Readonly<{
  image: HTMLImageElement | null;
  width: number;
  height: number;
  rect: Rect;
}>;

type Frame = Readonly<{
  clip: Rect;
  background: Plate | null;
  foreground: Plate | null | undefined;
  rigTransform: readonly [number, number, number, number, number, number];
  drawRig: (ctx: CanvasRenderingContext2D) => void;
}>;

function validateRect(rect: Rect, name: string): void {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height, rect.x + rect.width,
    rect.y + rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`SCENE_RECT_INVALID: ${name}`);
  }
}

function validatePlate(plate: Plate | null, name: string): asserts plate is Plate & { image: HTMLImageElement } {
  if (!plate?.image) throw new Error(`SCENE_PLATE_REQUIRED: ${name}`);
  const { image, width, height } = plate;
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    throw new Error(`SCENE_PLATE_NOT_READY: ${name}`);
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
    image.naturalWidth !== width || image.naturalHeight !== height) {
    throw new Error(`SCENE_PLATE_DIMENSIONS: ${name}`);
  }
  validateRect(plate.rect, name);
}

/**
 * Internal drawing inputs. The caller owns source binding and supplies decoded images.
 * Clip and plate rectangles use target-canvas pixels, independent of its current transform.
 * The explicit matrix maps the synchronous rig callback's coordinates to those pixels.
 * A runtime drawing exception can leave a cleared or partially drawn frame.
 * The caller MUST render offscreen and commit only the completed frame to the live canvas.
 * drawRig must be synchronous and balance its own save/restore calls.
 * The callback owns its current-path changes. Canvas save/restore does not restore that path.
 */
export function renderScenePlates(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { background, foreground, clip, rigTransform, drawRig } = frame;
  // Complete validation precedes every canvas operation, including clearing the held frame.
  validatePlate(background, 'background');
  if(foreground!==undefined)validatePlate(foreground, 'foreground');
  validateRect(clip, 'clip');
  if (!rigTransform || rigTransform.length !== 6 || !Array.from(rigTransform).every(Number.isFinite)) {
    throw new Error('SCENE_TRANSFORM_INVALID');
  }
  const [a, b, c, d, e, f] = rigTransform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error('SCENE_TRANSFORM_INVALID');
  if (typeof drawRig !== 'function') throw new Error('SCENE_DRAW_RIG_REQUIRED');

  // Use a separate Path2D for clipping. Existing clipping still applies.
  const path = new Path2D();
  path.rect(clip.x, clip.y, clip.width, clip.height);
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.clip(path);
    ctx.clearRect(clip.x, clip.y, clip.width, clip.height);

    const back = background.rect;
    ctx.drawImage(background.image, 0, 0, background.width, background.height,
      back.x, back.y, back.width, back.height);

    ctx.save();
    try {
      ctx.setTransform(a, b, c, d, e, f);
      drawRig(ctx);
    } finally {
      ctx.restore();
    }

    if(foreground){const front = foreground.rect;
    ctx.drawImage(foreground.image, 0, 0, foreground.width, foreground.height,
      front.x, front.y, front.width, front.height);}
  } finally {
    ctx.restore();
  }
}

/** One interpolation policy for the authored camera and rig timing; a key owns the interval after it. */
export function takeSample(direction:DirectionInspection,time:number):{box:SceneBox;sourceTime:number}{
 const at=Math.min(direction.take.duration,Math.max(0,time));
 function sample<T extends {time:number;easing:string}>(keys:T[]):{a:T;b:T;mix:number}{
  const index=keys.findIndex(key=>key.time>at),a=keys[index<0?keys.length-1:Math.max(0,index-1)]!,b=index<0?a:keys[index]!;
  let mix=b.time===a.time?0:(at-a.time)/(b.time-a.time);
  if(a.easing==='hold')mix=0;else if(a.easing==='smoothstep')mix=mix*mix*(3-2*mix);
  return {a,b,mix};
 }
 const camera=sample(direction.camera.keys),timing=sample(direction.timing),box={...camera.a.box};
 for(const key of ['x','y','width','height'] as const)box[key]+=(camera.b.box[key]-box[key])*camera.mix;
 return {box,sourceTime:timing.a.source_time+(timing.b.source_time-timing.a.source_time)*timing.mix};
}
/** Load only the byte identities already validated by the package reader; never follow a scene URL. */
export async function loadScenePlates(scene:SceneInspection,url:(path:string)=>string):Promise<Map<string,HTMLImageElement>>{
 const images=new Map<string,HTMLImageElement>();
 for(const plate of scene.plates){
  const response=await fetch(url(plate.path));if(!response.ok)throw new Error(t('scene.required',[plate.path]));
  const bytes=await response.clone().arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes);
  if(Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')!==plate.sha256)throw new Error(t('scene.plateChanged',[plate.path]));
  let image:HTMLImageElement;
  try{image=await loadViewportImage(response);}catch{throw new Error(t('scene.plateDimensions',[plate.path]));}
  if(image.naturalWidth!==plate.width||image.naturalHeight!==plate.height)throw new Error(t('scene.plateDimensions',[plate.path]));
  images.set(plate.path,image);
 }
 return images;
}
/** Scratch buffers only: the player's existing canvas remains the sole displayed image and comment surface. */
export function bindScenePlates(scene:SceneInspection,images:Map<string,HTMLImageElement>){
 const rig=document.createElement('canvas'),scratch=document.createElement('canvas');let last:CanvasRenderer|null=null;
 return {draw(player:RigPlayer,box:SceneBox){
  const renderer=player.renderer;if(!(renderer instanceof CanvasRenderer))throw new Error(t('scene.canvasRequired'));
  const canvas=renderer.canvas,width=canvas.width,height=canvas.height;
  if(!width||!height)return;
  if(last!==renderer||!renderer.framesReused||rig.width!==width||rig.height!==height){
   rig.width=width;rig.height=height;rig.getContext('2d')!.drawImage(canvas,0,0);last=renderer;
  }
  scratch.width=width;scratch.height=height;
  const raster={x:Math.floor(box.x),y:Math.floor(box.y),width:Math.ceil(box.x+box.width)-Math.floor(box.x),height:Math.ceil(box.y+box.height)-Math.floor(box.y)};
  // CanvasRenderer rounds backing dimensions up, but projects world units with its pixel ratio.
  const sx=renderer.pixelRatio,sy=renderer.pixelRatio;
  const plate=(role:'background'|'foreground')=>{const p=scene.plates.find(p=>p.role===role);return p?{...p,image:images.get(p.path)??null,
   rect:{x:(p.rect.x-raster.x)*sx,y:(raster.y+raster.height-p.rect.y-p.rect.height)*sy,width:p.rect.width*sx,height:p.rect.height*sy}}:undefined;};
  renderScenePlates(scratch.getContext('2d')!,{clip:{x:(box.x-raster.x)*sx,y:(raster.y+raster.height-box.y-box.height)*sy,width:box.width*sx,height:box.height*sy},background:plate('background')??null,foreground:plate('foreground'),rigTransform:[1,0,0,1,0,0],drawRig:ctx=>ctx.drawImage(rig,0,0)});
  const ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,width,height);ctx.drawImage(scratch,0,0);
 }};
}
