import {openGate,staleOpenStatus,type OpenIdentity} from './open-protocol.ts';
import { readFile } from 'node:fs/promises';
import { appRoot, buildWeb } from './build.ts';
import { packagePath, safeFile } from './manifest.ts';
import { assertCompareUnchanged, safeCompareReference, type ComparePackage } from './compare.ts';
import { exportCompareStrip, stripJson } from './strip-export.ts';
import { readCompareSession, saveCompareSession } from './compare-session.ts';

const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
async function bodyJson(req:Request):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('Expected application/json');
  if(Number(req.headers.get('content-length')??0)>1024*1024)throw new Error('Session payload exceeds 1 MiB');
  if(!req.body)throw new Error('JSON body required');const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1024*1024){await reader.cancel();throw new Error('Session payload exceeds 1 MiB');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
function serveAsset(req:Request,path:string):Response{
  const file=Bun.file(path),size=file.size;const assetHeaders={...headers,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Accept-Ranges':'bytes'};
  const range=req.headers.get('range');if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0,end=size-1;
    if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...assetHeaders,'Content-Range':`bytes */${size}`}});
    if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return new Response(null,{status:416,headers:{...assetHeaders,'Content-Range':`bytes */${size}`}});
    return new Response(req.method==='HEAD'?null:file.slice(start,end+1),{status:206,headers:{...assetHeaders,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1)}});
  }
  return new Response(req.method==='HEAD'?null:file,{headers:{...assetHeaders,'Content-Length':String(size)}});
}
export async function startCompareServer(p:ComparePackage,options:{port?:number;stateDir?:string;open?:OpenIdentity;activity?:()=>void}={}){
  const bundle=await buildWeb('compare');
  return Bun.serve({hostname:'127.0.0.1',port:options.port??4317,async fetch(req,server){try{
    const url=new URL(req.url),origin=`http://127.0.0.1:${server.port}`;
    if(url.origin!==origin)return json({error:'Loopback host required'},403);
    options.activity?.();const gate=openGate(req,options.open);if(gate){if(gate.status===200){try{await assertCompareUnchanged(p);}catch{return staleOpenStatus(options.open!);}}return gate;}
    if(req.method==='PUT'&&url.pathname==='/api/compare/session'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      return json(await saveCompareSession(p,await bodyJson(req),options.stateDir));
    }
    if(req.method==='POST'&&url.pathname==='/api/compare/strip'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      const result=await exportCompareStrip(p,await bodyJson(req));
      return new Response(result.png?new Uint8Array(result.png):stripJson(result),{headers:{...headers,'Content-Type':result.png?'image/png':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="review-strip.${result.png?'png':'json'}"`}});
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'Method not allowed'},405);
    if(url.pathname==='/api/compare'){await assertCompareUnchanged(p);return json(p.response);}
    if(url.pathname==='/api/compare/session')return json(await readCompareSession(p,options.stateDir));
    if(url.pathname==='/compare-reference')return serveAsset(req,await safeCompareReference(p));
    if(url.pathname.startsWith('/compare-assets/')){const match=/^\/compare-assets\/(a|b)\/(.+)$/.exec(url.pathname);if(!match)return json({error:'Unknown comparison side'},404);const side=match[1] as 'a'|'b',path=packagePath(decodeURIComponent(match[2]!));if(!p[side].files.has(path))return json({error:'Asset not declared by package'},404);return serveAsset(req,await safeFile(p[side].root,path));}
    if(url.pathname==='/main.js')return new Response(req.method==='HEAD'?null:bundle,{headers:{...headers,'Content-Type':'text/javascript'}});
    if(url.pathname==='/'||url.pathname==='/index.html')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/compare.html'),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
    if(url.pathname==='/styles.css')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/compare.css'),{headers:{...headers,'Content-Type':'text/css'}});
    return json({error:'Not found'},404);
  }catch(e){const message=e instanceof Error?e.message:'Request failed';return json({error:message},message.includes('inputs changed')?409:400);}}});
}
