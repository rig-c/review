import {test,expect} from 'bun:test';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {stagePartsRoutes} from '../src/stage-parts.ts';
import {frontRoute,stageFrameQuery} from '../src/front.ts';
import {loadPartsAtlas,loadPartsView,verdictSource} from '../src/parts-view.ts';
import {bindStageNav,reviewStages,stageReason} from '../web/stage-nav.ts';
import {instanceAccess,readOnlyReason,type InstanceAccess} from '../web/instance-access.ts';

/** Mount the real navigation with only its DOM plumbing stubbed; no browser or server. */
async function emittedStageFrames(access:InstanceAccess,href:string,side?:'a'|'b') {
 class Element {
  children:Element[]=[];dataset:Record<string,string>={};style={};
  classList={add(){},remove(){}};src='';onclick=()=>{};
  append(...children:Element[]){this.children.push(...children);}
  id='';setAttribute(){} getAttribute(){return null;} addEventListener(){} removeEventListener(){} remove(){}
  closest(){return null;} getBoundingClientRect(){return {bottom:0};}
  querySelectorAll(){return [];}
 }
 const host=new Element(),body=new Element(),workspace=new Element();
 const globals={
  document:{body,documentElement:new Element(),createElement:()=>new Element(),
   querySelector:(selector:string)=>selector==='[data-stage-nav]'?host:workspace,
   querySelectorAll:()=>[],getElementById:()=>null},
  location:new URL(href),window:{addEventListener(){},removeEventListener(){}},
  MutationObserver:class {observe(){} disconnect(){}},
  fetch:async()=>Response.json({}),
 };
 const descriptors=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 let dispose:(()=>void)|undefined;
 try{
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  dispose=bindStageNav({access,preRig:true,model:false,interview:true,side:side?()=>side:undefined});
  await new Promise(resolve=>setTimeout(resolve,0));
  const urls=body.children[0]!.children.filter(child=>child.src).map(child=>new URL(child.src,href));
  // #708: stage 2 is the interview modal over this screen, so the parts frame is the only stage frame.
  expect(urls).toHaveLength(1);
  expect(body.children.some(child=>(child as unknown as {id:string}).id==='review-interview-modal')).toBe(true);
  expect(host.children[1]!.onclick).toBeNull();
  return urls;
 }finally{
  dispose?.();
  for(const [key,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
 }
}

test('direct embedded frames recover the parent handoff slot without capability query values',async()=>{
 const key='b'.repeat(64),capability='c'.repeat(64),values=new Map<string,string>();
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const href=`http://127.0.0.1:5000/?handoff=${key}#cap=${capability}`;
 const parent=instanceAccess(href,storage,()=>{});
 const urls=await emittedStageFrames(parent,href);
 for(const url of urls){
  expect(url.origin).toBe(new URL(href).origin);
  expect(url.searchParams.get('handoff')).toBe(key);
  expect([...url.searchParams.keys()].sort()).toEqual(['handoff','lang','stageEmbed']);
  expect(url.search).not.toContain(capability);
  const child=instanceAccess(url.href,storage,()=>{});
  expect(child.key).toBe(parent.key);expect(child.capability).toBe(capability);
 }
 const parts=urls.find(url=>url.pathname==='/stage-parts.html')!;
 expect(parts.hash).toBe('');
 expect(instanceAccess(parts.href,null,()=>{}).capability).toBeNull();
 expect(instanceAccess(parts.href,{getItem:()=>null,setItem(){}},()=>{}).capability).toBeNull();
 const other=new Map([['rig-review-capability/1:'+'d'.repeat(64),capability]]);
 expect(instanceAccess(parts.href,{getItem:key=>other.get(key)??null,setItem(){}},()=>{}).capability).toBeNull();
 const old=new URL(parts);old.searchParams.delete('handoff');
 const lost=instanceAccess(old.href,storage,()=>{});
 expect(lost.key).toBe('direct');expect(lost.capability).toBeNull();expect(readOnlyReason(lost,true)).toBeTruthy();
});

test('managed and foreground frame queries retain their existing authority boundaries',async()=>{
 const key='b'.repeat(64);
 for(const side of [undefined,'a','b'] as const){
  const href=`http://127.0.0.1:4318/instances/${key}/?handoff=${'d'.repeat(64)}`;
  const access=instanceAccess(href,null,()=>{});
  for(const url of await emittedStageFrames(access,href,side)){
   expect(url.pathname).toStartWith(`/instances/${key}/`);expect(url.searchParams.has('handoff')).toBe(false);
   const compare=!!side&&url.pathname.endsWith('stage-parts.html');
   expect(stageFrameQuery(compare?'compare':'single',url.search)).toBe(true);
   expect(instanceAccess(url.href,null,()=>{}).key).toBe(key);
  }
 }
 for(const handoff of ['', 'short', 'A'.repeat(64), 'b'.repeat(63), 'b'.repeat(65)]){
  const href='http://127.0.0.1:5000/?handoff='+handoff;
  for(const url of await emittedStageFrames(instanceAccess(href,null,()=>{}),href)){
   expect(url.searchParams.has('handoff')).toBe(false);expect(url.hash).toBe('');
   expect(instanceAccess(url.href,null,()=>{}).capability).toBeNull();
  }
 }
 const values=new Map<string,string>(),capability='c'.repeat(64);
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
 const href=`http://127.0.0.1:5000/#cap=${capability}`;
 for(const url of await emittedStageFrames(instanceAccess(href,storage,()=>{}),href)){
  expect(url.searchParams.has('handoff')).toBe(false);
  expect(instanceAccess(url.href,storage,()=>{}).capability).toBe(capability);
 }
});

test('stage inspection does not create interview/direction/model capabilities',()=>{
 expect(reviewStages).toHaveLength(4);expect(stageReason(2,true)).toStartWith('INTERVIEW_UNAVAILABLE:');expect(stageReason(4,true)).toStartWith('DIRECTION_UNAVAILABLE:');expect(stageReason(3,false)).toStartWith('MODEL_UNAVAILABLE:');expect(stageReason(1,false)).toBeNull();
});
test('front stage routes are read-only, side-closed and index-only',()=>{
 for(const mode of ['single','compare'] as const){
  const base=mode==='single'?'/api/stage-parts':'/api/compare/a/stage-parts';
  for(const path of [base,base+'/page/0','/stage-parts.html','/parts.js','/parts.css']){expect(frontRoute(mode,'GET',path)).not.toBeNull();expect(frontRoute(mode,'POST',path)).toBeNull();}
  for(const path of [base+'/verdict',base+'/page/-1',base+'/page/../0',base+'/page/1/escape','/api/compare/c/stage-parts','/api/stage-parts/page/%2e%2e'])expect(frontRoute(mode,'GET',path)).toBeNull();
 }
});
test('loaded atlas preserves standalone identity, detects changed bytes and never writes verdict',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stage-atlas-'));try{
  await cp('examples/demo',root,{recursive:true});const p=await loadReview(join(root,'review.json'));
  const old=await loadPartsView(join(root,'review.json')),atlas=await loadPartsAtlas(p);
  expect(verdictSource(atlas)).toEqual(verdictSource(old));expect(atlas.protectedPaths).toEqual(old.protectedPaths);
  const route=stagePartsRoutes({single:p}),req=(path:string,method='GET')=>new Request('http://127.0.0.1'+path,{method});
  const data=await route(req('/api/stage-parts'));expect(data?.status).toBe(200);const atlasData=await data!.json();expect(atlasData.readOnly).toBe(true);expect(atlasData.draftUnavailable).toStartWith('STAGE_DRAFT_UNAVAILABLE');
  expect(await route(req('/api/stage-parts','POST'))).toBeNull();
  expect((await route(req('/api/stage-parts/page/999999')))?.status).toBe(404);
  const image=await route(req('/api/stage-parts/page/0'));expect(image?.status).toBe(200);expect(image?.headers.get('content-security-policy')).toContain('sandbox');
  const page=atlas.pagePaths[0]!,pageBefore=await readFile(page);await writeFile(page,Buffer.concat([pageBefore,Buffer.from('changed')]));
  expect((await route(req('/api/stage-parts/page/0')))?.status).toBe(409);
  await writeFile(page,pageBefore);
  // Unrelated reference bytes are checked on data load, never on each indexed page.
  const reference=join(root,'lantern.svg'),refBefore=await readFile(reference);await writeFile(reference,Buffer.concat([refBefore,Buffer.from(' ')]));
  expect((await route(req('/api/stage-parts/page/0')))?.status).toBe(200);
  expect((await route(req('/api/stage-parts')))?.status).toBe(409);await writeFile(reference,refBefore);
  const model=join(root,p.manifest.model!);await writeFile(model,(await readFile(model,'utf8'))+' ');
  expect((await route(req('/api/stage-parts')))?.status).toBe(409);expect((await route(req('/api/stage-parts/page/0')))?.status).toBe(409);
  expect(await Bun.file(atlas.verdictPath).exists()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('compare stage atlas never substitutes the other side',async()=>{
 const p=await loadReview('examples/demo/review.json'),bad={...p,manifest:{...p.manifest,model:undefined}};
 const route=stagePartsRoutes({a:p,b:bad});
 expect((await route(new Request('http://127.0.0.1/api/compare/a/stage-parts')))?.status).toBe(200);
 expect((await route(new Request('http://127.0.0.1/api/compare/b/stage-parts')))?.status).toBe(409);
 expect(await route(new Request('http://127.0.0.1/api/compare/c/stage-parts'))).toBeNull();
});

test('a FIRST image returns original bytes; page replacement during initial load fails post-load binding and stays refused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'stage-first-image-'));try{
  await cp('examples/demo',root,{recursive:true});const p=await loadReview(join(root,'review.json')),atlas=await loadPartsAtlas(p),page=atlas.pagePaths[0]!,original=await readFile(page);
  const request=()=>new Request('http://127.0.0.1/api/stage-parts/page/0');
  const positive=await stagePartsRoutes({single:p})(request());expect(positive?.status).toBe(200);expect(Buffer.from(await positive!.arrayBuffer())).toEqual(original);
  const {PNG}=await import('pngjs');const png=PNG.sync.read(original);png.data[0]^=255;const replacement=PNG.sync.write(png);expect(replacement.equals(original)).toBe(false);
  let loads=0;
  const race=stagePartsRoutes({single:p},async source=>{
   // This loader is called only AFTER the initial Review check, before atlas hashing; no sleep or data request.
   loads++;await writeFile(page,replacement);return loadPartsAtlas(source);
  });
  expect((await race(request()))?.status).toBe(409);expect((await race(request()))?.status).toBe(409);expect(loads).toBe(1);
  console.log('STAGE_FIRST_IMAGE_ORIGINAL_BYTES; GENERATED_PAGE_DURING_LOAD_REFUSED_AND_REPEATED_409');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('interview launch guidance and chrome have matching English and Korean keys',async()=>{
 const {enCatalog}=await import('../web/catalog-en.ts'),{koCatalog}=await import('../web/catalog-ko.ts');
 const key=stageReason(2,true)!;
 expect(enCatalog[key]).toContain('INTERVIEW_UNAVAILABLE:');expect(koCatalog[key]).toContain('INTERVIEW_UNAVAILABLE:');
 expect(stageReason(2,true,false,true)).toBeNull();
 for(const file of ['web/interview.ts','web/interview-panel.ts']){
  const source=await readFile(file,'utf8');
  const keys=[...new Set(source.match(/interview\.[A-Za-z]+/g))].filter(key=>!['interview.ts'].includes(key));
  expect(keys.length).toBeGreaterThan(0);
  for(const k of keys){expect(enCatalog[k],k).toBeTruthy();expect(koCatalog[k],k).toBeTruthy();}
 }
});

test('#562(ii) preRig stage-nav keeps direct Stage 3 refused, opens Setup only on verified Stage 1 correction, and re-syncs Stage 1 draft build on return or refresh',async()=>{
 const {bindStageNav}=await import('../web/stage-nav.ts');
 class NodeStub {
  tagName:string;id='';className='';textContent='';title='';hidden=false;disabled=false;inert=false;
  dataset:Record<string,string>={};style:Record<string,string>={};children:NodeStub[]=[];
  contentWindow:any=null;src='';
  private attrs=new Map<string,string>();
  private listeners=new Map<string,Set<(e:any)=>void>>();
  constructor(tag:string){this.tagName=tag.toUpperCase();if(this.tagName==='IFRAME')this.contentWindow={postMessage:(msg:unknown)=>{this.posted.push(msg);}};}
  posted:unknown[]=[];
  append(...nodes:NodeStub[]){this.children.push(...nodes);}
  remove(){if(body.children.includes(this))body.children=body.children.filter(c=>c!==this);}
  setAttribute(k:string,v:string){this.attrs.set(k,v);}
  getAttribute(k:string){return this.attrs.get(k)??null;}
  removeAttribute(k:string){this.attrs.delete(k);}
  addEventListener(type:string,fn:(e:any)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(fn);}
  removeEventListener(type:string,fn:(e:any)=>void){this.listeners.get(type)?.delete(fn);}
  dispatch(type:string,event:any={}){for(const fn of [...(this.listeners.get(type)??[])])fn(event);}
  click(){const ev={preventDefault(){},stopImmediatePropagation(){}};this.dispatch('click',ev);this.onclick?.();}
  onclick?:()=>void;
  closest(){return null;}
  getBoundingClientRect(){return {bottom:40};}
  classList={add:()=>{},remove:()=>{},toggle:()=>{}};
  querySelectorAll(){return [];}
 }
 const host=new NodeStub('nav'),workspace=new NodeStub('div'),inspectorRig=new NodeStub('button'),body=new NodeStub('body'),docEl=new NodeStub('html');
 inspectorRig.setAttribute('data-inspector','rig');inspectorRig.setAttribute('aria-selected','false');
 const winListeners=new Map<string,Set<(e:any)=>void>>();
 const prevDoc=(globalThis as any).document,prevWin=(globalThis as any).window,prevLoc=(globalThis as any).location,prevObs=(globalThis as any).MutationObserver;
 (globalThis as any).location={href:'http://127.0.0.1:4173/',origin:'http://127.0.0.1:4173',search:'',hash:''};
 (globalThis as any).MutationObserver=class{observe(){}disconnect(){}};
 (globalThis as any).window={
  location:(globalThis as any).location,
  addEventListener:(t:string,fn:(e:any)=>void)=>{if(!winListeners.has(t))winListeners.set(t,new Set());winListeners.get(t)!.add(fn);},
  removeEventListener:(t:string,fn:(e:any)=>void)=>{winListeners.get(t)?.delete(fn);},
 };
 (globalThis as any).document={
  documentElement:docEl,
  body,
  getElementById:()=>null,
  createElement:(tag:string)=>new NodeStub(tag),
  querySelector:(sel:string)=>sel==='[data-stage-nav]'?host:sel==='.layout'?workspace:sel==='[data-inspector="rig"]'?inspectorRig:null,
  querySelectorAll:(sel:string)=>sel.includes('[data-inspector]')?[inspectorRig]:[],
 };
 try{
  let currentBuild='inspected';
  let allowCorrection=true;
  let refreshFn:(()=>void)|undefined;
  const calls:string[]=[];
  const dispose=bindStageNav({
   preRig:true,
   model:false,
   draftBuild:()=>currentBuild,
   refresh:(fn:()=>void)=>{refreshFn=fn;},
   correction:async(req:{part:string;sourceHash:string;buildId:string;instrument:string})=>{
    calls.push(`${req.part}:${req.buildId}:${req.instrument}`);
    if(!allowCorrection)throw new Error('STAGE_DRAFT_MISMATCH');
    inspectorRig.click();
   },
  } as any);
  const panel=body.children.find(c=>c.className==='review-stage-panel')!;
  const status=panel.children[0]!;
  const stageButtons=host.children;
  expect(docEl.dataset.inspectionStage).toBe('1');
  expect(panel.hidden).toBe(false);
  expect(workspace.inert).toBe(true);
  expect(inspectorRig.disabled).toBe(true);

  // Direct click on Stage 3 in preRig remains refused (`RIG_VERSION_UNAVAILABLE`).
  stageButtons[2]!.click();
  expect(docEl.dataset.inspectionStage).toBe('3');
  expect(panel.hidden).toBe(false);
  expect(status.textContent).toContain('RIG_VERSION_UNAVAILABLE');

  // Return to Stage 1 and trigger a failed correction: stays on Stage 1 with error status and workspace inert.
  stageButtons[0]!.click();
  const frame1=panel.children.find(c=>c.tagName==='IFRAME')!;
  allowCorrection=false;
  for(const fn of winListeners.get('message')??[])await fn({origin:'http://127.0.0.1:4173',source:frame1.contentWindow,data:{type:'review-stage-correction',part:'torso',sourceHash:'h1',buildId:'inspected',instrument:'mesh'}});
  expect(docEl.dataset.inspectionStage).toBe('1');
  expect(panel.hidden).toBe(false);
  expect(workspace.inert).toBe(true);
  expect(status.textContent).toBe('STAGE_DRAFT_MISMATCH');

  // Verified Stage 1 correction enables inspector controls and reveals the Setup workspace (`panel.hidden === true`, `workspace.inert === false`).
  allowCorrection=true;
  for(const fn of winListeners.get('message')??[])await fn({origin:'http://127.0.0.1:4173',source:frame1.contentWindow,data:{type:'review-stage-correction',part:'torso',sourceHash:'h1',buildId:'inspected',instrument:'mesh'}});
  expect(docEl.dataset.inspectionStage).toBe('3');
  expect(panel.hidden).toBe(true);
  expect(workspace.inert).toBe(false);
  expect(inspectorRig.disabled).toBe(false);

  // After a scratch Apply changes `draftBuild()`, returning to Stage 1 mounts the scratch build frame; `refresh()` updates Stage 1 in place.
  currentBuild='b'.repeat(64);
  stageButtons[0]!.click();
  expect(docEl.dataset.inspectionStage).toBe('1');
  expect(panel.hidden).toBe(false);
  expect(workspace.inert).toBe(true);
  const frame2=panel.children.filter(c=>c.tagName==='IFRAME').at(-1)!;
  frame2.dispatch('load');
  expect(frame2.posted).toContainEqual({type:'review-stage-source',buildId:currentBuild,state:null});

  currentBuild='inspected';
  refreshFn?.();
  const frame3=panel.children.filter(c=>c.tagName==='IFRAME').at(-1)!;
  frame3.dispatch('load');
  expect(frame3.posted).toContainEqual({type:'review-stage-source',buildId:'inspected',state:null});
  dispose();
 }finally{
  (globalThis as any).document=prevDoc;(globalThis as any).window=prevWin;(globalThis as any).location=prevLoc;(globalThis as any).MutationObserver=prevObs;
 }
});
