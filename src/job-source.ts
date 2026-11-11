import {checkpointEvidenceFields, checkpointEvidenceMetadata} from './job-checkpoint-evidence.ts';
import { randomUUID } from 'node:crypto';
import { type Dirent, lstatSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { PNG } from 'pngjs';
import {
  JOB_API_V3_SCHEMA, JOB_PLAN_TEXT_FIELDS, JOB_PLAN_TEXT_SCHEMA,
  JOB_PARTS_ENUMERATOR_RANGE,
} from './job-contract.ts';
import type {
  JobCheckpointEvidence, JobFileIdentity, JobImageSetInput, JobInterviewDiagnostics, JobInterviewRecord, JobModelSourceBinding, JobPartsEnumerator, JobPartsFileReference, JobPartsIdentity, JobPlanIdentity, JobPublishRequest,
  JobSelector, JobSourceBinding, JobSubject, JobPlanTextProjection, JobPlanTextStep,
  OptionContext, OptionSource, PackageResultV3, PlanContext, PlanSource, ProjectRecord, PublishRequestV3,
  RecordFreeze, RecordOptionResult, RecordPlanResult, RecordPublicationReader, RecordPublishedContext,
  RecordReaderInput, RecordResult, RecordSource, RecordSubject,
} from './job-contract.ts';
import { checkedPath, jsonObject, readProject, readRegular, type InterviewQuestion, type InterviewSet } from './interview-project.ts';
import { loadReview } from './manifest.ts';
import { openKey } from './open.ts';
import { assertReviewUnchanged } from './reference.ts';
import {
  assertEqualRecordContexts,
  assertJobApiSchema,
  buildRecordSource,
  isRecordSource,
  jobHash,
  jobId,
  jobObject,
  jobPartsEnumeratorVersion,
  jobPath,
  jobSha,
  jobText,
  parseJobInterviewDiagnostics,
  parseRecordFreeze,
  parseRecordPublishedContext,
  parseRecordResult,
  parseRecordSource,
  recordInstanceKey,
  requestDigest,
  stripPackageResultKind,
  validateRecordAskSubject,
} from './job-api.ts';
import { JobError, type JobSnapshotOwner } from './job-store.ts';
import { prepareJobImageSet } from './job-image-set.ts';

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
  readonly checkpointEvidence?: readonly JobCheckpointEvidence[];
  readonly imageSet?: JobImageSetInput;
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
  /** Private base preimage for evidence-aware durable validation, absent historically. */
  readonly checkpointEvidencePackageHash?: string;
  readonly root: JobRootIdentity;
  readonly record: JobFileIdentity | null;
  readonly seals: readonly JobFileIdentity[];
  readonly snapshotRoot: string;
  readonly snapshotIdentity?: { readonly dev: number; readonly ino: number };
  readonly manifestPath: string;
  readonly source: JobSourceBinding;
  readonly instanceKey: string;
  readonly label: string;
  readonly visual: { readonly status: 'available' } | { readonly status: 'unavailable'; readonly code: string };
  readonly subjects: readonly JobSubject[];
  readonly questions: readonly InterviewQuestion[];
  readonly interview?: JobInterviewDiagnostics | null;
  readonly partIds: readonly string[];
}

export interface JobRetainedRecordSource {
  readonly kind: 'record';
  readonly root: JobRootIdentity;
  readonly record: ProjectRecord;
  readonly result: RecordResult;
  readonly seals: readonly JobFileIdentity[];
  readonly snapshotRoot: string;
  readonly snapshotIdentity?: { readonly dev: number; readonly ino: number };
  readonly manifestPath: null;
  readonly source: RecordSource;
  readonly instanceKey: string;
  readonly label: string;
  readonly visual: { readonly status: 'unavailable'; readonly code: 'MODEL_UNAVAILABLE' };
  readonly subjects: readonly RecordSubject[];
  readonly questions: readonly InterviewQuestion[];
  readonly interview?: undefined;
  readonly partIds: readonly [];
  readonly context: RecordPublishedContext;
}

export type JobRetainedSourceV3 = JobRetainedSource | JobRetainedRecordSource;

export function isRetainedRecordSource(retained: JobRetainedSourceV3): retained is JobRetainedRecordSource {
  return 'kind' in retained && retained.kind === 'record';
}

const maxSourceBytes = 256 * 1024 * 1024;
const maxSourceFiles = 4096;
const maxFileBytes = 64 * 1024 * 1024;
const maxProjectBytes = 8 * 1024 * 1024;

/** Private preservation identity. Keep the supplied seal order and fixed keys. */
export function jobSnapshotHash(seals: readonly JobFileIdentity[]): string {
  return jobHash(JSON.stringify(seals.map(({path, sha256}) => ({path, sha256}))));
}

export async function removeOwnedJobSnapshot(stateRoot: string,
  snapshot: Pick<JobSnapshotOwner, 'snapshotRoot' | 'dev' | 'ino'>): Promise<void> {
  const parent = join(stateRoot, 'snapshots'), path = snapshot.snapshotRoot;
  if (dirname(path) !== parent || !/^[a-f0-9-]{36}$/.test(posix.basename(path))) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership path differs');
  }
  let info: Stats;
  try { info = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.dev !== snapshot.dev || info.ino !== snapshot.ino || (info.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership differs');
  }
  if (realpathSync(parent) !== parent) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership differs');
  try {
    if (realpathSync(path) !== path) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership differs');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling replacement still exists and must refuse. Only absence drains.
    try { lstatSync(path); }
    catch (missing) {if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return; throw missing;}
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'Snapshot ownership differs');
  }
  await rm(path, {recursive: true, force: true});
}

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
export function assertJobSourceCurrent(
  source: Pick<JobRetainedSourceV3, 'root' | 'record' | 'seals'>,
): void {
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

function collectQuestionFiles(
  root: string,
  questions: readonly InterviewQuestion[],
  records: readonly JobInterviewRecord[] = [],
): { readonly required: JobFileIdentity[]; readonly optional: JobFileIdentity[] } {
  const required: JobFileIdentity[] = [];
  const optional: JobFileIdentity[] = [];
  function visit(value: unknown, isOptional: boolean): void {
    if (Array.isArray(value)) { value.forEach(item => visit(item, isOptional)); return; }
    if (value === null || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.path === 'string' && typeof entry.sha256 === 'string') {
      if (!isOptional) {
        required.push({ path: jobPath(entry.path), sha256: jobSha(entry.sha256) });
      } else {
        try {
          const path = jobPath(entry.path);
          const sha256 = jobSha(entry.sha256);
          if (jobHash(sourceBytes(root, path)) === sha256) {
            optional.push({ path, sha256 });
          }
        } catch {
          // Historical non-editable context file is missing or changed; its stale diagnostic is already recorded.
        }
      }
    }
    Object.values(entry).forEach(item => visit(item, isOptional));
  }
  for (const question of questions) {
    required.push(question.ref, ...question.images.map(image => image.ref));
    visit(JSON.parse(sourceBytes(root, question.ref.path).toString('utf8')), !question.editable);
  }
  for (const row of records) {
    if (row.observedSet) {
      try {
        const path = jobPath(row.observedSet.path);
        const sha256 = jobSha(row.observedSet.sha256);
        if (jobHash(sourceBytes(root, path)) === sha256) {
          optional.push({ path, sha256 });
        }
      } catch {
        // Unreadable or non-retained option set stays unsealed.
      }
    }
  }
  return { required, optional };
}

function isOptionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

function isNonEmptyTrimmedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validateOptionSetStructure(
  raw: Record<string, unknown>,
  questionId: string,
  setId: string,
  allowedStages: readonly string[],
): InterviewSet {
  const assembly = asPlainObject(raw.assembly);
  const rule = assembly?.rule;
  const asksRaw = Array.isArray(raw.asks) ? raw.asks : null;
  if (
    raw.schema !== 'rig-create/interview-options@1' ||
    !isOptionIdentifier(raw.id) ||
    raw.id !== setId ||
    !isOptionIdentifier(questionId) ||
    raw.question !== questionId ||
    !allowedStages.includes(String(raw.stage)) ||
    !isNonEmptyTrimmedText(raw.drafted_by) ||
    typeof raw.drafted_at !== 'string' ||
    !Number.isFinite(Date.parse(raw.drafted_at)) ||
    !asksRaw ||
    asksRaw.length === 0 ||
    !['single', 'concat', 'merge'].includes(String(rule)) ||
    (rule === 'single' && asksRaw.length !== 1)
  ) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const asks: Record<string, unknown>[] = [];
  const askIds = new Set<string>();
  for (const entry of asksRaw) {
    const ask = asPlainObject(entry);
    if (!ask || !isOptionIdentifier(ask.id) || askIds.has(ask.id) || !isNonEmptyTrimmedText(ask.prompt)) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    askIds.add(ask.id);
    if (!Array.isArray(ask.options)) throw new JobError('JOB_SOURCE_MISMATCH');
    const options: Record<string, unknown>[] = [];
    const optionIds = new Set<string>();
    for (const optEntry of ask.options) {
      const option = asPlainObject(optEntry);
      if (
        !option ||
        !isOptionIdentifier(option.id) ||
        optionIds.has(option.id) ||
        !isNonEmptyTrimmedText(option.label) ||
        !isNonEmptyTrimmedText(option.effect) ||
        typeof option.recommended !== 'boolean' ||
        !['value', 'other', 'auto'].includes(String(option.kind)) ||
        (option.recommended && (option.kind !== 'value' || !isNonEmptyTrimmedText(option.reason))) ||
        (option.kind === 'value'
          ? !('fragment' in option) ||
            (rule === 'concat' && !Array.isArray(option.fragment)) ||
            (rule === 'merge' && asPlainObject(option.fragment) === null)
          : 'fragment' in option)
      ) {
        throw new JobError('JOB_SOURCE_MISMATCH');
      }
      optionIds.add(option.id);
      options.push(option);
    }
    if (
      options.filter(option => option.kind === 'value').length < 2 ||
      options.filter(option => option.kind === 'other').length !== 1 ||
      options.filter(option => option.kind === 'auto').length !== 1 ||
      options.filter(option => option.recommended === true).length !== 1
    ) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    asks.push(ask);
  }
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints)) throw new JobError('JOB_SOURCE_MISMATCH');
    for (const entry of raw.constraints) {
      const constraint = asPlainObject(entry);
      const names = constraint?.asks;
      const allowed = constraint?.allowed;
      if (
        !constraint ||
        !Array.isArray(names) ||
        names.length === 0 ||
        new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !askIds.has(name)) ||
        !Array.isArray(allowed) ||
        allowed.length === 0
      ) {
        throw new JobError('JOB_SOURCE_MISMATCH');
      }
      for (const tuple of allowed) {
        if (!Array.isArray(tuple) || tuple.length !== names.length) {
          throw new JobError('JOB_SOURCE_MISMATCH');
        }
        for (let i = 0; i < names.length; i++) {
          const targetAsk = asks.find(ask => ask.id === names[i]);
          const targetOptions = Array.isArray(targetAsk?.options) ? targetAsk.options as Record<string, unknown>[] : [];
          if (!targetOptions.some(option => option.id === tuple[i] && option.kind === 'value')) {
            throw new JobError('JOB_SOURCE_MISMATCH');
          }
        }
      }
    }
  }
  return raw as unknown as InterviewSet;
}

export function assertRetainedSnapshotIntact(
  snapshotRoot: string,
  seals: readonly JobFileIdentity[],
  snapshotIdentity?: { readonly dev: number; readonly ino: number },
  refusalCode: 'JOB_SOURCE_UNRETAINABLE' | 'JOB_ACT_SOURCE_STALE' = 'JOB_SOURCE_UNRETAINABLE',
): void {
  let rootInfo: Stats;
  try {
    rootInfo = lstatSync(snapshotRoot);
    if (!rootInfo.isDirectory() || realpathSync(snapshotRoot) !== snapshotRoot || (rootInfo.mode & 0o077) !== 0) {
      throw new Error('Invalid snapshot directory');
    }
    if (snapshotIdentity && (rootInfo.dev !== snapshotIdentity.dev || rootInfo.ino !== snapshotIdentity.ino)) {
      throw new Error('Snapshot directory identity changed');
    }
  } catch {
    throw new JobError(refusalCode);
  }
  const expectedFiles = new Map<string, string>();
  const expectedDirs = new Set<string>(['']);
  for (const seal of seals) {
    let normalizedPath: string;
    let normalizedSha: string;
    try {
      normalizedPath = jobPath(seal.path);
      normalizedSha = jobSha(seal.sha256);
    } catch {
      throw new JobError(refusalCode);
    }
    if (expectedFiles.has(normalizedPath)) throw new JobError(refusalCode);
    expectedFiles.set(normalizedPath, normalizedSha);
    let dir = posix.dirname(normalizedPath);
    while (dir !== '.' && dir !== '') {
      expectedDirs.add(dir);
      dir = posix.dirname(dir);
    }
  }
  const visitedFiles = new Set<string>();
  const visitDir = (relDir: string): void => {
    const absDir = relDir ? join(snapshotRoot, relDir) : snapshotRoot;
    let entries: Dirent[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      throw new JobError(refusalCode);
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = join(absDir, entry.name);
      let stat: Stats;
      try {
        stat = lstatSync(abs);
      } catch {
        throw new JobError(refusalCode);
      }
      if (stat.isSymbolicLink()) throw new JobError(refusalCode);
      if (stat.isDirectory()) {
        if (!expectedDirs.has(rel)) throw new JobError(refusalCode);
        visitDir(rel);
      } else if (stat.isFile()) {
        const expectedSha = expectedFiles.get(rel);
        if (!expectedSha || visitedFiles.has(rel)) throw new JobError(refusalCode);
        let bytes: Buffer;
        try {
          bytes = sourceBytes(snapshotRoot, rel);
        } catch {
          throw new JobError(refusalCode);
        }
        if (jobHash(bytes) !== expectedSha) throw new JobError(refusalCode);
        visitedFiles.add(rel);
      } else {
        throw new JobError(refusalCode);
      }
    }
  };
  visitDir('');
  if (visitedFiles.size !== expectedFiles.size) throw new JobError(refusalCode);
}

function extractReaderToken(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { readonly code?: unknown; readonly message?: unknown };
  for (const raw of [candidate.code, candidate.message]) {
    if (typeof raw !== 'string') continue;
    if (
      raw === 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE' ||
      raw === 'CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE' ||
      raw === 'JOB_RECORD_CLOSURE_INCOMPLETE' ||
      raw === 'JOB_RECORD_PARTS_MISMATCH' ||
      raw === 'JOB_RECORD_PARTS_LOCK_MISSING'
    ) {
      return raw;
    }
  }
  return null;
}

function mapRecordReaderError(error: unknown, phase: 'publish' | 'ask' | 'finalize'): JobError {
  const token = extractReaderToken(error);
  if (
    token === 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE' ||
    token === 'CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE'
  ) {
    return new JobError('JOB_SOURCE_UNRETAINABLE', token);
  }
  const refusalCode = phase === 'finalize' ? 'JOB_ACT_SOURCE_STALE' : 'JOB_RECORD_INCOMPLETE';
  if (
    token === 'JOB_RECORD_CLOSURE_INCOMPLETE' ||
    token === 'JOB_RECORD_PARTS_MISMATCH' ||
    token === 'JOB_RECORD_PARTS_LOCK_MISSING'
  ) {
    return new JobError(refusalCode, token);
  }
  return new JobError(refusalCode);
}

async function readRecordPublishedPhase(
  readRecordPublished: RecordPublicationReader,
  input: RecordReaderInput,
  phase: 'publish' | 'ask' | 'finalize',
  assertCurrentBeforeGenericRefusal?: () => void,
): Promise<RecordPublishedContext> {
  let raw: unknown;
  try {
    raw = input.result.kind === 'option-set'
      ? await readRecordPublished({
          root: input.root,
          record: input.record,
          result: input.result,
          phase: input.phase,
          ...(input.parts !== undefined ? { parts: input.parts } : {}),
        })
      : await readRecordPublished({
          root: input.root,
          record: input.record,
          result: input.result,
          phase: input.phase,
          ...(input.parts !== undefined ? { parts: input.parts } : {}),
        });
  } catch (error) {
    if (extractReaderToken(error) === null) {
      assertCurrentBeforeGenericRefusal?.();
    }
    throw mapRecordReaderError(error, phase);
  }
  return parseRecordPublishedContext(raw, input.result, input.record);
}

function readProjectRecordBytes(root: string, record: ProjectRecord, allowLegacySchema = false): {
  readonly bytes: Buffer;
  readonly project: Record<string, unknown>;
} {
  let stat: Stats;
  try {
    stat = lstatSync(join(root, record.path));
  } catch {
    throw new JobError(allowLegacySchema ? 'JOB_SOURCE_UNRETAINABLE' : 'JOB_RECORD_MOVED');
  }
  if (!stat.isFile()) throw new JobError(allowLegacySchema ? 'JOB_SOURCE_UNRETAINABLE' : 'JOB_RECORD_MOVED');
  if (stat.size > maxProjectBytes) throw new JobError('JOB_SOURCE_UNRETAINABLE');
  let bytes: Buffer;
  try {
    bytes = sourceBytes(root, record.path);
  } catch {
    throw new JobError(allowLegacySchema ? 'JOB_SOURCE_UNRETAINABLE' : 'JOB_RECORD_MOVED');
  }
  if (jobHash(bytes) !== record.sha256) throw new JobError('JOB_RECORD_MOVED');
  let project: Record<string, unknown>;
  try {
    project = jsonObject(bytes);
  } catch {
    throw new JobError('JOB_RECORD_INCOMPLETE');
  }
  if (!allowLegacySchema && project.schema !== 'rig-create/project@0') throw new JobError('JOB_RECORD_INCOMPLETE');
  return { bytes, project };
}

function readClosureFileBytes(root: string, file: JobFileIdentity): Buffer {
  if (file.path === 'project.json') {
    return readProjectRecordBytes(root, file as ProjectRecord).bytes;
  }
  let target: string;
  try {
    target = checkedPath(root, file.path);
  } catch {
    throw new JobError('JOB_SOURCE_UNRETAINABLE');
  }
  let stat: Stats;
  try {
    stat = lstatSync(target);
  } catch {
    throw new JobError('JOB_SOURCE_UNRETAINABLE');
  }
  if (!stat.isFile() || stat.size > maxFileBytes) throw new JobError('JOB_SOURCE_UNRETAINABLE');
  let bytes: Buffer;
  try {
    bytes = sourceBytes(root, file.path);
  } catch (error) {
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_SOURCE_UNRETAINABLE');
  }
  if (jobHash(bytes) !== file.sha256) throw new JobError('JOB_SOURCE_MISMATCH');
  return bytes;
}

/** Delivery-only projection through the existing retained record reader. */
export function projectRetainedPlanText(retained: JobRetainedSourceV3): JobPlanTextProjection | undefined {
  const {source, record} = retained;
  const plan = source.plan;
  if (!plan) return undefined;
  let identity: {path: 'project.json'; sha256: string} | null = null;
  const unavailable = (reason: Extract<JobPlanTextProjection, {status:'unavailable'}>['reason']): JobPlanTextProjection =>
    ({schema:JOB_PLAN_TEXT_SCHEMA, record:identity, status:'unavailable', reason});
  if (!record || !source.projectHash) return unavailable('PLAN_TEXT_RECORD_UNAVAILABLE');
  if (record.path !== 'project.json') return unavailable('PLAN_TEXT_RECORD_UNSUPPORTED');
  const seals = retained.seals.filter(file => file.path === record.path);
  if (record.sha256 !== source.projectHash || seals.length !== 1 || seals[0]!.sha256 !== record.sha256 ||
      isRetainedRecordSource(retained) && (!retained.source.files.some(file => file.path === record.path && file.sha256 === record.sha256) ||
        retained.source.record.path !== record.path || retained.source.record.sha256 !== record.sha256)) {
    throw new JobError('JOB_SOURCE_MISMATCH', 'PLAN_TEXT_RECORD_MISMATCH');
  }
  identity = {path:'project.json', sha256:record.sha256};
  let project: Record<string, unknown>;
  try {project = readProjectRecordBytes(retained.snapshotRoot, identity, true).project;}
  catch (error) {
    if (error instanceof JobError && error.code === 'JOB_RECORD_MOVED')
      throw new JobError('JOB_SOURCE_MISMATCH', 'PLAN_TEXT_RECORD_HASH_MISMATCH');
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PLAN_TEXT_RECORD_UNAVAILABLE');
  }
  if (project.schema !== 'rig-create/project@0') return unavailable('PLAN_TEXT_RECORD_UNSUPPORTED');
  if (!Object.hasOwn(project, 'plan')) return unavailable('PLAN_TEXT_STEPS_ABSENT');
  const rawPlan = asPlainObject(project.plan);
  if (!rawPlan) return unavailable('PLAN_TEXT_STEPS_INVALID');
  if (!Object.hasOwn(rawPlan, 'steps')) return unavailable('PLAN_TEXT_STEPS_ABSENT');
  const rawSteps = rawPlan.steps;
  if (!Array.isArray(rawSteps)) return unavailable('PLAN_TEXT_STEPS_INVALID');
  if (plan.steps.length > 4096) return unavailable('PLAN_TEXT_LIMIT');
  if (isRetainedRecordSource(retained) && (rawSteps.length !== plan.steps.length ||
      rawSteps.some((raw, index) => asPlainObject(raw)?.id !== plan.steps[index]?.id)))
    return unavailable('PLAN_TEXT_MAPPING_UNAVAILABLE');
  const wanted = new Set(plan.steps.map(step => step.id));
  const matched = new Map<string, Record<string, unknown> | null>();
  for (const raw of rawSteps) {
    const step = asPlainObject(raw);
    if (typeof step?.id === 'string' && wanted.has(step.id))
      matched.set(step.id, matched.has(step.id) ? null : step);
  }
  if (plan.steps.some(step => !matched.get(step.id))) return unavailable('PLAN_TEXT_MAPPING_UNAVAILABLE');
  const steps = plan.steps.map<JobPlanTextStep>(step => {
    const raw = matched.get(step.id)!;
    const fields: Omit<JobPlanTextStep, 'id' | 'hash' | 'issues'> = {};
    const issues: JobPlanTextStep['issues'] = [];
    for (const field of JOB_PLAN_TEXT_FIELDS) {
      const value = raw[field];
      if (!Object.hasOwn(raw, field)) issues.push({field, reason:'absent'});
      else if (field === 'rests_on') {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) issues.push({field, reason:'invalid'});
        else if (value.length > 4096) issues.push({field, reason:'limit'});
        else fields.rests_on = value;
      } else if (typeof value === 'string') fields[field] = value;
      else issues.push({field, reason:'invalid'});
    }
    return {id:step.id, hash:step.hash, ...fields, issues};
  });
  const projection: JobPlanTextProjection = {schema:JOB_PLAN_TEXT_SCHEMA, record:identity, status:'projected', steps};
  return Buffer.byteLength(JSON.stringify(projection)) > 512 * 1024 ? unavailable('PLAN_TEXT_LIMIT') : projection;
}

/** Keep the normal owner metadata budget, including the small fallback itself. */
export function planTextMetadata(retained: JobRetainedSourceV3, metadata: Record<string, unknown>): Record<string, unknown> {
  const projection = projectRetainedPlanText(retained);
  if (!projection) return metadata;
  let result = {...metadata, planText:projection};
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) {
    result = {...metadata, planText:{schema:JOB_PLAN_TEXT_SCHEMA, record:projection.record,
      status:'unavailable', reason:'PLAN_TEXT_LIMIT'}};
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
      throw new JobError('JOB_BODY_LIMIT', 'PLAN_TEXT_LIMIT');
  }
  return result;
}

function decodeRetainedRecordProject(
  snapshotRoot: string,
  seals: readonly JobFileIdentity[],
  result: RecordResult,
  context: RecordPublishedContext,
): {
  readonly questions: readonly InterviewQuestion[];
  readonly optionSetFile: JobFileIdentity | null;
} {
  const sealMap = new Map<string, string>();
  for (const seal of seals) {
    sealMap.set(seal.path, seal.sha256);
  }
  const recordSha = sealMap.get('project.json');
  if (!recordSha) throw new JobError('JOB_SOURCE_MISMATCH');
  const { project } = readProjectRecordBytes(snapshotRoot, { path: 'project.json', sha256: recordSha });

  if (result.kind === 'option-set') {
    if (context.plan !== null) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    const { questionId, setId } = result;
    const interview = asPlainObject(project.interview);
    if (!interview) throw new JobError('JOB_SOURCE_MISMATCH');
    const collections = [
      [interview.framing, ['interview']],
      [interview.waypoints, ['interview', 'rigging-interview']],
      [asPlainObject(interview.post)?.items, ['post-interview']],
    ] as const;
    const matches: { readonly pending: unknown; readonly allowedStages: readonly string[] }[] = [];
    for (const [items, allowedStages] of collections) {
      if (items !== undefined && !Array.isArray(items)) throw new JobError('JOB_SOURCE_MISMATCH');
      for (const rawItem of Array.isArray(items) ? items : []) {
        const item = asPlainObject(rawItem);
        if (!item) throw new JobError('JOB_SOURCE_MISMATCH');
        if (item.id === questionId) {
          matches.push({ pending: item.pending_options, allowedStages });
        }
      }
    }
    if (matches.length !== 1 || matches[0]!.pending === undefined) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    let ref: JobFileIdentity;
    try {
      const pendingObj = jobObject(matches[0]!.pending, ['path', 'sha256']);
      ref = { path: jobPath(pendingObj.path), sha256: jobSha(pendingObj.sha256) };
    } catch {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    if (
      ref.path === 'project.json' ||
      ['derived', 'outputs', 'scratch', 'node_modules', '.git'].includes(ref.path.split('/')[0]!) ||
      sealMap.get(ref.path) !== ref.sha256
    ) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    let optionBytes: Buffer;
    let rawSet: Record<string, unknown>;
    try {
      optionBytes = sourceBytes(snapshotRoot, ref.path);
      if (jobHash(optionBytes) !== ref.sha256) throw new Error('Option set hash mismatch');
      rawSet = jsonObject(optionBytes);
    } catch {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
    const set = validateOptionSetStructure(rawSet, questionId, setId, matches[0]!.allowedStages);
    const images: InterviewQuestion['images'] = [];
    const ctx = asPlainObject(rawSet.context);
    if (ctx && Array.isArray(ctx.files)) {
      for (const rawFile of ctx.files) {
        const fileObj = asPlainObject(rawFile);
        if (!fileObj || typeof fileObj.path !== 'string' || typeof fileObj.sha256 !== 'string') {
          throw new JobError('JOB_SOURCE_MISMATCH');
        }
        const filePath = jobPath(fileObj.path);
        const fileSha = jobSha(fileObj.sha256);
        if (sealMap.get(filePath) !== fileSha) throw new JobError('JOB_SOURCE_MISMATCH');
        const ext = posix.extname(filePath).toLowerCase();
        const mime = ({
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
        } as Record<string, string>)[ext];
        if (mime) {
          images.push({ ref: { path: filePath, sha256: fileSha }, name: posix.basename(filePath), type: mime });
        }
      }
    }
    return {
      questions: [{
        ref,
        set,
        editable: true,
        images,
        hasParts: false,
      }],
      optionSetFile: ref,
    };
  }

  if (context.plan === null) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const planObj = asPlainObject(project.plan);
  const rawSteps = planObj?.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length !== context.plan.steps.length) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  for (let i = 0; i < rawSteps.length; i++) {
    const stepObj = asPlainObject(rawSteps[i]);
    if (!stepObj || typeof stepObj.id !== 'string' || stepObj.id !== context.plan.steps[i]!.id) {
      throw new JobError('JOB_SOURCE_MISMATCH');
    }
  }
  return { questions: [], optionSetFile: null };
}

export async function prepareJobRecordSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: {
    readonly freeze: RecordFreeze;
    readonly result: RecordResult;
  };
  readonly readRecordPublished?: RecordPublicationReader;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedRecordSource> {
  const { root } = options;
  assertJobRoot(root);
  const freeze = parseRecordFreeze(options.request.freeze);
  const result = parseRecordResult(options.request.result);
  const record = freeze.record;
  readProjectRecordBytes(root.path, record);
  if (!options.readRecordPublished) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE');
  }
  const inventory = await readRecordPublishedPhase(
    options.readRecordPublished,
    { root: root.path, record, result, phase: 'inventory' },
    'publish',
    () => assertRecord(root, record),
  );
  assertRecord(root, record);
  if (inventory.files.length > maxSourceFiles) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE');
  }
  checkpointEvidenceMetadata(root.path, inventory.checkpointEvidence);
  const snapshotRoot = join(options.stateRoot, 'snapshots', randomUUID());
  const seals: JobFileIdentity[] = [];
  let snapshotIdentity: { dev: number; ino: number } | null = null;
  try {
    await mkdir(dirname(snapshotRoot), { recursive: true, mode: 0o700 });
    await mkdir(snapshotRoot, { mode: 0o700 });
    const info = lstatSync(snapshotRoot);
    snapshotIdentity = { dev: info.dev, ino: info.ino };
    let retainedBytes = 0;
    const directories = new Set([snapshotRoot, dirname(snapshotRoot), options.stateRoot]);
    for (const file of inventory.files) {
      const bytes = readClosureFileBytes(root.path, file);
      retainedBytes += bytes.length;
      if (retainedBytes > maxSourceBytes) throw new JobError('JOB_SOURCE_UNRETAINABLE');
      const destination = join(snapshotRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(destination, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let directory = dirname(destination);
      while (directory !== snapshotRoot) {
        directories.add(directory);
        directory = dirname(directory);
      }
      seals.push({ path: file.path, sha256: file.sha256 });
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      const handle = await open(directory, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      options.afterDirectorySync?.(directory);
    }
    assertJobSourceCurrent({ root, record, seals });
    assertRetainedSnapshotIntact(snapshotRoot, seals, snapshotIdentity, 'JOB_SOURCE_UNRETAINABLE');
    const retainedContext = await readRecordPublishedPhase(
      options.readRecordPublished,
      { root: snapshotRoot, record, result, phase: 'retained', parts: inventory.parts },
      'publish',
      () => assertJobSourceCurrent({ root, record, seals }),
    );
    assertJobSourceCurrent({ root, record, seals });
    assertRetainedSnapshotIntact(snapshotRoot, seals, snapshotIdentity, 'JOB_SOURCE_UNRETAINABLE');
    assertEqualRecordContexts(inventory, retainedContext);
    const decoded = decodeRetainedRecordProject(snapshotRoot, seals, result, retainedContext);
    checkpointEvidenceMetadata(snapshotRoot, retainedContext.checkpointEvidence);
    const source = parseRecordSource(
      result.kind === 'option-set'
        ? buildRecordSource({
            record,
            selection: result,
            context: retainedContext as OptionContext,
            optionSetFile: decoded.optionSetFile!,
          })
        : buildRecordSource({
            record,
            selection: result,
            context: retainedContext as PlanContext,
            optionSetFile: null,
          }),
    );
    const prepared: JobRetainedRecordSource = {
      kind: 'record',
      root,
      record,
      result,
      seals,
      snapshotRoot,
      snapshotIdentity,
      manifestPath: null,
      source,
      instanceKey: recordInstanceKey(options.fingerprint, source.sourceHash),
      label: retainedContext.label,
      visual: { status: 'unavailable', code: 'MODEL_UNAVAILABLE' },
      subjects: retainedContext.subjects,
      questions: decoded.questions,
      partIds: [],
      context: retainedContext,
    };
    await options.afterSnapshot?.();
    assertJobSourceCurrent(prepared);
    assertRetainedSnapshotIntact(snapshotRoot, seals, snapshotIdentity, 'JOB_SOURCE_UNRETAINABLE');
    return prepared;
  } catch (error) {
    if (snapshotIdentity) {
      await removeOwnedJobSnapshot(options.stateRoot, { snapshotRoot, ...snapshotIdentity });
    }
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
}

export async function verifyJobRecordSourceFresh(options: {
  readonly retained: JobRetainedRecordSource;
  readonly readRecordPublished?: RecordPublicationReader;
  readonly phase?: 'ask' | 'finalize';
  readonly subject?: RecordSubject;
}): Promise<RecordSource> {
  const { retained } = options;
  const phase = options.phase ?? 'ask';
  assertJobSourceCurrent(retained);
  assertRetainedSnapshotIntact(
    retained.snapshotRoot,
    retained.seals,
    retained.snapshotIdentity,
    'JOB_SOURCE_UNRETAINABLE',
  );
  if (!options.readRecordPublished) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE');
  }
  const inventory = await readRecordPublishedPhase(
    options.readRecordPublished,
    { root: retained.root.path, record: retained.record, result: retained.result, phase: 'inventory' },
    phase,
    () => assertJobSourceCurrent(retained),
  );
  assertJobSourceCurrent(retained);
  if (requestDigest(inventory.parts) !== requestDigest(retained.context.parts)) {
    throw new JobError(phase === 'finalize' ? 'JOB_ACT_SOURCE_STALE' : 'JOB_SOURCE_MISMATCH');
  }
  assertRetainedSnapshotIntact(
    retained.snapshotRoot,
    retained.seals,
    retained.snapshotIdentity,
    'JOB_SOURCE_UNRETAINABLE',
  );
  const retainedContext = await readRecordPublishedPhase(
    options.readRecordPublished,
    {
      root: retained.snapshotRoot,
      record: retained.record,
      result: retained.result,
      phase: 'retained',
      parts: retained.context.parts,
    },
    phase,
    () => assertJobSourceCurrent(retained),
  );
  assertJobSourceCurrent(retained);
  assertRetainedSnapshotIntact(
    retained.snapshotRoot,
    retained.seals,
    retained.snapshotIdentity,
    'JOB_SOURCE_UNRETAINABLE',
  );
  try {
    assertEqualRecordContexts(inventory, retainedContext);
  } catch (error) {
    if (phase === 'finalize') throw new JobError('JOB_ACT_SOURCE_STALE');
    throw error;
  }
  const decoded = decodeRetainedRecordProject(retained.snapshotRoot, retained.seals, retained.result, retainedContext);
  const freshSource = parseRecordSource(
    retained.result.kind === 'option-set'
      ? buildRecordSource({
          record: retained.record,
          selection: retained.result,
          context: retainedContext as OptionContext,
          optionSetFile: decoded.optionSetFile!,
        })
      : buildRecordSource({
          record: retained.record,
          selection: retained.result,
          context: retainedContext as PlanContext,
          optionSetFile: null,
        }),
  );
  if (
    freshSource.sourceHash !== retained.source.sourceHash ||
    requestDigest(freshSource) !== requestDigest(retained.source) ||
    requestDigest(retainedContext.subjects) !== requestDigest(retained.subjects) ||
    requestDigest(retainedContext.parts) !== requestDigest(retained.context.parts) ||
    retainedContext.label !== retained.context.label
  ) {
    throw new JobError(phase === 'finalize' ? 'JOB_ACT_SOURCE_STALE' : 'JOB_SOURCE_MISMATCH');
  }
  if (options.subject !== undefined) {
    try {
      validateRecordAskSubject(options.subject, freshSource);
    } catch (error) {
      if (phase === 'finalize') throw new JobError('JOB_ACT_SOURCE_STALE');
      throw error;
    }
  }
  assertJobSourceCurrent(retained);
  return freshSource;
}

/** Preserve the existing composite preimage, conditionally appending the declaration. */
function packageSourceDigest(packageSourceHash: string, record: JobFileIdentity | null,
  source: Pick<JobModelSourceBinding, 'selector' | 'plan' | 'parts'>, files: readonly JobFileIdentity[],
  evidence: {readonly checkpointEvidence?: readonly JobCheckpointEvidence[]}): string {
  return jobHash(JSON.stringify({schema: 'rig-review-job-source/2', packageSourceHash, record,
    selector: source.selector, plan: source.plan, parts: source.parts, files, ...evidence}));
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
}): Promise<JobRetainedSource>;
export async function prepareJobSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: PublishRequestV3 & { readonly result: RecordResult };
  readonly readRecordPublished?: RecordPublicationReader;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedRecordSource>;
export async function prepareJobSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: PublishRequestV3 & { readonly result: PackageResultV3 };
  readonly readPublished?: JobPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedSource>;
export async function prepareJobSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: JobPublishRequest | PublishRequestV3;
  readonly readPublished?: JobPublicationReader;
  readonly readRecordPublished?: RecordPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedSourceV3>;
export async function prepareJobSource(options: {
  readonly root: JobRootIdentity;
  readonly stateRoot: string;
  readonly fingerprint: string;
  readonly request: JobPublishRequest | PublishRequestV3;
  readonly readPublished?: JobPublicationReader;
  readonly readRecordPublished?: RecordPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}): Promise<JobRetainedSourceV3> {
  if ('kind' in options.request.result) {
    assertJobApiSchema(options.request.schema, JOB_API_V3_SCHEMA);
    if (options.request.result.kind !== 'package') {
      return prepareJobRecordSource({
        root: options.root,
        stateRoot: options.stateRoot,
        fingerprint: options.fingerprint,
        request: {
          freeze: parseRecordFreeze(options.request.freeze),
          result: options.request.result,
        },
        readRecordPublished: options.readRecordPublished,
        afterSnapshot: options.afterSnapshot,
        afterDirectorySync: options.afterDirectorySync,
      });
    }
    const strippedRequest: JobPublishRequest = {
      schema: 'rig-review/job-api@2',
      jobId: options.request.jobId,
      requestId: options.request.requestId,
      verb: 'publish',
      expectedGeneration: options.request.expectedGeneration,
      idempotencyKey: options.request.idempotencyKey,
      freeze: options.request.freeze,
      result: stripPackageResultKind(options.request.result),
    };
    return prepareJobSource({
      ...options,
      request: strippedRequest,
    });
  }
  const { root } = options;
  const request = options.request as JobPublishRequest;
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
      if (record.path === 'project.json') {
        project = readProject(root.path);
      }
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
  const evidence = checkpointEvidenceFields(context, context.plan, context.subjects, declared);
  if (evidence.checkpointEvidence && context.imageSet !== undefined) throw new JobError(
    'JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_INVALID');
  checkpointEvidenceMetadata(root.path, evidence.checkpointEvidence);
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
  const questionFiles = collectQuestionFiles(
    root.path,
    project?.questions ?? [],
    project?.interview.records ?? [],
  );
  for (const file of [...declared, ...questionFiles.required]) add(file.path, file.sha256);
  for (const file of questionFiles.optional) {
    if (!wanted.has(file.path)) add(file.path, file.sha256);
  }
  if (wanted.size > maxSourceFiles) throw new JobError('JOB_SOURCE_UNRETAINABLE');
  const snapshotRoot = join(options.stateRoot, 'snapshots', randomUUID());
  const seals: JobFileIdentity[] = [];
  let snapshotIdentity: {dev: number; ino: number} | null = null;
  try {
    await mkdir(dirname(snapshotRoot), {recursive: true, mode: 0o700});
    await mkdir(snapshotRoot, {mode: 0o700});
    const info = lstatSync(snapshotRoot);
    snapshotIdentity = {dev: info.dev, ino: info.ino};
    const imageSet = context.imageSet === undefined ? null : prepareJobImageSet(context.imageSet,
      path => sourceBytes(root.path, path));
    for (const image of imageSet?.imageSet.images ?? []) add(image.path, image.sha256);
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
    checkpointEvidenceMetadata(snapshotRoot, evidence.checkpointEvidence);
    const modelSource: Omit<JobModelSourceBinding, 'checkpointEvidence'> = {
      sourceHash: project || context.plan || context.parts ? packageSourceDigest(review.sourceHash, record,
        {selector: context.selector, plan: context.plan, parts: parts.identity}, seals, evidence) : review.sourceHash,
      projectHash: project?.hash ?? null,
      package: { id: review.manifest.id, revision: review.manifest.revision },
      selector: context.selector,
      model: originalIdentity(review.reviewedSource.rig),
      direction: originalIdentity(review.direction?.file ?? null),
      optionSet: null, appliedResult: null, plan: context.plan, parts: parts.identity,
    };
    let source: JobSourceBinding = {...modelSource, ...evidence};
    if (imageSet) {
      if (modelSource.model || modelSource.selector) throw new JobError('JOB_IMAGE_SET_INVALID');
      const {model, selector, ...common} = modelSource;
      source = {...common, subject: 'image-set', ...imageSet,
        sourceHash: jobHash(JSON.stringify({schema: 'rig-review-job-image-set/1',
          packageSourceHash: modelSource.sourceHash, record, imageSet: imageSet.imageSet}))};
    }
    const boundReview = { ...review, sourceHash: source.sourceHash };
    const sealedByPath = new Map(seals.map(seal => [seal.path, seal.sha256]));
    const retainedInterview = project
      ? parseJobInterviewDiagnostics(
          {
            ...project.interview,
            records: project.interview.records.map(row => ({
              ...row,
              observedSet:
                row.observedSet && sealedByPath.get(row.observedSet.path) === row.observedSet.sha256
                  ? row.observedSet
                  : null,
            })),
          },
          'JOB_RECORD_INCOMPLETE',
        ) ?? null
      : null;
    const prepared: JobRetainedSource = {
      root, record, seals, snapshotRoot, snapshotIdentity,
      ...(evidence.checkpointEvidence ? {checkpointEvidencePackageHash: review.sourceHash} : {}),
      manifestPath: retained.manifestPath,
      source,
      instanceKey: openKey({ mode: 'single', p: boundReview, inputs: { input: review.manifestPath },
        contentHash: source.sourceHash, selection: null }, options.fingerprint),
      label: review.manifest.title,
      visual: imageSet || review.manifest.model || review.manifest.references.length ? { status: 'available' } :
        { status: 'unavailable', code: 'MODEL_UNAVAILABLE' },
      subjects: context.subjects,
      questions: (project?.questions ?? []).map(question => {
        const { answer, partsUnavailable, ...fields } = question;
        return {
          ...fields,
          ...(partsUnavailable === undefined ? {} : { partsUnavailable }),
          ...(answer === undefined ? {} : { answer: JSON.parse(JSON.stringify(answer)) as Record<string, unknown> }),
        };
      }),
      interview: retainedInterview,
      partIds: context.partIds,
    };
    await options.afterSnapshot?.();
    assertJobSourceCurrent(prepared);
    if (source.checkpointEvidence) assertRetainedSnapshotIntact(snapshotRoot, seals, snapshotIdentity);
    return prepared;
  } catch (error) {
    if (snapshotIdentity) await removeOwnedJobSnapshot(options.stateRoot, {snapshotRoot, ...snapshotIdentity});
    if (error instanceof JobError) throw error;
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
}

/** Authenticate the optional extension without opening live files or reclaimed snapshots. */
export function assertStoredCheckpointEvidence(retained: JobRetainedSourceV3): void {
  if (!retained.source || typeof retained.source !== 'object' || Array.isArray(retained.source)) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
  const hasEvidence = 'checkpointEvidence' in retained.source;
  if (isRetainedRecordSource(retained)) {
    const parsed = parseRecordSource(retained.source);
    if (!hasEvidence && !('checkpointEvidence' in retained.context)) return;
    const context = parseRecordPublishedContext(retained.context, retained.result, retained.record);
    if (requestDigest(parsed.checkpointEvidence ?? null) !== requestDigest(context.checkpointEvidence ?? null) ||
        requestDigest(parsed.subjects) !== requestDigest(retained.subjects) ||
        requestDigest(parsed.files) !== requestDigest(retained.seals)) throw new JobError('JOB_SOURCE_MISMATCH');
    return;
  }
  if (!hasEvidence && !('checkpointEvidencePackageHash' in retained)) return;
  const source = retained.source;
  if (!hasEvidence || source.subject === 'image-set' || !retained.record) throw new JobError('JOB_SOURCE_MISMATCH');
  const evidence = checkpointEvidenceFields(source, source.plan, retained.subjects, retained.seals);
  const packageSourceHash = jobSha(retained.checkpointEvidencePackageHash);
  const expected = packageSourceDigest(packageSourceHash, retained.record, source, retained.seals, evidence);
  if (expected !== source.sourceHash || requestDigest(evidence.checkpointEvidence) !== requestDigest(source.checkpointEvidence)) {
    throw new JobError('JOB_SOURCE_MISMATCH');
  }
}
