import {execFile} from 'node:child_process';
import type {VideoInfo} from './reference-frames.ts';
function fail(code:string,text:string):never {throw new Error(`${code}: ${text}`);}
function command(binary:string,args:string[],kind:string):Promise<Buffer>{
 return new Promise((resolve,reject)=>execFile(binary,args,{encoding:'buffer',timeout:60000,maxBuffer:32*1024*1024,windowsHide:true},(error,stdout,stderr)=>{if(error){reject(new Error(`STRIP_${kind}: ${binary}: ${error.message}; ${stderr.toString('utf8').slice(0,1200)}`));return;}resolve(stdout);}));
}
export async function probeReference(referencePath:string,binary:string):Promise<VideoInfo>{
  const bytes=await command(binary,['-v','error','-threads','1','-select_streams','v:0','-show_frames','-show_streams','-show_format','-show_entries','frame=best_effort_timestamp_time:stream=duration:format=duration','-of','json',referencePath],'FFPROBE');
  const value=JSON.parse(bytes.toString('utf8')) as {frames?:{best_effort_timestamp_time?:string}[];streams?:{duration?:string}[];format?:{duration?:string}};
  if(!Array.isArray(value.frames)||!value.frames.length)fail('STRIP_REFERENCE','no decoded video frames');
  const frames=value.frames.map((frame,index)=>({index,time:Number(frame.best_effort_timestamp_time)}));
  for(let i=0;i<frames.length;i++)if(!Number.isFinite(frames[i]!.time)||frames[i]!.time<0||(i>0&&frames[i]!.time<frames[i-1]!.time))fail('STRIP_REFERENCE','expected finite ordered nonnegative decoded PTS');
  const duration=Number(value.streams?.[0]?.duration??value.format?.duration);
  if(!Number.isFinite(duration)||duration<frames.at(-1)!.time)fail('STRIP_REFERENCE','finite video duration covering decoded frames required');
  return {frames,duration};
}
