import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {frontRoute} from '../src/front.ts';
import {applyConfigPatch,assertOpNames,CONFIG_PATCH_SCHEMA,jsonDiff,type ConfigPatch,type JsonValue} from '../src/config-patch.ts';
import {anchorAt,boneAnchors,boneOps,bonesApplyEnabled,compareOrigins,configBones,dragAnchor,draftEdits,draftText,movedRows,proposeLines,setAnchor,type BoneEdit} from '../src/bone-anchors.ts';
import {BONES_SOURCE_UNAVAILABLE,type BonesCheckResult} from '../src/bones-check.ts';
import {cropWorldMapping} from '../src/chest-regions.ts';
import {canvasToCrop} from '../web/chest-editor.ts';
import {hitAnchor,anchorLines} from '../web/bones-panel.ts';
import {patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

/** The real config's `bones` shapes: single bones (one with a tip), a chain with integer points and one with decimals. */
const bones=[
 {name:'hip',parent:'root',at:[416,620]},
 {name:'chest',parent:'hip',at:[416,442]},
 {name:'bun',parent:'chest',at:[413,127],tip:[413,193]},
 {chain:'bang_r',parent:'chest',points:[[387,111],[378,139]],tip:[371,174]},
 {chain:'ribbon_r_',parent:'hip',points:[[382.7,456.0],[378.0,546.0]],tip:[376.0,726.0],note:'a cord'},
];
const config={key:'k',bones,constraints:[]};
const LINT='LINT hip at [416, 430] is not below chest at [416, 442]: the hip must have the larger y, or breathing and the skirt hang from the shoulders';
const TIP='  FAIL  RIG_TIP_DISTINCT: config.bones[2] "bun".tip — is [413, 127], the bone\'s own origin; a bone is turned from its origin towards its tip (issue #239), and a tip on the origin has no direction — give a tip other than [413, 127], or leave the tip out (see rig-parts guide RIG_TIP_DISTINCT)';
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');

/**
 * Stand-ins. `rig-parts rig` copies <parts>/rig (a single bone whose tip is its origin is refused with RIG_TIP_DISTINCT);
 * `check` writes check.json; `propose --from-config` prints a LINT line when hip is not below chest, the count line and
 * one coverage line per bone, and exits 1 on any LINT; `compare` prints each named bone's origin distance (3 places) and
 * the origin summary. `rigc build` writes a model.
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,a.join(' ')+'\\n');
const bonesOf=p=>{const out={};for(const [i,b] of (JSON.parse(fs.readFileSync(p,'utf8')).bones||[]).entries()){if(b.name)out[b.name]={at:b.at,tip:b.tip,i};else (b.points||[]).forEach((pt,k)=>out[b.chain+k]={at:pt,i});}return out;};
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(f('--config'),'utf8'));
 for(const [i,b] of cfg.bones.entries())if(b.tip&&b.at&&b.tip[0]===b.at[0]&&b.tip[1]===b.at[1]){console.log('[rig] reading');console.log(${JSON.stringify(TIP)}.replace('[2]','['+i+']'));console.log('refused: 1 problem(s)');process.exit(1);}
 const out=f('--out'),src=path.join(f('--parts'),'rig');fs.mkdirSync(out,{recursive:true});
 for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));
 if(process.env.FAKE_PERTURB)fs.writeFileSync(path.join(out,'rig.json'),'{"perturbed":true}');
 console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
if(a[0]==='propose'){const b=bonesOf(f('--from-config'));fs.mkdirSync(path.join(f('--out'),'render'),{recursive:true});
 console.log('wrote '+f('--out')+'/render/landmarks_config.png (+_head)');const lint=b.hip.at[1]<=b.chest.at[1];
 if(lint)console.log('LINT hip at ['+b.hip.at.join(', ')+'] is not below chest at ['+b.chest.at.join(', ')+']: the hip must have the larger y, or breathing and the skirt hang from the shoulders');
 console.log((lint?1:0)+' LINT line(s) over 0 mesh(es) and the hip');for(const n of Object.keys(b))console.log('coverage '+n+' [deforms]: checked, '+(lint&&n==='hip'?'LINT':'clean')+' — read by hip-not-below-chest');
 console.log('coverage: '+Object.keys(b).length+' bone(s)');process.exit(lint?1:0);}
if(a[0]==='compare'){const l=bonesOf(f('--left')),r=bonesOf(f('--right'));let max=0,at='-';
 console.log('rig-parts compare: left '+f('--left')+', right '+f('--right')+', no map');
 for(const n of Object.keys(l)){const d=Math.hypot(r[n].at[0]-l[n].at[0],r[n].at[1]-l[n].at[1]);if(d>max){max=d;at=n;}
  const tip=l[n].tip?' · tip '+Math.hypot(r[n].tip[0]-l[n].tip[0],r[n].tip[1]-l[n].tip[1]).toFixed(3)+' px':' · tip, length, direction SKIP (left: states no tip; right: states no tip)';
  console.log('  '+n+': origin '+d.toFixed(3)+' px · parent same: x'+tip);}
 console.log('  origin: '+Object.keys(l).length+' measured, max '+max.toFixed(3)+' px ('+at+'), 0 SKIP');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
if(process.env.FAKE_LOG)fs.appendFileSync(process.env.FAKE_LOG,'rigc '+a.join(' ')+'\\n');
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}]}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
async function install(root:string){
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
}
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-bones-'))),pkg=join(root,'pkg');
 await mkdir(join(pkg,'rig/out/rig'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});await mkdir(join(pkg,'rig/inputs'),{recursive:true});await mkdir(join(pkg,'layers/full'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(pkg,'rig/out/rig',name),'{}');
 await writeFile(join(pkg,'rig/inputs/painting.png'),'png');await writeFile(join(pkg,'layers/full/layers.json'),'{}');
 await writeFile(join(pkg,'motion.json'),'{}');await install(root);
 return {root,pkg,state:join(root,'state'),log:join(root,'calls.log')};
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const declared=(pkg:string)=>({config:join(pkg,'rig/config.json'),source:join(pkg,'rig/inputs/painting.png'),full:join(pkg,'layers/full')});
const postCheck=(base:string,body:unknown,origin=base)=>fetch(base+'/api/bones-check',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const postPatch=(base:string,patch:ConfigPatch)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({patch})});
async function settle(base:string,job:{id:string;status:string}):Promise<PatchJobView>{let current=job as PatchJobView;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const patchFor=(configSha:string,ops:ConfigPatch['ops']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.42.0'},op:{cmd:'rig',args:[]}});
/** The pending edit a drag of `px` canvas pixels makes on one anchor, through a camera at `scale` and the crop mapping. */
function dragOn(path:string,dx:number,dy:number,scale:number){
 const anchors=boneAnchors(configBones(bones).bones),anchor=anchors.find(a=>a.path===path)!;
 const mapping=cropWorldMapping({x:-416,y:0,width:832,height:1216},{x:0,y:0});if(!mapping.available)throw new Error(mapping.reason);
 const project=(x:number,y:number)=>({x:300+x*scale,y:700-y*scale}),world=mapping.toWorld(...anchor.value),at=project(world.x,world.y);
 const start=canvasToCrop(project,mapping.toWorld,at)!,now=canvasToCrop(project,mapping.toWorld,{x:at.x+dx,y:at.y+dy})!;
 // The drag starts on the drawn handle.
 expect(hitAnchor([{path,at}],{x:at.x+2,y:at.y-2})).toBe(path);
 return {anchors,anchor,edits:setAnchor(new Map(),anchor,dragAnchor(anchor.value,start,now))};
}

test('the config bones read as anchors: a bone\'s at and tip, a chain\'s points and tip, each at its JSON Pointer; a chain is named by its chain',()=>{
 const read=configBones([...bones,{parent:'x',at:[1,2]},{name:'bad',at:[1]}]);
 expect(read.skipped).toEqual(['bones[5] names no bone (no name or chain)','bones[6] "bad" holds a point that is not [x, y]']);
 const anchors=boneAnchors(read.bones);
 expect(anchors.map(a=>`${a.path} ${a.label}`)).toEqual(['/bones/0/at hip','/bones/1/at chest','/bones/2/at bun','/bones/2/tip bun tip','/bones/3/points/0 bang_r0','/bones/3/points/1 bang_r1','/bones/3/tip bang_r tip','/bones/4/points/0 ribbon_r_0','/bones/4/points/1 ribbon_r_1','/bones/4/tip ribbon_r_ tip']);
 expect(anchorLines(read.bones,path=>anchors.find(a=>a.path===path)?.value??null).map(l=>`${l.from}→${l.to}`)).toEqual(['413,127→413,193','387,111→378,139','378,139→371,174','382.7,456→378,546','378,546→376,726']);
 // A chain op names the chain; the handoff config's entry at that index must hold it.
 expect(()=>assertOpNames(config as unknown as JsonValue,[{op:'replace',path:'/bones/3/points/0',value:[1,2],name:'bang_r'}])).not.toThrow();
 expect(()=>assertOpNames(config as unknown as JsonValue,[{op:'replace',path:'/bones/3/points/0',value:[1,2],name:'bang_l'}])).toThrow('EDIT_PATCH_NAME_MISMATCH');
 // The draft keeps pending edits while the anchor still holds the value they were made from.
 const {anchors:all,edits}=dragOn('/bones/1/at',14,0,2);
 expect([...draftEdits(draftText(edits),all).values()]).toEqual([...edits.values()]);
 expect(draftEdits(draftText(edits),boneAnchors(configBones(bones.map((b,i)=>i===1?{...b,at:[400,442]}:b)).bones)).size).toBe(0);
});

test('bar 1: dragging an origin by N rig px writes exactly that delta at /bones/<i>/at, and nothing else of the config changes',()=>{
 // N = 7 at a camera scale of 2 (14 canvas px) and of 0.37 (2.59 canvas px), plus sub-pixel jitter that rounds away.
 for(const [dx,scale] of [[14,2],[2.59,.37],[14.6,2]] as const){
  const {anchor,edits}=dragOn('/bones/1/at',dx,0,scale),ops=boneOps(edits);
  expect(ops).toEqual([{op:'replace',path:'/bones/1/at',value:[423,442],name:'chest'}]);
  const patched=applyConfigPatch(config as unknown as JsonValue,ops) as unknown as typeof config;
  expect(jsonDiff(config,patched)).toEqual(['/bones/1/at/0']);
  expect(anchorAt(anchor,edits)[0]-anchor.value[0]).toBe(7);
 }
 // A chain point and a tip move the same way (canvas up is rig y down: -7); a value the config writes with decimals keeps them.
 expect(boneOps(dragOn('/bones/4/points/0',0,-14,2).edits)).toEqual([{op:'replace',path:'/bones/4/points/0',value:[382.7,449],name:'ribbon_r_'}]);
 expect(boneOps(dragOn('/bones/4/points/0',14,0,2).edits)[0]!.value).toEqual([389.7,456]);
 // Sub-pixel jitter on a decimal value: the delta is snapped (7.3 → 7), not the sum (390.0).
 expect(boneOps(dragOn('/bones/4/points/0',14.6,0,2).edits)[0]!.value).toEqual([389.7,456]);
 expect(boneOps(dragOn('/bones/3/tip',-6,0,2).edits)).toEqual([{op:'replace',path:'/bones/3/tip',value:[368,174],name:'bang_r'}]);
 // Dragging back onto the config's value removes the pending op.
 expect(dragOn('/bones/1/at',0.8,0,2).edits.size).toBe(0);
});

test('bar 1 (server): Check runs propose --from-config and compare on a scratch copy of the patched config; compare reports the moved origin\'s distance',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const before=await treeMd5(pkg),p=await loadReview(pkg,{handoff:declared(pkg)}),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const configHash=sha(await readFile(join(pkg,'rig/config.json'))),ops=[{op:'replace',path:'/bones/1/at',value:[423,442],name:'chest'}];
  const response=await postCheck(base,{ops,configHash});expect(response.status).toBe(200);
  const result=await response.json() as BonesCheckResult;
  expect(result.propose).toMatchObject({status:'ran',exitCode:0,lint:[],summary:'0 LINT line(s) over 0 mesh(es) and the hip'});
  expect(result.propose.coverage).toHaveLength(8);
  expect(result.compare.origins.find(r=>r.bone==='chest')).toEqual({bone:'chest',distance:7,tip:null,text:'chest: origin 7.000 px · parent same: x · tip, length, direction SKIP (left: states no tip; right: states no tip)'});
  expect(movedRows(result.compare.origins).map(r=>r.bone)).toEqual(['chest']);
  expect(result.compare.line).toBe('origin: 7 measured, max 7.000 px (chest), 0 SKIP');
  const calls=(await readFile(log,'utf8')).trim().split('\n');
  expect(calls[0]).toBe(`propose --parts ${join(pkg,'rig/out')} --source ${join(pkg,'rig/inputs/painting.png')} --out propose --from-config config.json`);
  expect(calls[1]).toBe(`compare --left ${join(pkg,'rig/config.json')} --right config.json`);
  // Nothing written into the package; the scratch directory is gone.
  expect(await treeMd5(pkg)).toBe(before);
  expect(await readdir(join(state,'bones-check',p.sourceHash))).toEqual([]);
  // Typed, same-origin, bounded; an op outside the Bones block's scope is malformed; a stale hash is refused by name.
  expect((await postCheck(base,{ops,configHash},'http://evil.test')).status).toBe(403);
  const outside=await postCheck(base,{ops:[{op:'remove',path:'/bones/1'}],configHash});expect(outside.status).toBe(400);expect((await outside.json()).error).toStartWith('BONES_OP_OUT_OF_SCOPE');
  expect((await postCheck(base,{ops,configHash,out:'/tmp'})).status).toBe(400);
  expect((await (await postCheck(base,{ops,configHash:'0'.repeat(64)})).json()).error).toStartWith('EDIT_PATCH_STALE');
  expect((await postCheck(base,{ops:[{...ops[0]!,name:'hip'}],configHash})).status).toBe(200);
  expect((await (await postCheck(base,{ops:[{...ops[0]!,name:'hip'}],configHash})).json()).error).toStartWith('EDIT_PATCH_NAME_MISMATCH');
  expect((await fetch(base+'/api/bones-check',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'x'.repeat(70*1024)})).status).toBe(400);
  expect(frontRoute('single','POST','/api/bones-check')).toMatchObject({mutation:true,limit:64*1024});
  expect(frontRoute('compare','POST','/api/bones-check')).toBeNull();
 }finally{delete process.env.FAKE_LOG;await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 2: a LINT line is shown and blocks nothing; a handoff without a source painting names what propose needs; a producer refusal comes back verbatim',async()=>{
 const {root,pkg,state,log}=await fixture();process.env.FAKE_LOG=log;
 const p=await loadReview(pkg,{handoff:declared(pkg)}),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const configHash=sha(await readFile(join(pkg,'rig/config.json')));
  const result=await (await postCheck(base,{ops:[{op:'replace',path:'/bones/0/at',value:[416,430],name:'hip'}],configHash})).json() as BonesCheckResult;
  expect(result.status).toBe('checked');
  expect(result.propose).toMatchObject({status:'ran',exitCode:1,lint:[LINT],summary:'1 LINT line(s) over 0 mesh(es) and the hip',line:'1 LINT line(s) over 0 mesh(es) and the hip'});
  // The page leaves Apply enabled with the LINT line on screen.
  expect(bonesApplyEnabled({busy:false,pending:1,lint:result.propose.lint})).toBe(true);
  expect(bonesApplyEnabled({busy:true,pending:1,lint:[]})).toBe(false);expect(bonesApplyEnabled({busy:false,pending:0,lint:[]})).toBe(false);
  // The bun tip dragged onto its origin: rig refuses by name, and the line is shown as the producer printed it.
  const job=await (await postPatch(base,patchFor(configHash,[{op:'replace',path:'/bones/2/tip',value:[413,127],name:'bun'}]))).json() as PatchJobView;
  const settled=await settle(base,job);
  expect(settled).toMatchObject({status:'refused',producerLine:TIP.trim(),build:null});
  expect(patchOutcomeLine(settled)).toEqual({text:TIP.trim(),error:true});
 }finally{await server.stop(true);}
 // Discovered handoff (no --source): compare still runs; propose names the missing painting.
 const q=await loadReview(pkg),again=await startServer(q,{port:0,stateDir:state,cwd:root}),url=`http://127.0.0.1:${again.port}`;
 try{
  const result=await (await postCheck(url,{ops:[{op:'replace',path:'/bones/1/at',value:[423,442],name:'chest'}],configHash:sha(await readFile(join(pkg,'rig/config.json')))})).json() as BonesCheckResult;
  expect(result.propose).toEqual({status:'unavailable',exitCode:null,wallMs:null,lint:[],summary:null,coverage:[],line:BONES_SOURCE_UNAVAILABLE});
  expect(result.compare.origins.find(r=>r.bone==='chest')?.distance).toBe(7);
 }finally{delete process.env.FAKE_LOG;await again.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 3: only a reproduced baseline lets a bones Apply rebuild the whole rig; otherwise EDIT_BASELINE_MISMATCH and rig never runs on the patch',async()=>{
 const {root,pkg,state,log}=await fixture();
 const ops=[{op:'replace' as const,path:'/bones/1/at',value:[423,442],name:'chest'}];
 try{
  process.env.FAKE_LOG=log;process.env.FAKE_PERTURB='1';
  const p=await loadReview(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
  try{
   const body=await (await postPatch(base,patchFor(sha(await readFile(join(pkg,'rig/config.json'))),ops))).json();
   expect(body).toMatchObject({status:'refused',error:'EDIT_BASELINE_MISMATCH: rig/out/rig/rig.json'});
   expect((await readFile(log,'utf8')).split('\n').filter(l=>l.startsWith('rig --config config.json'))).toEqual([]);
  }finally{await server.stop(true);}
  delete process.env.FAKE_PERTURB;await rm(log,{force:true});await rm(state,{recursive:true,force:true});
  const q=await loadReview(pkg),again=await startServer(q,{port:0,stateDir:state,cwd:root}),url=`http://127.0.0.1:${again.port}`;
  try{
   const job=await settle(url,await (await postPatch(url,patchFor(sha(await readFile(join(pkg,'rig/config.json'))),ops))).json());
   expect(job.status).toBe('built');
   expect((await readFile(log,'utf8')).split('\n').filter(l=>l.startsWith('rig --config config.json'))).toHaveLength(1);
  }finally{await again.stop(true);}
 }finally{delete process.env.FAKE_LOG;delete process.env.FAKE_PERTURB;await rm(root,{recursive:true,force:true});}
});

test('the propose and compare lines are read as printed',()=>{
 expect(proposeLines(['wrote x','  LINT a b','0 LINT line(s) over 7 mesh(es) and the hip','coverage hip [deforms]: checked, clean — read by x','coverage: 1 bone(s)'])).toEqual({lint:['LINT a b'],summary:'0 LINT line(s) over 7 mesh(es) and the hip',coverage:['coverage hip [deforms]: checked, clean — read by x','coverage: 1 bone(s)']});
 const read=compareOrigins(['  root: origin SKIP (left: …) · parent: both roots','  bun: origin 0.000 px · parent same: head · tip 66.000 px · length 66.000 -> 0','  chest: origin 7.000 px · parent same: hip · tip, length, direction SKIP','  origin: 40 measured, max 7.000 px (chest), 1 SKIP','  tip: 29 measured, max 66.000 px (bun), 12 SKIP']);
 expect(read.origins.map(r=>[r.bone,r.distance,r.tip])).toEqual([['root',null,null],['bun',0,66],['chest',7,null]]);
 expect(movedRows(read.origins).map(r=>r.bone)).toEqual(['bun','chest']);
 expect(read.summary).toEqual(['origin: 40 measured, max 7.000 px (chest), 1 SKIP','tip: 29 measured, max 66.000 px (bun), 12 SKIP']);
 const edits:Map<string,BoneEdit>=new Map();expect(boneOps(edits)).toEqual([]);
});
