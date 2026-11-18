import {expect, test} from 'bun:test';
import {chmod, link, lstat, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertPrivate, readPrivate, writePrivate} from '../src/open-workspace-state.ts';

test('readPrivate returns absent for the detached inode observed during host.json shutdown', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/open-workspace-state-race.ts')],
    {stdout: 'pipe', stderr: 'pipe'});
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(),
    new Response(child.stderr).text(), child.exited]);
  console.log(output);
  expect(error).toBe('');
  expect(exit).toBe(0);
  expect(output).toContain('"nlink":0');
  expect(output).toContain('shutdown-read: null');
});

test('readPrivate still rejects nlink=0 when host.json has reappeared', async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'helpers/open-workspace-state-race.ts'), '--replacement'],
    {stdout: 'pipe', stderr: 'pipe'});
  const [output, error, exit] = await Promise.all([new Response(child.stdout).text(),
    new Response(child.stderr).text(), child.exited]);
  expect(error).toBe('');
  expect(exit).toBe(0);
  expect(output).toContain('replacement-read: WORKSPACE_STATE_INVALID');
});

test('private state retains regular-file, mode, uid, link, JSON and size refusals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-private-checks-'));
  const path = join(root, 'host.json');
  try {
    expect(await readPrivate(path)).toBeNull();
    await writePrivate(path, {ok: true});
    expect(await readPrivate(path)).toEqual({ok: true});
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const getuid = process.getuid;
    if (getuid) {
      process.getuid = () => getuid() + 1;
      try {await expect(readPrivate(path)).rejects.toThrow('WORKSPACE_STATE_INVALID');}
      finally {process.getuid = getuid;}
    }
    await chmod(path, 0o644);
    await expect(readPrivate(path)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await chmod(path, 0o600);
    const hardlink = join(root, 'alias.json'); await link(path, hardlink);
    await expect(readPrivate(path)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await rm(hardlink);
    await symlink(path, join(root, 'symlink.json'));
    await expect(readPrivate(join(root, 'symlink.json'))).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await expect(readPrivate(root)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await expect(assertPrivate(path, true)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await writeFile(path, 'invalid JSON');
    await expect(readPrivate(path)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await writeFile(path, JSON.stringify('x'.repeat(65536)));
    await expect(readPrivate(path)).rejects.toThrow('WORKSPACE_STATE_INVALID');
    await expect(writePrivate(path, 'x'.repeat(65536))).rejects.toThrow('WORKSPACE_BODY_LIMIT');
  } finally {await rm(root, {recursive: true, force: true});}
});
