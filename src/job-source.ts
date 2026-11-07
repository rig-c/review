import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import { JOB_PARTS_ENUMERATOR_RANGE } from './job-contract.ts';
import type {
  JobFileIdentity, JobPartsEnumerator, JobPartsFileReference, JobPartsIdentity, JobPlanIdentity, JobPublishRequest,
  JobSelector, JobSourceBinding, JobSubject,
} from './job-contract.ts';
import { checkedPath, readProject, readRegular, type InterviewQuestion } from './interview-project.ts';
import { loadReview } from './manifest.ts';
import { openKey } from './open.ts';
import { assertReviewUnchanged } from './reference.ts';
import { jobHash, jobId, jobPartsEnumeratorVersion, jobObject, jobPath, jobSha, jobText, requestDigest } from './job-api.ts';
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
  for (const file of files) { jobPath(file.path); jobSha(file.sha256); }
  return files;
}

function referenceRow(raw: unknown, row: number, hashed: boolean): JobPartsFileReference & { sha256?: string } {
  let item: Record<string, unknown>;
  let role: string;
  try {
    item = jobObject(raw, hashed ? ['path', 'role', 'sha256'] : ['path', 'role']);
    role = jobText(item.role, 128);
    if (hashed) jobSha(item.sha256);
  } catch { throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_SET_MISMATCH row=${row}`); }
  let path: string;
  try { path = jobPath(item.path); }
  catch { throw new JobError('JOB_SOURCE_UNRETAINABLE', `PARTS_REFERENCE_PATH_REFUSED row=${row}`); }
  return {path, role, ...(hashed ? {sha256: item.sha256 as string} : {})};
}

/** Membership, order and duplicate semantics belong solely to the trusted public
 * enumerator. Review compares its exact array and validates byte boundaries.
 */
async function prepareParts(root: string, snapshotRoot: string, claimed: JobPartsIdentity | null,
  enumerator?: JobPartsEnumerator): Promise<{identity: JobPartsIdentity | null; bytes: Map<string, Buffer>}> {
  const bytes = new Map<string, Buffer>();
  if (claimed === null) return {identity: null, bytes};
  if (!enumerator) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_ENUMERATOR_UNAVAILABLE');
  jobObject(claimed, ['enumeratorVersion', 'manifest', 'images']);
  const version = jobPartsEnumeratorVersion(claimed.enumeratorVersion);
  if (version !== jobPartsEnumeratorVersion(enumerator.version)) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE',
      `PARTS_ENUMERATOR_VERSION_MISMATCH range="${JOB_PARTS_ENUMERATOR_RANGE}" received="${version}" installed="${enumerator.version}"`);
  }
  let manifestPath: string;
  try {
    jobObject(claimed.manifest, ['path', 'sha256']);
    manifestPath = jobPath(claimed.manifest.path);
    if (posix.basename(manifestPath) !== 'parts.json') throw new Error('Manifest directory API');
    jobSha(claimed.manifest.sha256);
  } catch { throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_PATH_REFUSED manifest'); }
  if (!Array.isArray(claimed.images) || claimed.images.length > maxSourceFiles) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_LIMIT');
  }
  let manifestBytes: Buffer;
  try { manifestBytes = sourceBytes(root, manifestPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JobError('JOB_SOURCE_MISMATCH', 'PARTS_ENUMERATION_REFUSED rule=PARTS_FILE_PRESENT');
    }
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_PATH_REFUSED manifest');
  }
  if (jobHash(manifestBytes) !== claimed.manifest.sha256) {
    throw new JobError('JOB_SOURCE_MISMATCH', 'PARTS_REFERENCE_HASH_MISMATCH manifest');
  }
  bytes.set(manifestPath, manifestBytes);
  const enumerationRoot = join(snapshotRoot, 'enumeration-' + randomUUID());
  let references: readonly JobPartsFileReference[];
  try {
    await mkdir(enumerationRoot, {mode: 0o700});
    await writeFile(join(enumerationRoot, 'parts.json'), manifestBytes, {flag: 'wx', mode: 0o600});
    try { references = enumerator.enumerate(enumerationRoot); }
    catch (error) {
      const code = (error as {problems?: {code?: unknown}[]}).problems?.[0]?.code;
      const rule = typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/.test(code) ? ` rule=${code}` : '';
      throw new JobError('JOB_SOURCE_MISMATCH', 'PARTS_ENUMERATION_REFUSED' + rule);
    }
  } finally { await rm(enumerationRoot, {recursive: true, force: true}); }
  if (!Array.isArray(references) || references.length > maxSourceFiles) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_LIMIT');
  }
  const official = references.map((raw, row) => referenceRow(raw, row, false));
  const supplied = claimed.images.map((raw, row) => referenceRow(raw, row, true));
  const difference = official.findIndex((row, i) => row.path !== supplied[i]?.path || row.role !== supplied[i]?.role);
  if (difference !== -1 || official.length !== supplied.length) {
    throw new JobError('JOB_SOURCE_MISMATCH',
      `PARTS_REFERENCE_SET_MISMATCH row=${difference !== -1 ? difference : official.length}`);
  }
  let total = manifestBytes.length;
  const decoded = new Set<string>();
  const images: JobPartsIdentity['images'][number][] = [];
  for (const [row, reference] of official.entries()) {
    const detail = `row=${row} role=${reference.role} path=${JSON.stringify(reference.path)}`;
    const path = posix.join(posix.dirname(manifestPath), reference.path);
    let data = bytes.get(path);
    if (!data) {
      try {
        if (lstatSync(checkedPath(root, path)).size > maxFileBytes) {
          throw new JobError('JOB_SOURCE_UNRETAINABLE', `PARTS_REFERENCE_LIMIT ${detail}`);
        }
        data = sourceBytes(root, path);
      }
      catch (error) {
        if (error instanceof JobError && error.message.startsWith('PARTS_REFERENCE_LIMIT ')) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_MISSING ${detail}`);
        }
        throw new JobError('JOB_SOURCE_UNRETAINABLE', `PARTS_REFERENCE_PATH_REFUSED ${detail}`);
      }
      total += data.length;
      if (bytes.size >= maxSourceFiles || total > maxSourceBytes) {
        throw new JobError('JOB_SOURCE_UNRETAINABLE', `PARTS_REFERENCE_LIMIT ${detail}`);
      }
    }
    if (!decoded.has(path)) {
      if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') {
        throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_PNG_INVALID ${detail}`);
      }
      const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
      if (!width || !height) throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_PNG_INVALID ${detail}`);
      if (width > Math.floor(maxFileBytes / 4 / height)) {
        throw new JobError('JOB_SOURCE_UNRETAINABLE', `PARTS_REFERENCE_LIMIT ${detail}`);
      }
      try { PNG.sync.read(data); }
      catch { throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_PNG_INVALID ${detail}`); }
      bytes.set(path, data);
      decoded.add(path);
    }
    const sha256 = jobHash(data);
    if (sha256 !== supplied[row].sha256) {
      throw new JobError('JOB_SOURCE_MISMATCH', `PARTS_REFERENCE_HASH_MISMATCH ${detail}`);
    }
    images.push({path: reference.path, role: reference.role, sha256});
  }
  return {identity: {enumeratorVersion: version, manifest: {path: manifestPath, sha256: jobHash(manifestBytes)}, images}, bytes};
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
  readonly partsEnumerator?: JobPartsEnumerator;
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
    const parts = await prepareParts(root.path, snapshotRoot, context.parts, options.partsEnumerator);
    for (const [path, bytes] of parts.bytes) add(path, jobHash(bytes));
    if (wanted.size > maxSourceFiles) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PARTS_REFERENCE_LIMIT');
    let size = 0;
    const directories = new Set([snapshotRoot, dirname(snapshotRoot), options.stateRoot]);
    for (const [path, expected] of [...wanted].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      const bytes = parts.bytes.get(path) ?? sourceBytes(root.path, path), sha256 = jobHash(bytes);
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
        schema: 'rig-review-job-source/2', packageSourceHash: review.sourceHash,
        record, selector: context.selector, plan: context.plan, parts: parts.identity, files: seals,
      })) : review.sourceHash,
      projectHash: project?.hash ?? null,
      package: { id: review.manifest.id, revision: review.manifest.revision },
      selector: context.selector,
      model: originalIdentity(review.reviewedSource.rig),
      direction: originalIdentity(review.direction?.file ?? null),
      optionSet: null, appliedResult: null, plan: context.plan, parts: parts.identity,
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
      questions: (project?.questions ?? []).map(question => {
        const { answer, ...fields } = question;
        return answer === undefined ? fields : question;
      }),
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
