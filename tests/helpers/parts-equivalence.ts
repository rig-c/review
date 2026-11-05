/** Exact, separate no-rig instruments. No DOM, URL, style, or canvas normalization. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CdpSession } from '../parts-explorer-browser.ts';
type Snapshot = { dom: unknown; canvas: { width: number; height: number; rgba: number[] } };
const expression = `(()=>{
 const all=[...document.querySelectorAll('*')];
 const styles=(e,pseudo)=>{const s=getComputedStyle(e,pseudo);return Object.fromEntries([...s].sort().map(k=>[k,s.getPropertyValue(k)]))};
 const canvas=document.getElementById('pv-canvas');
 return {dom:{url:location.href,html:document.documentElement.outerHTML,title:document.title,activeIndex:all.indexOf(document.activeElement),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:scrollX,y:scrollY},elements:all.map((e,index)=>{
  const r=e.getBoundingClientRect();return {index,tag:e.tagName,namespace:e.namespaceURI,geometry:{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,left:r.left,right:r.right,bottom:r.bottom},scroll:{x:e.scrollLeft,y:e.scrollTop,width:e.scrollWidth,height:e.scrollHeight},form:{value:'value'in e?e.value:null,checked:'checked'in e?e.checked:null,selected:'selected'in e?e.selected:null,selectedIndex:'selectedIndex'in e?e.selectedIndex:null,selectionStart:'selectionStart'in e?e.selectionStart:null,selectionEnd:'selectionEnd'in e?e.selectionEnd:null},style:styles(e,null),before:styles(e,'::before'),after:styles(e,'::after')};
 })},canvas:{width:canvas.width,height:canvas.height,rgba:[...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data]}};
})()`;
function propertyDiff(left: unknown, right: unknown, path = '$', out: { path: string; left: unknown; right: unknown }[] = []) {
  if (Object.is(left, right)) return out;
  if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) propertyDiff(a[key], b[key], `${path}.${key}`, out);
  } else out.push({ path, left, right });
  return out;
}
function compare(a: Snapshot, b: Snapshot) {
  let canvasBytes = 0;
  if (a.canvas.width !== b.canvas.width || a.canvas.height !== b.canvas.height) canvasBytes++;
  for (let i = 0; i < Math.max(a.canvas.rgba.length, b.canvas.rgba.length); i++) if (a.canvas.rgba[i] !== b.canvas.rgba[i]) canvasBytes++;
  const domDiff = propertyDiff(a.dom, b.dom);
  return { canvasBytes, domPropertyDifferences: domDiff.length, domDiff };
}
export async function provePartsEquivalence(page: CdpSession, load: (baseline: boolean, language: string) => Promise<void>, directory: string) {
  const capture = async (baseline: boolean, language: string, name: string) => {
    await load(baseline, language);
    await page.evaluate(`document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
    const value = await page.evaluate<Snapshot>(expression);
    await writeFile(join(directory, name + '.json'), JSON.stringify(value));
    await writeFile(join(directory, name + '.png'), await page.screenshot());
    return value;
  };
  const controls = [];
  for (let i = 1; i <= 3; i++) {
    const a = await capture(true, 'en', `instrument-baseline-${i}a`), b = await capture(true, 'en', `instrument-baseline-${i}b`);
    controls.push(compare(a, b));
  }
  const before = await capture(true, 'en', 'instrument-mutant-before');
  await page.evaluate(`(()=>{const c=document.getElementById('pv-canvas'),x=c.getContext('2d'),d=x.getImageData(0,0,c.width,c.height);d.data[0]^=1;x.putImageData(d,0,0)})()`);
  const pixel = await page.evaluate<Snapshot>(expression), pixelDiff = compare(before, pixel);
  await writeFile(join(directory, 'instrument-mutant-pixel.json'), JSON.stringify({ snapshot: pixel, diff: pixelDiff }));
  // Restore only the deliberately changed backing-store byte, then plant exactly one inline CSS declaration.
  await page.evaluate(`(()=>{const c=document.getElementById('pv-canvas'),x=c.getContext('2d'),d=x.getImageData(0,0,c.width,c.height);d.data[0]^=1;x.putImageData(d,0,0);document.getElementById('pv-bg').style.setProperty('opacity','0.5')})()`);
  const css = await page.evaluate<Snapshot>(expression), cssDiff = compare(before, css);
  const actualOpacityDiff = cssDiff.domDiff.filter(d => d.path.endsWith('.style.opacity') && d.left === '1' && d.right === '0.5');
  await writeFile(join(directory, 'instrument-mutant-css.json'), JSON.stringify({ snapshot: css, diff: cssDiff, actualOpacityDiff }));
  const languages = [];
  for (const language of ['en', 'ko']) {
    const a = await capture(true, language, `instrument-main-${language}`), b = await capture(false, language, `instrument-head-${language}`);
    languages.push({ language, ...compare(a, b) });
  }
  const passed = controls.every(c => c.canvasBytes === 0 && c.domPropertyDifferences === 0) && pixelDiff.canvasBytes === 1 && pixelDiff.domPropertyDifferences === 0 && cssDiff.canvasBytes === 0 && actualOpacityDiff.length > 0 && languages.every(c => c.canvasBytes === 0 && c.domPropertyDifferences === 0);
  const result = { passed, normalization: 'none; identical origin/path/URL by construction', controls, pixelMutant: pixelDiff, cssMutant: { ...cssDiff, actualOpacityDiff }, languages, wording: 'the native form-control corners are not deterministic under this capture; the lower-level cause is unproved' };
  await writeFile(join(directory, 'instruments.json'), JSON.stringify(result, null, 2));
  return result;
}
