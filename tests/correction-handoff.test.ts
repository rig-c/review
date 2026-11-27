import { expect, test } from 'bun:test';
import { patchSha256, patchText, type ConfigPatch } from '../src/config-patch.ts';
import { projectPartsDescription, projectSessionCorrection } from '../src/correction-handoff.ts';
import type { AppliedAnimation, AppliedPatch } from '../src/applied-context.ts';
import type { PartsVerdict } from '../src/parts-view.ts';
import type { Feedback, ReviewSession } from '../src/session.ts';
import { loadReview } from '../src/manifest.ts';
import { hasStageComment } from '../src/stage-comment.ts';
import { t } from '../web/i18n.ts';
import { markedFeedback } from './helpers/verdict-feedback-746.ts';
import { statusDom } from './helpers/workspace-status-dom.ts';

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

test('#1249 the comment row attaches settled Made correction evidence to the original pin', async () => {
  const {readFile}=await import('node:fs/promises');
  const {parseFeedback}=await import('../src/session.ts');
  const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
  const rowStart=main.indexOf('function hasPinnedComment('),rowEnd=main.indexOf('function download(',rowStart);
  const guardStart=main.indexOf('function commentCaptureRefusal():'),guardEnd=main.indexOf('function sealedReferenceCamera(',guardStart);
  expect(rowStart).toBeGreaterThanOrEqual(0);expect(rowEnd).toBeGreaterThan(rowStart);
  expect(guardStart).toBeGreaterThanOrEqual(0);expect(guardEnd).toBeGreaterThan(guardStart);
  const js=new Bun.Transpiler({loader:'ts'}).transformSync(main.slice(rowStart,rowEnd)+main.slice(guardStart,guardEnd));

  const pinned=markedFeedback.feedback[0]!,mark=pinned.context.comment,modelHash=source.reviewedSource.rig!.sha256;
  const exact='Keep these precise words.  ',saved=sessionInput().session;
  const row=parseFeedback({...pinned,frameEnd:9,target:{kind:'bone',name:'elbow'},category:'quality',summary:exact,
    context:{...pinned.context,interval:{frameStart:3,frameEnd:9,inclusive:true},comment:{
      ...mark,sourceHash:source.sourceHash,modelHash,
      bookmark:{...mark.bookmark,binding:{mode:'single',sourceHash:source.sourceHash,rigs:[modelHash]}},
    }},
  });
  saved.feedback=[row];
  const original=structuredClone(row),errors:string[]=[],updates:string[]=[];
  const {doc,root}=await statusDom();
  const scope={
    document:doc,hasStageComment,session:saved,data:{direction:null},player:null,
    saving:false,readOnly:null,isSubmittedFeedback:()=>false,appliedOnStage:null as AppliedPatch|null,rebuildBusy:false,rigDifference:null,
    input:(id:string)=>{expect(id).toBe('correction-selector');return {value:'1'};},
    select:(id:string)=>{expect(id).toBe('correction-stage');return {value:'rig-review'};},
    actionButton:(label:string,click:()=>void)=>Object.assign(doc.createElement('button'),{textContent:label,onclick:click}),
    setSourceText:(element:HTMLElement,value:string)=>{element.textContent=value;},
    t:(key:string)=>t(key,undefined,'en'),tr:(value:string)=>value,
    message:(value:string,error:boolean)=>{if(error)errors.push(value);},errorText:(error:Error)=>error.message,
    feedbackEnvironment:()=>null,feedbackSchedule:()=>null,readingsContext:()=>null,requirementsPanel:null,
    markDirty:()=>updates.push('dirty'),renderProposals:()=>updates.push('render'),persistence:{save:()=>updates.push('save')},
  };
  const {renderFeedbackDetails,recordCommentCorrection,commentCaptureRefusal}=new Function('scope',
    `with(scope){${js};return {renderFeedbackDetails,recordCommentCorrection,commentCaptureRefusal};}`)(scope);
  const renderActions=():{textContent:string;onclick:()=>void}[]=>{
    root.replaceChildren();renderFeedbackDetails(row,root);return root.querySelectorAll('button');
  };
  const describedLabel='Use as described correction',madeLabel='Use as made correction';
  const pending='CORRECTION_APPLY_PENDING: Apply and check the correction first.';

  expect(renderActions().map(action=>action.textContent)).toEqual([describedLabel]);
  recordCommentCorrection(row,'made');
  expect(errors.splice(0)).toEqual([pending]);expect(row).toEqual(original);

  scope.appliedOnStage=applied;
  const actions=renderActions();
  expect(actions.map(action=>action.textContent)).toEqual([describedLabel,madeLabel]);
  const made=actions[1]!;
  scope.rebuildBusy=true;
  expect(renderActions().map(action=>action.textContent)).toEqual([describedLabel]);
  made.onclick();
  expect(errors.splice(0)).toEqual([pending]);expect(row).toEqual(original);expect(updates).toEqual([]);

  scope.rebuildBusy=false;
  expect(commentCaptureRefusal()).toStartWith('COMMENT_APPLIED_BUILD_UNSUPPORTED:');
  renderActions().find(action=>action.textContent===madeLabel)!.onclick();
  expect(errors).toEqual([]);expect(updates).toEqual(['dirty','render','save']);
  expect(saved.feedback).toHaveLength(1);expect(saved.feedback[0]).toBe(row);
  expect(row).toEqual<unknown>({...original,context:{...(original.context as Record<string,unknown>),
    correction:{path:'made',selector},applied,environment:null,environmentSchedule:null,readings:null,requirements:null,
  }});
  expect((row.context as {applied:unknown}).applied).not.toBe(applied);
  expect(parseFeedback(row)).toEqual(row);
  const projected=projectSessionCorrection({session:saved,sessionBytes:Buffer.from(JSON.stringify(saved)),source,selector,itemId:row.id,path:'made',settled});
  expect(projected).toMatchObject({kind:'checked-patch',verbatim:exact,applied});
});
