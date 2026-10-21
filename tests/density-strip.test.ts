import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {boundedStripConcurrency,defaultStripConcurrency} from '../src/rebuild.ts';
import {revisionBinding} from '../src/retune-check.ts';
import {stripPendingAfter} from '../web/rebuild-client.ts';
import {candidateRow,DENSITY_STRIP_LIMIT,DensityStripError,refineValues,stripFigures,stripLabels,stripShape,stripValues,type StripRow} from '../src/density-strip.ts';

/**
 * #173: the density strip. The stand-in `remesh` re-fits `bottomwear`'s grid entry: triangles 4000/grid (44 from grid 80
 * up, so 80 and 90 tie), TIP_OVER_ROOT's ratio 3 − grid/60 against the floor 1.4725 and TEXTURE_STRETCH severity
 * 1 + 10/grid against its ceiling, printed as remesh prints its revision check (`[check-revision] …`); from grid 89 the
 * revision misses TIP_OVER_ROOT and remesh refuses `REMESH_CHECK_HELD`. A built revision carries its check in
 * remesh.json (`check.revision.line` / `status`, parts 1.49.1, #174) bound by its hash rows. Each run sleeps 300 ms and
 * logs S/E beside the stand-in, so the overlap of runs is readable.
 */
const FLOOR=1.4725,CEIL=1.926544;
const entry={grid:31,r:15,segments:['skirt0a'],stray:40};
const config={key:'k',meshes:{bottomwear:entry,topwear:{contour:{tolerance:2,margin:2,spacing:28},r:15,segments:['chest']}}};
const fakeParts=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');const runs=path.join(__dirname,'runs');
const tree=root=>{const out=[];const walk=d=>{for(const n of fs.readdirSync(d).sort()){const p=path.join(d,n);if(fs.statSync(p).isDirectory())walk(p);else out.push(path.relative(root,p).split(path.sep).join('/'));}};walk(root);return out.sort();};
const copy=(src,out)=>{for(const r of tree(src)){fs.mkdirSync(path.dirname(path.join(out,r)),{recursive:true});fs.copyFileSync(path.join(src,r),path.join(out,r));}};
if(a[0]==='remesh'){fs.appendFileSync(path.join(__dirname,'args'),JSON.stringify(a)+'\\n');fs.appendFileSync(runs,'S\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
 const out=f('--out'),input=f('--rig'),part=f('--part'),e=JSON.parse(fs.readFileSync(f('--mesh'),'utf8')),g=e.grid;
 const parts=f('--parts'),binding={versions:{parts:JSON.parse(fs.readFileSync(path.join(__dirname,'../package.json'))).version,rigc:'2.64.1'},options:{page_edges:a.includes('--page-edges')?f('--page-edges'):'free',pack_shape:a.includes('--pack-shape')?f('--pack-shape'):'polygon',requirements:null},rig:{dir:path.resolve(input),files:tree(input).map(p=>[p,sha(fs.readFileSync(path.join(input,p)))])},parts:{dir:path.resolve(parts),files:[['parts.json',sha(fs.readFileSync(path.join(parts,'parts.json')))]]}};
 if(a.includes('--input-check')){let record;try{record=JSON.parse(fs.readFileSync(f('--input-check'),'utf8'));if(record.spec!=='rig-parts-input-check/1'||!record.rig||!record.parts||!record.check)throw Error();}catch{console.log('  FAIL  REMESH_INPUT_CHECK_FILE: invalid input-check.json');fs.appendFileSync(runs,'E\\n');process.exit(1);}
 if(JSON.stringify({versions:record.versions,options:record.options,rig:record.rig,parts:record.parts})!==JSON.stringify(binding)){console.log('  FAIL  REMESH_INPUT_CHECK_BOUND: rig.dir or input hash row differs');fs.appendFileSync(runs,'E\\n');process.exit(1);}
 console.log('  check-input: not run — recorded check bound to this input');
 }else fs.appendFileSync(path.join(__dirname,'input-check-runs'),'x\\n');
 const tris=g>=80?44:Math.round(4000/g),verts=Math.round(tris*0.7),ratio=+(3-g/60).toFixed(3),sev=+(1+10/g).toFixed(3),pass=ratio>=${FLOOR};
 console.log('rig-parts remesh: '+part);console.log('  '+part+': v=130 t=204 hull=54 -> v='+verts+' t='+tris+' hull=40');
 console.log('[check-revision]   TIP_OVER_ROOT: '+(pass?'PASS':'FAIL')+' — instrument geometry; parts part forearm_l, unmeasured a limb segment (config.limbs.arm_l), rigid on its one bone "sleeve_l1" | part '+part+', root_rig_px 2.545, tip_rig_px 5.078, ratio '+ratio+'; ratio_floor ${FLOOR}');
 console.log('[check-revision]   TEXTURE_STRETCH: PASS — meshes 2; triangles 300; frames 41; severity '+sev+'; severity_ceiling ${CEIL}; worst slot '+part+', triangle 4, vertices 1 | 2 | 3, edge 2 | 3, frame 40, ratio '+sev+'; max_ratio '+sev+'; min_ratio 0.9; per_mesh slot hair_back, triangles 256, max_ratio 1.068, max_at triangle 221 (vertices 126 125 200), edge 126-125, idle frame 5, min_ratio 0.925, min_at triangle 47 (vertices 159 161 162), edge 161-162, idle frame 5, severity 1.082 | slot '+part+', triangles '+tris+', max_ratio '+sev+', max_at triangle 4 (vertices 1 2 3), edge 2-3, idle frame 40, min_ratio 0.9, min_at triangle 9 (vertices 4 5 6), edge 5-4, idle frame 7, severity '+sev);
 console.log('[check-revision]   ANIMATIONS_DO_NOT_FOLD: PASS — 1 animation(s) read by rigc render --folds at 12 fps (idle): 0 folding mesh(es), 0 not declared in may_fold (<= 0)');
 const line=pass?'check: PASS; 3 of 3 bar(s) measured':'check: FAIL — 1 bar(s) not met';console.log('[check-revision] '+line);
 if(!pass){console.log('  FAIL  REMESH_CHECK_HELD: check bar TIP_OVER_ROOT — met on the input and not on the revision: CHECK_TIP_OVER_ROOT: part "'+part+'" ratio '+ratio+'; a ratio >= ${FLOOR} is required');console.log('refused: 1 problem(s)');fs.appendFileSync(runs,'E\\n');process.exit(1);}
 copy(input,out);const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.mesh=e;rig.tris=tris;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 const rows=tree(out).map(p=>{const b=fs.readFileSync(path.join(out,p));return {path:p,bytes:b.length,sha256:sha(b)};});
 const status={gate:'PASS',loop:'PASS',seam:'PASS',TIP_OVER_ROOT:'PASS',TEXTURE_STRETCH:'PASS',ANIMATIONS_DO_NOT_FOLD:'PASS'};
 fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({spec:'rig-parts-remesh/1',request:{part,mesh:e,page_edges:'free',pack_shape:'polygon'},target:{before:{vertices:130,triangles:204,hull:54},after:{vertices:verts,triangles:tris,hull:40}},revision:rows,check:{input:{pass:true,line:'check: PASS; 3 of 3 bar(s) measured',status},revision:{pass:true,line,status}}},null,2)+'\\n');
 if(a.includes('--record-input-check')){const mode=fs.existsSync(path.join(__dirname,'record-mode'))?fs.readFileSync(path.join(__dirname,'record-mode'),'utf8'):'';
 if(mode!=='missing'){if(mode==='mismatch')binding.rig.dir+='-other';fs.writeFileSync(path.join(out,'input-check.json'),mode==='malformed'?'not json':JSON.stringify({spec:'rig-parts-input-check/1',...binding,check:{pass:true,line:'check: PASS; 3 of 3 bar(s) measured',status}}));}}
 console.log('rig-parts remesh: wrote '+rows.length+' file(s), the provenance in remesh.json');fs.appendFileSync(runs,'E\\n');process.exit(0);}
if(a[0]==='check'){fs.appendFileSync(path.join(__dirname,'check-runs'),'x\\n');process.exit(1);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],skins:[{attachments:{bottomwear:{bottomwear:{kind:'mesh',triangles:Array(3*(rig.tris||0)).fill(0)}}}}],g:rig.mesh?rig.mesh.grid:null}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png-'+(rig.mesh?rig.mesh.grid:0));console.log('rigc: wrote');`;

async function fixture(version='1.49.1',recordMode=''){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-density-strip-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify({bones:[{name:'skirt0a'}]}));await writeFile(join(rig,'motion.json'),'{"animations":{"idle":{}}}');
 await writeFile(join(rig,'mesh_report.json'),'{"parts":{}}');await writeFile(join(rig,'images','bottomwear.png'),'png-bottomwear');
 await writeFile(join(pkg,'motion.json'),'{}');
 const bin=join(root,'node_modules/@rig-c/parts/bin');
 await mkdir(bin,{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(bin,'rig-parts.cjs'),fakeParts);
 await writeFile(join(bin,'record-mode'),recordMode);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state'),runs:join(bin,'runs'),checkRuns:join(bin,'check-runs')};
}
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const patchFor=(hash:string,grid:number,extra:Record<string,unknown>={},version='1.49.1'):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:hash,ops:[{op:'replace',path:'/meshes/bottomwear',value:{...entry,grid,...extra}}],producer:{name:'@rig-c/parts',version},op:{cmd:'remesh',args:['--part','bottomwear']}});
interface View {id:string;status:string;concurrency:number;wallMs:number|null;rows:StripRow[];labels:{fewest:number|null;widest:number|null};error?:string}
/** The most runs open at once in the S/E log. */
const overlap=(log:string)=>{let open=0,max=0;for(const c of log.trim().split('\n')){open+=c==='S'?1:-1;max=Math.max(max,open);}return max;};

async function session(run:(s:{base:string;hash:string;sourceHash:string;state:string;runs:string;checkRuns:string;root:string})=>Promise<void>,options:{stripConcurrency?:number;capability?:string;version?:string;recordMode?:string}={}){
 const f=await fixture(options.version,options.recordMode),p=await loadReview(f.pkg),server=await startServer(p,{port:0,stateDir:f.state,cwd:f.root,...options}),base=`http://127.0.0.1:${server.port}`;
 try{const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}};await run({base,hash:status.inputs.configHash,sourceHash:p.sourceHash,state:f.state,runs:f.runs,checkRuns:f.checkRuns,root:f.root});}
 finally{await server.stop(true);await rm(f.root,{recursive:true,force:true});}
}
const post=(base:string,path:string,body:unknown,headers:Record<string,string>={Origin:base})=>fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,started:Response):Promise<View>{let view=await started.json() as View;for(let i=0;view.status==='running'&&i<800;i++){await Bun.sleep(25);view=await (await fetch(`${base}/api/density-strip/${view.id}`)).json() as View;}return view;}
const ls=async(dir:string)=>{try{return (await readdir(dir)).sort();}catch{return [];}};
const calls=async(root:string):Promise<string[][]> => (await readFile(join(root,'node_modules/@rig-c/parts/bin/args'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
const inputChecks=async(root:string) => (await readFile(join(root,'node_modules/@rig-c/parts/bin/input-check-runs'),'utf8')).trim().split('\n').length;

test('#179: one input check, same inspected directories, at most four candidates, and the shared record never enters a revision or public route',async()=>{
 await session(async({base,hash,state,sourceHash,root,runs,checkRuns})=>{
  const patch=(g:number)=>patchFor(hash,g,{},'1.55.0');
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[40,50,60,70,80].map(patch)}));
  expect(view.rows.every(r=>r.status==='built')).toBe(true);
  expect(view.concurrency).toBe(4);expect(overlap(await readFile(runs,'utf8'))).toBe(4);
  const argv=await calls(root);
  expect(argv.filter(a=>a.includes('--record-input-check'))).toHaveLength(1);
  expect(argv.filter(a=>a.includes('--input-check'))).toHaveLength(4);
  expect(await inputChecks(root)).toBe(1);expect(await ls(checkRuns)).toEqual([]);
  for(const flag of ['--rig','--parts'])expect(new Set(argv.map(a=>a[a.indexOf(flag)+1])).size).toBe(1);
  const dir=join(state,'density-strip',sourceHash,view.id),record=await readFile(join(dir,'input-check.json'),'utf8');
  expect(JSON.parse(record).rig.dir).toBe(join(root,'pkg/rig/out/rig'));
  for(const row of view.rows){
   expect(await ls(join(dir,row.id,'rig'))).not.toContain('input-check.json');
   expect((await fetch(`${base}/density-strip/${view.id}/${row.id}/input-check.json`)).status).toBe(404);
  }
  expect((await fetch(`${base}/density-strip/${view.id}/input-check.json`)).status).toBe(404);
  // The ordinary revision binding remains strict: an unrelated extra file is still a named stale refusal.
  const revision=join(dir,view.rows[0]!.id,'rig'),provenance=JSON.parse(await readFile(join(revision,'remesh.json'),'utf8'));
  await writeFile(join(revision,'unexpected.json'),'{}');
  expect(await revisionBinding(revision,provenance,'remesh')).toMatch(/^REMESH_CHECK_STALE: unexpected.json /);
  await rm(join(revision,'unexpected.json'));
  const applied=await (await post(base,'/api/rebuild',{patch:patch(40)})).json() as {status:string;reused:boolean};
  expect(applied).toMatchObject({status:'built',reused:true});
  expect(await readFile(join(dir,'input-check.json'),'utf8')).toBe(record);
  const next=await settle(base,await post(base,'/api/density-strip',{patches:[42,62].map(patch)}));
  expect(next.rows.every(r=>r.status==='built')).toBe(true);expect(await inputChecks(root)).toBe(2);
  expect(await ls(join(state,'density-strip',sourceHash))).toEqual([next.id]);
  await post(base,'/api/density-strip/close',{id:next.id});
  expect(await ls(join(state,'density-strip'))).toEqual([]);
  expect((await loadReview(join(root,'pkg'))).sourceHash).toBe(sourceHash);
 },{version:'1.55.0',stripConcurrency:99});
});

test('#179: a refused first candidate keeps its line; the next candidate seeds the remaining pool; all-refused and single-slot strips settle',async()=>{
 await session(async({base,hash,root})=>{
  const patch=(g:number)=>patchFor(hash,g,{},'1.55.0');
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[120,40,60].map(patch)}));
  expect(view.rows.map(r=>r.status)).toEqual(['refused','built','built']);
  expect(view.rows[0]!.verdict).toMatch(/^FAIL  REMESH_CHECK_HELD: check bar TIP_OVER_ROOT/);
  const argv=await calls(root);
  expect(argv.map(a=>a.includes('--record-input-check'))).toEqual([true,true,false]);
  expect(await inputChecks(root)).toBe(2);
  const refused=await settle(base,await post(base,'/api/density-strip',{patches:[120,130].map(patch)}));
  expect(refused.status).toBe('done');expect(refused.rows.every(r=>r.status==='refused')).toBe(true);
 },{version:'1.55.0',stripConcurrency:1});
});

test('#179: missing output record refuses by name without falling back or starting any remaining producer',async()=>{
 await session(async({base,hash,root,state,sourceHash})=>{
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[40,60,80].map(g=>patchFor(hash,g,{},'1.55.0'))}));
  expect(view.rows.every(r=>r.status==='refused'&&r.verdict.startsWith('DENSITY_STRIP_INPUT_CHECK_MISSING:'))).toBe(true);
  expect(await calls(root)).toHaveLength(1);expect(await inputChecks(root)).toBe(1);
  expect(await ls(join(state,'density-strip',sourceHash,view.id))).toEqual([]);
 },{version:'1.55.0',recordMode:'missing'});
});

for(const [mode,code] of [['malformed','REMESH_INPUT_CHECK_FILE'],['mismatch','REMESH_INPUT_CHECK_BOUND']])test(`#179: ${mode} record preserves ${code}, with no unrecorded retry`,async()=>{
 await session(async({base,hash,root})=>{
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[40,60,80].map(g=>patchFor(hash,g,{},'1.55.0'))}));
  expect(view.rows.map(r=>r.status)).toEqual(['built','refused','refused']);
  expect(view.rows.slice(1).every(r=>r.verdict.startsWith(`FAIL  ${code}:`))).toBe(true);
  expect(await calls(root)).toHaveLength(3);expect(await inputChecks(root)).toBe(1);
 },{version:'1.55.0',recordMode:mode});
});

test('#179: older producer receives no input-check flags and measures each candidate independently',async()=>{
 await session(async({base,hash,root})=>{
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[40,60].map(g=>patchFor(hash,g))}));
  expect(view.rows.every(r=>r.status==='built')).toBe(true);
  expect((await calls(root)).every(a=>!a.includes('--record-input-check')&&!a.includes('--input-check'))).toBe(true);
  expect(await inputChecks(root)).toBe(2);
 });
});

test('#173 pure: the values of a strip and of a refined strip, the shape a strip may have, and the default concurrency',()=>{
 expect(stripValues(40,120,5,true)).toEqual([40,60,80,100,120]);
 expect(stripValues(120,40,3,true)).toEqual([40,80,120]);
 expect(stripValues(10,12,5,false)).toEqual([10,10.5,11,11.5,12]);
 expect(refineValues(100,80,5,true)).toEqual([83,87,90,93,97]);
 expect(()=>refineValues(80,81,5,true)).toThrow('DENSITY_STRIP_VALUES');
 expect(()=>stripValues(40,120,6,true)).toThrow('DENSITY_STRIP_VALUES');
 const h='a'.repeat(64);
 expect(stripShape([patchFor(h,40),patchFor(h,60)])).toMatchObject({part:'bottomwear',field:'grid',values:[40,60]});
 expect(()=>stripShape([patchFor(h,40),patchFor(h,60,{r:9})])).toThrow('DENSITY_STRIP_FIELD');
 expect(()=>stripShape([patchFor(h,40),patchFor(h,40)])).toThrow(DensityStripError);
 expect(()=>stripShape([patchFor(h,40),{...patchFor(h,60),ops:[{op:'replace',path:'/meshes/bottomwear/grid',value:60}]}])).toThrow('MESH_PATCH_SCOPE');
 expect(defaultStripConcurrency()).toBe(Math.min(4,Math.max(1,Math.floor(require('node:os').availableParallelism()/2))));
 expect([0,2.9,5,100].map(boundedStripConcurrency)).toEqual([1,2,4,4]);
 expect(boundedStripConcurrency(NaN)).toBe(defaultStripConcurrency());
 expect(DENSITY_STRIP_LIMIT).toBe(5*64*1024);
});

test('#173 pure: a row reads the producer\'s own check lines for the part — real lines from parts examples/wind bottomwear grid 40',()=>{
 const lines=[
  '[check-input]   TEXTURE_STRETCH: PASS — meshes 6; triangles 946; frames 41; severity 1.283; severity_ceiling 1.926544; worst slot hairpin, triangle 46, vertices 13 | 111 | 14, edge 14 | 13, frame 5, ratio 0.779; max_ratio 1.282; min_ratio 0.779; per_mesh slot bottomwear, triangles 204, max_ratio 1.2, max_at triangle 1 (vertices 1 2 3), edge 1-2, idle frame 3, min_ratio 0.9, min_at triangle 2 (vertices 1 2 3), edge 1-2, idle frame 4, severity 1.2',
  '[check-revision]   TIP_OVER_ROOT: PASS — instrument geometry; parts part forearm_l, unmeasured a limb segment (config.limbs.arm_l), rigid on its one bone "sleeve_l1": it turns at its joint and does not hang, so it is not held to the bar | part bottomwear, root_rig_px 2.545, tip_rig_px 5.078, ratio 1.995; ratio_floor 1.4725',
  '[check-revision]   TEXTURE_STRETCH: PASS — meshes 6; triangles 876; frames 41; severity 1.538; severity_ceiling 1.926544; worst slot bottomwear, triangle 104, vertices 74 | 86 | 75, edge 86 | 75, frame 40, ratio 1.538; max_ratio 1.538; min_ratio 0.734; per_mesh slot hair_back, triangles 256, max_ratio 1.068, max_at triangle 221 (vertices 126 125 200), edge 126-125, idle frame 5, min_ratio 0.925, min_at triangle 47 (vertices 159 161 162), edge 161-162, idle frame 5, severity 1.082 | slot bottomwear, triangles 134, max_ratio 1.538, max_at triangle 104 (vertices 74 86 75), edge 86-75, idle frame 40, min_ratio 0.734, min_at triangle 84 (vertices 65 17 16), edge 17-16, idle frame 40, severity 1.538 | slot topwear, triangles 234, max_ratio 1.104, max_at triangle 141 (vertices 105 116 117), edge 117-105, idle frame 10, min_ratio 0.971, min_at triangle 192 (vertices 127 138 128), edge 138-128, idle frame 24, severity 1.104',
  '[check-revision]   ANIMATIONS_DO_NOT_FOLD: PASS — 1 animation(s) read by rigc render --folds at 12 fps, with its 44 physics constraint(s) on and off (idle): 0 folding mesh(es), 0 not declared in may_fold (<= 0)',
 ];
 const f=stripFigures(lines,'bottomwear');
 expect(f.folds).toBe(0);
 expect(f.stretch).toEqual({severity:1.538,frame:'idle frame 40'});
 expect(f.bars.map(b=>[b.bar,b.key,b.value,b.kind,b.bound])).toEqual([['TIP_OVER_ROOT','ratio',1.995,'floor',1.4725],['TEXTURE_STRETCH','severity',1.538,'ceiling',1.926544]]);
 expect(f.bars[0]!.ratio).toBeCloseTo(1.995/1.4725,9);
 // forearm_l is named but unmeasured: no bar for it.
 expect(stripFigures(lines,'forearm_l').bars).toEqual([]);
 // Labels: the fewest-triangle passing row; among a tie, the one with the widest narrowest margin. A refusal is never labelled.
 const row=(t:number,ratio:number,verdict='PASS')=>({counts:{vertices:1,triangles:t},verdict,bars:[{bar:'TIP_OVER_ROOT',status:'PASS',key:'ratio',value:ratio,bound:1.4725,kind:'floor' as const,ratio:ratio/1.4725,margin:ratio/1.4725}]}) as unknown as StripRow;
 expect(stripLabels([row(30,2),row(22,1.5),row(22,2.1),row(20,1.1,'FAIL  REMESH_CHECK_HELD: …')])).toEqual({fewest:1,widest:2});
 expect(stripLabels([row(30,2),row(22,1.5)])).toEqual({fewest:1,widest:null});
 expect(candidateRow({value:120,id:'x',entry:{},part:'bottomwear',modelUrl:'/u',applied:false,job:{status:'refused',producerLine:'FAIL  REMESH_CHECK_HELD: x',lines:[],remesh:null,check:null,build:null}})).toMatchObject({verdict:'FAIL  REMESH_CHECK_HELD: x',modelUrl:null,counts:null});
});

test('#173 bars: a strip of five runs at most `concurrency` candidates at once; each row equals its remesh.json and check line; the refused row is verbatim and not served; nothing is applied',async()=>{
 await session(async({base,hash,sourceHash,state,runs,checkRuns})=>{
  const values=[40,60,80,90,120];
  const started=await post(base,'/api/density-strip',{patches:values.map(v=>patchFor(hash,v))});expect(started.status).toBe(202);
  const view=await settle(base,started);
  expect(view.status).toBe('done');expect(view.concurrency).toBe(2);expect(typeof view.wallMs).toBe('number');
  // Concurrency bound: never more than two runs open, and more than one (they ran beside each other).
  expect(overlap(await readFile(runs,'utf8'))).toBe(2);
  expect(view.rows.map(r=>[r.value,r.status])).toEqual([[40,'built'],[60,'built'],[80,'built'],[90,'built'],[120,'refused']]);
  // #174's carried check: no third check ran.
  expect(await ls(checkRuns)).toEqual([]);
  const dir=join(state,'density-strip',sourceHash,view.id);
  for(const r of view.rows.filter(r=>r.status==='built')){
   const prov=JSON.parse(await readFile(join(dir,r.id,'rig','remesh.json'),'utf8'));
   expect(r.counts).toEqual({vertices:prov.target.after.vertices,triangles:prov.target.after.triangles});
   expect(r.modelTriangles).toBe(prov.target.after.triangles);
   const job=await (await fetch(`${base}/api/density-strip/${view.id}/${r.id}`)).json() as {check:{line:string;source:string}};
   expect(job.check).toMatchObject({line:prov.check.revision.line,source:'remesh'});
   expect(r.verdict).toBe('PASS');
   const ratio=+(3-r.value/60).toFixed(3),sev=+(1+10/r.value).toFixed(3);
   expect(r.bars.map(b=>[b.bar,b.value,b.bound])).toEqual([['TIP_OVER_ROOT',ratio,FLOOR],['TEXTURE_STRETCH',sev,CEIL]]);
   expect(r.stretch).toEqual({severity:sev,frame:'idle frame 40'});expect(r.folds).toBe(0);
   // Served for viewing: the model's bytes hash to the row's model hash.
   const model=await fetch(base+r.modelUrl!);expect(model.status).toBe(200);expect(sha(new Uint8Array(await model.arrayBuffer()))).toBe(r.modelHash!);
  }
  // 80 and 90 tie at 44 triangles; 80 has the wider margin (TIP ratio 1.667 vs 1.5).
  expect(view.labels).toEqual({fewest:2,widest:2});
  const refused=view.rows[4]!;
  expect(refused.verdict).toBe('FAIL  REMESH_CHECK_HELD: check bar TIP_OVER_ROOT — met on the input and not on the revision: CHECK_TIP_OVER_ROOT: part "bottomwear" ratio 1; a ratio >= 1.4725 is required');
  expect(refused.modelUrl).toBeNull();expect(refused.counts).toBeNull();
  expect((await fetch(`${base}/density-strip/${view.id}/${refused.id}/skeleton.model.json`)).status).toBe(404);
  expect(await ls(join(dir,refused.id))).toEqual([]);
  // Opening the strip and loading its rows approves nothing: no applied record, nothing in the Apply scratch root.
  const history=await (await fetch(base+'/api/rebuild/history')).json() as {depth:number};
  expect(history.depth).toBe(0);expect(await ls(join(state,'rebuild',sourceHash))).toEqual([]);
 },{stripConcurrency:2});
});

test('#173 load-not-apply and Apply: a row Applied through the ordinary patch reuses its candidate build (no producer run), lands one record, and leaves the strip',async()=>{
 await session(async({base,hash,sourceHash,state,runs})=>{
  const view=await settle(base,await post(base,'/api/density-strip',{patches:[40,80].map(v=>patchFor(hash,v))}));
  const row=view.rows[1]!,before=(await readFile(runs,'utf8')).trim().split('\n').length;
  const applied=await (await post(base,'/api/rebuild',{patch:patchFor(hash,80)})).json() as {id:string;status:string;reused:boolean;remesh:{after:{triangles:number}};build:{modelHash:string}};
  expect(applied).toMatchObject({id:row.id,status:'built',reused:true});
  expect(applied.build.modelHash).toBe(row.modelHash!);expect(applied.remesh.after.triangles).toBe(row.counts!.triangles);
  expect((await readFile(runs,'utf8')).trim().split('\n').length).toBe(before);
  const history=await (await fetch(base+'/api/rebuild/history')).json() as {depth:number;records:{id:string}[]};
  expect(history.depth).toBe(1);expect(history.records[0]!.id).toBe(row.id);
  expect(await ls(join(state,'rebuild',sourceHash))).toEqual([row.id]);
  const after=await (await fetch(`${base}/api/density-strip/${view.id}`)).json() as View;
  expect(after.rows[1]).toMatchObject({applied:true,modelUrl:null});
  expect((await fetch(base+row.modelUrl!)).status).toBe(404);
  expect((await fetch(`${base}/rebuild/${row.id}/skeleton.model.json`)).status).toBe(200);
  // Undo returns to the inspected build: the strip never pushed a record of its own.
  const undone=await (await post(base,'/api/rebuild/undo',{from:row.id})).json() as {status:string;history:{depth:number}};
  expect(undone).toMatchObject({status:'inspected',history:{depth:0}});
 });
});

test('#173 cleanup, busy and request rules: a strip replaces its predecessor\'s scratch, close removes it, Apply and undo wait for a running strip, and the route is same-origin, bounded and typed',async()=>{
 await session(async({base,hash,sourceHash,state})=>{
  const root=join(state,'density-strip',sourceHash);
  const first=await settle(base,await post(base,'/api/density-strip',{patches:[40,60].map(v=>patchFor(hash,v))}));
  expect(await ls(root)).toEqual([first.id]);
  const started=await post(base,'/api/density-strip',{patches:[50,70,90].map(v=>patchFor(hash,v))});expect(started.status).toBe(202);
  const second=await started.json() as View;
  // While it runs: an Apply, an undo and a close are refused by name; a third strip too.
  const apply=await (await post(base,'/api/rebuild',{patch:patchFor(hash,33)})).json() as {status:string;error:string;producerLine:null};
  expect(apply).toEqual({status:'refused',error:`REBUILD_BUSY: density strip ${second.id} is still running`,producerLine:null});
  expect((await (await post(base,'/api/density-strip',{patches:[41,42].map(v=>patchFor(hash,v))})).json() as {error:string}).error).toBe(`REBUILD_BUSY: density strip ${second.id} is still running`);
  expect((await (await post(base,'/api/density-strip/close',{id:second.id})).json() as {error:string}).error).toMatch(/^DENSITY_STRIP_BUSY: /);
  const done=await settle(base,new Response(JSON.stringify(second)));
  expect(done.status).toBe('done');
  // Replaced: only the strip on screen keeps a folder.
  expect(await ls(root)).toEqual([second.id]);
  expect(await ls(join(root,second.id))).toEqual(second.rows.map(r=>r.id).sort());
  const closed=await (await post(base,'/api/density-strip/close',{id:second.id})).json();
  expect(closed).toEqual({status:'closed',id:second.id,applied:0});
  expect(await ls(join(state,'density-strip'))).toEqual([]);
  expect(await (await fetch(base+'/api/density-strip')).json()).toEqual({strip:null});
  // Same-origin, typed, bounded.
  expect((await post(base,'/api/density-strip',{patches:[40,60].map(v=>patchFor(hash,v))},{})).status).toBe(403);
  const six=await post(base,'/api/density-strip',{patches:[31,32,33,34,35,36].map(v=>patchFor(hash,v))});
  expect(six.status).toBe(400);expect((await six.json() as {error:string}).error).toMatch(/^DENSITY_STRIP_REQUEST_INVALID: patches must hold 2–5/);
  const other=await post(base,'/api/density-strip',{patches:[patchFor(hash,40),patchFor(hash,60,{r:9})]});
  expect(other.status).toBe(400);expect((await other.json() as {error:string}).error).toMatch(/^DENSITY_STRIP_FIELD: patches\[1\] differs from patches\[0\] outside meshes\.bottomwear\.grid/);
  const stale=await (await post(base,'/api/density-strip',{patches:[40,60].map(v=>patchFor('0'.repeat(64),v))})).json() as {error:string};
  expect(stale.error).toMatch(/^EDIT_PATCH_STALE: /);
  const big=await fetch(base+'/api/density-strip',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({patches:[patchFor(hash,40,{pad:'x'.repeat(DENSITY_STRIP_LIMIT)})]})});
  expect(big.status).toBe(400);expect((await big.json() as {error:string}).error).toMatch(/^DENSITY_STRIP_BODY_LIMIT/);
  expect(await ls(join(state,'density-strip'))).toEqual([]);
 },{stripConcurrency:3});
 // The page capability gates the mutation like every other one.
 await session(async({base,hash})=>{
  expect((await post(base,'/api/density-strip',{patches:[40,60].map(v=>patchFor(hash,v))})).status).toBe(403);
 },{capability:'c'.repeat(64)});
 // The managed front lists the routes for a single review only, with the body bound.
 expect(frontRoute('single','POST','/api/density-strip')).toMatchObject({mutation:true,limit:320*1024});
 expect(frontRoute('single','POST','/api/density-strip/close')).toMatchObject({mutation:true,limit:1024});
 expect(frontRoute('single','GET','/api/density-strip/'+'a'.repeat(64))).toMatchObject({mutation:false});
 expect(frontRoute('single','GET',`/density-strip/${'a'.repeat(64)}/${'b'.repeat(64)}/skeleton.model.json`)).toMatchObject({mutation:false});
 expect(frontRoute('single','PUT','/api/density-strip')).toBeNull();
 expect(frontRoute('compare','POST','/api/density-strip')).toBeNull();
});

test('#183 ownership: two strips, or a strip and an Apply, sent at once — exactly one starts, the other is refused REBUILD_BUSY; the started strip keeps its scratch',async()=>{
 await session(async({base,hash,sourceHash,state})=>{
  const root=join(state,'density-strip',sourceHash);
  // Two strips at once.
  const [a,b]=await Promise.all([post(base,'/api/density-strip',{patches:[40,60].map(v=>patchFor(hash,v))}),post(base,'/api/density-strip',{patches:[50,70].map(v=>patchFor(hash,v))})]);
  const views=[await a.json() as View&{status:string;error?:string},await b.json() as View&{status:string;error?:string}];
  console.log('#183 two strips at once: '+views.map(v=>v.status+(v.error?` (${v.error.slice(0,40)}…)`:'')).join(' | '));
  const running=views.filter(v=>v.status==='running'),refused=views.filter(v=>v.status==='refused');
  expect(running.length).toBe(1);expect(refused.length).toBe(1);
  expect(refused[0]!.error).toMatch(/^REBUILD_BUSY: density strip [a-f0-9]{64} is still running$/);
  const done=await settle(base,new Response(JSON.stringify(running[0])));
  expect(done.status).toBe('done');expect(await ls(root)).toEqual([done.id]);
  expect(done.rows.every(r=>r.status==='built')).toBe(true);
  // A strip and an Apply at once.
  const [s,r]=await Promise.all([post(base,'/api/density-strip',{patches:[44,66].map(v=>patchFor(hash,v))}),post(base,'/api/rebuild',{patch:patchFor(hash,33)})]);
  const sv=await s.json() as {status:string;error?:string;id?:string},rv=await r.json() as {status:string;error?:string;id?:string};
  console.log(`#183 strip + Apply at once: strip ${sv.status}${sv.error?` (${sv.error.slice(0,40)}…)`:''} | Apply ${rv.status}${rv.error?` (${rv.error.slice(0,40)}…)`:''}`);
  expect([sv.status,rv.status].filter(x=>x==='refused').length).toBe(1);
  expect((sv.status==='refused'?sv:rv).error).toMatch(/^REBUILD_BUSY: /);
  if(sv.status==='running')await settle(base,new Response(JSON.stringify(sv)));
  else for(let i=0;i<800;i++){const j=await (await fetch(`${base}/api/rebuild/${rv.id}`)).json() as {status:string};if(j.status!=='running')break;await Bun.sleep(25);}
 },{stripConcurrency:2});
});

test('#183 pending strip state: every landed Apply (any block), Reset and Undo clears the pending row and Back; a refusal and a Load do not',()=>{
 const pending={index:1,id:'s'.repeat(64),candidate:'c'.repeat(64)},other={index:0,id:'s'.repeat(64),candidate:'d'.repeat(64)};
 // The Apply paths that share the stage: regions, every patch block (Mesh, Physics, Idle, Cuts, Cloth, Rig fields, Bones), Edit Mesh's delta, retarget.
 for(const via of ['regions','mesh','physics','idle','cuts','cloth','rig-fields','bones','delta','retarget'] as const){
  const after=stripPendingAfter(pending,{kind:'apply',via});
  console.log(`#183 Apply via ${via}: pending ${after===null?'cleared':'kept'}`);
  expect(after).toBeNull();
 }
 expect(stripPendingAfter(pending,{kind:'reset'})).toBeNull();
 expect(stripPendingAfter(pending,{kind:'undo'})).toBeNull();
 // A refused or failed step leaves the stage, and the row on it, as they were.
 expect(stripPendingAfter(pending,{kind:'refused'})).toBe(pending);
 // Load puts a row on the stage; nothing pending stays nothing pending.
 expect(stripPendingAfter(pending,{kind:'load',row:other})).toBe(other);
 expect(stripPendingAfter(null,{kind:'apply',via:'physics'})).toBeNull();
});
