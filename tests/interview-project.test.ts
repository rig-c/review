import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, literalPath, readProject, type InterviewSet } from '../src/interview-project.ts';

export function projectFixture() {
  const root = mkdtempSync(join(tmpdir(), 'interview-test-'));
  mkdirSync(join(root, 'evidence'));
  mkdirSync(join(root, 'picks'));
  const source = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const input = {path:'source.svg', sha256:digest(source)};
  const option: InterviewSet & {schema:string;context:unknown} = {schema:'rig-create/interview-options@1', id:'set-a', question:'reference', stage:'interview', drafted_by:'agent',
    drafted_at:'2020-01-01T00:00:00Z', context:{kind:'inputs',files:[input]}, assembly:{rule:'single'},
    asks:[{id:'reference',prompt:'Prompt',options:[
      {id:'a',kind:'value',label:'Keep  \ne\u0301',effect:'Exact effect',fragment:'none',recommended:true,reason:'Fixture reason'},
      {id:'b',kind:'value',label:'Change',effect:'Effect',fragment:'different',recommended:false},
      {id:'other',kind:'other',label:'Other',effect:'Explain',recommended:false},
      {id:'auto',kind:'auto',label:'Auto',effect:'Delegate',recommended:false},
    ]}]};
  const setBytes = JSON.stringify(option) + '\n';
  const set = {path:'evidence/set.json',sha256:digest(setBytes)};
  const project = {schema:'rig-create/project@0', inputs:[input], interview:{order:{spec:'rig-create/stage-order@2',
    choices_adopted_at:'2020-01-01T00:00:00Z'}, framing:[{id:'reference',pending_options:set}]}};
  writeFileSync(join(root, input.path), source);
  writeFileSync(join(root, set.path), setBytes);
  writeFileSync(join(root, 'project.json'), JSON.stringify(project));
  return {root, set, input, project, option, dispose:() => rmSync(root,{recursive:true,force:true})};
}

test('a direction set exposes its exact source and never claims separated parts', () => {
  const fixture = projectFixture();
  try {
    const [question] = readProject(fixture.root).questions;
    expect(question?.ref).toEqual(fixture.set);
    expect(question?.set.asks).toEqual(fixture.option.asks);
    expect(question?.images.map(image => image.ref)).toEqual([fixture.input]);
    expect(question?.hasParts).toBe(false);
  } finally {fixture.dispose();}
});

test('a reopened context and changed or aliased bytes are refused before display', () => {
  const fixture = projectFixture();
  try {
    const path = join(fixture.root, 'project.json');
    writeFileSync(path, JSON.stringify({...fixture.project,reopens:[{stage:'interview',at:'2020-01-02T00:00:00Z'}]}));
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_OPTIONS_STALE');
    writeFileSync(path, JSON.stringify(fixture.project));
    writeFileSync(join(fixture.root,fixture.input.path),'changed');
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_OPTIONS_STALE');
    rmSync(join(fixture.root, fixture.set.path));
    symlinkSync(join(fixture.root,'source.svg'),join(fixture.root,fixture.set.path));
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_OPTIONS_FILE');
    for (const path of ['/absolute','a/../b','a/./b','a//b','a/%2e%2e','a\\b']) expect(literalPath(path)).toBe(false);
  } finally {fixture.dispose();}
});

test('legacy free-text is readable without manufacturing a set or pick', () => {
  const fixture = projectFixture();
  try {
    const answer = {by:'user',at:'2020-01-02T00:00:00Z',verbatim:'Keep  \n한글'};
    const {project} = fixture;
    writeFileSync(join(fixture.root,'project.json'),JSON.stringify({...project,interview:{framing:[{id:'reference',answer}]}}));
    const opened = readProject(fixture.root);
    expect(opened.questions).toEqual([]);
    expect(opened.historical).toEqual([{question:'reference', ...answer}]);
  } finally {fixture.dispose();}
});
