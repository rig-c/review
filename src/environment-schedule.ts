/**
 * The Environment block's wind as a `rigc-environment/1` schedule (issue #112): what `rigc render --environment` and
 * `rig-parts check --environment` (@rig-c/parts 1.48.0, parts#538) read — `{spec, steps: [{t, wind?, gravity?}]}`, each
 * step holding from its `t` until the next, x right and y down, the runtime's wind [1, 0] and gravity [0, 1] before the
 * first. Pure: no DOM, no IO, no clock.
 *
 * The panel's wind (`./environment.ts`) is `base + breeze(t) + gust(t)` on a clock the player's steps advance. From a
 * fresh clock (`restore`, which starts a repeating gust at 0) that is a function of time alone, so a schedule can carry
 * it with t = 0 at the animation's first frame:
 *  - the step form (no breeze, no repeating gust): one step, the standing world — exact;
 *  - the sampled form (breeze and/or repeat on): one step per frame of the render's grid (`SCHEDULE_FPS`), each the
 *    panel's wind at that frame's time. rigc sets a step before the physics step that poses its frame, as the panel sets
 *    the wind before the player's step, so the two agree at every frame time; between frames rigc holds the frame's
 *    value, within `scheduleTolerance` of the panel's.
 * A one-off Gust (Repeat off) is an event on the live clock, not part of the settings, and is not in the schedule.
 */
import { breezeAt, gustEnvelope, gustPeriod, type WindSnapshot } from './environment.ts';

export const ENVIRONMENT_SPEC = 'rigc-environment/1';
/** The grid the schedule is sampled on: `rigc render`'s default fps and `rig-parts check`'s IDLE_FPS. */
export const SCHEDULE_FPS = 12;
/** At most this many steps (50 s at 12 fps, ~36 KiB of JSON); a longer clip is refused by name. */
export const MAX_SCHEDULE_STEPS = 600;
/** The first `@rig-c/parts` release whose `check` reads `--environment` (its CHANGELOG: 1.48.0, parts#538). */
export const CHECK_ENVIRONMENT_SINCE = '1.48.0';
/** The runtime's world before the first step (rig-c `src/environment.ts`). */
export const RUNTIME_WORLD = { wind: [1, 0] as [number, number], gravity: [0, 1] as [number, number] };

export interface EnvironmentStep { t: number; wind?: [number, number]; gravity?: [number, number] }
export interface EnvironmentSchedule { spec: typeof ENVIRONMENT_SPEC; steps: EnvironmentStep[] }
export class ScheduleError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }

/** The standing world as one step from t = 0 (#108's readings schedule; the step form below is this). */
export const standingSchedule = (e: { wind: [number, number]; gravity: [number, number] }): EnvironmentSchedule => ({ spec: ENVIRONMENT_SPEC, steps: [{ t: 0, wind: e.wind, gravity: e.gravity }] });

/** The panel's wind at clock time `t` from a fresh clock (`createWindModel().restore(snapshot)`, then advanced to `t`). */
export function windAt(s: WindSnapshot, t: number): number {
  const gentle = s.breeze ? breezeAt(t) : 0;
  let gust = 0;
  if (s.repeat) {
    const period = gustPeriod(s.gustDuration), age = t - Math.floor(t / period) * period;
    gust = (s.base < 0 ? -1 : 1) * gustEnvelope(age, s.gustPeak, s.gustDuration);
  }
  return s.base + gentle + gust;
}
/** Whether the wind changes in time (breeze or a repeating gust): the sampled form. */
export const windVaries = (s: WindSnapshot) => s.breeze || (s.repeat && s.gustPeak > 0);
/**
 * The largest difference between the panel's wind and the schedule's held value inside one frame interval:
 * max |dw/dt| / fps, with |breeze'| <= 2·2.2 + 0.8·5.1 and |gust'| <= peak·π / duration. 0 for the step form.
 */
export function scheduleTolerance(s: WindSnapshot, fps = SCHEDULE_FPS): number {
  if (!windVaries(s)) return 0;
  return ((s.breeze ? 2 * 2.2 + 0.8 * 5.1 : 0) + (s.repeat ? s.gustPeak * Math.PI / s.gustDuration : 0)) / fps;
}

export type ScheduleForm = 'step' | 'sampled';
export interface WindScheduleExport { schedule: EnvironmentSchedule; form: ScheduleForm; tolerance: number; fps: number; duration: number }
/**
 * The panel's settings and gravity (the slider's value, applied as [0, g]) as a schedule over a clip of `duration`
 * seconds: the step form when nothing varies, else one step per frame of `fps` up to the clip's last frame (rigc refuses a
 * step after it), a step whose wind equals the one before left out.
 */
export function windSchedule(s: WindSnapshot, gravity: number, duration: number, fps = SCHEDULE_FPS): WindScheduleExport {
  const g: [number, number] = [0, gravity];
  if (!windVaries(s)) return { schedule: standingSchedule({ wind: [s.base, 0], gravity: g }), form: 'step', tolerance: 0, fps, duration };
  if (!(duration > 0) || !Number.isFinite(duration)) throw new ScheduleError('ENVIRONMENT_SCHEDULE_NO_CLIP', 'a breeze or a repeating gust is sampled over a clip; no clip with a duration is drawn');
  const last = Math.round(duration * fps);
  if (last + 1 > MAX_SCHEDULE_STEPS) throw new ScheduleError('ENVIRONMENT_SCHEDULE_TOO_LONG', `${duration} s at ${fps} fps is ${last + 1} steps; at most ${MAX_SCHEDULE_STEPS}`);
  const steps: EnvironmentStep[] = [];
  let previous = NaN;
  for (let k = 0; k <= last; k++) {
    const t = k / fps, w = windAt(s, t);
    if (k === 0) steps.push({ t, wind: [w, 0], gravity: g });
    else if (w !== previous) steps.push({ t, wind: [w, 0] });
    previous = w;
  }
  return { schedule: { spec: ENVIRONMENT_SPEC, steps }, form: 'sampled', tolerance: scheduleTolerance(s, fps), fps, duration };
}

/** The exported bytes: what is downloaded, written for rigc and rig-parts, and hashed into feedback. */
export const scheduleText = (s: EnvironmentSchedule) => JSON.stringify(s, null, 1) + '\n';

const bad = (detail: string): never => { throw new ScheduleError('ENVIRONMENT_SCHEDULE_INVALID', detail); };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pair = (v: unknown, field: string): [number, number] => {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e4)) bad(`${field} must be [x, y], finite`);
  return [(v as number[])[0]!, (v as number[])[1]!];
};
/** A schedule as rig-c's reader takes it (exact keys, ascending t from 0, a half stated per step), bounded; data only. */
export function parseSchedule(value: unknown): EnvironmentSchedule {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'spec,steps') return bad('expected exactly {spec, steps}');
  if (value.spec !== ENVIRONMENT_SPEC) bad(`spec must be ${ENVIRONMENT_SPEC}`);
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > MAX_SCHEDULE_STEPS) bad(`steps must hold 1–${MAX_SCHEDULE_STEPS} entries`);
  const steps: EnvironmentStep[] = [];
  (value.steps as unknown[]).forEach((raw, i) => {
    if (!isRecord(raw) || !Object.keys(raw).every(k => k === 't' || k === 'wind' || k === 'gravity')) bad(`steps[${i}] holds only t, wind, gravity`);
    const step = raw as Record<string, unknown>, t = step.t;
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 3600) bad(`steps[${i}].t must be seconds in [0, 3600]`);
    if (i > 0 && !((t as number) > steps[i - 1]!.t)) bad(`steps[${i}].t must come after steps[${i - 1}].t`);
    if (step.wind === undefined && step.gravity === undefined) bad(`steps[${i}] states neither wind nor gravity`);
    steps.push({ t: t as number, ...(step.wind === undefined ? {} : { wind: pair(step.wind, `steps[${i}].wind`) }), ...(step.gravity === undefined ? {} : { gravity: pair(step.gravity, `steps[${i}].gravity`) }) });
  });
  return { spec: ENVIRONMENT_SPEC, steps };
}

/** rig-c's `environmentFrame`: the first frame `i` whose time `i / fps` is at or after `t`. */
export function environmentFrame(t: number, fps: number): number {
  let i = Math.max(0, Math.ceil(t * fps));
  while (i > 0 && (i - 1) / fps >= t) i--;
  while (i / fps < t) i++;
  return i;
}
/**
 * The world as rigc reads the schedule at time `t` on the `fps` grid: the physics step that ends on frame
 * `environmentFrame(t)` runs under every step that lands on that frame or before (the runtime's world before the first).
 */
export function scheduleWorldAt(s: EnvironmentSchedule, t: number, fps = SCHEDULE_FPS): { wind: [number, number]; gravity: [number, number] } {
  const frame = environmentFrame(t, fps);
  let wind = RUNTIME_WORLD.wind, gravity = RUNTIME_WORLD.gravity;
  for (const step of s.steps) { if (environmentFrame(step.t, fps) > frame) break; if (step.wind) wind = step.wind; if (step.gravity) gravity = step.gravity; }
  return { wind, gravity };
}

/** One line: form, steps, the hash's first 16 hex (as check's `environment:` line prints it), the tolerance. */
export function scheduleSummary(e: WindScheduleExport, sha256: string): string {
  const form = e.form === 'step' ? 'step form (exact)' : `sampled at ${e.fps} fps over ${e.duration.toFixed(3)} s (held between frames, within ${e.tolerance.toFixed(3)} of the panel)`;
  return `${ENVIRONMENT_SPEC}, ${e.schedule.steps.length} step(s), sha256 ${sha256.slice(0, 16)} · ${form}`;
}

/** `context.environmentSchedule` (#112): the exported bytes by hash and content, and whether readings and Apply used them. */
export const SCHEDULE_CONTEXT_SCHEMA = 'rig-review-environment-schedule/1';
export interface ScheduleContext { schema: typeof SCHEDULE_CONTEXT_SCHEMA; sha256: string; size: number; text: string; usedForReadings: boolean }
const ctx = (detail: string): never => { throw new Error(`feedback.context.environmentSchedule: ${detail}`); };
/** The context's exact shape, its sha256 recomputed over `text` (`hash` is the caller's) and `text` a schedule. */
export function parseScheduleContext(value: unknown, hash: (text: string) => string): ScheduleContext | null {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'schema,sha256,size,text,usedForReadings') return ctx('expected exactly {schema, sha256, size, text, usedForReadings}');
  if (value.schema !== SCHEDULE_CONTEXT_SCHEMA) ctx(`schema must be ${SCHEDULE_CONTEXT_SCHEMA}`);
  if (typeof value.text !== 'string' || value.text.length > 128 * 1024) ctx('text must be the exported schedule, at most 128 KiB');
  const text = value.text as string;
  if (typeof value.sha256 !== 'string' || value.sha256 !== hash(text)) ctx('sha256 is not the sha256 of text');
  if (value.size !== new TextEncoder().encode(text).length) ctx('size is not the byte length of text');
  if (typeof value.usedForReadings !== 'boolean') ctx('usedForReadings must be a boolean');
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return ctx('text does not parse as JSON'); }
  try { parseSchedule(doc); } catch (e) { ctx(`text is not a ${ENVIRONMENT_SPEC} schedule (${e instanceof Error ? e.message : String(e)})`); }
  return value as unknown as ScheduleContext;
}
/** "41 step(s) · sha256 … · used for readings": one line for the issue export. */
export function scheduleContextLine(value: unknown): string | null {
  if (!isRecord(value) || value.schema !== SCHEDULE_CONTEXT_SCHEMA || typeof value.sha256 !== 'string' || typeof value.text !== 'string') return null;
  let steps = 0;
  try { const doc = JSON.parse(value.text) as { steps?: unknown[] }; steps = Array.isArray(doc.steps) ? doc.steps.length : 0; } catch { return null; }
  return `${ENVIRONMENT_SPEC}, ${steps} step(s) · schedule sha256 ${value.sha256}${value.usedForReadings ? ' · used for readings and Apply' : ' · not used for readings'}`;
}

/** SHA-256 of a string's UTF-8 bytes, hex — synchronous, so the page can hash the exported bytes where it records them. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text), K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = Math.ceil((bytes.length + 9) / 64) * 64, m = new Uint8Array(length);
  m.set(bytes); m[bytes.length] = 0x80;
  const view = new DataView(m.buffer), bits = bytes.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 0x100000000)); view.setUint32(length - 4, bits >>> 0);
  const w = new Uint32Array(64), rot = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) { const a = w[i - 15]!, b = w[i - 2]!; w[i] = (w[i - 16]! + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) >>> 0; }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rot(e!, 6) ^ rot(e!, 11) ^ rot(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rot(a!, 2) ^ rot(a!, 13) ^ rot(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a!; h[1] += b!; h[2] += c!; h[3] += d!; h[4] += e!; h[5] += f!; h[6] += g!; h[7] += hh!;
  }
  return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}
