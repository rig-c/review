import {test,expect} from 'bun:test';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {stagePartsRoutes} from '../src/stage-parts.ts';
import {frontRoute} from '../src/front.ts';
import {loadPartsAtlas,loadPartsView,verdictSource} from '../src/parts-view.ts';
import {reviewStages,stageReason} from '../web/stage-nav.ts';

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
 expect(enCatalog[key]).toContain('rig-review interview');expect(koCatalog[key]).toContain('rig-review interview');
 for(const file of ['web/interview.ts','web/interview-panel.ts']){
  const source=await readFile(file,'utf8');
  const keys=[...new Set(source.match(/interview\.[A-Za-z]+/g))].filter(key=>!['interview.ts','interview.js'].includes(key));
  expect(keys.length).toBeGreaterThan(0);
  for(const k of keys){expect(enCatalog[k],k).toBeTruthy();expect(koCatalog[k],k).toBeTruthy();}
 }
});
