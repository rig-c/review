/**
 * Picked-build Setup and Animate tools in a comparison session (#234).
 *
 * Mounts the existing Setup and Animate panel modules (`AnimationInspectionPanel`, `bindBonesPanel`, `bindRigFieldsPanel`,
 * `bindCutsPanel`, `bindClothPanel`, `bindMeshPanel`, `bindDensityStrip`, `bindChestEditor`, `bindMeshEditor`,
 * `bindWeightsView`, `bindRetargetPanel`, `bindPhysicsPanel`, `bindIdlePanel`, `bindReadingsPanel`,
 * `bindRequirementsPanel`, `bindInspectorBlocks`) against the reviewer's picked build (`a` or `b`).
 * Every producer route is scoped to `/api/compare/<side>/*` and `/compare-rebuild/<side>/:id/*`, and an Apply swaps
 * only `players[pickedSide]`.
 */
import type { BoneAdjust, ModelAssets, RigPlayer } from '@rig-c/play';
import type { CompareResponse } from '../src/compare.ts';
import type { CommentMode } from '../src/stage-comment.ts';
import { AnimationInspectionPanel } from './animation-inspection.ts';
import { partBounds, type PartExplorer } from './part-selection.ts';
import { bindInspectorBlocks, activeBlocksUI, restoreActiveBlocksUI, type InspectorBlocks } from './inspector-blocks.ts';
import { bindChestEditor, canvasToCrop, bustLabel, bustSides, LANDMARKS, landmarkInputId, rowCircle, type ChestEditor, type LandmarkKey } from './chest-editor.ts';
import { chestOverlayCircles, chestOverlayPolygons, chestRegionRows, chestRowId, evaluateChestForm } from './chest-regions-tool.ts';
import { chestRegionsBinding, cropWorldMapping, type CropWorldMapping } from '../src/chest-regions.ts';
import { bindMeshEditor, meshEditSource, sha256Hex, type MeshEditor } from './mesh-editor.ts';
import { meshEditBinding, meshEditText, type MeshEditDocument } from '../src/mesh-edit.ts';
import { bindWeightsView, setupPoseMesh, type WeightsView } from './weights-view.ts';
import { readSetupPose } from './setup-pose.ts';
import { bindBonesPanel, type BonesPanel, type BonesCheckView } from './bones-panel.ts';
import { bindCutsPanel, type CutsPanel } from './cuts-panel.ts';
import { bindClothPanel, type ClothPanel } from './cloth-panel.ts';
import { bindMeshPanel, type MeshPanel } from './mesh-panel.ts';
import { bindDensityStrip, type DensityStripPanel, type DensityStripViewLike } from './density-strip-panel.ts';
import { densityField, densityPath } from '../src/density-strip.ts';
import { assertMeshPatch, countsText, meshApplyOutcome, meshPatchOps, setEntryValue, triangleAgreement, type MeshEntry } from '../src/mesh-entry.ts';
import { bindPhysicsPanel, type PhysicsPanel } from './physics-panel.ts';
import { tuningRows, readoutRows, barLine, beforeLine, type InspectedCheckView } from '../src/physics-tuning.ts';
import { bindIdlePanel, type BoneSetup, type IdlePanel } from './idle-panel.ts';
import { IDLE_READOUT_BARS, type LocalChannel } from '../src/idle-tracks.ts';
import { bindRigFieldsPanel, type RigFieldsPanel } from './rig-fields-panel.ts';
import { assertRigFieldOps, RIG_FIELDS_READOUT_BARS, TURN_BONE } from '../src/rig-fields.ts';
import { bindReadingsPanel, type ReadingsJobView, type ReadingsPanel, type ReadingsRefusal } from './readings-panel.ts';
import { READINGS_SCHEMA, readingSeekTime, worstLine, type ReadingsContext } from '../src/readings.ts';
import { bindRequirementsPanel, type RequirementsCatalogView, type RequirementsJobView, type RequirementsPanel, type RequirementsRefusal } from './requirements-panel.ts';
import { bindRetargetPanel, type PoseMap, type RetargetPanel } from './retarget-panel.ts';
import type { RetargetFlags } from '../src/retarget.ts';
import {
  historyRow, isPatchJob, recordFor, refusedText, retargetStage, undoControl,
  appliedRecord, deltaAppliedRecord, deltaOutcomeLine, designatedRegions, handoffText,
  landmarksRequest, seedLandmarks, makePatch, outcomeLine, patchAppliedRecord, patchOutcomeLine,
  pickPart, runRebuild, seedFields, stageModel, retargetAppliedRecord, retargetOutcomeLine, stripPendingAfter,
  type AppliedHistoryView, type UndoView, type AnyJobView, type AppliedAnimation, type AppliedDelta, type AppliedPatch,
  type AppliedRecord, type AppliedRetarget, type DeltaJobView, type DeltaRequestBody, type ConfigPatch,
  type PatchJobView, type RebuildJobView, type RebuildRefusal, type RebuildRequestBody, type RebuildStatusView,
  type RetargetJobView, type RetargetRequestBody, type StageChange,
} from './rebuild-client.ts';
import { patchRoute } from '../src/retune-route.ts';
import type { CheckSummary } from '../src/applied-context.ts';
import { appliedBlockOps, recordBlock, staleReadouts } from '../src/applied-blocks.ts';
import { compareSeekStep } from '../src/compare-playhead.ts';
import { composeAdjust, PhysicsPreview } from './preview.ts';
import {
  createWindModel, environmentFor, windReadout, RUNTIME_START_READOUT, joltPacket, dueJolts, dragMoved,
  loadModelDocument, environmentContext, environmentJson, type JoltStep, type WindSnapshot, type WindState,
} from '../src/environment.ts';
import { environmentCheckRows, restartsWindClock, scheduleContext, worldExport, type ClipMove, type EnvironmentCheckView, type WorldExport } from './environment-world.ts';
import type { OverlayCircle, OverlayMarker, OverlayRegion, OverlaySnapshot } from './rig-overlays.ts';
import type { PatchOp } from '../src/config-patch.ts';

export type Side = 'a' | 'b';

interface StageWorld {
  wind: WindState;
  jolts: JoltStep[];
  applied: boolean;
  gravity: number;
}

interface SideBuildState {
  inspectedModel: { url: string; prefix: string; sha256: string } | null;
  stageSource: { url: string; prefix: string; hash: string } | null;
  stageModelHash: string | null;
  partModel: unknown | null;
  inspectedDocument: unknown | null;
  inspectedDocumentReason: string | null;
  rebuildStatus: RebuildStatusView | null;
  appliedOnStage: AppliedRecord | AppliedPatch | AppliedDelta | AppliedRetarget | AppliedAnimation | null;
  readoutStage: AppliedRecord | AppliedPatch | AppliedDelta | AppliedRetarget | AppliedAnimation | null;
  appliedHistory: AppliedHistoryView | null;
  stageCheck: { lines: string[]; check: CheckSummary | null } | null;
  chestInputs: Record<string, string> | null;
  chestMapping: CropWorldMapping;
  stripView: DensityStripViewLike | null;
  stripPending: {
    index: number;
    id: string;
    candidate: string;
    back: {
      url: string;
      prefix: string;
      hash: string;
      applied: AppliedRecord | AppliedPatch | AppliedDelta | AppliedRetarget | AppliedAnimation | null;
      check: { lines: string[]; check: CheckSummary | null } | null;
    };
  } | null;
  readingsJob: ReadingsJobView | null;
  requirementsCatalog: RequirementsCatalogView | null;
  lastOverlay: OverlaySnapshot | null;
}

function emptySideState(): SideBuildState {
  return {
    inspectedModel: null,
    stageSource: null,
    stageModelHash: null,
    partModel: null,
    inspectedDocument: null,
    inspectedDocumentReason: null,
    rebuildStatus: null,
    appliedOnStage: null,
    readoutStage: null,
    appliedHistory: null,
    stageCheck: null,
    chestInputs: null,
    chestMapping: { available: false, reason: 'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn' },
    stripView: null,
    stripPending: null,
    readingsJob: null,
    requirementsCatalog: null,
    lastOverlay: null,
  };
}

export interface ComparePickedToolsHost {
  data: () => CompareResponse;
  readOnly: () => string | null;
  players: Partial<Record<Side, RigPlayer>>;
  assets: Partial<Record<Side, ModelAssets>>;
  rigScales: Record<Side, number>;
  layers: { images: boolean; mesh: boolean; bones: boolean; meshOpacity: number };
  parts: () => PartExplorer | null;
  time: () => number;
  duration: () => number;
  playing: () => boolean;
  pause: () => void;
  seekTo: (seconds: number) => Promise<void>;
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  route: (path: string) => string;
  swapSideRig: (side: Side, modelUrl: string, prefix: string, sha256: string, clipName?: string) => Promise<void>;
  redrawOverlays: (fresh: boolean) => void;
  fit: () => void;
  syncLayout: () => void;
  saveDraft: () => void;
  message: (value: string, error?: boolean) => void;
  download: (filename: string, content: string, type: string) => void;
  turnAdjustFor: (side: Side) => BoneAdjust | null;
  syncFeedbackSide: (side: Side) => void;
}

export interface ComparePickedTools {
  mode: () => CommentMode;
  setMode: (mode: CommentMode, options?: { fromTab?: boolean }) => void;
  onInspectorTabChanged: () => void;
  pickedSide: () => Side;
  setPickedSide: (side: Side) => void;
  isSwitchingSide: () => boolean;
  defaultStatusMessage: () => string;
  registerSideModel: (side: Side, modelUrl: string, prefix: string, sha256: string, partModel: unknown | null) => void;
  loadInitialSideStatuses: () => Promise<void>;
  onPosePresented: () => void;
  onPartSelected: (side: Side | null, slot: string | null) => void;
  overlayInputFor: (side: Side) => {
    regions: OverlayRegion[];
    circles: OverlayCircle[];
    markers: OverlayMarker[];
    meshEdit: ReturnType<MeshEditor['overlay']>;
    weights: ReturnType<WeightsView['overlay']>;
    anchors: ReturnType<BonesPanel['overlay']>;
  };
  recordOverlaySnapshot: (side: Side, snapshot: OverlaySnapshot) => void;
  uiState: () => Record<string, string | number | null>;
  restoreUiState: (ui: Record<string, string | number | null>) => void;
  commentRefusal: () => string | null;
  shortcutBlocked: () => boolean;
  busy: () => boolean;
  appliedFor: (side: Side) => AppliedRecord | AppliedPatch | AppliedDelta | AppliedRetarget | AppliedAnimation | null;
  modelHashFor: (side: Side) => string | null;
  seekMode: (target: number, continuing: boolean) => 'settle' | 'seek';
  stepSide: (mode: 'present' | 'settle' | 'seek', side: Side, target: number) => void;
  dispose: () => void;
}

const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing compare UI element: ${id}`);
  return node as T;
};
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
const option = (value: string, label: string) => { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function boneSetup(document: unknown): BoneSetup {
  const list = (document as { bones?: unknown })?.bones;
  const map = new Map<string, Partial<Record<LocalChannel, number>>>();
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof (b as { name?: unknown }).name !== 'string') continue;
    const o = b as Record<string, unknown>, v: Partial<Record<LocalChannel, number>> = {};
    for (const c of ['rotation', 'x', 'y', 'scaleX', 'scaleY', 'shearX', 'shearY'] as const) {
      if (typeof o[c] === 'number') v[c] = o[c] as number;
    }
    map.set(o.name as string, v);
  }
  return { names: [...map.keys()], get: bone => map.get(bone) };
}

/**
 * Dynamic element proxy that forwards DOM queries/captures to the currently picked side's element
 * (`a-<suffix>` or `b-<suffix>`) and attaches event listeners to both sides, firing only when the event
 * originates on the currently picked side.
 */
function sideElementProxy<T extends HTMLElement>(getSide: () => Side, suffix: 'pane' | 'viewport' | 'overlay'): T {
  const targetFor = (side: Side) => el<T>(`${side}-${suffix}`);
  const wrapped = new Map<EventListenerOrEventListenerObject, { a: EventListener; b: EventListener }>();
  return new Proxy({} as T, {
    get(_target, prop) {
      const current = targetFor(getSide());
      if (prop === 'addEventListener') {
        return (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (!listener) return;
          const call = (side: Side) => (event: Event) => {
            if (getSide() !== side) return;
            if (typeof listener === 'function') listener.call(targetFor(side), event);
            else listener.handleEvent(event);
          };
          const pair = { a: call('a'), b: call('b') };
          wrapped.set(listener, pair);
          targetFor('a').addEventListener(type, pair.a, options);
          targetFor('b').addEventListener(type, pair.b, options);
        };
      }
      if (prop === 'removeEventListener') {
        return (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          if (!listener) return;
          const pair = wrapped.get(listener);
          if (!pair) return;
          targetFor('a').removeEventListener(type, pair.a, options);
          targetFor('b').removeEventListener(type, pair.b, options);
          wrapped.delete(listener);
        };
      }
      const value = Reflect.get(current, prop, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, prop, value) {
      const current = targetFor(getSide());
      return Reflect.set(current, prop, value, current);
    },
  });
}

export function mountComparePickedTools(host: ComparePickedToolsHost): ComparePickedTools {
  let workspaceMode: CommentMode = 'compare';
  let pickedSide: Side = 'a';
  let switchingSide = false;
  const sides: Record<Side, SideBuildState> = { a: emptySideState(), b: emptySideState() };
  let rebuildBusy = false, densityBusy = false, readingsBusy = false, environmentCheckBusy = false;
  let handoffTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMeshPatch: ConfigPatch | null = null;
  const disposers: (() => void)[] = [];

  const wind = createWindModel();
  let joltQueue: JoltStep[] = [];
  let environmentNote = '';
  let steppedLive = false;
  const physicsPreview = new PhysicsPreview();
  let idleAdjust: BoneAdjust | null = null;
  let dialAdjust: BoneAdjust | null = null;

  let inspectorBlocks: InspectorBlocks | null = null;
  let animationPanel: AnimationInspectionPanel | null = null;
  let chestEditor: ChestEditor | null = null;
  let meshEditor: MeshEditor | null = null;
  let weightsView: WeightsView | null = null;
  let bonesPanel: BonesPanel | null = null;
  let cutsPanel: CutsPanel | null = null;
  let clothPanel: ClothPanel | null = null;
  let meshPanel: MeshPanel | null = null;
  let densityStrip: DensityStripPanel | null = null;
  let physicsPanel: PhysicsPanel | null = null;
  let idlePanel: IdlePanel | null = null;
  let rigFieldsPanel: RigFieldsPanel | null = null;
  let readingsPanel: ReadingsPanel | null = null;
  let requirementsPanel: RequirementsPanel | null = null;
  let retargetPanel: RetargetPanel | null = null;

  const currentState = (): SideBuildState => sides[pickedSide];
  const currentPlayer = (): RigPlayer | undefined => host.players[pickedSide];
  const currentAssets = (): ModelAssets | undefined => host.assets[pickedSide];
  const currentSideData = () => host.data()[pickedSide];
  const sideApiPrefix = (side: Side = pickedSide) => `/api/compare/${side}`;

  function rigProject(side: Side = pickedSide) {
    const root = el(`${side}-root`);
    const scale = host.rigScales[side];
    return (x: number, y: number) => ({
      x: parseFloat(root.style.left || '0') + x * scale,
      y: parseFloat(root.style.top || '0') - y * scale,
    });
  }

  function currentInspector(): string {
    return document.querySelector<HTMLElement>('[data-inspector][aria-selected="true"]')?.dataset.inspector ?? 'view';
  }

  function selectInspectorTab(name: 'view' | 'rig' | 'playback' | 'feedback'): void {
    const tab = document.querySelector<HTMLButtonElement>(`[data-inspector="${name}"]`);
    if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
  }

  function defaultStatusMessage(): string {
    if (workspaceMode === 'compare') return 'Inspecting both rigs at the actual reference video time.';
    const d = host.data();
    const title = d ? d[pickedSide].manifest.title : pickedSide.toUpperCase();
    const sideUpper = pickedSide.toUpperCase();
    const modeLabel = workspaceMode === 'setup' ? 'Setup' : 'Animate';
    return `Inspecting Build ${sideUpper} (${title}) in ${modeLabel} mode at the actual reference video time; Apply rebuilds only Build ${sideUpper} in scratch.`;
  }

  function syncPickedBanner(): void {
    const d = host.data();
    const title = d ? d[pickedSide].manifest.title : pickedSide.toUpperCase();
    const sideUpper = pickedSide.toUpperCase();
    const modeLabel = workspaceMode === 'setup' ? 'Setup' : 'Animate';
    const isCompare = workspaceMode === 'compare';
    const label = document.getElementById('picked-build-label');
    if (label) label.textContent = `Build ${sideUpper} — ${title}`;
    for (const btn of document.querySelectorAll<HTMLButtonElement>('#mode-build-picker [data-build-side]')) {
      const active = btn.dataset.buildSide === pickedSide;
      btn.setAttribute('aria-pressed', String(active));
    }
    const picker = document.getElementById('mode-build-picker');
    if (picker) picker.hidden = isCompare;
    const stageLayout = document.getElementById('stage-layout');
    if (stageLayout) {
      stageLayout.dataset.workspaceMode = workspaceMode;
      stageLayout.dataset.pickedSide = pickedSide;
    }
    for (const s of ['a', 'b'] as const) {
      const pane = document.getElementById(`${s}-pane`);
      if (pane) {
        if (!isCompare && s === pickedSide) pane.dataset.picked = 'true';
        else delete pane.dataset.picked;
      }
    }
    host.parts()?.setVisibleSide(isCompare ? null : pickedSide);
    host.parts()?.setStatusHint(
      isCompare
        ? null
        : `Setup and Animate tools target Build ${sideUpper} (${title}): Apply rebuilds only Build ${sideUpper} in scratch; supplied source art and compiled packages on disk are never modified.`,
    );
    const toolbarHint = document.getElementById('toolbar-mode-hint');
    if (toolbarHint) {
      toolbarHint.textContent = isCompare
        ? 'Inspect A and B at the reference video time'
        : `Inspect Build ${sideUpper} (${title}) in ${modeLabel} mode at the reference video time`;
    }
    const inputsHint = document.querySelector<HTMLElement>('#workspace-left .workspace-sources > p.hint, #workspace-left > p.hint');
    if (inputsHint) {
      inputsHint.textContent = isCompare
        ? 'A and B retain their fixed source bindings. The reference video and shared animation are named above the stage.'
        : `Editing Build ${sideUpper} (${title}) in ${modeLabel} mode; Apply writes to scratch while A and B retain their fixed on-disk source bindings.`;
    }
    const rigHint = document.getElementById('rig-inspector-hint');
    if (rigHint) {
      rigHint.textContent = isCompare
        ? 'These controls show actual images, last-drawn mesh edges and named bone points. Both builds use the fixed animation named above. This inspector does not author geometry or motion.'
        : `These controls show actual images, last-drawn mesh edges and named bone points for Build ${sideUpper} (${title}). Setup tools apply changes only to Build ${sideUpper} in a scratch build; on-disk packages stay immutable.`;
    }
    const playbackHint = document.getElementById('playback-inspector-hint');
    if (playbackHint) {
      playbackHint.textContent = isCompare
        ? 'Motion is read only. The reference video FPS is not used to infer the pose frame clock.'
        : `Inspecting Build ${sideUpper} (${title}) in ${modeLabel} mode: Animate tools apply motion changes only to Build ${sideUpper} in a scratch build. The reference video FPS is not used to infer the pose frame clock.`;
    }
    const msgNode = document.getElementById('message');
    if (msgNode && !msgNode.classList.contains('error')) {
      host.message(defaultStatusMessage());
    }
    host.syncLayout();
  }

  function moveStageHandlesToPickedSide(): void {
    const viewport = document.getElementById(`${pickedSide}-viewport`);
    if (!viewport) return;
    const empty = document.getElementById(`${pickedSide}-empty`);
    for (const id of ['idle-handles', 'rig-fields-stage']) {
      const node = document.getElementById(id);
      if (node && node.parentElement !== viewport) {
        if (empty && empty.parentElement === viewport) viewport.insertBefore(node, empty);
        else viewport.append(node);
      }
    }
    const picks = document.querySelector<HTMLElement>('.animation-stage-picks');
    if (picks && picks.parentElement !== viewport) viewport.append(picks);
  }

  function setAdjust(side: Side = pickedSide): void {
    const player = host.players[side];
    if (!player) return;
    const baseTurn = host.turnAdjustFor(side);
    player.adjust = side === pickedSide ? composeAdjust(baseTurn, composeAdjust(idleAdjust, dialAdjust)) : baseTurn;
    if (player.current && !host.playing()) {
      player.repose();
      player.draw();
      host.parts()?.present(side);
      host.redrawOverlays(true);
    }
  }

  function syncModeButtons(): void {
    const expected = workspaceMode === 'setup' ? 'rig' : workspaceMode === 'animate' ? 'playback' : 'compare';
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.mode-switch [data-mode]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === expected));
    }
  }

  function setMode(nextMode: CommentMode, options: { fromTab?: boolean } = {}): void {
    const prevMode = workspaceMode;
    workspaceMode = nextMode;
    const currentPart = host.parts()?.value();
    if (nextMode !== 'compare' && (currentPart?.side === 'a' || currentPart?.side === 'b') && currentPart.side !== pickedSide) {
      setPickedSide(currentPart.side);
    }
    const modeBoundaryChanged = (prevMode === 'compare') !== (nextMode === 'compare');
    if (modeBoundaryChanged) {
      steppedLive = false;
      applyEnvironment();
      const p = currentPlayer();
      if (p?.current && !host.playing()) {
        p.seek(host.time());
        p.draw();
        host.parts()?.present(pickedSide);
      }
    }
    if (nextMode !== 'compare') {
      host.syncFeedbackSide(pickedSide);
    }
    syncModeButtons();
    syncPickedBanner();
    if (!options.fromTab) {
      if (nextMode === 'setup') selectInspectorTab('rig');
      else if (nextMode === 'animate') selectInspectorTab('playback');
      else if (currentInspector() === 'rig' || currentInspector() === 'playback') selectInspectorTab('view');
    }
    refreshAnimationInspection();
    inspectorBlocks?.refresh();
    host.redrawOverlays(modeBoundaryChanged);
    host.saveDraft();
  }

  function setPickedSide(nextSide: Side): void {
    if (pickedSide === nextSide) {
      if (workspaceMode !== 'compare') host.syncFeedbackSide(pickedSide);
      syncPickedBanner();
      moveStageHandlesToPickedSide();
      return;
    }
    const prevSide = pickedSide;
    if (sides[prevSide].chestInputs !== null) {
      sides[prevSide].chestInputs = snapshotChestInputs();
    }
    physicsPanel?.clearPreview();
    idleAdjust = null;
    dialAdjust = null;
    setAdjust(prevSide);
    const prevPlayer = host.players[prevSide];
    if (prevPlayer) {
      prevPlayer.environment(null);
      if (prevPlayer.current && !host.playing()) {
        prevPlayer.seek(host.time());
        prevPlayer.draw();
        host.parts()?.present(prevSide);
      }
    }
    pickedSide = nextSide;
    steppedLive = false;
    if (workspaceMode !== 'compare') host.syncFeedbackSide(pickedSide);
    applyEnvironment();
    const nextPlayer = currentPlayer();
    if (nextPlayer?.current && !host.playing()) {
      nextPlayer.repose();
      nextPlayer.draw();
      host.parts()?.present(pickedSide);
    }
    syncPickedBanner();
    moveStageHandlesToPickedSide();
    const currentPart = host.parts()?.value();
    if (currentPart && currentPart.side !== nextSide) {
      const nextSlots = host.data()[nextSide].feedbackCatalog.slots ?? [];
      switchingSide = true;
      try {
        if (nextSlots.includes(currentPart.slot)) {
          host.parts()?.select({ side: nextSide, slot: currentPart.slot, mode: currentPart.mode });
        } else {
          host.parts()?.select(null);
        }
      } finally {
        switchingSide = false;
      }
    }
    switchingSide = true;
    try {
      clearChestInputs();
      populateChestBones();
      applySideStateToPanels();
      updateChestMapping();
    } finally {
      switchingSide = false;
    }
    host.redrawOverlays(true);
    host.saveDraft();
  }

  function chestInputIds(): string[] {
    return [
      ...chestRegionRows.flatMap(row => ['name', 'bone', 'cx', 'cy', 'r', 'band', 'ring', 'poly'].map(f => chestRowId(row, f as 'name'))),
      ...LANDMARKS.flatMap(({ key }) => [landmarkInputId(key, 'x'), landmarkInputId(key, 'y')]),
      'lm-bone-r',
      'lm-bone-l',
    ];
  }

  function snapshotChestInputs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of chestInputIds()) {
      const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!node) continue;
      out[id] = node instanceof HTMLInputElement && node.type === 'checkbox' ? String(node.checked) : node.value;
    }
    return out;
  }

  function clearChestInputs(): void {
    for (const id of chestInputIds()) {
      const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!node) continue;
      if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = false;
      else node.value = '';
    }
  }

  function writeChestInputs(values: Record<string, string>): void {
    for (const [id, value] of Object.entries(values)) {
      const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
      if (!node) continue;
      if (node instanceof HTMLInputElement && node.type === 'checkbox') node.checked = value === 'true';
      else node.value = value;
    }
  }

  function populateChestBones(): void {
    const bones = currentSideData()?.feedbackCatalog.bones ?? null;
    const list = document.getElementById('lm-bones');
    if (list) {
      list.replaceChildren();
      for (const name of bones ?? []) list.append(option(name, name));
    }
    for (const row of chestRegionRows) {
      const node = document.getElementById(chestRowId(row, 'bone')) as HTMLSelectElement | null;
      if (!node) continue;
      node.replaceChildren(option('', bones ? 'Select bone' : 'No model bones'));
      for (const name of bones ?? []) node.append(option(name, name));
      node.disabled = !bones;
    }
  }

  function chestField(id: string) {
    const node = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    return node ? { value: node.value, ...(node instanceof HTMLInputElement && node.type === 'checkbox' ? { checked: node.checked } : {}) } : undefined;
  }

  function chestEvaluation() {
    return evaluateChestForm(chestField, currentState().chestMapping, currentSideData()?.feedbackCatalog.bones);
  }

  function updateChestMapping(side: Side = pickedSide): void {
    const state = sides[side];
    const player = host.players[side], sideAssets = host.assets[side];
    const root = host.data()[side]?.feedbackCatalog.bones?.[0];
    let at: { x: number; y: number } | null = null;
    if (player && root) {
      try { const bone = player.bone(root); at = { x: bone.x, y: bone.y }; } catch { at = null; }
    }
    state.chestMapping = player ? cropWorldMapping(sideAssets?.stage, at) : { available: false, reason: 'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn' };
    if (side === pickedSide) renderChest();
  }

  function renderChest(): void {
    const mapping = currentState().chestMapping;
    for (const id of ['chest-crop-w', 'chest-crop-h']) {
      const node = document.getElementById(id) as HTMLInputElement | null;
      if (!node) continue;
      node.readOnly = mapping.available;
      if (mapping.available) node.value = String(id === 'chest-crop-w' ? mapping.crop.w : mapping.crop.h);
    }
    const mapNode = document.getElementById('chest-mapping');
    if (mapNode) {
      mapNode.textContent = mapping.available ? `Crop → rig world from the model: ${mapping.basis}.` : `${mapping.reason}. No overlay is drawn; enter the crop size to export.`;
      mapNode.classList.toggle('error', !mapping.available);
    }
    const value = chestEvaluation();
    const statusNode = document.getElementById('chest-status');
    if (statusNode) {
      statusNode.textContent = value.ok ? `${value.document.mesh.value.contour.regions.map(r => `${r.name} → ${r.bone}`).join(' · ')} · valid for export` : value.error;
      statusNode.classList.toggle('error', !value.ok);
    }
    if (!switchingSide && currentState().chestInputs !== null) {
      currentState().chestInputs = snapshotChestInputs();
    }
    chestEditor?.sync(); meshEditor?.sync(); weightsView?.sync(); bonesPanel?.sync(); cutsPanel?.sync(); clothPanel?.sync();
    host.redrawOverlays(false);
  }

  function chestRegions(): OverlayRegion[] {
    const style = getComputedStyle(document.documentElement), token = (name: string) => style.getPropertyValue(name).trim();
    return chestOverlayPolygons(chestEvaluation(), currentState().chestMapping).map((region, i) => ({
      ...region,
      stroke: token(i ? '--rv-region-b' : '--rv-region-a'),
      fill: token(i ? '--rv-region-b-fill' : '--rv-region-a-fill'),
    }));
  }

  function chestCircles(): OverlayCircle[] {
    const mapping = currentState().chestMapping;
    if (!mapping.available) return [];
    const style = getComputedStyle(document.documentElement), token = (name: string) => style.getPropertyValue(name).trim();
    const colors = (row: number, overlap: boolean) => ({
      stroke: token(overlap ? '--rv-bust-overlap' : row ? '--rv-bust-l' : '--rv-bust-r'),
      fill: token(overlap ? '--rv-bust-overlap-fill' : row ? '--rv-bust-l-fill' : '--rv-bust-r-fill'),
      handle: token('--rv-bust-handle'),
      ink: token('--rv-bust-ink'),
      labelBg: token('--rv-bust-label-bg'),
      flash: token('--rv-bust-flash'),
    });
    if (chestEditor?.active() && chestEditor.mode() === 'landmarks') {
      const read = chestEditor.landmarks();
      if (!('derived' in read)) return [];
      const refused = !!read.derived.refusal;
      return read.derived.regions.filter(r => r.r > 0 && r.band >= 0).map((r, row) => ({
        center: mapping.toWorld(r.cx, r.cy), r: r.r, band: r.band, label: `${r.name} r:${r.r} b:${r.band}`, labelRow: row, handles: false, colors: colors(row, refused),
      }));
    }
    if (chestEditor?.active()) {
      const rows = bustSides.map(({ side, row }) => ({ side, row, circle: rowCircle(chestField, row) })), [r, l] = [rows[0]!.circle, rows[1]!.circle];
      const overlap = !!r && !!l && r.r + l.r > Math.hypot(l.cx - r.cx, l.cy - r.cy);
      return rows.flatMap(({ side, row, circle }) => circle ? [{
        center: mapping.toWorld(circle.cx, circle.cy), r: circle.r, band: circle.band, label: bustLabel(side, circle), labelRow: row, handles: true, flash: chestEditor!.flashing(side), colors: colors(row, overlap),
      }] : []);
    }
    return chestOverlayCircles(chestEvaluation(), mapping).map(c => ({ center: c.center, r: c.r, band: c.band, handles: false, colors: colors(c.row, false) }));
  }

  function chestMarkers(): OverlayMarker[] {
    const mapping = currentState().chestMapping;
    if (!mapping.available || !chestEditor?.active() || chestEditor.mode() !== 'landmarks') return [];
    const style = getComputedStyle(document.documentElement), token = (name: string) => style.getPropertyValue(name).trim(), armed = chestEditor.armed();
    const at = (key: LandmarkKey) => {
      const x = Number(input(landmarkInputId(key, 'x')).value.trim() || NaN), y = Number(input(landmarkInputId(key, 'y')).value.trim() || NaN);
      return Number.isFinite(x) && Number.isFinite(y) ? mapping.toWorld(x, y) : null;
    };
    const apexes = [at('apex_r'), at('apex_l')].filter((p): p is { x: number; y: number } => !!p);
    return LANDMARKS.flatMap(({ key, tag }) => {
      const p = at(key); if (!p) return [];
      const stroke = token(key === 'apex_r' ? '--rv-bust-r' : key === 'apex_l' ? '--rv-bust-l' : '--rv-landmark');
      return [{ at: p, tag, active: armed === key, colors: { stroke, fill: stroke, ink: token('--rv-landmark-ink'), labelBg: token('--rv-bust-label-bg') }, ...(key === 'cleavage' ? { guideTo: apexes } : {}) }];
    });
  }

  async function exportChest(): Promise<void> {
    const value = chestEvaluation();
    if (!value.ok) { host.message(`Chest regions not exported: ${value.error}`, true); return; }
    const digest = await sha256Hex(value.text);
    const sideData = currentSideData();
    const mapping = currentState().chestMapping;
    const binding = chestRegionsBinding({
      fileSha256: digest,
      sourceHash: sideData.sourceHash,
      reviewedSource: sideData.reviewedSource,
      exportedAt: new Date().toISOString(),
      mapping: mapping.available ? mapping.basis : mapping.reason,
    });
    host.download('chest-regions.json', value.text, 'application/json');
    host.download('chest-regions.binding.json', JSON.stringify(binding, null, 2) + '\n', 'application/json');
    host.message(`Downloaded chest-regions.json and chest-regions.binding.json for Build ${pickedSide.toUpperCase()}.`);
  }

  function meshSource() {
    const state = currentState(), sideData = currentSideData(), sideAssets = currentAssets();
    if (sideData.manifest.model && !state.partModel) return { ok: false as const, code: 'MESH_EDIT_RIG_UNAVAILABLE: the compiled model document is still loading' };
    const selectedPart = host.parts()?.value();
    const slot = selectedPart?.side === pickedSide ? selectedPart.slot : null;
    return meshEditSource({
      slot,
      model: sideData.manifest.model ? state.partModel : null,
      pose: s => sideAssets ? readSetupPose(sideAssets, s, document.createElement('div')) : null,
      mapping: state.chestMapping,
    });
  }

  async function exportMesh(doc: MeshEditDocument): Promise<void> {
    const raw = meshEditText(doc), digest = await sha256Hex(raw);
    const sideData = currentSideData(), mapping = currentState().chestMapping;
    const binding = meshEditBinding({
      fileSha256: digest,
      sourceHash: sideData.sourceHash,
      reviewedSource: sideData.reviewedSource,
      exportedAt: new Date().toISOString(),
      mapping: mapping.available ? mapping.basis : mapping.reason,
      attachment: { slot: doc.slot, skin: doc.skin, name: doc.attachment, sha256: doc.source.hash },
    });
    host.download('mesh-edit.json', raw, 'application/json');
    host.download('mesh-edit.binding.json', JSON.stringify(binding, null, 2) + '\n', 'application/json');
    host.message(`Downloaded mesh-edit.json (${doc.ops.length} ops) and mesh-edit.binding.json for Build ${pickedSide.toUpperCase()}.`);
  }

  function refreshAnimationInspection(): void {
    if (!animationPanel) return;
    const state = currentState(), player = currentPlayer();
    if (state.partModel) {
      animationPanel.model(state.partModel, player?.current ?? host.data().animation);
      animationPanel.update(host.time(), host.duration());
      if (player) animationPanel.capture(player, host.parts()?.frame(pickedSide));
    } else if (state.inspectedDocumentReason) {
      animationPanel.unavailable(state.inspectedDocumentReason);
    }
    animationPanel.redraw(host.layers.bones);
  }

  function refreshPhysics(): void {
    if (!physicsPanel) return;
    const state = currentState();
    if (state.inspectedDocumentReason) { physicsPanel.load({ available: false, reason: state.inspectedDocumentReason }, []); return; }
    if (!state.inspectedDocument) return;
    if (!state.rebuildStatus) { text('physics-panel-state', 'Reading the producer handoff…'); text('idle-tracks-state', 'Reading the producer handoff…'); return; }
    if (!state.rebuildStatus.inputs || !state.rebuildStatus.producer) {
      physicsPanel.load({ available: false, reason: state.rebuildStatus.reason ?? 'PHYSICS_TUNING_UNAVAILABLE: no producer handoff' }, []);
      return;
    }
    const bones = (state.inspectedDocument as { bones?: unknown }).bones;
    const list = Array.isArray(bones) ? bones.filter((b): b is { name: string; parent?: string } => !!b && typeof (b as { name?: unknown }).name === 'string') : [];
    physicsPanel.load(tuningRows(state.rebuildStatus.constraints ?? null, state.inspectedDocument), list);
    refreshIdle();
  }

  function refreshIdle(): void {
    const state = currentState();
    if (!idlePanel || !state.rebuildStatus) return;
    idlePanel.load(state.rebuildStatus.idle ?? null, state.rebuildStatus.inputs ? null : state.rebuildStatus.reason ?? 'IDLE_TRACKS_UNAVAILABLE: no producer handoff');
    if (state.inspectedDocument) idlePanel.model(boneSetup(state.inspectedDocument));
  }

  function renderHandoff(status: RebuildStatusView): void {
    const line = el('handoff-line'), shown = handoffText(status);
    line.textContent = shown.text; line.title = shown.text; line.classList.toggle('error', shown.error);
    if (handoffTimer) clearTimeout(handoffTimer); handoffTimer = null;
    const side = pickedSide;
    if (status.baseline?.status === 'running') {
      handoffTimer = setTimeout(() => {
        void host.api<RebuildStatusView>(`${sideApiPrefix(side)}/rebuild`).then(next => {
          sides[side].rebuildStatus = next;
          if (pickedSide === side) renderHandoff(next);
        }).catch(() => {});
      }, 2000);
    }
  }

  function renderAppliedBlocks(): void {
    const state = currentState();
    const on = appliedBlockOps(state.appliedOnStage);
    cutsPanel?.applied(on.cuts); clothPanel?.applied(on.cloth);
    animationPanel?.reconcileStageApplied(state.appliedOnStage?.schema === 'rig-review-applied/5' ? state.appliedOnStage : null);
    for (const block of staleReadouts(state.readoutStage, state.appliedOnStage)) {
      (block === 'cuts' ? cutsPanel : clothPanel)?.shown(null);
    }
    state.readoutStage = state.appliedOnStage;
  }

  function renderApplied(): void {
    renderAppliedBlocks();
    const section = document.getElementById('applied-records');
    if (!section) return;
    const state = currentState(), h = state.appliedHistory;
    section.hidden = !h || h.depth === 0;
    const list = el('applied-list');
    list.replaceChildren(...(h?.records ?? []).map((r, i) => {
      const li = document.createElement('li');
      li.textContent = historyRow(h!, i);
      li.dataset.buildId = r.id;
      li.classList.toggle('on-stage', i === h!.records.length - 1 && state.appliedOnStage?.buildId === r.id);
      return li;
    }));
    const control = undoControl(h, state.appliedOnStage?.buildId ?? null, rebuildBusy || !!host.readOnly());
    const undo = button('applied-undo');
    undo.textContent = control.label; undo.disabled = !control.enabled; undo.title = control.title;
  }

  async function refreshApplied(side: Side = pickedSide): Promise<void> {
    if (!sides[side].inspectedModel) return;
    try { sides[side].appliedHistory = await host.api<AppliedHistoryView>(`${sideApiPrefix(side)}/rebuild/history`); } catch { return; }
    if (side === pickedSide) renderApplied();
  }

  function rebuildState(): void {
    const state = currentState();
    chestEditor?.rebuildState({ busy: rebuildBusy, applied: !!state.appliedOnStage });
    renderApplied();
    if (!rebuildBusy) void refreshApplied(pickedSide);
  }

  function applySideStateToPanels(): void {
    const state = currentState(), sideData = currentSideData();
    const selectedPart = host.parts()?.value();
    const currentSlot = selectedPart?.side === pickedSide ? selectedPart.slot : null;
    readingsPanel?.catalog(sideData?.feedbackCatalog.slots ?? [], sideData?.feedbackCatalog.bones ?? []);
    readingsPanel?.status('Pick readings, then Run: each runs on the picked build and on its latest scratch build.', false);
    const status = state.rebuildStatus;
    if (status) {
      if (state.chestInputs !== null) {
        writeChestInputs(state.chestInputs);
      } else {
        clearChestInputs();
        const seed = { ...(seedFields(status, chestField) ?? {}), ...(seedLandmarks(status, chestField) ?? {}) };
        if (Object.keys(seed).length) {
          writeChestInputs(seed);
        }
        state.chestInputs = snapshotChestInputs();
      }
      el('chest-regions').dispatchEvent(new Event('input', { bubbles: true }));
      if (!status.available) chestEditor?.notify(status.reason, true);
      else chestEditor?.notify('', false);
      renderHandoff(status);
      retargetPanel?.load(status.retarget ?? null, status.reason);
      bonesPanel?.load(status.inputs ? status.bones ?? [] : null, status.inputs ? null : status.reason ?? 'BONES_UNAVAILABLE: no producer handoff');
      rigFieldsPanel?.load(status.inputs ? status.fields ?? {} : null, status.inputs ? null : status.reason ?? 'RIG_FIELDS_UNAVAILABLE: no producer handoff');
      clothPanel?.load(status.inputs ? status.cloth ?? null : null, status.inputs ? null : status.reason ?? 'CLOTH_UNAVAILABLE: no producer handoff');
      cutsPanel?.load(status.inputs && status.cuts ? status.cuts.config : null, status.bones ?? [], status.inputs ? null : status.reason ?? 'CUTS_UNAVAILABLE: no producer handoff', status.cuts?.build ?? null);
      meshPanel?.load(status.inputs ? status.meshes ?? {} : null, status.inputs ? null : status.reason ?? 'MESH_PANEL_UNAVAILABLE: no producer handoff');
      meshPanel?.select(currentSlot);
      animationPanel?.loadSource(status.animations ?? null, status.reason);
    } else {
      animationPanel?.setSourceLoading();
    }
    if (state.requirementsCatalog) {
      requirementsPanel?.load(state.requirementsCatalog, state.requirementsCatalog.reason);
    }
    refreshPhysics();
    refreshAnimationInspection();
    weightsView?.refresh();
    meshEditor?.selectionChanged();
    renderApplied();
    renderStrip();
    const draft = el<HTMLTextAreaElement>('rebuild-applied');
    draft.value = state.appliedOnStage ? JSON.stringify(state.appliedOnStage) : '';
  }

  async function loadRebuildStatus(side: Side = pickedSide): Promise<RebuildStatusView | null> {
    try {
      sides[side].rebuildStatus = await host.api<RebuildStatusView>(`${sideApiPrefix(side)}/rebuild`);
    } catch (error) {
      sides[side].rebuildStatus = null;
      const reason = `REBUILD_STATUS_UNAVAILABLE: ${errorText(error)}`;
      if (side === pickedSide) {
        chestEditor?.notify(reason, true);
        animationPanel?.loadSource(null, reason);
      }
      return null;
    }
    if (side === pickedSide) applySideStateToPanels();
    return sides[side].rebuildStatus;
  }

  async function loadRequirements(side: Side = pickedSide): Promise<void> {
    try {
      const catalog = await host.api<RequirementsCatalogView>(`${sideApiPrefix(side)}/requirements`);
      sides[side].requirementsCatalog = catalog;
      if (side === pickedSide) requirementsPanel?.load(catalog, catalog.reason);
    } catch (error) {
      if (side === pickedSide) requirementsPanel?.load(null, `REQUIREMENTS_UNAVAILABLE: ${errorText(error)}`);
    }
  }

  function environmentApplied(): boolean {
    return input('environment-applied').checked;
  }

  function gravityValue(): number {
    return Number(input('gravity').value);
  }

  function stageWorld(): StageWorld {
    return { wind: wind.state(), jolts: joltQueue.map(step => ({ ...step })), applied: environmentApplied(), gravity: gravityValue() };
  }

  function useWorld(): boolean {
    return input('environment-use').checked && environmentApplied();
  }

  function checkAnimation(side: Side = pickedSide): string {
    const sideAssets = host.assets[side];
    return sideAssets?.animations.some(item => item.name === 'idle') ? 'idle' : host.data().animation;
  }

  function clipDuration(name: string, side: Side = pickedSide): number {
    return host.assets[side]?.animations.find(item => item.name === name)?.duration ?? host.duration();
  }

  function worldFor(name: string, side: Side = pickedSide): WorldExport | { error: string } {
    return worldExport(wind.snapshot(), gravityValue(), environmentApplied(), name, clipDuration(name, side));
  }

  function stepEnvironment(dt: number): void {
    const player = currentPlayer();
    if (!player) return;
    wind.advance(dt);
    const { due, pending } = dueJolts(joltQueue, wind.read().time);
    joltQueue = pending;
    for (const step of due) player.moved({ x: step.x, y: step.y });
    if (environmentApplied()) player.environment(environmentFor(wind.read(), gravityValue()));
    renderEnvironment();
  }

  function applyEnvironment(): void {
    const active = workspaceMode !== 'compare' && environmentApplied();
    for (const s of ['a', 'b'] as const) {
      const p = host.players[s];
      if (!p) continue;
      if (s === pickedSide && active) {
        p.environment(environmentFor(wind.read(), gravityValue()));
      } else {
        p.environment(null);
      }
    }
    renderEnvironment();
  }

  function renderSchedule(): void {
    const animation = host.data().animation, check = checkAnimation(pickedSide);
    const world = worldFor(animation, pickedSide), checked = check !== animation ? worldFor(check, pickedSide) : null;
    const shown = 'error' in world
      ? world.error
      : `${world.summary}${useWorld() ? ' · used for readings and Apply' : ''}${checked && !('error' in checked) && checked.sha256 !== world.sha256 ? ` · check reads ${check}'s: ${checked.summary}` : ''}`;
    text('environment-schedule', shown);
  }

  function renderEnvironment(): void {
    if (!currentPlayer()) return;
    const reading = wind.read(), g = gravityValue();
    text('wind-readout', (environmentApplied() ? windReadout(reading, g) : RUNTIME_START_READOUT) + environmentNote);
    const gust = button('wind-gust');
    gust.disabled = reading.gusting;
    gust.setAttribute('aria-pressed', String(reading.gusting));
    gust.textContent = reading.gusting ? 'Gusting…' : 'Gust';
    text('wind-base-label', input('wind-base').value);
    text('gravity-label', g.toFixed(2));
    renderSchedule();
  }

  function restartWindClock(): void {
    const now = wind.read().time;
    wind.restore(wind.snapshot());
    joltQueue = joltQueue.map(step => ({ ...step, at: Math.max(0, step.at - now) }));
  }

  function clipMoved(move: ClipMove): void {
    if (currentPlayer() && restartsWindClock(move, useWorld())) {
      restartWindClock();
      applyEnvironment();
    }
  }

  function syncEnvironmentInputs(): void {
    const s = wind.snapshot();
    input('wind-base').value = String(s.base);
    input('wind-breeze').checked = s.breeze;
    input('wind-repeat').checked = s.repeat;
    input('wind-gust-peak').value = String(s.gustPeak);
    input('wind-gust-duration').value = String(s.gustDuration);
    renderEnvironment();
  }

  function resetPhysics(): void {
    const p = currentPlayer();
    if (!p) return;
    joltQueue = [];
    steppedLive = false;
    wind.restore(null);
    input('environment-applied').checked = false;
    input('gravity').value = '1';
    syncEnvironmentInputs();
    try {
      p.environment(null);
      if (p.current) {
        p.seek(host.time());
        p.draw();
        host.parts()?.present(pickedSide);
        host.redrawOverlays(true);
      }
      environmentNote = ` · physics history cleared; re-posed from ${host.time().toFixed(3)} s`;
    } catch (error) {
      environmentNote = '';
      host.message(`Physics reset refused: ${errorText(error)}`, true);
    }
    renderEnvironment();
    host.saveDraft();
  }

  function restoreEnvironment(): void {
    const snapshot: WindSnapshot = {
      version: 1,
      base: Number(input('wind-base').value),
      breeze: input('wind-breeze').checked,
      repeat: input('wind-repeat').checked,
      gustPeak: Number(input('wind-gust-peak').value),
      gustDuration: Number(input('wind-gust-duration').value),
    };
    try {
      wind.restore(snapshot);
      environmentFor(wind.read(), gravityValue());
    } catch (error) {
      wind.restore(null);
      input('environment-applied').checked = false;
      input('gravity').value = '1';
      host.message(`Saved environment not restored: ${errorText(error)}`, true);
    }
    syncEnvironmentInputs();
    applyEnvironment();
  }

  function seekEndTime(time: number): number {
    const steps = Math.floor(time / compareSeekStep);
    let t = 0;
    for (let i = 0; i < steps; i++) t += compareSeekStep;
    const rest = time - t;
    if (rest > 0) t += rest;
    return t;
  }

  function seekMode(target: number, continuing: boolean): 'settle' | 'seek' {
    if (workspaceMode === 'compare') {
      steppedLive = false;
      return 'seek';
    }
    const p = currentPlayer();
    if (!continuing && steppedLive && p && target >= p.time - 1e-9 && target - p.time <= 0.25) {
      steppedLive = false;
      return 'settle';
    }
    steppedLive = false;
    clipMoved(continuing ? { kind: 'replay' } : { kind: 'seek', to: target });
    return 'seek';
  }

  function stepSide(mode: 'present' | 'settle' | 'seek', side: Side, target: number): void {
    const player = host.players[side];
    if (!player) return;
    if (workspaceMode === 'compare' || side !== pickedSide) {
      player.environment(null);
      player.seek(target);
      return;
    }
    const end = seekEndTime(target);
    if ((mode === 'settle' || (mode === 'present' && (environmentApplied() || joltQueue.length > 0 || steppedLive))) && end >= player.time - 1e-9) {
      if (mode === 'present') steppedLive = true;
      player.resume();
      try {
        const step = compareSeekStep;
        while (player.time + step < end) {
          stepEnvironment(step);
          player.advance(step);
        }
        while (player.time > 0 && player.time < end / 2) {
          const d = Math.min(step, end / 2);
          stepEnvironment(d);
          player.advance(d);
        }
        const rest = end - player.time;
        if (rest > 0) {
          stepEnvironment(rest);
          player.advance(rest);
        }
      } finally {
        player.pause();
      }
      return;
    }
    steppedLive = false;
    if (environmentApplied()) {
      player.environment(environmentFor(wind.read(), gravityValue()));
    } else {
      player.environment(null);
    }
    player.seek(target);
  }

  function stageChanged(side: Side, change: StageChange<NonNullable<SideBuildState['stripPending']>>): void {
    const state = sides[side];
    const next = stripPendingAfter(state.stripPending, change);
    if (next === state.stripPending) return;
    state.stripPending = next;
    void refreshDensityStrip(side);
  }

  async function swapPickedSide(side: Side, modelUrl: string, prefix: string, sha256: string, clipName?: string): Promise<void> {
    await host.swapSideRig(side, modelUrl, prefix, sha256, clipName);
    applyEnvironment();
  }

  async function applyRebuild(): Promise<void> {
    if (rebuildBusy) return;
    const ro = host.readOnly();
    if (ro) { chestEditor?.notify(ro, true); return; }
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side);
    if (!status || !status.available || !status.inputs) {
      const reason = status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE';
      chestEditor?.notify(reason, true, [reason]); host.message(reason, true); return;
    }
    let part: string, body: RebuildRequestBody;
    const lines: string[] = [];
    if (chestEditor?.mode() === 'landmarks') {
      const request = landmarksRequest(status, chestEditor.landmarks());
      if ('error' in request) { chestEditor.notify(request.error, true, [request.error]); host.message(request.error, true); return; }
      ({ part, body } = request);
    } else {
      const designated = designatedRegions(chestField);
      if ('error' in designated) { chestEditor?.notify(designated.error, true); return; }
      const picked = pickPart(status, designated.regions);
      if (!picked) { chestEditor?.notify(`REBUILD_PART_AMBIGUOUS: the config states ${status.parts.length} contour meshes and the designated bones name none of them alone`, true); return; }
      part = picked; body = { part, regions: designated.regions, configHash: status.inputs.configHash };
    }
    rebuildBusy = true; rebuildState();
    chestEditor?.notify(`Rebuilding ${part} on Build ${side.toUpperCase()} with ${status.producer?.package} ${status.producer?.version}…`, false, []);
    try {
      const result = await runRebuild(body, {
        post: value => host.api<RebuildJobView | RebuildRefusal>(`${sideApiPrefix(side)}/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
        get: id => host.api<RebuildJobView>(`${sideApiPrefix(side)}/rebuild/${id}`),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        onLine: line => { lines.push(line); chestEditor?.notify(line.trim() || '…', false, lines.slice(-6)); },
      });
      const outcome = outcomeLine(result);
      if (!('id' in result) || result.status !== 'built' || !result.build) {
        chestEditor?.notify(outcome.text, true, [...lines.slice(-5), outcome.text]);
        host.message(outcome.text, true);
        return;
      }
      await swapPickedSide(side, new URL(host.route(result.build.modelUrl), location.href).href, host.route(`/compare-rebuild/${side}/${result.id}/`), result.build.modelHash);
      state.appliedOnStage = appliedRecord(result); state.stageCheck = null; stageChanged(side, { kind: 'apply', via: 'regions' });
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = JSON.stringify(state.appliedOnStage); draft.dispatchEvent(new Event('input', { bubbles: true }));
      chestEditor?.notify(outcome.text, false, []); host.message(outcome.text);
    } catch (error) {
      chestEditor?.notify(`REBUILD_FAILED: ${errorText(error)}`, true);
      host.message(`REBUILD_FAILED: ${errorText(error)}`, true);
    } finally {
      rebuildBusy = false; rebuildState();
    }
  }

  async function applyPatch(patch: ConfigPatch, _world: StageWorld | null = null): Promise<PatchJobView | RebuildRefusal> {
    if (rebuildBusy) return { status: 'refused', error: 'REBUILD_BUSY: an Apply is still running', producerLine: null };
    const ro = host.readOnly();
    if (ro) { chestEditor?.notify(ro, true); return { status: 'refused', error: ro, producerLine: null }; }
    const side = pickedSide, state = sides[side];
    const lines: string[] = [];
    rebuildBusy = true; rebuildState();
    chestEditor?.notify(`Applying patch on Build ${side.toUpperCase()} (${patch.op.cmd}, ${patch.ops.length} op(s))…`, false, []);
    try {
      const scheduled = useWorld() ? worldFor(checkAnimation(side), side) : null;
      if (scheduled && 'error' in scheduled) {
        chestEditor?.notify(scheduled.error, true); host.message(scheduled.error, true);
        return { status: 'refused', error: scheduled.error, producerLine: scheduled.error };
      }
      const result = await runRebuild<{ patch: ConfigPatch; environment?: WorldExport['schedule'] }, PatchJobView>(
        { patch, ...(scheduled ? { environment: scheduled.schedule } : {}) },
        {
          post: value => host.api<PatchJobView | RebuildRefusal>(`${sideApiPrefix(side)}/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
          get: id => host.api<PatchJobView>(`${sideApiPrefix(side)}/rebuild/${id}`),
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
          onLine: line => { lines.push(line); chestEditor?.notify(line.trim() || '…', false, lines.slice(-6)); },
        },
      );
      const outcome = patchOutcomeLine(result), next = stageModel(result, { url: '', hash: state.stageModelHash ?? '' });
      if (next.id === null || !('id' in result)) {
        chestEditor?.notify(outcome.text, true, [...lines.slice(-5), outcome.text]);
        host.message(outcome.text, true);
        return result;
      }
      await swapPickedSide(side, new URL(host.route(next.url), location.href).href, host.route(`/compare-rebuild/${side}/${next.id}/`), next.hash);
      state.appliedOnStage = patchAppliedRecord(result);
      state.stageCheck = { lines: [...result.lines], check: result.check };
      stageChanged(side, { kind: 'apply', via: 'patch' });
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = JSON.stringify(state.appliedOnStage); draft.dispatchEvent(new Event('input', { bubbles: true }));
      chestEditor?.notify(outcome.text, outcome.error, []); host.message(outcome.text, outcome.error);
      return result;
    } catch (error) {
      const textMsg = `REBUILD_FAILED: ${errorText(error)}`;
      chestEditor?.notify(textMsg, true); host.message(textMsg, true);
      return { status: 'refused', error: textMsg, producerLine: null };
    } finally {
      rebuildBusy = false; rebuildState();
    }
  }

  async function applyMeshDelta(doc: MeshEditDocument, line: (text: string) => void): Promise<{ built: boolean; text: string; error: boolean }> {
    if (rebuildBusy) return { built: false, text: 'REBUILD_BUSY: an Apply is still running', error: true };
    const ro = host.readOnly();
    if (ro) return { built: false, text: ro, error: true };
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side);
    if (!status?.inputs) return { built: false, text: status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE', error: true };
    const body: DeltaRequestBody = { part: doc.slot, delta: doc, configHash: status.inputs.configHash };
    rebuildBusy = true; rebuildState();
    try {
      const result = await runRebuild<DeltaRequestBody, DeltaJobView>(body, {
        post: value => host.api<DeltaJobView | RebuildRefusal>(`${sideApiPrefix(side)}/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
        get: id => host.api<DeltaJobView>(`${sideApiPrefix(side)}/rebuild/${id}`),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        onLine: textLine => line(textLine),
      });
      const outcome = deltaOutcomeLine(result), next = stageModel(result, { url: '', hash: state.stageModelHash ?? '' });
      if (next.id === null || !('id' in result)) { host.message(outcome.text, true); return { built: false, text: outcome.text, error: true }; }
      await swapPickedSide(side, new URL(host.route(next.url), location.href).href, host.route(`/compare-rebuild/${side}/${next.id}/`), next.hash);
      state.appliedOnStage = deltaAppliedRecord(result); state.stageCheck = null; stageChanged(side, { kind: 'apply', via: 'delta' });
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = JSON.stringify(state.appliedOnStage); draft.dispatchEvent(new Event('input', { bubbles: true }));
      host.message(outcome.text);
      return { built: true, text: outcome.text, error: false };
    } catch (error) {
      const textMsg = `REBUILD_FAILED: ${errorText(error)}`; host.message(textMsg, true);
      return { built: false, text: textMsg, error: true };
    } finally {
      rebuildBusy = false; rebuildState();
    }
  }

  async function applyRetarget(body: { sequence: string; map: PoseMap; flags: RetargetFlags }): Promise<RetargetJobView | RebuildRefusal | null> {
    if (rebuildBusy) { retargetPanel?.status('REBUILD_BUSY: an Apply is still running', true); return null; }
    const ro = host.readOnly();
    if (ro) { retargetPanel?.status(ro, true); return null; }
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side);
    if (!status?.inputs) { retargetPanel?.status(status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE', true); return null; }
    const request: RetargetRequestBody = { retarget: { ...body, configHash: status.inputs.configHash } };
    rebuildBusy = true; rebuildState(); retargetPanel?.busy(true); retargetPanel?.result(null);
    retargetPanel?.status(`Retargeting ${body.sequence} as "${body.flags.animation}" on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await runRebuild<RetargetRequestBody, RetargetJobView>(request, {
        post: value => host.api<RetargetJobView | RebuildRefusal>(`${sideApiPrefix(side)}/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
        get: id => host.api<RetargetJobView>(`${sideApiPrefix(side)}/rebuild/${id}`),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        onLine: textLine => retargetPanel?.line(textLine),
      });
      const outcome = retargetOutcomeLine(result), next = stageModel(result, { url: '', hash: state.stageModelHash ?? '' });
      retargetPanel?.result(result); retargetPanel?.status(outcome.text, outcome.error);
      if (next.id === null || !('id' in result)) { host.message(outcome.text, true); return result; }
      await swapPickedSide(side, new URL(host.route(next.url), location.href).href, host.route(`/compare-rebuild/${side}/${next.id}/`), next.hash, result.request.record.flags.animation);
      state.appliedOnStage = retargetAppliedRecord(result); state.stageCheck = null; stageChanged(side, { kind: 'apply', via: 'retarget' });
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = JSON.stringify(state.appliedOnStage); draft.dispatchEvent(new Event('input', { bubbles: true }));
      host.message(outcome.text, outcome.error);
      return result;
    } catch (error) {
      const textMsg = `REBUILD_FAILED: ${errorText(error)}`; retargetPanel?.status(textMsg, true); host.message(textMsg, true);
      return { status: 'refused', error: textMsg, producerLine: null };
    } finally {
      rebuildBusy = false; rebuildState(); retargetPanel?.busy(false);
    }
  }

  async function resetRebuild(_world: StageWorld | null = null): Promise<void> {
    const side = pickedSide, state = sides[side];
    if (rebuildBusy || (!state.appliedOnStage && !state.stripPending) || !state.inspectedModel) return;
    rebuildBusy = true; rebuildState();
    try {
      await swapPickedSide(side, state.inspectedModel.url, state.inspectedModel.prefix, state.inspectedModel.sha256);
      state.appliedOnStage = null; state.stageCheck = null; stageChanged(side, { kind: 'reset' });
      chestEditor?.notify(`Reset: Build ${side.toUpperCase()} is back on its inspected build.`, false);
      host.message(`Reset Build ${side.toUpperCase()} to its inspected build.`);
    } catch (error) {
      chestEditor?.notify(`REBUILD_RESET_FAILED: ${errorText(error)}`, true);
    } finally {
      rebuildBusy = false; rebuildState();
    }
  }

  function appliedStatus(msg: string, error = false): void {
    const node = el('applied-status'); node.textContent = msg; node.classList.toggle('error', error);
  }

  async function undoApply(): Promise<UndoView | null> {
    const side = pickedSide, state = sides[side];
    const from = state.appliedOnStage?.buildId;
    if (rebuildBusy || host.readOnly() || !from || !state.inspectedModel) return null;
    rebuildBusy = true; rebuildState(); appliedStatus('Undoing the last Apply…');
    try {
      let result = await host.api<UndoView>(`${sideApiPrefix(side)}/rebuild/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from }) });
      if (result.status === 'running') {
        let job = result.job as AnyJobView; const undone = result.undone; let seen = 0;
        while (job.status === 'running') {
          await new Promise(resolve => setTimeout(resolve, 700));
          job = await host.api<AnyJobView>(`${sideApiPrefix(side)}/rebuild/${job.id}`);
          for (; seen < job.lines.length; seen++) appliedStatus(job.lines[seen]!.trim() || '…');
        }
        if (job.status !== 'built') {
          const textMsg = refusedText(job); appliedStatus(textMsg, true); host.message(textMsg, true);
          return { status: 'refused', error: textMsg, producerLine: job.producerLine };
        }
        result = { status: 'built', undone, job, history: await host.api<AppliedHistoryView>(`${sideApiPrefix(side)}/rebuild/history`) };
      }
      if (result.status === 'refused') { appliedStatus(result.error, true); host.message(result.error, true); return result; }
      let ops: PatchOp[] | null = null;
      if (result.status === 'inspected') {
        await swapPickedSide(side, state.inspectedModel.url, state.inspectedModel.prefix, state.inspectedModel.sha256);
        state.appliedOnStage = null; state.stageCheck = null;
      } else {
        const job = result.job; if (!job.build) throw new Error('the restored job carries no build');
        await swapPickedSide(side, new URL(host.route(job.build.modelUrl), location.href).href, host.route(`/compare-rebuild/${side}/${job.id}/`), job.build.modelHash);
        state.appliedOnStage = recordFor(job);
        state.stageCheck = (job as PatchJobView).kind === 'patch' ? { lines: [...job.lines], check: (job as PatchJobView).check } : null;
        if ((job as PatchJobView).kind === 'patch') ops = (job as PatchJobView).request.patch.ops;
      }
      stageChanged(side, { kind: 'undo' });
      physicsPanel?.applied(ops); idlePanel?.applied(ops); rigFieldsPanel?.applied(ops); bonesPanel?.applied(ops);
      const restored = result.status === 'built' && isPatchJob(result.job) ? result.job : null, block = recordBlock(state.appliedOnStage);
      cutsPanel?.shown(block === 'cuts' ? restored : null); clothPanel?.shown(block === 'cloth' ? restored : null);
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = state.appliedOnStage ? JSON.stringify(state.appliedOnStage) : ''; draft.dispatchEvent(new Event('input', { bubbles: true }));
      state.appliedHistory = result.history;
      const textMsg = `Undid ${result.undone.slice(0, 12)}… on Build ${side.toUpperCase()} · ${result.history.depth} applied record(s) left`;
      appliedStatus(textMsg); host.message(textMsg); host.redrawOverlays(true);
      return result;
    } catch (error) {
      const textMsg = `UNDO_FAILED: ${errorText(error)}`; appliedStatus(textMsg, true); host.message(textMsg, true);
      return { status: 'refused', error: textMsg, producerLine: null };
    } finally {
      rebuildBusy = false; rebuildState();
    }
  }

  function inspectedCheckView(side: Side = pickedSide): InspectedCheckView | null {
    return sides[side].rebuildStatus?.inspectedCheck ?? null;
  }

  async function followInspectedCheck(show: () => void, side: Side = pickedSide): Promise<void> {
    for (let i = 0; i < 120 && (!sides[side].rebuildStatus?.inspectedCheck || sides[side].rebuildStatus?.inspectedCheck?.status === 'running'); i++) {
      try { sides[side].rebuildStatus = await host.api<RebuildStatusView>(`${sideApiPrefix(side)}/rebuild`); } catch { return; }
      if (side === pickedSide) show();
      if (sides[side].rebuildStatus?.inspectedCheck && sides[side].rebuildStatus?.inspectedCheck?.status !== 'running') return;
      if (!sides[side].rebuildStatus?.inspectedCheck && sides[side].rebuildStatus?.baseline?.status !== 'running') return;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  async function applyPhysics(ops: PatchOp[]): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side);
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig' }) : null;
    if (!patch) { const reason = !ops.length ? 'PHYSICS_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; physicsPanel?.status(reason, true); return null; }
    physicsPanel?.clearPreview();
    const world = stageWorld(), before = state.stageCheck;
    physicsPanel?.busy(true); physicsPanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, world);
      const outcome = patchOutcomeLine(result); physicsPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') {
        physicsPanel?.applied(result.request.patch.ops);
        const after = { lines: [...result.lines], check: result.check };
        const show = () => physicsPanel?.readout(readoutRows(before, before ? null : inspectedCheckView(side), after));
        show(); if (!before) void followInspectedCheck(show, side);
      }
      return result;
    } finally { physicsPanel?.busy(false); }
  }

  async function resetPhysicsBuild(): Promise<void> {
    physicsPanel?.clear(); physicsPanel?.applied(null); physicsPanel?.readout([]);
    if (currentState().appliedOnStage) { physicsPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { physicsPanel?.busy(false); } }
    physicsPanel?.status('Reset: the inspected build is on the stage; no pending ops.', false);
  }

  async function applyIdle(ops: PatchOp[], keys: 'ctl' | 'direct' | null): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side);
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig', args: keys ? ['--idle-keys', keys] : [] }) : null;
    if (!patch) { const reason = !ops.length ? 'IDLE_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; idlePanel?.status(reason, true); return null; }
    const world = stageWorld(), before = state.stageCheck;
    idlePanel?.busy(true); idlePanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, world);
      const outcome = patchOutcomeLine(result); idlePanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') {
        idlePanel?.applied(result.request.patch.ops);
        const after = { lines: [...result.lines], check: result.check };
        const show = () => idlePanel?.readout(readoutRows(before, before ? null : inspectedCheckView(side), after, IDLE_READOUT_BARS));
        show(); if (!before) void followInspectedCheck(show, side);
      }
      return result;
    } finally { idlePanel?.busy(false); }
  }

  async function resetIdleBuild(): Promise<void> {
    idlePanel?.clear(); idlePanel?.applied(null); idlePanel?.readout([]);
    if (currentState().appliedOnStage) { idlePanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { idlePanel?.busy(false); } }
    idlePanel?.status('Reset: the inspected build is on the stage; no pending ops; the preview is cleared.', false);
  }

  async function checkBones(ops: PatchOp[]): Promise<BonesCheckView> {
    const side = pickedSide, status = sides[side].rebuildStatus ?? await loadRebuildStatus(side);
    if (!status?.inputs) return { status: 'refused', error: status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE' };
    try { return await host.api<BonesCheckView>(`${sideApiPrefix(side)}/bones-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops, configHash: status.inputs.configHash }) }); }
    catch (error) { const raw = errorText(error).replace(/^\d+: /, ''); try { return { status: 'refused', error: (JSON.parse(raw) as { error?: string }).error ?? raw }; } catch { return { status: 'refused', error: raw }; } }
  }

  async function applyBones(ops: PatchOp[]): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, status = sides[side].rebuildStatus ?? await loadRebuildStatus(side);
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig' }) : null;
    if (!patch) { const reason = !ops.length ? 'BONES_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; bonesPanel?.status(reason, true); return null; }
    bonesPanel?.busy(true); bonesPanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, stageWorld());
      const outcome = patchOutcomeLine(result); bonesPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') { bonesPanel?.applied(result.request.patch.ops); host.redrawOverlays(true); }
      return result;
    } finally { bonesPanel?.busy(false); }
  }

  async function resetBonesBuild(): Promise<void> {
    bonesPanel?.clear(); bonesPanel?.applied(null);
    if (currentState().appliedOnStage) { bonesPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { bonesPanel?.busy(false); } }
    bonesPanel?.status('Reset: the inspected build is on the stage; no pending ops.', false);
  }

  async function applyCuts(ops: PatchOp[]): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, status = sides[side].rebuildStatus ?? await loadRebuildStatus(side);
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig' }) : null;
    if (!patch) { const reason = !ops.length ? 'CUTS_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; cutsPanel?.status(reason, true); return null; }
    cutsPanel?.busy(true); cutsPanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, stageWorld());
      const outcome = patchOutcomeLine(result); cutsPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') host.redrawOverlays(true);
      return result;
    } finally { cutsPanel?.busy(false); }
  }

  async function resetCutsBuild(): Promise<void> {
    cutsPanel?.clear(); cutsPanel?.shown(null);
    if (currentState().appliedOnStage) { cutsPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { cutsPanel?.busy(false); } }
    cutsPanel?.status('Reset: the inspected build is on the stage; no pending ops.', false);
  }

  async function applyCloth(ops: PatchOp[]): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, status = sides[side].rebuildStatus ?? await loadRebuildStatus(side);
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig' }) : null;
    if (!patch) { const reason = !ops.length ? 'CLOTH_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; clothPanel?.status(reason, true); return null; }
    clothPanel?.busy(true); clothPanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, stageWorld());
      const outcome = patchOutcomeLine(result); clothPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') host.redrawOverlays(true);
      return result;
    } finally { clothPanel?.busy(false); }
  }

  async function resetClothBuild(): Promise<void> {
    clothPanel?.clear(); clothPanel?.shown(null);
    if (currentState().appliedOnStage) { clothPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { clothPanel?.busy(false); } }
    clothPanel?.status('Reset: the inspected build is on the stage; no pending ops.', false);
  }

  async function applyRigFields(ops: PatchOp[]): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, state = sides[side], status = state.rebuildStatus ?? await loadRebuildStatus(side);
    try { assertRigFieldOps(ops); } catch (error) { rigFieldsPanel?.status(errorText(error), true); return null; }
    const patch = status && ops.length ? makePatch(status, ops, { cmd: 'rig' }) : null;
    if (!patch) { const reason = !ops.length ? 'RIG_FIELDS_NOTHING_PENDING: no pending ops' : status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE'; rigFieldsPanel?.status(reason, true); return null; }
    const world = stageWorld(), before = state.stageCheck;
    rigFieldsPanel?.busy(true); rigFieldsPanel?.status(`Applying ${ops.length} op(s) on Build ${side.toUpperCase()}…`, false);
    try {
      const result = await applyPatch(patch, world);
      const outcome = patchOutcomeLine(result); rigFieldsPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') {
        rigFieldsPanel?.applied(result.request.patch.ops);
        const after = { lines: [...result.lines], check: result.check };
        const show = () => rigFieldsPanel?.readout(readoutRows(before, before ? null : inspectedCheckView(side), after, RIG_FIELDS_READOUT_BARS));
        show(); if (!before) void followInspectedCheck(show, side);
      }
      return result;
    } finally { rigFieldsPanel?.busy(false); }
  }

  async function resetRigFieldsBuild(): Promise<void> {
    rigFieldsPanel?.setDial(0); rigFieldsPanel?.clear(); rigFieldsPanel?.applied(null); rigFieldsPanel?.readout([]);
    if (currentState().appliedOnStage) { rigFieldsPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { rigFieldsPanel?.busy(false); } }
    rigFieldsPanel?.status('Reset: the inspected build is on the stage; no pending ops; the dial is at 0.', false);
  }

  async function applyMesh(part: string, entry: MeshEntry): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, state = sides[side], status = state.rebuildStatus ?? await loadRebuildStatus(side);
    const problems = meshPanel?.precheck() ?? [];
    if (problems.length) { meshPanel?.status(`${problems[0]} (review pre-check; nothing sent)`, true); return null; }
    const patch = status ? makePatch(status, meshPatchOps(part, entry), { cmd: 'remesh', args: ['--part', part] }) : null;
    if (!patch) { meshPanel?.status(status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE', true); return null; }
    try { assertMeshPatch(patch, part); } catch (error) { meshPanel?.status(errorText(error), true); return null; }
    lastMeshPatch = patch;
    const world = stageWorld(), before = state.stageCheck;
    meshPanel?.busy(true); meshPanel?.status(`Applying meshes.${part} on Build ${side.toUpperCase()} with ${patch.producer.name} ${patch.producer.version}: remesh --mesh, compile, check…`, false);
    try {
      const result = await applyPatch(patch, world);
      const outcome = meshApplyOutcome(result as Parameters<typeof meshApplyOutcome>[0]);
      meshPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') {
        if (!host.layers.mesh) { host.layers.mesh = true; input('layer-mesh').checked = true; }
        const player = host.players[side];
        if (player) { player.draw(); host.parts()?.present(side); }
        host.redrawOverlays(true);
        const counts = result.remesh ?? null, overlay = state.lastOverlay?.meshTriangles[part] ?? null;
        const agree = triangleAgreement(counts, counts?.modelTriangles ?? null, overlay);
        meshPanel?.counts([
          ...(counts ? [{ label: 'BEFORE', text: `${counts.part} ${countsText(counts.before)} (remesh.json)` }, { label: 'AFTER', text: `${counts.part} ${countsText(counts.after)} (remesh.json)` }] : []),
          { label: agree.ok ? 'AGREE' : 'DIFFER', text: agree.line, error: !agree.ok },
        ]);
        const after = { lines: [...result.lines], check: result.check };
        const show = () => meshPanel?.readout(readoutRows(before, before ? null : inspectedCheckView(side), after, ['TEXTURE_STRETCH']));
        show(); if (!before) void followInspectedCheck(show, side);
      }
      return result;
    } finally { meshPanel?.busy(false); }
  }

  async function resetMeshBuild(): Promise<void> {
    meshPanel?.counts([]); meshPanel?.readout([]);
    if (currentState().appliedOnStage || currentState().stripPending) {
      meshPanel?.busy(true); try { await resetRebuild(stageWorld()); } finally { meshPanel?.busy(false); }
    }
    meshPanel?.status('Reset: the inspected build is on the stage; the pending entry is the config\'s.', false);
  }

  const densityLine = (msg: string, error = false) => { densityStrip?.status(msg, error); if (error) host.message(msg, true); };
  const renderStrip = () => {
    const state = currentState();
    densityStrip?.show(state.stripView, state.stripPending && state.stripView?.id === state.stripPending.id ? state.stripPending.index : null, densityBusy || rebuildBusy || !!host.readOnly());
  };

  async function refreshDensityStrip(side: Side = pickedSide): Promise<void> {
    try { const r = await host.api<{ strip: DensityStripViewLike | null }>(`${sideApiPrefix(side)}/density-strip`); sides[side].stripView = r.strip; } catch { /* keep */ }
    if (side === pickedSide) renderStrip();
  }

  async function buildDensityStrip(values: number[]): Promise<DensityStripViewLike | { error: string }> {
    if (densityBusy) return { error: 'DENSITY_STRIP_BUSY: a strip is still building' };
    const ro = host.readOnly();
    if (ro) { densityLine(ro, true); return { error: ro }; }
    const side = pickedSide, state = sides[side];
    const status = state.rebuildStatus ?? await loadRebuildStatus(side), part = meshPanel?.part() ?? null, entry = meshPanel?.entry() ?? null;
    if (!status || !part || !entry) { const t = status?.reason ?? 'MESH_PANEL_NO_PART: select a mesh part'; densityLine(t, true); return { error: t }; }
    const problems = meshPanel?.precheck() ?? [];
    if (problems.length) { const t = `${problems[0]} (review pre-check; nothing sent)`; densityLine(t, true); return { error: t }; }
    let patches: ConfigPatch[];
    try {
      const field = densityField(entry, part);
      patches = values.map(v => {
        const patch = makePatch(status, meshPatchOps(part, setEntryValue(entry, densityPath(field), v)), { cmd: 'remesh', args: ['--part', part] });
        if (!patch) throw new Error(status.reason ?? 'REBUILD_STATUS_UNAVAILABLE');
        assertMeshPatch(patch, part);
        return patch;
      });
    } catch (error) { const t = errorText(error); densityLine(t, true); return { error: t }; }
    if (state.stripPending) await stripBack();
    densityBusy = true; renderStrip();
    densityLine(`Building a strip of ${values.length} on ${part} (Build ${side.toUpperCase()}): ${values.join(', ')}…`);
    const t0 = performance.now();
    try {
      let view: DensityStripViewLike | { status: string; error: string };
      try { view = await host.api<DensityStripViewLike | { status: string; error: string }>(`${sideApiPrefix(side)}/density-strip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patches }) }); }
      catch (error) { const t = errorText(error); densityLine(t, true); return { error: t }; }
      if ('error' in view) { densityLine(view.error, true); return { error: view.error }; }
      state.stripView = view; renderStrip();
      while (state.stripView.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        state.stripView = await host.api<DensityStripViewLike>(`${sideApiPrefix(side)}/density-strip/${state.stripView.id}`);
        renderStrip();
        const settled = state.stripView.rows.filter(r => r.status !== 'running').length;
        densityLine(`Strip ${state.stripView.id.slice(0, 12)}…: ${settled} of ${state.stripView.rows.length} settled · ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
      const passing = state.stripView.rows.filter(r => r.verdict === 'PASS').length;
      densityLine(`Strip of ${state.stripView.rows.length} on ${state.stripView.part} settled: ${passing} passing.`);
      return state.stripView;
    } finally { densityBusy = false; renderStrip(); }
  }

  async function loadStripRow(index: number): Promise<{ line: string; ok: boolean } | { error: string }> {
    const side = pickedSide, state = sides[side];
    const view = state.stripView, row = view?.rows[index];
    if (!view || !row) return { error: 'DENSITY_STRIP_NOT_FOUND' };
    if (!row.modelUrl || !row.modelHash) { const t = `DENSITY_STRIP_ROW_NOT_LOADABLE: ${row.value} — ${row.applied ? 'applied already' : row.verdict}`; densityLine(t, true); return { error: t }; }
    if (rebuildBusy || densityBusy) return { error: 'REBUILD_BUSY' };
    const back = state.stripPending?.back ?? {
      url: state.stageSource?.url ?? state.inspectedModel!.url,
      prefix: state.stageSource?.prefix ?? state.inspectedModel!.prefix,
      hash: state.stageSource?.hash ?? state.inspectedModel!.sha256,
      applied: state.appliedOnStage,
      check: state.stageCheck,
    };
    rebuildBusy = true; rebuildState();
    try {
      await swapPickedSide(side, new URL(host.route(row.modelUrl), location.href).href, host.route(`/compare-density-strip/${side}/${view.id}/${row.id}/`), row.modelHash);
      state.stripPending = { index, id: view.id, candidate: row.id, back };
      state.appliedOnStage = null; state.stageCheck = null;
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = ''; draft.dispatchEvent(new Event('input', { bubbles: true }));
      meshPanel?.setEntry(row.entry as MeshEntry);
      if (!host.layers.mesh) { host.layers.mesh = true; input('layer-mesh').checked = true; }
      host.redrawOverlays(true);
      const c = row.counts ? { vertices: row.counts.vertices, triangles: row.counts.triangles, hull: 0 } : null;
      const agree = triangleAgreement(c ? { part: view.part, before: c, after: c } : null, row.modelTriangles, state.lastOverlay?.meshTriangles[view.part] ?? null);
      meshPanel?.counts([{ label: 'PENDING', text: `${view.field} ${row.value} — not applied` }, { label: agree.ok ? 'AGREE' : 'DIFFER', text: agree.line, error: !agree.ok }]);
      densityLine(`Pending on Build ${side.toUpperCase()}: ${view.part} ${view.field} ${row.value} (strip row ${index + 1}) — not applied.`, !agree.ok);
      return { line: agree.line, ok: agree.ok };
    } catch (error) { const t = `DENSITY_STRIP_LOAD_FAILED: ${errorText(error)}`; densityLine(t, true); return { error: t }; }
    finally { rebuildBusy = false; rebuildState(); renderStrip(); }
  }

  async function stripBack(): Promise<void> {
    const side = pickedSide, state = sides[side], pending = state.stripPending;
    if (!pending || rebuildBusy) return;
    rebuildBusy = true; rebuildState();
    try {
      await swapPickedSide(side, pending.back.url, pending.back.prefix, pending.back.hash);
      state.appliedOnStage = pending.back.applied; state.stageCheck = pending.back.check; state.stripPending = null;
      const draft = el<HTMLTextAreaElement>('rebuild-applied'); draft.value = state.appliedOnStage ? JSON.stringify(state.appliedOnStage) : ''; draft.dispatchEvent(new Event('input', { bubbles: true }));
      meshPanel?.counts([]); host.redrawOverlays(true);
      densityLine(`Back: Build ${side.toUpperCase()} shows ${state.appliedOnStage ? 'the last applied record' : 'the inspected build'}.`);
    } catch (error) { densityLine(`DENSITY_STRIP_BACK_FAILED: ${errorText(error)}`, true); }
    finally { rebuildBusy = false; rebuildState(); renderStrip(); }
  }

  async function closeDensityStrip(): Promise<{ status: string; error?: string }> {
    const side = pickedSide, state = sides[side], view = state.stripView;
    if (!view) return { status: 'closed' };
    if (state.stripPending && state.stripPending.id === view.id) await stripBack();
    try {
      const r = await host.api<{ status: string; error?: string }>(`${sideApiPrefix(side)}/density-strip/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: view.id }) });
      if (r.status !== 'closed') { densityLine(r.error ?? 'DENSITY_STRIP_CLOSE_REFUSED', true); return r; }
      state.stripView = null; renderStrip(); densityLine('Strip closed; its scratch is removed.'); return r;
    } catch (error) { const t = errorText(error); densityLine(t, true); return { status: 'refused', error: t }; }
  }

  async function runReadings(override?: { readings: import('../src/readings.ts').ReadingRequest[] }): Promise<ReadingsJobView | ReadingsRefusal | null> {
    if (!readingsPanel || readingsBusy) return null;
    const chosen = override ?? readingsPanel.requests();
    if ('error' in chosen) { readingsPanel.status(chosen.error, true); return { status: 'refused', error: chosen.error }; }
    const side = pickedSide, animation = host.data().animation;
    let environment: ReturnType<typeof environmentFor> | WorldExport['schedule'] | null = currentPlayer() && input('environment-applied').checked ? environmentFor(wind.read(), Number(input('gravity').value)) : null;
    if (environment && useWorld()) {
      const world = worldFor(animation, side);
      if ('error' in world) { readingsPanel.status(world.error, true); return { status: 'refused', error: world.error }; }
      environment = world.schedule;
    }
    const body = { animation, readings: chosen.readings, environment };
    readingsBusy = true; readingsPanel.busy(true); readingsPanel.status(`Running ${chosen.readings.length} reading(s) of ${animation} on Build ${side.toUpperCase()}…`, false);
    const started = performance.now();
    try {
      let job = await host.api<ReadingsJobView | ReadingsRefusal>(`${sideApiPrefix(side)}/readings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(error => ({ status: 'refused' as const, error: errorText(error).replace(/^\d+: /, '') }));
      if (!('id' in job)) {
        const textMsg = (() => { try { return (JSON.parse(job.error) as { error?: string }).error ?? job.error; } catch { return job.error; } })();
        readingsPanel.status(textMsg, true); return { status: 'refused', error: textMsg };
      }
      while (job.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 800));
        job = await host.api<ReadingsJobView>(`${sideApiPrefix(side)}/readings/${job.id}`);
      }
      if (job.status === 'failed') { readingsPanel.status(job.error ?? 'READINGS_FAILED', true); return job; }
      sides[side].readingsJob = job; readingsPanel.lines(job);
      const ticks = job.runs.map(r => `${r.build} ${r.results.reduce((n, x) => n + x.frames.length, 0)} tick(s)`).join(' · ');
      const refused = job.runs.flatMap(r => r.results).find(r => r.status !== 'read');
      readingsPanel.status(`${refused ? `${refused.refusal} · ` : ''}Readings of ${job.request.animation}: ${ticks} · ${((performance.now() - started) / 1000).toFixed(1)} s`, !!refused);
      return job;
    } catch (error) { readingsPanel.status(`READINGS_FAILED: ${errorText(error)}`, true); return null; }
    finally { readingsBusy = false; readingsPanel.busy(false); }
  }

  function readingsContext(): ReadingsContext | null {
    const job = currentState().readingsJob;
    if (!job) return null;
    const ticks = (build: 'inspected' | 'scratch') => {
      const run = job.runs.find(r => r.build === build);
      return run ? run.results.reduce((n, r) => n + r.frames.length, 0) : null;
    };
    return {
      schema: READINGS_SCHEMA,
      animation: job.request.animation,
      requests: job.request.readings,
      environment: job.request.environment,
      environmentPassed: job.environment.passed,
      builds: { inspected: job.runs.find(r => r.build === 'inspected')?.modelHash ?? '', scratch: job.runs.find(r => r.build === 'scratch')?.id ?? null },
      compiler: job.compiler,
      ticks: { inspected: ticks('inspected') ?? 0, scratch: ticks('scratch') },
    };
  }

  async function meshFolds(): Promise<string[]> {
    const animation = host.data().animation;
    meshPanel?.status(`Running the folds reading of ${animation}…`, false);
    const job = await runReadings({ readings: [{ kind: 'folds' }] });
    if (!job || !('runs' in job)) {
      const textMsg = job && 'error' in job && job.error ? job.error : 'READINGS_UNAVAILABLE: no reading ran';
      meshPanel?.status(textMsg, true); return [textMsg];
    }
    const lines = job.runs.map(run => { const r = run.results[0]; return r ? worstLine(run.build, r) : `${run.build} · folds: not run`; });
    if (job.runs.length < 2) lines.push('scratch · folds: no scratch build yet (Apply builds one)');
    meshPanel?.status(lines.join(' | '), job.runs.some(run => run.results.some(r => r.status !== 'read')));
    return lines;
  }

  async function runRequirements(body: { fps: number; build: 'inspected' | 'scratch'; requirements: Record<string, unknown>[] }): Promise<RequirementsJobView | RequirementsRefusal | null> {
    const side = pickedSide;
    const unwrap = (error: unknown) => { const raw = errorText(error).replace(/^\d+: /, ''); try { return (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { return raw; } };
    try {
      let job = await host.api<RequirementsJobView | RequirementsRefusal>(`${sideApiPrefix(side)}/requirements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      while ('id' in job && job.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 800));
        job = await host.api<RequirementsJobView>(`${sideApiPrefix(side)}/requirements/${job.id}`);
      }
      return job;
    } catch (error) { return { status: 'refused', error: unwrap(error) }; }
    finally { void loadRequirements(side); }
  }

  async function runEnvironmentCheck(): Promise<EnvironmentCheckView | { status: 'refused'; error: string } | null> {
    if (environmentCheckBusy) return null;
    const side = pickedSide, state = sides[side];
    const out = el('environment-check-lines');
    const show = (rows: { kind: string; text: string }[]) => {
      out.replaceChildren(...rows.map(row => { const line = document.createElement('div'); line.className = `env-${row.kind}`; line.textContent = row.text; return line; }));
    };
    const name = checkAnimation(side), world = worldFor(name, side);
    if ('error' in world) { show([{ kind: 'error', text: world.error }]); return { status: 'refused', error: world.error }; }
    const build = state.appliedOnStage ? 'scratch' : 'inspected', before = state.stageCheck;
    environmentCheckBusy = true; button('environment-check').disabled = true;
    show([{ kind: 'label', text: `Checking Build ${side.toUpperCase()} (${build}) under ${name}'s schedule…` }]);
    try {
      let job = await host.api<EnvironmentCheckView | { status: 'refused'; error: string }>(`${sideApiPrefix(side)}/environment-check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ build, schedule: world.schedule }) }).catch(error => ({ status: 'refused' as const, error: errorText(error).replace(/^\d+: /, '') }));
      if (!('id' in job)) {
        const textMsg = (() => { try { return (JSON.parse(job.error) as { error?: string }).error ?? job.error; } catch { return job.error; } })();
        show([{ kind: 'error', text: textMsg }]); return { status: 'refused', error: textMsg };
      }
      while (job.status === 'running') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        job = await host.api<EnvironmentCheckView>(`${sideApiPrefix(side)}/environment-check/${job.id}`);
      }
      const checked = job;
      const label = build === 'inspected' ? 'default world (the inspected build\'s own check)' : 'the scratch build\'s Apply check';
      const baseline = state.rebuildStatus?.baseline, noDefault = build === 'inspected' && !inspectedCheckView(side) && baseline && baseline.status !== 'running' && baseline.status !== 'reproduced';
      const draw = () => show(environmentCheckRows(checked, barName => noDefault ? `${barName}: no default-world check — ${baseline!.line}` : build === 'inspected' ? beforeLine(barName, null, inspectedCheckView(side)) : barLine(barName, before?.lines ?? null, before?.check ?? null), label));
      draw(); if (build === 'inspected' && inspectedCheckView(side)?.status !== 'checked') void followInspectedCheck(draw, side);
      return job;
    } catch (error) { show([{ kind: 'error', text: `ENVIRONMENT_CHECK_FAILED: ${errorText(error)}` }]); return null; }
    finally { environmentCheckBusy = false; button('environment-check').disabled = !currentPlayer(); }
  }

  function seekReading(clip: string, frame: number, exact: number | null, label: string): void {
    if (exact === null) { host.message(`${label}: F${frame} has no time; no seek was performed.`, true); return; }
    const at = readingSeekTime(exact, clipDuration(clip));
    void host.seekTo(Math.min(at, host.duration())).then(() => host.message(`Reading · ${label} → F${frame} · ${exact.toFixed(4)} s`));
  }

  function sampleLocals(bone: string, dt: number, n: number) {
    const p = currentPlayer();
    if (!p?.current || !(dt > 0) || !Number.isInteger(n) || n < 0) return null;
    const inner = p.adjust;
    const rows = new Map<number, { t: number; rotation: number; x: number; y: number; scaleX: number; scaleY: number; shearX: number; shearY: number }>();
    let recording = false;
    const read: BoneAdjust = (bones, ctx) => {
      inner?.(bones, ctx);
      if (!recording) return;
      const l = bones.bone(bone);
      rows.set(ctx.trackTime ?? 0, { t: ctx.trackTime ?? 0, rotation: l.rotation, x: l.x, y: l.y, scaleX: l.scaleX, scaleY: l.scaleY, shearX: l.shearX, shearY: l.shearY });
    };
    host.pause(); p.adjust = read;
    try { p.seek(0); recording = true; p.repose(); p.resume(); for (let k = 1; k <= n; k++) p.frame(dt); }
    finally { recording = false; p.pause(); p.adjust = inner; p.seek(host.time()); p.draw(); host.parts()?.present(pickedSide); }
    return [...rows.values()].sort((a, b) => a.t - b.t);
  }

  function bindEnvironmentControls(): void {
    const environmentInputs = ['wind-base', 'wind-breeze', 'wind-gust', 'wind-repeat', 'wind-gust-peak', 'wind-gust-duration', 'gravity', 'jolt', 'drag-trail', 'physics-reset', 'environment-use', 'environment-export', 'environment-check'];
    for (const id of environmentInputs) {
      const node = document.getElementById(id) as HTMLInputElement | HTMLButtonElement | null;
      if (node) node.disabled = false;
    }
    const engage = (change: () => void) => {
      try {
        change(); input('environment-applied').checked = true; environmentNote = '';
        applyEnvironment();
        const p = currentPlayer();
        if (p?.current && !host.playing()) {
          p.repose(); p.draw(); host.parts()?.present(pickedSide); host.redrawOverlays(true);
        }
        host.saveDraft();
      } catch (error) {
        host.message(`Environment unchanged: ${errorText(error)}`, true);
        syncEnvironmentInputs();
      }
    };
    input('wind-base').oninput = () => engage(() => wind.setBase(Number(input('wind-base').value)));
    input('wind-breeze').onchange = () => engage(() => wind.setBreeze(input('wind-breeze').checked));
    input('wind-repeat').onchange = () => engage(() => wind.setRepeat(input('wind-repeat').checked));
    input('wind-gust-peak').onchange = () => engage(() => wind.setGustPeak(Number(input('wind-gust-peak').value)));
    input('wind-gust-duration').onchange = () => engage(() => wind.setGustDuration(Number(input('wind-gust-duration').value)));
    input('gravity').oninput = () => engage(() => { environmentFor(wind.read(), gravityValue()); });
    button('wind-gust').onclick = () => engage(() => wind.triggerGust());
    button('jolt').onclick = () => {
      if (!currentPlayer()) return;
      joltQueue.push(...joltPacket(wind.read().time));
      if (!host.playing()) host.message('Jolt queued · it reaches the physics on the next steps; press Play.');
    };
    button('physics-reset').onclick = resetPhysics;
    button('applied-undo').onclick = () => { void undoApply(); };
    input('environment-use').onchange = () => {
      if (!input('environment-use').checked) {
        host.message("Use for readings is off: readings send the standing wind and gravity, Apply's check reads the default world.");
        renderSchedule();
        return;
      }
      const world = worldFor(host.data().animation, pickedSide);
      if ('error' in world) {
        input('environment-use').checked = false;
        host.message(world.error, true);
        renderSchedule();
        return;
      }
      restartWindClock();
      void host.seekTo(0);
      applyEnvironment();
      host.message(`Use for readings: ${world.summary} · the wind clock restarts with the clip.`);
    };
    button('environment-export').onclick = () => {
      const w = worldFor(host.data().animation, pickedSide);
      if ('error' in w) { host.message(w.error, true); return; }
      host.download('rigc-environment.json', w.text, 'application/json');
      host.message(`Exported ${w.summary}. The download is the bytes readings, Apply and feedback carry; the package is unchanged.`);
    };
    button('environment-check').onclick = () => { void runEnvironmentCheck(); };
    input('drag-trail').onchange = () => {
      for (const s of ['a', 'b'] as const) el(`${s}-viewport`).dataset.trail = String(s === pickedSide && input('drag-trail').checked);
    };
  }

  function onInspectorTabChanged(): void {
    const which = currentInspector();
    if (which === 'rig') {
      if (workspaceMode !== 'setup') setMode('setup', { fromTab: true });
      else syncModeButtons();
    } else if (which === 'playback') {
      if (workspaceMode !== 'animate') setMode('animate', { fromTab: true });
      else syncModeButtons();
    } else if (which === 'view') {
      if (workspaceMode !== 'compare') setMode('compare', { fromTab: true });
      else syncModeButtons();
    } else {
      syncModeButtons();
    }
  }

  // Wire top mode switch and picked-build switch.
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.mode-switch [data-mode]')) {
    btn.onclick = () => {
      const raw = btn.dataset.mode;
      const next: CommentMode = raw === 'rig' ? 'setup' : raw === 'playback' ? 'animate' : 'compare';
      setMode(next);
    };
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#mode-build-picker [data-build-side]')) {
    btn.onclick = () => {
      const side = btn.dataset.buildSide;
      if (side === 'a' || side === 'b') setPickedSide(side);
    };
  }
  syncModeButtons();
  syncPickedBanner();
  moveStageHandlesToPickedSide();

  button('chest-export').onclick = () => { void exportChest(); };
  for (const event of ['input', 'change']) el('chest-regions').addEventListener(event, renderChest);
  bindEnvironmentControls();

  const paneProxy = sideElementProxy(() => pickedSide, 'pane');
  const viewportProxy = sideElementProxy(() => pickedSide, 'viewport');
  const overlayProxy = sideElementProxy<HTMLCanvasElement>(() => pickedSide, 'overlay');
  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  inspectorBlocks = bindInspectorBlocks({
    sections: [el('inspector-rig'), el('inspector-playback')],
    changed: () => host.saveDraft(),
  });
  disposers.push(() => inspectorBlocks?.dispose());

  animationPanel = new AnimationInspectionPanel({
    host: el('animation-inspection'),
    stage: viewportProxy,
    project: (x, y) => rigProject()(x, y),
    enabled: () => !!currentState().partModel && currentInspector() === 'playback',
    readOnlyReason: 'keyed animation editing is read-only in comparison sessions until per-side animation rebuild is wired.',
    seek: exact => {
      if (!Number.isFinite(exact) || exact < 0 || exact > host.duration()) {
        host.message('KEY_TIME_OUT_OF_DOMAIN: no substitute time was used.', true);
        return;
      }
      void host.seekTo(exact);
    },
    select: value => {
      const slot = value?.kind === 'slot' ? value.name : null;
      const cur = host.parts()?.value();
      if ((cur?.side === pickedSide ? cur.slot : null) !== slot) {
        host.parts()?.select(slot ? { side: pickedSide, slot, mode: cur?.mode ?? 'context' } : null);
      }
      host.parts()?.highlightBone(value?.kind === 'bone' ? value.name : null);
      host.redrawOverlays(false);
    },
  });
  disposers.push(() => animationPanel?.dispose());

  chestEditor = bindChestEditor({
    pane: paneProxy,
    canvas: overlayProxy,
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    changed: renderChest,
    download: () => { void exportChest(); },
    apply: () => { void applyRebuild(); },
    reset: () => { void resetRebuild(); },
    message: host.message,
    inspector: currentInspector,
  });
  disposers.push(() => chestEditor?.dispose());

  meshEditor = bindMeshEditor({
    pane: paneProxy,
    canvas: overlayProxy,
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    inspector: currentInspector,
    source: meshSource,
    pause: host.pause,
    changed: () => host.redrawOverlays(false),
    download: doc => { void exportMesh(doc); },
    apply: (doc, line) => applyMeshDelta(doc, line),
    applied: () => currentState().appliedOnStage?.schema === 'rig-review-applied/3',
    resetBuild: () => resetRebuild(stageWorld()),
    message: host.message,
    confirm: msg => window.confirm(msg),
    token,
  });
  disposers.push(() => meshEditor?.dispose());

  weightsView = bindWeightsView({
    pane: paneProxy,
    canvas: overlayProxy,
    project: () => currentPlayer() ? rigProject() : null,
    inspector: currentInspector,
    slot: () => { const p = host.parts()?.value(); return p?.side === pickedSide ? p.slot : null; },
    model: () => currentSideData()?.manifest.model ? currentState().partModel ?? undefined : null,
    setup: slot => { const a = currentAssets(); return a ? setupPoseMesh(a, currentState().partModel, slot, document.createElement('div')) : null; },
    changed: () => host.redrawOverlays(false),
    token,
  });
  disposers.push(() => weightsView?.dispose());

  bonesPanel = bindBonesPanel({
    pane: paneProxy,
    canvas: overlayProxy,
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    inspector: currentInspector,
    pause: host.pause,
    changed: () => host.redrawOverlays(false),
    saved: () => host.saveDraft(),
    check: checkBones,
    apply: async ops => { await applyBones(ops); },
    reset: resetBonesBuild,
    token,
  });
  disposers.push(() => bonesPanel?.dispose());

  cutsPanel = bindCutsPanel({
    pane: paneProxy,
    canvas: overlayProxy,
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    inspector: currentInspector,
    pause: host.pause,
    changed: () => host.redrawOverlays(false),
    saved: () => host.saveDraft(),
    apply: applyCuts,
    reset: resetCutsBuild,
    token,
    route: path => host.route(path),
  });
  disposers.push(() => cutsPanel?.dispose());

  clothPanel = bindClothPanel({
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    inspector: currentInspector,
    pause: host.pause,
    changed: () => host.redrawOverlays(false),
    saved: () => host.saveDraft(),
    apply: applyCloth,
    reset: resetClothBuild,
    token,
  });
  disposers.push(() => clothPanel?.dispose());

  physicsPanel = bindPhysicsPanel({
    preview: edits => {
      const player = currentPlayer();
      const before = JSON.stringify(physicsPreview.read()), next = physicsPreview.sync(player ?? null, edits);
      if (player?.current && !host.playing() && before !== JSON.stringify(next)) {
        player.repose(); player.draw(); host.parts()?.present(pickedSide); host.redrawOverlays(true);
      }
      return physicsPreview.read();
    },
    previewRead: () => physicsPreview.read(),
    apply: async ops => { await applyPhysics(ops); },
    reset: resetPhysicsBuild,
    pane: paneProxy,
    saved: () => host.saveDraft(),
    bonePoints: bones => {
      const player = currentPlayer(); if (!player) return null;
      const project = rigProject(), pane = el(`${pickedSide}-pane`).getBoundingClientRect(), view = el(`${pickedSide}-root`).parentElement!.getBoundingClientRect();
      const out = new Map<string, { x: number; y: number }>();
      for (const name of bones) {
        try { const b = player.bone(name), p = project(b.x, b.y); out.set(name, { x: p.x + view.left - pane.left, y: p.y + view.top - pane.top }); } catch { /* absent */ }
      }
      return out;
    },
  });
  disposers.push(() => physicsPanel?.dispose());

  meshPanel = bindMeshPanel({
    pane: paneProxy,
    project: () => currentPlayer() ? rigProject() : null,
    mapping: () => currentState().chestMapping,
    bones: () => currentSideData()?.feedbackCatalog.bones ?? [],
    apply: async (part, entry) => { await applyMesh(part, entry); },
    reset: resetMeshBuild,
    folds: async () => { await meshFolds(); },
    changed: () => { host.redrawOverlays(false); densityStrip?.changed(); },
    saved: () => host.saveDraft(),
    token,
  });
  disposers.push(() => meshPanel?.dispose());

  densityStrip = bindDensityStrip({
    part: () => meshPanel?.part() ?? null,
    entry: () => meshPanel?.entry() ?? null,
    build: async values => { await buildDensityStrip(values); },
    load: async i => { await loadStripRow(i); },
    back: async () => { await stripBack(); },
    close: async () => { await closeDensityStrip(); },
  });

  idlePanel = bindIdlePanel({
    apply: async (ops, keys) => { await applyIdle(ops, keys); },
    reset: resetIdleBuild,
    pane: paneProxy,
    saved: () => host.saveDraft(),
    preview: fn => { idleAdjust = fn; setAdjust(); },
    bonePoints: bones => {
      const player = currentPlayer(); if (!player) return null;
      const project = rigProject(), out = new Map<string, { x: number; y: number }>();
      for (const name of bones) { try { const b = player.bone(name); out.set(name, project(b.x, b.y)); } catch { /* absent */ } }
      return out;
    },
  });
  disposers.push(() => idlePanel?.dispose());

  rigFieldsPanel = bindRigFieldsPanel({
    apply: async ops => { await applyRigFields(ops); },
    reset: resetRigFieldsBuild,
    reading: async (bone, relative) => { await runReadings({ readings: [{ kind: 'angle-range', bone, relative }] }); },
    part: () => { const p = host.parts()?.value(); return p?.side === pickedSide ? p.slot : null; },
    inspector: currentInspector,
    pause: host.pause,
    saved: () => host.saveDraft(),
    toPane: (x, y) => {
      const mapping = currentState().chestMapping;
      if (!currentPlayer() || !mapping.available) return null;
      const w = mapping.toWorld(x, y); return rigProject()(w.x, w.y);
    },
    toRig: (x, y) => {
      const mapping = currentState().chestMapping;
      return currentPlayer() && mapping.available ? canvasToCrop(rigProject(), mapping.toWorld, { x, y }) : null;
    },
    slotBox: slot => {
      const frame = currentPlayer()?.posedFrame(); if (!frame) return null;
      try {
        const b = partBounds(frame, slot); if (!b) return null;
        const project = rigProject(), a = project(b.x, b.y), c = project(b.x + b.width, b.y + b.height);
        return { left: Math.min(a.x, c.x), right: Math.max(a.x, c.x), top: Math.min(a.y, c.y), bottom: Math.max(a.y, c.y) };
      } catch { return null; }
    },
    dial: fn => { dialAdjust = fn as BoneAdjust | null; setAdjust(); },
    hasTurn: () => {
      const p = currentPlayer(); if (!p) return false;
      try { p.bone(TURN_BONE); return true; } catch { return false; }
    },
  });
  disposers.push(() => rigFieldsPanel?.dispose());

  readingsPanel = bindReadingsPanel({ run: () => { void runReadings(); }, seek: seekReading });
  retargetPanel = bindRetargetPanel({ apply: body => applyRetarget(body), reset: () => { void resetRebuild(stageWorld()); }, seek: seekReading });
  requirementsPanel = bindRequirementsPanel({
    check: runRequirements,
    seek: seekReading,
    animation: () => host.data().animation,
    slot: () => { const p = host.parts()?.value(); return p?.side === pickedSide ? p.slot : null; },
    hash: sha256Hex,
  });

  // Expose automation surface on window.rigReviewEditor for the picked build.
  (window as unknown as { rigReviewEditor: unknown }).rigReviewEditor = {
    mode: () => workspaceMode,
    setMode: (m: CommentMode) => setMode(m),
    pickedSide: () => pickedSide,
    pickSide: (s: Side) => setPickedSide(s),
    applyPatch,
    reset: () => resetRebuild(),
    undo: () => undoApply(),
    history: () => currentState().appliedHistory ? JSON.parse(JSON.stringify(currentState().appliedHistory)) : null,
    status: async () => currentState().rebuildStatus ?? await loadRebuildStatus(pickedSide),
    physics: {
      rows: () => physicsPanel?.rows() ?? [],
      chains: () => physicsPanel?.chains() ?? [],
      edits: () => physicsPanel?.edits() ?? [],
      preview: () => physicsPreview.read(),
      clearPreview: () => physicsPanel?.clearPreview(),
      set: (name: string, field: Parameters<PhysicsPanel['set']>[1], value: number) => physicsPanel?.set(name, field, value),
      ramp: (id: string, field: Parameters<PhysicsPanel['set']>[1], root: number, tip: number) => physicsPanel?.ramp(id, field, root, tip),
      select: (name: string) => physicsPanel?.select(name),
      apply: () => applyPhysics(physicsPanel?.edits().map(e => ({ op: e.op, path: e.path, value: e.value, name: e.name })) ?? []),
      reset: () => resetPhysicsBuild(),
    },
    posed: (slot: string) => {
      const frame = currentPlayer()?.posedFrame();
      const found = frame?.order.find(item => item.slot === slot);
      return found ? JSON.parse(JSON.stringify(found, (key, value) => key === 'bitmap' || key === 'image' || key === 'page' ? undefined : value)) : null;
    },
    bone: (name: string, side: Side = pickedSide) => host.players[side] ? JSON.parse(JSON.stringify(host.players[side]!.bone(name))) : null,
    meshEdit: () => {
      const sSession = meshEditor?.session(), overlay = meshEditor?.overlay();
      if (!sSession || !overlay) return null;
      const s = sSession.source, project = rigProject(), view = el(`${pickedSide}-root`).parentElement!.getBoundingClientRect();
      return {
        slot: s.slot, skin: s.skin, attachment: s.attachment, hash: s.hash, hull: s.hull,
        triangles: s.triangles.length / 3, vertices: s.vertices, ops: sSession.ops(),
        drawn: overlay.vertices.map(v => { const p = project(v.at.x, v.at.y); return { x: p.x + view.left, y: p.y + view.top, state: v.state }; }),
      };
    },
    screen: (x: number, y: number) => {
      const p = rigProject()(x, y), view = el(`${pickedSide}-root`).parentElement!.getBoundingClientRect();
      return { x: p.x + view.left, y: p.y + view.top };
    },
    readings: {
      run: (readings?: import('../src/readings.ts').ReadingRequest[]) => runReadings(readings ? { readings } : undefined),
      job: () => currentState().readingsJob ? JSON.parse(JSON.stringify(currentState().readingsJob)) : null,
      lines: () => readingsPanel?.shownLines() ?? [],
      context: () => readingsContext(),
    },
    idle: {
      state: () => idlePanel?.state() ?? null,
      ops: () => idlePanel?.ops() ?? [],
      source: () => idlePanel?.source() ?? null,
      keying: () => idlePanel?.keying() ?? null,
      refusals: () => idlePanel?.refusals() ?? [],
      select: (key: string) => idlePanel?.select(key),
      field: (key: string, field: Parameters<IdlePanel['field']>[1], value: number | null) => idlePanel?.field(key, field, value),
      linkAmp: (key: string, link: number, value: number) => idlePanel?.linkAmp(key, link, value),
      add: (spec: Parameters<IdlePanel['add']>[0]) => idlePanel?.add(spec),
      remove: (key: string) => idlePanel?.remove(key),
      blink: (field: Parameters<IdlePanel['blink']>[0], value: number) => idlePanel?.blink(field, value),
      preview: () => idlePanel?.previewing() ?? null,
      setPreview: (on: boolean) => idlePanel?.setPreview(on),
      apply: () => applyIdle(idlePanel?.ops() ?? [], idlePanel?.keying()?.keys ?? null),
      reset: () => resetIdleBuild(),
      sample: (bone: string, dt: number, n: number) => sampleLocals(bone, dt, n),
      adjustSet: () => !!currentPlayer()?.adjust,
    },
    mesh: {
      part: () => meshPanel?.part() ?? null,
      select: (part: string) => meshPanel?.select(part),
      entry: () => meshPanel?.entry() ?? null,
      configEntry: () => meshPanel?.configEntry() ?? null,
      set: (path: string[], value: import('../src/config-patch.ts').JsonValue | undefined) => meshPanel?.set(path, value),
      setEntry: (entry: MeshEntry) => meshPanel?.setEntry(entry),
      regions: () => meshPanel?.regions.list() ?? [],
      addRegion: (region: import('../src/mesh-entry.ts').MeshRegion) => meshPanel?.regions.add(region),
      moveRegion: (region: number, vertex: number, to: [number, number]) => meshPanel?.regions.move(region, vertex, to),
      drawRegions: (on: boolean) => meshPanel?.regions.draw(on),
      placing: () => meshPanel?.regions.placing() ?? null,
      precheck: () => meshPanel?.precheck() ?? [],
      apply: () => { const part = meshPanel?.part(), entry = meshPanel?.entry(); return part && entry ? applyMesh(part, entry) : Promise.resolve(null); },
      reset: () => resetMeshBuild(),
      folds: () => meshFolds(),
      overlayTriangles: (slot: string) => currentState().lastOverlay?.meshTriangles[slot] ?? null,
      status: () => el('mesh-status').textContent,
      counts: () => [...document.querySelectorAll('#mesh-counts code')].map(c => c.textContent),
      readout: () => [...document.querySelectorAll('#mesh-readout code')].map(c => c.textContent),
      pending: () => input('mesh-pending').value,
      lastPatch: () => lastMeshPatch ? JSON.parse(JSON.stringify(lastMeshPatch)) : null,
      strip: {
        build: (values: number[]) => buildDensityStrip(values),
        view: () => currentState().stripView ? JSON.parse(JSON.stringify(currentState().stripView)) : null,
        load: (i: number) => loadStripRow(i),
        back: () => stripBack(),
        close: () => closeDensityStrip(),
        pending: () => currentState().stripPending ? { index: currentState().stripPending!.index, candidate: currentState().stripPending!.candidate } : null,
        applied: () => currentState().appliedOnStage ? JSON.parse(JSON.stringify(currentState().appliedOnStage)) : null,
        stageHash: () => currentState().stageModelHash,
      },
    },
    cuts: {
      source: () => cutsPanel?.source() ?? null,
      ops: () => cutsPanel?.ops() ?? [],
      handles: () => cutsPanel?.handles() ?? [],
      active: () => cutsPanel?.active() ?? false,
      setActive: (on: boolean) => cutsPanel?.setActive(on),
      setVertex: (cut: number, k: number, value: [number, number]) => cutsPanel?.setVertex(cut, k, value),
      setBox: (i: number, value: [number, number, number, number]) => cutsPanel?.setBox(i, value),
      setRange: (limb: string, k: number, value: [number, number] | null) => cutsPanel?.setRange(limb, k, value),
      apply: () => cutsPanel?.apply() ?? Promise.resolve(null),
      reset: () => resetCutsBuild(),
      applied: () => cutsPanel?.appliedItems() ?? [],
    },
    cloth: {
      tag: () => clothPanel?.tag() ?? '',
      select: (tag: string) => clothPanel?.select(tag),
      values: (tag?: string) => clothPanel?.values(tag) ?? {},
      set: (key: string, val: string, tag?: string) => clothPanel?.set(key, val, tag),
      declare: (on: boolean, tag?: string) => clothPanel?.declare(on, tag),
      ops: () => clothPanel?.ops() ?? [],
      links: () => clothPanel?.links() ?? null,
      active: () => clothPanel?.active() ?? false,
      setActive: (on: boolean) => clothPanel?.setActive(on),
      apply: () => clothPanel?.apply() ?? Promise.resolve(null),
      reset: () => resetClothBuild(),
      applied: () => clothPanel?.appliedItems() ?? [],
      status: () => el('cloth-status').textContent,
      readout: () => [...document.querySelectorAll('#cloth-readout code')].map(c => c.textContent),
    },
    bones: {
      anchors: () => bonesPanel?.anchors() ?? [],
      edits: () => bonesPanel?.edits() ?? [],
      set: (path: string, value: [number, number]) => bonesPanel?.set(path, value),
      select: (name: string | null) => bonesPanel?.select(name),
      active: () => bonesPanel?.active() ?? false,
      setActive: (on: boolean) => bonesPanel?.setActive(on),
      handles: () => bonesPanel?.handles() ?? [],
      check: () => bonesPanel?.check() ?? Promise.resolve(null),
      apply: () => applyBones((bonesPanel?.edits() ?? []).map(e => ({ op: 'replace' as const, path: e.path, value: [...e.value], name: e.name }))),
      reset: () => resetBonesBuild(),
      status: () => el('bones-status').textContent,
      lines: () => [...document.querySelectorAll('#bones-lint code, #bones-lint summary')].map(c => c.textContent),
      compare: () => [...document.querySelectorAll('#bones-compare code')].map(c => c.textContent),
      pending: () => input('bones-pending').value,
    },
    fields: {
      source: () => rigFieldsPanel?.source() ?? null,
      edits: () => rigFieldsPanel?.edits() ?? [],
      ops: () => rigFieldsPanel?.ops() ?? [],
      region: (part: string, bone: string) => rigFieldsPanel?.region(part, bone),
      still: (part: string, entry: { row: number; bone: string } | null) => rigFieldsPanel?.still(part, entry),
      stop: (index: number, bounds: { inward?: number; outward?: number }) => rigFieldsPanel?.stop(index, bounds),
      inherit: (index: number, mode: string | null, link?: string) => rigFieldsPanel?.inherit(index, mode, link),
      turn: (target: { pivot: number } | { part: string; depth: number }) => rigFieldsPanel?.turn(target),
      select: (kind: 'part' | 'still' | 'stop' | 'bone', value: string | number | null) => rigFieldsPanel?.select(kind, value),
      setDial: (x: number) => rigFieldsPanel?.setDial(x),
      dial: () => rigFieldsPanel?.dialState() ?? null,
      handles: () => rigFieldsPanel?.handles() ?? [],
      apply: () => applyRigFields(rigFieldsPanel?.ops() ?? []),
      reset: () => resetRigFieldsBuild(),
      status: () => el('rig-fields-status').textContent,
      readout: () => [...document.querySelectorAll('#rig-fields-readout code')].map(c => c.textContent),
      pending: () => input('rig-fields-pending').value,
    },
    retarget: {
      map: () => retargetPanel?.map() ?? null,
      setMap: (map: PoseMap) => retargetPanel?.setMap(map),
      include: (chain: string, on: boolean) => retargetPanel?.include(chain, on),
      pick: (chain: string, index: number, bone: string) => retargetPanel?.pick(chain, index, bone),
      flags: () => retargetPanel?.flags() ?? null,
      setFlags: (flags: Partial<RetargetFlags>) => retargetPanel?.setFlags(flags),
      apply: () => { const b = document.getElementById('retarget-apply') as HTMLButtonElement | null; b?.click(); },
      status: () => el('retarget-status').textContent,
      lines: () => retargetPanel?.shownLines() ?? [],
      refusals: () => [...document.querySelectorAll('#retarget-refusals code')].map(c => c.textContent),
    },
    stage: (side: Side = pickedSide) => ({
      side,
      modelHash: sides[side].stageModelHash,
      inspectedHash: sides[side].inspectedModel?.sha256 ?? null,
      applied: sides[side].appliedOnStage ? JSON.parse(JSON.stringify(sides[side].appliedOnStage)) : null,
      animation: host.data()?.animation ?? null,
      time: host.time(),
      playing: host.playing(),
      busy: rebuildBusy,
    }),
  };

  return {
    mode: () => workspaceMode,
    setMode,
    onInspectorTabChanged,
    pickedSide: () => pickedSide,
    setPickedSide,
    isSwitchingSide: () => switchingSide,
    defaultStatusMessage,
    registerSideModel: (side, modelUrl, prefix, sha256, partModel) => {
      const st = sides[side];
      if (!st.inspectedModel) st.inspectedModel = { url: modelUrl, prefix, sha256 };
      st.stageSource = { url: modelUrl, prefix, hash: sha256 };
      st.stageModelHash = sha256;
      st.partModel = partModel;
      void loadModelDocument(modelUrl, sha256).then(loaded => {
        if (loaded.ok) {
          st.inspectedDocument = loaded.document;
          st.inspectedDocumentReason = null;
          if (side === pickedSide && st.stageModelHash === sha256) {
            idlePanel?.model(boneSetup(loaded.document));
          }
        } else {
          st.inspectedDocumentReason = `PHYSICS_TUNING_UNAVAILABLE: ${loaded.reason}`;
        }
        if (side === pickedSide) refreshPhysics();
      }, error => {
        st.inspectedDocumentReason = `PHYSICS_TUNING_UNAVAILABLE: ${errorText(error)}`;
        if (side === pickedSide) refreshPhysics();
      });
      updateChestMapping(side);
      if (side === pickedSide) {
        populateChestBones();
        refreshAnimationInspection();
        weightsView?.refresh();
      }
    },
    loadInitialSideStatuses: async () => {
      syncPickedBanner();
      moveStageHandlesToPickedSide();
      await Promise.all([
        loadRebuildStatus('a'),
        loadRebuildStatus('b'),
        loadRequirements('a'),
        loadRequirements('b'),
        refreshApplied('a'),
        refreshApplied('b'),
        refreshDensityStrip('a'),
        refreshDensityStrip('b'),
      ]);
      applySideStateToPanels();
      renderChest();
      physicsPanel?.restore();
      bonesPanel?.restore();
      cutsPanel?.restore();
      clothPanel?.restore();
      idlePanel?.restore();
      rigFieldsPanel?.restore();
      meshPanel?.restore();
    },
    onPosePresented: () => {
      if (!animationPanel) return;
      animationPanel.update(host.time(), host.duration());
      const player = currentPlayer();
      if (player && currentState().partModel) {
        animationPanel.capture(player, host.parts()?.frame(pickedSide));
      }
    },
    onPartSelected: (side, slot) => {
      if (side && side !== pickedSide && workspaceMode !== 'compare') {
        setPickedSide(side);
      }
      const activeSlot = (side ?? pickedSide) === pickedSide ? slot : null;
      const player = currentPlayer();
      if (player && currentState().partModel) animationPanel?.capture(player, host.parts()?.frame(pickedSide));
      weightsView?.refresh();
      meshEditor?.selectionChanged();
      animationPanel?.fromParts(activeSlot);
      meshPanel?.select(activeSlot);
      requirementsPanel?.selectionChanged();
    },
    overlayInputFor: side => {
      animationPanel?.redraw(host.layers.bones);
      if (side !== pickedSide) {
        return { regions: [], circles: [], markers: [], meshEdit: null, weights: null, anchors: null };
      }
      idlePanel?.place(host.duration());
      rigFieldsPanel?.place();
      return {
        regions: [
          ...chestRegions(),
          ...(meshPanel?.overlayRegions() ?? []),
          ...(cutsPanel?.overlayRegions() ?? []),
          ...(clothPanel?.overlayRegions() ?? []),
        ],
        circles: [
          ...chestCircles(),
          ...(meshPanel?.overlayCircles() ?? []),
        ],
        markers: [
          ...chestMarkers(),
          ...(cutsPanel?.overlayMarkers() ?? []),
        ],
        meshEdit: meshEditor?.overlay() ?? null,
        weights: weightsView?.overlay() ?? null,
        anchors: bonesPanel?.overlay() ?? null,
      };
    },
    recordOverlaySnapshot: (side, snapshot) => {
      sides[side].lastOverlay = snapshot;
    },
    uiState: () => ({
      workspaceMode,
      pickedSide,
      ...(inspectorBlocks ? activeBlocksUI(inspectorBlocks.state()) : {}),
    }),
    restoreUiState: ui => {
      if (ui.pickedSide === 'a' || ui.pickedSide === 'b') setPickedSide(ui.pickedSide);
      if (ui.workspaceMode === 'setup' || ui.workspaceMode === 'animate' || ui.workspaceMode === 'compare') {
        setMode(ui.workspaceMode);
      }
      restoreEnvironment();
      inspectorBlocks?.restore(restoreActiveBlocksUI(ui));
    },
    commentRefusal: () => {
      if (sides.a.appliedOnStage || sides.b.appliedOnStage) {
        return 'COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build';
      }
      if (rebuildBusy) {
        return 'COMMENT_SOURCE_BUSY: wait for the rebuild or candidate model replacement before commenting';
      }
      const preview = idleAdjust ? 'Idle tracks' : dialAdjust ? 'Rig fields turn dial' : physicsPreview.read().length ? 'Physics live overrides' :
        (sides.a.stripPending || sides.b.stripPending) ? 'Density strip candidate' :
        meshEditor?.overlay() ? 'Edit Mesh' : bonesPanel?.overlay() ? 'Bones anchors' :
        cutsPanel && (cutsPanel.overlayRegions().length || cutsPanel.overlayMarkers().length) ? 'Cuts/patches/joints' :
        clothPanel?.overlayRegions().length ? 'Cloth links' :
        meshPanel && (meshPanel.overlayRegions().length || meshPanel.overlayCircles().length) ? 'Mesh regions' :
        chestEditor?.active() ? 'Chest regions/landmarks' :
        rigFieldsPanel?.handles().length ? 'Rig fields stage handles' : null;
      return preview ? `COMMENT_UNAPPLIED_PREVIEW: ${preview} is active; leave or disable that preview before commenting (nothing is cleared or applied automatically)` : null;
    },
    shortcutBlocked: () => !!meshEditor?.active(),
    busy: () => rebuildBusy || densityBusy,
    appliedFor: side => sides[side].appliedOnStage,
    modelHashFor: side => sides[side].stageModelHash,
    seekMode,
    stepSide,
    dispose: () => {
      if (handoffTimer) clearTimeout(handoffTimer);
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}
