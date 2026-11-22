import {lstatSync, realpathSync} from 'node:fs';
import type {JobCheckpointEvidence, JobCheckpointTable, JobFileIdentity, JobPlanIdentity, JobSubject, RecordSubject} from './job-contract.ts';
import {exactObject, jobHash, jobPath, jobSha} from './job-api.ts';
import {JobError} from './job-store.ts';
import {checkedPath, readRegular} from './interview-project.ts';
import {validatePngBytes} from './comment-crops.ts';
import {evidenceText, parseCheckpointEvidencePacket} from './checkpoint-evidence-packet.ts';

export type {CheckpointEvidencePacketResult} from './job-contract.ts';
export {parseCheckpointEvidencePacket} from './checkpoint-evidence-packet.ts';
const tableSchema = 'rig-review-checkpoint-table/1';

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
