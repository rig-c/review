import {PartExplorer,loadPartCatalog} from './part-selection.ts';
import {cameraFrame,cameraSignature,cameraFromSignature,assertCameraView,boundsFitSignature,dragSignature,zoomSignature,type CameraFrame,type CameraSignature,type PaneCamera} from './camera-view.ts';
import { loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import type { CompareResponse, CompareSide } from '../src/compare.ts';
import type { CompareFeedback, CompareSession } from '../src/compare-session.ts';
import { clockForAnimation, lastFrame, timeAtFrame } from '../src/frame-clock.ts';
import { commonDomain, drawSynchronizedPair, compareSeekStep, feedbackTrace, inspectionFrame, requireCommonTime, type InspectionPlayer, type CompareDomain, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection } from '../src/feedback-validation.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';

import {bindAppearance,bindPan,bindStageLayout,bindInspectorTabs,syncStageLayout,idleAvailable} from './view-controls.ts';
import {RigOverlays} from './rig-overlays.ts';
import {connectControl} from './control.ts';
import type {ControlCommand,ControlInspection,ControlView} from '../src/control.ts';
import {connectInspectionPersistence,serializableView,numericCamera,restoredZoom,restoreTransaction,captureInputs,restoreInputs,type InspectionBookmark,type InspectionBinding,type PersistenceConnection} from './inspection-persistence.ts';
import {RendererBadge} from './renderer-status.ts';
import {ComparePresentation,type PresentationState} from '../src/compare-presentation.ts';
import {nextReferenceInterval,ReferenceSelectionUnavailable,inspectionReferenceFrame,lastSupportedReferenceFrame,producerFrameAssociations,referenceFrameAtTime,referenceSeekPosition,type ReferenceFrameIndex,type VideoInfo,type VideoFrame} from '../src/reference-frames.ts';
type Side = 'a' | 'b';
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id); if (!node) throw new Error(`Missing compare UI element: ${id}`); return node as T;
};
const input = (id: string) => el<HTMLInputElement>(id), select = (id: string) => el<HTMLSelectElement>(id), button = (id: string) => el<HTMLButtonElement>(id);
const text = (id: string, value: string) => { el(id).textContent = value; };
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
let appearance:ReturnType<typeof bindAppearance>|null=null,controlDispose:(()=>void)|null=null;
const viewDisposers:(()=>void)[]=[];
let parts:PartExplorer|null=null;
const overlays:Partial<Record<Side,RigOverlays>>={};
function inspectionPlayer(side:Side):InspectionPlayer {const player=players[side];if(!player)throw new Error('Part player unavailable');return {get time(){return player.time;},pause:()=>player.pause(),seek:time=>player.seek(time),draw:()=>{player.draw();parts?.present(side);}};}
const layers={images:true,mesh:false,bones:false,meshOpacity:.65};
let stripBusy = false;
let persistence:PersistenceConnection|null=null,submittedBaseline:CompareSession|null=null,draftConflict=false;
let referenceFrames:VideoInfo|null=null;
const presentation=new ComparePresentation();
const rendererBadges={a:new RendererBadge(),b:new RendererBadge()};
const associations:Record<Side,Map<number,number|null>>={a:new Map(),b:new Map()};
let requestedProducer:{side:Side;frame:number;time:number}|null=null;
let endStopReason:string|null=null;
const traceRows: CompareTrace[] = [];

function message(value: string, error = false): void { text('message', value); el('message').classList.toggle('error', error); }
function savedState(): void { text('save-state', dirty ? 'Unsubmitted changes' : session.updatedAt ? 'Submitted' : 'Not submitted'); el('save-state').classList.toggle('dirty', dirty); button('submit').disabled = saving || draftConflict || session.feedbackWarnings.length > 0; button('submit').title = session.feedbackWarnings.length ? 'Delete feedback with validation warnings, then add it again with a valid target.' : ''; }
function markDirty(): void { dirty = true; savedState(); }
async function api<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(path, init); if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); return await response.json() as T; }

function sideAsset(side: Side, path: string): string {
  if (!path || path.startsWith('/') || /[\\%?#\x00-\x1f:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid ${side} asset path: ${path}`);
  const base = `/compare-assets/${side}/`;
  if (data[side].assetsBase !== base) throw new Error(`Unexpected ${side} assets base`);
  return base + path.split('/').map(encodeURIComponent).join('/');
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
  updateFeedbackAvailability();frameControls();
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
  for(const side of ['a','b'] as const){text(`${side}-time`,last?`${last[side].toFixed(6)} s · ${state.status==='held'?'held':'drawn; feedback unavailable'}`:'unknown');const decoded=last&&referenceFrames?referenceFrameAtTime(referenceFrames,last.reference):null,frame=decoded?associations[side].get(decoded.index)??null:null;text(`${side}-frame`,last?`${state.status==='held'?'Held':'Drawn'} review F${frame??'—'}`:'Review frame unknown');}
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
 try{const state=presentation.present(sample,deadline,presentedFrames,inspectionPlayer('a'),inspectionPlayer('b'),domain,()=>performance.now(),nextReferenceInterval(referenceFrames,sample.time,video.playbackRate));if(state.inspection)renderTrace(state.inspection);renderPresentation(state);}catch(error){failPair(error);renderPresentation(presentation.snapshot());}
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
    const inspected=presentation.inspect(sample,inspectionPlayer('a'),inspectionPlayer('b'),domain,()=>performance.now());
    const value=inspected.inspection!;
    if (generation !== latestSeek || signal.aborted) return;
    requestedProducer=producer;endStopReason=endReason;seeking = false; lastPresented = { time: value.reference, source: value.source }; renderTrace(value);renderPresentation(inspected);
    message(endReason??'Inspecting both rigs at the actual reference video time.');
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

async function loadSide(side: Side, value: CompareSide): Promise<number> {
  text(`${side}-title`, value.manifest.title);
  if (!value.manifest.model) throw new Error(`${side.toUpperCase()}: compiled model Not supplied`);
  const modelUrl = new URL(sideAsset(side, value.manifest.model), location.href).href;
  const loaded = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, base) => { const url = new URL(name, base); if (url.origin !== location.origin || !url.pathname.startsWith(`/compare-assets/${side}/`)) throw new Error(`${side}: model page escapes its package`); return url.href; } });
  assets[side] = loaded; const clip = loaded.animations.find(item => item.name === data.animation); if (!clip) throw new Error(`${side.toUpperCase()}: animation "${data.animation}" Not supplied`);
  const player = new RigPlayer(el(`${side}-root`), loaded, { seekStep: compareSeekStep });
  players[side] = player;parts?.register(side,await loadPartCatalog(modelUrl,value.reviewedSource.rig!.sha256,value.feedbackCatalog.slots??[]),player); player.environment(null); player.play(data.animation, { loop: false }); player.pause();
  el(`${side}-empty`).hidden = true; return clip.duration;
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
  const url = new URL(data.reference.url, location.href); if (url.origin !== location.origin || url.pathname !== '/compare-reference' || url.search || url.hash) throw new Error('Reference must be the server-bound local compare video');
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
  const list = el('feedback-list'); list.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  warnings.textContent = session.feedbackWarnings.length ? `${session.feedbackWarnings.length} validation warnings in existing feedback · original records are preserved. Review the marked entries, delete them and add valid replacements before submitting. JSON and Markdown exports preserve both the original records and warnings.` : '';
  for (const feedback of session.feedback) {
    const row = document.createElement('div'); row.className = 'feedback-item'; const title = document.createElement('strong'); title.textContent = `${feedback.side.toUpperCase()} · ${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const summary = document.createElement('span'); summary.textContent = feedback.summary;
    row.append(title, summary);
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `Validation warning · ${warning.error}`; row.append(note); }
    const details = document.createElement('details'), heading = document.createElement('summary'), source = document.createElement('pre'); heading.textContent = 'Saved feedback and inspection context'; source.textContent = JSON.stringify(feedback, null, 2); details.append(heading, source);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.onclick = () => { session.feedback = session.feedback.filter(value => value.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); renderFeedback(); markDirty(); };
    row.append(details, remove); list.append(row);
  }
  savedState();
}

function download(filename: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function downloadStrip(filename: string, content: Blob): void { const url = URL.createObjectURL(content), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function stripStatus(value: string, error = false): void { text('strip-status', value); el('strip-status').setAttribute('role', error ? 'alert' : 'status'); }
function updateStripControls(): void {
  el('strip-panel').setAttribute('aria-busy', String(stripBusy));
  select('strip-scope').disabled = stripBusy; select('strip-format').disabled = stripBusy; select('strip-basis').disabled = stripBusy || select('strip-scope').value === 'feedback';
  button('strip-export').disabled = stripBusy; button('strip-export').textContent = stripBusy ? 'Generating strip…' : 'Download strip';
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
        intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: feedback.side, frameStart: feedback.frameStart, frameEnd: feedback.frameEnd });
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
    const response = await fetch('/api/compare/strip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
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
    session.feedback.push({ id: crypto.randomUUID(), side, frameStart, frameEnd, target, category: category as CompareFeedback['category'], summary, context: { interval: { frameStart, frameEnd, inclusive: true }, animation: data.animation, mediaTime: inspected.reference, clockSource: inspected.source, frame: currentFrame(side), frames: { a: currentFrame('a'), b: currentFrame('b') }, playheads: { reference: inspected.reference, a: inspected.a, b: inspected.b },reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')},requestedProducer,part:parts?.feedback()??null,view:{...serializableView(numericView()),theme:appearance?.get()??'system',layers:{...layers}},decodedIndex:referenceFrames?referenceFrameAtTime(referenceFrames,inspected.reference)?.index??null:null } });
    input('summary').value = ''; markDirty(); renderFeedback(); message('Added feedback bound to the target build and both reviewed sources.');
  };
  button('submit').onclick = async () => { if(draftConflict){message('Resolve the saved local draft conflict before submitting.',true);return;}if (session.feedbackWarnings.length) { message('Resolve validation warnings in existing feedback before submitting. Delete the marked entries and add valid replacements.', true); return; } saving = true; savedState(); const payload = JSON.stringify(session); try { const saved = await api<CompareSession>('/api/compare/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload }); if (JSON.stringify(session) === payload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt;await persistence?.submitted(saved); message(dirty ? 'Changes were made during submission. Submit again.' : 'Submitted the selected review status and A/B/reference-video provenance.'); } catch (error) { message(`Submission failed: ${describe(error)}`, true); } finally { saving = false; savedState(); } };
  button('export-json').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ ...session, schema: 'rig-review-compare-feedback/1', issues: session.feedback.map(issue) }, null, 2) + '\n', 'application/json'); };
  button('export-markdown').onclick = () => { download(`${session.id}-issues.md`, [`# ${md(data.title)}`, '', 'Ordered A/B and reference provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', 'Validation warnings:', ...JSON.stringify(session.feedbackWarnings, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(feedback => { const entry = issue(feedback); return [`## ${md(entry.title)}`, '', entry.body, '', '---', '']; })].join('\n'), 'text/markdown'); };
  appearance=bindAppearance(select('appearance'));
  for(const side of ['a','b'] as const)overlays[side]=new RigOverlays({canvas:el<HTMLCanvasElement>(side+'-overlay'),rigRoot:el(side+'-root')});
  for(const target of ['a','b','reference'] as const)viewDisposers.push(bindPan(el(target+'-viewport'),(dx,dy)=>cameraAction(()=>panCamera(target,dx,dy))));
  viewDisposers.push(bindStageLayout(el('stage-layout'),fit));
  for(const [id,key] of [['layer-images','images'],['layer-mesh','mesh'],['layer-bones','bones']] as const)input(id).onchange=()=>{layers[key]=input(id).checked;redrawOverlays(false);};
  input('idle-repeat').onchange=()=>{renderIdle();if(canRepeatIdle())void playComparison().catch(error=>message(describe(error),true));};
  el('inspector-feedback').addEventListener('focusin',()=>{idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined&&!seeking)void seekTo(current);});
  bindInspector();
  document.addEventListener('visibilitychange',()=>{if(document.hidden){suspendedPreview=!video.paused;stop();}else if(suspendedPreview&&!idleHeld){suspendedPreview=false;void playComparison().catch(error=>message(describe(error),true));}});
  const observer = new ResizeObserver(fit); observer.observe(el('a-viewport')); observer.observe(el('b-viewport'));observer.observe(el('reference-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { persistence?.dispose();disposed = true; seekAbort?.abort();controlDispose?.();appearance?.dispose();viewDisposers.forEach(dispose=>dispose());for(const overlay of Object.values(overlays))overlay.dispose();stop(); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); if (fallbackCallback !== null) cancelAnimationFrame(fallbackCallback); for (const side of ['a', 'b'] as const) { players[side]?.dispose(); assets[side]?.dispose(); } observer.disconnect(); });
}

async function start(): Promise<void> {
  try {
    [data, session] = await Promise.all([api<CompareResponse>('/api/compare'), api<CompareSession>('/api/compare/session')]);
    submittedBaseline=structuredClone(session);
    if (data.id !== session.id || data.sourceHash !== session.sourceHash || JSON.stringify(data.binding) !== JSON.stringify(session.binding)) throw new Error('Comparison and submission session refer to different source identities. Reopen the review.');
    text('title', data.title); text('animation', `${data.animation} · A/B order and reference video hash are fixed`); document.title = data.title + ' · rig review compare'; select('status').value = session.status; provenance(); bind(); parts=new PartExplorer(el('parts-explorer'),el('selected-part'),previous=>{redrawOverlays(true);const part=parts?.value();if(part){activeCamera=part.side==='b'?'b':'a';document.querySelector<HTMLButtonElement>('[data-inspector=rig]')?.click();renderCameraControls();}if(!cameraRestoring&&(previous?.side!==part?.side||previous?.slot!==part?.slot))cameraAction(()=>fitActiveCamera());persistence?.save();},part=>{select('side').value=part.side;select('target-kind').value='slot';renderFeedbackSelection();input('target-name').value=part.slot;document.querySelector<HTMLButtonElement>('[data-inspector=feedback]')?.click();}); updateStripControls(); stripStatus('Choose the entered start–end frames or all feedback ranges to download. Unsubmitted feedback is included; exporting does not submit the review.'); renderFeedbackSelection(); renderFeedback(); savedState();
    const [referenceDuration, aDuration, bDuration] = await Promise.all([loadReference(), loadSide('a', data.a), loadSide('b', data.b)]);
    void loadFrameIndex();
    domain = commonDomain(referenceDuration, aDuration, bDuration); input('scrub').max = String(domain.end); input('time-input').max = String(domain.end); text('domain', `Shared range 0–${domain.end} s · Neither side is independently clamped or looped`); ready = true;
    input('scrub').disabled = false; input('time-input').disabled = false; button('seek').disabled = false; button('play').disabled = domain.end === 0;
    await seekTo(0);activeCamera='a';if(cameraSync)alignCameras();fit();for(const id of ['layer-images','layer-mesh','layer-bones'])input(id).disabled=false;renderIdle();const restored=await setupPersistence();if(!restored&&canRepeatIdle())void playComparison().catch(error=>message(describe(error),true));
    controlDispose=connectControl({sourceHash:data.sourceHash,mode:'compare',observe:controlState,apply:applyControl,onStatus:value=>text('control-state',value)});
  } catch (error) { failPair(error); for (const side of ['a', 'b'] as const) if (!players[side]) text(`${side}-empty`, `${side.toUpperCase()} Could not open comparison rig.`); text('reference-empty', 'Check the reference video and comparison inputs.'); }
}
function sharedBox():PoseBounds|null {const a=assets.a?.stage??players.a?.bounds(),b=assets.b?.stage??players.b?.bounds();return a&&b?unionBounds(a,b):null;}
function paneFrame(target:CameraTarget,hidden=false):CameraFrame|null {
 const viewport=el(target+'-viewport');if(viewport.clientWidth<=0||viewport.clientHeight<=0)return hidden?cameraFrames[target]??null:null;
 const box=target==='reference'?video.videoWidth>0&&video.videoHeight>0?{x:0,y:0,width:video.videoWidth,height:video.videoHeight}:null:players[target]?sharedBox():null;
 if(!box)return null;const frame=cameraFrame(target==='reference'?'image':'world',box,viewport.clientWidth,viewport.clientHeight,target==='reference'?0:22,target==='reference'?0:38);if(frame)cameraFrames[target]=frame;return frame;
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
function fitActiveCamera(target=availableCamera()):void {if(!target)return;const part=parts?.value();if(part?.side===target){const box=parts?.bounds(),frame=paneFrame(target);if(!box||!frame){message('PART_FIT_UNAVAILABLE: selected slot has no positive drawn bounds.',true);return;}updateCamera(target,boundsFitSignature(box,frame,22,38));message('Selected slot fitted.');}else{if(!paneFrame(target))return;updateCamera(target,{zoom:1,pan:{x:0,y:0}});message('View fitted.');}}
function referenceFit():void {const frame=paneFrame('reference');if(!frame)return;const signature=cameraSignature(cameras.reference,frame);video.style.transform=`translate(${signature.pan.x*frame.width}px,${signature.pan.y*frame.height}px) scale(${signature.zoom})`;}
function redrawOverlays(fresh:boolean):void {
 const warnings:string[]=[];let needsCapture=false;
 for(const side of ['a','b'] as const){const overlay=overlays[side],player=players[side];if(!overlay||!player)continue;const root=el(`${side}-root`),project=(x:number,y:number)=>({x:parseFloat(root.style.left||'0')+x*rigScales[side],y:parseFloat(root.style.top||'0')-y*rigScales[side]});const snapshot=fresh?overlay.refresh({player,frame:parts?.frame(side),selectedSlot:parts?.value()?.side===side?parts.value()!.slot:null,bones:(data[side].feedbackCatalog.bones??[]).map(name=>({name})),project,settings:layers}):overlay.redraw({project,settings:layers});warnings.push(...snapshot.warnings);needsCapture ||= snapshot.needsCapture;}
 text('layer-state',warnings.join(' · ')||'Actual last-drawn mesh edges / bone points');
 if(!fresh&&needsCapture&&trace&&!seeking&&!video.seeking&&players.a&&players.b){try{drawSynchronizedPair(inspectionPlayer('a'),inspectionPlayer('b'));redrawOverlays(true);for(const side of ['a','b'] as const)text(`${side}-renderer`,rendererBadges[side].observe('drawn',players[side]!.renderer).label);}catch(error){failPair(error);}}
}
function bindInspector():void {bindInspectorTabs(()=>{if(document.querySelector('[data-inspector="feedback"][aria-selected="true"]')){idleHeld=true;const current=lastPresented?.time;stop();if(current!==undefined&&!seeking)void seekTo(current);}fit();});}

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
function localDraft():boolean{return dirty||!!input('summary').value.trim()||!!input('frame-start').value.trim()||!!input('frame-end').value.trim()||!!input('target-name').value.trim()||!!select('category').value;}
function controlState():ControlInspection {
 const css=(target:CameraTarget)=>{const frame=paneFrame(target,true);if(!frame)return {zoom:1,pan:{x:0,y:0}};const value=cameraSignature(cameras[target],frame);return {zoom:value.zoom,pan:{x:value.pan.x*frame.width,y:value.pan.y*frame.height}};};
 return {part:parts?.value()??null,partGeneration:parts?.observation()?.generation??null,view:numericView(),theme:appearance?.get()??'system',layout:'auto',effectiveLayout:el('stage-layout').dataset.orientation==='vertical'?'column':'row',cameras:{rig:css('a'),a:css('a'),b:css('b'),reference:css('reference')},animation:data.animation,time:trace?.reference??null,playing:!video.paused,loop:canRepeatIdle()?'idle':'off',layers:{images:!!players.a&&layers.images,meshes:!!players.a&&layers.mesh,bones:!!players.a&&layers.bones},ready,seeking:seeking||video.seeking||!!persistence?.restoring(),dirty:localDraft(),busy:saving||stripBusy||!!persistence?.restoring(),feedbackEligible:!persistence?.restoring()&&!!feedbackTrace(ready,seeking||video.seeking,trace),capabilities:{camera:!!players.a&&!!players.b,referenceCamera:video.readyState>=1,animation:false,time:ready,playback:ready,layers:{images:!!players.a&&!!players.b,meshes:!!players.a&&!!players.b,bones:!!players.a&&!!players.b}}};
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
function inspectionBookmark():InspectionBookmark {return {schema:'rig-review-inspection/1',binding:inspectionBinding(),animation:data.animation,time:trace?.reference??presentation.snapshot().lastDrawn?.reference??null,theme:appearance?.get()??'system',layers:{images:layers.images,meshes:layers.mesh,bones:layers.bones},view:numericView(),selection:{part:parts?.value()??null,reference:data.reference.sha256,inspector:document.querySelector<HTMLElement>('[data-inspector][aria-selected=true]')?.dataset.inspector??'view'}};}
async function restoreInspection(bookmark:InspectionBookmark,signal:AbortSignal):Promise<void> {
 await restoreTransaction(async()=>{

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
 parts?.select(bookmark.selection.part??null);
 idleHeld=true;stop();if(bookmark.time!==null){await seekTo(bookmark.time);if(signal.aborted||!trace)throw new Error('Saved reference inspection could not settle');}
 appearance?.set(bookmark.theme);Object.assign(layers,{images:bookmark.layers.images,mesh:bookmark.layers.meshes,bones:bookmark.layers.bones});input('layer-images').checked=layers.images;input('layer-mesh').checked=layers.mesh;input('layer-bones').checked=layers.bones;
 if(bookmark.selection.inspector){for(const tab of document.querySelectorAll<HTMLButtonElement>('[data-inspector]')){const selected=tab.dataset.inspector===bookmark.selection.inspector;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}for(const panel of document.querySelectorAll<HTMLElement>('[data-inspector-panel]'))panel.hidden=panel.dataset.inspectorPanel!==bookmark.selection.inspector;}
 syncStageLayout(el('stage-layout'));fit();
 for(const target of ['a','b','reference'] as const){const camera=bookmark.view.cameras[target],frame=paneFrame(target,true);if(camera&&frame)cameras[target]={zoom:restoredZoom(camera,frame.baseScale,frame.width,frame.height),center:{...camera.center}};}
 cameraSync=bookmark.view.cameraSync??false;activeCamera=bookmark.view.activeCamera==='b'||bookmark.view.activeCamera==='reference'?bookmark.view.activeCamera:'a';
 if(bookmark.selection.part)parts?.assertIdentity(bookmark.selection.part);fit();redrawOverlays(false);idleHeld=true;stop();
 }finally{cameraRestoring=false;}
}
async function setupPersistence():Promise<boolean> {
 persistence=await connectInspectionPersistence({scope:'compare:'+data.a.manifest.id+':'+data.b.manifest.id+':'+data.reference.name,binding:inspectionBinding(),baseline:submittedBaseline!,session:()=>session,reviewDirty:()=>dirty,restoreSession:(value,isDirty)=>{session=value;dirty=isDirty;select('status').value=session.status;renderFeedback();savedState();},bookmark:inspectionBookmark,restoreBookmark:restoreInspection,
 ui:()=>({frameBasis:select('frame-basis').value}),restoreUI:value=>{if(value.frameBasis==='a'||value.frameBasis==='b')select('frame-basis').value=value.frameBasis;frameControls();},afterInputs:()=>{video.muted=!input('reference-audio').checked;const name=input('target-name').value;renderFeedbackSelection();input('target-name').value=name;},onConflict:value=>{draftConflict=value;savedState();},onStatus:value=>{text('draft-state',value);el('draft-state').title=value;}});
 return persistence.restored;
}
void start();
