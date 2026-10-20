/**
 * Idle tracks (#104), the pure half: the config's `motion.tracks` and `motion.blink` as the panel edits them, the sine
 * the producer keys, the periods it accepts, review's pre-checks under the producer's own names and words, the pending
 * edits as config patch ops at `/motion/tracks/<i>/…` and `/motion/blink/…`, and what the preview writes through play's
 * `adjust`. No DOM, no IO, no clock: the producer (`rig --config`, then `check`) judges every value on Apply.
 *
 * The sine is rig-parts `src/motion.ts` `sineTrack`: `v(t) = base + amp·sin(2π(t/period − phase))`, keyed at
 * `KEYS_PER_PERIOD` keys per period with the sine's exact Hermite tangents as bezier handles. A chain track keys
 * `rotate` on every link, link `i` at phase `phase + lag·i` and amplitude `amps[i]`, about 0 (`idleMotion`).
 */
import { formatPointer, parsePointer, type JsonValue, type PatchOp } from './config-patch.ts';

/** rig-parts `SINGLE_PROPS` (`src/config.ts`). */
export const SINGLE_PROPS = ['rotate', 'translatex', 'translatey', 'scalex', 'scaley', 'shearx', 'sheary'] as const;
export type SingleProp = typeof SINGLE_PROPS[number];
/** rig-parts `KEYS_PER_PERIOD` and `IDLE_FPS` (`src/motion.ts`). */
export const KEYS_PER_PERIOD = 8;
export const IDLE_FPS = 12;
/** rig-parts `periodFits` (`src/config.ts`): `duration / period` within this of a whole number. */
export const PERIOD_SLACK = 1e-9;
/** The periods the panel offers: `duration / n` for n = 1 … this. A typed period is still checked, never offered. */
export const MAX_CYCLES_OFFERED = 12;
/** rig-parts `BLINK` (`src/motion.ts`): the blink's fixed timing after `blink.t`, in seconds. */
export const BLINK = { shut: 0.07, hold: 0.084, open: 0.16, browShut: 0.08, browHold: 0.084, browOpen: 0.2 } as const;
/** rig-parts `blinkSpan`: the last blink key after `t`; without brows only the eyes' keys must fit inside the idle. */
export const blinkSpan = (blink: { brows?: readonly string[] }) => blink.brows === undefined ? BLINK.shut + BLINK.hold + BLINK.open : Math.max(BLINK.shut + BLINK.hold + BLINK.open, BLINK.browShut + BLINK.browHold + BLINK.browOpen);
/** rig-parts `CONTROL_SUFFIX`: under `--idle-keys ctl` a keyed bone a mesh is weighted to is keyed on `<bone>_ctl`. */
export const CONTROL_SUFFIX = '_ctl';
/** The check bars (and check's `loop:` line) the readout shows before and after an Apply. */
export const IDLE_READOUT_BARS = ['CHAIN_LAG', 'TIP_OVER_ROOT', 'BREATH_VISIBLE', 'loop'] as const;
/** Slider extents for the panel; every number field takes any finite value. */
export const AMP_RANGE: Readonly<Record<SingleProp, { min: number; max: number; step: number }>> = {
  rotate: { min: -10, max: 10, step: 0.05 }, translatex: { min: -10, max: 10, step: 0.1 }, translatey: { min: -10, max: 10, step: 0.1 },
  scalex: { min: -0.05, max: 0.05, step: 0.001 }, scaley: { min: -0.05, max: 0.05, step: 0.001 }, shearx: { min: -10, max: 10, step: 0.1 }, sheary: { min: -10, max: 10, step: 0.1 },
};

export interface SingleTrack { bone: string; prop: SingleProp; amp: number; period: number; phase: number; base?: number }
export interface ChainTrack { chain: string; amps: number[]; period: number; phase: number; lag: number }
export type IdleTrack = SingleTrack | ChainTrack;
export interface IdleBlink { t: number; eyes: string[]; brows?: string[]; squash: number; brow_drop?: number; [key: string]: JsonValue | undefined }
export const isChain = (track: IdleTrack): track is ChainTrack => 'chain' in track;

/** The handoff config's idle as written: duration, tracks (each as written), blink, and the bones and chains it declares. */
export interface IdleSource { duration: number; tracks: IdleTrack[]; blink: IdleBlink | null; bones: string[]; chains: Record<string, number> }
export type IdleSourceResult = { available: true; source: IdleSource } | { available: false; reason: string };
/** One track of the edited idle: `origin` is its index in the handoff config (null for a track the panel added). */
export interface IdleEntry { key: string; origin: number | null; track: IdleTrack }
export interface IdleState { entries: IdleEntry[]; blink: IdleBlink | null }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clone = <T>(v: T): T => structuredClone(v);
const unavailable = (reason: string): IdleSourceResult => ({ available: false, reason: `IDLE_TRACKS_UNAVAILABLE: ${reason}` });

/**
 * Reads `config.motion` and `config.bones` (shapes only: what the panel needs to draw and edit). Anything the panel
 * cannot read as the producer's track shapes makes the panel unavailable by name; values are the producer's to judge.
 */
export function idleSource(config: unknown): IdleSourceResult {
  if (!isObject(config)) return unavailable('the handoff config is not an object');
  const motion = config.motion;
  if (!isObject(motion)) return unavailable('the handoff config states no motion');
  if (!finite(motion.duration) || motion.duration <= 0) return unavailable('config.motion.duration is not a positive number');
  if (!Array.isArray(motion.tracks)) return unavailable('config.motion.tracks is not a list');
  const tracks: IdleTrack[] = [];
  for (const [i, raw] of motion.tracks.entries()) {
    if (!isObject(raw)) return unavailable(`config.motion.tracks[${i}] is not an object`);
    if ('chain' in raw) {
      if (typeof raw.chain !== 'string' || !Array.isArray(raw.amps) || !raw.amps.every(finite) || !finite(raw.period) || !finite(raw.phase) || !finite(raw.lag)) return unavailable(`config.motion.tracks[${i}] is not a chain track {chain, amps, period, phase, lag}`);
    } else if (typeof raw.bone !== 'string' || !SINGLE_PROPS.includes(raw.prop as SingleProp) || !finite(raw.amp) || !finite(raw.period) || !finite(raw.phase) || ('base' in raw && !finite(raw.base))) {
      return unavailable(`config.motion.tracks[${i}] is not a single track {bone, prop, amp, period, phase, base?}`);
    }
    tracks.push(clone(raw) as unknown as IdleTrack);
  }
  let blink: IdleBlink | null = null;
  if (motion.blink !== undefined) {
    const b = motion.blink;
    if (!isObject(b) || !finite(b.t) || !finite(b.squash) || !Array.isArray(b.eyes)) return unavailable('config.motion.blink is not {t, eyes, squash, …}');
    blink = clone(b) as unknown as IdleBlink;
  }
  const bones: string[] = [], chains: Record<string, number> = {};
  for (const entry of Array.isArray(config.bones) ? config.bones : []) {
    if (!isObject(entry)) continue;
    if (typeof entry.chain === 'string' && Array.isArray(entry.points)) { chains[entry.chain] = entry.points.length; entry.points.forEach((_, k) => bones.push(`${entry.chain}${k}`)); }
    else if (typeof entry.name === 'string') bones.push(entry.name);
  }
  return { available: true, source: { duration: motion.duration, tracks, blink, bones, chains } };
}

/** The state the panel starts from: every track as written, in order, keyed by its config index. */
export const initialState = (source: IdleSource): IdleState => ({ entries: source.tracks.map((track, i) => ({ key: `o${i}`, origin: i, track: clone(track) })), blink: clone(source.blink) });

/** The producer's sine (rig-parts `sineTrack`): `base + amp·sin(2π(t/period − phase))`. */
export function sineValue(p: { amp: number; period: number; phase: number; base?: number }, t: number): number {
  return (p.base ?? 0) + p.amp * Math.sin(2 * Math.PI * (t / p.period - p.phase));
}
/** A chain's link `i` as the producer keys it (rig-parts `idleMotion`): rotate at phase `phase + lag·i`, amplitude `amps[i]`, about 0. */
export const linkSine = (track: ChainTrack, i: number) => ({ amp: track.amps[i]!, period: track.period, phase: track.phase + track.lag * i, base: 0 });

/** rig-parts `periodFits`: true when `duration / period` is within 1e-9 of a whole number (and the period is positive). */
export function periodFits(duration: number, period: number): boolean {
  if (!finite(period) || period <= 0) return false;
  const cycles = duration / period;
  return Math.abs(cycles - Math.round(cycles)) <= PERIOD_SLACK;
}
/**
 * The periods offered: exactly the ones the producer accepts. `duration / period` must be a whole number n (periodFits),
 * so a period is `duration / n`; n = 0 is no period, so n runs from 1 (the whole idle) up to `MAX_CYCLES_OFFERED`.
 */
export function periodOffers(duration: number, max = MAX_CYCLES_OFFERED): { cycles: number; period: number }[] {
  return Array.from({ length: max }, (_, i) => ({ cycles: i + 1, period: duration / (i + 1) }));
}

/** rig-parts `pyRound` for the numbers its lines print (`toFixed` rounding; an exact binary tie is not reproduced). */
const round6 = (x: number) => Number(x.toFixed(6));
/** The producer's refusal line without its `FAIL  ` lead and its `(see rig-parts guide …)` tail: `CODE: object — detail`. */
export const producerLine = (code: string, object: string, detail: string) => `${code}: ${object} — ${detail}`;

/** The patched config's track order: the kept tracks in config order, then the added ones (the ops apply in that order). */
export const orderedEntries = (state: IdleState) => [...state.entries.filter(e => e.origin !== null).sort((a, b) => a.origin! - b.origin!), ...state.entries.filter(e => e.origin === null)];

/**
 * Review's pre-checks, run before Apply on the idle the patch would produce, under the producer's names and in its words
 * (rig-parts `checkMotion`, `refuseSharedTargets`, the rig stage's `RIG_BLINK_INSIDE_IDLE`). Each line is the producer's
 * own line for the same config, less its `FAIL  ` lead and guide tail. Empty when none applies; the producer still
 * judges everything on Apply (`RIG_KEY_FRAME_UNTURNED` and `RIG_BLINK_HOLD_SPANS_A_FRAME` are left to it).
 */
export function precheck(source: IdleSource, state: IdleState): string[] {
  const out: string[] = [], p = 'config.motion', duration = source.duration, bones = new Set(source.bones);
  const claims = new Map<string, string[]>();
  const claim = (target: string, by: string) => claims.set(target, [...(claims.get(target) ?? []), by]);
  const periodLine = (at: string, period: number) => {
    if (!finite(period) || period <= 0 || periodFits(duration, period)) return;
    out.push(producerLine('CONFIG_PERIOD_DIVIDES_DURATION', at, `is ${period} s against a ${duration} s idle, ${(duration / period).toFixed(4)} cycles; a whole number of cycles is required or the loop's last frame is not its first`));
  };
  orderedEntries(state).forEach(({ track }, i) => {
    const at = `${p}.tracks[${i}]`;
    if (isChain(track)) {
      periodLine(`${at}.period`, track.period);
      const links = source.chains[track.chain];
      if (links === undefined) out.push(producerLine('CONFIG_NAME_RESOLVES', `${at}.chain`, `is ${JSON.stringify(track.chain)}; a chain declared in config.bones is required`));
      else for (let k = 0; k < links; k++) claim(`${track.chain}${k}.rotate`, `${at} (chain "${track.chain}", link ${k})`);
      return;
    }
    if (!bones.has(track.bone)) out.push(producerLine('CONFIG_NAME_RESOLVES', `${at}.bone`, `is ${JSON.stringify(track.bone)}; a declared bone is required`));
    else claim(`${track.bone}.${track.prop}`, at);
    periodLine(`${at}.period`, track.period);
  });
  const blink = state.blink;
  if (blink) {
    const groups: ['eyes' | 'brows', string][] = [['eyes', 'scaley'], ...(blink.brows !== undefined && blink.brow_drop !== undefined ? [['brows', 'translatey'] as ['brows', string]] : [])];
    for (const [key, prop] of groups) {
      const first = new Map<string, number>();
      (blink[key] ?? []).forEach((name, k) => { if (!first.has(name)) first.set(name, k); });
      for (const [name, k] of first) if (bones.has(name)) claim(`${name}.${prop}`, `${p}.blink.${key}[${k}] (the blink's ${key} group, which keys ${prop} on every member)`);
    }
  }
  for (const [target, by] of claims) {
    if (by.length < 2) continue;
    out.push(producerLine('CONFIG_BONE_PROPERTY_KEYED_ONCE', `bone property "${target}"`, `is keyed by ${by.length} tracks: ${by.join(' and ')}; one track per bone property is required — the idle would hold ${by.length} timelines on ${target}, and rigc refuses two tracks on one bone property. Merge them into one track, or key another property or bone`));
  }
  if (blink) {
    const span = blinkSpan(blink);
    if (!(blink.t > 0 && blink.t + span < duration)) out.push(producerLine('RIG_BLINK_INSIDE_IDLE', `${p}.blink.t`, `is ${blink.t} s; the blink's keys run from t to t + ${round6(span)} s between the idle's first key at 0 and its last at ${duration} s, so 0 < t < ${round6(duration - span)} is required`));
  }
  return out;
}

// ---- edits (immutable) -------------------------------------------------------------------------------------------

const entryOf = (state: IdleState, key: string) => { const e = state.entries.find(x => x.key === key); if (!e) throw new Error(`IDLE_TRACK_UNKNOWN: ${key}`); return e; };
const replaceEntry = (state: IdleState, key: string, track: IdleTrack): IdleState => ({ ...state, entries: state.entries.map(e => e.key === key ? { ...e, track } : e) });
const assertFinite = (value: number, what: string) => { if (!finite(value)) throw new Error(`IDLE_VALUE_INVALID: ${what} must be a finite number`); };

export type SingleField = 'amp' | 'period' | 'phase' | 'base';
export type ChainField = 'period' | 'phase' | 'lag';
/** Set one field of a track. `base: null` takes the field out (the sine about 0, as an absent base is written). */
export function setField(state: IdleState, key: string, field: SingleField | ChainField, value: number | null): IdleState {
  const entry = entryOf(state, key), track = clone(entry.track) as unknown as Record<string, unknown>;
  if (isChain(entry.track) ? !['period', 'phase', 'lag'].includes(field) : !['amp', 'period', 'phase', 'base'].includes(field)) throw new Error(`IDLE_FIELD_UNKNOWN: ${field} is not a field of a ${isChain(entry.track) ? 'chain' : 'single'} track`);
  if (value === null) { if (field !== 'base') throw new Error(`IDLE_VALUE_INVALID: ${field} cannot be absent`); delete track.base; }
  else { assertFinite(value, field); track[field] = value; }
  return replaceEntry(state, key, track as unknown as IdleTrack);
}
/** Set one chain link's amplitude (`amps[link]`). */
export function setLinkAmp(state: IdleState, key: string, link: number, value: number): IdleState {
  const entry = entryOf(state, key);
  if (!isChain(entry.track)) throw new Error(`IDLE_FIELD_UNKNOWN: ${key} is not a chain track`);
  if (!Number.isInteger(link) || link < 0 || link >= entry.track.amps.length) throw new Error(`IDLE_LINK_UNKNOWN: link ${link} of ${entry.track.chain}`);
  assertFinite(value, `amps[${link}]`);
  const amps = [...entry.track.amps]; amps[link] = value;
  return replaceEntry(state, key, { ...entry.track, amps });
}
/**
 * Add a track: a single track on `bone`/`prop`, or a chain track on a declared chain (one amplitude per link). It starts
 * still (amplitude 0) on the whole idle's period at phase 0, so adding it changes nothing until a value is set.
 */
export function addTrack(source: IdleSource, state: IdleState, spec: { bone: string; prop: string } | { chain: string }): IdleState {
  let track: IdleTrack;
  if ('chain' in spec) {
    const links = source.chains[spec.chain];
    if (links === undefined) throw new Error(`IDLE_CHAIN_UNKNOWN: ${spec.chain} is not a chain config.bones declares`);
    track = { chain: spec.chain, amps: Array.from({ length: links }, () => 0), period: source.duration, phase: 0, lag: 0 };
  } else {
    if (!SINGLE_PROPS.includes(spec.prop as SingleProp)) throw new Error(`IDLE_PROP_UNKNOWN: ${spec.prop} (one of ${SINGLE_PROPS.join(', ')})`);
    if (!spec.bone) throw new Error('IDLE_BONE_UNKNOWN: name a bone');
    track = { bone: spec.bone, prop: spec.prop as SingleProp, amp: 0, period: source.duration, phase: 0 };
  }
  const n = Math.max(-1, ...state.entries.filter(e => e.origin === null).map(e => Number(e.key.slice(1)))) + 1;
  return { ...state, entries: [...state.entries, { key: `n${n}`, origin: null, track }] };
}
export function removeTrack(state: IdleState, key: string): IdleState { entryOf(state, key); return { ...state, entries: state.entries.filter(e => e.key !== key) }; }
export type BlinkField = 't' | 'squash' | 'brow_drop';
export function setBlink(state: IdleState, field: BlinkField, value: number): IdleState {
  if (!state.blink) throw new Error('IDLE_BLINK_ABSENT: the config states no motion.blink');
  if (field === 'brow_drop' && state.blink.brow_drop === undefined) throw new Error('IDLE_BLINK_ABSENT: the config states no blink.brow_drop (no brows group)');
  assertFinite(value, `blink.${field}`);
  return { ...state, blink: { ...state.blink, [field]: value } };
}

// ---- ops ---------------------------------------------------------------------------------------------------------

/** The order fields are diffed in (then any other key, sorted), so the same edit always gives the same ops. */
const FIELD_ORDER = ['bone', 'prop', 'chain', 'amp', 'amps', 'period', 'phase', 'lag', 'base', 't', 'squash', 'brow_drop'];
const keyOrder = (a: Record<string, unknown>, b: Record<string, unknown>) => { const all = [...new Set([...Object.keys(a), ...Object.keys(b)])]; return [...FIELD_ORDER.filter(k => all.includes(k)), ...all.filter(k => !FIELD_ORDER.includes(k)).sort()]; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function diffObject(path: (string | number)[], before: Record<string, unknown>, after: Record<string, unknown>, ops: PatchOp[]): void {
  for (const k of keyOrder(before, after)) {
    const had = Object.hasOwn(before, k), has = Object.hasOwn(after, k), at = formatPointer([...path, k]);
    if (had && !has) ops.push({ op: 'remove', path: at });
    else if (!had && has) ops.push({ op: 'add', path: at, value: clone(after[k]) as JsonValue });
    else if (!same(before[k], after[k])) {
      const x = before[k], y = after[k];
      if (k === 'amps' && Array.isArray(x) && Array.isArray(y) && x.length === y.length) y.forEach((v, i) => { if (!same(x[i], v)) ops.push({ op: 'replace', path: formatPointer([...path, k, i]), value: v as JsonValue }); });
      else ops.push({ op: 'replace', path: at, value: clone(y) as JsonValue });
    }
  }
}
/**
 * The pending edits as config patch ops, applied in order: field ops on the kept tracks at their config index, then the
 * removed tracks from the highest index down, then the added tracks appended (`add /motion/tracks/-`), then the blink's
 * fields. Empty when the state is the config's own.
 */
export function idleOps(source: IdleSource, state: IdleState): PatchOp[] {
  const ops: PatchOp[] = [];
  const kept = state.entries.filter(e => e.origin !== null).sort((a, b) => a.origin! - b.origin!);
  for (const e of kept) diffObject(['motion', 'tracks', e.origin!], source.tracks[e.origin!] as unknown as Record<string, unknown>, e.track as unknown as Record<string, unknown>, ops);
  const keptOrigins = new Set(kept.map(e => e.origin));
  for (let i = source.tracks.length - 1; i >= 0; i--) if (!keptOrigins.has(i)) ops.push({ op: 'remove', path: formatPointer(['motion', 'tracks', i]) });
  for (const e of state.entries.filter(x => x.origin === null)) ops.push({ op: 'add', path: '/motion/tracks/-', value: clone(e.track) as unknown as JsonValue });
  if (source.blink && state.blink) diffObject(['motion', 'blink'], source.blink as Record<string, unknown>, state.blink as Record<string, unknown>, ops);
  return ops;
}

/**
 * The state back from ops (the draft, a submitted patch): the inverse of `idleOps`. Refused by name unless the ops are
 * exactly what `idleOps` writes for the state they give back — a hand-made op the panel cannot show is never half-read.
 */
export function stateFromOps(source: IdleSource, ops: readonly PatchOp[]): IdleState {
  let state = initialState(source);
  const tracks = new Map(state.entries.map(e => [e.origin!, clone(e.track) as unknown as Record<string, JsonValue>]));
  const removed = new Set<number>(), added: IdleTrack[] = [];
  let blink = clone(state.blink) as Record<string, JsonValue> | null;
  const bad = (i: number, why: string): never => { throw new Error(`IDLE_DRAFT_UNREADABLE: ops[${i}] ${why}`); };
  ops.forEach((op, i) => {
    const t = parsePointer(op.path);
    if (t[0] !== 'motion') bad(i, `${op.path} is not under /motion`);
    if (t[1] === 'tracks') {
      if (t.length === 3 && t[2] === '-' && op.op === 'add') { added.push(clone(op.value) as unknown as IdleTrack); return; }
      const index = Number(t[2]);
      if (!/^(0|[1-9][0-9]*)$/.test(t[2] ?? '') || !tracks.has(index)) bad(i, `${op.path} names no config track`);
      if (t.length === 3 && op.op === 'remove') { removed.add(index); return; }
      const track = tracks.get(index)!;
      if (t.length === 4) { if (op.op === 'remove') delete track[t[3]!]; else track[t[3]!] = clone(op.value!); return; }
      if (t.length === 5 && t[3] === 'amps' && Array.isArray(track.amps) && op.op === 'replace') { track.amps[Number(t[4])] = clone(op.value!); return; }
      bad(i, `${op.op} ${op.path} is not an idle track edit`);
    }
    if (t[1] === 'blink' && t.length === 3 && blink) { if (op.op === 'remove') delete blink[t[2]!]; else blink[t[2]!] = clone(op.value!); return; }
    bad(i, `${op.op} ${op.path} is not an idle edit`);
  });
  state = { entries: [...[...tracks].filter(([i]) => !removed.has(i)).map(([i, track]) => ({ key: `o${i}`, origin: i, track: track as unknown as IdleTrack })), ...added.map((track, k) => ({ key: `n${k}`, origin: null, track }))], blink: blink as IdleBlink | null };
  if (!same(idleOps(source, state), ops)) throw new Error('IDLE_DRAFT_UNREADABLE: the ops are not the ones the panel writes for the idle they describe');
  return state;
}

/** Whether a track differs from the config's own (a new track always does). */
export function entryChanged(source: IdleSource, entry: IdleEntry): boolean { return entry.origin === null || !same(source.tracks[entry.origin], entry.track); }

/** The draft's record of the panel: the pending ops (nothing about the preview). */
export const IDLE_DRAFT_SCHEMA = 'rig-review-idle-draft/1';
export const idleDraftText = (ops: readonly PatchOp[]) => JSON.stringify({ schema: IDLE_DRAFT_SCHEMA, ops });
/** The state a draft records, or the config's own when the draft is absent, foreign or no longer applies. */
export function idleDraftState(text: string, source: IdleSource): IdleState {
  try {
    const doc = JSON.parse(text) as unknown;
    if (!isObject(doc) || doc.schema !== IDLE_DRAFT_SCHEMA || !Array.isArray(doc.ops)) return initialState(source);
    return stateFromOps(source, doc.ops as PatchOp[]);
  } catch { return initialState(source); }
}

// ---- which bone the idle keys, and what the preview writes ---------------------------------------------------------

/**
 * Where the inspected idle keys each config track (#104): read off the handoff rig's `motion.json` (the idle's track
 * bones) and `rig.json` (`invariants.idleDrivesMeshes`, which `rig --idle-keys direct` declares). `keyed` maps
 * `<config bone>.<prop>` to the bone the idle keys — `<bone>_ctl` when the rig stage moved the keys to a control.
 */
/** `GET /api/rebuild`'s `idle`: the config's idle and where the inspected idle keys it. */
export interface IdleStatus { source: IdleSourceResult; keying: IdleKeying | { error: string } }
export interface IdleKeying { keys: 'ctl' | 'direct'; source: string; keyed: Record<string, string>; controls: string[] }
export function idleKeying(rig: unknown, motion: unknown): IdleKeying | { error: string } {
  if (!isObject(rig) || !Array.isArray(rig.bones)) return { error: 'IDLE_KEYS_UNKNOWN: the handoff rig.json has no bones list' };
  const idle = isObject(motion) && isObject(motion.animations) ? motion.animations.idle : undefined;
  if (!isObject(idle) || !Array.isArray(idle.tracks)) return { error: 'IDLE_KEYS_UNKNOWN: the handoff motion.json has no idle' };
  const parent = new Map<string, string | null>(rig.bones.filter(isObject).map(b => [String(b.name), typeof b.parent === 'string' ? b.parent : null]));
  // A control is `<bone>_ctl` whose child `<bone>` it parents (rig-parts `moveKeysToControls`).
  const configBone = (keyed: string) => keyed.endsWith(CONTROL_SUFFIX) && parent.get(keyed.slice(0, -CONTROL_SUFFIX.length)) === keyed ? keyed.slice(0, -CONTROL_SUFFIX.length) : keyed;
  const keyed: Record<string, string> = {}, groups = isObject(motion) && isObject(motion.groups) ? motion.groups : {};
  for (const t of idle.tracks) {
    if (!isObject(t) || typeof t.property !== 'string') continue;
    const members = typeof t.bone === 'string' ? [t.bone] : typeof t.group === 'string' && Array.isArray(groups[t.group]) ? (groups[t.group] as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    for (const m of members) keyed[`${configBone(m)}.${t.property}`] = m;
  }
  const controls = [...parent.keys()].filter(n => configBone(n) !== n).sort();
  const direct = isObject(rig.invariants) && rig.invariants.idleDrivesMeshes !== undefined;
  return direct
    ? { keys: 'direct', source: 'rig.json declares invariants.idleDrivesMeshes (rig --idle-keys direct)', keyed, controls }
    : { keys: 'ctl', source: `rig.json declares no invariants.idleDrivesMeshes, so the rig was built under --idle-keys ctl (the producer's default; a rig with no mesh-bound keyed bone is the same under both)${controls.length ? `; the idle keys ${controls.length} control(s): ${controls.join(', ')}` : ''}`, keyed, controls };
}

/**
 * The bone the preview drives for `<bone>.<prop>`: the bone the inspected idle keys for it; else, for a property the
 * idle does not key yet, the bone itself under direct keys, `<bone>_ctl` when the model already has that control, the
 * bone itself when the idle keys it directly on another property (no mesh is weighted to it). Otherwise review cannot
 * know whether the producer adds a control, and the preview is refused by name.
 */
export function previewTarget(bone: string, prop: string, keying: IdleKeying, modelBones: ReadonlySet<string>): { bone: string } | { refusal: string } {
  const known = keying.keyed[`${bone}.${prop}`];
  let target: string | null = known ?? null;
  if (target === null) {
    if (keying.keys === 'direct') target = bone;
    else if (modelBones.has(bone + CONTROL_SUFFIX)) target = bone + CONTROL_SUFFIX;
    else if (Object.values(keying.keyed).includes(bone)) target = bone;
  }
  if (target === null) return { refusal: `IDLE_PREVIEW_TARGET_UNKNOWN: ${bone}.${prop} is not keyed by the inspected idle; under --idle-keys ctl the producer keys ${bone}${CONTROL_SUFFIX} instead when a mesh is weighted to ${bone}, which review does not decide — Apply decides` };
  if (!modelBones.has(target)) return { refusal: `IDLE_PREVIEW_BONE_ABSENT: ${target} is not a bone of the drawn model — Apply decides` };
  return { bone: target };
}

export type LocalChannel = 'rotation' | 'x' | 'y' | 'scaleX' | 'scaleY' | 'shearX' | 'shearY';
/** The bone local a property keys (play's `BoneLocals`). */
export const CHANNEL: Readonly<Record<SingleProp, LocalChannel>> = { rotate: 'rotation', translatex: 'x', translatey: 'y', scalex: 'scaleX', scaley: 'scaleY', shearx: 'shearX', sheary: 'shearY' };
/** play's `LOCAL_CHANNELS`: a channel a bone does not state. */
export const SETUP_DEFAULT: Readonly<Record<LocalChannel, number>> = { rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
/** A keyed value as the bone local it poses (the Spine runtime's timelines, setup blend): a scale multiplies the setup, the rest add. */
export const localValue = (prop: SingleProp, setup: number, v: number) => prop === 'scalex' || prop === 'scaley' ? setup * v : setup + v;
/** A property with no track: the bone holds its setup value. */
export const STILL: Readonly<Record<SingleProp, number>> = { rotate: 0, translatex: 0, translatey: 0, scalex: 1, scaley: 1, shearx: 0, sheary: 0 };

export interface PreviewWrite { bone: string; channel: LocalChannel; prop: SingleProp; sine: { amp: number; period: number; phase: number; base: number } | null }
export interface PreviewPlan { writes: PreviewWrite[]; refusals: string[]; tracks: number }
/**
 * What the preview drives: every changed or added track (each chain link), and a removed track's bones held still. Each
 * write names the bone the idle keys (`previewTarget`) and its sine; a target review cannot know is refused by name and
 * left to Apply. Blink edits are not previewed (their keys are eased, not sines).
 */
export function previewPlan(source: IdleSource, state: IdleState, keying: IdleKeying, modelBones: ReadonlySet<string>): PreviewPlan {
  const writes: PreviewWrite[] = [], refusals: string[] = [];
  const add = (bone: string, prop: SingleProp, sine: PreviewWrite['sine']) => {
    const target = previewTarget(bone, prop, keying, modelBones);
    if ('refusal' in target) refusals.push(target.refusal); else writes.push({ bone: target.bone, channel: CHANNEL[prop], prop, sine });
  };
  const each = (track: IdleTrack, sine: (bone: string, prop: SingleProp, p: { amp: number; period: number; phase: number; base: number }) => void) => {
    if (isChain(track)) track.amps.forEach((_, i) => sine(`${track.chain}${i}`, 'rotate', linkSine(track, i)));
    else sine(track.bone, track.prop, { amp: track.amp, period: track.period, phase: track.phase, base: track.base ?? 0 });
  };
  let tracks = 0;
  const kept = new Set(state.entries.map(e => e.origin));
  source.tracks.forEach((track, i) => { if (!kept.has(i)) { tracks++; each(track, (bone, prop) => add(bone, prop, null)); } });
  for (const entry of state.entries) if (entryChanged(source, entry)) { tracks++; each(entry.track, (bone, prop, p) => add(bone, prop, p)); }
  return { writes, refusals, tracks };
}
/** The local a write holds at idle time `t` (`setup` is the bone's setup value of the channel). */
export function previewLocal(write: PreviewWrite, setup: number, t: number): number {
  return localValue(write.prop, setup, write.sine ? sineValue(write.sine, t) : STILL[write.prop]);
}

/**
 * Bar 1's bound, derived from how the producer keys a sine before measuring: within one key span h = period/8 the
 * bezier with the exact Hermite tangents is the cubic Hermite interpolant, off the sine by at most
 * h⁴/384·max|v⁗| = |amp|·(π/4)⁴/384; the runtime draws a bezier as 10 straight pieces (`BEZIER_PIECES`), off the
 * curve by at most (h/10)²/8·max|v''| = |amp|·(π/40)²/8; values and handles are written to 4 decimals (5e-5 between
 * them, a convex combination) and times to 6 (5e-7 s at slope |amp|·2π/period); the runtime holds the pieces' points
 * as float32 (`Math.fround`, 2⁻²⁴ relative: |base| + |amp| in value, `duration` in time at that slope). In the
 * local's units: × |setup| for a scale, and two float32 roundings of the setup-sized local (2·2⁻²⁴·|setup|).
 */
export function keySamplingBound(p: { amp: number; period: number; base?: number }, duration: number, prop: SingleProp = 'rotate', setup = 1): number {
  const a = Math.abs(p.amp), slope = a * 2 * Math.PI / p.period, f32 = 2 ** -24;
  const v = a * (Math.PI / 4) ** 4 / 384 + a * (Math.PI / 40) ** 2 / 8 + 5e-5 + slope * 5e-7 + (Math.abs(p.base ?? 0) + a) * f32 + slope * duration * f32;
  return (prop === 'scalex' || prop === 'scaley' ? Math.abs(setup) * (v + (Math.abs(p.base ?? 0) + a) * f32) : v) + Math.abs(setup) * 2 * f32 + 1e-9;
}
