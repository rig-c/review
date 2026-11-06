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
  setAttribute(){} addEventListener(){} removeEventListener(){} remove(){}
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
  host.children[1]!.onclick();
  // showInterview awaits the stub response and then mounts its frame.
  await new Promise(resolve=>setTimeout(resolve,0));
  const urls=body.children[0]!.children.filter(child=>child.src).map(child=>new URL(child.src,href));
  expect(urls).toHaveLength(2);
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
  const keys=[...new Set(source.match(/interview\.[A-Za-z]+/g))].filter(key=>!['interview.ts','interview.js','interview.html'].includes(key));
  expect(keys.length).toBeGreaterThan(0);
  for(const k of keys){expect(enCatalog[k],k).toBeTruthy();expect(koCatalog[k],k).toBeTruthy();}
 }
});
