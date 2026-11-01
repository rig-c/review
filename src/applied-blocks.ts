/**
 * #172: what the Cuts and Cloth blocks mark as applied, derived from the stage's current applied record — the same
 * record the draft keeps and feedback carries as `context.applied`. After an undo that record is the predecessor's (or
 * none on the inspected build), so a reverted Apply's ops are never marked.
 *
 * The rule: a patch record (`rig-review-applied/2`) belongs to the Cloth block when its op is `cloth` (the server runs
 * a patch whose every op is under `/cloth` as `propose --cloth --write-config`) and to the Cuts block when its op is
 * `build` (a cut, patch, limb or joint edit is read by assemble, so it runs `rig-parts build`). Any other record — a
 * physics or bones `rig` patch, a remesh, a regions, delta or retarget record, or none — marks nothing in either block.
 * A pending op is applied when the block's applied ops hold an op with the same op, path, value and name.
 */
import {
  APPLIED_ANIMATION_SCHEMA,
  APPLIED_DELTA_SCHEMA,
  APPLIED_PATCH_SCHEMA,
  APPLIED_RETARGET_SCHEMA,
} from './applied-context.ts';
import { parsePointer, type PatchOp } from './config-patch.ts';

export const APPLIED_REGIONS_SCHEMA = 'rig-review-applied/1';

export type AppliedBlock = 'cuts' | 'cloth';
export const APPLIED_BLOCKS: readonly AppliedBlock[] = ['cuts', 'cloth'];

export type AppliedPatchPanel = 'cuts' | 'cloth' | 'physics' | 'bones' | 'idle' | 'rig-fields';
export const APPLIED_PATCH_PANELS: readonly AppliedPatchPanel[] = [
  'cuts',
  'cloth',
  'physics',
  'bones',
  'idle',
  'rig-fields',
];

export type RebuildPanelKind =
  | 'chest'
  | 'mesh-edit'
  | 'mesh'
  | 'bones'
  | 'rig-fields'
  | 'cuts'
  | 'cloth'
  | 'physics'
  | 'idle'
  | 'retarget'
  | 'animation';

export const REBUILD_PANEL_KINDS: readonly RebuildPanelKind[] = [
  'chest',
  'mesh-edit',
  'mesh',
  'bones',
  'rig-fields',
  'cuts',
  'cloth',
  'physics',
  'idle',
  'retarget',
  'animation',
];

export interface RebuildHandoffContext {
  constraints?: readonly unknown[] | null;
  bones?: readonly unknown[] | null;
  fields?: Record<string, unknown> | null;
  cuts?: { config?: Record<string, unknown> | null } | null;
  idle?:
    | {
        tracks?: readonly unknown[] | null;
        blink?: Record<string, unknown> | null;
        source?: { available: boolean; source?: { tracks?: readonly unknown[] | null; blink?: unknown } };
      }
    | null;
  cloth?: { recipes?: Record<string, unknown> | null } | null;
  meshes?: Record<string, unknown> | null;
  animations?: { text?: string | null } | null;
}

export interface AppliedStageOwner {
  panel: RebuildPanelKind;
  part?: string;
  summary: string;
}

/** The record op each block owns. */
const BLOCK_OP: Record<AppliedBlock, string> = { cuts: 'build', cloth: 'cloth' };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One op's identity for the applied mark: op, path, value and name. */
export const opKey = (o: PatchOp): string => JSON.stringify([o.op, o.path, o.value ?? null, o.name ?? null]);

/** Which patch panel a single `ConfigPatch` operation belongs to, or null when the pointer is outside every known panel. */
export function patchOpPanel(recordOp: unknown, op: PatchOp): AppliedPatchPanel | 'mesh' | null {
  if (!isObject(op) || typeof op.path !== 'string') return null;
  let tokens: string[];
  try {
    tokens = parsePointer(op.path);
  } catch {
    return null;
  }
  if (!tokens.length) return null;
  if (recordOp === 'cloth') return tokens[0] === 'cloth' ? 'cloth' : null;
  if (recordOp === 'build') {
    return tokens[0] === 'assemble' || tokens[0] === 'limbs' || tokens[0] === 'joints' ? 'cuts' : null;
  }
  if (recordOp === 'remesh') return tokens[0] === 'meshes' && typeof tokens[1] === 'string' && tokens[1].length > 0 ? 'mesh' : null;
  if (recordOp === 'rig' || recordOp === 'retune' || recordOp === undefined) {
    if (tokens[0] === 'constraints') return 'physics';
    if (tokens[0] === 'bones' && (tokens[2] === 'at' || tokens[2] === 'points' || tokens[2] === 'tip')) return 'bones';
    if (tokens[0] === 'motion' && (tokens[1] === 'tracks' || (tokens[1] === 'blink' && tokens[2] !== 'still'))) return 'idle';
    if (
      tokens[0] === 'regions' ||
      tokens[0] === 'stops' ||
      tokens[0] === 'turn' ||
      (tokens[0] === 'motion' && tokens[1] === 'blink' && tokens[2] === 'still') ||
      (tokens[0] === 'bones' && (tokens[2] === 'inherit' || tokens[2] === 'link_inherit'))
    ) {
      return 'rig-fields';
    }
  }
  return null;
}

/** The block a record belongs to, or null when it marks nothing in the Cuts or Cloth block. */
export function recordBlock(record: unknown): AppliedBlock | null {
  if (!isObject(record) || record.schema !== APPLIED_PATCH_SCHEMA) return null;
  return APPLIED_BLOCKS.find(b => record.op === BLOCK_OP[b]) ?? null;
}

/** The stage record's applied ops per block: the record's patch ops in the block it belongs to, none in the other. */
export function appliedBlockOps(record: unknown): Record<AppliedBlock, PatchOp[]> {
  const out: Record<AppliedBlock, PatchOp[]> = { cuts: [], cloth: [] };
  const block = recordBlock(record);
  if (!block) return out;
  const patch = (record as Record<string, unknown>).patch;
  const ops = isObject(patch) && Array.isArray(patch.ops) ? (patch.ops as PatchOp[]) : [];
  out[block] = ops.map(o => ({ ...o }));
  return out;
}

/**
 * #250: the stage record's applied ops across all six patch-producing panels (`cuts`, `cloth`, `physics`, `bones`,
 * `idle`, `rig-fields`). When another panel's Apply replaces the stage record, superseded panels receive `[]` so their
 * items stop reading as `applied` while keeping their in-panel edits intact.
 */
export function appliedPanelOps(record: unknown): Record<AppliedPatchPanel, PatchOp[]> {
  const out: Record<AppliedPatchPanel, PatchOp[]> = {
    cuts: [],
    cloth: [],
    physics: [],
    bones: [],
    idle: [],
    'rig-fields': [],
  };
  if (!isObject(record) || record.schema !== APPLIED_PATCH_SCHEMA) return out;
  const patch = record.patch;
  const ops = isObject(patch) && Array.isArray(patch.ops) ? (patch.ops as PatchOp[]) : [];
  for (const op of ops) {
    const panel = patchOpPanel(record.op, op);
    if (panel && panel !== 'mesh') out[panel].push({ ...op });
  }
  return out;
}

/** Whether a pending item (the ops it sends) is applied: it sends at least one op and every one is in `applied`. */
export function itemApplied(itemOps: readonly PatchOp[], applied: readonly PatchOp[]): boolean {
  if (!itemOps.length || !applied.length) return false;
  const keys = new Set(applied.map(opKey));
  return itemOps.every(o => keys.has(opKey(o)));
}

/** The stage's identity for a readout: the applied record's build id, or null on the inspected build. */
const stageId = (record: unknown): string | null =>
  isObject(record) && typeof record.buildId === 'string' ? record.buildId : null;

/**
 * #186: the blocks whose result readout goes stale when the stage changes from `previous` to `next` — every block the
 * new stage record does not belong to (a Cuts readout after a Cloth Apply, both after a Reset or another kind of Apply).
 * Nothing while the stage is unchanged, so a refused Apply's readout stays; the owning block shows its own new job.
 */
export function staleReadouts(previous: unknown, next: unknown): AppliedBlock[] {
  if (stageId(previous) === stageId(next)) return [];
  const owner = recordBlock(next);
  return APPLIED_BLOCKS.filter(b => b !== owner);
}

function walkTokens(root: unknown, tokens: readonly string[]): unknown {
  let cur: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isObject(cur) && Object.hasOwn(cur, token)) {
      cur = cur[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

function lookupHandoffValue(handoff: RebuildHandoffContext | null | undefined, tokens: readonly string[]): unknown {
  if (!handoff || !tokens.length) return undefined;
  if (isObject(handoff.cuts?.config)) {
    const fromConfig = walkTokens(handoff.cuts.config, tokens);
    if (fromConfig !== undefined) return fromConfig;
  }
  if (tokens[0] === 'constraints' && Array.isArray(handoff.constraints)) {
    return walkTokens(handoff.constraints, tokens.slice(1));
  }
  if (tokens[0] === 'bones' && Array.isArray(handoff.bones)) {
    return walkTokens(handoff.bones, tokens.slice(1));
  }
  if (tokens[0] === 'meshes' && isObject(handoff.meshes)) {
    return walkTokens(handoff.meshes, tokens.slice(1));
  }
  if (tokens[0] === 'cloth' && isObject(handoff.cloth?.recipes)) {
    return walkTokens(handoff.cloth.recipes, tokens.slice(1));
  }
  if (tokens[0] === 'motion' && tokens[1] === 'tracks') {
    const tracks = Array.isArray(handoff.idle?.tracks)
      ? handoff.idle!.tracks
      : handoff.idle?.source?.available && Array.isArray(handoff.idle.source.source?.tracks)
        ? handoff.idle.source.source.tracks
        : null;
    if (tracks) return walkTokens(tracks, tokens.slice(2));
  }
  if (tokens[0] === 'motion' && tokens[1] === 'blink') {
    const blink = isObject(handoff.idle?.blink)
      ? handoff.idle!.blink
      : handoff.idle?.source?.available && isObject(handoff.idle.source.source?.blink)
        ? handoff.idle.source.source.blink
        : null;
    if (blink) return walkTokens(blink, tokens.slice(2));
  }
  if (isObject(handoff.fields)) {
    return walkTokens(handoff.fields, tokens);
  }
  return undefined;
}

function formatShortValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  if (typeof v === 'string') return v.length > 24 ? `${JSON.stringify(v.slice(0, 21))}…` : JSON.stringify(v);
  if (Array.isArray(v)) {
    const text = `[${v.map(x => (typeof x === 'number' ? String(x) : JSON.stringify(x))).join(', ')}]`;
    return text.length > 36 ? `${text.slice(0, 33)}…]` : text;
  }
  const text = JSON.stringify(v);
  return text && text.length > 36 ? `${text.slice(0, 33)}…` : String(text);
}

function formatTransition(label: string, op: PatchOp, from: unknown): string {
  if (op.op === 'remove') return `${label} removed`;
  const toText = formatShortValue(op.value);
  if (from !== undefined) return `${label} ${formatShortValue(from)} → ${toText}`;
  return `${label} → ${toText}`;
}

function summarizeList(items: readonly string[], max = 2): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} (+${items.length - max} more)`;
}

const refuseDropStatement = (detail: string): never => {
  throw new Error(`APPLIED_DROP_STATEMENT_UNAVAILABLE: ${detail}`);
};

/**
 * #250: derives the owning panel and plain-words summary for the stage's current applied record.
 * Returns `null` when nothing is applied (`null` / `undefined`). Refuses by name (`APPLIED_DROP_STATEMENT_UNAVAILABLE`)
 * when the record has an unknown schema or lacks the fields needed to state what will be dropped.
 */
export function describeAppliedRecord(
  record: unknown,
  handoff?: RebuildHandoffContext | null,
): AppliedStageOwner | null {
  if (record === null || record === undefined) return null;
  if (!isObject(record) || typeof record.schema !== 'string') {
    return refuseDropStatement('stage record is not a schema-tagged object');
  }
  const schema = record.schema;
  if (schema === APPLIED_REGIONS_SCHEMA) {
    const part = typeof record.part === 'string' && record.part.trim() ? record.part.trim() : null;
    if (!part) return refuseDropStatement(`${APPLIED_REGIONS_SCHEMA} is missing part`);
    if (isObject(record.bust)) {
      return { panel: 'chest', part, summary: `Chest landmarks on ${part}` };
    }
    const regions = Array.isArray(record.regions) ? record.regions : null;
    if (!regions || !regions.length) {
      return refuseDropStatement(`${APPLIED_REGIONS_SCHEMA} has neither bust landmarks nor regions`);
    }
    const names = regions
      .map(r => (isObject(r) && typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null))
      .filter((n): n is string => n !== null);
    if (!names.length) return refuseDropStatement(`${APPLIED_REGIONS_SCHEMA} regions have no names`);
    return { panel: 'chest', part, summary: `Chest regions on ${part} (${summarizeList(names, 3)})` };
  }

  if (schema === APPLIED_PATCH_SCHEMA) {
    const patch = isObject(record.patch) ? record.patch : null;
    const ops = patch && Array.isArray(patch.ops) ? (patch.ops as PatchOp[]) : null;
    if (!ops || !ops.length) return refuseDropStatement(`${APPLIED_PATCH_SCHEMA} has no patch ops`);
    const panels = new Set<AppliedPatchPanel | 'mesh'>();
    for (const op of ops) {
      const p = patchOpPanel(record.op, op);
      if (!p) return refuseDropStatement(`${APPLIED_PATCH_SCHEMA} op ${JSON.stringify(op?.path)} has no panel owner`);
      panels.add(p);
    }
    if (panels.size !== 1) {
      return refuseDropStatement(`${APPLIED_PATCH_SCHEMA} mixes multiple panels (${[...panels].join(', ')})`);
    }
    const panel = [...panels][0]!;
    if (panel === 'mesh') {
      const firstTokens = parsePointer(ops[0]!.path);
      const part = firstTokens[1];
      if (!part) return refuseDropStatement(`${APPLIED_PATCH_SCHEMA} remesh op is missing part`);
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const field = tokens.slice(2).join('/') || part;
        return formatTransition(field, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'mesh', part, summary: `Mesh ${part} ${summarizeList(items)}` };
    }
    if (panel === 'physics') {
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const field = tokens.slice(2).join('/') || op.path;
        return formatTransition(field, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'physics', summary: `Physics ${summarizeList(items)}` };
    }
    if (panel === 'bones') {
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const field = tokens.slice(2).join('/');
        const label = [op.name, field].filter(Boolean).join(' ') || op.path;
        return formatTransition(label, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'bones', summary: `Bones ${summarizeList(items)}` };
    }
    if (panel === 'idle') {
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const tail = tokens[1] === 'tracks' ? tokens.slice(3).join('/') || 'track' : tokens.slice(1).join('/');
        const label = op.name ? `${op.name} ${tail}` : tail || op.path;
        return formatTransition(label, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'idle', summary: `Idle ${summarizeList(items)}` };
    }
    if (panel === 'rig-fields') {
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const label = op.name ? `${op.name} ${tokens.slice(2).join('/') || tokens.at(-1)}` : tokens.join('/');
        return formatTransition(label, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'rig-fields', summary: `Rig fields ${summarizeList(items)}` };
    }
    if (panel === 'cuts') {
      const items = ops.map(op => {
        const tokens = parsePointer(op.path);
        const tail = tokens.slice(3).join('/') || tokens.slice(1).join('/');
        const label = op.name ? `${op.name} ${tail}` : tail || op.path;
        return formatTransition(label, op, lookupHandoffValue(handoff, tokens));
      });
      return { panel: 'cuts', summary: `Cuts ${summarizeList(items)}` };
    }
    const items = ops.map(op => {
      const tokens = parsePointer(op.path);
      const label = tokens.slice(1).join(' ') || op.path;
      return formatTransition(label, op, lookupHandoffValue(handoff, tokens));
    });
    return { panel: 'cloth', summary: `Cloth ${summarizeList(items)}` };
  }

  if (schema === APPLIED_DELTA_SCHEMA) {
    const part = typeof record.part === 'string' && record.part.trim() ? record.part.trim() : null;
    const delta = isObject(record.delta) ? record.delta : null;
    const ops = delta && Array.isArray(delta.ops) ? delta.ops : null;
    if (!part || !ops || !ops.length) {
      return refuseDropStatement(`${APPLIED_DELTA_SCHEMA} is missing part or delta ops`);
    }
    return {
      panel: 'mesh-edit',
      part,
      summary: `Edit mesh on ${part} (${ops.length} ${ops.length === 1 ? 'op' : 'ops'})`,
    };
  }

  if (schema === APPLIED_RETARGET_SCHEMA) {
    const motion = isObject(record.motion) ? record.motion : null;
    const retarget = isObject(record.retarget) ? record.retarget : null;
    const flags = retarget && isObject(retarget.flags) ? retarget.flags : null;
    const seq = retarget && isObject(retarget.sequence) ? retarget.sequence : null;
    const animation =
      (typeof motion?.animation === 'string' && motion.animation.trim()) ||
      (typeof flags?.animation === 'string' && flags.animation.trim()) ||
      null;
    const reference = typeof seq?.reference === 'string' && seq.reference.trim() ? seq.reference.trim() : null;
    if (!animation || !reference) {
      return refuseDropStatement(`${APPLIED_RETARGET_SCHEMA} is missing animation or sequence reference`);
    }
    return { panel: 'retarget', summary: `Retarget ${animation} from ${reference}` };
  }

  if (schema === APPLIED_ANIMATION_SCHEMA) {
    const ops = Array.isArray(record.ops) ? record.ops : null;
    if (!ops || !ops.length) return refuseDropStatement(`${APPLIED_ANIMATION_SCHEMA} has no ops`);
    let parsedMotion: Record<string, unknown> | null = null;
    if (typeof handoff?.animations?.text === 'string' && handoff.animations.text.trim()) {
      try {
        const doc = JSON.parse(handoff.animations.text);
        if (isObject(doc) && isObject(doc.animations)) parsedMotion = doc.animations;
      } catch {
        parsedMotion = null;
      }
    }
    const items = ops.map((raw, i) => {
      if (!isObject(raw) || typeof raw.op !== 'string' || typeof raw.animation !== 'string' || !raw.animation.trim()) {
        return refuseDropStatement(`${APPLIED_ANIMATION_SCHEMA} ops[${i}] is missing op or animation`);
      }
      const animName = raw.animation.trim();
      let bone = typeof raw.bone === 'string' && raw.bone.trim() ? raw.bone.trim() : '';
      if (!bone && typeof raw.track === 'number' && parsedMotion) {
        const animObj = parsedMotion[animName];
        const tracks = isObject(animObj) && Array.isArray(animObj.tracks) ? animObj.tracks : null;
        const tr = tracks?.[raw.track];
        if (isObject(tr) && typeof tr.bone === 'string' && tr.bone.trim()) bone = tr.bone.trim();
      }
      return `${raw.op} ${animName}${bone ? ` ${bone}` : ''}`;
    });
    return { panel: 'animation', summary: `Animation ${summarizeList(items)}` };
  }

  return refuseDropStatement(`unknown stage record schema ${JSON.stringify(schema)}`);
}

/**
 * #250: plain-words statement shown beside `panel`'s Apply button before the click when the stage carries an applied
 * edit from another panel (or another part on a per-part panel). Empty string when nothing will be dropped (including
 * `panel`'s own second Apply). Refuses by name (`APPLIED_DROP_STATEMENT_UNAVAILABLE`) when the stage record cannot
 * derive a statement.
 */
export function dropNoticeForPanel(
  record: unknown,
  panel: RebuildPanelKind,
  options?: { part?: string | null; handoff?: RebuildHandoffContext | null },
): string {
  if (!REBUILD_PANEL_KINDS.includes(panel)) {
    return refuseDropStatement(`unknown panel kind ${JSON.stringify(panel)}`);
  }
  const owner = describeAppliedRecord(record, options?.handoff);
  if (!owner) return '';
  if (owner.panel === panel) {
    const targetPart = typeof options?.part === 'string' && options.part.trim() ? options.part.trim() : null;
    if (!targetPart || !owner.part || targetPart === owner.part) return '';
  }
  return `This rebuild starts from the handoff and drops: ${owner.summary}`;
}

export interface PanelStatusSnapshot {
  text: string;
  part?: string | null;
}

export interface RestoredPanelOutcome {
  panel: RebuildPanelKind;
  part?: string;
  text: string;
}

/**
 * #250: whether `text` on `panel`'s status line claims an applied scratch build as the current stage state.
 * In-panel preview lines (such as Animation's `Applied <op> on <anim> track <i > (<n> pending op(s), preview active).`)
 * are not applied-build outcome lines and return false.
 */
export function isAppliedOutcomeStatus(panel: RebuildPanelKind, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  switch (panel) {
    case 'chest':
      return (
        (trimmed.startsWith('Applied ') &&
          trimmed.includes(' with ') &&
          trimmed.includes('Reset returns to the inspected build')) ||
        trimmed.startsWith('Applied patch ')
      );
    case 'mesh-edit':
      return trimmed.startsWith('Applied mesh edit ');
    case 'mesh':
      return trimmed.startsWith('Remeshed ') || trimmed.startsWith('Applied patch ');
    case 'bones':
    case 'rig-fields':
    case 'cuts':
    case 'cloth':
    case 'physics':
    case 'idle':
      return trimmed.startsWith('Applied patch ');
    case 'retarget':
      return trimmed.startsWith('Retargeted ');
    case 'animation':
      return (
        /^Applied [0-9a-f]{6,}…/.test(trimmed) ||
        (trimmed.startsWith('Applied ') &&
          trimmed.includes(' with ') &&
          trimmed.includes('Reset returns to the inspected build'))
      );
  }
}

/**
 * #250: return `{ panel, part? }` for the stage's applied record, or `null` when no known applied record is on the stage.
 */
export function appliedBuildOwner(record: unknown): { panel: RebuildPanelKind; part?: string } | null {
  try {
    const d = describeAppliedRecord(record);
    return d ? { panel: d.panel, ...(d.part ? { part: d.part } : {}) } : null;
  } catch {
    return null;
  }
}

/**
 * #250: reconcile every panel's status line against the record currently on the stage (`record`) and an optional
 * restored build outcome (`restored`, supplied when Undo returns to an earlier applied build). Any non-owning panel
 * whose status line still claims an applied build is cleared (`''`); non-applied status text (pre-checks, preview notes,
 * errors) stays untouched; when Undo restores `panel`'s build, `restored.text` is restored onto `panel`.
 */
export function reconcilePanelStatuses(
  current: Partial<Record<RebuildPanelKind, string | PanelStatusSnapshot>>,
  record: unknown,
  restored?: RestoredPanelOutcome | null,
): Record<RebuildPanelKind, string> {
  const owner = appliedBuildOwner(record);
  const out = {} as Record<RebuildPanelKind, string>;
  for (const panel of REBUILD_PANEL_KINDS) {
    const entry = current[panel];
    const text = typeof entry === 'string' ? entry : (entry?.text ?? '');
    const currentPart =
      typeof entry === 'object' && entry !== null && typeof entry.part === 'string' && entry.part.trim()
        ? entry.part.trim()
        : undefined;
    const ownsStage =
      owner !== null &&
      owner.panel === panel &&
      (restored?.panel === panel || owner.part === undefined || currentPart === undefined || owner.part === currentPart);
    if (ownsStage) {
      if (
        restored &&
        restored.panel === panel &&
        (restored.part === undefined || currentPart === undefined || restored.part === currentPart)
      ) {
        out[panel] = restored.text;
      } else {
        out[panel] = text;
      }
    } else {
      out[panel] = isAppliedOutcomeStatus(panel, text) ? '' : text;
    }
  }
  return out;
}
