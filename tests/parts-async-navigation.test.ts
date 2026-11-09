import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';
useTemporaryReviewState();
import {expect,test} from 'bun:test';
import {paintingRectangle} from '../src/parts-comparison.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {createPartsViewport} from '../web/parts-viewport-provider.ts';
import {projectMark,unprojectMark,region} from '../src/stage-comment.ts';
import {parsePartsIssue,assertPartsIssueBinding,snapImageRegion,type PartsIssue} from '../src/parts-comment.ts';
import {preparePartsComment} from '../src/parts-comment-crops.ts';
import {readPngCrop} from '../src/comment-crops.ts';
import {verdictSource} from '../src/parts-view.ts';
import {commentFixture,candidate} from './helpers/parts-comments-package.ts';

/** Run the actual reference painter, with only image completion and canvas calls controlled. */
async function referenceDriver(){
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('function partFrame('),end=source.indexOf('\nfunction renderFlags(',start),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end));
 const pending:((image:unknown)=>void)[]=[],draws:number[]=[];const ctx={imageSmoothingEnabled:true,drawImage:(_image:unknown,x:number)=>draws.push(x)},canvas={width:0,height:0,getContext:()=>ctx};
 const scope={disposed:false,paintToken:1,state:{data:{rigSize:[200,200],painting:{sha256:'a'.repeat(64),width:200,height:200},items:[{x:10,y:5,w:8,h:9},{x:100,y:50,w:18,h:19}]},selected:0,bg:'green'},paintingImage:()=>new Promise(resolve=>pending.push(resolve)),$:()=>canvas,paintingRectangle,paintPaintingCrop:(_ctx:unknown,img:unknown,r:{x:number})=>ctx.drawImage(img,r.x)};
 const paint=new Function('scope',`with(scope){${code};return paintReference;}`)(scope) as (token?:number)=>Promise<void>;
 return {scope,pending,draws,canvas,paint};
}
test('#389 adopted P2: late A painting image cannot overwrite already completed selected B crop',async()=>{
 const h=await referenceDriver(),a=h.paint(1);h.scope.state.selected=1;h.scope.paintToken=2;const b=h.paint(2);
 h.pending[1]!({name:'B'});await b;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
 h.pending[0]!({name:'A'});await a;expect(h.draws).toEqual([100]);expect([h.canvas.width,h.canvas.height]).toEqual([18,19]);
});

/** Actual parts paint orchestration/raster and comment host; only image delivery and raster calls are controlled. */
async function failedPaintDriver(){
 const source=await readFile('web/parts.ts','utf8'),start=source.indexOf('let paintToken = 0'),end=source.indexOf('\nfunction renderComparison(',start),setup=source.slice(source.indexOf('function issueParts('),source.indexOf('\nfunction renderCorrections():void',source.indexOf('function setupPartsComments():void'))),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end)+'\n'+setup);
 const nodes=new Map<string,any>();const node=(id:string)=>{if(!nodes.has(id)){const ctx={pixels:'',clearRect(){this.pixels='';}};nodes.set(id,{width:1,height:1,textContent:'',dataset:{},setAttribute(){},getContext:()=>ctx,replaceChildren(){}});}return nodes.get(id);};
 let host:any;const scope:any={settleReady:()=>{},paintingHeld:false,hoverName:null,highlightedParts:new Set(),disposed:false,mountActive:true,slots:{toolbar:{},stage:{dataset:{},setAttribute(){}}},host:{locked:()=>'open'},painting:0,commentUi:null,viewport:{fitCamera(){}},state:{data:{mode:'parts',rigSize:[100,100],painting:{width:100,height:100},items:[{name:'A',index:0,x:0,y:0,w:10,h:10},{name:'B',index:1,x:10,y:0,w:10,h:10}],flags:[]},selected:0,comparison:{mode:'overlay',opacity:.5},bg:'green',alpha:false,footprints:false,meshVisible:false},$:node,t:(s:string)=>s,itemImage:async(i:any)=>i.name,paintingImage:async()=>({}),frontParts:()=>[],setCanvas:(c:any,w:number,h:number)=>{c.width=w;c.height=h;c.getContext().pixels='';return c.getContext();},paintOverlay:(c:any,_i:any,img:any)=>{c.pixels=img;},paintPart:(c:any,_i:any,img:any)=>{c.pixels=img;},paintPaintingCrop:()=>{},paintFootprints:()=>{},paintingRectangle,doc:{createElement:()=>({})},query:()=>({}),stageEmbedded:false,bindStageComments:(h:any)=>{host=h;scope.boundHost=h;return {refresh(){}};}};
 const api=new Function('scope',`with(scope){${code};setupPartsComments();return {paint,host:()=>scope.boundHost};}`)(scope) as {paint:()=>Promise<void>;host:()=>any};
 // Keep the same scope object so controlled image failures can be replaced between generations.
 return {api,scope:scope as any,nodes,node};
}

for(const failed of ['painting','image'])test(`#391 adopted P2: failed ${failed} after A -> B clears old pixels and refuses capture/editing until successful repaint`,async()=>{
 const h=await failedPaintDriver();await h.api.paint();expect(h.node('pv-canvas').getContext().pixels).toBe('A');
 h.scope.state.selected=1;if(failed==='painting')h.scope.paintingImage=async()=>{throw Error('planted painting load');};else h.scope.itemImage=async()=>{throw Error('planted image load');};
 await h.api.paint().catch(()=>{});expect(h.node('pv-canvas').getContext().pixels).toBe('');expect(h.api.host().refusal()).toContain('PARTS_PAINT_FAILED');expect(h.api.host().blocked()).toBe(false);
 h.scope.paintingImage=async()=>({});h.scope.itemImage=async(i:any)=>i.name;await h.api.paint();expect(h.node('pv-canvas').getContext().pixels).toBe('B');expect(h.api.host().refusal()).toBeNull();expect(h.api.host().blocked()).toBe(false);
});

test('#391 adopted P2: an older failed painting generation cannot clear or refuse a newer successful view',async()=>{
 const h=await failedPaintDriver();await h.api.paint();let reject!:(e:Error)=>void;h.scope.state.selected=1;h.scope.paintingImage=()=>new Promise((_r:unknown,r:any)=>{reject=r;});const older=h.api.paint();for(let i=0;i<10&&!reject;i++)await Promise.resolve();expect(reject).toBeDefined();
 h.scope.state.selected=0;h.scope.paintingImage=async()=>({});await h.api.paint();expect(h.api.host().blocked()).toBe(false);reject(Error('late old load failure'));await older.catch(()=>{});
 expect(h.node('pv-canvas').getContext().pixels).toBe('A');expect(h.api.host().refusal()).toBeNull();expect(h.api.host().blocked()).toBe(false);
});

test('#613 after first paint and a stage-height change the actual parts codec crops only the visible original-image intersection', async () => {
 const root = await mkdtemp(join(tmpdir(), 'parts-edge-resize-'));
 try {
  const pkg = await commentFixture(root);
  const item = pkg.items[0]!;
  const sample = candidate(pkg);
  const h = await failedPaintDriver();
  const el = <T extends HTMLElement>(id: string): T => {
   const node = h.node(id);
   node.style ??= {};
   node.clientWidth ??= 437;
   node.clientHeight ??= 722;
   return node as T;
  };
  h.scope.state.view = 'item';
  h.scope.state.comparison = {mode: 'part', opacity: .5};
  h.scope.state.data = {...h.scope.state.data, sourceHash: verdictSource(pkg).sha256,
   items: pkg.items.map(part => ({...part, imageHash: pkg.files.find(file => file.abs === pkg.imagePaths[part.index])!.sha256}))};
  const controller = createPartsViewport({el, canvas: el<HTMLCanvasElement>('pv-canvas'),
   reference: () => null, frameSize: target => target === 'rig' ? {w: item.w, h: item.h} : null, message() {}});
  h.scope.viewport = controller;
  const sent: PartsIssue[] = [];
  Object.assign(h.scope, {region, projectMark, unprojectMark, snapImageRegion, parsePartsIssue, assertPartsIssueBinding,
   source: {crop: async (issue: PartsIssue) => { sent.push(issue); return preparePartsComment(pkg, issue); }}});
  await h.api.paint();
  controller.writeCamera('rig', {zoom: 1, center: {x: item.w / 2, y: item.h / 2}});
  controller.fitCamera();
  expect(controller.numericView().cameras.rig!.viewport.height).toBe(722);
  h.node('rig-viewport').clientHeight = 695;
  controller.fitCamera();
  const pose = h.api.host().pose();
  expect(pose.camera.viewport.height).toBe(695);
  expect(parseFloat(h.node('rig-root').style.top)).toBeCloseTo(projectMark({x: 0, y: 0}, pose.camera).y, 10);
  const codec = h.api.host().codec;
  const cases = [
   {start: {x: -3, y: -3}, end: {x: 12, y: 12}, expected: {x: 0, y: 0, width: 12, height: 12}},
   {start: {x: 25, y: 28}, end: {x: 35, y: 36}, expected: {x: 25, y: 28, width: 5, height: 4}},
   {start: {x: 12, y: 12}, end: {x: -3, y: -3}, expected: {x: 0, y: 0, width: 12, height: 12}},
   {start: {x: 3, y: 3}, end: {x: 12, y: 12}, expected: {x: 3, y: 3, width: 9, height: 9}},
  ];
  const original = PNG.sync.read(await readFile(pkg.imagePaths[item.index]!));
  for (const control of cases) {
   const screen = region(projectMark(control.start, pose.camera), projectMark(control.end, pose.camera));
   const issue: PartsIssue = await codec.create(pose, 'rig', screen, sample.crop, null, 'Visible edge');
   expect(issue.imageRegion).toEqual(control.expected);
   expect(issue.rigRegion).toEqual({...control.expected, x: item.x + control.expected.x, y: item.y + control.expected.y});
   expect(issue.parts).toEqual(sample.parts);
   expect(issue.sourceHash).toBe(sample.sourceHash);
   const decoded = PNG.sync.read(await readPngCrop(issue.nativeCrop!));
   const expected = Buffer.alloc(control.expected.width * control.expected.height * 4);
   for (let y = 0; y < control.expected.height; y++) {
    const start = ((control.expected.y + y) * original.width + control.expected.x) * 4;
    original.data.copy(expected, y * control.expected.width * 4, start, start + control.expected.width * 4);
   }
   expect(decoded.data).toEqual(expected);
  }
  const outside = region(projectMark({x: 35, y: 36}, pose.camera), projectMark({x: 40, y: 40}, pose.camera));
  await expect(codec.create(pose, 'rig', outside, sample.crop, null, 'Outside')).rejects.toThrow('PARTS_COMMENT_EMPTY');
  expect(sent).toHaveLength(cases.length);
  const invalid = structuredClone(sent[0]!);
  invalid.imageRegion!.y = -3;
  invalid.rigRegion.y = item.y - 3;
  await expect(preparePartsComment(pkg, invalid)).rejects.toThrow('PARTS_COMMENT_OUT_OF_BOUNDS');
  console.log('PARTS_EDGE_CROP ' + JSON.stringify({firstPaintHeight: 722, resizedHeight: 695,
   sentRegions: sent.map(issue => issue.imageRegion), nativeRGBA: 'bound original subrects matched', serverOOB: 'still refused'}));
 } finally {
  await rm(root, {recursive: true, force: true});
 }
});

/** Actual pan binder with event/capture surfaces substituted; independent background control stays pannable. */
test('#389 adopted P2: explicitly marked atlas action retains its click target; background still captures and pans',async()=>{
 const source=await readFile('web/view-controls.ts','utf8'),start=source.indexOf('const panVideoOverrides='),end=source.indexOf('export function bindInspectorTabs(',start),code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(source.slice(start,end).replace('export function','function'));
 class Node{
  style={};dataset:Record<string,string>={};handlers=new Map<string,Function[]>();captured=new Set<number>();
  constructor(readonly action=false){}closest(selector:string){return this.action&&selector.includes('[data-viewport-action]')?this:null;}querySelectorAll(){return [];}addEventListener(k:string,f:Function){this.handlers.set(k,[...this.handlers.get(k)??[],f]);}removeEventListener(){}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);}
  emit(k:string,values:object){for(const f of this.handlers.get(k)??[])f({button:0,isPrimary:true,pointerId:7,clientX:20,clientY:30,preventDefault(){},...values});}
 }
 class Observer{observe(){}disconnect(){}}
 const doc=new Node(),win=new Node(),pane=new Node(),moves:number[][]=[];const bind=new Function('window','document','Element','MutationObserver',code+';return bindPan;')(win,doc,Node,Observer),dispose=bind(pane,(x:number,y:number)=>moves.push([x,y]));
 try{pane.emit('pointerdown',{target:new Node(true)});expect(pane.captured.size).toBe(0);pane.emit('pointermove',{target:new Node(true),clientX:50,clientY:70});expect(moves).toEqual([]);
 pane.emit('pointerdown',{target:pane});expect(pane.captured.has(7)).toBe(true);pane.emit('pointermove',{target:pane,clientX:50,clientY:70});expect(moves).toEqual([[30,40]]);
 const parts=await readFile('web/parts.ts','utf8');expect(parts).toContain("box.dataset.viewportAction = 'select-region'");
 }finally{dispose();}
});

test('#614 a late Difference mesh image cannot draw, replace captions or retain its bitmap after newer selection',async()=>{
 const h=await failedPaintDriver();
 const prior=Object.getOwnPropertyDescriptor(globalThis,'createImageBitmap');
 let release!:(image:unknown)=>void,closed=0,meshDraws=0;
 Object.defineProperty(globalThis,'createImageBitmap',{configurable:true,writable:true,value:async()=>({close(){closed++;}})});
 try{
  h.scope.state.data.items[0].mesh={vertices:[0,0,10,0,0,10],triangles:[0,1,2]};
  h.scope.state.view='item';h.scope.state.comparison={mode:'difference',opacity:.5,threshold:0};h.scope.state.meshVisible=true;
  h.scope.source={difference:async()=>new Response(new Uint8Array([1]))};
  h.scope.itemImage=(item:any)=>item.name==='A'?new Promise(resolve=>{release=resolve;}):Promise.resolve('B');
  h.scope.paintMesh=()=>{meshDraws++;};
  const older=h.api.paint();for(let i=0;i<12&&!release;i++)await Promise.resolve();expect(release).toBeDefined();
  h.scope.state.selected=1;h.scope.state.comparison={mode:'part',opacity:.5};await h.api.paint();
  const caption=h.node('pv-caption').textContent;expect(h.node('pv-canvas').getContext().pixels).toBe('B');
  release('A');await older;
  expect(h.node('pv-canvas').getContext().pixels).toBe('B');expect(h.node('pv-caption').textContent).toBe(caption);
  expect(meshDraws).toBe(0);expect(closed).toBe(1);expect(h.api.host().refusal()).toBeNull();
 }finally{
  if(prior)Object.defineProperty(globalThis,'createImageBitmap',prior);else delete (globalThis as any).createImageBitmap;
 }
});
