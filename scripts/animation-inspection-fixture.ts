/** Reproduce #215's public getting-started input. Deliberate producer bootstrap, never a test hook. */
import {mkdir,readFile,writeFile,cp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const GUIDE='ce926769373977558da470973afb52fe7c32d7fc',INPUT='01436ee3f02c189fe1a1e9656fe62068889837f5';
const root=resolve('.review-state/215/guide-fixture'),bench=join(root,'bench'),rig=join(root,'rig'),guide=join(root,'guide');
const flags=new Set(process.argv.slice(2));const prepare=flags.has('--prepare');
const versions={parts:'1.64.0',core:'2.70.0'};
await mkdir(root,{recursive:true});await mkdir(bench,{recursive:true});await mkdir(rig,{recursive:true});await mkdir(guide,{recursive:true});
const receipt:{guide:string;input:string;versions:typeof versions;commands:{argv:string[];exit:number}[];modelSha256?:string}={guide:GUIDE,input:INPUT,versions,commands:[]};
async function run(argv:string[],cwd=rig){const p=Bun.spawn(argv,{cwd,env:{...process.env,OMP_NUM_THREADS:'4',OPENBLAS_NUM_THREADS:'4',UV_THREADPOOL_SIZE:'4',RAYON_NUM_THREADS:'4'},stdout:'inherit',stderr:'inherit'}),exit=await p.exited;receipt.commands.push({argv,exit});await writeFile(join(root,'bootstrap.json'),JSON.stringify(receipt,null,2)+'\n');if(exit!==0)throw new Error('Producer bootstrap command failed: '+argv[0]+' (exit '+exit+')');}
async function download(url:string,file:string){const r=await fetch(url);if(!r.ok)throw new Error('Download failed '+r.status);await writeFile(file,new Uint8Array(await r.arrayBuffer()));}
await writeFile(join(bench,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@rig-c/parts':versions.parts,'rig-c':versions.core}}));
await run(['bun','install','--cache-dir',join(root,'cache'),'--backend','copyfile'],bench);
const parts=join(bench,'node_modules/.bin/rig-parts'),core=join(bench,'node_modules/.bin/rigc');
// Read the actual installed signatures before calling any adapter below.
for(const argv of [[parts,'--help'],[core,'--help']])await run(argv);
await download(`https://codeload.github.com/rig-c/exam/tar.gz/${INPUT}`,join(root,'inputs.tar.gz'));
await run(['tar','-xzf',join(root,'inputs.tar.gz'),'--strip-components=3',`exam-${INPUT}/tasks/01-build/inputs`]);
await run(['tar','-xzf',join(root,'inputs.tar.gz'),'--strip-components=1',`exam-${INPUT}/LICENSE`,`exam-${INPUT}/NOTICE.md`]);
await rm(join(root,'inputs.tar.gz'));
for(const name of ['hello.ts','take.ts'])await download(`https://raw.githubusercontent.com/rig-c/getting-started/${GUIDE}/scripts/${name}`,join(guide,name));
const joints=await (await fetch(`https://raw.githubusercontent.com/rig-c/getting-started/${GUIDE}/docs/KEYPOINTS.md`)).text(),json=joints.match(/```json\s*([\s\S]*?)```/);if(!json)throw new Error('Pinned hand-placed joint input absent');
await writeFile(join(rig,'keypoints.json'),JSON.stringify(JSON.parse(json[1]!),null,1)+'\n');
await writeFile(join(rig,'config.json'),JSON.stringify({key:'getting-started',seethrough:{resolution:1024,steps:30,seed:42,offload:true},assemble:{rig_scale:.5}},null,2)+'\n');
for(const p of ['inputs/painting.png','inputs/layers/full/layers.json','inputs/layers/head/layers.json','keypoints.json','config.json'])await readFile(join(rig,p));
if(prepare){console.log('BOOTSTRAP_PREPARED: pinned inputs and actual producer help read; no producer solve run');process.exit(0);}
await run([parts,'inputs','--source','inputs/painting.png','--config','config.json','--out','work']);
async function capture(argv:string[],file:string){const p=Bun.spawn(argv,{cwd:rig,stdout:'pipe',stderr:'inherit'}),text=await new Response(p.stdout).text(),exit=await p.exited;receipt.commands.push({argv,exit});if(exit)throw new Error('Producer capture failed '+exit);await writeFile(join(rig,file),text);}
await capture([parts,'propose','--head-box','--full','inputs/layers/full','--canvas','1664x2432'],'head-box.log');
const lines=(await readFile(join(rig,'head-box.log'),'utf8')).trim().split('\n');await writeFile(join(rig,'head-box.json'),lines.at(-1)!+'\n');
await run(['bun',join(guide,'take.ts'),'head-box.json','config.json','seethrough.head_box=head_box']);
await run([parts,'inputs','--source','inputs/painting.png','--config','config.json','--out','work']);
await capture([parts,'assemble','--propose-plan','--source','inputs/painting.png','--full','inputs/layers/full','--head','inputs/layers/head','--config','config.json'],'plan.json');
await run(['bun',join(guide,'take.ts'),'plan.json','config.json','assemble.plan=plan','assemble.extend_below_crop=extend_below_crop']);
await run([parts,'assemble','--source','inputs/painting.png','--full','inputs/layers/full','--head','inputs/layers/head','--config','config.json','--out','work']);
await run([parts,'propose','--parts','work/rig','--source','inputs/painting.png','--out','work','--keypoints','keypoints.json']);
await run(['bun',join(guide,'take.ts'),'work/proposal.json','config.json','bones','meshes','regions','motion','limbs']);
const build=[parts,'build','--config','config.json','--source','inputs/painting.png','--full','inputs/layers/full','--head','inputs/layers/head','--out','out','--loop'];
await run(build);
await run(['bun',join(guide,'hello.ts'),'out/rig/rig.json']);
await writeFile(join(rig,'hello-from.json'),JSON.stringify({animations_from:'hello.anim.json'}));
await run(['bun',join(guide,'take.ts'),'hello-from.json','config.json','motion.animations_from=animations_from']);
await run(build);
const pkg=join(root,'package');await mkdir(pkg,{recursive:true});await cp(join(rig,'out/check/build'),join(pkg,'build'),{recursive:true});
await cp(join(rig,'out/rig/motion.json'),join(pkg,'motion.json'));for(const file of ['LICENSE','NOTICE.md'])await cp(join(rig,file),join(pkg,file));
await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'getting-started',title:'Getting started · hello',revision:GUIDE,model:'build/skeleton.model.json',motion:'motion.json',animations:[{id:'hello',label:'Hello'}],authoring:[{label:'Input license',path:'LICENSE'},{label:'Input attribution',path:'NOTICE.md'}]},null,2)+'\n');
receipt.modelSha256=createHash('sha256').update(await readFile(join(pkg,'build/skeleton.model.json'))).digest('hex');await writeFile(join(root,'bootstrap.json'),JSON.stringify(receipt,null,2)+'\n');console.log('BOOTSTRAP_FROZEN '+receipt.modelSha256);
// Keep the reusable checked package and small receipt; intermediate producer files are reproducible.
await rm(join(rig,'out'),{recursive:true,force:true});await rm(join(rig,'work'),{recursive:true,force:true});await rm(join(rig,'inputs'),{recursive:true,force:true});await rm(join(root,'cache'),{recursive:true,force:true});await rm(bench,{recursive:true,force:true});
