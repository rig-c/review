/**
 * Cloth recipe form (#111): the producer config's `cloth` block — one recipe per tag (`bottomwear`, `back hair`,
 * `front hair`, whatever the installed reader accepts) — edited as config patch ops at `/cloth/<tag>/…`. An Apply runs
 * the installed producer's `rig-parts propose --cloth <patched config> --keypoints <handoff keypoints> --write-config
 * <scratch>/config.json`, which writes the config's own text with what the recipe drafts spliced in (rig-parts
 * AUTHORING, *The config written*, issues #537 and #552), then builds that written config through the shared tail.
 * Review never reads the producer's draft file and never merges a draft itself: the written config is the producer's
 * one output review consumes. Pure: no IO.
 */
import { formatPointer, jsonDiff, parsePointer, type JsonValue, type PatchOp } from './config-patch.ts';

/** The first `@rig-c/parts` release whose `propose --cloth --write-config` splices bones, constraints and tracks entry by entry (its CHANGELOG: 1.49.1, parts#552). */
export const CLOTH_WRITE_SINCE = '1.49.1';
/** The config section a cloth patch edits. */
export const CLOTH_PATH = 'cloth';
/** Decision 1 (#111): without the declared keypoints the draft moves the body bones, so a cloth Apply is refused before anything runs. */
export const CLOTH_KEYPOINTS_UNDECLARED = 'CLOTH_KEYPOINTS_UNDECLARED: a cloth recipe Apply runs rig-parts propose, which places the body bones from the figure\'s keypoints; without them the draft moves the body bones the config states — declare the keypoint file with rig-review open <dir> --config <path> --keypoints <file> or the review.json "producer" block\'s "keypoints"';
/** A cloth patch holds only `/cloth` ops: what else the patch edits would be routed and gated differently. */
export const CLOTH_PATCH_MIXED = 'CLOTH_PATCH_MIXED: a cloth recipe patch holds /cloth ops only; apply the other edits separately';
/** propose reads the painting the parts were assembled from (`--source`). */
export const CLOTH_SOURCE_UNAVAILABLE = 'MODELING_INPUT_UNAVAILABLE: source painting — rig-parts propose reads the painting the parts were assembled from (--source), and the handoff declares none; declare it with rig-review open <dir> --config <path> --source <png> --full <dir> [--head <dir>] or the review.json "producer" block';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const under = (tokens: readonly string[], prefix: readonly string[]) => prefix.length <= tokens.length && prefix.every((t, i) => tokens[i] === t);

/** True when the op's pointer lies under `/cloth` (the whole block included). */
export const isClothOp = (op: Pick<PatchOp, 'path'>) => parsePointer(op.path)[0] === CLOTH_PATH;
/** `cloth` when every op is a cloth op, `mixed` when some are, else `none`. */
export function clothPatchKind(ops: readonly Pick<PatchOp, 'path'>[]): 'cloth' | 'mixed' | 'none' {
  const n = ops.filter(isClothOp).length;
  return n === 0 ? 'none' : n === ops.length ? 'cloth' : 'mixed';
}

/**
 * The tags the installed reader accepts, read from its own source text (`export const CLOTH_TARGETS = [...]`), or null
 * when the text does not state them in that form.
 */
export function readClothTargets(sourceText: string): string[] | null {
  const m = /export const CLOTH_TARGETS\s*=\s*\[([^\]]*)\]/.exec(sourceText);
  if (!m) return null;
  const tags = [...m[1]!.matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] ?? x[2]!);
  return tags.length ? tags : null;
}

/** One recipe field the form edits: its pointer below `/cloth/<tag>` and how it is typed. The producer judges every value. */
export interface RecipeField { key: string; path: readonly string[]; kind: 'int' | 'number' | 'bool' | 'pair' | 'list' | 'names' | 'shape'; label: string; required?: boolean }
/** The reader's fields (rig-parts `checkCloth`, AUTHORING §3 `cloth` row), in its order. */
export const RECIPE_FIELDS: readonly RecipeField[] = [
  { key: 'chains', path: ['chains'], kind: 'int', label: 'chains' },
  { key: 'links', path: ['links'], kind: 'int', label: 'links', required: true },
  { key: 'split.at', path: ['split', 'at'], kind: 'int', label: 'split at' },
  { key: 'split.into', path: ['split', 'into'], kind: 'int', label: 'split into' },
  { key: 'split.hold_tip', path: ['split', 'hold_tip'], kind: 'bool', label: 'hold tip' },
  { key: 'length_ratio', path: ['length_ratio'], kind: 'number', label: 'length ratio' },
  { key: 'strength.trunk', path: ['strength', 'trunk'], kind: 'number', label: 'strength trunk' },
  { key: 'strength.branch', path: ['strength', 'branch'], kind: 'number', label: 'strength branch' },
  { key: 'strength.edge', path: ['strength', 'edge'], kind: 'number', label: 'strength edge' },
  { key: 'damping', path: ['damping'], kind: 'number', label: 'damping' },
  { key: 'alternate_damping', path: ['alternate_damping'], kind: 'number', label: 'alternate damping' },
  { key: 'wind', path: ['wind'], kind: 'pair', label: 'wind [root, tip]', required: true },
  { key: 'gravity', path: ['gravity'], kind: 'pair', label: 'gravity [root, tip]', required: true },
  { key: 'translate', path: ['translate'], kind: 'number', label: 'translate' },
  { key: 'swing.scales', path: ['swing', 'scales'], kind: 'list', label: 'swing scales' },
  { key: 'part', path: ['part'], kind: 'names', label: 'part' },
  { key: 'parts', path: ['parts'], kind: 'names', label: 'parts' },
  { key: 'influence.across', path: ['influence', 'across'], kind: 'bool', label: 'influence across' },
  { key: 'influence.max', path: ['influence', 'max'], kind: 'int', label: 'influence max' },
  { key: 'influence.shape', path: ['influence', 'shape'], kind: 'shape', label: 'influence shape' },
  { key: 'influence.radius', path: ['influence', 'radius'], kind: 'number', label: 'influence radius' },
];

export class ClothFieldError extends Error { constructor(readonly field: string, detail: string) { super(`CLOTH_FIELD_INVALID ${field}: ${detail}`); } }

/** A field's text as the form shows it, from the recipe as written ('' when absent). */
export function fieldText(recipe: unknown, field: RecipeField): string {
  let v: unknown = recipe;
  for (const k of field.path) v = isObject(v) ? v[k] : undefined;
  if (v === undefined) return '';
  if (field.kind === 'pair' || field.kind === 'list') return Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
  if (field.kind === 'names') return Array.isArray(v) ? v.join(', ') : String(v);
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** A field's typed value from the form's text; `undefined` for an empty field. Only the type is checked here. */
export function fieldValue(field: RecipeField, text: string): JsonValue | undefined {
  const raw = text.trim();
  if (!raw) return undefined;
  const num = (s: string) => { const n = Number(s.trim()); if (!s.trim() || !Number.isFinite(n)) throw new ClothFieldError(field.key, `${JSON.stringify(s.trim())} is not a number`); return n; };
  switch (field.kind) {
    case 'int': { const n = num(raw); if (!Number.isInteger(n)) throw new ClothFieldError(field.key, `${raw} is not a whole number`); return n; }
    case 'number': return num(raw);
    case 'bool': if (raw === 'true' || raw === 'false') return raw === 'true'; throw new ClothFieldError(field.key, 'true or false');
    case 'shape': return raw;
    case 'pair': { const parts = raw.split(',').map(num); if (parts.length !== 2) throw new ClothFieldError(field.key, 'two numbers, root and tip'); return parts; }
    case 'list': return raw.split(',').map(num);
    case 'names': { const names = raw.split(',').map(s => s.trim()).filter(Boolean); return field.key === 'part' && names.length === 1 && !raw.includes(',') ? names[0]! : names; }
  }
}

/** The recipe object the form states: every non-empty field set at its path; `{}` when every field is empty. */
export function recipeFromFields(values: Readonly<Record<string, string>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const f of RECIPE_FIELDS) {
    const v = fieldValue(f, values[f.key] ?? '');
    if (v === undefined) continue;
    let holder = out;
    for (const k of f.path.slice(0, -1)) { if (!isObject(holder[k])) holder[k] = {}; holder = holder[k] as Record<string, JsonValue>; }
    holder[f.path.at(-1)!] = v;
  }
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * The ops that turn the config's recipe for `tag` into `next` (null: the tag's recipe removed). Keys the form does not
 * know (an annotation, a record) are kept: only form keys are replaced, added or removed. A tag the config does not
 * state is added whole; a config without a `cloth` block gets one.
 */
export function recipeOps(config: unknown, tag: string, next: Record<string, JsonValue> | null): PatchOp[] {
  const cloth = isObject(config) ? config.cloth : undefined;
  const current = isObject(cloth) ? cloth[tag] : undefined;
  const at = (...tokens: string[]) => formatPointer([CLOTH_PATH, tag, ...tokens]);
  if (next === null) return current === undefined ? [] : [{ op: 'remove', path: at() }];
  if (!isObject(cloth)) return [{ op: 'add', path: formatPointer([CLOTH_PATH]), value: { [tag]: next } }];
  if (!isObject(current)) return [{ op: current === undefined ? 'add' : 'replace', path: at(), value: next }];
  const known = new Set(RECIPE_FIELDS.map(f => f.path[0]!));
  const ops: PatchOp[] = [];
  for (const key of [...new Set([...Object.keys(current), ...Object.keys(next)])]) {
    if (!known.has(key)) continue;
    const was = current[key], now = next[key];
    if (same(was, now)) continue;
    if (now === undefined) { ops.push({ op: 'remove', path: at(key) }); continue; }
    if (was === undefined) { ops.push({ op: 'add', path: at(key), value: now }); continue; }
    // An object field (split, strength, swing, influence) is edited key by key, so its other keys keep their place.
    if (isObject(was) && isObject(now)) {
      for (const sub of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
        if (same(was[sub], now[sub])) continue;
        const known2 = RECIPE_FIELDS.some(f => f.path[0] === key && f.path[1] === sub);
        if (!known2) continue;
        if (now[sub] === undefined) ops.push({ op: 'remove', path: at(key, sub) });
        else ops.push({ op: was[sub] === undefined ? 'add' : 'replace', path: at(key, sub), value: now[sub] as JsonValue });
      }
      continue;
    }
    ops.push({ op: 'replace', path: at(key), value: now });
  }
  return ops;
}

/** One chain of links as the config states it: its name and its points then its tip, in rig px. */
export interface ClothChain { chain: string; points: [number, number][] }
/** Per tag: the parts the recipe drafts on (by See-through tag, plus any part the recipe names) and their chains' links. */
export interface ClothTagView { tag: string; parts: string[]; chains: ClothChain[] }
const point = (p: unknown): [number, number] | null => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)) ? [p[0] as number, p[1] as number] : null;
/**
 * The link preview's data (#111): for each tag, the parts tagged with it in `parts.json` (`from` "<run>:<tag>") and the
 * parts its recipe names, and every chain those parts' `meshes.<part>.segments` name, with the chain's `points` and
 * `tip` from `bones` as written. Read off whatever config is given — the inspected one, or the config the producer wrote.
 */
export function clothLinks(config: unknown, partsJson: unknown, tags: readonly string[]): ClothTagView[] {
  const cfg = isObject(config) ? config : {};
  const parts = isObject(partsJson) && Array.isArray(partsJson.parts) ? partsJson.parts : [];
  const recipes = isObject(cfg.cloth) ? cfg.cloth : {};
  const meshes = isObject(cfg.meshes) ? cfg.meshes : {};
  const bones = Array.isArray(cfg.bones) ? cfg.bones : [];
  return tags.map(tag => {
    const names = new Set<string>();
    for (const p of parts) if (isObject(p) && typeof p.name === 'string' && typeof p.from === 'string' && p.from.slice(p.from.indexOf(':') + 1) === tag) names.add(p.name);
    const recipe = recipes[tag];
    if (isObject(recipe)) for (const key of ['part', 'parts']) { const v = recipe[key]; for (const n of Array.isArray(v) ? v : [v]) if (typeof n === 'string' && n) names.add(n); }
    const chains: ClothChain[] = [], seen = new Set<string>();
    for (const part of names) {
      const entry = meshes[part], segments = isObject(entry) && Array.isArray(entry.segments) ? entry.segments : [];
      for (const s of segments) {
        if (typeof s !== 'string' || seen.has(s)) continue;
        const bone = bones.find(b => isObject(b) && b.chain === s);
        if (!isObject(bone) || !Array.isArray(bone.points)) continue;
        const pts = [...bone.points.map(point), point(bone.tip)].filter((x): x is [number, number] => !!x);
        if (pts.length >= 2) { chains.push({ chain: s, points: pts }); seen.add(s); }
      }
    }
    return { tag, parts: [...names].sort(), chains };
  });
}

/**
 * The sections `propose --write-config` splices (rig-parts `PROPOSAL_CONFIG_SECTIONS`, and of `motion` only `tracks`,
 * AUTHORING *The config written*): a written config may differ from its input only at or under these.
 */
export const DRAFTED_PREFIXES: readonly (readonly string[])[] = [['bones'], ['constraints'], ['meshes'], ['regions'], ['limbs'], ['motion', 'tracks'], ['turn'], ['proposed_rig_scale']];
export const MAX_WRITTEN_PATHS = 200;
/** Bar 1: every JSON Pointer at which the written config differs from its input, and those outside the drafted sections. */
export interface WrittenDiff { count: number; paths: string[]; outside: string[]; sections: string[] }
export function writtenDiff(input: unknown, written: unknown): WrittenDiff {
  const paths = jsonDiff(input, written);
  const outside = paths.filter(p => !DRAFTED_PREFIXES.some(prefix => under(parsePointer(p), prefix)));
  const sections = [...new Set(paths.map(p => { const t = parsePointer(p); return t[0] === 'motion' ? t.slice(0, 2).join('.') : t[0] === 'meshes' || t[0] === 'regions' ? t.slice(0, 2).join('.') : t[0] ?? ''; }))];
  return { count: paths.length, paths: paths.slice(0, MAX_WRITTEN_PATHS), outside: outside.slice(0, MAX_WRITTEN_PATHS), sections };
}
