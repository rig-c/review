/**
 * Cuts, patches and limbs (#115): the producer config's `assemble.cuts`, `assemble.patches` and `limbs` as the Setup
 * Cuts block edits them on the stage. Every coordinate is rig px of the setup pose, y down — the space of `parts.json`
 * and of the cut polygons and patch boxes (rig-parts AUTHORING §3, `assemble.cuts`: "non-negative integer rig pixels").
 *
 *  - a cut's polygon vertex is one anchor at `/assemble/cuts/<i>/polygon/<k>`, a `replace` op naming the cut by `into`;
 *  - a patch's box is two corner anchors whose edit is one `replace` at `/assemble/patches/<i>/box` naming the patch;
 *  - a limb segment below a joint has its `range` (`[min, max]` degrees from rest, `min <= 0 <= max`), a `replace` (or
 *    `add` when the config states none, `remove` to drop it) at `/limbs/<limb>/segments/<k>/range` naming its `part`; its
 *    joint is the lower bone's origin, which is a `bones` anchor (`src/bone-anchors.ts`) — a joint drag is a bone op;
 *  - a new cut is `add /assemble/cuts/-` with `{from, into, polygon, draw, overlap}` (no `under`: review paints no image)
 *    plus `add /regions/<into>` (the coverage rule wants every part a mesh or a region); a new patch is
 *    `add /assemble/patches/-` with `{name, box, alpha, draw}` plus `add /regions/<name>` (a patch is always a region).
 *
 * What only the producer can judge (a polygon point past the rig, two cuts overlapping, a cut taking no pixel, an
 * `under` no longer the polygon box's size, a name already taken, a range out of order) is the producer's refusal,
 * shown verbatim. Review refuses before sending only what is not the loader's type: a non-integer or negative point, a
 * polygon under three points, a range that is not two numbers. Pure: no IO, no DOM.
 */
import type { JsonValue, PatchOp } from './config-patch.ts';

export type RigPoint = [number, number];
export type PatchBox = [number, number, number, number];
export type CutDraw = 'back' | 'front' | { before: string };
export interface ConfigCut { index: number; from: string; into: string; polygon: RigPoint[]; draw: CutDraw; overlap: number; under: string | null }
export interface ConfigPatchEntry { index: number; name: string; box: PatchBox; alpha: string; draw: CutDraw }
export interface ConfigLimbSegment { limb: string; index: number; part: string; from: string; bone: string; joint: string | null; range: [number, number] | null }
export interface CutsSource { cuts: ConfigCut[]; patches: ConfigPatchEntry[]; segments: ConfigLimbSegment[]; plan: string[]; skipped: string[] }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const intPoint = (v: unknown): RigPoint | null => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n)) ? [v[0] as number, v[1] as number] : null;
const draw = (v: unknown): CutDraw | null => v === 'back' || v === 'front' ? v : isObject(v) && typeof v.before === 'string' ? { before: v.before } : null;

/** The config's cuts, patches, limb segments and plan part names as written; an unreadable entry is named in `skipped`. */
export function cutsSource(config: unknown): CutsSource {
  const out: CutsSource = { cuts: [], patches: [], segments: [], plan: [], skipped: [] };
  if (!isObject(config)) return out;
  const assemble = isObject(config.assemble) ? config.assemble : {};
  if (Array.isArray(assemble.plan)) for (const row of assemble.plan) if (Array.isArray(row) && typeof row[0] === 'string') out.plan.push(row[0]);
  if (Array.isArray(assemble.cuts)) assemble.cuts.forEach((q, index) => {
    const polygon = isObject(q) && Array.isArray(q.polygon) ? q.polygon.map(intPoint) : [];
    const d = isObject(q) ? draw(q.draw) : null;
    if (!isObject(q) || typeof q.from !== 'string' || typeof q.into !== 'string' || !d || typeof q.overlap !== 'number' || polygon.length < 3 || polygon.some(p => !p)) { out.skipped.push(`assemble.cuts[${index}] is not {from, into, polygon, draw, overlap}`); return; }
    out.cuts.push({ index, from: q.from, into: q.into, polygon: polygon as RigPoint[], draw: d, overlap: q.overlap, under: typeof q.under === 'string' ? q.under : null });
  });
  if (Array.isArray(assemble.patches)) assemble.patches.forEach((q, index) => {
    const d = isObject(q) ? draw(q.draw) : null;
    if (!isObject(q) || typeof q.name !== 'string' || !Array.isArray(q.box) || q.box.length !== 4 || !q.box.every(n => typeof n === 'number' && Number.isFinite(n)) || typeof q.alpha !== 'string' || !d) { out.skipped.push(`assemble.patches[${index}] is not {name, box, alpha, draw}`); return; }
    out.patches.push({ index, name: q.name, box: [...q.box] as PatchBox, alpha: q.alpha, draw: d });
  });
  if (isObject(config.limbs)) for (const [limb, entry] of Object.entries(config.limbs)) {
    if (!isObject(entry) || !Array.isArray(entry.segments)) { out.skipped.push(`limbs.${limb} has no segments`); continue; }
    entry.segments.forEach((sg, index) => {
      if (!isObject(sg) || typeof sg.part !== 'string' || typeof sg.from !== 'string' || typeof sg.bone !== 'string') { out.skipped.push(`limbs.${limb}.segments[${index}] is not {part, from, bone}`); return; }
      const range = Array.isArray(sg.range) && sg.range.length === 2 && sg.range.every(n => typeof n === 'number' && Number.isFinite(n)) ? [sg.range[0], sg.range[1]] as [number, number] : null;
      out.segments.push({ limb, index, part: sg.part, from: sg.from, bone: sg.bone, joint: typeof sg.joint === 'string' ? sg.joint : null, range });
    });
  }
  return out;
}

export class CutEditError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }

/** One pending edit, keyed by its pointer; `value` is the whole new value at that pointer (or `null` to remove a range). */
export type CutEdit =
  | { kind: 'vertex'; path: string; name: string; label: string; from: RigPoint; value: RigPoint }
  | { kind: 'box'; path: string; name: string; label: string; from: PatchBox; value: PatchBox }
  | { kind: 'range'; path: string; name: string; label: string; from: [number, number] | null; value: [number, number] | null };
/** A new cut or patch, placed on the stage; it becomes two `add` ops (the entry and its `regions` bone). */
export type CutAdd =
  | { kind: 'cut'; from: string; into: string; polygon: RigPoint[]; draw: CutDraw; overlap: number; bone: string }
  | { kind: 'patch'; name: string; box: PatchBox; alpha: 'silhouette' | 'box'; draw: CutDraw; bone: string };

export const vertexPath = (cut: number, k: number) => `/assemble/cuts/${cut}/polygon/${k}`;
export const boxPath = (patch: number) => `/assemble/patches/${patch}/box`;
export const rangePath = (limb: string, k: number) => `/limbs/${limb.replace(/~/g, '~0').replace(/\//g, '~1')}/segments/${k}/range`;

/** A rig px value as the loader takes it: a non-negative integer (`CONFIG_FIELD_TYPE` otherwise). */
function rigInt(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0) throw new CutEditError('CUTS_VALUE_INVALID', `${what} must be a non-negative integer of rig px (the config's polygons and boxes are)`);
  return v;
}
const same = (a: readonly number[] | null, b: readonly number[] | null) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));

/** Set a cut vertex; a value equal to the config's removes the pending edit. */
export function setVertex(edits: ReadonlyMap<string, CutEdit>, cut: ConfigCut, k: number, value: RigPoint): Map<string, CutEdit> {
  const from = cut.polygon[k];
  if (!from) throw new CutEditError('CUTS_VERTEX_UNKNOWN', `${cut.into} has no vertex ${k}`);
  const v: RigPoint = [rigInt(value[0], `${cut.into} vertex ${k} x`), rigInt(value[1], `${cut.into} vertex ${k} y`)];
  const next = new Map(edits), path = vertexPath(cut.index, k);
  if (same(v, from)) next.delete(path); else next.set(path, { kind: 'vertex', path, name: cut.into, label: `${cut.into} vertex ${k}`, from: [...from], value: v });
  return next;
}
/** Set a patch box (`[x0, y0, x1, y1]`, `x1`/`y1` exclusive); a box equal to the config's removes the edit. */
export function setBox(edits: ReadonlyMap<string, CutEdit>, patch: ConfigPatchEntry, value: PatchBox): Map<string, CutEdit> {
  const v = value.map((n, i) => rigInt(n, `${patch.name} box[${i}]`)) as PatchBox;
  if (v[2] <= v[0] || v[3] <= v[1]) throw new CutEditError('CUTS_VALUE_INVALID', `${patch.name} box must have x1 > x0 and y1 > y0`);
  const next = new Map(edits), path = boxPath(patch.index);
  if (same(v, patch.box)) next.delete(path); else next.set(path, { kind: 'box', path, name: patch.name, label: `${patch.name} box`, from: [...patch.box] as PatchBox, value: v });
  return next;
}
/** Set (or with null, drop) a segment's range; only a segment below a joint takes one (the loader's `CONFIG_KEY_KNOWN`). */
export function setRange(edits: ReadonlyMap<string, CutEdit>, segment: ConfigLimbSegment, value: [number, number] | null): Map<string, CutEdit> {
  if (!segment.joint) throw new CutEditError('CUTS_RANGE_UPPER', `${segment.part} is the upper segment of ${segment.limb}; only a segment below a joint takes a range`);
  if (value && !value.every(n => typeof n === 'number' && Number.isFinite(n))) throw new CutEditError('CUTS_VALUE_INVALID', `${segment.part} range must be two numbers of degrees`);
  const next = new Map(edits), path = rangePath(segment.limb, segment.index);
  if (same(value, segment.range)) next.delete(path); else next.set(path, { kind: 'range', path, name: segment.part, label: `${segment.limb} ${segment.joint} range (${segment.part})`, from: segment.range ? [...segment.range] : null, value: value ? [...value] : null });
  return next;
}
/** Where a vertex stands now: its pending value, else the config's. */
export const vertexAt = (edits: ReadonlyMap<string, CutEdit>, cut: ConfigCut, k: number): RigPoint => (edits.get(vertexPath(cut.index, k)) as Extract<CutEdit, { kind: 'vertex' }> | undefined)?.value ?? cut.polygon[k]!;
export const boxAt = (edits: ReadonlyMap<string, CutEdit>, patch: ConfigPatchEntry): PatchBox => (edits.get(boxPath(patch.index)) as Extract<CutEdit, { kind: 'box' }> | undefined)?.value ?? patch.box;
export const rangeAt = (edits: ReadonlyMap<string, CutEdit>, s: ConfigLimbSegment): [number, number] | null => { const e = edits.get(rangePath(s.limb, s.index)) as Extract<CutEdit, { kind: 'range' }> | undefined; return e ? e.value : s.range; };

/** A drag moves a point by the pointer's delta snapped to whole rig px. */
export const dragPoint = (from: RigPoint, start: RigPoint, now: RigPoint): RigPoint => [0, 1].map(i => { const d = Math.round(now[i]! - start[i]!); return from[i]! + (d === 0 ? 0 : d); }) as RigPoint;

/**
 * The pending edits and additions as config patch ops, in order: the edits (each one op at its own pointer, naming its
 * entry), then each addition's entry and its `regions` bone. A new name is not checked against the config: the
 * producer's `CONFIG_PART_UNIQUE` says so, verbatim.
 */
export function cutOps(edits: ReadonlyMap<string, CutEdit>, adds: readonly CutAdd[], config: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  for (const e of edits.values()) {
    if (e.kind === 'range') {
      if (e.value === null) ops.push({ op: 'remove', path: e.path, name: e.name });
      else ops.push({ op: e.from === null ? 'add' : 'replace', path: e.path, value: [...e.value], name: e.name });
    } else ops.push({ op: 'replace', path: e.path, value: [...e.value], name: e.name });
  }
  const assemble = isObject(config) && isObject(config.assemble) ? config.assemble : {};
  let cuts = Array.isArray(assemble.cuts) ? assemble.cuts.length : null, patches = Array.isArray(assemble.patches) ? assemble.patches.length : null;
  let regions = isObject(config) && isObject(config.regions);
  for (const a of adds) {
    const list = a.kind === 'cut' ? 'cuts' : 'patches', has = a.kind === 'cut' ? cuts !== null : patches !== null;
    const entry: JsonValue = a.kind === 'cut'
      ? { from: a.from, into: a.into, polygon: a.polygon.map(p => [rigInt(p[0], `${a.into} x`), rigInt(p[1], `${a.into} y`)]), draw: a.draw as JsonValue, overlap: rigInt(a.overlap, `${a.into} overlap`) }
      : { name: a.name, box: a.box.map((n, i) => rigInt(n, `${a.name} box[${i}]`)), alpha: a.alpha, draw: a.draw as JsonValue };
    if (a.kind === 'cut' && a.polygon.length < 3) throw new CutEditError('CUTS_POLYGON_SHORT', `${a.into} needs at least three points`);
    ops.push(has ? { op: 'add', path: `/assemble/${list}/-`, value: entry } : { op: 'add', path: `/assemble/${list}`, value: [entry] });
    if (a.kind === 'cut') cuts = (cuts ?? 0) + 1; else patches = (patches ?? 0) + 1;
    const name = a.kind === 'cut' ? a.into : a.name;
    if (!regions) { ops.push({ op: 'add', path: '/regions', value: {} }); regions = true; }
    ops.push({ op: 'add', path: `/regions/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, value: a.bone });
  }
  return ops;
}

/**
 * A segment's range as an arc for the overlay: the joint (the lower bone's origin), the bone's rest direction (rig px,
 * y down) and the two ends `min`, `max` turned counter-clockwise on screen (rigc's sense), sampled every `step` degrees.
 */
export function rangeArc(joint: RigPoint, toward: RigPoint, range: [number, number], radius: number, step = 5): RigPoint[] {
  const rest = Math.atan2(toward[1] - joint[1], toward[0] - joint[0]);
  const [lo, hi] = range[0] <= range[1] ? range : [range[1], range[0]];
  const out: RigPoint[] = [[joint[0], joint[1]]];
  for (let d = lo; ; d = Math.min(hi, d + step)) {
    // Counter-clockwise on screen with y down is a negative angle in rig px.
    const a = rest - (d * Math.PI) / 180;
    out.push([joint[0] + radius * Math.cos(a), joint[1] + radius * Math.sin(a)]);
    if (d >= hi) break;
  }
  return out;
}

export const CUTS_DRAFT_SCHEMA = 'rig-review-cuts-draft/1';
export const cutsDraftText = (edits: ReadonlyMap<string, CutEdit>, adds: readonly CutAdd[]) => JSON.stringify({ schema: CUTS_DRAFT_SCHEMA, edits: [...edits.values()], adds });
/** Edits back from a draft, kept only where the pointer still names the same entry with the same config value. */
export function cutsDraft(text: string, source: CutsSource): { edits: Map<string, CutEdit>; adds: CutAdd[] } {
  const empty = { edits: new Map<string, CutEdit>(), adds: [] as CutAdd[] };
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return empty; }
  if (!isObject(doc) || doc.schema !== CUTS_DRAFT_SCHEMA || !Array.isArray(doc.edits)) return empty;
  let edits = new Map<string, CutEdit>();
  for (const e of doc.edits as CutEdit[]) {
    try {
      if (e.kind === 'vertex') { const m = /^\/assemble\/cuts\/(\d+)\/polygon\/(\d+)$/.exec(e.path); const cut = m ? source.cuts.find(c => c.index === Number(m[1])) : undefined; if (cut && cut.into === e.name && same(cut.polygon[Number(m![2])] ?? null, e.from)) edits = setVertex(edits, cut, Number(m![2]), e.value); }
      else if (e.kind === 'box') { const patch = source.patches.find(q => boxPath(q.index) === e.path); if (patch && patch.name === e.name && same(patch.box, e.from)) edits = setBox(edits, patch, e.value); }
      else if (e.kind === 'range') { const s = source.segments.find(g => rangePath(g.limb, g.index) === e.path); if (s && s.part === e.name && same(s.range, e.from)) edits = setRange(edits, s, e.value); }
    } catch { /* a draft value the editor would refuse is dropped */ }
  }
  const adds = Array.isArray(doc.adds) ? (doc.adds as CutAdd[]).filter(a => isObject(a) && (a.kind === 'cut' || a.kind === 'patch')) : [];
  return { edits, adds };
}
