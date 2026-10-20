/**
 * Chest by landmarks (issue #105): the producer's `meshes.<part>.contour.bust` shorthand — three rig-px points (right
 * apex, left apex, cleavage), `alpha`, `clearance`, optional bone names — and the two circles the producer derives from
 * it (`bust_r`, `bust_l`). Pure: no DOM, no filesystem. Review draws these circles live and pre-checks the one geometric
 * refusal (`CONFIG_BUST_CLEARANCE`); the producer derives them again from the entry and is the judge.
 *
 * The derivation is a transcription of `@rig-c/parts` 1.42.0 `src/config.ts` `deriveBustRegions` and the
 * `CONFIG_BUST_CLEARANCE` test in its contour loader (docs/AUTHORING.md `meshes.<part>.contour`, issue #475):
 *
 *   dR = edgeLength(kx - rx, ky - ry); dL = edgeLength(kx - lx, ky - ly)
 *   RR = Math.round(dR - clearance);   RL = Math.round(dL - clearance)
 *   rR = Math.round(alpha * RR);       rL = Math.round(alpha * RL)
 *   bust_r: cx rx, cy ry, r rR, band RR - rR; bust_l: cx lx, cy ly, r rL, band RL - rL
 *   refused when clearance <= 0 || RR + RL >= D || rR <= 0 || rL <= 0 || bandR < 0 || bandL < 0  (D = |apex_r − apex_l|)
 *
 * Coordinates: every config position is rig px (the whole figure's frame, the compiled model's stage when the model is
 * the rig's crop frame). A part image is that frame less the part's box less the producer's pad (`PAD = 4` in
 * `src/rig.ts`): rig = part image + (box.x − 4, box.y − 4). `partToRig` / `rigToPart` are that translation.
 */

export const BUST_SPEC_FIELDS = ['apex_r', 'apex_l', 'cleavage', 'alpha', 'clearance', 'bone_r', 'bone_l', 'spacing'] as const;
/** The producer's defaults (parts `DEFAULT_BUST_*`). */
export const BUST_DEFAULTS = { alpha: 0.22, clearance: 3.8, spacing: 14, bone_r: 'boob_r', bone_l: 'boob_l' } as const;
/** The transparent margin the producer pads every part image with (parts `src/rig.ts` `PAD`). */
export const PART_PAD = 4;
const GRID = 256;

export type RigPoint = [number, number];
/** The `contour.bust` entry as the config holds it; absent optional fields are the producer's defaults. */
export interface BustSpec { apex_r: RigPoint; apex_l: RigPoint; cleavage: RigPoint; alpha?: number; clearance?: number; bone_r?: string; bone_l?: string; spacing?: number }
/** A derived region in the config's circle shape (key order as parts writes it). */
export interface DerivedBustRegion { name: 'bust_r' | 'bust_l'; shape: 'circle'; cx: number; cy: number; r: number; spacing: number; band: number; bone: string }
export interface BustDerivation {
  regions: [DerivedBustRegion, DerivedBustRegion];
  /** The unrounded cleavage distances, the rounded outer radii and the apex distance the refusal reads. */
  dR: number; dL: number; RR: number; RL: number; D: number;
  /** `CONFIG_BUST_CLEARANCE` with the producer's detail, or null when the producer's test passes. */
  refusal: string | null;
}

/** parts `src/length.ts`: `sqrt(dx·dx + dy·dy)`, not `Math.hypot`. */
const edgeLength = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);
/** The refusal's printed figures: parts `src/round.ts` `pyRound(x, n)` is `toFixed(n)` except at an exact binary tie (display only). */
const pyRound = (value: number, digits: number) => Number(value.toFixed(digits));

/** The producer's derivation and its `CONFIG_BUST_CLEARANCE` test, on the same numbers. */
export function deriveBust(spec: BustSpec): BustDerivation {
  const alpha = spec.alpha ?? BUST_DEFAULTS.alpha, clearance = spec.clearance ?? BUST_DEFAULTS.clearance, spacing = spec.spacing ?? BUST_DEFAULTS.spacing;
  const boneR = spec.bone_r ?? BUST_DEFAULTS.bone_r, boneL = spec.bone_l ?? BUST_DEFAULTS.bone_l;
  const [rx, ry] = spec.apex_r, [lx, ly] = spec.apex_l, [kx, ky] = spec.cleavage;
  const D = edgeLength(lx - rx, ly - ry), dR = edgeLength(kx - rx, ky - ry), dL = edgeLength(kx - lx, ky - ly);
  const RR = Math.round(dR - clearance), RL = Math.round(dL - clearance);
  const rR = Math.round(alpha * RR), rL = Math.round(alpha * RL);
  const bandR = RR - rR, bandL = RL - rL;
  let refusal: string | null = null;
  if (clearance <= 0 || RR + RL >= D || rR <= 0 || rL <= 0 || bandR < 0 || bandL < 0) {
    const minClearance = Math.max(0, (dR + dL - D) / 2);
    refusal = `CONFIG_BUST_CLEARANCE: contour.bust.clearance — is ${clearance} (giving R_r = ${RR}, R_l = ${RL}, R_r + R_l = ${RR + RL} px against apex distance D = ${pyRound(D, 2)} px, r_r = ${rR}, band_r = ${bandR}, r_l = ${rL}, band_l = ${bandL}); a clearance > 0 with R_r + R_l < D (clearance > ${pyRound(minClearance, 2)} px) and positive radii is required`;
  }
  return {
    regions: [
      { name: 'bust_r', shape: 'circle', cx: rx, cy: ry, r: rR, spacing, band: bandR, bone: boneR },
      { name: 'bust_l', shape: 'circle', cx: lx, cy: ly, r: rL, spacing, band: bandL, bone: boneL },
    ],
    dR, dL, RR, RL, D, refusal,
  };
}

export class BustSpecError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new BustSpecError('REBUILD_REQUEST_INVALID', detail); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onGrid = (v: number) => Number.isInteger(v * GRID);
function point(v: unknown, field: string): RigPoint {
  if (!Array.isArray(v) || v.length !== 2 || !v.every(n => typeof n === 'number' && Number.isFinite(n))) bad(`${field} must be [x, y], finite rig px`);
  const [x, y] = v as [number, number];
  if (!onGrid(x) || !onGrid(y)) bad(`${field} is off the 1/${GRID} px grid`);
  return [x, y];
}
/**
 * A `contour.bust` request, typed as the producer's loader types it (points on the 1/256 grid, `alpha` and `spacing`
 * positive numbers, `clearance` a number, bone names non-empty strings); the geometry (`CONFIG_BUST_CLEARANCE`) and
 * whether the bones resolve (`CONFIG_NAME_RESOLVES`) are the producer's to judge. Key order is the producer's.
 */
export function parseBustSpec(value: unknown, field = 'bust'): BustSpec {
  if (!isObject(value)) return bad(`${field} must be an object`);
  for (const key of Object.keys(value)) if (!(BUST_SPEC_FIELDS as readonly string[]).includes(key)) bad(`${field}.${key} is not a contour.bust field`);
  const out: BustSpec = { apex_r: point(value.apex_r, `${field}.apex_r`), apex_l: point(value.apex_l, `${field}.apex_l`), cleavage: point(value.cleavage, `${field}.cleavage`) };
  for (const key of ['alpha', 'clearance', 'spacing'] as const) {
    if (!(key in value)) continue;
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || (key !== 'clearance' && n <= 0)) bad(`${field}.${key} must be a finite number${key === 'clearance' ? '' : ' > 0'}`);
    out[key] = n as number;
  }
  for (const key of ['bone_r', 'bone_l'] as const) {
    if (!(key in value)) continue;
    const name = value[key];
    if (typeof name !== 'string' || !name || name.length > 128) bad(`${field}.${key} must name a bone`);
    out[key] = name as string;
  }
  return out;
}

/**
 * The part's `meshes.<part>` entry with `contour.regions` replaced by `contour.bust`: the landmarks are the chest, so
 * the hand-written regions (whose circles the derived ones replace) are dropped; every other field is as written.
 */
export function bustMeshEntry(entry: Record<string, unknown>, spec: BustSpec): Record<string, unknown> {
  const out = structuredClone(entry), contour = out.contour;
  if (!isObject(contour)) throw new BustSpecError('REBUILD_PART_NOT_CONTOUR', 'the entry is not a contour; contour.bust applies to contour meshes only');
  delete contour.regions;
  const bust: Record<string, unknown> = {};
  for (const key of BUST_SPEC_FIELDS) if (spec[key] !== undefined) bust[key] = Array.isArray(spec[key]) ? [...(spec[key] as RigPoint)] : spec[key];
  contour.bust = bust;
  return out;
}

/** The part's box in rig px as `parts.json` states it (`x`, `y` of the unpadded art). */
export interface PartBox { x: number; y: number }
/** Part image px → rig px: the image's origin is the box less the pad. */
export const partToRig = ([x, y]: RigPoint, box: PartBox, pad = PART_PAD): RigPoint => [x + box.x - pad, y + box.y - pad];
/** Rig px → part image px. */
export const rigToPart = ([x, y]: RigPoint, box: PartBox, pad = PART_PAD): RigPoint => [x - box.x + pad, y - box.y + pad];
