import { randomUUID } from 'node:crypto';
import {
  JOB_ACT_SCHEMA, JOB_PLAN_BOUND_SIGNOFF_STAGES, JOB_RESERVED_ACT_KINDS,
  type JobAct, type JobActValues, type JobPendingAsk, type JobReviewerBinding,
  type JobSourceBinding, type JobSubject, type JobUISubmission,
} from './job-contract.ts';
import { jobId, jobInteger, jobObject, requestDigest } from './job-api.ts';
import { validatePicks } from './interview-picks.ts';
import type { JobRetainedSource } from './job-source.ts';
import { JobError } from './job-store.ts';

function words(value: unknown): string {
  if (typeof value !== 'string' || value.length > 10_000) throw new JobError('JOB_ACT_INVALID');
  return value;
}

function choice<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (!allowed.includes(value as Value)) throw new JobError('JOB_ACT_INVALID');
  return value as Value;
}

function requirePlan(source: JobSourceBinding): void {
  if (!source.plan?.steps.length) throw new JobError('JOB_ASK_INVALID', 'Published plan step identities are required');
}

export function bindJobAsk(subject: JobSubject, retained: JobRetainedSource): JobSourceBinding {
  const source = structuredClone(retained.source);
  const declared = retained.subjects.some(candidate => requestDigest(candidate) === requestDigest(subject));
  switch (subject.kind) {
    case 'interview-picks': {
      const question = retained.questions.find(item => item.editable && item.set.question === subject.questionId && item.set.id === subject.setId);
      if (!question) throw new JobError('JOB_ASK_INVALID');
      return { ...source, optionSet: { id: question.set.id, sha256: question.ref.sha256 } };
    }
    case 'checkpoint': {
      requirePlan(source);
      const stepId = subject.planStepId ?? subject.checkpointId;
      if (!declared || !source.plan!.steps.some(step => step.id === stepId)) throw new JobError('JOB_ASK_INVALID');
      return source;
    }
    case 'parts-verdict':
      if (!declared || !source.projectHash || !source.parts || source.selector?.kind !== 'draft' ||
          source.selector.id !== subject.draftId || !retained.partIds.length) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'review-verdict':
      if (!source.model || (subject.stage === 'rig-review' ? source.selector?.kind !== 'rig' :
        source.selector?.kind !== 'post' || !source.direction)) throw new JobError('JOB_ASK_INVALID');
      return source;
    case 'signoff':
      if (!declared) throw new JobError('JOB_ASK_INVALID');
      if ((JOB_PLAN_BOUND_SIGNOFF_STAGES as readonly string[]).includes(subject.stage)) requirePlan(source);
      return source;
  }
}

export function parseUISubmission(value: unknown): JobUISubmission {
  const item = jobObject(value, ['publicationId', 'askId', 'pageId', 'displayedNonce', 'expectedGeneration', 'submissionId', 'kind', 'value']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ACT_KIND_DISABLED');
  jobId(item.publicationId); jobId(item.askId); jobId(item.pageId); jobId(item.displayedNonce); jobId(item.submissionId);
  jobInteger(item.expectedGeneration);
  if (!['interview-picks', 'checkpoint', 'parts-verdict', 'review-verdict', 'signoff'].includes(String(item.kind))) {
    throw new JobError('JOB_ACT_INVALID');
  }
  return item as unknown as JobUISubmission;
}

/** Only the authenticated UI host invokes this adapter. All source and authority
 * fields are daemon-owned. Empty/whitespace strings remain exact human words.
 */
export function finalizeJobAct(options: {
  readonly jobId: string;
  readonly submission: JobUISubmission;
  readonly ask: JobPendingAsk;
  readonly retained: JobRetainedSource;
  readonly reviewer: JobReviewerBinding;
}): JobAct {
  const { submission, ask, retained, reviewer } = options;
  if (ask.status !== 'pending') throw new JobError('JOB_ASK_SUPERSEDED');
  if (submission.kind !== ask.subject.kind || submission.publicationId !== ask.publicationId) throw new JobError('JOB_ACT_SOURCE_STALE');
  const source = bindJobAsk(ask.subject, retained);
  if (requestDigest(source) !== requestDigest(ask.source)) throw new JobError('JOB_ACT_SOURCE_STALE');
  if (!reviewer.id || !['owner', 'delegate'].includes(reviewer.role)) throw new JobError('JOB_AUTHORITY_REFUSED');
  const at = new Date().toISOString();
  const envelope = {
    schema: JOB_ACT_SCHEMA, actId: randomUUID(), jobId: options.jobId, askId: ask.askId,
    publicationId: ask.publicationId,
    authority: { actor: 'human' as const, channel: 'review-ui' as const, reviewer: structuredClone(reviewer) },
    at,
  };
  switch (submission.kind) {
    case 'interview-picks': {
      const value = jobObject(submission.value, ['questionId', 'selections', 'note']);
      const subject = ask.subject;
      if (subject.kind !== 'interview-picks' || value.questionId !== subject.questionId || !Array.isArray(value.selections)) {
        throw new JobError('JOB_ACT_INVALID');
      }
      const question = retained.questions.find(item => item.editable && item.set.id === subject.setId && item.set.question === subject.questionId)!;
      const selections = value.selections.map(raw => {
        const item = jobObject(raw, ['itemId', 'optionId', 'otherText']);
        if (item.otherText !== null && typeof item.otherText !== 'string') throw new JobError('JOB_ACT_INVALID');
        return { itemId: jobId(item.itemId), optionId: jobId(item.optionId), otherText: item.otherText as string | null };
      });
      const note = words(value.note);
      try {
        validatePicks({ schema: 'rig-review/interview-picks@1', set: question.ref, by: 'user', at,
          picks: selections.map(item => ({ ask: item.itemId, option_id: item.optionId,
            ...(item.otherText === null ? {} : { other_text: item.otherText }) })), note }, question);
      } catch { throw new JobError('JOB_ACT_INVALID'); }
      return { ...envelope, kind: 'interview-picks', source: { ...source, optionSet: source.optionSet! },
        value: { questionId: subject.questionId, selections, note } };
    }
    case 'checkpoint': {
      const value = jobObject(submission.value, ['checkpointId', 'outcome', 'words']);
      const subject = ask.subject;
      if (subject.kind !== 'checkpoint' || value.checkpointId !== subject.checkpointId) throw new JobError('JOB_ACT_INVALID');
      return { ...envelope, kind: 'checkpoint', source: { ...source, plan: source.plan! }, value: {
        checkpointId: subject.checkpointId, planStepId: subject.planStepId ?? subject.checkpointId,
        outcome: choice(value.outcome, ['pass', 'fail'] as const), words: words(value.words),
      } };
    }
    case 'parts-verdict': {
      const value = jobObject(submission.value, ['verdict', 'parts', 'words']);
      if (!Array.isArray(value.parts) || value.parts.length !== retained.partIds.length) throw new JobError('JOB_ACT_INVALID');
      const ids = new Set<string>();
      const parts = value.parts.map(raw => {
        const item = jobObject(raw, ['partId', 'part', 'mesh']);
        const partId = jobId(item.partId);
        if (!retained.partIds.includes(partId) || ids.has(partId)) throw new JobError('JOB_ACT_INVALID');
        ids.add(partId);
        const outcome = (raw: unknown) => {
          const item = jobObject(raw, ['outcome', 'note']);
          const result = { outcome: choice(item.outcome, ['pending', 'clean', 'flagged'] as const), note: words(item.note) };
          // Match the existing parts verdict writer's flagged-note validation.
          if (result.outcome === 'flagged' && !result.note.trim()) throw new JobError('JOB_ACT_INVALID');
          return result;
        };
        return { partId, part: outcome(item.part), mesh: outcome(item.mesh) };
      });
      const verdict = choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const);
      const outcomes = parts.flatMap(part => [part.part.outcome, part.mesh.outcome]);
      if (verdict === 'approved' && outcomes.some(outcome => outcome !== 'clean') ||
          verdict === 'changes-requested' && !outcomes.includes('flagged')) throw new JobError('JOB_ACT_INVALID');
      return { ...envelope, kind: 'parts-verdict', source: { ...source, projectHash: source.projectHash!,
        selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'draft' }>, parts: source.parts! },
      value: { verdict, parts, words: words(value.words) } };
    }
    case 'review-verdict': {
      const value = jobObject(submission.value, ['stage', 'verdict', 'words']);
      if (ask.subject.kind !== 'review-verdict' || value.stage !== ask.subject.stage) throw new JobError('JOB_ACT_INVALID');
      return { ...envelope, kind: 'review-verdict', source: { ...source, model: source.model!,
        selector: source.selector as Extract<NonNullable<JobSourceBinding['selector']>, { kind: 'rig' | 'post' }> }, value: {
        stage: ask.subject.stage, verdict: choice(value.verdict, ['pending', 'approved', 'changes-requested'] as const), words: words(value.words),
      } };
    }
    case 'signoff': {
      const value = jobObject(submission.value, ['stage', 'decision', 'words']);
      if (ask.subject.kind !== 'signoff' || value.stage !== ask.subject.stage || value.decision !== 'approved') {
        throw new JobError('JOB_ACT_INVALID');
      }
      const result: JobActValues['signoff'] = { stage: ask.subject.stage, decision: 'approved', words: words(value.words) };
      return { ...envelope, kind: 'signoff', source, value: result };
    }
  }
}
