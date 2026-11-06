import { closeSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { checkedPath, invalid, jsonObject, object, readRegular, type InterviewQuestion, type SetRef } from './interview-project.ts';

export const picksLimit = 256 * 1024;
interface Pick {ask: string; option_id: string; other_text?: string}
export interface Picks {schema: 'rig-review/interview-picks@1'; set: SetRef; picks: Pick[]; note?: string; by: 'user'; at: string}

export function validatePicks(input: unknown, question: InterviewQuestion): Picks {
  const data = object(input);
  if (data.schema !== 'rig-review/interview-picks@1' || data.by !== 'user' ||
      typeof data.at !== 'string' || !Number.isFinite(Date.parse(data.at)) || Date.parse(data.at) > Date.now() ||
      Date.parse(data.at) < Date.parse(question.set.drafted_at) ||
      (data.note !== undefined && typeof data.note !== 'string') ||
      Object.keys(data).some(key => !['schema','set','picks','note','by','at'].includes(key)) ||
      !Array.isArray(data.picks) || data.picks.length !== question.set.asks.length) return invalid('Invalid picks payload');
  if (!equal(data.set, question.ref)) return invalid('Displayed set is not registered');
  const choices = question.set.asks.map((ask, index) => {
    const pick = object((data.picks as unknown[])[index]);
    const option = ask.options.find(option => option.id === pick.option_id);
    if (!option || pick.ask !== ask.id || Object.keys(pick).some(key => !['ask','option_id','other_text'].includes(key)) ||
        (option.kind === 'other' ? typeof pick.other_text !== 'string' || !pick.other_text.trim() : 'other_text' in pick)) return invalid('Invalid ordered pick');
    return option;
  });
  if (question.set.assembly.rule === 'merge') {
    const keys = choices.flatMap(option => Object.keys(object(option.fragment)));
    if (new Set(keys).size !== keys.length) return invalid('Merge key collision');
  }
  for (const constraint of question.set.constraints ?? []) {
    const tuple = constraint.asks.map(id => choices[question.set.asks.findIndex(ask => ask.id === id)]);
    if (tuple.every(option => option?.kind === 'value') && !constraint.allowed.some(allowed => equal(allowed, tuple.map(option => option?.id)))) {
      throw new Error('INTERVIEW_CHOICE_CONSTRAINT: Pick an allowed combination');
    }
  }
  return data as unknown as Picks;
}

export function outputDirectory(root: string, path: string, project: unknown): string {
  const fail = () => { throw new Error('INTERVIEW_PICKS_OUTPUT: Choose a dedicated existing project-relative output directory'); };
  if (['.git','node_modules'].includes(path.split('/')[0]!)) return fail();
  const portable = (value: string) => value.normalize('NFC').toLowerCase();
  const output = portable(path);
  const check = (value: unknown): void => {
    if (typeof value === 'string') {
      const input = portable(value);
      if (input === output || input.startsWith(output + '/') || output.startsWith(input + '/')) fail();
    }
    if (value && typeof value === 'object') Object.values(value).forEach(check);
  };
  check(project);
  try {return checkedPath(root, path, true);} catch {return fail();}
}

function target(directory: string, question: InterviewQuestion) {
  return join(directory, question.ref.sha256 + '.json');
}

export function readPicks(directory: string, question: InterviewQuestion): Picks | null {
  const path = target(directory, question);
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink !== 1) throw new Error('Output is aliased');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('INTERVIEW_PICKS_OUTPUT: Output is aliased or inaccessible');
  }
  try { return validatePicks(jsonObject(readRegular(path, picksLimit)), question); }
  catch {throw new Error('INTERVIEW_PICKS_OUTPUT: Existing file is not a valid picks record for this set');}
}

export function savePicks(directory: string, question: InterviewQuestion, input: unknown): Picks {
  const picks = validatePicks(input, question);
  readPicks(directory, question);
  const bytes = JSON.stringify(picks) + '\n';
  if (Buffer.byteLength(bytes) > picksLimit) return invalid('Picks file exceeds size limit');
  const temp = join(directory, '.interview-' + randomUUID() + '.tmp');
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try {writeFileSync(fd, bytes);}
    finally {closeSync(fd);}
    renameSync(temp, target(directory, question));
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
  return picks;
}
