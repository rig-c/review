/**
 * Chest-region designation (`family-chest-regions/1`): pure geometry, validation and the exact JSON text the
 * public generator's example files use. No DOM, no filesystem. Review designates and exports these values as
 * evidence; regenerating a mesh from them is the producer path, never this module.
 */

/** The generator's coordinate grid: every point is a multiple of 1/256 crop pixel. */
export const CHEST_REGION_GRID = 256;
export const CHEST_REGIONS_SPEC = 'family-chest-regions/1';

export type CropPoint = [number, number];
export type ChestSegment = string | [string, [number, number], [number, number]];
export interface ChestRegion { name: string; bone: string; shape: 'polygon'; points: CropPoint[]; spacing: number; band: number }
export interface ChestContour { tolerance: number; margin: number; spacing: number; maxEdge: number; stray: number; bridges: boolean; regions: ChestRegion[] }
export interface ChestMesh { contour: ChestContour; r?: number; segments?: ChestSegment[] }
export interface ChestRegionsDocument {
  spec: typeof CHEST_REGIONS_SPEC;
  coordinates: string;
  publicGenerator: string;
  mesh: { name: string; value: ChestMesh };
  sourceRule?: string;
}

export interface ChestRegionInput {
  name: string;
  bone: string;
  center: [number, number];
  semiAxes: [number, number];
  spacing: number;
  band: number;
  /** Medial clip line x: the polygon side toward this x stops at it (x ≤ clip when clip > centre x, x ≥ clip when clip < centre x). */
  clip?: number;
}
export interface ChestRegionsInput {
  crop: { w: number; h: number };
  generator: string;
  mesh?: string;
  contour: Omit<ChestContour, 'regions'>;
  regions: ChestRegionInput[];
  r?: number;
  segments?: unknown;
  sourceRule?: string;
  /** The loaded model's bone names; when present every region bone must be one of them. */
  bones?: readonly string[] | null;
}

export class ChestRegionError extends Error {
  constructor(readonly code: string, detail: string) { super(`${code} ${detail}`.trim()); }
}

const quantize = (value: number): number => { const q = Math.round(value * CHEST_REGION_GRID) / CHEST_REGION_GRID; return q === 0 ? 0 : q; };
const onGrid = (value: number): boolean => Number.isInteger(value * CHEST_REGION_GRID);

/**
 * The 32-sample ellipse the examples encode: sample i at angle θ = 2πi/samples, starting at +x (screen-right)
 * and turning toward +y (down, crop pixels), each coordinate rounded to the nearest 1/256 pixel. A clip x
 * (on the grid) then stops the side that faces it.
 */
export function ellipsePolygon(center: [number, number], semiAxes: [number, number], samples = 32, clip?: number): CropPoint[] {
  const [cx, cy] = center, [ax, ay] = semiAxes, points: CropPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const angle = 2 * Math.PI * i / samples;
    let x = quantize(cx + ax * Math.cos(angle));
    const y = quantize(cy + ay * Math.sin(angle));
    if (clip !== undefined) x = clip > cx ? Math.min(x, clip) : Math.max(x, clip);
    points.push([x, y]);
  }
  return points;
}

function finite(value: unknown, region: string, field: string, min: number, inclusive = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (inclusive ? value < min : value <= min)) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', `${region} ${field}`);
  return value;
}

function pointSegmentDistance(p: CropPoint, a: CropPoint, b: CropPoint): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const cross = (o: CropPoint, a: CropPoint, b: CropPoint) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsCross(a: CropPoint, b: CropPoint, c: CropPoint, d: CropPoint): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function inside(p: CropPoint, polygon: CropPoint[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
/** Distance between two closed polygons; 0 when their edges cross or one contains the other. */
export function polygonDistance(a: CropPoint[], b: CropPoint[]): number {
  if (inside(a[0]!, b) || inside(b[0]!, a)) return 0;
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!, a1 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j]!, b1 = b[(j + 1) % b.length]!;
      if (segmentsCross(a0, a1, b0, b1)) return 0;
      best = Math.min(best, pointSegmentDistance(a0, b0, b1), pointSegmentDistance(a1, b0, b1), pointSegmentDistance(b0, a0, a1), pointSegmentDistance(b1, a0, a1));
    }
  }
  return best;
}

/**
 * Review's pre-check for the generator's no-overlap rule: two regions are refused when their supports (polygon
 * grown by its band) overlap, i.e. polygon distance < bandA + bandB. The generator itself refuses per mesh
 * vertex (`RIG_CONTOUR_REGIONS_OVERLAP`, a vertex weighted by two falloffs); without a mesh this geometric test
 * is the stricter side of that rule: it can refuse a pair the generator would accept, never the reverse.
 */
export function regionsOverlap(a: { points: CropPoint[]; band: number }, b: { points: CropPoint[]; band: number }): boolean {
  return polygonDistance(a.points, b.points) < a.band + b.band;
}

function coordinatesText(crop: { w: number; h: number }, regions: ChestRegionInput[]): string {
  const [left, right] = [...regions].sort((a, b) => a.center[0] - b.center[0]);
  return `${crop.w}x${crop.h} crop pixels, x screen-right and y down; ${left!.bone} screen-left, ${right!.bone} screen-right`;
}

function segmentList(value: unknown): ChestSegment[] {
  if (!Array.isArray(value)) throw new ChestRegionError('CHEST_SEGMENTS_INVALID', 'expected an array');
  const point = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));
  return value.map((item: unknown, i) => {
    if (typeof item === 'string' && item) return item;
    if (Array.isArray(item) && item.length === 3 && typeof item[0] === 'string' && item[0] && point(item[1]) && point(item[2])) return [item[0], [item[1][0], item[1][1]], [item[2][0], item[2][1]]] as ChestSegment;
    throw new ChestRegionError('CHEST_SEGMENTS_INVALID', `segments[${i}]`);
  });
}

export function buildChestRegions(input: ChestRegionsInput): ChestRegionsDocument {
  const w = finite(input.crop?.w, 'crop', 'w', 0, false), h = finite(input.crop?.h, 'crop', 'h', 0, false);
  if (typeof input.generator !== 'string' || !input.generator.trim()) throw new ChestRegionError('CHEST_REGIONS_GENERATOR_MISSING', '');
  if (input.regions.length !== 2) throw new ChestRegionError('CHEST_REGIONS_COUNT', String(input.regions.length));
  const c = input.contour;
  for (const field of ['tolerance', 'margin', 'spacing', 'maxEdge', 'stray'] as const) finite(c[field], 'contour', field, 0);
  if (typeof c.bridges !== 'boolean') throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', 'contour bridges');
  const names = new Set<string>(), regions: ChestRegion[] = [];
  for (const region of input.regions) {
    const name = region.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', `${String(name)} name`);
    if (names.has(name)) throw new ChestRegionError('CHEST_REGION_NAME_DUPLICATE', name);
    names.add(name);
    if (typeof region.bone !== 'string' || !region.bone) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', `${name} bone`);
    if (input.bones && !input.bones.includes(region.bone)) throw new ChestRegionError('CHEST_REGION_BONE_UNKNOWN', region.bone);
    const cx = finite(region.center?.[0], name, 'center x', -Infinity), cy = finite(region.center?.[1], name, 'center y', -Infinity);
    const ax = finite(region.semiAxes?.[0], name, 'semi-axis x', 0, false), ay = finite(region.semiAxes?.[1], name, 'semi-axis y', 0, false);
    const spacing = finite(region.spacing, name, 'spacing', 0, false), band = finite(region.band, name, 'band', 0);
    if (region.clip !== undefined) finite(region.clip, name, 'clip', -Infinity);
    for (const [field, value] of [['center x', cx], ['center y', cy], ['band', band], ...(region.clip === undefined ? [] : [['clip', region.clip]])] as [string, number][]) {
      if (!onGrid(value)) throw new ChestRegionError('CHEST_REGION_OFF_GRID', `${name} ${field}`);
    }
    const points = ellipsePolygon([cx, cy], [ax, ay], 32, region.clip);
    if (points.some(([x, y]) => x < 0 || y < 0 || x > w || y > h)) throw new ChestRegionError('CHEST_REGION_OUT_OF_CROP', name);
    regions.push({ name, bone: region.bone, shape: 'polygon', points, spacing, band });
  }
  if (regionsOverlap(regions[0]!, regions[1]!)) throw new ChestRegionError('CHEST_REGIONS_OVERLAP', `${regions[0]!.name} ${regions[1]!.name}`);
  const mesh: ChestMesh = { contour: { tolerance: c.tolerance, margin: c.margin, spacing: c.spacing, maxEdge: c.maxEdge, stray: c.stray, bridges: c.bridges, regions } };
  if (input.r !== undefined) mesh.r = finite(input.r, 'mesh', 'r', 0);
  if (input.segments !== undefined) mesh.segments = segmentList(input.segments);
  const meshName = input.mesh ?? 'topwear';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meshName)) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', 'mesh name');
  return { spec: CHEST_REGIONS_SPEC, coordinates: coordinatesText({ w, h }, input.regions), publicGenerator: input.generator, mesh: { name: meshName, value: mesh }, ...(input.sourceRule ? { sourceRule: input.sourceRule } : {}) };
}

/** Python-style JSON text (`json.dumps(value, indent=2)` + newline), the examples' exact formatting; `{float}` marks a Python float. */
type Emit = { float: number } | number | string | boolean | Emit[] | { [key: string]: Emit };
const isFloat = (v: unknown): v is { float: number } => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'float' in v;
function numberText(value: number, float: boolean): string {
  if (!Number.isFinite(value)) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', 'non-finite number');
  const v = value === 0 ? 0 : value, text = String(v);
  if (/e/i.test(text)) throw new ChestRegionError('CHEST_REGION_VALUE_INVALID', `number ${text} needs exponent notation`);
  return float && Number.isInteger(v) ? `${text}.0` : text;
}
const stringText = (value: string) => JSON.stringify(value).replace(/[\u007f-￿]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
function emit(value: Emit, depth: number): string {
  const pad = '  '.repeat(depth + 1), close = '  '.repeat(depth);
  if (isFloat(value)) return numberText(value.float, true);
  if (typeof value === 'number') return numberText(value, false);
  if (typeof value === 'string') return stringText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length ? `[\n${value.map(v => pad + emit(v, depth + 1)).join(',\n')}\n${close}]` : '[]';
  const entries = Object.entries(value);
  return entries.length ? `{\n${entries.map(([k, v]) => `${pad}${stringText(k)}: ${emit(v, depth + 1)}`).join(',\n')}\n${close}}` : '{}';
}

export function serializeChestRegions(doc: ChestRegionsDocument): string {
  const mesh = doc.mesh.value, contour = mesh.contour;
  const value: { [key: string]: Emit } = {
    spec: doc.spec,
    coordinates: doc.coordinates,
    publicGenerator: doc.publicGenerator,
    [`meshes.${doc.mesh.name}`]: {
      contour: {
        tolerance: contour.tolerance, margin: contour.margin, spacing: contour.spacing, maxEdge: contour.maxEdge, stray: contour.stray, bridges: contour.bridges,
        regions: contour.regions.map(r => ({ name: r.name, bone: r.bone, shape: r.shape, points: r.points.map(([x, y]) => [{ float: x }, { float: y }]), spacing: r.spacing, band: r.band })),
      },
      ...(mesh.r === undefined ? {} : { r: mesh.r }),
      ...(mesh.segments === undefined ? {} : { segments: mesh.segments as Emit[] }),
    },
    ...(doc.sourceRule === undefined ? {} : { sourceRule: doc.sourceRule }),
  };
  return emit(value, 0) + '\n';
}

/** Crop → rig world mapping, only when the loaded model fixes it. */
export type CropWorldMapping =
  | { available: true; crop: { w: number; h: number }; toWorld: (x: number, y: number) => { x: number; y: number }; basis: string }
  | { available: false; reason: string };

/**
 * The rig-parts crop convention is world = (x − W/2, H − y): root at the crop's bottom centre, world y up. A
 * model fixes W×H only when its declared `stage` is exactly that frame (x = −width/2, y = 0) and the root bone's
 * drawn world position is the origin. Anything else is reported as missing; no frame is assumed.
 */
export function cropWorldMapping(stage: { x: number; y: number; width: number; height: number } | null | undefined, root: { x: number; y: number } | null): CropWorldMapping {
  const missing = (what: string): CropWorldMapping => ({ available: false, reason: `CHEST_REGION_MAPPING_UNAVAILABLE: ${what}` });
  if (!stage) return missing('the model declares no stage');
  if (![stage.x, stage.y, stage.width, stage.height].every(Number.isFinite) || stage.width <= 0 || stage.height <= 0) return missing('the model stage is not a positive finite box');
  if (stage.x !== -stage.width / 2 || stage.y !== 0) return missing(`the model stage (${stage.x}, ${stage.y}, ${stage.width}×${stage.height}) is not a crop frame with the root at its bottom centre`);
  if (!root) return missing('no drawn root bone position');
  if (Math.abs(root.x) > 1e-6 || Math.abs(root.y) > 1e-6) return missing(`the drawn root bone is at (${root.x}, ${root.y}), not the world origin`);
  const { x: ox, y: oy, width, height } = stage;
  return { available: true, crop: { w: width, h: height }, toWorld: (x, y) => ({ x: ox + x, y: oy + height - y }), basis: `model stage ${width}×${height} at (${ox}, ${oy}), root at world origin: world = (x − ${width / 2}, ${height} − y)` };
}

export interface ChestRegionsBinding {
  schema: 'rig-review-chest-regions-binding/1';
  file: { name: 'chest-regions.json'; sha256: string };
  package: string;
  model: string | null;
  motion: string | null;
  exportedAt: string;
  tools: { viewerVersion: string; runtimeVersion: string };
  mapping: string;
  evidence: string;
}
export function chestRegionsBinding(input: { fileSha256: string; sourceHash: string; reviewedSource: { viewerVersion: string; runtimeVersion: string; rig: { sha256: string } | null; motion: { sha256: string } | null }; exportedAt: string; mapping: string }): ChestRegionsBinding {
  return {
    schema: 'rig-review-chest-regions-binding/1',
    file: { name: 'chest-regions.json', sha256: input.fileSha256 },
    package: input.sourceHash,
    model: input.reviewedSource.rig?.sha256 ?? null,
    motion: input.reviewedSource.motion?.sha256 ?? null,
    exportedAt: input.exportedAt,
    tools: { viewerVersion: input.reviewedSource.viewerVersion, runtimeVersion: input.reviewedSource.runtimeVersion },
    mapping: input.mapping,
    evidence: 'Designation is review evidence, not an approval. Nothing was written into the package; regeneration is the producer path.',
  };
}
