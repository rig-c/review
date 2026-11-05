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
 * - `check.json`: a gate whose `status` is FAIL or WARN, `seam_pairs` and `figure_openings`, on every part they name.
 *
 * The sign-off is `rig-review-parts-verdict/1` (docs/PARTS_VIEW.md), written beside `parts.json` by default. Its
 * `source.sha256` is the sha256 over the UTF-8 lines `<path>\t<sha256>\n`, sorted by path bytewise, where every path
 * is relative to the verdict file's directory. rig-c/create recomputes it, so the definition is fixed here.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { loadReview, safeFile } from './manifest.ts';

export const PARTS_VERDICT_SCHEMA = 'rig-review-parts-verdict/1';
export const PARTS_VERDICT_FILE = 'parts-review.json';
export const PARTS_NOTE_LIMIT = 10000;
export type PartsViewMode = 'parts' | 'atlas';
export type PartOutcome = 'pending' | 'clean' | 'flagged';
export type VerdictStatus = 'pending' | 'approved' | 'changes-requested';

/** One file the verdict rests on: `path` relative to the verdict file's directory, POSIX separators. */
export interface HashedFile { path: string; bytes: number; sha256: string }
interface LocalFile { abs: string; bytes: number; sha256: string }

/** A part (parts mode) or a named region (atlas mode). Boxes are rig px (parts) or page px (atlas). */
export interface ViewItem {
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
      root: string; status: string | null; entry: Record<string, unknown> };

export interface PartsViewPackage {
  mode: PartsViewMode;
  root: string;
  title: string;
  rigSize: [number, number] | null;
  items: ViewItem[];
  pages: ViewPage[];
  flags: ProducerFlag[];
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

export interface PartsViewOptions { meshReport?: string; check?: string; verdict?: string }

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

async function readJson(abs: string, what: string): Promise<unknown> {
  try { return JSON.parse(await readFile(abs, 'utf8')); } catch (e) { return refuse('PARTS_FLAGS_MALFORMED', `${what}: ${e instanceof Error ? e.message : String(e)}`); }
}

/**
 * Flags from the producer files: explicit paths win; otherwise where rig-parts writes them in a build root — `rig`
 * writes `mesh_report.json` beside `parts.json` in `rig/`, and `check` writes `check/check.json` beside `rig/`.
 * `rigDir` is that `rig/` directory (parts mode) or null (atlas mode: explicit paths only, or `buildRoot`'s files).
 */
async function producerFlags(rigDir: string | null, buildRoot: string | null, names: ReadonlySet<string>, options: PartsViewOptions): Promise<{ flags: ProducerFlag[]; files: LocalFile[]; notes: string[] }> {
  const flags: ProducerFlag[] = [], files: LocalFile[] = [], notes: string[] = [];
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
  if (check) { files.push(await hashFile(check)); flags.push(...checkFlags(await readJson(check, 'check.json'), names)); }
  else notes.push('check.json');
  return { flags, files, notes };
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
  const { flags, files: flagFiles, notes } = await producerFlags(root, null, seen, options);
  const protectedPaths = [join(root, 'rig.json'), join(root, 'config.json'), join(root, 'review.json'), join(root, 'report.json')];
  if (basename(root) === 'rig') protectedPaths.push(...['parts.json', 'config.json', 'review.json', 'report.json'].map(name => join(dirname(root), name)));
  return { mode: 'parts', root, title: basename(root) === 'rig' ? basename(dirname(root)) : basename(root), rigSize, items, pages: [], flags, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath: options.verdict ? resolve(options.verdict) : join(root, PARTS_VERDICT_FILE), imagePaths, pagePaths: [] };
}

async function loadAtlasMode(input: string, options: PartsViewOptions): Promise<PartsViewPackage> {
  const p = await loadReview(input);
  const modelPath = p.manifest.model;
  if (!modelPath) return refuse('PARTS_VIEW_NO_ATLAS', `${input} holds neither parts.json nor a compiled model with pages`);
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
  const { flags, files: flagFiles, notes } = await producerFlags(null, buildRoot, names, options);
  const protectedPaths = [...p.files].map(path => resolve(p.root, path));
  protectedPaths.push(...['rig.json', 'config.json', 'report.json', 'review.json'].map(name => join(p.root, name)));
  if (p.handoff) protectedPaths.push(...p.handoff.record.files.map(file => resolve(p.root, file.path)));
  if (buildRoot) protectedPaths.push(...['parts.json', 'config.json', 'rig/rig.json', 'rig/parts.json'].map(name => join(buildRoot, name)));
  return { mode: 'atlas', root: p.root, title: p.manifest.title, rigSize: null, items, pages, flags, files, flagFiles, flagNotes: notes, protectedPaths, verdictPath: options.verdict ? resolve(options.verdict) : join(dirname(modelAbs), PARTS_VERDICT_FILE), imagePaths: [], pagePaths };
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
async function assertVerdictDestination(pkg: PartsViewPackage): Promise<void> {
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
  parts: Record<string, { outcome: PartOutcome; note: string; flags: string[] }>;
  updatedAt: string;
}

/** What the page submits: the status and every item's outcome and note. */
export interface VerdictSubmission { status: VerdictStatus; parts: Record<string, { outcome: PartOutcome; note?: string }> }

/** The distinct names, in item order (atlas sequence frames share a name). */
export const itemNames = (pkg: Pick<PartsViewPackage, 'items'>): string[] => [...new Set(pkg.items.map(i => i.name))];

/** Builds the verdict document, or refuses by name. Pure but for the clock. */
export function buildVerdict(pkg: Pick<PartsViewPackage, 'mode' | 'items' | 'flags' | 'files' | 'flagFiles' | 'verdictPath'>, input: unknown, version: string, now = new Date()): PartsVerdict {
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
    parts[name] = { outcome, note, flags: [...new Set(pkg.flags.filter(f => f.item === name).map(f => f.id))] };
  }
  const outcomes = Object.values(parts).map(p => p.outcome);
  if (status === 'approved' && outcomes.some(o => o !== 'clean')) refuse('PARTS_VERDICT_NOT_CLEAN', `approved needs every part clean; ${outcomes.filter(o => o !== 'clean').length} are not`);
  if (status === 'changes-requested' && !outcomes.includes('flagged')) refuse('PARTS_VERDICT_NOTHING_FLAGGED', 'changes-requested needs at least one flagged part');
  return { schema: PARTS_VERDICT_SCHEMA, mode: pkg.mode, tool: { name: '@rig-c/review', version }, source: verdictSource(pkg), status, parts, updatedAt: now.toISOString() };
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
  const verdict = buildVerdict(pkg, input, await packageVersion());
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
  try { raw = JSON.parse(await readFile(pkg.verdictPath, 'utf8')); } catch { return { verdict: null, stale: null }; }
  const v = record(raw), source = record(v?.source), now = verdictSource(pkg);
  if (!v || v.schema !== PARTS_VERDICT_SCHEMA || v.mode !== pkg.mode || source?.sha256 !== now.sha256) return { verdict: null, stale: 'files' };
  if (JSON.stringify(source.flags) !== JSON.stringify(now.flags)) return { verdict: null, stale: 'flags' };
  return { verdict: v as unknown as PartsVerdict, stale: null };
}

/** What the page reads: no absolute path leaves the server but the verdict file's name. */
export function partsViewJson(pkg: PartsViewPackage, saved: { verdict: PartsVerdict | null; stale: VerdictStale }) {
  return {
    schema: 'rig-review-parts-view/1', mode: pkg.mode, title: pkg.title, rigSize: pkg.rigSize,
    items: pkg.items, pages: pkg.pages, flags: pkg.flags,
    flagSources: pkg.flagFiles.map(f => basename(f.abs)), flagMissing: pkg.flagNotes,
    verdictFile: basename(pkg.verdictPath), verdict: saved.verdict, verdictStale: saved.stale,
  };
}

/** Index → absolute path, for the image routes. */
export function servedImage(pkg: PartsViewPackage, kind: 'image' | 'page', index: number): string | null {
  const list = kind === 'image' ? pkg.imagePaths : pkg.pagePaths;
  return Number.isInteger(index) && index >= 0 && index < list.length ? list[index]! : null;
}

