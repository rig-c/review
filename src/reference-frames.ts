/** Actual reference PTS and explicit producer-sample associations. No guessed rate. */
import { lastFrame,timeAtFrame,type FrameClock } from './frame-clock.ts';
import {requireCommonTime,type CompareDomain} from './compare-playhead.ts';
export interface VideoFrame {index:number;time:number}
export interface VideoInfo {frames:VideoFrame[];duration:number}
export type ReferenceFrameIndex = {available:true;sourceHash:string;referenceSha256:string;video:VideoInfo}|{available:false;reason:string};
/** Keep the strip's decoded selection contract, including its earlier-PTS tie. */
export function nearestReferenceFrame(frames:readonly VideoFrame[],time:number):VideoFrame {
 if(!Number.isFinite(time)||!frames.length)throw new Error('STRIP_REFERENCE_TIME: finite time and decoded frames required');
 let lo=0,hi=frames.length;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(frames[mid]!.time<time)lo=mid+1;else hi=mid;}
 const after=frames[lo],before=frames[lo-1];if(!before)return after!;if(!after)return before;
 return time-before.time<=after.time-time?before:after;
}
export function requireUniqueReferencePts(video:VideoInfo):void {
 if(!video.frames.length||!Number.isFinite(video.duration))throw new Error('REFERENCE_FRAME_INDEX_INVALID: finite duration and frames required');
 for(let i=0;i<video.frames.length;i++){const frame=video.frames[i]!;if(frame.index!==i||!Number.isFinite(frame.time)||frame.time<0||frame.time>=video.duration)throw new Error('REFERENCE_FRAME_INDEX_INVALID: ordered finite frames inside video duration required');if(i&&frame.time<=video.frames[i-1]!.time)throw new Error('REFERENCE_FRAME_PTS_AMBIGUOUS: duplicate or unordered PTS cannot identify an exact decoded frame');}
}
/** Seek inside the selected real frame's interval, not onto rounded PTS boundary. */
export function referenceSeekPosition(video:VideoInfo,frame:VideoFrame):number {
 const next=video.frames[frame.index+1]?.time??video.duration;
 if(video.frames[frame.index]!==frame||!Number.isFinite(next)||next<=frame.time)throw new Error('REFERENCE_FRAME_SEEK_UNAVAILABLE: no real frame interval');
 const middle=frame.time+(next-frame.time)/2;
 if(!(middle>frame.time&&middle<next))throw new Error('REFERENCE_FRAME_SEEK_UNAVAILABLE: frame interval has no representable interior');
 return middle;
}
/** Browser PTS can retain more precision than ffprobe decimal output. Match the
 * nearest indexed timestamp inside the actual video domain; no epsilon or rate. */
export function referenceFrameAtTime(video:VideoInfo,time:number):VideoFrame|null {
 if(!Number.isFinite(time)||!Number.isFinite(video.duration)||!video.frames.length||time<0||time>=video.duration)return null;
 return nearestReferenceFrame(video.frames,time);
}
/** CPU submission budget estimate from adjacent decoded timestamps. The browser
 * reports the current display time only; this is not a compositor acknowledgement. */
export function nextReferenceInterval(video:VideoInfo|null,time:number,playbackRate:number):number|null {
 if(!video||!Number.isFinite(playbackRate)||playbackRate<=0)return null;
 const current=referenceFrameAtTime(video,time);if(!current)return null;
 const next=video.frames[current.index+1];if(!next)return null;
 const interval=(next.time-current.time)/playbackRate;
 return Number.isFinite(interval)&&interval>0?interval:null;
}
/** Invert explicit producer sample→nearest decoded index only when one-to-one.
 * This is a review sample association, not frameAtTime's floor interpretation. */
export function producerFrameAssociations(clock:FrameClock|null|undefined,video:VideoInfo):Map<number,number|null> {
 const result=new Map<number,number|null>(),last=lastFrame(clock);if(last===null)return result;if(last>=100000)throw new Error('REFERENCE_SAMPLE_LIMIT: exact review association supports at most 100000 explicit samples');
 for(let frame=0;frame<=last;frame++){const time=timeAtFrame(clock,frame);if(time===null||time<0||time>video.duration)continue;const index=nearestReferenceFrame(video.frames,time).index;result.set(index,result.has(index)?null:frame);}
 return result;
}

export class ReferenceSelectionUnavailable extends Error {constructor(detail:string){super(`REFERENCE_SELECTION_UNAVAILABLE: ${detail}`);this.name='ReferenceSelectionUnavailable';}}
/** Refuse an unsupported selection before the caller changes video or inspection. */
export function inspectionReferenceFrame(video:VideoInfo,time:number,domain:CompareDomain):VideoFrame {
 requireCommonTime(time,domain);
 if(time<0||time>video.duration)throw new ReferenceSelectionUnavailable('requested time is outside video duration');
 const selected=nearestReferenceFrame(video.frames,time);
 if(selected.time<domain.start||selected.time>domain.end)throw new ReferenceSelectionUnavailable(`nearest decoded frame at ${selected.time} s is outside the shared clip domain; choose an earlier supported reference frame`);
 return selected;
}
/** Explicit playback stop selection, distinct from nearest-request selection. */
export function lastSupportedReferenceFrame(video:VideoInfo,domain:CompareDomain):VideoFrame|null {
 let lo=0,hi=video.frames.length;while(lo<hi){const mid=lo+Math.floor((hi-lo)/2);if(video.frames[mid]!.time<=domain.end)lo=mid+1;else hi=mid;}
 const frame=video.frames[lo-1];return frame&&frame.time>=domain.start?frame:null;
}
