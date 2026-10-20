import {expect,test} from 'bun:test';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {applyConfigPatch,CONFIG_PATCH_SCHEMA,jsonDiff,type ConfigPatch,type JsonValue} from '../src/config-patch.ts';
import {absolutizeBuildFiles,buildReadout,needsBuild,newBuildFile} from '../src/build-route.ts';
import {appliedSummary,parseAppliedContext} from '../src/applied-context.ts';
import {cutOps,cutsSource,setVertex} from '../src/cut-edits.ts';
import {patchAppliedRecord,patchOutcomeLine,stageModel,type PatchJobView} from '../web/rebuild-client.ts';

/**
 * #115: a cut, patch or limb edit is read by the producer's assemble stage, so the `rig` patch runs `rig-parts build`
 * (assemble → rig → check) from the handoff's painting and runs, into scratch, and the shared tail compiles and serves
 * it. Stand-ins: `rig` copies the inspected rig (so the baseline reproduces), `build` records the config it was given,
 * writes parts whose bytes follow each cut's polygon and a rig.json that carries them, and refuses a polygon point past
 * the 832 x 1216 rig with the producer's line; `check` writes check.json; `rigc build` hashes the rig into the model.
 */
const RIG_W=832;
const config={key:'k',assemble:{rig_scale:0.5,plan:[['bottomwear','full','bottomwear'],['topwear','full','topwear']],cuts:[
 {from:'bottomwear',into:'ribbon_r',polygon:[[368,450],[393,450],[389,742],[364,742]],draw:{before:'topwear'},overlap:2,under:'ribbon_r_under.png'},
 {from:'bottomwear',into:'ribbon_l',polygon:[[414,450],[436,450],[452,742],[430,742]],draw:{before:'topwear'},overlap:2},
]},limbs:{arm_r:{segments:[{part:'upperarm_r',from:'handwear_r',bone:'sleeve_r0'},{part:'forearm_r',from:'handwear_r',bone:'sleeve_r1',joint:'elbow'}]}},
 bones:[{chain:'sleeve_r',parent:'root',points:[[300,300],[305,444]],tip:[320,560]}],regions:{ribbon_r:'hip',ribbon_l:'hip'},meshes:{}};
const inspected={'rig.json':JSON.stringify({bones:[{name:'root'}],cuts:'inspected'}),'motion.json':'{}','sets.json':'{}','mesh_report.json':'{}'};
const fakeParts=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
if(a[0]==='rig'){copy(path.join(f('--parts'),'rig'),f('--out'));console.log('rig-parts rig: wrote');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
if(a[0]==='build'){const cfgPath=path.resolve(f('--config')),cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8')),out=f('--out');
 if(!a.includes('--seam-pairs')){console.log('review did not ask for the seam pairs');process.exit(4);}
 console.log('rig-parts build: config.json -> out');
 for(const q of cfg.assemble.cuts||[])if(q.under&&!fs.existsSync(path.resolve(path.dirname(cfgPath),q.under))){console.log('[assemble]   FAIL  ASSEMBLE_UNDER_PRESENT: config.assemble.cuts (part "'+q.into+'") — names '+q.under+', which is no such file');console.log('[assemble] refused: 1 problem(s)');console.log('build: stopped at assemble; no later stage ran');process.exit(1);}
 const past=(cfg.assemble.cuts||[]).flatMap((q,i)=>q.polygon.filter(p=>p[0]>${RIG_W}).map(p=>[i,p]));
 if(past.length){console.log('[assemble]   FAIL  ASSEMBLE_CUT_INSIDE: config.assemble.cuts['+past[0][0]+'].polygon — has the point '+past[0][1].join(',')+' past the ${RIG_W}x1216 rig');console.log('[assemble] refused: 1 problem(s)');console.log('build: stopped at assemble; no later stage ran');process.exit(1);}
 fs.mkdirSync(path.join(out,'parts'),{recursive:true});fs.mkdirSync(path.join(out,'check'),{recursive:true});
 fs.writeFileSync(path.join(out,'received-config.json'),JSON.stringify(cfg));
 const parts=JSON.parse(fs.readFileSync(path.join(process.env.FAKE_PARTS,'parts.json'),'utf8'));
 for(const q of cfg.assemble.cuts||[]){fs.writeFileSync(path.join(out,'parts',q.into+'.png'),'png-'+JSON.stringify(q.polygon));console.log('[assemble]   cut: "'+q.from+'" opaque 100 = "'+q.from+'" 90 + "'+q.into+'" 10; band 2 px held by both');}
 fs.writeFileSync(path.join(out,'parts','bottomwear.png'),'png-bottom-'+crypto.createHash('md5').update(JSON.stringify(cfg.assemble.cuts)).digest('hex'));
 fs.writeFileSync(path.join(out,'parts','topwear.png'),'png-topwear');
 parts.recomposite.error_px=8194+(cfg.assemble.cuts[0].polygon[2][0]===389?0:3);fs.writeFileSync(path.join(out,'parts.json'),JSON.stringify(parts));
 fs.writeFileSync(path.join(out,'recomposite_error_rig.png'),'map-'+parts.recomposite.error_px);
 console.log('[assemble] recomposite vs source: mean |d|=0.88, within 8: 97.5%, error px > 40: '+parts.recomposite.error_px+', uncovered error px: 1143');
 const rigDir=path.join(out,'rig');copy(path.join(process.env.FAKE_PARTS,'rig'),rigDir);
 const rig=JSON.parse(fs.readFileSync(path.join(rigDir,'rig.json'),'utf8'));rig.cuts=JSON.stringify(cfg.assemble.cuts.map(q=>q.polygon))===JSON.stringify(${JSON.stringify(config.assemble.cuts.map(q=>q.polygon))})?'inspected':cfg.assemble.cuts.map(q=>q.polygon);fs.writeFileSync(path.join(rigDir,'rig.json'),JSON.stringify(rig));
 fs.writeFileSync(path.join(out,'check','check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true,LIMB_ONE_BONE:{status:'PASS'}}));
 console.log('[check]   seam: setup pose at 464x1216, scale 1.0017: mean |d| 0.245 (<= 1.0), 47 px over 40');
 console.log('[check]   seam pair 1 of 2: "bottomwear" / "ribbon_l" at the setup pose: 13 px over 40 (0 over 80), frame box x 237..257');
 console.log('[check]   seam pair 2 of 2: "bottomwear" / "ribbon_r" at the setup pose: 5 px over 40 (0 over 80), frame box x 210..210');
 if(cfg.assemble.cuts[1].polygon[2][0]===451){console.log('[check]   FAIL  CHECK_SEAM_WITHIN_BAR: the setup-pose render vs the flat composite of parts/ — 50.83 rig px');console.log('[check] check: FAIL; 1 of 13 bar(s) not met');console.log('build: stopped at check; 1 bar(s) not met, so no loop was encoded and no artifact is reported');fs.writeFileSync(path.join(out,'check','check.json'),JSON.stringify({gate_spine_html_green:true,PASS:false,CHECK_SEAM_WITHIN_BAR:{status:'FAIL'}}));process.exit(1);}
 console.log('[check] check: PASS; 11 of 13 bar(s) measured, 2 skipped');
 console.log('build: PASS — the packed atlas is the artifact; parts/ and rig/ are the intermediates it was made from');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=fs.readFileSync(f('--rig'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:crypto.createHash('sha256').update(rig).digest('hex')}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png-'+crypto.createHash('sha256').update(rig).digest('hex'));console.log('rigc: wrote');`;

async function fixture(withSource=true){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-cuts-build-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});await mkdir(join(pkg,'layers/full'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));
 await writeFile(join(pkg,'rig/ribbon_r_under.png'),'under');await writeFile(join(pkg,'rig/inputs.png'),'painting');await writeFile(join(pkg,'layers/full/layers.json'),'{}');
 await writeFile(join(pkg,'rig/out/parts.json'),JSON.stringify({parts:[],recomposite:{mean_abs:0.88,within_share:0.975,error_px:8194,uncovered_error_px:1143,hole_count:31}}));
 for(const n of ['ribbon_r','ribbon_l']){const q=config.assemble.cuts.find(c=>c.into===n)!;await writeFile(join(pkg,'rig/out/parts',n+'.png'),'png-'+JSON.stringify(q.polygon));}
 const crypto=await import('node:crypto');
 await writeFile(join(pkg,'rig/out/parts/bottomwear.png'),'png-bottom-'+crypto.createHash('md5').update(JSON.stringify(config.assemble.cuts)).digest('hex'));
 await writeFile(join(pkg,'rig/out/parts/topwear.png'),'png-topwear');
 for(const [name,text] of Object.entries(inspected))await writeFile(join(rig,name),text);
 await writeFile(join(rig,'images','topwear.png'),'png-topwear');await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.44.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 process.env.FAKE_PARTS=join(pkg,'rig/out');
 const handoff={config:join(pkg,'rig/config.json'),parts:join(pkg,'rig/out'),...(withSource?{source:join(pkg,'rig/inputs.png'),full:join(pkg,'layers/full')}:{})};
 const p=await loadReview(pkg,{handoff});
 const server=await startServer(p,{port:0,stateDir:join(root,'state'),cwd:root}),base=`http://127.0.0.1:${server.port}`;
 return {root,pkg,p,server,base,state:join(root,'state')};
}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,job:{id?:string;status:string}):Promise<PatchJobView>{let current=job as PatchJobView;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json() as PatchJobView;}return current;}
const patchFor=(configSha:string,ops:ConfigPatch['ops']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.44.0'},op:{cmd:'rig',args:[]}});
const statusOf=async(base:string)=>await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string};cuts:{config:unknown;build:string|null}|null};

test('#115 routing: assemble and limbs ops need the build, a bone op only with limbs declared, and no op names a new file',()=>{
 expect(needsBuild([{path:'/assemble/cuts/0/polygon/2'}],config)).toBe(true);
 expect(needsBuild([{path:'/limbs/arm_r/segments/1/range'}],config)).toBe(true);
 expect(needsBuild([{path:'/bones/0/points/1'}],config)).toBe(true);
 expect(needsBuild([{path:'/bones/0/points/1'}],{...config,limbs:undefined})).toBe(false);
 expect(needsBuild([{path:'/constraints/0/damping'}],config)).toBe(false);
 const moved=applyConfigPatch(config as JsonValue,[{op:'add',path:'/assemble/cuts/1/under',value:'ribbon_r_under.png'}]);
 expect(newBuildFile(config as JsonValue,moved)).toBeNull();
 const fresh=applyConfigPatch(config as JsonValue,[{op:'add',path:'/assemble/cuts/1/under',value:'mine.png'}]);
 expect(newBuildFile(config as JsonValue,fresh)).toBe('assemble.cuts[1].under');
});

test('#115 bar 1 (editor): one vertex drag is one op at its pointer, and the patched config differs from the handoff config only there',()=>{
 const source=cutsSource(config),cut=source.cuts[0]!;
 const ops=cutOps(setVertex(new Map(),cut,2,[386,742]),[],config);
 expect(ops).toEqual([{op:'replace',path:'/assemble/cuts/0/polygon/2',value:[386,742],name:'ribbon_r'}]);
 expect(jsonDiff(config,applyConfigPatch(config as JsonValue,ops))).toEqual(['/assemble/cuts/0/polygon/2/0']);
});

test('#115 bar 1 (server): the build runs on the patched config, the scratch config differs only at the edited path, the parts and rig follow, the stage takes the scratch model',async()=>{
 const {root,p,server,base,state}=await fixture();
 try{
  const status=await statusOf(base);
  expect(status.cuts?.build).toBeNull();
  expect(cutsSource(status.cuts!.config).cuts.map(c=>c.into)).toEqual(['ribbon_r','ribbon_l']);
  const ops=cutOps(setVertex(new Map(),cutsSource(config).cuts[0]!,2,[386,742]),[],config);
  const started=await post(base,{patch:patchFor(status.inputs.configHash,ops)});expect(started.status).toBe(202);
  const job=await settle(base,await started.json() as PatchJobView);
  expect(job.status).toBe('built');expect(job.op).toBe('build');
  expect(job.producerLine).toBe('build: PASS — the packed atlas is the artifact; parts/ and rig/ are the intermediates it was made from');
  const dir=join(state,'rebuild',p.sourceHash,job.id);
  // The config the producer received, against the handoff config with the same files made absolute: only the edited pointer.
  const received=JSON.parse(await readFile(join(dir,'out','received-config.json'),'utf8'));
  const handoffDir=dirname(join(root,'pkg','rig','config.json')),expected=structuredClone(config) as Record<string,unknown>;
  absolutizeBuildFiles(expected,v=>isAbsolute(v)?v:resolve(handoffDir,v));
  expect(jsonDiff(expected,received)).toEqual(['/assemble/cuts/0/polygon/2/0']);
  expect(received.assemble.cuts[0].under).toBe(resolve(handoffDir,'ribbon_r_under.png'));
  // What assemble wrote: ribbon_r and the layer it was cut from changed, ribbon_l and topwear did not; the recomposite moved.
  expect(job.assembled!.parts!.changed).toEqual(['bottomwear','ribbon_r']);
  expect(job.assembled!.recomposite.before!.error_px).toBe(8194);expect(job.assembled!.recomposite.after!.error_px).toBe(8197);
  expect(job.assembled!.lines.filter(l=>l.startsWith('cut:'))).toHaveLength(2);
  expect(job.assembled!.seamPairs).toEqual(['seam pair 1 of 2: "bottomwear" / "ribbon_l" at the setup pose: 13 px over 40 (0 over 80), frame box x 237..257','seam pair 2 of 2: "bottomwear" / "ribbon_r" at the setup pose: 5 px over 40 (0 over 80), frame box x 210..210']);
  expect(job.check?.pass).toBe(true);expect(job.check?.line).toBe('check: PASS; 11 of 13 bar(s) measured, 2 skipped');
  expect(job.files!.documents.find(d=>d.file==='rig.json')!.paths).toEqual(['/cuts']);
  // The error map is served read-only under its one name.
  const map=await fetch(base+job.assembled!.recomposite.errorMap!.url);expect(map.status).toBe(200);expect(await map.text()).toBe('map-8197');
  // The stage swaps to the scratch model: its served bytes are the scratch build's, not the inspected one's.
  const next=stageModel(job,{url:'/assets/inspected.model.json',hash:'f'.repeat(64)});
  expect(next).toEqual({url:job.build!.modelUrl,hash:job.build!.modelHash,id:job.id});
  const served=await (await fetch(base+next.url)).text(),{createHash}=await import('node:crypto');
  expect(JSON.parse(served).rig).not.toBe(createHash('sha256').update(inspected['rig.json']).digest('hex'));
  expect(served).toBe(await readFile(join(dir,'build','skeleton.model.json'),'utf8'));
  // Bar 2: the build's wall clock is in the job, the applied record and the line shown.
  expect(job.wallMs.op).toBeNumber();
  const record=patchAppliedRecord(job);expect(record.op).toBe('build');expect(record.assembled!.wallMs).toBe(job.wallMs.op);
  expect(()=>parseAppliedContext(record)).not.toThrow();
  expect(appliedSummary(record)).toContain(`build ${(job.wallMs.op!/1000).toFixed(1)} s`);
  expect(patchOutcomeLine(job).text).toContain(`build ${(job.wallMs.op!/1000).toFixed(1)} s (assemble → rig → check)`);
  // A record that says build but carries no measurements, or measurements on another op, is refused.
  const {assembled:_,...bare}=record;expect(()=>parseAppliedContext(bare)).toThrow('assembled');
  expect(()=>parseAppliedContext({...record,op:'rig'})).toThrow('assembled');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#115 bar 3: the producer\'s refusal comes back verbatim by name, and nothing is left in scratch',async()=>{
 const {root,p,server,base,state}=await fixture();
 try{
  const status=await statusOf(base);
  const ops=cutOps(setVertex(new Map(),cutsSource(config).cuts[1]!,2,[900,742]),[],config);
  const job=await settle(base,await (await post(base,{patch:patchFor(status.inputs.configHash,ops)})).json() as PatchJobView);
  expect(job.status).toBe('refused');
  expect(job.producerLine).toBe('FAIL  ASSEMBLE_CUT_INSIDE: config.assemble.cuts[1].polygon — has the point 900,742 past the 832x1216 rig');
  expect(job.assembled!.refusals).toEqual([job.producerLine!]);
  expect(patchOutcomeLine(job)).toEqual({text:job.producerLine!,error:true});
  expect(await Bun.file(join(state,'rebuild',p.sourceHash,job.id)).exists()).toBe(false);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#115: without a declared painting and full run the build refuses by name before anything runs; a new file path is held',async()=>{
 const bare=await fixture(false);
 try{
  const status=await statusOf(bare.base);
  expect(status.cuts?.build).toMatch(/^MODELING_INPUT_UNAVAILABLE: source painting and See-through runs/);
  const ops=cutOps(setVertex(new Map(),cutsSource(config).cuts[0]!,2,[386,742]),[],config);
  const body=await (await post(bare.base,{patch:patchFor(status.inputs.configHash,ops)})).json() as {status:string;error:string};
  expect(body.status).toBe('refused');expect(body.error).toMatch(/^MODELING_INPUT_UNAVAILABLE: source painting and See-through runs — rig-parts build/);
 }finally{await bare.server.stop(true);await rm(bare.root,{recursive:true,force:true});}
 const full=await fixture();
 try{
  const status=await statusOf(full.base);
  const body=await (await post(full.base,{patch:patchFor(status.inputs.configHash,[{op:'add',path:'/assemble/cuts/1/under',value:'mine.png',name:'ribbon_l'}])})).json() as {status:string;error:string};
  expect(body).toMatchObject({status:'refused'});expect(body.error).toMatch(/^EDIT_PATCH_PATH_HELD: assemble\.cuts\[1\]\.under/);
 }finally{await full.server.stop(true);await rm(full.root,{recursive:true,force:true});}
});

test('#115: the build readout keeps every FAIL line, the cut and limb lines, the base set\'s seam pairs and check\'s line',()=>{
 const r=buildReadout(['[assemble]   cut: "a" opaque 3 = "a" 2 + "b" 1','[assemble]   limb cap: "arm_r" joint "elbow" at [305, 444]','[assemble]   FAIL  CONFIG_PART_UNIQUE: config.assemble.cuts[2].into — names the part "topwear"','[check]   seam pair 1 of 1: "a" / "b" at the setup pose: 1 px over 40','[check]   seam pair (mouth_mid) 1 of 1: "a" / "b"','[check] check: FAIL; 1 bar(s) not met']);
 expect(r.refusals).toEqual(['FAIL  CONFIG_PART_UNIQUE: config.assemble.cuts[2].into — names the part "topwear"']);
 expect(r.assemble).toHaveLength(2);expect(r.seamPairs).toEqual(['seam pair 1 of 1: "a" / "b" at the setup pose: 1 px over 40']);expect(r.check).toBe('check: FAIL; 1 bar(s) not met');
});

test('#115: a check that finds a bar not met keeps the build (check\'s judgment, verbatim); the record refuses submission',async()=>{
 const {root,server,base}=await fixture();
 try{
  const status=await statusOf(base);
  const ops=cutOps(setVertex(new Map(),cutsSource(config).cuts[1]!,2,[451,742]),[],config);
  const job=await settle(base,await (await post(base,{patch:patchFor(status.inputs.configHash,ops)})).json() as PatchJobView);
  expect(job.status).toBe('built');expect(job.exitCode).toBe(1);
  expect(job.producerLine).toBe('build: stopped at check; 1 bar(s) not met, so no loop was encoded and no artifact is reported');
  expect(job.assembled!.refusals).toEqual([]);
  expect(job.assembled!.checkFails).toEqual(['FAIL  CHECK_SEAM_WITHIN_BAR: the setup-pose render vs the flat composite of parts/ — 50.83 rig px']);
  expect(job.check).toMatchObject({pass:false,line:'check: FAIL; 1 of 13 bar(s) not met'});
  const {appliedCheckRefusal}=await import('../src/applied-context.ts');
  expect(appliedCheckRefusal(patchAppliedRecord(job))).toBe('EDIT_SUBMIT_UNCHECKED: applied build failed check — check: FAIL; 1 of 13 bar(s) not met');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});
