/**
 * #172: what the Cuts and Cloth blocks mark as applied, derived from the stage's current applied record — the same
 * record the draft keeps and feedback carries as `context.applied`. After an undo that record is the predecessor's (or
 * none on the inspected build), so a reverted Apply's ops are never marked.
 *
 * The rule: a patch record (`rig-review-applied/2`) belongs to the Cloth block when its op is `cloth` (the server runs
 * a patch whose every op is under `/cloth` as `propose --cloth --write-config`) and to the Cuts block when its op is
 * `build` (a cut, patch, limb or joint edit is read by assemble, so it runs `rig-parts build`). Any other record — a
 * physics or bones `rig` patch, a remesh, a regions, delta or retarget record, or none — marks nothing in either block.
 * A pending op is applied when the block's applied ops hold an op with the same op, path, value and name.
 */
import {APPLIED_PATCH_SCHEMA} from './applied-context.ts';
import type {PatchOp} from './config-patch.ts';

export type AppliedBlock = 'cuts' | 'cloth';
export const APPLIED_BLOCKS: readonly AppliedBlock[] = ['cuts', 'cloth'];

/** The record op each block owns. */
const BLOCK_OP: Record<AppliedBlock, string> = { cuts: 'build', cloth: 'cloth' };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One op's identity for the applied mark: op, path, value and name. */
export const opKey = (o: PatchOp): string => JSON.stringify([o.op, o.path, o.value ?? null, o.name ?? null]);

/** The block a record belongs to, or null when it marks nothing in the Cuts or Cloth block. */
export function recordBlock(record: unknown): AppliedBlock | null {
  if (!isObject(record) || record.schema !== APPLIED_PATCH_SCHEMA) return null;
  return APPLIED_BLOCKS.find(b => record.op === BLOCK_OP[b]) ?? null;
}

/** The stage record's applied ops per block: the record's patch ops in the block it belongs to, none in the other. */
export function appliedBlockOps(record: unknown): Record<AppliedBlock, PatchOp[]> {
  const out: Record<AppliedBlock, PatchOp[]> = { cuts: [], cloth: [] };
  const block = recordBlock(record);
  if (!block) return out;
  const patch = (record as Record<string, unknown>).patch;
  const ops = isObject(patch) && Array.isArray(patch.ops) ? patch.ops as PatchOp[] : [];
  out[block] = ops.map(o => ({ ...o }));
  return out;
}

/** Whether a pending item (the ops it sends) is applied: it sends at least one op and every one is in `applied`. */
export function itemApplied(itemOps: readonly PatchOp[], applied: readonly PatchOp[]): boolean {
  if (!itemOps.length || !applied.length) return false;
  const keys = new Set(applied.map(opKey));
  return itemOps.every(o => keys.has(opKey(o)));
}

/** The stage's identity for a readout: the applied record's build id, or null on the inspected build. */
const stageId = (record: unknown): string | null => isObject(record) && typeof record.buildId === 'string' ? record.buildId : null;

/**
 * #186: the blocks whose result readout goes stale when the stage changes from `previous` to `next` — every block the
 * new stage record does not belong to (a Cuts readout after a Cloth Apply, both after a Reset or another kind of Apply).
 * Nothing while the stage is unchanged, so a refused Apply's readout stays; the owning block shows its own new job.
 */
export function staleReadouts(previous: unknown, next: unknown): AppliedBlock[] {
  if (stageId(previous) === stageId(next)) return [];
  const owner = recordBlock(next);
  return APPLIED_BLOCKS.filter(b => b !== owner);
}
