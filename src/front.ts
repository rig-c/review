import {interviewRequest} from './interview-routes.ts';
import {picksLimit} from './interview-picks.ts';
import {stageVerdictLimit} from './stage-parts.ts';
import {LIVE_PATH} from './live-lifecycle.ts';
export const defaultFrontPort=4318; // Foreground `review <dir>` keeps 4317.
export function frontPort(value?:number):number{const raw=value??(process.env.RIG_REVIEW_FRONT_PORT===undefined?defaultFrontPort:Number(process.env.RIG_REVIEW_FRONT_PORT));if(!Number.isSafeInteger(raw)||raw<(value===0?0:1)||raw>65535)throw new Error('FRONT_PORT: RIG_REVIEW_FRONT_PORT expects an integer 1..65535');return raw;}
interface Route {mutation:boolean;limit:number;timeoutMs:number;control:boolean;live?:boolean}
/** Closed allowlist per method. Agent control endpoints, open-status and anything unlisted are refused. */
export function frontRoute(mode:'single'|'compare',method:string,path:string):Route|null{
 const read=method==='GET'||method==='HEAD',get:Route={mutation:false,limit:0,timeoutMs:30000,control:false};
 if(path===LIVE_PATH)return method==='GET'?{...get,live:true}:null;
 if(['/','/index.html','/main.js','/styles.css','/api/access'].includes(path))return read?get:null;
 if((mode==='single'?/^\/api\/stage-parts(?:\/(?:image|page)\/\d+)?$/:/^\/api\/compare\/(?:a|b)\/stage-parts(?:\/(?:image|page)\/\d+)?$/).test(path))return read?get:null;
 if(mode==='single'){
  if(path==='/api/stage-parts/verdict')return method==='POST'?{...get,mutation:true,limit:stageVerdictLimit}:null;
  if(path==='/api/stage-parts/export/json'||path==='/api/stage-parts/export/issue')return read?get:null;
  if(interviewRequest(path))return path==='/api/interview/picks'?
   method==='POST'?{...get,mutation:true,limit:picksLimit}:null:method==='GET'?get:null;
 }
 if(path==='/api/control/config')return method==='GET'?{...get,control:true}:null;
 if(['/api/control/register','/api/control/poll','/api/control/ack','/api/control/close'].includes(path))return method==='POST'?{mutation:true,limit:16384,timeoutMs:10000,control:true}:null;
 const session=mode==='single'?'/api/session':'/api/compare/session',strip=mode==='single'?'/api/strip':'/api/compare/strip';
 if(path===session)return read?get:method==='PUT'?{mutation:true,limit:1024*1024,timeoutMs:30000,control:false}:null;
 if(path===strip)return method==='POST'?{mutation:true,limit:1024*1024,timeoutMs:120000,control:false}:null;
 const reads=mode==='single'?['/api/review','/review-reference','/review-painting']:['/api/compare','/api/compare/reference-frames','/compare-reference'];
 if(reads.includes(path))return read?get:null;
 if((mode==='single'?/^\/assets\/[^/]/:/^\/compare-assets\/(a|b)\/[^/]/).test(path))return read?get:null;
 // Apply · Rebuild and producer checks: un-prefixed in single mode, side-scoped (/api/compare/(a|b)/*, /compare-rebuild/(a|b)/*) in compare mode (#234).
 const toolPath=mode==='compare'?path.replace(/^\/api\/compare\/(?:a|b)(?=\/)/,'/api').replace(/^\/compare-rebuild\/(?:a|b)\//,'/rebuild/').replace(/^\/compare-density-strip\/(?:a|b)\//,'/density-strip/'):path;
 if(mode==='compare'&&toolPath===path)return null;
 if(toolPath==='/api/rebuild')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(toolPath==='/api/rebuild/history')return read?get:null;
 if(toolPath==='/api/rebuild/undo')return method==='POST'?{mutation:true,limit:1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/rebuild\/[a-f0-9]{64}$/.test(toolPath)||/^\/rebuild\/[a-f0-9]{64}\/[^/]/.test(toolPath))return read?get:null;
 if(toolPath==='/api/density-strip')return read?get:method==='POST'?{mutation:true,limit:320*1024,timeoutMs:30000,control:false}:null;
 if(toolPath==='/api/density-strip/close')return method==='POST'?{mutation:true,limit:1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/density-strip\/[a-f0-9]{64}(?:\/[a-f0-9]{64})?$/.test(toolPath)||/^\/density-strip\/[a-f0-9]{64}\/[a-f0-9]{64}\/[^/]/.test(toolPath))return read?get:null;
 if(toolPath==='/api/bones-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:60000,control:false}:null;
 if(toolPath==='/api/readings')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/readings\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 if(toolPath==='/api/requirements')return read?get:method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/requirements\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 if(toolPath==='/api/environment-check')return method==='POST'?{mutation:true,limit:64*1024,timeoutMs:30000,control:false}:null;
 if(/^\/api\/environment-check\/[a-f0-9]{64}$/.test(toolPath))return read?get:null;
 return null;
}
export async function boundedBody(req:Request,limit:number,timeoutMs=10000):Promise<ArrayBuffer>{
 if(!/^application\/json(?:\s*;|$)/i.test(req.headers.get('content-type')??''))throw new Error('FRONT_JSON_REQUIRED');
 const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('FRONT_BODY_LIMIT');
 if(!req.body)throw new Error('FRONT_JSON_REQUIRED');const reader=req.body.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([(async()=>{const chunks:Uint8Array[]=[];let size=0;while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit)throw new Error('FRONT_BODY_LIMIT');chunks.push(next.value);}const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes.buffer;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('FRONT_BODY_TIMEOUT')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
export const maximumUpstreamStreams=32;
