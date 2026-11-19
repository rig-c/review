import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalJson} from '../src/canonical-json.ts';
import {finalizeJobAct, prepareJobStill} from '../src/job-act.ts';
import {jobHash, parseMeshEditsAct} from '../src/job-api.ts';
import type {JobMeshEditValue, JobUISubmission} from '../src/job-contract.ts';
import {attachmentHashText, meshEditActValue, MeshEditSession} from '../src/mesh-edit.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const bind = (edit: JobMeshEditValue) => ({edit, sha256: jobHash(canonicalJson(edit))});

test('#952 the writer gates mesh edits and replays only against the retained attachment', async () => {
  const fixture = await jobFixture();
  try {
    const publication = await fixture.publish();
    const ask = await fixture.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    const page = await fixture.display(publication);
    const retained = fixture.session.retainedSource(publication.publicationId);
    const model = JSON.parse(await readFile(join(retained.snapshotRoot, ask.source.model!.path), 'utf8'));
    const entry = model.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh.mesh;
    const editor = new MeshEditSession({slot: 'mesh', attachment: 'mesh', skin: 'default',
      vertices: [[48.12345678912345, 42.00000000000001], [48, 22], [68, 22], [68, 42]], triangles: entry.triangles,
      hull: entry.hull, hash: jobHash(attachmentHashText(entry))});
    expect(editor.addVertex([60.12345, 29.56789])).toMatchObject({ok: true, changed: true});
    const edit = meshEditActValue(editor, {width: model.stage.width, height: model.stage.height});
    expect(edit.source.positions).toEqual([...editor.source.vertices]);
    expect(edit.ops).toEqual([{op: 'add', at: [60.12, 29.57]}]);
    const submission = {...page, askId: ask.askId, expectedGeneration: fixture.session.status().generation,
      submissionId: 'mesh-952', kind: 'review-verdict', capture: rigStillCapture(publication, ask, page).capture,
      value: {stage: 'rig-review', verdict: 'changes-requested', words: '', meshEdits: [bind(edit)]}} as const;
    const options = {jobId: fixture.session.jobId, ask, retained,
      reviewer: {id: 'owner', role: 'owner'} as const, still: prepareJobStill(submission, ask, retained).still};
    const finalize = (value: JobUISubmission['value'] = submission.value) =>
      finalizeJobAct({...options, submission: {...submission, value} as JobUISubmission, emitUnpinned: true});
    const refused = await fixture.ports.commitUIAct(fixture.session.jobId, fixture.uiRequest(submission));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('JOB_ACT_KIND_DISABLED');
    expect(fixture.session.status().pending.find(row => row.askId === ask.askId)?.status).toBe('pending');

    const act = parseMeshEditsAct(finalize());
    expect(act.value.comments).toEqual([]);
    expect(act.value.meshEdits).toEqual(submission.value.meshEdits);
    const serialized = parseMeshEditsAct(JSON.parse(JSON.stringify(act)));
    expect(serialized.value.meshEdits?.[0]?.edit.source.positions).toEqual([...editor.source.vertices]);
    expect(serialized.value.meshEdits?.[0]?.edit.source.frame).toEqual({width: model.stage.width, height: model.stage.height});
    expect(parseMeshEditsAct(finalize({...submission.value, words: 'please revise'})).value.comments)
      .toEqual([{text: 'please revise'}]);
    expect(() => finalize({...submission.value, verdict: 'approved'})).toThrow('JOB_ACT_INVALID');
    // Historical @6 allows this wire value. The existing UI blocks the empty request.
    expect(finalize({stage: 'rig-review', verdict: 'changes-requested', words: ''}).schema).toBe('rig-review/act@6');
    const mutant = (patch: Partial<JobMeshEditValue>) => ({...submission.value, meshEdits: [bind({...edit, ...patch})]});
    expect(() => finalize(mutant({source: {...edit.source, hash: '1'.repeat(64)}}))).toThrow('JOB_ACT_SOURCE_STALE');
    expect(() => finalize(mutant({source: {...edit.source, triangleCount: 9}}))).toThrow('JOB_ACT_INVALID');
    expect(() => finalize(mutant({source: {...edit.source, frame: {...edit.source.frame, width: 1}}}))).toThrow('JOB_ACT_INVALID');
    expect(() => finalize(mutant({ops: [{op: 'remove', v: 950}]}))).toThrow('JOB_ACT_INVALID');
  } finally {
    await fixture.close();
  }
});
