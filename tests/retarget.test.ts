import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {runTool} from '../src/producer.ts';
import {assertRetargetRecord,cleanArgs,cleanArgv,DEFAULT_FLAGS,parseRetargetFlags,parseRetargetRequest,retargetArgs,retargetArgv,retargetLines,RetargetError,type RetargetFlags,type RetargetRecord} from '../src/retarget.ts';
import {APPLIED_RETARGET_SCHEMA,appliedSummary,parseAppliedContext} from '../src/applied-context.ts';

/**
 * #114 Retarget tuning. The pure half (typed flags → argv, the request's envelope, the record, the listed lines) and the
 * runner with stand-in producers: `rig-pose` (clean adds its record; retarget refuses an uncleaned sequence, a bone the
 * rig lacks and a name the rig already has, by name, else adds one animation whose keys depend on the map, the sequence
 * and every flag it was given, and writes its report's frameTimes beside --out) and `rigc` (a model carrying the rig's
 * and the motion's hashes). Bar 1: the scratch motion is byte-equal to a direct run of the same producer with the
 * record's flags. Bar 2: the package's motion.json md5 (and every package file) is unchanged by Apply.
 */
const fakePose=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>{const i=a.indexOf(n);return i<0?undefined:a[i+1];};
const h=t=>crypto.createHash('sha256').update(t).digest('hex');
if(a[0]==='clean'){const seq=JSON.parse(fs.readFileSync(f('--pose'),'utf8'));seq.cleaned={spec:'rig-pose-clean/1',params:{argv:a.slice(5)}};fs.writeFileSync(f('--out'),JSON.stringify(seq,null,2)+'\\n');console.log('  CLEAN  rig-pose-clean/1: '+a.slice(5).join(' '));console.log('  wrote '+f('--out'));process.exit(0);}
if(a[0]==='retarget'){const seqPath=f('--sequence'),seqText=fs.readFileSync(seqPath,'utf8'),seq=JSON.parse(seqText);
 if(!seq.cleaned){console.log('FAIL  POSE_NOT_CLEANED: '+seqPath+' has no "cleaned" record; run rig-pose clean');console.log('rig-pose retarget: 1 problem(s) — nothing written');process.exit(1);}
 const mapText=fs.readFileSync(f('--map'),'utf8'),map=JSON.parse(mapText),rig=JSON.parse(fs.readFileSync(path.join(f('--rig'),'rig.json'),'utf8')),bones=rig.bones.map(b=>b.name);
 const missing=[];for(const c of map.chains)for(const b of c.bones)if(!bones.includes(b))missing.push('FAIL  MAP_BONE_EXISTS: chain "'+c.name+'" — bone "'+b+'" is not in the rig');
 if(missing.length){console.log('FAIL  MAP_RESOLVES: '+f('--map')+' does not resolve against the rig');for(const m of missing)console.log(m);console.log('rig-pose retarget: '+(missing.length+1)+' problem(s) — nothing written');process.exit(1);}
 const motion=JSON.parse(fs.readFileSync(path.join(f('--rig'),'motion.json'),'utf8')),name=f('--animation')||'dance';
 if(motion.animations[name]){console.log('FAIL  MOTION_NAME_FREE: the rig\\'s motion spec already has an animation "'+name+'"');process.exit(1);}
 const flags=a.slice(9),t0=seq.frames[0].t,times=seq.frames.map(x=>+(x.t-t0).toFixed(5)),seed=h(mapText+seqText+JSON.stringify(flags));
 const tracks={};for(const c of map.chains)for(const b of c.bones)tracks[b]={rotate:times.map((time,i)=>({time,value:parseInt(h(seed+b+i).slice(0,6),16)/1e5}))};
 motion.animations[name]={duration:times[times.length-1],bones:tracks};
 if(flags.includes('--flip'))console.log('  FLIP   chain "'+map.chains[0].name+'" bone "'+map.chains[0].bones[0]+'" turned +40.0° from frame 1 to 2 (t=0.040–0.080s), over '+f('--flip')+'° in one frame; spread over frames 1–2 (h=1)');
 console.log('  GATE   rigc build --profile spine: green');
 const out=f('--out');fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,JSON.stringify(motion,null,1)+'\\n');
 fs.writeFileSync(out.replace(/\\.json$/,'')+'.report.json',JSON.stringify({spec:'rig-pose-report/1',frameTimes:times}));
 console.log('  wrote '+out+' — animations: '+Object.keys(motion.animations).join(', '));process.exit(0);}
process.exit(2);`;
const fakeRigc=`const fs=require('fs'),path=require('path'),crypto=require('crypto');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const h=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],rig:h(f('--rig')),motion:h(f('--motion'))}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
const fakeParts=`console.log('rig-parts');process.exit(0);`;
const rigJson={bones:[{name:'root'},{name:'hip'},{name:'chest'},{name:'arm0'},{name:'arm1'}]};
const inspectedMotion={animations:{idle:{duration:2,bones:{chest:{rotate:[{time:0,value:0},{time:2,value:1}]}}}}};
const sequence={spec:'rig-pose-sequence/1',space:{units:'picture-px',origin:'top-left',y:'down'},width:100,height:200,source:'test',
 frames:[0,1,2,3].map(i=>({t:1+i*0.04,people:[{id:'a',joints:{neck:{state:'observed',at:[50,40+i],score:0.9},r_shoulder:{state:'observed',at:[40,45],score:0.9},r_elbow:{state:'observed',at:[35,60+i],score:0.9},r_wrist:{state:'observed',at:[30,75],score:0.9}}}]}))};
const map={spec:'rig-pose-map/1',chains:[{name:'arm_r',bones:['arm0','arm1'],joints:['r_shoulder','r_elbow','r_wrist'],bend:'free'}],translate:{bone:'hip',joint:'neck',scale:{pose:['neck','r_wrist'],rig:['hip','chest']}}};

async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-retarget-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify({key:'k'}));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify(rigJson));await writeFile(join(rig,'motion.json'),JSON.stringify(inspectedMotion));
 await writeFile(join(rig,'sets.json'),'{"sets":[]}');await writeFile(join(rig,'mesh_report.json'),'{}');await writeFile(join(rig,'images','arm0.png'),'png-arm0');
 await writeFile(join(pkg,'motion.json'),JSON.stringify(inspectedMotion));await writeFile(join(pkg,'dance.pose.json'),JSON.stringify(sequence));
 const tool=async(dir:string,name:string,version:string,bin:string,text:string)=>{await mkdir(join(root,'node_modules',dir,'bin'),{recursive:true});await writeFile(join(root,'node_modules',dir,'package.json'),JSON.stringify({name,version,bin:{[bin]:`./bin/${bin}.cjs`}}));await writeFile(join(root,'node_modules',dir,'bin',`${bin}.cjs`),text);};
 await tool('@rig-c/pose','@rig-c/pose','0.37.0','rig-pose',fakePose);await tool('rig-c','rig-c','2.64.1','rigc',fakeRigc);await tool('@rig-c/parts','@rig-c/parts','1.44.0','rig-parts',fakeParts);
 return {root,pkg,state:join(root,'state')};
}
const md5=(bytes:Uint8Array|string)=>createHash('md5').update(bytes).digest('hex');
async function tree(dir:string):Promise<Record<string,string>>{const out:Record<string,string>={};const walk=async(d:string)=>{for(const e of await readdir(d,{withFileTypes:true})){const full=join(d,e.name);if(e.isDirectory())await walk(full);else out[relative(dir,full)]=md5(await readFile(full));}};await walk(dir);return out;}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,body:{id?:string;status:string}):Promise<Record<string,unknown>>{let current=body as Record<string,unknown>;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json() as Record<string,unknown>;}return current;}
const flags=(over:Partial<RetargetFlags>={}):RetargetFlags=>({...structuredClone(DEFAULT_FLAGS),...over});

test('typed flags map to argv; only what is stated, the paths never', () => {
 expect(retargetArgv(flags({animation:'dance'}))).toEqual(['--animation','dance']);
 expect(retargetArgv(flags({animation:'d',flip:90,short:0.35,bends:'clamp',bendTolerance:5,legScale:[0.8,1.05],plantFeet:true,stance:0.07,raisedByHead:true,carryIdle:true,minScore:0.4})))
  .toEqual(['--animation','d','--min-score','0.4','--flip','90','--short','0.35','--bends','clamp','--bend-tolerance','5','--leg-scale','0.8,1.05','--plant-feet','--stance','0.07','--raised-by-head','--carry-idle']);
 expect(cleanArgv({loop:true,legs:1,rest:9,hold:false,hipsInferred:true},'b')).toEqual(['--loop','--legs','1','--rest','9','--hold','off','--hips-inferred','--person','b']);
 // A skipped clean sends --person to retarget instead.
 expect(retargetArgv(flags({animation:'d',person:'b',clean:null}))).toEqual(['--animation','d','--person','b']);
 expect(cleanArgs({pose:'pose.json',out:'pose.clean.json',argv:['--legs','5']})).toEqual(['clean','--pose','pose.json','--out','pose.clean.json','--legs','5']);
 expect(retargetArgs({rig:'R',map:'map.json',sequence:'s.json',out:'motion.json',argv:['--animation','d']})).toEqual(['retarget','--rig','R','--map','map.json','--sequence','s.json','--out','motion.json','--animation','d']);
});

test('the request is typed data: no path, no flag string, no unknown key, windows and ranges as the producer states them', () => {
 const ok={sequence:'pose-1',map,flags:flags(),configHash:'a'.repeat(64)};
 expect(parseRetargetRequest(ok).flags.animation).toBe('retarget');
 const refuse=(value:unknown)=>{try{parseRetargetRequest(value);return null;}catch(e){return e instanceof RetargetError?e.code:String(e);}};
 expect(refuse({...ok,path:'/etc/passwd'})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,sequence:'../x.json'})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,flags:{...flags(),args:['--out','/tmp/x']}})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,flags:{...flags(),animation:'--out'}})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,flags:{...flags(),clean:{loop:false,legs:3,rest:7,hold:true,hipsInferred:false}}})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,flags:{...flags(),legScale:[1.1,1.2]}})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,map:{...map,spec:'other'}})).toBe('RETARGET_REQUEST_INVALID');
 expect(refuse({...ok,map:{...map,chains:[]}})).toBe('RETARGET_REQUEST_INVALID');
 expect(() => parseRetargetFlags({...flags(),flip:'90'})).toThrow('RETARGET_REQUEST_INVALID');
});

test('listed lines keep the text and name their first frame, timed by the report\'s frameTimes, else the line\'s t=', () => {
 const lines=['  GATE   green','  FLIP   chain "arm_r" bone "a" turned +33.5° from frame 177 to 178 (t=7.375–7.417s), over 30°','  SHORT  chain "arm_l" bone "b" (l_elbow → l_wrist) frames 24–25 (t=1.000–1.042s): picture length down to 0.55','  FEET   not measured','  LAND   bone "chest"'];
 const times=Array.from({length:200},(_,i)=>i/24);
 expect(retargetLines(lines,times)).toEqual([
  {code:'FLIP',line:lines[1]!.trim(),frame:177,time:177/24},
  {code:'SHORT',line:lines[2]!.trim(),frame:24,time:1},
  {code:'FEET',line:'FEET   not measured',frame:null,time:null},
 ]);
 expect(retargetLines(lines,null)[0]).toEqual({code:'FLIP',line:lines[1]!.trim(),frame:177,time:7.375});
});

test('#161 the leg-side lines of a live run (rig-pose examples/walk onto parts examples/wind) parse to what the job listed', async () => {
 // The real retarget output and report frameTimes of one live Apply (--leg-scale 0.9,1.05 --plant-feet --stance 0.07, a reach trunk).
 const live=JSON.parse(await readFile(join(import.meta.dir,'fixtures/retarget-wind-walk.json'),'utf8')) as {op:{args:string[]};frameTimes:number[];lines:string[];readings:unknown[]};
 expect(live.op.args).toEqual(['--animation','walk','--leg-scale','0.9,1.05','--plant-feet','--stance','0.07']);
 const parsed=retargetLines(live.lines,live.frameTimes);
 expect(parsed).toEqual(live.readings as typeof parsed);
 const count=(code:string)=>parsed.filter(r=>r.code===code).length;
 expect([count('FEET'),count('STANCE'),count('LEG-SCALE'),count('REACH'),parsed.length]).toEqual([12,7,4,1,24]);
 // Each line is the producer's text, trimmed; none of the other codes (GATE, LAND, JITTER, SHEAR…) is listed.
 for(const r of parsed)expect(live.lines.map(l=>l.trim())).toContain(r.line);
 // The first seekable line of each leg-side code: its first `frame(s) N`, at the motion's key time for N.
 const first=(code:string,head:string)=>{const r=parsed.find(x=>x.code===code&&x.frame!==null)!;return [r.line.startsWith(head),r.frame,r.time];};
 expect(first('FEET','FEET   blend held on the floor: supporting foot l frames 14–16')).toEqual([true,14,0.583333]);
 expect(first('STANCE','STANCE planted both: free foot l frames 0–3')).toEqual([true,0,0]);
 expect(first('LEG-SCALE','LEG-SCALE chain "leg_r" bone "leg_r0"')).toEqual([true,16,0.666667]);
 expect(first('REACH','REACH  chain "trunk" bone "chest"')).toEqual([true,18,0.75]);
 // `frame(s) under 0.9, clamped (frames 16–20)`: the count's `frame(s)` is not a frame; the clamped span is.
 expect(parsed.filter(r=>r.code==='LEG-SCALE').map(r=>r.frame)).toEqual([16,null,4,null]);
 // A line naming its frames without the word `frame` (`supports: r 0–13`) or none at all lists without a seek.
 expect(parsed.find(r=>r.line.startsWith('FEET   supports:'))).toEqual({code:'FEET',line:'FEET   supports: r 0–13, l 14–23',frame:null,time:null});
 expect(parsed.filter(r=>r.frame!==null).map(r=>`${r.code} F${r.frame}`)).toEqual(['REACH F18','LEG-SCALE F16','LEG-SCALE F4','FEET F14','STANCE F0','STANCE F4','STANCE F9','STANCE F14','STANCE F16','STANCE F21']);
});

test('Apply · Retarget: clean → retarget → compile in scratch; bar 1 byte-equal to a direct run, bar 2 the package untouched; refusals verbatim', async () => {
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg,{handoff:{config:join(pkg,'rig/config.json'),parts:join(pkg,'rig/out')}});
 const server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const before=await tree(pkg),motionBefore=md5(await readFile(join(pkg,'motion.json'))),rigMotionBefore=md5(await readFile(join(pkg,'rig/out/rig/motion.json')));
  const status=await (await fetch(base+'/api/rebuild')).json() as {inputs:{configHash:string};retarget:{available:boolean;reason:string|null;sequences:{id:string;label:string;path:string;cleaned:boolean;frames:number;people:string[]}[];bones:string[];animations:string[];producer:{package:string;version:string}}};
  expect(status.retarget.available).toBe(true);
  expect(status.retarget.producer).toEqual({package:'@rig-c/pose',version:'0.37.0'});
  expect(status.retarget.sequences).toEqual([{id:'pose-1',label:'dance.pose.json',path:'dance.pose.json',cleaned:false,frames:4,people:['a']}]);
  expect(status.retarget.bones).toEqual(['root','hip','chest','arm0','arm1']);
  expect(status.retarget.animations).toEqual(['idle']);
  const configHash=status.inputs.configHash,f=flags({animation:'dance',flip:30});
  const started=await post(base,{retarget:{sequence:'pose-1',map,flags:f,configHash}});expect(started.status).toBe(202);
  const job=await settle(base,await started.json() as {status:string}) as {id:string;status:string;request:{record:RetargetRecord;recordSha256:string};readings:unknown[];motion:{kept:boolean;animations:string[]};files:{documents:{file:string;count:number;paths:string[]}[]};build:{modelHash:string}};
  expect(job.status).toBe('built');
  expect(job.request.record.op).toEqual({cmd:'retarget',args:['--animation','dance','--flip','30'],clean:['--legs','5','--rest','7']});
  expect(assertRetargetRecord(job.request.record,'record')).toBeTruthy();
  expect(job.motion.kept).toBe(true);expect(job.motion.animations).toEqual(['idle','dance']);
  // The per-file diff: motion.json differs at the new animation only; the rest of the rig is the handoff's.
  expect(job.files.documents.map(d=>[d.file,d.count,d.paths])).toEqual([['rig.json',0,[]],['motion.json',1,['/animations/dance']],['sets.json',0,[]],['mesh_report.json',0,[]]]);
  expect(job.readings).toEqual([{code:'FLIP',line:'FLIP   chain "arm_r" bone "arm0" turned +40.0° from frame 1 to 2 (t=0.040–0.080s), over 30° in one frame; spread over frames 1–2 (h=1)',frame:1,time:0.04}]);
  const scratch=join(state,'rebuild',p.sourceHash,job.id);
  // #164: the job carries its report's frameTimes, the new animation's own clock for the transport and the rig pane.
  const ownReport=JSON.parse(await readFile(join(scratch,'motion.report.json'),'utf8')) as {frameTimes:number[]};
  expect(ownReport.frameTimes.length).toBeGreaterThan(1);expect((job as unknown as {frameTimes:unknown}).frameTimes).toEqual(ownReport.frameTimes);
  const served=await fetch(`${base}/rebuild/${job.id}/skeleton.model.json`);expect(served.status).toBe(200);

  // Bar 1: the same producer run directly with the record's flags writes the same motion, byte for byte.
  const direct=join(root,'direct');await mkdir(direct);
  await writeFile(join(direct,'pose.json'),await readFile(join(pkg,'dance.pose.json')));await writeFile(join(direct,'map.json'),JSON.stringify(map,null,1)+'\n');
  const bin=join(root,'node_modules/@rig-c/pose/bin/rig-pose.cjs');
  expect((await runTool(bin,cleanArgs({pose:'pose.json',out:'pose.clean.json',argv:job.request.record.op.clean!}),{cwd:direct})).exitCode).toBe(0);
  expect((await runTool(bin,retargetArgs({rig:join(pkg,'rig/out/rig'),map:'map.json',sequence:'pose.clean.json',out:'motion.json',argv:job.request.record.op.args}),{cwd:direct})).exitCode).toBe(0);
  const directMotion=await readFile(join(direct,'motion.json')),scratchMotion=await readFile(join(scratch,'rig','motion.json'));
  expect(md5(scratchMotion)).toBe(md5(directMotion));
  expect(JSON.stringify(JSON.parse(scratchMotion.toString()).animations.dance)).toBe(JSON.stringify(JSON.parse(directMotion.toString()).animations.dance));

  // Bar 2: the package's motion.json — and every other package file — is what it was.
  expect(md5(await readFile(join(pkg,'motion.json')))).toBe(motionBefore);
  expect(md5(await readFile(join(pkg,'rig/out/rig/motion.json')))).toBe(rigMotionBefore);
  expect(await tree(pkg)).toEqual(before);

  // The applied record a feedback note carries is valid and summarised.
  const applied={schema:APPLIED_RETARGET_SCHEMA,buildId:job.id,retarget:job.request.record,recordSha256:job.request.recordSha256,configHash,producer:{package:'@rig-c/pose',version:'0.37.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'wrote motion.json',motion:job.motion,files:job.files,readings:job.readings,modelHash:job.build.modelHash};
  expect(()=>parseAppliedContext(applied)).not.toThrow();
  expect(appliedSummary(applied)).toContain('retarget "dance" from pose-1');
  expect(()=>parseAppliedContext({...applied,retarget:{...job.request.record,op:{...job.request.record.op,args:['--out','/x']}}})).toThrow('op must be');

  // Refusals come back verbatim and leave no scratch build behind.
  const refused=async(over:Partial<RetargetFlags>,m:unknown=map)=>{const r=await post(base,{retarget:{sequence:'pose-1',map:m,flags:flags(over),configHash}});return settle(base,await r.json() as {status:string}) as Promise<{status:string;producerLine:string;refusals:string[];id:string}>;};
  const notCleaned=await refused({animation:'raw',clean:null});
  expect(notCleaned.status).toBe('refused');expect(notCleaned.producerLine).toBe('FAIL  POSE_NOT_CLEANED: pose.json has no "cleaned" record; run rig-pose clean');
  const nameTaken=await refused({animation:'idle'});
  expect(nameTaken.producerLine).toBe('FAIL  MOTION_NAME_FREE: the rig\'s motion spec already has an animation "idle"');
  const wrongBone=await refused({animation:'x'},{...map,chains:[{...map.chains[0]!,bones:['leg0','arm1']}]});
  expect(wrongBone.producerLine).toBe('FAIL  MAP_RESOLVES: map.json does not resolve against the rig');
  expect(wrongBone.refusals).toEqual(['FAIL  MAP_RESOLVES: map.json does not resolve against the rig','FAIL  MAP_BONE_EXISTS: chain "arm_r" — bone "leg0" is not in the rig']);
  for(const r of [notCleaned,nameTaken,wrongBone])expect(await readdir(join(state,'rebuild',p.sourceHash))).not.toContain(r.id);
  // A malformed request never reaches the producer.
  expect((await post(base,{retarget:{sequence:'pose-1',map,flags:{...flags(),out:'/tmp/x'},configHash}})).status).toBe(400);
  expect((await post(base,{retarget:{sequence:'nope',map,flags:flags(),configHash}})).status).toBe(200);
  expect(await tree(pkg)).toEqual(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
},60000);
