/**
 * Density strip (#173), pure: N ≤ 5 values of one part's density field — `grid` on a lattice entry, `contour.spacing`
 * on a contour entry — each sent as the one existing Mesh-panel patch (`replace /meshes/<part>`, `remesh --part
 * <part>`, #106) and built side by side. This module holds what needs no IO: the request's shape (the patches may
 * differ only at the density field), the values of a strip and of a refined strip, and the row a settled candidate job
 * reads as — `remesh.json`'s `target.after` counts, the producer's own check lines for the part (folds, stretch, every
 * bar the part is measured on as a ratio against its floor or ceiling) and the verdict (PASS, or the refusal verbatim).
 * The two labels ("fewest triangles passing", "widest margin among ties") name rows; nothing here applies one.
 */
import { applyConfigPatch, type ConfigPatch, type JsonValue } from './config-patch.ts';
import { assertMeshPatch, MeshEntryError, meshMode, type MeshCounts } from './mesh-entry.ts';

export const DENSITY_STRIP_SCHEMA = 'rig-review-density-strip/1';
/** At most this many values per strip (the card's N ≤ 5); at least two (one value is an Apply). */
export const MAX_STRIP_VALUES = 5, MIN_STRIP_VALUES = 2;
/** `POST /api/density-strip`: five patches of at most 64 KiB each (the Apply body bound). */
export const DENSITY_STRIP_LIMIT = MAX_STRIP_VALUES * 64 * 1024;
/** The density field a strip runs over, by the entry's mode. */
export type DensityField = 'grid' | 'contour.spacing';
export const densityPath = (field: DensityField): readonly string[] => (field === 'grid' ? ['grid'] : ['contour', 'spacing']);

export class DensityStripError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const invalid = (detail: string): never => { throw new DensityStripError('DENSITY_STRIP_REQUEST_INVALID', detail); };
const isObject = (v: unknown): v is Record<string, JsonValue> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The density field of an entry: `grid` for a lattice, `contour.spacing` for a contour; any other mode has none here. */
export function densityField(entry: unknown, part: string): DensityField {
  const mode = meshMode(entry, part);
  if ('error' in mode) throw new DensityStripError('DENSITY_STRIP_FIELD', mode.error);
  if (mode.mode === 'grid') return 'grid';
  if (mode.mode === 'contour') return 'contour.spacing';
  return invalid(`meshes.${part} is a ${mode.mode} entry; a strip runs over grid (lattice) or contour.spacing (contour) only`);
}
const valueAt = (entry: Record<string, JsonValue>, path: readonly string[]): JsonValue | undefined => path.reduce<JsonValue | undefined>((v, k) => (isObject(v) ? v[k] : undefined), entry);
const without = (entry: Record<string, JsonValue>, path: readonly string[]): JsonValue => {
  const out = structuredClone(entry); let holder: Record<string, JsonValue> = out;
  for (const k of path.slice(0, -1)) holder = holder[k] as Record<string, JsonValue>;
  delete holder[path.at(-1)!];
  return out;
};

/** `{patches}` exactly, 2–5 of them (each still to be parsed as a config patch). */
export function stripPatches(input: unknown): unknown[] {
  if (!isObject(input) || Object.keys(input).join(',') !== 'patches') invalid('expected exactly {patches}');
  const patches = (input as { patches: unknown }).patches;
  if (!Array.isArray(patches) || patches.length < MIN_STRIP_VALUES || patches.length > MAX_STRIP_VALUES) invalid(`patches must hold ${MIN_STRIP_VALUES}–${MAX_STRIP_VALUES} config patches`);
  return patches as unknown[];
}

export interface StripShape { part: string; field: DensityField; values: number[]; entries: JsonValue[] }
/**
 * The strip a list of parsed patches states: every one the Mesh panel's patch for one part (`MESH_PATCH_SCOPE`
 * otherwise), the same config bytes, producer and flags, and entries that differ only at the part's density field,
 * each at another value. Order is the request's.
 */
export function stripShape(patches: readonly ConfigPatch[]): StripShape {
  const first = patches[0]!;
  const part = first.op.args[first.op.args.indexOf('--part') + 1];
  if (first.op.cmd !== 'remesh' || typeof part !== 'string') invalid('a strip is made of remesh patches (remesh --part <part>)');
  const field = densityField(first.ops[0]?.value, part!);
  const path = densityPath(field), entries: JsonValue[] = [], values: number[] = [];
  let rest: string | null = null;
  for (const [i, patch] of patches.entries()) {
    try { assertMeshPatch(patch, part!); } catch (e) { if (e instanceof MeshEntryError) throw new DensityStripError(e.code, `patches[${i}]: ${e.message.slice(e.code.length + 2)}`); throw e; }
    if (patch.config_sha256 !== first.config_sha256) invalid(`patches[${i}] was made against other config bytes than patches[0]`);
    if (JSON.stringify(patch.producer) !== JSON.stringify(first.producer) || JSON.stringify(patch.op) !== JSON.stringify(first.op)) invalid(`patches[${i}] names another producer or other flags than patches[0]`);
    const entry = patch.ops[0]!.value;
    if (!isObject(entry) || densityField(entry, part!) !== field) invalid(`patches[${i}]: the entry is not a ${field === 'grid' ? 'grid' : 'contour'} entry like patches[0]`);
    const value = valueAt(entry as Record<string, JsonValue>, path);
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`patches[${i}]: meshes.${part}.${field} is not a number`);
    const others = JSON.stringify(without(entry as Record<string, JsonValue>, path));
    if (rest === null) rest = others;
    else if (others !== rest) throw new DensityStripError('DENSITY_STRIP_FIELD', `patches[${i}] differs from patches[0] outside meshes.${part}.${field}; a strip varies the density field only`);
    if (values.includes(value as number)) invalid(`patches[${i}]: ${field} ${value} is already in the strip`);
    values.push(value as number); entries.push(entry as JsonValue);
  }
  return { part: part!, field, values, entries };
}

/** n values from a to b inclusive, evenly spaced; a lattice's grid is a whole number (rounded, duplicates dropped). */
export function stripValues(a: number, b: number, n: number, integer: boolean): number[] {
  if (![a, b, n].every(Number.isFinite) || n < MIN_STRIP_VALUES || n > MAX_STRIP_VALUES || !Number.isInteger(n)) throw new DensityStripError('DENSITY_STRIP_VALUES', `N must be a whole number ${MIN_STRIP_VALUES}–${MAX_STRIP_VALUES}, and A and B numbers`);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const raw = Array.from({ length: n }, (_, k) => lo + ((hi - lo) * k) / (n - 1));
  const out = [...new Set(raw.map(v => (integer ? Math.round(v) : Math.round(v * 1000) / 1000)))].sort((x, y) => x - y);
  if (out.length < MIN_STRIP_VALUES) throw new DensityStripError('DENSITY_STRIP_VALUES', `${lo}…${hi} holds fewer than ${MIN_STRIP_VALUES} distinct ${integer ? 'whole ' : ''}values`);
  return out;
}
/** "Refine between" two adjacent rows: up to n values strictly inside (a, b), evenly spaced. */
export function refineValues(a: number, b: number, n: number, integer: boolean): number[] {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const raw = Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 1)) / (n + 1));
  const out = [...new Set(raw.map(v => (integer ? Math.round(v) : Math.round(v * 1000) / 1000)))].filter(v => v > lo && v < hi).sort((x, y) => x - y);
  if (out.length < MIN_STRIP_VALUES) throw new DensityStripError('DENSITY_STRIP_VALUES', `between ${lo} and ${hi} there are fewer than ${MIN_STRIP_VALUES} ${integer ? 'whole ' : ''}values to try`);
  return out;
}
/** The entry with its density field at `value` (every other field as the base entry holds it, in its order). */
export const entryAt = (entry: Record<string, JsonValue>, field: DensityField, value: number): JsonValue =>
  applyConfigPatch(entry, [{ op: 'replace', path: densityPath(field).map(k => '/' + k).join(''), value }]);

/** One bar the part is measured on, as the producer's check printed it: its figure against the bar's floor or ceiling. */
export interface StripBar { bar: string; status: string; key: string; value: number; bound: number; kind: 'floor' | 'ceiling'; ratio: number; margin: number }
export interface StripFigures {
  /** `ANIMATIONS_DO_NOT_FOLD`'s folding mesh count, as printed. */
  folds: number | null;
  /** The part's `TEXTURE_STRETCH` severity and the frame of its worst triangle (the max or the min side, whichever is worse). */
  stretch: { severity: number; frame: string | null } | null;
  bars: StripBar[];
}
const NUM = '(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The check lines a candidate's figures are read from: the producer op's own check of its revision (remesh prints it
 * as `[check-revision] …`, #174) when the job carries it, else the lines of the check review ran (no bracket prefix).
 */
export function revisionCheckLines(lines: readonly string[]): string[] {
  const tagged = lines.filter(l => l.startsWith('[check-revision]')).map(l => l.slice('[check-revision]'.length));
  return tagged.length ? tagged : lines.filter(l => !/^\s*\[/.test(l) && !l.startsWith('review:'));
}
/** The part's figures from check's bar lines (`  BAR: STATUS — detail`), the producer's numbers as printed. */
export function stripFigures(lines: readonly string[], part: string): StripFigures {
  const out: StripFigures = { folds: null, stretch: null, bars: [] };
  const marker = new RegExp(`\\b(?:part|slot) ${escape(part)}, `, 'g');
  for (const raw of revisionCheckLines(lines)) {
    const m = /^\s*([A-Z][A-Z0-9_]+): (PASS|FAIL|SKIP|WARN|CLEAR|REPORTED) — (.*)$/.exec(raw);
    if (!m) continue;
    const [, bar, status, detail] = m as unknown as [string, string, string, string];
    if (bar === 'ANIMATIONS_DO_NOT_FOLD') { const f = /(\d+) folding mesh\(es\)/.exec(detail); if (f) out.folds = Number(f[1]); }
    // The part's own segment: the last time the line names it (TEXTURE_STRETCH names its worst slot first, then per mesh).
    let at = -1; for (const hit of detail.matchAll(marker)) at = hit.index!;
    if (at < 0) continue;
    const end = detail.indexOf(' | ', at), segment = detail.slice(at, end < 0 ? undefined : end);
    if (/^\S+ \S+, unmeasured\b/.test(segment)) continue;
    if (bar === 'TEXTURE_STRETCH') {
      const sev = new RegExp(`\\bseverity ${NUM}`).exec(segment), max = new RegExp(`\\bmax_ratio ${NUM}`).exec(segment), min = new RegExp(`\\bmin_ratio ${NUM}`).exec(segment);
      const frames = [...segment.matchAll(/\b([A-Za-z0-9_-]+) frame (\d+)/g)].map(f => `${f[1]} frame ${f[2]}`);
      if (sev) {
        // The worst frame is the side the severity was taken from: the max ratio, or the inverse of the min ratio.
        const s = Number(sev[1]), worstMin = !!(max && min && Number(min[1]) > 0 && Math.abs(1 / Number(min[1]) - s) < Math.abs(Number(max[1]) - s));
        out.stretch = { severity: Number(sev[1]), frame: (worstMin ? frames[1] : frames[0]) ?? null };
      }
    }
    for (const b of detail.matchAll(new RegExp(`\\b([a-z][a-z0-9_]*?)_(floor|ceiling) ${NUM}`, 'g'))) {
      const key = b[1]!, kind = b[2] as 'floor' | 'ceiling', bound = Number(b[3]);
      const v = new RegExp(`\\b${escape(key)} ${NUM}`).exec(segment);
      if (!v || !(bound > 0)) continue;
      const value = Number(v[1]), ratio = value / bound;
      out.bars.push({ bar, status, key, value, bound, kind, ratio, margin: kind === 'floor' ? ratio : value > 0 ? bound / value : Infinity });
    }
  }
  return out;
}

/** A settled candidate job, as much of it as a row reads. */
export interface CandidateJobLike {
  status: string; producerLine: string | null; lines: readonly string[];
  remesh: { part: string; before: MeshCounts; after: MeshCounts; modelTriangles: number | null } | null;
  check: { pass: boolean | null; line: string | null } | null;
  build: { modelHash: string } | null;
}
export interface StripRow extends StripFigures {
  value: number; id: string; status: string;
  /** `remesh.json`'s `target.after` (null when the candidate wrote none: refused before it). */
  counts: { vertices: number; triangles: number } | null;
  modelTriangles: number | null;
  /** PASS, or the producer's refusal (or check's line) verbatim. */
  verdict: string;
  /** Served for viewing while the strip holds it; null for a refused or running row. */
  modelUrl: string | null; modelHash: string | null;
  /** The candidate's build moved into the Apply scratch root when the reader Applied this row's patch. */
  applied: boolean;
  entry: JsonValue;
}
export function candidateRow(input: { value: number; id: string; entry: JsonValue; job: CandidateJobLike; part: string; modelUrl: string | null; applied: boolean }): StripRow {
  const { job } = input, built = job.status === 'built';
  const verdict = job.status === 'running' ? 'running' : built ? (job.check?.pass ? 'PASS' : job.check?.line ?? 'check: no summary') : job.producerLine ?? `REBUILD_${job.status.toUpperCase()}`;
  return {
    value: input.value, id: input.id, status: job.status, ...stripFigures(job.lines, input.part),
    counts: job.remesh ? { vertices: job.remesh.after.vertices, triangles: job.remesh.after.triangles } : null,
    modelTriangles: job.remesh?.modelTriangles ?? null, verdict,
    modelUrl: built && !input.applied ? input.modelUrl : null, modelHash: built ? job.build?.modelHash ?? null : null,
    applied: input.applied, entry: input.entry,
  };
}
/** The narrowest margin of a row over every bar it is measured on (> 1: every bar met with room), or null with none. */
export const rowMargin = (row: Pick<StripRow, 'bars'>): number | null => (row.bars.length ? Math.min(...row.bars.map(b => b.margin)) : null);
/**
 * The two labels, by row index: the passing row with the fewest triangles, and — when several passing rows tie on that
 * count — the one among them with the widest narrowest margin. Labels only: nothing here applies a row.
 */
export function stripLabels(rows: readonly StripRow[]): { fewest: number | null; widest: number | null } {
  const passing = rows.map((r, i) => ({ r, i })).filter(x => x.r.verdict === 'PASS' && x.r.counts);
  if (!passing.length) return { fewest: null, widest: null };
  const least = Math.min(...passing.map(x => x.r.counts!.triangles)), tied = passing.filter(x => x.r.counts!.triangles === least);
  const fewest = tied[0]!.i;
  if (tied.length < 2) return { fewest, widest: null };
  const best = tied.reduce((a, b) => ((rowMargin(b.r) ?? -Infinity) > (rowMargin(a.r) ?? -Infinity) ? b : a));
  return { fewest, widest: best.i };
}
/** A bar as the table shows it: `TIP_OVER_ROOT ratio 1.995 / floor 1.4725 = 1.355×`. */
export const barText = (b: StripBar) => `${b.bar} ${b.key} ${b.value} / ${b.kind} ${b.bound} = ${b.ratio.toFixed(3)}×`;
