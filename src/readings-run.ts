/**
 * `POST /api/readings` (issue #108): the requested readings run, one `rigc render` each, on the inspected build (the
 * package's compiled model directory, read only) and on the session's latest scratch build (if any), each into
 * `<state>/readings/<package hash>/<build>/<reading key>/` — no clock in any name, and an identical reading on the same
 * build and compiler reuses its stored result. Only the reading's JSON and frames.json are kept; the rendered frames are
 * removed. Nothing is written into the package (checked again after the run); no path comes from the client.
 */
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { safeFile, type ReviewPackage } from './manifest.ts';
import { resolveCompiler, runTool, type InstalledTool } from './producer.ts';
import { environmentSchedule, helpHasEnvironment, parseReadingsRequest, READING_FILE, readingLabel, readingResult, READINGS_SCHEMA, READINGS_SINCE, ReadingsError, renderArgs, type ReadingBuild, type ReadingRequest, type ReadingResult, type ReadingsRequest } from './readings.ts';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }

export interface ReadingsBuildRun { build: ReadingBuild; id: string; modelHash: string; results: ReadingResult[] }
export interface ReadingsJob {
  schema: typeof READINGS_SCHEMA; id: string; status: 'running' | 'done' | 'failed'; error: string | null;
  request: ReadingsRequest;
  /** Whether the schedule went to rigc: only when one was asked for and this rigc's `render --help` lists `--environment`. */
  environment: { requested: boolean; flag: boolean; passed: boolean };
  compiler: { package: string; version: string };
  runs: ReadingsBuildRun[];
}
export interface ReadingsOptions {
  stateDir: string; starts: readonly string[]; unchanged: () => Promise<void>;
  /** The session's latest built scratch build: its id, its build directory and its model hash. */
  latest: () => { id: string; build: string; modelHash: string } | null;
}
export const readingsRoot = (stateDir: string, sourceHash: string) => join(stateDir, 'readings', sourceHash);
/** Deterministic: the reading, the animation, the schedule passed (or none), the compiler and the build's model bytes. */
export const readingKey = (r: ReadingRequest, animation: string, schedule: unknown, compiler: string, modelHash: string) => sha256(JSON.stringify([READINGS_SCHEMA, readingLabel(r), animation, schedule, compiler, modelHash]));

/** One reading on one build: reuse its stored result, or run `rigc render` and keep its JSON beside the result. */
export async function runReading(r: ReadingRequest, animation: string, candidate: string, dir: string, key: string, compiler: InstalledTool, schedule: unknown): Promise<ReadingResult> {
  const resultFile = join(dir, 'result.json');
  try { const stored = JSON.parse(await readFile(resultFile, 'utf8')) as { key: string; result: ReadingResult }; if (stored.key === key) return stored.result; } catch { /* not run yet */ }
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (schedule) await writeFile(join(dir, 'environment.json'), JSON.stringify(schedule, null, 1) + '\n', { mode: 0o600 });
  const run = await runTool(compiler.bin, renderArgs(r, animation, { candidate, out: 'render', environment: schedule ? 'environment.json' : null }), { cwd: dir });
  let json: unknown = null, fps: number | null = null;
  if (run.exitCode === 0) {
    try {
      const frames = JSON.parse(await readFile(join(dir, 'render', 'frames.json'), 'utf8')) as { sets?: { dir: string; animation: string | null; fps: number }[] };
      const set = frames.sets?.find(s => s.animation === animation);
      if (set) {
        fps = set.fps;
        const file = READING_FILE[r.kind];
        if (file) { json = JSON.parse(await readFile(join(dir, 'render', set.dir, file), 'utf8')); await copyFile(join(dir, 'render', set.dir, file), join(dir, file)); }
      }
      await copyFile(join(dir, 'render', 'frames.json'), join(dir, 'frames.json'));
    } catch { /* readingResult says what it could not read */ }
  }
  const result = readingResult(r, run, json, fps);
  // The frames and plates are rigc's pictures of the reading, not its result; the JSON is kept.
  await rm(join(dir, 'render'), { recursive: true, force: true });
  await writeFile(resultFile, JSON.stringify({ key, result }, null, 1) + '\n', { mode: 0o600 });
  return result;
}

export function createReadings(p: ReviewPackage, options: ReadingsOptions) {
  const jobs = new Map<string, ReadingsJob>(), help = new Map<string, boolean>();
  let running: string | null = null;
  const snapshot = (job: ReadingsJob): ReadingsJob => JSON.parse(JSON.stringify(job)) as ReadingsJob;
  function assertStateOutside(): void {
    for (const root of [p.root, ...(p.handoff ? [p.handoff.root] : [])]) {
      const inside = relative(root, options.stateDir);
      if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside)) throw new ReadingsError('READINGS_STATE_INSIDE_PACKAGE', 'the review state directory is inside the inspected package; set RIG_REVIEW_STATE_DIR outside it');
    }
  }
  /** Whether this rigc's `render --help` lists `--environment`, asked once per compiler. */
  async function environmentFlag(compiler: InstalledTool): Promise<boolean> {
    const key = `${compiler.bin}@${compiler.version}`;
    if (!help.has(key)) { await mkdir(options.stateDir, { recursive: true, mode: 0o700 }); const run = await runTool(compiler.bin, ['render', '--help'], { cwd: options.stateDir }); help.set(key, helpHasEnvironment(run.lines)); }
    return help.get(key)!;
  }

  async function execute(job: ReadingsJob, compiler: InstalledTool, builds: { build: ReadingBuild; key: string; candidate: string }[], schedule: unknown): Promise<void> {
    try {
      for (const [i, b] of builds.entries()) {
        const run = job.runs[i]!;
        for (const r of job.request.readings) {
          const key = readingKey(r, job.request.animation, schedule, `${compiler.package}@${compiler.version}`, run.modelHash);
          run.results.push(await runReading(r, job.request.animation, b.candidate, join(readingsRoot(options.stateDir, p.sourceHash), b.key, key), key, compiler, schedule));
        }
      }
      try { await options.unchanged(); } catch { throw new ReadingsError('READINGS_INPUTS_CHANGED', 'the package changed while the readings ran'); }
      job.status = 'done';
    } catch (error) { job.status = 'failed'; job.error = error instanceof Error ? error.message : String(error); }
  }

  /** Refusals come before anything is run; a refusal of the compiler's is an outcome (200), a malformed request a 400. */
  async function start(input: unknown): Promise<{ status: number; body: unknown }> {
    const request = parseReadingsRequest(input);
    assertStateOutside();
    await options.unchanged();
    if (!p.manifest.model) throw new ReadingsError('READINGS_NO_MODEL', 'the package names no compiled model; readings run on a compiled build');
    const resolved = resolveCompiler(options.starts, READINGS_SINCE);
    if (!resolved.ok) return { status: 200, body: { status: 'refused', error: resolved.error } };
    const compiler = resolved.compiler;
    const modelPath = await safeFile(p.root, p.manifest.model), modelHash = sha256(await readFile(modelPath));
    const latest = options.latest();
    const flag = await environmentFlag(compiler), passed = !!request.environment && flag, schedule = passed ? environmentSchedule(request.environment!) : null;
    const id = sha256(JSON.stringify([READINGS_SCHEMA, p.sourceHash, request, modelHash, latest?.id ?? null, `${compiler.package}@${compiler.version}`, passed]));
    const current = jobs.get(id);
    if (current && current.status !== 'failed') return { status: current.status === 'running' ? 202 : 200, body: snapshot(current) };
    if (running) return { status: 200, body: { status: 'refused', error: `READINGS_BUSY: readings ${running} are still running` } };
    const builds: { build: ReadingBuild; key: string; candidate: string }[] = [{ build: 'inspected', key: `inspected-${modelHash}`, candidate: dirname(modelPath) }];
    if (latest && await exists(join(latest.build, 'skeleton.json'))) builds.push({ build: 'scratch', key: `scratch-${latest.id}`, candidate: latest.build });
    const job: ReadingsJob = {
      schema: READINGS_SCHEMA, id, status: 'running', error: null, request,
      environment: { requested: !!request.environment, flag, passed },
      compiler: { package: compiler.package, version: compiler.version },
      runs: builds.map(b => ({ build: b.build, id: b.build === 'inspected' ? modelHash : latest!.id, modelHash: b.build === 'inspected' ? modelHash : latest!.modelHash, results: [] })),
    };
    jobs.set(id, job); running = id;
    void execute(job, compiler, builds, schedule).finally(() => { if (running === id) running = null; });
    return { status: 202, body: snapshot(job) };
  }
  function read(id: string): ReadingsJob {
    const job = jobs.get(id);
    if (!job) throw new ReadingsError('READINGS_NOT_FOUND', id);
    return snapshot(job);
  }
  return { start, read, running: () => running };
}
