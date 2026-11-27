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
import { AnimationInspectionPanel, type AnimationSideState } from './animation-inspection.ts';
import type { AnimationSourceOp } from '../src/animation-ops.ts';
import { partBounds, type PartExplorer } from './part-selection.ts';
import { bindInspectorBlocks, activeBlocksUI, restoreActiveBlocksUI, type InspectorBlocks } from './inspector-blocks.ts';
import { sourceTextContent, tr } from './i18n.ts';
import { bindChestEditor, canvasToCrop, chestField, chestCircles as readChestCircles, exportChest as exportChestFiles, chestMarkers as readChestMarkers, chestPoseOffset, LANDMARKS, landmarkInputId, posedChestMapping, type ChestEditor } from './chest-editor.ts';
import { writeRebuildDraft, stageApplyMeshDelta, stageApplyPatch, stageResetRebuild, stageUndoApply, stageApplyAnimation, stageLoadStripRow, stageResetAnimation, stageApplyRebuild, stageApplyRetarget, stageStripBack, type StageJobScreen } from './rebuild-client.ts';
import { chestOverlayPolygons, chestRegionRows, chestRowId, evaluateChestForm } from './chest-regions-tool.ts';
import { cropWorldMapping, type CropWorldMapping } from '../src/chest-regions.ts';
import { bindMeshEditor, exportMesh as exportMeshFiles, meshEditSource, sha256Hex, type MeshEditor } from './mesh-editor.ts';
import type { MeshEditDocument } from '../src/mesh-edit.ts';
import { bindWeightsView, setupPoseMesh, type WeightsView } from './weights-view.ts';
import { readSetupPose } from './setup-pose.ts';
import { bindBonesPanel, requestBonesCheck, type BonesPanel, type BonesCheckView } from './bones-panel.ts';
import { bindCutsPanel, type CutsPanel } from './cuts-panel.ts';
import { bindClothPanel, type ClothPanel } from './cloth-panel.ts';
import { bindMeshPanel, type MeshPanel } from './mesh-panel.ts';
import { bindDensityStrip, bindDensityStripJobs, type DensityStripPanel, type DensityStripViewLike } from './density-strip-panel.ts';
import { assertMeshPatch, countsText, meshApplyOutcome, meshPatchOps, triangleAgreement, type MeshEntry } from '../src/mesh-entry.ts';
import { bindPhysicsPanel, type PhysicsPanel } from './physics-panel.ts';
import { tuningRows, readoutRows, type InspectedCheckView } from '../src/physics-tuning.ts';
import { bindIdlePanel, type BoneSetup, type IdlePanel } from './idle-panel.ts';
import { type LocalChannel } from '../src/idle-tracks.ts';
import { bindRigFieldsPanel, type RigFieldsPanel } from './rig-fields-panel.ts';
import { TURN_BONE } from '../src/rig-fields.ts';
import { bindReadingsPanel, readingsContext as buildReadingsContext, type ReadingsJobView, type ReadingsPanel, type ReadingsRefusal } from './readings-panel.ts';
import { formatSeconds } from './format-seconds.ts';
import { readingSeekTime, type ReadingsContext } from '../src/readings.ts';
import { bindRequirementsPanel, runRequirementsRequest, type RequirementsCatalogView, type RequirementsJobView, type RequirementsPanel, type RequirementsRefusal } from './requirements-panel.ts';
import type { RequirementsRequest } from '../src/requirements.ts';
import { bindRetargetPanel, type PoseMap, type RetargetPanel } from './retarget-panel.ts';
import type { RetargetFlags } from '../src/retarget.ts';
import {
  createHandoffRefresh, directJobUiSink, bindRequirementsCatalog, bindMeshFolds,
  bindPanelRebuilds, createJobUiState, type JobUiSink, type ScopedJobUiSink, appliedStatus as setAppliedStatus, inspectedCheckView as readInspectedCheck, renderApplied as renderAppliedPanel,
  renderAppliedBlocks as reconcileAppliedBlocks, chestSeed, designatedRegions, noContourReason, seedLandmarks, makePatch,
  pickBustPart, pickPart, runReadingsRequest, seedFields, stageChanged as updateDensityPending, type AppliedHistoryView, type AnyJobView, type AppliedAnimation, type AppliedDelta, type AppliedPatch,
  type AppliedRecord, type AppliedRetarget, type ConfigPatch,
  type PatchJobView, type RebuildRefusal, type RebuildStatusView, type StageChange,
} from './rebuild-client.ts';
import type { CheckSummary } from '../src/applied-context.ts';
import { dropNoticeForPanel, type RebuildPanelKind } from '../src/applied-blocks.ts';
import { compareSeekStep } from '../src/compare-playhead.ts';
import { composeAdjust, PhysicsPreview } from './preview.ts';
import {
  createWindModel, environmentFor, windReadout, RUNTIME_START_READOUT, joltPacket,
  loadModelDocument, environmentContext, environmentJson, type JoltStep, type WindSnapshot,
} from '../src/environment.ts';
import { bindEnvironmentInputs, checkAnimation as selectCheckAnimation, bindEnvironmentCheck, restartsWindClock, scheduleContext, worldExport, type ClipMove, type StageWorld, type WorldExport } from './environment-world.ts';
import type { OverlayCircle, OverlayMarker, OverlayRegion, OverlaySnapshot } from './rig-overlays.ts';
import type { PatchOp } from '../src/config-patch.ts';

export type Side = 'a' | 'b';

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
  setupChestWorld: { x: number; y: number } | null;
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
  animationState: AnimationSideState | null;
  animAdjust: BoneAdjust | null;
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
    setupChestWorld: null,
    stripView: null,
    stripPending: null,
    readingsJob: null,
    requirementsCatalog: null,
    lastOverlay: null,
    animationState: null,
    animAdjust: null,
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
  let currentJobMessage: { source: string; error: boolean } | null = null;
  const jobUiState = createJobUiState<Side>(() => pickedSide, (key, write) => {
    write();
    if (key === 'message') {
      const message = el('message');
      currentJobMessage = { source: sourceTextContent(message), error: message.classList.contains('error') };
    }
  });
  const sinks = { a: jobUiState.sink('a'), b: jobUiState.sink('b') };
  const sinkFor = (side: Side) => sinks[side];

  function clearCompareJobMessage(): void {
    const message = el('message');
    if (currentJobMessage && currentJobMessage.source === sourceTextContent(message) &&
        currentJobMessage.error === message.classList.contains('error')) host.message(defaultStatusMessage());
    currentJobMessage = null;
  }
  let switchingSide = false;
  const sides: Record<Side, SideBuildState> = { a: emptySideState(), b: emptySideState() };
  let rebuildBusy = false, densityBusy = false, readingsBusy = false, environmentCheckBusy = false;
  const handoffRefresh = createHandoffRefresh(() => el('handoff-line'));
  let densityOwner: Side | null = null;
  let rebuildUiOwner: Side | null = null;
  let lastMeshPatch: ConfigPatch | null = null;
  const disposers: (() => void)[] = [];

  const wind = createWindModel();
  let joltQueue: JoltStep[] = [];
  const { environmentApplied, gravityValue, useWorld, stageWorld, syncEnvironmentInputs, stepEnvironment: stepWorldEnvironment } =
    bindEnvironmentInputs(input, wind, () => joltQueue, renderEnvironment);
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
    const activeTools = side === pickedSide ? composeAdjust(idleAdjust, dialAdjust) : null;
    player.adjust = composeAdjust(composeAdjust(baseTurn, activeTools), sides[side].animAdjust);
    if (player.current && !host.playing()) {
      player.seek(host.time());
      player.draw();
      host.parts()?.present(side);
      if (side === pickedSide && sides[side].partModel) {
        animationPanel?.capture(player, host.parts()?.frame(side));
      }
      host.redrawOverlays(true);
    }
  }

  function syncModeButtons(): void {
    button('play').hidden = workspaceMode !== 'animate';
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
    jobUiState.leave(prevSide);
    if (sides[prevSide].chestInputs !== null) {
      sides[prevSide].chestInputs = snapshotChestInputs();
    }
    if (animationPanel) {
      sides[prevSide].animationState = animationPanel.exportSideState();
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
      const nextAnimState = sides[nextSide].animationState;
      if (nextAnimState && sides[nextSide].partModel && nextAnimState.document !== sides[nextSide].partModel) {
        nextAnimState.document = null;
        nextAnimState.baseInspection = null;
      }
      animationPanel?.importSideState(nextAnimState);
      clearChestInputs();
      populateChestBones();
      applySideStateToPanels();
      updateChestMapping();
      if (animationPanel) {
        sides[nextSide].animationState = animationPanel.exportSideState();
      }
    } finally {
      switchingSide = false;
    }
    setAdjust(nextSide);
    host.redrawOverlays(true);
    host.saveDraft();
    if (rebuildUiOwner !== null) renderRebuildState();
    jobUiState.enter(nextSide);
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
    const status = currentState().rebuildStatus, seeded = status ? chestSeed(status) : null;
    for (const row of chestRegionRows) {
      const id = chestRowId(row, 'bone'), nameId = chestRowId(row, 'name');
      const node = document.getElementById(id) as HTMLSelectElement | null;
      if (!node) continue;
      const current = node.value, seededRow = seeded?.rows.find(r => r.row === row);
      const rowName = (document.getElementById(nameId) as HTMLInputElement | null)?.value.trim() ?? '';
      const keep = current || (node.disabled && rowName && rowName === (seededRow?.fields[nameId] ?? '').trim() ? (seededRow?.fields[id] ?? '').trim() : '');
      node.replaceChildren(option('', bones ? 'Select bone' : 'No model bones'));
      for (const name of bones ?? []) node.append(option(name, name));
      if (bones && keep && bones.includes(keep)) node.value = keep;
      node.disabled = !bones;
    }
  }

  function chestEvaluation() {
    return evaluateChestForm(chestField, currentState().chestMapping, currentSideData()?.feedbackCatalog.bones);
  }

  function activeChestMapping(side: Side = pickedSide): CropWorldMapping {
    const state = sides[side];
    return posedChestMapping(state.chestMapping, chestPoseOffset(host.players[side], state.setupChestWorld));
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
    renderDropNotices();
    host.redrawOverlays(false);
  }

  function chestRegions(): OverlayRegion[] {
    // #345: the chest overlay is drawn only while the Chest regions toggle is on.
    if (!chestEditor?.active()) return [];
    const style = getComputedStyle(document.documentElement), token = (name: string) => style.getPropertyValue(name).trim();
    return chestOverlayPolygons(chestEvaluation(), activeChestMapping()).map((region, i) => ({
      ...region,
      stroke: token(i ? '--rv-region-b' : '--rv-region-a'),
      fill: token(i ? '--rv-region-b-fill' : '--rv-region-a-fill'),
    }));
  }

  function chestCircles(): OverlayCircle[] { return readChestCircles(activeChestMapping(), chestEditor, chestField); }

  function chestMarkers() { return readChestMarkers(activeChestMapping(), chestEditor, input); }

  function editExportSource() {
    const sideData = currentSideData(), mapping = currentState().chestMapping;
    return { sourceHash: sideData.sourceHash, reviewedSource: sideData.reviewedSource, mapping };
  }

  async function exportChest(): Promise<void> {
    return exportChestFiles(chestEvaluation(), {
      source: editExportSource,
      download: (name, content, mime) => host.download(name, content, mime),
      refused: error => host.message(`Chest regions not exported: ${error}`, true),
      complete: () => host.message(`Downloaded chest-regions.json and chest-regions.binding.json for Build ${pickedSide.toUpperCase()}.`),
    });
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
    return exportMeshFiles(doc, {
      source: editExportSource,
      download: (name, content, mime) => host.download(name, content, mime),
      complete: count => host.message(`Downloaded mesh-edit.json (${count} ops) and mesh-edit.binding.json for Build ${pickedSide.toUpperCase()}.`),
    });
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
    if (state.inspectedDocumentReason) { physicsPanel.load({ available: false, reason: state.inspectedDocumentReason }, []); refreshIdle(); return; }
    if (!state.inspectedDocument) return;
    if (!state.rebuildStatus) { text('physics-panel-state', 'Reading the producer handoff…'); text('idle-tracks-state', 'Reading the producer handoff…'); return; }
    if (!state.rebuildStatus.inputs || !state.rebuildStatus.producer) {
      physicsPanel.load({ available: false, reason: state.rebuildStatus.reason ?? 'PHYSICS_TUNING_UNAVAILABLE: no producer handoff' }, []);
      refreshIdle();
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

  function chestPartForNotice(): string | null {
    const status = currentState().rebuildStatus;
    if (!status) return null;
    if (chestEditor?.mode() === 'landmarks') {
      const read = chestEditor.landmarks();
      return 'derived' in read ? pickBustPart(status, read.derived.regions) : pickBustPart(status, []);
    }
    const designated = designatedRegions(chestField, chestSeed(status));
    return 'regions' in designated ? pickPart(status, designated.regions) : status.parts.length === 1 ? status.parts[0]!.name : null;
  }

  function renderDropNotices(): void {
    const state = currentState();
    const selectedPart = host.parts()?.value();
    const slot = selectedPart?.side === pickedSide ? selectedPart.slot : null;
    const meshPart = meshPanel?.part() ?? slot;
    const chestPart = chestPartForNotice();
    for (const node of document.querySelectorAll<HTMLElement>('[data-rebuild-drop]')) {
      const panel = node.dataset.rebuildDrop as RebuildPanelKind;
      const part = panel === 'mesh' ? meshPart : panel === 'mesh-edit' ? slot : panel === 'chest' ? chestPart : null;
      let notice = '';
      let isError = false;
      try {
        notice = dropNoticeForPanel(state.appliedOnStage, panel, { part, handoff: state.rebuildStatus });
      } catch (error) {
        notice = errorText(error);
        isError = true;
      }
      node.textContent = notice;
      node.hidden = !notice;
      node.classList.toggle('error', isError);
    }
  }

  function renderAppliedBlocks(restoredJob: AnyJobView | null = null): void {
    reconcileAppliedBlocks(currentState(), {
      chestEditor, meshEditor, meshPanel, bonesPanel, rigFieldsPanel, cutsPanel, clothPanel, physicsPanel, idlePanel, retargetPanel, animationPanel,
    }, renderDropNotices, restoredJob, document);
  }

  function renderApplied(): void {
    renderAppliedPanel(renderAppliedBlocks, currentState, () => rebuildUiBusy() || !!host.readOnly(), el, document);
  }

  async function refreshApplied(side: Side = pickedSide): Promise<void> {
    if (!sides[side].inspectedModel) return;
    try { sides[side].appliedHistory = await host.api<AppliedHistoryView>(`${sideApiPrefix(side)}/rebuild/history`); } catch { return; }
    if (side === pickedSide) renderApplied();
  }

  function rebuildUiBusy(): boolean {
    return rebuildBusy && (rebuildUiOwner === null || rebuildUiOwner === pickedSide);
  }

  function renderRebuildState(): void {
    chestEditor?.rebuildState({ busy: rebuildUiBusy(), applied: !!currentState().appliedOnStage });
    renderApplied();
  }

  function rebuildState(historySide: Side = pickedSide, ui: JobUiSink = directJobUiSink): void {
    ui.render(renderRebuildState);
    if (!rebuildBusy) void refreshApplied(historySide);
  }

  function setRebuildBusy(value: boolean, side: Side, ui?: ScopedJobUiSink): void {
    rebuildBusy = value;
    rebuildUiOwner = value && ui ? side : null;
    rebuildState(ui ? side : undefined, ui);
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
      // #315: a config polygon the editor cannot read as an ellipse is named, never shown as an empty row.
      const refused = chestSeed(status).refusals;
      // #342: a rig with no contour mesh disables the chest tools before use and says why in words about the rig.
      const noContour = noContourReason(status);
      chestEditor?.unavailable(noContour?.text ?? null);
      if (noContour) chestEditor?.notify(noContour.text, false, noContour.lines);
      else if (!status.available) chestEditor?.notify(status.reason, true);
      else if (refused.length) chestEditor?.notify(refused.join(' · '), true, refused);
      else chestEditor?.notify('', false);
      sideJobs[pickedSide].renderHandoff(status);
      retargetPanel?.load(status.retarget ?? null, status.reason);
      bonesPanel?.load(status.inputs ? status.bones ?? [] : null, status.inputs ? null : status.reason ?? 'BONES_UNAVAILABLE: no producer handoff');
      rigFieldsPanel?.load(status.inputs ? status.fields ?? {} : null, status.inputs ? null : status.reason ?? 'RIG_FIELDS_UNAVAILABLE: no producer handoff');
      clothPanel?.load(status.inputs ? status.cloth ?? null : null, status.inputs ? null : status.reason ?? 'CLOTH_UNAVAILABLE: no producer handoff');
      cutsPanel?.load(status.inputs && status.cuts ? status.cuts.config : null, status.bones ?? [], status.inputs ? null : status.reason ?? 'CUTS_UNAVAILABLE: no producer handoff', status.cuts?.build ?? null);
      meshPanel?.load(status.inputs ? status.meshes ?? {} : null, status.inputs ? null : status.reason ?? 'MESH_PANEL_UNAVAILABLE: no producer handoff');
      meshPanel?.select(currentSlot);
      animationPanel?.loadSource(status.animations ?? null, status.reason);
    } else {
      chestEditor?.unavailable(null);
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

  function checkAnimation(side: Side = pickedSide): string {
    return selectCheckAnimation(host.assets[side]?.animations, () => host.data().animation);
  }

  function clipDuration(name: string, side: Side = pickedSide): number {
    return host.assets[side]?.animations.find(item => item.name === name)?.duration ?? host.duration();
  }

  function worldFor(name: string, side: Side = pickedSide): WorldExport | { error: string } {
    return worldExport(wind.snapshot(), gravityValue(), environmentApplied(), name, clipDuration(name, side));
  }

  function stepEnvironment(dt: number): void {
    const player = currentPlayer();
    stepWorldEnvironment(dt, () => player, pending => { joltQueue = pending; });
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
    updateDensityPending(sides[side], change, sideJobs[side].density.refresh);
  }

  async function swapPickedSide(side: Side, modelUrl: string, prefix: string, sha256: string, clipName?: string): Promise<void> {
    await host.swapSideRig(side, modelUrl, prefix, sha256, clipName);
    setAdjust(side);
    applyEnvironment();
    if (side === pickedSide) {
      refreshAnimationInspection();
      weightsView?.refresh();
      meshEditor?.selectionChanged();
    }
  }

  const panelRebuilds = bindPanelRebuilds({
    bones: () => bonesPanel, cloth: () => clothPanel, cuts: () => cutsPanel, idle: () => idlePanel,
    mesh: () => meshPanel, physics: () => physicsPanel, 'rig-fields': () => rigFieldsPanel,
  }, {
    origin: () => pickedSide, sink: sinkFor, status: side => sides[side].rebuildStatus, loadStatus: loadRebuildStatus,
    stageWorld, canReset: (side, key) => !!sides[side].appliedOnStage || (key === 'mesh' && !!sides[side].stripPending),
    apply: (side, patch, world, ui) => applyPatch(patch, world, side, ui),
    reset: (side, world, ui) => resetRebuild(world, side, ui),
    before: side => sides[side].stageCheck, inspected: inspectedCheckView,
    follow: (side, show, ui) => sideJobs[side].followInspectedCheck(show, ui),
    redraw: () => host.redrawOverlays(true),
    progress: (side, _key, patch) => `Applying ${patch.ops.length} op(s) on Build ${side.toUpperCase()}…`,
  });

  function rebuildJobOutput(side: Side, ui?: ScopedJobUiSink) {
    const visible = sinkFor(side).status, clear = () => chestEditor?.notify(null, false, []);
    return {
      progress: (write: () => void) => ui ? ui.transient('chest', write, clear) : visible(write),
      notice: (text: string, error: boolean, lines?: readonly string[]) => {
        const write = () => chestEditor?.notify(text, error, lines);
        if (ui) ui.outcome('chest', write, clear); else visible(write);
      },
      message: (text: string, error?: boolean) => {
        const write = () => host.message(text, error);
        if (ui) ui.outcome('message', write, clearCompareJobMessage); else write();
      },
    };
  }

  async function applyPatch(patch: ConfigPatch, _world: StageWorld | null = null, side: Side = pickedSide, ui?: ScopedJobUiSink): Promise<PatchJobView | RebuildRefusal> {
    return stageApplyPatch(stageJobs[side], patch, _world, ui);
  }

  async function resetRebuild(_world: StageWorld | null = null, side: Side = pickedSide, ui?: ScopedJobUiSink): Promise<void> {
    return stageResetRebuild(stageJobs[side], _world, ui);
  }

  function appliedStatus(msg: string, error = false): void {
    setAppliedStatus(el('applied-status'), msg, error);
  }

  function inspectedCheckView(side: Side = pickedSide): InspectedCheckView | null {
    return readInspectedCheck(sides[side].rebuildStatus);
  }

  const applyPhysics = panelRebuilds.apply.bind(null, 'physics');

  const resetPhysicsBuild = panelRebuilds.reset.bind(null, 'physics');

  const applyIdle = panelRebuilds.apply.bind(null, 'idle');

  const resetIdleBuild = panelRebuilds.reset.bind(null, 'idle');

  async function checkBones(ops: PatchOp[]): Promise<BonesCheckView> {
    const side = pickedSide, status = sides[side].rebuildStatus ?? await loadRebuildStatus(side);
    return requestBonesCheck(ops, status, {
      api: (path, init) => host.api(path, init), path: `${sideApiPrefix(side)}/bones-check`,
    });
  }

  const applyBones = panelRebuilds.apply.bind(null, 'bones');

  const resetBonesBuild = panelRebuilds.reset.bind(null, 'bones');

  const applyCuts = panelRebuilds.apply.bind(null, 'cuts');

  const resetCutsBuild = panelRebuilds.reset.bind(null, 'cuts');

  const applyCloth = panelRebuilds.apply.bind(null, 'cloth');

  const resetClothBuild = panelRebuilds.reset.bind(null, 'cloth');

  const applyRigFields = panelRebuilds.apply.bind(null, 'rig-fields');

  const resetRigFieldsBuild = panelRebuilds.reset.bind(null, 'rig-fields');

  async function applyMesh(part: string, entry: MeshEntry): Promise<PatchJobView | RebuildRefusal | null> {
    const side = pickedSide, state = sides[side], status = state.rebuildStatus ?? await loadRebuildStatus(side);
    const problems = meshPanel?.precheck() ?? [];
    if (problems.length) { if (pickedSide === side) meshPanel?.status(`${problems[0]} (review pre-check; nothing sent)`, true); return null; }
    const patch = status ? makePatch(status, meshPatchOps(part, entry), { cmd: 'remesh', args: ['--part', part] }) : null;
    if (!patch) { if (pickedSide === side) meshPanel?.status(status?.reason ?? 'REBUILD_STATUS_UNAVAILABLE', true); return null; }
    try { assertMeshPatch(patch, part); } catch (error) { if (pickedSide === side) meshPanel?.status(errorText(error), true); return null; }
    lastMeshPatch = patch;
    const world = stageWorld(), before = state.stageCheck;
    if (pickedSide === side) { meshPanel?.busy(true); meshPanel?.status(`Applying meshes.${part} on Build ${side.toUpperCase()} with ${patch.producer.name} ${patch.producer.version}: remesh --mesh, compile, check…`, false); }
    try {
      const result = await applyPatch(patch, world, side);
      const outcome = meshApplyOutcome(result as Parameters<typeof meshApplyOutcome>[0]);
      if (pickedSide === side) meshPanel?.status(outcome.text, outcome.error);
      if ('id' in result && result.status === 'built') {
        if (!host.layers.mesh) { host.layers.mesh = true; input('layer-mesh').checked = true; }
        const player = host.players[side];
        if (player) { player.draw(); host.parts()?.present(side); }
        host.redrawOverlays(true);
        const counts = result.remesh ?? null, overlay = state.lastOverlay?.meshTriangles[part] ?? null;
        const agree = triangleAgreement(counts, counts?.modelTriangles ?? null, overlay);
        if (pickedSide === side) {
          meshPanel?.counts([
            ...(counts ? [{ label: 'BEFORE', text: `${counts.part} ${countsText(counts.before)} (remesh.json)` }, { label: 'AFTER', text: `${counts.part} ${countsText(counts.after)} (remesh.json)` }] : []),
            { label: agree.ok ? 'AGREE' : 'DIFFER', text: agree.line, error: !agree.ok },
          ]);
        }
        const after = { lines: [...result.lines], check: result.check };
        const show = () => { if (pickedSide === side) meshPanel?.readout(readoutRows(before, before ? null : inspectedCheckView(side), after, ['TEXTURE_STRETCH'])); };
        show(); if (!before) void sideJobs[side].followInspectedCheck(show);
      }
      return result;
    } finally { meshPanel?.busy(false); }
  }

  const resetMeshBuild = panelRebuilds.reset.bind(null, 'mesh');

  const densityLine = (msg: string, error = false, side: Side = pickedSide) => {
    if (pickedSide === side) densityStrip?.status(msg, error);
    if (error) host.message(msg, true);
  };
  const renderStrip = () => {
    const state = currentState();
    densityStrip?.show(state.stripView, state.stripPending && state.stripView?.id === state.stripPending.id ? state.stripPending.index : null, (densityBusy && densityOwner === pickedSide) || rebuildUiBusy() || !!host.readOnly());
  };

  async function runReadings(override?: { readings: import('../src/readings.ts').ReadingRequest[] },
    origin?: Side): Promise<ReadingsJobView | ReadingsRefusal | null> {
    if (!readingsPanel || readingsBusy) return null;
    const side = origin ?? pickedSide, state = sides[side], ui = sinkFor(side);
    const hint = 'Pick readings, then Run: each runs on the picked build and on its latest scratch build.';
    const clearStatus = () => readingsPanel?.status(hint, false);
    const status = (text: string, error: boolean) => {
      if (origin) ui.outcome('readings', () => readingsPanel?.status(text, error), clearStatus);
      else if (pickedSide === side) readingsPanel?.status(text, error);
    };
    ui.clearOutcome('readings');
    const chosen = override ?? readingsPanel.requests();
    if ('error' in chosen) { status(chosen.error, true); return { status: 'refused', error: chosen.error }; }
    const animation = host.data().animation;
    let environment: ReturnType<typeof environmentFor> | WorldExport['schedule'] | null = currentPlayer() && input('environment-applied').checked ? environmentFor(wind.read(), Number(input('gravity').value)) : null;
    if (environment && useWorld()) {
      const world = worldFor(animation, side);
      if ('error' in world) { status(world.error, true); return { status: 'refused', error: world.error }; }
      environment = world.schedule;
    }
    const body = { animation, readings: chosen.readings, environment };
    const busy = (value: boolean) => {
      readingsBusy = value;
      if (origin) ui.projectBusy('readings', value, active => readingsPanel?.busy(active));
      else readingsPanel?.busy(value);
    };
    busy(true);
    const starting = `Running ${chosen.readings.length} reading(s) of ${animation} on Build ${side.toUpperCase()}…`;
    if (origin) ui.transient('readings', () => readingsPanel?.status(starting, false), clearStatus);
    else readingsPanel.status(starting, false);
    const started = performance.now();
    try {
      const job = await runReadingsRequest(body, { api: host.api.bind(host), path: `${sideApiPrefix(side)}/readings`, onError: text => status(text, true) });
      if (job.status !== 'done') return job;
      state.readingsJob = job;
      const ticks = job.runs.map(r => `${r.build} ${r.results.reduce((n, x) => n + x.frames.length, 0)} tick(s)`).join(' · ');
      const refused = job.runs.flatMap(r => r.results).find(r => r.status !== 'read');
      const line = `${refused ? `${refused.refusal} · ` : ''}Readings of ${job.request.animation}: ${ticks} · ${((performance.now() - started) / 1000).toFixed(1)} s`;
      const write = () => { readingsPanel?.lines(job); readingsPanel?.status(line, !!refused); };
      if (origin) ui.outcome('readings', write, () => { readingsPanel?.lines(null); clearStatus(); });
      else if (pickedSide === side) write();
      return job;
    } catch (error) { status(`READINGS_FAILED: ${errorText(error)}`, true); return null; }
    finally { busy(false); }
  }

  function readingsContext(): ReadingsContext | null {
    return buildReadingsContext(currentState().readingsJob);
  }

  function runRequirements(body: RequirementsRequest): Promise<RequirementsJobView | RequirementsRefusal | null> {
    const side = pickedSide;
    return runRequirementsRequest(body, {
      api: (path, init) => host.api(path, init),
      path: `${sideApiPrefix(side)}/requirements`, refresh: sideJobs[side].loadRequirements,
    });
  }

  function bindSideJobs(side: Side) {
    const state = sides[side], ui = sinkFor(side), api = host.api.bind(host), path = sideApiPrefix(side);
    const rebuild = handoffRefresh.bind({ api, path: `${path}/rebuild`, ui,
      read: () => state.rebuildStatus, save: next => { state.rebuildStatus = next; } });
    return {
      ...rebuild,
      loadRequirements: bindRequirementsCatalog({ api, path: `${path}/requirements`, ui, panel: () => requirementsPanel,
        save: catalog => { state.requirementsCatalog = catalog; } }),
      meshFolds: bindMeshFolds(ui, () => host.data().animation, request => runReadings(request, side), () => meshPanel),
      density: bindDensityStripJobs({
        api, path: `${path}/density-strip`, ui, view: () => state.stripView, save: next => { state.stripView = next; }, render: renderStrip,
        busy: () => densityBusy, setBusy: value => { densityBusy = value; densityOwner = value ? side : null; },
        pendingId: () => state.stripPending?.id, back: () => stageStripBack(stageJobs[side], ui), panel: () => densityStrip,
        footer: text => host.message(text, true), clearFooter: clearCompareJobMessage,
        readOnly: () => host.readOnly(), status: () => state.rebuildStatus, loadStatus: () => loadRebuildStatus(side),
        mesh: () => meshPanel, selected: () => pickedSide === side,
        initial: (part, values) => `Building a strip of ${values.length} on ${part} (Build ${side.toUpperCase()}): ${values.join(', ')}…`,
        summary: (view, passing) => `Strip of ${view.rows.length} on ${view.part} settled: ${passing} passing.`,
      }),
      runEnvironmentCheck: bindEnvironmentCheck({
        api, path: `${path}/environment-check`, ui, out: () => el('environment-check-lines'),
        busy: () => environmentCheckBusy, setBusy: value => { environmentCheckBusy = value; },
        paintBusy: value => { button('environment-check').disabled = value || !currentPlayer(); },
        animation: () => checkAnimation(side), worldFor: name => worldFor(name, side),
        applied: () => !!state.appliedOnStage, before: () => state.stageCheck, baseline: () => state.rebuildStatus?.baseline,
        inspected: () => inspectedCheckView(side), follow: show => rebuild.followInspectedCheck(show, directJobUiSink),
        scratchLabel: () => "the scratch build's Apply check",
        missingDefault: (name, line) => `${name}: no default-world check — ${line}`,
        initial: (name, build) => `Checking Build ${side.toUpperCase()} (${build}) under ${name}'s schedule…`,
        guardRevisions: true,
      }),
    };
  }
  const sideJobs = { a: bindSideJobs('a'), b: bindSideJobs('b') };

  function bindStageJobs(side: Side): StageJobScreen {
    const state = sides[side];
    const buildLetter = side === 'a' ? 'A' : 'B';
    const animationResetText = `Reset: Build ${buildLetter} is back on its inspected build; no pending animation ops.`;
    const rememberAnimation = () => { if (animationPanel) state.animationState = animationPanel.exportSideState(); };
    const directChest = rebuildJobOutput(side), scopedChest = rebuildJobOutput(side, sinkFor(side));
    return {
      state, buildLetter, api: host.api.bind(host), path: `${sideApiPrefix(side)}/rebuild`,
      readOnly: () => host.readOnly(), loadStatus: () => loadRebuildStatus(side),
      selected: () => pickedSide === side, busy: () => rebuildBusy,
      setBusy: value => { rebuildBusy = value; rebuildState(); },
      setScopedBusy: (value, ui) => setRebuildBusy(value, side, ui), world: () => null,
      swap: ({ url, prefix, hash }, _world, animation) => swapPickedSide(side, url, prefix, hash, animation),
      target: (next, stripId) => ({ url: new URL(host.route(next.url), location.href).href,
        prefix: host.route(stripId ? `/compare-density-strip/${side}/${stripId}/${next.id}/` : `/compare-rebuild/${side}/${next.id}/`), hash: next.hash }),
      changed: change => stageChanged(side, change), message: (text, error) => host.message(text, error),
      writeDraft: () => writeRebuildDraft(el<HTMLTextAreaElement>('rebuild-applied'), state.appliedOnStage),
      chest: () => chestEditor, chestField, mesh: () => meshPanel,
      meshNote: text => meshEditor?.setStatusNote(text, false), animation: () => animationPanel, retarget: () => retargetPanel,
      schedule: () => useWorld() ? worldFor(checkAnimation(side), side) : null,
      inactive: (ops, status, clearSelection) => {
        const cache = state.animationState;
        if (!cache) return;
        if (ops) cache.appliedOps = ops.map(op => structuredClone(op));
        if (status) cache.editorStatus = status;
        if (clearSelection) { cache.selectedKey = null; cache.selectedKeys = []; }
      },
      chestOutput: ui => ui ? scopedChest : directChest,
      patchStart: patch => `Applying patch on Build ${buildLetter} (${patch.op.cmd}, ${patch.ops.length} op(s))…`,
      resetNote: `Reset: Build ${buildLetter} is back on its inspected build.`,
      resetMessage: `Reset Build ${buildLetter} to its inspected build.`,
      finishReset: () => { rememberAnimation(); writeRebuildDraft(el<HTMLTextAreaElement>('rebuild-applied'), null); },
      undoStatus: appliedStatus,
      undoText: result => `Undid ${result.undone.slice(0, 12)}… on Build ${buildLetter} · ${result.history.depth} applied record(s) left`,
      finishUndo: job => { renderAppliedBlocks(job); rememberAnimation(); },
      undoReadouts: (cuts, cloth) => { cutsPanel?.shown(cuts); clothPanel?.shown(cloth); },
      redrawUndo: () => host.redrawOverlays(true),
      redrawStripBack: () => host.redrawOverlays(true), renderStrip,
      reportStrip: (text, error, ui) => {
        if (ui) sideJobs[side].density.outcome(text, error);
        else densityLine(text, error, side);
      },
      animationApplyText: (path, count) => `Applying ${count} animation op(s) on Build ${buildLetter} (${path}: rig-parts rig → rigc build → rig-parts check)…`,
      animationResetText, rememberAnimation,
      resetForAnimation: () => resetRebuild(stageWorld(), side),
      beforeAnimationReset: () => {
        animationPanel?.setEditorStatus(animationResetText, false); rememberAnimation();
        state.animAdjust = null; setAdjust(side);
      },
      stripLoad: {
        densityBusy: () => densityBusy,
        draw: () => {
          if (!host.layers.mesh) { host.layers.mesh = true; input('layer-mesh').checked = true; }
          host.redrawOverlays(true);
        },
        triangles: part => state.lastOverlay?.meshTriangles[part] ?? null,
        pendingCount: (view, row) => `${view.field} ${row.value} — not applied`,
        pendingStatus: (view, row, index) => `Pending on Build ${buildLetter}: ${view.part} ${view.field} ${row.value} (strip row ${index + 1}) — not applied.`,
      },
    };
  }
  const stageJobs = { a: bindStageJobs('a'), b: bindStageJobs('b') };

  function seekReading(clip: string, frame: number, exact: number | null, label: string): void {
    if (exact === null) { host.message(`${label}: F${frame} has no time; no seek was performed.`, true); return; }
    const at = readingSeekTime(exact, clipDuration(clip)), duration = host.duration();
    if (!Number.isFinite(at) || at < 0 || at > duration) {
      host.pause();
      host.message(`Explicit time ${formatSeconds(at)} s is outside the current range of ${formatSeconds(duration)} s. No substitute time was used.`, true);
      return;
    }
    void host.seekTo(at).then(() => {
      if (!document.getElementById('message')?.classList.contains('error')) {
        host.message(`Reading · ${label} → F${frame} · ${exact.toFixed(4)} s`);
      }
    });
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
    const environmentInputs = ['wind-base', 'wind-breeze', 'wind-gust', 'wind-repeat', 'wind-gust-peak', 'wind-gust-duration', 'gravity', 'jolt', 'physics-reset', 'environment-use', 'environment-export', 'environment-check'];
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
    button('applied-undo').onclick = () => { void stageUndoApply(stageJobs[pickedSide]); };
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
    button('environment-check').onclick = () => { void sideJobs[pickedSide].runEnvironmentCheck(); };
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
    readOnlyReason: () => host.readOnly(),
    hasTurnDial: () => currentState().partModel ? Boolean(currentSideData().feedbackCatalog.turnDials?.length) : undefined,
    pause: () => host.pause(),
    preview: fn => {
      sides[pickedSide].animAdjust = fn;
      setAdjust(pickedSide);
    },
    apply: ops => stageApplyAnimation(stageJobs[pickedSide], ops),
    reset: () => stageResetAnimation(stageJobs[pickedSide]),
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
    mapping: () => activeChestMapping(),
    changed: renderChest,
    download: () => { void exportChest(); },
    apply: () => { void stageApplyRebuild(stageJobs[pickedSide]); },
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
    apply: (doc, line) => stageApplyMeshDelta(stageJobs[pickedSide], doc, line),
    applied: () => currentState().appliedOnStage?.schema === 'rig-review-applied/3',
    resetBuild: () => resetRebuild(stageWorld()),
    message: host.message,
    confirm: msg => window.confirm(tr(msg)),
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
    folds: async () => { await sideJobs[pickedSide].meshFolds(); },
    changed: () => { host.redrawOverlays(false); densityStrip?.changed(); },
    saved: () => host.saveDraft(),
    token,
  });
  disposers.push(() => meshPanel?.dispose());

  densityStrip = bindDensityStrip({
    part: () => meshPanel?.part() ?? null,
    entry: () => meshPanel?.entry() ?? null,
    build: values => sideJobs[pickedSide].density.build(values),
    load: async i => { await stageLoadStripRow(stageJobs[pickedSide], i); },
    back: () => stageStripBack(stageJobs[pickedSide]),
    close: () => sideJobs[pickedSide].density.close(),
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
  retargetPanel = bindRetargetPanel({ apply: body => stageApplyRetarget(stageJobs[pickedSide], body), reset: () => { void resetRebuild(stageWorld()); }, seek: seekReading });
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
    undo: () => stageUndoApply(stageJobs[pickedSide]),
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
      select: (part: string) => { meshPanel?.select(part); renderDropNotices(); },
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
      folds: () => sideJobs[pickedSide].meshFolds(),
      overlayTriangles: (slot: string) => currentState().lastOverlay?.meshTriangles[slot] ?? null,
      status: () => el('mesh-status').textContent,
      counts: () => [...document.querySelectorAll('#mesh-counts code')].map(c => c.textContent),
      readout: () => [...document.querySelectorAll('#mesh-readout code')].map(c => c.textContent),
      pending: () => input('mesh-pending').value,
      lastPatch: () => lastMeshPatch ? JSON.parse(JSON.stringify(lastMeshPatch)) : null,
      strip: {
        build: (values: number[]) => sideJobs[pickedSide].density.build(values),
        view: () => currentState().stripView ? JSON.parse(JSON.stringify(currentState().stripView)) : null,
        load: (i: number) => stageLoadStripRow(stageJobs[pickedSide], i),
        back: () => stageStripBack(stageJobs[pickedSide]),
        close: () => sideJobs[pickedSide].density.close(),
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
    animation: {
      ops: () => animationPanel?.ops() ?? [],
      unappliedOps: () => animationPanel?.unappliedOps() ?? [],
      hasPreview: () => animationPanel?.hasUnappliedPreview() ?? false,
      source: () => animationPanel?.sourceInfo() ?? null,
      setSourceLoading: () => animationPanel?.setSourceLoading(),
      setSource: (source: Parameters<AnimationInspectionPanel['loadSource']>[0], fallbackReason?: string | null) => animationPanel?.loadSource(source, fallbackReason),
      gate: () => animationPanel?.gateInfo() ?? null,
      tracks: () => animationPanel?.tracksInfo() ?? [],
      selectedKey: () => animationPanel?.selectedKeyInfo() ?? null,
      selectedKeys: () => animationPanel?.selectedKeysInfo() ?? [],
      selectKey: (track: number, key: number) => animationPanel?.selectKey(track, key) ?? false,
      selectKeys: (selections: ReadonlyArray<{ track: number; key: number }>) => animationPanel?.selectKeys(selections) ?? false,
      toggleKeySelection: (track: number, key: number) => animationPanel?.toggleKeySelection(track, key) ?? false,
      deleteSelection: () => animationPanel?.deleteSelection() ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      stagePoseMode: () => animationPanel?.stagePoseMode() ?? 'rotate',
      setStagePoseMode: (mode: 'rotate' | 'translate') => animationPanel?.setStagePoseMode(mode),
      poseBone: (boneName: string, arg2: 'rotate' | 'translate' | number, arg3: number, arg4: number | 'rotate' | 'translate') => {
        const mode = typeof arg2 === 'string' ? arg2 : (arg4 as 'rotate' | 'translate');
        const clientX = typeof arg2 === 'number' ? arg2 : arg3;
        const clientY = typeof arg2 === 'number' ? arg3 : (arg4 as number);
        return animationPanel?.poseBoneOnStage(boneName, mode, clientX, clientY) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' };
      },
      overlaid: () => animationPanel?.overlaidInspection() ?? null,
      boneWorld: (boneName: string) => animationPanel?.boneWorldMatrix(boneName) ?? null,
      setKeyTime: (track: number, key: number, t: number) => animationPanel?.setKeyTime(track, key, t) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      setKeyValue: (track: number, key: number, channel: number | undefined, value: number | readonly number[]) => animationPanel?.setKeyValue(track, key, channel, value) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      setKeyCurve: (track: number, key: number, curve: readonly number[] | 'stepped' | null) => animationPanel?.setKeyCurve(track, key, curve) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      setKeyEase: (track: number, key: number, ease: string | null) => animationPanel?.setKeyEase(track, key, ease) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      insertKey: (track: number, t: number, value?: readonly number[]) => animationPanel?.insertKey(track, t, value) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      deleteKey: (track: number, key: number) => animationPanel?.deleteKey(track, key) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      moveSelection: (selections: ReadonlyArray<{ track: number; key: number }>, deltaTime: number) => animationPanel?.moveSelection(selections, deltaTime) ?? { ok: false, error: 'ANIMATION_PANEL_UNAVAILABLE' },
      undoOp: () => animationPanel?.undoOp() ?? false,
      clearPending: () => animationPanel?.clearPending(),
      zoom: () => animationPanel?.zoomLevel() ?? 1,
      setZoom: (z: number) => animationPanel?.setZoom(z),
      apply: () => stageApplyAnimation(stageJobs[pickedSide], animationPanel?.ops() ?? []),
      reset: () => stageResetAnimation(stageJobs[pickedSide]),
      status: () => document.querySelector('[data-animation-editor-status]')?.textContent ?? '',
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
      const p = host.players[side];
      try { const b = p?.bone('chest'); st.setupChestWorld = b && Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y } : null; } catch { st.setupChestWorld = null; }
      if (side !== pickedSide && st.animationState) {
        st.animationState.document = null;
        st.animationState.baseInspection = null;
      }
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
      if (side === pickedSide) populateChestBones();
      updateChestMapping(side);
      if (side === pickedSide) {
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
        sideJobs.a.loadRequirements(),
        sideJobs.b.loadRequirements(),
        refreshApplied('a'),
        refreshApplied('b'),
        sideJobs.a.density.refresh(),
        sideJobs.b.density.refresh(),
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
      renderDropNotices();
    },
    overlayInputFor: side => {
      if (side !== pickedSide) {
        return { regions: [], circles: [], markers: [], meshEdit: null, weights: null, anchors: null };
      }
      animationPanel?.redraw(host.layers.bones);
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
      const preview = idleAdjust ? 'Idle tracks' : (sides.a.animAdjust || sides.b.animAdjust) ? 'Keyed animation preview' : dialAdjust ? 'Rig fields turn dial' : physicsPreview.read().length ? 'Physics live overrides' :
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
      handoffRefresh.cancel();
      for (const dispose of disposers) dispose();
      disposers.length = 0;
    },
  };
}
