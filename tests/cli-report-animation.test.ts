import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const roots:string[]=[],children:Bun.Subprocess[]=[];
afterEach(async()=>{for(const child of children.splice(0)){child.kill();await child.exited;}for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
/** A folder-adapter output whose model lists idle before dance, as producer outputs do. */
async function producer(root:string,name:string,animation?:string){const dir=join(root,name);await mkdir(dir);await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(dir,'build'),{recursive:true});await cp(join(import.meta.dir,'fixtures/strip-probe/motion.json'),join(dir,'motion.json'));
 const modelPath=join(dir,'build/skeleton.model.json'),model=JSON.parse(await readFile(modelPath,'utf8')),clip=model.animations[0];model.animations=[{...clip,name:'idle'},{...clip,name:'dance'}];model.editorOrder.animations=['idle','dance'];await writeFile(modelPath,JSON.stringify(model));
 if(animation!==undefined)await writeFile(join(dir,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation,frameTimes:[0,.5,1]}));return dir;}
async function fixture(){const root=await realpath(await mkdtemp(join(tmpdir(),'review-cli-report-')));roots.push(root);const reference=join(root,'original.mov');await cp(join(import.meta.dir,'fixtures/strip-probe/reference.mov'),reference);return {root,reference,state:join(root,'state')};}
async function run(args:string[],state:string){const child=Bun.spawn([process.execPath,'src/cli.ts',...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}
/** Serve through the legacy `review <dir>` path and read what the page receives on first load. */
async function serve(args:string[],state:string){const child=Bun.spawn([process.execPath,'src/cli.ts',...args,'--port','0'],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'});children.push(child);
 const reader=child.stdout.getReader(),decoder=new TextDecoder();let out='';while(!/Review ready: (\S+)/.test(out)){const {value,done}=await reader.read();if(done)throw new Error(`exited: ${await new Response(child.stderr).text()}`);out+=decoder.decode(value);}
 const origin=new URL(/Review ready: (\S+)/.exec(out)![1]!).origin;return (await (await fetch(origin+'/api/review')).json()) as {initialAnimation:string|null};}
test('legacy review starts on the only report animation; --animation keeps precedence; no report keeps the catalog default',async()=>{
 const f=await fixture(),dance=await producer(f.root,'dance','dance'),plain=await producer(f.root,'plain');
 expect((await serve([dance],f.state)).initialAnimation).toBe('dance');
 expect((await serve([dance,'--animation','idle'],f.state)).initialAnimation).toBe('idle');
 expect((await serve([plain],f.state)).initialAnimation).toBeNull();
},30000);
test('legacy review refuses a report animation the model lacks, by name',async()=>{
 const f=await fixture(),absent=await producer(f.root,'absent','absent'),result=await run([absent],f.state);
 expect(result.exit).toBe(1);expect(result.stderr).toContain('model has no animation "absent"');
},30000);
test('legacy compare takes a shared report animation, refuses conflicts, and still requires --animation without reports',async()=>{
 const f=await fixture(),a=await producer(f.root,'a','dance'),b=await producer(f.root,'b','dance'),idle=await producer(f.root,'idle','idle'),plainA=await producer(f.root,'plain-a'),plainB=await producer(f.root,'plain-b');
 const agreed=await run(['check','compare',a,b,'--reference',f.reference],f.state);expect(agreed.exit).toBe(0);expect(agreed.stdout).toContain('Animation: dance');expect(agreed.stderr).toContain('animation: dance (from report.json)');
 const explicit=await run(['check','compare',a,b,'--reference',f.reference,'--animation','idle'],f.state);expect(explicit.exit).toBe(0);expect(explicit.stdout).toContain('Animation: idle');
 const conflict=await run(['check','compare',a,idle,'--reference',f.reference],f.state);expect(conflict.exit).toBe(1);expect(conflict.stderr).toContain('conflicting report animations');
 const none=await run(['check','compare',plainA,plainB,'--reference',f.reference],f.state);expect(none.exit).toBe(1);expect(none.stderr).toContain('--reference and --animation are required');
},30000);
