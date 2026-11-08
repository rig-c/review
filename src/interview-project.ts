import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import {coveringChange, sceneAt} from './interview-scene.ts';

type RecordData = Record<string, unknown>;
export interface SetRef {path: string; sha256: string}
interface Option {id: string; kind: 'value' | 'other' | 'auto'; label: string; effect: string; recommended: boolean; reason?: string; fragment?: unknown}
interface Ask {id: string; prompt: string; options: Option[]}
interface Constraint {asks: string[]; allowed: string[][]}
export interface InterviewSet {
  id: string; question: string; stage: string; drafted_by: string; drafted_at: string;
  asks: Ask[]; assembly: {rule: 'single' | 'concat' | 'merge'}; constraints?: Constraint[];
}
interface Image {ref: SetRef; name: string; type: string}
export interface HistoricalInterview {
  question: string; verbatim: string; by?: string; at?: string;
  ref?: SetRef; record?: string; answer?: RecordData;
}
export interface InterviewDiagnostic {
  code: 'INTERVIEW_OPTIONS_STALE' | 'INTERVIEW_OPTIONS_SCENE_LEGACY';
  question: string; record: string; ref: SetRef; at?: string;
}
export interface InterviewQuestion {ref: SetRef; set: InterviewSet; editable: boolean; images: Image[]; hasParts: boolean; partsUnavailable?: boolean; answer?: RecordData}
export const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const object = (v: unknown): RecordData => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordData : {};
const records = (v: unknown) => Array.isArray(v) ? v.map(object) : [];
const date = (v: unknown) => typeof v === 'string' ? Date.parse(v) : NaN;
export const invalid = (message: string): never => {throw new Error('INTERVIEW_CHOICE_INVALID: ' + message);};
const invalidOptions = (message: string): never => {throw new Error('INTERVIEW_OPTIONS_INVALID: ' + message);};
const stale = (message: string): never => {throw new Error('INTERVIEW_OPTIONS_STALE: ' + message);};
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const optionStages = ['interview', 'rigging-interview', 'post-interview'];

export function literalPath(path: unknown): path is string {
  return typeof path === 'string' && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !/[\\:%\u0000-\u001f\u007f]/.test(segment));
}
export function checkedPath(root: string, path: string, directory = false): string {
  if (!literalPath(path)) throw new Error('Invalid project-relative path');
  let current = root;
  const segments = path.split('/');
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const entry = lstatSync(current);
    if (!(directory || index < segments.length - 1 ? entry.isDirectory() : entry.isFile())) throw new Error('Expected literal directory or regular file');
  }
  return current;
}
export function readRegular(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('File type or size exceeds interview limits');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw new Error('File changed during read');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
function binding(v: unknown): SetRef {
  const {path, sha256} = object(v);
  if (!literalPath(path) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return invalid('Malformed file binding');
  return {path, sha256};
}
export function boundBytes(root: string, ref: SetRef): Buffer {
  const bytes = readRegular(checkedPath(root, ref.path), 64 * 1024 * 1024);
  if (digest(bytes) !== ref.sha256) throw new Error('Raw SHA-256 differs');
  return bytes;
}
export function jsonObject(bytes: Buffer): RecordData {
  const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (object(value) !== value) return invalid('Expected a JSON object');
  return value;
}

function readSet(root: string, ref: SetRef): RecordData {
  try {
    if (['derived', 'outputs', 'scratch', 'node_modules', '.git'].includes(ref.path.split('/')[0]!)) throw new Error('Option files require retained storage');
    return jsonObject(boundBytes(root, ref));
  } catch (error) {
    if (error instanceof Error && error.message === 'Raw SHA-256 differs') return stale(ref.path);
    throw new Error('INTERVIEW_OPTIONS_FILE: ' + ref.path);
  }
}

function validateSet(raw: RecordData, question: unknown, allowedStages: string[]): InterviewSet {
  const asks = records(raw.asks);
  const rule = object(raw.assembly).rule;
  if (raw.schema !== 'rig-create/interview-options@1' || !id(raw.id) || raw.question !== question || !id(question) ||
      !allowedStages.includes(String(raw.stage)) || !text(raw.drafted_by) || !Number.isFinite(date(raw.drafted_at)) ||
      !asks.length || new Set(asks.map(ask => ask.id)).size !== asks.length ||
      !['single', 'concat', 'merge'].includes(String(rule)) || (rule === 'single' && asks.length !== 1)) return invalidOptions('Invalid option set');
  for (const ask of asks) {
    const options = records(ask.options);
    if (!id(ask.id) || !text(ask.prompt) || new Set(options.map(option => option.id)).size !== options.length ||
        options.filter(option => option.kind === 'value').length < 2 ||
        options.filter(option => option.kind === 'other').length !== 1 ||
        options.filter(option => option.kind === 'auto').length !== 1 ||
        options.filter(option => option.recommended === true).length !== 1) return invalidOptions('Invalid ask or recommendation');
    for (const option of options) {
      if (!id(option.id) || !text(option.label) || !text(option.effect) || typeof option.recommended !== 'boolean' ||
          !['value', 'other', 'auto'].includes(String(option.kind)) ||
          (option.recommended && (option.kind !== 'value' || !text(option.reason))) ||
          (option.kind === 'value' ? !('fragment' in option) ||
            (rule === 'concat' && !Array.isArray(option.fragment)) ||
            (rule === 'merge' && object(option.fragment) !== option.fragment) : 'fragment' in option)) return invalidOptions('Invalid option');
    }
  }
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints)) return invalidOptions('Invalid constraints');
    for (const constraint of records(raw.constraints)) {
      const names = constraint.asks;
      if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length ||
          names.some(name => !asks.some(ask => ask.id === name)) || !Array.isArray(constraint.allowed) ||
          !constraint.allowed.length || constraint.allowed.some(tuple => !Array.isArray(tuple) || tuple.length !== names.length ||
            tuple.some((value, index) => !records(asks.find(ask => ask.id === names[index])?.options)
              .some(option => option.id === value && option.kind === 'value')))) return invalidOptions('Invalid constraint tuple');
    }
  }
  return raw as unknown as InterviewSet;
}

const reopened = coveringChange;
function approval(project: RecordData, stage: string, at: number) {
  return records(project.signoffs).filter(s => s.stage === stage && (s.checkpoint === null || s.checkpoint === undefined) &&
    text(s.by) && s.by.toLowerCase() !== 'agent' && date(s.at) <= at &&
    !reopened(project, stage, date(s.at) - 1, at)).reverse().sort((a, b) => date(b.at) - date(a.at))[0];
}
function draftFor(project: RecordData, signoff: RecordData | undefined, at: number) {
  return records(project.drafts).find(draft => draft.id === signoff?.draft_id && date(draft.at) <= at);
}
function contextAt(project: RecordData, stage: string, at: number): unknown {
  if (stage === 'interview') return {kind: 'inputs', files: records(project.inputs)
    .filter(file => file.at === undefined || date(file.at) <= at).map(({path, sha256}) => ({path, sha256}))};
  if (stage === 'rigging-interview') {
    const signoff = approval(project, 'parts-review', at);
    const draft = draftFor(project, signoff, at);
    return signoff && draft && {kind: 'parts', accepted_parts: {signoff_at: signoff.at, evidence: signoff.evidence},
      structure: signoff.structure, draft_id: draft.id, parts: draft.parts};
  }
  const signoff = approval(project, 'rig-review', at);
  const rig = records(project.versions).filter(v => v.kind === 'rig' && date(v.at) <= at &&
    !reopened(project, 'rig-review', date(v.at) - 1, at) &&
    records(v.verdicts).filter(d => d.review === 'rig-review' && d.by !== 'agent' && date(d.at) <= at &&
      d.verdict !== 'provisional').at(-1)?.verdict === 'accepted').sort((a, b) => Number(b.n) - Number(a.n))[0];
  const draft = rig && draftFor(project, approval(project, 'parts-review', date(rig.at)), date(rig.at));
  return signoff && rig && draft && {kind: 'rig', rig_version: rig.n, signoff_at: signoff.at,
    config: object(rig.provenance).config, parts: draft.parts};
}

function inspectContext(root: string, project: RecordData, raw: RecordData, set: InterviewSet, at: number, fresh: boolean): {
  images: Image[]; hasParts: boolean; partsUnavailable?: boolean; legacy?: boolean;
} {
  const drafted = date(set.drafted_at);
  const ctx = object(raw.context);
  if (!Number.isFinite(at) || drafted > at || reopened(project, set.stage, drafted, at)) return stale(set.id);
  if (ctx.kind === 'scene') {
    if (set.stage !== 'post-interview') return stale(set.id);
    let legacy = false;
    let scene: RecordData = {};
    for (const instant of [drafted, at]) {
      const selected = sceneAt(project, instant, ref => jsonObject(boundBytes(root, ref)));
      if (!selected || !equal(selected.context, ctx)) return stale(set.id);
      if (!selected.current) {
        if (drafted >= Date.parse('2026-11-08T00:00:00Z')) return stale(set.id);
        legacy = true;
      }
      scene = selected.document;
    }
    const images = records(scene.plates).map(plate => ({
      ref: {path: plate.path as string, sha256: plate.sha256 as string}, name: plate.role as string, type: 'image/png',
    }));
    return {images, hasParts: false, legacy};
  }
  const expected = contextAt(project, set.stage, drafted);
  const historicalInputs = !fresh && set.stage === 'interview';
  const matches = historicalInputs ? ctx.kind === 'inputs' && records(ctx.files).length > 0 &&
    records(ctx.files).every(file => records(object(expected).files).some(declared => equal(declared, file))) :
    equal(expected, ctx) && equal(contextAt(project, set.stage, at), ctx);
  if (!Number.isFinite(at) || drafted > at || !matches || reopened(project, set.stage, drafted, at)) return stale(set.id);
  const parts = object(ctx.parts);
  const fileRefs = records(ctx.kind === 'inputs' ? ctx.files : parts.files).map(binding);
  const extra = ctx.kind === 'parts' ? [ctx.structure, object(ctx.accepted_parts).evidence] : ctx.kind === 'rig' ? [ctx.config] : [];
  const images: Image[] = [];
  try {
    if (!fileRefs.length || new Set(fileRefs.map(ref => ref.path)).size !== fileRefs.length) throw new Error('Invalid inventory');
    let partsUnavailable = false;
    for (const ref of [...fileRefs, ...extra.map(binding)]) {
      try {boundBytes(root, ref);}
      catch (error) {
        if (fresh || !ref.path.startsWith('derived/drafts/') || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        partsUnavailable = true;
      }
    }
    if (partsUnavailable) return {images, hasParts:true, partsUnavailable};
    const add = (ref: SetRef, name: string) => {
      const type = ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'} as Record<string, string>)[extname(ref.path).toLowerCase()];
      if (type) images.push({ref, name, type});
    };
    if (ctx.kind === 'inputs') {
      for (const ref of fileRefs) add(ref, ref.path.split('/').at(-1)!);
    } else {
      if (!literalPath(parts.path)) throw new Error('Invalid parts directory');
      const manifest = fileRefs.find(ref => ref.path === parts.path + '/parts.json');
      if (!manifest) throw new Error('Missing bound parts.json');
      for (const part of records(jsonObject(boundBytes(root, manifest)).parts)) {
        if (!text(part.name)) throw new Error('Invalid part name');
        const file = fileRefs.find(ref => ref.path === parts.path + '/parts/' + part.name + '.png');
        if (!file) throw new Error('Missing bound part image');
        add(file, part.name);
      }
    }
  } catch { return stale(set.id + ' context files'); }
  return {images, hasParts: ctx.kind !== 'inputs'};
}

export function readProject(root: string, now = Date.now()) {
  try {
    root = realpathSync(resolve(root));
    if (!lstatSync(root).isDirectory()) return invalid('Project root must be a directory');
  } catch {return invalid('Project root must be a readable directory');}
  let bytes: Buffer;
  let project: RecordData;
  try {
    bytes = readRegular(checkedPath(root, 'project.json'), 8 * 1024 * 1024);
    project = jsonObject(bytes);
  } catch {return invalid('project.json must be a readable regular JSON file');}
  if (project.schema !== 'rig-create/project@0') return invalid('Unsupported create project');
  const interview = object(project.interview);
  const questions: InterviewQuestion[] = [];
  const historical: HistoricalInterview[] = [];
  const diagnostics: InterviewDiagnostic[] = [];
  let sceneAnswers = 0;
  const seen = new Map<string, string>();
  for (const [items, answerKey, allowed, collection] of [
    [interview.framing, 'answer', ['interview'], 'interview.framing'],
    [interview.waypoints, 'guide', optionStages.slice(0, 2), 'interview.waypoints'],
    [object(interview.post).items, 'guide', ['post-interview'], 'interview.post.items'],
  ] as const) {
    for (const [itemIndex, item] of records(items).entries()) {
      const itemPath = `${collection}[${itemIndex}]`;
      const current = object(item[answerKey]);
      const answers = [current, ...records(item.history)];
      for (const answer of answers) {
        if (typeof item.id === 'string' && typeof answer.verbatim === 'string' && answer.choice === undefined) {
          historical.push({question:item.id, verbatim:answer.verbatim,
            by:typeof answer.by === 'string' ? answer.by : undefined, at:typeof answer.at === 'string' ? answer.at : undefined});
        }
      }
      const entries = [
        ...(item.pending_options === undefined ? [] : [{ref: item.pending_options, answer: undefined, record: itemPath + '.pending_options'}]),
        ...answers.map((answer, index) => ({answer, record: index === 0 ? itemPath + '.' + answerKey : `${itemPath}.history[${index - 1}]`}))
          .filter(({answer}) => object(answer.choice).spec === 'rig-create/interview-choice@1')
          .map(({answer, record}) => ({ref: object(answer.choice).set, answer, record})),
      ];
      for (const entry of entries) {
        const ref = binding(entry.ref);
        const prior = seen.get(ref.sha256);
        if (prior !== undefined) {
          if (prior !== ref.path) return invalid('A retained set hash has conflicting paths');
        }
        const editable = entry.answer === undefined;
        let raw: RecordData;
        let set: InterviewSet;
        try {
          raw = readSet(root, ref);
          const expectedStage = allowed.length === 1 ? allowed[0]! :
            ['rig_type','reference','seethrough','assemble'].includes(String(item.id)) ? 'interview' : 'rigging-interview';
          set = validateSet(raw, item.id, [expectedStage]);
        } catch (error) {
          if (editable) throw error;
          const answer = entry.answer!;
          historical.push({question: String(item.id), verbatim: typeof answer.verbatim === 'string' ? answer.verbatim : '',
            by: typeof answer.by === 'string' ? answer.by : undefined, at: typeof answer.at === 'string' ? answer.at : undefined,
            ref, record: entry.record, answer});
          diagnostics.push({code: 'INTERVIEW_OPTIONS_STALE', question: String(item.id), record: entry.record, ref,
            ...(typeof answer.at === 'string' ? {at: answer.at} : {})});
          continue;
        }
        if (editable && (set.stage === 'interview' || set.stage === 'rigging-interview') &&
            (object(interview.order).spec !== 'rig-create/stage-order@2' || !Number.isFinite(date(object(interview.order).choices_adopted_at)))) {
          throw new Error('INTERVIEW_CHOICE_REQUIRED: Adopt create choices before selecting');
        }
        if (editable && approval(project, set.stage === 'interview' ? 'plan-approved' : set.stage, now)) return invalid('Question approval is still live');
        const sceneKind = object(raw.context).kind === 'scene';
        if (!editable && sceneKind) sceneAnswers++;
        const evaluate = (at: number, record: string) => {
          try {
            const {legacy, ...context} = inspectContext(root, project, raw, set, at, editable);
            if (legacy) diagnostics.push({code: 'INTERVIEW_OPTIONS_SCENE_LEGACY', question: set.question, record, ref, at: new Date(at).toISOString()});
            return context;
          } catch (error) {
            if (editable || !(error instanceof Error) || !error.message.startsWith('INTERVIEW_OPTIONS_STALE:')) throw error;
            diagnostics.push({code: 'INTERVIEW_OPTIONS_STALE', question: set.question, record, ref,
              ...(Number.isFinite(at) ? {at: new Date(at).toISOString()} : {})});
            return {images: [], hasParts: false};
          }
        };
        const context = evaluate(editable ? now : date(entry.answer?.at), entry.record);
        const decision = object(entry.answer?.agent_decision);
        if (!editable && ['at', 'value', 'fragments'].some(key => Object.hasOwn(decision, key))) {
          evaluate(date(decision.at), entry.record + '.agent_decision');
        }
        questions.push({ref, set, editable, answer: entry.answer, ...context});
        seen.set(ref.sha256, ref.path);
      }
    }
  }
  return {root, hash: digest(bytes), project, questions, historical, diagnostics, sceneAnswers};
}
