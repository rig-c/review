import {requireFeedbackFrames} from '../src/stage-comment.ts';
import {bindStageComments,type CommentPose} from './stage-comments.ts';
import {sharedTurnDials,type TurnDial} from '../src/turn-pad.ts';
import {bindTurnPad,type TurnPad} from './turn-pad.ts';
import {PartExplorer,loadPartModel} from './part-selection.ts';
import {PartThumbnails,pageRegionTable} from './part-thumbnails.ts';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraSignature,type PaneCamera} from './camera-view.ts';
import { CanvasRenderer, loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import type { CompareResponse, CompareSide } from '../src/compare.ts';
import type { CompareFeedback, CompareSession } from '../src/compare-session.ts';
import { clockForAnimation, lastFrame, timeAtFrame } from '../src/frame-clock.ts';
import { commonDomain, drawSynchronizedPair, compareSeekStep, feedbackTrace, inspectionFrame, requireCommonTime, type InspectionPlayer, type CompareDomain, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection } from '../src/feedback-validation.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';

import {bindAppearance,bindPan,bindStageLayout,bindInspectorTabs,syncStageLayout,idleAvailable} from './view-controls.ts';
import {RigOverlays} from './rig-overlays.ts';
import {bindWorkspaceUI,type WorkspaceUI} from './workspace-ui.ts';
import {connectControl} from './control.ts';
import {connectLiveWindow} from './live-connection.ts';
import {pageInstanceAccess,readOnlyReason} from './instance-access.ts';
import {controlComparison,type ControlCommand,type ControlInspection,type ControlView} from '../src/control.ts';
import {pairEligibility,type InputState,type PairDomain} from '../src/comparison-eligibility.ts';
import {parseBookmark,connectInspectionPersistence,serializableView,numericCamera,restoredZoom,restoreTransaction,captureInputs,restoreInputs,type InspectionBookmark,type InspectionBinding,type PersistenceConnection} from './inspection-persistence.ts';
import {RendererBadge} from './renderer-status.ts';
import {ComparePresentation,type PresentationState} from '../src/compare-presentation.ts';
import {nextReferenceInterval,ReferenceSelectionUnavailable,inspectionReferenceFrame,lastSupportedReferenceFrame,producerFrameAssociations,referenceFrameAtTime,referenceSeekPosition,type ReferenceFrameIndex,type VideoInfo,type VideoFrame} from '../src/reference-frames.ts';
import {mountComparePickedTools,type ComparePickedTools} from './compare-picked-tools.ts';
import {appliedCheckRefusal} from '../src/applied-context.ts';
type Side = 'a' | 'b';
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing compare UI element: ${id}`); return node as T;
};
const input = (id: string) => el<HTMLInputElement>(id), select = (id: string) => el<HTMLSelectElement>(id), button = (id: string) => el<HTMLButtonElement>(id);
const titledIds = new Set(['reference-time', 'a-time', 'b-time', 'a-frame', 'b-frame', 'a-renderer', 'b-renderer', 'reference-name', 'a-title', 'b-title', 'message']);
const text = (id: string, value: string) => { const node = el(id); node.textContent = value; if (titledIds.has(id)) node.title = value; };
const describe = (value: unknown) => value instanceof Error ? value.message : String(value);
const video = el<HTMLVideoElement>('reference-video');
let data: CompareResponse, session: CompareSession;
const assets: Partial<Record<Side, ModelAssets>> = {}, players: Partial<Record<Side, RigPlayer>> = {};
let domain: CompareDomain | null = null, trace: CompareTrace | null = null, lastPresented: ReferenceSample | null = null;
let dirty = false, saving = false, ready = false, seeking = false, disposed = false;
let seekAbort: AbortController | null = null, videoCallback: number | null = null, fallbackCallback: number | null = null;
let latestSeek = 0;
type CameraTarget=Side|'reference';
const cameras:Record<CameraTarget,PaneCamera>={a:{zoom:1,center:null},b:{zoom:1,center:null},reference:{zoom:1,center:null}};
const cameraFrames:Partial<Record<CameraTarget,CameraFrame>>={};
const rigScales:Record<Side,number>={a:1,b:1};
let cameraSync=true,activeCamera:CameraTarget='a',cameraRestoring=false,cameraLayout='';
let idleHeld=true,loopRestarting=false,suspendedPreview=false;
let appearance:ReturnType<typeof bindAppearance>|null=null,controlDispose:(()=>void)|null=null,workspace:WorkspaceUI|null=null;
const viewDisposers:(()=>void)[]=[];
let parts:PartExplorer|null=null,turnPad:TurnPad|null=null;
const thumbnails:Partial<Record<Side,PartThumbnails>>={};
let comments:ReturnType<typeof bindStageComments>|null=null;
let pickedTools:ComparePickedTools|null=null;
const turnAdjusts:Partial<Record<Side,import('@rig-c/play').BoneAdjust|null>>={};
const overlays:Partial<Record<Side,RigOverlays>>={};
function inspectionPlayer(side:Side,mode:'present'|'settle'|'seek'='seek'):InspectionPlayer {const player=players[side];if(!player)throw new Error('Part player unavailable');return {get time(){return player.time;},pause:()=>player.pause(),seek:time=>{if(typeof pickedTools!=='undefined'&&pickedTools)pickedTools.stepSide(mode,side,time);else player.seek(time);},draw:()=>{player.draw();parts?.present(side);}};}
const layers={images:true,mesh:false,bones:false,meshOpacity:.65};
let stripBusy = false;
let persistence:PersistenceConnection|null=null,submittedBaseline:CompareSession|null=null,draftConflict=false;
// First, before any URL use: take the `#cap=` handoff into memory/session storage and strip it.
const access=pageInstanceAccess();connectLiveWindow(access);let readOnly:string|null=null;
/** Whether this instance serves agent control (`/api/access`); a plain open is never probed for it (#164). */
let controlServed=true;
let referenceFrames:VideoInfo|null=null;
const presentation=new ComparePresentation();
const rendererBadges={a:new RendererBadge(),b:new RendererBadge()};
const associations:Record<Side,Map<number,number|null>>={a:new Map(),b:new Map()};
let requestedProducer:{side:Side;frame:number;time:number}|null=null;
let endStopReason:string|null=null;
// Actual load outcomes per input; the shared domain exists only after all three loaded.
let pairInputs:{a:InputState;b:InputState;reference:InputState;domain:PairDomain}={a:{state:'pending'},b:{state:'pending'},reference:{state:'pending'},domain:null};
const traceRows: CompareTrace[] = [];

function message(value: string, error = false): void { text('message', value); el('message').classList.toggle('error', error); }
function savedState(): void { text('save-state', dirty ? 'Unsubmitted changes' : session.updatedAt ? 'Submitted' : 'Not submitted'); el('save-state').classList.toggle('dirty', dirty); button('submit').disabled = saving || draftConflict || !!readOnly || session.feedbackWarnings.length > 0; button('submit').title = readOnly ? readOnly : session.feedbackWarnings.length ? 'Delete feedback with validation warnings, then add it again with a valid target.' : ''; }
function markDirty(): void { dirty = true; savedState(); }
async function api<T>(path: string, init?: RequestInit): Promise<T> { const method = (init?.method ?? 'GET').toUpperCase(); const response = await fetch(access.route(path), method === 'GET' || method === 'HEAD' ? init : { ...init, headers: access.headers(init?.headers) }); if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); return await response.json() as T; }

function sideAsset(side: Side, path: string): string {
  if (!path || path.startsWith('/') || /[\\%?#\x00-\x1f:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid ${side} asset path: ${path}`);
  const base = `/compare-assets/${side}/`;
  if (data[side].assetsBase !== base) throw new Error(`Unexpected ${side} assets base`);
  return access.route(base + path.split('/').map(encodeURIComponent).join('/'));
}

function currentFrame(side: Side): number | null {
  const player = players[side];
  const clock = clockForAnimation(data[side].report?.clock, data[side].report?.animation, player?.current ?? '', !!player);
  return inspectionFrame(clock, feedbackTrace(ready, seeking || video.seeking, trace));
}

function currentReviewFrame(side:Side):number|null {
 if(!referenceFrames||!trace)return null;
 const frame=referenceFrameAtTime(referenceFrames,trace.reference);return frame?associations[side].get(frame.index)??null:null;
}
function frameLabel(side: Side): string {
 const sideData=data[side],player=players[side],clock=clockForAnimation(sideData.report?.clock,sideData.report?.animation,player?.current??'',!!player);
 if(!clock)return 'Review frame unknown';
 const frame=currentReviewFrame(side),decoded=referenceFrames&&trace?referenceFrameAtTime(referenceFrames,trace.reference):null;
 return `Review F${frame??'—'} / ${lastFrame(clock)??'—'}${decoded?` · video #${decoded.index}`:''}`;
}
function frameControls():void {
 const exact=!!referenceFrames&&typeof video.requestVideoFrameCallback==='function';
 for(const side of ['a','b'] as const){const option=select('frame-basis').querySelector<HTMLOptionElement>(`option[value="${side}"]`);if(option)option.disabled=!associations[side].size;}
 const side=select('frame-basis').value as Side,clock=data[side]?.report?.clock;
 input('frame-input').max=String(lastFrame(clock)??0);input('frame-input').disabled=!exact||!clock||!ready||seeking;button('frame-seek').disabled=!exact||!clock||!ready||seeking;
}

function renderTrace(value: CompareTrace): void {
  trace = value; traceRows.push({ ...value }); if (traceRows.length > 12) traceRows.shift();
  text('reference-time', `${value.reference.toFixed(6)} s`);
  for (const side of ['a', 'b'] as const) { text(`${side}-time`, `${value[side].toFixed(6)} s`); text(`${side}-frame`, frameLabel(side)); }
  text('time', `${value.reference.toFixed(4)} / ${domain!.end.toFixed(4)} s`);
  if (document.activeElement !== input('scrub')) input('scrub').value = String(value.reference);
  if (document.activeElement !== input('time-input')) input('time-input').value = value.reference.toFixed(6);
  text('clock-source', value.source === 'video-frame' ? 'requestVideoFrameCallback · Actual mediaTime' : 'currentTime fallback');
  text('trace', JSON.stringify({ seekStep: compareSeekStep, referenceClock: value.source, frames: { a: currentFrame('a'), b: currentFrame('b') }, reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')}, requestedProducer,endStopReason, decodedIndex:referenceFrames?referenceFrameAtTime(referenceFrames,value.reference)?.index??null:null, recent: traceRows }, null, 2));
  updateFeedbackAvailability();frameControls();pickedTools?.onPosePresented();
}

function updateFeedbackAvailability(): void { button('add-feedback').disabled = !feedbackTrace(ready, seeking || video.seeking, trace); }
function invalidateTrace(reason: string): void {
  for(const side of ['a','b'] as const)text(`${side}-renderer`,rendererBadges[side].pending().label);
  trace = null; updateFeedbackAvailability();
  for (const id of ['reference-time', 'a-time', 'b-time']) text(id, '— s');
  for (const side of ['a', 'b'] as const) text(`${side}-frame`, 'Frame unknown · not synchronized');
  text('time', '— / — s'); text('clock-source', reason);
  text('trace', JSON.stringify({ status: reason, current: null, previous: traceRows }, null, 2));
}

function stop(): void { video.pause(); players.a?.pause(); players.b?.pause(); button('play').textContent = loopRestarting&&!idleHeld?'Ⅱ':'▶'; button('play').setAttribute('aria-label',loopRestarting&&!idleHeld?'Cancel idle restart and pause comparison':'Play reference video and both rigs'); }
function failPair(error: unknown): void { stop(); ready = false; invalidateTrace('Comparison stopped · no valid synchronized time');for(const side of ['a','b'] as const){overlays[side]?.clear();text(`${side}-renderer`,rendererBadges[side].failed().label);} button('play').disabled = true; input('scrub').disabled = true; button('seek').disabled = true;button('frame-seek').disabled=true; message(`Comparison stopped: ${describe(error)}`, true); }

function renderPresentation(state:PresentationState):void {
 for(const side of ['a','b'] as const){const value=rendererBadges[side].observe(state.status,players[side]?.renderer??null);text(`${side}-renderer`,value.label);}
 if(state.status==='drawn')redrawOverlays(true);else if(state.status==='failed')for(const overlay of Object.values(overlays))overlay.clear();
 const target=state.target?.time,last=state.lastDrawn;
 if(target!==undefined){text('reference-time',`${target.toFixed(6)} s`);text('time',`${target.toFixed(4)} / ${domain!.end.toFixed(4)} s`);input('scrub').value=String(target);}
 const delta=target===undefined||!last?null:Math.max(Math.abs(last.a-target),Math.abs(last.b-target))*24;
 const visible=last?`${last.reference.toFixed(6)} s`:'unknown';
 text('sync-status',`${state.status==='held'?'Held':state.status==='drawn'?(state.lastLatenessMs>0?'Drawn late':'Drawn'):'Unknown'} pose ${visible} · Δ ${delta===null?'—':delta.toFixed(2)} (1/24 s units) · dropped ${state.dropped} · deadline misses ${state.deadlineMisses}/${state.deadlineKnownCallbacks} known next-reference estimates (${state.deadlineUnknownCallbacks} unknown) · replay ${state.lastPoseMs.toFixed(1)} ms · lateness ${state.deadlineKind==='unknown'?'unknown':state.lastLatenessMs.toFixed(1)+' ms'} (next-reference estimate; CPU submission)`);
 el('sync-status').classList.toggle('error',state.status==='held'||state.lastLatenessMs>0||state.status==='failed');
 if(!state.inspection){
  trace=null;updateFeedbackAvailability();
  for(const side of ['a','b'] as const){text(`${side}-time`,last?`${last[side].toFixed(6)} s`:'— s');const decoded=last&&referenceFrames?referenceFrameAtTime(referenceFrames,last.reference):null,frame=decoded?associations[side].get(decoded.index)??null:null;text(`${side}-frame`,last?`${state.status==='held'?'Held':'Drawn; feedback unavailable'} · review F${frame??'—'}`:'Review frame unknown');}
  text('clock-source','Feedback requires a pair submitted before the known next-reference estimate or paused inspection.');
 }
 text('sync-warning',state.deadlineKind==='unknown'?'Next-reference timing unknown: an adjacent decoded timestamp and positive playback rate are required. Playback continues; pause for exact inspection.':state.lastLatenessMs>0?'The pair finished CPU draw submission after the estimated next reference display boundary. Pause for exact inspection.':'');
 text('trace',JSON.stringify({presentation:state,playerTimes:{a:players.a?.time??null,b:players.b?.time??null},rawFloorFrames:{a:currentFrame('a'),b:currentFrame('b')},reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')},requestedProducer,endStopReason,renderers:{a:rendererBadges.a.snapshot(),b:rendererBadges.b.snapshot()},decodedIndex:referenceFrames&&target!==undefined?referenceFrameAtTime(referenceFrames,target)?.index??null:null},null,2));
 frameControls();
}
function acceptReference(sample: ReferenceSample,deadline:number|null=null,presentedFrames:number|null=null): void {
 if(!ready||seeking||video.seeking||!domain||!players.a||!players.b)return;
 if(sample.time>domain.end){stopAtSupportedEnd();return;}
 if(trace?.reference===sample.time&&trace.source===sample.source)return;
 try{const state=presentation.present(sample,deadline,presentedFrames,inspectionPlayer('a','present'),inspectionPlayer('b','present'),domain,()=>performance.now(),nextReferenceInterval(referenceFrames,sample.time,video.playbackRate));if(state.inspection)renderTrace(state.inspection);renderPresentation(state);}catch(error){failPair(error);renderPresentation(presentation.snapshot());}
}

function stopAtSupportedEnd():void {
 if(canRepeatIdle()&&!idleHeld&&!document.hidden){void restartIdle();return;}
 stop();requestedProducer=null;
 if(!domain)return;
 const selected=referenceFrames&&typeof video.requestVideoFrameCallback==='function'?lastSupportedReferenceFrame(referenceFrames,domain):null;
 if(selected){const reason=`Playback stopped at the last supported decoded reference frame: ${selected.time.toFixed(6)} s (shared clip end ${domain.end.toFixed(6)} s).`;void seekTo(selected.time,null,reason);}
 else{endStopReason='Playback stopped outside the shared clip domain. Exact reference selection is unavailable; choose a supported time to inspect again.';invalidateTrace(endStopReason);text('sync-warning',endStopReason);message(endStopReason);frameControls();}
}

function observeVideoFrames(): void {
  if (typeof video.requestVideoFrameCallback === 'function') {
    const next = () => { videoCallback = video.requestVideoFrameCallback((_now, metadata) => {
      if (disposed) return;
      lastPresented = { time: metadata.mediaTime, source: 'video-frame' };
      acceptReference(lastPresented,metadata.expectedDisplayTime,metadata.presentedFrames); next();
    }); }; next();
  } else {
    // This is a media-clock sampler, not an elapsed-time animation loop. The
    // only time sent to either player is the reference element's currentTime.
    const next = () => { if (disposed) return; acceptReference({ time: video.currentTime, source: 'current-time' }); fallbackCallback = requestAnimationFrame(next); }; next();
  }
}

/** On supported browsers a seek waits for BOTH seeked and the decoded frame. */
function seekReferenceFrame(target: number, signal: AbortSignal,selected:VideoFrame|null): Promise<ReferenceSample> {
  video.pause();
  const seekPosition=selected?referenceSeekPosition(referenceFrames!,selected):target;
  if(!video.seeking&&lastPresented&&(selected?referenceFrameAtTime(referenceFrames!,lastPresented.time)?.index===selected.index:video.currentTime===target))return Promise.resolve({...lastPresented});
  return new Promise((resolve, reject) => {
    let seeked = false, presented: ReferenceSample | null = null, handle: number | null = null;
    const hasFrames = typeof video.requestVideoFrameCallback === 'function';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for reference video seek / decoded-frame response.')), 10000);
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', onError); signal.removeEventListener('abort', onAbort); if (handle !== null) video.cancelVideoFrameCallback(handle); };
    const finish = (error?: Error) => { if (error) { cleanup(); reject(error); } else if (seeked && presented) { cleanup(); resolve(presented); } };
    const onSeeked = () => { seeked = true; if (!hasFrames) presented = { time: video.currentTime, source: 'current-time' }; finish(); };
    const onError = () => finish(new Error('Reference video seek failed'));
    const onAbort = () => finish(new DOMException('Newer reference seek requested', 'AbortError'));
    if (signal.aborted) { finish(new DOMException('Reference seek aborted', 'AbortError')); return; }
    signal.addEventListener('abort', onAbort, { once: true }); video.addEventListener('seeked', onSeeked); video.addEventListener('error', onError, { once: true });
    try {
      // Registered while paused before changing currentTime, so a fast seek
      // cannot present its new frame before this callback is installed.
      if (hasFrames) handle = video.requestVideoFrameCallback((_now, metadata) => { handle = null; const actual=selected?referenceFrameAtTime(referenceFrames!,metadata.mediaTime):null;if(selected&&actual?.index!==selected.index){finish(new ReferenceSelectionUnavailable('REFERENCE_FRAME_MISMATCH: decoded frame does not match selected reference PTS; choose another supported time to inspect'));return;}presented = { time: metadata.mediaTime, source: 'video-frame' }; finish(); });
      video.currentTime = seekPosition;
      if (!video.seeking) { seeked = true; if (!hasFrames) presented = { time: video.currentTime, source: 'current-time' }; finish(); }
    } catch (error) { finish(new Error(describe(error))); }
  });
}

async function seekTo(target: number,producer:{side:Side;frame:number;time:number}|null=null,endReason:string|null=null,continuing=false): Promise<void> {
  if (!domain || !players.a || !players.b || !ready) return;
  if(!continuing)idleHeld=true;
  let selected:VideoFrame|null=null;
  try { requireCommonTime(target, domain);if(referenceFrames&&typeof video.requestVideoFrameCallback==='function')selected=inspectionReferenceFrame(referenceFrames,target,domain); } catch (error) { message(describe(error), true); return; }
  stop(); seekAbort?.abort(); seekAbort = new AbortController(); const signal = seekAbort.signal, generation = ++latestSeek; seeking = true; invalidateTrace('Synchronizing reference video and both rigs');
  try {
    const sample=await seekReferenceFrame(target,signal,selected);
    if(signal.aborted||generation!==latestSeek)throw new DOMException('Reference seek superseded','AbortError');
    if(sample.time<domain.start||sample.time>domain.end)throw new ReferenceSelectionUnavailable('the presented reference timestamp is outside the shared clip domain; choose a supported time');
    const tools=typeof pickedTools!=='undefined'?pickedTools:null,seekMode=tools?tools.seekMode(sample.time,continuing):'seek';
    const inspected=presentation.inspect(sample,inspectionPlayer('a',seekMode),inspectionPlayer('b',seekMode),domain,()=>performance.now());
    const value=inspected.inspection!;
    if (generation !== latestSeek || signal.aborted) return;
    requestedProducer=producer;endStopReason=endReason;seeking = false; lastPresented = { time: value.reference, source: value.source }; renderTrace(value);renderPresentation(inspected);
    message(endReason??((typeof pickedTools!=='undefined'&&pickedTools?pickedTools.defaultStatusMessage():null)??'Inspecting both rigs at the actual reference video time.'));
  } catch (error) { if (!signal.aborted && generation === latestSeek){if(error instanceof ReferenceSelectionUnavailable){stop();invalidateTrace(describe(error));message(describe(error),true);}else failPair(error);} }
  finally { if (generation === latestSeek) { seeking = false; updateFeedbackAvailability();frameControls(); } }
}

function unionBounds(a: PoseBounds, b: PoseBounds): PoseBounds { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; }
function fit(): void {
 const layout=['a','b','reference'].map(target=>{const v=el(target+'-viewport');return `${v.clientWidth}:${v.clientHeight}`;}).join('|')+!!players.a+!!players.b+video.videoWidth+':'+video.videoHeight;
 if(cameraSync&&!cameraRestoring&&layout!==cameraLayout)alignCameras();cameraLayout=layout;
 for(const side of ['a','b'] as const){
  const frame=paneFrame(side);if(!frame)continue;const camera=cameras[side],center=camera.center??frame.center,scale=rigScales[side]=frame.baseScale*camera.zoom;
  const viewport=el(side+'-viewport'),root=el(side+'-root');root.style.left=`${viewport.clientWidth/2-center.x*scale}px`;root.style.top=`${viewport.clientHeight/2+center.y*scale}px`;root.style.transform=`scale(${scale})`;players[side]?.renderer.syncPixelRatio();
 }
 redrawOverlays(false);referenceFit();renderCameraControls();renderNumericView();
}

function configureTurnPad():void {
 const a=data.a.feedbackCatalog.turnDials??[],b=data.b.feedbackCatalog.turnDials??[],dials=sharedTurnDials(a,b);
 if(!dials.length)return;
 const host=document.createElement('div');host.id='turn-pad-host';el('stage-layout').before(host);
 turnPad=bindTurnPad({host,stages:[el('a-viewport'),el('b-viewport')],dials,blocked:()=>seeking||video.seeking||!!persistence?.restoring()||!ready,
  draw:state=>{if(!players.a||!players.b)return;try{for(const side of ['a','b'] as const){const source=side==='a'?a:b;players[side]!.adjust=state.adjust(source.filter(d=>dials.some(shared=>shared.axis===d.axis)));if(typeof turnAdjusts!=='undefined')turnAdjusts[side]=players[side]!.adjust;}players.a.draw();parts?.present('a');players.b.draw();parts?.present('b');redrawOverlays(true);}catch(error){failPair(error);throw error;}},save:()=>persistence?.save(),error:value=>message(value,true)});
 const note=document.createElement('p');note.className='hint';note.textContent='Both panes share the same values over the intersection of their declared ranges. Axes absent on either side are not offered.';host.append(note);
}
async function loadSide(side: Side, value: CompareSide): Promise<number> {
  text(`${side}-title`, value.manifest.title);
  if (!value.manifest.model) throw new Error(`${side.toUpperCase()}: compiled model Not supplied`);
  const modelUrl = new URL(sideAsset(side, value.manifest.model), location.href).href;
  const loaded = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, base) => { const url = new URL(name, base); if (url.origin !== location.origin || !url.pathname.startsWith(access.route(`/compare-assets/${side}/`))) throw new Error(`${side}: model page escapes its package`); return url.href; } });
  assets[side] = loaded; const clip = loaded.animations.find(item => item.name === data.animation); if (!clip) throw new Error(`${side.toUpperCase()}: animation "${data.animation}" Not supplied`);
  const player = new RigPlayer(el(`${side}-root`), loaded, { seekStep: compareSeekStep });
  // A side counts as loaded only after its first successful draw; a parts catalog refusal never fails the side.
  try { players[side] = player;try{const catalog=await loadPartModel(modelUrl,value.reviewedSource.rig!.sha256,value.feedbackCatalog.slots??[]);thumbnails[side]?.dispose();thumbnails[side]=new PartThumbnails(pageRegionTable(catalog.model),loaded.pageImages);parts?.register(side,catalog.entries,player,thumbnails[side]);pickedTools?.registerSideModel(side,modelUrl,access.route(`/compare-assets/${side}/`),value.reviewedSource.rig!.sha256,catalog.model);}catch(error){parts?.refuseCatalog(side,error);pickedTools?.registerSideModel(side,modelUrl,access.route(`/compare-assets/${side}/`),value.reviewedSource.rig!.sha256,null);} player.environment(null); player.play(data.animation, { loop: false }); player.pause(); player.draw(); }
  catch (error) { thumbnails[side]?.dispose(); delete thumbnails[side]; delete players[side]; player.dispose(); throw error; }
  el(`${side}-empty`).hidden = true; return clip.duration;
}
async function swapSideRig(side:Side,modelUrl:string,prefix:string,sha256:string,clipName?:string):Promise<void> {
 const keepTime=players[side]?.time??trace?.reference??0,wasPlaying=!video.paused;
 stop();
 const next=await loadModel({modelUrl,setsUrl:null,resolvePage:(name,url)=>{const target=new URL(name,url);if(target.origin!==location.origin||!target.pathname.startsWith(prefix))throw new Error(`${side}: model page escapes its build`);return target.href;}});
 const chosenClip=clipName&&next.animations.some(item=>item.name===clipName)?clipName:next.animations.some(item=>item.name===data.animation)?data.animation:next.animations[0]?.name??'';
 players[side]?.dispose();assets[side]?.dispose();assets[side]=next;
 const player=new RigPlayer(el(`${side}-root`),next,{seekStep:compareSeekStep});players[side]=player;
 try{const catalog=await loadPartModel(modelUrl,sha256,data[side].feedbackCatalog.slots??[]);thumbnails[side]?.dispose();thumbnails[side]=new PartThumbnails(pageRegionTable(catalog.model),next.pageImages);parts?.register(side,catalog.entries,player,thumbnails[side]);pickedTools?.registerSideModel(side,modelUrl,prefix,sha256,catalog.model);}
 catch(error){parts?.refuseCatalog(side,error);pickedTools?.registerSideModel(side,modelUrl,prefix,sha256,null);}
 player.environment(null);if(chosenClip){player.play(chosenClip,{loop:false});player.pause();player.seek(Math.min(keepTime,next.animations.find(item=>item.name===chosenClip)?.duration??keepTime));}
 player.draw();parts?.present(side);fit();redrawOverlays(true);
 if(wasPlaying)void playComparison().catch(error=>message(describe(error),true));
}

async function loadFrameIndex():Promise<void>{
 try{
  const value=await api<ReferenceFrameIndex>('/api/compare/reference-frames');
  if(!value.available){text('frame-index-status',value.reason);return;}
  if(value.sourceHash!==data.sourceHash||value.referenceSha256!==data.reference.sha256)throw new Error('Reference frame index identity differs');
  referenceFrames=value.video;
  for(const side of ['a','b'] as const){const clock=clockForAnimation(data[side].report?.clock,data[side].report?.animation,data.animation,true);associations[side]=producerFrameAssociations(clock,referenceFrames);}
  select('frame-basis').value=associations.b.size?'b':'a';
  text('frame-index-status',typeof video.requestVideoFrameCallback==='function'?'Exact selection: nearest real reference PTS; review frame = unique explicit sample association.':'Exact frame selection unavailable: requestVideoFrameCallback required; seconds playback remains available.');
 }catch(error){referenceFrames=null;text('frame-index-status',`Exact frame selection unavailable: ${describe(error)}`);}
 frameControls();
}
function loadReference(): Promise<number> {
  if (data.reference.url !== '/compare-reference') throw new Error('Reference must be the server-bound local compare video'); const url = new URL(access.route(data.reference.url), location.href); if (url.origin !== location.origin || url.pathname !== access.route('/compare-reference') || url.search || url.hash) throw new Error('Reference must be the server-bound local compare video');
  text('reference-name', data.reference.name); observeVideoFrames();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not read reference video metadata / first frame.')), 15000);
    video.addEventListener('loadeddata', () => { clearTimeout(timer); if (!Number.isFinite(video.duration) || video.duration < 0) reject(new Error('Reference video duration must be finite.')); else { el('reference-empty').hidden = true; resolve(video.duration); } }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Reference video load failed')); }, { once: true }); video.src = url.href; video.load();
  });
}

function provenance(): void {
  const brief = el('provenance-brief'); brief.replaceChildren();
  for (const side of ['a', 'b'] as const) { const value = data[side].reviewedSource; const p = document.createElement('p'); p.textContent = `${side.toUpperCase()} · ${value.packageRevision} / rig ${value.rig?.sha256.slice(0, 12) ?? 'Not supplied'} / motion ${value.motion?.sha256.slice(0, 12) ?? 'Not supplied'}`; brief.append(p); }
  const p = document.createElement('p'); p.textContent = `REF · ${data.reference.sha256.slice(0, 12)}`; brief.append(p); text('provenance-full', JSON.stringify(session.binding, null, 2));
}

function renderFeedbackSelection(): void {
  const side = select('side').value, kind = select('target-kind').value;
  const catalog = side === 'a' || side === 'b' ? data[side].feedbackCatalog : null;
  const names = catalog && ['bone', 'slot', 'rig'].includes(kind) ? feedbackTargetNames(catalog, kind as CompareFeedback['target']['kind']) : null;
  const list = el<HTMLDataListElement>('target-names'); list.replaceChildren();
  for (const name of names ?? []) { const option = document.createElement('option'); option.value = name; list.append(option); }
  const field = input('target-name'); field.value = kind === 'rig' && catalog ? catalog.rig : ''; field.readOnly = kind === 'rig'; field.disabled = !names?.length;
  text('target-hint', !catalog || !kind ? 'Select a target build and type first.' : names === null ? 'Actual target catalog unavailable · bone and slot feedback cannot be added.' : !names.length ? 'No targets of this type.' : kind === 'rig' ? 'Actual rig identifier for the selected package.' : `Choose or enter an exact name from ${side.toUpperCase()}: ${names.length} rig targets.`);
  const last = catalog ? feedbackLastFrame(catalog, data.animation) : null;
  for (const id of ['frame-start', 'frame-end']) { if (last === null) input(id).removeAttribute('max'); else input(id).max = String(Math.max(0, last)); }
  text('feedback-range-hint', !catalog ? 'Select A or B to check frame bounds.' : last === null ? 'Bounds unknown · enter an inclusive integer frame range. FPS is not inferred.' : last < 0 ? 'No frames overlap the explicit clock and selected clip.' : `${side.toUpperCase()}: F0–F${last} for the explicit clock and current clip · inclusive`);
}

function renderFeedback(): void {
  comments?.refresh();
  const list = el('feedback-list'); list.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  const unchecked = session.feedback.map(f => appliedCheckRefusal((f.context as Record<string, unknown> | undefined)?.applied)).find(Boolean) ?? null;
  const appliedCheck = document.getElementById('feedback-applied-check');
  if (appliedCheck) { appliedCheck.hidden = !unchecked; appliedCheck.textContent = unchecked ? `${unchecked} · Submit refuses this review; delete the entry written on that build or Apply a build that passes check.` : ''; }
  warnings.textContent = session.feedbackWarnings.length ? `${session.feedbackWarnings.length} validation warnings in existing feedback · original records are preserved. Review the marked entries, delete them and add valid replacements before submitting. JSON and Markdown exports preserve both the original records and warnings.` : '';
  for (const feedback of session.feedback) {
    const row = document.createElement('div'); row.className = 'feedback-item'; const title = document.createElement('strong'); title.textContent = `${feedback.side.toUpperCase()} · ${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const summary = document.createElement('span'); summary.textContent = feedback.summary;
    row.append(title, summary);
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `Validation warning · ${warning.error}`; row.append(note); }
    const details = document.createElement('details'), heading = document.createElement('summary'), source = document.createElement('pre'); heading.textContent = 'Saved feedback and inspection context'; source.textContent = JSON.stringify(feedback, null, 2); details.append(heading, source);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.onclick = () => { session.feedback = session.feedback.filter(value => value.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); renderFeedback(); markDirty(); };
    row.append(details);if((feedback.context as any)?.comment?.schema!=='rig-review-comment/1'||!submittedBaseline?.feedback.some(f=>f.id===feedback.id))row.append(remove); list.append(row);
  }
  savedState();
}

function download(filename: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function downloadStrip(filename: string, content: Blob): void { const url = URL.createObjectURL(content), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function stripStatus(value: string, error = false): void { text('strip-status', value); el('strip-status').setAttribute('role', error ? 'alert' : 'status'); }
function updateStripControls(): void {
  el('strip-panel').setAttribute('aria-busy', String(stripBusy));
  select('strip-scope').disabled = stripBusy; select('strip-format').disabled = stripBusy; select('strip-basis').disabled = stripBusy || select('strip-scope').value === 'feedback';
  button('strip-export').disabled = stripBusy || !!readOnly; button('strip-export').title = readOnly ?? ''; button('strip-export').textContent = stripBusy ? 'Generating strip…' : 'Download strip';
}
async function exportStrip(): Promise<void> {
  if (stripBusy) return;
  stripStatus('Checking the selected range…');
  try {
    const format = select('strip-format').value;
    if (format !== 'png' && format !== 'json') throw new Error('Select PNG or JSON.');
    const intervals: StripInterval[] = [];
    if (select('strip-scope').value === 'feedback') {
      if (!session.feedback.length) throw new Error('No feedback ranges to export.');
      for (const feedback of session.feedback) {
        const context = feedback.context;
        if (!context || typeof context !== 'object' || Array.isArray(context) || context.animation !== data.animation) throw new Error(`Feedback ${feedback.id}: Its animation is missing or differs from the comparison animation. The range was not reassigned to another animation.`);
        intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: feedback.side, ...requireFeedbackFrames(feedback) });
      }
    } else {
      const basis = select('strip-basis').value, start = input('frame-start').value.trim(), end = input('frame-end').value.trim();
      if (basis !== 'a' && basis !== 'b') throw new Error('Explicitly select A or B as the report defining the frame range.');
      if (!start || !end) throw new Error('Enter the strip start and end frames in the feedback form.');
      intervals.push({ id: 'selection', basis, frameStart: Number(start), frameEnd: Number(end) });
    }
    for (const interval of intervals) if (!Number.isSafeInteger(interval.frameStart) || !Number.isSafeInteger(interval.frameEnd) || interval.frameStart < 0 || interval.frameEnd < interval.frameStart) throw new Error(`${interval.id}: Specify an inclusive range of nonnegative integer frames.`);
    const request: StripRequest = { format, sourceHash: data.sourceHash, animation: data.animation, intervals };
    stripBusy = true; updateStripControls(); stripStatus(`${data.animation} · ${intervals.length} ranges · Generating ${format.toUpperCase()}…`);
    const response = await fetch(access.route('/api/compare/strip'), { method: 'POST', headers: access.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(request) });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw new Error(failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : `Strip export failed · HTTP ${response.status}`);
    }
    const mime = format === 'png' ? 'image/png' : 'application/json';
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(mime)) throw new Error('The strip response format does not match the request.');
    downloadStrip(`review-strip.${format}`, await response.blob()); stripStatus(`${data.animation} · ${intervals.length} ranges · Requested ${format.toUpperCase()} download. Review status was not changed.`);
  } catch (error) { stripStatus(describe(error), true); }
  finally { stripBusy = false; updateStripControls(); }
}
const md = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
function issue(feedback: CompareFeedback) {
  const title = `[${feedback.category}][${feedback.side.toUpperCase()}] ${feedback.target.kind}:${feedback.target.name} F${feedback.frameStart}–${feedback.frameEnd} · ${feedback.summary}`;
  const body = [`Side: ${feedback.side.toUpperCase()}`, `Frames: ${feedback.frameStart}–${feedback.frameEnd} (inclusive; explicit producer frame numbers)`, `Target: ${feedback.target.kind} / ${md(feedback.target.name)}`, '', md(feedback.summary), '', 'Ordered compare provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', 'Inspection context:', ...JSON.stringify(feedback.context ?? null, null, 2).split('\n').map(line => '    ' + line), '', 'Validation warnings (must be corrected before submission):', ...JSON.stringify(session.feedbackWarnings.filter(warning => warning.id === feedback.id), null, 2).split('\n').map(line => '    ' + line)].join('\n');
  return { title, body, labels: [feedback.category] };
}

function bind(): void {
  select('frame-basis').onchange=frameControls;
  button('frame-seek').onclick=()=>{const side=select('frame-basis').value as Side,raw=input('frame-input').value.trim(),frame=Number(raw),clock=clockForAnimation(data[side].report?.clock,data[side].report?.animation,players[side]?.current??'',true),time=timeAtFrame(clock,frame);if(!raw||time===null){message('Choose an integer frame inside the explicit producer clock.',true);return;}void seekTo(time,{side,frame,time});};
  button('strip-export').onclick = () => { void exportStrip(); };
  for (const id of ['strip-scope', 'strip-basis', 'strip-format']) select(id).onchange = () => { updateStripControls(); stripStatus('Selection changed. Check the ranges and frame-basis report before downloading.'); };
  button('play').onclick=()=>{if(loopRestarting||seeking&&!idleHeld){void cancelPendingPlayback();return;}if(!video.paused){idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined)void seekTo(current);return;}void playComparison().catch(error=>message(describe(error),true));};
  input('scrub').oninput = () => { void seekTo(Number(input('scrub').value)); };
  button('seek').onclick = () => { const value = input('time-input').value.trim(); if (!value) { message('Enter a time in seconds.', true); return; } void seekTo(Number(value)); };
  video.addEventListener('ended', () => { stopAtSupportedEnd(); });
  input('reference-audio').onchange = () => { video.muted = !input('reference-audio').checked; };
  button('zoom-in').onclick=()=>cameraAction(()=>zoomCamera(1.25));button('zoom-out').onclick=()=>cameraAction(()=>zoomCamera(1/1.25));button('fit').onclick=()=>cameraAction(()=>fitActiveCamera());
  input('camera-sync').onchange=()=>cameraAction(()=>setCameraSync(input('camera-sync').checked));
  for(const target of ['a','b','reference'] as const){
   el(target+'-viewport').addEventListener('wheel',event=>{event.preventDefault();cameraAction(()=>zoomCamera(event.deltaY<0?1.1:1/1.1,target));},{passive:false});
   for(const event of ['pointerdown','focusin'] as const)el(target+'-viewport').addEventListener(event,()=>activateCamera(target));
  }
  select('status').onchange = () => { session.status = select('status').value as CompareSession['status']; markDirty(); };
  select('side').onchange = () => { renderFeedbackSelection(); select('category').value = ''; input('summary').value = ''; }; select('target-kind').onchange = renderFeedbackSelection;
  button('add-feedback').onclick = () => {
    const inspected = feedbackTrace(ready, seeking || video.seeking, trace);
    if (!inspected) { message('Wait for the reference video and both rigs to synchronize successfully before adding feedback.', true); return; }
    const side = select('side').value, start = input('frame-start').value.trim(), end = input('frame-end').value.trim(), frameStart = Number(start), frameEnd = Number(end), kind = select('target-kind').value, category = select('category').value, name = input('target-name').value.trim(), summary = input('summary').value.trim();
    if (side !== 'a' && side !== 'b') { message('Select A or B as the feedback target.', true); return; }
    if (!start || !end || !Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd) || frameStart < 0 || frameEnd < frameStart) { message('Enter an inclusive range of nonnegative integer frames.', true); return; }
    if (!['bone', 'slot', 'rig'].includes(kind) || !['defect', 'quality'].includes(category) || !name || !summary || /[\r\n]/.test(summary) || summary.length > 1000) { message('Enter a target type, actual name, category and one-line summary of up to 1,000 characters.', true); return; }
    const target: CompareFeedback['target'] = { kind: kind as CompareFeedback['target']['kind'], name };
    try { validateFeedbackSelection(data[side].feedbackCatalog, { frameStart, frameEnd, target, animation: data.animation }); } catch (error) { message(describe(error), true); return; }
    const appliedOnStage = pickedTools ? pickedTools.appliedFor(side) : null;
    session.feedback.push({ id: crypto.randomUUID(), side, frameStart, frameEnd, target, category: category as CompareFeedback['category'], summary, context: { ...(turnPad?{turn:JSON.parse(JSON.stringify(turnPad.snapshot()))}:{}),interval: { frameStart, frameEnd, inclusive: true }, animation: data.animation, mediaTime: inspected.reference, clockSource: inspected.source, frame: currentFrame(side), frames: { a: currentFrame('a'), b: currentFrame('b') }, playheads: { reference: inspected.reference, a: inspected.a, b: inspected.b },reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')},requestedProducer,part:parts?.feedback()??null,view:{...serializableView(numericView()),theme:appearance?.get()??'system',layers:{...layers}},applied:appliedOnStage?JSON.parse(JSON.stringify(appliedOnStage)):null,decodedIndex:referenceFrames?referenceFrameAtTime(referenceFrames,inspected.reference)?.index??null:null } });
    input('summary').value = ''; markDirty(); renderFeedback(); message('Added feedback bound to the target build and both reviewed sources.');
  };
  button('submit').onclick = async () => { if(readOnly){message(readOnly,true);return;}if(draftConflict){message('Resolve the saved local draft conflict before submitting.',true);return;}if (session.feedbackWarnings.length) { message('Resolve validation warnings in existing feedback before submitting. Delete the marked entries and add valid replacements.', true); return; } const unchecked = session.feedback.map(f => appliedCheckRefusal((f.context as Record<string, unknown> | undefined)?.applied)).find(Boolean) ?? null; if (unchecked) { message(unchecked, true); return; } saving = true; savedState(); const payload = JSON.stringify(session); try { const saved = await api<CompareSession>('/api/compare/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload }); if (JSON.stringify(session) === payload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt;submittedBaseline=structuredClone(saved);comments?.refresh();await persistence?.submitted(saved);renderFeedback(); message(dirty ? 'Changes were made during submission. Submit again.' : 'Submitted the selected review status and A/B/reference-video provenance.'); } catch (error) { message(`Submission failed: ${describe(error)}`, true); } finally { saving = false; savedState(); } };
  button('export-json').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ ...session, schema: 'rig-review-compare-feedback/1', issues: session.feedback.map(issue) }, null, 2) + '\n', 'application/json'); };
  button('export-markdown').onclick = () => { download(`${session.id}-issues.md`, [`# ${md(data.title)}`, '', 'Ordered A/B and reference provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', 'Validation warnings:', ...JSON.stringify(session.feedbackWarnings, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(feedback => { const entry = issue(feedback); return [`## ${md(entry.title)}`, '', entry.body, '', '---', '']; })].join('\n'), 'text/markdown'); };
  // Saved browser defaults seed a new inspection; explicit links and source drafts restore over them.
  workspace=bindWorkspaceUI({changed:fit,defaultTheme:theme=>appearance?.set(theme)});
  cameraSync=workspace.defaults().defaultCameraSync;input('camera-sync').checked=cameraSync;input('idle-repeat').checked=workspace.defaults().defaultIdleRepeat;
  appearance=bindAppearance(select('appearance'),workspace.defaults().theme);
  for(const side of ['a','b'] as const)overlays[side]=new RigOverlays({canvas:el<HTMLCanvasElement>(side+'-overlay'),rigRoot:el(side+'-root')});
  for(const target of ['a','b','reference'] as const)viewDisposers.push(bindPan(el(target+'-viewport'),(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy)),()=>!comments?.active()));
  viewDisposers.push(bindStageLayout(el('stage-layout'),fit));
  for(const [id,key] of [['layer-images','images'],['layer-mesh','mesh'],['layer-bones','bones']] as const)input(id).onchange=()=>{layers[key]=input(id).checked;redrawOverlays(false);};
  input('idle-repeat').onchange=()=>{renderIdle();if(canRepeatIdle())void playComparison().catch(error=>message(describe(error),true));};
  el('inspector-feedback').addEventListener('focusin',()=>{idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined&&!seeking)void seekTo(current);});
  bindInspector();
  pickedTools=mountComparePickedTools({data:()=>data,readOnly:()=>readOnly,players,assets,rigScales,layers,parts:()=>parts,time:()=>trace?.reference??presentation.snapshot().lastDrawn?.reference??0,duration:()=>domain?.end??0,playing:()=>!video.paused,pause:()=>{idleHeld=true;stop();},seekTo:seconds=>seekTo(seconds),api,route:access.route,swapSideRig,redrawOverlays,fit,syncLayout:()=>{renderPairLayout();const mode=pickedTools?.mode()??'compare',picked=pickedTools?.pickedSide()??'a';if(mode!=='compare'&&activeCamera!=='reference'&&activeCamera!==picked)activeCamera=picked;fit();},saveDraft:()=>{persistence?.save();},message,download,turnAdjustFor:side=>turnAdjusts[side]??null,syncFeedbackSide:side=>{if(select('side').value!==side&&!input('summary').value.trim()){select('side').value=side;renderFeedbackSelection();}}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){suspendedPreview=!video.paused;stop();}else if(suspendedPreview&&!idleHeld){suspendedPreview=false;void playComparison().catch(error=>message(describe(error),true));}});
  const observer = new ResizeObserver(fit); observer.observe(el('a-viewport')); observer.observe(el('b-viewport'));observer.observe(el('reference-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { pickedTools?.dispose();comments?.dispose();persistence?.dispose();turnPad?.dispose();workspace?.dispose();disposed = true; seekAbort?.abort();controlDispose?.();appearance?.dispose();viewDisposers.forEach(dispose=>dispose());for(const overlay of Object.values(overlays))overlay.dispose();stop(); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); if (fallbackCallback !== null) cancelAnimationFrame(fallbackCallback); for (const side of ['a', 'b'] as const) { thumbnails[side]?.dispose(); players[side]?.dispose(); assets[side]?.dispose(); } observer.disconnect(); });
}

async function start(): Promise<void> {
  try {
    for (const id of titledIds) { const node = document.getElementById(id); if (node && node.textContent) node.title = node.textContent; }
    let writes: { capabilityRequired: boolean; control?: boolean };
    [data, session, writes] = await Promise.all([api<CompareResponse>('/api/compare'), api<CompareSession>('/api/compare/session'), api<{ capabilityRequired: boolean; control?: boolean }>('/api/access')]);
    readOnly = readOnlyReason(access, writes.capabilityRequired); if (readOnly) message(readOnly, true); controlServed = writes.control !== false;
    submittedBaseline=structuredClone(session);
    if (data.id !== session.id || data.sourceHash !== session.sourceHash || JSON.stringify(data.binding) !== JSON.stringify(session.binding)) throw new Error('Comparison and submission session refer to different source identities. Reopen the review.');
    text('title', data.title); text('animation', `${data.animation} · A/B order and reference video hash are fixed`); document.title = data.title + ' · rig review compare'; select('status').value = session.status; provenance(); bind(); parts=new PartExplorer(el('parts-explorer'),el('selected-part'),previous=>{redrawOverlays(true);const part=parts?.value();pickedTools?.onPartSelected(part?.side==='b'?'b':part?.side==='a'?'a':null,part?.slot??null);if(part&&!pickedTools?.isSwitchingSide()){activeCamera=part.side==='b'?'b':'a';workspace?.revealInspector();if(document.querySelector<HTMLElement>('[data-inspector][aria-selected="true"]')?.dataset.inspector!=='playback')document.querySelector<HTMLButtonElement>('[data-inspector=rig]')?.click();renderCameraControls();}if(!cameraRestoring&&!pickedTools?.isSwitchingSide()&&(previous?.side!==part?.side||previous?.slot!==part?.slot))cameraAction(()=>fitActiveCamera());persistence?.save();},part=>{select('side').value=part.side;select('target-kind').value='slot';renderFeedbackSelection();input('target-name').value=part.slot;document.querySelector<HTMLButtonElement>('[data-inspector=feedback]')?.click();}); updateStripControls(); stripStatus('Choose the entered start–end frames or all feedback ranges to download. Unsubmitted feedback is included; exporting does not submit the review.'); renderFeedbackSelection(); renderFeedback(); savedState();
    renderPairLayout();
    const settled = await Promise.allSettled([loadReference(), loadSide('a', data.a), loadSide('b', data.b)]);
    const outcome = (value: PromiseSettledResult<number>): InputState => value.status === 'fulfilled' ? { state: 'loaded' } : { state: 'failed', reason: describe(value.reason) };
    pairInputs = { reference: outcome(settled[0]), a: outcome(settled[1]), b: outcome(settled[2]), domain: null };
    if (settled[0].status === 'fulfilled' && settled[1].status === 'fulfilled' && settled[2].status === 'fulfilled') { try { domain = commonDomain(settled[0].value, settled[1].value, settled[2].value); pairInputs.domain = { end: domain.end }; } catch (error) { pairInputs.domain = { refused: describe(error) }; } }
    renderPairLayout();
    if (!domain) { showSurvivors(); return; }
    void loadFrameIndex();
    input('scrub').max = String(domain.end); input('time-input').max = String(domain.end); text('domain', `Shared range 0–${domain.end} s · Neither side is independently clamped or looped`); ready = true;
    input('scrub').disabled = false; input('time-input').disabled = false; button('seek').disabled = false; button('play').disabled = domain.end === 0;
    await seekTo(0);configureTurnPad();workspace?.refresh();activeCamera='a';if(cameraSync)alignCameras();fit();for(const id of ['layer-images','layer-mesh','layer-bones'])input(id).disabled=false;renderIdle();const restored=await setupPersistence();setupComments();await pickedTools?.loadInitialSideStatuses();if(!restored&&canRepeatIdle())void playComparison().catch(error=>message(describe(error),true));
    if(!readOnly&&controlServed)controlDispose=connectControl({sourceHash:data.sourceHash,mode:'compare',route:access.route,headers:()=>access.headers(),observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
  } catch (error) { failPair(error); for (const side of ['a', 'b'] as const) if (!players[side]) text(`${side}-empty`, `${side.toUpperCase()} Could not open comparison rig.`); text('reference-empty', 'Check the reference video and comparison inputs.'); }
}
function sharedBox():PoseBounds|null {const a=assets.a?.stage??players.a?.bounds(),b=assets.b?.stage??players.b?.bounds();return a&&b?unionBounds(a,b):a??b??null;}
/** The pair is offered only when both sides and the shared video actually loaded; a failed side leaves the survivor as a single pane, named. */
function renderPairLayout():PairEligibilityState {
 const tools=typeof pickedTools!=='undefined'?pickedTools:null,state=pairEligibility(pairInputs),mode=tools?.mode()??'compare',picked=tools?.pickedSide()??'a',shown={reference:state.effective==='compare'||state.effective==='reference',a:(state.effective==='compare'&&(mode==='compare'||picked==='a'))||state.effective==='a',b:(state.effective==='compare'&&(mode==='compare'||picked==='b'))||state.effective==='b'};
 for(const target of ['reference','a','b'] as const){const pane=el(target+'-viewport').closest('section');if(pane)pane.hidden=!shown[target];}
 el('stage-layout').dataset.panes=String(Object.values(shown).filter(Boolean).length);
 if(state.effective!=='compare')text('domain',state.effective===null?`No input rendered · ${state.reasons.compare??''}`:`${state.effective==='reference'?'Reference only':state.effective.toUpperCase()+' only'} · comparison unavailable: ${state.reasons.compare??''}`);
 return state;
}
type PairEligibilityState=ReturnType<typeof pairEligibility>;
/** Static single-pane inspection of whatever actually loaded. No synchronized pair, playback or feedback. */
function showSurvivors():void {
 invalidateTrace('Comparison unavailable · no synchronized pair');
 for(const side of ['a','b'] as const){if(pairInputs[side].state==='loaded'&&players[side])text(`${side}-renderer`,rendererBadges[side].succeeded(players[side]!.renderer).label);else{thumbnails[side]?.dispose();delete thumbnails[side];assets[side]?.dispose();delete assets[side];text(`${side}-empty`,`${side.toUpperCase()} unavailable · ${pairInputs[side].state==='failed'?(pairInputs[side] as {reason:string}).reason:'not loaded'}`);text(`${side}-renderer`,rendererBadges[side].failed().label);}}
 if(pairInputs.reference.state!=='loaded')text('reference-empty','Reference video unavailable.');
 updateFeedbackAvailability();
 const state=renderPairLayout();activeCamera=state.effective==='b'?'b':state.effective==='reference'?'reference':'a';fit();
 message(`Comparison unavailable · ${state.reasons.compare??''}${state.effective&&state.effective!=='compare'?` · showing ${state.effective==='reference'?'the reference':state.effective.toUpperCase()} alone`:''}`,true);
 if(!readOnly&&controlServed)controlDispose=connectControl({sourceHash:data.sourceHash,mode:'compare',route:access.route,headers:()=>access.headers(),observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
}
function paneFrame(target:CameraTarget,hidden=false):CameraFrame|null {
 const viewport=el(target+'-viewport');let width=viewport.clientWidth,height=viewport.clientHeight;
 if(width<=0||height<=0){if(!hidden)return null;if(cameraFrames[target])return cameraFrames[target]!;if(target==='a'||target==='b'){const other=el((target==='a'?'b':'a')+'-viewport');width=other.clientWidth;height=other.clientHeight;}if(width<=0||height<=0)return null;}
 const box=target==='reference'?video.videoWidth>0&&video.videoHeight>0?{x:0,y:0,width:video.videoWidth,height:video.videoHeight}:null:players[target]?sharedBox():null;
 if(!box)return null;const frame=cameraFrame(target==='reference'?'image':'world',box,width,height,target==='reference'?0:22,target==='reference'?0:38);if(frame)cameraFrames[target]=frame;return frame;
}
function availableCamera():CameraTarget|null {return paneFrame(activeCamera)?activeCamera:paneFrame('a')?'a':paneFrame('b')?'b':paneFrame('reference')?'reference':null;}
function activateCamera(target:CameraTarget):void {if(paneFrame(target)){activeCamera=target;renderCameraControls();}}
function alignCameras():void {
 const target=availableCamera();if(!target)return;const source=paneFrame(target)!;assertCameraView(cameras[target],source);const signature=cameraSignature(cameras[target],source);
 const updates:Partial<Record<CameraTarget,PaneCamera>>={};
 for(const other of ['a','b','reference'] as const){if(other===target)continue;const frame=paneFrame(other);if(frame)updates[other]=cameraFromSignature(signature,frame);}
 Object.assign(cameras,updates);activeCamera=target;
}
function renderCameraControls():void {input('camera-sync').checked=cameraSync;const target=availableCamera();text('zoom-label',`${Math.round((target?cameras[target].zoom:1)*100)}% · ${target==='reference'?'Reference':target?.toUpperCase()??'A'}`);button('fit').textContent=cameraSync?'Fit synchronized views':'Fit active view';}
function setCameraSync(value:boolean):void {if(value)alignCameras();cameraSync=value;fit();}
function cameraAction(action:()=>void):void {try{action();}catch(error){renderCameraControls();message(describe(error),true);}}
function updateCamera(target:CameraTarget,value:CameraSignature,rigGroup=false):void {
 const frame=paneFrame(target);if(!frame)return;
 const updates:Partial<Record<CameraTarget,PaneCamera>>={[target]:cameraFromSignature(value,frame)};
 for(const other of ['a','b','reference'] as const){if(other===target||!cameraSync&&!(rigGroup&&other!=='reference'))continue;const next=paneFrame(other);if(next)updates[other]=cameraFromSignature(value,next);}
 Object.assign(cameras,updates);activeCamera=target;fit();
}
function zoomCamera(factor:number,target=availableCamera()):void {if(!target)return;const frame=paneFrame(target);if(frame)updateCamera(target,zoomSignature(cameraSignature(cameras[target],frame),factor));}
function panCamera(target:CameraTarget,dx:number,dy:number):void {const frame=paneFrame(target);if(frame)updateCamera(target,dragSignature(cameraSignature(cameras[target],frame),frame,dx,dy));}
function fitActiveCamera(target=availableCamera()):void {if(!target)return;const tools=typeof pickedTools!=='undefined'?pickedTools:null,mode=tools?.mode()??'compare',picked=tools?.pickedSide()??'a',suffix=mode==='compare'?'':` on Build ${picked.toUpperCase()} (${data[picked].manifest.title})`;const part=parts?.value();if(part?.side===target){const box=parts?.bounds(),frame=paneFrame(target);if(!box||!frame){message('PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',true);return;}updateCamera(target,boundsFitSignature(box,frame,22,38));message(`Selected slot fitted${suffix}.`);}else{if(!paneFrame(target))return;updateCamera(target,{zoom:1,pan:{x:0,y:0}});message(`View fitted${suffix}.`);}}
function referenceFit():void {const frame=paneFrame('reference');if(!frame)return;const signature=cameraSignature(cameras.reference,frame);video.style.transform=`translate(${signature.pan.x*frame.width}px,${signature.pan.y*frame.height}px) scale(${signature.zoom})`;}
function redrawOverlays(fresh:boolean):void {
 const warnings:string[]=[];let needsCapture=false;
 for(const side of ['a','b'] as const){const overlay=overlays[side],player=players[side];if(!overlay||!player)continue;const root=el(`${side}-root`),project=(x:number,y:number)=>({x:parseFloat(root.style.left||'0')+x*rigScales[side],y:parseFloat(root.style.top||'0')-y*rigScales[side]}),extra=pickedTools?pickedTools.overlayInputFor(side):{regions:[],circles:[],markers:[],meshEdit:null,weights:null,anchors:null};const snapshot=fresh?overlay.refresh({player,frame:parts?.frame(side),selectedSlot:parts?.value()?.side===side?parts.value()!.slot:null,bones:(data[side].feedbackCatalog.bones??[]).map(name=>({name})),project,settings:layers,...extra}):overlay.redraw({project,settings:layers,...extra});pickedTools?.recordOverlaySnapshot(side,snapshot);warnings.push(...snapshot.warnings);needsCapture ||= snapshot.needsCapture;}
 text('layer-state',warnings.join(' · ')||'Actual last-drawn mesh edges / bone points');
 if(!fresh&&needsCapture&&trace&&!seeking&&!video.seeking&&players.a&&players.b){try{drawSynchronizedPair(inspectionPlayer('a'),inspectionPlayer('b'));redrawOverlays(true);for(const side of ['a','b'] as const)text(`${side}-renderer`,rendererBadges[side].observe('drawn',players[side]!.renderer).label);}catch(error){failPair(error);}}
}
function bindInspector():void {bindInspectorTabs(()=>{pickedTools?.onInspectorTabChanged();workspace?.afterTab();if(document.querySelector('[data-inspector="feedback"][aria-selected="true"]')){idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined&&!seeking)void seekTo(current);}fit();},()=>workspace?.beforeTab());}

function canRepeatIdle():boolean{return data?.animation==='idle'&&idleAvailable(assets.a?.animations.map(a=>a.name)??[],data.animation)&&idleAvailable(assets.b?.animations.map(a=>a.name)??[],data.animation)&&input('idle-repeat').checked&&!!domain&&domain.end>0;}
function renderIdle():void {text('idle-state',canRepeatIdle()?'Actual idle · repeat enabled':'Bound non-idle inspection · no automatic playback');}
async function playComparison(signal?:AbortSignal):Promise<void> {
 if(!ready||seeking||!domain||domain.end<=0)throw new Error('Comparison playback is unavailable');
 idleHeld=false;if(trace&&trace.reference>=domain.end){await seekTo(0,null,null,true);if(!trace||signal?.aborted)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');}
 const generation=latestSeek;requestedProducer=null;endStopReason=null;
 try{await video.play();if(signal?.aborted||generation!==latestSeek||idleHeld){stop();throw new Error('CONTROL_SUPERSEDED');}button('play').textContent='Ⅱ';button('play').setAttribute('aria-label','Pause comparison');}catch(error){stop();idleHeld=true;throw new Error(`Playback is paused: ${describe(error)}. Use Play to retry.`);}
}
async function cancelPendingPlayback():Promise<void> {
 const previous=presentation.snapshot().lastDrawn?.reference??trace?.reference??null;
 idleHeld=true;++latestSeek;seekAbort?.abort();seeking=false;requestedProducer=null;stop();invalidateTrace('Idle restart cancelled · restoring paused inspection');frameControls();
 // Recover the last actual drawn inspection via a NEW generation. The aborted
 // restart can no longer commit or resume after this explicit manual hold.
 if(previous!==null&&ready&&!disposed)await seekTo(previous);
}
async function restartIdle():Promise<void> {
 if(loopRestarting)return;loopRestarting=true;stop();
 try{await seekTo(0,null,null,true);if(!idleHeld&&canRepeatIdle()&&!disposed&&!document.hidden&&trace)await playComparison();}
 catch(error){idleHeld=true;message(describe(error),true);}finally{loopRestarting=false;}
}
function localDraft():boolean{return !!comments?.draft()||dirty||!!input('summary').value.trim()||!!input('frame-start').value.trim()||!!input('frame-end').value.trim()||!!input('target-name').value.trim()||!!select('category').value;}
function controlState():ControlInspection {
 const css=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return {zoom:1,pan:{x:0,y:0}};const value=cameraSignature(cameras[target],frame);return {zoom:value.zoom,pan:{x:value.pan.x*frame.width,y:value.pan.y*frame.height}};};
 return {part:parts?.value()??null,partGeneration:parts?.observation()?.generation??null,view:numericView(),theme:appearance?.get()??'system',layout:'auto',effectiveLayout:el('stage-layout').dataset.orientation==='vertical'?'column':'row',cameras:{rig:css('a'),a:css('a'),b:css('b'),reference:css('reference')},animation:data.animation,time:trace?.reference??null,playing:!video.paused,loop:canRepeatIdle()?'idle':'off',layers:{images:!!players.a&&layers.images,meshes:!!players.a&&layers.mesh,bones:!!players.a&&layers.bones},ready,seeking:seeking||video.seeking||!!persistence?.restoring(),dirty:localDraft(),busy:saving||stripBusy||!!persistence?.restoring(),feedbackEligible:!persistence?.restoring()&&pairEligibility(pairInputs).feedback&&!!feedbackTrace(ready,seeking||video.seeking,trace),comparison:controlComparison(pairEligibility(pairInputs)),capabilities:{camera:!!players.a&&!!players.b,referenceCamera:video.readyState>=1,animation:false,time:ready,playback:ready&&pairEligibility(pairInputs).playback,layers:{images:!!players.a&&!!players.b,meshes:!!players.a&&!!players.b,bones:!!players.a&&!!players.b}}};
}
async function applyControl(command:ControlCommand,signal:AbortSignal):Promise<void> {
 if(signal.aborted)throw new Error('CONTROL_SUPERSEDED');
 if(['animation','time','playback'].includes(command.type)&&(localDraft()||saving||stripBusy))throw new Error('CONTROL_DRAFT_BUSY: preserve review draft');
 if(command.type==='theme'){appearance?.set(command.value);return;}
 if(command.type==='layout'){fit();return;}
 if(command.type==='camera-sync'){setCameraSync(command.value);return;}
 if(command.type==='animation'){if(command.name!==data.animation)throw new Error('CONTROL_REBIND_REQUIRED');return;}
 if(command.type==='layers'){if(!players.a||!players.b)throw new Error('CONTROL_LAYERS_UNAVAILABLE');Object.assign(layers,{images:command.images,mesh:command.meshes,bones:command.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;redrawOverlays(false);return;}
 if(command.type==='camera'||command.type==='fit'){
  const target=command.target==='rig'?'a':command.target,frame=paneFrame(target);if(!frame)throw new Error('CONTROL_CAMERA_UNAVAILABLE');
  const value=command.type==='fit'?{zoom:1,pan:{x:0,y:0}}:{zoom:command.zoom,pan:{x:command.pan.x/frame.width,y:command.pan.y/frame.height}};
  updateCamera(target,value,command.target==='rig');return;
 }
 if(command.type==='playback'){if(command.value==='play')await playComparison(signal);else{idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined){await seekTo(current);if(!trace)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');}}return;}
 if(command.type==='time'){if(!domain)throw new Error('CONTROL_TIME_UNAVAILABLE');requireCommonTime(command.seconds,domain);await seekTo(command.seconds);if(signal.aborted||!trace)throw new Error('CONTROL_REFERENCE_UNAVAILABLE');}
}
function numericView():ControlView {
 const numeric=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return null;const camera=cameras[target];return numericCamera(frame.space,camera.center??frame.center,camera.zoom,frame.baseScale*camera.zoom,frame.width,frame.height);};
 return {schema:'rig-review-view/1',cameraSync,activeCamera,cameras:{rig:null,a:numeric('a'),b:numeric('b'),reference:numeric('reference')}};
}
function renderNumericView():void {const node=document.getElementById('view-coordinates');if(node)node.textContent=JSON.stringify(numericView(),null,2);}
function inspectionBinding():InspectionBinding{return {mode:'compare',sourceHash:data.sourceHash,rigs:[data.a.reviewedSource.rig?.sha256??null,data.b.reviewedSource.rig?.sha256??null]};}
function inspectionBookmark():InspectionBookmark {return {schema:'rig-review-inspection/1',binding:inspectionBinding(),animation:data.animation,time:trace?.reference??presentation.snapshot().lastDrawn?.reference??null,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:layers.bones},view:numericView(),selection:{...(turnPad?{turn:turnPad.snapshot()}:{}),part:parts?.value()??null,reference:data.reference.sha256,inspector:document.querySelector<HTMLElement>('[data-inspector][aria-selected=true]')?.dataset.inspector??'view',mode:pickedTools?.mode()??'compare',side:pickedTools?.pickedSide()??'a'}};}
async function restoreInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 await restoreTransaction(async()=>{

 if(bookmark.selection.turn){if(!turnPad)throw new Error('TURN_UNAVAILABLE');turnPad.state.validate(bookmark.selection.turn);}
 parts?.validate(bookmark.selection.part);
 if(bookmark.animation!==data.animation||bookmark.selection.reference!==data.reference.sha256)throw new Error('Saved comparison animation/reference requires a different source binding');
 if(!domain)throw new Error('Comparison is not ready');if(bookmark.time!==null)requireCommonTime(bookmark.time,domain);
 for(const target of ['a','b','reference'] as const)if(bookmark.view.cameras[target]&&!paneFrame(target,true))throw new Error('Saved '+target+' camera is unavailable');
 if(bookmark.view.cameras.rig)throw new Error('Saved single-rig camera is unavailable in comparison');
 if(signal.aborted)throw new Error('Inspection restore superseded');
 },()=>({bookmark:inspectionBookmark(),inputs:captureInputs()}),()=>applyInspection(bookmark,signal),async previous=>{await applyInspection(previous.bookmark,new AbortController().signal);restoreInputs(previous.inputs);video.muted=!input('reference-audio').checked;});
}
async function applyInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 cameraRestoring=true;try{
 if(turnPad){if(bookmark.selection.turn)turnPad.restore(bookmark.selection.turn);else{turnPad.state.reset();turnPad.restore(turnPad.snapshot());}}
 parts?.select(bookmark.selection.part??null);
 idleHeld=true;stop();if(bookmark.time!==null){await seekTo(bookmark.time);if(signal.aborted||!trace)throw new Error('Saved reference inspection could not settle');}
 appearance?.set(bookmark.theme);Object.assign(layers,{images:bookmark.layers.images,mesh:bookmark.layers.meshes,bones:bookmark.layers.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;
 if(bookmark.selection.inspector){workspace?.beforeTab();for(const tab of document.querySelectorAll<HTMLButtonElement>('[data-inspector]')){const selected=tab.dataset.inspector===bookmark.selection.inspector;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}for(const panel of document.querySelectorAll<HTMLElement>('[data-inspector-panel]'))panel.hidden=panel.dataset.inspectorPanel!==bookmark.selection.inspector;workspace?.afterTab();}
 if(typeof pickedTools!=='undefined'&&pickedTools){if(bookmark.selection.side==='a'||bookmark.selection.side==='b')pickedTools.setPickedSide(bookmark.selection.side);const nextMode=bookmark.selection.mode??(bookmark.selection.inspector==='rig'?'setup':bookmark.selection.inspector==='playback'?'animate':'compare');pickedTools.setMode(nextMode,{fromTab:true});}
 syncStageLayout(el('stage-layout'));fit();
 for(const target of ['a','b','reference'] as const){const camera=bookmark.view.cameras[target],frame=paneFrame(target,true);if(camera&&frame)cameras[target]={zoom:restoredZoom(camera,frame.baseScale,frame.width,frame.height),center:{...camera.center}};}
 cameraSync=bookmark.view.cameraSync??false;activeCamera=bookmark.view.activeCamera==='b'||bookmark.view.activeCamera==='reference'?bookmark.view.activeCamera:'a';
 if(bookmark.selection.part)parts?.assertIdentity(bookmark.selection.part);fit();redrawOverlays(false);idleHeld=true;stop();
 }finally{cameraRestoring=false;}
}
async function setupPersistence():Promise<boolean> {
 persistence=await connectInspectionPersistence({scope:'compare:'+data.a.manifest.id+':'+data.a.sourceHash+':'+data.b.manifest.id+':'+data.b.sourceHash,binding:inspectionBinding(),baseline:submittedBaseline!,session:()=>session,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{session=value;dirty=isDirty;select('status').value=session.status;renderFeedback();savedState();},bookmark:inspectionBookmark,restoreBookmark:restoreInspection,
 ui:()=>({inspectorScroll:workspace?.scroll()??'{}',frameBasis:select('frame-basis').value,...(pickedTools?pickedTools.uiState():{})}),restoreUI:value=>{if(value.frameBasis==='a'||value.frameBasis==='b')select('frame-basis').value=value.frameBasis;frameControls();pickedTools?.restoreUiState(value);workspace?.restoreScroll(value.inspectorScroll);},afterInputs:()=>{video.muted=!input('reference-audio').checked;const name=input('target-name').value;renderFeedbackSelection();input('target-name').value=name;},onConflict:value=>{draftConflict=value;savedState();},onStatus:value=>{text('draft-state',value);el('draft-state').title=value;}});
 return persistence.restored;
}

function setupComments():void {
 comments=bindStageComments({toolbar:el('stage-comment').parentElement!,viewports:{a:el('a-viewport'),b:el('b-viewport'),reference:el('reference-viewport')},
  pose:view=>{
   if(view==='rig'||!trace)return null;const side=view==='b'?'b':'a',camera=numericView().cameras[view];if(!camera||hostHidden(el(view+'-viewport')))return null;
   const raw=currentReviewFrame(side)??currentFrame(side),decoded=referenceFrames?referenceFrameAtTime(referenceFrames,trace.reference):null;
   const renderer=players[side]?.renderer;const index=view==='reference'?decoded?.index:raw??decoded?.index,basis=view==='reference'||raw===null?'reference':'producer';
   return {mode:pickedTools?.mode()??'compare',capture:{pane:el(view+'-viewport'),root:view==='reference'?undefined:el(side+'-root'),images:view==='reference'||layers.images,canvas:view!=='reference'&&renderer instanceof CanvasRenderer?renderer.canvas:undefined,backend:renderer instanceof CanvasRenderer?renderer.backendActive:renderer?.meshBackendActive??'canvas2d'},camera,frame:index===null||index===undefined?null:{index,basis},time:trace.reference,animation:data.animation,turn:turnPad?.snapshot()??null,sourceHash:data[side].sourceHash,modelHash:view==='reference'?null:pickedTools?.modelHashFor(side)??data[side].reviewedSource.rig?.sha256??null,referenceHash:data.reference.sha256,referenceId:data.reference.sha256,rig:data[side].manifest.id,side,...(view==='reference'?{media:video}:{posed:parts?.frame(side),assets:assets[side]})} as CommentPose;
  },
  pause:async()=>{idleHeld=true;const running=!video.paused,at=trace?.reference??lastPresented?.time;stop();if(running&&at!==undefined){await seekTo(at);if(!trace)throw new Error('COMMENT_INSPECTION_UNAVAILABLE');}if(turnPad)turnPad.restore({...turnPad.snapshot(),held:true},false);},
  bookmark:inspectionBookmark,restore:b=>restoreInspection(parseBookmark(b,inspectionBinding()),new AbortController().signal),feedback:()=>session.feedback,
  locked:id=>!!submittedBaseline?.updatedAt&&submittedBaseline.feedback.some(f=>f.id===id),
  add:(f,side)=>session.feedback.push({...f,side:side??'a'}),changed:()=>{markDirty();renderFeedback();persistence?.save();},error:value=>message(value,true),refusal:()=>pickedTools?.commentRefusal()??null,shortcutBlocked:()=>pickedTools?.shortcutBlocked()??false,blocked:()=>saving||seeking||video.seeking||!!persistence?.restoring()||!ready||!!pickedTools?.busy()
 });
}
function hostHidden(node:HTMLElement):boolean{return node.clientWidth<=0||node.clientHeight<=0;}

void start();
