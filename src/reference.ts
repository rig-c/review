/** Explicit CLI video capability; package manifests never gain filesystem escapes. */
import {createHash} from 'node:crypto';
import {constants,createReadStream} from 'node:fs';
import {open,realpath,stat} from 'node:fs/promises';
import {basename,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {loadReview,type ReviewPackage} from './manifest.ts';
export interface ReferenceBinding {packageSourceHash:string;reference:{id:string;name:string;sha256:string}}
export interface PinnedReference {path:string;binding:ReferenceBinding}
const pinned=Symbol('explicit CLI reference');
type ReferencedPackage=ReviewPackage&{[pinned]?:PinnedReference};
export const selectedReference=(p:ReviewPackage):PinnedReference|undefined=>(p as ReferencedPackage)[pinned];
export const referenceBinding=(p:ReviewPackage):ReferenceBinding|undefined=>selectedReference(p)?.binding;
export const packageSourceHash=(p:ReviewPackage):string=>referenceBinding(p)?.packageSourceHash??p.sourceHash;
export async function hashLocalVideo(input:string):Promise<{path:string;name:string;sha256:string}>{
 const path=await realpath(resolve(input));if(!/\.(mp4|mov|webm)$/i.test(path))throw new Error('reference: expected local mp4, mov or webm file');
 const before=await stat(path);if(!before.isFile())throw new Error('reference: expected regular local video');
 const hash=createHash('sha256');for await(const chunk of createReadStream(path,{highWaterMark:65536}))hash.update(chunk);
 const after=await stat(path);if(await realpath(input)!==path||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Reference inputs changed while hashing');
 return {path,name:basename(path),sha256:hash.digest('hex')};
}
export async function loadReferencedReview(input:string,reference?:string):Promise<ReviewPackage>{
 const base=await loadReview(input);if(reference===undefined)return base;
 const video=await hashLocalVideo(reference),id='open-reference-'+video.sha256;
 if(base.manifest.references.some(r=>r.id===id))throw new Error('reference: selected reference id collides with package reference');
 const binding:ReferenceBinding={packageSourceHash:base.sourceHash,reference:{id,name:video.name,sha256:video.sha256}};
 const sourceHash=createHash('sha256').update(JSON.stringify({schema:'rig-review-reference/1',...binding})).digest('hex');
 return {...base,sourceHash,manifest:{...base.manifest,references:[{id,label:video.name+' · selected reference',type:'video',path:'__review_selected_reference__.mp4'},...base.manifest.references]},[pinned]:{path:video.path,binding}} as ReferencedPackage;
}
export async function assertReviewUnchanged(p:ReviewPackage):Promise<void>{
 try{const current=await loadReferencedReview(p.manifestPath,selectedReference(p)?.path);if(current.sourceHash!==p.sourceHash||!isDeepStrictEqual(current.reviewedSource,p.reviewedSource)||!isDeepStrictEqual(referenceBinding(current),referenceBinding(p)))throw new Error('source binding differs');}
 catch{throw new Error('Package inputs changed or are unavailable. Restart review to bind feedback to current inputs.');}
}
export async function safeSelectedReference(p:ReviewPackage):Promise<string>{
 const selected=selectedReference(p);if(!selected)throw new Error('reference: no explicit video selected');
 try{const current=await realpath(selected.path);if(current!==selected.path||!(await stat(current)).isFile())throw new Error('not original file');return current;}
 catch{throw new Error('reference: originally selected canonical regular file unavailable (no symlink replacement)');}
}
/** Hash and serve the same opened file, bounded to 64 KiB buffers; never reopen a checked path. */
export async function serveReference(req:Request,path:string,sha256:string,base:Record<string,string>):Promise<Response>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>{throw new Error('Reference inputs changed or unavailable. Restart review to bind current video bytes.');});
 let closed=false;const close=async()=>{if(!closed){closed=true;await file.close();}};
 try{
  const before=await file.stat();if(!before.isFile())throw new Error('Reference inputs changed: expected regular video');
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
  while(position<before.size){const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,before.size-position),position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
  const after=await file.stat(),current=await stat(path);
  if(await realpath(path)!==path||current.dev!==after.dev||current.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||hash.digest('hex')!==sha256)throw new Error('Reference inputs changed. Restart review to bind current video bytes.');
  const size=after.size,headers={...base,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':Bun.file(path).type||'application/octet-stream','Accept-Ranges':'bytes'};
  const range=req.headers.get('range');let start=0,end=size-1,status=200;
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(match&&(match[1]||match[2])){if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}}else start=-1;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start){await close();return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});}status=206;
  }
  const responseHeaders={...headers,'Content-Length':String(Math.max(0,end-start+1)),...(status===206?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})};
  if(req.method==='HEAD'||size===0){await close();return new Response(null,{status,headers:responseHeaders});}
  position=start;
  const body=new ReadableStream<Uint8Array>({
   async pull(controller){try{const chunk=new Uint8Array(Math.min(65536,end-position+1)),{bytesRead}=await file.read(chunk,0,chunk.length,position),now=await file.stat();if(!bytesRead||now.size!==after.size||now.mtimeMs!==after.mtimeMs||now.ctimeMs!==after.ctimeMs)throw new Error('Reference changed during streaming');position+=bytesRead;controller.enqueue(chunk.subarray(0,bytesRead));if(position>end){await close();controller.close();}}catch(error){await close();controller.error(error);}},
   async cancel(){await close();}
  });
  return new Response(body,{status,headers:responseHeaders});
 }catch{await close();throw new Error('Reference inputs changed or unavailable. Restart review to bind current video bytes.');}
}
