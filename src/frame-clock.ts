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

/** One animation's clock from the package's declared `rigc-frames/1` record (#1018). */
export interface DeclaredFrameClock {animation:string;clock:FrameClock}

/**
 * A `rigc-frames/1` set's clock (#1018): `written` frames, frame `i` at `i * stride / fps` seconds. The set is
 * checked against the compiled model's animation when the package loads; this only states the schedule.
 */
export function framesSetClock(set:{fps:number;written:number;stride:number}):FrameClock {
  return {kind:'uniform',fps:set.fps/set.stride,frame0:0,frameCount:set.written};
}

/**
 * The transport's clock. The package report's clock when it names the active animation; else, with a player, the
 * clock the package's declared frame record states for the active animation (#1018); else the clock the build on
 * the stage states for the active animation (#164: a retarget's own report frameTimes). The stage clock binds by
 * animation and by the drawn model's hash, so a reset or another rebuild drops it. The report and the record are the
 * package's own clocks, the ones the server validates a comment against, so they come before the page-only stage.
 */
export function transportClock(report:{clock:FrameClock|null|undefined;animation:string|undefined;frameClocks?:readonly DeclaredFrameClock[]|null|undefined},active:string,hasPlayer:boolean,stage:StageClock|null,stageModelHash:string|null):{clock:FrameClock;source:'report'|'frames'|'stage'}|null {
  const own=clockForAnimation(report.clock,report.animation,active,hasPlayer);if(own)return {clock:own,source:'report'};
  const declared=hasPlayer&&active?report.frameClocks?.find(value=>value.animation===active):undefined;if(declared)return {clock:declared.clock,source:'frames'};
  if(hasPlayer&&stage&&active&&stage.animation===active&&stage.modelHash===stageModelHash)return {clock:stage.clock,source:'stage'};
  return null;
}

export const formatFixed=(value:number,digits=3):string=>(Object.is(value,-0)?0:value).toFixed(digits);

/** The rig pane's header: the animation, frame and time the drawn pose is at — the transport's clock, the one a seek sets. */
export function rigPaneLabel(state:{hasPlayer:boolean;animation:string;time:number;frame:number|null}):string {
  if(!state.hasPlayer)return 'Generated rig · read only';
  return ['Generated rig',state.animation||'no animation',...(state.frame===null?[]:[`F${state.frame}`]),`${formatFixed(state.time)} s`].join(' · ');
}
