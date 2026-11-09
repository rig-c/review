import {defaultPartsComparison,paintingRectangle,type PartsComparison} from '../src/parts-comparison.ts';
import {mountViewportPair} from './viewport-pair.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
import {bindStageComments,type CommentUiPose,type CommentCodec} from './stage-comments.ts';
import {parsePartsIssue,snapImageRegion,type PartsComment,type PartsIssue} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {stagePartsSelectionIndex,type StagePartsState} from './stage-nav.ts';
import type {JobEnabledActKind,UISubmissionV3} from '../src/job-contract.ts';
import type {LegacyPartsVerdictView} from '../src/parts-view.ts';
/**
 * The parts and atlas view (#348). Every part on its own, on a sentinel background, through the shared native-scale
 * viewport controller; the footprints of the parts drawn in front of it; the producer's flags on it; and pointed
 * issues saved as `rig-review-parts-verdict/4`. In atlas mode, the pages as packed with every region's box
 * and name, and a click from a region to its own view.
 *
 * Nothing here measures the art: flags come from the producer's files, and the footprint is the front parts' own
 * alpha drawn over the selected part (the parts.json draw order, back first, says which parts are in front).
 */
import { applyDomI18n, onLanguageChange, t } from './i18n.ts';
import { flagLabel, readingGroup, countedFlag } from './parts-flags.ts';
import { paintAssembly, pickAssembly, paintAssemblyOutline, frontParts, paintAlphaOnly, paintBackground, paintPart, paintMesh, paintOverlay, paintPaintingCrop, paintFootprints } from './parts-render.ts';

export interface Mesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown> }
export interface Item { mesh?: Mesh; name: string; index: number; x: number; y: number; w: number; h: number; page?: string; degrees?: number; image?: boolean;imageHash?:string }
export interface Page { name: string; width: number; height: number; index: number }
export type Flag =
  | { id: string; item: string; source: 'mesh_report'; kind: 'faint'; art: number; maxAlpha: number; box: [number, number, number, number] }
  | { id: string; item: string; source: 'check'; kind: 'check'; path: string; line: string; root: string; status: string | null; entry: Record<string, unknown>; classification?: 'part' | 'pair' | 'evidence' | 'unclassified' };
export interface ViewData {
 inspectionSourceHash?:string;
 joinedVerdictBinding?:string;
 verdictReadOnlyReason?:string;
 draft?:{inspectionOnly?:boolean;label:string;buildId:string;inspectionSourceHash:string;mappings:{part:string;skin:string;slot:string;attachment:string;vertices:number;triangles:number}[];evidence:unknown};draftUnavailable?:string;
  differenceAvailable?:boolean;painting:{sha256:string;width:number;height:number}|null;sourceHash:string;mode: 'parts' | 'atlas'; title: string; rigSize: [number, number] | null; items: Item[]; pages: Page[]; flags: Flag[]; readings?: Flag[];
  flagSources: string[]; flagMissing: string[]; verdictFile: string;
  verdict: { issues?:PartsIssue[];comments?:PartsComment[];status: string; parts?: Record<string, unknown> } | null; verdictStale: 'files' | 'flags' | null;
  legacyVerdict?: LegacyPartsVerdictView;
}

export interface PanelOutput {
  kind: JobEnabledActKind;
  value(): UISubmissionV3['value'];
}

export interface PartsSource {
  view(): Promise<ViewData>;
  image(index: number): Promise<HTMLImageElement>;
  page(index: number): Promise<HTMLImageElement>;
  painting(): Promise<HTMLImageElement> | null;
  difference?(index: number, threshold: number, footprints: boolean): Promise<Response>;
  crop(issue: PartsIssue): Promise<PartsIssue>;
}

export interface PartsHost {
  initial(): PartsIssue[];
  changed(issues: PartsIssue[]): void;
  register(output: PanelOutput): void;
  locked(): 'open' | 'sent' | 'approved' | 'retry-signoff';
}

export interface PartsWorkspaceSlots {
  left: HTMLElement;
  stage: HTMLElement;
  toolbar: HTMLElement;
  side: HTMLElement;
}

export interface MountPartsWorkspaceOptions {
  defaultView: 'item' | 'assembled';
  embedded?: boolean;
}

export interface PartsWorkspaceHandle {
  dispose(): void;
  select(part: string): void;
  ready: Promise<void>;
  issues(): PartsIssue[];
  snapshot(): StagePartsState | null;
  restore(saved: StagePartsState): Promise<void>;
  revalidate(savedState?: StagePartsState | null): Promise<void>;
}

/** Page pixels shown around a region in its own view, so the packer's bleed and padding are visible. */
export const REGION_MARGIN = 4;

function mountPartsMarkup(slots: PartsWorkspaceSlots): void {
  const doc = slots.stage.ownerDocument;
  if (slots.left) {
    const title = doc.createElement('h2'); title.id = 'pv-list-title'; title.textContent = t('PARTS');
    const ul = doc.createElement('ul'); ul.id = 'pv-items'; ul.setAttribute('data-pv-items', '');
    slots.left.append(title, ul);
  }
  if (slots.toolbar) {
    slots.toolbar.classList.add('pv-toolbar');
    const assemble = doc.createElement('button'); assemble.type = 'button'; assemble.id = 'pv-assemble'; assemble.setAttribute('aria-pressed', 'false'); assemble.textContent = t('Assembled');
    const bgLabel = doc.createElement('label'); bgLabel.className = 'pv-field'; bgLabel.textContent = t('Background');
    const bgSelect = doc.createElement('select'); bgSelect.id = 'pv-bg'; bgSelect.setAttribute('data-pv-bg', '');
    for (const [val, text] of [['green', 'Green'], ['magenta', 'Magenta'], ['black', 'Black'], ['white', 'White'], ['checker', 'Checker']]) {
      const opt = doc.createElement('option'); opt.value = val!; opt.textContent = t(text!); bgSelect.append(opt);
    }
    bgLabel.append(bgSelect);
    const zoomGroup = doc.createElement('span'); zoomGroup.className = 'pv-group'; zoomGroup.setAttribute('role', 'group'); zoomGroup.setAttribute('aria-label', t('Zoom'));
    for (const [id, text] of [['zoom-out', '−'], ['zoom-in', '+'], ['fit', 'Fit'], ['native-one', '1:1']]) {
      if (id === 'zoom-in') { const zv = doc.createElement('span'); zv.id = 'zoom-value'; zv.textContent = '1:1'; zoomGroup.append(zv); }
      const btn = doc.createElement('button'); btn.type = 'button'; btn.id = id!; btn.textContent = text === 'Fit' ? t('Fit') : text!;
      if (id === 'native-one') btn.setAttribute('aria-pressed', 'true');
      zoomGroup.append(btn);
    }
    const syncLabel = doc.createElement('label'); syncLabel.className = 'pv-field';
    const syncInput = doc.createElement('input'); syncInput.id = 'camera-sync'; syncInput.type = 'checkbox';
    syncLabel.append(syncInput, t('Sync cameras'));
    const commentBtn = doc.createElement('button'); commentBtn.type = 'button'; commentBtn.id = 'stage-comment'; commentBtn.setAttribute('aria-pressed', 'false'); commentBtn.setAttribute('aria-controls', 'stage-comment-list'); commentBtn.textContent = t('Comment · C ({0})', [0]);
    const alphaLabel = doc.createElement('label'); alphaLabel.className = 'pv-field';
    const alphaInput = doc.createElement('input'); alphaInput.type = 'checkbox'; alphaInput.id = 'pv-alpha'; alphaInput.setAttribute('data-pv-alpha', '');
    alphaLabel.append(alphaInput, t('Alpha only'));
    const fpLabel = doc.createElement('label'); fpLabel.className = 'pv-field'; fpLabel.id = 'pv-footprint-control';
    const fpInput = doc.createElement('input'); fpInput.type = 'checkbox'; fpInput.id = 'pv-footprints'; fpInput.setAttribute('data-pv-footprints', '');
    fpLabel.append(fpInput, t('Footprints of parts in front'));
    const compSpan = doc.createElement('span'); compSpan.id = 'pv-comparison'; compSpan.className = 'pv-comparison'; compSpan.hidden = true;
    const compGroupWrap = doc.createElement('span'); compGroupWrap.className = 'pv-field'; compGroupWrap.textContent = t('Painting comparison');
    const compGroup = doc.createElement('span'); compGroup.className = 'pv-group'; compGroup.setAttribute('role', 'group'); compGroup.setAttribute('aria-label', t('Painting comparison'));
    for (const [mode, text] of [['part', 'Part'], ['overlay', 'Overlay'], ['difference', 'Difference']]) {
      const btn = doc.createElement('button'); btn.type = 'button'; btn.setAttribute('data-pv-comparison', mode!); btn.setAttribute('aria-pressed', String(mode === 'part')); btn.textContent = t(text!);
      compGroup.append(btn);
    }
    compGroupWrap.append(compGroup);
    const opLabel = doc.createElement('label'); opLabel.className = 'pv-field'; opLabel.id = 'pv-opacity-control'; opLabel.hidden = true; opLabel.textContent = t('Part opacity');
    const opInput = doc.createElement('input'); opInput.type = 'range'; opInput.id = 'pv-opacity'; opInput.min = '0'; opInput.max = '1'; opInput.step = '0.001'; opInput.value = '0.5';
    const opOut = doc.createElement('output'); opOut.id = 'pv-opacity-value'; opOut.textContent = '50.0%';
    opLabel.append(opInput, opOut);
    const thLabel = doc.createElement('label'); thLabel.className = 'pv-field'; thLabel.id = 'pv-threshold-control'; thLabel.hidden = true; thLabel.textContent = t('Threshold');
    const thInput = doc.createElement('input'); thInput.type = 'number'; thInput.id = 'pv-threshold'; thInput.min = '0'; thInput.max = '255'; thInput.step = '1'; thInput.value = '0';
    thLabel.append(thInput);
    compSpan.append(compGroupWrap, opLabel, thLabel);
    const atlasSwitch = doc.createElement('span'); atlasSwitch.className = 'pv-group'; atlasSwitch.setAttribute('role', 'group'); atlasSwitch.setAttribute('aria-label', t('Atlas view')); atlasSwitch.id = 'pv-atlas-switch'; atlasSwitch.hidden = true;
    for (const [view, text] of [['item', 'Region'], ['page', 'Pages']]) {
      const btn = doc.createElement('button'); btn.type = 'button'; btn.setAttribute('data-pv-view', view!); btn.setAttribute('aria-pressed', String(view === 'item')); btn.textContent = t(text!);
      atlasSwitch.append(btn);
    }
    slots.toolbar.append(assemble, bgLabel, zoomGroup, syncLabel, commentBtn, alphaLabel, fpLabel, compSpan, atlasSwitch);
  }
  if (slots.stage) {
    const wrap = doc.createElement('div'); wrap.className = 'pv-canvas-wrap'; wrap.id = 'stage-layout';
    const box = doc.createElement('div'); box.className = 'pv-canvas-box'; box.id = 'pv-canvas-box';
    const canvas = doc.createElement('canvas'); canvas.id = 'pv-canvas'; canvas.setAttribute('data-pv-canvas', ''); canvas.width = 1; canvas.height = 1;
    const overlay = doc.createElement('div'); overlay.id = 'pv-overlay'; overlay.className = 'pv-overlay';
    box.append(canvas, overlay); wrap.append(box);
    const caption = doc.createElement('p'); caption.id = 'pv-caption'; caption.className = 'pv-subtle';
    const status = doc.createElement('p'); status.id = 'pv-load'; status.className = 'pv-subtle'; status.setAttribute('role', 'status');
    const message = doc.createElement('p'); message.id = 'pv-save-status'; message.className = 'pv-subtle'; message.setAttribute('role', 'status');
    slots.stage.append(status, wrap, caption, message);
  }
  if (slots.side) {
    const flagsSec = doc.createElement('section');
    const flagsH2 = doc.createElement('h2'); flagsH2.id = 'pv-flags-title'; flagsH2.textContent = t('PRODUCER FLAGS');
    const flagsUl = doc.createElement('ul'); flagsUl.id = 'pv-flags'; flagsUl.setAttribute('data-pv-flags', '');
    const flagsSources = doc.createElement('p'); flagsSources.id = 'pv-flag-sources'; flagsSources.className = 'pv-subtle';
    flagsSec.append(flagsH2, flagsUl, flagsSources);
    const legacyUl = doc.createElement('ul'); legacyUl.id = 'pv-legacy-flagged'; legacyUl.className = 'pv-legacy-flagged'; legacyUl.hidden = true;
    slots.side.append(flagsSec, legacyUl);
  }
}

export function mountPartsWorkspace(
  slots: PartsWorkspaceSlots,
  source: PartsSource,
  host: PartsHost,
  options: MountPartsWorkspaceOptions,
): PartsWorkspaceHandle {
  const roots = [slots.left, slots.stage, slots.toolbar, slots.side];
  if (roots.some(root => !root)) throw new Error('PARTS_WORKSPACE_SLOT_REQUIRED');
  const doc = slots.stage.ownerDocument;
  const win = doc.defaultView;
  if (!win || roots.some(root => root.ownerDocument !== doc)) throw new Error('PARTS_WORKSPACE_DOCUMENT_REQUIRED');
  for (const root of roots) root.replaceChildren();
  mountPartsMarkup(slots);
  const query = <T extends Element = HTMLElement>(selector: string): T | null => {
    for (const root of roots) {
      if (root.matches(selector)) return root as unknown as T;
      const found = root.querySelector<T>(selector);
      if (found) return found;
    }
    return null;
  };
  const queryAll = <T extends Element = HTMLElement>(selector: string): T[] =>
    [...new Set(roots.flatMap(root => [...root.querySelectorAll<T>(selector)]))];
  const $ = <T extends HTMLElement>(id: string): T => {
    const found = query<T>(`#${id}`);
    if (!found) throw new Error(`PARTS_WORKSPACE_NODE_REQUIRED: ${id}`);
    return found;
  };
  const disposers: (() => void)[] = [];
  let disposed = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  let readyPending = true;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const settleReady = (error?: unknown) => {
    if (!readyPending) return;
    readyPending = false;
    if (error === undefined) resolveReady(); else rejectReady(error);
  };
  let pendingSelectPart: string | null = null;
  let mountActive = false;
  const activate = (event: Event) => {
    mountActive = roots.some(root => event.target instanceof win.Node && root.contains(event.target));
  };
  for (const event of ['pointerdown', 'focusin']) {
    doc.addEventListener(event, activate, true);
    disposers.push(() => doc.removeEventListener(event, activate, true));
  }
  const stageEmbedded = Boolean(options.embedded);
  const state = { data: null as ViewData | null, selected: 0, zoom: 1, bg: 'green', alpha: false, footprints: false, comparison:defaultPartsComparison(), differenceThreshold:0, hidden: new Set<string>(), view: options.defaultView as 'item' | 'page' | 'assembled', page: 0, meshShown: new Set<string>() };
  const comments:PartsIssue[]=[];let commentUi:ReturnType<typeof bindStageComments>|null=null;let viewport:ReturnType<typeof createPartsViewport>|null=null;let painting=true;
  const images = new Map<string, HTMLImageElement>();
  const pendingImages = new Map<string, Promise<HTMLImageElement>>();
  let imageGeneration = 0;
  function cachedImage(key: string, read: () => Promise<HTMLImageElement>): Promise<HTMLImageElement> {
    const cached = images.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = pendingImages.get(key);
    if (pending) return pending;
    const generation = imageGeneration;
    const result = read().then(image => {
      if (!disposed && generation === imageGeneration) images.set(key, image);
      return image;
    }).finally(() => { if (pendingImages.get(key) === result) pendingImages.delete(key); });
    pendingImages.set(key, result);
    return result;
  }
  const itemImage = (item: Item) => cachedImage(`image:${item.index}`, () => source.image(item.index));
  const pageImage = (name: string) => {
    const page = state.data?.pages.find(page => page.name === name);
    if (!page) return Promise.reject(new Error('PARTS_PAINT_FAILED'));
    return cachedImage(`page:${page.index}`, () => source.page(page.index));
  };
  const paintingImage = () => cachedImage('painting', () => {
    const image = source.painting();
    if (!image) return Promise.reject(new Error('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting'));
    return image;
  });

function setCanvas(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  canvas.width = w; canvas.height = h;
  canvas.style.width = `${w * state.zoom}px`; canvas.style.height = `${h * state.zoom}px`;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function overlayBox(x: number, y: number, w: number, h: number): HTMLDivElement {
  const div = doc.createElement('div');
  div.className = 'pv-box';
  div.style.left = `${x * state.zoom}px`; div.style.top = `${y * state.zoom}px`;
  div.style.width = `${w * state.zoom}px`; div.style.height = `${h * state.zoom}px`;
  return div;
}

let paintToken = 0;
let paintFailure:string|null=null,paintReset=false;
let paintBusyStatus: {token: number; text: string} | null = null;
function syncPaintState(): void {
 slots.stage.dataset.partsPaintState = disposed ? 'disposed' : painting ? 'busy' : paintFailure ? 'failed' : 'ready';
 slots.stage.setAttribute('aria-busy', String(painting));
 const toggle = $<HTMLButtonElement>('stage-comment');
 toggle.disabled = painting;
 toggle.setAttribute('aria-busy', String(painting));
 if (commentUi) commentUi.refresh();
 else toggle.textContent = t(painting ? 'Comment · C ({0}) · Rendering' : 'Comment · C ({0})', [0]);
}

async function paint():Promise<void>{
 const token=++paintToken;painting=true;
 if (paintBusyStatus) {
  if ($('pv-save-status').textContent === paintBusyStatus.text) paintBusyStatus.token = token;
  else paintBusyStatus = null;
 }
 syncPaintState();
 try{
  await paintRaster(token);if(disposed||token!==paintToken)return;
  await paintReference(token);if(disposed||token!==paintToken)return;
  if(paintFailure&&$('pv-save-status').textContent===t(paintFailure))$('pv-save-status').textContent='';paintFailure=null;viewport?.fitCamera();commentUi?.refresh();settleReady();
 }catch(error){
  if(disposed||token!==paintToken)return;
  settleReady(error instanceof Error?error:new Error('PARTS_PAINT_FAILED'));
  const failure=error instanceof Error&&error.message.startsWith('PARTS_DIFFERENCE_')?error.message:'PARTS_PAINT_FAILED: view could not be rendered; select the part to retry';
  const canvas=$<HTMLCanvasElement>('pv-canvas');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
  const ref=$<HTMLCanvasElement>('pv-reference') as HTMLCanvasElement|null;if(ref){if(canvas.width>0&&canvas.height>0){ref.width=canvas.width;ref.height=canvas.height;}ref.getContext('2d')?.clearRect(0,0,ref.width,ref.height);}
  $('pv-overlay').replaceChildren();$('pv-caption').textContent=t(failure);$('pv-save-status').textContent=t(failure);
  painting=false;paintFailure=null;paintReset=true;
  try{viewport?.writeCamera?.('rig',{zoom:1,center:null});viewport?.writeCamera?.('reference',{zoom:1,center:null});viewport?.fitCamera();}
  finally{paintReset=false;paintFailure=failure;}
  commentUi?.refresh();
 }finally{
  if(!disposed&&token===paintToken){
   painting=false;
   if(paintBusyStatus?.token===token){
    if(!paintFailure&&$('pv-save-status').textContent===paintBusyStatus.text)$('pv-save-status').textContent='';
    paintBusyStatus=null;
   }
   syncPaintState();
  }
 }
}
const assemblyAlpha=new Map<string,Uint8ClampedArray>();
function sourceAlpha(item:Item,img:HTMLImageElement):Uint8ClampedArray {
 const cached=assemblyAlpha.get(item.name);if(cached)return cached;
 const c=doc.createElement('canvas');c.width=item.w;c.height=item.h;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);
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
    const original=state.comparison.mode==='overlay'&&data.painting?await paintingImage():null;
    if(disposed||token!==paintToken)return;
    const ctx=setCanvas(canvas,w,h);
    if(original){
      paintPaintingCrop(ctx,original,paintingRectangle({x:0,y:0,w,h},data.rigSize,data.painting!),w,h,state.bg);
      const assembled=doc.createElement('canvas');assembled.width=w;assembled.height=h;const a=assembled.getContext('2d')!;a.imageSmoothingEnabled=false;for(const l of layers)a.drawImage(l.image,l.box.x,l.box.y);ctx.globalAlpha=state.comparison.opacity;ctx.drawImage(assembled,0,0);ctx.globalAlpha=1;
    }else paintAssembly(ctx,w,h,layers,{bg:state.bg,alpha:state.alpha});
    overlay.replaceChildren();
    const selected=layers.find(l=>l.box.name===item.name);
    if(selected){const outline=doc.createElement('canvas');outline.width=w;outline.height=h;outline.dataset.assemblyOutline=item.name;paintAssemblyOutline(outline.getContext('2d')!,item,sourceAlpha(item,selected.image));overlay.append(outline);}
    caption.textContent=t('Assembled package · {count} visible parts.',{count:shown.length});
    return;
  }
  if (data.mode === 'atlas' && state.view === 'page') {
    const page = data.pages[state.page]!, img = await pageImage(page.name);
    if (disposed || token !== paintToken) return;
    const ctx = setCanvas(canvas, w, h);
    if (state.alpha) paintAlphaOnly(ctx, img, 0, 0, page.width, page.height);
    else { paintBackground(ctx, page.width, page.height, state.bg); ctx.drawImage(img, 0, 0); }
    overlay.replaceChildren(...data.items.filter(r => r.page === page.name).map(r => {
      const box = overlayBox(r.x, r.y, r.w, r.h);
      box.dataset.viewportAction = 'select-region';
      box.dataset.region = r.name; box.dataset.x = String(r.x); box.dataset.y = String(r.y); box.dataset.w = String(r.w); box.dataset.h = String(r.h);
      if (r.index === item.index) box.setAttribute('aria-current', 'true');
      const label = doc.createElement('span'); label.textContent = r.name; box.append(label);
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
    if (disposed || token !== paintToken) return;
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
    if (!source.difference) throw new Error('PARTS_DIFFERENCE_UNAVAILABLE: declared painting_in_rig and individual part view required.');
    const response = await source.difference(item.index, state.comparison.threshold, state.footprints);
    if(!response.ok){const out=await response.json() as {error:string};throw new Error(out.error);}
    const image=await createImageBitmap(await response.blob());
    try{if(disposed||token!==paintToken)return;const ctx=setCanvas(canvas,w,h);paintBackground(ctx,w,h,state.bg);ctx.drawImage(image,0,0);overlay.replaceChildren();
      caption.textContent=t('Difference: {count} pixels above threshold · {covered} covered pixels excluded · visual comparison, no automatic verdict.',{count:response.headers.get('X-Difference-Count')??'',covered:response.headers.get('X-Difference-Covered')??''});
    }finally{image.close();}return;
  }
  const img = await itemImage(item), front = state.footprints ? frontParts(data.items, item) : [];
  const fronts = await Promise.all(front.map(async o => ({ o, img: await itemImage(o) })));
  const original=state.comparison.mode==='overlay'&&data.painting?await paintingImage():null;
  if (disposed || token !== paintToken) return;
  const ctx = setCanvas(canvas, w, h);
  const makeCanvas=(w:number,h:number)=>Object.assign(doc.createElement('canvas'),{width:w,height:h});
  if(original){paintOverlay(ctx,item,img,original,paintingRectangle(item,data.rigSize!,data.painting!),state.comparison.opacity,state.bg);paintFootprints(ctx,item,fronts.map(f=>({box:f.o,image:f.img})),makeCanvas);}
  else paintPart(ctx, item, img, { bg: state.bg, alpha: state.alpha, fronts: fronts.map(f => ({ box: f.o, image: f.img })), makeCanvas: (w, h) => Object.assign(doc.createElement('canvas'), { width: w, height: h }) });
  if (!original && item.mesh && state.meshShown.has(item.name)) paintMesh(ctx, img, item.w, item.h, item.mesh, (w, h) => Object.assign(doc.createElement('canvas'), { width: w, height: h }));
  overlay.replaceChildren(...data.flags.filter((f): f is Extract<Flag, { kind: 'faint' }> => f.item === item.name && f.kind === 'faint').map(f => {
    const box = overlayBox(f.box[0], f.box[1], f.box[2], f.box[3]);
    box.dataset.flag = f.id;
    return box;
  }));
  caption.textContent = t('{name}: {width}×{height} px at {x},{y} in rig px, draw order {order} of {count}.', { name: item.name, width: item.w, height: item.h, x: item.x, y: item.y, order: item.index + 1, count: data.items.length })
    + (state.footprints ? ' ' + (front.length === 1 ? t('Tinted: the footprint of the part drawn in front ({names}).', { names: front[0]!.name }) : front.length ? t('Tinted: the footprints of {count} parts drawn in front ({names}).', { count: front.length, names: front.map(o => o.name).join(', ') }) : t('No part is drawn in front of it.')) : '');
}

async function paintReference(token:number):Promise<void>{const data=state.data,item=data?.items[state.selected];if(!data?.painting||!item)return;const img=await paintingImage();if(token!==paintToken||data!==state.data||item!==state.data?.items[state.selected])return;const box=partFrame(data,item);const canvas=$<HTMLCanvasElement>('pv-reference');canvas.width=box.w;canvas.height=box.h;const ctx=canvas.getContext('2d')!;paintPaintingCrop(ctx,img,paintingRectangle(box,data.rigSize!,data.painting),box.w,box.h,state.bg);}

function renderComparison():void {
 const active=state.data?.mode==='parts'&&(!!state.data.painting||!!state.data.differenceAvailable),overlay=active&&state.comparison.mode==='overlay',difference=state.comparison.mode==='difference';
 const button=query<HTMLButtonElement>('[data-pv-comparison="difference"]');if(button){button.disabled=!state.data?.differenceAvailable||!source.difference||state.view!=='item';button.title=button.disabled?t('PARTS_DIFFERENCE_UNAVAILABLE: declared painting_in_rig and individual part view required.'):'';}
 const overlayButton=query<HTMLButtonElement>('[data-pv-comparison="overlay"]');if(overlayButton)overlayButton.disabled=!state.data?.painting;
 $('pv-threshold-control').hidden=!difference;$<HTMLInputElement>('pv-threshold').value=String(state.comparison.mode==='difference'?state.comparison.threshold:state.differenceThreshold);
 $('pv-comparison').hidden=!active;for(const b of queryAll<HTMLElement>('[data-pv-comparison]'))b.setAttribute('aria-pressed',String(b.dataset.pvComparison===state.comparison.mode));
 $('pv-opacity-control').hidden=!overlay;$<HTMLInputElement>('pv-opacity').value=String(state.comparison.opacity);$('pv-opacity-value').textContent=(state.comparison.opacity*100).toFixed(1)+'%';
 $<HTMLInputElement>('pv-alpha').disabled=overlay||difference;
 const mesh=query<HTMLInputElement>('#pv-mesh-control input');if(mesh)mesh.disabled=overlay||difference||state.view==='assembled';
 $<HTMLInputElement>('pv-footprints').disabled=state.data?.mode==='atlas'||state.view==='assembled';
}

function renderFlags(): void {
  const data = state.data!, item = data.items[state.selected];
  const list = $('pv-flags');
  const flags = item ? [...data.flags.filter(f => f.kind === 'faint' && f.item === item.name), ...(data.readings ?? data.flags.filter(f => f.kind === 'check')).filter(f => f.item === item.name || f.item === '')] : [];
  const row = (f: Flag): HTMLLIElement => {
    const li = doc.createElement('li');
    li.dataset.flagId = f.id; li.dataset.flagSource = f.source;
    const label = doc.createElement('span'); label.className = 'pv-flag-label'; label.textContent = flagLabel(f, t);
    li.append(label);
    if (f.kind === 'check') {
      // The producer's object, verbatim, one click away: the label names its fields and hides none of it.
      const raw = doc.createElement('details'), summary = doc.createElement('summary'), code = doc.createElement('code');
      summary.textContent = t('Producer line'); code.textContent = `${f.path}: ${f.line}`;
      raw.append(summary, code); li.append(raw);
    }
    return li;
  };
  // Source and producer-root groups are presentation only. Every original row and verdict flag id is retained.
  list.replaceChildren(...(['mesh_report', 'check'] as const).flatMap(source => {
    const fromSource = flags.filter(f => f.source === source);
    if (!fromSource.length) return [];
    const sourceItem = doc.createElement('li'), heading = doc.createElement('h3');
    sourceItem.dataset.pvSource = source;
    heading.textContent = source === 'mesh_report' ? 'mesh_report.json' : 'check.json';
    sourceItem.append(heading);
    const categories = source === 'mesh_report' ? ['mesh'] as const : ['part', 'pair', 'evidence', 'unclassified'] as const;
    for (const category of categories) {
    const selected = fromSource.filter(f => readingGroup(f) === category);
    if (!selected.length) continue;
    const section = doc.createElement('details'), title = doc.createElement('summary');
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
      const details = doc.createElement('details'), summary = doc.createElement('summary'), rows = doc.createElement('ul');
      details.dataset.pvRoot = root; details.dataset.flagSource = source;
      summary.textContent = group.length === 1 ? t('{root} · 1 row', { root }) : t('{root} · {count} rows', { root, count: group.length });
      rows.append(...group.map(row)); details.append(summary, rows); section.append(details);
    }
    sourceItem.append(section);
    }
    return [sourceItem];
  }));
  if (!flags.length) { const li = doc.createElement('li'); li.className = 'pv-none'; li.textContent = t('No producer flag names this part.'); list.replaceChildren(li); }
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
  const issueList = comments;
  list.replaceChildren(...data.items.filter(i => !seen.has(i.name) && seen.add(i.name)).map(item => {
    const li = doc.createElement('li'), button = doc.createElement('button');
    button.type = 'button'; button.dataset.pvItem = item.name; button.title = item.name;
    if (data.items[state.selected]?.name === item.name) button.setAttribute('aria-current', 'true');
    const name = doc.createElement('span'); name.className = 'pv-name'; name.textContent = item.name;
    const onItem = [...data.flags.filter(f => f.kind === 'faint'), ...(data.readings ?? [])].filter(f => f.item === item.name && countedFlag(f));
    const flags = doc.createElement('span'); flags.className = 'pv-count';
    // flagSources holds actual basenames (including custom.json); flagMissing canonically names unread kinds.
    const meshRead = !data.flagMissing.includes('mesh_report.json'), checkRead = !data.flagMissing.includes('check.json');
    const mesh = onItem.filter(f => f.source === 'mesh_report').length, check = onItem.filter(f => f.source === 'check').length;
    if (onItem.length) {
      if (meshRead && checkRead) flags.textContent = t('mesh {mesh} · check {check}', { mesh, check });
      else if (meshRead) flags.textContent = t('mesh {mesh}', { mesh });
      else if (checkRead) flags.textContent = t('check {check}', { check });
    }
    const issueCount = issueList.filter(c => c.parts.some(p => p.name === item.name)).length;
    const badge = doc.createElement('span'); badge.className = 'pv-badge'; badge.dataset.issues = String(issueCount); badge.textContent = issueCount ? String(issueCount) : '';
    button.append(name, flags, badge);
    button.onclick = () => { select(item.index); if (data.mode === 'atlas') setView('item'); };
    li.append(button);
    if(data.mode==='parts'){
      const label=doc.createElement('label'),visible=doc.createElement('input');visible.type='checkbox';visible.checked=!state.hidden.has(item.name);visible.dataset.pvVisible=item.name;visible.setAttribute('aria-label',t('Show {name} in assembly',{name:item.name}));
      visible.onchange=()=>{if(visible.checked)state.hidden.delete(item.name);else state.hidden.add(item.name);void paint();};label.append(visible);li.append(label);
    }
    return li;
  }));
}

function renderMesh(): void {
  query('#pv-mesh-panel')?.remove();
  query('#pv-mesh-control')?.remove();
  const item = state.data!.items[state.selected]!;
  if (!item.mesh) return;
  const control = doc.createElement('label'); control.id = 'pv-mesh-control'; control.className = 'pv-field';
  const toggle = doc.createElement('input'); toggle.type = 'checkbox'; toggle.checked = state.meshShown.has(item.name); toggle.disabled=state.comparison.mode!=='part'||state.view==='assembled';
  toggle.onchange = () => { if (toggle.checked) state.meshShown.add(item.name); else state.meshShown.delete(item.name); void paint(); };
  control.append(toggle, t('mesh from rig.json UVs')); query('.pv-toolbar')?.append(control);
  const panel = doc.createElement('section'); panel.id = 'pv-mesh-panel';
  const heading = doc.createElement('h2'); heading.textContent = t('Mesh geometry'); panel.append(heading);
  const figures = doc.createElement('dl');
  for (const key of ['mode', 'vertices', 'triangles', 'art_coverage', 'stray_cleared']) {
    const dt = doc.createElement('dt'), dd = doc.createElement('dd'); dt.textContent = key;
    dd.textContent = Object.hasOwn(item.mesh.figures, key) ? JSON.stringify(item.mesh.figures[key]) : t('not reported');
    dd.dataset.meshFigure = key; figures.append(dt, dd);
  }
  panel.append(figures);
  const help = doc.createElement('p'); help.textContent = t('Pink: art pixels outside every triangle.'); panel.append(help);
  slots.side.append(panel);
}

function select(index: number): void {
  if (disposed) return;
  queueMicrotask(() => { if (!disposed) renderCorrections(); });
  const data = state.data!;
  const item = data.items[index]!;
  if (item.page !== undefined) state.page = data.pages.findIndex(p => p.name === item.page);
  const changed=state.selected!==index;state.selected = index;if((changed||paintFailure)&&viewport&&state.view!=='assembled'){viewport.writeCamera('rig',{zoom:1,center:null});viewport.writeCamera('reference',{zoom:1,center:null});}
  commentUi?.refresh();
  renderList(); renderFlags(); renderMesh(); renderComparison(); void paint();
}

function setView(view: 'item' | 'page' | 'assembled'): void {
  if(view==='assembled'&&(state.data?.mode!=='parts'||!state.data.rigSize))return;
  if((state.view!==view||paintFailure)&&viewport){viewport.writeCamera('rig',{zoom:1,center:null});viewport.writeCamera('reference',{zoom:1,center:null});}
  if(view!=='item'&&state.comparison.mode==='difference')state.comparison={mode:'part',opacity:state.comparison.opacity};
  state.view = view;renderMesh();renderComparison();$('rig-label').textContent=t(view==='assembled'?'Assembled':'Selected part');commentUi?.refresh();
  for (const b of queryAll<HTMLButtonElement>('[data-pv-view]')) b.setAttribute('aria-pressed', String(b.dataset.pvView === view));
  void paint();
}

function renderLegacyVerdict(): void {
  const legacy = state.data?.legacyVerdict;
  const list = query('#pv-legacy-flagged') as HTMLElement | null;
  if (!list) return;
  if (!legacy) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  list.hidden = !legacy.flaggedParts.length;
  list.replaceChildren(...legacy.flaggedParts.map(fp => {
    const li = doc.createElement('li');
    li.dataset.legacyFlaggedPart = fp.name;
    li.textContent = fp.note ? fp.name + ': ' + fp.note : fp.name;
    return li;
  }));
}

async function boot(): Promise<void> {
  const box=$('pv-canvas-box'),layout=$('stage-layout');mountViewportPair(layout);$('rig-root').append(box);const reference=doc.createElement('canvas');reference.id='pv-reference';$('reference-content').append(reference);$('rig-empty').hidden=true;$('rig-overlay').hidden=true;$('rig-label').textContent=t('Selected part');$('rig-viewport').tabIndex=0;
  viewport=createPartsViewport({el:$,canvas:$<HTMLCanvasElement>('pv-canvas'),message:(msg)=>{paintBusyStatus=null;$('pv-save-status').textContent=t(msg);},reference:()=>state.data?.painting?$<HTMLCanvasElement>('pv-reference'):null,
    frameSize:target=>{
      const data=state.data,item=data?.items[state.selected];
      if(!data||!item||paintReset)return null;
      if(paintFailure)return {w:0,h:0};
      return target==='rig'?rasterFrame(data,item)??{w:0,h:0}:data.painting?partFrame(data,item):null;
    },
  });disposers.push(viewport.bindControls());
  $('native-one').onclick=()=>viewport!.cameraAction(()=>viewport!.updateCamera(viewport!.availableCamera()??'rig',{zoom:1,pan:{x:0,y:0}}));
  if (disposed) return;
  let data: ViewData & { error?: string };
  try {
    data = await source.view();
  } catch (err) {
    if (disposed) return;
    const status = $('pv-load');
    status.textContent = t(err instanceof Error ? err.message : 'Save failed.');
    status.dataset.result = 'refused';
    painting=false;paintFailure=err instanceof Error?err.message:String(err);syncPaintState();
    settleReady(err);
    return;
  }
  if (disposed) return;
  if (data.error) { const status=$('pv-load');status.textContent=t(data.error);status.dataset.result='refused';painting=false;paintFailure=data.error;syncPaintState();settleReady(new Error(data.error));return; }
  if (!data.items.length) throw new Error('PARTS_PAINT_FAILED');
  state.data = data;if(stageEmbedded)for(const item of data.items)if(item.mesh)state.meshShown.add(item.name);$('reference-empty').textContent=data.painting?'':t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');$('reference-empty').hidden=!!data.painting;if(data.painting)viewport.state.cameraSync=true;
  if (data.mode !== 'parts' || !data.rigSize) state.view = 'item';
  comments.push(...structuredClone(host.initial()).map(issue => parsePartsIssue(issue, false, true, false)));
  host.register({kind: 'parts-verdict', value: () => {
    if (disposed || state.data?.legacyVerdict?.readOnly) throw new Error('PARTS_VERDICT_READ_ONLY');
    return {verdict: comments.length ? 'changes-requested' : 'approved', issues: structuredClone(comments), words: ''};
  }});
  setupPartsComments();const ro=viewport.observeResize();disposers.push(viewport.bindNavigation(undefined,()=>mountActive&&!disposed&&!commentUi?.active()&&!paintFailure),()=>ro.disconnect());
  renderLegacyVerdict();
  const legacyBanner = data.legacyVerdict ? data.legacyVerdict.code + ': ' + t('parts.legacyVerdictBanner', [data.legacyVerdict.flaggedCount]) : '';
  $('pv-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : legacyBanner ? legacyBanner : data.verdict ? t('Saved sign-off loaded.') : data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';
  if (legacyBanner) $('pv-load').dataset.result = 'readonly';
  $('pv-atlas-switch').hidden = data.mode !== 'atlas';
  const assemble=$<HTMLButtonElement>('pv-assemble');assemble.disabled=data.mode!=='parts'||!data.rigSize;assemble.title=assemble.disabled?t(data.mode==='atlas'?'Assembly unavailable: atlas regions carry no rig placement.':'Assembly unavailable: rig_size is not declared.'):'';
  assemble.onclick=()=>{setView(state.view==='assembled'?'item':'assembled');assemble.setAttribute('aria-pressed',String(state.view==='assembled'));};
  bindAssemblyPicking();
  for(const button of queryAll<HTMLElement>('[data-pv-comparison]'))button.onclick=()=>{const mode=button.dataset.pvComparison as PartsComparison['mode'];state.comparison=mode==='difference'?{mode,opacity:state.comparison.opacity,threshold:state.differenceThreshold}:{mode,opacity:state.comparison.opacity};if(state.comparison.mode!=='part'){state.alpha=false;$<HTMLInputElement>('pv-alpha').checked=false;state.meshShown.delete(state.data!.items[state.selected]!.name);renderMesh();}renderComparison();void paint();};
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

  for (const b of queryAll<HTMLButtonElement>('[data-pv-view]')) b.onclick = () => setView(b.dataset.pvView as 'item' | 'page');
  const offLang = onLanguageChange(() => { if (!disposed && state.data) { localizeWorkspace(); select(state.selected); } });
  disposers.push(offLang);
  if(data.items.length){
    const index = pendingSelectPart ? data.items.findIndex(item => item.name === pendingSelectPart) : 0;
    select(index >= 0 ? index : 0);
    $('rig-label').textContent = t(state.view === 'assembled' ? 'Assembled' : 'Selected part');
    assemble.setAttribute('aria-pressed', String(state.view === 'assembled'));
  }
  localizeWorkspace();
  renderCorrections();
}

function localizeWorkspace(): void {
  applyDomI18n(slots.toolbar);
  $('reference-pane').setAttribute('aria-label', t('Reference'));
  $('rig-pane').setAttribute('aria-label', t('Rig'));
  $('reference-label').textContent = t('Reference');
  $('rig-label').textContent = t(state.view === 'assembled' ? 'Assembled' : 'Selected part');
  $('pv-list-title').textContent = t(state.data?.mode === 'atlas' ? 'REGIONS' : 'PARTS');
  $('pv-flags-title').textContent = t('PRODUCER FLAGS');
  viewport?.renderCameraControls();
}

/** Observe taps only; the shared controller exclusively owns pan, zoom and pinch. */
function bindAssemblyPicking():void {
 const pane=$('rig-viewport');let tap:{id:number;x:number;y:number}|null=null;const pointers=new Set<number>();
 const onDown=(e:PointerEvent)=>{pointers.add(e.pointerId);if(pointers.size===1&&e.button===0)tap={id:e.pointerId,x:e.clientX,y:e.clientY};else tap=null;};
 const onMove=(e:PointerEvent)=>{if(tap&&Math.hypot(e.clientX-tap.x,e.clientY-tap.y)>4)tap=null;};
 const onCancel=(e:PointerEvent)=>{pointers.delete(e.pointerId);tap=null;};
 const onUp=(e:PointerEvent)=>{
  pointers.delete(e.pointerId);const start=tap;tap=null;
  if(!start||start.id!==e.pointerId||Math.hypot(e.clientX-start.x,e.clientY-start.y)>4||state.view!=='assembled'||painting||paintFailure||commentUi?.active())return;
  const data=state.data!,r=$('pv-canvas').getBoundingClientRect(),zoom=viewport!.paneCamera('rig').zoom;
  const layers=data.items.flatMap(box=>{const img=images.get(`image:${box.index}`);return img?[{box,alpha:sourceAlpha(box,img)}]:[];});
  const hit=pickAssembly(layers,(e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom,state.hidden);if(hit)select(hit.index);
 };
 pane.addEventListener('pointerdown',onDown);
 pane.addEventListener('pointermove',onMove);
 pane.addEventListener('pointercancel',onCancel);
 pane.addEventListener('pointerup',onUp);
 disposers.push(()=>{
  pane.removeEventListener('pointerdown',onDown);
  pane.removeEventListener('pointermove',onMove);
  pane.removeEventListener('pointercancel',onCancel);
  pane.removeEventListener('pointerup',onUp);
 });
}

interface PartsPose extends CommentUiPose {item:Item;sourceHash:string;view:PartsIssue['view']}
function setupPartsComments():void {
 const codec:CommentCodec<PartsIssue,PartsPose>={
 read:raw=>{try{const c=parsePartsIssue(raw,false,true,false);const camera={space:'image' as const,center:c.view.camera.center,zoom:c.view.camera.zoom,viewport:c.view.camera.viewport,visible:{x:c.view.camera.center.x-c.view.camera.viewport.width/c.view.camera.zoom/2,y:c.view.camera.center.y-c.view.camera.viewport.height/c.view.camera.zoom/2,width:c.view.camera.viewport.width/c.view.camera.zoom,height:c.view.camera.viewport.height/c.view.camera.zoom}};const r=c.view.mode==='assembled'?c.rigRegion:c.imageRegion!;const part=c.parts[0]!;return {mode:'parts',viewport:'rig',screen:region(projectMark(r,camera),projectMark({x:r.x+r.width,y:r.y+r.height},camera)),world:r,camera,crop:{...c.crop,png:c.crop.png??''},bookmark:{part:part.name,imageHash:part.imageHash,sourceHash:c.sourceHash,view:c.view}};}catch{return null;}},
 signature:p=>[p.item.name,p.item.imageHash,p.sourceHash,p.camera,p.view],
 matches:(_mark,p,raw)=>{try{const c=parsePartsIssue(raw,false,true,false);return c.view.mode==='item'&&p.item.name===c.parts[0]?.name&&p.item.imageHash===c.parts[0]?.imageHash&&p.sourceHash===c.sourceHash;}catch{return false;}},
 label:raw=>{const c=parsePartsIssue(raw,false,true,false);return `${c.parts.map(pt=>pt.name).join(', ')} · ${c.summary}`;},
 create:async(p,_view,screen,crop,_bookmark,summary)=>{const r=snapImageRegion(region(unprojectMark(screen,p.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},p.camera)));const c:PartsIssue={schema:'rig-review-parts-comment/2',id:crypto.randomUUID(),summary,parts:[{name:p.item.name,imageHash:p.item.imageHash!}],sourceHash:p.sourceHash,imageRegion:r,rigRegion:{...r,x:p.item.x+r.x,y:p.item.y+r.y},view:{...p.view,mode:'item'},crop,nativeCrop:null};return parsePartsIssue(await source.crop(c),true,true,false);}
 };
 const pose=():PartsPose|null=>{const data=state.data,item=data?.items[state.selected],camera=viewport?.numericView().cameras.rig;if(!data||!item||!camera||data.mode!=='parts'||state.view!=='item')return null;return {mode:'parts',camera,item:{...item},sourceHash:data.sourceHash,view:{mode:'item',camera:{zoom:camera.zoom,center:{...camera.center},viewport:{...camera.viewport}},cameraSync:viewport!.state.cameraSync,referenceCamera:(()=>{const c=viewport!.numericView().cameras.reference;return c?{zoom:c.zoom,center:{...c.center},viewport:{...c.viewport}}:null;})(),background:state.bg,alpha:state.alpha,footprints:state.footprints,mesh:state.meshShown.has(item.name),comparison:{...state.comparison}},capture:{pane:$('rig-viewport'),root:$('rig-root'),images:true,canvas:$<HTMLCanvasElement>('pv-canvas'),backend:'canvas2d',nearest:true}};};
 commentUi=bindStageComments({toolbar:slots.toolbar,listHost:slots.side,toggle:$<HTMLButtonElement>('stage-comment'),viewports:{rig:$('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
  restore:async(raw)=>{const current = await source.view();if(disposed)return;if(current.sourceHash!==state.data?.sourceHash)throw new Error('PARTS_COMMENT_STALE_SOURCE');const b=raw as {part:string;imageHash:string;sourceHash:string;view:PartsIssue['view']},item=state.data!.items.find(i=>i.name===b.part);if(!item||item.imageHash!==b.imageHash||state.data!.sourceHash!==b.sourceHash)throw new Error('PARTS_COMMENT_STALE_SOURCE: reopen the bound source');setView('item');$('pv-assemble').setAttribute('aria-pressed','false');select(item.index);state.bg=b.view.background;state.alpha=b.view.alpha;state.footprints=b.view.footprints;state.comparison={...(b.view.comparison??defaultPartsComparison())};if(state.comparison.mode==='difference')state.differenceThreshold=state.comparison.threshold;renderComparison();if(b.view.mesh)state.meshShown.add(item.name);else state.meshShown.delete(item.name);$<HTMLSelectElement>('pv-bg').value=state.bg;$<HTMLInputElement>('pv-alpha').checked=state.alpha;$<HTMLInputElement>('pv-footprints').checked=state.footprints;renderMesh();viewport!.state.cameraRestoring=true;try{await paint();if(!paintFailure){viewport!.writeCamera('rig',{zoom:b.view.camera.zoom,center:{...b.view.camera.center}});if(b.view.referenceCamera)viewport!.writeCamera('reference',{zoom:b.view.referenceCamera.zoom,center:{...b.view.referenceCamera.center}});viewport!.state.cameraSync=b.view.cameraSync;viewport!.fitCamera();}}finally{viewport!.state.cameraRestoring=false;}},
  feedback:()=>comments,locked:()=>Boolean(state.data?.legacyVerdict?.readOnly)||host.locked() !== 'open',add:c=>comments.push(c),changed:()=>{renderList();host.changed(structuredClone(comments));},error:m=>{paintBusyStatus=null;$('pv-save-status').textContent=t(m);},blocked:()=>painting,busy:()=>painting,busyError:message=>{paintBusyStatus={token:paintToken,text:t(message)};$('pv-save-status').textContent=paintBusyStatus.text;},shortcutActive:()=>mountActive&&!disposed,refusal:()=>paintFailure??(state.data?.legacyVerdict?.readOnly?state.data.legacyVerdict.code+': '+t('parts.legacyVerdictBanner',[state.data.legacyVerdict.flaggedCount]):null)??(host.locked() !== 'open'?'Read-only view: reopen with rig-review open to edit.':null)??(stageEmbedded&&state.data?.mode==='parts'?'PARTS_JOINED_ISSUE_UNSUPPORTED':null)??(state.view==='assembled'?'PARTS_COMMENT_UNAVAILABLE: select the individual part view to comment':null)??(state.data?.mode!=='parts'?'PARTS_COMMENT_UNAVAILABLE: original part image required':null),codec});

}

function renderCorrections():void {
 const data = state.data;
 if (!stageEmbedded && (!data || (!Object.hasOwn(data, 'draft') && !Object.hasOwn(data, 'draftUnavailable')))) {
  query('#pv-corrections')?.remove();
  return;
 }
 let host=query('#pv-corrections');if(!host){host=doc.createElement('section');host.id='pv-corrections';slots.stage.append(host);}
 host.replaceChildren();const item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 const label=doc.createElement('p');label.textContent=t(data?.draft&&!mapping?'STAGE_DRAFT_NO_MESH: this part has no mesh attachment; direct correction is unavailable.':data?.draft?.label??data?.draftUnavailable??'STAGE_DRAFT_UNAVAILABLE: no producer-compatible draft is supplied.');host.append(label);
 if(!mapping||!data?.draft)return;
 label.textContent+=` · ${mapping.part} · ${mapping.skin}/${mapping.slot}/${mapping.attachment} · v ${mapping.vertices} t ${mapping.triangles} · ${data.draft.buildId}`;
 if(data.draft.inspectionOnly)return;
 for(const [instrument,title,operation]of [['chest','Chest regions',t('rig-parts remesh --mesh')],['mesh','Mesh parameters',t('rig-parts remesh --mesh')],['delta','Edit Mesh',t('rig-parts remesh --delta')]]){
  const button=doc.createElement('button');button.type='button';button.textContent=t(title!);button.title=`${mapping.part} · ${operation}`;button.onclick=()=>slots.stage.dispatchEvent(new CustomEvent('parts-correction',{detail:{type:'review-stage-correction',part:mapping.part,sourceHash:data.sourceHash,buildId:data.draft!.buildId,instrument}}));host.append(button);
 }
 const guidance=doc.createElement('p');guidance.textContent=t('Use Write review, choose Parts review and name the Create draft. Export the saved item with the feedback CLI. Mesh deltas retain evidence as unsupported operations.');host.append(guidance);
}

function stagePartsSnapshot():StagePartsState|null {
 const data=state.data,item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 if(!data?.inspectionSourceHash||!item?.imageHash||!mapping||!viewport)return null;
 return {inspectionSourceHash:data.inspectionSourceHash,part:item.name,imageHash:item.imageHash,box:{x:item.x,y:item.y,w:item.w,h:item.h},mapping:{skin:mapping.skin,slot:mapping.slot,attachment:mapping.attachment},rig:{...viewport.paneCamera('rig')},reference:{...viewport.paneCamera('reference')},cameraSync:viewport.state.cameraSync,bg:state.bg,alpha:state.alpha,footprints:state.footprints,view:state.view,mesh:state.meshShown.has(item.name)};
}
async function restoreStageParts(saved:StagePartsState):Promise<void>{
 if(disposed||!state.data||!viewport)return;
 try{
  const index=stagePartsSelectionIndex(state.data,saved);
  viewport.state.cameraRestoring=true;state.bg=saved.bg;state.alpha=saved.alpha;state.footprints=saved.footprints;state.view=saved.view;
  if(saved.mesh)state.meshShown.add(saved.part);else state.meshShown.delete(saved.part);
  select(index);await paint();if(!disposed&&!paintFailure){viewport.writeCamera('rig',saved.rig);if(state.data.painting)viewport.writeCamera('reference',saved.reference);viewport.state.cameraSync=saved.cameraSync;viewport.fitCamera();}
 }catch{if(disposed)return;const status=$('pv-load');status.hidden=false;status.dataset.result='refused';status.textContent=t('STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.');$('stage-layout').hidden=true;}
 finally{viewport.state.cameraRestoring=false;}
}

async function revalidateStageParts(savedState?: StagePartsState | null): Promise<void> {
  try {
    const data = await source.view();
    if (disposed) return;
    const previous = state.data;
    const sameBuild = data.draft?.buildId === previous?.draft?.buildId;
    const valid = sameBuild ? data.sourceHash === previous?.sourceHash :
      Boolean(data.inspectionSourceHash && data.inspectionSourceHash === previous?.inspectionSourceHash);
    if (!valid) throw new Error('STAGE_DRAFT_MISMATCH: separated parts and draft mesh identity differ.');
    state.data = data;
    imageGeneration++; paintToken++; pendingImages.clear();
    images.clear(); assemblyAlpha.clear();
    if (savedState) await restoreStageParts(savedState);
    else if (data.items.length) { select(Math.min(state.selected, data.items.length - 1)); await paint(); }
    renderCorrections();
  } catch (error) {
    if (disposed) return;
    const status = $('pv-load');
    status.hidden = false; status.dataset.result = 'refused';
    status.textContent = t(error instanceof Error ? error.message : String(error));
    for (const root of roots) if (root !== slots.stage) root.hidden = true;
    $('stage-layout').hidden = true;
  }
}

  syncPaintState();
  void boot().catch(error => {if(disposed)return;painting=false;paintFailure=error instanceof Error?error.message:String(error);syncPaintState();settleReady(error);});
  return {
    ready,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      painting=false;syncPaintState();
      settleReady(new Error('PARTS_WORKSPACE_DISPOSED'));
      paintToken++; imageGeneration++;
      commentUi?.dispose();
      commentUi = null;
      for (const dispose of disposers.splice(0)) dispose();
      pendingImages.clear();
      for (const root of roots) root.replaceChildren();
      images.clear();
      assemblyAlpha.clear();
    },
    select(part: string): void {
      pendingSelectPart = part;
      const idx = state.data?.items.findIndex(i => i.name === part) ?? -1;
      if (idx >= 0) select(idx);
    },
    issues(): PartsIssue[] {
      return structuredClone(comments);
    },
    snapshot(): StagePartsState | null {
      return stagePartsSnapshot();
    },
    restore(saved: StagePartsState): Promise<void> {
      return restoreStageParts(saved);
    },
    revalidate(savedState?: StagePartsState | null): Promise<void> {
      return revalidateStageParts(savedState);
    },
  };
}
