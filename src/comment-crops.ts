import {inflateSync} from 'node:zlib';
/** Derived PNGs live beside the session. A client never selects a filesystem path. */
import {createHash} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {homedir} from 'node:os';
import {parseStageComment,hasStageComment} from './stage-comment.ts';
import type {Feedback} from './session.ts';
export interface PngCrop {path:string;sha256:string;png:string;width:number;height:number}
export function validateCommentCrop(value:unknown):Buffer {return validatePngCrop(parseStageComment(value).crop);}
/** Shared bounded PNG validator; callers own their closed comment codecs. */
export function validatePngCrop(crop:PngCrop):Buffer {
 if(!crop||!Number.isSafeInteger(crop.width)||!Number.isSafeInteger(crop.height)||crop.width<1||crop.height<1||crop.width>16384||crop.height>16384||crop.width*crop.height>16777216||typeof crop.png!=='string'||crop.png.length>90*1024*1024||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(crop.png)||!/^[a-f0-9]{64}$/.test(crop.sha256)||crop.path!==`comment-crops/${crop.sha256}.png`)throw new Error('COMMENT_CROP_INVALID: bounded content-addressed PNG required');
  const bytes=Buffer.from(crop.png.slice('data:image/png;base64,'.length),'base64');
  if(createHash('sha256').update(bytes).digest('hex')!==crop.sha256)throw new Error('COMMENT_CROP_INVALID: PNG signature, dimensions or SHA-256 differ');
  return validatePngBytes(bytes,crop.width,crop.height);
}

/** Shared decoded-byte core. Callers enforce their own transport and byte limits. */
export function validatePngBytes(bytes:Buffer,width:number,height:number):Buffer {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||
    width>16384||height>16384||width*height>16777216||bytes.length<33||
    bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||
    bytes.toString('ascii',12,16)!=='IHDR'||bytes.readUInt32BE(16)!==width||bytes.readUInt32BE(20)!==height) {
    throw new Error('COMMENT_CROP_INVALID: PNG signature, dimensions or SHA-256 differ');
  }
  const data:Buffer[]=[];
  let offset=8,ended=false,hasData=false;
  const color=bytes[25],channels=color===6?4:color===2?3:0;
  if(bytes[24]!==8||!channels||bytes[26]!==0||bytes[27]!==0||bytes[28]!==0) {
    throw new Error('COMMENT_CROP_INVALID: expected noninterlaced 8-bit RGB/RGBA');
  }
  while(offset<bytes.length) {
    if(offset+12>bytes.length)throw new Error('COMMENT_CROP_INVALID: truncated PNG chunk');
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    if(end>bytes.length)throw new Error('COMMENT_CROP_INVALID: PNG chunk length');
    const type=bytes.toString('ascii',offset+4,offset+8);
    let crc=0xffffffff;
    for(const n of bytes.subarray(offset+4,end-4)) {
      crc^=n;
      for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
    }
    if(((crc^0xffffffff)>>>0)!==bytes.readUInt32BE(end-4))throw new Error('COMMENT_CROP_INVALID: PNG chunk CRC');
    if(type==='IDAT'){hasData=true;data.push(bytes.subarray(offset+8,end-4));}
    if(type==='acTL')throw new Error('COMMENT_CROP_INVALID: static PNG required');
    if(type==='IEND') {
      if(length!==0||end!==bytes.length)throw new Error('COMMENT_CROP_INVALID: PNG end');
      ended=true;
    }
    offset=end;
  }
  if(!ended||!hasData)throw new Error('COMMENT_CROP_INVALID: PNG data/end missing');
  const stride=width*channels+1;
  let inflated:Buffer;
  try{inflated=inflateSync(Buffer.concat(data),{maxOutputLength:stride*height});}
  catch{throw new Error('COMMENT_CROP_INVALID: bounded PNG data decode');}
  if(inflated.length!==stride*height)throw new Error('COMMENT_CROP_INVALID: PNG scanlines');
  for(let row=0;row<height;row++) {
    if(inflated[row*stride]!>4)throw new Error('COMMENT_CROP_INVALID: PNG scanlines');
  }
  return bytes;
}
const stateRoot=(state?:string)=>state??process.env.RIG_REVIEW_STATE_DIR??join(homedir(),'.local','state','rig-c-review');
export async function storePngCrop(crop:PngCrop,state?:string):Promise<void>{
 const bytes=validatePngCrop(crop),folder=join(stateRoot(state),'comment-crops');await mkdir(folder,{recursive:true,mode:0o700});if(!(await lstat(folder)).isDirectory())throw new Error('COMMENT_CROP_PATH: regular state directory required');const path=join(folder,crop.sha256+'.png');
 try{await writeFile(path,bytes,{mode:0o600,flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const info=await lstat(path);if(!info.isFile()||createHash('sha256').update(await readFile(path)).digest('hex')!==crop.sha256)throw new Error('COMMENT_CROP_PATH: existing crop is not the bound regular PNG');}
}
export function resolvedCropPath(path:string,state?:string):string {if(!/^comment-crops\/[a-f0-9]{64}\.png$/.test(path))throw new Error('COMMENT_CROP_PATH: content-addressed PNG required');return resolve(stateRoot(state),path);}
/** Read and validate stored evidence without creating state directories or rewriting a PNG. */
export async function readPngCrop(crop:Omit<PngCrop,'png'>,state?:string):Promise<Buffer>{
 const path=resolvedCropPath(crop.path,state);let bytes:Buffer;
 try{const info=await lstat(path);if(!info.isFile())throw new Error('COMMENT_CROP_PATH: stored crop must be a regular PNG');bytes=await readFile(path);}catch(error){if(error instanceof Error&&error.message.startsWith('COMMENT_CROP_PATH:'))throw error;throw new Error('COMMENT_CROP_STATE_UNAVAILABLE: stored crop cannot be read');}
 return validatePngCrop({...crop,png:'data:image/png;base64,'+bytes.toString('base64')});
}
export async function saveCommentCrops(feedback:Feedback[],state?:string):Promise<void>{
 for(const f of feedback){const context=f.context as Record<string,unknown>|undefined;if(!hasStageComment(context?.comment))continue;await storePngCrop(parseStageComment(context?.comment).crop,state);}
}
/** Only comment-bearing exports acquire resolved derived-evidence paths; old/no-comment bytes stay unchanged. */
export function commentCropPaths<T extends {feedback:Feedback[]}>(session:T,state?:string):T {
 if(!session.feedback.some(f=>hasStageComment((f.context as any)?.comment)))return session;
 return {...session,feedback:session.feedback.map(f=>{const raw=(f.context as any)?.comment;if(!hasStageComment(raw))return f;let c;try{c=parseStageComment(raw);}catch{return f;}const {png:_privatePng,...metadata}=c.crop;return {...f,context:{...f.context as any,comment:{...c,crop:{...metadata,path:resolve(stateRoot(state),c.crop.path)}}}};})};
}

/** Once submitted, comment evidence can be extended only by new IDs. Ordinary feedback keeps its existing rules. */
export function assertSubmittedComments(previous:Feedback[],next:Feedback[]):void {
 for(const old of previous){if(!hasStageComment((old.context as any)?.comment))continue;const candidate=next.find(f=>f.id===old.id);if(!candidate||!isDeepStrictEqual(candidate,old))throw new Error('COMMENT_SUBMITTED: submitted comments cannot be edited or deleted; add a new comment');}
}
