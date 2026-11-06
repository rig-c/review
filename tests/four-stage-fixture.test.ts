import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, verifyArchive } from './helpers/four-stage-fixture.ts';

test('four-stage materializer refuses unpinned archive before extraction', () => {
  expect(() => verifyArchive(Buffer.from('untrusted archive'))).toThrow('CREATE_ARCHIVE_SHA');
});

test('four-stage inventory reports changed bytes and refuses a linked input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'four-stage-inventory-'));
  try {
    await mkdir(join(root, 'evidence'));
    const file = join(root, 'evidence/input.json');
    await writeFile(file, '{}');
    const before = await inventory(root);
    await writeFile(file, '[]');
    expect((await inventory(root))['evidence/input.json']).not.toBe(before['evidence/input.json']);
    await symlink(file, join(root, 'linked.json'));
    await expect(inventory(root)).rejects.toThrow('CHECKPOINT_NOT_REGULAR');
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
