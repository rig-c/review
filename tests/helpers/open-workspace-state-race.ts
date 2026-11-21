/** Isolated syscall schedule: hold the inode through the host's real shutdown unlink. */
import {mock} from 'bun:test';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const native = {...fs};
const root = await native.mkdtemp(join(tmpdir(), 'review-private-shutdown-'));
const stateDir = join(root, 'state'), path = join(stateDir, 'owner-workspace/host.json');
let shutdown: (() => Promise<void>) | undefined;
let planted = false;
let pinned: Awaited<ReturnType<typeof native.open>> | undefined;
// --detached-open: Linux path lookup can still find the dentry while unlink has already
// dropped nlink to 0 (measured on Nova, #894). Hand smallJson's open a descriptor held on
// that same real inode, so open succeeds after lstat reported the detached snapshot.
let held: Awaited<ReturnType<typeof native.open>> | undefined;
mock.module('node:fs/promises', () => ({...native, open: async (...args: Parameters<typeof fs.open>) => {
  if (args[0] === path && planted && held) {const handle = held; held = undefined; return handle;}
  return native.open(...args);
}, lstat: async (...args: Parameters<typeof fs.lstat>) => {
  if (args[0] === path && shutdown) {
    const stop = shutdown; shutdown = undefined;
    // Model lstat's inode lookup before unlink and its metadata result after unlink.
    // No fabricated Stats: fstat reads the same pinned inode after real host.stop().
    await stop();
    const info = await pinned!.stat();
    console.log(JSON.stringify({step: 'shutdown-unlink-before-stat-result', nlink: info.nlink,
      mode: info.mode & 0o777, uid: info.uid, regular: info.isFile(), size: info.size}));
    if (info.nlink !== 0) throw new Error('shutdown did not detach the pinned inode');
    if (Bun.argv.includes('--replacement')) await native.writeFile(path, '{"replacement":true}', {mode: 0o600});
    planted = true;
    return info;
  }
  return native.lstat(...args);
}}));
const {startOpenWorkspace} = await import('../../src/open-workspace.ts');
const {readPrivate} = await import('../../src/open-workspace-state.ts');
let host: Awaited<ReturnType<typeof startOpenWorkspace>> | undefined;
try {
  host = await startOpenWorkspace({stateDir, fingerprint: 'a'.repeat(64), port: 0});
  pinned = await native.open(path, 'r');
  if (Bun.argv.includes('--detached-open')) held = await native.open(path, 'r');
  shutdown = host.stop;
  if (Bun.argv.includes('--replacement')) {
    try {await readPrivate(path); throw new Error('invalid snapshot was accepted');}
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'WORKSPACE_STATE_INVALID' || !planted) throw error;
      console.log('replacement-read: WORKSPACE_STATE_INVALID');
    }
    process.exitCode = 0;
  } else {
  const value = await readPrivate(path);
  if (!planted || value !== null) throw new Error('detached descriptor was not absent');
  if (Bun.argv.includes('--detached-open') && held) throw new Error('detached open was not exercised');
  console.log('shutdown-read: null');
  }
} finally {
  shutdown = undefined;
  await pinned?.close();
  await host?.stop();
  await native.rm(root, {recursive: true, force: true});
}
