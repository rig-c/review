import { loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import type { CompareResponse, CompareSide } from '../src/compare.ts';
import type { CompareFeedback, CompareSession } from '../src/compare-session.ts';
import { clockForAnimation, lastFrame, timeAtFrame } from '../src/frame-clock.ts';
import { commonDomain, compareSeekStep, feedbackTrace, inspectionFrame, requireCommonTime, type CompareDomain, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection } from '../src/feedback-validation.ts';
import type { StripInterval, StripRequest } from '../src/strip.ts';

import {ComparePresentation,type PresentationState} from '../src/compare-presentation.ts';
import {ReferenceSelectionUnavailable,inspectionReferenceFrame,lastSupportedReferenceFrame,producerFrameAssociations,referenceFrameAtTime,referenceSeekPosition,type ReferenceFrameIndex,type VideoInfo,type VideoFrame} from '../src/reference-frames.ts';
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
let dirty = false, saving = false, ready = false, seeking = false, disposed = false, zoom = 1;
let seekAbort: AbortController | null = null, videoCallback: number | null = null, fallbackCallback: number | null = null;
let latestSeek = 0;
let stripBusy = false;
let referenceFrames:VideoInfo|null=null;
const presentation=new ComparePresentation();
const associations:Record<Side,Map<number,number|null>>={a:new Map(),b:new Map()};
let requestedProducer:{side:Side;frame:number;time:number}|null=null;
let endStopReason:string|null=null;
const traceRows: CompareTrace[] = [];

function message(value: string, error = false): void { text('message', value); el('message').classList.toggle('error', error); }
function savedState(): void { text('save-state', dirty ? '미제출 변경' : session.updatedAt ? '제출됨' : '미제출'); el('save-state').classList.toggle('dirty', dirty); button('submit').disabled = saving || session.feedbackWarnings.length > 0; button('submit').title = session.feedbackWarnings.length ? '경고가 있는 기존 피드백을 삭제한 뒤 올바른 대상으로 다시 추가해 주세요.' : ''; }
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
  text('clock-source', value.source === 'video-frame' ? 'requestVideoFrameCallback · 실제 mediaTime' : 'currentTime fallback');
  text('trace', JSON.stringify({ seekStep: compareSeekStep, referenceClock: value.source, frames: { a: currentFrame('a'), b: currentFrame('b') }, reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')}, requestedProducer,endStopReason, decodedIndex:referenceFrames?referenceFrameAtTime(referenceFrames,value.reference)?.index??null:null, recent: traceRows }, null, 2));
  updateFeedbackAvailability();frameControls();
}

function updateFeedbackAvailability(): void { button('add-feedback').disabled = !feedbackTrace(ready, seeking || video.seeking, trace); }
function invalidateTrace(reason: string): void {
  trace = null; updateFeedbackAvailability();
  for (const id of ['reference-time', 'a-time', 'b-time']) text(id, '— s');
  for (const side of ['a', 'b'] as const) text(`${side}-frame`, 'frame unknown · 동기화 없음');
  text('time', '— / — s'); text('clock-source', reason);
  text('trace', JSON.stringify({ status: reason, current: null, previous: traceRows }, null, 2));
}

function stop(): void { video.pause(); players.a?.pause(); players.b?.pause(); button('play').textContent = '▶'; button('play').setAttribute('aria-label', '참조 영상과 비교 재생'); }
function failPair(error: unknown): void { stop(); ready = false; invalidateTrace('비교 중단 · 유효한 동기화 시각 없음'); button('play').disabled = true; input('scrub').disabled = true; button('seek').disabled = true;button('frame-seek').disabled=true; message(`비교 중단: ${describe(error)}`, true); }

function renderPresentation(state:PresentationState):void {
 const target=state.target?.time,last=state.lastDrawn;
 if(target!==undefined){text('reference-time',`${target.toFixed(6)} s`);text('time',`${target.toFixed(4)} / ${domain!.end.toFixed(4)} s`);input('scrub').value=String(target);}
 const delta=target===undefined||!last?null:Math.max(Math.abs(last.a-target),Math.abs(last.b-target))*24;
 const visible=last?`${last.reference.toFixed(6)} s`:'unknown';
 text('sync-status',`${state.status==='held'?'Held':state.status==='drawn'?(state.lastLatenessMs>0?'Drawn late':'Drawn'):'Unknown'} pose ${visible} · Δ ${delta===null?'—':delta.toFixed(2)} (1/24 s units) · dropped ${state.dropped} · deadline misses ${state.deadlineMisses}/${state.callbacks} · replay ${state.lastPoseMs.toFixed(1)} ms · lateness ${state.lastLatenessMs.toFixed(1)} ms`);
 el('sync-status').classList.toggle('error',state.status==='held'||state.lastLatenessMs>0||state.status==='failed');
 if(!state.inspection){
  trace=null;updateFeedbackAvailability();
  for(const side of ['a','b'] as const){text(`${side}-time`,last?`${last[side].toFixed(6)} s · held`:'unknown');const decoded=last&&referenceFrames?referenceFrameAtTime(referenceFrames,last.reference):null,frame=decoded?associations[side].get(decoded.index)??null:null;text(`${side}-frame`,last?`Held review F${frame??'—'}`:'Review frame unknown');}
  text('clock-source','Reference continues; feedback requires a fresh drawn pair or paused inspection.');
 }
 text('sync-warning',state.status==='held'?'Holding the last drawn pose: deterministic replay exceeded the real presentation budget. Pause and inspect an exact frame; the current replay cannot keep up.':state.lastLatenessMs>0?'The pair finished drawing after its presentation deadline. Pause for exact inspection.':'');
 text('trace',JSON.stringify({presentation:state,playerTimes:{a:players.a?.time??null,b:players.b?.time??null},rawFloorFrames:{a:currentFrame('a'),b:currentFrame('b')},reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')},requestedProducer,endStopReason,decodedIndex:referenceFrames&&target!==undefined?referenceFrameAtTime(referenceFrames,target)?.index??null:null},null,2));
 frameControls();
}
function acceptReference(sample: ReferenceSample,deadline:number|null=null,presentedFrames:number|null=null): void {
 if(!ready||seeking||video.seeking||!domain||!players.a||!players.b)return;
 if(sample.time>domain.end){stopAtSupportedEnd();return;}
 if(trace?.reference===sample.time&&trace.source===sample.source)return;
 try{const state=presentation.present(sample,deadline,presentedFrames,players.a,players.b,domain,()=>performance.now());if(state.inspection)renderTrace(state.inspection);renderPresentation(state);}catch(error){failPair(error);renderPresentation(presentation.snapshot());}
}

function stopAtSupportedEnd():void {
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
    const timer = setTimeout(() => finish(new Error('참조 영상의 seek / decoded-frame 응답을 받지 못했습니다.')), 10000);
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); video.removeEventListener('error', onError); signal.removeEventListener('abort', onAbort); if (handle !== null) video.cancelVideoFrameCallback(handle); };
    const finish = (error?: Error) => { if (error) { cleanup(); reject(error); } else if (seeked && presented) { cleanup(); resolve(presented); } };
    const onSeeked = () => { seeked = true; if (!hasFrames) presented = { time: video.currentTime, source: 'current-time' }; finish(); };
    const onError = () => finish(new Error('참조 영상 seek 실패'));
    const onAbort = () => finish(new DOMException('Newer reference seek requested', 'AbortError'));
    if (signal.aborted) { finish(new DOMException('Reference seek aborted', 'AbortError')); return; }
    signal.addEventListener('abort', onAbort, { once: true }); video.addEventListener('seeked', onSeeked); video.addEventListener('error', onError, { once: true });
    try {
      // Registered while paused before changing currentTime, so a fast seek
      // cannot present its new frame before this callback is installed.
      if (hasFrames) handle = video.requestVideoFrameCallback((_now, metadata) => { handle = null; const actual=selected?referenceFrameAtTime(referenceFrames!,metadata.mediaTime):null;if(selected&&actual?.index!==selected.index){finish(new Error('REFERENCE_FRAME_MISMATCH: decoded frame does not match selected reference PTS'));return;}presented = { time: metadata.mediaTime, source: 'video-frame' }; finish(); });
      video.currentTime = seekPosition;
      if (!video.seeking) { seeked = true; if (!hasFrames) presented = { time: video.currentTime, source: 'current-time' }; finish(); }
    } catch (error) { finish(new Error(describe(error))); }
  });
}

async function seekTo(target: number,producer:{side:Side;frame:number;time:number}|null=null,endReason:string|null=null): Promise<void> {
  if (!domain || !players.a || !players.b || !ready) return;
  let selected:VideoFrame|null=null;
  try { requireCommonTime(target, domain);if(referenceFrames&&typeof video.requestVideoFrameCallback==='function')selected=inspectionReferenceFrame(referenceFrames,target,domain); } catch (error) { message(describe(error), true); return; }
  stop(); seekAbort?.abort(); seekAbort = new AbortController(); const signal = seekAbort.signal, generation = ++latestSeek; seeking = true; invalidateTrace('참조 영상과 양쪽 리그 동기화 중');
  try {
    const sample=await seekReferenceFrame(target,signal,selected);
    if(signal.aborted||generation!==latestSeek)throw new DOMException('Reference seek superseded','AbortError');
    if(sample.time<domain.start||sample.time>domain.end)throw new ReferenceSelectionUnavailable('the presented reference timestamp is outside the shared clip domain; choose a supported time');
    const inspected=presentation.inspect(sample,players.a,players.b,domain,()=>performance.now());
    const value=inspected.inspection!;
    if (generation !== latestSeek || signal.aborted) return;
    requestedProducer=producer;endStopReason=endReason;seeking = false; lastPresented = { time: value.reference, source: value.source }; renderTrace(value);renderPresentation(inspected);
    message(endReason??'참조 영상의 실제 시각으로 양쪽 리그를 정지 검사합니다.');
  } catch (error) { if (!signal.aborted && generation === latestSeek){if(error instanceof ReferenceSelectionUnavailable){stop();invalidateTrace(describe(error));message(describe(error),true);}else failPair(error);} }
  finally { if (generation === latestSeek) { seeking = false; updateFeedbackAvailability();frameControls(); } }
}

function unionBounds(a: PoseBounds, b: PoseBounds): PoseBounds { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }; }
function fit(): void {
  text('zoom-label', `${Math.round(zoom * 100)}%`);
  if (!players.a || !players.b || !assets.a || !assets.b) return;
  const a = assets.a.stage ?? players.a.bounds(), b = assets.b.stage ?? players.b.bounds(); if (!a || !b) return;
  const box = unionBounds(a, b); if (!(box.width > 0 && box.height > 0)) return;
  const width = Math.min(el('a-viewport').clientWidth, el('b-viewport').clientWidth), height = Math.min(el('a-viewport').clientHeight, el('b-viewport').clientHeight);
  const scale = Math.min((width - 22) / box.width, (height - 38) / box.height) * zoom;
  for (const side of ['a', 'b'] as const) {
    const viewport = el(`${side}-viewport`), root = el(`${side}-root`);
    root.style.left = `${viewport.clientWidth / 2 - (box.x + box.width / 2) * scale}px`; root.style.top = `${viewport.clientHeight / 2 + (box.y + box.height / 2) * scale}px`; root.style.transform = `scale(${scale})`; players[side]?.renderer.syncPixelRatio();
  }
}

async function loadSide(side: Side, value: CompareSide): Promise<number> {
  text(`${side}-title`, value.manifest.title);
  if (!value.manifest.model) throw new Error(`${side.toUpperCase()}: compiled model 미제공`);
  const modelUrl = new URL(sideAsset(side, value.manifest.model), location.href).href;
  const loaded = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, base) => { const url = new URL(name, base); if (url.origin !== location.origin || !url.pathname.startsWith(`/compare-assets/${side}/`)) throw new Error(`${side}: model page escapes its package`); return url.href; } });
  assets[side] = loaded; const clip = loaded.animations.find(item => item.name === data.animation); if (!clip) throw new Error(`${side.toUpperCase()}: animation "${data.animation}" 미제공`);
  const player = new RigPlayer(el(`${side}-root`), loaded, { seekStep: compareSeekStep, meshBackend: 'canvas2d' });
  players[side] = player; player.environment(null); player.play(data.animation, { loop: false }); player.pause();
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
    const timer = setTimeout(() => reject(new Error('참조 영상의 metadata / 첫 프레임을 읽지 못했습니다.')), 15000);
    video.addEventListener('loadeddata', () => { clearTimeout(timer); if (!Number.isFinite(video.duration) || video.duration < 0) reject(new Error('참조 영상 길이가 유한하지 않습니다.')); else { el('reference-empty').hidden = true; resolve(video.duration); } }, { once: true });
    video.addEventListener('error', () => { clearTimeout(timer); reject(new Error('참조 영상 로드 실패')); }, { once: true }); video.src = url.href; video.load();
  });
}

function provenance(): void {
  const brief = el('provenance-brief'); brief.replaceChildren();
  for (const side of ['a', 'b'] as const) { const value = data[side].reviewedSource; const p = document.createElement('p'); p.textContent = `${side.toUpperCase()} · ${value.packageRevision} / rig ${value.rig?.sha256.slice(0, 12) ?? '미제공'} / motion ${value.motion?.sha256.slice(0, 12) ?? '미제공'}`; brief.append(p); }
  const p = document.createElement('p'); p.textContent = `REF · ${data.reference.sha256.slice(0, 12)}`; brief.append(p); text('provenance-full', JSON.stringify(session.binding, null, 2));
}

function renderFeedbackSelection(): void {
  const side = select('side').value, kind = select('target-kind').value;
  const catalog = side === 'a' || side === 'b' ? data[side].feedbackCatalog : null;
  const names = catalog && ['bone', 'slot', 'rig'].includes(kind) ? feedbackTargetNames(catalog, kind as CompareFeedback['target']['kind']) : null;
  const list = el<HTMLDataListElement>('target-names'); list.replaceChildren();
  for (const name of names ?? []) { const option = document.createElement('option'); option.value = name; list.append(option); }
  const field = input('target-name'); field.value = kind === 'rig' && catalog ? catalog.rig : ''; field.readOnly = kind === 'rig'; field.disabled = !names?.length;
  text('target-hint', !catalog || !kind ? '대상 빌드와 종류를 먼저 선택해 주세요.' : names === null ? '실제 대상 목록 미제공 · 본 / 슬롯 피드백을 추가할 수 없습니다.' : !names.length ? '이 종류의 대상이 없습니다.' : kind === 'rig' ? '선택한 패키지의 실제 리그 식별자입니다.' : `${side.toUpperCase()} 리그의 ${names.length}개 실제 이름 중 선택하거나 정확히 입력해 주세요.`);
  const last = catalog ? feedbackLastFrame(catalog, data.animation) : null;
  for (const id of ['frame-start', 'frame-end']) { if (last === null) input(id).removeAttribute('max'); else input(id).max = String(Math.max(0, last)); }
  text('feedback-range-hint', !catalog ? '대상 A / B를 선택하면 프레임 범위를 확인합니다.' : last === null ? '범위 미확인 · 양끝 포함 정수 프레임을 직접 지정합니다. FPS는 추정하지 않습니다.' : last < 0 ? '명시 클록과 선택 clip이 겹치는 프레임이 없습니다.' : `${side.toUpperCase()}의 명시 클록과 현재 clip 기준 F0–F${last} · 양끝 포함`);
}

function renderFeedback(): void {
  const list = el('feedback-list'); list.replaceChildren();
  const warnings = el('feedback-warnings'); warnings.hidden = session.feedbackWarnings.length === 0;
  warnings.textContent = session.feedbackWarnings.length ? `기존 피드백 검증 경고 ${session.feedbackWarnings.length}개 · 기록을 그대로 보존했습니다. 아래 경고 항목을 확인하고 삭제 후 올바르게 다시 추가해야 제출할 수 있습니다. JSON / Markdown으로 원문과 경고를 보관할 수 있습니다.` : '';
  for (const feedback of session.feedback) {
    const row = document.createElement('div'); row.className = 'feedback-item'; const title = document.createElement('strong'); title.textContent = `${feedback.side.toUpperCase()} · ${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const summary = document.createElement('span'); summary.textContent = feedback.summary;
    row.append(title, summary);
    for (const warning of session.feedbackWarnings.filter(value => value.id === feedback.id)) { const note = document.createElement('p'); note.className = 'hint'; note.textContent = `검증 경고 · ${warning.error}`; row.append(note); }
    const details = document.createElement('details'), heading = document.createElement('summary'), source = document.createElement('pre'); heading.textContent = '저장된 피드백과 검사 context'; source.textContent = JSON.stringify(feedback, null, 2); details.append(heading, source);
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.onclick = () => { session.feedback = session.feedback.filter(value => value.id !== feedback.id); session.feedbackWarnings = session.feedbackWarnings.filter(warning => warning.id !== feedback.id); renderFeedback(); markDirty(); };
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
  button('strip-export').disabled = stripBusy; button('strip-export').textContent = stripBusy ? '스트립 생성 중…' : '스트립 다운로드';
}
async function exportStrip(): Promise<void> {
  if (stripBusy) return;
  stripStatus('선택 구간을 확인하는 중입니다.');
  try {
    const format = select('strip-format').value;
    if (format !== 'png' && format !== 'json') throw new Error('PNG 또는 JSON 형식을 선택해 주세요.');
    const intervals: StripInterval[] = [];
    if (select('strip-scope').value === 'feedback') {
      if (!session.feedback.length) throw new Error('내보낼 피드백 구간이 없습니다.');
      for (const feedback of session.feedback) {
        const context = feedback.context;
        if (!context || typeof context !== 'object' || Array.isArray(context) || context.animation !== data.animation) throw new Error(`피드백 ${feedback.id}: 비교 애니메이션과 다르거나 애니메이션 정보가 없습니다. 구간을 다른 애니메이션으로 바꾸지 않았습니다.`);
        intervals.push({ id: feedback.id, feedbackId: feedback.id, basis: feedback.side, frameStart: feedback.frameStart, frameEnd: feedback.frameEnd });
      }
    } else {
      const basis = select('strip-basis').value, start = input('frame-start').value.trim(), end = input('frame-end').value.trim();
      if (basis !== 'a' && basis !== 'b') throw new Error('프레임 구간의 기준 report를 A / B 중 명시적으로 선택해 주세요.');
      if (!start || !end) throw new Error('오른쪽 피드백의 시작·끝 프레임에 스트립 구간을 입력해 주세요.');
      intervals.push({ id: 'selection', basis, frameStart: Number(start), frameEnd: Number(end) });
    }
    for (const interval of intervals) if (!Number.isSafeInteger(interval.frameStart) || !Number.isSafeInteger(interval.frameEnd) || interval.frameStart < 0 || interval.frameEnd < interval.frameStart) throw new Error(`${interval.id}: 양끝을 포함하는 0 이상의 정수 프레임 구간을 지정해 주세요.`);
    const request: StripRequest = { format, sourceHash: data.sourceHash, animation: data.animation, intervals };
    stripBusy = true; updateStripControls(); stripStatus(`${data.animation} · ${intervals.length}개 구간의 ${format.toUpperCase()}를 생성하는 중입니다.`);
    const response = await fetch('/api/compare/strip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => null);
      throw new Error(failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string' ? failure.error : `스트립 내보내기 실패 · HTTP ${response.status}`);
    }
    const mime = format === 'png' ? 'image/png' : 'application/json';
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith(mime)) throw new Error('스트립 응답의 파일 형식이 요청과 다릅니다.');
    downloadStrip(`review-strip.${format}`, await response.blob()); stripStatus(`${data.animation} · ${intervals.length}개 구간의 ${format.toUpperCase()} 다운로드를 요청했습니다. 검토 상태는 변경하지 않았습니다.`);
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
  for (const id of ['strip-scope', 'strip-basis', 'strip-format']) select(id).onchange = () => { updateStripControls(); stripStatus('선택이 변경되었습니다. 다운로드할 구간과 기준 report를 확인해 주세요.'); };
  button('play').onclick = async () => { if (!ready || seeking || !domain) return; if (!video.paused) {const current=lastPresented?.time;stop();if(current!==undefined)void seekTo(current);return; } if (trace && trace.reference >= domain.end) { message('공통 범위 끝입니다. 앞 시각으로 이동해 다시 재생해 주세요.'); return; } try { requestedProducer=null;endStopReason=null;await video.play(); button('play').textContent = 'Ⅱ'; button('play').setAttribute('aria-label', '비교 일시정지'); } catch (error) { failPair(error); } };
  input('scrub').oninput = () => { void seekTo(Number(input('scrub').value)); };
  button('seek').onclick = () => { const value = input('time-input').value.trim(); if (!value) { message('이동할 초를 입력해 주세요.', true); return; } void seekTo(Number(value)); };
  video.addEventListener('ended', () => { stop(); if (typeof video.requestVideoFrameCallback !== 'function') acceptReference({ time: video.currentTime, source: 'current-time' }); });
  input('reference-audio').onchange = () => { video.muted = !input('reference-audio').checked; };
  button('zoom-in').onclick = () => { zoom = Math.min(8, zoom * 1.25); fit(); }; button('zoom-out').onclick = () => { zoom = Math.max(.25, zoom / 1.25); fit(); }; button('fit').onclick = () => { zoom = 1; fit(); };
  for (const side of ['a', 'b'] as const) el(`${side}-viewport`).addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(.25, Math.min(8, zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))); fit(); }, { passive: false });
  select('status').onchange = () => { session.status = select('status').value as CompareSession['status']; markDirty(); };
  select('side').onchange = () => { renderFeedbackSelection(); select('category').value = ''; input('summary').value = ''; }; select('target-kind').onchange = renderFeedbackSelection;
  button('add-feedback').onclick = () => {
    const inspected = feedbackTrace(ready, seeking || video.seeking, trace);
    if (!inspected) { message('참조 영상과 양쪽 리그의 동기화가 성공한 뒤 피드백을 추가해 주세요.', true); return; }
    const side = select('side').value, start = input('frame-start').value.trim(), end = input('frame-end').value.trim(), frameStart = Number(start), frameEnd = Number(end), kind = select('target-kind').value, category = select('category').value, name = input('target-name').value.trim(), summary = input('summary').value.trim();
    if (side !== 'a' && side !== 'b') { message('피드백 대상 A / B를 선택해 주세요.', true); return; }
    if (!start || !end || !Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd) || frameStart < 0 || frameEnd < frameStart) { message('양끝을 포함하는 0 이상의 정수 프레임 구간을 입력해 주세요.', true); return; }
    if (!['bone', 'slot', 'rig'].includes(kind) || !['defect', 'quality'].includes(category) || !name || !summary || /[\r\n]/.test(summary) || summary.length > 1000) { message('대상 종류·실제 이름·분류·1,000자 이내 한 줄 요약을 입력해 주세요.', true); return; }
    const target: CompareFeedback['target'] = { kind: kind as CompareFeedback['target']['kind'], name };
    try { validateFeedbackSelection(data[side].feedbackCatalog, { frameStart, frameEnd, target, animation: data.animation }); } catch (error) { message(describe(error), true); return; }
    session.feedback.push({ id: crypto.randomUUID(), side, frameStart, frameEnd, target, category: category as CompareFeedback['category'], summary, context: { interval: { frameStart, frameEnd, inclusive: true }, animation: data.animation, mediaTime: inspected.reference, clockSource: inspected.source, frame: currentFrame(side), frames: { a: currentFrame('a'), b: currentFrame('b') }, playheads: { reference: inspected.reference, a: inspected.a, b: inspected.b },reviewFrames:{a:currentReviewFrame('a'),b:currentReviewFrame('b')},requestedProducer,decodedIndex:referenceFrames?referenceFrameAtTime(referenceFrames,inspected.reference)?.index??null:null } });
    input('summary').value = ''; markDirty(); renderFeedback(); message('대상 빌드와 양쪽 검토 출처에 연결된 피드백을 추가했습니다.');
  };
  button('submit').onclick = async () => { if (session.feedbackWarnings.length) { message('기존 피드백의 검증 경고를 먼저 확인해 주세요. 경고 항목을 삭제한 뒤 올바르게 다시 추가해야 제출할 수 있습니다.', true); return; } saving = true; savedState(); const payload = JSON.stringify(session); try { const saved = await api<CompareSession>('/api/compare/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload }); if (JSON.stringify(session) === payload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt; message(dirty ? '제출 중 추가한 변경이 있습니다. 다시 제출해 주세요.' : '선택한 검토 상태와 A/B·참조 영상 출처를 제출했습니다.'); } catch (error) { message(`제출 실패: ${describe(error)}`, true); } finally { saving = false; savedState(); } };
  button('export-json').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ ...session, schema: 'rig-review-compare-feedback/1', issues: session.feedback.map(issue) }, null, 2) + '\n', 'application/json'); };
  button('export-markdown').onclick = () => { download(`${session.id}-issues.md`, [`# ${md(data.title)}`, '', 'Ordered A/B and reference provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', 'Validation warnings:', ...JSON.stringify(session.feedbackWarnings, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(feedback => { const entry = issue(feedback); return [`## ${md(entry.title)}`, '', entry.body, '', '---', '']; })].join('\n'), 'text/markdown'); };
  const observer = new ResizeObserver(fit); observer.observe(el('a-viewport')); observer.observe(el('b-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { disposed = true; seekAbort?.abort(); stop(); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); if (fallbackCallback !== null) cancelAnimationFrame(fallbackCallback); for (const side of ['a', 'b'] as const) { players[side]?.dispose(); assets[side]?.dispose(); } observer.disconnect(); });
}

async function start(): Promise<void> {
  try {
    [data, session] = await Promise.all([api<CompareResponse>('/api/compare'), api<CompareSession>('/api/compare/session')]);
    if (data.id !== session.id || data.sourceHash !== session.sourceHash || JSON.stringify(data.binding) !== JSON.stringify(session.binding)) throw new Error('비교 화면과 제출 세션의 원본 출처가 다릅니다. 다시 열어 주세요.');
    text('title', data.title); text('animation', `${data.animation} · A/B 순서와 원본 영상 해시 고정`); document.title = data.title + ' · rig review compare'; select('status').value = session.status; provenance(); bind(); updateStripControls(); stripStatus('오른쪽 시작·끝 프레임 또는 모든 피드백 구간을 선택해 다운로드합니다. 미제출 피드백도 선택에 포함되며, 내보내기로 제출되지는 않습니다.'); renderFeedbackSelection(); renderFeedback(); savedState();
    const [referenceDuration, aDuration, bDuration] = await Promise.all([loadReference(), loadSide('a', data.a), loadSide('b', data.b)]);
    void loadFrameIndex();
    domain = commonDomain(referenceDuration, aDuration, bDuration); input('scrub').max = String(domain.end); input('time-input').max = String(domain.end); text('domain', `공통 범위 0–${domain.end} s · 한쪽만 clamp / loop하지 않음`); ready = true;
    input('scrub').disabled = false; input('time-input').disabled = false; button('seek').disabled = false; button('play').disabled = domain.end === 0;
    await seekTo(0); fit();
  } catch (error) { failPair(error); for (const side of ['a', 'b'] as const) if (!players[side]) text(`${side}-empty`, `${side.toUpperCase()} 비교 리그를 열지 못했습니다.`); text('reference-empty', '참조 영상 또는 비교 입력을 확인해 주세요.'); }
}
void start();
