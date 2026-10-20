/**
 * `POST /api/environment-check` (issue #112): "Check under this world". The Environment block's exported
 * `rigc-environment/1` schedule is written by review into `<state>/environment-check/<package hash>/<id>/environment.json`,
 * then `rig-parts check --rig <rig> --out out --parts <handoff parts> --page-edges free --pack-shape polygon
 * --environment environment.json` runs with the installed producer (@rig-c/parts 1.48.0 or later, parts#538), on the
 * inspected rig spec (the handoff's, read only) or on the session's latest scratch revision. The pack flags are the
 * inspected build's own background check's (`src/baseline.ts`), so the default-world line beside it differs only by the
 * world. The job keeps what check said: its `environment:` line, check.json's `environment` record (path, sha256, steps),
 * the ANIMATIONS_DO_NOT_FOLD and TEXTURE_STRETCH lines, the summary, and a `CHECK_ENVIRONMENT` refusal verbatim. The
 * check's output directory is removed after the run; the result is stored so the same schedule on the same build is read
 * back. The client sends `{build, schedule}` only — never a path or a flag. Nothing is written into the package.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { ReviewPackage } from './manifest.ts';
import { firstRefusal, modelingProducerTooOld, resolveProducer, runTool, versionAtLeast } from './producer.ts';
import { producerInputs, RebuildError } from './rebuild.ts';
import { checkSummary, type CheckSummary } from './applied-context.ts';
import { barLine, READOUT_BARS } from './physics-tuning.ts';
import { CHECK_ENVIRONMENT_SINCE, parseSchedule, ScheduleError, scheduleText } from './environment-schedule.ts';

export const ENVIRONMENT_CHECK_SCHEMA = 'rig-review-environment-check/1';
export const ENVIRONMENT_CHECK_LIMIT = 64 * 1024;
const MAX_LINES = 4000;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export class EnvironmentCheckError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
export type EnvironmentCheckBuild = 'inspected' | 'scratch';
export interface EnvironmentCheckRequest { build: EnvironmentCheckBuild; text: string }
/** `{build, schedule}` only: the schedule as data (re-serialized here, so its hash is the exported bytes'), never a path. */
export function parseEnvironmentCheckRequest(input: unknown): EnvironmentCheckRequest {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'build,schedule') throw new EnvironmentCheckError('ENVIRONMENT_CHECK_REQUEST_INVALID', 'expected exactly {build, schedule}');
  if (input.build !== 'inspected' && input.build !== 'scratch') throw new EnvironmentCheckError('ENVIRONMENT_CHECK_REQUEST_INVALID', 'build must be inspected or scratch');
  try { return { build: input.build, text: scheduleText(parseSchedule(input.schedule)) }; }
  catch (e) { if (e instanceof ScheduleError) throw new EnvironmentCheckError('ENVIRONMENT_CHECK_REQUEST_INVALID', e.message); throw e; }
}
/** check's argv as `rig-parts check --help` states it (1.48.0); every path the server's. */
export const environmentCheckArgs = (r: { rig: string; parts: string; out: string; environment: string }): string[] =>
  ['check', '--rig', r.rig, '--out', r.out, '--parts', r.parts, '--page-edges', 'free', '--pack-shape', 'polygon', '--environment', r.environment];

/** What check.json records under `--environment` (parts#538): the path as given, the bytes' sha256, the step count. */
export interface CheckEnvironmentRecord { path: string; sha256: string; steps: number }
export function checkEnvironmentRecord(checkJson: unknown): CheckEnvironmentRecord | null {
  const e = isRecord(checkJson) && isRecord(checkJson.environment) ? checkJson.environment : null;
  return e && typeof e.path === 'string' && typeof e.sha256 === 'string' && Number.isSafeInteger(e.steps) ? { path: e.path, sha256: e.sha256, steps: e.steps as number } : null;
}
/** check's `environment: <path>, rigc-environment/1, <n> step(s), sha256 <16 hex> — …` line, verbatim (trimmed). */
export const environmentLineOf = (lines: readonly string[]) => lines.map(l => l.trim()).find(l => /^environment: \S.*rigc-environment\/1, \d+ step\(s\), sha256 [0-9a-f]{16}/.test(l)) ?? null;

export interface EnvironmentCheckJob {
  schema: typeof ENVIRONMENT_CHECK_SCHEMA; id: string; status: 'running' | 'checked' | 'refused' | 'failed';
  build: EnvironmentCheckBuild; buildId: string | null;
  /** The schedule as written: its sha256, byte length, step count. */
  schedule: { sha256: string; size: number; steps: number };
  producer: { package: string; version: string };
  exitCode: number | null; wallMs: number | null;
  check: CheckSummary | null;
  /** check.json's `environment`; its sha256 must be the schedule's (a mismatch fails the job). */
  environment: CheckEnvironmentRecord | null;
  environmentLine: string | null;
  /** The readout bars' lines (ANIMATIONS_DO_NOT_FOLD, TEXTURE_STRETCH) as check printed them. */
  bars: { name: string; line: string }[];
  /** A named refusal verbatim (`FAIL  CHECK_ENVIRONMENT: …`), or why the run failed. */
  error: string | null;
  lines: string[];
}
export interface EnvironmentCheckOptions {
  stateDir: string; starts: readonly string[]; unchanged: () => Promise<void>;
  latest: () => { id: string; spec: string } | null;
}
export const environmentCheckRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'environment-check', sourceHash);

/** One check at a time per review instance; finished jobs stay readable by id, and a stored result is read back. */
export function createEnvironmentCheck(p: ReviewPackage, options: EnvironmentCheckOptions) {
  const jobs = new Map<string, EnvironmentCheckJob>();
  let running: string | null = null;
  const snapshot = (job: EnvironmentCheckJob): EnvironmentCheckJob => JSON.parse(JSON.stringify(job)) as EnvironmentCheckJob;
  function assertStateOutside(): void {
    for (const root of [p.root, ...(p.handoff ? [p.handoff.root] : [])]) {
      const inside = relative(root, options.stateDir);
      if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) throw new EnvironmentCheckError('ENVIRONMENT_CHECK_STATE_INSIDE_PACKAGE', 'the review state directory is inside the inspected package; set RIG_REVIEW_STATE_DIR outside it');
    }
  }

  async function execute(job: EnvironmentCheckJob, dir: string, bin: string, rig: string, parts: string, text: string): Promise<void> {
    try {
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, 'environment.json'), text, { mode: 0o600 });
      const run = await runTool(bin, environmentCheckArgs({ rig, parts, out: 'out', environment: 'environment.json' }), { cwd: dir, onLine: line => { if (job.lines.length < MAX_LINES) job.lines.push(line); } });
      let checkJson: unknown = null;
      try { checkJson = JSON.parse(await readFile(join(dir, 'out', 'check.json'), 'utf8')); } catch { /* refused before check.json; the lines say why */ }
      const refusal = firstRefusal(run.lines);
      Object.assign(job, { exitCode: run.exitCode, wallMs: run.wallMs, environmentLine: environmentLineOf(run.lines), environment: checkEnvironmentRecord(checkJson) });
      try { await options.unchanged(); } catch { throw new EnvironmentCheckError('ENVIRONMENT_CHECK_INPUTS_CHANGED', 'the package or its producer handoff changed during the check'); }
      if (checkJson === null) { job.status = 'refused'; job.error = refusal ?? `rig-parts check exited ${run.exitCode} without a named refusal`; }
      else {
        job.check = checkSummary(checkJson, run.exitCode, run.lines, refusal);
        job.bars = READOUT_BARS.map(name => ({ name, line: barLine(name, run.lines, job.check) }));
        if (!job.environment || job.environment.sha256 !== job.schedule.sha256) throw new EnvironmentCheckError('ENVIRONMENT_CHECK_UNRECORDED', `check.json's environment ${job.environment ? `sha256 ${job.environment.sha256}` : 'is absent'}; the schedule written was sha256 ${job.schedule.sha256}`);
        job.status = 'checked';
      }
      await writeFile(join(dir, 'result.json'), JSON.stringify({ ...job, lines: job.lines.slice(-MAX_LINES) }, null, 1) + '\n', { mode: 0o600 });
    } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
    finally { await rm(join(dir, 'out'), { recursive: true, force: true }).catch(() => {}); if (job.status === 'failed') await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }

  /** Refusals before anything runs; a malformed request is ENVIRONMENT_CHECK_REQUEST_INVALID (400 at the route). */
  async function start(input: unknown): Promise<{ status: number; body: unknown }> {
    const request = parseEnvironmentCheckRequest(input);
    assertStateOutside();
    await options.unchanged();
    let inputs: Awaited<ReturnType<typeof producerInputs>>;
    try { inputs = await producerInputs(p.handoff, p.handoffReason); } catch (e) { if (e instanceof RebuildError) return { status: 200, body: { status: 'refused', error: e.message } }; throw e; }
    let rig = inputs.rig, buildId: string | null = null;
    if (request.build === 'scratch') {
      const latest = options.latest();
      if (!latest) return { status: 200, body: { status: 'refused', error: 'ENVIRONMENT_CHECK_NO_SCRATCH: no scratch build in this session yet; Apply builds one, or check the inspected rig' } };
      rig = latest.spec; buildId = latest.id;
    }
    const resolved = resolveProducer(options.starts);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error } };
    const producer = { package: resolved.producer.package, version: resolved.producer.version };
    if (!versionAtLeast(producer.version, CHECK_ENVIRONMENT_SINCE)) return { status: 200, body: { status: 'refused', error: modelingProducerTooOld(producer.version || 'unknown', CHECK_ENVIRONMENT_SINCE, 'rig-parts check --environment') } };
    const fileSha = sha256(request.text);
    const id = sha256(JSON.stringify([ENVIRONMENT_CHECK_SCHEMA, p.sourceHash, fileSha, request.build, buildId, inputs.configHash, `${producer.package}@${producer.version}`]));
    const current = jobs.get(id);
    if (current && current.status !== 'failed') return { status: current.status === 'running' ? 202 : 200, body: snapshot(current) };
    const dir = join(environmentCheckRoot(options.stateDir, p.sourceHash), id);
    try { const stored = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as EnvironmentCheckJob; if (stored.schema === ENVIRONMENT_CHECK_SCHEMA && stored.id === id) { jobs.set(id, stored); return { status: 200, body: snapshot(stored) }; } } catch { /* not run yet */ }
    if (running) return { status: 200, body: { status: 'refused', error: `ENVIRONMENT_CHECK_BUSY: check ${running} is still running` } };
    const job: EnvironmentCheckJob = {
      schema: ENVIRONMENT_CHECK_SCHEMA, id, status: 'running', build: request.build, buildId,
      schedule: { sha256: fileSha, size: Buffer.byteLength(request.text), steps: (JSON.parse(request.text) as { steps: unknown[] }).steps.length }, producer,
      exitCode: null, wallMs: null, check: null, environment: null, environmentLine: null, bars: [], error: null, lines: [],
    };
    jobs.set(id, job); running = id;
    void execute(job, dir, resolved.producer.bin, rig, inputs.parts, request.text).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }
  function read(id: string): EnvironmentCheckJob {
    const job = jobs.get(id);
    if (!job) throw new EnvironmentCheckError('ENVIRONMENT_CHECK_NOT_FOUND', id);
    return snapshot(job);
  }
  return { start, read, running: () => running };
}
