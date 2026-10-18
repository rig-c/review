/** Explicit CLI video capability; package manifests never gain filesystem escapes. */
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath,stat} from 'node:fs/promises';
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
/** Fixed selected-file byte serving, never a browser-provided path. */
export function serveReference(req:Request,path:string,base:Record<string,string>):Response{
 const file=Bun.file(path),size=file.size,headers={...base,'Content-Security-Policy':"default-src 'none'; script-src 'none'; sandbox",'Content-Type':file.type||'application/octet-stream','Accept-Ranges':'bytes'};
 const range=req.headers.get('range');if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let start=0,end=size-1;if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${size}`}});return new Response(req.method==='HEAD'?null:file.slice(start,end+1),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':String(end-start+1)}});}
 return new Response(req.method==='HEAD'?null:file,{headers:{...headers,'Content-Length':String(size)}});
}
