import {afterEach,expect,test} from 'bun:test';
import {cp,mkdir,mkdtemp,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {openReview} from '../src/open.ts';
import {createRequirementsCheck} from '../src/requirements-run.ts';
import {createReadings} from '../src/readings-run.ts';
import {canonicalStatePath,stateDirInside,stateRoots} from '../src/state-dir.ts';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function scratch(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-state-dir-')));roots.push(root);return root;}
/** A package with a compiled model and its own producer handoff (rig/config.json, rig/out/…), the requirements fixture's layout. */
async function handoffPackage(root:string){
 const pkg=join(root,'pkg'),rig=join(pkg,'rig/out/rig');
 await mkdir(pkg);await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(pkg,'build'),{recursive:true});
 await mkdir(rig,{recursive:true});await mkdir(join(pkg,'rig/out/parts'),{recursive:true});
 await writeFile(join(pkg,'rig/config.json'),JSON.stringify({key:'k'}));await writeFile(join(pkg,'rig/out/parts.json'),'{}');
 await writeFile(join(rig,'rig.json'),JSON.stringify({bones:[{name:'root'}],slots:[]}));await writeFile(join(rig,'mesh_report.json'),'{}');await writeFile(join(rig,'motion.json'),JSON.stringify({animations:{idle:{duration:1}}}));
 await writeFile(join(pkg,'motion.json'),'{}');
 return pkg;
}
/** What `rig-parts build --out <proj>/out` leaves (tests/build-root.test.ts), optionally with the producer's config beside out/. */
async function built(root:string,withConfig:boolean){
 const proj=join(root,'proj'),out=join(proj,'out');
 await mkdir(join(out,'rig'),{recursive:true});await mkdir(join(out,'parts'),{recursive:true});await mkdir(join(out,'check/build'),{recursive:true});
 if(withConfig)await writeFile(join(proj,'config.json'),JSON.stringify({key:'k'}));
 await writeFile(join(out,'parts.json'),JSON.stringify({parts:[{name:'a'}]}));await writeFile(join(out,'parts/a.png'),'png-a');
 for(const file of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(out,'rig',file),`{"${file}":1}`);
 await writeFile(join(out,'check/build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[{name:'skeleton.png'}],animations:[{name:'idle',duration:1}]}));await writeFile(join(out,'check/build/skeleton.png'),'png');
 return {proj,out,check:join(out,'check')};
}
const caught=async(run:()=>Promise<unknown>)=>run().then(()=>null,(e:unknown)=>e as Error&{code?:string});
const runnerOptions=(stateDir:string,root:string)=>({stateDir,starts:[root],unchanged:async()=>{},latest:()=>null});

test('#187 bar 1: a state directory that is a symlink into the package is refused by name before anything is written',async()=>{
 const root=await scratch(),pkg=await handoffPackage(root),p=await loadReview(pkg);
 // An outside-looking path whose last component, or an ancestor, points into the package.
 await symlink(join(pkg,'rig'),join(root,'state-link'));await symlink(pkg,join(root,'ancestor-link'));
 for(const stateDir of [join(root,'state-link'),join(root,'ancestor-link','not-yet','state')]){
  expect(canonicalStatePath(stateDir).startsWith(pkg+'/')).toBe(true);
  expect(stateDirInside(stateDir,stateRoots(p))?.kind).toBe('package');
  const requirements=createRequirementsCheck(p,runnerOptions(stateDir,root));
  const error=await caught(()=>requirements.start({fps:12,build:'inspected',requirements:[{name:'ROOT_RANGE',kind:'range',animation:'idle',bone:'root',lo_degrees:-1,hi_degrees:1}]}));
  expect(error?.code).toBe('REQUIREMENTS_STATE_INSIDE_PACKAGE');expect(error?.message).toContain('inside the inspected package');
  const readings=createReadings(p,runnerOptions(stateDir,root));
  const refused=await caught(()=>readings.start({animation:'idle',readings:[{kind:'folds'}],environment:null}));
  expect(refused?.code).toBe('READINGS_STATE_INSIDE_PACKAGE');
 }
 expect((await readdir(join(pkg,'rig'))).sort()).toEqual(['config.json','out']);expect((await readdir(pkg)).sort()).toEqual(['build','motion.json','rig']);
});

test('#187 bar 2: `open out` with RIG_REVIEW_STATE_DIR=out/.review-state is refused as inside the build root, and nothing is written',async()=>{
 const root=await scratch(),b=await built(root,false),stateDir=join(b.out,'.review-state');
 const error=await caught(()=>openReview({input:b.out},{stateDir,direct:true,idleMs:200}));
 expect(error?.message).toStartWith('OPEN_STATE_INSIDE_PACKAGE build root: ');
 expect(error?.message).toContain('outside input packages');
 const p=await loadReview(b.out);expect(p.root).toBe(b.check);expect(p.handoff).toBeNull();expect(p.buildRoot).toBe(b.out);
 // Opening check/ itself is the same package and the same refusal.
 expect((await caught(()=>openReview({input:b.check},{stateDir,direct:true,idleMs:200})))?.message).toStartWith('OPEN_STATE_INSIDE_PACKAGE build root: ');
 expect((await readdir(b.out)).sort()).toEqual(['check','parts','parts.json','rig']);
});

test('#187 bar 3: a state directory inside the handoff root (beside the opened build) is refused by name, at open and in the runners',async()=>{
 const root=await scratch(),b=await built(root,true),stateDir=join(b.proj,'review-state');
 const p=await loadReview(b.out);expect(p.handoff?.root).toBe(b.proj);
 const error=await caught(()=>openReview({input:b.out},{stateDir,direct:true,idleMs:200}));
 expect(error?.message).toStartWith('OPEN_STATE_INSIDE_PACKAGE handoff root: ');
 const requirements=createRequirementsCheck(p,runnerOptions(stateDir,root));
 const refused=await caught(()=>requirements.start({fps:12,build:'inspected',requirements:[{name:'ROOT_RANGE',kind:'range',animation:'idle',bone:'root',lo_degrees:-1,hi_degrees:1}]}));
 expect(refused?.code).toBe('REQUIREMENTS_STATE_INSIDE_PACKAGE');expect(refused?.message).toContain('inside the inspected handoff root');
 expect((await readdir(b.proj)).sort()).toEqual(['config.json','out']);
});

test('#187 bar 4: existing layouts are unchanged — the bundled demo and the LIVE_FIXTURE layout with an outside state directory',async()=>{
 const root=await scratch(),state=join(root,'state');
 const demo=await loadReview(join(import.meta.dir,'../examples/demo'));expect(demo.buildRoot).toBeUndefined();
 expect(stateDirInside(state,stateRoots(demo))).toBeNull();
 // docs/LIVE_FIXTURE.md: the package folder holds build/, config.json and out/ — it stays the package, rooted in itself.
 const b=await built(root,true);await mkdir(join(b.proj,'build'));await writeFile(join(b.proj,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[]}));
 const live=await loadReview(b.proj);expect(live.root).toBe(b.proj);expect(live.buildRoot).toBeUndefined();
 expect(stateDirInside(state,stateRoots(live))).toBeNull();
 expect(stateDirInside(join(b.proj,'state'),stateRoots(live))?.kind).toBe('package');
});

test('#192: a build root opened through the review.json in its check/ keeps its buildRoot, so state inside it is refused', async () => {
 const base = await scratch(), out = join(base, 'out'), check = join(out, 'check');
 await mkdir(join(out, 'rig'), {recursive:true}); await mkdir(join(check, 'build'), {recursive:true});
 await writeFile(join(out, 'parts.json'), '{}'); await writeFile(join(out, 'rig', 'rig.json'), '{}'); await writeFile(join(check, 'build', 'skeleton.model.json'), '{}');
 await cp(new URL('../examples/demo', import.meta.url).pathname, check, {recursive:true});
 for (const opened of [check, join(check, 'review.json')]) {
  const p = await loadReview(opened);
  expect(p.root).toBe(check);
  expect(p.buildRoot).toBe(out);
  expect(stateDirInside(canonicalStatePath(join(out, '.review-state')), stateRoots(p))).not.toBeNull();
 }
});
