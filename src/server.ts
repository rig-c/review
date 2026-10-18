import {createControlServer,type ControlIdentity} from './control-server.ts';
import { readFile } from 'node:fs/promises';
import { appRoot, buildWeb } from './build.ts';
import { packagePath, safeFile, type ReviewPackage } from './manifest.ts';
import { exportReviewStrip, stripJson } from './strip-export.ts';
import {assertReviewUnchanged,referenceBinding,selectedReference,safeSelectedReference,serveReference} from './reference.ts';
import {openGate,staleOpenStatus,accessGate,openNonceGate,stampOpen,type OpenIdentity} from './open-protocol.ts';
import { readSession, saveSession } from './session.ts';
const headers={ 'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'};
function json(data:unknown,status=200){return Response.json(data,{status,headers});}
async function bodyJson(req:Request):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('Expected application/json');
  if(Number(req.headers.get('content-length')??0)>1024*1024)throw new Error('Session payload exceeds 1 MiB');
  if(!req.body)throw new Error('JSON body required');const reader=req.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024){await reader.cancel();throw new Error('Session payload exceeds 1 MiB');}chunks.push(value);}
  const full=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){full.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(full));
}
/** `capability` (open workers and foreground CLI serving) gates every non-GET request; tests may omit it. */
export async function startServer(p:ReviewPackage,options:{port?:number;stateDir?:string;open?:OpenIdentity;initialAnimation?:string;activity?:()=>void;control?:ControlIdentity;capability?:string}={}){
  const bundle=await buildWeb();
  const unchanged=()=>assertReviewUnchanged(p);
  const control=options.control?createControlServer({identity:options.control,sourceHash:p.sourceHash,mode:'single',unchanged,activity:options.activity}):null;
  const handle=async(req:Request,port:number|undefined):Promise<Response>=>{try {
      const url=new URL(req.url);const origin=`http://127.0.0.1:${port}`;
      if(url.origin!==origin)return json({error:'Loopback host required'},403);
      const refused=openNonceGate(req,options.open)??accessGate(req,options.capability);if(refused)return refused;
      const controlled=await control?.(req,origin);if(controlled)return controlled;
      options.activity?.();const gate=openGate(req,options.open);if(gate){if(gate.status===200){try{await unchanged();}catch{return staleOpenStatus(options.open!);}}return gate;}
      if(req.method==='PUT'&&url.pathname==='/api/session'){
        if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
        const input=await bodyJson(req);await unchanged();return json(await saveSession(p,input,options.stateDir));
      }
    if(req.method==='POST'&&url.pathname==='/api/strip'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      const result=await exportReviewStrip(p,await bodyJson(req));
      return new Response(result.png?new Uint8Array(result.png):stripJson(result),{headers:{...headers,'Content-Type':result.png?'image/png':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="review-strip.${result.png?'png':'json'}"`}});
    }
      if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'Method not allowed'},405);
      if(url.pathname==='/api/review'){await unchanged();return json({manifest:p.manifest,initialAnimation:options.initialAnimation??null,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource,...(referenceBinding(p)?{referenceBinding:referenceBinding(p),explicitReference:{...referenceBinding(p)!.reference,url:'/review-reference'}}:{}),report:p.report,feedbackCatalog:p.feedbackCatalog,assetsBase:'/assets/',capabilities:{playback:!!p.manifest.model,modeling:false,motion:false,feedback:true,audio:true}});}
      if(url.pathname==='/api/session'){await unchanged();return json(await readSession(p,options.stateDir));}
      if(url.pathname==='/review-reference')return await serveReference(req,await safeSelectedReference(p),referenceBinding(p)!.reference.sha256,headers);
      if(url.pathname.startsWith('/assets/')){
        const path=packagePath(decodeURIComponent(url.pathname.slice('/assets/'.length)));if(!p.files.has(path))return json({error:'Asset not declared by package'},404);
        const file=Bun.file(await safeFile(p.root,path));const size=file.size;
        const assetHeaders={...headers,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Accept-Ranges':'bytes'};
        const range=req.headers.get('range');
        if(range){
          const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0;let end=size-1;
          if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...assetHeaders,'Content-Range':`bytes */${size}`}});
          if(!match[1])start=Math.max(0,size-Number(match[2]));else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return new Response(null,{status:416,headers:{...assetHeaders,'Content-Range':`bytes */${size}`}});
          return new Response(req.method==='HEAD'?null:file.slice(start,end+1),{status:206,headers:{...assetHeaders,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1)}});
        }
        return new Response(req.method==='HEAD'?null:file,{headers:{...assetHeaders,'Content-Length':String(size)}});
      }
      if(url.pathname==='/main.js')return new Response(req.method==='HEAD'?null:bundle,{headers:{...headers,'Content-Type':'text/javascript'}});
      if(url.pathname==='/'||url.pathname==='/index.html')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/index.html'),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
      if(url.pathname==='/styles.css')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/styles.css'),{headers:{...headers,'Content-Type':'text/css'}});
      return json({error:'Not found'},404);
    }catch(e){const message=e instanceof Error?e.message:'Request failed';return json({error:message},message.includes('inputs changed')?409:400);}};
  return Bun.serve({hostname:'127.0.0.1',port:options.port??4317,async fetch(req,server){return stampOpen(req,await handle(req,server.port),options.open);}});
}
