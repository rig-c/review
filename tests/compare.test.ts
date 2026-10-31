import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCompare, assertCompareUnchanged, type ComparePackage } from '../src/compare.ts';
import { freshCompareSession, parseCompareSession, readCompareSession, saveCompareSession } from '../src/compare-session.ts';
import { startCompareServer } from '../src/compare-server.ts';

const dirs:string[]=[];afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
// Envelope-only transport probes; actual runtime controls use the separately gated fixture.
async function fixture(){const root=await mkdtemp(join(tmpdir(),'review-compare-'));dirs.push(root);for(const side of ['a','b']){await mkdir(join(root,side,'build'),{recursive:true});await writeFile(join(root,side,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'page.png'}],animations:[{name:'inspect',duration:2}],bones:[{name:'probe'}],slots:[],transportProbe:side}));await writeFile(join(root,side,'build/page.png'),side+' page bytes');await writeFile(join(root,side,'motion.json'),JSON.stringify({side}));}await writeFile(join(root,'ref.mp4'),'0123456789');return {root,inputs:{a:join(root,'a'),b:join(root,'b'),reference:join(root,'ref.mp4'),animation:'inspect'}};}
function note(){return {id:'one',side:'b' as const,frameStart:1,frameEnd:3,target:{kind:'bone' as const,name:'probe'},category:'quality' as const,summary:'Inspect the motion',context:{time:0.5,frame:null}};}
async function inventory(root:string){const names=(await readdir(root,{recursive:true})).sort();const values:Record<string,string>={};for(const n of names){const f=Bun.file(join(root,n));try{values[n]=await f.text();}catch{}}return values;}
test('comparison binds ordered package and reference identities without writing either source',async()=>{
 const f=await fixture(),before=await inventory(f.root);const p=await loadCompare(f.inputs);expect(p.response.mode).toBe('compare');expect(p.response.binding.a.reviewedSource.rig?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.response.binding.b.reviewedSource.motion?.sha256).toMatch(/^[a-f0-9]{64}$/);expect(p.response.binding.a.reviewedSource.rig).not.toEqual(p.response.binding.b.reviewedSource.rig);expect(p.response.reference.url).toBe('/compare-reference');expect(JSON.stringify(p.response)).not.toContain(f.root);expect(p.response.a.assetsBase).toBe('/compare-assets/a/');expect(p.response.b.assetsBase).toBe('/compare-assets/b/');
 const swapped=await loadCompare({...f.inputs,a:f.inputs.b,b:f.inputs.a});expect(swapped.response.sourceHash).not.toBe(p.response.sourceHash);expect(freshCompareSession(p).status).toBe('pending');expect(await inventory(f.root)).toEqual(before);
});
test('comparison session requires side and exact complete immutable provenance on save',async()=>{
 const f=await fixture(),p=await loadCompare(f.inputs),state=join(f.root,'state');const input={...freshCompareSession(p),status:'changes-requested',feedback:[note()]};const saved=await saveCompareSession(p,input,state);expect(saved.feedback[0]?.side).toBe('b');expect(saved.binding).toEqual(p.response.binding);expect(saved.updatedAt).toBeString();expect((await readCompareSession(p,state)).binding).toEqual(p.response.binding);
 for(const side of [undefined,'both','c'])expect(()=>parseCompareSession({...input,feedback:[{...note(),side}]},p)).toThrow('feedback.side');
 for(const binding of [{...p.response.binding,a:{...p.response.binding.a,sourceHash:'forged'}},{...p.response.binding,b:{...p.response.binding.b,reviewedSource:{...p.response.binding.b.reviewedSource,motion:null}}},{...p.response.binding,reference:{...p.response.binding.reference,sha256:'forged'}},{...p.response.binding,animation:'other'}])expect(()=>parseCompareSession({...input,binding},p)).toThrow('session.binding');
 expect(()=>parseCompareSession({...input,feedback:[note(),note()]},p)).toThrow('duplicate ids');
});
test('changing A or B model page, motion, model, or reference refuses both read and save',async()=>{
 for(const path of ['a/build/page.png','b/build/page.png','a/motion.json','b/motion.json','a/build/skeleton.model.json','b/build/skeleton.model.json','ref.mp4']){const f=await fixture(),p=await loadCompare(f.inputs),file=join(f.root,path),old=await readFile(file,'utf8');await writeFile(file,old+' ');await expect(assertCompareUnchanged(p)).rejects.toThrow('inputs changed');await expect(saveCompareSession(p,{...freshCompareSession(p),feedback:[note()]},join(f.root,'state'))).rejects.toThrow('inputs changed');await expect(readCompareSession(p,join(f.root,'state'))).rejects.toThrow('inputs changed');}
});
test('comparison refuses missing rig, animation, external package symlink and non-video reference',async()=>{
 const f=await fixture();await writeFile(join(f.root,'ref.txt'),'bytes');await expect(loadCompare({...f.inputs,reference:join(f.root,'ref.txt')})).rejects.toThrow('compare.reference');await rm(join(f.root,'a/build/skeleton.model.json'));await expect(loadCompare(f.inputs)).rejects.toThrow('compare.a.model');
 const other=await fixture();await rm(join(other.root,'a/build/page.png'));await symlink(join(other.root,'ref.mp4'),join(other.root,'a/build/page.png'));await expect(loadCompare(other.inputs)).rejects.toThrow('symlinks may not escape');
});
test('comparison animation refusal identifies each invalid side independently of parallel read order',async()=>{
 for(const side of ['a','b'] as const){const f=await fixture(),other=side==='a'?'b':'a',modelPath=join(f.root,other,'build/skeleton.model.json'),model=JSON.parse(await readFile(modelPath,'utf8'));model.animations.push({name:'only-other-side',duration:2});await writeFile(modelPath,JSON.stringify(model));await expect(loadCompare({...f.inputs,animation:'only-other-side'})).rejects.toThrow(`compare.${side}.animation: model has no animation "only-other-side"`);}
});
test('compare HTTP isolates sides and reference, guards mutations and detects delayed changed input',async()=>{
 const f=await fixture(),p=await loadCompare(f.inputs);const server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')});const base=`http://127.0.0.1:${server.port}`;try{
  const response=await fetch(base+'/api/compare');expect(response.status).toBe(200);expect((await response.json()).binding).toEqual(p.response.binding);expect((await fetch(base+'/api/review')).status).toBe(404);expect((await fetch(base+'/api/compare/session')).status).toBe(200);expect((await fetch(base+'/api/compare',{headers:{Host:'evil.test'}})).status).toBe(403);
  expect(await (await fetch(base+'/compare-assets/a/build/page.png')).text()).toBe('a page bytes');expect(await (await fetch(base+'/compare-assets/b/build/page.png')).text()).toBe('b page bytes');expect((await fetch(base+'/compare-assets/c/build/page.png')).status).toBe(404);expect((await fetch(base+'/compare-assets/a/not-declared')).status).toBe(404);expect((await fetch(base+'/compare-reference/secret')).status).toBe(404);expect((await fetch(base+'/api/file?path=/etc/passwd')).status).toBe(404);expect((await fetch(base+'/compare-assets/a/%252e%252e/ref.mp4')).status).toBe(400);
  const video=await fetch(base+'/compare-reference',{headers:{Range:'bytes=2-5'}});expect(video.status).toBe(206);expect(video.headers.get('content-range')).toBe('bytes 2-5/10');expect(await video.text()).toBe('2345');expect((await fetch(base+'/compare-reference',{headers:{Range:'bytes=99-100'}})).status).toBe(416);
  const input={...freshCompareSession(p),feedback:[note()]},headers={Origin:base,'Content-Type':'application/json'};expect((await fetch(base+'/api/compare/session',{method:'PUT',headers:{...headers,Origin:'http://evil.test'},body:JSON.stringify(input)})).status).toBe(403);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers:{...headers,'Content-Type':'text/plain'},body:'{}'})).status).toBe(400);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify({padding:'x'.repeat(1024*1024)})})).status).toBe(400);expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify({...input,feedback:[{...note(),side:'both'}]})})).status).toBe(400);
  expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify(input)})).status).toBe(200);const stored=await(await fetch(base+'/api/compare/session')).json();expect(stored.feedback[0].side).toBe('b');expect(stored.binding).toEqual(p.response.binding);
  const body=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(new TextEncoder().encode('{'));await Bun.sleep(20);await writeFile(join(f.root,'b/motion.json'),'changed');controller.enqueue(new TextEncoder().encode(JSON.stringify(input).slice(1)));controller.close();}});expect((await fetch(base+'/api/compare/session',{method:'PUT',headers,body})).status).toBe(409);expect((await fetch(base+'/api/compare')).status).toBe(409);
 }finally{await server.stop(true);}
});
test('compare check and feedback CLI preserve single-mode syntax and require explicit inputs',async()=>{
 const f=await fixture();for(const command of ['check','feedback']){const proc=Bun.spawn([process.execPath,'src/cli.ts',command,'compare',f.inputs.a,f.inputs.b,'--reference',f.inputs.reference,'--animation','inspect'],{stdout:'pipe',stderr:'pipe'});const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);if(command==='check')expect(output).toContain('Playback: two compiled models present');else{const session=JSON.parse(output);expect(session.schema).toBe('rig-review-compare-session/1');expect(session.status).toBe('pending');expect(session.updatedAt).toBeNull();}}
 const missing=Bun.spawn([process.execPath,'src/cli.ts','check','compare',f.inputs.a,f.inputs.b],{stdout:'pipe',stderr:'pipe'});expect(await missing.exited).toBe(1);expect(await new Response(missing.stderr).text()).toContain('--reference and --animation are required');
});
test('reference GET, HEAD and ranges refuse replaced leaf or parent symlinks',async()=>{
 for(const replace of ['leaf','parent']){const f=await fixture();const referenceDir=join(f.root,'reference'),outside=join(f.root,'outside');await mkdir(referenceDir);await mkdir(outside);await writeFile(join(referenceDir,'ref.mp4'),'selected bytes');await writeFile(join(outside,'ref.mp4'),'OUTSIDE SECRET');const p=await loadCompare({...f.inputs,reference:join(referenceDir,'ref.mp4')});const server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')});try{
   if(replace==='leaf'){await rm(join(referenceDir,'ref.mp4'));await symlink(join(outside,'ref.mp4'),join(referenceDir,'ref.mp4'));}else{await rename(referenceDir,referenceDir+'-original');await symlink(outside,referenceDir);}
   for(const init of [{method:'GET'},{method:'HEAD'},{headers:{Range:'bytes=0-6'}}]){const response=await fetch(`http://127.0.0.1:${server.port}/compare-reference`,init);expect(response.status).toBe(400);expect(await response.text()).not.toContain('OUTSIDE SECRET');}
 }finally{await server.stop(true);}}
});


test('comparison reference refuses same-size overwritten and atomically replaced bytes for GET/HEAD/ranges',async()=>{
 for(const replacement of ['overwrite','atomic']){const f=await fixture(),p=await loadCompare(f.inputs),server=await startCompareServer(p,{port:0,stateDir:join(f.root,'state')}),url=`http://127.0.0.1:${server.port}/compare-reference`;try{
  await utimes(f.inputs.reference,new Date(0),new Date(1000));const original=await fetch(url,{headers:{Range:'bytes=2-5'}});expect(original.status).toBe(206);expect(await original.text()).toBe('2345');expect((await fetch(url,{method:'HEAD'})).status).toBe(200);
  if(replacement==='overwrite')await writeFile(f.inputs.reference,'9876543210');else{await writeFile(f.inputs.reference+'.next','9876543210');await rename(f.inputs.reference+'.next',f.inputs.reference);}await utimes(f.inputs.reference,new Date(0),new Date(1000));
  for(const init of [{method:'GET'},{method:'HEAD'},{headers:{Range:'bytes=2-5'}}]){const response=await fetch(url,init);expect(response.status).toBe(409);if(init.method!=='HEAD')expect(await response.text()).not.toContain('9876543210');}
 }finally{await server.stop(true);}}
});

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { assertSharedCompareMarkup, extractSharedWorkspaceMarkup, renderCompareHtml, type SharedWorkspaceMarkup } from '../src/compare-html.ts';
import { frontRoute } from '../src/front.ts';
import { openReview } from '../src/open.ts';
import { decodeBookmark, encodeBookmark, parseBookmark, type InspectionBinding, type InspectionBookmark } from '../web/inspection-persistence.ts';
import { stageCommentMode } from '../src/stage-comment.ts';

test('single and compare shells share Setup · Animate · Compare top switch and identical Setup/Animate markup, failing on a planted difference', async () => {
  const [indexHtml, compareTemplate] = await Promise.all([
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../web/compare.html', import.meta.url), 'utf8'),
  ]);
  expect(indexHtml).toContain('data-mode="compare" aria-pressed="false" disabled title="No second build supplied: reopen with --compare &lt;built&gt; --reference &lt;video&gt;">Compare</button>');
  expect(compareTemplate).toContain('data-mode="rig" aria-pressed="false">Setup</button>');
  expect(compareTemplate).toContain('data-mode="playback" aria-pressed="false">Animate</button>');
  expect(compareTemplate).toContain('data-mode="compare" aria-pressed="true">Compare</button>');
  const rendered = renderCompareHtml(compareTemplate, indexHtml);
  expect(() => assertSharedCompareMarkup(rendered, indexHtml)).not.toThrow();
  const shared = extractSharedWorkspaceMarkup(indexHtml);
  const keys = Object.keys(shared) as (keyof SharedWorkspaceMarkup)[];
  expect(keys.length).toBe(9);
  for (const key of keys) {
    const planted = rendered.replace(shared[key], shared[key] + '<!-- planted-difference -->');
    expect(() => assertSharedCompareMarkup(planted, indexHtml)).toThrow(`COMPARE_SHARED_MARKUP_DRIFT: ${key}`);
  }
  const missingPlaceholder = compareTemplate.replace('<!-- shared:setup-panels -->', '');
  expect(() => renderCompareHtml(missingPlaceholder, indexHtml)).toThrow('COMPARE_SHARED_MARKUP_MISSING: placeholder <!-- shared:setup-panels -->');
});

test('compare bookmarks and stage comments carry setup, animate and compare modes and reject mismatched mode/inspector pairs', () => {
  const compareBinding: InspectionBinding = { mode: 'compare', sourceHash: 'a'.repeat(64), rigs: ['b'.repeat(64), 'c'.repeat(64)] };
  const singleBinding: InspectionBinding = { mode: 'single', sourceHash: 'a'.repeat(64), rigs: ['b'.repeat(64)] };
  const cam = (space: 'world' | 'image') => ({ space, center: { x: 0, y: 0 }, zoom: 1, viewport: { width: 100, height: 100 }, visible: { x: -50, y: -50, width: 100, height: 100 } });
  const baseView = {
    schema: 'rig-review-view/1' as const,
    cameraSync: true,
    activeCamera: 'a' as const,
    cameras: { rig: null, a: cam('world'), b: cam('world'), reference: cam('image') },
  };
  for (const [mode, inspector, side] of [['setup', 'rig', 'a'], ['animate', 'playback', 'b'], ['compare', 'view', 'a']] as const) {
    const bm: InspectionBookmark = {
      schema: 'rig-review-inspection/1',
      binding: compareBinding,
      animation: 'inspect',
      time: 0.5,
      theme: 'dark',
      layers: { images: true, meshes: false, bones: false },
      view: baseView,
      selection: { reference: 'd'.repeat(64), inspector, mode, side },
    };
    const parsed = decodeBookmark(encodeBookmark(bm), compareBinding)!;
    expect(parsed.selection.mode).toBe(mode);
    expect(parsed.selection.side).toBe(side);
    expect(stageCommentMode({ mode, viewport: 'a', bookmark: parsed })).toBe(mode);
  }
  // Legacy compare link without selection.mode or selection.side still parses cleanly.
  const legacyParsed = parseBookmark({
    schema: 'rig-review-inspection/1',
    binding: compareBinding,
    animation: 'inspect',
    time: 0.25,
    theme: 'system',
    layers: { images: true, meshes: false, bones: false },
    view: baseView,
    selection: { reference: 'd'.repeat(64), inspector: 'view' },
  }, compareBinding);
  expect(legacyParsed.selection.mode).toBeUndefined();
  expect(stageCommentMode({ mode: 'compare', viewport: 'a', bookmark: legacyParsed })).toBe('compare');
  // Mismatched mode and inspector in compare session is rejected.
  expect(() => stageCommentMode({ mode: 'setup', viewport: 'a', bookmark: legacyParsed })).toThrow('COMMENT_MODE_MISMATCH');
  // Single session rejects compare mode or side in bookmark.
  expect(() => parseBookmark(
    {
      schema: 'rig-review-inspection/1',
      binding: singleBinding,
      animation: 'inspect',
      time: 0,
      theme: 'dark',
      layers: { images: true, meshes: false, bones: false },
      view: { schema: 'rig-review-view/1', cameraSync: true, activeCamera: 'rig', cameras: { rig: cam('world'), a: null, b: null, reference: null } },
      selection: { inspector: 'rig', mode: 'compare' },
    },
    singleBinding,
  )).toThrow('Compare mode is unavailable without a second build');
});

test('managed front allowlists /api/compare/(a|b)/* and /compare-rebuild/(a|b)/:id/*, and Apply through the front rebuilds only the picked side', async () => {
  const id = 'a'.repeat(64), cid = 'b'.repeat(64);
  expect(frontRoute('compare', 'GET', '/api/compare/a/rebuild')).toMatchObject({ limit: 0, mutation: false });
  expect(frontRoute('compare', 'POST', '/api/compare/b/rebuild')).toMatchObject({ mutation: true, limit: 64 * 1024 });
  expect(frontRoute('compare', 'GET', `/api/compare/a/rebuild/${id}`)).toMatchObject({ limit: 0, mutation: false });
  expect(frontRoute('compare', 'GET', '/api/compare/b/rebuild/history')).toMatchObject({ limit: 0, mutation: false });
  expect(frontRoute('compare', 'POST', '/api/compare/a/rebuild/undo')).toMatchObject({ mutation: true });
  expect(frontRoute('compare', 'GET', `/compare-rebuild/a/${id}/skeleton.model.json`)).toMatchObject({ limit: 0, mutation: false });
  expect(frontRoute('compare', 'GET', `/compare-density-strip/b/${id}/${cid}/skeleton.model.json`)).toMatchObject({ limit: 0, mutation: false });
  expect(frontRoute('compare', 'POST', '/api/rebuild')).toBeNull();
  expect(frontRoute('compare', 'GET', '/api/compare/c/rebuild')).toBeNull();
  expect(frontRoute('single', 'GET', '/api/compare/a/rebuild')).toBeNull();

  const root = await realpath(await mkdtemp(join(tmpdir(), 'review-compare-rebuild-')));
  dirs.push(root);
  const bust = { name: 'bust', shape: 'circle' as const, cx: 414, cy: 342, r: 50, bone: 'probe', spacing: 13, band: 30 };
  const makeCfg = (r: number) => ({ key: 'k', meshes: { topwear: { contour: { tolerance: 2, margin: 2, spacing: 28, maxEdge: 45, stray: 300, bridges: true, regions: [{ ...bust, r }] }, r: 15, segments: [['probe', [416, 230], [416, 600]]] } } });
  const fakeParts = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log('1.42.0');process.exit(0);}
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));console.log('rig-parts rig: wrote '+out);process.exit(0);}
const out=f('--out');fs.mkdirSync(out,{recursive:true});const mesh=fs.readFileSync(f('--mesh'),'utf8');
fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({mesh:JSON.parse(mesh)}));fs.writeFileSync(path.join(out,'motion.json'),'{}');
fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part:f('--part'),page_edges:'free',pack_shape:'polygon'},target:{before:{vertices:10,triangles:8,hull:4},after:{vertices:12,triangles:10,hull:4}}}));
console.log('rig-parts remesh: wrote 3 file(s) under '+out);`;
  const fakeRigc = `const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='--version'){console.log('2.64.1');process.exit(0);}
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'page.png'}],animations:[{name:'inspect',duration:2}],bones:[{name:'probe'}],slots:[],regions:rig.mesh.contour.regions}));
fs.writeFileSync(path.join(out,'page.png'),'rebuilt-png');console.log('rigc: wrote '+path.join(out,'skeleton.model.json'));`;

  await mkdir(join(root, 'node_modules/@rig-c/parts/bin'), { recursive: true });
  await mkdir(join(root, 'node_modules/rig-c/bin'), { recursive: true });
  await writeFile(join(root, 'node_modules/@rig-c/parts/package.json'), JSON.stringify({ name: '@rig-c/parts', version: '1.42.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }));
  await writeFile(join(root, 'node_modules/@rig-c/parts/bin/rig-parts.cjs'), fakeParts);
  await writeFile(join(root, 'node_modules/rig-c/package.json'), JSON.stringify({ name: 'rig-c', version: '2.64.1', bin: { rigc: './bin/rigc.cjs' } }));
  await writeFile(join(root, 'node_modules/rig-c/bin/rigc.cjs'), fakeRigc);

  for (const [side, r] of [['a', 50], ['b', 55]] as const) {
    const pkg = join(root, side);
    await mkdir(join(pkg, 'build'), { recursive: true });
    await mkdir(join(pkg, 'rig/out/rig'), { recursive: true });
    await mkdir(join(pkg, 'rig/out/parts'), { recursive: true });
    await writeFile(join(pkg, 'rig/config.json'), JSON.stringify(makeCfg(r), null, 1));
    await writeFile(join(pkg, 'rig/out/parts.json'), '{}');
    for (const n of ['rig.json', 'motion.json', 'mesh_report.json']) await writeFile(join(pkg, 'rig/out/rig', n), '{}');
    await writeFile(join(pkg, 'build/skeleton.model.json'), JSON.stringify({ spec: 'rigc-compiled/3', pages: [{ name: 'page.png' }], animations: [{ name: 'inspect', duration: 2 }], bones: [{ name: 'probe' }], slots: [], side }));
    await writeFile(join(pkg, 'build/page.png'), side + ' page bytes');
    await writeFile(join(pkg, 'motion.json'), JSON.stringify({ side }));
  }
  const refPath = join(root, 'ref.mp4');
  await writeFile(refPath, '0123456789');
  const treeHash = async (dir: string): Promise<string> => {
    const h = createHash('sha256');
    for (const name of (await readdir(dir, { recursive: true })).sort()) {
      const full = join(dir, name);
      try { h.update(name); h.update(await readFile(full)); } catch {}
    }
    return h.digest('hex');
  };
  const beforeA = await treeHash(join(root, 'a')), beforeB = await treeHash(join(root, 'b'));
  const stateDir = join(root, 'state');
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const frontPort = probe.port!;
  probe.stop(true);

  const opened = await openReview({ input: join(root, 'a'), compare: join(root, 'b'), reference: refPath, animation: 'inspect' }, { stateDir, frontPort });
  const frontOrigin = `http://127.0.0.1:${frontPort}`;
  const base = frontOrigin + new URL(opened.url).pathname;
  const cap = new URL(opened.url).hash.slice(5);
  const headers = { Origin: frontOrigin, 'Content-Type': 'application/json', 'X-Review-Capability': cap };
  try {
    const landing = await fetch(opened.url);
    expect(landing.status).toBe(200);
    const html = await landing.text();
    const indexHtml = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
    expect(() => assertSharedCompareMarkup(html, indexHtml)).not.toThrow();

    const statusA = await (await fetch(base + 'api/compare/a/rebuild')).json();
    const statusB = await (await fetch(base + 'api/compare/b/rebuild')).json();
    expect(statusA.available).toBe(true);
    expect(statusB.available).toBe(true);

    // Apply on picked Build A through the managed front.
    const movedA = { ...bust, cx: 430 };
    const startA = await fetch(base + 'api/compare/a/rebuild', {
      method: 'POST',
      headers,
      body: JSON.stringify({ part: 'topwear', regions: [movedA], configHash: statusA.inputs.configHash }),
    });
    expect(startA.status).toBe(202);
    let jobA = await startA.json();
    for (let i = 0; jobA.status === 'running' && i < 200; i++) {
      await Bun.sleep(25);
      jobA = await (await fetch(`${base}api/compare/a/rebuild/${jobA.id}`)).json();
    }
    expect(jobA.status).toBe('built');
    expect(jobA.build.modelUrl).toBe(`/compare-rebuild/a/${jobA.id}/skeleton.model.json`);
    const modelResA = await fetch(base + jobA.build.modelUrl.slice(1));
    expect(modelResA.status).toBe(200);
    expect((await modelResA.json()).regions).toEqual([movedA]);

    // Build B's history is still empty and both input packages on disk are untouched.
    const histA = await (await fetch(base + 'api/compare/a/rebuild/history')).json();
    const histB = await (await fetch(base + 'api/compare/b/rebuild/history')).json();
    expect(histA.depth).toBe(1);
    expect(histB.depth).toBe(0);
    expect(await treeHash(join(root, 'a'))).toBe(beforeA);
    expect(await treeHash(join(root, 'b'))).toBe(beforeB);
  } finally {
    for (const name of await readdir(join(stateDir, 'open')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(stateDir, 'open', name), 'utf8'));
        if (rec.pid) process.kill(rec.pid, 'SIGTERM');
      } catch {}
    }
  }
}, 60000);
