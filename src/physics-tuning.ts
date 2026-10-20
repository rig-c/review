/**
 * Physics tuning (#103), the pure half: which constraint rows of the inspected model the handoff config declares (so a
 * field can be patched at `/constraints/<i>/<field>`), the pending edits as config patch ops that record the constraint's
 * name beside its index, the constraint chains read from bone parentage with their root → tip ramp, and the check
 * readout lines. No DOM, no IO, no clock; the producer judges every value (a mass of 0 is rigc's `A23` to refuse).
 */
import { formatPointer, type PatchOp } from './config-patch.ts';
import type { CheckSummary } from './applied-context.ts';

/** rig-c's `RigPhysicsConstraint` tuning fields (rig-c `src/rig.ts`; defaults 0.5 / 100 / 0.85 / 1 / 0 / 0 / 1). */
export const TUNING_FIELDS = ['strength', 'damping', 'inertia', 'mass', 'wind', 'gravity', 'mix'] as const;
export type TuningField = typeof TUNING_FIELDS[number];
/** The components the panel toggles; rig-c stores each as a number (0 = off). `scaleX` and `shearX` are not offered. */
export const COMPONENT_FIELDS = ['x', 'y', 'rotate'] as const;
export type ComponentField = typeof COMPONENT_FIELDS[number];
export type PhysicsField = TuningField | ComponentField;
/** Slider extents; the number field beside each slider takes any finite value and the slider widens to hold it. */
export const FIELD_RANGE: Readonly<Record<TuningField, { min: number; max: number; step: number }>> = {
  strength: { min: 0, max: 1000, step: 1 }, damping: { min: 0, max: 1, step: 0.01 }, inertia: { min: 0, max: 1, step: 0.01 },
  mass: { min: 0, max: 5, step: 0.05 }, wind: { min: -20, max: 20, step: 0.1 }, gravity: { min: -20, max: 20, step: 0.1 }, mix: { min: 0, max: 1, step: 0.01 },
};
/** The check bars whose lines the readout shows before and after an Apply. */
export const READOUT_BARS = ['ANIMATIONS_DO_NOT_FOLD', 'TEXTURE_STRETCH'] as const;

export interface TuningRow {
  name: string; kind: string; bone: string | null;
  /** Index in the inspected model's `constraints`, or null for a config entry the model does not have. */
  modelIndex: number | null;
  /** Index in the handoff config's `constraints`: the pointer's index. Null when the config does not declare the row. */
  configIndex: number | null;
  editable: boolean;
  /** Why a row is not editable, by name; null when it is. */
  reason: string | null;
  /** The config's numeric values for the panel's fields, exactly as written; an absent field stays absent. */
  values: Partial<Record<PhysicsField, number>>;
}
export type TuningTable = { available: true; rows: TuningRow[] } | { available: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const FIELDS: readonly PhysicsField[] = [...TUNING_FIELDS, ...COMPONENT_FIELDS];
const numberOf = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * The inspected model's constraints, each matched to the config entry of the same name and kind (the config's `type`
 * is the model's `kind`). A row is editable only when it is a physics constraint the config declares and every field
 * this panel edits (and the bone) reads the same on both sides — the config field maps 1:1 onto what the model holds.
 */
export function tuningRows(configConstraints: unknown, modelDocument: unknown): TuningTable {
  if (!isObject(modelDocument) || !Array.isArray(modelDocument.constraints)) return { available: false, reason: 'PHYSICS_TUNING_UNAVAILABLE: the inspected model declares no constraints list' };
  if (!Array.isArray(configConstraints)) return { available: false, reason: 'PHYSICS_TUNING_UNAVAILABLE: the handoff config has no constraints list' };
  const config = configConstraints.map((entry, index) => ({ entry: isObject(entry) ? entry : {}, index }));
  const used = new Set<number>();
  const rows: TuningRow[] = [];
  modelDocument.constraints.forEach((raw, modelIndex) => {
    const m = isObject(raw) ? raw : {};
    const name = typeof m.name === 'string' ? m.name : `#${modelIndex}`, kind = typeof m.kind === 'string' ? m.kind : 'unknown';
    const bone = typeof m.bone === 'string' ? m.bone : null;
    const found = config.find(c => !used.has(c.index) && c.entry.name === name && c.entry.type === kind);
    if (!found) {
      rows.push({ name, kind, bone, modelIndex, configIndex: null, editable: false, values: {}, reason: `PHYSICS_ROW_UNDECLARED: the model has ${kind} "${name}" but config.constraints does not declare it; it was added at the rig stage (e.g. the \`turn\` twins), so there is no config field to patch` });
      return;
    }
    used.add(found.index);
    const values: Partial<Record<PhysicsField, number>> = {};
    for (const field of FIELDS) { const v = numberOf(found.entry[field]); if (v !== undefined) values[field] = v; }
    if (kind !== 'physics') { rows.push({ name, kind, bone, modelIndex, configIndex: found.index, editable: false, values, reason: `PHYSICS_ROW_NOT_PHYSICS: config.constraints[${found.index}] is a ${kind} constraint; this panel tunes physics constraints only` }); return; }
    const differs = [...FIELDS, 'bone'].find(field => JSON.stringify(found.entry[field]) !== JSON.stringify(m[field]));
    if (differs) { rows.push({ name, kind, bone, modelIndex, configIndex: found.index, editable: false, values, reason: `PHYSICS_ROW_UNMAPPED: config.constraints[${found.index}].${differs} is ${JSON.stringify(found.entry[differs]) ?? 'absent'}, the model holds ${JSON.stringify(m[differs]) ?? 'absent'}; the config does not map 1:1 onto this row` }); return; }
    rows.push({ name, kind, bone, modelIndex, configIndex: found.index, editable: true, reason: null, values });
  });
  for (const c of config) if (!used.has(c.index)) {
    const name = typeof c.entry.name === 'string' ? c.entry.name : `#${c.index}`, kind = typeof c.entry.type === 'string' ? c.entry.type : 'unknown';
    rows.push({ name, kind, bone: typeof c.entry.bone === 'string' ? c.entry.bone : null, modelIndex: null, configIndex: c.index, editable: false, values: {}, reason: `PHYSICS_ROW_NOT_IN_MODEL: config.constraints[${c.index}] ${kind} "${name}" is not in the inspected model` });
  }
  return { available: true, rows };
}

/** One pending edit: the patch op it becomes, with the field, the config's value before it and the constraint's name. */
export interface PendingEdit { op: 'replace' | 'add'; path: string; value: number; name: string; configIndex: number; field: PhysicsField; from: number | null }
export const pointerFor = (row: Pick<TuningRow, 'configIndex'>, field: PhysicsField) => formatPointer(['constraints', row.configIndex!, field]);

/**
 * The edit setting `field` of an editable row to `value`: `replace` when the config declares the field, `add` when it
 * does not. Null when the value is the config's own (the edit reverts). Refused by name for a row that is not editable.
 */
export function editFor(row: TuningRow, field: PhysicsField, value: number): PendingEdit | null {
  if (!row.editable || row.configIndex === null) throw new Error(row.reason ?? `PHYSICS_ROW_NOT_EDITABLE: ${row.name}`);
  if (!FIELDS.includes(field)) throw new Error(`PHYSICS_FIELD_UNKNOWN: ${field}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`PHYSICS_VALUE_INVALID: ${row.name}.${field} must be a finite number`);
  const from = row.values[field] ?? null;
  if (from === value) return null;
  return { op: from === null ? 'add' : 'replace', path: pointerFor(row, field), value, name: row.name, configIndex: row.configIndex, field, from };
}

/** Pending edits by pointer: a later edit of the same field replaces the earlier one; an edit back to the config's value drops it. */
export function setEdit(edits: ReadonlyMap<string, PendingEdit>, row: TuningRow, field: PhysicsField, value: number): Map<string, PendingEdit> {
  const next = new Map(edits), edit = editFor(row, field, value), path = pointerFor(row, field);
  if (edit) next.set(path, edit); else next.delete(path);
  return next;
}

/** The ops a patch carries, in edit order, each naming its constraint so the server resolves it by name as well as index. */
export const patchOps = (edits: ReadonlyMap<string, PendingEdit>): PatchOp[] => [...edits.values()].map(e => ({ op: e.op, path: e.path, value: e.value, name: e.name }));

/** A component's toggle: on keeps (or restores) the config's own weight, else 1; off is 0. */
export function componentValue(row: TuningRow, field: ComponentField, on: boolean): number {
  const declared = row.values[field];
  return on ? (declared !== undefined && declared > 0 ? declared : 1) : 0;
}

/** Which components a row moves (non-zero x, y, rotate), as a chain groups links: "rotate", "x+y", … */
export const componentSignature = (row: TuningRow) => COMPONENT_FIELDS.filter(f => (row.values[f] ?? 0) !== 0).join('+') || 'none';

export interface PhysicsChain { id: string; label: string; signature: string; links: TuningRow[] }
/**
 * Chains of editable physics rows read from bone parentage: a link's parent link is the row on its bone's parent bone
 * that moves the same components. Every root → tip path of two or more links is a chain (a fork gives one per branch).
 */
export function physicsChains(rows: readonly TuningRow[], bones: readonly { name: string; parent?: string | null }[]): PhysicsChain[] {
  const parent = new Map(bones.map(b => [b.name, b.parent ?? null]));
  const links = rows.filter(r => r.editable && r.kind === 'physics' && r.bone !== null);
  const at = new Map<string, TuningRow[]>();
  for (const row of links) { const key = `${componentSignature(row)}|${row.bone}`; at.set(key, [...(at.get(key) ?? []), row]); }
  const one = (signature: string, bone: string | null) => { if (bone === null) return null; const found = at.get(`${signature}|${bone}`); return found && found.length === 1 ? found[0]! : null; };
  const parentLink = (row: TuningRow) => one(componentSignature(row), parent.get(row.bone!) ?? null);
  const children = new Map<TuningRow, TuningRow[]>();
  for (const row of links) { const up = parentLink(row); if (up) children.set(up, [...(children.get(up) ?? []), row]); }
  const chains: PhysicsChain[] = [];
  const walk = (path: TuningRow[]) => {
    const next = children.get(path.at(-1)!) ?? [];
    if (!next.length) { if (path.length >= 2) { const signature = componentSignature(path[0]!); chains.push({ id: path.map(r => r.name).join('>'), signature, label: `${path[0]!.bone} → ${path.at(-1)!.bone} · ${signature} · ${path.length} links`, links: path }); } return; }
    for (const child of next) walk([...path, child]);
  };
  for (const row of links) if (!parentLink(row)) walk([row]);
  return chains;
}

/** Link i of n (0 at the root) takes root + (tip − root)·i/(n − 1): exactly one edit per link, linear root → tip. */
export function rampValues(n: number, root: number, tip: number): number[] {
  if (!Number.isInteger(n) || n < 2) throw new Error('PHYSICS_CHAIN_SHORT: a ramp needs two or more links');
  return Array.from({ length: n }, (_, i) => root + (tip - root) * i / (n - 1));
}
/** The ramp as edits over the pending set: every link's `field` set once, root → tip. */
export function applyRamp(edits: ReadonlyMap<string, PendingEdit>, chain: PhysicsChain, field: PhysicsField, root: number, tip: number): Map<string, PendingEdit> {
  const values = rampValues(chain.links.length, root, tip);
  let next = new Map(edits);
  chain.links.forEach((row, i) => { next = setEdit(next, row, field, values[i]!); });
  return next;
}

/**
 * One readout line for a bar: check's own printed line for it (`  NAME: STATUS — …`) from the job's lines, else the
 * bar's status from the summary, else "not in check summary" by name. Nothing is inferred.
 */
export function barLine(name: string, lines: readonly string[] | null, check: CheckSummary | null): string {
  const printed = lines?.map(l => l.trim()).find(l => l.startsWith(`${name}: `));
  if (printed) return printed;
  const status = check?.bars[name];
  return status ? `${name}: ${status} (status from check.json; check printed no line for it)` : `${name}: not in check summary`;
}

/** The inspected build's stored check (#108, HQ ruling) as `GET /api/rebuild` returns it. */
export interface InspectedCheckView { status: 'running' | 'checked' | 'refused' | 'failed'; lines: string[]; check: CheckSummary | null; line: string }
export const INSPECTED_NOT_CHECKED = (name: string) => `${name}: not in check summary (the inspected build; review ran no check on it)`;
/**
 * BEFORE: the build that was on the stage when Apply was pressed. A scratch build: its own check lines. The inspected
 * build: the stored background check of it — labelled "check running…" while it runs (never a value), its line
 * verbatim when check refused, and "not in check summary" only when no check exists (the baseline did not reproduce).
 */
export function beforeLine(name: string, stage: { lines: readonly string[]; check: CheckSummary | null } | null, inspected: InspectedCheckView | null): string {
  if (stage) return barLine(name, stage.lines, stage.check);
  if (!inspected) return INSPECTED_NOT_CHECKED(name);
  if (inspected.status === 'running') return `${name}: check running… (rig-parts check of the inspected build, in the background)`;
  if (inspected.status !== 'checked') return inspected.line;
  return barLine(name, inspected.lines, inspected.check);
}
/** The readout rows after an Apply: BEFORE per `beforeLine`, AFTER from the job just built. */
export function readoutRows(stage: { lines: readonly string[]; check: CheckSummary | null } | null, inspected: InspectedCheckView | null, after: { lines: readonly string[]; check: CheckSummary | null }) {
  return READOUT_BARS.map(name => ({ name, before: beforeLine(name, stage, inspected), after: barLine(name, after.lines, after.check) }));
}

/** A control the row editor draws: a slider with its number field (a tuning field) or a toggle (a component). */
export type RowControl =
  | { kind: 'slider'; field: TuningField; value: number; base: number; min: number; max: number; step: number; pending: boolean }
  | { kind: 'toggle'; field: ComponentField; on: boolean; base: number | null; pending: boolean };
/**
 * What the row editor shows for a row: for an editable row a slider per tuning field the config declares (an absent
 * field is the producer's default, shown as absent and not offered) and the x / y / rotate toggles; for a row that is
 * not editable no control at all, only the reason.
 */
export function rowControls(row: TuningRow, edits: ReadonlyMap<string, PendingEdit>): { editable: true; controls: RowControl[] } | { editable: false; reason: string } {
  if (!row.editable || row.configIndex === null) return { editable: false, reason: row.reason ?? `PHYSICS_ROW_NOT_EDITABLE: ${row.name}` };
  const current = (field: PhysicsField) => edits.get(pointerFor(row, field))?.value;
  const controls: RowControl[] = [];
  for (const field of TUNING_FIELDS) {
    const base = row.values[field];
    if (base === undefined && current(field) === undefined) continue;
    const value = current(field) ?? base!, range = FIELD_RANGE[field];
    controls.push({ kind: 'slider', field, value, base: base ?? value, min: Math.min(range.min, value), max: Math.max(range.max, value), step: range.step, pending: current(field) !== undefined });
  }
  for (const field of COMPONENT_FIELDS) {
    const value = current(field) ?? row.values[field] ?? 0;
    controls.push({ kind: 'toggle', field, on: value !== 0, base: row.values[field] ?? null, pending: current(field) !== undefined });
  }
  return { editable: true, controls };
}

/** The chain whose link bone lies nearest a click on the stage, within `radius` px; null when none does. */
export function nearestChain(chains: readonly PhysicsChain[], points: ReadonlyMap<string, { x: number; y: number }>, click: { x: number; y: number }, radius = 24): PhysicsChain | null {
  let best: { chain: PhysicsChain; d: number } | null = null;
  for (const chain of chains) for (const link of chain.links) {
    const p = link.bone ? points.get(link.bone) : undefined;
    if (!p) continue;
    const d = Math.hypot(p.x - click.x, p.y - click.y);
    if (d <= radius && (!best || d < best.d)) best = { chain, d };
  }
  return best?.chain ?? null;
}

/** The draft's record of the panel: the pending edits (in order) as the patch ops they become. */
export const PHYSICS_DRAFT_SCHEMA = 'rig-review-physics-draft/1';
export function draftText(edits: ReadonlyMap<string, PendingEdit>): string { return JSON.stringify({ schema: PHYSICS_DRAFT_SCHEMA, edits: [...edits.values()] }); }
/** Edits back from a draft, kept only where the row still resolves (same name at the same index, still editable). */
export function draftEdits(text: string, rows: readonly TuningRow[]): Map<string, PendingEdit> {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return new Map(); }
  if (!isObject(doc) || doc.schema !== PHYSICS_DRAFT_SCHEMA || !Array.isArray(doc.edits)) return new Map();
  let edits = new Map<string, PendingEdit>();
  for (const raw of doc.edits) {
    if (!isObject(raw) || typeof raw.value !== 'number' || typeof raw.field !== 'string') continue;
    const row = rows.find(r => r.editable && r.configIndex === raw.configIndex && r.name === raw.name);
    if (!row || !FIELDS.includes(raw.field as PhysicsField)) continue;
    try { edits = setEdit(edits, row, raw.field as PhysicsField, raw.value); } catch { /* a value the panel would refuse is not restored */ }
  }
  return edits;
}
