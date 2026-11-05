import {stageDraftRefusals} from '../src/stage-parts.ts';
import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startFront} from '../src/front.ts';
import {openNonceHeader,openKeyHeader} from '../src/open-protocol.ts';

function freePort(){const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=probe.port!;probe.stop(true);return port;}
test('actual managed front validates and forwards the complete trusted iframe query using this instance nonce',async()=>{
 const control=await mkdtemp(join(tmpdir(),'stage-front-')),key='a'.repeat(64),nonce=crypto.randomUUID(),fingerprint='f'.repeat(64);let forwarded=0,forwardedBuild:string|null=null;
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(req.headers.get(openNonceHeader)!==nonce)return new Response(null,{status:403});forwarded++;forwardedBuild=req.headers.get('X-Review-Stage-Build');const url=new URL(req.url);return Response.json({path:url.pathname,search:url.search},{headers:{[openKeyHeader]:key}});}});
 const front=startFront({control,port:freePort(),nonce:crypto.randomUUID(),fingerprint}),base=front.origin+'/instances/'+key+'/';
 const record={schema:'rig-review-open-instance/1',key,contentHash:'b'.repeat(64),nonce,fingerprint,pid:process.pid,origin:`http://127.0.0.1:${upstream.port}`,capability:'c'.repeat(64)};
 try{
  for(const mode of ['single','compare']){
   await writeFile(join(control,key+'.json'),JSON.stringify({...record,mode}),{mode:0o600});
   const suffix=mode==='single'?'':'&side=b';
   for(const lang of ['en','ko']){
    const search=`?stageEmbed=1&lang=${lang}${suffix}`,response=await fetch(base+'stage-parts.html'+search);expect(response.status).toBe(200);expect(await response.json()).toEqual({path:'/stage-parts.html',search});
    expect((await fetch(base+'stage-parts.html'+search,{method:'HEAD'})).status).toBe(200);
   }
   if(mode==='single'){for(const build of ['inspected','d'.repeat(64)]){expect((await fetch(base+'api/stage-parts',{headers:{'X-Review-Stage-Build':build}})).status).toBe(200);expect(String(forwardedBuild)).toBe(build);}const count=forwarded;expect((await fetch(base+'api/stage-parts',{headers:{'X-Review-Stage-Build':'../escape'}})).status).toBe(400);expect(forwarded).toBe(count);}
   const before=forwarded;
   const invalid=['','?stageEmbed=1','?stageEmbed=0&lang=en'+suffix,'?stageEmbed=1&lang=fr'+suffix,'?stageEmbed=1&lang=en&lang=ko'+suffix,'?stageEmbed=1&stageEmbed=1&lang=en'+suffix,'?stageEmbed=1&lang=en&path=/tmp'+suffix,'?stageEmbed=1&lang=en&cap=secret'+suffix,'?stageEmbed=1&lang=en&command=apply'+suffix,'?stageEmbed=1&lang=en&side=c',mode==='single'?'?stageEmbed=1&lang=en&side=a':'?stageEmbed=1&lang=en'];
   for(const query of invalid){const response=await fetch(base+'stage-parts.html'+query);expect(response.status).toBe(400);expect((await response.json()).error).toBe('FRONT_QUERY_REFUSED');}
   expect((await fetch(base+'parts.js?lang=en')).status).toBe(400);expect((await fetch(base+'stage-parts.html?stageEmbed=1&lang=en'+suffix,{method:'POST',headers:{Origin:front.origin}})).status).toBe(404);expect(forwarded).toBe(before);
   expect((await fetch(base+'stage-parts.html?stageEmbed=1&lang=en'+suffix,{headers:{Origin:'http://foreign.invalid'}})).status).toBe(403);
  }
  // A substituted nonce cannot serve this key, even though the route/query are valid.
  await writeFile(join(control,key+'.json'),JSON.stringify({...record,mode:'single',nonce:crypto.randomUUID()}),{mode:0o600});
  expect((await fetch(base+'stage-parts.html?stageEmbed=1&lang=en')).status).toBe(410);
 }finally{front.stop();upstream.stop(true);await rm(control,{recursive:true,force:true});}
});

test('actual front preserves only the bounded closed stage-data refusal after nonce/key checks',async()=>{
 const control=await mkdtemp(join(tmpdir(),'stage-front-refusal-')),key='a'.repeat(64),nonce=crypto.randomUUID(),fingerprint='f'.repeat(64),named='PARTS_ATLAS_UNAVAILABLE: the inspected package has no usable atlas or its source changed.';
 let reply={status:409,type:'application/json',body:JSON.stringify({error:named}),correctKey:true,chunked:false};
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(req.headers.get(openNonceHeader)!==nonce)return new Response(null,{status:403});const headers={'Content-Type':reply.type,[openKeyHeader]:reply.correctKey?key:'0'.repeat(64)};return new Response(reply.chunked?new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(reply.body));controller.close();}}):reply.body,{status:reply.status,headers});}});
 const front=startFront({control,port:freePort(),nonce:crypto.randomUUID(),fingerprint}),base=front.origin+'/instances/'+key;
 const record={schema:'rig-review-open-instance/1',key,contentHash:'b'.repeat(64),nonce,fingerprint,pid:process.pid,origin:`http://127.0.0.1:${upstream.port}`,capability:'c'.repeat(64)};
 try{
  for(const mode of ['single','compare']){
   await writeFile(join(control,key+'.json'),JSON.stringify({...record,mode}),{mode:0o600});const path=mode==='single'?'/api/stage-parts':'/api/compare/b/stage-parts';
   let response=await fetch(base+path);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:named});
   for(const error of Object.values(stageDraftRefusals)){reply.body=JSON.stringify({error});response=await fetch(base+path);expect(response.status).toBe(409);expect(await response.json()).toEqual({error});}
   for(const body of [JSON.stringify({error:'/private/not-allowed'}),JSON.stringify({error:named,extra:'secret'}),'not JSON',JSON.stringify({error:named,padding:'x'.repeat(1024)})]){
    reply.body=body;response=await fetch(base+path);expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'FRONT_UPSTREAM_CONFLICT'});
   }
   reply.body=JSON.stringify({error:named,padding:'x'.repeat(1024)});reply.chunked=true;response=await fetch(base+path);expect(await response.json()).toEqual({error:'FRONT_UPSTREAM_CONFLICT'});reply.chunked=false;
   reply.body=JSON.stringify({error:named});reply.type='text/html';response=await fetch(base+path);expect(await response.json()).toEqual({error:'FRONT_UPSTREAM_CONFLICT'});reply.type='application/json';
   response=await fetch(base+(mode==='single'?'/api/review':'/api/compare'));expect(await response.json()).toEqual({error:'FRONT_UPSTREAM_CONFLICT'});
   reply.status=400;response=await fetch(base+path);expect(await response.json()).toEqual({error:'FRONT_UPSTREAM_REJECTED'});reply.status=409;
   reply.correctKey=false;response=await fetch(base+path);expect(response.status).toBe(410);expect((await response.json()).error).toStartWith('FRONT_INSTANCE_REPLACED');reply.correctKey=true;
   response=await fetch(base+path,{headers:{Origin:'http://foreign.invalid'}});expect(response.status).toBe(403);
  }
 }finally{front.stop();upstream.stop(true);await rm(control,{recursive:true,force:true});}
});
