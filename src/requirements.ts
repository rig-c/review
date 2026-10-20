/**
 * Declared requirements (issue #113): the scene's bars on the rig's motion, written by review as a
 * `spine-parts-requirements/1` file and measured by the installed producer's `rig-parts check --requirements`.
 * Pure: the typed requirement for each kind (the fields the producer's reader reads, nothing else), the file text,
 * the request envelope the page sends, the check's `requirements` block (or its printed lines) read back into one row
 * per requirement with its measured figure and worst frame, and the feedback context that carries the file by hash and
 * content. Review judges nothing here: whether a field, a name or a bar holds is the producer's to say, and its
 * `REQUIREMENTS_*`, `CHECK_REQUIREMENT_MET` and `CHECK_REQUIREMENT_MEASURABLE` lines are shown verbatim.
 * Not written: scene targets, the exception lists (`not_planted`, `not_swinging`, `rises`, `rests`) and waivers
 * (`may_fold`) — the envelope carries `spec`, `fps` and `requirements` only.
 */
import { firstRefusal } from './producer.ts';

export const REQUIREMENTS_SPEC = 'spine-parts-requirements/1';
export const REQUIREMENTS_RUN_SCHEMA = 'rig-review-requirements/1';
export const REQUIREMENTS_CONTEXT_SCHEMA = 'rig-review-requirements-context/1';
/** Request body cap, file text cap and requirement count cap. */
export const REQUIREMENTS_LIMIT = 64 * 1024;
export const MAX_REQUIREMENTS = 64;
/** The six kinds the producer's reader reads, in its order. */
export const REQUIREMENT_KINDS = ['contact', 'follow', 'aim', 'range', 'stretch', 'seam'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];
/** Each kind's fields as the producer's reader lists them (`KIND_FIELDS`); every one is required. */
export const KIND_FIELDS: Record<RequirementKind, readonly string[]> = {
  contact: ['bone', 'point', 'target', 'within_px'],
  follow: ['constraint', 'constraint_type', 'bone', 'property', 'fraction', 'tolerance', 'least_drive'],
  aim: ['bone', 'target', 'within_degrees'],
  range: ['bone', 'lo_degrees', 'hi_degrees'],
  stretch: ['slot', 'attachment', 'within_ratio'],
  seam: ['part', 'neighbour', 'within_px'],
};
/** The reader's name rule: a letter, then letters, digits and underscores. */
export const REQUIREMENT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export type BonePoint = 'origin' | 'tip';
export type TargetRef = { bone: string; point: BonePoint } | { stage: [number, number] };
interface Common { name: string; animation: string }
export type Requirement =
  | (Common & { kind: 'contact'; bone: string; point: BonePoint; target: TargetRef; within_px: number })
  | (Common & { kind: 'follow'; constraint: string; constraint_type: 'ik' | 'transform'; bone: string; property: 'rotate' | 'translate'; fraction: number; tolerance: number; least_drive: number })
  | (Common & { kind: 'aim'; bone: string; target: TargetRef; within_degrees: number })
  | (Common & { kind: 'range'; bone: string; lo_degrees: number; hi_degrees: number })
  | (Common & { kind: 'stretch'; slot: string; attachment: string; within_ratio: number })
  | (Common & { kind: 'seam'; part: string; neighbour: string; within_px: number });

/** The file as review writes it: `spec`, `fps` and the requirements, nothing else. */
export interface RequirementsDocument { spec: typeof REQUIREMENTS_SPEC; fps: number; requirements: Record<string, unknown>[] }
export function requirementsDocument(fps: number, requirements: readonly Record<string, unknown>[]): RequirementsDocument {
  return { spec: REQUIREMENTS_SPEC, fps, requirements: requirements.map(r => ({ ...r })) };
}
/** The file's bytes: one stable serialization, so its sha256 names exactly what the producer read. */
export function requirementsFileText(doc: RequirementsDocument): string {
  return JSON.stringify({ spec: doc.spec, fps: doc.fps, requirements: doc.requirements }, null, 1) + '\n';
}
/** One requirement with exactly its kind's fields, in the reader's order (`name`, `kind`, `animation`, then the fields). */
export function requirementEntry(r: Requirement): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: r.name, kind: r.kind, animation: r.animation };
  for (const field of KIND_FIELDS[r.kind]) {
    const value = (r as unknown as Record<string, unknown>)[field];
    entry[field] = field === 'target' && value && typeof value === 'object' ? ('stage' in value ? { stage: [...(value as { stage: [number, number] }).stage] } : { bone: (value as { bone: string }).bone, point: (value as { point: BonePoint }).point }) : value;
  }
  return entry;
}

export class RequirementsError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new RequirementsError('REQUIREMENTS_REQUEST_INVALID', detail); };
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const KEY = /^[a-z][a-z_]{0,31}$/;
const TEXT = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);

/** Which build the check reads: the inspected rig spec (the handoff's) or the session's latest scratch revision. */
export type RequirementsBuild = 'inspected' | 'scratch';
export interface RequirementsRequest { fps: number; build: RequirementsBuild; requirements: Record<string, unknown>[] }
/**
 * `{fps, build, requirements}` only. The envelope is bounded and typed (each requirement an object of short keys whose
 * values are names, finite numbers or a `{bone, point}` / `{stage: [x, y]}` target); which kind, field, name or bar
 * reads is the producer's reader's to say, so a misspelt kind reaches it and comes back refused by name.
 */
export function parseRequirementsRequest(input: unknown): RequirementsRequest {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'build,fps,requirements') bad('expected exactly {fps, build, requirements}');
  const v = input as Record<string, unknown>;
  if (!finite(v.fps) || v.fps <= 0 || v.fps > 240) bad('fps must be a number above 0, at most 240');
  if (v.build !== 'inspected' && v.build !== 'scratch') bad('build must be "inspected" or "scratch"');
  if (!Array.isArray(v.requirements) || v.requirements.length === 0 || v.requirements.length > MAX_REQUIREMENTS) bad(`requirements must hold 1 to ${MAX_REQUIREMENTS} entries`);
  const requirements = (v.requirements as unknown[]).map((r, i) => {
    if (!isRecord(r) || Object.keys(r).length > 12) return bad(`requirements[${i}] must be an object of at most 12 fields`);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(r)) {
      if (!KEY.test(key)) bad(`requirements[${i}] key ${JSON.stringify(key).slice(0, 40)} is not a field name`);
      if (key === 'may_fold') bad(`requirements[${i}].may_fold: waivers are not written by review`);
      if (TEXT(value) || finite(value)) out[key] = value;
      else if (key === 'target' && isRecord(value) && Object.keys(value).sort().join(',') === 'bone,point' && TEXT(value.bone) && TEXT(value.point)) out[key] = { bone: value.bone, point: value.point };
      else if (key === 'target' && isRecord(value) && Object.keys(value).join(',') === 'stage' && Array.isArray(value.stage) && value.stage.length === 2 && value.stage.every(n => finite(n) && Math.abs(n) <= 1e5)) out[key] = { stage: [...value.stage] };
      else bad(`requirements[${i}].${key} must be a name, a finite number or a target`);
    }
    return out;
  });
  return { fps: v.fps as number, build: v.build as RequirementsBuild, requirements };
}

/** `rig-parts check --rig <rig> --out out --requirements requirements.json [--parts <parts>]`; every path the server's. */
export const requirementsCheckArgs = (r: { rig: string; parts: string | null; out: string; requirements: string }): string[] => ['check', '--rig', r.rig, '--out', r.out, ...(r.parts ? ['--parts', r.parts] : []), '--requirements', r.requirements];

export type RequirementStatus = 'PASS' | 'FAIL' | 'NOT MEASURABLE';
export interface WorstFrame { frame: number; time: number | null; text: string }
/** One requirement's row: what check measured, the figure the bar is read against, and the worst frame. */
export interface RequirementRow {
  name: string; kind: string; animation: string; status: RequirementStatus;
  /** The measured figure (`largest_px`, `largest_degrees`, `severity`, `fraction_measured`), or, for a range, the least and the greatest. */
  measured: number | null; least: number | null; greatest: number | null;
  worst: WorstFrame | null;
  /** The NOT MEASURABLE reason, verbatim. */
  reason: string | null;
  /** The console line `NAME: STATUS — …` as printed, or one built from check.json's figures in the same words. */
  line: string;
}
/** "frame 4 (t = 0.333333s)" → frame 4, 0.333333 s. */
export function worstFrame(text: unknown): WorstFrame | null {
  if (typeof text !== 'string') return null;
  const m = /^frame (\d+)(?: \(t = (-?[0-9.]+(?:e-?\d+)?)s\))?/.exec(text);
  return m ? { frame: Number(m[1]), time: m[2] === undefined ? null : Number(m[2]), text } : null;
}
const num = (v: unknown) => (finite(v) ? v : null);
/** The figure a kind's bar is held against; a range's two ends; and where its worst frame is named. */
export function rowOf(name: string, line: Record<string, unknown>, printed: string | null): RequirementRow {
  const kind = String(line.kind ?? ''), status = String(line.status ?? '') as RequirementStatus;
  let measured: number | null = null, least: number | null = null, greatest: number | null = null, worst: WorstFrame | null = null;
  if (kind === 'contact' || kind === 'seam') { measured = num(line.largest_px); worst = worstFrame(line.at); }
  else if (kind === 'aim') { measured = num(line.largest_degrees); worst = worstFrame(line.at); }
  else if (kind === 'stretch') { measured = num(line.severity); worst = worstFrame(line.at); }
  else if (kind === 'range') {
    least = num(line.least_degrees); greatest = num(line.greatest_degrees);
    // The producer prints the bar as `range_degrees: [lo, hi]`.
    const bar = Array.isArray(line.range_degrees) ? line.range_degrees : [line.lo_degrees, line.hi_degrees];
    const lo = num(bar[0]), hi = num(bar[1]);
    // The end that breaks its bar, else the end with less room to its bar.
    const lowSide = least !== null && lo !== null && (least < lo || (greatest === null || hi === null || least - lo < hi - greatest));
    worst = worstFrame(lowSide ? line.least_at : line.greatest_at) ?? worstFrame(line.least_at);
  } else if (kind === 'follow') { measured = num(line.fraction_measured); worst = worstFrame(line.largest_residual_at) ?? worstFrame(line.largest_drive_at); }
  const reason = typeof line.reason === 'string' ? line.reason : null;
  const built = `${name}: ${status} — ${[...(reason ? [reason] : []), ...Object.entries(line).filter(([k]) => k !== 'status' && k !== 'reason').map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)].join('; ')}`;
  return { name, kind, animation: String(line.animation ?? ''), status, measured, least, greatest, worst, reason, line: printed ?? built };
}

export interface RequirementsReadout {
  rows: RequirementRow[];
  /** `requirements: N declared — …`, verbatim. */
  summary: string | null;
  /** check's last `check: …` line. */
  checkLine: string | null;
  /** Every `REQUIREMENTS_*` refusal line, verbatim (trimmed). Non-empty means the file was refused before anything was built. */
  refusals: string[];
  /** Every `CHECK_REQUIREMENT_MET` / `CHECK_REQUIREMENT_MEASURABLE` line, verbatim (trimmed). */
  problems: string[];
  /** check's first named refusal when it measured nothing (any code), else null. */
  refusal: string | null;
}
const REFUSAL_LINE = /^\s*FAIL\s+(REQUIREMENTS_[A-Z_]+)\b/, PROBLEM_LINE = /^\s*FAIL\s+(CHECK_REQUIREMENT_(?:MET|MEASURABLE))\b/;
/**
 * check's requirements, from `check.json`'s `requirements` block when check wrote one (its lines by name, in the file's
 * order), else from the printed `NAME: STATUS — …` lines of the names the file declares. The printed line is kept
 * verbatim beside the JSON's figures; the refusal and problem lines are kept verbatim.
 */
export function readRequirements(names: readonly string[], checkJson: unknown, lines: readonly string[]): RequirementsReadout {
  const trimmed = lines.map(l => l.trim());
  const printed = (name: string) => trimmed.find(l => l.startsWith(`${name}: PASS`) || l.startsWith(`${name}: FAIL`) || l.startsWith(`${name}: NOT MEASURABLE`)) ?? null;
  const block = isRecord(checkJson) && isRecord(checkJson.requirements) && isRecord(checkJson.requirements.lines) ? checkJson.requirements.lines : null;
  const rows: RequirementRow[] = [];
  for (const name of names) {
    const line = block && isRecord(block[name]) ? block[name] as Record<string, unknown> : null;
    const text = printed(name);
    if (line) rows.push(rowOf(name, line, text));
    else if (text) {
      const status = (/^[^:]+: (PASS|FAIL|NOT MEASURABLE)/.exec(text)?.[1] ?? 'FAIL') as RequirementStatus;
      const at = / at (frame \d+ \(t = [^)]*\))/.exec(text)?.[1] ?? null;
      rows.push({ name, kind: / kind (\w+)/.exec(text)?.[1] ?? '', animation: / animation ([^;]+)/.exec(text)?.[1] ?? '', status, measured: null, least: null, greatest: null, worst: worstFrame(at), reason: null, line: text });
    }
  }
  const refusals = trimmed.filter(l => REFUSAL_LINE.test(l)), problems = trimmed.filter(l => PROBLEM_LINE.test(l));
  return {
    rows, summary: trimmed.find(l => l.startsWith('requirements: ')) ?? null,
    checkLine: [...trimmed].reverse().find(l => l.startsWith('check: ')) ?? null,
    refusals, problems, refusal: rows.length ? null : refusals[0] ?? firstRefusal(lines),
  };
}

/**
 * `context.requirements` (#113): the requirements file the note was written against, by hash and content — its bytes
 * (`text`, exactly what the producer read), their sha256 and size — and the last check of exactly those bytes, or null.
 */
export interface RequirementsContext {
  schema: typeof REQUIREMENTS_CONTEXT_SCHEMA;
  sha256: string; size: number; text: string;
  checked: { build: RequirementsBuild; producer: { package: string; version: string }; summary: string | null; refusals: string[]; rows: { name: string; status: RequirementStatus; worst: WorstFrame | null }[] } | null;
}
const ctx = (detail: string): never => { throw new Error(`feedback.context.requirements: ${detail}`); };
/** The context's exact shape, its sha256 recomputed over `text` (`sha256` is the caller's hash function). */
export function parseRequirementsContext(value: unknown, sha256: (text: string) => string): RequirementsContext | null {
  if (value === null) return null;
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'checked,schema,sha256,size,text') return ctx('expected exactly {schema, sha256, size, text, checked}');
  if (value.schema !== REQUIREMENTS_CONTEXT_SCHEMA) ctx(`schema must be ${REQUIREMENTS_CONTEXT_SCHEMA}`);
  if (typeof value.text !== 'string' || value.text.length > REQUIREMENTS_LIMIT) ctx(`text must be the file's text, at most ${REQUIREMENTS_LIMIT} characters`);
  const text = value.text as string;
  if (typeof value.sha256 !== 'string' || value.sha256 !== sha256(text)) ctx('sha256 is not the sha256 of text');
  if (value.size !== new TextEncoder().encode(text).length) ctx('size is not the byte length of text');
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return ctx('text does not parse as JSON'); }
  if (!isRecord(doc) || doc.spec !== REQUIREMENTS_SPEC || Object.keys(doc).sort().join(',') !== 'fps,requirements,spec') ctx(`text must be a ${REQUIREMENTS_SPEC} file of spec, fps and requirements`);
  const checked = value.checked;
  if (checked !== null) {
    if (!isRecord(checked) || Object.keys(checked).sort().join(',') !== 'build,producer,refusals,rows,summary') ctx('checked: expected null or exactly {build, producer, summary, refusals, rows}');
    const c = checked as Record<string, unknown>;
    if (c.build !== 'inspected' && c.build !== 'scratch') ctx('checked.build');
    if (!isRecord(c.producer) || typeof c.producer.package !== 'string' || typeof c.producer.version !== 'string') ctx('checked.producer');
    if (c.summary !== null && typeof c.summary !== 'string') ctx('checked.summary');
    if (!Array.isArray(c.refusals) || !c.refusals.every(l => typeof l === 'string')) ctx('checked.refusals');
    if (!Array.isArray(c.rows) || c.rows.length > MAX_REQUIREMENTS || !c.rows.every(r => isRecord(r) && typeof r.name === 'string' && ['PASS', 'FAIL', 'NOT MEASURABLE'].includes(r.status as string) && (r.worst === null || (isRecord(r.worst) && Number.isSafeInteger(r.worst.frame))))) ctx('checked.rows');
  }
  return value as unknown as RequirementsContext;
}
/** "3 declared · sha256 ab12… · 2 PASS, 1 FAIL": one line for the issue export. */
export function requirementsSummaryLine(value: unknown): string | null {
  if (!isRecord(value) || value.schema !== REQUIREMENTS_CONTEXT_SCHEMA || typeof value.sha256 !== 'string' || typeof value.text !== 'string') return null;
  let count = 0;
  try { const doc = JSON.parse(value.text) as { requirements?: unknown[] }; count = Array.isArray(doc.requirements) ? doc.requirements.length : 0; } catch { return null; }
  const checked = isRecord(value.checked) ? value.checked : null;
  const result = checked ? (Array.isArray(checked.refusals) && checked.refusals.length ? ' · refused by the producer' : typeof checked.summary === 'string' ? ` · ${checked.summary}` : '') : ' · not checked';
  return `${count} declared · requirements file sha256 ${value.sha256}${result}`;
}
