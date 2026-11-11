import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {jobPublicationRoutes} from '../web/job-session.ts';

const partsSource = readFileSync(new URL('../web/parts.ts', import.meta.url), 'utf8');
const jobSource = readFileSync(new URL('../web/job-session.ts', import.meta.url), 'utf8');

function productFunction(name: string, scope: Record<string, unknown>, source = partsSource) {
  const tree = ts.createSourceFile('product.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(tree) === name) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(matches).toHaveLength(1);
  const node = matches[0]!;
  const code = ts.isMethodDeclaration(node) ? node.getText(tree).replace(/^async /, 'async function ') : node.getText(tree);
  const compiled = new Bun.Transpiler({loader: 'ts', target: 'bun'}).transformSync(code);
  return new Function('scope', `with(scope){${compiled};return ${name};}`)(scope);
}

class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  id = '';
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  title = '';
  classList = {
    add: (value: string) => {this.className = [...new Set([...this.className.split(' ').filter(Boolean), value])].join(' ');},
    remove: (value: string) => {this.className = this.className.split(' ').filter(item => item !== value).join(' ');},
  };
  constructor(public tag = 'div', public ownerDocument?: {createElement(tag: string): Element}) {}
  append(...nodes: (Element | string)[]) {
    for (const node of nodes) {
      if (typeof node === 'string') this.children.push(Object.assign(new Element('#text'), {textContent: node}));
      else this.children.push(node);
    }
  }
  setAttribute(name: string, value: string) {this.attributes[name] = value;}
  removeAttribute(name: string) {delete this.attributes[name];}
}

const descendants = (node: Element): Element[] => [node, ...node.children.flatMap(descendants)];
const message = (key: string, values: Record<string, unknown> = {}) => key.replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));

test('#645 existing parts markup separates named toolbar rows and keeps the comment control in the sidebar in EN/KO', () => {
  for (const catalog of [enCatalog, koCatalog]) {
    const doc = {createElement: (tag: string): Element => new Element(tag, doc)};
    const slots = Object.fromEntries(['left', 'stage', 'toolbar', 'side'].map(name => [name, new Element('div', doc)])) as Record<string, Element>;
    slots.toolbar!.className = 'pv-toolbar';
    slots.toolbar!.setAttribute('role', 'toolbar');
    slots.toolbar!.setAttribute('aria-label', 'View');
    productFunction('mountPartsMarkup', {t: (key: string) => catalog[key] ?? key})(slots);
    const rows = slots.toolbar!.children;
    expect(rows).toHaveLength(2);
    expect(slots.toolbar!.attributes.role).toBeUndefined();
    expect(rows.map(row => row.attributes.role)).toEqual(['toolbar', 'toolbar']);
    expect(rows.map(row => row.attributes['aria-label'])).toEqual([catalog['Main toolbar'], catalog['Secondary toolbar']]);
    expect(rows.map(row => row.textContent)).toEqual(['', '']);
    const ids = (root: Element) => descendants(root).map(node => node.id).filter(Boolean);
    expect(ids(rows[0]!)).toContain('pv-comparison');
    expect(ids(rows[0]!)).toContain('fit');
    expect(ids(rows[0]!)).toContain('native-one');
    expect(ids(rows[1]!)).toContain('pv-bg');
    expect(ids(rows[1]!)).toContain('pv-threshold');
    expect(ids(rows[1]!)).toContain('camera-sync');
    expect(ids(slots.toolbar!)).not.toContain('stage-comment');
    expect(ids(slots.side!)).toContain('stage-comment');
  }
});

function rasterCaller() {
  const requests: unknown[][] = [];
  const assemblies: {width: number; height: number; layers: {box: {index: number}; image: unknown}[]; options: unknown}[] = [];
  const closed: number[] = [];
  const caption = {textContent: ''};
  const canvas = {width: 0, height: 0};
  const ctx = {drawImage() {}};
  const state = {
    data: {mode: 'parts', rigSize: [32, 24], items: [
      {name: 'body', index: 0, x: 4, y: 4, w: 20, h: 16},
      {name: 'front', index: 1, x: 14, y: 8, w: 8, h: 10},
    ], painting: null},
    view: 'assembled', selected: 0, hidden: new Set<string>(),
    comparison: {mode: 'difference', threshold: 16, opacity: .5}, footprints: false, meshVisible: false, bg: 'checker', alpha: false,
  };
  const scope: Record<string, any> = {
    state, disposed: false, paintToken: 1, paintingHeld: false,
    $: (id: string) => id === 'pv-canvas' ? canvas : id === 'pv-caption' ? caption : {replaceChildren() {}},
    rasterFrame: () => ({x: 0, y: 0, w: 32, h: 24}),
    itemImage: async (item: {index: number}) => ({original: item.index}),
    setCanvas: (_canvas: unknown, width: number, height: number) => {canvas.width = width; canvas.height = height; return ctx;},
    paintAssembly: (_ctx: unknown, width: number, height: number, layers: typeof assemblies[number]['layers'], options: unknown) => {assemblies.push({width, height, layers, options});},
    drawMeshes() {}, renderAssemblySelection() {}, paintBackground() {}, t: message,
    source: {difference: async (index: number, threshold: number, footprints: boolean) => {
      requests.push([index, threshold, footprints]);
      return new Response(String(index), {headers: {'X-Difference-Count': '81', 'X-Difference-Covered': '0'}});
    }},
    createImageBitmap: async (blob: Blob) => {const index = Number(await blob.text()); return {index, close: () => closed.push(index)};},
  };
  scope.differenceImage = productFunction('differenceImage', scope);
  return {scope, state, requests, assemblies, closed, caption, canvas, paint: productFunction('paintRaster', scope)};
}

test('#645 assembled Difference requests every visible original part and reuses the existing ordered assembly renderer', async () => {
  const caller = rasterCaller();
  await caller.paint(1);
  expect(caller.requests).toEqual([[0, 16, false], [1, 16, false]]);
  expect(caller.assemblies).toHaveLength(1);
  const drawn = caller.assemblies[0]!;
  expect([drawn.width, drawn.height]).toEqual([32, 24]);
  expect(drawn.layers.map(layer => layer.box.index)).toEqual([0, 1]);
  expect(drawn.layers.map(layer => layer.image)).toEqual([
    {index: 0, close: expect.any(Function)}, {index: 1, close: expect.any(Function)},
  ]);
  expect(drawn.options).toEqual({bg: 'checker', alpha: false});
  expect(caller.closed).toEqual([0, 1]);
  expect(caller.caption.textContent).toBe('Difference across 2 visible parts.');
});

test('#645 assembled Difference honors visibility and original footprint settings without a global pixel-count claim', async () => {
  const caller = rasterCaller();
  caller.state.hidden.add('front');
  caller.state.footprints = true;
  await caller.paint(1);
  expect(caller.requests).toEqual([[0, 16, true]]);
  expect(caller.assemblies[0]!.layers.map(layer => layer.box.index)).toEqual([0]);
  expect(caller.caption.textContent).toBe('Difference across 1 visible parts.');
});

test('#645 assembled Difference closes decoded images on source failure and never paints a partial result', async () => {
  const caller = rasterCaller();
  caller.scope.source.difference = async (index: number) => index === 0
    ? new Response('0') : Response.json({error: 'PARTS_DIFFERENCE_ALIGNMENT'}, {status: 400});
  await expect(caller.paint(1)).rejects.toThrow('PARTS_DIFFERENCE_ALIGNMENT');
  expect(caller.closed).toEqual([0]);
  expect(caller.assemblies).toHaveLength(0);
});

test('#645 an assembly with every part hidden paints only its background and fetches no Difference image', async () => {
  const caller = rasterCaller();
  caller.state.hidden.add('body');
  caller.state.hidden.add('front');
  await caller.paint(1);
  expect(caller.requests).toHaveLength(0);
  expect(caller.assemblies).toHaveLength(1);
  expect(caller.assemblies[0]!.layers).toEqual([]);
  expect(caller.caption.textContent).toBe('Difference across 0 visible parts.');
});

test('#645 superseded assembled Difference stops fetching and closes its already-decoded image', async () => {
  const caller = rasterCaller();
  caller.scope.source.difference = async (index: number) => {
    caller.requests.push([index]);
    caller.scope.paintToken = 2;
    return new Response(String(index));
  };
  await caller.paint(1);
  expect(caller.requests).toEqual([[0]]);
  expect(caller.closed).toEqual([0]);
  expect(caller.assemblies).toHaveLength(0);
});

test('#645 selected-part Difference retains the existing numeric caption and bitmap lifetime', async () => {
  const caller = rasterCaller();
  caller.state.view = 'item';
  await caller.paint(1);
  expect(caller.requests).toEqual([[0, 16, false]]);
  expect(caller.closed).toEqual([0]);
  expect(caller.caption.textContent).toContain('81 pixels above threshold');
  expect(caller.assemblies).toHaveLength(0);
});

test('#645 assembled comparison remains selectable only with a declared operand and a live Difference callback', () => {
  const nodes = new Map<string, Element>();
  const $ = (id: string) => {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!;};
  const difference = new Element(), overlay = new Element();
  const state: Record<string, any> = {data: {mode: 'parts', differenceAvailable: true, painting: null}, view: 'assembled', comparison: {mode: 'difference', threshold: 16}, differenceThreshold: 16};
  const source: Record<string, any> = {difference() {}};
  const scope = {state, source, $, t: message, query: (selector: string) => selector.includes('"difference"') ? difference : overlay, queryAll: () => []};
  const render = productFunction('renderComparison', scope);
  render();
  expect(difference.disabled).toBe(false);
  expect($('pv-threshold-control').hidden).toBe(false);
  delete source.difference;
  render();
  expect(difference.disabled).toBe(true);
  expect(difference.title).toContain('Difference route required');
  source.difference = () => {};
  state.data.differenceAvailable = false;
  render();
  expect(difference.disabled).toBe(true);
});

test('#645 changing from selected part to assembly preserves Difference and keeps shared camera ownership', () => {
  const caller = rasterCaller();
  caller.state.view = 'item';
  const writes: unknown[] = [];
  const nodes = new Map<string, Element>();
  Object.assign(caller.scope, {
    paintFailure: null, viewport: {writeCamera: (...args: unknown[]) => writes.push(args)}, hoverName: null,
    $: (id: string) => {if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!;},
    renderMesh() {}, renderComparison() {}, commentUi: {refresh() {}}, queryAll: () => [], paint() {},
  });
  productFunction('setView', caller.scope)('assembled');
  expect(caller.state.comparison.mode).toBe('difference');
  expect(caller.state.view).toBe('assembled');
  expect(writes).toEqual([['rig', {zoom: 1, center: null}], ['reference', {zoom: 1, center: null}]]);
});

function liveDifference() {
  const prepared = {}, lifetime = new AbortController(), calls: {url: string; init: RequestInit}[] = [];
  const key = 'a'.repeat(64), origin = 'http://127.0.0.1:4317';
  const entry = `/jobs/parts-fixture/publications/parts-publication/instances/${key}/`;
  const display = {publication: {publicationId: 'parts-publication', instanceKey: key},
    routes: {entry, apiBase: entry + 'api/', assetsBase: entry + 'assets/'}} as Parameters<typeof jobPublicationRoutes>[0];
  const routes = jobPublicationRoutes(display, origin);
  const scope: Record<string, any> = {
    prepared, current: prepared, lifetime, routes,
    access: {headers: () => ({'X-Review-Capability': 'fixture'})},
    fetch: async (url: string, init: RequestInit) => {calls.push({url, init}); return new Response('png');},
  };
  return {scope, lifetime, calls, routes, display, origin, read: productFunction('difference', scope, jobSource)};
}

test('#645 live host Difference uses the publication-pinned route, capability and cancellation signal', async () => {
  const caller = liveDifference();
  const response = await caller.read(2, 17, true);
  expect(await response.text()).toBe('png');
  const request = new URL(caller.calls[0]!.url);
  expect(request.href).toBe(caller.routes.api('stage-parts/difference/2') + '?threshold=17&footprints=true');
  expect(request.origin).toBe(caller.origin);
  expect([...request.searchParams]).toEqual([['threshold', '17'], ['footprints', 'true']]);
  expect(caller.calls[0]!.init.signal).toBe(caller.lifetime.signal);
  expect(caller.calls[0]!.init.headers).toEqual({'X-Review-Capability': 'fixture'});
});

test('#645 live host Difference rejects a moved display before request and after response, and preserves named failures', async () => {
  const caller = liveDifference();
  caller.scope.current = {};
  await expect(caller.read(0, 16, false)).rejects.toThrow('JOB_ACT_SOURCE_STALE');
  expect(caller.calls).toHaveLength(0);
  caller.scope.current = caller.scope.prepared;
  caller.scope.fetch = async () => {caller.scope.current = {}; return new Response('png');};
  await expect(caller.read(0, 16, false)).rejects.toThrow('JOB_ACT_SOURCE_STALE');
  caller.scope.current = caller.scope.prepared;
  caller.scope.fetch = async () => Response.json({error: {code: 'PARTS_DIFFERENCE_ALIGNMENT'}}, {status: 400});
  await expect(caller.read(0, 16, false)).rejects.toThrow('PARTS_DIFFERENCE_ALIGNMENT');
});

test('#645 a disposed live host refuses Difference before starting a request', async () => {
  const caller = liveDifference();
  caller.lifetime.abort();
  await expect(caller.read(0, 16, false)).rejects.toThrow('JOB_ACT_SOURCE_STALE');
  expect(caller.calls).toHaveLength(0);
});


test('#645 real publication routes retain literal path and global extra-query refusal', () => {
  const caller = liveDifference();
  expect(caller.routes.api('stage-parts/difference/2')).toBe(caller.origin + caller.display.routes.apiBase + 'stage-parts/difference/2');
  for (const path of ['stage-parts/difference/2?threshold=17&footprints=true',
    'stage-parts/difference/2?extra=1', 'review?lang=en', 'stage-parts?extra=1',
    'stage-parts/difference/2#fragment', '../stage-parts/difference/2', 'stage-parts/%2e%2e/review']) {
    expect(() => caller.routes.api(path)).toThrow('JOB_DISPLAY_MISMATCH');
  }
  expect(() => jobPublicationRoutes({...caller.display, routes: {...caller.display.routes,
    apiBase: caller.display.routes.apiBase + '?extra=1'}}, caller.origin)).toThrow('JOB_DISPLAY_MISMATCH');
});

test('#645 Difference adapter cannot smuggle an extra query through its literal endpoint', async () => {
  const caller = liveDifference();
  await expect(caller.read('2?extra=1', 17, true)).rejects.toThrow('JOB_DISPLAY_MISMATCH');
  expect(caller.calls).toHaveLength(0);
});


test('#645 Parts inspection refusal excludes only the current mutation lock while preserving all unsafe display states',()=>{
  let phase='sent',binding:Record<string,any>|undefined;
  const scope:Record<string,any>={disposed:false,paintFailure:null,painting:false,paintingHeld:false,stageEmbedded:false,
    state:{data:{mode:'parts'}},host:{locked:()=>phase},slots:{toolbar:new Element(),side:new Element()},
    $:()=>new Element(),t:(key:string)=>key,commentUi:null,
    bindStageComments:(host:Record<string,any>)=>{binding=host;return {};}};
  productFunction('setupPartsComments',scope)();
  expect(binding).toBeDefined();const bound=binding!;
  for(const locked of ['sent','approved','retry-signoff']){
    phase=locked;expect(bound.locked()).toBe(true);expect(bound.refusal()).toContain('Read-only');
    expect(bound.inspectionRefusal()).toBeNull();
  }
  phase='open';expect(bound.refusal()).toBeNull();expect(bound.inspectionRefusal()).toBeNull();
  for(const failure of ['PARTS_PAINT_FAILED','PARTS_COMMENT_STALE_SOURCE']){
    scope.paintFailure=failure;expect(bound.refusal()).toBe(failure);expect(bound.inspectionRefusal()).toBe(failure);
  }
  scope.paintFailure=null;
  for(const key of ['painting','paintingHeld']){
    scope[key]=true;expect(bound.blocked()).toBe(true);expect(bound.busy()).toBe(true);
    expect(bound.refusal()).toBeNull();expect(bound.inspectionRefusal()).toContain('COMMENT_BUSY');scope[key]=false;
  }
  scope.stageEmbedded=true;expect(bound.inspectionRefusal()).toBe('PARTS_JOINED_ISSUE_UNSUPPORTED');scope.stageEmbedded=false;
  scope.state.data.mode='atlas';expect(bound.inspectionRefusal()).toContain('PARTS_COMMENT_UNAVAILABLE');scope.state.data.mode='parts';
  scope.state.data.legacyVerdict={readOnly:true,code:'legacy-boundary',flaggedCount:1};
  expect(bound.locked()).toBe(true);expect(bound.refusal()).toContain('legacy-boundary');expect(bound.inspectionRefusal()).toContain('legacy-boundary');
  delete scope.state.data.legacyVerdict;scope.disposed=true;expect(bound.inspectionRefusal()).toContain('PARTS_COMMENT_UNAVAILABLE');
});
