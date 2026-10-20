import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {assertOpNames,parseConfigPatch,patchSha256,CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {appliedCheckRefusal,checkSummary} from '../src/applied-context.ts';
import {freshSession,validatePackageFeedback} from '../src/session.ts';
import {createWindModel} from '../src/environment.ts';
import {applyRamp,barLine,componentValue,draftEdits,draftText,editFor,nearestChain,patchOps,physicsChains,rampValues,rowControls,setEdit,tuningRows,type PendingEdit,type TuningRow} from '../src/physics-tuning.ts';
import {makePatch,patchOutcomeLine,stageModel,type PatchJobView} from '../web/rebuild-client.ts';

/** The real config's shapes (names invented): two-link rotate chains with a translate twin at the tip, a three-link chain with mass, a transform, a bust jiggle. */
const configConstraints=[
 {type:'physics',name:'fringe_a0_physics',bone:'fringe_a0',rotate:1,strength:100,damping:0.85,wind:1,gravity:2},
 {type:'physics',name:'fringe_a1_physics',bone:'fringe_a1',rotate:1,strength:100,damping:0.85,wind:4,gravity:8},
 {type:'physics',name:'fringe_a1_translate',bone:'fringe_a1',x:0.1,y:0.1,strength:100,damping:0.85},
 {type:'transform',name:'swing_0',source:'swing',bones:['tail_0'],mixRotate:1},
 {type:'physics',name:'tail_0_physics',bone:'tail_0',rotate:1,inertia:0.5,strength:160,damping:0.85,mass:1,wind:1,gravity:2,mix:1},
 {type:'physics',name:'tail_1_physics',bone:'tail_1',rotate:1,inertia:0.5,strength:160,damping:0.85,mass:1,wind:2,gravity:3,mix:1},
 {type:'physics',name:'tail_2_physics',bone:'tail_2',rotate:1,inertia:0.5,strength:160,damping:0.85,mass:1,wind:3,gravity:4,mix:1},
 {type:'physics',name:'bust_phys',bone:'chest_jiggle',x:0.5,y:1,inertia:0.35,strength:100,damping:0.85,mass:1.2,mix:1},
];
/** The compiled model: the config's entries as `kind` + `declaredIn`, then the rig stage's turn twins the config never declares. */
const model={constraints:[
 ...configConstraints.map(({type,...rest})=>({kind:type,declaredIn:'rig',...rest})),
 {kind:'transform',name:'turn_hair',declaredIn:'rig',bones:['turn_hair_head'],source:'turn',properties:{}},
 {kind:'transform',name:'turn_neck',declaredIn:'rig',bones:['turn_neck_chest'],source:'turn',properties:{}},
],bones:[{name:'root'},{name:'head',parent:'root'},{name:'fringe_a0',parent:'head'},{name:'fringe_a1',parent:'fringe_a0'},{name:'hip',parent:'root'},{name:'tail_0',parent:'hip'},{name:'tail_1',parent:'tail_0'},{name:'tail_2',parent:'tail_1'},{name:'chest',parent:'hip'},{name:'chest_jiggle',parent:'chest'}]};
const table=()=>{const t=tuningRows(configConstraints,model);if(!t.available)throw new Error(t.reason);return t.rows;};
const byName=(rows:TuningRow[],name:string)=>rows.find(r=>r.name===name)!;

test('rows: the config maps 1:1 onto the model by name and kind; index and name both recorded',()=>{
 const rows=table();
 expect(rows.filter(r=>r.editable).map(r=>[r.name,r.configIndex,r.modelIndex])).toEqual([['fringe_a0_physics',0,0],['fringe_a1_physics',1,1],['fringe_a1_translate',2,2],['tail_0_physics',4,4],['tail_1_physics',5,5],['tail_2_physics',6,6],['bust_phys',7,7]]);
 expect(byName(rows,'tail_1_physics').values).toEqual({strength:160,damping:0.85,inertia:0.5,mass:1,wind:2,gravity:3,mix:1,rotate:1});
 // A config field the model holds otherwise does not map: not editable, with the field named.
 const drifted=tuningRows(configConstraints,{...model,constraints:model.constraints.map((c,i)=>i===1?{...c,damping:0.5}:c)});
 if(!drifted.available)throw new Error('unavailable');
 expect(byName(drifted.rows,'fringe_a1_physics')).toMatchObject({editable:false,reason:'PHYSICS_ROW_UNMAPPED: config.constraints[1].damping is 0.85, the model holds 0.5; the config does not map 1:1 onto this row'});
 expect(tuningRows(null,model)).toEqual({available:false,reason:'PHYSICS_TUNING_UNAVAILABLE: the handoff config has no constraints list'});
});

test('bar 4: rows the model has and the config does not declare are shown, not editable, with the reason',()=>{
 const rows=table(),twins=rows.filter(r=>r.name.startsWith('turn_'));
 expect(twins.map(r=>[r.name,r.editable,r.configIndex])).toEqual([['turn_hair',false,null],['turn_neck',false,null]]);
 for(const twin of twins){
  expect(twin.reason).toBe(`PHYSICS_ROW_UNDECLARED: the model has transform "${twin.name}" but config.constraints does not declare it; it was added at the rig stage (e.g. the \`turn\` twins), so there is no config field to patch`);
  expect(rowControls(twin,new Map())).toEqual({editable:false,reason:twin.reason!});
  expect(()=>editFor(twin,'damping',0.5)).toThrow('PHYSICS_ROW_UNDECLARED');
 }
 // A config transform is shown too, not editable here.
 expect(rowControls(byName(rows,'swing_0'),new Map())).toEqual({editable:false,reason:'PHYSICS_ROW_NOT_PHYSICS: config.constraints[3] is a transform constraint; this panel tunes physics constraints only'});
});

test('bar 1 (unit): the damping slider writes exactly /constraints/<i>/damping, naming its constraint; a revert drops the op',()=>{
 const rows=table(),row=byName(rows,'fringe_a1_physics'),view=rowControls(row,new Map());
 if(!view.editable)throw new Error('not editable');
 expect(view.controls.map(c=>`${c.kind}:${c.field}`)).toEqual(['slider:strength','slider:damping','slider:wind','slider:gravity','toggle:x','toggle:y','toggle:rotate']);
 const slider=view.controls.find(c=>c.kind==='slider'&&c.field==='damping')!;
 expect(slider).toMatchObject({value:0.85,base:0.85,min:0,max:1,pending:false});
 let edits=setEdit(new Map(),row,slider.field,0.5);
 expect(patchOps(edits)).toEqual([{op:'replace',path:'/constraints/1/damping',value:0.5,name:'fringe_a1_physics'}]);
 const after=rowControls(row,edits);if(!after.editable)throw new Error('x');
 expect(after.controls.find(c=>c.field==='damping')).toMatchObject({value:0.5,base:0.85,pending:true});
 edits=setEdit(edits,row,'damping',0.85);expect(edits.size).toBe(0);
 // An absent field becomes an add; a component toggle off is 0, on restores the config's own weight.
 expect(editFor(row,'mass',2)).toEqual({op:'add',path:'/constraints/1/mass',value:2,name:'fringe_a1_physics',configIndex:1,field:'mass',from:null});
 const translate=byName(rows,'fringe_a1_translate');
 expect(componentValue(translate,'x',false)).toBe(0);expect(componentValue(translate,'x',true)).toBe(0.1);expect(componentValue(translate,'rotate',true)).toBe(1);
 expect(()=>editFor(row,'damping',Number.NaN)).toThrow('PHYSICS_VALUE_INVALID');
});

test('bar 2: a chain ramp writes exactly one op per link, linear root → tip (numerically)',()=>{
 const rows=table(),chains=physicsChains(rows,model.bones);
 expect(chains.map(c=>c.links.map(l=>l.name))).toEqual([['fringe_a0_physics','fringe_a1_physics'],['tail_0_physics','tail_1_physics','tail_2_physics']]);
 const tail=chains[1]!;
 expect(rampValues(3,0.9,0.6)).toEqual([0.9,0.75,0.6]);
 const ops=patchOps(applyRamp(new Map(),tail,'damping',0.95,0.65));
 expect(ops.map(o=>o.path)).toEqual(['/constraints/4/damping','/constraints/5/damping','/constraints/6/damping']);
 expect(ops.map(o=>o.name)).toEqual(['tail_0_physics','tail_1_physics','tail_2_physics']);
 const values=ops.map(o=>o.value as number);
 expect(values[0]).toBe(0.95);expect(Math.abs(values.at(-1)!-0.65)).toBeLessThan(1e-12);
 const steps=values.slice(1).map((v,i)=>v-values[i]!);for(const step of steps)expect(Math.abs(step-(0.65-0.95)/2)).toBeLessThan(1e-12);
 // Five links: one op each, equal steps.
 const five=rampValues(5,100,300);expect(five).toEqual([100,150,200,250,300]);
 // Ramping a field over a link that lacks it adds it there; one op per link still.
 expect(patchOps(applyRamp(new Map(),chains[0]!,'mass',1,2)).map(o=>[o.op,o.path,o.value])).toEqual([['add','/constraints/0/mass',1],['add','/constraints/1/mass',2]]);
 expect(()=>rampValues(1,0,1)).toThrow('PHYSICS_CHAIN_SHORT');
 // Picking on stage: the nearest link bone within the radius.
 const points=new Map([['fringe_a1',{x:100,y:100}],['tail_2',{x:300,y:300}]]);
 expect(nearestChain(chains,points,{x:296,y:305})?.id).toBe(tail.id);expect(nearestChain(chains,points,{x:200,y:200})).toBeNull();
});

test('the draft keeps the pending ops and restores only rows that still resolve by index and name',()=>{
 const rows=table();let edits:Map<string,PendingEdit>=setEdit(new Map(),byName(rows,'tail_2_physics'),'wind',5);edits=setEdit(edits,byName(rows,'bust_phys'),'mass',1.5);
 const text=draftText(edits);
 expect([...draftEdits(text,rows).values()]).toEqual([...edits.values()]);
 const moved=rows.map(r=>r.name==='bust_phys'?{...r,configIndex:9}:r);
 expect([...draftEdits(text,moved).keys()]).toEqual(['/constraints/6/wind']);
 const renamed=rows.map(r=>r.name==='bust_phys'?{...r,name:'bust_phys_v2'}:r);
 expect([...draftEdits(text,renamed).keys()]).toEqual(['/constraints/6/wind']);
 expect(draftEdits('not json',rows).size).toBe(0);
});

test('a patch op may record the name its index holds; a mismatch is EDIT_PATCH_NAME_MISMATCH',()=>{
 const doc={constraints:configConstraints} as never;
 const patch=parseConfigPatch({schema:CONFIG_PATCH_SCHEMA,config_sha256:'a'.repeat(64),ops:[{op:'replace',path:'/constraints/1/damping',value:0.5,name:'fringe_a1_physics'}],producer:{name:'@rig-c/parts',version:'1.42.0'},op:{cmd:'rig',args:[]}});
 expect(patch.ops[0]).toEqual({op:'replace',path:'/constraints/1/damping',value:0.5,name:'fringe_a1_physics'});
 expect(()=>assertOpNames(doc,patch.ops)).not.toThrow();
 expect(()=>assertOpNames(doc,[{...patch.ops[0]!,name:'fringe_a0_physics'}])).toThrow('EDIT_PATCH_NAME_MISMATCH: ops[0] /constraints/1/damping records "fringe_a0_physics", but /constraints/1 is "fringe_a1_physics" in the handoff config');
 expect(()=>parseConfigPatch({...patch,ops:[{op:'replace',path:'/key',value:1,name:'x'}]})).toThrow('EDIT_PATCH_INVALID');
 expect(()=>parseConfigPatch({...patch,ops:[{op:'replace',path:'/constraints/1/damping',value:1,name:''}]})).toThrow('EDIT_PATCH_INVALID');
 expect(patchSha256(patch)).not.toBe(patchSha256({...patch,ops:[{op:'replace',path:'/constraints/1/damping',value:0.5}]}));
});

test('readout: check\'s own printed line per bar, else the status from check.json, else "not in check summary" by name',()=>{
 const lines=['  TEXTURE_STRETCH: PASS — meshes 7; severity 1.056','check: PASS; 11 of 13 bar(s) measured'];
 const check=checkSummary({PASS:true,TEXTURE_STRETCH:{status:'PASS'},ANIMATIONS_DO_NOT_FOLD:{status:'PASS'}},0,lines,null);
 expect(barLine('TEXTURE_STRETCH',lines,check)).toBe('TEXTURE_STRETCH: PASS — meshes 7; severity 1.056');
 expect(barLine('ANIMATIONS_DO_NOT_FOLD',lines,check)).toBe('ANIMATIONS_DO_NOT_FOLD: PASS (status from check.json; check printed no line for it)');
 expect(barLine('ANIMATIONS_DO_NOT_FOLD',[],null)).toBe('ANIMATIONS_DO_NOT_FOLD: not in check summary');
});

test('an Apply\'s reload resumes the same world: wind clock, active pulse and repeat as they stood',()=>{
 const wind=createWindModel();wind.setBase(30);wind.setRepeat(true);wind.advance(1.1);wind.triggerGust();wind.advance(0.4);
 const saved=wind.state(),reading=wind.read();
 wind.advance(7.3);wind.setBase(-5);
 wind.resume(saved);expect(wind.read()).toEqual(reading);
 const twin=createWindModel();twin.resume(saved);twin.advance(0.5);wind.advance(0.5);expect(twin.read()).toEqual(wind.read());
});

const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
/** rigc's own A23 line as `rig-parts rig` relays it under RIG_RIGC_GREEN (the real producer's shape, shortened). */
const A23='    FAIL  A23_PHYSICS_CONSTRAINT_EFFECTIVE: physics "tail_0_physics" has massInverse Infinity; mass must be > 0 (see rigc guide A23_PHYSICS_CONSTRAINT_EFFECTIVE)';
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8'));
 if((cfg.constraints||[]).some(c=>c.mass===0)){console.log('rig-parts rig: reading');console.log(${JSON.stringify(A23)});console.log('  FAIL  RIG_RIGC_GREEN: rigc build — exited 1: FAIL  A23_PHYSICS_CONSTRAINT_EFFECTIVE: …');console.log('refused: 1 problem(s)');process.exit(1);}
 const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});
 for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));if(cfg.constraints)rig.constraints=cfg.constraints;fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 console.log('rig-parts rig: wrote rig.json');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:true,gate_spine_html_green:true,TEXTURE_STRETCH:{status:'PASS'},ANIMATIONS_DO_NOT_FOLD:{status:'PASS'}}));console.log('  TEXTURE_STRETCH: PASS — x');console.log('  ANIMATIONS_DO_NOT_FOLD: PASS — y');console.log('check: PASS; 2 of 2 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});const rig=JSON.parse(fs.readFileSync(f('--rig'),'utf8'));
fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],constraints:rig.constraints||null}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-physics-'))),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify({key:'k',constraints:configConstraints},null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(pkg,'rig/out/rig/rig.json'),JSON.stringify({bones:[{name:'root'}],constraints:configConstraints}));for(const name of ['motion.json','mesh_report.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,state:join(root,'state')};
}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
async function settle(base:string,job:PatchJobView):Promise<PatchJobView>{while(job.status==='running'){await Bun.sleep(20);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json();}return job;}

test('bar 3: mass 0 is refused with rigc\'s A23 line verbatim, no build is served and the stage keeps its model',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json();
  expect(status.constraints).toEqual(configConstraints);
  const rows=table(),edits=setEdit(new Map(),byName(rows,'tail_0_physics'),'mass',0);
  const patch=makePatch(status,patchOps(edits)) as ConfigPatch;
  expect(patch.ops).toEqual([{op:'replace',path:'/constraints/4/mass',value:0,name:'tail_0_physics'}]);
  expect(patch.config_sha256).toBe(sha(await readFile(join(pkg,'rig/config.json'))));
  const job=await settle(base,await (await post(base,{patch})).json());
  expect(job).toMatchObject({status:'refused',exitCode:1,producerLine:A23.trim(),build:null});
  expect(patchOutcomeLine(job)).toEqual({text:A23.trim(),error:true});
  const current={url:'/assets/build/skeleton.model.json',hash:'e'.repeat(64)};expect(stageModel(job,current)).toEqual({...current,id:null});
  // A name that no longer matches its index is refused before the producer runs.
  const renamed={...patch,ops:[{...patch.ops[0]!,name:'tail_1_physics'}]};
  expect(await (await post(base,{patch:renamed})).json()).toMatchObject({status:'refused',error:expect.stringMatching(new RegExp('^'+'EDIT_PATCH_NAME_MISMATCH'))});
  // The same panel edit at mass 2 builds, and check's two readout lines come back in the job's lines.
  const built=await settle(base,await (await post(base,{patch:makePatch(status,patchOps(setEdit(new Map(),byName(rows,'tail_0_physics'),'mass',2)))})).json());
  expect(built).toMatchObject({status:'built',diff:{count:1,paths:['/constraints/4/mass']}});
  expect(barLine('ANIMATIONS_DO_NOT_FOLD',built.lines,built.check)).toBe('ANIMATIONS_DO_NOT_FOLD: PASS — y');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('submit refuses a review whose applied state failed check: EDIT_SUBMIT_UNCHECKED with the FAIL line',async()=>{
 const patch=parseConfigPatch({schema:CONFIG_PATCH_SCHEMA,config_sha256:'f'.repeat(64),ops:[{op:'replace',path:'/constraints/1/damping',value:0.5,name:'fringe_a1_physics'}],producer:{name:'@rig-c/parts',version:'1.42.0'},op:{cmd:'rig',args:[]}});
 const fail=checkSummary({PASS:false,gate_spine_html_green:true,TEXTURE_STRETCH:{status:'FAIL'}},1,['  TEXTURE_STRETCH: FAIL — severity 3.2','check: FAIL — TEXTURE_STRETCH; 1 of 1 bar(s) measured'],null);
 const applied=(check:typeof fail)=>({schema:'rig-review-applied/2',buildId:'d'.repeat(64),patch,patchSha256:patchSha256(patch),configHash:'f'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'rig-parts rig: wrote',check,diff:{count:1,paths:['/constraints/1/damping']},modelHash:'e'.repeat(64)});
 const line='EDIT_SUBMIT_UNCHECKED: applied build failed check — check: FAIL — TEXTURE_STRETCH; 1 of 1 bar(s) measured';
 expect(appliedCheckRefusal(applied(fail))).toBe(line);
 expect(appliedCheckRefusal(applied({...fail,line:null}))).toBe('EDIT_SUBMIT_UNCHECKED: applied build failed check — TEXTURE_STRETCH: FAIL');
 expect(appliedCheckRefusal(applied({...fail,pass:true,bars:{TEXTURE_STRETCH:'PASS'},line:'check: PASS'}))).toBeNull();
 expect(appliedCheckRefusal(null)).toBeNull();
 // Through the server: PUT /api/session with that note is refused by name; the same note on a passing build saves.
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const note=(context:Record<string,unknown>)=>({id:'n1',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.feedbackCatalog.rig},category:'quality',summary:'fringe settles',context});
  expect(()=>validatePackageFeedback(note({applied:applied(fail)}) as never,p)).toThrow(line);
  const put=(feedback:unknown[])=>fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...freshSession(p),feedback})});
  const refused=await put([note({applied:applied(fail)})]);expect(refused.ok).toBe(false);expect(await refused.text()).toContain(line);
  const passing={...fail,pass:true,bars:{TEXTURE_STRETCH:'PASS'},line:'check: PASS; 1 of 1 bar(s) measured',exitCode:0};
  const saved=await put([note({applied:applied(passing)})]);expect(saved.ok).toBe(true);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});
