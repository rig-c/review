import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { keptRoot, rebuildDir } from '../src/rebuild.ts';
import { patchSha256, type ConfigPatch } from '../src/config-patch.ts';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReview } from '../src/manifest.ts';
import { freshSession, readSession, saveSession, sessionFile, type Feedback } from '../src/session.ts';
import { startServer } from '../src/server.ts';
test('loopback API rejects cross-origin mutation, bounds bodies, serves ranges and binds delayed save to current bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-http-'));const input=join(root,'review.json');await writeFile(input,JSON.stringify({schema:'rig-review/1',id:'http',title:'HTTP',revision:'1',references:[{id:'video',label:'Reference bytes',type:'video',path:'clip.mp4'}],authoring:[{label:'HTML source',path:'page.html'},{label:'JS source',path:'payload.js'}]}));await writeFile(join(root,'clip.mp4'),'0123456789');await writeFile(join(root,'page.html'),"<script src='/assets/payload.js'></script>");await writeFile(join(root,'payload.js'),"fetch('/api/session')");const p=await loadReview(input);const stateDir=join(root,'state');const server=await startServer(p,{port:0,stateDir});const base=`http://127.0.0.1:${server.port}`;
 try {
  const get=await fetch(base+'/api/review');expect(get.status).toBe(200);const reviewData=await get.json();expect(reviewData.capabilities.playback).toBe(false);expect(reviewData.reviewedSource).toEqual(p.reviewedSource);
  expect((await fetch(base+'/styles.css')).status).toBe(200);expect((await fetch(base+'/main.js')).status).toBe(200);const html=await fetch(base+'/assets/page.html');expect(html.headers.get('content-security-policy')).toContain("script-src 'none'; sandbox");expect(html.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  const range=await fetch(base+'/assets/clip.mp4',{headers:{Range:'bytes=2-5'}});expect(range.status).toBe(206);expect(range.headers.get('content-range')).toBe('bytes 2-5/10');expect(await range.text()).toBe('2345');expect(range.headers.get('content-security-policy')).toContain('sandbox');
  expect((await fetch(base+'/assets/clip.mp4',{headers:{Range:'bytes=99-100'}})).status).toBe(416);
  expect((await fetch(base+'/assets/not-declared')).status).toBe(404);
  const session=freshSession(p);session.status='approved';
  expect((await fetch(base+'/api/session',{method:'PUT',headers:{Origin:'http://evil.test','Content-Type':'application/json'},body:JSON.stringify(session)})).status).toBe(403);
  expect((await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'text/plain'},body:JSON.stringify(session)})).status).toBe(400);
  expect((await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({padding:'x'.repeat(1024*1024)})})).status).toBe(400);
  const tampered=await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...session,reviewedSource:{...p.reviewedSource,viewerVersion:'forged'}})});expect(tampered.status).toBe(400);const saved=await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(session)});expect(saved.status).toBe(200);expect((await (await fetch(base+'/api/session')).json()).status).toBe('approved');session.status='pending';expect((await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(session)})).status).toBe(200);session.status='approved';
  const body=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(new TextEncoder().encode('{'));await Bun.sleep(30);await writeFile(join(root,'clip.mp4'),'modified');controller.enqueue(new TextEncoder().encode(JSON.stringify(session).slice(1)));controller.close();}});
  const delayed=await fetch(base+'/api/session',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body});expect(delayed.status).toBe(409);expect((await readSession(p,stateDir)).status).toBe('pending');
 }finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
});

test('CLI prints a stable deep checkpoint URL without opening a browser',async()=>{
 const proc=Bun.spawn([process.execPath,'src/cli.ts','examples/demo/review.json','--port','0','--checkpoint','silhouette'],{stdout:'pipe',stderr:'pipe'});
 try{const reader=proc.stdout.getReader();const first=await reader.read();const output=new TextDecoder().decode(first.value);expect(output).toMatch(/Review ready: http:\/\/127\.0\.0\.1:\d+\/\?checkpoint=silhouette/);await reader.cancel();}finally{proc.kill();await proc.exited;}
});

test('read-only feedback CLI retrieves saved identity and otherwise reports pending without writing source',async()=>{
 const root=await mkdtemp(join(tmpdir(),'review-cli-'));await writeFile(join(root,'motion.json'),'{}');const before=await Bun.file(join(root,'motion.json')).text();
 const proc=Bun.spawn([process.execPath,'src/cli.ts','feedback',root],{stdout:'pipe',stderr:'pipe'});const output=await new Response(proc.stdout).text();expect(await proc.exited).toBe(0);const session=JSON.parse(output);expect(session.status).toBe('pending');expect(session.updatedAt).toBeNull();expect(session.reviewedSource.rig).toBeNull();expect(session.reviewedSource.motion.path).toBe('motion.json');expect(session.reviewedSource.motion.sha256).toMatch(/^[a-f0-9]{64}$/);expect(await Bun.file(join(root,'review.json')).exists()).toBe(false);expect(await Bun.file(join(root,'motion.json')).text()).toBe(before);const p=await loadReview(root);try{await saveSession(p,{...freshSession(p),status:'changes-requested'});const submitted=Bun.spawn([process.execPath,'src/cli.ts','feedback',root],{stdout:'pipe',stderr:'pipe'});const stored=JSON.parse(await new Response(submitted.stdout).text());expect(await submitted.exited).toBe(0);expect(stored.status).toBe('changes-requested');expect(stored.reviewedSource).toEqual(p.reviewedSource);expect(stored.updatedAt).toBeString();}finally{await rm(sessionFile(p),{force:true});await rm(root,{recursive:true,force:true});}
});

test('selected correction keeps exact session bytes and pending made feedback cannot save', async () => {
  const root=await mkdtemp(join(tmpdir(),'review-correction-http-'));
  const stateDir=join(root,'state');
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'correction',title:'Correction',revision:'one'}));
    const p=await loadReview(root);
    server=await startServer(p,{port:0,stateDir,capability:'b'.repeat(64)});
    const origin='http://127.0.0.1:'+server.port;
    const session=freshSession(p);
    const selector={stage:'rig-review',kind:'rig',version:1};
    const words='Keep these exact words.  \r\n';
    session.feedback=[{id:'request',summary:words,frameStart:0,frameEnd:0,target:{kind:'rig',name:'correction'},category:'quality',context:{correction:{path:'described',selector}}}];
    const save=()=>fetch(origin+'/api/session',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':'b'.repeat(64)},body:JSON.stringify(session)});
    const response=await save();
    expect(response.status).toBe(200);
    const bytes=await Bun.file(sessionFile(p,stateDir)).text();
    const child=Bun.spawn([process.execPath,'-e',"import {main} from './src/cli.ts'; await main(process.argv.slice(1),{stateDir:process.env.TEST_STATE});",'--','feedback',root,'--correction','request','--format','json'],{env:{...process.env,TEST_STATE:stateDir},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect({stdout,stderr,exit}).toEqual({stdout:bytes,stderr:'',exit:0});
    expect(JSON.parse(stdout).feedback[0].summary).toBe(words);
    session.feedback[0]!.context={correction:{path:'made',selector}};
    const refused=await save();
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('CORRECTION_APPLY_PENDING');
    expect(await Bun.file(sessionFile(p,stateDir)).text()).toBe(bytes);
  } finally {
    server?.stop(true);
    await rm(root,{recursive:true,force:true});
  }
});

test('made correction uses a retained build and only revalidates new or edited saved items', async () => {
  // Hand-built seals exercise storage and transport, with no producer invocation.
  const root=await mkdtemp(join(tmpdir(),'review-correction-retention-'));
  const stateDir=join(root,'state');
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
  const model=(name:string)=>JSON.stringify({spec:'rigc-compiled/3',name,pages:[{name:'page.png'}]});
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'retained',title:'Retained',revision:'one',model:'skeleton.model.json',producer:{config:'config.json'}}));
    await writeFile(join(root,'skeleton.model.json'),model('source'));
    await writeFile(join(root,'page.png'),'source page');
    await writeFile(join(root,'config.json'),'{"note":"source"}\n');
    await mkdir(join(root,'out','rig'),{recursive:true});
    await writeFile(join(root,'out','parts.json'),'{}');
    for(const name of ['rig.json','motion.json','mesh_report.json'])await writeFile(join(root,'out','rig',name),'{}');
    const p=await loadReview(root);
    const {reviewedSource,sourceHash}=p;
    const binding={id:p.manifest.id,revision:p.manifest.revision,sourceHash,reviewedSource};
    const selector={stage:'rig-review',kind:'rig',version:1};
    const item=(id:string):Feedback=>({id,summary:id,frameStart:0,frameEnd:0,target:{kind:'rig',name:'retained'},category:'quality'});
    async function seal(name:string) {
      const buildId=sha(name), dir=rebuildDir(stateDir,sourceHash,buildId), build=join(dir,'build');
      await mkdir(build,{recursive:true});
      await writeFile(join(build,'skeleton.model.json'),model(name));
      await writeFile(join(build,'page.png'),name);
      const modelHash=sha(model(name));
      const patch:ConfigPatch={schema:'rig-review-config-patch/1',config_sha256:reviewedSource.handoff!.config.sha256,
        ops:[{op:'replace',path:'/note',value:name}],producer:{name:'@rig-c/parts',version:'2.18.0'},op:{cmd:'rig',args:[]}};
      const check={schema:'rig-review-check-summary/1',pass:true,exitCode:0,line:'check: PASS',bars:{GATE:'PASS'},gate:true,source:'check'};
      const record={schema:'rig-review-applied/2',buildId,patch,patchSha256:patchSha256(patch),configHash:patch.config_sha256,modelHash,
        producer:{package:patch.producer.name,version:patch.producer.version},compiler:{package:'@rig-c/core',version:'3.2.1'},
        line:'producer result',check,diff:{count:1,paths:['/note']},op:'rig'};
      const body={schema:'rig-review-applied-evidence/1',binding,buildId,operation:'rig',inputHash:null,
        outputHash:sha(JSON.stringify({'skeleton.model.json':modelHash,'page.png':sha(name)})),modelHash,check,record};
      const seals=join(stateDir,'applied-evidence',sourceHash);
      await mkdir(seals,{recursive:true});
      await writeFile(join(seals,buildId+'.json'),JSON.stringify({body,digest:sha(JSON.stringify(body))}));
      return {dir,build,buildId,record,row:JSON.parse(JSON.stringify({...item(name),context:{correction:{path:'made',selector},applied:record}})) as Feedback};
    }
    const a=await seal('apply-a');
    const session=freshSession(p);
    const connect=()=>startServer(p,{port:0,stateDir,capability:'b'.repeat(64)});
    server=await connect();
    const save=()=>{
      const origin='http://127.0.0.1:'+server!.port;
      return fetch(origin+'/api/session',{method:'PUT',headers:{Origin:origin,'Content-Type':'application/json','X-Review-Capability':'b'.repeat(64)},body:JSON.stringify(session)});
    };
    const selected=async(id:string)=>{
      const code="import {main} from './src/cli.ts'; await main(process.argv.slice(1),{stateDir:process.env.TEST_STATE});";
      const child=Bun.spawn([process.execPath,'-e',code,'--','feedback',root,'--correction',id,'--format','json'],{env:{...process.env,TEST_STATE:stateDir},stdout:'pipe',stderr:'pipe'});
      const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      return {stdout,stderr,exit};
    };
    const refuse=async(code:string)=>{
      const before=await Bun.file(sessionFile(p,stateDir)).text(), response=await save();
      expect(response.status).toBe(400);expect(await response.text()).toContain(code);
      expect(await Bun.file(sessionFile(p,stateDir)).text()).toBe(before);
    };

    session.feedback=[a.row];
    expect((await save()).status).toBe(200);
    const kept=keptRoot(stateDir,sourceHash);
    await mkdir(kept,{recursive:true});
    await rename(a.dir,join(kept,a.buildId));
    const b=await seal('apply-b');
    session.feedback=[a.row,b.row];

    await writeFile(join(b.build,'skeleton.model.json'),model('tampered'));
    await refuse('CORRECTION_RESULT_STALE');
    await writeFile(join(b.build,'skeleton.model.json'),model('apply-b'));
    await writeFile(join(b.build,'page.png'),'tampered page');
    await refuse('CORRECTION_RESULT_STALE');
    await writeFile(join(b.build,'page.png'),'apply-b');
    const redirected=join(root,'redirected');
    await rename(b.build,redirected);
    await symlink(redirected,b.build);
    await refuse('CORRECTION_RESULT_STALE');
    await rm(b.build);
    await rename(redirected,b.build);

    expect((await save()).status).toBe(200);
    expect(await selected(a.row.id)).toEqual({stdout:await Bun.file(sessionFile(p,stateDir)).text(),stderr:'',exit:0});
    const forged=JSON.parse(JSON.stringify({...b.row,context:{correction:{path:'made',selector},applied:{...b.record,line:'forged'}}})) as Feedback;
    session.feedback=[a.row,b.row,{...forged,id:'forged-new'}];
    await refuse('STAGE_DRAFT_STALE');
    // Edited saved evidence must not inherit the old row's trust.
    session.feedback=[a.row,forged];
    await refuse('STAGE_DRAFT_STALE');

    await rm(join(kept,a.buildId),{recursive:true});
    server.stop(true);server=await connect();
    session.feedback=[a.row,b.row,item('ordinary-after-restart')];
    expect((await save()).status).toBe(200);
    const evicted=await selected(a.row.id);
    expect(evicted.exit).toBe(1);expect(evicted.stderr).toContain('CORRECTION_RESULT_STALE');
    session.feedback[0]={...a.row,summary:'Edited history requires evidence'};
    await refuse('CORRECTION_RESULT_STALE');
  } finally {
    server?.stop(true);
    await rm(root,{recursive:true,force:true});
  }
});
