import {seedHistoricalDecisionAct} from './helpers/historical-decision-act.ts';
import historicalDirection from './fixtures/job-decision-1233/direction.json';
import {seedHistoricalVerdictAsk} from './helpers/historical-verdict-ask.ts';
import {afterEach, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {cp} from 'node:fs/promises';
import {join} from 'node:path';
import {parseJobRequest} from '../src/job-api.ts';
import type {JobAnsweredDirectionFeedback, JobComment, JobPublication, JobVerdict} from '../src/job-contract.ts';
import {JobSession} from '../src/job-session.ts';
import {feedbackItemComments} from '../src/stage-comment.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {syntheticPinnedFeedback} from './helpers/job-pinned-comments.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});

const stage = 'direction-review';
const subject = {kind: 'review-verdict', stage} as const;
const comments = [{text: '  원문 그대로\r\nKeep the camera still.  \n'}, {text: 'A second comment'}];
const invalid = 'JOB_ANSWERED_DIRECTION_FEEDBACK_INVALID';

async function fixture(direction = true) {
  const f = await jobFixture();
  fixtures.push(f);
  if (direction) {
    await cp(new URL('./fixtures/direction-inspection', import.meta.url), join(f.root, 'out'), {recursive: true});
  }
  return f;
}

function post(f: Awaited<ReturnType<typeof fixture>>, version: number, field: object = {}) {
  f.setContext({...f.getContext(), selector: {kind: 'post', version, rigVersion: 1}, ...field});
}

async function finalize(f: Awaited<ReturnType<typeof fixture>>, publication: JobPublication,
  options: {other?: boolean; verdict?: JobVerdict; comments?: readonly JobComment[]} = {}) {
  // #1235: the comment-only act@10 sample, which answers no ask (#1231: it is direction feedback on a post).
  if (options.other) {
    const page = await f.display(publication);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page,
      expectedGeneration: f.session.status().generation, submissionId: 'other-kind', kind: 'comments',
      value: {comments: [{text: 'Comment-only act'}]}}));
    if (!saved.ok) throw new Error(saved.error.code);
    return saved.value;
  }
  const ask = seedHistoricalVerdictAsk(f.session, publication.publicationId, subject);
  return seedHistoricalDecisionAct(f.session,ask,historicalDirection.receipt.value,{
    stage, verdict: options.verdict ?? 'changes-requested', comments: options.comments ?? comments,
  });
}

function reopen(f: Awaited<ReturnType<typeof fixture>>): JobSession {
  f.session.dispose();
  return new JobSession({root: f.root, stateDir: f.state, fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}});
}

test('#1201 omitted field keeps historical post, display, next event and raw act bytes', async () => {
  const f = await fixture();
  post(f, 2);
  const publication = await f.publish();
  expect(publication).not.toHaveProperty('answeredDirectionFeedback');
  const bytes = JSON.stringify(publication);
  const act = await finalize(f, publication);
  const actBytes = JSON.stringify(act);
  const display = await f.ports.readPublication(f.session.jobId, publication.publicationId);
  expect(display.ok && JSON.stringify(display.value.publication)).toBe(bytes);
  const next = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  expect(JSON.stringify(next.value.events[0].publication)).toBe(bytes);
  expect(JSON.stringify(next.value.events[2].act)).toBe(actBytes);
  const reopened = reopen(f);
  try {
    expect(JSON.stringify(reopened.status().publication)).toBe(bytes);
    expect(JSON.stringify(reopened.displayPublication(publication.publicationId).publication)).toBe(bytes);
    expect(reopened.readActExport(act.actId, false).toString()).toBe(actBytes);
  } finally { reopened.dispose(); }
});

test.each([
  ['explicit undefined', undefined],
  ['null', null],
  ['non-array', {}],
  ['sparse entry', new Array(1)],
  ['missing identity', [{jobId: 'own'}]],
  ['extra key', [{jobId: 'own', actId: 'earlier', comment: 'forged'}]],
  ['wrong identity type', [{jobId: 'own', actId: 2}]],
  ['whitespace identity', [{jobId: 'own', actId: ' earlier'}]],
])('#1201 refuses malformed answeredDirectionFeedback (%s) by name', async (_name, field) => {
  const f = await fixture();
  post(f, 3, {answeredDirectionFeedback: field});
  const response = await f.call(await f.publishRequest());
  expect(await response.json()).toMatchObject({ok: false, generation: 0, error: {code: invalid}});
  expect(response.status).toBe(409);
  expect(f.session.status().publication).toBeNull();
});

// #1231: a comment-only act@10 on the post is direction feedback now, so it left this list (see the test below).
test.each(['wrong job', 'unknown act', 'inherited act ID', 'pending ask', 'same version', 'future version',
  'non-post selector', 'no direction asset', 'mixed valid and unknown'])('#1201 refuses ineligible answeredDirectionFeedback (%s) by name', async reason => {
  const f = await fixture();
  post(f, 2);
  const earlier = await f.publish();
  const act = await finalize(f, earlier);
  const pending = reason === 'pending ask' ? seedHistoricalVerdictAsk(f.session, earlier.publicationId, subject) : undefined;
  const field = {answeredDirectionFeedback: [{
    jobId: reason === 'wrong job' ? 'other-job' : f.session.jobId,
    actId: pending?.askId ?? (reason === 'unknown act' ? 'unknown-act' : reason === 'inherited act ID' ? 'constructor' : act.actId),
  }]};
  if (reason === 'mixed valid and unknown') field.answeredDirectionFeedback.push({jobId: f.session.jobId, actId: 'unknown-act'});
  post(f, reason === 'same version' ? 2 : reason === 'future version' ? 1 : 3, field);
  if (reason === 'non-post selector') {
    f.setContext({...f.getContext(), selector: {kind: 'rig', version: 1}});
  } else if (reason === 'no direction asset') {
    await cp(new URL('./fixtures/viewport-387/package', import.meta.url), join(f.root, 'out'), {recursive: true});
  }
  const before = f.session.status();
  const response = await f.call(await f.publishRequest());
  expect(await response.json()).toMatchObject({ok: false, generation: before.generation, error: {code: invalid}});
  expect(response.status).toBe(409);
  expect(f.session.status()).toEqual(before);
  expect(f.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
});

test('#1231 an act@10 sent on an earlier post resolves as answered direction feedback and survives restart', async () => {
  const f = await fixture();
  post(f, 1);
  const earlier = await f.publish();
  const act = await finalize(f, earlier, {other: true});
  expect(act.schema).toBe('rig-review/act@10');
  post(f, 2, {answeredDirectionFeedback: [{jobId: f.session.jobId, actId: act.actId}]});
  const response = await f.call(await f.publishRequest('answer-act10'));
  const body = await response.json() as {ok: boolean; value: JobPublication};
  expect(body.ok).toBe(true);
  const entries: readonly JobAnsweredDirectionFeedback[] = [{jobId: f.session.jobId, actId: act.actId, postVersion: 1,
    answeredByPostVersion: 2, comments: [{text: 'Comment-only act', kind: 'general'}]}];
  expect(body.value.answeredDirectionFeedback).toEqual(entries);
  const bytes = JSON.stringify(body.value);
  const reopened = reopen(f);
  try {
    expect(JSON.stringify(reopened.displayPublication(body.value.publicationId).publication)).toBe(bytes);
    expect(reopened.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
  } finally { reopened.dispose(); }
});

test('#1201 resolves only the producer-declared acts across an intervening publication and preserves exact bytes through restart and replay', async () => {
  const f = await fixture();
  post(f, 1);
  const firstPost = await f.publish();
  const first = await finalize(f, firstPost, {verdict: 'approved'});
  post(f, 2);
  const secondPost = await f.publish();
  const pins = feedbackItemComments(syntheticPinnedFeedback({...secondPost.source, model: secondPost.source.model!}, 1));
  const second = await finalize(f, secondPost, {comments: [...pins, comments[0]]});
  const skipped = await finalize(f, secondPost, {comments: [{text: 'Earlier feedback without a producer reference'}]});
  const firstBytes = f.session.readActExport(first.actId, false).toString();
  const secondBytes = f.session.readActExport(second.actId, false).toString();
  expect(secondBytes).toContain('data:image/png;base64,');
  f.setContext({...f.getContext(), selector: {kind: 'rig', version: 4}});
  const between = await f.publish();
  const ref = ({jobId, actId}: typeof first) => ({jobId, actId});
  f.setContext({...f.getContext(), selector: {kind: 'post', version: 3, rigVersion: 4},
    answeredDirectionFeedback: [ref(second), ref(first)]});
  const signal = new AbortController().signal;
  const input = parseJobRequest(await f.publishRequest('answer-v3'));
  const result = await f.session.execute(input, signal) as JobPublication;
  const entries: readonly JobAnsweredDirectionFeedback[] = [{
    ...ref(second), postVersion: 2, answeredByPostVersion: 3,
    comments: [{text: pins[0].text, kind: 'pinned'}, {text: comments[0].text, kind: 'general'}],
  }, {
    ...ref(first), postVersion: 1, answeredByPostVersion: 3,
    comments: comments.map(({text}) => ({text, kind: 'general' as const})),
  }];
  expect(result.answeredDirectionFeedback).toEqual(entries);
  expect(result.previousPublicationId).toBe(between.publicationId);
  expect(result.source).not.toHaveProperty('answeredDirectionFeedback');
  expect(JSON.stringify(result)).not.toContain(skipped.actId);
  expect(JSON.stringify(result)).not.toContain('data:image/png;base64,');
  const resultBytes = JSON.stringify(result);
  const display = await f.ports.readPublication(f.session.jobId, result.publicationId);
  expect(display.ok && JSON.stringify(display.value.publication)).toBe(resultBytes);
  const answeringAct = await finalize(f, result);
  expect(answeringAct.source).not.toHaveProperty('answeredDirectionFeedback');
  expect(answeringAct).not.toHaveProperty('answeredDirectionFeedback');
  const answeringBytes = JSON.stringify(answeringAct);
  const nextRequest = parseJobRequest({...f.base(), verb: 'next', after: null, waitMs: 0});
  const next = await f.session.execute(nextRequest, signal);
  expect((next as {events: unknown[]}).events).toContainEqual(expect.objectContaining({type: 'published', publication: result}));
  expect((next as {events: unknown[]}).events).toContainEqual(expect.objectContaining({type: 'act', act: second}));

  const reopened = reopen(f);
  try {
    expect(reopened.jobId).toBe(f.session.jobId);
    expect(JSON.stringify(reopened.status().publication)).toBe(resultBytes);
    expect(JSON.stringify(reopened.displayPublication(result.publicationId).publication)).toBe(resultBytes);
    expect(JSON.stringify(await reopened.execute(input, signal))).toBe(resultBytes);
    expect(JSON.stringify(await reopened.execute(nextRequest, signal))).toBe(JSON.stringify(next));
    expect(reopened.readActExport(first.actId, false).toString()).toBe(firstBytes);
    expect(reopened.readActExport(second.actId, false).toString()).toBe(secondBytes);
    expect(reopened.readActExport(answeringAct.actId, false).toString()).toBe(answeringBytes);
  } finally { reopened.dispose(); }
});

test('#1201 restores empty optional arrays and refuses tampered durable copies', async () => {
  const f = await fixture();
  post(f, 1);
  const earlier = await f.publish();
  const act = await finalize(f, earlier);
  post(f, 2, {answeredDirectionFeedback: []});
  const empty = await f.publish();
  expect(empty.answeredDirectionFeedback).toEqual([]);
  post(f, 3, {answeredDirectionFeedback: [{jobId: f.session.jobId, actId: act.actId}]});
  const response = await f.call(await f.publishRequest('answer'));
  const {value: publication} = await response.json() as {value: JobPublication};
  expect(publication.answeredDirectionFeedback).toHaveLength(1);
  const reopened = reopen(f);
  const db = new Database(join(f.state, 'jobs.sqlite'));
  try {
    expect(reopened.displayPublication(empty.publicationId).publication.answeredDirectionFeedback).toEqual([]);
    const id = reopened.jobId;
    const {document} = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(id)!;
    const update = db.query('UPDATE jobs SET document=? WHERE job_id=?');
    for (const target of ['reference', 'act', 'publication', 'published event', 'publish receipt']) {
      const row = JSON.parse(document);
      const stored = row.publications[publication.publicationId];
      if (target === 'reference') stored.retained.answeredDirectionFeedback[0].actId = 'unknown-act';
      if (target === 'act') row.acts[act.actId].value.comments[0].text = 'different act bytes';
      if (target === 'publication') delete stored.publication.answeredDirectionFeedback;
      if (target === 'published event') delete row.events.at(-1).publication.answeredDirectionFeedback;
      if (target === 'publish receipt') delete row.replays['agent:answer'].value.answeredDirectionFeedback;
      update.run(JSON.stringify(row), id);
      expect(() => reopened.status(), target).toThrow('JOB_SOURCE_MISMATCH');
    }
    update.run(document, id);
    expect(reopened.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
  } finally {
    db.close();
    reopened.dispose();
  }
});
