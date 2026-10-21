/**
 * Apply · Rebuild (issue #99): the user's chest-region designation goes to the installed producer as one mesh entry,
 * `rig-parts remesh` re-fits that one part of the package's gated rig into a scratch revision, `rigc build` compiles
 * the revision the way remesh's own gate did, and the compiled scratch build is served read-only for the viewer to
 * load in place. Review builds nothing itself, writes nothing into the package and takes no path from the client:
 * the producer inputs are the package's resolved handoff (#101, `src/handoff.ts`: declared, else the fixed discovery
 * order), the scratch directory is `<state>/rebuild/<package hash>/<designation hash>/` (no clock), and an identical
 * designation reuses its build. Once per session the baseline (`src/baseline.ts`) rebuilds the whole rig from the
 * handoff and says whether it reproduces the inspected rig.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { object, packagePath, safeFile, type ReviewPackage } from './manifest.ts';
import { compileArgs, firstRefusal, modelingProducerTooOld, REMESH_DELTA_SINCE, remeshArgs, remeshDeltaArgs, resolvePose, resolveProducer, runTool, versionAtLeast, type CompileRequest, type InstalledTool, type ProcessResult } from './producer.ts';
import { meshEditText } from './mesh-edit.ts';
import { CONFIG_NAMED_FILES, HANDOFF_DECLARATION, type Handoff, type HandoffRecord } from './handoff.ts';
import { assertWholeRigBaseline, BaselineError, baselineKey, producerDiff, runBaseline, runInspectedCheck, runningInspectedCheck, type BaselineResult, type InspectedCheck } from './baseline.ts';
import { applyConfigPatch, assertOpNames, assertPatchFresh, ConfigPatchError, parseConfigPatch, patchSha256, patchText, remeshPart, type ConfigPatch, type JsonValue } from './config-patch.ts';
import { checkSummary, filesDiffText, MAX_RETARGET_LINES, type CheckSummary, type FilesDiff } from './applied-context.ts';
import { idleKeying, idleSource, type IdleStatus } from './idle-tracks.ts';
import { CHEST_REGIONS_MAX } from './chest-regions.ts';
import { bustMeshEntry, deriveBust, parseBustSpec, BustSpecError, type BustSpec } from './chest-landmarks.ts';
import { modelMeshTriangles, remeshCounts, type RemeshCounts } from './mesh-entry.ts';
import { patchRoute } from './retune-route.ts';
import { producerHint } from './baseline-reach.ts';
import { carriedCheck, carriedCheckSummary, type CarryingOp, provenanceFile, REMESH_CHECK_SINCE, RETUNE_CHECK_SINCE, revisionBinding } from './retune-check.ts';
import { absolutizeBuildFiles, buildLines, buildNamedFiles, buildReadout, MAX_BUILD_READOUT, needsBuild, newBuildFile, recompositeFigures, type RecompositeFigures } from './build-route.ts';
import { jsonDiff } from './config-patch.ts';
import { CLOTH_KEYPOINTS_UNDECLARED, CLOTH_PATCH_MIXED, CLOTH_SOURCE_UNAVAILABLE, CLOTH_WRITE_SINCE, clothLinks, clothPatchKind, readClothTargets, writtenDiff, type ClothTagView, type WrittenDiff } from './cloth-recipe.ts';
import { CHECK_ENVIRONMENT_SINCE, parseSchedule, ScheduleError, scheduleText } from './environment-schedule.ts';
import { availableParallelism } from 'node:os';
import { candidateRow, DENSITY_STRIP_SCHEMA, DensityStripError, stripLabels, stripPatches, stripShape, type DensityField, type StripRow } from './density-strip.ts';
import { samplesClock } from './frame-clock.ts';
import { cleanArgs, mapText, motionSummary, parseRetargetRequest, retargetArgs, retargetLines, retargetRecord, retargetRecordText, RetargetError, type MotionSummary, type RetargetLine, type RetargetRecord } from './retarget.ts';

export const REBUILD_SCHEMA = 'rig-review-rebuild/1';
const MAX_REGIONS = CHEST_REGIONS_MAX, MAX_POINTS = 256, MAX_LINES = 4000, GRID = 256;

export interface ProducerInputs { config: string; parts: string; rig: string; configText: string; configHash: string; handoff: HandoffRecord }
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Without any handoff, Apply refuses by this name and says which flag declares one. */
export const modelingHandoffMissing = (reason: string | null) => `MODELING_HANDOFF_MISSING: no producer handoff — declare it with ${HANDOFF_DECLARATION}${reason ? ` (${reason})` : ''}`;
/** What remesh needs from the handoff, or the line naming what is missing. */
export function handoffGap(handoff: Handoff): string | null {
  if (!handoff.parts) return `MODELING_INPUT_UNAVAILABLE: ${handoff.record.missing.join(', ')}`;
  const missing = handoff.record.missing.filter(m => m.startsWith('parts.json') || m.startsWith('rig '));
  return handoff.rig && !missing.length ? null : `MODELING_INPUT_UNAVAILABLE: ${missing.join(', ') || 'rig'}`;
}
/** The handoff's config, parts and inspected rig, the config read and checked against the bytes the session is bound to. */
export async function producerInputs(handoff: Handoff | null, reason: string | null): Promise<ProducerInputs> {
  if (!handoff) throw new RebuildError('MODELING_HANDOFF_MISSING', modelingHandoffMissing(reason).slice('MODELING_HANDOFF_MISSING: '.length));
  const gap = handoffGap(handoff);
  if (gap) throw new RebuildError('MODELING_INPUT_UNAVAILABLE', gap.slice('MODELING_INPUT_UNAVAILABLE: '.length));
  const configText = await readFile(handoff.config, 'utf8'), configHash = sha256(configText);
  if (configHash !== handoff.record.config.sha256) throw new RebuildError('REBUILD_INPUTS_CHANGED', `${handoff.record.config.path} changed since the review was opened; restart review`);
  return { config: handoff.config, parts: handoff.parts!, rig: handoff.rig!, configText, configHash, handoff: handoff.record };
}

/** The config's `constraints` list as written, or null when it has none. */
export function configConstraints(configText: string): unknown[] | null {
  const list = object(JSON.parse(configText), 'config').constraints;
  return Array.isArray(list) ? list : null;
}

/**
 * The idle the Idle tracks panel edits (#104): the config's motion as written (shapes read by `idleSource`) and where
 * the inspected idle keys each track (`idleKeying`, read off the handoff rig's rig.json and motion.json).
 */
export async function idleStatus(inputs: Pick<ProducerInputs, 'configText' | 'rig'>): Promise<IdleStatus> {
  const read = async (name: string): Promise<unknown> => { try { return JSON.parse(await readFile(join(inputs.rig, name), 'utf8')); } catch { return null; } };
  return { source: idleSource(JSON.parse(inputs.configText)), keying: idleKeying(await read('rig.json'), await read('motion.json')) };
}

export type ProducerRegion =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; bone: string; spacing: number; band: number }
  | { name: string; bone: string; shape: 'polygon'; points: [number, number][]; spacing: number; band: number };
export interface ContourPart { name: string; regions: unknown[]; entry: Record<string, unknown> }
/** The config's `bones` list as written (#109), or null when it states none. */
export function configBonesList(configText: string): unknown[] | null {
  const list = object(JSON.parse(configText), 'config').bones;
  return Array.isArray(list) ? list : null;
}
/**
 * The config's sections the Rig fields block edits (#110), as written: `regions`, `motion.blink`, `stops`, `bones` and
 * `turn` (an absent section is left out). The block reads them with `rigFieldsSource` (`src/rig-fields.ts`).
 */
export function configFields(configText: string): Record<string, unknown> {
  const config = object(JSON.parse(configText), 'config'), motion = config.motion, out: Record<string, unknown> = {};
  for (const key of ['regions', 'stops', 'bones', 'turn']) if (config[key] !== undefined) out[key] = config[key];
  if (motion && typeof motion === 'object' && !Array.isArray(motion) && (motion as Record<string, unknown>).blink !== undefined) out.motion = { blink: (motion as Record<string, unknown>).blink };
  return out;
}
/**
 * #115: what the Cuts block edits, as written — `assemble.plan`, `assemble.cuts`, `assemble.patches` (each only when
 * the config states it) and `limbs` — read by `cutsSource` (`src/cut-edits.ts`).
 */
export function configCuts(configText: string): Record<string, unknown> {
  const config = object(JSON.parse(configText), 'config'), assemble = config.assemble, out: Record<string, unknown> = {};
  if (assemble && typeof assemble === 'object' && !Array.isArray(assemble)) {
    const a = assemble as Record<string, unknown>, kept: Record<string, unknown> = {};
    for (const key of ['plan', 'cuts', 'patches']) if (a[key] !== undefined) kept[key] = a[key];
    out.assemble = kept;
  }
  if (config.limbs !== undefined) out.limbs = config.limbs;
  return out;
}
/** #115: why a build-routed Apply cannot run here (the handoff declares no painting and full run), or null. */
export const buildGap = (handoff: Handoff | null) => (handoff && handoff.source && handoff.full ? null : BUILD_SOURCE_UNAVAILABLE);
/** Every `meshes.<part>` entry as written (#106: the Mesh panel starts from the config's own entry). */
export function configMeshes(configText: string): Record<string, unknown> {
  const meshes = object(JSON.parse(configText), 'config').meshes;
  return meshes && typeof meshes === 'object' && !Array.isArray(meshes) ? meshes as Record<string, unknown> : {};
}
/** Config meshes whose entry is a contour (the only mode with regions); its regions as written. */
export function contourParts(configText: string): ContourPart[] {
  const config = object(JSON.parse(configText), 'config'), meshes = config.meshes;
  if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) return [];
  return Object.entries(meshes as Record<string, unknown>).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const contour = (entry as Record<string, unknown>).contour;
    if (!contour || typeof contour !== 'object' || Array.isArray(contour)) return [];
    const regions = (contour as Record<string, unknown>).regions;
    return [{ name, regions: Array.isArray(regions) ? regions : [], entry: entry as Record<string, unknown> }];
  });
}

export class RebuildError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new RebuildError('REBUILD_REQUEST_INVALID', detail); };
const finite = (value: unknown, field: string, min = -Infinity, exclusive = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (exclusive ? value <= min : value < min)) bad(`${field} must be a finite number${min === -Infinity ? '' : exclusive ? ` > ${min}` : ` >= ${min}`}`);
  return value as number;
};
const onGrid = (value: number, field: string) => { if (!Number.isInteger(value * GRID)) bad(`${field} is off the 1/${GRID} px grid`); return value; };

/** One designated region in the producer's config shape. Geometry beyond types and the grid is the producer's to judge. */
export function parseProducerRegion(value: unknown, field: string, bones: readonly string[] | null): ProducerRegion {
  const v = object(value, field), keys = Object.keys(v).sort().join(',');
  const name = v.name, bone = v.bone;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) bad(`${field}.name`);
  if (typeof bone !== 'string' || !bone || bone.length > 128) bad(`${field}.bone`);
  if (bones && !bones.includes(bone as string)) throw new RebuildError('REBUILD_REGION_BONE_UNKNOWN', `${field}.bone ${String(bone)} is not a bone of the loaded model`);
  const spacing = finite(v.spacing, `${field}.spacing`, 0, true), band = onGrid(finite(v.band, `${field}.band`, 0), `${field}.band`);
  if (v.shape === 'circle') {
    if (keys !== 'band,bone,cx,cy,name,r,shape,spacing') bad(`${field}: a circle holds exactly name, shape, cx, cy, r, bone, spacing, band`);
    return { name: name as string, shape: 'circle', cx: onGrid(finite(v.cx, `${field}.cx`), `${field}.cx`), cy: onGrid(finite(v.cy, `${field}.cy`), `${field}.cy`), r: finite(v.r, `${field}.r`, 0, true), bone: bone as string, spacing, band };
  }
  if (v.shape === 'polygon') {
    if (keys !== 'band,bone,name,points,shape,spacing') bad(`${field}: a polygon holds exactly name, bone, shape, points, spacing, band`);
    if (!Array.isArray(v.points) || v.points.length < 3 || v.points.length > MAX_POINTS) bad(`${field}.points must hold 3–${MAX_POINTS} points`);
    const points = (v.points as unknown[]).map((p, i): [number, number] => {
      if (!Array.isArray(p) || p.length !== 2) bad(`${field}.points[${i}]`);
      const [x, y] = p as unknown[];
      return [onGrid(finite(x, `${field}.points[${i}].x`), `${field}.points[${i}].x`), onGrid(finite(y, `${field}.points[${i}].y`), `${field}.points[${i}].y`)];
    });
    return { name: name as string, bone: bone as string, shape: 'polygon', points, spacing, band };
  }
  return bad(`${field}.shape must be circle or polygon`);
}

/**
 * `{part, regions}` (#99, the regions as written) or `{part, bust}` (#105, the `contour.bust` landmarks); `regions` of a
 * bust request is review's derivation of the two circles (`src/chest-landmarks.ts`), recorded beside it, never sent.
 */
export interface RebuildRequest { part: string; regions: ProducerRegion[]; configHash: string; bust?: BustSpec }
/** `{part, regions, configHash}` or `{part, bust, configHash}`: no path, no flag, no command — the server composes everything else. */
export function parseRebuildRequest(input: unknown, bones: readonly string[] | null): RebuildRequest {
  const v = object(input, 'rebuild'), keys = Object.keys(v).sort().join(',');
  if (keys !== 'configHash,part,regions' && keys !== 'bust,configHash,part') bad('expected exactly {part, regions, configHash} or {part, bust, configHash}');
  if (typeof v.part !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.part)) bad('part');
  if (typeof v.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.configHash)) bad('configHash');
  if ('bust' in v) {
    // Typed as the producer's loader types it; whether the circles clear and the bones resolve is the producer's call.
    let bust: BustSpec;
    try { bust = parseBustSpec(v.bust); } catch (e) { if (e instanceof BustSpecError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    return { part: v.part as string, regions: deriveBust(bust).regions.map(r => ({ ...r })), configHash: v.configHash as string, bust };
  }
  if (!Array.isArray(v.regions) || v.regions.length < 1 || v.regions.length > MAX_REGIONS) bad(`regions must hold 1–${MAX_REGIONS} entries`);
  const regions = (v.regions as unknown[]).map((r, i) => parseProducerRegion(r, `regions[${i}]`, bones));
  if (new Set(regions.map(r => r.name)).size !== regions.length) bad('regions: duplicate names');
  return { part: v.part as string, regions, configHash: v.configHash as string };
}

/** The part's config entry with `contour.regions` replaced by the designation and every other field as written. */
export function meshEntryText(configText: string, part: string, regions: readonly ProducerRegion[]): string {
  const found = contourParts(configText).find(p => p.name === part);
  if (!found) throw new RebuildError('REBUILD_PART_NOT_CONTOUR', `config meshes.${part} is not a contour entry; regions apply to contour meshes only`);
  const entry = structuredClone(found.entry), contour = entry.contour as Record<string, unknown>;
  contour.regions = regions.map(r => ({ ...r }));
  return JSON.stringify(entry, null, 1) + '\n';
}
/** The part's config entry with `contour.bust` in place of `contour.regions` (#105) and every other field as written. */
export function bustEntryText(configText: string, part: string, bust: BustSpec): string {
  const found = contourParts(configText).find(p => p.name === part);
  if (!found) throw new RebuildError('REBUILD_PART_NOT_CONTOUR', `config meshes.${part} is not a contour entry; contour.bust applies to contour meshes only`);
  return JSON.stringify(bustMeshEntry(found.entry, bust), null, 1) + '\n';
}

/** Deterministic: the package, the config bytes, the part, the entry bytes and both tool versions. No clock. */
export function designationId(input: { sourceHash: string; configHash: string; part: string; entry: string; producer: string; compiler: string }): string {
  return sha256(JSON.stringify([REBUILD_SCHEMA, input.sourceHash, input.configHash, input.part, input.entry, input.producer, input.compiler]));
}
export const rebuildRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'rebuild', sourceHash);
export const rebuildDir = (stateDir: string, sourceHash: string, id: string) => join(rebuildRoot(stateDir, sourceHash), id);
/**
 * #166: where the applied records' earlier builds wait for an undo — outside the scratch root, so the scratch root still
 * holds only the build on the stage. At most `MAX_KEPT_BUILDS` builds are on disk per package (the stage's included);
 * an older record's build is evicted, and undoing to it re-runs its producer step from the record.
 */
export const keptRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'rebuild-kept', sourceHash);
export const MAX_KEPT_BUILDS = 8;
/** The undo refusal: the predecessor cannot be restored byte for byte, and review does not guess. */
export const UNDO_PREDECESSOR_CHANGED = 'UNDO_PREDECESSOR_CHANGED';
/** One applied record of the session's stack (#166): the request as sent (to re-run it), its inputs and its build by hash. */
export interface AppliedEntry {
  id: string; body: unknown; configHash: string;
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  files: Record<string, string>; modelHash: string;
  /** The job as it settled, served back on undo. */
  job: RebuildJob | PatchJob | DeltaJob | RetargetJob;
}
/** `GET /api/rebuild/history`: the applied records in order, the last one on the stage; `kept`: its build is still on disk. */
export interface AppliedHistory { schema: 'rig-review-applied-history/1'; depth: number; records: { id: string; kind: 'regions' | 'patch' | 'delta' | 'retarget'; op: string; what: string; modelHash: string; kept: boolean }[] }

export type RebuildStatus = 'running' | 'built' | 'refused' | 'failed';
export interface RebuildBuild { model: string; modelUrl: string; modelHash: string; files: Record<string, string> }
export interface RebuildJob {
  schema: typeof REBUILD_SCHEMA; id: string; status: RebuildStatus; reused: boolean;
  request: { part: string; regions: ProducerRegion[]; configHash: string; entrySha256: string; bust?: BustSpec };
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  lines: string[]; producerLine: string | null; exitCode: number | null; wallMs: { remesh: number | null; compile: number | null };
  build: RebuildBuild | null;
  /** #148: review's reading of a producer refusal it can explain (`producerHint`), beside the producer's line; absent otherwise. */
  hint?: string;
}
/**
 * A patch Apply (#102): the config patch, its hash and the config bytes it was made against; the op's, the compile's
 * and check's wall clocks; check's summary; and every JSON Pointer at which the scratch rig.json differs from the
 * inspected one (`diff`) — and, #125, every document the producer writes, per file, with the images by hash (`files`).
 */
export interface PatchJob {
  schema: typeof REBUILD_SCHEMA; kind: 'patch'; id: string; status: RebuildStatus; reused: boolean;
  /** #136: the producer op that ran — a `rig` patch runs `retune` when `patchRoute` routes it there, else `rig`; a remesh patch `remesh`. */
  op: AppliedOp;
  request: { patch: ConfigPatch; patchSha256: string; configHash: string };
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  lines: string[]; producerLine: string | null; exitCode: number | null; wallMs: { op: number | null; compile: number | null; check: number | null };
  /** #148: as `RebuildJob.hint`. */
  hint?: string;
  check: CheckSummary | null; diff: { count: number; paths: string[] } | null;
  /** #125: the per-file diff of every producer document (`src/producer-files.ts`) and the images by hash. */
  files: FilesDiff | null;
  /** #106: a remesh patch's part counts from the revision's `remesh.json`, and the compiled model's triangles for the part. */
  remesh: (RemeshCounts & { modelTriangles: number | null }) | null;
  build: RebuildBuild | null;
  /** #115, a `build` job only: what the assemble stage read and wrote (absent on every other op, so their jobs are unchanged). */
  assembled?: AssembledView;
  /** #112: the `rigc-environment/1` schedule check read (`--environment`), by hash; absent when Apply ran under the default world. */
  environment?: ApplyWorld['record'];
  /** #111, a `cloth` job only: what `propose --cloth --write-config` wrote and how the written config was built. */
  cloth?: ClothJob;
}
/**
 * #111: a cloth recipe Apply — `rig-parts propose --cloth cloth.json --write-config config.json` on the handoff's parts,
 * painting and keypoints, then the written config built as `build` (the config declares `limbs`) or `rig --config`.
 * `refusals`: every FAIL line propose printed, verbatim; `line`: propose's own `wrote config.json: …` line; `written`:
 * every JSON Pointer at which the written config differs from cloth.json (the patched handoff config), and those outside
 * the sections propose splices (none, or the Apply is refused); `links`: the written config's chains per tag.
 */
export interface ClothJob {
  route: 'build' | 'rig';
  inputs: { source: string; keypoints: { path: string; sha256: string } };
  refusals: string[]; line: string | null; written: WrittenDiff | null; links: ClothTagView[];
  wallMs: { propose: number | null; build: number | null };
}
/** #111: what a cloth Apply runs with — the handoff's painting and keypoints (absolute), parts.json and the reader's tags; never from the client. */
export interface ClothPlan { source: string; keypoints: string; partsJson: unknown; targets: string[] }
/**
 * The tags the installed reader accepts, read off its own source (`src/cloth.ts`'s `CLOTH_TARGETS`); when that text
 * does not state them, the tags the config's `cloth` block already declares (and `read: false`).
 */
export async function clothTargets(producerRoot: string | null, configText: string): Promise<{ tags: string[]; read: boolean }> {
  if (producerRoot) { try { const tags = readClothTargets(await readFile(join(producerRoot, 'src', 'cloth.ts'), 'utf8')); if (tags) return { tags, read: true }; } catch { /* not readable: fall back */ } }
  const cloth = object(JSON.parse(configText), 'config').cloth;
  return { tags: cloth && typeof cloth === 'object' && !Array.isArray(cloth) ? Object.keys(cloth).filter(k => k !== 'note' && !k.endsWith('_note') && !k.startsWith('x-')) : [], read: false };
}
/** A written config that differs from its input outside the drafted sections is not built (bar 1, #111). */
export const CLOTH_WRITTEN_OUTSIDE_DRAFTED = 'CLOTH_WRITTEN_OUTSIDE_DRAFTED';
/** #112: the exported schedule an Apply's check reads, as written into the scratch directory, and what the job records of it. */
export interface ApplyWorld { text: string; record: { sha256: string; steps: number } }
/** `{patch, environment}`'s schedule: parsed as data and re-serialized, so its hash is the exported bytes'. */
export function parseApplyWorld(value: unknown): ApplyWorld {
  try { const schedule = parseSchedule(value), text = scheduleText(schedule); return { text, record: { sha256: sha256(text), steps: schedule.steps.length } }; }
  catch (e) { if (e instanceof ScheduleError) throw new RebuildError('REBUILD_REQUEST_INVALID', `environment: ${e.message}`); throw e; }
}
/** The producer op a patch job ran (#136; `build` since #115). */
export type AppliedOp = 'rig' | 'retune' | 'remesh' | 'build' | 'cloth';
/**
 * #115: a `rig-parts build` job's assemble readout — the inputs it was run with (paths relative to the package root, the
 * assemble-read config files by hash), every FAIL line verbatim, the `cut:` / `limb cut:` / `limb cap:` / uncovered-hole
 * lines, the setup-pose seam and its `seam pair` lines, the recomposite figures before (the handoff's parts.json) and
 * after (the scratch one) with the scratch error map served read-only, and which parts changed against the handoff's.
 */
export interface AssembledView {
  inputs: { source: string; full: string; head: string | null; named: { field: string; path: string; sha256: string | null }[] };
  /** `refusals`: the FAIL lines of a stage that refused; `checkFails`: check's FAIL lines when its bars were not met (a judgment, the build kept). */
  refusals: string[]; checkFails: string[]; lines: string[]; seam: string[]; seamPairs: string[];
  recomposite: { line: string | null; before: RecompositeFigures | null; after: RecompositeFigures | null; errorMap: { url: string; sha256: string } | null };
  parts: { changed: string[]; unchanged: number; partsJson: { count: number; paths: string[] } } | null;
}
/** The scratch error map's served name (`/rebuild/<id>/<name>`), read from `<dir>/out/recomposite_error_rig.png`. */
export const RECOMPOSITE_ERROR_MAP = 'recomposite/recomposite_error_rig.png';
/** A build's refusal before it runs: the handoff declares no painting or See-through run for assemble to read. */
export const BUILD_SOURCE_UNAVAILABLE = 'MODELING_INPUT_UNAVAILABLE: source painting and See-through runs — rig-parts build reassembles the parts from the painting (--source) and the runs (--full, --head) before the rig, and the handoff declares none; declare them with rig-review open <dir> --config <path> --source <png> --full <dir> [--head <dir>] or the review.json "producer" block';

/**
 * #114: a retarget Apply's job — `rig-pose clean` (unless skipped), `rig-pose retarget` onto the handoff rig into
 * `<dir>/motion.json`, the handoff rig's files beside it as `<dir>/rig/` (motion.json the retarget's), then the shared
 * tail (per-file diff, compile). `refusals` holds every `FAIL` line the failing step printed, verbatim; `readings` the
 * run's FEET / STANCE / FLIP / SHORT / END-ON / LEG-SCALE / REACH lines with their frames; `motion` what the scratch
 * motion holds against the inspected rig's.
 */
export interface RetargetJob {
  schema: typeof REBUILD_SCHEMA; kind: 'retarget'; id: string; status: RebuildStatus; reused: boolean; op: 'retarget';
  request: { record: RetargetRecord; recordSha256: string; configHash: string };
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  lines: string[]; producerLine: string | null; refusals: string[]; exitCode: number | null;
  wallMs: { clean: number | null; retarget: number | null; compile: number | null };
  files: FilesDiff | null; motion: MotionSummary | null; readings: RetargetLine[];
  /** The run's report `frameTimes` (`motion.report.json`): the new animation's own clock, null when absent or malformed (#164). */
  frameTimes: number[] | null;
  build: RebuildBuild | null;
}
/** Deterministic: the package, the config bytes, the record's bytes and both tool versions. No clock. */
export function retargetId(input: { sourceHash: string; configHash: string; record: RetargetRecord; producer: string; compiler: string }): string {
  return sha256(JSON.stringify([REBUILD_SCHEMA, 'retarget', input.sourceHash, input.configHash, retargetRecordText(input.record), input.producer, input.compiler]));
}
/** A pose reference the retarget can read: a `rig-pose-sequence/1` the package declares. */
export interface RetargetSequence { id: string; label: string; path: string; cleaned: boolean; frames: number; people: string[] }

/**
 * #135: Edit Mesh's Apply · Rebuild — `{part, delta, configHash}`, the delta being the `rig-review-mesh-edit/1` document
 * the editor exports (`src/mesh-edit.ts`, `basis: "setup"`). Review checks only the envelope: the document's schema,
 * basis, source counts and hash and every op are the producer's to judge (`rig-parts remesh --delta`), and its
 * `REMESH_DELTA_*` / `REMESH_*` line comes back verbatim. The delta is written as `meshEditText` writes the download,
 * so `deltaSha256` is the `mesh-edit.binding.json` file hash of the same document.
 */
export interface DeltaRequest { part: string; delta: Record<string, unknown>; configHash: string }
export function parseDeltaRequest(input: unknown): DeltaRequest {
  const v = object(input, 'rebuild'), keys = Object.keys(v).sort().join(',');
  if (keys !== 'configHash,delta,part') bad('expected exactly {part, delta, configHash}');
  if (typeof v.part !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.part)) bad('part');
  if (typeof v.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.configHash)) bad('configHash');
  if (!v.delta || typeof v.delta !== 'object' || Array.isArray(v.delta)) bad('delta must be one rig-review-mesh-edit/1 document');
  return { part: v.part as string, delta: v.delta as Record<string, unknown>, configHash: v.configHash as string };
}
/** Deterministic: the package, the config bytes, the part, the delta's bytes and both tool versions. No clock. */
export function deltaId(input: { sourceHash: string; configHash: string; part: string; deltaText: string; producer: string; compiler: string }): string {
  return sha256(JSON.stringify([REBUILD_SCHEMA, 'delta', input.sourceHash, input.configHash, input.part, input.deltaText, input.producer, input.compiler]));
}
/** A delta Apply's job (#135): `remesh --delta`, then the shared tail with the per-file diff (#125); remesh's own gate holds check. */
export interface DeltaJob {
  schema: typeof REBUILD_SCHEMA; kind: 'delta'; id: string; status: RebuildStatus; reused: boolean; op: 'remesh';
  request: { part: string; delta: Record<string, unknown>; deltaSha256: string; configHash: string };
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  lines: string[]; producerLine: string | null; exitCode: number | null; wallMs: { op: number | null; compile: number | null };
  /** #148: as `RebuildJob.hint`. */
  hint?: string;
  files: FilesDiff | null;
  remesh: (RemeshCounts & { modelTriangles: number | null }) | null;
  build: RebuildBuild | null;
}
/**
 * Deterministic: the package, the config bytes, the patch's own bytes and both tool versions. No clock. A retune-routed
 * patch adds its op (#136), so a scratch build the whole-rig path left for the same patch is never reused as retune's.
 */
export function patchId(input: { sourceHash: string; configHash: string; patch: ConfigPatch; producer: string; compiler: string; op?: AppliedOp; buildInputs?: string; environment?: string; cloth?: string }): string {
  // #115: a build-routed patch adds its op and the hash of the files assemble reads (painting, runs, named files).
  // #112: an Apply whose check reads a schedule adds the schedule's hash, so a default-world build is never reused for it.
  return sha256(JSON.stringify([REBUILD_SCHEMA, 'patch', input.sourceHash, input.configHash, patchText(input.patch), input.producer, input.compiler, ...(input.op === 'retune' ? ['retune'] : []), ...(input.op === 'build' ? ['build', input.buildInputs ?? ''] : []), ...(input.op === 'cloth' ? ['cloth', input.cloth ?? '', input.buildInputs ?? ''] : []), ...(input.environment ? ['environment', input.environment] : [])]));
}
const namedFile = (doc: unknown, keys: readonly string[]): unknown => keys.reduce<unknown>((v, k) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined), doc);
/**
 * The patched config as the producer's own scratch configs are written (rig-parts `scratchConfig`): every path the
 * loader resolves against the config's directory (`motion.animations_from`, `generation.control.skeleton`) made
 * absolute when it names a file there, so the scratch copy reads the same files as the handoff config.
 */
export function scratchConfigText(configPath: string, doc: JsonValue): string {
  const configDir = dirname(resolve(configPath)), out = structuredClone(doc) as Record<string, unknown>;
  for (const keys of CONFIG_NAMED_FILES) {
    const holder = namedFile(out, keys.slice(0, -1)) as Record<string, unknown> | undefined, key = keys.at(-1)!, value = holder?.[key];
    if (typeof value === 'string' && value && !isAbsolute(value) && existsSync(resolve(configDir, value))) holder![key] = resolve(configDir, value);
  }
  return JSON.stringify(out, null, 2) + '\n';
}
/** A patch may not change which files the config names (they are the handoff's hashed files): `EDIT_PATCH_PATH_HELD`. */
export function assertNamedFilesHeld(before: unknown, after: unknown): void {
  for (const keys of CONFIG_NAMED_FILES) if (JSON.stringify(namedFile(before, keys)) !== JSON.stringify(namedFile(after, keys))) throw new RebuildError('EDIT_PATCH_PATH_HELD', `${keys.join('.')} names a handoff file; a patch may not change it`);
}
/** The value of a flag in the patch's args, or the producer's default. */
const flagValue = (args: readonly string[], flag: string, fallback: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1]! : fallback; };

export interface RebuildOptions {
  stateDir: string; starts: readonly string[]; unchanged: () => Promise<void>; bones: readonly string[] | null;
  /** #173: how many strip candidates run at once (default max(1, floor(cores / 2))). */
  stripConcurrency?: number;
}
/** #173: a density strip's scratch — one folder per package, holding at most the one strip on screen. */
export const stripRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'density-strip', sourceHash);
export const defaultStripConcurrency = () => Math.max(1, Math.floor(availableParallelism() / 2));
/** Deterministic: the package, the config bytes, every candidate's patch bytes in order and both tool versions. */
export function stripId(input: { sourceHash: string; configHash: string; patches: readonly ConfigPatch[]; producer: string; compiler: string }): string {
  return sha256(JSON.stringify([DENSITY_STRIP_SCHEMA, input.sourceHash, input.configHash, input.patches.map(patchText), input.producer, input.compiler]));
}
/** `GET /api/density-strip/<id>`: the strip, one row per candidate in the request's order, and the two labels. */
export interface DensityStripView {
  schema: typeof DENSITY_STRIP_SCHEMA; id: string; status: 'running' | 'done'; part: string; field: DensityField;
  concurrency: number; configHash: string; producer: { package: string; version: string }; compiler: { package: string; version: string };
  wallMs: number | null; rows: StripRow[]; labels: { fewest: number | null; widest: number | null };
}
export const baselineDir = (stateDir: string, key: string) => join(stateDir, 'baseline', key);

const tool = (t: InstalledTool) => ({ package: t.package, version: t.version });
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

type Resolved = Extract<ReturnType<typeof resolveProducer>, { ok: true }>;
type PageEdges = CompileRequest['pageEdges'];
type PackShape = CompileRequest['packShape'];
/** A runner's producer op (#121): the one step the two Apply paths do not share. */
interface ProducerOp {
  /** The producer command, for the unnamed-refusal line. */
  cmd: string;
  /** The producer's binary name, for the unnamed-refusal line (`rig-parts` unless stated). */
  tool?: string;
  /** The rig spec directory the op writes under the scratch directory. */
  spec: string;
  /** Writes the op's inputs into the scratch directory, says what runs, runs it. */
  run: (push: (line: string) => void) => Promise<ProcessResult>;
  /** Where the job records the op's wall clock. */
  wallMs: (ms: number) => void;
  /** After a clean op: the pack flags the build compiles with, and what the compile line adds about them. */
  flags: (push: (line: string) => void) => Promise<{ pageEdges: PageEdges; packShape: PackShape; note: string }>;
}
/** The tail's optional steps; each receives what it measured for the job to record. */
interface ApplySteps {
  /** #125: diff every producer document against the inspected rig, before the compile. */
  diff?: (files: FilesDiff) => void;
  /** #102: check the scratch rig after the compile. */
  check?: (summary: CheckSummary, wallMs: number | null) => void;
  /**
   * #139 / #174: the check the producer op (retune, remesh) already ran on the spec it wrote, read instead of running check again: a summary
   * (recorded through `check`, no wall clock), a refusal line (nothing recorded, the build refused), or null — the op
   * carries none, so check runs as for any other Apply.
   */
  carried?: (push: (line: string) => void) => Promise<{ summary: CheckSummary } | { refused: string } | null>;
  /** After the build is hashed, before result.json is written. */
  hashed?: () => Promise<void>;
  /** #112: the schedule check reads (`--environment environment.json`, written into the scratch directory first). */
  world?: ApplyWorld | null;
  /**
   * #173: a density strip's candidate — built and hashed and its result.json written exactly as an Apply's, but it does
   * not land: no applied record, no stage, no scratch-root arrangement. Its build waits in the strip's own folder.
   */
  candidate?: boolean;
}

/**
 * #139 / #174: the check `rig-parts retune` (or `remesh`) ran on the revision it wrote into `spec`, as review's check
 * summary, bound to the revision's files by the provenance's hash rows (`RETUNE_CHECK_STALE` / `REMESH_CHECK_STALE`
 * refuses the Apply). Null — check runs as before — when the Apply checks under an exported world (the op's check read
 * the default one) or the provenance carries no `line` / `status` (a producer before `RETUNE_CHECK_SINCE` /
 * `REMESH_CHECK_SINCE`, both 1.49.0).
 */
async function opCarried(op: CarryingOp, spec: string, world: ApplyWorld | null, push: (line: string) => void): Promise<{ summary: CheckSummary } | { refused: string } | null> {
  const file = provenanceFile(op);
  if (world) { push(`review: ${op}'s own check read the default world and this Apply checks under the exported schedule, so check runs on the revision`); return null; }
  const provenance = JSON.parse(await readFile(join(spec, file), 'utf8')) as unknown;
  const carried = carriedCheck(provenance, op);
  if (!carried) { push(`review: ${file} carries no check line or block statuses (@rig-c/parts before ${op === 'retune' ? RETUNE_CHECK_SINCE : REMESH_CHECK_SINCE}), so check runs on the revision`); return null; }
  const stale = await revisionBinding(spec, provenance, op);
  if (stale) return { refused: stale };
  const rows = (provenance as { revision: unknown[] }).revision.length;
  push(`review: check not run again — ${file} carries ${op}'s check of this revision, bound to it by ${rows} revision hash row(s): ${carried.line}`);
  return { summary: carriedCheckSummary(carried, op) };
}

/** #115: what a build-routed patch runs with — the handoff's painting and runs, absolute; never from the client. */
export interface BuildPlan { source: string; full: string; head: string | null; inputsHash: string; inputs: AssembledView['inputs'] }
/**
 * The build's inputs for a patch (`null` refusal line when the handoff declares no painting and full run): the painting
 * and the runs, and every config-relative file the patched config names for assemble, each resolved against the handoff
 * config's directory and held inside the handoff root (`BUILD_INPUT_OUTSIDE_ROOT`, `BUILD_INPUT_MISSING`) and hashed.
 */
export async function buildPlan(handoff: Handoff, patched: JsonValue, show: (abs: string) => string): Promise<BuildPlan> {
  if (!handoff.source || !handoff.full) throw new RebuildError('MODELING_INPUT_UNAVAILABLE', BUILD_SOURCE_UNAVAILABLE.slice('MODELING_INPUT_UNAVAILABLE: '.length));
  const root = await realpath(handoff.root), configDir = dirname(handoff.config), named: AssembledView['inputs']['named'] = [];
  for (const f of buildNamedFiles(patched)) {
    if (isAbsolute(f.value)) throw new RebuildError('BUILD_INPUT_OUTSIDE_ROOT', `config ${f.field} is an absolute path; the handoff config names its files relative to its own directory`);
    const lexical = resolve(configDir, f.value);
    let real: string;
    try { real = await realpath(lexical); } catch { throw new RebuildError('BUILD_INPUT_MISSING', `config ${f.field} names ${show(lexical)}, which does not exist`); }
    const rel = relative(root, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new RebuildError('BUILD_INPUT_OUTSIDE_ROOT', `config ${f.field} resolves outside the package root`);
    named.push({ field: f.field, path: show(real), sha256: f.kind === 'file' ? sha256(await readFile(real)) : null });
  }
  const inputs = { source: handoff.record.source?.path ?? show(handoff.source), full: handoff.record.full ?? show(handoff.full), head: handoff.head ? handoff.record.head ?? show(handoff.head) : null, named };
  // The painting, the runs' hashed files (the handoff record's) and the named files: an identical build reuses its scratch build.
  const inputsHash = sha256(JSON.stringify([handoff.record.files, named]));
  return { source: handoff.source, full: handoff.full, head: handoff.head ?? null, inputsHash, inputs };
}
/** After a build ran: the recomposite figures before (the handoff's parts.json) and after, the error map, the parts diff. */
async function assembledAfter(job: PatchJob, dir: string, inputs: ProducerInputs): Promise<void> {
  const read = async (path: string): Promise<unknown> => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
  const before = await read(join(inputs.parts, 'parts.json')), after = await read(join(dir, 'out', 'parts.json'));
  let errorMap: { url: string; sha256: string } | null = null;
  try { errorMap = { url: `/rebuild/${job.id}/${RECOMPOSITE_ERROR_MAP}`, sha256: sha256(await readFile(join(dir, 'out', 'recomposite_error_rig.png'))) }; } catch { /* assemble wrote none */ }
  const pngs = async (d: string) => { const m = new Map<string, string>(); let names: string[] = []; try { names = (await readdir(d)).filter(n => n.endsWith('.png')).sort(); } catch { /* none */ } for (const n of names) m.set(n, sha256(await readFile(join(d, n)))); return m; };
  const was = await pngs(join(inputs.parts, 'parts')), now = await pngs(join(dir, 'out', 'parts'));
  const names = [...new Set([...was.keys(), ...now.keys()])].sort(), changed = names.filter(n => was.get(n) !== now.get(n));
  const docPaths = before !== null && after !== null ? jsonDiff(before, after) : [''];
  job.assembled = { ...job.assembled!, recomposite: { ...job.assembled!.recomposite, before: recompositeFigures(before), after: recompositeFigures(after), errorMap },
    parts: { changed: changed.map(n => n.replace(/\.png$/, '')).slice(0, 200), unchanged: names.length - changed.length, partsJson: { count: docPaths.length, paths: docPaths.slice(0, 200) } } };
}

/** Hash every page the compiled model names and the model itself; names are literal relative paths inside the build. */
async function hashBuild(build: string, id: string): Promise<RebuildBuild> {
  const dir = await realpath(build), model = 'skeleton.model.json', bytes = await readFile(await safeFile(dir, model)), doc = object(JSON.parse(bytes.toString('utf8')), 'model');
  if (doc.spec !== 'rigc-compiled/3' || !Array.isArray(doc.pages)) throw new RebuildError('REBUILD_BUILD_INVALID', 'the compiled scratch model is not rigc-compiled/3 with pages');
  const files: Record<string, string> = { [model]: sha256(bytes) };
  for (const page of doc.pages) { const name = packagePath(object(page, 'model.pages[]').name, 'model.pages[].name'); files[name] = sha256(await readFile(await safeFile(dir, name))); }
  return { model, modelUrl: `/rebuild/${id}/${model}`, modelHash: files[model]!, files };
}

/** One rebuild at a time per review instance; finished jobs stay readable by id. */
export function createRebuilds(p: ReviewPackage, options: RebuildOptions) {
  const jobs = new Map<string, RebuildJob | PatchJob | DeltaJob | RetargetJob>();
  let running: string | null = null;
  /** #173: the density strip on screen (at most one per review): its candidates run beside each other, none of them applied. */
  interface StripCandidate { value: number; id: string; entry: JsonValue; dir: string; job: PatchJob; applied: boolean }
  let strip: { id: string; status: 'running' | 'done'; part: string; field: DensityField; concurrency: number; configHash: string; producer: { package: string; version: string }; compiler: { package: string; version: string }; started: number; wallMs: number | null; candidates: StripCandidate[] } | null = null;
  /** One producer workload at a time per review: an Apply (or undo's re-run) or a strip; the line refusing the other. */
  const busy = (): string | null => (running ? `REBUILD_BUSY: rebuild ${running} is still running` : strip?.status === 'running' ? `REBUILD_BUSY: density strip ${strip.id} is still running` : null);
  /** #166: the session's applied records, in order; the last is on the stage. The request bodies by job id. */
  const stack: AppliedEntry[] = [];
  const bodies = new Map<string, unknown>();
  /** #166: an undo re-running an evicted predecessor: its id and the build files it must reproduce. */
  let restoring: { id: string; files: Record<string, string> } | null = null;
  const snapshot = <J extends RebuildJob | PatchJob | DeltaJob | RetargetJob>(job: J): J => ({ ...job, lines: [...job.lines] });

  /** The state directory may not sit inside the package or the handoff's root (the parent of an opened out/). */
  function assertStateOutside(): void {
    for (const root of [p.root, ...(p.handoff ? [p.handoff.root] : [])]) {
      const inside = relative(root, options.stateDir);
      if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) throw new RebuildError('REBUILD_STATE_INSIDE_PACKAGE', 'the review state directory is inside the inspected package; set RIG_REVIEW_STATE_DIR outside it');
    }
  }
  /** Once per session: the first time the handoff and the producer both resolve, the baseline starts (or is reused). */
  let baseline: BaselineResult | null = null, baselineRun: Promise<BaselineResult> | null = null;
  /** #108 (HQ): the inspected build's check, started once the baseline reproduces; stored beside the baseline record. */
  let inspectedCheck: InspectedCheck | null = null, inspectedCheckRun: Promise<InspectedCheck> | null = null;
  function ensureBaseline(resolved: ReturnType<typeof resolveProducer>): BaselineResult | null {
    if (baselineRun || !p.handoff || !resolved.ok) return baseline;
    try { assertStateOutside(); } catch { return null; }
    const handoff = p.handoff, key = baselineKey(p.sourceHash, handoff, resolved.producer, resolved.compiler), rig = handoff.rig ?? p.root;
    const show = (rel: string) => relative(p.root, join(rig, rel)).split(sep).join('/');
    baseline = { schema: 'rig-review-baseline/1', key, status: 'running', producer: tool(resolved.producer), firstDifference: null, hashes: null, reach: null, line: `baseline: running ${resolved.producer.package} ${resolved.producer.version} rig into scratch…`, exitCode: null, wallMs: null };
    const started = baseline;
    baselineRun = runBaseline(baselineDir(options.stateDir, key), key, handoff, resolved.producer, show)
      .catch((error): BaselineResult => ({ ...started, status: 'failed', line: `baseline: failed — ${error instanceof Error ? error.message : String(error)}` }))
      .then(result => {
        baseline = result;
        // Only a reproduced baseline is the inspected rig; its check is the inspected build's check.
        if (result.status === 'reproduced' && handoff.parts) {
          inspectedCheck = runningInspectedCheck(key);
          const parts = handoff.parts, dir = baselineDir(options.stateDir, key);
          inspectedCheckRun = runInspectedCheck(dir, key, parts, resolved.producer)
            .catch((error): InspectedCheck => ({ ...runningInspectedCheck(key), status: 'failed', line: `inspected check: failed — ${error instanceof Error ? error.message : String(error)}` }))
            .then(checked => (inspectedCheck = checked));
        }
        return result;
      });
    return baseline;
  }

  /** `GET /api/rebuild`: whether Apply can run here, the handoff and its baseline, and what the config holds (so the editor can start from it). */
  async function describe() {
    await options.unchanged();
    const handoff = p.handoff, gap = handoff ? handoffGap(handoff) : null;
    const inputs = handoff && !gap ? await producerInputs(handoff, p.handoffReason) : null;
    const resolved = resolveProducer(options.starts);
    const parts = inputs ? contourParts(inputs.configText).map(({ name, regions }) => ({ name, regions })) : [];
    const contour = inputs ? Object.fromEntries(contourParts(inputs.configText).map(({ name, entry }) => [name, entry])) : {};
    const reason = !handoff ? (p.handoffReason ?? modelingHandoffMissing(null)) : gap ?? (!resolved.ok ? resolved.error : parts.length ? null : 'REBUILD_INPUTS_UNAVAILABLE: the config states no contour mesh');
    return {
      schema: 'rig-review-rebuild-status/1', available: !!inputs && resolved.ok && parts.length > 0,
      handoff: handoff ? handoff.record : null,
      inputs: inputs && handoff ? { config: handoff.record.config.path, parts: handoff.record.parts, rig: handoff.record.rig, configHash: inputs.configHash } : null,
      baseline: ensureBaseline(resolved),
      // #108 (HQ): the physics readout's BEFORE for the inspected build; null until the baseline reproduces.
      inspectedCheck,
      parts, contour,
      // #106: every meshes entry as written, for the Mesh panel's selected part.
      meshes: inputs ? configMeshes(inputs.configText) : {},
      // The config's constraints as written (#103: the physics panel patches them by index and name).
      constraints: inputs ? configConstraints(inputs.configText) : null,
      // #109: the config's bones as written (the Bones block drags their at / points / tip).
      bones: inputs ? configBonesList(inputs.configText) : null,
      // #110: the sections the Rig fields block edits (regions, motion.blink, stops, bones, turn) as written.
      fields: inputs ? configFields(inputs.configText) : null,
      // #115: the config's cuts, patches and limbs as written, and whether the handoff can run `rig-parts build`.
      cuts: inputs ? { config: configCuts(inputs.configText), build: buildGap(handoff) } : null,
      // #104: the config's idle (tracks, blink, bones, chains) and where the inspected idle keys each track.
      idle: inputs ? await idleStatus(inputs) : null,
      // #111: the cloth recipe form — the reader's tags, the config's recipes as written, each tag's parts and chains (the
      // link preview) and why a cloth Apply cannot run here (no keypoints, no painting, an older producer), or null.
      cloth: inputs && handoff ? await clothStatus(handoff, inputs, resolved) : null,
      producer: resolved.ok ? tool(resolved.producer) : null, compiler: resolved.ok ? tool(resolved.compiler) : null,
      // #114: what the retarget editor offers — the pose producer, the declared sequences, the rig's bones and animations.
      retarget: await retargetStatus(inputs),
      reason,
      running,
    };
  }
  /** #111: what the cloth recipe form starts from. */
  async function clothStatus(handoff: Handoff, inputs: ProducerInputs, resolved: ReturnType<typeof resolveProducer>) {
    const config = object(JSON.parse(inputs.configText), 'config');
    let partsJson: unknown = null;
    try { partsJson = JSON.parse(await readFile(join(inputs.parts, 'parts.json'), 'utf8')); } catch { /* none: no tag lists its parts */ }
    const targets = await clothTargets(resolved.ok ? resolved.producer.root : null, inputs.configText);
    const reason = !handoff.keypoints || !handoff.record.keypoints ? CLOTH_KEYPOINTS_UNDECLARED
      : !resolved.ok ? resolved.error
      : !versionAtLeast(resolved.producer.version, CLOTH_WRITE_SINCE) ? modelingProducerTooOld(resolved.producer.version || 'unknown', CLOTH_WRITE_SINCE, 'rig-parts propose --cloth --write-config (entry by entry)')
      : !handoff.source ? CLOTH_SOURCE_UNAVAILABLE
      : config.limbs !== undefined && !handoff.full ? BUILD_SOURCE_UNAVAILABLE : null;
    return { targets: targets.tags, targetsRead: targets.read, recipes: config.cloth ?? null, tags: clothLinks(config, partsJson, targets.tags), keypoints: handoff.record.keypoints ?? null, route: config.limbs !== undefined ? 'build' : 'rig', reason };
  }
  /** The inspected build's check once it settles (tests); null when the baseline did not reproduce. */
  async function settledInspectedCheck(): Promise<InspectedCheck | null> { await settledBaseline(); return inspectedCheckRun ? await inspectedCheckRun : inspectedCheck; }
  /** The most recent built scratch build of this session (#108 readings run on it), or null. */
  let latestId: string | null = null;
  function latest(): { id: string; build: string; modelHash: string; spec: string } | null {
    const job = latestId ? jobs.get(latestId) : undefined;
    // `spec`: the rig spec directory the job's producer op wrote (#113 checks requirements on it) — a designation's `revision`, a patch's or delta's `rig`.
    const dir = job ? rebuildDir(options.stateDir, p.sourceHash, job.id) : '';
    return job && job.status === 'built' && job.build ? { id: job.id, build: join(dir, 'build'), modelHash: job.build.modelHash, spec: join(dir, !('kind' in job) ? 'revision' : job.op === 'build' || (job.kind === 'patch' && job.cloth?.route === 'build') ? 'out/rig' : 'rig') } : null;
  }
  /**
   * #166: the line refusing an undo's re-run whose build is not the one its record names (the first differing file by
   * hash), or null — also null for any job that is not an undo's re-run.
   */
  function restoredDifference(id: string, files: Record<string, string>): string | null {
    if (restoring?.id !== id) return null;
    const names = [...new Set([...Object.keys(restoring.files), ...Object.keys(files)])].sort();
    const file = names.find(n => restoring!.files[n] !== files[n]);
    if (!file) return null;
    const side = (h: string | undefined) => (h ? `${h.slice(0, 12)}…` : 'absent'), recorded = restoring.files[file];
    restoring = null;
    return `${UNDO_PREDECESSOR_CHANGED}: ${file} — the record's build has sha256 ${side(recorded)}, the re-run wrote ${side(files[file])}; the predecessor cannot be restored byte for byte, so the stage stays on the last Apply`;
  }
  /** #166: an undo's re-run computed another build id than its record's — some input it hashes is not what it was. */
  function guardRestore(id: string): void {
    if (!restoring || restoring.id === id) return;
    const was = restoring.id; restoring = null;
    throw new RebuildError(UNDO_PREDECESSOR_CHANGED, `build id ${was.slice(0, 12)}… → ${id.slice(0, 12)}… — an input the record's build id hashes (the package, the handoff config, the build's painting, runs or named files, the keypoints, the producer or the compiler) is not what it was; the stage stays on the last Apply`);
  }
  /** #166: a kept build asked for again moves back into the scratch root (where reuse reads it). */
  async function unkeep(id: string): Promise<void> {
    const from = join(keptRoot(options.stateDir, p.sourceHash), id), to = rebuildDir(options.stateDir, p.sourceHash, id);
    if (!(await exists(from))) return;
    if (await exists(to)) { await rm(from, { recursive: true, force: true }); return; }
    await mkdir(rebuildRoot(options.stateDir, p.sourceHash), { recursive: true, mode: 0o700 });
    await rename(from, to);
  }
  /**
   * #166: a built (or reused) Apply lands on the stack — or, for an undo's re-run or reuse of the predecessor, the undone
   * record leaves it — and the scratch tree is arranged: the stage's build in the scratch root, the other records' most
   * recent `MAX_KEPT_BUILDS - 1` builds in keptRoot, every other build removed.
   */
  async function landed(job: RebuildJob | PatchJob | DeltaJob | RetargetJob): Promise<void> {
    if (restoring?.id === job.id) { stack.pop(); restoring = null; }
    else if (stack.at(-1)?.id !== job.id && job.build) stack.push({ id: job.id, body: bodies.get(job.id) ?? null, configHash: job.request.configHash, producer: { ...job.producer }, compiler: { ...job.compiler }, files: { ...job.build.files }, modelHash: job.build.modelHash, job: snapshot(job) });
    latestId = stack.at(-1)?.id ?? null;
    await arrange();
  }
  async function arrange(): Promise<void> {
    const root = rebuildRoot(options.stateDir, p.sourceHash), kept = keptRoot(options.stateDir, p.sourceHash);
    const top = stack.at(-1)?.id ?? null, order: string[] = [];
    for (let i = stack.length - 2; i >= 0; i--) { const id = stack[i]!.id; if (id !== top && !order.includes(id)) order.push(id); }
    const keep = new Set(order.slice(0, MAX_KEPT_BUILDS - 1));
    const list = async (dir: string) => { try { return (await readdir(dir)).filter(n => /^[a-f0-9]{64}$/.test(n)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } };
    if (top) await unkeep(top);
    for (const id of await list(root)) {
      if (id === top) continue;
      if (keep.has(id) && !(await exists(join(kept, id)))) { await mkdir(kept, { recursive: true, mode: 0o700 }); await rename(join(root, id), join(kept, id)); }
      else await rm(join(root, id), { recursive: true, force: true });
      jobs.delete(id);
    }
    for (const id of await list(kept)) if (!keep.has(id)) await rm(join(kept, id), { recursive: true, force: true });
  }
  /** `GET /api/rebuild/history` (#166). */
  async function history(): Promise<AppliedHistory> {
    const records: AppliedHistory['records'] = [];
    for (const [i, e] of stack.entries()) {
      const job = e.job, last = i === stack.length - 1;
      const kind = !('kind' in job) ? 'regions' as const : job.kind;
      const what = !('kind' in job) ? `${job.request.bust ? 'contour.bust landmarks' : `${job.request.regions.length} region(s)`} on ${job.request.part}`
        : job.kind === 'patch' ? job.request.patch.ops.map(o => `${o.op} ${o.path}`).slice(0, 3).join(', ') + (job.request.patch.ops.length > 3 ? `, +${job.request.patch.ops.length - 3}` : '')
        : job.kind === 'delta' ? `mesh edit on ${job.request.part}` : `retarget "${job.request.record.flags.animation}"`;
      const kept = await exists(join(last ? rebuildRoot(options.stateDir, p.sourceHash) : keptRoot(options.stateDir, p.sourceHash), e.id));
      records.push({ id: e.id, kind, op: 'op' in job ? job.op : 'remesh', what, modelHash: e.modelHash, kept });
    }
    return { schema: 'rig-review-applied-history/1', depth: stack.length, records };
  }
  /**
   * `POST /api/rebuild/undo` with `{from}` (#166): the last applied record leaves the stack and the stage returns to its
   * predecessor's build, or to the inspected build when none is left. `from` is the record the page shows on the stage
   * (`UNDO_STALE` otherwise). A kept predecessor is restored from disk after its files are re-hashed against its record;
   * an evicted one re-runs its recorded request through the same runner, refused before anything runs when the handoff
   * config or a tool version is not the record's, and refused after when the build is not byte-identical — either way
   * `UNDO_PREDECESSOR_CHANGED: <what>`, the stage left on the last Apply. Undo writes nothing into the package.
   */
  async function undo(input: unknown): Promise<{ status: number; body: unknown }> {
    const v = object(input, 'undo');
    if (Object.keys(v).join(',') !== 'from' || typeof v.from !== 'string' || !/^[a-f0-9]{64}$/.test(v.from)) bad('expected exactly {from: <the build id on the stage>}');
    assertStateOutside();
    if (busy()) return { status: 200, body: { status: 'refused', error: busy(), producerLine: null } };
    const top = stack.at(-1);
    if (!top) throw new RebuildError('UNDO_NOTHING_APPLIED', 'no Apply is on the stage; the inspected build is');
    if (top.id !== v.from) throw new RebuildError('UNDO_STALE', `the stage's last Apply is ${top.id.slice(0, 12)}…, not ${String(v.from).slice(0, 12)}…; reload`);
    const pred = stack.at(-2);
    if (!pred) { stack.pop(); latestId = null; await arrange(); return { status: 200, body: { status: 'inspected', undone: top.id, history: await history() } }; }
    // (i) the kept build: back into the scratch root, re-hashed against result.json and against the record.
    await unkeep(pred.id);
    const dir = rebuildDir(options.stateDir, p.sourceHash, pred.id);
    const kept = await reuse<RebuildJob | PatchJob | DeltaJob | RetargetJob>(dir, pred.id);
    if (kept && JSON.stringify(kept.build!.files) === JSON.stringify(pred.files)) {
      jobs.set(pred.id, kept); stack.pop(); latestId = pred.id; await arrange();
      return { status: 200, body: { status: 'built', undone: top.id, job: snapshot(kept), history: await history() } };
    }
    await rm(dir, { recursive: true, force: true });
    // (ii) evicted (or not its record's bytes): re-run the record's request, only on the inputs it was built from.
    if (pred.body === null) throw new RebuildError(UNDO_PREDECESSOR_CHANGED, `${pred.id.slice(0, 12)}… — the record carries no request to re-run and its build is gone`);
    const handoff = p.handoff;
    if (handoff) {
      let now = 'unreadable';
      try { now = sha256(await readFile(handoff.config)); } catch { /* named below */ }
      if (now !== pred.configHash) throw new RebuildError(UNDO_PREDECESSOR_CHANGED, `${handoff.record.config.path} sha256 ${pred.configHash.slice(0, 12)}… → ${now === 'unreadable' ? now : `${now.slice(0, 12)}…`}; the evicted build was made from the config as it was`);
    }
    const retargeting = 'kind' in pred.job && pred.job.kind === 'retarget';
    const resolved = retargeting ? resolvePose(options.starts) : resolveProducer(options.starts);
    if (!resolved.ok) throw new RebuildError(UNDO_PREDECESSOR_CHANGED, `${pred.producer.package} ${pred.producer.version} → ${resolved.error}`);
    for (const [was, now] of [[pred.producer, resolved.producer], [pred.compiler, resolved.compiler]] as const) {
      if (was.package !== now.package || was.version !== now.version) throw new RebuildError(UNDO_PREDECESSOR_CHANGED, `${was.package} ${was.version} → ${now.package} ${now.version}; the evicted build was made with the version its record names`);
    }
    restoring = { id: pred.id, files: { ...pred.files } };
    let started: { status: number; body: unknown };
    try { started = await start(pred.body); } catch (e) { restoring = null; throw e; }
    const body = started.body as { id?: string; status?: string };
    if (body.id !== pred.id) { restoring = null; return started; }
    return { status: started.status, body: { status: body.status === 'running' ? 'running' : body.status, undone: top.id, job: body, ...(body.status === 'running' ? {} : { history: await history() }) } };
  }
  /** The baseline once it settles (tests, and the whole-rig ops of #102/#103 through assertWholeRigBaseline). */
  async function settledBaseline(): Promise<BaselineResult | null> { if (!baselineRun) ensureBaseline(resolveProducer(options.starts)); return baselineRun ? await baselineRun : baseline; }

  async function reuse<J extends RebuildJob | PatchJob | DeltaJob | RetargetJob>(dir: string, id: string): Promise<J | null> {
    const resultFile = join(dir, 'result.json');
    if (!(await exists(resultFile))) return null;
    try {
      const stored = JSON.parse(await readFile(resultFile, 'utf8')) as J;
      if (stored.schema !== REBUILD_SCHEMA || stored.id !== id || stored.status !== 'built' || !stored.build) return null;
      const now = await hashBuild(join(dir, 'build'), id);
      if (JSON.stringify(now.files) !== JSON.stringify(stored.build.files)) return null;
      const job = { ...stored, reused: true };
      // A retarget built before the job carried its report's frameTimes (#164): read them from the build's own report.
      if ('kind' in job && job.kind === 'retarget' && (job as RetargetJob).frameTimes === undefined) {
        let times: unknown = null;
        try { times = (JSON.parse(await readFile(join(dir, 'motion.report.json'), 'utf8')) as { frameTimes?: unknown }).frameTimes; } catch { /* no report: no clock */ }
        const clock = samplesClock(times); (job as RetargetJob).frameTimes = clock?.kind === 'samples' ? clock.frameTimes : null;
      }
      return job;
    } catch { return null; }
  }

  /**
   * The tail every Apply shares (#121), once its producer op has written a rig spec into `<dir>/<op.spec>`: the per-file
   * diff when asked (#125), the compile with the revision's own pack flags, check when asked (#102), the build hashed,
   * result.json written, the package's other scratch builds replaced (#166: the applied records' earlier builds kept
   * beside the scratch root for undo); anything but a built job leaves nothing behind.
   * Each runner passes only its producer op and the optional steps it records.
   */
  async function apply(job: RebuildJob | PatchJob | DeltaJob | RetargetJob, dir: string, inputs: ProducerInputs, resolved: Resolved, op: ProducerOp, steps: ApplySteps = {}): Promise<void> {
    const push = (line: string) => { if (job.lines.length < MAX_LINES) job.lines.push(line); };
    const producer = resolved.producer;
    // #180: a refusal or failure is published only after its scratch is removed (as "built" is published last, #146),
    // so a reader that sees the outcome never finds a folder mid-removal.
    let outcome: RebuildStatus | null = null;
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const run = await op.run(push);
      job.exitCode = run.exitCode; op.wallMs(run.wallMs);
      if (run.exitCode !== 0) {
        job.producerLine = firstRefusal(run.lines) ?? `${op.tool ?? 'rig-parts'} ${op.cmd} exited ${run.exitCode} without a named refusal`;
        // #148: the producer's line stays as printed; review adds what it means here, when it knows.
        const hint = producerHint(job.producerLine);
        if (hint && !('refusals' in job)) { (job as RebuildJob | PatchJob | DeltaJob).hint = hint; push(`review: ${hint}`); }
        outcome = 'refused'; return;
      }
      job.producerLine = run.stdout.filter(l => l.trim()).at(-1)?.trim() ?? null;
      const { pageEdges, packShape, note } = await op.flags(push);
      if (steps.diff) {
        // #125: the structural diff of every document the producer writes against the inspected rig's, file by file.
        const files = await producerDiff(inputs.rig, join(dir, op.spec));
        steps.diff(files);
        push(`review: against the inspected rig — ${filesDiffText(files)}`);
        for (const d of files.documents) if (d.count) push(`review: ${d.file}: ${d.paths.slice(0, 8).join(', ')}${d.count > 8 ? ', …' : ''}`);
        if (files.images.changed) push(`review: images changed: ${files.images.names.slice(0, 8).join(', ')}${files.images.changed > 8 ? ', …' : ''}`);
      }
      push(`review: ${resolved.compiler.package} ${resolved.compiler.version} build --profile rig-play --pack --page-edges ${pageEdges} --pack-shape ${packShape}${note}`);
      const compile = await runTool(resolved.compiler.bin, compileArgs({ rig: `${op.spec}/rig.json`, motion: `${op.spec}/motion.json`, out: 'build', pageEdges, packShape }), { cwd: dir, onLine: push });
      job.wallMs.compile = compile.wallMs;
      if (compile.exitCode !== 0) { job.exitCode = compile.exitCode; job.producerLine = firstRefusal(compile.lines) ?? `rigc build exited ${compile.exitCode} without a named refusal`; outcome = 'refused'; return; }
      const carried = steps.check && steps.carried ? await steps.carried(push) : null;
      if (carried && 'refused' in carried) { job.producerLine = carried.refused; outcome = 'refused'; push(`review: ${carried.refused}`); return; }
      if (steps.check && carried) steps.check(carried.summary, null);
      else if (steps.check) {
        // check measures the scratch rig; a FAIL is its judgment, recorded beside the build, not a refusal of the build.
        if (steps.world) await writeFile(join(dir, 'environment.json'), steps.world.text, { mode: 0o600 });
        push(`review: ${producer.package} ${producer.version} check --rig ${op.spec} --out check --parts <handoff parts>${steps.world ? ` --environment environment.json (the exported schedule, ${steps.world.record.steps} step(s), sha256 ${steps.world.record.sha256.slice(0, 16)})` : ''}`);
        const check = await runTool(producer.bin, ['check', '--rig', op.spec, '--out', 'check', '--parts', inputs.parts, '--page-edges', pageEdges, '--pack-shape', packShape, ...(steps.world ? ['--environment', 'environment.json'] : [])], { cwd: dir, onLine: push });
        let checkJson: unknown = null;
        try { checkJson = JSON.parse(await readFile(join(dir, 'check', 'check.json'), 'utf8')); } catch { /* check refused before writing it; its line says why */ }
        steps.check(checkSummary(checkJson, check.exitCode, check.lines, firstRefusal(check.lines)), check.wallMs);
      }
      // The package and its producer inputs must still be the bytes the request was made against.
      // The handoff files are in the reviewed identity, so this also catches a config, parts or rig change.
      try { await options.unchanged(); } catch { throw new RebuildError('REBUILD_INPUTS_CHANGED', 'the package or its producer handoff changed during the rebuild'); }
      job.build = await hashBuild(join(dir, 'build'), job.id);
      if (steps.hashed) await steps.hashed();
      // #166: an undo's re-run must reproduce the build its record names, file for file; otherwise it is refused, not guessed.
      const changed = steps.candidate ? null : restoredDifference(job.id, job.build.files);
      if (changed) { job.producerLine = changed; outcome = 'refused'; push(`review: ${changed}`); return; }
      if (!steps.candidate) latestId = job.id;
      await writeFile(join(dir, 'result.json'), JSON.stringify({ ...job, status: 'built', reused: false }, null, 1) + '\n', { mode: 0o600 });
      // Each Apply replaces the previous scratch build of this package in the scratch root; #166 keeps the applied records'
      // earlier builds beside it (keptRoot) for undo. #173: a strip candidate lands nowhere until its row is Applied.
      if (!steps.candidate) await landed({ ...job, status: 'built' });
      // "built" is published last: a reader that sees it finds the scratch root already settled (no sibling mid-removal).
      job.status = 'built';
    } catch (error) {
      outcome = 'failed'; job.producerLine = error instanceof Error ? error.message : String(error); push(`review: ${job.producerLine}`);
    } finally {
      const built = job.status === 'built';
      if (restoring?.id === job.id && !built) restoring = null;
      // Only a built Apply keeps its scratch directory; a refusal or failure leaves nothing behind — removed before it is published.
      if (!built) { await rm(dir, { recursive: true, force: true }).catch(() => {}); job.status = outcome ?? 'failed'; }
    }
  }

  /** #99: the designation's entry → `rig-parts remesh` → a scratch revision, compiled with the revision's own pack flags. */
  function execute(job: RebuildJob, dir: string, inputs: ProducerInputs, resolved: Resolved, entry: string): Promise<void> {
    return apply(job, dir, inputs, resolved, {
      cmd: 'remesh', spec: 'revision',
      async run(push) {
        await writeFile(join(dir, 'mesh.json'), entry, { mode: 0o600 });
        push(`review: ${resolved.producer.package} ${resolved.producer.version} remesh ${job.request.part} → scratch revision`);
        return runTool(resolved.producer.bin, remeshArgs({ rig: inputs.rig, config: inputs.config, parts: inputs.parts, part: job.request.part, mesh: 'mesh.json', out: 'revision' }), { cwd: dir, onLine: push });
      },
      wallMs: ms => { job.wallMs.remesh = ms; },
      async flags() {
        const provenance = object(JSON.parse(await readFile(join(dir, 'revision', 'remesh.json'), 'utf8')), 'remesh.json'), request = object(provenance.request, 'remesh.json request');
        return { pageEdges: request.page_edges === 'pot' ? 'pot' : 'free', packShape: request.pack_shape === 'rect' ? 'rect' : 'polygon', note: ' (the revision\'s own pack flags)' };
      },
    });
  }

  /**
   * #102: the patched config → `rig-parts rig` (whole rig), `retune` (#136: the constraints and the idle spliced onto the
   * inspected rig) or `remesh` (one part's patched entry) → `<dir>/rig`; the tail adds the diff and check.
   */
  function executePatch(job: PatchJob, dir: string, inputs: ProducerInputs, resolved: Resolved, patched: JsonValue, part: string | null, plan: BuildPlan | null = null, world: ApplyWorld | null = null, cloth: ClothPlan | null = null, candidate = false): Promise<void> {
    const args = job.request.patch.op.args, producer = resolved.producer;
    let counts: RemeshCounts | null = null;
    let built: ProcessResult | null = null;
    /** #111: a cloth job whose written config declares limbs is built as `build` does; otherwise as `rig --config`. */
    const building = job.op === 'build' || (job.op === 'cloth' && job.cloth?.route === 'build');
    /** #115 (and #111's build route): assemble → rig → check on `config.json`, already written into the scratch directory. */
    async function runBuild(push: (line: string) => void, what: string): Promise<ProcessResult> {
      // #112: build forwards `--environment` to its check stage (rig-parts build --help, 1.48.0).
      if (world) await writeFile(join(dir, 'environment.json'), world.text, { mode: 0o600 });
      push(`review: ${producer.package} ${producer.version} build --config config.json (${what}) --source <handoff source> --full <handoff full>${plan!.head ? ' --head <handoff head>' : ''} --seam-pairs${world ? ` --environment environment.json (the exported schedule, ${world.record.steps} step(s), sha256 ${world.record.sha256.slice(0, 16)})` : ''} → scratch out (assemble → rig → check)`);
      // `--seam-pairs` (forwarded to check): the setup-pose seam split by pair on a pass too, so every Apply shows its `seam pair` lines.
      built = await runTool(producer.bin, ['build', '--config', 'config.json', '--source', plan!.source, '--full', plan!.full, ...(plan!.head ? ['--head', plan!.head] : []), '--out', 'out', '--seam-pairs', ...(world ? ['--environment', 'environment.json'] : []), ...args], { cwd: dir, onLine: push });
      const readout = buildReadout(built.lines);
      // A check that ran and found a bar not met is check's judgment, kept beside the build (as for a `rig` patch):
      // build prints "stopped at check; N bar(s) not met" (a check that refused its input says "no later stage ran").
      const stoppedAtCheck = built.exitCode !== 0 && built.lines.some(l => /^build: stopped at check; \d+ bar\(s\) not met/.test(l.trim())) && (await exists(join(dir, 'out', 'rig', 'rig.json')));
      job.assembled = { ...job.assembled!, refusals: stoppedAtCheck ? [] : readout.refusals, checkFails: stoppedAtCheck ? readout.refusals : [], lines: readout.assemble, seam: readout.seam, seamPairs: readout.seamPairs, recomposite: { ...job.assembled!.recomposite, line: readout.recomposite } };
      const lines = buildLines(built.lines);
      return { ...built, exitCode: stoppedAtCheck ? 0 : built.exitCode, lines, stdout: lines };
    }
    /** #111: propose writes the config, review checks the written diff, then the written config is built. */
    async function runCloth(push: (line: string) => void): Promise<ProcessResult> {
      const c = job.cloth!, plan2 = cloth!;
      // cloth.json: the patched handoff config with every path it names made absolute (the scratch copy reads the
      // handoff's files), so the config propose writes beside it builds from the same files.
      const input = JSON.parse(scratchConfigText(inputs.config, patched)) as Record<string, unknown>;
      absolutizeBuildFiles(input, value => (isAbsolute(value) ? value : resolve(dirname(inputs.config), value)));
      await writeFile(join(dir, 'cloth.json'), JSON.stringify(input, null, 2) + '\n', { mode: 0o600 });
      push(`review: ${producer.package} ${producer.version} propose --parts <handoff parts> --source <handoff source> --keypoints <handoff keypoints> --out propose --cloth cloth.json (the handoff config with ${job.request.patch.ops.length} patch op(s)) --write-config config.json`);
      const proposed = await runTool(producer.bin, ['propose', '--parts', inputs.parts, '--source', plan2.source, '--keypoints', plan2.keypoints, '--out', 'propose', '--cloth', 'cloth.json', '--write-config', 'config.json'], { cwd: dir, onLine: push });
      c.wallMs.propose = proposed.wallMs;
      if (proposed.exitCode !== 0) { c.refusals = proposed.lines.filter(l => /^\s*FAIL\s/.test(l)).map(l => l.trim()).slice(0, MAX_BUILD_READOUT); return proposed; }
      c.line = proposed.stdout.map(l => l.trim()).find(l => l.startsWith('wrote config.json:')) ?? null;
      const written = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as unknown;
      c.written = writtenDiff(input, written);
      c.links = clothLinks(written, plan2.partsJson, plan2.targets);
      if (c.written.outside.length) {
        const line = `${CLOTH_WRITTEN_OUTSIDE_DRAFTED}: the config propose wrote differs from cloth.json outside the sections it splices, at ${c.written.outside.slice(0, 8).join(', ')}${c.written.outside.length > 8 ? ', …' : ''}; not built`;
        push(`review: ${line}`);
        return { exitCode: 1, lines: [line], stdout: [], wallMs: proposed.wallMs };
      }
      push(`review: the written config differs from cloth.json at ${c.written.count} path(s), every one under the sections propose splices${c.written.sections.length ? ` (${c.written.sections.join(', ')})` : ''}`);
      let op: ProcessResult;
      if (c.route === 'build') op = await runBuild(push, 'the config propose wrote');
      else {
        push(`review: ${producer.package} ${producer.version} rig --config config.json (the config propose wrote) → scratch rig`);
        op = await runTool(producer.bin, ['rig', '--config', 'config.json', '--parts', inputs.parts, '--out', 'rig', ...args], { cwd: dir, onLine: push });
      }
      c.wallMs.build = op.wallMs;
      return { ...op, wallMs: proposed.wallMs + op.wallMs };
    }
    return apply(job, dir, inputs, resolved, {
      cmd: job.op === 'cloth' ? 'propose' : job.op, spec: building ? 'out/rig' : 'rig',
      async run(push) {
        if (job.op === 'cloth' && cloth) return runCloth(push);
        if (job.op === 'build' && plan) {
          // #115: assemble → rig → check from the painting and the runs, the patched config's assemble-read files absolute.
          const doc = JSON.parse(scratchConfigText(inputs.config, patched)) as Record<string, unknown>;
          absolutizeBuildFiles(doc, value => (isAbsolute(value) ? value : resolve(dirname(inputs.config), value)));
          await writeFile(join(dir, 'config.json'), JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
          return runBuild(push, `the handoff config with ${job.request.patch.ops.length} patch op(s)`);
        }
        if (job.op === 'retune') {
          // retune reads the inspected rig and writes only --out; what it holds it refuses by name (RETUNE_REQUEST_HELD).
          await writeFile(join(dir, 'config.json'), scratchConfigText(inputs.config, patched), { mode: 0o600 });
          push(`review: ${producer.package} ${producer.version} retune --rig <handoff rig> --config config.json (the handoff config with ${job.request.patch.ops.length} patch op(s)) → scratch rig`);
          return runTool(producer.bin, ['retune', '--rig', inputs.rig, '--config', 'config.json', '--parts', inputs.parts, '--out', 'rig', ...args], { cwd: dir, onLine: push });
        }
        if (part === null) {
          await writeFile(join(dir, 'config.json'), scratchConfigText(inputs.config, patched), { mode: 0o600 });
          push(`review: ${producer.package} ${producer.version} rig --config config.json (the handoff config with ${job.request.patch.ops.length} patch op(s)) → scratch rig`);
          return runTool(producer.bin, ['rig', '--config', 'config.json', '--parts', inputs.parts, '--out', 'rig', ...args], { cwd: dir, onLine: push });
        }
        // remesh takes the one entry and reads the handoff config as written (REMESH_BASELINE_MISMATCH otherwise).
        const entry = (patched as Record<string, Record<string, JsonValue>>).meshes?.[part];
        if (entry === undefined) throw new RebuildError('EDIT_PATCH_PATH_MISSING', `the patched config has no meshes.${part}`);
        await writeFile(join(dir, 'mesh.json'), JSON.stringify(entry, null, 1) + '\n', { mode: 0o600 });
        const rest = args.filter((_, i) => args[i] !== '--part' && args[i - 1] !== '--part');
        push(`review: ${producer.package} ${producer.version} remesh ${part} (its patched meshes entry) → scratch rig`);
        return runTool(producer.bin, [...remeshArgs({ rig: inputs.rig, config: inputs.config, parts: inputs.parts, part, mesh: 'mesh.json', out: 'rig' }), ...rest], { cwd: dir, onLine: push });
      },
      wallMs: ms => { job.wallMs.op = ms; },
      async flags(push) {
        if (building && built) {
          job.exitCode = built.exitCode;
          const lines = buildLines(built.lines);
          job.producerLine = lines.filter(l => /^build:\s/.test(l)).at(-1) ?? job.producerLine;
          let checkJson: unknown = null;
          try { checkJson = JSON.parse(await readFile(join(dir, 'out', 'check', 'check.json'), 'utf8')); } catch { /* check wrote none; its line says why */ }
          job.check = checkSummary(checkJson, built.exitCode, lines, firstRefusal(lines));
          await assembledAfter(job, dir, inputs);
          for (const l of job.assembled!.seamPairs.slice(0, 8)) push(`review: ${l}`);
          return { pageEdges: flagValue(args, '--page-edges', 'free') as PageEdges, packShape: flagValue(args, '--pack-shape', 'polygon') as PackShape, note: ' (the build\'s pack flags)' };
        }
        if (job.op === 'retune') {
          const request = object(object(JSON.parse(await readFile(join(dir, 'rig', 'retune.json'), 'utf8')) as unknown, 'retune.json').request, 'retune.json request');
          return { pageEdges: request.page_edges === 'pot' ? 'pot' : 'free', packShape: request.pack_shape === 'rect' ? 'rect' : 'polygon', note: ' (retune.json\'s pack flags)' };
        }
        if (part === null) return { pageEdges: flagValue(args, '--page-edges', 'free') as PageEdges, packShape: flagValue(args, '--pack-shape', 'polygon') as PackShape, note: '' };
        const provenance = JSON.parse(await readFile(join(dir, 'rig', 'remesh.json'), 'utf8')) as unknown;
        const request = object(object(provenance, 'remesh.json').request, 'remesh.json request');
        counts = remeshCounts(provenance);
        if (counts) push(`review: remesh.json ${counts.part}: v ${counts.before.vertices} t ${counts.before.triangles} → v ${counts.after.vertices} t ${counts.after.triangles}`);
        return { pageEdges: request.page_edges === 'pot' ? 'pot' : 'free', packShape: request.pack_shape === 'rect' ? 'rect' : 'polygon', note: '' };
      },
    }, {
      diff: files => { const rigJson = files.documents.find(d => d.file === 'rig.json'); job.files = files; job.diff = rigJson ? { count: rigJson.count, paths: rigJson.paths } : null; },
      // #115: build runs check itself, on the parts it assembled; its check.json is read after the op (flags).
      ...(building ? {} : { check: (summary: CheckSummary, wallMs: number | null) => { job.wallMs.check = wallMs; job.check = summary; } }),
      // #139: a retune Apply reads the check retune ran on its revision (retune.json, bound by its hash rows) unless the
      // Apply checks under an exported world (retune's check reads the default one) or the producer carries no line.
      // #174: a remesh patch the same, from remesh.json — remesh checked the revision with the request's pack flags,
      // the ones `flags` reads for review's own check, and the same `--parts`; a patch passes no `--requirements`.
      ...(job.op === 'retune' || job.op === 'remesh' ? { carried: (push: (line: string) => void) => opCarried(job.op as CarryingOp, join(dir, 'rig'), world, push) } : {}),
      hashed: async () => { if (counts) job.remesh = { ...counts, modelTriangles: modelMeshTriangles(JSON.parse(await readFile(join(dir, 'build', 'skeleton.model.json'), 'utf8')), counts.part) }; },
      world,
      ...(candidate ? { candidate: true } : {}),
    });
  }

  /**
   * `POST /api/rebuild` with `{patch}`: the patch is checked against the handoff config's bytes (`EDIT_PATCH_STALE`),
   * applied to a scratch copy, and the op it names runs on that copy. A `rig` patch inside retune's scope runs `retune`
   * on a producer that has it (#136, `src/retune-route.ts`); any other `rig` patch rebuilds the whole rig and first needs
   * the baseline to have reproduced the inspected rig (`EDIT_BASELINE_MISMATCH` naming the path). Refusals come before anything is run.
   */
  async function startPatch(input: unknown, world: ApplyWorld | null = null, body: unknown = { patch: input }): Promise<{ status: number; body: unknown }> {
    let patch: ConfigPatch;
    try { patch = parseConfigPatch(input); } catch (e) { if (e instanceof ConfigPatchError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    let patched: JsonValue, part: string | null = null;
    const original = JSON.parse(inputs.configText) as JsonValue;
    try {
      assertPatchFresh(patch, inputs.configHash);
      assertOpNames(original, patch.ops);
      patched = applyConfigPatch(original, patch.ops);
      if (patch.op.cmd === 'remesh') part = remeshPart(patch);
    } catch (e) { if (e instanceof ConfigPatchError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    assertNamedFilesHeld(original, patched);
    // #111: a cloth recipe patch (every op under /cloth) runs propose --cloth --write-config, then builds what it wrote.
    // Decision 1: without the declared keypoints the draft moves the body bones, so it is refused before anything else.
    const clothKind = clothPatchKind(patch.ops);
    if (clothKind === 'mixed') throw new RebuildError('CLOTH_PATCH_MIXED', CLOTH_PATCH_MIXED.slice('CLOTH_PATCH_MIXED: '.length));
    const clothing = clothKind === 'cloth' && patch.op.cmd === 'rig';
    if (clothing && (!p.handoff!.keypoints || !p.handoff!.record.keypoints)) throw new RebuildError('CLOTH_KEYPOINTS_UNDECLARED', CLOTH_KEYPOINTS_UNDECLARED.slice('CLOTH_KEYPOINTS_UNDECLARED: '.length));
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    if (patch.producer.name !== resolved.producer.package || patch.producer.version !== resolved.producer.version) throw new RebuildError('EDIT_PRODUCER_MISMATCH', `the patch was made for ${patch.producer.name} ${patch.producer.version}; the installed producer is ${resolved.producer.package} ${resolved.producer.version}`);
    // #112: `check --environment` is @rig-c/parts 1.48.0's (parts#538); an older producer is refused by name, nothing run.
    if (world && !versionAtLeast(resolved.producer.version, CHECK_ENVIRONMENT_SINCE)) { const error = modelingProducerTooOld(resolved.producer.version || 'unknown', CHECK_ENVIRONMENT_SINCE, 'rig-parts check --environment'); return { status: 200, body: { status: 'refused', error, producerLine: error } }; }
    // #136: the whole-rig rebuild is the fast path (~18 s) and gives the same bytes when the baseline is reproduced,
    // so it stays the default. Only when the config cannot reproduce the inspected rig (a repaired build) does a
    // patch inside retune's scope run retune, which holds the rest of the inspected rig itself (~52 s).
    // #115: a cut, patch or limb edit (or a bone edit on a config with limbs) is read by assemble, so it runs `build`.
    let clothPlan: ClothPlan | null = null;
    if (clothing) {
      if (!versionAtLeast(resolved.producer.version, CLOTH_WRITE_SINCE)) { const error = modelingProducerTooOld(resolved.producer.version || 'unknown', CLOTH_WRITE_SINCE, 'rig-parts propose --cloth --write-config (entry by entry)'); return { status: 200, body: { status: 'refused', error, producerLine: error } }; }
      if (!p.handoff!.source) throw new RebuildError('MODELING_INPUT_UNAVAILABLE', CLOTH_SOURCE_UNAVAILABLE.slice('MODELING_INPUT_UNAVAILABLE: '.length));
      let partsJson: unknown = null;
      try { partsJson = JSON.parse(await readFile(join(inputs.parts, 'parts.json'), 'utf8')); } catch { /* propose reads parts.json itself and refuses by name */ }
      clothPlan = { source: p.handoff!.source, keypoints: p.handoff!.keypoints!, partsJson, targets: (await clothTargets(resolved.producer.root, inputs.configText)).tags };
    }
    // Decision 2 (#111): the written config is built as #115 builds when it declares limbs, else by `rig --config`.
    const building = patch.op.cmd === 'rig' && (needsBuild(patch.ops, original) || (clothing && !!original && typeof original === 'object' && !Array.isArray(original) && (original as Record<string, unknown>).limbs !== undefined));
    let plan: BuildPlan | null = null;
    if (building) {
      const held = newBuildFile(original, patched);
      if (held) throw new RebuildError('EDIT_PATCH_PATH_HELD', `${held} names a file the handoff config does not; a patch may not name a new file (review sends no path)`);
      plan = await buildPlan(p.handoff!, patched, abs => relative(p.root, abs).split(sep).join('/'));
    }
    const route = patch.op.cmd === 'remesh' ? 'remesh' : clothing ? 'cloth' : building ? 'build' : patchRoute(patch.ops, resolved.producer.version);
    const baselineNow = route === 'retune' ? await settledBaseline() : null;
    const op: AppliedOp = route === 'retune' && baselineNow?.status === 'reproduced' ? 'rig' : route;
    if (op === 'rig' || op === 'build' || op === 'cloth') {
      try { assertWholeRigBaseline(await settledBaseline()); } catch (e) { if (e instanceof BaselineError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    }
    const id = patchId({ sourceHash: p.sourceHash, configHash: inputs.configHash, patch, producer: `${resolved.producer.package}@${resolved.producer.version}`, compiler: `${resolved.compiler.package}@${resolved.compiler.version}`, op, ...(plan ? { buildInputs: plan.inputsHash } : {}), ...(world ? { environment: world.record.sha256 } : {}), ...(clothPlan ? { cloth: p.handoff!.record.keypoints!.sha256 } : {}) });
    const current = jobs.get(id);
    if (current?.status === 'running') return { status: 202, body: snapshot(current) };
    if (busy()) return { status: 200, body: { status: 'refused', error: busy(), producerLine: null } };
    guardRestore(id);
    const dir = rebuildDir(options.stateDir, p.sourceHash, id);
    await adopt(id);
    await unkeep(id);
    const reused = await reuse<PatchJob>(dir, id);
    if (reused) { jobs.set(id, reused); latestId = id; bodies.set(id, body); await landed(reused); return { status: 200, body: snapshot(reused) }; }
    const job: PatchJob = { schema: REBUILD_SCHEMA, kind: 'patch', id, status: 'running', reused: false, op, request: { patch, patchSha256: patchSha256(patch), configHash: inputs.configHash }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, exitCode: null, wallMs: { op: null, compile: null, check: null }, check: null, diff: null, files: null, remesh: null, build: null,
      ...(plan ? { assembled: { inputs: plan.inputs, refusals: [], checkFails: [], lines: [], seam: [], seamPairs: [], recomposite: { line: null, before: null, after: null, errorMap: null }, parts: null } } : {}),
      ...(world ? { environment: world.record } : {}),
      ...(clothPlan ? { cloth: { route: building ? 'build' as const : 'rig' as const, inputs: { source: p.handoff!.record.source?.path ?? '', keypoints: { ...p.handoff!.record.keypoints! } }, refusals: [], line: null, written: null, links: [], wallMs: { propose: null, build: null } } } : {}) };
    jobs.set(id, job); running = id; bodies.set(id, body);
    void executePatch(job, dir, inputs, resolved, patched, part, plan, world, clothPlan).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }

  /**
   * #173 · `POST /api/density-strip` with `{patches}`: 2–5 Mesh-panel patches for one part that differ only at its density
   * field (`src/density-strip.ts`). Each is checked as an Apply checks it (fresh config bytes, names, held files, the
   * installed producer) and runs through the same patch runner — remesh, the compile, #174's carried check — into its own
   * folder under `stripRoot`, at most `concurrency` at once. Nothing lands: no applied record, no stage, no undo entry.
   * A new strip replaces the folder of the one before it; refused while an Apply runs (and an Apply is refused while a
   * strip runs: `REBUILD_BUSY`).
   */
  async function startStrip(input: unknown): Promise<{ status: number; body: unknown }> {
    let patches: ConfigPatch[];
    try { patches = stripPatches(input).map(parseConfigPatch); }
    catch (e) { if (e instanceof ConfigPatchError || e instanceof DensityStripError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    let shape: ReturnType<typeof stripShape>;
    try { shape = stripShape(patches); } catch (e) { if (e instanceof DensityStripError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    const original = JSON.parse(inputs.configText) as JsonValue;
    const planned: { patch: ConfigPatch; patched: JsonValue }[] = [];
    for (const patch of patches) {
      let patched: JsonValue;
      try { assertPatchFresh(patch, inputs.configHash); assertOpNames(original, patch.ops); patched = applyConfigPatch(original, patch.ops); remeshPart(patch); }
      catch (e) { if (e instanceof ConfigPatchError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
      assertNamedFilesHeld(original, patched);
      planned.push({ patch, patched });
    }
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    const first = patches[0]!;
    if (first.producer.name !== resolved.producer.package || first.producer.version !== resolved.producer.version) throw new RebuildError('EDIT_PRODUCER_MISMATCH', `the patch was made for ${first.producer.name} ${first.producer.version}; the installed producer is ${resolved.producer.package} ${resolved.producer.version}`);
    const producer = `${resolved.producer.package}@${resolved.producer.version}`, compiler = `${resolved.compiler.package}@${resolved.compiler.version}`;
    const id = stripId({ sourceHash: p.sourceHash, configHash: inputs.configHash, patches, producer, compiler });
    if (strip?.id === id) return { status: strip.status === 'running' ? 202 : 200, body: stripView() };
    const refusal = busy();
    if (refusal) return { status: 200, body: { status: 'refused', error: refusal, producerLine: null } };
    // Bounded disk: the strip on screen is the only one this package keeps; its predecessor's folder goes first.
    const root = stripRoot(options.stateDir, p.sourceHash);
    await rm(root, { recursive: true, force: true });
    const concurrency = Math.max(1, Math.floor(options.stripConcurrency ?? defaultStripConcurrency()));
    const candidates: StripCandidate[] = planned.map(({ patch }, i) => {
      const cid = patchId({ sourceHash: p.sourceHash, configHash: inputs.configHash, patch, producer, compiler, op: 'remesh' });
      const job: PatchJob = { schema: REBUILD_SCHEMA, kind: 'patch', id: cid, status: 'running', reused: false, op: 'remesh', request: { patch, patchSha256: patchSha256(patch), configHash: inputs.configHash }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, exitCode: null, wallMs: { op: null, compile: null, check: null }, check: null, diff: null, files: null, remesh: null, build: null };
      return { value: shape.values[i]!, id: cid, entry: shape.entries[i]!, dir: join(root, id, cid), job, applied: false };
    });
    const current = { id, status: 'running' as const, part: shape.part, field: shape.field, concurrency, configHash: inputs.configHash, producer: tool(resolved.producer), compiler: tool(resolved.compiler), started: performance.now(), wallMs: null, candidates };
    strip = current;
    // A bounded pool: each worker takes the next candidate in order; the strip is done when every candidate settled.
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < candidates.length; i = next++) {
        const c = candidates[i]!;
        await executePatch(c.job, c.dir, inputs, resolved, planned[i]!.patched, shape.part, null, null, null, true).catch(() => {});
      }
    };
    void Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker)).finally(() => {
      if (strip === current) { (current as { status: 'running' | 'done' }).status = 'done'; (current as { wallMs: number | null }).wallMs = Math.round(performance.now() - current.started); }
    });
    return { status: 202, body: stripView() };
  }
  function stripView(): DensityStripView | null {
    if (!strip) return null;
    const s = strip;
    const rows = s.candidates.map(c => candidateRow({ value: c.value, id: c.id, entry: c.entry, job: c.job, part: s.part, modelUrl: c.job.build ? `/density-strip/${s.id}/${c.id}/${c.job.build.model}` : null, applied: c.applied }));
    return { schema: DENSITY_STRIP_SCHEMA, id: s.id, status: s.status, part: s.part, field: s.field, concurrency: s.concurrency, configHash: s.configHash, producer: s.producer, compiler: s.compiler, wallMs: s.wallMs, rows, labels: s.status === 'done' ? stripLabels(rows) : { fewest: null, widest: null } };
  }
  /** `GET /api/density-strip/<id>` (and `GET /api/density-strip`: the strip on screen, or null). */
  function readStrip(id?: string): DensityStripView | null {
    if (id !== undefined && strip?.id !== id) throw new RebuildError('DENSITY_STRIP_NOT_FOUND', id);
    return stripView();
  }
  /** A candidate's job as it settled (its lines in full), for the row's log. */
  function stripJob(id: string, cid: string): PatchJob {
    const c = strip?.id === id ? strip.candidates.find(x => x.id === cid) : undefined;
    if (!c) throw new RebuildError('DENSITY_STRIP_NOT_FOUND', `${id}/${cid}`);
    return snapshot(c.job);
  }
  /** `POST /api/density-strip/close` with `{id}`: the strip's folder is removed; refused while its candidates run. */
  async function closeStrip(input: unknown): Promise<{ status: number; body: unknown }> {
    const v = object(input, 'density strip close');
    if (Object.keys(v).join(',') !== 'id' || typeof v.id !== 'string' || !/^[a-f0-9]{64}$/.test(v.id)) throw new RebuildError('REBUILD_REQUEST_INVALID', 'expected exactly {id: <the strip id>}');
    if (strip?.id !== v.id) throw new RebuildError('DENSITY_STRIP_NOT_FOUND', `${v.id.slice(0, 12)}… is not the strip on screen`);
    if (strip.status === 'running') return { status: 200, body: { status: 'refused', error: `DENSITY_STRIP_BUSY: strip ${strip.id} is still running; close it when its candidates settle`, producerLine: null } };
    const applied = strip.candidates.filter(c => c.applied).length;
    strip = null;
    await rm(stripRoot(options.stateDir, p.sourceHash), { recursive: true, force: true });
    return { status: 200, body: { status: 'closed', id: v.id, applied } };
  }
  /** A served candidate file: only a built, not-applied candidate's hashed model and pages, read-only. */
  async function stripFile(id: string, cid: string, name: string): Promise<string> {
    const c = strip?.id === id ? strip.candidates.find(x => x.id === cid) : undefined;
    if (!c || c.applied || c.job.status !== 'built' || !c.job.build || !Object.hasOwn(c.job.build.files, name)) throw new RebuildError('DENSITY_STRIP_NOT_FOUND', `${id}/${cid}/${name}`);
    return safeFile(await realpath(join(c.dir, 'build')), packagePath(name));
  }
  /**
   * #173: an Apply whose build id is a settled strip candidate's takes that candidate's build: the folder moves into the
   * scratch root, where the ordinary reuse reads and re-hashes it and lands it as any Apply lands. The row then reads
   * "applied" and is no longer served from the strip.
   */
  async function adopt(id: string): Promise<void> {
    const c = strip && strip.status === 'done' ? strip.candidates.find(x => x.id === id && !x.applied && x.job.status === 'built') : undefined;
    if (!c) return;
    const to = rebuildDir(options.stateDir, p.sourceHash, id);
    if (await exists(to)) return;
    await mkdir(rebuildRoot(options.stateDir, p.sourceHash), { recursive: true, mode: 0o700 });
    await rename(c.dir, to);
    c.applied = true;
  }

  /** #135: the delta → `rig-parts remesh --delta mesh-edit.json --part <part>` → `<dir>/rig`; the tail adds the per-file diff. */
  function executeDelta(job: DeltaJob, dir: string, inputs: ProducerInputs, resolved: Resolved, text: string): Promise<void> {
    const producer = resolved.producer, part = job.request.part;
    let counts: RemeshCounts | null = null;
    return apply(job, dir, inputs, resolved, {
      cmd: 'remesh', spec: 'rig',
      async run(push) {
        await writeFile(join(dir, 'mesh-edit.json'), text, { mode: 0o600 });
        const ops = Array.isArray(job.request.delta.ops) ? job.request.delta.ops.length : '?';
        push(`review: ${producer.package} ${producer.version} remesh --delta mesh-edit.json --part ${part} (Edit Mesh's delta, ${ops} op(s), sha256 ${job.request.deltaSha256.slice(0, 12)}…) → scratch rig`);
        return runTool(producer.bin, remeshDeltaArgs({ rig: inputs.rig, config: inputs.config, parts: inputs.parts, part, delta: 'mesh-edit.json', out: 'rig' }), { cwd: dir, onLine: push });
      },
      wallMs: ms => { job.wallMs.op = ms; },
      async flags(push) {
        const provenance = JSON.parse(await readFile(join(dir, 'rig', 'remesh.json'), 'utf8')) as unknown;
        const request = object(object(provenance, 'remesh.json').request, 'remesh.json request');
        counts = remeshCounts(provenance);
        if (counts) push(`review: remesh.json ${counts.part}: v ${counts.before.vertices} t ${counts.before.triangles} → v ${counts.after.vertices} t ${counts.after.triangles}`);
        return { pageEdges: request.page_edges === 'pot' ? 'pot' : 'free', packShape: request.pack_shape === 'rect' ? 'rect' : 'polygon', note: ' (remesh.json\'s pack flags)' };
      },
    }, {
      diff: files => { job.files = files; },
      hashed: async () => { if (counts) job.remesh = { ...counts, modelTriangles: modelMeshTriangles(JSON.parse(await readFile(join(dir, 'build', 'skeleton.model.json'), 'utf8')), counts.part) }; },
    });
  }

  /**
   * `POST /api/rebuild` with `{part, delta, configHash}` (#135): the config hash the editor read must still be the
   * handoff's (`REBUILD_CONFIG_STALE`), and the installed producer must read `--delta` (`MODELING_PRODUCER_TOO_OLD`,
   * the version from its own manifest). Everything about the delta itself is the producer's judgment, verbatim.
   */
  async function startDelta(input: unknown): Promise<{ status: number; body: unknown }> {
    const request = parseDeltaRequest(input);
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    if (inputs.configHash !== request.configHash) throw new RebuildError('REBUILD_CONFIG_STALE', 'the producer config changed since the editor read it; reload');
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    if (!versionAtLeast(resolved.producer.version, REMESH_DELTA_SINCE)) {
      const error = modelingProducerTooOld(resolved.producer.version || 'unknown', REMESH_DELTA_SINCE, 'rig-parts remesh --delta');
      return { status: 200, body: { status: 'refused', error, producerLine: error } };
    }
    const text = meshEditText(request.delta);
    const id = deltaId({ sourceHash: p.sourceHash, configHash: inputs.configHash, part: request.part, deltaText: text, producer: `${resolved.producer.package}@${resolved.producer.version}`, compiler: `${resolved.compiler.package}@${resolved.compiler.version}` });
    const current = jobs.get(id);
    if (current?.status === 'running') return { status: 202, body: snapshot(current) };
    if (busy()) return { status: 200, body: { status: 'refused', error: busy(), producerLine: null } };
    guardRestore(id);
    const dir = rebuildDir(options.stateDir, p.sourceHash, id);
    await adopt(id);
    await unkeep(id);
    const reused = await reuse<DeltaJob>(dir, id);
    if (reused) { jobs.set(id, reused); latestId = id; bodies.set(id, input); await landed(reused); return { status: 200, body: snapshot(reused) }; }
    const job: DeltaJob = { schema: REBUILD_SCHEMA, kind: 'delta', id, status: 'running', reused: false, op: 'remesh', request: { part: request.part, delta: request.delta, deltaSha256: sha256(text), configHash: inputs.configHash }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, exitCode: null, wallMs: { op: null, compile: null }, files: null, remesh: null, build: null };
    jobs.set(id, job); running = id; bodies.set(id, input);
    void executeDelta(job, dir, inputs, resolved, text).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }

  /** The package's declared `rig-pose-sequence/1` references (validated at load), with whether clean's record is on them. */
  async function retargetSequences(): Promise<RetargetSequence[]> {
    const out: RetargetSequence[] = [];
    for (const r of p.manifest.references.filter(r => r.type === 'pose')) {
      let doc: Record<string, unknown>;
      try { doc = object(JSON.parse(await readFile(await safeFile(p.root, r.path), 'utf8')), r.id); } catch { continue; }
      if (doc.spec !== 'rig-pose-sequence/1' || !Array.isArray(doc.frames)) continue;
      const people = [...new Set((doc.frames as { people?: { id?: unknown }[] }[]).flatMap(f => (f.people ?? []).map(x => String(x.id))))];
      out.push({ id: r.id, label: r.label, path: r.path, cleaned: doc.cleaned !== undefined, frames: doc.frames.length, people });
    }
    return out;
  }
  /** `GET /api/rebuild`'s retarget section (#114): whether a retarget can run here and what the editor picks from. */
  async function retargetStatus(inputs: ProducerInputs | null) {
    const resolved = resolvePose(options.starts), sequences = await retargetSequences();
    const read = async (name: string): Promise<Record<string, unknown>> => { if (!inputs) return {}; try { const v = JSON.parse(await readFile(join(inputs.rig, name), 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
    const rig = await read('rig.json'), motion = await read('motion.json');
    const bones = (Array.isArray(rig.bones) ? rig.bones : []).map(b => (b && typeof b === 'object' ? (b as Record<string, unknown>).name : null)).filter((n): n is string => typeof n === 'string');
    const animations = motion.animations && typeof motion.animations === 'object' && !Array.isArray(motion.animations) ? Object.keys(motion.animations) : [];
    const reason = !inputs ? (p.handoff ? handoffGap(p.handoff) : p.handoffReason ?? modelingHandoffMissing(null)) : !resolved.ok ? resolved.error : sequences.length ? null : 'RETARGET_SEQUENCE_UNAVAILABLE: the package declares no rig-pose-sequence/1 reference (a pose reference in review.json, or a *pose*.json in the opened folder)';
    return { available: reason === null, reason, producer: resolved.ok ? tool(resolved.producer) : null, compiler: resolved.ok ? tool(resolved.compiler) : null, rig: p.handoff?.record.rig ?? null, sequences, bones, animations };
  }

  /**
   * #114: clean (unless skipped) → retarget onto the handoff rig → `<dir>/motion.json`; the handoff rig's files are
   * copied beside it into `<dir>/rig/` so the shared tail diffs and compiles a whole rig spec. Nothing is read from or
   * written to the package but the declared sequence, read once into scratch.
   */
  function executeRetarget(job: RetargetJob, dir: string, inputs: ProducerInputs, resolved: Resolved, sequence: Uint8Array): Promise<void> {
    const pose = resolved.producer, record = job.request.record;
    let retargetRun: ProcessResult | null = null;
    const op: ProducerOp = {
      cmd: 'retarget', tool: 'rig-pose', spec: 'rig',
      async run(push) {
        await writeFile(join(dir, 'pose.json'), sequence, { mode: 0o600 });
        await writeFile(join(dir, 'map.json'), mapText(record.map), { mode: 0o600 });
        let input = 'pose.json';
        if (record.op.clean) {
          const args = cleanArgs({ pose: 'pose.json', out: 'pose.clean.json', argv: record.op.clean });
          push(`review: ${pose.package} ${pose.version} ${args.join(' ')}`);
          const clean = await runTool(pose.bin, args, { cwd: dir, onLine: push });
          job.wallMs.clean = clean.wallMs;
          if (clean.exitCode !== 0) { op.cmd = 'clean'; job.refusals = clean.lines.filter(l => /^\s*FAIL\s/.test(l)).map(l => l.trim()); return clean; }
          input = 'pose.clean.json';
        } else push(`review: clean skipped — the sequence goes to retarget as the package holds it`);
        const args = retargetArgs({ rig: inputs.rig, map: 'map.json', sequence: input, out: 'motion.json', argv: record.op.args });
        push(`review: ${pose.package} ${pose.version} retarget --rig <handoff rig> ${args.slice(3).join(' ')}`);
        retargetRun = await runTool(pose.bin, args, { cwd: dir, onLine: push });
        if (retargetRun.exitCode !== 0) job.refusals = retargetRun.lines.filter(l => /^\s*FAIL\s/.test(l)).map(l => l.trim());
        return retargetRun;
      },
      wallMs: ms => { if (retargetRun) job.wallMs.retarget = ms; },
      async flags(push) {
        // The handoff rig as a rig spec beside the retarget's motion: every regular file but motion.json, and images/.
        const out = join(dir, 'rig');
        await mkdir(join(out, 'images'), { recursive: true, mode: 0o700 });
        for (const [from, to] of [[inputs.rig, out], [join(inputs.rig, 'images'), join(out, 'images')]] as const) {
          let entries: import('node:fs').Dirent[] = [];
          try { entries = await readdir(from, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          for (const e of entries) if (e.isFile() && !(from === inputs.rig && e.name === 'motion.json')) await copyFile(join(from, e.name), join(to, e.name));
        }
        const text = await readFile(join(dir, 'motion.json'), 'utf8');
        await writeFile(join(out, 'motion.json'), text, { mode: 0o600 });
        let frameTimes: number[] | null = null;
        try { const report = JSON.parse(await readFile(join(dir, 'motion.report.json'), 'utf8')) as { frameTimes?: unknown }; if (Array.isArray(report.frameTimes) && report.frameTimes.every(t => typeof t === 'number')) frameTimes = report.frameTimes as number[]; } catch { /* no report: the lines' own t= */ }
        const clock = samplesClock(frameTimes); job.frameTimes = clock?.kind === 'samples' ? clock.frameTimes : null;
        job.readings = retargetLines(retargetRun?.lines ?? [], frameTimes).slice(0, MAX_RETARGET_LINES);
        let inspected: unknown = null;
        try { inspected = JSON.parse(await readFile(join(inputs.rig, 'motion.json'), 'utf8')); } catch { /* a rig without motion.json: nothing to keep */ }
        job.motion = motionSummary(inspected, JSON.parse(text), text, record.flags.animation);
        push(`review: motion.json holds ${job.motion.animations.length} animation(s), "${record.flags.animation}" added${job.motion.kept ? '; the rig\'s own animations unchanged' : `; changed: ${job.motion.changed.join(', ')}`}`);
        return { pageEdges: 'free', packShape: 'polygon', note: ' (Apply\'s default pack flags)' };
      },
    };
    return apply(job, dir, inputs, resolved, op, { diff: files => { job.files = files; } });
  }

  /**
   * `POST /api/rebuild` with `{retarget: {sequence, map, flags, configHash}}` (#114): the config hash the editor read must
   * still be the handoff's, the sequence a declared `rig-pose-sequence/1` reference, and `@rig-c/pose` installed. The
   * map's resolution against the rig, the flags' combinations and the pose are the producer's to judge, verbatim.
   */
  async function startRetarget(input: unknown, body: unknown = { retarget: input }): Promise<{ status: number; body: unknown }> {
    let request: ReturnType<typeof parseRetargetRequest>;
    try { request = parseRetargetRequest(input); } catch (e) { if (e instanceof RetargetError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    if (inputs.configHash !== request.configHash) throw new RebuildError('REBUILD_CONFIG_STALE', 'the producer config changed since the editor read it; reload');
    const reference = p.manifest.references.find(r => r.id === request.sequence && r.type === 'pose');
    if (!reference) throw new RebuildError('RETARGET_SEQUENCE_UNKNOWN', `${request.sequence} is not a pose reference the package declares`);
    const sequence = await readFile(await safeFile(p.root, reference.path));
    let spec: unknown;
    try { spec = (JSON.parse(Buffer.from(sequence).toString('utf8')) as { spec?: unknown }).spec; } catch { spec = null; }
    if (spec !== 'rig-pose-sequence/1') throw new RebuildError('RETARGET_SEQUENCE_UNSUPPORTED', `${reference.id} is not a rig-pose-sequence/1 (a static pose cannot be retargeted)`);
    const resolved = resolvePose(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    const rigJson = await readFile(join(inputs.rig, 'rig.json'));
    const record = retargetRecord(request, { rig: { path: inputs.handoff.rig ?? '', sha256: sha256(rigJson) }, sequence: { path: reference.path, sha256: sha256(sequence) }, producer: { name: resolved.producer.package, version: resolved.producer.version } });
    const id = retargetId({ sourceHash: p.sourceHash, configHash: inputs.configHash, record, producer: `${resolved.producer.package}@${resolved.producer.version}`, compiler: `${resolved.compiler.package}@${resolved.compiler.version}` });
    const current = jobs.get(id);
    if (current?.status === 'running') return { status: 202, body: snapshot(current) };
    if (busy()) return { status: 200, body: { status: 'refused', error: busy(), producerLine: null } };
    guardRestore(id);
    const dir = rebuildDir(options.stateDir, p.sourceHash, id);
    await adopt(id);
    await unkeep(id);
    const reused = await reuse<RetargetJob>(dir, id);
    if (reused) { jobs.set(id, reused); latestId = id; bodies.set(id, body); await landed(reused); return { status: 200, body: snapshot(reused) }; }
    const job: RetargetJob = { schema: REBUILD_SCHEMA, kind: 'retarget', id, status: 'running', reused: false, op: 'retarget', request: { record, recordSha256: sha256(retargetRecordText(record)), configHash: inputs.configHash }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, refusals: [], exitCode: null, wallMs: { clean: null, retarget: null, compile: null }, files: null, motion: null, readings: [], frameTimes: null, build: null };
    jobs.set(id, job); running = id; bodies.set(id, body);
    void executeRetarget(job, dir, inputs, resolved, sequence).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }

  /** `POST /api/rebuild`: refusals are returned before anything is written or run. */
  async function start(input: unknown): Promise<{ status: number; body: unknown }> {
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'retarget')) {
      if (Object.keys(input).length !== 1) bad('expected exactly {retarget}');
      return startRetarget((input as { retarget: unknown }).retarget, input);
    }
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'delta')) return startDelta(input);
    if (input && typeof input === 'object' && !Array.isArray(input) && Object.hasOwn(input, 'patch')) {
      // #112: `{patch, environment}` — the exported schedule Apply's check reads.
      const keys = Object.keys(input).sort().join(',');
      if (keys !== 'patch' && keys !== 'environment,patch') bad('expected exactly {patch}, {patch, environment} or {part, regions, configHash}');
      const world = Object.hasOwn(input, 'environment') ? parseApplyWorld((input as { environment: unknown }).environment) : null;
      return startPatch((input as { patch: unknown }).patch, world, input);
    }
    const request = parseRebuildRequest(input, options.bones);
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    if (inputs.configHash !== request.configHash) throw new RebuildError('REBUILD_CONFIG_STALE', 'the producer config changed since the editor read it; reload');
    const entry = request.bust ? bustEntryText(inputs.configText, request.part, request.bust) : meshEntryText(inputs.configText, request.part, request.regions);
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    const id = designationId({ sourceHash: p.sourceHash, configHash: inputs.configHash, part: request.part, entry, producer: `${resolved.producer.package}@${resolved.producer.version}`, compiler: `${resolved.compiler.package}@${resolved.compiler.version}` });
    const current = jobs.get(id);
    if (current?.status === 'running') return { status: 202, body: snapshot(current) };
    if (busy()) return { status: 200, body: { status: 'refused', error: busy(), producerLine: null } };
    guardRestore(id);
    const dir = rebuildDir(options.stateDir, p.sourceHash, id);
    await adopt(id);
    await unkeep(id);
    const reused = await reuse(dir, id);
    if (reused) { jobs.set(id, reused); latestId = id; bodies.set(id, input); await landed(reused); return { status: 200, body: snapshot(reused) }; }
    const job: RebuildJob = { schema: REBUILD_SCHEMA, id, status: 'running', reused: false, request: { ...request, entrySha256: sha256(entry) }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, exitCode: null, wallMs: { remesh: null, compile: null }, build: null };
    jobs.set(id, job); running = id; bodies.set(id, input);
    void execute(job, dir, inputs, resolved, entry).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }

  function read(id: string): RebuildJob | PatchJob | DeltaJob | RetargetJob {
    const job = jobs.get(id);
    if (!job) throw new RebuildError('REBUILD_NOT_FOUND', id);
    return snapshot(job);
  }

  /** A served scratch file: only a built job's hashed model and pages, read-only. */
  async function file(id: string, name: string): Promise<string> {
    const job = jobs.get(id);
    // #115: a built build job's scratch error map, read-only, by its one served name.
    if (name === RECOMPOSITE_ERROR_MAP && job && job.status === 'built' && 'kind' in job && job.kind === 'patch' && job.assembled?.recomposite.errorMap) return safeFile(await realpath(join(rebuildDir(options.stateDir, p.sourceHash, id), 'out')), 'recomposite_error_rig.png');
    if (!job || job.status !== 'built' || !job.build || !Object.hasOwn(job.build.files, name)) throw new RebuildError('REBUILD_NOT_FOUND', `${id}/${name}`);
    return safeFile(await realpath(join(rebuildDir(options.stateDir, p.sourceHash, id), 'build')), packagePath(name));
  }

  return { describe, start, read, file, running: () => running, baseline: settledBaseline, inspectedCheck: settledInspectedCheck, latest, undo, history, startStrip, readStrip, stripJob, closeStrip, stripFile };
}
