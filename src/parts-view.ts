/**
 * The parts and atlas view (#348): every part as an image, before any rig is built, and the atlas a built rig ships.
 *
 * Two inputs open it:
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
import {assertOriginalPaintingSize} from './parts-comparison.ts';
import {parsePartsComment,assertPartsCommentBinding,type PartsComment} from './parts-comment.ts';
import {preparePartsComment,validateStoredPartsComment} from './parts-comment-crops.ts';
import {resolvedCropPath} from './comment-crops.ts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import { loadReview, safeFile, packagePath, type ReviewPackage } from './manifest.ts';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/2';
export const PARTS_VERDICT_FILE = 'parts-review.json';
export const PARTS_NOTE_LIMIT = 10000;
export type PartsViewMode = 'parts' | 'atlas';
export type PartOutcome = 'pending' | 'clean' | 'flagged';
export type VerdictStatus = 'pending' | 'approved' | 'changes-requested';

/** One file the verdict rests on: `path` relative to the verdict file's directory, POSIX separators. */
export interface HashedFile { path: string; bytes: number; sha256: string }
interface LocalFile { abs: string; bytes: number; sha256: string }

/** A part (parts mode) or a named region (atlas mode). Boxes are rig px (parts) or page px (atlas). */
export interface PartMesh { vertices: number[]; triangles: number[]; figures: Record<string, unknown>; width: number; height: number; image: string }
export interface ViewItem {
  mesh?: PartMesh;
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

export interface PartsViewOptions { rig?: string; meshReport?: string; check?: string; verdict?: string;painting?:string }

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
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) refuse(code, `${what} resolves outside ${basename(realRoot)}/ (symlinks may not escape the package)`);
  return real;
}

async function hashFile(abs: string): Promise<LocalFile> {
  const bytes = await readFile(abs);
  return { abs, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
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
    if (hasMetadata || row) {
      const scope = obj.row_scope, kind = obj.row_kind, subjects = obj.row_subjects;
      const valid = ['part', 'pair', 'rig'].includes(String(scope)) && ['finding', 'evidence'].includes(String(kind)) &&
        Array.isArray(subjects) && subjects.length === (scope === 'part' ? 1 : scope === 'pair' ? 2 : 0) &&
        subjects.every(s => typeof s === 'string' && s.length > 0) && new Set(subjects).size === subjects.length;
      const classification = !valid ? 'unclassified' : scope === 'rig' || kind === 'evidence' ? 'evidence' : scope === 'part' ? 'part' : 'pair';
      // Invalid/missing metadata has no implied subjects. Keep it visible globally, unclassified.
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

async function readJson(abs: string, what: string): Promise<unknown> {
  try { return JSON.parse(await readFile(abs, 'utf8')); } catch (e) { return refuse('PARTS_FLAGS_MALFORMED', `${what}: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Flags from the producer files: explicit paths win; otherwise where rig-parts writes them in a build root — `rig`
 * writes `mesh_report.json` beside `parts.json` in `rig/`, and `check` writes `check/check.json` beside `rig/`.
 * `rigDir` is that `rig/` directory (parts mode) or null (atlas mode: explicit paths only, or `buildRoot`'s files).
 */
async function producerFlags(rigDir: string | null, buildRoot: string | null, names: ReadonlySet<string>, options: PartsViewOptions): Promise<{ flags: ProducerFlag[]; readings: ProducerFlag[]; files: LocalFile[]; notes: string[] }> {
  const flags: ProducerFlag[] = [], readings: ProducerFlag[] = [], files: LocalFile[] = [], notes: string[] = [];
  // A discovered file must resolve inside the directory it was discovered in; a path given on the command line is the user's own choice.
  const pick = async (explicit: string | undefined, candidates: ([string, string] | null)[], what: string): Promise<string | null> => {
    if (explicit !== undefined) return resolve(explicit);
    const found = candidates.find((c): c is [string, string] => !!c && existsSync(c[1]));
    return found ? insideRoot(found[0], found[1], 'PARTS_FLAGS_OUTSIDE', what) : null;
  };
  const mesh = await pick(options.meshReport, [rigDir ? [rigDir, join(rigDir, 'mesh_report.json')] : null, buildRoot ? [buildRoot, join(buildRoot, 'rig', 'mesh_report.json')] : null], 'mesh_report.json');
  if (mesh) { files.push(await hashFile(mesh)); flags.push(...meshReportFlags(await readJson(mesh, 'mesh_report.json'), names)); }
  else notes.push('mesh_report.json');
  const check = await pick(options.check, [rigDir ? [dirname(rigDir), join(dirname(rigDir), 'check', 'check.json')] : null, buildRoot ? [buildRoot, join(buildRoot, 'check', 'check.json')] : null], 'check/check.json');
  if (check) { files.push(await hashFile(check)); const doc = await readJson(check, 'check.json'); flags.push(...checkFlags(doc, names)); readings.push(...checkReadings(doc, names)); }
  else notes.push('check.json');
  return { flags, readings, files, notes };
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
      if (item!.mesh) refuse('PARTS_MESH_AMBIGUOUS', `${name}: found multiple meshes; required one attachment`);
      if (!finite(a.width, 1) || !Number.isInteger(a.width) || !finite(a.height, 1) || !Number.isInteger(a.height) || typeof a.image !== 'string') refuse('PARTS_MESH_SIZE', `${name}: found invalid raster declaration; required image and positive integer dimensions`);
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

async function loadPartsMode(root: string, options: PartsViewOptions): Promise<PartsViewPackage> {
  const partsJson = await insideRoot(root, join(root, 'parts.json'), 'PARTS_FILE_OUTSIDE', 'parts.json');
  const doc = record(await readJson(partsJson, 'parts.json'));
  const list = doc?.parts;
  if (!doc || !Array.isArray(list)) return refuse('PARTS_JSON_MALFORMED', 'parts.json has no parts[] array');
  const size = doc.rig_size;
  const rigSize: [number, number] | null = Array.isArray(size) && size.length === 2 && finite(size[0], 1) && finite(size[1], 1) ? [size[0], size[1]] : null;
  const items: ViewItem[] = [], imagePaths: string[] = [], files: LocalFile[] = [await hashFile(partsJson)];
  const seen = new Set<string>();
  for (const [index, raw] of list.entries()) {
    const p = record(raw);
    if (!p || typeof p.name !== 'string' || !finite(p.x, -1e9) || !finite(p.y, -1e9) || !finite(p.w, 1) || !finite(p.h, 1)) refuse('PARTS_JSON_MALFORMED', `parts[${index}] needs name, x, y, w, h`);
    const part = p as { name: string; x: number; y: number; w: number; h: number };
    if (seen.has(part.name)) refuse('PARTS_JSON_MALFORMED', `part ${part.name} appears twice`);
    seen.add(part.name);
    const abs = join(root, 'parts', partFileName(part.name));
    if (!existsSync(abs)) refuse('PARTS_IMAGE_MISSING', `parts/${part.name}.png is named in parts.json and is not on disk`);
    // Hashed and served by its real path, so a link swapped after load cannot redirect what the page is shown.
    const real = await insideRoot(root, abs, 'PARTS_IMAGE_OUTSIDE', `parts/${part.name}.png`);
    files.push(await hashFile(real));
    imagePaths.push(real);
    items.push({ name: part.name, index, x: part.x, y: part.y, w: part.w, h: part.h, image: true });
  }
  let painting:PartsViewPackage['painting'];if(options.painting){
    const candidate=resolve(options.painting),rel=relative(resolve(root),candidate);if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))refuse('PARTS_PAINTING_OUTSIDE','painting must be inside the parts package');
    let abs:string,bytes:Buffer;try{abs=await insideRoot(root,candidate,'PARTS_PAINTING_OUTSIDE','painting');packagePath(relative(root,abs).split(sep).join('/'),'painting');bytes=await readFile(abs);}catch(error){if(error instanceof Error&&error.message.startsWith('PARTS_PAINTING_OUTSIDE:'))throw error;refuse('PARTS_PAINTING_UNAVAILABLE','painting must be a readable portable package PNG');}
    let png:PNG;try{png=PNG.sync.read(bytes!);}catch{refuse('PARTS_PAINTING_PNG','painting must be a valid PNG');}
    assertOriginalPaintingSize(png!.width,png!.height,rigSize,doc.scale_rig_per_source);
    const file={abs:abs!,bytes:bytes!.length,sha256:createHash('sha256').update(bytes!).digest('hex')};painting={...file,width:png!.width,height:png!.height};files.push(file);
  }
  const { flags, readings, files: flagFiles, notes } = await producerFlags(root, null, seen, options);
  const protectedPaths = [join(root, 'rig.json'), join(root, 'config.json'), join(root, 'review.json'), join(root, 'report.json')];
  if (basename(root) === 'rig') protectedPaths.push(...['parts.json', 'config.json', 'review.json', 'report.json'].map(name => join(dirname(root), name)));
  if (options.rig !== undefined) protectedPaths.push(resolve(options.rig));
  const verdictPath = options.verdict ? resolve(options.verdict) : join(root, PARTS_VERDICT_FILE);
  await assertVerdictDestination({ files, flagFiles, protectedPaths, verdictPath });
  const rigPath = options.rig !== undefined ? resolve(options.rig) : existsSync(join(root, 'rig.json')) ? await insideRoot(root, join(root, 'rig.json'), 'PARTS_MESH_OUTSIDE', 'rig.json') : null;
  if (rigPath) {
    const report = notes.includes('mesh_report.json') ? undefined : flagFiles[0];
    const rigBytes = await readFile(rigPath);
    let rig: unknown;
    try { rig = JSON.parse(rigBytes.toString('utf8')); }
    catch (e) { return refuse('PARTS_MESH_MALFORMED', `rig.json: ${e instanceof Error ? e.message : String(e)}`); }
    readPartMeshes(rig, items, report ? await readJson(report.abs, 'mesh_report.json') : null);
    await locateMeshRasters(rig, dirname(rigPath), items, imagePaths, files);
    // Bind exactly the bytes parsed above, even if the path is replaced during raster checks.
    files.push({ abs: rigPath, bytes: rigBytes.length, sha256: createHash('sha256').update(rigBytes).digest('hex') });
    if (report) files.push(report);
  }
  return { ...(painting?{painting}:{}),mode: 'parts', root, title: basename(root) === 'rig' ? basename(dirname(root)) : basename(root), rigSize, items, pages: [], flags, readings, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath, imagePaths, pagePaths: [] };
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
  const model = record(JSON.parse(await readFile(modelAbs, 'utf8')));
  const pagesRaw = model?.pages;
  if (!Array.isArray(pagesRaw)) return refuse('PARTS_VIEW_NO_ATLAS', `${modelPath} declares no pages`);
  const pages: ViewPage[] = [], pagePaths: string[] = [], items: ViewItem[] = [], files: LocalFile[] = [await hashFile(modelAbs)];
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
  return { mode: 'atlas', root: p.root, title: p.manifest.title, rigSize: null, items, pages, flags, readings, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath: options.verdict ? resolve(options.verdict) : join(dirname(modelAbs), PARTS_VERDICT_FILE), imagePaths: [], pagePaths };
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
  parts: Record<string, { outcome: PartOutcome; note: string; flags: string[]; mesh?: { outcome: PartOutcome; note: string } }>;
  comments: PartsComment[];
  updatedAt: string;
}

/** What the page submits: the status and every item's outcome and note. */
export interface VerdictSubmission { status: VerdictStatus; parts: Record<string, { outcome: PartOutcome; note?: string }> }

/** The distinct names, in item order (atlas sequence frames share a name). */
export const itemNames = (pkg: Pick<PartsViewPackage, 'items'>): string[] => [...new Set(pkg.items.map(i => i.name))];

/** Builds the verdict document, or refuses by name. Pure but for the clock. */
export function buildVerdict(pkg: Pick<PartsViewPackage, 'mode' | 'items' | 'flags' | 'files' | 'flagFiles' | 'verdictPath' | 'imagePaths' | 'painting'>, input: unknown, version: string, now = new Date()): PartsVerdict {
  const body = record(input);
  if (!body) return refuse('PARTS_VERDICT_INVALID', 'expected { status, parts }');
  const status = body.status;
  if (status !== 'pending' && status !== 'approved' && status !== 'changes-requested') return refuse('PARTS_VERDICT_INVALID', 'status is pending, approved or changes-requested');
  const given = record(body.parts);
  if (!given) return refuse('PARTS_VERDICT_INVALID', 'parts is an object keyed by part name');
  const names = itemNames(pkg), known = new Set(names);
  for (const name of Object.keys(given)) if (!known.has(name)) refuse('PARTS_VERDICT_UNKNOWN_PART', `${name} is not a part of this input`);
  const parts: PartsVerdict['parts'] = {};
  for (const name of names) {
    const entry = record(given[name]);
    if (!entry) return refuse('PARTS_VERDICT_MISSING_PART', `${name} has no entry`);
    const outcome = entry.outcome;
    if (outcome !== 'pending' && outcome !== 'clean' && outcome !== 'flagged') return refuse('PARTS_VERDICT_INVALID', `${name}.outcome is pending, clean or flagged`);
    const note = entry.note === undefined ? '' : entry.note;
    if (typeof note !== 'string' || note.length > PARTS_NOTE_LIMIT) return refuse('PARTS_VERDICT_INVALID', `${name}.note is a string of at most ${PARTS_NOTE_LIMIT} characters`);
    if (outcome === 'flagged' && !note.trim()) return refuse('PARTS_VERDICT_NOTE_REQUIRED', `${name} is flagged and has no note saying what is wrong`);
    const meshInput = record(entry.mesh);
    const hasMesh = pkg.items.some(i => i.name === name && i.mesh);
    if (!hasMesh && entry.mesh !== undefined) refuse('PARTS_MESH_OUTCOME_UNAVAILABLE', `${name}: no mesh; required no mesh outcome`);
    let mesh: { outcome: PartOutcome; note: string } | undefined;
    if (hasMesh) {
      if (!meshInput || !['pending', 'clean', 'flagged'].includes(String(meshInput.outcome))) refuse('PARTS_MESH_OUTCOME', `${name}: required mesh outcome pending, clean or flagged`);
      const meshNote = meshInput!.note ?? '';
      if (typeof meshNote !== 'string' || meshNote.length > PARTS_NOTE_LIMIT) refuse('PARTS_MESH_OUTCOME', `${name}: required mesh note up to ${PARTS_NOTE_LIMIT} characters`);
      if (meshInput!.outcome === 'flagged' && !(meshNote as string).trim()) refuse('PARTS_VERDICT_NOTE_REQUIRED', `${name}.mesh is flagged and has no note`);
      mesh = { outcome: meshInput!.outcome as PartOutcome, note: meshNote as string };
    }
    parts[name] = { ...(mesh ? { mesh } : {}), outcome, note, flags: [...new Set(pkg.flags.filter(f => f.item === name).map(f => f.id))] };
  }
  const outcomes = Object.values(parts).flatMap(p => p.mesh ? [p.outcome, p.mesh.outcome] : [p.outcome]);
  if (status === 'approved' && outcomes.some(o => o !== 'clean')) refuse('PARTS_VERDICT_NOT_CLEAN', `approved needs every part clean; ${outcomes.filter(o => o !== 'clean').length} are not`);
  if (status === 'changes-requested' && !outcomes.includes('flagged')) refuse('PARTS_VERDICT_NOTHING_FLAGGED', 'changes-requested needs at least one flagged part');
  const comments=body.comments??[];if(!Array.isArray(comments)||comments.length>1000)refuse('PARTS_COMMENT_LIMIT','comments must be an array of at most 1000 entries');
  const ids=new Set<string>();for(const raw of comments as unknown[]){const c=parsePartsComment(raw);if(c.view.comparison?.mode==='overlay'&&!pkg.painting)refuse('PARTS_COMPARISON_UNAVAILABLE','original painting required');const item=pkg.items.find(i=>i.name===c.part);if(!item||pkg.mode!=='parts')refuse('PARTS_COMMENT_UNAVAILABLE','original part required');if(ids.has(c.id))refuse('PARTS_COMMENT_DUPLICATE','duplicate comment id');ids.add(c.id);const file=pkg.files.find(f=>f.abs===pkg.imagePaths[item!.index]);assertPartsCommentBinding(c,item!,file?.sha256??'',verdictSource(pkg).sha256);}
  return { schema: PARTS_VERDICT_SCHEMA, mode: pkg.mode, tool: { name: '@rig-c/review', version }, source: verdictSource(pkg), status, parts, comments:comments as PartsComment[], updatedAt: now.toISOString() };
}

/** Every file the package was loaded from still has the bytes it was loaded with. */
export async function assertPartsUnchanged(pkg: Pick<PartsViewPackage, 'files' | 'flagFiles'>): Promise<void> {
  for (const f of [...pkg.files, ...pkg.flagFiles]) {
    const now = await hashFile(f.abs).catch(() => null);
    if (!now || now.sha256 !== f.sha256) refuse('PARTS_VIEW_SOURCE_CHANGED', `${basename(f.abs)} changed after the view opened; reopen it to review what is on disk`);
  }
}

async function packageVersion(): Promise<string> {
  return (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

/** Writes the verdict atomically beside its sources. */
export async function saveVerdict(pkg: PartsViewPackage, input: unknown): Promise<PartsVerdict> {
  await assertVerdictDestination(pkg);
  await assertPartsUnchanged(pkg);
  await readVerdict(pkg); // Existing read-side evidence errors must never become an implicit reset.
  const verdict = buildVerdict(pkg, input, await packageVersion());
  for(const comment of verdict.comments)await preparePartsComment(pkg,comment,true);
  await assertPartsUnchanged(pkg);
  await mkdir(dirname(pkg.verdictPath), { recursive: true });
  const tmp = `${pkg.verdictPath}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' });
    await assertVerdictDestination(pkg);
    await rename(tmp, pkg.verdictPath);
  } finally { await rm(tmp, { force: true }); }
  return verdict;
}

/** Why a saved verdict is not offered: made on other part files, or on the same files with other producer flags. */
export type VerdictStale = 'files' | 'flags' | null;

/**
 * The saved verdict, when it was made on exactly these files and these producer flags. create gates on
 * `source.sha256` alone; the page also requires `source.flags`, so a reviewer never sees a sign-off over flags they
 * were not shown.
 */
export async function readVerdict(pkg: PartsViewPackage): Promise<{ verdict: PartsVerdict | null; stale: VerdictStale }> {
  let raw: unknown;
  let text:string;try{text=await readFile(pkg.verdictPath,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {verdict:null,stale:null};throw new Error('PARTS_VERDICT_READ: saved verdict cannot be read');}
  try{raw=JSON.parse(text);}catch{throw new Error('PARTS_VERDICT_INVALID: saved verdict is not valid JSON');}
  const v = record(raw), source = record(v?.source), now = verdictSource(pkg);
  if(!v||![PARTS_VERDICT_SCHEMA,'rig-review-parts-verdict/1'].includes(String(v.schema))||typeof source?.sha256!=='string')throw new Error('PARTS_VERDICT_INVALID: saved verdict schema or binding is invalid');
  if(v.mode!==pkg.mode||source.sha256!==now.sha256)return {verdict:null,stale:'files'};
  if (JSON.stringify(source.flags) !== JSON.stringify(now.flags)) return { verdict: null, stale: 'flags' };
  const date=new Date(String(v.updatedAt));if(!Number.isFinite(date.getTime()))throw new Error('PARTS_VERDICT_INVALID: saved verdict date is invalid');
  const normalized=buildVerdict(pkg,{...v,comments:v.schema==='rig-review-parts-verdict/1'?[]:v.comments},String(record(v.tool)?.version??''),date);for(const c of normalized.comments)await validateStoredPartsComment(pkg,c);return {verdict:normalized,stale:null};
}

/** What the page reads: no absolute path leaves the server but the verdict file's name. */
export function partsViewJson(pkg: PartsViewPackage, saved: { verdict: PartsVerdict | null; stale: VerdictStale }) {
  return {
    schema: 'rig-review-parts-view/1', mode: pkg.mode, title: pkg.title, rigSize: pkg.rigSize,
    painting:pkg.painting?{sha256:pkg.painting.sha256,width:pkg.painting.width,height:pkg.painting.height}:null,
    sourceHash:verdictSource(pkg).sha256,
    items:pkg.items.map(item=>({...item,...(pkg.mode==='parts'?{imageHash:pkg.files.find(f=>f.abs===pkg.imagePaths[item.index])?.sha256}:{})})), pages: pkg.pages, flags: pkg.flags, readings: pkg.readings ?? [],
    flagSources: pkg.flagFiles.map(f => basename(f.abs)), flagMissing: pkg.flagNotes,
    verdictFile: basename(pkg.verdictPath), verdict: saved.verdict, verdictStale: saved.stale,
  };
}

/** Index → absolute path, for the image routes. */
export function servedImage(pkg: PartsViewPackage, kind: 'image' | 'page', index: number): string | null {
  const list = kind === 'image' ? pkg.imagePaths : pkg.pagePaths;
  return Number.isInteger(index) && index >= 0 && index < list.length ? list[index]! : null;
}


/** Both export forms preserve original text, native and rig coordinates and resolved evidence. */
export function exportPartsVerdict(verdict:PartsVerdict,format:'json'|'issue'):string {
 const comments=verdict.comments.map(c=>{const {png,...crop}=c.crop;return {...c,crop:{...crop,path:resolvedCropPath(crop.path)},nativeCrop:c.nativeCrop?{...c.nativeCrop,path:resolvedCropPath(c.nativeCrop.path)}:null};});
 if(format==='json')return JSON.stringify({...verdict,comments},null,2)+'\n';
 return [`# Parts review`, `Source: ${verdict.source.sha256}`,`Status: ${verdict.status}`,...Object.entries(verdict.parts).flatMap(([name,p])=>[`\n## ${name}`,`${p.outcome}: ${p.note}`,...comments.filter(c=>c.part===name).flatMap(c=>[`\n### ${c.summary}`,`Part: ${c.part} · image SHA-256: ${c.imageHash}`,`Image region: ${JSON.stringify(c.imageRegion)}`,`Rig region: ${JSON.stringify(c.rigRegion)}`,`Viewport crop: ${c.crop.path} · SHA-256 ${c.crop.sha256}`,`Native crop: ${c.nativeCrop!.path} · SHA-256 ${c.nativeCrop!.sha256}`,`View: ${JSON.stringify(c.view)}`])])].join('\n')+'\n';
}
