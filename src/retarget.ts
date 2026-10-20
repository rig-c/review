/**
 * Retarget tuning (#114): a pose sequence the package declares goes onto the inspected rig through the installed
 * `@rig-c/pose` — `rig-pose clean`, then `rig-pose retarget` with the person's `rig-pose-map/1` and flags, then the
 * compile — into a scratch build that plays beside the reference. Review authors no keys: the motion is the producer's,
 * written in scratch; the package's motion.json is never written.
 *
 * Pure: the typed request (`{sequence, map, flags, configHash}` — a declared reference id, the map document by content
 * and a closed set of typed flags; never a path, never a flag string), the argv each step runs with (the server maps the
 * typed flags; the client sends none), the record of what was applied (`rig-review-retarget/1`, whose `op.args` and
 * `op.clean` hold the flag set as argv) and the run's FEET / STANCE / FLIP / SHORT / END-ON / LEG-SCALE / REACH lines with
 * the frame each one names.
 */
import { createHash } from 'node:crypto';

export const RETARGET_SCHEMA = 'rig-review-retarget/1';
export const POSE_MAP_SCHEMA = 'rig-pose-map/1';
/** The map document as sent, at most this many bytes of JSON. */
export const MAX_MAP_BYTES = 32 * 1024;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class RetargetError extends Error { constructor(readonly code: string, detail: string) { super(`${code}: ${detail}`); } }
const bad = (detail: string): never => { throw new RetargetError('RETARGET_REQUEST_INVALID', detail); };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactly = (v: unknown, keys: string, field: string): Record<string, unknown> => {
  if (!isObject(v) || Object.keys(v).sort().join(',') !== keys) bad(`${field} holds exactly ${keys.split(',').join(', ')}`);
  return v as Record<string, unknown>;
};
const num = (v: unknown, field: string, ok: (n: number) => boolean, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) bad(`${field} must be ${what}`);
  return v as number;
};
const orNull = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null ? null : read(v));
const bool = (v: unknown, field: string): boolean => (typeof v === 'boolean' ? v : bad(`${field} must be true or false`));

/** `rig-pose clean`'s flags, typed. `legs` / `rest`: 1 (none), or odd and ≥ 5, as clean's help states. */
export interface CleanFlags { loop: boolean; legs: number; rest: number; hold: boolean; hipsInferred: boolean }
/**
 * `rig-pose retarget`'s flags, typed; `clean: null` retargets the sequence as the package holds it (retarget refuses one
 * without clean's record, `POSE_NOT_CLEANED`). A null figure leaves the producer's default (`--flip`/`--short` off).
 */
export interface RetargetFlags {
  animation: string; person: string | null; clean: CleanFlags | null;
  minScore: number | null; flip: number | null; short: number | null;
  bends: 'refuse' | 'clamp'; bendTolerance: number | null;
  legScale: [number, number] | null; plantFeet: boolean; stance: number | null;
  raisedByHead: boolean; carryIdle: boolean;
}
export const DEFAULT_CLEAN: CleanFlags = { loop: false, legs: 5, rest: 7, hold: true, hipsInferred: false };
export const DEFAULT_FLAGS: RetargetFlags = { animation: 'retarget', person: null, clean: { ...DEFAULT_CLEAN }, minScore: null, flip: null, short: null, bends: 'refuse', bendTolerance: null, legScale: null, plantFeet: false, stance: null, raisedByHead: false, carryIdle: false };
const FLAG_KEYS = 'animation,bendTolerance,bends,carryIdle,clean,flip,legScale,minScore,person,plantFeet,raisedByHead,short,stance';
const windowOk = (n: number) => Number.isInteger(n) && (n === 1 || (n >= 5 && n <= 61 && n % 2 === 1));

export function parseCleanFlags(v: unknown, field = 'flags.clean'): CleanFlags {
  const c = exactly(v, 'hipsInferred,hold,legs,loop,rest', field);
  return { loop: bool(c.loop, `${field}.loop`), legs: num(c.legs, `${field}.legs`, windowOk, '1, or odd and 5–61'), rest: num(c.rest, `${field}.rest`, windowOk, '1, or odd and 5–61'), hold: bool(c.hold, `${field}.hold`), hipsInferred: bool(c.hipsInferred, `${field}.hipsInferred`) };
}
export function parseRetargetFlags(v: unknown): RetargetFlags {
  const f = exactly(v, FLAG_KEYS, 'flags');
  if (typeof f.animation !== 'string' || !NAME.test(f.animation)) bad('flags.animation must be an animation name ([A-Za-z0-9_][A-Za-z0-9_.-], at most 64)');
  const person = orNull(f.person, p => (typeof p === 'string' && NAME.test(p) ? p : bad('flags.person must be a person id or null')));
  const bends = f.bends === 'refuse' || f.bends === 'clamp' ? f.bends : bad('flags.bends must be refuse or clamp');
  const legScale = orNull(f.legScale, l => {
    if (!Array.isArray(l) || l.length !== 2) bad('flags.legScale must be [min, max] or null');
    const [min, max] = (l as unknown[]).map((n, i) => num(n, `flags.legScale[${i}]`, x => x > 0 && x <= 4, 'in (0, 4]'));
    if (!(min! <= 1 && 1 <= max!)) bad('flags.legScale must hold 0 < min ≤ 1 ≤ max');
    return [min!, max!] as [number, number];
  });
  return {
    animation: f.animation as string, person, clean: orNull(f.clean, c => parseCleanFlags(c)),
    minScore: orNull(f.minScore, n => num(n, 'flags.minScore', x => x >= 0 && x <= 100, 'in [0, 100]')),
    flip: orNull(f.flip, n => num(n, 'flags.flip', x => x > 0 && x <= 180, 'degrees in (0, 180]')),
    short: orNull(f.short, n => num(n, 'flags.short', x => x > 0 && x < 1, 'a fraction in (0, 1)')),
    bends, bendTolerance: orNull(f.bendTolerance, n => num(n, 'flags.bendTolerance', x => x >= 0 && x <= 180, 'degrees in [0, 180]')),
    legScale, plantFeet: bool(f.plantFeet, 'flags.plantFeet'),
    stance: orNull(f.stance, n => num(n, 'flags.stance', x => x > 0 && x <= 1, 'leg lengths in (0, 1]')),
    raisedByHead: bool(f.raisedByHead, 'flags.raisedByHead'), carryIdle: bool(f.carryIdle, 'flags.carryIdle'),
  };
}

const figure = (n: number) => String(n);
/** `rig-pose clean`'s flags as argv; the paths (`--pose`, `--out`) are the server's. */
export function cleanArgv(c: CleanFlags, person: string | null): string[] {
  return [...(c.loop ? ['--loop'] : []), '--legs', figure(c.legs), '--rest', figure(c.rest), ...(c.hold ? [] : ['--hold', 'off']), ...(c.hipsInferred ? ['--hips-inferred'] : []), ...(person ? ['--person', person] : [])];
}
/** `rig-pose retarget`'s flags as argv, only what the typed flags state; the paths (`--rig`, `--map`, `--sequence`, `--out`) are the server's. */
export function retargetArgv(f: RetargetFlags): string[] {
  return [
    '--animation', f.animation,
    // A cleaned sequence holds the one person clean wrote; --person reaches retarget only when clean is skipped.
    ...(f.person && !f.clean ? ['--person', f.person] : []),
    ...(f.minScore !== null ? ['--min-score', figure(f.minScore)] : []),
    ...(f.flip !== null ? ['--flip', figure(f.flip)] : []),
    ...(f.short !== null ? ['--short', figure(f.short)] : []),
    ...(f.bends === 'clamp' ? ['--bends', 'clamp'] : []),
    ...(f.bendTolerance !== null ? ['--bend-tolerance', figure(f.bendTolerance)] : []),
    ...(f.legScale ? ['--leg-scale', `${figure(f.legScale[0])},${figure(f.legScale[1])}`] : []),
    ...(f.plantFeet ? ['--plant-feet'] : []),
    ...(f.stance !== null ? ['--stance', figure(f.stance)] : []),
    ...(f.raisedByHead ? ['--raised-by-head'] : []),
    ...(f.carryIdle ? ['--carry-idle'] : []),
  ];
}
export const cleanArgs = (r: { pose: string; out: string; argv: readonly string[] }): string[] => ['clean', '--pose', r.pose, '--out', r.out, ...r.argv];
export const retargetArgs = (r: { rig: string; map: string; sequence: string; out: string; argv: readonly string[] }): string[] => ['retarget', '--rig', r.rig, '--map', r.map, '--sequence', r.sequence, '--out', r.out, ...r.argv];

/**
 * The map's envelope: `rig-pose-map/1`, chains each with a name, bones and joints (strings), at most `MAX_MAP_BYTES`.
 * Whether its bones are the rig's, its chains descend or its aims resolve is the producer's to judge (`MAP_*`, verbatim).
 */
export function parsePoseMap(v: unknown): Record<string, unknown> {
  if (!isObject(v) || v.spec !== POSE_MAP_SCHEMA) bad(`map must be a ${POSE_MAP_SCHEMA} document`);
  const map = v as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(map)) > MAX_MAP_BYTES) bad(`map is over ${MAX_MAP_BYTES} bytes`);
  if (!Array.isArray(map.chains) || map.chains.length < 1 || map.chains.length > 64) bad('map.chains must hold 1–64 chains');
  for (const [i, raw] of (map.chains as unknown[]).entries()) {
    if (!isObject(raw)) bad(`map.chains[${i}] must be an object`);
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== 'string' || !c.name || c.name.length > 64) bad(`map.chains[${i}].name`);
    for (const key of ['bones', 'joints'] as const) if (!Array.isArray(c[key]) || !(c[key] as unknown[]).length || (c[key] as unknown[]).length > 32 || !(c[key] as unknown[]).every(s => typeof s === 'string' && s.length > 0 && s.length <= 128)) bad(`map.chains[${i}].${key} must hold 1–32 names`);
  }
  return structuredClone(map);
}
/** The map file review writes into scratch; `map_sha256` is its hash. */
export const mapText = (map: Record<string, unknown>) => JSON.stringify(map, null, 1) + '\n';

export interface RetargetRequest { sequence: string; map: Record<string, unknown>; flags: RetargetFlags; configHash: string }
/** `{sequence, map, flags, configHash}`: a declared pose reference id, the map by content, typed flags, the handoff config hash read. */
export function parseRetargetRequest(input: unknown): RetargetRequest {
  const v = exactly(input, 'configHash,flags,map,sequence', 'retarget');
  if (typeof v.sequence !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v.sequence)) bad('sequence must be a declared pose reference id');
  if (typeof v.configHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.configHash)) bad('configHash');
  return { sequence: v.sequence as string, map: parsePoseMap(v.map), flags: parseRetargetFlags(v.flags), configHash: v.configHash as string };
}

/**
 * What was applied, the data form a feedback record carries: the handoff config and rig it ran against, the sequence
 * (reference id, package path, sha256), the map by content and hash, the typed flags, the producer, and `op` — the flag
 * set as the argv each step ran with (`args` for retarget, `clean` for clean, null when clean was skipped).
 */
export interface RetargetRecord {
  schema: typeof RETARGET_SCHEMA;
  config_sha256: string;
  rig: { path: string; sha256: string };
  sequence: { reference: string; path: string; sha256: string };
  map: Record<string, unknown>; map_sha256: string;
  flags: RetargetFlags;
  producer: { name: string; version: string };
  op: { cmd: 'retarget'; args: string[]; clean: string[] | null };
}
export function retargetRecord(r: RetargetRequest, at: { rig: { path: string; sha256: string }; sequence: { path: string; sha256: string }; producer: { name: string; version: string } }): RetargetRecord {
  return {
    schema: RETARGET_SCHEMA, config_sha256: r.configHash, rig: { ...at.rig }, sequence: { reference: r.sequence, ...at.sequence },
    map: structuredClone(r.map), map_sha256: sha256(mapText(r.map)), flags: structuredClone(r.flags), producer: { ...at.producer },
    op: { cmd: 'retarget', args: retargetArgv(r.flags), clean: r.flags.clean ? cleanArgv(r.flags.clean, r.flags.person) : null },
  };
}
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
/** A record exactly its shape, its argv the typed flags' own and its map hash the map's. Throws a plain Error. */
export function assertRetargetRecord(value: unknown, field: string): RetargetRecord {
  const fail = (detail: string): never => { throw new Error(`${field}: ${detail}`); };
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'config_sha256,flags,map,map_sha256,op,producer,rig,schema,sequence') fail('expected exactly {schema, config_sha256, rig, sequence, map, map_sha256, flags, producer, op}');
  const v = value as Record<string, unknown>;
  if (v.schema !== RETARGET_SCHEMA) fail(`schema must be ${RETARGET_SCHEMA}`);
  if (![v.config_sha256, v.map_sha256].every(hex)) fail('config_sha256 and map_sha256 are SHA-256 hex');
  const rig = v.rig as Record<string, unknown>, seq = v.sequence as Record<string, unknown>, producer = v.producer as Record<string, unknown>;
  if (!isObject(rig) || typeof rig.path !== 'string' || !hex(rig.sha256) || Object.keys(rig).length !== 2) fail('rig must be {path, sha256}');
  if (!isObject(seq) || typeof seq.reference !== 'string' || typeof seq.path !== 'string' || !hex(seq.sha256) || Object.keys(seq).length !== 3) fail('sequence must be {reference, path, sha256}');
  if (!isObject(producer) || typeof producer.name !== 'string' || typeof producer.version !== 'string' || Object.keys(producer).length !== 2) fail('producer must be {name, version}');
  let flags: RetargetFlags, map: Record<string, unknown>;
  try { flags = parseRetargetFlags(v.flags); map = parsePoseMap(v.map); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  if (sha256(mapText(map)) !== v.map_sha256) fail('map_sha256 is not the map\'s');
  const op = v.op as Record<string, unknown>;
  if (!isObject(op) || op.cmd !== 'retarget' || JSON.stringify(op.args) !== JSON.stringify(retargetArgv(flags)) || JSON.stringify(op.clean) !== JSON.stringify(flags.clean ? cleanArgv(flags.clean, flags.person) : null) || Object.keys(op).length !== 3) fail('op must be {cmd: "retarget", args, clean}, the argv of its flags');
  return value as unknown as RetargetRecord;
}
export const retargetRecordText = (r: RetargetRecord) => JSON.stringify(r);

/** The run's lines the card lists, each with the first frame it names (and that frame's key time, when known). */
export const RETARGET_LINE_CODES = ['FEET', 'STANCE', 'FLIP', 'SHORT', 'END-ON', 'LEG-SCALE', 'REACH'] as const;
export type RetargetLineCode = typeof RETARGET_LINE_CODES[number];
export interface RetargetLine { code: RetargetLineCode; line: string; frame: number | null; time: number | null }
const CODE = new RegExp(`^\\s*(${RETARGET_LINE_CODES.map(c => c.replace('-', '\\-')).join('|')})\\s`);
/**
 * Each listed line verbatim (trimmed), in run order. The frame is the first `frame N` / `frames N–M` / `from frame N`
 * it names; its time is the motion's own key time for that frame (`frameTimes`, the run's report), else the line's `t=`.
 */
export function retargetLines(lines: readonly string[], frameTimes: readonly number[] | null): RetargetLine[] {
  const out: RetargetLine[] = [];
  for (const raw of lines) {
    const match = CODE.exec(raw);
    if (!match) continue;
    const line = raw.trim(), f = /\bframes? (\d+)/.exec(line), t = /\bt=(-?\d+(?:\.\d+)?)/.exec(line);
    const frame = f ? Number(f[1]) : null;
    const keyed = frame !== null && frameTimes && Number.isFinite(frameTimes[frame]) ? frameTimes[frame]! : null;
    out.push({ code: match[1] as RetargetLineCode, line, frame, time: keyed ?? (t ? Number(t[1]) : null) });
  }
  return out;
}

/**
 * The scratch motion against the rig's own: the new animation's name, whether every animation the rig already had is
 * byte-for-byte what it was (retarget writes "the rig's own animations plus the new one"), and the new one's hash.
 */
export interface MotionSummary { animation: string; animations: string[]; kept: boolean; changed: string[]; animationSha256: string | null; motionSha256: string }
export function motionSummary(inspected: unknown, scratch: unknown, scratchText: string, animation: string): MotionSummary {
  const anims = (doc: unknown): Record<string, unknown> => (isObject(doc) && isObject(doc.animations) ? doc.animations : {});
  const a = anims(inspected), b = anims(scratch);
  const changed = Object.keys(a).filter(name => JSON.stringify(a[name]) !== JSON.stringify(b[name]));
  return { animation, animations: Object.keys(b), kept: !changed.length, changed, animationSha256: b[animation] === undefined ? null : sha256(JSON.stringify(b[animation])), motionSha256: sha256(scratchText) };
}
