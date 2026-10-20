/**
 * What a feedback record's `context.applied` holds: the exact last applied state that was on the stage when the note was
 * written, or null. `rig-review-applied/1` is #99's region designation; `rig-review-applied/2` (#102) is a config patch
 * with its hash, the producer's line, the scratch `check.json` summary and the structural diff against the inspected
 * rig.json. A remesh patch from the Mesh panel (#106) adds `mesh`: the part and its vertex / triangle / hull counts before
 * and after, as the revision's `remesh.json` states them. #125 adds `files`: the diff of every document the producer
 * writes (`src/producer-files.ts`), per file, and its images by hash; records without it (older ones) stay valid. #136
 * adds `op`: the producer op that ran (`rig`, `retune` or `remesh`); records without it stay valid.
 * `rig-review-applied/3` (#135) is Edit Mesh's delta, run by `rig-parts remesh --delta`: the `rig-review-mesh-edit/1`
 * document as sent (by content) and the SHA-256 of its bytes (`deltaSha256`, the download's file hash), the part, the
 * producer's line, `op` "remesh", the per-file diff and the part's counts.
 * `rig-review-applied/4` (#114) is a retarget: the `rig-review-retarget/1` record (the sequence by reference, path and
 * hash; the map by content and hash; the typed flags and their argv in `op`), the producer's line, what the scratch
 * motion holds against the inspected rig's (`motion`), the per-file diff and the run's FEET / STANCE / FLIP / SHORT /
 * END-ON / LEG-SCALE / REACH lines with their frames.
 * Records without `applied`, or with null, stay valid. Pure.
 */
import { CONFIG_PATCH_SCHEMA, parseConfigPatch, type ConfigPatch } from './config-patch.ts';
import { parseBustSpec } from './chest-landmarks.ts';
import { PRODUCER_DOCUMENTS, type ProducerDocument } from './producer-files.ts';
import { MESH_EDIT_BASIS, MESH_EDIT_MAX_OPS, MESH_EDIT_SCHEMA } from './mesh-edit.ts';
import { assertRetargetRecord, RETARGET_LINE_CODES, type MotionSummary, type RetargetLine, type RetargetRecord } from './retarget.ts';

export const APPLIED_REGIONS_SCHEMA = 'rig-review-applied/1';
export const APPLIED_PATCH_SCHEMA = 'rig-review-applied/2';
export const APPLIED_DELTA_SCHEMA = 'rig-review-applied/3';
export const APPLIED_RETARGET_SCHEMA = 'rig-review-applied/4';
/** At most this many retarget lines are kept in a record. */
export const MAX_RETARGET_LINES = 200;
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
  /** rig.json's diff (#102), kept as it was for older readers; `files` carries it too. */
  diff: { count: number; paths: string[] } | null;
  modelHash: string;
  /** #106, a remesh patch only: `remesh.json`'s part counts. */
  mesh?: { part: string; before: MeshCounts; after: MeshCounts };
  /** #125: every producer document's diff, per file, and the images by hash. Absent in older records. */
  files?: FilesDiff | null;
  /** #136: the producer op that ran — `retune`, `rig` or (#115) `build` for a `rig` patch, `remesh` for a remesh patch. Absent in older records. */
  op?: 'rig' | 'retune' | 'remesh' | 'build';
  /** #115, a `build` op only: the build's wall clock, the recomposite figures before and after, the parts it changed and its `seam pair` lines. */
  assembled?: AppliedAssembled;
  /** #112: the `rigc-environment/1` schedule the Apply's check read (`--environment`), by hash and step count. Absent: the default world. */
  environment?: { sha256: string; steps: number };
}
/** #115: what a `rig-parts build` Apply measured, recorded per Apply. `wallMs` is the build's own wall clock (assemble → rig → check). */
export interface AppliedAssembled { wallMs: number | null; recomposite: { before: Record<string, number> | null; after: Record<string, number> | null }; partsChanged: string[]; seamPairs: string[] }
export const MAX_SEAM_PAIR_LINES = 64;
const RECOMPOSITE_KEYS = 'error_px,hole_count,mean_abs,uncovered_error_px,within_share';
function parseAssembled(v: unknown, field: string): void {
  const a = exact(v, 'partsChanged,recomposite,seamPairs,wallMs', field);
  if (a.wallMs !== null && !count(a.wallMs)) throw new Error(`${field}.wallMs: whole ms or null`);
  const r = exact(a.recomposite, 'after,before', `${field}.recomposite`);
  for (const side of ['before', 'after'] as const) if (r[side] !== null) { const f = exact(r[side], RECOMPOSITE_KEYS, `${field}.recomposite.${side}`); if (!Object.values(f).every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${field}.recomposite.${side}: numbers`); }
  if (!Array.isArray(a.partsChanged) || a.partsChanged.length > MAX_DIFF_PATHS || !a.partsChanged.every(n => typeof n === 'string')) throw new Error(`${field}.partsChanged: at most ${MAX_DIFF_PATHS} part names`);
  if (!Array.isArray(a.seamPairs) || a.seamPairs.length > MAX_SEAM_PAIR_LINES || !a.seamPairs.every(l => typeof l === 'string' && l.length <= 4000)) throw new Error(`${field}.seamPairs: at most ${MAX_SEAM_PAIR_LINES} lines`);
}
/** #135: Edit Mesh's delta as applied by `rig-parts remesh --delta`. */
export interface AppliedDelta {
  schema: typeof APPLIED_DELTA_SCHEMA;
  buildId: string;
  part: string;
  /** The `rig-review-mesh-edit/1` document as sent to the producer. */
  delta: Record<string, unknown>;
  /** SHA-256 of the delta's bytes as written (`meshEditText`): the binding's `file.sha256` for the same document. */
  deltaSha256: string;
  configHash: string;
  producer: Tool; compiler: Tool;
  line: string | null;
  op: 'remesh';
  files: FilesDiff | null;
  mesh?: { part: string; before: MeshCounts; after: MeshCounts };
  modelHash: string;
}
/** #114: a retarget as applied by `rig-pose clean` + `rig-pose retarget`, compiled in scratch. */
export interface AppliedRetarget {
  schema: typeof APPLIED_RETARGET_SCHEMA;
  buildId: string;
  retarget: RetargetRecord;
  /** SHA-256 of the record's bytes as review hashes them (`retargetRecordText`). */
  recordSha256: string;
  configHash: string;
  producer: Tool; compiler: Tool;
  line: string | null;
  motion: MotionSummary;
  files: FilesDiff | null;
  readings: RetargetLine[];
  modelHash: string;
}
/** One producer document against the inspected one: `count` differing JSON Pointers, the first `MAX_DIFF_PATHS` listed. */
export interface DocumentDiff { file: ProducerDocument; count: number; paths: string[] }
/** #125: the documents in `PRODUCER_DOCUMENTS` order (a document neither side has is left out) and the images by hash. */
export interface FilesDiff { documents: DocumentDiff[]; images: { changed: number; unchanged: number; names: string[] } }
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
function parseFilesDiff(v: unknown, field: string): void {
  if (v === null) return;
  const f = exact(v, 'documents,images', field);
  if (!Array.isArray(f.documents)) throw new Error(`${field}.documents: expected [{file, count, paths}]`);
  const seen = new Set<string>();
  for (const [i, entry] of f.documents.entries()) {
    const d = exact(entry, 'count,file,paths', `${field}.documents[${i}]`);
    if (typeof d.file !== 'string' || !(PRODUCER_DOCUMENTS as readonly string[]).includes(d.file) || seen.has(d.file)) throw new Error(`${field}.documents[${i}].file: one of ${PRODUCER_DOCUMENTS.join(', ')}, each once`);
    seen.add(d.file);
    if (!count(d.count) || !Array.isArray(d.paths) || d.paths.length > MAX_DIFF_PATHS || d.paths.length > (d.count as number) || !d.paths.every(p => typeof p === 'string')) throw new Error(`${field}.documents[${i}]: {count, paths ≤ ${MAX_DIFF_PATHS}}`);
  }
  const m = exact(f.images, 'changed,names,unchanged', `${field}.images`);
  if (!count(m.changed) || !count(m.unchanged) || !Array.isArray(m.names) || m.names.length > MAX_DIFF_PATHS || m.names.length > (m.changed as number) || !m.names.every(n => typeof n === 'string')) throw new Error(`${field}.images: {changed, unchanged, names ≤ ${MAX_DIFF_PATHS}}`);
}
/**
 * The diff in one line, e.g. `motion.json differs at 2 path(s) · rig.json, sets.json, mesh_report.json unchanged · 31
 * images unchanged`: each differing document by name, then the unchanged ones, then the images.
 */
export function filesDiffText(files: FilesDiff): string {
  const differs = files.documents.filter(d => d.count > 0).map(d => `${d.file} differs at ${d.count} path(s)`);
  const same = files.documents.filter(d => d.count === 0).map(d => d.file);
  const { changed, unchanged } = files.images;
  const images = changed ? `${changed} image(s) changed, ${unchanged} unchanged` : `${unchanged} images unchanged`;
  return [...differs, ...(same.length ? [`${same.join(', ')} unchanged`] : []), images].join(' · ');
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
    const v = exact(value, `${Object.hasOwn(value, 'assembled') ? 'assembled,' : ''}buildId,check,compiler,configHash,diff,${Object.hasOwn(value, 'environment') ? 'environment,' : ''}${Object.hasOwn(value, 'files') ? 'files,' : ''}line,${Object.hasOwn(value, 'mesh') ? 'mesh,' : ''}modelHash,${Object.hasOwn(value, 'op') ? 'op,' : ''}patch,patchSha256,producer,schema`, field);
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
    if (Object.hasOwn(v, 'files')) parseFilesDiff(v.files, `${field}.files`);
    if (Object.hasOwn(v, 'environment')) { const e = exact(v.environment, 'sha256,steps', `${field}.environment`); if (!hex(e.sha256) || !Number.isSafeInteger(e.steps) || (e.steps as number) < 1) throw new Error(`${field}.environment: {sha256 (SHA-256 hex), steps ≥ 1}`); }
    // #136: a remesh patch ran remesh; a rig patch ran rig, retune or (#115) build.
    if (Object.hasOwn(v, 'op') && !(patch.op.cmd === 'remesh' ? ['remesh'] : ['rig', 'retune', 'build']).includes(v.op as string)) throw new Error(`${field}.op: ${patch.op.cmd === 'remesh' ? '"remesh" for a remesh patch' : '"rig", "retune" or "build" for a rig patch'}`);
    // #115: the build's measurements ride with a build op only, and a build op carries them.
    if (Object.hasOwn(v, 'assembled') !== (v.op === 'build')) throw new Error(`${field}.assembled: present exactly when op is "build"`);
    if (Object.hasOwn(v, 'assembled')) parseAssembled(v.assembled, `${field}.assembled`);
    if (v.diff !== null) {
      const d = exact(v.diff, 'count,paths', `${field}.diff`);
      if (!Number.isSafeInteger(d.count) || (d.count as number) < 0 || !Array.isArray(d.paths) || d.paths.length > MAX_DIFF_PATHS || d.paths.length > (d.count as number) || !d.paths.every(p => typeof p === 'string')) throw new Error(`${field}.diff: {count, paths ≤ ${MAX_DIFF_PATHS}}`);
    }
    return;
  }
  if (value.schema === APPLIED_DELTA_SCHEMA) {
    const v = exact(value, `buildId,compiler,configHash,delta,deltaSha256,files,line,${Object.hasOwn(value, 'mesh') ? 'mesh,' : ''}modelHash,op,part,producer,schema`, field);
    if (![v.buildId, v.configHash, v.deltaSha256, v.modelHash].every(hex)) throw new Error(`${field}: buildId, configHash, deltaSha256 and modelHash are SHA-256 hex`);
    if (typeof v.part !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.part)) throw new Error(`${field}.part: the part remesh --delta ran on`);
    const d = v.delta;
    if (!isObject(d) || d.schema !== MESH_EDIT_SCHEMA || d.basis !== MESH_EDIT_BASIS || d.slot !== v.part || !isObject(d.source) || !hex(d.source.hash) || !Array.isArray(d.ops) || d.ops.length > MESH_EDIT_MAX_OPS) throw new Error(`${field}.delta: a ${MESH_EDIT_SCHEMA} document (basis "${MESH_EDIT_BASIS}", slot the part, source.hash, at most ${MESH_EDIT_MAX_OPS} ops)`);
    if (v.op !== 'remesh') throw new Error(`${field}.op: "remesh" for a mesh-edit delta`);
    tool(v.producer, `${field}.producer`); tool(v.compiler, `${field}.compiler`); lineOrNull(v.line, `${field}.line`);
    parseFilesDiff(v.files, `${field}.files`);
    if (Object.hasOwn(v, 'mesh')) {
      const m = exact(v.mesh, 'after,before,part', `${field}.mesh`);
      if (m.part !== v.part) throw new Error(`${field}.mesh.part: the delta's part`);
      meshCounts(m.before, `${field}.mesh.before`); meshCounts(m.after, `${field}.mesh.after`);
    }
    return;
  }
  if (value.schema === APPLIED_RETARGET_SCHEMA) {
    const v = exact(value, 'buildId,compiler,configHash,files,line,modelHash,motion,producer,readings,recordSha256,retarget,schema', field);
    if (![v.buildId, v.configHash, v.recordSha256, v.modelHash].every(hex)) throw new Error(`${field}: buildId, configHash, recordSha256 and modelHash are SHA-256 hex`);
    const record = assertRetargetRecord(v.retarget, `${field}.retarget`);
    if (record.config_sha256 !== v.configHash) throw new Error(`${field}: retarget.config_sha256 is not configHash`);
    tool(v.producer, `${field}.producer`); tool(v.compiler, `${field}.compiler`); lineOrNull(v.line, `${field}.line`);
    const m = exact(v.motion, 'animation,animationSha256,animations,changed,kept,motionSha256', `${field}.motion`);
    if (m.animation !== record.flags.animation || typeof m.kept !== 'boolean' || !hex(m.motionSha256) || (m.animationSha256 !== null && !hex(m.animationSha256)) || !Array.isArray(m.animations) || !m.animations.every(a => typeof a === 'string') || !Array.isArray(m.changed) || !m.changed.every(a => typeof a === 'string')) throw new Error(`${field}.motion: {animation (the record's), animations, kept, changed, animationSha256, motionSha256}`);
    parseFilesDiff(v.files, `${field}.files`);
    if (!Array.isArray(v.readings) || v.readings.length > MAX_RETARGET_LINES) throw new Error(`${field}.readings: at most ${MAX_RETARGET_LINES} lines`);
    for (const [i, r] of v.readings.entries()) {
      const x = exact(r, 'code,frame,line,time', `${field}.readings[${i}]`);
      if (!(RETARGET_LINE_CODES as readonly string[]).includes(x.code as string) || typeof x.line !== 'string' || x.line.length > 4000 || (x.frame !== null && !count(x.frame)) || (x.time !== null && (typeof x.time !== 'number' || !Number.isFinite(x.time)))) throw new Error(`${field}.readings[${i}]: {code, line, frame, time}`);
    }
    return;
  }
  throw new Error(`${field}.schema: expected ${APPLIED_REGIONS_SCHEMA}, ${APPLIED_PATCH_SCHEMA} (patch ${CONFIG_PATCH_SCHEMA}), ${APPLIED_DELTA_SCHEMA} (mesh-edit delta) or ${APPLIED_RETARGET_SCHEMA} (retarget)`);
}

/** The export's one readable line for a valid applied record; the raw context still follows it. */
export function appliedSummary(value: unknown): string | null {
  try { parseAppliedContext(value); } catch { return null; }
  if (value === null) return 'the inspected build (nothing applied)';
  const v = value as Record<string, unknown>, producer = v.producer as Tool, model = String(v.modelHash).slice(0, 12);
  if (v.schema === APPLIED_REGIONS_SCHEMA && v.bust) return `contour.bust landmarks on ${String(v.part)} with ${producer.package} ${producer.version} · model ${model}…`;
  if (v.schema === APPLIED_REGIONS_SCHEMA) return `regions on ${String(v.part)} with ${producer.package} ${producer.version} · model ${model}…`;
  if (v.schema === APPLIED_RETARGET_SCHEMA) {
    const r = value as AppliedRetarget, seq = r.retarget.sequence;
    return `retarget "${r.motion.animation}" from ${seq.reference} (${seq.sha256.slice(0, 12)}…) with map ${r.retarget.map_sha256.slice(0, 12)}… and ${producer.package} ${producer.version} (${r.retarget.op.clean ? 'clean, ' : ''}retarget ${r.retarget.op.args.join(' ')})${r.motion.kept ? '' : ` · changed ${r.motion.changed.join(', ')}`} · ${r.readings.length} line(s) · model ${model}…`;
  }
  if (v.schema === APPLIED_DELTA_SCHEMA) {
    const d = value as AppliedDelta, ops = (d.delta.ops as unknown[]).length;
    const mesh = d.mesh ? ` · ${d.mesh.part} v ${d.mesh.before.vertices} t ${d.mesh.before.triangles} → v ${d.mesh.after.vertices} t ${d.mesh.after.triangles}` : '';
    return `mesh edit ${d.deltaSha256.slice(0, 12)}… (remesh --delta; ${ops} op(s) on ${d.part}) with ${producer.package} ${producer.version}${d.files ? ` · ${filesDiffText(d.files)}` : ''}${mesh} · model ${model}…`;
  }
  const a = value as AppliedPatch, paths = a.patch.ops.map(o => `${o.op} ${o.path}`);
  const check = a.check ? `check ${a.check.pass === null ? 'not read' : a.check.pass ? 'PASS' : 'FAIL'}` : 'check not run';
  const diff = a.files ? ` · ${filesDiffText(a.files)}` : a.diff ? ` · rig.json differs at ${a.diff.count} path(s)` : '';
  const mesh = a.mesh ? ` · ${a.mesh.part} v ${a.mesh.before.vertices} t ${a.mesh.before.triangles} → v ${a.mesh.after.vertices} t ${a.mesh.after.triangles}` : '';
  const assembled = a.assembled ? ` · build ${a.assembled.wallMs === null ? '—' : `${(a.assembled.wallMs / 1000).toFixed(1)} s`}${a.assembled.partsChanged.length ? ` · parts changed: ${a.assembled.partsChanged.slice(0, 6).join(', ')}${a.assembled.partsChanged.length > 6 ? ', …' : ''}` : ''}${a.assembled.recomposite.before && a.assembled.recomposite.after ? ` · recomposite error px ${a.assembled.recomposite.before.error_px} → ${a.assembled.recomposite.after.error_px}` : ''}` : '';
  return `patch ${a.patchSha256.slice(0, 12)}… (${a.op ?? a.patch.op.cmd}; ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, +${paths.length - 3}` : ''}) with ${producer.package} ${producer.version} · ${check}${diff}${mesh}${assembled} · model ${model}…`;
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
