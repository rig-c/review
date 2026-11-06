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
