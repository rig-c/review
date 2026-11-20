import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts, parseRecordAct } from '../src/job-api.ts';
import { JOB_API_V3_SCHEMA, type OptionContext, type PendingAskV3, type PublicationV3, type RecordSubject } from '../src/job-contract.ts';
import {
  createSyntheticOptionRecordWorkspace, createSyntheticOptionSetsRecordWorkspace, createSyntheticRecordReader, type SyntheticOptionWorkspace,
} from './helpers/job-record-fixture.ts';

// Review #1004: one option-set publication carries 1..K sets, each ask binds its own set and an act for one set
// leaves the other asks pending. Review-side synthetic reader only; no installed Create conformance claim.

async function setsFixture(prefix: string, build: (root: string) => SyntheticOptionWorkspace,
  context?: (workspace: SyntheticOptionWorkspace) => OptionContext) {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), prefix));
  const root = join(scratch, 'input');
  await mkdir(root);
  const workspace = build(root);
  const reader = createSyntheticRecordReader({ onOption: () => structuredClone(context?.(workspace) ?? workspace.context) });
  const session = new JobSession({ root, stateDir: join(scratch, 'state'), fingerprint: 'b'.repeat(64),
    reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package', readRecordPublished: reader.reader });
  const origin = 'http://127.0.0.1:19004', ports = createJobHostPorts(session, origin), credentials = session.hostCredentials();
  let sequence = 0;
  const call = async (body: object) => (await ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credentials.agent },
    body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'request-' + (++sequence), ...body }),
  }))).json();
  const publish = (result: object = workspace.result, idempotencyKey = 'publish') => call({ verb: 'publish',
    expectedGeneration: session.status().generation, idempotencyKey, result,
    freeze: { kind: 'producer-held', holdId: 'synthetic', record: workspace.record } });
  const ui = (path: string, body: object) => new Request(`${origin}/jobs/${session.jobId}/ui/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': credentials.ui }, body: JSON.stringify(body) });
  /** Answer one ask the way the page does: the recommended option of every item, an empty note. */
  const answer = async (publication: PublicationV3, ask: PendingAskV3) => {
    const displayed = await ports.ackDisplayed(session.jobId, ui('displayed', { publicationId: publication.publicationId,
      pageId: 'page-1004', sourceHash: publication.source.sourceHash }));
    if (!displayed.ok) throw new Error(displayed.error.code);
    if (ask.subject.kind !== 'interview-picks') throw new Error('not an interview ask');
    const question = session.retainedSourceV3(publication.publicationId).questions
      .find(item => item.set.question === (ask.subject as { questionId: string }).questionId)!;
    return ports.commitUIAct(session.jobId, ui('acts', { publicationId: publication.publicationId, askId: ask.askId, pageId: 'page-1004',
      displayedNonce: displayed.value.displayedNonce, expectedGeneration: session.status().generation, submissionId: 'submit-' + ask.askId,
      kind: 'interview-picks', value: { questionId: ask.subject.questionId,
        selections: question.set.asks.map(item => ({ itemId: item.id, optionId: item.options.find(option => option.recommended)!.id, otherText: null })),
        note: '' } }));
  };
  return { scratch, workspace, reader, session, call, publish, answer,
    dispose: async () => { session.dispose(); await rm(scratch, { recursive: true, force: true }); } };
}

test('#1004 K = 4 publishes four questions; two acts leave two asks pending, two more acts answer them', async () => {
  const fixture = await setsFixture('review-1004-sets-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 4 }));
  try {
    const published = await fixture.publish();
    expect(published.ok).toBe(true);
    const publication = published.value as PublicationV3;
    const source = publication.source as Extract<PublicationV3['source'], { subject: 'option-set' }>;
    expect(source.subjects.map(subject => subject.questionId)).toEqual(['bones', 'meshes', 'constraints', 'motion']);
    expect(source.optionSets!.map(row => [row.questionId, row.optionSetFile.path])).toEqual([
      ['bones', 'interview/options/rigging-1.json'], ['meshes', 'interview/options/rigging-2.json'],
      ['constraints', 'interview/options/rigging-3.json'], ['motion', 'interview/options/rigging-4.json']]);
    expect(source.optionSet).toEqual(source.optionSets![0]!.optionSet);
    expect(fixture.session.retainedSourceV3(publication.publicationId).questions.map(question => question.set.question))
      .toEqual(['bones', 'meshes', 'constraints', 'motion']);

    // Four single asks on the one publication: none supersedes another.
    const asks: PendingAskV3[] = [];
    for (const [index, subject] of source.subjects.entries()) {
      const asked = await fixture.call({ verb: 'ask', expectedGeneration: fixture.session.status().generation,
        idempotencyKey: 'ask-' + index, publicationId: publication.publicationId, subject });
      expect(asked.ok).toBe(true);
      asks.push(asked.value);
    }
    expect(fixture.session.status().pending.map(ask => ask.askId)).toEqual(asks.map(ask => ask.askId));

    // Answer 2 of 4: two acts, the other two asks stay pending.
    const first = [await fixture.answer(publication, asks[0]!), await fixture.answer(publication, asks[2]!)];
    for (const act of first) {
      expect(act.ok).toBe(true);
      if (act.ok) expect(parseRecordAct(act.value)).toEqual(act.value as never);
    }
    const firstActs = first.map(act => act.ok ? act.value as unknown as { kind: string; askId: string; value: { questionId: string } } : null);
    expect(firstActs.map(act => [act!.kind, act!.askId, act!.value.questionId]))
      .toEqual([['interview-picks', asks[0]!.askId, 'bones'], ['interview-picks', asks[2]!.askId, 'constraints']]);
    expect(fixture.session.status().pending.map(ask => ask.subject)).toEqual([source.subjects[1], source.subjects[3]]);
    // The stored ask replay is still true for an answered ask (#1022 rule unchanged).
    const replay = await fixture.call({ verb: 'ask', expectedGeneration: 1, idempotencyKey: 'ask-0', publicationId: publication.publicationId,
      subject: source.subjects[0] });
    expect(replay.ok).toBe(true);

    // Answer the other two later: two more acts, nothing pending.
    for (const ask of [asks[1]!, asks[3]!]) expect((await fixture.answer(publication, ask)).ok).toBe(true);
    expect(fixture.session.status().pending).toEqual([]);
  } finally { await fixture.dispose(); }
});

test('#1004 an ask-batch over a K = 4 publication binds each set and every ask keeps its own set', async () => {
  const fixture = await setsFixture('review-1004-batch-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 4 }));
  try {
    const publication = (await fixture.publish()).value as PublicationV3;
    const subjects = (publication.source as { subjects: readonly RecordSubject[] }).subjects;
    const batch = await fixture.call({ verb: 'ask-batch', expectedGeneration: fixture.session.status().generation,
      idempotencyKey: 'batch', publicationId: publication.publicationId, subjects });
    expect(batch.ok).toBe(true);
    expect((batch.value.asks as PendingAskV3[]).map(ask => ask.subject)).toEqual([...subjects]);
    const act = await fixture.answer(publication, batch.value.asks[3]);
    expect(act.ok).toBe(true);
    expect(fixture.session.status().pending.length).toBe(3);
    // A set the publication does not carry is not askable.
    const stray = await fixture.call({ verb: 'ask', expectedGeneration: fixture.session.status().generation, idempotencyKey: 'stray',
      publicationId: publication.publicationId, subject: { kind: 'interview-picks', questionId: 'bones', setId: 'rig-meshes-01' } });
    expect(stray).toMatchObject({ ok: false, error: { code: 'JOB_ASK_INVALID' } });
  } finally { await fixture.dispose(); }
});

test('#1004 two subjects for one set, or one set named twice, refuse JOB_OPTION_SET_DUPLICATE and publish nothing', async () => {
  const doubled = await setsFixture('review-1004-dup-', root => createSyntheticOptionRecordWorkspace(root),
    workspace => ({ ...workspace.context, subjects: [workspace.context.subjects[0]!, workspace.context.subjects[0]!] }));
  try {
    const refused = await doubled.publish();
    expect(refused).toMatchObject({ ok: false, error: { code: 'JOB_OPTION_SET_DUPLICATE', message: 'two subjects for set rig_type/set_rig_type_01' } });
    expect(doubled.session.status()).toMatchObject({ generation: 0, publication: null });
  } finally { await doubled.dispose(); }

  const sets = await setsFixture('review-1004-dup-sets-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 2 }));
  try {
    const result = sets.workspace.result as { kind: 'option-set'; questionId: string; setId: string; sets: object[] };
    const refused = await sets.publish({ ...result, sets: [result.sets[0], result.sets[1], result.sets[0]] });
    expect(refused).toMatchObject({ ok: false, error: { code: 'JOB_OPTION_SET_DUPLICATE', message: 'set bones/rig-bones-01 is named twice' } });
    // One set never uses `sets`, so it keeps a single encoding.
    expect(await sets.publish({ ...result, sets: [result.sets[0]] }, 'one')).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID' } });
    expect(sets.session.status()).toMatchObject({ generation: 0, publication: null });
    expect(sets.reader.calls.length).toBe(0);
  } finally { await sets.dispose(); }
});

test('#1004 K = 1 keeps the source bytes recorded on main 199b43a (control)', async () => {
  const fixture = await setsFixture('review-1004-k1-', root => createSyntheticOptionRecordWorkspace(root));
  try {
    const publication = (await fixture.publish()).value as PublicationV3;
    // Recorded by running the same publish on origin/main 199b43a before this change.
    expect(publication.source.sourceHash).toBe('85a7e3edab3021115972d4fee6a48351c8177c51a9e107797f906ebb419663bd');
    expect(Object.keys(publication.source)).not.toContain('optionSets');
    expect((publication.source as { selection: object }).selection).toEqual({ kind: 'option-set', questionId: 'rig_type', setId: 'set_rig_type_01' });
  } finally { await fixture.dispose(); }
});
