/** Both inspection players reopen on exactly the same fixed-step history. */
import { frameAtTime, type FrameClock } from './frame-clock.ts';

export const compareSeekStep = 1 / 60;
export interface CompareDomain { start: 0; end: number }
export interface ReferenceSample { time: number; source: 'video-frame' | 'current-time' }
export interface InspectionPlayer { readonly time: number; pause(): void; seek(time: number): void; draw(): void }
export interface CompareTrace { reference: number; a: number; b: number; source: ReferenceSample['source'] }

/** Feedback can describe only a successfully synchronized inspection state. */
export function feedbackTrace(ready: boolean, seeking: boolean, trace: CompareTrace | null): CompareTrace | null {
  return ready && !seeking ? trace : null;
}

/** Runtime accumulation may differ by an admitted ULP; the validated master
 * mediaTime is the timestamp each side's explicit producer clock interprets. */
export function inspectionFrame(clock: FrameClock | null | undefined, trace: CompareTrace | null): number | null {
  return trace ? frameAtTime(clock, trace.reference) : null;
}

export function commonDomain(referenceDuration: number, aDuration: number, bDuration: number): CompareDomain {
  for (const [name, value] of [['reference', referenceDuration], ['a', aDuration], ['b', bDuration]] as const) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`compare ${name} duration: expected finite seconds >= 0`);
  }
  return { start: 0, end: Math.min(referenceDuration, aDuration, bDuration) };
}

export function requireCommonTime(time: number, domain: CompareDomain): void {
  if (!Number.isFinite(time) || time < domain.start || time > domain.end) throw new Error(`compare time ${time}: outside shared domain ${domain.start}–${domain.end} s`);
}

/** No frame(dt), resume, per-side clamp or loop exists on this inspection path. */
export function prepareSynchronizedPair(sample: ReferenceSample, a: InspectionPlayer, b: InspectionPlayer, domain: CompareDomain): CompareTrace {
  requireCommonTime(sample.time, domain);
  a.pause(); b.pause();
  // Prepare both poses before either draw. A refusal is a failed pair, never a
  // success trace made by copying the requested time into the returned values.
  a.seek(sample.time); b.seek(sample.time);
  const trace = { reference: sample.time, a: a.time, b: b.time, source: sample.source };
  if (![trace.a, trace.b].every(Number.isFinite) || Math.abs(trace.a - sample.time) > 1e-9 || Math.abs(trace.b - sample.time) > 1e-9 || trace.a !== trace.b) throw new Error(`compare playhead mismatch: reference=${trace.reference}, a=${trace.a}, b=${trace.b}`);
  return trace;
}

export function drawSynchronizedPair(a:InspectionPlayer,b:InspectionPlayer):void {a.draw();b.draw();}

export function seekSynchronizedPair(sample: ReferenceSample,a:InspectionPlayer,b:InspectionPlayer,domain:CompareDomain):CompareTrace {
 const trace=prepareSynchronizedPair(sample,a,b,domain);drawSynchronizedPair(a,b);return trace;
}

/** The browser adapter resolves only after the reference seek has completed. */
export async function seekAfterReference(requested: number, seekReference: (time: number) => Promise<ReferenceSample>, a: InspectionPlayer, b: InspectionPlayer, domain: CompareDomain): Promise<CompareTrace> {
  requireCommonTime(requested, domain);
  const presented = await seekReference(requested);
  return seekSynchronizedPair(presented, a, b, domain);
}
