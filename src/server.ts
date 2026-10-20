import {createControlServer,type ControlIdentity} from './control-server.ts';
import { readFile } from 'node:fs/promises';
import { appRoot, buildWeb } from './build.ts';
import { packagePath, safeFile, type ReviewPackage } from './manifest.ts';
import { exportReviewStrip, stripJson } from './strip-export.ts';
import {assertReviewUnchanged,referenceBinding,selectedReference,safeSelectedReference,serveReference} from './reference.ts';
import {openGate,staleOpenStatus,accessGate,openNonceGate,stampOpen,type OpenIdentity} from './open-protocol.ts';
import { readSession, saveSession } from './session.ts';
import { createRebuilds, RebuildError } from './rebuild.ts';
import { createReadings } from './readings-run.ts';
import { ReadingsError } from './readings.ts';
import { BONES_CHECK_LIMIT, createBonesCheck } from './bones-check.ts';
import { createRequirementsCheck } from './requirements-run.ts';
import { REQUIREMENTS_LIMIT, RequirementsError } from './requirements.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
const headers={ 'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'};
/** Request shapes the page or an edit card got wrong: 400. Everything else a refusal names is an outcome (200). */
const MALFORMED=new Set(['REBUILD_REQUEST_INVALID','EDIT_PATCH_INVALID','EDIT_PATCH_OP_UNKNOWN','EDIT_PATCH_POINTER_INVALID','EDIT_PATCH_CMD_UNKNOWN','EDIT_PATCH_ARG_UNKNOWN','BONES_OP_OUT_OF_SCOPE','RETARGET_REQUEST_INVALID']);
function json(data:unknown,status=200){return Response.json(data,{status,headers});}
async function bodyJson(req:Request,limit=1024*1024,what='Session payload exceeds 1 MiB'):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('Expected application/json');
  if(Number(req.headers.get('content-length')??0)>limit)throw new Error(what);
  if(!req.body)throw new Error('JSON body required');const reader=req.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit){await reader.cancel();throw new Error(what);}chunks.push(value);}
  const full=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){full.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(full));
}
/** `capability` (open workers and foreground CLI serving) gates every non-GET request; tests may omit it.
 * `cwd` is where the producer is looked for after the package's own directories (review's working directory by default). */
export async function startServer(p:ReviewPackage,options:{port?:number;stateDir?:string;open?:OpenIdentity;initialAnimation?:string;activity?:()=>void;control?:ControlIdentity;capability?:string;cwd?:string}={}){
  const bundle=await buildWeb();
  const unchanged=()=>assertReviewUnchanged(p);
  const stateDir=options.stateDir??process.env.RIG_REVIEW_STATE_DIR??join(homedir(),'.local','state','rig-c-review'),starts=[p.root,options.cwd??process.cwd()];
  const rebuilds=createRebuilds(p,{stateDir,starts,unchanged,bones:p.feedbackCatalog.bones});
  // Readings (#108): rigc render's readings on the inspected build and on the latest scratch build, into scratch.
  const readings=createReadings(p,{stateDir,starts,unchanged,latest:rebuilds.latest});
  // Bones check (#109): propose --from-config and compare on a scratch copy of the patched handoff config.
  const bonesCheck=createBonesCheck(p,{stateDir,starts,unchanged});
  // Declared requirements (#113): review writes the file into scratch; the installed producer's check measures it.
  const requirements=createRequirementsCheck(p,{stateDir,starts,unchanged,latest:rebuilds.latest});
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
    // Apply · Rebuild (#99 regions, #102 {patch}): typed data, never a path; the server runs the installed producer into scratch.
    if(req.method==='POST'&&url.pathname==='/api/rebuild'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      try{const result=await rebuilds.start(await bodyJson(req,64*1024,'REBUILD_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
      // A refusal is an outcome the page shows verbatim (200), so the managed front passes its text through; only a malformed request is a 400.
      catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message,producerLine:null},MALFORMED.has(e.code)?400:200);throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/bones-check'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      try{return json(await bonesCheck.run(await bodyJson(req,BONES_CHECK_LIMIT,'BONES_CHECK_BODY_LIMIT: maximum 64 KiB')));}
      catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message},MALFORMED.has(e.code)?400:200);throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/requirements'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      try{const result=await requirements.start(await bodyJson(req,REQUIREMENTS_LIMIT,'REQUIREMENTS_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
      catch(e){if(e instanceof RequirementsError)return json({status:'refused',error:e.message},e.code==='REQUIREMENTS_REQUEST_INVALID'?400:200);throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/readings'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      try{const result=await readings.start(await bodyJson(req,16*1024,'READINGS_BODY_LIMIT: maximum 16 KiB'));return json(result.body,result.status);}
      catch(e){if(e instanceof ReadingsError)return json({status:'refused',error:e.message},e.code==='READINGS_REQUEST_INVALID'?400:200);throw e;}
    }
    if(req.method==='POST'&&url.pathname==='/api/strip'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      const result=await exportReviewStrip(p,await bodyJson(req));
      return new Response(result.png?new Uint8Array(result.png):stripJson(result),{headers:{...headers,'Content-Type':result.png?'image/png':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="review-strip.${result.png?'png':'json'}"`}});
    }
      if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'Method not allowed'},405);
      if(url.pathname==='/api/review'){await unchanged();return json({manifest:p.manifest,initialAnimation:options.initialAnimation??null,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource,...(referenceBinding(p)?{referenceBinding:referenceBinding(p),explicitReference:{...referenceBinding(p)!.reference,url:'/review-reference'}}:{}),report:p.report,feedbackCatalog:p.feedbackCatalog,assetsBase:'/assets/',capabilities:{playback:!!p.manifest.model,modeling:false,motion:false,feedback:true,audio:true}});}
      if(url.pathname==='/api/session'){await unchanged();return json(await readSession(p,options.stateDir));}
      if(url.pathname==='/api/rebuild')return json(await rebuilds.describe());
      const rebuildStatus=/^\/api\/rebuild\/([a-f0-9]{64})$/.exec(url.pathname);
      if(rebuildStatus){try{return json(rebuilds.read(rebuildStatus[1]!));}catch(e){if(e instanceof RebuildError)return json({error:e.message},404);throw e;}}
      if(url.pathname==='/api/requirements')return json(await requirements.describe());
      const requirementsStatus=/^\/api\/requirements\/([a-f0-9]{64})$/.exec(url.pathname);
      if(requirementsStatus){try{return json(requirements.read(requirementsStatus[1]!));}catch(e){if(e instanceof RequirementsError)return json({error:e.message},404);throw e;}}
      const readingsStatus=/^\/api\/readings\/([a-f0-9]{64})$/.exec(url.pathname);
      if(readingsStatus){try{return json(readings.read(readingsStatus[1]!));}catch(e){if(e instanceof ReadingsError)return json({error:e.message},404);throw e;}}
      const rebuildFile=/^\/rebuild\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
      if(rebuildFile){
        let full:string;try{full=await rebuilds.file(rebuildFile[1]!,decodeURIComponent(rebuildFile[2]!));}catch(e){return json({error:e instanceof Error?e.message:'Not found'},404);}
        const file=Bun.file(full);return new Response(req.method==='HEAD'?null:file,{headers:{...headers,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Content-Length':String(file.size)}});
      }
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
