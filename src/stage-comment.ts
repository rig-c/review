/** Stage marks are optional inspection evidence on an ordinary feedback row. */
import type {PosedFrame} from '@rig-c/play';
import type {ControlNumericCamera} from './control.ts';
export interface MarkPoint {x:number;y:number}
export interface MarkRegion {x:number;y:number;width:number;height:number}
export const commentModes=['setup','animate','compare'] as const;
export type CommentMode=typeof commentModes[number];
export const timeOnlyReason='frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)' as const;
export const timeOnlyBasis={schema:'rig-review-time-only/1',basis:'seconds',reason:timeOnlyReason} as const;
export interface StageComment {
 schema:'rig-review-comment/1';mode:CommentMode;viewport:'rig'|'a'|'b'|'reference';
 frame:{index:number;basis:'producer'|'reference'}|null;timeBasis?:typeof timeOnlyBasis;time:number;animation:string|null;
 sourceHash:string;modelHash:string|null;referenceHash:string|null;referenceId:string|null;
 camera:ControlNumericCamera;screen:MarkRegion;world:MarkRegion;
 slots:{slot:string;z:number}[];
 crop:{path:string;sha256:string;png:string;width:number;height:number};
 bookmark:unknown;
}
export const hasStageComment=(value:unknown):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(value as Record<string,unknown>).schema==='rig-review-comment/1';
const fail=(message:string):never=>{throw new Error('COMMENT_INVALID: '+message);};
const obj=(v:unknown):Record<string,any>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:fail('object required');
const exact=(v:Record<string,any>,keys:string[])=>{if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('unknown or missing fields');};
const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER;
/** Also usable on derived reports, whose private inline PNG has been removed. */
export function stageCommentMode(value:unknown):CommentMode {
 const c=obj(value);
 if(!Object.hasOwn(c,'mode'))throw new Error('COMMENT_MODE_MISSING: placement mode is required');
 if(!commentModes.includes(c.mode))throw new Error('COMMENT_MODE_UNKNOWN: expected setup, animate or compare');
 const b=c.bookmark;
 if(c.mode==='compare' ? b?.binding?.mode!=='compare'||c.viewport==='rig' : b?.binding?.mode!=='single'||!['rig','reference'].includes(c.viewport)||b?.selection?.inspector!==(c.mode==='setup'?'rig':'playback'))throw new Error('COMMENT_MODE_MISMATCH: placement mode differs from page, viewport or saved inspector');
 return c.mode;
}
export function parseStageComment(value:unknown):StageComment {
 const v=obj(value);stageCommentMode(v);exact(v,['schema','mode','viewport','frame','time','animation','sourceHash','modelHash','referenceHash','referenceId','camera','screen','world','slots','crop','bookmark',...(v.frame===null?['timeBasis']:[])]);
 if(v.schema!=='rig-review-comment/1'||!['rig','a','b','reference'].includes(v.viewport))fail('schema/viewport');
 if(v.frame===null){const b=obj(v.timeBasis);exact(b,['schema','basis','reason']);if(b.schema!==timeOnlyBasis.schema||b.basis!==timeOnlyBasis.basis||b.reason!==timeOnlyReason||!['rig','reference'].includes(v.viewport))fail('time-only basis');}
 else{exact(obj(v.frame),['index','basis']);if(!Number.isSafeInteger(v.frame.index)||v.frame.index<0||!['producer','reference'].includes(v.frame.basis))fail('frame');}
 if(!number(v.time)||v.time<0||v.animation!==null&&typeof v.animation!=='string')fail('time/animation');
 const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 if(!hash(v.sourceHash)||v.modelHash!==null&&!hash(v.modelHash)||v.referenceHash!==null&&!hash(v.referenceHash)||v.referenceId!==null&&(typeof v.referenceId!=='string'||v.referenceId.length>512))fail('source binding');
 for(const key of ['screen','world']){const r=obj(v[key]);exact(r,['x','y','width','height']);if(!Object.values(r).every(number)||r.width<0||r.height<0)fail('region');}
 const c=obj(v.camera);exact(c,['space','center','zoom','viewport','visible']);if(!['world','image'].includes(c.space)||!number(c.zoom)||c.zoom<.25||c.zoom>8)fail('camera');exact(obj(c.center),['x','y']);if(!Object.values(c.center).every(number))fail('camera center');exact(obj(c.viewport),['width','height']);if(!Object.values(c.viewport).every(n=>number(n)&&Number(n)>0&&Number(n)<=65536))fail('camera extent');exact(obj(c.visible),['x','y','width','height']);if(!Object.values(c.visible).every(number)||c.visible.width<=0||c.visible.height<=0)fail('camera visible');
 if(!Array.isArray(v.slots)||v.slots.length>20000)fail('slots');let previous=Infinity;const names=new Set();for(const raw of v.slots){const s=obj(raw);exact(s,['slot','z']);if(typeof s.slot!=='string'||!s.slot||s.slot.length>512||names.has(s.slot)||!Number.isSafeInteger(s.z)||s.z<0||s.z>=previous)fail('nearest-first slots');names.add(s.slot);previous=s.z;}
 const crop=obj(v.crop);exact(crop,['path','sha256','png','width','height']);if(!hash(crop.sha256)||crop.path!==`comment-crops/${crop.sha256}.png`||typeof crop.png!=='string'||crop.png.length>200000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(crop.png)||![crop.width,crop.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=1024))fail('bounded PNG crop');
 if(v.bookmark===undefined||JSON.stringify(v.bookmark).length>16384)fail('bookmark limit');
 return v as StageComment;
}
/** Null frame indices are legal only on the closed, explicitly time-only single-comment shape. */
export function isTimeOnlyFeedback(value:unknown):boolean {
 try{const f=obj(value),context=obj(f.context),c=parseStageComment(context.comment);return f.frameStart===null&&f.frameEnd===null&&context.frame===null&&context.interval===null&&context.time===c.time&&c.frame===null&&c.timeBasis!==undefined;}catch{return false;}
}
export function feedbackTimingLabel(f:{frameStart:number|null;frameEnd:number|null;context?:unknown}):string {
 if(f.frameStart===null||f.frameEnd===null){const c=obj(obj(f.context).comment);if(c.frame!==null||c.timeBasis?.schema!==timeOnlyBasis.schema||c.timeBasis?.reason!==timeOnlyReason||!number(c.time)||c.time<0)fail('time-only display context');return `${c.time} s (seconds basis) · ${timeOnlyReason}`;}
 return `F${f.frameStart}–${f.frameEnd}`;
}
export function requireFeedbackFrames(f:{frameStart:number|null;frameEnd:number|null}):{frameStart:number;frameEnd:number}{
 if(f.frameStart===null||f.frameEnd===null)throw new Error(`COMMENT_CLOCK_UNAVAILABLE: ${timeOnlyReason}; a time-only comment has no frame interval for strip export`);
 return {frameStart:f.frameStart,frameEnd:f.frameEnd};
}
export function region(a:MarkPoint,b:MarkPoint):MarkRegion{return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
export function projectMark(p:MarkPoint,c:ControlNumericCamera):MarkPoint {const s=c.viewport.width/c.visible.width;return {x:(p.x-c.visible.x)*s,y:c.space==='world'?(c.visible.y+c.visible.height-p.y)*s:(p.y-c.visible.y)*s};}
export function unprojectMark(p:MarkPoint,c:ControlNumericCamera):MarkPoint {const s=c.visible.width/c.viewport.width;return {x:c.visible.x+p.x*s,y:c.space==='world'?c.visible.y+c.visible.height-p.y*s:c.visible.y+p.y*s};}
const cross=(a:MarkPoint,b:MarkPoint,c:MarkPoint)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const points=(v:readonly number[])=>Array.from({length:v.length/2},(_,i)=>({x:v[i*2]!,y:v[i*2+1]!}));
const area=(p:MarkPoint[])=>Math.abs(p.reduce((n,a,i)=>{const b=p[(i+1)%p.length]!;return n+a.x*b.y-a.y*b.x;},0))/2;
function inside(p:MarkPoint,poly:MarkPoint[]):boolean {let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i]!,b=poly[j]!;if(Math.abs(cross(a,b,p))<1e-9&&p.x>=Math.min(a.x,b.x)&&p.x<=Math.max(a.x,b.x)&&p.y>=Math.min(a.y,b.y)&&p.y<=Math.max(a.y,b.y))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;}
function convexHull(p:MarkPoint[]):MarkPoint[]{const sorted=[...p].sort((a,b)=>a.x-b.x||a.y-b.y),half=(ps:MarkPoint[])=>{const out:MarkPoint[]=[];for(const v of ps){while(out.length>1&&cross(out.at(-2)!,out.at(-1)!,v)<=0)out.pop();out.push(v);}return out;};return [...half(sorted).slice(0,-1),...half(sorted.reverse()).slice(0,-1)];}
function clip(subject:MarkPoint[],boundary:MarkPoint[]):MarkPoint[]{const signed=boundary.reduce((n,p,i)=>{const q=boundary[(i+1)%boundary.length]!;return n+p.x*q.y-p.y*q.x;},0),sign=signed<0?-1:1;let out=subject;for(let i=0;i<boundary.length&&out.length;i++){const a=boundary[i]!,b=boundary[(i+1)%boundary.length]!,input=out;out=[];for(let j=0;j<input.length;j++){const p=input[j]!,q=input[(j+1)%input.length]!,cp=cross(a,b,p)*sign,cq=cross(a,b,q)*sign;if(cp>=0)out.push(p);if((cp>=0)!==(cq>=0)){const t=cp/(cp-cq);out.push({x:p.x+t*(q.x-p.x),y:p.y+t*(q.y-p.y)});}}}return out;}
function triangles(poly:MarkPoint[]):MarkPoint[][]{const signed=poly.reduce((n,p,i)=>{const q=poly[(i+1)%poly.length]!;return n+p.x*q.y-p.y*q.x;},0);let ring=signed<0?[...poly].reverse():[...poly];const out:MarkPoint[][]=[];while(ring.length>3){let found=false;for(let i=0;i<ring.length;i++){const tri=[ring[(i+ring.length-1)%ring.length]!,ring[i]!,ring[(i+1)%ring.length]!];if(cross(...tri as [MarkPoint,MarkPoint,MarkPoint])<=0||ring.some(p=>!tri.includes(p)&&inside(p,tri)))continue;out.push(tri);ring.splice(i,1);found=true;break;}if(!found)throw new Error('COMMENT_CLIP_UNAVAILABLE: degenerate clipping polygon');}if(ring.length===3)out.push(ring);return out;}
/** Triangle coverage with the held runtime clip; alpha transparency is not a picking oracle. */
export function drawnSlots(frame:PosedFrame,r:MarkRegion):StageComment['slots'] {
 const box=[{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}],point=r.width===0&&r.height===0;
 const hits=frame.order.filter(row=>{
  if(row.tint[3]<=0)return false;const vertices=points(row.kind==='mesh'?row.vertices:row.corners),indices=row.kind==='mesh'?row.triangles:[0,1,2,0,2,3];
  let boundary=row.clip?points(row.clip.polygon):null;if(boundary&&(row.clip!.inverse||row.clip!.convex))boundary=convexHull(boundary);
  for(let i=0;i<indices.length;i+=3){const t=indices.slice(i,i+3).map(n=>vertices[n]!);if(area(t)===0)continue;
   if(point){if(inside(box[0]!,t)&&(!boundary||(row.clip!.inverse?!inside(box[0]!,boundary):inside(box[0]!,boundary))))return true;continue;}
   const selected=clip(t,box);if(area(selected)<=1e-12)continue;if(!boundary)return true;
   if(row.clip!.inverse){if(area(selected)-area(clip(selected,boundary))>1e-10)return true;}
   else if(triangles(boundary).some(piece=>area(clip(selected,piece))>1e-12))return true;
  }return false;
 });return hits.sort((a,b)=>b.z-a.z).map(({slot,z})=>({slot,z}));
}
