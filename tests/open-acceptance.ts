/** Executed only on explicit copied acceptance inputs, never by the default test suite. */
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {shellWord} from '../src/open-shell.ts';
const app=fileURLToPath(new URL('..',import.meta.url));
const producer=process.env.RIG_REVIEW_ACCEPT_INPUT,reference=process.env.RIG_REVIEW_ACCEPT_REFERENCE,mutant=process.env.RIG_REVIEW_ACCEPT_MUTANT,output=process.env.RIG_REVIEW_ACCEPT_OUTPUT;
if(!producer||!reference||!mutant||!output)throw new Error('Acceptance needs explicit copied input/reference/mutant/output');
await mkdir(output,{recursive:true});const state=resolve(output,'state');await mkdir(state,{recursive:true});
const install=join(state,'installation'),globalDir=join(install,'global'),binDir=join(install,'bin');await mkdir(binDir,{recursive:true});
const config=join(state,'bunfig.toml');await writeFile(config,`[install]\nglobalDir = ${JSON.stringify(globalDir)}\nglobalBinDir = ${JSON.stringify(binDir)}\n`);
const env={...process.env,BUN_INSTALL:install,BUN_INSTALL_GLOBAL_DIR:globalDir,BUN_INSTALL_BIN:binDir,BUN_INSTALL_CACHE_DIR:join(install,'cache'),RIG_REVIEW_STATE_DIR:state};
async function command(args:string[],cwd=app){const start=performance.now(),p=Bun.spawn(args,{cwd,env,stdout:'pipe',stderr:'pipe'});const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(exit!==0)throw new Error(`Acceptance command failed ${exit}: ${stderr}\n${stdout}`);return {stdout,stderr,elapsedMs:performance.now()-start};}
const link=await command([process.execPath,'link',`--config=${config}`,'--no-save',`--cache-dir=${join(install,'cache')}`]);
const binary=join(binDir,'rig-review');await realpath(binary);const help=await command([binary,'--help']);if(!help.stdout.includes('rig-review open'))throw new Error('Installed executable help missing');
const cleanup:{nonce:string;stopped:boolean}[]=[],workers:{origin:string;pid:number;nonce:string}[]=[];
async function remember(url:string){const key=new URL(url).searchParams.get('handoff'),row=JSON.parse(await readFile(join(state,'open',key+'.json'),'utf8'));workers.push({origin:new URL(url).origin,pid:row.pid,nonce:row.nonce});return row;}
async function stopAll(){for(const worker of workers.splice(0)){try{const response=await fetch(worker.origin+'/api/open-status',{headers:{authorization:`Bearer ${worker.nonce}`},signal:AbortSignal.timeout(500)}),identity=await response.json();if(identity.nonce===worker.nonce)process.kill(worker.pid,'SIGTERM');}catch{}let stopped=false;for(let n=0;n<40;n++){try{await fetch(worker.origin,{signal:AbortSignal.timeout(100)});}catch{stopped=true;break;}await new Promise(r=>setTimeout(r,25));}cleanup.push({nonce:worker.nonce,stopped});if(!stopped)throw new Error('Acceptance own worker did not stop');}}
try{
 const cold=await command([binary,'open',producer,'--reference',reference]),url=cold.stdout.trim(),origin=new URL(url).origin,worker=await remember(url);
 if((await fetch(url)).status!==200)throw new Error('Printed hash URL did not open intended app');const wrong=new URL(url);wrong.searchParams.set('input','0'.repeat(64));if((await fetch(wrong)).status!==409)throw new Error('Wrong URL hash not refused');
 const warm=[];for(let n=0;n<5;n++){const result=await command([binary,'open',producer,'--reference',reference]);if(result.stdout.trim()!==url||!result.stderr.includes('reused')||result.elapsedMs>2000)throw new Error(`Warm CLI bar failed ${JSON.stringify(result)}`);warm.push(result.elapsedMs);}
 const current=JSON.parse(await readFile(join(state,'open',new URL(url).searchParams.get('handoff')+'.json'),'utf8'));if(current.nonce!==worker.nonce)throw new Error('Warm worker was not reused');
 const data=await (await fetch(origin+'/api/review')).json(),session=await (await fetch(origin+'/api/session')).json();if(data.report?.clock!==null)throw new Error('v19 must remain rate unknown');
 const feedback={id:'acceptance-interval',frameStart:176,frameEnd:184,target:{kind:'rig',name:data.manifest.id},category:'quality',summary:'Synthetic acceptance feedback for the supplied interval',context:{animation:'dance',reference:data.explicitReference.id}};
 const saved=await fetch(origin+'/api/session',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...session,status:'changes-requested',feedback:[feedback]})});if(saved.status!==200)throw new Error('Same-origin feedback save failed '+await saved.text());
 await stopAll();
 const read=await command([binary,'feedback',producer,'--reference',reference]),retrieved=JSON.parse(read.stdout);if(retrieved.status!=='changes-requested'||retrieved.feedback[0].summary!==feedback.summary||retrieved.feedback[0].frameStart!==176||retrieved.feedback[0].frameEnd!==184||retrieved.sourceHash!==data.sourceHash||JSON.stringify(retrieved.referenceBinding)!==JSON.stringify(data.referenceBinding))throw new Error('Exact feedback roundtrip failed');
 const plain=JSON.parse((await command([binary,'feedback',producer])).stdout);if(plain.status!=='pending')throw new Error('Reference-free lookup borrowed approval');
 const changed=await command([binary,'open',mutant,'--reference',reference]),changedUrl=changed.stdout.trim();await remember(changedUrl);const next=await (await fetch(new URL(changedUrl).origin+'/api/session')).json();if(changedUrl===url||next.sourceHash===session.sourceHash||next.status!=='pending')throw new Error('Changed motion did not produce new pending binding');await stopAll();
 await writeFile(join(output,'acceptance-summary.json'),JSON.stringify({kind:'CLI and HTTP only; no browser execution',installedBinary:true,link,help:help.stdout,coldMs:cold.elapsedMs,warmMs:warm,warmMaxMs:Math.max(...warm),url,sourceHash:data.sourceHash,referenceBinding:data.referenceBinding,reviewedSource:data.reviewedSource,reportClock:data.report?.clock,feedback:retrieved,changedSourceHash:next.sourceHash,cleanup},null,2)+'\n');
 console.log(JSON.stringify({installedBinary:true,coldMs:cold.elapsedMs,warmMs:warm,sourceHash:data.sourceHash,cleanup}));
}finally{await stopAll();await writeFile(join(output,'worker-cleanup.json'),JSON.stringify(cleanup,null,2)+'\n');}
