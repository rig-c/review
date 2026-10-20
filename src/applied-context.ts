/**
 * What a feedback record's `context.applied` holds: the exact last applied state that was on the stage when the note was
 * written, or null. `rig-review-applied/1` is #99's region designation; `rig-review-applied/2` (#102) is a config patch
 * with its hash, the producer's line, the scratch `check.json` summary and the structural diff against the inspected
 * rig.json. A remesh patch from the Mesh panel (#106) adds `mesh`: the part and its vertex / triangle / hull counts before
 * and after, as the revision's `remesh.json` states them. Records without `applied`, or with null, stay valid. Pure.
 */
import { CONFIG_PATCH_SCHEMA, parseConfigPatch, type ConfigPatch } from './config-patch.ts';
import { parseBustSpec } from './chest-landmarks.ts';

export const APPLIED_REGIONS_SCHEMA = 'rig-review-applied/1';
export const APPLIED_PATCH_SCHEMA = 'rig-review-applied/2';
export const CHECK_SUMMARY_SCHEMA = 'rig-review-check-summary/1';
/** At most this many differing paths are listed; `count` always holds the full number. */
export const MAX_DIFF_PATHS = 200;

export interface CheckSummary {
  schema: typeof CHECK_SUMMARY_SCHEMA;
  /** check.json's PASS, or null when check wrote no check.json. */
  pass: boolean | null;
  exitCode: number;
  /** check's last `check: …` line (or its first named refusal when it wrote nothing), verbatim. */
  line: string | null;
  /** Every bar check.json carries as `{status}`, by name. */
  bars: Record<string, string>;
  gate: boolean | null;
}
export interface Tool { package: string; version: string }
export interface AppliedPatch {
  schema: typeof APPLIED_PATCH_SCHEMA;
  buildId: string;
  patch: ConfigPatch;
  patchSha256: string;
  configHash: string;
  producer: Tool; compiler: Tool;
  line: string | null;
  check: CheckSummary | null;
  diff: { count: number; paths: string[] } | null;
  modelHash: string;
  /** #106, a remesh patch only: `remesh.json`'s part counts. */
  mesh?: { part: string; before: MeshCounts; after: MeshCounts };
}
export interface MeshCounts { vertices: number; triangles: number; hull: number }
const meshCounts = (v: unknown, field: string) => {
  const c = exact(v, 'hull,triangles,vertices', field);
  if (![c.vertices, c.triangles, c.hull].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) throw new Error(`${field}: vertices, triangles and hull are whole numbers`);
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v: unknown, keys: string, field: string): Record<string, unknown> => {
  if (!isObject(v) || Object.keys(v).sort().join(',') !== keys) throw new Error(`${field}: expected exactly {${keys.split(',').join(', ')}}`);
  return v;
};
const tool = (v: unknown, field: string) => { const t = exact(v, 'package,version', field); if (typeof t.package !== 'string' || typeof t.version !== 'string') throw new Error(`${field}: package and version are strings`); };
const lineOrNull = (v: unknown, field: string) => { if (v !== null && (typeof v !== 'string' || v.length > 4000)) throw new Error(`${field}: expected the producer's line or null`); };

/** check's summary from what it wrote and printed. */
export function checkSummary(checkJson: unknown, exitCode: number, lines: readonly string[], refusal: string | null): CheckSummary {
  const bars: Record<string, string> = {};
  const doc = isObject(checkJson) ? checkJson : null;
  if (doc) for (const [name, value] of Object.entries(doc)) if (/^[A-Z][A-Z0-9_]+$/.test(name) && isObject(value) && typeof value.status === 'string') bars[name] = value.status;
  const last = [...lines].reverse().find(l => /^check:\s/.test(l.trim()))?.trim() ?? null;
  return { schema: CHECK_SUMMARY_SCHEMA, pass: doc && typeof doc.PASS === 'boolean' ? doc.PASS : null, exitCode, line: last ?? refusal, bars, gate: doc && typeof doc.gate_spine_html_green === 'boolean' ? doc.gate_spine_html_green : null };
}

function parseCheck(v: unknown, field: string): void {
  if (v === null) return;
  const c = exact(v, 'bars,exitCode,gate,line,pass,schema', field);
  if (c.schema !== CHECK_SUMMARY_SCHEMA) throw new Error(`${field}.schema: expected ${CHECK_SUMMARY_SCHEMA}`);
  if (c.pass !== null && typeof c.pass !== 'boolean') throw new Error(`${field}.pass: boolean or null`);
  if (c.gate !== null && typeof c.gate !== 'boolean') throw new Error(`${field}.gate: boolean or null`);
  if (!Number.isSafeInteger(c.exitCode)) throw new Error(`${field}.exitCode: integer`);
  lineOrNull(c.line, `${field}.line`);
  if (!isObject(c.bars) || !Object.values(c.bars).every(s => typeof s === 'string')) throw new Error(`${field}.bars: {name: status}`);
}

/** Null, #99's region record or #102's patch record, each exactly its shape. */
export function parseAppliedContext(value: unknown): void {
  if (value === null) return;
  if (!isObject(value)) throw new Error('feedback.context.applied: expected an applied record or null');
  const field = 'feedback.context.applied';
  if (value.schema === APPLIED_REGIONS_SCHEMA) {
    // #105: a landmarks Apply adds `bust` (the contour.bust entry as sent); its `regions` are review's derived circles.
    const v = exact(value, Object.hasOwn(value, 'bust') ? 'buildId,bust,compiler,configHash,entrySha256,line,modelHash,part,producer,regions,schema' : 'buildId,compiler,configHash,entrySha256,line,modelHash,part,producer,regions,schema', field);
    if (Object.hasOwn(v, 'bust')) { try { parseBustSpec(v.bust, `${field}.bust`); } catch (e) { throw new Error(e instanceof Error ? e.message : String(e)); } }
    if (![v.buildId, v.configHash, v.entrySha256, v.modelHash].every(hex)) throw new Error(`${field}: buildId, configHash, entrySha256 and modelHash are SHA-256 hex`);
    if (typeof v.part !== 'string' || !Array.isArray(v.regions)) throw new Error(`${field}: part and regions`);
    tool(v.producer, `${field}.producer`); tool(v.compiler, `${field}.compiler`); lineOrNull(v.line, `${field}.line`);
    return;
  }
  if (value.schema === APPLIED_PATCH_SCHEMA) {
    const v = exact(value, `buildId,check,compiler,configHash,diff,line,${Object.hasOwn(value, 'mesh') ? 'mesh,' : ''}modelHash,patch,patchSha256,producer,schema`, field);
    if (![v.buildId, v.configHash, v.patchSha256, v.modelHash].every(hex)) throw new Error(`${field}: buildId, configHash, patchSha256 and modelHash are SHA-256 hex`);
    let patch: ConfigPatch;
    try { patch = parseConfigPatch(v.patch); } catch (e) { throw new Error(`${field}.patch: ${e instanceof Error ? e.message : String(e)}`); }
    if (patch.config_sha256 !== v.configHash) throw new Error(`${field}: patch.config_sha256 is not configHash`);
    tool(v.producer, `${field}.producer`); tool(v.compiler, `${field}.compiler`); lineOrNull(v.line, `${field}.line`);
    parseCheck(v.check, `${field}.check`);
    if (Object.hasOwn(v, 'mesh')) {
      const m = exact(v.mesh, 'after,before,part', `${field}.mesh`);
      if (patch.op.cmd !== 'remesh' || patch.op.args[patch.op.args.indexOf('--part') + 1] !== m.part) throw new Error(`${field}.mesh.part: the part the patch's remesh names`);
      meshCounts(m.before, `${field}.mesh.before`); meshCounts(m.after, `${field}.mesh.after`);
    }
    if (v.diff !== null) {
      const d = exact(v.diff, 'count,paths', `${field}.diff`);
      if (!Number.isSafeInteger(d.count) || (d.count as number) < 0 || !Array.isArray(d.paths) || d.paths.length > MAX_DIFF_PATHS || d.paths.length > (d.count as number) || !d.paths.every(p => typeof p === 'string')) throw new Error(`${field}.diff: {count, paths ≤ ${MAX_DIFF_PATHS}}`);
    }
    return;
  }
  throw new Error(`${field}.schema: expected ${APPLIED_REGIONS_SCHEMA} or ${APPLIED_PATCH_SCHEMA} (patch ${CONFIG_PATCH_SCHEMA})`);
}

/** The export's one readable line for a valid applied record; the raw context still follows it. */
export function appliedSummary(value: unknown): string | null {
  try { parseAppliedContext(value); } catch { return null; }
  if (value === null) return 'the inspected build (nothing applied)';
  const v = value as Record<string, unknown>, producer = v.producer as Tool, model = String(v.modelHash).slice(0, 12);
  if (v.schema === APPLIED_REGIONS_SCHEMA && v.bust) return `contour.bust landmarks on ${String(v.part)} with ${producer.package} ${producer.version} · model ${model}…`;
  if (v.schema === APPLIED_REGIONS_SCHEMA) return `regions on ${String(v.part)} with ${producer.package} ${producer.version} · model ${model}…`;
  const a = value as AppliedPatch, paths = a.patch.ops.map(o => `${o.op} ${o.path}`);
  const check = a.check ? `check ${a.check.pass === null ? 'not read' : a.check.pass ? 'PASS' : 'FAIL'}` : 'check not run';
  const diff = a.diff ? ` · rig.json differs at ${a.diff.count} path(s)` : '';
  const mesh = a.mesh ? ` · ${a.mesh.part} v ${a.mesh.before.vertices} t ${a.mesh.before.triangles} → v ${a.mesh.after.vertices} t ${a.mesh.after.triangles}` : '';
  return `patch ${a.patchSha256.slice(0, 12)}… (${a.patch.op.cmd}; ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, +${paths.length - 3}` : ''}) with ${producer.package} ${producer.version} · ${check}${diff}${mesh} · model ${model}…`;
}

/**
 * HQ ruling on #103: a scratch build whose `rig-parts check` FAILed may be loaded and looked at, but a review whose
 * applied state failed check is not submitted. The refusal names check's FAIL line — the summary's `check: FAIL …` line,
 * else the first bar check.json marks FAIL — verbatim. Null when the record is not a patch or its check did not FAIL.
 */
export function appliedCheckRefusal(value: unknown): string | null {
  if (!isObject(value) || value.schema !== APPLIED_PATCH_SCHEMA || !isObject(value.check) || value.check.pass !== false) return null;
  const check = value.check as unknown as CheckSummary;
  const bar = Object.entries(check.bars ?? {}).find(([, status]) => status === 'FAIL')?.[0];
  const line = typeof check.line === 'string' && /\bFAIL\b/.test(check.line) ? check.line : bar ? `${bar}: FAIL` : `check exited ${check.exitCode}`;
  return `EDIT_SUBMIT_UNCHECKED: applied build failed check — ${line}`;
}
