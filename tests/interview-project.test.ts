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

test('designated root aliases are canonicalized while project.json aliases and missing inputs are refused by name', () => {
  const fixture = projectFixture();
  try {
    const alias = join(fixture.root,'root-link');
    symlinkSync(fixture.root,alias);
    const now = Date.now();
    expect(readProject(alias,now)).toEqual(readProject(fixture.root,now));
    expect(() => readProject(join(fixture.root,'missing'))).toThrow('INTERVIEW_CHOICE_INVALID: Project root');
    const path = join(fixture.root,'project.json');
    rmSync(path);
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_CHOICE_INVALID: project.json');
    symlinkSync(join(fixture.root,fixture.input.path),path);
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_CHOICE_INVALID: project.json');
  } finally {fixture.dispose();}
});

test('rigging context retains both same-hash part identities and refuses missing bound PNG', () => {
  const fixture = projectFixture();
  try {
    const put = (path:string, bytes:string|Buffer) => {
      writeFileSync(join(fixture.root,path),bytes);
      return {path,sha256:digest(bytes)};
    };
    const signoffAt = '2019-12-31T00:00:00Z';
    const evidence = put('evidence/parts-review.json','{}');
    const structure = put('evidence/structure.json','{}');
    const path = 'parts-input';
    mkdirSync(join(fixture.root,path,'parts'),{recursive:true});
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXn8AAAAASUVORK5CYII=', 'base64');
    const manifest = put(path+'/parts.json',JSON.stringify({parts:[{name:'eye_l'},{name:'eye_r'}]}));
    const left = put(path+'/parts/eye_l.png',png);
    const right = put(path+'/parts/eye_r.png',png);
    const parts = {path,files:[manifest,left,right]};
    const option = {...fixture.option,question:'bones',stage:'rigging-interview',context:{
      kind:'parts',accepted_parts:{signoff_at:signoffAt,evidence},structure,draft_id:'draft',parts,
    }};
    const set = put(fixture.set.path,JSON.stringify(option));
    put('project.json',JSON.stringify({...fixture.project,
      signoffs:[{stage:'parts-review',checkpoint:null,by:'user',at:signoffAt,draft_id:'draft',evidence,structure}],
      drafts:[{id:'draft',at:signoffAt,parts}],
      interview:{order:fixture.project.interview.order,waypoints:[{id:'bones',pending_options:set}]},
    }));
    const question = readProject(fixture.root).questions[0]!;
    expect(left.sha256).toBe(right.sha256);
    expect(question.images.map(({name,ref})=>({name,ref}))).toEqual([{name:'eye_l',ref:left},{name:'eye_r',ref:right}]);
    rmSync(join(fixture.root,right.path));
    expect(() => readProject(fixture.root)).toThrow('INTERVIEW_OPTIONS_STALE');
  } finally {fixture.dispose();}
});


const postQuestions = ['camera_depth', 'post_timing', 'post_composition'] as const;
const postNow = Date.parse('2020-01-10T00:00:00Z');
type RigState = 'current' | 'older' | 'rejected' | 'reopened';

function postProjectFixture(question: string, adopted: boolean, rigState: RigState = 'current', answered = false) {
  const fixture = projectFixture();
  const put = (path: string, bytes: string | Buffer) => {
    writeFileSync(join(fixture.root, path), bytes);
    return {path, sha256: digest(bytes)};
  };
  const partsAt = '2019-12-26T00:00:00Z';
  const rigSignoffAt = '2019-12-29T00:00:00Z';
  const evidence = put('evidence/parts-review.json', '{}');
  const structure = put('evidence/structure.json', '{}');
  const path = 'parts-input';
  mkdirSync(join(fixture.root, path, 'parts'), {recursive: true});
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXn8AAAAASUVORK5CYII=', 'base64');
  const manifest = put(path + '/parts.json', JSON.stringify({parts: [{name: 'body'}]}));
  const image = put(path + '/parts/body.png', png);
  const parts = {path, files: [manifest, image]};
  const oldConfig = put('evidence/rig-1.json', '{"fixtureRig":1}');
  const config = put('evidence/rig-2.json', '{"fixtureRig":2}');
  const context = {kind: 'rig', rig_version: rigState === 'older' ? 1 : 2,
    signoff_at: rigSignoffAt, config: rigState === 'older' ? oldConfig : config, parts};
  const option = {...fixture.option, question, stage: 'post-interview', context};
  const set = put(fixture.set.path, JSON.stringify(option));
  const answer = {by: 'user', at: '2020-01-02T00:00:00Z', verbatim: 'Keep the authored framing',
    choice: {spec: 'rig-create/interview-choice@1', set}};
  const item = answered ? {id: question, guide: answer} : {id: question, pending_options: set};
  const project = {...fixture.project,
    signoffs: [
      {stage: 'plan-approved', checkpoint: null, by: 'user', at: '2019-12-25T00:00:00Z'},
      {stage: 'parts-review', checkpoint: null, by: 'user', at: partsAt, draft_id: 'draft', evidence, structure},
      {stage: 'rig-review', checkpoint: null, by: 'user', at: rigSignoffAt},
    ],
    drafts: [{id: 'draft', at: partsAt, parts}],
    versions: [
      {kind: 'rig', n: 1, at: '2019-12-27T00:00:00Z', provenance: {config: oldConfig},
        verdicts: [{review: 'rig-review', by: 'user', at: '2019-12-27T01:00:00Z', verdict: 'accepted'}]},
      {kind: 'rig', n: 2, at: '2019-12-28T00:00:00Z', provenance: {config},
        verdicts: [
          {review: 'rig-review', by: 'user', at: rigSignoffAt, verdict: 'accepted'},
          ...(rigState === 'rejected' ? [{review: 'rig-review', by: 'user', at: '2020-01-03T00:00:00Z', verdict: 'rejected'}] : []),
        ]},
    ],
    reopens: rigState === 'reopened' ? [{stage: 'rig-review', at: '2020-01-03T00:00:00Z'}] : [],
    interview: {...(adopted ? {order: fixture.project.interview.order} : {}), post: {items: [item]}},
  };
  put('project.json', JSON.stringify(project));
  return {...fixture, project, option, set, image, put};
}

for (const questionId of postQuestions) {
  test(`legacy ${questionId} opens editable on the accepted rig without adoption`, () => {
    const fixture = postProjectFixture(questionId, false);
    try {
      const opened = readProject(fixture.root, postNow);
      expect(opened.questions).toHaveLength(1);
      const question = opened.questions[0]!;
      expect(question.ref).toEqual(fixture.set);
      expect(question.set).toEqual(fixture.option);
      expect(question.editable).toBe(true);
      expect(question.images.map(image => image.ref)).toEqual([fixture.image]);
      expect(question.hasParts).toBe(true);
      expect(fixture.project.interview).not.toHaveProperty('order');
    } finally {fixture.dispose();}
  });

  test(`expectedStage admits adopted ${questionId} as post-interview`, () => {
    const fixture = postProjectFixture(questionId, true);
    try {
      const opened = readProject(fixture.root, postNow);
      expect(opened.questions).toHaveLength(1);
      const question = opened.questions[0]!;
      expect(question.set.stage).toBe('post-interview');
      expect(question.set.question).toBe(questionId);
      expect(question.ref).toEqual(fixture.set);
      expect(question.editable).toBe(true);
      expect(question.images.map(image => image.ref)).toEqual([fixture.image]);
      expect(question.hasParts).toBe(true);
    } finally {fixture.dispose();}
  });

  test(`expectedStage admits answered legacy ${questionId} without adoption`, () => {
    const fixture = postProjectFixture(questionId, false, 'current', true);
    try {
      const opened = readProject(fixture.root, postNow);
      expect(opened.questions).toHaveLength(1);
      const question = opened.questions[0]!;
      expect(question.set.stage).toBe('post-interview');
      expect(question.set.question).toBe(questionId);
      expect(question.ref).toEqual(fixture.set);
      expect(question.editable).toBe(false);
      expect(question.answer?.verbatim).toBe('Keep the authored framing');
    } finally {fixture.dispose();}
  });

  test(`expectedStage refuses post in place of post-interview for ${questionId}`, () => {
    const fixture = postProjectFixture(questionId, true);
    try {
      const set = fixture.put(fixture.set.path, JSON.stringify({...fixture.option, stage: 'post'}));
      fixture.put('project.json', JSON.stringify({...fixture.project,
        interview: {order: fixture.project.interview.order, post: {items: [{id: questionId, pending_options: set}]}},
      }));
      expect(() => readProject(fixture.root, postNow)).toThrow('INTERVIEW_OPTIONS_INVALID: Invalid option set');
    } finally {fixture.dispose();}
  });
}

for (const rigState of ['older', 'rejected', 'reopened'] as const) {
  test(`legacy post on ${rigState} rig refuses by the stale code`, () => {
    const fixture = postProjectFixture('camera_depth', false, rigState);
    try {
      expect(() => readProject(fixture.root, postNow)).toThrow('INTERVIEW_OPTIONS_STALE: set-a');
    } finally {fixture.dispose();}
  });

  test(`adopted post on ${rigState} rig retains the stale refusal`, () => {
    const fixture = postProjectFixture('camera_depth', true, rigState);
    try {
      expect(() => readProject(fixture.root, postNow)).toThrow('INTERVIEW_OPTIONS_STALE: set-a');
    } finally {fixture.dispose();}
  });
}

for (const stage of ['interview', 'rigging-interview']) {
  for (const order of [undefined,
    {spec: 'rig-create/stage-order@1', choices_adopted_at: '2020-01-01T00:00:00Z'},
    {spec: 'rig-create/stage-order@2'},
    {spec: 'rig-create/stage-order@2', choices_adopted_at: 'invalid'},
  ]) {
    test(`${stage} requires adoption for ${JSON.stringify(order)}`, () => {
      const fixture = projectFixture();
      try {
        const question = stage === 'interview' ? 'reference' : 'bones';
        const bytes = JSON.stringify({...fixture.option, question, stage});
        writeFileSync(join(fixture.root, fixture.set.path), bytes);
        const item = {id: question, pending_options: {path: fixture.set.path, sha256: digest(bytes)}};
        const items = stage === 'interview' ? {framing: [item]} : {waypoints: [item]};
        writeFileSync(join(fixture.root, 'project.json'), JSON.stringify({...fixture.project,
          interview: {...(order === undefined ? {} : {order}), ...items},
        }));
        expect(() => readProject(fixture.root, postNow)).toThrow('INTERVIEW_CHOICE_REQUIRED: Adopt create choices before selecting');
      } finally {fixture.dispose();}
    });
  }
}

for (const adopted of [false, true]) {
  for (const questionId of postQuestions) {
    test(`missing scene context is stale before adoption for ${adopted ? 'adopted' : 'legacy'} ${questionId}`, () => {
      const fixture = postProjectFixture(questionId, adopted);
      try {
        const context = {kind: 'scene', scene: {n: 1, path: 'evidence/unsupported-scene.json', sha256: digest('{}')}};
        const set = fixture.put(fixture.set.path, JSON.stringify({...fixture.option, context}));
        fixture.put('project.json', JSON.stringify({...fixture.project,
          interview: {...fixture.project.interview, post: {items: [{id: questionId, pending_options: set}]}},
        }));
        expect(() => readProject(fixture.root, postNow)).toThrow('INTERVIEW_OPTIONS_STALE');
      } finally {fixture.dispose();}
    });
  }
}
