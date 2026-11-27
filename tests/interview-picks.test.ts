import { expect, test } from 'bun:test';
import { linkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../src/interview-project.ts';
import { outputDirectory, readPicks, validatePicks, type Picks } from '../src/interview-picks.ts';
import { projectFixture } from './interview-project.test.ts';

test('legacy picks preserve exact Other and note bytes and refuse forged or aliased files', () => {
  const fixture = projectFixture();
  try {
    const opened = readProject(fixture.root);
    const question = opened.questions[0]!;
    const output = outputDirectory(fixture.root,'picks',opened.project);
    const payload: Picks = {schema:'rig-review/interview-picks@1',set:question.ref,
      picks:[{ask:'reference',option_id:'other',other_text:'한글\r\nKeep spaces  \ne\u0301'}],note:'  \n',by:'user',at:'2020-01-03T00:00:00Z'};
    const target = join(output,question.ref.sha256 + '.json');
    const bytes = JSON.stringify(payload) + '\n';
    expect(readPicks(output,question)).toBeNull();
    writeFileSync(target,JSON.stringify({...payload,picks:[{ask:'reference',option_id:'forged'}]}));
    expect(() => readPicks(output,question)).toThrow('INTERVIEW_PICKS_OUTPUT');
    writeFileSync(target,bytes);
    expect(readPicks(output,readProject(fixture.root).questions[0]!)).toEqual(payload);
    expect(readFileSync(target,'utf8')).toBe(bytes);
    expect(() => validatePicks({...payload,shown:{}},question)).toThrow('INTERVIEW_CHOICE_INVALID');
    const input = join(fixture.root,'project.json');
    const before = readFileSync(input);
    rmSync(target);
    linkSync(input,target);
    expect(() => readPicks(output,question)).toThrow('INTERVIEW_PICKS_OUTPUT');
    expect(readFileSync(input)).toEqual(before);
    symlinkSync(output,join(fixture.root,'picks-alias'));
    expect(() => outputDirectory(fixture.root,'picks-alias',opened.project)).toThrow('INTERVIEW_PICKS_OUTPUT');
    expect(() => outputDirectory(fixture.root,'evidence',opened.project)).toThrow('INTERVIEW_PICKS_OUTPUT');
  } finally {fixture.dispose();}
});

test('constraints refuse disallowed explicit value tuples while Other waits', () => {
  const fixture = projectFixture();
  try {
    const question = readProject(fixture.root).questions[0]!;
    const first = question.set.asks[0]!;
    question.set.asks.push({...first,id:'second'});
    question.set.assembly = {rule:'concat'};
    question.set.constraints = [{asks:[first.id,'second'],allowed:[['a','a']]}];
    const payload: Picks = {schema:'rig-review/interview-picks@1',set:question.ref,
      picks:[{ask:first.id,option_id:'a'},{ask:'second',option_id:'b'}],by:'user',at:'2020-01-03T00:00:00Z'};
    expect(() => validatePicks(payload,question)).toThrow('INTERVIEW_CHOICE_CONSTRAINT');
    payload.picks[1] = {ask:'second',option_id:'other',other_text:'Exact words  '};
    expect(validatePicks(payload,question)).toEqual(payload);
  } finally {fixture.dispose();}
});
