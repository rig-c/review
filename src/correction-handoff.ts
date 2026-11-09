/** Internal projection from canonical Review evidence. No filesystem, wire format or create invocation. */
import { isDeepStrictEqual } from 'node:util';
import { APPLIED_ANIMATION_SCHEMA, APPLIED_DELTA_SCHEMA, APPLIED_PATCH_SCHEMA, APPLIED_RETARGET_SCHEMA, parseAppliedContext, type AppliedPatch } from './applied-context.ts';
import { patchSha256, patchText } from './config-patch.ts';
import type { PartsVerdict } from './parts-view.ts';
import type { Feedback, ReviewSession } from './session.ts';
import type { DirectionInspection } from './direction-inspection.ts';
import { hasStageComment, parseStageComment } from './stage-comment.ts';

type Selector =
  | { stage: 'parts-review'; kind: 'parts'; inventory: string }
  | { stage: 'parts-review'; kind: 'draft'; id: string }
  | { stage: 'rig-review'; kind: 'rig'; version: number }
  | { stage: 'direction-review'; kind: 'post'; version: number; modelFile: string };

type SessionSource = Pick<ReviewSession, 'id' | 'revision' | 'sourceHash' | 'reviewedSource'>;
type SessionSelector = Exclude<Selector, { kind: 'parts' }>;

/**
 * The caller must obtain this from the verified server-side settled Apply and
 * independently verify the retained operation and result bytes. Client context
 * or a status flag cannot establish this precondition.
 */
interface SettledEvidence {
  source: SessionSource;
  applied: unknown;
  operationSha256: string;
  modelSha256: string;
}

type SessionInput = {
  // Already read and validated through Review's canonical saved-session path.
  session: ReviewSession;
  // Exact bytes of the same retained session, validated by the reader.
  sessionBytes: Uint8Array;
  source: SessionSource;
  selector: SessionSelector;
  itemId: string;
  direction?: DirectionInspection;
} & ({ path: 'described' } | { path: 'made'; settled?: SettledEvidence });

const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const id = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
const checkStatuses = new Set(['PASS', 'SKIP', 'WARN', 'CLEAR', 'REPORTED', 'UNCLASSIFIED']);
const nonblank = (value: string) => value.trim().length > 0;

function refuse(code: string, reason: string): never {
  throw new Error(`${code}: ${reason}`);
}

export function parseCorrection(value: unknown): { path: 'described' | 'made'; selector: SessionSelector } | undefined {
  if (value === undefined) return undefined;
  const invalid = () => refuse('CORRECTION_SELECTOR_INVALID', 'expected explicit correction path and create selector');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return invalid();
  const { path, selector } = value as { path?: unknown; selector?: unknown };
  if ((path !== 'described' && path !== 'made') || !selector || typeof selector !== 'object' || Array.isArray(selector)) return invalid();
  const v = selector as Record<string, unknown>;
  if (v.kind === 'draft' && v.stage === 'parts-review' && typeof v.id === 'string' && id(v.id) && Object.keys(v).length === 3) {
    return { path, selector: { kind: 'draft', stage: 'parts-review', id: v.id } };
  }
  if (typeof v.version === 'number' && Number.isSafeInteger(v.version) && v.version > 0) {
    if (v.kind === 'rig' && v.stage === 'rig-review' && Object.keys(v).length === 3) return { path, selector: { kind: 'rig', stage: 'rig-review', version: v.version } };
    if (v.kind === 'post' && v.stage === 'direction-review' && portablePath(v.modelFile) && Object.keys(v).length === 4) {
      return { path, selector: { kind: 'post', stage: 'direction-review', version: v.version, modelFile: v.modelFile } };
    }
  }
  return invalid();
}

function portablePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9_. /-]+$/.test(value) &&
    value.split('/').every(part => nonblank(part) && part !== '.' && part !== '..' && !part.startsWith('-'));
}

function selectorArgs(selector: Selector): readonly string[] {
  if (selector.kind === 'parts' && selector.stage === 'parts-review' && portablePath(selector.inventory)) return ['--parts-file', selector.inventory];
  if (selector.kind === 'draft' && selector.stage === 'parts-review' && id(selector.id)) return ['--draft', selector.id];
  if ((selector.kind === 'rig' || selector.kind === 'post') && Number.isSafeInteger(selector.version) && selector.version > 0) {
    const version = ['--version', String(selector.version)];
    if (selector.kind === 'rig' && selector.stage === 'rig-review') return version;
    if (selector.kind === 'post' && selector.stage === 'direction-review' && portablePath(selector.modelFile)) return [...version, '--model-file', selector.modelFile];
  }
  return refuse('CORRECTION_SELECTOR_INVALID', 'explicit create identity for this stage required');
}

function itemWords(itemId: string, summary: string): string {
  if (!id(itemId) || !nonblank(summary) || Buffer.from(summary).toString('utf8') !== summary) {
    return refuse('CORRECTION_ITEM_INVALID', 'create-compatible id and nonblank UTF-8 words required');
  }
  return summary;
}

function sessionSource({ id, revision, sourceHash, reviewedSource }: SessionSource): SessionSource {
  return { id, revision, sourceHash, reviewedSource };
}

export function appliedValue(item: Feedback): unknown {
  const { context } = item;
  return context && typeof context === 'object' && !Array.isArray(context) ? context.applied : null;
}

function unsupportedOperation(schema: string): string {
  switch (schema) {
    case APPLIED_DELTA_SCHEMA: return 'mesh-delta';
    case APPLIED_RETARGET_SCHEMA: return 'retarget';
    case APPLIED_ANIMATION_SCHEMA: return 'keyed-animation';
    default: return 'other';
  }
}

export function projectSessionCorrection(input: SessionInput) {
  const { session, sessionBytes, selector, source, itemId } = input;
  const joined = input.direction?.joined;
  if (selector.kind === 'post' && joined && selector.version !== joined.postVersion)
    return refuse('CORRECTION_DIRECTION_SOURCE', 'select the joined Create post version');
  if (selector.kind === 'post' && joined && input.path === 'made')
    return refuse('CAMERA_APPLY_UNSUPPORTED', 'joined direction supports described requests only');
  const on = selectorArgs(selector);
  if (!hash(source.sourceHash) || !isDeepStrictEqual(sessionSource(session), source)) {
    return refuse('CORRECTION_SOURCE_STALE', 'saved session differs from verified source');
  }
  const matches = session.feedback.filter(item => item.id === itemId);
  const item = matches[0];
  if (matches.length !== 1 || !item) return refuse('CORRECTION_ITEM_INVALID', 'expected one saved feedback item');
  const verbatim = itemWords(itemId, item.summary);
  const common = { itemId, verbatim, stage: selector.stage, on, source, target: item.target };
  if (input.path === 'described') {
    const direction = input.direction?.file;
    if (selector.kind !== 'post' || !direction) return { ...common, kind: 'described' as const, outcome: null };
    const model = source.reviewedSource.rig;
    if (!model || selector.modelFile !== model.path || appliedValue(item) != null) {
      return refuse('CORRECTION_DIRECTION_SOURCE', 'select the inspected compiled model and its authored direction');
    }
    const context = item.context as Record<string, unknown> | undefined;
    const comment = hasStageComment(context?.comment) ? parseStageComment(context?.comment) : null;
    const createSource = JSON.stringify({
      source, post: selector.version, model: joined?.projectModel ?? model, direction,
      ...(joined ? {binding: joined, rigVersion: input.direction!.rigVersion, inspectedModel: model} : {}),
      animation: comment ? comment.animation : context?.animation,
      time: comment ? comment.time : context?.time,
      sourceTime: context?.sourceTime,
      frame: comment ? comment.frame : context?.frame,
      interval: comment?.frame === null ? null : { frameStart: item.frameStart, frameEnd: item.frameEnd, inclusive: true },
      target: item.target,
      camera: comment ? comment.camera : context?.camera,
      region: comment ? { viewport: comment.viewport, screen: comment.screen, world: comment.world } : null,
      reference: comment ? { id: comment.referenceId, sha256: comment.referenceHash } : context?.reference,
      view: context?.view,
    });
    if (Buffer.byteLength(createSource) > 32 * 1024) {
      return refuse('CORRECTION_DIRECTION_CONTEXT_SIZE', 'direction correction source exceeds 32 KiB');
    }
    return { ...common, on: joined ? selectorArgs({...selector, modelFile: joined.projectModel.path}) : on,
      kind: 'described' as const, outcome: null, createSource };
  }

  const value = appliedValue(item);
  if (value == null) return refuse('CORRECTION_APPLY_PENDING', 'no settled Apply in the saved item');
  try {
    parseAppliedContext(value);
  } catch (error) {
    return refuse('CORRECTION_APPLY_INVALID', error instanceof Error ? error.message : String(error));
  }
  const { schema } = value as { schema: string };
  if (schema !== APPLIED_PATCH_SCHEMA || selector.kind === 'post') {
    return { ...common, kind: 'unsupported' as const, operation: unsupportedOperation(schema), applied: value, sessionBytes, outcome: null };
  }

  const applied = value as AppliedPatch;
  const { settled } = input;
  if (!settled) return refuse('CORRECTION_APPLY_PENDING', 'verified server-side settled evidence is required');
  if (!isDeepStrictEqual(source, settled.source) || !isDeepStrictEqual(applied, settled.applied) ||
      applied.configHash !== source.reviewedSource.handoff?.config.sha256) {
    return refuse('CORRECTION_APPLY_STALE', 'saved Apply differs from settled source or operation');
  }
  const { rig, motion, handoff } = source.reviewedSource;
  if (!rig || motion !== null || !handoff || handoff.missing.length) {
    return refuse('CORRECTION_SOURCE_UNSUPPORTED', 'create requires a compiled source with a complete supported handoff');
  }
  if (!applied.diff) return refuse('CORRECTION_APPLY_INVALID', 'create requires the retained rig diff');
  const { check, patch, producer } = applied;
  if (!check || check.pass !== true || check.exitCode !== 0 || check.gate !== true ||
      (check.source !== 'retune' && check.source !== 'remesh' && check.source !== 'check') ||
      !check.line?.trim() || !Object.values(check.bars).includes('PASS') ||
      Object.values(check.bars).some(status => !checkStatuses.has(status)) ||
      /\b\d+ of \d+ bar\(s\) measured, \d+ skipped \(([^)]*)\)/.exec(check.line)?.[1]?.split(', ').some(name => check.bars[name] === 'PASS')) {
    return refuse('CORRECTION_CHECK_FAILED', 'the settled Apply requires a passing producer check');
  }
  if (!applied.line?.trim() || producer.package !== patch.producer.name || producer.version !== patch.producer.version ||
      patchSha256(patch) !== applied.patchSha256 || settled.operationSha256 !== applied.patchSha256) {
    return refuse('CORRECTION_ARTIFACT_MISMATCH', 'producer or canonical patch binding differs');
  }
  if (settled.modelSha256 !== applied.modelHash || (selector.kind === 'rig' && rig.sha256 === applied.modelHash)) {
    return refuse('CORRECTION_OUTCOME_MISMATCH', 'expected the bound scratch result');
  }
  return { ...common, kind: 'checked-patch' as const, applied, sessionBytes, patchBytes: patchText(patch), outcome: null };
}

type PartsCorrectionVerdict = PartsVerdict | {
  schema?: string;
  mode: PartsVerdict['mode'];
  tool?: { name: string; version: string };
  source: PartsVerdict['source'];
  status?: string;
  parts?: Record<string, { outcome: string; note: string; flags: string[] }>;
  comments?: import('./parts-comment.ts').PartsComment[];
  issues?: import('./parts-comment.ts').PartsIssue[];
  updatedAt?: string;
};

/** Standalone parts notes and pointed comments keep their original parts identity. */
export function projectPartsDescription(input: {
  verdict: PartsCorrectionVerdict;
  source: PartsVerdict['source'];
  selector: Extract<Selector, { kind: 'parts' }>;
  selection: { kind: 'comment'; itemId: string } | { kind: 'note'; itemId: string; part: string };
}) {
  const { verdict, source, selector, selection } = input;
  const on = selectorArgs(selector);
  if (verdict.mode !== 'parts' || !hash(source.sha256) || !isDeepStrictEqual(verdict.source, source)) {
    return refuse('CORRECTION_SOURCE_STALE', 'saved parts verdict differs from verified parts');
  }
  const { itemId } = selection;
  if (selection.kind === 'comment') {
    if ('issues' in verdict && Array.isArray(verdict.issues)) {
      const matches = verdict.issues.filter(issue => issue.id === itemId);
      const item = matches[0];
      if (matches.length !== 1 || !item || item.sourceHash !== source.sha256) {
        return refuse('CORRECTION_ITEM_INVALID', 'expected one source-bound parts comment');
      }
      const primary = item.parts[0]!;
      return { kind: 'described' as const, itemId, verbatim: itemWords(itemId, item.summary), stage: selector.stage, on, source, part: primary.name, imageHash: primary.imageHash, parts: item.parts, comment: item, outcome: null };
    }
    const comments = ('comments' in verdict && Array.isArray(verdict.comments)) ? verdict.comments : [];
    const matches = comments.filter(comment => comment.id === itemId);
    const item = matches[0];
    if (matches.length !== 1 || !item || item.sourceHash !== source.sha256) {
      return refuse('CORRECTION_ITEM_INVALID', 'expected one source-bound parts comment');
    }
    return { kind: 'described' as const, itemId, verbatim: itemWords(itemId, item.summary), stage: selector.stage, on, source, part: item.part, imageHash: item.imageHash, comment: item, outcome: null };
  }
  const parts = ('parts' in verdict && verdict.parts) ? verdict.parts : null;
  if (!parts || !Object.hasOwn(parts, selection.part)) return refuse('CORRECTION_ITEM_INVALID', 'expected a saved part note');
  return { kind: 'described' as const, itemId, verbatim: itemWords(itemId, parts[selection.part]!.note), stage: selector.stage, on, source, part: selection.part, outcome: null };
}
