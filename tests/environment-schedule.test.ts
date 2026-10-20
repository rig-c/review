import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createWindModel,type WindSnapshot} from '../src/environment.ts';
import {environmentFrame,parseSchedule,parseScheduleContext,SCHEDULE_CONTEXT_SCHEMA,SCHEDULE_FPS,scheduleText,scheduleTolerance,scheduleWorldAt,sha256Hex,standingSchedule,windAt,windSchedule} from '../src/environment-schedule.ts';
import {environmentSchedule,parseReadingsRequest} from '../src/readings.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {freshSession} from '../src/session.ts';
import {formatFeedbackIssues} from '../src/feedback-export.ts';
import {environmentCheckArgs,type EnvironmentCheckJob} from '../src/environment-check.ts';
import {parseAppliedContext} from '../src/applied-context.ts';
import {environmentCheckRows,scheduleContext,worldExport,ENVIRONMENT_NOT_APPLIED} from '../web/environment-world.ts';

/**
 * #112. Bar 1: the exported schedule, read the way rigc reads it (each step set before the physics step that ends on
 * the first frame at or after its t, the runtime's world before the first), against the panel's own wind model driven
 * the way the page drives it (`advance(dt)` per player step at 60 Hz from a fresh `restore`). Bar 2: the schedule's bytes
 * and their sha256 ride in feedback and survive save and validation. The route and Apply wiring run against stand-in
 * producers; the real producer bar is reproduced against an installed `@rig-c/parts` 1.48.0 (see the issue's PR).
 */
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const snap=(over:Partial<WindSnapshot>):WindSnapshot=>({version:1,base:0,breeze:false,repeat:false,gustPeak:48,gustDuration:2.4,...over});
/** The panel's wind at each 1/60 s step index in `steps`, from a fresh clock — what `stepEnvironment` hands the player. */
function panelWind(s:WindSnapshot,steps:readonly number[]):Map<number,number>{
 const model=createWindModel();model.restore(s);const out=new Map<number,number>();let n=0;
 for(const target of [...steps].sort((a,b)=>a-b)){while(n<target){model.advance(1/60);n++;}out.set(target,model.read().wind);}
 return out;
}
/** 10 sampled times (1/60 s step indices): six on the 12 fps grid (multiples of 5), four between frames. */
const SAMPLES=[0,5,37,60,83,100,131,155,180,200];
function table(s:WindSnapshot,gravity:number,duration:number){
 const e=windSchedule(s,gravity,duration),live=panelWind(s,SAMPLES);
 return {e,rows:SAMPLES.map(n=>{const t=n/60,w=scheduleWorldAt(e.schedule,t);return {t:Number(t.toFixed(4)),onGrid:n%5===0,frame:environmentFrame(t,SCHEDULE_FPS),panel:live.get(n)!,schedule:w.wind[0],gravity:w.gravity,diff:Math.abs(live.get(n)!-w.wind[0])};})};
}

test('#112 bar 1, step form: one step reproduces the panel\'s wind exactly at 10 sampled times',()=>{
 const s=snap({base:30});
 const {e,rows}=table(s,1.5,10/3);
 expect(e.form).toBe('step');expect(e.tolerance).toBe(0);
 // The step form is #108's standing schedule (reused, not rebuilt).
 expect(e.schedule).toEqual(standingSchedule({wind:[30,0],gravity:[0,1.5]}));
 expect(e.schedule).toEqual(environmentSchedule({wind:[30,0],gravity:[0,1.5]}));
 for(const r of rows){expect(r.diff).toBe(0);expect(r.gravity).toEqual([0,1.5]);}
 console.log('#112 bar 1 step form (base 30, gravity 1.5)\n'+rows.map(r=>`t ${r.t.toFixed(4)} F${r.frame}${r.onGrid?'':' (between frames)'} panel ${r.panel} schedule ${r.schedule} |Δ| ${r.diff}`).join('\n'));
});

test('#112 bar 1, sampled form: exact (float noise only) at frame times, within max|dw/dt|/fps between frames',()=>{
 // Breeze and a repeating gust (peak 48 over 2.4 s, period 6 s) on base 10, over idle's 3.333 s.
 const s=snap({base:10,breeze:true,repeat:true});
 const {e,rows}=table(s,1,10/3);
 expect(e.form).toBe('sampled');
 expect(e.tolerance).toBeCloseTo((2*2.2+0.8*5.1+48*Math.PI/2.4)/12,12);
 // One step per 12 fps frame up to the clip's last (frame 40 at t = 3.3333 s), none after it (rigc refuses a late step).
 expect(e.schedule.steps.length).toBe(41);expect(e.schedule.steps.at(-1)!.t).toBe(40/12);
 expect(e.schedule.steps.every((step,i)=>environmentFrame(step.t,12)===i)).toBe(true);
 for(const r of rows){if(r.onGrid)expect(r.diff).toBeLessThan(1e-9);else expect(r.diff).toBeLessThanOrEqual(e.tolerance);expect(r.gravity).toEqual([0,1]);}
 console.log(`#112 bar 1 sampled form (base 10, breeze, repeat 48/2.4 s; tolerance ${e.tolerance.toFixed(4)})\n`+rows.map(r=>`t ${r.t.toFixed(4)} F${r.frame}${r.onGrid?'':' (between frames)'} panel ${r.panel.toFixed(6)} schedule ${r.schedule.toFixed(6)} |Δ| ${r.diff.toExponential(2)}`).join('\n'));
 // Breeze alone: the tolerance is the breeze's bound, 0.7067.
 const b=table(snap({base:0,breeze:true}),1,10/3);expect(b.e.tolerance).toBeCloseTo(8.48/12,12);for(const r of b.rows)expect(r.diff).toBeLessThanOrEqual(r.onGrid?1e-9:b.e.tolerance);
 // A negative base turns the gust; a repeating gust alone drops the held calm steps.
 expect(windAt(snap({base:-5,repeat:true}),1.2)).toBeCloseTo(-5-48,9);
 const gust=windSchedule(snap({base:2,repeat:true,gustDuration:1}),1,10/3);expect(gust.schedule.steps.length).toBeLessThan(41);
 for(const n of SAMPLES){const t=n/60;expect(Math.abs(scheduleWorldAt(gust.schedule,t).wind[0]-panelWind(snap({base:2,repeat:true,gustDuration:1}),[n]).get(n)!)).toBeLessThanOrEqual(n%5===0?1e-9:gust.tolerance);}
});

test('#112: the schedule reads by rig-c\'s rules; no clip, a too-long clip and a not-applied panel are refused by name',()=>{
 const e=windSchedule(snap({breeze:true}),2,10/3),text=scheduleText(e.schedule);
 expect(parseSchedule(JSON.parse(text))).toEqual(e.schedule);
 expect(Object.keys(JSON.parse(text))).toEqual(['spec','steps']);
 for(const bad of [{spec:'rigc-environment/2',steps:[{t:0,wind:[1,0]}]},{spec:'rigc-environment/1',steps:[]},{spec:'rigc-environment/1',steps:[{t:0}]},{spec:'rigc-environment/1',steps:[{t:1,wind:[1,0]},{t:1,wind:[2,0]}]},{spec:'rigc-environment/1',steps:[{t:0,wind:[1,0],path:'/tmp'}]},{spec:'rigc-environment/1',steps:[{t:0,wind:[1]}]},{spec:'rigc-environment/1',steps:[{t:0,wind:[1,0]}],out:'/tmp'}])
  expect(()=>parseSchedule(bad)).toThrow('ENVIRONMENT_SCHEDULE_INVALID');
 expect(()=>windSchedule(snap({breeze:true}),1,0)).toThrow('ENVIRONMENT_SCHEDULE_NO_CLIP');
 expect(()=>windSchedule(snap({breeze:true}),1,60)).toThrow('ENVIRONMENT_SCHEDULE_TOO_LONG');
 expect(worldExport(snap({base:3}),1,false,'idle',10/3)).toEqual({error:ENVIRONMENT_NOT_APPLIED});
 // The readings request takes the schedule in place of the standing world, as data only.
 expect(parseReadingsRequest({animation:'idle',readings:[{kind:'folds'}],environment:e.schedule}).environment).toEqual(e.schedule);
 expect(()=>parseReadingsRequest({animation:'idle',readings:[{kind:'folds'}],environment:{...e.schedule,path:'x'}})).toThrow('READINGS_REQUEST_INVALID');
 expect(environmentSchedule(e.schedule)).toBe(e.schedule);
 expect(environmentCheckArgs({rig:'/r',parts:'/p',out:'out',environment:'environment.json'})).toEqual(['check','--rig','/r','--out','out','--parts','/p','--page-edges','free','--pack-shape','polygon','--environment','environment.json']);
 // The page's synchronous hash is SHA-256.
 for(const t of ['',text,'é'.repeat(1000)])expect(sha256Hex(t)).toBe(sha(t));
 expect(scheduleTolerance(snap({base:9}))).toBe(0);
});

/** Stand-ins: `check --environment` writes check.json's environment {path, sha256 of the bytes read, steps} and prints the bars; a spec it does not read is refused as parts 1.48.0 prints it. */
const fakeParts=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='rig'){const out=f('--out');fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of ['rig.json','motion.json','mesh_report.json'])fs.copyFileSync(path.join(f('--parts'),'rig',n),path.join(out,n));console.log('rig-parts rig: wrote');process.exit(0);}
if(a[0]!=='check')process.exit(3);
fs.appendFileSync(process.env.FAKE_LOG,'check '+a.join(' ')+' @'+process.cwd()+'\\n');
const out=f('--out'),env=a.includes('--environment')?f('--environment'):null;
let rec=null,wind=1;
if(env){const bytes=fs.readFileSync(path.resolve(env)),doc=JSON.parse(bytes);
 if(doc.spec!=='rigc-environment/1'){console.log('  FAIL  CHECK_ENVIRONMENT: '+env+' — --environment '+env+': "spec" is '+JSON.stringify(doc.spec)+'; render reads "rigc-environment/1" (see rig-parts guide CHECK_ENVIRONMENT)');console.log('refused: 1 problem(s)');process.exit(1);}
 const late=doc.steps.findIndex(s=>Math.round(s.t*12)>40);if(late>=0){console.log('  FAIL  CHECK_ENVIRONMENT: '+env+' — --environment '+env+': entry '+late+"'s t "+doc.steps[late].t+' falls after the last frame of every set drawn — the longest, "idle", ends at frame 40, t=3.3333s at 12 fps — so it would change nothing; rigc 2.64.1 ran it (see rig-parts guide CHECK_ENVIRONMENT)');console.log('refused: 1 problem(s)');process.exit(1);}
 rec={path:env,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),steps:doc.steps.length};wind=Math.max(...doc.steps.map(s=>s.wind?Math.abs(s.wind[0]):0));
 console.log('  environment: '+env+', rigc-environment/1, '+rec.steps+' step(s), sha256 '+rec.sha256.slice(0,16)+' — every render a bar or a warning reads with the physics on is posed under it; the physics-off, setup-pose and loop renders are not');}
const severity=(1+wind/10).toFixed(3),pass=wind<10;
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:pass,gate_spine_html_green:true,TEXTURE_STRETCH:{status:pass?'PASS':'FAIL'},ANIMATIONS_DO_NOT_FOLD:{status:'PASS'},...(rec?{environment:rec}:{})}));
console.log('  TEXTURE_STRETCH: '+(pass?'PASS':'FAIL')+' — severity '+severity);console.log('  ANIMATIONS_DO_NOT_FOLD: PASS — 0 folding mesh(es)');console.log(pass?'check: PASS':'check: FAIL — 1 bar(s) not met');process.exit(pass?0:1);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=fs.readFileSync(f('--rig'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:crypto.createHash('sha256').update(rig).digest('hex')}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
const constraints=[{type:'physics',name:'c0',bone:'hip',wind:1,strength:100,damping:0.85}];
async function fixture(version='1.48.0'){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-environment-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify({key:'k',constraints}));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify({bones:[{name:'root'},{name:'hip',parent:'root'}],constraints}));await writeFile(join(rig,'mesh_report.json'),'{}');await writeFile(join(rig,'motion.json'),JSON.stringify({animations:{idle:{duration:10/3}}}));
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version,bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 const log=join(root,'calls.log');await writeFile(log,'');
 return {root,pkg,state:join(root,'state'),log};
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const post=(base:string,path:string,body:unknown,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
async function settle<J extends {id:string;status:string}>(base:string,path:string,job:J,done=(j:J)=>j.status!=='running'):Promise<J>{let current=job;for(let i=0;!done(current)&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}${path}/${current.id}`)).json() as J;}return current;}

test('#112: Check under this world writes the exported bytes, check.json records their sha256, the bars come back beside the default world; refusals verbatim',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const before=await treeMd5(pkg),p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const e=windSchedule(snap({base:40}),1,10/3),text=scheduleText(e.schedule);
  const started=await post(base,'/api/environment-check',{build:'inspected',schedule:e.schedule});expect(started.status).toBe(202);
  const job=await settle(base,'/api/environment-check',await started.json() as EnvironmentCheckJob);
  expect(job.status).toBe('checked');
  expect(job.schedule).toEqual({sha256:sha(text),size:Buffer.byteLength(text),steps:1});
  expect(job.environment).toEqual({path:'environment.json',sha256:sha(text),steps:1});
  expect(job.environmentLine).toStartWith(`environment: environment.json, rigc-environment/1, 1 step(s), sha256 ${sha(text).slice(0,16)}`);
  expect(job.bars).toEqual([{name:'ANIMATIONS_DO_NOT_FOLD',line:'ANIMATIONS_DO_NOT_FOLD: PASS — 0 folding mesh(es)'},{name:'TEXTURE_STRETCH',line:'TEXTURE_STRETCH: FAIL — severity 5.000'}]);
  expect(job.check).toMatchObject({pass:false,line:'check: FAIL — 1 bar(s) not met'});
  const call=(await readFile(log,'utf8')).trim().split('\n').at(-1)!;
  expect(call.split(' @')[0]).toContain('--page-edges free --pack-shape polygon --environment environment.json');
  // The rows beside the default world's line; the same schedule again is read back, not re-run.
  const rows=environmentCheckRows(job as never,name=>`${name}: PASS (default)`,'default world');
  expect(rows.map(r=>r.text)).toContain('this world: TEXTURE_STRETCH: FAIL — severity 5.000');expect(rows.map(r=>r.text)).toContain('default world: TEXTURE_STRETCH: PASS (default)');
  const again=await (await post(base,'/api/environment-check',{build:'inspected',schedule:e.schedule})).json() as EnvironmentCheckJob;
  expect(again).toMatchObject({id:job.id,status:'checked'});expect((await readFile(log,'utf8')).trim().split('\n')).toHaveLength(1);
  // A schedule the producer refuses comes back as its line, verbatim; nothing kept.
  const late={spec:'rigc-environment/1',steps:[{t:0,wind:[1,0]},{t:9,wind:[3,0]}]};
  const refused=await settle(base,'/api/environment-check',await (await post(base,'/api/environment-check',{build:'inspected',schedule:late})).json() as EnvironmentCheckJob);
  const line='FAIL  CHECK_ENVIRONMENT: environment.json — --environment environment.json: entry 1\'s t 9 falls after the last frame of every set drawn — the longest, "idle", ends at frame 40, t=3.3333s at 12 fps — so it would change nothing; rigc 2.64.1 ran it (see rig-parts guide CHECK_ENVIRONMENT)';
  expect(refused).toMatchObject({status:'refused',error:line,check:null,bars:[]});
  expect(environmentCheckRows(refused as never,()=>'',"")).toEqual([{kind:'error',text:line}]);
  // Envelope: data only, same origin, bounded, no scratch build yet, nothing written into the package.
  expect((await post(base,'/api/environment-check',{build:'inspected',schedule:e.schedule,path:'/tmp'})).status).toBe(400);
  expect((await post(base,'/api/environment-check',{build:'inspected',schedule:{...e.schedule,spec:'rigc-environment/2'}})).status).toBe(400);
  expect((await post(base,'/api/environment-check',{build:'inspected',schedule:e.schedule},'http://evil.test')).status).toBe(403);
  expect((await post(base,'/api/environment-check','x'.repeat(70*1024))).status).toBe(400);
  expect(await (await post(base,'/api/environment-check',{build:'scratch',schedule:e.schedule})).json()).toEqual({status:'refused',error:'ENVIRONMENT_CHECK_NO_SCRATCH: no scratch build in this session yet; Apply builds one, or check the inspected rig'});
  expect(frontRoute('single','POST','/api/environment-check')).toMatchObject({mutation:true,limit:64*1024});
  expect(frontRoute('single','GET','/api/environment-check/'+'a'.repeat(64))).toMatchObject({mutation:false});
  expect(frontRoute('compare','POST','/api/environment-check')).toBeNull();
  expect(await treeMd5(pkg)).toBe(before);
  expect((await readdir(join(state,'environment-check',p.sourceHash,job.id))).sort()).toEqual(['environment.json','result.json']);
  // The refused run is kept as its result (the same schedule is read back), its check output removed.
  expect((await readdir(join(state,'environment-check',p.sourceHash,refused.id))).sort()).toEqual(['environment.json','result.json']);
  expect(await readFile(join(state,'environment-check',p.sourceHash,job.id,'environment.json'),'utf8')).toBe(text);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#112: a producer before 1.48.0 is refused by name for check --environment and for Apply under the world; nothing runs',async()=>{
 const {root,pkg,state,log}=await fixture('1.47.0');process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const e=windSchedule(snap({base:40}),1,10/3);
  const line='MODELING_PRODUCER_TOO_OLD 1.47.0 1.48.0: rig-parts check --environment needs @rig-c/parts 1.48.0 or later — bun add -d @rig-c/parts@latest';
  expect(await (await post(base,'/api/environment-check',{build:'inspected',schedule:e.schedule})).json()).toEqual({status:'refused',error:line});
  const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}};
  const patch={schema:'rig-review-config-patch/1',config_sha256:status.inputs.configHash,producer:{name:'@rig-c/parts',version:'1.47.0'},op:{cmd:'rig',args:[]},ops:[{op:'replace',path:'/constraints/0/strength',value:90,name:'c0'}]};
  const refused=await (await post(base,'/api/rebuild',{patch,environment:e.schedule})).json() as {status:string;error:string};
  expect(refused).toMatchObject({status:'refused',error:line});
  expect(await readFile(log,'utf8')).toBe('');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#112: Apply {patch, environment} hands check the same bytes; the job and its applied record carry the schedule\'s hash',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string}};
  const e=windSchedule(snap({base:4,breeze:true}),1,10/3),text=scheduleText(e.schedule);
  const patch={schema:'rig-review-config-patch/1',config_sha256:status.inputs.configHash,producer:{name:'@rig-c/parts',version:'1.48.0'},op:{cmd:'rig',args:[]},ops:[{op:'replace',path:'/constraints/0/strength',value:90,name:'c0'}]};
  // The baseline must reproduce before a whole-rig op; this fixture's stand-in rig copies the inspected rig.
  const first=await post(base,'/api/rebuild',{patch,environment:e.schedule});const body=await first.json() as {id?:string;status:string;error?:string};
  if(!body.id)throw new Error(`apply refused: ${body.error}`);
  const job=await settle(base,'/api/rebuild',body as {id:string;status:string;environment?:unknown;lines:string[];check:unknown});
  expect(job.status).toBe('built');
  expect(job.environment).toEqual({sha256:sha(text),steps:e.schedule.steps.length});
  const call=(await readFile(log,'utf8')).trim().split('\n').find(l=>l.startsWith('check check --rig rig '))!;
  expect(call.split(' @')[0]).toEndWith('--environment environment.json');
  expect(await readFile(join(call.split(' @')[1]!,'environment.json'),'utf8')).toBe(text);
  expect(job.lines.some(l=>l.includes(`--environment environment.json (the exported schedule, ${e.schedule.steps.length} step(s), sha256 ${sha(text).slice(0,16)})`))).toBe(true);
  // A default-world Apply of the same patch is a different build.
  const plain=await (await post(base,'/api/rebuild',{patch})).json() as {id:string};expect(plain.id).not.toBe(job.id);
  await settle(base,'/api/rebuild',plain as {id:string;status:string});
  // Malformed: a schedule key it does not read.
  expect((await post(base,'/api/rebuild',{patch,environment:{...e.schedule,out:'/tmp'}})).status).toBe(400);
  expect((await post(base,'/api/rebuild',{patch,environment:e.schedule,extra:1})).status).toBe(400);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#112 bar 2: feedback carries the schedule\'s sha256 and bytes through save and validation; a hash of other bytes is refused',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const world=worldExport(snap({base:10,breeze:true,repeat:true}),1.25,true,'idle',10/3);if('error' in world)throw new Error(world.error);
  const schedule=scheduleContext(world,true);
  expect(schedule).toEqual({schema:SCHEDULE_CONTEXT_SCHEMA,sha256:sha(world.text),size:Buffer.byteLength(world.text),text:world.text,usedForReadings:true});
  const note={id:'n1',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.feedbackCatalog.rig},category:'quality',summary:'skirt under breeze',context:{animation:null,environmentSchedule:schedule}};
  const put=(feedback:unknown[])=>fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...freshSession(p),feedback})});
  expect((await put([note])).status).toBe(200);
  const read=await (await fetch(base+'/api/session')).json();
  const carried=read.feedback[0].context.environmentSchedule;
  expect(carried).toEqual(schedule);expect(sha(carried.text)).toBe(carried.sha256);
  expect(parseSchedule(JSON.parse(carried.text))).toEqual(world.schedule);
  // The issue text (markdown-escaped) names the step count and the full hash.
  expect(formatFeedbackIssues(read)).toContain(`- Environment schedule: rigc&#45;environment/1, ${world.schedule.steps.length} step&#40;s&#41; · schedule sha256 ${sha(world.text)} · used for readings and Apply`);
  // Mutants: a hash of other bytes; a text that is not a schedule; an extra key.
  const wrong=await put([{...note,context:{animation:null,environmentSchedule:{...schedule,sha256:sha(world.text+' ')}}}]);
  expect(wrong.status).toBe(400);expect((await wrong.json()).error).toBe('feedback.context.environmentSchedule: sha256 is not the sha256 of text');
  const notSchedule='{"spec":"rigc-environment/1","steps":[]}\n';
  expect(()=>parseScheduleContext({...schedule,text:notSchedule,sha256:sha(notSchedule),size:Buffer.byteLength(notSchedule)},sha)).toThrow('is not a rigc-environment/1 schedule');
  expect(()=>parseScheduleContext({...schedule,path:'/tmp'},sha)).toThrow('expected exactly');
  // Absent or null stays valid.
  expect((await put([{...note,context:{animation:null,environmentSchedule:null}}])).status).toBe(200);
  // The applied record's optional environment is validated by shape.
  expect(()=>parseAppliedContext({schema:'rig-review-applied/2',environment:{sha256:'x',steps:1}})).toThrow();
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});
