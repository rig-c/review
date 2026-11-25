import {expect} from 'bun:test';
import {join} from 'node:path';
import {realpathSync} from 'node:fs';
import {mkdir, mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {JOB_API_SCHEMA, JOB_API_V3_SCHEMA, JOB_RECORD_READER_ID, startJobHost, type JobHostOptions, type JobOwnerHost} from '../../src/job-host.ts';
import {jobHash} from '../../src/job-api.ts';
import {jobFixture} from './job-api-fixture.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticPlanRecordWorkspace, createSyntheticRecordReader} from './job-record-fixture.ts';
import type {OptionContext, PlanContext, RecordActKind} from '../../src/job-contract.ts';

// Every UI submission here is an explicitly synthetic test fixture. No real
// owner's review or producer acceptance is represented by these acts.
let sequence = 0;
/** A live owner host, a strict attachment beside it, a pending rig verdict ask on its head and a comment-only act@10 to send (#1235). */
export async function attachedPair(fixtures: Awaited<ReturnType<typeof jobFixture>>[], hosts: JobOwnerHost[]) {
  const f = await jobFixture();
  fixtures.push(f);
  const options: JobHostOptions = {
    root: f.root, stateDir: join(f.scratch, 'host-state'), fingerprint: 'f'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}, readPublished: async () => f.getContext(),
    readerId: 'reader/1', installWriterBinding: () => {}, bindingId: 'writer/1',
    partsEnumerator: f.partsEnumerator, partsEnumeratorId: 'parts/1',
  };
  const owner = await startJobHost(options);
  hosts.push(owner);
  const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}});
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.session).not.toBe(owner.session);
  const jobId = owner.session.jobId, {agent, ui} = owner.session.hostCredentials();
  async function agentCall(host: JobOwnerHost, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + agent}, signal,
      body: JSON.stringify({schema: JOB_API_SCHEMA, jobId, requestId: `request-${++sequence}`, ...body}),
    }));
    return response.json();
  }
  const uiRequest = (path: string, body: unknown) => new Request(`${owner.origin}/jobs/${jobId}/ui/${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': ui},
    body: JSON.stringify(body),
  });
  const publish = async () => agentCall(owner, {verb: 'publish', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `publish-${++sequence}`, result: {path: 'out', selector: f.getContext().selector},
    freeze: {kind: 'producer-held', holdId: 'synthetic-held-freeze',
      record: {path: 'record.json', sha256: jobHash(await readFile(join(f.root, 'record.json')))}}});
  const published = await publish();
  expect(published.ok).toBe(true);
  const publication = published.value;
  const asked = await agentCall(owner, {verb: 'ask', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `ask-${++sequence}`, publicationId: publication.publicationId,
    subject: {kind: 'review-verdict', stage: 'rig-review'}});
  expect(asked.ok).toBe(true);
  async function display(pageId = 'page-one') {
    const shown = await owner.ports.ackDisplayed(jobId, uiRequest('displayed',
      {publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash}));
    if (!shown.ok) throw new Error(JSON.stringify(shown));
    return shown.value;
  }
  const page = await display();
  const act = {...page, expectedGeneration: owner.session.status().generation,
    submissionId: 'synthetic-cross-session-act', kind: 'comments', value: {comments: [{text: 'synthetic'}]}};
  const head = await agentCall(attached, {verb: 'next', after: null, waitMs: 0});
  expect(head.ok).toBe(true);
  return {owner, attached, agentCall, display, publish, act, cursor: head.value.cursor as string,
    commit: (value: unknown = act) => owner.ports.commitUIAct(jobId, uiRequest('acts', value))};
}

/** One record subject per record act kind, with the finalized UI value its owner submits. */
const recordCases = {
  'interview-picks': {subject: {kind: 'interview-picks', questionId: 'rig_type', setId: 'set_rig_type_01'},
    value: {questionId: 'rig_type', selections: [
      {itemId: 'topology', optionId: 'biped_std', otherText: null},
      {itemId: 'detail_level', optionId: 'density_high', otherText: null}], note: ''}},
  checkpoint: {subject: {kind: 'checkpoint', checkpointId: 'step_layout'},
    value: {checkpointId: 'step_layout', outcome: 'pass', words: 'synthetic'}},
  signoff: {subject: {kind: 'signoff', stage: 'plan-approved'},
    value: {stage: 'plan-approved', decision: 'approved', words: 'synthetic'}},
  reopen: {subject: {kind: 'reopen', stage: 'plan-approved'},
    value: {stage: 'plan-approved', words: 'synthetic'}},
} as const satisfies Record<RecordActKind, {subject: object; value: object}>;

/** A live record-and-package owner host with a strict attachment and a pending record ask of `kind`.
 * `comments` asks nothing and sends the comment-only act@10 on a plan record (#1235). */
export async function recordAttachedPair(scratches: string[], hosts: JobOwnerHost[], kind: RecordActKind | 'comments' = 'comments') {
  const scratch = await mkdtemp(join(realpathSync(tmpdir()), 'review-1005-record-'));
  scratches.push(scratch);
  const root = join(scratch, 'input');
  await mkdir(root);
  const workspace = kind === 'interview-picks' ? createSyntheticOptionRecordWorkspace(root)
    : createSyntheticPlanRecordWorkspace(root, {subjects: kind === 'comments' ? [recordCases.signoff.subject]
      : [recordCases.checkpoint.subject, recordCases.signoff.subject, recordCases.reopen.subject]});
  const reader = createSyntheticRecordReader({onPlan: () => structuredClone(workspace.context as PlanContext),
    onOption: () => structuredClone(workspace.context as OptionContext)});
  const options: JobHostOptions = {
    root, stateDir: join(scratch, 'state'), fingerprint: 'r'.repeat(64),
    reviewer: {id: 'declared-owner', role: 'owner'}, publicationMode: 'record-and-package',
    readRecordPublished: reader.reader, readerId: JOB_RECORD_READER_ID,
    installWriterBinding: () => {}, bindingId: 'record-writer/1',
  };
  const owner = await startJobHost(options);
  hosts.push(owner);
  const attached = await startJobHost({...options, reuseOnly: {expected: owner.attachment!}});
  hosts.push(attached);
  expect(attached.reused).toBe(true);
  expect(attached.session.apiSchema).toBe(JOB_API_V3_SCHEMA);
  const jobId = owner.session.jobId, {agent, ui} = owner.session.hostCredentials();
  async function agentCall(host: JobOwnerHost, body: Record<string, unknown>) {
    const response = await host.ports.handleJobApi(new Request(`${host.origin}/jobs/${jobId}/api`, {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + agent},
      body: JSON.stringify({schema: JOB_API_V3_SCHEMA, jobId, requestId: `request-${++sequence}`, ...body}),
    }));
    return response.json();
  }
  const uiRequest = (path: string, body: unknown) => new Request(`${owner.origin}/jobs/${jobId}/ui/${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: owner.origin, 'X-Review-Capability': ui},
    body: JSON.stringify(body),
  });
  const published = await agentCall(owner, {verb: 'publish', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `publish-${++sequence}`, result: workspace.result,
    freeze: {kind: 'producer-held', holdId: 'synthetic-held-freeze', record: workspace.record}});
  expect(published.ok).toBe(true);
  const publication = published.value;
  const asked = kind === 'comments' ? undefined : await agentCall(owner, {verb: 'ask', expectedGeneration: owner.session.status().generation,
    idempotencyKey: `ask-${++sequence}`, publicationId: publication.publicationId, subject: recordCases[kind].subject});
  if (asked && !asked.ok) throw new Error(JSON.stringify(asked));
  const display = async (pageId = 'page-record') => {
    const shown = await owner.ports.ackDisplayed(jobId, uiRequest('displayed',
      {publicationId: publication.publicationId, pageId, sourceHash: publication.source.sourceHash}));
    if (!shown.ok) throw new Error(JSON.stringify(shown));
    return shown.value;
  };
  const page = await display();
  const act = kind === 'comments' ? {...page, expectedGeneration: owner.session.status().generation,
    submissionId: 'synthetic-record-comments', kind, value: {comments: [{text: 'synthetic'}]}}
    : {...page, askId: asked.value.askId, expectedGeneration: owner.session.status().generation,
      submissionId: `synthetic-record-${kind}`, kind, value: recordCases[kind].value};
  const head = await agentCall(attached, {verb: 'next', after: null, waitMs: 0});
  expect(head.ok).toBe(true);
  return {owner, attached, agentCall, display, act, cursor: head.value.cursor as string,
    commit: (value: unknown = act) => owner.ports.commitUIAct(jobId, uiRequest('acts', value))};
}
