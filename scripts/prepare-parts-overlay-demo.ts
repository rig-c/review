/** Reproducible public #384 visual evidence only. Explicit pinned producer; never called by the review app. */
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const parts='971b3a7fab1109adf5be11750886687a7addb306',inputs='ba99e403d4058fc1cfe40699bdcde8aaf00a90c0';
const output=resolve(process.argv[2]??'cache/parts-overlay-demo'),producer=resolve('cache/overlay-producer/node_modules/@rig-c/parts');
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function get(url:string){const res=await fetch(url,{signal:AbortSignal.timeout(90000)});if(!res.ok)throw new Error('PUBLIC_FIXTURE_FETCH '+res.status+' '+url);return Buffer.from(await res.arrayBuffer());}
const installed=JSON.parse(await readFile(join(producer,'package.json'),'utf8'));if(installed.version!=='2.17.0')throw new Error('PINNED_PRODUCER_REQUIRED');
await mkdir(output,{recursive:true});
const tree=JSON.parse((await get(`https://api.github.com/repos/rig-c/examples/git/trees/${inputs}?recursive=1`)).toString()) as {tree:{path:string;type:string;sha:string}[]};
const queue=tree.tree.filter(f=>f.type==='blob'&&(f.path==='demo/painting.png'||f.path.startsWith('demo/layers/'))),files:{path:string;gitBlob:string;sha256:string;bytes:number}[]=[];
await Promise.all(Array.from({length:4},async()=>{for(;;){const f=queue.shift();if(!f)return;const bytes=await get(`https://raw.githubusercontent.com/rig-c/examples/${inputs}/${f.path}`),blob=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(blob!==f.sha)throw new Error('PINNED_BLOB_MISMATCH '+f.path);const path=join(output,f.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);files.push({path:f.path,gitBlob:blob,sha256:hash(bytes),bytes:bytes.length});}}));
for(const name of ['config.json','requirements.json','pose.json','animations.json'])await writeFile(join(output,'demo',name),await get(`https://raw.githubusercontent.com/rig-c/parts/${parts}/examples/demo/${name}`));
const args=[process.execPath,join(producer,'cli.ts'),'assemble','--source',join(output,'demo/painting.png'),'--full',join(output,'demo/layers/full'),'--head',join(output,'demo/layers/head'),'--config',join(output,'demo/config.json'),'--out',join(output,'out')];
const start=performance.now(),child=Bun.spawn(args,{env:{...process.env},stdout:'pipe',stderr:'pipe'}),[stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]),exit=await child.exited;
await writeFile(join(output,'assemble.stdout.txt'),stdout);await writeFile(join(output,'assemble.stderr.txt'),stderr);
if(exit!==0)throw new Error('PUBLIC_DEMO_ASSEMBLE '+exit+' '+(stdout+'\n'+stderr).slice(-3000));
await copyFile(join(output,'demo/painting.png'),join(output,'out/rig/painting.png'));
const metadata=JSON.parse(await readFile(join(output,'out/rig/parts.json'),'utf8'));
const report={partsVersion:installed.version,partsCommit:parts,inputsCommit:inputs,command:['bun','<pinned-producer>/cli.ts',...args.slice(2).map(a=>a.startsWith(output)?a.slice(output.length+1):a)],exit,assembleMs:performance.now()-start,rigSize:metadata.rig_size,scaleRigPerSource:metadata.scale_rig_per_source,partCount:metadata.parts.length,files:files.sort((a,b)=>a.path.localeCompare(b.path)),partsSha256:hash(await readFile(join(output,'out/rig/parts.json'))),paintingSha256:hash(await readFile(join(output,'out/rig/painting.png')))};
await writeFile(join(output,'receipt.json'),JSON.stringify(report,null,2)+'\n');console.log('PUBLIC_OVERLAY_DEMO '+JSON.stringify(report));
