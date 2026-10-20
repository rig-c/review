/**
 * Which config patches need `rig-parts build` (#115): the cut, patch and limb sections are read by the producer's
 * assemble stage, which makes the parts from the painting and its See-through runs before the rig is built, so an edit
 * there is invisible to `rig --config --parts` (it reads the parts the inspected build already assembled). rig-parts
 * AUTHORING §3: `assemble.patches` and `assemble.cuts` are read by "assemble", and `limbs` by "assemble (the cut and the
 * caps), rig (through `regions`), check (`LIMB_ONE_BONE`)"; with `limbs`, "`assemble` reads `bones` too" — a limb's
 * joint is its lower bone's origin, so a bone edit on a config that declares limbs moves a cut and needs assemble as
 * well. `rig-parts build` runs assemble, rig and check in one process and needs the painting (`--source`) and the
 * See-through runs (`--full`, `--head`) the handoff declares.
 *
 * The assemble stage also reads files the config names relative to its own directory (rig-parts `src/build.ts`:
 * `readUnders`, `readCaps`, and the alternates' `source` / `full` / `head` / `skeleton`). A patch may not name a new one
 * (`EDIT_PATCH_PATH_HELD`): review never sends a path, so an `under` or a `cap` can only be one the config already
 * names. Pure: no IO.
 */
import { parsePointer, type JsonValue, type PatchOp } from './config-patch.ts';

/** The pointer prefixes whose ops only `build` carries. */
export const BUILD_PATHS: readonly (readonly string[])[] = [['assemble'], ['limbs']];
/** With `limbs` declared, a bone edit is also a cut edit (the joint is the bone's origin). */
export const LIMB_BONE_PATH: readonly string[] = ['bones'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const under = (tokens: readonly string[], prefix: readonly string[]) => prefix.length <= tokens.length && prefix.every((t, i) => tokens[i] === t);

/** True when a `rig` patch needs the build: any op under `/assemble` or `/limbs`, or under `/bones` on a config that declares `limbs`. */
export function needsBuild(ops: readonly Pick<PatchOp, 'path'>[], config: unknown): boolean {
  const limbs = isObject(config) && config.limbs !== undefined;
  return ops.some(op => { const t = parsePointer(op.path); return BUILD_PATHS.some(p => under(t, p)) || (limbs && under(t, LIMB_BONE_PATH)); });
}

/** One config-relative file the assemble stage reads: where it is named and the value as written. */
export interface BuildNamedFile { field: string; role: 'under' | 'cap' | 'source' | 'full' | 'head' | 'skeleton'; value: string; kind: 'file' | 'dir' }

/** Every config-relative path the build's assemble stage reads (besides the two `rig` reads, `CONFIG_NAMED_FILES`). */
export function buildNamedFiles(config: unknown): BuildNamedFile[] {
  const out: BuildNamedFile[] = [];
  if (!isObject(config)) return out;
  const assemble = isObject(config.assemble) ? config.assemble : {};
  const cuts = (list: unknown, at: string) => { if (Array.isArray(list)) list.forEach((q, i) => { if (isObject(q) && typeof q.under === 'string' && q.under) out.push({ field: `${at}[${i}].under`, role: 'under', value: q.under, kind: 'file' }); }); };
  cuts(assemble.cuts, 'assemble.cuts');
  if (Array.isArray(assemble.alternates)) assemble.alternates.forEach((a, i) => {
    if (!isObject(a)) return;
    for (const [role, kind] of [['source', 'file'], ['full', 'dir'], ['head', 'dir'], ['skeleton', 'file']] as const) if (typeof a[role] === 'string' && a[role]) out.push({ field: `assemble.alternates[${i}].${role}`, role, value: a[role] as string, kind });
    cuts(a.cuts, `assemble.alternates[${i}].cuts`);
  });
  if (isObject(config.limbs)) for (const [limb, entry] of Object.entries(config.limbs)) {
    if (!isObject(entry) || !Array.isArray(entry.segments)) continue;
    entry.segments.forEach((sg, k) => { if (isObject(sg) && typeof sg.cap === 'string' && sg.cap) out.push({ field: `limbs.${limb}.segments[${k}].cap`, role: 'cap', value: sg.cap, kind: 'file' }); });
  }
  return out;
}

/**
 * `null` when every file the patched config names for the assemble stage is one the handoff config already names in the
 * same role (a cut may drop its `under`, a cut may go, an `under` may move to another cut — but no new path); else the
 * first field that names a new one.
 */
export function newBuildFile(original: JsonValue, patched: JsonValue): string | null {
  const held = new Set(buildNamedFiles(original).map(f => `${f.role}\u0000${f.value}`));
  return buildNamedFiles(patched).find(f => !held.has(`${f.role}\u0000${f.value}`))?.field ?? null;
}

/** The patched config with every assemble-read path made absolute against the handoff config's directory (`resolve`). */
export function absolutizeBuildFiles(doc: Record<string, unknown>, resolve: (value: string) => string): void {
  const fix = (holder: unknown, key: string) => { if (isObject(holder) && typeof holder[key] === 'string' && holder[key]) holder[key] = resolve(holder[key] as string); };
  const assemble = isObject(doc.assemble) ? doc.assemble : null;
  const cuts = (list: unknown) => { if (Array.isArray(list)) for (const q of list) fix(q, 'under'); };
  if (assemble) {
    cuts(assemble.cuts);
    if (Array.isArray(assemble.alternates)) for (const a of assemble.alternates) { for (const k of ['source', 'full', 'head', 'skeleton']) fix(a, k); if (isObject(a)) cuts(a.cuts); }
  }
  if (isObject(doc.limbs)) for (const entry of Object.values(doc.limbs)) if (isObject(entry) && Array.isArray(entry.segments)) for (const sg of entry.segments) fix(sg, 'cap');
}

/**
 * The build's own lines, read for review (prefix `[assemble]`, `[rig]`, `[check]` stripped): every `FAIL` line (the
 * refusals, verbatim), the `cut:` / `limb cut:` / `limb cap:` lines, `recomposite vs source`, the uncovered holes, the
 * `seam:` and `seam pair` lines, and check's last `check: …` line.
 */
export interface BuildReadout { refusals: string[]; assemble: string[]; recomposite: string | null; seam: string[]; seamPairs: string[]; check: string | null }
export const MAX_BUILD_READOUT = 64;
const stripStage = (line: string) => line.replace(/^\s*\[[a-z]+\]\s?/, '').trim();
export function buildReadout(lines: readonly string[]): BuildReadout {
  const out: BuildReadout = { refusals: [], assemble: [], recomposite: null, seam: [], seamPairs: [], check: null };
  for (const raw of lines) {
    const line = stripStage(raw);
    if (/^FAIL\s+[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(line)) { if (out.refusals.length < MAX_BUILD_READOUT) out.refusals.push(line); continue; }
    if (/^(cut|limb cut|limb cap):\s/.test(line) || /^uncovered hole \d+:/.test(line)) { if (out.assemble.length < MAX_BUILD_READOUT) out.assemble.push(line); continue; }
    if (/^recomposite vs source:/.test(line)) { out.recomposite = line; continue; }
    // The base set's pairs only; an alternate set's own pairs read `seam pair (<set>) …`.
    if (/^seam pair \d+ of \d+:/.test(line)) { if (out.seamPairs.length < MAX_BUILD_READOUT) out.seamPairs.push(line); continue; }
    if (/^seam:\s/.test(line)) { out.seam.push(line); continue; }
    if (/^check:\s/.test(line)) out.check = line;
  }
  return out;
}
/** The lines with the stage prefix stripped, for check's summary and the first-refusal reader. */
export const buildLines = (lines: readonly string[]) => lines.map(stripStage);

/** `parts.json`'s `recomposite` block figures (rig-parts AUTHORING §5), or null without one. */
export interface RecompositeFigures { mean_abs: number; within_share: number; error_px: number; uncovered_error_px: number; hole_count: number }
export function recompositeFigures(partsJson: unknown): RecompositeFigures | null {
  const block = isObject(partsJson) && isObject(partsJson.recomposite) ? partsJson.recomposite : null;
  if (!block) return null;
  const keys = ['mean_abs', 'within_share', 'error_px', 'uncovered_error_px', 'hole_count'] as const;
  if (!keys.every(k => typeof block[k] === 'number' && Number.isFinite(block[k]))) return null;
  return Object.fromEntries(keys.map(k => [k, block[k] as number])) as unknown as RecompositeFigures;
}
