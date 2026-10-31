import {
  CHANNELS,
  type AnimationInspection,
  type InspectionTrack,
  type StoredKey,
} from './animation-inspection.ts';

export const MOTION_SPEC_VERSION = 'rigc-motion/1';

export type EasingTuple = readonly [number, number, number, number];

export interface JsonSpan {
  start: number;
  end: number;
  keyStart?: number;
  keyEnd?: number;
}

interface ObjectMemberSpan {
  key: string;
  keyStart: number;
  keyEnd: number;
  colonIndex: number;
  valueStart: number;
  valueEnd: number;
}

interface ParsedObjectSpan {
  kind: 'object';
  start: number;
  end: number;
  members: ObjectMemberSpan[];
}

interface ParsedArraySpan {
  kind: 'array';
  start: number;
  end: number;
  elements: JsonSpan[];
}

interface ParsedPrimitiveSpan {
  kind: 'primitive';
  start: number;
  end: number;
}

type ParsedNodeSpan = ParsedObjectSpan | ParsedArraySpan | ParsedPrimitiveSpan;

function isWhitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) i++;
  return i;
}

function scanString(text: string, start: number): { value: string; end: number } {
  if (text.charCodeAt(start) !== 0x22 /* " */) {
    throw new Error(`ANIMATION_JSON_PARSE: expected string at offset ${start}`);
  }
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (ch === 0x22 /* " */) {
      const raw = text.slice(start, i + 1);
      return { value: JSON.parse(raw) as string, end: i + 1 };
    }
    if (ch === 0x5c /* \ */) {
      i += 2;
      continue;
    }
    i++;
  }
  throw new Error(`ANIMATION_JSON_PARSE: unterminated string at offset ${start}`);
}

function scanPrimitive(text: string, start: number): ParsedPrimitiveSpan {
  let i = start;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (
      isWhitespace(ch) ||
      ch === 0x2c /* , */ ||
      ch === 0x5d /* ] */ ||
      ch === 0x7d /* } */ ||
      ch === 0x3a /* : */
    ) {
      break;
    }
    i++;
  }
  if (i === start) {
    throw new Error(`ANIMATION_JSON_PARSE: unexpected token at offset ${start}`);
  }
  return { kind: 'primitive', start, end: i };
}

function scanNode(text: string, startIndex: number): ParsedNodeSpan {
  const start = skipWhitespace(text, startIndex);
  if (start >= text.length) {
    throw new Error('ANIMATION_JSON_PARSE: unexpected end of input');
  }
  const ch = text.charCodeAt(start);
  if (ch === 0x22 /* " */) {
    const str = scanString(text, start);
    return { kind: 'primitive', start, end: str.end };
  }
  if (ch === 0x7b /* { */) {
    const members: ObjectMemberSpan[] = [];
    let i = skipWhitespace(text, start + 1);
    if (i < text.length && text.charCodeAt(i) === 0x7d /* } */) {
      return { kind: 'object', start, end: i + 1, members };
    }
    while (i < text.length) {
      const keyStart = skipWhitespace(text, i);
      const parsedKey = scanString(text, keyStart);
      const keyEnd = parsedKey.end;
      const colonIndex = skipWhitespace(text, keyEnd);
      if (text.charCodeAt(colonIndex) !== 0x3a /* : */) {
        throw new Error(`ANIMATION_JSON_PARSE: expected ':' at offset ${colonIndex}`);
      }
      const valueNode = scanNode(text, colonIndex + 1);
      members.push({
        key: parsedKey.value,
        keyStart,
        keyEnd,
        colonIndex,
        valueStart: valueNode.start,
        valueEnd: valueNode.end,
      });
      i = skipWhitespace(text, valueNode.end);
      const nextCh = text.charCodeAt(i);
      if (nextCh === 0x2c /* , */) {
        i = skipWhitespace(text, i + 1);
        continue;
      }
      if (nextCh === 0x7d /* } */) {
        return { kind: 'object', start, end: i + 1, members };
      }
      throw new Error(`ANIMATION_JSON_PARSE: expected ',' or '}' at offset ${i}`);
    }
    throw new Error(`ANIMATION_JSON_PARSE: unterminated object at offset ${start}`);
  }
  if (ch === 0x5b /* [ */) {
    const elements: JsonSpan[] = [];
    let i = skipWhitespace(text, start + 1);
    if (i < text.length && text.charCodeAt(i) === 0x5d /* ] */) {
      return { kind: 'array', start, end: i + 1, elements };
    }
    while (i < text.length) {
      const elemNode = scanNode(text, i);
      elements.push({ start: elemNode.start, end: elemNode.end });
      i = skipWhitespace(text, elemNode.end);
      const nextCh = text.charCodeAt(i);
      if (nextCh === 0x2c /* , */) {
        i = skipWhitespace(text, i + 1);
        continue;
      }
      if (nextCh === 0x5d /* ] */) {
        return { kind: 'array', start, end: i + 1, elements };
      }
      throw new Error(`ANIMATION_JSON_PARSE: expected ',' or ']' at offset ${i}`);
    }
    throw new Error(`ANIMATION_JSON_PARSE: unterminated array at offset ${start}`);
  }
  return scanPrimitive(text, start);
}

/**
 * Locate the exact `[start, end)` byte/character span of a JSON value at `path`
 * without reformatting or parsing unrelated subtrees into a new string.
 */
export function jsonValueSpan(
  text: string,
  path: readonly (string | number)[],
): JsonSpan | null {
  let cursor = skipWhitespace(text, 0);
  let keyStart: number | undefined;
  let keyEnd: number | undefined;

  for (let depth = 0; depth < path.length; depth++) {
    const step = path[depth]!;
    const node = scanNode(text, cursor);
    if (typeof step === 'string') {
      if (node.kind !== 'object') return null;
      const member = node.members.find((m) => m.key === step);
      if (!member) return null;
      keyStart = member.keyStart;
      keyEnd = member.keyEnd;
      cursor = member.valueStart;
      if (depth === path.length - 1) {
        return {
          start: member.valueStart,
          end: member.valueEnd,
          keyStart,
          keyEnd,
        };
      }
    } else {
      if (node.kind !== 'array' || !Number.isInteger(step) || step < 0 || step >= node.elements.length) {
        return null;
      }
      const elem = node.elements[step]!;
      keyStart = undefined;
      keyEnd = undefined;
      cursor = elem.start;
      if (depth === path.length - 1) {
        return { start: elem.start, end: elem.end };
      }
    }
  }

  const root = scanNode(text, cursor);
  return { start: root.start, end: root.end };
}

function resolveObjectNode(text: string, path: readonly (string | number)[]): ParsedObjectSpan {
  const span = jsonValueSpan(text, path);
  if (!span) {
    throw new Error(`ANIMATION_SPAN_NOT_FOUND: /${path.join('/')}`);
  }
  const node = scanNode(text, span.start);
  if (node.kind !== 'object') {
    throw new Error(`ANIMATION_SPAN_NOT_OBJECT: /${path.join('/')}`);
  }
  return node;
}

function resolveArrayNode(text: string, path: readonly (string | number)[]): ParsedArraySpan {
  const span = jsonValueSpan(text, path);
  if (!span) {
    throw new Error(`ANIMATION_SPAN_NOT_FOUND: /${path.join('/')}`);
  }
  const node = scanNode(text, span.start);
  if (node.kind !== 'array') {
    throw new Error(`ANIMATION_SPAN_NOT_ARRAY: /${path.join('/')}`);
  }
  return node;
}

/**
 * Strip IEEE-754 double rounding noise (e.g. `0.08750000000000001` -> `0.0875`)
 * while preserving all significant digits of float32/authored motion numbers.
 */
export function cleanMotionNumber(n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`ANIMATION_NUMBER_NONFINITE: ${String(n)}`);
  }
  if (n === 0) return 0;
  const cleaned = Number(n.toPrecision(12));
  return cleaned === 0 ? 0 : cleaned;
}

// ---------------------------------------------------------------------------
// The two independent curve laws + thirds-line cubic seeding
// ---------------------------------------------------------------------------

/**
 * Law 1 (Time-only affine retime):
 * When segment `[t0, t1]` becomes `[nextT0, nextT1]`, scale each channel's
 * `[cx1, cx2]` affinely with no clamp and without touching `[cy1, cy2]`.
 * Identity when `t0 === nextT0 && t1 === nextT1`.
 */
export function retimeCurveX(
  curve: readonly number[],
  channels: number,
  t0: number,
  t1: number,
  nextT0: number,
  nextT1: number,
): number[] {
  if (!Number.isInteger(channels) || channels <= 0 || curve.length !== channels * 4) {
    throw new Error(
      `ANIMATION_CURVE_INVALID: expected ${channels * 4} numbers for ${channels} channel(s), got ${curve.length}`,
    );
  }
  const dt = t1 - t0;
  const nextDt = nextT1 - nextT0;
  if (!Number.isFinite(dt) || dt <= 0 || !Number.isFinite(nextDt) || nextDt <= 0) {
    throw new Error(
      `ANIMATION_KEY_ORDER: segment [${t0}, ${t1}] -> [${nextT0}, ${nextT1}] must have positive duration`,
    );
  }
  if (t0 === nextT0 && t1 === nextT1) {
    return [...curve];
  }
  const out = [...curve];
  for (let c = 0; c < channels; c++) {
    const i1 = c * 4;
    const i2 = c * 4 + 2;
    const u1 = (curve[i1]! - t0) / dt;
    const u2 = (curve[i2]! - t0) / dt;
    out[i1] = cleanMotionNumber(nextT0 + u1 * nextDt);
    out[i2] = cleanMotionNumber(nextT0 + u2 * nextDt);
  }
  return out;
}

/**
 * Law 2 (Endpoint-owned value translation):
 * Translating a key's channel value by `dv` shifts only the handle owned by that
 * endpoint (`cy1` on the key's outgoing curve, or `cy2` on the previous key's
 * incoming curve). Never scales `cy` and never touches `cx1` or `cx2`.
 */
export function translateCurveY(
  curve: readonly number[],
  channels: number,
  endpoint: 'outgoing' | 'incoming',
  deltas: readonly number[],
): number[] {
  if (!Number.isInteger(channels) || channels <= 0 || curve.length !== channels * 4) {
    throw new Error(
      `ANIMATION_CURVE_INVALID: expected ${channels * 4} numbers for ${channels} channel(s), got ${curve.length}`,
    );
  }
  if (deltas.length !== channels) {
    throw new Error(
      `ANIMATION_CHANNEL_COUNT: expected ${channels} channel delta(s), got ${deltas.length}`,
    );
  }
  const out = [...curve];
  const offset = endpoint === 'outgoing' ? 1 : 3;
  for (let c = 0; c < channels; c++) {
    const dv = deltas[c]!;
    if (!Number.isFinite(dv)) {
      throw new Error(`ANIMATION_NUMBER_NONFINITE: channel ${c} delta is ${String(dv)}`);
    }
    if (dv === 0) continue;
    const idx = c * 4 + offset;
    out[idx] = cleanMotionNumber(out[idx]! + dv);
  }
  return out;
}

/**
 * Law 3 (Thirds-line cubic seed):
 * Converting a linear, stepped, or named-easing segment `(t0, v0) -> (t1, v1)`
 * to an explicit cubic `curve` places control points at 1/3 and 2/3 along the
 * segment for every channel.
 */
export function seedCubicCurve(
  t0: number,
  v0: readonly number[],
  t1: number,
  v1: readonly number[],
): number[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
    throw new Error(`ANIMATION_KEY_ORDER: invalid segment [${t0}, ${t1}]`);
  }
  if (v0.length === 0 || v0.length !== v1.length) {
    throw new Error(`ANIMATION_CHANNEL_COUNT: channel mismatch (${v0.length} vs ${v1.length})`);
  }
  const dt = t1 - t0;
  const cx1 = cleanMotionNumber(t0 + dt / 3);
  const cx2 = cleanMotionNumber(t0 + (2 * dt) / 3);
  const out: number[] = [];
  for (let c = 0; c < v0.length; c++) {
    const a = v0[c]!;
    const b = v1[c]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error(`ANIMATION_NUMBER_NONFINITE: channel ${c} endpoint is non-finite`);
    }
    const dv = b - a;
    out.push(
      cx1,
      cleanMotionNumber(a + dv / 3),
      cx2,
      cleanMotionNumber(a + (2 * dv) / 3),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gate & Track classification (Rulings U1, U3, U4, Holes H4, H5)
// ---------------------------------------------------------------------------

export interface AnimationEditGate {
  editable: boolean;
  code:
    | 'OK'
    | 'ANIMATION_IDLE_GOVERNED_BY_TURN_PAD'
    | 'ANIMATION_SOURCE_MISSING'
    | 'ANIMATION_NOT_IN_SOURCE';
  reason: string | null;
  note: string | null;
}

export interface TrackClassification {
  trackIndex: number;
  targetKind: 'bone' | 'slot' | 'group' | 'physics' | 'path' | 'slider' | 'unknown';
  target: string;
  property: string;
  channels: number;
  editable: boolean;
  reason: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Evaluate whether an animation in a package may be edited through `animations_from`.
 */
export function checkAnimationEditGate(
  animationName: string,
  animationsFrom: string | null | undefined,
  motionDocument?: unknown,
): AnimationEditGate {
  if (animationName === 'idle') {
    return {
      editable: false,
      code: 'ANIMATION_IDLE_GOVERNED_BY_TURN_PAD',
      reason:
        'Animation "idle" is generated by rig-parts from config.json idle/blink/turn parameters; use the Turn & Idle controls.',
      note: null,
    };
  }
  if (!animationsFrom || typeof animationsFrom !== 'string' || !animationsFrom.trim()) {
    return {
      editable: false,
      code: 'ANIMATION_SOURCE_MISSING',
      reason: 'config.json does not declare an "animations_from" motion spec file.',
      note: null,
    };
  }
  if (motionDocument !== undefined) {
    if (!isRecord(motionDocument) || motionDocument.spec !== MOTION_SPEC_VERSION || !isRecord(motionDocument.animations)) {
      return {
        editable: false,
        code: 'ANIMATION_NOT_IN_SOURCE',
        reason: `Motion source "${animationsFrom}" is not a valid ${MOTION_SPEC_VERSION} document.`,
        note: null,
      };
    }
    const anim = motionDocument.animations[animationName];
    if (!isRecord(anim)) {
      return {
        editable: false,
        code: 'ANIMATION_NOT_IN_SOURCE',
        reason: `Animation "${animationName}" is not declared in "${animationsFrom}".`,
        note: null,
      };
    }
    const topNote = typeof motionDocument.note === 'string' ? motionDocument.note : null;
    const animNote = typeof anim.note === 'string' ? anim.note : null;
    return {
      editable: true,
      code: 'OK',
      reason: null,
      note: animNote ?? topNote,
    };
  }
  return { editable: true, code: 'OK', reason: null, note: null };
}

/**
 * Classify every track in `animations[animationName].tracks`:
 * only bone value tracks (`property in CHANNELS`) with finite numeric `v` arrays
 * and no `derive`, `lag`, or `stagger` are editable in v1.
 */
export function classifyAnimationTracks(
  motionDocument: unknown,
  animationName: string,
): TrackClassification[] {
  if (!isRecord(motionDocument) || !isRecord(motionDocument.animations)) return [];
  const anim = motionDocument.animations[animationName];
  if (!isRecord(anim) || !Array.isArray(anim.tracks)) return [];

  return anim.tracks.map((rawTrack, trackIndex): TrackClassification => {
    if (!isRecord(rawTrack)) {
      return {
        trackIndex,
        targetKind: 'unknown',
        target: '',
        property: '',
        channels: 0,
        editable: false,
        reason: 'track entry is not an object',
      };
    }
    const property = typeof rawTrack.property === 'string' ? rawTrack.property : '';
    const keys = Array.isArray(rawTrack.keys) ? rawTrack.keys : [];

    for (const kind of ['slot', 'group', 'physics', 'path', 'slider'] as const) {
      if (typeof rawTrack[kind] === 'string') {
        return {
          trackIndex,
          targetKind: kind,
          target: rawTrack[kind] as string,
          property,
          channels: 0,
          editable: false,
          reason: `${kind} track "${rawTrack[kind] as string}.${property}" is read-only in v1`,
        };
      }
    }

    if (typeof rawTrack.bone !== 'string') {
      return {
        trackIndex,
        targetKind: 'unknown',
        target: '',
        property,
        channels: 0,
        editable: false,
        reason: 'track has no bone target',
      };
    }

    const bone = rawTrack.bone;
    if (property === 'inherit') {
      return {
        trackIndex,
        targetKind: 'bone',
        target: bone,
        property,
        channels: 0,
        editable: false,
        reason: `bone "${bone}" inherit track is stepped mode data (read-only in v1)`,
      };
    }

    const channelSpec = CHANNELS[property];
    if (!channelSpec) {
      return {
        trackIndex,
        targetKind: 'bone',
        target: bone,
        property,
        channels: 0,
        editable: false,
        reason: `bone "${bone}" property "${property}" is not an editable value timeline`,
      };
    }

    const channels = channelSpec.length;
    if (rawTrack.lag !== undefined || rawTrack.stagger !== undefined) {
      return {
        trackIndex,
        targetKind: 'bone',
        target: bone,
        property,
        channels,
        editable: false,
        reason: `bone "${bone}.${property}" uses lag/stagger timing offset (read-only in v1)`,
      };
    }

    if (keys.some((k) => isRecord(k) && k.derive !== undefined)) {
      return {
        trackIndex,
        targetKind: 'bone',
        target: bone,
        property,
        channels,
        editable: false,
        reason: `bone "${bone}.${property}" uses procedural derive keys (read-only in v1)`,
      };
    }

    if (
      keys.length === 0 ||
      keys.some(
        (k) =>
          !isRecord(k) ||
          typeof k.t !== 'number' ||
          !Number.isFinite(k.t) ||
          !Array.isArray(k.v) ||
          k.v.length !== channels ||
          !k.v.every((n) => typeof n === 'number' && Number.isFinite(n)),
      )
    ) {
      return {
        trackIndex,
        targetKind: 'bone',
        target: bone,
        property,
        channels,
        editable: false,
        reason: `bone "${bone}.${property}" keys do not carry ${channels} finite numeric channel(s)`,
      };
    }

    return {
      trackIndex,
      targetKind: 'bone',
      target: bone,
      property,
      channels,
      editable: true,
      reason: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure span-preserving source operations
// ---------------------------------------------------------------------------

export type AnimationSourceOp =
  | {
      op: 'set_key_time';
      animation: string;
      track: number;
      key: number;
      time: number;
    }
  | {
      op: 'set_key_value';
      animation: string;
      track: number;
      key: number;
      channel?: number;
      value: number | readonly number[];
    }
  | {
      op: 'set_key_curve';
      animation: string;
      track: number;
      key: number;
      curve: readonly number[] | 'stepped' | null;
    }
  | {
      op: 'set_key_ease';
      animation: string;
      track: number;
      key: number;
      ease: string | null;
    }
  | {
      op: 'insert_key';
      animation: string;
      track: number;
      time: number;
      value: readonly number[];
      curve?: readonly number[] | 'stepped';
      ease?: string;
    }
  | {
      op: 'delete_key';
      animation: string;
      track: number;
      key: number;
    };

export interface SpanReplacement {
  start: number;
  end: number;
  replacement: string;
}

export interface AppliedAnimationOpsResult {
  text: string;
  changedSpans: { start: number; end: number }[];
}

interface KeyObjectStyle {
  braceLead: string;
  braceTrail: string;
  colonSep: string;
  memberSep: string;
  arraySep: string;
}

function detectKeyObjectStyle(text: string, keyObj: ParsedObjectSpan): KeyObjectStyle {
  const m0 = keyObj.members[0];
  const m1 = keyObj.members[1];
  const mLast = keyObj.members[keyObj.members.length - 1];
  const braceLead = m0 ? text.slice(keyObj.start + 1, m0.keyStart) : '';
  const braceTrail = mLast ? text.slice(mLast.valueEnd, keyObj.end - 1) : '';
  const colonSep = m0 ? text.slice(m0.keyEnd, m0.valueStart) : ': ';
  const memberSep = m0 && m1 ? text.slice(m0.valueEnd, m1.keyStart) : colonSep.includes(' ') ? ', ' : ',';

  let arraySep = colonSep.includes(' ') ? ', ' : ',';
  for (const m of keyObj.members) {
    const valNode = scanNode(text, m.valueStart);
    if (valNode.kind === 'array' && valNode.elements.length >= 2) {
      arraySep = text.slice(valNode.elements[0]!.end, valNode.elements[1]!.start);
      break;
    }
  }
  return { braceLead, braceTrail, colonSep, memberSep, arraySep };
}

function formatNumberArray(values: readonly number[], sep: string): string {
  return `[${values.map((v) => String(cleanMotionNumber(v))).join(sep)}]`;
}

function formatKeyObjectLiteral(
  style: KeyObjectStyle,
  key: {
    t: number;
    v: readonly number[];
    ease?: string;
    curve?: readonly number[] | 'stepped';
  },
): string {
  const parts: string[] = [
    `"t"${style.colonSep}${String(cleanMotionNumber(key.t))}`,
    `"v"${style.colonSep}${formatNumberArray(key.v, style.arraySep)}`,
  ];
  if (key.ease !== undefined) {
    parts.push(`"ease"${style.colonSep}${JSON.stringify(key.ease)}`);
  }
  if (key.curve !== undefined) {
    const curveStr =
      key.curve === 'stepped'
        ? '"stepped"'
        : formatNumberArray(key.curve, style.arraySep);
    parts.push(`"curve"${style.colonSep}${curveStr}`);
  }
  return `{${style.braceLead}${parts.join(style.memberSep)}${style.braceTrail}}`;
}

function removeObjectMemberEdit(
  keyObj: ParsedObjectSpan,
  memberIndex: number,
): SpanReplacement {
  const target = keyObj.members[memberIndex]!;
  if (keyObj.members.length === 1) {
    return { start: target.keyStart, end: target.valueEnd, replacement: '' };
  }
  if (memberIndex > 0) {
    const prev = keyObj.members[memberIndex - 1]!;
    return { start: prev.valueEnd, end: target.valueEnd, replacement: '' };
  }
  const next = keyObj.members[1]!;
  return { start: target.keyStart, end: next.keyStart, replacement: '' };
}

/**
 * Produce the minimal span replacements on `keyObj` to set or clear `curve` / `ease`
 * while enforcing Rule R6 (`ease` XOR `curve`).
 */
function buildKeyEasingEdits(
  text: string,
  keyObj: ParsedObjectSpan,
  nextState: { curve?: readonly number[] | 'stepped' | null; ease?: string | null },
  baseCurveRawValue?: string,
): SpanReplacement[] {
  const style = detectKeyObjectStyle(text, keyObj);
  const easeIdx = keyObj.members.findIndex((m) => m.key === 'ease');
  const curveIdx = keyObj.members.findIndex((m) => m.key === 'curve');

  const wantCurve = nextState.curve !== undefined ? nextState.curve : null;
  const wantEase = nextState.ease !== undefined ? nextState.ease : null;

  // Case 1: clear both ease and curve
  if (wantCurve === null && wantEase === null) {
    const edits: SpanReplacement[] = [];
    if (easeIdx >= 0 && curveIdx >= 0) {
      const firstIdx = Math.min(easeIdx, curveIdx);
      const secondIdx = Math.max(easeIdx, curveIdx);
      if (firstIdx > 0 && secondIdx === firstIdx + 1) {
        const prev = keyObj.members[firstIdx - 1]!;
        const second = keyObj.members[secondIdx]!;
        edits.push({ start: prev.valueEnd, end: second.valueEnd, replacement: '' });
        return edits;
      }
    }
    if (easeIdx >= 0) edits.push(removeObjectMemberEdit(keyObj, easeIdx));
    if (curveIdx >= 0) edits.push(removeObjectMemberEdit(keyObj, curveIdx));
    return edits;
  }

  // Case 2: set curve (and remove ease if present)
  if (wantCurve !== null) {
    let formattedCurve =
      wantCurve === 'stepped'
        ? '"stepped"'
        : formatNumberArray(wantCurve, style.arraySep);
    let baseCurveElems: string[] | undefined;
    if (baseCurveRawValue !== undefined && Array.isArray(wantCurve)) {
      try {
        const node = scanNode(baseCurveRawValue, 0);
        if (node.kind === 'array' && node.elements.length === wantCurve.length) {
          baseCurveElems = node.elements.map((e) => baseCurveRawValue.slice(e.start, e.end));
          if (baseCurveElems.every((raw, i) => Number(raw) === cleanMotionNumber(wantCurve[i]!))) {
            formattedCurve = baseCurveRawValue;
          }
        }
      } catch {
        // ignore
      }
    }

    if (curveIdx >= 0 && easeIdx < 0) {
      const curveMember = keyObj.members[curveIdx]!;
      if (Array.isArray(wantCurve)) {
        const existingNode = scanNode(text, curveMember.valueStart);
        if (existingNode.kind === 'array' && existingNode.elements.length === wantCurve.length) {
          const elemEdits: SpanReplacement[] = [];
          for (let i = 0; i < wantCurve.length; i++) {
            const elem = existingNode.elements[i]!;
            const rawElem = text.slice(elem.start, elem.end);
            const nextStr = formatNumberWithRawStyle(wantCurve[i]!, rawElem, baseCurveElems?.[i]);
            if (rawElem !== nextStr) {
              elemEdits.push({ start: elem.start, end: elem.end, replacement: nextStr });
            }
          }
          return elemEdits;
        }
      }
      if (text.slice(curveMember.valueStart, curveMember.valueEnd) === formattedCurve) {
        return [];
      }
      return [
        {
          start: curveMember.valueStart,
          end: curveMember.valueEnd,
          replacement: formattedCurve,
        },
      ];
    }

    if (easeIdx >= 0 && curveIdx < 0) {
      const easeMember = keyObj.members[easeIdx]!;
      return [
        {
          start: easeMember.keyStart,
          end: easeMember.valueEnd,
          replacement: `"curve"${style.colonSep}${formattedCurve}`,
        },
      ];
    }

    const edits: SpanReplacement[] = [];
    if (easeIdx >= 0) edits.push(removeObjectMemberEdit(keyObj, easeIdx));
    if (curveIdx >= 0) {
      const curveMember = keyObj.members[curveIdx]!;
      edits.push({
        start: curveMember.valueStart,
        end: curveMember.valueEnd,
        replacement: formattedCurve,
      });
      return edits;
    }
    const lastMember = keyObj.members[keyObj.members.length - 1]!;
    edits.push({
      start: lastMember.valueEnd,
      end: lastMember.valueEnd,
      replacement: `${style.memberSep}"curve"${style.colonSep}${formattedCurve}`,
    });
    return edits;
  }

  // Case 3: set ease (and remove curve if present)
  const formattedEase = JSON.stringify(wantEase);
  if (easeIdx >= 0 && curveIdx < 0) {
    const easeMember = keyObj.members[easeIdx]!;
    if (text.slice(easeMember.valueStart, easeMember.valueEnd) === formattedEase) {
      return [];
    }
    return [
      {
        start: easeMember.valueStart,
        end: easeMember.valueEnd,
        replacement: formattedEase,
      },
    ];
  }
  if (curveIdx >= 0 && easeIdx < 0) {
    const curveMember = keyObj.members[curveIdx]!;
    return [
      {
        start: curveMember.keyStart,
        end: curveMember.valueEnd,
        replacement: `"ease"${style.colonSep}${formattedEase}`,
      },
    ];
  }
  const edits: SpanReplacement[] = [];
  if (curveIdx >= 0) edits.push(removeObjectMemberEdit(keyObj, curveIdx));
  if (easeIdx >= 0) {
    const easeMember = keyObj.members[easeIdx]!;
    edits.push({
      start: easeMember.valueStart,
      end: easeMember.valueEnd,
      replacement: formattedEase,
    });
    return edits;
  }
  const lastMember = keyObj.members[keyObj.members.length - 1]!;
  edits.push({
    start: lastMember.valueEnd,
    end: lastMember.valueEnd,
    replacement: `${style.memberSep}"ease"${style.colonSep}${formattedEase}`,
  });
  return edits;
}

function formatNumberWithRawStyle(
  nextNum: number,
  rawElem: string,
  baseRawElem?: string,
): string {
  const cleaned = cleanMotionNumber(nextNum);
  if (baseRawElem !== undefined && Number(baseRawElem) === cleaned) {
    return baseRawElem;
  }
  if (Number(rawElem) === cleaned) return rawElem;
  if (Number.isInteger(cleaned) && /^-?\d+\.0$/.test(rawElem)) {
    return cleaned.toFixed(1);
  }
  return String(cleaned);
}

function buildCurveElementsReplacement(
  text: string,
  keyObj: ParsedObjectSpan,
  nextCurve: readonly number[],
  baseCurveRawElems?: readonly string[],
): SpanReplacement[] {
  const curveMember = keyObj.members.find((m) => m.key === 'curve');
  if (!curveMember) return [];
  const curveNode = scanNode(text, curveMember.valueStart);
  if (curveNode.kind !== 'array' || curveNode.elements.length !== nextCurve.length) {
    const style = detectKeyObjectStyle(text, keyObj);
    return [
      {
        start: curveMember.valueStart,
        end: curveMember.valueEnd,
        replacement: formatNumberArray(nextCurve, style.arraySep),
      },
    ];
  }
  const edits: SpanReplacement[] = [];
  for (let i = 0; i < nextCurve.length; i++) {
    const elem = curveNode.elements[i]!;
    const rawElem = text.slice(elem.start, elem.end);
    const nextStr = formatNumberWithRawStyle(
      nextCurve[i]!,
      rawElem,
      baseCurveRawElems?.[i],
    );
    if (rawElem !== nextStr) {
      edits.push({ start: elem.start, end: elem.end, replacement: nextStr });
    }
  }
  return edits;
}

function readRawArrayElements(
  baseText: string | undefined,
  path: readonly (string | number)[],
): string[] | undefined {
  if (!baseText) return undefined;
  const span = jsonValueSpan(baseText, path);
  if (!span) return undefined;
  const node = scanNode(baseText, span.start);
  if (node.kind !== 'array') return undefined;
  return node.elements.map((e) => baseText.slice(e.start, e.end));
}

function applySpanReplacements(
  text: string,
  replacements: readonly SpanReplacement[],
): { text: string; changedSpans: { start: number; end: number }[] } {
  if (replacements.length === 0) {
    return { text, changedSpans: [] };
  }
  const sorted = [...replacements].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.start < prev.end) {
      throw new Error(
        `ANIMATION_OVERLAPPING_SPANS: [${prev.start}, ${prev.end}) overlaps [${curr.start}, ${curr.end})`,
      );
    }
  }

  let out = '';
  let cursor = 0;
  const changedSpans: { start: number; end: number }[] = [];
  for (const edit of sorted) {
    out += text.slice(cursor, edit.start);
    const newStart = out.length;
    out += edit.replacement;
    const newEnd = out.length;
    changedSpans.push({ start: newStart, end: newEnd });
    cursor = edit.end;
  }
  out += text.slice(cursor);
  return { text: out, changedSpans };
}

interface ValidatedTrackContext {
  doc: Record<string, unknown>;
  classification: TrackClassification;
  keys: Array<{
    t: number;
    v: number[];
    ease?: string;
    curve?: number[] | 'stepped';
  }>;
}

function resolveEditableTrack(
  text: string,
  animation: string,
  trackIndex: number,
): ValidatedTrackContext {
  const doc = JSON.parse(text) as unknown;
  const gate = checkAnimationEditGate(animation, 'animations.json', doc);
  if (!gate.editable) {
    throw new Error(`${gate.code}: ${gate.reason}`);
  }
  const classifications = classifyAnimationTracks(doc, animation);
  if (!Number.isInteger(trackIndex) || trackIndex < 0 || trackIndex >= classifications.length) {
    throw new Error(
      `ANIMATION_TRACK_OUT_OF_RANGE: animation "${animation}" has ${classifications.length} track(s), got index ${trackIndex}`,
    );
  }
  const classification = classifications[trackIndex]!;
  if (!classification.editable) {
    throw new Error(`ANIMATION_TRACK_READ_ONLY: ${classification.reason}`);
  }
  const animObj = (doc as { animations: Record<string, { tracks: Array<{ keys: ValidatedTrackContext['keys'] }> }> })
    .animations[animation]!;
  const keys = animObj.tracks[trackIndex]!.keys;
  return { doc: doc as Record<string, unknown>, classification, keys };
}

/**
 * Apply a single pure source operation to a `rigc-motion/1` JSON string,
 * touching only the target value/key span(s) and any curve handle spans coupled
 * by Law 1 or Law 2.
 */
export function applyAnimationOp(
  text: string,
  op: AnimationSourceOp,
  baseText?: string,
): AppliedAnimationOpsResult {
  const { doc, classification, keys } = resolveEditableTrack(text, op.animation, op.track);
  const channels = classification.channels;
  const keysPath = ['animations', op.animation, 'tracks', op.track, 'keys'] as const;

  if (op.op === 'set_key_time') {
    if (!Number.isInteger(op.key) || op.key < 0 || op.key >= keys.length) {
      throw new Error(`ANIMATION_KEY_OUT_OF_RANGE: key index ${op.key} out of [0, ${keys.length - 1}]`);
    }
    if (typeof op.time !== 'number' || !Number.isFinite(op.time) || op.time < 0) {
      throw new Error(`ANIMATION_KEY_TIME_INVALID: key time must be a finite number >= 0, got ${String(op.time)}`);
    }
    const nextTime = cleanMotionNumber(op.time);
    const prevKey = op.key > 0 ? keys[op.key - 1] : undefined;
    const nextKey = op.key + 1 < keys.length ? keys[op.key + 1] : undefined;
    if (prevKey && nextTime <= prevKey.t) {
      throw new Error(
        `ANIMATION_KEY_ORDER: key ${op.key} time ${nextTime} must be > previous key ${op.key - 1} time ${prevKey.t}`,
      );
    }
    if (nextKey && nextTime >= nextKey.t) {
      throw new Error(
        `ANIMATION_KEY_ORDER: key ${op.key} time ${nextTime} must be < next key ${op.key + 1} time ${nextKey.t}`,
      );
    }

    const currentKey = keys[op.key]!;
    if (currentKey.t === nextTime) {
      return { text, changedSpans: [] };
    }

    const edits: SpanReplacement[] = [];
    const tSpan = jsonValueSpan(text, [...keysPath, op.key, 't']);
    if (!tSpan) throw new Error('ANIMATION_SPAN_NOT_FOUND: key.t');
    const rawT = text.slice(tSpan.start, tSpan.end);
    const baseTSpan = baseText ? jsonValueSpan(baseText, [...keysPath, op.key, 't']) : null;
    const baseRawT = baseTSpan && baseText ? baseText.slice(baseTSpan.start, baseTSpan.end) : undefined;
    const nextTimeStr = formatNumberWithRawStyle(nextTime, rawT, baseRawT);
    if (rawT !== nextTimeStr) {
      edits.push({ start: tSpan.start, end: tSpan.end, replacement: nextTimeStr });
    }

    // Law 1 on previous key's curve if segment [prevKey.t, currentKey.t] -> [prevKey.t, nextTime]
    if (prevKey && Array.isArray(prevKey.curve)) {
      const retimedPrev = retimeCurveX(
        prevKey.curve,
        channels,
        prevKey.t,
        currentKey.t,
        prevKey.t,
        nextTime,
      );
      const prevKeyObj = resolveObjectNode(text, [...keysPath, op.key - 1]);
      const basePrevCurve = readRawArrayElements(baseText, [...keysPath, op.key - 1, 'curve']);
      edits.push(...buildCurveElementsReplacement(text, prevKeyObj, retimedPrev, basePrevCurve));
    }

    // Law 1 on current key's curve if segment [currentKey.t, nextKey.t] -> [nextTime, nextKey.t]
    if (nextKey && Array.isArray(currentKey.curve)) {
      const retimedCurr = retimeCurveX(
        currentKey.curve,
        channels,
        currentKey.t,
        nextKey.t,
        nextTime,
        nextKey.t,
      );
      const currKeyObj = resolveObjectNode(text, [...keysPath, op.key]);
      const baseCurrCurve = readRawArrayElements(baseText, [...keysPath, op.key, 'curve']);
      edits.push(...buildCurveElementsReplacement(text, currKeyObj, retimedCurr, baseCurrCurve));
    }

    return applySpanReplacements(text, edits);
  }

  if (op.op === 'set_key_value') {
    if (!Number.isInteger(op.key) || op.key < 0 || op.key >= keys.length) {
      throw new Error(`ANIMATION_KEY_OUT_OF_RANGE: key index ${op.key} out of [0, ${keys.length - 1}]`);
    }
    const currentKey = keys[op.key]!;
    const nextValues = [...currentKey.v];

    if (op.channel !== undefined) {
      if (!Number.isInteger(op.channel) || op.channel < 0 || op.channel >= channels) {
        throw new Error(`ANIMATION_CHANNEL_OUT_OF_RANGE: channel ${op.channel} out of [0, ${channels - 1}]`);
      }
      if (typeof op.value !== 'number' || !Number.isFinite(op.value)) {
        throw new Error(`ANIMATION_VALUE_INVALID: expected finite number for channel ${op.channel}`);
      }
      nextValues[op.channel] = cleanMotionNumber(op.value);
    } else {
      if (
        !Array.isArray(op.value) ||
        op.value.length !== channels ||
        !op.value.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error(`ANIMATION_VALUE_INVALID: expected array of ${channels} finite number(s)`);
      }
      for (let c = 0; c < channels; c++) {
        nextValues[c] = cleanMotionNumber(op.value[c]!);
      }
    }

    const deltas = nextValues.map((nv, c) => cleanMotionNumber(nv - currentKey.v[c]!));
    if (deltas.every((d) => d === 0)) {
      return { text, changedSpans: [] };
    }

    const edits: SpanReplacement[] = [];
    const vArray = resolveArrayNode(text, [...keysPath, op.key, 'v']);
    const baseVElems = readRawArrayElements(baseText, [...keysPath, op.key, 'v']);
    for (let c = 0; c < channels; c++) {
      if (deltas[c] === 0) continue;
      const elemSpan = vArray.elements[c]!;
      const rawV = text.slice(elemSpan.start, elemSpan.end);
      const nextStr = formatNumberWithRawStyle(nextValues[c]!, rawV, baseVElems?.[c]);
      if (rawV !== nextStr) {
        edits.push({ start: elemSpan.start, end: elemSpan.end, replacement: nextStr });
      }
    }

    // Law 2 on current key's outgoing handle cy1
    if (op.key + 1 < keys.length && Array.isArray(currentKey.curve)) {
      const translatedCurr = translateCurveY(currentKey.curve, channels, 'outgoing', deltas);
      const currKeyObj = resolveObjectNode(text, [...keysPath, op.key]);
      const baseCurrCurve = readRawArrayElements(baseText, [...keysPath, op.key, 'curve']);
      edits.push(...buildCurveElementsReplacement(text, currKeyObj, translatedCurr, baseCurrCurve));
    }

    // Law 2 on previous key's incoming handle cy2
    const prevKey = op.key > 0 ? keys[op.key - 1] : undefined;
    if (prevKey && Array.isArray(prevKey.curve)) {
      const translatedPrev = translateCurveY(prevKey.curve, channels, 'incoming', deltas);
      const prevKeyObj = resolveObjectNode(text, [...keysPath, op.key - 1]);
      const basePrevCurve = readRawArrayElements(baseText, [...keysPath, op.key - 1, 'curve']);
      edits.push(...buildCurveElementsReplacement(text, prevKeyObj, translatedPrev, basePrevCurve));
    }

    return applySpanReplacements(text, edits);
  }

  if (op.op === 'set_key_curve') {
    if (!Number.isInteger(op.key) || op.key < 0 || op.key >= keys.length) {
      throw new Error(`ANIMATION_KEY_OUT_OF_RANGE: key index ${op.key} out of [0, ${keys.length - 1}]`);
    }
    if (op.curve !== null && op.key === keys.length - 1) {
      throw new Error('ANIMATION_LAST_KEY_CURVE: the last key of a track cannot carry a curve');
    }
    if (op.curve !== null && op.curve !== 'stepped') {
      if (
        !Array.isArray(op.curve) ||
        op.curve.length !== channels * 4 ||
        !op.curve.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error(
          `ANIMATION_CURVE_INVALID: curve must be "stepped", null, or ${channels * 4} finite numbers`,
        );
      }
    }
    const keyObj = resolveObjectNode(text, [...keysPath, op.key]);
    const baseCurveSpan = baseText ? jsonValueSpan(baseText, [...keysPath, op.key, 'curve']) : null;
    const baseCurveRaw =
      baseCurveSpan && baseText ? baseText.slice(baseCurveSpan.start, baseCurveSpan.end) : undefined;
    const edits = buildKeyEasingEdits(text, keyObj, { curve: op.curve, ease: null }, baseCurveRaw);
    return applySpanReplacements(text, edits);
  }

  if (op.op === 'set_key_ease') {
    if (!Number.isInteger(op.key) || op.key < 0 || op.key >= keys.length) {
      throw new Error(`ANIMATION_KEY_OUT_OF_RANGE: key index ${op.key} out of [0, ${keys.length - 1}]`);
    }
    if (op.ease !== null && op.key === keys.length - 1) {
      throw new Error('ANIMATION_LAST_KEY_EASING: the last key of a track cannot carry an easing');
    }
    if (op.ease !== null) {
      if (op.ease === 'stepped') {
        throw new Error('ANIMATION_EASING_STEPPED_USE_CURVE: "stepped" is a curve mode; use curve: "stepped"');
      }
      const easings = isRecord(doc.easings) ? doc.easings : {};
      if (!Array.isArray(easings[op.ease])) {
        throw new Error(`ANIMATION_EASING_UNKNOWN: unknown easing "${op.ease}"`);
      }
    }
    const keyObj = resolveObjectNode(text, [...keysPath, op.key]);
    const edits = buildKeyEasingEdits(text, keyObj, { ease: op.ease, curve: null });
    return applySpanReplacements(text, edits);
  }

  if (op.op === 'insert_key') {
    if (typeof op.time !== 'number' || !Number.isFinite(op.time) || op.time < 0) {
      throw new Error(`ANIMATION_KEY_TIME_INVALID: key time must be a finite number >= 0, got ${String(op.time)}`);
    }
    const insertTime = cleanMotionNumber(op.time);
    if (keys.some((k) => k.t === insertTime)) {
      throw new Error(`ANIMATION_KEY_DUPLICATE_TIME: a key already exists at t=${insertTime}`);
    }
    if (
      !Array.isArray(op.value) ||
      op.value.length !== channels ||
      !op.value.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new Error(`ANIMATION_VALUE_INVALID: expected ${channels} finite channel value(s)`);
    }
    if (op.curve !== undefined && op.ease !== undefined) {
      throw new Error('ANIMATION_KEY_EASING_AND_CURVE: a key cannot carry both ease and curve');
    }
    const insertIndex = keys.findIndex((k) => k.t > insertTime);
    const targetIdx = insertIndex === -1 ? keys.length : insertIndex;
    const isLast = targetIdx === keys.length;
    if (isLast && op.curve !== undefined) {
      throw new Error('ANIMATION_LAST_KEY_CURVE: the last key of a track cannot carry a curve');
    }
    if (isLast && op.ease !== undefined) {
      throw new Error('ANIMATION_LAST_KEY_EASING: the last key of a track cannot carry an easing');
    }
    if (op.curve !== undefined && op.curve !== 'stepped') {
      if (
        !Array.isArray(op.curve) ||
        op.curve.length !== channels * 4 ||
        !op.curve.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error(`ANIMATION_CURVE_INVALID: expected ${channels * 4} finite numbers`);
      }
    }
    if (op.ease !== undefined) {
      if (op.ease === 'stepped') {
        throw new Error('ANIMATION_EASING_STEPPED_USE_CURVE: "stepped" is a curve mode; use curve: "stepped"');
      }
      const easings = isRecord(doc.easings) ? doc.easings : {};
      if (!Array.isArray(easings[op.ease])) {
        throw new Error(`ANIMATION_EASING_UNKNOWN: unknown easing "${op.ease}"`);
      }
    }

    const keysArray = resolveArrayNode(text, keysPath);
    const refKeyIndex = targetIdx > 0 ? targetIdx - 1 : 0;
    const refKeyObj = resolveObjectNode(text, [...keysPath, refKeyIndex]);
    const style = detectKeyObjectStyle(text, refKeyObj);
    const newKeyLiteral = formatKeyObjectLiteral(style, {
      t: insertTime,
      v: op.value.map(cleanMotionNumber),
      ease: op.ease,
      curve: op.curve,
    });

    let elemSep = style.memberSep;
    if (keysArray.elements.length >= 2) {
      const sepIdx = Math.min(targetIdx > 0 ? targetIdx - 1 : 0, keysArray.elements.length - 2);
      elemSep = text.slice(
        keysArray.elements[sepIdx]!.end,
        keysArray.elements[sepIdx + 1]!.start,
      );
    } else if (keysArray.elements.length === 1) {
      const lead = text.slice(keysArray.start + 1, keysArray.elements[0]!.start);
      elemSep = lead.includes('\n') ? `,${lead}` : style.memberSep;
    }

    const edits: SpanReplacement[] = [];

    // If inserted between [targetIdx - 1, targetIdx], retime previous key's numeric curve
    if (targetIdx > 0 && targetIdx < keys.length) {
      const prevKey = keys[targetIdx - 1]!;
      const nextKey = keys[targetIdx]!;
      if (Array.isArray(prevKey.curve)) {
        const retimedPrev = retimeCurveX(
          prevKey.curve,
          channels,
          prevKey.t,
          nextKey.t,
          prevKey.t,
          insertTime,
        );
        const prevKeyObj = resolveObjectNode(text, [...keysPath, targetIdx - 1]);
        edits.push(...buildCurveElementsReplacement(text, prevKeyObj, retimedPrev));
      }
    }

    if (targetIdx > 0) {
      const prevElem = keysArray.elements[targetIdx - 1]!;
      edits.push({
        start: prevElem.end,
        end: prevElem.end,
        replacement: `${elemSep}${newKeyLiteral}`,
      });
    } else {
      const firstElem = keysArray.elements[0]!;
      edits.push({
        start: firstElem.start,
        end: firstElem.start,
        replacement: `${newKeyLiteral}${elemSep}`,
      });
    }

    return applySpanReplacements(text, edits);
  }

  if (op.op === 'delete_key') {
    if (!Number.isInteger(op.key) || op.key < 0 || op.key >= keys.length) {
      throw new Error(`ANIMATION_KEY_OUT_OF_RANGE: key index ${op.key} out of [0, ${keys.length - 1}]`);
    }
    if (keys.length <= 1) {
      throw new Error('ANIMATION_TRACK_MIN_KEYS: cannot delete the only key on a track');
    }

    const keysArray = resolveArrayNode(text, keysPath);
    const edits: SpanReplacement[] = [];

    // If deleting the last key, strip any curve/ease on the new last key (key - 1)
    if (op.key === keys.length - 1) {
      const newLastKey = keys[op.key - 1]!;
      if (newLastKey.curve !== undefined || newLastKey.ease !== undefined) {
        const prevKeyObj = resolveObjectNode(text, [...keysPath, op.key - 1]);
        edits.push(...buildKeyEasingEdits(text, prevKeyObj, { curve: null, ease: null }));
      }
    } else if (op.key > 0) {
      // Deleting an interior key: retime previous key's numeric curve to the new next key
      const prevKey = keys[op.key - 1]!;
      const currKey = keys[op.key]!;
      const nextKey = keys[op.key + 1]!;
      if (Array.isArray(prevKey.curve)) {
        const retimedPrev = retimeCurveX(
          prevKey.curve,
          channels,
          prevKey.t,
          currKey.t,
          prevKey.t,
          nextKey.t,
        );
        const prevKeyObj = resolveObjectNode(text, [...keysPath, op.key - 1]);
        edits.push(...buildCurveElementsReplacement(text, prevKeyObj, retimedPrev));
      }
    }

    if (op.key > 0) {
      const prevElem = keysArray.elements[op.key - 1]!;
      const currElem = keysArray.elements[op.key]!;
      edits.push({ start: prevElem.end, end: currElem.end, replacement: '' });
    } else {
      const currElem = keysArray.elements[0]!;
      const nextElem = keysArray.elements[1]!;
      edits.push({ start: currElem.start, end: nextElem.start, replacement: '' });
    }

    return applySpanReplacements(text, edits);
  }

  const exhaustive: never = op;
  throw new Error(`ANIMATION_OP_UNKNOWN: ${JSON.stringify(exhaustive)}`);
}

/**
 * Apply a sequence of pure source ops to `text`.
 * When `ops` is empty, returns `{ text, changedSpans: [] }` byte-identically.
 */
export function applyAnimationOps(
  text: string,
  ops: readonly AnimationSourceOp[],
): AppliedAnimationOpsResult {
  let current = text;
  const allSpans: { start: number; end: number }[] = [];
  for (const op of ops) {
    const res = applyAnimationOp(current, op, text);
    current = res.text;
    allSpans.push(...res.changedSpans);
  }
  return { text: current, changedSpans: allSpans };
}

/**
 * Stateful builder over an immutable base `animations_from` text.
 * Supports applying, coalescing, undoing, and reverting edits while guaranteeing
 * that reverting all ops yields the exact original bytes.
 */
export class AnimationOpBuilder {
  readonly baseText: string;
  private currentText: string;
  private readonly history: Array<{ op: AnimationSourceOp; textBefore: string }> = [];

  constructor(baseText: string) {
    this.baseText = baseText;
    this.currentText = baseText;
  }

  get text(): string {
    return this.currentText;
  }

  get ops(): readonly AnimationSourceOp[] {
    return this.history.map((h) => h.op);
  }

  get dirty(): boolean {
    return this.currentText !== this.baseText;
  }

  apply(op: AnimationSourceOp): AppliedAnimationOpsResult {
    const res = applyAnimationOp(this.currentText, op, this.baseText);
    this.history.push({ op, textBefore: this.currentText });
    this.currentText = res.text;
    return res;
  }

  undo(): boolean {
    const last = this.history.pop();
    if (!last) return false;
    this.currentText = last.textBefore;
    return true;
  }

  revert(): string {
    this.history.length = 0;
    this.currentText = this.baseText;
    return this.currentText;
  }
}

// ---------------------------------------------------------------------------
// Pending-preview adapter into src/animation-inspection.ts (Correction 7)
// ---------------------------------------------------------------------------

function f32(n: number): number {
  return Math.fround(n);
}

function resolveKeyCurveForInspection(
  key: { t: number; v: readonly number[]; ease?: string; curve?: readonly number[] | 'stepped' },
  nextKey: { t: number; v: readonly number[] } | undefined,
  easings: Readonly<Record<string, EasingTuple>> | undefined,
): number[] | 'stepped' | undefined {
  if (!nextKey) return undefined;
  if (key.curve !== undefined) {
    return key.curve === 'stepped' ? 'stepped' : [...key.curve];
  }
  if (key.ease === undefined) return undefined;
  if (key.ease === 'stepped') return 'stepped';
  const handles = easings?.[key.ease];
  if (!handles || handles.length !== 4) return undefined;
  const isHold =
    key.v.length === nextKey.v.length && key.v.every((v, c) => f32(v) === f32(nextKey.v[c]!));
  if (isHold) return 'stepped';
  const [hx1, hy1, hx2, hy2] = handles;
  const dt = nextKey.t - key.t;
  const out: number[] = [];
  for (let c = 0; c < key.v.length; c++) {
    const v1 = key.v[c]!;
    const dv = nextKey.v[c]! - v1;
    out.push(
      cleanMotionNumber(key.t + dt * hx1),
      cleanMotionNumber(v1 + dv * hy1),
      cleanMotionNumber(key.t + dt * hx2),
      cleanMotionNumber(v1 + dv * hy2),
    );
  }
  return out;
}

/**
 * Project an editable bone value track from a `rigc-motion/1` document into an
 * `InspectionTrack` so `evaluateStoredChannel` and `evaluateBoneLocals` in
 * `src/animation-inspection.ts` evaluate pending edits directly with no second evaluator.
 */
export function draftTrackToInspectionTrack(
  track: {
    bone: string;
    property: string;
    keys: ReadonlyArray<{
      t: number;
      v: readonly number[];
      ease?: string;
      curve?: readonly number[] | 'stepped';
    }>;
  },
  pointer = `/draft/bones/${track.bone}/${track.property}`,
  easings?: Readonly<Record<string, EasingTuple>>,
): InspectionTrack {
  const channelSpec = CHANNELS[track.property];
  if (!channelSpec) {
    throw new Error(`ANIMATION_TRACK_READ_ONLY: unsupported bone property "${track.property}"`);
  }
  const storedKeys: StoredKey[] = track.keys.map((k, idx) => {
    const entry: StoredKey = { time: k.t };
    channelSpec.forEach((ch, c) => {
      entry[ch.field] = k.v[c]!;
    });
    const curve = resolveKeyCurveForInspection(k, track.keys[idx + 1], easings);
    if (curve !== undefined) {
      entry.curve = curve;
    }
    return entry;
  });
  return {
    kind: 'bone',
    target: track.bone,
    name: track.property,
    pointer,
    keys: storedKeys,
  };
}

/**
 * Overlay all editable bone value tracks from a draft `rigc-motion/1` text onto
 * an existing `AnimationInspection`, returning a new `AnimationInspection` that
 * `evaluateStoredChannel` and `evaluateBoneLocals` can evaluate at any time `t`.
 */
export function overlayDraftOnInspection(
  inspection: AnimationInspection,
  draftMotionText: string,
): AnimationInspection {
  const doc = JSON.parse(draftMotionText) as Record<string, unknown>;
  if (!isRecord(doc.animations)) return inspection;
  const anim = doc.animations[inspection.name];
  if (!isRecord(anim) || !Array.isArray(anim.tracks)) return inspection;
  const rawTracks = anim.tracks as unknown[];

  const easings = isRecord(doc.easings)
    ? (doc.easings as Readonly<Record<string, EasingTuple>>)
    : undefined;
  const classifications = classifyAnimationTracks(doc, inspection.name);
  const replacementByKey = new Map<string, InspectionTrack>();

  classifications.forEach((cls, idx) => {
    if (!cls.editable) return;
    const rawTrack = rawTracks[idx] as {
      bone: string;
      property: string;
      keys: ReadonlyArray<{
        t: number;
        v: readonly number[];
        ease?: string;
        curve?: readonly number[] | 'stepped';
      }>;
    };
    const key = `${rawTrack.bone}\0${rawTrack.property}`;
    const existing = inspection.tracks.find(
      (t) => t.kind === 'bone' && t.target === rawTrack.bone && t.name === rawTrack.property,
    );
    replacementByKey.set(
      key,
      draftTrackToInspectionTrack(
        rawTrack,
        existing?.pointer ?? `/animations/0/bones/${idx}/timelines/0`,
        easings,
      ),
    );
  });

  const usedKeys = new Set<string>();
  const nextTracks: InspectionTrack[] = inspection.tracks.map((t) => {
    if (t.kind !== 'bone') return t;
    const key = `${t.target}\0${t.name}`;
    const rep = replacementByKey.get(key);
    if (!rep) return t;
    usedKeys.add(key);
    return rep;
  });

  for (const [key, rep] of replacementByKey.entries()) {
    if (!usedKeys.has(key)) nextTracks.push(rep);
  }

  return {
    ...inspection,
    tracks: nextTracks,
  };
}
