import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { JobSession } from '../src/job-session.ts';
import { createJobHostPorts, parseCommentsAct, recordActSource } from '../src/job-api.ts';
import { retainedPublicationRoutes } from '../src/job-front.ts';
import { JOB_API_V3_SCHEMA, type OptionContext, type PublicationV3, type RecordSource, type RecordSubject } from '../src/job-contract.ts';
import {
  createSyntheticOptionRecordWorkspace, createSyntheticOptionSetsRecordWorkspace, createSyntheticRecordReader, type SyntheticOptionWorkspace,
} from './helpers/job-record-fixture.ts';

// Review #1004: one option-set publication carries 1..K sets and each act names its own set. Review #1230 refuses
// fresh interview-picks asks: publications declaring picks subjects still parse, and per-set acts committed before the
// refusal still decode. Review-side synthetic reader only; no installed Create conformance claim.

type RecordActOf = { value: { questionId: string }; source: Extract<PublicationV3['source'], { subject: 'option-set' }> };

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
  const call = async (body: object, token = credentials.agent) => (await ports.handleJobApi(new Request(origin + `/jobs/${session.jobId}/api`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ schema: JOB_API_V3_SCHEMA, jobId: session.jobId, requestId: 'request-' + (++sequence), ...body }),
  }))).json();
  const publish = (result: object = workspace.result, idempotencyKey = 'publish') => call({ verb: 'publish',
    expectedGeneration: session.status().generation, idempotencyKey, result,
    freeze: { kind: 'producer-held', holdId: 'synthetic', record: workspace.record } });
  const ui = (path: string, body: object) => new Request(`${origin}/jobs/${session.jobId}/ui/${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': credentials.ui }, body: JSON.stringify(body) });
  /** A per-set act in the removed record writer's key order, as committed before #1230: the recommended option of every item, an empty note. */
  const historicalAct = (publication: PublicationV3, subject: RecordSubject) => {
    if (subject.kind !== 'interview-picks') throw new Error('not an interview subject');
    const question = session.retainedSourceV3(publication.publicationId).questions.find(item => item.set.question === subject.questionId)!;
    return { schema: 'rig-review/act@6', actId: 'historical-act-' + subject.questionId, jobId: session.jobId,
      askId: 'historical-ask-' + subject.questionId, publicationId: publication.publicationId, kind: 'interview-picks',
      authority: { actor: 'human', channel: 'review-ui', reviewer: { id: 'synthetic-owner', role: 'owner' } },
      at: '2026-11-01T00:00:00.000Z', source: recordActSource(publication.source as RecordSource, subject),
      value: { questionId: subject.questionId,
        selections: question.set.asks.map(item => ({ itemId: item.id, optionId: item.options.find(option => option.recommended)!.id, otherText: null })),
        note: '', comments: [] } };
  };
  return { scratch, workspace, reader, session, call, publish, historicalAct,
    dispose: async () => { session.dispose(); await rm(scratch, { recursive: true, force: true }); } };
}

test('#1004 / #1230 K = 4 publishes four questions; fresh asks refuse JOB_REQUEST_INVALID and historical per-set acts decode', async () => {
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

    // #1230: every declared set refuses a fresh ask; nothing is stored and the generation does not move.
    const generation = fixture.session.status().generation;
    for (const [index, subject] of source.subjects.entries()) {
      const asked = await fixture.call({ verb: 'ask', expectedGeneration: generation,
        idempotencyKey: 'ask-' + index, publicationId: publication.publicationId, subject });
      expect(asked).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });
    }
    expect(fixture.session.status()).toMatchObject({ generation, pending: [] });

    // Each historical act names its own set; subjects, optionSets and sourceHash stay the publication's.
    const acts = source.subjects.map(subject => fixture.historicalAct(publication, subject) as unknown as RecordActOf);
    for (const [index, act] of acts.entries()) {
      const row = source.optionSets![index]!;
      expect(act.value.questionId).toBe(row.questionId);
      expect(act.source.selection).toEqual({ kind: 'option-set', questionId: row.questionId, setId: row.setId, sets: source.selection.sets });
      expect(act.source.optionSet).toEqual(row.optionSet);
      expect(act.source.optionSetFile).toEqual(row.optionSetFile);
      expect(act.source.optionSets).toEqual(source.optionSets);
      expect(act.source.subjects).toEqual(source.subjects);
      expect(act.source.sourceHash).toBe(source.sourceHash);
      // Re-derivation: put set 0 back into the singular fields and the publication source returns.
      expect({ ...act.source, selection: source.selection, optionSet: source.optionSet, optionSetFile: source.optionSetFile }).toEqual(source);
      const bytes = JSON.stringify(act);
      expect(JSON.stringify(parseCommentsAct(JSON.parse(bytes)))).toBe(bytes);
    }
    expect(new Set(acts.map(act => act.source.optionSet.id)).size).toBe(4);
  } finally { await fixture.dispose(); }
});

test('#1004 / #1230 an ask-batch over a K = 4 publication refuses JOB_REQUEST_INVALID by name', async () => {
  const fixture = await setsFixture('review-1004-batch-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 4 }));
  try {
    const publication = (await fixture.publish()).value as PublicationV3;
    const subjects = (publication.source as { subjects: readonly RecordSubject[] }).subjects;
    const generation = fixture.session.status().generation;
    const batch = await fixture.call({ verb: 'ask-batch', expectedGeneration: generation,
      idempotencyKey: 'batch', publicationId: publication.publicationId, subjects });
    expect(batch).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask-batch' } });
    expect(fixture.session.status()).toMatchObject({ generation, pending: [] });
    // A set the publication does not carry is not askable either.
    const stray = await fixture.call({ verb: 'ask', expectedGeneration: generation, idempotencyKey: 'stray',
      publicationId: publication.publicationId, subject: { kind: 'interview-picks', questionId: 'bones', setId: 'rig-meshes-01' } });
    expect(stray).toMatchObject({ ok: false, error: { code: 'JOB_REQUEST_INVALID', message: 'Unknown job verb: ask' } });
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

test('#1004 an act whose set fields disagree is refused by name (JOB_ACT_INVALID)', async () => {
  const fixture = await setsFixture('review-1004-act-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 4 }));
  try {
    const publication = (await fixture.publish()).value as PublicationV3;
    const subjects = (publication.source as { subjects: readonly RecordSubject[] }).subjects;
    // #1230: the act is historical; the decoder that refuses disagreeing set fields stays.
    const act = fixture.historicalAct(publication, subjects[2]!) as unknown as RecordActOf & Record<string, unknown>;
    const other = act.source.optionSets![1]!;
    const refused = (mutate: (copy: typeof act) => void) => {
      const copy = structuredClone(act); mutate(copy);
      try { parseCommentsAct(copy); return null; } catch (error) { return { code: (error as { code?: string }).code, message: (error as Error).message }; }
    };
    expect(refused(copy => { (copy.source as { optionSet: object }).optionSet = other.optionSet; }))
      .toEqual({ code: 'JOB_ACT_INVALID', message: 'act optionSet does not name set constraints/rig-constraints-01' });
    expect(refused(copy => { (copy.source as { optionSetFile: object }).optionSetFile = other.optionSetFile; }))
      .toEqual({ code: 'JOB_ACT_INVALID', message: 'act optionSetFile is not the file of set constraints/rig-constraints-01' });
    expect(refused(copy => { copy.value.questionId = 'meshes'; }))
      .toEqual({ code: 'JOB_ACT_INVALID', message: 'value.questionId meshes is not the act set constraints/rig-constraints-01' });
    // The pre-#1004 encoding (singular fields on set 0) for a set-3 answer also disagrees, so it refuses.
    const first = act.source.optionSets![0]!;
    expect(refused(copy => { Object.assign(copy.source, { selection: { ...copy.source.selection, questionId: first.questionId, setId: first.setId },
      optionSet: first.optionSet, optionSetFile: first.optionSetFile }); }))
      .toEqual({ code: 'JOB_ACT_INVALID', message: 'value.questionId constraints is not the act set bones/rig-bones-01' });
    expect(refused(copy => { (copy.source.selection as { setId: string }).setId = 'rig-nowhere-01'; }))
      .toEqual({ code: 'JOB_ACT_INVALID', message: 'act set constraints/rig-nowhere-01 is not published' });
    expect(refused(() => {})).toBeNull();
  } finally { await fixture.dispose(); }
});

test('#1230 option sets publish with no subject as pictures to look at; their images stay served', async () => {
  // Control: the historical one-subject-per-set list and the subjectless list serve the same question images.
  const images = async (subjects: 'declared' | 'none') => {
    const fixture = await setsFixture('review-1230-' + subjects + '-', root => createSyntheticOptionRecordWorkspace(root, { questionImages: true }),
      workspace => ({ ...workspace.context, subjects: subjects === 'none' ? [] : workspace.context.subjects }));
    try {
      const published = await fixture.publish();
      expect(published.ok).toBe(true);
      const publication = published.value as PublicationV3;
      expect((publication.source as { subjects: readonly RecordSubject[] }).subjects.length).toBe(subjects === 'none' ? 0 : 1);
      expect(fixture.session.status().pending).toEqual([]);
      const response = await retainedPublicationRoutes(fixture.session)(fixture.session.jobId, publication.publicationId,
        publication.instanceKey, 'api/interview', new Request('http://127.0.0.1/api/interview'));
      expect(response.status).toBe(200);
      const body = await response.json() as { questions: { set: { question: string }; images: { name: string; path?: string }[] }[] };
      return body.questions.map(question => [question.set.question, question.images.map(image => [image.name, image.path])]);
    } finally { await fixture.dispose(); }
  };
  const declared = await images('declared');
  expect(declared.flatMap(([, rows]) => rows as unknown[]).length).toBeGreaterThan(0);
  expect(await images('none')).toEqual(declared);
});

test('#1230 a subject list that is neither empty nor one per set still refuses', async () => {
  const partial = await setsFixture('review-1230-partial-', root => createSyntheticOptionSetsRecordWorkspace(root, { count: 2 }),
    workspace => ({ ...workspace.context, subjects: [workspace.context.subjects[0]!] }));
  try {
    expect(await partial.publish()).toMatchObject({ ok: false, error: { code: 'JOB_SOURCE_MISMATCH' } });
    expect(partial.session.status()).toMatchObject({ generation: 0, publication: null });
  } finally { await partial.dispose(); }
});
