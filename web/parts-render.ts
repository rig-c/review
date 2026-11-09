/**
 * The part view's pixels (#348), apart from the DOM so a test draws them on a server canvas too: the sentinel
 * background, the part, its alpha alone, and the footprints of the parts drawn in front of it.
 *
 * The footprint is the front parts' own alpha, placed by their rig boxes, tinted one colour at one opacity. Nothing is
 * measured: where the part has no pixel under its occluder, the tint lands on the bare sentinel and reads as its own
 * colour, so a back part that stops at its occluder's edge shows the occluder's shape.
 */
export interface Box { name: string; index: number; x: number; y: number; w: number; h: number }
type Ctx = CanvasRenderingContext2D;
type Source = CanvasImageSource;
import type {PaintingRectangle} from '../src/parts-comparison.ts';

/** Sentinel backgrounds: colours no art is expected to hold, so a sliver of empty canvas is plain. */
export const SENTINELS: Readonly<Record<string, string>> = { green: '#00ff00', magenta: '#ff00ff', black: '#000000', white: '#ffffff' };
export const BACKGROUNDS = ['green', 'magenta', 'black', 'white', 'checker'] as const;
/** The footprint tint and its opacity: cyan at half, so over green it is (0,255,128) and over art it mixes with the art. */
export const FOOTPRINT_RGB: readonly [number, number, number] = [0, 255, 255], FOOTPRINT_ALPHA = 0.5;
export const CHECKER = 8;

export function paintBackground(ctx: Ctx, w: number, h: number, bg: string): void {
  if (bg === 'checker') {
    for (let y = 0; y < h; y += CHECKER) for (let x = 0; x < w; x += CHECKER) { ctx.fillStyle = ((x + y) / CHECKER) % 2 ? '#bdbdbd' : '#ffffff'; ctx.fillRect(x, y, CHECKER, CHECKER); }
    return;
  }
  ctx.fillStyle = SENTINELS[bg] ?? SENTINELS.green!;
  ctx.fillRect(0, 0, w, h);
}

/** Alpha as grey (white = opaque) over the whole box; the source is drawn on transparent first. */
export function paintAlphaOnly(ctx: Ctx, source: Source, sx: number, sy: number, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, sx, sy, w, h, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h), px = data.data;
  for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]!; px[i] = px[i + 1] = px[i + 2] = a; px[i + 3] = 255; }
  ctx.putImageData(data, 0, 0);
}

/** The parts drawn in front of `item` (later in parts.json, which is in draw order, back first) whose box meets its box. */
export function frontParts<T extends Box>(items: readonly T[], item: Box): T[] {
  return items.filter(o => o.index > item.index && o.x < item.x + item.w && o.x + o.w > item.x && o.y < item.y + item.h && o.y + o.h > item.y);
}

/** Draws one part's view: background, part (or its alpha), then the tinted footprints of `fronts`. */
export function paintPart(ctx: Ctx, item: Box, image: Source, options: { bg: string; alpha: boolean; fronts: readonly { box: Box; image: Source }[]; makeCanvas: (w: number, h: number) => HTMLCanvasElement }): void {
  const { w, h } = item;
  if (options.alpha) paintAlphaOnly(ctx, image, 0, 0, w, h);
  else { paintBackground(ctx, w, h, options.bg); ctx.drawImage(image, 0, 0); }
  paintFootprints(ctx,item,options.fronts,options.makeCanvas);
}
export function paintFootprints(ctx:Ctx,item:Box,fronts:readonly {box:Box;image:Source}[],makeCanvas:(w:number,h:number)=>HTMLCanvasElement):void {
  if (!fronts.length) return;
  const {w,h}=item;
  const mask = makeCanvas(w, h), m = mask.getContext('2d')!;
  for (const f of fronts) m.drawImage(f.image, f.box.x - item.x, f.box.y - item.y);
  m.globalCompositeOperation = 'source-in';
  m.fillStyle = `rgb(${FOOTPRINT_RGB.join(',')})`;
  m.fillRect(0, 0, w, h);
  ctx.globalAlpha = FOOTPRINT_ALPHA;
  ctx.drawImage(mask, 0, 0);
  ctx.globalAlpha = 1;
}

/** Original painting's continuous rectangle, displayed with browser interpolation; no native-pixel parity claim. */
export function paintPaintingCrop(ctx:Ctx,painting:Source,source:PaintingRectangle,w:number,h:number,bg:string):void {
 paintBackground(ctx,w,h,bg);ctx.imageSmoothingEnabled=true;
 ctx.drawImage(painting,source.x,source.y,source.width,source.height,0,0,w,h);
 ctx.imageSmoothingEnabled=false;
}
export function paintOverlay(ctx:Ctx,item:Box,image:Source,painting:Source,source:PaintingRectangle,opacity:number,bg:string):void {
 paintPaintingCrop(ctx,painting,source,item.w,item.h,bg);
 ctx.globalAlpha=opacity;ctx.drawImage(image,0,0);ctx.globalAlpha=1;
}

export interface MeshGeometry { vertices: readonly number[]; triangles: readonly number[] }
/** Closed triangle union at pixel centres. Degenerate triangles cover no area. */
export function meshCoverage(w: number, h: number, mesh: MeshGeometry): Uint8Array {
  const mask = new Uint8Array(w * h), v = mesh.vertices;
  const cross = (ax: number, ay: number, bx: number, by: number, x: number, y: number) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = mesh.triangles[i]! * 2, b = mesh.triangles[i + 1]! * 2, c = mesh.triangles[i + 2]! * 2;
    const ax = v[a]!, ay = v[a + 1]!, bx = v[b]!, by = v[b + 1]!, cx = v[c]!, cy = v[c + 1]!;
    if (cross(ax, ay, bx, by, cx, cy) === 0) continue;
    for (let y = Math.max(0, Math.ceil(Math.min(ay, by, cy) - .5)); y <= Math.min(h - 1, Math.floor(Math.max(ay, by, cy) - .5)); y++) {
      for (let x = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - .5)); x <= Math.min(w - 1, Math.floor(Math.max(ax, bx, cx) - .5)); x++) {
        const p = cross(ax, ay, bx, by, x + .5, y + .5), q = cross(bx, by, cx, cy, x + .5, y + .5), r = cross(cx, cy, ax, ay, x + .5, y + .5);
        if ((p >= 0 && q >= 0 && r >= 0) || (p <= 0 && q <= 0 && r <= 0)) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}
/** Tint only nontransparent source-art pixels outside the triangle union, before drawing diagnostic edges. */
export function paintMesh(ctx: Ctx, source: Source, w: number, h: number, mesh: MeshGeometry, makeCanvas: (w: number, h: number) => HTMLCanvasElement, options: {tint?: boolean; alpha?: number} = {}): void {
  const tintEnabled = options.tint !== false;
  ctx.save();
  try {
    ctx.globalAlpha *= options.alpha ?? 1;
    if (tintEnabled) {
      const scratch = makeCanvas(w, h), s = scratch.getContext('2d')!;
      s.drawImage(source, 0, 0);
      const art = s.getImageData(0, 0, w, h), tint = s.createImageData(w, h), mask = meshCoverage(w, h, mesh);
      for (let i = 0; i < mask.length; i++) if (!mask[i] && art.data[i * 4 + 3]) {
        tint.data[i * 4] = 255; tint.data[i * 4 + 2] = 80; tint.data[i * 4 + 3] = 160;
      }
      s.putImageData(tint, 0, 0); ctx.drawImage(scratch, 0, 0);
    }
    ctx.strokeStyle = '#00bfff'; ctx.fillStyle = '#ffffff'; ctx.lineWidth = .5;
    ctx.beginPath();
    const v = mesh.vertices;
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      for (let j = 0; j < 3; j++) { const a = mesh.triangles[i + j]! * 2; if (!j) ctx.moveTo(v[a]!, v[a + 1]!); else ctx.lineTo(v[a]!, v[a + 1]!); }
      ctx.closePath();
    }
    ctx.stroke();
    if (tintEnabled) for (let i = 0; i < v.length; i += 2) { ctx.beginPath(); ctx.arc(v[i]!, v[i + 1]!, .8, 0, Math.PI * 2); ctx.fill(); }
  } finally {ctx.restore();}
}

/** Package order is back to front. Placements remain continuous rig pixels. */
export function paintAssembly(ctx:Ctx,w:number,h:number,layers:readonly {box:Box;image:Source}[],options:{bg:string;alpha:boolean}):void {
 ctx.imageSmoothingEnabled=false;
 if(!options.alpha)paintBackground(ctx,w,h,options.bg);else ctx.clearRect(0,0,w,h);
 for(const {box,image} of layers)ctx.drawImage(image,box.x,box.y);
 if(options.alpha){const data=ctx.getImageData(0,0,w,h),px=data.data;for(let i=0;i<px.length;i+=4){px[i]=px[i+1]=px[i+2]=px[i+3]!;px[i+3]=255;}ctx.putImageData(data,0,0);}
}
/** Native source alpha, independent of the sentinel, overlay opacity and selection decoration. */
export function pickAssembly<T extends Box>(layers:readonly {box:T;alpha:Uint8ClampedArray}[],x:number,y:number,hidden:ReadonlySet<string>=new Set()):T|null {
 for(let i=layers.length-1;i>=0;i--){const {box,alpha}=layers[i]!;if(hidden.has(box.name))continue;const px=Math.floor(x-box.x),py=Math.floor(y-box.y);if(px>=0&&py>=0&&px<box.w&&py<box.h&&alpha[py*box.w+px]!>0)return box;}
 return null;
}
/** Exposed native-alpha cell edges; decoration is separate from comparison pixels. */
export function paintAssemblyOutline(ctx:Ctx,box:Box,alpha:Uint8ClampedArray):void {
 const at=(x:number,y:number)=>x>=0&&y>=0&&x<box.w&&y<box.h&&alpha[y*box.w+x]!>0;
 ctx.strokeStyle='#00bfff';ctx.lineWidth=1;ctx.beginPath();
 for(let y=0;y<box.h;y++)for(let x=0;x<box.w;x++)if(at(x,y)){
 const edge=(ax:number,ay:number,bx:number,by:number)=>{ctx.moveTo(box.x+ax,box.y+ay);ctx.lineTo(box.x+bx,box.y+by);};
 if(!at(x,y-1))edge(x,y,x+1,y);if(!at(x,y+1))edge(x,y+1,x+1,y+1);if(!at(x-1,y))edge(x,y,x,y+1);if(!at(x+1,y))edge(x+1,y,x+1,y+1);
 }ctx.stroke();
}
