import {readSceneInspection,scenePlateBytes,type SceneInspection} from './scene-inspection.ts';
import {DIRECTION_MAX_BYTES, readDirectionInspection, type DirectionInspection} from './direction-inspection.ts';
import {discoverTurnDials} from './turn-pad.ts';
import {fileURLToPath} from 'node:url';
import { createHash } from 'node:crypto';
import { toolVersions } from './versions.ts';
import type { FeedbackCatalog } from './feedback-validation.ts';
import { validatePoseSequence } from './pose.ts';
import { parseReport, type ReportSeeds } from './report.ts';
import { framesSetClock, type DeclaredFrameClock } from './frame-clock.ts';
import { readFile, realpath, stat, lstat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, posix } from 'node:path';
import { isBuildRoot, parseHandoffDeclaration, resolveHandoff, type Handoff, type HandoffDeclaration, type HandoffFlags, type HandoffRecord } from './handoff.ts';
import { JOB_PREVIOUS_BUILD_SCHEMA, parsePanelComposition, type JobFileIdentity, type JobPanelComposition,
  type JobPreviousBuild, type JobSelector } from './job-contract.ts';
import { exactObject, jobHash, parseFileRow } from './job-api.ts';
import { readCheckpointEvidenceBytes } from './job-checkpoint-evidence.ts';
import { JobError, jobPath, jobPathTextLimit, jobSha } from './job-validation.ts';
import { checkedPath } from './interview-project.ts';
export { isPanelComponent, parsePanelComposition } from './job-contract.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Reference { id: string; label: string; type: 'image' | 'video' | 'pose'; path: string; width?: number; height?: number }
export interface Checkpoint { id: string; title: string; time?: number; animation?: string; reference?: string; note?: string; workspace?: 'modeling' | 'motion'; camera?: { zoom: number; x: number; y: number }; axis?: {id:string;value:number} }
export interface ReviewManifest {
  schema: 'rig-review/1'; id: string; title: string; revision: string; model?: string; frames?: string; motion?: string;
  sceneReport?: JobFileIdentity;
  direction?: string; scene?: string; sets?: string;
  references: Reference[]; animations: { id: string; label?: string; duration?: number }[];
  checkpoints: Checkpoint[]; authoring: { label: string; path: string }[];
  axes: { id: string; label: string; animation: string; min: number; max: number }[];
  audio: { clips: { id: string; label?: string; path: string }[]; cues: { id: string; clip: string; time: number; animation?: string }[] };
  /** Optional producer handoff (#101): package-relative literal paths; checked when the package loads. */
  producer?: HandoffDeclaration;
  panels?: JobPanelComposition;
  previousBuild?: JobPreviousBuild;
}
export interface ReviewFrameSet { animation: string; fps: number; written: number; stride: number; duration: number }
export interface ReviewFrames { path: string; sha256: string; sets: ReviewFrameSet[] }
export interface ReviewedSource { readonly packageRevision:string; readonly viewerVersion:string; readonly runtimeVersion:string; readonly rig:{readonly path:string;readonly sha256:string}|null; readonly motion:{readonly path:string;readonly sha256:string}|null; readonly handoff?:HandoffRecord }
export interface ReviewPackage { scene?:SceneInspection; direction?:DirectionInspection; setsHash?:string; referenceHashes?:Record<string,string>; root: string; manifestPath: string; manifest: ReviewManifest; sourceHash: string; reviewedSource:ReviewedSource; files: Set<string>; report:ReportSeeds|null; frames:ReviewFrames|null; feedbackCatalog:FeedbackCatalog;
  /** The resolved producer handoff (#101) and, when there is none, the refusal line naming where it was looked for. */
  handoff: Handoff|null; handoffReason: string|null; handoffInputs?: HandoffFlags;
  /** #187: the rig-parts build root ({@link isBuildRoot}) whose `check/` this package is, however it was opened; review state stays outside it. */
  buildRoot?: string;
  /** #305: viewer-only open (`--view-only`). */
  viewOnly?: boolean;
  /** Logical working directory passed at load/open time for resolving an external producer (`options.cwd`). */
  cwd?: string;
  /** Explicit producer lookup roots, retained for source revalidation. */
  handoffStarts?: readonly string[];
  /** Launcher-validated original package root when opening a retained pair. */
  originalProducerRoot?: string;
  /** Live-job publication selector retained for source revalidation. */
  selector?: JobSelector | null;
  /** #329: the handoff's source painting, served at a fixed route by its pinned hash; absent when the handoff knows none. */
  sourcePainting?: SourcePainting }
export function reviewProducerStarts(p: ReviewPackage, cwd = process.cwd()): string[] {
  return [p.originalProducerRoot ?? p.root, cwd];
}
function fail(field: string, expected: string): never { throw new Error(`${field}: expected ${expected}`); }
export function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'object'); return value as Record<string, unknown>; }
export function string(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 10000) fail(field, 'nonempty string (at most 10000 characters)'); return value; }
function id(value: unknown, field: string): string { const s = string(value, field); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(s)) fail(field, 'identifier [A-Za-z0-9][A-Za-z0-9._-], at most 128 characters'); return s; }
export function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T { if (!choices.includes(value as T)) fail(field, choices.join(' | ')); return value as T; }
function number(value: unknown, field: string, min = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min) fail(field, `finite number >= ${min}`); return value; }
export { number as numberField };
function optionalString(value: unknown, field: string): string | undefined { return value === undefined ? undefined : string(value, field); }
function optionalNumber(value: unknown, field: string): number | undefined { return value === undefined ? undefined : number(value, field); }
function list<T>(value: unknown, field: string, parse: (v: Record<string, unknown>, field: string) => T): T[] {
  if (value === undefined) return []; if (!Array.isArray(value) || value.length > 10000) fail(field, 'array of at most 10000 entries');
  const result = value.map((v, i) => parse(object(v, `${field}[${i}]`), `${field}[${i}]`));
  const ids = result.filter((v): v is T & { id: string } => !!v && typeof v === 'object' && 'id' in v);
  if (new Set(ids.map(v => v.id)).size !== ids.length) fail(field, 'unique ids'); return result;
}
/** Manifest paths are literal portable relative paths, never encoded URLs. */
export function packagePath(value: unknown, field = 'path'): string {
  const p = string(value, field);
  if (isAbsolute(p) || /^[a-zA-Z]:/.test(p) || /[:\\%?#\x00-\x1f]/.test(p) || p.split('/').some(s => !s || s === '.' || s === '..') || posix.normalize(p) !== p) fail(field, 'literal relative path inside package; no traversal, encoding, backslash, query or fragment');
  return p;
}
export async function safeFile(root: string, path: string): Promise<string> {
  packagePath(path); const full = await realpath(resolve(root, path)); const rel = relative(root, full);
  if (!rel || rel.startsWith('..' + '/') || rel === '..' || isAbsolute(rel)) fail(path, 'file inside package (symlinks may not escape)');
  if (!(await stat(full)).isFile()) fail(path, 'regular file'); return full;
}
const previousBuildInvalid = 'JOB_PREVIOUS_BUILD_INVALID';
export const previousBuildByteLimit = 64 * 1024 * 1024;
const previousBuildPageLimit = 64;
const previousBuildTextLimit = 128;
const previousBuildMapLimit = 256;
const previousBuildDeclarationLimit = 64 * 1024;

export function previousBuildLimit(bound: string, found: number, limit: number, path?: string): JobError {
  return new JobError(previousBuildInvalid, `${previousBuildInvalid}: ${bound} found=${found} limit=${limit}` +
    (path === undefined ? '' : ` path=${JSON.stringify(path)}`));
}

export function previousBuildFileError(path: string, reason: string): JobError {
  return new JobError(previousBuildInvalid, `${previousBuildInvalid}: ${reason} path=${JSON.stringify(path)}`);
}

function previousBuildText(field: string, value: unknown): string {
  if (typeof value !== 'string') throw new JobError(previousBuildInvalid);
  const size = Buffer.byteLength(value);
  if (size > previousBuildTextLimit) throw previousBuildLimit(field + ' UTF-8 bytes', size, previousBuildTextLimit);
  if (!value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new JobError(previousBuildInvalid);
  return value;
}

function previousBuildFile(field: string, value: unknown): JobFileIdentity {
  if (value && typeof value === 'object' && 'path' in value &&
      typeof value.path === 'string' && value.path.length > jobPathTextLimit)
    throw previousBuildLimit(field + '.path code units', value.path.length, jobPathTextLimit);
  try { return parseFileRow(value, previousBuildInvalid); }
  catch { throw new JobError(previousBuildInvalid, `${previousBuildInvalid}: ${field} requires a literal package-relative path and SHA-256`); }
}

export function previousBuildFiles(build: JobPreviousBuild): readonly JobFileIdentity[] {
  return [build.model, build.atlas, ...build.pages];
}

export function parsePreviousBuild(raw: unknown): JobPreviousBuild {
  const item = exactObject(raw, ['schema', 'label', 'currentLabel', 'model', 'atlas', 'pages', 'clipMap'], previousBuildInvalid);
  if (item.schema !== JOB_PREVIOUS_BUILD_SCHEMA || !Array.isArray(item.pages)) throw new JobError(previousBuildInvalid);
  if (item.pages.length > previousBuildPageLimit) throw previousBuildLimit('pages count', item.pages.length, previousBuildPageLimit);
  const map = item.clipMap;
  if (!map || typeof map !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(map)))
    throw new JobError(previousBuildInvalid);
  const clips = Object.entries(map);
  if (clips.length > previousBuildMapLimit) throw previousBuildLimit('clipMap entries', clips.length, previousBuildMapLimit);
  const build: JobPreviousBuild = {
    schema: JOB_PREVIOUS_BUILD_SCHEMA,
    label: previousBuildText('label', item.label),
    currentLabel: previousBuildText('currentLabel', item.currentLabel),
    model: previousBuildFile('model', item.model),
    atlas: previousBuildFile('atlas', item.atlas),
    pages: Array.from(item.pages, (page, index) => previousBuildFile(`pages[${index}]`, page)),
    clipMap: Object.fromEntries(clips.map(([current, previous]) =>
      [previousBuildText('clipMap key', current), previousBuildText('clipMap value', previous)])),
  };
  const size = Buffer.byteLength(JSON.stringify(build));
  if (size > previousBuildDeclarationLimit) throw previousBuildLimit('declaration bytes', size, previousBuildDeclarationLimit);
  if (!build.model.path.endsWith('.model.json')) throw previousBuildFileError(build.model.path, 'expected compiled model');
  if (!build.atlas.path.endsWith('.atlas')) throw previousBuildFileError(build.atlas.path, 'expected atlas');
  const invalidPage = build.pages.find(page => !/\.(png|jpe?g|webp)$/i.test(page.path));
  if (invalidPage) throw previousBuildFileError(invalidPage.path, 'expected page image');
  const paths = new Set<string>();
  for (const file of previousBuildFiles(build)) {
    if (paths.has(file.path)) throw previousBuildFileError(file.path, 'duplicate asset');
    paths.add(file.path);
  }
  return build;
}

export function readPreviousBuildFile(root: string, file: {path: string; sha256: string | null}, bytesRead?: number): Buffer {
  return readCheckpointEvidenceBytes(root, file, previousBuildByteLimit - (bytesRead ?? 0), (failure, size) => {
    if (failure === 'limit') {
      const bound = bytesRead === undefined ? 'asset bytes' : 'closure bytes through asset';
      return previousBuildLimit(bound, (bytesRead ?? 0) + size, previousBuildByteLimit, file.path);
    }
    return previousBuildFileError(file.path, failure === 'hash' ? 'hash mismatch' : 'asset unavailable or outside package');
  });
}

function modelPagePaths(modelPath: string, model: Record<string, unknown>, sealedPlayback = false): string[] {
  if (model.spec !== 'rigc-compiled/3') fail('model.spec', 'rigc-compiled/3, produced by a gated rigc build');
  if (!Array.isArray(model.pages)) fail('model.pages', 'array');
  return model.pages.map(page => {
    const name = string(object(page, 'model.pages[]').name, 'model.pages[].name');
    if(isAbsolute(name)||/[:\\%?#\x00-\x1f]/.test(name)||name.split('/').some(v=>!v))fail('model.pages[].name','literal relative model page path');
    if(sealedPlayback&&!/\.(png|jpe?g|webp)$/i.test(packagePath(name,'model.pages[].name')))fail('model.pages[].name','literal build page image');
    return packagePath(posix.join(posix.dirname(modelPath), name), 'model page resolved inside package');
  });
}

function previousModelPages(path: string, bytes: Buffer, strict = false): string[] {
  try {
    const model = object(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), 'previousBuild.model');
    if (Array.isArray(model.pages) && model.pages.length > previousBuildPageLimit)
      throw previousBuildLimit('model pages count', model.pages.length, previousBuildPageLimit, path);
    if (strict && Array.isArray(model.pages)) for (const page of model.pages) {
      const name=object(page,'model.pages[]').name;
      if (typeof name==='string' && name.length>jobPathTextLimit)
        throw previousBuildLimit('page path code units',name.length,jobPathTextLimit,path);
    }
    const paths = modelPagePaths(path, model, strict);
    const modelUrl = new URL(path.split('/').map(encodeURIComponent).join('/'), 'http://127.0.0.1/');
    const runtimePaths = (model.pages as {name: string}[])
      .map(page => decodeURIComponent(new URL(page.name, modelUrl).pathname.slice(1)));
    if (new Set(paths).size !== paths.length || paths.some((page, index) => runtimePaths[index] !== page))
      throw previousBuildFileError(path, 'runtime pages differ from declared closure');
    return paths;
  } catch (error) {
    if (error instanceof JobError && error.code === previousBuildInvalid) throw error;
    throw previousBuildFileError(path, 'invalid compiled model or runtime page');
  }
}

export function admitPreviousBuild(root: string, build: JobPreviousBuild): void {
  let bytesRead = 0;
  const read = (file: JobFileIdentity) => {
    const bytes = readPreviousBuildFile(root, file, bytesRead);
    bytesRead += bytes.length;
    return bytes;
  };
  const paths = previousModelPages(build.model.path, read(build.model));
  if (paths.length !== build.pages.length || build.pages.some(page => !paths.includes(page.path)))
    throw previousBuildFileError(build.model.path, 'runtime pages differ from declared closure');
  read(build.atlas);
  for (const page of build.pages) read(page);
}

export function parseManifest(input: unknown): ReviewManifest {
  return parseReviewManifest(input,packagePath);
}

function parseSceneReportPointer(value: unknown, parsePath: typeof packagePath): JobFileIdentity {
  const code = 'SCENE_SOURCE_MISMATCH';
  const pointer = exactObject(value, ['path', 'sha256'], code);
  try {
    return {path: parsePath(pointer.path, 'sceneReport.path'), sha256: jobSha(pointer.sha256)};
  } catch {
    throw new JobError(code, `${code}: invalid sceneReport path or SHA-256`);
  }
}

function admitSceneReportSpec(bytes: Buffer, path: string): void {
  const invalid = new JobError('SCENE_CAMERA_REPORT_INVALID', `SCENE_CAMERA_REPORT_INVALID: ${path}`);
  let spec: unknown;
  try { spec = object(JSON.parse(bytes.toString('utf8')), 'sceneReport').spec; }
  catch { throw invalid; }
  // Slice A only recognizes the version. Play owns camera schema, byte limit and clock validation.
  if (spec === 'spine-parts-scene-report/2')
    throw new JobError('SCENE_CAMERA_UNAVAILABLE', `SCENE_CAMERA_UNAVAILABLE: ${path}`);
  if (spec !== 'spine-parts-scene-report/1') throw invalid;
}

function parseReviewManifest(input: unknown, parsePath: typeof packagePath): ReviewManifest {
  const m = object(input, 'review'); if (m.schema !== 'rig-review/1') fail('schema', 'rig-review/1');
  const audio = m.audio === undefined ? {} : object(m.audio, 'audio');
  let panels: JobPanelComposition | undefined;
  if (m.panels !== undefined) {
    try { panels = parsePanelComposition(m.panels); }
    catch { panels = undefined; }
  }
  const manifest: ReviewManifest = {
    schema: 'rig-review/1', id: id(m.id, 'id'), title: string(m.title, 'title'), revision: string(m.revision, 'revision'),
    model: m.model === undefined ? undefined : parsePath(m.model, 'model'),
    ...(Object.hasOwn(m, 'sceneReport') ? {sceneReport: parseSceneReportPointer(m.sceneReport, parsePath)} : {}),
    ...(Object.hasOwn(m, 'previousBuild') ? {previousBuild: parsePreviousBuild(m.previousBuild)} : {}),
    ...(m.frames===undefined?{}:{frames:parsePath(m.frames,'frames')}),
    ...(m.direction===undefined?{}:{direction:parsePath(m.direction,'direction')}),
    ...(m.scene===undefined?{}:{scene:parsePath(m.scene,'scene')}),
    ...(m.sets===undefined?{}:{sets:parsePath(m.sets,'sets')}),
    motion:m.motion===undefined?undefined:parsePath(m.motion,'motion'),
    references: list(m.references, 'references', (v,f) => ({ id:id(v.id,f+'.id'), label:string(v.label,f+'.label'), type:choice(v.type,['image','video','pose'],f+'.type'), path:parsePath(v.path,f+'.path'), width:v.width===undefined?undefined:number(v.width,f+'.width',Number.EPSILON), height:v.height===undefined?undefined:number(v.height,f+'.height',Number.EPSILON) })),
    animations: list(m.animations,'animations',(v,f) => ({id:id(v.id,f+'.id'),label:optionalString(v.label,f+'.label'),duration:optionalNumber(v.duration,f+'.duration')})),
    checkpoints: list(m.checkpoints,'checkpoints',(v,f) => ({id:id(v.id,f+'.id'),title:string(v.title,f+'.title'),time:optionalNumber(v.time,f+'.time'),animation:optionalString(v.animation,f+'.animation'),reference:optionalString(v.reference,f+'.reference'),note:optionalString(v.note,f+'.note'),workspace:v.workspace === undefined ? undefined : choice(v.workspace,['modeling','motion'] as const,f+'.workspace'),axis:v.axis===undefined?undefined:(()=>{const a=object(v.axis,f+'.axis');return {id:id(a.id,f+'.axis.id'),value:number(a.value,f+'.axis.value',-Number.MAX_VALUE)};})(),camera:v.camera === undefined ? undefined : (() => {const c=object(v.camera,f+'.camera'); const zoom=number(c.zoom,f+'.camera.zoom',Number.EPSILON); return {zoom,x:number(c.x,f+'.camera.x',-Number.MAX_VALUE),y:number(c.y,f+'.camera.y',-Number.MAX_VALUE)};})()})),
    authoring:list(m.authoring,'authoring',(v,f)=>({label:string(v.label,f+'.label'),path:parsePath(v.path,f+'.path')})),
    axes:list(m.axes,'axes',(v,f)=>({id:id(v.id,f+'.id'),label:string(v.label,f+'.label'),animation:string(v.animation,f+'.animation'),min:number(v.min,f+'.min',-Number.MAX_VALUE),max:number(v.max,f+'.max',-Number.MAX_VALUE)})),
    ...(m.producer===undefined?{}:{producer:parseHandoffDeclaration(m.producer)}),
    ...(panels===undefined?{}:{panels}),
    audio:{clips:list(audio.clips,'audio.clips',(v,f)=>({id:id(v.id,f+'.id'),label:optionalString(v.label,f+'.label'),path:parsePath(v.path,f+'.path')})),cues:list(audio.cues,'audio.cues',(v,f)=>({id:id(v.id,f+'.id'),clip:string(v.clip,f+'.clip'),time:number(v.time,f+'.time'),animation:optionalString(v.animation,f+'.animation')}))}
  };
  if(manifest.model&&!manifest.model.endsWith('.model.json'))fail('model','compiled model path ending .model.json (the play runtime input)');
  if (manifest.sceneReport && !manifest.model)
    throw new JobError('SCENE_CAMERA_MODEL_MISMATCH', 'SCENE_CAMERA_MODEL_MISMATCH: sceneReport requires model');
  if (manifest.previousBuild && !manifest.model) throw new JobError(previousBuildInvalid);
  if(manifest.sets&&!manifest.model)fail('sets','compiled model declaration');
  if(manifest.scene&&!manifest.direction)throw new Error('SCENE_REQUIRED: scene requires direction');
  if(manifest.direction&&!manifest.model)fail('direction','compiled model declaration');
  for (const c of manifest.checkpoints) { if(c.reference && !manifest.references.some(r=>r.id===c.reference)) fail(`checkpoint ${c.id}.reference`,'declared reference id'); if(c.animation && !manifest.animations.some(a=>a.id===c.animation)) fail(`checkpoint ${c.id}.animation`,'declared animation id'); }
  for (const c of manifest.audio.cues) { if(!manifest.audio.clips.some(a=>a.id===c.clip)) fail(`cue ${c.id}.clip`,'declared audio clip id'); if(c.animation && !manifest.animations.some(a=>a.id===c.animation)) fail(`cue ${c.id}.animation`,'declared animation id'); }
  for (const a of manifest.axes) { if(a.min >= a.max) fail(`axis ${a.id}`,'min < max'); if(!manifest.animations.some(v=>v.id===a.animation)) fail(`axis ${a.id}.animation`,'declared animation id'); }
  for(const c of manifest.checkpoints) if(c.axis){const a=manifest.axes.find(a=>a.id===c.axis!.id);if(!a)fail(`checkpoint ${c.id}.axis`,'declared axis id');if(c.axis.value<a.min||c.axis.value>a.max)fail(`checkpoint ${c.id}.axis.value`,`number in [${a.min}, ${a.max}]`);}
  return manifest;
}
function parseFrames(text: string, path: string, sha256: string): ReviewFrames {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`FRAMES_JSON: ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`FRAMES_FIELD: ${path}: expected object`);
  const doc = raw as Record<string, unknown>;
  if (doc.spec !== 'rigc-frames/1') throw new Error(`FRAMES_SPEC: ${path}.spec: expected rigc-frames/1`);
  if (!Array.isArray(doc.sets) || doc.sets.length > 10000) throw new Error(`FRAMES_FIELD: ${path}.sets: expected array of at most 10000 entries`);
  const seen = new Set<string>();
  const sets = doc.sets.map((entry, i): ReviewFrameSet => {
    const f = `${path}.sets[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`FRAMES_FIELD: ${f}: expected object`);
    const s = entry as Record<string, unknown>;
    if (typeof s.animation !== 'string' || !s.animation.trim() || s.animation.length > 10000) throw new Error(`FRAMES_FIELD: ${f}.animation: expected nonempty string`);
    if (seen.has(s.animation)) throw new Error(`FRAMES_DUPLICATE_ANIMATION: ${f}.animation: duplicate animation ${JSON.stringify(s.animation)}`);
    seen.add(s.animation);
    if (typeof s.fps !== 'number' || !Number.isSafeInteger(s.fps) || s.fps <= 0) throw new Error(`FRAMES_FIELD: ${f}.fps: expected integer > 0`);
    if (typeof s.written !== 'number' || !Number.isSafeInteger(s.written) || s.written < 0) throw new Error(`FRAMES_FIELD: ${f}.written: expected integer >= 0`);
    if (typeof s.stride !== 'number' || !Number.isSafeInteger(s.stride) || s.stride <= 0) throw new Error(`FRAMES_FIELD: ${f}.stride: expected integer > 0`);
    if (typeof s.duration !== 'number' || !Number.isFinite(s.duration) || s.duration < 0) throw new Error(`FRAMES_FIELD: ${f}.duration: expected finite number >= 0`);
    return { animation: s.animation, fps: s.fps, written: s.written, stride: s.stride, duration: s.duration };
  });
  return { path, sha256, sets };
}
/** Seconds a set's `duration` may differ from the producer's last sample time: float rounding only (#1018). */
export const FRAMES_DURATION_TOLERANCE = 1e-9;
/**
 * #1018: one clock per set of the declared record, each checked against the compiled model's animation before it
 * indexes anything. The producer samples an animation of duration D at fps to round(D * fps) + 1 frames, frame i at
 * i / fps, writes every stride-th one from frame 0, and records the last sample's time as `duration`; a set that is
 * not that schedule for the model's animation is refused by name. An animation the report's clock names keeps the
 * report's clock, so its set adds none. A package without a compiled model plays nothing, so its record adds no clock.
 */
function declaredFrameClocks(frames: ReviewFrames, animations: {name: string; duration: number}[], report: ReportSeeds | null): DeclaredFrameClock[] {
  return frames.sets.flatMap(set => {
    const where = `${frames.path}: set ${JSON.stringify(set.animation)}`;
    const clip = animations.find(value => value.name === set.animation);
    if (!clip) throw new Error(`FRAMES_ANIMATION_UNKNOWN: ${where} names no animation of the compiled model`);
    const last = Math.round(clip.duration * set.fps), written = Math.floor(last / set.stride) + 1;
    if (set.written !== written) throw new Error(`FRAMES_COUNT_MISMATCH: ${where} writes ${set.written} frame(s) at ${set.fps} fps stride ${set.stride}; the model's ${clip.duration} s animation samples to ${written}`);
    if (Math.abs(set.duration - last / set.fps) > FRAMES_DURATION_TOLERANCE) throw new Error(`FRAMES_DURATION_MISMATCH: ${where} lasts ${set.duration} s; the model's ${clip.duration} s animation at ${set.fps} fps ends its last sample at ${last / set.fps} s`);
    return report?.clock && report.animation === set.animation ? [] : [{animation: set.animation, clock: framesSetClock(set)}];
  });
}
export const BUILD_MODEL_PATH = 'build/skeleton.model.json';
export interface PreviousOpenSource {
  rawManifest: Record<string, unknown> | ReviewManifest;
  files: ReadonlyMap<string, string>;
  playback: {model: JobFileIdentity; atlas: JobFileIdentity; pages: JobFileIdentity[]};
}

function previousOpenPath(path: unknown, field = 'path'): string {
  if (typeof path !== 'string') throw new JobError(previousBuildInvalid,`${previousBuildInvalid}: ${field} requires a path`);
  if (path.length > jobPathTextLimit) throw previousBuildLimit('path code units', path.length, jobPathTextLimit, path);
  try { return jobPath(path); }
  catch { throw previousBuildFileError(path, 'expected a literal package-relative path'); }
}

function previousOpenFile(root: string, path: string): string {
  previousOpenPath(path);
  try { return checkedPath(root, path); }
  catch { throw previousBuildFileError(path, 'asset unavailable or outside package (symlinks refused)'); }
}

async function previousOpenAtlas(root: string, model: string, side: 'current' | 'previous', explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    previousOpenPath(explicit);
    if (!explicit.endsWith('.atlas')) throw previousBuildFileError(explicit, 'expected atlas');
    return explicit;
  }
  const directory = posix.dirname(model);
  const candidates = (await readdir(resolve(root, directory),{withFileTypes:true}))
    .filter(entry => entry.isFile() && entry.name.endsWith('.atlas'))
    .map(entry => posix.join(directory, entry.name)).sort();
  if (candidates.length !== 1)
    throw new Error(`OPEN_PREVIOUS_ATLAS_AMBIGUOUS --${side}-atlas: expected one atlas beside ${JSON.stringify(model)}; candidates=${JSON.stringify(candidates)}`);
  return previousOpenPath(candidates[0]!);
}

interface ReviewLoadOptions {
  /** Explicit producer flags take precedence over discovery. False disables producer lookup. */
  handoff?: HandoffFlags | false;
  cwd?: string;
  handoffStarts?: readonly string[];
  originalProducerRoot?: string;
  /** Live-job publication selector, forwarded to direction and scene admission. */
  selector?: JobSelector | null;
  /** Load only the adapter's build model and its sealed page images. */
  sealedPlayback?: ReadonlyMap<string, string>;
  /** Standalone pairing retains the loader's exact closure and the original manifest fields. */
  previousOpen?: {side: 'current' | 'previous'; atlas?: string; capture: (source: PreviousOpenSource) => void};
}
export async function loadReview(input: string, options: ReviewLoadOptions = {}): Promise<ReviewPackage> {
  const {sealedPlayback,previousOpen}=options;
  if(previousOpen && (await lstat(resolve(input))).isSymbolicLink())
    throw previousBuildFileError(input, 'symlink input');
  const inputPath=await realpath(resolve(input));const directory=(await stat(inputPath)).isDirectory();
  if(previousOpen && !directory && !(await stat(inputPath)).isFile())
    throw previousBuildFileError(input, 'expected a regular manifest or package directory');
  if(sealedPlayback&&(!directory||options.handoff!==false||inputPath!==resolve(input)))fail('sealed playback','literal folder with handoff disabled');
  if(directory&&!sealedPlayback){
    const namedManifest=resolve(inputPath,'review.json');
    const entry=await (previousOpen?lstat:stat)(namedManifest).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw error;
    });
    if(entry){
      if(previousOpen&&entry.isSymbolicLink())throw previousBuildFileError('review.json','symlink input');
      return loadReview(namedManifest,options);
    }
    // #149: a rig-parts build root without a model of its own opens as its check package, exactly as opening check/ does.
    const check=await buildCheckPackage(inputPath);if(check)return loadReview(check,options);}
  const manifestPath=inputPath;const root=directory?inputPath:await realpath(dirname(inputPath));
  const manifestBytes=directory?null:await readFile(manifestPath);
  let rawManifest: Record<string, unknown> | ReviewManifest;
  try {
    rawManifest=manifestBytes===null
      ? await folderManifest(root,!!sealedPlayback,previousOpen ? path=>previousOpenFile(root,path) : undefined)
      : object(JSON.parse(manifestBytes.toString('utf8')),'review');
  } catch (error) {
    if (previousOpen && error instanceof UnrecognizedOutputError)
      throw new Error(`OPEN_PREVIOUS_MODEL_MISSING ${previousOpen.side}: ${root}`);
    throw error;
  }
  const manifest=directory?rawManifest as ReviewManifest:parseReviewManifest(rawManifest,previousOpen?previousOpenPath:packagePath);
  const adapterManifest=previousOpen&&directory?structuredClone(manifest):undefined;
  if(previousOpen&&!manifest.model)throw new Error(`OPEN_PREVIOUS_MODEL_MISSING ${previousOpen.side}: ${root}`);
  const assetFile=async(path:string):Promise<string>=>{
    if(sealedPlayback&&!sealedPlayback.has(path))fail(path,'sealed playback file');
    const literal=previousOpen?previousOpenFile(root,path):sealedPlayback?checkedPath(root,path):undefined;
    let full:string;
    try{full=await safeFile(root,path);}
    catch(e){if(path===manifest.frames&&['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw new Error(`FRAMES_MISSING: ${path}: ${(e as Error).message}`);throw e;}
    if(literal!==undefined&&full!==literal)fail(path,'file without symlinks');
    return full;
  };
  const files = new Set([...(directory?[]:[relative(root,manifestPath)]),...manifest.references.map(v=>v.path),...manifest.authoring.map(v=>v.path),...manifest.audio.clips.map(v=>v.path)]);
  if(manifest.frames)files.add(manifest.frames);
  if(manifest.direction)files.add(manifest.direction);
  if (manifest.sceneReport) files.add(manifest.sceneReport.path);
  if(manifest.sets)files.add(manifest.sets);
  const rootFile=async(name:string):Promise<string|undefined>=>{try{await safeFile(root,name);return name;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}};
  const authoringPath=(name:string):string|undefined=>{const paths=manifest.authoring.filter(v=>posix.basename(v.path)===name);return paths.length===1?paths[0].path:undefined;};
  const rigPath=manifest.model??await rootFile('skeleton.json')??authoringPath('skeleton.json')??await rootFile('skeleton.skel')??authoringPath('skeleton.skel');
  const motionPath=sealedPlayback?undefined:manifest.motion??await rootFile('motion.json')??authoringPath('motion.json');
  if(rigPath)files.add(rigPath);if(motionPath)files.add(motionPath);
  let modelBytesHash:string|null=null;
  let playback:PreviousOpenSource['playback']|undefined;
  if(manifest.model) {
    files.add(manifest.model);
    if(previousOpen){
      const path=previousOpenPath(manifest.model);
      try {checkedPath(root,path);}
      catch(error){
        if ((error as NodeJS.ErrnoException).code==='ENOENT')
          throw new Error(`OPEN_PREVIOUS_MODEL_MISSING ${previousOpen.side}: ${path}`);
        throw previousBuildFileError(path,'model unavailable or outside package (symlinks refused)');
      }
    }
    const bytes=previousOpen
      ? readPreviousBuildFile(root,{path:previousOpenPath(manifest.model),sha256:null},0)
      : await readFile(await assetFile(manifest.model));
    modelBytesHash=jobHash(bytes);
    if(sealedPlayback&&modelBytesHash!==sealedPlayback.get(manifest.model))fail(manifest.model,'sealed playback hash');
    const pages=previousOpen?previousModelPages(manifest.model,bytes,true)
      :modelPagePaths(manifest.model,object(JSON.parse(bytes.toString('utf8')),'model'),!!sealedPlayback);
    for (const path of pages) files.add(path);
    if(previousOpen){
      const atlasPath=await previousOpenAtlas(root,manifest.model,previousOpen.side,previousOpen.atlas);
      let size=bytes.length;
      const seal=(path:string)=>{
        const data=readPreviousBuildFile(root,{path:previousOpenPath(path),sha256:null},size);
        size+=data.length;
        return {path,sha256:jobHash(data)};
      };
      playback={model:{path:manifest.model,sha256:modelBytesHash},atlas:seal(atlasPath),pages:pages.map(seal)};
    }
  }
  for(const r of manifest.references.filter(r=>r.type==='pose')) {
    const pose=object(JSON.parse(await readFile(await (previousOpen?assetFile(r.path):safeFile(root,r.path)),'utf8')),`pose ${r.id}`);
    if(pose.spec==='rig-pose-sequence/1'){validatePoseSequence(pose,`pose ${r.id}`);continue;}
    if(pose.schema!=='rig-review-pose/1'||pose.coordinateSystem!=='image-pixels-y-down') fail(`pose ${r.id}`,'rig-review-pose/1 with image-pixels-y-down coordinates');
    number(pose.width,`pose ${r.id}.width`,Number.EPSILON); number(pose.height,`pose ${r.id}.height`,Number.EPSILON);
    const joints=list(pose.joints,`pose ${r.id}.joints`,(v,f)=>({id:id(v.id,f+'.id'),x:number(v.x,f+'.x',-Number.MAX_VALUE),y:number(v.y,f+'.y',-Number.MAX_VALUE),parent:optionalString(v.parent,f+'.parent')}));
    for(const j of joints) if(j.parent&&!joints.some(v=>v.id===j.parent&&v.id!==j.id)) fail(`pose ${r.id} joint ${j.id}.parent`,'another declared joint id');
  }
  const reportPath=files.has('report.json')?'report.json':authoringPath('report.json');let report:ReportSeeds|null=null;let frames:ReviewFrames|null=null;let modelMetadata:Record<string,unknown>|null=null;let directionInput:unknown;
  // The handoff files are hashed beside the package: their record joins the reviewed identity (and so the session file).
  const {handoff,reason:handoffReason}=options.handoff===false?{handoff:null,reason:null}:
    await resolveHandoff(root,manifest.producer,options.handoff,{starts:options.handoffStarts??[options.cwd??process.cwd()],originalProducerRoot:options.originalProducerRoot});
  // #329: the source painting the handoff knows is the first reference, outside the package's own files.
  const painting=sourcePainting(manifest,handoff,directory);
  const current=options.selector?.kind==='current';
  let scene:SceneInspection|undefined;
  const sceneBytes=new Map<string,Buffer>();
  if(manifest.scene){
    if(current)throw new Error('SCENE_SOURCE_MISMATCH: '+manifest.scene);
    const sceneFile=previousOpen?await assetFile(manifest.scene):undefined;
    let bytes:Buffer;try{bytes=await readFile(sceneFile??await safeFile(root,manifest.scene));}catch{throw new Error('SCENE_REQUIRED: '+manifest.scene);}
    if(bytes.length>DIRECTION_MAX_BYTES)throw new Error('SCENE_SOURCE_MISMATCH: '+manifest.scene);
    const dirBytes=await readFile(await (previousOpen?assetFile(manifest.direction!):safeFile(root,manifest.direction!)));
    const direction=readDirectionInspection(JSON.parse(dirBytes.toString()),{path:manifest.direction!,sha256:createHash('sha256').update(dirBytes).digest('hex')},{path:manifest.model!,sha256:modelBytesHash!});
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(direction.scene?.path!==manifest.scene||direction.scene.sha256!==sha256)throw new Error('SCENE_SOURCE_MISMATCH: '+manifest.scene);
    const model=object(JSON.parse((await readFile(await safeFile(root,manifest.model!))).toString()),'model');
    let sceneInput:unknown;try{sceneInput=JSON.parse(bytes.toString());}catch{throw new Error('SCENE_SOURCE_MISMATCH: '+manifest.scene);}
    scene=readSceneInspection(sceneInput,{path:manifest.scene,sha256},direction,model);
    sceneBytes.set(manifest.scene,bytes);sceneBytes.set(manifest.direction!,dirBytes);
    for(const [path,bytes] of await scenePlateBytes(root,scene))sceneBytes.set(path,bytes);
    for(const path of sceneBytes.keys())files.add(path);
  }
  if (manifest.previousBuild) admitPreviousBuild(root, manifest.previousBuild);
  const hash = createHash('sha256');hash.update(JSON.stringify(manifest));hash.update('\0');const fileHashes=new Map<string,string>();
  for (const p of [...files].sort()) {
    const sceneReport = manifest.sceneReport?.path === p ? manifest.sceneReport : undefined;
    const fileHash = createHash('sha256');
    const metadataChunks: Buffer[] = [];
    const isDirection = p === manifest.direction;
    let bytesRead = 0;
    try {
      const full = await assetFile(p);
      const before = await stat(full);
      hash.update(p).update('\0').update(String(before.size)).update('\0');
      if (isDirection && before.size > DIRECTION_MAX_BYTES) throw new Error('DIRECTION_SIZE: direction exceeds 256 KiB');
      for await (const chunk of createReadStream(full)) {
        hash.update(chunk);
        fileHash.update(chunk);
        if (isDirection && (bytesRead += chunk.length) > DIRECTION_MAX_BYTES) throw new Error('DIRECTION_SIZE: direction exceeds 256 KiB');
        if (p === reportPath || p === manifest.model || isDirection || p === manifest.frames || sceneReport) metadataChunks.push(chunk);
      }
      const after = await stat(full);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error(`Asset ${p} changed while hashing; retry with stable package inputs`);
    } catch (error) {
      if (!sceneReport) throw error;
      const missing = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '');
      const code = missing ? 'SCENE_REQUIRED' : 'SCENE_SOURCE_MISMATCH';
      throw new JobError(code, `${code}: ${p}`);
    }
    fileHashes.set(p, fileHash.digest('hex'));
    if (sceneBytes.has(p) && createHash('sha256').update(sceneBytes.get(p)!).digest('hex') !== fileHashes.get(p))
      throw new Error('SCENE_SOURCE_MISMATCH: ' + p);
    if (sceneReport && fileHashes.get(p) !== sceneReport.sha256)
      throw new JobError('SCENE_SOURCE_MISMATCH', `SCENE_SOURCE_MISMATCH: ${p}`);
    if(sealedPlayback&&fileHashes.get(p)!==sealedPlayback.get(p))fail(p,'sealed playback hash');
    // The parser and package hash consume the same bytes, never two file reads.
    if (sceneReport) admitSceneReportSpec(Buffer.concat(metadataChunks), p);
    if(p===manifest.model){if(fileHashes.get(p)!==modelBytesHash)throw new Error(`Model ${p} changed while hashing; retry with stable package inputs`);modelMetadata=object(JSON.parse(Buffer.concat(metadataChunks).toString('utf8')),'model');}
    if(isDirection)directionInput=JSON.parse(Buffer.concat(metadataChunks).toString('utf8'));
    if(p===reportPath){let value:unknown;try{value=JSON.parse(Buffer.concat(metadataChunks).toString('utf8'));}catch(e){throw new Error(`${p}: ${e instanceof Error?e.message:String(e)}`);}report=parseReport(value,p);}
    if(p===manifest.frames)frames=parseFrames(Buffer.concat(metadataChunks).toString('utf8'),p,fileHashes.get(p)!);
  }
  if(painting){hash.update(SOURCE_PAINTING_ID);hash.update('\0');hash.update(painting.sha256);hash.update('\0');}
  // #192: the root is `check/` whether the folder or its review.json was opened, so the build root is kept either way.
  const buildRoot=!sealedPlayback&&basename(root)==='check'&&await isBuildRoot(dirname(root))?dirname(root):undefined;
  const reviewedSource:ReviewedSource={packageRevision:manifest.revision,...await toolVersions(),rig:rigPath?{path:rigPath,sha256:fileHashes.get(rigPath)!}:null,motion:motionPath?{path:motionPath,sha256:fileHashes.get(motionPath)!}:null,...(handoff?{handoff:handoff.record}:{})};
  const direction=manifest.direction?readDirectionInspection(directionInput,{path:manifest.direction,sha256:fileHashes.get(manifest.direction)!},reviewedSource.rig,current?{current:true}:undefined):undefined;
  const animations=modelAnimations(modelMetadata);
  if(previousOpen&&playback){
    if(manifestBytes&&fileHashes.get(relative(root,manifestPath))!==jobHash(manifestBytes))
      throw previousBuildFileError(manifestPath,'manifest changed during load');
    const add=({path,sha256}:JobFileIdentity)=>{
      if(fileHashes.has(path)&&fileHashes.get(path)!==sha256)throw previousBuildFileError(path,'asset changed during load');
      previousOpenFile(root,path);
      fileHashes.set(path,sha256);
    };
    for(const file of [playback.model,playback.atlas,...playback.pages,...(manifest.previousBuild?previousBuildFiles(manifest.previousBuild):[])])add(file);
    if(handoff?.root===root)for(const file of handoff.record.files)add(file);
    previousOpen.capture({rawManifest:adapterManifest??rawManifest,files:fileHashes,playback});
  }
  const feedbackCatalog:FeedbackCatalog={rig:manifest.id,bones:modelNames(modelMetadata,'bones'),slots:modelNames(modelMetadata,'slots'),animations,clock:report?.clock??null,clockAnimation:report?.animation??null,...(frames&&animations?{frameClocks:declaredFrameClocks(frames,animations,report)}:{}),...(discoverTurnDials(modelMetadata).length?{turnDials:discoverTurnDials(modelMetadata)}:{})};
  return {...(scene?{scene}:{}),...(direction?{direction}:{}),...(manifest.sets?{setsHash:fileHashes.get(manifest.sets)!}:{}),referenceHashes:Object.fromEntries(manifest.references.map(r=>[r.id,r.id===painting?.id?painting.sha256:fileHashes.get(r.path)!])),root,manifestPath,manifest,sourceHash:hash.digest('hex'),reviewedSource,files,report,frames,feedbackCatalog,handoff,handoffReason,...(handoff?.flags?{handoffInputs:handoff.flags}:{}),...(buildRoot?{buildRoot}:{}),...(painting?{sourcePainting:painting}:{}),...(options.cwd?{cwd:options.cwd}:{}),...(options.handoffStarts?{handoffStarts:options.handoffStarts}:{}),...(options.originalProducerRoot?{originalProducerRoot:options.originalProducerRoot}:{}),...(options.selector!==undefined?{selector:options.selector}:{})};
}

/** #329: the reference id and served path of the handoff's source painting; the path is a name, never a package file. */
export const SOURCE_PAINTING_ID='source-painting';
export const SOURCE_PAINTING_PATH='__review_source_painting__.png';
export interface SourcePainting {id:string;path:string;sha256:string}
/**
 * #329: when the handoff knows the source painting (declared `source`, or `painting.png` beside a discovered config),
 * it becomes the first reference, labelled as the original, and — for the folder adapter, whose checkpoints are one per
 * reference — the first checkpoint, so it is the reference selected on open. The manifest is changed in place before it
 * is hashed; with no painting nothing is added. `path` is the handoff record's own display path.
 */
function sourcePainting(manifest:ReviewManifest,handoff:Handoff|null,folder:boolean):SourcePainting|null{
  const record=handoff?.record.source;if(!record)return null;
  if(manifest.references.some(r=>r.id===SOURCE_PAINTING_ID)||manifest.checkpoints.some(c=>c.id===SOURCE_PAINTING_ID))fail(`references ${SOURCE_PAINTING_ID}`,'an id the handoff source painting does not take');
  const reference:Reference={id:SOURCE_PAINTING_ID,label:'Original painting · '+posix.basename(record.path),type:'image',path:SOURCE_PAINTING_PATH};
  manifest.references.unshift(reference);
  if(folder)manifest.checkpoints.unshift({id:reference.id,title:'Inspect '+reference.label,reference:reference.id,workspace:'motion'});
  return {id:reference.id,path:record.path,sha256:record.sha256};
}
/** Job lookup is fixed to its designation and this Review install, never the operator's shell. */
export function loadJobReview(input: string, root: string, selector?: JobSelector | null): Promise<ReviewPackage> {
  return loadReview(input, {cwd: root, handoffStarts: [root, fileURLToPath(new URL('..', import.meta.url))], ...(selector !== undefined ? {selector} : {})});
}

/**
 * #149: the `check/` package of a rig-parts build root ({@link isBuildRoot}), when the folder has neither of the two
 * adapter model paths itself (a folder that does keeps opening as before). Fixed names, no search.
 */
export async function buildCheckPackage(dir:string):Promise<string|null>{
  for(const candidate of ['skeleton.model.json',BUILD_MODEL_PATH]){try{await lstat(resolve(dir,candidate));return null;}catch(e){if(!['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
  return await isBuildRoot(dir)?resolve(dir,'check'):null;
}
/** Same text for every command; `root` lets the open launcher name the refused input. */
export class UnrecognizedOutputError extends Error {
  constructor(readonly root:string){super('Output folder: no recognized skeleton.*, build/skeleton.model.json, rig-parts build root (check/build/skeleton.model.json), motion.json, report.json, source video, pose sequence or contact strip');}
}
/** An adapter over an existing output directory; never writes a manifest there. */
async function folderManifest(root:string,playbackOnly=false,strictFile?:(path:string)=>string):Promise<ReviewManifest>{
  const entries=(await readdir(root,{withFileTypes:true})).filter(v=>v.isFile()||v.isSymbolicLink()).map(v=>v.name).sort();
  if(playbackOnly&&entries.length)fail('output folder','build playback without top-level files');
  const has=(name:string)=>entries.includes(name);const references:Reference[]=[];
  // Sealed playback validates the fixed model through assetFile before any lookup.
  let model:string|undefined=playbackOnly?BUILD_MODEL_PATH:undefined;
  // These are named layouts, not a recursive search. Check existence separately
  // so an existing broken symlink is refused rather than treated as absent.
  for(const candidate of playbackOnly?[]:['skeleton.model.json',BUILD_MODEL_PATH]){
    try{await lstat(resolve(root,candidate));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
    if(strictFile)strictFile(candidate);else await safeFile(root,candidate);model=candidate;break;
  }
  for(const name of entries){
    if(/\.(mp4|webm|mov)$/i.test(name))references.push({id:`video-${references.length+1}`,label:name,type:'video',path:name});
    if(/(strip|contact|sheet|띠|filmstrip)/i.test(name)&&/\.(png|jpe?g|webp|svg)$/i.test(name))references.push({id:`strip-${references.length+1}`,label:name,type:'image',path:name});
    if(/pose/i.test(name)&&/\.json$/i.test(name)){const value=JSON.parse(await readFile(strictFile?strictFile(name):await safeFile(root,name),'utf8'));if(value?.spec==='rig-pose-sequence/1'||value?.schema==='rig-review-pose/1')references.push({id:`pose-${references.length+1}`,label:name,type:'pose',path:name});}
  }
  const name=basename(root);const packageId=name.replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^[^a-zA-Z0-9]+/,'').slice(0,128)||'output-bundle';
  const authoring=entries.filter(n=>n==='motion.json'||n==='report.json'||(/^skeleton\./i.test(n)&&n!=='skeleton.model.json')).map(path=>({label:path+' · read only',path}));
  if(!references.length&&!authoring.length&&!model)throw new UnrecognizedOutputError(root);
  return parseManifest({schema:'rig-review/1',id:packageId,title:name,revision:'folder-adapter/1',model,motion:has('motion.json')?'motion.json':undefined,references,authoring,checkpoints:references.map(r=>({id:r.id,title:'Inspect '+r.label,reference:r.id,workspace:'motion'}))});
}

/** Exact hashed model bytes supply names; absent metadata stays unavailable. */
function modelNames(model:Record<string,unknown>|null,field:'bones'|'slots'):string[]|null {
  if(model===null||model[field]===undefined)return null;
  const entries=model[field];if(!Array.isArray(entries))fail(`model.${field}`,'array');
  const names=entries.map((value,i)=>string(object(value,`model.${field}[${i}]`).name,`model.${field}[${i}].name`));
  if(new Set(names).size!==names.length)fail(`model.${field}`,'unique names');return names;
}
function modelAnimations(model:Record<string,unknown>|null):FeedbackCatalog['animations'] {
  if(model===null||model.animations===undefined)return null;
  if(!Array.isArray(model.animations))fail('model.animations','array');
  const animations=model.animations.map((value,i)=>{const v=object(value,`model.animations[${i}]`);return {name:string(v.name,`model.animations[${i}].name`),duration:number(v.duration,`model.animations[${i}].duration`)};});
  if(new Set(animations.map(value=>value.name)).size!==animations.length)fail('model.animations','unique names');return animations;
}
