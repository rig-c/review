import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {opRoute,patchRoute,RETUNE_SINCE,routeForPatch} from '../src/retune-route.ts';
import {appliedSummary,parseAppliedContext} from '../src/applied-context.ts';
import {patchAppliedRecord,patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

test('#136: retune\'s scope, read off its help — constraints, the idle\'s tracks and duration, the blink\'s numbers; everything else rebuilds the whole rig',()=>{
 const table:[string,'retune'|'rig'][]=[
  ['/constraints/0/damping','retune'],['/constraints/3','retune'],['/constraints/-','retune'],['/constraints','retune'],
  ['/motion/tracks/0/amp','retune'],['/motion/tracks/2/amps/1','retune'],['/motion/tracks/-','retune'],['/motion/tracks/1','retune'],['/motion/duration','retune'],
  ['/motion/blink/t','retune'],['/motion/blink/squash','retune'],['/motion/blink/brow_drop','retune'],
  // Held by retune: the blink's groups (eyes, brows), its still slot, animations_from, stops, bones, regions, turn, meshes.
  ['/motion/blink','rig'],['/motion/blink/eyes/0','rig'],['/motion/blink/brows','rig'],['/motion/blink/still','rig'],['/motion/blink/still/lash','rig'],
  ['/motion/animations_from','rig'],['/motion','rig'],['/stops/0','rig'],['/bones/0/at','rig'],['/bones/2/inherit','rig'],['/bones/1/link_inherit','rig'],
  ['/regions/hat','rig'],['/turn/pivot','rig'],['/turn/depths/hat','rig'],['/meshes/topwear/contour/spacing','rig'],['/constraintsX','rig'],['/motion/tracksX/0','rig'],
 ];
 for(const [path,route] of table)expect({path,route:opRoute(path)}).toEqual({path,route});
 // A patch is retune's only when every op is; one held op sends the whole patch to the whole-rig path.
 expect(routeForPatch([{path:'/constraints/0/damping'},{path:'/motion/tracks/0/amp'}])).toBe('retune');
 expect(routeForPatch([{path:'/constraints/0/damping'},{path:'/stops/0'}])).toBe('rig');
 expect(routeForPatch([])).toBe('rig');
 // The floor: parts 1.44.0's CHANGELOG is the first with retune.
 expect(RETUNE_SINCE).toBe('1.44.0');
 expect(patchRoute([{path:'/constraints/0/damping'}],'1.44.0')).toBe('retune');
 expect(patchRoute([{path:'/constraints/0/damping'}],'1.45.2')).toBe('retune');
 expect(patchRoute([{path:'/constraints/0/damping'}],'1.43.9')).toBe('rig');
 expect(patchRoute([{path:'/bones/0/at'}],'1.44.0')).toBe('rig');
});

/**
 * A repaired build. The inspected rig's rig.json carries a hand repair (`skins.topwear.repaired`) no config states, so
 * the stand-in `rig-parts rig` — <parts>/rig with the config's bones, stops, constraints and idle written over it, the
 * repair not among them — does not reproduce it: the baseline is "not reproduced" at rig.json. The stand-in `retune`
 * does what its help says: rebuilds as rig does, refuses RETUNE_REQUEST_HELD when the rebuild's bones, stops or
 * motion.json outside animations.idle differ from the input's, and otherwise writes the input with rig.json's
 * constraints and motion.json's animations.idle the rebuild's, plus retune.json.
 */
const config={key:'k',bones:[{name:'chest',at:[400,300]}],stops:[{chain:'leg',against:'hip',at:[0,0],inward:10,outward:20}],
 constraints:[{type:'physics',name:'c0',bone:'chest',rotate:1,strength:100,damping:0.85}],
 motion:{duration:4,tracks:[{bone:'chest',prop:'rotate',amp:2,period:4,phase:0}]}};
const rigJson=(repaired:boolean)=>JSON.stringify({bones:config.bones,slots:[{name:'topwear',bone:'chest'}],stops:config.stops,constraints:config.constraints,invariants:{detached:[]},skins:{topwear:repaired?{vertices:[1,2,3],repaired:true}:{vertices:[1,2,3]}}});
const motionJson=JSON.stringify({spec:'rigc-motion/1',groups:{eyes:['eye']},animations:{idle:{duration:4,tracks:config.motion.tracks},smile:{duration:1,tracks:[]}}});
const fakeParts=`const fs=require('fs'),path=require('path'),os=require('os');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
const build=(cfgPath,parts,out)=>{const cfg=JSON.parse(fs.readFileSync(path.resolve(cfgPath),'utf8'));copy(path.join(parts,'rig'),out);
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));delete rig.skins.topwear.repaired;rig.bones=cfg.bones;rig.stops=cfg.stops;rig.constraints=cfg.constraints;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 const motion=JSON.parse(fs.readFileSync(path.join(out,'motion.json'),'utf8'));motion.animations.idle={duration:cfg.motion.duration,tracks:cfg.motion.tracks};fs.writeFileSync(path.join(out,'motion.json'),JSON.stringify(motion));};
if(a[0]==='rig'){build(f('--config'),f('--parts'),f('--out'));console.log('rig-parts rig: wrote rig.json under '+f('--out'));process.exit(0);}
if(a[0]==='retune'){const out=f('--out'),input=f('--rig');if(fs.existsSync(out)){console.log('  FAIL  RETUNE_OUT_FRESH: '+out+' — exists');process.exit(1);}
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fake-retune-')),rebuilt=path.join(tmp,'rig');build(f('--config'),f('--parts'),rebuilt);
 const r=n=>JSON.parse(fs.readFileSync(path.join(input,n),'utf8')),b=n=>JSON.parse(fs.readFileSync(path.join(rebuilt,n),'utf8'));
 const inRig=r('rig.json'),reRig=b('rig.json'),inMotion=r('motion.json'),reMotion=b('motion.json');fs.rmSync(tmp,{recursive:true,force:true});
 for(const k of ['stops','bones','slots'])if(JSON.stringify(inRig[k])!==JSON.stringify(reRig[k])){console.log('rig-parts retune: '+input);console.log('  FAIL  RETUNE_REQUEST_HELD: rig.json '+k+' — the config changes it (input vs rebuilt: '+k+'[0]); a retune replaces constraints and the idle and holds every other byte of the input, so nothing is written — make it a rebuild with rig --config');console.log('refused: 1 problem(s)');process.exit(1);}
 const outside=m=>JSON.stringify({...m,animations:Object.fromEntries(Object.entries(m.animations).filter(([k])=>k!=='idle'))});
 if(outside(inMotion)!==outside(reMotion)){console.log('  FAIL  RETUNE_REQUEST_HELD: motion.json — outside animations.idle');process.exit(1);}
 copy(input,out);inRig.constraints=reRig.constraints;inMotion.animations.idle=reMotion.animations.idle;
 fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(inRig));fs.writeFileSync(path.join(out,'motion.json'),JSON.stringify(inMotion));
 const e=f('--page-edges'),s=f('--pack-shape');fs.writeFileSync(path.join(out,'retune.json'),JSON.stringify({spec:'rig-parts-retune/1',request:{idle_keys:a.includes('--idle-keys')?f('--idle-keys'):'ctl',page_edges:a.includes('--page-edges')?e:'free',pack_shape:a.includes('--pack-shape')?s:'polygon'}}));
 console.log('rig-parts retune: wrote 5 file(s) under '+out+', the provenance in retune.json');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=fs.readFileSync(f('--rig'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:crypto.createHash('sha256').update(rig).digest('hex')}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;

async function fixture(version:string,repaired:boolean){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-retune-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),rigJson(repaired));await writeFile(join(rig,'motion.json'),motionJson);
 await writeFile(join(rig,'sets.json'),'{"sets":[]}');await writeFile(join(rig,'mesh_report.json'),'{"parts":{}}');await writeFile(join(rig,'images','topwear.png'),'png-topwear');
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state')};
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,started:Response):Promise<PatchJobView&{error?:string}>{let job=await started.json() as PatchJobView;for(let i=0;job.status==='running'&&i<400;i++){await Bun.sleep(25);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json() as PatchJobView;}return job;}
const patchFor=(configSha:string,version:string,ops:ConfigPatch['ops']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version},op:{cmd:'rig',args:[]}});
const damping=[{op:'replace' as const,path:'/constraints/0/damping',value:0.6,name:'c0'}];
const boneMove=[{op:'replace' as const,path:'/bones/0/at',value:[402,300],name:'chest'}];
const idleAmp=[{op:'replace' as const,path:'/motion/tracks/0/amp',value:3}];

/** One session on a fixture: the baseline settled, then each patch Applied in turn; the package's md5 before and after. */
async function session(version:string,repaired:boolean,patches:ConfigPatch['ops'][]){
 const {root,pkg,state}=await fixture(version,repaired),before=await treeMd5(pkg);
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  let status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string};baseline:{status:string;firstDifference:string|null}};
  for(let i=0;status.baseline?.status==='running'&&i<400;i++){await Bun.sleep(25);status=await (await fetch(base+'/api/rebuild')).json() as typeof status;}
  const jobs:(PatchJobView&{error?:string})[]=[];
  for(const ops of patches)jobs.push(await settle(base,await post(base,{patch:patchFor(status.inputs.configHash,version,ops)})));
  return {baseline:status.baseline,jobs,unchanged:before===await treeMd5(pkg)};
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
}

test('#136 bars 1–3: on a repaired build (baseline not reproduced) a damping patch and an idle patch Apply via retune, touching only their own place; a bone move still refuses EDIT_BASELINE_MISMATCH',async()=>{
 const {baseline,jobs:[physics,bone,idle],unchanged}=await session('1.44.0',true,[damping,boneMove,idleAmp]);
 expect(baseline).toMatchObject({status:'not-reproduced',firstDifference:'rig/out/rig/rig.json'});
 // (bun's toMatchObject writes its matchers into the received object, so the record is taken first.)
 const record=patchAppliedRecord({...physics,build:{...physics.build!}});
 // Bar 1: retune ran, rig.json differs only under /constraints, motion.json and the images are the inspected rig's.
 expect(physics).toMatchObject({status:'built',op:'retune'});expect(physics.producerLine).toStartWith('rig-parts retune: wrote');
 expect(physics.lines).toContain('review: @rig-c/parts 1.44.0 retune --rig <handoff rig> --config config.json (the handoff config with 1 patch op(s)) → scratch rig');
 expect(physics.files!.documents).toEqual([{file:'rig.json',count:1,paths:['/constraints/0/damping']},{file:'motion.json',count:0,paths:[]},{file:'sets.json',count:0,paths:[]},{file:'mesh_report.json',count:0,paths:[]}]);
 expect(physics.files!.images).toEqual({changed:0,unchanged:1,names:[]});
 // context.applied records the op; the export line names it.
 expect(record.op).toBe('retune');expect(()=>parseAppliedContext(record)).not.toThrow();
 expect(appliedSummary(record)).toContain('(retune; replace /constraints/0/damping)');
 expect(patchOutcomeLine(physics).text).toContain('retune ');
 expect(()=>parseAppliedContext({...record,op:'remesh'})).toThrow('feedback.context.applied.op');
 // Bar 2: a bone move is outside retune's scope, so it keeps the whole-rig path and its guard.
 expect(bone).toMatchObject({status:'refused',error:'EDIT_BASELINE_MISMATCH: rig/out/rig/rig.json'});
 // Bar 3: the idle patch reaches motion.json's animations.idle only.
 expect(idle).toMatchObject({status:'built',op:'retune'});
 expect(idle.files!.documents).toEqual([{file:'rig.json',count:0,paths:[]},{file:'motion.json',count:1,paths:['/animations/idle/tracks/0/amp']},{file:'sets.json',count:0,paths:[]},{file:'mesh_report.json',count:0,paths:[]}]);
 expect(unchanged).toBe(true);
});

test('#136 bar 4: below the floor a damping patch keeps the whole-rig path behind the guard; above it on a reproduced baseline the fast whole-rig path still runs (same bytes), recorded as rig',async()=>{
 const old=await session('1.43.0',true,[damping]);
 expect(old.jobs[0]).toMatchObject({status:'refused',error:'EDIT_BASELINE_MISMATCH: rig/out/rig/rig.json'});
 const fresh=await session('1.44.0',false,[damping,[{op:'replace',path:'/stops/0',value:{...config.stops[0]!,inward:12},name:'leg'}]]);
 expect(fresh.baseline.status).toBe('reproduced');
 expect(fresh.jobs[0]).toMatchObject({status:'built',op:'rig'});expect(fresh.jobs[0]!.lines.some(l=>l.includes(' rig --config config.json'))).toBe(true);
 expect(fresh.jobs[1]).toMatchObject({status:'built',op:'rig'});
 expect(fresh.jobs[1]!.lines.some(l=>l.includes(' rig --config config.json'))).toBe(true);
 expect(fresh.jobs[1]!.files!.documents[0]).toEqual({file:'rig.json',count:1,paths:['/stops/0/inward']});
 expect(old.unchanged&&fresh.unchanged).toBe(true);
});
