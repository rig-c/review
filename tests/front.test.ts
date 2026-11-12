import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/interview-project.ts';
import {openReview} from '../src/open.ts';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
test('direct opener preserves the malformed scene stale refusal', async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), 'review-front-scene-')));
 roots.push(root);
 const projectRoot = join(root, 'project');
 const control = join(root, 'open');
 await mkdir(projectRoot);
 await mkdir(control);
 const archive = await readFile(new URL('./fixtures/create-reopened-v2/project.tar.gz', import.meta.url));
 expect(digest(archive)).toBe('35fb7799f48336e10c7999dbeeacdfa87b2e6e015b59a76c6a37d33966f311ff');
 const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', projectRoot], {stdin: archive});
 expect(extracted.exitCode).toBe(0);
 const optionPath = 'evidence/interview/example-post-composition.json';
 const option = JSON.parse(await readFile(join(projectRoot, optionPath), 'utf8'));
 option.context = {kind: 'scene', scene: {n: 1, path: 'evidence/unsupported-scene.json', sha256: digest('{}')}};
 const optionBytes = JSON.stringify(option);
 await writeFile(join(projectRoot, optionPath), optionBytes);
 const project = JSON.parse(await readFile(join(projectRoot, 'project.json'), 'utf8'));
 project.interview = {post: {items: [{id: 'post_composition', pending_options: {path: optionPath, sha256: digest(optionBytes)}}]}};
 await writeFile(join(projectRoot, 'project.json'), JSON.stringify(project));
 const error = await openReview({input: join(projectRoot, 'derived/review/v2/out'),
  project: {root: projectRoot, version: 2, picksDir: 'reviewer-picks'}}, {stateDir: join(root, 'state'), direct: true})
  .then(() => null, error => error as Error);
  expect(error?.message).toBe('INTERVIEW_OPTIONS_STALE: example-post-composition');
});
