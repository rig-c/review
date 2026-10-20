import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {resolveHandoff,HandoffError} from '../src/handoff.ts';
import {CONFIG_PATCH_SCHEMA,type ConfigPatch} from '../src/config-patch.ts';
import {parseAppliedContext,appliedSummary} from '../src/applied-context.ts';
import {patchAppliedRecord,type PatchJobView} from '../web/rebuild-client.ts';

/**
 * #111: a cloth recipe Apply with stand-in producers. `rig-parts propose` logs its argv, refuses a "back hair" recipe
 * as the real one does on a bun-only figure (PROPOSE_CLOTH_DRAFTED), and otherwise writes --write-config as the --cloth
 * config with constraints[0].wind set to the bottomwear recipe's links (links 99: `key` changed too, outside the drafted
 * sections). `rig` and `build` copy the handoff rig; `check` writes check.json; `rigc` writes a model.
 */
const fakeParts=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
fs.appendFileSync(path.join(__dirname,'calls.log'),a.join(' ')+'\\n');
const copy=(src,out)=>{fs.mkdirSync(path.join(out,'images'),{recursive:true});for(const n of fs.readdirSync(src))if(fs.statSync(path.join(src,n)).isFile())fs.copyFileSync(path.join(src,n),path.join(out,n));for(const n of fs.readdirSync(path.join(src,'images')))fs.copyFileSync(path.join(src,'images',n),path.join(out,'images',n));};
if(a[0]==='propose'){const text=fs.readFileSync(f('--cloth'),'utf8'),cfg=JSON.parse(text);
 if(cfg.cloth['back hair']){console.log('  FAIL  PROPOSE_CLOTH_DRAFTED: config.cloth."back hair" — declares a recipe for "back hair", and every back hair part ends above the shoulders (0.5 face heights below the neck), which the proposer drafts as a bun bone with no chain; leave the recipe out (see rig-parts guide PROPOSE_CLOTH_DRAFTED)');console.log('refused: 1 problem(s)');process.exit(1);}
 const links=cfg.cloth.bottomwear.links;cfg.constraints[0].wind=links;if(links===99)cfg.key='moved';
 fs.mkdirSync(f('--out'),{recursive:true});fs.writeFileSync(f('--write-config'),JSON.stringify(cfg,null,2)+'\\n');
 console.log('wrote '+f('--write-config')+': '+f('--cloth')+"'s text with constraints[\\"c0\\"] replaced spliced in from the draft; every other byte as read");process.exit(0);}
if(a[0]==='rig'){copy(path.join(f('--parts'),'rig'),f('--out'));console.log('rig-parts rig: wrote');process.exit(0);}
if(a[0]==='build'){const out=f('--out');copy(path.join(process.env.FAKE_PARTS,'rig'),path.join(out,'rig'));fs.copyFileSync(path.join(process.env.FAKE_PARTS,'parts.json'),path.join(out,'parts.json'));fs.mkdirSync(path.join(out,'check'),{recursive:true});fs.writeFileSync(path.join(out,'check','check.json'),JSON.stringify({PASS:true,TEXTURE_STRETCH:{status:'PASS'}}));console.log('[check] check: PASS; 1 of 1 bar(s) measured');console.log('build: PASS — the packed atlas is the artifact');process.exit(0);}
if(a[0]==='check'){const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'check.json'),JSON.stringify({PASS:true,TEXTURE_STRETCH:{status:'PASS'}}));console.log('check: PASS; 1 of 1 bar(s) measured');process.exit(0);}
process.exit(3);`;
const fakeRigc=`const fs=require('fs'),path=require('path');const a=process.argv.slice(2);const f=n=>a[a.indexOf(n)+1];
const out=f('--out');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}]}));fs.writeFileSync(path.join(out,'skeleton.png'),'png');console.log('rigc: wrote');`;
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

async function fixture(options:{limbs?:boolean}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-cloth-'))),pkg=join(root,'pkg'),out=join(pkg,'out'),rig=join(out,'rig');
 await mkdir(join(rig,'images'),{recursive:true});await mkdir(join(out,'parts'),{recursive:true});await mkdir(join(pkg,'layers/full'),{recursive:true});
 const config={key:'k',cloth:{bottomwear:{chains:1,links:2,wind:[1,2],gravity:[1,2]}},bones:[{name:'hip',parent:'root',at:[10,10]},{chain:'skirt0_',parent:'hip',points:[[10,20],[10,30]],tip:[10,40]}],meshes:{skirt:{grid:8,segments:['skirt0_']}},constraints:[{type:'physics',name:'c0',bone:'skirt0_0',wind:1}],...(options.limbs?{limbs:{}}:{})};
 await writeFile(join(pkg,'config.json'),JSON.stringify(config,null,1));
 await writeFile(join(out,'parts.json'),JSON.stringify({parts:[{name:'skirt',from:'full:bottomwear'}]}));await writeFile(join(out,'parts/skirt.png'),'png-skirt');
 for(const [name,text] of Object.entries({'rig.json':'{"bones":[]}','motion.json':'{}','mesh_report.json':'{}'}))await writeFile(join(rig,name),text);
 await writeFile(join(rig,'images/skirt.png'),'png-skirt');
 await writeFile(join(pkg,'motion.json'),'{}');await writeFile(join(pkg,'painting.png'),'png-painting');await writeFile(join(pkg,'layers/full/a.png'),'png-a');
 await writeFile(join(pkg,'keypoints.json'),JSON.stringify({spec:'rig-parts-keypoints/1'}));
 const parts=join(root,'node_modules/@rig-c/parts');
 await mkdir(join(parts,'bin'),{recursive:true});await mkdir(join(parts,'src'),{recursive:true});await mkdir(join(root,'node_modules/rig-c/bin'),{recursive:true});
 await writeFile(join(parts,'package.json'),JSON.stringify({name:'@rig-c/parts',version:'1.49.1',bin:{'rig-parts':'./bin/rig-parts.cjs'}}));
 await writeFile(join(parts,'bin/rig-parts.cjs'),fakeParts);
 await writeFile(join(parts,'src/cloth.ts'),`export const CLOTH_TARGETS = ['bottomwear', 'back hair', 'front hair'] as const;\n`);
 await writeFile(join(root,'node_modules/rig-c/package.json'),JSON.stringify({name:'rig-c',version:'2.64.1',bin:{rigc:'./bin/rigc.cjs'}}));
 await writeFile(join(root,'node_modules/rig-c/bin/rigc.cjs'),fakeRigc);
 process.env.FAKE_PARTS=out;
 const calls=async()=>{try{return (await readFile(join(parts,'bin/calls.log'),'utf8')).trim().split('\n').filter(Boolean);}catch{return [] as string[];}};
 return {root,pkg,out,state:join(root,'state'),config,calls,done:()=>rm(root,{recursive:true,force:true})};
}
const flags=(f:Awaited<ReturnType<typeof fixture>>,keypoints=true)=>({config:join(f.pkg,'config.json'),parts:f.out,source:join(f.pkg,'painting.png'),full:join(f.pkg,'layers/full'),...(keypoints?{keypoints:join(f.pkg,'keypoints.json')}:{})});
const patchFor=(configSha:string,ops:ConfigPatch['ops']):ConfigPatch=>({schema:CONFIG_PATCH_SCHEMA,config_sha256:configSha,ops,producer:{name:'@rig-c/parts',version:'1.49.1'},op:{cmd:'rig',args:[]}});
async function apply(f:Awaited<ReturnType<typeof fixture>>,ops:ConfigPatch['ops'],keypoints=true){
 const p=await loadReview(f.pkg,{handoff:flags(f,keypoints)}),server=await startServer(p,{port:0,stateDir:f.state,cwd:f.root}),base=`http://127.0.0.1:${server.port}`;
 try{
  const configSha=sha(await readFile(join(f.pkg,'config.json')));
  const started=await (await fetch(base+'/api/rebuild',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({patch:patchFor(configSha,ops)})})).json() as PatchJobView&{error?:string};
  let job=started;for(let i=0;job.status==='running'&&i<400;i++){await Bun.sleep(25);job=await (await fetch(`${base}/api/rebuild/${job.id}`)).json();}
  let scratch:string[]=[];try{scratch=await readdir(join(f.state,'rebuild',p.sourceHash));}catch{/* none */}
  return {job,scratch,p};
 }finally{await server.stop(true);}
}

test('#111 Decision 1: a cloth Apply without declared keypoints is refused by name before anything runs',async()=>{
 const f=await fixture();
 try{
  const {job,scratch}=await apply(f,[{op:'replace',path:'/cloth/bottomwear/links',value:3}],false);
  expect(job.status).toBe('refused');expect((job as {error?:string}).error).toStartWith('CLOTH_KEYPOINTS_UNDECLARED: ');
  expect((await f.calls()).filter(l=>l.startsWith('propose'))).toEqual([]);expect(scratch).toEqual([]);
 }finally{await f.done();}
});

test('#111 bar 2: a recipe that drafts nothing is refused by name, verbatim, and leaves no scratch',async()=>{
 const f=await fixture();
 try{
  const {job,scratch}=await apply(f,[{op:'add',path:'/cloth/back hair',value:{links:3,wind:[1,4],gravity:[2,8]}}]);
  expect(job.status).toBe('refused');expect(job.op).toBe('cloth');
  expect(job.producerLine).toStartWith('FAIL  PROPOSE_CLOTH_DRAFTED: config.cloth."back hair" — declares a recipe for "back hair"');
  expect(job.cloth!.refusals).toEqual([job.producerLine!]);expect(job.cloth!.written).toBeNull();
  // propose ran on the handoff's parts, painting and keypoints, with the patched config and a scratch write target.
  const propose=(await f.calls()).find(l=>l.startsWith('propose'))!;
  expect(propose).toBe(`propose --parts ${f.out} --source ${join(f.pkg,'painting.png')} --keypoints ${join(f.pkg,'keypoints.json')} --out propose --cloth cloth.json --write-config config.json`);
  expect(scratch).toEqual([]);
 }finally{await f.done();}
});

test('#111 bar 1: the written config is built by rig --config when the config declares no limbs; its diff is listed and confined',async()=>{
 const f=await fixture();
 try{
  const {job}=await apply(f,[{op:'replace',path:'/cloth/bottomwear/links',value:3}]);
  expect(job.status).toBe('built');expect(job.op).toBe('cloth');expect(job.cloth!.route).toBe('rig');
  expect(job.cloth!.written).toEqual({count:1,paths:['/constraints/0/wind'],outside:[],sections:['constraints']});
  expect(job.cloth!.line).toBe(`wrote config.json: cloth.json's text with constraints["c0"] replaced spliced in from the draft; every other byte as read`);
  expect(job.cloth!.links).toEqual([{tag:'bottomwear',parts:['skirt'],chains:[{chain:'skirt0_',points:[[10,20],[10,30],[10,40]]}]},{tag:'back hair',parts:[],chains:[]},{tag:'front hair',parts:[],chains:[]}]);
  const calls=await f.calls();
  expect(calls.some(l=>l.startsWith('rig --config config.json --parts '))).toBe(true);expect(calls.some(l=>l.startsWith('build'))).toBe(false);
  expect(job.check?.pass).toBe(true);
  // The applied record carries the route, the keypoints and the written diff, and validates.
  const record=patchAppliedRecord(job);
  expect(record.cloth).toEqual({route:'rig',keypoints:{path:'keypoints.json',sha256:sha(await readFile(join(f.pkg,'keypoints.json')))},written:{count:1,paths:['/constraints/0/wind']}});
  expect(()=>parseAppliedContext(record)).not.toThrow();expect(appliedSummary(record)).toContain('propose --cloth wrote a config differing at 1 path(s), built by rig --config');
  expect(()=>parseAppliedContext({...record,cloth:undefined})).toThrow();
 }finally{await f.done();}
});

test('#111 Decision 2: a config that declares limbs builds the written config with rig-parts build',async()=>{
 const f=await fixture({limbs:true});
 try{
  const {job}=await apply(f,[{op:'replace',path:'/cloth/bottomwear/links',value:3}]);
  expect(job.status).toBe('built');expect(job.cloth!.route).toBe('build');
  const calls=await f.calls();
  expect(calls.find(l=>l.startsWith('build'))).toBe(`build --config config.json --source ${join(f.pkg,'painting.png')} --full ${join(f.pkg,'layers/full')} --out out --seam-pairs`);
  expect(()=>parseAppliedContext(patchAppliedRecord(job))).not.toThrow();expect(patchAppliedRecord(job).assembled).toBeDefined();
 }finally{await f.done();}
});

test('#111: a written config that differs outside the drafted sections is not built; a mixed patch is refused',async()=>{
 const f=await fixture();
 try{
  let {job}=await apply(f,[{op:'replace',path:'/cloth/bottomwear/links',value:99}]);
  expect(job.status).toBe('refused');expect(job.producerLine).toStartWith('CLOTH_WRITTEN_OUTSIDE_DRAFTED: the config propose wrote differs from cloth.json outside the sections it splices, at /key');
  ({job}=await apply(f,[{op:'replace',path:'/cloth/bottomwear/links',value:3},{op:'replace',path:'/constraints/0/wind',value:2}]));
  expect((job as {error?:string}).error).toStartWith('CLOTH_PATCH_MIXED: ');
 }finally{await f.done();}
});

test('#111 Decision 1: the keypoint file is hashed into the handoff identity only when declared; same path rules as --source',async()=>{
 const f=await fixture();
 try{
  const without=(await resolveHandoff(f.pkg,undefined,flags(f,false))).handoff!.record;
  // Undeclared: no keypoints key at all, and no keypoints file hashed — the record (and so the identity) is as before #111.
  expect(Object.hasOwn(without,'keypoints')).toBe(false);expect(without.files.some(x=>x.path==='keypoints.json')).toBe(false);
  expect(Object.keys(without)).toEqual(['schema','how','via','outside','config','parts','rig','source','full','head','files','missing']);
  const p=await loadReview(f.pkg,{handoff:flags(f,false)});expect(JSON.stringify(p.reviewedSource.handoff)).toBe(JSON.stringify(without));
  const declared=(await resolveHandoff(f.pkg,undefined,flags(f))).handoff!.record;
  const hash=sha(await readFile(join(f.pkg,'keypoints.json')));
  expect(declared.keypoints).toEqual({path:'keypoints.json',sha256:hash});expect(declared.files).toContainEqual({path:'keypoints.json',sha256:hash});
  // Changing the declared file's bytes changes the record; with it undeclared, the same change does not.
  await writeFile(join(f.pkg,'keypoints.json'),JSON.stringify({spec:'rig-parts-keypoints/1',moved:true}));
  expect((await resolveHandoff(f.pkg,undefined,flags(f))).handoff!.record.keypoints!.sha256).not.toBe(hash);
  expect(JSON.stringify((await resolveHandoff(f.pkg,undefined,flags(f,false))).handoff!.record)).toBe(JSON.stringify(without));
  // review.json's producer block: literal, inside the root; the same refusals as --source.
  const block=async(keypoints:string)=>resolveHandoff(f.pkg,{config:'config.json',parts:'out',keypoints},undefined);
  expect((await block('keypoints.json')).handoff!.record.keypoints?.path).toBe('keypoints.json');
  await expect(block('../keypoints.json')).rejects.toMatchObject({code:'HANDOFF_PATH_OUTSIDE_ROOT'});
  await expect(block('missing.json')).rejects.toMatchObject({code:'HANDOFF_INPUT_MISSING'});
  await writeFile(join(f.root,'outside.json'),'{}');await symlink(join(f.root,'outside.json'),join(f.pkg,'link.json'));
  await expect(block('link.json')).rejects.toMatchObject({code:'HANDOFF_SYMLINK_ESCAPE'});
  await expect(resolveHandoff(f.pkg,undefined,{...flags(f,false),keypoints:join(f.root,'outside.json')})).rejects.toBeInstanceOf(HandoffError);
  await expect(resolveHandoff(f.pkg,undefined,{keypoints:join(f.pkg,'keypoints.json')} as never)).rejects.toMatchObject({code:'HANDOFF_FLAGS_INVALID'});
 }finally{await f.done();}
});
