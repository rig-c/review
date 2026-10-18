/** One fixed server-selected video capability. Cache only after byte verification. */
import {hashLocalVideo} from './reference.ts';
import {probeReference} from './probe-reference.ts';
import {requireUniqueReferencePts,type ReferenceFrameIndex,type VideoInfo} from './reference-frames.ts';
export function referenceFrameIndex(path:string,sha256:string,sourceHash:string,binary=process.env.RIG_REVIEW_FFPROBE??'ffprobe'):()=>Promise<ReferenceFrameIndex>{
 let cached:VideoInfo|null=null,pending:Promise<VideoInfo>|null=null;
 const unchanged=async()=>{try{const current=await hashLocalVideo(path);if(current.path!==path||current.sha256!==sha256)throw new Error('hash differs');}catch{throw new Error('Reference inputs changed. Restart review to bind current video bytes.');}};
 return async()=>{
  await unchanged();
  if(!cached){
   if(!pending)pending=(async()=>{const video=await probeReference(path,binary);requireUniqueReferencePts(video);await unchanged();return video;})();
   try{cached=await pending;}catch(error){await unchanged();return {available:false,reason:error instanceof Error&&error.message.includes('REFERENCE_FRAME_PTS_AMBIGUOUS')?'REFERENCE_FRAME_PTS_AMBIGUOUS: exact frame selection unavailable for duplicate PTS':'REFERENCE_FRAME_INDEX_UNAVAILABLE: ffprobe must decode an unambiguous timestamp index; basic seconds playback remains available'};}finally{pending=null;}
  }
  await unchanged();return {available:true,sourceHash,referenceSha256:sha256,video:cached};
 };
}
