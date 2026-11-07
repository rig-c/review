import {dirname, join} from 'node:path';
import {realpath, unlink} from 'node:fs/promises';
import {startOpenWorkspace} from './open-workspace.ts';
import {openFingerprint} from './open.ts';
import {readPrivate, workspaceDirectory, workspaceError} from './open-workspace-state.ts';
import {WORKSPACE_SCHEMA} from './open-workspace-contract.ts';

async function main(path: string) {
  const value = await readPrivate(path) as {schema?: unknown; stateDir?: unknown; fingerprint?: unknown;
    port?: unknown; idleMs?: unknown; graceMs?: unknown} | null;
  if (!value || value.schema !== WORKSPACE_SCHEMA || typeof value.stateDir !== 'string' ||
      value.fingerprint !== await openFingerprint() || !Number.isSafeInteger(value.port) ||
      Number(value.port) < 1 || Number(value.port) > 65535 ||
      [value.idleMs, value.graceMs].some(item => item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 100))) {
    throw workspaceError('WORKSPACE_REQUEST_INVALID');
  }
  const directory = await workspaceDirectory(value.stateDir);
  if (dirname(await realpath(path)) !== directory) throw workspaceError('WORKSPACE_STATE_INVALID');
  await unlink(path).catch(error => {if (error.code !== 'ENOENT') throw error;});
  const host = await startOpenWorkspace({stateDir: value.stateDir, fingerprint: String(value.fingerprint),
    port: Number(value.port), idleMs: value.idleMs as number | undefined, graceMs: value.graceMs as number | undefined});
  const stop = () => {void host.stop().then(() => process.exit(0));};
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  void host.live.exited.then(info => {if (info) process.exit(0);});
}

if (import.meta.main) main(Bun.argv[2] ?? join(process.cwd(), 'missing.request')).catch(error => {
  const message = error instanceof Error ? error.message : '';
  const occupied = /^FRONT_PORT_BUSY: 127\.0\.0\.1:[1-9]\d{0,4} is held by another listener; use --direct \(or set RIG_REVIEW_FRONT_PORT\)$/.test(message);
  const safeCodes = ['WORKSPACE_REQUEST_INVALID', 'WORKSPACE_STATE_INVALID', 'WORKSPACE_BODY_LIMIT', 'WORKSPACE_START_REFUSED'];
  console.error(occupied || safeCodes.includes(message) ? message : 'WORKSPACE_START_REFUSED');
  process.exitCode = 1;
});
