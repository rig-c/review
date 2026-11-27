import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {parseCommentsAct} from '../src/job-api.ts';
import {isPanelComponent, type JobSubject} from '../src/job-contract.ts';
import {loadReview} from '../src/manifest.ts';
import {jobFixture, syntheticJobParts} from './helpers/job-api-fixture.ts';

const subjects = [
  {kind: 'review-verdict', stage: 'rig-review'},
  {kind: 'parts-verdict', draftId: 'synthetic-draft'},
] as const satisfies readonly JobSubject[];

for (const subject of subjects) {
  test(`#1232 refuses fresh ${subject.kind} without changing durable job state`, async () => {
    const f = await jobFixture();
    try {
      if (subject.kind === 'parts-verdict') await syntheticJobParts(f, {project: true});
      const publication = await f.publish();
      const db = new Database(join(f.state, 'jobs.sqlite'), {readonly: true});
      try {
        const row = db.query<{document: string; revision: number}, [string]>('SELECT document, revision FROM jobs WHERE job_id=?');
        const before = row.get(f.session.jobId);
        const response = await f.call({...f.base(), verb: 'ask', expectedGeneration: publication.generation,
          idempotencyKey: 'fresh-verdict', publicationId: publication.publicationId, subject});
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ok: false, generation: publication.generation,
          error: {code: 'JOB_ASK_INVALID'}});
        expect(row.get(f.session.jobId)).toEqual(before);
      } finally {db.close();}
    } finally {await f.close();}
  });
}

test('#1232 the base direction verdict decodes with its original act bytes', async () => {
  const bytes = await readFile(new URL('./fixtures/job-verdict-1232/direction-act.json', import.meta.url), 'utf8');
  const act = parseCommentsAct(JSON.parse(bytes));
  expect(act).toMatchObject({kind: 'review-verdict', value: {stage: 'direction-review', verdict: 'changes-requested',
    comments: [{text: '  원문 그대로\r\nKeep the camera still.  \n'}, {text: 'A second comment'}]}});
  expect(JSON.stringify(act)).toBe(bytes);
});

test('#1232 an existing package opens with its historical act.submit component', async () => {
  const f = await jobFixture();
  try {
    const root = join(f.root, 'out');
    const bytes = await readFile(new URL('./fixtures/job-verdict-1232/legacy-panels.json', import.meta.url));
    await writeFile(join(root, 'review.json'), bytes);
    const opened = await loadReview(root);
    expect(isPanelComponent('act.submit')).toBe(true);
    expect(opened.manifest.panels).toEqual({schema: 'rig-review/panels@1', left: ['parts.list'],
      stage: ['parts.canvas'], toolbar: ['parts.layers'], side: ['parts.issues', 'act.submit']});
  } finally {await f.close();}
});
