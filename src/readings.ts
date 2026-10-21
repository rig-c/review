/**
 * Readings as watch instruments (issue #108): the installed compiler's own readings — `rigc render --folds`,
 * `--pass-through <cloth>:<leg>`, `--seam <slot>:<slot>`, `--overlaps`, `--angle-range <bone>:<relative-to>` — run on
 * the inspected build and on the latest scratch build, and their results become timeline ticks and one worst-frame line
 * per pair. Pure: typed requests to argv (every path the server's), the JSON each reading writes (and, for
 * `--angle-range`, which writes nothing, its printed line) to frames and a worst frame, and rigc's refusal line verbatim.
 * Review judges nothing here: a reading is not a gate, and an unknown slot or bone is rigc's to refuse.
 */
import { firstRefusal } from './producer.ts';
import { parseSchedule, ScheduleError, standingSchedule, type EnvironmentSchedule } from './environment-schedule.ts';

export const READINGS_SCHEMA = 'rig-review-readings/1';
/** The first `rig-c` release with all five readings (its CHANGELOG: 2.63.0, "render: --overlaps names which slot covers which"). */
export const READINGS_SINCE = '2.63.0';
export const MAX_READINGS = 8;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export type ReadingRequest =
  | { kind: 'folds' }
  | { kind: 'overlaps' }
  | { kind: 'pass-through'; cloth: string; leg: string }
  | { kind: 'seam'; a: string; b: string }
  | { kind: 'angle-range'; bone: string; relative: string };
export type ReadingKind = ReadingRequest['kind'];
export const READING_KINDS: readonly ReadingKind[] = ['folds', 'pass-through', 'seam', 'overlaps', 'angle-range'];
/** The world the physics answers while the readings are posed: the Environment block's wind and gravity as they stand (x right, y down). */
export interface ReadingEnvironment { wind: [number, number]; gravity: [number, number] }
/** #112: with "Use for readings" on, the Environment block's exported `rigc-environment/1` schedule goes in its place. */
export interface ReadingsRequest { animation: string; readings: ReadingRequest[]; environment: ReadingEnvironment | EnvironmentSchedule | null }

export class ReadingsError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new ReadingsError('READINGS_REQUEST_INVALID', detail); };
const record = (value: unknown, field: string): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad(`${field} must be an object`));
const exactly = (v: Record<string, unknown>, keys: string[], field: string) => { if (Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) bad(`${field} holds exactly ${keys.join(', ')}`); };
/** A slot or bone name as rigc's list syntax can carry it (no `:` or `,`, no leading `-`); whether the rig has it is rigc's to say. */
const name = (value: unknown, field: string): string => (typeof value === 'string' && NAME.test(value) ? value : bad(`${field} must be a slot or bone name`));
const pair = (value: unknown, field: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e4)) bad(`${field} must be [x, y], finite`);
  const [x, y] = value as [number, number];
  return [x, y];
};

export function parseReading(value: unknown, field: string): ReadingRequest {
  const v = record(value, field);
  switch (v.kind) {
    case 'folds': case 'overlaps': exactly(v, ['kind'], field); return { kind: v.kind };
    case 'pass-through': exactly(v, ['kind', 'cloth', 'leg'], field); return { kind: 'pass-through', cloth: name(v.cloth, `${field}.cloth`), leg: name(v.leg, `${field}.leg`) };
    case 'seam': exactly(v, ['kind', 'a', 'b'], field); return { kind: 'seam', a: name(v.a, `${field}.a`), b: name(v.b, `${field}.b`) };
    case 'angle-range': exactly(v, ['kind', 'bone', 'relative'], field); return { kind: 'angle-range', bone: name(v.bone, `${field}.bone`), relative: name(v.relative, `${field}.relative`) };
    default: return bad(`${field}.kind must be one of ${READING_KINDS.join(', ')}`);
  }
}
/** `{animation, readings, environment}` only: names and numbers, never a path or a flag. */
export function parseReadingsRequest(input: unknown): ReadingsRequest {
  const v = record(input, 'readings request');
  exactly(v, ['animation', 'readings', 'environment'], 'readings request');
  const animation = name(v.animation, 'animation');
  if (!Array.isArray(v.readings) || v.readings.length < 1 || v.readings.length > MAX_READINGS) bad(`readings must hold 1–${MAX_READINGS} entries`);
  const readings = (v.readings as unknown[]).map((r, i) => parseReading(r, `readings[${i}]`));
  const labels = readings.map(readingLabel);
  if (new Set(labels).size !== labels.length) bad('readings: one entry named twice');
  let environment: ReadingsRequest['environment'] = null;
  if (v.environment !== null) {
    const e = record(v.environment, 'environment');
    if (Object.hasOwn(e, 'spec')) { try { environment = parseSchedule(e); } catch (error) { if (error instanceof ScheduleError) bad(`environment: ${error.message}`); throw error; } }
    else { exactly(e, ['wind', 'gravity'], 'environment'); environment = { wind: pair(e.wind, 'environment.wind'), gravity: pair(e.gravity, 'environment.gravity') }; }
  }
  return { animation, readings, environment };
}

/** The reading as the worst-frame line names it: `folds`, `seam topwear:bottomwear`, `angle-range head:chest`. */
export function readingLabel(r: ReadingRequest): string {
  switch (r.kind) {
    case 'folds': case 'overlaps': return r.kind;
    case 'pass-through': return `pass-through ${r.cloth}:${r.leg}`;
    case 'seam': return `seam ${r.a}:${r.b}`;
    case 'angle-range': return `angle-range ${r.bone}:${r.relative}`;
  }
}
/** The flag as `rigc render --help` states it. */
export function readingFlag(r: ReadingRequest): string[] {
  switch (r.kind) {
    case 'folds': return ['--folds'];
    case 'overlaps': return ['--overlaps'];
    case 'pass-through': return ['--pass-through', `${r.cloth}:${r.leg}`];
    case 'seam': return ['--seam', `${r.a}:${r.b}`];
    case 'angle-range': return ['--angle-range', `${r.bone}:${r.relative}`];
  }
}
/** The file each reading writes into the set's directory, or null (`--angle-range` prints its line and writes nothing). */
export const READING_FILE: Record<ReadingKind, string | null> = { folds: 'folds.json', 'pass-through': 'pass-through.json', seam: 'seam.json', overlaps: 'overlaps.json', 'angle-range': null };
export interface RenderPaths { candidate: string; out: string; environment: string | null }
/** One `rigc render` per reading: the candidate build, the one animation, the default 12 fps, the server's scratch `--out`. */
export function renderArgs(r: ReadingRequest, animation: string, paths: RenderPaths): string[] {
  return ['render', '--candidate', paths.candidate, '--animation', animation, ...(paths.environment ? ['--environment', paths.environment] : []), ...readingFlag(r), '--out', paths.out];
}
/** The schedule file `--environment` reads: the world as it stands, from t = 0 — or, #112, the exported schedule as sent. */
export const environmentSchedule = (e: ReadingEnvironment | EnvironmentSchedule): EnvironmentSchedule => ('spec' in e ? e : standingSchedule(e));
/** Whether this rigc's `render --help` lists `--environment` (the schedule is passed only then). */
export const helpHasEnvironment = (lines: readonly string[]) => lines.some(l => /^\s*--environment\s/.test(l));

/**
 * rigc's refusal, verbatim: its first `rigc: …` line that is not a write notice (an unknown slot or bone, a malformed
 * list, a pair named twice — rigc names them), else a named `CODE:` / `FAIL` line, else the exit.
 */
export function readingRefusal(lines: readonly string[], exitCode: number): string {
  for (const line of lines) if (/^rigc: /.test(line) && !/^rigc: wrote /.test(line)) return line.trimEnd();
  return firstRefusal(lines) ?? `rigc render exited ${exitCode} without a named refusal`;
}

export interface ReadingWorst { frame: number; figure: string; line: string }
export interface ReadingItem { pair: string; frames: number[]; worst: ReadingWorst | null }
export type ReadingStatus = 'read' | 'refused' | 'failed';
export interface ReadingResult {
  reading: ReadingRequest; label: string; status: ReadingStatus;
  /** The set's sampling rate from frames.json; a frame's time is frame / fps (rigc's own `time` fields agree). */
  fps: number | null;
  /** Every frame the reading's JSON lists (union over its pairs or meshes), ascending. */
  frames: number[];
  /** Where the frames come from: the reading's JSON, or (angle-range) its printed line. */
  source: 'json' | 'line' | null;
  worst: ReadingWorst | null; items: ReadingItem[];
  /** The reading's own printed lines (rigc's `  ..    <tag>    …` rows for it), tag column removed. */
  lines: string[];
  refusal: string | null; exitCode: number | null; wallMs: number | null;
}

const TAG: Record<ReadingKind, string> = { folds: 'folds', 'pass-through': 'pass', seam: 'seam', overlaps: 'overlap', 'angle-range': 'angle' };
/** The reading's printed rows with rigc's `  ..    <tag>    ` column removed. */
export function readingLines(kind: ReadingKind, lines: readonly string[]): string[] {
  const tag = new RegExp(`^\\s*\\.\\.\\s+${TAG[kind]}\\s+(.*)$`);
  return lines.flatMap(l => { const m = tag.exec(l); return m ? [m[1]!.trimEnd()] : []; });
}
const sorted = (frames: Iterable<number>) => [...new Set(frames)].sort((a, b) => a - b);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown, field: string): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ReadingsError('READINGS_JSON_UNREAD', `${field} is not a frame index`); return v; };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const q = (s: string) => JSON.stringify(s);
const find = (rows: readonly string[], ...parts: string[]) => rows.find(l => parts.every(p => l.includes(p))) ?? '';

/** Frames and the worst frame of one reading, from its JSON (or, for angle-range, its printed line). */
export function readingFrames(r: ReadingRequest, json: unknown, rows: readonly string[]): { frames: number[]; worst: ReadingWorst | null; items: ReadingItem[]; source: 'json' | 'line' } {
  const doc = obj(json);
  switch (r.kind) {
    case 'folds': {
      const items = list(doc.meshes).map(obj).filter(m => list(m.frames).length).map((m): ReadingItem & { count: number } => {
        const frames = list(m.frames).map((f, i) => int(obj(f).index, `folds.meshes[].frames[${i}].index`)), worst = obj(m.worst), count = list(worst.triangles).length;
        const slot = String(m.slot), attachment = String(m.attachment);
        return { pair: attachment === slot ? slot : `${slot}/${attachment}`, frames, count, worst: { frame: int(worst.index, 'folds worst.index'), figure: `${count} of ${num(m.triangleCount)} triangle(s) folded`, line: find(rows, `mesh ${q(attachment)} (slot ${q(slot)})`) } };
      });
      const top = items.reduce<(typeof items)[number] | null>((best, i) => (!best || i.count > best.count ? i : best), null);
      return { frames: sorted(items.flatMap(i => i.frames)), worst: top ? { ...top.worst!, figure: `${top.worst!.figure} (mesh ${top.pair})` } : null, items: items.map(({ count: _, ...i }) => i), source: 'json' };
    }
    case 'pass-through': {
      const p = obj(list(doc.pairs).map(obj).find(x => x.cloth === r.cloth && x.leg === r.leg));
      const frames = list(p.frames).map((f, i) => int(obj(f).index, `pass-through.frames[${i}].index`)), d = obj(p.deepest), line = find(rows, `cloth ${q(r.cloth)} over leg ${q(r.leg)} passes through on`);
      const worst = frames.length ? { frame: int(d.index, 'pass-through deepest.index'), figure: `${num(d.depth).toFixed(2)} units (${num(d.cells)} step(s)) on its ${String(d.side)} side`, line } : null;
      return { frames: sorted(frames), worst, items: [{ pair: `${r.cloth}:${r.leg}`, frames: sorted(frames), worst }], source: 'json' };
    }
    case 'seam': {
      const p = obj(list(doc.pairs).map(obj).find(x => x.a === r.a && x.b === r.b));
      const frames = list(p.opens).map((f, i) => int(f, `seam.opens[${i}]`)), line = find(rows, `seam ${q(r.a)} | ${q(r.b)}`);
      const kinds = (['gap', 'ghost'] as const).map(k => ({ k, w: obj(obj(p[k]).worst) })).filter(x => typeof x.w.index === 'number');
      const top = kinds.reduce<(typeof kinds)[number] | null>((best, x) => (!best || num(x.w.px) > num(best.w.px) ? x : best), null);
      const worst = frames.length && top ? { frame: int(top.w.index, `seam ${top.k}.worst.index`), figure: `${top.k} ${num(top.w.px)} px (${num(top.w.area).toFixed(2)} units²)`, line } : null;
      return { frames: sorted(frames), worst, items: [{ pair: `${r.a}:${r.b}`, frames: sorted(frames), worst }], source: 'json' };
    }
    case 'overlaps': {
      const items = list(doc.pairs).map(obj).filter(x => x.varies === true).map((x): ReadingItem & { px: number } => {
        const frames = list(x.runs).flatMap((run, i) => { const [a, b] = list(run).map(v => int(v, `overlaps.runs[${i}]`)); const out: number[] = []; for (let f = a!; f <= b!; f++) out.push(f); return out; });
        const most = obj(x.most), under = String(x.under), over = String(x.over);
        return { pair: `${under}<${over}`, frames: sorted(frames), px: num(most.px), worst: { frame: int(most.index, 'overlaps most.index'), figure: `${num(most.px)} px of ${under} covered by ${over}`, line: find(rows, `OVERLAP ${q(under)} under ${q(over)}`) } };
      });
      const top = items.reduce<(typeof items)[number] | null>((best, i) => (!best || i.px > best.px ? i : best), null);
      return { frames: sorted(items.flatMap(i => i.frames)), worst: top?.worst ?? null, items: items.map(({ px: _, ...i }) => i), source: 'json' };
    }
    case 'angle-range': {
      // rigc writes no file for this reading; its line names the lowest and the highest angle and the frame of each.
      const line = find(rows, `bone ${q(r.bone)} against ${q(r.relative)}`);
      const m = /ranges (-?[\d.]+)° to (-?[\d.]+)° \(a span of ([\d.]+)°\).*lowest at frame (\d+) .*highest at frame (\d+) /.exec(line + ' ');
      if (!m) throw new ReadingsError('READINGS_LINE_UNREAD', `no angle line for ${r.bone}:${r.relative}`);
      const low = Number(m[1]), high = Number(m[2]), lowFrame = Number(m[4]), highFrame = Number(m[5]);
      const frame = Math.abs(high) > Math.abs(low) ? highFrame : lowFrame;
      const worst = { frame, figure: `span ${m[3]}° (${m[1]}° at F${lowFrame}, ${m[2]}° at F${highFrame})`, line };
      const frames = sorted([lowFrame, highFrame]);
      return { frames, worst, items: [{ pair: `${r.bone}:${r.relative}`, frames, worst }], source: 'line' };
    }
  }
}

/** One finished run of one reading: refused when rigc exited non-zero (its line verbatim), else its frames. */
export function readingResult(r: ReadingRequest, run: { exitCode: number; lines: string[]; wallMs: number }, json: unknown, fps: number | null): ReadingResult {
  const base = { reading: r, label: readingLabel(r), fps, exitCode: run.exitCode, wallMs: run.wallMs, lines: readingLines(r.kind, run.lines) };
  if (run.exitCode !== 0) return { ...base, status: 'refused', frames: [], source: null, worst: null, items: [], refusal: readingRefusal(run.lines, run.exitCode) };
  try { return { ...base, status: 'read', ...readingFrames(r, json, base.lines), refusal: null }; }
  catch (e) { return { ...base, status: 'failed', frames: [], source: null, worst: null, items: [], refusal: e instanceof Error ? e.message : String(e) }; }
}

export type ReadingBuild = 'inspected' | 'scratch';
/** `<build> · <reading> <pair>: worst at frame N — <figure> · <rigc line>`; no frame, or rigc's refusal, said as such. */
export function worstLine(build: ReadingBuild, result: ReadingResult, item?: ReadingItem): string {
  const label = item && result.items.length > 1 ? `${result.reading.kind} ${item.pair}` : result.label, worst = item ? item.worst : result.worst;
  if (result.status !== 'read') return `${build} · ${result.label}: ${result.refusal}`;
  if (!worst) return `${build} · ${label}: no frame${result.lines.length ? ` · ${result.lines[0]}` : ''}`;
  return `${build} · ${label}: worst at frame ${worst.frame} — ${worst.figure}${worst.line ? ` · ${worst.line}` : ''}`;
}

export interface ReadingTick { build: ReadingBuild; label: string; frame: number; time: number | null }
/** The timeline ticks: one per frame each reading's JSON lists, per build. A frame's time is frame / fps. */
export function readingTicks(runs: readonly { build: ReadingBuild; results: readonly ReadingResult[] }[]): ReadingTick[] {
  return runs.flatMap(run => run.results.filter(r => r.status === 'read').flatMap(r => r.frames.map(frame => ({ build: run.build, label: r.label, frame, time: r.fps ? frame / r.fps : null }))));
}

/** rigc samples the last frame at frame / fps; the runtime's clip duration can round a hair below it. Within this, the tick is the clip's end. */
export const TICK_EDGE = 1e-4;
/**
 * A reading's seek time on its clip (#186): within TICK_EDGE past the clip's end, the clip's end. `clipDuration` is the
 * duration of the clip the reading names (the one the seek switches to), never the clip drawn before the switch; a time
 * further past is returned unchanged for the seek to refuse by name.
 */
export function readingSeekTime(exact: number, clipDuration: number): number {
  return clipDuration > 0 && exact > clipDuration && exact - clipDuration <= TICK_EDGE ? clipDuration : exact;
}
/** The ticks the scrub draws: the job's animation is the one drawn, each with a time inside the clip (the last sample kept). */
export function ticksOnClip(ticks: readonly ReadingTick[], jobAnimation: string, animation: string, duration: number): ReadingTick[] {
  if (jobAnimation !== animation || !(duration > 0)) return [];
  return ticks.filter(t => t.time !== null && t.time <= duration + TICK_EDGE);
}

/** `context.readings`: the pairs chosen and where they ran (the builds' identities), never the results' bytes. */
export interface ReadingsContext {
  schema: typeof READINGS_SCHEMA; animation: string; requests: ReadingRequest[]; environment: ReadingsRequest['environment']; environmentPassed: boolean;
  builds: { inspected: string; scratch: string | null }; compiler: { package: string; version: string };
  ticks: { inspected: number; scratch: number | null };
}
export function parseReadingsContext(value: unknown): ReadingsContext | null {
  if (value === null) return null;
  const v = record(value, 'context.readings');
  if (v.schema !== READINGS_SCHEMA) bad(`context.readings.schema must be ${READINGS_SCHEMA}`);
  const parsed = parseReadingsRequest({ animation: v.animation, readings: v.requests, environment: v.environment ?? null });
  const builds = record(v.builds, 'context.readings.builds'), ticks = record(v.ticks, 'context.readings.ticks'), compiler = record(v.compiler, 'context.readings.compiler');
  if (typeof builds.inspected !== 'string' || (builds.scratch !== null && typeof builds.scratch !== 'string')) bad('context.readings.builds');
  if (typeof compiler.package !== 'string' || typeof compiler.version !== 'string') bad('context.readings.compiler');
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!count(ticks.inspected) || !(ticks.scratch === null || count(ticks.scratch))) bad('context.readings.ticks');
  if (typeof v.environmentPassed !== 'boolean') bad('context.readings.environmentPassed');
  return { schema: READINGS_SCHEMA, animation: parsed.animation, requests: parsed.readings, environment: parsed.environment, environmentPassed: v.environmentPassed as boolean, builds: { inspected: builds.inspected as string, scratch: builds.scratch as string | null }, compiler: { package: compiler.package as string, version: compiler.version as string }, ticks: { inspected: ticks.inspected as number, scratch: ticks.scratch as number | null } };
}
