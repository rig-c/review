import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareJobRecordAct} from '../src/job-act.ts';
import {buildRecordSource, createJobHostPorts, parseCommentsAct, parseRecordAct, parseRecordPublishedContext,
  parseRecordSource, serializeRecordSourceDigestPayload} from '../src/job-api.ts';
import {JOB_API_V3_SCHEMA, JOB_COMMENTS_ACT_SCHEMA, jobRawActMediaType, type JobCommentsAct, type PendingAskV3, type PlanContext,
  type PublicationV3, type UISubmissionV3} from '../src/job-contract.ts';
import {retainedPublicationRoutes} from '../src/job-front.ts';
import {JobSession, type JobSessionOptions} from '../src/job-session.ts';
import {isRetainedRecordSource} from '../src/job-source.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticPlanRecordWorkspace,
  createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';

const signoff = {kind: 'signoff', stage: 'direction-review'} as const;
const checkpoint = {kind: 'checkpoint', checkpointId: 'step_layout'} as const;
const directionReview = {postVersion: 2, verdictActId: 'fixture-verdict',
  take: {duration: 2.5, loop: true}, camera: 'composed'} as const satisfies PlanContext['directionReview'];
const reviewer = {id: 'synthetic-owner', role: 'owner'} as const;
const invalid = {code: 'JOB_SOURCE_INVALID'};

test('#1088 validates exact display shape and admits it only on declared record direction signoff', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'review-1088-shape-')));
  try {
    const fixture = createSyntheticPlanRecordWorkspace(scratch, {subjects: [signoff]});
    const source = buildRecordSource({record: fixture.record, selection: fixture.result, context: fixture.context});
    const refuse = (patch: Record<string, unknown>) => {
      expect(() => parseRecordPublishedContext({...fixture.context, ...patch}, fixture.result)).toThrow(invalid.code);
      expect(() => parseRecordSource({...source, ...patch})).toThrow(invalid.code);
    };
    for (const projection of [undefined, null, [], 'direction', {},
      {...directionReview, extra: true}, {...directionReview, verdictActId: undefined},
      {...directionReview, verdictActId: 1}, {...directionReview, camera: 'authored'},
      ...[undefined, 0, -1, 1.5, Infinity, NaN, '2'].map(postVersion => ({...directionReview, postVersion})),
      ...[undefined, 0, -1, Infinity, NaN, '2.5'].map(duration => ({...directionReview, take: {duration, loop: true}})),
      {...directionReview, take: []}, {...directionReview, take: {duration: 1}},
      {...directionReview, take: {duration: 1, loop: 'false'}},
      {...directionReview, take: {duration: 1, loop: false, extra: true}},
    ]) refuse({directionReview: projection});
    for (const subjects of [[], [checkpoint], [{...signoff, stage: 'post-interview'}],
      [{...signoff, stage: 'unknown-stage'}], [{...signoff, stage: null}],
      [{...signoff, kind: 'reopen'}], [{...signoff, kind: 'review-verdict'}],
    ]) refuse({directionReview, subjects});
    for (const camera of ['fixed', 'moving', 'composed'] as const) {
      const projected = {postVersion: 1, verdictActId: null, take: {duration: 0.25, loop: false}, camera};
      expect(parseRecordPublishedContext({...fixture.context, directionReview: projected}, fixture.result).directionReview)
        .toEqual(projected);
      expect(parseRecordSource({...source, directionReview: projected}).directionReview).toEqual(projected);
    }
    const option = createSyntheticOptionRecordWorkspace(join(scratch, 'option'));
    expect(() => parseRecordPublishedContext({...option.context, directionReview}, option.result)).toThrow(invalid.code);
    const optionSource = buildRecordSource({record: option.record, selection: option.result, context: option.context,
      optionSetFile: option.optionSetFile});
    expect(() => parseRecordSource({...optionSource, directionReview})).toThrow(invalid.code);
  } finally {rmSync(scratch, {recursive: true, force: true});}
});

test('#1088 refuses the record display field in the trusted package reader', async () => {
  const fixture = await jobFixture();
  try {
    const context = {...fixture.getContext(), directionReview};
    fixture.setContext(context);
    const response = await fixture.call(await fixture.publishRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ok: false, generation: 0, error: invalid});
  } finally {await fixture.close();}
});

function host(session: JobSession) {
  const origin = 'http://127.0.0.1:19484';
  const base = `${origin}/jobs/${session.jobId}`;
  const ports = createJobHostPorts(session, origin);
  const credentials = session.hostCredentials();
  const ui = (path: string, body: object) => new Request(`${base}/ui/${path}`, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin, 'X-Review-Capability': credentials.ui},
    body: JSON.stringify(body)});
  const call = (body: object, token = credentials.agent, accept = 'application/json') => ports.handleJobApi(
    new Request(`${base}/api`, {method: 'POST', headers: {'Content-Type': 'application/json', accept,
      Authorization: `Bearer ${token}`}, body: JSON.stringify({schema: JOB_API_V3_SCHEMA,
      jobId: session.jobId, requestId: 'direction-review-fixture', ...body})}));
  return {call, display: (body: object) => ports.ackDisplayed(session.jobId, ui('displayed', body)),
    commit: (body: object) => ports.commitUIAct(session.jobId, ui('acts', body)),
    fetch: (actId: string) => call({verb: 'fetch-act', actId}, session.writerGrant().fetchCapability, jobRawActMediaType)};
}

test('#1088 publish, ask, display, finalize, fetch and replay preserve act bytes and source identity', async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'review-1088-host-')));
  const root = join(scratch, 'work');
  mkdirSync(root);
  const fixture = createSyntheticPlanRecordWorkspace(root, {subjects: [signoff, checkpoint]});
  const original = fixture.files.map(file => readFileSync(join(root, file.path)));
  const sessions: JobSession[] = [];
  try {
    const results = [];
    for (const projection of [undefined, directionReview]) {
      const context: PlanContext = projection ? {...fixture.context, directionReview: projection} : fixture.context;
      const drift = {...fixture.context, directionReview: {...directionReview, postVersion: 9}};
      let inventory: PlanContext = context, retainedRead: PlanContext = context;
      const {reader, calls} = createSyntheticRecordReader({onPlan: input => input.phase === 'inventory' ? inventory : retainedRead});
      const options: JobSessionOptions = {root, stateDir: join(scratch, projection ? 'present' : 'absent'),
        fingerprint: 'direction-review', reviewer, readRecordPublished: reader};
      const session = new JobSession(options);
      sessions.push(session);
      const api = host(session);
      const publish = {verb: 'publish', expectedGeneration: 0, idempotencyKey: 'publish', result: fixture.result,
        freeze: {kind: 'producer-held', holdId: 'synthetic', record: fixture.record}};
      if (projection) {
        inventory = {...context, subjects: [{...signoff, stage: 'unknown-stage'}]} as unknown as PlanContext;
        expect(await (await api.call(publish)).json()).toMatchObject({ok: false, generation: 0, error: invalid});
        inventory = context;
        retainedRead = drift;
        expect(await (await api.call(publish)).json()).toMatchObject({ok: false, generation: 0,
          error: {code: 'JOB_SOURCE_MISMATCH'}});
        retainedRead = context;
      }
      const published = await (await api.call(publish)).json();
      expect(published.ok).toBe(true);
      const publication: PublicationV3 = published.value;
      const retained = session.retainedSourceV3(publication.publicationId);
      if (!isRetainedRecordSource(retained)) throw new Error('Expected record source');
      expect(publication.source).toEqual(retained.source);
      expect(retained.source.directionReview).toEqual(projection);
      expect(Object.hasOwn(retained.source, 'directionReview')).toBe(!!projection);
      const metadata = await retainedPublicationRoutes(session)(session.jobId, publication.publicationId,
        publication.instanceKey, 'api/review', new Request('http://127.0.0.1/api/review'));
      expect(metadata.status).toBe(200);
      expect((await metadata.json()).recordSource).toEqual(publication.source);

      const ask = {verb: 'ask-batch', expectedGeneration: 1, idempotencyKey: 'ask',
        publicationId: publication.publicationId, subjects: [signoff, checkpoint]};
      if (projection) {
        inventory = retainedRead = drift;
        expect(await (await api.call(ask)).json()).toMatchObject({ok: false, generation: 1,
          error: {code: 'JOB_SOURCE_MISMATCH'}});
        inventory = retainedRead = context;
      }
      const asked = await (await api.call(ask)).json();
      expect(asked.ok).toBe(true);
      const asks: PendingAskV3[] = asked.value.asks;
      expect(asks).toHaveLength(2);
      const receipt = await api.display({publicationId: publication.publicationId, pageId: 'owner',
        sourceHash: retained.source.sourceHash});
      if (!receipt.ok) throw new Error(receipt.error.code);

      const artifacts = [];
      for (const pending of asks) {
        expect(pending.source).toEqual(publication.source);
        const fields = {...receipt.value, askId: pending.askId, submissionId: pending.subject.kind,
          expectedGeneration: session.status().generation};
        const words = '  Original approval · 원문\n';
        const submission: UISubmissionV3 = pending.subject.kind === 'signoff'
          ? {...fields, kind: 'signoff', value: {stage: signoff.stage, decision: 'approved', words}}
          : {...fields, kind: 'checkpoint', value: {checkpointId: checkpoint.checkpointId, outcome: 'pass', words}};
        if (projection && pending.subject.kind === 'signoff') {
          retainedRead = drift;
          expect(await api.commit(submission)).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
          expect(session.status().generation).toBe(fields.expectedGeneration);
          retainedRead = context;
        }
        const committed = await api.commit(submission);
        if (!committed.ok) throw new Error(committed.error.code);
        const act = parseRecordAct(committed.value);
        expect(Object.hasOwn(act.source, 'directionReview')).toBe(false);
        expect(() => parseRecordAct({...act, source: {...act.source, directionReview}})).toThrow('JOB_ACT_INVALID');
        if (act.kind !== 'signoff' && act.kind !== 'checkpoint') throw new Error('Expected signoff or checkpoint act');
        const comments = [{text: act.value.words}];
        const commentsAct: JobCommentsAct = act.kind === 'signoff'
          ? {...act, schema: JOB_COMMENTS_ACT_SCHEMA, value: {stage: act.value.stage, decision: act.value.decision, comments}}
          : {...act, schema: JOB_COMMENTS_ACT_SCHEMA, value: {checkpointId: act.value.checkpointId,
            planStepId: act.value.planStepId, outcome: act.value.outcome, comments}};
        expect(parseCommentsAct(commentsAct)).toEqual(commentsAct);
        expect(() => parseCommentsAct({...commentsAct, source: {...act.source, directionReview}})).toThrow('JOB_ACT_INVALID');
        const response = await api.fetch(act.actId);
        expect(response.status).toBe(200);
        const raw = await response.text();
        expect(raw).toBe(JSON.stringify(act));
        // The production writer accepts fixed envelope fields, so compare the complete act across both inputs.
        const fixedAsk = {...pending, askId: 'fixed-ask', publicationId: 'fixed-publication'};
        const fixed = prepareJobRecordAct({jobId: 'fixed-job', ask: fixedAsk, retained, reviewer,
          submission: {...submission, publicationId: fixedAsk.publicationId}, actId: 'fixed-act', at: '2026-11-23T00:00:00Z'});
        expect(raw).toBe(JSON.stringify({...fixed, actId: act.actId, jobId: act.jobId, askId: act.askId,
          publicationId: act.publicationId, at: act.at}));
        artifacts.push({act, raw, submission, fixedBytes: JSON.stringify(fixed)});
      }

      session.dispose();
      const reopened = new JobSession(options);
      sessions.push(reopened);
      expect(reopened.jobId).toBe(session.jobId);
      const replay = host(reopened), readCount = calls.length;
      expect((await (await replay.call(publish)).json()).value).toEqual(publication);
      expect((await (await replay.call(ask)).json()).value).toEqual(asked.value);
      for (const {act, raw, submission} of artifacts) {
        expect(await replay.commit(submission)).toEqual({ok: true, value: act});
        expect(await (await replay.fetch(act.actId)).text()).toBe(raw);
      }
      expect(calls).toHaveLength(readCount);
      const nextContext = projection ? drift : context;
      inventory = retainedRead = nextContext;
      const nextPublish = await (await replay.call({...publish, idempotencyKey: 'next-publish',
        expectedGeneration: reopened.status().generation})).json();
      expect(nextPublish).toMatchObject({ok: true, value: {instanceKey: publication.instanceKey,
        source: {sourceHash: retained.source.sourceHash}}});
      expect(nextPublish.value.source.directionReview).toEqual(nextContext.directionReview);
      expect(nextPublish.value.publicationId).not.toBe(publication.publicationId);
      expect(await (await replay.call(publish)).json()).toMatchObject({ok: false, error: {code: 'JOB_ACT_SOURCE_STALE'}});
      expect((await (await replay.call(ask)).json()).value).toEqual(asked.value);
      for (const {act, raw} of artifacts) expect(await (await replay.fetch(act.actId)).text()).toBe(raw);

      results.push({sourceHash: retained.source.sourceHash, projectHash: retained.source.projectHash,
        instanceKey: retained.instanceKey, digest: serializeRecordSourceDigestPayload(retained.source),
        inputs: retained.source.inputs, files: retained.source.files, seals: retained.seals,
        fixedBytes: artifacts.map(artifact => artifact.fixedBytes)});
      expect(fixture.files.map(file => readFileSync(join(retained.snapshotRoot, file.path)))).toEqual(original);
      if (projection) {
        // Corrupt one durable copy at a time in the disposable host, keeping the other copies as controls.
        const db = new Database(join(options.stateDir, 'jobs.sqlite'));
        try {
          const id = reopened.jobId;
          const {document} = db.query<{document: string}, [string]>('SELECT document FROM jobs WHERE job_id=?').get(id)!;
          const update = db.query('UPDATE jobs SET document=? WHERE job_id=?');
          for (const target of ['retained', 'ask-replay', 'act'] as const) {
            const data = JSON.parse(document);
            if (target === 'retained') data.publications[publication.publicationId].retained.context.directionReview = drift.directionReview;
            if (target === 'ask-replay') delete data.replays['agent:ask'].value.asks[0].source.directionReview;
            if (target === 'act') data.acts[artifacts[0]!.act.actId].source.directionReview = projection;
            update.run(JSON.stringify(data), id);
            expect(() => reopened.status(), target).toThrow('JOB_SOURCE_MISMATCH');
          }
          update.run(document, id);
          expect(await (await replay.fetch(artifacts[0]!.act.actId)).text()).toBe(artifacts[0]!.raw);
        } finally {db.close();}
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(fixture.files.map(file => readFileSync(join(root, file.path)))).toEqual(original);
  } finally {
    for (const session of sessions) session.dispose();
    rmSync(scratch, {recursive: true, force: true});
  }
});
