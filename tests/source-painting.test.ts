import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview,type ReviewPackage} from '../src/manifest.ts';
import {HandoffError} from '../src/handoff.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import {sessionFile} from '../src/session.ts';
import {startServer} from '../src/server.ts';

// #329: when the producer handoff knows the source painting, the reference pane shows that painting first and selects
// it on open; the contact sheet stays a later option, and a handoff with no painting leaves the references as they were.
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const PAINTING='painting-bytes';
async function scratch(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-source-painting-')));return {root,done:()=>rm(root,{recursive:true,force:true})};}
/** What `rig-parts build --config <proj>/config.json --out <proj>/out` leaves, with the contact sheet check/ writes. */
async function built(root:string){
 const proj=join(root,'proj'),out=join(proj,'out'),check=join(out,'check');
 await mkdir(join(out,'rig'),{recursive:true});await mkdir(join(out,'parts'),{recursive:true});await mkdir(join(check,'build'),{recursive:true});await mkdir(join(proj,'inputs/full'),{recursive:true});
 await writeFile(join(proj,'config.json'),JSON.stringify({key:'k'}));await writeFile(join(proj,'inputs/full/layer.png'),'layer');
 await writeFile(join(out,'parts.json'),JSON.stringify({parts:[{name:'a'}]}));await writeFile(join(out,'parts/a.png'),'png-a');
 for(const file of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(out,'rig',file),`{"${file}":1}`);
 await writeFile(join(check,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],animations:[{name:'idle',duration:1}]}));await writeFile(join(check,'build/skeleton.png'),'png');
 await writeFile(join(check,'contact.png'),'contact-sheet');
 return {proj,out,check};
}
const refusal=async(run:()=>Promise<unknown>)=>{const error=await run().then(()=>null,e=>e);expect(error).toBeInstanceOf(HandoffError);return {code:(error as HandoffError).code,field:(error as HandoffError).field};};
/** The painting is the first reference, the first checkpoint's, and so the one the page selects on open. */
function paintingFirst(p:ReviewPackage,shown:string){
 const [first,second]=p.manifest.references;
 expect(first).toMatchObject({id:'source-painting',type:'image',label:'Original painting · painting.png'});
 expect(second).toMatchObject({type:'image',label:'contact.png',path:'contact.png'});
 expect(p.manifest.checkpoints[0]).toMatchObject({reference:'source-painting'});
 expect(initialReviewSelection(p.manifest,null).referenceId).toBe('source-painting');
 expect(p.referenceHashes!['source-painting']).toBe(sha(PAINTING));
 expect(p.reviewedSource.handoff!.source).toEqual({path:shown,sha256:sha(PAINTING)});
 // Outside the package: never an asset path the package serves.
 expect(p.files.has(first!.path)).toBe(false);
}

test('bar 1: a build root with ../config.json and ../painting.png opens with the painting first and selected',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);await writeFile(join(b.proj,'painting.png'),PAINTING);
  const p=await loadReview(b.out);
  expect(p.root).toBe(b.check);expect(p.reviewedSource.handoff).toMatchObject({how:'discovered',outside:true,config:{path:'../../config.json'}});
  paintingFirst(p,'../../painting.png');expect(p.handoff!.source).toBe(join(b.proj,'painting.png'));
  // Changed painting bytes give a new identity and a new session, like any other reference.
  const before=p.sourceHash,session=sessionFile(p,'/state');await writeFile(join(b.proj,'painting.png'),PAINTING+'!');
  const changed=await loadReview(b.out);expect(changed.sourceHash).not.toBe(before);expect(sessionFile(changed,'/state')).not.toBe(session);
 }finally{await s.done();}
});

test('bar 1: an opened out/ folder with ../config.json and ../painting.png beside it does the same',async()=>{
 const s=await scratch();
 try{
  const proj=join(s.root,'plain'),out=join(proj,'out');await mkdir(out,{recursive:true});
  await writeFile(join(proj,'config.json'),'{}');await writeFile(join(proj,'painting.png'),PAINTING);await writeFile(join(out,'contact.png'),'contact-sheet');
  paintingFirst(await loadReview(out),'../painting.png');
 }finally{await s.done();}
});

test('bar 2: a declared --source gives the same result',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);await writeFile(join(b.proj,'inputs/painting.png'),PAINTING);
  const p=await loadReview(b.out,{handoff:{config:join(b.proj,'config.json'),source:join(b.proj,'inputs/painting.png'),full:join(b.proj,'inputs/full')}});
  expect(p.reviewedSource.handoff).toMatchObject({how:'declared',via:'open --config'});
  paintingFirst(p,'../../inputs/painting.png');
 }finally{await s.done();}
});

test('bar 3: with no painting the references, checkpoints and identity are byte-for-byte today\'s',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root),p=await loadReview(b.out);
  expect(JSON.stringify(p.manifest.references)).toBe('[{"id":"strip-1","label":"contact.png","type":"image","path":"contact.png"}]');
  expect(JSON.stringify(p.manifest.checkpoints)).toBe('[{"id":"strip-1","title":"Inspect contact.png","reference":"strip-1","workspace":"motion"}]');
  expect(p.reviewedSource.handoff!.source).toBeNull();expect(p.handoff!.source).toBeNull();
  expect(p.referenceHashes).toEqual({'strip-1':sha('contact-sheet')});
  // The source hash measured on the tree before #329 for this exact fixture.
  expect(p.sourceHash).toBe(NO_PAINTING_SOURCE_HASH);
  // A painting somewhere other than beside the config is not searched for.
  await writeFile(join(b.proj,'inputs/painting.png'),PAINTING);await writeFile(join(b.out,'painting.png'),PAINTING);
  expect((await loadReview(b.out)).sourceHash).toBe(NO_PAINTING_SOURCE_HASH);
 }finally{await s.done();}
});
const NO_PAINTING_SOURCE_HASH='77fc368c755ec02b084180c11d3dade23f7faf7d31e77fccc85a46b1b80fc5e6';

test('bar 4: a ../painting.png that escapes by symlink, is a symlink at all, or is not a regular file is refused by name',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root),place=join(b.proj,'painting.png');
  await writeFile(join(s.root,'elsewhere.png'),PAINTING);await symlink(join(s.root,'elsewhere.png'),place);
  expect(await refusal(()=>loadReview(b.out))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'../../painting.png'});
  // Even a symlink that stays inside the folder: only the file beside the config is discovered, as for the config itself.
  await rm(place);await writeFile(join(b.proj,'inputs/painting.png'),PAINTING);await symlink(join(b.proj,'inputs/painting.png'),place);
  expect(await refusal(()=>loadReview(b.out))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'../../painting.png'});
  await rm(place);await symlink(join(b.proj,'missing.png'),place);
  expect(await refusal(()=>loadReview(b.out))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'../../painting.png'});
  await rm(place);await mkdir(place);
  expect(await refusal(()=>loadReview(b.out))).toEqual({code:'HANDOFF_INPUT_INVALID',field:'../../painting.png'});
  // The opened-out/ step names its own place.
  const proj=join(s.root,'plain'),out=join(proj,'out');await mkdir(out,{recursive:true});await writeFile(join(proj,'config.json'),'{}');await writeFile(join(out,'contact.png'),'c');
  await symlink(join(s.root,'elsewhere.png'),join(proj,'painting.png'));
  expect(await refusal(()=>loadReview(out))).toEqual({code:'HANDOFF_SYMLINK_ESCAPE',field:'../painting.png'});
 }finally{await s.done();}
});

test('the server serves the painting by its pinned hash at a fixed URL, never by a package path, and names no absolute path',async()=>{
 const s=await scratch();
 try{
  const b=await built(s.root);await writeFile(join(b.proj,'painting.png'),PAINTING);
  const p=await loadReview(b.out),server=await startServer(p,{port:0,stateDir:join(s.root,'state')}),base=`http://127.0.0.1:${server.port}`;
  try{
   const data=await (await fetch(base+'/api/review')).json();
   expect(data.sourcePainting).toEqual({id:'source-painting',path:'../../painting.png',sha256:sha(PAINTING),url:'/review-painting'});
   expect(data.manifest.references[0].id).toBe('source-painting');expect(JSON.stringify(data)).not.toContain(s.root);
   const response=await fetch(base+'/review-painting');expect(response.status).toBe(200);expect(await response.text()).toBe(PAINTING);
   expect(response.headers.get('content-security-policy')).toContain('sandbox');
   expect((await fetch(base+'/assets/'+encodeURIComponent(p.manifest.references[0]!.path))).status).toBe(404);
   await writeFile(join(b.proj,'painting.png'),PAINTING+'!');expect((await fetch(base+'/review-painting')).status).toBe(409);
  }finally{server.stop(true);}
  // Without a painting there is no such key and no such route.
  await rm(join(b.proj,'painting.png'));const plain=await loadReview(b.out),other=await startServer(plain,{port:0,stateDir:join(s.root,'state')});
  try{const data=await (await fetch(`http://127.0.0.1:${other.port}/api/review`)).json();expect('sourcePainting' in data).toBe(false);expect((await fetch(`http://127.0.0.1:${other.port}/review-painting`)).status).toBe(404);}finally{other.stop(true);}
 }finally{await s.done();}
});

test('inside the opened folder the painting beside config.json is taken; a review.json keeps its own first checkpoint',async()=>{
 const s=await scratch();
 try{
  const folder=join(s.root,'folder');await mkdir(folder);await writeFile(join(folder,'config.json'),'{}');await writeFile(join(folder,'painting.png'),PAINTING);await writeFile(join(folder,'contact.png'),'contact-sheet');
  paintingFirst(await loadReview(folder),'painting.png');
  // An authored package: the painting is listed first, the authored checkpoints are not rewritten.
  const pkg=join(s.root,'pkg');await mkdir(join(pkg,'inputs/full'),{recursive:true});await writeFile(join(pkg,'config.json'),'{}');await writeFile(join(pkg,'inputs/painting.png'),PAINTING);await writeFile(join(pkg,'inputs/full/a.png'),'a');await writeFile(join(pkg,'contact.png'),'c');
  const manifest={schema:'rig-review/1',id:'pkg',title:'pkg',revision:'r1',references:[{id:'sheet',label:'Sheet',type:'image',path:'contact.png'}],checkpoints:[{id:'one',title:'One'}],producer:{config:'config.json',source:'inputs/painting.png',full:'inputs/full'}};
  await writeFile(join(pkg,'review.json'),JSON.stringify(manifest));
  const p=await loadReview(pkg);expect(p.manifest.references.map(r=>r.id)).toEqual(['source-painting','sheet']);expect(p.manifest.checkpoints.map(c=>c.id)).toEqual(['one']);
  expect(initialReviewSelection(p.manifest,null).referenceId).toBe('source-painting');
  await writeFile(join(pkg,'review.json'),JSON.stringify({...manifest,checkpoints:[{id:'one',title:'One',reference:'sheet'}]}));
  expect(initialReviewSelection((await loadReview(pkg)).manifest,null).referenceId).toBe('sheet');
 }finally{await s.done();}
});

test('the managed front passes the painting route through for single reviews only, read only',async()=>{
 const {frontRoute}=await import('../src/front.ts');
 for(const method of ['GET','HEAD'])expect(frontRoute('single',method,'/review-painting')).toMatchObject({mutation:false});
 expect(frontRoute('single','POST','/review-painting')).toBeNull();expect(frontRoute('compare','GET','/review-painting')).toBeNull();
});
