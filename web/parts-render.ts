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
  if (!options.fronts.length) return;
  const mask = options.makeCanvas(w, h), m = mask.getContext('2d')!;
  for (const f of options.fronts) m.drawImage(f.image, f.box.x - item.x, f.box.y - item.y);
  m.globalCompositeOperation = 'source-in';
  m.fillStyle = `rgb(${FOOTPRINT_RGB.join(',')})`;
  m.fillRect(0, 0, w, h);
  ctx.globalAlpha = FOOTPRINT_ALPHA;
  ctx.drawImage(mask, 0, 0);
  ctx.globalAlpha = 1;
}
