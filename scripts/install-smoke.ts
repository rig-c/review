/**
 * Install smoke: what an agent gets from `npm i -D @rig-c/review`, not what a checkout has.
 * Packs this tree, installs the tarball into an empty project, then runs the installed bin:
 * help, `check` on the bundled demo, and a served page whose browser bundle is built from the
 * installed `web/` against the installed `@rig-c/play`. A file missing from `files` fails here.
 * Internal packs skip lifecycle scripts and override inherited dry-run, as does the empty install.
 * Registry, authentication and cache settings stay with the caller.
 * CI publishes this output, so every line goes through `log`, which redacts the `#cap=` value.
 */
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import type {Readable} from 'node:stream';
import {leaksCapability,redactCapability} from './redact.ts';
const root=new URL('..',import.meta.url).pathname,work=await mkdtemp(join(tmpdir(),'rig-review-smoke-')),app=join(work,'app');
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')) as {name:string;bin:Record<string,string>};
let failed=false;const printed:string[]=[];let servedCapability='';
/** The one writer of this script's stdout. */
function log(line:string){const safe=redactCapability(line);printed.push(safe);console.log(safe);}
interface PackResult {filename:string;files:{path:string}[]}
/** npm <= 11 prints an array of results; npm 12 prints an object keyed by package name. Anything else is refused by name. */
function packResult(value:unknown,name:string):PackResult{
 const entry=Array.isArray(value)?(value.length===1?value[0]:undefined):value&&typeof value==='object'?(value as Record<string,unknown>)[name]:undefined;
 const result=entry as Partial<PackResult>|undefined;
 if(!result||typeof result.filename!=='string'||!Array.isArray(result.files))throw new Error(`SMOKE_PACK_JSON: unrecognised npm pack --json output: ${JSON.stringify(value).slice(0,200)}`);
 return result as PackResult;
}
function step(name:string,ok:boolean,detail=''){log(`${ok?'ok  ':'FAIL'} ${name}${detail?' · '+detail:''}`);if(!ok)failed=true;return ok;}
async function run(cmd:string[],cwd:string,extra:Record<string,string>={}){const child=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state'),...extra}});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}
function firstLine(stream: Readable): Promise<string> {
 return new Promise((resolve,reject)=>{
  let text='';
  const finish=(error?:Error)=>{
   clearTimeout(timer);stream.off('data',data);stream.off('end',ended);stream.off('error',failed);
   if(error)reject(error);else resolve(text.slice(0,text.indexOf('\n')).trim());
  };
  const data=(chunk:Buffer)=>{text+=chunk.toString('utf8');if(text.includes('\n'))finish();};
  const ended=()=>finish(new Error('SMOKE_SESSION_START'));
  const failed=(error:Error)=>finish(error);
  const timer=setTimeout(()=>finish(new Error('SMOKE_SESSION_TIMEOUT')),30_000);
  stream.on('data',data);stream.once('end',ended);stream.once('error',failed);
 });
}

try{
 const packed=await run(['npm','pack','--json','--ignore-scripts','--dry-run=false','--pack-destination',work],root);
 if(!step('npm pack',packed.exit===0,packed.stderr.trim().split('\n').at(-1)))throw new Error('pack');
 const info=packResult(JSON.parse(packed.stdout),manifest.name);const files=info.files.map(f=>f.path);
 step('tarball carries the bin, web, demo and licence',['src/entry.ts','src/cli.ts','src/job-front.ts','src/job-session.ts','src/job-contract.ts','web/job-session.ts','web/main.ts','web/index.html','examples/demo/review.json','LICENSE'].every(f=>files.includes(f)),`${files.length} files`);
 step('tarball carries no tests or fixtures',!files.some(f=>f.startsWith('tests/')||f.startsWith('node_modules/')));
 await Bun.$`mkdir -p ${app}`;await writeFile(join(app,'package.json'),JSON.stringify({name:'rig-review-smoke',private:true})+'\n');
 const installed=await run(['npm','i','-D','--dry-run=false','--no-audit','--no-fund',join(work,info!.filename)],app);
 if(!step('npm i -D <tarball> into an empty project',installed.exit===0,installed.stderr.trim().split('\n').at(-1)))throw new Error('install');
 await writeFile(join(app,'node_modules/.metadata_never_index'),'');
 const help=await run(['npx','--no-install','rig-review','--help'],app);step('npx rig-review --help',help.exit===0&&help.stdout.includes('Usage'));
 const development=await run([process.execPath,'src/entry.ts','--help'],root);
 const legacy=await run([process.execPath,'src/cli.ts','--help'],root);
 step('installed/development/legacy help parity',development.exit===help.exit&&legacy.exit===help.exit&&development.stdout===help.stdout&&legacy.stdout===help.stdout);
 const sessionHelp=await run(['npx','--no-install','rig-review','session','--help'],app);
 const developmentSession=await run([process.execPath,'src/entry.ts','session','--help'],root);
 step('installed/development session entry parity',sessionHelp.exit===0&&developmentSession.exit===0&&sessionHelp.stdout===developmentSession.stdout&&sessionHelp.stdout.includes('session publish'));
 const installedManifest=JSON.parse(await readFile(join(app,'node_modules/@rig-c/review/package.json'),'utf8'));
 step('installed bin maps to the thin entry',installedManifest.bin['rig-review']==='src/entry.ts'&&manifest.bin['rig-review']==='src/entry.ts');
 const openHelp=await run(['npx','--no-install','rig-review','open','--help'],app);step('npx rig-review open --help',openHelp.exit===0&&openHelp.stdout.includes('rig-review open <dir>'));
 const demo=join(app,'node_modules/@rig-c/review/examples/demo/review.json');
 const check=await run(['npx','--no-install','rig-review','check',demo],app);step('rig-review check <bundled demo>',check.exit===0&&check.stdout.includes('Package valid'),check.stdout.split('\n')[0]||check.stderr.trim());
 const server=Bun.spawn([join(app,'node_modules/.bin/rig-review'),demo,'--port','0'],{cwd:app,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state')}});
 try{
  const reader=server.stdout.getReader(),decoder=new TextDecoder(),deadline=Date.now()+30000;let out='';
  while(!/Review ready: (\S+)/.test(out)&&Date.now()<deadline){const {value,done}=await reader.read();if(done)break;out+=decoder.decode(value);}
  const ready=/Review ready: (\S+)/.exec(out);
  if(step('installed bin serves the demo on loopback',!!ready,ready?.[1]??(await new Response(server.stderr).text()).trim())){
   servedCapability=new URL(ready![1]!).hash.slice(5);
   step('installed bin prints a write capability in its handoff URL',/^[a-f0-9]{64}$/.test(servedCapability),'value redacted in this log');
   const origin=new URL(ready![1]!).origin;
   for(const [path,type] of [['/','text/html'],['/styles.css','text/css'],['/main.js','text/javascript'],['/api/review','application/json']] as const){const r=await fetch(origin+path);const body=await r.text();step(`GET ${path}`,r.ok&&(r.headers.get('content-type')??'').includes(type)&&body.length>0,`${r.status} · ${body.length} bytes`);}
  }
 }finally{server.kill();await server.exited;}
 const job=spawn(join(app,'node_modules/.bin/rig-review'),['session','open',dirname(demo)],{
  cwd:app,stdio:['ignore','pipe','pipe','pipe'],env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'job-state'),
   RIG_REVIEW_JOB_REVIEWER_ID:'install-smoke-owner',RIG_REVIEW_JOB_REVIEWER_ROLE:'owner',RIG_REVIEW_JOB_AGENT_FD:'3'},
 });
 const jobExited=new Promise<void>(resolve=>job.once('exit',()=>resolve()));
 let jobErrors='';job.stderr!.on('data',chunk=>{jobErrors+=chunk.toString('utf8');});
 try{
  const [ownerLine,privateLine]=await Promise.all([firstLine(job.stdout!),firstLine(job.stdio[3] as Readable)]);
  const owner=new URL(ownerLine),bootstrap=JSON.parse(privateLine);
  const locator=owner.origin+'/jobs/'+bootstrap.jobId;
  const agentEnv={RIG_REVIEW_JOB_AGENT_CAPABILITY:bootstrap.agentCapability};
  step('installed session opens one standing owner window',owner.pathname==='/jobs/'+bootstrap.jobId+'/'&&owner.origin===bootstrap.origin&&/^[a-f0-9]{64}$/.test(owner.hash.slice(5)));
  const publish=await run(['npx','--no-install','rig-review','session','publish',locator,'--generation','0','--key','installed-smoke','--result','review.json','--freeze-hold','installed-smoke-held'],app,agentEnv);
  const publication=JSON.parse(publish.stdout);
  if(!step('installed semantic entry publishes the immutable bundled demo',publish.exit===0&&publication.ok===true))throw new Error('SMOKE_SESSION_PUBLISH');
  const descriptor=await (await fetch(locator+'/publications/'+publication.value.publicationId)).json();
  const data=await (await fetch(owner.origin+descriptor.value.routes.apiBase+'review')).json();
  step('installed job metadata stays bound to the displayed source',data.sourceHash===publication.value.source.sourceHash);
  const model=await fetch(owner.origin+descriptor.value.routes.assetsBase+data.manifest.model);
  step('installed job serves its retained model',model.ok&&(await model.text()).length>0);
  for(const path of ['', 'job.js','styles.css']){
   const response=await fetch(locator+'/'+path);const body=await response.text();
   step('installed standing owner resource '+(path||'page'),response.ok&&body.length>0);
  }
  const close=await run(['npx','--no-install','rig-review','session','close',locator,'--generation',String(publication.generation),'--key','installed-close','--reason','install smoke complete'],app,agentEnv);
  step('installed session closes explicitly',close.exit===0&&JSON.parse(close.stdout).value.status==='closed');
  await jobExited;
 }catch(error){if(jobErrors)log(jobErrors.trim());throw error;}finally{if(job.exitCode===null){job.kill('SIGTERM');await jobExited;}}
}catch(error){if(!failed)step('smoke',false,error instanceof Error?error.message:String(error));}
finally{await rm(work,{recursive:true,force:true});}
log(`bun ${Bun.version}`);
{const text=printed.join('\n');step('smoke output carries no capability value',!leaksCapability(text)&&!(servedCapability&&text.includes(servedCapability)));}
process.exit(failed?1:0);
