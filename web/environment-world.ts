/**
 * The Environment block's "Use for readings" (issue #112), the DOM-free half: the controls as the exported
 * `rigc-environment/1` schedule for a clip, its bytes and their hash, the feedback context that carries them, and the
 * "Check under this world" rows (each readout bar under the default world beside the same bar under this one).
 */
import { scheduleSummary, scheduleText, sha256Hex, SCHEDULE_CONTEXT_SCHEMA, windSchedule, ScheduleError, type EnvironmentSchedule, type ScheduleContext, type WindScheduleExport } from '../src/environment-schedule.ts';
import type { WindSnapshot } from '../src/environment.ts';
import type { CheckSummary } from '../src/applied-context.ts';
import { READOUT_BARS } from '../src/physics-tuning.ts';

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
