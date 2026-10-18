/** Explicit producer clock only. No duration, event spacing or video-rate fallback. */
export type FrameClock =
  | {kind:'uniform';fps:number;frame0:number;frameCount?:number}
  | {kind:'samples';frameTimes:number[]};

/** Source-only time remains usable; a player must identify the matching output. */
export function clockForAnimation(clock:FrameClock|null|undefined,animation:string|undefined,activeAnimation:string,hasPlayer=true):FrameClock|null {
  if(!clock)return null;
  return !hasPlayer||(animation&&animation===activeAnimation)?clock:null;
}

export function lastFrame(clock:FrameClock|null|undefined):number|null {
  if(!clock)return null;
  const count=clock.kind==='samples'?clock.frameTimes.length:clock.frameCount;
  return count!==undefined&&Number.isSafeInteger(count)&&count>0?count-1:null;
}

/** Return exactly the declared sample time; invalid/noninteger frames stay unknown. */
export function timeAtFrame(clock:FrameClock|null|undefined,frame:number):number|null {
  const last=lastFrame(clock);
  if(!clock||last===null||!Number.isSafeInteger(frame)||frame<0||frame>last)return null;
  const time=clock.kind==='samples'?clock.frameTimes[frame]!:clock.frame0+frame/clock.fps;
  return Number.isFinite(time)?time:null;
}

/** The latest sample at or before time, only inside the closed declared domain. */
export function frameAtTime(clock:FrameClock|null|undefined,time:number):number|null {
  const last=lastFrame(clock);if(last===null||!Number.isFinite(time))return null;
  const firstTime=timeAtFrame(clock,0),lastTime=timeAtFrame(clock,last);
  if(firstTime===null||lastTime===null||time<firstTime||time>lastTime)return null;
  // Search the declared times directly: avoids both interpolation and floating
  // multiplication rounding a mathematically exact uniform sample down a frame.
  let low=0,high=last;
  while(low<=high){const middle=low+Math.floor((high-low)/2);const sample=timeAtFrame(clock,middle);if(sample===null)return null;if(sample<=time)low=middle+1;else high=middle-1;}
  return high>=0?high:null;
}
