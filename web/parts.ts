import {mountViewportPair} from './viewport-pair.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
import {bindStageComments,type CommentUiPose,type CommentCodec} from './stage-comments.ts';
import {parsePartsComment,snapImageRegion,type PartsComment} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {bindStageNav} from './stage-nav.ts';
/**
 * The parts and atlas view (#348). Every part on its own, on a sentinel background, through the shared native-scale
 * viewport controller; the footprints of the parts drawn in front of it; the producer's flags on it; and a
 * per-part verdict saved as `rig-review-parts-verdict/2`. In atlas mode, the pages as packed with every region's box
 * and name, and a click from a region to its own view.
 *
 * Nothing here measures the art: flags come from the producer's files, and the footprint is the front parts' own
 * alpha drawn over the selected part (the parts.json draw order, back first, says which parts are in front).
 */
import { bindDomI18n, onLanguageChange, setLinkLanguage, setLanguagePreference, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { connectLiveWindow } from './live-connection.ts';
import { flagLabel } from './parts-flags.ts';
import { frontParts, paintAlphaOnly, paintBackground, paintPart, paintMesh } from './parts-render.ts';

type Outcome = 'pending' | 'clean' | 'flagged';
interface Mesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown> }
interface Entry { outcome: Outcome; note: string; mesh?: { outcome: Outcome; note: string } }
interface Item { mesh?: Mesh; name: string; index: number; x: number; y: number; w: number; h: number; page?: string; degrees?: number; image?: boolean;imageHash?:string }
interface Page { name: string; width: number; height: number; index: number }
type Flag =
  | { id: string; item: string; source: 'mesh_report'; kind: 'faint'; art: number; maxAlpha: number; box: [number, number, number, number] }
  | { id: string; item: string; source: 'check'; kind: 'check'; path: string; line: string; root: string; status: string | null; entry: Record<string, unknown> };
interface ViewData {
  painting:{sha256:string;width:number;height:number}|null;sourceHash:string;mode: 'parts' | 'atlas'; title: string; rigSize: [number, number] | null; items: Item[]; pages: Page[]; flags: Flag[];
  flagSources: string[]; flagMissing: string[]; verdictFile: string;
  verdict: { comments?:PartsComment[];status: string; parts: Record<string, Entry> } | null; verdictStale: 'files' | 'flags' | null;
}

/** Page pixels shown around a region in its own view, so the packer's bleed and padding are visible. */
export const REGION_MARGIN = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const access = pageInstanceAccess();
const stageEmbedded=new URL(location.href).searchParams.get('stageEmbed')==='1';
const stageSide=new URL(location.href).searchParams.get('side');
const partsApi=stageEmbedded?(stageSide==='a'||stageSide==='b'?`/api/compare/${stageSide}/stage-parts`:'/api/stage-parts'):'/api/parts';

const state = { data: null as ViewData | null, selected: 0, zoom: 1, bg: 'green', alpha: false, footprints: false, view: 'item' as 'item' | 'page', page: 0, meshShown: new Set<string>(), verdict: new Map<string, Entry>() };
const comments:PartsComment[]=[];let commentUi:ReturnType<typeof bindStageComments>|null=null;let viewport:ReturnType<typeof createPartsViewport>|null=null;let painting=0;
const images = new Map<string, HTMLImageElement>();

function load(src: string): Promise<HTMLImageElement> {
  const cached = images.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images.set(src, img); resolve(img); };
    img.onerror = () => reject(new Error(src));
    img.src = access.route(src);
  });
}
const itemImage = (item: Item) => load(`${partsApi}/image/${item.index}`);
const pageImage = (name: string) => { const page = state.data!.pages.find(p => p.name === name)!; return load(`${partsApi}/page/${page.index}`); };

function setCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  canvas.width = w; canvas.height = h;
  canvas.style.width = `${w * state.zoom}px`; canvas.style.height = `${h * state.zoom}px`;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function overlayBox(x: number, y: number, w: number, h: number): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'pv-box';
  div.style.left = `${x * state.zoom}px`; div.style.top = `${y * state.zoom}px`;
  div.style.width = `${w * state.zoom}px`; div.style.height = `${h * state.zoom}px`;
  return div;
}

let paintToken = 0;
async function paint():Promise<void>{painting++;try{await paintRaster();await paintReference();viewport?.fitCamera();}finally{painting--;}}
async function paintRaster(): Promise<void> {
  const data = state.data;
  if (!data || !data.items.length) return;
  const token = ++paintToken, canvas = $<HTMLCanvasElement>('pv-canvas'), overlay = $('pv-overlay'), caption = $('pv-caption');
  const item = data.items[state.selected]!;
  if (data.mode === 'atlas' && state.view === 'page') {
    const page = data.pages[state.page]!, img = await pageImage(page.name);
    if (token !== paintToken) return;
    const ctx = setCanvas(canvas, page.width, page.height);
    if (state.alpha) paintAlphaOnly(ctx, img, 0, 0, page.width, page.height);
    else { paintBackground(ctx, page.width, page.height, state.bg); ctx.drawImage(img, 0, 0); }
    overlay.replaceChildren(...data.items.filter(r => r.page === page.name).map(r => {
      const box = overlayBox(r.x, r.y, r.w, r.h);
      box.dataset.region = r.name; box.dataset.x = String(r.x); box.dataset.y = String(r.y); box.dataset.w = String(r.w); box.dataset.h = String(r.h);
      if (r.index === item.index) box.setAttribute('aria-current', 'true');
      const label = document.createElement('span'); label.textContent = r.name; box.append(label);
      box.title = `${r.name} · ${r.x},${r.y} ${r.w}×${r.h}${r.degrees ? ` · ${r.degrees}°` : ''}`;
      box.onclick = () => { select(r.index); setView('item'); };
      return box;
    }));
    const regions = data.items.filter(r => r.page === page.name).length;
    caption.textContent = regions === 1
      ? t('Page {name}: {width}×{height} px, 1 region. The background shows through padding; a region box is the packer\'s, and pixels outside it are bleed.', { name: page.name, width: page.width, height: page.height })
      : t('Page {name}: {width}×{height} px, {count} regions. The background shows through padding; a region box is the packer\'s, and pixels outside it are bleed.', { name: page.name, width: page.width, height: page.height, count: regions });
    return;
  }
  if (data.mode === 'atlas') {
    const page = data.pages.find(p => p.name === item.page)!, img = await pageImage(item.page!);
    if (token !== paintToken) return;
    const x0 = Math.max(0, item.x - REGION_MARGIN), y0 = Math.max(0, item.y - REGION_MARGIN);
    const x1 = Math.min(page.width, item.x + item.w + REGION_MARGIN), y1 = Math.min(page.height, item.y + item.h + REGION_MARGIN);
    const ctx = setCanvas(canvas, x1 - x0, y1 - y0);
    if (state.alpha) paintAlphaOnly(ctx, img, x0, y0, x1 - x0, y1 - y0);
    else { paintBackground(ctx, x1 - x0, y1 - y0, state.bg); ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0); }
    const edge = overlayBox(item.x - x0, item.y - y0, item.w, item.h);
    edge.className = 'pv-region-edge';
    overlay.replaceChildren(edge);
    caption.textContent = t('Region {name} on {page} at {x},{y}, {width}×{height} px, with {margin} px of the page around it (dashed: the region box).', { name: item.name, page: item.page!, x: item.x, y: item.y, width: item.w, height: item.h, margin: REGION_MARGIN }) + (item.degrees ? ' ' + t('Packed at {degrees}°.', { degrees: item.degrees }) : '');
    return;
  }
  const img = await itemImage(item), front = state.footprints ? frontParts(data.items, item) : [];
  const fronts = await Promise.all(front.map(async o => ({ o, img: await itemImage(o) })));
  if (token !== paintToken) return;
  const ctx = setCanvas(canvas, item.w, item.h);
  paintPart(ctx, item, img, { bg: state.bg, alpha: state.alpha, fronts: fronts.map(f => ({ box: f.o, image: f.img })), makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }) });
  if (item.mesh && state.meshShown.has(item.name)) paintMesh(ctx, img, item.w, item.h, item.mesh, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  overlay.replaceChildren(...data.flags.filter((f): f is Extract<Flag, { kind: 'faint' }> => f.item === item.name && f.kind === 'faint').map(f => {
    const box = overlayBox(f.box[0], f.box[1], f.box[2], f.box[3]);
    box.dataset.flag = f.id;
    return box;
  }));
  caption.textContent = t('{name}: {width}×{height} px at {x},{y} in rig px, draw order {order} of {count}.', { name: item.name, width: item.w, height: item.h, x: item.x, y: item.y, order: item.index + 1, count: data.items.length })
    + (state.footprints ? ' ' + (front.length === 1 ? t('Tinted: the footprint of the part drawn in front ({names}).', { names: front[0]!.name }) : front.length ? t('Tinted: the footprints of {count} parts drawn in front ({names}).', { count: front.length, names: front.map(o => o.name).join(', ') }) : t('No part is drawn in front of it.')) : '');
}

async function paintReference():Promise<void>{const data=state.data,item=data?.items[state.selected];if(!data?.painting||!item)return;const img=await load('/api/parts/painting'),canvas=$<HTMLCanvasElement>('pv-reference');canvas.width=item.w;canvas.height=item.h;const ctx=canvas.getContext('2d')!;ctx.imageSmoothingEnabled=false;paintBackground(ctx,item.w,item.h,state.bg);ctx.drawImage(img,item.x,item.y,item.w,item.h,0,0,item.w,item.h);}

function renderFlags(): void {
  const data = state.data!, item = data.items[state.selected];
  const list = $('pv-flags');
  const flags = item ? data.flags.filter(f => f.item === item.name) : [];
  const row = (f: Flag): HTMLLIElement => {
    const li = document.createElement('li');
    li.dataset.flagId = f.id; li.dataset.flagSource = f.source;
    const label = document.createElement('span'); label.className = 'pv-flag-label'; label.textContent = flagLabel(f, t);
    li.append(label);
    if (f.kind === 'check') {
      // The producer's object, verbatim, one click away: the label names its fields and hides none of it.
      const raw = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('code');
      summary.textContent = t('Producer line'); code.textContent = `${f.path}: ${f.line}`;
      raw.append(summary, code); li.append(raw);
    }
    return li;
  };
  // Source and producer-root groups are presentation only. Every original row and verdict flag id is retained.
  list.replaceChildren(...(['mesh_report', 'check'] as const).flatMap(source => {
    const fromSource = flags.filter(f => f.source === source);
    if (!fromSource.length) return [];
    const sourceItem = document.createElement('li'), heading = document.createElement('h3');
    sourceItem.dataset.pvSource = source;
    heading.textContent = source === 'mesh_report' ? 'mesh_report.json' : 'check.json';
    sourceItem.append(heading);
    const roots = new Map<string, Flag[]>();
    for (const f of fromSource) {
      const root = f.kind === 'check' ? f.root : 'contour.bridges.faint';
      const group = roots.get(root) ?? [];
      group.push(f); roots.set(root, group);
    }
    for (const [root, group] of roots) {
      const details = document.createElement('details'), summary = document.createElement('summary'), rows = document.createElement('ul');
      details.dataset.pvRoot = root; details.dataset.flagSource = source;
      summary.textContent = group.length === 1 ? t('{root} · 1 row', { root }) : t('{root} · {count} rows', { root, count: group.length });
      rows.append(...group.map(row)); details.append(summary, rows); sourceItem.append(details);
    }
    return [sourceItem];
  }));
  if (!flags.length) { const li = document.createElement('li'); li.className = 'pv-none'; li.textContent = t('No producer flag names this part.'); list.replaceChildren(li); }
  $('pv-flag-sources').textContent = [
    data.flagSources.length ? t('Read from: {files}.', { files: data.flagSources.join(', ') }) : '',
    data.flagMissing.length ? t('Not found: {files}.', { files: data.flagMissing.join(', ') }) : '',
    t('Occlusion coverage is not read yet: the producer does not write it.'),
    t('Grouped by source and producer root; counts are rows, not a classification of defects.'),
  ].filter(Boolean).join(' ');
}

function renderList(): void {
  const data = state.data!, list = $('pv-items');
  const seen = new Set<string>();
  list.replaceChildren(...data.items.filter(i => !seen.has(i.name) && seen.add(i.name)).map(item => {
    const li = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.dataset.pvItem = item.name; button.title = item.name;
    if (data.items[state.selected]?.name === item.name) button.setAttribute('aria-current', 'true');
    const name = document.createElement('span'); name.className = 'pv-name'; name.textContent = item.name;
    const onItem = data.flags.filter(f => f.item === item.name);
    const flags = document.createElement('span'); flags.className = 'pv-count';
    // flagSources holds actual basenames (including custom.json); flagMissing canonically names unread kinds.
    const meshRead = !data.flagMissing.includes('mesh_report.json'), checkRead = !data.flagMissing.includes('check.json');
    const mesh = onItem.filter(f => f.source === 'mesh_report').length, check = onItem.filter(f => f.source === 'check').length;
    if (onItem.length) {
      if (meshRead && checkRead) flags.textContent = t('mesh {mesh} · check {check}', { mesh, check });
      else if (meshRead) flags.textContent = t('mesh {mesh}', { mesh });
      else if (checkRead) flags.textContent = t('check {check}', { check });
    }
    const outcome = state.verdict.get(item.name)?.outcome ?? 'pending';
    const badge = document.createElement('span'); badge.className = 'pv-badge'; badge.dataset.outcome = outcome; badge.textContent = t(outcome === 'clean' ? 'Clean' : outcome === 'flagged' ? 'Flagged' : 'Pending');
    button.append(name, flags, badge);
    button.onclick = () => { select(item.index); if (data.mode === 'atlas') setView('item'); };
    li.append(button);
    return li;
  }));
}

function renderVerdict(): void {
  const item = state.data!.items[state.selected];
  if (!item) return;
  const entry = state.verdict.get(item.name) ?? { outcome: 'pending' as Outcome, note: '' };
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[data-pv-outcome]')) radio.checked = radio.value === entry.outcome;
  $<HTMLTextAreaElement>('pv-note').value = entry.note;
  $('pv-comment-count').textContent=t('Comments on this part: {count}',{count:comments.filter(c=>c.part===item.name).length});
}

function renderMesh(): void {
  document.getElementById('pv-mesh-panel')?.remove();
  document.getElementById('pv-mesh-control')?.remove();
  const item = state.data!.items[state.selected]!;
  if (!item.mesh) return;
  const control = document.createElement('label'); control.id = 'pv-mesh-control'; control.className = 'pv-field';
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = state.meshShown.has(item.name);
  toggle.onchange = () => { if (toggle.checked) state.meshShown.add(item.name); else state.meshShown.delete(item.name); void paint(); };
  control.append(toggle, t('mesh from rig.json UVs')); document.querySelector('.pv-toolbar')!.append(control);
  const panel = document.createElement('section'); panel.id = 'pv-mesh-panel';
  const heading = document.createElement('h2'); heading.textContent = t('Mesh geometry'); panel.append(heading);
  const figures = document.createElement('dl');
  for (const key of ['mode', 'vertices', 'triangles', 'art_coverage', 'stray_cleared']) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = key;
    dd.textContent = Object.hasOwn(item.mesh.figures, key) ? JSON.stringify(item.mesh.figures[key]) : t('not reported');
    dd.dataset.meshFigure = key; figures.append(dt, dd);
  }
  panel.append(figures);
  const help = document.createElement('p'); help.textContent = t('Pink: art pixels outside every triangle.'); panel.append(help);
  const entry = state.verdict.get(item.name)!;
  const select = document.createElement('select'); select.setAttribute('aria-label', t('Mesh outcome'));
  for (const [value, label] of [['pending', 'Pending'], ['clean', 'Clean'], ['flagged', 'Flagged']]) { const option = document.createElement('option'); option.value = value!; option.textContent = t(label!); select.append(option); }
  select.value = entry.mesh!.outcome;
  const note = document.createElement('textarea'); note.maxLength = 10000; note.value = entry.mesh!.note; note.setAttribute('aria-label', t('Mesh note'));
  select.onchange = () => { entry.mesh!.outcome = select.value as Outcome; };
  note.oninput = () => { entry.mesh!.note = note.value; };
  const outcomeLabel = document.createElement('label'), noteLabel = document.createElement('label');
  outcomeLabel.append(t('Mesh outcome'), select); noteLabel.append(t('Mesh note'), note);
  panel.append(outcomeLabel, noteLabel); document.querySelector('.pv-verdict')!.before(panel);
}

function select(index: number): void {
  const data = state.data!;
  const changed=state.selected!==index;state.selected = index;if(changed&&viewport){viewport.writeCamera('rig',{zoom:1,center:null});viewport.writeCamera('reference',{zoom:1,center:null});}
  commentUi?.refresh();
  const item = data.items[index]!;
  if (item.page !== undefined) state.page = data.pages.findIndex(p => p.name === item.page);
  renderList(); renderFlags(); renderVerdict(); renderMesh(); void paint();
}

function setView(view: 'item' | 'page'): void {
  state.view = view;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.setAttribute('aria-pressed', String(b.dataset.pvView === view));
  void paint();
}

function updateEntry(change: Partial<{ outcome: Outcome; note: string }>): void {
  const item = state.data!.items[state.selected]!;
  const entry = { ...(state.verdict.get(item.name) ?? { outcome: 'pending' as Outcome, note: '' }), ...change };
  state.verdict.set(item.name, entry);
  renderList();
}

async function save(): Promise<void> {
  if(stageEmbedded)return;
  const status = $('pv-save-status');
  const body = { status: $<HTMLSelectElement>('pv-overall').value, parts: Object.fromEntries(state.verdict),comments };
  const res = await fetch(access.route('/api/parts/verdict'), { method: 'POST', headers: access.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const out = await res.json() as { error?: string; verdict?: { source: { sha256: string } } };
  status.textContent = res.ok ? t('Saved {file}: source {hash}.', { file: state.data!.verdictFile, hash: out.verdict!.source.sha256.slice(0, 12) }) : out.error ?? t('Save failed.');
  status.dataset.result = res.ok ? 'saved' : 'refused';
}

async function boot(): Promise<void> {
  const box=$('pv-canvas-box'),layout=$('stage-layout');mountViewportPair(layout);$('rig-root').append(box);const reference=document.createElement('canvas');reference.id='pv-reference';$('reference-content').append(reference);$('rig-empty').hidden=true;$('rig-overlay').hidden=true;$('rig-label').textContent=t('Selected part');$('rig-viewport').tabIndex=0;
  viewport=createPartsViewport({el:$,canvas:$<HTMLCanvasElement>('pv-canvas'),message:(msg)=>{$('pv-save-status').textContent=t(msg);},reference:()=>state.data?.painting?$<HTMLCanvasElement>('pv-reference'):null});viewport.bindControls();
  $('native-one').onclick=()=>viewport!.cameraAction(()=>viewport!.updateCamera(viewport!.availableCamera()??'rig',{zoom:1,pan:{x:0,y:0}}));
  bindDomI18n(document);
  bindStageNav({partsOnly:true,model:false});
  if(stageEmbedded){
    const header=document.querySelector<HTMLElement>('.pv-top')!,status=$('pv-load');
    header.hidden=true;status.classList.add('pv-embedded-status');header.after(status);
    document.querySelector<HTMLElement>('.pv-layout')!.hidden=true;
    document.querySelector<HTMLElement>('.pv-verdict')!.hidden=true;
    const saveButton=$<HTMLButtonElement>('pv-save');saveButton.disabled=true;saveButton.title=t('Embedded atlas inspection is read-only. Use the parts command for a separate sign-off.');
  }
  window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='review-stage-language'||!['en','ko'].includes(event.data.language))return;setLinkLanguage(null);setLanguagePreference(event.data.language);});
  connectLiveWindow(access);
  const res = await fetch(access.route(partsApi), { headers: access.headers() });
  const data = await res.json() as ViewData & { error?: string };
  if (!res.ok) { const status=$('pv-load');status.textContent=t(data.error??'Load failed.');status.dataset.result='refused';return; }
  state.data = data;$('reference-empty').textContent=data.painting?'':t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');$('reference-empty').hidden=!!data.painting;if(data.painting)viewport.state.cameraSync=true;comments.push(...data.verdict?.comments??[]);setupPartsComments();viewport.bindNavigation(undefined,()=>!commentUi?.active());viewport.observeResize();
  for (const item of data.items) state.verdict.set(item.name, { outcome: 'pending', note: '', ...(item.mesh ? { mesh: { outcome: 'pending' as Outcome, note: '' } } : {}) });
  if (data.verdict) { for (const [name, v] of Object.entries(data.verdict.parts)) if (state.verdict.has(name)) state.verdict.set(name, { outcome: v.outcome, note: v.note ?? '', ...(v.mesh ? { mesh: v.mesh } : {}) }); $<HTMLSelectElement>('pv-overall').value = data.verdict.status; }
  document.title = data.title;
  $('pv-title').textContent = data.title;
  $('pv-mode').textContent = data.mode === 'parts' ? t('Parts package, before rigging') : t('Atlas of a built rig');
  $('pv-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : data.verdict ? t('Saved sign-off loaded.') : '';
  if(stageEmbedded){$('pv-load').hidden=$('pv-load').textContent==='';document.querySelector<HTMLElement>('.pv-layout')!.hidden=false;}
  $('pv-atlas-switch').hidden = data.mode !== 'atlas';
  const footprints = $<HTMLInputElement>('pv-footprints');
  if (data.mode === 'atlas') { footprints.disabled = true; $('pv-footprint-control').title = t('Footprints need a parts package: atlas regions carry no rig placement.'); }
  $<HTMLSelectElement>('pv-bg').onchange = e => { state.bg = (e.target as HTMLSelectElement).value; void paint(); };
  $<HTMLInputElement>('pv-alpha').onchange = e => { state.alpha = (e.target as HTMLInputElement).checked; void paint(); };
  footprints.onchange = e => { state.footprints = (e.target as HTMLInputElement).checked; void paint(); };

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.onclick = () => setView(b.dataset.pvView as 'item' | 'page');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[data-pv-outcome]')) r.onchange = () => { if (r.checked) updateEntry({ outcome: r.value as Outcome }); };
  $<HTMLTextAreaElement>('pv-note').oninput = e => updateEntry({ note: (e.target as HTMLTextAreaElement).value });
  $('pv-save').onclick = () => { void save(); };
  for(const format of ['json','issue'])$('pv-export-'+format).onclick=async()=>{const res=await fetch(access.route('/api/parts/export?format='+format),{headers:access.headers()});const value=await res.text();if(!res.ok){$('pv-save-status').textContent=value;return;}const url=URL.createObjectURL(new Blob([value],{type:format==='json'?'application/json':'text/markdown'})),a=document.createElement('a');a.href=url;a.download=format==='json'?'parts-review-export.json':'parts-review-export.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  onLanguageChange(() => { if (state.data) select(state.selected); });
  if (data.items.length) select(0);
  document.body.dataset.ready = 'true';
}

interface PartsPose extends CommentUiPose {item:Item;sourceHash:string;view:PartsComment['view']}
function setupPartsComments():void {
 const codec:CommentCodec<PartsComment,PartsPose>={
 read:c=>{try{parsePartsComment(c);const camera={space:'image' as const,center:c.view.camera.center,zoom:c.view.camera.zoom,viewport:c.view.camera.viewport,visible:{x:c.view.camera.center.x-c.view.camera.viewport.width/c.view.camera.zoom/2,y:c.view.camera.center.y-c.view.camera.viewport.height/c.view.camera.zoom/2,width:c.view.camera.viewport.width/c.view.camera.zoom,height:c.view.camera.viewport.height/c.view.camera.zoom}};const r=c.imageRegion;return {mode:'parts',viewport:'rig',screen:region(projectMark(r,camera),projectMark({x:r.x+r.width,y:r.y+r.height},camera)),world:r,camera,crop:c.crop,bookmark:{part:c.part,imageHash:c.imageHash,sourceHash:c.sourceHash,view:c.view}};}catch{return null;}},
 signature:p=>[p.item.name,p.item.imageHash,p.sourceHash,p.camera,p.view],
 matches:(_mark,p,c)=>p.item.name===c.part&&p.item.imageHash===c.imageHash&&p.sourceHash===c.sourceHash,
 label:c=>`${c.part} · ${c.summary}`,
 create:async(p,_view,screen,crop,_bookmark,summary)=>{const r=snapImageRegion(region(unprojectMark(screen,p.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},p.camera)));const c:PartsComment={schema:'rig-review-parts-comment/1',id:crypto.randomUUID(),summary,part:p.item.name,imageHash:p.item.imageHash!,sourceHash:p.sourceHash,imageRegion:r,rigRegion:{...r,x:p.item.x+r.x,y:p.item.y+r.y},view:p.view,crop,nativeCrop:null};const res=await fetch(access.route('/api/parts/comment'),{method:'POST',headers:access.headers({'Content-Type':'application/json'}),body:JSON.stringify(c)}),out=await res.json() as {comment:PartsComment;error?:string};if(!res.ok)throw new Error(out.error);return parsePartsComment(out.comment);}
 };
 const pose=():PartsPose|null=>{const data=state.data,item=data?.items[state.selected],camera=viewport?.numericView().cameras.rig;if(!data||!item||!camera||data.mode!=='parts'||state.view!=='item')return null;return {mode:'parts',camera,item:{...item},sourceHash:data.sourceHash,view:{camera:{zoom:camera.zoom,center:{...camera.center},viewport:{...camera.viewport}},cameraSync:viewport!.state.cameraSync,referenceCamera:(()=>{const c=viewport!.numericView().cameras.reference;return c?{zoom:c.zoom,center:{...c.center},viewport:{...c.viewport}}:null;})(),background:state.bg,alpha:state.alpha,footprints:state.footprints,mesh:state.meshShown.has(item.name)},capture:{pane:$('rig-viewport'),root:$('rig-root'),images:true,canvas:$<HTMLCanvasElement>('pv-canvas'),backend:'canvas2d',nearest:true}};};
 commentUi=bindStageComments({toolbar:document.querySelector<HTMLElement>('.pv-toolbar')!,viewports:{rig:$('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
 restore:async(raw)=>{const b=raw as {part:string;imageHash:string;sourceHash:string;view:PartsComment['view']},item=state.data!.items.find(i=>i.name===b.part);if(!item||item.imageHash!==b.imageHash||state.data!.sourceHash!==b.sourceHash)throw new Error('PARTS_COMMENT_STALE_SOURCE: reopen the bound source');select(item.index);state.bg=b.view.background;state.alpha=b.view.alpha;state.footprints=b.view.footprints;if(b.view.mesh)state.meshShown.add(item.name);else state.meshShown.delete(item.name);$<HTMLSelectElement>('pv-bg').value=state.bg;$<HTMLInputElement>('pv-alpha').checked=state.alpha;$<HTMLInputElement>('pv-footprints').checked=state.footprints;renderMesh();viewport!.state.cameraRestoring=true;try{await paint();viewport!.writeCamera('rig',{zoom:b.view.camera.zoom,center:{...b.view.camera.center}});if(b.view.referenceCamera)viewport!.writeCamera('reference',{zoom:b.view.referenceCamera.zoom,center:{...b.view.referenceCamera.center}});viewport!.state.cameraSync=b.view.cameraSync;viewport!.fitCamera();}finally{viewport!.state.cameraRestoring=false;}},
 feedback:()=>comments,locked:()=>false,add:c=>comments.push(c),changed:()=>renderVerdict(),error:m=>{$('pv-save-status').textContent=t(m);},blocked:()=>painting>0,refusal:()=>state.data?.mode!=='parts'||stageEmbedded?'PARTS_COMMENT_UNAVAILABLE: original part image required':null,codec});
}

if (typeof document !== 'undefined' && document.getElementById('parts-app')) void boot();
