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
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

export const HANDOFF_SCHEMA = 'rig-review-handoff/1';
/** The fixed discovery order, as the refusal names it. */
export const DISCOVERY_PLACES = ['config.json', 'rig/config.json', '../config.json (beside an opened out/)'] as const;
export const HANDOFF_DECLARATION = 'rig-review open <dir> --config <path> [--parts <dir>] or the review.json "producer" block';
export const MODELING_INPUT_UNAVAILABLE = `MODELING_INPUT_UNAVAILABLE: config.json — looked at ${DISCOVERY_PLACES.join(', ')}; declare it with ${HANDOFF_DECLARATION}`;
/** Files the producer reads by the config's own naming, resolved against the config's directory (rig-parts `relativeConfigPaths`). */
export const CONFIG_NAMED_FILES = [['motion', 'animations_from'], ['generation', 'control', 'skeleton']] as const;
/** What `rig-parts rig` writes into its --out and remesh reads from --rig: the rig spec, its motion, the mesh report and the part images. */
export const RIG_FILES = ['rig.json', 'motion.json', 'mesh_report.json'] as const;
const MAX_LISTED = 4096;

export interface HandoffDeclaration { config: string; parts?: string; source?: string; full?: string; head?: string }
export type HandoffFlags = HandoffDeclaration;
export const HANDOFF_FLAGS = ['config', 'parts', 'source', 'full', 'head'] as const;
export interface HandoffFile { path: string; sha256: string }
/** The identity record: paths relative to the package root (`../` only for the discovered parent config), every hashed file. */
export interface HandoffRecord {
  schema: typeof HANDOFF_SCHEMA;
  how: 'declared' | 'discovered';
  via: 'open --config' | 'review.json producer' | 'discovery';
  outside: boolean;
  config: HandoffFile;
  parts: string | null; rig: string | null; source: HandoffFile | null; full: string | null; head: string | null;
  files: HandoffFile[];
  missing: string[];
}
/** The record plus the absolute paths the producer is run with (never served, never in the identity). */
/** `source` (#109): the declared source painting's absolute path, which `propose --from-config` reads; null when none was declared. */
/** `full` / `head` (#115): the declared See-through runs' absolute paths, which `rig-parts build` reads; null when none was declared. */
export interface Handoff { record: HandoffRecord; config: string; parts: string | null; rig: string | null; root: string; flags?: HandoffFlags; source?: string | null; full?: string | null; head?: string | null }

export class HandoffError extends Error {
  constructor(readonly code: string, readonly field: string, readonly detail: string) { super(`${code} ${field}: ${detail}`); }
}
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (base: string, path: string, allowSelf = false) => { const rel = relative(base, path); return rel === '' ? allowSelf : rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? '';
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return false; throw e; } }

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

/** `producer: {config, parts?, source?, full?, head?}` — strings only, no other key. Paths are checked at load. */
export function parseHandoffDeclaration(value: unknown): HandoffDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HandoffError('HANDOFF_PATH_INVALID', 'producer', 'expected an object {config, parts?, source?, full?, head?}');
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!(HANDOFF_FLAGS as readonly string[]).includes(key)) throw new HandoffError('HANDOFF_PATH_INVALID', `producer.${key}`, 'unknown key; expected config, parts, source, full, head');
  if (typeof v.config !== 'string') throw new HandoffError('HANDOFF_PATH_INVALID', 'producer.config', 'required: the producer config path');
  const out: HandoffDeclaration = { config: v.config };
  for (const key of ['parts', 'source', 'full', 'head'] as const) if (v[key] !== undefined) { if (typeof v[key] !== 'string') throw new HandoffError('HANDOFF_PATH_INVALID', `producer.${key}`, 'expected a string path'); out[key] = v[key] as string; }
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
async function record(root: string, base: string, how: HandoffRecord['how'], via: HandoffRecord['via'], config: string, partsPath: string | null, extra: { source?: string; full?: string; head?: string }, partsDeclared: boolean): Promise<Handoff> {
  const show = (path: string) => relative(root, path).split(sep).join('/') || '.';
  const files = new Map<string, string>(), missing: string[] = [];
  const add = async (path: string) => { files.set(show(path), await hashFile(path)); };
  await add(config);
  // Files the config names that the producer reads, resolved against the config's own directory.
  let parsed: unknown = null;
  try { parsed = JSON.parse(await readFile(config, 'utf8')); } catch { /* the producer refuses an unreadable config by name */ }
  for (const keys of CONFIG_NAMED_FILES) {
    let value: unknown = parsed;
    for (const k of keys) value = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[k] : undefined;
    if (typeof value !== 'string' || !value) continue;
    const field = `config ${keys.join('.')}`, lexical = resolve(dirname(config), value);
    if (!inside(base, lexical)) throw new HandoffError('HANDOFF_PATH_OUTSIDE_ROOT', field, `${value} resolves outside ${base}`);
    if (!(await exists(lexical))) { missing.push(`${keys.join('.')} ${show(lexical)}`); continue; }
    await add(await contained(base, lexical, field, 'file', true));
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
  if (extra.source) { await add(extra.source); source = { path: show(extra.source), sha256: files.get(show(extra.source))! }; }
  for (const dir of [extra.full, extra.head]) if (dir) for (const file of await listed(base, dir, show(dir))) await add(file);
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, hash]) => ({ path, sha256: hash }));
  return {
    record: { schema: HANDOFF_SCHEMA, how, via, outside: !inside(root, config), config: { path: show(config), sha256: files.get(show(config))! }, parts: parts ? show(parts) : null, rig: rig ? show(rig) : null, source, full: extra.full ? show(extra.full) : null, head: extra.head ? show(extra.head) : null, files: sorted, missing },
    config, parts, rig, root: base, source: extra.source ?? null, full: extra.full ?? null, head: extra.head ?? null,
  };
}

/**
 * The one handoff lookup (used by load, identity and `/api/rebuild`): CLI flags, else the review.json block, else the
 * fixed discovery order. `root` is the canonical package root (the opened folder). A declared path that is missing,
 * outside its root or a symlink escape is refused by name; nothing found is `{handoff: null}` with the refusal line.
 */
export async function resolveHandoff(root: string, declared: HandoffDeclaration | undefined, flags: HandoffFlags | undefined): Promise<{ handoff: Handoff | null; reason: string | null }> {
  if (flags) {
    const problem = checkHandoffFlags(flags);
    if (problem) throw new HandoffError('HANDOFF_FLAGS_INVALID', problem.split(':')[0]!, problem);
    const config = await flagPath(root, flags.config, '--config', 'file');
    const parts = flags.parts !== undefined ? await flagPath(root, flags.parts, '--parts', 'dir') : join(dirname(config), 'out');
    const source = flags.source !== undefined ? await flagPath(root, flags.source, '--source', 'file') : undefined;
    const full = flags.full !== undefined ? await flagPath(root, flags.full, '--full', 'dir') : undefined;
    const head = flags.head !== undefined ? await flagPath(root, flags.head, '--head', 'dir') : undefined;
    const handoff = await record(root, root, 'declared', 'open --config', config, parts, { source, full, head }, flags.parts !== undefined);
    // Canonical absolute flags: the background worker and later reloads read exactly these.
    handoff.flags = { config, ...(flags.parts !== undefined ? { parts } : {}), ...(source ? { source } : {}), ...(full ? { full } : {}), ...(head ? { head } : {}) };
    return { handoff, reason: null };
  }
  if (declared) {
    const config = await blockPath(root, declared.config, 'producer.config', 'file');
    const parts = declared.parts !== undefined ? await blockPath(root, declared.parts, 'producer.parts', 'dir') : join(dirname(config), 'out');
    const source = declared.source !== undefined ? await blockPath(root, declared.source, 'producer.source', 'file') : undefined;
    const full = declared.full !== undefined ? await blockPath(root, declared.full, 'producer.full', 'dir') : undefined;
    const head = declared.head !== undefined ? await blockPath(root, declared.head, 'producer.head', 'dir') : undefined;
    if ((source === undefined) !== (full === undefined) || (head !== undefined && full === undefined)) throw new HandoffError('HANDOFF_FLAGS_INVALID', 'producer', 'source and full are given together, head only with them');
    return { handoff: await record(root, root, 'declared', 'review.json producer', config, parts, { source, full, head }, declared.parts !== undefined), reason: null };
  }
  for (const name of ['config.json', 'rig/config.json']) {
    const path = join(root, name);
    if (!(await exists(path))) continue;
    const config = await contained(root, path, name, 'file', true);
    return { handoff: await record(root, root, 'discovered', 'discovery', config, join(dirname(path), 'out'), {}, false), reason: null };
  }
  // The last step: an opened `out/` whose config sits beside it, one level up. Outside the folder, so named.
  if (basename(root) === 'out') {
    const parent = dirname(root), path = join(parent, 'config.json');
    if (await exists(path)) {
      const config = await contained(parent, path, '../config.json', 'file', true);
      if (config !== path) throw new HandoffError('HANDOFF_SYMLINK_ESCAPE', '../config.json', `${path} is a symlink; only the file beside out/ is discovered`);
      return { handoff: await record(root, parent, 'discovered', 'discovery', config, root, {}, false), reason: null };
    }
  }
  return { handoff: null, reason: MODELING_INPUT_UNAVAILABLE };
}
