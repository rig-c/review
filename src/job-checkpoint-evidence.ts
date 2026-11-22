import {lstatSync, realpathSync} from 'node:fs';
import type {CheckpointEvidencePacketResult, JobCheckpointEvidence, JobCheckpointTable, JobFileIdentity, JobPlanIdentity, JobSubject, RecordSubject} from './job-contract.ts';
import {exactObject, jobHash, jobId, jobPath, jobSha} from './job-api.ts';
import {JobError} from './job-store.ts';
import {checkedPath, readRegular} from './interview-project.ts';
import {validatePngBytes} from './comment-crops.ts';

export type {CheckpointEvidencePacketResult} from './job-contract.ts';

const evidenceSchema = 'rig-review-checkpoint-evidence/1';
const tableSchema = 'rig-review-checkpoint-table/1';

function evidenceText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_TEXT_INVALID');
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKeys = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> =>
  isRecord(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const check = (fn: () => unknown): boolean => {
  try { fn(); return true; } catch { return false; }
};

/** Pure single-packet validator shared by Review and Create (#716). Never throws. */
export function parseCheckpointEvidencePacket(value: unknown): CheckpointEvidencePacketResult {
  if (!hasKeys(value, ['schema', 'checkpointId', 'planStepId', 'tiles', 'table', 'routesText', 'recommendationText'], ['pair'])) {
    return {ok: false, member: 'keys', reason: 'unexpected or missing declaration fields'};
  }
  if (value.schema !== evidenceSchema || !check(() => jobId(value.checkpointId)) || !check(() => jobId(value.planStepId))) {
    return {ok: false, member: 'keys', reason: 'schema, checkpointId and planStepId must be valid'};
  }
  if (!Array.isArray(value.tiles) || value.tiles.length < 1 || value.tiles.length > 8) {
    return {ok: false, member: 'tiles', reason: 'expected 1–8 ordered tiles'};
  }
  const ids = new Set<string>();
  const tiles: {id: string; label: string; path: string; sha256: string}[] = [];
  for (const [index, rawTile] of value.tiles.entries()) {
    if (!hasKeys(rawTile, ['id', 'label', 'path', 'sha256'])) {
      return {ok: false, member: 'tiles', index, reason: 'unexpected or missing declaration fields'};
    }
    if (!check(() => jobId(rawTile.id)) || ids.has(rawTile.id as string) || !check(() => evidenceText(rawTile.label, 512))) {
      return {ok: false, member: 'tiles', index, reason: 'tile IDs must be unique and labels must be bounded nonempty text'};
    }
    if (!check(() => jobPath(rawTile.path)) || !check(() => jobSha(rawTile.sha256))) {
      return {ok: false, member: 'tiles', index, reason: 'a file needs its literal portable project-relative path and lowercase SHA-256'};
    }
    ids.add(rawTile.id as string);
    tiles.push({id: rawTile.id as string, label: rawTile.label as string, path: rawTile.path as string, sha256: rawTile.sha256 as string});
  }
  const rawTable = value.table;
  if (!hasKeys(rawTable, ['path', 'sha256'], ['label'])) {
    return {ok: false, member: 'table', reason: 'unexpected or missing declaration fields'};
  }
  if (Object.hasOwn(rawTable, 'label') && !check(() => evidenceText(rawTable.label, 512))) {
    return {ok: false, member: 'table', reason: 'table label must be bounded nonempty text'};
  }
  if (!check(() => jobPath(rawTable.path)) || !check(() => jobSha(rawTable.sha256))) {
    return {ok: false, member: 'table', reason: 'a file needs its literal portable project-relative path and lowercase SHA-256'};
  }
  if (!check(() => evidenceText(value.routesText, 4096)) || !check(() => evidenceText(value.recommendationText, 4096))) {
    return {ok: false, member: 'text', reason: 'routes and recommendation must be bounded nonempty text'};
  }
  const table = {
    path: rawTable.path as string,
    sha256: rawTable.sha256 as string,
    ...(Object.hasOwn(rawTable, 'label') ? {label: rawTable.label as string} : {}),
  };
  let pair: JobCheckpointEvidence['pair'];
  if (Object.hasOwn(value, 'pair')) {
    const rawPair = value.pair;
    if (!isRecord(rawPair) || Object.keys(rawPair).some(key => key !== 'before' && key !== 'after')) {
      return {ok: false, member: 'pair', reason: 'unexpected or missing pair fields'};
    }
    const sides = {} as {before: {id: string; sha256: string}; after: {id: string; sha256: string}};
    for (const side of ['before', 'after'] as const) {
      if (!Object.hasOwn(rawPair, side)) {
        return {ok: false, member: 'pair', side, reason: 'unexpected or missing pair fields'};
      }
      const rawSide = rawPair[side];
      if (!isRecord(rawSide) || Object.keys(rawSide).some(key => key !== 'id' && key !== 'sha256')) {
        return {ok: false, member: 'pair', side, reason: 'unexpected or missing pair side fields'};
      }
      if (!Object.hasOwn(rawSide, 'id') || !check(() => jobId(rawSide.id))) {
        return {ok: false, member: 'pair', side, reason: 'pair side requires a valid tile id'};
      }
      if (!Object.hasOwn(rawSide, 'sha256') || !check(() => jobSha(rawSide.sha256))) {
        return {ok: false, member: 'pair', side, reason: 'pair side requires a lowercase SHA-256'};
      }
      const tile = tiles.find(item => item.id === rawSide.id);
      if (!tile) {
        return {ok: false, member: 'pair', side, reason: 'pair side must name a tile in this packet'};
      }
      if (tile.sha256 !== rawSide.sha256) {
        return {ok: false, member: 'pair', side, reason: 'pair side sha256 must match the named tile'};
      }
      sides[side] = {id: rawSide.id as string, sha256: rawSide.sha256 as string};
    }
    if (sides.before.id === sides.after.id) {
      return {ok: false, member: 'pair', side: 'after', reason: 'before and after must name distinct tiles'};
    }
    pair = {before: sides.before, after: sides.after};
  }
  return {
    ok: true,
    packet: {
      schema: evidenceSchema,
      checkpointId: value.checkpointId as string,
      planStepId: value.planStepId as string,
      tiles,
      table,
      routesText: value.routesText as string,
      recommendationText: value.recommendationText as string,
      ...(pair ? {pair} : {}),
    },
  };
}

/** Canonical optional declaration. Absence must not materialize a historical field. */
export function checkpointEvidenceFields(holder: object, plan: JobPlanIdentity | null,
  subjects: readonly (JobSubject | RecordSubject)[], files: readonly JobFileIdentity[]): {checkpointEvidence?: readonly JobCheckpointEvidence[]} {
  if (!('checkpointEvidence' in holder)) return {};
  try {
    const raw = holder.checkpointEvidence;
    if (!plan || !Array.isArray(raw) || raw.length < 1 || raw.length > 8) throw new Error('collection');
    const seen = new Set<string>();
    const checkpointEvidence = raw.map<JobCheckpointEvidence>(value => {
      const parsed = parseCheckpointEvidencePacket(value);
      if (!parsed.ok) throw new Error(parsed.reason);
      const {packet} = parsed;
      const {checkpointId, planStepId, tiles, table} = packet;
      if (seen.has(checkpointId) || !plan.steps.some(step => step.id === planStepId) ||
          !subjects.some(subject => subject.kind === 'checkpoint' && subject.checkpointId === checkpointId &&
            (('planStepId' in subject ? subject.planStepId : undefined) ?? subject.checkpointId) === planStepId)) throw new Error('association');
      seen.add(checkpointId);
      for (const file of [...tiles, table]) {
        if (!files.some(seal => seal.path === file.path && seal.sha256 === file.sha256)) throw new Error('closure');
      }
      return packet;
    });
    if (Buffer.byteLength(JSON.stringify(checkpointEvidence)) > 32 * 1024) throw new Error('declaration bound');
    return {checkpointEvidence};
  } catch {
    throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_INVALID');
  }
}

/** #983: the plan-level picture the owner signs against. Plan records only; one sealed raster, by the
 * package page-image rule (png, jpg, webp). Absence must not materialize the field. */
export function planPictureFields(holder: object, plan: JobPlanIdentity | null,
  files: readonly JobFileIdentity[]): {planPicture?: JobFileIdentity} {
  if (!('planPicture' in holder)) return {};
  try {
    if (!plan) throw new Error('plan only');
    const raw = exactObject(holder.planPicture, ['path', 'sha256'], 'JOB_SOURCE_MISMATCH');
    const planPicture = {path: jobPath(raw.path), sha256: jobSha(raw.sha256)};
    if (!/\.(png|jpe?g|webp)$/i.test(planPicture.path) ||
        !files.some(seal => seal.path === planPicture.path && seal.sha256 === planPicture.sha256)) throw new Error('closure');
    return {planPicture};
  } catch {
    throw new JobError('JOB_SOURCE_MISMATCH', 'PLAN_PICTURE_INVALID');
  }
}

/** The sealed document is the sole table body. Preserve columns, rows and scalars. */
export function parseCheckpointTable(bytes: Buffer): JobCheckpointTable {
  try {
    if (bytes.length > 256 * 1024) throw new Error('byte bound');
    const item = exactObject(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)), ['schema', 'columns', 'rows'], 'JOB_SOURCE_MISMATCH');
    if (item.schema !== tableSchema || !Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 32 ||
        !Array.isArray(item.rows) || item.rows.length > 2048 || item.rows.length * item.columns.length > 16384) throw new Error('dimensions');
    const columns = item.columns.map(value => evidenceText(value, 512));
    const rows = item.rows.map(row => {
      if (!Array.isArray(row) || row.length !== columns.length) throw new Error('row width');
      return row.map(cell => {
        if (typeof cell === 'string') {
          if (cell.length > 2048 || /[\x00-\x08\x0b-\x1f\x7f]/.test(cell)) throw new Error('cell text');
        } else if (cell !== null && typeof cell !== 'boolean' && !(typeof cell === 'number' && Number.isFinite(cell))) {
          throw new Error('scalar');
        }
        return cell as string | number | boolean | null;
      });
    });
    return {schema: tableSchema, columns, rows};
  } catch {
    throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_TABLE_INVALID');
  }
}

/** Exact retained closure reads reuse regular-file, containment and descriptor bounds. */
export function readCheckpointEvidenceBytes(root: string, file: JobFileIdentity, limit: number,
  refuse: (failure: 'path' | 'limit' | 'hash') => JobError = failure => failure === 'hash'
    ? new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_HASH_MISMATCH')
    : new JobError('JOB_SOURCE_UNRETAINABLE', 'CHECKPOINT_EVIDENCE_PATH_REFUSED')): Buffer {
  let bytes: Buffer | undefined;
  try {
    if (realpathSync(root) !== root) throw new Error('Noncanonical evidence root');
    const path = checkedPath(root, jobPath(file.path));
    const before = lstatSync(path);
    if (!before.isFile()) throw new Error('Expected a regular evidence file');
    if (before.size <= limit) {
      bytes = readRegular(path, limit);
      const after = lstatSync(path);
      if (realpathSync(path) !== path || bytes.length !== before.size || before.dev !== after.dev ||
          before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs) throw new Error('Evidence file changed during read');
    }
  }
  catch { throw refuse('path'); }
  if (bytes === undefined) throw refuse('limit');
  if (jobHash(bytes) !== file.sha256) throw refuse('hash');
  return bytes;
}

/** Used before publication and metadata delivery. No table body enters durable state. */
export function checkpointEvidenceMetadata(root: string, evidence: readonly JobCheckpointEvidence[] | undefined) {
  if (evidence === undefined) return {};
  let tableBytes = 0;
  const checkpointEvidence = evidence.map(packet => {
    for (const tile of packet.tiles) {
      const bytes = readCheckpointEvidenceBytes(root, tile, 8 * 1024 * 1024);
      try { validatePngBytes(bytes, bytes.readUInt32BE(16), bytes.readUInt32BE(20)); }
      catch { throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_PNG_INVALID'); }
    }
    const bytes = readCheckpointEvidenceBytes(root, packet.table, 256 * 1024);
    tableBytes += bytes.length;
    if (tableBytes > 512 * 1024) throw new JobError('JOB_SOURCE_UNRETAINABLE', 'CHECKPOINT_EVIDENCE_TABLE_LIMIT');
    return {...packet, tiles: packet.tiles.map((tile, index) => ({...tile,
      url: `/api/checkpoint-evidence/${packet.checkpointId}/tiles/${index}`})),
      table: {...packet.table, url: `/api/checkpoint-evidence/${packet.checkpointId}/table`, ...parseCheckpointTable(bytes)}};
  });
  return {checkpointEvidence};
}
