/**
 * The parts and atlas view (#348). Every part on its own, on a sentinel background, at native scale with 2× and 4×
 * nearest-neighbour zoom; the footprints of the parts drawn in front of it; the producer's flags on it; and a
 * per-part verdict saved as `rig-review-parts-verdict/1`. In atlas mode, the pages as packed with every region's box
 * and name, and a click from a region to its own view.
 *
 * Nothing here measures the art: flags come from the producer's files, and the footprint is the front parts' own
 * alpha drawn over the selected part (the parts.json draw order, back first, says which parts are in front).
 */
import { bindDomI18n, onLanguageChange, t } from './i18n.ts';
import { pageInstanceAccess } from './instance-access.ts';
import { connectLiveWindow } from './live-connection.ts';
import { flagLabel } from './parts-flags.ts';
import { frontParts, paintAlphaOnly, paintBackground, paintPart } from './parts-render.ts';

type Outcome = 'pending' | 'clean' | 'flagged';
interface Item { name: string; index: number; x: number; y: number; w: number; h: number; page?: string; degrees?: number; image?: boolean }
interface Page { name: string; width: number; height: number; index: number }
type Flag =
  | { id: string; item: string; source: 'mesh_report'; kind: 'faint'; art: number; maxAlpha: number; box: [number, number, number, number] }
  | { id: string; item: string; source: 'check'; kind: 'check'; path: string; line: string; root: string; status: string | null; entry: Record<string, unknown> };
interface ViewData {
  mode: 'parts' | 'atlas'; title: string; rigSize: [number, number] | null; items: Item[]; pages: Page[]; flags: Flag[];
  flagSources: string[]; flagMissing: string[]; verdictFile: string;
  verdict: { status: string; parts: Record<string, { outcome: Outcome; note: string }> } | null; verdictStale: 'files' | 'flags' | null;
}

/** Page pixels shown around a region in its own view, so the packer's bleed and padding are visible. */
export const REGION_MARGIN = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const access = pageInstanceAccess();
const state = { data: null as ViewData | null, selected: 0, zoom: 1, bg: 'green', alpha: false, footprints: false, view: 'item' as 'item' | 'page', page: 0, verdict: new Map<string, { outcome: Outcome; note: string }>() };
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
const itemImage = (item: Item) => load(`/api/parts/image/${item.index}`);
const pageImage = (name: string) => { const page = state.data!.pages.find(p => p.name === name)!; return load(`/api/parts/page/${page.index}`); };

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
async function paint(): Promise<void> {
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
  overlay.replaceChildren(...data.flags.filter((f): f is Extract<Flag, { kind: 'faint' }> => f.item === item.name && f.kind === 'faint').map(f => {
    const box = overlayBox(f.box[0], f.box[1], f.box[2], f.box[3]);
    box.dataset.flag = f.id;
    return box;
  }));
  caption.textContent = t('{name}: {width}×{height} px at {x},{y} in rig px, draw order {order} of {count}.', { name: item.name, width: item.w, height: item.h, x: item.x, y: item.y, order: item.index + 1, count: data.items.length })
    + (state.footprints ? ' ' + (front.length === 1 ? t('Tinted: the footprint of the part drawn in front ({names}).', { names: front[0]!.name }) : front.length ? t('Tinted: the footprints of {count} parts drawn in front ({names}).', { count: front.length, names: front.map(o => o.name).join(', ') }) : t('No part is drawn in front of it.')) : '');
}

function renderFlags(): void {
  const data = state.data!, item = data.items[state.selected];
  const list = $('pv-flags');
  const flags = item ? data.flags.filter(f => f.item === item.name) : [];
  list.replaceChildren(...flags.map(f => {
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
  }));
  if (!flags.length) { const li = document.createElement('li'); li.className = 'pv-none'; li.textContent = t('No producer flag names this part.'); list.replaceChildren(li); }
  $('pv-flag-sources').textContent = [
    data.flagSources.length ? t('Read from: {files}.', { files: data.flagSources.join(', ') }) : '',
    data.flagMissing.length ? t('Not found: {files}.', { files: data.flagMissing.join(', ') }) : '',
    t('Occlusion coverage is not read yet: the producer does not write it.'),
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
    const count = data.flags.filter(f => f.item === item.name).length;
    const flags = document.createElement('span'); flags.className = 'pv-count'; flags.textContent = count ? `⚑${count}` : '';
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
}

function select(index: number): void {
  const data = state.data!;
  state.selected = index;
  const item = data.items[index]!;
  if (item.page !== undefined) state.page = data.pages.findIndex(p => p.name === item.page);
  renderList(); renderFlags(); renderVerdict(); void paint();
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
  const status = $('pv-save-status');
  const body = { status: $<HTMLSelectElement>('pv-overall').value, parts: Object.fromEntries(state.verdict) };
  const res = await fetch(access.route('/api/parts/verdict'), { method: 'POST', headers: access.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const out = await res.json() as { error?: string; verdict?: { source: { sha256: string } } };
  status.textContent = res.ok ? t('Saved {file}: source {hash}.', { file: state.data!.verdictFile, hash: out.verdict!.source.sha256.slice(0, 12) }) : out.error ?? t('Save failed.');
  status.dataset.result = res.ok ? 'saved' : 'refused';
}

async function boot(): Promise<void> {
  bindDomI18n(document);
  connectLiveWindow(access);
  const res = await fetch(access.route('/api/parts'), { headers: access.headers() });
  const data = await res.json() as ViewData & { error?: string };
  if (!res.ok) { $('pv-load').textContent = data.error ?? t('Load failed.'); return; }
  state.data = data;
  for (const item of data.items) state.verdict.set(item.name, { outcome: 'pending', note: '' });
  if (data.verdict) { for (const [name, v] of Object.entries(data.verdict.parts)) if (state.verdict.has(name)) state.verdict.set(name, { outcome: v.outcome, note: v.note ?? '' }); $<HTMLSelectElement>('pv-overall').value = data.verdict.status; }
  document.title = data.title;
  $('pv-title').textContent = data.title;
  $('pv-mode').textContent = data.mode === 'parts' ? t('Parts package, before rigging') : t('Atlas of a built rig');
  $('pv-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : data.verdict ? t('Saved sign-off loaded.') : '';
  $('pv-atlas-switch').hidden = data.mode !== 'atlas';
  const footprints = $<HTMLInputElement>('pv-footprints');
  if (data.mode === 'atlas') { footprints.disabled = true; $('pv-footprint-control').title = t('Footprints need a parts package: atlas regions carry no rig placement.'); }
  $<HTMLSelectElement>('pv-bg').onchange = e => { state.bg = (e.target as HTMLSelectElement).value; void paint(); };
  $<HTMLInputElement>('pv-alpha').onchange = e => { state.alpha = (e.target as HTMLInputElement).checked; void paint(); };
  footprints.onchange = e => { state.footprints = (e.target as HTMLInputElement).checked; void paint(); };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-zoom]')) b.onclick = () => { state.zoom = Number(b.dataset.pvZoom); for (const o of document.querySelectorAll<HTMLButtonElement>('[data-pv-zoom]')) o.setAttribute('aria-pressed', String(o === b)); void paint(); };
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.onclick = () => setView(b.dataset.pvView as 'item' | 'page');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[data-pv-outcome]')) r.onchange = () => { if (r.checked) updateEntry({ outcome: r.value as Outcome }); };
  $<HTMLTextAreaElement>('pv-note').oninput = e => updateEntry({ note: (e.target as HTMLTextAreaElement).value });
  $('pv-save').onclick = () => { void save(); };
  onLanguageChange(() => { if (state.data) select(state.selected); });
  if (data.items.length) select(0);
  document.body.dataset.ready = 'true';
}

if (typeof document !== 'undefined' && document.getElementById('parts-app')) void boot();
