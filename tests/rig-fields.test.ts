import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {applyConfigPatch,assertOpNames,CONFIG_PATCH_SCHEMA,jsonDiff,type ConfigPatch,type JsonValue,type PatchOp} from '../src/config-patch.ts';
import {arcBound,assertRigFieldOps,readingPair,currentAt,dragRow,fieldsApplyEnabled,fieldsDraftEdits,fieldsDraftText,INHERIT_MODES,rigFieldOps,rigFieldsSource,RIG_FIELDS_READOUT_BARS,seedStill,setInherit,setRegion,setStill,setStop,setTurn,stillParts,stopArcs,turnDial,TURN_BONE,type FieldEdit} from '../src/rig-fields.ts';
import {readoutRows} from '../src/physics-tuning.ts';
import {arcPath} from '../web/rig-fields-panel.ts';
import {patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

/** The real config's shapes (regions a part → bone map, a blink with eyes, a turn with pivot and depths) plus a stop, an inherit and a still row the real config does not state. */
const config={key:'k',
 bones:[
  {name:'hip',parent:'root',at:[416,620]},
  {name:'head',parent:'hip',at:[413,214]},
  {name:'eye_r',parent:'head',at:[388,176]},
  {name:'eye_l',parent:'head',at:[438,174]},
  {name:'bun',parent:'head',at:[413,127],tip:[413,193]},
  {chain:'leg_r',parent:'hip',points:[[400,640],[400,800]],tip:[400,960]},
  {name:'foot_r',parent:'leg_r1',at:[400,960],inherit:'noRotationOrReflection'},
  {chain:'skirt0_',parent:'hip',points:[[380,640],[370,700]],tip:[360,760]},
 ],
 regions:{lash_r:'eye_r',lash_l:'eye_l',hairpin:'bun',face:'head',shoes:'root'},
 motion:{duration:3,tracks:[],blink:{t:1.2,eyes:['eye_r','eye_l'],squash:.12,still:{lash_l:{row:170,bone:'head'}}}},
 stops:[{chain:'skirt0_',against:'leg_r0',at:[80,0],inward:20,outward:35}],
 turn:{pivot:0.68,depths:{face:0.64,hairpin:0.0098,lash_r:0.6396,shoes:0.668,lash_l:0.6396}},
};
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const ops=(edits:ReadonlyMap<string,FieldEdit>)=>rigFieldOps(rigFieldsSource(config),edits);
const diffOf=(list:PatchOp[])=>jsonDiff(config,applyConfigPatch(config as unknown as JsonValue,list));

test('the config fields are read as written; an entry the block cannot read is named, not guessed',()=>{
 const s=rigFieldsSource(config);
 expect(s.regions).toEqual(config.regions);
 expect(s.blink).toEqual({eyes:['eye_r','eye_l'],still:{lash_l:{row:170,bone:'head'}}});
 expect(s.stops?.map(x=>[x.index,x.chain,x.against,x.at,x.inward,x.outward])).toEqual([[0,'skirt0_','leg_r0',[80,0],20,35]]);
 expect(s.bones.map(b=>[b.index,b.name,b.chain,b.inherit])).toEqual([[0,'hip',false,null],[1,'head',false,null],[2,'eye_r',false,null],[3,'eye_l',false,null],[4,'bun',false,null],[5,'leg_r',true,null],[6,'foot_r',false,'noRotationOrReflection'],[7,'skirt0_',true,null]]);
 expect(s.boneNames).toEqual(['root','hip','head','eye_r','eye_l','bun','leg_r0','leg_r1','foot_r','skirt0_0','skirt0_1']);
 expect(s.turn).toEqual({pivot:.68,depths:config.turn.depths});
 expect(stillParts(s)).toEqual(['lash_l','lash_r']);
 expect(seedStill(s,'lash_r')).toEqual({row:176,bone:'head'});
 const odd=rigFieldsSource({regions:{a:3},motion:{blink:{eyes:[],still:{x:{row:'1'}}}},stops:[{chain:'c'}],turn:{depths:{}}});
 expect(odd.skipped).toEqual(['regions.a is not a bone name','motion.blink.still.x is not {row, bone}','stops[0] is not {chain, against, at, inward, outward}','turn.pivot is not a number']);
 expect(rigFieldsSource({})).toMatchObject({regions:null,blink:null,stops:null,turn:null,bones:[],boneNames:['root']});
 expect(INHERIT_MODES).toEqual(['normal','onlyTranslation','noRotationOrReflection','noScale','noScaleOrReflection']);
});

test('each field is one op at the card\'s pointer, and the patched config differs at exactly that path',()=>{
 const s=rigFieldsSource(config),none=new Map<string,FieldEdit>();
 // regions.<part>
 let e=setRegion(s,none,'hairpin','head');
 expect(ops(e)).toEqual([{op:'replace',path:'/regions/hairpin',value:'head'}]);expect(diffOf(ops(e))).toEqual(['/regions/hairpin']);
 expect(setRegion(s,e,'hairpin','bun').size).toBe(0);
 expect(()=>setRegion(s,none,'topwear','chest')).toThrow('RIG_FIELDS_NOT_A_REGION');
 // motion.blink.still.<part>: an existing entry, a new one, a removal
 e=setStill(s,none,'lash_l',{row:dragRow(170,40.2,43.6),bone:'head'});
 expect(ops(e)).toEqual([{op:'add',path:'/motion/blink/still/lash_l',value:{row:173,bone:'head'}}]);expect(diffOf(ops(e))).toEqual(['/motion/blink/still/lash_l/row']);
 e=setStill(s,none,'lash_r',{row:176,bone:'head'});expect(diffOf(ops(e))).toEqual(['/motion/blink/still/lash_r']);
 e=setStill(s,none,'lash_l',null);expect(ops(e)).toEqual([{op:'remove',path:'/motion/blink/still/lash_l'}]);expect(diffOf(ops(e))).toEqual(['/motion/blink/still/lash_l']);
 // A config with no still: the container is added first, then the entry at the card's pointer.
 const bare={...config,motion:{...config.motion,blink:{t:1.2,eyes:['eye_r','eye_l'],squash:.12}}},b=rigFieldsSource(bare);
 const added=rigFieldOps(b,setStill(b,none,'lash_r',{row:176,bone:'head'}));
 expect(added).toEqual([{op:'add',path:'/motion/blink/still',value:{}},{op:'add',path:'/motion/blink/still/lash_r',value:{row:176,bone:'head'}}]);
 expect(jsonDiff(bare,applyConfigPatch(bare as unknown as JsonValue,added))).toEqual(['/motion/blink/still']);
 // stops[i]: the whole entry, one bound changed, named by its chain
 const arcs=stopArcs(s,s.stops![0]!);if('reason' in arcs)throw new Error(arcs.reason);
 e=setStop(s,none,0,{outward:arcBound(arcs.rest,'outward',arcs.rest+48.6)});
 expect(ops(e)).toEqual([{op:'replace',path:'/stops/0',value:{chain:'skirt0_',against:'leg_r0',at:[80,0],inward:20,outward:49},name:'skirt0_'}]);expect(diffOf(ops(e))).toEqual(['/stops/0/outward']);
 // bones[i].inherit (single) and link_inherit (chain), named
 e=setInherit(s,none,4,'noScale');expect(ops(e)).toEqual([{op:'add',path:'/bones/4/inherit',value:'noScale',name:'bun'}]);expect(diffOf(ops(e))).toEqual(['/bones/4/inherit']);
 e=setInherit(s,none,6,null);expect(ops(e)).toEqual([{op:'remove',path:'/bones/6/inherit',name:'foot_r'}]);expect(diffOf(ops(e))).toEqual(['/bones/6/inherit']);
 e=setInherit(s,none,5,'onlyTranslation','leg_r1');expect(ops(e)).toEqual([{op:'add',path:'/bones/5/link_inherit',value:{leg_r1:'onlyTranslation'},name:'leg_r'}]);expect(diffOf(ops(e))).toEqual(['/bones/5/link_inherit']);
 expect(setInherit(s,e,5,null,'leg_r1').size).toBe(0);
 expect(()=>setInherit(s,none,5,'normal')).toThrow('RIG_FIELDS_VALUE_INVALID');
 // turn: pivot and one part's depth
 e=setTurn(s,none,{part:'hairpin',depth:.3});expect(ops(e)).toEqual([{op:'replace',path:'/turn/depths/hairpin',value:.3}]);expect(diffOf(ops(e))).toEqual(['/turn/depths/hairpin']);
 e=setTurn(s,none,{pivot:.7});expect(diffOf(ops(e))).toEqual(['/turn/pivot']);
 // Names resolve against the unpatched config: a stop by its chain, a bone by name or chain.
 const all=ops(setTurn(s,setInherit(s,setStop(s,setRegion(s,none,'hairpin','head'),0,{inward:10}),5,'noScale','leg_r0'),{part:'face',depth:.6}));
 expect(all.map(o=>o.path)).toEqual(['/regions/hairpin','/stops/0','/bones/5/link_inherit','/turn/depths/face']);
 expect(()=>assertOpNames(config as unknown as JsonValue,all)).not.toThrow();
 expect(()=>assertOpNames(config as unknown as JsonValue,[{op:'replace',path:'/stops/0',value:{},name:'leg_r'}])).toThrow('EDIT_PATCH_NAME_MISMATCH');
 expect(()=>assertRigFieldOps(all)).not.toThrow();
});

test('the block\'s scope: anything outside the card\'s pointers or shapes is refused by name',()=>{
 const bad:[PatchOp,string][]=[
  [{op:'replace',path:'/meshes/face',value:'head'},'/meshes/face'],
  [{op:'add',path:'/regions/face',value:'head'},'a region is replaced'],
  [{op:'add',path:'/motion/blink/still/lash_r',value:{row:1}},'{row, bone}'],
  [{op:'add',path:'/motion/blink/still',value:{lash_r:{row:1,bone:'head'}}},'only {}'],
  [{op:'replace',path:'/stops/0',value:{inward:1}},'names its chain'],
  [{op:'add',path:'/bones/2/inherit',value:'noScale'},'name its bone'],
  [{op:'add',path:'/bones/2/inherit',value:3,name:'eye_r'},'mode name'],
  [{op:'replace',path:'/turn/deform',value:{}},'turn.deform is out of scope'],
  [{op:'replace',path:'/turn/pivot',value:'x'},'number'],
 ];
 for(const [op,why] of bad)expect(()=>assertRigFieldOps([op])).toThrow(why);
 try{assertRigFieldOps([bad[0]![0]]);}catch(e){expect((e as Error).message).toStartWith('RIG_FIELDS_OP_OUT_OF_SCOPE: ops[0] replace /meshes/face');}
 expect(fieldsApplyEnabled({busy:false,pending:1})).toBe(true);expect(fieldsApplyEnabled({busy:true,pending:1})).toBe(false);expect(fieldsApplyEnabled({busy:false,pending:0})).toBe(false);
});

test('stage geometry: the still row snaps to whole rig px; a stop\'s arcs are aimed as rig-c aims them; the dial writes only the turn bone\'s x',()=>{
 expect(dragRow(170,40.2,43.6)).toBe(173);expect(dragRow(170.5,10,6.9)).toBe(167.5);expect(dragRow(170,10,10.4)).toBe(170);
 const s=rigFieldsSource(config),arcs=stopArcs(s,s.stops![0]!);if('reason' in arcs)throw new Error(arcs.reason);
 // leg_r0 runs from [400,640] down to [400,800]: +x is straight down the page; at [80,0] is 80 px along it.
 expect(arcs.pivot).toEqual([380,640]);expect(arcs.touch.map(v=>Math.round(v*1e6)/1e6)).toEqual([400,720]);
 const rest=Math.atan2(-(720-640),400-380)*180/Math.PI;expect(arcs.rest).toBeCloseTo(rest,12);expect(arcs.from).toBeCloseTo(rest-20,12);expect(arcs.to).toBeCloseTo(rest+35,12);
 // A perpendicular offset: +y is 90° counter-clockwise from leg_r0 (down the page) in Spine world, so image-right.
 const side=stopArcs(s,{...s.stops![0]!,at:[80,10]});if('reason' in side)throw new Error(side.reason);expect(side.touch.map(v=>Math.round(v*1e6)/1e6)).toEqual([410,720]);
 expect(arcBound(rest,'outward',rest+35.4)).toBe(35);expect(arcBound(rest,'inward',rest-12.6)).toBe(13);expect(arcBound(rest,'inward',rest+5)).toBe(0);
 expect(arcBound(170,'outward',-170)).toBe(20);
 expect(stopArcs(s,{...s.stops![0]!,against:'nope'})).toEqual({reason:'CONFIG_NAME_RESOLVES: stops[0].against nope has no origin and direction in bones'});
 expect(arcPath({x:0,y:0},0,90,10)).toBe('M 0 0 L 10.00 0.00 A 10 10 0 0 0 0.00 -10.00 Z');
 const touched:string[]=[],locals={x:5};turnDial(37)({bone:name=>{touched.push(name);return locals;}});
 expect(touched).toEqual([TURN_BONE]);expect(locals.x).toBe(37);expect(()=>turnDial(Number.NaN)).toThrow('RIG_FIELDS_VALUE_INVALID');
});

test('the draft keeps pending edits only while the config still holds what they were made from',()=>{
 const s=rigFieldsSource(config),e=setTurn(s,setRegion(s,new Map(),'hairpin','head'),{part:'face',depth:.6}),text=fieldsDraftText(e);
 expect([...fieldsDraftEdits(text,s).keys()]).toEqual(['/regions/hairpin','/turn/depths/face']);
 const moved=rigFieldsSource({...config,regions:{...config.regions,hairpin:'head'}});
 expect([...fieldsDraftEdits(text,moved).keys()]).toEqual(['/turn/depths/face']);
 expect(fieldsDraftEdits('nope',s).size).toBe(0);
 expect(currentAt(s,'/bones/6/inherit')).toBe('noRotationOrReflection');expect(currentAt(s,'/motion/blink/still/lash_r')).toBeUndefined();
});

/**
 * Stand-ins. `rig-parts rig` derives rig.json from the config the way the producer places these fields: a slot per
 * region part on its bone (sorted), then a `<part>_still` slot per still row; the bones with their inherit; the stops as
 * handed; one `turn_<part>` transform per depth with mix (pivot − depth) / (pivot − nearest). It refuses, as the producer
 * names them, a still off the blink, an inherit rig-c does not name, a pivot at or before the nearest depth and a region
 * bone nothing declares. `check` prints BLINK_NO_HOLE and FEET_STAY_LEVEL (PASS when foot_r keeps its setup angle).
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
const fail=l=>{console.log('[rig] reading config');console.log('  FAIL  '+l);console.log('refused: 1 problem(s)');process.exit(1);};
if(a[0]==='rig'){const c=JSON.parse(fs.readFileSync(f('--config'),'utf8'));
 const names=['root'];for(const b of c.bones)if(b.name)names.push(b.name);else (b.points||[]).forEach((_,k)=>names.push(b.chain+k));
 const modes=['normal','onlyTranslation','noRotationOrReflection','noScale','noScaleOrReflection'],eyes=c.motion.blink.eyes;
 for(const [p,b] of Object.entries(c.regions))if(!names.includes(b))fail('CONFIG_NAME_RESOLVES: config.regions.'+p+' — names bone "'+b+'", which bones does not declare');
 for(const [i,b] of c.bones.entries())if(b.inherit!==undefined&&!modes.includes(b.inherit))fail('CONFIG_BONE_INHERIT: config.bones['+i+'].inherit — "'+b.inherit+'" is not one of rig-c\\'s modes: '+modes.join(', '));
 for(const [p,s] of Object.entries(c.motion.blink.still||{}))if(!eyes.includes(c.regions[p])||eyes.includes(s.bone))fail('CONFIG_STILL_OFF_THE_BLINK: config.motion.blink.still.'+p+' — '+(eyes.includes(s.bone)?'bone "'+s.bone+'" is one the blink\\'s eyes names':'the part rides no eye bone'));
 const d=Object.values(c.turn.depths),near=Math.min(...d);if(c.turn.pivot<=near)fail('CONFIG_TURN_PIVOT_BEHIND_NEAREST: config.turn.pivot — '+c.turn.pivot+' is at or in front of the nearest depth '+near);
 const slots=Object.keys(c.regions).sort().map(p=>({name:p,bone:c.regions[p]}));for(const p of Object.keys(c.motion.blink.still||{}).sort())slots.push({name:p+'_still',bone:c.motion.blink.still[p].bone,row:c.motion.blink.still[p].row});
 const bones=names.map(n=>{const b=c.bones.find(x=>x.name===n);return b&&b.inherit?{name:n,inherit:b.inherit}:{name:n};});
 const constraints=Object.keys(c.turn.depths).sort().map(p=>({name:'turn_'+p,mixX:(c.turn.pivot-c.turn.depths[p])/(c.turn.pivot-near)}));
 const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify({bones,slots,stops:c.stops||[],constraints}));
 fs.writeFileSync(path.join(out,'motion.json'),JSON.stringify({blink:{t:c.motion.blink.t}}));fs.writeFileSync(path.join(out,'mesh_report.json'),'{}');
 console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out'),rig=JSON.parse(fs.readFileSync(path.join(f('--rig'),'rig.json'),'utf8'));fs.mkdirSync(out,{recursive:true});
 const level=(rig.bones.find(b=>b.name==='foot_r')||{}).inherit==='noRotationOrReflection'?'PASS':'FAIL';
 fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:level==='PASS',BLINK_NO_HOLE:{status:'PASS'},FEET_STAY_LEVEL:{status:level}}));
 console.log('BLINK_NO_HOLE: PASS — the shut eye shows no page');console.log('FEET_STAY_LEVEL: '+level+' — foot_r '+(level==='PASS'?'keeps':'turns from')+' its setup angle');console.log('check: '+level+'; 2 of 2 bar(s) measured');process.exit(level==='PASS'?0:1);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}]}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-fields-'))),pkg=join(root,'pkg'),bin=join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));await writeFile(bin,fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');await writeFile(join(pkg,'motion.json'),'{}');
 // The inspected rig is the stand-in's own output for the handoff config, so the baseline reproduces it.
 const made=Bun.spawnSync(['node',bin,'rig','--config',join(pkg,'rig/config.json'),'--parts',join(pkg,'rig/out'),'--out',join(pkg,'rig/out/rig')]);
 if(made.exitCode!==0)throw new Error(made.stdout.toString());
 return {root,pkg,state:join(root,'state')};
}
const postPatch=(base:string,patch:ConfigPatch)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({patch})});
async function settle(base:string,job:{id:string;status:string}):Promise<PatchJobView>{let current=job as PatchJobView;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const patchFor=(configSha:string,list:ConfigPatch['ops']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops:list,producer:{name:'@rig-c/parts',version:'1.42.0'},op:{cmd:'rig',args:[]}});
const fileDiff=(job:PatchJobView)=>Object.fromEntries((job.files?.documents??[]).filter(d=>d.count).map(d=>[d.file,d.paths]));

test('bars (server): each field\'s Apply rebuilds the whole rig, and the revision differs from the inspected rig at the one path the field places',async()=>{
 const {root,pkg,state}=await fixture(),p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const status=await (await fetch(base+'/api/rebuild')).json() as {fields:Record<string,unknown>;inputs:{configHash:string};inspectedCheck:unknown};
  const s=rigFieldsSource(status.fields),none=new Map<string,FieldEdit>(),hash=status.inputs.configHash;
  expect(hash).toBe(sha(await readFile(join(pkg,'rig/config.json'))));
  expect(status.fields).toEqual({regions:config.regions,stops:config.stops,bones:config.bones,turn:config.turn,motion:{blink:config.motion.blink}});
  const cases:[string,Map<string,FieldEdit>,Record<string,string[]>][]=[
   // slots sorted: face, hairpin, lash_l, lash_r, shoes, then lash_l_still
   ['region',setRegion(s,none,'hairpin','head'),{'rig.json':['/slots/1/bone']}],
   ['still',setStill(s,none,'lash_l',{row:173,bone:'head'}),{'rig.json':['/slots/5/row']}],
   ['stop',setStop(s,none,0,{outward:49}),{'rig.json':['/stops/0/outward']}],
   ['inherit',setInherit(s,none,4,'noScale'),{'rig.json':['/bones/5/inherit']}],
   // face is not the nearest part, so only its own transform's mix moves.
   ['turn',setTurn(s,none,{part:'face',depth:.6}),{'rig.json':['/constraints/0/mixX']}],
  ];
  for(const [field,edits,want] of cases){
   const list=rigFieldOps(s,edits);assertRigFieldOps(list);
   const job=await settle(base,await (await postPatch(base,patchFor(hash,list))).json());
   expect({field,status:job.status}).toEqual({field,status:'built'});
   expect({field,diff:fileDiff(job)}).toEqual({field,diff:want});
   expect(patchOutcomeLine(job).text).toContain('rig.json differs at 1 path');
  }
  // The readout: BLINK_NO_HOLE and FEET_STAY_LEVEL before (the inspected build's stored check) and after, as printed.
  const job=await settle(base,await (await postPatch(base,patchFor(hash,rigFieldOps(s,setInherit(s,none,6,'normal'))))).json());
  expect(fileDiff(job)).toEqual({'rig.json':['/bones/8/inherit']});
  let inspected:import('../src/physics-tuning.ts').InspectedCheckView|null=null;
  for(let i=0;i<400&&(!inspected||inspected.status==='running');i++){inspected=(await (await fetch(base+'/api/rebuild')).json() as {inspectedCheck:import('../src/physics-tuning.ts').InspectedCheckView|null}).inspectedCheck;if(!inspected||inspected.status==='running')await Bun.sleep(25);}
  expect(readoutRows(null,inspected,{lines:job.lines,check:job.check},RIG_FIELDS_READOUT_BARS)).toEqual([
   {name:'BLINK_NO_HOLE',before:'BLINK_NO_HOLE: PASS — the shut eye shows no page',after:'BLINK_NO_HOLE: PASS — the shut eye shows no page'},
   {name:'FEET_STAY_LEVEL',before:'FEET_STAY_LEVEL: PASS — foot_r keeps its setup angle',after:'FEET_STAY_LEVEL: FAIL — foot_r turns from its setup angle'},
  ]);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bars (server): the producer\'s refusals come back verbatim and leave no build',async()=>{
 const {root,pkg,state}=await fixture(),p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const hash=sha(await readFile(join(pkg,'rig/config.json'))),s=rigFieldsSource(config),none=new Map<string,FieldEdit>();
  const refusals:[Map<string,FieldEdit>,string][]=[
   [setStill(s,none,'lash_l',{row:170,bone:'eye_l'}),'FAIL  CONFIG_STILL_OFF_THE_BLINK: config.motion.blink.still.lash_l — bone "eye_l" is one the blink\'s eyes names'],
   [setInherit(s,none,4,'NoScale'),'FAIL  CONFIG_BONE_INHERIT: config.bones[4].inherit — "NoScale" is not one of rig-c\'s modes: normal, onlyTranslation, noRotationOrReflection, noScale, noScaleOrReflection'],
   [setTurn(s,none,{pivot:.005}),'FAIL  CONFIG_TURN_PIVOT_BEHIND_NEAREST: config.turn.pivot — 0.005 is at or in front of the nearest depth 0.0098'],
   [setRegion(s,none,'hairpin','tail'),'FAIL  CONFIG_NAME_RESOLVES: config.regions.hairpin — names bone "tail", which bones does not declare'],
  ];
  for(const [edits,line] of refusals){
   const job=await settle(base,await (await postPatch(base,patchFor(hash,rigFieldOps(s,edits)))).json());
   expect(job).toMatchObject({status:'refused',producerLine:line,build:null});
   expect(patchOutcomeLine(job)).toEqual({text:line,error:true});
  }
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('the block in the page: one Fields button in Setup\'s row, the draft textarea the only control with an id, and the stage layer beside the idle handles',async()=>{
 const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
 expect(html.split('data-block-target="rig-fields">Fields</button>').length).toBe(2);
 const block=html.slice(html.indexOf('<section id="rig-fields"'),html.indexOf('</section>',html.indexOf('<section id="rig-fields"')));
 expect([...block.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(m=>m[2])).toEqual(['rig-fields-pending']);
 for(const id of ['rig-fields-state','rig-fields-region','rig-fields-still','rig-fields-stops','rig-fields-inherit','rig-fields-turn','rig-fields-pending-list','rig-fields-apply','rig-fields-reset','rig-fields-reading','rig-fields-status','rig-fields-readout','rig-fields-dial-label'])expect({id,once:html.split(` id="${id}"`).length}).toEqual({id,once:2});
 expect(html).toContain('<div id="idle-handles" class="idle-handles" hidden aria-label="Chain amplitude handles"></div><div id="rig-fields-stage" class="rig-fields-stage" hidden aria-label="Rig field handles"></div>');
 expect(html.slice(html.indexOf('id="rig-fields-dial-label"'),html.indexOf('</span>',html.indexOf('id="rig-fields-dial-label"')))).toContain('preview — Apply decides');
});

test('the one-click angle-range pair: an inherit bone against its parent, a re-boned part\'s new bone against its old one, else the part\'s bone against its parent',()=>{
 const s=rigFieldsSource(config),none=new Map<string,FieldEdit>();
 expect(readingPair(s,none,{bone:6,part:'hairpin'})).toEqual({bone:'foot_r',relative:'leg_r1'});
 expect(readingPair(s,none,{bone:null,part:'hairpin'})).toEqual({bone:'bun',relative:'head'});
 expect(readingPair(s,setRegion(s,none,'hairpin','hip'),{bone:null,part:'hairpin'})).toEqual({bone:'hip',relative:'bun'});
 expect(readingPair(s,none,{bone:null,part:'shoes'})).toBeNull();expect(readingPair(s,none,{bone:0,part:null})).toEqual({bone:'hip',relative:'root'});expect(readingPair(s,none,{bone:5,part:null})).toBeNull();
});
