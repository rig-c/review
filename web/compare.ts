import { loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import type { CompareResponse, CompareSide } from '../src/compare.ts';
import type { CompareFeedback, CompareSession } from '../src/compare-session.ts';
import { clockForAnimation, lastFrame } from '../src/frame-clock.ts';
import { commonDomain, compareSeekStep, feedbackTrace, inspectionFrame, requireCommonTime, seekAfterReference, seekSynchronizedPair, type CompareDomain, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';

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
const traceRows: CompareTrace[] = [];

function message(value: string, error = false): void { text('message', value); el('message').classList.toggle('error', error); }
function savedState(): void { text('save-state', dirty ? '미제출 변경' : session.updatedAt ? '제출됨' : '미제출'); el('save-state').classList.toggle('dirty', dirty); button('submit').disabled = saving; }
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

function frameLabel(side: Side): string {
  const sideData = data[side], player = players[side];
  const clock = clockForAnimation(sideData.report?.clock, sideData.report?.animation, player?.current ?? '', !!player);
  if (!sideData.report?.clock) return 'rate unknown';
  if (!clock) return 'frame unknown · clip 연결 없음';
  const last = lastFrame(clock), frame = currentFrame(side);
  return `F${frame ?? '?'} / ${last ?? '?'}${frame === null ? ' · 범위 밖' : ''}`;
}

function renderTrace(value: CompareTrace): void {
  trace = value; traceRows.push({ ...value }); if (traceRows.length > 12) traceRows.shift();
  text('reference-time', `${value.reference.toFixed(6)} s`);
  for (const side of ['a', 'b'] as const) { text(`${side}-time`, `${value[side].toFixed(6)} s`); text(`${side}-frame`, frameLabel(side)); }
  text('time', `${value.reference.toFixed(4)} / ${domain!.end.toFixed(4)} s`);
  if (document.activeElement !== input('scrub')) input('scrub').value = String(value.reference);
  if (document.activeElement !== input('time-input')) input('time-input').value = value.reference.toFixed(6);
  text('clock-source', value.source === 'video-frame' ? 'requestVideoFrameCallback · 실제 mediaTime' : 'currentTime fallback');
  text('trace', JSON.stringify({ seekStep: compareSeekStep, referenceClock: value.source, frames: { a: currentFrame('a'), b: currentFrame('b') }, recent: traceRows }, null, 2));
  updateFeedbackAvailability();
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
function failPair(error: unknown): void { stop(); ready = false; invalidateTrace('비교 중단 · 유효한 동기화 시각 없음'); button('play').disabled = true; input('scrub').disabled = true; button('seek').disabled = true; message(`비교 중단: ${describe(error)}`, true); }

function acceptReference(sample: ReferenceSample): void {
  if (!ready || seeking || video.seeking || !domain || !players.a || !players.b) return;
  if (sample.time > domain.end) { stop(); void seekTo(domain.end); return; }
  if (trace?.reference === sample.time && trace.source === sample.source) return;
  try { renderTrace(seekSynchronizedPair(sample, players.a, players.b, domain)); } catch (error) { failPair(error); }
}

function observeVideoFrames(): void {
  if (typeof video.requestVideoFrameCallback === 'function') {
    const next = () => { videoCallback = video.requestVideoFrameCallback((_now, metadata) => {
      if (disposed) return;
      lastPresented = { time: metadata.mediaTime, source: 'video-frame' };
      acceptReference(lastPresented); next();
    }); }; next();
  } else {
    // This is a media-clock sampler, not an elapsed-time animation loop. The
    // only time sent to either player is the reference element's currentTime.
    const next = () => { if (disposed) return; acceptReference({ time: video.currentTime, source: 'current-time' }); fallbackCallback = requestAnimationFrame(next); }; next();
  }
}

/** On supported browsers a seek waits for BOTH seeked and the decoded frame. */
function seekReferenceFrame(target: number, signal: AbortSignal): Promise<ReferenceSample> {
  video.pause();
  if (!video.seeking && video.currentTime === target && lastPresented) return Promise.resolve({ ...lastPresented });
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
      if (hasFrames) handle = video.requestVideoFrameCallback((_now, metadata) => { handle = null; presented = { time: metadata.mediaTime, source: 'video-frame' }; finish(); });
      video.currentTime = target;
      if (!video.seeking) { seeked = true; if (!hasFrames) presented = { time: video.currentTime, source: 'current-time' }; finish(); }
    } catch (error) { finish(new Error(describe(error))); }
  });
}

async function seekTo(target: number): Promise<void> {
  if (!domain || !players.a || !players.b || !ready) return;
  try { requireCommonTime(target, domain); } catch (error) { message(describe(error), true); return; }
  stop(); seekAbort?.abort(); seekAbort = new AbortController(); const signal = seekAbort.signal, generation = ++latestSeek; seeking = true; invalidateTrace('참조 영상과 양쪽 리그 동기화 중');
  try {
    const value = await seekAfterReference(target, async value => {
      const sample = await seekReferenceFrame(value, signal);
      if (signal.aborted || generation !== latestSeek) throw new DOMException('Reference seek superseded', 'AbortError');
      return sample;
    }, players.a, players.b, domain);
    if (generation !== latestSeek || signal.aborted) return;
    seeking = false; lastPresented = { time: value.reference, source: value.source }; renderTrace(value);
    message('참조 영상의 실제 시각으로 양쪽 리그를 정지 검사합니다.');
  } catch (error) { if (!signal.aborted && generation === latestSeek) failPair(error); }
  finally { if (generation === latestSeek) { seeking = false; updateFeedbackAvailability(); } }
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

function renderFeedback(): void {
  const list = el('feedback-list'); list.replaceChildren();
  for (const feedback of session.feedback) {
    const row = document.createElement('div'); row.className = 'feedback-item'; const title = document.createElement('strong'); title.textContent = `${feedback.side.toUpperCase()} · ${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const summary = document.createElement('span'); summary.textContent = feedback.summary;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.onclick = () => { session.feedback = session.feedback.filter(value => value.id !== feedback.id); renderFeedback(); markDirty(); };
    row.append(title, summary, document.createElement('br'), remove); list.append(row);
  }
}

function download(filename: string, content: string, type: string): void { const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const md = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
function issue(feedback: CompareFeedback) {
  const title = `[${feedback.category}][${feedback.side.toUpperCase()}] ${feedback.target.kind}:${feedback.target.name} F${feedback.frameStart}–${feedback.frameEnd} · ${feedback.summary}`;
  const body = [`Side: ${feedback.side.toUpperCase()}`, `Frames: ${feedback.frameStart}–${feedback.frameEnd} (inclusive; explicit producer frame numbers)`, `Target: ${feedback.target.kind} / ${md(feedback.target.name)}`, '', md(feedback.summary), '', 'Ordered compare provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', 'Inspection context:', ...JSON.stringify(feedback.context ?? null, null, 2).split('\n').map(line => '    ' + line)].join('\n');
  return { title, body, labels: [feedback.category] };
}

function bind(): void {
  button('play').onclick = async () => { if (!ready || seeking || !domain) return; if (!video.paused) { stop(); return; } if (trace && trace.reference >= domain.end) { message('공통 범위 끝입니다. 앞 시각으로 이동해 다시 재생해 주세요.'); return; } try { await video.play(); button('play').textContent = 'Ⅱ'; button('play').setAttribute('aria-label', '비교 일시정지'); } catch (error) { failPair(error); } };
  input('scrub').oninput = () => { void seekTo(Number(input('scrub').value)); };
  button('seek').onclick = () => { const value = input('time-input').value.trim(); if (!value) { message('이동할 초를 입력해 주세요.', true); return; } void seekTo(Number(value)); };
  video.addEventListener('ended', () => { stop(); if (typeof video.requestVideoFrameCallback !== 'function') acceptReference({ time: video.currentTime, source: 'current-time' }); });
  input('reference-audio').onchange = () => { video.muted = !input('reference-audio').checked; };
  button('zoom-in').onclick = () => { zoom = Math.min(8, zoom * 1.25); fit(); }; button('zoom-out').onclick = () => { zoom = Math.max(.25, zoom / 1.25); fit(); }; button('fit').onclick = () => { zoom = 1; fit(); };
  for (const side of ['a', 'b'] as const) el(`${side}-viewport`).addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(.25, Math.min(8, zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))); fit(); }, { passive: false });
  select('status').onchange = () => { session.status = select('status').value as CompareSession['status']; markDirty(); };
  const targetName = () => { const side = select('side').value; input('target-name').value = select('target-kind').value === 'rig' && (side === 'a' || side === 'b') ? data[side].manifest.id : ''; };
  select('side').onchange = () => { targetName(); select('category').value = ''; input('summary').value = ''; }; select('target-kind').onchange = targetName;
  button('add-feedback').onclick = () => {
    const inspected = feedbackTrace(ready, seeking || video.seeking, trace);
    if (!inspected) { message('참조 영상과 양쪽 리그의 동기화가 성공한 뒤 피드백을 추가해 주세요.', true); return; }
    const side = select('side').value, start = input('frame-start').value.trim(), end = input('frame-end').value.trim(), frameStart = Number(start), frameEnd = Number(end), kind = select('target-kind').value, category = select('category').value, name = input('target-name').value.trim(), summary = input('summary').value.trim();
    if (side !== 'a' && side !== 'b') { message('피드백 대상 A / B를 선택해 주세요.', true); return; }
    if (!start || !end || !Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd) || frameStart < 0 || frameEnd < frameStart) { message('양끝을 포함하는 0 이상의 정수 프레임 구간을 입력해 주세요.', true); return; }
    if (!['bone', 'slot', 'rig'].includes(kind) || !['defect', 'quality'].includes(category) || !name || !summary || /[\r\n]/.test(summary) || summary.length > 1000) { message('대상 종류·실제 이름·분류·1,000자 이내 한 줄 요약을 입력해 주세요.', true); return; }
    session.feedback.push({ id: crypto.randomUUID(), side, frameStart, frameEnd, target: { kind: kind as CompareFeedback['target']['kind'], name }, category: category as CompareFeedback['category'], summary, context: { animation: data.animation, mediaTime: inspected.reference, clockSource: inspected.source, frame: currentFrame(side), frames: { a: currentFrame('a'), b: currentFrame('b') }, playheads: { reference: inspected.reference, a: inspected.a, b: inspected.b } } });
    input('summary').value = ''; markDirty(); renderFeedback(); message('대상 빌드와 양쪽 검토 출처에 연결된 피드백을 추가했습니다.');
  };
  button('submit').onclick = async () => { saving = true; savedState(); const payload = JSON.stringify(session); try { const saved = await api<CompareSession>('/api/compare/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload }); if (JSON.stringify(session) === payload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt; message(dirty ? '제출 중 추가한 변경이 있습니다. 다시 제출해 주세요.' : '선택한 검토 상태와 A/B·참조 영상 출처를 제출했습니다.'); } catch (error) { message(`제출 실패: ${describe(error)}`, true); } finally { saving = false; savedState(); } };
  button('export-json').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ ...session, schema: 'rig-review-compare-feedback/1', issues: session.feedback.map(issue) }, null, 2) + '\n', 'application/json'); };
  button('export-markdown').onclick = () => { download(`${session.id}-issues.md`, [`# ${md(data.title)}`, '', 'Ordered A/B and reference provenance:', ...JSON.stringify(session.binding, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(feedback => { const entry = issue(feedback); return [`## ${md(entry.title)}`, '', entry.body, '', '---', '']; })].join('\n'), 'text/markdown'); };
  const observer = new ResizeObserver(fit); observer.observe(el('a-viewport')); observer.observe(el('b-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { disposed = true; seekAbort?.abort(); stop(); if (videoCallback !== null) video.cancelVideoFrameCallback(videoCallback); if (fallbackCallback !== null) cancelAnimationFrame(fallbackCallback); for (const side of ['a', 'b'] as const) { players[side]?.dispose(); assets[side]?.dispose(); } observer.disconnect(); });
}

async function start(): Promise<void> {
  try {
    [data, session] = await Promise.all([api<CompareResponse>('/api/compare'), api<CompareSession>('/api/compare/session')]);
    if (data.id !== session.id || data.sourceHash !== session.sourceHash || JSON.stringify(data.binding) !== JSON.stringify(session.binding)) throw new Error('비교 화면과 제출 세션의 원본 출처가 다릅니다. 다시 열어 주세요.');
    text('title', data.title); text('animation', `${data.animation} · A/B 순서와 원본 영상 해시 고정`); document.title = data.title + ' · rig review compare'; select('status').value = session.status; provenance(); bind(); renderFeedback(); savedState();
    const [referenceDuration, aDuration, bDuration] = await Promise.all([loadReference(), loadSide('a', data.a), loadSide('b', data.b)]);
    domain = commonDomain(referenceDuration, aDuration, bDuration); input('scrub').max = String(domain.end); input('time-input').max = String(domain.end); text('domain', `공통 범위 0–${domain.end} s · 한쪽만 clamp / loop하지 않음`); ready = true;
    input('scrub').disabled = false; input('time-input').disabled = false; button('seek').disabled = false; button('play').disabled = domain.end === 0;
    await seekTo(0); fit();
  } catch (error) { failPair(error); for (const side of ['a', 'b'] as const) if (!players[side]) text(`${side}-empty`, `${side.toUpperCase()} 비교 리그를 열지 못했습니다.`); text('reference-empty', '참조 영상 또는 비교 입력을 확인해 주세요.'); }
}
void start();
