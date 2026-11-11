import {expect, test} from 'bun:test';
import {checkpointNoteComments, feedbackItemComments, feedbackWordsComments, imageNoteComments,
  legacyActComments, legacyRecordActComments, legacySessionComments} from '../src/feedback-export.ts';
import {parseComments, parseRecordAct} from '../src/job-api.ts';
import type {ActV3, JobCommentsAct} from '../src/job-contract.ts';
import type {Feedback} from '../src/session.ts';
import legacy from './fixtures/comments-contract-legacy.json';

const feedback: Feedback = {id: 'one', frameStart: 3, frameEnd: 5,
  target: {kind: 'slot', name: 'sleeve'}, category: 'defect', summary: '  fix\nthis '};
test('Feedback mapper preserves order, duplicate text, side and detached evidence', () => {
  const rows = [{...feedback, context: {comment: {evidence: 'retained'}}}, {...feedback, id: 'two', side: 'a' as const}];
  const before = structuredClone(rows), mapped = feedbackItemComments(rows);
  expect(mapped.map(row => row.text)).toEqual([feedback.summary, feedback.summary]);
  expect(mapped[1]!.anchor).toEqual({...feedbackItemComments([feedback])[0]!.anchor, id: 'two', side: 'a'});
  expect(mapped[0]!.anchor.context).toEqual(rows[0]!.context);
  mapped[0]!.anchor.target.name = 'changed';
  (mapped[0]!.anchor.context as any).comment.evidence = 'changed';
  expect(rows).toEqual(before);
});
test('checkpoint mapping keeps explicit plan mapping and image notes keep names', () => {
  expect(checkpointNoteComments({checkpointId: 'checkpoint', planStepId: 'different-step', note: ' exact '}))
    .toEqual([{text: ' exact ', anchor: {checkpointId: 'checkpoint', planStepId: 'different-step'}}]);
  expect(imageNoteComments([{name: 'plate', words: ' first '}, {name: 'plate', words: ' first '}]))
    .toEqual([{text: ' first ', anchor: {name: 'plate'}}, {text: ' first ', anchor: {name: 'plate'}}]);
  expect(feedbackWordsComments(' words ')).toEqual([{text: ' words '}]);
});
test('mapped feedback uses existing decoder; empty preparation is not fresh text admission', () => {
  const item = {...feedback, summary: ' fix '};
  expect(parseComments(feedbackItemComments([item]), 'f'.repeat(64))).toEqual(feedbackItemComments([item]));
  expect(feedbackWordsComments('')).toEqual([{text: ''}]);
  expect(() => parseComments(feedbackWordsComments(''), 'f'.repeat(64))).toThrow('JOB_ACT_INVALID');
  expect(feedbackItemComments([])).toEqual([]);
  expect(imageNoteComments([])).toEqual([]);
});
test('historical sessions display every note and summary as general, including empty text', () => {
  const input = {checkpoints: {one: {outcome: 'pass' as const, note: ''}}, feedback: [feedback, feedback]};
  const before = structuredClone(input);
  expect(legacySessionComments(input)).toEqual([{text: ''}, {text: feedback.summary}, {text: feedback.summary}]);
  expect(input).toEqual(before);
});
test('legacy record display reuses decoder and preserves original bytes', () => {
  const raw = legacy.records['@4'].raw, input = JSON.parse(raw), before = structuredClone(input);
  const act = parseRecordAct(input);
  expect(legacyRecordActComments(input)).toEqual(legacyActComments(act));
  expect(input).toEqual(before);
  expect(legacy.records['@4'].raw).toBe(raw);
  expect(() => legacyRecordActComments({...input, schema: 'rig-review/act@6'})).toThrow('JOB_ACT_INVALID');
});
test('legacy acts preserve words and issue precedence, without reclassifying surveys', () => {
  for (const key of ['@2', '@3', '@5'] as const) {
    const act = JSON.parse(legacy.records[key].raw) as Exclude<ActV3, JobCommentsAct>;
    expect(legacyActComments(act)[0]).toEqual({text: (act.value as any).words});
  }
  const base = JSON.parse(legacy.records['@2'].raw);
  expect(legacyActComments({...base, kind: 'interview-picks', value: {note: 'survey'}})).toEqual([]);
  expect(legacyActComments({...base, kind: 'parts-verdict', value: {words: '', issues: [],
    parts: [{part: {note: 'ignored'}, mesh: {note: 'ignored'}}]}})).toEqual([{text: ''}]);
  expect(legacyActComments({...base, kind: 'review-verdict', value: {words: 'general',
    imageNotes: [{name: 'plate', words: ''}, {name: 'plate', words: 'note'}]}}))
    .toEqual([{text: 'general'}, {text: ''}, {text: 'note'}]);
});
