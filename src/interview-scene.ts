/** Shared closed scene shape and private option-context gate, from Create PROJECT rule 4. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as equal} from 'node:util';
import type {SetRef} from './interview-project.ts';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const records = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
const date = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const path = (value: unknown): value is string => text(value) && !value.startsWith('/') && !/^[a-z]:/i.test(value) &&
  !value.includes('\\') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
const human = (value: unknown) => text(value) && value.toLowerCase() !== 'agent';
const stages = ['interview', 'plan-approved', 'parts', 'parts-review', 'rigging-interview', 'rigging', 'rig-review', 'post-interview', 'post', 'direction-review', 'accepted'];
const stale = (): never => {throw new Error('INTERVIEW_OPTIONS_STALE: scene context');};

function closed(value: unknown, required: string[], optional: string[] = []): boolean {
  const data = object(value);
  return data === value && required.every(key => Object.hasOwn(data, key)) &&
    Object.keys(data).every(key => required.includes(key) || optional.includes(key));
}
const binding = (value: unknown) => closed(value, ['path', 'sha256']) && path(object(value).path) && hash(object(value).sha256);
function box(value: unknown): boolean {
  return closed(value, ['x', 'y', 'width', 'height']) && Object.values(object(value)).every(n => typeof n === 'number');
}
function citation(value: unknown): boolean {
  if (!closed(value, [], ['guide', 'asks', 'quote', 'delegated'])) return false;
  const data = object(value);
  return (!('guide' in data) || typeof data.guide === 'string') &&
    (!('quote' in data) || typeof data.quote === 'string') &&
    (!('delegated' in data) || typeof data.delegated === 'boolean') &&
    (!('asks' in data) || Array.isArray(data.asks) && data.asks.every(ask => typeof ask === 'string'));
}
function plate(value: unknown): boolean {
  const p = object(value), registered = object(p.registered);
  return closed(value, ['role', 'path', 'sha256', 'width', 'height', 'rect', 'registered'], ['citation']) &&
    ['background', 'foreground'].includes(String(p.role)) && path(p.path) && hash(p.sha256) && count(p.width) && count(p.height) && box(p.rect) &&
    closed(p.registered, ['kind', 'ref']) && ['input', 'derived'].includes(String(registered.kind)) && text(registered.ref) &&
    (!('citation' in p) || citation(p.citation));
}
export function sceneDocumentShape(value: Data, n: unknown): boolean {
  const rig = object(value.rig), animation = object(rig.animation), acceptance = object(rig.acceptance);
  const signoff = object(acceptance.signoff), reviewPackage = object(acceptance.review_package), frame = object(value.frame);
  return closed(value, ['schema', 'n', 'rig', 'frame', 'plates', 'layers']) && value.schema === 'rig-create/scene@1' && count(value.n) && value.n === n &&
    closed(value.rig, ['version', 'acceptance', 'model', 'animation']) && count(rig.version) && binding(rig.model) &&
    closed(rig.animation, ['name'], ['frames']) && text(animation.name) && (!('frames' in animation) || binding(animation.frames)) &&
    closed(rig.acceptance, ['signoff', 'verdict', 'review_package']) && typeof acceptance.verdict === 'string' && /^versions\[\d+\]\.verdicts\[\d+\]$/.test(acceptance.verdict) &&
    closed(acceptance.review_package, ['path', 'sha256']) && text(reviewPackage.path) && hash(reviewPackage.sha256) &&
    closed(acceptance.signoff, ['stage', 'checkpoint', 'at']) && signoff.stage === 'rig-review' && signoff.checkpoint === null && Number.isFinite(date(signoff.at)) &&
    closed(value.frame, ['space', 'stage']) && frame.space === 'rig-world-y-up' && box(frame.stage) &&
    Array.isArray(value.plates) && value.plates.every(plate) && Array.isArray(value.layers) && value.layers.every(layer => typeof layer === 'string');
}

export function coveringChange(project: Data, stage: string, after: number, through: number): boolean {
  const changes = [...records(project.reopens), ...records(project.amendments).map((entry): Data => ({...entry, stage: object(entry.target).stage}))];
  return changes.some(change => {
    const index = stages.indexOf(String(change.stage)), at = date(change.at);
    return index >= 0 && index <= stages.indexOf(stage) && at > after && at <= through;
  });
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  const data = object(value);
  if (data !== value) return value;
  return Object.fromEntries(Object.keys(data).sort().map(key => [key, sorted(data[key])]));
}
function current(project: Data, scene: Data, at: number): boolean {
  const live = records(project.versions).map((version, index) => ({version, index})).filter(({version}) =>
    version.kind === 'rig' && date(version.at) <= at && !coveringChange(project, 'rig-review', date(version.at) - 1, at));
  const latest = live.sort((a, b) => Number(b.version.n) - Number(a.version.n))[0];
  if (!latest || latest.version.n !== object(scene.rig).version) return false;
  const {version, index} = latest;
  const verdicts = records(version.verdicts);
  const operative = verdicts.map((verdict, index) => ({verdict, index})).filter(({verdict}) =>
    verdict.review === 'rig-review' && human(verdict.by) && verdict.verdict !== 'provisional' && date(verdict.at) <= at).at(-1);
  if (!operative || operative.verdict.verdict !== 'accepted') return false;
  const signature = records(project.signoffs).filter(signoff => signoff.stage === 'rig-review' && signoff.checkpoint === null &&
    human(signoff.by) && date(signoff.at) <= at && object(signoff.target).version === version.n &&
    !coveringChange(project, 'rig-review', date(signoff.at) - 1, at)).reverse().sort((a, b) => date(b.at) - date(a.at))[0];
  if (!signature) return false;
  const target = object(signature.target), pkg = object(version.review_package);
  const packageHash = createHash('sha256').update(JSON.stringify(sorted({config: pkg.config, files: pkg.files}))).digest('hex');
  if (target.verdict !== `versions[${index}].verdicts[${operative.index}]` ||
      !equal(target.review_package, {path: `versions[${index}].review_package`, sha256: packageHash})) return false;
  return equal(object(scene.rig).acceptance, {
    signoff: {stage: signature.stage, checkpoint: signature.checkpoint, at: signature.at},
    verdict: target.verdict, review_package: target.review_package,
  });
}

export function sceneAt(project: Data, at: number, read: (ref: SetRef) => Data) {
  if (project.scenes === undefined) return undefined;
  if (!Array.isArray(project.scenes)) return stale();
  const entries = records(project.scenes);
  for (const [index, entry] of entries.entries()) {
    if (!closed(entry, ['n', 'path', 'sha256', 'at', 'by']) || entry.n !== index + 1 ||
        entry.path !== `evidence/scene/s${index + 1}.json` || !hash(entry.sha256) || !human(entry.by) ||
        typeof entry.at !== 'string' || !entry.at.endsWith('Z') || !Number.isFinite(date(entry.at))) return stale();
  }
  const candidate = entries.filter(entry => date(entry.at) <= at).at(-1);
  if (!candidate) return undefined;
  const reference = {n: candidate.n, path: candidate.path as string, sha256: candidate.sha256 as string};
  let scene: Data;
  try {scene = read(reference);} catch {return stale();}
  if (!sceneDocumentShape(scene, candidate.n)) return stale();
  return {context: {kind: 'scene', scene: reference}, current: current(project, scene, at), document: scene};
}
