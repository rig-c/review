/**
 * `POST /api/bones-check` (#109): the Bones block's pending ops, checked before any Apply. The ops are applied to a
 * scratch copy of the handoff config (written the way the patch runner writes it, `scratchConfigText`) under
 * `<state>/bones-check/<package hash>/<ops hash>/`, then the installed producer reads it twice:
 *  - `rig-parts propose --parts <handoff parts> --source <handoff source> --out propose --from-config config.json`:
 *    its LINT lines, LINT count line and coverage lines, shown as printed (it exits 1 on any LINT; that blocks nothing);
 *  - `rig-parts compare --left <handoff config> --right config.json`: each bone's origin distance and the summary lines.
 * The client sends ops and the config hash only — never a path or a flag. Nothing is written into the package; the
 * scratch directory is removed after the run.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { ReviewPackage } from './manifest.ts';
import { firstRefusal, resolveProducer, runTool, type InstalledTool } from './producer.ts';
import { applyConfigPatch, assertOpNames, assertPatchFresh, ConfigPatchError, CONFIG_PATCH_SCHEMA, parseConfigPatch, type JsonValue, type PatchOp } from './config-patch.ts';
import { assertNamedFilesHeld, producerInputs, RebuildError, scratchConfigText } from './rebuild.ts';
import { assertBoneOps, BoneAnchorError, compareOrigins, proposeLines, type OriginRow } from './bone-anchors.ts';
import { assertStateOutside as assertStateDirOutside } from './state-dir.ts';

export const BONES_CHECK_SCHEMA = 'rig-review-bones-check/1';
export const BONES_CHECK_LIMIT = 64 * 1024;
const MAX_LINES = 2000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** What `propose --from-config` needs beyond the handoff config and parts, refused by name when the handoff lacks it. */
export const BONES_SOURCE_UNAVAILABLE = 'MODELING_INPUT_UNAVAILABLE: source painting — propose --from-config reads the painting (--source) and the handoff declares none; declare it with rig-review open <dir> --config <path> --source <png> --full <dir> or the review.json "producer" block';
export const proposeArgs = (r: { parts: string; source: string; config: string; out: string }): string[] => ['propose', '--parts', r.parts, '--source', r.source, '--out', r.out, '--from-config', r.config];
export const compareArgs = (left: string, right: string): string[] => ['compare', '--left', left, '--right', right];

export interface BonesLintResult {
  status: 'ran' | 'unavailable';
  exitCode: number | null; wallMs: number | null;
  /** Each LINT line, the LINT count line and the coverage lines, as printed. */
  lint: string[]; summary: string | null; coverage: string[];
  /** The count line, a named refusal verbatim, or the unavailable line. */
  line: string;
}
export interface BonesCompareResult { exitCode: number; wallMs: number; origins: OriginRow[]; summary: string[]; line: string }
export interface BonesCheckResult {
  schema: typeof BONES_CHECK_SCHEMA; status: 'checked';
  request: { configHash: string; opsSha256: string; ops: PatchOp[] };
  producer: { package: string; version: string };
  propose: BonesLintResult; compare: BonesCompareResult;
}

/** `{ops, configHash}` only; each op a Bones-block op (`assertBoneOps`), typed as a config patch op. */
export function parseBonesCheck(input: unknown): { ops: PatchOp[]; configHash: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'configHash,ops') throw new RebuildError('REBUILD_REQUEST_INVALID', 'expected exactly {ops, configHash}');
  const v = input as Record<string, unknown>;
  if (typeof v.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.configHash)) throw new RebuildError('REBUILD_REQUEST_INVALID', 'configHash');
  let ops: PatchOp[];
  try { ops = parseConfigPatch({ schema: CONFIG_PATCH_SCHEMA, config_sha256: v.configHash, ops: v.ops, producer: { name: 'check', version: 'check' }, op: { cmd: 'rig', args: [] } }).ops; }
  catch (e) { if (e instanceof ConfigPatchError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
  try { assertBoneOps(ops); } catch (e) { if (e instanceof BoneAnchorError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
  return { ops, configHash: v.configHash };
}

/** One check at a time per review instance. */
export function createBonesCheck(p: ReviewPackage, options: { stateDir: string; starts: readonly string[]; unchanged: () => Promise<void> }) {
  let running = false;
  async function run(input: unknown): Promise<BonesCheckResult> {
    const { ops, configHash } = parseBonesCheck(input);
    assertStateDirOutside(options.stateDir, p, message => new RebuildError('REBUILD_STATE_INSIDE_PACKAGE', message));
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    const original = JSON.parse(inputs.configText) as JsonValue;
    let patched: JsonValue;
    try { assertPatchFresh({ config_sha256: configHash }, inputs.configHash); assertOpNames(original, ops); patched = applyConfigPatch(original, ops); }
    catch (e) { if (e instanceof ConfigPatchError) throw new RebuildError(e.code, e.message.slice(e.code.length + 2)); throw e; }
    assertNamedFilesHeld(original, patched);
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) { const refusal = new RebuildError(resolved.error.split(/[ :]/)[0]!, ''); refusal.message = resolved.error; throw refusal; }
    if (running) throw new RebuildError('BONES_CHECK_BUSY', 'a bones check is still running');
    running = true;
    const opsSha256 = sha256(JSON.stringify(ops)), dir = join(options.stateDir, 'bones-check', p.sourceHash, opsSha256);
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'config.json'), scratchConfigText(inputs.config, patched), { mode: 0o600 });
      const propose = await lint(resolved.producer, dir, inputs.parts, p.handoff?.source ?? null);
      const cmp = await runTool(resolved.producer.bin, compareArgs(inputs.config, 'config.json'), { cwd: dir });
      const read = compareOrigins(cmp.lines);
      const compare: BonesCompareResult = { exitCode: cmp.exitCode, wallMs: cmp.wallMs, ...read, line: cmp.exitCode === 0 ? read.summary.find(l => l.startsWith('origin:')) ?? 'compare: no origin line' : firstRefusal(cmp.lines) ?? `rig-parts compare exited ${cmp.exitCode} without a named refusal` };
      try { await options.unchanged(); } catch { throw new RebuildError('REBUILD_INPUTS_CHANGED', 'the package or its producer handoff changed during the check'); }
      return { schema: BONES_CHECK_SCHEMA, status: 'checked', request: { configHash, opsSha256, ops }, producer: { package: resolved.producer.package, version: resolved.producer.version }, propose, compare };
    } finally {
      running = false;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { run };
}

/** `propose --from-config` on the scratch config, or the line naming the missing source painting. */
async function lint(producer: InstalledTool, dir: string, parts: string, source: string | null): Promise<BonesLintResult> {
  if (!source) return { status: 'unavailable', exitCode: null, wallMs: null, lint: [], summary: null, coverage: [], line: BONES_SOURCE_UNAVAILABLE };
  const run = await runTool(producer.bin, proposeArgs({ parts, source, config: 'config.json', out: 'propose' }), { cwd: dir });
  const read = proposeLines(run.lines.slice(0, MAX_LINES));
  // Exit 1 with LINT lines is propose's verdict on the bones, not a refusal; exit 1 with none is a refusal, quoted.
  const refusal = run.exitCode !== 0 && !read.lint.length ? firstRefusal(run.lines) ?? `rig-parts propose exited ${run.exitCode} without a named refusal` : null;
  return { status: 'ran', exitCode: run.exitCode, wallMs: run.wallMs, ...read, line: refusal ?? read.summary ?? `rig-parts propose exited ${run.exitCode}` };
}
