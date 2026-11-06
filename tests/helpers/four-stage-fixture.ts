import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, literalPath } from '../../src/interview-project.ts';

export const createCommit = 'a1a5162cf4ce7fdef8caba50dc3979cf416467dd';
export const createArchiveSha = '68034a42a70765ddda434195b945c9d87da85cf86443c657c31848ee163a8096';
const archiveRoot = 'rig-c-create-a1a5162';
const names = ['1-parts-verdict', '2-rigging-answers', '3-rig-review', '4-direction-post'] as const;
const counts = [38, 41, 89, 92];
const steps = [30, 37, 59, 80];
const sidecarHashes = [
  'bef9ed3fba1fded9d41a1c7324755a0f43431af7497b2ad16fc0608efc55fe21',
  '6b1c9db9e7666145b166e7410c65b2bd454afb81854160cd181c77bf62a0a676',
  'a77bb4596fe92a8711985da73bd385c29ec0a43a721d0463ead96285bff79c7c',
  'c69338567e26f47252f47ce45879c7354958058194073e1621b7a60dc3f63d57',
];
type FileBinding = {path: string; sha256: string};
type Sidecar = {
  schema: string; stage: number; name: string; chain_step: number;
  files: FileBinding[]; project_sha256: string;
  pending: {commands: string[]; command_roles: string[]};
};
export async function inventory(root: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  const entries = await readdir(join(root, prefix), {withFileTypes: true});
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = prefix + entry.name;
    assert(literalPath(path), path);
    if (entry.isDirectory()) Object.assign(result, await inventory(root, path + '/'));
    else {
      assert(entry.isFile(), `CHECKPOINT_NOT_REGULAR: ${path}`);
      result[path] = digest(await readFile(join(root, path)));
    }
  }
  return result;
}

export function verifyArchive(bytes: Buffer) {
  assert.equal(digest(bytes), createArchiveSha, 'CREATE_ARCHIVE_SHA');
}

export async function materializeFourStages(archive: string, destination: string) {
  const bytes = await readFile(archive);
  verifyArchive(bytes);
  await mkdir(destination);
  const extracted = Bun.spawnSync(['tar', '-xzf', '-', '-C', destination], {stdin: bytes});
  assert.equal(extracted.exitCode, 0, extracted.stderr.toString());
  const create = join(destination, archiveRoot);
  const checkpoints = join(create, 'templates/example-chain/checkpoints');
  const stages = await Promise.all(names.map(async (name, index) => {
    const sidecar = await readFile(join(checkpoints, name + '.json'));
    assert.equal(digest(sidecar), sidecarHashes[index], 'CHECKPOINT_SIDECAR_SHA');
    const declared = JSON.parse(sidecar.toString()) as Sidecar;
    assert.equal(declared.schema, 'rig-create/example-checkpoint@1');
    assert.deepEqual([declared.name, declared.stage, declared.chain_step], [name, index + 1, steps[index]]);
    assert.equal(declared.pending.commands.length, declared.pending.command_roles.length);
    const root = join(checkpoints, name);
    const original = await inventory(root);
    assert.equal(declared.files.length, counts[index]);
    assert.equal(Object.keys(original).length, counts[index]);
    assert.equal(new Set(declared.files.map(file => file.path)).size, counts[index]);
    for (const file of declared.files) assert.equal(original[file.path], file.sha256, file.path);
    assert.equal(original['project.json'], declared.project_sha256);
    return {name, declared, original, async copy(to: string) {
      await cp(root, to, {recursive: true, force: false, errorOnExist: true});
      assert.deepEqual(await inventory(to), original);
    }, async assertOriginal() { assert.deepEqual(await inventory(root), original); }};
  }));
  return {create, stages};
}
