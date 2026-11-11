import {test,expect} from 'bun:test';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {stagePartsRoutes} from '../src/stage-parts.ts';
import {frontRoute} from '../src/front.ts';
import {loadPartsAtlas,loadPartsView,verdictSource} from '../src/parts-view.ts';
import {bindStageNav,reviewStages,stageReason,type StageNavOptions} from '../web/stage-nav.ts';

test('stage inspection does not create interview/direction/model capabilities',()=>{
 expect(reviewStages).toHaveLength(4);expect(stageReason(2,true)).toStartWith('INTERVIEW_UNAVAILABLE:');expect(stageReason(3,false)).toStartWith('MODEL_UNAVAILABLE:');expect(stageReason(1,true)).toBeNull();expect(stageReason(3,true)).toBeNull();
 // #726: Direction is not built; the chip names itself unavailable whatever the package carries.
 expect(stageReason(4,true)).toStartWith('DIRECTION_NOT_AVAILABLE:');expect(stageReason(4,true,true,false,true)).toStartWith('DIRECTION_NOT_AVAILABLE:');
 // The interview chip opens only through the modal hook (#708 seam).
 expect(stageReason(2,true,true)).toStartWith('INTERVIEW_MODAL_UNAVAILABLE:');expect(stageReason(2,true,true,false,true)).toBeNull();
 expect(stageReason(1,false,false,true)).toStartWith('RIG_VERSION_UNAVAILABLE:');
});
test('front stage routes are read-only, side-closed and index-only',()=>{
 for(const mode of ['single','compare'] as const){
  const base=mode==='single'?'/api/stage-parts':'/api/compare/a/stage-parts';
  for(const path of [base,base+'/page/0']){expect(frontRoute(mode,'GET',path)).not.toBeNull();expect(frontRoute(mode,'POST',path)).toBeNull();}
  // #726: the legacy stage frames are gone; no page route remains for them.
  for(const path of ['/stage-parts.html','/stage-interview.html','/parts.js','/parts.css','/interview.js','/interview.css'])expect(frontRoute(mode,'GET',path)).toBeNull();
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
 for(const key of [stageReason(2,true)!,stageReason(2,true,true)!,stageReason(4,true)!,'{stage} · not available']){expect(enCatalog[key],key).toBeTruthy();expect(koCatalog[key],key).toBeTruthy();}
 for(const file of ['web/interview-panel.ts']){
  const source=await readFile(file,'utf8');
  const keys=[...new Set(source.match(/interview\.[A-Za-z]+/g))];
  expect(keys.length).toBeGreaterThan(0);
  for(const k of keys){expect(enCatalog[k],k).toBeTruthy();expect(koCatalog[k],k).toBeTruthy();}
 }
});

/** Mount the real chips with only DOM plumbing stubbed; no browser or server. */
function mountChips(options:StageNavOptions){
 class NodeStub {
  tagName:string;textContent='';title='';hidden=false;disabled=false;dataset:Record<string,string>={};children:NodeStub[]=[];onclick?:()=>void;
  private attrs=new Map<string,string>();
  constructor(tag:string){this.tagName=tag.toUpperCase();}
  append(...nodes:NodeStub[]){this.children.push(...nodes);}
  remove(){host.children=host.children.filter(c=>c!==this);}
  setAttribute(k:string,v:string){this.attrs.set(k,v);}
  getAttribute(k:string){return this.attrs.get(k)??null;}
  removeAttribute(k:string){this.attrs.delete(k);}
  addEventListener(){} removeEventListener(){}
 }
 const host=new NodeStub('nav'),docEl=new NodeStub('html'),body=new NodeStub('body'),mode=new NodeStub('button');mode.setAttribute('data-mode','rig');
 const previous=Object.fromEntries(['document','window','location','MutationObserver'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const set=(key:string,value:unknown)=>Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 set('location',new URL('http://127.0.0.1:4173/'));set('MutationObserver',class{observe(){}disconnect(){}});
 set('window',{addEventListener(){},removeEventListener(){}});
 set('document',{documentElement:docEl,body,getElementById:()=>null,createElement:(tag:string)=>new NodeStub(tag),
  querySelector:(sel:string)=>sel==='[data-stage-nav]'?host:null,querySelectorAll:(sel:string)=>sel.includes('[data-mode]')?[mode]:[]});
 const dispose=bindStageNav(options);
 return {host,docEl,body,mode,restore(){dispose();for(const [key,d] of Object.entries(previous)){if(d)Object.defineProperty(globalThis,key,d);else Reflect.deleteProperty(globalThis,key);}}};
}

test('#726 chips open modes of the one screen, the interview modal hook, or name themselves unavailable, and never mount a frame',()=>{
 const calls:string[]=[];let current:1|3|null=3;
 const chips=mountChips({model:true,interview:true,setup:()=>{calls.push('setup');current=1;},animate:()=>{calls.push('animate');current=3;},
  interviewModal:()=>calls.push('interview'),current:()=>current});
 try{
  const [one,two,three,four]=chips.host.children;
  expect(chips.host.children.map(b=>b.dataset.reviewStage)).toEqual(['1','2','3','4']);
  expect(chips.docEl.dataset.inspectionStage).toBe('3');expect(three!.getAttribute('aria-current')).toBe('step');
  one!.onclick!();expect(calls).toEqual(['setup']);expect(chips.docEl.dataset.inspectionStage).toBe('1');expect(one!.getAttribute('aria-current')).toBe('step');
  two!.onclick!();expect(calls).toEqual(['setup','interview']);expect(one!.getAttribute('aria-current')).toBe('step');
  three!.onclick!();expect(calls).toEqual(['setup','interview','animate']);expect(chips.docEl.dataset.inspectionStage).toBe('3');
  four!.onclick!();expect(calls).toHaveLength(3);
  expect(four!.getAttribute('aria-disabled')).toBe('true');expect(four!.dataset.unavailable).toBe('DIRECTION_NOT_AVAILABLE');
  expect(four!.textContent).toContain('not available');expect(four!.title).toStartWith('DIRECTION_NOT_AVAILABLE:');
  expect(chips.body.children).toHaveLength(0);expect(chips.mode.disabled).toBe(false);
 }finally{chips.restore();}
});

test('#726 without the #708 modal the interview chip names itself unavailable; a model-less package disables Setup and Animate by name',()=>{
 const calls:string[]=[];
 const chips=mountChips({model:false,interview:true,setup:()=>calls.push('setup'),animate:()=>calls.push('animate')});
 try{
  for(const chip of chips.host.children)chip.onclick!();
  expect(calls).toEqual([]);
  expect(chips.host.children.map(b=>b.dataset.unavailable)).toEqual(['MODEL_UNAVAILABLE','INTERVIEW_MODAL_UNAVAILABLE','MODEL_UNAVAILABLE','DIRECTION_NOT_AVAILABLE']);
  expect(chips.mode.disabled).toBe(true);expect(chips.mode.title).toStartWith('MODEL_UNAVAILABLE:');
  expect(chips.body.children).toHaveLength(0);
 }finally{chips.restore();}
 expect(chips.mode.disabled).toBe(false);
});

test('#726 a standalone page shows only its own stage chip',()=>{
 const chips=mountChips({only:1,model:false});
 try{
  expect(chips.host.children).toHaveLength(1);expect(chips.host.children[0]!.dataset.reviewStage).toBe('1');
  expect(chips.host.children[0]!.getAttribute('aria-current')).toBe('step');expect(chips.host.children[0]!.dataset.unavailable).toBeUndefined();
  expect(chips.mode.disabled).toBe(false);
 }finally{chips.restore();}
});

test('revealing feedback does not click a stage chip, so Write review stays open (#726 review)',async()=>{
 const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
 expect(main).not.toMatch(/data-review-stage="\d"\]['"]?\)\??\.click\(\)/);
});
