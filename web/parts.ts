import {bindWorkspaceUI,mountStatusBar,type WorkspaceScreenRegions} from './workspace-ui.ts';
import {mountBottomPanel} from './inspector-blocks.ts';
import {bindPartNavigator} from './part-selection.ts';
import {defaultPartsComparison,paintingRectangle,type PartsComparison} from '../src/parts-comparison.ts';
import {mountViewportPair} from './viewport-pair.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
import {bindStageComments,type CommentUiPose,type CommentCodec} from './stage-comments.ts';
import {parsePartsIssue,assertPartsIssueBinding,snapImageRegion,type PartsComment,type PartsIssue} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {textEntryFocused,createViewControls,bindInspectorTabs,panelMake,labelledControl,actionButton} from './view-controls.ts';
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
import { BACKGROUNDS, paintAssembly, pickAssembly, paintAssemblyOutline, frontParts, paintAlphaOnly, paintBackground, paintPart, paintMesh, paintOverlay, paintPaintingCrop, paintFootprints } from './parts-render.ts';

export interface Mesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown> }
export interface Item { mesh?: Mesh; meshUnavailable?: 'PARTS_MESH_GENERATED'; name: string; index: number; x: number; y: number; w: number; h: number; page?: string; degrees?: number; image?: boolean;imageHash?:string }
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

export interface MountPartsWorkspaceOptions {
  defaultView: 'item' | 'assembled';
  embedded?: boolean;
  language?: HTMLSelectElement;
  kind?: 'parts'|'job-parts';
  tabs?: {id:string;label:string;panel:HTMLElement}[];
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

/** Shared Background item; step 5 can adopt it without another list of sentinel choices. */
export function createPartsBackground() {
 const select=panelMake('select',{id:'pv-bg'});select.dataset.pvBg='';
 for(const value of BACKGROUNDS)select.append(panelMake('option',{value,textContent:t(value[0]!.toUpperCase()+value.slice(1))}));
 return labelledControl(t('Background'),select);
}

export function mountPartsWorkspace(
  regions: WorkspaceScreenRegions,
  source: PartsSource,
  host: PartsHost,
  options: MountPartsWorkspaceOptions,
): PartsWorkspaceHandle {
  const roots = [regions.left, regions.stage, regions.toolbar, regions.secondary, regions.bottom, regions.status];
  if (roots.some(root => !root)) throw new Error('PARTS_WORKSPACE_REGION_REQUIRED');
  const doc = regions.stage.ownerDocument;
  const win = doc.defaultView;
  if (!win || roots.some(root => root.ownerDocument !== doc)) throw new Error('PARTS_WORKSPACE_DOCUMENT_REQUIRED');
  const eventWindow: EventTarget = win;
  const title=panelMake('h2',{id:'parts-list-title',textContent:t('PARTS')}),search=panelMake('input',{id:'parts-search',type:'search'});
  search.setAttribute('aria-label',t('Search parts'));search.placeholder=t('Search parts');
  const list=panelMake('ul',{id:'pv-items'});list.dataset.pvItems='';const leftHeader=panelMake('div',{className:'left-header'},title,search);leftHeader.classList.add('parts-header');regions.left.prepend(leftHeader,list);
  const viewControls=createViewControls({layout:'rigStep1',viewSwitch:{groups:[{modes:[
   {id:'assembled',labelKey:'Assembled',pressed:options.defaultView==='assembled'},
   {id:'part',labelKey:'Part',pressed:options.defaultView==='item'},
   {id:'overlay',labelKey:'Overlay',pressed:false},{id:'difference',labelKey:'Difference',pressed:false},
  ]},{modes:[{id:'item',labelKey:'Region',pressed:false},{id:'page',labelKey:'Pages',pressed:false}]}],currentMode:options.defaultView==='assembled'?'assembled':'part',onChange:changeMode}});
  const comment=actionButton(t('Comment · C ({0})',[0]),null);comment.id='stage-comment';comment.setAttribute('aria-pressed','false');comment.setAttribute('aria-controls','stage-comment-list');
  regions.toolbar.append(comment,viewControls.syncLabel,viewControls.zoomGroup!);
  const alpha=panelMake('input',{id:'pv-alpha',type:'checkbox'}),footprints=panelMake('input',{id:'pv-footprints',type:'checkbox'});
  alpha.dataset.pvAlpha='';footprints.dataset.pvFootprints='';
  const footprintControl=labelledControl(t('Footprints of parts in front'),footprints);footprintControl.id='pv-footprint-control';
  const opacity=panelMake('input',{id:'pv-opacity',type:'range',min:'0',max:'1',step:'0.001',value:'0.5'}),opacityValue=panelMake('output',{id:'pv-opacity-value',textContent:'50.0%'});
  const opacityControl=labelledControl(t('Part opacity'),opacity);opacityControl.id='pv-opacity-control';opacityControl.hidden=true;opacityControl.append(opacityValue);
  const threshold=panelMake('input',{id:'pv-threshold',type:'number',min:'0',max:'255',step:'1',value:'0'}),thresholdControl=labelledControl(t('Threshold'),threshold);thresholdControl.id='pv-threshold-control';thresholdControl.hidden=true;
  regions.secondary.append(createPartsBackground(),labelledControl(t('Alpha only'),alpha,true),footprintControl,opacityControl,thresholdControl);
  const box=panelMake('div',{id:'pv-canvas-box',className:'pv-canvas-box'}),canvas=panelMake('canvas',{id:'pv-canvas',width:1,height:1}),overlay=panelMake('div',{id:'pv-overlay',className:'pv-overlay'});
  canvas.dataset.pvCanvas='';box.append(canvas,overlay);regions.stage.append(box);
  const caption=panelMake('p',{id:'pv-caption',className:'pane-footer'});
  const load=panelMake('span',{id:'pv-load'}),saveState=panelMake('span',{id:'parts-save-status'});
  regions.status.append(mountStatusBar({message:load,readouts:[saveState],source:panelMake('span',{id:'parts-source-hash'})}).footer);
  const issuesPanel=panelMake('section',{id:'parts-issues'}),flagsPanel=panelMake('section',{id:'parts-producer-flags'}),meshPanel=panelMake('section',{id:'parts-mesh-geometry'}),legacyPanel=panelMake('section',{id:'parts-legacy',className:'context-block'});
  const flags=panelMake('ul',{id:'pv-flags'});flags.dataset.pvFlags='';
  flagsPanel.append(panelMake('h2',{id:'pv-flags-title',textContent:t('PRODUCER FLAGS')}),flags,panelMake('p',{id:'pv-flag-sources',className:'subtle'}));
  legacyPanel.append(panelMake('ul',{id:'pv-legacy-flagged',hidden:true}));
  const extraTabs=options.tabs??[];
  regions.body.append(issuesPanel,flagsPanel,meshPanel,legacyPanel,...extraTabs.map(tab=>tab.panel));issuesPanel.append(regions.act);
  const bottom=mountBottomPanel({kind:options.kind??'parts',heading:regions.heading,act:regions.act,actHome:issuesPanel,tabs:[
   {id:'parts-issues',label:'Issues',panel:issuesPanel},{id:'parts-flags',label:'Producer flags',panel:flagsPanel},
   {id:'parts-mesh',label:'Mesh geometry',panel:meshPanel},{id:'parts-legacy',label:'Legacy flagged',panel:legacyPanel},...extraTabs,
  ]});
  const tabs=bindInspectorTabs(()=>{},()=>{},{...bottom.row,reveal:()=>workspaceUI?.revealInspector()});
  let workspaceUI:ReturnType<typeof bindWorkspaceUI>|undefined;
  roots.push(viewControls.zoomGroup!,caption,issuesPanel,flagsPanel,meshPanel,legacyPanel);
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
  disposers.push(()=>tabs.dispose());
  disposers.push(bindPartNavigator(search,list,()=>{if(state.data)renderList();}));
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
  const state = { data: null as ViewData | null, selected: 0, bg: 'checker', alpha: false, footprints: false, comparison:defaultPartsComparison(), differenceThreshold:0, hidden: new Set<string>(), view: options.defaultView as 'item' | 'page' | 'assembled', page: 0, meshVisible: false };
  const comments:PartsIssue[]=[];let commentUi:ReturnType<typeof bindStageComments>|null=null;let viewport:ReturnType<typeof createPartsViewport>|null=null;let painting=true;
  let paintingHeld = false;
  let hoverName: string | null = null;
  const highlightedParts = new Set<string>();
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
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

function overlayBox(x: number, y: number, w: number, h: number): HTMLDivElement {
  const div = doc.createElement('div');
  div.className = 'pv-box';
  div.style.left = `${x}px`; div.style.top = `${y}px`;
  div.style.width = `${w}px`; div.style.height = `${h}px`;
  return div;
}

let paintToken = 0;
let paintFailure:string|null=null,paintReset=false;
let paintBusyStatus: {token: number; text: string} | null = null;
function syncPaintState(): void {
 regions.stage.dataset.partsPaintState = disposed ? 'disposed' : painting ? 'busy' : paintFailure ? 'failed' : 'ready';
 regions.stage.setAttribute('aria-busy', String(painting));
 const toggle = $<HTMLButtonElement>('stage-comment');
 toggle.disabled = painting || paintingHeld;
 toggle.setAttribute('aria-busy', String(painting));
 if (commentUi) commentUi.refresh();
 else toggle.textContent = t(painting ? 'Comment · C ({0}) · Rendering' : 'Comment · C ({0})', [0]);
}

async function paint():Promise<void>{
 const token=++paintToken;painting=true;
 if (paintBusyStatus) {
  if ($('parts-save-status').textContent === paintBusyStatus.text) paintBusyStatus.token = token;
  else paintBusyStatus = null;
 }
 syncPaintState();
 try{
  await paintRaster(token);if(disposed||token!==paintToken)return;
  await paintReference(token);if(disposed||token!==paintToken)return;
  if(paintFailure&&$('parts-save-status').textContent===t(paintFailure))$('parts-save-status').textContent='';paintFailure=null;painting=false;
  if(paintBusyStatus?.token===token){
   if($('parts-save-status').textContent===paintBusyStatus.text)$('parts-save-status').textContent='';
   paintBusyStatus=null;
  }
  syncPaintState();viewport?.fitCamera();commentUi?.refresh();settleReady();
 }catch(error){
  if(disposed||token!==paintToken)return;
  settleReady(error instanceof Error?error:new Error('PARTS_PAINT_FAILED'));
  const failure=error instanceof Error&&error.message.startsWith('PARTS_DIFFERENCE_')?error.message:'PARTS_PAINT_FAILED: view could not be rendered; select the part to retry';
  const canvas=$<HTMLCanvasElement>('pv-canvas');canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);
  const ref=$<HTMLCanvasElement>('pv-reference') as HTMLCanvasElement|null;if(ref){if(canvas.width>0&&canvas.height>0){ref.width=canvas.width;ref.height=canvas.height;}ref.getContext('2d')?.clearRect(0,0,ref.width,ref.height);}
  $('pv-overlay').replaceChildren();$('pv-caption').textContent=t(failure);$('parts-save-status').textContent=t(failure);
  painting=false;paintFailure=null;paintReset=true;
  try{viewport?.writeCamera?.('rig',{zoom:1,center:null});viewport?.writeCamera?.('reference',{zoom:1,center:null});viewport?.fitCamera();}
  finally{paintReset=false;paintFailure=failure;}
  commentUi?.refresh();
 }finally{
  if(!disposed&&token===paintToken){
   painting=false;
   if(paintBusyStatus?.token===token){
    if(!paintFailure&&$('parts-save-status').textContent===paintBusyStatus.text)$('parts-save-status').textContent='';
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

function drawMeshes(ctx: CanvasRenderingContext2D, layers: {box: Item; image: HTMLImageElement}[], assembled = true): void {
  if (!state.meshVisible) return;
  for (const {box, image} of layers) {
    if (!box.mesh) continue;
    const selected = box.index === state.selected;
    ctx.save();
    if (assembled) ctx.translate(box.x, box.y);
    paintMesh(ctx, image, box.w, box.h, box.mesh,
      (w, h) => Object.assign(doc.createElement('canvas'), {width: w, height: h}),
      {tint: selected, alpha: selected ? 1 : .35});
    ctx.restore();
  }
}

function renderAssemblySelection(layers: {box: Item; image: HTMLImageElement}[]): void {
  const overlay = $('pv-overlay'), canvas = $<HTMLCanvasElement>('pv-canvas');
  overlay.replaceChildren();
  if (paintingHeld) return;
  const names = new Set([state.data!.items[state.selected]!.name, ...highlightedParts, hoverName]);
  for (const {box, image} of layers) {
    if (!names.has(box.name)) continue;
    const outline = doc.createElement('canvas');
    outline.width = canvas.width;outline.height = canvas.height;outline.dataset.assemblyOutline = box.name;
    paintAssemblyOutline(outline.getContext('2d')!, box, sourceAlpha(box, image));overlay.append(outline);
    if (box.name !== hoverName) continue;
    const label = overlayBox(box.x, box.y, box.w, box.h), text = doc.createElement('span');
    label.style.pointerEvents = 'none';label.dataset.assemblyHover = box.name;text.textContent = box.name;
    label.append(text);overlay.append(label);
  }
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
    const original=(paintingHeld||state.comparison.mode==='overlay')&&data.painting?await paintingImage():null;
    if(disposed||token!==paintToken)return;
    const ctx=setCanvas(canvas,w,h);
    if(original){
      paintPaintingCrop(ctx,original,paintingRectangle({x:0,y:0,w,h},data.rigSize,data.painting!),w,h,state.bg);
      const assembled=doc.createElement('canvas');assembled.width=w;assembled.height=h;
      paintAssembly(assembled.getContext('2d')!,w,h,layers,{bg:state.bg,alpha:false,transparent:true});
      ctx.globalAlpha=paintingHeld?0:state.comparison.opacity;ctx.drawImage(assembled,0,0);ctx.globalAlpha=1;
    }else paintAssembly(ctx,w,h,layers,{bg:state.bg,alpha:state.alpha});
    if (!paintingHeld) drawMeshes(ctx, layers);
    renderAssemblySelection(layers);
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
  if (paintingHeld && data.painting) {
    const original = await paintingImage();
    if (disposed || token !== paintToken) return;
    const ctx = setCanvas(canvas, w, h);
    paintPaintingCrop(ctx, original, paintingRectangle(item, data.rigSize!, data.painting), w, h, state.bg);
    overlay.replaceChildren();
    return;
  }
  if(state.comparison.mode==='difference'){
    if (!source.difference) throw new Error('PARTS_DIFFERENCE_UNAVAILABLE: declared painting_in_rig and individual part view required.');
    const response = await source.difference(item.index, state.comparison.threshold, state.footprints);
    if(!response.ok){const out=await response.json() as {error:string};throw new Error(out.error);}
    const meshImage=state.meshVisible&&item.mesh?await itemImage(item):null;
    const image=await createImageBitmap(await response.blob());
    try{if(disposed||token!==paintToken)return;const ctx=setCanvas(canvas,w,h);paintBackground(ctx,w,h,state.bg);ctx.drawImage(image,0,0);if(meshImage)drawMeshes(ctx,[{box:item,image:meshImage}],false);overlay.replaceChildren();
      caption.textContent=t('Difference: {count} pixels above threshold · {covered} covered pixels excluded · visual comparison, no automatic verdict.',{count:response.headers.get('X-Difference-Count')??'',covered:response.headers.get('X-Difference-Covered')??''});
    }finally{image.close();}return;
  }
  const img = await itemImage(item), front = state.footprints ? frontParts(data.items, item) : [];
  const fronts = await Promise.all(front.map(async o => ({ o, img: await itemImage(o) })));
  const original=(paintingHeld||state.comparison.mode==='overlay')&&data.painting?await paintingImage():null;
  if (disposed || token !== paintToken) return;
  const ctx = setCanvas(canvas, w, h);
  const makeCanvas=(w:number,h:number)=>Object.assign(doc.createElement('canvas'),{width:w,height:h});
  if(original){paintOverlay(ctx,item,img,original,paintingRectangle(item,data.rigSize!,data.painting!),state.comparison.opacity,state.bg);paintFootprints(ctx,item,fronts.map(f=>({box:f.o,image:f.img})),makeCanvas);}
  else paintPart(ctx, item, img, { bg: state.bg, alpha: state.alpha, fronts: fronts.map(f => ({ box: f.o, image: f.img })), makeCanvas: (w, h) => Object.assign(doc.createElement('canvas'), { width: w, height: h }) });
  drawMeshes(ctx, [{box: item, image: img}], false);
  overlay.replaceChildren(...data.flags.filter((f): f is Extract<Flag, { kind: 'faint' }> => f.item === item.name && f.kind === 'faint').map(f => {
    const box = overlayBox(f.box[0], f.box[1], f.box[2], f.box[3]);
    box.dataset.flag = f.id;
    return box;
  }));
  caption.textContent = t('{name}: {width}×{height} px at {x},{y} in rig px, draw order {order} of {count}.', { name: item.name, width: item.w, height: item.h, x: item.x, y: item.y, order: item.index + 1, count: data.items.length })
    + (state.footprints ? ' ' + (front.length === 1 ? t('Tinted: the footprint of the part drawn in front ({names}).', { names: front[0]!.name }) : front.length ? t('Tinted: the footprints of {count} parts drawn in front ({names}).', { count: front.length, names: front.map(o => o.name).join(', ') }) : t('No part is drawn in front of it.')) : '');
}

async function paintReference(token:number):Promise<void>{const data=state.data,item=data?.items[state.selected];if(!data?.painting||!item)return;const img=await paintingImage();if(disposed||token!==paintToken||data!==state.data||item!==state.data?.items[state.selected])return;const box=partFrame(data,item);const canvas=$<HTMLCanvasElement>('pv-reference');canvas.width=box.w;canvas.height=box.h;const ctx=canvas.getContext('2d')!;paintPaintingCrop(ctx,img,paintingRectangle(box,data.rigSize!,data.painting),box.w,box.h,state.bg);}

function changeMode(mode:string):void {
 if(mode==='assembled'||mode==='item'||mode==='page'){state.comparison={mode:'part',opacity:state.comparison.opacity};setView(mode);return;}
 if(mode==='part')setView('item');
 state.comparison=mode==='difference'?{mode,opacity:state.comparison.opacity,threshold:state.differenceThreshold}:{mode:mode as 'part'|'overlay',opacity:state.comparison.opacity};
 if(mode!=='part'){state.alpha=false;$<HTMLInputElement>('pv-alpha').checked=false;renderMesh();}
 renderComparison();void paint();
}

function renderComparison():void {
 const overlay=!!state.data?.painting&&state.comparison.mode==='overlay',difference=state.comparison.mode==='difference';
 const differenceReason=!state.data?.differenceAvailable||!source.difference||state.view!=='item'?t('PARTS_DIFFERENCE_UNAVAILABLE: declared painting_in_rig and individual part view required.'):null;
 viewControls.setDisabled('difference',differenceReason);viewControls.setDisabled('overlay',state.data?.painting?null:t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting'));
 viewControls.setDisabled('assembled',state.data?.mode==='parts'&&state.data.rigSize?null:t(state.data?.mode==='atlas'?'Assembly unavailable: atlas regions carry no rig placement.':'Assembly unavailable: rig_size is not declared.'));
 for(const id of ['item','page']){const button=query<HTMLButtonElement>(`[data-view="${id}"]`);if(button)button.hidden=state.data?.mode!=='atlas';}for(const separator of viewControls.viewSwitch!.querySelectorAll<HTMLElement>('hr'))separator.hidden=state.data?.mode!=='atlas';
 let differenceNotice=query('#parts-difference-reason');if(!differenceNotice){differenceNotice=panelMake('span',{id:'parts-difference-reason',className:'subtle'});regions.secondary.append(differenceNotice);}differenceNotice.textContent=!source.difference?differenceReason??'':'';
 const mode=state.view==='page'?'page':state.comparison.mode!=='part'?state.comparison.mode:state.view==='assembled'?'assembled':state.data?.mode==='atlas'?'item':'part';
 viewControls.setMode(null);viewControls.setMode(mode);
 $('pv-threshold-control').hidden=!difference;$<HTMLInputElement>('pv-threshold').value=String(state.comparison.mode==='difference'?state.comparison.threshold:state.differenceThreshold);
 $('pv-opacity-control').hidden=!overlay;$<HTMLInputElement>('pv-opacity').value=String(state.comparison.opacity);$('pv-opacity-value').textContent=(state.comparison.opacity*100).toFixed(1)+'%';
 $<HTMLInputElement>('pv-alpha').disabled=overlay||difference;

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
  list.replaceChildren(...data.items.filter(i => !seen.has(i.name) && seen.add(i.name)).filter(item=>item.name.toLowerCase().includes(search.value.toLowerCase())).map(item => {
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
    if(data.mode==='parts'&&state.view==='assembled'){
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
  const meshCount = state.data!.items.filter(part => part.mesh).length;
  const control = doc.createElement('label'); control.id = 'pv-mesh-control'; control.className = 'pv-field';
  const toggle = doc.createElement('input'); toggle.type = 'checkbox'; toggle.checked = state.meshVisible;
  toggle.onchange = () => { state.meshVisible = toggle.checked; void paint(); };
  control.append(toggle, meshCount ? t('mesh from rig.json UVs') : t('Mesh (none 0/{0})', [state.data!.items.length])); regions.secondary.append(control);
  const panel = doc.createElement('section'); panel.id = 'pv-mesh-panel';
  const heading = doc.createElement('h2'); heading.textContent = t('Mesh geometry'); panel.append(heading);
  if (!item.mesh) {
    const unavailable = doc.createElement('p');
    unavailable.textContent = t(item.meshUnavailable === 'PARTS_MESH_GENERATED' ? 'PARTS_MESH_GENERATED: No mesh geometry is available for this part.' : meshCount ? 'No mesh geometry is available for this part.' : 'No mesh geometry is available for this draft.');
    panel.append(unavailable);meshPanel.append(panel);return;
  }
  const figures = doc.createElement('dl');
  for (const key of ['mode', 'vertices', 'triangles', 'art_coverage', 'stray_cleared']) {
    const dt = doc.createElement('dt'), dd = doc.createElement('dd'); dt.textContent = key;
    dd.textContent = Object.hasOwn(item.mesh.figures, key) ? JSON.stringify(item.mesh.figures[key]) : t('not reported');
    dd.dataset.meshFigure = key; figures.append(dt, dd);
  }
  panel.append(figures);
  const help = doc.createElement('p'); help.textContent = t('Pink: art pixels outside every triangle.'); panel.append(help);
  meshPanel.append(panel);
}

function select(index: number): void {
  if (disposed) return;
  hoverName = null;highlightedParts.clear();
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
  hoverName = null;
  state.view = view;renderList();renderMesh();renderComparison();$('rig-label').textContent=t(view==='assembled'?'Assembled':'Selected part');commentUi?.refresh();
  void paint();
}

function renderLegacyVerdict(): void {
  const legacy = state.data?.legacyVerdict;
  const list = query('#pv-legacy-flagged') as HTMLElement | null;
  if (!list) return;
  bottom.row.tabs.find(tab=>tab.id==='parts-legacy')!.button.hidden=!legacy?.flaggedParts.length;
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
  const box=$('pv-canvas-box'),layout=$('stage-layout');mountViewportPair(layout,{footer:caption});$('rig-root').append(box);const reference=doc.createElement('canvas');reference.id='pv-reference';$('reference-content').append(reference);$('rig-empty').hidden=true;$('rig-overlay').hidden=true;$('rig-label').textContent=t('Selected part');$('rig-viewport').tabIndex=0;
  viewport=createPartsViewport({el:$,canvas:$<HTMLCanvasElement>('pv-canvas'),message:(msg)=>{paintBusyStatus=null;$('parts-save-status').textContent=t(msg);},reference:()=>state.data?.painting?$<HTMLCanvasElement>('pv-reference'):null,
    frameSize:target=>{
      const data=state.data,item=data?.items[state.selected];
      if(!data||!item||paintReset)return null;
      if(paintFailure)return {w:0,h:0};
      return target==='rig'?rasterFrame(data,item)??{w:0,h:0}:data.painting?partFrame(data,item):null;
    },
  });viewport.state.cameraSync=true;disposers.push(viewport.bindControls());
  $('native-one').onclick=()=>viewport!.cameraAction(()=>viewport!.updateCamera(viewport!.availableCamera()??'rig',{zoom:1,pan:{x:0,y:0}}));
  const language=options.language??panelMake('select',{id:'settings-language'});
  if(!options.language)regions.left.append(labelledControl(t('Language'),language));
  workspaceUI=bindWorkspaceUI({regions,language,bottomPanel:bottom,changed:()=>viewport?.fitCamera(),defaultTheme:theme=>{doc.documentElement.dataset.theme=theme;}});
  disposers.push(()=>workspaceUI?.dispose());
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
  $('parts-source-hash').textContent=data.sourceHash;
  state.data = data;state.meshVisible=stageEmbedded||!data.items.some(item=>item.mesh);$<HTMLSelectElement>('pv-bg').value=state.bg;$('reference-empty').textContent=data.painting?'':t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');$('reference-empty').hidden=!!data.painting;if(data.painting)viewport.state.cameraSync=true;
  if (data.mode !== 'parts' || !data.rigSize) state.view = 'item';
  comments.push(...structuredClone(host.initial()).map(issue => parsePartsIssue(issue, false, true, false)));
  host.register({kind: 'parts-verdict', value: () => {
    if (disposed || state.data?.legacyVerdict?.readOnly) throw new Error('PARTS_VERDICT_READ_ONLY');
    return {verdict: comments.length ? 'changes-requested' : 'approved', issues: structuredClone(comments), words: ''};
  }});
  setupPartsComments();const ro=viewport.observeResize();disposers.push(viewport.bindNavigation(undefined,()=>mountActive&&!disposed&&!commentUi?.active()&&!paintFailure),()=>ro.disconnect());
  renderLegacyVerdict();
  const legacyBanner = data.legacyVerdict ? data.legacyVerdict.code + ': ' + t('parts.legacyVerdictBanner', [data.legacyVerdict.flaggedCount]) : '';
  $('parts-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : legacyBanner ? legacyBanner : data.verdict ? t('Saved sign-off loaded.') : data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';
  if (legacyBanner) $('pv-load').dataset.result = 'readonly';
  bindAssemblyPicking();
  $<HTMLInputElement>('pv-opacity').oninput=e=>{state.comparison.opacity=Number((e.target as HTMLInputElement).value);renderComparison();void paint();};
  $<HTMLInputElement>('pv-threshold').oninput=e=>{
    const input=e.target as HTMLInputElement,threshold=input.valueAsNumber,status=$('parts-save-status');
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

  const offLang = onLanguageChange(() => { if (!disposed && state.data) { localizeWorkspace(); select(state.selected); } });
  disposers.push(offLang);
  if(data.items.length){
    const index = pendingSelectPart ? data.items.findIndex(item => item.name === pendingSelectPart) : 0;
    select(index >= 0 ? index : 0);
    $('rig-label').textContent = t(state.view === 'assembled' ? 'Assembled' : 'Selected part');
  }
  localizeWorkspace();
  renderCorrections();
}

function localizeWorkspace(): void {
  for(const root of roots)applyDomI18n(root);
  $('reference-pane').setAttribute('aria-label', t('Reference'));
  $('rig-pane').setAttribute('aria-label', t('Rig'));
  $('reference-label').textContent = t('Reference');
  $('rig-label').textContent = t(state.view === 'assembled' ? 'Assembled' : 'Selected part');
  $('parts-list-title').textContent = t(state.data?.mode === 'atlas' ? 'REGIONS' : 'PARTS');
  $('pv-flags-title').textContent = t('PRODUCER FLAGS');
  viewport?.renderCameraControls();
}

/** Observe taps only; the shared controller exclusively owns pan, zoom and pinch. */
function assemblyLayers() {
  return state.data!.items.flatMap(box => {
    const image = images.get(`image:${box.index}`);
    return image && !state.hidden.has(box.name) ? [{box, image, alpha: sourceAlpha(box, image)}] : [];
  });
}

function bindAssemblyPicking():void {
  const pane = $('rig-viewport');
  let tap: {id: number; x: number; y: number} | null = null;
  const pointers = new Set<number>();
  const available = () => !disposed && state.view === 'assembled' && !painting && !paintFailure && !paintingHeld && !commentUi?.active();
  const hitAt = (event: MouseEvent) => {
    const bounds = $('pv-canvas').getBoundingClientRect(), zoom = viewport!.paneCamera('rig').zoom;
    return pickAssembly(assemblyLayers(), (event.clientX - bounds.left) / zoom, (event.clientY - bounds.top) / zoom);
  };
  const clearHover = () => {
    if (!hoverName) return;
    hoverName = null;
    if (!disposed && state.view === 'assembled' && !painting && !paintFailure) renderAssemblySelection(assemblyLayers());
  };
  const onDown = (event: PointerEvent) => {
    if ((event.target as Element)?.closest?.('.stage-comment-ui,button,input')) {tap = null;return;}
    pointers.add(event.pointerId);
    tap = pointers.size === 1 && event.button === 0 ? {id: event.pointerId, x: event.clientX, y: event.clientY} : null;
    clearHover();
  };
  const onMove = (event: PointerEvent) => {
    if (tap && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 4) tap = null;
    if (!available() || pointers.size || event.buttons) {clearHover();return;}
    const name = hitAt(event)?.name ?? null;
    if (name !== hoverName) {hoverName = name;renderAssemblySelection(assemblyLayers());}
  };
  const onCancel = (event: PointerEvent) => {pointers.delete(event.pointerId);tap = null;clearHover();};
  const onUp = (event: PointerEvent) => {
    pointers.delete(event.pointerId);const start = tap;tap = null;
    if (!start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !available()) return;
    const hit = hitAt(event);if (hit) select(hit.index);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (disposed || state.view !== 'assembled' || paintFailure || paintingHeld || commentUi?.active()) return;
    if ((event.target as Element)?.closest?.('.stage-comment-ui,button,input')) return;
    const hit = hitAt(event);if (hit) {select(hit.index);setView('item');}
  };
  const releasePainting = () => {
    if (!paintingHeld) return;
    paintingHeld = false;
    if (!disposed) void paint();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (mountActive && commentUi?.active()) clearHover();
    if (!mountActive || disposed || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || textEntryFocused(event.target)) return;
    if (event.key === 'Escape' && state.view === 'item' && !commentUi?.active() && !commentUi?.draft()) {
      event.preventDefault();setView('assembled');
    }
    if (event.key.toLowerCase() === 'p' && state.data?.mode === 'parts' && state.data.painting && !painting && !paintFailure && !commentUi?.draft()) {
      event.preventDefault();paintingHeld = true;hoverName = null;void paint();
    }
  };
  const keyUp = (event: KeyboardEvent) => {if (event.key.toLowerCase() === 'p') releasePainting();};
  const deactivate = () => {if (!mountActive) releasePainting();};
  const onVisibilityChange = () => {
    if (doc.visibilityState === 'hidden') releasePainting();
  };
  const bindings: [EventTarget, string, EventListener][] = [
    [pane, 'pointerdown', onDown as EventListener], [pane, 'pointermove', onMove as EventListener],
    [pane, 'pointercancel', onCancel as EventListener], [pane, 'pointerup', onUp as EventListener],
    [pane, 'pointerleave', clearHover], [pane, 'dblclick', onDoubleClick as EventListener],
    [doc, 'keydown', keyDown as EventListener], [doc, 'keyup', keyUp as EventListener],
    [doc, 'focusin', deactivate], [doc, 'pointerdown', deactivate], [eventWindow, 'blur', releasePainting],
    [doc, 'visibilitychange', onVisibilityChange],
  ];
  for (const [target, type, handler] of bindings) target.addEventListener(type, handler);
  disposers.push(() => {for (const [target, type, handler] of bindings) target.removeEventListener(type, handler);});
}

interface PartsPose extends CommentUiPose {item:Item;sourceHash:string;view:PartsIssue['view']}
function issueParts(names: string[]): PartsIssue['parts'] {
  return names.map(name => {
    const item = state.data?.items.find(item => item.name === name);
    if (!item?.imageHash) throw new Error('PARTS_COMMENT_PART_MISMATCH: comment belongs to another part');
    return {name, imageHash: item.imageHash};
  });
}

async function prepareIssue(issue: PartsIssue): Promise<PartsIssue> {
  const data = state.data!;
  const bound = parsePartsIssue(issue, false, false, false);
  const items = new Map(data.items.map(item => [item.name, {...item, imageHash: item.imageHash!}]));
  assertPartsIssueBinding(bound, items, data.sourceHash);
  const prepared = await source.crop(bound);
  if (disposed || state.data !== data) throw new Error('PARTS_COMMENT_STALE_SOURCE');
  return parsePartsIssue(prepared, true, false, false);
}

function setupPartsComments():void {
 const codec:CommentCodec<PartsIssue,PartsPose>={
 read:raw=>{try{const c=parsePartsIssue(raw,false,true,false);const camera={space:'image' as const,center:c.view.camera.center,zoom:c.view.camera.zoom,viewport:c.view.camera.viewport,visible:{x:c.view.camera.center.x-c.view.camera.viewport.width/c.view.camera.zoom/2,y:c.view.camera.center.y-c.view.camera.viewport.height/c.view.camera.zoom/2,width:c.view.camera.viewport.width/c.view.camera.zoom,height:c.view.camera.viewport.height/c.view.camera.zoom}};const r=c.view.mode==='assembled'?c.rigRegion:c.imageRegion!;return {mode:'parts',viewport:'rig',screen:region(projectMark(r,camera),projectMark({x:r.x+r.width,y:r.y+r.height},camera)),world:r,camera,crop:{...c.crop,png:c.crop.png??''},bookmark:{parts:c.parts,sourceHash:c.sourceHash,view:c.view}};}catch{return null;}},
 signature:p=>[p.view.mode,p.item.name,p.item.imageHash,p.sourceHash,p.camera,p.view],
 matches:(_mark,p,raw)=>{try{const c=parsePartsIssue(raw,false,true,false);return p.sourceHash===c.sourceHash&&p.view.mode===c.view.mode&&(c.view.mode==='assembled'?c.parts.every(part=>state.data?.items.some(item=>item.name===part.name&&item.imageHash===part.imageHash)):p.item.name===c.parts[0]?.name&&p.item.imageHash===c.parts[0]?.imageHash);}catch{return false;}},
 label:raw=>{const c=parsePartsIssue(raw,false,true,false);return `${c.parts.map(pt=>pt.name).join(', ')} · ${c.summary}`;},
 chips:(pose,screen,existing)=>{
  const visible = state.data!.items.filter(item => !state.hidden.has(item.name));
  if (existing) return {selected: existing.parts.map(part => part.name), candidates: existing.view.mode === 'assembled' ? visible.map(item => item.name) : []};
  if (pose.view.mode === 'item') return {selected: [pose.item.name], candidates: []};
  const size = state.data!.rigSize!;
  const r = snapImageRegion(region(unprojectMark(screen, pose.camera), unprojectMark({x: screen.x + screen.width, y: screen.y + screen.height}, pose.camera), {x: 0, y: 0, width: size[0], height: size[1]}));
  const hits = new Set<string>(), layers = assemblyLayers();
  const stepX = Math.max(1, r.width / 32), stepY = Math.max(1, r.height / 32);
  for (let y = r.y + .5; y < r.y + r.height; y += stepY) {
    for (let x = r.x + .5; x < r.x + r.width; x += stepX) {
      const hit = pickAssembly(layers, x, y);if (hit) hits.add(hit.name);
    }
  }
  return {selected: visible.filter(item => hits.has(item.name)).map(item => item.name), candidates: visible.map(item => item.name)};
 },
 create:async(p,_view,screen,crop,_bookmark,summary,parts)=>{
  const isItem = p.view.mode === 'item';
  const size = state.data!.rigSize!;
  const bounds = {x: 0, y: 0, width: isItem ? p.item.w : size[0], height: isItem ? p.item.h : size[1]};
  const r = snapImageRegion(region(unprojectMark(screen, p.camera),
    unprojectMark({x: screen.x + screen.width, y: screen.y + screen.height}, p.camera), bounds));
  return prepareIssue({schema:'rig-review-parts-comment/2',id:crypto.randomUUID(),summary,
    parts:issueParts(isItem?[p.item.name]:parts??[]),sourceHash:p.sourceHash,
    imageRegion:isItem?r:null,rigRegion:isItem?{...r,x:p.item.x+r.x,y:p.item.y+r.y}:r,
    view:structuredClone(p.view),crop,nativeCrop:null});
 },
 update:async(existing,summary,parts)=>prepareIssue({...existing,summary,
   parts:existing.view.mode==='assembled'?issueParts(parts??[]):existing.parts}),
 };
 const pose=():PartsPose|null=>{const data=state.data,item=data?.items[state.selected],camera=viewport?.numericView().cameras.rig;if(!data||!item||!camera||data.mode!=='parts'||paintingHeld||(state.view!=='item'&&state.view!=='assembled'))return null;return {mode:'parts',camera,item:{...item},sourceHash:data.sourceHash,view:{mode:state.view,camera:{zoom:camera.zoom,center:{...camera.center},viewport:{...camera.viewport}},cameraSync:viewport!.state.cameraSync,referenceCamera:(()=>{const c=viewport!.numericView().cameras.reference;return c?{zoom:c.zoom,center:{...c.center},viewport:{...c.viewport}}:null;})(),background:state.bg,alpha:state.alpha,footprints:state.footprints,mesh:state.meshVisible,comparison:{...state.comparison}},capture:{pane:$('rig-viewport'),root:$('rig-root'),images:true,canvas:$<HTMLCanvasElement>('pv-canvas'),backend:'canvas2d',nearest:true}};};
 commentUi=bindStageComments({toolbar:regions.toolbar,listHost:issuesPanel,toggle:$<HTMLButtonElement>('stage-comment'),viewports:{rig:$('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
  restore:async(raw)=>{
    const data = state.data!, navigation = paintToken, current = await source.view();
    if (disposed) return;
    if (navigation !== paintToken) throw new Error('COMMENT_BUSY: wait for inspection');
    if (state.data !== data || current.sourceHash !== data.sourceHash) throw new Error('PARTS_COMMENT_STALE_SOURCE');
    const bookmark = raw as {parts:PartsIssue['parts'];sourceHash:string;view:PartsIssue['view']};
    const matched = bookmark.parts.map(part => data.items.find(item => item.name === part.name && item.imageHash === part.imageHash));
    if (!matched.length || matched.some(item => !item) || data.sourceHash !== bookmark.sourceHash) throw new Error('PARTS_COMMENT_STALE_SOURCE: reopen the bound source');
    setView(bookmark.view.mode);select(matched[0]!.index);
    highlightedParts.clear();for (const part of bookmark.parts) {highlightedParts.add(part.name);state.hidden.delete(part.name);}
    state.bg = bookmark.view.background;state.alpha = bookmark.view.alpha;state.footprints = bookmark.view.footprints;
    state.comparison = {...(bookmark.view.comparison ?? defaultPartsComparison())};
    if (state.comparison.mode === 'difference') state.differenceThreshold = state.comparison.threshold;
    state.meshVisible = bookmark.view.mesh;
    $<HTMLSelectElement>('pv-bg').value=state.bg;$<HTMLInputElement>('pv-alpha').checked=state.alpha;$<HTMLInputElement>('pv-footprints').checked=state.footprints;
    renderList();renderMesh();renderComparison();viewport!.state.cameraRestoring = true;
    const painted = paint(), token = paintToken;
    try {
      await painted;
      if (disposed || token !== paintToken || paintFailure) return;
      viewport!.writeCamera('rig', bookmark.view.camera);
      if (bookmark.view.referenceCamera) viewport!.writeCamera('reference', bookmark.view.referenceCamera);
      viewport!.state.cameraSync = bookmark.view.cameraSync;viewport!.fitCamera();
    } finally {if (!disposed) viewport!.state.cameraRestoring = false;}
  },
  feedback:()=>comments,locked:()=>Boolean(state.data?.legacyVerdict?.readOnly)||host.locked() !== 'open',add:c=>comments.push(c),changed:()=>{renderList();host.changed(structuredClone(comments));},error:m=>{paintBusyStatus=null;$('parts-save-status').textContent=t(m);},blocked:()=>painting||paintingHeld,busy:()=>painting||paintingHeld,busyError:message=>{paintBusyStatus={token:paintToken,text:t(message)};$('parts-save-status').textContent=paintBusyStatus.text;},shortcutActive:()=>mountActive&&!disposed,refusal:()=>paintFailure??(state.data?.legacyVerdict?.readOnly?state.data.legacyVerdict.code+': '+t('parts.legacyVerdictBanner',[state.data.legacyVerdict.flaggedCount]):null)??(host.locked() !== 'open'?'Read-only view: reopen with rig-review open to edit.':null)??(stageEmbedded&&state.data?.mode==='parts'?'PARTS_JOINED_ISSUE_UNSUPPORTED':null)??(state.data?.mode!=='parts'?'PARTS_COMMENT_UNAVAILABLE: original part image required':null),codec});
}

function renderCorrections():void {
 const data = state.data;
 if (!stageEmbedded && (!data || (!Object.hasOwn(data, 'draft') && !Object.hasOwn(data, 'draftUnavailable')))) {
  query('#pv-corrections')?.remove();
  return;
 }
 let host=query('#pv-corrections');if(!host){host=doc.createElement('section');host.id='pv-corrections';regions.secondary.append(host);}
 host.replaceChildren();const item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 const label=doc.createElement('p');label.textContent=t(data?.draft&&!mapping?'STAGE_DRAFT_NO_MESH: this part has no mesh attachment; direct correction is unavailable.':data?.draft?.label??data?.draftUnavailable??'STAGE_DRAFT_UNAVAILABLE: no producer-compatible draft is supplied.');host.append(label);
 if(!mapping||!data?.draft)return;
 label.textContent+=` · ${mapping.part} · ${mapping.skin}/${mapping.slot}/${mapping.attachment} · v ${mapping.vertices} t ${mapping.triangles} · ${data.draft.buildId}`;
 if(data.draft.inspectionOnly)return;
 for(const [instrument,title,operation]of [['chest','Chest regions',t('rig-parts remesh --mesh')],['mesh','Mesh parameters',t('rig-parts remesh --mesh')],['delta','Edit Mesh',t('rig-parts remesh --delta')]]){
  const button=doc.createElement('button');button.type='button';button.textContent=t(title!);button.title=`${mapping.part} · ${operation}`;button.onclick=()=>regions.stage.dispatchEvent(new CustomEvent('parts-correction',{detail:{type:'review-stage-correction',part:mapping.part,sourceHash:data.sourceHash,buildId:data.draft!.buildId,instrument}}));host.append(button);
 }
 const guidance=doc.createElement('p');guidance.textContent=t('Use Write review, choose Parts review and name the Create draft. Export the saved item with the feedback CLI. Mesh deltas retain evidence as unsupported operations.');host.append(guidance);
}

function stagePartsSnapshot():StagePartsState|null {
 const data=state.data,item=data?.items[state.selected],mapping=data?.draft?.mappings.find(m=>m.part===item?.name);
 if(!data?.inspectionSourceHash||!item?.imageHash||!mapping||!viewport)return null;
 return {inspectionSourceHash:data.inspectionSourceHash,part:item.name,imageHash:item.imageHash,box:{x:item.x,y:item.y,w:item.w,h:item.h},mapping:{skin:mapping.skin,slot:mapping.slot,attachment:mapping.attachment},rig:{...viewport.paneCamera('rig')},reference:{...viewport.paneCamera('reference')},cameraSync:viewport.state.cameraSync,bg:state.bg,alpha:state.alpha,footprints:state.footprints,view:state.view,mesh:state.meshVisible};
}
async function restoreStageParts(saved:StagePartsState):Promise<void>{
 if(disposed||!state.data||!viewport)return;
 try{
  const index=stagePartsSelectionIndex(state.data,saved);
  viewport.state.cameraRestoring=true;state.bg=saved.bg;state.alpha=saved.alpha;state.footprints=saved.footprints;state.view=saved.view;
  state.meshVisible=saved.mesh;
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
    for (const root of roots) if (root !== regions.stage&&root!==regions.status) root.hidden = true;
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
