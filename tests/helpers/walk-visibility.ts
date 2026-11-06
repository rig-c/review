// Self-contained so the walk can evaluate it inside the browser document.
export function fullyVisible(target: HTMLElement): boolean {
  const view = target.ownerDocument.defaultView;
  if (!view || !target.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false;
  const box = target.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0 ||
      box.left < 0 || box.top < 0 || box.right > view.innerWidth || box.bottom > view.innerHeight) return false;

  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const {overflowX, overflowY} = view.getComputedStyle(ancestor);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const bounds = ancestor.getBoundingClientRect();
    const left = bounds.left + ancestor.clientLeft;
    const top = bounds.top + ancestor.clientTop;
    if (overflowX !== 'visible' && (box.left < left || box.right > left + ancestor.clientWidth)) return false;
    if (overflowY !== 'visible' && (box.top < top || box.bottom > top + ancestor.clientHeight)) return false;
  }
  return true;
}

// Keep geometry receipts independent of the acceptance predicate.
export function visibilityGeometry(target: HTMLElement) {
  const view = target.ownerDocument.defaultView!;
  const {left, top, right, bottom, width, height} = target.getBoundingClientRect();
  const viewport = {left:0, top:0, right:view.innerWidth, bottom:view.innerHeight};
  const clips = [];
  let firstFailure: string | null = null;
  if (!target.checkVisibility({opacityProperty:true, visibilityProperty:true})) firstFailure = 'hidden';
  else if (width <= 0 || height <= 0) firstFailure = 'empty-target';
  else if (left < 0 || top < 0 || right > viewport.right || bottom > viewport.bottom) firstFailure = 'viewport';

  let intersection = viewport;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const {overflowX, overflowY} = view.getComputedStyle(ancestor);
    if (overflowX === 'visible' && overflowY === 'visible') continue;
    const bounds = ancestor.getBoundingClientRect();
    const clipLeft = bounds.left + ancestor.clientLeft;
    const clipTop = bounds.top + ancestor.clientTop;
    const rect = {left:clipLeft, top:clipTop, right:clipLeft+ancestor.clientWidth, bottom:clipTop+ancestor.clientHeight};
    const clipX = overflowX !== 'visible';
    const clipY = overflowY !== 'visible';
    const failed = (clipX && (left < rect.left || right > rect.right)) ||
      (clipY && (top < rect.top || bottom > rect.bottom));
    intersection = {
      left:clipX ? Math.max(intersection.left, rect.left) : intersection.left,
      right:clipX ? Math.min(intersection.right, rect.right) : intersection.right,
      top:clipY ? Math.max(intersection.top, rect.top) : intersection.top,
      bottom:clipY ? Math.min(intersection.bottom, rect.bottom) : intersection.bottom,
    };
    const boundary: string = ancestor.id ? '#' + ancestor.id : ancestor.tagName + '[' + clips.length + ']';
    if (failed && firstFailure === null) firstFailure = boundary;
    clips.push({boundary, overflowX, overflowY, rect, intersection, failed});
  }
  return {viewport, target:{left, top, right, bottom, width, height}, clips, firstFailure};
}
