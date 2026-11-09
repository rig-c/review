import {defaultPartsComparison,paintingRectangle,type PartsComparison} from '../src/parts-comparison.ts';
import {mountViewportPair} from './viewport-pair.ts';
import {createPartsViewport} from './parts-viewport-provider.ts';
import {bindStageComments,type CommentUiPose,type CommentCodec} from './stage-comments.ts';
import {parsePartsIssue,snapImageRegion,type PartsComment,type PartsIssue} from '../src/parts-comment.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {stagePartsSelectionIndex,type StagePartsState,type StagePartsWindow} from './stage-nav.ts';
import type {JobEnabledActKind,JobUISubmissionV3,PanelSlot} from '../src/job-contract.ts';
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
import { onLanguageChange, t } from './i18n.ts';
import type { InstanceAccess } from './instance-access.ts';
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
  value(words?: string): JobUISubmissionV3['value'];
}

export interface PartsSource {
  view(): Promise<ViewData>;
  image(part: string): Promise<Blob>;
  page?(name: string): Promise<Blob>;
  painting?(): Promise<Blob | null>;
  difference?(part: string, threshold: number, footprints: boolean): Promise<{ png: Blob; count: number; covered: number; compared: number }>;
  crop(issue: PartsIssue): Promise<PartsIssue>;
}

export interface PartsHost {
  locked(): boolean;
  changed(issues: PartsIssue[]): void;
  register?(output: PanelOutput): void;
  message?(text: string): void;
}

export interface MountPartsWorkspaceOptions {
  stageEmbedded?: boolean;
  stageSide?: string | null;
  stageBuild?: string;
  initialRestore?: StagePartsState | null;
  sourceReady?: Promise<void>;
  access?: InstanceAccess;
  saveVerdict?: (body: { status: 'approved' | 'changes-requested'; issues: PartsIssue[]; binding?: string }) => Promise<{ ok: boolean; error?: string; verdict?: { source: { sha256: string } } }>;
  exportVerdict?: (format: 'json' | 'issue', data: ViewData) => Promise<void>;
}

export interface PartsWorkspaceHandle {
  dispose(): void;
  select(part: string): void;
  ready: Promise<void>;
  issues(): PartsIssue[];
  snapshot(): StagePartsState | null;
  restore(saved: StagePartsState): Promise<void>;
  revalidate(nextBuild?: string, savedState?: StagePartsState | null): Promise<void>;
}

/** Page pixels shown around a region in its own view, so the packer's bleed and padding are visible. */
export const REGION_MARGIN = 4;

function ensureSlotMarkup(slots: Partial<Record<PanelSlot, HTMLElement>>, query: <T extends Element = HTMLElement>(sel: string) => T | null): void {
  const doc = typeof globalThis.document !== 'undefined' ? globalThis.document : null;
  if (!doc || typeof doc.createElement !== 'function') return;
  if (slots.left && !query('#pv-items')) {
    const title = doc.createElement('h2'); title.id = 'pv-list-title'; title.textContent = t('PARTS');
    const ul = doc.createElement('ul'); ul.id = 'pv-items'; ul.setAttribute('data-pv-items', '');
    slots.left.append(title, ul);
  }
  if (slots.toolbar && !query('#pv-assemble')) {
    slots.toolbar.classList?.add?.('pv-toolbar');
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
  if (slots.stage && !query('#stage-layout')) {
    const wrap = doc.createElement('div'); wrap.className = 'pv-canvas-wrap'; wrap.id = 'stage-layout';
    const box = doc.createElement('div'); box.className = 'pv-canvas-box'; box.id = 'pv-canvas-box';
    const canvas = doc.createElement('canvas'); canvas.id = 'pv-canvas'; canvas.setAttribute('data-pv-canvas', ''); canvas.width = 1; canvas.height = 1;
    const overlay = doc.createElement('div'); overlay.id = 'pv-overlay'; overlay.className = 'pv-overlay';
    box.append(canvas, overlay); wrap.append(box);
    const caption = doc.createElement('p'); caption.id = 'pv-caption'; caption.className = 'pv-subtle';
    slots.stage.append(wrap, caption);
  }
  if (slots.side && !query('#pv-flags')) {
    const flagsSec = doc.createElement('section');
    const flagsH2 = doc.createElement('h2'); flagsH2.textContent = t('PRODUCER FLAGS');
    const flagsUl = doc.createElement('ul'); flagsUl.id = 'pv-flags'; flagsUl.setAttribute('data-pv-flags', '');
    const flagsSources = doc.createElement('p'); flagsSources.id = 'pv-flag-sources'; flagsSources.className = 'pv-subtle';
    flagsSec.append(flagsH2, flagsUl, flagsSources);
    const verdictSec = doc.createElement('section'); verdictSec.className = 'pv-verdict';
    const verdictH2 = doc.createElement('h2'); verdictH2.textContent = t('VERDICT');
    const hint = doc.createElement('p'); hint.id = 'parts-correction-hint'; hint.className = 'subtle'; hint.hidden = true;
    const legacyUl = doc.createElement('ul'); legacyUl.id = 'pv-legacy-flagged'; legacyUl.className = 'pv-legacy-flagged'; legacyUl.hidden = true;
    const saveBtn = doc.createElement('button'); saveBtn.id = 'pv-save'; saveBtn.type = 'button'; saveBtn.className = 'pv-primary'; saveBtn.textContent = t('Save sign-off');
    const expSpan = doc.createElement('span');
    const expJson = doc.createElement('button'); expJson.id = 'pv-export-json'; expJson.type = 'button'; expJson.textContent = t('Export JSON');
    const expIssue = doc.createElement('button'); expIssue.id = 'pv-export-issue'; expIssue.type = 'button'; expIssue.textContent = t('Export issue');
    expSpan.append(expJson, expIssue);
    const saveStatus = doc.createElement('p'); saveStatus.id = 'pv-save-status'; saveStatus.className = 'pv-subtle'; saveStatus.setAttribute('role', 'status');
    verdictSec.append(verdictH2, hint, legacyUl, saveBtn, expSpan, saveStatus);
    slots.side.append(flagsSec, verdictSec);
  }
}

export function mountPartsWorkspace(
  slots: Partial<Record<PanelSlot, HTMLElement>>,
  source: PartsSource,
  host: PartsHost,
  options: MountPartsWorkspaceOptions = {},
): PartsWorkspaceHandle {
  const slotRoots = (): HTMLElement[] => [slots.left, slots.stage, slots.toolbar, slots.side].filter((n): n is HTMLElement => Boolean(n));
  const appWrapper = (): HTMLElement | null => slots.stage?.closest?.('.pv-app') ?? slots.left?.closest?.('.pv-app') ?? null;
  const fallbackElements = new Map<string, HTMLElement>();
  const queryInRoots = <T extends Element = HTMLElement>(roots: HTMLElement[], selector: string): T | null => {
    for (const r of roots) {
      if (typeof r.matches === 'function' && r.matches(selector)) return r as unknown as T;
      const found = r.querySelector?.<T>(selector);
      if (found) return found;
    }
    return null;
  };
  const query = <T extends Element = HTMLElement>(selector: string): T | null => {
    const roots = slotRoots();
    const inSlots = queryInRoots<T>(roots, selector);
    if (inSlots) return inSlots;
    const wrapper = appWrapper();
    if (wrapper) {
      const inWrapper = queryInRoots<T>([wrapper], selector);
      if (inWrapper) return inWrapper;
    }
    if (!roots.length && typeof globalThis.document !== 'undefined') {
      return globalThis.document.querySelector?.<T>(selector) ?? null;
    }
    return null;
  };
  const queryAll = <T extends Element = HTMLElement>(selector: string): T[] => {
    const roots = slotRoots();
    if (roots.length) {
      const seen = new Set<T>();
      for (const r of roots) {
        if (typeof r.matches === 'function' && r.matches(selector)) seen.add(r as unknown as T);
        for (const el of r.querySelectorAll?.<T>(selector) ?? []) seen.add(el);
      }
      return [...seen];
    }
    return typeof globalThis.document !== 'undefined' ? [...(globalThis.document.querySelectorAll?.<T>(selector) ?? [])] : [];
  };
  ensureSlotMarkup(slots, query);
  const $ = <T extends HTMLElement>(id: string): T => {
    const found = query<T>(`#${id}`);
    if (found) return found;
    if (!slotRoots().length && typeof globalThis.document !== 'undefined') {
      const byId = globalThis.document.getElementById?.(id);
      if (byId) return byId as T;
    }
    if (!fallbackElements.has(id)) {
      const dummy = typeof globalThis.document?.createElement === 'function'
        ? globalThis.document.createElement('div')
        : ({ id, style: {}, dataset: {}, hidden: false, disabled: false, textContent: '', value: '', checked: false, replaceChildren() {}, append() {}, remove() {}, setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {}, getContext() { return null; } } as unknown as HTMLElement);
      dummy.id = id;
      fallbackElements.set(id, dummy);
    }
    return fallbackElements.get(id)! as T;
  };
  const disposers: (() => void)[] = [];
  let disposed = false;
  let pendingSelectPart: string | null = null;
  const roots = slotRoots();
  let mountActive = true;
  if (roots.length && typeof globalThis.document !== 'undefined' && typeof globalThis.document.addEventListener === 'function') {
    const updateActive = (e: Event) => {
      const tNode = e.target as Node | null;
      if (!tNode) return;
      const inThisMount = roots.some(r => r === tNode || r.contains?.(tNode));
      if (inThisMount) {
        mountActive = true;
      } else if ((tNode as HTMLElement).closest?.('[data-pv-items], .pv-canvas-wrap, .pv-toolbar, .pv-verdict')) {
        mountActive = false;
      }
    };
    globalThis.document.addEventListener('pointerdown', updateActive, true);
    globalThis.document.addEventListener('pointerover', updateActive, true);
    globalThis.document.addEventListener('focusin', updateActive, true);
    disposers.push(() => {
      globalThis.document.removeEventListener('pointerdown', updateActive, true);
      globalThis.document.removeEventListener('pointerover', updateActive, true);
      globalThis.document.removeEventListener('focusin', updateActive, true);
    });
  }
  const document = new Proxy((typeof globalThis.document !== 'undefined' ? globalThis.document : {}) as Document, {
    get(target, prop) {
      if (prop === 'getElementById') return (id: string) => query(`#${id}`);
      if (prop === 'querySelector') return (sel: string) => query(sel);
      if (prop === 'querySelectorAll') return (sel: string) => queryAll(sel);
      if (prop === 'addEventListener') {
        return (type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
          if (typeof target.addEventListener !== 'function') return;
          const wrapped: EventListener = (e: Event) => {
            if (disposed) return;
            if ((type === 'keydown' || type === 'keyup') && slotRoots().length && !mountActive) return;
            if (typeof listener === 'function') listener.call(target, e);
            else listener.handleEvent(e);
          };
          target.addEventListener(type, wrapped, opts);
          disposers.push(() => target.removeEventListener?.(type, wrapped, opts));
        };
      }
      const val = Reflect.get(target, prop);
      return typeof val === 'function' ? val.bind(target) : val;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });
  const window = new Proxy((typeof globalThis.window !== 'undefined' ? globalThis.window : {}) as Window & typeof globalThis, {
    get(target, prop) {
      if (prop === 'addEventListener') {
        return (type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
          if (typeof target.addEventListener !== 'function') return;
          target.addEventListener(type, listener, opts);
          disposers.push(() => target.removeEventListener?.(type, listener, opts));
        };
      }
      const val = Reflect.get(target, prop);
      return typeof val === 'function' ? val.bind(target) : val;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  });

  const access: InstanceAccess = options.access ?? {
    base: '/',
    key: 'direct',
    capability: null,
    route: (path: string) => path,
    headers: (init?: HeadersInit) => new Headers(init),
  };
  const stageEmbedded = Boolean(options.stageEmbedded);
  const stageSide = options.stageSide ?? null;
  let stageBuild = options.stageBuild ?? 'inspected';
  const stageRestore: StagePartsState | null = options.initialRestore ?? null;
  const sourceReady = options.sourceReady ?? Promise.resolve();
  const stageHeaders = () => access.headers(stageEmbedded ? { 'X-Review-Stage-Build': stageBuild } : {});
  const partsApi = stageEmbedded ? (stageSide === 'a' || stageSide === 'b' ? `/api/compare/${stageSide}/stage-parts` : '/api/stage-parts') : '/api/parts';

  const state = { data: null as ViewData | null, selected: 0, zoom: 1, bg: 'green', alpha: false, footprints: false, comparison:defaultPartsComparison(), differenceThreshold:0, hidden: new Set<string>(), view: 'item' as 'item' | 'page' | 'assembled', page: 0, meshShown: new Set<string>() };
  const comments:PartsIssue[]=[];let commentUi:ReturnType<typeof bindStageComments>|null=null;let viewport:ReturnType<typeof createPartsViewport>|null=null;let painting=false;
  const images = new Map<string, HTMLImageElement>();
  const objectUrls = new Set<string>();

  const decodeBlobToImage = async (src: string, blob: Blob | null): Promise<HTMLImageElement> => {
    if (!blob) throw new Error('PARTS_PAINT_FAILED');
    if (typeof Image === 'undefined') {
      const stub = { width: 1, height: 1, src } as unknown as HTMLImageElement;
      images.set(src, stub);
      return stub;
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const dataUrl = `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { images.set(src, img); resolve(img); };
      img.onerror = () => reject(new Error(src));
      img.src = dataUrl;
    });
  };

  function load(src: string): Promise<HTMLImageElement> {
    const cached = images.get(src);
    if (cached) return Promise.resolve(cached);
    const imageMatch = /\/image\/(\d+)$/.exec(src);
    if (imageMatch && typeof source?.image === 'function') {
      const item = state.data?.items[Number(imageMatch[1])];
      if (!item) return Promise.reject(new Error('PARTS_PAINT_FAILED'));
      return source.image(item.name).then(blob => decodeBlobToImage(src, blob));
    }
    const pageMatch = /\/page\/(\d+)$/.exec(src);
    if (pageMatch && typeof source?.page === 'function') {
      const page = state.data?.pages[Number(pageMatch[1])];
      if (!page) return Promise.reject(new Error('PARTS_PAINT_FAILED'));
      return source.page(page.name).then(blob => decodeBlobToImage(src, blob));
    }
    if (src === '/api/parts/painting' && typeof source?.painting === 'function') {
      return source.painting().then(blob => decodeBlobToImage(src, blob));
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { images.set(src, img); resolve(img); };
      img.onerror = () => reject(new Error(src));
      if(stageEmbedded)void fetch(access.route(src),{headers:stageHeaders()}).then(async res=>{if(!res.ok)throw new Error('STAGE_DRAFT_CHANGED');const url=URL.createObjectURL(await res.blob());objectUrls.add(url);img.addEventListener('load',()=>{URL.revokeObjectURL(url);objectUrls.delete(url);},{once:true});img.src=url;}).catch(reject);
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
    if (typeof source !== 'undefined' && typeof source?.difference === 'function') {
      const diff = await source.difference(item.name, state.comparison.threshold, state.footprints);
      const image = await createImageBitmap(diff.png);
      try {
        if (token !== paintToken) return;
        const ctx = setCanvas(canvas, w, h); paintBackground(ctx, w, h, state.bg); ctx.drawImage(image, 0, 0); overlay.replaceChildren();
        caption.textContent = t('Difference: {count} pixels above threshold · {covered} covered pixels excluded · visual comparison, no automatic verdict.', { count: String(diff.count), covered: String(diff.covered) });
      } finally { image.close(); }
      return;
    }
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
 const overlayButton=document.querySelector<HTMLButtonElement>('[data-pv-comparison="overlay"]');if(overlayButton)overlayButton.disabled=!state.data?.painting;
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
  const issueList = typeof comments !== 'undefined' ? comments : [];
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
    const issueCount = issueList.filter(c => Array.isArray(c.parts) ? c.parts.some(p => p.name === item.name) : (c as unknown as PartsComment).part === item.name).length;
    const badge = document.createElement('span'); badge.className = 'pv-badge'; badge.dataset.issues = String(issueCount); badge.textContent = issueCount ? String(issueCount) : '';
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

function renderMesh(): void {
  document.getElementById('pv-mesh-panel')?.remove();
  document.getElementById('pv-mesh-control')?.remove();
  const item = state.data!.items[state.selected]!;
  if (!item.mesh) return;
  const control = document.createElement('label'); control.id = 'pv-mesh-control'; control.className = 'pv-field';
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = state.meshShown.has(item.name); toggle.disabled=state.comparison.mode!=='part'||state.view==='assembled';
  toggle.onchange = () => { if (toggle.checked) state.meshShown.add(item.name); else state.meshShown.delete(item.name); void paint(); };
  control.append(toggle, t('mesh from rig.json UVs')); document.querySelector('.pv-toolbar')?.append(control);
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
  document.querySelector('.pv-verdict')?.before(panel);
}

function select(index: number): void {
  queueMicrotask(renderCorrections);
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
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-pv-view]')) b.setAttribute('aria-pressed', String(b.dataset.pvView === view));
  void paint();
}

function renderLegacyVerdict(): void {
  const legacy = state.data?.legacyVerdict;
  const list = document.getElementById('pv-legacy-flagged') as HTMLElement | null;
  if (!list) return;
  if (!legacy) {
    list.hidden = true;
    list.replaceChildren();
    return;
  }
  list.hidden = !legacy.flaggedParts.length;
  list.replaceChildren(...legacy.flaggedParts.map(fp => {
    const li = document.createElement('li');
    li.dataset.legacyFlaggedPart = fp.name;
    li.textContent = fp.note ? fp.name + ': ' + fp.note : fp.name;
    return li;
  }));
}

async function save(): Promise<void> {
  const data=state.data;
  if(!data||data.legacyVerdict?.readOnly||(typeof host!=='undefined'&&host?.locked?.())||stageEmbedded&&(!data.joinedVerdictBinding||!access.capability||stageBuild!=='inspected'))return;
  const status = $('pv-save-status'),button=$<HTMLButtonElement>('pv-save');
  const body = { status: (comments.length === 0 ? 'approved' : 'changes-requested') as 'approved' | 'changes-requested', issues: [...comments],
    ...(stageEmbedded?{binding:data.joinedVerdictBinding}:{}) };
  button.disabled=true;
  try{
    const out = typeof options !== 'undefined' && options?.saveVerdict
      ? await options.saveVerdict(body)
      : await (async () => {
          const headers=stageEmbedded?stageHeaders():access.headers();headers.set('Content-Type','application/json');
          const res = await fetch(access.route(stageEmbedded?partsApi+'/verdict':'/api/parts/verdict'), { method: 'POST', headers, body: JSON.stringify(body) });
          return { ok: res.ok, ...(await res.json() as { error?: string; verdict?: { source: { sha256: string } } }) };
        })();
    status.textContent = out.ok ? t('Saved {file}: source {hash}.', { file: data.verdictFile, hash: out.verdict!.source.sha256.slice(0, 12) }) : out.error ? t(out.error) : t('Save failed.');
    status.dataset.result = out.ok ? 'saved' : 'refused';
  }catch{
    status.textContent=t('Save failed.');status.dataset.result='refused';
  }finally{button.disabled=false;}
}

async function boot(): Promise<void> {
  const box=$('pv-canvas-box'),layout=$('stage-layout');mountViewportPair(layout);$('rig-root').append(box);const reference=document.createElement('canvas');reference.id='pv-reference';$('reference-content').append(reference);$('rig-empty').hidden=true;$('rig-overlay').hidden=true;$('rig-label').textContent=t('Selected part');$('rig-viewport').tabIndex=0;
  viewport=createPartsViewport({el:$,canvas:$<HTMLCanvasElement>('pv-canvas'),message:(msg)=>{$('pv-save-status').textContent=t(msg);host?.message?.(t(msg));},reference:()=>state.data?.painting?$<HTMLCanvasElement>('pv-reference'):null,
    frameSize:target=>{
      const data=state.data,item=data?.items[state.selected];
      if(!data||!item||paintReset)return null;
      if(paintFailure)return {w:0,h:0};
      return target==='rig'?rasterFrame(data,item)??{w:0,h:0}:data.painting?partFrame(data,item):null;
    },
  });viewport.bindControls();
  $('native-one').onclick=()=>viewport!.cameraAction(()=>viewport!.updateCamera(viewport!.availableCamera()??'rig',{zoom:1,pan:{x:0,y:0}}));
  if(stageEmbedded){
    const header=document.querySelector<HTMLElement>('.pv-top'),status=$('pv-load');
    if(header){header.hidden=true;status.classList.add('pv-embedded-status');header.after(status);}
    const pvLayout=document.querySelector<HTMLElement>('.pv-layout');if(pvLayout)pvLayout.hidden=true;
    const pvVerdict=document.querySelector<HTMLElement>('.pv-verdict');if(pvVerdict)pvVerdict.hidden=true;
    const saveButton=$<HTMLButtonElement>('pv-save');saveButton.disabled=true;
  }
  host.register?.({
    kind: 'parts-verdict',
    value: (words = '') => ({
      verdict: comments.length === 0 ? 'approved' : 'changes-requested',
      issues: [...comments],
      words,
    }),
  });
  if(stageEmbedded)await sourceReady;
  if (disposed) return;
  let data: ViewData & { error?: string };
  try {
    data = await source.view();
  } catch (err) {
    const status = $('pv-load');
    status.textContent = t(err instanceof Error ? err.message : 'Save failed.');
    status.dataset.result = 'refused';
    return;
  }
  if (disposed) return;
  if (data.error) { const status=$('pv-load');status.textContent=t(data.error);status.dataset.result='refused';return; }
  state.data = data;if(!data.differenceAvailable)document.querySelector('[data-pv-comparison="difference"]')?.remove();if(stageEmbedded)for(const item of data.items)if(item.mesh)state.meshShown.add(item.name);$('reference-empty').textContent=data.painting?'':t('PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');$('reference-empty').hidden=!!data.painting;if(data.painting)viewport.state.cameraSync=true;
  const initialIssues = data.verdict?.issues ?? data.legacyVerdict?.issues ?? (data.verdict?.comments ?? []).map(c => parsePartsIssue(c, true, true, false));
  comments.push(...initialIssues);
  setupPartsComments();const ro=viewport.observeResize();disposers.push(viewport.bindNavigation(undefined,()=>!commentUi?.active()&&!paintFailure),()=>ro.disconnect());
  if(stageEmbedded&&data.joinedVerdictBinding){
    const pvVerdict=document.querySelector<HTMLElement>('.pv-verdict');if(pvVerdict)pvVerdict.hidden=false;
    const saveBtn=$<HTMLButtonElement>('pv-save');
    saveBtn.disabled=!access.capability||Boolean(data.legacyVerdict?.readOnly)||host.locked();
    if(!access.capability)saveBtn.title=t('Read-only view: reopen with rig-review open to edit.');
  }
  if(data.legacyVerdict?.readOnly||host.locked()){
    $<HTMLButtonElement>('pv-save').disabled=true;
  }
  const correctionHint = document.getElementById('parts-correction-hint');
  if (correctionHint) correctionHint.hidden = data.mode !== 'parts' || stageEmbedded;
  renderLegacyVerdict();
  const legacyBanner = data.legacyVerdict ? data.legacyVerdict.code + ': ' + t('parts.legacyVerdictBanner', [data.legacyVerdict.flaggedCount]) : '';
  if (typeof globalThis.document !== 'undefined' && !slotRoots().length) globalThis.document.title = data.title;
  $('pv-title').textContent = data.title;
  $('pv-mode').textContent = data.mode === 'parts' ? t('Parts package, before rigging') : t('Atlas of a built rig');
  $('pv-list-title').textContent = data.mode === 'parts' ? t('PARTS') : t('REGIONS');
  $('pv-load').textContent = data.verdictStale === 'files' ? t('A saved sign-off was made on other files; this review starts fresh.') : data.verdictStale === 'flags' ? t('The saved sign-off is for different producer flags; this review starts fresh.') : legacyBanner ? legacyBanner : data.verdict ? t('Saved sign-off loaded.') : data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';
  if (legacyBanner) $('pv-load').dataset.result = 'readonly';
  if(stageEmbedded){$('pv-load').hidden=$('pv-load').textContent==='';const pvLayout=document.querySelector<HTMLElement>('.pv-layout');if(pvLayout)pvLayout.hidden=false;}
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
  $('pv-save').onclick = () => { void save(); };
  for(const format of ['json','issue'] as const)$('pv-export-'+format).onclick=async()=>{
    if (options.exportVerdict) { await options.exportVerdict(format, data); return; }
    const res=await fetch(access.route(stageEmbedded?partsApi+'/export/'+format:'/api/parts/export?format='+format),{headers:stageHeaders()});const value=await res.text();if(!res.ok){$('pv-save-status').textContent=JSON.parse(value).error??t('Save failed.');return;}const url=URL.createObjectURL(new Blob([value],{type:format==='json'?'application/json':'text/markdown'})),a=document.createElement('a');a.href=url;a.download=stageEmbedded?(format==='json'?data.verdictFile:data.verdictFile.replace(/\.json$/,'.md')):format==='json'?'parts-review-export.json':'parts-review-export.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const offLang = onLanguageChange(() => { if (!disposed && state.data) select(state.selected); });
  disposers.push(offLang);
  if(stageEmbedded && typeof window !== 'undefined')(window as StagePartsWindow).rigReviewStageParts={snapshot:stagePartsSnapshot};
  if(data.items.length){
    if(stageRestore)await restoreStageParts(stageRestore);
    else if(pendingSelectPart){const idx=data.items.findIndex(i=>i.name===pendingSelectPart);select(idx>=0?idx:0);}
    else select(0);
  }
  renderCorrections();
  if (typeof globalThis.document !== 'undefined' && globalThis.document.body) globalThis.document.body.dataset.ready = 'true';
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
  const layers=data.items.flatMap(box=>{const img=images.get(`${partsApi}/image/${box.index}`);return img?[{box,alpha:sourceAlpha(box,img)}]:[];});
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
 create:async(p,_view,screen,crop,_bookmark,summary)=>{const r=snapImageRegion(region(unprojectMark(screen,p.camera),unprojectMark({x:screen.x+screen.width,y:screen.y+screen.height},p.camera)));const c:PartsIssue={schema:'rig-review-parts-comment/2',id:crypto.randomUUID(),summary,parts:[{name:p.item.name,imageHash:p.item.imageHash!}],sourceHash:p.sourceHash,imageRegion:r,rigRegion:{...r,x:p.item.x+r.x,y:p.item.y+r.y},view:{...p.view,mode:'item'},crop,nativeCrop:null};if(typeof source!=='undefined'&&typeof source?.crop==='function')return parsePartsIssue(await source.crop(c),true,true,false);const res=await fetch(access.route('/api/parts/comment'),{method:'POST',headers:access.headers({'Content-Type':'application/json'}),body:JSON.stringify(c)}),out=await res.json() as {comment:PartsIssue;error?:string};if(!res.ok)throw new Error(out.error);return parsePartsIssue(out.comment,true,true,false);}
 };
 const pose=():PartsPose|null=>{const data=state.data,item=data?.items[state.selected],camera=viewport?.numericView().cameras.rig;if(!data||!item||!camera||data.mode!=='parts'||state.view!=='item')return null;return {mode:'parts',camera,item:{...item},sourceHash:data.sourceHash,view:{mode:'item',camera:{zoom:camera.zoom,center:{...camera.center},viewport:{...camera.viewport}},cameraSync:viewport!.state.cameraSync,referenceCamera:(()=>{const c=viewport!.numericView().cameras.reference;return c?{zoom:c.zoom,center:{...c.center},viewport:{...c.viewport}}:null;})(),background:state.bg,alpha:state.alpha,footprints:state.footprints,mesh:state.meshShown.has(item.name),comparison:{...state.comparison}},capture:{pane:$('rig-viewport'),root:$('rig-root'),images:true,canvas:$<HTMLCanvasElement>('pv-canvas'),backend:'canvas2d',nearest:true}};};
 const toolbarEl = document.querySelector<HTMLElement>('.pv-toolbar') ?? $('stage-comment').parentElement ?? $('rig-viewport');
 const toggleEl = $('stage-comment') as HTMLButtonElement;
 const rawDoc = typeof globalThis.document !== 'undefined' ? globalThis.document : null;
 const origGetById = rawDoc?.getElementById;
 if (rawDoc && toggleEl) {
  rawDoc.getElementById = ((id: string) => id === 'stage-comment' ? toggleEl : origGetById?.call(rawDoc, id) ?? null) as typeof document.getElementById;
 }
 try {
  commentUi=bindStageComments({toolbar:toolbarEl,viewports:{rig:$('rig-viewport')},pose,pause:async()=>{},bookmark:()=>null,
  restore:async(raw)=>{const current:ViewData&{error?:string}=typeof source!=='undefined'&&typeof source?.view==='function'?await source.view().catch((e:unknown)=>({error:e instanceof Error?e.message:String(e)} as ViewData&{error?:string})):await (async()=>{const res=await fetch(access.route(partsApi),{headers:stageHeaders()});const json=await res.json() as ViewData&{error?:string};return res.ok?json:{...json,error:json.error??'PARTS_COMMENT_STALE_SOURCE'};})();if(current.error||current.sourceHash!==state.data?.sourceHash)throw new Error(current.error??'PARTS_COMMENT_STALE_SOURCE');const b=raw as {part:string;imageHash:string;sourceHash:string;view:PartsIssue['view']},item=state.data!.items.find(i=>i.name===b.part);if(!item||item.imageHash!==b.imageHash||state.data!.sourceHash!==b.sourceHash)throw new Error('PARTS_COMMENT_STALE_SOURCE: reopen the bound source');setView('item');$('pv-assemble').setAttribute('aria-pressed','false');select(item.index);state.bg=b.view.background;state.alpha=b.view.alpha;state.footprints=b.view.footprints;state.comparison={...(b.view.comparison??defaultPartsComparison())};if(state.comparison.mode==='difference')state.differenceThreshold=state.comparison.threshold;renderComparison();if(b.view.mesh)state.meshShown.add(item.name);else state.meshShown.delete(item.name);$<HTMLSelectElement>('pv-bg').value=state.bg;$<HTMLInputElement>('pv-alpha').checked=state.alpha;$<HTMLInputElement>('pv-footprints').checked=state.footprints;renderMesh();viewport!.state.cameraRestoring=true;try{await paint();if(!paintFailure){viewport!.writeCamera('rig',{zoom:b.view.camera.zoom,center:{...b.view.camera.center}});if(b.view.referenceCamera)viewport!.writeCamera('reference',{zoom:b.view.referenceCamera.zoom,center:{...b.view.referenceCamera.center}});viewport!.state.cameraSync=b.view.cameraSync;viewport!.fitCamera();}}finally{viewport!.state.cameraRestoring=false;}},
  feedback:()=>comments,locked:()=>Boolean(state.data?.legacyVerdict?.readOnly)||(typeof host!=='undefined'&&Boolean(host?.locked?.())),add:c=>comments.push(c),changed:()=>{renderList();if(typeof host!=='undefined')host?.changed?.([...comments]);},error:m=>{$('pv-save-status').textContent=t(m);if(typeof host!=='undefined')host?.message?.(t(m));},blocked:()=>painting,refusal:()=>paintFailure??(state.data?.legacyVerdict?.readOnly?state.data.legacyVerdict.code+': '+t('parts.legacyVerdictBanner',[state.data.legacyVerdict.flaggedCount]):null)??(typeof host!=='undefined'&&host?.locked?.()?'Read-only view: reopen with rig-review open to edit.':null)??(state.view==='assembled'?'PARTS_COMMENT_UNAVAILABLE: select the individual part view to comment':null)??(state.data?.mode!=='parts'||stageEmbedded?'PARTS_COMMENT_UNAVAILABLE: original part image required':null),codec});
 } finally {
  if (rawDoc && origGetById) rawDoc.getElementById = origGetById;
 }
}

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
   const pvVerdict=document.querySelector<HTMLElement>('.pv-verdict');if(pvVerdict)pvVerdict.hidden=!data.joinedVerdictBinding;
   const status=$('pv-load');status.textContent=data.verdictReadOnlyReason?t(data.verdictReadOnlyReason):'';status.hidden=status.textContent==='';delete status.dataset.result;
  }
  if(savedState)await restoreStageParts(savedState);else if(!sameBuild){select(state.selected);await paint();}
  renderCorrections();
 }catch(error){
  const pvVerdict=document.querySelector<HTMLElement>('.pv-verdict');if(pvVerdict)pvVerdict.hidden=true;if(state.data)delete state.data.joinedVerdictBinding;
  const status=$('pv-load');status.hidden=false;status.dataset.result='refused';status.textContent=t(error instanceof Error?error.message:String(error));
  const pvLayout=document.querySelector<HTMLElement>('.pv-layout');if(pvLayout)pvLayout.hidden=true;
 }
}

  const ready = boot();
  return {
    ready,
    dispose(): void {
      disposed = true;
      paintToken++;
      commentUi?.dispose();
      commentUi = null;
      for (const dispose of disposers.splice(0)) dispose();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      images.clear();
      assemblyAlpha.clear();
    },
    select(part: string): void {
      pendingSelectPart = part;
      const idx = state.data?.items.findIndex(i => i.name === part) ?? -1;
      if (idx >= 0) select(idx);
    },
    issues(): PartsIssue[] {
      return [...comments];
    },
    snapshot(): StagePartsState | null {
      return stagePartsSnapshot();
    },
    restore(saved: StagePartsState): Promise<void> {
      return restoreStageParts(saved);
    },
    revalidate(nextBuild?: string, savedState?: StagePartsState | null): Promise<void> {
      return revalidateStageParts(nextBuild, savedState);
    },
  };
}
