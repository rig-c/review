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
    async run(
      page: InputCdpSession,
      helpers: {
        wait(expression: string, what: string): Promise<void>;
        show(publication: JobPublication): Promise<void>;
        edit(selector: string, value: string): Promise<void>;
        submit(askId: string): Promise<void>;
        checkpoints(name: string, value: unknown): Promise<void>;
        send: Send;
      },
    ) {
      const {wait, show, edit, submit, checkpoints, send} = helpers;
      const publication = await fixture.publish('rig', 'scene-interview-555');
      await show(publication);

      const retained = fixture.host.session.retainedSource(publication.publicationId);
      assert.deepEqual(retained.subjects, currentSubjects, 'published retained source uses current post_composition reader subjects');
      assert.ok(publication.interview, 'published standing-window event carries interview diagnostics envelope');
      assert.equal(publication.interview.schema, 'rig-review/job-interview@1');

      const pending = await fixture.ask(publication, {
        kind: 'interview-picks',
        questionId: editableSceneQuestion.set.question,
        setId: editableSceneQuestion.set.id,
      });
      const formSelector = `form[data-job-ask=${JSON.stringify(pending.askId)}]`;
      await wait(
        `!!document.querySelector(${JSON.stringify(formSelector)}) && !!document.querySelector('[data-job-interview-diagnostics]')`,
        'standing interview ask form and diagnostics section rendered',
      );

      const domDiagnostics = await page.evaluate<{
        diagnosticsHidden: boolean;
        interactiveCountInsideDiagnostics: number;
        diagnosticBadges: {
          codeAttr: string | null;
          severityAttr: string | null;
          recordAttr: string | null;
          summaryText: string;
          parsedPre: JobInterviewDiagnostic;
        }[];
        recordRows: {
          recordAttr: string | null;
          timeKindAttr: string | null;
          parsedPre: JobInterviewRecord;
        }[];
        activeFormWarningAttr: string | null;
        activeFormWarningText: string | null;
        fieldsetDisabledBeforeSubmit: boolean;
      }>(`(() => {
        const section = document.querySelector('[data-job-interview-diagnostics]');
        const form = document.querySelector(${JSON.stringify(formSelector)});
        const warningEl = form?.querySelector('[data-job-interview-warning]');
        return {
          diagnosticsHidden: !section || section.hidden,
          interactiveCountInsideDiagnostics: section ? section.querySelectorAll('input,select,textarea,button,form').length : -1,
          diagnosticBadges: section ? [...section.querySelectorAll('[data-job-interview-diagnostic]')].map(el => ({
            codeAttr: el.getAttribute('data-job-interview-diagnostic'),
            severityAttr: el.getAttribute('data-severity'),
            recordAttr: el.getAttribute('data-record'),
            summaryText: el.querySelector('p')?.textContent ?? '',
            parsedPre: JSON.parse(el.querySelector('pre')?.textContent ?? 'null'),
          })) : [],
          recordRows: section ? [...section.querySelectorAll('[data-job-interview-record]')].map(el => ({
            recordAttr: el.getAttribute('data-job-interview-record'),
            timeKindAttr: el.getAttribute('data-time-kind'),
            parsedPre: JSON.parse(el.querySelector('pre')?.textContent ?? 'null'),
          })) : [],
          activeFormWarningAttr: warningEl?.getAttribute('data-job-interview-warning') ?? null,
          activeFormWarningText: warningEl?.textContent ?? null,
          fieldsetDisabledBeforeSubmit: !!form?.querySelector('fieldset')?.disabled,
        };
      })()`);

      assert.equal(domDiagnostics.diagnosticsHidden, false);
      assert.equal(domDiagnostics.interactiveCountInsideDiagnostics, 0, 'historical/diagnostic rows must be strictly read-only');
      assert.equal(domDiagnostics.activeFormWarningAttr, 'INTERVIEW_OPTIONS_SCENE_LEGACY');
      assert.equal(domDiagnostics.activeFormWarningText, catalog.INTERVIEW_OPTIONS_SCENE_LEGACY);
      assert.equal(domDiagnostics.fieldsetDisabledBeforeSubmit, false, 'legacy warning must not block active editable choice');

      const legacyDiag = domDiagnostics.diagnosticBadges.find(
        d => d.recordAttr === 'interview.post.items[2].pending_options',
      );
      assert.ok(legacyDiag, 'renders INTERVIEW_OPTIONS_SCENE_LEGACY warning badge');
      assert.equal(legacyDiag.codeAttr, 'INTERVIEW_OPTIONS_SCENE_LEGACY');
      assert.equal(legacyDiag.severityAttr, 'warning');
      assert.equal(legacyDiag.summaryText, catalog.INTERVIEW_OPTIONS_SCENE_LEGACY);
      assert.deepEqual(legacyDiag.parsedPre, {
        record: 'interview.post.items[2].pending_options',
        at: publication.interview.evaluatedAt,
        code: 'INTERVIEW_OPTIONS_SCENE_LEGACY',
        severity: 'warning',
      });

      const staleAnswerDiag = domDiagnostics.diagnosticBadges.find(
        d => d.recordAttr === 'interview.post.items[2].history[0]',
      );
      assert.ok(staleAnswerDiag, 'renders historical answer INTERVIEW_OPTIONS_STALE error badge');
      assert.equal(staleAnswerDiag.codeAttr, 'INTERVIEW_OPTIONS_STALE');
      assert.equal(staleAnswerDiag.severityAttr, 'error');
      assert.equal(staleAnswerDiag.summaryText, catalog.INTERVIEW_OPTIONS_STALE);
      assert.deepEqual(staleAnswerDiag.parsedPre, {
        record: 'interview.post.items[2].history[0]',
        at: STALE_ANSWER_AT,
        code: 'INTERVIEW_OPTIONS_STALE',
        severity: 'error',
      });

      const staleDecisionDiag = domDiagnostics.diagnosticBadges.find(
        d => d.recordAttr === 'interview.post.items[2].history[0].agent_decision',
      );
      assert.ok(staleDecisionDiag, 'renders completed agent_decision INTERVIEW_OPTIONS_STALE error badge at its own decision timestamp');
      assert.equal(staleDecisionDiag.codeAttr, 'INTERVIEW_OPTIONS_STALE');
      assert.equal(staleDecisionDiag.severityAttr, 'error');
      assert.equal(staleDecisionDiag.summaryText, catalog.INTERVIEW_OPTIONS_STALE);
      assert.deepEqual(staleDecisionDiag.parsedPre, {
        record: 'interview.post.items[2].history[0].agent_decision',
        at: STALE_DECISION_AT,
        code: 'INTERVIEW_OPTIONS_STALE',
        severity: 'error',
      });

      assert.equal(
        domDiagnostics.diagnosticBadges.some(d => d.recordAttr === 'interview.post.items[2].history[1].agent_decision'),
        false,
        'covers-only pending decision has no diagnostic badge',
      );

      const histAnswerRow = domDiagnostics.recordRows.find(r => r.recordAttr === 'interview.post.items[2].history[0]');
      assert.ok(histAnswerRow);
      assert.equal(histAnswerRow.timeKindAttr, 'answer');
      assert.equal(histAnswerRow.parsedPre.questionId, 'post_composition');
      assert.equal(histAnswerRow.parsedPre.record, 'interview.post.items[2].history[0]');
      assert.equal(histAnswerRow.parsedPre.timeKind, 'answer');
      assert.equal(histAnswerRow.parsedPre.at, STALE_ANSWER_AT);
      assert.equal(histAnswerRow.parsedPre.original?.verbatim, EXACT_STALE_ANSWER_WORDS);

      const completedDecisionRow = domDiagnostics.recordRows.find(
        r => r.recordAttr === 'interview.post.items[2].history[0].agent_decision',
      );
      assert.ok(completedDecisionRow);
      assert.equal(completedDecisionRow.timeKindAttr, 'decision');
      assert.equal(completedDecisionRow.parsedPre.questionId, 'post_composition');
      assert.equal(completedDecisionRow.parsedPre.record, 'interview.post.items[2].history[0].agent_decision');
      assert.equal(completedDecisionRow.parsedPre.timeKind, 'decision');
      assert.equal(completedDecisionRow.parsedPre.at, STALE_DECISION_AT);
      assert.equal(completedDecisionRow.parsedPre.original?.at, STALE_DECISION_AT);
      assert.equal(completedDecisionRow.parsedPre.original?.reasoning, 'Completed decision evaluated at its own timestamp');

      const coversOnlyAnswerRow = domDiagnostics.recordRows.find(
        r => r.recordAttr === 'interview.post.items[2].history[1]',
      );
      assert.ok(coversOnlyAnswerRow);
      assert.equal(coversOnlyAnswerRow.timeKindAttr, 'answer');
      assert.equal(coversOnlyAnswerRow.parsedPre.at, COVERS_ONLY_ANSWER_AT);
      assert.equal(coversOnlyAnswerRow.parsedPre.original?.verbatim, EXACT_COVERS_ONLY_WORDS);

      const coversOnlyDecisionRow = domDiagnostics.recordRows.find(
        r => r.recordAttr === 'interview.post.items[2].history[1].agent_decision',
      );
      assert.ok(coversOnlyDecisionRow);
      assert.equal(coversOnlyDecisionRow.timeKindAttr, 'decision');
      assert.equal(coversOnlyDecisionRow.parsedPre.questionId, 'post_composition');
      assert.equal(coversOnlyDecisionRow.parsedPre.record, 'interview.post.items[2].history[1].agent_decision');
      assert.equal(coversOnlyDecisionRow.parsedPre.timeKind, 'decision');
      assert.equal(coversOnlyDecisionRow.parsedPre.at, null);
      assert.deepEqual(coversOnlyDecisionRow.parsedPre.original, {covers: 'post_composition'});

      const shot = (await send('Page.captureScreenshot', {format: 'png'})) as {data: string};
      await writeFile(join(output, 'interview-diagnostics.png'), Buffer.from(shot.data, 'base64'));

      // Verify the active choice with INTERVIEW_OPTIONS_SCENE_LEGACY warning remains interactive and submits cleanly:
      for (const item of editableSceneQuestion.set.asks) {
        const option = item.options.find(opt => opt.kind === 'value' && opt.recommended) ?? item.options[0]!;
        await page.evaluate(`document.querySelector(${JSON.stringify(formSelector + ' input[name="choice.' + item.id + '"][value="' + option.id + '"]')}).click()`);
      }
      await edit(`${formSelector} textarea[name=note]`, EXACT_SUBMITTED_NOTE_WORDS);
      const immutableBeforeSubmit = await jobInputHashes(fixture.input.root);
      await submit(pending.askId);
      assert.deepEqual(await jobInputHashes(fixture.input.root), immutableBeforeSubmit);

      const events = await fixture.next();
      const picksEvent = events.events.find(e => e.type === 'act' && e.act.askId === pending.askId);
      assert.ok(picksEvent?.type === 'act' && picksEvent.act.kind === 'interview-picks');
      assert.equal(picksEvent.act.value.questionId, 'post_composition');
      assert.equal(picksEvent.act.value.note, EXACT_SUBMITTED_NOTE_WORDS);

      await checkpoints('interview-diagnostics-verified', {
        language,
        provenanceClassification: 'SYNTHETIC_CONTROL_OVER_WRITER_ARCHIVE',
        realUserSceneStatus: 'REAL_USER_SCENE_PENDING',
        publicationId: publication.publicationId,
        retainedSubjects: retained.subjects,
        interview: publication.interview as JobInterviewDiagnostics,
        domDiagnostics,
        submittedAct: picksEvent.act,
      });

      await fixture.finish();
      await wait(
        `document.querySelector('.job-notice').textContent.includes(${JSON.stringify(
          language === 'ko' ? '명시적으로 종료' : 'explicitly closed',
        )})`,
        'explicit close',
      );
      await checkpoints('complete', {
        language,
        mode: 'interview-diagnostics-only',
        provenanceClassification: 'SYNTHETIC_CONTROL_OVER_WRITER_ARCHIVE',
        baseArchives: 'tests/fixtures/scene-interview-551/{writer-current,writer-history}.tar.gz',
        realUserSceneStatus: 'REAL_USER_SCENE_PENDING',
        createWriterReadback: 'PENDING_CREATE_182_184',
        separateUID: 'PARENT_A_GATE',
      });
    },
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

/** Compare natural-resolution displayed pixels with the independently decoded normal-route PNG. */
export function assertScreenADisplayedPixels(png:{width:number;height:number;data:Uint8Array},
    displayed:{width:number;height:number;rgba:number[]}) {
    assert.equal(displayed.width,png.width,'displayed natural width matches source PNG');
    assert.equal(displayed.height,png.height,'displayed natural height matches source PNG');
    const expected=Buffer.from(png.data),actual=Buffer.from(displayed.rgba);
    assert.deepEqual(actual,expected,'displayed natural-resolution RGBA matches decoded normal-route PNG byte-for-byte');
    return {rgbaBytes:actual.length,decodedRgbaSha256:digest(expected),displayedRgbaSha256:digest(actual),matches:true};
}

/** Screen A uses the existing sealed fixtures, host, CDP and PNG oracle. No owner state is injected. */
export async function screenABrowser(output: string, language: 'en' | 'ko') {
    const { mkdir } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    const { startJobHost } = await import('../../src/job-front.ts');
    const { JOB_RECORD_READER_ID } = await import('../../src/job-contract.ts');
    const { createSyntheticOptionRecordWorkspace, createSyntheticRecordReader, writeWorkspaceFile, makeSyntheticPngBytes } = await import('./job-record-fixture.ts');
    const { launchCdpSession } = await import('../parts-explorer-browser.ts');
    const { inspectPartsViewportPng } = await import('./job-window-paint.ts');
    const { PNG } = await import('pngjs');
    const { jobPublicationRoutes } = await import('../../web/job-session.ts');
    await mkdir(output, { recursive: true });
    const scratch = await mkdtemp(join(tmpdir(), 'review605-browser-'));
    let control: Send | undefined;
    const browserErrors: unknown[] = [];
    const page = await launchCdpSession(join(scratch, 'profile'), { onEvent(event, send) {
            if (event.sessionId)
                control = send;
            if (event.method === 'Runtime.exceptionThrown')
                browserErrors.push(event.params);
        } });
    const observations: Record<string, unknown> = { provenance: 'SYNTHETIC_REVIEW_SCREEN_A, no Create consumer receipt' };
    const managedHosts: {
        mode: string;
        host: any;
        schema: string;
        root: string;
        beforeInputs?: Record<string, string>;
        inputReadbackDone?: boolean;
        stop: () => Promise<void>;
    }[] = [];
    const semanticClosures: unknown[] = [];
    const inputReadbacks: unknown[] = [];
    const cleanupErrors: string[] = [];
    let failure: unknown;
    function recordCleanupError(stage: string, error: unknown) {
        cleanupErrors.push(stage + ': ' + String(error));
        if (failure === undefined)
            failure = error;
    }
    async function wait(expression: string) {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            if (await page.evaluate(expression))
                return;
            await Bun.sleep(25);
        }
        throw new Error('SCREEN_A_WAIT ' + expression);
    }
    async function call(host: any, schema: string, body: object) {
        const response = await fetch(host.origin + '/jobs/' + host.session.jobId + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + host.session.hostCredentials().agent }, body: JSON.stringify({ schema, jobId: host.session.jobId, requestId: randomUUID(), ...body }) });
        const result = await response.json();
        assert.equal(result.ok, true, JSON.stringify(result));
        return result.value;
    }
    async function readbackInputs(entry: typeof managedHosts[number]) {
        if (entry.inputReadbackDone)
            return;
        if (!entry.beforeInputs) {
            inputReadbacks.push({ mode: entry.mode, status: 'unavailable', reason: 'Source baseline was not captured before failure' });
            entry.inputReadbackDone = true;
            return;
        }
        const after = await jobInputHashes(entry.root);
        const matches = Object.keys(after).length === Object.keys(entry.beforeInputs).length &&
            Object.entries(entry.beforeInputs).every(([path,sha256])=>after[path]===sha256);
        inputReadbacks.push({ mode: entry.mode, status: 'read', before: entry.beforeInputs, after, matches });
        entry.inputReadbackDone = true;
        assert.deepEqual(after, entry.beforeInputs, 'fixture input bytes remain immutable before disposal');
    }
    async function closeManaged(entry: typeof managedHosts[number]) {
        const before = entry.host.session.status();
        let result: unknown;
        if (before.status !== 'closed') {
            result = await call(entry.host, entry.schema, { verb: 'close', expectedGeneration: before.generation,
                idempotencyKey: randomUUID(), reason: 'Synthetic Screen A browser cleanup' });
        }
        const after = entry.host.session.status();
        assert.equal(after.status, 'closed');
        assert.equal(after.pending.length, 0);
        semanticClosures.push({ mode: entry.mode, jobId: entry.host.session.jobId, result, status: after.status,
            generation: after.generation, pendingCount: after.pending.length });
    }
    try {
        for (const mode of ['record-images', 'record-unavailable', 'package'] as const) {
            let host: any, publication: any, question: any, schema: string, root: string, fetchCapability = '';
            if (mode === 'package') {
                const fixture = await scriptedJobWindowFixture();
                host = fixture.host;
                managedHosts.push({ mode, host, root: fixture.input.root, schema: 'rig-review/job-api@2', stop: () => fixture.close() });
                root = fixture.input.root;
                schema = 'rig-review/job-api@2';
                // Existing package fixture already has its retained editable question and reader.
                question = fixture.question;
                publication = await fixture.publish('rig', 'Synthetic Screen A package');
                fetchCapability = host.session.writerGrant().fetchCapability;
            }
            else {
                root = join(scratch, mode);
                await mkdir(root);
                const input = createSyntheticOptionRecordWorkspace(root, { stage: 'rigging-interview' });
                const set = JSON.parse(await readFile(join(root, input.optionSetFile.path), 'utf8'));
                const second = writeWorkspaceFile(root, 'inputs/second.png', makeSyntheticPngBytes(220, 80, 40));
                set.context.files = mode === 'record-images' ? [input.inputImage, second, input.inputSpec] : [input.inputSpec];
                const optionSetFile = writeWorkspaceFile(root, input.optionSetFile.path, JSON.stringify(set, null, 2) + '\n');
                const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
                project.interview.waypoints[0].pending_options = optionSetFile;
                const record = writeWorkspaceFile(root, 'project.json', JSON.stringify(project, null, 2) + '\n');
                const files = [...input.files.filter(file => file.path !== record.path && file.path !== optionSetFile.path), second, optionSetFile, record].sort((a, b) => a.path < b.path ? -1 : 1);
                const context = { ...input.context, files };
                const { reader } = createSyntheticRecordReader({ onOption: () => structuredClone(context) });
                host = await startJobHost({ root, stateDir: join(scratch, mode + '-state'), fingerprint: 'a'.repeat(64), reviewer: { id: 'synthetic-owner', role: 'owner' }, publicationMode: 'record-and-package', readRecordPublished: reader, recordReaderId: JOB_RECORD_READER_ID, bindingId: 'synthetic-screen-a/1', installWriterBinding: binding => { fetchCapability = binding.fetchCapability; } });
                managedHosts.push({ mode, host, root, schema: 'rig-review/job-api@3', stop: async () => host.stop() });
                schema = 'rig-review/job-api@3';
                question = { set, ref: optionSetFile };
                publication = await call(host, schema, { verb: 'publish', expectedGeneration: 0, idempotencyKey: randomUUID(), freeze: { kind: 'producer-held', holdId: 'synthetic', record }, result: input.result });
            }
            const managed = managedHosts[managedHosts.length - 1]!;
            const before = await jobInputHashes(root);
            managed.beforeInputs = before;
            const decodedImages = new Map<number, ReturnType<typeof PNG.sync.read>>();
            const routes = jobPublicationRoutes(host.session.displayPublication(publication.publicationId), host.origin);
            const interviewResponse = await fetch(routes.api('interview'));
            assert.equal(interviewResponse.ok, true);
            const interviewMetadata = await interviewResponse.json();
            const admitted = interviewMetadata.questions.find((item: any) => item.ref.sha256 === question.ref.sha256);
            const retained = host.session.retainedSourceV3(publication.publicationId).questions
                .find((item: any) => item.ref.sha256 === question.ref.sha256);
            assert.ok(admitted && retained, 'normal metadata maps to the retained question');
            assert.equal(admitted.images.length, retained.images.length);
            const imageMapping = await Promise.all(admitted.images.map(async (image: any, index: number) => {
                const source = retained.images[index];
                assert.equal(image.name, source.name);
                const normalUrl = routes.instance(image.url);
                const response = await fetch(normalUrl);
                assert.equal(response.ok, true);
                const raw = Buffer.from(await response.arrayBuffer());
                const sourceBytes = await readFile(join(root, source.ref.path));
                assert.equal(digest(sourceBytes), source.ref.sha256, 'immutable source image seal');
                assert.equal(digest(raw), source.ref.sha256, 'normal image route bytes match source seal');
                const png = PNG.sync.read(raw);
                decodedImages.set(index, png);
                return { index, name: image.name, normalUrl, source: source.ref, rawSha256: digest(raw),
                    decodedWidth: png.width, decodedHeight: png.height };
            }));
            const asked = await call(host, schema, { verb: 'ask', expectedGeneration: host.session.status().generation, idempotencyKey: randomUUID(), publicationId: publication.publicationId, subject: { kind: 'interview-picks', questionId: question.set.question, setId: question.set.id } });
            const owner = new URL(host.ownerUrl);
            owner.searchParams.set('lang', language);
            const selector = 'form[data-job-ask="' + asked.askId + '"]';
            const phases: any[] = [];
            observations[mode] = { sourceHash: publication.source.sourceHash, publicationId: publication.publicationId, askId: asked.askId, imageMapping, phases };
            for (const sample of [{ width: 1440, height: 900, phase: 'initial' }, { width: 1024, height: 768, phase: 'resize' }, { width: 1024, height: 768, phase: 'initial' }, { width: 1440, height: 900, phase: 'resize' }]) {
                await page.setViewport(sample.width, sample.height);
                if (sample.phase === 'initial')
                    await page.goto(owner.href);
                await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector + ' fieldset')}).disabled`);
                assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector + ' input[type=radio]:checked')}).length`), 0);
                const geometry = await page.evaluate<any>(`(()=>{const form=document.querySelector(${JSON.stringify(selector)}),workspace=document.querySelector('.job-inspection');const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {forms:rect(form.closest('[data-job-forms]')),workspace:rect(workspace),reason:[...form.querySelectorAll('.interview-option b')].map(n=>n.textContent),tabs:[...workspace.querySelectorAll('.interview-image-tabs button')].map(n=>n.textContent),radios:[...form.querySelectorAll('input[type=radio]')].map(n=>({name:n.name,value:n.value,checked:n.checked})),source:form.querySelector('.job-source').textContent};})()`);
                assert.ok(geometry.source.includes(publication.source.sourceHash));
                assert.ok(geometry.reason.length > 0);
                assert.deepEqual(geometry.tabs, imageMapping.map((image: any) => image.name));
                const phase: any = { ...sample, sourceHash: publication.source.sourceHash, geometry, images: [] };
                phases.push(phase);
                if (mode === 'record-unavailable') {
                    assert.equal(geometry.tabs.length, 0);
                    assert.equal(await page.evaluate(`document.querySelector('[data-job-interview-empty]').textContent`), (language === 'ko' ? koCatalog : enCatalog)['job.picks.noImages'].replace('{0}', 'inputs'));
                }
                for (let index = 0; index < geometry.tabs.length; index++) {
                    await page.evaluate(`document.querySelectorAll('.interview-image-tabs button')[${index}].click()`);
                    await wait(`document.querySelector('.interview-image-preview img')?.complete && document.querySelector('.interview-image-preview img').naturalWidth>0`);
                    const image = await page.evaluate<any>(`(()=>{const art=document.querySelector('.interview-images'),img=art.querySelector('img');art.scrollIntoView({block:'center'});const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {src:img.src,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,image:rect(img),preview:rect(img.parentElement),selected:art.querySelectorAll('button')[${index}].getAttribute('aria-pressed')};})()`);
                    const mapping = imageMapping[index];
                    const png = decodedImages.get(index);
                    assert.ok(mapping && png);
                    assert.equal(image.naturalWidth, png.width, 'natural width matches source PNG');
                    assert.equal(image.naturalHeight, png.height, 'natural height matches source PNG');
                    // The displayed IMG is read at natural resolution without fetching its object URL.
                    const displayed = await page.evaluate<{
                        width: number;
                        height: number;
                        rgba: number[];
                    }>(`(()=>{
                        const image=document.querySelector('.interview-image-preview img');
                        const canvas=document.createElement('canvas');
                        canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
                        const context=canvas.getContext('2d');
                        if(!context)throw new Error('SCREEN_A_CANVAS_READBACK_UNAVAILABLE');
                        context.drawImage(image,0,0);
                        return {width:canvas.width,height:canvas.height,
                            rgba:Array.from(context.getImageData(0,0,canvas.width,canvas.height).data)};
                    })()`);
                    const decodedDisplay = assertScreenADisplayedPixels(png, displayed);
                    const colors = new Map<string, number>();
                    for (let at = 0; at < png.data.length; at += 4) {
                        if (png.data[at + 3] !== 255)
                            continue;
                        const color = [...png.data.subarray(at, at + 4)].join(',');
                        colors.set(color, (colors.get(color) ?? 0) + 1);
                    }
                    const color = [...colors].sort((a, b) => b[1] - a[1])[0];
                    assert.ok(color, 'fixture has opaque context pixels');
                    const box: [
                        number,
                        number,
                        number,
                        number
                    ] = [Math.ceil(image.image.left), Math.ceil(image.image.top), Math.floor(image.image.right), Math.floor(image.image.bottom)];
                    const shot = await page.screenshot();
                    const pixels = inspectPartsViewportPng(shot, { viewport: sample, backgroundRgba: color[0].split(',').map(Number) as [
                            number,
                            number,
                            number,
                            number
                        ], leftROI: box, rightAdjacent: box });
                    assert.ok(pixels.inBounds && pixels.leftROI.backgroundPixels > 0);
                    assert.equal(image.selected, 'true');
                    assert.ok(image.image.left >= image.preview.left - 1 && image.image.right <= image.preview.right + 1 && image.image.top >= image.preview.top - 1 && image.image.bottom <= image.preview.bottom + 1);
                    phase.images.push({ ...image, mapping, normalRouteRawSha256: mapping.rawSha256, decodedDisplay, decodedWidth: png.width, decodedHeight: png.height,
                        matchedPixels: pixels.leftROI.backgroundPixels, matchedROI: pixels.leftROI, expectedRgba: color[0].split(',').map(Number) });
                    await writeFile(join(output, mode + '-' + sample.width + '-' + sample.phase + '-image' + index + '.png'), shot);
                }
                await writeFile(join(output, mode + '-' + sample.width + '-' + sample.phase + '-layout.png'), await page.screenshot());
            }
            // Real CDP keys exercise native radio grouping, Tab movement, and image shortcuts.
            assert.ok(control);
            const key = async (key: string, code: string, virtual: number) => {
                await control!('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual });
                await control!('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
            };
            await page.evaluate(`document.querySelector(${JSON.stringify(selector + ' input[type=radio]')}).focus()`);
            await key('ArrowDown', 'ArrowDown', 40);
            assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(selector + ' input[type=radio]:checked')}).length`), 1);
            const focusBefore = await page.evaluate<any>(`(()=>{
                const form=document.querySelector(${JSON.stringify(selector)});
                const describe=node=>node?{tag:node.tagName,name:node.name||'',type:node.type||'',value:node.value||''}:null;
                const controls=[...form.querySelectorAll('input,select,textarea,button,[tabindex]')]
                    .filter(node=>node.tabIndex>=0&&!node.matches(':disabled')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden');
                const stops=controls.filter(node=>{
                    if(node.type!=='radio')return true;
                    const group=controls.filter(item=>item.type==='radio'&&item.name===node.name);
                    return node===(group.find(item=>item.checked)||group[0]);
                });
                const selected=form.querySelector('input[type=radio]:checked');
                const index=stops.indexOf(selected);
                if(index<0||document.activeElement!==selected||!stops[index+1])throw new Error('SCREEN_A_FOCUS_BEFORE_INVALID');
                return {before:describe(selected),expected:describe(stops[index+1]),tabStops:stops.map(describe)};
            })()`);
            await key('Tab', 'Tab', 9);
            const focusAfter = await page.evaluate<any>(`(()=>{const node=document.activeElement;
                return {tag:node.tagName,name:node.name||'',type:node.type||'',value:node.value||''};})()`);
            Object.assign(observations[mode] as object, { focusProgression: { ...focusBefore, after: focusAfter } });
            assert.notDeepEqual(focusAfter, focusBefore.before, 'Tab leaves the selected radio');
            assert.deepEqual(focusAfter, focusBefore.expected, 'Tab reaches the next native focusable control');
            if (mode === 'record-images') {
                await page.evaluate(`document.querySelector('.interview-images').focus()`);
                await key('1', 'Digit1', 49);
                assert.equal(await page.evaluate(`document.querySelector('.interview-image-tabs button').getAttribute('aria-pressed')`), 'true');
                await page.evaluate(`document.querySelector(${JSON.stringify(selector + ' textarea[name=note]')}).focus()`);
                await key('2', 'Digit2', 50);
                assert.equal(await page.evaluate(`document.querySelector('.interview-image-tabs button').getAttribute('aria-pressed')`), 'true');
            }
            const exactNote = '  owner <literal> 한글\nEND ', exactOther = '  Other 한글\n ';
            const first = question.set.asks[0];
            const expected = { questionId: question.set.question, selections: question.set.asks.map((ask: any, index: number) => { const option = ask.options.find((item: any) => index === 0 ? item.kind === 'other' : item.kind === 'auto'); assert.ok(option); return { itemId: ask.id, optionId: option.id, otherText: index === 0 ? exactOther : null }; }), note: exactNote };
            await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});for(const pick of ${JSON.stringify(expected.selections)}){[...f.querySelectorAll('input[type=radio]')].find(n=>n.name==='choice.'+pick.itemId&&n.value===pick.optionId).click();}f.querySelector(${JSON.stringify('textarea[name="other.' + first.id + '"]')}).value=${JSON.stringify(exactOther)};f.querySelector('textarea[name=note]').value=${JSON.stringify(exactNote)};f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
            const alternate = language === 'en' ? 'ko' : 'en';
            await page.evaluate(`(()=>{const language=document.querySelector('.job-header select');language.value=${JSON.stringify(alternate)};language.dispatchEvent(new Event('change',{bubbles:true}));})()`);
            assert.equal(await page.evaluate(`document.querySelector('.interview-option b').textContent`), (alternate === 'ko' ? koCatalog : enCatalog)['interview.recommended']);
            assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector + ' textarea[name=note]')}).value`), exactNote);
            await page.goto('about:blank');
            await page.goto(owner.href);
            await wait(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector + ' fieldset')}).disabled`);
            assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(selector + ' textarea[name=note]')}).value`), exactNote);
            await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);
            let act: any;
            for (let tick = 0; tick < 200; tick++) {
                const next = await call(host, schema, { verb: 'next', after: null, waitMs: 0 });
                act = next.events.find((event: any) => event.type === 'act' && event.act.askId === asked.askId)?.act;
                if (act)
                    break;
                await Bun.sleep(25);
            }
            assert.ok(act);
            const fetchedResponse = await fetch(host.origin + '/jobs/' + host.session.jobId + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fetchCapability }, body: JSON.stringify({ schema, jobId: host.session.jobId, requestId: randomUUID(), verb: 'fetch-act', actId: act.actId }) });
            const fetched = await fetchedResponse.json();
            assert.equal(fetched.ok, true);
            assert.deepEqual(fetched.value.value, expected);
            await readbackInputs(managed);
            Object.assign(observations[mode] as object, { actId: act.actId, expected, sourceFiles: before });
            await closeManaged(managedHosts[managedHosts.length - 1]!);
        }
        observations.browserErrors = browserErrors;
        assert.deepEqual(browserErrors, []);
    }
    catch (error) {
        failure = error;
        observations.failure = String(error);
        try {
            await writeFile(join(output, 'failure.png'), await page.screenshot());
        }
        catch (captureError) {
            recordCleanupError('failure screenshot', captureError);
        }
    }
    finally {
        for (const entry of managedHosts) {
            try {
                await readbackInputs(entry);
            }
            catch (error) {
                recordCleanupError('input readback ' + entry.mode, error);
            }
            if (semanticClosures.some((item: any) => item.jobId === entry.host.session.jobId))
                continue;
            try {
                await closeManaged(entry);
            }
            catch (error) {
                recordCleanupError('semantic close ' + entry.mode, error);
            }
        }
        try {
            await page.close();
        }
        catch (error) {
            recordCleanupError('browser close', error);
        }
        for (const entry of [...managedHosts].reverse()) {
            try {
                await entry.stop();
            }
            catch (error) {
                recordCleanupError('host stop ' + entry.mode, error);
            }
        }
        try {
            await rm(scratch, { recursive: true, force: true });
        }
        catch (error) {
            recordCleanupError('scratch removal', error);
        }
    }
    observations.inputReadbacks = inputReadbacks;
    observations.semanticClosures = semanticClosures;
    observations.cleanupErrors = cleanupErrors;
    if (failure !== undefined)
        observations.failure = String(failure);
    try {
        await writeFile(join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    }
    catch (error) {
        recordCleanupError('observations write', error);
        console.error('SCREEN_A_EVIDENCE_WRITE_FAILED', String(error));
    }
    if (failure !== undefined)
        throw failure;
}
if (import.meta.main) {
    const value = (key: string) => { const at = Bun.argv.indexOf(key); return at < 0 ? undefined : Bun.argv[at + 1]; };
    const language = value('--lang') ?? 'en';
    assert.ok(language === 'en' || language === 'ko');
    await screenABrowser(value('--out') ?? 'evidence/review605-' + language, language);
}
