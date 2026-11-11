import { expect, test } from 'bun:test';
import { patchSha256, patchText, type ConfigPatch } from '../src/config-patch.ts';
import { projectPartsDescription, projectSessionCorrection } from '../src/correction-handoff.ts';
import type { AppliedAnimation, AppliedPatch } from '../src/applied-context.ts';
import type { PartsVerdict } from '../src/parts-view.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import { loadReview } from '../src/manifest.ts';

const hash = (digit: string) => digit.repeat(64);
const source = {
  id: 'package', revision: 'r1', sourceHash: hash('a'),
  reviewedSource: {
    packageRevision: 'r1', viewerVersion: '1.10.2', runtimeVersion: '1.23.0',
    rig: { path: 'build/skeleton.model.json', sha256: hash('b') }, motion: null,
    handoff: { schema: 'rig-review-handoff/1', how: 'declared', via: 'review.json producer', outside: false,
      config: { path: 'config.json', sha256: hash('c') }, parts: 'out', rig: 'out/rig', source: null,
      full: null, head: null, files: [{ path: 'config.json', sha256: hash('c') }], missing: [] },
  } satisfies ReviewSession['reviewedSource'],
};
const selector = { stage: 'rig-review', kind: 'rig', version: 1 } as const;
const patch: ConfigPatch = {
  schema: 'rig-review-config-patch/1', config_sha256: hash('c'),
  ops: [{ op: 'replace', path: '/note', value: 'new' }],
  producer: { name: '@rig-c/parts', version: '2.18.0' }, op: { cmd: 'rig', args: [] },
};
const check = { schema: 'rig-review-check-summary/1', pass: true, gate: true, exitCode: 0, line: 'check: PASS', bars: { BOUND: 'PASS' }, source: 'check' } as const;
const applied: AppliedPatch = {
  schema: 'rig-review-applied/2', buildId: hash('d'), patch, patchSha256: patchSha256(patch),
  configHash: hash('c'), modelHash: hash('e'), stageInputHash: hash('f'),
  producer: { package: '@rig-c/parts', version: '2.18.0' }, compiler: { package: '@rig-c/core', version: '3.2.1' },
  line: 'producer line', check, diff: { count: 1, paths: ['/note'] },
};
const settled = {
  source, applied, operationSha256: applied.patchSha256, modelSha256: applied.modelHash,
};

function sessionInput(value: unknown = applied) {
  const session: ReviewSession = {
    ...source, schema: 'rig-review-session/1', status: 'changes-requested', updatedAt: null,
    checkpoints: {}, feedbackWarnings: [],
    feedback: [{ id: 'item-1', frameStart: 0, frameEnd: 0, target: { kind: 'rig', name: 'package' },
      category: 'quality', summary: 'Please refine the contour.  ', context: { applied: value } as Feedback['context'] }],
  };
  return { session, sessionBytes: Buffer.from(JSON.stringify(session, null, 2) + '\n'), source, selector, itemId: 'item-1' };
}

test('projects one exact saved request and keeps its outcome open', () => {
  const input = sessionInput();
  const projected = projectSessionCorrection({ ...input, path: 'described' });
  expect(projected).toMatchObject({ kind: 'described', itemId: 'item-1', verbatim: 'Please refine the contour.  ', outcome: null, on: ['--version', '1'] });
  expect(() => projectSessionCorrection({ ...input, path: 'described', itemId: 'missing' })).toThrow('CORRECTION_ITEM_INVALID');
  expect(() => projectSessionCorrection({ ...input, path: 'described', source: { ...source, revision: 'stale' } })).toThrow('CORRECTION_SOURCE_STALE');
  expect(() => projectSessionCorrection({ ...input, path: 'described', selector: { ...selector, version: 0 } })).toThrow('CORRECTION_SELECTOR_INVALID');
});

test('an authored direction request refuses feedback captured on a checked scratch Apply', async () => {
  const pkg = await loadReview('tests/fixtures/direction-inspection');
  const directionSource = {
    id: pkg.manifest.id, revision: pkg.manifest.revision, sourceHash: pkg.sourceHash, reviewedSource: pkg.reviewedSource,
  };
  const request = (context: typeof applied | null) => {
    const input = sessionInput(context);
    const session = { ...input.session, ...directionSource };
    return projectSessionCorrection({
      ...input, source: directionSource, session, sessionBytes: Buffer.from(JSON.stringify(session)),
      selector: { stage: 'direction-review', kind: 'post', version: 2, modelFile: pkg.manifest.model! },
      direction: pkg.direction!, path: 'described',
    });
  };
  expect(request(null)).toMatchObject({ kind: 'described', outcome: null });
  expect(() => request(applied)).toThrow('CORRECTION_DIRECTION_SOURCE');
});

test('pre-rig verdict note retains verbatim CRLF and uses only a parts selector', () => {
  const verdict = {
    schema: 'rig-review-parts-verdict/2', mode: 'parts' as const, tool: { name: '@rig-c/review', version: '1.10.2' },
    source: { sha256: hash('a'), files: [], flags: [] }, status: 'changes-requested',
    parts: { torso: { outcome: 'flagged', note: 'Keep these words.  \r\n', flags: [] } },
    comments: [], updatedAt: '2026-11-06T00:00:00Z',
  };
  const result = projectPartsDescription({ verdict, source: verdict.source, selector: { kind: 'parts', stage: 'parts-review', inventory: 'evidence/parts.json' }, selection: { kind: 'note', part: 'torso', itemId: 'note-1' } });
  expect(result).toMatchObject({ verbatim: 'Keep these words.  \r\n', part: 'torso', on: ['--parts-file', 'evidence/parts.json'], outcome: null });
});

test('checked patch keeps the exact session and patch, bound to a scratch result with the create outcome open', () => {
  const input = sessionInput();
  const result = projectSessionCorrection({ ...input, path: 'made', settled });
  expect(result).toMatchObject({ kind: 'checked-patch', applied, patchBytes: patchText(patch), outcome: null });
  if (result.kind !== 'checked-patch') throw Error('expected checked patch');
  expect(result.sessionBytes).toBe(input.sessionBytes);
  expect(() => projectSessionCorrection({ ...input, path: 'made' })).toThrow('CORRECTION_APPLY_PENDING');
  expect(() => projectSessionCorrection({ ...sessionInput(null), path: 'made', settled })).toThrow('CORRECTION_APPLY_PENDING');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, applied: { ...applied, buildId: hash('0') } } })).toThrow('CORRECTION_APPLY_STALE');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, operationSha256: hash('0') } })).toThrow('CORRECTION_ARTIFACT_MISMATCH');
  expect(() => projectSessionCorrection({ ...input, path: 'made', settled: { ...settled, modelSha256: hash('0') } })).toThrow('CORRECTION_OUTCOME_MISMATCH');
});

test('failed or skipped checks cannot project a create checked outcome', () => {
  for (const failedCheck of [null, { ...check, gate: false }, { ...check, bars: { BOUND: 'SKIP' } }]) {
    const failed = { ...applied, check: failedCheck };
    expect(() => projectSessionCorrection({ ...sessionInput(failed), path: 'made', settled: { ...settled, applied: failed } })).toThrow('CORRECTION_CHECK_FAILED');
  }
});

test('keyed animation is explicitly unsupported with its original operation and session', () => {
  const keyed: AppliedAnimation = {
    schema: 'rig-review-applied/5', buildId: applied.buildId, configHash: applied.configHash,
    animationsFrom: { path: 'animations.json', beforeSha256: hash('1'), afterSha256: hash('2') },
    ops: [{ op: 'set_key_time', animation: 'tilt', track: 0, key: 1, time: 0.42 }],
    opsSha256: hash('3'), args: [], producer: applied.producer, compiler: applied.compiler,
    line: applied.line, check, files: null, modelHash: applied.modelHash,
  };
  const input = sessionInput(keyed);
  const result = projectSessionCorrection({ ...input, path: 'made' });
  expect(result).toMatchObject({ kind: 'unsupported', operation: 'keyed-animation', applied: keyed, outcome: null });
  if (result.kind !== 'unsupported') throw Error('expected unsupported operation');
  expect(result.sessionBytes).toBe(input.sessionBytes);
});

test('known non-PASS producer diagnostics survive alongside PASS', () => {
  const diagnostic = { ...applied, check: { ...check, bars: { BOUND: 'PASS', OPTIONAL: 'SKIP', SUPPORT: 'UNCLASSIFIED' } } };
  const result = projectSessionCorrection({ ...sessionInput(diagnostic), path: 'made', settled: { ...settled, applied: diagnostic } });
  expect(result).toMatchObject({ kind: 'checked-patch', applied: diagnostic });
  for (const status of ['FAIL', 'UNKNOWN']) {
    const rejected = { ...diagnostic, check: { ...check, bars: { BOUND: 'PASS', OPTIONAL: status } } };
    expect(() => projectSessionCorrection({ ...sessionInput(rejected), path: 'made', settled: { ...settled, applied: rejected } })).toThrow('CORRECTION_CHECK_FAILED');
  }
});

test('checked handoff refuses missing and unknown producer check sources without changing diagnostics', () => {
  const { source: _source, ...noSource } = check;
  for (const [summary, error] of [[noSource, 'CORRECTION_CHECK_FAILED'], [{ ...check, source: 'unknown' }, 'CORRECTION_APPLY_INVALID']] as const) {
    const rejected = { ...applied, check: summary };
    const original = JSON.stringify(rejected);
    expect(() => projectSessionCorrection({ ...sessionInput(rejected), path: 'made', settled: { ...settled, applied: rejected } })).toThrow(error);
    expect(JSON.stringify(rejected)).toBe(original);
  }
});

test('#735 Made correction records from the existing UTF-8 file path on applied scratch without comment capture', async () => {
  const {readFile}=await import('node:fs/promises');
  const {parseFeedback}=await import('../src/session.ts');
  const {validateFeedbackSelection,validateTimedFeedbackSelection}=await import('../src/feedback-validation.ts');
  const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
  const record=main.slice(main.indexOf('function recordFeedback('),main.indexOf('\n\nfunction bind():',main.indexOf('function recordFeedback(')));
  const selection=main.slice(main.indexOf('function correctionSelection('),main.indexOf('function propose('));
  const handler=main.slice(main.indexOf("  button('add-proposal').onclick = "),main.indexOf("  button('save').onclick = "));
  const guard=main.slice(main.indexOf('function commentCaptureRefusal():'),main.indexOf('function setupComments():'));
  const values:Record<string,any>={
    'feedback-start':{value:'3'},'feedback-end':{value:'9'},'feedback-target-kind':{value:'bone'},'feedback-target-name':{value:'elbow'},'feedback-category':{value:'quality'},
    'correction-path':{value:'made'},'correction-stage':{value:'rig-review'},'correction-selector':{value:'1'},
    'reference-select':{value:''},'axis-select':{value:''},'axis-value':{value:''},
  };
  const exact='Keep these precise words.  \r\n', bytes=new TextEncoder().encode(exact),saved=sessionInput().session;
  saved.feedback=[];const errors:string[]=[],button:any={};
  values['correction-words']={value:'request.txt',files:[{size:bytes.length,arrayBuffer:async()=>bytes.buffer}]};
  const scope:any={input:(id:string)=>values[id],select:(id:string)=>values[id],button:()=>button,session:saved,appliedOnStage:applied,rigDifference:null,
    data:{feedbackCatalog:{rig:'package',bones:['elbow'],slots:[],animations:null,clock:null,clockAnimation:null}},
    tr:(value:string)=>value,t:(value:string)=>value,message:(value:string,error:boolean)=>{if(error)errors.push(value);},errorText:(error:Error)=>error.message,
    validateFeedbackSelection,validateTimedFeedbackSelection,feedbackAnimation:()=>null,assets:null,player:null,viewport:{state:{cameraCenter:null,zoom:1}},
    turnPad:null,parts:null,checkpoint:null,time:.25,activeFrameClock:()=>null,frameAtTime:()=>null,selectedPerson:null,sequence:null,
    serializableView:()=>({}),numericView:()=>({}),appearance:null,layers:{},axisInspection:false,feedbackEnvironment:()=>null,feedbackSchedule:()=>null,
    readingsContext:()=>null,requirementsPanel:null,selectedReportEvent:null,markDirty(){},renderProposals(){},
  };
  const js=new Bun.Transpiler({loader:'ts'}).transformSync(record+selection+guard+handler);
  const readGuard=new Function('scope','with(scope){'+js+';return commentCaptureRefusal;}')(scope);
  expect(readGuard()).toStartWith('COMMENT_APPLIED_BUILD_UNSUPPORTED:');
  await button.onclick();expect(errors).toEqual([]);expect(saved.feedback).toHaveLength(1);
  const row=saved.feedback[0]!;expect(parseFeedback(row)).toEqual(row);expect(row.summary).toBe(exact);
  expect(row).toMatchObject({frameStart:3,frameEnd:9,target:{kind:'bone',name:'elbow'},category:'quality',context:{applied,correction:{path:'made',selector}}});
  expect((row.context as any).comment).toBeUndefined();expect((row.context as any).applied).not.toBe(applied);
  const projected=projectSessionCorrection({session:saved,sessionBytes:Buffer.from(JSON.stringify(saved)),source,selector,itemId:row.id,path:'made',settled});
  expect(projected).toMatchObject({kind:'checked-patch',verbatim:exact,applied});
  // A replaced Apply during file decoding must retain the original CORRECTION_APPLY_PENDING refusal.
  values['correction-words'].files=[{size:bytes.length,arrayBuffer:async()=>{scope.appliedOnStage={...applied,buildId:hash('1')};return bytes.buffer;}}];
  await button.onclick();expect(saved.feedback).toHaveLength(1);expect(errors.at(-1)).toStartWith('CORRECTION_APPLY_PENDING:');
});
