import {mountComposedTake, type CameraMode} from '@rig-c/play/composed-take';

/** Mount the public take separately from Review at a 1:1 backing size. */
export async function readPlayCoverageFrame(
  modelUrl: string, sceneReportUrl: string, figure: string[], width: number, height: number,
  compiledSeconds: number, camera: CameraMode, horizontalExcursion: number,
) {
  const root = document.createElement('div');
  Object.assign(root.style, {position: 'fixed', left: '-10000px', top: '0', width: `${width}px`, height: `${height}px`});
  document.body.appendChild(root);
  try {
    const take = await mountComposedTake(root, {
      modelUrl, sceneReportUrl, animation: 'idle', loop: true, camera, autoStart: false,
      pointerTurn: false, backend: 'canvas2d', maxDisplacement: {x: horizontalExcursion, y: 0},
      planes: {
        backdrop: {role: 'backdrop', slots: ['backdrop']},
        figure: {role: 'figure', slots: figure},
        foreground: {role: 'overlay', slots: ['foreground'], gain: 0.55},
      },
    });
    try {
      take.player.seek(compiledSeconds);
      const box = take.canvas.getBoundingClientRect();
      root.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, isPrimary: true, pointerType: 'mouse', pointerId: 1,
        clientX: box.right, clientY: box.top + box.height / 2,
      }));
      take.advance(0, 120);
      take.render();
      return {
        mode: take.mode, refusal: take.refusal?.code ?? null, detail: take.refusal?.message ?? null,
        compiledSeconds: take.player.entry(0)?.animationTime, offsets: take.offsets, target: take.cameraTarget,
        backing: [take.canvas.width, take.canvas.height], png: take.canvas.toDataURL('image/png'),
      };
    } finally {
      take.dispose();
    }
  } finally {
    root.remove();
  }
}
