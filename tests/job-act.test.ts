import { afterEach, expect, test } from 'bun:test';
import { finalizeJobAct } from '../src/job-act.ts';
import type { JobPendingAsk, JobUISubmission } from '../src/job-contract.ts';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jobFixture, syntheticJobParts } from './helpers/job-api-fixture.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
async function fixture() { const f = await jobFixture(); fixtures.push(f); return f; }

test('actual UI ports finalize exact empty/whitespace words with host-declared authority and idempotent act IDs', async () => {
  const f = await fixture(), publication = await f.publish();
  for (const text of ['', ' \n\t ', '원문\nline two']) {
    const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' });
    const page = await f.display(publication);
    const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: 'submit-' + ask.askId, kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: text } };
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value.value).toEqual({ checkpointId: 'step-one', planStepId: 'step-one', outcome: 'pass', words: text });
    expect(saved.value.authority).toEqual({ actor: 'human', channel: 'review-ui', reviewer: { id: 'declared-owner', role: 'owner' } });
    expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input)))).toEqual(saved);
    const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, f.session.writerGrant().fetchCapability)).json();
    expect(fetched.value).toEqual(saved.value);
  }
});

test('pending checkpoint and browser-supplied authority/plan mapping are refused; fail is a distinct nonapproval act', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'checkpoint', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pending', words: '' } };
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).ok).toBe(false);
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, authority: { actor: 'human' } }))).ok).toBe(false);
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    value: { ...input.value, outcome: 'pass', planStepId: 'different' } }))).ok).toBe(false);
  const failed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, value: { ...input.value, outcome: 'fail' } }));
  expect(failed.ok).toBe(true);
  if (failed.ok) { expect(failed.value.kind).toBe('checkpoint'); expect(failed.value.value).toHaveProperty('outcome', 'fail'); }
});

test('all three plan sign-off stages require published IDs/hashes and accept only approval with exact words', async () => {
  const f = await fixture(), publication = await f.publish();
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const ask = await f.ask(publication, { kind: 'signoff', stage }), page = await f.display(publication);
    const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
      submissionId: stage, kind: 'signoff', value: { stage, decision: 'approved', words: '' } };
    const rejected = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, value: { ...input.value, decision: 'changes-requested' } }));
    expect(rejected.ok).toBe(false);
    const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.value.source.plan?.steps).toEqual([{ id: 'step-one', hash: '1'.repeat(64) }]);
  }
  const missing = f.getContext();
  f.setContext({ ...missing, plan: null });
  const newer = await f.publish();
  for (const stage of ['plan-approved', 'rigging-interview', 'post-interview']) {
    const response = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: f.session.status().generation,
      idempotencyKey: 'missing-' + stage, publicationId: newer.publicationId, subject: { kind: 'signoff', stage } })).json();
    expect(response.error.code).toBe('JOB_ASK_INVALID');
  }
});

test('review verdict remains separate from sign-off and is bound to the displayed model/version', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' }), page = await f.display(publication);
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'review', kind: 'review-verdict',
    value: { stage: 'rig-review', verdict: 'approved', words: 'exact verdict' } }));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.source.model).toEqual(publication.source.model);
    expect(result.value.source.selector).toEqual({ kind: 'rig', version: 1 });
    expect(result.value.kind).toBe('review-verdict');
  }
  expect(f.session.status().pending).toHaveLength(0);
});

test('synthetic private adapters validate ordered interview picks without exposing storage formats', async () => {
  const f = await fixture(), publication = await f.publish();
  const retained = f.session.retainedSource(publication.publicationId);
  const question = { ref: { path: 'synthetic/options.json', sha256: '2'.repeat(64) }, editable: true,
    set: { id: 'set-one', question: 'question-one', stage: 'interview', drafted_by: 'synthetic', drafted_at: '2020-01-01T00:00:00Z',
      asks: [{ id: 'item-one', prompt: 'Choose', options: [{ id: 'value-one', kind: 'value', label: 'One', effect: 'One', recommended: true }] }],
      assembly: { rule: 'single' } }, images: [], hasParts: false } as const;
  const withQuestion = { ...retained, questions: [structuredClone(question)] } as unknown as typeof retained;
  const ask: JobPendingAsk = { askId: 'ask-one', publicationId: publication.publicationId,
    subject: { kind: 'interview-picks', questionId: 'question-one', setId: 'set-one' },
    source: { ...retained.source, optionSet: { id: 'set-one', sha256: question.ref.sha256 } }, status: 'pending' };
  const common = { publicationId: publication.publicationId, askId: ask.askId, pageId: 'page', displayedNonce: 'nonce',
    expectedGeneration: 1, submissionId: 'submission' };
  const submission: JobUISubmission = { ...common, kind: 'interview-picks', value: {
    questionId: 'question-one', selections: [{ itemId: 'item-one', optionId: 'value-one', otherText: null }], note: '원문' } };
  const act = finalizeJobAct({ jobId: f.session.jobId, submission, ask, retained: withQuestion,
    reviewer: { id: 'owner', role: 'owner' } });
  expect(act.kind).toBe('interview-picks');
  expect(act.value).toEqual(submission.value);
  expect(() => finalizeJobAct({ jobId: f.session.jobId, submission: { ...submission, value: {
    ...submission.value, selections: [{ itemId: 'different', optionId: 'value-one', otherText: null }] } },
  ask, retained: withQuestion, reviewer: { id: 'owner', role: 'owner' } })).toThrow('JOB_ACT_INVALID');
});

test('parts-verdict UI save covers every declared part and mesh, preserves words, rejects invalid outcomes and binds all referenced bytes', async () => {
  const f = await fixture(), parts = await syntheticJobParts(f, { project: true, painting: true });
  const publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
  const page = await f.display(publication);
  const clean = ['body', 'head'].map(partId => ({ partId, part: { outcome: 'clean' as const, note: '' }, mesh: { outcome: 'clean' as const, note: '' } }));
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'parts-submit', kind: 'parts-verdict', value: { verdict: 'approved' as const, parts: clean, words: ' \n원문 ' } };
  const invalidParts = [clean.slice(0, 1), [clean[0], clean[0]], [...clean, clean[0]],
    [{ ...clean[0], partId: 'unknown' }, clean[1]],
    [{ ...clean[0], mesh: { outcome: 'flagged', note: '' } }, clean[1]],
    [{ ...clean[0], mesh: { outcome: 'pending', note: '' } }, clean[1]]];
  for (const given of invalidParts) {
    expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, value: { ...input.value, parts: given } }))).ok).toBe(false);
  }
  expect((await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    value: { ...input.value, verdict: 'changes-requested' } }))).ok).toBe(false);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.kind).toBe('parts-verdict');
  expect(saved.value.value).toEqual(input.value);
  expect(saved.value.source.parts).toEqual(parts);
  expect(saved.value.source.projectHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const fetched = await (await f.call({ ...f.base(), verb: 'fetch-act', actId: saved.value.actId }, f.session.writerGrant().fetchCapability)).json();
  expect(fetched.value).toEqual(saved.value);
  const secondAsk = await f.ask(publication, { kind: 'parts-verdict', draftId: 'synthetic-draft' });
  await writeFile(join(f.root, 'out/parts/depth.png'), 'changed depth only');
  const stale = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, askId: secondAsk.askId,
    submissionId: 'stale-parts', expectedGeneration: f.session.status().generation }));
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe('JOB_SOURCE_MISMATCH');
});
