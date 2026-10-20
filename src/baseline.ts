/**
 * Baseline hold (#101): once per session, when the handoff and the producer both resolve, `rig-parts rig --config
 * <config> --parts <parts> --out <scratch>/baseline` rebuilds the whole rig from the handoff into scratch under the review
 * state directory, and what it writes (rig.json, motion.json, mesh_report.json, images/*) is compared with the inspected
 * rig directory, file by file. Reproduced means the handoff is what the inspected rig was built from, so an op that
 * rebuilds the whole rig may run; otherwise the first differing path is named. Nothing is written into the package.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Handoff } from './handoff.ts';
import { RIG_FILES } from './handoff.ts';
import { firstRefusal, runTool, type InstalledTool } from './producer.ts';

export const BASELINE_SCHEMA = 'rig-review-baseline/1';
export type BaselineStatus = 'running' | 'reproduced' | 'not-reproduced' | 'refused' | 'failed';
export interface BaselineResult {
  schema: typeof BASELINE_SCHEMA; key: string; status: BaselineStatus;
  producer: { package: string; version: string };
  /** The first path (relative to the package root) whose bytes differ or that only one side has; null when reproduced. */
  firstDifference: string | null;
  /** Both sides: the rig.json SHA-256 and the SHA-256 of the sorted {path: sha256} table of every compared file. */
  hashes: { baseline: { rigJson: string | null; tree: string }; inspected: { rigJson: string | null; tree: string } } | null;
  line: string; exitCode: number | null; wallMs: number | null;
}
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function present(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

/** A rig directory as {relative path: sha256}: its regular files and images/* (fixed places, not a search). */
export async function rigTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await readdir(dir, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort()) out[e] = sha256(await readFile(join(dir, e)));
  const images = join(dir, 'images');
  if (await present(images)) for (const e of (await readdir(images, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name).sort()) out[`images/${e}`] = sha256(await readFile(join(images, e)));
  return out;
}
export const treeHash = (tree: Record<string, string>) => sha256(JSON.stringify(Object.keys(tree).sort().map(k => [k, tree[k]])));
/**
 * The first path, in sorted order, whose hash differs or that one side lacks; null when the two match. Compared: every
 * file the baseline wrote, and on the inspected side the rig files and images (a file there that rig never writes, such
 * as a note, is not the producer's to reproduce).
 */
export function firstDifference(baseline: Record<string, string>, inspected: Record<string, string>): string | null {
  const own = Object.keys(inspected).filter(k => (RIG_FILES as readonly string[]).includes(k) || k.startsWith('images/'));
  for (const path of [...new Set([...Object.keys(baseline), ...own])].sort()) if (baseline[path] !== inspected[path]) return path;
  if (!Object.keys(baseline).length) return 'rig.json';
  return null;
}
/** The editor bar's line. */
export function baselineLine(r: Pick<BaselineResult, 'status' | 'firstDifference' | 'hashes' | 'line'>): string {
  if (r.status === 'reproduced' && r.hashes) return `baseline: reproduced — rig.json ${r.hashes.baseline.rigJson?.slice(0, 12)}… = inspected ${r.hashes.inspected.rigJson?.slice(0, 12)}…`;
  if (r.status === 'not-reproduced') return `baseline: not reproduced — ${r.firstDifference}`;
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
  if (result.status !== 'reproduced') throw new BaselineError('EDIT_BASELINE_MISMATCH', result.firstDifference ?? result.line);
}

/** Deterministic: the package, the handoff record and the producer. No clock. */
export const baselineKey = (sourceHash: string, handoff: Handoff, producer: InstalledTool, compiler: InstalledTool) =>
  sha256(JSON.stringify([BASELINE_SCHEMA, sourceHash, handoff.record, `${producer.package}@${producer.version}`, `${compiler.package}@${compiler.version}`]));

/** Compare a finished `<dir>/baseline` with the inspected rig; `show` turns a rig-relative path into the package-relative one. */
export async function compareBaseline(out: string, inspectedRig: string, show: (rel: string) => string): Promise<Pick<BaselineResult, 'status' | 'firstDifference' | 'hashes'>> {
  const baseline = await rigTree(out), inspected = await rigTree(inspectedRig), first = firstDifference(baseline, inspected);
  return { status: first === null ? 'reproduced' : 'not-reproduced', firstDifference: first === null ? null : show(first), hashes: { baseline: { rigJson: baseline['rig.json'] ?? null, tree: treeHash(baseline) }, inspected: { rigJson: inspected['rig.json'] ?? null, tree: treeHash(inspected) } } };
}

/**
 * Run (or reuse) the baseline into `dir`. `dir/result.json` holds a finished result; it is reused while the baseline
 * output still hashes to what it recorded. The inspected rig is re-read every time.
 */
export async function runBaseline(dir: string, key: string, handoff: Handoff, producer: InstalledTool, show: (rel: string) => string): Promise<BaselineResult> {
  const base = { schema: BASELINE_SCHEMA, key, producer: { package: producer.package, version: producer.version } } as const;
  const out = join(dir, 'baseline'), resultFile = join(dir, 'result.json');
  if (!handoff.parts || !handoff.rig) return { ...base, status: 'refused', firstDifference: null, hashes: null, line: `baseline: unavailable — MODELING_INPUT_UNAVAILABLE: ${handoff.record.missing.join(', ')}`, exitCode: null, wallMs: null };
  try {
    const stored = JSON.parse(await readFile(resultFile, 'utf8')) as BaselineResult;
    if (stored.schema === BASELINE_SCHEMA && stored.key === key && (stored.status === 'reproduced' || stored.status === 'not-reproduced')) {
      const now = await compareBaseline(out, handoff.rig, show);
      if (now.hashes?.baseline.tree === stored.hashes?.baseline.tree) return { ...stored, ...now, line: baselineLine({ ...stored, ...now }) };
    }
  } catch { /* no reusable result */ }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const run = await runTool(producer.bin, ['rig', '--config', handoff.config, '--parts', handoff.parts, '--out', out], { cwd: dir });
  if (run.exitCode !== 0) {
    const named = firstRefusal(run.lines) ?? `rig-parts rig exited ${run.exitCode} without a named refusal`;
    return { ...base, status: 'refused', firstDifference: null, hashes: null, line: `baseline: not run — ${named}`, exitCode: run.exitCode, wallMs: run.wallMs };
  }
  const compared = await compareBaseline(out, handoff.rig, show);
  const result: BaselineResult = { ...base, ...compared, line: '', exitCode: 0, wallMs: run.wallMs };
  result.line = baselineLine(result);
  await writeFile(resultFile, JSON.stringify(result, null, 1) + '\n', { mode: 0o600 });
  return result;
}
