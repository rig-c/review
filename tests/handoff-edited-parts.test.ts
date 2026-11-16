import {expect, test} from 'bun:test';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, relative} from 'node:path';
import {jobHash} from '../src/job-api.ts';
import {loadOpenPackage} from '../src/open.ts';
import {loadReview} from '../src/manifest.ts';
import {jobFixture, jobInputHashes} from './helpers/job-api-fixture.ts';
import {joinedVerdictFixture} from './helpers/joined-verdict-fixture.ts';

test('#887 edited_parts receipt file bound in draft config_inputs opens, publishes and seals unchanged bytes', async () => {
  const f = await jobFixture();
  try {
    const original = await joinedVerdictFixture(f.root);
    const projectPath = join(f.root, 'project.json');
    const project = JSON.parse(await readFile(projectPath, 'utf8'));
    const draft = project.drafts[0];
    const configPath = join(f.root, draft.config.path);
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const bytes = await readFile(join(f.root, draft.parts.path, 'parts/torso.png'));
    const path = dirname(draft.config.path) + '/edited/torso.png';
    await mkdir(dirname(join(f.root, path)), {recursive: true});
    await writeFile(join(f.root, path), bytes);
    config.assemble = {...config.assemble, edited_parts: {dir: 'edited', receipts: [{file: 'torso.png'}]}};
    await writeFile(configPath, JSON.stringify(config));
    draft.config.sha256 = jobHash(await readFile(configPath));
    draft.config_inputs.push({path, sha256: jobHash(bytes)});
    await writeFile(projectPath, JSON.stringify(project));
    const before = await jobInputHashes(f.root);
    const opened = await loadOpenPackage({input: original.input, project: original.project});
    expect(opened.mode).toBe('single');
    if (opened.mode !== 'single') throw new Error('Expected single draft');
    expect(opened.joined?.draft?.files.get(join(f.root, path))).toBe(jobHash(bytes));
    f.setRecordPath('project.json');
    f.setContext({...f.getContext(), selector: {kind: 'draft', id: draft.id},
      files: [...opened.joined!.draft!.files].map(([file, sha256]) => ({
        path: relative(f.root, file).split('\\').join('/'), sha256,
      }))});
    const request = await f.publishRequest();
    request.result.path = relative(f.root, original.input).split('\\').join('/');
    const result = await (await f.call(request)).json();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const retained = f.session.retainedSource(result.value.publicationId);
    expect(retained.seals).toContainEqual({path, sha256: jobHash(bytes)});
    expect(await readFile(join(retained.snapshotRoot, path))).toEqual(bytes);
    expect(await jobInputHashes(f.root)).toEqual(before);
    await writeFile(join(f.root, path), 'changed after publication');
    expect(await readFile(join(retained.snapshotRoot, path))).toEqual(bytes);
  } finally { await f.close(); }
});

test('#887 edited_parts receipt directory refuses by its config reference name', async () => {
  const f = await jobFixture();
  try {
    await mkdir(join(f.root, 'out/edited/torso.png'), {recursive: true});
    await writeFile(join(f.root, 'out/config.json'), JSON.stringify({assemble: {
      edited_parts: {dir: 'edited', receipts: [{file: 'torso.png'}]},
    }}));
    await expect(loadReview(join(f.root, 'out'))).rejects.toThrow(
      'HANDOFF_INPUT_INVALID config assemble.edited_parts.receipts[0].file:');
    await expect(loadReview(join(f.root, 'out'))).rejects.toThrow('is not a regular file');
  } finally { await f.close(); }
});
