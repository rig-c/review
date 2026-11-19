import {exactObject, jobId, jobSha, parseFileRow} from './job-api.ts';
import {JOB_PREVIOUS_DRAFT_SCHEMA, type JobFileIdentity, type JobPreviousDraft, type JobSelector} from './job-contract.ts';
import {JobError} from './job-store.ts';

function parsePreviousDraft(value: unknown): JobPreviousDraft {
  try {
    const item = exactObject(value, ['schema', 'draft', 'composites'], 'JOB_SOURCE_MISMATCH', ['diff']);
    if (item.schema !== JOB_PREVIOUS_DRAFT_SCHEMA) throw new Error('schema');
    const draft = exactObject(item.draft, ['id', 'revision'], 'JOB_SOURCE_MISMATCH');
    const composites = exactObject(item.composites, ['current', 'previous'], 'JOB_SOURCE_MISMATCH');
    return {schema: JOB_PREVIOUS_DRAFT_SCHEMA, draft: {id: jobId(draft.id), revision: jobSha(draft.revision)},
      composites: {current: parseFileRow(composites.current, 'JOB_SOURCE_MISMATCH'),
        previous: parseFileRow(composites.previous, 'JOB_SOURCE_MISMATCH')},
      ...('diff' in item ? {diff: parseFileRow(item.diff, 'JOB_SOURCE_MISMATCH')} : {})};
  } catch {
    throw new JobError('JOB_SOURCE_MISMATCH', 'PREVIOUS_DRAFT_INVALID');
  }
}

/** The decoder checks the declaration. Admission additionally supplies the actual files closure. */
export function previousDraftFields(holder: object, selector: JobSelector | null,
  files?: readonly JobFileIdentity[]): {previousDraft?: JobPreviousDraft} {
  if (!('previousDraft' in holder)) return {};
  if (selector?.kind !== 'draft') throw new JobError('JOB_SOURCE_MISMATCH', 'PREVIOUS_DRAFT_SELECTOR');
  const previousDraft = parsePreviousDraft(holder.previousDraft);
  if (previousDraft.draft.id === selector.id) throw new JobError('JOB_SOURCE_MISMATCH', 'PREVIOUS_DRAFT_SELF');
  if (Buffer.byteLength(JSON.stringify(previousDraft)) > 4096) {
    throw new JobError('JOB_SOURCE_UNRETAINABLE', 'PREVIOUS_DRAFT_LIMIT operand=declaration');
  }
  const operands = {...previousDraft.composites, diff: previousDraft.diff};
  for (const [operand, file] of Object.entries(operands)) {
    if (file && files && !files.some(seal => seal.path === file.path && seal.sha256 === file.sha256)) {
      throw new JobError('JOB_SOURCE_MISMATCH', `PREVIOUS_DRAFT_UNSEALED operand=${operand}`);
    }
  }
  return {previousDraft};
}
