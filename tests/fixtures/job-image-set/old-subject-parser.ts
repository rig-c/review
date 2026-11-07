// Exact pre-522 src/job-api.ts parseJobSubject body at base 4dffe227e87206bac3e236cf7833890972d97b04.
// Function SHA-256 8800df697d579e52804ce0f8caf8deae705b05dae0256afba037d1f01870afd0.
// Shared validators and kind constants are current imports. This is an old-parser control, not an old-server run.
import {jobObject, jobId} from '../../../src/job-api.ts';
import {JOB_RESERVED_ACT_KINDS, JOB_ENABLED_ACT_KINDS, type JobSubject} from '../../../src/job-contract.ts';
import {JobError} from '../../../src/job-store.ts';
export function parseJobSubject(value: unknown): JobSubject {
  const item = jobObject(value, ['kind', 'questionId', 'setId', 'checkpointId', 'planStepId', 'draftId', 'stage']);
  if ((JOB_RESERVED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ACT_KIND_DISABLED');
  if (!(JOB_ENABLED_ACT_KINDS as readonly unknown[]).includes(item.kind)) throw new JobError('JOB_ASK_INVALID');
  switch (item.kind) {
    case 'interview-picks':
      jobObject(item, ['kind', 'questionId', 'setId']);
      return { kind: item.kind, questionId: jobId(item.questionId), setId: jobId(item.setId) };
    case 'checkpoint':
      jobObject(item, ['kind', 'checkpointId', 'planStepId']);
      return {
        kind: item.kind, checkpointId: jobId(item.checkpointId),
        ...(item.planStepId === undefined ? {} : { planStepId: jobId(item.planStepId) }),
      };
    case 'parts-verdict':
      jobObject(item, ['kind', 'draftId']);
      return { kind: item.kind, draftId: jobId(item.draftId) };
    case 'review-verdict':
      jobObject(item, ['kind', 'stage']);
      if (item.stage !== 'rig-review' && item.stage !== 'direction-review') throw new JobError('JOB_ASK_INVALID');
      return { kind: item.kind, stage: item.stage };
    case 'signoff':
      jobObject(item, ['kind', 'stage']);
      return { kind: item.kind, stage: jobId(item.stage) };
  }
  throw new JobError('JOB_ASK_INVALID');
}

