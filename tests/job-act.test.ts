import { afterEach, expect, test } from 'bun:test';
import { finalizeJobAct, parseUISubmission } from '../src/job-act.ts';
import { JOB_ENABLED_ACT_KINDS, JOB_RESERVED_ACT_KINDS, type JobPendingAsk, type JobUISubmission } from '../src/job-contract.ts';
import { readFile, writeFile } from 'node:fs/promises';
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

test('P1 unrelated agent ask does not stale a captured pending UI act and future generations still refuse', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'captured-ui', kind: 'checkpoint', value: { checkpointId: 'step-one', outcome: 'pass', words: '' } };
  const unrelated = await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
  const future = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'future-ui', expectedGeneration: f.session.status().generation + 1 }));
  expect(future.ok).toBe(false);
  if (!future.ok) expect(future.error.code).toBe('JOB_GENERATION_STALE');
  const agentGeneration = f.session.status().generation;
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  if (!saved.ok) console.log(JSON.stringify({ pendingUIRefusal: saved.error }));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.askId).toBe(ask.askId);
  expect(f.session.status().pending.map(item => item.askId)).toContain(unrelated.askId);
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input))).toEqual(saved);
  const duplicate = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input,
    submissionId: 'duplicate-ui', expectedGeneration: f.session.status().generation }));
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok) expect(duplicate.error.code).toBe('JOB_ASK_SUPERSEDED');
  const staleAgent = await (await f.call({ ...f.base(), verb: 'ask', expectedGeneration: agentGeneration,
    idempotencyKey: 'stale-agent-cas', publicationId: publication.publicationId,
    subject: { kind: 'review-verdict', stage: 'rig-review' } })).json();
  expect(staleAgent.error.code).toBe('JOB_GENERATION_STALE');
});

test('pending UI act still refuses a rotated nonce, changed source and superseded publication', async () => {
  const f = await fixture(), publication = await f.publish();
  const ask = await f.ask(publication, { kind: 'checkpoint', checkpointId: 'step-one' }), page = await f.display(publication);
  const input = { ...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'pending-bindings', kind: 'checkpoint' as const, value: { checkpointId: 'step-one', outcome: 'pass' as const, words: '' } };
  const freshPage = await f.display(publication);
  await f.ask(publication, { kind: 'review-verdict', stage: 'rig-review' });
  const wrongNonce = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(wrongNonce.ok).toBe(false);
  if (!wrongNonce.ok) expect(wrongNonce.error.code).toBe('JOB_DISPLAY_MISMATCH');
  const retained = f.session.retainedSource(publication.publicationId);
  expect(() => finalizeJobAct({ jobId: f.session.jobId, submission: { ...input, ...freshPage },
    ask: { ...ask, status: 'superseded' }, retained, reviewer: { id: 'declared-owner', role: 'owner' } })).toThrow('JOB_ASK_SUPERSEDED');
  const manifestPath = join(f.root, 'out/review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, revision: 'changed-source' }));
  const changed = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, ...freshPage }));
  expect(changed.ok).toBe(false);
  if (!changed.ok) expect(changed.error.code).toBe('JOB_SOURCE_MISMATCH');
  const newer = await f.publish();
  expect(newer.publicationId).not.toBe(publication.publicationId);
  const oldPublication = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...input, ...freshPage }));
  expect(oldPublication.ok).toBe(false);
  if (!oldPublication.ok) expect(oldPublication.error.code).toBe('JOB_ACT_SOURCE_STALE');
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

test('parseUISubmission accepts all 5 enabled act kinds, preserves String(kind) conversion, refuses reserved kinds first and rejects invalid kinds', async () => {
  const base = { publicationId: 'publication-one', askId: 'ask-one', pageId: 'page-one', displayedNonce: 'nonce-one',
    expectedGeneration: 0, submissionId: 'submit-one', value: {} };
  expect(JOB_ENABLED_ACT_KINDS).toEqual(['interview-picks', 'checkpoint', 'parts-verdict', 'review-verdict', 'signoff']);
  for (const kind of JOB_ENABLED_ACT_KINDS) {
    const input = { ...base, kind };
    expect(parseUISubmission(input)).toEqual(input as unknown as JobUISubmission);
  }
  const stringified = { ...base, kind: ['checkpoint'] };
  expect(parseUISubmission(stringified)).toEqual(stringified as unknown as JobUISubmission);
  for (const kind of JOB_RESERVED_ACT_KINDS) {
    expect(() => parseUISubmission({ ...base, kind })).toThrow('JOB_ACT_KIND_DISABLED');
    expect(() => parseUISubmission({ ...base, publicationId: '', expectedGeneration: -1, kind })).toThrow('JOB_ACT_KIND_DISABLED');
  }
  for (const kind of ['unknown-kind', '', null, undefined, 42, ['unknown-kind']]) {
    expect(() => parseUISubmission({ ...base, kind })).toThrow('JOB_ACT_INVALID');
  }
  const f = await fixture(), publication = await f.publish(), page = await f.display(publication);
  for (const kind of JOB_RESERVED_ACT_KINDS) {
    const reserved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: 'ask-one',
      expectedGeneration: f.session.status().generation, submissionId: 'reserved-' + kind, kind, value: {} }));
    expect(reserved).toEqual({ ok: false, error: { code: 'JOB_ACT_KIND_DISABLED', message: 'JOB_ACT_KIND_DISABLED' } });
  }
  for (const kind of ['unknown-kind', '']) {
    const invalid = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({ ...page, askId: 'ask-one',
      expectedGeneration: f.session.status().generation, submissionId: 'invalid-' + kind, kind, value: {} }));
    expect(invalid).toEqual({ ok: false, error: { code: 'JOB_ACT_INVALID', message: 'JOB_ACT_INVALID' } });
  }
});
