/**
 * The Environment block's "Use for readings" (issue #112), the controls as the exported
 * `rigc-environment/1` schedule for a clip, its bytes and their hash, the feedback context that carries them, and the
 * "Check under this world" rows (each readout bar under the default world beside the same bar under this one).
 */
import { scheduleSummary, scheduleText, sha256Hex, SCHEDULE_CONTEXT_SCHEMA, windSchedule, ScheduleError, type EnvironmentSchedule, type ScheduleContext, type WindScheduleExport } from '../src/environment-schedule.ts';
import { dueJolts, environmentFor, type JoltStep, type WindModel, type WindSnapshot, type WindState } from '../src/environment.ts';
import type { RigPlayer } from '@rig-c/play';
import type { CheckSummary } from '../src/applied-context.ts';
import { barLine, beforeLine, READOUT_BARS, type InspectedCheckView } from '../src/physics-tuning.ts';
import { jsonPost, refusalBodyText, type BaselineView, type ScopedJobUiSink } from './rebuild-client.ts';

/** The world an Apply's reload resumes: wind (clock and active pulse), pending jolts, whether the controls are engaged, gravity. */
export interface StageWorld { wind: WindState; jolts: JoltStep[]; applied: boolean; gravity: number }

export function bindEnvironmentInputs(
  input: (id: string) => Pick<HTMLInputElement, 'checked' | 'value'>,
  wind: Pick<WindModel, 'snapshot' | 'state' | 'advance' | 'read'>,
  readJolts: () => readonly JoltStep[],
  renderEnvironment: () => void,
) {
  const environmentApplied = (): boolean => input('environment-applied').checked;
  const gravityValue = (): number => Number(input('gravity').value);
  /**
   * #112 · Use for readings: the controls as the exported `rigc-environment/1` schedule (src/environment-schedule.ts). While
   * on, readings send the drawn clip's schedule, Apply's check reads the checked clip's (`idle` when the rig has one, as
   * `rig-parts check` renders it), and the wind clock restarts with the clip so the person watches the world rigc reads.
   */
  const useWorld = (): boolean => input('environment-use').checked && environmentApplied();
  /** The world as it stands now: what a physics Apply's reload resumes. */
  const stageWorld = (): StageWorld => ({
    wind: wind.state(), jolts: readJolts().map(step => ({ ...step })), applied: environmentApplied(), gravity: gravityValue(),
  });
  function syncEnvironmentInputs(): void {
    const s = wind.snapshot();
    input('wind-base').value = String(s.base);
    input('wind-breeze').checked = s.breeze;
    input('wind-repeat').checked = s.repeat;
    input('wind-gust-peak').value = String(s.gustPeak);
    input('wind-gust-duration').value = String(s.gustDuration);
    renderEnvironment();
  }
  /** Called from `tick` right before the fixed playback steps (#346): the gust clock is the stepped time, so a paused player freezes it. */
  function stepEnvironment(
    dt: number,
    readPlayer: () => Pick<RigPlayer, 'moved' | 'environment'> | null | undefined,
    writeJolts: (pending: JoltStep[]) => void,
  ): void {
    if (!readPlayer()) return;
    wind.advance(dt);
    const { due, pending } = dueJolts(readJolts(), wind.read().time);
    writeJolts(pending);
    // Rig reads its live player for each call; Compare supplies the player it picked for the step.
    for (const step of due) readPlayer()!.moved({ x: step.x, y: step.y });
    if (environmentApplied()) readPlayer()!.environment(environmentFor(wind.read(), gravityValue()));
    renderEnvironment();
  }
  return { environmentApplied, gravityValue, useWorld, stageWorld, syncEnvironmentInputs, stepEnvironment };
}

/** The clip `rig-parts check` poses its idle readings over: `idle` when the rig has one, else the drawn clip. */
export function checkAnimation(animations: readonly { name: string }[] | undefined, drawnClip: () => string): string {
  return animations?.some(item => item.name === 'idle') ? 'idle' : drawnClip();
}

export const ENVIRONMENT_NOT_APPLIED = 'ENVIRONMENT_NOT_APPLIED: the player stands at the runtime start values (wind [1, 0], gravity [0, 1]), which check and render read without --environment; move a control first';
export interface WorldExport { export: WindScheduleExport; schedule: EnvironmentSchedule; text: string; sha256: string; summary: string; animation: string }
/** The controls as a schedule over `animation` (`duration` s), or why there is none. */
export function worldExport(snapshot: WindSnapshot, gravity: number, applied: boolean, animation: string, duration: number): WorldExport | { error: string } {
  if (!applied) return { error: ENVIRONMENT_NOT_APPLIED };
  try {
    const e = windSchedule(snapshot, gravity, duration), text = scheduleText(e.schedule), sha256 = sha256Hex(text);
    return { export: e, schedule: e.schedule, text, sha256, summary: scheduleSummary(e, sha256), animation };
  } catch (error) { if (error instanceof ScheduleError) return { error: error.message }; throw error; }
}
export const scheduleContext = (w: WorldExport, used: boolean): ScheduleContext => ({ schema: SCHEDULE_CONTEXT_SCHEMA, sha256: w.sha256, size: new TextEncoder().encode(w.text).length, text: w.text, usedForReadings: used });

/** `POST /api/environment-check`'s job as the page reads it. */
export interface EnvironmentCheckView {
  id: string; status: 'running' | 'checked' | 'refused' | 'failed'; build: 'inspected' | 'scratch'; buildId: string | null;
  schedule: { sha256: string; size: number; steps: number }; producer: { package: string; version: string };
  exitCode: number | null; wallMs: number | null; check: CheckSummary | null;
  environment: { path: string; sha256: string; steps: number } | null; environmentLine: string | null;
  bars: { name: string; line: string }[]; error: string | null; lines: string[];
}
export interface EnvironmentRow { kind: 'label' | 'bar' | 'error'; text: string }

function renderEnvironmentCheckRows(out:HTMLElement,rows:readonly EnvironmentRow[]):void {
 out.replaceChildren(...rows.map(row=>{
  const line=document.createElement('div');line.className=`env-${row.kind}`;line.textContent=row.text;return line;
 }));
}

type EnvironmentCheckResult=EnvironmentCheckView|{status:'refused';error:string}|null;
const checkErrorText=(error:unknown)=>error instanceof Error?error.message:String(error);

export function bindEnvironmentCheck({
 api,path,ui,out,paintBusy,busy,setBusy,animation,worldFor,applied,before,baseline,inspected,follow,scratchLabel,missingDefault,
 initial,progress,guardRevisions,
}:{
 api:<T>(path:string,init?:RequestInit)=>Promise<T>;path:string;ui:ScopedJobUiSink;
 out:()=>HTMLElement;paintBusy:(value:boolean)=>void;busy:()=>boolean;setBusy:(value:boolean)=>void;
 animation:()=>string;worldFor:(name:string)=>WorldExport|{error:string};applied:()=>boolean;
 before:()=>{lines:readonly string[];check:CheckSummary|null}|null;baseline:()=>BaselineView|null|undefined;
 inspected:()=>InspectedCheckView|null;follow:(show:()=>void)=>Promise<void>;
 scratchLabel:()=>string;missingDefault:(name:string,line:string)=>string;
 initial:(name:string,build:EnvironmentCheckView['build'],world:WorldExport)=>string;
 progress?:(build:EnvironmentCheckView['build'],job:EnvironmentCheckView,started:number)=>string;
 guardRevisions?:boolean;
}):()=>Promise<EnvironmentCheckResult> {
 let latest=0;
 const key='environment-check';
 const updateBusy=(value:boolean)=>{setBusy(value);ui.projectBusy(key,value,paintBusy);};
 return async()=>{
  if(busy())return null;
  const revision=++latest,node=out();
  const clear=()=>node.replaceChildren();
  const show=(rows:EnvironmentRow[])=>renderEnvironmentCheckRows(node,rows);
  const outcome=(rows:EnvironmentRow[])=>{
   if(!guardRevisions||revision===latest)ui.outcome(key,()=>show(rows),clear);
  };
  const label=(text:string)=>ui.transient(key,()=>show([{kind:'label',text}]),clear);
  ui.clearOutcome(key);
  const name=animation(),world=worldFor(name),build=applied()?'scratch':'inspected',original=before();
  if('error' in world){outcome([{kind:'error',text:world.error}]);return {status:'refused',error:world.error};}
  updateBusy(true);label(initial(name,build,world));
  try{
   let job=await api<EnvironmentCheckView|{status:'refused';error:string}>(path,jsonPost({build,schedule:world.schedule}))
    .catch(error=>({status:'refused' as const,error:checkErrorText(error).replace(/^\d+: /,'')}));
   if(!('id' in job)){
    const text=refusalBodyText(job.error);
    outcome([{kind:'error',text}]);
    return {status:'refused',error:text};
   }
   const started=performance.now();
   while(job.status==='running'){
    if(progress)label(progress(build,job,started));
    await new Promise(resolve=>setTimeout(resolve,1500));
    job=await api<EnvironmentCheckView>(`${path}/${job.id}`);
   }
   const checked=job,currentBaseline=baseline();
   const readoutLabel=build==='inspected'?'default world (the inspected build\'s own check)':scratchLabel();
   // No inspected check exists when the baseline did not reproduce the inspected rig; say why, verbatim (a schedule of wind [1, 0], gravity [0, 1] reads the default world).
   const noDefault=build==='inspected'&&!inspected()&&currentBaseline&&currentBaseline.status!=='running'&&currentBaseline.status!=='reproduced';
   const draw=()=>outcome(environmentCheckRows(checked,name=>noDefault?missingDefault(name,currentBaseline.line)
    :build==='inspected'?beforeLine(name,null,inspected()):barLine(name,original?.lines??null,original?.check??null),readoutLabel));
   draw();
   // The follow-up may finish offside. The sink retains its terminal outcome for the origin.
   if(build==='inspected'&&inspected()?.status!=='checked')void follow(draw);
   return job;
  }catch(error){outcome([{kind:'error',text:`ENVIRONMENT_CHECK_FAILED: ${checkErrorText(error)}`}]);return null;}
  finally{updateBusy(false);}
 };
}

/** The panel's lines: which schedule check read, then per bar the default world's line and this world's, or the refusal verbatim. */
export function environmentCheckRows(job: EnvironmentCheckView, defaultLine: (name: string) => string, defaultLabel: string): EnvironmentRow[] {
  if (job.status !== 'checked') return [{ kind: 'error', text: job.error ?? `ENVIRONMENT_CHECK_FAILED: ${job.status}` }];
  const rows: EnvironmentRow[] = [{ kind: 'label', text: `${job.build} build · ${job.producer.package} ${job.producer.version} check --environment · ${job.environmentLine ?? `check.json environment sha256 ${job.environment?.sha256 ?? '?'}`}${job.wallMs !== null ? ` · ${(job.wallMs / 1000).toFixed(1)} s` : ''}` }];
  for (const name of READOUT_BARS) {
    rows.push({ kind: 'label', text: `${defaultLabel}: ${defaultLine(name)}` });
    rows.push({ kind: 'bar', text: `this world: ${job.bars.find(b => b.name === name)?.line ?? `${name}: not in check summary`}` });
  }
  if (job.check?.line) rows.push({ kind: 'label', text: `this world · ${job.check.line}` });
  return rows;
}

/**
 * #183: a move of the drawn clip, as the page makes it — another animation chosen, a seek (scrub, cue, reading, control),
 * a replay from the end (Play after the clip ended, idle repeat's loop), or an Apply's reload, which keeps the animation
 * and time and resumes the world it had.
 */
export type ClipMove = { kind: 'choose' } | { kind: 'seek'; to: number } | { kind: 'replay' } | { kind: 'reload' };
/**
 * Whether the move restarts the clip and so, while the schedule is watched (Use for readings), the wind clock restarts
 * with it: the exported schedule starts at t = 0 on the clip's first frame, so the stage must too.
 */
export function restartsWindClock(move: ClipMove, watched: boolean): boolean {
  if (!watched) return false;
  return move.kind === 'choose' || move.kind === 'replay' || (move.kind === 'seek' && move.to <= 0);
}
/**
 * #935: the wind clock time a clip move sets, or null to leave the running clock alone. A clip restart while the
 * schedule is watched sets 0 (#183); a paused seek to T sets T whatever is watched, so a paused frame is a function of T
 * and the world (a fresh clock advanced to T, the schedule's wind at T). During playback the clock runs on unchanged.
 */
export function windClockOnMove(move: ClipMove, watched: boolean, playing: boolean): number | null {
  if (restartsWindClock(move, watched)) return 0;
  return move.kind === 'seek' && !playing ? move.to : null;
}

/** Rebase the wind and queued jolts to a new clip-clock position. */
export function resetWindClock(wind: WindModel, jolts: readonly JoltStep[], at = 0): JoltStep[] {
  const previous = wind.read().time;
  wind.restore(wind.snapshot());
  if (at > 0) wind.advance(at);
  return jolts.map(step => ({ ...step, at: Math.max(0, step.at - previous) + at }));
}
