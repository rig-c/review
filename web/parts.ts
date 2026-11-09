import {defaultPartsComparison,paintingRectangle,type PartsComparison} from '../src/parts-comparison.ts';
import {mountViewportPair} from './viewport-pair.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
import {bindStageComments,type CommentUiPose,type CommentCodec} from './stage-comments.ts';
import {parsePartsComment,snapImageRegion,type PartsComment} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {bindStageNav,stagePartsSelectionIndex,type StagePartsState,type StagePartsWindow} from './stage-nav.ts';
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
import { flagLabel, readingGroup, countedFlag } from './parts-flags.ts';
import { paintAssembly, pickAssembly, paintAssemblyOutline, frontParts, paintAlphaOnly, paintBackground, paintPart, paintMesh, paintOverlay, paintPaintingCrop, paintFootprints } from './parts-render.ts';

type Outcome = 'pending' | 'clean' | 'flagged';
interface Mesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown> }
interface Entry { outcome: Outcome; note: string; mesh?: { outcome: Outcome; note: string } }
interface Item { mesh?: Mesh; name: string; index: number; x: number; y: number; w: number; h: number; page?: string; degrees?: number; image?: boolean;imageHash?:string }
interface Page { name: string; width: number; height: number; index: number }
type Flag =
  | { id: string; item: string; source: 'mesh_report'; kind: 'faint'; art: number; maxAlpha: number; box: [number, number, number, number] }
  | { id: string; item: string; source: 'check'; kind: 'check'; path: string; line: string; root: string; status: string | null; entry: Record<string, unknown>; classification?: 'part' | 'pair' | 'evidence' | 'unclassified' };
interface ViewData {
 inspectionSourceHash?:string;
 joinedVerdictBinding?:string;
 verdictReadOnlyReason?:string;
 draft?:{inspectionOnly?:boolean;label:string;buildId:string;inspectionSourceHash:string;mappings:{part:string;skin:string;slot:string;attachment:string;vertices:number;triangles:number}[];evidence:unknown};draftUnavailable?:string;
  differenceAvailable?:boolean;painting:{sha256:string;width:number;height:number}|null;sourceHash:string;mode: 'parts' | 'atlas'; title: string; rigSize: [number, number] | null; items: Item[]; pages: Page[]; flags: Flag[]; readings?: Flag[];
  flagSources: string[]; flagMissing: string[]; verdictFile: string;
  verdict: { comments?:PartsComment[];status: string; parts: Record<string, Entry> } | null; verdictStale: 'files' | 'flags' | null;
}

/** Page pixels shown around a region in its own view, so the packer's bleed and padding are visible. */
export const REGION_MARGIN = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const access = pageInstanceAccess();
const stageEmbedded=new URL(location.href).searchParams.get('stageEmbed')==='1';
const stageSide=new URL(location.href).searchParams.get('side');
let stageBuild='inspected',stageRestore:StagePartsState|null=null;
let receiveSource:()=>void=()=>{};const sourceReady=new Promise<void>(resolve=>{receiveSource=resolve;});
if(typeof window!=='undefined')window.addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data?.type==='review-stage-source'&&(event.data.buildId==='inspected'||/^[a-f0-9]{64}$/.test(event.data.buildId))){stageBuild=event.data.buildId;stageRestore=event.data.state??null;receiveSource();}});
const stageHeaders=()=>access.headers(stageEmbedded?{'X-Review-Stage-Build':stageBuild}:{});
const partsApi=stageEmbedded?(stageSide==='a'||stageSide==='b'?`/api/compare/${stageSide}/stage-parts`:'/api/stage-parts'):'/api/parts';

const state = { data: null as ViewData | null, selected: 0, zoom: 1, bg: 'green', alpha: false, footprints: false, comparison:defaultPartsComparison(), differenceThreshold:0, hidden: new Set<string>(), view: 'item' as 'item' | 'page' | 'assembled', page: 0, meshShown: new Set<string>(), verdict: new Map<string, Entry>() };
const comments:PartsComment[]=[];let commentUi:ReturnType<typeof bindStageComments>|null=null;let viewport:ReturnType<typeof createPartsViewport>|null=null;let painting=false;
const images = new Map<string, HTMLImageElement>();

function load(src: string): Promise<HTMLImageElement> {
  const cached = images.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { images.set(src, img); resolve(img); };
    img.onerror = () => reject(new Error(src));
    if(stageEmbedded)void fetch(access.route(src),{headers:stageHeaders()}).then(async res=>{if(!res.ok)throw new Error('STAGE_DRAFT_CHANGED');const url=URL.createObjectURL(await res.blob());img.addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});img.src=url;}).catch(reject);
    else img.src = access.route(src);
  });
}
const itemImage = (item: Item) => load(`${partsApi}/image/${item.index}`);
const pageImage = (name: string) => { const page = state.data?.pages.find(p => p.name === name); return page ? load(`${partsApi}/page/${page.index}`) : Promise.reject(new Error('PARTS_PAINT_FAILED')); };

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
let paintFailure:string|null=null,paintReset=false;
async function paint():Promise<void>{
 const token=++paintToken;painting=true;
 try{
  await paintRaster(token);if(token!==paintToken)return;
  await paintReference(token);if(token!==paintToken)return;
  if(paintFailure)$('pv-save-status').textContent='';paintFailure=null;viewport?.fitCamera();commentUi?.refresh();
 }catch(error){
  if(token!==paintToken)return;
  const failure=error instanceof Error&&error.message.startsWith('PARTS_DIFFERENCE_')?error.message:'PARTS_PAINT_FAILED: view could not be rendered; select the part to retry';
  const canvas=$<HTMLCanvasElement>('pv-canvas');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
  const ref=$<HTMLCanvasElement>('pv-reference') as HTMLCanvasElement|null;if(ref){if(canvas.width>0&&canvas.height>0){ref.width=canvas.width;ref.height=canvas.height;}ref.getContext('2d')?.clearRect(0,0,ref.width,ref.height);}
  $('pv-overlay').replaceChildren();$('pv-caption').textContent=t(failure);$('pv-save-status').textContent=t(failure);
  painting=false;paintFailure=null;paintReset=true;
  try{viewport?.writeCamera?.('rig',{zoom:1,center:null});viewport?.writeCamera?.('reference',{zoom:1,center:null});viewport?.fitCamera();}
  finally{paintReset=false;paintFailure=failure;}
  commentUi?.refresh();
 }finally{if(token===paintToken)painting=false;}
}
const assemblyAlpha=new Map<string,Uint8ClampedArray>();
function sourceAlpha(item:Item,img:HTMLImageElement):Uint8ClampedArray {
 const cached=assemblyAlpha.get(item.name);if(cached)return cached;
 const c=document.createElement('canvas');c.width=item.w;c.height=item.h;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);
 const rgba=ctx.getImageData(0,0,item.w,item.h).data,alpha=new Uint8ClampedArray(item.w*item.h);for(let i=0;i<alpha.length;i++)alpha[i]=rgba[i*4+3]!;assemblyAlpha.set(item.name,alpha);return alpha;
}

function partFrame(data:ViewData,item:Item) {
  if(state.view==='assembled'&&data.rigSize) {
    return {x:0,y:0,w:data.rigSize[0],h:data.rigSize[1]};
  }
  return item;
}

function rasterFrame(data:ViewData,item:Item):{x:number;y:number;w:number;h:number}|null {
  if(data.mode==='parts')return partFrame(data,item);
  if(state.view==='page') {
    const page=data.pages[state.page];
    return page?{x:0,y:0,w:page.width,h:page.height}:null;
  }
  const page=data.pages.find(p=>p.name===item.page);
  if(!page)return null;
  const x=Math.max(0,item.x-REGION_MARGIN),y=Math.max(0,item.y-REGION_MARGIN);
  const right=Math.min(page.width,item.x+item.w+REGION_MARGIN);
  const bottom=Math.min(page.height,item.y+item.h+REGION_MARGIN);
  return {x,y,w:right-x,h:bottom-y};
}

async function paintRaster(token:number): Promise<void> {
  const data = state.data;
  if (!data || !data.items.length) return;
  const canvas = $<HTMLCanvasElement>('pv-canvas'), overlay = $('pv-overlay'), caption = $('pv-caption');
  const item = data.items[state.selected]!;
  const frame=rasterFrame(data,item);
  if(!frame)throw new Error('PARTS_PAINT_FAILED');
  const {x,y,w,h}=frame;
  if(state.view==='assembled'&&data.mode==='parts'&&data.rigSize){
    const shown=data.items.filter(i=>!state.hidden.has(i.name));
    const layers=await Promise.all(shown.map(async box=>({box,image:await itemImage(box)})));
    const original=state.comparison.mode==='overlay'&&data.painting?await load('/api/parts/painting'):null;
    if(token!==paintToken)return;
    const ctx=setCanvas(canvas,w,h);
    if(original){
      paintPaintingCrop(ctx,original,paintingRectangle({x:0,y:0,w,h},data.rigSize,data.painting!),w,h,state.bg);
      const assembled=document.createElement('canvas');assembled.width=w;assembled.height=h;const a=assembled.getContext('2d')!;a.imageSmoothingEnabled=false;for(const l of layers)a.drawImage(l.image,l.box.x,l.box.y);ctx.globalAlpha=state.comparison.opacity;ctx.drawImage(assembled,0,0);ctx.globalAlpha=1;
    }else paintAssembly(ctx,w,h,layers,{bg:state.bg,alpha:state.alpha});
    overlay.replaceChildren();
    const selected=layers.find(l=>l.box.name===item.name);
    if(selected){const outline=document.createElement('canvas');outline.width=w;outline.height=h;outline.dataset.assemblyOutline=item.name;paintAssemblyOutline(outline.getContext('2d')!,item,sourceAlpha(item,selected.image));overlay.append(outline);}
    caption.textContent=t('Assembled package · {count} visible parts. Selection and verdict remain per part.',{count:shown.length});
    return;
  }
  if (data.mode === 'atlas' && state.view === 'page') {
    const page = data.pages[state.page]!, img = await pageImage(page.name);
    if (token !== paintToken) return;
    const ctx = setCanvas(canvas, w, h);
    if (state.alpha) paintAlphaOnly(ctx, img, 0, 0, page.width, page.height);
    else { paintBackground(ctx, page.width, page.height, state.bg); ctx.drawImage(img, 0, 0); }
    overlay.replaceChildren(...data.items.filter(r => r.page === page.name).map(r => {
      const box = overlayBox(r.x, r.y, r.w, r.h);
      box.dataset.viewportAction = 'select-region';
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
    const ctx = setCanvas(canvas, w, h);
    if (state.alpha) paintAlphaOnly(ctx, img, x, y, w, h);
    else { paintBackground(ctx, w, h, state.bg); ctx.drawImage(img, x, y, w, h, 0, 0, w, h); }
    const edge = overlayBox(item.x - x, item.y - y, item.w, item.h);
    edge.className = 'pv-region-edge';
    overlay.replaceChildren(edge);
    caption.textContent = t('Region {name} on {page} at {x},{y}, {width}×{height} px, with {margin} px of the page around it (dashed: the region box).', { name: item.name, page: item.page!, x: item.x, y: item.y, width: item.w, height: item.h, margin: REGION_MARGIN }) + (item.degrees ? ' ' + t('Packed at {degrees}°.', { degrees: item.degrees }) : '');
    return;
  }
  if(state.comparison.mode==='difference'){
    const response=await fetch(access.route(`${partsApi}/difference/${item.index}?threshold=${state.comparison.threshold}&footprints=${state.footprints}`),{headers:stageHeaders()});
    if(!response.ok){const out=await response.json() as {error:string};throw new Error(out.error);}
    const image=await createImageBitmap(await response.blob());
    try{if(token!==paintToken)return;const ctx=setCanvas(canvas,w,h);paintBackground(ctx,w,h,state.bg);ctx.drawImage(image,0,0);overlay.replaceChildren();
      caption.textContent=t('Difference: {count} pixels above threshold · {covered} covered pixels excluded · visual comparison, no automatic verdict.',{count:response.headers.get('X-Difference-Count')??'',covered:response.headers.get('X-Difference-Covered')??''});
    }finally{image.close();}return;
  }
  const img = await itemImage(item), front = state.footprints ? frontParts(data.items, item) : [];
  const fronts = await Promise.all(front.map(async o => ({ o, img: await itemImage(o) })));
  const original=state.comparison.mode==='overlay'&&data.painting?await load('/api/parts/painting'):null;
  if (token !== paintToken) return;
  const ctx = setCanvas(canvas, w, h);
  const makeCanvas=(w:number,h:number)=>Object.assign(document.createElement('canvas'),{width:w,height:h});
  if(original){paintOverlay(ctx,item,img,original,paintingRectangle(item,data.rigSize!,data.painting!),state.comparison.opacity,state.bg);paintFootprints(ctx,item,fronts.map(f=>({box:f.o,image:f.img})),makeCanvas);}
  else paintPart(ctx, item, img, { bg: state.bg, alpha: state.alpha, fronts: fronts.map(f => ({ box: f.o, image: f.img })), makeCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }) });
  if (!original && item.mesh && state.meshShown.has(item.name)) paintMesh(ctx, img, item.w, item.h, item.mesh, (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }));
  overlay.replaceChildren(...data.flags.filter((f): f is Extract<Flag, { kind: 'faint' }> => f.item === item.name && f.kind === 'faint').map(f => {
    const box = overlayBox(f.box[0], f.box[1], f.box[2], f.box[3]);
    box.dataset.flag = f.id;
    return box;
  }));
  caption.textContent = t('{name}: {width}×{height} px at {x},{y} in rig px, draw order {order} of {count}.', { name: item.name, width: item.w, height: item.h, x: item.x, y: item.y, order: item.index + 1, count: data.items.length })
    + (state.footprints ? ' ' + (front.length === 1 ? t('Tinted: the footprint of the part drawn in front ({names}).', { names: front[0]!.name }) : front.length ? t('Tinted: the footprints of {count} parts drawn in front ({names}).', { count: front.length, names: front.map(o => o.name).join(', ') }) : t('No part is drawn in front of it.')) : '');
}

async function paintReference(token:number):Promise<void>{const data=state.data,item=data?.items[state.selected];if(!data?.painting||!item)return;const img=await load('/api/parts/painting');if(token!==paintToken||data!==state.data||item!==state.data?.items[state.selected])return;const box=partFrame(data,item);const canvas=$<HTMLCanvasElement>('pv-reference');canvas.width=box.w;canvas.height=box.h;const ctx=canvas.getContext('2d')!;paintPaintingCrop(ctx,img,paintingRectangle(box,data.rigSize!,data.painting),box.w,box.h,state.bg);}

function renderComparison():void {
 const active=state.data?.mode==='parts'&&(!!state.data.painting||!!state.data.differenceAvailable),overlay=active&&state.comparison.mode==='overlay',difference=state.comparison.mode==='difference';
 const button=document.querySelector<HTMLButtonElement>('[data-pv-comparison="difference"]');if(button){button.disabled=!state.data?.differenceAvailable||state.view!=='item';button.title=button.disabled?t('PARTS_DIFFERENCE_UNAVAILABLE: declared painting_in_rig and individual part view required.'):'';}
 document.querySelector<HTMLButtonElement>('[data-pv-comparison="overlay"]')!.disabled=!state.data?.painting;
 $('pv-threshold-control').hidden=!difference;$<HTMLInputElement>('pv-threshold').value=String(state.comparison.mode==='difference'?state.comparison.threshold:state.differenceThreshold);
 $('pv-comparison').hidden=!active;for(const b of document.querySelectorAll<HTMLElement>('[data-pv-comparison]'))b.setAttribute('aria-pressed',String(b.dataset.pvComparison===state.comparison.mode));
 $('pv-opacity-control').hidden=!overlay;$<HTMLInputElement>('pv-opacity').value=String(state.comparison.opacity);$('pv-opacity-value').textContent=(state.comparison.opacity*100).toFixed(1)+'%';
 $<HTMLInputElement>('pv-alpha').disabled=overlay||difference;
 const mesh=document.querySelector<HTMLInputElement>('#pv-mesh-control input');if(mesh)mesh.disabled=overlay||difference||state.view==='assembled';
 $<HTMLInputElement>('pv-footprints').disabled=state.data?.mode==='atlas'||state.view==='assembled';
}

function renderFlags(): void {
  const data = state.data!, item = data.items[state.selected];
  const list = $('pv-flags');
  const flags = item ? [...data.flags.filter(f => f.kind === 'faint' && f.item === item.name), ...(data.readings ?? data.flags.filter(f => f.kind === 'check')).filter(f => f.item === item.name || f.item === '')] : [];
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
    const categories = source === 'mesh_report' ? ['mesh'] as const : ['part', 'pair', 'evidence', 'unclassified'] as const;
    for (const category of categories) {
    const selected = fromSource.filter(f => readingGroup(f) === category);
    if (!selected.length) continue;
    const section = document.createElement('details'), title = document.createElement('summary');
    section.dataset.pvCategory = category;
    title.textContent = t(category === 'mesh' ? 'Mesh flags' : category === 'part' ? 'Part findings' : category === 'pair' ? 'Pair readings' : category === 'evidence' ? 'Check evidence' : 'Unclassified check rows');
    section.append(title);
    const roots = new Map<string, Flag[]>();
    for (const f of selected) {
      const root = f.kind === 'check' ? f.root : 'contour.bridges.faint';
      const group = roots.get(root) ?? [];
      group.push(f); roots.set(root, group);
    }
    for (const [root, group] of roots) {
      const details = document.createElement('details'), summary = document.createElement('summary'), rows = document.createElement('ul');
      details.dataset.pvRoot = root; details.dataset.flagSource = source;
      summary.textContent = group.length === 1 ? t('{root} · 1 row', { root }) : t('{root} · {count} rows', { root, count: group.length });
      rows.append(...group.map(row)); details.append(summary, rows); section.append(details);
    }
    sourceItem.append(section);
    }
    return [sourceItem];
  }));
  if (!flags.length) { const li = document.createElement('li'); li.className = 'pv-none'; li.textContent = t('No producer flag names this part.'); list.replaceChildren(li); }
  $('pv-flag-sources').textContent = [
    data.flagSources.length ? t('Read from: {files}.', { files: data.flagSources.join(', ') }) : '',
    data.flagMissing.length ? t('Not found: {files}.', { files: data.flagMissing.join(', ') }) : '',
    t('Occlusion coverage is not read yet: the producer does not write it.'),
    t('Badges count only mesh flags and explicit part findings. Pair readings and check evidence are not counted.'),
    flags.some(f => readingGroup(f) === 'unclassified') ? t('Missing or invalid row metadata: source-root rows remain unclassified and are not counted.') : '',
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
    const onItem = [...data.flags.filter(f => f.kind === 'faint'), ...(data.readings ?? [])].filter(f => f.item === item.name && countedFlag(f));
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
    if(data.mode==='parts'){
      const label=document.createElement('label'),visible=document.createElement('input');visible.type='checkbox';visible.checked=!state.hidden.has(item.name);visible.dataset.pvVisible=item.name;visible.setAttribute('aria-label',t('Show {name} in assembly',{name:item.name}));
      visible.onchange=()=>{if(visible.checked)state.hidden.delete(item.name);else state.hidden.add(item.name);void paint();};label.append(visible);li.append(label);
    }
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
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = state.meshShown.has(item.name); toggle.disabled=state.comparison.mode!=='part'||state.view==='assembled';
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
  if(stageEmbedded&&!state.data?.joinedVerdictBinding){document.querySelector('.pv-verdict')!.before(panel);return;}
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
  queueMicrotask(renderCorrections);
  const data = state.data!;
  const item = data.items[index]!;
  if (item.page !== undefined) state.page = data.pages.findIndex(p => p.name === item.page);
  const changed=state.selected!==index;state.selected = index;if((changed||paintFailure)&&viewport&&state.view!=='assembled'){viewport.writeCamera('rig',{zoom:1,center:null});viewport.writeCamera('reference',{zoom:1,center:null});}
  commentUi?.refresh();
  renderList(); renderFlags(); renderVerdict(); renderMesh(); renderComparison(); void paint();
}

function setView(view: 'item' | 'page' | 'assembled'): void {
  if(view==='assembled'&&(state.data?.mode!=='parts'||!state.data.rigSize))return;
  if((state.view!==view||paintFailure)&&viewport){viewport.writeCamera('rig',{zoom:1,center:null});viewport.writeCamera('reference',{zoom:1,center:null});}
  if(view!=='item'&&state.comparison.mode==='difference')state.comparison={mode:'part',opacity:state.comparison.opacity};
  state.view = view;renderMesh();renderComparison();$('rig-label').textContent=t(view==='assembled'?'Assembled':'Selected part');commentUi?.refresh();
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.setAttribute('aria-pressed', String(b.dataset.pvView === view));
  void paint();
}

function updateEntry(change: Partial<{ outcome: Outcome; note: string }>): void {
  const item = state.data!.items[state.selected]!;
  const entry = { ...(state.verdict.get(item.name) ?? { outcome: 'pending' as Outcome, note: '' }), ...change };
  state.verdict.set(item.name, entry);
  renderList();
}

/** Explicit approval only: refuse before changing any pending entry when a flag remains. */
async function approveAll(): Promise<void> {
  if (stageEmbedded || !state.data) return;
  const entries = state.data.items.map(item => state.verdict.get(item.name));
  if (entries.some(entry => entry?.outcome === 'flagged' || entry?.mesh?.outcome === 'flagged')) {
    const status = $('pv-save-status');
    status.textContent = t('PARTS_APPROVE_ALL_FLAGGED: resolve flagged part and mesh outcomes before approving all.');
    status.dataset.result = 'refused';
    return;
  }
  for (const item of state.data.items) {
    const entry = state.verdict.get(item.name) ?? { outcome: 'pending' as Outcome, note: '' };
    if (entry.outcome === 'pending') entry.outcome = 'clean';
    if (item.mesh) {
      entry.mesh ??= { outcome: 'pending', note: '' };
      if (entry.mesh.outcome === 'pending') entry.mesh.outcome = 'clean';
    }
    state.verdict.set(item.name, entry);
  }
  $<HTMLSelectElement>('pv-overall').value = 'approved';
  renderList(); renderVerdict(); renderMesh();
  await save();
}

async function save(): Promise<void> {
  const data=state.data;
  if(!data||stageEmbedded&&(!data.joinedVerdictBinding||!access.capability||stageBuild!=='inspected'))return;
  const status = $('pv-save-status'),button=$<HTMLButtonElement>('pv-save');
  const body = { status: $<HTMLSelectElement>('pv-overall').value, parts: Object.fromEntries(state.verdict),
    ...(stageEmbedded?{binding:data.joinedVerdictBinding}:{comments}) };
  button.disabled=true;
  try{
    const headers=stageEmbedded?stageHeaders():access.headers();headers.set('Content-Type','application/json');
    const res = await fetch(access.route(stageEmbedded?partsApi+'/verdict':'/api/parts/verdict'), { method: 'POST', headers, body: JSON.stringify(body) });
    const out = await res.json() as { error?: string; verdict?: { source: { sha256: string } } };
    status.textContent = res.ok ? t('Saved {file}: source {hash}.', { file: data.verdictFile, hash: out.verdict!.source.sha256.slice(0, 12) }) : out.error ? t(out.error) : t('Save failed.');
    status.dataset.result = res.ok ? 'saved' : 'refused';
  }catch{
    status.textContent=t('Save failed.');status.dataset.result='refused';
  }finally{button.disabled=false;}
}

async function boot(): Promise<void> {
  const box=$('pv-canvas-box'),layout=$('stage-layout');mountViewportPair(layout);$('rig-root').append(box);const reference=document.createElement('canvas');reference.id='pv-reference';$('reference-content').append(reference);$('rig-empty').hidden=true;$('rig-overlay').hidden=true;$('rig-label').textContent=t('Selected part');$('rig-viewport').tabIndex=0;
  viewport=createPartsViewport({el:$,canvas:$<HTMLCanvasElement>('pv-canvas'),message:(msg)=>{$('pv-save-status').textContent=t(msg);},reference:()=>state.data?.painting?$<HTMLCanvasElement>('pv-reference'):null,
    frameSize:target=>{
      const data=state.data,item=data?.items[state.selected];
      if(!data||!item||paintReset)return null;
      if(paintFailure)return {w:0,h:0};
      return target==='rig'?rasterFrame(data,item)??{w:0,h:0}:data.painting?partFrame(data,item):null;
    },
  });viewport.bindControls();
  $('native-one').onclick=()=>viewport!.cameraAction(()=>viewport!.updateCamera(viewport!.availableCamera()??'rig',{zoom:1,pan:{x:0,y:0}}));
  bindDomI18n(document);
  bindStageNav({partsOnly:true,model:false});
  if(stageEmbedded){
    const header=document.querySelector<HTMLElement>('.pv-top')!,status=$('pv-load');
    header.hidden=true;status.classList.add('pv-embedded-status');header.after(status);
    document.querySelector<HTMLElement>('.pv-layout')!.hidden=true;
    document.querySelector<HTMLElement>('.pv-verdict')!.hidden=true;
    const approveButton=$<HTMLButtonElement>('pv-approve-all');approveButton.disabled=true;
    const saveButton=$<HTMLButtonElement>('pv-save');saveButton.disabled=true;
  }
  window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='review-stage-language'||!['en','ko'].includes(event.data.language))return;setLinkLanguage(null);setLanguagePreference(event.data.language);});
  connectLiveWindow(access);
  if(stageEmbedded)await sourceReady;
  const res = await fetch(access.route(partsApi), { headers: stageHeaders() });
  const data = await res.json() as ViewData & { error?: string };
  if (!res.ok) { const status=$('pv-load');status.textContent=t(data.error??'Load failed.');status.dataset.result='refused';return; }
  state.data = data;if(!data.differenceAvailable)document.querySelector('[data-pv-comparison="difference"]')?.remove();if(stageEmbedded)for(const item of data.items)if(item.mesh)state.meshShown.add(item.name);$('reference-empty').textContent=data.painting?'':t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');$('reference-empty').hidden=!!data.painting;if(data.painting)viewport.state.cameraSync=true;comments.push(...data.verdict?.comments??[]);setupPartsComments();viewport.bindNavigation(undefined,()=>!commentUi?.active()&&!paintFailure);viewport.observeResize();
  if(stageEmbedded&&data.joinedVerdictBinding){
    document.querySelector<HTMLElement>('.pv-verdict')!.hidden=false;
    $('pv-approve-all').hidden=true;
    $('pv-comment-count').hidden=true;
    const save=$<HTMLButtonElement>('pv-save');
    save.disabled=!access.capability;
    if(!access.capability)save.title=t('Read-only view: reopen with rig-review open to edit.');
  }
  document.getElementById('parts-correction-hint')!.hidden = data.mode !== 'parts' || stageEmbedded;
  for (const item of data.items) state.verdict.set(item.name, { outcome: 'pending', note: '', ...(item.mesh ? { mesh: { outcome: 'pending' as Outcome, note: '' } } : {}) });
  if (data.verdict) { for (const [name, v] of Object.entries(data.verdict.parts)) if (state.verdict.has(name)) state.verdict.set(name, { outcome: v.outcome, note: v.note ?? '', ...(v.mesh ? { mesh: v.mesh } : {}) }); $<HTMLSelectElement>('pv-overall').value = data.verdict.status; }
  document.title = data.title;
  $('pv-title').textContent = data.title;
  $('pv-mode').textContent = data.mode === 'parts' ? t('Parts package, before rigging') : t('Atlas of a built rig');
  $('pv-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : data.verdict ? t('Saved sign-off loaded.') : data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';
  if(stageEmbedded){$('pv-load').hidden=$('pv-load').textContent==='';document.querySelector<HTMLElement>('.pv-layout')!.hidden=false;}
  $('pv-atlas-switch').hidden = data.mode !== 'atlas';
  const assemble=$<HTMLButtonElement>('pv-assemble');assemble.disabled=data.mode!=='parts'||!data.rigSize;assemble.title=assemble.disabled?t(data.mode==='atlas'?'Assembly unavailable: atlas regions carry no rig placement.':'Assembly unavailable: rig_size is not declared.'):'';
  assemble.onclick=()=>{setView(state.view==='assembled'?'item':'assembled');assemble.setAttribute('aria-pressed',String(state.view==='assembled'));};
  bindAssemblyPicking();
  for(const button of document.querySelectorAll<HTMLElement>('[data-pv-comparison]'))button.onclick=()=>{const mode=button.dataset.pvComparison as PartsComparison['mode'];state.comparison=mode==='difference'?{mode,opacity:state.comparison.opacity,threshold:state.differenceThreshold}:{mode,opacity:state.comparison.opacity};if(state.comparison.mode!=='part'){state.alpha=false;$<HTMLInputElement>('pv-alpha').checked=false;state.meshShown.delete(state.data!.items[state.selected]!.name);renderMesh();}renderComparison();void paint();};
  $<HTMLInputElement>('pv-opacity').oninput=e=>{state.comparison.opacity=Number((e.target as HTMLInputElement).value);renderComparison();void paint();};
  $<HTMLInputElement>('pv-threshold').oninput=e=>{
    const input=e.target as HTMLInputElement,threshold=input.valueAsNumber,status=$('pv-save-status');
    if(!Number.isInteger(threshold)||threshold<0||threshold>255){
      input.value=String(state.differenceThreshold);
      status.dataset.thresholdRefused='true';
      status.textContent=t('PARTS_COMPARISON_INVALID: enter an integer threshold from 0 to 255. Last valid value restored.');
      return;
    }
    if(status.dataset.thresholdRefused){delete status.dataset.thresholdRefused;status.textContent='';}
    state.differenceThreshold=threshold;
    if(state.comparison.mode==='difference')state.comparison.threshold=threshold;
    void paint();
  };
  const footprints = $<HTMLInputElement>('pv-footprints');
  if (data.mode === 'atlas') { footprints.disabled = true; $('pv-footprint-control').title = t('Footprints need a parts package: atlas regions carry no rig placement.'); }
  $<HTMLSelectElement>('pv-bg').onchange = e => { state.bg = (e.target as HTMLSelectElement).value; void paint(); };
  $<HTMLInputElement>('pv-alpha').onchange = e => { state.alpha = (e.target as HTMLInputElement).checked; void paint(); };
  footprints.onchange = e => { state.footprints = (e.target as HTMLInputElement).checked; void paint(); };

  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.onclick = () => setView(b.dataset.pvView as 'item' | 'page');
  for (const r of document.querySelectorAll<HTMLInputElement>('input[data-pv-outcome]')) r.onchange = () => { if (r.checked) updateEntry({ outcome: r.value as Outcome }); };
  $<HTMLTextAreaElement>('pv-note').oninput = e => updateEntry({ note: (e.target as HTMLTextAreaElement).value });
  $('pv-save').onclick = () => { void save(); };
  $('pv-approve-all').onclick = () => approveAll();
  for(const format of ['json','issue'])$('pv-export-'+format).onclick=async()=>{const res=await fetch(access.route(stageEmbedded?partsApi+'/export/'+format:'/api/parts/export?format='+format),{headers:stageHeaders()});const value=await res.text();if(!res.ok){$('pv-save-status').textContent=JSON.parse(value).error??t('Save failed.');return;}const url=URL.createObjectURL(new Blob([value],{type:format==='json'?'application/json':'text/markdown'})),a=document.createElement('a');a.href=url;a.download=stageEmbedded?(format==='json'?data.verdictFile:data.verdictFile.replace(/\.json$/,'.md')):format==='json'?'parts-review-export.json':'parts-review-export.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  onLanguageChange(() => { if (state.data) select(state.selected); });
  if(stageEmbedded)(window as StagePartsWindow).rigReviewStageParts={snapshot:stagePartsSnapshot};
  if(data.items.length){if(stageRestore)await restoreStageParts(stageRestore);else select(0);}
  renderCorrections();
  document.body.dataset.ready = 'true';
}

/** Observe taps only; the shared controller exclusively owns pan, zoom and pinch. */
function bindAssemblyPicking():void {
 const pane=$('rig-viewport');let tap:{id:number;x:number;y:number}|null=null;const pointers=new Set<number>();
 pane.addEventListener('pointerdown',e=>{pointers.add(e.pointerId);if(pointers.size===1&&e.button===0)tap={id:e.pointerId,x:e.clientX,y:e.clientY};else tap=null;});
 pane.addEventListener('pointermove',e=>{if(tap&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)>4)tap=null;});
 pane.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);tap=null;});
 pane.addEventListener('pointerup',e=>{
  pointers.delete(e.pointerId);const start=tap;tap=null;
  if(!start||start.id!==e.pointerId||Math.hypot(e.clientX-start.x,e.clientY-start.y)>4||state.view!=='assembled'||painting||paintFailure||commentUi?.active())return;
  const data=state.data!,r=$('pv-canvas').getBoundingClientRect(),zoom=viewport!.paneCamera('rig').zoom;
  const layers=data.items.flatMap(box=>{const img=images.get(`${partsApi}/image/${box.index}`);return img?[{box,alpha:sourceAlpha(box,img)}]:[];});
  const hit=pickAssembly(layers,(e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom,state.hidden);if(hit)select(hit.index);
 });
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
 const pose=():PartsPose|null=>{const data=state.data,item=data?.items[state.selected],camera=viewport?.numericView().cameras.rig;if(!data||!item||!camera||data.mode!=='parts'||state.view!=='item')return null;return {mode:'parts',camera,item:{...item},sourceHash:data.sourceHash,view:{camera:{zoom:camera.zoom,center:{...camera.center},viewport:{...camera.viewport}},cameraSync:viewport!.state.cameraSync,referenceCamera:(()=>{const c=viewport!.numericView().cameras.reference;return c?{zoom:c.zoom,center:{...c.center},viewport:{...c.viewport}}:null;})(),background:state.bg,alpha:state.alpha,footprints:state.footprints,mesh:state.meshShown.has(item.name),comparison:{...state.comparison}},capture:{pane:$('rig-viewport'),root:$('rig-root'),images:true,canvas:$<HTMLCanvasElement>('pv-canvas'),backend:'canvas2d',nearest:true}};};
 commentUi=bindStageComments({toolbar:document.querySelector<HTMLElement>('.pv-toolbar')!,viewports:{rig:$('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
 restore:async(raw)=>{const res=await fetch(access.route(partsApi),{headers:stageHeaders()});const current=await res.json() as ViewData&{error?:string};if(!res.ok||current.sourceHash!==state.data?.sourceHash)throw new Error(current.error??'PARTS_COMMENT_STALE_SOURCE');const b=raw as {part:string;imageHash:string;sourceHash:string;view:PartsComment['view']},item=state.data!.items.find(i=>i.name===b.part);if(!item||item.imageHash!==b.imageHash||state.data!.sourceHash!==b.sourceHash)throw new Error('PARTS_COMMENT_STALE_SOURCE: reopen the bound source');setView('item');$('pv-assemble').setAttribute('aria-pressed','false');select(item.index);state.bg=b.view.background;state.alpha=b.view.alpha;state.footprints=b.view.footprints;state.comparison={...(b.view.comparison??defaultPartsComparison())};if(state.comparison.mode==='difference')state.differenceThreshold=state.comparison.threshold;renderComparison();if(b.view.mesh)state.meshShown.add(item.name);else state.meshShown.delete(item.name);$<HTMLSelectElement>('pv-bg').value=state.bg;$<HTMLInputElement>('pv-alpha').checked=state.alpha;$<HTMLInputElement>('pv-footprints').checked=state.footprints;renderMesh();viewport!.state.cameraRestoring=true;try{await paint();if(!paintFailure){viewport!.writeCamera('rig',{zoom:b.view.camera.zoom,center:{...b.view.camera.center}});if(b.view.referenceCamera)viewport!.writeCamera('reference',{zoom:b.view.referenceCamera.zoom,center:{...b.view.referenceCamera.center}});viewport!.state.cameraSync=b.view.cameraSync;viewport!.fitCamera();}}finally{viewport!.state.cameraRestoring=false;}},
 feedback:()=>comments,locked:()=>false,add:c=>comments.push(c),changed:()=>renderVerdict(),error:m=>{$('pv-save-status').textContent=t(m);},blocked:()=>painting,refusal:()=>paintFailure??(state.view==='assembled'?'PARTS_COMMENT_UNAVAILABLE: select the individual part view to comment':null)??(state.data?.mode!=='parts'||stageEmbedded?'PARTS_COMMENT_UNAVAILABLE: original part image required':null),codec});
}

if (typeof document !== 'undefined' && document.getElementById('parts-app')) void boot();

function renderCorrections():void {
 const data = state.data;
 if (!stageEmbedded && (!data || (!Object.hasOwn(data, 'draft') && !Object.hasOwn(data, 'draftUnavailable')))) {
  document.getElementById('pv-corrections')?.remove();
  return;
 }
 let host=document.getElementById('pv-corrections');if(!host){host=document.createElement('section');host.id='pv-corrections';document.querySelector('.pv-toolbar')!.after(host);}
 host.replaceChildren();const item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 const label=document.createElement('p');label.textContent=t(data?.draft&&!mapping?'STAGE_DRAFT_NO_MESH: this part has no mesh attachment; direct correction is unavailable.':data?.draft?.label??data?.draftUnavailable??'STAGE_DRAFT_UNAVAILABLE: no producer-compatible draft is supplied.');host.append(label);
 if(!mapping||!data?.draft)return;
 label.textContent+=` · ${mapping.part} · ${mapping.skin}/${mapping.slot}/${mapping.attachment} · v ${mapping.vertices} t ${mapping.triangles} · ${data.draft.buildId}`;
 if(data.draft.inspectionOnly)return;
 for(const [instrument,title,operation]of [['chest','Chest regions',t('rig-parts remesh --mesh')],['mesh','Mesh parameters',t('rig-parts remesh --mesh')],['delta','Edit Mesh',t('rig-parts remesh --delta')]]){
  const button=document.createElement('button');button.type='button';button.textContent=t(title!);button.title=`${mapping.part} · ${operation}`;button.onclick=()=>parent.postMessage({type:'review-stage-correction',part:mapping.part,sourceHash:data.sourceHash,buildId:data.draft!.buildId,instrument},location.origin);host.append(button);
 }
 const guidance=document.createElement('p');guidance.textContent=t('Use Write review, choose Parts review and name the Create draft. Export the saved item with the feedback CLI. Mesh deltas retain evidence as unsupported operations.');host.append(guidance);
}

function stagePartsSnapshot():StagePartsState|null {
 const data=state.data,item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 if(!data?.inspectionSourceHash||!item?.imageHash||!mapping||!viewport)return null;
 return {inspectionSourceHash:data.inspectionSourceHash,part:item.name,imageHash:item.imageHash,box:{x:item.x,y:item.y,w:item.w,h:item.h},mapping:{skin:mapping.skin,slot:mapping.slot,attachment:mapping.attachment},rig:{...viewport.paneCamera('rig')},reference:{...viewport.paneCamera('reference')},cameraSync:viewport.state.cameraSync,bg:state.bg,alpha:state.alpha,footprints:state.footprints,view:state.view,mesh:state.meshShown.has(item.name)};
}
async function restoreStageParts(saved:StagePartsState):Promise<void>{
 if(!state.data||!viewport)return;
 try{
  const index=stagePartsSelectionIndex(state.data,saved);
  viewport.state.cameraRestoring=true;state.bg=saved.bg;state.alpha=saved.alpha;state.footprints=saved.footprints;state.view=saved.view;
  if(saved.mesh)state.meshShown.add(saved.part);else state.meshShown.delete(saved.part);
  select(index);await paint();if(!paintFailure){viewport.writeCamera('rig',saved.rig);if(state.data.painting)viewport.writeCamera('reference',saved.reference);viewport.state.cameraSync=saved.cameraSync;viewport.fitCamera();}
 }catch{const status=$('pv-load');status.hidden=false;status.dataset.result='refused';status.textContent=t('STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.');document.querySelector<HTMLElement>('.pv-layout')!.hidden=true;}
 finally{viewport.state.cameraRestoring=false;}
}
if(typeof window!=='undefined')window.addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data?.type==='review-stage-restore'&&event.data.state)void restoreStageParts(event.data.state);});

async function revalidateStageParts(nextBuild?:string,savedState?:StagePartsState|null):Promise<void>{
 const targetBuild=nextBuild==='inspected'||(typeof nextBuild==='string'&&/^[a-f0-9]{64}$/.test(nextBuild))?nextBuild:stageBuild;
 try{
  const headers=access.headers(stageEmbedded?{'X-Review-Stage-Build':targetBuild}:{});
  const response=await fetch(access.route(partsApi),{headers}),data=await response.json() as ViewData&{error?:string};
  const sameBuild=targetBuild===stageBuild&&(data.draft?.buildId??targetBuild)===(state.data?.draft?.buildId??stageBuild);
  const validBuild=sameBuild?data.sourceHash===state.data?.sourceHash:Boolean(data.inspectionSourceHash&&data.inspectionSourceHash===state.data?.inspectionSourceHash&&data.draft?.buildId===targetBuild);
  if(!response.ok||!validBuild)throw new Error(data.error??'STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.');
  stageBuild=targetBuild;state.data=data;
  if(stageEmbedded){
   document.querySelector<HTMLElement>('.pv-verdict')!.hidden=!data.joinedVerdictBinding;
   const status=$('pv-load');status.textContent=data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';status.hidden=status.textContent==='';delete status.dataset.result;
  }
  if(savedState)await restoreStageParts(savedState);else if(!sameBuild){select(state.selected);await paint();}
  renderCorrections();
 }catch(error){
  document.querySelector<HTMLElement>('.pv-verdict')!.hidden=true;if(state.data)delete state.data.joinedVerdictBinding;
  const status=$('pv-load');status.hidden=false;status.dataset.result='refused';status.textContent=t(error instanceof Error?error.message:String(error));
  document.querySelector<HTMLElement>('.pv-layout')!.hidden=true;
 }
}
if(typeof window!=='undefined')window.addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='review-stage-revalidate')return;void revalidateStageParts(event.data.buildId,event.data.state);});
