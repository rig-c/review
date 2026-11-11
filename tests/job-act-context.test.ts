import {expect, test} from 'bun:test';
import {parseCommentsAct, parseContextCommentsAct, parseRecordAct, projectComments,
  JOB_COMMENT_CONTEXT_ACT_SCHEMA} from '../src/job-host.ts';
import {commentsActForEmission, jobHash} from '../src/job-api.ts';
import {EMIT_UNPINNED_CREATE_FIELDS} from '../src/create-pin-gate.ts';
import legacy from './fixtures/comments-contract-legacy.json';

// Deliberately untyped: planted malformed packets go through the public decoder.
function act(schema: string, comments: unknown[]): any {
  const old = JSON.parse(legacy.records['@2'].raw);
  const {words: _words, ...value} = old.value;
  return {...old, schema, value: {...value, comments}};
}
const sourceHash = JSON.parse(legacy.records['@2'].raw).source.sourceHash as string;
const context = {
  subject: {ask: {kind: 'checkpoint', checkpointId: 'step-one', planStepId: 'step-one'}, sourceHash, selector: {kind: 'rig', version: 1}},
  mode: 'setup', tab: 'rig', part: {side: 'single', slot: 'sleeve', mode: 'solo'},
  region: {x: -4.5, y: 2, width: 10, height: 0}, viewMode: 'assembled',
  camera: {space: 'world', center: {x: 1, y: 2}, zoom: 1.5, viewport: {width: 640, height: 480},
    visible: {x: -10, y: -8, width: 20, height: 16}},
  frame: {index: 3, basis: 'producer'},
};
const anchor = {checkpointId: 'step-one', planStepId: 'step-one'};
// @6 bytes, pinned from main 7b68d5f's parseCommentsAct before this change.
const at6 = act('rig-review/act@6', [{text: ' general\n'}, {text: 'pinned', anchor}]);
const AT6_SHA256 = '6d51adb72901e3201c85502a1c710dce9e50ea184d2e6c9977cd01f78373308e';

test('#714 @7 round-trips byte-identically with and without context', () => {
  for (const comments of [[{text: 'no context'}, {text: 'pinned', anchor}],
    [{text: 'general', context}, {text: 'pinned', anchor, context: {tab: 'playback'}}]]) {
    const raw = act(JOB_COMMENT_CONTEXT_ACT_SCHEMA, comments), bytes = JSON.stringify(raw);
    const parsed = parseContextCommentsAct(JSON.parse(bytes));
    expect(JSON.stringify(parsed)).toBe(bytes);
    expect(JSON.stringify(parseContextCommentsAct(parsed))).toBe(bytes);
    // The signed projection is text and anchor only; context never changes it.
    const {context: _a, ...first} = comments[0] as any, {context: _b, ...second} = comments[1] as any;
    expect(projectComments(parsed.value.comments.map(({context: _c, ...rest}) => rest))).toBe(projectComments([first, second]));
  }
});

test('#714 @7 context is closed and bound to the act source', () => {
  const refuse = (change: Record<string, unknown>) =>
    expect(() => parseContextCommentsAct(act(JOB_COMMENT_CONTEXT_ACT_SCHEMA, [{text: 'x', context: {...context, ...change}}]))).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct(act(JOB_COMMENT_CONTEXT_ACT_SCHEMA, [{text: 'x', context: {}}]))).toThrow('JOB_ACT_INVALID');
  refuse({unknown: 1});
  refuse({mode: 'edit'});
  refuse({tab: 'comments'});
  refuse({part: null});
  refuse({region: {x: 0, y: 0, width: -1, height: 1}});
  refuse({viewMode: 'grid'});
  refuse({camera: {...context.camera, zoom: 9}});
  refuse({frame: {index: -1, basis: 'producer'}});
  refuse({frame: null});
  refuse({subject: {...context.subject, sourceHash: '0'.repeat(64)}});
  refuse({subject: {...context.subject, selector: {kind: 'rig', version: 2}}});
  refuse({subject: {...context.subject, ask: {kind: 'signoff', stage: 'plan-approved'}}});
});

test('#714 @6 refuses context and @7 refuses the @6 schema', () => {
  expect(() => parseCommentsAct(act('rig-review/act@6', [{text: 'x', context}]))).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct(act('rig-review/act@6', [{text: 'x'}]))).toThrow('JOB_ACT_INVALID');
  expect(() => parseCommentsAct(act(JOB_COMMENT_CONTEXT_ACT_SCHEMA, [{text: 'x'}]))).toThrow('JOB_ACT_INVALID');
});

test('#714 @2-@6 decode byte-identically', () => {
  for (const key of ['@2', '@3', '@4', '@5'] as const) {
    const {raw, sha256} = legacy.records[key];
    expect(jobHash(raw)).toBe(sha256);
    // No comments decoder rereads a historical act as a newer version.
    expect(() => parseCommentsAct(JSON.parse(raw))).toThrow('JOB_ACT_INVALID');
    expect(() => parseContextCommentsAct(JSON.parse(raw))).toThrow('JOB_ACT_INVALID');
  }
  // Decoded @4 bytes, pinned from main 7b68d5f's parseRecordAct.
  expect(jobHash(JSON.stringify(parseRecordAct(JSON.parse(legacy.records['@4'].raw)))))
    .toBe('47394cfc6d96735e3099f90c8b19b9cacbf025a85c1df22d7a0a991c4b92a224');
  const bytes = JSON.stringify(parseCommentsAct(structuredClone(at6)));
  expect(bytes).toBe(JSON.stringify(at6));
  expect(jobHash(bytes)).toBe(AT6_SHA256);
});

test('#714 with EMIT_UNPINNED_CREATE_FIELDS off, Review emits no @7', () => {
  expect(EMIT_UNPINNED_CREATE_FIELDS).toBe(false);
  const withContext = parseContextCommentsAct(act(JOB_COMMENT_CONTEXT_ACT_SCHEMA,
    [{text: ' general\n', context}, {text: 'pinned', anchor, context: {tab: 'rig'}}]));
  const emitted = commentsActForEmission(withContext);
  expect(emitted.schema).toBe('rig-review/act@6');
  expect(JSON.stringify(emitted)).not.toContain('"context"');
  expect(JSON.stringify(emitted)).toBe(JSON.stringify(at6));
  expect(JSON.stringify(commentsActForEmission(parseCommentsAct(structuredClone(at6))))).toBe(JSON.stringify(at6));
  // The flag is the only switch: on, the same input goes out as @7 with its context.
  const on = commentsActForEmission(withContext, true);
  expect(on.schema).toBe(JOB_COMMENT_CONTEXT_ACT_SCHEMA);
  expect(JSON.stringify(on)).toBe(JSON.stringify(withContext));
  expect(commentsActForEmission(parseCommentsAct(structuredClone(at6)), true).schema).toBe('rig-review/act@6');
});
