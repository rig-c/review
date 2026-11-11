import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {
  JobInterviewDiagnostic,
  JobInterviewDiagnostics,
  JobInterviewRecord,
  JobPublication,
  JobSubject,
} from '../../src/job-contract.ts';
import {enCatalog} from '../../web/catalog-en.ts';
import {koCatalog} from '../../web/catalog-ko.ts';
import {digest, readProject} from '../../src/interview-project.ts';
import {jobInputHashes} from './job-api-fixture.ts';
import {scriptedJobWindowFixture} from './job-window-fixture.ts';
import type {InputCdpSession} from '../parts-explorer-browser.ts';

type Fixture = Awaited<ReturnType<typeof scriptedJobWindowFixture>>;
type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const sceneFixtureDir = fileURLToPath(new URL('../fixtures/scene-interview-551', import.meta.url));
const LEGACY_CUTOFF_MS = Date.parse('2026-11-08T00:00:00Z');

export const EXACT_STALE_ANSWER_WORDS = 'Historical stale answer\n한글 원문';
export const EXACT_COVERS_ONLY_WORDS = 'Covers-only pending answer\n대기 원문';
export const EXACT_SUBMITTED_NOTE_WORDS = '  legacy warning pick\n원문 유지';
export const STALE_ANSWER_AT = '2026-11-06T01:01:00.000Z';
export const STALE_DECISION_AT = '2026-11-06T01:02:00.000Z';
export const COVERS_ONLY_ANSWER_AT = new Date(LEGACY_CUTOFF_MS - 8_000).toISOString();

async function extractVerifiedArchive(name: 'writer-current' | 'writer-history'): Promise<string> {
  const provenance = JSON.parse(await readFile(join(sceneFixtureDir, 'provenance.json'), 'utf8')) as {
    archives: Record<string, string>;
  };
  const archiveName = `${name}.tar.gz`;
  const archivePath = join(sceneFixtureDir, archiveName);
  const archiveBytes = await readFile(archivePath);
  assert.equal(digest(archiveBytes), provenance.archives[archiveName], `verified ${archiveName} sha256`);
  const extractedRoot = await mkdtemp(join(tmpdir(), `review-scene-555-${name}-`));
  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', extractedRoot], {encoding: 'utf8'});
  if (extracted.status !== 0) {
    await rm(extractedRoot, {recursive: true, force: true});
    throw new Error(`Fixture extraction failed for ${archiveName}: ${extracted.stderr}`);
  }
  return extractedRoot;
}

/**
 * Closed synthetic seam over committed writer example archives (tests/fixtures/scene-interview-551).
 * IMPORTANT: Committed writer archive provenance does NOT make the altered project a real-user scene
 * or establish official Create writer acceptance. Every project/option mutation below is an explicit
 * SYNTHETIC CONTROL (`SYNTHETIC_CONTROL_OVER_WRITER_ARCHIVE`); `REAL_USER_SCENE_PENDING` remains open.
 */
export async function interviewDiagnosticsBrowserProbe(
  fixture: Fixture,
  output: string,
  language: 'en' | 'ko',
) {
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  const currentRoot = await extractVerifiedArchive('writer-current');
  const historyRoot = await extractVerifiedArchive('writer-history');
  try {
    // Copy committed writer-current scene project & evidence into the standing host root while keeping out/ package.
    for (const entry of ['project.json', 'evidence', 'inputs', 'derived']) {
      await cp(join(currentRoot, entry), join(fixture.input.root, entry), {recursive: true, force: true});
    }
    const historyProject = JSON.parse(await readFile(join(historyRoot, 'project.json'), 'utf8'));
    const historyPostItem = historyProject.interview.post.items.find((item: {id: string}) => item.id === 'post_composition');
    assert.ok(historyPostItem?.history?.length > 0, 'writer-history post_composition history exists');
    const baseHistoryAnswer = structuredClone(historyPostItem.history[0]);
    assert.equal(baseHistoryAnswer.choice?.spec, 'rig-create/interview-choice@1');

    const projectPath = join(fixture.input.root, 'project.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    const postItem = project.interview.post.items.find((item: {id: string}) => item.id === 'post_composition');
    assert.ok(postItem?.pending_options, 'writer-current post_composition pending_options exists');

    const activeRef = postItem.pending_options as {path: string; sha256: string};
    const activeSetPath = join(fixture.input.root, activeRef.path);
    const activeSet = JSON.parse(await readFile(activeSetPath, 'utf8'));

    // 1. SYNTHETIC CONTROL: pre-cutoff legacy currentness warning on the active editable scene option set:
    project.reopens[0].at = new Date(LEGACY_CUTOFF_MS - 10_000).toISOString();
    const rigV3At = new Date(LEGACY_CUTOFF_MS - 5_000).toISOString();
    const rigV3 = structuredClone(project.versions[0]);
    rigV3.n = 3;
    rigV3.at = rigV3At;
    rigV3.verdicts = [{review: 'rig-review', by: 'synthetic-control', at: new Date(LEGACY_CUTOFF_MS - 4_999).toISOString(), verdict: 'accepted'}];
    project.versions.push(rigV3);
    const rigV3Signoff = structuredClone(project.signoffs.find((s: {stage: string}) => s.stage === 'rig-review'));
    rigV3Signoff.at = new Date(LEGACY_CUTOFF_MS - 4_998).toISOString();
    rigV3Signoff.target = {
      ...rigV3Signoff.target,
      version: 3,
      verdict: `versions[${project.versions.length - 1}].verdicts[0]`,
      review_package: {...rigV3Signoff.target.review_package, path: `versions[${project.versions.length - 1}].review_package`},
    };
    project.signoffs.push(rigV3Signoff);

    activeSet.drafted_at = new Date(LEGACY_CUTOFF_MS - 1).toISOString();
    const activeSetText = JSON.stringify(activeSet, null, 2) + '\n';
    await writeFile(activeSetPath, activeSetText);
    postItem.pending_options = {path: activeRef.path, sha256: digest(Buffer.from(activeSetText))};

    // 2. SYNTHETIC CONTROL: retained historical stale set + completed delegated decision (own timestamp) + covers-only decision:
    const staleSetRelPath = 'evidence/interview/review551-scene-history-stale.json';
    const staleSet = structuredClone(activeSet);
    staleSet.id = 'review551-scene-history-stale';
    // Drafted before scenes[0].at (2026-11-06T01:00:57Z) so historical evaluation after 01:00:57Z is INTERVIEW_OPTIONS_STALE:
    staleSet.drafted_at = '2026-11-06T01:00:50.000Z';
    const staleSetText = JSON.stringify(staleSet, null, 2) + '\n';
    await writeFile(join(fixture.input.root, staleSetRelPath), staleSetText);
    const staleSetRef = {path: staleSetRelPath, sha256: digest(Buffer.from(staleSetText))};

    const cleanHistorySetRelPath = 'evidence/interview/review551-scene-history-clean.json';
    const cleanHistorySet = structuredClone(activeSet);
    cleanHistorySet.id = 'review551-scene-history-clean';
    // Drafted after reopens[0].at (-10_000ms) and before rigV3 (-5_000ms) so answer at -8_000ms is current and clean:
    cleanHistorySet.drafted_at = new Date(LEGACY_CUTOFF_MS - 9_000).toISOString();
    const cleanHistorySetText = JSON.stringify(cleanHistorySet, null, 2) + '\n';
    await writeFile(join(fixture.input.root, cleanHistorySetRelPath), cleanHistorySetText);
    const cleanHistorySetRef = {path: cleanHistorySetRelPath, sha256: digest(Buffer.from(cleanHistorySetText))};

    const askId = activeSet.asks[0].id as string;
    const staleHistoricalAnswer = {
      ...baseHistoryAnswer,
      at: STALE_ANSWER_AT,
      verbatim: EXACT_STALE_ANSWER_WORDS,
      delegated: true,
      choice: {
        ...baseHistoryAnswer.choice,
        set: staleSetRef,
        picks: [{ask: askId, option_id: 'auto', shown: {label: 'Auto', effect: 'Delegate'}}],
      },
      agent_decision: {
        by: 'agent',
        at: STALE_DECISION_AT,
        reasoning: 'Completed decision evaluated at its own timestamp',
        covers: askId,
        fragments: [{ask: askId, fragment: {framing: 'whole synthetic plate'}}],
        value: {framing: 'whole synthetic plate'},
      },
    };
    const coversOnlyHistoricalAnswer = {
      ...baseHistoryAnswer,
      at: COVERS_ONLY_ANSWER_AT,
      verbatim: EXACT_COVERS_ONLY_WORDS,
      delegated: true,
      choice: {
        ...baseHistoryAnswer.choice,
        set: cleanHistorySetRef,
        picks: [{ask: askId, option_id: 'auto', shown: {label: 'Auto', effect: 'Delegate'}}],
      },
      agent_decision: {
        covers: askId,
      },
    };
    postItem.history = [staleHistoricalAnswer, coversOnlyHistoricalAnswer];
    await writeFile(projectPath, JSON.stringify(project, null, 2) + '\n');
  } finally {
    await rm(currentRoot, {recursive: true, force: true});
    await rm(historyRoot, {recursive: true, force: true});
  }

  const inspected = readProject(fixture.input.root);
  const editableSceneQuestion = inspected.questions.find(q => q.set.id === 'review551-scene-current' && q.editable);
  assert.ok(editableSceneQuestion, 'active scene question remains editable with legacy warning');

  // Replace the old rigging-only context subjects captured at scriptedJobWindowFixture creation
  // with the current post_composition reader subjects from the replaced project:
  const currentSubjects: readonly JobSubject[] = [
    ...inspected.questions
      .filter(q => q.editable)
      .map(q => ({
        kind: 'interview-picks' as const,
        questionId: q.set.question,
        setId: q.set.id,
      })),
    {kind: 'signoff', stage: 'post-interview'},
  ];
  fixture.input.setContext({
    ...fixture.input.getContext(),
    plan: null,
    subjects: currentSubjects,
  });

  return {
    editableSceneQuestion,
    currentSubjects,
  };
}

/**
 * Cheap non-browser setup/publish/ask/UI-act dry check through the exact same
 * scriptedJobWindowFixture + interviewDiagnosticsBrowserProbe helper before browser spend.
 */
export async function verifyInterviewDiagnosticsFixtureDryRun(): Promise<void> {
  const fixture = await scriptedJobWindowFixture();
  const tempOut = await mkdtemp(join(tmpdir(), 'review-interview-dry-'));
  try {
    const probe = await interviewDiagnosticsBrowserProbe(fixture, tempOut, 'en');
    const publication = await fixture.publish('rig', 'scene-interview-555');
    const retained = fixture.host.session.retainedSource(publication.publicationId);
    assert.deepEqual(retained.subjects, probe.currentSubjects);
    assert.equal(
      retained.subjects.some(s => s.kind === 'interview-picks' && s.questionId === 'shape'),
      false,
      'old rigging-only question subjects are not carried after project replacement',
    );
    assert.ok(publication.interview);
    assert.deepEqual(
      publication.interview.diagnostics,
      [
        {
          record: 'interview.post.items[2].pending_options',
          at: publication.interview.evaluatedAt,
          code: 'INTERVIEW_OPTIONS_SCENE_LEGACY',
          severity: 'warning',
        },
        {
          record: 'interview.post.items[2].history[0]',
          at: STALE_ANSWER_AT,
          code: 'INTERVIEW_OPTIONS_STALE',
          severity: 'error',
        },
        {
          record: 'interview.post.items[2].history[0].agent_decision',
          at: STALE_DECISION_AT,
          code: 'INTERVIEW_OPTIONS_STALE',
          severity: 'error',
        },
      ],
    );

    const pending = await fixture.ask(publication, {
      kind: 'interview-picks',
      questionId: probe.editableSceneQuestion.set.question,
      setId: probe.editableSceneQuestion.set.id,
    });
    assert.equal(pending.subject.kind, 'interview-picks');
    assert.equal(pending.source.optionSet?.id, 'review551-scene-current');

    const ackRes = await fixture.ui('displayed', {
      publicationId: publication.publicationId,
      pageId: 'dry-run-page',
      sourceHash: publication.source.sourceHash,
    });
    const ackBody = (await ackRes.json()) as {ok: boolean; value: {displayedNonce: string}};
    assert.equal(ackBody.ok, true);

    const askItem = probe.editableSceneQuestion.set.asks[0]!;
    const recommended = askItem.options.find(opt => opt.kind === 'value' && opt.recommended) ?? askItem.options[0]!;
    const actRes = await fixture.ui('acts', {
      publicationId: publication.publicationId,
      askId: pending.askId,
      pageId: 'dry-run-page',
      displayedNonce: ackBody.value.displayedNonce,
      expectedGeneration: fixture.host.session.status().generation,
      submissionId: 'dry-run-submit-1',
      kind: 'interview-picks',
      value: {
        questionId: 'post_composition',
        selections: [{itemId: askItem.id, optionId: recommended.id, otherText: null}],
        note: EXACT_SUBMITTED_NOTE_WORDS,
      },
    });
    const actBody = (await actRes.json()) as {ok: boolean; value: {kind: string; value: {questionId: string; note: string}}};
    assert.equal(actBody.ok, true);
    assert.equal(actBody.value.kind, 'interview-picks');
    assert.equal(actBody.value.value.questionId, 'post_composition');
    assert.equal(actBody.value.value.note, EXACT_SUBMITTED_NOTE_WORDS);

    await fixture.finish();
  } finally {
    await fixture.close();
    await rm(tempOut, {recursive: true, force: true});
  }
}
