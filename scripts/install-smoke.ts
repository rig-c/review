/**
 * Install smoke: what an agent gets from `npm i -D @rig-c/review`, not what a checkout has.
 * Packs this tree, installs the tarball into an empty project, then runs the installed bin:
 * help, `check` on the bundled demo, and a served page whose browser bundle is built from the
 * installed `web/` against the installed `@rig-c/play`. A file missing from `files` fails here.
 */
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const root=new URL('..',import.meta.url).pathname,work=await mkdtemp(join(tmpdir(),'rig-review-smoke-')),app=join(work,'app');
let failed=false;
function step(name:string,ok:boolean,detail=''){console.log(`${ok?'ok  ':'FAIL'} ${name}${detail?' · '+detail:''}`);if(!ok)failed=true;return ok;}
async function run(cmd:string[],cwd:string){const child=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state')}});const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,exit};}
try{
 const packed=await run(['npm','pack','--json','--pack-destination',work],root);
 if(!step('npm pack',packed.exit===0,packed.stderr.trim().split('\n').at(-1)))throw new Error('pack');
 const [info]=JSON.parse(packed.stdout) as {filename:string;files:{path:string}[]}[];const files=info!.files.map(f=>f.path);
 step('tarball carries the bin, web, demo and licence',['src/cli.ts','web/main.ts','web/index.html','examples/demo/review.json','LICENSE'].every(f=>files.includes(f)),`${files.length} files`);
 step('tarball carries no tests or fixtures',!files.some(f=>f.startsWith('tests/')||f.startsWith('node_modules/')));
 await Bun.$`mkdir -p ${app}`;await writeFile(join(app,'package.json'),JSON.stringify({name:'rig-review-smoke',private:true})+'\n');
 const installed=await run(['npm','i','-D','--no-audit','--no-fund',join(work,info!.filename)],app);
 if(!step('npm i -D <tarball> into an empty project',installed.exit===0,installed.stderr.trim().split('\n').at(-1)))throw new Error('install');
 const help=await run(['npx','--no-install','rig-review','--help'],app);step('npx rig-review --help',help.exit===0&&help.stdout.includes('Usage'));
 const openHelp=await run(['npx','--no-install','rig-review','open','--help'],app);step('npx rig-review open --help',openHelp.exit===0&&openHelp.stdout.includes('rig-review open <dir>'));
 const demo=join(app,'node_modules/@rig-c/review/examples/demo/review.json');
 const check=await run(['npx','--no-install','rig-review','check',demo],app);step('rig-review check <bundled demo>',check.exit===0&&check.stdout.includes('Package valid'),check.stdout.split('\n')[0]||check.stderr.trim());
 const server=Bun.spawn([join(app,'node_modules/.bin/rig-review'),demo,'--port','0'],{cwd:app,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:join(work,'state')}});
 try{
  const reader=server.stdout.getReader(),decoder=new TextDecoder(),deadline=Date.now()+30000;let out='';
  while(!/Review ready: (\S+)/.test(out)&&Date.now()<deadline){const {value,done}=await reader.read();if(done)break;out+=decoder.decode(value);}
  const ready=/Review ready: (\S+)/.exec(out);
  if(step('installed bin serves the demo on loopback',!!ready,ready?.[1]??(await new Response(server.stderr).text()).trim())){
   const origin=new URL(ready![1]!).origin;
   for(const [path,type] of [['/','text/html'],['/styles.css','text/css'],['/main.js','text/javascript'],['/api/review','application/json']] as const){const r=await fetch(origin+path);const body=await r.text();step(`GET ${path}`,r.ok&&(r.headers.get('content-type')??'').includes(type)&&body.length>0,`${r.status} · ${body.length} bytes`);}
  }
 }finally{server.kill();await server.exited;}
}catch(error){if(!failed)step('smoke',false,error instanceof Error?error.message:String(error));}
finally{await rm(work,{recursive:true,force:true});}
console.log(`bun ${Bun.version}`);
process.exit(failed?1:0);
