/**
 * Baseline hold (#101): once per session, when the handoff and the producer both resolve, `rig-parts rig --config
 * <config> --parts <parts> --out <scratch>/baseline` rebuilds the whole rig from the handoff into scratch under the review
 * state directory, and what it writes (`PRODUCER_DOCUMENTS` and images/*, `src/producer-files.ts` — the same list the
 * applied-state diff reads) is compared with the inspected rig directory, file by file. Reproduced means the handoff is what the inspected rig was built from, so an op that
 * rebuilds the whole rig may run; otherwise the first differing path is named. Nothing is written into the package.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Handoff } from './handoff.ts';
import { isProducerFile, PRODUCER_DOCUMENTS, PRODUCER_IMAGES_DIR } from './producer-files.ts';
import { firstRefusal, runTool, type InstalledTool } from './producer.ts';
import { checkSummary, MAX_DIFF_PATHS, type CheckSummary, type FilesDiff } from './applied-context.ts';
import { jsonDiff } from './config-patch.ts';
import { baselineReach, reachOps, type BaselineReach } from './baseline-reach.ts';

export const BASELINE_SCHEMA = 'rig-review-baseline/1';
export type BaselineStatus = 'running' | 'reproduced' | 'not-reproduced' | 'refused' | 'failed';
export interface BaselineResult {
  schema: typeof BASELINE_SCHEMA; key: string; status: BaselineStatus;
  producer: { package: string; version: string };
  /** The first path (relative to the package root) whose bytes differ or that only one side has; null when reproduced. */
  firstDifference: string | null;
  /** Both sides: the rig.json SHA-256 and the SHA-256 of the sorted {path: sha256} table of every compared file. */
  hashes: { baseline: { rigJson: string | null; tree: string }; inspected: { rigJson: string | null; tree: string } } | null;
  /** #148: what Apply can still do when not reproduced (`src/baseline-reach.ts`); null otherwise. */
  reach?: BaselineReach | null;
  line: string; exitCode: number | null; wallMs: number | null;
}
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function present(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

/** A rig directory as {relative path: sha256}: its regular files and images/* (fixed places, not a search). */
export async function rigTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort()) out[e] = sha256(await readFile(join(dir, e)));
  const images = join(dir, PRODUCER_IMAGES_DIR);
  if (await present(images)) for (const e of (await readdir(images, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort()) out[`${PRODUCER_IMAGES_DIR}/${e}`] = sha256(await readFile(join(images, e)));
  return out;
}
export const treeHash = (tree: Record<string, string>) => sha256(JSON.stringify(Object.keys(tree).sort().map(k => [k, tree[k]])));
/**
 * The first path, in sorted order, whose hash differs or that one side lacks; null when the two match. Compared: every
 * file the baseline wrote, and on the inspected side the producer's documents and images (`isProducerFile`; a file there
 * that rig never writes, such as a note, is not the producer's to reproduce).
 */
export function firstDifference(baseline: Record<string, string>, inspected: Record<string, string>): string | null {
  const own = Object.keys(inspected).filter(isProducerFile);
  for (const path of [...new Set([...Object.keys(baseline), ...own])].sort()) if (baseline[path] !== inspected[path]) return path;
  if (!Object.keys(baseline).length) return 'rig.json';
  return null;
}
/**
 * The applied-state diff (#125): every producer document (`PRODUCER_DOCUMENTS`, the baseline's list) of a scratch rig
 * directory against the inspected one, as JSON Pointers per file, and the images by hash only. A document neither side
 * has is left out; one only one side has, or that does not parse as JSON on a side, differs at `""` (the whole
 * document) unless its bytes are equal. Paths are capped at `MAX_DIFF_PATHS` per file; `count` is the full number.
 */
export async function producerDiff(inspectedDir: string, scratchDir: string): Promise<FilesDiff> {
  const read = async (dir: string, name: string): Promise<{ bytes: Buffer | null; doc: unknown; parsed: boolean }> => {
    let bytes: Buffer;
    try { bytes = await readFile(join(dir, name)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, doc: undefined, parsed: false }; throw e; }
    try { return { bytes, doc: JSON.parse(bytes.toString('utf8')) as unknown, parsed: true }; } catch { return { bytes, doc: undefined, parsed: false }; }
  };
  const documents: FilesDiff['documents'] = [];
  for (const file of PRODUCER_DOCUMENTS) {
    const before = await read(inspectedDir, file), after = await read(scratchDir, file);
    if (!before.bytes && !after.bytes) continue;
    const paths = before.parsed && after.parsed ? jsonDiff(before.doc, after.doc) : before.bytes && after.bytes && before.bytes.equals(after.bytes) ? [] : [''];
    documents.push({ file, count: paths.length, paths: paths.slice(0, MAX_DIFF_PATHS) });
  }
  const images = async (dir: string) => Object.fromEntries(Object.entries(await rigTree(dir)).filter(([k]) => k.startsWith(`${PRODUCER_IMAGES_DIR}/`)));
  const a = await images(inspectedDir), b = await images(scratchDir);
  const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(), changed = names.filter(n => a[n] !== b[n]);
  return { documents, images: { changed: changed.length, unchanged: names.length - changed.length, names: changed.slice(0, MAX_DIFF_PATHS) } };
}
/** The editor bar's line. */
export function baselineLine(r: Pick<BaselineResult, 'status' | 'firstDifference' | 'hashes' | 'line'> & { reach?: BaselineReach | null }): string {
  if (r.status === 'reproduced' && r.hashes) return `baseline: reproduced — rig.json ${r.hashes.baseline.rigJson?.slice(0, 12)}… = inspected ${r.hashes.inspected.rigJson?.slice(0, 12)}…`;
  if (r.status === 'not-reproduced') return `baseline: not reproduced — ${r.firstDifference}${r.reach ? ` · ${r.reach.text}` : ''}`;
  return r.line;
}
/**
 * For an op that rebuilds the whole rig (#102/#103): refuses unless the baseline reproduced the inspected rig.
 * `remesh` does not call this; it holds its own REMESH_BASELINE_MISMATCH.
 */
export class BaselineError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
export function assertWholeRigBaseline(result: BaselineResult | null): void {
  if (!result) throw new BaselineError('EDIT_BASELINE_MISMATCH', 'no baseline was run: the handoff or the producer did not resolve');
  if (result.status === 'running') throw new BaselineError('EDIT_BASELINE_PENDING', 'the baseline rebuild is still running');
  if (result.status !== 'reproduced') throw new BaselineError('EDIT_BASELINE_MISMATCH', result.firstDifference ? `${result.firstDifference}${result.reach ? ` — ${result.reach.text}` : ''}` : result.line);
}

/** Deterministic: the package, the handoff record and the producer. No clock. */
export const baselineKey = (sourceHash: string, handoff: Handoff, producer: InstalledTool, compiler: InstalledTool) =>
  sha256(JSON.stringify([BASELINE_SCHEMA, sourceHash, handoff.record, `${producer.package}@${producer.version}`, `${compiler.package}@${compiler.version}`]));

/** Compare a finished `<dir>/baseline` with the inspected rig; `show` turns a rig-relative path into the package-relative one. */
export async function compareBaseline(out: string, inspectedRig: string, show: (rel: string) => string, producerVersion: string | null = null): Promise<Pick<BaselineResult, 'status' | 'firstDifference' | 'hashes' | 'reach'>> {
  const baseline = await rigTree(out), inspected = await rigTree(inspectedRig), first = firstDifference(baseline, inspected);
  // #148: a build the config does not reproduce says, per op, what the producer will still take.
  const reach = first === null ? null : await baselineReach(out, inspectedRig, baseline, inspected, show, reachOps(producerVersion));
  return { status: first === null ? 'reproduced' : 'not-reproduced', firstDifference: first === null ? null : show(first), hashes: { baseline: { rigJson: baseline['rig.json'] ?? null, tree: treeHash(baseline) }, inspected: { rigJson: inspected['rig.json'] ?? null, tree: treeHash(inspected) } }, reach };
}

/**
 * Run (or reuse) the baseline into `dir`. `dir/result.json` holds a finished result; it is reused while the baseline
 * output still hashes to what it recorded. The inspected rig is re-read every time.
 */
export async function runBaseline(dir: string, key: string, handoff: Handoff, producer: InstalledTool, show: (rel: string) => string): Promise<BaselineResult> {
  const base = { schema: BASELINE_SCHEMA, key, producer: { package: producer.package, version: producer.version } } as const;
  const out = join(dir, 'baseline'), resultFile = join(dir, 'result.json');
  if (!handoff.parts || !handoff.rig) return { ...base, status: 'refused', firstDifference: null, hashes: null, reach: null, line: `baseline: unavailable — MODELING_INPUT_UNAVAILABLE: ${handoff.record.missing.join(', ')}`, exitCode: null, wallMs: null };
  try {
    const stored = JSON.parse(await readFile(resultFile, 'utf8')) as BaselineResult;
    if (stored.schema === BASELINE_SCHEMA && stored.key === key && (stored.status === 'reproduced' || stored.status === 'not-reproduced')) {
      const now = await compareBaseline(out, handoff.rig, show, producer.version);
      if (now.hashes?.baseline.tree === stored.hashes?.baseline.tree) return { ...stored, ...now, line: baselineLine({ ...stored, ...now }) };
    }
  } catch { /* no reusable result */ }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const run = await runTool(producer.bin, ['rig', '--config', handoff.config, '--parts', handoff.parts, '--out', out], { cwd: dir });
  if (run.exitCode !== 0) {
    const named = firstRefusal(run.lines) ?? `rig-parts rig exited ${run.exitCode} without a named refusal`;
    return { ...base, status: 'refused', firstDifference: null, hashes: null, reach: null, line: `baseline: not run — ${named}`, exitCode: run.exitCode, wallMs: run.wallMs };
  }
  const compared = await compareBaseline(out, handoff.rig, show, producer.version);
  const result: BaselineResult = { ...base, ...compared, line: '', exitCode: 0, wallMs: run.wallMs };
  result.line = baselineLine(result);
  await writeFile(resultFile, JSON.stringify(result, null, 1) + '\n', { mode: 0o600 });
  return result;
}

/**
 * The inspected build's own check (#108, HQ ruling): once the baseline reproduces the inspected rig, `rig-parts check`
 * runs on that baseline output — byte-identical to the inspected rig, so nothing reads or writes the package — into
 * `<baseline dir>/inspected-check/`, with Apply's default pack flags (`--page-edges free --pack-shape polygon`). The
 * summary is stored beside the baseline record (`inspected-check.json`) so a reload reads it instead of re-running.
 * It is what the physics readout's BEFORE line quotes while the inspected build is on the stage.
 */
export const INSPECTED_CHECK_SCHEMA = 'rig-review-inspected-check/1';
export type InspectedCheckStatus = 'running' | 'checked' | 'refused' | 'failed';
export interface InspectedCheck {
  schema: typeof INSPECTED_CHECK_SCHEMA; key: string; status: InspectedCheckStatus;
  /** check's printed lines (the per-bar lines the readout quotes), capped. */
  lines: string[]; check: CheckSummary | null;
  /** The line to show: check's summary line, its named refusal verbatim, or "check running…". */
  line: string; exitCode: number | null; wallMs: number | null;
}
export const INSPECTED_CHECK_FILE = 'inspected-check.json';
export const INSPECTED_CHECK_RUNNING = 'check running… (rig-parts check of the inspected build, in the background)';
export const inspectedCheckArgs = (parts: string): string[] => ['check', '--rig', 'baseline', '--out', 'inspected-check', '--parts', parts, '--page-edges', 'free', '--pack-shape', 'polygon'];
export const runningInspectedCheck = (key: string): InspectedCheck => ({ schema: INSPECTED_CHECK_SCHEMA, key, status: 'running', lines: [], check: null, line: INSPECTED_CHECK_RUNNING, exitCode: null, wallMs: null });
/** The stored record when it belongs to this baseline key and finished; null otherwise. */
export async function storedInspectedCheck(dir: string, key: string): Promise<InspectedCheck | null> {
  try {
    const stored = JSON.parse(await readFile(join(dir, INSPECTED_CHECK_FILE), 'utf8')) as InspectedCheck;
    return stored.schema === INSPECTED_CHECK_SCHEMA && stored.key === key && (stored.status === 'checked' || stored.status === 'refused') ? stored : null;
  } catch { return null; }
}
/** Run (or reuse) the inspected build's check in `dir` (the baseline's directory, whose `baseline/` reproduced the inspected rig). */
export async function runInspectedCheck(dir: string, key: string, parts: string, producer: InstalledTool): Promise<InspectedCheck> {
  const stored = await storedInspectedCheck(dir, key);
  if (stored) return stored;
  await rm(join(dir, 'inspected-check'), { recursive: true, force: true });
  const run = await runTool(producer.bin, inspectedCheckArgs(parts), { cwd: dir });
  let json: unknown = null;
  try { json = JSON.parse(await readFile(join(dir, 'inspected-check', 'check.json'), 'utf8')); } catch { /* check refused before writing it; its line says why */ }
  const refusal = firstRefusal(run.lines), check = checkSummary(json, run.exitCode, run.lines, refusal);
  const refused = json === null && run.exitCode !== 0;
  const result: InspectedCheck = {
    schema: INSPECTED_CHECK_SCHEMA, key, status: refused ? 'refused' : 'checked', lines: run.lines.slice(-4000), check: refused ? null : check,
    line: refused ? refusal ?? `rig-parts check exited ${run.exitCode} without a named refusal` : check.line ?? `rig-parts check exited ${run.exitCode}`,
    exitCode: run.exitCode, wallMs: run.wallMs,
  };
  await writeFile(join(dir, INSPECTED_CHECK_FILE), JSON.stringify(result, null, 1) + '\n', { mode: 0o600 });
  return result;
}
