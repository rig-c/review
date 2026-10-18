import { loadModel, RigPlayer, type ModelAssets, type PoseBounds } from '@rig-c/play';
import type { Checkpoint, Reference, ReviewedSource, ReviewManifest } from '../src/manifest.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import type { ReportEvent, ReportSeeds } from '../src/report.ts';
import { clockForAnimation, frameAtTime, lastFrame as lastProducerFrame, timeAtFrame } from '../src/frame-clock.ts';
import { eventCoordinates, eventSeekTime, eventSelection, eventTimingLabel, reportCounts, reportDraftForMarker, targetLabel } from './report-view.ts';

interface ReviewResponse { manifest: ReviewManifest; sourceHash: string; reviewedSource: ReviewedSource; report: ReportSeeds | null; assetsBase: string; capabilities: { playback: boolean; modeling: false; motion: false; feedback: boolean; audio: boolean } }
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
let data: ReviewResponse;
let session: ReviewSession;
let dirty = false;
let saving = false;
let checkpoint: Checkpoint | undefined;
let assets: ModelAssets | null = null;
let player: RigPlayer | null = null;
let animation = '';
let playing = false;
let time = 0;
let duration = 0;
let lastFrame = 0;
let workspace: 'modeling' | 'motion' = 'modeling';
let view: 'compare' | 'reference' | 'rig' = 'compare';
let zoom = 1;
let cameraCenter: { x: number; y: number } | null = null;
let referenceSize: { width: number; height: number } | null = null;
let video: HTMLVideoElement | null = null;
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
  el('message').classList.toggle('error', error);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

function assetUrl(path: string): string {
  if (!path || path.startsWith('/') || /[\\%?#\x00-\x1f]/.test(path) || /^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsupported package asset path: ${path}`);
  return '/assets/' + path.split('/').map(encodeURIComponent).join('/');
}

function markDirty(): void {
  dirty = true;
  text('dirty', '미제출 변경');
  el('dirty').classList.add('dirty');
  button('save').disabled = saving;
}

function updateSavedState(): void {
  text('dirty', dirty ? '미제출 변경' : session.updatedAt ? '제출됨' : '미제출');
  el('dirty').classList.toggle('dirty', dirty);
  button('save').disabled = saving;
}

function renderProvenance(): void {
  const provenance = session.reviewedSource;
  text('provenance-version', provenance.packageRevision);
  text('provenance-rig', provenance.rig ? provenance.rig.sha256.slice(0, 12) + '…' : '미제공');
  text('provenance-motion', provenance.motion ? provenance.motion.sha256.slice(0, 12) + '…' : '미제공');
  text('provenance-full', JSON.stringify({ sourceHash: session.sourceHash, reviewedSource: provenance }, null, 2));
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
    status.textContent = { pending: '○ 대기', pass: '✓ 통과', fail: '↗ 수정 필요' }[session.checkpoints[point.id]?.outcome ?? 'pending'];
    item.append(label, status); item.onclick = () => { void chooseCheckpoint(point); }; list.append(item);
  }
  if (!data.manifest.checkpoints.length) list.textContent = '확인 항목이 없습니다.';
}

async function chooseCheckpoint(point: Checkpoint): Promise<void> {
  pause(); checkpoint = point; axisInspection = false;
  const url = new URL(location.href); url.searchParams.set('checkpoint', point.id); window.history.replaceState(null, '', url);
  if (point.workspace) setWorkspace(point.workspace);
  if (point.animation) chooseAnimation(point.animation);
  time = point.time ?? 0;
  if (point.reference && select('reference-select').value !== point.reference) {
    select('reference-select').value = point.reference; await showReference(point.reference);
  }
  zoom = Math.min(8, Math.max(.25, point.camera?.zoom ?? 1));
  cameraCenter = point.camera ? { x: point.camera.x, y: point.camera.y } : null;
  seek(time);
  if (point.axis && player && !input('axis-value').disabled) {
    select('axis-select').value = point.axis.id; chooseAxis(); input('axis-value').value = String(point.axis.value); applyAxis();
  }
  fitCamera(); renderCheckpoint(); renderCheckpoints();
}

function renderCheckpoint(): void {
  text('checkpoint-title', checkpoint?.title ?? '패키지 전체 살펴보기');
  text('detail-title', checkpoint?.title ?? '확인 항목 미제공');
  text('detail-note', checkpoint?.note ?? '확인 항목의 메모와 결과를 기록합니다.');
  const entry = checkpoint ? session.checkpoints[checkpoint.id] : undefined;
  el<HTMLTextAreaElement>('checkpoint-note').value = entry?.note ?? '';
  el<HTMLTextAreaElement>('checkpoint-note').disabled = !checkpoint;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="outcome"]')) { radio.checked = radio.value === (entry?.outcome ?? 'pending'); radio.disabled = !checkpoint; }
}

function setWorkspace(value: typeof workspace): void {
  workspace = value;
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workspace]')) tab.setAttribute('aria-pressed', String(tab.dataset.workspace === value));
  el('modeling-tools').hidden = value !== 'modeling'; el('motion-tools').hidden = value !== 'motion';
  el('sound-panel').hidden = value !== 'motion';
  el('report-panel').hidden = value !== 'motion';
  el('angle-panel').hidden = value !== 'modeling' || !axisInspection;
}

function setView(value: typeof view): void {
  view = value;
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) item.setAttribute('aria-pressed', String(item.dataset.view === value));
  el('reference-pane').hidden = value === 'rig'; el('rig-pane').hidden = value === 'reference'; fitCamera();
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
  text('reference-label', `입력 포즈 · ${selectedPerson || '인물 미선택'} · t ${frame.t.toFixed(3)} s`);
  if (!person) { el('reference-empty').hidden = false; text('reference-empty', selectedPerson ? '선택 인물이 이 프레임에 없습니다.' : '인물을 선택해 주세요.'); return; }
  el('reference-empty').hidden = true;
  const pairs = [['nose', 'neck'], ['neck', 'r_shoulder'], ['r_shoulder', 'r_elbow'], ['r_elbow', 'r_wrist'], ['neck', 'l_shoulder'], ['l_shoulder', 'l_elbow'], ['l_elbow', 'l_wrist'], ['neck', 'r_hip'], ['r_hip', 'r_knee'], ['r_knee', 'r_ankle'], ['neck', 'l_hip'], ['l_hip', 'l_knee'], ['l_knee', 'l_ankle']];
  for (const [a, b] of pairs) { const from = person.joints[a!], to = person.joints[b!]; if (from?.at && to?.at && from.state !== 'missing' && to.state !== 'missing') svgNode('line', { x1: from.at[0], y1: from.at[1], x2: to.at[0], y2: to.at[1], stroke: '#b2deca', 'stroke-width': 2, 'stroke-dasharray': from.state === 'observed' && to.state === 'observed' ? 'none' : '5 4' }, sequenceSvg); }
  for (const [name, joint] of Object.entries(person.joints)) { if (!joint.at || joint.state === 'missing') continue; const dot = svgNode('circle', { cx: joint.at[0], cy: joint.at[1], r: 4, fill: joint.state === 'observed' ? '#c6e6d7' : '#294535', stroke: '#c6e6d7', 'stroke-width': 1.5 }, sequenceSvg); const title = document.createElementNS(sequenceSvg.namespaceURI, 'title'); title.textContent = `${name}: ${joint.state}${joint.score === undefined ? '' : ` · score ${joint.score}`}`; dot.append(title); }
}

async function showReference(id: string): Promise<void> {
  const generation = ++referenceGeneration;
  video?.pause(); video = null; referenceSize = null; sequence = null; sequenceSvg = null; lastPoseFrame = -1; el('person-control').hidden = true;
  const content = el('reference-content'); content.replaceChildren();
  const reference = data.manifest.references.find(item => item.id === id);
  el('reference-empty').hidden = false;
  if (!reference) { text('reference-empty', '원본 자료가 제공되지 않았습니다.'); text('reference-info', '이미지 · 영상 · 입력 포즈를 패키지에 연결할 수 있습니다.'); return; }
  text('reference-label', reference.label + (reference.type === 'pose' ? ' · 정적 입력 포즈' : ' · 원본'));
  text('reference-empty', '원본 자료를 읽는 중…');
  text('reference-info', `${reference.type} · ${reference.path}`);
  const fail = () => { if (generation !== referenceGeneration) return; el('reference-empty').hidden = false; text('reference-empty', '자료를 열지 못했습니다. 패키지의 파일을 확인해 주세요.'); };
  try {
    if (reference.type === 'pose') {
      const response = await fetch(assetUrl(reference.path)); if (!response.ok) throw new Error(`Pose reference HTTP ${response.status}`);
      const value: unknown = await response.json(); if (generation !== referenceGeneration) return;
      const canonical = readSequence(value);
      if (canonical) {
        sequence = canonical; referenceSize = { width: canonical.width, height: canonical.height };
        sequenceSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); sequenceSvg.setAttribute('width', String(canonical.width)); sequenceSvg.setAttribute('height', String(canonical.height)); sequenceSvg.setAttribute('viewBox', `0 0 ${canonical.width} ${canonical.height}`); sequenceSvg.setAttribute('role', 'img'); sequenceSvg.setAttribute('aria-label', '원본 입력 포즈 시퀀스 · 상태와 confidence 보존');
        content.append(sequenceSvg); const people = [...new Set(canonical.frames.flatMap(frame => frame.people.map(person => person.id)))];
        select('person-select').replaceChildren(); if (people.length !== 1) select('person-select').append(option('', '인물 선택')); for (const id of people) select('person-select').append(option(id, id)); selectedPerson = people.length === 1 ? people[0]! : ''; select('person-select').value = selectedPerson; el('person-control').hidden = false;
        if (!player) duration = canonical.frames[canonical.frames.length - 1]!.t - canonical.frames[0]!.t;
        text('reference-info', `${reference.path} · picture-px / top-left / y↓ · ${canonical.frames.length} frames${canonical.camera ? ' · camera 메타데이터 보존 (정규화 중복 적용 없음)' : ''}`);
        renderSequenceFrame(); fitCamera(); renderTransport(); return;
      }
      const pose = readPose(value);
      referenceSize = { width: pose.width, height: pose.height };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', String(pose.width)); svg.setAttribute('height', String(pose.height)); svg.setAttribute('viewBox', `0 0 ${pose.width} ${pose.height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', reference.label + ' · 변경하지 않은 정적 입력 포즈');
      const byId = new Map(pose.joints.map(joint => [joint.id, joint]));
      for (const joint of pose.joints) {
        if (joint.parent) { const parent = byId.get(joint.parent)!; svgNode('line', { x1: parent.x, y1: parent.y, x2: joint.x, y2: joint.y, stroke: '#b2deca', 'stroke-width': 2 }, svg); }
        const dot = svgNode('circle', { cx: joint.x, cy: joint.y, r: 4, fill: '#203d31', stroke: '#caead9', 'stroke-width': 1.5 }, svg);
        const title = document.createElementNS(svg.namespaceURI, 'title'); title.textContent = joint.id; dot.append(title);
      }
      content.append(svg); el('reference-empty').hidden = true; fitCamera();
    } else if (reference.type === 'image') {
      const image = new Image(); image.alt = reference.label; image.onload = () => { if (generation !== referenceGeneration) return; referenceSize = { width: image.naturalWidth, height: image.naturalHeight }; image.width = image.naturalWidth; image.height = image.naturalHeight; el('reference-empty').hidden = true; fitCamera(); }; image.onerror = fail; image.src = assetUrl(reference.path); content.append(image);
    } else {
      const media = document.createElement('video'); media.controls = true; media.muted = true; media.preload = 'metadata'; media.playsInline = true;
      media.onloadedmetadata = () => { if (generation !== referenceGeneration) return; referenceSize = { width: media.videoWidth, height: media.videoHeight }; media.width = media.videoWidth; media.height = media.videoHeight; if (Number.isFinite(media.duration) && !player) duration = media.duration; media.currentTime = Math.min(time, Math.max(0, media.duration - .01)); el('reference-empty').hidden = true; fitCamera(); renderTransport(); };
      media.onerror = fail; media.src = assetUrl(reference.path); video = media; content.append(media);
    }
  } catch (error) { fail(); message(errorText(error), true); }
}

function referenceFit(): void {
  if (!referenceSize) return;
  const viewport = el('reference-viewport'), content = el('reference-content');
  const scale = Math.min((viewport.clientWidth - 24) / referenceSize.width, (viewport.clientHeight - 56) / referenceSize.height) * zoom;
  content.style.left = `${(viewport.clientWidth - referenceSize.width * scale) / 2}px`;
  content.style.top = `${(viewport.clientHeight - referenceSize.height * scale) / 2}px`;
  content.style.transform = `scale(${scale})`;
}

function fitCamera(): void {
  referenceFit(); text('zoom-value', `${Math.round(zoom * 100)}%`);
  if (!player || !assets) return;
  const box: PoseBounds | null = assets.stage ?? player.bounds(); if (!box || box.width <= 0 || box.height <= 0) return;
  const viewport = el('rig-viewport');
  const scale = Math.min((viewport.clientWidth - 28) / box.width, (viewport.clientHeight - 58) / box.height) * zoom;
  const center = cameraCenter ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const root = el('rig-root'); root.style.left = `${viewport.clientWidth / 2 - center.x * scale}px`; root.style.top = `${viewport.clientHeight / 2 + center.y * scale}px`; root.style.transform = `scale(${scale})`;
  player.renderer.syncPixelRatio();
}

function renderTransport(): void {
  const end = duration > 0 ? ` / ${duration.toFixed(4)}` : '';
  text('time-label', sequence ? `입력 ${(time + sequence.frames[0]!.t).toFixed(4)} ↔ ${time.toFixed(4)}${end} s` : `${time.toFixed(4)}${end} s`);
  input('scrub').max = String(Math.max(duration, .001)); input('scrub').value = String(time); input('scrub').disabled = duration <= 0;
  button('play').disabled = (!player && !video && !sequence) || duration <= 0;
  renderFrameTransport();
}

function renderFrameTransport(): void {
  const clock = activeFrameClock();
  const last = lastProducerFrame(clock), frame = frameAtTime(clock, time);
  el('frame-controls').hidden = last === null;
  if (!clock) { text('frame-label', data.report?.clock ? data.report.animation ? 'frame unknown · report와 현재 clip 불일치' : 'frame unknown · report animation 미제공' : 'rate unknown'); return; }
  if (last === null) { text('frame-label', 'F? / ? · frame range unknown'); return; }
  text('frame-label', `F${frame === null ? '?' : frame} / ${last}${frame === null ? ' · 범위 밖' : ''}`);
  text('frame-clock-label', clock.kind === 'uniform' ? `${clock.fps} fps · frame0 ${clock.frame0} s` : `frameTimes · ${clock.frameTimes.length}개 명시 시각`);
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
  if (exact === null) { message('명시된 클록 범위의 정수 프레임을 선택해 주세요.', true); renderFrameTransport(); return; }
  pause();
  if ((duration > 0 && exact > duration) || (video && video.readyState >= 1 && Number.isFinite(video.duration) && exact > video.duration)) { message(`F${frame}의 명시 시각 ${exact} s가 현재 자료 범위 밖입니다. 다른 시각으로 바꾸지 않았습니다.`, true); renderFrameTransport(); return; }
  seek(exact);
  message(`F${frame} · 명시된 시각 ${exact} s${!player && !video && !sequence ? ' (재생 자료 없음 · 시각 표시만)' : ''}`);
}

function chooseAnimation(name: string): void {
  pause(); animation = name; axisInspection = false; el('angle-panel').hidden = true;
  const runtimeAnimation = assets?.animations.find(item => item.name === name);
  duration = runtimeAnimation?.duration ?? data.manifest.animations.find(item => item.id === name)?.duration ?? 0;
  select('animation-select').value = name;
  if (player && runtimeAnimation) { player.play(name, { loop: false }); player.pause(); player.draw(); }
  else if (player && name) message(`리그에 애니메이션 "${name}"이 없습니다.`, true);
  time = 0; renderTransport(); renderCues();
}

function seek(value: number): void {
  time = duration > 0 ? Math.min(Math.max(0, value), duration) : Math.max(0, value);
  if (player && player.current) { try { player.seek(time); player.draw(); } catch (error) { message(errorText(error), true); } }
  if (video && video.readyState >= 1 && Number.isFinite(video.duration)) video.currentTime = Math.min(time, video.duration);
  renderSequenceFrame(); renderTransport();
}

function stopAudio(): void { for (const audio of audioPlaying) audio.pause(); audioPlaying.clear(); }
function pause(): void { playing = false; lastFrame = 0; player?.pause(); video?.pause(); stopAudio(); button('play').textContent = '▶'; button('play').setAttribute('aria-label', '재생'); }

async function audition(clipId: string): Promise<void> {
  const clip = data.manifest.audio.clips.find(item => item.id === clipId); if (!clip) return;
  const audio = new Audio(assetUrl(clip.path)); audio.volume = Number(input('audio-volume').value); audioPlaying.add(audio);
  audio.onended = () => audioPlaying.delete(audio); audio.onerror = () => { audioPlaying.delete(audio); message(`음원을 열지 못했습니다: ${clip.label ?? clip.id}`, true); };
  try { await audio.play(); } catch (error) { audioPlaying.delete(audio); message(`음원 재생 거부: ${errorText(error)}`, true); }
}

function activeCues() { return data.manifest.audio.cues.filter(cue => !cue.animation || cue.animation === animation); }
function renderCues(): void {
  const area = el('cues'); area.replaceChildren();
  for (const cue of activeCues()) {
    const clip = data.manifest.audio.clips.find(item => item.id === cue.clip);
    const row = document.createElement('div'); row.className = 'cue';
    const label = document.createElement('span'); label.textContent = `◇ ${cue.id} · ${cue.time.toFixed(2)} s → ${clip?.label ?? cue.clip}`;
    const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = '시점 보기'; jump.onclick = () => { pause(); seek(cue.time); };
    const play = document.createElement('button'); play.type = 'button'; play.textContent = '미리듣기'; play.disabled = !clip; play.onclick = () => { void audition(cue.clip); };
    row.append(label, jump, play); area.append(row);
  }
  if (!activeCues().length) area.textContent = '연결된 사운드 큐가 없습니다.';
  input('sync-audio').disabled = !data.manifest.audio.clips.length;
}

function reportEvents(): ReportEvent[] {
  const field = select('report-category').value;
  return data.report?.categories.filter(category => field === 'all' || category.field === field).flatMap(category => category.events) ?? [];
}

function initReport(): void {
  const report = data.report;
  el('report-browser').hidden = !report; el('report-unavailable').hidden = !!report;
  if (!report) { text('report-summary', '미제공'); return; }
  const counts = reportCounts(report); text('report-summary', `${counts.events}개 이벤트 · 명시된 빈 분류 ${counts.empty.length}개`);
  const source = el<HTMLAnchorElement>('report-source-link'); source.hidden = false; source.href = assetUrl(report.path);
  const filter = select('report-category'); filter.replaceChildren(option('all', '모든 이벤트'));
  for (const category of report.categories) filter.append(option(category.field, `${category.field} · ${category.state === 'empty' ? 'none' : category.events.length}`));
  const empty = el('report-empty-categories'); empty.replaceChildren();
  for (const field of counts.empty) { const label = document.createElement('span'); label.textContent = `${field}: none`; empty.append(label); }
  el('report-missing').hidden = !counts.missing.length;
  text('report-missing', counts.missing.length ? `미제공 필드: ${counts.missing.join(', ')} (none으로 판정하지 않음)` : '');
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
    const targets = document.createElement('small'); targets.textContent = event.targets.length ? event.targets.map(targetLabel).join(' · ') : '본 / 슬롯 매핑 없음';
    const timing = document.createElement('small'); timing.textContent = eventTimingLabel(event); if (!event.seek) timing.className = 'no-time';
    item.append(title, targets, timing); item.onclick = () => chooseReportEvent(event); row.append(item); list.append(row);
  }
  if (!rows.length) { const empty = document.createElement('li'); empty.className = 'hint'; empty.textContent = select('report-category').value === 'all' ? '제공된 이벤트가 없습니다.' : 'none · 제공된 빈 이벤트 배열'; list.append(empty); }
}

function prefillReportEvent(): void {
  if (!selectedReportEvent) return;
  const selection = eventSelection(selectedReportEvent, selectedReportTarget);
  input('feedback-start').value = selection.frames ? String(selection.frames[0]) : '';
  input('feedback-end').value = selection.frames ? String(selection.frames[1]) : '';
  select('feedback-target-kind').value = selection.target?.kind ?? '';
  input('feedback-target-name').value = selection.target?.name ?? '';
  text('report-prefill-note', `${selection.frames ? '명시된 프레임 구간을 가져왔습니다.' : '프레임 정보 없음 · 프레임 구간은 직접 입력해야 합니다.'} ${selection.target ? '명명된 대상을 가져왔습니다.' : selection.targets.length > 1 ? '여러 대상 중 하나를 선택해 주세요.' : '본 / 슬롯 매핑 없음 · 대상을 직접 지정해 주세요.'} defect / quality는 직접 선택합니다.`);
}

function chooseReportEvent(event: ReportEvent): void {
  const draft = reportDraftForMarker(selectedReportEvent?.id ?? null, event.id, { category: select('feedback-category').value, summary: input('feedback-summary').value });
  select('feedback-category').value = draft.category; input('feedback-summary').value = draft.summary;
  pause(); selectedReportEvent = event; selectedReportTime = undefined; selectedReportTarget = undefined;
  const selection = eventSelection(event);
  const times = select('report-time'); times.replaceChildren();
  for (const [index, value] of selection.exactTimes.entries()) times.append(option(String(index), `${index + 1}. ${value} s`));
  times.hidden = !selection.exactTimes.length; el('report-time-label').hidden = times.hidden;
  const targets = select('report-target'); targets.replaceChildren(option('', '대상 선택'));
  for (const [index, target] of selection.targets.entries()) targets.append(option(String(index), targetLabel(target)));
  el('report-target-control').hidden = selection.targets.length <= 1;
  prefillReportEvent(); renderReportSelection(); renderReportEvents();
  if (event.seek) seekReportEvent();
}

function renderReportSelection(): void {
  const event = selectedReportEvent; el('report-selection').hidden = !event; if (!event) return;
  text('report-selection-heading', `${event.field} · ${eventCoordinates(event)}`);
  const exact = eventSeekTime(event, selectedReportTime);
  text('report-timing', event.times?.length ? `${eventTimingLabel(event)} · ${event.times.length}개의 개별 시각을 보존합니다. 시각 사이를 연속 구간으로 확장하지 않습니다.` : eventTimingLabel(event));
  button('report-seek').disabled = exact === null;
  text('report-provenance', `출처 ${event.source.path}${event.source.pointer}${Object.keys(event.provenance).length ? ' · 원본 식별자: ' + JSON.stringify(event.provenance) : ''}`);
  text('report-details', JSON.stringify({ source: event.source, frames: event.frames, times: event.times, timeInterval: event.timeInterval, durationSeconds: event.durationSeconds, targets: event.targets, provenance: event.provenance, details: event.details }, null, 2));
}

function seekReportEvent(): void {
  const event = selectedReportEvent; if (!event) return;
  const exact = eventSeekTime(event, selectedReportTime); if (exact === null) return;
  pause();
  const reportAnimation = data.report?.animation;
  if (reportAnimation && player && !assets?.animations.some(item => item.name === reportAnimation)) { message(`리포트의 애니메이션 "${reportAnimation}"이 현재 리그에 없어 seek하지 않았습니다.`, true); return; }
  if (reportAnimation && assets?.animations.some(item => item.name === reportAnimation) && animation !== reportAnimation) chooseAnimation(reportAnimation);
  if (duration > 0 && exact > duration) { message(`명시 시각 ${exact} s가 현재 자료 범위 ${duration} s 밖입니다. 다른 시각으로 바꿔 seek하지 않았습니다.`, true); return; }
  seek(exact);
  message((player || video || sequence) ? `리포트의 명시 시각 ${exact} s를 선택했습니다.` : `리포트의 명시 시각 ${exact} s · 재생 자료가 없어 시각만 표시합니다.`);
}

function tick(now: number): void {
  if (playing) {
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .1) : 0;
    const previous = time; time = Math.min(duration, time + dt);
    if (player && player.current) { try { player.frame(dt); } catch (error) { pause(); message(errorText(error), true); } }
    if (video && Math.abs(video.currentTime - time) > .15) video.currentTime = Math.min(time, video.duration || time);
    if (input('sync-audio').checked) for (const cue of activeCues()) if ((previous < cue.time && cue.time <= time) || (previous === 0 && cue.time === 0 && dt > 0)) void audition(cue.clip);
    renderSequenceFrame(); renderTransport(); if (time >= duration) pause(); lastFrame = now;
  }
  requestAnimationFrame(tick);
}

async function initPlayer(): Promise<void> {
  if (!data.manifest.model) { text('player-state', '리그 미제공 · 원본 자료 검토 가능'); return; }
  text('player-state', '컴파일된 리그 읽는 중');
  try {
    const modelUrl = new URL(assetUrl(data.manifest.model), location.href).href;
    assets = await loadModel({ modelUrl, setsUrl: null, resolvePage: (name, url) => {
      const target = new URL(name, url); if (target.origin !== location.origin || !target.pathname.startsWith('/assets/')) throw new Error(`Model page escapes local package: ${name}`); return target.href;
    } });
    player = new RigPlayer(el('rig-root'), assets, { meshBackend: 'canvas2d' });
    player.on('event', event => { text('event-log', `런타임 이벤트: ${event.name} · ${event.time.toFixed(2)} s`); });
    const animations = select('animation-select'); animations.replaceChildren();
    for (const item of assets.animations) animations.append(option(item.name, data.manifest.animations.find(a => a.id === item.name)?.label ?? item.name));
    animations.disabled = assets.animations.length === 0;
    if (assets.animations[0]) chooseAnimation(assets.animations[0].name); else player.draw();
    el('rig-empty').hidden = true; text('player-state', '@rig-c/play · 실제 리그');
    const presets = player.sets(); if (presets.length) { select('part-set').replaceChildren(option('', '원본 세트')); for (const set of presets) select('part-set').append(option(set.name, set.name)); select('part-set').disabled = false; }
    const validAxes = data.manifest.axes.filter(axis => assets?.animations.some(item => item.name === axis.animation));
    text('axis-state', validAxes.length ? `${validAxes.length}개 축` : '축 미제공');
    select('axis-select').replaceChildren(); for (const axis of validAxes) select('axis-select').append(option(axis.id, axis.label));
    input('axis-value').disabled = !validAxes.length;
    fitCamera();
  } catch (error) { player?.dispose(); player = null; assets?.dispose(); assets = null; text('player-state', '리그 로드 실패'); text('rig-empty', `리그를 열지 못했습니다: ${errorText(error)}`); message(errorText(error), true); }
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
  for (const feedback of session.feedback) {
    const item = document.createElement('div'); item.className = 'proposal-item'; const title = document.createElement('strong'); title.textContent = `${feedback.category} · ${feedback.target.kind}:${feedback.target.name} · F${feedback.frameStart}–${feedback.frameEnd}`; const description = document.createElement('span'); description.textContent = feedback.summary;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '삭제'; remove.onclick = () => { session.feedback = session.feedback.filter(item => item.id !== feedback.id); markDirty(); renderProposals(); };
    item.append(title, description, document.createElement('br'), remove); area.append(item);
  }
}

function propose(tool: string): void {
  if (tool === 'angle' && !input('axis-value').disabled) { chooseAxis(); return; }
  const choices: Record<string, { target: Feedback['target']['kind']; hint: string }> = {
    mesh: { target: 'slot', hint: '메시 밀도에 대한 한 줄 피드백' }, contour: { target: 'slot', hint: '윤곽 곡률에 대한 한 줄 피드백' }, chest: { target: 'rig', hint: '가슴 위치에 대한 한 줄 피드백' },
    angle: { target: 'rig', hint: '얼굴 / 몸통 각도 변형에 대한 한 줄 피드백' }, pose: { target: 'bone', hint: '입력 포즈와 비교한 한 줄 피드백' }, timing: { target: 'rig', hint: '선택 구간의 타이밍에 대한 한 줄 피드백' }, audio: { target: 'rig', hint: '이벤트 / 음원 연결에 대한 한 줄 피드백' },
  };
  const choice = choices[tool]; if (!choice) return;
  select('feedback-target-kind').value = choice.target; input('feedback-target-name').value = choice.target === 'rig' ? data.manifest.id : ''; input('feedback-summary').placeholder = choice.hint;
  input('feedback-summary').focus(); message('프레임 구간과 실제 본 / 슬롯 이름을 지정해 피드백을 표시합니다. 모션 키는 작성하지 않습니다.');
}

function download(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const markdown = (value: string) => value.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
function issueFields(feedback: Feedback): { title: string; body: string; labels: string[] } {
  const title = `[${feedback.category}] ${feedback.target.kind}:${feedback.target.name} F${feedback.frameStart}–${feedback.frameEnd} · ${feedback.summary}`;
  const body = [
    `- Package: ${markdown(session.id)} / ${markdown(session.revision)}`,
    `- Source hash: ${session.sourceHash}`,
    `- Package revision: ${markdown(session.reviewedSource.packageRevision)}`,
    `- Viewer version: ${markdown(session.reviewedSource.viewerVersion)}`,
    `- Runtime version: ${markdown(session.reviewedSource.runtimeVersion)}`,
    `- Rig: ${session.reviewedSource.rig ? `${markdown(session.reviewedSource.rig.path)} / SHA-256 ${session.reviewedSource.rig.sha256}` : 'not supplied'}`,
    `- Motion: ${session.reviewedSource.motion ? `${markdown(session.reviewedSource.motion.path)} / SHA-256 ${session.reviewedSource.motion.sha256}` : 'not supplied'}`,
    `- Frames: ${feedback.frameStart}–${feedback.frameEnd} (inclusive; producer frame numbers; no inferred FPS)`,
    `- Target: ${feedback.target.kind} / ${markdown(feedback.target.name)}`,
    `- Category: ${feedback.category}`, '', markdown(feedback.summary), '', 'Inspection context:',
    ...JSON.stringify(feedback.context ?? null, null, 2).split('\n').map(line => '    ' + line),
  ].join('\n');
  return { title, body, labels: [feedback.category] };
}

function bind(): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-workspace]')) tab.onclick = () => setWorkspace(tab.dataset.workspace as typeof workspace);
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-view]')) item.onclick = () => setView(item.dataset.view as typeof view);
  for (const item of document.querySelectorAll<HTMLButtonElement>('[data-proposal]')) item.onclick = () => propose(item.dataset.proposal ?? '');
  select('reference-select').onchange = () => { void showReference(select('reference-select').value); };
  select('person-select').onchange = () => { selectedPerson = select('person-select').value; lastPoseFrame = -1; renderSequenceFrame(); };
  select('animation-select').onchange = () => chooseAnimation(select('animation-select').value);
  select('part-set').onchange = () => { try { player?.setSet(select('part-set').value || null); player?.draw(); fitCamera(); } catch (error) { message(errorText(error), true); } };
  select('axis-select').onchange = chooseAxis; input('axis-value').oninput = applyAxis;
  button('zoom-in').onclick = () => { zoom = Math.min(8, zoom * 1.25); fitCamera(); }; button('zoom-out').onclick = () => { zoom = Math.max(.25, zoom / 1.25); fitCamera(); }; button('fit').onclick = () => { zoom = 1; cameraCenter = null; fitCamera(); };
  for (const id of ['reference-viewport', 'rig-viewport']) el(id).addEventListener('wheel', event => { event.preventDefault(); zoom = Math.max(.25, Math.min(8, zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1))); fitCamera(); }, { passive: false });
  input('scrub').oninput = () => { pause(); seek(Number(input('scrub').value)); };
  input('frame-number').onfocus = pause;
  input('frame-number').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); const value = input('frame-number').value.trim(); seekFrame(value ? Number(value) : NaN); } };
  button('frame-jump').onclick = () => { const value = input('frame-number').value.trim(); seekFrame(value ? Number(value) : NaN); };
  input('frame-scrub').oninput = () => seekFrame(Number(input('frame-scrub').value));
  button('play').onclick = () => {
    if (playing) { pause(); return; }
    if (time >= duration) seek(0); playing = true; lastFrame = 0; player?.resume(); button('play').textContent = 'Ⅱ'; button('play').setAttribute('aria-label', '일시정지'); if (video) void video.play().catch(error => { pause(); message(errorText(error), true); });
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
  select('feedback-target-kind').onchange = () => { input('feedback-target-name').value = select('feedback-target-kind').value === 'rig' ? data.manifest.id : ''; };
  button('add-proposal').onclick = () => {
    const start = input('feedback-start').value.trim(), end = input('feedback-end').value.trim(), frameStart = Number(start), frameEnd = Number(end);
    const name = input('feedback-target-name').value.trim(), summary = input('feedback-summary').value.trim();
    if (!start || !end || !Number.isSafeInteger(frameStart) || !Number.isSafeInteger(frameEnd) || frameStart < 0 || frameEnd < frameStart) { message('시작 / 끝 프레임을 0 이상의 정수로 입력하고 끝이 시작보다 앞서지 않게 지정해 주세요.', true); return; }
    if (!['bone', 'slot', 'rig'].includes(select('feedback-target-kind').value) || !['defect', 'quality'].includes(select('feedback-category').value)) { message('대상 종류와 defect / quality 분류를 직접 선택해 주세요.', true); return; }
    if (!name || !summary || /[\r\n]/.test(summary) || summary.length > 1000) { message('대상의 실제 이름과 1,000자 이내 한 줄 요약을 입력해 주세요.', true); return; }
    const box = assets?.stage ?? player?.bounds();
    const center = cameraCenter ?? (box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null);
    session.feedback.push({ id: crypto.randomUUID(), frameStart, frameEnd, target: { kind: select('feedback-target-kind').value as Feedback['target']['kind'], name }, category: select('feedback-category').value as Feedback['category'], summary, context: {
      checkpoint: checkpoint?.id ?? null, workspace, animation: animation || null, time, frame: frameAtTime(activeFrameClock(), time),
      reference: select('reference-select').value || null, person: selectedPerson || null,
      sourceTime: sequence ? sequence.frames[0]!.t + time : time,
      camera: center ? { zoom, x: center.x, y: center.y, coordinateSystem: 'world-y-up' } : { zoom, coordinateSystem: 'reference-fit' },
      axis: axisInspection ? { id: select('axis-select').value, value: Number(input('axis-value').value) } : null,
      reportEvent: selectedReportEvent ? { id: selectedReportEvent.id, field: selectedReportEvent.field, source: { ...selectedReportEvent.source }, frames: selectedReportEvent.frames ? [...selectedReportEvent.frames] : null, exactTime: eventSeekTime(selectedReportEvent, selectedReportTime), targets: selectedReportEvent.targets.map(target => ({ ...target })) } : null,
    } });
    input('feedback-summary').value = ''; markDirty(); renderProposals(); message('구조화된 피드백 표시를 추가했습니다. 리뷰 제출을 눌러 보관하세요.');
  };
  button('save').onclick = async () => {
    saving = true; updateSavedState(); const savedPayload = JSON.stringify(session);
    try { const saved = await api<ReviewSession>('/api/session', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: savedPayload });
      if (JSON.stringify(session) === savedPayload) { session = saved; dirty = false; } else session.updatedAt = saved.updatedAt;
      renderProvenance();
      message(dirty ? '제출 중 추가한 변경이 있습니다. 다시 제출해 주세요.' : '선택한 검토 상태·피드백·검토 대상 출처를 제출했습니다.');
    } catch (error) { message(`제출 실패: ${errorText(error)}`, true); } finally { saving = false; updateSavedState(); }
  };
  button('export').onclick = () => { download(`${session.id}-feedback.json`, JSON.stringify({ schema: 'rig-review-feedback/1', id: session.id, revision: session.revision, sourceHash: session.sourceHash, reviewedSource: session.reviewedSource, status: session.status, checkpoints: session.checkpoints, feedback: session.feedback, issues: session.feedback.map(issueFields) }, null, 2) + '\n', 'application/json'); message('검토 대상 출처·피드백·이슈용 필드를 JSON으로 내보냈습니다. 원본은 변경하지 않았습니다.'); };
  button('export-markdown').onclick = () => { const content = [`# ${markdown(session.id)} review feedback`, '', 'Reviewed source:', ...JSON.stringify({ sourceHash: session.sourceHash, reviewedSource: session.reviewedSource }, null, 2).split('\n').map(line => '    ' + line), '', ...session.feedback.flatMap(item => { const issue = issueFields(item); return [`## ${markdown(issue.title)}`, '', issue.body, '', '---', '']; })].join('\n'); download(`${session.id}-issues.md`, content, 'text/markdown'); message('검토 출처와 각 피드백의 구조화된 이슈 내용을 Markdown으로 내보냈습니다.'); };
  const resize = new ResizeObserver(fitCamera); resize.observe(el('rig-viewport')); resize.observe(el('reference-viewport'));
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { pause(); player?.dispose(); assets?.dispose(); resize.disconnect(); });
}

async function start(): Promise<void> {
  try {
    [data, session] = await Promise.all([api<ReviewResponse>('/api/review'), api<ReviewSession>('/api/session')]);
    text('package-title', data.manifest.title); text('revision', data.manifest.revision); document.title = `${data.manifest.title} · rig review`; text('source-hash', `source ${data.sourceHash.slice(0, 12)}`); select('review-status').value = session.status; select('feedback-target-kind').value = 'rig'; input('feedback-target-name').value = data.manifest.id;
    select('reference-select').replaceChildren(); for (const reference of data.manifest.references) select('reference-select').append(option(reference.id, `${reference.label} · ${reference.type}`));
    if (!data.manifest.references.length) { select('reference-select').append(option('', '자료 미제공')); select('reference-select').disabled = true; }
    const sourceFiles = el('source-files'); for (const file of data.manifest.authoring) { const a = document.createElement('a'); a.href = assetUrl(file.path); a.textContent = file.label; a.className = 'source-link'; a.target = '_blank'; a.rel = 'noopener'; sourceFiles.append(a); } if (!data.manifest.authoring.length) sourceFiles.textContent = '소스 파일 미제공';
    bind(); renderCheckpoints(); renderProposals(); renderProvenance(); updateSavedState(); renderCues(); initReport();
    const reference = data.manifest.references[0]; if (reference) await showReference(reference.id);
    await initPlayer();
    const requestedId = new URLSearchParams(location.search).get('checkpoint');
    const first = requestedId ? data.manifest.checkpoints.find(point => point.id === requestedId) : data.manifest.checkpoints[0];
    if (first) await chooseCheckpoint(first); else renderCheckpoint();
    if (data.report && !first?.workspace) workspace = 'motion';
    renderTransport(); setWorkspace(workspace);
    if (requestedId && !first) message(`확인 항목 "${requestedId}"이 패키지에 없습니다. 목록에서 선택해 주세요.`, true);
    else message(data.manifest.model ? '원본을 유지하며 검토 상태와 구조화된 피드백을 기록합니다. 모션은 읽기 전용입니다.' : '리그 미제공 패키지입니다. 제공된 원본 자료와 확인 항목을 검토할 수 있습니다.');
    requestAnimationFrame(tick);
  } catch (error) { message(`검토 패키지를 열지 못했습니다: ${errorText(error)}`, true); text('dirty', '불러오기 실패'); }
}
void start();
