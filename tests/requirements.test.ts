import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {freshSession} from '../src/session.ts';
import {formatFeedbackIssues} from '../src/feedback-export.ts';
import {KIND_FIELDS,parseRequirementsContext,readRequirements,REQUIREMENT_KINDS,REQUIREMENTS_CONTEXT_SCHEMA,requirementEntry,requirementsDocument,requirementsFileText,worstFrame,type Requirement} from '../src/requirements.ts';
import type {RequirementsJob} from '../src/requirements-run.ts';
import {defaultTargetBone,kindUnavailable,requirementName,selfTargetRefusal} from '../web/requirements-panel.ts';

/**
 * #113. A stand-in `rig-parts check --requirements` that reads the file by the producer reader's own rules, written out
 * here independently of review (spec; fps above 0; a name of a letter then letters, digits, underscores, once each; a
 * kind among the six; an animation; exactly that kind's fields and no other), refusing each problem as the reader prints
 * it — `  FAIL  REQUIREMENTS_FIELD: <object> — <detail> (see rig-parts guide REQUIREMENTS_FIELD)` then `refused: N
 * problem(s)`, exit 1 — and otherwise writing check.json's `requirements` block and printing one line per requirement.
 * The real producer bar is reproduced against an installed `@rig-c/parts` (see the issue's PR).
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]!=='check')process.exit(3);
const out=f('--out'),file=path.resolve(f('--requirements'));
const fields={contact:['bone','point','target','within_px'],follow:['constraint','constraint_type','bone','property','fraction','tolerance','least_drive'],aim:['bone','target','within_degrees'],range:['bone','lo_degrees','hi_degrees'],stretch:['slot','attachment','within_ratio'],seam:['part','neighbour','within_px']};
const raw=JSON.parse(fs.readFileSync(file,'utf8')),problems=[];const field=(o,d)=>problems.push('  FAIL  REQUIREMENTS_FIELD: '+o+' — '+d+' (see rig-parts guide REQUIREMENTS_FIELD)');
if(raw.spec!=='spine-parts-requirements/1')field(file+' field "spec"','is '+JSON.stringify(raw.spec));
for(const k of Object.keys(raw))if(!['spec','fps','targets','requirements','not_planted','not_swinging','rises','rests','may_fold'].includes(k))field(file+' field "'+k+'"','is not a field this format reads');
if(!(typeof raw.fps==='number'&&raw.fps>0))field(file+' field "fps"','is '+JSON.stringify(raw.fps));
const seen=new Set();
(raw.requirements||[]).forEach((r,i)=>{const ok=typeof r.name==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(r.name);const label=ok?'requirements['+i+'] "'+r.name+'"':'requirements['+i+']';
 if(!ok)field('requirements['+i+'] field "name"','is '+JSON.stringify(r.name));else if(seen.has(r.name))field('requirements['+i+'] field "name"','is used twice');else seen.add(r.name);
 if(!fields[r.kind]){field(label+' field "kind"','is '+JSON.stringify(r.kind)+'; one of contact, follow, aim, range, stretch, seam is required');return;}
 if(typeof r.animation!=='string'||!r.animation)field(label+' field "animation"','is missing');
 for(const k of Object.keys(r))if(!['name','kind','animation',...fields[r.kind]].includes(k))field(label+' field "'+k+'"','is not a field a '+r.kind+' requirement reads');
 for(const k of fields[r.kind])if(r[k]===undefined)field(label+' field "'+k+'"','is undefined');});
if(problems.length){for(const p of problems)console.log(p);console.log('refused: '+problems.length+' problem(s)');process.exit(1);}
const lines={};
for(const r of raw.requirements){const at='frame 4 (t = 0.333333s)';
 lines[r.name]=r.kind==='stretch'?{kind:r.kind,animation:r.animation,status:'PASS',severity:1.226207,at,within_ratio:r.within_ratio}
 :r.kind==='range'?{kind:r.kind,animation:r.animation,status:'FAIL',least_degrees:-60,least_at:'frame 2 (t = 0.166667s)',greatest_degrees:10,greatest_at:at,range_degrees:[r.lo_degrees,r.hi_degrees]}
 :r.kind==='follow'?{kind:r.kind,animation:r.animation,status:'NOT MEASURABLE',reason:'no frame reaches the least drive',largest_drive_at:at}
 :{kind:r.kind,animation:r.animation,status:'PASS',[r.kind==='aim'?'largest_degrees':'largest_px']:0.25,at};}
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:false,requirements:{fps:raw.fps,summary:{},lines}}));
for(const [n,l] of Object.entries(lines))console.log('  '+n+': '+l.status+' — kind '+l.kind+'; animation '+l.animation);
console.log('  requirements: '+raw.requirements.length+' declared — fake');
for(const [n,l] of Object.entries(lines))if(l.status==='FAIL')console.log('  FAIL  CHECK_REQUIREMENT_MET: requirement "'+n+'" — outside its bar');
console.log('check: FAIL — 0 bar(s) not met, 1 declared requirement(s) not PASS');process.exit(1);`;
const fakeRigc=`console.log('rigc: fake');`;
const rigSpec={bones:[{name:'root'},{name:'hip',parent:'root'},{name:'arm',parent:'hip'}],slots:[{name:'neck',bone:'hip',attachment:'neck'},{name:'sleeve',bone:'arm',attachment:'sleeve'}],
 skins:{default:{neck:{neck:{type:'mesh'}},sleeve:{sleeve:{}}}},constraints:[{type:'ik',name:'reach',bones:['arm']},{type:'physics',name:'p',bone:'hip'}]};
const motion={animations:{idle:{duration:1},act_bow:{duration:0.75}}};

async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-requirements-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify({key:'k'}));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify(rigSpec));await writeFile(join(rig,'mesh_report.json'),'{}');await writeFile(join(rig,'motion.json'),JSON.stringify(motion));
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.44.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state')};
}
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const post=(base:string,body:unknown,origin=base)=>fetch(base+'/api/requirements',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,job:RequirementsJob):Promise<RequirementsJob>{let current=job;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/requirements/${current.id}`)).json() as RequirementsJob;}return current;}

/** One requirement of each kind, as the panel builds them (`requirementEntry` of the typed requirement). */
const every:Requirement[]=[
 {name:'HAND_ON_CUP',kind:'contact',animation:'act_bow',bone:'arm',point:'tip',target:{bone:'hip',point:'origin'},within_px:0.5},
 {name:'ARM_IK',kind:'follow',animation:'act_bow',constraint:'reach',constraint_type:'ik',bone:'arm',property:'rotate',fraction:0.5,tolerance:0.05,least_drive:2},
 {name:'ARM_AIM',kind:'aim',animation:'act_bow',bone:'arm',target:{bone:'hip',point:'origin'},within_degrees:3},
 {name:'ARM_RANGE',kind:'range',animation:'act_bow',bone:'arm',lo_degrees:-45,hi_degrees:45},
 {name:'NECK_BOW',kind:'stretch',animation:'act_bow',slot:'neck',attachment:'neck',within_ratio:1.3},
 {name:'NECK_SLEEVE',kind:'seam',animation:'act_bow',part:'neck',neighbour:'sleeve',within_px:1},
];

test('#113: each kind writes exactly the fields the producer reader lists, and the file is spec, fps and requirements only',()=>{
 for(const r of every){const entry=requirementEntry(r);expect(Object.keys(entry)).toEqual(['name','kind','animation',...KIND_FIELDS[r.kind]]);}
 expect(every.map(r=>r.kind)).toEqual([...REQUIREMENT_KINDS]);
 const doc=JSON.parse(requirementsFileText(requirementsDocument(12,every.map(requirementEntry))));
 expect(Object.keys(doc)).toEqual(['spec','fps','requirements']);expect(doc.spec).toBe('spine-parts-requirements/1');expect('may_fold' in doc).toBe(false);
 expect(requirementName('stretch','neck',['STRETCH_NECK'])).toBe('STRETCH_NECK_2');expect(requirementName('seam','9a',[])).toBe('SEAM_9A');
 expect(worstFrame('frame 4 (t = 0.333333s)')).toEqual({frame:4,time:0.333333,text:'frame 4 (t = 0.333333s)'});
 expect(kindUnavailable('follow',{bones:['a'],slots:['s'],meshes:{},constraints:[]})).toBe('the rig spec declares no ik or transform constraint');
 expect(kindUnavailable('stretch',{bones:['a'],slots:['s'],meshes:{s:[]},constraints:[]})).toBe('no slot of the rig spec holds a mesh attachment');
});

test('#113 bar 1: the file review writes reads without a REQUIREMENTS_* refusal; a misspelt kind is refused by name (REQUIREMENTS_FIELD), verbatim',async()=>{
 const {root,pkg,state}=await fixture();
 const before=await treeMd5(pkg),p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const catalog=await (await fetch(base+'/api/requirements')).json();
  expect(catalog).toMatchObject({status:'ready',bones:['root','hip','arm'],slots:['neck','sleeve'],meshes:{neck:['neck']},slotBones:{neck:'hip',sleeve:'arm'},constraints:[{name:'reach',type:'ik',bones:['arm'],drives:['rotate']}],animations:[{name:'idle',duration:1},{name:'act_bow',duration:0.75}],scratch:null});
  const requirements=every.map(requirementEntry);
  const started=await post(base,{fps:12,build:'inspected',requirements});expect(started.status).toBe(202);
  const job=await settle(base,await started.json() as RequirementsJob);
  expect(job.status).toBe('checked');
  expect(job.refusals).toEqual([]);expect(job.lines.some(l=>/REQUIREMENTS_[A-Z]/.test(l))).toBe(false);
  // The bytes the producer read are the ones the page computes for the feedback context.
  const text=requirementsFileText(requirementsDocument(12,requirements));
  expect(job.file).toEqual({sha256:sha(text),size:Buffer.byteLength(text),text});
  // One row per requirement, its measured figure and its worst frame for the seek.
  expect(job.rows.map(r=>[r.name,r.status,r.worst?.frame??null])).toEqual([['HAND_ON_CUP','PASS',4],['ARM_IK','NOT MEASURABLE',4],['ARM_AIM','PASS',4],['ARM_RANGE','FAIL',2],['NECK_BOW','PASS',4],['NECK_SLEEVE','PASS',4]]);
  expect(job.rows.find(r=>r.name==='NECK_BOW')).toMatchObject({measured:1.226207,worst:{frame:4,time:0.333333},line:'NECK_BOW: PASS — kind stretch; animation act_bow'});
  expect(job.rows.find(r=>r.name==='ARM_RANGE')).toMatchObject({least:-60,greatest:10});
  expect(job.problems).toEqual(['FAIL  CHECK_REQUIREMENT_MET: requirement "ARM_RANGE" — outside its bar']);
  expect(job.summary).toBe('requirements: 6 declared — fake');
  // Mutant: a misspelt kind reaches the producer's reader and comes back refused by name.
  const mutant=requirements.map(r=>r.name==='NECK_BOW'?{...r,kind:'strech'}:r);
  const refused=await settle(base,await (await post(base,{fps:12,build:'inspected',requirements:mutant})).json() as RequirementsJob);
  const line='FAIL  REQUIREMENTS_FIELD: requirements[4] "NECK_BOW" field "kind" — is "strech"; one of contact, follow, aim, range, stretch, seam is required (see rig-parts guide REQUIREMENTS_FIELD)';
  expect(refused.status).toBe('refused');expect(refused.refusals).toEqual([line]);expect(refused.error).toBe(line);expect(refused.rows).toEqual([]);
  // Nothing was written into the package; each run's scratch directory is gone.
  expect(await treeMd5(pkg)).toBe(before);
  expect(await readdir(join(state,'requirements',p.sourceHash))).toEqual([]);
  // No scratch build yet: refused by name, before anything runs.
  expect(await (await post(base,{fps:12,build:'scratch',requirements})).json()).toEqual({status:'refused',error:'REQUIREMENTS_NO_SCRATCH: no scratch build in this session yet; Apply builds one, or check the inspected rig'});
  // The envelope: no path, no flag, no waiver; same origin only.
  expect((await post(base,{fps:12,build:'inspected',requirements,out:'/tmp'})).status).toBe(400);
  expect((await post(base,{fps:12,build:'inspected',requirements:[{...requirements[0],may_fold:'x'}]})).status).toBe(400);
  expect((await post(base,{fps:12,build:'inspected',requirements:[{...requirements[0],bone:{path:'/etc'}}]})).status).toBe(400);
  expect((await post(base,{fps:12,build:'inspected',requirements},'http://evil.example')).status).toBe(403);
  expect((await fetch(base+'/api/requirements',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'x'.repeat(70*1024)})).status).toBe(400);
  expect(frontRoute('single','POST','/api/requirements')).toMatchObject({mutation:true,limit:64*1024});
  expect(frontRoute('single','GET','/api/requirements/'+'a'.repeat(64))).toMatchObject({mutation:false});
  expect(frontRoute('compare','POST','/api/requirements')).toBeNull();
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#113 bar 2: submitted feedback carries the requirements file\'s sha256 and bytes; a hash that is not the text\'s is refused',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const text=requirementsFileText(requirementsDocument(12,every.slice(4,5).map(requirementEntry)));
  const requirements={schema:REQUIREMENTS_CONTEXT_SCHEMA,sha256:sha(text),size:Buffer.byteLength(text),text,
   checked:{build:'inspected',producer:{package:'@rig-c/parts',version:'1.44.0'},summary:'requirements: 1 declared — 1 measured (1 PASS, 0 FAIL), 0 NOT MEASURABLE; not declared: contact, follow, aim, range, seam',refusals:[],rows:[{name:'NECK_BOW',status:'PASS',worst:{frame:4,time:0.333333,text:'frame 4 (t = 0.333333s)'}}]}};
  const note={id:'n1',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.feedbackCatalog.rig},category:'quality',summary:'neck stretch bar',context:{animation:null,requirements}};
  const put=(feedback:unknown[])=>fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...freshSession(p),feedback})});
  const saved=await put([note]);expect(saved.status).toBe(200);
  const read=await (await fetch(base+'/api/session')).json();
  const carried=read.feedback[0].context.requirements;
  expect(carried.sha256).toBe(sha(text));expect(carried.text).toBe(text);expect(carried.size).toBe(Buffer.byteLength(text));
  expect(sha(carried.text)).toBe(carried.sha256);
  expect(formatFeedbackIssues(read)).toContain(`- Requirements: 1 declared · requirements file sha256 ${sha(text)}`);
  // Mutants: a hash of other bytes, a waiver smuggled into the text.
  const wrong=await put([{...note,context:{animation:null,requirements:{...requirements,sha256:sha(text+' ')}}}]);
  expect(wrong.status).toBe(400);expect((await wrong.json()).error).toBe('feedback.context.requirements: sha256 is not the sha256 of text');
  const waived=text.replace('"requirements"','"may_fold": [],\n "requirements"');
  expect(()=>parseRequirementsContext({...requirements,text:waived,sha256:sha(waived),size:Buffer.byteLength(waived)},sha)).toThrow('spec, fps and requirements');
  // Absent or null stays valid.
  expect((await put([{...note,context:{animation:null,requirements:null}}])).status).toBe(200);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('#113: the printed lines are read when check.json carries no requirements block',()=>{
 const read=readRequirements(['A'],null,['  A: FAIL — kind contact; animation idle; largest_px 2; at frame 3 (t = 0.25s); within_px 1','  requirements: 1 declared — 1 measured (0 PASS, 1 FAIL), 0 NOT MEASURABLE; not declared: follow','check: FAIL — 0 bar(s) not met, 1 declared requirement(s) not PASS']);
 expect(read.rows).toEqual([{name:'A',kind:'contact',animation:'idle',status:'FAIL',measured:null,least:null,greatest:null,worst:{frame:3,time:0.25,text:'frame 3 (t = 0.25s)'},reason:null,line:'A: FAIL — kind contact; animation idle; largest_px 2; at frame 3 (t = 0.25s); within_px 1'}]);
 expect(read.summary).toStartWith('requirements: 1 declared');expect(read.checkLine).toStartWith('check: FAIL');expect(read.refusal).toBeNull();
});

test('#142 bar 1: a contact against its own bone and point, or an aim at its own bone, is refused by name before Add', () => {
 const contact = selfTargetRefusal({kind:'contact',bone:'root',point:'origin',target:{bone:'root',point:'origin'}});
 expect(contact).toStartWith('REQUIREMENTS_SELF_TARGET: contact of bone "root" origin against itself');
 expect(selfTargetRefusal({kind:'aim',bone:'arm',target:{bone:'arm',point:'tip'}})).toStartWith('REQUIREMENTS_SELF_TARGET: aim of bone "arm" at its own tip');
 expect(selfTargetRefusal({kind:'aim',bone:'arm',target:{bone:'arm',point:'origin'}})).toStartWith('REQUIREMENTS_SELF_TARGET:');
 // Not vacuous: a bone's tip against its own origin measures the bone's length; two different bones are read as before.
 expect(selfTargetRefusal({kind:'contact',bone:'arm',point:'tip',target:{bone:'arm',point:'origin'}})).toBeNull();
 expect(selfTargetRefusal({kind:'contact',bone:'arm',point:'origin',target:{bone:'hand',point:'origin'}})).toBeNull();
 expect(selfTargetRefusal({kind:'aim',bone:'arm',target:{bone:'hand',point:'origin'}})).toBeNull();
});

test('#142 bar 2: the form proposes a target bone other than the subject', () => {
 const bones = ['root','hip','chest','neck'];
 for (const subject of bones) { const t = defaultTargetBone(bones, subject); expect(t).not.toBeNull(); expect(t).not.toBe(subject); }
 expect(defaultTargetBone(bones,'root')).toBe('hip');
 expect(defaultTargetBone(bones,'neck')).toBe('root');
 expect(defaultTargetBone(['only'],'only')).toBeNull();
});
