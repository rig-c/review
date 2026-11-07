import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type {
  JobFileIdentity, JobPartsIdentity, JobPlanIdentity, JobPublishRequest,
  JobSelector, JobSourceBinding, JobSubject,
} from './job-contract.ts';
import { checkedPath, readProject, readRegular, type InterviewQuestion } from './interview-project.ts';
import { loadReview } from './manifest.ts';
import { openKey } from './open.ts';
import { assertReviewUnchanged } from './reference.ts';
import { jobHash, jobId, jobPath, jobSha, requestDigest } from './job-api.ts';
import { JobError } from './job-store.ts';

export interface JobRootIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/** Trusted Create #184 adapter boundary. These are host return values, not new
 * project record keys or an agent API payload. Until the producer publishes its
 * actual read contract, no default adapter invents plan/parts bindings. Parts
 * referenced-image enumeration belongs to the public Parts #1163 surface.
 */
export interface JobPublishedContext {
  readonly selector: JobSelector | null;
  readonly plan: JobPlanIdentity | null;
  readonly parts: JobPartsIdentity | null;
  readonly subjects: readonly JobSubject[];
  readonly partIds: readonly string[];
  readonly files: readonly JobFileIdentity[];
}

export type JobPublicationReader = (input: {
  readonly root: string;
  readonly record: JobFileIdentity;
  readonly result: JobPublishRequest['result'];
}) => Promise<JobPublishedContext>;

export interface JobRetainedSource {
  readonly root: JobRootIdentity;
  readonly record: JobFileIdentity | null;
  readonly seals: readonly JobFileIdentity[];
  readonly snapshotRoot: string;
  readonly manifestPath: string;
  readonly source: JobSourceBinding;
  readonly instanceKey: string;
  readonly label: string;
  readonly visual: { readonly status: 'available' } | { readonly status: 'unavailable'; readonly code: string };
  readonly subjects: readonly JobSubject[];
  readonly questions: readonly InterviewQuestion[];
  readonly partIds: readonly string[];
}

const maxSourceBytes = 256 * 1024 * 1024;
const maxSourceFiles = 4096;
const maxFileBytes = 64 * 1024 * 1024;

export function captureJobRoot(path: string): JobRootIdentity {
  try {
    const canonical = realpathSync(path), info = lstatSync(path);
    if (!info.isDirectory()) throw new Error('Directory required');
    return { path: canonical, dev: info.dev, ino: info.ino };
  } catch { throw new JobError('JOB_ROOT_REPLACED'); }
}

export function assertJobRoot(root: JobRootIdentity): void {
  const now = captureJobRoot(root.path);
  if (now.path !== root.path || now.dev !== root.dev || now.ino !== root.ino) throw new JobError('JOB_ROOT_REPLACED');
}

function rootRelative(root: string, absolute: string): string {
  const path = relative(root, absolute).split(sep).join('/');
  if (isAbsolute(path) || !path || path === '..' || path.startsWith('../')) throw new JobError('JOB_SOURCE_UNRETAINABLE');
  return jobPath(path);
}

function sourceBytes(root: string, path: string): Buffer {
  const file = checkedPath(root, jobPath(path));
  const before = lstatSync(file), bytes = readRegular(file, maxFileBytes), after = lstatSync(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new JobError('JOB_SOURCE_MISMATCH');
  return bytes;
}

function assertRecord(root: JobRootIdentity, record: JobFileIdentity | null): void {
  assertJobRoot(root);
  if (record) {
    try {
      if (jobHash(sourceBytes(root.path, record.path)) !== record.sha256) throw new Error('Changed');
    } catch { throw new JobError('JOB_RECORD_MOVED'); }
  }
}

/** Synchronous final read is used inside local CAS. The producer must still hold
 * its external freeze. This does not lock an independent producer's filesystem.
 */
export function assertJobSourceCurrent(source: JobRetainedSource): void {
  assertRecord(source.root, source.record);
  for (const file of source.seals) {
    try {
      if (jobHash(sourceBytes(source.root.path, file.path)) !== file.sha256) throw new Error('Changed');
    } catch (error) {
      if (file.path === source.record?.path) throw new JobError('JOB_RECORD_MOVED');
      if (error instanceof JobError && error.code === 'JOB_ROOT_REPLACED') throw error;
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
  }
  assertRecord(source.root, source.record);
}

function publishedIdentities(context: JobPublishedContext): JobFileIdentity[] {
  const files = [...context.files];
  const ids = new Set<string>();
  for (const step of context.plan?.steps ?? []) {
    if (ids.has(jobId(step.id))) throw new JobError('JOB_SOURCE_MISMATCH');
    ids.add(step.id);
    jobSha(step.hash);
  }
  if (context.parts) {
    if (!/(^|\/)parts\.json$/.test(context.parts.manifest.path)) throw new JobError('JOB_SOURCE_MISMATCH');
    const painting = posix.join(posix.dirname(context.parts.manifest.path), 'painting_in_rig.png');
    if (context.parts.images.some(file =>
      !/(^|\/)parts\/[^/]+\.png$/.test(file.path) && file.path !== painting)) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    files.push(context.parts.manifest, ...context.parts.images);
    const paths = context.parts.images.map(file => file.path);
    if (new Set(paths).size !== paths.length || paths.some((path, i) => i > 0 && path < paths[i - 1])) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
  }
  for (const file of files) { jobPath(file.path); jobSha(file.sha256); }
  return files;
}

function collectQuestionFiles(root: string, questions: readonly InterviewQuestion[]): JobFileIdentity[] {
  const result: JobFileIdentity[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value === null || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.path === 'string' && typeof entry.sha256 === 'string') {
      result.push({ path: jobPath(entry.path), sha256: jobSha(entry.sha256) });
    }
    Object.values(entry).forEach(visit);
  }
  for (const question of questions) {
    result.push(question.ref, ...question.images.map(image => image.ref));
    visit(JSON.parse(sourceBytes(root, question.ref.path).toString('utf8')));
  }
  return result;
}

export async function prepareJobSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: JobPublishRequest;
  readonly readPublished?: JobPublicationReader;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedSource> {
  const { root, request } = options;
  assertJobRoot(root);
  const record = request.freeze.record;
  let project: ReturnType<typeof readProject> | null = null;
  try {
    let hasProject = false;
    try { lstatSync(join(root.path, 'project.json')); hasProject = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (hasProject && record?.path !== 'project.json') throw new JobError('JOB_FREEZE_REQUIRED');
    if (record) {
      const bytes = sourceBytes(root.path, record.path);
      if (jobHash(bytes) !== record.sha256) throw new JobError('JOB_RECORD_MOVED');
      try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new JobError('JOB_RECORD_INCOMPLETE'); }
      if (record.path === 'project.json') project = readProject(root.path);
    } else {
      try { lstatSync(join(root.path, 'project.json')); throw new JobError('JOB_FREEZE_REQUIRED'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_RECORD_INCOMPLETE');
  }
  const context: JobPublishedContext = options.readPublished && record ? await options.readPublished({
    root: root.path, record, result: request.result,
  }) : { selector: request.result.selector, plan: null, parts: null, subjects: [], partIds: [], files: [] };
  if (project && !options.readPublished) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE');
  }
  if (requestDigest(context.selector) !== requestDigest(request.result.selector)) throw new JobError('JOB_SOURCE_MISMATCH');
  const declared = publishedIdentities(context);
  let review: Awaited<ReturnType<typeof loadReview>>;
  try {
    const target = checkedPath(root.path, request.result.path, lstatSync(join(root.path, request.result.path)).isDirectory());
    review = await loadReview(target);
  } catch { throw new JobError('JOB_SOURCE_MISMATCH'); }
  const wanted = new Map<string, string | null>();
  function add(path: string, sha256: string | null = null): void {
    jobPath(path);
    const existing = wanted.get(path);
    if (existing && sha256 && existing !== sha256) throw new JobError('JOB_SOURCE_MISMATCH');
    wanted.set(path, sha256 ?? existing ?? null);
  }
  for (const path of review.files) add(rootRelative(root.path, resolve(review.root, path)));
  for (const file of review.handoff?.record.files ?? []) add(rootRelative(root.path, resolve(review.root, file.path)), file.sha256);
  if (review.handoff?.source && review.handoff.record.source) {
    add(rootRelative(root.path, review.handoff.source), review.handoff.record.source.sha256);
  }
  if (record) add(record.path, record.sha256);
  for (const file of [...declared, ...collectQuestionFiles(root.path, project?.questions ?? [])]) add(file.path, file.sha256);
  if (wanted.size > maxSourceFiles) throw new JobError('JOB_SOURCE_UNRETAINABLE');
  const snapshotRoot = join(options.stateRoot, 'snapshots', randomUUID());
  const seals: JobFileIdentity[] = [];
  try {
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    let size = 0;
    const directories = new Set([snapshotRoot, dirname(snapshotRoot), options.stateRoot]);
    for (const [path, expected] of [...wanted].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const bytes = sourceBytes(root.path, path), sha256 = jobHash(bytes);
      size += bytes.length;
      if (size > maxSourceBytes) throw new JobError('JOB_SOURCE_UNRETAINABLE');
      if (expected && sha256 !== expected) throw new JobError(path === record?.path ? 'JOB_RECORD_MOVED' : 'JOB_SOURCE_MISMATCH');
      const destination = join(snapshotRoot, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const file = await open(destination, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      let directory = dirname(destination);
      while (directory !== snapshotRoot) {
        directories.add(directory);
        directory = dirname(directory);
      }
      seals.push({ path, sha256 });
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      const handle = await open(directory, 'r');
      try { await handle.sync(); }
      finally { await handle.close(); }
      options.afterDirectorySync?.(directory);
    }
    await assertReviewUnchanged(review);
    const retained = await loadReview(join(snapshotRoot, request.result.path));
    if (retained.sourceHash !== review.sourceHash || requestDigest(retained.reviewedSource) !== requestDigest(review.reviewedSource)) {
      throw new JobError('JOB_SOURCE_UNRETAINABLE');
    }
    const originalIdentity = (file: { path: string; sha256: string } | null): JobFileIdentity | null => file && ({
      path: rootRelative(root.path, resolve(review.root, file.path)), sha256: file.sha256,
    });
    const source: JobSourceBinding = {
      sourceHash: project || context.plan || context.parts ? jobHash(JSON.stringify({
        schema: 'rig-review-job-source/1', packageSourceHash: review.sourceHash,
        record, selector: context.selector, plan: context.plan, parts: context.parts, files: seals,
      })) : review.sourceHash,
      projectHash: project?.hash ?? null,
      package: { id: review.manifest.id, revision: review.manifest.revision },
      selector: context.selector,
      model: originalIdentity(review.reviewedSource.rig),
      direction: originalIdentity(review.direction?.file ?? null),
      optionSet: null, appliedResult: null, plan: context.plan, parts: context.parts,
    };
    const boundReview = { ...review, sourceHash: source.sourceHash };
    const prepared: JobRetainedSource = {
      root, record, seals, snapshotRoot,
      manifestPath: retained.manifestPath,
      source,
      instanceKey: openKey({ mode: 'single', p: boundReview, inputs: { input: review.manifestPath },
        contentHash: source.sourceHash, selection: null }, options.fingerprint),
      label: review.manifest.title,
      visual: review.manifest.model || review.manifest.references.length ? { status: 'available' } :
        { status: 'unavailable', code: 'MODEL_UNAVAILABLE' },
      subjects: context.subjects,
      questions: project?.questions ?? [],
      partIds: context.partIds,
    };
    await options.afterSnapshot?.();
    assertJobSourceCurrent(prepared);
    return prepared;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
}
