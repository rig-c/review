import {timeOnlyBasis,feedbackTimingLabel,requireFeedbackFrames,isTimeOnlyFeedback} from '../src/stage-comment.ts';
import {bindStageComments,type CommentPose} from './stage-comments.ts';
import {discoverTurnDials,TurnState} from '../src/turn-pad.ts';
import {bindTurnPad,type TurnPad} from './turn-pad.ts';
import {PartExplorer,loadPartModel,partBounds} from './part-selection.ts';
import {AnimationInspectionPanel} from './animation-inspection.ts';
import {PartThumbnails,pageRegionTable} from './part-thumbnails.ts';
import { CanvasRenderer, loadModel, RigPlayer, type BoneAdjust, type ModelAssets, type PoseBounds } from '@rig-c/play';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraSignature} from './camera-view.ts';
import {rendererStatus} from './renderer-status.ts';
import {bindAppearance,bindPan,bindStageLayout,syncStageLayout,bindInspectorTabs,idleAvailable,initialIdleAnimation,automaticIdlePreview,bindLayerShortcuts,describeLayerToggles,type ViewPoint} from './view-controls.ts';
import {RigOverlays,type OverlayCircle,type OverlayMarker,type OverlayRegion,type OverlaySnapshot} from './rig-overlays.ts';
import {bindMeshPanel,type MeshPanel} from './mesh-panel.ts';
import {bindDensityStrip,type DensityStripPanel,type DensityStripViewLike} from './density-strip-panel.ts';
import {densityField,densityPath} from '../src/density-strip.ts';
import {assertMeshPatch,countsText,meshApplyOutcome,meshPatchOps,setEntryValue,triangleAgreement,type MeshEntry} from '../src/mesh-entry.ts';
import {worstLine} from '../src/readings.ts';
import {chestOverlayCircles,chestOverlayPolygons,chestRegionRows,chestRowId,evaluateChestForm} from './chest-regions-tool.ts';
import {bindChestEditor,canvasToCrop,bustLabel,bustSides,LANDMARKS,landmarkInputId,rowCircle,type ChestEditor,type LandmarkKey} from './chest-editor.ts';
import {bindMeshEditor,meshEditSource,sha256Hex,type MeshEditor} from './mesh-editor.ts';
import {bindWeightsView,setupPoseMesh,type WeightsView} from './weights-view.ts';
import {readSetupPose} from './setup-pose.ts';
import {bindBonesPanel,type BonesPanel,type BonesCheckView} from './bones-panel.ts';
import {bindCutsPanel,type CutsPanel} from './cuts-panel.ts';
import {bindClothPanel,type ClothPanel} from './cloth-panel.ts';
import {retargetAppliedRecord,retargetOutcomeLine,stripPendingAfter,type StageChange,type AppliedRetarget,type RetargetJobView,type RetargetRequestBody} from './rebuild-client.ts';
import {bindRetargetPanel,type PoseMap,type RetargetPanel} from './retarget-panel.ts';
import type {RetargetFlags} from '../src/retarget.ts';
import {historyRow,isPatchJob,recordFor,refusedText,retargetStage,undoControl,type AppliedHistoryView,type UndoView,type AnyJobView,appliedRecord,deltaAppliedRecord,deltaOutcomeLine,designatedRegions,handoffText,landmarksRequest,seedLandmarks,makePatch,outcomeLine,patchAppliedRecord,patchOutcomeLine,pickPart,runRebuild,seedFields,stageModel,type AppliedDelta,type AppliedPatch,type AppliedRecord,type DeltaJobView,type DeltaRequestBody,type ConfigPatch,type PatchJobView,type RebuildJobView,type RebuildRefusal,type RebuildRequestBody,type RebuildStatusView} from './rebuild-client.ts';
import {meshEditBinding,meshEditText,type MeshEditDocument} from '../src/mesh-edit.ts';
import {chestRegionsBinding,cropWorldMapping,type CropWorldMapping} from '../src/chest-regions.ts';
import {bindWorkspaceUI,selectedInspector,type WorkspaceUI} from './workspace-ui.ts';
import {bindInspectorBlocks,activeBlocksUI,restoreActiveBlocksUI,type InspectorBlocks} from './inspector-blocks.ts';
import {connectControl} from './control.ts';
import {pageInstanceAccess,readOnlyReason} from './instance-access.ts';
import {controlComparison,type ControlCommand,type ControlInspection,type ControlView} from '../src/control.ts';
import {singleEligibility,videoReferenceAt,type InputState,type SingleLayout} from '../src/comparison-eligibility.ts';
import {parseBookmark,connectInspectionPersistence,serializableView,numericCamera,restoredZoom,restoreTransaction,captureInputs,restoreInputs,type InspectionBookmark,type InspectionBinding,type PersistenceConnection} from './inspection-persistence.ts';
import {initialPlayerAnimation,keptAnimation} from '../src/animation-selection.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import type {ReferenceBinding} from '../src/reference.ts';
import type { Checkpoint, Json, Reference, ReviewedSource, ReviewManifest } from '../src/manifest.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import type { ReportEvent, ReportSeeds } from '../src/report.ts';
import { frameAtTime, lastFrame as lastProducerFrame, rigPaneLabel, timeAtFrame, transportClock, type StageClock } from '../src/frame-clock.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection, type FeedbackCatalog } from '../src/feedback-validation.ts';
import { eventCoordinates, eventSeekTime, eventSelection, eventTimingLabel, reportCounts, reportDraftForMarker, targetLabel } from './report-view.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';
import {createWindModel,environmentFor,windReadout,RUNTIME_START_READOUT,joltPacket,dueJolts,dragMoved,loadModelDocument,environmentContext,environmentJson,type JoltStep,type WindSnapshot,type WindState} from '../src/environment.ts';
import {tuningRows,readoutRows,type InspectedCheckView} from '../src/physics-tuning.ts';
import {bindReadingsPanel,type ReadingsJobView,type ReadingsPanel,type ReadingsRefusal} from './readings-panel.ts';
import {READINGS_SCHEMA,readingSeekTime,type ReadingsContext} from '../src/readings.ts';
import {restartsWindClock,type ClipMove,environmentCheckRows,scheduleContext,worldExport,type EnvironmentCheckView,type WorldExport} from './environment-world.ts';
import {barLine,beforeLine} from '../src/physics-tuning.ts';
import {bindRequirementsPanel,type RequirementsCatalogView,type RequirementsJobView,type RequirementsPanel,type RequirementsRefusal} from './requirements-panel.ts';
import {patchRoute} from '../src/retune-route.ts';
import {appliedCheckRefusal,type CheckSummary} from '../src/applied-context.ts';
import {appliedBlockOps,recordBlock,staleReadouts} from '../src/applied-blocks.ts';
import {bindPhysicsPanel,type PhysicsPanel} from './physics-panel.ts';
import {bindIdlePanel,type BoneSetup,type IdlePanel} from './idle-panel.ts';
import {composeAdjust,PhysicsPreview} from './preview.ts';
import {bindRigFieldsPanel,type RigFieldsPanel} from './rig-fields-panel.ts';
import {assertRigFieldOps,RIG_FIELDS_READOUT_BARS,TURN_BONE} from '../src/rig-fields.ts';
import {IDLE_READOUT_BARS,type LocalChannel} from '../src/idle-tracks.ts';
import type {PatchOp} from '../src/config-patch.ts';

interface ReviewResponse { referenceHashes?:Record<string,string>; initialAnimation?:string|null; manifest: ReviewManifest; referenceBinding?:ReferenceBinding; explicitReference?:{id:string;name:string;sha256:string;url:string}; sourceHash: string; reviewedSource: ReviewedSource; report: ReportSeeds | null; feedbackCatalog: FeedbackCatalog; assetsBase: string; capabilities: { playback: boolean; modeling: false; motion: false; feedback: boolean; audio: boolean } }
interface PoseReference { schema: 'rig-review-pose/1'; coordinateSystem: 'image-pixels-y-down'; width: number; height: number; joints: { id: string; x: number; y: number; parent?: string }[] }
interface SequenceJoint { state: 'observed' | 'occluded' | 'missing' | 'inferred'; at?: [number, number]; score?: number }
interface PoseSequence { spec: 'rig-pose-sequence/1'; space: { units: 'picture-px'; origin: 'top-left'; y: 'down' }; width: number; height: number; source?: string; frames: { t: number; people: { id: string; joints: Record<string, SequenceJoint> }[] }[]; camera?: { s: number; tx: number; ty: number; inliers: number }[]; cameraSource?: unknown }
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
};
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const titledIds = new Set(['message', 'player-state', 'layout-state', 'renderer-state', 'layer-state', 'idle-state', 'control-state', 'draft-state', 'rig-label', 'reference-label', 'coordinates']);
const text = (id: string, value: string) => { const node = el(id); node.textContent = value; if (titledIds.has(id)) node.title = value; };
const option = (value: string, label: string) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// First, before any URL use: take the `#cap=` handoff into memory/session storage and strip it.
const access = pageInstanceAccess();
let readOnly: string | null = null;
let data: ReviewResponse;
let session: ReviewSession;
let dirty = false;
let saving = false;
let stripBusy = false;
let persistence:PersistenceConnection|null=null,submittedBaseline:ReviewSession|null=null,draftConflict=false;
let checkpoint: Checkpoint | undefined;
let assets: ModelAssets | null = null;
let player: RigPlayer | null = null;
let animation = '';
let playing = false;
let time = 0;
/** The clock a scratch build on the stage states for its own animation (a retarget's report frameTimes, #164). */
let stageClock: StageClock | null = null;
let duration = 0;
let lastFrame = 0;
type CameraTarget='rig'|'reference';
let cameraSync=true,activeCamera:CameraTarget='rig',cameraRestoring=false,cameraLayout='';
const cameraFrames:Partial<Record<CameraTarget,CameraFrame>>={};
let comments:ReturnType<typeof bindStageComments>|null=null;
let view: 'compare' | 'reference' | 'rig' = 'compare';
// Requested layout persists in the source-bound draft; the effective one follows actual load events only.
let rigInput:InputState={state:'pending'},referenceInput:InputState={state:'absent'},effectiveView:SingleLayout|null=null;
let zoom = 1;
let cameraCenter: { x: number; y: number } | null = null;
let referenceCenter:ViewPoint|null=null;
let rigScale=1,referenceScale=1,referenceZoom=1;
let displayedCenter:ViewPoint|null=null;
let playbackIntent=0,desiredPlay=false,seekingControl=false;
let parts:PartExplorer|null=null;
let animationPanel:AnimationInspectionPanel|null=null;
let inspectionSourceState:'ready'|'pending'|'failed'='ready';
function refreshAnimationInspection(){if(inspectionSourceState!=='ready'){animationPanel?.unavailable(`ANIMATION_INSPECTION_SOURCE_${inspectionSourceState.toUpperCase()}: current model source is unavailable`);return;}animationPanel?.update(player?.time??time,duration);animationPanel?.model(partModel,player?.current??'');animationPanel?.update(player?.time??time,duration);}
let overlays:RigOverlays|null=null;
let chestEditor:ChestEditor|null=null;
let meshEditor:MeshEditor|null=null;
/** Setup · Weights (#107): a watch layer over the selected slot's setup-pose mesh. */
let weightsView:WeightsView|null=null;
/** Setup · Bones (#109): the config's bone anchors on the stage, Check and a whole-rig Apply. */
let bonesPanel:BonesPanel|null=null;
let cutsPanel:CutsPanel|null=null;
let clothPanel:ClothPanel|null=null;
/** The hash-verified compiled model document the parts catalog was read from (mesh edit reads attachments from it). */
let partModel:unknown=null;
/** Apply · Rebuild (#99): the inspected model's URL, the producer status, and the applied record while its scratch build is on the stage. */
let inspectedModel:{url:string;prefix:string;sha256:string}|null=null,rebuildStatus:RebuildStatusView|null=null,appliedOnStage:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|null=null,rebuildBusy=false,stageModelHash:string|null=null;
let appearance:ReturnType<typeof bindAppearance>|null=null;
let workspace:WorkspaceUI|null=null;
let inspectorBlocks:InspectorBlocks|null=null;
let idleHeld=false;
let suspendedPreview=false;
let controlDispose:(()=>void)|null=null;
const viewDisposers:(()=>void)[]=[];
const layers={images:true,mesh:false,bones:false,meshOpacity:.65};
let chestMapping:CropWorldMapping={available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn'};
let referenceSize: { width: number; height: number } | null = null;
let video: HTMLVideoElement | null = null;
let controlledVideoSample:{media:HTMLVideoElement;position:number;time:number}|null=null;
let referenceGeneration = 0;
let axisInspection = false;
let sequence: PoseSequence | null = null;
let sequenceSvg: SVGSVGElement | null = null;
let selectedPerson = '';
let lastPoseFrame = -1;
const audioPlaying = new Set<HTMLAudioElement>();
const reportPageSize = 8;
let reportPage = 0;
let selectedReportEvent: ReportEvent | null = null;
let selectedReportTime: number | undefined;
let selectedReportTarget: number | undefined;
// Animate's Environment block: the wind clock advances only with the steps the player takes.
const wind=createWindModel();
let joltQueue:JoltStep[]=[],environmentNote='';
/** Animate · Physics tuning (#103): the panel, the inspected model document it maps against, and the check lines of the build on the stage (null: the inspected build, which review has not checked). */
/** Animate · Idle tracks (#104): the panel; its preview drives `player.adjust`. */
let idlePanel:IdlePanel|null=null;
/** Setup · Rig fields (#110): the panel; its turn dial and the idle preview share `player.adjust` (both run, idle first). */
let rigFieldsPanel:RigFieldsPanel|null=null,idleAdjust:BoneAdjust|null=null,dialAdjust:BoneAdjust|null=null;
let turnPad:TurnPad|null=null,turnAdjust:BoneAdjust|null=null;
function setAdjust():void {if(!player)return;player.adjust=composeAdjust(composeAdjust(idleAdjust,dialAdjust),turnAdjust);if(!playing)drawRig(()=>player!.draw());}
/** #106: the Setup Mesh panel, and the overlay's last snapshot (bar 1 reads its per-slot triangle count). */
let meshPanel:MeshPanel|null=null,lastOverlay:OverlaySnapshot|null=null,densityStrip:DensityStripPanel|null=null;
const physicsPreview=new PhysicsPreview();
let physicsPanel:PhysicsPanel|null=null,inspectedDocument:unknown=null,inspectedDocumentReason:string|null=null,stageCheck:{lines:string[];check:CheckSummary|null}|null=null;
/** Animate · Readings (#108): the block, the last finished job (its ticks and worst lines), and the run in flight. */
let requirementsPanel:RequirementsPanel|null=null,retargetPanel:RetargetPanel|null=null;
let readingsPanel:ReadingsPanel|null=null,readingsJob:ReadingsJobView|null=null,readingsBusy=false,readingsTickKey='';
/** The world an Apply's reload resumes: wind (clock and active pulse), pending jolts, whether the controls are engaged, gravity. */
interface StageWorld {wind:WindState;jolts:JoltStep[];applied:boolean;gravity:number}

function message(value: string, error = false): void {
  text('message', value);
  el('message').title = value; // the footer truncates long messages
  el('message').classList.toggle('error', error);
  // The modal makes the footer inert; the review dialog repeats the latest message for its reader.
  text('review-message', value); el('review-message').classList.toggle('error', error);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const response = await fetch(access.route(path), method === 'GET' || method === 'HEAD' ? init : { ...init, headers: access.headers(init?.headers) });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function referenceUrl(reference:Reference):string {return data.explicitReference?.id===reference.id?access.route(data.explicitReference.url):assetUrl(reference.path);}

function assetUrl(path: string): string {
  if (!path || path.startsWith('/') || /[\\%?#\x00-\x1f]/.test(path) || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsupported package asset path: ${path}`);
  return access.route('/assets/' + path.split('/').map(encodeURIComponent).join('/'));
}

function markDirty(): void {
  dirty = true;
  updateSavedState();
}

function updateSavedState(): void {
  text('dirty', dirty ? 'Unsubmitted changes' : session.updatedAt ? 'Submitted' : 'Not submitted');
  el('dirty').classList.toggle('dirty', dirty);
  button('save').disabled = saving || draftConflict || !!readOnly || session.feedbackWarnings.length > 0;
  button('save').title = readOnly ? readOnly : session.feedbackWarnings.length ? 'Delete feedback with validation warnings, then add it again with a valid target.' : '';
}

function renderProvenance(): void {
  const provenance = session.reviewedSource;
  text('provenance-version', provenance.packageRevision);
  text('provenance-rig', provenance.rig ? provenance.rig.sha256.slice(0, 12) + '…' : 'Not supplied');
  text('provenance-motion', provenance.motion ? provenance.motion.sha256.slice(0, 12) + '…' : 'Not supplied');
  text('provenance-full', JSON.stringify({ sourceHash: session.sourceHash, referenceBinding:session.referenceBinding, reviewedSource: provenance }, null, 2));
}

function checkpointEntry(): ReviewSession['checkpoints'][string] | undefined {
  if (!checkpoint) return;
  return session.checkpoints[checkpoint.id] ??= { outcome: 'pending', note: '' };
}

function renderCheckpoints(): void {
  const list = el('checkpoints'); list.replaceChildren();
  for (const point of data.manifest.checkpoints) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'checkpoint';
    item.setAttribute('aria-current', String(point.id === checkpoint?.id));
    const label = document.createElement('span'); label.textContent = point.title;
    const status = document.createElement('small');
    status.textContent = { pending: '○ Pending', pass: '✓ Pass', fail: '↗ Needs changes' }[session.checkpoints[point.id]?.outcome ?? 'pending'];
    item.append(label, status); item.onclick = () => { void chooseCheckpoint(point); }; list.append(item);
  }
  if (!data.manifest.checkpoints.length) list.textContent = 'No checkpoints supplied.';
}

async function chooseCheckpoint(point: Checkpoint,initial?:{referenceId?:string;updateUrl:boolean}): Promise<void> {
  pause(); checkpoint = point; axisInspection = false;
  if(initial?.updateUrl!==false){const url = new URL(location.href); url.searchParams.set('checkpoint', point.id); window.history.replaceState(null, '', url);}
  if (point.animation) chooseAnimation(point.animation);
  time = point.time ?? 0;
  const referenceId=initial?.referenceId??point.reference;
  if (referenceId && select('reference-select').value !== referenceId) {
    select('reference-select').value = referenceId; await showReference(referenceId);
  }
  zoom = Math.min(8, Math.max(.25, point.camera?.zoom ?? 1));
  if(cameraSync)activeCamera=player?'rig':'reference';
  cameraCenter = point.camera ? { x: point.camera.x, y: point.camera.y } : null;
  seek(time);
  if (point.axis && player && !input('axis-value').disabled) {
    select('axis-select').value = point.axis.id; chooseAxis(); input('axis-value').value = String(point.axis.value); applyAxis();
  }
  if(cameraSync)alignCameras();fitCamera(); renderCheckpoint(); renderCheckpoints();
}

function renderCheckpoint(): void {
  text('checkpoint-title', checkpoint?.title ?? 'Review entire package');
  text('detail-title', checkpoint?.title ?? 'No checkpoint supplied');
  text('detail-note', checkpoint?.note ?? 'Record checkpoint notes and outcomes.');
  const entry = checkpoint ? session.checkpoints[checkpoint.id] : undefined;
  el<HTMLTextAreaElement>('checkpoint-note').value = entry?.note ?? '';
  el<HTMLTextAreaElement>('checkpoint-note').disabled = !checkpoint;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="outcome"]')) { radio.checked = radio.value === (entry?.outcome ?? 'pending'); radio.disabled = !checkpoint; }
}

function setView(value: typeof view): void {view=value;renderLayout();}
function layoutEligibility(){return singleEligibility({rig:rigInput,reference:referenceInput,requested:view});}
/** Unavailable layouts stay visible but disabled with their named reason; no placeholder pane stands in for a missing input. */
function renderLayout():void {
 const state=layoutEligibility();effectiveView=state.effective;
 for(const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')){const layout=item.dataset.view as SingleLayout,reason=state.reasons[layout]??'';item.setAttribute('aria-pressed',String(layout===state.effective));item.disabled=!!reason;item.title=reason;if(reason)item.setAttribute('aria-description',reason);else item.removeAttribute('aria-description');}
 const menuLabels={compare:'Side by side',reference:'Reference',rig:'Rig'};text('view-menu-label',menuLabels[state.effective??state.requested]);
 el('reference-pane').hidden=state.effective!=='compare'&&state.effective!=='reference';el('rig-pane').hidden=state.effective!=='compare'&&state.effective!=='rig';
 const shown={compare:'Side by side',reference:'Reference only',rig:'Rig only'};
 text('layout-state',state.effective===null?`No input rendered · ${state.reasons.compare??''}`:state.effective===state.requested?shown[state.effective]:`${shown[state.effective]} · ${shown[state.requested]} unavailable: ${state.reasons[state.requested]??''}`);
 fitCamera();
}
function setReferenceInput(value:InputState):void {const leaving=referenceInput.state==='out-of-domain'&&value.state!=='out-of-domain';referenceInput=value;if(value.state==='out-of-domain')message(`REFERENCE_OUT_OF_DOMAIN: ${value.reason}. The reference was not clamped.`,true);else if(leaving)message('Reference back in its domain at the held time.');renderLayout();}
/** A video counts only after `seeked` at the held time with a decoded frame (readyState >= 2). */
function holdVideoReference(media:HTMLVideoElement,generation:number):void {
 if(referenceInput.state==='failed')return;
 const next=videoReferenceAt(time,media.duration);
 if(next.state!=='pending'){if(referenceInput.state!==next.state||next.state!=='out-of-domain')setReferenceInput(next);return;}
 if(referenceInput.state==='loaded'){media.currentTime=time;return;}
 const held=time,current=()=>generation===referenceGeneration&&media===video&&referenceInput.state==='pending'&&time===held;
 media.addEventListener('seeked',()=>{if(!current())return;const done=()=>{if(current()&&media.readyState>=2)setReferenceInput({state:'loaded'});};if(media.readyState>=2)done();else for(const event of ['loadeddata','canplay'])media.addEventListener(event,done,{once:true});},{once:true});
 if(referenceInput.state!=='pending')setReferenceInput({state:'pending'});media.currentTime=held;
}

function svgNode(tag: string, attrs: Record<string, string | number>, parent: SVGElement): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value))); parent.append(node); return node;
}

function readPose(value: unknown): PoseReference {
  if (!value || typeof value !== 'object') throw new Error('Pose reference: expected object');
  const pose = value as Partial<PoseReference>;
  if (pose.schema !== 'rig-review-pose/1' || pose.coordinateSystem !== 'image-pixels-y-down' || !Number.isFinite(pose.width) || !Number.isFinite(pose.height) || !(pose.width! > 0) || !(pose.height! > 0) || !Array.isArray(pose.joints)) throw new Error('Pose reference: expected rig-review-pose/1 with positive dimensions');
  const ids = new Set<string>();
  for (const joint of pose.joints) {
    if (!joint || typeof joint.id !== 'string' || !joint.id || ids.has(joint.id) || !Number.isFinite(joint.x) || !Number.isFinite(joint.y)) throw new Error('Pose reference: joints require unique IDs and finite x/y');
    ids.add(joint.id);
  }
  for (const joint of pose.joints) if (joint.parent && !ids.has(joint.parent)) throw new Error(`Pose reference: unknown parent ${joint.parent}`);
  return pose as PoseReference;
}

function readSequence(value: unknown): PoseSequence | null {
  if (!value || typeof value !== 'object' || !('spec' in value) || value.spec !== 'rig-pose-sequence/1') return null;
  const pose = value as Partial<PoseSequence>;
  if (pose.space?.units !== 'picture-px' || pose.space.origin !== 'top-left' || pose.space.y !== 'down' || !(pose.width! > 0) || !(pose.height! > 0) || !Number.isFinite(pose.width) || !Number.isFinite(pose.height) || !Array.isArray(pose.frames) || !pose.frames.length) throw new Error('rig-pose-sequence/1: expected picture-px, top-left, y-down and nonempty frames');
  let previous = -Infinity;
  for (const frame of pose.frames) {
    if (!frame || !Number.isFinite(frame.t) || frame.t <= previous || !Array.isArray(frame.people)) throw new Error('rig-pose-sequence/1: frame times must strictly increase');
    previous = frame.t; const ids = new Set<string>();
    for (const person of frame.people) {
      if (!person || typeof person.id !== 'string' || ids.has(person.id) || !person.joints || typeof person.joints !== 'object') throw new Error('rig-pose-sequence/1: each person needs a unique id and joints');
      ids.add(person.id);
      for (const joint of Object.values(person.joints)) {
        if (!joint || !['observed', 'occluded', 'missing', 'inferred'].includes(joint.state)) throw new Error('rig-pose-sequence/1: unknown joint state');
        if (joint.state !== 'missing' && (!Array.isArray(joint.at) || joint.at.length !== 2 || !joint.at.every(Number.isFinite))) throw new Error('rig-pose-sequence/1: located joints require finite at[x,y]');
        if (joint.score !== undefined && !Number.isFinite(joint.score)) throw new Error('rig-pose-sequence/1: score must be finite');
      }
    }
  }
  return pose as PoseSequence;
}

function renderSequenceFrame(): void {
  if (!sequence || !sequenceSvg) return;
  const target = sequence.frames[0]!.t + time;
  let lo = 0, hi = sequence.frames.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sequence.frames[mid]!.t <= target) lo = mid; else hi = mid - 1; }
  if (lo === lastPoseFrame) return;
  lastPoseFrame = lo; sequenceSvg.replaceChildren();
  const frame = sequence.frames[lo]!, person = frame.people.find(item => item.id === selectedPerson);
  text('reference-label', `Input pose · ${selectedPerson || 'No person selected'} · t ${frame.t.toFixed(3)} s`);
  if (!person) { el('reference-empty').hidden = false; text('reference-empty', selectedPerson ? 'The selected person is absent from this frame.' : 'Select a person.'); return; }
  el('reference-empty').hidden = true;
  const pairs = [['nose', 'neck'], ['neck', 'r_shoulder'], ['r_shoulder', 'r_elbow'], ['r_elbow', 'r_wrist'], ['neck', 'l_shoulder'], ['l_shoulder', 'l_elbow'], ['l_elbow', 'l_wrist'], ['neck', 'r_hip'], ['r_hip', 'r_knee'], ['r_knee', 'r_ankle'], ['neck', 'l_hip'], ['l_hip', 'l_knee'], ['l_knee', 'l_ankle']];
  for (const [a, b] of pairs) { const from = person.joints[a!], to = person.joints[b!]; if (from?.at && to?.at && from.state !== 'missing' && to.state !== 'missing') svgNode('line', { x1: from.at[0], y1: from.at[1], x2: to.at[0], y2: to.at[1], stroke: '#b2deca', 'stroke-width': 2, 'stroke-dasharray': from.state === 'observed' && to.state === 'observed' ? 'none' : '5 4' }, sequenceSvg); }
  for (const [name, joint] of Object.entries(person.joints)) { if (!joint.at || joint.state === 'missing') continue; const dot = svgNode('circle', { cx: joint.at[0], cy: joint.at[1], r: 4, fill: joint.state === 'observed' ? '#c6e6d7' : '#294535', stroke: '#c6e6d7', 'stroke-width': 1.5 }, sequenceSvg); const title = document.createElementNS(sequenceSvg.namespaceURI, 'title'); title.textContent = `${name}: ${joint.state}${joint.score === undefined ? '' : ` · score ${joint.score}`}`; dot.append(title); }
}

async function showReference(id: string): Promise<void> {
  const generation = ++referenceGeneration;
  video?.pause(); video = null;controlledVideoSample=null;delete cameraFrames.reference; referenceCenter=null; referenceSize = null; sequence = null; sequenceSvg = null; selectedPerson=''; lastPoseFrame = -1; el('person-control').hidden = true;
  const content = el('reference-content'); content.replaceChildren();
  const reference = data.manifest.references.find(item => item.id === id);
  el('reference-empty').hidden = false;setReferenceInput(reference?{state:'pending'}:{state:'absent'});
  if (!reference) { text('reference-empty', 'No reference supplied.'); text('reference-info', 'Add image, video or input-pose references to the package.'); return; }
  text('reference-label', reference.label + (reference.type === 'pose' ? ' · Static input pose' : ' · Reference'));
  text('reference-empty', 'Loading reference…');
  text('reference-info', `${reference.type} · ${reference.path}`);
  const fail = (reason='reference could not render') => { if (generation !== referenceGeneration) return; setReferenceInput({state:'failed',reason}); el('reference-empty').hidden = false; text('reference-empty', 'Could not open the reference. Check the package files.'); };
  try {
    if (reference.type === 'pose') {
      const response = await fetch(referenceUrl(reference)); if (!response.ok) throw new Error(`Pose reference HTTP ${response.status}`);
      const value: unknown = await response.json(); if (generation !== referenceGeneration) return;
      const canonical = readSequence(value);
      if (canonical) {
        sequence = canonical; referenceSize = { width: canonical.width, height: canonical.height };
        sequenceSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sequenceSvg.setAttribute('width', String(canonical.width)); sequenceSvg.setAttribute('height', String(canonical.height)); sequenceSvg.setAttribute('viewBox', `0 0 ${canonical.width} ${canonical.height}`); sequenceSvg.setAttribute('role', 'img'); sequenceSvg.setAttribute('aria-label', 'Original input pose sequence · joint states and confidence preserved');
        content.append(sequenceSvg); const people = [...new Set(canonical.frames.flatMap(frame => frame.people.map(person => person.id)))];
        select('person-select').replaceChildren(); if (people.length !== 1) select('person-select').append(option('', 'Select person')); for (const id of people) select('person-select').append(option(id, id)); selectedPerson = people.length === 1 ? people[0]! : ''; select('person-select').value = selectedPerson; el('person-control').hidden = false;
        if (!player) duration = canonical.frames[canonical.frames.length - 1]!.t - canonical.frames[0]!.t;
        text('reference-info', `${reference.path} · picture-px / top-left / y↓ · ${canonical.frames.length} frames${canonical.camera ? ' · Camera metadata preserved (normalization is not applied twice)' : ''}`);
        renderSequenceFrame(); setReferenceInput({state:'loaded'}); renderTransport(); return;
      }
      const pose = readPose(value);
      referenceSize = { width: pose.width, height: pose.height };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(pose.width)); svg.setAttribute('height', String(pose.height)); svg.setAttribute('viewBox', `0 0 ${pose.width} ${pose.height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', reference.label + ' · Unmodified static input pose');
      const byId = new Map(pose.joints.map(joint => [joint.id, joint]));
      for (const joint of pose.joints) {
        if (joint.parent) { const parent = byId.get(joint.parent)!; svgNode('line', { x1: parent.x, y1: parent.y, x2: joint.x, y2: joint.y, stroke: '#b2deca', 'stroke-width': 2 }, svg); }
        const dot = svgNode('circle', { cx: joint.x, cy: joint.y, r: 4, fill: '#203d31', stroke: '#caead9', 'stroke-width': 1.5 }, svg);
        const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = joint.id; dot.append(title);
      }
      content.append(svg); el('reference-empty').hidden = true; setReferenceInput({state:'loaded'});
    } else if (reference.type === 'image') {
      const image = new Image(); image.draggable=false; image.alt = reference.label; image.onload = () => { if (generation !== referenceGeneration) return; referenceSize = { width: image.naturalWidth, height: image.naturalHeight }; image.width = image.naturalWidth; image.height = image.naturalHeight; el('reference-empty').hidden = true; fitCamera(); }; await new Promise<void>((resolve,reject)=>{const loaded=image.onload;const timer=setTimeout(()=>reject(new Error('Reference image load timed out')),10000);image.onload=event=>{clearTimeout(timer);if(typeof loaded==='function')loaded.call(image,event);resolve();};image.onerror=()=>{clearTimeout(timer);fail();reject(new Error('Reference image load failed'));};image.src=referenceUrl(reference);content.append(image);});
      await image.decode(); if (generation !== referenceGeneration) return; if (!image.naturalWidth || !image.naturalHeight) throw new Error('Reference image has no renderable pixels'); setReferenceInput({state:'loaded'});
    } else {
      const media = document.createElement('video'); media.controls = true; media.muted = true; media.preload = 'metadata'; media.playsInline = true;
      media.onloadedmetadata = () => { if (generation !== referenceGeneration) return; referenceSize = { width: media.videoWidth, height: media.videoHeight }; media.width = media.videoWidth; media.height = media.videoHeight; if (Number.isFinite(media.duration) && !player) duration = media.duration; el('reference-empty').hidden = true; holdVideoReference(media, generation); fitCamera(); renderTransport(); };
      media.onerror = () => fail('reference video could not be decoded'); media.src = referenceUrl(reference); video = media; content.append(media);
    }
  } catch (error) { fail(errorText(error)); message(errorText(error), true); }
}

function referenceFit(): void {
  if (!referenceSize || !paneFrame('reference')) return;
  const viewport = el('reference-viewport'), content = el('reference-content');
  const scale = referenceScale = Math.max(.001,Math.min((viewport.clientWidth - 24) / referenceSize.width, (viewport.clientHeight - 56) / referenceSize.height) * referenceZoom);
  const center=referenceCenter??{x:referenceSize.width/2,y:referenceSize.height/2};
  content.style.left = `${viewport.clientWidth/2-center.x*scale}px`;
  content.style.top = `${viewport.clientHeight/2-center.y*scale}px`;
  content.style.transform = `scale(${scale})`;
}

function fitCamera(): void {
  const boxKey=assets?.stage??player?.bounds();
  const layout=['rig','reference'].map(target=>{const v=el(target+'-viewport');return `${v.clientWidth}:${v.clientHeight}`;}).join('|')+view+referenceGeneration+!!player+JSON.stringify(referenceSize)+JSON.stringify(boxKey);
  if(cameraSync&&!cameraRestoring&&layout!==cameraLayout)alignCameras();cameraLayout=layout;
  referenceFit();renderNumericView();renderCameraControls();
  if (!player || !assets) return;
  const box: PoseBounds | null = assets.stage ?? player.bounds(); if (!box || box.width <= 0 || box.height <= 0) return;
  const viewport = el('rig-viewport');if(!paneFrame('rig'))return;
  const scale = rigScale = Math.max(.001,Math.min((viewport.clientWidth - 28) / box.width, (viewport.clientHeight - 58) / box.height) * zoom);
  const center = cameraCenter ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };displayedCenter={...center};
  const root = el('rig-root'); root.style.left = `${viewport.clientWidth / 2 - center.x * scale}px`; root.style.top = `${viewport.clientHeight / 2 + center.y * scale}px`; root.style.transform = `scale(${scale})`;
  player.renderer.syncPixelRatio();redrawOverlay(false);renderNumericView();
}

function renderTransport(): void {
  refreshAnimationInspection();
  const end = duration > 0 ? ` / ${duration.toFixed(4)}` : '';
  text('time-label', sequence ? `Source ${(time + sequence.frames[0]!.t).toFixed(4)} ↔ ${time.toFixed(4)}${end} s` : `${time.toFixed(4)}${end} s`);
  input('scrub').max = String(Math.max(duration, .001)); input('scrub').value = String(time); input('scrub').disabled = duration <= 0;
  button('play').disabled = (!player && !video && !sequence) || duration <= 0;
  renderFrameTransport();
  renderFeedbackRange();
  renderReadingTicks();
  idlePanel?.place(duration);physicsPanel?.refreshPreview();
}

/** Re-lay the reading ticks only when what places them changes (renderTransport runs every played frame). */
function renderReadingTicks(force = false): void {
  if (!readingsPanel) return;
  const scrub = input('scrub'), key = `${readingsJob?.id ?? ''}|${readingsJob?.runs.map(r => r.results.length).join(',')}|${animation}|${duration}|${scrub.offsetLeft},${scrub.offsetTop},${scrub.offsetWidth}`;
  if (!force && key === readingsTickKey) return;
  readingsTickKey = key; readingsPanel.ticks(readingsJob, animation, duration);
}

function feedbackAnimation(): string | null { return player && player.current !== animation ? null : animation || null; }

function renderFeedbackRange(): void {
  const last = feedbackLastFrame(data.feedbackCatalog, feedbackAnimation());
  for (const id of ['feedback-start', 'feedback-end']) {
    if (last === null) input(id).removeAttribute('max'); else input(id).max = String(Math.max(0, last));
  }
  text('feedback-range-hint', last === null ? 'Bounds unknown · enter an inclusive integer frame range. FPS is not inferred.' : last < 0 ? 'No frames overlap the explicit clock and selected clip.' : `F0–F${last} for the explicit clock and current clip · inclusive`);
}

function renderFeedbackTargets(preserve = false): void {
  const kind = select('feedback-target-kind').value;
  const names = ['bone', 'slot', 'rig'].includes(kind) ? feedbackTargetNames(data.feedbackCatalog, kind as Feedback['target']['kind']) : null;
  const list = el<HTMLDataListElement>('feedback-target-names'); list.replaceChildren();
  for (const name of names ?? []) list.append(option(name, name));
  const field = input('feedback-target-name'); field.readOnly = kind === 'rig'; field.disabled = !names?.length;
  if (kind === 'rig') field.value = data.feedbackCatalog.rig;
  else if (!preserve || !names?.includes(field.value)) field.value = '';
  text('feedback-target-hint', !kind ? 'Select a target type first.' : names === null ? 'Actual target catalog unavailable · bone and slot feedback cannot be added.' : !names.length ? 'No targets of this type.' : kind === 'rig' ? 'Actual rig identifier for this package.' : `Choose or enter an exact name from this rig: ${names.length} targets.`);
}

function renderFrameTransport(): void {
  const active = activeTransportClock(), clock = active?.clock ?? null;
  const last = lastProducerFrame(clock), frame = frameAtTime(clock, time);
  text('rig-label', rigPaneLabel({ hasPlayer: !!player, animation: player?.current ?? animation, time, frame }));
  el('frame-controls').hidden = last === null;
  if (!clock) { text('frame-label', data.report?.clock ? data.report.animation ? 'Frame unknown · report and current clip do not match' : 'Frame unknown · report animation not supplied' : 'rate unknown'); return; }
  if (last === null) { text('frame-label', 'F? / ? · frame range unknown'); return; }
  text('frame-label', `F${frame === null ? '?' : frame} / ${last}${frame === null ? ' · Out of range' : ''}`);
  text('frame-clock-label', (clock.kind === 'uniform' ? `${clock.fps} fps · frame0 ${clock.frame0} s` : `frameTimes · ${clock.frameTimes.length} explicit times`) + (active?.source === 'stage' ? " · this build's report" : ''));
  input('frame-number').max = String(last);
  if (document.activeElement !== input('frame-number')) input('frame-number').value = frame === null ? '' : String(frame);
  input('frame-scrub').max = String(last); input('frame-scrub').hidden = frame === null;
  if (frame !== null) input('frame-scrub').value = String(frame);
  input('frame-scrub').disabled = last === 0;
  el('frame-outside').hidden = frame !== null;
}

function activeTransportClock() {
  const active = player && player.current !== animation ? '' : animation;
  return transportClock({ clock: data.report?.clock, animation: data.report?.animation }, active, !!player, stageClock, stageModelHash);
}
function activeFrameClock() { return activeTransportClock()?.clock ?? null; }

function seekFrame(frame: number): void {
  const exact = timeAtFrame(activeFrameClock(), frame);
  if (exact === null) { message('Select an integer frame within the explicit clock bounds.', true); renderFrameTransport(); return; }
  pause();
  if ((duration > 0 && exact > duration) || (video && video.readyState >= 1 && Number.isFinite(video.duration) && exact > video.duration)) { message(`F${frame} maps to ${exact} s, outside the current reference range. The requested time was not changed.`, true); renderFrameTransport(); return; }
  seek(exact);
  message(`F${frame} · Explicit time ${exact} s${!player && !video && !sequence ? ' (No playback reference · time display only)' : ''}`);
}

function drawRig(action:()=>void):void {
 try{action();parts?.present('single');if(player&&inspectionSourceState==='ready')animationPanel?.capture(player,parts?.frame('single'));else animationPanel?.capture(null,undefined);text('renderer-state',rendererStatus(player?.renderer??null,'succeeded').label);redrawOverlay(true);}
 catch(error){animationPanel?.capture(null,undefined);overlays?.clear();text('renderer-state',rendererStatus(null,'failed').label);throw error;}
}

function chooseAnimation(name: string, move: ClipMove = { kind: 'choose' }): void {
  pause(); animation = name; axisInspection = false; el('angle-panel').hidden = true;
  const runtimeAnimation = assets?.animations.find(item => item.name === name);
  duration = clipDuration(name);
  select('animation-select').value = name;
  // #191: the wind restarts before the clip's first frame is drawn, so the paused stage shows the schedule's t=0 world.
  time = 0; clipMoved(move);
  if (player && runtimeAnimation) { drawRig(()=>{player!.play(name,{loop:false});player!.pause();refreshAnimationInspection();player!.draw();}); }
  else if (player && name){text('renderer-state',rendererStatus(null,'failed').label);message(`Animation "${name}" is not present in the rig.`, true);}
  renderTransport(); renderCues();renderIdle();
}

function seek(value: number, move?: ClipMove): void {
  time = duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value);
  clipMoved(move ?? { kind: 'seek', to: time });
  if (player && player.current) { try { player.seek(time); drawRig(()=>player!.draw()); } catch (error) {text('renderer-state',rendererStatus(null,'failed').label); message(errorText(error), true); } }
  if (video && video.readyState >= 1) holdVideoReference(video, referenceGeneration);
  renderSequenceFrame(); renderTransport();
}

function stopAudio(): void { for (const audio of audioPlaying) audio.pause(); audioPlaying.clear(); }
function pause(): void { ++playbackIntent;desiredPlay=false;suspendedPreview=false;idleHeld=true; playing = false; lastFrame = 0; player?.pause(); video?.pause(); stopAudio(); button('play').textContent = '▶'; button('play').setAttribute('aria-label', 'Play'); }

async function audition(clipId: string): Promise<void> {
  const clip = data.manifest.audio.clips.find(item => item.id === clipId); if (!clip) return;
  const audio = new Audio(assetUrl(clip.path)); audio.volume = Number(input('audio-volume').value); audioPlaying.add(audio);
  audio.onended = () => audioPlaying.delete(audio); audio.onerror = () => { audioPlaying.delete(audio); message(`Could not open audio: ${clip.label ?? clip.id}`, true); };
  try { await audio.play(); } catch (error) { audioPlaying.delete(audio); message(`Audio playback was refused: ${errorText(error)}`, true); }
}

function activeCues() { return data.manifest.audio.cues.filter(cue => !cue.animation || cue.animation === animation); }
function renderCues(): void {
  const area = el('cues'); area.replaceChildren();
  for (const cue of activeCues()) {
    const clip = data.manifest.audio.clips.find(item => item.id === cue.clip);
    const row = document.createElement('div'); row.className = 'cue';
    const label = document.createElement('span'); label.textContent = `◇ ${cue.id} · ${cue.time.toFixed(2)} s → ${clip?.label ?? cue.clip}`;
    const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = 'Go to cue'; jump.onclick = () => { pause(); seek(cue.time); };
    const play = document.createElement('button'); play.type = 'button'; play.textContent = 'Audition'; play.disabled = !clip; play.onclick = () => { void audition(cue.clip); };
    row.append(label, jump, play); area.append(row);
  }
  if (!activeCues().length) area.textContent = 'No linked sound cues.';
  input('sync-audio').disabled = !data.manifest.audio.clips.length;
}

function reportEvents(): ReportEvent[] {
  const field = select('report-category').value;
  return data.report?.categories.filter(category => field === 'all' || category.field === field).flatMap(category => category.events) ?? [];
}

function initReport(): void {
  const report = data.report;
  el('report-browser').hidden = !report; el('report-unavailable').hidden = !!report;
  if (!report) { text('report-summary', 'Not supplied'); return; }
  const counts = reportCounts(report); text('report-summary', `${counts.events} events · ${counts.empty.length} explicitly empty categories`);
  const source = el<HTMLAnchorElement>('report-source-link'); source.hidden = false; source.href = assetUrl(report.path);
  const filter = select('report-category'); filter.replaceChildren(option('all', 'All events'));
  for (const category of report.categories) filter.append(option(category.field, `${category.field} · ${category.state === 'empty' ? 'none' : category.events.length}`));
  const empty = el('report-empty-categories'); empty.replaceChildren();
  for (const field of counts.empty) { const label = document.createElement('span'); label.textContent = `${field}: none`; empty.append(label); }
  el('report-missing').hidden = !counts.missing.length;
  text('report-missing', counts.missing.length ? `Fields not supplied: ${counts.missing.join(', ')} (not classified as none)` : '');
  renderReportEvents();
}

function renderReportEvents(): void {
  const events = reportEvents();
  const pages = Math.ceil(events.length / reportPageSize); reportPage = Math.max(0, Math.min(reportPage, Math.max(0, pages - 1)));
  const start = reportPage * reportPageSize, rows = events.slice(start, start + reportPageSize);
  text('report-page', rows.length ? `${start + 1}–${start + rows.length} / ${events.length}` : '0 / 0');
  button('report-previous').disabled = reportPage === 0; button('report-next').disabled = reportPage >= pages - 1;
  const list = el('report-events'); list.replaceChildren();
  for (const event of rows) {
    const row = document.createElement('li'), item = document.createElement('button'); item.type = 'button'; item.setAttribute('aria-current', String(event.id === selectedReportEvent?.id));
    const title = document.createElement('strong'); title.textContent = `${event.field} · ${eventCoordinates(event)}`;
    const targets = document.createElement('small'); targets.textContent = event.targets.length ? event.targets.map(targetLabel).join(' · ') : 'No bone/slot mapping';
    const timing = document.createElement('small'); timing.textContent = eventTimingLabel(event); if (!event.seek) timing.className = 'no-time';
    item.append(title, targets, timing); item.onclick = () => chooseReportEvent(event); row.append(item); list.append(row);
  }
  if (!rows.length) { const empty = document.createElement('li'); empty.className = 'hint'; empty.textContent = select('report-category').value === 'all' ? 'No events supplied.' : 'none · explicitly supplied empty event array'; list.append(empty); }
}

function prefillReportEvent(): void {
  if (!selectedReportEvent) return;
  const selection = eventSelection(selectedReportEvent, selectedReportTarget);
  input('feedback-start').value = selection.frames ? String(selection.frames[0]) : '';
  input('feedback-end').value = selection.frames ? String(selection.frames[1]) : '';
  select('feedback-target-kind').value = selection.target?.kind ?? '';
  input('feedback-target-name').value = selection.target?.name ?? '';
  renderFeedbackTargets(true);
  text('report-prefill-note', `${selection.frames ? 'Copied the explicit frame range.' : 'No frame data · enter the range manually.'} ${selection.target ? input('feedback-target-name').value === selection.target.name ? 'Copied a target present in the rig catalog.' : 'The report target is absent from the current rig catalog; choose a target manually.' : selection.targets.length > 1 ? 'Select one of the named targets.' : 'No bone/slot mapping · choose a target manually.'} Choose defect or quality yourself.`);
}

function chooseReportEvent(event: ReportEvent): void {
  const draft = reportDraftForMarker(selectedReportEvent?.id ?? null, event.id, { category: select('feedback-category').value, summary: input('feedback-summary').value });
  select('feedback-category').value = draft.category; input('feedback-summary').value = draft.summary;
  pause(); selectedReportEvent = event; selectedReportTime = undefined; selectedReportTarget = undefined;
  const selection = eventSelection(event);
  const times = select('report-time'); times.replaceChildren();
  for (const [index, value] of selection.exactTimes.entries()) times.append(option(String(index), `${index + 1}. ${value} s`));
  times.hidden = !selection.exactTimes.length; el('report-time-label').hidden = times.hidden;
  const targets = select('report-target'); targets.replaceChildren(option('', 'Select target'));
  for (const [index, target] of selection.targets.entries()) targets.append(option(String(index), targetLabel(target)));
  el('report-target-control').hidden = selection.targets.length <= 1;
  prefillReportEvent(); renderReportSelection(); renderReportEvents();
  if (event.seek) seekReportEvent();
}

function renderReportSelection(): void {
  const event = selectedReportEvent; el('report-selection').hidden = !event; if (!event) return;
  text('report-selection-heading', `${event.field} · ${eventCoordinates(event)}`);
  const exact = eventSeekTime(event, selectedReportTime);
  text('report-timing', event.times?.length ? `${eventTimingLabel(event)} · Preserves ${event.times.length} discrete times. Gaps are not expanded into a continuous interval.` : eventTimingLabel(event));
  button('report-seek').disabled = exact === null;
  text('report-provenance', `Source ${event.source.path}${event.source.pointer}${Object.keys(event.provenance).length ? ' · Original identifiers: ' + JSON.stringify(event.provenance) : ''}`);
  text('report-details', JSON.stringify({ source: event.source, frames: event.frames, times: event.times, timeInterval: event.timeInterval, durationSeconds: event.durationSeconds, targets: event.targets, provenance: event.provenance, details: event.details }, null, 2));
}

/**
 * The timeline-marker seek: report events and reading ticks (#108) both land here — pause, switch to the marker's
 * animation when the rig has it, refuse a time past the clip, else seek to the exact time.
 */
function seekMarker(clip: string | undefined, exact: number, what: string): boolean {
  pause();
  if (clip && player && !assets?.animations.some(item => item.name === clip)) { message(`${what} animation "${clip}" is absent from the current rig; no seek was performed.`, true); return false; }
  if (clip && assets?.animations.some(item => item.name === clip) && animation !== clip) chooseAnimation(clip);
  if (duration > 0 && exact > duration) { message(`Explicit time ${exact} s is outside the current range of ${duration} s. No substitute time was used.`, true); return false; }
  seek(exact);
  return true;
}
function seekReportEvent(): void {
  const event = selectedReportEvent; if (!event) return;
  const exact = eventSeekTime(event, selectedReportTime); if (exact === null) return;
  if (!seekMarker(data.report?.animation, exact, 'Report')) return;
  message((player || video || sequence) ? `Selected report time ${exact} s.` : `Report time ${exact} s · no playback reference; time display only.`);
}
/** A reading tick or worst line: its frame's time (frame / fps of the reading's set) in the reading's animation. */
function seekReading(clip: string, frame: number, exact: number | null, label: string): void {
  if (exact === null) { message(`${label}: F${frame} has no time (the reading's set states no fps); no seek was performed.`, true); return; }
  // The clip's last sample can sit a rounding hair past the runtime duration; that tick is the clip's end — the end of
  // the reading's clip, the one the seek switches to (#186), not the clip drawn now.
  const at = readingSeekTime(exact, clipDuration(clip));
  if (seekMarker(clip, at, 'Reading')) message(`Reading · ${label} → F${frame} · ${exact.toFixed(4)} s`);
}

function tick(now: number): void {
  if (playing) {
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0;
    const previous = time; time = Math.min(duration, time + dt);
    if (player && player.current) { try { stepEnvironment(dt); drawRig(()=>player!.frame(dt)); } catch (error) { pause(); message(errorText(error), true); } }
    if (video && video.readyState >= 1 && time > video.duration) { if (referenceInput.state !== 'out-of-domain') holdVideoReference(video, referenceGeneration); } else if (video && referenceInput.state === 'loaded' && Math.abs(video.currentTime - time) > .15) video.currentTime = time;
    if (input('sync-audio').checked) for (const cue of activeCues()) if ((previous < cue.time && cue.time <= time) || (previous === 0 && cue.time === 0 && dt > 0)) void audition(cue.clip);
    renderSequenceFrame(); renderTransport(); if(time>=duration){if(canRepeatIdle()&&!idleHeld){stopAudio();seek(0,{kind:'replay'});player?.resume();if(video)void video.play().catch(error=>{pause();message(errorText(error),true);});}else pause();} lastFrame = now;
  }
  requestAnimationFrame(tick);
}

function configureTurnPad(model:unknown):void {
 const previous=turnPad?.snapshot();turnPad?.dispose();turnPad=null;turnAdjust=null;document.getElementById('turn-pad-host')?.remove();
 const dials=discoverTurnDials(model,assets?.animations);if(!dials.length){setAdjust();workspace?.refresh();return;}
 const host=document.createElement('div');host.id='turn-pad-host';el('stage-layout').before(host);
 turnPad=bindTurnPad({host,stages:[el('rig-viewport')],dials,blocked:()=>!!persistence?.restoring()||!!document.querySelector('dialog[open]')||!!rebuildBusy,
  draw:state=>{if(!player)return;turnAdjust=state.adjust();setAdjust();if(playing)drawRig(()=>player!.draw());},save:()=>persistence?.save(),error:value=>message(value,true)});
 if(previous&&turnPad){try{turnPad.restore(previous);}catch{message('TURN_STATE_MODEL_MISMATCH: turn values reset for this build.',true);}}
 workspace?.refresh();
}
async function initPlayer(initialCheckpoint?:Checkpoint): Promise<void> {
  text('renderer-state',rendererStatus(null,'pending').label);
  if (!data.manifest.model) { text('player-state', 'No rig supplied · reference review is available'); return; }
  text('player-state', 'Loading compiled rig…');
  try {
    const modelUrl = new URL(assetUrl(data.manifest.model), location.href).href;
    inspectedModel={url:modelUrl,prefix:access.route('/assets/'),sha256:data.reviewedSource.rig?.sha256??''};stageModelHash=inspectedModel.sha256||null;
    assets = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, url) => {
      const target = new URL(name, url); if (target.origin !== location.origin || !target.pathname.startsWith(access.route('/assets/'))) throw new Error(`Model page escapes local package: ${name}`); return target.href;
    } });
    player = new RigPlayer(el('rig-root'), assets);
    // Parts inspection is an add-on: a catalog refusal is shown in the explorer and never aborts the rig.
    try{const catalog=await loadPartModel(modelUrl,data.reviewedSource.rig!.sha256,data.feedbackCatalog.slots??[]);inspectionSourceState='ready';partModel=catalog.model;configureTurnPad(catalog.model);refreshAnimationInspection();weightsView?.refresh();parts?.register('single',catalog.entries,player,new PartThumbnails(pageRegionTable(catalog.model),assets.pageImages));}catch(error){inspectionSourceState='failed';partModel=null;refreshAnimationInspection();parts?.refuseCatalog('single',error);}
    player.on('event', event => { text('event-log', `Runtime event: ${event.name} · ${event.time.toFixed(2)} s`); });
    const animations = select('animation-select'); animations.replaceChildren();
    for (const item of assets.animations) animations.append(option(item.name, data.manifest.animations.find(a => a.id === item.name)?.label ?? item.name));
    animations.disabled = assets.animations.length === 0;
    const names=assets.animations.map(clip=>clip.name),initial=initialIdleAnimation(names,initialPlayerAnimation(names,data.initialAnimation??undefined,initialCheckpoint),!!data.initialAnimation||!!initialCheckpoint?.animation||!!initialCheckpoint?.axis);
    if(initial)chooseAnimation(initial);else drawRig(()=>player!.draw());
    el('rig-empty').hidden = true; text('player-state', '@rig-c/play · Actual rig');
    const presets = player.sets(); if (presets.length) { select('part-set').replaceChildren(option('', 'Original set')); for (const set of presets) select('part-set').append(option(set.name, set.name)); select('part-set').disabled = false; }
    const validAxes = data.manifest.axes.filter(axis => assets?.animations.some(item => item.name === axis.animation));
    text('axis-state', validAxes.length ? `${validAxes.length} axes` : 'No inspection axes supplied');
    select('axis-select').replaceChildren(); for (const axis of validAxes) select('axis-select').append(option(axis.id, axis.label));
    input('axis-value').disabled = !validAxes.length;
    for(const id of ['layer-images','layer-mesh','layer-bones'])input(id).disabled=false;
    enableEnvironment(modelUrl);
    describeLayerToggles(document,el('layer-state').textContent??'');
    fitCamera();
  } catch (error) { turnPad?.dispose();turnPad=null;document.getElementById('turn-pad-host')?.remove();text('renderer-state',rendererStatus(null,'failed').label);player?.dispose(); player = null; assets?.dispose(); assets = null; text('player-state', 'Rig load failed'); text('rig-empty', `Could not open rig: ${errorText(error)}`); message(errorText(error), true); }
}

function chooseAxis(): void {
  const axis = data.manifest.axes.find(item => item.id === select('axis-select').value);
  const clip = assets?.animations.find(item => item.name === axis?.animation); if (!axis || !clip || !player) return;
  pause(); chooseAnimation(clip.name); axisInspection = true; el('angle-panel').hidden = false;
  input('axis-value').min = String(axis.min); input('axis-value').max = String(axis.max); input('axis-value').step = String((axis.max - axis.min) / 200); input('axis-value').value = String((axis.max + axis.min) / 2); text('axis-label', axis.label); applyAxis();
}

function applyAxis(): void {
  const axis = data.manifest.axes.find(item => item.id === select('axis-select').value);
  if (!axis || !player) return;
  const value = Number(input('axis-value').value); text('axis-value-label', value.toFixed(3)); seek((value - axis.min) / (axis.max - axis.min) * duration);
}

function renderProposals(): void {
  comments?.refresh();
  const area = el('proposal-list'); area.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  const unchecked = session.feedback.map(f => appliedCheckRefusal((f.context as Record<string, unknown> | undefined)?.applied)).find(Boolean) ?? null;
  el('feedback-applied-check').hidden = !unchecked; text('feedback-applied-check', unchecked ? `${unchecked} · Submit refuses this review; delete the entry written on that build or Apply a build that passes check.` : '');
  warnings.textContent = session.feedbackWarnings.length ? `${session.feedbackWarnings.length} validation warnings in existing feedback · original records are preserved. Review the marked entries, delete them and add valid replacements before submitting. The saved session that rig-review feedback exports keeps both the original records and warnings.` : '';
  for (const feedback of session.feedback) {
    const item = document.createElement('div'); item.className = 'proposal-item'; const title = document.createElement('strong'); title.textContent = `${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · ${feedbackTimingLabel(feedback)}`; const description = document.createElement('span'); description.textContent = feedback.summary;
    item.append(title, description);
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `Validation warning · ${warning.error}`; item.append(note); }
    const details = document.createElement('details'), summary = document.createElement('summary'), source = document.createElement('pre'); summary.textContent = 'Saved feedback and inspection context'; source.textContent = JSON.stringify(feedback, null, 2); details.append(summary, source);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.onclick = () => { session.feedback = session.feedback.filter(item => item.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); markDirty(); renderProposals(); };
    item.append(details);if((feedback.context as any)?.comment?.schema!=='rig-review-comment/1'||!submittedBaseline?.feedback.some(f=>f.id===feedback.id))item.append(remove); area.append(item);
  }
  updateSavedState();
}

function propose(tool: string): void {
  if (tool === 'angle' && !input('axis-value').disabled) { showInspector('playback');chooseAxis(); return; }
  const choices: Record<string, { target: Feedback['target']['kind']; hint: string }> = {
    mesh: { target: 'slot', hint: 'One-line feedback on mesh density' }, contour: { target: 'slot', hint: 'One-line feedback on contour curvature' }, chest: { target: 'rig', hint: 'One-line feedback on chest position' },
    angle: { target: 'rig', hint: 'One-line feedback on face or torso angle deformation' }, pose: { target: 'bone', hint: 'One-line feedback on differences from the input pose' }, timing: { target: 'rig', hint: 'One-line feedback on timing in the selected range' }, audio: { target: 'rig', hint: 'One-line feedback on event or audio links' },
  };
  const choice = choices[tool]; if (!choice) return;
  select('feedback-target-kind').value = choice.target; input('feedback-target-name').value = choice.target === 'rig' ? data.manifest.id : ''; input('feedback-summary').placeholder = choice.hint;
  renderFeedbackTargets();
  showInspector('feedback');input('feedback-summary').focus(); message('Specify a frame range and actual bone or slot name to add feedback. Motion keys are not edited.');
}


function download(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadStrip(name: string, content: Blob): void {
  const url = URL.createObjectURL(content), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stripStatus(value: string, error = false): void { text('strip-status', value); el('strip-status').setAttribute('role', error ? 'alert' : 'status'); }

function updateStripControls(): void {
  el('strip-panel').setAttribute('aria-busy', String(stripBusy));
  for (const id of ['strip-scope', 'strip-reference', 'strip-format']) select(id).disabled = stripBusy;
  button('strip-export').disabled = stripBusy || !!readOnly; button('strip-export').title = readOnly ?? ''; button('strip-export').textContent = stripBusy ? 'Generating strip…' : 'Download strip';
}

async function exportStrip(): Promise<void> {
  if (stripBusy) return;
  stripStatus('Checking the selected range…');
  try {
    const format = select('strip-format').value, selectedAnimation = feedbackAnimation();
    if (format !== 'png' && format !== 'json') throw new Error('Select PNG or JSON.');
    if (!selectedAnimation) throw new Error('Explicitly select an animation to export.');
    const intervals: StripInterval[] = [];
    if (select('strip-scope').value === 'feedback') {
      if (!session.feedback.length) throw new Error('No feedback ranges to export.');
      for (const feedback of session.feedback) {
        const context = feedback.context;
        if (!context || typeof context !== 'object' || Array.isArray(context) || context.animation !== selectedAnimation) throw new Error(`Feedback ${feedback.id}: Its animation is missing or differs from the selected animation. Batch export supports ranges from the same animation only.`);
        intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: 'single', ...requireFeedbackFrames(feedback) });
      }
    } else {
      const start = input('feedback-start').value.trim(), end = input('feedback-end').value.trim();
      if (!start || !end) throw new Error('Enter the strip start and end frames in the feedback form.');
      intervals.push({ id: 'selection', basis: 'single', frameStart: Number(start), frameEnd: Number(end) });
    }
    for (const interval of intervals) if (!Number.isSafeInteger(interval.frameStart) || !Number.isSafeInteger(interval.frameEnd) || interval.frameStart < 0 || interval.frameEnd < interval.frameStart) throw new Error(`${interval.id}: Specify an inclusive range of nonnegative integer frames.`);
    const referenceId = select('strip-reference').value;
    const request: StripRequest = { format, sourceHash: data.sourceHash, animation: selectedAnimation, ...(referenceId ? { referenceId } : {}), intervals };
    stripBusy = true; updateStripControls(); stripStatus(`${selectedAnimation} · ${intervals.length} ranges · Generating ${format.toUpperCase()}…`);
    const response = await fetch(access.route('/api/strip'), { method: 'POST', headers: access.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(request) });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw new Error(failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : `Strip export failed · HTTP ${response.status}`);
    }
    const mime = format === 'png' ? 'image/png' : 'application/json';
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(mime)) throw new Error('The strip response format does not match the request.');
    downloadStrip(`review-strip.${format}`, await response.blob()); stripStatus(`${selectedAnimation} · ${intervals.length} ranges · Requested ${format.toUpperCase()} download. Review status was not changed.`);
  } catch (error) { stripStatus(errorText(error), true); }
  finally { stripBusy = false; updateStripControls(); }
}


function paneFrame(target:CameraTarget,hidden=false):CameraFrame|null {
 const viewport=el(target+'-viewport'),pane=el(target+'-pane');
 const box=target==='rig'?assets?.stage??player?.bounds():referenceSize?{x:0,y:0,...referenceSize}:null;
 if(!box||target==='rig'&&!player){delete cameraFrames[target];return null;}
 if(pane.hidden||viewport.clientWidth<=0||viewport.clientHeight<=0)return hidden?cameraFrames[target]??null:null;
 const frame=cameraFrame(target==='rig'?'world':'image',box,viewport.clientWidth,viewport.clientHeight,target==='rig'?28:24,target==='rig'?58:56);
 if(frame)cameraFrames[target]=frame;return frame;
}
function paneCamera(target:CameraTarget){return target==='rig'?{zoom,center:cameraCenter}:{zoom:referenceZoom,center:referenceCenter};}
function writeCamera(target:CameraTarget,value:ReturnType<typeof cameraFromSignature>):void {if(target==='rig'){zoom=value.zoom;cameraCenter=value.center;}else{referenceZoom=value.zoom;referenceCenter=value.center;}}
function activateCamera(target:CameraTarget):void {if(paneFrame(target)){activeCamera=target;renderCameraControls();}}
function availableCamera():CameraTarget|null {return paneFrame(activeCamera)?activeCamera:paneFrame('rig')?'rig':paneFrame('reference')?'reference':null;}
function alignCameras():void {
 const target=availableCamera();if(!target)return;
 const frame=paneFrame(target)!;assertCameraView(paneCamera(target),frame);const signature=cameraSignature(paneCamera(target),frame);
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={};
 for(const other of ['rig','reference'] as const){if(other===target)continue;const next=paneFrame(other);if(next)updates[other]=cameraFromSignature(signature,next);}
 for(const other of ['rig','reference'] as const){const update=updates[other];if(update)writeCamera(other,update);}activeCamera=target;
}
function renderCameraControls():void {input('camera-sync').checked=cameraSync;const target=availableCamera();text('zoom-value',`${Math.round((target?paneCamera(target).zoom:1)*100)}% · ${target==='reference'?'Reference':'Rig'}`);button('fit').textContent=cameraSync?'Fit views':'Fit active';text('coordinates',cameraSync?'Cameras synchronized · drag to pan · scroll to zoom':'Independent cameras · drag to pan · scroll to zoom');}
function setCameraSync(value:boolean):void {if(value)alignCameras();cameraSync=value;fitCamera();renderCameraControls();}
function cameraAction(action:()=>void):void {try{action();}catch(error){renderCameraControls();message(errorText(error),true);}}
function updateCamera(target:CameraTarget,value:CameraSignature):void {
 const frame=paneFrame(target);if(!frame)return;
 const updates:Partial<Record<CameraTarget,ReturnType<typeof cameraFromSignature>>>={[target]:cameraFromSignature(value,frame)};
 if(cameraSync)for(const other of ['rig','reference'] as const){if(other===target)continue;const next=paneFrame(other);if(next)updates[other]=cameraFromSignature(value,next);}
 for(const other of ['rig','reference'] as const){const update=updates[other];if(update)writeCamera(other,update);}activeCamera=target;
 fitCamera();renderCameraControls();
}
function zoomCamera(factor:number,target=availableCamera()):void {if(!target)return;const frame=paneFrame(target);if(frame)updateCamera(target,zoomSignature(cameraSignature(paneCamera(target),frame),factor));}
function panCamera(target:CameraTarget,dx:number,dy:number):void {const frame=paneFrame(target);if(frame)updateCamera(target,dragSignature(cameraSignature(paneCamera(target),frame),frame,dx,dy));}
function fitActiveCamera(target=availableCamera()):void {if(!target)return;const part=parts?.value();if(target==='rig'&&part){const box=parts?.bounds(),frame=paneFrame(target);if(!box||!frame){message('PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',true);return;}updateCamera(target,boundsFitSignature(box,frame,28,58));message('Selected slot fitted.');}else{if(!paneFrame(target))return;updateCamera(target,{zoom:1,pan:{x:0,y:0}});message('View fitted.');}}
function zoomViewport(target:CameraTarget,deltaY:number):void {zoomCamera(deltaY<0?1.1:1/1.1,target);}

function bind(): void {
  button('strip-export').onclick = () => { void exportStrip(); };
  button('chest-export').onclick = () => { void exportChest(); };
  for (const event of ['input', 'change']) el('chest-regions').addEventListener(event, renderChest);
  // A discarded local draft restores the form after its button's own handler; re-read the tool then.
  el('draft-recovery').addEventListener('click', () => { renderChest(); restoreEnvironment(); physicsPanel?.restore(); bonesPanel?.restore(); cutsPanel?.restore(); clothPanel?.restore(); idlePanel?.restore(); rigFieldsPanel?.restore(); });
  for (const id of ['strip-scope', 'strip-reference', 'strip-format']) select(id).onchange = () => stripStatus('Selection changed. Check the ranges, animation and reference video before downloading.');
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) item.onclick = () => {setView(item.dataset.view as typeof view);const menu=document.getElementById('view-menu') as HTMLDetailsElement|null;if(menu)menu.open=false;};
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-proposal]')) item.onclick = () => propose(item.dataset.proposal ?? '');
  select('reference-select').onchange = () => { void showReference(select('reference-select').value); };
  select('person-select').onchange = () => { selectedPerson = select('person-select').value; lastPoseFrame = -1; renderSequenceFrame(); };
  select('animation-select').onchange = () => {chooseAnimation(select('animation-select').value);if(canRepeatIdle())void playPreview();};
  select('part-set').onchange = () => { try { if(!player)return;player.setSet(select('part-set').value || null);drawRig(()=>player!.draw());fitCamera(); } catch (error) {text('renderer-state',rendererStatus(null,'failed').label); message(errorText(error), true); } };
  select('axis-select').onchange = chooseAxis; input('axis-value').oninput = applyAxis;
  button('zoom-in').onclick=()=>cameraAction(()=>zoomCamera(1.25));button('zoom-out').onclick=()=>cameraAction(()=>zoomCamera(1/1.25));button('fit').onclick=()=>cameraAction(()=>fitActiveCamera());
  input('camera-sync').onchange=()=>cameraAction(()=>setCameraSync(input('camera-sync').checked));
  for(const target of ['rig','reference'] as const)for(const event of ['pointerdown','focusin'] as const)el(target+'-viewport').addEventListener(event,()=>activateCamera(target));
  for (const id of ['reference-viewport', 'rig-viewport']) el(id).addEventListener('wheel', event => { event.preventDefault(); cameraAction(()=>zoomViewport(id==='rig-viewport'?'rig':'reference',event.deltaY)); }, { passive: false });
  input('scrub').oninput = () => { pause(); seek(Number(input('scrub').value)); };
  input('frame-number').onfocus = pause;
  input('frame-number').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); const value = input('frame-number').value.trim(); seekFrame(value ? Number(value) : NaN); } };
  button('frame-jump').onclick = () => { const value = input('frame-number').value.trim(); seekFrame(value ? Number(value) : NaN); };
  input('frame-scrub').oninput = () => seekFrame(Number(input('frame-scrub').value));
  button('play').onclick = () => {
    if (playing) { pause(); return; }
    void playPreview();
  };
  input('audio-volume').oninput = () => { text('audio-volume-label', `${Math.round(Number(input('audio-volume').value) * 100)}%`); for (const audio of audioPlaying) audio.volume = Number(input('audio-volume').value); };
  input('sync-audio').onchange = () => { if (!input('sync-audio').checked) stopAudio(); };
  select('report-category').onchange = () => { reportPage = 0; renderReportEvents(); };
  button('report-previous').onclick = () => { reportPage--; renderReportEvents(); };
  button('report-next').onclick = () => { reportPage++; renderReportEvents(); };
  button('report-seek').onclick = seekReportEvent;
  select('report-time').onchange = () => { selectedReportTime = Number(select('report-time').value); renderReportSelection(); seekReportEvent(); };
  select('report-target').onchange = () => { const value = select('report-target').value; selectedReportTarget = value ? Number(value) : undefined; prefillReportEvent(); };
  select('review-status').onchange = () => { session.status = select('review-status').value as ReviewSession['status']; markDirty(); };
  el<HTMLTextAreaElement>('checkpoint-note').oninput = () => { const entry = checkpointEntry(); if (entry) { entry.note = el<HTMLTextAreaElement>('checkpoint-note').value; markDirty(); } };
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="outcome"]')) radio.onchange = () => { const entry = checkpointEntry(); if (entry) { entry.outcome = radio.value as typeof entry.outcome; markDirty(); renderCheckpoints(); } };
  select('feedback-target-kind').onchange = () => renderFeedbackTargets();
  button('add-proposal').onclick = () => {
    const start = input('feedback-start').value.trim(), end = input('feedback-end').value.trim(), frameStart = Number(start), frameEnd = Number(end);
    const name = input('feedback-target-name').value.trim(), summary = input('feedback-summary').value.trim();
    if (!start || !end || !Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd) || frameStart < 0 || frameEnd < frameStart) { message('Enter nonnegative integer start and end frames, with the end at or after the start.', true); return; }
    if (!['bone', 'slot', 'rig'].includes(select('feedback-target-kind').value) || !['defect', 'quality'].includes(select('feedback-category').value)) { message('Select a target type and defect or quality category.', true); return; }
    if (!name || !summary || /[\r\n]/.test(summary) || summary.length > 1000) { message('Enter the actual target name and a one-line summary of up to 1,000 characters.', true); return; }
    const target: Feedback['target'] = { kind: select('feedback-target-kind').value as Feedback['target']['kind'], name };
    const selectedAnimation = feedbackAnimation();
    try { validateFeedbackSelection(data.feedbackCatalog, { frameStart, frameEnd, target, animation: selectedAnimation }); } catch (error) { message(errorText(error), true); return; }
    const box = assets?.stage ?? player?.bounds();
    const center = cameraCenter ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
    session.feedback.push({ id: crypto.randomUUID(), frameStart, frameEnd, target, category: select('feedback-category').value as Feedback['category'], summary, context: {...(turnPad?{turn:JSON.parse(JSON.stringify(turnPad.snapshot())) as Json}:{}),part:parts?.feedback()??null,
      interval: { frameStart, frameEnd, inclusive: true },
      checkpoint: checkpoint?.id ?? null, animation: selectedAnimation, time, frame: frameAtTime(activeFrameClock(), time),
      reference: select('reference-select').value || null, person: selectedPerson || null,
      sourceTime: sequence ? sequence.frames[0]!.t + time : time,
      camera: center ? { zoom, x: center.x, y: center.y, coordinateSystem: 'world-y-up' } : { zoom, coordinateSystem: 'reference-fit' },
      view:{...serializableView(numericView()),theme:appearance?.get()??'system',layers:{...layers}},
      axis: axisInspection ? { id: select('axis-select').value, value: Number(input('axis-value').value) } : null,
      environment: feedbackEnvironment(),
      // The exported schedule (#112): the drawn clip's rigc-environment/1 bytes and their sha256, and whether readings and Apply read them.
      environmentSchedule: feedbackSchedule() as unknown as Json,
      // The exact last applied designation and the producer's line, only while that scratch build is what is drawn.
      applied: appliedOnStage ? JSON.parse(JSON.stringify(appliedOnStage)) as Json : null,
      // The readings chosen (#108): the pairs of the last finished run and the builds they ran on, not their results.
      readings: readingsContext() as unknown as Json,
      // The declared requirements (#113): the file by hash and content, and its last check, or null when none are declared.
      requirements: (requirementsPanel?.context() ?? null) as unknown as Json,
      reportEvent: selectedReportEvent ? { id: selectedReportEvent.id, field: selectedReportEvent.field, source: { ...selectedReportEvent.source }, frames: selectedReportEvent.frames ? [...selectedReportEvent.frames] : null, exactTime: eventSeekTime(selectedReportEvent, selectedReportTime), targets: selectedReportEvent.targets.map(target => ({ ...target })) } : null,
    } });
    input('feedback-summary').value = ''; markDirty(); renderProposals(); message('Added structured feedback. Submit the review to save it.');
  };
  button('save').onclick = async () => {
    if(readOnly){message(readOnly,true);return;}
    if(draftConflict){message('Resolve the saved local draft conflict before submitting.',true);return;}
    if (session.feedbackWarnings.length) { message('Resolve validation warnings in existing feedback before submitting. Delete the marked entries and add valid replacements.', true); return; }
    saving = true; updateSavedState(); const savedPayload = JSON.stringify(session);
    try { const saved = await api<ReviewSession>('/api/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: savedPayload });
      if (JSON.stringify(session) === savedPayload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt;
      submittedBaseline=structuredClone(saved);comments?.refresh();await persistence?.submitted(saved);renderProvenance();renderProposals();
      message(dirty ? 'Changes were made during submission. Submit again.' : 'Submitted the selected review status, feedback and source provenance.');
    } catch (error) { message(`Submission failed: ${errorText(error)}`, true); } finally { saving = false; updateSavedState(); }
  };
  // Saved browser defaults seed a new inspection; explicit links and source drafts restore over them.
  workspace=bindWorkspaceUI({changed:fitCamera,defaultTheme:theme=>appearance?.set(theme),currentTheme:()=>appearance?.get()});
  cameraSync=workspace.defaults().defaultCameraSync;input('camera-sync').checked=cameraSync;input('idle-repeat').checked=workspace.defaults().defaultIdleRepeat;
  appearance=bindAppearance(select('settings-theme'),workspace.defaults().theme);
  inspectorBlocks=bindInspectorBlocks({sections:[el('inspector-rig'),el('inspector-playback')],changed:()=>persistence?.save()});
  overlays=new RigOverlays({canvas:el<HTMLCanvasElement>('rig-overlay'),rigRoot:el('rig-root')});
  chestEditor=bindChestEditor({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>chestMapping,changed:renderChest,download:()=>{void exportChest();},apply:()=>{void applyRebuild();},reset:()=>{void resetRebuild();},message,inspector:()=>selectedInspector()});viewDisposers.push(()=>chestEditor?.dispose());
  meshEditor=bindMeshEditor({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>chestMapping,inspector:()=>selectedInspector(),source:meshSource,pause,changed:()=>redrawOverlay(false),download:doc=>{void exportMesh(doc);},apply:(doc,line)=>applyMeshDelta(doc,line),applied:()=>appliedOnStage?.schema==='rig-review-applied/3',resetBuild:()=>resetRebuild(stageWorld()),message,confirm:text=>window.confirm(text),token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});viewDisposers.push(()=>meshEditor?.dispose());
  weightsView=bindWeightsView({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,inspector:()=>selectedInspector(),slot:()=>parts?.value()?.slot??null,
   model:()=>data.manifest.model?partModel??undefined:null,setup:slot=>assets?setupPoseMesh(assets,partModel,slot,document.createElement('div')):null,changed:()=>redrawOverlay(false),
   token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});
  viewDisposers.push(()=>weightsView?.dispose());weightsView.refresh();
  bonesPanel=bindBonesPanel({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>chestMapping,inspector:()=>selectedInspector(),pause,changed:()=>redrawOverlay(false),saved:()=>persistence?.save(),
   check:checkBones,apply:async ops=>{await applyBones(ops);},reset:resetBonesBuild,token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});
  viewDisposers.push(()=>bonesPanel?.dispose());
  // #115: cuts, patches and limb joints on the stage; Apply runs rig-parts build through the patch runner.
  cutsPanel=bindCutsPanel({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>chestMapping,inspector:()=>selectedInspector(),pause,changed:()=>redrawOverlay(false),saved:()=>persistence?.save(),
   apply:applyCuts,reset:resetCutsBuild,token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim(),route:path=>access.route(path)});
  viewDisposers.push(()=>cutsPanel?.dispose());
  // #111: the cloth recipe per tag; Apply runs rig-parts propose --cloth --write-config, then builds what it wrote.
  clothPanel=bindClothPanel({project:()=>player?rigProject():null,mapping:()=>chestMapping,inspector:()=>selectedInspector(),pause,changed:()=>redrawOverlay(false),saved:()=>persistence?.save(),
   apply:applyCloth,reset:resetClothBuild,token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});
  viewDisposers.push(()=>clothPanel?.dispose());
  physicsPanel=bindPhysicsPanel({preview:edits=>{const before=JSON.stringify(physicsPreview.read()),next=physicsPreview.sync(player,edits);if(player?.current&&!playing&&before!==JSON.stringify(next)){player.repose();drawRig(()=>player!.draw());}return physicsPreview.read();},previewRead:()=>physicsPreview.read(),apply:async ops=>{await applyPhysics(ops);},reset:resetPhysicsBuild,pane:el('rig-pane'),saved:()=>persistence?.save(),
   bonePoints:bones=>{if(!player)return null;const project=rigProject(),pane=el('rig-pane').getBoundingClientRect(),view=el('rig-root').parentElement!.getBoundingClientRect(),out=new Map<string,{x:number;y:number}>();for(const name of bones){try{const b=player.bone(name),p=project(b.x,b.y);out.set(name,{x:p.x+view.left-pane.left,y:p.y+view.top-pane.top});}catch{/* a bone this model lacks is not pickable */}}return out;}});
  viewDisposers.push(()=>physicsPanel?.dispose());
  meshPanel=bindMeshPanel({pane:el('rig-pane'),project:()=>player?rigProject():null,mapping:()=>chestMapping,bones:()=>data.feedbackCatalog.bones??[],
   apply:async(part,entry)=>{await applyMesh(part,entry);},reset:resetMeshBuild,folds:async()=>{await meshFolds();},changed:()=>{redrawOverlay(false);densityStrip?.changed();},saved:()=>persistence?.save(),
   token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});
  viewDisposers.push(()=>meshPanel?.dispose());
  // #173: the density strip beside the Mesh panel's density field.
  densityStrip=bindDensityStrip({part:()=>meshPanel?.part()??null,entry:()=>meshPanel?.entry()??null,build:async values=>{await buildDensityStrip(values);},load:async i=>{await loadStripRow(i);},back:async()=>{await stripBack();},close:async()=>{await closeDensityStrip();}});
  idlePanel=bindIdlePanel({apply:async(ops,keys)=>{await applyIdle(ops,keys);},reset:resetIdleBuild,pane:el('rig-pane'),saved:()=>persistence?.save(),
   preview:fn=>{idleAdjust=fn;setAdjust();},
   bonePoints:bones=>{if(!player)return null;const project=rigProject(),out=new Map<string,{x:number;y:number}>();for(const name of bones){try{const b=player.bone(name);out.set(name,project(b.x,b.y));}catch{/* a bone this model lacks has no handle */}}return out;}});
  viewDisposers.push(()=>idlePanel?.dispose());
  rigFieldsPanel=bindRigFieldsPanel({apply:async ops=>{await applyRigFields(ops);},reset:resetRigFieldsBuild,reading:async(bone,relative)=>{await runReadings({readings:[{kind:'angle-range',bone,relative}]});},
   part:()=>parts?.value()?.slot??null,inspector:()=>selectedInspector(),pause,saved:()=>persistence?.save(),
   toPane:(x,y)=>{if(!player||!chestMapping.available)return null;const w=chestMapping.toWorld(x,y);return rigProject()(w.x,w.y);},
   toRig:(x,y)=>player&&chestMapping.available?canvasToCrop(rigProject(),chestMapping.toWorld,{x,y}):null,
   slotBox:slot=>{const frame=player?.posedFrame();if(!frame)return null;try{const b=partBounds(frame,slot);if(!b)return null;const project=rigProject(),a=project(b.x,b.y),c=project(b.x+b.width,b.y+b.height);return {left:Math.min(a.x,c.x),right:Math.max(a.x,c.x),top:Math.min(a.y,c.y),bottom:Math.max(a.y,c.y)};}catch{return null;}},
   dial:fn=>{dialAdjust=fn as BoneAdjust|null;setAdjust();},
   hasTurn:()=>{if(!player)return false;try{player.bone(TURN_BONE);return true;}catch{return false;}}});
  viewDisposers.push(()=>rigFieldsPanel?.dispose());
  readingsPanel=bindReadingsPanel({run:()=>{void runReadings();},seek:seekReading});
  retargetPanel=bindRetargetPanel({apply:body=>applyRetarget(body),reset:()=>{void resetRebuild(stageWorld());},seek:seekReading});
  requirementsPanel=bindRequirementsPanel({check:runRequirements,seek:seekReading,animation:()=>animation,slot:()=>parts?.value()?.slot??null,hash:sha256Hex});
  const tickResize=new ResizeObserver(()=>renderReadingTicks());tickResize.observe(el('transport'));viewDisposers.push(()=>tickResize.disconnect());
  viewDisposers.push(bindStageLayout(el('stage-layout'),fitCamera));
  for(const target of ['rig','reference'] as const)viewDisposers.push(bindPan(el(target+'-viewport'),(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy)),()=>!comments?.active()));
  for(const [id,key] of [['layer-images','images'],['layer-mesh','mesh'],['layer-bones','bones']] as const)input(id).onchange=()=>{layers[key]=input(id).checked;redrawOverlay(false);};
  viewDisposers.push(bindLayerShortcuts(document));describeLayerToggles(document,el('layer-state').textContent??'');
  input('idle-repeat').onchange=()=>{renderIdle();if(canRepeatIdle())void playPreview();};
  bindEnvironment();
  for(const id of ['proposal-panel','checkpoint-detail'])el(id).addEventListener('focusin',pause);
  bindInspector();bindReviewDialog();
  document.addEventListener('visibilitychange',()=>{if(document.hidden){const resume=playing;pause();suspendedPreview=resume;}else if(suspendedPreview){suspendedPreview=false;void playPreview();}});
  const resize = new ResizeObserver(fitCamera); resize.observe(el('rig-viewport')); resize.observe(el('reference-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { comments?.dispose();persistence?.dispose();turnPad?.dispose();workspace?.dispose();pause();controlDispose?.();appearance?.dispose();viewDisposers.forEach(dispose=>dispose());overlays?.dispose(); player?.dispose(); assets?.dispose(); resize.disconnect(); });
}

async function start(): Promise<void> {
  try {
    let writes: { capabilityRequired: boolean; control?: boolean };
    [data, session, writes] = await Promise.all([api<ReviewResponse>('/api/review'), api<ReviewSession>('/api/session'), api<{ capabilityRequired: boolean; control?: boolean }>('/api/access')]);
    readOnly = readOnlyReason(access, writes.capabilityRequired);
    submittedBaseline=structuredClone(session);
    text('package-title', data.manifest.title); text('revision', data.manifest.revision); document.title = `${data.manifest.title} · rig review`; text('source-hash', `source ${data.sourceHash.slice(0, 12)}`); select('review-status').value = session.status; select('feedback-target-kind').value = 'rig'; input('feedback-target-name').value = data.manifest.id;
    select('reference-select').replaceChildren(); for (const reference of data.manifest.references) select('reference-select').append(option(reference.id, `${reference.label} · ${reference.type}`));
    for (const reference of data.manifest.references.filter(item => item.type === 'video')) select('strip-reference').append(option(reference.id, reference.label));
    if (!data.manifest.references.length) { select('reference-select').append(option('', 'No references supplied')); select('reference-select').disabled = true; }
    // Checkpoints and reference fold away when the package supplies neither.
    (el('package-context') as HTMLDetailsElement).open = data.manifest.checkpoints.length > 0 || data.manifest.references.length > 0;
    const sourceFiles = el('source-files'); for (const file of data.manifest.authoring) { const a = document.createElement('a'); a.href = assetUrl(file.path); a.textContent = file.label; a.className = 'source-link'; a.target = '_blank'; a.rel = 'noopener'; sourceFiles.append(a); } if (!data.manifest.authoring.length) sourceFiles.textContent = 'No source files supplied';
    populateChestBones(); bind(); parts=new PartExplorer(el('workspace-left'),el('selected-part'),previous=>{if(player&&inspectionSourceState==='ready')animationPanel?.capture(player,parts?.frame('single'));else animationPanel?.capture(null,undefined);weightsView?.refresh();redrawOverlay(true);meshEditor?.selectionChanged();const part=parts?.value();animationPanel?.fromParts(part?.slot??null);meshPanel?.select(part?.slot??null);requirementsPanel?.selectionChanged();if(part){activeCamera='rig';if(view==='reference')setView('rig');if(selectedInspector(document)!=='playback')showInspector('rig');renderCameraControls();}if(!cameraRestoring&&(previous?.side!==part?.side||previous?.slot!==part?.slot))cameraAction(()=>fitActiveCamera(part?'rig':availableCamera()));persistence?.save();},part=>{select('feedback-target-kind').value='slot';renderFeedbackTargets(true);input('feedback-target-name').value=part.slot;showInspector('feedback');}); animationPanel=new AnimationInspectionPanel({host:el('animation-inspection'),stage:el('rig-viewport'),project:(x,y)=>rigProject()(x,y),enabled:()=>inspectionSourceState==='ready'&&selectedInspector(document)==='playback',seek:exact=>{if(!Number.isFinite(exact)||exact<0||exact>duration){message('KEY_TIME_OUT_OF_DOMAIN: no substitute time was used.',true);return;}seekMarker(animation,exact,'Stored key');},select:value=>{const slot=value?.kind==='slot'?value.name:null;if((parts?.value()?.slot??null)!==slot)parts?.select(slot?{side:'single',slot,mode:parts?.value()?.mode??'context'}:null);parts?.highlightBone(value?.kind==='bone'?value.name:null);redrawOverlay(false);}});viewDisposers.push(()=>animationPanel?.dispose()); updateStripControls(); stripStatus('Choose the entered start–end frames or all feedback ranges to download. Unsubmitted feedback is included; exporting does not submit the review.'); renderFeedbackTargets(true); renderFeedbackRange(); renderCheckpoints(); renderProposals(); renderProvenance(); updateSavedState(); renderCues(); initReport();
    const requestedId = new URLSearchParams(location.search).get('checkpoint'),initial=initialReviewSelection(data.manifest,requestedId,data.explicitReference?.id,data.initialAnimation??undefined),first=initial.checkpoint;
    rigInput=data.manifest.model?{state:'pending'}:{state:'absent'};renderLayout();
    if(initial.referenceId){select('reference-select').value=initial.referenceId;await showReference(initial.referenceId);}
    await initPlayer(first);
    // initPlayer keeps `player` only after its first draw succeeded; a declared model path alone never counts.
    updateChestMapping();
    rigInput=player?{state:'loaded'}:data.manifest.model?{state:'failed',reason:el('rig-empty').textContent||'compiled player unavailable'}:{state:'absent'};renderLayout();
    if (first) await chooseCheckpoint(first,initial); else renderCheckpoint();
    activeCamera=player?'rig':'reference';if(cameraSync)alignCameras();renderTransport();fitCamera();
    if (requestedId && !first) message(`Checkpoint "${requestedId}" is not in this package. Select one from the list.`, true);
    else if (readOnly) message(readOnly, true);
    else message(data.manifest.model ? 'Record review status and structured feedback while preserving sources. Motion is read only.' : 'No rig supplied. Review the available references and checkpoints.');
    requestAnimationFrame(tick);
    const restored=await setupPersistence();setupComments();await loadRebuildStatus();void loadRequirements();renderChest();restoreEnvironment();physicsPanel?.restore();bonesPanel?.restore();cutsPanel?.restore();clothPanel?.restore();idlePanel?.restore();rigFieldsPanel?.restore();meshPanel?.restore();void refreshDensityStrip();renderIdle();if(!restored&&canRepeatIdle()&&automaticIdlePreview(assets?.animations.map(item=>item.name)??[],animation,first,!!requestedId))void playPreview();
    // Only an instance that serves agent control is asked for its config: a plain open has no control endpoint (#164).
    if(!readOnly&&writes.control!==false)controlDispose=connectControl({sourceHash:data.sourceHash,mode:'single',route:access.route,headers:()=>access.headers(),observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
  } catch (error) { message(`Could not open review package: ${errorText(error)}`, true); text('dirty', 'Load failed'); }
}
/** `feedback` is the review dialog, not an Inspector section: a user action opens it; a restored older bookmark that saved it selects nothing. */
function showInspector(name:string,reveal=true):void {if(name==='feedback'){if(reveal)openReview();return;}if(reveal)workspace?.revealInspector();const selector=document.querySelector<HTMLButtonElement>(`[data-inspector="${name}"]`);if(selector&&selector.getAttribute('aria-pressed')!=='true'&&selector.getAttribute('aria-selected')!=='true')selector.click();}
function bindInspector():void {bindInspectorTabs(()=>{workspace?.afterTab();fitCamera();},()=>workspace?.beforeTab());}
/** Opening the review pauses playback, as selecting Feedback did. Its inputs stay in the document whether or not it is open, so the draft keeps them. */
function openReview():void {const dialog=el<HTMLDialogElement>('review-dialog');for(const drawer of document.querySelectorAll<HTMLDialogElement>('dialog.workspace-drawer[open]'))drawer.close();pause();if(!dialog.open)dialog.showModal();}
function bindReviewDialog():void {
 const dialog=el<HTMLDialogElement>('review-dialog');
 button('write-review').onclick=openReview;button('review-dialog-close').onclick=()=>dialog.close();
 // Escape closes the native modal; every close returns focus to the button that opens it.
 dialog.addEventListener('close',()=>{button('write-review').setAttribute('aria-expanded','false');button('write-review').focus();});
 dialog.addEventListener('toggle',()=>{if(dialog.open)button('write-review').setAttribute('aria-expanded','true');});
}

/** Rig world → rig-pane pixels for the current camera. */
function rigProject(){const root=el('rig-root');return (x:number,y:number)=>({x:parseFloat(root.style.left||'0')+x*rigScale,y:parseFloat(root.style.top||'0')-y*rigScale});}
function redrawOverlay(fresh:boolean):void {
 animationPanel?.redraw(layers.bones);
 if(!overlays||!player)return;
 const project=rigProject();
 const regions=[...chestRegions(),...(meshPanel?.overlayRegions()??[]),...(cutsPanel?.overlayRegions()??[]),...(clothPanel?.overlayRegions()??[])],circles=[...chestCircles(),...(meshPanel?.overlayCircles()??[])],markers=[...chestMarkers(),...(cutsPanel?.overlayMarkers()??[])];
 const value=fresh?overlays.refresh({player,frame:parts?.frame('single'),selectedSlot:parts?.value()?.slot,bones:(data.feedbackCatalog.bones??[]).map(name=>({name})),project,settings:layers,regions,circles,markers,meshEdit:meshEditor?.overlay(),weights:weightsView?.overlay(),anchors:bonesPanel?.overlay()}):overlays.redraw({project,settings:layers,regions,circles,markers,meshEdit:meshEditor?.overlay(),weights:weightsView?.overlay(),anchors:bonesPanel?.overlay()});
 lastOverlay=value;
 text('layer-state',value.warnings.join(' · ')||'Actual last-drawn mesh edges / bone points');idlePanel?.place(duration);rigFieldsPanel?.place();if(!fresh&&value.needsCapture&&!playing&&!seekingControl)drawRig(()=>player!.draw());
}
function canRepeatIdle():boolean{return !!player&&idleAvailable(assets?.animations.map(a=>a.name)??[],animation)&&!axisInspection&&input('idle-repeat').checked&&duration>0;}
function renderIdle():void {text('idle-state',canRepeatIdle()?'Actual idle · repeat enabled':animation==='idle'?'Idle repeat paused':'Non-idle inspection · no automatic playback');}
async function playPreview():Promise<void> {
 if((!player&&!video&&!sequence)||duration<=0)return;
 const intent=++playbackIntent;desiredPlay=true;idleHeld=false;if(time>=duration)seek(0,{kind:'replay'});
 if(video&&referenceInput.state==='loaded'){try{await video.play();}catch(error){pause();message(`Playback is paused: ${errorText(error)}. Use Play to retry.`,true);return;}}
 if(intent!==playbackIntent||!desiredPlay){if(!desiredPlay)video?.pause();return;}playing=true;lastFrame=0;player?.resume();button('play').textContent='Ⅱ';button('play').setAttribute('aria-label','Pause');
}
function localDraft():boolean{return !!comments?.draft()||dirty||!!input('feedback-summary').value.trim()||!!input('feedback-start').value.trim()||!!input('feedback-end').value.trim()||!!select('feedback-category').value||!!input('feedback-target-name').value.trim()&&input('feedback-target-name').value!==data.manifest.id;}
function controlState():ControlInspection {
 const box=assets?.stage??player?.bounds(),center=box?{x:box.x+box.width/2,y:box.y+box.height/2}:null;
 return {part:parts?.value()??null,partGeneration:parts?.observation()?.generation??null,view:numericView(),theme:appearance?.get()??'system',layout:'auto',effectiveLayout:el('stage-layout').dataset.orientation==='vertical'?'column':'row',cameras:{rig:{zoom:player?zoom:1,pan:{x:center&&cameraCenter?(center.x-cameraCenter.x)*rigScale:0,y:center&&cameraCenter?(cameraCenter.y-center.y)*rigScale:0}},reference:{zoom:referenceSize?referenceZoom:1,pan:{x:referenceSize&&referenceCenter?(referenceSize.width/2-referenceCenter.x)*referenceScale:0,y:referenceSize&&referenceCenter?(referenceSize.height/2-referenceCenter.y)*referenceScale:0}}},animation:animation||null,time:player?.time??time,playing,loop:canRepeatIdle()?'idle':'off',layers:{images:!!player&&layers.images,meshes:!!player&&layers.mesh,bones:!!player&&layers.bones},ready:!!data,seeking:seekingControl||!!video?.seeking||!!persistence?.restoring(),dirty:localDraft(),busy:saving||stripBusy||!!persistence?.restoring(),feedbackEligible:!persistence?.restoring(),comparison:controlComparison(layoutEligibility()),capabilities:{camera:!!player,referenceCamera:!!referenceSize,animation:!!player,time:duration>0,playback:duration>0,layers:{images:!!player,meshes:!!player,bones:!!player}}};
}
async function applyControl(command:ControlCommand,signal:AbortSignal):Promise<void> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 if(['animation','time','playback'].includes(command.type)&&(localDraft()||saving||stripBusy))throw new Error('CONTROL_DRAFT_BUSY: preserve review draft');
 if(command.type==='theme'){appearance?.set(command.value);return;}
 if(command.type==='layout'){fitCamera();return;}
 if(command.type==='camera-sync'){setCameraSync(command.value);return;}
 if(command.type==='layers'){if(!player)throw new Error('CONTROL_LAYERS_UNAVAILABLE');Object.assign(layers,{images:command.images,mesh:command.meshes,bones:command.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;redrawOverlay(false);return;}
 if(command.type==='camera'||command.type==='fit'){
  const target=command.target;if(target!=='rig'&&target!=='reference')throw new Error('CONTROL_CAMERA_MODE: single review has no A/B panes');
  const frame=paneFrame(target);if(!frame)throw new Error('CONTROL_CAMERA_UNAVAILABLE');
  if(command.type==='fit')fitActiveCamera(target);else updateCamera(target,{zoom:command.zoom,pan:{x:command.pan.x/frame.width,y:command.pan.y/frame.height}});return;
 }
 if(command.type==='animation'){if(!assets?.animations.some(a=>a.name===command.name))throw new Error('CONTROL_ANIMATION_UNAVAILABLE');chooseAnimation(command.name);return;}
 if(command.type==='playback'){if(command.value==='pause')pause();else{await playPreview();if(!playing)throw new Error('CONTROL_PLAYBACK_REFUSED');}return;}
 if(command.type==='time'){
  if(!Number.isFinite(command.seconds)||command.seconds<0||command.seconds>duration)throw new Error('CONTROL_TIME_OUTSIDE_DOMAIN');
  pause();seekingControl=true;try{await inspectControlTime(command.seconds,signal);}finally{seekingControl=false;}
 }
}
async function inspectControlTime(target:number,signal:AbortSignal,preserveSeconds=false):Promise<void> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 // #191: a control seek is a clip move like the transport's: a seek to 0 restarts the wind clock while the exported world is in use.
 clipMoved({kind:'seek',to:target});
 const media=video;
 if(!media){if(player){player.seek(target);drawRig(()=>player!.draw());}time=target;renderSequenceFrame();renderTransport();return;}
 if(media.readyState<1||target>media.duration)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');
 const previousPosition=media.currentTime;
 const commit=(actual:number)=>{
  if(signal.aborted||media!==video)throw new Error('CONTROL_SUPERSEDED');
  if(!Number.isFinite(actual)||actual<0||actual>duration)throw new Error('CONTROL_TIME_OUTSIDE_DOMAIN');
  const seconds=preserveSeconds?target:actual;
  if(player){player.seek(seconds);drawRig(()=>player!.draw());}time=seconds;
  controlledVideoSample={media,position:media.currentTime,time:actual};if(axisInspection&&duration>0){const axis=data.manifest.axes.find(item=>item.id===select('axis-select').value&&item.animation===animation);if(axis){const value=axis.min+actual/duration*(axis.max-axis.min);input('axis-value').value=String(value);text('axis-value-label',value.toFixed(3));}}renderSequenceFrame();renderTransport();
 };
 try{const actual=await decodedControlTime(media,target,signal);if(signal.aborted||media!==video)throw new Error('CONTROL_SUPERSEDED');commit(actual);if(Math.abs(actual-target)>1e-6)message(`Reference decoded ${actual.toFixed(4)} s · requested ${target.toFixed(4)} s. The rig and saved view use the decoded timestamp.`);}
 catch(error){
  // Superseding local/remote input owns its position; never undo it. Other
  // refusals recover the prior reference through the same decoded-frame path.
  if(signal.aborted||media!==video)throw error;
  try{commit(await decodedControlTime(media,previousPosition,signal));}catch(recovery){throw new Error(`Reference inspection failed (${errorText(error)}); prior inspection recovery failed (${errorText(recovery)})`);}
  throw error;
 }
}
async function decodedControlTime(media:HTMLVideoElement,target:number,signal:AbortSignal):Promise<number> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 if(!media.seeking&&media.currentTime===target&&controlledVideoSample?.media===media&&controlledVideoSample.position===target)return controlledVideoSample.time;
 return await new Promise<number>((resolve,reject)=>{
  let actual:number|null=null,done=false,handle:number|null=null;
  const cleanup=()=>{clearTimeout(timer);media.removeEventListener('seeked',onSeek);signal.removeEventListener('abort',abort);if(handle!==null)media.cancelVideoFrameCallback(handle);};
  const finish=()=>{if(!done||actual===null)return;cleanup();if(signal.aborted){reject(new Error('CONTROL_SUPERSEDED'));return;}resolve(actual);};
  const onSeek=()=>{done=true;if(typeof media.requestVideoFrameCallback!=='function')actual=media.currentTime;finish();};
  const abort=()=>{cleanup();reject(new Error('CONTROL_SUPERSEDED'));};
  const timer=setTimeout(()=>{cleanup();reject(new Error('CONTROL_REFERENCE_TIMEOUT'));},10000);
  media.addEventListener('seeked',onSeek);signal.addEventListener('abort',abort,{once:true});
  if(typeof media.requestVideoFrameCallback==='function')handle=media.requestVideoFrameCallback((_n,m)=>{handle=null;actual=m.mediaTime;finish();});
  media.currentTime=target;
 });
}
function numericView():ControlView {
 const numeric=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return null;const camera=paneCamera(target);return numericCamera(frame.space,camera.center??frame.center,camera.zoom,frame.baseScale*camera.zoom,frame.width,frame.height);};
 return {schema:'rig-review-view/1',cameraSync,activeCamera,cameras:{rig:numeric('rig'),a:null,b:null,reference:numeric('reference')}};
}
function renderNumericView():void {const node=document.getElementById('view-coordinates');if(node)node.textContent=JSON.stringify(numericView(),null,2);}
function inspectionBinding():InspectionBinding{return {mode:'single',sourceHash:data.sourceHash,rigs:[data.reviewedSource.rig?.sha256??null]};}
function inspectionBookmark():InspectionBookmark {return {schema:'rig-review-inspection/1',binding:inspectionBinding(),animation:animation||null,time:player?.time??time,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:layers.bones},view:numericView(),selection:{...(turnPad?{turn:turnPad.snapshot()}:{}),part:parts?.value()??null,view,checkpoint:checkpoint?.id??null,reference:select('reference-select').value||null,person:selectedPerson||null,inspector:selectedInspector()??'view',partSet:select('part-set').disabled?null:select('part-set').value,axis:axisInspection?{id:select('axis-select').value,value:Number(input('axis-value').value)}:null}};}
async function restoreInspection(bookmark:InspectionBookmark,signal:AbortSignal,preserveSeconds=false):Promise<void> {
 await restoreTransaction(()=>prepareInspection(bookmark,signal),()=>({bookmark:inspectionBookmark(),inputs:captureInputs()}),()=>applyInspection(bookmark,signal,preserveSeconds),async previous=>{await applyInspection(previous.bookmark,new AbortController().signal);restoreInputs(previous.inputs);renderFeedbackRange();});
}
/** Read the SELECTED reference without replacing the currently inspected DOM/player. */
async function inspectionReferenceInfo(id:string|null,signal:AbortSignal):Promise<{width:number;height:number;duration:number|null;people:string[]}> {
 if(!id)return {width:0,height:0,duration:null,people:[]};
 const reference=data.manifest.references.find(r=>r.id===id);if(!reference)throw new Error('Saved reference is not declared');
 if(id===select('reference-select').value&&referenceSize)return {...referenceSize,duration:reference.type==='video'&&video?video.duration:sequence?sequence.frames[sequence.frames.length-1]!.t-sequence.frames[0]!.t:null,people:sequence?[...new Set(sequence.frames.flatMap(f=>f.people.map(p=>p.id)))]:[]};
 if(reference.type==='pose'){const response=await fetch(referenceUrl(reference),{signal});if(!response.ok)throw new Error('Saved pose reference is unavailable');const value:unknown=await response.json(),canonical=readSequence(value);if(canonical)return {width:canonical.width,height:canonical.height,duration:canonical.frames[canonical.frames.length-1]!.t-canonical.frames[0]!.t,people:[...new Set(canonical.frames.flatMap(f=>f.people.map(p=>p.id)))]};const pose=readPose(value);return {width:pose.width,height:pose.height,duration:null,people:[]};}
 if(reference.type==='image')return await new Promise((resolve,reject)=>{const image=new Image(),clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',fail);image.onload=null;image.onerror=null;},fail=()=>{clean();reject(new Error('Saved reference image unavailable'));},timer=setTimeout(fail,10000);image.onload=()=>{clean();resolve({width:image.naturalWidth,height:image.naturalHeight,duration:null,people:[]});};image.onerror=fail;signal.addEventListener('abort',fail,{once:true});image.src=referenceUrl(reference);});
 const media=document.createElement('video');media.preload='metadata';media.muted=true;
 try{media.src=referenceUrl(reference);await waitReferenceMetadata(media,signal);return {width:media.videoWidth,height:media.videoHeight,duration:media.duration,people:[]};}finally{media.pause();media.removeAttribute('src');media.load();}
}
async function prepareInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 const selection=bookmark.selection;
 if(selection.turn){if(!turnPad)throw new Error('TURN_UNAVAILABLE');turnPad.state.validate(selection.turn);}
 parts?.validate(selection.part);
 if(player&&!bookmark.animation||bookmark.animation&&!assets?.animations.some(a=>a.name===bookmark.animation))throw new Error('Saved animation is absent from this rig');
 if(selection.reference&&!data.manifest.references.some(r=>r.id===selection.reference))throw new Error('Saved reference is not declared');
 if(selection.checkpoint&&!data.manifest.checkpoints.some(c=>c.id===selection.checkpoint))throw new Error('Saved checkpoint is absent');
 const axis=selection.axis?data.manifest.axes.find(a=>a.id===selection.axis!.id):null;
 if(selection.axis&&(!axis||selection.axis.value<axis.min||selection.axis.value>axis.max||axis.animation!==bookmark.animation))throw new Error('Saved inspection axis is unavailable or outside its range');
 if(selection.partSet&&!player?.sets().some(set=>set.name===selection.partSet))throw new Error('Saved part preset is absent');
 if(bookmark.view.cameras.a||bookmark.view.cameras.b||bookmark.view.cameras.rig&&!player)throw new Error('Saved camera is unavailable in this single review');
 const info=await inspectionReferenceInfo(selection.reference===undefined?select('reference-select').value:selection.reference,signal);
 if(selection.person&&!info.people.includes(selection.person))throw new Error('Saved pose person is absent');
 const clipDuration=bookmark.animation?assets?.animations.find(a=>a.name===bookmark.animation)?.duration:undefined,referenceId=selection.reference===undefined?select('reference-select').value:selection.reference,isVideo=data.manifest.references.find(r=>r.id===referenceId)?.type==='video';const limit=clipDuration===undefined?info.duration??0:isVideo&&info.duration!==null?Math.min(clipDuration,info.duration):clipDuration;
 if(bookmark.time!==null&&(bookmark.time<0||bookmark.time>limit&&limit>=0))throw new Error('Saved inspection time is outside the selected clip/reference');
 const rig=bookmark.view.cameras.rig,ref=bookmark.view.cameras.reference;
 if(rig&&!player)throw new Error('Saved rig camera is unavailable');
 if(ref&&(info.width<=0||info.height<=0))throw new Error('Saved reference camera has no selected image/video/pose');
 // Viewport aspect, Inspector and pose bounds may differ from the current view.
 // Range fitting belongs to the transactional apply after that layout is measured.
 if(signal.aborted)throw new Error('Inspection restore superseded');
}
async function applyInspection(bookmark:InspectionBookmark,signal:AbortSignal,preserveSeconds=false):Promise<void> {
 cameraRestoring=true;try{
 const selection=bookmark.selection;
 if(turnPad){if(selection.turn)turnPad.restore(selection.turn);else{turnPad.state.reset();turnPad.restore(turnPad.snapshot());}}
 parts?.select(selection.part??null);
 pause();
 if(selection.checkpoint!==undefined){checkpoint=data.manifest.checkpoints.find(c=>c.id===selection.checkpoint);renderCheckpoint();renderCheckpoints();}
 if(selection.reference!==undefined&&select('reference-select').value!==(selection.reference??'')){select('reference-select').value=selection.reference??'';await showReference(selection.reference??'');if(selection.reference&&!referenceSize&& !video)throw new Error('Saved reference did not load');}
 if(bookmark.animation&&player)chooseAnimation(bookmark.animation);
 if(selection.axis){select('axis-select').value=selection.axis.id;chooseAxis();input('axis-value').value=String(selection.axis.value);applyAxis();}
 if(selection.partSet!==undefined&&player){if(selection.partSet||player.sets().length)player.setSet(selection.partSet||null);select('part-set').value=selection.partSet??'';}
 if(bookmark.time!==null){if(video&&video.readyState<1)await waitReferenceMetadata(video,signal);await inspectControlTime(bookmark.time,signal,preserveSeconds);}
 if(selection.person!==undefined){selectedPerson=selection.person??'';select('person-select').value=selectedPerson;lastPoseFrame=-1;renderSequenceFrame();}
 if(selection.view)setView(selection.view);
 appearance?.set(bookmark.theme);
 Object.assign(layers,{images:bookmark.layers.images,mesh:bookmark.layers.meshes,bones:bookmark.layers.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;
 if(selection.inspector)showInspector(selection.inspector,false);syncStageLayout(el('stage-layout'));
 // Mode changes schedule workspace layout and resize observers. Settle them
 // while restoration is held, before measuring/applying the saved pane camera.
 await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));if(signal.aborted)throw new Error('Inspection restore superseded');fitCamera();
 const camera=bookmark.view.cameras.rig,ref=bookmark.view.cameras.reference,rigViewport=el('rig-viewport'),referenceViewport=el('reference-viewport');
 const nextZoom=camera&&player&&rigViewport.clientWidth&&rigViewport.clientHeight?restoredZoom(camera,rigScale/zoom,rigViewport.clientWidth,rigViewport.clientHeight):camera?.zoom??null;
 const nextReferenceZoom=ref&&referenceSize&&referenceViewport.clientWidth&&referenceViewport.clientHeight?restoredZoom(ref,referenceScale/referenceZoom,referenceViewport.clientWidth,referenceViewport.clientHeight):ref?.zoom??null;
 if(nextZoom!==null&&camera){zoom=nextZoom;cameraCenter={...camera.center};}
 if(nextReferenceZoom!==null&&ref){referenceZoom=nextReferenceZoom;referenceCenter={...ref.center};}
 cameraSync=bookmark.view.cameraSync??false;activeCamera=bookmark.view.activeCamera==='reference'?'reference':'rig';
 if(player)drawRig(()=>player!.draw());if(selection.part)parts?.assertIdentity(selection.part);fitCamera();redrawOverlay(false);pause();renderTransport();renderCameraControls();
 }finally{cameraRestoring=false;}
}
async function waitReferenceMetadata(media:HTMLVideoElement,signal:AbortSignal):Promise<void> {if(media.readyState>=1)return;await new Promise<void>((resolve,reject)=>{const clean=()=>{clearTimeout(timer);media.removeEventListener('loadedmetadata',ready);media.removeEventListener('error',fail);signal.removeEventListener('abort',fail);};const ready=()=>{clean();resolve();},fail=()=>{clean();reject(new Error('Saved reference metadata unavailable'));};const timer=setTimeout(fail,10000);media.addEventListener('loadedmetadata',ready,{once:true});media.addEventListener('error',fail,{once:true});signal.addEventListener('abort',fail,{once:true});});}
async function setupPersistence():Promise<boolean> {
 persistence=await connectInspectionPersistence({scope:'single:'+data.manifest.id+':'+data.sourceHash,binding:inspectionBinding(),baseline:submittedBaseline!,session:()=>session,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{session=value;dirty=isDirty;select('review-status').value=session.status;renderProposals();renderCheckpoint();renderCheckpoints();updateSavedState();},bookmark:inspectionBookmark,restoreBookmark:(b,s)=>restoreInspection(b,s,session.feedback.some(f=>isTimeOnlyFeedback(f)&&JSON.stringify((f.context as any).comment.bookmark)===JSON.stringify(b))),
 ui:()=>({inspectorScroll:workspace?.scroll()??'{}',...(inspectorBlocks?activeBlocksUI(inspectorBlocks.state()):{}),reportCategory:select('report-category').value,reportPage,reportEvent:selectedReportEvent?.id??null,reportTime:selectedReportTime??null,reportTarget:selectedReportTarget??null}),restoreUI:value=>{if(typeof value.reportCategory==='string'&&[...select('report-category').options].some(o=>o.value===value.reportCategory))select('report-category').value=value.reportCategory;if(typeof value.reportPage==='number'&&Number.isSafeInteger(value.reportPage)&&value.reportPage>=0)reportPage=value.reportPage;selectedReportEvent=typeof value.reportEvent==='string'?data.report?.categories.flatMap(c=>c.events).find(e=>e.id===value.reportEvent)??null:null;selectedReportTime=typeof value.reportTime==='number'?value.reportTime:undefined;selectedReportTarget=typeof value.reportTarget==='number'?value.reportTarget:undefined;renderReportEvents();renderReportSelection();workspace?.restoreScroll(value.inspectorScroll);inspectorBlocks?.restore(restoreActiveBlocksUI(value));},afterInputs:()=>{const target=input('feedback-target-name').value;renderFeedbackTargets(true);if(select('feedback-target-kind').value!=='rig')input('feedback-target-name').value=target;renderFeedbackRange();text('audio-volume-label',`${Math.round(Number(input('audio-volume').value)*100)}%`);},onConflict:value=>{draftConflict=value;updateSavedState();},onStatus:value=>{text('draft-state',value);el('draft-state').title=value;text('review-draft-state',value);}});
 return persistence.restored;
}
/** Setup's Chest regions tool: designation values, an overlay and a two-file client download. Nothing reaches the session's feedback or the package. */
function chestField(id:string){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;return node?{value:node.value,...(node instanceof HTMLInputElement&&node.type==='checkbox'?{checked:node.checked}:{})}:undefined;}
function chestEvaluation(){return evaluateChestForm(chestField,chestMapping,data.feedbackCatalog.bones);}
function chestRegions():OverlayRegion[]{
 const style=getComputedStyle(document.documentElement),token=(name:string)=>style.getPropertyValue(name).trim();
 return chestOverlayPolygons(chestEvaluation(),chestMapping).map((region,i)=>({...region,stroke:token(i?'--rv-region-b':'--rv-region-a'),fill:token(i?'--rv-region-b-fill':'--rv-region-a-fill')}));
}
/** Circle regions: in edit mode the editor's circles straight from the fields (handles and labels), else the valid designation's. */
function chestCircles():OverlayCircle[]{
 const mapping=chestMapping;if(!mapping.available)return [];
 const style=getComputedStyle(document.documentElement),token=(name:string)=>style.getPropertyValue(name).trim();
 const colors=(row:number,overlap:boolean)=>({stroke:token(overlap?'--rv-bust-overlap':row?'--rv-bust-l':'--rv-bust-r'),fill:token(overlap?'--rv-bust-overlap-fill':row?'--rv-bust-l-fill':'--rv-bust-r-fill'),handle:token('--rv-bust-handle'),ink:token('--rv-bust-ink'),labelBg:token('--rv-bust-label-bg'),flash:token('--rv-bust-flash')});
 if(chestEditor?.active()&&chestEditor.mode()==='landmarks'){
  // #105: the producer's derivation drawn live; a CONFIG_BUST_CLEARANCE refusal turns both to the overlap colour.
  const read=chestEditor.landmarks();if(!('derived' in read))return [];
  const refused=!!read.derived.refusal;
  return read.derived.regions.filter(r=>r.r>0&&r.band>=0).map((r,row)=>({center:mapping.toWorld(r.cx,r.cy),r:r.r,band:r.band,label:`${r.name} r:${r.r} b:${r.band}`,labelRow:row,handles:false,colors:colors(row,refused)}));
 }
 if(chestEditor?.active()){
  const rows=bustSides.map(({side,row})=>({side,row,circle:rowCircle(chestField,row)})),[r,l]=[rows[0]!.circle,rows[1]!.circle];
  // As in the example, overlapping cores turn both circles to the overlap colour.
  const overlap=!!r&&!!l&&r.r+l.r>Math.hypot(l.cx-r.cx,l.cy-r.cy);
  return rows.flatMap(({side,row,circle})=>circle?[{center:mapping.toWorld(circle.cx,circle.cy),r:circle.r,band:circle.band,label:bustLabel(side,circle),labelRow:row,handles:true,flash:chestEditor!.flashing(side),colors:colors(row,overlap)}]:[]);
 }
 return chestOverlayCircles(chestEvaluation(),mapping).map(c=>({center:c.center,r:c.r,band:c.band,handles:false,colors:colors(c.row,false)}));
}
/** Landmark markers (#105) in Landmarks mode: apexes in the R / L colours, the cleavage with guides to both apexes. */
function chestMarkers():OverlayMarker[]{
 const mapping=chestMapping;if(!mapping.available||!chestEditor?.active()||chestEditor.mode()!=='landmarks')return [];
 const style=getComputedStyle(document.documentElement),token=(name:string)=>style.getPropertyValue(name).trim(),armed=chestEditor.armed();
 const at=(key:LandmarkKey)=>{const x=Number(input(landmarkInputId(key,'x')).value.trim()||NaN),y=Number(input(landmarkInputId(key,'y')).value.trim()||NaN);return Number.isFinite(x)&&Number.isFinite(y)?mapping.toWorld(x,y):null;};
 const apexes=[at('apex_r'),at('apex_l')].filter((p):p is {x:number;y:number}=>!!p);
 return LANDMARKS.flatMap(({key,tag})=>{const p=at(key);if(!p)return [];const stroke=token(key==='apex_r'?'--rv-bust-r':key==='apex_l'?'--rv-bust-l':'--rv-landmark');
  return [{at:p,tag,active:armed===key,colors:{stroke,fill:stroke,ink:token('--rv-landmark-ink'),labelBg:token('--rv-bust-label-bg')},...(key==='cleavage'?{guideTo:apexes}:{})}];});
}
function populateChestBones():void {
 const list=document.getElementById('lm-bones');if(list){list.replaceChildren();for(const name of data.feedbackCatalog.bones??[])list.append(option(name,name));}
 const bones=data.feedbackCatalog.bones;
 for(const row of chestRegionRows){const node=select(chestRowId(row,'bone'));node.replaceChildren(option('',bones?'Select bone':'No model bones'));for(const name of bones??[])node.append(option(name,name));node.disabled=!bones;}
}
function updateChestMapping():void {
 const root=data.feedbackCatalog.bones?.[0];let at:{x:number;y:number}|null=null;
 if(player&&root){try{const bone=player.bone(root);at={x:bone.x,y:bone.y};}catch{at=null;}}
 chestMapping=player?cropWorldMapping(assets?.stage,at):{available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn'};
 renderChest();
}
function renderChest():void {
 for(const id of ['chest-crop-w','chest-crop-h']){const node=input(id);node.readOnly=chestMapping.available;if(chestMapping.available)node.value=String(id==='chest-crop-w'?chestMapping.crop.w:chestMapping.crop.h);}
 text('chest-mapping',chestMapping.available?`Crop → rig world from the model: ${chestMapping.basis}.`:`${chestMapping.reason}. No overlay is drawn; enter the crop size to export.`);
 el('chest-mapping').classList.toggle('error',!chestMapping.available);
 const value=chestEvaluation();text('chest-status',value.ok?`${value.document.mesh.value.contour.regions.map(r=>`${r.name} → ${r.bone}`).join(' · ')} · valid for export`:value.error);
 el('chest-status').classList.toggle('error',!value.ok);
 chestEditor?.sync();meshEditor?.sync();weightsView?.sync();bonesPanel?.sync();cutsPanel?.sync();clothPanel?.sync();redrawOverlay(false);
}
async function exportChest():Promise<void> {
 const value=chestEvaluation();if(!value.ok){message(`Chest regions not exported: ${value.error}`,true);return;}
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
 const binding=chestRegionsBinding({fileSha256:digest,sourceHash:data.sourceHash,reviewedSource:data.reviewedSource,exportedAt:new Date().toISOString(),mapping:chestMapping.available?chestMapping.basis:chestMapping.reason});
 download('chest-regions.json',value.text,'application/json');download('chest-regions.binding.json',JSON.stringify(binding,null,2)+'\n','application/json');
 message('Downloaded chest-regions.json and chest-regions.binding.json. The regions are review evidence, not an approval; the package is unchanged.');
}
/** Animate · Environment. Inspection only: the player is the solver, nothing is written to the model or motion. */
const environmentInputs=['wind-base','wind-breeze','wind-gust','wind-repeat','wind-gust-peak','wind-gust-duration','gravity','jolt','drag-trail','physics-reset','environment-use','environment-export','environment-check'];
function environmentApplied():boolean{return input('environment-applied').checked;}
function gravityValue():number{return Number(input('gravity').value);}
/** Called from `tick` right before `player.frame(dt)`: the gust clock is the stepped time, so a paused player freezes it. */
function stepEnvironment(dt:number):void {
 if(!player)return;
 wind.advance(dt);
 const {due,pending}=dueJolts(joltQueue,wind.read().time);joltQueue=pending;for(const step of due)player.moved({x:step.x,y:step.y});
 if(environmentApplied())player.environment(environmentFor(wind.read(),gravityValue()));
 renderEnvironment();
}
function applyEnvironment():void {if(player&&environmentApplied())player.environment(environmentFor(wind.read(),gravityValue()));renderEnvironment();}
function renderEnvironment():void {
 if(!player)return;
 const reading=wind.read();
 text('wind-readout',(environmentApplied()?windReadout(reading,gravityValue()):RUNTIME_START_READOUT)+environmentNote);
 const gust=button('wind-gust');gust.disabled=reading.gusting;gust.setAttribute('aria-pressed',String(reading.gusting));gust.textContent=reading.gusting?'Gusting…':'Gust';
 text('wind-base-label',input('wind-base').value);text('gravity-label',gravityValue().toFixed(2));
 renderSchedule();
}
/**
 * #112 · Use for readings: the controls as the exported `rigc-environment/1` schedule (src/environment-schedule.ts). While
 * on, readings send the drawn clip's schedule, Apply's check reads the checked clip's (`idle` when the rig has one, as
 * `rig-parts check` renders it), and the wind clock restarts with the clip so the person watches the world rigc reads.
 */
function useWorld():boolean{return input('environment-use').checked&&environmentApplied();}
function clipDuration(name:string):number{return assets?.animations.find(item=>item.name===name)?.duration??data.manifest.animations.find(item=>item.id===name)?.duration??0;}
/** The clip `rig-parts check` poses its idle readings over: `idle` when the rig has one, else the drawn clip. */
function checkAnimation():string{return assets?.animations.some(item=>item.name==='idle')?'idle':animation;}
let worldCache:{key:string;value:WorldExport|{error:string}}|null=null;
function worldFor(name:string):WorldExport|{error:string} {
 const key=JSON.stringify([wind.snapshot(),gravityValue(),environmentApplied(),name,clipDuration(name)]);
 if(worldCache?.key!==key)worldCache={key,value:worldExport(wind.snapshot(),gravityValue(),environmentApplied(),name,clipDuration(name))};
 return worldCache.value;
}
/** A fresh wind clock at the same settings (a repeating gust restarts at 0); pending jolts keep their distance in time. */
function restartWindClock():void {const now=wind.read().time;wind.restore(wind.snapshot());joltQueue=joltQueue.map(step=>({...step,at:Math.max(0,step.at-now)}));}
/** #183: every clip restart (`restartsWindClock`) restarts the wind clock while the schedule is watched, not only the checkbox. */
function clipMoved(move:ClipMove):void {if(player&&restartsWindClock(move,useWorld())){restartWindClock();applyEnvironment();}}
let scheduleShown='';
function renderSchedule():void {
 const world=worldFor(animation),check=checkAnimation(),checked=check!==animation?worldFor(check):null;
 const shown='error' in world?world.error:`${world.summary}${useWorld()?' · used for readings and Apply':''}${checked&&!('error' in checked)&&checked.sha256!==world.sha256?` · check reads ${check}'s: ${checked.summary}`:''}`;
 if(shown!==scheduleShown){scheduleShown=shown;text('environment-schedule',shown);}
}
function feedbackSchedule(){if(!player||!environmentApplied())return null;const world=worldFor(animation);return 'error' in world?null:scheduleContext(world,useWorld());}
let environmentCheckBusy=false;
/** Check under this world: `rig-parts check --environment` on the build on the stage, beside that build's default-world check. */
async function runEnvironmentCheck():Promise<EnvironmentCheckView|{status:'refused';error:string}|null> {
 if(environmentCheckBusy)return null;
 const out=el('environment-check-lines'),show=(rows:{kind:string;text:string}[])=>{out.replaceChildren(...rows.map(row=>{const line=document.createElement('div');line.className=`env-${row.kind}`;line.textContent=row.text;return line;}));};
 const name=checkAnimation(),world=worldFor(name);
 if('error' in world){show([{kind:'error',text:world.error}]);return {status:'refused',error:world.error};}
 const build=appliedOnStage?'scratch':'inspected',before=stageCheck;
 environmentCheckBusy=true;button('environment-check').disabled=true;show([{kind:'label',text:`Checking the ${build} build under ${name}'s schedule (${world.schedule.steps.length} step(s), sha256 ${world.sha256.slice(0,16)}) with rig-parts check --environment…`}]);
 try{
  let job=await api<EnvironmentCheckView|{status:'refused';error:string}>('/api/environment-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({build,schedule:world.schedule})}).catch(error=>({status:'refused' as const,error:errorText(error).replace(/^\d+: /,'')}));
  if(!('id' in job)){const text=(()=>{try{return (JSON.parse(job.error) as {error?:string}).error??job.error;}catch{return job.error;}})();show([{kind:'error',text}]);return {status:'refused',error:text};}
  const started=performance.now();
  while(job.status==='running'){show([{kind:'label',text:`check --environment running on the ${build} build · ${((performance.now()-started)/1000).toFixed(0)} s · ${job.lines.at(-1)?.trim()??''}`}]);await new Promise(resolve=>setTimeout(resolve,1500));job=await api<EnvironmentCheckView>(`/api/environment-check/${job.id}`);}
  const checked=job;
  const label=build==='inspected'?'default world (the inspected build\'s own check)':`the scratch build's Apply check${appliedOnStage&&'environment' in appliedOnStage&&appliedOnStage.environment?` (under schedule sha256 ${appliedOnStage.environment.sha256.slice(0,16)})`:' (default world)'}`;
  // No inspected check exists when the baseline did not reproduce the inspected rig; say why, verbatim (a schedule of wind [1, 0], gravity [0, 1] reads the default world).
  const baseline=rebuildStatus?.baseline,noDefault=build==='inspected'&&!inspectedCheckView()&&baseline&&baseline.status!=='running'&&baseline.status!=='reproduced';
  const draw=()=>show(environmentCheckRows(checked,name=>noDefault?`${name}: no default-world check — ${baseline!.line} (check a schedule of wind 1, gravity 1 for the runtime's world)`:build==='inspected'?beforeLine(name,null,inspectedCheckView()):barLine(name,before?.lines??null,before?.check??null),label));
  draw();if(build==='inspected'&&inspectedCheckView()?.status!=='checked')void followInspectedCheck(draw);
  return job;
 }catch(error){show([{kind:'error',text:`ENVIRONMENT_CHECK_FAILED: ${errorText(error)}`}]);return null;}
 finally{environmentCheckBusy=false;button('environment-check').disabled=!player;}
}
/** Every control change engages the environment; until then the player stands at the runtime start values. */
function engage(change:()=>void):void {
 try{change();input('environment-applied').checked=true;environmentNote='';applyEnvironment();persistence?.save();}
 catch(error){message(`Environment unchanged: ${errorText(error)}`,true);syncEnvironmentInputs();}
}
function syncEnvironmentInputs():void {
 const s=wind.snapshot();input('wind-base').value=String(s.base);input('wind-breeze').checked=s.breeze;input('wind-repeat').checked=s.repeat;input('wind-gust-peak').value=String(s.gustPeak);input('wind-gust-duration').value=String(s.gustDuration);renderEnvironment();
}
function bindEnvironment():void {
 input('wind-base').oninput=()=>engage(()=>wind.setBase(Number(input('wind-base').value)));
 input('wind-breeze').onchange=()=>engage(()=>wind.setBreeze(input('wind-breeze').checked));
 input('wind-repeat').onchange=()=>engage(()=>wind.setRepeat(input('wind-repeat').checked));
 input('wind-gust-peak').onchange=()=>engage(()=>wind.setGustPeak(Number(input('wind-gust-peak').value)));
 input('wind-gust-duration').onchange=()=>engage(()=>wind.setGustDuration(Number(input('wind-gust-duration').value)));
 input('gravity').oninput=()=>engage(()=>{environmentFor(wind.read(),gravityValue());});
 button('wind-gust').onclick=()=>engage(()=>wind.triggerGust());
 button('jolt').onclick=()=>{if(!player)return;joltQueue.push(...joltPacket(wind.read().time));if(!playing)message('Jolt queued · it reaches the physics on the next steps; press Play.');};
 button('physics-reset').onclick=resetPhysics;
 button('applied-undo').onclick=()=>{void undoApply();};
 input('environment-use').onchange=()=>{
  if(!input('environment-use').checked){message('Use for readings is off: readings send the standing wind and gravity, Apply\'s check reads the default world.');renderSchedule();return;}
  const world=worldFor(animation);
  if('error' in world){input('environment-use').checked=false;message(world.error,true);renderSchedule();return;}
  // The watched world starts where the schedule does: a fresh wind clock at the clip's first frame.
  restartWindClock();seek(0);applyEnvironment();message(`Use for readings: ${world.summary} · the wind clock restarts with the clip.`);
 };
 button('environment-export').onclick=()=>{const world=worldFor(animation);if('error' in world){message(world.error,true);return;}download('rigc-environment.json',world.text,'application/json');message(`Exported ${world.summary}. The download is the bytes readings, Apply and feedback carry; the package is unchanged.`);};
 button('environment-check').onclick=()=>{void runEnvironmentCheck();};
 input('drag-trail').onchange=()=>{el('rig-viewport').dataset.trail=String(input('drag-trail').checked);};
 // Drag to trail: the rig pane's pointer drag becomes `player.moved` before the pan handler sees it; Space still pans.
 let space=false,trail:{id:number;x:number;y:number}|null=null;
 const keys=(event:KeyboardEvent)=>{if(event.code==='Space')space=event.type==='keydown';};
 window.addEventListener('keydown',keys);window.addEventListener('keyup',keys);window.addEventListener('blur',()=>{space=false;});
 const pane=el('rig-pane'),viewport=el('rig-viewport');
 pane.addEventListener('pointerdown',event=>{
  if(!input('drag-trail').checked||space||!player||!event.isPrimary||event.button!==0)return;
  if(event.target instanceof Element&&event.target.closest('button,input,select,textarea,a'))return;
  event.stopPropagation();event.preventDefault();trail={id:event.pointerId,x:event.clientX,y:event.clientY};viewport.setPointerCapture(event.pointerId);
 },{capture:true});
 pane.addEventListener('pointermove',event=>{
  if(!trail||event.pointerId!==trail.id)return;event.stopPropagation();
  const motion=dragMoved(event.clientX-trail.x,event.clientY-trail.y,rigScale);trail.x=event.clientX;trail.y=event.clientY;if(motion&&player)player.moved(motion);
 },{capture:true});
 const end=(event:PointerEvent)=>{if(!trail||event.pointerId!==trail.id)return;event.stopPropagation();if(viewport.hasPointerCapture(trail.id))viewport.releasePointerCapture(trail.id);trail=null;};
 pane.addEventListener('pointerup',end,{capture:true});pane.addEventListener('pointercancel',end,{capture:true});
}
/** Reset: the runtime's start values, then the player's reopen-then-step to the current time, so the physics history is cleared. */
function resetPhysics():void {
 if(!player)return;
 joltQueue=[];wind.restore(null);input('environment-applied').checked=false;input('gravity').value='1';syncEnvironmentInputs();
 try{player.environment(null);if(player.current){player.seek(time);drawRig(()=>player!.draw());}environmentNote=` · physics history cleared; re-posed from ${time.toFixed(3)} s`;}
 catch(error){environmentNote='';message(`Physics reset refused: ${errorText(error)}`,true);}
 renderEnvironment();persistence?.save();
}
/** Draft restore: the inputs are already back; rebuild the wind model from them (a fresh gust clock). */
function restoreEnvironment():void {
 const snapshot:WindSnapshot={version:1,base:Number(input('wind-base').value),breeze:input('wind-breeze').checked,repeat:input('wind-repeat').checked,gustPeak:Number(input('wind-gust-peak').value),gustDuration:Number(input('wind-gust-duration').value)};
 try{wind.restore(snapshot);environmentFor(wind.read(),gravityValue());}
 catch(error){wind.restore(null);input('environment-applied').checked=false;input('gravity').value='1';message(`Saved environment not restored: ${errorText(error)}`,true);}
 syncEnvironmentInputs();el('rig-viewport').dataset.trail=String(input('drag-trail').checked);
 if(player){if(environmentApplied())applyEnvironment();else player.environment(null);}
}
function feedbackEnvironment(){return player?environmentJson(environmentContext(wind.read(),gravityValue(),environmentApplied(),player.environment())):null;}
function enableEnvironment(modelUrl:string):void {
 for(const id of environmentInputs)el<HTMLInputElement|HTMLButtonElement>(id).disabled=false;
 syncEnvironmentInputs();text('physics-panel-state','Reading the compiled model…');
 readingsPanel?.catalog(data.feedbackCatalog.slots??[],data.feedbackCatalog.bones??[]);readingsPanel?.status('Pick readings, then Run: each runs on the inspected build and on the latest scratch build.',false);
 const rig=data.reviewedSource.rig;
 if(!rig){inspectedDocumentReason='PHYSICS_TUNING_UNAVAILABLE: no reviewed rig identity';refreshPhysics();return;}
 void loadModelDocument(modelUrl,rig.sha256).then(loaded=>{if(loaded.ok)inspectedDocument=loaded.document;else inspectedDocumentReason=`PHYSICS_TUNING_UNAVAILABLE: ${loaded.reason}`;refreshPhysics();},error=>{inspectedDocumentReason=`PHYSICS_TUNING_UNAVAILABLE: ${errorText(error)}`;refreshPhysics();});
}
/** The panel's rows: the inspected model's constraints against the handoff config's (both must be read). */
function refreshPhysics():void {
 if(!physicsPanel)return;
 if(inspectedDocumentReason){physicsPanel.load({available:false,reason:inspectedDocumentReason},[]);return;}
 if(!inspectedDocument)return;
 if(!rebuildStatus){text('physics-panel-state','Reading the producer handoff…');return;}
 if(!rebuildStatus.inputs||!rebuildStatus.producer){physicsPanel.load({available:false,reason:rebuildStatus.reason??'PHYSICS_TUNING_UNAVAILABLE: no producer handoff'},[]);return;}
 const bones=(inspectedDocument as {bones?:unknown}).bones,list=Array.isArray(bones)?bones.filter((b):b is {name:string;parent?:string}=>!!b&&typeof (b as {name?:unknown}).name==='string'):[];
 physicsPanel.load(tuningRows(rebuildStatus.constraints??null,inspectedDocument),list);
 refreshIdle();
}
/** The Idle tracks panel (#104): the config's idle and its keying from `GET /api/rebuild`, the drawn model's bone setups. */
function refreshIdle():void {
 if(!idlePanel||!rebuildStatus)return;
 idlePanel.load(rebuildStatus.idle??null,rebuildStatus.inputs?null:rebuildStatus.reason??'IDLE_TRACKS_UNAVAILABLE: no producer handoff');
 if(!stageDocumentSet&&inspectedDocument)idlePanel.model(boneSetup(inspectedDocument));
}
let stageDocumentSet=false;
/** A model document's bone setups as play poses them before the timelines (absent channels are play's defaults). */
function boneSetup(document:unknown):BoneSetup {
 const list=(document as {bones?:unknown}).bones,map=new Map<string,Partial<Record<LocalChannel,number>>>();
 for(const b of Array.isArray(list)?list:[]){if(!b||typeof (b as {name?:unknown}).name!=='string')continue;const o=b as Record<string,unknown>,v:Partial<Record<LocalChannel,number>>={};for(const c of ['rotation','x','y','scaleX','scaleY','shearX','shearY'] as const)if(typeof o[c]==='number')v[c]=o[c] as number;map.set(o.name as string,v);}
 return {names:[...map.keys()],get:bone=>map.get(bone)};
}
/** Setup's mesh edit: the selected slot's actual mesh as a typed delta. A two-file client download; nothing reaches the session or the package. */
/** Edit Mesh's source (#100): the selected slot's mesh in the model document at the setup pose (a never-played player's bones). */
function meshSource(){
 if(data.manifest.model&&!partModel)return {ok:false as const,code:'MESH_EDIT_RIG_UNAVAILABLE: the compiled model document is still loading'};
 return meshEditSource({slot:parts?.value()?.slot??null,model:data.manifest.model?partModel:null,pose:slot=>assets?readSetupPose(assets,slot,document.createElement('div')):null,mapping:chestMapping});
}
async function exportMesh(doc:MeshEditDocument):Promise<void> {
 const text=meshEditText(doc),digest=await sha256Hex(text);
 const binding=meshEditBinding({fileSha256:digest,sourceHash:data.sourceHash,reviewedSource:data.reviewedSource,exportedAt:new Date().toISOString(),mapping:chestMapping.available?chestMapping.basis:chestMapping.reason,attachment:{slot:doc.slot,skin:doc.skin,name:doc.attachment,sha256:doc.source.hash}});
 download('mesh-edit.json',text,'application/json');download('mesh-edit.binding.json',JSON.stringify(binding,null,2)+'\n','application/json');
 message(`Downloaded mesh-edit.json (${doc.ops.length} ops) and mesh-edit.binding.json. The delta is review evidence, not an approval; the package is unchanged and the producer retriangulates.`);
}
/**
 * Retarget Apply (#114): `{retarget: {sequence, map, flags, configHash}}` to `/api/rebuild`, where the server runs the
 * installed `rig-pose clean` and `rig-pose retarget` and the shared tail into scratch. On a built job the scratch build
 * replaces the drawn rig in place, the new animation is chosen and the sequence is shown as the reference beside it; the
 * draft keeps the record (map by content, flags and their argv), the producer's line, the motion summary and the lines.
 * A refusal leaves the stage as it was and shows every FAIL line verbatim.
 */
async function applyRetarget(body:{sequence:string;map:PoseMap;flags:RetargetFlags}):Promise<RetargetJobView|RebuildRefusal|null> {
 if(rebuildBusy){retargetPanel?.status('REBUILD_BUSY: an Apply is still running',true);return null;}
 if(readOnly){retargetPanel?.status(readOnly,true);return null;}
 const status=rebuildStatus??await loadRebuildStatus();
 if(!status?.inputs){retargetPanel?.status(status?.reason??'REBUILD_STATUS_UNAVAILABLE',true);return null;}
 const request:RetargetRequestBody={retarget:{...body,configHash:status.inputs.configHash}},world=stageWorld();
 rebuildBusy=true;rebuildState();retargetPanel?.busy(true);retargetPanel?.result(null);
 retargetPanel?.status(`Retargeting ${body.sequence} as "${body.flags.animation}" with ${status.retarget?.producer?.package??'@rig-c/pose'} ${status.retarget?.producer?.version??''}: ${body.flags.clean?'clean, ':''}retarget, compile…`,false);
 try{
  const result=await runRebuild<RetargetRequestBody,RetargetJobView>(request,{post:value=>api<RetargetJobView|RebuildRefusal>('/api/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),get:id=>api<RetargetJobView>(`/api/rebuild/${id}`),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),onLine:text=>retargetPanel?.line(text)});
  const outcome=retargetOutcomeLine(result),next=stageModel(result,{url:'',hash:stageModelHash??''});
  retargetPanel?.result(result);retargetPanel?.status(outcome.text,outcome.error);
  if(next.id===null||!('id' in result)){message(outcome.text,true);return result;}
  await swapRig(new URL(access.route(next.url),location.href).href,access.route(`/rebuild/${next.id}/`),next.hash,world);
  // The new animation's own clock (the run's report frameTimes), bound to this build: the transport counter and the rig pane read it.
  stageClock=retargetStage(result,next.hash)?.clock??null;
  appliedOnStage=retargetAppliedRecord(result);stageCheck=null;stageChanged({kind:'apply',via:'retarget'});
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=JSON.stringify(appliedOnStage);draft.dispatchEvent(new Event('input',{bubbles:true}));
  // The new animation plays against the reference: choose it, and show the sequence it was made from beside it.
  const name=result.request.record.flags.animation;if(assets?.animations.some(clip=>clip.name===name))chooseAnimation(name);
  const ref=result.request.record.sequence.reference;if(data.manifest.references.some(r=>r.id===ref)&&select('reference-select').value!==ref){select('reference-select').value=ref;await showReference(ref);}
  message(outcome.text,outcome.error);
  return result;
 }catch(error){const text=`REBUILD_FAILED: ${errorText(error)}`;retargetPanel?.status(text,true);message(text,true);return {status:'refused',error:text,producerLine:null};}
 finally{rebuildBusy=false;rebuildState();retargetPanel?.busy(false);}
}
/**
 * Edit Mesh's Apply · Rebuild (#135): `{part, delta, configHash}` to `/api/rebuild`, where the server runs
 * `rig-parts remesh --delta` and the shared tail; on a built job the revision replaces the drawn rig in place under the
 * same world, and the draft keeps the applied delta (by content and hash), the producer's line, op "remesh", the
 * per-file diff and the part's counts. A refusal leaves the stage as it was and returns the producer's line verbatim.
 */
async function applyMeshDelta(doc:MeshEditDocument,line:(text:string)=>void):Promise<{built:boolean;text:string;error:boolean}> {
 if(rebuildBusy)return {built:false,text:'REBUILD_BUSY: an Apply is still running',error:true};
 if(readOnly)return {built:false,text:readOnly,error:true};
 const status=rebuildStatus??await loadRebuildStatus();
 if(!status?.inputs)return {built:false,text:status?.reason??'REBUILD_STATUS_UNAVAILABLE',error:true};
 const body:DeltaRequestBody={part:doc.slot,delta:doc,configHash:status.inputs.configHash},world=stageWorld();
 rebuildBusy=true;rebuildState();
 try{
  const result=await runRebuild<DeltaRequestBody,DeltaJobView>(body,{post:value=>api<DeltaJobView|RebuildRefusal>('/api/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),get:id=>api<DeltaJobView>(`/api/rebuild/${id}`),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),onLine:text=>line(text)});
  const outcome=deltaOutcomeLine(result),next=stageModel(result,{url:'',hash:stageModelHash??''});
  if(next.id===null||!('id' in result)){message(outcome.text,true);return {built:false,text:outcome.text,error:true};}
  await swapRig(new URL(access.route(next.url),location.href).href,access.route(`/rebuild/${next.id}/`),next.hash,world);
  appliedOnStage=deltaAppliedRecord(result);stageCheck=null;stageChanged({kind:'apply',via:'delta'});
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=JSON.stringify(appliedOnStage);draft.dispatchEvent(new Event('input',{bubbles:true}));
  message(outcome.text);
  return {built:true,text:outcome.text,error:false};
 }catch(error){const text=`REBUILD_FAILED: ${errorText(error)}`;message(text,true);return {built:false,text,error:true};}
 finally{rebuildBusy=false;rebuildState();}
}
/** `GET /api/rebuild`: whether Apply can run, and the producer config's regions to start an untouched editor from. */
async function loadRebuildStatus():Promise<RebuildStatusView|null> {
 try{rebuildStatus=await api<RebuildStatusView>('/api/rebuild');}catch(error){rebuildStatus=null;chestEditor?.notify(`REBUILD_STATUS_UNAVAILABLE: ${errorText(error)}`,true);return null;}
 const seed={...(seedFields(rebuildStatus,chestField)??{}),...(seedLandmarks(rebuildStatus,chestField)??{})};
 if(Object.keys(seed).length){for(const [id,value] of Object.entries(seed)){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;if(!node)continue;if(node instanceof HTMLInputElement&&node.type==='checkbox')node.checked=value==='true';else node.value=value;}el('chest-regions').dispatchEvent(new Event('input',{bubbles:true}));}
 if(!rebuildStatus.available)chestEditor?.notify(rebuildStatus.reason,true);
 renderHandoff(rebuildStatus);refreshPhysics();
 retargetPanel?.load(rebuildStatus.retarget??null,rebuildStatus.reason);
 bonesPanel?.load(rebuildStatus.inputs?rebuildStatus.bones??[]:null,rebuildStatus.inputs?null:rebuildStatus.reason??'BONES_UNAVAILABLE: no producer handoff');
 rigFieldsPanel?.load(rebuildStatus.inputs?rebuildStatus.fields??{}:null,rebuildStatus.inputs?null:rebuildStatus.reason??'RIG_FIELDS_UNAVAILABLE: no producer handoff');
 clothPanel?.load(rebuildStatus.inputs?rebuildStatus.cloth??null:null,rebuildStatus.inputs?null:rebuildStatus.reason??'CLOTH_UNAVAILABLE: no producer handoff');
 cutsPanel?.load(rebuildStatus.inputs&&rebuildStatus.cuts?rebuildStatus.cuts.config:null,rebuildStatus.bones??[],rebuildStatus.inputs?null:rebuildStatus.reason??'CUTS_UNAVAILABLE: no producer handoff',rebuildStatus.cuts?.build??null);
 meshPanel?.load(rebuildStatus.inputs?rebuildStatus.meshes??{}:null,rebuildStatus.inputs?null:rebuildStatus.reason??'MESH_PANEL_UNAVAILABLE: no producer handoff');meshPanel?.select(parts?.value()?.slot??null);
 return rebuildStatus;
}
/** The handoff line (#101): path, hash and how it was found, then the baseline; re-read while the baseline runs. */
let handoffTimer:ReturnType<typeof setTimeout>|null=null;
function renderHandoff(status:RebuildStatusView):void {
 const line=el('handoff-line'),shown=handoffText(status);line.textContent=shown.text;line.title=shown.text;line.classList.toggle('error',shown.error);
 if(handoffTimer)clearTimeout(handoffTimer);handoffTimer=null;
 if(status.baseline?.status==='running')handoffTimer=setTimeout(()=>{void api<RebuildStatusView>('/api/rebuild').then(next=>{rebuildStatus=next;renderHandoff(next);}).catch(()=>{});},2000);
}
function rebuildState():void {chestEditor?.rebuildState({busy:rebuildBusy,applied:!!appliedOnStage});renderApplied();if(!rebuildBusy)void refreshApplied();}
/** #166: the session's applied records (the server's stack), the last one on the stage when the stage shows it. */
let appliedHistory:AppliedHistoryView|null=null;
async function refreshApplied():Promise<void> {
 if(!inspectedModel)return;
 try{appliedHistory=await api<AppliedHistoryView>('/api/rebuild/history');}catch{return;}
 renderApplied();
}
/** #172: the Cuts and Cloth blocks mark as applied only the ops the stage's applied record holds (none on the inspected build). */
let readoutStage:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|null=null;
function renderAppliedBlocks():void {
 const on=appliedBlockOps(appliedOnStage);cutsPanel?.applied(on.cuts);clothPanel?.applied(on.cloth);
 // #186: when the stage record changes, a Cuts / Cloth readout the new record is not that block's names an older build.
 for(const block of staleReadouts(readoutStage,appliedOnStage))(block==='cuts'?cutsPanel:clothPanel)?.shown(null);
 readoutStage=appliedOnStage;
}
function renderApplied():void {
 renderAppliedBlocks();
 const section=document.getElementById('applied-records');if(!section)return;
 const h=appliedHistory;section.hidden=!h||h.depth===0;
 const list=el('applied-list');list.replaceChildren(...(h?.records??[]).map((r,i)=>{const li=document.createElement('li');li.textContent=historyRow(h!,i);li.dataset.buildId=r.id;li.classList.toggle('on-stage',i===h!.records.length-1&&appliedOnStage?.buildId===r.id);return li;}));
 const control=undoControl(h,appliedOnStage?.buildId??null,rebuildBusy||!!readOnly),undo=button('applied-undo');
 undo.textContent=control.label;undo.disabled=!control.enabled;undo.title=control.title;
}
function appliedStatus(text:string,error=false):void {const node=el('applied-status');node.textContent=text;node.classList.toggle('error',error);}
/**
 * #166: Undo last Apply — the last record leaves the server's stack and the stage returns to its predecessor's build
 * (kept on disk, or re-run from its record when evicted) or to the inspected build, under the same world. The feedback
 * context then carries the post-undo record (or null), never the reverted one. A refusal leaves the stage as it was.
 */
async function undoApply():Promise<UndoView|null> {
 const from=appliedOnStage?.buildId;
 if(rebuildBusy||readOnly||!from||!inspectedModel)return null;
 const world=stageWorld();
 rebuildBusy=true;rebuildState();appliedStatus('Undoing the last Apply…');
 try{
  let result=await api<UndoView>('/api/rebuild/undo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({from})});
  if(result.status==='running'){
   // An evicted predecessor re-runs its recorded step; its lines stream like an Apply's.
   let job=result.job as AnyJobView;const undone=result.undone;let seen=0;
   while(job.status==='running'){await new Promise(resolve=>setTimeout(resolve,700));job=await api<AnyJobView>(`/api/rebuild/${job.id}`);for(;seen<job.lines.length;seen++)appliedStatus(job.lines[seen]!.trim()||'…');}
   if(job.status!=='built'){const text=refusedText(job);appliedStatus(text,true);message(text,true);return {status:'refused',error:text,producerLine:job.producerLine};}
   result={status:'built',undone,job,history:await api<AppliedHistoryView>('/api/rebuild/history')};
  }
  if(result.status==='refused'){appliedStatus(result.error,true);message(result.error,true);return result;}
  let ops:import('../src/config-patch.ts').PatchOp[]|null=null;
  if(result.status==='inspected'){await swapRig(inspectedModel.url,inspectedModel.prefix,inspectedModel.sha256,world);appliedOnStage=null;stageCheck=null;}
  else{
   const job=result.job;if(!job.build)throw new Error('the restored job carries no build');
   await swapRig(new URL(access.route(job.build.modelUrl),location.href).href,access.route(`/rebuild/${job.id}/`),job.build.modelHash,world);
   appliedOnStage=recordFor(job);stageCheck=(job as PatchJobView).kind==='patch'?{lines:[...job.lines],check:(job as PatchJobView).check}:null;
   if((job as PatchJobView).kind==='patch')ops=(job as PatchJobView).request.patch.ops;
   // #186: a restored retarget build gets what its Apply set — its own clock, then its animation selected.
   const retarget=retargetStage(job,job.build.modelHash);stageClock=retarget?.clock??null;
   if(retarget&&assets?.animations.some(clip=>clip.name===retarget.animation))chooseAnimation(retarget.animation);
  }
  stageChanged({kind:'undo'});
  // The panels mark the ops the stage's build applied; the pending edits stay as they are.
  physicsPanel?.applied(ops);idlePanel?.applied(ops);rigFieldsPanel?.applied(ops);bonesPanel?.applied(ops);
  // #172: the Cuts and Cloth readouts show the restored build's job when it is theirs, else nothing (never the reverted one).
  const restored=result.status==='built'&&isPatchJob(result.job)?result.job:null,block=recordBlock(appliedOnStage);
  cutsPanel?.shown(block==='cuts'?restored:null);clothPanel?.shown(block==='cloth'?restored:null);
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=appliedOnStage?JSON.stringify(appliedOnStage):'';draft.dispatchEvent(new Event('input',{bubbles:true}));
  appliedHistory=result.history;
  const text=`Undid ${result.undone.slice(0,12)}… · the stage is ${result.status==='inspected'?`the inspected build (model ${inspectedModel.sha256.slice(0,12)}…)`:`record ${result.history.depth} (model ${stageModelHash?.slice(0,12)}…)`} · ${result.history.depth} applied record(s) left`;
  appliedStatus(text);message(text);redrawOverlay(true);
  return result;
 }catch(error){const text=`UNDO_FAILED: ${errorText(error)}`;appliedStatus(text,true);message(text,true);return {status:'refused',error:text,producerLine:null};}
 finally{rebuildBusy=false;rebuildState();}
}
/** Apply · Rebuild: the rows go to the installed producer; on success its scratch build replaces the drawn rig in place. */
async function applyRebuild():Promise<void> {
 if(rebuildBusy)return;
 if(readOnly){chestEditor?.notify(readOnly,true);return;}
 const status=rebuildStatus??await loadRebuildStatus();
 if(!status||!status.available||!status.inputs){const reason=status?.reason??'REBUILD_STATUS_UNAVAILABLE';chestEditor?.notify(reason,true,[reason]);message(reason,true);return;}
 let part:string,body:RebuildRequestBody;const lines:string[]=[];
 if(chestEditor?.mode()==='landmarks'){
  // #105: refused here, before anything is sent, when a point is missing or the circles would not clear.
  const request=landmarksRequest(status,chestEditor.landmarks());if('error' in request){chestEditor.notify(request.error,true,[request.error]);message(request.error,true);return;}
  ({part,body}=request);
 }else{
  const designated=designatedRegions(chestField);if('error' in designated){chestEditor?.notify(designated.error,true);return;}
  const picked=pickPart(status,designated.regions);if(!picked){chestEditor?.notify(`REBUILD_PART_AMBIGUOUS: the config states ${status.parts.length} contour meshes and the designated bones name none of them alone`,true);return;}
  part=picked;body={part,regions:designated.regions,configHash:status.inputs.configHash};
 }
 rebuildBusy=true;rebuildState();chestEditor?.notify(`Rebuilding ${part} with ${status.producer?.package} ${status.producer?.version}…`,false,[]);
 try{
  const result=await runRebuild(body,{post:value=>api<RebuildJobView|RebuildRefusal>('/api/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),get:id=>api<RebuildJobView>(`/api/rebuild/${id}`),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
   onLine:line=>{lines.push(line);chestEditor?.notify(line.trim()||'…',false,lines.slice(-6));}});
  const outcome=outcomeLine(result);
  // A refusal stays readable in full: the bar's status line is one line, so the log ends with the producer's line verbatim.
  if(!('id' in result)||result.status!=='built'||!result.build){chestEditor?.notify(outcome.text,true,[...lines.slice(-5),outcome.text]);message(outcome.text,true);return;}
  await swapRig(new URL(access.route(result.build.modelUrl),location.href).href,access.route(`/rebuild/${result.id}/`),result.build.modelHash);
  appliedOnStage=appliedRecord(result);stageCheck=null;stageChanged({kind:'apply',via:'regions'});
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=JSON.stringify(appliedOnStage);draft.dispatchEvent(new Event('input',{bubbles:true}));
  // The log closes on success so nothing floats over the rebuilt stage; a refusal keeps it open.
  chestEditor?.notify(outcome.text,false,[]);message(outcome.text);
 }catch(error){chestEditor?.notify(`REBUILD_FAILED: ${errorText(error)}`,true);message(`REBUILD_FAILED: ${errorText(error)}`,true);}
 finally{rebuildBusy=false;rebuildState();}
}
/**
 * Apply a config patch (#102): the same stream, in-place reload and Reset as a region Apply. The patch goes to the
 * installed producer through `POST /api/rebuild {patch}`; on a built job the scratch build replaces the drawn rig with
 * the same camera, animation, time, set and environment, and the draft keeps the patch, its hash, the producer's line
 * and check's summary. A refusal leaves the stage as it was and shows the producer's line verbatim. No editing UI calls
 * this yet (#103+); `window.rigReviewEditor.applyPatch` is its entry point.
 */
async function applyPatch(patch:ConfigPatch,world:StageWorld|null=null):Promise<PatchJobView|RebuildRefusal> {
 if(rebuildBusy)return {status:'refused',error:'REBUILD_BUSY: an Apply is still running',producerLine:null};
 if(readOnly){chestEditor?.notify(readOnly,true);return {status:'refused',error:readOnly,producerLine:null};}
 const lines:string[]=[];
 rebuildBusy=true;rebuildState();chestEditor?.notify(`Applying patch (${patch.op.cmd}, ${patch.ops.length} op(s))…`,false,[]);
 try{
  // #112: with "Use for readings" on, Apply's check reads the exported schedule of the clip check renders (its idle).
  const scheduled=useWorld()?worldFor(checkAnimation()):null;
  if(scheduled&&'error' in scheduled){chestEditor?.notify(scheduled.error,true);message(scheduled.error,true);return {status:'refused',error:scheduled.error,producerLine:scheduled.error};}
  const result=await runRebuild<{patch:ConfigPatch;environment?:WorldExport['schedule']},PatchJobView>({patch,...(scheduled?{environment:scheduled.schedule}:{})},{post:value=>api<PatchJobView|RebuildRefusal>('/api/rebuild',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}),get:id=>api<PatchJobView>(`/api/rebuild/${id}`),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
   onLine:line=>{lines.push(line);chestEditor?.notify(line.trim()||'…',false,lines.slice(-6));}});
  const outcome=patchOutcomeLine(result),next=stageModel(result,{url:'',hash:stageModelHash??''});
  if(next.id===null||!('id' in result)){chestEditor?.notify(outcome.text,true,[...lines.slice(-5),outcome.text]);message(outcome.text,true);return result;}
  await swapRig(new URL(access.route(next.url),location.href).href,access.route(`/rebuild/${next.id}/`),next.hash,world);
  appliedOnStage=patchAppliedRecord(result);stageCheck={lines:[...result.lines],check:result.check};stageChanged({kind:'apply',via:'patch'});
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=JSON.stringify(appliedOnStage);draft.dispatchEvent(new Event('input',{bubbles:true}));
  chestEditor?.notify(outcome.text,outcome.error,[]);message(outcome.text,outcome.error);
  return result;
 }catch(error){const text=`REBUILD_FAILED: ${errorText(error)}`;chestEditor?.notify(text,true);message(text,true);return {status:'refused',error:text,producerLine:null};}
 finally{rebuildBusy=false;rebuildState();}
}
/** The client's edit entry point for automation and the edit cards to come: apply a patch, return to the inspected build, read the stage. */
(window as unknown as {rigReviewEditor:unknown}).rigReviewEditor={
 applyPatch,reset:()=>resetRebuild(),
 /** #166: undo the last Apply, and the applied records as the server holds them. */
 undo:()=>undoApply(),history:()=>appliedHistory?JSON.parse(JSON.stringify(appliedHistory)):null,
 status:async()=>rebuildStatus??await loadRebuildStatus(),
 physics:{rows:()=>physicsPanel?.rows()??[],chains:()=>physicsPanel?.chains()??[],edits:()=>physicsPanel?.edits()??[],preview:()=>physicsPreview.read(),clearPreview:()=>physicsPanel?.clearPreview(),set:(name:string,field:Parameters<PhysicsPanel['set']>[1],value:number)=>physicsPanel?.set(name,field,value),ramp:(id:string,field:Parameters<PhysicsPanel['set']>[1],root:number,tip:number)=>physicsPanel?.ramp(id,field,root,tip),select:(name:string)=>physicsPanel?.select(name),apply:()=>applyPhysics(physicsPanel?.edits().map(e=>({op:e.op,path:e.path,value:e.value,name:e.name}))??[]),reset:()=>resetPhysicsBuild()},
 /** Inspection only: one slot's posed world geometry on the drawn frame (what the stage drew), for comparing against `rigc render --geometry`. */
 posed:(slot:string)=>{const frame=player?.posedFrame();const found=frame?.order.find(item=>item.slot===slot);return found?JSON.parse(JSON.stringify(found,(key,value)=>key==='bitmap'||key==='image'||key==='page'?undefined:value)):null;},
 bone:(name:string)=>player?JSON.parse(JSON.stringify(player.bone(name))):null,
 /** Inspection only (#100): Edit Mesh's setup-space source (crop px per vertex, unrounded) and its drawn vertices as page client pixels. */
 meshEdit:()=>{
  const session=meshEditor?.session(),overlay=meshEditor?.overlay();if(!session||!overlay)return null;
  const s=session.source,project=rigProject(),view=el('rig-root').parentElement!.getBoundingClientRect();
  return {slot:s.slot,skin:s.skin,attachment:s.attachment,hash:s.hash,hull:s.hull,triangles:s.triangles.length/3,vertices:s.vertices,ops:session.ops(),
   drawn:overlay.vertices.map(v=>{const p=project(v.at.x,v.at.y);return {x:p.x+view.left,y:p.y+view.top,state:v.state};})};
 },
 /** Inspection only: a world point (y up) as page client pixels on the rig pane, the projection the overlays draw with. */
 screen:(x:number,y:number)=>{const p=rigProject()(x,y),view=el('rig-root').parentElement!.getBoundingClientRect();return {x:p.x+view.left,y:p.y+view.top};},
 /**
  * Inspection only, a fixed schedule: pause, reopen the track at 0 and step it `round(t/dt)` times by `dt`. With `steps`
  * (`rigc-environment/1` steps: x right, y down) each step is set before the step that poses the first frame at or after
  * its `t`, the way `rigc render --environment` steps a build; without, the environment as it stands. The page's own
  * environment is put back afterwards; no jolt is replayed and the wind clock is untouched.
  */
 replay:(t:number,dt:number,steps:readonly {t:number;wind?:[number,number];gravity?:[number,number]}[]=[])=>{
  if(!player?.current||!(dt>0)||!(t>=0))return null;
  const at=(k:number)=>{for(const step of steps)if(Math.max(0,Math.ceil(step.t/dt-1e-9))===k)player!.environment({...(step.wind?{wind:step.wind}:{}),...(step.gravity?{gravity:step.gravity}:{})});};
  pause();if(steps.length)player.environment(null);at(0);player.seek(0);player.resume();
  try{for(let k=1,n=Math.round(t/dt);k<=n;k++){at(k);player.frame(dt);}}finally{player.pause();}
  drawRig(()=>player!.draw());time=player.time;renderTransport();
  const posedTime=player.time;if(steps.length){if(environmentApplied())player.environment(environmentFor(wind.read(),gravityValue()));else player.environment(null);}
  return posedTime;},
 /** Readings (#108): run (the pickers' choice, or the given readings), the last job, the ticks drawn and the worst lines shown. */
 /** #112: the exported schedule of a clip (the drawn one by default), Use for readings, and Check under this world. */
 world:{schedule:(name?:string)=>{const w=worldFor(name??animation);return 'error' in w?w:{text:w.text,sha256:w.sha256,summary:w.summary,form:w.export.form,tolerance:w.export.tolerance};},use:(on:boolean)=>{input('environment-use').checked=on;input('environment-use').dispatchEvent(new Event('change'));return useWorld();},check:()=>runEnvironmentCheck(),lines:()=>[...el('environment-check-lines').children].map(c=>c.textContent??'')},
 readings:{run:(readings?:import('../src/readings.ts').ReadingRequest[])=>runReadings(readings?{readings}:undefined),job:()=>readingsJob?JSON.parse(JSON.stringify(readingsJob)):null,ticks:()=>[...document.querySelectorAll<HTMLButtonElement>('#reading-ticks .reading-tick')].map(t=>({build:t.dataset.build,frame:Number(t.dataset.frame),left:t.style.left})),lines:()=>readingsPanel?.shownLines()??[],context:()=>readingsContext()},
 /** Idle tracks (#104): the panel's state and ops, its edits, Apply and Reset, the preview, and the inspection-only `sample`. */
 idle:{state:()=>idlePanel?.state()??null,ops:()=>idlePanel?.ops()??[],source:()=>idlePanel?.source()??null,keying:()=>idlePanel?.keying()??null,refusals:()=>idlePanel?.refusals()??[],
  select:(key:string)=>idlePanel?.select(key),field:(key:string,field:Parameters<IdlePanel['field']>[1],value:number|null)=>idlePanel?.field(key,field,value),linkAmp:(key:string,link:number,value:number)=>idlePanel?.linkAmp(key,link,value),
  add:(spec:Parameters<IdlePanel['add']>[0])=>idlePanel?.add(spec),remove:(key:string)=>idlePanel?.remove(key),blink:(field:Parameters<IdlePanel['blink']>[0],value:number)=>idlePanel?.blink(field,value),
  preview:()=>idlePanel?.previewing()??null,setPreview:(on:boolean)=>idlePanel?.setPreview(on),
  apply:()=>applyIdle(idlePanel?.ops()??[],idlePanel?.keying()?.keys??null),reset:()=>resetIdleBuild(),
  sample:(bone:string,dt:number,n:number)=>sampleLocals(bone,dt,n),adjustSet:()=>!!player?.adjust},
 /** Mesh panel (#106): the selected part's pending entry, its edits, Apply, Reset, the folds reading and the overlay's triangle count per slot. */
 mesh:{part:()=>meshPanel?.part()??null,select:(part:string)=>meshPanel?.select(part),entry:()=>meshPanel?.entry()??null,configEntry:()=>meshPanel?.configEntry()??null,set:(path:string[],value:import('../src/config-patch.ts').JsonValue|undefined)=>meshPanel?.set(path,value),setEntry:(entry:MeshEntry)=>meshPanel?.setEntry(entry),
  regions:()=>meshPanel?.regions.list()??[],addRegion:(region:import('../src/mesh-entry.ts').MeshRegion)=>meshPanel?.regions.add(region),moveRegion:(region:number,vertex:number,to:[number,number])=>meshPanel?.regions.move(region,vertex,to),drawRegions:(on:boolean)=>meshPanel?.regions.draw(on),placing:()=>meshPanel?.regions.placing()??null,
  precheck:()=>meshPanel?.precheck()??[],apply:()=>{const part=meshPanel?.part(),entry=meshPanel?.entry();return part&&entry?applyMesh(part,entry):Promise.resolve(null);},reset:()=>resetMeshBuild(),folds:()=>meshFolds(),
  overlayTriangles:(slot:string)=>lastOverlay?.meshTriangles[slot]??null,status:()=>el('mesh-status').textContent,counts:()=>[...document.querySelectorAll('#mesh-counts code')].map(c=>c.textContent),readout:()=>[...document.querySelectorAll('#mesh-readout code')].map(c=>c.textContent),pending:()=>input('mesh-pending').value,lastPatch:()=>lastMeshPatch?JSON.parse(JSON.stringify(lastMeshPatch)):null,
  /** #173: the density strip — build N values, the view, load a row as pending, back, close. */
  strip:{build:(values:number[])=>buildDensityStrip(values),view:()=>stripView?JSON.parse(JSON.stringify(stripView)):null,load:(i:number)=>loadStripRow(i),back:()=>stripBack(),close:()=>closeDensityStrip(),pending:()=>stripPending?{index:stripPending.index,candidate:stripPending.candidate}:null,
   applied:()=>appliedOnStage?JSON.parse(JSON.stringify(appliedOnStage)):null,stageHash:()=>stageModelHash}},
 /** #115: the Cuts block — its handles as client pixels (for a real-pointer drag), its ops, Apply and Reset. */
 cuts:{source:()=>cutsPanel?.source()??null,ops:()=>cutsPanel?.ops()??[],handles:()=>cutsPanel?.handles()??[],active:()=>cutsPanel?.active()??false,setActive:(on:boolean)=>cutsPanel?.setActive(on),
  setVertex:(cut:number,k:number,value:[number,number])=>cutsPanel?.setVertex(cut,k,value),setBox:(i:number,value:[number,number,number,number])=>cutsPanel?.setBox(i,value),setRange:(limb:string,k:number,value:[number,number]|null)=>cutsPanel?.setRange(limb,k,value),
  apply:()=>cutsPanel?.apply()??Promise.resolve(null),reset:()=>resetCutsBuild(),applied:()=>cutsPanel?.appliedItems()??[]},
 /** #111: the Cloth block — the selected tag, its form values, the pending ops, the link preview, Apply and Reset. */
 cloth:{tag:()=>clothPanel?.tag()??'',select:(tag:string)=>clothPanel?.select(tag),values:(tag?:string)=>clothPanel?.values(tag)??{},set:(key:string,text:string,tag?:string)=>clothPanel?.set(key,text,tag),declare:(on:boolean,tag?:string)=>clothPanel?.declare(on,tag),
  ops:()=>clothPanel?.ops()??[],links:()=>clothPanel?.links()??null,active:()=>clothPanel?.active()??false,setActive:(on:boolean)=>clothPanel?.setActive(on),apply:()=>clothPanel?.apply()??Promise.resolve(null),reset:()=>resetClothBuild(),applied:()=>clothPanel?.appliedItems()??[],status:()=>el('cloth-status').textContent,readout:()=>[...document.querySelectorAll('#cloth-readout code')].map(c=>c.textContent)},
 bones:{anchors:()=>bonesPanel?.anchors()??[],edits:()=>bonesPanel?.edits()??[],set:(path:string,value:[number,number])=>bonesPanel?.set(path,value),select:(name:string|null)=>bonesPanel?.select(name),
  active:()=>bonesPanel?.active()??false,setActive:(on:boolean)=>bonesPanel?.setActive(on),handles:()=>bonesPanel?.handles()??[],check:()=>bonesPanel?.check()??Promise.resolve(null),
  apply:()=>applyBones((bonesPanel?.edits()??[]).map(e=>({op:'replace' as const,path:e.path,value:[...e.value],name:e.name}))),reset:()=>resetBonesBuild(),
  status:()=>el('bones-status').textContent,lines:()=>[...document.querySelectorAll('#bones-lint code, #bones-lint summary')].map(c=>c.textContent),compare:()=>[...document.querySelectorAll('#bones-compare code')].map(c=>c.textContent),pending:()=>input('bones-pending').value},
 /** Rig fields (#110): the block's source, edits and ops, each field's setter, the dial, the stage handles, Apply and Reset. */
 fields:{source:()=>rigFieldsPanel?.source()??null,edits:()=>rigFieldsPanel?.edits()??[],ops:()=>rigFieldsPanel?.ops()??[],
  region:(part:string,bone:string)=>rigFieldsPanel?.region(part,bone),still:(part:string,entry:{row:number;bone:string}|null)=>rigFieldsPanel?.still(part,entry),stop:(index:number,bounds:{inward?:number;outward?:number})=>rigFieldsPanel?.stop(index,bounds),
  inherit:(index:number,mode:string|null,link?:string)=>rigFieldsPanel?.inherit(index,mode,link),turn:(target:{pivot:number}|{part:string;depth:number})=>rigFieldsPanel?.turn(target),
  select:(kind:'part'|'still'|'stop'|'bone',value:string|number|null)=>rigFieldsPanel?.select(kind,value),setDial:(x:number)=>rigFieldsPanel?.setDial(x),dial:()=>rigFieldsPanel?.dialState()??null,handles:()=>rigFieldsPanel?.handles()??[],
  apply:()=>applyRigFields(rigFieldsPanel?.ops()??[]),reset:()=>resetRigFieldsBuild(),status:()=>el('rig-fields-status').textContent,readout:()=>[...document.querySelectorAll('#rig-fields-readout code')].map(c=>c.textContent),pending:()=>input('rig-fields-pending').value},
 /** Retarget (#114): the editor's map and flags, Apply (through the panel's own pre-check) and the listed lines shown. */
 retarget:{map:()=>retargetPanel?.map()??null,setMap:(map:PoseMap)=>retargetPanel?.setMap(map),include:(chain:string,on:boolean)=>retargetPanel?.include(chain,on),pick:(chain:string,index:number,bone:string)=>retargetPanel?.pick(chain,index,bone),flags:()=>retargetPanel?.flags()??null,setFlags:(flags:Partial<RetargetFlags>)=>retargetPanel?.setFlags(flags),apply:()=>{const button=document.getElementById('retarget-apply') as HTMLButtonElement|null;button?.click();},status:()=>el('retarget-status').textContent,lines:()=>retargetPanel?.shownLines()??[],refusals:()=>[...document.querySelectorAll('#retarget-refusals code')].map(c=>c.textContent)},
 stage:()=>({modelHash:stageModelHash,inspectedHash:inspectedModel?.sha256??null,applied:appliedOnStage?JSON.parse(JSON.stringify(appliedOnStage)):null,animation,time:player?.time??time,playing,busy:rebuildBusy}),
};
/** The world as it stands now: what a physics Apply's reload resumes. */
function stageWorld():StageWorld {return {wind:wind.state(),jolts:joltQueue.map(step=>({...step})),applied:environmentApplied(),gravity:gravityValue()};}
/**
 * Physics Apply (#103): the pending ops become one config patch (`rig`, then check) against the handoff config; the
 * scratch build reloads under the world Apply was pressed in, and the readout shows the two check lines before (the
 * build that was on the stage) and after. A refusal shows the producer's line verbatim and leaves the stage as it was.
 */
async function applyPhysics(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig'}):null;
 if(!patch){const reason=!ops.length?'PHYSICS_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';physicsPanel?.status(reason,true);return null;}
 physicsPanel?.clearPreview();
 const world=stageWorld(),before=stageCheck;
 physicsPanel?.busy(true);physicsPanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: ${patchRoute(patch.ops,patch.producer.version)} --config, compile, check…`,false);
 try{
  const result=await applyPatch(patch,world);
  const outcome=patchOutcomeLine(result);physicsPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built'){
   physicsPanel?.applied(result.request.patch.ops);
   // BEFORE for the inspected build is its stored background check (#108, HQ ruling); re-read while it still runs.
   const after={lines:[...result.lines],check:result.check};
   const show=()=>physicsPanel?.readout(readoutRows(before,before?null:inspectedCheckView(),after));
   show();if(!before)void followInspectedCheck(show);
  }
  return result;
 }finally{physicsPanel?.busy(false);}
}
/** The inspected build's check as the last `GET /api/rebuild` returned it. */
function inspectedCheckView():InspectedCheckView|null {return rebuildStatus?.inspectedCheck??null;}
/** While the inspected check runs, re-read the status and redraw the readout once it settles. */
async function followInspectedCheck(show:()=>void):Promise<void> {
 for(let i=0;i<120&&(!rebuildStatus?.inspectedCheck||rebuildStatus.inspectedCheck.status==='running');i++){
  try{rebuildStatus=await api<RebuildStatusView>('/api/rebuild');}catch{return;}
  show();if(rebuildStatus.inspectedCheck&&rebuildStatus.inspectedCheck.status!=='running')return;
  if(!rebuildStatus.inspectedCheck&&rebuildStatus.baseline?.status!=='running')return;
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
}
/**
 * Readings (#108): the pickers' readings of the drawn animation go to `POST /api/readings`, which runs `rigc render`
 * once per reading on the inspected build and on the latest scratch build; the finished job's frames become ticks and
 * its worst frames lines. The Environment block's wind and gravity go along only while its controls are applied.
 */
async function runReadings(override?:{readings:import('../src/readings.ts').ReadingRequest[]}):Promise<ReadingsJobView|ReadingsRefusal|null> {
 if(!readingsPanel||readingsBusy)return null;
 const chosen=override??readingsPanel.requests();
 if('error' in chosen){readingsPanel.status(chosen.error,true);return {status:'refused',error:chosen.error};}
 if(!animation){readingsPanel.status('READINGS_NO_ANIMATION: no animation is drawn',true);return null;}
 // #112: with "Use for readings" on, the exported schedule of the drawn clip goes in place of the standing world.
 let environment:ReturnType<typeof environmentFor>|WorldExport['schedule']|null=player&&environmentApplied()?environmentFor(wind.read(),gravityValue()):null;
 if(environment&&useWorld()){const world=worldFor(animation);if('error' in world){readingsPanel.status(world.error,true);return {status:'refused',error:world.error};}environment=world.schedule;}
 const body={animation,readings:chosen.readings,environment};
 readingsBusy=true;readingsPanel.busy(true);readingsPanel.status(`Running ${chosen.readings.length} reading(s) of ${animation} with rigc render…`,false);
 const started=performance.now();
 try{
  let job=await api<ReadingsJobView|ReadingsRefusal>('/api/readings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(error=>({status:'refused' as const,error:errorText(error).replace(/^\d+: /,'')}));
  if(!('id' in job)){const text=(()=>{try{return (JSON.parse(job.error) as {error?:string}).error??job.error;}catch{return job.error;}})();readingsPanel.status(text,true);return {status:'refused',error:text};}
  while(job.status==='running'){
   const done=job.runs.reduce((n,r)=>n+r.results.length,0),total=job.runs.length*job.request.readings.length;
   readingsPanel.status(`Running readings of ${animation}: ${done} of ${total} done…`,false);
   await new Promise(resolve=>setTimeout(resolve,800));
   job=await api<ReadingsJobView>(`/api/readings/${job.id}`);
  }
  if(job.status==='failed'){readingsPanel.status(job.error??'READINGS_FAILED',true);return job;}
  readingsJob=job;readingsPanel.lines(job);renderReadingTicks(true);
  const ticks=job.runs.map(r=>`${r.build} ${r.results.reduce((n,x)=>n+x.frames.length,0)} tick(s)`).join(' · ');
  const refused=job.runs.flatMap(r=>r.results).find(r=>r.status!=='read');
  const scheduled=job.request.environment&&'spec' in job.request.environment?job.request.environment:null;
  const env=job.environment.requested?(job.environment.passed?(scheduled?` · the exported schedule (${scheduled.steps.length} step(s)) passed as --environment`:' · wind and gravity passed as --environment'):' · this rigc has no --environment; the environment was not passed'):'';
  readingsPanel.status(`${refused?`${refused.refusal} · `:''}Readings of ${job.request.animation}: ${ticks}${job.runs.length<2?' · no scratch build yet (Apply builds one)':''}${env} · ${((performance.now()-started)/1000).toFixed(1)} s`,!!refused);
  return job;
 }catch(error){readingsPanel.status(`READINGS_FAILED: ${errorText(error)}`,true);return null;}
 finally{readingsBusy=false;readingsPanel.busy(false);}
}
/** `context.readings`: the last finished run's pairs and builds, or null when none ran. */
function readingsContext():ReadingsContext|null {
 const job=readingsJob;if(!job)return null;
 const ticks=(build:'inspected'|'scratch')=>{const run=job.runs.find(r=>r.build===build);return run?run.results.reduce((n,r)=>n+r.frames.length,0):null;};
 return {schema:READINGS_SCHEMA,animation:job.request.animation,requests:job.request.readings,environment:job.request.environment,environmentPassed:job.environment.passed,builds:{inspected:job.runs.find(r=>r.build==='inspected')?.modelHash??'',scratch:job.runs.find(r=>r.build==='scratch')?.id??null},compiler:job.compiler,ticks:{inspected:ticks('inspected')??0,scratch:ticks('scratch')}};
}
/** Requirements (#113): what the handoff's rig spec offers the panel, or why nothing does. */
async function loadRequirements():Promise<void> {
 try{const catalog=await api<RequirementsCatalogView>('/api/requirements');requirementsPanel?.load(catalog,catalog.reason);}
 catch(error){requirementsPanel?.load(null,`REQUIREMENTS_UNAVAILABLE: ${errorText(error)}`);}
}
/** Requirements Check (#113): typed requirements to `POST /api/requirements`, then its job until it settles; a refusal is shown verbatim. */
async function runRequirements(body:{fps:number;build:'inspected'|'scratch';requirements:Record<string,unknown>[]}):Promise<RequirementsJobView|RequirementsRefusal|null> {
 const unwrap=(error:unknown)=>{const text=errorText(error).replace(/^\d+: /,'');try{return (JSON.parse(text) as {error?:string}).error??text;}catch{return text;}};
 try{
  let job=await api<RequirementsJobView|RequirementsRefusal>('/api/requirements',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  while('id' in job&&job.status==='running'){await new Promise(resolve=>setTimeout(resolve,800));job=await api<RequirementsJobView>(`/api/requirements/${job.id}`);}
  return job;
 }catch(error){return {status:'refused',error:unwrap(error)};}
 finally{void loadRequirements();}
}
/** Bones Check (#109): the pending ops go to `POST /api/bones-check` with the handoff config's hash; a refusal is shown verbatim. */
async function checkBones(ops:PatchOp[]):Promise<BonesCheckView> {
 const status=rebuildStatus??await loadRebuildStatus();
 if(!status?.inputs)return {status:'refused',error:status?.reason??'REBUILD_STATUS_UNAVAILABLE'};
 try{return await api<BonesCheckView>('/api/bones-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ops,configHash:status.inputs.configHash})});}
 catch(error){const text=errorText(error).replace(/^\d+: /,'');let shown=text;try{shown=(JSON.parse(text) as {error?:string}).error??text;}catch{/* not JSON */}return {status:'refused',error:shown};}
}
/**
 * Bones Apply (#109): the pending ops become one config patch (`rig`, then check) against the handoff config — a
 * whole-rig op, so the server refuses it (`EDIT_BASELINE_MISMATCH`) unless the baseline reproduced the inspected rig.
 * On a build the re-weighted rig reloads in place (the Weights view reads the revision); a refusal is shown verbatim.
 */
async function applyBones(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig'}):null;
 if(!patch){const reason=!ops.length?'BONES_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';bonesPanel?.status(reason,true);return null;}
 bonesPanel?.busy(true);bonesPanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: ${patchRoute(patch.ops,patch.producer.version)} --config, compile, check…`,false);
 try{
  const result=await applyPatch(patch,stageWorld());
  const outcome=patchOutcomeLine(result);bonesPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built'){bonesPanel?.applied(result.request.patch.ops);redrawOverlay(true);}
  return result;
 }finally{bonesPanel?.busy(false);}
}
/**
 * Cuts Apply (#115): the pending cut / patch / range / joint ops become one `rig` patch, which the server runs as
 * `rig-parts build` (assemble → rig → check) from the handoff's painting and runs; the scratch build reloads in place
 * and the panel shows the refusals, the recomposite, the seam pairs and the build's wall clock.
 */
async function applyCuts(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig'}):null;
 if(!patch){const reason=!ops.length?'CUTS_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';cutsPanel?.status(reason,true);return null;}
 cutsPanel?.busy(true);cutsPanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: build (assemble → rig → check), compile… (a full build takes minutes)`,false);
 try{
  const result=await applyPatch(patch,stageWorld());
  const outcome=patchOutcomeLine(result);cutsPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built')redrawOverlay(true);
  return result;
 }finally{cutsPanel?.busy(false);}
}
/**
 * Cloth Apply (#111): the pending recipe ops become one `rig` patch, which the server runs as `rig-parts propose --cloth
 * --write-config` and then builds the written config; the scratch build reloads in place under the stage's world.
 */
async function applyCloth(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig'}):null;
 if(!patch){const reason=!ops.length?'CLOTH_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';clothPanel?.status(reason,true);return null;}
 const route=status?.cloth?.route==='build'?'build (assemble → rig → check)':'rig --config, check';
 clothPanel?.busy(true);clothPanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: propose --cloth --write-config, then ${route}, compile…`,false);
 try{
  const result=await applyPatch(patch,stageWorld());
  const outcome=patchOutcomeLine(result);clothPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built')redrawOverlay(true);
  return result;
 }finally{clothPanel?.busy(false);}
}
/** Cloth Reset: the inspected build back on the stage (same world), and no pending op. */
async function resetClothBuild():Promise<void> {
 clothPanel?.clear();clothPanel?.shown(null);
 if(appliedOnStage){clothPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{clothPanel?.busy(false);}}
 clothPanel?.status('Reset: the inspected build is on the stage; no pending ops.',false);
}
/** Cuts Reset: the inspected build back on the stage (same world), and no pending op. */
async function resetCutsBuild():Promise<void> {
 cutsPanel?.clear();cutsPanel?.shown(null);
 if(appliedOnStage){cutsPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{cutsPanel?.busy(false);}}
 cutsPanel?.status('Reset: the inspected build is on the stage; no pending ops.',false);
}
/** Bones Reset: the inspected build back on the stage (same world), and no pending op. */
async function resetBonesBuild():Promise<void> {
 bonesPanel?.clear();bonesPanel?.applied(null);
 if(appliedOnStage){bonesPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{bonesPanel?.busy(false);}}
 bonesPanel?.status('Reset: the inspected build is on the stage; no pending ops.',false);
}
/**
 * Rig fields Apply (#110): the pending ops (in the block's scope, `RIG_FIELDS_OP_OUT_OF_SCOPE` otherwise) become one
 * config patch (`rig`, then check) against the handoff config — a whole-rig op behind the baseline guard (`/stops`,
 * `/bones`, `/regions`, `/turn` and the blink still are outside retune's scope, #136). On a build the revision reloads in place and the readout shows BLINK_NO_HOLE and FEET_STAY_LEVEL
 * before and after; a refusal shows the producer's line verbatim and leaves the stage as it was.
 */
async function applyRigFields(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 try{assertRigFieldOps(ops);}catch(error){rigFieldsPanel?.status(errorText(error),true);return null;}
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig'}):null;
 if(!patch){const reason=!ops.length?'RIG_FIELDS_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';rigFieldsPanel?.status(reason,true);return null;}
 const world=stageWorld(),before=stageCheck;
 rigFieldsPanel?.busy(true);rigFieldsPanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: ${patchRoute(patch.ops,patch.producer.version)} --config, compile, check…`,false);
 try{
  const result=await applyPatch(patch,world);
  const outcome=patchOutcomeLine(result);rigFieldsPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built'){
   rigFieldsPanel?.applied(result.request.patch.ops);
   const after={lines:[...result.lines],check:result.check};
   const show=()=>rigFieldsPanel?.readout(readoutRows(before,before?null:inspectedCheckView(),after,RIG_FIELDS_READOUT_BARS));
   show();if(!before)void followInspectedCheck(show);
  }
  return result;
 }finally{rigFieldsPanel?.busy(false);}
}
/** Rig fields Reset: the dial off, no pending op, and the inspected build back under the same world. */
async function resetRigFieldsBuild():Promise<void> {
 rigFieldsPanel?.setDial(0);rigFieldsPanel?.clear();rigFieldsPanel?.applied(null);rigFieldsPanel?.readout([]);
 if(appliedOnStage){rigFieldsPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{rigFieldsPanel?.busy(false);}}
 rigFieldsPanel?.status('Reset: the inspected build is on the stage; no pending ops; the dial is at 0.',false);
}
/** Physics Reset: the inspected build back under the same world, and no pending op. */
async function resetPhysicsBuild():Promise<void> {
 physicsPanel?.clear();physicsPanel?.applied(null);physicsPanel?.readout([]);
 if(appliedOnStage){physicsPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{physicsPanel?.busy(false);}}
 physicsPanel?.status('Reset: the inspected build is on the stage; no pending ops.',false);
}
/**
 * Idle tracks Apply (#104): the pending ops become one config patch (`rig --idle-keys <the inspected rig's keys>`, no
 * flag when they could not be read, then check) against the handoff config. The preview was cleared when Apply was pressed; on a built job the scratch build
 * reloads under the same world and its built idle plays, and the readout shows CHAIN_LAG, TIP_OVER_ROOT, BREATH_VISIBLE
 * and the loop line before and after. A refusal shows the producer's line verbatim and leaves the stage as it was.
 */
async function applyIdle(ops:PatchOp[],keys:'ctl'|'direct'|null):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const patch=status&&ops.length?makePatch(status,ops,{cmd:'rig',args:keys?['--idle-keys',keys]:[]}):null;
 if(!patch){const reason=!ops.length?'IDLE_NOTHING_PENDING: no pending ops':status?.reason??'REBUILD_STATUS_UNAVAILABLE';idlePanel?.status(reason,true);return null;}
 const world=stageWorld(),before=stageCheck;
 idlePanel?.busy(true);idlePanel?.status(`Applying ${ops.length} op(s) with ${patch.producer.name} ${patch.producer.version}: ${patchRoute(patch.ops,patch.producer.version)} --config${keys?` --idle-keys ${keys}`:''}, compile, check…`,false);
 try{
  const result=await applyPatch(patch,world);
  const outcome=patchOutcomeLine(result);idlePanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built'){
   idlePanel?.applied(result.request.patch.ops);
   const after={lines:[...result.lines],check:result.check};
   const show=()=>idlePanel?.readout(readoutRows(before,before?null:inspectedCheckView(),after,IDLE_READOUT_BARS));
   show();if(!before)void followInspectedCheck(show);
  }
  return result;
 }finally{idlePanel?.busy(false);}
}
/** Idle Reset: the preview cleared, no pending op, and the inspected build back under the same world. */
async function resetIdleBuild():Promise<void> {
 idlePanel?.clear();idlePanel?.applied(null);idlePanel?.readout([]);
 if(appliedOnStage){idlePanel?.busy(true);try{await resetRebuild(stageWorld());}finally{idlePanel?.busy(false);}}
 idlePanel?.status('Reset: the inspected build is on the stage; no pending ops; the preview is cleared.',false);
}
/**
 * Inspection only (#104 bar 1): pause, reopen the track at 0 and step it `n` times by `dt`, reading `bone`'s locals on
 * every pose after the timelines and the preview's adjust (when one is set) — what the pose holds before constraints.
 */
function sampleLocals(bone:string,dt:number,n:number):{t:number;rotation:number;x:number;y:number;scaleX:number;scaleY:number;shearX:number;shearY:number}[]|null {
 if(!player?.current||!(dt>0)||!Number.isInteger(n)||n<0)return null;
 const p=player,inner=p.adjust,rows=new Map<number,{t:number;rotation:number;x:number;y:number;scaleX:number;scaleY:number;shearX:number;shearY:number}>();
 let recording=false;
 const read:BoneAdjust=(bones,ctx)=>{inner?.(bones,ctx);if(!recording)return;const l=bones.bone(bone);rows.set(ctx.trackTime??0,{t:ctx.trackTime??0,rotation:l.rotation,x:l.x,y:l.y,scaleX:l.scaleX,scaleY:l.scaleY,shearX:l.shearX,shearY:l.shearY});};
 pause();p.adjust=read;
 try{p.seek(0);recording=true;p.repose();p.resume();for(let k=1;k<=n;k++)p.frame(dt);}
 finally{recording=false;p.pause();p.adjust=inner;drawRig(()=>p.draw());time=p.time;renderTransport();}
 return [...rows.values()].sort((a,b)=>a.t-b.t);
}
async function resetRebuild(world:StageWorld|null=null):Promise<void> {
 if(rebuildBusy||(!appliedOnStage&&!stripPending)||!inspectedModel)return;
 rebuildBusy=true;rebuildState();
 try{await swapRig(inspectedModel.url,inspectedModel.prefix,inspectedModel.sha256,world);appliedOnStage=null;stageCheck=null;stageChanged({kind:'reset'});chestEditor?.notify('Reset: the inspected build is on the stage. The draft keeps the last applied state.',false);message('Reset to the inspected build.');}
 catch(error){chestEditor?.notify(`REBUILD_RESET_FAILED: ${errorText(error)}`,true);}
 finally{rebuildBusy=false;rebuildState();}
}
/**
 * Replace the drawn rig in place: the new model loads first (a failure leaves the stage as it was), then the player is
 * swapped and the same animation, time, set, camera and environment are restored; playback resumes when it was running.
 */
let stageSource:{url:string;prefix:string;hash:string}|null=null;
async function swapRig(modelUrl:string,prefix:string,sha256:string,world:StageWorld|null=null):Promise<void> {
 const keepAnimation=animation,keepTime=player?.time??time,wasPlaying=playing,keepSet=select('part-set').disabled?'':select('part-set').value;
 inspectionSourceState='pending';partModel=null;pause();refreshAnimationInspection();
 const next=await loadModel({modelUrl,setsUrl:null,resolvePage:(name,url)=>{const target=new URL(name,url);if(target.origin!==location.origin||!target.pathname.startsWith(prefix))throw new Error(`Model page escapes its build: ${name}`);return target.href;}}).catch(error=>{inspectionSourceState='failed';refreshAnimationInspection();throw error;});
 physicsPanel?.clearPreview();
 pause();player?.dispose();assets?.dispose();assets=next;player=new RigPlayer(el('rig-root'),assets);stageModelHash=sha256;stageSource={url:modelUrl,prefix,hash:sha256};
 // A scratch build may hold another set of animations (a retarget adds one, #114): the picker lists what this build has.
 {const animations=select('animation-select');animations.replaceChildren(...assets.animations.map(item=>option(item.name,data.manifest.animations.find(a=>a.id===item.name)?.label??item.name)));animations.disabled=assets.animations.length===0;}
 player.on('event',event=>{text('event-log',`Runtime event: ${event.name} · ${event.time.toFixed(2)} s`);});
 try{const catalog=await loadPartModel(modelUrl,sha256,data.feedbackCatalog.slots??[]);inspectionSourceState='ready';partModel=catalog.model;configureTurnPad(catalog.model);refreshAnimationInspection();weightsView?.refresh();parts?.register('single',catalog.entries,player,new PartThumbnails(pageRegionTable(catalog.model),assets.pageImages));}catch(error){inspectionSourceState='failed';partModel=null;refreshAnimationInspection();parts?.refuseCatalog('single',error);}
 if(keepSet){try{player.setSet(keepSet);}catch{select('part-set').value='';player.setSet(null);}}
 // The same world before the first pose: a physics Apply resumes the wind (clock and pulse), the pending jolts, gravity and
 // whether the controls are engaged as they stood when Apply was pressed; then the seek re-poses under that world.
 if(world){wind.resume(world.wind);joltQueue=world.jolts.map(step=>({...step}));input('environment-applied').checked=world.applied;input('gravity').value=String(world.gravity);syncEnvironmentInputs();}
 if(environmentApplied())player.environment(environmentFor(wind.read(),gravityValue()));
 // #186: a model without the staged animation (Reset after a retarget, a rebuild without that clip) clears it, so the
 // rig pane and the transport name the setup pose drawn, not the removed clip.
 if(keptAnimation(keepAnimation,assets.animations.map(clip=>clip.name))){chooseAnimation(keepAnimation,{kind:'reload'});seek(keepTime,{kind:'reload'});}
 // #197: the picker was just refilled (which selects its first option), so it is cleared whenever no clip is kept — even
 // when none was staged — and nothing claims a clip the stage is not drawing.
 else{drawRig(()=>player!.draw());animation='';duration=0;time=0;select('animation-select').value='';renderTransport();renderCues();renderIdle();}
 if(environmentApplied())applyEnvironment();
 updateChestMapping();fitCamera();
 // The preview (#104) drives the new player once its bone setups are read (an idle Apply cleared it first).
 stageDocumentSet=true;void loadModelDocument(modelUrl,sha256).then(loaded=>{if(loaded.ok&&stageModelHash===sha256)idlePanel?.model(boneSetup(loaded.document));});
 if(wasPlaying)void playPreview();
}
/**
 * Mesh Apply (#106): the pending `meshes.<part>` entry becomes one config patch — `replace /meshes/<part>` and nothing
 * else (bar 3) — run by `remesh --part <part>` through the patch runner (compile, check). On a build the revision
 * reloads with the mesh edges on, and the panel shows remesh.json's counts, the revision model's and the overlay's
 * triangle counts (bar 1) and TEXTURE_STRETCH before and after. A refusal leaves the stage and the pending entry as
 * they were and shows the producer's line verbatim (bar 2).
 */
let lastMeshPatch:ConfigPatch|null=null;
async function applyMesh(part:string,entry:MeshEntry):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const problems=meshPanel?.precheck()??[];
 if(problems.length){meshPanel?.status(`${problems[0]} (review pre-check; nothing sent)`,true);return null;}
 const patch=status?makePatch(status,meshPatchOps(part,entry),{cmd:'remesh',args:['--part',part]}):null;
 if(!patch){meshPanel?.status(status?.reason??'REBUILD_STATUS_UNAVAILABLE',true);return null;}
 try{assertMeshPatch(patch,part);}catch(error){meshPanel?.status(errorText(error),true);return null;}
 lastMeshPatch=patch;
 const world=stageWorld(),before=stageCheck;
 meshPanel?.busy(true);meshPanel?.status(`Applying meshes.${part} with ${patch.producer.name} ${patch.producer.version}: remesh --mesh, compile, check…`,false);
 try{
  const result=await applyPatch(patch,world);
  const outcome=meshApplyOutcome(result as Parameters<typeof meshApplyOutcome>[0]);meshPanel?.status(outcome.text,outcome.error);
  if('id' in result&&result.status==='built'){
   // #173 / #183: the pending strip row (if any) was cleared by applyPatch's landing, as after every Apply.
   // The new triangulation is drawn: the mesh edges go on and the overlay captures the reloaded pose.
   if(!layers.mesh){layers.mesh=true;input('layer-mesh').checked=true;}
   if(player)drawRig(()=>player!.draw());redrawOverlay(true);
   const counts=result.remesh??null,overlay=lastOverlay?.meshTriangles[part]??null,agree=triangleAgreement(counts,counts?.modelTriangles??null,overlay);
   meshPanel?.counts([
    ...(counts?[{label:'BEFORE',text:`${counts.part} ${countsText(counts.before)} (remesh.json)`},{label:'AFTER',text:`${counts.part} ${countsText(counts.after)} (remesh.json)`}]:[]),
    {label:agree.ok?'AGREE':'DIFFER',text:agree.line,error:!agree.ok},
   ]);
   const after={lines:[...result.lines],check:result.check};
   const show=()=>meshPanel?.readout(readoutRows(before,before?null:inspectedCheckView(),after,['TEXTURE_STRETCH']));
   show();if(!before)void followInspectedCheck(show);
  }
  return result;
 }finally{meshPanel?.busy(false);}
}
/** Mesh Reset: the inspected build back on the stage (same world); the panel already holds the config's entry again. */
async function resetMeshBuild():Promise<void> {
 meshPanel?.counts([]);meshPanel?.readout([]);
 if(appliedOnStage||stripPending){meshPanel?.busy(true);try{await resetRebuild(stageWorld());}finally{meshPanel?.busy(false);}}
 meshPanel?.status('Reset: the inspected build is on the stage; the pending entry is the config\'s.',false);
}
/**
 * #173 · Density strip. Build: one Mesh-panel patch per value (the pending entry with its density field at that value),
 * sent together to `POST /api/density-strip` and polled until every candidate settles. Load: a built row's revision on
 * the stage as pending — the applied record, the undo stack and the feedback context's applied state are left alone
 * (the context reads null while a pending row is on the stage: nothing applied is on it), and Undo is unavailable until
 * Back returns the stage to what it showed or an Apply lands (the Mesh panel's reuses the row's build; any Apply, Reset or Undo clears the pending row, #183). Close removes
 * the strip's scratch.
 */
let stripView:DensityStripViewLike|null=null,densityBusy=false;
let stripPending:{index:number;id:string;candidate:string;back:{url:string;prefix:string;hash:string;applied:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|null;check:{lines:string[];check:CheckSummary|null}|null}}|null=null;
/** #183: after every landed Apply, Reset or Undo the pending row and Back go (`stripPendingAfter`); the strip re-reads (a row Applied is marked). */
function stageChanged(change:StageChange<NonNullable<typeof stripPending>>):void {const next=stripPendingAfter(stripPending,change);if(next===stripPending)return;stripPending=next;void refreshDensityStrip();}
const densityLine=(text:string,error=false)=>{densityStrip?.status(text,error);if(error)message(text,true);};
const renderStrip=()=>densityStrip?.show(stripView,stripPending&&stripView?.id===stripPending.id?stripPending.index:null,densityBusy||rebuildBusy||!!readOnly);
async function refreshDensityStrip():Promise<void>{try{const r=await api<{strip:DensityStripViewLike|null}>('/api/density-strip');stripView=r.strip;}catch{/* keep the last view */}renderStrip();}
async function buildDensityStrip(values:number[]):Promise<DensityStripViewLike|{error:string}>{
 if(densityBusy)return {error:'DENSITY_STRIP_BUSY: a strip is still building'};
 if(readOnly){densityLine(readOnly,true);return {error:readOnly};}
 const status=rebuildStatus??await loadRebuildStatus(),part=meshPanel?.part()??null,entry=meshPanel?.entry()??null;
 if(!status||!part||!entry){const t=status?.reason??'MESH_PANEL_NO_PART: select a mesh part';densityLine(t,true);return {error:t};}
 const problems=meshPanel?.precheck()??[];if(problems.length){const t=`${problems[0]} (review pre-check; nothing sent)`;densityLine(t,true);return {error:t};}
 let patches:ConfigPatch[];
 try{const field=densityField(entry,part);patches=values.map(v=>{const patch=makePatch(status,meshPatchOps(part,setEntryValue(entry,densityPath(field),v)),{cmd:'remesh',args:['--part',part]});if(!patch)throw new Error(status.reason??'REBUILD_STATUS_UNAVAILABLE');assertMeshPatch(patch,part);return patch;});}
 catch(error){const t=errorText(error);densityLine(t,true);return {error:t};}
 // A pending row goes back first: the strip it came from is about to be replaced.
 if(stripPending)await stripBack();
 densityBusy=true;renderStrip();densityLine(`Building a strip of ${values.length} on ${part}: ${values.join(', ')} — remesh, compile and remesh's own check per value…`);
 const t0=performance.now();
 try{
  let view:DensityStripViewLike|{status:string;error:string};
  try{view=await api<DensityStripViewLike|{status:string;error:string}>('/api/density-strip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patches})});}
  catch(error){const t=errorText(error);densityLine(t,true);return {error:t};}
  if('error' in view){densityLine(view.error,true);return {error:view.error};}
  stripView=view;renderStrip();
  while(stripView.status==='running'){await new Promise(resolve=>setTimeout(resolve,1500));stripView=await api<DensityStripViewLike>(`/api/density-strip/${stripView.id}`);renderStrip();
   const settled=stripView.rows.filter(r=>r.status!=='running').length;densityLine(`Strip ${stripView.id.slice(0,12)}…: ${settled} of ${stripView.rows.length} settled · ${((performance.now()-t0)/1000).toFixed(0)} s`);}
  const passing=stripView.rows.filter(r=>r.verdict==='PASS').length;
  densityLine(`Strip of ${stripView.rows.length} on ${stripView.part} settled in ${((stripView.wallMs??0)/1000).toFixed(1)} s (at most ${stripView.concurrency} at once): ${passing} passing, ${stripView.rows.length-passing} refused or failing. Labels only — nothing is applied; Load puts a row on the stage as pending.`);
  return stripView;
 }finally{densityBusy=false;renderStrip();}
}
async function loadStripRow(index:number):Promise<{line:string;ok:boolean}|{error:string}>{
 const view=stripView,row=view?.rows[index];
 if(!view||!row)return {error:'DENSITY_STRIP_NOT_FOUND'};
 if(!row.modelUrl||!row.modelHash){const t=`DENSITY_STRIP_ROW_NOT_LOADABLE: ${row.value} — ${row.applied?'applied already':row.verdict}`;densityLine(t,true);return {error:t};}
 if(rebuildBusy||densityBusy)return {error:'REBUILD_BUSY'};
 const back=stripPending?.back??{url:stageSource?.url??inspectedModel!.url,prefix:stageSource?.prefix??inspectedModel!.prefix,hash:stageSource?.hash??inspectedModel!.sha256,applied:appliedOnStage,check:stageCheck};
 rebuildBusy=true;rebuildState();
 try{
  await swapRig(new URL(access.route(row.modelUrl),location.href).href,access.route(`/density-strip/${view.id}/${row.id}/`),row.modelHash,stageWorld());
  stripPending={index,id:view.id,candidate:row.id,back};
  // Pending, not applied: no record, no undo entry; the feedback context names no applied state while it is on the stage.
  appliedOnStage=null;stageCheck=null;
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value='';draft.dispatchEvent(new Event('input',{bubbles:true}));
  meshPanel?.setEntry(row.entry as MeshEntry);
  if(!layers.mesh){layers.mesh=true;input('layer-mesh').checked=true;}
  if(player)drawRig(()=>player!.draw());redrawOverlay(true);
  const c=row.counts?{vertices:row.counts.vertices,triangles:row.counts.triangles,hull:0}:null;
  const agree=triangleAgreement(c?{part:view.part,before:c,after:c}:null,row.modelTriangles,lastOverlay?.meshTriangles[view.part]??null);
  meshPanel?.counts([{label:'PENDING',text:`${view.field} ${row.value} · ${row.counts?`v ${row.counts.vertices} · t ${row.counts.triangles}`:'no counts'} (remesh.json) — not applied`},{label:agree.ok?'AGREE':'DIFFER',text:agree.line,error:!agree.ok}]);
  const line=`Pending on the stage: ${view.part} ${view.field} ${row.value} (strip row ${index+1}) — not applied. The Mesh panel's Apply applies it; Back returns the stage. ${agree.line}`;
  densityLine(line,!agree.ok);
  return {line:agree.line,ok:agree.ok};
 }catch(error){const t=`DENSITY_STRIP_LOAD_FAILED: ${errorText(error)}`;densityLine(t,true);return {error:t};}
 finally{rebuildBusy=false;rebuildState();renderStrip();}
}
async function stripBack():Promise<void>{
 const pending=stripPending;if(!pending||rebuildBusy)return;
 rebuildBusy=true;rebuildState();
 try{
  await swapRig(pending.back.url,pending.back.prefix,pending.back.hash,stageWorld());
  appliedOnStage=pending.back.applied;stageCheck=pending.back.check;stripPending=null;
  const draft=el<HTMLTextAreaElement>('rebuild-applied');draft.value=appliedOnStage?JSON.stringify(appliedOnStage):'';draft.dispatchEvent(new Event('input',{bubbles:true}));
  meshPanel?.counts([]);redrawOverlay(true);
  densityLine(`Back: the stage shows ${appliedOnStage?`the last applied record (model ${pending.back.hash.slice(0,12)}…)`:`the inspected build (model ${pending.back.hash.slice(0,12)}…)`}.`);
 }catch(error){densityLine(`DENSITY_STRIP_BACK_FAILED: ${errorText(error)}`,true);}
 finally{rebuildBusy=false;rebuildState();renderStrip();}
}
async function closeDensityStrip():Promise<{status:string;error?:string}>{
 const view=stripView;if(!view)return {status:'closed'};
 if(stripPending&&stripPending.id===view.id)await stripBack();
 try{
  const r=await api<{status:string;error?:string}>('/api/density-strip/close',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:view.id})});
  if(r.status!=='closed'){densityLine(r.error??'DENSITY_STRIP_CLOSE_REFUSED',true);return r;}
  stripView=null;renderStrip();densityLine('Strip closed; its scratch is removed.');return r;
 }catch(error){const t=errorText(error);densityLine(t,true);return {status:'refused',error:t};}
}
/** The folds reading (#108) of the drawn animation, on the inspected build and on the latest scratch build: one line per build. */
async function meshFolds():Promise<string[]> {
 meshPanel?.status(`Running the folds reading of ${animation||'(no animation)'}…`,false);
 const job=await runReadings({readings:[{kind:'folds'}]});
 if(!job||!('runs' in job)){const text=job&&'error' in job&&job.error?job.error:'READINGS_UNAVAILABLE: no reading ran';meshPanel?.status(text,true);return [text];}
 const lines=job.runs.map(run=>{const r=run.results[0];return r?worstLine(run.build,r):`${run.build} · folds: not run`;});
 if(job.runs.length<2)lines.push('scratch · folds: no scratch build yet (Apply builds one)');
 meshPanel?.status(lines.join(' | '),job.runs.some(run=>run.results.some(r=>r.status!=='read')));
 return lines;
}
void start();


/** Only live, unrecorded authoring effects block capture; unsent form ops alone do not. */
function commentCaptureRefusal():string|null {
 if(appliedOnStage)return 'COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build';
 if(rebuildBusy)return 'COMMENT_SOURCE_BUSY: wait for the rebuild or candidate model replacement before commenting';
 const preview=idleAdjust?'Idle tracks':dialAdjust?'Rig fields turn dial':physicsPreview.read().length?'Physics live overrides':stripPending?'Density strip candidate':
  meshEditor?.overlay()?'Edit Mesh':bonesPanel?.overlay()?'Bones anchors':cutsPanel&&(cutsPanel.overlayRegions().length||cutsPanel.overlayMarkers().length)?'Cuts/patches/joints':
  clothPanel?.overlayRegions().length?'Cloth links':meshPanel&&(meshPanel.overlayRegions().length||meshPanel.overlayCircles().length)?'Mesh regions':
  chestRegions().length||chestCircles().length||chestMarkers().length?'Chest regions/landmarks':rigFieldsPanel?.handles().length?'Rig fields stage handles':
  (()=>{const handles=document.getElementById('idle-handles');return handles&&!handles.hidden&&handles.childElementCount>0;})()?'Idle tracks stage handles':null;
 return preview?`COMMENT_UNAPPLIED_PREVIEW: ${preview} is active; leave or disable that preview before commenting (nothing is cleared or applied automatically)`:null;
}
function setupComments():void {
 comments=bindStageComments({toolbar:el('stage-comment').parentElement!,viewports:{rig:el('rig-viewport'),reference:el('reference-viewport')},
  pose:view=>{
   if(view!=='rig'&&view!=='reference')return null;const workspaceMode=document.querySelector<HTMLElement>('[data-mode][aria-pressed="true"]')?.dataset.mode;if(workspaceMode!=='rig'&&workspaceMode!=='playback')return null;const camera=numericView().cameras[view],pane=el(view+'-viewport');if(!camera||pane.clientWidth<=0||pane.clientHeight<=0)return null;
   const renderer=player?.renderer;const current=player?.time??time,index=frameAtTime(activeFrameClock(),current),referenceId=view==='reference'?select('reference-select').value||null:null,referenceHash=referenceId?data.referenceHashes?.[referenceId]??(data.explicitReference?.id===referenceId?data.explicitReference.sha256:null):null;
   return {mode:workspaceMode==='playback'?'animate':'setup',capture:{pane,root:view==='rig'?el('rig-root'):undefined,images:view==='reference'||layers.images,canvas:view==='rig'&&renderer instanceof CanvasRenderer?renderer.canvas:undefined,backend:renderer instanceof CanvasRenderer?renderer.backendActive:renderer?.meshBackendActive??'canvas2d'},camera,frame:index===null?null:{index,basis:'producer'},...(index===null?{timeBasis:timeOnlyBasis}:{}),time:current,animation:animation||null,turn:turnPad?.snapshot()??null,sourceHash:data.sourceHash,modelHash:view==='reference'?null:stageModelHash,referenceHash,referenceId,rig:data.manifest.id,...(view==='reference'?{media:video??el('reference-content').querySelector('img')??undefined}:{posed:parts?.frame('single'),assets:assets??undefined})} as CommentPose;
  },
  pause:async()=>{const running=playing||!!video&&!video.paused;pause();if(running&&video&&video.readyState>=1){seekingControl=true;try{await inspectControlTime(player?.time??time,new AbortController().signal);}finally{seekingControl=false;}}if(turnPad)turnPad.restore({...turnPad.snapshot(),held:true},false);},bookmark:inspectionBookmark,restore:(b,timed)=>restoreInspection(parseBookmark(b,inspectionBinding()),new AbortController().signal,!!timed),feedback:()=>session.feedback,
  locked:id=>!!submittedBaseline?.updatedAt&&submittedBaseline.feedback.some(f=>f.id===id),add:f=>session.feedback.push(f),changed:()=>{markDirty();renderProposals();persistence?.save();},error:value=>message(value,true),
  refusal:commentCaptureRefusal,blocked:()=>saving||!!persistence?.restoring()||seekingControl||!!video?.seeking||!!rebuildBusy||!!appliedOnStage,shortcutBlocked:()=>!!meshEditor?.active()
 });
}
