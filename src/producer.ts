/**
 * The installed producer (`@rig-c/parts`' `rig-parts`) and the compiler it gates with (`rig-c`'s `rigc`), resolved the
 * way `rigc review` resolves `rig-review`: the package's own `package.json` under the nearest `node_modules` walking
 * up from each start directory, its `bin` entry read from that manifest. No PATH lookup, no install, no prompt.
 * Review builds nothing itself: it runs these binaries as child processes with arguments it composes from a typed
 * request, and reports what they printed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PRODUCER_PACKAGE = '@rig-c/parts';
export const PRODUCER_BIN = 'rig-parts';
export const COMPILER_PACKAGE = 'rig-c';
export const COMPILER_BIN = 'rigc';
/** The first `@rig-c/parts` release with `rig-parts remesh` (its CHANGELOG: 1.40.0, "remesh: re-fit one part of a gated rig"). */
export const REMESH_SINCE = '1.40.0';
/**
 * The first `@rig-c/parts` release whose `rig-parts remesh` reads `--delta <mesh-edit.json>` in place of `--mesh` (its
 * CHANGELOG: 1.43.0, "remesh: --delta replays rig-c/review's mesh edit over one part's mesh", parts#528). Edit Mesh's
 * Apply · Rebuild (#135) needs it; the version is read off the installed producer's own `package.json`.
 */
export const REMESH_DELTA_SINCE = '1.43.0';
export const MODELING_PRODUCER_NOT_INSTALLED = `MODELING_PRODUCER_NOT_INSTALLED: ${PRODUCER_PACKAGE} is not installed beside the package or beside review, and review does not install it — bun add -d ${PRODUCER_PACKAGE}`;
export const modelingProducerTooOld = (found: string, required: string, what = 'rig-parts remesh') => `MODELING_PRODUCER_TOO_OLD ${found} ${required}: ${what} needs ${PRODUCER_PACKAGE} ${required} or later — bun add -d ${PRODUCER_PACKAGE}@latest`;
export const MODELING_COMPILER_NOT_INSTALLED = `MODELING_COMPILER_NOT_INSTALLED: ${COMPILER_PACKAGE} is not installed beside ${PRODUCER_PACKAGE}, which gates its rigs with it — reinstall ${PRODUCER_PACKAGE} (bun add -d ${PRODUCER_PACKAGE})`;

export interface InstalledTool { package: string; version: string; root: string; bin: string }
export type ProducerResolution = { ok: true; producer: InstalledTool; compiler: InstalledTool } | { ok: false; error: string };

/** The nearest `node_modules/<name>/package.json` walking up from each start, first start first. */
export function findPackage(name: string, starts: readonly string[], exists: (path: string) => boolean = existsSync): string | null {
  for (const start of starts) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      const manifest = join(dir, 'node_modules', name, 'package.json');
      if (exists(manifest)) return manifest;
      if (dirname(dir) === dir) break;
    }
  }
  return null;
}

/** `X.Y.Z` → [X, Y, Z]; anything else is null (a pre-release tag is not compared, it is refused as unread). */
export function parseVersion(text: unknown): [number, number, number] | null {
  const match = typeof text === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim()) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
export function versionAtLeast(found: string, required: string): boolean {
  const a = parseVersion(found), b = parseVersion(required);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

function readTool(manifest: string, binName: string): InstalledTool | { error: string } {
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return { error: `${manifest} is not readable JSON` }; }
  const bins = value.bin, relative = typeof bins === 'object' && bins !== null ? (bins as Record<string, unknown>)[binName] : undefined;
  const root = dirname(manifest), version = typeof value.version === 'string' ? value.version : '';
  if (typeof relative !== 'string') return { error: `${String(value.name)} at ${root} declares no "${binName}" bin` };
  const bin = resolve(root, relative);
  try { if (!statSync(bin).isFile()) throw new Error(); } catch { return { error: `${String(value.name)} at ${root} declares the "${binName}" bin ${relative}, which is not there` }; }
  return { package: typeof value.name === 'string' ? value.name : '', version, root, bin };
}

/**
 * Producer: walking up from the inspected package, then from review's working directory. Compiler: walking up from
 * the producer's own package directory, which is where `rig-parts` itself finds the `rigc` it gates remesh with.
 */
export function resolveProducer(starts: readonly string[], exists: (path: string) => boolean = existsSync): ProducerResolution {
  const manifest = findPackage(PRODUCER_PACKAGE, starts, exists);
  if (!manifest) return { ok: false, error: MODELING_PRODUCER_NOT_INSTALLED };
  const producer = readTool(manifest, PRODUCER_BIN);
  if ('error' in producer) return { ok: false, error: `${MODELING_PRODUCER_NOT_INSTALLED} (${producer.error})` };
  if (!versionAtLeast(producer.version, REMESH_SINCE)) return { ok: false, error: modelingProducerTooOld(producer.version || 'unknown', REMESH_SINCE) };
  const compilerManifest = findPackage(COMPILER_PACKAGE, [producer.root], exists);
  if (!compilerManifest) return { ok: false, error: MODELING_COMPILER_NOT_INSTALLED };
  const compiler = readTool(compilerManifest, COMPILER_BIN);
  if ('error' in compiler) return { ok: false, error: `${MODELING_COMPILER_NOT_INSTALLED} (${compiler.error})` };
  return { ok: true, producer, compiler };
}

export interface RemeshRequest { rig: string; config: string; parts: string; part: string; mesh: string; out: string }
/** `rig-parts remesh` flags as its help states them; every value a path the server composed, never a client string. */
export const remeshArgs = (r: RemeshRequest): string[] => ['remesh', '--rig', r.rig, '--config', r.config, '--parts', r.parts, '--part', r.part, '--mesh', r.mesh, '--out', r.out];
export interface RemeshDeltaRequest { rig: string; config: string; parts: string; part: string; delta: string; out: string }
/** `rig-parts remesh … --delta <mesh-edit.json>` (#135): the same flags with `--delta` in place of `--mesh`, as its help states. */
export const remeshDeltaArgs = (r: RemeshDeltaRequest): string[] => ['remesh', '--rig', r.rig, '--config', r.config, '--parts', r.parts, '--part', r.part, '--delta', r.delta, '--out', r.out];
export interface CompileRequest { rig: string; motion: string; out: string; pageEdges: 'pot' | 'free'; packShape: 'rect' | 'polygon' }
/** remesh writes a rig spec (rig.json + motion.json); this is the compile its own gate ran, with the revision's pack flags. */
export const compileArgs = (r: CompileRequest): string[] => ['build', '--rig', r.rig, '--motion', r.motion, '--out', r.out, '--profile', 'rig-play', '--pack', '--page-edges', r.pageEdges, '--pack-shape', r.packShape];

/** The producer's first named refusal line, verbatim (trimmed): `FAIL  CODE: …`, or a `CODE: …` line, or `refused: …`. */
export function firstRefusal(lines: readonly string[]): string | null {
  for (const line of lines) if (/^\s*FAIL\s+[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(line)) return line.trim();
  for (const line of lines) if (/^\s*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+:\s/.test(line)) return line.trim();
  for (const line of lines) if (/^\s*refused:/.test(line)) return line.trim();
  return null;
}

export interface ProcessResult { exitCode: number; lines: string[]; stdout: string[]; wallMs: number }
/**
 * One child process: `bun <bin> …args` with cwd = the scratch directory, stdout and stderr read line by line (each
 * line handed to `onLine` as it arrives), the exit code and a wall-clock duration. Nothing is read from a manifest.
 */
export async function runTool(bin: string, args: readonly string[], options: { cwd: string; onLine?: (line: string) => void; env?: Record<string, string | undefined> }): Promise<ProcessResult> {
  const started = performance.now(), lines: string[] = [], stdout: string[] = [];
  const child = Bun.spawn([process.execPath, bin, ...args], { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env: options.env ?? process.env });
  const pump = async (stream: ReadableStream<Uint8Array>, own: string[] | null) => {
    const decoder = new TextDecoder(); let rest = '';
    const reader = stream.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      rest += decoder.decode(next.value, { stream: true });
      let at: number;
      while ((at = rest.indexOf('\n')) >= 0) { const line = rest.slice(0, at).replace(/\r$/, ''); rest = rest.slice(at + 1); lines.push(line); own?.push(line); options.onLine?.(line); }
    }
    rest += decoder.decode();
    if (rest) { lines.push(rest); own?.push(rest); options.onLine?.(rest); }
  };
  await Promise.all([pump(child.stdout, stdout), pump(child.stderr, null)]);
  const exitCode = await child.exited;
  // `lines` is the merged stream in arrival order (what the status area shows); `stdout` keeps the tool's own
  // report channel apart so a last line is never a stderr line that happened to arrive late.
  return { exitCode, lines, stdout, wallMs: Math.round(performance.now() - started) };
}

/** #108: the compiler alone (its readings need no producer op) — beside `@rig-c/parts` when that resolves, else walking up from each start. */
export const READINGS_COMPILER_NOT_INSTALLED = `READINGS_COMPILER_NOT_INSTALLED: ${COMPILER_PACKAGE} is not installed beside the package, beside ${PRODUCER_PACKAGE} or beside review, and review does not install it — bun add -d ${COMPILER_PACKAGE}`;
export const readingsCompilerTooOld = (found: string, required: string) => `READINGS_COMPILER_TOO_OLD ${found} ${required}: rigc render's readings (--folds, --pass-through, --seam, --overlaps, --angle-range) need ${COMPILER_PACKAGE} ${required} or later — bun add -d ${COMPILER_PACKAGE}@latest`;
export function resolveCompiler(starts: readonly string[], since: string, exists: (path: string) => boolean = existsSync): { ok: true; compiler: InstalledTool } | { ok: false; error: string } {
  const pair = resolveProducer(starts, exists);
  let compiler: InstalledTool | { error: string } | null = pair.ok ? pair.compiler : null;
  if (!compiler) { const manifest = findPackage(COMPILER_PACKAGE, starts, exists); compiler = manifest ? readTool(manifest, COMPILER_BIN) : null; }
  if (!compiler) return { ok: false, error: READINGS_COMPILER_NOT_INSTALLED };
  if ('error' in compiler) return { ok: false, error: `${READINGS_COMPILER_NOT_INSTALLED} (${compiler.error})` };
  if (!versionAtLeast(compiler.version, since)) return { ok: false, error: readingsCompilerTooOld(compiler.version || 'unknown', since) };
  return { ok: true, compiler };
}

/**
 * #114: the installed pose producer (`@rig-c/pose`' `rig-pose`), resolved as `@rig-c/parts` is — walking up from the
 * package, then from review's working directory — and the `rigc` beside it, which gates and poses its retarget and
 * compiles its scratch motion here. Refused by name when absent; review never installs it.
 */
export const POSE_PACKAGE = '@rig-c/pose';
export const POSE_BIN = 'rig-pose';
export const RETARGET_PRODUCER_NOT_INSTALLED = `RETARGET_PRODUCER_NOT_INSTALLED: ${POSE_PACKAGE} is not installed beside the package or beside review, and review does not install it — bun add -d ${POSE_PACKAGE}`;
export const RETARGET_COMPILER_NOT_INSTALLED = `RETARGET_COMPILER_NOT_INSTALLED: ${COMPILER_PACKAGE} is not installed beside ${POSE_PACKAGE}, which gates and poses its retarget with it — reinstall ${POSE_PACKAGE} (bun add -d ${POSE_PACKAGE})`;
export function resolvePose(starts: readonly string[], exists: (path: string) => boolean = existsSync): ProducerResolution {
  const manifest = findPackage(POSE_PACKAGE, starts, exists);
  if (!manifest) return { ok: false, error: RETARGET_PRODUCER_NOT_INSTALLED };
  const producer = readTool(manifest, POSE_BIN);
  if ('error' in producer) return { ok: false, error: `${RETARGET_PRODUCER_NOT_INSTALLED} (${producer.error})` };
  const compilerManifest = findPackage(COMPILER_PACKAGE, [producer.root], exists);
  if (!compilerManifest) return { ok: false, error: RETARGET_COMPILER_NOT_INSTALLED };
  const compiler = readTool(compilerManifest, COMPILER_BIN);
  if ('error' in compiler) return { ok: false, error: `${RETARGET_COMPILER_NOT_INSTALLED} (${compiler.error})` };
  return { ok: true, producer, compiler };
}
