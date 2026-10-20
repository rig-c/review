/**
 * Mesh panel (issue #106), pure: one part's `meshes.<part>` entry as the installed producer's config loader reads it
 * (`@rig-c/parts` AUTHORING §3, `meshes.<part>` rows), what `rig-parts remesh --mesh` takes. Review edits the two modes
 * remesh documents with a field set this panel draws — `grid` (the lattice) and `contour` (the outline mode) — and
 * reads the rest as written. `auto` is documented by remesh but has no controls here; `influence` is a config mode
 * that `remesh --help` does not name, so it is not offered (that half is the producer's to document).
 *
 * The pre-checks mirror the config loader's rules and names only (`CONFIG_MESH_MODE`, `CONFIG_FIELD_PRESENT`,
 * `CONFIG_FIELD_TYPE`, `CONFIG_REGION_NAME_UNIQUE`, `CONFIG_NAME_RESOLVES`, `CONFIG_RIBS_MODE`, `CONFIG_STRAY_MODE`).
 * What the outline itself refuses at the rig stage — a spacing whose keep radius snaps to 0 (`CONTOUR_PARAMETER`), a
 * bridge no quad makes (`CONTOUR_BRIDGE`), a heat source (`RIG_HEAT_*`), a remesh rule (`REMESH_*`) — is the
 * producer's to say, in its words: those lines come back verbatim. No IO, no clock.
 */
import { applyConfigPatch, jsonDiff, parsePointer, pointerToken, type ConfigPatch, type JsonValue, type PatchOp } from './config-patch.ts';

export const MESH_PANEL_SCHEMA = 'rig-review-mesh-entry/1';
/** The 1/256 px grid every region number sits on (parts `GRID`). */
export const MESH_GRID = 256;
export type MeshMode = 'grid' | 'contour' | 'auto' | 'influence';
export const MESH_MODES: readonly MeshMode[] = ['grid', 'contour', 'auto', 'influence'];
/** The modes this panel edits: the two whose fields remesh documents and the panel draws. */
export const EDITABLE_MODES: readonly MeshMode[] = ['grid', 'contour'];
/** Every key the loader accepts on `meshes.<part>` (parts `checkMeshes`), in its order. */
export const ENTRY_KEYS = ['grid', 'r', 'segments', 'contour', 'auto', 'exponent', 'rule', 'ribs', 'influences', 'stray', 'influence'] as const;
/** `contour`'s keys, in the loader's order. */
export const CONTOUR_KEYS = ['tolerance', 'margin', 'spacing', 'maxEdge', 'budget', 'stray', 'bridges', 'regions', 'bust'] as const;

export type Point = [number, number];
export type Segment = string | [string, Point, Point];
export type MeshRegion =
  | { name: string; shape: 'circle'; cx: number; cy: number; r: number; bone: string; spacing: number; band: number }
  | { name: string; shape: 'polygon'; points: Point[]; bone: string; spacing: number; band: number };
export type MeshEntry = Record<string, JsonValue>;

export class MeshEntryError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const isObject = (v: unknown): v is Record<string, JsonValue> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const whole = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const onGrid = (v: number) => Number.isInteger(v * MESH_GRID);

/** The entry's mode, or the loader's refusal when it states none or several. */
export function meshMode(entry: unknown, part: string): { mode: MeshMode } | { error: string } {
  if (!isObject(entry)) return { error: `CONFIG_FIELD_TYPE: config.meshes.${part} — is not an object` };
  const modes = MESH_MODES.filter(m => m in entry);
  if (modes.length === 1) return { mode: modes[0]! };
  return { error: `CONFIG_MESH_MODE: config.meshes.${part} — ${modes.length ? `has ${modes.join(' and ')}` : 'has no mode'}; exactly one of grid, contour, auto and influence is required` };
}
/** Why the panel draws no controls for a mode (null when it does). */
export function modeNotEditable(mode: MeshMode): string | null {
  if (mode === 'auto') return 'MESH_PANEL_MODE: an auto entry is remeshed by the producer but this panel draws no auto controls; edit it in the config';
  if (mode === 'influence') return 'MESH_PANEL_MODE: remesh --help names grid, contour and auto entries, not influence; an influence entry waits for the producer to document it';
  return null;
}

/** A slider: review's drawing range (never a bound — the number field takes any value), and the producer's rule in its words. */
export interface MeshParam {
  key: string; path: readonly string[]; mode: 'grid' | 'contour' | 'both';
  min: number; max: number; step: number; optional: boolean; integer: boolean; rule: string;
}
/** AUTHORING §3, `meshes.<part>` and `meshes.<part>.contour`: what each field is, as the producer states it. */
export const MESH_PARAMS: readonly MeshParam[] = [
  { key: 'tolerance', path: ['contour', 'tolerance'], mode: 'contour', min: 0, max: 10, step: 0.5, optional: false, integer: false, rule: "rig-c's Douglas–Peucker tolerance on the traced outline, px, 0 or more" },
  { key: 'margin', path: ['contour', 'margin'], mode: 'contour', min: 0, max: 10, step: 1, optional: false, integer: false, rule: 'how far the silhouette grows before it is traced, px: 0, or 1 or more' },
  { key: 'spacing', path: ['contour', 'spacing'], mode: 'contour', min: 4, max: 80, step: 1, optional: false, integer: false, rule: 'the background interior spacing, px, above 0' },
  { key: 'maxEdge', path: ['contour', 'maxEdge'], mode: 'contour', min: 4, max: 160, step: 1, optional: true, integer: false, rule: 'the longest outline edge, px, above 0 (absent: nothing is cut)' },
  { key: 'budget', path: ['contour', 'budget'], mode: 'contour', min: 3, max: 2000, step: 1, optional: true, integer: true, rule: 'the most vertices the mesh may have (refused above it, nothing thinned)' },
  { key: 'stray', path: ['contour', 'stray'], mode: 'contour', min: 0, max: 2000, step: 1, optional: true, integer: true, rule: 'the largest island, in art pixels, that may be left out of the mesh' },
  { key: 'grid', path: ['grid'], mode: 'grid', min: 2, max: 80, step: 1, optional: false, integer: true, rule: 'the lattice: cell size, px (a whole number, 1 or more)' },
  { key: 'stray', path: ['stray'], mode: 'grid', min: 0, max: 2000, step: 1, optional: true, integer: true, rule: 'the largest island, in art pixels, that may be left out of the lattice' },
  { key: 'r', path: ['r'], mode: 'both', min: 0, max: 60, step: 1, optional: false, integer: false, rule: 'added to every distance before weighting: w = 1/(d + r)²' },
  { key: 'exponent', path: ['exponent'], mode: 'both', min: 0.5, max: 8, step: 0.1, optional: true, integer: false, rule: 'a number above 0 that replaces the 2 in w = 1/(d + r)^exponent (absent is 2)' },
  { key: 'maxInfluences', path: ['influences', 'maxInfluences'], mode: 'both', min: 1, max: 8, step: 1, optional: true, integer: true, rule: 'the most bones that pull one vertex (absent is 4)' },
];
export const RULES = ['distance', 'heat'] as const;
export const FLOORS = ['cut', 'continuous'] as const;
export const paramsFor = (mode: MeshMode) => MESH_PARAMS.filter(p => p.mode === 'both' || p.mode === mode);

/** The value at a path inside the entry, or undefined. */
export function entryValue(entry: MeshEntry, path: readonly string[]): JsonValue | undefined {
  let at: JsonValue | undefined = entry;
  for (const key of path) at = isObject(at) && Object.hasOwn(at, key) ? at[key] : undefined;
  return at;
}
/**
 * A copy of the entry with one field set (or removed with undefined). A new key goes where the loader lists it, so
 * the pending entry keeps the config's order and only the edited field differs. An emptied `influences` is removed.
 */
export function setEntryValue(entry: MeshEntry, path: readonly string[], value: JsonValue | undefined): MeshEntry {
  const out = structuredClone(entry);
  let holder: Record<string, JsonValue> = out;
  for (const key of path.slice(0, -1)) {
    if (!isObject(holder[key])) { if (value === undefined) return out; holder[key] = {}; }
    holder = holder[key] as Record<string, JsonValue>;
  }
  const last = path.at(-1)!;
  if (value === undefined) delete holder[last];
  else holder[last] = value;
  const order = path.length === 1 ? ENTRY_KEYS as readonly string[] : path[0] === 'contour' ? CONTOUR_KEYS as readonly string[] : path[0] === 'influences' ? ['maxInfluences', 'floor'] : null;
  if (order && value !== undefined) reorder(holder, order);
  if (isObject(out.influences) && !Object.keys(out.influences).length) delete out.influences;
  if (isObject(out.ribs) && !Object.keys(out.ribs).length) delete out.ribs;
  return out;
}
/** Keys the order names first, in that order; any other key keeps its place after them. */
function reorder(holder: Record<string, JsonValue>, order: readonly string[]): void {
  const known = order.filter(k => Object.hasOwn(holder, k)), rest = Object.keys(holder).filter(k => !order.includes(k));
  const before = Object.keys(holder);
  // An entry as written keeps its own order: only a key that was not there moves into the loader's place.
  const sorted = [...known, ...rest];
  if (before.join() === sorted.join()) return;
  const copy = { ...holder };
  for (const k of before) delete holder[k];
  for (const k of sorted) holder[k] = copy[k]!;
}

/** The region list of a contour entry, as written (empty when it states none). */
export function entryRegions(entry: MeshEntry): MeshRegion[] {
  const regions = entryValue(entry, ['contour', 'regions']);
  return Array.isArray(regions) ? regions.filter(isObject) as unknown as MeshRegion[] : [];
}
export const withRegions = (entry: MeshEntry, regions: readonly MeshRegion[]): MeshEntry => setEntryValue(entry, ['contour', 'regions'], regions.length ? regions.map(r => structuredClone(r)) as unknown as JsonValue : undefined);
/** Whole rig px: every whole number is a multiple of 1/256, the loader's grid. */
export const snapPoint = (x: number, y: number): Point => [Math.round(x), Math.round(y)];
/** A new polygon region from at least three placed points, its bone, spacing and band. */
export function polygonRegion(name: string, points: readonly Point[], bone: string, spacing: number, band: number): MeshRegion {
  if (points.length < 3) throw new MeshEntryError('MESH_POLYGON_POINTS', `${name} has ${points.length} point(s); a polygon region needs 3 or more`);
  return { name, shape: 'polygon', points: points.map(p => snapPoint(p[0], p[1])), bone, spacing, band };
}
/** Move one vertex of a polygon region (or a circle's centre, vertex 0) to a rig px point on the whole-pixel grid. */
export function moveRegionPoint(regions: readonly MeshRegion[], index: number, vertex: number, to: Point): MeshRegion[] {
  return regions.map((r, i) => {
    if (i !== index) return structuredClone(r);
    const [x, y] = snapPoint(to[0], to[1]);
    if (r.shape === 'circle') return { ...r, cx: x, cy: y };
    return { ...r, points: r.points.map((p, k) => (k === vertex ? [x, y] as Point : [p[0], p[1]] as Point)) };
  });
}
/** A free region name: `<stem>`, else `<stem>_2`, `<stem>_3`, … */
export function freeRegionName(regions: readonly MeshRegion[], stem = 'region'): string {
  const names = new Set(regions.map(r => r.name));
  if (!names.has(stem)) return stem;
  for (let i = 2; ; i++) if (!names.has(`${stem}_${i}`)) return `${stem}_${i}`;
}
/** The nearest region handle (polygon vertex or circle centre) to a point in pane px, within `radius`. */
export function hitRegionPoint(regions: readonly MeshRegion[], project: (x: number, y: number) => { x: number; y: number }, at: { x: number; y: number }, radius = 9): { region: number; vertex: number } | null {
  let best: { region: number; vertex: number; d: number } | null = null;
  regions.forEach((r, region) => {
    const points: Point[] = r.shape === 'circle' ? [[r.cx, r.cy]] : r.points;
    points.forEach((p, vertex) => {
      const q = project(p[0], p[1]), d = Math.hypot(q.x - at.x, q.y - at.y);
      if (d <= radius && (!best || d < best.d)) best = { region, vertex, d };
    });
  });
  return best ? { region: (best as { region: number }).region, vertex: (best as { vertex: number }).vertex } : null;
}

/** The entry's segments as written. */
export const entrySegments = (entry: MeshEntry): Segment[] => (Array.isArray(entry.segments) ? entry.segments as unknown as Segment[] : []);
/** Add a bone (or chain) name from the bone list; a name already listed is not added twice. */
export function addSegment(entry: MeshEntry, name: string): MeshEntry {
  if (!name || entrySegments(entry).some(s => s === name)) return entry;
  return setEntryValue(entry, ['segments'], [...entrySegments(entry), name] as unknown as JsonValue);
}
export function removeSegment(entry: MeshEntry, index: number): MeshEntry {
  const list = entrySegments(entry).filter((_, i) => i !== index);
  let out = setEntryValue(entry, ['segments'], list as unknown as JsonValue);
  // A rib keyed by a chain the segments no longer name would be refused (CONFIG_NAME_RESOLVES): it goes with it.
  const ribs = entryValue(out, ['ribs']), named = new Set(list.filter((s): s is string => typeof s === 'string'));
  if (isObject(ribs)) for (const chain of Object.keys(ribs)) if (!named.has(chain)) out = setEntryValue(out, ['ribs', chain], undefined);
  return out;
}
/** Ribs stations for one chain (null removes the chain's ribs). */
export const setRibs = (entry: MeshEntry, chain: string, stations: number | null): MeshEntry => setEntryValue(entry, ['ribs', chain], stations === null ? undefined : { stations });
/** The bone names a segment may name: the loaded model's bones, plus any string the entry already lists (a chain). */
export function segmentChoices(bones: readonly string[], entry: MeshEntry): string[] {
  const listed = entrySegments(entry).filter((s): s is string => typeof s === 'string');
  return [...new Set([...listed, ...bones])].sort((a, b) => a.localeCompare(b));
}

/**
 * The config loader's rules for one entry, each a line `CODE: config.meshes.<part>.<field> — <detail>` in the
 * loader's names. `bones`, when given, are the loaded model's bone names: a region bone outside them cannot be one
 * the config declares. Empty when nothing is refused here; the rig stage may still refuse, in its own words.
 */
export function precheckEntry(part: string, entry: unknown, bones: readonly string[] | null = null): string[] {
  const out: string[] = [], at = `config.meshes.${part}`;
  const fail = (code: string, path: string, detail: string) => out.push(`${code}: ${at}${path} — ${detail}`);
  if (!isObject(entry)) return [`CONFIG_FIELD_TYPE: ${at} — is not an object`];
  for (const key of Object.keys(entry)) if (!(ENTRY_KEYS as readonly string[]).includes(key)) fail('CONFIG_KEY_KNOWN', `.${key}`, 'is not a field of a mesh entry');
  const mode = meshMode(entry, part);
  if ('error' in mode) out.push(mode.error);
  if (!('influence' in entry)) for (const key of ['r', 'segments']) if (!(key in entry)) fail('CONFIG_FIELD_PRESENT', `.${key}`, 'is absent and required');
  if ('grid' in entry && !whole(entry.grid, 1)) fail('CONFIG_FIELD_TYPE', '.grid', `is ${JSON.stringify(entry.grid)}; a whole number, 1 or more, is required`);
  if ('r' in entry && !(finite(entry.r) && entry.r >= 0)) fail('CONFIG_FIELD_TYPE', '.r', `is ${JSON.stringify(entry.r)}; a non-negative number is required`);
  if ('exponent' in entry && !(finite(entry.exponent) && entry.exponent > 0)) fail('CONFIG_FIELD_TYPE', '.exponent', `is ${JSON.stringify(entry.exponent)}; a positive number is required`);
  if ('rule' in entry && !(RULES as readonly unknown[]).includes(entry.rule)) fail('CONFIG_FIELD_TYPE', '.rule', `is ${JSON.stringify(entry.rule)}; "distance" or "heat" is required`);
  if ('exponent' in entry && entry.rule === 'heat') fail('CONFIG_FIELD_TYPE', '.exponent', 'is declared beside rule "heat"; the exponent belongs to the distance rule — remove exponent, or declare rule "distance"');
  if ('segments' in entry) {
    if (!Array.isArray(entry.segments) || !entry.segments.length) fail('CONFIG_FIELD_TYPE', '.segments', 'a non-empty list is required');
    else entry.segments.forEach((s, i) => {
      if (typeof s === 'string' && s) return;
      const point = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(finite);
      if (Array.isArray(s) && s.length === 3 && typeof s[0] === 'string' && point(s[1]) && point(s[2])) {
        if (bones && !bones.includes(s[0])) fail('CONFIG_NAME_RESOLVES', `.segments[${i}][0]`, `names "${s[0]}", which is not a bone`);
        return;
      }
      fail('CONFIG_FIELD_TYPE', `.segments[${i}]`, 'a chain name, a bone name, or [bone, [x, y], [x, y]] is required');
    });
  }
  if ('ribs' in entry) {
    if ('grid' in entry) fail('CONFIG_RIBS_MODE', '.ribs', 'is declared on a lattice mesh (grid); ribs are placed by the contour and auto modes');
    const named = new Set((Array.isArray(entry.segments) ? entry.segments : []).filter((s): s is string => typeof s === 'string'));
    if (!isObject(entry.ribs) || !Object.keys(entry.ribs).length) fail('CONFIG_FIELD_TYPE', '.ribs', 'an object of chain name -> { stations } naming one or more chains is required');
    else for (const [chain, value] of Object.entries(entry.ribs)) {
      if (!named.has(chain)) fail('CONFIG_NAME_RESOLVES', `.ribs.${chain}`, `names "${chain}", which this mesh's segments do not name`);
      if (!isObject(value) || !whole(value.stations, 0)) fail('CONFIG_FIELD_TYPE', `.ribs.${chain}.stations`, 'a whole number, 0 or more, is required');
    }
  }
  if ('influences' in entry) {
    const l = entry.influences;
    if (!isObject(l) || (!('maxInfluences' in l) && !('floor' in l))) fail('CONFIG_FIELD_TYPE', '.influences', 'names neither maxInfluences nor floor');
    else {
      if ('maxInfluences' in l && l.maxInfluences !== null && !whole(l.maxInfluences, 1)) fail('CONFIG_FIELD_TYPE', '.influences.maxInfluences', `is ${JSON.stringify(l.maxInfluences)}; an integer at or above 1, or null, is required`);
      if ('floor' in l && !(FLOORS as readonly unknown[]).includes(l.floor)) fail('CONFIG_FIELD_TYPE', '.influences.floor', `is ${JSON.stringify(l.floor)}; "cut" or "continuous" is required`);
    }
  }
  if ('stray' in entry) {
    if ('contour' in entry && !('grid' in entry)) fail('CONFIG_STRAY_MODE', '.stray', 'is declared on a contour mesh; that mode states it in contour.stray');
    else if (!whole(entry.stray, 0)) fail('CONFIG_FIELD_TYPE', '.stray', 'a whole number, 0 or more, is required');
  }
  if ('contour' in entry) precheckContour(entry.contour, `${at}.contour`, bones, out);
  return out;
}
function precheckContour(v: JsonValue, at: string, bones: readonly string[] | null, out: string[]): void {
  const fail = (code: string, path: string, detail: string) => out.push(`${code}: ${at}${path} — ${detail}`);
  if (!isObject(v)) { out.push(`CONFIG_FIELD_TYPE: ${at} — an object is required`); return; }
  for (const key of Object.keys(v)) if (!(CONTOUR_KEYS as readonly string[]).includes(key)) fail('CONFIG_KEY_KNOWN', `.${key}`, 'is not a field of contour');
  for (const key of ['tolerance', 'margin', 'spacing']) if (!(key in v)) fail('CONFIG_FIELD_PRESENT', `.${key}`, 'is absent and required');
  if ('tolerance' in v && !(finite(v.tolerance) && v.tolerance >= 0)) fail('CONFIG_FIELD_TYPE', '.tolerance', `is ${JSON.stringify(v.tolerance)}; a non-negative number is required`);
  if ('margin' in v) {
    if (!(finite(v.margin) && v.margin >= 0)) fail('CONFIG_FIELD_TYPE', '.margin', `is ${JSON.stringify(v.margin)}; a non-negative number is required`);
    else if (v.margin > 0 && v.margin < 1) fail('CONFIG_FIELD_TYPE', '.margin', `is ${v.margin}; 0, or 1 px or more, is required`);
  }
  for (const key of ['spacing', 'maxEdge']) if (key in v && !(finite(v[key]) && (v[key] as number) > 0)) fail('CONFIG_FIELD_TYPE', `.${key}`, `is ${JSON.stringify(v[key])}; a positive number is required`);
  if ('budget' in v && !whole(v.budget, 3)) fail('CONFIG_FIELD_TYPE', '.budget', `is ${JSON.stringify(v.budget)}; a whole number, 3 or more, is required`);
  if ('stray' in v && !whole(v.stray, 0)) fail('CONFIG_FIELD_TYPE', '.stray', `is ${JSON.stringify(v.stray)}; a whole number, 0 or more, is required`);
  if ('bridges' in v && v.bridges !== true) fail('CONFIG_FIELD_TYPE', '.bridges', `is ${JSON.stringify(v.bridges)}; true is required — remove the field for the one-island rule`);
  if (!('regions' in v)) return;
  if (!Array.isArray(v.regions)) { fail('CONFIG_FIELD_TYPE', '.regions', 'a list is required'); return; }
  const names = new Set<string>();
  v.regions.forEach((rv, i) => {
    const rat = `.regions[${i}]`;
    if (!isObject(rv)) { fail('CONFIG_FIELD_TYPE', rat, 'an object is required'); return; }
    const grid = (path: string, n: unknown, positive: boolean | null) => {
      if (!finite(n) || (positive === true && n <= 0) || (positive === false && n < 0)) fail('CONFIG_FIELD_TYPE', path, `is ${JSON.stringify(n)}; a ${positive === true ? 'positive ' : positive === false ? 'non-negative ' : ''}number is required`);
      else if (!onGrid(n)) fail('CONFIG_FIELD_TYPE', path, `is ${n}; a multiple of 1/${MESH_GRID} px is required`);
    };
    if (typeof rv.name !== 'string' || !rv.name) fail('CONFIG_FIELD_TYPE', `${rat}.name`, 'a string is required');
    else if (names.has(rv.name)) fail('CONFIG_REGION_NAME_UNIQUE', `${rat}.name`, `"${rv.name}" is declared twice in this mesh; each region needs its own name`);
    else names.add(rv.name);
    if (typeof rv.bone !== 'string' || !rv.bone || (bones && !bones.includes(rv.bone))) fail('CONFIG_NAME_RESOLVES', `${rat}.bone`, `is ${JSON.stringify(rv.bone)}; a bone config.bones declares is required — the region's control bone`);
    if (!(finite(rv.spacing) && rv.spacing > 0)) fail('CONFIG_FIELD_TYPE', `${rat}.spacing`, `is ${JSON.stringify(rv.spacing)}; a positive number is required`);
    grid(`${rat}.band`, rv.band, false);
    if (rv.shape === 'circle') { grid(`${rat}.cx`, rv.cx, null); grid(`${rat}.cy`, rv.cy, null); grid(`${rat}.r`, rv.r, true); }
    else if (rv.shape === 'polygon') {
      if (!Array.isArray(rv.points) || rv.points.length < 3) fail('CONFIG_FIELD_TYPE', `${rat}.points`, `has ${Array.isArray(rv.points) ? rv.points.length : 0} point(s); 3 or more [x, y] in rig pixels are required`);
      else rv.points.forEach((p, k) => { if (!Array.isArray(p) || p.length !== 2) fail('CONFIG_FIELD_TYPE', `${rat}.points[${k}]`, '[x, y] is required'); else { grid(`${rat}.points[${k}][0]`, p[0], null); grid(`${rat}.points[${k}][1]`, p[1], null); } });
    } else fail('CONFIG_FIELD_TYPE', `${rat}.shape`, `is ${JSON.stringify(rv.shape)}; "circle" (with cx, cy, r) or "polygon" (with points) is required`);
  });
}

/** One differing field of the pending entry against the config's: its pointer inside the entry and both values. */
export interface EntryChange { path: string; before: JsonValue | undefined; after: JsonValue | undefined }
const at = (doc: JsonValue, pointer: string): JsonValue | undefined => {
  let v: JsonValue | undefined = doc;
  for (const t of parsePointer(pointer)) v = Array.isArray(v) ? v[Number(t)] : isObject(v) && Object.hasOwn(v, t) ? v[t] : undefined;
  return v;
};
export function entryChanges(config: MeshEntry, pending: MeshEntry): EntryChange[] {
  return jsonDiff(config, pending).map(path => ({ path, before: at(config, path), after: at(pending, path) }));
}

/**
 * Bar 3 (#106): the submitted patch is one op, `replace /meshes/<part>` with the whole pending entry, run by `remesh
 * --part <part>`. Nothing else in the config moves: the server's `remeshPart` already holds every op under
 * `/meshes/<part>`, and this holds the patch to that one path.
 */
export function meshPatchOps(part: string, entry: MeshEntry): PatchOp[] {
  return [{ op: 'replace', path: `/meshes/${pointerToken(part)}`, value: structuredClone(entry) }];
}
export function assertMeshPatch(patch: Pick<ConfigPatch, 'ops' | 'op'>, part: string): void {
  const path = `/meshes/${pointerToken(part)}`;
  if (patch.op.cmd !== 'remesh' || patch.op.args[patch.op.args.indexOf('--part') + 1] !== part) throw new MeshEntryError('MESH_PATCH_SCOPE', `a mesh patch runs remesh --part ${part}`);
  if (patch.ops.length !== 1 || patch.ops[0]!.path !== path || patch.ops[0]!.op !== 'replace') throw new MeshEntryError('MESH_PATCH_SCOPE', `a mesh patch is one op, replace ${path}; this one has ${patch.ops.length}: ${patch.ops.map(o => `${o.op} ${o.path}`).join(', ')}`);
}
/** Every config pointer the patch changes (applied to the config it was made against). */
export const patchChangedPaths = (config: JsonValue, ops: readonly PatchOp[]) => jsonDiff(config, applyConfigPatch(config, ops));

/** `remesh.json`'s part counts (spec `rig-parts-remesh/1`, `target.before` / `target.after`). */
export interface MeshCounts { vertices: number; triangles: number; hull: number }
export interface RemeshCounts { part: string; before: MeshCounts; after: MeshCounts }
const counts = (v: unknown): MeshCounts | null => (isObject(v) && whole(v.vertices, 0) && whole(v.triangles, 0) && whole(v.hull, 0) ? { vertices: v.vertices as number, triangles: v.triangles as number, hull: v.hull as number } : null);
/** The part and its before/after counts, or null when the document does not carry them in that shape. */
export function remeshCounts(doc: unknown): RemeshCounts | null {
  if (!isObject(doc) || doc.spec !== 'rig-parts-remesh/1' || !isObject(doc.target) || !isObject(doc.request) || typeof doc.request.part !== 'string') return null;
  const before = counts(doc.target.before), after = counts(doc.target.after);
  return before && after ? { part: doc.request.part, before, after } : null;
}
export const countsText = (c: MeshCounts) => `v ${c.vertices} · t ${c.triangles} · hull ${c.hull}`;
/**
 * The triangles of a slot's mesh attachment in a compiled model (`rigc-compiled/3`: `skins[].attachments.<slot>.<name>`
 * with `kind: "mesh"` and a flat `triangles` index list): the attachment named like the slot when there is one, else
 * the slot's only mesh attachment. Null when the slot draws no mesh.
 */
export function modelMeshTriangles(model: unknown, slot: string): number | null {
  const skins = isObject(model) && Array.isArray(model.skins) ? model.skins : [];
  const found: { name: string; triangles: number }[] = [];
  for (const skin of skins) {
    const attachments = isObject(skin) && isObject(skin.attachments) ? skin.attachments[slot] : undefined;
    if (!isObject(attachments)) continue;
    for (const [name, a] of Object.entries(attachments)) if (isObject(a) && a.kind === 'mesh' && Array.isArray(a.triangles)) found.push({ name, triangles: a.triangles.length / 3 });
  }
  return (found.find(f => f.name === slot) ?? (found.length === 1 ? found[0] : undefined))?.triangles ?? null;
}
/**
 * Bar 1 (#106): the revision's triangle count — the compiled model's attachment — equals `remesh.json`'s after-count,
 * and the overlay draws that many triangles for the slot. Each figure is shown; a missing one is said by name.
 */
export function triangleAgreement(remesh: RemeshCounts | null, model: number | null, overlay: number | null): { ok: boolean; line: string } {
  if (!remesh) return { ok: false, line: 'MESH_COUNTS_UNAVAILABLE: remesh.json carries no part counts' };
  const after = remesh.after.triangles, show = (n: number | null) => (n === null ? 'not read' : String(n));
  const ok = model === after && overlay === after;
  return { ok, line: `${ok ? 'MESH_COUNTS_AGREE' : 'MESH_COUNTS_DIFFER'}: remesh.json after t ${after} · revision model t ${show(model)} · overlay draws ${show(overlay)} triangle(s) on ${remesh.part}` };
}

/** What the panel says after an Apply: the producer's line verbatim on a refusal (bar 2), the counts on a build. */
export function meshApplyOutcome(result: { status: string; error?: string; producerLine?: string | null; exitCode?: number | null; remesh?: RemeshCounts | null; id?: string }): { text: string; error: boolean } {
  if (result.status !== 'built') return { text: result.producerLine ?? result.error ?? `REBUILD_FAILED: exit ${result.exitCode ?? '?'}`, error: true };
  const c = result.remesh;
  return { text: c ? `Remeshed ${c.part}: ${countsText(c.before)} → ${countsText(c.after)} (remesh.json) · Reset returns to the inspected build` : 'Remeshed · remesh.json carries no part counts', error: false };
}

/** The draft the panel keeps (`#mesh-pending`): the part and its pending entry, or null. */
export interface MeshDraft { schema: typeof MESH_PANEL_SCHEMA; part: string; entry: MeshEntry }
export const meshDraftText = (draft: MeshDraft | null) => (draft ? JSON.stringify(draft) : '');
export function parseMeshDraft(text: string): MeshDraft | null {
  try {
    const v = JSON.parse(text) as unknown;
    return isObject(v) && v.schema === MESH_PANEL_SCHEMA && typeof v.part === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.part) && isObject(v.entry) ? { schema: MESH_PANEL_SCHEMA, part: v.part, entry: v.entry } : null;
  } catch { return null; }
}
