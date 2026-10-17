import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReview } from '../src/manifest.ts';
import { freshSession, readSession, saveSession, sessionFile } from '../src/session.ts';
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
