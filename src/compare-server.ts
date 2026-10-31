import {createControlServer,type ControlIdentity} from './control-server.ts';
import {openGate,staleOpenStatus,accessGate,openNonceGate,openNonceHeader,sameSecret,stampOpen,type OpenIdentity} from './open-protocol.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appRoot, buildWeb } from './build.ts';
import { packagePath, safeFile, type ReviewPackage } from './manifest.ts';
import { assertCompareUnchanged, safeCompareReference, type ComparePackage } from './compare.ts';
import { assertReviewUnchanged, serveReference } from './reference.ts';
import {referenceFrameIndex} from './reference-frame-index.ts';
import { exportCompareStrip, stripJson } from './strip-export.ts';
import { readCompareSession, saveCompareSession } from './compare-session.ts';
import { createRebuilds, RebuildError } from './rebuild.ts';
import { DENSITY_STRIP_LIMIT } from './density-strip.ts';
import { createReadings } from './readings-run.ts';
import { ReadingsError } from './readings.ts';
import { BONES_CHECK_LIMIT, createBonesCheck } from './bones-check.ts';
import { createRequirementsCheck } from './requirements-run.ts';
import { REQUIREMENTS_LIMIT, RequirementsError } from './requirements.ts';
import { createEnvironmentCheck, ENVIRONMENT_CHECK_LIMIT, EnvironmentCheckError } from './environment-check.ts';
import { renderCompareHtml } from './compare-html.ts';
import { createLiveLifecycle, LIVE_PATH, type LiveExitInfo, type UpgradableServer } from './live-lifecycle.ts';

const headers={'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",'Referrer-Policy':'no-referrer'};
const MALFORMED=new Set(['REBUILD_REQUEST_INVALID','DENSITY_STRIP_REQUEST_INVALID','DENSITY_STRIP_FIELD','MESH_PATCH_SCOPE','EDIT_PATCH_INVALID','EDIT_PATCH_OP_UNKNOWN','EDIT_PATCH_POINTER_INVALID','EDIT_PATCH_CMD_UNKNOWN','EDIT_PATCH_ARG_UNKNOWN','BONES_OP_OUT_OF_SCOPE','RETARGET_REQUEST_INVALID']);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers});
async function bodyJson(req:Request,limit=1024*1024,what='Session payload exceeds 1 MiB'):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('Expected application/json');
  if(Number(req.headers.get('content-length')??0)>limit)throw new Error(what);
  if(!req.body)throw new Error('JSON body required');const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error(what);}chunks.push(value);}
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
/** `capability` (open workers and foreground CLI serving) gates every non-GET request; tests may omit it. */
export async function startCompareServer(p:ComparePackage,options:{port?:number;stateDir?:string;open?:OpenIdentity;activity?:()=>void;control?:ControlIdentity;capability?:string;cwd?:string;stripConcurrency?:number;graceMs?:number;unopenedTimeoutMs?:number;exitOnClose?:boolean;onClose?:(info:LiveExitInfo)=>void|Promise<void>;log?:(line:string)=>void}={}){
  const bundle=await buildWeb('compare');
  const frames=referenceFrameIndex(p.referencePath,p.response.binding.reference.sha256,p.response.sourceHash);
  const stateDir=options.stateDir??process.env.RIG_REVIEW_STATE_DIR??join(homedir(),'.local','state','rig-c-review');
  const makeSideTools=(side:'a'|'b',pkg:ReviewPackage)=>{
    const unchanged=()=>assertReviewUnchanged(pkg),starts=[pkg.root,options.cwd??process.cwd()];
    const rebuilds=createRebuilds(pkg,{stateDir,starts,unchanged,bones:pkg.feedbackCatalog.bones,assetPrefix:`/compare-rebuild/${side}`,stripPrefix:`/compare-density-strip/${side}`,...(options.stripConcurrency?{stripConcurrency:options.stripConcurrency}:{})});
    const readings=createReadings(pkg,{stateDir,starts,unchanged,latest:rebuilds.latest});
    const bonesCheck=createBonesCheck(pkg,{stateDir,starts,unchanged});
    const requirements=createRequirementsCheck(pkg,{stateDir,starts,unchanged,latest:rebuilds.latest});
    const environmentCheck=createEnvironmentCheck(pkg,{stateDir,starts,unchanged,latest:rebuilds.latest});
    return {rebuilds,readings,bonesCheck,requirements,environmentCheck,busy:()=>Boolean(rebuilds.busy()||readings.running()||requirements.running()||environmentCheck.running()||bonesCheck.running())};
  };
  const sideTools={a:makeSideTools('a',p.a),b:makeSideTools('b',p.b)};
  const control=options.control?createControlServer({identity:options.control,sourceHash:p.response.sourceHash,mode:'compare',unchanged:()=>assertCompareUnchanged(p),activity:options.activity}):null;
  let rawStop:((closeActiveConnections?:boolean)=>void)|null=null;
  const live=createLiveLifecycle({
    label:'review compare',
    graceMs:options.graceMs,
    unopenedTimeoutMs:options.unopenedTimeoutMs,
    exitOnClose:options.exitOnClose,
    onClose:options.onClose,
    log:options.log,
    busy:()=>sideTools.a.busy()||sideTools.b.busy(),
    stopServer:()=>{rawStop?.(true);},
  });
  const handle=async(req:Request,port:number|undefined,srv:UpgradableServer):Promise<Response|undefined>=>{try{
    const url=new URL(req.url),origin=`http://127.0.0.1:${port}`;
    if(url.origin!==origin)return json({error:'Loopback host required'},403);
    const refused=openNonceGate(req,options.open)??accessGate(req,options.capability,!!control);if(refused)return refused;
    if(req.method==='GET'&&url.pathname===LIVE_PATH){
      const fromFront=Boolean(options.open&&sameSecret(req.headers.get(openNonceHeader),options.open.nonce)&&req.headers.get('origin')===null);
      if(!fromFront&&req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      options.activity?.();return live.upgrade(req,srv,headers,options.open?.key);
    }
    live.onRequestStart(url.pathname);
    try {
    const controlled=await control?.(req,origin);if(controlled)return controlled;
    options.activity?.();const gate=openGate(req,options.open);if(gate){if(gate.status===200){try{await assertCompareUnchanged(p);}catch{return staleOpenStatus(options.open!);}if(!live.rearmUnopened())return json({error:'Server is closing'},503);}return gate;}
    if(req.method==='PUT'&&url.pathname==='/api/compare/session'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      return json(await saveCompareSession(p,await bodyJson(req),options.stateDir));
    }
    if(req.method==='POST'&&url.pathname==='/api/compare/strip'){
      if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
      const result=await exportCompareStrip(p,await bodyJson(req));
      return new Response(result.png?new Uint8Array(result.png):stripJson(result),{headers:{...headers,'Content-Type':result.png?'image/png':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="review-strip.${result.png?'png':'json'}"`}});
    }
    const sideApi=/^\/api\/compare\/(a|b)(\/.+)$/.exec(url.pathname);
    if(sideApi){
      const side=sideApi[1] as 'a'|'b',sub=sideApi[2]!,tools=sideTools[side];
      if(req.method==='POST'){
        if(req.headers.get('origin')!==origin)return json({error:'Same-origin Origin required'},403);
        if(sub==='/rebuild'){
          try{const result=await tools.rebuilds.start(await bodyJson(req,64*1024,'REBUILD_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message,producerLine:null},MALFORMED.has(e.code)?400:200);throw e;}
        }
        if(sub==='/rebuild/undo'){
          try{const result=await tools.rebuilds.undo(await bodyJson(req,1024,'REBUILD_BODY_LIMIT: maximum 1 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message,producerLine:null},MALFORMED.has(e.code)?400:200);throw e;}
        }
        if(sub==='/density-strip'){
          try{const result=await tools.rebuilds.startStrip(await bodyJson(req,DENSITY_STRIP_LIMIT,'DENSITY_STRIP_BODY_LIMIT: maximum 320 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message,producerLine:null},MALFORMED.has(e.code)?400:200);throw e;}
        }
        if(sub==='/density-strip/close'){
          try{const result=await tools.rebuilds.closeStrip(await bodyJson(req,1024,'DENSITY_STRIP_BODY_LIMIT: maximum 1 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message,producerLine:null},MALFORMED.has(e.code)?400:200);throw e;}
        }
        if(sub==='/bones-check'){
          try{return json(await tools.bonesCheck.run(await bodyJson(req,BONES_CHECK_LIMIT,'BONES_CHECK_BODY_LIMIT: maximum 64 KiB')));}
          catch(e){if(e instanceof RebuildError)return json({status:'refused',error:e.message},MALFORMED.has(e.code)?400:200);throw e;}
        }
        if(sub==='/requirements'){
          try{const result=await tools.requirements.start(await bodyJson(req,REQUIREMENTS_LIMIT,'REQUIREMENTS_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof RequirementsError)return json({status:'refused',error:e.message},e.code==='REQUIREMENTS_REQUEST_INVALID'?400:200);throw e;}
        }
        if(sub==='/environment-check'){
          try{const result=await tools.environmentCheck.start(await bodyJson(req,ENVIRONMENT_CHECK_LIMIT,'ENVIRONMENT_CHECK_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof EnvironmentCheckError)return json({status:'refused',error:e.message},e.code==='ENVIRONMENT_CHECK_REQUEST_INVALID'?400:200);throw e;}
        }
        if(sub==='/readings'){
          try{const result=await tools.readings.start(await bodyJson(req,64*1024,'READINGS_BODY_LIMIT: maximum 64 KiB'));return json(result.body,result.status);}
          catch(e){if(e instanceof ReadingsError)return json({status:'refused',error:e.message},e.code==='READINGS_REQUEST_INVALID'?400:200);throw e;}
        }
        return json({error:'Not found'},404);
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'Method not allowed'},405);
      if(sub==='/rebuild')return json(await tools.rebuilds.describe());
      if(sub==='/rebuild/history')return json(await tools.rebuilds.history());
      if(sub==='/density-strip')return json({strip:tools.rebuilds.readStrip()});
      const stripStatus=/^\/density-strip\/([a-f0-9]{64})(?:\/([a-f0-9]{64}))?$/.exec(sub);
      if(stripStatus){try{return json(stripStatus[2]?tools.rebuilds.stripJob(stripStatus[1]!,stripStatus[2]):tools.rebuilds.readStrip(stripStatus[1]!));}catch(e){if(e instanceof RebuildError)return json({error:e.message},404);throw e;}}
      const rebuildStatus=/^\/rebuild\/([a-f0-9]{64})$/.exec(sub);
      if(rebuildStatus){try{return json(tools.rebuilds.read(rebuildStatus[1]!));}catch(e){if(e instanceof RebuildError)return json({error:e.message},404);throw e;}}
      if(sub==='/requirements')return json(await tools.requirements.describe());
      const requirementsStatus=/^\/requirements\/([a-f0-9]{64})$/.exec(sub);
      if(requirementsStatus){try{return json(tools.requirements.read(requirementsStatus[1]!));}catch(e){if(e instanceof RequirementsError)return json({error:e.message},404);throw e;}}
      const environmentCheckStatus=/^\/environment-check\/([a-f0-9]{64})$/.exec(sub);
      if(environmentCheckStatus){try{return json(tools.environmentCheck.read(environmentCheckStatus[1]!));}catch(e){if(e instanceof EnvironmentCheckError)return json({error:e.message},404);throw e;}}
      const readingsStatus=/^\/readings\/([a-f0-9]{64})$/.exec(sub);
      if(readingsStatus){try{return json(tools.readings.read(readingsStatus[1]!));}catch(e){if(e instanceof ReadingsError)return json({error:e.message},404);throw e;}}
      return json({error:'Not found'},404);
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return json({error:'Method not allowed'},405);
    const compareRebuildFile=/^\/compare-rebuild\/(a|b)\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
    if(compareRebuildFile){
      const side=compareRebuildFile[1] as 'a'|'b';
      let full:string;try{full=await sideTools[side].rebuilds.file(compareRebuildFile[2]!,decodeURIComponent(compareRebuildFile[3]!));}catch(e){return json({error:e instanceof Error?e.message:'Not found'},404);}
      const file=Bun.file(full);return new Response(req.method==='HEAD'?null:file,{headers:{...headers,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Content-Length':String(file.size)}});
    }
    const compareStripFile=/^\/compare-density-strip\/(a|b)\/([a-f0-9]{64})\/([a-f0-9]{64})\/(.+)$/.exec(url.pathname);
    if(compareStripFile){
      const side=compareStripFile[1] as 'a'|'b';
      let full:string;try{full=await sideTools[side].rebuilds.stripFile(compareStripFile[2]!,compareStripFile[3]!,decodeURIComponent(compareStripFile[4]!));}catch(e){return json({error:e instanceof Error?e.message:'Not found'},404);}
      const file=Bun.file(full);return new Response(req.method==='HEAD'?null:file,{headers:{...headers,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Content-Length':String(file.size)}});
    }
    if(url.pathname==='/api/compare/reference-frames'){if(url.search)return json({error:'Reference frame index accepts no parameters'},400);await assertCompareUnchanged(p);await safeCompareReference(p);return json(await frames());}
    if(url.pathname==='/api/compare'){await assertCompareUnchanged(p);return json(p.response);}
    if(url.pathname==='/api/compare/session')return json(await readCompareSession(p,options.stateDir));
    if(url.pathname==='/compare-reference')return await serveReference(req,await safeCompareReference(p),p.response.binding.reference.sha256,headers);
    if(url.pathname.startsWith('/compare-assets/')){const match=/^\/compare-assets\/(a|b)\/(.+)$/.exec(url.pathname);if(!match)return json({error:'Unknown comparison side'},404);const side=match[1] as 'a'|'b',path=packagePath(decodeURIComponent(match[2]!));if(!p[side].files.has(path))return json({error:'Asset not declared by package'},404);return serveAsset(req,await safeFile(p[side].root,path));}
    if(url.pathname==='/main.js')return new Response(req.method==='HEAD'?null:bundle,{headers:{...headers,'Content-Type':'text/javascript'}});
    if(url.pathname==='/'||url.pathname==='/index.html'){const html=renderCompareHtml(await readFile(appRoot+'web/compare.html','utf8'),await readFile(appRoot+'web/index.html','utf8'));return new Response(req.method==='HEAD'?null:html,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});}
    if(url.pathname==='/styles.css')return new Response(req.method==='HEAD'?null:await readFile(appRoot+'web/compare.css'),{headers:{...headers,'Content-Type':'text/css'}});
    return json({error:'Not found'},404);
    } finally { live.onRequestEnd(url.pathname); }
  }catch(e){const message=e instanceof Error?e.message:'Request failed';return json({error:message},message.includes('inputs changed')?409:400);}};
  const server=Bun.serve({hostname:'127.0.0.1',port:options.port??4317,websocket:live.websocket,async fetch(req,srv){const res=await handle(req,srv.port,srv);if(!res)return undefined as unknown as Response;return stampOpen(req,res,options.open);}});
  rawStop=server.stop.bind(server);
  server.stop=((closeActiveConnections?:boolean)=>{live.stop();return rawStop!(closeActiveConnections);}) as typeof server.stop;
  return Object.assign(server,{live});
}
