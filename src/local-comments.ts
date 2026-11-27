import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertSubmittedComments } from './comment-crops.ts';
import { commentsObject, jobHash, jobSha, parseCommentOnlyValue } from './job-api.ts';
import { JobError } from './job-validation.ts';
import type { JobCommentOnlyAct, JobContextComment } from './job-contract.ts';
import { packagePath, string, type ReviewPackage, type ReviewedSource } from './manifest.ts';
import { commentPartsIssues } from './parts-comment.ts';
import { validateStoredPartsComment } from './parts-comment-crops.ts';
import { assertPartsUnchanged, assertVerdictDestination, verdictSource, type PartsViewMode, type PartsViewPackage } from './parts-view.ts';
import { parseCommentsReviewedSource, sessionFile, validatePackageFeedback, type Feedback } from './session.ts';
import { hasStageComment, parseStageComment } from './stage-comment.ts';
import { assertStateOutside, canonicalStatePath } from './state-dir.ts';

export const LOCAL_COMMENTS_SCHEMA = 'rig-review/local-comments@1' as const;
export const LOCAL_COMMENTS_ROUTE = '/api/local-comments';
export const PACKAGE_COMMENTS_BODY_LIMIT = 1024 * 1024;

type LocalCommentSource =
  | { kind: 'package'; id: string; revision: string; sourceHash: string; reviewedSource: ReviewedSource }
  | { kind: 'parts'; mode: PartsViewMode; sourceHash: string };
type CommentValue = JobCommentOnlyAct['value'];
interface LocalCommentSend {
  sendId: string;
  source: LocalCommentSource;
  at: string;
  by?: string;
  value: CommentValue;
}
interface LocalCommentsFile { schema: typeof LOCAL_COMMENTS_SCHEMA; sends: LocalCommentSend[] }
type CommentReceipt = Pick<LocalCommentSend, 'sendId' | 'at'>;
export interface LocalCommentsExport {
  schema: typeof LOCAL_COMMENTS_SCHEMA;
  path: string;
  earlierPaths?: string[];
  sends: (LocalCommentSend & { earlierSource?: true })[];
}

const fileInvalid = (cause?: unknown) => new Error('LOCAL_COMMENTS_FILE_INVALID', {cause});
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const isSendId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const packageSource = (p: ReviewPackage): Extract<LocalCommentSource, {kind: 'package'}> =>
  ({kind: 'package', id: p.manifest.id, revision: p.manifest.revision, sourceHash: p.sourceHash, reviewedSource: p.reviewedSource});
const partsSource = (p: PartsViewPackage): LocalCommentSource =>
  ({kind: 'parts', mode: p.mode, sourceHash: verdictSource(p).sha256});
const packageFile = (source: ReturnType<typeof packageSource>, stateDir?: string) =>
  sessionFile({...source, manifest: source}, stateDir).replace(/\.json$/, '.comments.json');
const partsFile = (p: PartsViewPackage) => join(dirname(p.verdictPath), 'review-comments.json');

function parseSource(raw: unknown): LocalCommentSource {
  const value = raw as Partial<LocalCommentSource> | null;
  if (value?.kind === 'package') {
    const source = commentsObject(raw, ['kind', 'id', 'revision', 'sourceHash', 'reviewedSource']);
    const id = string(source.id, 'id'), revision = string(source.revision, 'revision');
    const reviewedSource = parseCommentsReviewedSource(source.reviewedSource);
    if (revision !== reviewedSource.packageRevision) throw fileInvalid();
    for (const file of [reviewedSource.rig, reviewedSource.motion]) if (file) packagePath(file.path);
    return {kind: 'package', id, revision, sourceHash: jobSha(source.sourceHash), reviewedSource};
  }
  const source = commentsObject(raw, ['kind', 'mode', 'sourceHash']);
  if (source.kind !== 'parts' || (source.mode !== 'parts' && source.mode !== 'atlas')) throw fileInvalid();
  return {kind: 'parts', mode: source.mode, sourceHash: jobSha(source.sourceHash)};
}

function parseValue(raw: unknown, source: LocalCommentSource): CommentValue {
  const model = source.kind === 'package' ? source.reviewedSource.rig : null;
  const value = parseCommentOnlyValue(raw, source.sourceHash, model);
  for (const {anchor} of value.comments) {
    if (!anchor) continue;
    if (source.kind === 'parts' ? !('schema' in anchor) : !('frameStart' in anchor)) throw new JobError('JOB_ACT_INVALID');
    if ('frameStart' in anchor) {
      const mark = (anchor.context as {comment?: unknown} | undefined)?.comment;
      if (hasStageComment(mark)) {
        const stage = parseStageComment(mark);
        if (stage.modelHash !== (stage.viewport === 'reference' ? null : model?.sha256 ?? null)) throw new JobError('JOB_ACT_SOURCE_STALE');
      }
    }
  }
  return value;
}

function rememberAnchoredComments(seen: Set<string>, comments: readonly JobContextComment[]): void {
  for (const {anchor} of comments) {
    if (!anchor || !('id' in anchor)) continue;
    if (seen.has(anchor.id)) throw new Error('COMMENT_SUBMITTED');
    seen.add(anchor.id);
  }
}

function packageFeedback(value: CommentValue): Feedback[] {
  return value.comments.flatMap(({text, anchor}) => anchor && 'frameStart' in anchor ? [{...anchor, summary: text}] : []);
}

function parseFile(raw: unknown, current: LocalCommentSource): {sends: LocalCommentSend[]; seen: Set<string>} {
  try {
    const file = commentsObject(raw, ['schema', 'sends']);
    if (file.schema !== LOCAL_COMMENTS_SCHEMA || !Array.isArray(file.sends)) throw fileInvalid();
    const ids = new Set<string>(), seen = new Set<string>();
    const sends = file.sends.map(rawSend => {
      const row = commentsObject(rawSend, ['sendId', 'at', 'source', 'value'], current.kind === 'parts' ? ['by'] : []);
      const {sendId, at, by} = row;
      if (!isSendId(sendId) || ids.has(sendId) || typeof at !== 'string' || new Date(at).toISOString() !== at ||
          ('by' in row && (typeof by !== 'string' || !by.trim()))) throw fileInvalid();
      const source = parseSource(row.source);
      if (source.kind !== current.kind || (source.kind === 'package' && current.kind === 'package' && source.id !== current.id)) throw fileInvalid();
      const value = parseValue(row.value, source);
      ids.add(sendId);
      rememberAnchoredComments(seen, value.comments);
      // Keep all already-validated original rows, including optional-field ordering, when appending.
      return rawSend as LocalCommentSend;
    });
    return {sends, seen};
  } catch (error) { throw fileInvalid(error); }
}

async function readLocalRecord(path: string): Promise<{raw: unknown; bytes: Buffer} | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw fileInvalid();
      const bytes = await handle.readFile();
      return {raw: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), bytes};
    } finally { await handle.close(); }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw fileInvalid(error);
  }
}

async function readLocalJson(path: string): Promise<unknown> {
  return (await readLocalRecord(path))?.raw;
}

function replayReceipt(row: LocalCommentSend, source: LocalCommentSource, sourceHash: string, rawValue: unknown, by?: string): CommentReceipt {
  if (sourceHash !== source.sourceHash || !isDeepStrictEqual(row.source, source) || row.by !== by)
    throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
  let value: CommentValue;
  try { value = parseValue(rawValue, source); }
  catch { throw new JobError('JOB_IDEMPOTENCY_CONFLICT'); }
  if (!isDeepStrictEqual(row.value, value)) throw new JobError('JOB_IDEMPOTENCY_CONFLICT');
  return {sendId: row.sendId, at: row.at};
}

async function appendComments(options: {
  file: string; source: LocalCommentSource; raw: unknown; by?: string;
  assertDestination: () => void | Promise<void>;
  assertCurrent: () => Promise<void>; validate: (value: CommentValue) => Promise<void>;
}): Promise<CommentReceipt> {
  const {file, source, by, assertDestination, assertCurrent, validate} = options;
  const request = commentsObject(options.raw, ['sendId', 'sourceHash', 'value']);
  const {sendId} = request, sourceHash = jobSha(request.sourceHash);
  if (!isSendId(sendId)) throw new JobError('JOB_ACT_INVALID');
  await assertDestination();
  const folder = canonicalStatePath(dirname(file)), path = join(folder, basename(file));
  // Readers see complete, atomic snapshots. A committed retry need not acquire a write claim.
  const snapshot = await readLocalJson(path) as Partial<LocalCommentsFile> | undefined;
  if (Array.isArray(snapshot?.sends) && snapshot.sends.some(row => row?.sendId === sendId)) {
    const replay = parseFile(snapshot, source).sends.find(row => row.sendId === sendId)!;
    return replayReceipt(replay, source, sourceHash, request.value, by);
  }
  await mkdir(folder, {recursive: true, mode: 0o700});
  const nonce = randomUUID();
  const {acquireClaim, releaseClaim} = await import('./open.ts');
  // Package revisions have different filenames but share the sendId namespace.
  const claimName = source.kind === 'package' ? 'package-comments-' + jobHash(source.id) : basename(file);
  const claimed = await acquireClaim(folder, claimName, nonce, async () => null, performance.now() + 10_000, 'LOCAL_COMMENTS_BUSY');
  if (!('claim' in claimed)) throw new Error('LOCAL_COMMENTS_BUSY');
  const temp = path + '.' + nonce + '.tmp';
  try {
    const previous = await readLocalJson(path);
    const {sends, seen} = previous === undefined ? {sends: [], seen: new Set<string>()} : parseFile(previous, source);
    let replay = sends.find(row => row.sendId === sendId);
    if (!replay && source.kind === 'package') {
      for await (const entry of packageCommentHistory(path, source, sendId)) {
        replay = entry.sends.find(row => row.sendId === sendId);
        if (replay) break;
      }
    }
    if (replay) return replayReceipt(replay, source, sourceHash, request.value, by);
    if (sourceHash !== source.sourceHash) throw new JobError('JOB_ACT_SOURCE_STALE');
    await assertCurrent();
    const value = parseValue(request.value, source);
    if (source.kind === 'package') {
      const incoming = packageFeedback(value), ids = new Set(incoming.map(row => row.id));
      const pinned = sends.flatMap(row => packageFeedback(row.value)).filter(row => ids.has(row.id));
      assertSubmittedComments(pinned, incoming);
    }
    rememberAnchoredComments(seen, value.comments);
    await validate(value);
    const at = new Date().toISOString();
    const record: LocalCommentsFile = {schema: LOCAL_COMMENTS_SCHEMA, sends: [...sends, {sendId, source, at, ...(by === undefined ? {} : {by}), value}]};
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await assertDestination();
    await assertCurrent();
    await rename(temp, path);
    return {sendId, at};
  } finally {
    try { await rm(temp, {force: true}); }
    finally { await releaseClaim(claimed.claim, nonce); }
  }
}

export function savePackageComments(p: ReviewPackage, raw: unknown, stateDir: string | undefined, unchanged: () => Promise<void>,
  validateFeedback: (feedback: Feedback) => Promise<void>) {
  const source = packageSource(p), file = packageFile(source, stateDir);
  return appendComments({file, source, raw, assertDestination: () => {
    assertStateOutside(dirname(file), p, message => new Error('LOCAL_COMMENTS_STATE_INVALID: ' + message));
  }, assertCurrent: unchanged, validate: async value => {
    for (const row of packageFeedback(value)) await validateFeedback(validatePackageFeedback(row, p));
  }});
}

export function savePartsComments(p: PartsViewPackage, raw: unknown, by?: string) {
  if (by !== undefined && !by.trim()) throw new JobError('JOB_ACT_INVALID');
  const file = partsFile(p), source = partsSource(p);
  return appendComments({file, source, raw, by, assertDestination: async () => {
    if (file === p.verdictPath) throw new Error('LOCAL_COMMENTS_FILE_INVALID');
    await assertVerdictDestination(p, file);
  }, assertCurrent: () => assertPartsUnchanged(p), validate: async value => {
    for (const issue of commentPartsIssues(value.comments)) await validateStoredPartsComment(p, issue);
  }});
}

function exportedSends(sends: LocalCommentSend[], source: LocalCommentSource): LocalCommentsExport['sends'] {
  return sends.map(send => isDeepStrictEqual(send.source, source) ? send : {...send, earlierSource: true});
}

export async function readPartsComments(p: PartsViewPackage): Promise<LocalCommentsExport | undefined> {
  const path = resolve(partsFile(p)), source = partsSource(p);
  if (path === resolve(p.verdictPath)) return undefined;
  await assertVerdictDestination(p, path);
  const raw = await readLocalJson(path);
  if (raw !== undefined) return {schema: LOCAL_COMMENTS_SCHEMA, path, sends: exportedSends(parseFile(raw, source).sends, source)};
}

/** Find verified earlier keys for the same package. A replay lookup parses only files containing that sendId. */
async function* packageCommentHistory(path: string, source: ReturnType<typeof packageSource>, sendId?: string) {
  const folder = dirname(path);
  const names = await readdir(folder).catch(error => { if (isMissing(error)) return []; throw error; });
  for (const name of names.sort()) {
    if (name === basename(path) || !/^[a-f0-9]{64}\.comments\.json$/.test(name)) continue;
    const other = join(folder, name);
    // A malformed foreign key has no trustworthy package identity.
    const record = await readLocalRecord(other).catch(() => undefined);
    if (!record) continue;
    const candidate = record.raw as Partial<LocalCommentsFile> | undefined;
    if (!Array.isArray(candidate?.sends) || !candidate.sends.some(row => row?.source?.kind === 'package' &&
        row.source.id === source.id && (sendId === undefined || row.sendId === sendId))) continue;
    const {sends} = parseFile(candidate, source);
    if (!sends.some(row => row.source.kind === 'package' && basename(packageFile(row.source)) === name)) throw fileInvalid();
    yield {path: other, sends, bytes: record.bytes};
  }
}

export async function readPackageComments(p: ReviewPackage, stateDir?: string): Promise<LocalCommentsExport | undefined> {
  const source = packageSource(p), path = resolve(packageFile(source, stateDir));
  const raw = await readLocalJson(path);
  const current = raw === undefined ? [] : parseFile(raw, source).sends;
  const earlierPaths: string[] = [], earlier: LocalCommentSend[] = [];
  for await (const entry of packageCommentHistory(path, source)) {
    earlier.push(...entry.sends);
    earlierPaths.push(entry.path);
  }
  if (raw === undefined && !earlier.length) return undefined;
  const sends = [...earlier, ...current].sort((a,b) => a.at.localeCompare(b.at));
  return {schema: LOCAL_COMMENTS_SCHEMA, path, ...(earlierPaths.length ? {earlierPaths} : {}), sends: exportedSends(sends, source)};
}

/** Resolve the original feedback anchor and byte snapshot for the existing correction projector. */
export async function readPackageCommentCorrection(p: ReviewPackage, stateDir: string, id: string) {
  const source = packageSource(p), path = resolve(packageFile(source, stateDir));
  let stale = false;
  const select = (sends: LocalCommentSend[], bytes: Buffer) => {
    for (const send of sends) {
      const feedback = packageFeedback(send.value).find(row => row.id === id);
      if (!feedback) continue;
      if (send.source.kind !== 'package' || !isDeepStrictEqual(send.source, source)) {
        stale = true;
        continue;
      }
      const {kind: _kind, ...binding} = send.source;
      return {session: {...binding, feedback: [validatePackageFeedback(feedback, p)]}, bytes};
    }
  };
  const record = await readLocalRecord(path);
  const current = record && select(parseFile(record.raw, source).sends, record.bytes);
  if (current) return current;
  for await (const entry of packageCommentHistory(path, source)) {
    const selected = select(entry.sends, entry.bytes);
    if (selected) return selected;
  }
  if (stale) throw new Error('CORRECTION_SOURCE_STALE: saved session differs from verified source');
}
