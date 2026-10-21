/**
 * What Apply can still do on a build whose baseline did not reproduce (#148). The baseline (`src/baseline.ts`) rebuilds
 * the whole rig from the handoff config; when that differs from the inspected rig, the whole-rig ops refuse
 * (`EDIT_BASELINE_MISMATCH`), and the producer's own revising ops hold their own parts of it. This module reads both
 * rig directories and states, per op, what the installed producer will hold — read off `@rig-c/parts`' AUTHORING
 * (§remesh and §retune, the `REMESH_*` and `RETUNE_*` rows) and `src/remesh.ts` / `src/retune.ts`:
 *
 * - **The writer's text.** `remesh` (and its `--delta` mesh edit) splices `rig.json` and `mesh_report.json` as text,
 *   `retune` splices `rig.json` and `motion.json`; each refuses an input file that is not the text the writer prints
 *   for its value (`REMESH_INPUT_WRITTEN`, `RETUNE_INPUT_WRITTEN`: "reformatted, or written by something else"). The
 *   writer is `rigJsonText`: `JSON.stringify(value, null, 1)` and a closing newline.
 * - **retune** carries every attachment and every `mesh_report.json` row over as bytes, so a mesh repair stays; it
 *   holds `stops`, `bones`, `slots`, `skeleton`, `images`, every invariant but `detached`, every image file and
 *   `motion.json` outside `animations.idle` to the config's rebuild (`RETUNE_REQUEST_HELD`). An image the config draws
 *   differently — a repaired texture — is therefore held, and no constraint or idle edit can Apply over it.
 * - **remesh** holds its target part (its attachment, its image, its `mesh_report.json` row, and for an `auto` row the
 *   motion) and the bones to the config's rebuild (`REMESH_BASELINE_MISMATCH`); every other part is carried over. The
 *   mesh edit (`--delta`) builds no config entry: its baseline is the inspected mesh itself.
 *
 * The baseline is the config as written, so this is what an op whose patch the producer judges no further meets. It is
 * a reading, not the producer's verdict: the producer's own line on Apply stays the judgment, shown verbatim.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCER_IMAGES_DIR } from './producer-files.ts';
import { REMESH_DELTA_SINCE, versionAtLeast } from './producer.ts';
import { RETUNE_SINCE } from './retune-route.ts';

/** Which revising ops the installed producer has: `retune` since 1.44.0, `remesh --delta` since 1.43.0. Unknown version: both. */
export interface ReachOps { retune: boolean; delta: boolean; version: string | null }
export const reachOps = (version: string | null | undefined): ReachOps => ({ retune: !version || versionAtLeast(version, RETUNE_SINCE), delta: !version || versionAtLeast(version, REMESH_DELTA_SINCE), version: version || null });

/** `@rig-c/parts`' writer for its rig documents (`src/rig.ts` `rigJsonText`): one space of indent and a closing newline. */
export const writerText = (value: unknown): string => `${JSON.stringify(value, null, 1)}\n`;
/** True when the text is exactly what the writer prints for the value it parses to. */
export function isWriterText(text: string): boolean {
  try { return writerText(JSON.parse(text)) === text; } catch { return false; }
}

export const BASELINE_REACH_SCHEMA = 'rig-review-baseline-reach/1';
export interface BaselineReach {
  schema: typeof BASELINE_REACH_SCHEMA;
  /** Inspected documents (package-relative) that are not the writer's text, in `rig.json`, `motion.json`, `mesh_report.json` order. */
  notWriterText: string[];
  /** Images (package-relative) the config draws differently from the inspected rig, or that one side lacks. */
  images: string[];
  /** retune (physics and idle edits): null when it holds nothing the config changes, else the first held difference. */
  retuneHeld: string | null;
  /** remesh from a config entry: the meshed parts whose attachment, image or report row the config does not reproduce. */
  remeshRefused: string[];
  /** remesh: every meshed part of the inspected rig, in the order the rig lists its skins. */
  meshParts: string[];
  /** remesh: true when the config moves a bone, which refuses every part. */
  bonesDiffer: boolean;
  /** The producer's revising ops this reading assumed (`reachOps`). */
  ops: ReachOps;
  /** The sentence the baseline line and `EDIT_BASELINE_MISMATCH` carry. */
  text: string;
}

type Json = unknown;
const isObject = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Structural equality of two parsed JSON values (object key order ignored). */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}
const withoutKey = (v: Json, key: string): Json => isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== key)) : v;
/** motion.json outside `animations.idle`, as retune holds it. */
const outsideIdle = (m: Json): Json => isObject(m) ? { ...m, animations: withoutKey(m.animations, 'idle') } : m;
/** The rig's mesh attachments named as `remesh --part` names them: `skins.default.<part>.<part>` of type `mesh`. */
function meshAttachments(rig: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  const skins = isObject(rig) ? rig.skins : undefined, skin = isObject(skins) ? skins.default : undefined;
  if (!isObject(skin)) return out;
  for (const [slot, atts] of Object.entries(skin)) if (isObject(atts) && isObject(atts[slot]) && (atts[slot] as Record<string, Json>).type === 'mesh') out.set(slot, atts[slot]);
  return out;
}
const reportRow = (report: Json, part: string): Json => Array.isArray(report) ? report.find(r => isObject(r) && r.part === part) : undefined;

export interface RigDocuments { rig: Json; motion: Json; report: Json; texts: Record<string, string | null> }
const DOCUMENTS = ['rig.json', 'motion.json', 'mesh_report.json'] as const;
async function documents(dir: string): Promise<RigDocuments> {
  const texts: Record<string, string | null> = {}, parsed: Record<string, Json> = {};
  for (const name of DOCUMENTS) {
    let text: string | null = null;
    try { text = await readFile(join(dir, name), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    texts[name] = text;
    try { parsed[name] = text === null ? undefined : JSON.parse(text); } catch { parsed[name] = undefined; }
  }
  return { rig: parsed['rig.json'], motion: parsed['motion.json'], report: parsed['mesh_report.json'], texts };
}

/**
 * The reach, from both rig directories' documents and their `{rig-relative path: sha256}` trees (`rigTree`).
 * `show` turns a rig-relative path into the package-relative one the line names.
 */
export function reachOf(baseline: RigDocuments, inspected: RigDocuments, baselineTree: Record<string, string>, inspectedTree: Record<string, string>, show: (rel: string) => string, ops: ReachOps = reachOps(null)): BaselineReach {
  const notWritten = DOCUMENTS.filter(name => inspected.texts[name] !== null && !isWriterText(inspected.texts[name]!));
  const imageKeys = [...new Set([...Object.keys(baselineTree), ...Object.keys(inspectedTree)])].filter(k => k.startsWith(`${PRODUCER_IMAGES_DIR}/`)).sort();
  const images = imageKeys.filter(k => baselineTree[k] !== inspectedTree[k]);
  const rigB = isObject(baseline.rig) ? baseline.rig : {}, rigI = isObject(inspected.rig) ? inspected.rig : {};
  // retune's hold, in its own order: stops, then bones, slots, skeleton, images, the invariants but detached, each image, motion outside idle.
  let retuneHeld: string | null = null;
  for (const key of ['stops', 'bones', 'slots', 'skeleton', 'images']) if (!retuneHeld && !jsonEqual(rigI[key], rigB[key])) retuneHeld = `rig.json ${key}`;
  if (!retuneHeld && !jsonEqual(withoutKey(rigI.invariants, 'detached'), withoutKey(rigB.invariants, 'detached'))) retuneHeld = 'rig.json invariants';
  if (!retuneHeld && images.length) retuneHeld = images[0]!;
  if (!retuneHeld && !jsonEqual(outsideIdle(inspected.motion), outsideIdle(baseline.motion))) retuneHeld = 'motion.json outside animations.idle';
  // remesh's per-part baseline: the attachment, the image, the report row (and an auto row's motion), and the bones.
  const attsI = meshAttachments(inspected.rig), attsB = meshAttachments(baseline.rig), meshParts = [...attsI.keys()];
  const bonesDiffer = !jsonEqual(rigI.bones, rigB.bones), motionDiffers = !jsonEqual(inspected.motion, baseline.motion);
  const remeshRefused = meshParts.filter(part => {
    const row = reportRow(inspected.report, part);
    return !jsonEqual(attsI.get(part), attsB.get(part)) || images.includes(`${PRODUCER_IMAGES_DIR}/${part}.png`) || !jsonEqual(row, reportRow(baseline.report, part)) || (isObject(row) && row.mode === 'auto' && motionDiffers);
  });
  const reach: BaselineReach = { schema: BASELINE_REACH_SCHEMA, notWriterText: notWritten.map(show), images: images.map(show), retuneHeld: retuneHeld === null ? null : retuneHeld.startsWith(`${PRODUCER_IMAGES_DIR}/`) ? show(retuneHeld) : retuneHeld, remeshRefused, meshParts, bonesDiffer, ops, text: '' };
  reach.text = reachText(reach, show);
  return reach;
}

/** Reads both directories and returns the reach (`reachOf`). */
export async function baselineReach(baselineDir: string, inspectedDir: string, baselineTree: Record<string, string>, inspectedTree: Record<string, string>, show: (rel: string) => string, ops: ReachOps = reachOps(null)): Promise<BaselineReach> {
  return reachOf(await documents(baselineDir), await documents(inspectedDir), baselineTree, inspectedTree, show, ops);
}

const list = (items: readonly string[], max = 4) => items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
/** The re-serialisation advice for a document that is not the writer's text (the producer's own row says: use the files as rig wrote them). */
export const WRITER_TEXT_ADVICE = 'use the files as rig wrote them, or re-serialise them in a copy of the package exactly as rig writes them (JSON with one space of indent and a closing newline) and open the copy';

/**
 * One sentence per op, the cause first:
 *   whole-rig edits refuse (EDIT_BASELINE_MISMATCH); physics and idle edits (retune) …; remesh …; a mesh edit ….
 */
export function reachText(r: Omit<BaselineReach, 'text'>, show: (rel: string) => string = rel => rel): string {
  const parts: string[] = [];
  const written = (names: readonly string[]) => r.notWriterText.filter(p => names.some(n => p === show(n)));
  const remeshWritten = written(['rig.json', 'mesh_report.json']), retuneWritten = written(['rig.json', 'motion.json']);
  if (r.notWriterText.length) parts.push(`${list(r.notWriterText)} ${r.notWriterText.length === 1 ? 'is' : 'are'} not the text rig writes for ${r.notWriterText.length === 1 ? 'its value' : 'their values'} (reformatted, or written by another tool), and an op that splices a revision as text refuses such a file — ${WRITER_TEXT_ADVICE}`);
  parts.push('whole-rig edits refuse (EDIT_BASELINE_MISMATCH)');
  // retune: physics and the idle.
  const retune = !r.ops.retune ? `physics and idle edits rebuild the whole rig on ${r.ops.version} (retune is ${RETUNE_SINCE}+), so they refuse too`
    : retuneWritten.length ? `physics and idle edits (retune) refuse ${list(retuneWritten)} (RETUNE_INPUT_WRITTEN)${r.retuneHeld ? `, and past that ${retuneHeldText(r.retuneHeld)}` : ''}`
    : r.retuneHeld ? `physics and idle edits (retune) refuse: ${retuneHeldText(r.retuneHeld)}`
      : 'physics and idle edits Apply through retune, which carries every inspected mesh over';
  parts.push(retune);
  // remesh from the config's entry (Mesh panel, chest regions).
  const fits = r.meshParts.filter(p => !r.remeshRefused.includes(p));
  const remeshHeld = r.bonesDiffer ? 'the config moves a bone, so every part is refused (REMESH_BASELINE_MISMATCH)'
    : r.remeshRefused.length ? `${list(r.remeshRefused)} ${r.remeshRefused.length === 1 ? 'is' : 'are'} refused (REMESH_BASELINE_MISMATCH: the config does not reproduce ${r.remeshRefused.length === 1 ? 'its' : 'their'} attachment, image or report row)${fits.length ? `; ${list(fits, 8)} can be re-fit` : ''}`
      : r.meshParts.length ? 'every meshed part can be re-fit' : 'the rig has no meshed part';
  parts.push(remeshWritten.length ? `remesh${r.ops.delta ? ' and a mesh edit refuse' : ' refuses'} ${list(remeshWritten)} (REMESH_INPUT_WRITTEN); past that, remesh: ${remeshHeld}` : `remesh: ${remeshHeld}`);
  if (r.ops.delta && !remeshWritten.length && r.meshParts.length) parts.push('a mesh edit (Edit Mesh) is held to the inspected mesh itself, not to the config, so the baseline does not refuse it');
  return parts.join('; ');
}
function retuneHeldText(held: string): string {
  if (held.includes(`${PRODUCER_IMAGES_DIR}/`) && !held.startsWith('rig.json')) return `the config draws ${held} differently and retune holds every image (RETUNE_REQUEST_HELD)`;
  return `the config changes ${held}, which retune holds (RETUNE_REQUEST_HELD)`;
}

/**
 * A review line beside a producer refusal it can explain (#148). The producer's line stays as printed; this names the
 * cause and the way out in review's terms. Null for any other line.
 */
export function producerHint(line: string | null): string | null {
  if (!line) return null;
  const written = /\b(REMESH|RETUNE)_INPUT_WRITTEN:\s+(.+?)\s+—\s/.exec(line);
  if (written) {
    const file = written[2]!.split(/[\\/]/).pop()!, op = written[1] === 'REMESH' ? 'remesh' : 'retune';
    return `${file} in the inspected rig is not the text rig writes for its value (reformatted, or written by another tool); ${op} splices a revision as text, so it refuses the file — ${WRITER_TEXT_ADVICE}`;
  }
  const image = /\bRETUNE_REQUEST_HELD:\s+(images\/\S+)\s+—/.exec(line);
  if (image) return `the inspected ${image[1]} is not the image the config draws (a repaired or redrawn image); retune holds every image, so no physics or idle edit Applies on this build — the baseline line says what still does`;
  return null;
}
