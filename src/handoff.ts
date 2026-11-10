/**
 * Producer handoff (#101): which producer config, parts and inspected rig the package was built from, so an Apply can
 * rebuild through the installed producer and the AI receiving the review can rebuild exactly that state.
 *
 * Declared first — `rig-review open <dir> --config <path> …`, else the `producer` block in review.json — then a fixed
 * discovery order, never a search: `config.json`, then `rig/config.json` inside the opened folder, and as the last step
 * `../config.json` beside an opened `out/`. That last one sits outside the opened folder, so the record names it
 * `discovered` with `outside: true`, its path and its hash. Every path is literal and must stay inside its root (the
 * package root; for the `../config.json` step, the folder that holds `out/`); a symlink that leaves it is refused by name.
 * The record (paths relative to the package root, hashes, how it was found) is part of `reviewedSource`, so changing a
 * handoff file's bytes starts a new pending session.
 *
 * A rig-parts build root (#149, {@link isBuildRoot}) opens as its `check/` package. For that package the producer's own
 * config for the build is the regular file `config.json` in the build root, else in the folder that holds it — the two
 * places `rig-parts build --config <dir>/config.json --out <dir>/out` leaves it. The build writes no record of its
 * config, so this is a location rule bounded by the build's own files, not a proof: the session baseline (the producer
 * rebuilding the inspected rig from that config) is the check. Discovered there, or declared with `--config` at exactly
 * one of those two files, the handoff's root is that file's folder and the parts directory is the build root.
 *
 * #329: a discovered handoff knows its source painting by one fixed name beside the config it found, `painting.png`
 * (so `../painting.png` beside an opened `out/`, `../../painting.png` beside a build root), never by a search. It is
 * held to the config's own refusals at that place — inside the same root, and at the two places outside the opened
 * folder no symlink at all — and when present it is the record's `source` like a declared one.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { findPackage, MODELING_PRODUCER_NOT_INSTALLED, PRODUCER_PACKAGE } from './producer.ts';

export const HANDOFF_SCHEMA = 'rig-review-handoff/1';
/** The fixed discovery order, as the refusal names it. */
export const DISCOVERY_PLACES = ['config.json', 'rig/config.json', '../config.json (beside an opened out/)'] as const;
export const HANDOFF_DECLARATION = 'rig-review open <dir> --config <path> [--parts <dir>] or the review.json "producer" block';
export const MODELING_INPUT_UNAVAILABLE = `MODELING_INPUT_UNAVAILABLE: config.json — looked at ${DISCOVERY_PLACES.join(', ')}; declare it with ${HANDOFF_DECLARATION}`;
/** #149: the places looked at for the check package of a rig-parts build root, after the in-folder ones. */
export const BUILD_DISCOVERY_PLACES = ['../config.json (in the build root)', '../../config.json (beside the build root)'] as const;
export const BUILD_MODELING_INPUT_UNAVAILABLE = `MODELING_INPUT_UNAVAILABLE: config.json — looked at ${[...DISCOVERY_PLACES.slice(0, 2), ...BUILD_DISCOVERY_PLACES].join(', ')}; declare it with ${HANDOFF_DECLARATION}`;
/** Files the producer reads by the config's own naming, resolved against the config's directory (rig-parts `relativeConfigPaths`). */
export const CONFIG_NAMED_FILES = [['requirements'], ['motion', 'animations_from'], ['generation', 'control', 'skeleton']] as const;
export const CONFIG_SKELETON_NAMES = ['stand_sides', 'stand_clasp'] as const;
/**
 * #591 (create#326, 93b361f8bfec0ec7e20318d9c8e643eef5d7a674): the file a directory reference binds.
 * A See-through occluder plate directory (`comfy plate --mode occluder`) is bound by its producer's receipt;
 * review never hashes or generates plate sibling files.
 */
export const DIRECTORY_INPUT_RECEIPT = 'receipt.json';
/** What `rig-parts rig` writes into its --out and remesh reads from --rig: the rig spec, its motion, the mesh report and the part images. */
export const RIG_FILES = ['rig.json', 'motion.json', 'mesh_report.json'] as const;
const MAX_LISTED = 4096;
/** #329: the fixed name a discovered handoff's source painting has beside its config. */
export const DISCOVERED_PAINTING = 'painting.png';

export interface HandoffDeclaration { config: string; parts?: string; source?: string; full?: string; head?: string; keypoints?: string }
export type HandoffFlags = HandoffDeclaration;
export const HANDOFF_FLAGS = ['config', 'parts', 'source', 'full', 'head', 'keypoints'] as const;
export interface HandoffFile { path: string; sha256: string; directory?: string; spec?: string }
export type ConfigReferenceKind = 'requirements' | 'file' | 'plate';
export interface ConfigReference { at: string; value: string; set: (value: string) => void; kind: ConfigReferenceKind }
/** The identity record: paths relative to the package root (`../` only for the discovered parent config), every hashed file. */
export interface HandoffRecord {
  schema: typeof HANDOFF_SCHEMA;
  how: 'declared' | 'discovered';
  via: 'open --config' | 'review.json producer' | 'discovery';
  outside: boolean;
  config: HandoffFile;
  parts: string | null; rig: string | null; source: HandoffFile | null; full: string | null; head: string | null;
  /** #111: the declared body-18 keypoint file `rig-parts propose --keypoints` reads; the key is absent when none is declared, so an undeclared handoff's identity is unchanged. */
  keypoints?: HandoffFile;
  files: HandoffFile[];
  missing: string[];
}
/** The record plus the absolute paths the producer is run with (never served, never in the identity). */
/** `source` (#109): the declared source painting's absolute path, which `propose --from-config` reads; null when none was declared. */
/** `full` / `head` (#115): the declared See-through runs' absolute paths, which `rig-parts build` reads; null when none was declared. */
/** `keypoints` (#111): the declared keypoint file's absolute path, which a cloth recipe Apply's `propose --keypoints` reads; null when none was declared. */
export interface Handoff { record: HandoffRecord; config: string; parts: string | null; rig: string | null; root: string; flags?: HandoffFlags; source?: string | null; full?: string | null; head?: string | null; keypoints?: string | null; starts?: readonly string[] }
export interface ResolveHandoffOptions { starts?: readonly string[] }

export class HandoffError extends Error {
  constructor(readonly code: string, readonly field: string, readonly detail: string) { super(`${code} ${field}: ${detail}`); }
}
const load = createRequire(import.meta.url);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function expandStarts(starts: readonly string[]): string[] {
  const roots: string[] = [];
  for (const start of starts) {
    if (!start) continue;
    const resolved = resolve(start);
    if (!roots.includes(resolved)) roots.push(resolved);
    try {
      const real = realpathSync(resolved);
      if (!roots.includes(real)) roots.push(real);
    } catch { /* non-existent start path */ }
  }
  return roots;
}

/** Resolve the nearest installed `@rig-c/parts` package directory using `findPackage` from `src/producer.ts`. */
export function findInstalledParts(starts: readonly string[] = [process.cwd()]): string | null {
  const manifest = findPackage(PRODUCER_PACKAGE, expandStarts(starts));
  if (!manifest) return null;
  try { return realpathSync(dirname(manifest)); } catch { return dirname(manifest); }
}

/** Resolve the nearest installed `@rig-c/parts` package directory, or refuse by name when absent. */
export function locateInstalledParts(starts: readonly string[] = [process.cwd()]): string {
  const found = findInstalledParts(starts);
  if (!found) throw new HandoffError('HANDOFF_INPUT_INVALID', 'config', MODELING_PRODUCER_NOT_INSTALLED);
  return found;
}

export function classifyConfigReference(at: string): ConfigReferenceKind | null {
  if (at === 'requirements') return 'requirements';
  if (at === 'motion.animations_from' || at === 'generation.control.skeleton' || /^assemble\.occluders\[\d+\]\.image$/.test(at)) return 'file';
  if (/^assemble\.occluders\[\d+\]\.plate$/.test(at)) return 'plate';
  return null;
}

function undeclaredOccluderReference(raw: unknown, declaredAt: ReadonlySet<string>): string | null {
  const assemble = isPlainObject(raw) ? raw.assemble : undefined;
  const occluders = isPlainObject(assemble) && Array.isArray(assemble.occluders) ? assemble.occluders : [];
  for (let i = 0; i < occluders.length; i++) {
    const entry = occluders[i];
    if (!isPlainObject(entry)) continue;
    if (typeof entry.image === 'string' && entry.image !== '' && !declaredAt.has(`assemble.occluders[${i}].image`)) {
      return `assemble.occluders[${i}].image`;
    }
    if (typeof entry.plate === 'string' && entry.plate !== '' && !declaredAt.has(`assemble.occluders[${i}].plate`)) {
      return `assemble.occluders[${i}].plate`;
    }
  }
  return null;
}

function fallbackNamedReferences(raw: Record<string, unknown>): ConfigReference[] {
  const out: ConfigReference[] = [];
  if (typeof raw.requirements === 'string' && raw.requirements !== '') {
    out.push({ at: 'requirements', value: raw.requirements, set: value => { raw.requirements = value; }, kind: 'requirements' });
  }
  const motion = isPlainObject(raw.motion) ? raw.motion : null;
  if (motion && typeof motion.animations_from === 'string' && motion.animations_from !== '') {
    out.push({ at: 'motion.animations_from', value: motion.animations_from, set: value => { motion.animations_from = value; }, kind: 'file' });
  }
  const generation = isPlainObject(raw.generation) ? raw.generation : null;
  const control = generation && isPlainObject(generation.control) ? generation.control : null;
  if (control && typeof control.skeleton === 'string' && control.skeleton !== '' && !(CONFIG_SKELETON_NAMES as readonly string[]).includes(control.skeleton)) {
    out.push({ at: 'generation.control.skeleton', value: control.skeleton, set: value => { control.skeleton = value; }, kind: 'file' });
  }
  return out;
}

/**
 * #591: enumerate config-named references from the installed `@rig-c/parts` `configFileReferences` export (stable since v2.23.0).
 * Refuses by name when a parts reference is unknown to the handoff or when an older/absent loader omits a declared occluder input,
 * while preserving read-only inspection for non-occluder configs when optional `@rig-c/parts` is not installed.
 */
export function configNamedReferences(
  raw: unknown,
  starts: readonly string[] = [process.cwd()],
): { partsRoot: string | null; references: ConfigReference[] } {
  const partsRoot = findInstalledParts(starts);
  if (!isPlainObject(raw)) return { partsRoot, references: [] };
  const configModulePath = partsRoot ? join(partsRoot, 'src', 'config.ts') : null;
  if (!partsRoot || !configModulePath || !existsSync(configModulePath)) {
    const missingOccluder = undeclaredOccluderReference(raw, new Set());
    if (missingOccluder) {
      if (!partsRoot) {
        throw new HandoffError('HANDOFF_INPUT_INVALID', `config ${missingOccluder}`, MODELING_PRODUCER_NOT_INSTALLED);
      }
      const pkg = JSON.parse(readFileSync(join(partsRoot, 'package.json'), 'utf8')) as { version?: string };
      throw new HandoffError('HANDOFF_INPUT_INVALID', `config ${missingOccluder}`, `@rig-c/parts ${pkg.version ?? 'unknown'} has no configFileReferences export; install a version providing occluder file declarations`);
    }
    return { partsRoot, references: fallbackNamedReferences(raw) };
  }
  const mod = load(configModulePath) as { configFileReferences?: (config: unknown) => { at: string; value: string; set: (value: string) => void }[] };
  if (typeof mod.configFileReferences !== 'function') {
    const missingOccluder = undeclaredOccluderReference(raw, new Set());
    const pkg = JSON.parse(readFileSync(join(partsRoot, 'package.json'), 'utf8')) as { version?: string };
    if (missingOccluder) {
      throw new HandoffError('HANDOFF_INPUT_INVALID', `config ${missingOccluder}`, `@rig-c/parts ${pkg.version ?? 'unknown'} has no configFileReferences export; install a version providing occluder file declarations`);
    }
    return { partsRoot, references: fallbackNamedReferences(raw) };
  }
  const rawRefs = mod.configFileReferences(raw);
  const missingOccluder = undeclaredOccluderReference(raw, new Set(rawRefs.map(r => r.at)));
  if (missingOccluder) {
    const pkg = JSON.parse(readFileSync(join(partsRoot, 'package.json'), 'utf8')) as { version?: string };
    throw new HandoffError('HANDOFF_INPUT_INVALID', `config ${missingOccluder}`, `@rig-c/parts ${pkg.version ?? 'unknown'} configFileReferences does not declare ${missingOccluder}; install a version providing occluder file declarations`);
  }
  const references: ConfigReference[] = [];
  for (const ref of rawRefs) {
    const kind = classifyConfigReference(ref.at);
    if (!kind) throw new HandoffError('HANDOFF_INPUT_INVALID', `config ${ref.at}`, `unsupported config file reference ${ref.at}`);
    references.push({ ...ref, kind });
  }
  return { partsRoot, references };
}

/** Read `PLATE_RECEIPT_SPEC` from the installed `@rig-c/parts/src/plate.ts` without copying the constant into review. */
export function plateReceiptSpec(partsRoot: string | null, field = 'config'): string {
  if (!partsRoot) throw new HandoffError('HANDOFF_INPUT_INVALID', field, MODELING_PRODUCER_NOT_INSTALLED);
  let spec: unknown;
  try { spec = (load(join(partsRoot, 'src', 'plate.ts')) as { PLATE_RECEIPT_SPEC?: unknown }).PLATE_RECEIPT_SPEC; } catch { spec = undefined; }
  if (typeof spec !== 'string' || !spec) {
    const pkg = JSON.parse(readFileSync(join(partsRoot, 'package.json'), 'utf8')) as { version?: string };
    throw new HandoffError('HANDOFF_INPUT_INVALID', field, `@rig-c/parts ${pkg.version ?? 'unknown'} has no PLATE_RECEIPT_SPEC export in src/plate.ts; install a version declaring the plate receipt spec before binding a directory input`);
  }
  return spec;
}

/** The `spec` a receipt's bytes declare, or null when they are not a JSON object with a string spec. */
export function receiptSpec(bytes: Uint8Array): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return null; }
  return isPlainObject(parsed) && typeof parsed.spec === 'string' ? parsed.spec : null;
}
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (base: string, path: string, allowSelf = false) => { const rel = relative(base, path); return rel === '' ? allowSelf : rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? '';
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return false; throw e; } }

/** A path's own entry (never followed) is of this kind; absent or another kind is false. */
async function entryIs(path: string, kind: 'file' | 'dir'): Promise<boolean> {
  try { const info = await lstat(path); return kind === 'file' ? info.isFile() : info.isDirectory(); } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return false; throw e; }
}
/**
 * #149: a rig-parts build root — the folder `rig-parts build --out` wrote — recognised by fixed names the build owns, never
 * by a search: regular `parts.json` and `rig/rig.json`, a real (not symlinked) `check/` directory, and an existing
 * `check/build/skeleton.model.json` entry (its validity is the package adapter's to refuse). A folder lacking any of
 * these is not a build root.
 */
export async function isBuildRoot(dir: string): Promise<boolean> {
  if (!(await entryIs(join(dir, 'parts.json'), 'file')) || !(await entryIs(join(dir, 'rig'), 'dir')) || !(await entryIs(join(dir, 'rig', 'rig.json'), 'file')) || !(await entryIs(join(dir, 'check'), 'dir'))) return false;
  return exists(join(dir, 'check', 'build', 'skeleton.model.json'));
}
/** The producer's own config places for the build whose check package is `root` (canonical), or null when `root` is not one. */
interface BuildPlace { config: string; base: string; field: string }
async function buildPlaces(root: string): Promise<{ build: string; places: BuildPlace[] } | null> {
  if (basename(root) !== 'check' || !(await isBuildRoot(dirname(root)))) return null;
  const build = dirname(root);
  return { build, places: [{ config: join(build, 'config.json'), base: build, field: '../config.json' }, { config: join(dirname(build), 'config.json'), base: dirname(build), field: '../../config.json' }] };
}
/** The path as written with its parent chain canonicalized (so /tmp → /private/tmp is not an escape); null when the parent is missing. */
async function writtenPath(value: string): Promise<string | null> {
  const lexical = resolve(value);
  try { return join(await realpath(dirname(lexical)), basename(lexical)); } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return null; throw e; }
}

/**
 * One handoff path: it must exist, its canonical location must stay inside `base`, and it must be the expected kind.
 * `lexicalInside` says whether the path as written was inside the root, so a canonical escape is named a symlink escape.
 */
async function contained(base: string, path: string, field: string, kind: 'file' | 'dir', lexicalInside: boolean): Promise<string> {
  if (!(await exists(path))) throw new HandoffError('HANDOFF_INPUT_MISSING', field, `${path} does not exist`);
  let real: string;
  try { real = await realpath(path); } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ELOOP') throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', field, `${path} is a dangling or looping symlink`); throw e; }
  if (!inside(base, real, kind === 'dir')) {
    if (lexicalInside) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', field, `${path} resolves outside ${base} (symlinks may not escape)`);
    throw new HandoffError('HANDOFF_PATH_OUTSIDE_ROOT', field, `${path} is outside ${base}`);
  }
  const info = await stat(real);
  if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new HandoffError('HANDOFF_INPUT_INVALID', field, `${path} is not a ${kind === 'file' ? 'regular file' : 'directory'}`);
  return real;
}
/** A CLI path: written relative to the working directory or absolute; canonical inside the package root. */
async function flagPath(root: string, value: string, field: string, kind: 'file' | 'dir'): Promise<string> {
  const lexical = resolve(value);
  // The parent chain is canonicalized so a platform alias (/tmp → /private/tmp) is not taken for an escape; the last
  // component is left as written so a symlink there is named as one.
  let parent: string;
  try { parent = await realpath(dirname(lexical)); } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') throw new HandoffError('HANDOFF_INPUT_MISSING', field, `${value} does not exist`); throw e; }
  const written = join(parent, basename(lexical));
  return contained(root, written, field, kind, inside(root, written, kind === 'dir'));
}
/** A review.json `producer` path: literal, portable, relative to the package root. */
async function blockPath(root: string, value: unknown, field: string, kind: 'file' | 'dir'): Promise<string> {
  if (typeof value !== 'string' || !value) throw new HandoffError('HANDOFF_PATH_INVALID', field, 'expected a nonempty literal relative path');
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value) || value.split('/').includes('..')) throw new HandoffError('HANDOFF_PATH_OUTSIDE_ROOT', field, `${value} leaves the package root (absolute or ..)`);
  if (/[:\\%?#\x00-\x1f]/.test(value) || value.split('/').some(s => !s || s === '.') || posix.normalize(value) !== value) throw new HandoffError('HANDOFF_PATH_INVALID', field, `${value} is not a literal portable relative path`);
  return contained(root, join(root, value), field, kind, true);
}

/**
 * #329: the painting beside a discovered config — `field` is the config's own place with its file name swapped — or
 * undefined when nothing is there. `strict` (a place outside the opened folder) refuses any symlink, as for the config.
 */
async function discoveredPainting(base: string, config: string, configField: string, strict: boolean): Promise<string | undefined> {
  const path = join(dirname(config), DISCOVERED_PAINTING), field = posix.join(posix.dirname(configField), DISCOVERED_PAINTING);
  if (!(await exists(path))) return undefined;
  const real = await contained(base, path, field, 'file', true);
  if (strict && real !== path) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', field, `${path} is a symlink; only the file beside the config is discovered`);
  return real;
}

/** `producer: {config, parts?, source?, full?, head?, keypoints?}` — strings only, no other key. Paths are checked at load. */
export function parseHandoffDeclaration(value: unknown): HandoffDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HandoffError('HANDOFF_PATH_INVALID', 'producer', 'expected an object {config, parts?, source?, full?, head?, keypoints?}');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(HANDOFF_FLAGS as readonly string[]).includes(key)) throw new HandoffError('HANDOFF_PATH_INVALID', `producer.${key}`, 'unknown key; expected config, parts, source, full, head, keypoints');
  if (typeof v.config !== 'string') throw new HandoffError('HANDOFF_PATH_INVALID', 'producer.config', 'required: the producer config path');
  const out: HandoffDeclaration = { config: v.config };
  for (const key of ['parts', 'source', 'full', 'head', 'keypoints'] as const) if (v[key] !== undefined) { if (typeof v[key] !== 'string') throw new HandoffError('HANDOFF_PATH_INVALID', `producer.${key}`, 'expected a string path'); out[key] = v[key] as string; }
  return out;
}
/** `--source` and `--full` travel together, `--head` only with them, and everything else only with `--config`. */
export function checkHandoffFlags(flags: Partial<HandoffFlags>): string | null {
  const present = HANDOFF_FLAGS.filter(f => flags[f] !== undefined);
  if (!present.length) return null;
  if (flags.config === undefined) return `--${present[0]}: requires --config <path>`;
  if ((flags.source === undefined) !== (flags.full === undefined)) return `--${flags.source === undefined ? 'full' : 'source'}: --source <png> and --full <dir> are given together`;
  if (flags.head !== undefined && flags.full === undefined) return '--head: requires --source <png> --full <dir>';
  return null;
}

async function hashFile(path: string): Promise<string> { return sha256(await readFile(path)); }
/** Regular files directly in `dir` (a fixed directory, not a search); each must stay inside `base`. */
async function listed(base: string, dir: string, field: string): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(e => !e.isDirectory()).map(e => e.name).sort();
  if (entries.length > MAX_LISTED) throw new HandoffError('HANDOFF_INPUT_INVALID', field, `${dir} holds more than ${MAX_LISTED} files`);
  const out: string[] = [];
  for (const name of entries) { const real = await contained(base, join(dir, name), `${field}/${name}`, 'file', true).catch(e => { if (e instanceof HandoffError && e.code === 'HANDOFF_INPUT_INVALID') return null; throw e; }); if (real) out.push(real); }
  return out;
}

/** Hash every handoff file and build the record. `root` is the package root (display paths are relative to it). */
async function record(root: string, base: string, how: HandoffRecord['how'], via: HandoffRecord['via'], config: string, partsPath: string | null, extra: { source?: string; full?: string; head?: string; keypoints?: string }, partsDeclared: boolean, options: ResolveHandoffOptions = {}): Promise<Handoff> {
  const show = (path: string) => relative(root, path).split(sep).join('/') || '.';
  const files = new Map<string, HandoffFile>(), missing: string[] = [];
  const add = async (path: string) => { const p = show(path); files.set(p, { path: p, sha256: await hashFile(path) }); };
  await add(config);
  // Files the config names that the producer reads, resolved against the config's own directory.
  let parsed: unknown = null;
  try { parsed = JSON.parse(await readFile(config, 'utf8')); } catch { /* the producer refuses an unreadable config by name */ }
  const searchStarts = [dirname(config), base, root, ...(options.starts ?? [process.cwd()])];
  const { partsRoot, references } = configNamedReferences(parsed, searchStarts);
  for (const ref of references) {
    const field = `config ${ref.at}`, lexical = resolve(dirname(config), ref.value);
    if (!inside(base, lexical)) throw new HandoffError('HANDOFF_PATH_OUTSIDE_ROOT', field, `${ref.value} resolves outside ${base}`);
    if (ref.kind === 'requirements' && (isAbsolute(ref.value) || /[:\\%?#\x00-\x1f]/.test(ref.value) ||
        ref.value.split('/').some(part => !part || part === '.' || part === '..'))) {
      throw new HandoffError('HANDOFF_PATH_INVALID', field, 'expected a literal portable config-relative path');
    }
    if (ref.kind === 'plate') {
      if (!(await exists(lexical))) { missing.push(`${ref.at} ${show(lexical)}/${DIRECTORY_INPUT_RECEIPT}`); continue; }
      const dir = await contained(base, lexical, field, 'dir', true);
      const dirRel = show(dir), receiptLexical = join(dir, DIRECTORY_INPUT_RECEIPT), boundRel = `${dirRel}/${DIRECTORY_INPUT_RECEIPT}`;
      if (!(await exists(receiptLexical))) {
        throw new HandoffError('HANDOFF_INPUT_INVALID', field, `${dirRel} holds no regular-file ${DIRECTORY_INPUT_RECEIPT}; a directory input binds its producer's receipt, such as a comfy plate --mode occluder output`);
      }
      const receiptReal = await contained(base, receiptLexical, `${field}/${DIRECTORY_INPUT_RECEIPT}`, 'file', true);
      if (receiptReal !== receiptLexical || !(await lstat(receiptLexical)).isFile()) {
        throw new HandoffError('HANDOFF_INPUT_INVALID', field, `${boundRel} is not a regular file`);
      }
      const bytes = await readFile(receiptReal);
      const spec = plateReceiptSpec(partsRoot, field);
      const declared = receiptSpec(bytes);
      if (declared !== spec) {
        throw new HandoffError('HANDOFF_INPUT_INVALID', field, `${boundRel} declares spec ${JSON.stringify(declared)}; a directory input binds a ${spec} receipt, such as a comfy plate --mode occluder output`);
      }
      files.set(boundRel, { path: boundRel, sha256: sha256(bytes), directory: dirRel, spec });
      continue;
    }
    if (!(await exists(lexical))) { missing.push(`${ref.at} ${show(lexical)}`); continue; }
    const file = await contained(base, lexical, field, 'file', true);
    if (ref.kind === 'requirements' && file !== lexical) {
      throw new HandoffError('HANDOFF_PATH_INVALID', field, 'expected a regular file without a symlink alias');
    }
    await add(file);
  }
  let parts: string | null = null, rig: string | null = null;
  if (partsPath && (partsDeclared || await exists(partsPath))) {
    parts = await contained(base, partsPath, partsDeclared ? '--parts' : 'parts', 'dir', true);
    const partsJson = join(parts, 'parts.json');
    if (await exists(partsJson)) await add(await contained(base, partsJson, 'parts.json', 'file', true)); else missing.push(`parts.json ${show(partsJson)}`);
    if (await exists(join(parts, 'parts'))) for (const file of await listed(base, await contained(base, join(parts, 'parts'), 'parts/', 'dir', true), 'parts')) await add(file);
    const rigDir = join(parts, 'rig');
    if (await exists(rigDir)) {
      rig = await contained(base, rigDir, 'rig', 'dir', true);
      for (const name of RIG_FILES) if (!(await exists(join(rig, name)))) missing.push(`rig ${show(join(rig, name))}`);
      // Every file remesh carries over: the rig directory's regular files (rig.json, motion.json, mesh_report.json, sets.json, …) and images/.
      for (const file of await listed(base, rig, 'rig')) await add(file);
      if (await exists(join(rig, 'images'))) for (const file of await listed(base, await contained(base, join(rig, 'images'), 'rig/images', 'dir', true), 'rig/images')) await add(file);
    } else missing.push(`rig ${show(rigDir)}`);
  } else missing.push(`parts ${partsPath ? show(partsPath) : '(none)'}`);
  let source: HandoffFile | null = null;
  if (extra.source) { await add(extra.source); source = { path: show(extra.source), sha256: files.get(show(extra.source))!.sha256 }; }
  for (const dir of [extra.full, extra.head]) if (dir) for (const file of await listed(base, dir, show(dir))) await add(file);
  // #111: hashed only when declared — an undeclared handoff's record (and so its identity) holds no keypoints key at all.
  if (extra.keypoints) await add(extra.keypoints);
  const sorted = [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    record: { schema: HANDOFF_SCHEMA, how, via, outside: !inside(root, config), config: { path: show(config), sha256: files.get(show(config))!.sha256 }, parts: parts ? show(parts) : null, rig: rig ? show(rig) : null, source, full: extra.full ? show(extra.full) : null, head: extra.head ? show(extra.head) : null, ...(extra.keypoints ? { keypoints: { path: show(extra.keypoints), sha256: files.get(show(extra.keypoints))!.sha256 } } : {}), files: sorted, missing },
    config, parts, rig, root: base, source: extra.source ?? null, full: extra.full ?? null, head: extra.head ?? null, keypoints: extra.keypoints ?? null,
    starts: searchStarts,
  };
}

/**
 * The one handoff lookup (used by load, identity and `/api/rebuild`): CLI flags, else the review.json block, else the
 * fixed discovery order. `root` is the canonical package root (the opened folder). A declared path that is missing,
 * outside its root or a symlink escape is refused by name; nothing found is `{handoff: null}` with the refusal line.
 */
export async function resolveHandoff(root: string, declared: HandoffDeclaration | undefined, flags: HandoffFlags | undefined, options: ResolveHandoffOptions = {}): Promise<{ handoff: Handoff | null; reason: string | null }> {
  if (flags) {
    const problem = checkHandoffFlags(flags);
    if (problem) throw new HandoffError('HANDOFF_FLAGS_INVALID', problem.split(':')[0]!, problem);
    // #149: a --config written as exactly one of the build's own config places takes that place's folder as its root.
    const build = await buildPlaces(root), written = build ? await writtenPath(flags.config) : null;
    const place = build?.places.find(p => p.config === written) ?? null, base = place?.base ?? root;
    const config = await flagPath(base, flags.config, '--config', 'file');
    if (place && config !== place.config) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', '--config', `${flags.config} is a symlink; only the build's own ${place.field} is taken`);
    const parts = flags.parts !== undefined ? await flagPath(base, flags.parts, '--parts', 'dir') : place ? build!.build : join(dirname(config), 'out');
    const source = flags.source !== undefined ? await flagPath(base, flags.source, '--source', 'file') : undefined;
    const full = flags.full !== undefined ? await flagPath(base, flags.full, '--full', 'dir') : undefined;
    const head = flags.head !== undefined ? await flagPath(base, flags.head, '--head', 'dir') : undefined;
    const keypoints = flags.keypoints !== undefined ? await flagPath(base, flags.keypoints, '--keypoints', 'file') : undefined;
    const handoff = await record(root, base, 'declared', 'open --config', config, parts, { source, full, head, keypoints }, flags.parts !== undefined, options);
    // Canonical absolute flags: the background worker and later reloads read exactly these.
    handoff.flags = { config, ...(flags.parts !== undefined ? { parts } : {}), ...(source ? { source } : {}), ...(full ? { full } : {}), ...(head ? { head } : {}), ...(keypoints ? { keypoints } : {}) };
    return { handoff, reason: null };
  }
  if (declared) {
    const config = await blockPath(root, declared.config, 'producer.config', 'file');
    const parts = declared.parts !== undefined ? await blockPath(root, declared.parts, 'producer.parts', 'dir') : join(dirname(config), 'out');
    const source = declared.source !== undefined ? await blockPath(root, declared.source, 'producer.source', 'file') : undefined;
    const full = declared.full !== undefined ? await blockPath(root, declared.full, 'producer.full', 'dir') : undefined;
    const head = declared.head !== undefined ? await blockPath(root, declared.head, 'producer.head', 'dir') : undefined;
    const keypoints = declared.keypoints !== undefined ? await blockPath(root, declared.keypoints, 'producer.keypoints', 'file') : undefined;
    if ((full !== undefined && source === undefined) || (head !== undefined && full === undefined)) throw new HandoffError('HANDOFF_FLAGS_INVALID', 'producer', 'full requires source, and head requires full');
    return { handoff: await record(root, root, 'declared', 'review.json producer', config, parts, { source, full, head, keypoints }, declared.parts !== undefined, options), reason: null };
  }
  for (const name of ['config.json', 'rig/config.json']) {
    const path = join(root, name);
    if (!(await exists(path))) continue;
    const config = await contained(root, path, name, 'file', true);
    const source = await discoveredPainting(root, path, name, false);
    return { handoff: await record(root, root, 'discovered', 'discovery', config, join(dirname(path), 'out'), { source }, false, options), reason: null };
  }
  // #149: the check package of a rig-parts build root — the build's own config, in the build root, else beside it.
  const build = await buildPlaces(root);
  if (build) {
    for (const place of build.places) {
      if (!(await exists(place.config))) continue;
      const config = await contained(place.base, place.config, place.field, 'file', true);
      if (config !== place.config) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', place.field, `${place.config} is a symlink; only the build's own config file is discovered`);
      const source = await discoveredPainting(place.base, config, place.field, true);
      return { handoff: await record(root, place.base, 'discovered', 'discovery', config, build.build, { source }, false, options), reason: null };
    }
    return { handoff: null, reason: BUILD_MODELING_INPUT_UNAVAILABLE };
  }
  // The last step: an opened `out/` whose config sits beside it, one level up. Outside the folder, so named.
  if (basename(root) === 'out') {
    const parent = dirname(root), path = join(parent, 'config.json');
    if (await exists(path)) {
      const config = await contained(parent, path, '../config.json', 'file', true);
      if (config !== path) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', '../config.json', `${path} is a symlink; only the file beside out/ is discovered`);
      const source = await discoveredPainting(parent, config, '../config.json', true);
      return { handoff: await record(root, parent, 'discovered', 'discovery', config, root, { source }, false, options), reason: null };
    }
  }
  return { handoff: null, reason: MODELING_INPUT_UNAVAILABLE };
}
