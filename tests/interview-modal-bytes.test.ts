import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../src/interview-project.ts';
import { outputDirectory, savePicks } from '../src/interview-picks.ts';
import { interviewPicksRecord } from '../web/interview-panel.ts';
import { projectFixture } from './interview-project.test.ts';

/** #708 / #1230: `rig-review/interview-picks@1` file records keep their exact key order and bytes. */
const AT = '2026-11-11T00:00:00.000Z';
const SET = '{"path":"evidence/set.json","sha256":"e409abaf13f5670766f8c36c20cb0d970609d79ddd72c51483b45a9312b6dc18"}';
const cases = [
  {option:'a', other:'', note:undefined,
    picks:`{"schema":"rig-review/interview-picks@1","set":${SET},"picks":[{"ask":"reference","option_id":"a"}],"by":"user","at":"${AT}"}\n`},
  {option:'other', other:'한글\r\nKeep  ', note:' note\n원문 ',
    picks:`{"schema":"rig-review/interview-picks@1","set":${SET},"picks":[{"ask":"reference","option_id":"other","other_text":"한글\\r\\nKeep  "}],"note":" note\\n원문 ","by":"user","at":"${AT}"}\n`},
] as const;

for (const item of cases) test(`interview picks record keeps the picks file bytes (${item.option})`, () => {
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
  } finally {fixture.dispose();}
});
