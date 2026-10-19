import {PartExplorer,loadPartCatalog} from './part-selection.ts';
import { loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraSignature} from './camera-view.ts';
import {rendererStatus} from './renderer-status.ts';
import {bindAppearance,bindPan,bindStageLayout,syncStageLayout,bindInspectorTabs,idleAvailable,initialIdleAnimation,automaticIdlePreview,bindLayerShortcuts,describeLayerToggles,type ViewPoint} from './view-controls.ts';
import {RigOverlays} from './rig-overlays.ts';
import {bindWorkspaceUI,type WorkspaceUI} from './workspace-ui.ts';
import {connectControl} from './control.ts';
import {pageInstanceAccess,readOnlyReason} from './instance-access.ts';
import {controlComparison,type ControlCommand,type ControlInspection,type ControlView} from '../src/control.ts';
import {singleEligibility,videoReferenceAt,type InputState,type SingleLayout} from '../src/comparison-eligibility.ts';
import {connectInspectionPersistence,serializableView,numericCamera,restoredZoom,restoreTransaction,captureInputs,restoreInputs,type InspectionBookmark,type InspectionBinding,type PersistenceConnection} from './inspection-persistence.ts';
import {initialPlayerAnimation} from '../src/animation-selection.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import type {ReferenceBinding} from '../src/reference.ts';
import type { Checkpoint, Reference, ReviewedSource, ReviewManifest } from '../src/manifest.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import type { ReportEvent, ReportSeeds } from '../src/report.ts';
import { clockForAnimation, frameAtTime, lastFrame as lastProducerFrame, timeAtFrame } from '../src/frame-clock.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection, type FeedbackCatalog } from '../src/feedback-validation.ts';
import { eventCoordinates, eventSeekTime, eventSelection, eventTimingLabel, reportCounts, reportDraftForMarker, targetLabel } from './report-view.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';

interface ReviewResponse { initialAnimation?:string|null; manifest: ReviewManifest; referenceBinding?:ReferenceBinding; explicitReference?:{id:string;name:string;sha256:string;url:string}; sourceHash: string; reviewedSource: ReviewedSource; report: ReportSeeds | null; feedbackCatalog: FeedbackCatalog; assetsBase: string; capabilities: { playback: boolean; modeling: false; motion: false; feedback: boolean; audio: boolean } }
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
const text = (id: string, value: string) => { el(id).textContent = value; };
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
let duration = 0;
let lastFrame = 0;
type CameraTarget='rig'|'reference';
let cameraSync=true,activeCamera:CameraTarget='rig',cameraRestoring=false,cameraLayout='';
const cameraFrames:Partial<Record<CameraTarget,CameraFrame>>={};
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
let overlays:RigOverlays|null=null;
let appearance:ReturnType<typeof bindAppearance>|null=null;
let workspace:WorkspaceUI|null=null;
let idleHeld=false;
let suspendedPreview=false;
let controlDispose:(()=>void)|null=null;
const viewDisposers:(()=>void)[]=[];
const layers={images:true,mesh:false,bones:false,meshOpacity:.65};
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

function message(value: string, error = false): void {
  text('message', value);
  el('message').title = value; // the footer truncates long messages
  el('message').classList.toggle('error', error);
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
  const end = duration > 0 ? ` / ${duration.toFixed(4)}` : '';
  text('time-label', sequence ? `Source ${(time + sequence.frames[0]!.t).toFixed(4)} ↔ ${time.toFixed(4)}${end} s` : `${time.toFixed(4)}${end} s`);
  input('scrub').max = String(Math.max(duration, .001)); input('scrub').value = String(time); input('scrub').disabled = duration <= 0;
  button('play').disabled = (!player && !video && !sequence) || duration <= 0;
  renderFrameTransport();
  renderFeedbackRange();
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
  const clock = activeFrameClock();
  const last = lastProducerFrame(clock), frame = frameAtTime(clock, time);
  el('frame-controls').hidden = last === null;
  if (!clock) { text('frame-label', data.report?.clock ? data.report.animation ? 'Frame unknown · report and current clip do not match' : 'Frame unknown · report animation not supplied' : 'rate unknown'); return; }
  if (last === null) { text('frame-label', 'F? / ? · frame range unknown'); return; }
  text('frame-label', `F${frame === null ? '?' : frame} / ${last}${frame === null ? ' · Out of range' : ''}`);
  text('frame-clock-label', clock.kind === 'uniform' ? `${clock.fps} fps · frame0 ${clock.frame0} s` : `frameTimes · ${clock.frameTimes.length} explicit times`);
  input('frame-number').max = String(last);
  if (document.activeElement !== input('frame-number')) input('frame-number').value = frame === null ? '' : String(frame);
  input('frame-scrub').max = String(last); input('frame-scrub').hidden = frame === null;
  if (frame !== null) input('frame-scrub').value = String(frame);
  input('frame-scrub').disabled = last === 0;
  el('frame-outside').hidden = frame !== null;
}

function activeFrameClock() {
  const active = player && player.current !== animation ? '' : animation;
  return clockForAnimation(data.report?.clock, data.report?.animation, active, !!player);
}

function seekFrame(frame: number): void {
  const exact = timeAtFrame(activeFrameClock(), frame);
  if (exact === null) { message('Select an integer frame within the explicit clock bounds.', true); renderFrameTransport(); return; }
  pause();
  if ((duration > 0 && exact > duration) || (video && video.readyState >= 1 && Number.isFinite(video.duration) && exact > video.duration)) { message(`F${frame} maps to ${exact} s, outside the current reference range. The requested time was not changed.`, true); renderFrameTransport(); return; }
  seek(exact);
  message(`F${frame} · Explicit time ${exact} s${!player && !video && !sequence ? ' (No playback reference · time display only)' : ''}`);
}

function drawRig(action:()=>void):void {
 try{action();parts?.present('single');text('renderer-state',rendererStatus(player?.renderer??null,'succeeded').label);redrawOverlay(true);}
 catch(error){overlays?.clear();text('renderer-state',rendererStatus(null,'failed').label);throw error;}
}

function chooseAnimation(name: string): void {
  pause(); animation = name; axisInspection = false; el('angle-panel').hidden = true;
  const runtimeAnimation = assets?.animations.find(item => item.name === name);
  duration = runtimeAnimation?.duration ?? data.manifest.animations.find(item => item.id === name)?.duration ?? 0;
  select('animation-select').value = name;
  if (player && runtimeAnimation) { drawRig(()=>{player!.play(name,{loop:false});player!.pause();player!.draw();}); }
  else if (player && name){text('renderer-state',rendererStatus(null,'failed').label);message(`Animation "${name}" is not present in the rig.`, true);}
  time = 0; renderTransport(); renderCues();renderIdle();
}

function seek(value: number): void {
  time = duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value);
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

function seekReportEvent(): void {
  const event = selectedReportEvent; if (!event) return;
  const exact = eventSeekTime(event, selectedReportTime); if (exact === null) return;
  pause();
  const reportAnimation = data.report?.animation;
  if (reportAnimation && player && !assets?.animations.some(item => item.name === reportAnimation)) { message(`Report animation "${reportAnimation}" is absent from the current rig; no seek was performed.`, true); return; }
  if (reportAnimation && assets?.animations.some(item => item.name === reportAnimation) && animation !== reportAnimation) chooseAnimation(reportAnimation);
  if (duration > 0 && exact > duration) { message(`Explicit time ${exact} s is outside the current range of ${duration} s. No substitute time was used.`, true); return; }
  seek(exact);
  message((player || video || sequence) ? `Selected report time ${exact} s.` : `Report time ${exact} s · no playback reference; time display only.`);
}

function tick(now: number): void {
  if (playing) {
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0;
    const previous = time; time = Math.min(duration, time + dt);
    if (player && player.current) { try { drawRig(()=>player!.frame(dt)); } catch (error) { pause(); message(errorText(error), true); } }
    if (video && video.readyState >= 1 && time > video.duration) { if (referenceInput.state !== 'out-of-domain') holdVideoReference(video, referenceGeneration); } else if (video && referenceInput.state === 'loaded' && Math.abs(video.currentTime - time) > .15) video.currentTime = time;
    if (input('sync-audio').checked) for (const cue of activeCues()) if ((previous < cue.time && cue.time <= time) || (previous === 0 && cue.time === 0 && dt > 0)) void audition(cue.clip);
    renderSequenceFrame(); renderTransport(); if(time>=duration){if(canRepeatIdle()&&!idleHeld){stopAudio();seek(0);player?.resume();if(video)void video.play().catch(error=>{pause();message(errorText(error),true);});}else pause();} lastFrame = now;
  }
  requestAnimationFrame(tick);
}

async function initPlayer(initialCheckpoint?:Checkpoint): Promise<void> {
  text('renderer-state',rendererStatus(null,'pending').label);
  if (!data.manifest.model) { text('player-state', 'No rig supplied · reference review is available'); return; }
  text('player-state', 'Loading compiled rig…');
  try {
    const modelUrl = new URL(assetUrl(data.manifest.model), location.href).href;
    assets = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, url) => {
      const target = new URL(name, url); if (target.origin !== location.origin || !target.pathname.startsWith(access.route('/assets/'))) throw new Error(`Model page escapes local package: ${name}`); return target.href;
    } });
    player = new RigPlayer(el('rig-root'), assets);
    // Parts inspection is an add-on: a catalog refusal is shown in the explorer and never aborts the rig.
    try{parts?.register('single',await loadPartCatalog(modelUrl,data.reviewedSource.rig!.sha256,data.feedbackCatalog.slots??[]),player);}catch(error){parts?.refuseCatalog('single',error);}
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
    describeLayerToggles(document,el('layer-state').textContent??'');
    fitCamera();
  } catch (error) { text('renderer-state',rendererStatus(null,'failed').label);player?.dispose(); player = null; assets?.dispose(); assets = null; text('player-state', 'Rig load failed'); text('rig-empty', `Could not open rig: ${errorText(error)}`); message(errorText(error), true); }
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
  const area = el('proposal-list'); area.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  warnings.textContent = session.feedbackWarnings.length ? `${session.feedbackWarnings.length} validation warnings in existing feedback · original records are preserved. Review the marked entries, delete them and add valid replacements before submitting. JSON and Markdown exports preserve both the original records and warnings.` : '';
  for (const feedback of session.feedback) {
    const item = document.createElement('div'); item.className = 'proposal-item'; const title = document.createElement('strong'); title.textContent = `${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const description = document.createElement('span'); description.textContent = feedback.summary;
    item.append(title, description);
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `Validation warning · ${warning.error}`; item.append(note); }
    const details = document.createElement('details'), summary = document.createElement('summary'), source = document.createElement('pre'); summary.textContent = 'Saved feedback and inspection context'; source.textContent = JSON.stringify(feedback, null, 2); details.append(summary, source);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.onclick = () => { session.feedback = session.feedback.filter(item => item.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); markDirty(); renderProposals(); };
    item.append(details, remove); area.append(item);
  }
  updateSavedState();
}

function propose(tool: string): void {
  if (tool === 'angle' && !input('axis-value').disabled) { showInspector('rig');chooseAxis(); return; }
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
        intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: 'single', frameStart: feedback.frameStart, frameEnd: feedback.frameEnd });
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

const markdown = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
function issueFields(feedback: Feedback): { title: string; body: string; labels: string[] } {
  const title = `[${feedback.category}] ${feedback.target.kind}:${feedback.target.name} F${feedback.frameStart}–${feedback.frameEnd} · ${feedback.summary}`;
  const body = [
    `- Package: ${markdown(session.id)} / ${markdown(session.revision)}`,
    `- Source hash: ${session.sourceHash}`, ...(session.referenceBinding?[`- Reference binding: ${JSON.stringify(session.referenceBinding)}`]:[]),
    `- Package revision: ${markdown(session.reviewedSource.packageRevision)}`,
    `- Viewer version: ${markdown(session.reviewedSource.viewerVersion)}`,
    `- Runtime version: ${markdown(session.reviewedSource.runtimeVersion)}`,
    `- Rig: ${session.reviewedSource.rig ? `${markdown(session.reviewedSource.rig.path)} / SHA-256 ${session.reviewedSource.rig.sha256}` : 'not supplied'}`,
    `- Motion: ${session.reviewedSource.motion ? `${markdown(session.reviewedSource.motion.path)} / SHA-256 ${session.reviewedSource.motion.sha256}` : 'not supplied'}`,
    `- Frames: ${feedback.frameStart}–${feedback.frameEnd} (inclusive; producer frame numbers; no inferred FPS)`,
    `- Target: ${feedback.target.kind} / ${markdown(feedback.target.name)}`,
    `- Category: ${feedback.category}`, '', markdown(feedback.summary), '', 'Inspection context:',
    ...JSON.stringify(feedback.context ?? null, null, 2).split('\n').map(line => '    ' + line),
    '', 'Validation warnings (must be corrected before submission):',
    ...JSON.stringify(session.feedbackWarnings.filter(warning => warning.id === feedback.id), null, 2).split('\n').map(line => '    ' + line),
  ].join('\n');
  return { title, body, labels: [feedback.category] };
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
  for (const id of ['strip-scope', 'strip-reference', 'strip-format']) select(id).onchange = () => stripStatus('Selection changed. Check the ranges, animation and reference video before downloading.');
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) item.onclick = () => setView(item.dataset.view as typeof view);
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
    session.feedback.push({ id: crypto.randomUUID(), frameStart, frameEnd, target, category: select('feedback-category').value as Feedback['category'], summary, context: {part:parts?.feedback()??null,
      interval: { frameStart, frameEnd, inclusive: true },
      checkpoint: checkpoint?.id ?? null, animation: selectedAnimation, time, frame: frameAtTime(activeFrameClock(), time),
      reference: select('reference-select').value || null, person: selectedPerson || null,
      sourceTime: sequence ? sequence.frames[0]!.t + time : time,
      camera: center ? { zoom, x: center.x, y: center.y, coordinateSystem: 'world-y-up' } : { zoom, coordinateSystem: 'reference-fit' },
      view:{...serializableView(numericView()),theme:appearance?.get()??'system',layers:{...layers}},
      axis: axisInspection ? { id: select('axis-select').value, value: Number(input('axis-value').value) } : null,
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
      await persistence?.submitted(saved);renderProvenance();
      message(dirty ? 'Changes were made during submission. Submit again.' : 'Submitted the selected review status, feedback and source provenance.');
    } catch (error) { message(`Submission failed: ${errorText(error)}`, true); } finally { saving = false; updateSavedState(); }
  };
  button('export').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ schema: 'rig-review-feedback/1', id: session.id, revision: session.revision, sourceHash: session.sourceHash, referenceBinding:session.referenceBinding, reviewedSource: session.reviewedSource, status: session.status, checkpoints: session.checkpoints, feedback: session.feedback, feedbackWarnings: session.feedbackWarnings, issues: session.feedback.map(issueFields) }, null, 2) + '\n', 'application/json'); message('Exported source provenance, feedback, validation warnings and issue fields as JSON. Source files remain unchanged.'); };
  button('export-markdown').onclick = () => { const content = [`# ${markdown(session.id)} review feedback`, '', 'Reviewed source:', ...JSON.stringify({ sourceHash: session.sourceHash, referenceBinding:session.referenceBinding, reviewedSource: session.reviewedSource }, null, 2).split('\n').map(line => '    ' + line), '', 'Validation warnings:', ...JSON.stringify(session.feedbackWarnings, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(item => { const issue = issueFields(item); return [`## ${markdown(issue.title)}`, '', issue.body, '', '---', '']; })].join('\n'); download(`${session.id}-issues.md`, content, 'text/markdown'); message('Exported source provenance, validation warnings and structured issue content as Markdown.'); };
  // Saved browser defaults seed a new inspection; explicit links and source drafts restore over them.
  workspace=bindWorkspaceUI({changed:fitCamera,defaultTheme:theme=>appearance?.set(theme)});
  cameraSync=workspace.defaults().defaultCameraSync;input('camera-sync').checked=cameraSync;input('idle-repeat').checked=workspace.defaults().defaultIdleRepeat;
  appearance=bindAppearance(select('appearance'),workspace.defaults().theme);
  overlays=new RigOverlays({canvas:el<HTMLCanvasElement>('rig-overlay'),rigRoot:el('rig-root')});
  viewDisposers.push(bindStageLayout(el('stage-layout'),fitCamera));
  for(const target of ['rig','reference'] as const)viewDisposers.push(bindPan(el(target+'-viewport'),(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy))));
  for(const [id,key] of [['layer-images','images'],['layer-mesh','mesh'],['layer-bones','bones']] as const)input(id).onchange=()=>{layers[key]=input(id).checked;redrawOverlay(false);};
  viewDisposers.push(bindLayerShortcuts(document));describeLayerToggles(document,el('layer-state').textContent??'');
  input('idle-repeat').onchange=()=>{renderIdle();if(canRepeatIdle())void playPreview();};
  for(const id of ['proposal-panel','checkpoint-detail'])el(id).addEventListener('focusin',pause);
  bindInspector();
  document.addEventListener('visibilitychange',()=>{if(document.hidden){const resume=playing;pause();suspendedPreview=resume;}else if(suspendedPreview){suspendedPreview=false;void playPreview();}});
  const resize = new ResizeObserver(fitCamera); resize.observe(el('rig-viewport')); resize.observe(el('reference-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { persistence?.dispose();workspace?.dispose();pause();controlDispose?.();appearance?.dispose();viewDisposers.forEach(dispose=>dispose());overlays?.dispose(); player?.dispose(); assets?.dispose(); resize.disconnect(); });
}

async function start(): Promise<void> {
  try {
    let writes: { capabilityRequired: boolean };
    [data, session, writes] = await Promise.all([api<ReviewResponse>('/api/review'), api<ReviewSession>('/api/session'), api<{ capabilityRequired: boolean }>('/api/access')]);
    readOnly = readOnlyReason(access, writes.capabilityRequired);
    submittedBaseline=structuredClone(session);
    text('package-title', data.manifest.title); text('revision', data.manifest.revision); document.title = `${data.manifest.title} · rig review`; text('source-hash', `source ${data.sourceHash.slice(0, 12)}`); select('review-status').value = session.status; select('feedback-target-kind').value = 'rig'; input('feedback-target-name').value = data.manifest.id;
    select('reference-select').replaceChildren(); for (const reference of data.manifest.references) select('reference-select').append(option(reference.id, `${reference.label} · ${reference.type}`));
    for (const reference of data.manifest.references.filter(item => item.type === 'video')) select('strip-reference').append(option(reference.id, reference.label));
    if (!data.manifest.references.length) { select('reference-select').append(option('', 'No references supplied')); select('reference-select').disabled = true; }
    // Checkpoints and reference fold away when the package supplies neither.
    (el('package-context') as HTMLDetailsElement).open = data.manifest.checkpoints.length > 0 || data.manifest.references.length > 0;
    const sourceFiles = el('source-files'); for (const file of data.manifest.authoring) { const a = document.createElement('a'); a.href = assetUrl(file.path); a.textContent = file.label; a.className = 'source-link'; a.target = '_blank'; a.rel = 'noopener'; sourceFiles.append(a); } if (!data.manifest.authoring.length) sourceFiles.textContent = 'No source files supplied';
    bind(); parts=new PartExplorer(el('parts-explorer'),el('selected-part'),previous=>{redrawOverlay(true);const part=parts?.value();if(part){activeCamera='rig';if(view==='reference')setView('rig');showInspector('rig');renderCameraControls();}if(!cameraRestoring&&(previous?.side!==part?.side||previous?.slot!==part?.slot))cameraAction(()=>fitActiveCamera(part?'rig':availableCamera()));persistence?.save();},part=>{select('feedback-target-kind').value='slot';renderFeedbackTargets(true);input('feedback-target-name').value=part.slot;showInspector('feedback');}); updateStripControls(); stripStatus('Choose the entered start–end frames or all feedback ranges to download. Unsubmitted feedback is included; exporting does not submit the review.'); renderFeedbackTargets(true); renderFeedbackRange(); renderCheckpoints(); renderProposals(); renderProvenance(); updateSavedState(); renderCues(); initReport();
    const requestedId = new URLSearchParams(location.search).get('checkpoint'),initial=initialReviewSelection(data.manifest,requestedId,data.explicitReference?.id,data.initialAnimation??undefined),first=initial.checkpoint;
    rigInput=data.manifest.model?{state:'pending'}:{state:'absent'};renderLayout();
    if(initial.referenceId){select('reference-select').value=initial.referenceId;await showReference(initial.referenceId);}
    await initPlayer(first);
    // initPlayer keeps `player` only after its first draw succeeded; a declared model path alone never counts.
    rigInput=player?{state:'loaded'}:data.manifest.model?{state:'failed',reason:el('rig-empty').textContent||'compiled player unavailable'}:{state:'absent'};renderLayout();
    if (first) await chooseCheckpoint(first,initial); else renderCheckpoint();
    activeCamera=player?'rig':'reference';if(cameraSync)alignCameras();renderTransport();fitCamera();
    if (requestedId && !first) message(`Checkpoint "${requestedId}" is not in this package. Select one from the list.`, true);
    else if (readOnly) message(readOnly, true);
    else message(data.manifest.model ? 'Record review status and structured feedback while preserving sources. Motion is read only.' : 'No rig supplied. Review the available references and checkpoints.');
    requestAnimationFrame(tick);
    const restored=await setupPersistence();renderIdle();if(!restored&&canRepeatIdle()&&automaticIdlePreview(assets?.animations.map(item=>item.name)??[],animation,first,!!requestedId))void playPreview();
    if(!readOnly)controlDispose=connectControl({sourceHash:data.sourceHash,mode:'single',route:access.route,headers:()=>access.headers(),observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
  } catch (error) { message(`Could not open review package: ${errorText(error)}`, true); text('dirty', 'Load failed'); }
}
function showInspector(name:string,reveal=true):void {if(reveal)workspace?.revealInspector();document.querySelector<HTMLButtonElement>(`[data-inspector="${name}"]`)?.click();}
function bindInspector():void {bindInspectorTabs(()=>{workspace?.afterTab();if(document.querySelector('[data-inspector="feedback"][aria-selected="true"]'))pause();fitCamera();},()=>workspace?.beforeTab());}

function redrawOverlay(fresh:boolean):void {
 if(!overlays||!player)return;
 const root=el('rig-root'),project=(x:number,y:number)=>({x:parseFloat(root.style.left||'0')+x*rigScale,y:parseFloat(root.style.top||'0')-y*rigScale});
 const value=fresh?overlays.refresh({player,frame:parts?.frame('single'),selectedSlot:parts?.value()?.slot,bones:(data.feedbackCatalog.bones??[]).map(name=>({name})),project,settings:layers}):overlays.redraw({project,settings:layers});
 text('layer-state',value.warnings.join(' · ')||'Actual last-drawn mesh edges / bone points');if(!fresh&&value.needsCapture&&!playing&&!seekingControl)drawRig(()=>player!.draw());
}
function canRepeatIdle():boolean{return !!player&&idleAvailable(assets?.animations.map(a=>a.name)??[],animation)&&!axisInspection&&input('idle-repeat').checked&&duration>0;}
function renderIdle():void {text('idle-state',canRepeatIdle()?'Actual idle · repeat enabled':animation==='idle'?'Idle repeat paused':'Non-idle inspection · no automatic playback');}
async function playPreview():Promise<void> {
 if((!player&&!video&&!sequence)||duration<=0)return;
 const intent=++playbackIntent;desiredPlay=true;idleHeld=false;if(time>=duration)seek(0);
 if(video&&referenceInput.state==='loaded'){try{await video.play();}catch(error){pause();message(`Playback is paused: ${errorText(error)}. Use Play to retry.`,true);return;}}
 if(intent!==playbackIntent||!desiredPlay){if(!desiredPlay)video?.pause();return;}playing=true;lastFrame=0;player?.resume();button('play').textContent='Ⅱ';button('play').setAttribute('aria-label','Pause');
}
function localDraft():boolean{return dirty||!!input('feedback-summary').value.trim()||!!input('feedback-start').value.trim()||!!input('feedback-end').value.trim()||!!select('feedback-category').value||!!input('feedback-target-name').value.trim()&&input('feedback-target-name').value!==data.manifest.id;}
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
async function inspectControlTime(target:number,signal:AbortSignal):Promise<void> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 const media=video;
 if(!media){if(player){player.seek(target);drawRig(()=>player!.draw());}time=target;renderSequenceFrame();renderTransport();return;}
 if(media.readyState<1||target>media.duration)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');
 const previousPosition=media.currentTime;
 const commit=(actual:number)=>{
  if(signal.aborted||media!==video)throw new Error('CONTROL_SUPERSEDED');
  if(!Number.isFinite(actual)||actual<0||actual>duration)throw new Error('CONTROL_TIME_OUTSIDE_DOMAIN');
  if(player){player.seek(actual);drawRig(()=>player!.draw());}time=actual;
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
function inspectionBookmark():InspectionBookmark {return {schema:'rig-review-inspection/1',binding:inspectionBinding(),animation:animation||null,time:player?.time??time,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:layers.bones},view:numericView(),selection:{part:parts?.value()??null,view,checkpoint:checkpoint?.id??null,reference:select('reference-select').value||null,person:selectedPerson||null,inspector:document.querySelector<HTMLElement>('[data-inspector][aria-selected=true]')?.dataset.inspector??'view',partSet:select('part-set').disabled?null:select('part-set').value,axis:axisInspection?{id:select('axis-select').value,value:Number(input('axis-value').value)}:null}};}
async function restoreInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 await restoreTransaction(()=>prepareInspection(bookmark,signal),()=>({bookmark:inspectionBookmark(),inputs:captureInputs()}),()=>applyInspection(bookmark,signal),async previous=>{await applyInspection(previous.bookmark,new AbortController().signal);restoreInputs(previous.inputs);renderFeedbackRange();});
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
async function applyInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 cameraRestoring=true;try{
 const selection=bookmark.selection;
 parts?.select(selection.part??null);
 pause();
 if(selection.checkpoint!==undefined){checkpoint=data.manifest.checkpoints.find(c=>c.id===selection.checkpoint);renderCheckpoint();renderCheckpoints();}
 if(selection.reference!==undefined&&select('reference-select').value!==(selection.reference??'')){select('reference-select').value=selection.reference??'';await showReference(selection.reference??'');if(selection.reference&&!referenceSize&& !video)throw new Error('Saved reference did not load');}
 if(bookmark.animation&&player)chooseAnimation(bookmark.animation);
 if(selection.axis){select('axis-select').value=selection.axis.id;chooseAxis();input('axis-value').value=String(selection.axis.value);applyAxis();}
 if(selection.partSet!==undefined&&player){if(selection.partSet||player.sets().length)player.setSet(selection.partSet||null);select('part-set').value=selection.partSet??'';}
 if(bookmark.time!==null){if(video&&video.readyState<1)await waitReferenceMetadata(video,signal);await inspectControlTime(bookmark.time,signal);}
 if(selection.person!==undefined){selectedPerson=selection.person??'';select('person-select').value=selectedPerson;lastPoseFrame=-1;renderSequenceFrame();}
 if(selection.view)setView(selection.view);
 appearance?.set(bookmark.theme);
 Object.assign(layers,{images:bookmark.layers.images,mesh:bookmark.layers.meshes,bones:bookmark.layers.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;
 if(selection.inspector)showInspector(selection.inspector,false);syncStageLayout(el('stage-layout'));fitCamera();
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
 persistence=await connectInspectionPersistence({scope:'single:'+data.manifest.id+':'+data.sourceHash,binding:inspectionBinding(),baseline:submittedBaseline!,session:()=>session,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{session=value;dirty=isDirty;select('review-status').value=session.status;renderProposals();renderCheckpoint();renderCheckpoints();updateSavedState();},bookmark:inspectionBookmark,restoreBookmark:restoreInspection,
 ui:()=>({inspectorScroll:workspace?.scroll()??'{}',reportCategory:select('report-category').value,reportPage,reportEvent:selectedReportEvent?.id??null,reportTime:selectedReportTime??null,reportTarget:selectedReportTarget??null}),restoreUI:value=>{if(typeof value.reportCategory==='string'&&[...select('report-category').options].some(o=>o.value===value.reportCategory))select('report-category').value=value.reportCategory;if(typeof value.reportPage==='number'&&Number.isSafeInteger(value.reportPage)&&value.reportPage>=0)reportPage=value.reportPage;selectedReportEvent=typeof value.reportEvent==='string'?data.report?.categories.flatMap(c=>c.events).find(e=>e.id===value.reportEvent)??null:null;selectedReportTime=typeof value.reportTime==='number'?value.reportTime:undefined;selectedReportTarget=typeof value.reportTarget==='number'?value.reportTarget:undefined;renderReportEvents();renderReportSelection();workspace?.restoreScroll(value.inspectorScroll);},afterInputs:()=>{const target=input('feedback-target-name').value;renderFeedbackTargets(true);if(select('feedback-target-kind').value!=='rig')input('feedback-target-name').value=target;renderFeedbackRange();text('audio-volume-label',`${Math.round(Number(input('audio-volume').value)*100)}%`);},onConflict:value=>{draftConflict=value;updateSavedState();},onStatus:value=>{text('draft-state',value);el('draft-state').title=value;}});
 return persistence.restored;
}
void start();
