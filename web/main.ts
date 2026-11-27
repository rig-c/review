import {nativeDifferenceAlignment} from '../src/parts-comparison.ts';
import type {CheckpointPairView} from './rig-host.ts';
import {clampZoom} from './camera-view.ts';
import {advanceTake,applyTakeStep,bindScenePlates,loadScenePlates,takeSample,type TakeStep} from './scene-plates.ts';
import type {SceneInspection} from '../src/scene-inspection.ts';
import type {JobProgressV3,RecordSource} from '../src/job-contract.ts';
import type {InterviewSubjectEntry} from '../src/joined-project.ts';
import {mountJobScreen,mediaReady,jobSubmissionRefusal} from './job-session.ts';
import {mountOwnerWorkspace} from './owner-workspace.ts';
import {mountCompareScreen} from './compare.ts';
import {partsIssueComments,parsePartsIssue,assertPartsIssueBinding,type PartsIssue} from '../src/parts-comment.ts';
import type {JobForm} from './job-session.ts';
import type {JobRigMeshHost,JobRigMeshScreen} from './job-rig-screen.ts';
import {bindWorkspaceDrawer,settleAnimationFrames} from './workspace-layout.ts';
import {captureRigRestStill,rigRestCanvas} from './job-rig-capture.ts';
import {createPartsViewportProvider,bindPartsSubject,paintRigDifference,loadViewportImage,type PartsSubjectEntry,type PartsSubjectSession} from './parts-viewport-provider.ts';
import {rigWorkspaceMarkup,rigFeedbackMarkup,sharedViewToolsMarkup,sharedCommentMarkup,renderCompareHtml} from '../src/compare-html.ts';
import {bindDirectionPanel} from './direction-panel.ts';
import {bindWorkspaceVisibility} from './workspace-visibility.ts';
import type {DirectionInspection} from '../src/direction-inspection.ts';
import {parseStageComment,parsePictureCommentLabel,feedbackContextComments,feedbackItemComments,projectComments,projectCommentLabels,timeOnlyBasis,unprojectMark,feedbackTimingLabel,requireFeedbackFrames,isTimeOnlyFeedback,hasStageComment,type StageComment} from '../src/stage-comment.ts';
import {bindStageComments,type CommentRow,type CommentPose} from './stage-comments.ts';
import {discoverTurnDials,TurnState} from '../src/turn-pad.ts';
import {bindTurnPad,type TurnPad} from './turn-pad.ts';
import {PartExplorer,loadPartModel,partBounds,partCatalog,type PartEntry} from './part-selection.ts';
import {AnimationInspectionPanel} from './animation-inspection.ts';
import {formatSeconds} from './format-seconds.ts';
import {PartThumbnails,pageRegionTable} from './part-thumbnails.ts';
import { CanvasRenderer, loadModel, RigPlayer, type BoneAdjust, type ModelAssets, type PoseBounds } from '@rig-c/play';
import {createViewportController,createViewportState,type CameraTarget} from './viewport-controller.ts';
import {createRigViewportProvider,rigPanCarry} from './rig-viewport-provider.ts';
import {mountViewportPair} from './viewport-pair.ts';
import {createPreviousBuildView} from './previous-build-view.ts';
import {rendererStatus} from './renderer-status.ts';
import {panelMake,createRigLayerControls,createViewControls,inspectionViewSwitch,actionButton,bindAppearance,syncStageLayout,bindInspectorTabs,idleAvailable,initialIdleAnimation,automaticIdlePreview,idlePreviewOnOpen,bookmarkCameraKept,bindLayerShortcuts,describeLayerToggles,type ViewPoint,type ViewSwitchGroup} from './view-controls.ts';
import {RigOverlays,type OverlayCircle,type OverlayRegion,type OverlaySnapshot} from './rig-overlays.ts';
import {bindMeshPanel,type MeshPanel} from './mesh-panel.ts';
import {bindDensityStrip,bindDensityStripJobs,type DensityStripPanel,type DensityStripViewLike} from './density-strip-panel.ts';
import {assertMeshPatch,countsText,meshApplyOutcome,meshPatchOps,triangleAgreement,type MeshEntry} from '../src/mesh-entry.ts';
import {chestOverlayPolygons,chestInputIds,chestRegionRows,chestRowId,evaluateChestForm} from './chest-regions-tool.ts';
import {bindChestEditor,canvasToCrop,chestField,chestCircles as readChestCircles,exportChest as exportChestFiles,chestMarkers as readChestMarkers,chestPoseOffset,LANDMARKS,posedChestMapping,type ChestEditor} from './chest-editor.ts';
import {bindMeshEditor,exportMesh as exportMeshFiles,meshEditSource,sha256Hex,type MeshEditor} from './mesh-editor.ts';
import {bindWeightsView,setupPoseMesh,type WeightsView} from './weights-view.ts';
import {readSetupPose,modelBoneNames} from './setup-pose.ts';
import {bindBonesPanel,requestBonesCheck,type BonesPanel,type BonesCheckView} from './bones-panel.ts';
import {bindCutsPanel,type CutsPanel} from './cuts-panel.ts';
import {bindClothPanel,type ClothPanel} from './cloth-panel.ts';
import {stageChanged as updateDensityPending,type StageChange,type AppliedAnimation,type AppliedRetarget,type RetargetJobView} from './rebuild-client.ts';
import {bindRetargetPanel,type PoseMap,type RetargetPanel} from './retarget-panel.ts';
import {writeRebuildDraft, stageApplyMeshDelta, stageApplyPatch, stageResetRebuild, stageUndoApply, stageApplyAnimation, stageLoadStripRow, stageResetAnimation, stageApplyRebuild, stageApplyRetarget, stageStripBack,type StageJobScreen} from './rebuild-client.ts';
import type {RetargetFlags} from '../src/retarget.ts';
import {createHandoffRefresh,directJobUiSink,bindRequirementsCatalog,bindMeshFolds,bindPanelRebuilds,preparePanelPatch,appliedStatus as setAppliedStatus,inspectedCheckView as readInspectedCheck,renderApplied as renderAppliedPanel,renderAppliedBlocks as reconcileAppliedBlocks,retargetStage,type AppliedHistoryView,type UndoView,type AnyJobView,MESH_DELTA_APPLIED_SOURCE,chestPartFields,chestStatusForPart,chestSeed,designatedRegions,noContourReason,seedLandmarks,makePatch,pickBustPart,pickPart,runReadingsRequest,seedFields,type AppliedDelta,type AppliedPatch,type AppliedRecord,type ConfigPatch,type PatchJobView,type RebuildRefusal,type RebuildStatusView} from './rebuild-client.ts';
import type {MeshEditDocument} from '../src/mesh-edit.ts';
import {cropWorldMapping,type CropWorldMapping} from '../src/chest-regions.ts';
import {mountWorkspaceShell,mountStatusBar,bindWorkspaceUI,bindHeaderModeAvailability,selectedInspector,type WorkspaceUI} from './workspace-ui.ts';
import {setSourceAttribute,setSourceText,sourceAttribute,sourceTextContent,onLanguageChange,t,tr} from './i18n.ts';
import {holdScrubBox,releaseScrubBox,scrubBox} from './scrub-box.ts';
import {mountRigInspector,bindInspectorBlocks,activeBlocksUI,restoreActiveBlocksUI,type InspectorBlocks} from './inspector-blocks.ts';
import {connectControl} from './control.ts';
import {connectLiveWindow} from './live-connection.ts';
import {pageInstanceAccess,readOnlyReason} from './instance-access.ts';
import {rigHost,type RigHost,type RigHostStage} from './rig-host.ts';
import {controlComparison,type ControlCommand,type ControlInspection,type ControlView} from '../src/control.ts';
import {singleEligibility,videoReferenceAt,type InputState,type SingleLayout} from '../src/comparison-eligibility.ts';
import {parseBookmark,connectInspectionPersistence,serializableView,restoredZoom,restoreTransaction,captureInputs,restoreInputs,type InspectionBookmark,type InspectionBinding,type PersistenceConnection} from './inspection-persistence.ts';
import {initialPlayerAnimation,keptAnimation} from '../src/animation-selection.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import type {ReferenceBinding} from '../src/reference.ts';
import type { Checkpoint, Json, Reference, ReviewedSource, ReviewManifest } from '../src/manifest.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import type { ReportEvent, ReportSeeds } from '../src/report.ts';
import { frameAtTime, lastFrame as lastProducerFrame, rigPaneLabel, timeAtFrame, transportClock, type StageClock } from '../src/frame-clock.ts';
import { feedbackLastFrame, feedbackTargetNames, type FeedbackCatalog } from '../src/feedback-validation.ts';
import { eventCoordinates, eventSeekTime, eventSelection, eventTimingLabel, reportCounts, targetLabel } from './report-view.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';
import {createWindModel,environmentFor,windReadout,RUNTIME_START_READOUT,joltPacket,dragImpulse,loadModelDocument,environmentContext,environmentJson,type JoltStep,type WindSnapshot} from '../src/environment.ts';
import {tuningRows,readoutRows,type InspectedCheckView} from '../src/physics-tuning.ts';
import {bindReadingsPanel,readingsContext as buildReadingsContext,type ReadingsJobView,type ReadingsPanel,type ReadingsRefusal} from './readings-panel.ts';
import {readingSeekTime,type ReadingsContext} from '../src/readings.ts';
import {bindEnvironmentInputs,checkAnimation as selectCheckAnimation,windClockOnMove,resetWindClock,type ClipMove,bindEnvironmentCheck,scheduleContext,worldExport,type StageWorld,type WorldExport} from './environment-world.ts';
import {bindRequirementsPanel,runRequirementsRequest,type RequirementsCatalogView,type RequirementsJobView,type RequirementsPanel,type RequirementsRefusal} from './requirements-panel.ts';
import type {RequirementsRequest} from '../src/requirements.ts';
import {patchRoute} from '../src/retune-route.ts';
import {appliedCheckRefusal,type CheckSummary} from '../src/applied-context.ts';
import {dropNoticeForPanel,type RebuildPanelKind} from '../src/applied-blocks.ts';
import {bindPhysicsPanel,type PhysicsPanel} from './physics-panel.ts';
import {bindIdlePanel,type BoneSetup,type IdlePanel} from './idle-panel.ts';
import {composeAdjust,PhysicsPreview} from './preview.ts';
import {advancePlayback,cueDue} from './playback-clock.ts';
import {bindRigFieldsPanel,type RigFieldsPanel} from './rig-fields-panel.ts';
import {TURN_BONE} from '../src/rig-fields.ts';
import {type LocalChannel} from '../src/idle-tracks.ts';
import type {PatchOp} from '../src/config-patch.ts';

/** Mount the existing composition again for a live publication; each instance owns its source-bound state. */
export function mountRigScreen():{dispose():void} {
const screenRoot=document.getElementById('app')!;
const lifecycle=new AbortController();
let suspended=false,disposed=false,frameHandle=0,navigationMissing=false;
let publicEditor:unknown;
let workspace:WorkspaceUI|null=null;
interface ReviewResponse { scene?:SceneInspection; direction?:DirectionInspection; recordSource?:RecordSource; setsHash?:string; referenceHashes?:Record<string,string>; initialAnimation?:string|null; manifest: ReviewManifest; referenceBinding?:ReferenceBinding; explicitReference?:{id:string;name:string;sha256:string;url:string}; sourcePainting?:{id:string;path:string;sha256:string;url:string}; sourceHash: string; reviewedSource: ReviewedSource; report: ReportSeeds | null; feedbackCatalog: FeedbackCatalog; assetsBase: string; capabilities: { interview?:true; preRig?:true; playback: boolean; modeling: false; motion: false; feedback: boolean; audio: boolean } }
interface PoseReference { schema: 'rig-review-pose/1'; coordinateSystem: 'image-pixels-y-down'; width: number; height: number; joints: { id: string; x: number; y: number; parent?: string }[] }
interface SequenceJoint { state: 'observed' | 'occluded' | 'missing' | 'inferred'; at?: [number, number]; score?: number }
interface PoseSequence { spec: 'rig-pose-sequence/1'; space: { units: 'picture-px'; origin: 'top-left'; y: 'down' }; width: number; height: number; source?: string; frames: { t: number; people: { id: string; joints: Record<string, SequenceJoint> }[] }[]; camera?: { s: number; tx: number; ty: number; inliers: number }[]; cameraSource?: unknown }
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = id==='app'?screenRoot:screenRoot.querySelector<HTMLElement>('#'+id)??workspace?.element(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
};
const input = (id: string) => el<HTMLInputElement>(id);
const select = (id: string) => el<HTMLSelectElement>(id);
const button = (id: string) => el<HTMLButtonElement>(id);
const titledIds = new Set(['message', 'review-message', 'player-state', 'layout-state', 'renderer-state', 'layer-state', 'idle-state', 'control-state', 'draft-state', 'rig-label', 'reference-label', 'coordinates']);
// #347: write only a changed source, so a played frame does not rewrite (and re-translate) unchanged text.
const text = (id: string, value: string) => { const node = el(id); setSourceText(node, value); if (titledIds.has(id)) setSourceAttribute(node, 'title', value); };
const option = (value: string, label: string) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// Capability is consumed before shell composition or any URL-dependent binding.
// A live job (#709) hosts this screen for a rig subject: its routes, its session and its submit.
let host:JobRigMeshHost|null=rigHost(),access=host?.access??pageInstanceAccess();
const entryParams=new URLSearchParams(location.search);
const ownerStage=!!access.capability&&access.base!=='/'&&entryParams.has('workspace')&&window.parent!==window&&window.frameElement?.getAttribute('data-stage-embed')==='owner';
let partsOnly=host?.subject==='parts'||screenRoot.dataset.reviewScreen==='parts';
let firstPublicationPrompt=!!host?.waiting;
const app=el('app');app.innerHTML=rigWorkspaceMarkup+rigFeedbackMarkup;
/** #1041: the right panel is communication with the AI: the pending question, Comments and (later) record forms.
 * The bottom panel keeps the controllers tied to the view. */
const communicationPanel=panelMake('aside',{id:'workspace-communication',className:'workspace-communication',hidden:true});
setSourceAttribute(communicationPanel,'aria-label','Communication');
const rigStatusBar=mountStatusBar({
 message:'Loading local review package…',
 readouts:[
  panelMake('span',{id:'player-state',className:'subtle',textContent:'No rig supplied'}),
  panelMake('span',{id:'layout-state',className:'subtle',textContent:'Loading inputs…'}),
  panelMake('span',{id:'renderer-state',className:'subtle',title:'DOM images for rigid parts; WebGL meshes when available, Canvas2D fallback.',textContent:'Not rendered'}),
  panelMake('span',{id:'layer-state',className:'hint',textContent:'No rig supplied'}),
  panelMake('span',{id:'idle-state',className:'hint',textContent:'Idle preview unavailable'}),
  panelMake('span',{id:'control-state',className:'hint'}),
  panelMake('div',{className:'draft-notice'},panelMake('span',{id:'draft-state'}),panelMake('div',{id:'draft-recovery'})),
 ],
 source:panelMake('div',{className:'status-source'},
  panelMake('details',{className:'view-region'},panelMake('summary',{},'View region'),
   panelMake('div',{className:'view-region-body'},
    panelMake('span',{className:'hint',textContent:'Numeric source region · opening this link restores a paused inspection'}),
    panelMake('pre',{id:'view-coordinates',className:'numeric-view'}),
    panelMake('p',{className:'hint',textContent:'Sync cameras links fit-relative zoom and viewport-relative pan across visible panes. Turn it off to inspect each pane independently. Toolbar zoom and Fit use the last active pane. Hold Space while dragging a video to pan without taking over its native controls.'}))),
  panelMake('span',{id:'source-hash',className:'subtle'})),
});
app.querySelector<HTMLElement>('[data-workspace-status]')!.replaceWith(rigStatusBar.footer);
for(const id of ['layout-state','idle-state','control-state','draft-state'])el(id).setAttribute('role','status');
el('layout-state').setAttribute('aria-label','Effective layout');el('renderer-state').setAttribute('aria-label','Last draw backend');el('draft-state').setAttribute('aria-live','polite');el('view-coordinates').setAttribute('aria-label','Current numeric inspection region');
const shell=mountWorkspaceShell({compatibility:'rigStep1',embedded:entryParams.has('stageEmbed')||ownerStage});app.prepend(shell.header,...shell.actRow?[shell.actRow]:[]);
function bindOwnerStage(sourceHash:string):void {
 const stop=bindWorkspaceVisibility({key:access.key,sourceHash,pause,...ownerStage?{modeSwitch:shell.modeSwitch!}:{}});
 if(stop)viewDisposers.push(stop);
}
el('app').querySelector<HTMLElement>('[data-workspace-comment]')!.innerHTML=sharedCommentMarkup;
el('app').querySelector<HTMLElement>('[data-workspace-layers]')!.append(createRigLayerControls());
el('app').querySelector<HTMLElement>('[data-workspace-view-tools]')!.innerHTML=sharedViewToolsMarkup;
const controls=createViewControls({layout:'rigStep1',viewSwitch:inspectionViewSwitch(chooseInspectionView,true)}),cameraControls=el('app').querySelector<HTMLElement>('[data-workspace-camera]')!;cameraControls.append(controls.syncLabel,controls.zoomGroup!);
cameraControls.insertBefore(button('play'),controls.zoomGroup!);button('play').hidden=true;
const primaryToolbar=app.querySelector<HTMLElement>('.viewbar')!;primaryToolbar.classList.add('workspace-main-toolbar');
const secondaryToolbar=document.createElement('div');secondaryToolbar.className='workspace-secondary-toolbar';secondaryToolbar.append(app.querySelector<HTMLElement>('[data-workspace-layers]')!,app.querySelector<HTMLElement>('[data-workspace-view-tools]')!);primaryToolbar.after(secondaryToolbar);
for(const event of ['click','change'])secondaryToolbar.addEventListener(event,()=>{if(rigDifference){leaveRigDifference();renderLayout();}},true);
const rigInspector=mountRigInspector(document,shell.actRow??undefined);
rigInspector.act.hidden=true;
const rigAsk=panelMake('button',{className:'workspace-act-ask',id:'workspace-pending-ask',hidden:true});rigAsk.type='button';
const askHeadline=panelMake('span',{id:'workspace-ask-headline',className:'workspace-act-ask',hidden:true});
rigInspector.act.prepend(askHeadline,rigAsk);
// #1226: Send comments sits in the act bar, leftmost of the answers; it sends a comment-only act that answers no ask.
const sendComments=panelMake('button',{id:'send-comments',type:'button',hidden:true});setSourceText(sendComments,'Send comments');button('save').before(sendComments);
let commentSendState:'idle'|'sent'='idle';let commentSending=false;
const rowStoreCache=new Map<string,{key:string;rows:Record<string,string>}>();
let pendingAnswers:readonly {kind:string;stage?:string}[]=[];
let recordSaveStateShown=false;
let jobProgress:JobProgressV3|null=null,progressTimer:ReturnType<typeof setInterval>|undefined;
let askSentence='';
mountViewportPair(el('stage-layout'));
const viewportState=createViewportState();
let previousBuildView:ReturnType<typeof createPreviousBuildView>|null=null;
let previousBuildEnteredFromDifference=false,previousBuildSelection=0;
let previousBuildCamera:{camera:typeof viewportState;referenceGeneration:number}|null=null;
const partsCanvas=document.createElement('canvas'),partsReference=document.createElement('canvas');partsCanvas.width=partsCanvas.height=partsReference.width=partsReference.height=0;
let partsSubject:ReturnType<typeof bindPartsSubject>|null=null;
let setupPartsPersistence:(()=>Promise<void>)|null=null;
let rigDifference:{assets:ModelAssets;painting:HTMLImageElement;camera:ReturnType<typeof createViewportState>;hidden:Map<HTMLElement,boolean>;label:string;bookmark:InspectionBookmark}|null=null;
let rigDifferenceFailure:string|null=null;
const checkpointPairLabels={compare:'Side by side',before:'Before',after:'After',difference:'Difference'} as const;
const checkpointPairPrefix='checkpoint-pair-';
type CheckpointPairMode=keyof typeof checkpointPairLabels;
type CheckpointPairTile={pair:CheckpointPairView;side:'before'|'after'};
let checkpointPair:{pair:CheckpointPairView;mode:CheckpointPairMode;requestedMode:CheckpointPairMode;bookmark:InspectionBookmark;
 /** An explicit replay lasts while this pending pair (or its absence) holds. */
 replayFor?:CheckpointPairView|null;
 difference:Promise<HTMLCanvasElement>|null;generation:number;release:()=>void}|null=null;
const pairFrame=(target:CameraTarget)=>{
 const pair=checkpointPair?.pair;if(!pair||target==='rig'&&checkpointPair?.mode!=='compare')return null;
 const {image}=target==='rig'||checkpointPair?.mode==='after'||checkpointPair?.mode==='difference'?pair.after:pair.before;
 return {w:image.naturalWidth,h:image.naturalHeight};
};

const rigRaster={el,canvas:partsCanvas,message,reference:()=>null,
 frameSize:(target:CameraTarget)=>checkpointPair?pairFrame(target):activeInterviewImage
  ?target==='reference'&&referenceSize?{w:referenceSize.width,h:referenceSize.height}:null
  :{w:partsCanvas.width,h:partsCanvas.height},
 active:()=>!!checkpointPair||!!rigDifference||!!activeInterviewImage,
 pairedRig:()=>previousBuildView?.pane()??null};
if(partsOnly){partsCanvas.id='parts-canvas';el('rig-root').append(partsCanvas);el('reference-content').append(partsReference);}
let sceneComposite:ReturnType<typeof bindScenePlates>|undefined;
const activeScene=()=>sceneComposite&&data.direction&&(!stageSource||stageSource.url===inspectedModel?.url)?data.direction:undefined;
const sceneBox=()=>{const direction=activeScene();return direction?takeSample(direction,time).box:null;};
const rebuildFramingBoxes=new WeakMap<ModelAssets,PoseBounds>();
let viewportProvider=partsOnly?createPartsViewportProvider({el,canvas:partsCanvas,message,reference:()=>partsReference.width>0?partsReference:null,frameSize:target=>target==='reference'&&activeInterviewImage&&referenceSize?{w:referenceSize.width,h:referenceSize.height}:partsSubject?.frameSize(target)??null},viewportState):createRigViewportProvider({fitLabel:'Fit',framingBox:()=>sceneBox()??(assets?rebuildFramingBoxes.get(assets)??null:null),el,player:()=>player,assets:()=>assets,referenceSize:()=>referenceSize,view:()=>view,referenceGeneration:()=>referenceGeneration,parts:()=>parts,text,message,redrawOverlay,raster:rigRaster,pairedRig:rigRaster.pairedRig},viewportState);
// The first publication selects the existing provider without replacing the empty viewport.
const viewport=createViewportController(new Proxy(viewportProvider,{get:(_target,key)=>{
 const value=Reflect.get(viewportProvider,key,viewportProvider);return typeof value==='function'?value.bind(viewportProvider):value;
}}),viewportState);
const {fitCamera,paneFrame,availableCamera,alignCameras,renderCameraControls,setCameraSync,cameraAction,updateCamera,fitActiveCamera}=viewport;
// First, before any URL use: take the `#cap=` handoff into memory/session storage and strip it.
if(!host)connectLiveWindow(access);
let readOnly: string | null = null;
let actReadOnly: string | null = null;
let data: ReviewResponse;
let directionPanel:ReturnType<typeof bindDirectionPanel>|undefined;
let session: ReviewSession;
let dirty = false;
let saving = false;
let stripBusy = false;
let persistence:PersistenceConnection|null=null,submittedBaseline:ReviewSession|null=null,draftConflict=false,draftStatus:string|null=null;
let checkpoint: Checkpoint | undefined;
let assets: ModelAssets | null = null;
let player: RigPlayer | null = null;
let animation = '';
let playing = false;
let heldPhysicsFailed = false;
let time = 0;
/** The clock a scratch build on the stage states for its own animation (a retarget's report frameTimes, #164). */
let stageClock: StageClock | null = null;
let duration = 0;
let lastFrame = 0;
/** #346: wall-clock seconds accumulated toward the next fixed playback step. */
let playbackCarry = 0;
let comments:ReturnType<typeof bindStageComments>|null=null;
const recordComments:CommentRow[]=[];
let recordCommentKey='';
const submittedDirectionComments=new Set<string>();
/** #1242: record rows as an answered record act carried them, by id; a row written or edited after it is unsent. */
let answerInFlightRows:readonly CommentRow[]=[];let recordAnswered=false;
/** #1242: pinned parts issues an answered parts verdict carried (startParts owns the set). */
let partsSubmittedIssues:ReadonlySet<string>=new Set();
let localCommentSource:{publicationId:string;sourceHash:string;jobId?:undefined;draftId?:undefined;previousPublicationId?:undefined}|null=null;
let localCommentAttempt:{key:string;sendId:string}|null=null;
const localCommentNotes={rows:[] as {id:string;summary:string}[],available:()=>true};
let view: 'compare' | 'reference' | 'rig' = 'compare';
// Requested layout persists in the source-bound draft; the effective one follows actual load events only.
let rigInput:InputState={state:'pending'},referenceInput:InputState={state:'absent'},effectiveView:SingleLayout|null=null;
let playbackIntent=0,desiredPlay=false,seekingControl=false;
let parts:PartExplorer|null=null;
let animationPanel:AnimationInspectionPanel|null=null;
let inspectionSourceState:'ready'|'pending'|'failed'='ready';
function refreshAnimationInspection(){if(inspectionSourceState!=='ready'){animationPanel?.unavailable(`ANIMATION_INSPECTION_SOURCE_${inspectionSourceState.toUpperCase()}: current model source is unavailable`);return;}animationPanel?.update(time,duration);animationPanel?.model(partModel,player?.current??'');animationPanel?.update(time,duration);}
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
let stageModelBones:string[]|null=null;
function activeSetupBones():string[]|null{return data?.capabilities?.preRig?stageModelBones:data.feedbackCatalog.bones;}
function hasStageModel():boolean{return Boolean(data.manifest.model||(data?.capabilities?.preRig&&stageSource&&player));}
/** Apply · Rebuild (#99): the inspected model's URL, the producer status, and the applied record while its scratch build is on the stage. */
let inspectedModel:{url:string;prefix:string;sha256:string}|null=null,rebuildStatus:RebuildStatusView|null=null,appliedOnStage:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation|null=null,rebuildBusy=false,stageModelHash:string|null=null;
let appearance:ReturnType<typeof bindAppearance>|null=null;

let inspectorTabs:ReturnType<typeof bindInspectorTabs>|null=null;
let inspectorBlocks:InspectorBlocks|null=null;
let idleHeld=false;
let suspendedPreview=false;
let controlDispose:(()=>void)|null=null;
const viewDisposers:(()=>void)[]=[];
if(host)viewDisposers.push(onLanguageChange(()=>{if(host?.checkpointPairs&&checkpointPair)renderLayout();if(jobProgress&&!pendingAnswers.length)renderAskHeadline();}));
const layers={images:true,mesh:false,bones:false,meshOpacity:.65};
let chestMapping:CropWorldMapping={available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn'};
let setupChestWorld:{x:number;y:number}|null=null;
const readSetupChest=(p:RigPlayer|null):{x:number;y:number}|null=>{if(!p)return null;try{const b=p.bone('chest');return b&&Number.isFinite(b.x)&&Number.isFinite(b.y)?{x:b.x,y:b.y}:null;}catch{return null;}};
const activeChestMapping=():CropWorldMapping=>posedChestMapping(chestMapping,chestPoseOffset(player,setupChestWorld));
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
const {environmentApplied,gravityValue,useWorld,stageWorld,syncEnvironmentInputs,stepEnvironment:stepWorldEnvironment}=bindEnvironmentInputs(input,wind,()=>joltQueue,renderEnvironment);
/** Animate · Physics tuning (#103): the panel, the inspected model document it maps against, and the check lines of the build on the stage (null: the inspected build, which review has not checked). */
/** Animate · Idle tracks (#104): the panel; its preview drives `player.adjust`. */
let idlePanel:IdlePanel|null=null;
/** Setup · Rig fields (#110): the panel; its turn dial and the idle preview share `player.adjust` (both run, idle first). */
let rigFieldsPanel:RigFieldsPanel|null=null,idleAdjust:BoneAdjust|null=null,dialAdjust:BoneAdjust|null=null;
let turnPad:TurnPad|null=null,turnAdjust:BoneAdjust|null=null,animAdjust:BoneAdjust|null=null,inDrawRig=false;
function setAdjust():void {if(!player)return;player.adjust=composeAdjust(composeAdjust(composeAdjust(idleAdjust,dialAdjust),turnAdjust),animAdjust);if(!playing&&!inDrawRig)drawRig(()=>player!.draw());}
/** #106: the Setup Mesh panel, and the overlay's last snapshot (bar 1 reads its per-slot triangle count). */
let meshPanel:MeshPanel|null=null,lastOverlay:OverlaySnapshot|null=null,densityStrip:DensityStripPanel|null=null;
const physicsPreview=new PhysicsPreview();
let physicsPanel:PhysicsPanel|null=null,inspectedDocument:unknown=null,inspectedDocumentReason:string|null=null,stageCheck:{lines:string[];check:CheckSummary|null}|null=null;
/** Animate · Readings (#108): the block, the last finished job (its ticks and worst lines), and the run in flight. */
let requirementsPanel:RequirementsPanel|null=null,retargetPanel:RetargetPanel|null=null;
let readingsPanel:ReadingsPanel|null=null,readingsJob:ReadingsJobView|null=null,readingsBusy=false,readingsTickKey='';

function message(value: string, error = false, footerOnly = false, diagnostic?: string): void {
  if (!error) text('message', value);
  // A view readout (a Difference count) is not the act's state, so it stays in the footer only.
  if (footerOnly && !error) return;
  // A refusal belongs to the act row. Keep the previous status and its tooltip in the footer.
  const reviewMessage=el('review-message');
  const cleared = !error && reviewMessage.classList.contains('error');
  text('review-message', value); reviewMessage.classList.toggle('error', error);
  if (diagnostic) reviewMessage.title = diagnostic;
  if(error&&rigInspector.act.hidden){
    if(!rigInspector.answersRendered)for(const node of rigInspector.act.querySelectorAll<HTMLElement>('#save,#review-status,label[for="review-status"]'))node.hidden=true;
    rigInspector.act.hidden=false;
    rigInspector.syncActRow?.();
  }
  if(cleared&&host?.ownerActAccess)syncJobActRow();
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const hosted = host?.read(path, method); if (hosted) return await hosted as T;
  const response = await fetch(access.route(path), method === 'GET' || method === 'HEAD' ? init : { ...init, headers: access.headers(init?.headers) });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function referenceUrl(reference:Reference):string {return data.explicitReference?.id===reference.id?access.route(data.explicitReference.url):data.sourcePainting?.id===reference.id?access.route(data.sourcePainting.url):assetUrl(reference.path);}

function assetUrl(path: string, base=access.route('/assets/')): string {
  if (!path || path.startsWith('/') || /[\\%?#\x00-\x1f]/.test(path) || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsupported package asset path: ${path}`);
  return base + path.split('/').map(encodeURIComponent).join('/');
}

function markDirty(): void {
  dirty = true;
  updateSavedState();
}

function updateSavedState(): void {
  if (saving) { text('review-message', ''); el('review-message').classList?.toggle('error', false); }
  text('dirty', dirty ? 'Unsubmitted changes' : session.updatedAt ? 'Submitted' : 'Not submitted');
  el('dirty').classList.toggle('dirty', dirty);
  button('save').disabled = saving || draftConflict || !!readOnly || session.feedbackWarnings.length > 0;
  button('save').title = actReadOnly ? actReadOnly : session.feedbackWarnings.length ? 'Delete feedback with validation warnings, then add it again with a valid target.' : '';
  renderDraftState();
  renderAnswerControls();
}

/** C10: the act bar renders the latest local draft status; rig only classifies it. Nothing renders before the first status. */
// #1226: a row already sent on its own does not count toward a later Request changes.
let liveIssueCount=()=>{const fresh=(row:{id:string})=>!(typeof isSentAlone==='function'&&isSentAlone(row));
  return (session?.feedback.filter(fresh).length??0)+(host?.verdictComments?.rows.filter(fresh).length??0);};
/** #1226: the publication the screen's comments are bound to; #1242: rig and parts verdict comments, direction or record. */
const commentBinding=()=>host?.verdictComments??host?.direction??host?.record??(typeof localCommentSource!=='undefined'?localCommentSource:null);
/** #1226/#1242: a live rig, direction, parts or record screen can send its comments without an ask. */
function commentHost():boolean {return !!commentBinding()&&(!!host?.submitComments||typeof localCommentSource!=='undefined'&&!!localCommentSource);}
/** #1226: rows sent on their own as act@10, by id with the exact content sent. Such a row is shown Submitted and
 * is never sent again inside a later act (CONTRACT §1). Bound to the displayed publication and source. */
function sentAloneRows(store='rig-review-sent-alone/1'):Record<string,string> {
  const binding=commentBinding(),key=binding?`${store}:${binding.publicationId}:${binding.sourceHash}`:'';
  let cached=rowStoreCache.get(store);
  if(cached?.key!==key){
    const rows:Record<string,string>={};
    try{const stored=key?JSON.parse(localStorage.getItem(key)??'{}'):{};
      if(stored&&typeof stored==='object'&&!Array.isArray(stored))for(const [id,json] of Object.entries(stored))if(typeof json==='string')rows[id]=json;}catch{/* in memory only */}
    cached={key,rows};rowStoreCache.set(store,cached);
  }
  return cached.rows;
}
function isSentAlone(row:{id:string}):boolean {
  const sent=sentAloneRows();
  return typeof localCommentSource!=='undefined'&&localCommentSource
    ? Object.hasOwn(sent,row.id) : sent[row.id]===JSON.stringify(row);
}
function markSentAlone(rows:readonly {id:string}[],store='rig-review-sent-alone/1'):void {
  const sent=sentAloneRows(store);for(const row of rows)sent[row.id]=JSON.stringify(row);
  const key=rowStoreCache.get(store)?.key;
  try{if(key)localStorage.setItem(key,JSON.stringify(sent));}catch{/* in memory only */}
}
/** #1242: rows a successful record answer carried, by id with the exact content, kept across reloads. Rows the
 * answer did not carry (written later, or while it was in flight) stay for Send comments. */
const answerCarriedStore='rig-review-answer-carried/1';
const isAnswerCarried=(row:{id:string})=>sentAloneRows(answerCarriedStore)[row.id]===JSON.stringify(row);
/** The rows the record answer being submitted carries; committed only when that answer is saved. Draft saves read
 * the same words, so the snapshot holds still while an answer is in flight. */
function carryRecordRows(rows:readonly CommentRow[]):readonly CommentRow[] {
  if(host?.record&&host.recordSubmission?.()!=='sending')answerInFlightRows=rows.map(row=>structuredClone(row));
  return rows;
}
function commitAnswerCarried():void {
  if(answerInFlightRows.length)markSentAlone(answerInFlightRows,answerCarriedStore);
  answerInFlightRows=[];
}
const unsentFeedback=()=>(session?.feedback??[]).filter(row=>!isSubmittedFeedback(row.id));
/** #1242: what Send comments carries on this screen: rows neither sent on their own nor carried by an answered act. */
function unsentComments():{feedback:Feedback[];general:{id:string;summary:string}[];issues:PartsIssue[]} {
  const fresh=(row:{id:string})=>!isSentAlone(row);
  if((host?.direction||host?.record)&&typeof recordComments!=='undefined'){
    const rows=recordComments.filter(row=>fresh(row)&&!submittedDirectionComments.has(row.id)&&!isAnswerCarried(row));
    return {feedback:rows.filter(row=>'target' in row) as Feedback[],issues:rows.filter(row=>'schema' in row) as unknown as PartsIssue[],
      general:rows.filter(row=>!('target' in row)&&!('schema' in row))};
  }
  const general=(host?.verdictComments?.rows??(typeof localCommentNotes!=='undefined'?localCommentNotes.rows:[])).filter(fresh);
  if(typeof partsOnly!=='undefined'&&partsOnly)return {feedback:[],general,issues:(partsSubject?.issues()??[]).filter(issue=>fresh(issue)&&!partsSubmittedIssues.has(issue.id))};
  return {feedback:unsentFeedback(),general,issues:[]};
}
const hasUnsentComments=()=>{const unsent=unsentComments();return unsent.feedback.length+unsent.general.length+unsent.issues.length>0;};
/** #1231: a pending Edit Mesh or chest edit is content Send comments carries, as an unsent comment is. */
const hasUnsentContent=()=>hasUnsentComments()||!!host?.canSubmitMeshEdits?.();
/** An edit draft changes the answer controls and, beside Send comments, the save state (#1231). */
const renderEditDraftState=()=>commentHost()?renderDraftState():renderAnswerControls();
/** #1226: Send comments sends the screen's unsent comments as one act@10. #1242: bound once for every screen that
 * holds the act bar (rig, direction, parts and record), not by the rig workspace alone. */
sendComments.onclick=async()=>{
  if(!commentHost()||sendComments.disabled||saving)return;
  // The rig workspace's saved-state renderer reads its session; parts and a record without a picture have none.
  const savedState=()=>session?updateSavedState():renderDraftState();
  const composer=typeof partsOnly!=='undefined'&&partsOnly?partsSubject:comments;
  if(composer?.hasPendingComment?.()&&!await composer.commitDraft())return;
  const {feedback,general:generalRows,issues}=unsentComments(),general=generalRows.map(row=>row.summary);
  if(!feedback.length&&!general.length&&!issues.length&&!host?.canSubmitMeshEdits?.())return;
  // A new attempt replaces the previous refusal in the shared act row.
  if(typeof el==='function'&&el('review-message').classList.contains('error'))message(sourceTextContent(el('message')));
  saving=true;commentSending=true;savedState();
  let failure:ReturnType<typeof jobSubmissionRefusal>|null=null;
  try{
    const local=typeof localCommentSource!=='undefined'?localCommentSource:null;
    const sent=local
      ? await saveLocalComments(local.sourceHash,feedback,general,issues)
      : await host!.submitComments!(structuredClone(feedback),general,structuredClone(issues));
    // Sent rows stay in the list and show Submitted, pinned and general alike.
    markSentAlone([...feedback,...generalRows,...issues]);
    commentSendState='sent';dirty=hasUnsentContent();
    comments?.refresh();if(typeof partsSubject!=='undefined')partsSubject?.refreshComments();if(session)renderProposals();if(sent)message(sent);
  }catch(error){
    failure=jobSubmissionRefusal(error);
    if(typeof localCommentSource!=='undefined'&&localCommentSource&&error instanceof Error)failure.title=error.message;
    message(failure.text,true);
  }
  finally{
    saving=false;commentSending=false;savedState();
    if(failure)rigInspector.actBar.setSaveState({kind:'failed',text:failure.text,title:failure.title});
  }
};
async function saveLocalComments(sourceHash:string,feedback:readonly Feedback[],general:readonly string[],issues:readonly PartsIssue[]):Promise<string> {
  const comments=[...feedbackContextComments(feedback),...partsIssueComments(issues),...general.map(text=>({text}))];
  const value={comments},key=JSON.stringify({sourceHash,value});
  if(localCommentAttempt?.key!==key)localCommentAttempt={key,sendId:crypto.randomUUID()};
  const {sendId}=localCommentAttempt;
  const response=await fetch(access.route('/api/local-comments'),{
    method:'POST',headers:access.headers({'Content-Type':'application/json'}),
    body:JSON.stringify({sourceHash,sendId,value}),
  });
  const result=await response.json() as {error?:string;sendId?:string};
  if(!response.ok){
    if(response.status<500)localCommentAttempt=null;
    throw new Error(result.error??'JOB_ACT_INVALID');
  }
  if(result.sendId!==sendId)throw new Error('JOB_ACT_INVALID');
  localCommentAttempt=null;
  return '';
}
/** Rehydrate the shared sent-row cache for a local screen after navigation in the same browser. */
function restoreLocalSentRows<Row extends Feedback|PartsIssue>(rows:Row[],type:'target'|'schema'):void {
  for(const [id,raw] of Object.entries(sentAloneRows())){
    if(rows.some(row=>row.id===id))continue;
    try{
      const row=JSON.parse(raw);
      if(row&&row.id===id&&type in row)rows.push(type==='schema'?parsePartsIssue(row,false,true,false) as Row:row);
    }catch{/* Invalid browser cache has no authority. */}
  }
}
function renderDraftState(): void {
  const recordSubmission=host?.recordSubmission?.();
  // #1242: the rows an answered record act carried are not sent again by Send comments.
  if(typeof commitAnswerCarried==='function'&&host?.record){
    if(recordSubmission==='submitted'&&!recordAnswered)commitAnswerCarried();
    recordAnswered=recordSubmission==='submitted';
  }
  // #1242: on a record screen a comment written after the answer falls to Send comments' own state.
  if(recordSubmission&&!(host?.record&&recordSubmission==='submitted'&&typeof commentHost==='function'&&commentHost()&&hasUnsentContent())){
    rigInspector.actBar.setSaveState(recordSubmission==='sending'?{kind:'saving',text:'Sending'}:{kind:'saved',text:'Submitted'});
    recordSaveStateShown=true;
    renderAnswerControls();return;
  }
  if(host?.recordSubmission&&recordSaveStateShown){
    recordSaveStateShown=false;
    rigInspector.actBar.setSaveState({kind:'unsaved',text:'Not submitted'});
  }
  renderAnswerControls();
  const draftStorageProblem=draftStatus&&/^(The source changed, so |Local draft could not be saved|Local draft storage unavailable|Local draft needs explicit recovery)/.test(draftStatus)?draftStatus:null;
  const standaloneRestoreRefusal=!host&&draftStatus&&/^(Inspection was not restored|View link refused|View link was not restored): /.test(draftStatus);
  // Standalone inspection refusals keep their place in the draft state beside Send comments.
  if(typeof commentHost==='function'&&commentHost()&&!(saving&&!commentSending)&&!draftConflict&&!actReadOnly&&!draftStorageProblem&&!standaloneRestoreRefusal){
    const unsent=hasUnsentContent();
    rigInspector.actBar.setSaveState(saving?{kind:'saving',text:'Sending'}:
      !unsent&&(commentSendState==='sent'||!!session?.updatedAt||Object.keys(sentAloneRows()).length>0)?{kind:'saved',text:'Submitted'}:{kind:'unsaved',text:'Not submitted'});
    return;
  }
  if (draftStatus === null && !dirty && !saving && !draftConflict && !actReadOnly && !session?.updatedAt) return;
  rigInspector.actBar.setSaveState({ kind: actReadOnly ? 'read-only' : saving ? 'saving' : draftConflict ? 'failed' : dirty ? 'unsaved' : 'saved', text: draftConflict ? 'Saved draft could not be restored. Your draft has not been deleted. Download or discard it before submitting.' : saving ? 'Saving…' : draftStorageProblem??actReadOnly??draftStatus??(dirty ? 'Unsubmitted changes' : session?.updatedAt ? 'Submitted' : 'Not submitted') });
}

function renderProvenance(): void {
  const provenance = session.reviewedSource;
  text('provenance-version', provenance.packageRevision);
  el('provenance-rig').textContent = provenance.rig ? provenance.rig.sha256.slice(0, 12) + '…' : t('Not supplied');
  el('provenance-motion').hidden = !provenance.motion;
  el('provenance-motion-missing').hidden = !!provenance.motion;
  text('provenance-motion', provenance.motion ? provenance.motion.sha256.slice(0, 12) + '…' : '');
  text('provenance-full', JSON.stringify({ sourceHash: session.sourceHash, referenceBinding:session.referenceBinding, reviewedSource: provenance }, null, 2));
}
viewDisposers.push(onLanguageChange(()=>{if(session)renderProvenance();}));

function renderCheckpoints(): void {
  const list = el('checkpoints'); list.replaceChildren();
  for (const point of data.manifest.checkpoints) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'checkpoint';
    item.setAttribute('aria-current', String(point.id === checkpoint?.id));
    const label = document.createElement('span'); label.textContent = point.title;
    item.append(label); item.onclick = () => { void chooseCheckpoint(point); }; list.append(item);
  }
  if (!data.manifest.checkpoints.length) list.textContent = 'No checkpoints supplied.';
}

async function chooseCheckpoint(point: Checkpoint,initial?:{referenceId?:string;updateUrl:boolean}): Promise<void> {
  pause(); checkpoint = point; axisInspection = false;
  if(!host&&initial?.updateUrl!==false){const url = new URL(location.href); url.searchParams.set('checkpoint', point.id); window.history.replaceState(null, '', url);}
  if (point.animation) chooseAnimation(point.animation);
  time = point.time ?? 0;
  const referenceId=initial?.referenceId??point.reference;
  if (referenceId && select('reference-select').value !== referenceId) {
    select('reference-select').value = referenceId; await showReference(referenceId);
  }
  viewport.state.zoom = Math.min(8, Math.max(.25, point.camera?.zoom ?? 1));
  if(viewport.state.cameraSync)viewport.state.activeCamera=player?'rig':'reference';
  viewport.state.cameraCenter = point.camera ? { x: point.camera.x, y: point.camera.y } : null;
  // A checkpoint without its own camera opens at Fit, held until the panes are measured and until someone moves it.
  if(point.camera)viewport.cancelFit();else viewport.requestFit();
  seek(time);
  if (point.axis && player && !input('axis-value').disabled) {
    select('axis-select').value = point.axis.id; chooseAxis(); input('axis-value').value = String(point.axis.value); applyAxis();
  }
  if(viewport.state.cameraSync)alignCameras();fitCamera(); renderCheckpoint(); renderCheckpoints();
}

function renderCheckpoint(): void {
  el('checkpoint-detail').hidden=!checkpoint;
  text('checkpoint-title', checkpoint?.title ?? 'Review entire package');
  text('detail-title', checkpoint?.title ?? 'No checkpoint supplied');
  text('detail-note', checkpoint?.note ?? 'Record checkpoint notes and outcomes.');
  const entry = checkpoint ? session.checkpoints[checkpoint.id] : undefined;
  el('checkpoint-note').textContent = entry?.note ?? '';
}

function setView(value: typeof view): void {leavePreviousBuild();view=value;renderLayout();}

function leavePreviousBuild():void {
 ++previousBuildSelection;
 if(!previousBuildCamera)return;
 const {camera,referenceGeneration:priorReference}=previousBuildCamera;
 previousBuildView?.hide();
 viewport.cancelFit();
 // Preserve a reference explicitly selected while the retained build was visible.
 if(priorReference!==referenceGeneration){
  camera.referenceCenter=viewport.state.referenceCenter;
  delete camera.cameraFrames.reference;
 }
 Object.assign(viewport.state,camera);
 previousBuildCamera=null;
 if(video&&video.readyState>=1){
  holdVideoReference(video,referenceGeneration);
  if(playing&&referenceInput.state==='loaded')void video.play().catch(()=>{});
 }
 renderTransport();
 comments?.refresh();
}

async function choosePreviousBuild():Promise<void> {
 const previous=previousBuildView;
 if(!previous)return;
 if(previous.active()){
  const difference=previousBuildEnteredFromDifference;
  leavePreviousBuild();
  if(difference&&!rigDifferenceReason())await chooseInspectionView('difference');
  else renderLayout();
  return;
 }
 const selection=++previousBuildSelection;
 renderLayout();
 try{
  await previous.load();
  if(disposed||selection!==previousBuildSelection||checkpointPair||activeInterviewImages||rigInput.state!=='loaded'||!player)return;
  if(el('reference-viewport').querySelector('.stage-comment-composer')){
   message('COMMENT_BUSY: close the active editor or wait for the inspection to settle',true);
   return;
  }
  previousBuildEnteredFromDifference=!!rigDifference;
  leaveRigDifference();
  previousBuildCamera={camera:structuredClone(viewport.state),referenceGeneration};
  viewport.state.activeCamera='rig';
  previous.show(player);
  video?.pause();
  renderLayout();
  renderTransport();
  comments?.refresh();
 }catch(error){
  if(disposed||selection!==previousBuildSelection)return;
  leavePreviousBuild();renderLayout();message(errorText(error),true);
 }
}

async function chooseInspectionView(id:string):Promise<void> {
 if(checkpointPair){
  if(id.startsWith(checkpointPairPrefix)){
   const pair=host?.selectCheckpointPair?.(id.slice(checkpointPairPrefix.length));
   if(pair)await syncCheckpointPair(false,checkpointPair.requestedMode);
  }else await showCheckpointPair(id as CheckpointPairMode);
  return;
 }
 if(activeInterviewImages){const image=activeInterviewImages[Number(id.replace('interview-image-',''))];if(id.startsWith('interview-image-')&&image){activeInterviewImage=image;void showReference('',image);}return;}
 if(id==='previous-version'){await choosePreviousBuild();return;}
 leavePreviousBuild();
 if(!partsSubject){
  if(id==='difference'){
   const reason=rigDifferenceReason();if(reason){message(reason,true);renderLayout();return;}
   try{
    const painting=el('reference-content').querySelector<HTMLImageElement>('img')!;
    const still=captureRigRestStill(assets!,{width:painting.naturalWidth,height:painting.naturalHeight});
    const result=paintRigDifference(partsCanvas,still,painting);
    pause();
    if(!rigDifference)rigDifference={assets:assets!,painting,camera:structuredClone(viewport.state),hidden:new Map(),label:sourceTextContent(el('rig-label')),bookmark:inspectionBookmark()};
    partsCanvas.id='rig-difference-canvas';el('rig-root').append(partsCanvas);partsCanvas.hidden=false;
    for(const node of [...el('rig-root').children,...el('rig-viewport').children])if(node instanceof HTMLElement&&node!==partsCanvas&&node!==el('rig-root')&&node!==el('rig-label')&&node!==el('rig-empty')){if(!rigDifference.hidden.has(node))rigDifference.hidden.set(node,node.hidden);node.hidden=true;}
    viewport.cancelFit();viewport.state.cameraFrames={};viewport.state.cameraCenter=null;viewport.state.referenceCenter=null;viewport.state.activeCamera='rig';
    text('rig-label','Difference');setView('rig');viewport.fitActiveCamera('rig');
    message(t('Difference: {0} of {1} pixels differ, compared where the rig draws · rest still vs original painting.',[result.count,result.compared],'en'),false,true);
   }catch(error){leaveRigDifference();rigDifferenceFailure=errorText(error);message(rigDifferenceFailure,true);renderLayout();}
  }else{leaveRigDifference();setView(id as SingleLayout);}
  return;
 }
 const overlay=document.getElementById('parts-overlay') as HTMLInputElement;
 const subject=partsSubject;
 if(!await subject.setComparison(id==='difference'?'difference':overlay.checked?'overlay':'part')||partsSubject!==subject)return;
 if(id==='difference')overlay.checked=false;
 setView(id==='difference'?'rig':id as SingleLayout);
}
/** Availability follows the actual loaded image and declared native rig canvas, never a resized reference. */
function rigDifferenceReason():string|null {
 if(selectedInspector()!=='rig')return 'RIG_DIFFERENCE_SETUP_ONLY: Difference is available in Setup.';
 if(!assets||!player||rigInput.state!=='loaded')return 'RIG_DIFFERENCE_MODEL_UNAVAILABLE: no compiled rig is loaded.';
 const painting=el('reference-content').querySelector<HTMLImageElement>('img');
 if(referenceInput.state!=='loaded'||!painting?.naturalWidth)return 'RIG_DIFFERENCE_REFERENCE_UNAVAILABLE: select a loaded original painting image.';
 try{rigRestCanvas(assets,{width:painting.naturalWidth,height:painting.naturalHeight});}catch{return 'RIG_DIFFERENCE_NATIVE_SCALE: original painting and declared rig canvas must align at native scale.';}
 return rigDifferenceFailure;
}
/** Restore the compiled view without carrying image-space zoom, hidden layers or diagnostic pixels into capture. */
function leaveRigDifference():void {
 const previous=rigDifference;if(!previous)return;rigDifference=null;
 partsCanvas.remove();for(const [node,hidden]of previous.hidden)node.hidden=hidden;
 viewport.cancelFit();Object.assign(viewport.state,previous.camera);viewport.state.cameraFrames={};viewport.state.cameraLayout='';
 text('rig-label',previous.label);
}
function layoutEligibility(){return singleEligibility({rig:rigInput,reference:referenceInput,requested:view});}
/** Unavailable layouts stay visible but disabled with their named reason; no placeholder pane stands in for a missing input. */
function renderLayout():void {
 el('play').hidden=selectedInspector()!=='playback';
 if(checkpointPair){
  const {mode,pair}=checkpointPair;
  effectiveView=mode==='compare'?'compare':'reference';
  el('reference-pane').hidden=false;el('rig-pane').hidden=mode!=='compare';
  controls.setMode(mode);controls.setDisabled('difference',checkpointDifferenceReason(pair));
  text('layout-state',checkpointPairLabels[mode]);
  fitCamera();return;
 }
 if(controls.viewModeIds.includes('previous-version')&&renderPreviousBuildLayout())return;
 if(rigDifference&&(rigDifferenceReason()||rigDifference.assets!==assets||rigDifference.painting!==el('reference-content').querySelector('img')))leaveRigDifference();
 const state=layoutEligibility();effectiveView=state.effective;
 for(const id of controls.viewModeIds)if(id!=='difference'&&id!=='previous-version')controls.setDisabled(id,state.reasons[id as SingleLayout]??null);
 if(activeInterviewImages)controls.setMode('interview-image-'+activeInterviewImages.indexOf(activeInterviewImage!));
 else controls.setMode(rigDifference||partsSubject?.comparison().mode==='difference'?'difference':state.effective,state.effective??state.requested);
 if(partsSubject){
  const previousAvailable=partsSubject.previousDraftAvailable(),comparison=partsSubject.comparison();
  const available=partsSubject.differenceAvailable()&&rigInput.state==='loaded'&&(previousAvailable||referenceInput.state==='loaded');
  controls.setDisabled('difference',available?null:tr('PARTS_DIFFERENCE_UNAVAILABLE: missing painting_in_rig declaration or painting_in_rig.json sidecar and its bound operand.'));
  if(comparison.mode==='difference')controls.setMode('difference');
  const operand=screenRoot.querySelector<HTMLSelectElement>('#parts-difference-operand');
  if(operand){
   operand.parentElement!.hidden=!!activeInterviewImages||!previousAvailable||comparison.mode!=='difference';
   operand.value=comparison.mode==='difference'?comparison.operand??'painting':'painting';
   operand.title=operand.selectedOptions[0]?.title??'';
  }
 }
 if(!partsSubject){controls.setDisabled('difference',tr(rigDifferenceReason()??'')||null);if(rigDifference)controls.setMode('difference');}
 el('reference-pane').hidden=state.effective!=='compare'&&state.effective!=='reference';el('rig-pane').hidden=state.effective!=='compare'&&state.effective!=='rig';
 const shown={compare:'Side by side',reference:'Reference only',rig:'Rig only'};
 text('layout-state',state.effective===null?`No input rendered · ${state.reasons.compare??''}`:state.effective===state.requested?shown[state.effective]:`${shown[state.effective]} · ${shown[state.requested]} unavailable: ${state.reasons[state.requested]??''}`);
 fitCamera();
}
function renderPreviousBuildLayout():boolean {
 const ready=rigInput.state==='loaded';
 controls.setDisabled('previous-version',ready?null:tr(layoutEligibility().reasons.rig??''));
 if(!ready||!previousBuildView?.active())return false;
 effectiveView='compare';
 el('reference-pane').hidden=el('rig-pane').hidden=false;
 controls.setMode('previous-version');
 text('layout-state','Previous version');
 fitCamera();
 return true;
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

async function showReference(id: string, bound?:{name:string;src:string}): Promise<void> {
  if(checkpointPair)return;
  rigDifferenceFailure=null;leaveRigDifference();
  const generation = ++referenceGeneration;
  video?.pause(); video = null;controlledVideoSample=null;delete viewport.state.cameraFrames.reference; viewport.state.referenceCenter=null; referenceSize = null; sequence = null; sequenceSvg = null; selectedPerson=''; lastPoseFrame = -1; el('person-control').hidden = true;
  const content = el('reference-content'); content.replaceChildren();
  const reference = bound?{id:'',label:bound.name,type:'image' as const,path:''}:data.manifest.references.find(item => item.id === id);
  el('reference-empty').hidden = false;setReferenceInput(reference?{state:'pending'}:{state:'absent'});
  if(bound)viewport.requestFit();
  if (!reference) { text('reference-empty', 'No reference supplied.'); text('reference-info', 'Add image, video or input-pose references to the package.'); return; }
  text('reference-label', reference.label + (reference.type === 'pose' ? ' · Static input pose' : ' · Reference'));
  text('reference-empty', 'Loading reference…');
  text('reference-info', `${reference.type} · ${bound?bound.name:data.sourcePainting?.id === reference.id ? data.sourcePainting.path : reference.path}`);
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
      const image = new Image(); image.draggable=false; image.alt = reference.label; image.onload = () => { if (generation !== referenceGeneration) return; referenceSize = { width: image.naturalWidth, height: image.naturalHeight }; image.width = image.naturalWidth; image.height = image.naturalHeight; el('reference-empty').hidden = true; fitCamera(); }; await new Promise<void>((resolve,reject)=>{const loaded=image.onload;const timer=setTimeout(()=>reject(new Error('Reference image load timed out')),10000);image.onload=event=>{clearTimeout(timer);if(typeof loaded==='function')loaded.call(image,event);resolve();};image.onerror=()=>{clearTimeout(timer);fail();reject(new Error('Reference image load failed'));};image.src=bound?.src??referenceUrl(reference);content.append(image);});
      await image.decode(); if (generation !== referenceGeneration) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('Reference image has no renderable pixels'); setReferenceInput({state:'loaded'});
    } else {
      const media = document.createElement('video'); media.controls = true; media.muted = true; media.preload = 'metadata'; media.playsInline = true;
      media.onloadedmetadata = () => { if (generation !== referenceGeneration) return; referenceSize = { width: media.videoWidth, height: media.videoHeight }; media.width = media.videoWidth; media.height = media.videoHeight; if (Number.isFinite(media.duration) && !player) duration = media.duration; el('reference-empty').hidden = true; holdVideoReference(media, generation); fitCamera(); renderTransport(); };
      media.onerror = () => fail('reference video could not be decoded'); media.src = referenceUrl(reference); video = media; content.append(media);
    }
  } catch (error) { fail(errorText(error)); message(errorText(error), true); }
}

function renderTransport(): void {
  refreshAnimationInspection();
  const end = duration > 0 ? ` / ${duration.toFixed(4)}` : '';
  text('time-label', sequence&&!previousBuildView?.active() ? `Source ${(time + sequence.frames[0]!.t).toFixed(4)} ↔ ${time.toFixed(4)}${end} s` : `${time.toFixed(4)}${end} s`);
  input('scrub').max = String(Math.max(duration, .001)); input('scrub').value = String(time); input('scrub').disabled = duration <= 0;
  button('play').disabled = (!player && !video && !sequence) || duration <= 0;
  renderFrameTransport();
  renderReadingTicks();
  idlePanel?.place(duration);physicsPanel?.refreshPreview();
}

/** Re-lay the reading ticks only when what places them changes (renderTransport runs every played frame). */
function renderReadingTicks(force = false): void {
  if (!readingsPanel) return;
  const box = scrubBox(input('scrub')), key = `${readingsJob?.id ?? ''}|${readingsJob?.runs.map(r => r.results.length).join(',')}|${animation}|${duration}|${box.left},${box.top},${box.width}`;
  if (!force && key === readingsTickKey) return;
  readingsTickKey = key; readingsPanel.ticks(readingsJob, animation, duration);
}

function feedbackAnimation(): string | null { return player && player.current !== animation ? null : animation || null; }

function renderFrameTransport(): void {
  const active = activeTransportClock(), clock = active?.clock ?? null;
  const last = lastProducerFrame(clock), frame = frameAtTime(clock, time);
  text('rig-label', host?.direction&&data.direction ? `Take · ${formatSeconds(data.direction.take.duration)} s` : rigPaneLabel({ hasPlayer: !!player, animation: player?.current ?? animation, time, frame }));
  el('frame-controls').hidden = last === null;
  if (!clock) { text('frame-label', data.report?.clock ? data.report.animation ? 'Frame unknown · report and current clip do not match' : 'Frame unknown · report animation not supplied' : 'rate unknown'); return; }
  if (last === null) { text('frame-label', 'F? / ? · frame range unknown'); return; }
  text('frame-label', `F${frame === null ? '?' : frame} / ${last}${frame === null ? ' · Out of range' : ''}`);
  text('frame-clock-label', (clock.kind === 'uniform' ? `${clock.fps} fps · frame0 ${formatSeconds(clock.frame0)} s` : `frameTimes · ${clock.frameTimes.length} explicit times`) + (active?.source === 'stage' ? " · this build's report" : ''));
  input('frame-number').max = String(last);
  if (document.activeElement !== input('frame-number')) input('frame-number').value = frame === null ? '' : String(frame);
  input('frame-scrub').max = String(last); input('frame-scrub').hidden = frame === null;
  if (frame !== null) input('frame-scrub').value = String(frame);
  input('frame-scrub').disabled = last === 0;
  el('frame-outside').hidden = frame !== null;
}

function activeTransportClock() {
  if(activeScene())return null;
  const active = player && player.current !== animation ? '' : animation;
  return transportClock({ clock: data.report?.clock, animation: data.report?.animation, frameClocks: data.feedbackCatalog?.frameClocks }, active, !!player, stageClock, stageModelHash);
}
function activeFrameClock() { return activeScene()?null:activeTransportClock()?.clock ?? null; }

function seekFrame(frame: number): void {
  const exact = timeAtFrame(activeFrameClock(), frame);
  if (exact === null) { message('Select an integer frame within the explicit clock bounds.', true); renderFrameTransport(); return; }
  pause();
  if ((duration > 0 && exact > duration) || (video && video.readyState >= 1 && Number.isFinite(video.duration) && exact > video.duration)) { message(`F${frame} maps to ${exact} s, outside the current reference range. The requested time was not changed.`, true); renderFrameTransport(); return; }
  seek(exact);
  message(`F${frame} · Explicit time ${exact} s${!player && !video && !sequence ? ' (No playback reference · time display only)' : ''}`);
}

function drawRig(action:()=>void,previousFrame?:'seek'|((view:NonNullable<typeof previousBuildView>)=>void)):void {
 if(rigDifference&&rigDifference.assets!==assets){leaveRigDifference();renderLayout();}
 inDrawRig=true;
 try{
  const box=sceneBox();if(box&&player?.renderer instanceof CanvasRenderer)player.renderer.viewport=box;
  action();if(box&&player)sceneComposite?.draw(player,box);
  parts?.present('single');chestEditor?.syncJobTarget();
  if(player&&previousBuildView?.active()){
   try{
    if(typeof previousFrame==='function')previousFrame(previousBuildView);
    else previousBuildView.present(player,previousFrame==='seek');
   }catch(error){leavePreviousBuild();renderLayout();message(errorText(error),true);}
  }
  if(box)viewport.fitCamera();
  if(player&&inspectionSourceState==='ready')animationPanel?.capture(player,parts?.frame('single'));else animationPanel?.capture(null,undefined);
  text('renderer-state',rendererStatus(player?.renderer??null,'succeeded').label);redrawOverlay(true);
 }
 catch(error){animationPanel?.capture(null,undefined);overlays?.clear();text('renderer-state',rendererStatus(null,'failed').label);throw error;}
 finally{inDrawRig=false;}
}

function chooseAnimation(name: string, move: ClipMove = { kind: 'choose' }): void {
  if(rigDifference){leaveRigDifference();renderLayout();}
  pause(); animation = name; axisInspection = false; el('angle-panel').hidden = true;
  const runtimeAnimation = assets?.animations.find(item => item.name === name);
  duration = activeScene()?.take.duration??clipDuration(name);
  select('animation-select').value = name;
  // #191: the wind restarts before the clip's first frame is drawn, so the paused stage shows the schedule's t=0 world.
  time = 0; const scene=activeScene();if(!scene)clipMoved(move);
  if (player && runtimeAnimation) {
    restartSetupPlayer();
    if(scene){player.play(name,{loop:canRepeatIdle()});player.pause();seek(0,move);}
    else drawRig(()=>{player!.play(name,{loop:canRepeatIdle()});player!.pause();refreshAnimationInspection();player!.draw();},'seek');
  }
  else if (player && name){text('renderer-state',rendererStatus(null,'failed').label);message(`Animation "${name}" is not present in the rig.`, true);}
  renderTransport(); renderCues();renderIdle();
}

function seek(value: number, move?: ClipMove): void {
  if(rigDifference){leaveRigDifference();renderLayout();}
  time = duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value);
  clipMoved(move ?? { kind: 'seek', to: time });
  if (player && player.current) { try { player.seek(activeScene()?takeSample(activeScene()!,time).sourceTime:time); drawRig(()=>player!.draw(),'seek'); } catch (error) {text('renderer-state',rendererStatus(null,'failed').label); message(errorText(error), true); } }
  if (video && video.readyState >= 1 && !previousBuildView?.active()) holdVideoReference(video, referenceGeneration);
  renderSequenceFrame(); renderTransport();
}

function stopAudio(): void { for (const audio of audioPlaying) audio.pause(); audioPlaying.clear(); }
function pause(): void { ++playbackIntent;desiredPlay=false;suspendedPreview=false;idleHeld=true; heldPhysicsFailed=false; playing = false; lastFrame = 0; playbackCarry = 0; player?.hold(true); player?.resume(); video?.pause(); stopAudio(); button('play').textContent = '▶'; button('play').setAttribute('aria-label', 'Play'); }

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
    const jump = actionButton('Go to cue', () => { pause(); seek(cue.time); });
    const play = actionButton('Audition', () => { void audition(cue.clip); }, !clip);
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

function selectReportTarget(): void {
  if (!selectedReportEvent) return;
  const {target}=eventSelection(selectedReportEvent,selectedReportTarget);
  if (!target || !feedbackTargetNames(data.feedbackCatalog,target.kind)?.includes(target.name)) return;
  if (target.kind==='bone') animationPanel?.select(target);
  else parts?.select({side:'single',slot:target.name,mode:parts.value()?.mode??'context'});
}

function chooseReportEvent(event: ReportEvent): void {
  pause(); selectedReportEvent = event; selectedReportTime = undefined; selectedReportTarget = undefined;
  const selection = eventSelection(event);
  const times = select('report-time'); times.replaceChildren();
  for (const [index, value] of selection.exactTimes.entries()) times.append(option(String(index), `${index + 1}. ${value} s`));
  times.hidden = !selection.exactTimes.length; el('report-time-label').hidden = times.hidden;
  const targets = select('report-target'); targets.replaceChildren(option('', 'Select target'));
  for (const [index, target] of selection.targets.entries()) targets.append(option(String(index), targetLabel(target)));
  el('report-target-control').hidden = selection.targets.length <= 1;
  renderReportSelection(); renderReportEvents();
  if (event.seek) seekReportEvent();
  selectReportTarget();
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
  if (duration > 0 && exact > duration) { message(`Explicit time ${formatSeconds(exact)} s is outside the current range of ${formatSeconds(duration)} s. No substitute time was used.`, true); return false; }
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
  if(suspended||disposed||!screenRoot.isConnected)return;
  // #356: the scrub box is read before this frame writes anything (a read after the writes forces a layout).
  if (playing) try { holdScrubBox(input('scrub')); tickPlaying(now,!previousBuildView?.active()); } finally { releaseScrubBox(); }
  else tickHeldPhysics(now);
  frameHandle=requestAnimationFrame(tick);
}

/** A callback can owe zero or several fixed steps. Each stepped rig draws once after the batch. */
function drawRigSteps(current:RigPlayer,steps:readonly number[],held:boolean,take?:{direction:NonNullable<ReturnType<typeof activeScene>>;from:number}):void {
 const paired=previousBuildView?.active();
 const takeSteps:TakeStep[]|undefined=paired&&take?[]:undefined;
 const advance=(rig:RigPlayer)=>{for(const step of steps)rig.advance(step);};
 drawRig(()=>{
  if(take)advanceTake(current,take.direction,take.from,steps,takeSteps);
  else advance(current);
  current.draw();
 },paired?view=>view.step(takeSteps?rig=>{
  for(const {kind,seconds} of takeSteps)applyTakeStep(rig,kind,seconds);
 }:advance,held,take?1:current.timeScale):undefined);
}

/** Animate steps held physics under the standing environment; wind time and queued jolts stay frozen. */
function tickHeldPhysics(now:number):void {
 const elapsed=lastFrame?Math.min((now-lastFrame)/1000,.1):0;lastFrame=now;
 if(heldPhysicsFailed||!player?.current||document.hidden||selectedInspector(document)!=='playback'||seekingControl){playbackCarry=0;return;}
 const next=advancePlayback({time,duration,carry:playbackCarry,elapsed,repeat:false,held:true});
 playbackCarry=next.carry;
 if(!next.steps.length)return;
 try{
  player.hold(true);player.resume();
  drawRigSteps(player,next.steps,true);
 }catch(error){heldPhysicsFailed=true;player.pause();playbackCarry=0;message(errorText(error),true);}
}

function tickPlaying(now: number,useReference=true): void {
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0;
  // #346: fixed PLAYBACK_STEP steps from wall-clock time; a repeating clip wraps here with no seek, so physics carries across the loop.
  const previous = time, next = advancePlayback({ time, duration, carry: playbackCarry, elapsed: dt, repeat: canRepeatIdle() && !idleHeld });
  playbackCarry = next.carry; time = next.time;
  const stepped = next.steps.reduce((sum, step) => sum + step, 0);
  // The wrap does what the replaced seek(0) did besides the player: restart the wind clock and re-hold the reference at the wrapped time.
  if (next.wrapped) { stopAudio(); clipMoved({ kind: 'replay' }); if (video && useReference) { if (video.readyState >= 1) holdVideoReference(video, referenceGeneration); void video.play().catch(error => { pause(); message(errorText(error), true); }); } }
  if (player && player.current && next.steps.length) {
   try {
    const direction=activeScene();stepEnvironment(stepped);
    drawRigSteps(player,next.steps,false,direction?{direction,from:previous}:undefined);
   } catch (error) { pause(); message(errorText(error), true); }
  }
  if (useReference && video && video.readyState >= 1 && time > video.duration) { if (referenceInput.state !== 'out-of-domain') holdVideoReference(video, referenceGeneration); } else if (useReference && video && referenceInput.state === 'loaded' && Math.abs(video.currentTime - time) > .15) video.currentTime = time;
  if (input('sync-audio').checked) for (const cue of activeCues()) if (cueDue(cue.time, previous, next, duration)) void audition(cue.clip);
  renderSequenceFrame(); renderTransport(); if (next.ended) pause(); lastFrame = now;
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
/** Verify the same response consumed by Play, rather than a second read of its source. One request per input per
 * load (#1050): the verified response is kept for this load, and the part catalog and model document read it again
 * through the same fetch. A new load (a rebuild, another build) calls this again and gets a fresh request. */
function stageLoadInputs(modelUrl:string, modelHash:string, previousSignal?:AbortSignal) {
 const setsUrl=!previousSignal&&modelUrl===inspectedModel?.url&&data.manifest.sets&&data.setsHash
  ?new URL(assetUrl(data.manifest.sets),location.href).href:null;
 const verified=new Map<string,Promise<Response>>();
 const checkedFetch=new Proxy(fetch,{apply:async(_target,_this,args:Parameters<typeof fetch>)=>{
  const url=String(args[0]),expected=url===modelUrl?modelHash:url===setsUrl?data.setsHash:null;
  if(!expected)throw new Error('DIRECTION_SOURCE_CHANGED: undeclared playback input');
  let pending=verified.get(url);
  if(!pending){pending=(async()=>{
   const response=previousSignal?await fetch(args[0],{...args[1],signal:previousSignal}):await fetch(...args);
   if(!response.ok)return response;
   const bytes=await response.arrayBuffer();
   const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
   if(sha256!==expected)throw new Error('DIRECTION_SOURCE_CHANGED: playback bytes differ from the bound SHA-256');
   return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
  })();verified.set(url,pending);}
  return (await pending).clone();
 }});
 return {setsUrl,fetch:checkedFetch};
}

function configurePartSets(keep=''):void {
 const picker=select('part-set'),presets=player?.sets()??[];
 picker.replaceChildren(option('', 'Original set'),...presets.map(set=>option(set.name,set.name)));
 picker.disabled=!presets.length;
 if(keep&&presets.some(set=>set.name===keep)){player!.setSet(keep);picker.value=keep;}
}

/** One creation path for initial load, rebuilds and a post-Setup single-track restart. */
function createInspectionPlayer(root:HTMLElement,loaded:ModelAssets,mode?:RigPlayer['mode'],source?:{url:string;sha256:string}):RigPlayer {
 const direction=source&&data.direction;
 const declared=source&&direction?.composed&&source.url===inspectedModel?.url&&source.sha256===direction.model.sha256?loaded.stage:null;
 const stage=declared&&declared.width>0&&declared.height>0?declared:null;
 const next=new RigPlayer(root,loaded,{mode:stage?'canvas':mode});
 if(stage&&next.renderer instanceof CanvasRenderer){
  next.renderer.viewport=stage;
  // Play rounds its canvas origin outward in Y-down space. Clip the rounded raster in canvas-local CSS units.
  const top=-(stage.y+stage.height);
  const x=stage.x-Math.floor(stage.x),y=top-Math.floor(top);
  const right=x+stage.width,bottom=y+stage.height;
  const corners=[[x,y],[right,y],[right,bottom],[x,bottom]].map(point=>point.map(value=>`${value}px`).join(' '));
  next.renderer.canvas.style.clipPath='polygon('+corners.join(', ')+')';
 }
 next.on('event',event=>{text('event-log',`Runtime event: ${event.name} · ${event.time.toFixed(2)} s`);});
 return next;
}
/** Public clear composes tracks permanently; restart single-track seeking over the same immutable assets. */
function restartSetupPlayer(force=false):void {
 const previous=player,loaded=assets;if(!previous||!loaded||!force&&(previous.current!==null||!previous.composed))return;
 const skin=previous.skin,sets=[...previous.activeSets],slots=previous.slots,adjust=previous.adjust,world=previous.environment(),mode=previous.mode;
 const entries=partModel&&inspectionSourceState==='ready'?partCatalog(partModel,data.feedbackCatalog.slots??[]):null;
 const source=data.direction?.composed?(stageSource?{url:stageSource.url,sha256:stageSource.hash}:inspectedModel??undefined):undefined;
 previous.dispose();player=createInspectionPlayer(el('rig-root'),loaded,mode,source);
 player.skin=skin;if(sets.length)player.setSets(sets);player.slots=slots;player.adjust=adjust;player.environment(world);
 setupChestWorld=readSetupChest(player);
 if(entries)parts?.register('single',entries,player,new PartThumbnails(pageRegionTable(partModel),loaded.pageImages));
}
async function initPlayer(initialCheckpoint?:Checkpoint): Promise<void> {
  text('renderer-state',rendererStatus(null,'pending').label);
  if (!data.manifest.model) { text('player-state', 'No rig supplied · reference review is available'); return; }
  text('player-state', 'Loading compiled rig…');
  try {
    const modelUrl = new URL(assetUrl(data.manifest.model), location.href).href;
    inspectedModel={url:modelUrl,prefix:access.route('/assets/'),sha256:data.reviewedSource.rig?.sha256??''};stageModelHash=inspectedModel.sha256||null;
    const inputs=stageLoadInputs(modelUrl,inspectedModel.sha256);
    assets = await loadModel({ modelUrl, ...inputs, resolvePage: (name, url) => {
      const target = new URL(name, url); if (target.origin !== location.origin || !target.pathname.startsWith(access.route('/assets/'))) throw new Error(`Model page escapes local package: ${name}`); return target.href;
    } });
    if(data.scene){sceneComposite=bindScenePlates(data.scene,await loadScenePlates(data.scene,assetUrl));input('idle-repeat').checked=data.direction!.take.loop;input('idle-repeat').disabled=true;}
    player = createInspectionPlayer(el('rig-root'), assets,sceneComposite?'canvas':undefined,inspectedModel);
    setupChestWorld = readSetupChest(player);
    // Parts inspection is an add-on: a catalog refusal is shown in the explorer and never aborts the rig.
    try{const catalog=await loadPartModel(modelUrl,data.reviewedSource.rig!.sha256,data.feedbackCatalog.slots??[],inputs.fetch);inspectionSourceState='ready';partModel=catalog.model;configureTurnPad(catalog.model);refreshAnimationInspection();weightsView?.refresh();parts?.register('single',catalog.entries,player,new PartThumbnails(pageRegionTable(catalog.model),assets.pageImages));}catch(error){inspectionSourceState='failed';partModel=null;refreshAnimationInspection();parts?.refuseCatalog('single',error);}
    const animations = select('animation-select'); animations.replaceChildren();
    for (const item of assets.animations) animations.append(option(item.name, data.manifest.animations.find(a => a.id === item.name)?.label ?? item.name));
    animations.disabled = assets.animations.length === 0 || !!data.scene;
    if(host?.chestLandmarks?.length)updateChestMapping();
    const names=assets.animations.map(clip=>clip.name),initial=data.scene?.animation??initialIdleAnimation(names,initialPlayerAnimation(names,data.initialAnimation??undefined,initialCheckpoint),!!data.initialAnimation||!!initialCheckpoint?.animation||!!initialCheckpoint?.axis);
    if(initial)chooseAnimation(initial);else drawRig(()=>player!.draw());
    el('rig-empty').hidden = true; text('player-state', '@rig-c/play · Actual rig');
    configurePartSets();
    const validAxes = data.manifest.axes.filter(axis => assets?.animations.some(item => item.name === axis.animation));
    text('axis-state', validAxes.length ? `${validAxes.length} axes` : 'No inspection axes supplied');
    select('axis-select').replaceChildren(); for (const axis of validAxes) select('axis-select').append(option(axis.id, axis.label));
    input('axis-value').disabled = !validAxes.length;
    for(const id of ['layer-images','layer-mesh','layer-bones'])input(id).disabled=false;
    enableEnvironment(modelUrl,inputs.fetch);
    describeLayerToggles(document,el('layer-state').textContent??'');
    fitCamera();
  } catch (error) { turnPad?.dispose();turnPad=null;document.getElementById('turn-pad-host')?.remove();text('renderer-state',rendererStatus(null,'failed').label);player?.dispose(); player = null; assets?.dispose(); assets = null; text('player-state', 'Rig load failed'); text('rig-empty', `Could not open rig: ${errorText(error)}`); message(errorText(error), true); }
  directionPanel?.refresh();
}

function chooseAxis(): void {
  const axis = data.manifest.axes.find(item => item.id === select('axis-select').value);
  const clip = assets?.animations.find(item => item.name === axis?.animation); if (!axis || !clip || !player) return;
  pause(); chooseAnimation(clip.name); axisInspection = true; syncPlayerLoop(); el('angle-panel').hidden = false;
  input('axis-value').min = String(axis.min); input('axis-value').max = String(axis.max); input('axis-value').step = String((axis.max - axis.min) / 200); input('axis-value').value = String((axis.max + axis.min) / 2); text('axis-label', axis.label); applyAxis();
}

function applyAxis(): void {
  const axis = data.manifest.axes.find(item => item.id === select('axis-select').value);
  if (!axis || !player) return;
  const value = Number(input('axis-value').value); text('axis-value-label', value.toFixed(3)); seek((value - axis.min) / (axis.max - axis.min) * duration);
}

/** A changed draft with the same id is still editable; only the exact submitted row is locked. */
function isSubmittedFeedback(id:string):boolean {
  const row=session.feedback.find(item=>item.id===id);
  if(typeof isSentAlone==='function'){const sent=row??host?.verdictComments?.rows.find(item=>item.id===id)??(typeof localCommentNotes!=='undefined'?localCommentNotes.rows.find(item=>item.id===id):undefined);if(sent&&isSentAlone(sent))return true;}
  return !!row&&!!submittedBaseline?.updatedAt&&submittedBaseline.feedback.some(item=>item.id===id&&JSON.stringify(item)===JSON.stringify(row));
}

function renderProposals(): void {
  comments?.refresh();
  if(host?.direction){setSourceText(rigInspector.comments.button,`Comments (${recordComments.length})`);return;}
  const count=session.feedback.length+(host?.verdictComments?.rows.length??(typeof localCommentNotes!=='undefined'?localCommentNotes.rows.length:0));setSourceText(rigInspector.comments.button, `Comments (${count})`);
  const area = el('proposal-list'); area.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  const unchecked = session.feedback.map(f => appliedCheckRefusal((f.context as Record<string, unknown> | undefined)?.applied)).find(Boolean) ?? null;
  el('feedback-applied-check').hidden = !unchecked; text('feedback-applied-check', unchecked ? `${unchecked} · Submit refuses this review; delete the entry written on that build or Apply a build that passes check.` : '');
  warnings.textContent = session.feedbackWarnings.length ? `${session.feedbackWarnings.length} validation warnings in existing feedback · original records are preserved. Review the marked entries, delete them and add valid replacements before submitting. The saved session that rig-review feedback exports keeps both the original records and warnings.` : '';
  for (const feedback of session.feedback) {
    if (!comments || !hasPinnedComment(feedback)) renderFeedbackDetails(feedback,area);
  }
  updateSavedState();
}

function hasPinnedComment(feedback:Feedback):boolean {
  return hasStageComment((feedback.context as Record<string,Json>|undefined)?.comment);
}

function renderFeedbackDetails(feedback:Feedback,row:HTMLElement):void {
    const marked=hasPinnedComment(feedback);
    const item = document.createElement('div'); item.className = 'proposal-item';
    if(!marked){
      const heading = document.createElement('strong');
      const title = document.createElement('span'); title.className = 'feedback-heading'; title.textContent = `${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · `;
      const timing = document.createElement('span'); timing.textContent = feedbackTimingLabel(feedback); heading.append(title, timing);
      const description = document.createElement('span'); description.className = 'feedback-summary'; description.textContent = feedback.summary;
      item.append(heading, description);
    }
    const context = feedback.context as Record<string, Json> | undefined;
    const correction = context?.correction as {path?: string;selector?:{kind?:string}} | undefined;
    if (correction) {
      const label = document.createElement('p');
      const schema=(context?.applied as {schema?:string}|undefined)?.schema;
      const unsupported=correction.selector?.kind==='post'||schema!=='rig-review-applied/2';
      setSourceText(label, correction.path === 'described'
        ? correction.selector?.kind === 'post' && data.direction && !context?.applied
          ? 'Direction request · bound to inspected model and direction'
          : 'Unresolved correction request'
        :
        unsupported ? 'Unsupported correction operation' : 'Made correction evidence');
      item.append(label);
    }
    if (marked && !readOnly && !isSubmittedFeedback(feedback.id)) {
      const actions=document.createElement('div');actions.className='comment-correction-actions';
      actions.append(actionButton(t('Use as described correction'),()=>recordCommentCorrection(feedback,'described')));
      if (appliedOnStage && !rebuildBusy) actions.append(actionButton(t('Use as made correction'),()=>recordCommentCorrection(feedback,'made')));
      item.append(actions);
    }
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `Validation warning · ${warning.error}`; item.append(note); }
    const details = document.createElement('details'), summary = document.createElement('summary'), source = document.createElement('pre'); summary.textContent = 'Saved feedback and inspection context'; source.className = 'feedback-json'; source.textContent = JSON.stringify(feedback, null, 2); details.append(summary, source);
    item.append(details);
    if(!marked)item.append(actionButton('Delete', () => { session.feedback = session.feedback.filter(item => item.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); markDirty(); renderProposals(); }));
    row.append(item);
}

function recordCommentCorrection(feedback:Feedback,path:'described'|'made'):void {
  try {
    if (saving || readOnly || isSubmittedFeedback(feedback.id) || !session.feedback.includes(feedback)) return;
    if (!feedback.summary.trim() || feedback.summary.length>1000) throw new Error(tr('Correction text must be valid UTF-8 and at most 1,000 characters.'));
    const correction=correctionSelection(path),applied=appliedOnStage,context=feedback.context as Record<string,Json>|undefined;
    if (path==='made' && (!applied || rebuildBusy)) throw new Error(tr('CORRECTION_APPLY_PENDING: Apply and check the correction first.'));
    feedback.context={...context,correction,...(path==='made'?{
      applied:structuredClone(applied) as unknown as Json,
      environment: feedbackEnvironment(),
      environmentSchedule: feedbackSchedule() as unknown as Json,
      readings: readingsContext() as unknown as Json,
      requirements:(requirementsPanel?.context()??null) as unknown as Json,
    }:context?.correction ? {applied:null} : {})};
    markDirty();renderProposals();void persistence?.save();
  } catch (error) { message(errorText(error),true); }
}

function syncCorrectionStage(): void {
  el('correction-post-fields').hidden = select('correction-stage').value !== 'direction-review';
}

function correctionSelection(path: 'described' | 'made'): Json {
  const stage = select('correction-stage').value, identity = input('correction-selector').value;
  const joined = data.direction?.joined;
  if (stage === 'direction-review' && joined) {
    if (path === 'made') throw new Error(t('direction.cameraApplyUnavailable'));
    if (identity !== String(joined.postVersion)) throw new Error(tr('Choose the joined Create post version.'));
  }
  if (stage === 'parts-review' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(identity)) {
    return { path, selector: { stage, kind: 'draft', id: identity } };
  }
  const version = Number(identity);
  if (/^[1-9][0-9]*$/.test(identity) && Number.isSafeInteger(version)) {
    if (stage === 'rig-review') return { path, selector: { stage, kind: 'rig', version } };
    const modelFile = input('correction-model').value;
    if (stage === 'direction-review') {
      if (path === 'described' && data.direction && modelFile !== data.reviewedSource.rig?.path) {
        throw new Error(tr('Use the inspected compiled model path for an authored direction request.'));
      }
      if (modelFile) return { path, selector: { stage, kind: 'post', version, modelFile } };
    }
  }
  throw new Error(tr('Choose the explicit Create source identity.'));
}

function download(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadStrip(name: string, content: Blob): void {
  const url = URL.createObjectURL(content), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stripStatus(value: string, error = false): void { text('strip-status', value); el('strip-status').setAttribute('role', error ? 'alert' : 'status'); }

function updateStripControls(): void {
  el('strip-panel').hidden=!!readOnly||!data.manifest.references.some(reference=>reference.type==='video');
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
    if (!session.feedback.length) throw new Error('No feedback ranges to export.');
    for (const feedback of session.feedback) {
      const context = feedback.context;
      if (!context || typeof context !== 'object' || Array.isArray(context) || context.animation !== selectedAnimation) throw new Error(`Feedback ${feedback.id}: Its animation is missing or differs from the selected animation. Batch export supports ranges from the same animation only.`);
      intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: 'single', ...requireFeedbackFrames(feedback) });
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


function sealedRecordRigReadOnly():string|null {return host?.record&&data?.recordSource?readOnly:null;}

function bind(): void {
  button('strip-export').onclick = () => { void exportStrip(); };
  button('chest-export').onclick = () => { void exportChest(); };
  for (const event of ['input', 'change']) el('chest-regions').addEventListener(event, renderChest);
  // A discarded local draft restores the form after its button's own handler; re-read the tool then.
  for (const id of ['draft-recovery', 'review-draft-recovery']) el(id).addEventListener('click', () => { renderChest(); restoreEnvironment(); physicsPanel?.restore(); bonesPanel?.restore(); cutsPanel?.restore(); clothPanel?.restore(); idlePanel?.restore(); rigFieldsPanel?.restore(); syncCorrectionStage(); });
  for (const id of ['strip-scope', 'strip-reference', 'strip-format']) select(id).onchange = () => stripStatus('Selection changed. Check the ranges, animation and reference video before downloading.');
  const angleTool = el<HTMLButtonElement>('motion-tools').querySelector<HTMLButtonElement>('[data-proposal="angle"]')!;
  angleTool.onclick = () => { if (!input('axis-value').disabled) { showInspector('playback'); chooseAxis(); } };
  select('reference-select').onchange = () => { void showReference(select('reference-select').value); };
  select('person-select').onchange = () => { selectedPerson = select('person-select').value; lastPoseFrame = -1; renderSequenceFrame(); };
  select('animation-select').onchange = () => {
    const wasPlaying = playing;
    chooseAnimation(select('animation-select').value);
    if (wasPlaying) void playPreview();
  };
  select('part-set').onchange = () => { try { if(!player)return;player.setSet(select('part-set').value || null);drawRig(()=>player!.draw());fitCamera(); } catch (error) {text('renderer-state',rendererStatus(null,'failed').label); message(errorText(error), true); } };
  select('axis-select').onchange = chooseAxis; input('axis-value').oninput = applyAxis;
  viewport.bindControls(unitScaleMessage);
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
  select('report-target').onchange = () => { const value = select('report-target').value; selectedReportTarget = value ? Number(value) : undefined; selectReportTarget(); };
  select('review-status').onchange = () => { session.status = select('review-status').value as ReviewSession['status']; markDirty(); };
  button('save').onclick = async () => {
    if(readOnly){message(readOnly,true);return;}
    if(draftConflict){message('Resolve the saved local draft conflict before submitting.',true);return;}
    if (session.feedbackWarnings.length) { message('Resolve validation warnings in existing feedback before submitting. Delete the marked entries and add valid replacements.', true); return; }
    saving = true; updateSavedState(); const savedPayload = JSON.stringify(session);
    if (host) {
      let submissionFailure: ReturnType<typeof jobSubmissionRefusal> | null = null;
      const generalRows = host.verdictComments?.rows;
      // #1226: a comment already sent on its own is not sent again inside the verdict (CONTRACT §1).
      const alreadySent = typeof isSentAlone === 'function' ? (row: {id: string}) => isSentAlone(row) : () => false;
      const verdictRows = generalRows?.filter(row => !alreadySent(row));
      const general = verdictRows?.map(row=>row.summary);
      try {
        const sent = await host.submit(structuredClone(session), async committed => {
          submittedBaseline = {...submittedBaseline!, ...committed.review,
            checkpoints: {...submittedBaseline!.checkpoints, ...committed.checkpoints}, updatedAt: committed.at};
          session.updatedAt = committed.at;
          if (generalRows && verdictRows?.length && committed.review) {
            const sentIds = new Set(verdictRows.map(row => row.id));
            generalRows.splice(0, generalRows.length, ...generalRows.filter(row => !sentIds.has(row.id)));
            persistRecordComments();
          }
          const ids = new Set([...Object.keys(session.checkpoints), ...Object.keys(submittedBaseline.checkpoints)]);
          dirty = session.status !== submittedBaseline.status || JSON.stringify(session.feedback) !== JSON.stringify(submittedBaseline.feedback) ||
            !!generalRows?.some(row => !alreadySent(row)) ||
            [...ids].some(id => JSON.stringify(session.checkpoints[id] ?? {outcome: 'pending', note: ''}) !==
              JSON.stringify(submittedBaseline!.checkpoints[id] ?? {outcome: 'pending', note: ''}));
          if(host?.direction){for(const row of recordComments)submittedDirectionComments.add(row.id);try{localStorage.removeItem(recordCommentKey);}catch{}}
          await persistence?.submitted(submittedBaseline);
          comments?.refresh(); renderProposals();
        },host.direction?recordJobComments(recordComments.filter(row => !alreadySent(row))):undefined,general,alreadySent);
        if (sent) message(sent);
      } catch (error) {
        submissionFailure = jobSubmissionRefusal(error);
        message(submissionFailure.text, true);
      }
      finally {
        saving = false; updateSavedState();
        if (submissionFailure) {
          rigInspector.actBar.setSaveState({kind: 'failed', text: submissionFailure.text, title: submissionFailure.title});
        }
      }
      return;
    }
    try { const saved = await api<ReviewSession>('/api/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: savedPayload });
      if (JSON.stringify(session) === savedPayload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt;
      submittedBaseline=structuredClone(saved);comments?.refresh();await persistence?.submitted(saved);renderProvenance();renderProposals();
      message(dirty ? 'Changes were made during submission. Submit again.' : 'Saved locally. The producer received no feedback.');
    } catch (error) { message(`Submission failed: ${errorText(error)}`, true); } finally { saving = false; updateSavedState(); }
  };
  // Saved browser defaults seed a new inspection; explicit links and source drafts restore over them.
  directionPanel=bindDirectionPanel(el('stage-layout'),()=>{
    const inspected=!!inspectedModel&&(!stageSource||stageSource.url===inspectedModel.url);
    const model=player&&stageModelHash?{path:inspected?data.manifest.model!:new URL(stageSource!.url).pathname,sha256:stageModelHash,inspected}:null;
    return {model,revision:data.manifest.revision,sourceHash:data.sourceHash,runtime:data.reviewedSource.runtimeVersion,
      dials:player?turnPad?.state.dials??[]:[],sets:player?.sets().map(set=>set.name)??[],activeSet:select('part-set').value,authored:data.direction,scene:data.scene};
  },name=>{
    const picker=select('part-set');picker.value=name;picker.dispatchEvent(new Event('change',{bubbles:true}));
  });
  directionPanel.show(!!data.direction);
  viewDisposers.push(()=>directionPanel?.dispose());
  bindWorkspace(!!data.manifest.model);
  overlays=new RigOverlays({canvas:el<HTMLCanvasElement>('rig-overlay'),rigRoot:el('rig-root')});
  chestEditor=bindChestEditor({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>activeChestMapping(),
   job:host?(readOnly||host.direction?'read-only':{
    hasPublishedSpec:()=>!!host?.chestLandmarks?.length,
    seeds:()=>inspectionSourceState==='ready'&&stageModelHash===data.reviewedSource.rig?.sha256&&chestMapping.available?host?.chestLandmarks??[]:[],
    selection:()=>{const part=parts?.value();return part?{slot:part.slot,skin:part.identity?.skin??null,attachment:part.identity?.attachment??null}:null;},
    download:edit=>download('chest-landmarks.json',JSON.stringify(edit,null,2)+'\n','application/json'),
   }):undefined,
   changed:()=>{renderChest();if(host)renderEditDraftState();},download:()=>{void exportChest();},apply:()=>{void applyRebuild();},reset:()=>{void resetRebuild();},message,inspector:()=>selectedInspector()});viewDisposers.push(()=>chestEditor?.dispose());
  const editRefusal=sealedRecordRigReadOnly();
  if(editRefusal)chestEditor.unavailable(editRefusal);
  meshEditor=bindMeshEditor({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,mapping:()=>chestMapping,inspector:()=>selectedInspector(),readOnly:!!editRefusal,source:meshSource,pause,
   job:host?(host.record||host.direction||!host.access.capability?'read-only':{slots:()=>data.feedbackCatalog.slots??[],modelHash:()=>inspectionSourceState==='ready'&&chestMapping.available?stageModelHash:null}):undefined,changed:()=>{if(host)renderEditDraftState();redrawOverlay(false);},download:doc=>{void exportMesh(doc);},
   apply:(doc,line)=>applyMeshDelta(doc,line),applied:()=>appliedOnStage?.schema==='rig-review-applied/3',resetBuild:()=>resetRebuild(stageWorld()),message,confirm:text=>window.confirm(tr(text)),token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});viewDisposers.push(()=>meshEditor?.dispose());
  weightsView=bindWeightsView({pane:el('rig-pane'),canvas:el('rig-overlay'),project:()=>player?rigProject():null,inspector:()=>selectedInspector(),slot:()=>parts?.value()?.slot??stageDraftSelection?.slot??null,
   model:()=>hasStageModel()?partModel??undefined:null,setup:slot=>assets?setupPoseMesh(assets,partModel,slot,document.createElement('div')):null,changed:()=>redrawOverlay(false),
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
  meshPanel=bindMeshPanel({pane:el('rig-pane'),project:()=>player?rigProject():null,mapping:()=>chestMapping,bones:()=>activeSetupBones()??[],
   apply:async(part,entry)=>{await applyMesh(part,entry);},reset:resetMeshBuild,folds:async()=>{await meshFolds();},changed:()=>{redrawOverlay(false);densityStrip?.changed();},saved:()=>persistence?.save(),
   token:name=>getComputedStyle(document.documentElement).getPropertyValue(name).trim()});
  viewDisposers.push(()=>meshPanel?.dispose());
  // #173: the density strip beside the Mesh panel's density field.
  densityStrip=bindDensityStrip({part:()=>meshPanel?.part()??null,entry:()=>meshPanel?.entry()??null,build:buildDensityStrip,load:async i=>{await stageLoadStripRow(rigStageJobs, i);},back:()=>stageStripBack(rigStageJobs),close:closeDensityStrip});
  idlePanel=bindIdlePanel({apply:async(ops,keys)=>{await applyIdle(ops,keys);},reset:resetIdleBuild,pane:el('rig-pane'),saved:()=>persistence?.save(),
   preview:fn=>{idleAdjust=fn;setAdjust();},
   bonePoints:bones=>{if(!player)return null;const project=rigProject(),out=new Map<string,{x:number;y:number}>();for(const name of bones){try{const b=player.bone(name);out.set(name,project(b.x,b.y));}catch{/* a bone this model lacks has no handle */}}return out;}});
  viewDisposers.push(()=>idlePanel?.dispose());
  rigFieldsPanel=bindRigFieldsPanel({apply:async ops=>{await applyRigFields(ops);},reset:resetRigFieldsBuild,reading:async(bone,relative)=>{await runReadings({readings:[{kind:'angle-range',bone,relative}]});},
   part:()=>parts?.value()?.slot??stageDraftSelection?.slot??null,inspector:()=>selectedInspector(),pause,saved:()=>persistence?.save(),
   toPane:(x,y)=>{if(!player||!chestMapping.available)return null;const w=chestMapping.toWorld(x,y);return rigProject()(w.x,w.y);},
   toRig:(x,y)=>player&&chestMapping.available?canvasToCrop(rigProject(),chestMapping.toWorld,{x,y}):null,
   slotBox:slot=>{const frame=player?.posedFrame();if(!frame)return null;try{const b=partBounds(frame,slot);if(!b)return null;const project=rigProject(),a=project(b.x,b.y),c=project(b.x+b.width,b.y+b.height);return {left:Math.min(a.x,c.x),right:Math.max(a.x,c.x),top:Math.min(a.y,c.y),bottom:Math.max(a.y,c.y)};}catch{return null;}},
   dial:fn=>{dialAdjust=fn as BoneAdjust|null;setAdjust();},
   hasTurn:()=>{if(!player)return false;try{player.bone(TURN_BONE);return true;}catch{return false;}}});
  viewDisposers.push(()=>rigFieldsPanel?.dispose());
  readingsPanel=bindReadingsPanel({run:()=>{void runReadings();},seek:seekReading});
  retargetPanel=bindRetargetPanel({apply:body=>applyRetarget(body),reset:()=>{void resetRebuild(stageWorld());},seek:seekReading});
  requirementsPanel=bindRequirementsPanel({check:runRequirements,seek:seekReading,animation:()=>animation,slot:()=>parts?.value()?.slot??stageDraftSelection?.slot??null,hash:sha256Hex});
  const tickResize=new ResizeObserver(()=>renderReadingTicks());tickResize.observe(el('transport'));viewDisposers.push(()=>tickResize.disconnect());
  viewDisposers.push(viewport.bindNavigation(rigPanCarry({player:()=>player},viewport.state),panOnly=>!comments?.active()||!!panOnly));
  for(const [id,key] of [['layer-images','images'],['layer-mesh','mesh'],['layer-bones','bones']] as const)input(id).onchange=()=>{layers[key]=input(id).checked;redrawOverlay(false);};
  viewDisposers.push(bindLayerShortcuts(document));describeLayerToggles(document,el('layer-state').textContent??'');
  input('idle-repeat').onchange=()=>{syncPlayerLoop();renderIdle();if(animation==='idle'&&canRepeatIdle())void playPreview();};
  bindEnvironment();
  for(const id of ['proposal-panel','checkpoint-detail'])el(id).addEventListener('focusin',pause);
  bindInspector();
  document.addEventListener('visibilitychange',()=>{if(!screenRoot.isConnected)return;if(document.hidden){const resume=playing;pause();suspendedPreview=resume;}else if(suspendedPreview){suspendedPreview=false;void playPreview();}},{signal:lifecycle.signal});
  const resize = viewport.observeResize();
  window.addEventListener('beforeunload', event => { if (screenRoot.isConnected&&dirty) { event.preventDefault(); event.returnValue = ''; } },{signal:lifecycle.signal});
  viewDisposers.push(()=>resize.disconnect());
}

/** The one shell and block binding, for either subject. */
function bindWorkspace(hasModel=false,empty=false):void {
  if(!workspace){
  const layout=screenRoot.querySelector<HTMLElement>('.layout')!;layout.append(communicationPanel);
  // #1242: a comment added or removed, or Comment pressed or released, opens or closes the panel when commenting flips.
  let wasCommenting=false;
  const followCommenting=()=>{const now=commenting();if(now===wasCommenting)return;wasCommenting=now;if(now)workspace?.refresh();else workspace?.concealCommunication();};
  const commentWatch=new MutationObserver(followCommenting);
  commentWatch.observe(communicationPanel,{childList:true,subtree:true});commentWatch.observe(el('stage-comment'),{attributes:true,attributeFilter:['aria-pressed']});
  workspace=bindWorkspaceUI({root:screenRoot,regions:{layout,left:screenRoot.querySelector<HTMLElement>('.left-panel')!,main:el('stage-layout').parentElement!,stage:el('stage-layout'),bottom:screenRoot.querySelector<HTMLElement>('.inspector')!,right:communicationPanel,columns:{left:'rightWidth',right:'communicationWidth'},rightPending:communicationPending,bottomBound:()=>inspectorBlocks!==null},language:shell.language!,bottomPanel:rigInspector,changed:fitCamera,defaultTheme:theme=>appearance?.set(theme),currentTheme:()=>appearance?.get()});
  viewport.state.cameraSync=workspace.defaults().defaultCameraSync;input('camera-sync').checked=viewport.state.cameraSync;input('idle-repeat').checked=workspace.defaults().defaultIdleRepeat;
  appearance=bindAppearance(select('settings-theme'),workspace.defaults().theme);
  }
  if(empty)return;
  bindReviewDialog();
  // Comment rows sit above the provenance block and the review form.
  const comments=rigInspector.comments.panel;comments.hidden=false;
  comments.querySelector('.review-dialog-header')?.after(el('comments-list-host'));
  communicationPanel.append(comments);
  inspectorBlocks=bindInspectorBlocks({sections:[el('inspector-rig'),el('inspector-playback')],available:host?.record&&(!host.record.hasPicture||!hasModel&&!partsOnly)?['feedback']:undefined,bottom:{strip:rigInspector.strip},changed:()=>{if(!checkpointPair)syncQuestionImage();workspace?.refresh();persistence?.save();}});
  workspace?.refresh();
}
async function start(): Promise<void> {
  try {
    if(host?.waiting){
      bindWorkspace(false,true);
      el('rig-pane').hidden=false;el('reference-pane').hidden=false;
      const partStatus=screenRoot.querySelector<HTMLElement>('[data-part-status]')!;
      const loadingCopy=[['message',sourceTextContent(el('message'))],['layout-state',sourceTextContent(el('layout-state'))]] as const,partStatusCopy=sourceTextContent(partStatus);
      for(const id of ['package-title','revision','rig-empty','reference-empty','dirty','message','layout-state'])text(id,'');
      setSourceText(partStatus,'');
      const controls=[...screenRoot.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,textarea,button')]
        .filter(control=>control.id!=='settings-language').map(control=>({control,disabled:control.disabled}));
      for(const {control}of controls)control.disabled=true;
      for(const control of [button('save'),select('review-status'),screenRoot.querySelector<HTMLElement>('label[for="review-status"]')!])control.hidden=true;
      renderAskHeadline(t('job.waiting',undefined,'en'));syncJobActRow();
      await workspace?.settle();if(disposed)return;
      const next=await new Promise<RigHost>((resolve,reject)=>{
        lifecycle.signal.addEventListener('abort',()=>reject(new Error('JOB_PRELOAD_CANCELLED')),{once:true});
        host!.attach({publish:resolve,stage:()=>null,redraw:()=>{},
          message:(value,error,diagnostic)=>message(value,error,false,diagnostic),syncActRow:syncJobActRow,progress:setJobProgress,suspend:()=>{},dispose:disposeScreen});
      });
      if(disposed)return;
      host=next;access=next.access;partsOnly=next.subject==='parts';
      for(const [id,value]of loadingCopy)text(id,value);
      setSourceText(partStatus,partStatusCopy);
      for(const {control,disabled}of controls)control.disabled=disabled;
      if(partsOnly){
        partsCanvas.id='parts-canvas';el('rig-root').append(partsCanvas);el('reference-content').append(partsReference);
        viewportProvider=createPartsViewportProvider({el,canvas:partsCanvas,message,reference:()=>partsReference.width>0?partsReference:null,
          frameSize:target=>target==='reference'&&activeInterviewImage&&referenceSize?{w:referenceSize.width,h:referenceSize.height}:partsSubject?.frameSize(target)??null},viewportState);
      }
    }
    if(host?.record&&!host.record.hasPicture){await startRecord();return;}
    let writes: { capabilityRequired: boolean; control?: boolean };
    const opened=await api<ReviewResponse|PartsSubjectEntry|InterviewSubjectEntry>('/api/review');
    if('subject' in opened&&opened.subject==='interview'){
      await startRecord(opened);
      if(ownerStage&&!disposed)bindOwnerStage(opened.sourceHash);
      return;
    }
    const [saved,accessState]=await Promise.all([api<ReviewSession|PartsSubjectSession>('/api/session'),api<{capabilityRequired:boolean;control?:boolean}>('/api/access')]);
    if('subject' in opened&&opened.subject==='parts'){await startParts(opened,saved as PartsSubjectSession,accessState);return;}
    data=opened as ReviewResponse;session=saved as ReviewSession;writes=accessState;
    if(!host&&data.capabilities.feedback)localCommentSource={publicationId:'local-package:'+data.manifest.id,sourceHash:data.sourceHash};
    const previous=data.manifest?.previousBuild;
    if(previous){
      const base=data.assetsBase==='/assets/'?access.route(data.assetsBase):data.assetsBase;
      previousBuildView=createPreviousBuildView(previous,{el,signal:lifecycle.signal,
        url:path=>new URL(assetUrl(path,base),location.href).href,
        modelFetch:(url,hash)=>stageLoadInputs(url,hash,lifecycle.signal).fetch});
      viewDisposers.push(previousBuildView.dispose,controls.replaceViewSwitch(inspectionViewSwitch(chooseInspectionView,true,true)));
    }
    // A sealed record rig is the question's picture, so open its existing rig-only view.
    if(host?.record && data.recordSource)view='rig';
    readOnly = host?.unavailable?t('job.refusal.'+host.unavailable):host?.record ? tr('JOB_REVIEW_READ_ONLY') : readOnlyReason(access, writes.capabilityRequired);
    actReadOnly = readOnlyReason(access, writes.capabilityRequired, host?.ownerActAccess);
    if(data.capabilities.preRig&&!host?.record){rigInspector.comments.button.disabled=true;rigInspector.act.hidden=true;}
    submittedBaseline=structuredClone(session);
    text('package-title', data.manifest.title); text('revision', data.manifest.revision); document.title = `${data.manifest.title} · rig review`; text('source-hash', `source ${data.sourceHash.slice(0, 12)}`); select('review-status').value = session.status;
    select('reference-select').replaceChildren(); for (const reference of data.manifest.references) select('reference-select').append(option(reference.id, `${reference.label} · ${reference.type}`));
    for (const reference of data.manifest.references.filter(item => item.type === 'video')) select('strip-reference').append(option(reference.id, reference.label));
    if (!data.manifest.references.length) { select('reference-select').append(option('', 'No references supplied')); select('reference-select').disabled = true; }
    // Checkpoints and reference fold away when the package supplies neither.
    (el('package-context') as HTMLDetailsElement).open = data.manifest.checkpoints.length > 0 || data.manifest.references.length > 0;
    const sourceFiles = el('source-files'); for (const file of data.manifest.authoring) { const a = document.createElement('a'); a.href = assetUrl(file.path); a.textContent = file.label; a.className = 'source-link'; a.target = '_blank'; a.rel = 'noopener'; sourceFiles.append(a); } if (!data.manifest.authoring.length) sourceFiles.textContent = 'No source files supplied';sourceFiles.parentElement!.hidden=!data.manifest.authoring.length;
    populateChestBones(); bind(); parts=new PartExplorer(el('workspace-left'),el('selected-part'),previous=>{if(rigDifference){leaveRigDifference();renderLayout();}const part=parts?.value();if(!stageCorrectionRebinding&&(previous?.side!==part?.side||previous?.slot!==part?.slot||previous?.mode!==part?.mode))stageDraftRequestToken++;if(player&&inspectionSourceState==='ready')animationPanel?.capture(player,parts?.frame('single'));else animationPanel?.capture(null,undefined);weightsView?.refresh();redrawOverlay(true);meshEditor?.selectionChanged();if(stageCorrectionPart&&!stageCorrectionRebinding&&(part?.slot??null)!==stageCorrectionPart){stageCorrectionPart=null;document.getElementById('stage-draft-label')?.remove();}animationPanel?.fromParts(part?.slot??null);meshPanel?.select(part?.slot??null);if(host)chestEditor?.sync();else if(part&&!stageCorrectionRebinding)void openStageCorrection({part:part.slot,instrument:'selection'});requirementsPanel?.selectionChanged();renderDropNotices();if(part){viewport.state.activeCamera='rig';if(view==='reference')setView('rig');if(selectedInspector(document)!=='playback')showInspector('rig');renderCameraControls();}if(!viewport.state.cameraRestoring&&(previous?.side!==part?.side||previous?.slot!==part?.slot))cameraAction(()=>fitActiveCamera(part?'rig':availableCamera()));persistence?.save();}); animationPanel=new AnimationInspectionPanel({hideGateBanner:!!host?.direction,readOnlyReason:sealedRecordRigReadOnly,hasTurnDial:()=>inspectionSourceState==='ready'?!!turnPad:undefined,host:el('animation-inspection'),stage:el('rig-viewport'),project:(x,y)=>rigProject()(x,y),enabled:()=>inspectionSourceState==='ready'&&selectedInspector(document)==='playback',pause,preview:fn=>{animAdjust=fn;if(!player)return;player.adjust=composeAdjust(composeAdjust(composeAdjust(idleAdjust,dialAdjust),turnAdjust),animAdjust);if(!inDrawRig&&player.current&&!playing){if(activeScene())seek(time);else{player.seek(time);drawRig(()=>player!.draw());}}},apply:ops=>stageApplyAnimation(rigStageJobs, ops),reset:()=>stageResetAnimation(rigStageJobs),seek:exact=>{if(!Number.isFinite(exact)||exact<0||exact>duration){message('KEY_TIME_OUT_OF_DOMAIN: no substitute time was used.',true);return;}seekMarker(animation,exact,'Stored key');},select:value=>{const slot=value?.kind==='slot'?value.name:null;if((parts?.value()?.slot??null)!==slot)parts?.select(slot?{side:'single',slot,mode:parts?.value()?.mode??'context'}:null);parts?.highlightBone(value?.kind==='bone'?value.name:null);redrawOverlay(false);}});viewDisposers.push(()=>animationPanel?.dispose()); updateStripControls(); renderCheckpoints(); renderProposals(); renderProvenance(); updateSavedState(); renderCues(); initReport();
    if(!host&&!data.capabilities.preRig)renderPendingSubjects([]);
    const requestedId = new URLSearchParams(location.search).get('checkpoint'),initial=initialReviewSelection(data.manifest,requestedId,data.explicitReference?.id,data.initialAnimation??undefined),first=initial.checkpoint;
    rigInput=data.manifest.model?{state:'pending'}:{state:'absent'};renderLayout();
    // A job rig subject lands in Animate before the model finishes loading (#709).
    if(host)showInspector(data.manifest.model?'playback':'rig');
    if(initial.referenceId){select('reference-select').value=initial.referenceId;await showReference(initial.referenceId);}
    await initPlayer(first);
    // initPlayer keeps `player` only after its first draw succeeded; a declared model path alone never counts.
    if(!host?.chestLandmarks?.length)updateChestMapping();
    rigInput=player?{state:'loaded'}:data.manifest.model?{state:'failed',reason:el('rig-empty').textContent||'compiled player unavailable'}:{state:'absent'};renderLayout();
    if (first) await chooseCheckpoint(first,initial); else renderCheckpoint();
    viewport.state.activeCamera=player?'rig':'reference';if(viewport.state.cameraSync)alignCameras();renderTransport();fitCamera();
    if (requestedId && !first) message(`Checkpoint "${requestedId}" is not in this package. Select one from the list.`, true);
    else if (actReadOnly) message(actReadOnly);
    else if (host?.ownerActAccess) message('Not submitted',false,true);
    else message(data.manifest.model ? 'Saves locally. The producer receives no feedback.' : 'No rig supplied. Review the available references and checkpoints.');
    frameHandle=requestAnimationFrame(tick);
    const restored=await setupPersistence();if(localCommentSource)restoreLocalSentRows(session.feedback,'target');setupComments();renderPendingSubjects(host?.pendingSubjects?.()??[]);if(host?.direction)showRecordComments(true);else if(host?.record&&!data.manifest.model)showRecordComments();await loadRebuildStatus();void loadRequirements();renderChest();restoreEnvironment();physicsPanel?.restore();bonesPanel?.restore();cutsPanel?.restore();clothPanel?.restore();idlePanel?.restore();rigFieldsPanel?.restore();meshPanel?.restore();void refreshDensityStrip();renderIdle();if(idlePreviewOnOpen(restored,!!host)&&canRepeatIdle()&&automaticIdlePreview(assets?.animations.map(item=>item.name)??[],animation,first,!!requestedId))void playPreview();
    // Only an instance that serves agent control is asked for its config: a plain open has no control endpoint (#164).
    if(!readOnly&&writes.control!==false)controlDispose=connectControl({sourceHash:data.sourceHash,mode:'single',route:access.route,headers:()=>access.headers(),observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
    bindOwnerStage(data.sourceHash);
    if(host){
      if(!player&&video){
        await waitReferenceMetadata(video,lifecycle.signal);
        if(video.readyState<2)await mediaReady(video,'loadeddata',lifecycle.signal);
        if(video.seeking)await mediaReady(video,'seeked',lifecycle.signal);
        if(!video.seeking&&video.readyState>=2&&video.currentTime===time)setReferenceInput({state:'loaded'});
      }
      if(!player&&(data.manifest.model||referenceInput.state!=='loaded'))throw new Error('JOB_VISUAL_UNAVAILABLE');
      await restorePublicationNavigation();document.body.dataset.ready='true';
      const screen:JobRigMeshScreen={recordForms:renderRecordForms,pendingSubjects:renderPendingSubjects,progress:setJobProgress,stage:hostStage,redraw:()=>{if(player&&!playing)drawRig(()=>player!.draw());},message:(value,error,diagnostic)=>message(value,error,false,diagnostic),syncActRow:syncJobActRow,...host.record?{}:{incompatible:()=>navigationMissing,navigation:()=>({subject:'rig' as const,bookmark:navigationBookmark()})},suspend:suspendScreen,resume:resumeScreen,dispose:disposeScreen,
        hasMeshEdits:()=>!!meshEditor?.hasJobEdits(),meshEdits:async()=>meshEditor?.jobEdits()??null,chestLandmarks:()=>chestEditor?.jobEdits()??null};
      hostAttached=true;host.attach(screen);showInspector(data.manifest.model?'playback':'rig');host.displayed();
    }
  } catch (error) { if(disposed)return;message(`Could not open review package: ${errorText(error)}`, true); text('dirty', 'Load failed'); host?.failed(error); }
}
/** Parts have a verdict and image-space pixels, never fabricated model/session fields. */
async function startParts(opened:PartsSubjectEntry,saved:PartsSubjectSession,writes:{capabilityRequired:boolean}):Promise<void>{
 const subject=opened.parts,issues=saved.issues;let partsBaseline=structuredClone(saved);const submittedIssues=new Set(host? saved.issues.map(issue=>issue.id):[]);
 if(!host){
  localCommentSource={publicationId:'local-parts:'+access.key,sourceHash:subject.sourceHash};
  for(const issue of saved.issues)submittedIssues.add(issue.id);
 }
 const notes=host?.verdictComments??(localCommentSource?localCommentNotes:null);
 const generalRows=notes?.rows;partsSubmittedIssues=submittedIssues;
 // #1242: a comment sent on its own is not counted, flagged or sent again by the parts verdict (CONTRACT §1).
 const fresh=(row:{id:string})=>!isSentAlone(row);
 liveIssueCount=()=>issues.filter(fresh).length;
 if(!partsOnly)throw new Error('PARTS_SUBJECT_ENTRY_REQUIRED');
 readOnly=host?.record?tr('JOB_REVIEW_READ_ONLY'):readOnlyReason(access,writes.capabilityRequired);
 actReadOnly=readOnlyReason(access,writes.capabilityRequired,host?.ownerActAccess);
 text('package-title',subject.title);text('revision','Parts package, before rigging');text('source-hash',`source ${subject.sourceHash.slice(0,12)}`);document.title=subject.title;
 bindWorkspace();bindInspector(true);
 const base=host?'/api/stage-parts':'/api/parts';
 const request=async(path:string,init?:RequestInit)=>{
  const response=await fetch(access.route(path),{...init,headers:access.headers(init?.headers)});
  if(!response.ok){const body=await response.json();throw new Error(typeof body.error==='string'?body.error:body.error?.code??'PARTS_PAINT_FAILED');}return response;
 };
 const showCommentCount=()=>setSourceText(rigInspector.comments.button,`Comments (${issues.length+(generalRows?.length??0)})`);
 const changed=()=>{if(/^The source changed, so /.test(draftStatus??''))draftStatus=null;dirty=true;text('dirty','Unsubmitted changes');el('dirty').classList.add('dirty');parts?.refreshImages();rigInspector.actBar.setSaveState({kind:'unsaved',text:'Unsubmitted changes'});renderDraftState();showCommentCount();return persistence?.save();};
 // A parts verdict is saved only over a drawn subject: until the first paint, or after a failed one, Save stays off.
 const saveBlocked=()=>!!readOnly||!!subject.legacyVerdict?.readOnly||rigInput.state!=='loaded'||draftConflict||!!persistence?.restoring();
 text('rig-empty','Loading package…');
 if(generalRows||host?.record)restoreRecordComments();
 partsSubject=bindPartsSubject({data:subject,canvas:partsCanvas,referenceCanvas:partsReference,viewport,el,toolbar:primaryToolbar,commentsHost:el('comments-list-host'),openComments:openReview,hasPicture:()=>!activeInterviewImages,issues,
  ...(host?.record?{recordComments}:notes?{generalComments:notes,submitting:()=>saving}:{}),
  request,base,paintingPath:host?'/review-painting':'/api/parts/painting',mesh:()=>layers.mesh,restoreMesh:on=>{layers.mesh=on;input('layer-mesh').checked=on;},images:()=>layers.images,
  changed:()=>{if(host?.record){recordCommentsChanged();return;}if(generalRows)persistRecordComments();return changed();},
  selectionChanged:()=>{parts?.refreshImages();renderAnswerControls();},locked:id=>submittedIssues.has(id)||[...issues,...generalRows??[],...host?.record?recordComments:[]].some(row=>row.id===id&&isSentAlone(row)),refusal:()=>readOnly,drawn:state=>{rigInput=state;button('save').disabled=saveBlocked();renderAnswerControls();if(state.state==='failed')text('rig-empty',state.reason);text('renderer-state',state.state==='loaded'?'Parts raster drawn · Canvas2D':'Rendering failed');text('player-state',state.state==='loaded'?'Parts images · no compiled rig loaded':'Rig load failed');renderLayout();},message});
 parts=new PartExplorer(el('workspace-left'),el('selected-part'),()=>{});
 const thumbnails=new PartThumbnails();viewDisposers.push(()=>thumbnails.dispose());
 parts.registerImages({thumbnail:(icon,item,glyph)=>thumbnails.showOriginal(icon,item,()=>partsSubject!.image(item.index),glyph),items:subject.items,selected:partsSubject.selected,solo:partsSubject.solo,visible:partsSubject.visible,select:partsSubject.select,isolate:partsSubject.isolate,show:partsSubject.show});
 const unavailable='PARTS_RIG_UNAVAILABLE: this parts subject has no compiled rig.';
 for(const node of el('proposal-panel').children)if(node.id!=='comments-list-host')(node as HTMLElement).hidden=true;
 for(const control of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('#proposal-panel input,#proposal-panel select,#proposal-panel button,#strip-panel input,#strip-panel select,#strip-panel button'))if(!control.closest('#comments-list-host')){control.disabled=true;setSourceAttribute(control,'title',unavailable);}
 el('checkpoint-detail').hidden=true;
 el('strip-panel').hidden=true;
 const renderPartsProvenance=()=>{text('provenance-version','Parts package, before rigging');el('provenance-rig').textContent=t('Not supplied');el('provenance-motion').hidden=true;el('provenance-motion-missing').hidden=false;text('provenance-motion','');};
 renderPartsProvenance();viewDisposers.push(onLanguageChange(renderPartsProvenance));
 text('provenance-full',JSON.stringify({subject:'parts',sourceHash:subject.sourceHash,painting:subject.painting,images:subject.items.map(({name,imageHash})=>({name,imageHash}))},null,2));
 text('source-files',`source ${subject.sourceHash}`);const provenanceHint=document.querySelector<HTMLElement>('.provenance>.hint');if(provenanceHint)setSourceText(provenanceHint,'Source files remain unchanged.');
 for(const tab of document.querySelectorAll<HTMLButtonElement>('[data-block-target]'))if(!['selected-part','feedback'].includes(tab.dataset.blockTarget??'')){tab.disabled=true;setSourceAttribute(tab,'title',unavailable);}
 for(const tool of document.querySelectorAll<HTMLButtonElement>('[data-workspace-view-tools] button')){tool.hidden=false;tool.disabled=true;setSourceAttribute(tool,'title',unavailable);}
 input('layer-images').disabled=false;input('layer-mesh').disabled=!subject.items.some(item=>item.mesh);input('layer-bones').disabled=true;
 describeLayerToggles(document,unavailable);
 for(const [id,key]of [['layer-images','images'],['layer-mesh','mesh']]as const)input(id).onchange=()=>{layers[key]=input(id).checked;partsSubject?.redraw();};
 const overlay=panelMake('input',{id:'parts-overlay',type:'checkbox',disabled:!subject.painting}),opacity=panelMake('input',{id:'parts-opacity',type:'range',min:'0',max:'1',step:'0.001',value:'0.5',disabled:!subject.painting});
 const overlayLabel=panelMake('label',{},overlay,tr('Overlay')),opacityLabel=panelMake('label',{},tr('Part opacity'),opacity);
 if(!subject.painting)for(const node of [overlayLabel,opacityLabel])setSourceAttribute(node,'title','PARTS_REFERENCE_UNAVAILABLE: supply --painting to compare the original painting');
 secondaryToolbar.append(overlayLabel,opacityLabel);
 const previousDraft=subject.previousDraft;
 if(previousDraft){
  const paintingOption=option('painting',''),previousOption=option('previous-draft','');
  paintingOption.disabled=!partsSubject.paintingDifferenceAvailable();
  previousOption.title=`${previousDraft.id} · ${previousDraft.revision}`;
  const operand=panelMake('select',{id:'parts-difference-operand',translate:false},paintingOption,previousOption);
  const label=panelMake('label',{id:'parts-difference-operand-label',hidden:true},tr('Compare with'),operand);
  const localizeOptions=()=>{
   paintingOption.textContent=t('Original painting');
   previousOption.textContent=t('Previous accepted draft · {0}',[previousDraft.id]);
  };
  localizeOptions();viewDisposers.push(onLanguageChange(localizeOptions));
  operand.onchange=()=>{
   const bound=partsSubject;
   if(!bound||label.hidden)return;
   void bound.setComparison('difference',operand.value==='previous-draft'?'previous-draft':'painting')
    .then(drawn=>{if(!drawn&&partsSubject===bound)renderLayout();});
  };
  secondaryToolbar.append(label);
 }
 overlay.onchange=()=>{partsSubject?.setComparison(overlay.checked?'overlay':'part');if(overlay.checked){view='rig';renderLayout();}};
 opacity.oninput=()=>partsSubject?.opacity(Number(opacity.value));
 controls.setDisabled('difference',partsSubject.differenceAvailable()?null:tr('PARTS_DIFFERENCE_UNAVAILABLE: missing painting_in_rig declaration or painting_in_rig.json sidecar and its bound operand.'));
 const reference=select('reference-select');reference.replaceChildren(option('',subject.painting?'Original painting':'No references supplied'));reference.disabled=true;
 el('package-context').removeAttribute('open');el('reference-empty').hidden=!!subject.painting;el('rig-overlay').hidden=true;
 const state=rigInspector.actBar;state.setSaveState({kind:actReadOnly?'read-only':'unsaved',text:actReadOnly??'Not submitted'});
 select('review-status').hidden=true;document.querySelector<HTMLLabelElement>('label[for="review-status"]')!.hidden=true;
 button('save').disabled=saveBlocked();
 button('save').onclick=async()=>{
  if(saving||saveBlocked())return;
  if(partsSubject?.hasPendingComment()){if(!await partsSubject.commitDraft())return;}
  if(saving||saveBlocked())return;
  saving=true;text('review-message','');el('review-message').classList?.toggle('error',false);button('save').disabled=true;state.setSaveState({kind:'saving',text:'Saving…'});renderDraftState();
  const unsentIssues=issues.filter(fresh),verdictRows=generalRows?.filter(fresh);
  const all=structuredClone(issues),frozen=structuredClone(unsentIssues),general=verdictRows?.map(row=>row.summary);
  let submissionFailure:ReturnType<typeof jobSubmissionRefusal>|null=null,saveFailed=false;
  try{
   if(host?.submitParts)message(await host.submitParts(frozen,general));
   else await request(base+'/verdict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:frozen.length?'changes-requested':'approved',issues:frozen})});
   if(generalRows&&verdictRows?.length){const sentIds=new Set(verdictRows.map(row=>row.id));generalRows.splice(0,generalRows.length,...generalRows.filter(row=>!sentIds.has(row.id)));persistRecordComments();}
   if(disposed)return;
   if(host)for(const issue of frozen)submittedIssues.add(issue.id);
   if(general?.length){partsSubject?.refreshComments();showCommentCount();}
   dirty=JSON.stringify(issues)!==JSON.stringify(all);partsBaseline={subject:'parts',issues:all};await persistence?.submitted(partsBaseline);if(disposed)return;state.setSaveState({kind:dirty?'unsaved':'saved',text:dirty?'Unsubmitted changes':'Submitted'});text('dirty',dirty?'Unsubmitted changes':'Submitted');el('dirty').classList.toggle('dirty',dirty);
  }catch(error){saveFailed=true;if(host){submissionFailure=jobSubmissionRefusal(error);message(submissionFailure.text,true);}else{message(errorText(error),true);state.setSaveState({kind:'failed',text:'Save failed.'});}}
  finally{saving=false;button('save').disabled=saveBlocked();renderDraftState();if(submissionFailure){state.setSaveState({kind:'failed',text:submissionFailure.text,title:submissionFailure.title});}else if(saveFailed)state.setSaveState({kind:'failed',text:'Save failed.'});}
 };
 viewDisposers.push(viewport.bindControls(unitScaleMessage),viewport.bindNavigation(undefined,()=>!el('stage-layout').getAttribute('aria-busy')?.includes('true')),bindLayerShortcuts(document));
 const resize=viewport.observeResize();viewDisposers.push(()=>resize.disconnect());
 if(!host)renderPendingSubjects([]);
 viewport.requestFit();await partsSubject.ready();text('dirty','Not submitted');message(actReadOnly??(host?.ownerActAccess?'Not submitted':'Parts ready. Source files remain unchanged.'),false,!!host?.ownerActAccess&&!actReadOnly);referenceInput=subject.painting?{state:'loaded'}:{state:'absent'};renderLayout();
 setupPartsPersistence=async()=>{
  if(host?.record)return;
  const binding:InspectionBinding={mode:'single',sourceHash:subject.sourceHash,rigs:[null]};
  const legacyPartsScope='parts:'+access.key+':'+access.base+':'+subject.sourceHash;
  const partsDraftScope=host?.verdictComments?.jobId&&host?.verdictComments?.draftId?host.verdictComments.jobId+':'+host.verdictComments.draftId:access.key+':'+access.base;
  const partsScope='parts:'+partsDraftScope+':'+subject.sourceHash;
  const connection=await connectInspectionPersistence({scope:partsScope,legacyScopes:partsScope!==legacyPartsScope?[legacyPartsScope]:[],binding,baseline:partsBaseline,session:()=>({subject:'parts' as const,issues}),reviewDirty:()=>dirty,
   recover:value=>{try{if(!value||typeof value!=='object')return null;const row=value as PartsSubjectSession;if(row.subject!=='parts'||!Array.isArray(row.issues)||row.issues.length>1000||Object.keys(row).some(key=>!['subject','issues'].includes(key)))return null;const items=new Map(subject.items.map(item=>[item.name,{...item,imageHash:item.imageHash!}]));const restored=row.issues.map(issue=>{const parsed=parsePartsIssue(issue,false,true,false);assertPartsIssueBinding(parsed,items,subject.sourceHash);return parsed;});if(new Set(restored.map(issue=>issue.id)).size!==restored.length)return null;return {subject:'parts' as const,issues:restored};}catch{return null;}},
   restoreSession:(value,isDirty)=>{issues.splice(0,issues.length,...value.issues);dirty=isDirty;partsSubject?.refreshComments();showCommentCount();text('dirty',isDirty?'Unsubmitted changes':'Submitted');el('dirty').classList.toggle('dirty',isDirty);state.setSaveState({kind:isDirty?'unsaved':'saved',text:isDirty?'Unsubmitted changes':'Submitted'});},
   bookmark:()=>({schema:'rig-review-inspection/1',binding,animation:null,time:null,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:null}},selection:{}}),
   // Parts comments carry their own explicit view restore. Opening never replays a selection or camera.
   restoreBookmark:async()=>{},
   ui:()=>({}),restoreUI:()=>{},afterInputs:()=>{if(!dirty||issues.length===0){const current=partsSubject!.comparison();overlay.checked=current.mode==='overlay';opacity.value=String(current.opacity);return;}partsSubject!.setComparison(overlay.checked?'overlay':'part');partsSubject!.opacity(Number(opacity.value));},onConflict:value=>{draftConflict=value;button('save').disabled=saveBlocked();renderAnswerControls();},onStatus:value=>{draftStatus=value;renderDraftState();}});
  if(disposed){connection.dispose();return;}persistence=connection;
 };
 await setupPartsPersistence();if(disposed)return;
 if(localCommentSource){restoreLocalSentRows(issues,'schema');partsSubject.refreshComments();showCommentCount();}
 if(generalRows?.length)changed();
 renderPendingSubjects(host?.pendingSubjects?.()??[]);
 if(host){await restorePublicationNavigation();hostAttached=true;host.attach({recordForms:renderRecordForms,stage:()=>null,redraw:()=>partsSubject?.redraw(),message:(value,error,diagnostic)=>message(value,error,false,diagnostic),syncActRow:syncJobActRow,pendingSubjects:renderPendingSubjects,progress:setJobProgress,...host.record?{}:{incompatible:()=>navigationMissing,navigation:()=>({subject:'parts' as const,part:partsSubject!.selected(),solo:partsSubject!.solo(),view,camera:numericView()})},suspend:suspendScreen,resume:resumeScreen,dispose:disposeScreen});host.displayed();}

 if(ownerStage)bindOwnerStage(subject.sourceHash);
 document.body.dataset.ready='true';
}
/** Use the existing Comments-only presentation for subjects without rig capabilities. */
function showRecordComments(preserveInspector=false):void {
 for(const child of el('proposal-panel').children)if(child.id!=='comments-list-host')(child as HTMLElement).hidden=true;
 if(preserveInspector){
  const angleTool=el('motion-tools').querySelector<HTMLButtonElement>('[data-proposal="angle"]')!;
  angleTool.disabled=input('axis-value').disabled;
  if(angleTool.disabled){
   const reason=sourceTextContent(el('axis-state'));
   setSourceAttribute(angleTool,'title',reason);setSourceAttribute(angleTool,'aria-description',reason);
  }
  return;
 }
 for(const child of rigInspector.comments.panel.children)(child as HTMLElement).hidden=child!==el('proposal-panel')&&child!==el('comments-list-host')&&!child.classList.contains('review-dialog-header');
 rigInspector.comments.panel.style.display='block';
 rigInspector.collapse.disabled=false;setSourceAttribute(rigInspector.collapse,'title','');
}
/** Publications without a picture reuse the empty main view; no model is manufactured. */
async function startRecord(interview?:InterviewSubjectEntry):Promise<void> {
 if(!host?.record&&!interview)throw new Error('JOB_DISPLAY_MISMATCH');
 const missingPicture=host?.record?.missingPicture;
 const unavailable=interview?'MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.':
  missingPicture==='rig'?'This question refers to a rig version that this publication does not include.':
  missingPicture==='scene'?'This question refers to a scene that this publication does not include.':
  'This request has no picture.';
 readOnly=tr(interview?'MODEL_UNAVAILABLE':'JOB_REVIEW_READ_ONLY');
 if(!interview)actReadOnly=readOnlyReason(access,true,host?.ownerActAccess);
 // Image and pair mounts temporarily replace this baseline and release it before viewDisposers run.
 for(const control of controls.zoomButtons.concat(controls.nativeOne!))control.disabled=true;
 viewDisposers.push(controls.replaceViewSwitch({...inspectionViewSwitch(chooseInspectionView,true),disabled:true}));
 bindWorkspace();bindInspector(true);rigInput={state:'absent'};referenceInput={state:'absent'};renderLayout();
 parts=new PartExplorer(el('workspace-left'),el('selected-part'),()=>{},()=>{});text('checkpoints','No checkpoints supplied.');text('dirty','Not submitted');if(interview)message(unavailable);else message(actReadOnly??(host?.record?.questionPicture||host?.record?.planPicture?'':unavailable));
 text('package-title',interview?.label??host!.record!.label);text('revision','');text('source-hash',`source ${(interview?.sourceHash??host!.record!.sourceHash).slice(0,12)}`);
 el('rig-pane').hidden=false;el('rig-empty').hidden=false;text('rig-empty',unavailable);
 for(const region of document.querySelectorAll('.inspector,.workspace-secondary-toolbar'))for(const control of region.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|HTMLButtonElement>('input,select,textarea,button')){
  if(control===rigInspector.collapse||(!interview&&control===rigInspector.comments.button))continue;
  control.disabled=true;control.removeAttribute('title');
  const toggleLabel=control.closest('label.layer-toggle');if(toggleLabel)toggleLabel.removeAttribute('title');
  if(!control.hasAttribute('aria-label')&&!control.hasAttribute('aria-labelledby')&&control.getAttribute('aria-hidden')!=='true'){
   const wrappingLabel=control.closest('label'),explicitLabel=control.id?document.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`):null;
   const labelNode=control instanceof HTMLButtonElement?(control.childElementCount?control.childNodes[0]??null:control):wrappingLabel?(wrappingLabel.querySelector('span')??[...wrappingLabel.childNodes].find(node=>node.nodeType===3&&node.nodeValue?.trim())??null):explicitLabel;
   const labelText=sourceTextContent(labelNode).trim();
   if(labelText)setSourceAttribute(control,'aria-label',labelText);
  }
  setSourceAttribute(control,'aria-description',unavailable);
 }
 if(interview){
  const interviewRefusal='INTERVIEW_PICKS_DISABLED: the interview answer form has been removed; discuss options through live job comments.';
  button('stage-comment').hidden=true;
  button('save').disabled=true;setSourceAttribute(button('save'),'aria-description',interviewRefusal);
  text('provenance-rig',unavailable);text('provenance-motion',unavailable);text('source-files','project.json');
  text('rig-empty',interviewRefusal);message(interviewRefusal);message(interviewRefusal,true,false,'INTERVIEW_PICKS_DISABLED');
 }else{restoreRecordComments();setupComments();showRecordComments();rigInspector.comments.button.disabled=false;button('stage-comment').disabled=false;}
 const resize=viewport.observeResize();viewDisposers.push(()=>resize.disconnect());
 await workspace?.settle();if(disposed)return;
 if(host?.unavailable){message(t('job.refusal.'+host.unavailable),true,false,host.unavailable);button('save').disabled=true;button('save').title=host.unavailable;}
 document.body.dataset.ready='true';
 if(!interview){host!.attach({recordForms:renderRecordForms,pendingSubjects:renderPendingSubjects,progress:setJobProgress,stage:()=>null,redraw:()=>{},message:(value,error,diagnostic)=>message(value,error,false,diagnostic),syncActRow:syncJobActRow,suspend:suspendScreen,resume:resumeScreen,dispose:disposeScreen});host!.displayed();}
}
/** #1041 B: checkpoint, signoff and plan-approval forms are retired (#1227, #1229, #1230); record comments stay in Comments. */
let hostAttached=false;
let activeInterviewImages:readonly {name:string;src:string;path?:string;sha256?:string}[]|null=null;
let activeInterviewImage:{name:string;src:string;path?:string;sha256?:string}|null=null;
let releaseInterview:(()=>void)|null=null;

/** Publication and source bind native comment drafts independently of inspection navigation. */
function restoreRecordComments(form?:HTMLFormElement):void {
 const local=typeof localCommentSource!=='undefined'?localCommentSource:null;
 const notes=host?.verdictComments??(local?localCommentNotes:null);
 const binding=host?.direction??host?.verdictComments??host?.record??local;
 if(!binding||recordCommentKey)return;
 const route=typeof access!=='undefined'?/^\/jobs\/([^/]+)\/publications\/([^/]+)\//.exec(access?.base??''):null;
 const publicationId=binding.publicationId??form?.dataset.jobPublication??route?.[2],sourceHash=binding.sourceHash;
 const jobId=binding.jobId??route?.[1],draftId=binding.draftId;
 if(!publicationId&&(!jobId||!draftId))throw new Error('JOB_DISPLAY_MISMATCH');
 const prefix=notes?'rig-review-verdict-comments/1:':'rig-review-record-comments/1:';
 const scopePrefix=jobId&&draftId?`${prefix}${jobId}:${draftId}:`:null;
 recordCommentKey=(scopePrefix??`${prefix}${publicationId}:`)+sourceHash;
 const fallbackKey=publicationId?`${prefix}${publicationId}:${sourceHash}`:'';
 const previousKey=binding.previousPublicationId?`${prefix}${binding.previousPublicationId}:${sourceHash}`:'';
 const target=(notes?.rows??recordComments) as CommentRow[]&{knownIds?:Set<string>;storageBound?:boolean};
 const knownIds=(target.knownIds??=new Set<string>());
 const parseRows=(raw:string|null,expectedPub?:string):CommentRow[]|null=>{
  const saved=JSON.parse(raw??'null');
  if(!saved||saved.sourceHash!==sourceHash||!Array.isArray(saved.comments)||saved.comments.length>1000)return null;
  if(expectedPub!==undefined?saved.publicationId!==expectedPub:(typeof saved.publicationId!=='string'||!saved.publicationId))return null;
  const ids=new Set<string>(),rows=saved.comments as CommentRow[];
  for(const row of rows){
   if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.summary!=='string'||!row.summary.trim()||row.summary.length>1000)throw new Error('JOB_ACT_INVALID');
   ids.add(row.id);
   if(notes&&('schema' in row||'target' in row))throw new Error('JOB_ACT_INVALID');
   if('schema' in row){const issue=parsePartsIssue(row,false,true,false),items=new Map((partsSubject?.items()??[]).map(item=>[item.name,{...item,imageHash:item.imageHash!}]));assertPartsIssueBinding(issue,items,partsSubject!.sourceHash());}
   else if('target' in row){const mark=parseStageComment((row.context as {comment?:unknown})?.comment),pictures=!host?.direction?recordPictures():undefined;
    const pairs=host?.checkpointPairs,reference=(mark.bookmark as InspectionBookmark).selection.reference;
    // A record-source reference pin stays on the sealed-picture path over a retained backdrop.
    if(pictures&&(!host!.record!.hasPicture||mark.viewport==='reference'&&
     !manifestReferenceMatches(mark,reference)&&
     (pairs&&mark.sourceHash===sourceHash||pictures.some(picture=>picture.path===mark.referenceId)))){
     // #1048: a plan- or question-picture pin restores only through its A1 label, parsed back against a sealed entry.
     if(mark.viewport!=='reference'||mark.sourceHash!==sourceHash)throw new Error('JOB_DISPLAY_MISMATCH');
     validateSealedPictureMark(row as Feedback,mark,pictures,pairs?'COMMENT_REFERENCE_MISMATCH':undefined);
    }else if((!host?.direction&&!host!.record!.hasPicture)||mark.sourceHash!==data.sourceHash)throw new Error('JOB_DISPLAY_MISMATCH');}
   else if(Object.keys(row).some(key=>key!=='id'&&key!=='summary'))throw new Error('JOB_ACT_INVALID');
  }
  if(!notes)projectRecordComments(rows);
  return rows;
 };
 if(!target.storageBound&&typeof window!=='undefined'&&typeof window.addEventListener==='function'){
  target.storageBound=true;
  const onStorage=(event:Pick<StorageEvent,'key'|'newValue'>)=>{
   if(!recordCommentKey||event.key!==recordCommentKey)return;
   try{
    const currentRaw=typeof localStorage.getItem==='function'?localStorage.getItem(recordCommentKey):event.newValue;
    const incoming=currentRaw===null?[]:parseRows(currentRaw,scopePrefix?undefined:publicationId);
    if(!incoming)return;
    const incomingIds=new Set(incoming.map(row=>row.id));
    const localUnsaved=target.filter(row=>!knownIds.has(row.id)&&!incomingIds.has(row.id));
    target.splice(0,target.length,...incoming,...localUnsaved);
    knownIds.clear();for(const row of incoming)knownIds.add(row.id);
    if(typeof rigInspector!=='undefined'&&typeof setSourceText==='function'){
     const count=notes?(typeof partsOnly!=='undefined'&&partsOnly?(partsSubject?.issues().length??0)+target.length:target.length):recordComments.length;
     setSourceText(rigInspector.comments.button,`Comments (${count})`);
    }
    if(typeof comments!=='undefined')comments?.refresh();
    if(typeof partsSubject!=='undefined')partsSubject?.refreshComments();
    if(typeof renderProposals==='function'&&notes&&!(typeof partsOnly!=='undefined'&&partsOnly))renderProposals();
    if(typeof renderAnswerControls==='function')renderAnswerControls();
   }catch{/* Ignore malformed cross-tab storage payloads. */}
  };
  window.addEventListener('storage',onStorage,typeof lifecycle!=='undefined'?{signal:lifecycle.signal}:undefined);
 }
 try {
  const primaryRaw=localStorage.getItem(recordCommentKey);
  const fallbackRaw=primaryRaw===null&&fallbackKey&&fallbackKey!==recordCommentKey?localStorage.getItem(fallbackKey):null;
  const previousRaw=primaryRaw===null&&fallbackRaw===null&&previousKey&&previousKey!==recordCommentKey?localStorage.getItem(previousKey):null;
  const rows=primaryRaw!==null?parseRows(primaryRaw,scopePrefix?undefined:publicationId):
   fallbackRaw!==null?parseRows(fallbackRaw,publicationId):
   previousRaw!==null?parseRows(previousRaw,binding.previousPublicationId??undefined):null;
  if(rows){
   for(const row of rows){knownIds.add(row.id);if(!target.some(existing=>existing.id===row.id))target.push(row);}
   if(primaryRaw===null&&typeof localStorage.removeItem==='function'){
    persistRecordComments();
    if(fallbackKey&&fallbackKey!==recordCommentKey)localStorage.removeItem(fallbackKey);
    if(previousKey&&previousKey!==recordCommentKey)localStorage.removeItem(previousKey);
   }
   return;
  }
  if((scopePrefix||binding.previousPublicationId)&&typeof localStorage.length==='number'&&typeof localStorage.key==='function'){
   const partsScopePrefix=jobId&&draftId?`rig-review-draft/1:parts:${jobId}:${draftId}:`:null;
   let unsentCount=0;
   for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);
    if(!key||key===recordCommentKey)continue;
    if((scopePrefix&&key.startsWith(scopePrefix))||(binding.previousPublicationId&&key.startsWith(`${prefix}${binding.previousPublicationId}:`))){
     const prior=JSON.parse(localStorage.getItem(key)??'null');
     if(prior&&typeof prior.sourceHash==='string'&&prior.sourceHash!==sourceHash&&Array.isArray(prior.comments)&&prior.comments.length>0){
      unsentCount+=prior.comments.length;
     }
    }else if(partsScopePrefix&&key.startsWith(partsScopePrefix)&&!key.endsWith(':'+sourceHash)){
     const prior=JSON.parse(localStorage.getItem(key)??'null');
     if(prior&&typeof prior.sourceHash==='string'&&prior.sourceHash!==sourceHash&&prior.reviewDirty&&Array.isArray(prior.session?.issues)&&prior.session.issues.length>0){
      unsentCount+=prior.session.issues.length;
     }
    }
   }
   if(unsentCount>0){
    const notice=`The source changed, so ${unsentCount} unsent comment(s) could not be carried over. Please add them again.`;
    if(typeof draftStatus!=='undefined')draftStatus=notice;
    if(typeof renderDraftState==='function')renderDraftState();
   }
  }
 }catch(error){
  /* A mismatched or invalid local draft has no authority. A plan-picture pin that cannot be parsed back says so by name (#1048). */
  const reason=error instanceof Error?error.message:'';
  if(/^(COMMENT_PICTURE_LABEL_INVALID|COMMENT_REFERENCE_MISMATCH)/.test(reason)&&typeof message==='function')message(reason,true);
 }
}
function validateSealedPictureMark(row:Feedback,mark:StageComment,pictures:readonly {path:string;sha256:string}[],mismatch?:string):void {
 const exact=pictures.find(picture=>picture.path===mark.referenceId&&picture.sha256===mark.referenceHash);
 if(mismatch&&(!exact||mark.viewport!=='reference'||(mark.bookmark as InspectionBookmark).selection.reference!==mark.referenceId))
  throw new Error(mismatch);
 const label=projectComments(feedbackItemComments([row]),exact?[exact]:pictures).split('\n')[0]!.slice(1,-1),parsed=parsePictureCommentLabel(label);
 if(!pictures.some(picture=>parsed.referenceId===picture.path&&parsed.referenceHash===picture.sha256))
  throw new Error(mismatch??'COMMENT_PICTURE_LABEL_INVALID: the pin does not name a sealed picture of this record');
}
function manifestReferenceMatches(mark:StageComment,reference:string|null|undefined):boolean {
 const id=mark.referenceId;
 if(!id||reference!==id||!data?.manifest.references.some(item=>item.id===id))return false;
 const hash=data.explicitReference?.id===id?data.explicitReference.sha256:data.referenceHashes?.[id];
 return !!hash&&hash===mark.referenceHash;
}
/** The record draft keeps the sealed picture identities for the life of the publication. */
function recordPictures():{path:string;sha256:string}[]|undefined {
 const picture=host?.record?.planPicture,rows=[...picture?[{path:picture.path,sha256:picture.sha256}]:[],...host?.record?.questionPictures??[]];
 for(const pair of host?.checkpointPairs?.values()??[])for(const {path,sha256}of [pair.before,pair.after])rows.push({path,sha256});
 return rows.length?rows:undefined;
}
function recordJobComments(rows:readonly CommentRow[]=recordComments) {
 return rows.map(row=>'schema' in row?partsIssueComments([row as import('../src/parts-comment.ts').PartsIssue])[0]!:'target' in row?feedbackItemComments([row as Feedback])[0]!:{text:row.summary});
}
function projectRecordComments(rows:readonly CommentRow[]):string {
 const entries=recordJobComments(rows);
 const pictures=recordPictures();
 if(!pictures||(!host?.record?.hasPicture&&!host?.checkpointPairs))return projectComments(entries,pictures);
 return projectCommentLabels(entries,mark=>{
  if(manifestReferenceMatches(mark,(mark.bookmark as InspectionBookmark).selection.reference))return undefined;
  return pictures.find(picture=>picture.path===mark.referenceId&&picture.sha256===mark.referenceHash)??
   pictures.find(picture=>picture.path===mark.referenceId);
 });
}
/** Comments remain native rows in the draft and feed both act encodings. */
function recordCommentWords():string {
 // #1242: a row already sent on its own is not sent again inside a record answer (CONTRACT §1).
 return projectRecordComments(carryRecordRows(recordComments.filter(row=>!isSentAlone(row))));
}
function checkpointPairTile(path:string|null,sha256:string|null):CheckpointPairTile|undefined {
 for(const pair of host?.checkpointPairs?.values()??[]){
  const side=(['after','before'] as const).find(side=>pair[side].path===path&&pair[side].sha256===sha256);
  if(side)return {pair,side};
 }
}
/** The sealed plan picture or question image while it is the reference view's shown image, with or without a retained
 * backdrop (#1068); null otherwise (#1048). */
function shownPlanPicture():{name:string;path:string;sha256:string}|null {
 if(host?.checkpointPairs&&checkpointPair){
  const before=checkpointPair.mode==='before'||checkpointPair.mode==='compare';
  return {...(before?checkpointPair.pair.before:checkpointPair.pair.after),name:before?'Before':'After'};
 }
 const image=host?.record?activeInterviewImage:null,path=image?.path,sha256=image?.sha256;
 return image&&path&&sha256&&recordPictures()?.some(picture=>picture.path===path&&picture.sha256===sha256)?{name:image.name,path,sha256}:null;
}
function persistRecordComments():void {
 const local=typeof localCommentSource!=='undefined'?localCommentSource:null;
 const notes=host?.verdictComments??(local?localCommentNotes:null);
 const binding=host?.direction??host?.verdictComments??host?.record??local;
 if(!binding||!recordCommentKey)return;
 const comments=(notes?.rows??recordComments) as CommentRow[]&{knownIds?:Set<string>};
 const knownIds=(comments.knownIds??=new Set<string>());
 try{
  const raw=typeof localStorage.getItem==='function'?localStorage.getItem(recordCommentKey):null;
  if(raw!==null){
   const existing=JSON.parse(raw);
   const storedRows:CommentRow[]=existing?.sourceHash===binding.sourceHash&&Array.isArray(existing.comments)
    ?existing.comments.filter((row:CommentRow)=>row&&typeof row.id==='string'&&row.id&&typeof row.summary==='string'&&row.summary.trim()&&row.summary.length<=1000):[];
   const storedIds=new Set(storedRows.map(row=>row.id));
   const survivingLocal=comments.filter(row=>!knownIds.has(row.id)||storedIds.has(row.id));
   const survivingIds=new Set(survivingLocal.map(row=>row.id));
   const addedFromOther=storedRows.filter(row=>!knownIds.has(row.id)&&!survivingIds.has(row.id));
   const kept=survivingLocal.filter(row=>knownIds.has(row.id));
   const localNew=survivingLocal.filter(row=>!knownIds.has(row.id));
   comments.splice(0,comments.length,...kept,...addedFromOther,...localNew);
  }
  knownIds.clear();for(const row of comments)knownIds.add(row.id);
  const activePub=binding.publicationId;
  const prefix=notes?'rig-review-verdict-comments/1:':'rig-review-record-comments/1:';
  if(typeof localStorage.removeItem==='function'){
   if(activePub&&`${prefix}${activePub}:${binding.sourceHash}`!==recordCommentKey)localStorage.removeItem(`${prefix}${activePub}:${binding.sourceHash}`);
   if(binding.previousPublicationId&&`${prefix}${binding.previousPublicationId}:${binding.sourceHash}`!==recordCommentKey)localStorage.removeItem(`${prefix}${binding.previousPublicationId}:${binding.sourceHash}`);
  }
  if(notes&&!comments.length)localStorage.removeItem(recordCommentKey);
  else localStorage.setItem(recordCommentKey,JSON.stringify({status:select('review-status').value,publicationId:activePub,sourceHash:binding.sourceHash,comments}));
 }catch{/* In-memory comments remain bound to this host. */}
}
function recordCommentsChanged():void {
 if(!host?.record&&!host?.direction)return;
 if(/^The source changed, so /.test(draftStatus??''))draftStatus=null;
 persistRecordComments();
 setSourceText(rigInspector.comments.button,`Comments (${recordComments.length})`);
 renderDraftState();
}
/** Comments remain native rows (#992); checkpoint pairs take the reference viewport (#1229). */
function checkpointDifferenceReason({before,after}:CheckpointPairView):string|null {
 return before.image.naturalWidth!==after.image.naturalWidth||before.image.naturalHeight!==after.image.naturalHeight
  ?tr(nativeDifferenceAlignment):null;
}

async function showCheckpointPair(mode:CheckpointPairMode):Promise<void> {
 const state=checkpointPair;if(!state)return;
 if(mode==='difference'&&checkpointDifferenceReason(state.pair)){renderLayout();return;}
 const {pair}=state,generation=++state.generation;
 state.requestedMode=mode;
 let pixels:HTMLCanvasElement|undefined;
 if(mode==='difference'){
  try{
   pixels=await (state.difference??=fetch(pair.differenceUrl,{signal:lifecycle.signal}).then(async response=>{
    if(!response.ok)throw new Error((await response.json()).error.message);
    const image=await loadViewportImage(response),canvas=document.createElement('canvas');
    canvas.id='checkpoint-difference-canvas';canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    canvas.getContext('2d')!.drawImage(image,0,0);return canvas;
   }));
  }catch(error){
   state.difference=null;
   if(checkpointPair===state&&generation===state.generation){
    state.requestedMode=state.mode;message(errorText(error),true);renderLayout();
   }
   return;
  }
 }
 if(checkpointPair!==state||generation!==state.generation)return;
 state.mode=mode;
 const image=mode==='before'||mode==='compare'?pair.before.image:pair.after.image;
 el('reference-content').replaceChildren(pixels??image);
 if(mode==='compare'&&pair.after.image.parentElement!==el('rig-root'))el('rig-root').append(pair.after.image);
 else if(mode!=='compare'&&pair.after.image.parentElement===el('rig-root'))pair.after.image.remove();
 const label=checkpointPairLabels[mode==='compare'?'before':mode];
 text('reference-label',label);setSourceAttribute(el('reference-pane'),'aria-label',label);
 viewport.state.activeCamera='reference';viewport.state.cameraFrames={};viewport.state.cameraLayout='';
 viewport.requestFit();renderLayout();
 // Allocate the new menu and fitted readout in the first mount's task, before paint.
 if(generation===1&&mode!=='difference')workspace?.layoutNow();
 comments?.refresh();
}

async function syncCheckpointPair(keepReplay=true,mode:CheckpointPairMode='after'):Promise<void> {
 const pair=host?.record?host.checkpointPair?.():undefined;
 if(keepReplay&&checkpointPair?.replayFor===(pair??null))return;
 if(pair===checkpointPair?.pair){
  if(checkpointPair?.replayFor!==undefined){checkpointPair.replayFor=undefined;comments?.refresh();}
  return;
 }
 const nextMode=pair&&mode==='difference'&&checkpointDifferenceReason(pair)?'after':mode;
 if(mountCheckpointPair(pair,nextMode))await showCheckpointPair(nextMode);
}

function mountCheckpointPair(pair:CheckpointPairView|undefined,mode:CheckpointPairMode='after'):boolean {
 const hadPair=!!checkpointPair;checkpointPair?.release();
 if(!pair){if(hadPair)syncQuestionImage();return false;}
 releaseInterview?.();releaseInterview=null;
 leavePreviousBuild();leaveRigDifference();pause();++referenceGeneration;
 const bookmark=inspectionBookmark(),camera=structuredClone(viewport.state),content=el('reference-content'),nodes=[...content.childNodes];
 const hidden=[...el('rig-root').children,...el('rig-viewport').children,el('reference-empty')]
  .filter((node):node is HTMLElement=>node instanceof HTMLElement&&node!==el('rig-root')&&!node.classList.contains('stage-comment-layer'))
  .map(node=>({node,value:node.hidden}));
 const labels=['reference-label','rig-label'].map(id=>({id,value:sourceTextContent(el(id))}));
 const paneLabels=['reference-pane','rig-pane'].map(id=>({id,value:sourceAttribute(el(id),'aria-label')??''}));
 for(const {node}of hidden)node.hidden=true;
 for(const {image}of [pair.before,pair.after]){image.draggable=false;image.width=image.naturalWidth;image.height=image.naturalHeight;}
 const disabled=new Map(controls.zoomButtons.concat(controls.nativeOne!).map(button=>[button,button.disabled]));
 for(const button of disabled.keys())button.disabled=false;
 const bindings=button('zoom-in').onclick?[]:[viewport.bindControls(unitScaleMessage),viewport.bindNavigation()];
 const modes=Object.entries(checkpointPairLabels).map(([id,labelKey])=>({id,labelKey,pressed:id===mode}));
 const recordPairs=host?.selectCheckpointPair?host.checkpointPairs:undefined;
 const groups:ViewSwitchGroup[]=[{modes}];
 if(recordPairs&&recordPairs.size>1)groups.push({keepSummary:true,modes:[...recordPairs.values()].map((candidate,index)=>({
  id:checkpointPairPrefix+candidate.checkpointId,labelKey:t('Pair {0}',[index+1],'en'),
  labelSuffix:candidate.checkpointId,pressed:candidate===pair,
 }))});
 const restoreSwitch=controls.replaceViewSwitch({currentMode:mode,groups,reserveSummaryWidth:true,onChange:chooseInspectionView});
 checkpointPair={pair,mode,requestedMode:mode,bookmark,difference:null,generation:0,release:()=>{
  checkpointPair=null;pair.after.image.remove();content.replaceChildren(...nodes);restoreSwitch();
  for(const {node,value}of hidden)node.hidden=value;
  for(const {id,value}of labels)text(id,value);
  for(const {id,value}of paneLabels)setSourceAttribute(el(id),'aria-label',value);
  select('reference-select').value=bookmark.selection.reference??'';
  for(const dispose of bindings)dispose();for(const [button,value]of disabled)button.disabled=value;
  viewport.cancelFit();Object.assign(viewport.state,camera);if(!disposed){renderLayout();comments?.refresh();}
 }};
 viewport.state.cameraSync=false;text('rig-label','After');setSourceAttribute(el('rig-pane'),'aria-label','After');
 if(mode==='difference'){
  content.replaceChildren();text('reference-label','Difference');setSourceAttribute(el('reference-pane'),'aria-label','Difference');
  renderLayout();workspace?.layoutNow();
 }
 if(sourceTextContent(el('message'))==='This request has no picture.')message(sourceTextContent(el('dirty')),false,true);
 return true;
}

/** Keep the shared reference viewport bound while a record picture or option image is active. */
function syncQuestionImage():void {
 if(disposed){releaseInterview?.();releaseInterview=null;return;}
 if(host?.record?.hasPicture&&!hostAttached)return;
 const recordImages=host?.record?.planPicture?[host.record.planPicture]:host?.record?.questionPictures?.flatMap(picture=>picture.src?[{name:picture.name,src:picture.src,path:picture.path,sha256:picture.sha256}]:[]);
 const images=recordImages?.length?recordImages:undefined;
 if(activeInterviewImages&&images?.length===activeInterviewImages.length&&images.every((image,index)=>{
  const previous=activeInterviewImages![index]!;
  return previous.name===image.name&&previous.src===image.src;
 })){
  if(['','This request has no picture.'].includes(sourceTextContent(el('message'))))message(sourceTextContent(el('dirty')),false,true);
  return;
 }
 releaseInterview?.();releaseInterview=null;
 if(!images?.length)return;
 if(controls.viewModeIds.includes('previous-version'))leavePreviousBuild();
 const previousView=view,previousCamera=structuredClone(viewport.state);viewport.cancelFit();
 const previousReferenceNodes=[...el('reference-content').childNodes],previousReferenceInput=referenceInput,previousReferenceSize=referenceSize;
 const previousMedia={video,controlledVideoSample,sequence,sequenceSvg,selectedPerson,lastPoseFrame};
 const previousLabels=['reference-empty','reference-label','reference-info','person-control'].map(id=>({node:el(id),html:id==='person-control'?undefined:el(id).innerHTML,hidden:el(id).hidden}));
 const disabled=new Map(controls.zoomButtons.concat(controls.nativeOne!).map(button=>[button,button.disabled]));
 for(const button of disabled.keys())button.disabled=false;
 const cameraBindings=button('zoom-in').onclick?[]:[viewport.bindControls(unitScaleMessage),viewport.bindNavigation()];
 activeInterviewImages=images;activeInterviewImage=images[0]!;
 const restore=controls.replaceViewSwitch({currentMode:'interview-image-0',groups:[{modes:images.map((_image,index)=>({id:'interview-image-'+index,labelKey:images.length>1?`Reference ${index+1}`:'Reference',pressed:index===0}))}],onChange:chooseInspectionView});
 viewport.state.cameraSync=false;viewport.state.activeCamera='reference';view='reference';
 releaseInterview=()=>{
  ++referenceGeneration;activeInterviewImages=null;activeInterviewImage=null;restore();
  for(const dispose of cameraBindings)dispose();for(const [button,value]of disabled)button.disabled=value;
  view=previousView;referenceInput=previousReferenceInput;referenceSize=previousReferenceSize;
  ({video,controlledVideoSample,sequence,sequenceSvg,selectedPerson,lastPoseFrame}=previousMedia);
  el('reference-content').replaceChildren(...previousReferenceNodes);
  for(const {node,html,hidden}of previousLabels){if(html!==undefined)node.innerHTML=html;node.hidden=hidden;}
  viewport.cancelFit();Object.assign(viewport.state,previousCamera,{cameraRestoring:true});
  if(!disposed){renderLayout();workspace?.refresh();}
  Object.assign(viewport.state,previousCamera);if(!disposed)fitCamera();
 };
 if(['','This request has no picture.'].includes(sourceTextContent(el('message'))))message(sourceTextContent(el('dirty')),false,true);
 void showReference('',activeInterviewImage);
}
/** Record forms take the record section in the right panel (#1041). */
function renderRecordForms(_forms:readonly HTMLElement[]):void {
 if((typeof checkpointPair==='undefined'||!checkpointPair)&&typeof syncQuestionImage==='function')syncQuestionImage();
 if(host?.record){
  for(const child of el('proposal-panel').children)if(child.id!=='comments-list-host')(child as HTMLElement).hidden=true;
  setSourceText(rigInspector.comments.button,`Comments (${recordComments.length})`);comments?.refresh();partsSubject?.refreshComments();
 }
 rigAsk.onclick=null;
 renderDraftState();
}
/** The ask heading reads only already-pending subjects. It never synthesizes an agent request. */
function renderPendingSubjects(subjects:readonly {kind:string;stage?:string}[]):void {
 subjects=subjects.filter(subject=>subject.kind!=='parts-verdict'&&subject.kind!=='review-verdict');
 const refreshVerdictComments=host?.verdictComments&&(!pendingAnswers.length!==!subjects.length);
 pendingAnswers=subjects;
 // #1226: the comments hint names the button that actually sends them.
 const commentsHint=typeof commentHost==='function'&&commentHost()?rigInspector.comments.panel.querySelector('.review-dialog-header .hint'):null;
 if(commentsHint)setSourceText(commentsHint,'Drafts save locally as you type · nothing is sent until you press Send comments');
 if(host?.record&&host.checkpointPair)void syncCheckpointPair();
 if(refreshVerdictComments){comments?.refresh();partsSubject?.refreshComments();}
 if(host?.recordSubmission?.()==='submitted')firstPublicationPrompt=false;
 // #1228: a displayed record publication takes the comment line where the first-publication waiting line stood;
 // answered and submitted states keep their own line, and progress still takes over the headline.
 const recordCommentMode=!!host?.record&&firstPublicationPrompt;
 renderAskHeadline(((typeof commentHost==='function'&&commentHost())||recordCommentMode?"We're looking at the work together. Leave your thoughts as comments.":firstPublicationPrompt?t('job.waiting',undefined,'en'):'Nothing is waiting for your answer.'));
 if(subjects.length)firstPublicationPrompt=false;
 renderDraftState();
}
function syncJobActRow(subjects=pendingAnswers):void {
 const notice=el('review-message');
 const refusal=notice.classList.contains('error')&&!!notice.textContent?.trim();
 rigInspector.act.hidden=!subjects.length&&!firstPublicationPrompt&&!jobProgress&&!refusal&&!host?.recordSubmission?.()&&!(typeof commentHost==='function'&&commentHost());
 rigInspector.syncActRow?.();
}
function setJobProgress(value:JobProgressV3|null):void {
 if(disposed||jobProgress===value)return;
 jobProgress=value;
 if(pendingAnswers.length)return;
 renderAskHeadline();
 syncJobActRow();
}
function stopProgressTimer():void {
 clearInterval(progressTimer);
 progressTimer=undefined;
}
/** Render the existing sentence. The timer writes only its age node until the quiet threshold. */
function renderAskHeadline(sentence=askSentence):void {
 askSentence=sentence;
 stopProgressTimer();
 askHeadline.hidden=false;
 const progress=pendingAnswers.length||host?.recordSubmission?.()==='submitted' ? null : jobProgress;
 if(!progress){
  askHeadline.removeAttribute('translate');
  askHeadline.style?.removeProperty('white-space');
  setSourceText(askHeadline,sentence);
  // In a refusal the headline ellipsizes to one line (#1041); its title keeps the whole sentence.
  setSourceAttribute(askHeadline,'title',sentence);
  return;
 }
 const at=Date.parse(progress.at),age=()=>Math.max(0,Math.floor((Date.now()-at)/1000));
 const initialAge=age(),quiet=initialAge>=60;
 const phase=t('job.progress.phase.'+progress.phase);
 const phaseAndStep=progress.step ? phase+' · '+t('job.progress.step',[progress.step.i,progress.step.n]) : phase;
 const ageValue=(seconds:number)=>quiet ? String(Math.floor(seconds/60)) : seconds ? t('job.progress.seconds',[seconds]) : t('job.progress.now');
 const ageText=document.createTextNode(ageValue(initialAge));
 // Catalog fragments are already localized. Keep the agent's text as a literal across locale changes.
 askHeadline.setAttribute('translate','no');
 askHeadline.style?.setProperty('white-space','pre-wrap');
 const [before,after]=quiet?t('job.progress.quiet',['{0}',phaseAndStep]).split('{0}'):[(progress.text?phaseAndStep+' · '+progress.text:phaseAndStep)+' · ',''];
 askHeadline.replaceChildren(...[before!,ageText,after!].filter(part=>part!==''));
 // In a refusal the headline ellipsizes to one line (#1041); its title keeps the whole sentence.
 const titleNow=()=>setSourceAttribute(askHeadline,'title',before!+ageText.data+after!);titleNow();
 const tickAge=()=>{
  const seconds=age();
  if((seconds>=60)!==quiet){renderAskHeadline();return;}
  const value=ageValue(seconds);
  if(ageText.data!==value){ageText.data=value;titleNow();}
 };
 if(!suspended&&!disposed)progressTimer=setInterval(tickAge,1000);
}
/** Answer controls compose the existing act bar and submit handlers. */
function renderAnswerControls():void {
 const subjects=pendingAnswers;
 const blocked=saving||draftConflict||!!actReadOnly||!!host?.unavailable||
  (typeof persistence!=='undefined'&&!!persistence?.restoring());
 const save=button('save');
 select('review-status').hidden=true;document.querySelector<HTMLLabelElement>('label[for="review-status"]')!.hidden=true;
 save.hidden=true;rigAsk.hidden=true;
 if(typeof sendComments!=='undefined'){
  const parts=typeof partsOnly!=='undefined'&&partsOnly;
  const pendingComment=parts?!!partsSubject?.hasPendingComment?.():typeof comments!=='undefined'&&!!comments?.hasPendingComment?.();
  const partsLoading=parts&&typeof rigInput!=='undefined'&&rigInput.state!=='loaded';
  sendComments.hidden=!commentHost()||!!host?.jobClosed?.();
  sendComments.disabled=blocked||!!(host?.record?actReadOnly:readOnly)||partsLoading||!hasUnsentContent()&&!pendingComment;
  sendComments.classList.toggle('primary',!subjects.length);
 }
 rigInspector.answersRendered=true;syncJobActRow(subjects);
}
/** The rig pane for a live job's still (#709): the job binds and copies it, this screen keeps its view. */
function hostStage():RigHostStage|null {
 if(!player)return null;const frame=parts?.frame('single');
 return {pane:el('rig-viewport'),paneHidden:el('rig-pane').hidden,root:el('rig-root'),player,frameGeneration:frame?.generation,camera:numericView().cameras.rig,frame:paneFrame('rig'),
  wholeRig:!rigDifference&&!parts?.value()&&player.slots===null&&layers.images,playing,posed:frame,assets};
}
/** Navigation alone crosses publication identity. The source's draft and submitted baseline were loaded normally above. */
async function restorePublicationNavigation():Promise<void> {
 const navigation=host?.navigation;if(!navigation)return;
 if(navigation.subject==='parts'){
  if(!partsSubject)return;
  const opened=await api<PartsSubjectEntry>('/api/review');
  const exists=navigation.part===null||opened.parts.items.some(item=>item.name===navigation.part);
  partsSubject.select(exists?navigation.part:null);partsSubject.isolate(exists&&navigation.solo);parts?.refreshImages();
  await partsSubject.paint();
  view=navigation.view==='reference'?'reference':navigation.view==='compare'?'compare':'rig';renderLayout();
  viewport.cancelFit();
  for(const target of ['rig','reference']as const){const camera=navigation.camera.cameras[target];if(camera)viewport.writeCamera(target,camera);}
  viewport.state.cameraSync=navigation.camera.cameraSync??false;fitCamera();
  navigationMissing=!exists;if(!exists)message(tr('job.incompatible'));return;
 }
 if(partsOnly)return;
 const bookmark=structuredClone(navigation.bookmark);bookmark.binding=inspectionBinding();
 let missing=false;
 if(bookmark.selection.part){
  const {side,slot,mode}=bookmark.selection.part;bookmark.selection.part={side,slot,mode};
  try{parts?.validate(bookmark.selection.part);}catch{bookmark.selection.part=null;missing=true;}
 }
 if(bookmark.selection.checkpoint&&!data.manifest.checkpoints.some(item=>item.id===bookmark.selection.checkpoint))bookmark.selection.checkpoint=null;
 if(bookmark.selection.reference&&!data.manifest.references.some(item=>item.id===bookmark.selection.reference)){bookmark.selection.reference=null;bookmark.view.cameras.reference=null;missing=true;}
 if(bookmark.animation&&!assets?.animations.some(item=>item.name===bookmark.animation)){bookmark.animation=null;bookmark.time=0;bookmark.selection.axis=null;missing=true;}
 if(bookmark.selection.turn){try{if(!turnPad)throw new Error('TURN_UNAVAILABLE');turnPad.state.validate(bookmark.selection.turn);}catch{delete bookmark.selection.turn;missing=true;}}
 if(bookmark.selection.partSet&&!player?.sets().some(item=>item.name===bookmark.selection.partSet)){bookmark.selection.partSet=null;missing=true;}
 if(bookmark.selection.axis){const saved=bookmark.selection.axis,axis=data.manifest.axes.find(item=>item.id===saved.id);if(!axis||axis.animation!==bookmark.animation||saved.value<axis.min||saved.value>axis.max){bookmark.selection.axis=null;missing=true;}}
 const info=await inspectionReferenceInfo(bookmark.selection.reference===undefined?select('reference-select').value:bookmark.selection.reference,new AbortController().signal);
 const limit=inspectionTimeLimit(bookmark,info);
 if(bookmark.time!==null&&(bookmark.time<0||bookmark.time>limit&&limit>=0)){bookmark.time=0;missing=true;}
 if(bookmark.selection.person&&!info.people.includes(bookmark.selection.person)){bookmark.selection.person=null;missing=true;}
 await restoreInspection(bookmark,new AbortController().signal,true,true);
 persistence?.save();
 navigationMissing=missing;if(missing)message(tr('job.incompatible'));
}
function suspendScreen():void {
 if(suspended||disposed)return;
 stopProgressTimer();
 if(!partsOnly&&(!host?.record||host.record.hasPicture))pause();
 persistence?.dispose();persistence=null;suspended=true;cancelAnimationFrame(frameHandle);
}
async function resumeScreen():Promise<void> {
 if(disposed)return;
 (window as unknown as {rigReviewEditor:unknown}).rigReviewEditor=publicEditor;
 const wasInert=screenRoot.inert;let ready=false;screenRoot.inert=true;document.body.removeAttribute('data-ready');
 try{
  await workspace?.settle();
  if(disposed)return;
  if(partsOnly){await setupPartsPersistence?.();if(disposed)return;}
  else if(!host?.record||host.record.hasPicture)await setupPersistence(true);
  suspended=false;if(jobProgress)renderAskHeadline();
  if(!partsOnly&&(!host?.record||host.record.hasPicture))frameHandle=requestAnimationFrame(tick);ready=true;
 }finally{screenRoot.inert=ready?wasInert:true;if(ready&&!disposed)document.body.dataset.ready='true';}
}
function disposeScreen():void {checkpointPair?.release();releaseInterview?.();releaseInterview=null;
 if(disposed)return;suspendScreen();disposed=true;lifecycle.abort();
 comments?.dispose();partsSubject?.dispose();turnPad?.dispose();inspectorBlocks?.dispose();inspectorTabs?.dispose();
 workspace?.dispose();controlDispose?.();appearance?.dispose();rigInspector.actBar.dispose();shell.dispose();
 viewDisposers.forEach(dispose=>dispose());overlays?.dispose();player?.dispose();assets?.dispose();
}
window.addEventListener('pagehide',disposeScreen,{once:true,signal:lifecycle.signal});
/** Old feedback bookmarks keep their inspection mode; only an explicit reveal opens the act. */
function showInspector(name:string,reveal=true):void {if(name==='feedback'){if(reveal)openReview();return;}if(reveal)inspectorTabs?.select(name);else inspectorTabs?.restore(name);}
function bindInspector(partsSubject=false):void {
 inspectorTabs?.dispose();
 rigInspector.row.reveal=()=>workspace?.revealInspector();
 inspectorTabs=bindInspectorTabs(()=>{const mode=inspectorTabs?.state();if(mode)inspectorBlocks?.activate(mode);if(!checkpointPair)syncQuestionImage();workspace?.afterTab();renderLayout();},()=>workspace?.beforeTab(),rigInspector.row);
 viewDisposers.push(bindHeaderModeAvailability(partsSubject?{model:false,parts:true}:{model:!!data.manifest.model,preRig:data.capabilities.preRig,parts:!!host?.record&&!data.manifest.model}));
 for(const mode of document.querySelectorAll<HTMLButtonElement>('[data-mode]'))if(mode.dataset.mode==='rig'||mode.dataset.mode==='playback')mode.onclick=()=>{
  if(checkpointPair?.replayFor!==undefined)void syncCheckpointPair(false);
  showInspector(mode.dataset.mode!);
 };
}
/** Pause at the held time and reveal the existing act without changing Setup/Animate mode. */
function openReview():void {pause();if(!partsOnly)syncCorrectionStage();workspace?.revealCommunication();}
/** #1242 owner ruling 11-25: the person is commenting: at least one comment, pinned or general, or the toolbar's
 * Comment pressed. On rig, direction and parts the right panel opens only then and otherwise leaves the stage wide. */
function commenting():boolean {
  return !!communicationPanel.querySelector('.stage-comment-item[data-comment-id]')||document.getElementById('stage-comment')?.getAttribute('aria-pressed')==='true';
}
/** Something to communicate: a displayed record publication (#1228: its Comments and source stay open without an ask),
 * a pending question or record form, or the person commenting. */
function communicationPending():boolean {return !!host?.record||commenting()||!!communicationPanel.querySelector('form[data-job-ask], .stage-comment-item[data-comment-id]');}
function unitScaleMessage(target:CameraTarget):void {message(partsOnly?'1:1':target==='rig'?'1:1 · one CSS pixel per model coordinate unit.':'1:1 · one CSS pixel per reference grid unit.');}
function bindReviewDialog():void {select('correction-stage').onchange=syncCorrectionStage;button('native-one').title=tr('One CSS pixel per current pane coordinate unit; synchronized panes retain relative zoom.');}

/** Rig world → rig-pane pixels for the current camera. */
function rigProject(){const root=el('rig-root');return (x:number,y:number)=>({x:parseFloat(root.style.left||'0')+x*viewport.state.rigScale,y:parseFloat(root.style.top||'0')-y*viewport.state.rigScale});}
function redrawOverlay(fresh:boolean):void {
 // Fit and editor notifications inside drawRig are followed by its fresh capture.
 if(rigDifference||!fresh&&inDrawRig)return;
 animationPanel?.redraw(layers.bones);
 if(!overlays||!player)return;
 const project=rigProject();
 const regions=[...chestRegions(),...(meshPanel?.overlayRegions()??[]),...(cutsPanel?.overlayRegions()??[]),...(clothPanel?.overlayRegions()??[])],circles=[...chestCircles(),...(meshPanel?.overlayCircles()??[])],markers=[...chestMarkers(),...(cutsPanel?.overlayMarkers()??[])];
 const value=fresh?overlays.refresh({player,frame:parts?.frame('single'),selectedSlot:parts?.value()?.slot,bones:(activeSetupBones()??[]).map(name=>({name})),project,settings:layers,regions,circles,markers,meshEdit:meshEditor?.overlay(),weights:weightsView?.overlay(),anchors:bonesPanel?.overlay()}):overlays.redraw({project,settings:layers,regions,circles,markers,meshEdit:meshEditor?.overlay(),weights:weightsView?.overlay(),anchors:bonesPanel?.overlay()});
 lastOverlay=value;
 text('layer-state',value.warnings.join(' · ')||'Actual last-drawn mesh edges / bone points');idlePanel?.place(duration);rigFieldsPanel?.place();if(!fresh&&value.needsCapture&&!playing&&!seekingControl)drawRig(()=>player!.draw());
}
/**
 * #346: the player loops exactly when Animate repeats, so a repeating clip wraps inside the track and its physics
 * carries across the seam. Changing the mode reopens the track at the current time, as a seek does.
 */
function syncPlayerLoop():void {
 const want=canRepeatIdle();
 if(!player?.current||player.composed||player.entry(0)?.loop===want)return;
 try{drawRig(()=>{player!.play(animation,{loop:want});if(!playing)player!.pause();player!.seek(activeScene()?takeSample(activeScene()!,time).sourceTime:time);player!.draw();},'seek');}
 catch(error){message(errorText(error),true);}
}
function canRepeatIdle():boolean{const direction=activeScene();if(direction)return direction.take.loop;return !!player&&!!assets?.animations.some(clip=>clip.name===animation)&&!axisInspection&&input('idle-repeat').checked&&duration>0;}
function renderIdle():void {text('idle-state',canRepeatIdle()?animation&&animation!=='idle'?`${data.manifest?.animations?.find(a=>a.id===animation)?.label??animation} · repeating`:'Actual idle · repeat enabled':animation==='idle'?'Idle repeat paused':'Non-idle inspection · no automatic playback');}
async function playPreview():Promise<void> {
 if((!player&&!video&&!sequence)||duration<=0)return;
 const intent=++playbackIntent;desiredPlay=true;idleHeld=false;syncPlayerLoop();if(time>=duration)seek(0,{kind:'replay'});
 if(video&&referenceInput.state==='loaded'&&!previousBuildView?.active()){try{await video.play();}catch(error){pause();message(`Playback is paused: ${errorText(error)}. Use Play to retry.`,true);return;}}
 if(intent!==playbackIntent||!desiredPlay){if(!desiredPlay)video?.pause();return;}playing=true;lastFrame=0;player?.hold(false);player?.resume();button('play').textContent='Ⅱ';button('play').setAttribute('aria-label','Pause');
}
function localDraft():boolean{return !!comments?.draft()||dirty;}
function controlState():ControlInspection {
 const box=assets?.stage??player?.bounds(),center=viewport.paneFrame('rig')?.center??(box?{x:box.x+box.width/2,y:box.y+box.height/2}:null);
 return {part:parts?.value()??null,partGeneration:parts?.observation()?.generation??null,view:numericView(),theme:appearance?.get()??'system',layout:'auto',effectiveLayout:el('stage-layout').dataset.orientation==='vertical'?'column':'row',cameras:{rig:{zoom:player?viewport.state.zoom:1,pan:{x:center&&viewport.state.cameraCenter?(center.x-viewport.state.cameraCenter.x)*viewport.state.rigScale:0,y:center&&viewport.state.cameraCenter?(viewport.state.cameraCenter.y-center.y)*viewport.state.rigScale:0}},reference:{zoom:referenceSize?viewport.state.referenceZoom:1,pan:{x:referenceSize&&viewport.state.referenceCenter?(referenceSize.width/2-viewport.state.referenceCenter.x)*viewport.state.referenceScale:0,y:referenceSize&&viewport.state.referenceCenter?(referenceSize.height/2-viewport.state.referenceCenter.y)*viewport.state.referenceScale:0}}},animation:animation||null,time,playing,loop:canRepeatIdle()?'idle':'off',layers:{images:!!player&&layers.images,meshes:!!player&&layers.mesh,bones:!!player&&layers.bones},ready:!!data,seeking:seekingControl||!!video?.seeking||!!persistence?.restoring(),dirty:localDraft(),busy:saving||stripBusy||!!persistence?.restoring(),feedbackEligible:!persistence?.restoring(),comparison:controlComparison(layoutEligibility()),capabilities:{camera:!!player,referenceCamera:!!referenceSize,animation:!!player,time:duration>0,playback:duration>0,layers:{images:!!player,meshes:!!player,bones:!!player}}};
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
  pause();seekingControl=true;try{await inspectControlTime(command.seconds,signal,false,!previousBuildView?.active());}finally{seekingControl=false;}
 }
}
async function inspectControlTime(target:number,signal:AbortSignal,preserveSeconds=false,useReference=true):Promise<void> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 // #191: a control seek is a clip move like the transport's: a seek to 0 restarts the wind clock while the exported world is in use.
 clipMoved({kind:'seek',to:target});
 const media=!useReference||activeScene()?null:video;
 if(!media){time=target;if(player?.current){player.seek(activeScene()?takeSample(activeScene()!,target).sourceTime:target);drawRig(()=>player!.draw(),'seek');}renderSequenceFrame();renderTransport();return;}
 if(media.readyState<1||target>media.duration)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');
 const previousPosition=media.currentTime;
 const commit=(actual:number)=>{
  if(signal.aborted||media!==video)throw new Error('CONTROL_SUPERSEDED');
  if(!Number.isFinite(actual)||actual<0||actual>duration)throw new Error('CONTROL_TIME_OUTSIDE_DOMAIN');
  const seconds=preserveSeconds?target:actual;
  if(player?.current){player.seek(seconds);drawRig(()=>player!.draw(),'seek');}time=seconds;
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
 const value=viewport.numericView();
 if(previousBuildView?.active()){
  // The two world cameras are shown in the viewport readout. Source-bound evidence
  // still has one rig and never treats the previous build as a reference asset.
  value.cameras.reference=null;value.cameraSync=viewport.state.cameraSync;
 }
 return value;
}
function inspectionBinding():InspectionBinding{return {mode:'single',sourceHash:data?.sourceHash??host!.record!.sourceHash,rigs:[data?.reviewedSource.rig?.sha256??null]};}
// Persist the displayed inspection clock; the runtime clock accumulates across idle loops for physics.
function inspectionBookmark():InspectionBookmark {if(rigDifference)return structuredClone(rigDifference.bookmark);const turn=turnPad?.snapshot(),turnSelection=turn?{turn}:{};return {schema:'rig-review-inspection/1',binding:inspectionBinding(),animation:animation||null,time,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:layers.bones},view:numericView(),selection:{...turnSelection,part:parts?.value()??null,view:view==='reference'&&previousBuildView?.active()?'rig':view,checkpoint:checkpoint?.id??null,reference:select('reference-select').value||null,person:selectedPerson||null,inspector:document.querySelector<HTMLElement>('[data-mode][aria-pressed="true"]')?.dataset.mode??selectedInspector()??'rig',partSet:select('part-set').disabled?null:select('part-set').value,axis:axisInspection?{id:select('axis-select').value,value:Number(input('axis-value').value)}:null}};}
async function restoreInspection(bookmark:InspectionBookmark,signal:AbortSignal,preserveSeconds=false,keepCamera=true,feedback?:Feedback):Promise<void> {
 const pictureHost=feedback&&(host?.checkpointPairs||host?.record);
 if(pictureHost){
  const picture=await prepareInspection(bookmark,signal,feedback);
  if(picture){await restoreSealedPicture(bookmark,picture,signal);return;}
 }
 await restoreTransaction(async()=>{
  if(!pictureHost)await prepareInspection(bookmark,signal);
  if(pictureHost||checkpointPair?.replayFor!==undefined)checkpointPair?.release();
 },()=>({bookmark:inspectionBookmark(),inputs:captureInputs()}),()=>applyInspection(bookmark,signal,preserveSeconds,keepCamera),async previous=>{await applyInspection(previous.bookmark,new AbortController().signal);restoreInputs(previous.inputs);});
}
const navigationBookmark=()=>checkpointPair?structuredClone(checkpointPair.bookmark):inspectionBookmark();
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
/** One duration bound for validation and carried publication navigation. */
function inspectionTimeLimit(bookmark:InspectionBookmark,info:{duration:number|null}):number {
 const selection=bookmark.selection;
 if(activeScene()&&bookmark.animation===data.scene?.animation)return activeScene()!.take.duration;
 const clipDuration=bookmark.animation?assets?.animations.find(a=>a.name===bookmark.animation)?.duration:undefined,referenceId=selection.reference===undefined?select('reference-select').value:selection.reference,isVideo=data.manifest.references.find(r=>r.id===referenceId)?.type==='video';
 return clipDuration===undefined?info.duration??0:isVideo&&info.duration!==null?Math.min(clipDuration,info.duration):clipDuration;
}
async function prepareInspection(bookmark:InspectionBookmark,signal:AbortSignal,feedback?:Feedback):Promise<{path:string;sha256:string}|void> {
 const selection=bookmark.selection;
 if(feedback){
  const mark=parseStageComment((feedback.context as {comment?:unknown}|undefined)?.comment),pairs=host?.checkpointPairs;
  const pictures=recordPictures(),picture=pictures?.find(item=>item.path===mark.referenceId&&item.sha256===mark.referenceHash);
  if(mark.viewport==='reference'&&(pairs||host?.record&&(!host.record.hasPicture||picture))&&!manifestReferenceMatches(mark,selection.reference)){
   if(signal.aborted)throw new Error('Inspection restore superseded');
   if(pairs&&mark.sourceHash!==(host?.record?.sourceHash??data.sourceHash))
    throw new Error('COMMENT_REFERENCE_MISMATCH');
   validateSealedPictureMark(feedback,mark,pictures??[],pairs?'COMMENT_REFERENCE_MISMATCH':undefined);
   return picture;
  }
 }

 if(selection.turn){if(!turnPad)throw new Error('TURN_UNAVAILABLE');turnPad.state.validate(selection.turn);}
 parts?.validate(selection.part);
 if(bookmark.animation&&!assets?.animations.some(a=>a.name===bookmark.animation))throw new Error('Saved animation is absent from this rig');
 if(selection.reference&&!data.manifest.references.some(r=>r.id===selection.reference))throw new Error('Saved reference is not declared');
 if(selection.checkpoint&&!data.manifest.checkpoints.some(c=>c.id===selection.checkpoint))throw new Error('Saved checkpoint is absent');
 const axis=selection.axis?data.manifest.axes.find(a=>a.id===selection.axis!.id):null;
 if(selection.axis&&(!axis||selection.axis.value<axis.min||selection.axis.value>axis.max||axis.animation!==bookmark.animation))throw new Error('Saved inspection axis is unavailable or outside its range');
 if(selection.partSet&&!player?.sets().some(set=>set.name===selection.partSet))throw new Error('Saved part preset is absent');
 if(bookmark.view.cameras.a||bookmark.view.cameras.b||bookmark.view.cameras.rig&&!player)throw new Error('Saved camera is unavailable in this single review');
 const info=await inspectionReferenceInfo(selection.reference===undefined?select('reference-select').value:selection.reference,signal);
 if(selection.person&&!info.people.includes(selection.person))throw new Error('Saved pose person is absent');
 const limit=inspectionTimeLimit(bookmark,info);
 if(bookmark.time!==null&&(bookmark.time<0||bookmark.time>limit&&limit>=0))throw new Error('Saved inspection time is outside the selected clip/reference');
 const rig=bookmark.view.cameras.rig,ref=bookmark.view.cameras.reference;
 if(rig&&!player)throw new Error('Saved rig camera is unavailable');
 if(ref&&(info.width<=0||info.height<=0))throw new Error('Saved reference camera has no selected image/video/pose');
 // Viewport aspect, Inspector and pose bounds may differ from the current view.
 // Range fitting belongs to the transactional apply after that layout is measured.
 if(signal.aborted)throw new Error('Inspection restore superseded');
}
async function restoreSealedPicture(bookmark:InspectionBookmark,picture:{path:string;sha256:string},signal:AbortSignal):Promise<void> {
 if(signal.aborted)throw new Error('Inspection restore superseded');
 const tile=checkpointPairTile(picture.path,picture.sha256);
 let shown:typeof checkpointPair=null,generation:number|undefined;
 if(tile){
  if(checkpointPair?.pair!==tile.pair)mountCheckpointPair(tile.pair);
  shown=checkpointPair!;
  const pending=host?.checkpointPair?.();
  shown.replayFor=tile.pair===pending?undefined:pending??null;
  const showing=showCheckpointPair(tile.side);
  generation=shown.generation;
  await showing;
 }else{
  if(checkpointPair){checkpointPair.release();syncQuestionImage();}
  const image=activeInterviewImages?.find(image=>image.path===picture.path&&image.sha256===picture.sha256);
  if(!image)return;
  if(image!==activeInterviewImage){activeInterviewImage=image;await showReference('',image);}
 }
 await settleAnimationFrames();
 if(signal.aborted||checkpointPair!==shown||shown&&generation!==shown.generation)throw new Error('Inspection restore superseded');
 const camera=bookmark.view.cameras.reference;
 if(camera){
  const zoom=tile?camera.viewport.width/camera.visible.width:camera.zoom;
  viewport.writeCamera('reference',{center:camera.center,zoom});viewport.activateCamera('reference');fitCamera();
 }
}
async function applyInspection(bookmark:InspectionBookmark,signal:AbortSignal,preserveSeconds=false,keepCamera=true):Promise<void> {
 viewport.state.cameraRestoring=true;try{
 const selection=bookmark.selection;
 turnPad?.restore(selection.turn);
 parts?.select(selection.part??null);
 pause();
 if(selection.checkpoint!==undefined){checkpoint=data.manifest.checkpoints.find(c=>c.id===selection.checkpoint);renderCheckpoint();renderCheckpoints();}
 if(selection.reference!==undefined&&select('reference-select').value!==(selection.reference??'')){select('reference-select').value=selection.reference??'';await showReference(selection.reference??'');if(selection.reference&&!referenceSize&& !video)throw new Error('Saved reference did not load');}
 if(bookmark.animation&&player)chooseAnimation(bookmark.animation);
 else if(player){restartSetupPlayer(true);player!.clear();animation='';duration=0;time=0;select('animation-select').value='';}
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
 await settleAnimationFrames();if(signal.aborted)throw new Error('Inspection restore superseded');fitCamera();
 const camera=bookmark.view.cameras.rig,ref=bookmark.view.cameras.reference,rigViewport=el('rig-viewport'),referenceViewport=el('reference-viewport');
 const nextZoom=camera&&player&&rigViewport.clientWidth&&rigViewport.clientHeight?restoredZoom(camera,viewport.state.rigScale/viewport.state.zoom,rigViewport.clientWidth,rigViewport.clientHeight):camera?.zoom??null;
 const nextReferenceZoom=ref&&referenceSize&&referenceViewport.clientWidth&&referenceViewport.clientHeight?restoredZoom(ref,viewport.state.referenceScale/viewport.state.referenceZoom,referenceViewport.clientWidth,referenceViewport.clientHeight):ref?.zoom??null;
 // A job rig subject opens at Fit (#709): the bookmark camera was saved at another window size, so opening requests the Fit instead.
 if(keepCamera){viewport.cancelFit();
 if(nextZoom!==null&&camera){viewport.state.zoom=nextZoom;viewport.state.cameraCenter={...camera.center};}
 if(nextReferenceZoom!==null&&ref){viewport.state.referenceZoom=nextReferenceZoom;viewport.state.referenceCenter={...ref.center};}}
 viewport.state.cameraSync=bookmark.view.cameraSync??false;viewport.state.activeCamera=bookmark.view.activeCamera==='reference'?'reference':'rig';
 if(player)drawRig(()=>player!.draw());if(selection.part)parts?.assertIdentity(selection.part);fitCamera();redrawOverlay(false);pause();renderTransport();renderCameraControls();
 }finally{viewport.state.cameraRestoring=false;}
 if(!keepCamera){viewport.requestFit();fitCamera();}
}
async function waitReferenceMetadata(media:HTMLVideoElement,signal:AbortSignal):Promise<void> {if(media.readyState>=1)return;await new Promise<void>((resolve,reject)=>{const clean=()=>{clearTimeout(timer);media.removeEventListener('loadedmetadata',ready);media.removeEventListener('error',fail);signal.removeEventListener('abort',fail);};const ready=()=>{clean();resolve();},fail=()=>{clean();reject(new Error('Saved reference metadata unavailable'));};const timer=setTimeout(fail,10000);media.addEventListener('loadedmetadata',ready,{once:true});media.addEventListener('error',fail,{once:true});signal.addEventListener('abort',fail,{once:true});});}
let inspectionOpening=false;
async function setupPersistence(keepCameraOnResume=false):Promise<boolean> {
 let restoredChestFormPart:string|null=null;
 inspectionOpening=true;try{
 persistence=await connectInspectionPersistence({scope:'single:'+data.manifest.id+':'+data.sourceHash,binding:inspectionBinding(),baseline:submittedBaseline!,session:()=>session,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{session=value;dirty=isDirty;select('review-status').value=session.status;renderProposals();renderCheckpoint();renderCheckpoints();renderProvenance();updateSavedState();},bookmark:navigationBookmark,restoreBookmark:(b,s)=>restoreInspection(b,s,session.feedback.some(f=>isTimeOnlyFeedback(f)&&JSON.stringify((f.context as any).comment.bookmark)===JSON.stringify(b)),keepCameraOnResume||bookmarkCameraKept(inspectionOpening,!!host)),
 ui:()=>({chestFormPart,...(host?{chestLandmarkDraft:chestEditor?.jobDraftText()??null}:{}),inspectorScroll:workspace?.scroll()??'{}',...(inspectorBlocks?activeBlocksUI(inspectorBlocks.state()):{}),reportCategory:select('report-category').value,reportPage,reportEvent:selectedReportEvent?.id??null,reportTime:selectedReportTime??null,reportTarget:selectedReportTarget??null}),restoreUI:value=>{restoredChestFormPart=typeof value.chestFormPart==='string'?value.chestFormPart:null;if(typeof value.reportCategory==='string'&&[...select('report-category').options].some(o=>o.value===value.reportCategory))select('report-category').value=value.reportCategory;if(typeof value.reportPage==='number'&&Number.isSafeInteger(value.reportPage)&&value.reportPage>=0)reportPage=value.reportPage;selectedReportEvent=typeof value.reportEvent==='string'?data.report?.categories.flatMap(c=>c.events).find(e=>e.id===value.reportEvent)??null:null;selectedReportTime=typeof value.reportTime==='number'?value.reportTime:undefined;selectedReportTarget=typeof value.reportTarget==='number'?value.reportTarget:undefined;renderReportEvents();renderReportSelection();inspectorBlocks?.restore(restoreActiveBlocksUI(value));workspace?.restoreScroll(value.inspectorScroll);},afterInputs:draft=>{
  if(host){
   const saved=draft?.ui.chestLandmarkDraft;
   chestEditor?.restoreJobDraft(typeof saved==='string'?saved:null);
  }
  chestFormPart=restoredChestFormPart??parts?.value()?.slot??null;const selected=parts?.value()?.slot;if(rebuildStatus&&selected)void openStageCorrection({part:selected,instrument:'selection'});text('audio-volume-label',`${Math.round(Number(input('audio-volume').value)*100)}%`);},onConflict:value=>{draftConflict=value;updateSavedState();},onStatus:value=>{draftStatus=value;renderDraftState();}});
 }finally{inspectionOpening=false;}
 return persistence.restored;
}
/** Setup's Chest regions tool: designation values, an overlay and a two-file client download. Nothing reaches the session's feedback or the package. */
function chestEvaluation(){return evaluateChestForm(chestField,chestMapping,activeSetupBones());}
function chestRegions():OverlayRegion[]{
 // #345: the chest overlay is drawn only while the Chest regions toggle is on.
 // Jobs draw the landmark derivation through chestCircles, separately from manual region rows.
 if(host||!chestEditor?.active())return [];
 const style=getComputedStyle(document.documentElement),token=(name:string)=>style.getPropertyValue(name).trim();
 return chestOverlayPolygons(chestEvaluation(),activeChestMapping()).map((region,i)=>({...region,stroke:token(i?'--rv-region-b':'--rv-region-a'),fill:token(i?'--rv-region-b-fill':'--rv-region-a-fill')}));
}
function chestCircles():OverlayCircle[]{return readChestCircles(activeChestMapping(),chestEditor,chestField);}
function chestMarkers(){return readChestMarkers(activeChestMapping(),chestEditor,input);}
function populateChestBones():void {
 const bones=activeSetupBones();
 const list=document.getElementById('lm-bones');if(list){list.replaceChildren();for(const name of bones??[])list.append(option(name,name));}
 const part=stageCorrectionPart??chestFormPart,seeded=rebuildStatus&&part?chestSeed(chestStatusForPart(rebuildStatus,part)):null;
 for(const row of chestRegionRows){
  const id=chestRowId(row,'bone'),nameId=chestRowId(row,'name'),node=select(id),current=node.value,seededRow=seeded?.rows.find(r=>r.row===row);
  const rowName=input(nameId).value.trim(),seededName=(seededRow?.fields[nameId]??'').trim();
  const keep=current||(node.disabled&&rowName&&rowName===seededName?(seededRow?.fields[id]??'').trim():'');
  node.replaceChildren(option('',bones?'Select bone':'No model bones'));
  for(const name of bones??[])node.append(option(name,name));
  if(bones&&keep&&bones.includes(keep))node.value=keep;
  node.disabled=!bones;
 }
}
function updateChestMapping():void {
 const root=activeSetupBones()?.[0];let at:{x:number;y:number}|null=null;
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
 chestEditor?.sync();meshEditor?.sync();weightsView?.sync();bonesPanel?.sync();cutsPanel?.sync();clothPanel?.sync();renderDropNotices();redrawOverlay(false);
}
function editExportSource(){return {sourceHash:data.sourceHash,reviewedSource:data.reviewedSource,mapping:chestMapping};}
async function exportChest():Promise<void>{
 return exportChestFiles(chestEvaluation(),{
  source:editExportSource,download,
  refused:error=>message(`Chest regions not exported: ${error}`,true),
  complete:()=>message('Downloaded chest-regions.json and chest-regions.binding.json. The regions are review evidence, not an approval; the package is unchanged.'),
 });
}
/** Animate · Environment. Inspection only: the player is the solver, nothing is written to the model or motion. */
const environmentInputs=['wind-base','wind-breeze','wind-gust','wind-repeat','wind-gust-peak','wind-gust-duration','gravity','jolt','physics-reset','environment-use','environment-export','environment-check'];
function stepEnvironment(dt:number):void {
 stepWorldEnvironment(dt,()=>player,pending=>{joltQueue=pending;});
}
/** A standing world already in force is not set again: `environment` clears the player's seek replay cache (#935: a paused seek applies it). */
function applyEnvironment():void {if(player&&environmentApplied()){const next=environmentFor(wind.read(),gravityValue()),now=player.environment();if(String(next.wind)!==String(now.wind)||String(next.gravity)!==String(now.gravity))player.environment(next);}renderEnvironment();}
function renderEnvironment():void {
 if(!player)return;
 const reading=wind.read();
 text('wind-readout',(environmentApplied()?windReadout(reading,gravityValue()):RUNTIME_START_READOUT)+environmentNote);
 const gust=button('wind-gust');gust.disabled=reading.gusting;if(gust.getAttribute('aria-pressed')!==String(reading.gusting))gust.setAttribute('aria-pressed',String(reading.gusting));setSourceText(gust,reading.gusting?'Gusting…':'Gust');
 text('wind-base-label',input('wind-base').value);text('gravity-label',gravityValue().toFixed(2));
 renderSchedule();
}
function clipDuration(name:string):number{return assets?.animations.find(item=>item.name===name)?.duration??data.manifest.animations.find(item=>item.id===name)?.duration??0;}
function checkAnimation():string{return selectCheckAnimation(assets?.animations,()=>animation);}
let worldCache:{key:string;value:WorldExport|{error:string}}|null=null;
function worldFor(name:string):WorldExport|{error:string} {
 const key=JSON.stringify([wind.snapshot(),gravityValue(),environmentApplied(),name,clipDuration(name)]);
 if(worldCache?.key!==key)worldCache={key,value:worldExport(wind.snapshot(),gravityValue(),environmentApplied(),name,clipDuration(name))};
 return worldCache.value;
}
/** A fresh wind clock at the same settings (a repeating gust restarts at 0), advanced to `at`; pending jolts keep their distance in time. */
function restartWindClock(at=0):void {joltQueue=resetWindClock(wind,joltQueue,at);}
/** #183: every clip restart restarts the wind clock while the schedule is watched. #935: a paused seek sets it to the seek's time. */
function clipMoved(move:ClipMove):void {const at=player?windClockOnMove(move,useWorld(),playing):null;if(at!==null){restartWindClock(at);applyEnvironment();}}
let scheduleShown='';
function renderSchedule():void {
 const world=worldFor(animation),check=checkAnimation(),checked=check!==animation?worldFor(check):null;
 const shown='error' in world?world.error:`${world.summary}${useWorld()?' · used for readings and Apply':''}${checked&&!('error' in checked)&&checked.sha256!==world.sha256?` · check reads ${check}'s: ${checked.summary}`:''}`;
 if(shown!==scheduleShown){scheduleShown=shown;text('environment-schedule',shown);}
}
function feedbackSchedule(){if(!player||!environmentApplied())return null;const world=worldFor(animation);return 'error' in world?null:scheduleContext(world,useWorld());}
let environmentCheckBusy=false;
/** Check under this world: `rig-parts check --environment` on the build on the stage, beside that build's default-world check. */
const runEnvironmentCheck=bindEnvironmentCheck({
 api,path:'/api/environment-check',ui:directJobUiSink,out:()=>el('environment-check-lines'),
 busy:()=>environmentCheckBusy,setBusy:value=>{environmentCheckBusy=value;},
 paintBusy:value=>{button('environment-check').disabled=value||!player;},
 animation:checkAnimation,worldFor,applied:()=>!!appliedOnStage,before:()=>stageCheck,
 baseline:()=>rebuildStatus?.baseline,inspected:inspectedCheckView,follow:show=>followInspectedCheck(show),
 scratchLabel:()=>`the scratch build's Apply check${appliedOnStage&&'environment' in appliedOnStage&&appliedOnStage.environment?` (under schedule sha256 ${appliedOnStage.environment.sha256.slice(0,16)})`:' (default world)'}`,
 missingDefault:(name,line)=>`${name}: no default-world check — ${line} (check a schedule of wind 1, gravity 1 for the runtime's world)`,
 initial:(name,build,scheduled)=>`Checking the ${build} build under ${name}'s schedule (${scheduled.schedule.steps.length} step(s), sha256 ${scheduled.sha256.slice(0,16)}) with rig-parts check --environment…`,
 progress:(build,job,started)=>`check --environment running on the ${build} build · ${((performance.now()-started)/1000).toFixed(0)} s · ${job.lines.at(-1)?.trim()??''}`,
});
/** Every control change engages the environment; until then the player stands at the runtime start values. */
function engage(change:()=>void):void {
 try{change();input('environment-applied').checked=true;environmentNote='';applyEnvironment();persistence?.save();}
 catch(error){message(`Environment unchanged: ${errorText(error)}`,true);syncEnvironmentInputs();}
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
 syncEnvironmentInputs();
 if(player){if(environmentApplied())applyEnvironment();else player.environment(null);}
}
function feedbackEnvironment(){return player?environmentJson(environmentContext(wind.read(),gravityValue(),environmentApplied(),player.environment())):null;}
function enableEnvironment(modelUrl:string,fetcher:typeof fetch):void {
 for(const id of environmentInputs)el<HTMLInputElement|HTMLButtonElement>(id).disabled=false;
 syncEnvironmentInputs();text('physics-panel-state','Reading the compiled model…');text('idle-tracks-state','Reading the compiled model…');
 readingsPanel?.catalog(data.feedbackCatalog.slots??[],data.feedbackCatalog.bones??[]);readingsPanel?.status('Pick readings, then Run: each runs on the inspected build and on the latest scratch build.',false);
 const rig=data.reviewedSource.rig;
 if(!rig){inspectedDocumentReason='PHYSICS_TUNING_UNAVAILABLE: no reviewed rig identity';refreshPhysics();return;}
 void loadModelDocument(modelUrl,rig.sha256,fetcher).then(loaded=>{if(loaded.ok)inspectedDocument=loaded.document;else inspectedDocumentReason=`PHYSICS_TUNING_UNAVAILABLE: ${loaded.reason}`;refreshPhysics();},error=>{inspectedDocumentReason=`PHYSICS_TUNING_UNAVAILABLE: ${errorText(error)}`;refreshPhysics();});
}
/** The panel's rows: the inspected model's constraints against the handoff config's (both must be read). */
function refreshPhysics():void {
 if(!physicsPanel)return;
 if(inspectedDocumentReason){physicsPanel.load({available:false,reason:inspectedDocumentReason},[]);return;}
 if(!inspectedDocument)return;
 if(!rebuildStatus){text('physics-panel-state','Reading the producer handoff…');text('idle-tracks-state','Reading the producer handoff…');return;}
 if(!rebuildStatus.inputs||!rebuildStatus.producer){physicsPanel.load({available:false,reason:rebuildStatus.reason??'PHYSICS_TUNING_UNAVAILABLE: no producer handoff'},[]);refreshIdle();return;}
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
/** Edit Mesh's source (#100): the selected slot's mesh in the model document at the setup pose (a never-played player's bones). */
function meshSource(slot=parts?.value()?.slot??stageDraftSelection?.slot??null){
 if(hasStageModel()&&!partModel)return {ok:false as const,code:'MESH_EDIT_RIG_UNAVAILABLE: the compiled model document is still loading'};
 return meshEditSource({slot,model:hasStageModel()?partModel:null,pose:slot=>assets?readSetupPose(assets,slot,document.createElement('div')):null,mapping:chestMapping});
}
async function exportMesh(doc:MeshEditDocument):Promise<void>{
 return exportMeshFiles(doc,{
  source:editExportSource,download,
  complete:count=>message(`Downloaded mesh-edit.json (${count} ops) and mesh-edit.binding.json. The delta is review evidence, not an approval; the package is unchanged and the producer retriangulates.`),
 });
}
async function applyRetarget(body:{sequence:string;map:PoseMap;flags:RetargetFlags}):Promise<RetargetJobView|RebuildRefusal|null> {
 return stageApplyRetarget(rigStageJobs,body);
}
async function applyMeshDelta(doc:MeshEditDocument,line:(text:string)=>void):Promise<{built:boolean;text:string;error:boolean}> {
 return stageApplyMeshDelta(rigStageJobs,doc,line);
}
let chestFormPart:string|null=null;
const chestPartDrafts=new Map<string,Record<string,{value:string;checked?:boolean}>>();
/** Rebinding is explicit: defaults and both modes belong to the new part, while reopening the same part keeps edits. */
function rebindChestPart(status:RebuildStatusView,part:string):void {
 if(chestFormPart===part)return;
 const next=chestPartFields(status,part);
 const ids=[...chestInputIds,...LANDMARKS.flatMap(({key})=>['x','y'].map(axis=>`lm-${key}-${axis}`)),'lm-alpha','lm-clearance','lm-bone_r','lm-bone_l','bust-mode'];
 if(chestFormPart)chestPartDrafts.set(chestFormPart,Object.fromEntries(ids.flatMap(id=>{const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;return node?[[id,{value:node.value,...(node instanceof HTMLInputElement?{checked:node.checked}:{})}]]:[];})));
 for(const id of ids){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;if(!node)continue;
  if(node instanceof HTMLInputElement){node.value=node.defaultValue;node.checked=node.defaultChecked;}
  else if(node instanceof HTMLTextAreaElement)node.value=node.defaultValue;
  else node.value=[...node.options].find(option=>option.defaultSelected)?.value??node.options[0]?.value??'';
 }
 for(const [id,value] of Object.entries(next.fields)){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|null;if(!node)continue;if(node instanceof HTMLInputElement&&node.type==='checkbox')node.checked=value==='true';else node.value=value;}
 input('bust-mode').value=next.mode;
 const saved=chestPartDrafts.get(part);if(saved)for(const [id,field] of Object.entries(saved)){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;if(node){node.value=field.value;if(node instanceof HTMLInputElement&&field.checked!==undefined)node.checked=field.checked;}}
 chestFormPart=part;chestEditor?.rebind();
 const refusal=next.seed.refusals.join(' · ');chestEditor?.notify(refusal||null,!!refusal,next.seed.refusals);
 el('chest-regions').dispatchEvent(new Event('input',{bubbles:true}));
}
/** `GET /api/rebuild`: whether Apply can run, and the producer config's regions to start an untouched editor from. */
async function loadRebuildStatus():Promise<RebuildStatusView|null> {
 try{rebuildStatus=await api<RebuildStatusView>('/api/rebuild');}catch(error){rebuildStatus=null;const reason=`REBUILD_STATUS_UNAVAILABLE: ${errorText(error)}`;if(!host)chestEditor?.notify(reason,true);animationPanel?.loadSource(null,reason);return null;}
 // Restore the form owner before seeding either mode or caching a selection switch.
 chestFormPart??=chestSeed(rebuildStatus).part;
 const scoped=chestStatusForPart(rebuildStatus,chestFormPart);
 const seed={...(seedFields(scoped,chestField)??{}),...(seedLandmarks(scoped,chestField)??{})};
 if(Object.keys(seed).length){for(const [id,value] of Object.entries(seed)){const node=document.getElementById(id) as HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null;if(!node)continue;if(node instanceof HTMLInputElement&&node.type==='checkbox')node.checked=value==='true';else node.value=value;}el('chest-regions').dispatchEvent(new Event('input',{bubbles:true}));}
 // #315: a config polygon the editor cannot read as an ellipse is named, never shown as an empty row.
 const refused=chestSeed(chestStatusForPart(rebuildStatus,chestFormPart)).refusals;if(refused.length)chestEditor?.notify(refused.join(' · '),true,refused);
 // #342: a rig with no contour mesh disables the chest tools before use and says why in words about the rig.
 const noContour=noContourReason(rebuildStatus);chestEditor?.unavailable(noContour?.text??null);
 if(noContour)chestEditor?.notify(noContour.text,false,noContour.lines);else if(!rebuildStatus.available)chestEditor?.notify(rebuildStatus.reason,!rebuildStatus.viewOnly);
 renderHandoff(rebuildStatus);refreshPhysics();
 retargetPanel?.load(rebuildStatus.retarget??null,rebuildStatus.reason);
 bonesPanel?.load(rebuildStatus.inputs?rebuildStatus.bones??[]:null,rebuildStatus.inputs?null:rebuildStatus.reason??'BONES_UNAVAILABLE: no producer handoff');
 rigFieldsPanel?.load(rebuildStatus.inputs?rebuildStatus.fields??{}:null,rebuildStatus.inputs?null:rebuildStatus.reason??'RIG_FIELDS_UNAVAILABLE: no producer handoff');
 clothPanel?.load(rebuildStatus.inputs?rebuildStatus.cloth??null:null,rebuildStatus.inputs?null:rebuildStatus.reason??'CLOTH_UNAVAILABLE: no producer handoff');
 cutsPanel?.load(rebuildStatus.inputs&&rebuildStatus.cuts?rebuildStatus.cuts.config:null,rebuildStatus.bones??[],rebuildStatus.inputs?null:rebuildStatus.reason??'CUTS_UNAVAILABLE: no producer handoff',rebuildStatus.cuts?.build??null);
 meshPanel?.load(rebuildStatus.inputs?rebuildStatus.meshes??{}:null,rebuildStatus.inputs?null:rebuildStatus.reason??'MESH_PANEL_UNAVAILABLE: no producer handoff');meshPanel?.select(parts?.value()?.slot??stageDraftSelection?.slot??null);
 animationPanel?.loadSource(rebuildStatus.animations??null,rebuildStatus.reason);
 if(!inspectedModel&&canManageApplied())void refreshApplied();
 renderDropNotices();
 const selected=parts?.value()?.slot;if(selected)void openStageCorrection({part:selected,instrument:'selection'});
 return rebuildStatus;
}
/** The handoff line (#101): path, hash and how it was found, then the baseline; re-read while the baseline runs. */
const {renderHandoff,followInspectedCheck}=createHandoffRefresh(()=>el('handoff-line')).bind({
 api,path:'/api/rebuild',ui:directJobUiSink,read:()=>rebuildStatus,save:next=>{rebuildStatus=next;},
});
function rebuildState():void {chestEditor?.rebuildState({busy:rebuildBusy,applied:!!appliedOnStage});renderApplied();comments?.refresh();if(!rebuildBusy)void refreshApplied();}
/** #166: the session's applied records (the server's stack), the last one on the stage when the stage shows it. */
let appliedHistory:AppliedHistoryView|null=null;
async function refreshApplied():Promise<void> {
 if(!canManageApplied())return;
 try{appliedHistory=await api<AppliedHistoryView>('/api/rebuild/history');}catch{return;}
 renderApplied();
}
function chestPartForNotice():string|null {
 if(!rebuildStatus)return null;
 if(chestEditor?.mode()==='landmarks'){
  const read=chestEditor.landmarks();
  return 'derived' in read?pickBustPart(rebuildStatus,read.derived.regions):pickBustPart(rebuildStatus,[]);
 }
 const designated=designatedRegions(chestField,rebuildStatus?chestSeed(chestStatusForPart(rebuildStatus,chestFormPart)):null);
 return 'regions' in designated?pickPart(rebuildStatus,designated.regions):rebuildStatus.parts.length===1?rebuildStatus.parts[0]!.name:null;
}
function renderDropNotices():void {
 const slot=parts?.value()?.slot??stageDraftSelection?.slot??null,meshPart=meshPanel?.part()??slot,chestPart=chestPartForNotice();
 for(const node of document.querySelectorAll<HTMLElement>('[data-rebuild-drop]')){
  const panel=node.dataset.rebuildDrop as RebuildPanelKind;
  const part=panel==='mesh'?meshPart:panel==='mesh-edit'?slot:panel==='chest'?chestPart:null;
  let notice='';let isError=false;
  try{notice=dropNoticeForPanel(appliedOnStage,panel,{part,handoff:rebuildStatus});}
  catch(error){notice=errorText(error);isError=true;}
  node.textContent=notice;node.hidden=!notice;node.classList.toggle('error',isError);
 }
}
let readoutStage:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation|null=null;
const rigStageJobState={
  get inspectedModel(){return inspectedModel;},
  get stageSource(){return stageSource;},
  get stageModelHash(){return stageModelHash;},
  get rebuildStatus(){return rebuildStatus;},
  get appliedOnStage(){return appliedOnStage;},
  set appliedOnStage(next){appliedOnStage=next;},
  get stageCheck(){return stageCheck;},
  set stageCheck(next){stageCheck=next;},
  get appliedHistory(){return appliedHistory;},
  set appliedHistory(next){appliedHistory=next;},
  get readoutStage(){return readoutStage;},
  set readoutStage(next){readoutStage=next;},
  get stripPending(){return stripPending;},
  set stripPending(next){stripPending=next;},
  get stripView(){return stripView;},
};
const rigStageDraft:NonNullable<StageJobScreen['draft']>={
 canManage:canManageApplied,
 deltaRefusal:()=>!inspectedModel&&appliedOnStage?MESH_DELTA_APPLIED_SOURCE:null,
 begin(kind){
  const transition={kind,priorBuildId:appliedOnStage?.buildId??'inspected',
   priorPart:stageCorrectionPart??stageDraftSelection?.part??null,token:++stageDraftRequestToken};
  return async(next,world)=>{
   const target=next?draftScratchTarget(next.id,next.url,next.hash):draftInspectedTarget();
   await prepareStageDraftBuild(target.buildId,target.sha256,{target,transition,world});
  };
 },
 refresh:refreshRigDraft,
 regionStatus:loaded=>loaded?chestStatusForPart(loaded,stageCorrectionPart??chestFormPart):loaded,
 regionRefusal:()=>stageCorrectionPart&&(parts?.value()?.slot??stageDraftSelection?.slot??null)!==stageCorrectionPart?'STAGE_DRAFT_MISMATCH':null,
};
function refreshRigDraft():void {if(!inspectedModel)refreshStageParts?.();}
const rigChestOutput={
 progress:(write:()=>void)=>write(),
 notice:(text:string,error:boolean,lines?:readonly string[])=>chestEditor?.notify(text,error,lines),
 message:(text:string,error?:boolean)=>message(text,error),
};
const rigStageJobs:StageJobScreen={
 state:rigStageJobState,api:(path,init)=>api(path,init),path:'/api/rebuild',
 draft:rigStageDraft,readOnly:()=>readOnly,loadStatus:loadRebuildStatus,selected:()=>true,
 busy:()=>rebuildBusy,setBusy:setRigRebuildBusy,setScopedBusy:setRigRebuildBusy,
 world:()=>stageWorld(),swap:({url,prefix,hash},world)=>swapRig(url,prefix,hash,world),
 target:(next,stripId)=>({url:new URL(access.route(next.url),location.href).href,
  prefix:access.route(stripId?`/density-strip/${stripId}/${next.id}/`:`/rebuild/${next.id}/`),hash:next.hash}),
 changed:stageChanged,message:(text,error)=>message(text,error),
 writeDraft:()=>writeRebuildDraft(el<HTMLTextAreaElement>('rebuild-applied'),appliedOnStage),
 chest:()=>chestEditor,chestField:(name)=>chestField(name),mesh:()=>meshPanel,
 meshNote:text=>meshEditor?.setStatusNote(text,false),animation:()=>animationPanel,retarget:()=>retargetPanel,
 schedule:()=>useWorld()?worldFor(checkAnimation()):null,
 chestOutput:()=>rigChestOutput,
 patchStart:patch=>`Applying patch (${patch.op.cmd}, ${patch.ops.length} op(s))…`,
 resetNote:'Reset: the inspected build is on the stage. The draft keeps the last applied state.',
 resetMessage:'Reset to the inspected build.',
 undoStatus:(text,error)=>appliedStatus(text,error),
 undoText:result=>{
  const inspectedHash=inspectedModel?.sha256??data.reviewedSource.rig?.sha256??data.sourceHash;
  return `Undid ${result.undone.slice(0,12)}… · the stage is ${result.status==='inspected'?`the inspected build (model ${inspectedHash.slice(0,12)}…)`:`record ${result.history.depth} (model ${stageModelHash?.slice(0,12)}…)`} · ${result.history.depth} applied record(s) left`;
 },
 restoreUndoRetarget:retarget=>{
  stageClock=retarget?.clock??null;
  if(retarget&&assets?.animations.some(clip=>clip.name===retarget.animation))chooseAnimation(retarget.animation);
 },
 finishUndo:job=>renderAppliedBlocks(job),
 undoReadouts:(cuts,cloth)=>{cutsPanel?.shown(cuts);clothPanel?.shown(cloth);},
 redrawUndo:()=>redrawOverlay(true),
 setRetargetClock:(job,hash)=>{stageClock=retargetStage(job,hash)?.clock??null;},
 selectRetargetPlayback:job=>{
  const name=job.request.record.flags.animation;
  if(assets?.animations.some(clip=>clip.name===name))chooseAnimation(name);
  const ref=job.request.record.sequence.reference;
  if(data.manifest.references.some(r=>r.id===ref)&&select('reference-select').value!==ref){
   select('reference-select').value=ref;return showReference(ref);
  }
 },
 redrawStripBack:()=>redrawOverlay(true),renderStrip:()=>renderStrip(),reportStrip:(text,error)=>densityLine(text,error),
 animationApplyText:(path,count)=>`Applying ${count} animation op(s) on ${path} (rig-parts rig → rigc build → rig-parts check)…`,
 animationResetText:'Reset: the inspected build is on the stage; no pending animation ops.',
 resetForAnimation:()=>resetRebuild(stageWorld()),
 stripLoad:{
  densityBusy:()=>densityBusy,
  draw:()=>{
   if(!layers.mesh){layers.mesh=true;input('layer-mesh').checked=true;}
   if(player)drawRig(()=>player!.draw());redrawOverlay(true);
  },
  triangles:part=>lastOverlay?.meshTriangles[part]??null,
  pendingCount:(view,row)=>`${view.field} ${row.value} · ${row.counts?`v ${row.counts.vertices} · t ${row.counts.triangles}`:'no counts'} (remesh.json) — not applied`,
  pendingStatus:(view,row,index,agreement)=>`Pending on the stage: ${view.part} ${view.field} ${row.value} (strip row ${index+1}) — not applied. The Mesh panel's Apply applies it; Back returns the stage. ${agreement}`,
 },
};
function setRigRebuildBusy(value:boolean):void {rebuildBusy=value;rebuildState();}
function readAppliedStage(){return rigStageJobState;}
function renderAppliedBlocks(restoredJob:AnyJobView|null=null):void {
 reconcileAppliedBlocks(readAppliedStage(),{
  chestEditor,meshEditor,meshPanel,bonesPanel,rigFieldsPanel,cutsPanel,clothPanel,physicsPanel,idlePanel,retargetPanel,animationPanel,
 },renderDropNotices,restoredJob,document);
}
function renderApplied():void {
 renderAppliedPanel(renderAppliedBlocks,readAppliedStage,()=>rebuildBusy||!!readOnly,el,document);
}
function appliedStatus(text:string,error=false):void {setAppliedStatus(el('applied-status'),text,error);}
async function undoApply():Promise<UndoView|null> {
 return stageUndoApply(rigStageJobs);
}
async function applyRebuild():Promise<void> {
 return stageApplyRebuild(rigStageJobs);
}
async function applyPatch(patch:ConfigPatch,world:StageWorld|null=null):Promise<PatchJobView|RebuildRefusal> {
 return stageApplyPatch(rigStageJobs,patch,world);
}
/** The client's edit entry point for automation and the edit cards to come: apply a patch, return to the inspected build, read the stage. */
(window as unknown as {rigReviewEditor:unknown}).rigReviewEditor=publicEditor={
 applyPatch,reset:()=>resetRebuild(),
 /** #166: undo the last Apply, and the applied records as the server holds them. */
 undo:()=>undoApply(),history:()=>appliedHistory?JSON.parse(JSON.stringify(appliedHistory)):null,
 status:async()=>rebuildStatus??await loadRebuildStatus(),
 /** #345: what the stage draws for the chest tools right now (zero of each while the toggle is off). */
 chest:{drawn:()=>({circles:chestCircles().length,regions:chestRegions().length,markers:chestMarkers().length})},
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
  pause();if(steps.length)player.environment(null);at(0);player.seek(0);player.hold(false);player.resume();
  try{for(let k=1,n=Math.round(t/dt);k<=n;k++){at(k);player.frame(dt);}}finally{player.hold(true);player.pause();}
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
 mesh:{part:()=>meshPanel?.part()??null,select:(part:string)=>{meshPanel?.select(part);renderDropNotices();},entry:()=>meshPanel?.entry()??null,configEntry:()=>meshPanel?.configEntry()??null,set:(path:string[],value:import('../src/config-patch.ts').JsonValue|undefined)=>meshPanel?.set(path,value),setEntry:(entry:MeshEntry)=>meshPanel?.setEntry(entry),
  regions:()=>meshPanel?.regions.list()??[],addRegion:(region:import('../src/mesh-entry.ts').MeshRegion)=>meshPanel?.regions.add(region),moveRegion:(region:number,vertex:number,to:[number,number])=>meshPanel?.regions.move(region,vertex,to),drawRegions:(on:boolean)=>meshPanel?.regions.draw(on),placing:()=>meshPanel?.regions.placing()??null,
  precheck:()=>meshPanel?.precheck()??[],apply:()=>{const part=meshPanel?.part(),entry=meshPanel?.entry();return part&&entry?applyMesh(part,entry):Promise.resolve(null);},reset:()=>resetMeshBuild(),folds:()=>meshFolds(),
  overlayTriangles:(slot:string)=>lastOverlay?.meshTriangles[slot]??null,status:()=>el('mesh-status').textContent,counts:()=>[...document.querySelectorAll('#mesh-counts code')].map(c=>c.textContent),readout:()=>[...document.querySelectorAll('#mesh-readout code')].map(c=>c.textContent),pending:()=>input('mesh-pending').value,lastPatch:()=>lastMeshPatch?JSON.parse(JSON.stringify(lastMeshPatch)):null,
  /** #173: the density strip — build N values, the view, load a row as pending, back, close. */
  strip:{build:(values:number[])=>buildDensityStrip(values),view:()=>stripView?JSON.parse(JSON.stringify(stripView)):null,load:(i:number)=>stageLoadStripRow(rigStageJobs, i),back:()=>stageStripBack(rigStageJobs),close:()=>closeDensityStrip(),pending:()=>stripPending?{index:stripPending.index,candidate:stripPending.candidate}:null,
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
 /** Keyed animation editor (#235): the single pending op list, dopesheet/inspector actions, preview state, Apply and Reset. */
 animation:{
  ops:()=>animationPanel?.ops()??[],
  unappliedOps:()=>animationPanel?.unappliedOps()??[],
  hasPreview:()=>animationPanel?.hasUnappliedPreview()??false,
  source:()=>animationPanel?.sourceInfo()??null,
  setSourceLoading:()=>animationPanel?.setSourceLoading(),
  setSource:(source:Parameters<AnimationInspectionPanel['loadSource']>[0],fallbackReason?:string|null)=>animationPanel?.loadSource(source,fallbackReason),
  gate:()=>animationPanel?.gateInfo()??null,
  tracks:()=>animationPanel?.tracksInfo()??[],
  selectedKey:()=>animationPanel?.selectedKeyInfo()??null,
  selectedKeys:()=>animationPanel?.selectedKeysInfo()??[],
  selectKey:(track:number,key:number)=>animationPanel?.selectKey(track,key)??false,
  selectKeys:(selections:ReadonlyArray<{track:number;key:number}>)=>animationPanel?.selectKeys(selections)??false,
  toggleKeySelection:(track:number,key:number)=>animationPanel?.toggleKeySelection(track,key)??false,
  deleteSelection:()=>animationPanel?.deleteSelection()??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  stagePoseMode:()=>animationPanel?.stagePoseMode()??'rotate',
  setStagePoseMode:(mode:'rotate'|'translate')=>animationPanel?.setStagePoseMode(mode),
  poseBone:(boneName:string,arg2:'rotate'|'translate'|number,arg3:number,arg4:number|'rotate'|'translate')=>{const mode=typeof arg2==='string'?arg2:(arg4 as 'rotate'|'translate');const clientX=typeof arg2==='number'?arg2:arg3;const clientY=typeof arg2==='number'?arg3:(arg4 as number);return animationPanel?.poseBoneOnStage(boneName,mode,clientX,clientY)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'};},
  overlaid:()=>animationPanel?.overlaidInspection()??null,
  boneWorld:(boneName:string)=>animationPanel?.boneWorldMatrix(boneName)??null,
  setKeyTime:(track:number,key:number,t:number)=>animationPanel?.setKeyTime(track,key,t)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  setKeyValue:(track:number,key:number,channel:number|undefined,value:number|readonly number[])=>animationPanel?.setKeyValue(track,key,channel,value)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  setKeyCurve:(track:number,key:number,curve:readonly number[]|'stepped'|null)=>animationPanel?.setKeyCurve(track,key,curve)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  setKeyEase:(track:number,key:number,ease:string|null)=>animationPanel?.setKeyEase(track,key,ease)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  insertKey:(track:number,t:number,value?:readonly number[])=>animationPanel?.insertKey(track,t,value)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  deleteKey:(track:number,key:number)=>animationPanel?.deleteKey(track,key)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  moveSelection:(selections:ReadonlyArray<{track:number;key:number}>,deltaTime:number)=>animationPanel?.moveSelection(selections,deltaTime)??{ok:false,error:'ANIMATION_PANEL_UNAVAILABLE'},
  undoOp:()=>animationPanel?.undoOp()??false,
  clearPending:()=>animationPanel?.clearPending(),
  zoom:()=>animationPanel?.zoomLevel()??1,
  setZoom:(z:number)=>animationPanel?.setZoom(z),
  apply:()=>stageApplyAnimation(rigStageJobs,animationPanel?.ops()??[]),
  reset:()=>stageResetAnimation(rigStageJobs),
  status:()=>document.querySelector('[data-animation-editor-status]')?.textContent??'',
 },
 stage:()=>({modelHash:stageModelHash,inspectedHash:inspectedModel?.sha256??null,applied:appliedOnStage?JSON.parse(JSON.stringify(appliedOnStage)):null,animation,time:player?.time??time,playing,busy:rebuildBusy}),
};
const panelRebuilds=bindPanelRebuilds({
 bones:()=>bonesPanel,cloth:()=>clothPanel,cuts:()=>cutsPanel,idle:()=>idlePanel,
 mesh:()=>meshPanel,physics:()=>physicsPanel,'rig-fields':()=>rigFieldsPanel,
},{
 origin:()=>undefined,sink:()=>directJobUiSink,status:()=>rebuildStatus,loadStatus:loadRebuildStatus,
 stageWorld,canReset:(_origin,key)=>!!appliedOnStage||(key==='mesh'&&!!stripPending),
 apply:(_origin,patch,world)=>applyPatch(patch,world),reset:(_origin,world)=>resetRebuild(world),
 before:()=>stageCheck,inspected:inspectedCheckView,follow:(_origin,show)=>followInspectedCheck(show),
 redraw:()=>redrawOverlay(true),
 progress:(_origin,key,patch,status,keys)=>{
  const {ops,producer}=patch;
  if(key==='cuts')return `Applying ${ops.length} op(s) with ${producer.name} ${producer.version}: build (assemble → rig → check), compile… (a full build takes minutes)`;
  if(key==='cloth'){
   const route=status?.cloth?.route==='build'?'build (assemble → rig → check)':'rig --config, check';
   return `Applying ${ops.length} op(s) with ${producer.name} ${producer.version}: propose --cloth --write-config, then ${route}, compile…`;
  }
  if(key==='idle')return `Applying ${ops.length} op(s) with ${producer.name} ${producer.version}: ${patchRoute(ops,producer.version)} --config${keys?` --idle-keys ${keys}`:''}, compile, check…`;
  return `Applying ${ops.length} op(s) with ${producer.name} ${producer.version}: ${patchRoute(ops,producer.version)} --config, compile, check…`;
 },
});

/**
 * Physics Apply (#103): the pending ops become one config patch (`rig`, then check) against the handoff config; the
 * scratch build reloads under the world Apply was pressed in, and the readout shows the two check lines before (the
 * build that was on the stage) and after. A refusal shows the producer's line verbatim and leaves the stage as it was.
 */
async function applyPhysics(ops:PatchOp[]):Promise<PatchJobView|RebuildRefusal|null> {
 const status=rebuildStatus??await loadRebuildStatus();
 const job=panelRebuilds.beginPanelRebuild('physics');
 const patch = preparePanelPatch(status, ops, 'PHYSICS_NOTHING_PENDING: no pending ops', job);
 if(!patch)return null;
 physicsPanel?.clearPreview();
 const world=stageWorld();
 return panelRebuilds.applyPanelPatch(job,patch,status,null,()=>applyPatch(patch,world));
}
function inspectedCheckView():InspectedCheckView|null {return readInspectedCheck(rebuildStatus);}
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
  const job=await runReadingsRequest(body,{api,path:'/api/readings',onError:text=>readingsPanel?.status(text,true),onProgress:job=>{
   const done=job.runs.reduce((n,r)=>n+r.results.length,0),total=job.runs.length*job.request.readings.length;
   readingsPanel?.status(`Running readings of ${animation}: ${done} of ${total} done…`,false);
  }});
  if(job.status!=='done')return job;
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
function readingsContext():ReadingsContext|null {return buildReadingsContext(readingsJob);}
/** Requirements (#113): what the handoff's rig spec offers the panel, or why nothing does. */
const loadRequirements=bindRequirementsCatalog({api,path:'/api/requirements',ui:directJobUiSink,panel:()=>requirementsPanel});
function runRequirements(body:RequirementsRequest):Promise<RequirementsJobView|RequirementsRefusal|null> {
 return runRequirementsRequest(body,{api,path:'/api/requirements',refresh:loadRequirements});
}
async function checkBones(ops:PatchOp[]):Promise<BonesCheckView> {
 const status=rebuildStatus??await loadRebuildStatus();
 return requestBonesCheck(ops,status,{api,path:'/api/bones-check'});
}
/**
 * Bones Apply (#109): the pending ops become one config patch (`rig`, then check) against the handoff config — a
 * whole-rig op, so the server refuses it (`EDIT_BASELINE_MISMATCH`) unless the baseline reproduced the inspected rig.
 * On a build the re-weighted rig reloads in place (the Weights view reads the revision); a refusal is shown verbatim.
 */
const applyBones=panelRebuilds.apply.bind(null,'bones');
/**
 * Cuts Apply (#115): the pending cut / patch / range / joint ops become one `rig` patch, which the server runs as
 * `rig-parts build` (assemble → rig → check) from the handoff's painting and runs; the scratch build reloads in place
 * and the panel shows the refusals, the recomposite, the seam pairs and the build's wall clock.
 */
const applyCuts=panelRebuilds.apply.bind(null,'cuts');
/**
 * Cloth Apply (#111): the pending recipe ops become one `rig` patch, which the server runs as `rig-parts propose --cloth
 * --write-config` and then builds the written config; the scratch build reloads in place under the stage's world.
 */
const applyCloth=panelRebuilds.apply.bind(null,'cloth');
/** Cloth Reset: the inspected build back on the stage (same world), and no pending op. */
const resetClothBuild=panelRebuilds.reset.bind(null,'cloth');
/** Cuts Reset: the inspected build back on the stage (same world), and no pending op. */
const resetCutsBuild=panelRebuilds.reset.bind(null,'cuts');
/** Bones Reset: the inspected build back on the stage (same world), and no pending op. */
const resetBonesBuild=panelRebuilds.reset.bind(null,'bones');
/**
 * Rig fields Apply (#110): the pending ops (in the block's scope, `RIG_FIELDS_OP_OUT_OF_SCOPE` otherwise) become one
 * config patch (`rig`, then check) against the handoff config — a whole-rig op behind the baseline guard (`/stops`,
 * `/bones`, `/regions`, `/turn` and the blink still are outside retune's scope, #136). On a build the revision reloads in place and the readout shows BLINK_NO_HOLE and FEET_STAY_LEVEL
 * before and after; a refusal shows the producer's line verbatim and leaves the stage as it was.
 */
const applyRigFields=panelRebuilds.apply.bind(null,'rig-fields');
/** Rig fields Reset: the dial off, no pending op, and the inspected build back under the same world. */
const resetRigFieldsBuild=panelRebuilds.reset.bind(null,'rig-fields');
/** Physics Reset: the inspected build back under the same world, and no pending op. */
const resetPhysicsBuild=panelRebuilds.reset.bind(null,'physics');
/**
 * Idle tracks Apply (#104): the pending ops become one config patch (`rig --idle-keys <the inspected rig's keys>`, no
 * flag when they could not be read, then check) against the handoff config. The preview was cleared when Apply was pressed; on a built job the scratch build
 * reloads under the same world and its built idle plays, and the readout shows CHAIN_LAG, TIP_OVER_ROOT, BREATH_VISIBLE
 * and the loop line before and after. A refusal shows the producer's line verbatim and leaves the stage as it was.
 */
const applyIdle=panelRebuilds.apply.bind(null,'idle');
/** Idle Reset: the preview cleared, no pending op, and the inspected build back under the same world. */
const resetIdleBuild=panelRebuilds.reset.bind(null,'idle');
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
 try{p.seek(0);recording=true;p.repose();p.hold(false);p.resume();for(let k=1;k<=n;k++)p.frame(dt);}
 finally{recording=false;p.hold(true);p.pause();p.adjust=inner;drawRig(()=>p.draw());time=p.time;renderTransport();}
 return [...rows.values()].sort((a,b)=>a.t-b.t);
}
async function resetRebuild(world:StageWorld|null=null):Promise<void> {
 return stageResetRebuild(rigStageJobs,world);
}
/**
 * Replace the drawn rig in place: the new model loads first (a failure leaves the stage as it was), then the player is
 * swapped and the same animation, time, set, camera and environment are restored; playback resumes when it was running.
 */
let stageSource:{url:string;prefix:string;hash:string}|null=null;
async function swapRig(modelUrl:string,prefix:string,sha256:string,world:StageWorld|null=null):Promise<void> {
 const cameraRestoring=viewport.state.cameraRestoring;
 stageCorrectionRebinding++;try{
 const keepPart=parts?.value()??null,keepStage=assets?.stage;
 const keepFramingBox=rigRaster.active()?undefined:viewportProvider.geometry('rig')?.box;
 const keepRigCamera=structuredClone(viewport.paneCamera('rig')),keepReferenceCamera=structuredClone(viewport.paneCamera('reference'));
 const keepAnimation=animation,keepTime=time,wasPlaying=playing,keepSet=select('part-set').disabled?'':select('part-set').value;
 inspectionSourceState='pending';partModel=null;pause();refreshAnimationInspection();
 const inputs=stageLoadInputs(modelUrl,sha256);
 const next=await loadModel({modelUrl,...inputs,resolvePage:(name,url)=>{const target=new URL(name,url);if(target.origin!==location.origin||!target.pathname.startsWith(prefix))throw new Error(`Model page escapes its build: ${name}`);return target.href;}}).catch(error=>{inspectionSourceState='failed';refreshAnimationInspection();throw error;});
 const keepFraming=!!keepStage&&!!next.stage&&(['x','y','width','height'] as const).every(key=>keepStage[key]===next.stage![key]);
 viewport.state.cameraRestoring=true;viewport.cancelFit();
 // The fit-relative zoom also depends on the first-draw framing basis, not just the declared stage.
 if(keepFraming&&keepFramingBox)rebuildFramingBoxes.set(next,{...keepFramingBox});
 physicsPanel?.clearPreview();
 pause();player?.dispose();assets?.dispose();assets=next;player=createInspectionPlayer(el('rig-root'),assets,undefined,{url:modelUrl,sha256});setupChestWorld=readSetupChest(player);stageModelHash=sha256;stageSource={url:modelUrl,prefix,hash:sha256};
 // A scratch build may hold another set of animations (a retarget adds one, #114): the picker lists what this build has.
 {const animations=select('animation-select');animations.replaceChildren(...assets.animations.map(item=>option(item.name,data.manifest.animations.find(a=>a.id===item.name)?.label??item.name)));animations.disabled=assets.animations.length===0;}
 try{const catalog=await loadPartModel(modelUrl,sha256,data.feedbackCatalog.slots??[],inputs.fetch);inspectionSourceState='ready';partModel=catalog.model;configureTurnPad(catalog.model);refreshAnimationInspection();weightsView?.refresh();meshEditor?.selectionChanged();parts?.register('single',catalog.entries,player,new PartThumbnails(pageRegionTable(catalog.model),assets.pageImages));}catch(error){inspectionSourceState='failed';partModel=null;refreshAnimationInspection();parts?.refuseCatalog('single',error);}
 configurePartSets(keepSet);
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
 if(parts&&inspectionSourceState==='ready')parts.restoreSelection(keepPart);
 updateChestMapping();
 if(keepFraming){viewport.writeCamera('rig',keepRigCamera);viewport.writeCamera('reference',keepReferenceCamera);fitCamera();}
 else{viewport.state.cameraRestoring=cameraRestoring;viewport.requestFit();fitCamera();}
 // The preview (#104) drives the new player once its bone setups are read (an idle Apply cleared it first).
 stageDocumentSet=true;void loadModelDocument(modelUrl,sha256,inputs.fetch).then(loaded=>{if(loaded.ok&&stageModelHash===sha256)idlePanel?.model(boneSetup(loaded.document));});
 if(wasPlaying)void playPreview();
 }finally{viewport.state.cameraRestoring=cameraRestoring;stageCorrectionRebinding--;directionPanel?.refresh();}
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
const resetMeshBuild=panelRebuilds.reset.bind(null,'mesh');
/**
 * #173 · Density strip. Build: one Mesh-panel patch per value (the pending entry with its density field at that value),
 * sent together to `POST /api/density-strip` and polled until every candidate settles. Load: a built row's revision on
 * the stage as pending — the applied record, the undo stack and the feedback context's applied state are left alone
 * (the context reads null while a pending row is on the stage: nothing applied is on it), and Undo is unavailable until
 * Back returns the stage to what it showed or an Apply lands (the Mesh panel's reuses the row's build; any Apply, Reset or Undo clears the pending row, #183). Close removes
 * the strip's scratch.
 */
let stripView:DensityStripViewLike|null=null,densityBusy=false;
let stripPending:{index:number;id:string;candidate:string;back:{url:string;prefix:string;hash:string;applied:AppliedRecord|AppliedPatch|AppliedDelta|AppliedRetarget|AppliedAnimation|null;check:{lines:string[];check:CheckSummary|null}|null}}|null=null;
function stageChanged(change:StageChange<NonNullable<typeof stripPending>>):void {updateDensityPending(readAppliedStage(),change,refreshDensityStrip);}
const densityLine=(text:string,error=false)=>{densityStrip?.status(text,error);if(error)message(text,true);};
const renderStrip=()=>densityStrip?.show(stripView,stripPending&&stripView?.id===stripPending.id?stripPending.index:null,densityBusy||rebuildBusy||!!readOnly);
const {refresh:refreshDensityStrip,build:buildDensityStrip,close:closeDensityStrip}=bindDensityStripJobs({
 api,path:'/api/density-strip',ui:directJobUiSink,view:()=>stripView,save:next=>{stripView=next;},render:renderStrip,
 busy:()=>densityBusy,setBusy:value=>{densityBusy=value;},pendingId:()=>stripPending?.id,back:()=>stageStripBack(rigStageJobs),panel:()=>densityStrip,
 footer:text=>message(text,true),readOnly:()=>readOnly,status:()=>rebuildStatus,loadStatus:loadRebuildStatus,mesh:()=>meshPanel,
 initial:(part,values)=>`Building a strip of ${values.length} on ${part}: ${values.join(', ')} — remesh, compile and remesh's own check per value…`,
 summary:(view,passing)=>`Strip of ${view.rows.length} on ${view.part} settled in ${((view.wallMs??0)/1000).toFixed(1)} s (at most ${view.concurrency} at once): ${passing} passing, ${view.rows.length-passing} refused or failing. Labels only — nothing is applied; Load puts a row on the stage as pending.`,
});
const meshFolds=bindMeshFolds(directJobUiSink,()=>animation||'(no animation)',runReadings,()=>meshPanel);
void start();


/** Only live, unrecorded authoring effects block capture; unsent form ops alone do not. */
function commentCaptureRefusal():string|null {
 if(rigDifference)return 'RIG_DIFFERENCE_COMMENT_UNAVAILABLE: return to Rig or Reference before adding a comment.';
 if(appliedOnStage)return 'COMMENT_APPLIED_BUILD_UNSUPPORTED: return to the inspected source before commenting on this applied scratch build';
 if(rebuildBusy)return 'COMMENT_SOURCE_BUSY: wait for the rebuild or candidate model replacement before commenting';
 const preview=idleAdjust?'Idle tracks':typeof animAdjust!=='undefined'&&animAdjust?'Keyed animation preview':dialAdjust?'Rig fields turn dial':physicsPreview.read().length?'Physics live overrides':stripPending?'Density strip candidate':
  meshEditor?.overlay()?'Edit Mesh':bonesPanel?.overlay()?'Bones anchors':cutsPanel&&(cutsPanel.overlayRegions().length||cutsPanel.overlayMarkers().length)?'Cuts/patches/joints':
  clothPanel?.overlayRegions().length?'Cloth links':meshPanel&&(meshPanel.overlayRegions().length||meshPanel.overlayCircles().length)?'Mesh regions':
  chestRegions().length||chestCircles().length||chestMarkers().length?'Chest regions/landmarks':rigFieldsPanel?.handles().length?'Rig fields stage handles':
  (()=>{const handles=document.getElementById('idle-handles');return handles&&!handles.hidden&&handles.childElementCount>0;})()?'Idle tracks stage handles':null;
 return preview?`COMMENT_UNAPPLIED_PREVIEW: ${preview} is active; leave or disable that preview before commenting (nothing is cleared or applied automatically)`:null;
}
/** #1048: the shown plan picture or sealed question image takes reference-view pins. The camera is the shared reference viewport's image space,
 * so `world` is the picture's natural pixels; the identity is the sealed `files` entry. */
function sealedReferenceCamera(){
 const camera=numericView().cameras.reference;
 return camera?{...camera,zoom:clampZoom(camera.zoom)}:camera;
}
function planPicturePose(view:StageComment['viewport']):CommentPose|null {
 const picture=shownPlanPicture(),pane=el('reference-viewport'),camera=sealedReferenceCamera();
 const content=el('reference-content'),media=content.querySelector('img');
 const canvas=checkpointPair?.mode==='difference'?content.querySelector('canvas')??undefined:undefined;
 if(!picture||view!=='reference'||!camera||(!media&&!canvas)||pane.clientWidth<=0||pane.clientHeight<=0)return null;
 return {mode:'setup',capture:{pane,root:content,images:true,backend:'canvas2d',canvas},camera,frame:null,timeBasis:timeOnlyBasis,time:0,animation:null,turn:null,
  sourceHash:host?.record?.sourceHash??data.sourceHash,modelHash:null,referenceHash:picture.sha256,referenceId:picture.path,
  rig:checkpointPair&&data?data.feedbackCatalog.rig:picture.name,media:media??undefined};
}
function planPictureBookmark():InspectionBookmark {
 const bookmark=navigationBookmark();
 if(checkpointPair){
  const reference=sealedReferenceCamera();
  return {...bookmark,animation:null,time:0,view:{schema:'rig-review-view/1',cameras:{rig:null,reference,a:null,b:null},cameraSync:false,activeCamera:'reference'},selection:{
  view:'reference',part:null,checkpoint:data?.manifest.checkpoints.some(item=>item.id===checkpointPair!.pair.checkpointId)?checkpointPair.pair.checkpointId:null,
  reference:shownPlanPicture()!.path,inspector:'rig'}};
 }
 return {...bookmark,time:0,selection:{...bookmark.selection,view:'reference',reference:shownPlanPicture()!.path,inspector:'rig'}};
}
function restoreCommentInspection(value:unknown,timeOnly?:boolean,row?:CommentRow):Promise<void> {
 const feedback=row as Feedback|undefined;
 const mark=host?.record&&host.checkpointPairs&&feedback?
  parseStageComment((feedback.context as {comment?:unknown}|undefined)?.comment):null;
 // The record can reopen with a different backdrop. The tile path, hash and record source bind this replay.
 if(mark?.viewport==='reference'&&mark.sourceHash===host?.record?.sourceHash&&checkpointPairTile(mark.referenceId,mark.referenceHash)){
  const bookmark=parseBookmark(value);
  if(!manifestReferenceMatches(mark,bookmark.selection.reference))
   return restoreInspection(bookmark,lifecycle.signal,!!timeOnly,true,feedback);
 }
 return restoreInspection(parseBookmark(value,inspectionBinding()),lifecycle.signal,!!timeOnly,true,feedback);
}
function setupComments():void {
 if(host?.direction||host?.record){restoreRecordComments();liveIssueCount=()=>recordComments.filter(row=>!(typeof isSentAlone==='function'&&isSentAlone(row))).length;if(host?.direction)dirty=dirty||recordComments.length>0;}
 const notes=host?.verdictComments??(typeof localCommentSource!=='undefined'&&localCommentSource?localCommentNotes:null);
 if(notes){
  restoreRecordComments();
  if(localCommentSource){
   // The persisted draft can predate a successful send. Recheck its comments against the sent-row cache.
   const recoveredReviewChanges=dirty&&submittedBaseline!==null&&
    (session.status!==submittedBaseline.status||JSON.stringify(session.checkpoints)!==JSON.stringify(submittedBaseline.checkpoints));
   dirty=hasUnsentComments()||recoveredReviewChanges;
   updateSavedState();
  }else if(notes.rows.length)markDirty();
 }
 comments=bindStageComments<CommentRow,CommentPose>({answeredDirectionFeedback:host?.direction?.answeredDirectionFeedback,general:host?.record||host?.direction||notes?{
  create:summary=>({id:crypto.randomUUID(),summary}),matches:row=>!('target' in row),
  ...(notes?{...notes,refusal:()=>readOnly}:{}),
 }:undefined,listHost:el('comments-list-host'),openList:openReview,hasPicture:()=>checkpointPair?.replayFor===undefined&&(!activeInterviewImages||!!shownPlanPicture()),toolbar:el('stage-comment').parentElement!,viewports:host?.record&&!host.record.hasPicture?(recordPictures()?{reference:el('reference-viewport')}:{}):{rig:el('rig-viewport'),reference:el('reference-viewport')},
  viewportAvailable:view=>view!=='reference'||!previousBuildView?.active(),
  rigAnchor:host?.direction||host?.record?undefined:{
   lastFrame:selected=>feedbackLastFrame(data.feedbackCatalog,selected),
   targetNames:kind=>feedbackTargetNames(data.feedbackCatalog,kind),
   selectedTarget:()=>{
    const selected=animationPanel?.value(),slot=parts?.value()?.slot;
    return selected?.kind==='bone'?selected:slot?{kind:'slot',name:slot}:null;
   },
  },
  renderRow:host?.direction||host?.record?undefined:(row,element)=>{
   if('target' in row)renderFeedbackDetails(row as Feedback,element);
  },
  pose:view=>{
   if(host?.checkpointPairs&&checkpointPair||host?.record&&(!host.record.hasPicture||shownPlanPicture()))return planPicturePose(view);
   if(activeInterviewImages)return null;
   if(view!=='rig'&&view!=='reference')return null;const workspaceMode=document.querySelector<HTMLElement>('[data-mode][aria-pressed="true"]')?.dataset.mode;if(workspaceMode!=='rig'&&workspaceMode!=='playback')return null;const camera=numericView().cameras[view],pane=el(view+'-viewport');if(!camera||pane.clientWidth<=0||pane.clientHeight<=0)return null;
   const renderer=player?.renderer;const current=time,index=frameAtTime(activeFrameClock(),current),referenceId=view==='reference'?select('reference-select').value||null:null,referenceHash=referenceId?data.referenceHashes?.[referenceId]??(data.explicitReference?.id===referenceId?data.explicitReference.sha256:null):null;
   return {mode:workspaceMode==='playback'?'animate':'setup',capture:{pane,root:view==='rig'?el('rig-root'):undefined,images:view==='reference'||layers.images,canvas:view==='rig'&&renderer instanceof CanvasRenderer?renderer.canvas:undefined,backend:renderer instanceof CanvasRenderer?renderer.backendActive:renderer?.meshBackendActive??'canvas2d'},camera,frame:index===null?null:{index,basis:'producer'},...(index===null?{timeBasis:timeOnlyBasis}:{}),time:current,animation:animation||null,turn:turnPad?.snapshot()??null,sourceHash:data.sourceHash,modelHash:view==='reference'?null:stageModelHash,referenceHash,referenceId,rig:data.manifest.id,...(view==='reference'?{media:video??el('reference-content').querySelector('img')??undefined}:{posed:parts?.frame('single'),assets:assets??undefined})} as CommentPose;
  },
  pause:async()=>{const running=playing||!!video&&!video.paused;pause();if(running&&video&&video.readyState>=1&&!video.closest?.('[data-previous-build-active]')){seekingControl=true;try{await inspectControlTime(time,new AbortController().signal);}finally{seekingControl=false;}}const turn=turnPad?.snapshot();if(turn)turnPad?.restore({...turn,held:true},false);else if(turnPad?.state?.releasing)turnPad.restore(undefined);},bookmark:()=>shownPlanPicture()?planPictureBookmark():inspectionBookmark(),restore:restoreCommentInspection,feedback:()=>host?.record||host?.direction?recordComments:session.feedback,
  locked:host?.record||host?.direction?id=>submittedDirectionComments.has(id)||recordComments.some(row=>row.id===id&&isSentAlone(row)):isSubmittedFeedback,add:f=>{if(host?.record||host?.direction)recordComments.push(f);else session.feedback.push(f as Feedback);},changed:()=>{if(/^The source changed, so /.test(draftStatus??''))draftStatus=null;if(host?.record||host?.direction){recordCommentsChanged();if(host?.direction){markDirty();comments?.refresh();}return;}if(notes)persistRecordComments();session.feedbackWarnings=session.feedbackWarnings.filter(warning=>session.feedback.some(row=>row.id===warning.id));markDirty();renderProposals();return persistence?.save();},draftChanged:()=>{if(typeof renderAnswerControls==='function')renderAnswerControls();},error:value=>message(value,true),
  picture:mark=>{
   if(mark.viewport!=='reference'||manifestReferenceMatches(mark,(mark.bookmark as InspectionBookmark).selection.reference))return null;
   const tile=checkpointPairTile(mark.referenceId,mark.referenceHash);
   if(tile)return {name:t(checkpointPairLabels[tile.side])};
   const record=host?.record,pictures=record?[...record.planPicture?[record.planPicture]:[],...record.questionPictures??[]]:[];
   return pictures.find(picture=>mark.referenceId===picture.path&&mark.referenceHash===picture.sha256)?.name??null;},
  refusal:()=>{
   if(host?.checkpointPairs&&checkpointPair)return shownPlanPicture()!.path.length>512?'COMMENT_PICTURE_LABEL_INVALID: picture identity':null;
   return host?.record&&(!host.record.hasPicture||shownPlanPicture())?null:commentCaptureRefusal();
  },blocked:()=>saving||!!persistence?.restoring()||seekingControl||!!video?.seeking||!!rebuildBusy||!!appliedOnStage,shortcutBlocked:()=>!!meshEditor?.active()
 });
 if(!host?.direction&&!host?.record)renderProposals();
}

/** Open the existing precision instruments only after re-reading the same displayed draft binding. */
interface StageDraftModelTarget {buildId:string;url:string;prefix:string;sha256:string}
interface StageDraftTransition {
 kind:'open'|'apply'|'undo'|'reset';
 token:number;
 priorBuildId:string;
 priorPart:string|null;
 expectedPart?:string|null;
 expectedSourceHash?:string;
 instrument?:string;
}
let stageCorrectionPart:string|null=null,stageCorrectionRebinding=0,stageDraftRequestToken=0;
let stageDraftSelection:{part:string;slot:string;skin:string;attachment:string;sourceHash:string;buildId:string}|null=null;
let stageCommittedEntries:PartEntry[]|null=null;
let stageDraftTarget:StageDraftModelTarget|null=null;
let refreshStageParts:(()=>void)|null=null;
function canManageApplied():boolean{return Boolean(inspectedModel||data?.capabilities?.preRig||rebuildStatus?.draft);}
function draftInspectedTarget():StageDraftModelTarget{
 const rig=data?.reviewedSource?.rig;
 if(!rig||typeof rig.path!=='string'||!rig.path||typeof rig.sha256!=='string'||!rig.sha256)throw new Error('STAGE_DRAFT_MISMATCH');
 return {buildId:'inspected',url:new URL(assetUrl(rig.path),location.href).href,prefix:access.route('/assets/'),sha256:rig.sha256};
}
function draftScratchTarget(buildId:unknown,modelUrl:unknown,modelHash:unknown):StageDraftModelTarget{
 if(typeof buildId!=='string'||!buildId||buildId==='inspected'||typeof modelUrl!=='string'||!modelUrl||typeof modelHash!=='string'||!modelHash)throw new Error('STAGE_DRAFT_MISMATCH');
 return {buildId,url:new URL(access.route(modelUrl),location.href).href,prefix:access.route(`/rebuild/${buildId}/`),sha256:modelHash};
}
async function resolveStageDraftTarget(buildId:string):Promise<StageDraftModelTarget>{
 if(buildId==='inspected')return draftInspectedTarget();
 if(!appliedOnStage||appliedOnStage.buildId!==buildId||typeof appliedOnStage.modelHash!=='string'||!appliedOnStage.modelHash)throw new Error('STAGE_DRAFT_STALE');
 if(stageDraftTarget&&stageDraftTarget.buildId===buildId&&stageDraftTarget.sha256===appliedOnStage.modelHash)return stageDraftTarget;
 const job=await api<AnyJobView>(`/api/rebuild/${buildId}`);
 if(!job||job.id!==buildId||job.status!=='built'||!job.build||job.build.modelHash!==appliedOnStage.modelHash)throw new Error('STAGE_DRAFT_MISMATCH');
 return draftScratchTarget(job.id,job.build.modelUrl,job.build.modelHash);
}
async function prepareStageDraftBuild(
 buildId:string,
 nextModelHash:string|null,
 options?:{target?:StageDraftModelTarget;transition?:StageDraftTransition;world?:StageWorld|null},
):Promise<{status:RebuildStatusView|null;mapping:{part:string;slot:string;skin:string;attachment:string}}>{
 if(readOnly)throw new Error(readOnly);
 const transition=options?.transition;
 if(transition){
  if(transition.token!==stageDraftRequestToken)throw new Error('STAGE_DRAFT_STALE');
  if(transition.kind==='open'){
   if(rebuildBusy||(appliedOnStage?.buildId??'inspected')!==buildId)throw new Error('STAGE_DRAFT_STALE');
  }else{
   if(!rebuildBusy||(appliedOnStage?.buildId??'inspected')!==transition.priorBuildId||(stageCorrectionPart??stageDraftSelection?.part??null)!==transition.priorPart)throw new Error('STAGE_DRAFT_STALE');
  }
 }

 let nextAssets:ModelAssets|null=null;
 let target:StageDraftModelTarget;
 let verifiedDoc:unknown=null;
 let verifiedEntries:PartEntry[]=[];
 let verifiedBones:string[]=[];
 let verifiedRegions:ReturnType<typeof pageRegionTable>|null=null;
 let stageData:{sourceHash:string;draft?:{inspectionOnly?:boolean;buildId:string;mappings:{part:string;slot:string;skin:string;attachment:string;vertices:number;triangles:number}[]};draftUnavailable?:string};
 let mapping:{part:string;slot:string;skin:string;attachment:string}|undefined;
 let status:RebuildStatusView|null=rebuildStatus;
 try{
  stageData=await api<{sourceHash:string;draft?:{inspectionOnly?:boolean;buildId:string;mappings:{part:string;slot:string;skin:string;attachment:string;vertices:number;triangles:number}[]};draftUnavailable?:string}>('/api/stage-parts',{headers:{'X-Review-Stage-Build':buildId}});
  if(!stageData.draft||stageData.draft.buildId!==buildId)throw new Error(stageData.draftUnavailable??'STAGE_DRAFT_MISMATCH');
  if(stageData.draft.inspectionOnly)throw new Error('PARTS_VERDICT_READ_ONLY: Stage 1 draft is inspection-only');
  if(transition?.expectedSourceHash!==undefined&&stageData.sourceHash!==transition.expectedSourceHash)throw new Error(stageData.draftUnavailable??'STAGE_DRAFT_MISMATCH');
  const targetPart=transition?.expectedPart??stageCorrectionPart??stageDraftSelection?.part??null;
  mapping=targetPart?stageData.draft.mappings.find(m=>m.part===targetPart):stageData.draft.mappings[0];
  if(!mapping||mapping.slot!==mapping.part)throw new Error(stageData.draftUnavailable??'STAGE_DRAFT_MISMATCH');
  if(transition?.kind==='open'){
   status=rebuildStatus??await loadRebuildStatus();
   if(!status)throw new Error('REBUILD_STATUS_UNAVAILABLE');
   if(transition.instrument==='chest'&&!status.parts.some(part=>part.name===mapping!.part))throw new Error(`REBUILD_PART_NOT_CONTOUR: ${mapping.part}`);
  }
  if(!nextModelHash)throw new Error(buildId==='inspected'?'STAGE_DRAFT_MISMATCH':'STAGE_DRAFT_STALE');
  target=options?.target??await resolveStageDraftTarget(buildId);
  if(target.buildId!==buildId||target.sha256!==nextModelHash||!target.url||!target.prefix)throw new Error('STAGE_DRAFT_MISMATCH');
  const inputs=stageLoadInputs(target.url,target.sha256);
  nextAssets=await loadModel({modelUrl:target.url,...inputs,resolvePage:(name,url)=>{const pageUrl=new URL(name,url);if(pageUrl.origin!==location.origin||!pageUrl.pathname.startsWith(target.prefix))throw new Error(`Model page escapes its build: ${name}`);return pageUrl.href;}});
  const loadedDoc=await loadModelDocument(target.url,target.sha256,inputs.fetch);
  if(!loadedDoc.ok)throw new Error('PART_SOURCE_CHANGED: model bytes differ from reviewed SHA-256');
  verifiedDoc=loadedDoc.document;
  const rawSlots=verifiedDoc&&typeof verifiedDoc==='object'&&!Array.isArray(verifiedDoc)?(verifiedDoc as {slots?:unknown}).slots:null;
  if(!Array.isArray(rawSlots))throw new Error('Part catalog requires bounded model slots and skins');
  const slotNames=rawSlots.map(s=>s&&typeof s==='object'&&typeof (s as {name?:unknown}).name==='string'?(s as {name:string}).name:'');
  verifiedEntries=partCatalog(verifiedDoc,slotNames);
  verifiedBones=modelBoneNames(verifiedDoc);
  verifiedRegions=pageRegionTable(verifiedDoc);
  const slotEntry=verifiedEntries.find(e=>e.slot===mapping!.slot);
  if(!slotEntry||!slotEntry.declarations.some(d=>d.skin===mapping!.skin&&d.attachment===mapping!.attachment&&d.kind==='mesh'))throw new Error('STAGE_DRAFT_MISMATCH');
  const setupPose=readSetupPose(nextAssets,mapping.slot,document.createElement('div'));
  if(!setupPose.identity||setupPose.identity.skin!==mapping.skin||setupPose.identity.attachment!==mapping.attachment||!setupPose.readMesh())throw new Error('STAGE_DRAFT_MISMATCH');
  if(!verifiedBones.length)throw new Error('CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn');

  const finalStage=await api<{sourceHash:string;draft?:{inspectionOnly?:boolean;buildId:string;mappings:{part:string;slot:string;skin:string;attachment:string}[]};draftUnavailable?:string}>('/api/stage-parts',{headers:{'X-Review-Stage-Build':buildId}});
  if(!finalStage.draft||finalStage.draft.buildId!==buildId||finalStage.sourceHash!==stageData.sourceHash)throw new Error(finalStage.draftUnavailable??'STAGE_DRAFT_STALE');
  if(finalStage.draft.inspectionOnly)throw new Error('PARTS_VERDICT_READ_ONLY: Stage 1 draft is inspection-only');
  const finalMapping=finalStage.draft.mappings.find(m=>m.part===mapping!.part);
  if(!finalMapping||finalMapping.slot!==mapping.slot||finalMapping.skin!==mapping.skin||finalMapping.attachment!==mapping.attachment)throw new Error(finalStage.draftUnavailable??'STAGE_DRAFT_MISMATCH');

  if(readOnly)throw new Error(readOnly);
  if(transition){
   if(transition.token!==stageDraftRequestToken)throw new Error('STAGE_DRAFT_STALE');
   if(transition.kind==='open'){
    if(rebuildBusy||(appliedOnStage?.buildId??'inspected')!==buildId)throw new Error('STAGE_DRAFT_STALE');
   }else{
    if(!rebuildBusy||(appliedOnStage?.buildId??'inspected')!==transition.priorBuildId||(stageCorrectionPart??stageDraftSelection?.part??null)!==transition.priorPart)throw new Error('STAGE_DRAFT_STALE');
   }
  }
 }catch(error){
  try{nextAssets?.dispose();}catch{/* ignore */}
  throw error;
 }

 const rigRoot=el('rig-root');
 const prevNodes=[...rigRoot.childNodes];
 const prevRootStyle={left:rigRoot.style.left,top:rigRoot.style.top,transform:rigRoot.style.transform,transformOrigin:rigRoot.style.transformOrigin,clipPath:rigRoot.style.clipPath};
 const prevPlayer=player,prevAssets=assets,prevPartModel=partModel,prevStageModelBones=stageModelBones,prevCommittedEntries=stageCommittedEntries;
 const prevInspectionSourceState=inspectionSourceState,prevStageModelHash=stageModelHash,prevStageSource=stageSource,prevSetupChestWorld=setupChestWorld,prevChestMapping=chestMapping,prevRigInput=rigInput,prevSelection=stageDraftSelection,prevStageDraftTarget=stageDraftTarget;
 const prevPartValue=parts?.value()??null,prevPartRefusal=parts?.refusal('single')??null;
 const prevView=view,prevEffectiveView=effectiveView,prevViewportState=structuredClone(viewport.state),prevInspector=selectedInspector(document);
 const prevInspectorStates=[...document.querySelectorAll<HTMLElement>('[data-inspector]')].map(node=>({node,pressed:node.getAttribute('aria-pressed'),selected:node.getAttribute('aria-selected')}));
 const prevAnimation=animation,prevTime=time,prevDuration=duration,prevWasPlaying=playing;
 const partSetNode=document.getElementById('part-set') as HTMLSelectElement|null;
 const keepSet=!partSetNode||partSetNode.disabled?'':partSetNode.value;
 const animSelect=document.getElementById('animation-select') as HTMLSelectElement|null;
 const prevAnimationOptions=animSelect?[...animSelect.childNodes]:[];
 const prevAnimationControl=animSelect?{disabled:animSelect.disabled,value:animSelect.value}:null;
 const prevSetOptions=partSetNode?[...partSetNode.childNodes]:[];
 const prevSetControl=partSetNode?{disabled:partSetNode.disabled,value:partSetNode.value}:null;
 const prevStageControls=['rig-empty','player-state','renderer-state','layer-images','layer-mesh','layer-bones'].map(id=>{
  const node=document.getElementById(id) as HTMLInputElement|null;
  return {node,hidden:node?.hidden,disabled:node?.disabled,text:node?.textContent};
 });
 let nextPlayer:RigPlayer|null=null;
 stageCorrectionRebinding++;
 try{
  pause();
  // Release the previous renderer's root clip while retaining its pose and views for rollback.
  prevPlayer?.renderer.render({order:[]});
  rigRoot.replaceChildren();
  nextPlayer=createInspectionPlayer(rigRoot,nextAssets,undefined,target);
  // A fresh player's draw has no held pose. Clearing track 0 publicly poses Setup.
  nextPlayer.clear();
  const nextSetupChest=readSetupChest(nextPlayer);
  let rootAt:{x:number;y:number}|null=null;
  try{const b=nextPlayer.bone(verifiedBones[0]!);rootAt={x:b.x,y:b.y};}catch{rootAt=null;}
  const nextMapping=cropWorldMapping(nextAssets.stage,rootAt);
  if(!nextMapping.available)throw new Error(nextMapping.reason);

  assets=nextAssets;
  player=nextPlayer;
  partModel=verifiedDoc;
  stageModelBones=verifiedBones;
  stageCommittedEntries=verifiedEntries;
  inspectionSourceState='ready';
  stageModelHash=target.sha256;
  stageSource={url:target.url,prefix:target.prefix,hash:target.sha256};
  setupChestWorld=nextSetupChest;
  chestMapping=nextMapping;
  rigInput={state:'loaded'};

  parts?.register('single',verifiedEntries,nextPlayer,new PartThumbnails(verifiedRegions!,nextAssets.pageImages));
  drawRig(()=>nextPlayer!.draw());
  parts?.select({side:'single',slot:mapping.slot,mode:prevPartValue?.slot===mapping.slot?prevPartValue.mode:'context'});
  if(parts){
   const liveIdentity=parts.value()?.identity;
   if(!liveIdentity||liveIdentity.skin!==mapping.skin||liveIdentity.attachment!==mapping.attachment)throw new Error('STAGE_DRAFT_MISMATCH');
  }
  renderLayout();
  updateChestMapping();
  fitCamera();

  if(animSelect){
   animSelect.replaceChildren(...nextAssets.animations.map(item=>option(item.name,data.manifest?.animations?.find(a=>a.id===item.name)?.label??item.name)));
   animSelect.disabled=nextAssets.animations.length===0;
   animSelect.value='';
  }
  if(partSetNode)configurePartSets(keepSet);
  if(options?.world){
   wind.resume(options.world.wind);
   joltQueue=options.world.jolts.map(step=>({...step}));
   const envApplied=document.getElementById('environment-applied') as HTMLInputElement|null;if(envApplied)envApplied.checked=options.world.applied;
   const grav=document.getElementById('gravity') as HTMLInputElement|null;if(grav)grav.value=String(options.world.gravity);
   syncEnvironmentInputs();
  }
  if(document.getElementById('environment-applied')&&environmentApplied()){
   nextPlayer.environment(environmentFor(wind.read(),gravityValue()));
   applyEnvironment();
  }
  animation='';duration=0;time=0;
  renderTransport();renderCues();renderIdle();
  stageDraftSelection={part:mapping.part,slot:mapping.slot,skin:mapping.skin,attachment:mapping.attachment,sourceHash:stageData.sourceHash,buildId};
  stageDraftTarget=target;
  const rigEmpty=document.getElementById('rig-empty');if(rigEmpty)rigEmpty.hidden=true;
  if(document.getElementById('player-state'))text('player-state','Draft rig · structure evidence only');
  for(const id of ['layer-images','layer-mesh','layer-bones']){const node=document.getElementById(id) as HTMLInputElement|null;if(node)node.disabled=false;}
  populateChestBones();
  configureTurnPad(verifiedDoc);
  refreshAnimationInspection();
  weightsView?.refresh();
  meshEditor?.selectionChanged();
  renderChest();
  idlePanel?.model(boneSetup(verifiedDoc));
  physicsPanel?.clearPreview();
  stageDocumentSet=true;
  if(prevWasPlaying)void playPreview();
 }catch(commitError){
  try{nextPlayer?.dispose();}catch{/* ignore */}
  try{nextAssets.dispose();}catch{/* ignore */}
  rigRoot.replaceChildren(...prevNodes);
  assets=prevAssets;player=prevPlayer;partModel=prevPartModel;stageModelBones=prevStageModelBones;stageCommittedEntries=prevCommittedEntries;
  inspectionSourceState=prevInspectionSourceState;stageModelHash=prevStageModelHash;stageSource=prevStageSource;setupChestWorld=prevSetupChestWorld;chestMapping=prevChestMapping;rigInput=prevRigInput;stageDraftSelection=prevSelection;stageDraftTarget=prevStageDraftTarget;
  animation=prevAnimation;time=prevTime;duration=prevDuration;
  // nextPlayer.dispose() has returned the caller's clip. Redraw before restoring
  // the saved styles so the previous renderer borrows that baseline again.
  if(prevPlayer&&prevAssets&&prevPartModel&&prevCommittedEntries){
   parts?.register('single',prevCommittedEntries,prevPlayer,new PartThumbnails(pageRegionTable(prevPartModel),prevAssets.pageImages));
   try{drawRig(()=>prevPlayer.draw());}catch{/* ignore */}
   try{parts?.select(prevPartValue?{side:prevPartValue.side,slot:prevPartValue.slot,mode:prevPartValue.mode}:null);}catch{/* ignore */}
  }else{
   if(prevPartRefusal)parts?.refuseCatalog('single',prevPartRefusal.message);
   else parts?.clear('single');
  }
  view=prevView;effectiveView=prevEffectiveView;
  if(prevInspector)showInspector(prevInspector,false);
  for(const {node,pressed,selected} of prevInspectorStates){
   if(pressed===null)node.removeAttribute('aria-pressed');else node.setAttribute('aria-pressed',pressed);
   if(selected===null)node.removeAttribute('aria-selected');else node.setAttribute('aria-selected',selected);
  }
  try{renderLayout();}catch{/* ignore */}
  Object.assign(viewport.state,structuredClone(prevViewportState));
  renderCameraControls();
  Object.assign(rigRoot.style,{left:prevRootStyle.left,top:prevRootStyle.top,transform:prevRootStyle.transform,transformOrigin:prevRootStyle.transformOrigin,clipPath:prevRootStyle.clipPath});
  if(animSelect&&prevAnimationControl){animSelect.replaceChildren(...prevAnimationOptions);Object.assign(animSelect,prevAnimationControl);}
  if(partSetNode&&prevSetControl){partSetNode.replaceChildren(...prevSetOptions);Object.assign(partSetNode,prevSetControl);}
  for(const {node,hidden,disabled,text:priorText} of prevStageControls){
   if(!node)continue;
   node.hidden=hidden!;node.disabled=disabled!;
   if(node.id==='player-state'||node.id==='renderer-state')node.textContent=priorText!;
  }
  populateChestBones();
  renderChest();
  if(prevWasPlaying)void playPreview();
  throw commitError;
 }finally{
  stageCorrectionRebinding--;
  directionPanel?.refresh();
 }
 try{prevPlayer?.dispose();}catch{/* ignore */}
 try{prevAssets?.dispose();}catch{/* ignore */}
 return {status,mapping};
}
async function openStageCorrection(request:{part:string;sourceHash:string;buildId:string;instrument:string}|{part:string;instrument:'selection'}):Promise<void>{
 if(!('sourceHash' in request)){
  if(!rebuildStatus||rebuildBusy)return;
  const seed=chestSeed(chestStatusForPart(rebuildStatus,request.part));
  const unavailable='The selected part has no chest regions. The chest editor keeps its current part.';
  if(!seed.part){chestEditor?.notify(unavailable);return;}
  if(chestFormPart===request.part){if(chestEditor?.noticeText?.()===unavailable)chestEditor.notify(null);return;}
  rebindChestPart(rebuildStatus,request.part);redrawOverlay(true);return;
 }
 if(readOnly)throw new Error(readOnly);
 if(rebuildBusy)throw new Error('STAGE_DRAFT_STALE');
 const buildId=appliedOnStage?.buildId??'inspected';
 if(request.buildId!==buildId)throw new Error('STAGE_DRAFT_STALE');
 const priorPart=stageCorrectionPart??stageDraftSelection?.part??null,token=++stageDraftRequestToken;
 let status:RebuildStatusView|null=null;
 let mapping:{part:string;slot:string;skin:string;attachment:string}|undefined;
 if(inspectedModel){
  const stageData=await api<{sourceHash:string;draft?:{inspectionOnly?:boolean;buildId:string;mappings:{part:string;slot:string;skin:string;attachment:string}[]};draftUnavailable?:string}>('/api/stage-parts',{headers:{'X-Review-Stage-Build':buildId}});
  if(stageData.draft?.inspectionOnly)throw new Error('PARTS_VERDICT_READ_ONLY: Stage 1 draft is inspection-only');
  mapping=stageData.draft?.mappings.find(m=>m.part===request.part);
  if(!mapping||stageData.sourceHash!==request.sourceHash||stageData.draft?.buildId!==buildId||mapping.slot!==mapping.part)throw new Error(stageData.draftUnavailable??'STAGE_DRAFT_MISMATCH');
  status=rebuildStatus??await loadRebuildStatus();
  if(!status)throw new Error('REBUILD_STATUS_UNAVAILABLE');
  if(request.instrument==='chest'&&!status.parts.some(part=>part.name===mapping!.part))throw new Error(`REBUILD_PART_NOT_CONTOUR: ${mapping.part}`);
  if(token!==stageDraftRequestToken||rebuildBusy||(appliedOnStage?.buildId??'inspected')!==buildId)throw new Error('STAGE_DRAFT_STALE');
  pause();seek(0);showInspector('rig');
  parts?.select({side:'single',slot:mapping.slot,mode:'context'});
  const identity=parts?.value()?.identity;if(!identity||identity.skin!==mapping.skin||identity.attachment!==mapping.attachment)throw new Error('STAGE_DRAFT_MISMATCH');
  stageDraftSelection={part:mapping.part,slot:mapping.slot,skin:mapping.skin,attachment:mapping.attachment,sourceHash:stageData.sourceHash,buildId};
 }else{
  const expectedHash=buildId==='inspected'?data?.reviewedSource?.rig?.sha256??null:appliedOnStage?.buildId===buildId&&typeof appliedOnStage.modelHash==='string'?appliedOnStage.modelHash:null;
  const prepared=await prepareStageDraftBuild(buildId,expectedHash,{
   transition:{kind:'open',token,priorBuildId:buildId,priorPart,expectedPart:request.part,expectedSourceHash:request.sourceHash,instrument:request.instrument},
  });
  status=prepared.status;
  mapping=prepared.mapping;
  showInspector('rig');
 }
 if(request.instrument==='mesh'&&!layers.mesh){
  layers.mesh=true;
  const layerMesh=document.getElementById('layer-mesh') as HTMLInputElement|null;if(layerMesh)layerMesh.checked=true;
 }
 meshPanel?.select(mapping.part);
 rebindChestPart(status!,mapping.part);
 stageCorrectionPart=mapping.part;
 let label=document.getElementById('stage-draft-label');if(!label){label=document.createElement('p');label.id='stage-draft-label';label.setAttribute('data-i18n','Draft rig · structure evidence only');document.querySelector('.viewbar')?.prepend(label);}label.textContent=tr('Draft rig · structure evidence only');
 inspectorBlocks?.select('rig',request.instrument==='chest'?'chest-regions':request.instrument==='mesh'?'mesh-panel':'modeling-tools');
 if(request.instrument==='chest'&&button('chest-edit').getAttribute('aria-pressed')!=='true')button('chest-edit').click();
 if(request.instrument==='delta'&&button('mesh-edit').getAttribute('aria-pressed')!=='true')button('mesh-edit').click();
 redrawOverlay(true);
 message(tr('Draft rig · structure evidence only')+tr(` · ${mapping.part} · rig-parts remesh ${request.instrument==='delta'?'--delta':'--mesh'}`));
}

return {dispose:disposeScreen};
}

// Package entries mount directly; the live host invokes the rig composition for each publication.
if (!rigHost()) {
  const root = document.getElementById('app');
  if (root?.dataset.reviewScreen === 'compare') {
    root.innerHTML = renderCompareHtml();
    mountCompareScreen();
  }
  else if (root?.dataset.reviewScreen === 'workspace') mountOwnerWorkspace(root);
  else if (/^\/jobs\/[^/]+\/$/.test(location.pathname)) void mountJobScreen(document.body);
  else mountRigScreen();
}
