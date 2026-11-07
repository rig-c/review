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
  foreground: Plate | null;
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
 */
export function renderScenePlates(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { background, foreground, clip, rigTransform, drawRig } = frame;
  // Complete validation precedes every canvas operation, including clearing the held frame.
  validatePlate(background, 'background');
  validatePlate(foreground, 'foreground');
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

    const front = foreground.rect;
    ctx.drawImage(foreground.image, 0, 0, foreground.width, foreground.height,
      front.x, front.y, front.width, front.height);
  } finally {
    ctx.restore();
  }
}
