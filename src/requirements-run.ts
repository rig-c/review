/**
 * `POST /api/requirements` (issue #113): the page's declared requirements, written by review as a
 * `spine-parts-requirements/1` file into `<state>/requirements/<package hash>/<run id>/requirements.json`, then
 * `rig-parts check --rig <rig> --out out --parts <handoff parts> --requirements requirements.json` with the installed
 * producer, on the inspected rig spec (the handoff's) or on the session's latest scratch revision. The job keeps what
 * check said (its requirements block, its lines, its refusals verbatim); the scratch directory is removed after the run.
 * `GET /api/requirements` says what the stage offers the panel: the rig spec's bones, slots and their mesh attachments,
 * its ik and transform constraints, motion.json's animations, and whether a scratch revision exists.
 * The client sends typed requirements only — never a path or a flag. Nothing is written into the package.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { ReviewPackage } from './manifest.ts';
import { resolveProducer, runTool } from './producer.ts';
import { producerInputs, RebuildError } from './rebuild.ts';
import { parseRequirementsRequest, readRequirements, requirementsCheckArgs, requirementsDocument, requirementsFileText, RequirementsError, REQUIREMENTS_RUN_SCHEMA, type RequirementRow, type RequirementsBuild } from './requirements.ts';
import { assertStateOutside as assertStateDirOutside } from './state-dir.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const MAX_LINES = 4000;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export interface RequirementsJob {
  schema: typeof REQUIREMENTS_RUN_SCHEMA; id: string; status: 'running' | 'checked' | 'refused' | 'failed';
  build: RequirementsBuild; buildId: string | null;
  /** The file as written: its sha256, its byte length and its text. */
  file: { sha256: string; size: number; text: string };
  producer: { package: string; version: string };
  exitCode: number | null; wallMs: number | null;
  rows: RequirementRow[]; summary: string | null; checkLine: string | null;
  /** `REQUIREMENTS_*` lines verbatim; non-empty means the file was refused before anything was built. */
  refusals: string[];
  /** `CHECK_REQUIREMENT_MET` / `CHECK_REQUIREMENT_MEASURABLE` lines verbatim. */
  problems: string[];
  /** The line to show when nothing was measured: a named refusal verbatim, or why the run failed. */
  error: string | null;
  lines: string[];
}
export interface RequirementsCatalog {
  status: 'ready' | 'unavailable'; reason: string | null;
  bones: string[]; slots: string[]; meshes: Record<string, string[]>;
  /** Each slot's bone, so a slot picked on the stage names its bone. */
  slotBones: Record<string, string>;
  constraints: { name: string; type: 'ik' | 'transform'; bones: string[]; drives: string[] }[];
  animations: { name: string; duration: number | null }[];
  scratch: string | null;
}
export interface RequirementsOptions {
  stateDir: string; starts: readonly string[]; unchanged: () => Promise<void>;
  /** The session's latest built scratch build and the rig spec directory its producer op wrote. */
  latest: () => { id: string; spec: string } | null;
}
export const requirementsRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'requirements', sourceHash);

/** The mesh attachments each slot holds in any skin (short form, or the long form's `attachments`). */
function meshesOf(rig: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const skin of Object.values(isRecord(rig.skins) ? rig.skins : {})) {
    if (!isRecord(skin)) continue;
    const attachments = isRecord(skin.attachments) ? skin.attachments : skin;
    for (const [slot, held] of Object.entries(attachments)) {
      if (!isRecord(held)) continue;
      for (const [name, a] of Object.entries(held)) if (isRecord(a) && a.type === 'mesh') (out[slot] ??= new Set()).add(name);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([slot, names]) => [slot, [...names].sort()]));
}
function drivesOf(c: Record<string, unknown>): string[] {
  if (c.type === 'ik') return ['rotate'];
  const to = new Set<string>();
  if (isRecord(c.properties)) for (const p of Object.values(c.properties)) if (isRecord(p) && isRecord(p.to)) for (const k of Object.keys(p.to)) to.add(k);
  return [...(to.has('rotate') ? ['rotate'] : []), ...(to.has('x') || to.has('y') ? ['translate'] : [])];
}
/** What a rig spec directory offers the panel; names only. */
export async function rigCatalog(rigDir: string): Promise<Omit<RequirementsCatalog, 'status' | 'reason' | 'scratch'>> {
  const read = async (name: string): Promise<Record<string, unknown>> => { try { const v = JSON.parse(await readFile(join(rigDir, name), 'utf8')); return isRecord(v) ? v : {}; } catch { return {}; } };
  const rig = await read('rig.json'), motion = await read('motion.json');
  const names = (list: unknown) => (Array.isArray(list) ? list : []).filter(isRecord).map(x => x.name).filter((n): n is string => typeof n === 'string');
  const constraints = (Array.isArray(rig.constraints) ? rig.constraints : []).filter(isRecord).filter(c => (c.type === 'ik' || c.type === 'transform') && typeof c.name === 'string')
    .map(c => ({ name: c.name as string, type: c.type as 'ik' | 'transform', bones: (Array.isArray(c.bones) ? c.bones : []).filter((b): b is string => typeof b === 'string'), drives: drivesOf(c) }));
  const animations = Object.entries(isRecord(motion.animations) ? motion.animations : {}).map(([name, a]) => ({ name, duration: isRecord(a) && typeof a.duration === 'number' ? a.duration : null }));
  const slotBones = Object.fromEntries((Array.isArray(rig.slots) ? rig.slots : []).filter(isRecord).filter(x => typeof x.name === 'string' && typeof x.bone === 'string').map(x => [x.name as string, x.bone as string]));
  return { bones: names(rig.bones), slots: names(rig.slots), meshes: meshesOf(rig), slotBones, constraints, animations };
}

/** One check at a time per review instance; finished jobs stay readable by id. */
export function createRequirementsCheck(p: ReviewPackage, options: RequirementsOptions) {
  const jobs = new Map<string, RequirementsJob>();
  let running: string | null = null;
  const snapshot = (job: RequirementsJob): RequirementsJob => JSON.parse(JSON.stringify(job)) as RequirementsJob;
  function assertStateOutside(): void {
    assertStateDirOutside(options.stateDir, p, message => new RequirementsError('REQUIREMENTS_STATE_INSIDE_PACKAGE', message));
  }
  const asRequirements = (e: unknown): never => { if (e instanceof RebuildError) throw new RequirementsError(e.code, e.message.slice(e.code.length + 2)); throw e; };

  async function describe(): Promise<RequirementsCatalog> {
    await options.unchanged();
    const empty = { bones: [], slots: [], meshes: {}, slotBones: {}, constraints: [], animations: [] };
    let rig: string;
    try { rig = (await producerInputs(p.handoff, p.handoffReason)).rig; } catch (e) { if (e instanceof RebuildError) return { status: 'unavailable', reason: e.message, ...empty, scratch: null }; throw e; }
    return { status: 'ready', reason: null, ...await rigCatalog(rig), scratch: options.latest()?.id ?? null };
  }

  async function execute(job: RequirementsJob, dir: string, bin: string, rig: string, parts: string, names: string[]): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'requirements.json'), job.file.text, { mode: 0o600 });
      const run = await runTool(bin, requirementsCheckArgs({ rig, parts, out: 'out', requirements: 'requirements.json' }), { cwd: dir, onLine: line => { if (job.lines.length < MAX_LINES) job.lines.push(line); } });
      let checkJson: unknown = null;
      try { checkJson = JSON.parse(await readFile(join(dir, 'out', 'check.json'), 'utf8')); } catch { /* refused before check.json; the lines say why */ }
      const read = readRequirements(names, checkJson, run.lines);
      Object.assign(job, { exitCode: run.exitCode, wallMs: run.wallMs, rows: read.rows, summary: read.summary, checkLine: read.checkLine, refusals: read.refusals, problems: read.problems });
      try { await options.unchanged(); } catch { throw new RequirementsError('REQUIREMENTS_INPUTS_CHANGED', 'the package or its producer handoff changed during the check'); }
      if (read.rows.length) job.status = 'checked';
      else { job.status = 'refused'; job.error = read.refusal ?? `rig-parts check exited ${run.exitCode} without a named refusal`; }
    } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
    finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  /** Refusals before anything runs; a malformed request is REQUIREMENTS_REQUEST_INVALID (400 at the route). */
  async function start(input: unknown): Promise<{ status: number; body: unknown }> {
    const request = parseRequirementsRequest(input);
    assertStateOutside();
    await options.unchanged();
    const inputs = await producerInputs(p.handoff, p.handoffReason).catch(asRequirements);
    let rig = inputs.rig, buildId: string | null = null;
    if (request.build === 'scratch') {
      const latest = options.latest();
      if (!latest) return { status: 200, body: { status: 'refused', error: 'REQUIREMENTS_NO_SCRATCH: no scratch build in this session yet; Apply builds one, or check the inspected rig' } };
      rig = latest.spec; buildId = latest.id;
    }
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error } };
    const text = requirementsFileText(requirementsDocument(request.fps, request.requirements)), fileSha = sha256(text);
    const producer = { package: resolved.producer.package, version: resolved.producer.version };
    const id = sha256(JSON.stringify([REQUIREMENTS_RUN_SCHEMA, p.sourceHash, fileSha, request.build, buildId, inputs.configHash, `${producer.package}@${producer.version}`]));
    const current = jobs.get(id);
    if (current && current.status !== 'failed') return { status: current.status === 'running' ? 202 : 200, body: snapshot(current) };
    if (running) return { status: 200, body: { status: 'refused', error: `REQUIREMENTS_BUSY: requirements check ${running} is still running` } };
    const job: RequirementsJob = {
      schema: REQUIREMENTS_RUN_SCHEMA, id, status: 'running', build: request.build, buildId,
      file: { sha256: fileSha, size: Buffer.byteLength(text), text }, producer,
      exitCode: null, wallMs: null, rows: [], summary: null, checkLine: null, refusals: [], problems: [], error: null, lines: [],
    };
    jobs.set(id, job); running = id;
    const names = request.requirements.map(r => String(r.name ?? ''));
    void execute(job, join(requirementsRoot(options.stateDir, p.sourceHash), id), resolved.producer.bin, rig, inputs.parts, names).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }
  function read(id: string): RequirementsJob {
    const job = jobs.get(id);
    if (!job) throw new RequirementsError('REQUIREMENTS_NOT_FOUND', id);
    return snapshot(job);
  }
  return { start, read, describe, running: () => running };
}
