/**
 * The parts and atlas view (#348): every part as an image, before any rig is built, and the atlas a built rig ships.
 *
 * Two inputs can be read (only parts mode opens the parts workspace):
 * - **parts mode** — a parts package as rig-parts assemble writes it: `parts.json` (draw order, back first) beside
 *   `parts/<name>.png`, each PNG cropped to its own box at `x`/`y` in rig pixels;
 * - **atlas mode** — a review package (or rig-parts build root) whose compiled model declares `pages[].regions[]`.
 *
 * Producer flags are read from the files rig-parts writes and shown on their part; nothing is re-measured here:
 * - `mesh_report.json` rows: `contour.bridges.faint[]` (rig-parts #326), each a faint island the mesh left out;
 * - `check.json`: read-only row metadata drives display counts; the historical FAIL/WARN extraction below
 *   stays separate for verdict/2 compatibility. No display classification rewrites saved flag IDs.
 *
 * The sign-off is `rig-review-parts-verdict/2` (docs/PARTS_VIEW.md), written beside `parts.json` by default. Its
 * `source.sha256` is the sha256 over the UTF-8 lines `<path>\t<sha256>\n`, sorted by path bytewise, where every path
 * is relative to the verdict file's directory. rig-c/create recomputes it, so the definition is fixed here.
 */
import {differencePixels,assertOriginalPaintingSize} from './parts-comparison.ts';
import {parsePartsIssue,assertPartsIssueBinding,type PartsComment,type PartsIssue} from './parts-comment.ts';
import {preparePartsComment,validateStoredPartsComment} from './parts-comment-crops.ts';
import {resolvedCropPath} from './comment-crops.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import { loadReview, safeFile, packagePath, type ReviewPackage } from './manifest.ts';
import { destinationDirectory } from './destination-directory.ts';
import {commentsObject, jobSha, jobInteger, parseComments} from './job-api.ts';
import {PARTS_COMMENTS_VERDICT_SCHEMA, type PartsCommentsVerdict} from './job-contract.ts';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/4';
const LEGACY_VERDICT_SCHEMAS = ['rig-review-parts-verdict/1', 'rig-review-parts-verdict/2', 'rig-review-parts-verdict/3'] as const;
export type LegacyVerdictSchema = typeof LEGACY_VERDICT_SCHEMAS[number];
export const PARTS_VERDICT_FILE = 'parts-review.json';
export const PARTS_NOTE_LIMIT = 10000;
export type PartsViewMode = 'parts' | 'atlas';
export type PartOutcome = 'pending' | 'clean' | 'flagged';
export type VerdictStatus = 'approved' | 'changes-requested';
export type LegacyVerdictStatus = 'pending' | 'approved' | 'changes-requested';

/** One file the verdict rests on: `path` relative to the verdict file's directory, POSIX separators. */
export interface HashedFile { path: string; bytes: number; sha256: string }
interface LocalFile { abs: string; bytes: number; sha256: string; declaredPath?: string }

/** A part (parts mode) or a named region (atlas mode). Boxes are rig px (parts) or page px (atlas). */
export interface PartMesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown>; width: number; height: number; image: string }
export interface ViewItem {
  mesh?: PartMesh;
  meshUnavailable?: 'PARTS_MESH_GENERATED';
  name: string;
  /** Draw order, back first (parts mode); the region's place in the atlas file (atlas mode). */
  index: number;
  x: number; y: number; w: number; h: number;
  /** Atlas mode only: the page the region is packed on, and its packing rotation. */
  page?: string; degrees?: number;
  /** Parts mode: served at `/api/parts/image/<index>`. */
  image?: boolean;
}
export interface ViewPage { name: string; width: number; height: number; index: number }

/** A producer flag on one item. `id` is stable for the same producer file, and is what the verdict records. */
export type ProducerFlag =
  | { id: string; item: string; source: 'mesh_report'; kind: 'faint'; art: number; maxAlpha: number; box: [number, number, number, number] }
  | { id: string; item: string; source: 'check'; kind: 'check'; path: string; line: string;
      /** The top-level check.json key the line sits under, the gate's status when it is a gate, and the object as written. */
      root: string; status: string | null; entry: Record<string, unknown>;
      classification?: 'part' | 'pair' | 'evidence' | 'unclassified' };

export interface PartsViewPackage {
  paintingInRig?: LocalFile & {width:number;height:number;declaredPath:string};
  painting?:{sha256:string;width:number;height:number;abs:string};
  mode: PartsViewMode;
  root: string;
  title: string;
  rigSize: [number, number] | null;
  items: ViewItem[];
  pages: ViewPage[];
  flags: ProducerFlag[];
  /** Read-only check presentation; never serialized into verdict/2. */
  readings?: ProducerFlag[];
  /** The files the sign-off rests on (parts.json and every part PNG; or the model and every page). */
  files: LocalFile[];
  /** The producer files the flags were read from. */
  flagFiles: LocalFile[];
  /** Where flags were looked for and not found, said in words. */
  flagNotes: string[];
  /** Additional package/producer inputs protected from verdict writes, without changing verdict identity. */
  protectedPaths?: string[];
  verdictPath: string;
  /** Absolute paths, served by index. */
  imagePaths: string[];
  pagePaths: string[];
}

export interface PartsViewOptions { rig?: string; meshReport?: string; check?: string; verdict?: string; painting?: string; paintingRoot?: string }

const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const finite = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min;
const refuse = (code: string, message: string): never => { throw new Error(`${code}: ${message}`); };

/**
 * The file's real path, refused by name when it resolves outside `root`. The same invariant `safeFile` holds for a
 * review package: a symlink inside the package may not reach a file outside it, since the view hashes and serves it.
 */
export async function insideRoot(root: string, path: string, code: string, what: string): Promise<string> {
  const realRoot = await realpath(root), real = await realpath(path);
  const rel = relative(realRoot, real);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) refuse(code, `${what} resolves outside ${basename(realRoot)}/`);
  return real;
}

function hashBytes(abs: string, bytes: Buffer): LocalFile {
  return { abs, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function hashFile(abs: string): Promise<LocalFile> {
  return hashBytes(abs, await readFile(abs));
}

/** A part name is a file stem under `parts/`: no separators, no traversal. */
function partFileName(name: string): string {
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name)) refuse('PARTS_NAME_INVALID', `part name ${JSON.stringify(name)} is not a file name under parts/`);
  return name + '.png';
}

/** `source.sha256`: sha256 over `<path>\t<sha256>\n` lines sorted by path bytewise (UTF-8). */
export function sourceSha256(files: readonly Pick<HashedFile, 'path' | 'sha256'>[]): string {
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const hash = createHash('sha256');
  for (const f of sorted) hash.update(`${f.path}\t${f.sha256}\n`, 'utf8');
  return hash.digest('hex');
}

/** `abs` relative to `dir`, with POSIX separators. */
function relativeTo(dir: string, abs: string): string {
  const rel = relative(dir, abs);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/** Match canonical input paths, resolving only the destination's parent. Missing
 * directories retain their suffix; the output leaf is never followed through a symlink. */
function verdictDestination(path: string): string {
  const absolute = resolve(path);
  const parent = destinationDirectory(dirname(absolute), 'PARTS_VERDICT_DESTINATION_INVALID: the verdict parent path has a non-directory component or a symlink loop');
  return join(parent, basename(absolute));
}

/** Faint islands (rig-parts #326) from `mesh_report.json` rows, on the parts the view holds. */
export function meshReportFlags(rows: unknown, names: ReadonlySet<string>): ProducerFlag[] {
  if (!Array.isArray(rows)) refuse('PARTS_FLAGS_MALFORMED', 'mesh_report.json is not an array of rows');
  const flags: ProducerFlag[] = [];
  for (const raw of rows as unknown[]) {
    const row = record(raw);
    if (!row || typeof row.part !== 'string' || !names.has(row.part)) continue;
    const faint = record(record(row.contour)?.bridges)?.faint;
    if (!Array.isArray(faint)) continue;
    faint.forEach((value, i) => {
      const f = record(value), box = f?.box;
      if (!f || !finite(f.art, 0) || !finite(f.maxAlpha, 0) || !Array.isArray(box) || box.length !== 4 || !box.every(n => finite(n, 0))) return;
      flags.push({ id: `faint:${i}`, item: row.part as string, source: 'mesh_report', kind: 'faint', art: f.art, maxAlpha: f.maxAlpha, box: box as [number, number, number, number] });
    });
  }
  return flags;
}

/** check.json fields that hold a bone name, never a part's, even when a bone shares a part's name (`hairpin`). */
const BONE_FIELDS = new Set(['bone', 'bones', 'root', 'tip', 'link', 'links', 'head_bone']);
/** check.json lists that are problem lines by themselves (rig-parts STABILITY: written when a bar fails or on request). */
const PROBLEM_LISTS = new Set(['seam_pairs', 'figure_openings']);
/** Gate statuses that report a problem; PASS, CLEAR, SKIP and REPORTED do not (rig-parts `CheckStatus`). */
export const PROBLEM_STATUSES = new Set(['FAIL', 'WARN']);

/**
 * The lines of `check.json` that report a problem and name a held part: a gate whose `status` is FAIL or WARN, or an
 * entry of `seam_pairs` / `figure_openings`. Every object inside that names a part by a string field (or a string in
 * an array field), bone fields excepted, is quoted as the producer wrote it. A passing gate is not a flag.
 */
export function checkFlags(doc: unknown, names: ReadonlySet<string>): ProducerFlag[] {
  const flags: ProducerFlag[] = [];
  const walk = (value: unknown, path: string, depth: number, root: string, status: string | null): void => {
    if (depth > 32) return;
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1, root, status)); return; }
    const obj = record(value);
    if (!obj) return;
    const named = new Set<string>();
    for (const [k, v] of Object.entries(obj)) {
      if (BONE_FIELDS.has(k)) continue;
      if (typeof v === 'string' && names.has(v)) named.add(v);
      else if (Array.isArray(v)) for (const s of v) if (typeof s === 'string' && names.has(s)) named.add(s);
    }
    if (named.size) {
      const text = JSON.stringify(obj);
      const line = text.length > 600 ? text.slice(0, 599) + '…' : text;
      for (const item of named) flags.push({ id: `check:${path}`, item, source: 'check', kind: 'check', path, line, root, status, entry: obj });
    }
    for (const [k, v] of Object.entries(obj)) if (v && typeof v === 'object') walk(v, `${path}.${k}`, depth + 1, root, status);
  };
  for (const [key, value] of Object.entries(record(doc) ?? {})) {
    const status = record(value)?.status;
    if (typeof status === 'string' ? PROBLEM_STATUSES.has(status) : PROBLEM_LISTS.has(key)) walk(value, key, 0, key, typeof status === 'string' ? status : null);
  }
  return flags;
}

/** Additive check-row metadata is authoritative only as a complete valid tuple.
 * Walk all roots (including PASS/SKIP), nested arrays, sets and requirements.lines.
 * Legacy extraction and verdict IDs deliberately remain in checkFlags above.
 */
export function checkReadings(doc: unknown, names: ReadonlySet<string>): ProducerFlag[] {
  const rows: ProducerFlag[] = [];
  let labelled = false;
  const visit = (value: unknown, path: string, root: string, status: string | null, row = false, depth = 0): void => {
    if (depth > 32) return;
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`, root, status, true, depth + 1)); return; }
    const obj = record(value); if (!obj) return;
    const hasMetadata = ['row_scope', 'row_kind', 'row_subjects'].some(k => Object.hasOwn(obj, k));
    labelled ||= hasMetadata;
    // Preserve failed/warning root gates even when only their child rows carry metadata.
    const unlabelledProblemRoot = path === root && !hasMetadata && PROBLEM_STATUSES.has(String(obj.status));
    if (hasMetadata || row || unlabelledProblemRoot) {
      const scope = obj.row_scope, kind = obj.row_kind, subjects = obj.row_subjects;
      const valid = ['part', 'pair', 'rig'].includes(String(scope)) && ['finding', 'evidence'].includes(String(kind)) &&
        Array.isArray(subjects) && subjects.length === (scope === 'part' ? 1 : scope === 'pair' ? 2 : 0) &&
        subjects.every(s => typeof s === 'string' && s.length > 0 && names.has(s)) && new Set(subjects).size === subjects.length;
      const classification = !valid ? 'unclassified' : scope === 'rig' || kind === 'evidence' ? 'evidence' : scope === 'part' ? 'part' : 'pair';
      // Invalid/missing metadata or any unheld subject has no implied attribution. Keep the whole row globally unclassified.
      const items = valid ? (subjects as string[]).filter(s => names.has(s)) : [];
      for (const item of items.length ? items : ['']) rows.push({id: `check:${path}`, item, source:'check', kind:'check', path, root, status, entry:obj, line:JSON.stringify(obj), classification});
    }
    for (const [key, child] of Object.entries(obj)) {
      // requirements.lines is the producer's dictionary of individual rows, not an array.
      if (key === 'lines' && /(?:^|\.)requirements$/.test(path) && record(child)) {
        for (const [name, entry] of Object.entries(child as Record<string, unknown>)) visit(entry, `${path}.lines.${name}`, root, status, true, depth + 1);
      } else visit(child, path ? `${path}.${key}` : key, root, status, false, depth + 1);
    }
  };
  for (const [root, value] of Object.entries(record(doc) ?? {})) visit(value, root, root, typeof record(value)?.status === 'string' ? record(value)!.status as string : null);
  return labelled ? rows : checkFlags(doc, names).map(f => ({...f, classification:'unclassified' as const, ...(f.kind === 'check' ? {line:JSON.stringify(f.entry)} : {})}));
}

function parseJson(bytes: Buffer, what: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch (e) { return refuse('PARTS_FLAGS_MALFORMED', `${what}: ${e instanceof Error ? e.message : String(e)}`); }
}

async function readJsonBytes(abs: string, what: string): Promise<{ bytes: Buffer; value: unknown }> {
  try { const bytes = await readFile(abs); return { bytes, value: JSON.parse(bytes.toString('utf8')) }; }
  catch (e) { return refuse('PARTS_FLAGS_MALFORMED', `${what}: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Flags from the producer files: explicit paths win; otherwise where rig-parts writes them in a build root — `rig`
 * writes `mesh_report.json` beside `parts.json` in `rig/`, and `check` writes `check/check.json` beside `rig/`.
 * `rigDir` is that `rig/` directory (parts mode) or null (atlas mode: explicit paths only, or `buildRoot`'s files).
 */
async function producerFlags(rigDir: string | null, buildRoot: string | null, names: ReadonlySet<string>, options: PartsViewOptions): Promise<{ flags: ProducerFlag[]; readings: ProducerFlag[]; files: LocalFile[]; notes: string[]; meshReport: unknown }> {
  const flags: ProducerFlag[] = [], readings: ProducerFlag[] = [], files: LocalFile[] = [], notes: string[] = [];
  let meshReport: unknown = null;
  // A discovered file must resolve inside the directory it was discovered in; a path given on the command line is the user's own choice.
  const pick = async (explicit: string | undefined, candidates: ([string, string] | null)[], what: string): Promise<string | null> => {
    if (explicit !== undefined) return realpath(resolve(explicit));
    const found = candidates.find((c): c is [string, string] => !!c && existsSync(c[1]));
    return found ? insideRoot(found[0], found[1], 'PARTS_FLAGS_OUTSIDE', what) : null;
  };
  const mesh = await pick(options.meshReport, [rigDir ? [rigDir, join(rigDir, 'mesh_report.json')] : null, buildRoot ? [buildRoot, join(buildRoot, 'rig', 'mesh_report.json')] : null], 'mesh_report.json');
  if (mesh) { const bytes = await readFile(mesh); files.push(hashBytes(mesh, bytes)); meshReport = parseJson(bytes, 'mesh_report.json'); flags.push(...meshReportFlags(meshReport, names)); }
  else notes.push('mesh_report.json');
  const check = await pick(options.check, [rigDir ? [dirname(rigDir), join(dirname(rigDir), 'check', 'check.json')] : null, buildRoot ? [buildRoot, join(buildRoot, 'check', 'check.json')] : null], 'check/check.json');
  if (check) { const bytes = await readFile(check); files.push(hashBytes(check, bytes)); const doc = parseJson(bytes, 'check.json'); flags.push(...checkFlags(doc, names)); readings.push(...checkReadings(doc, names)); }
  else notes.push('check.json');
  return { flags, readings, files, notes, meshReport };
}

/** Exact attachment identity and UV-derived geometry; never reconstruct through weights. */
export function readPartMeshes(raw: unknown, items: ViewItem[], reports: unknown): void {
  const skins = record(record(raw)?.skins);
  if (!skins) refuse('PARTS_MESH_MALFORMED', 'rig.json requires skins object');
  const byName = new Map(items.map(i => [i.name, i]));
  for (const slots of Object.values(skins!)) for (const attachments of Object.values(record(slots) ?? {})) {
    for (const [name, value] of Object.entries(record(attachments) ?? {})) {
      const a = record(value);
      if (a?.type !== 'mesh') continue;
      const item = byName.get(name);
      if (!item) refuse('PARTS_MESH_UNKNOWN_PART', `${name}: found mesh; required a part in parts.json`);
      if (item!.mesh || item!.meshUnavailable) refuse('PARTS_MESH_AMBIGUOUS', `${name}: found multiple meshes; required one attachment`);
      if (!finite(a.width, 1) || !Number.isInteger(a.width) || !finite(a.height, 1) || !Number.isInteger(a.height) || typeof a.image !== 'string') refuse('PARTS_MESH_SIZE', `${name}: found invalid raster declaration; required image and positive integer dimensions`);
      if (Object.hasOwn(a, 'generator')) {
        if (!record(a.generator) || Object.hasOwn(a, 'uvs')) refuse('PARTS_MESH_UV', `${name}: found invalid uvs; required nonempty coordinate pairs in [0,1]`);
        if (Object.hasOwn(a, 'triangles')) refuse('PARTS_MESH_TRIANGLE', `${name}: found invalid triangles; required nonempty index triples`);
        const rows = Array.isArray(reports) ? reports.filter(r => record(r)?.part === name) : [];
        if (rows.length > 1) refuse('PARTS_MESH_REPORT_AMBIGUOUS', `${name}: found ${rows.length} report rows; required at most one`);
        item!.meshUnavailable = 'PARTS_MESH_GENERATED';
        continue;
      }
      const uv = a.uvs, triangles = a.triangles;
      if (!Array.isArray(uv) || !uv.length || uv.length % 2) refuse('PARTS_MESH_UV', `${name}: found invalid uvs; required nonempty coordinate pairs in [0,1]`);
      for (const v of uv as unknown[]) if (!finite(v, 0) || v > 1) refuse('PARTS_MESH_UV', `${name}: found ${String(v)}; required UV in [0,1]`);
      const count = (uv as number[]).length / 2;
      if (!Array.isArray(triangles) || !triangles.length || triangles.length % 3) refuse('PARTS_MESH_TRIANGLE', `${name}: found invalid triangles; required nonempty index triples`);
      for (const v of triangles as unknown[]) if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= count) refuse('PARTS_MESH_TRIANGLE', `${name}: found ${String(v)}; required integer index in [0,${count - 1}]`);
      const rows = Array.isArray(reports) ? reports.filter(r => record(r)?.part === name) : [];
      if (rows.length > 1) refuse('PARTS_MESH_REPORT_AMBIGUOUS', `${name}: found ${rows.length} report rows; required at most one`);
      const row = record(rows[0]) ?? {}, figures: Record<string, unknown> = {};
      for (const field of ['mode', 'vertices', 'triangles', 'art_coverage', 'stray_cleared']) if (Object.hasOwn(row, field)) figures[field] = row[field];
      item!.mesh = { vertices: (uv as number[]).map((v, i) => v * (i % 2 ? a.height as number : a.width as number)), triangles: triangles as number[], figures, width: a.width as number, height: a.height as number, image: a.image as string };
    }
  }
}

/** Prove the crop window in the mesh raster byte-for-byte; accept no inferred producer padding. */
async function locateMeshRasters(rig: unknown, root: string, items: ViewItem[], images: string[], files: LocalFile[]): Promise<void> {
  const directory = record(rig)?.images;
  for (const item of items) {
    const mesh = item.mesh; if (!mesh) continue;
    let path: string;
    try {
      // Validate both literal components before joining: normalization must not hide traversal.
      path = await safeFile(root, `${packagePath(directory, 'rig.images')}/${packagePath(mesh.image, 'mesh.image')}`);
    } catch { return refuse('PARTS_MESH_IMAGE_PATH', `${item.name}: found unavailable or unsafe rig image; required a literal local raster inside the rig directory`); }
    const bytes = await readFile(path);
    let image: ReturnType<typeof PNG.sync.read>, part: ReturnType<typeof PNG.sync.read>;
    try {
      const partBytes = await readFile(images[item.index]!);
      image = PNG.sync.read(bytes); part = PNG.sync.read(partBytes);
      // Retain all sixteen bits where present; 8-bit downsampling would hide a differing sample.
      if (image.depth === 16) image = PNG.sync.read(bytes, { skipRescale: true });
      if (part.depth === 16) part = PNG.sync.read(partBytes, { skipRescale: true });
    }
    catch { return refuse('PARTS_MESH_IMAGE_FORMAT', `${item.name}: found undecodable PNG; required PNG raster`); }
    if (image.width !== mesh.width || image.height !== mesh.height) refuse('PARTS_MESH_IMAGE_SIZE', `${item.name}: found ${image.width}×${image.height}; required ${mesh.width}×${mesh.height}`);
    const ox = (mesh.width - part.width) / 2, oy = (mesh.height - part.height) / 2;
    if (part.width !== item.w || part.height !== item.h || ox < 0 || oy < 0 || !Number.isInteger(ox) || !Number.isInteger(oy)) refuse('PARTS_MESH_IMAGE_MISMATCH', `${item.name}: found incompatible raster window ${ox},${oy}; required a centred integer window of ${item.w}×${item.h}`);
    const raster = image.data, original = part.data;
    const rasterScale = image.depth === 16 ? 1 : 257, partScale = part.depth === 16 ? 1 : 257;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const inside = x >= ox && x < ox + part.width && y >= oy && y < oy + part.height;
      const j = ((y - oy) * part.width + x - ox) * 4;
      if (inside ? [0, 1, 2, 3].some(c => raster[i + c]! * rasterScale !== original[j + c]! * partScale) : raster[i + 3] !== 0) refuse('PARTS_MESH_IMAGE_MISMATCH', `${item.name}: first differing rig pixel (${x},${y}) found RGBA [${[...raster.slice(i, i + 4)]}]; required ${inside ? `RGBA [${[...original.slice(j, j + 4)]}]` : 'border alpha 0'}`);
    }
    mesh.vertices = mesh.vertices.map((v, i) => v - (i % 2 ? oy : ox));
    files.push({ abs: path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}

/** Resolve the existing inline declaration, or the frozen adjacent sidecar only when absent. */
export async function resolvePartsPaintingInRig(root: string, manifestBytes: Buffer,
  read: (absolute: string, kind: 'sidecar' | 'painting') => Promise<Buffer> = absolute => readFile(absolute),
): Promise<{paintingInRig?: PartsViewPackage['paintingInRig']; files: LocalFile[]; sidecar?: true}> {
  const doc = record(JSON.parse(manifestBytes.toString('utf8')));
  if (!doc) return refuse('PARTS_JSON_MALFORMED', 'parts.json must be an object');
  const size = doc.rig_size;
  const rigSize = Array.isArray(size) && size.length === 2 && size.every(n => finite(n, 1)) ? size : null;
  const files: LocalFile[] = [];
  let d = record(doc.painting_in_rig), sidecar: true | undefined;
  if (Object.hasOwn(doc, 'painting_in_rig')) {
    if (!d || Object.keys(d).length !== 3) refuse('PARTS_DIFFERENCE_PROVENANCE', 'declared path, lowercase SHA-256 and lanczos3-rgb-opaque required');
  } else {
    const declaredPath = join(root, 'painting_in_rig.json');
    const info = await lstat(declaredPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return refuse('PARTS_DIFFERENCE_PATH', 'sidecar must be readable inside the package');
    });
    if (!info) return {files};
    const abs = await safeFile(root, 'painting_in_rig.json').catch(() => refuse('PARTS_DIFFERENCE_PATH', 'sidecar must be readable inside the package'));
    const bytes = await read(abs, 'sidecar').catch(error => {
      if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return refuse('PARTS_DIFFERENCE_PATH', 'sidecar must be readable inside the package');
      throw error;
    });
    try { d = record(JSON.parse(bytes.toString('utf8'))); }
    catch { refuse('PARTS_DIFFERENCE_PROVENANCE', 'sidecar must be a JSON declaration'); }
    const keys = ['schema', 'manifest_sha256', 'path', 'sha256', 'resample', 'rig_size'];
    if (!d || Object.keys(d).length !== keys.length || !keys.every(key => Object.hasOwn(d!, key)) ||
        d.schema !== 'rig-parts-painting-reference/1' || typeof d.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.manifest_sha256)) {
      refuse('PARTS_DIFFERENCE_PROVENANCE', 'sidecar requires the six frozen painting reference fields');
    }
    if (d!.manifest_sha256 !== hashBytes(join(root, 'parts.json'), manifestBytes).sha256) refuse('PARTS_DIFFERENCE_HASH', 'sidecar manifest hash differs');
    const declaredSize = d!.rig_size;
    if (!Array.isArray(declaredSize) || declaredSize.length !== 2 || !declaredSize.every(n => Number.isSafeInteger(n) && n > 0) ||
        !rigSize || declaredSize.some((n, i) => n !== rigSize[i])) refuse('PARTS_DIFFERENCE_SIZE', 'sidecar rig_size must equal parts.json rig_size');
    files.push({...hashBytes(abs, bytes), declaredPath});
    sidecar = true;
  }
  if (!d || typeof d.path !== 'string' || typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256) || d.resample !== 'lanczos3-rgb-opaque') {
    refuse('PARTS_DIFFERENCE_PROVENANCE', 'declared path, lowercase SHA-256 and lanczos3-rgb-opaque required');
  }
  try { packagePath(d!.path, 'painting_in_rig'); } catch { refuse('PARTS_DIFFERENCE_PATH', 'literal portable inside-package path required'); }
  const declaredPath = join(root, d!.path as string);
  const unreadable = () => refuse('PARTS_DIFFERENCE_PATH', 'declared painting must be readable inside the package');
  const abs = await safeFile(root, d!.path as string).catch(unreadable);
  const bytes = await read(abs, 'painting').catch(error => {
    if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return unreadable();
    throw error;
  }), sha256 = hashBytes(abs, bytes).sha256;
  if (sha256 !== d!.sha256) refuse('PARTS_DIFFERENCE_HASH', 'declared painting hash differs');
  let png: PNG;
  try { png = PNG.sync.read(bytes); } catch { return refuse('PARTS_DIFFERENCE_PNG', 'declared painting must be RGBA8 PNG'); }
  if (bytes[24] !== 8 || bytes[25] !== 6) refuse('PARTS_DIFFERENCE_PNG', 'declared painting must be RGBA8 PNG');
  if (!rigSize || !rigSize.every(Number.isSafeInteger) || png.width !== rigSize[0] || png.height !== rigSize[1]) refuse('PARTS_DIFFERENCE_SIZE', 'declared painting dimensions must equal integer rig_size');
  for (let i = 3; i < png.data.length; i += 4) if (png.data[i] !== 255) refuse('PARTS_DIFFERENCE_ALPHA', 'declared painting must have alpha 255');
  const paintingInRig = {abs, declaredPath, bytes: bytes.length, sha256, width: png.width, height: png.height};
  files.push(paintingInRig);
  return {paintingInRig, files, ...(sidecar ? {sidecar} : {})};
}

async function loadPartsMode(root: string, options: PartsViewOptions): Promise<PartsViewPackage> {
  const partsJson = await insideRoot(root, join(root, 'parts.json'), 'PARTS_FILE_OUTSIDE', 'parts.json');
  const { bytes: partsBytes, value: partsRaw } = await readJsonBytes(partsJson, 'parts.json');
  const doc = record(partsRaw);
  const list = doc?.parts;
  if (!doc || !Array.isArray(list)) return refuse('PARTS_JSON_MALFORMED', 'parts.json has no parts[] array');
  const size = doc.rig_size;
  const rigSize: [number, number] | null = Array.isArray(size) && size.length === 2 && finite(size[0], 1) && finite(size[1], 1) ? [size[0], size[1]] : null;
  const items: ViewItem[] = [], imagePaths: string[] = [], files: LocalFile[] = [hashBytes(partsJson, partsBytes)];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const p = record(raw);
    if (!p || typeof p.name !== 'string' || !finite(p.x, -1e9) || !finite(p.y, -1e9) || !finite(p.w, 1) || !finite(p.h, 1)) refuse('PARTS_JSON_MALFORMED', `parts[${index}] needs name, x, y, w, h`);
    const part = p as { name: string; x: number; y: number; w: number; h: number };
    if (seen.has(part.name)) refuse('PARTS_JSON_MALFORMED', `part ${part.name} appears twice`);
    seen.add(part.name);
    const abs = join(root, 'parts', partFileName(part.name));
    if (!existsSync(abs)) refuse('PARTS_IMAGE_MISSING', `parts/${part.name}.png is named in parts.json and is not on disk`);
    // Resolved to its current real path inside root before hashing; full path-replacement pinning stays tracked in #479.
    const real = await insideRoot(root, abs, 'PARTS_IMAGE_OUTSIDE', `parts/${part.name}.png`);
    files.push(await hashFile(real));
    imagePaths.push(real);
    items.push({ name: part.name, index, x: part.x, y: part.y, w: part.w, h: part.h, image: true });
  }
  const {paintingInRig, files: paintingFiles} = await resolvePartsPaintingInRig(root, partsBytes);
  files.push(...paintingFiles);
  let painting:PartsViewPackage['painting'];if(options.painting){
    // Both paths are physical: a user-designated alias to an inside file is valid,
    // while a link reaching outside is refused before any painting bytes are read.
    let abs:string,bytes:Buffer;try{
      const paintingRoot = options.paintingRoot !== undefined ? await realpath(resolve(options.paintingRoot)) : root;
      abs = await insideRoot(paintingRoot, resolve(options.painting), 'PARTS_PAINTING_OUTSIDE', 'painting');
      packagePath(relative(paintingRoot, abs).split(sep).join('/'), 'painting');
      bytes = await readFile(abs);
    }catch(error){if(error instanceof Error&&error.message.startsWith('PARTS_PAINTING_OUTSIDE:'))throw error;refuse('PARTS_PAINTING_UNAVAILABLE','painting must be a readable portable package PNG');}
    let png:PNG;try{png=PNG.sync.read(bytes!);}catch{refuse('PARTS_PAINTING_PNG','painting must be a valid PNG');}
    assertOriginalPaintingSize(png!.width,png!.height,rigSize,doc.scale_rig_per_source);
    const file={abs:abs!,bytes:bytes!.length,sha256:createHash('sha256').update(bytes!).digest('hex')};painting={...file,width:png!.width,height:png!.height};files.push(file);
  }
  const { flags, readings, files: flagFiles, notes, meshReport } = await producerFlags(root, null, seen, options);
  const protectedPaths = [join(root, 'rig.json'), join(root, 'config.json'), join(root, 'review.json'), join(root, 'report.json')];
  if (basename(root) === 'rig') protectedPaths.push(...['parts.json', 'config.json', 'review.json', 'report.json'].map(name => join(dirname(root), name)));
  if (options.rig !== undefined) protectedPaths.push(resolve(options.rig));
  const verdictPath = options.verdict ? verdictDestination(options.verdict) : join(root, PARTS_VERDICT_FILE);
  await assertVerdictDestination({ files, flagFiles, protectedPaths, verdictPath });
  const rigPath = options.rig !== undefined ? await realpath(resolve(options.rig)) : existsSync(join(root, 'rig.json')) ? await insideRoot(root, join(root, 'rig.json'), 'PARTS_MESH_OUTSIDE', 'rig.json') : null;
  if (rigPath) {
    const report = notes.includes('mesh_report.json') ? undefined : flagFiles[0];
    const rigBytes = await readFile(rigPath);
    let rig: unknown;
    try { rig = JSON.parse(rigBytes.toString('utf8')); }
    catch (e) { return refuse('PARTS_MESH_MALFORMED', `rig.json: ${e instanceof Error ? e.message : String(e)}`); }
    readPartMeshes(rig, items, report ? meshReport : null);
    await locateMeshRasters(rig, dirname(rigPath), items, imagePaths, files);
    // Bind exactly the bytes parsed above, even if the path is replaced during raster checks.
    files.push({ abs: rigPath, bytes: rigBytes.length, sha256: createHash('sha256').update(rigBytes).digest('hex') });
    if (report) files.push(report);
  }
  return { ...(paintingInRig?{paintingInRig}:{}),...(painting?{painting}:{}),mode: 'parts', root, title: basename(root) === 'rig' ? basename(dirname(root)) : basename(root), rigSize, items, pages: [], flags, readings, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath, imagePaths, pagePaths: [] };
}

async function loadAtlasMode(input: string, options: PartsViewOptions): Promise<PartsViewPackage> {
  if(options.painting)refuse('PARTS_PAINTING_UNAVAILABLE','atlas regions have no rig placement; use a pre-rig parts package');
  const p = await loadReview(input);
  if (!p.manifest.model) return refuse('PARTS_VIEW_NO_ATLAS', `${input} holds neither parts.json nor a compiled model with pages`);
  return loadPartsAtlas(p, options);
}

/** Atlas inspector bound to an already loaded package; never rediscover a different source. */
export async function loadPartsAtlas(p: ReviewPackage, options: PartsViewOptions = {}): Promise<PartsViewPackage> {
  const modelPath = p.manifest.model;
  if (!modelPath) return refuse('PARTS_VIEW_NO_ATLAS', `The inspected package holds no compiled model with pages`);
  const modelAbs = await safeFile(p.root, modelPath);
  const modelBytes = await readFile(modelAbs);
  const model = record(JSON.parse(modelBytes.toString('utf8')));
  const pagesRaw = model?.pages;
  if (!Array.isArray(pagesRaw)) return refuse('PARTS_VIEW_NO_ATLAS', `${modelPath} declares no pages`);
  const pages: ViewPage[] = [], pagePaths: string[] = [], items: ViewItem[] = [], files: LocalFile[] = [hashBytes(modelAbs, modelBytes)];
  const names = new Set<string>();
  for (const raw of pagesRaw) {
    const page = record(raw);
    if (!page || typeof page.name !== 'string' || !finite(page.width, 1) || !finite(page.height, 1) || !Array.isArray(page.regions)) continue;
    const abs = await safeFile(p.root, posix.join(posix.dirname(modelPath), page.name));
    const index = pages.length;
    pages.push({ name: page.name, width: page.width, height: page.height, index });
    pagePaths.push(abs);
    files.push(await hashFile(abs));
    for (const value of page.regions) {
      const r = record(value);
      if (!r || typeof r.name !== 'string' || !finite(r.x, 0) || !finite(r.y, 0) || !finite(r.width, 1) || !finite(r.height, 1)) continue;
      items.push({ name: r.name, index: items.length, x: r.x, y: r.y, w: r.width, h: r.height, page: page.name, degrees: typeof r.degrees === 'number' ? r.degrees : 0 });
      names.add(r.name);
    }
  }
  // A build root opens as its check package (#149); its own rig/ and check/ hold the flags.
  const buildRoot = p.buildRoot ?? null;
  const { flags, readings, files: flagFiles, notes } = await producerFlags(null, buildRoot, names, options);
  const protectedPaths = [...p.files].map(path => resolve(p.root, path));
  protectedPaths.push(...['rig.json', 'config.json', 'report.json', 'review.json'].map(name => join(p.root, name)));
  if (p.handoff) protectedPaths.push(...p.handoff.record.files.map(file => resolve(p.root, file.path)));
  if (buildRoot) protectedPaths.push(...['parts.json', 'config.json', 'rig/rig.json', 'rig/parts.json'].map(name => join(buildRoot, name)));
  return { mode: 'atlas', root: p.root, title: p.manifest.title, rigSize: null, items, pages, flags, readings, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath: options.verdict ? verdictDestination(options.verdict) : join(dirname(modelAbs), PARTS_VERDICT_FILE), imagePaths: [], pagePaths };
}

/**
 * Parts mode: a directory holding `parts.json`, or a build root whose `rig/` holds it (assemble writes
 * `<out>/rig/parts.json`). Anything else — a review package, a `check/` folder — is read for its atlas.
 */
export async function loadPartsView(input: string, options: PartsViewOptions = {}): Promise<PartsViewPackage> {
  const abs = await realpath(resolve(input)).catch(() => refuse('PARTS_VIEW_INPUT_MISSING', `${input} does not exist`));
  if ((await stat(abs)).isDirectory()) {
    if (existsSync(join(abs, 'parts.json'))) return checkedVerdict(await loadPartsMode(abs, options));
    if (existsSync(join(abs, 'rig', 'parts.json')) && !existsSync(join(abs, 'review.json'))) return checkedVerdict(await loadPartsMode(join(abs, 'rig'), options));
  }
  return checkedVerdict(await loadAtlasMode(input, options));
}

/** Opening is narrower than loading: keep embedded atlas inspection and saved verdict reads available. */
export function assertPartsCanOpen(pkg: Pick<PartsViewPackage, 'mode'>): void {
  if (pkg.mode === 'atlas') refuse('PARTS_ATLAS_NOT_CARRIED', 'atlas inspection is not available in the parts workspace; open the rig review instead.');
}

/** Compare names, real paths (including parent links), and filesystem identities before creating output. */
async function assertVerdictDestination(pkg: Pick<PartsViewPackage, 'files' | 'flagFiles' | 'protectedPaths' | 'verdictPath'>): Promise<void> {
  const target = resolve(pkg.verdictPath);
  const targetReal = await realpath(target).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
  const targetStat = await stat(target, { bigint: true }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
  const parent = await realpath(dirname(target)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
  for (const path of [...pkg.files, ...pkg.flagFiles].map(file => file.abs).concat(pkg.protectedPaths ?? [])) {
    const input = resolve(path);
    const real = await realpath(input).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null; });
    const sameName = target === input || (real !== null && (targetReal === real || (parent !== null && join(parent, basename(target)) === real)));
    const identity = targetStat && real ? await stat(real, { bigint: true }) : null;
    if (sameName || (targetStat && identity && targetStat.dev === identity.dev && targetStat.ino === identity.ino)) refuse('PARTS_VERDICT_INPUT_COLLISION', `${basename(target)} is a protected input; choose a separate verdict file`);
  }
}

async function checkedVerdict(pkg: PartsViewPackage): Promise<PartsViewPackage> {
  await assertVerdictDestination(pkg);
  return pkg;
}

/** The hashed files as the verdict records them: relative to the verdict file's directory. */
export function verdictSource(pkg: Pick<PartsViewPackage, 'files' | 'flagFiles' | 'verdictPath'>): { sha256: string; files: HashedFile[]; flags: { path: string; sha256: string }[] } {
  const dir = dirname(pkg.verdictPath);
  const files = pkg.files.map(f => ({ path: relativeTo(dir, f.abs), bytes: f.bytes, sha256: f.sha256 }));
  return { sha256: sourceSha256(files), files, flags: pkg.flagFiles.map(f => ({ path: relativeTo(dir, f.abs), sha256: f.sha256 })) };
}

export interface PartsVerdict {
  schema: typeof PARTS_VERDICT_SCHEMA;
  mode: PartsViewMode;
  tool: { name: '@rig-c/review'; version: string };
  source: ReturnType<typeof verdictSource>;
  status: VerdictStatus;
  issues: PartsIssue[];
  updatedAt: string;
  by?: string;
}

/** The standalone comments envelope is a decoder until the consumer activation receipt. */
export function parseCommentsPartsVerdict(value: unknown): PartsCommentsVerdict {
  const raw = commentsObject(value, ['schema', 'mode', 'tool', 'source', 'status', 'comments', 'updatedAt'], ['by']);
  if (raw.schema !== PARTS_COMMENTS_VERDICT_SCHEMA || typeof raw.mode !== 'string' || !['parts', 'atlas'].includes(raw.mode) ||
      typeof raw.status !== 'string' || !['approved', 'changes-requested'].includes(raw.status)) throw new Error('JOB_ACT_INVALID');
  const tool = commentsObject(raw.tool, ['name', 'version']);
  if (tool.name !== '@rig-c/review' || typeof tool.version !== 'string' || !tool.version) throw new Error('JOB_ACT_INVALID');
  const source = commentsObject(raw.source, ['sha256', 'files', 'flags']);
  jobSha(source.sha256);
  if (!Array.isArray(source.files) || !source.files.length || !Array.isArray(source.flags)) throw new Error('JOB_ACT_INVALID');
  for (const file of source.files) {
    const row = commentsObject(file, ['path', 'sha256', 'bytes']);
    if (typeof row.path !== 'string' || !row.path) throw new Error('JOB_ACT_INVALID');
    jobSha(row.sha256); jobInteger(row.bytes);
  }
  for (const file of source.flags) {
    const row = commentsObject(file, ['path', 'sha256']);
    if (typeof row.path !== 'string' || !row.path) throw new Error('JOB_ACT_INVALID');
    jobSha(row.sha256);
  }
  if (sourceSha256(source.files as HashedFile[]) !== source.sha256) throw new Error('JOB_ACT_INVALID');
  if (typeof raw.updatedAt !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) ||
      'by' in raw && (typeof raw.by !== 'string' || !raw.by)) throw new Error('JOB_ACT_INVALID');
  const comments = parseComments(raw.comments, source.sha256 as string);
  const issues = comments.filter(comment => comment.anchor && 'schema' in comment.anchor).length;
  if (comments.some(comment => comment.anchor && !('schema' in comment.anchor)) ||
      (raw.status === 'approved') !== (issues === 0)) throw new Error('JOB_ACT_INVALID');
  return {...structuredClone(raw), comments} as unknown as PartsCommentsVerdict;
}

export interface LegacyPartsVerdictView {
  schema: LegacyVerdictSchema;
  status: LegacyVerdictStatus;
  readOnly: true;
  code: 'PARTS_VERDICT_LEGACY_FORMAT';
  flaggedCount: number;
  flaggedParts: { name: string; note: string }[];
  issues: PartsIssue[];
  by?: string;
}

export interface LegacyPartsVerdictRecord {
  schema: LegacyVerdictSchema;
  mode: PartsViewMode;
  tool: { name: '@rig-c/review'; version: string };
  source: ReturnType<typeof verdictSource>;
  status: LegacyVerdictStatus;
  parts: Record<string, { outcome: PartOutcome; note: string; flags: string[]; mesh?: { outcome: PartOutcome; note: string; flags: string[] } }>;
  comments?: import('./parts-comment.ts').PartsComment[];
  issues: PartsIssue[];
  updatedAt: string;
  by?: string;
}

/** What the page submits: the status and pointed issues. */
export interface VerdictSubmission { status: VerdictStatus; issues: PartsIssue[] }

/** The distinct names, in item order (atlas sequence frames share a name). */
export const itemNames = (pkg: Pick<PartsViewPackage, 'items'>): string[] => [...new Set(pkg.items.map(i => i.name))];

/** Builds the verdict document, or refuses by name. Pure but for the clock. */
export function buildVerdict(
  pkg: Pick<PartsViewPackage, 'mode' | 'items' | 'flags' | 'files' | 'flagFiles' | 'verdictPath' | 'imagePaths' | 'painting' | 'paintingInRig'>,
  input: unknown,
  version: string,
  now = new Date(),
  by?: string,
): PartsVerdict {
  const body = record(input);
  if (!body || body.parts !== undefined || body.comments !== undefined) {
    return refuse('PARTS_VERDICT_INVALID', 'expected { status, issues }');
  }
  const status = body.status;
  if (status !== 'approved' && status !== 'changes-requested') {
    return refuse('PARTS_VERDICT_INVALID', 'status is approved or changes-requested');
  }
  const issues = body.issues;
  if (!Array.isArray(issues) || issues.length > 1000) {
    return refuse('PARTS_COMMENT_LIMIT', 'issues must be an array of at most 1000 entries');
  }
  if (status === 'approved' && issues.length > 0) {
    return refuse('PARTS_VERDICT_NOT_CLEAN', `approved needs zero issues; ${issues.length} present`);
  }
  if (status === 'changes-requested' && issues.length === 0) {
    return refuse('PARTS_VERDICT_NOTHING_FLAGGED', 'changes-requested needs at least one issue');
  }
  if (by !== undefined && (typeof by !== 'string' || !by.trim())) {
    return refuse('PARTS_VERDICT_INVALID', 'reviewer name must be nonblank');
  }
  const itemMap = new Map(
    pkg.items.map(i => [i.name, { ...i, imageHash: pkg.files.find(f => f.abs === pkg.imagePaths[i.index])?.sha256 ?? '' }]),
  );
  const sourceHash = verdictSource(pkg).sha256;
  const ids = new Set<string>();
  const parsedIssues: PartsIssue[] = [];
  for (const raw of issues as unknown[]) {
    const c = parsePartsIssue(raw, true, false);
    if (c.view.comparison?.mode === 'overlay' && !pkg.painting) {
      refuse('PARTS_COMPARISON_UNAVAILABLE', 'original painting required');
    }
    if (c.view.comparison?.mode === 'difference' && !pkg.paintingInRig) {
      refuse('PARTS_DIFFERENCE_UNAVAILABLE', 'declared painting_in_rig required');
    }
    if (pkg.mode !== 'parts') {
      refuse('PARTS_COMMENT_UNAVAILABLE', 'original part required');
    }
    if (ids.has(c.id)) {
      refuse('PARTS_COMMENT_DUPLICATE', 'duplicate issue id');
    }
    ids.add(c.id);
    assertPartsIssueBinding(c, itemMap, sourceHash);
    parsedIssues.push(c);
  }
  return {
    schema: PARTS_VERDICT_SCHEMA,
    mode: pkg.mode,
    tool: { name: '@rig-c/review', version },
    source: verdictSource(pkg),
    status,
    issues: parsedIssues,
    updatedAt: now.toISOString(),
    ...(by !== undefined ? { by } : {}),
  };
}

/** Decode-only reader for legacy /1, /2 and /3 files: /1 comments become /2 item issues; uncommented flagged rows and pending open read-only. */
async function decodeLegacyVerdict(
  pkg: PartsViewPackage,
  v: Record<string, unknown>,
  version: string,
  date: Date,
  by: string | null,
) {
  const status = v.status;
  if (status !== 'pending' && status !== 'approved' && status !== 'changes-requested') {
    return refuse('PARTS_VERDICT_INVALID', 'status is pending, approved or changes-requested');
  }
  const given = record(v.parts);
  if (!given) {
    return refuse('PARTS_VERDICT_INVALID', 'parts is an object keyed by part name');
  }
  const names = itemNames(pkg);
  const known = new Set(names);
  for (const name of Object.keys(given)) {
    if (!known.has(name)) {
      return refuse('PARTS_VERDICT_UNKNOWN_PART', `${name} is not a part of this input`);
    }
  }
  const parts: LegacyPartsVerdictRecord['parts'] = {};
  for (const name of names) {
    const entry = record(given[name]);
    if (!entry) {
      return refuse('PARTS_VERDICT_MISSING_PART', `${name} has no entry`);
    }
    const outcome = entry.outcome;
    if (outcome !== 'pending' && outcome !== 'clean' && outcome !== 'flagged') {
      return refuse('PARTS_VERDICT_INVALID', `${name}.outcome is pending, clean or flagged`);
    }
    const note = entry.note === undefined ? '' : entry.note;
    if (typeof note !== 'string' || note.length > PARTS_NOTE_LIMIT) {
      return refuse('PARTS_VERDICT_INVALID', `${name}.note is a string of at most ${PARTS_NOTE_LIMIT} characters`);
    }
    if (outcome === 'flagged' && !note.trim()) {
      return refuse('PARTS_VERDICT_NOTE_REQUIRED', `${name} is flagged and has no note saying what is wrong`);
    }
    const partFlags = Array.isArray(entry.flags) ? entry.flags.map(String) : [];
    const meshInput = record(entry.mesh);
    const hasMesh = pkg.items.some(i => i.name === name && i.mesh);
    if (!hasMesh && entry.mesh !== undefined) {
      return refuse('PARTS_MESH_OUTCOME_UNAVAILABLE', `${name}: no mesh; required no mesh outcome`);
    }
    let mesh: { outcome: PartOutcome; note: string; flags: string[] } | undefined;
    if (hasMesh) {
      if (!meshInput || !['pending', 'clean', 'flagged'].includes(String(meshInput.outcome))) {
        return refuse('PARTS_MESH_OUTCOME', `${name}: required mesh outcome pending, clean or flagged`);
      }
      const meshNote = meshInput.note ?? '';
      if (typeof meshNote !== 'string' || meshNote.length > PARTS_NOTE_LIMIT) {
        return refuse('PARTS_MESH_OUTCOME', `${name}: required mesh note up to ${PARTS_NOTE_LIMIT} characters`);
      }
      if (meshInput.outcome === 'flagged' && !meshNote.trim()) {
        return refuse('PARTS_VERDICT_NOTE_REQUIRED', `${name}.mesh is flagged and has no note`);
      }
      const meshFlags = Array.isArray(meshInput.flags) ? meshInput.flags.map(String) : [];
      mesh = { outcome: meshInput.outcome as PartOutcome, note: meshNote, flags: meshFlags };
    }
    parts[name] = { ...(mesh ? { mesh } : {}), outcome, note, flags: partFlags };
  }
  const outcomes = Object.values(parts).flatMap(p => (p.mesh ? [p.outcome, p.mesh.outcome] : [p.outcome]));
  if (status === 'approved' && outcomes.some(o => o !== 'clean')) {
    return refuse('PARTS_VERDICT_NOT_CLEAN', 'approved needs every part clean');
  }
  if (status === 'changes-requested' && !outcomes.includes('flagged')) {
    return refuse('PARTS_VERDICT_NOTHING_FLAGGED', 'changes-requested needs at least one flagged part');
  }
  const rawComments = v.schema === 'rig-review-parts-verdict/1' ? [] : (v.comments ?? []);
  if (!Array.isArray(rawComments) || rawComments.length > 1000) {
    return refuse('PARTS_COMMENT_LIMIT', 'comments must be an array of at most 1000 entries');
  }
  const ids = new Set<string>();
  const issues: PartsIssue[] = [];
  const legacyComments: import('./parts-comment.ts').PartsComment[] = [];
  for (const raw of rawComments as unknown[]) {
    const c = await validateStoredPartsComment(pkg, raw, true);
    if (ids.has(c.id)) {
      return refuse('PARTS_COMMENT_DUPLICATE', 'duplicate comment id');
    }
    ids.add(c.id);
    issues.push(c);
    const primary = c.parts[0]!;
    const { mode: _mode, ...restView } = c.view;
    legacyComments.push({
      schema: 'rig-review-parts-comment/1',
      id: c.id,
      part: primary.name,
      imageHash: primary.imageHash,
      sourceHash: c.sourceHash,
      summary: c.summary,
      imageRegion: c.imageRegion!,
      rigRegion: c.rigRegion,
      crop: { ...c.crop, png: c.crop.png ?? '' },
      nativeCrop: c.nativeCrop!,
      view: restView,
    });
  }
  const commentedParts = new Set(issues.flatMap(i => i.parts.map(p => p.name)));
  const flaggedParts: { name: string; note: string }[] = [];
  for (const name of names) {
    const p = parts[name]!;
    const pf = p.outcome === 'flagged';
    const mf = p.mesh?.outcome === 'flagged';
    if ((pf || mf) && !commentedParts.has(name)) {
      flaggedParts.push({
        name,
        note: [pf ? p.note.trim() : '', mf ? p.mesh!.note.trim() : ''].filter(Boolean).join(' / '),
      });
    }
  }
  const legacyRecord: LegacyPartsVerdictRecord = {
    schema: v.schema as LegacyVerdictSchema,
    mode: pkg.mode,
    tool: { name: '@rig-c/review', version },
    source: verdictSource(pkg),
    status,
    parts,
    ...(v.schema === 'rig-review-parts-verdict/1' ? {} : { comments: legacyComments }),
    issues,
    updatedAt: date.toISOString(),
    ...(by ? { by } : {}),
  };
  if (flaggedParts.length > 0 || status === 'pending' || (status === 'approved') !== (issues.length === 0)) {
    const legacy: LegacyPartsVerdictView = {
      schema: v.schema as LegacyVerdictSchema,
      status,
      readOnly: true,
      code: 'PARTS_VERDICT_LEGACY_FORMAT',
      flaggedCount: flaggedParts.length,
      flaggedParts,
      issues,
      ...(by ? { by } : {}),
    };
    return { verdict: null, legacy, legacyRecord };
  }
  const verdict: PartsVerdict = {
    schema: PARTS_VERDICT_SCHEMA,
    mode: pkg.mode,
    tool: { name: '@rig-c/review', version },
    source: verdictSource(pkg),
    status,
    issues,
    updatedAt: date.toISOString(),
    ...(by ? { by } : {}),
  };
  return { verdict, legacy: null, legacyRecord };
}

/** Every file the package was loaded from still has the bytes it was loaded with. */
export async function assertPartsUnchanged(pkg: Pick<PartsViewPackage, 'files' | 'flagFiles' | 'paintingInRig'>): Promise<void> {
  if(pkg.paintingInRig&&await realpath(pkg.paintingInRig.declaredPath).catch(()=>null)!==pkg.paintingInRig.abs)refuse('PARTS_VIEW_SOURCE_CHANGED','declared painting path changed');
  for (const f of [...pkg.files, ...pkg.flagFiles]) {
    if (f.declaredPath && await realpath(f.declaredPath).catch(() => null) !== f.abs) refuse('PARTS_VIEW_SOURCE_CHANGED', 'declared input path changed');
    const now = await hashFile(f.abs).catch(() => null);
    if (!now || now.sha256 !== f.sha256) refuse('PARTS_VIEW_SOURCE_CHANGED', `${basename(f.abs)} changed after the view opened; reopen it to review what is on disk`);
  }
}

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

async function verdictWrite<T>(operation: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'IO';
    throw new Error(`PARTS_VERDICT_WRITE_FAILED: ${operation} (${code})`, {cause: error});
  }
}

export interface PartsSaveReceipt { verdictPath: string; sha256: string; status: VerdictStatus }

/** One durable buffer, shared by standalone and joined saves. Attribution is launch configuration only. */
export async function saveVerdictWithReceipt(pkg: PartsViewPackage, input: unknown,
  assertCurrent?: () => Promise<void>, by?: string): Promise<{verdict: PartsVerdict; receipt: PartsSaveReceipt}> {
  if (by !== undefined && (typeof by !== 'string' || !by.trim())) refuse('PARTS_VERDICT_INVALID', 'reviewer name must be nonblank');
  await assertCurrent?.();
  await assertVerdictDestination(pkg);
  await assertPartsUnchanged(pkg);
  await readVerdict(pkg); // Existing read-side evidence errors must never become an implicit reset.
  const verdict = buildVerdict(pkg, input, await packageVersion(), new Date(), by);
  for(const issue of verdict.issues)await preparePartsComment(pkg,issue,true);
  await assertPartsUnchanged(pkg);
  const bytes = Buffer.from(JSON.stringify(verdict, null, 2) + '\n');
  const parent = dirname(pkg.verdictPath);
  const firstCreated = await verdictWrite('mkdir', () => mkdir(parent, { recursive: true }));
  const tmp = `${pkg.verdictPath}.${crypto.randomUUID()}.tmp`;
  try {
    await verdictWrite('write/fsync', async () => {
      const file = await open(tmp, 'wx');
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
    });
    await assertVerdictDestination(pkg);
    await assertCurrent?.();
    await assertPartsUnchanged(pkg);
    await verdictWrite('rename', () => rename(tmp, pkg.verdictPath));
    // Flush the file's entry and every newly created directory's entry in its parent.
    const last = firstCreated ? dirname(firstCreated) : parent;
    for (let directory = parent; ; directory = dirname(directory)) {
      await verdictWrite('directory fsync', async () => {
        const handle = await open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      });
      if (directory === last) break;
    }
  } finally { await verdictWrite('temporary cleanup', () => rm(tmp, { force: true })); }
  return {verdict, receipt: {verdictPath: pkg.verdictPath, sha256: createHash('sha256').update(bytes).digest('hex'), status: verdict.status}};
}

/** Shared callers retain the ordinary normalized verdict and produce no save notification. */
export async function saveVerdict(pkg: PartsViewPackage, input: unknown, assertCurrent?: () => Promise<void>): Promise<PartsVerdict> {
  const {verdict} = await saveVerdictWithReceipt(pkg, input, assertCurrent);
  return verdict;
}

/** Why a saved verdict is not offered: made on other part files, or on the same files with other producer flags. */
export type VerdictStale = 'files' | 'flags' | null;

/**
 * The saved verdict, when it was made on exactly these files and these producer flags. create gates on
 * `source.sha256` alone; the page also requires `source.flags`, so a reviewer never sees a sign-off over flags they
 * were not shown.
 */
async function readVerdictSnapshot(pkg: PartsViewPackage): Promise<{
  verdict: PartsVerdict | null;
  stale: VerdictStale;
  legacy: LegacyPartsVerdictView | null;
  legacyRecord: LegacyPartsVerdictRecord | null;
  by: string | null;
  savedFileSha256: string | null;
}> {
  let raw: unknown;
  const unavailable = { verdict: null, legacy: null, legacyRecord: null, by: null, savedFileSha256: null };
  let bytes: Buffer;
  try {
    bytes = await readFile(pkg.verdictPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...unavailable, stale: null };
    }
    throw new Error('PARTS_VERDICT_READ: saved verdict cannot be read');
  }
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('PARTS_VERDICT_INVALID: saved verdict is not valid JSON');
  }
  const v = record(raw);
  const source = record(v?.source);
  const now = verdictSource(pkg);
  const isLegacy = Boolean(v && (LEGACY_VERDICT_SCHEMAS as readonly string[]).includes(String(v.schema)));
  if (!v || (v.schema !== PARTS_VERDICT_SCHEMA && !isLegacy) || typeof source?.sha256 !== 'string') {
    throw new Error('PARTS_VERDICT_INVALID: saved verdict schema or binding is invalid');
  }
  let by: string | null = null;
  if (v.schema === 'rig-review-parts-verdict/3' || (v.schema === PARTS_VERDICT_SCHEMA && v.by !== undefined)) {
    if (typeof v.by !== 'string' || !v.by.trim()) {
      refuse('PARTS_VERDICT_INVALID', 'saved reviewer name must be nonblank');
    }
    by = v.by as string;
  }
  if (v.mode !== pkg.mode || source.sha256 !== now.sha256) {
    return { ...unavailable, stale: 'files' };
  }
  if (JSON.stringify(source.flags) !== JSON.stringify(now.flags)) {
    return { ...unavailable, stale: 'flags' };
  }
  const date = new Date(String(v.updatedAt));
  if (!Number.isFinite(date.getTime())) {
    throw new Error('PARTS_VERDICT_INVALID: saved verdict date is invalid');
  }
  const savedFileSha256 = createHash('sha256').update(bytes).digest('hex');
  const version = String(record(v.tool)?.version ?? '');
  if (isLegacy) {
    const decoded = await decodeLegacyVerdict(pkg, v, version, date, by);
    return { ...decoded, stale: null, by, savedFileSha256 };
  }
  const normalized = buildVerdict(pkg, v, version, date, by ?? undefined);
  for (const c of normalized.issues) {
    await validateStoredPartsComment(pkg, c, false);
  }
  return { verdict: normalized, stale: null, legacy: null, legacyRecord: null, by, savedFileSha256 };
}

/** Explicitly project the shared response so retrieval metadata cannot escape through joined wrappers. */
export async function readVerdict(
  pkg: PartsViewPackage,
): Promise<{ verdict: PartsVerdict | null; stale: VerdictStale; legacy?: LegacyPartsVerdictView }> {
  const { verdict, stale, legacy } = await readVerdictSnapshot(pkg);
  return legacy ? { verdict, stale, legacy } : { verdict, stale };
}

/** Validated current or legacy verdict record for CLI read and correction projection paths. */
export async function readPartsVerdictForCli(
  pkg: PartsViewPackage,
): Promise<PartsVerdict | LegacyPartsVerdictRecord | null> {
  const saved = await readVerdictSnapshot(pkg);
  return saved.verdict ?? saved.legacyRecord;
}

/** Standalone CLI retrieval metadata and content come from one validated saved-file buffer. */
export async function readPartsVerdictJson(pkg: PartsViewPackage): Promise<string> {
  const saved = await readVerdictSnapshot(pkg);
  const target = saved.verdict ?? saved.legacyRecord;
  if (!target) {
    return refuse('PARTS_VERDICT_UNAVAILABLE', 'save a verdict first');
  }
  await assertPartsUnchanged(pkg);
  return (
    JSON.stringify(
      {
        ...JSON.parse(exportPartsVerdict(target, 'json')),
        by: saved.by,
        savedFileSha256: saved.savedFileSha256,
      },
      null,
      2,
    ) + '\n'
  );
}

/** What the page reads: no absolute path leaves the server but the verdict file's name. */
export function partsViewJson(
  pkg: PartsViewPackage,
  saved: { verdict: PartsVerdict | null; stale: VerdictStale; legacy?: LegacyPartsVerdictView | null },
) {
  return {
    schema: 'rig-review-parts-view/1',
    mode: pkg.mode,
    title: pkg.title,
    rigSize: pkg.rigSize,
    differenceAvailable: !!pkg.paintingInRig,
    painting: pkg.painting ? { sha256: pkg.painting.sha256, width: pkg.painting.width, height: pkg.painting.height } : null,
    sourceHash: verdictSource(pkg).sha256,
    items: pkg.items.map(item => ({
      ...item,
      ...(pkg.mode === 'parts' ? { imageHash: pkg.files.find(f => f.abs === pkg.imagePaths[item.index])?.sha256 } : {}),
    })),
    pages: pkg.pages,
    flags: pkg.flags,
    readings: pkg.readings ?? [],
    flagSources: pkg.flagFiles.map(f => basename(f.abs)),
    flagMissing: pkg.flagNotes,
    verdictFile: basename(pkg.verdictPath),
    verdict: saved.verdict,
    verdictStale: saved.stale,
    ...(saved.legacy ? { legacyVerdict: saved.legacy } : {}),
  };
}

/** Index → absolute path, for the image routes. */
export function servedImage(pkg: PartsViewPackage, kind: 'image' | 'page', index: number): string | null {
  const list = kind === 'image' ? pkg.imagePaths : pkg.pagePaths;
  return Number.isInteger(index) && index >= 0 && index < list.length ? list[index]! : null;
}

/** Both export forms preserve original text, native and rig coordinates and resolved evidence. */
export function exportPartsVerdict(
  verdict: PartsVerdict | LegacyPartsVerdictRecord,
  format: 'json' | 'issue',
): string {
  const issues = verdict.issues.map(c => {
    const { png, ...crop } = c.crop;
    return {
      ...c,
      crop: { ...crop, path: resolvedCropPath(crop.path) },
      nativeCrop: c.nativeCrop ? { ...c.nativeCrop, path: resolvedCropPath(c.nativeCrop.path) } : null,
    };
  });
  const comments =
    'comments' in verdict && Array.isArray(verdict.comments)
      ? verdict.comments.map(c => {
          const { png, ...crop } = c.crop;
          return {
            ...c,
            crop: { ...crop, path: resolvedCropPath(crop.path) },
            nativeCrop: { ...c.nativeCrop!, path: resolvedCropPath(c.nativeCrop!.path) },
          };
        })
      : undefined;
  if (format === 'json') {
    return (
      JSON.stringify(
        {
          ...verdict,
          issues,
          ...(comments !== undefined ? { comments } : {}),
        },
        null,
        2,
      ) + '\n'
    );
  }
  const commentedParts = new Set(issues.flatMap(i => i.parts.map(p => p.name)));
  const bareFlaggedLines =
    'parts' in verdict && verdict.parts
      ? Object.entries(verdict.parts).flatMap(([name, p]) => {
          const pf = p.outcome === 'flagged';
          const mf = p.mesh?.outcome === 'flagged';
          if ((!pf && !mf) || commentedParts.has(name)) {
            return [];
          }
          const note = [pf ? p.note.trim() : '', mf ? p.mesh!.note.trim() : ''].filter(Boolean).join(' / ');
          return [`\n## ${name}`, note];
        })
      : [];
  return (
    [
      `# Parts review`,
      `Source: ${verdict.source.sha256}`,
      `Status: ${verdict.status}`,
      ...bareFlaggedLines,
      ...issues.flatMap(c => [
        `\n## ${c.parts.map(p => p.name).join(', ')}`,
        `\n### ${c.summary}`,
        `Part: ${c.parts.map(p => `${p.name} · image SHA-256: ${p.imageHash}`).join(', ')}`,
        `Image region: ${JSON.stringify(c.imageRegion)}`,
        `Rig region: ${JSON.stringify(c.rigRegion)}`,
        `Viewport crop: ${c.crop.path} · SHA-256 ${c.crop.sha256}`,
        ...(c.nativeCrop ? [`Native crop: ${c.nativeCrop.path} · SHA-256 ${c.nativeCrop.sha256}`] : []),
        `View: ${JSON.stringify(c.view)}`,
      ]),
    ].join('\n') + '\n'
  );
}

/** Numeric comparison is decoded from bound original PNG bytes on the server, never browser pixels. */
export async function partsDifference(pkg: PartsViewPackage, index: number, threshold: number, footprints: boolean) {
  await assertPartsUnchanged(pkg);
  if (!pkg.paintingInRig) {
    refuse('PARTS_DIFFERENCE_UNAVAILABLE', 'declared painting_in_rig required; legacy records remain readable');
  }
  const item = pkg.items[index];
  if (pkg.mode !== 'parts' || !Number.isInteger(index) || !item) {
    refuse('PARTS_DIFFERENCE_UNAVAILABLE', 'known original part required');
  }
  const decode = async (path: string) => {
    const bytes = await readFile(path);
    if (bytes[24] !== 8 || bytes[25] !== 6) {
      refuse('PARTS_DIFFERENCE_PNG', 'exact RGBA8 operands required');
    }
    return PNG.sync.read(bytes);
  };
  const painting = await decode(pkg.paintingInRig!.abs);
  const part = await decode(pkg.imagePaths[index]!);
  const fronts = footprints
    ? await Promise.all(
        pkg.items
          .filter(
            f =>
              f.index > index &&
              f.x < item!.x + item!.w &&
              f.x + f.w > item!.x &&
              f.y < item!.y + item!.h &&
              f.y + f.h > item!.y,
          )
          .map(async box => ({ box, raster: await decode(pkg.imagePaths[box.index]!) })),
      )
    : [];
  const result = differencePixels(part, item!, painting, fronts, threshold, footprints);
  await assertPartsUnchanged(pkg);
  return result;
}

/** Selected JSON keeps the canonical verdict and names the user's handoff selection. */
export function exportPartsCorrection(
  verdict: PartsVerdict | LegacyPartsVerdictRecord,
  correction: ReturnType<typeof import('./correction-handoff.ts').projectPartsDescription>,
): string {
  return (
    JSON.stringify(
      {
        ...verdict,
        correction: {
          path: 'described',
          stage: correction.stage,
          itemId: correction.itemId,
          part: correction.part,
          verbatim: correction.verbatim,
          selectorArgs: correction.on,
          outcome: null,
          ...('imageHash' in correction ? { imageHash: correction.imageHash } : {}),
        },
      },
      null,
      2,
    ) + '\n'
  );
}
