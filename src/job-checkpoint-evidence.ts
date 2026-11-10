import {realpathSync} from 'node:fs';
import type {JobCheckpointEvidence, JobCheckpointTable, JobFileIdentity, JobPlanIdentity, JobSubject, RecordSubject} from './job-contract.ts';
import {exactObject, jobHash, jobId, jobPath, jobSha} from './job-api.ts';
import {JobError} from './job-store.ts';
import {checkedPath, readRegular} from './interview-project.ts';
import {validatePngBytes} from './comment-crops.ts';

const evidenceSchema = 'rig-review-checkpoint-evidence/1';
const tableSchema = 'rig-review-checkpoint-table/1';

function evidenceText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) {
    throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_TEXT_INVALID');
  }
  return value;
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
      const item = exactObject(value, ['schema', 'checkpointId', 'planStepId', 'tiles', 'table', 'routesText', 'recommendationText'], 'JOB_SOURCE_MISMATCH');
      const checkpointId = jobId(item.checkpointId), planStepId = jobId(item.planStepId);
      if (item.schema !== evidenceSchema || seen.has(checkpointId) || !plan.steps.some(step => step.id === planStepId) ||
          !subjects.some(subject => subject.kind === 'checkpoint' && subject.checkpointId === checkpointId &&
            (('planStepId' in subject ? subject.planStepId : undefined) ?? subject.checkpointId) === planStepId)) throw new Error('association');
      seen.add(checkpointId);
      if (!Array.isArray(item.tiles) || item.tiles.length < 1 || item.tiles.length > 8) throw new Error('tiles');
      const ids = new Set<string>();
      const tiles = item.tiles.map(value => {
        const tile = exactObject(value, ['id', 'label', 'path', 'sha256'], 'JOB_SOURCE_MISMATCH');
        const id = jobId(tile.id);
        if (ids.has(id)) throw new Error('duplicate tile');
        ids.add(id);
        return {id, label: evidenceText(tile.label, 512), path: jobPath(tile.path), sha256: jobSha(tile.sha256)};
      });
      const rawTable = exactObject(item.table, ['path', 'sha256'], 'JOB_SOURCE_MISMATCH', ['label']);
      const table = {path: jobPath(rawTable.path), sha256: jobSha(rawTable.sha256),
        ...('label' in rawTable ? {label: evidenceText(rawTable.label, 512)} : {})};
      for (const file of [...tiles, table]) {
        if (!files.some(seal => seal.path === file.path && seal.sha256 === file.sha256)) throw new Error('closure');
      }
      return {schema: evidenceSchema, checkpointId, planStepId, tiles, table,
        routesText: evidenceText(item.routesText, 4096), recommendationText: evidenceText(item.recommendationText, 4096)};
    });
    if (Buffer.byteLength(JSON.stringify(checkpointEvidence)) > 32 * 1024) throw new Error('declaration bound');
    return {checkpointEvidence};
  } catch {
    throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_INVALID');
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
export function readCheckpointEvidenceBytes(root: string, file: JobFileIdentity, limit: number): Buffer {
  let bytes: Buffer;
  try {
    if (realpathSync(root) !== root) throw new Error('Noncanonical evidence root');
    bytes = readRegular(checkedPath(root, file.path), limit);
  }
  catch { throw new JobError('JOB_SOURCE_UNRETAINABLE', 'CHECKPOINT_EVIDENCE_PATH_REFUSED'); }
  if (jobHash(bytes) !== file.sha256) throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_HASH_MISMATCH');
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
