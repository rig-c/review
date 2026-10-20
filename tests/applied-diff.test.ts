import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {CONFIG_PATCH_SCHEMA,patchSha256,type ConfigPatch} from '../src/config-patch.ts';
import {appliedSummary,filesDiffText,parseAppliedContext,type FilesDiff} from '../src/applied-context.ts';
import {firstDifference,producerDiff} from '../src/baseline.ts';
import {PRODUCER_DOCUMENTS} from '../src/producer-files.ts';
import {validatePackageFeedback} from '../src/session.ts';
import {formatFeedbackIssues} from '../src/feedback-export.ts';
import {patchAppliedRecord,patchOutcomeLine,type PatchJobView} from '../web/rebuild-client.ts';

/**
 * #125: the applied-state diff reads every document the producer writes. Stand-ins: `rig-parts rig` copies <parts>/rig
 * (documents and images) and writes motion.json from the config's `motion.tracks`; `remesh` copies the inspected rig and
 * rewrites the part's mesh in rig.json and its mesh_report.json entry, images untouched (what the real 1.42.0 remesh did
 * live on the real package, #125 report); `check` and `rigc build` as in #102.
 */
const tracks=[{bone:'head',prop:'rotate',amp:0.9,period:1,phase:0.12},{bone:'bun',prop:'rotate',amp:0.5,period:1,phase:0}];
const config={motion:{tracks},constraints:[],meshes:{topwear:{contour:{spacing:28}}}};
const inspected={
 'rig.json':JSON.stringify({bones:[{name:'head'},{name:'bun'}]}),
 'motion.json':JSON.stringify({tracks}),
 'sets.json':JSON.stringify({sets:[{name:'base'}]}),
 'mesh_report.json':JSON.stringify({parts:{topwear:{vertices:178,triangles:296}}}),
};
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
if(a[0]==='rig'){const cfg=JSON.parse(fs.readFileSync(path.resolve(f('--config')),'utf8')),out=f('--out');copy(path.join(f('--parts'),'rig'),out);
 fs.writeFileSync(path.join(out,'motion.json'),JSON.stringify({tracks:cfg.motion.tracks}));console.log('rig-parts rig: wrote rig.json under '+out);process.exit(0);}
if(a[0]==='remesh'){const out=f('--out'),part=f('--part'),entry=JSON.parse(fs.readFileSync(f('--mesh'),'utf8'));copy(f('--rig'),out);
 const report=JSON.parse(fs.readFileSync(path.join(out,'mesh_report.json'),'utf8'));report.parts[part]={vertices:Math.round(5000/entry.contour.spacing),triangles:Math.round(8300/entry.contour.spacing)};
 fs.writeFileSync(path.join(out,'mesh_report.json'),JSON.stringify(report));
 const rig=JSON.parse(fs.readFileSync(path.join(out,'rig.json'),'utf8'));rig.skins={default:{[part]:{triangles:report.parts[part].triangles}}};fs.writeFileSync(path.join(out,'rig.json'),JSON.stringify(rig));
 fs.writeFileSync(path.join(out,'remesh.json'),JSON.stringify({request:{page_edges:'free',pack_shape:'polygon'}}));console.log('rig-parts remesh: wrote');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({gate_spine_html_green:true,PASS:true}));console.log('check: PASS; 0 of 0 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],motion:fs.readFileSync(f('--motion'),'utf8')}));
fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
async function fixture(){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-applied-diff-'))),pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify(config,null,1));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 for(const [name,text] of Object.entries(inspected))await writeFile(join(rig,name),text);
 for(const name of ['topwear.png','head.png','bun.png'])await writeFile(join(rig,'images',name),`png-${name}`);
 await writeFile(join(pkg,'motion.json'),'{}');
 await mkdir(join(root,'node_modules/@rig-c/parts/bin'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(root,'node_modules/@rig-c/parts/package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.42.0',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(root,'node_modules/@rig-c/parts/bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 return {root,pkg,rig,state:join(root,'state')};
}
async function treeMd5(dir:string):Promise<string>{const hash=createHash('md5');const walk=async(d:string)=>{for(const e of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:1)){const full=join(d,e.name);if(e.isDirectory())await walk(full);else{hash.update(relative(dir,full));hash.update(await readFile(full));}}};await walk(dir);return hash.digest('hex');}
const sha=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
const patchFor=(configSha:string,ops:ConfigPatch['ops'],op:ConfigPatch['op']={cmd:'rig',args:['--idle-keys','ctl']}):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.42.0'},op});
async function settle(base:string,job:{id:string;status:string}):Promise<PatchJobView>{let current=job as PatchJobView;for(let i=0;current.status==='running'&&i<400;i++){await Bun.sleep(25);current=await (await fetch(`${base}/api/rebuild/${current.id}`)).json();}return current;}
const post=(base:string,body:unknown)=>fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
const doc=(files:FilesDiff,file:string)=>files.documents.find(d=>d.file===file);

test('bar 1: a motion-only patch names motion.json and its paths; rig.json, sets.json and mesh_report.json are unchanged; images by hash',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const patch=patchFor(sha(await readFile(join(pkg,'rig/config.json'))),[{op:'replace',path:'/motion/tracks/0/amp',value:2},{op:'replace',path:'/motion/tracks/0/phase',value:0.3}]);
  const job=await settle(base,await (await post(base,{patch})).json());
  expect(job.status).toBe('built');
  expect(job.files).toEqual({documents:[{file:'rig.json',count:0,paths:[]},{file:'motion.json',count:2,paths:['/tracks/0/amp','/tracks/0/phase']},{file:'sets.json',count:0,paths:[]},{file:'mesh_report.json',count:0,paths:[]}],images:{changed:0,unchanged:3,names:[]}});
  // rig.json's own entry is still `diff`, for older readers.
  expect(job.diff).toEqual({count:0,paths:[]});
  expect(job.lines).toContain('review: against the inspected rig — motion.json differs at 2 path(s) · rig.json, sets.json, mesh_report.json unchanged · 3 images unchanged');
  expect(job.lines).toContain('review: motion.json: /tracks/0/amp, /tracks/0/phase');
  expect(patchOutcomeLine(job).text).toContain(' · check PASS · motion.json differs at 2 path(s) · rig.json, sets.json, mesh_report.json unchanged · 3 images unchanged · Reset returns to the inspected build');
  const applied=patchAppliedRecord(job);expect(applied.files).toEqual(job.files);expect(()=>parseAppliedContext(applied)).not.toThrow();
  expect(await treeMd5(pkg)).toBe(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('bar 2 (stand-in producer): a mesh-only remesh names mesh_report.json paths beside rig.json\'s; motion.json, sets.json and the images unchanged',async()=>{
 const {root,pkg,state}=await fixture();
 const p=await loadReview(pkg),before=await treeMd5(pkg),server=await startServer(p,{port:0,stateDir:state,cwd:root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const patch=patchFor(sha(await readFile(join(pkg,'rig/config.json'))),[{op:'replace',path:'/meshes/topwear/contour/spacing',value:20}],{cmd:'remesh',args:['--part','topwear']});
  const job=await settle(base,await (await post(base,{patch})).json());
  expect(job.status).toBe('built');
  expect(doc(job.files!,'mesh_report.json')).toEqual({file:'mesh_report.json',count:2,paths:['/parts/topwear/triangles','/parts/topwear/vertices']});
  expect(doc(job.files!,'rig.json')).toEqual({file:'rig.json',count:1,paths:['/skins']});expect(job.diff).toEqual({count:1,paths:['/skins']});
  for(const file of ['motion.json','sets.json'])expect(doc(job.files!,file)!.count).toBe(0);
  expect(job.files!.images).toEqual({changed:0,unchanged:3,names:[]});
  expect(patchOutcomeLine(job).text).toContain('rig.json differs at 1 path(s) · mesh_report.json differs at 2 path(s) · motion.json, sets.json unchanged · 3 images unchanged');
  expect(await treeMd5(pkg)).toBe(before);
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('producerDiff: a document one side lacks differs at "" (the whole document); one neither side has is left out; non-JSON compares bytes',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-applied-diff-unit-'))),a=join(root,'a'),b=join(root,'b');
 try{
  for(const d of [a,b])await mkdir(join(d,'images'),{recursive:true});
  await writeFile(join(a,'rig.json'),'{"x":1}');await writeFile(join(b,'rig.json'),'{"x":1}');
  await writeFile(join(b,'motion.json'),'{}');
  await writeFile(join(a,'sets.json'),'not json');await writeFile(join(b,'sets.json'),'not json');
  await writeFile(join(a,'images/p.png'),'1');await writeFile(join(b,'images/q.png'),'1');await writeFile(join(b,'remesh.json'),'{}');
  expect(await producerDiff(a,b)).toEqual({documents:[{file:'rig.json',count:0,paths:[]},{file:'motion.json',count:1,paths:['']},{file:'sets.json',count:0,paths:[]}],images:{changed:2,unchanged:0,names:['images/p.png','images/q.png']}});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('one list: the baseline compares sets.json because the applied diff does (PRODUCER_DOCUMENTS)',()=>{
 expect(PRODUCER_DOCUMENTS).toEqual(['rig.json','motion.json','sets.json','mesh_report.json']);
 const same={'rig.json':'a','motion.json':'b','mesh_report.json':'c','images/p.png':'d'};
 expect(firstDifference(same,{...same,'sets.json':'e','NOTES.md':'x'})).toBe('sets.json');
 expect(firstDifference(same,{...same,'NOTES.md':'x'})).toBeNull();
});

test('context.applied: older v2 records without files stay valid; files is exactly its shape; the summary and export print it per file',()=>{
 const patch=patchFor('f'.repeat(64),[{op:'replace',path:'/motion/tracks/0/amp',value:2}]);
 const older={schema:'rig-review-applied/2',buildId:'d'.repeat(64),patch,patchSha256:patchSha256(patch),configHash:'f'.repeat(64),producer:{package:'@rig-c/parts',version:'1.42.0'},compiler:{package:'rig-c',version:'2.64.1'},line:'rig-parts rig: wrote',check:null,diff:{count:0,paths:[]},modelHash:'e'.repeat(64)};
 const files:FilesDiff={documents:[{file:'rig.json',count:0,paths:[]},{file:'motion.json',count:2,paths:['/tracks/0/amp','/tracks/0/phase']}],images:{changed:0,unchanged:31,names:[]}};
 const record={...older,files};
 for(const ok of [older,record,{...older,files:null}])expect(()=>parseAppliedContext(ok)).not.toThrow();
 for(const [bad,message] of [
  [{...older,files:{documents:[]}},'files: expected exactly'],
  [{...older,files:{...files,documents:[{file:'notes.json',count:0,paths:[]}]}},'files.documents[0].file'],
  [{...older,files:{...files,documents:[files.documents[0],files.documents[0]]}},'files.documents[1].file'],
  [{...older,files:{...files,documents:[{file:'motion.json',count:1,paths:['/a','/b']}]}},'files.documents[0]'],
  [{...older,files:{...files,images:{changed:0,unchanged:1,names:['images/x.png']}}},'files.images'],
 ] as const)expect(()=>parseAppliedContext(bad)).toThrow(message);
 expect(filesDiffText(files)).toBe('motion.json differs at 2 path(s) · rig.json unchanged · 31 images unchanged');
 expect(appliedSummary(older)).toContain(' · check not run · rig.json differs at 0 path(s) · model ');
 expect(appliedSummary(record)).toContain(' · check not run · motion.json differs at 2 path(s) · rig.json unchanged · 31 images unchanged · model ');
 const p={feedbackCatalog:{rig:'r',bones:[],slots:[],animations:null,clock:null,clockAnimation:null}} as never;
 const note=(applied:unknown)=>({id:'n',frameStart:0,frameEnd:0,target:{kind:'rig' as const,name:'r'},category:'quality' as const,summary:'s',context:{applied} as never});
 for(const applied of [older,record])expect(()=>validatePackageFeedback(note(applied),p)).not.toThrow();
 const session={schema:'rig-review-session/1',id:'r',revision:'1',sourceHash:'s'.repeat(64),reviewedSource:{packageRevision:'1',viewerVersion:'0',runtimeVersion:'0',rig:null,motion:null},status:'pending',checkpoints:{},feedback:[validatePackageFeedback(note(record),p)],feedbackWarnings:[],updatedAt:null};
 expect(formatFeedbackIssues(session as never)).toContain('motion&#46;json differs at 2 path&#40;s&#41; · rig&#46;json unchanged · 31 images unchanged');
});
