import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {canonicalJson} from '../src/canonical-json.ts';
import {jobHash, parseCommentOnlyAct} from '../src/job-api.ts';
import type {JobMeshEditValue} from '../src/job-contract.ts';
import {attachmentHashText, meshEditActValue, MeshEditSession} from '../src/mesh-edit.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();

const bind = (edit: JobMeshEditValue) => ({edit, sha256: jobHash(canonicalJson(edit))});

test('#977 comment-only acts store mesh edits against the retained attachment', async () => {
  const fixture = await jobFixture();
  try {
    const publication = await fixture.publish();
    const page = await fixture.display(publication);
    const retained = fixture.session.retainedSource(publication.publicationId);
    const model = JSON.parse(await readFile(join(retained.snapshotRoot, publication.source.model!.path), 'utf8'));
    const entry = model.skins.find((skin: {name: string}) => skin.name === 'default').attachments.mesh.mesh;
    const editor = new MeshEditSession({slot: 'mesh', attachment: 'mesh', skin: 'default',
      vertices: [[48.12345678912345, 42.00000000000001], [48, 22], [68, 22], [68, 42]], triangles: entry.triangles,
      hull: entry.hull, hash: jobHash(attachmentHashText(entry))});
    expect(editor.addVertex([60.12345, 29.56789])).toMatchObject({ok: true, changed: true});
    const edit = meshEditActValue(editor, {width: model.stage.width, height: model.stage.height});
    expect(edit.source.positions).toEqual([...editor.source.vertices]);
    expect(edit.ops).toEqual([{op: 'add', at: [60.12, 29.57]}]);
    const file = publication.source.model!;
    const carrier = {kind: 'mesh-edits', file, meshEdits: [bind(edit)]} as const;
    const submission = {...page, expectedGeneration: fixture.session.status().generation,
      submissionId: 'mesh-952', kind: 'comments', value: {comments: [], carriers: [carrier]}} as const;
    const commit = (input: object) => fixture.ports.commitUIAct(fixture.session.jobId, fixture.uiRequest(input));
    const saved = await commit(submission);
    expect(saved).toMatchObject({ok: true, value: {schema: 'rig-review/act@10'}});
    if (!saved.ok) throw new Error(saved.error.code);
    const act = parseCommentOnlyAct(saved.value);
    expect(act).not.toHaveProperty('askId');
    expect(fixture.session.readActExport(act.actId, false).toString()).toBe(JSON.stringify(act));
    expect(await commit(submission)).toEqual(saved);
    expect(act.value.comments).toEqual([]);
    expect(act.value.carriers).toEqual([carrier]);
    const serialized = parseCommentOnlyAct(JSON.parse(JSON.stringify(act))).value.carriers?.[0];
    if (serialized?.kind !== 'mesh-edits') throw new Error('Expected mesh carrier');
    expect(serialized.meshEdits[0]?.edit.source.positions).toEqual([...editor.source.vertices]);
    expect(serialized.meshEdits[0]?.edit.source.frame).toEqual({width: model.stage.width, height: model.stage.height});
    const comments = [{text: 'please revise'}];
    const withComment = await commit({...submission, submissionId: 'mesh-and-comment', value: {...submission.value, comments}});
    if (!withComment.ok) throw new Error(withComment.error.code);
    expect(parseCommentOnlyAct(withComment.value).value.comments).toEqual(comments);
    const before = fixture.session.status();
    const mutants = [
      ['stale-hash', {source: {...edit.source, hash: '1'.repeat(64)}}, 'JOB_ACT_SOURCE_STALE'],
      ['bad-count', {source: {...edit.source, triangleCount: 9}}, 'JOB_ACT_INVALID'],
      ['bad-frame', {source: {...edit.source, frame: {...edit.source.frame, width: 1}}}, 'JOB_ACT_INVALID'],
      ['bad-op', {ops: [{op: 'remove', v: 950}]}, 'JOB_ACT_INVALID'],
    ] as const satisfies readonly (readonly [string, Partial<JobMeshEditValue>, string])[];
    for (const [submissionId, patch, code] of mutants) {
      const altered = {...carrier, meshEdits: [bind({...edit, ...patch})]};
      expect(await commit({...submission, submissionId, value: {comments: [], carriers: [altered]}}))
        .toMatchObject({ok: false, error: {code}});
      expect(fixture.session.status()).toEqual(before);
    }
  } finally {
    await fixture.close();
  }
});
