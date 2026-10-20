/**
 * Apply · Rebuild (issue #99): the user's chest-region designation goes to the installed producer as one mesh entry,
 * `rig-parts remesh` re-fits that one part of the package's gated rig into a scratch revision, `rigc build` compiles
 * the revision the way remesh's own gate did, and the compiled scratch build is served read-only for the viewer to
 * load in place. Review builds nothing itself, writes nothing into the package and takes no path from the client:
 * the producer inputs are the package's resolved handoff (#101, `src/handoff.ts`: declared, else the fixed discovery
 * order), the scratch directory is `<state>/rebuild/<package hash>/<designation hash>/` (no clock), and an identical
 * designation reuses its build. Once per session the baseline (`src/baseline.ts`) rebuilds the whole rig from the
 * handoff and says whether it reproduces the inspected rig.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile, lstat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { object, packagePath, safeFile, type ReviewPackage } from './manifest.ts';
import { compileArgs, firstRefusal, remeshArgs, resolveProducer, runTool, type InstalledTool } from './producer.ts';
import { HANDOFF_DECLARATION, type Handoff, type HandoffRecord } from './handoff.ts';
import { baselineKey, runBaseline, type BaselineResult } from './baseline.ts';

export const REBUILD_SCHEMA = 'rig-review-rebuild/1';
const MAX_REGIONS = 8, MAX_POINTS = 256, MAX_LINES = 4000, GRID = 256;

export interface ProducerInputs { config: string; parts: string; rig: string; configText: string; configHash: string; handoff: HandoffRecord }
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Without any handoff, Apply refuses by this name and says which flag declares one. */
export const modelingHandoffMissing = (reason: string | null) => `MODELING_HANDOFF_MISSING: no producer handoff — declare it with ${HANDOFF_DECLARATION}${reason ? ` (${reason})` : ''}`;
/** What remesh needs from the handoff, or the line naming what is missing. */
export function handoffGap(handoff: Handoff): string | null {
  if (!handoff.parts) return `MODELING_INPUT_UNAVAILABLE: ${handoff.record.missing.join(', ')}`;
  const missing = handoff.record.missing.filter(m => m.startsWith('parts.json') || m.startsWith('rig '));
  return handoff.rig && !missing.length ? null : `MODELING_INPUT_UNAVAILABLE: ${missing.join(', ') || 'rig'}`;
}
/** The handoff's config, parts and inspected rig, the config read and checked against the bytes the session is bound to. */
export async function producerInputs(handoff: Handoff | null, reason: string | null): Promise<ProducerInputs> {
  if (!handoff) throw new RebuildError('MODELING_HANDOFF_MISSING', modelingHandoffMissing(reason).slice('MODELING_HANDOFF_MISSING: '.length));
  const gap = handoffGap(handoff);
  if (gap) throw new RebuildError('MODELING_INPUT_UNAVAILABLE', gap.slice('MODELING_INPUT_UNAVAILABLE: '.length));
  const configText = await readFile(handoff.config, 'utf8'), configHash = sha256(configText);
  if (configHash !== handoff.record.config.sha256) throw new RebuildError('REBUILD_INPUTS_CHANGED', `${handoff.record.config.path} changed since the review was opened; restart review`);
  return { config: handoff.config, parts: handoff.parts!, rig: handoff.rig!, configText, configHash, handoff: handoff.record };
}

export type ProducerRegion =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; bone: string; spacing: number; band: number }
  | { name: string; bone: string; shape: 'polygon'; points: [number, number][]; spacing: number; band: number };
export interface ContourPart { name: string; regions: unknown[]; entry: Record<string, unknown> }
/** Config meshes whose entry is a contour (the only mode with regions); its regions as written. */
export function contourParts(configText: string): ContourPart[] {
  const config = object(JSON.parse(configText), 'config'), meshes = config.meshes;
  if (!meshes || typeof meshes !== 'object' || Array.isArray(meshes)) return [];
  return Object.entries(meshes as Record<string, unknown>).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const contour = (entry as Record<string, unknown>).contour;
    if (!contour || typeof contour !== 'object' || Array.isArray(contour)) return [];
    const regions = (contour as Record<string, unknown>).regions;
    return [{ name, regions: Array.isArray(regions) ? regions : [], entry: entry as Record<string, unknown> }];
  });
}

export class RebuildError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new RebuildError('REBUILD_REQUEST_INVALID', detail); };
const finite = (value: unknown, field: string, min = -Infinity, exclusive = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (exclusive ? value <= min : value < min)) bad(`${field} must be a finite number${min === -Infinity ? '' : exclusive ? ` > ${min}` : ` >= ${min}`}`);
  return value as number;
};
const onGrid = (value: number, field: string) => { if (!Number.isInteger(value * GRID)) bad(`${field} is off the 1/${GRID} px grid`); return value; };

/** One designated region in the producer's config shape. Geometry beyond types and the grid is the producer's to judge. */
export function parseProducerRegion(value: unknown, field: string, bones: readonly string[] | null): ProducerRegion {
  const v = object(value, field), keys = Object.keys(v).sort().join(',');
  const name = v.name, bone = v.bone;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) bad(`${field}.name`);
  if (typeof bone !== 'string' || !bone || bone.length > 128) bad(`${field}.bone`);
  if (bones && !bones.includes(bone as string)) throw new RebuildError('REBUILD_REGION_BONE_UNKNOWN', `${field}.bone ${String(bone)} is not a bone of the loaded model`);
  const spacing = finite(v.spacing, `${field}.spacing`, 0, true), band = onGrid(finite(v.band, `${field}.band`, 0), `${field}.band`);
  if (v.shape === 'circle') {
    if (keys !== 'band,bone,cx,cy,name,r,shape,spacing') bad(`${field}: a circle holds exactly name, shape, cx, cy, r, bone, spacing, band`);
    return { name: name as string, shape: 'circle', cx: onGrid(finite(v.cx, `${field}.cx`), `${field}.cx`), cy: onGrid(finite(v.cy, `${field}.cy`), `${field}.cy`), r: finite(v.r, `${field}.r`, 0, true), bone: bone as string, spacing, band };
  }
  if (v.shape === 'polygon') {
    if (keys !== 'band,bone,name,points,shape,spacing') bad(`${field}: a polygon holds exactly name, bone, shape, points, spacing, band`);
    if (!Array.isArray(v.points) || v.points.length < 3 || v.points.length > MAX_POINTS) bad(`${field}.points must hold 3–${MAX_POINTS} points`);
    const points = (v.points as unknown[]).map((p, i): [number, number] => {
      if (!Array.isArray(p) || p.length !== 2) bad(`${field}.points[${i}]`);
      const [x, y] = p as unknown[];
      return [onGrid(finite(x, `${field}.points[${i}].x`), `${field}.points[${i}].x`), onGrid(finite(y, `${field}.points[${i}].y`), `${field}.points[${i}].y`)];
    });
    return { name: name as string, bone: bone as string, shape: 'polygon', points, spacing, band };
  }
  return bad(`${field}.shape must be circle or polygon`);
}

export interface RebuildRequest { part: string; regions: ProducerRegion[]; configHash: string }
/** `{part, regions, configHash}`: no path, no flag, no command — the server composes everything else. */
export function parseRebuildRequest(input: unknown, bones: readonly string[] | null): RebuildRequest {
  const v = object(input, 'rebuild');
  if (Object.keys(v).sort().join(',') !== 'configHash,part,regions') bad('expected exactly {part, regions, configHash}');
  if (typeof v.part !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.part)) bad('part');
  if (typeof v.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.configHash)) bad('configHash');
  if (!Array.isArray(v.regions) || v.regions.length < 1 || v.regions.length > MAX_REGIONS) bad(`regions must hold 1–${MAX_REGIONS} entries`);
  const regions = (v.regions as unknown[]).map((r, i) => parseProducerRegion(r, `regions[${i}]`, bones));
  if (new Set(regions.map(r => r.name)).size !== regions.length) bad('regions: duplicate names');
  return { part: v.part as string, regions, configHash: v.configHash as string };
}

/** The part's config entry with `contour.regions` replaced by the designation and every other field as written. */
export function meshEntryText(configText: string, part: string, regions: readonly ProducerRegion[]): string {
  const found = contourParts(configText).find(p => p.name === part);
  if (!found) throw new RebuildError('REBUILD_PART_NOT_CONTOUR', `config meshes.${part} is not a contour entry; regions apply to contour meshes only`);
  const entry = structuredClone(found.entry), contour = entry.contour as Record<string, unknown>;
  contour.regions = regions.map(r => ({ ...r }));
  return JSON.stringify(entry, null, 1) + '\n';
}

/** Deterministic: the package, the config bytes, the part, the entry bytes and both tool versions. No clock. */
export function designationId(input: { sourceHash: string; configHash: string; part: string; entry: string; producer: string; compiler: string }): string {
  return sha256(JSON.stringify([REBUILD_SCHEMA, input.sourceHash, input.configHash, input.part, input.entry, input.producer, input.compiler]));
}
export const rebuildRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'rebuild', sourceHash);
export const rebuildDir = (stateDir: string, sourceHash: string, id: string) => join(rebuildRoot(stateDir, sourceHash), id);

export type RebuildStatus = 'running' | 'built' | 'refused' | 'failed';
export interface RebuildBuild { model: string; modelUrl: string; modelHash: string; files: Record<string, string> }
export interface RebuildJob {
  schema: typeof REBUILD_SCHEMA; id: string; status: RebuildStatus; reused: boolean;
  request: { part: string; regions: ProducerRegion[]; configHash: string; entrySha256: string };
  producer: { package: string; version: string }; compiler: { package: string; version: string };
  lines: string[]; producerLine: string | null; exitCode: number | null; wallMs: { remesh: number | null; compile: number | null };
  build: RebuildBuild | null;
}
export interface RebuildOptions { stateDir: string; starts: readonly string[]; unchanged: () => Promise<void>; bones: readonly string[] | null }
export const baselineDir = (stateDir: string, key: string) => join(stateDir, 'baseline', key);

const tool = (t: InstalledTool) => ({ package: t.package, version: t.version });
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

/** Hash every page the compiled model names and the model itself; names are literal relative paths inside the build. */
async function hashBuild(build: string, id: string): Promise<RebuildBuild> {
  const dir = await realpath(build), model = 'skeleton.model.json', bytes = await readFile(await safeFile(dir, model)), doc = object(JSON.parse(bytes.toString('utf8')), 'model');
  if (doc.spec !== 'rigc-compiled/3' || !Array.isArray(doc.pages)) throw new RebuildError('REBUILD_BUILD_INVALID', 'the compiled scratch model is not rigc-compiled/3 with pages');
  const files: Record<string, string> = { [model]: sha256(bytes) };
  for (const page of doc.pages) { const name = packagePath(object(page, 'model.pages[]').name, 'model.pages[].name'); files[name] = sha256(await readFile(await safeFile(dir, name))); }
  return { model, modelUrl: `/rebuild/${id}/${model}`, modelHash: files[model]!, files };
}

/** One rebuild at a time per review instance; finished jobs stay readable by id. */
export function createRebuilds(p: ReviewPackage, options: RebuildOptions) {
  const jobs = new Map<string, RebuildJob>();
  let running: string | null = null;
  const snapshot = (job: RebuildJob): RebuildJob => ({ ...job, lines: [...job.lines] });

  /** The state directory may not sit inside the package or the handoff's root (the parent of an opened out/). */
  function assertStateOutside(): void {
    for (const root of [p.root, ...(p.handoff ? [p.handoff.root] : [])]) {
      const inside = relative(root, options.stateDir);
      if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) throw new RebuildError('REBUILD_STATE_INSIDE_PACKAGE', 'the review state directory is inside the inspected package; set RIG_REVIEW_STATE_DIR outside it');
    }
  }
  /** Once per session: the first time the handoff and the producer both resolve, the baseline starts (or is reused). */
  let baseline: BaselineResult | null = null, baselineRun: Promise<BaselineResult> | null = null;
  function ensureBaseline(resolved: ReturnType<typeof resolveProducer>): BaselineResult | null {
    if (baselineRun || !p.handoff || !resolved.ok) return baseline;
    try { assertStateOutside(); } catch { return null; }
    const handoff = p.handoff, key = baselineKey(p.sourceHash, handoff, resolved.producer, resolved.compiler), rig = handoff.rig ?? p.root;
    const show = (rel: string) => relative(p.root, join(rig, rel)).split(sep).join('/');
    baseline = { schema: 'rig-review-baseline/1', key, status: 'running', producer: tool(resolved.producer), firstDifference: null, hashes: null, line: `baseline: running ${resolved.producer.package} ${resolved.producer.version} rig into scratch…`, exitCode: null, wallMs: null };
    const started = baseline;
    baselineRun = runBaseline(baselineDir(options.stateDir, key), key, handoff, resolved.producer, show)
      .catch((error): BaselineResult => ({ ...started, status: 'failed', line: `baseline: failed — ${error instanceof Error ? error.message : String(error)}` }))
      .then(result => (baseline = result));
    return baseline;
  }

  /** `GET /api/rebuild`: whether Apply can run here, the handoff and its baseline, and what the config holds (so the editor can start from it). */
  async function describe() {
    await options.unchanged();
    const handoff = p.handoff, gap = handoff ? handoffGap(handoff) : null;
    const inputs = handoff && !gap ? await producerInputs(handoff, p.handoffReason) : null;
    const resolved = resolveProducer(options.starts);
    const parts = inputs ? contourParts(inputs.configText).map(({ name, regions }) => ({ name, regions })) : [];
    const contour = inputs ? Object.fromEntries(contourParts(inputs.configText).map(({ name, entry }) => [name, entry])) : {};
    const reason = !handoff ? (p.handoffReason ?? modelingHandoffMissing(null)) : gap ?? (!resolved.ok ? resolved.error : parts.length ? null : 'REBUILD_INPUTS_UNAVAILABLE: the config states no contour mesh');
    return {
      schema: 'rig-review-rebuild-status/1', available: !!inputs && resolved.ok && parts.length > 0,
      handoff: handoff ? handoff.record : null,
      inputs: inputs && handoff ? { config: handoff.record.config.path, parts: handoff.record.parts, rig: handoff.record.rig, configHash: inputs.configHash } : null,
      baseline: ensureBaseline(resolved),
      parts, contour,
      producer: resolved.ok ? tool(resolved.producer) : null, compiler: resolved.ok ? tool(resolved.compiler) : null,
      reason,
      running,
    };
  }
  /** The baseline once it settles (tests, and the whole-rig ops of #102/#103 through assertWholeRigBaseline). */
  async function settledBaseline(): Promise<BaselineResult | null> { if (!baselineRun) ensureBaseline(resolveProducer(options.starts)); return baselineRun ? await baselineRun : baseline; }

  async function reuse(dir: string, id: string): Promise<RebuildJob | null> {
    const resultFile = join(dir, 'result.json');
    if (!(await exists(resultFile))) return null;
    try {
      const stored = JSON.parse(await readFile(resultFile, 'utf8')) as RebuildJob;
      if (stored.schema !== REBUILD_SCHEMA || stored.id !== id || stored.status !== 'built' || !stored.build) return null;
      const now = await hashBuild(join(dir, 'build'), id);
      if (JSON.stringify(now.files) !== JSON.stringify(stored.build.files)) return null;
      return { ...stored, reused: true };
    } catch { return null; }
  }

  async function execute(job: RebuildJob, dir: string, inputs: ProducerInputs, resolved: Extract<ReturnType<typeof resolveProducer>, { ok: true }>, entry: string): Promise<void> {
    const push = (line: string) => { if (job.lines.length < MAX_LINES) job.lines.push(line); };
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'mesh.json'), entry, { mode: 0o600 });
      push(`review: ${resolved.producer.package} ${resolved.producer.version} remesh ${job.request.part} → scratch revision`);
      const remesh = await runTool(resolved.producer.bin, remeshArgs({ rig: inputs.rig, config: inputs.config, parts: inputs.parts, part: job.request.part, mesh: 'mesh.json', out: 'revision' }), { cwd: dir, onLine: push });
      job.exitCode = remesh.exitCode; job.wallMs.remesh = remesh.wallMs;
      if (remesh.exitCode !== 0) { job.producerLine = firstRefusal(remesh.lines) ?? `rig-parts remesh exited ${remesh.exitCode} without a named refusal`; job.status = 'refused'; return; }
      job.producerLine = remesh.lines.filter(l => l.trim()).at(-1)?.trim() ?? null;
      const provenance = object(JSON.parse(await readFile(join(dir, 'revision', 'remesh.json'), 'utf8')), 'remesh.json'), request = object(provenance.request, 'remesh.json request');
      const pageEdges = request.page_edges === 'pot' ? 'pot' : 'free', packShape = request.pack_shape === 'rect' ? 'rect' : 'polygon';
      push(`review: ${resolved.compiler.package} ${resolved.compiler.version} build --profile rig-play --pack --page-edges ${pageEdges} --pack-shape ${packShape} (the revision's own pack flags)`);
      const compile = await runTool(resolved.compiler.bin, compileArgs({ rig: 'revision/rig.json', motion: 'revision/motion.json', out: 'build', pageEdges, packShape }), { cwd: dir, onLine: push });
      job.wallMs.compile = compile.wallMs;
      if (compile.exitCode !== 0) { job.exitCode = compile.exitCode; job.producerLine = firstRefusal(compile.lines) ?? `rigc build exited ${compile.exitCode} without a named refusal`; job.status = 'refused'; return; }
      // The package and its producer inputs must still be the bytes the request was made against.
      // The handoff files are in the reviewed identity, so this also catches a config, parts or rig change.
      try { await options.unchanged(); } catch { throw new RebuildError('REBUILD_INPUTS_CHANGED', 'the package or its producer handoff changed during the rebuild'); }
      job.build = await hashBuild(join(dir, 'build'), job.id);
      job.status = 'built';
      await writeFile(join(dir, 'result.json'), JSON.stringify({ ...job, reused: false }, null, 1) + '\n', { mode: 0o600 });
      // Each Apply replaces the previous scratch build of this package.
      for (const sibling of await readdir(rebuildRoot(options.stateDir, p.sourceHash))) if (sibling !== job.id && /^[a-f0-9]{64}$/.test(sibling)) { await rm(join(rebuildRoot(options.stateDir, p.sourceHash), sibling), { recursive: true, force: true }); jobs.delete(sibling); }
    } catch (error) {
      job.status = 'failed'; job.producerLine = error instanceof Error ? error.message : String(error); push(`review: ${job.producerLine}`);
    } finally {
      // Only a built designation keeps its scratch directory; a refusal or failure leaves nothing behind.
      if (job.status !== 'built') await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** `POST /api/rebuild`: refusals are returned before anything is written or run. */
  async function start(input: unknown): Promise<{ status: number; body: unknown }> {
    const request = parseRebuildRequest(input, options.bones);
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason);
    if (inputs.configHash !== request.configHash) throw new RebuildError('REBUILD_CONFIG_STALE', 'the producer config changed since the editor read it; reload');
    const entry = meshEntryText(inputs.configText, request.part, request.regions);
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error, producerLine: resolved.error } };
    const id = designationId({ sourceHash: p.sourceHash, configHash: inputs.configHash, part: request.part, entry, producer: `${resolved.producer.package}@${resolved.producer.version}`, compiler: `${resolved.compiler.package}@${resolved.compiler.version}` });
    const current = jobs.get(id);
    if (current?.status === 'running') return { status: 202, body: snapshot(current) };
    if (running) return { status: 200, body: { status: 'refused', error: `REBUILD_BUSY: rebuild ${running} is still running`, producerLine: null } };
    const dir = rebuildDir(options.stateDir, p.sourceHash, id);
    const reused = await reuse(dir, id);
    if (reused) { jobs.set(id, reused); return { status: 200, body: snapshot(reused) }; }
    const job: RebuildJob = { schema: REBUILD_SCHEMA, id, status: 'running', reused: false, request: { ...request, entrySha256: sha256(entry) }, producer: tool(resolved.producer), compiler: tool(resolved.compiler), lines: [], producerLine: null, exitCode: null, wallMs: { remesh: null, compile: null }, build: null };
    jobs.set(id, job); running = id;
    void execute(job, dir, inputs, resolved, entry).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }

  function read(id: string): RebuildJob {
    const job = jobs.get(id);
    if (!job) throw new RebuildError('REBUILD_NOT_FOUND', id);
    return snapshot(job);
  }

  /** A served scratch file: only a built job's hashed model and pages, read-only. */
  async function file(id: string, name: string): Promise<string> {
    const job = jobs.get(id);
    if (!job || job.status !== 'built' || !job.build || !Object.hasOwn(job.build.files, name)) throw new RebuildError('REBUILD_NOT_FOUND', `${id}/${name}`);
    return safeFile(await realpath(join(rebuildDir(options.stateDir, p.sourceHash, id), 'build')), packagePath(name));
  }

  return { describe, start, read, file, running: () => running, baseline: settledBaseline };
}
