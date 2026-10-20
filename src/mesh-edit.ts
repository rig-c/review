/**
 * Mesh edit (Setup): a typed delta over the actual loaded mesh attachment of one slot. Pure — no DOM, no I/O.
 *
 * The source is the attachment the hash-verified model declares, with its vertices taken from the last drawn pose of
 * that slot and mapped to crop pixels (x right, y down) through the same crop mapping as the chest regions. Ops are
 * recorded in order; nothing is retriangulated here — the preview draws the delta over the original triangulation and
 * the producer (#45) owns the mesher. Vertex ids are stable: the source vertices keep their indices, an added vertex
 * takes the next id after every vertex that existed before it, and a removed vertex keeps its id (it is only marked).
 */
/** Edit Mesh's Apply · Rebuild: no producer command consumes a vertex delta, so it refuses by name and runs nothing. */
export const MODELING_TARGET_UNSUPPORTED = 'MODELING_TARGET_UNSUPPORTED: the producer has no delta operation (parts); export the delta';
export type Vec = [number, number];
export type MeshOp =
  | { op: 'move'; v: number; from: Vec; to: Vec }
  | { op: 'add'; at: Vec; onEdge?: [number, number] }
  | { op: 'remove'; v: number }
  | { op: 'edge'; a: number; b: number }
  | { op: 'unedge'; a: number; b: number };
export type EdgeKind = 'hull' | 'interior' | 'constraint';
export interface MeshEdge { a: number; b: number; kind: EdgeKind }
export interface MeshSource {
  slot: string; skin: string; attachment: string;
  /** Crop px, x right, y down, one per source vertex. */
  vertices: readonly Vec[];
  triangles: readonly number[];
  /** The model's `hull`: the first `hull` vertices, in order, are the hull. */
  hull: number;
  /** SHA-256 of the attachment's entry in the hash-verified model (see `attachmentHashText`). */
  hash: string;
}
export interface MeshView {
  /** Current position per vertex id; null when removed. */
  vertices: (Vec | null)[];
  edges: MeshEdge[];
  /** Edges the delta removed (explicitly, or with a removed vertex), for the preview. */
  removedEdges: MeshEdge[];
  added: Set<number>;
  /** Moved vertex id → its source (or creation) position. */
  moved: Map<number, Vec>;
  removed: Set<number>;
}
export type MeshEditResult = { ok: true; changed: boolean; code?: string } | { ok: false; code: string };

export const MESH_EDIT_SCHEMA = 'rig-review-mesh-edit/1';
export const MESH_EDIT_BINDING_SCHEMA = 'rig-review-mesh-edit-binding/1';
export const MESH_EDIT_DRAFT_SCHEMA = 'rig-review-mesh-edit-draft/1';
export const MESH_EDIT_SELECT_SLOT = 'MESH_EDIT_SELECT_SLOT';
export const MESH_EDIT_NO_MESH = 'MESH_EDIT_NO_MESH';
export const MESH_EDIT_HULL_EDGE = 'MESH_EDIT_HULL_EDGE';
export const MESH_EDIT_EDGE_EXISTS = 'MESH_EDIT_EDGE_EXISTS';
export const MESH_EDIT_TRIANGULATION_EDGE = 'MESH_EDIT_TRIANGULATION_EDGE';
export const MESH_EDIT_INVALID_OP = 'MESH_EDIT_INVALID_OP';
export const MESH_EDIT_OPS_LIMIT = 'MESH_EDIT_OPS_LIMIT';
/** The draft rides in one form field (≤ 32768 characters), so the delta is bounded. */
export const MESH_EDIT_MAX_OPS = 300;
export const MESH_EDIT_PREVIEW_NOTE = 'preview only — the producer retriangulates';
/** Screen-space hit radii in CSS px. */
export const MESH_HIT = Object.freeze({ vertex: 6, vertexTouch: 8, edge: 4 });

const round = (value: number) => Math.round(value * 100) / 100;
export const roundVec = (p: { x: number; y: number } | Vec): Vec => Array.isArray(p) ? [round(p[0]), round(p[1])] : [round(p.x), round(p.y)];
export const edgeKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
const isHullPair = (a: number, b: number, hull: number) => a < hull && b < hull && (Math.abs(a - b) === 1 || Math.abs(a - b) === hull - 1) && hull > 2;

/** The original triangulation's unique edges; consecutive hull vertices (and the closing pair) are hull edges. */
export function sourceEdges(source: Pick<MeshSource, 'triangles' | 'hull' | 'vertices'>): MeshEdge[] {
  const seen = new Map<string, MeshEdge>(), n = source.vertices.length;
  const add = (a: number, b: number) => { if (a === b || a < 0 || b < 0 || a >= n || b >= n) return; const key = edgeKey(a, b); if (!seen.has(key)) seen.set(key, { a: Math.min(a, b), b: Math.max(a, b), kind: isHullPair(a, b, source.hull) ? 'hull' : 'interior' }); };
  for (let i = 0; i + 2 < source.triangles.length; i += 3) { const t = source.triangles; add(t[i]!, t[i + 1]!); add(t[i + 1]!, t[i + 2]!); add(t[i + 2]!, t[i]!); }
  for (let i = 0; i < source.hull && source.hull > 2; i++) add(i, (i + 1) % source.hull);
  return [...seen.values()];
}

const finiteVec = (v: unknown): v is Vec => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
const index = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Replays ops over the source. Throws `MESH_EDIT_INVALID_OP` naming the first op that does not apply. */
export function applyMeshOps(source: MeshSource, ops: readonly MeshOp[]): MeshView {
  const view: MeshView = { vertices: source.vertices.map(v => [v[0], v[1]] as Vec), edges: [], removedEdges: [], added: new Set(), moved: new Map(), removed: new Set() };
  const edges = new Map(sourceEdges(source).map(e => [edgeKey(e.a, e.b), { ...e }]));
  const fail = (i: number, why: string): never => { throw new Error(`${MESH_EDIT_INVALID_OP}: op ${i} ${why}`); };
  const live = (v: unknown, i: number): number => { if (!index(v) || v >= view.vertices.length || !view.vertices[v]) fail(i, `names no live vertex ${String(v)}`); return v as number; };
  const removeEdge = (key: string) => { const edge = edges.get(key); if (edge) { edges.delete(key); view.removedEdges.push(edge); } };
  ops.forEach((op, i) => {
    switch (op?.op) {
      case 'move': {
        const v = live(op.v, i); if (!finiteVec(op.from) || !finiteVec(op.to)) fail(i, 'needs finite from/to');
        if (!view.moved.has(v)) view.moved.set(v, [...view.vertices[v]!] as Vec);
        view.vertices[v] = [op.to[0], op.to[1]]; break;
      }
      case 'add': {
        if (!finiteVec(op.at)) fail(i, 'needs a finite at');
        const id = view.vertices.length;
        if (op.onEdge !== undefined) {
          if (!Array.isArray(op.onEdge) || op.onEdge.length !== 2) fail(i, 'onEdge must be a pair');
          const [a, b] = [live(op.onEdge![0], i), live(op.onEdge![1], i)], key = edgeKey(a, b), edge = edges.get(key);
          if (!edge) fail(i, `splits a missing edge ${a}-${b}`);
          edges.delete(key); view.vertices.push([op.at[0], op.at[1]]);
          edges.set(edgeKey(a, id), { a: Math.min(a, id), b: Math.max(a, id), kind: edge!.kind });
          edges.set(edgeKey(id, b), { a: Math.min(b, id), b: Math.max(b, id), kind: edge!.kind });
        } else view.vertices.push([op.at[0], op.at[1]]);
        view.added.add(id); break;
      }
      case 'remove': {
        const v = live(op.v, i); view.vertices[v] = null; view.removed.add(v); view.moved.delete(v);
        for (const [key, edge] of [...edges]) if (edge.a === v || edge.b === v) removeEdge(key);
        break;
      }
      case 'edge': {
        const a = live(op.a, i), b = live(op.b, i); if (a === b) fail(i, 'joins a vertex to itself');
        if (edges.has(edgeKey(a, b))) fail(i, `duplicates edge ${a}-${b}`);
        edges.set(edgeKey(a, b), { a: Math.min(a, b), b: Math.max(a, b), kind: 'constraint' }); break;
      }
      case 'unedge': {
        const a = live(op.a, i), b = live(op.b, i), edge = edges.get(edgeKey(a, b));
        if (!edge) fail(i, `removes a missing edge ${a}-${b}`); if (edge!.kind === 'hull') fail(i, `removes hull edge ${a}-${b}`);
        removeEdge(edgeKey(a, b)); break;
      }
      default: fail(i, 'has an unknown op');
    }
  });
  view.edges = [...edges.values()];
  return view;
}

/** The ordered delta with per-action undo/redo. One user action (a drag of an edge or of a multi-selection) is one step of one or more ops. */
export class MeshEditSession {
  private list: MeshOp[] = [];
  private steps: number[] = [];
  private redoSteps: MeshOp[][] = [];
  private current: MeshView;
  constructor(readonly source: MeshSource, ops: readonly MeshOp[] = []) {
    this.current = applyMeshOps(source, ops); this.list = ops.map(op => structuredClone(op)); this.steps = this.list.map(() => 1);
  }
  ops(): MeshOp[] { return this.list.map(op => structuredClone(op)); }
  view(): MeshView { return this.current; }
  canUndo(): boolean { return this.steps.length > 0; }
  canRedo(): boolean { return this.redoSteps.length > 0; }
  /** Records one step; refuses the whole step when any op does not apply. */
  record(ops: readonly MeshOp[]): MeshEditResult {
    if (!ops.length) return { ok: true, changed: false };
    if (this.list.length + ops.length > MESH_EDIT_MAX_OPS) return { ok: false, code: `${MESH_EDIT_OPS_LIMIT}: at most ${MESH_EDIT_MAX_OPS} ops per attachment — download and reset to continue` };
    let next: MeshView;
    try { next = applyMeshOps(this.source, [...this.list, ...ops]); } catch (error) { return { ok: false, code: error instanceof Error ? error.message : String(error) }; }
    this.list.push(...ops.map(op => structuredClone(op))); this.steps.push(ops.length); this.redoSteps = []; this.current = next;
    return { ok: true, changed: true };
  }
  undo(): boolean {
    const count = this.steps.pop(); if (count === undefined) return false;
    this.redoSteps.push(this.list.splice(this.list.length - count, count));
    this.current = applyMeshOps(this.source, this.list); return true;
  }
  redo(): boolean {
    const ops = this.redoSteps.pop(); if (!ops) return false;
    this.list.push(...ops); this.steps.push(ops.length); this.current = applyMeshOps(this.source, this.list); return true;
  }
  reset(): void { this.list = []; this.steps = []; this.redoSteps = []; this.current = applyMeshOps(this.source, []); }

  /** Moves vertices by a crop-px offset from their positions at `base` (the drag's start view): one move op per vertex. */
  moveOps(ids: readonly number[], dx: number, dy: number, base: MeshView = this.current): MeshOp[] {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return [];
    return [...new Set(ids)].flatMap(v => { const from = base.vertices[v]; if (!from) return []; const to = roundVec([from[0] + dx, from[1] + dy]); return to[0] === from[0] && to[1] === from[1] ? [] : [{ op: 'move' as const, v, from: [from[0], from[1]] as Vec, to }]; });
  }
  /** Create: a vertex on empty space, or a split of an edge at the click point. */
  addVertex(at: Vec, onEdge?: [number, number]): MeshEditResult { return this.record([{ op: 'add', at: roundVec(at), ...(onEdge ? { onEdge: [onEdge[0], onEdge[1]] as [number, number] } : {}) }]); }
  /** Delete on a vertex: the vertex and its edges. */
  removeVertex(v: number): MeshEditResult { return this.record([{ op: 'remove', v }]); }
  /** Delete on an edge: any edge but a hull edge. */
  deleteEdge(a: number, b: number): MeshEditResult {
    const edge = this.findEdge(a, b); if (!edge) return { ok: false, code: `${MESH_EDIT_INVALID_OP}: no edge ${a}-${b}` };
    if (edge.kind === 'hull') return { ok: false, code: `${MESH_EDIT_HULL_EDGE}: ${a}-${b} is a hull edge and cannot be removed` };
    return this.record([{ op: 'unedge', a, b }]);
  }
  /**
   * Edges mode on a pair: a new pair adds a constraint edge; an existing constraint edge is removed; a hull edge is
   * refused; any other existing edge is a duplicate and records nothing.
   */
  toggleConstraint(a: number, b: number): MeshEditResult {
    if (a === b) return { ok: true, changed: false };
    const edge = this.findEdge(a, b);
    if (!edge) return this.record([{ op: 'edge', a, b }]);
    if (edge.kind === 'hull') return { ok: false, code: `${MESH_EDIT_HULL_EDGE}: ${a}-${b} is a hull edge and cannot be removed` };
    if (edge.kind === 'constraint') return this.record([{ op: 'unedge', a, b }]);
    return { ok: true, changed: false, code: `${MESH_EDIT_EDGE_EXISTS}: ${a}-${b} is already a triangulation edge` };
  }
  findEdge(a: number, b: number): MeshEdge | undefined { const key = edgeKey(a, b); return this.current.edges.find(e => edgeKey(e.a, e.b) === key); }
}

export interface ScreenPoint { x: number; y: number }
export type MeshHit = { kind: 'vertex'; v: number } | { kind: 'edge'; a: number; b: number; t: number; at: ScreenPoint };
/** Screen-space hit test: the nearest vertex within the radius wins over any edge; then the nearest edge within 4 px. */
export function hitMesh(points: readonly (ScreenPoint | null)[], edges: readonly Pick<MeshEdge, 'a' | 'b'>[], p: ScreenPoint, touch = false): MeshHit | null {
  const radius = touch ? MESH_HIT.vertexTouch : MESH_HIT.vertex;
  let best: MeshHit | null = null, bestDistance = Infinity;
  points.forEach((q, v) => { if (!q) return; const d = Math.hypot(p.x - q.x, p.y - q.y); if (d <= radius && d < bestDistance) { best = { kind: 'vertex', v }; bestDistance = d; } });
  if (best) return best;
  for (const edge of edges) {
    const a = points[edge.a], b = points[edge.b]; if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy; if (length === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)), at = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= MESH_HIT.edge && d < bestDistance) { best = { kind: 'edge', a: edge.a, b: edge.b, t, at }; bestDistance = d; }
  }
  return best;
}
/** Vertex ids inside a screen rectangle (any corner order). */
export function verticesInBox(points: readonly (ScreenPoint | null)[], from: ScreenPoint, to: ScreenPoint): number[] {
  const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)], [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  return points.flatMap((p, v) => p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 ? [v] : []);
}

/** A 2D affine map x' = a x + c y + e, y' = b x + d y + f. */
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }
/** Samples an affine function at three points. */
export function affineOf(fn: (x: number, y: number) => ScreenPoint): Affine {
  const o = fn(0, 0), x = fn(1, 0), y = fn(0, 1);
  return { a: x.x - o.x, b: x.y - o.y, c: y.x - o.x, d: y.y - o.y, e: o.x, f: o.y };
}
export function invertAffine(m: Affine): Affine | null {
  const det = m.a * m.d - m.b * m.c; if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}
export const applyAffine = (m: Affine, x: number, y: number): ScreenPoint => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
/** A screen-px offset as a crop-px offset through the inverse of crop → screen. */
export function screenDeltaToCrop(cropToScreen: Affine, dx: number, dy: number): Vec | null {
  const inverse = invertAffine(cropToScreen); if (!inverse) return null;
  return [inverse.a * dx + inverse.c * dy, inverse.b * dx + inverse.d * dy];
}

/** The text hashed for `source.hash`: the attachment's entry from the hash-verified model, as `JSON.stringify` writes it. */
export const attachmentHashText = (entry: unknown) => JSON.stringify(entry);

export interface MeshEditDocument {
  schema: typeof MESH_EDIT_SCHEMA;
  slot: string; skin: string; attachment: string;
  source: { vertexCount: number; triangleCount: number; hullLength: number; hash: string };
  units: string; basis: string; preview: string;
  ops: MeshOp[];
}
export function meshEditDocument(session: MeshEditSession, basis: string): MeshEditDocument {
  const s = session.source;
  return {
    schema: MESH_EDIT_SCHEMA, slot: s.slot, skin: s.skin, attachment: s.attachment,
    source: { vertexCount: s.vertices.length, triangleCount: Math.floor(s.triangles.length / 3), hullLength: s.hull, hash: s.hash },
    units: 'crop px, x right, y down; vertex ids are source indices, added vertices take the next id in op order, removed ids are not reused',
    basis, preview: `${MESH_EDIT_PREVIEW_NOTE}; the ops are a request over the original triangulation, not a mesh`,
    ops: session.ops(),
  };
}
export function meshEditBinding(input: { fileSha256: string; sourceHash: string; reviewedSource: { viewerVersion: string; runtimeVersion: string; rig: { sha256: string } | null; motion: { sha256: string } | null }; exportedAt: string; mapping: string; attachment: { slot: string; skin: string; name: string; sha256: string } }) {
  return {
    schema: MESH_EDIT_BINDING_SCHEMA,
    file: { name: 'mesh-edit.json', sha256: input.fileSha256 },
    package: input.sourceHash,
    model: input.reviewedSource.rig?.sha256 ?? null,
    motion: input.reviewedSource.motion?.sha256 ?? null,
    attachment: { ...input.attachment },
    exportedAt: input.exportedAt,
    tools: { viewerVersion: input.reviewedSource.viewerVersion, runtimeVersion: input.reviewedSource.runtimeVersion },
    mapping: input.mapping,
    evidence: 'Mesh edit is review evidence, not an approval. Nothing was written into the package; retriangulation and regeneration are the producer path.',
  };
}

/** Draft: per attachment, the ops bound to the attachment hash. A draft for another hash is not restored. */
export interface MeshEditDraft { schema: typeof MESH_EDIT_DRAFT_SCHEMA; entries: Record<string, { hash: string; ops: MeshOp[] }> }
export const draftKey = (s: Pick<MeshSource, 'slot' | 'skin' | 'attachment'>) => `${s.skin}/${s.slot}/${s.attachment}`;
export function parseMeshDraft(text: string): MeshEditDraft {
  const empty: MeshEditDraft = { schema: MESH_EDIT_DRAFT_SCHEMA, entries: {} };
  if (!text.trim()) return empty;
  let value: unknown; try { value = JSON.parse(text); } catch { return empty; }
  const o = value as Partial<MeshEditDraft> | null;
  if (!o || typeof o !== 'object' || o.schema !== MESH_EDIT_DRAFT_SCHEMA || !o.entries || typeof o.entries !== 'object' || Array.isArray(o.entries)) return empty;
  const entries: MeshEditDraft['entries'] = {};
  for (const [key, entry] of Object.entries(o.entries)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !entry || typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || !Array.isArray(entry.ops) || entry.ops.length > MESH_EDIT_MAX_OPS) continue;
    entries[key] = { hash: entry.hash, ops: entry.ops as MeshOp[] };
  }
  return { schema: MESH_EDIT_DRAFT_SCHEMA, entries };
}
/** Ops a draft holds for this source, or null when the draft has none or names another hash / an op that does not apply. */
export function draftOps(draft: MeshEditDraft, source: MeshSource): MeshOp[] | null {
  const entry = draft.entries[draftKey(source)]; if (!entry || entry.hash !== source.hash) return null;
  try { applyMeshOps(source, entry.ops); return entry.ops; } catch { return null; }
}
export function writeMeshDraft(draft: MeshEditDraft, source: MeshSource, ops: readonly MeshOp[]): string {
  const entries = { ...draft.entries }; const key = draftKey(source);
  if (ops.length) entries[key] = { hash: source.hash, ops: ops.map(op => structuredClone(op)) }; else delete entries[key];
  return Object.keys(entries).length ? JSON.stringify({ schema: MESH_EDIT_DRAFT_SCHEMA, entries }) : '';
}
