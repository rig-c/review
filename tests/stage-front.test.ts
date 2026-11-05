import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startFront} from '../src/front.ts';
import {openNonceHeader,openKeyHeader} from '../src/open-protocol.ts';

function freePort(){const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')}),port=probe.port!;probe.stop(true);return port;}
test('actual managed front validates and forwards the complete trusted iframe query using this instance nonce',async()=>{
 const control=await mkdtemp(join(tmpdir(),'stage-front-')),key='a'.repeat(64),nonce=crypto.randomUUID(),fingerprint='f'.repeat(64);let forwarded=0;
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){if(req.headers.get(openNonceHeader)!==nonce)return new Response(null,{status:403});forwarded++;const url=new URL(req.url);return Response.json({path:url.pathname,search:url.search},{headers:{[openKeyHeader]:key}});}});
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
