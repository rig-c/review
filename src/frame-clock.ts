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

/** The most frame times a scratch build's report may state (a bound for the served job, not a timing claim). */
export const MAX_STAGE_FRAME_TIMES=100_000;

/** A producer report's `frameTimes`, kept only when it is a bounded, finite, strictly increasing list; else null. */
export function samplesClock(times:unknown):FrameClock|null {
  if(!Array.isArray(times)||!times.length||times.length>MAX_STAGE_FRAME_TIMES)return null;
  for(let i=0;i<times.length;i++){const t=times[i];if(typeof t!=='number'||!Number.isFinite(t)||(i>0&&t<=times[i-1]))return null;}
  return {kind:'samples',frameTimes:[...times as number[]]};
}

/** The clock a scratch build states for one of its animations (a retarget's `motion.report.json`), bound to that build. */
export interface StageClock {animation:string;modelHash:string;clock:FrameClock}

/**
 * The transport's clock. The package report's clock when it names the active animation; else, with a player, the
 * clock the build on the stage states for the active animation (#164: a retarget's own report frameTimes). The
 * stage clock binds by animation and by the drawn model's hash, so a reset or another rebuild drops it.
 */
export function transportClock(report:{clock:FrameClock|null|undefined;animation:string|undefined},active:string,hasPlayer:boolean,stage:StageClock|null,stageModelHash:string|null):{clock:FrameClock;source:'report'|'stage'}|null {
  const own=clockForAnimation(report.clock,report.animation,active,hasPlayer);if(own)return {clock:own,source:'report'};
  if(hasPlayer&&stage&&active&&stage.animation===active&&stage.modelHash===stageModelHash)return {clock:stage.clock,source:'stage'};
  return null;
}

/** The rig pane's header: the animation, frame and time the drawn pose is at — the transport's clock, the one a seek sets. */
export function rigPaneLabel(state:{hasPlayer:boolean;animation:string;time:number;frame:number|null}):string {
  if(!state.hasPlayer)return 'Generated rig · read only';
  return ['Generated rig',state.animation||'no animation',...(state.frame===null?[]:[`F${state.frame}`]),`${state.time.toFixed(3)} s`].join(' · ');
}
