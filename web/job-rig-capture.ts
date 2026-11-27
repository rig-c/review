import {CanvasRenderer, RigPlayer, type ModelAssets} from '@rig-c/play';
import {assertOriginalPaintingSize} from '../src/parts-comparison.ts';

/** Native original-art comparison needs the declared canvas, never a fitted viewport or inferred bounds. */
export function rigRestCanvas(assets: Pick<ModelAssets, 'stage'>, painting: {width: number; height: number}) {
  const stage = assets.stage;
  assertOriginalPaintingSize(painting.width, painting.height, stage ? [stage.width, stage.height] : null, 1);
  if (!stage || !Number.isSafeInteger(stage.x) || !Number.isSafeInteger(stage.y) ||
      stage.width > 16384 || stage.height > 16384 || stage.width * stage.height > 16777216) {
    throw new Error('PARTS_PAINTING_MAPPING: declared rig_size and positive scale_rig_per_source required');
  }
  return {x: stage.x, y: stage.y, width: stage.width, height: stage.height};
}

/** Standalone Setup operand. A fresh public player has no animation, slot filter, previews or environment history. */
export function captureRigRestStill(assets: ModelAssets, painting: {width: number; height: number}): HTMLCanvasElement {
  const viewport = rigRestCanvas(assets, painting), root = document.createElement('div');
  const player = new RigPlayer(root, assets, {mode: 'canvas'});
  try {
    const renderer = player.renderer;
    if (!(renderer instanceof CanvasRenderer)) throw new Error('JOB_STILL_CAPTURE_FAILED');
    // Public clear(0) holds Setup even on a model without animations or sets. No clip is played.
    renderer.viewport = viewport; renderer.pixelRatio = 1;
    player.clear(0); player.draw();
    const frame = player.posedFrame();
    if (renderer.backendActive === 'canvas2d' && frame.order.some(row => row.tint.slice(0, 3).some(c => c !== 1) || row.dark?.some(c => c !== 0))) {
      throw new Error('COMMENT_CAPTURE_UNAVAILABLE: Canvas2D cannot reproduce active RGB/dark tint');
    }
    return copyRigBitmap(renderer.canvas, viewport.width, viewport.height);
  } finally {player.dispose();}
}

/** Copy the Setup pixels before disposing the temporary player. */
function copyRigBitmap(displayed: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const source = displayed.getContext('2d');
    const context = canvas.getContext('2d');
    if (!source || !context) throw new Error('JOB_STILL_CAPTURE_FAILED');
    context.putImageData(source.getImageData(0, 0, width, height), 0, 0);
  } catch { throw new Error('JOB_STILL_CAPTURE_FAILED'); }
  return canvas;
}
