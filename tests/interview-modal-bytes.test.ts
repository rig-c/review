import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../src/interview-project.ts';
import { outputDirectory, savePicks } from '../src/interview-picks.ts';
import { interviewPicksRecord, jobInterviewValue } from '../web/interview-panel.ts';
import { projectFixture } from './interview-project.test.ts';

/** #708 bar: the interview modal writes `rig-review/interview-picks@1` and the job interview act value byte-for-byte as
 * before. The expected strings were captured on main f562572 by running that tree's inline payload expressions
 * (web/interview-panel.ts form submit and web/job-session.ts option-set `read`) over this fixture. */
const AT = '2026-11-11T00:00:00.000Z';
const SET = '{"path":"evidence/set.json","sha256":"e409abaf13f5670766f8c36c20cb0d970609d79ddd72c51483b45a9312b6dc18"}';
const cases = [
  {option:'a', other:'', note:undefined,
    picks:`{"schema":"rig-review/interview-picks@1","set":${SET},"picks":[{"ask":"reference","option_id":"a"}],"by":"user","at":"${AT}"}\n`,
    job:'{"questionId":"reference","selections":[{"itemId":"reference","optionId":"a","otherText":null}],"note":""}'},
  {option:'other', other:'한글\r\nKeep  ', note:' note\n원문 ',
    picks:`{"schema":"rig-review/interview-picks@1","set":${SET},"picks":[{"ask":"reference","option_id":"other","other_text":"한글\\r\\nKeep  "}],"note":" note\\n원문 ","by":"user","at":"${AT}"}\n`,
    job:'{"questionId":"reference","selections":[{"itemId":"reference","optionId":"other","otherText":"한글\\r\\nKeep  "}],"note":" note\\n원문 "}'},
] as const;

for (const item of cases) test(`interview modal keeps the picks file and job act value bytes (${item.option})`, () => {
  const fixture = projectFixture();
  try {
    const opened = readProject(fixture.root);
    const question = opened.questions[0]!;
    const output = outputDirectory(fixture.root, 'picks', opened.project);
    const ask = question.set.asks[0]!;
    const option = ask.options.find(option => option.id === item.option)!;
    const pick = option.kind === 'other' ? {ask:ask.id, option_id:option.id, other_text:item.other} : {ask:ask.id, option_id:option.id};
    savePicks(output, question, interviewPicksRecord(question.ref, [pick], item.note, AT));
    expect(readFileSync(join(output, question.ref.sha256 + '.json'), 'utf8')).toBe(item.picks);
    const value = jobInterviewValue('reference', question.set.asks, () => ({optionId:option.id, otherText:item.other}), item.note ?? '');
    expect(JSON.stringify(value)).toBe(item.job);
  } finally {fixture.dispose();}
});


test('#722 empty-note value bytes equal the original 60d7f17 serializer with source Other and auto IDs',async()=>{
 const baseline=await Bun.file(new URL('./fixtures/interview-722-empty-note.json',import.meta.url)).json();
 const expected=JSON.parse(baseline.expectedValueBytes);
 const asks=[{id:'topology',options:[{id:'topology_other',kind:'other'}]},{id:'detail_level',options:[{id:'density_auto',kind:'auto'}]}];
 const actual=jobInterviewValue('rig_type',asks as never,ask=>({optionId:ask.id==='topology'?'topology_other':'density_auto',otherText:ask.id==='topology'?'  Custom topology · 직접 입력\n':''}),'');
 expect(baseline.sourceCommit).toBe('60d7f17');expect(expected.note).toBe('');expect(JSON.stringify(actual)).toBe(baseline.expectedValueBytes);
});
