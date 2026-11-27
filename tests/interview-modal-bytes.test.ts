import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProject } from '../src/interview-project.ts';
import { outputDirectory, readPicks } from '../src/interview-picks.ts';
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

for (const item of cases) test(`legacy interview picks reader keeps the file bytes (${item.option})`, () => {
  const fixture = projectFixture();
  try {
    const opened = readProject(fixture.root);
    const question = opened.questions[0]!;
    const output = outputDirectory(fixture.root, 'picks', opened.project);
    const ask = question.set.asks[0]!;
    const option = ask.options.find(option => option.id === item.option)!;
    const pick = option.kind === 'other' ? {ask:ask.id, option_id:option.id, other_text:item.other} : {ask:ask.id, option_id:option.id};
    const file = join(output, question.ref.sha256 + '.json');
    writeFileSync(file, item.picks);
    expect(readPicks(output, question)).toEqual({
      schema:'rig-review/interview-picks@1', set:question.ref, picks:[pick],
      ...(item.note === undefined ? {} : {note:item.note}), by:'user', at:AT,
    });
    expect(readFileSync(file, 'utf8')).toBe(item.picks);
  } finally {fixture.dispose();}
});
