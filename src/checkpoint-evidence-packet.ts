import type {CheckpointEvidencePacketResult, JobCheckpointEvidence} from './job-contract.ts';
import {JobError, jobId, jobPath, jobSha} from './job-validation.ts';

const evidenceSchema = 'rig-review-checkpoint-evidence/1';

export function evidenceText(value: unknown, max: number): string {
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

export function checkpointEvidencePair(packet: JobCheckpointEvidence) {
  if (!isRecord(packet)) throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_INVALID');
  if (!Object.hasOwn(packet, 'pair')) return undefined;
  const parsed = parseCheckpointEvidencePacket(packet);
  if (!parsed.ok) throw new JobError('JOB_SOURCE_MISMATCH', parsed.member === 'pair' ? 'CHECKPOINT_EVIDENCE_PAIR_INVALID' : 'CHECKPOINT_EVIDENCE_INVALID');
  if (!parsed.packet.pair) throw new JobError('JOB_SOURCE_MISMATCH', 'CHECKPOINT_EVIDENCE_PAIR_INVALID');
  const {tiles, pair} = parsed.packet;
  const tile = (side: 'before' | 'after') => tiles.find(item => item.id === pair[side].id && item.sha256 === pair[side].sha256)!;
  return {before: tile('before'), after: tile('after')};
}
