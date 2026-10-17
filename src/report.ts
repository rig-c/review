/** Read-only rig-pose findings. Frame indices never imply a sampling rate. */
export const reportFields = ['switches','raised','short','endOn','cleaned.holds','cleaned.seams','feet.jumps','feet.supports','landings','shear','artRange','uncovered','flips','turns','range','holds'] as const;
export type ReportField = typeof reportFields[number];
export interface ReportTarget { kind:'bone'|'slot'; name:string }
export interface ReportEvent {
  id:string; source:{path:string;pointer:string}; field:ReportField;
  frames?:[number,number]; times?:number[];
  timeInterval?:{start:number;end:number;endKind:'boundary'|'frame'};
  seek?:{time:number;source:'event'|'frameTimes'|'fps'};
  timing:'mapped'|'frames-unmapped'|'unavailable'; durationSeconds?:number;
  targets:ReportTarget[];
  provenance:{joint?:string;point?:string;chain?:string;chains?:string[];side?:string;set?:string;attachment?:string;line?:string;joints?:string[]};
  details:Record<string,unknown>;
}
export interface ReportCategory { field:ReportField; state:'events'|'empty'; events:ReportEvent[] }
export interface ReportSeeds { spec:'rig-pose-report/1';path:string;animation?:string;rig?:string;frameCount?:number;durationSeconds?:number;categories:ReportCategory[] }

function fail(field:string,expected:string):never { throw new Error(`${field}: expected ${expected}`); }
function record(v:unknown,field:string):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))fail(field,'object');return v as Record<string,unknown>;}
function text(v:unknown,field:string):string{if(typeof v!=='string'||!v.trim())fail(field,'nonempty string');return v;}
function finite(v:unknown,field:string):number{if(typeof v!=='number'||!Number.isFinite(v)||v<0)fail(field,'finite number >= 0');return v;}
function frame(v:unknown,field:string):number{const n=finite(v,field);if(!Number.isSafeInteger(n))fail(field,'nonnegative safe integer');return n;}
function numbers(v:unknown,field:string,strict=true):number[]{if(!Array.isArray(v))fail(field,'array of times in seconds');const result=v.map((n,i)=>finite(n,`${field}[${i}]`));for(let i=1;i<result.length;i++)if(strict?result[i]!<=result[i-1]!:result[i]!<result[i-1]!)fail(field,strict?'strictly increasing times in seconds':'nondecreasing times in seconds');return result;}
function frames(v:unknown,field:string):[number,number]{if(!Array.isArray(v)||v.length!==2)fail(field,'inclusive [first,last] frame pair');const a=frame(v[0],field+'[0]'),b=frame(v[1],field+'[1]');if(b<a)fail(field,'first <= last');return [a,b];}
function names(v:unknown,field:string):string[]{if(!Array.isArray(v))fail(field,'array of names');return v.map((n,i)=>text(n,`${field}[${i}]`));}

/** Unrelated report documents remain evidence rather than invented findings. */
export function parseReport(input:unknown,path='report.json'):ReportSeeds|null {
  const root=record(input,path);if(root.spec!=='rig-pose-report/1')return null;
  const report:ReportSeeds={spec:'rig-pose-report/1',path,categories:[]};
  if(root.animation!==undefined)report.animation=text(root.animation,path+'.animation');
  if(root.rig!==undefined)report.rig=text(root.rig,path+'.rig');
  if(root.frames!==undefined)report.frameCount=frame(root.frames,path+'.frames');
  if(root.duration!==undefined)report.durationSeconds=finite(root.duration,path+'.duration');
  let frameTimes:number[]|undefined;
  if(root.frameTimes!==undefined){frameTimes=numbers(root.frameTimes,path+'.frameTimes');if(report.frameCount!==undefined&&frameTimes.length!==report.frameCount)fail(path+'.frameTimes','one time per reported frame');}
  let fps:number|undefined,frame0:number|undefined;
  if(root.fps!==undefined||root.frame0!==undefined){fps=finite(root.fps,path+'.fps');if(fps===0)fail(path+'.fps','number > 0');frame0=finite(root.frame0,path+'.frame0');}
  if(frameTimes&&fps!==undefined)for(let i=0;i<frameTimes.length;i++)if(Math.abs(frameTimes[i]!-(frame0!+i/fps))>1e-6)fail(path+'.frameTimes','times matching declared fps/frame0');
  // Producer contract rig-c/pose#209: frame0 is seconds; t = frame0 + frame/fps.
  const mapped=(n:number):{time:number;source:'frameTimes'|'fps'}|undefined=>{
    if(frameTimes){if(n>=frameTimes.length)fail(path+'.frameTimes',`time for event frame ${n}`);return {time:frameTimes[n]!,source:'frameTimes'};}
    if(fps===undefined)return undefined;return {time:finite(frame0!+n/fps,path+'.fps frame time'),source:'fps'};
  };
  for(const field of reportFields){
    let value:unknown=root;let absent=false;
    for(const segment of field.split('.')){if(value===null){absent=true;break;}const parent=record(value,path+'.'+field);if(parent[segment]===undefined){absent=true;break;}value=parent[segment];}
    if(absent)continue;
    const fieldPath=path+'.'+field;if(!Array.isArray(value))fail(fieldPath,'event array');
    const events=value.map((raw,index):ReportEvent=>{
      const where=`${fieldPath}[${index}]`;const pointer='/'+field.replaceAll('.','/')+'/'+index;
      const row=Array.isArray(raw)&&field==='feet.jumps'?{frames:raw}:record(raw,where);
      const event:ReportEvent={id:`report-${field.replaceAll('.','-')}-${index}`,source:{path,pointer},field,timing:'unavailable',targets:[],provenance:{},details:{...row}};
      if(row.frames!==undefined)event.frames=frames(row.frames,where+'.frames');
      if(row.frame!==undefined){const n=frame(row.frame,where+'.frame');if(event.frames&&(event.frames[0]!==n||event.frames[1]!==n))fail(where+'.frame','consistent frame and frames');event.frames=[n,n];}
      // The legacy top-level holds use from/to as frame indices, unlike switches.
      if(field==='holds'&&(row.from!==undefined||row.to!==undefined)){const interval=frames([row.from,row.to],where+'.from/to');if(event.frames&&(event.frames[0]!==interval[0]||event.frames[1]!==interval[1]))fail(where+'.from/to','consistent holds frames and from/to');event.frames=interval;}
      if(event.frames&&report.frameCount!==undefined&&event.frames[1]>=report.frameCount)fail(where+'.frames',`indices below report.frames (${report.frameCount})`);
      for(const name of ['bone','slot'] as const)if(row[name]!==undefined)event.targets.push({kind:name,name:text(row[name],where+'.'+name)});
      if(field==='switches'&&row.slots!==undefined){const slots=record(row.slots,where+'.slots');for(const [slot,attachment] of Object.entries(slots)){text(slot,where+'.slots key');text(attachment,where+'.slots.'+slot);if(!event.targets.some(t=>t.kind==='slot'&&t.name===slot))event.targets.push({kind:'slot',name:slot});}}
      for(const key of ['joint','point','chain','side','set','attachment','line'] as const)if(row[key]!==undefined)event.provenance[key]=text(row[key],where+'.'+key);
      for(const key of ['chains','joints'] as const)if(row[key]!==undefined)event.provenance[key]=names(row[key],where+'.'+key);
      if(row.seconds!==undefined)event.durationSeconds=finite(row.seconds,where+'.seconds');
      if(row.spanSeconds!==undefined){const duration=finite(row.spanSeconds,where+'.spanSeconds');if(event.durationSeconds!==undefined&&Math.abs(event.durationSeconds-duration)>1e-6)fail(where+'.spanSeconds','consistent seconds and spanSeconds');event.durationSeconds=duration;}
      if(row.times!==undefined){event.times=numbers(row.times,where+'.times',field==='uncovered');if(field!=='uncovered'&&event.times.length!==2)fail(where+'.times','[first,last] times in seconds');if(event.times.length){event.seek={time:event.times[0]!,source:'event'};if(field!=='uncovered')event.timeInterval={start:event.times[0]!,end:event.times[1]!,endKind:'frame'};}}
      if(row.t!==undefined){const t=finite(row.t,where+'.t');if(event.seek&&Math.abs(event.seek.time-t)>1e-6)fail(where+'.t','consistent event t and times');event.seek={time:t,source:'event'};}
      if(field==='switches'&&(row.from!==undefined||row.to!==undefined)){const start=finite(row.from,where+'.from'),end=finite(row.to,where+'.to');if(end<start)fail(where+'.to','boundary >= from');if(event.seek&&Math.abs(event.seek.time-start)>1e-6)fail(where+'.from','consistent explicit start time');event.seek={time:start,source:'event'};event.timeInterval={start,end,endKind:'boundary'};}
      if(event.frames){const first=mapped(event.frames[0]),last=mapped(event.frames[1]);if(first){if(event.seek&&Math.abs(first.time-event.seek.time)>1e-6)fail(where+'.t','event time matching declared frame time base');if(event.timeInterval?.endKind==='frame'&&last&&Math.abs(event.timeInterval.end-last.time)>1e-6)fail(where+'.times','last time matching declared frame time base');if(!event.seek)event.seek=first;if(!event.timeInterval&&last)event.timeInterval={start:first.time,end:last.time,endKind:'frame'};}}
      if(!event.frames&&!event.times&&!event.seek)fail(where,'frame/frames or explicit t/times event coordinates');
      event.timing=event.seek?'mapped':event.frames?'frames-unmapped':'unavailable';return event;
    });
    report.categories.push({field,state:events.length?'events':'empty',events});
  }
  return report;
}
