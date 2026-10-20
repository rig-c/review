import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {READINGS_COMPILER_NOT_INSTALLED} from '../src/producer.ts';
import {ticksOnClip,environmentSchedule,parseReadingsContext,parseReadingsRequest,readingRefusal,readingResult,readingTicks,renderArgs,worstLine,READINGS_SCHEMA,ReadingsError,type ReadingRequest} from '../src/readings.ts';
import {readoutRows,beforeLine,type InspectedCheckView} from '../src/physics-tuning.ts';
import {checkSummary} from '../src/applied-context.ts';
import {validatePackageFeedback} from '../src/session.ts';

// ---- Shapes as rig-c 2.64.1 writes them (trimmed from a real render of a 41-frame idle at 12 fps) ----
const seamJson={spec:'rigc-seam/1',animation:'idle',fps:12,pairs:[{a:'topwear',b:'bottomwear',drawn:41,banded:41,status:'read',opens:[0,1,2,7,8,9,10,24],maxPx:678,
 gap:{frames:[{index:0,time:0,px:266}],spans:[],worst:{index:10,time:10/12,px:678,cell:1,area:677.99,box:[0,0,1,1]}},ghost:{frames:[],spans:[],worst:{index:8,time:8/12,px:17,cell:1,area:17,box:[0,0,1,1]}}}]};
const seamLine='  ..    seam     "idle": seam "topwear" | "bottomwear" opens on 8 of 41 frame(s) read [0-2, 7-10, 24] at 12 fps, max 678 px — gap on 8 frame(s), worst frame 10 (t=0.8333s): 678 px';
const passJson={spec:'rigc-pass-through/1',animation:'act_bow',fps:12,pairs:[{cloth:'ribbon_r',leg:'bottomwear',drawn:9,over:9,frames:[0,1,2,3,5].map(index=>({index,time:index/12,cells:125-index,depth:125-index,cell:1,side:'right',rows:474,box:[0,0,1,1]})),deepest:{index:0,time:0,cells:125,depth:125.00001,cell:1,side:'right'}}]};
const foldsJson={spec:'rigc-folds/1',animation:'idle',fps:12,meshes:[{slot:'hair_back',attachment:'hair_back',triangleCount:58,area:1,setup:{degenerate:[],inverted:[]},frames:[],worst:null,folded:[]},
 {slot:'skirt',attachment:'skirt',triangleCount:358,area:1,setup:{degenerate:[],inverted:[]},frames:[{index:3,time:.25,triangles:[4],box:[0,0,1,1],area:1,share:.1},{index:4,time:1/3,triangles:[4,5,9],box:[0,0,1,1],area:1,share:.1}],worst:{index:4,time:1/3,triangles:[4,5,9],box:[0,0,1,1],area:1,share:.1},folded:[4,5,9]},
 {slot:'sleeve',attachment:'sleeve',triangleCount:40,area:1,setup:{degenerate:[],inverted:[]},frames:[{index:11,time:11/12,triangles:[1],box:[0,0,1,1],area:1,share:.1}],worst:{index:11,time:11/12,triangles:[1],box:[0,0,1,1],area:1,share:.1},folded:[1]}]};
const overlapsJson={spec:'rigc-overlaps/1',animation:'idle',fps:12,frames:[],pairs:[{under:'bottomwear',over:'ribbon_l',frames:41,of:41,runs:[[0,40]],most:{index:4,px:282},inside:true,varies:false},
 {under:'brow_l',over:'hair_front',frames:6,of:41,runs:[[0,1],[3,5],[18,18]],most:{index:0,px:2},inside:false,varies:true},{under:'ear_l',over:'face',frames:2,of:41,runs:[[38,39]],most:{index:38,px:9},inside:false,varies:true}]};
const angleLine='  ..    angle    "idle": bone "head" against "chest" ranges -1.2388° to 1.2308° (a span of 2.4696°) over 41 frame(s) at 12 fps; lowest at frame 34 (t=2.8333s), highest at frame 14 (t=1.1667s)';
const run=(lines:string[],exitCode=0)=>({exitCode,lines,wallMs:5});
const frameSet=(xs:readonly number[])=>new Set(xs);

test('bar 1: the ticks are exactly the frames each reading\'s JSON lists (set equality), on both builds, at frame / fps',()=>{
 const seam:ReadingRequest={kind:'seam',a:'topwear',b:'bottomwear'},pass:ReadingRequest={kind:'pass-through',cloth:'ribbon_r',leg:'bottomwear'},folds:ReadingRequest={kind:'folds'},overlaps:ReadingRequest={kind:'overlaps'};
 const inspected=[readingResult(seam,run([seamLine]),seamJson,12),readingResult(pass,run([]),passJson,12),readingResult(folds,run([]),foldsJson,12),readingResult(overlaps,run([]),overlapsJson,12)];
 const scratchSeam={...seamJson,pairs:[{...seamJson.pairs[0]!,opens:[3,4,30]}]},scratch=[readingResult(seam,run([seamLine]),scratchSeam,12)];
 const ticks=readingTicks([{build:'inspected',results:inspected},{build:'scratch',results:scratch}]);
 const of=(build:string,label:string)=>ticks.filter(t=>t.build===build&&t.label===label);
 expect(frameSet(of('inspected','seam topwear:bottomwear').map(t=>t.frame))).toEqual(frameSet(seamJson.pairs[0]!.opens));
 expect(frameSet(of('scratch','seam topwear:bottomwear').map(t=>t.frame))).toEqual(frameSet([3,4,30]));
 expect(frameSet(of('inspected','pass-through ribbon_r:bottomwear').map(t=>t.frame))).toEqual(frameSet(passJson.pairs[0]!.frames.map(f=>f.index)));
 expect(frameSet(of('inspected','folds').map(t=>t.frame))).toEqual(frameSet(foldsJson.meshes.flatMap(m=>m.frames.map(f=>f.index))));
 // Overlaps: the frames of every pair whose layering moves (the static ones cover every frame by the same pixels).
 expect(frameSet(of('inspected','overlaps').map(t=>t.frame))).toEqual(frameSet([0,1,3,4,5,18,38,39]));
 expect(of('inspected','seam topwear:bottomwear').length).toBe(seamJson.pairs[0]!.opens.length);
 for(const t of ticks)expect(t.time).toBeCloseTo(t.frame/12,12);
 // The scrub draws every one of them on the reading's own clip, the last sample (40/12 s) included even where the runtime's
 // duration rounds a hair below it; on another animation it draws none.
 const last=readingTicks([{build:'inspected',results:[readingResult(seam,run([seamLine]),{...seamJson,pairs:[{...seamJson.pairs[0]!,opens:[0,20,40]}]},12)]}]);
 expect(frameSet(ticksOnClip(last,'idle','idle',Math.fround(40/12)-1e-6).map(t=>t.frame))).toEqual(frameSet([0,20,40]));
 expect(ticksOnClip(last,'idle','act_bow',0.7)).toEqual([]);
 // Each JSON frame carries rigc's own time; the tick's time agrees with it.
 for(const f of passJson.pairs[0]!.frames)expect(of('inspected','pass-through ribbon_r:bottomwear').find(t=>t.frame===f.index)!.time).toBeCloseTo(f.time,12);
 // Worst frames: the JSON's worst entries, and the reading's own printed line.
 expect(inspected[0]!.worst).toEqual({frame:10,figure:'gap 678 px (677.99 units²)',line:seamLine.replace(/^\s*\.\.\s+seam\s+/,'')});
 expect(worstLine('inspected',inspected[0]!)).toBe(`inspected · seam topwear:bottomwear: worst at frame 10 — gap 678 px (677.99 units²) · ${seamLine.replace(/^\s*\.\.\s+seam\s+/,'')}`);
 expect(inspected[1]!.worst?.frame).toBe(0);expect(inspected[2]!.worst).toMatchObject({frame:4,figure:'3 of 358 triangle(s) folded (mesh skirt)'});expect(inspected[3]!.worst?.frame).toBe(38);
 expect(inspected[2]!.items.map(i=>i.pair)).toEqual(['skirt','sleeve']);
 // A pair that never opens: no tick and the line says so.
 const none=readingResult(seam,run([seamLine]),{...seamJson,pairs:[{...seamJson.pairs[0]!,opens:[]}]},12);expect(none.frames).toEqual([]);expect(worstLine('scratch',none)).toStartWith('scratch · seam topwear:bottomwear: no frame');
});

test('angle-range writes no JSON: its ticks are the two frames its printed line names (lowest, highest), and that is said',()=>{
 const r=readingResult({kind:'angle-range',bone:'head',relative:'chest'},run([angleLine]),null,12);
 expect(r).toMatchObject({status:'read',source:'line',frames:[14,34]});
 expect(r.worst).toEqual({frame:34,figure:'span 2.4696° (-1.2388° at F34, 1.2308° at F14)',line:angleLine.replace(/^\s*\.\.\s+angle\s+/,'')});
});

test('bar 2: an unknown slot or bone is refused with rigc\'s own line, verbatim; no tick',()=>{
 const line='rigc: --seam: entry 0 names slot "nope", which this skeleton does not have; its slots are [hair_back, topwear, bottomwear]';
 const lines=['rigc render','  ..    skeleton /x/skeleton.json',line,'','rigc — the rig compiler','usage:','  rigc build --rig <path> …'];
 const r=readingResult({kind:'seam',a:'topwear',b:'nope'},run(lines,2),null,null);
 expect(r).toMatchObject({status:'refused',refusal:line,frames:[],exitCode:2});
 expect(worstLine('inspected',r)).toBe(`inspected · seam topwear:nope: ${line}`);
 const bone='rigc: --angle-range: entry 0 names relative-to bone "nobone", which this skeleton does not have; its bones are [root, hip]';
 expect(readingRefusal(['rigc render',bone],2)).toBe(bone);expect(readingRefusal(['rigc: wrote /x/frames.json','  FAIL  X_Y: z'],1)).toBe('FAIL  X_Y: z');expect(readingRefusal(['nothing'],3)).toBe('rigc render exited 3 without a named refusal');
 expect(readingTicks([{build:'inspected',results:[r]}])).toEqual([]);
});

test('requests are typed names only; argv is rigc render\'s documented flags with server paths',()=>{
 expect(parseReadingsRequest({animation:'idle',readings:[{kind:'folds'},{kind:'seam',a:'topwear',b:'bottomwear'},{kind:'angle-range',bone:'head',relative:'chest'}],environment:null}).readings).toHaveLength(3);
 for(const bad of [{animation:'idle',readings:[],environment:null},{animation:'idle',readings:[{kind:'seam',a:'a:b',b:'c'}],environment:null},{animation:'idle',readings:[{kind:'seam',a:'-x',b:'c'}],environment:null},{animation:'idle',readings:[{kind:'folds'},{kind:'folds'}],environment:null},{animation:'idle',readings:[{kind:'folds',out:'/tmp'}],environment:null},{animation:'idle',readings:[{kind:'folds'}],environment:null,out:'/tmp'},{animation:'idle',readings:[{kind:'shell'}],environment:null},{animation:'idle',readings:[{kind:'folds'}],environment:{wind:[1],gravity:[0,1]}}])
  expect(()=>parseReadingsRequest(bad)).toThrow(ReadingsError);
 expect(renderArgs({kind:'pass-through',cloth:'skirt',leg:'leg_l'},'idle',{candidate:'/b',out:'render',environment:null})).toEqual(['render','--candidate','/b','--animation','idle','--pass-through','skirt:leg_l','--out','render']);
 expect(renderArgs({kind:'overlaps'},'idle',{candidate:'/b',out:'render',environment:'environment.json'})).toEqual(['render','--candidate','/b','--animation','idle','--environment','environment.json','--overlaps','--out','render']);
 expect(environmentSchedule({wind:[40,0],gravity:[0,1]})).toEqual({spec:'rigc-environment/1',steps:[{t:0,wind:[40,0],gravity:[0,1]}]});
 const context={schema:READINGS_SCHEMA,animation:'idle',requests:[{kind:'seam',a:'a',b:'b'}],environment:null,environmentPassed:false,builds:{inspected:'f'.repeat(64),scratch:null},compiler:{package:'rig-c',version:'2.64.1'},ticks:{inspected:3,scratch:null}};
 expect(parseReadingsContext(context)).toEqual(context as never);expect(()=>parseReadingsContext({...context,ticks:{inspected:-1,scratch:null}})).toThrow();expect(parseReadingsContext(null)).toBeNull();
});

test('HQ: the physics readout\'s BEFORE for the inspected build is its stored check, "check running…" while it runs, its refusal verbatim',()=>{
 const inspectedLines=['  TEXTURE_STRETCH: PASS — severity 1.054','  ANIMATIONS_DO_NOT_FOLD: PASS — 12 animation(s)','check: PASS; 11 of 13 bar(s) measured'];
 const inspected:InspectedCheckView={status:'checked',lines:inspectedLines,check:checkSummary({PASS:true,TEXTURE_STRETCH:{status:'PASS'}},0,inspectedLines,null),line:'check: PASS; 11 of 13 bar(s) measured'};
 const afterLines=['  TEXTURE_STRETCH: PASS — severity 1.044','  ANIMATIONS_DO_NOT_FOLD: PASS — 12 animation(s) after','check: PASS'],after={lines:afterLines,check:checkSummary({PASS:true},0,afterLines,null)};
 expect(readoutRows(null,inspected,after)).toEqual([
  {name:'ANIMATIONS_DO_NOT_FOLD',before:'ANIMATIONS_DO_NOT_FOLD: PASS — 12 animation(s)',after:'ANIMATIONS_DO_NOT_FOLD: PASS — 12 animation(s) after'},
  {name:'TEXTURE_STRETCH',before:'TEXTURE_STRETCH: PASS — severity 1.054',after:'TEXTURE_STRETCH: PASS — severity 1.044'}]);
 expect(beforeLine('TEXTURE_STRETCH',null,{...inspected,status:'running',lines:[],check:null,line:''})).toBe('TEXTURE_STRETCH: check running… (rig-parts check of the inspected build, in the background)');
 expect(beforeLine('TEXTURE_STRETCH',null,{status:'refused',lines:[],check:null,line:'FAIL  CHECK_INPUT: x'})).toBe('FAIL  CHECK_INPUT: x');
 expect(beforeLine('TEXTURE_STRETCH',null,null)).toBe('TEXTURE_STRETCH: not in check summary (the inspected build; review ran no check on it)');
 // A scratch build on the stage at Apply: its own check lines, not the inspected one's.
 expect(readoutRows({lines:['  TEXTURE_STRETCH: FAIL — 3.2'],check:null},inspected,after)[1]!.before).toBe('TEXTURE_STRETCH: FAIL — 3.2');
});

// ---- Stand-ins for the installed tools ----
const config={key:'k',meshes:{topwear:{contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,bridges:true,regions:[{name:'bust',shape:'circle',cx:414,cy:342,r:50,bone:'chest',spacing:13,band:30}]}}}};
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'parts '+a.join(' ')+'\\n');
if(a[0]==='rig'){const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});for(const n of fs.readdirSync(src))fs.copyFileSync(path.join(src,n),path.join(out,n));process.exit(0);}
if(a[0]==='check'){if(process.env.FAKE_CHECK_REFUSE){console.log('  FAIL  CHECK_PARTS_MISSING: parts.json — not a parts directory');process.exit(1);}const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:true,TEXTURE_STRETCH:{status:'PASS'},ANIMATIONS_DO_NOT_FOLD:{status:'PASS'}}));console.log('  TEXTURE_STRETCH: PASS — inspected 1.054');console.log('  ANIMATIONS_DO_NOT_FOLD: PASS — inspected');console.log('check: PASS; 2 of 2 bar(s) measured');process.exit(0);}
if(a[0]==='remesh'){const out=f('--out');fs.mkdirSync(out);fs.writeFileSync(path.join(out,'rig.json'),fs.readFileSync(f('--mesh')));fs.writeFileSync(path.join(out,'motion.json'),'{}');fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({request:{page_edges:'free',pack_shape:'polygon'}}));console.log('rig-parts remesh: wrote');process.exit(0);}
process.exit(3);`;
/** rigc: build writes a model, its page and skeleton.json; render writes frames.json and the reading's JSON (or refuses an unknown slot by name, as rigc does); --help lists --environment only when FAKE_ENV_FLAG is set. */
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'rigc '+a.join(' ')+' @'+process.cwd()+'\\n');
if(a[0]==='render'&&a[1]==='--help'){console.log('usage:');if(process.env.FAKE_ENV_FLAG)console.log('  --environment <schedule.json>                  the world the rig\\'s physics answers');console.log('  --out <dir>');process.exit(0);}
if(a[0]==='build'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}]}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');fs.writeFileSync(path.join(out,'skeleton.json'),'{"scratch":true}');process.exit(0);}
if(a[0]==='render'){const slots=['topwear','bottomwear','shoes'],cand=f('--candidate'),scratch=JSON.parse(fs.readFileSync(path.join(cand,'skeleton.json'),'utf8')).scratch===true;
 console.log('rigc render');
 if(a.includes('--seam')){const [x,y]=f('--seam').split(':');for(const s of [x,y])if(!slots.includes(s)){console.log('rigc: --seam: entry 0 names slot '+JSON.stringify(s)+', which this skeleton does not have; its slots are ['+slots.join(', ')+']');console.log('');console.log('rigc — the rig compiler');process.exit(2);}}
 const anim=f('--animation'),out=f('--out');fs.mkdirSync(path.join(out,anim),{recursive:true});fs.writeFileSync(path.join(out,anim,'f0000.png'),'png');
 fs.writeFileSync(path.join(out,'frames.json'),JSON.stringify({spec:'rigc-frames/1',sets:[{dir:anim,animation:anim,fps:12}]}));
 if(a.includes('--seam')){const [x,y]=f('--seam').split(':'),opens=scratch?[5,6]:[1,2,9];fs.writeFileSync(path.join(out,anim,'seam.json'),JSON.stringify({pairs:[{a:x,b:y,status:'read',opens,gap:{worst:{index:opens[0],px:40,area:40}},ghost:{worst:null}}]}));console.log('  ..    seam     '+JSON.stringify(anim)+': seam '+JSON.stringify(x)+' | '+JSON.stringify(y)+' opens on '+opens.length+' frame(s)');}
 if(a.includes('--folds')){fs.writeFileSync(path.join(out,anim,'folds.json'),JSON.stringify({meshes:[{slot:'topwear',attachment:'topwear',triangleCount:9,frames:[{index:4}],worst:{index:4,triangles:[1]},folded:[1]}]}));console.log('  ..    folds    '+JSON.stringify(anim)+': mesh "topwear" (slot "topwear") folds on 1 frame(s)');}
 console.log('rigc: wrote '+path.join(out,'frames.json'));process.exit(0);}
process.exit(3);`;
async function install(root:string,rigcVersion='2.64.1'){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:rigcVersion,bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'review-readings-')),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'build'),{recursive:true});
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'readings',title:'readings',revision:'one',model:'build/skeleton.model.json'}));
 await writeFile(join(pkg,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[{name:'root'},{name:'chest'}],slots:[{name:'topwear'},{name:'bottomwear'}],animations:[{name:'idle',duration:2}]}));
 await writeFile(join(pkg,'build/skeleton.json'),'{"scratch":false}');
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
async function treeHash(dir:string):Promise<string>{
 const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};
 await walk(dir);return hash.digest('hex');
}
const post=(base:string,path:string,body:unknown,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settleReadings(base:string,job:{id:string;status:string}):Promise<any>{for(let i=0;i<200&&job.status==='running';i++){await Bun.sleep(25);job=await (await fetch(`${base}/api/readings/${job.id}`)).json();}return job;}
async function settleRebuild(base:string,job:{id:string;status:string}):Promise<any>{for(let i=0;i<200&&job.status==='running';i++){await Bun.sleep(25);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json();}return job;}

test('bar 3 + scratch: readings run on the inspected build and the latest scratch build into <state>/readings/, reuse, and leave the package unchanged',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root);process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const request={animation:'idle',readings:[{kind:'folds'},{kind:'seam',a:'topwear',b:'bottomwear'}],environment:{wind:[40,0],gravity:[0,1]}};
  const first=await settleReadings(base,await (await post(base,'/api/readings',request)).json());
  // Bar 3 first: the package's tree is the bytes it was before the readings ran.
  const afterFirst=await treeHash(pkg);console.log(`bar 3 package tree md5 before ${before} after first run ${afterFirst}`);expect(afterFirst).toBe(before);
  expect(first).toMatchObject({status:'done',environment:{requested:true,flag:false,passed:false},compiler:{package:'rig-c',version:'2.64.1'}});
  expect(first.runs.map((r:any)=>r.build)).toEqual(['inspected']);
  expect(first.runs[0].results.map((r:any)=>[r.label,r.status,r.frames])).toEqual([['folds','read',[4]],['seam topwear:bottomwear','read',[1,2,9]]]);
  // No --environment in this rigc's help: the schedule is not passed.
  expect((await readFile(log,'utf8')).split('\n').filter(l=>l.startsWith('rigc render --candidate')).every(l=>!l.includes('--environment'))).toBe(true);
  // A scratch build (one Apply), then the same readings: both builds, scratch frames from the scratch JSON.
  const status=await (await fetch(base+'/api/rebuild')).json();
  const applied=await settleRebuild(base,await (await post(base,'/api/rebuild',{part:'topwear',regions:[{name:'bust',shape:'circle',cx:420,cy:342,r:50,bone:'chest',spacing:13,band:30}],configHash:status.inputs.configHash})).json());expect(applied.status).toBe('built');
  const second=await settleReadings(base,await (await post(base,'/api/readings',request)).json());
  expect(second.runs.map((r:any)=>[r.build,r.id])).toEqual([['inspected',first.runs[0].id],['scratch',applied.id]]);
  expect(second.runs[1].results[1].frames).toEqual([5,6]);expect(second.runs[1].modelHash).toBe(applied.build.modelHash);
  // The inspected readings were reused (same build, reading and compiler): only the scratch ones ran again.
  const renders=(await readFile(log,'utf8')).split('\n').filter(l=>l.startsWith('rigc render --candidate'));expect(renders).toHaveLength(4);
  expect(renders.slice(2).every(l=>l.includes(join(state,'rebuild')))).toBe(true);
  // Every render ran in scratch under <state>/readings/<package>/<build>/<key>/, kept its JSON and dropped its frames.
  const real=await realpath(state);for(const l of renders)expect(l.split(' @')[1]!.startsWith(join(real,'readings',p.sourceHash)+'/')).toBe(true);
  const dirs=await readdir(join(state,'readings',p.sourceHash));expect(dirs.sort()).toEqual([`inspected-${first.runs[0].modelHash}`,`scratch-${applied.id}`].sort());
  const one=join(state,'readings',p.sourceHash,dirs.find(d=>d.startsWith('inspected'))!);const keys=await readdir(one);expect(keys).toHaveLength(2);
  for(const k of keys){const files=(await readdir(join(one,k))).sort();expect(files).not.toContain('render');expect(files).toContain('result.json');}
  // Bar 3: nothing written outside scratch.
  const after=await treeHash(pkg);console.log(`bar 3 package tree md5 before ${before} after ${after}`);expect(after).toBe(before);
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 2 live path: an unknown slot comes back as rigc\'s line verbatim; --environment passed when the flag exists',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root);process.env.FAKE_LOG=log;process.env.FAKE_ENV_FLAG='1';
 const p=await loadReview(pkg),before=await treeHash(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const job=await settleReadings(base,await (await post(base,'/api/readings',{animation:'idle',readings:[{kind:'seam',a:'topwear',b:'nope'}],environment:{wind:[40,0],gravity:[0,1]}})).json());
  const result=job.runs[0].results[0];
  expect(result).toMatchObject({status:'refused',exitCode:2,frames:[],refusal:'rigc: --seam: entry 0 names slot "nope", which this skeleton does not have; its slots are [topwear, bottomwear, shoes]'});
  expect(job.environment).toEqual({requested:true,flag:true,passed:true});
  const call=(await readFile(log,'utf8')).split('\n').find(l=>l.startsWith('rigc render --candidate'))!;expect(call).toContain('--environment environment.json');
  const dir=call.split(' @')[1]!;expect(JSON.parse(await readFile(join(dir,'environment.json'),'utf8'))).toEqual({spec:'rigc-environment/1',steps:[{t:0,wind:[40,0],gravity:[0,1]}]});
  expect(await treeHash(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;delete process.env.FAKE_ENV_FLAG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('the route is same-origin, typed and bounded; no compiler or one too old is refused by name; the front passes it for a single review',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 const body={animation:'idle',readings:[{kind:'folds'}],environment:null};
 try{
  expect(await (await post(base,'/api/readings',body)).json()).toEqual({status:'refused',error:READINGS_COMPILER_NOT_INSTALLED});
  await install(root,'2.62.0');expect((await (await post(base,'/api/readings',body)).json()).error).toStartWith('READINGS_COMPILER_TOO_OLD 2.62.0 2.63.0');
  expect((await post(base,'/api/readings',body,'http://evil.test')).status).toBe(403);
  expect((await post(base,'/api/readings',{...body,out:'/tmp'})).status).toBe(400);
  const padded=await fetch(base+'/api/readings',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)+' '.repeat(65*1024)});expect(padded.status).toBe(400);
  expect((await fetch(`${base}/api/readings/${'0'.repeat(64)}`)).status).toBe(404);
  expect(await Bun.file(join(state,'readings')).exists()).toBe(false);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
 expect(frontRoute('single','POST','/api/readings')).toMatchObject({mutation:true,limit:65536});expect(frontRoute('single','GET',`/api/readings/${'a'.repeat(64)}`)).toMatchObject({mutation:false});
 expect(frontRoute('compare','POST','/api/readings')).toBeNull();expect(frontRoute('single','GET','/api/readings')).toBeNull();
});

test('HQ: the inspected build\'s check runs once after the baseline reproduces, is stored beside it, and a reload reads it instead of re-running',async()=>{
 const {root,pkg,state,log}=await fixture();await install(root);process.env.FAKE_LOG=log;
 const p=await loadReview(pkg),before=await treeHash(pkg);
 try{
  for(const pass of [1,2]){
   const server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
   try{
    const first=await (await fetch(base+'/api/rebuild')).json();if(pass===1)expect(first.inspectedCheck).toBeNull();
    let status=first;for(let i=0;i<200&&(!status.inspectedCheck||status.inspectedCheck.status==='running');i++){await Bun.sleep(25);status=await (await fetch(base+'/api/rebuild')).json();}
    expect(status.baseline.status).toBe('reproduced');
    expect(status.inspectedCheck).toMatchObject({schema:'rig-review-inspected-check/1',status:'checked',line:'check: PASS; 2 of 2 bar(s) measured',check:{pass:true}});
    expect(beforeLine('TEXTURE_STRETCH',null,status.inspectedCheck)).toBe('TEXTURE_STRETCH: PASS — inspected 1.054');
   }finally{await server.stop(true);}
  }
  const checks=(await readFile(log,'utf8')).split('\n').filter(l=>l.startsWith('parts check '));
  expect(checks).toEqual([`parts check --rig baseline --out inspected-check --parts ${join(p.root,'rig/out')} --page-edges free --pack-shape polygon`]);
  expect(await treeHash(pkg)).toBe(before);
 }finally{delete process.env.FAKE_LOG;await rm(root,{recursive:true,force:true});}
});

test('HQ: a refused inspected check shows the producer\'s line verbatim',async()=>{
 const {root,pkg,state}=await fixture();await install(root);process.env.FAKE_CHECK_REFUSE='1';
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  let status=await (await fetch(base+'/api/rebuild')).json();for(let i=0;i<200&&(!status.inspectedCheck||status.inspectedCheck.status==='running');i++){await Bun.sleep(25);status=await (await fetch(base+'/api/rebuild')).json();}
  expect(status.inspectedCheck).toMatchObject({status:'refused',line:'FAIL  CHECK_PARTS_MISSING: parts.json — not a parts directory'});
  expect(beforeLine('TEXTURE_STRETCH',null,status.inspectedCheck)).toBe('FAIL  CHECK_PARTS_MISSING: parts.json — not a parts directory');
 }finally{delete process.env.FAKE_CHECK_REFUSE;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('feedback context.readings is validated when present: the chosen pairs and the builds, or null',async()=>{
 const {root,pkg}=await fixture();
 try{
  const p=await loadReview(pkg),context={schema:READINGS_SCHEMA,animation:'idle',requests:[{kind:'seam',a:'topwear',b:'bottomwear'}],environment:null,environmentPassed:false,builds:{inspected:'f'.repeat(64),scratch:null},compiler:{package:'rig-c',version:'2.64.1'},ticks:{inspected:3,scratch:null}};
  const feedback=(readings:unknown)=>({id:'x',frameStart:0,frameEnd:1,target:{kind:'rig' as const,name:p.feedbackCatalog.rig},category:'defect' as const,summary:'s',context:{animation:'idle',interval:{frameStart:0,frameEnd:1,inclusive:true},readings} as never});
  expect(()=>validatePackageFeedback(feedback(context),p)).not.toThrow();expect(()=>validatePackageFeedback(feedback(null),p)).not.toThrow();
  expect(()=>validatePackageFeedback(feedback({...context,requests:[]}),p)).toThrow('READINGS_REQUEST_INVALID');
 }finally{await rm(root,{recursive:true,force:true});}
});
