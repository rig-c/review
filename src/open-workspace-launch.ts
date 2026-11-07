import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {open, readFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {appRoot} from './build.ts';
import {frontPort} from './front.ts';
import {acquireClaim, defaultStateDir, openFingerprint, prepareOpenTarget, readOpenStatus, releaseClaim,
  type OpenInputs, type OpenOptions} from './open.ts';
import {canonicalStatePath} from './state-dir.ts';
import {assertPrivate, parseRegistry, probeWorkspace, readPrivate, targetCapability, workspaceDirectory, workspaceError, writePrivate} from './open-workspace-state.ts';
import {WORKSPACE_BODY_LIMIT, WORKSPACE_SCHEMA, type WorkspaceDesignation, type WorkspaceRecord} from './open-workspace-contract.ts';

async function register(record: WorkspaceRecord, targets: WorkspaceDesignation[]) {
  const text = JSON.stringify({schema: WORKSPACE_SCHEMA, incarnation: record.incarnation, targets});
  if (Buffer.byteLength(text) > WORKSPACE_BODY_LIMIT) throw workspaceError('WORKSPACE_BODY_LIMIT');
  const response = await fetch(record.origin + '/workspace/api/register', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + record.registrationCapability}, body: text,
  });
  const value = await readOpenStatus(response, 20_000) as {error?: string; schema?: string; incarnation?: string};
  if (!response.ok) throw workspaceError(value.error?.startsWith('WORKSPACE_') ? value.error : 'WORKSPACE_REGISTRATION_REFUSED');
  if (value.schema !== WORKSPACE_SCHEMA || value.incarnation !== record.incarnation) throw workspaceError('WORKSPACE_HOST_MISMATCH');
}

/** Launchers exchange designated package data, never callbacks or human acts. */
export async function openWorkspace(inputs: readonly OpenInputs[], options: OpenOptions & {foreground?: boolean} = {}) {
  const fingerprint = await openFingerprint();
  const prepared = [];
  for (const input of inputs) prepared.push(await prepareOpenTarget(input, options, fingerprint));
  if (!prepared.length || inputs.some(input => input.direct)) throw workspaceError('WORKSPACE_REQUEST_INVALID');
  const stateDir = canonicalStatePath(options.stateDir ?? defaultStateDir());
  const designations: WorkspaceDesignation[] = prepared.map(target => ({key: target.key,
    contentHash: target.package.contentHash, cwd: target.cwd, viewOnly: target.viewOnly,
    inputs: {...target.package.inputs, viewOnly: target.viewOnly}}));
  if (Buffer.byteLength(JSON.stringify(designations)) > WORKSPACE_BODY_LIMIT - 256) throw workspaceError('WORKSPACE_BODY_LIMIT');
  const directory = await workspaceDirectory(stateDir), port = frontPort(options.frontPort);
  const nonce = randomUUID();
  const reuse = () => probeWorkspace(directory, fingerprint, port);
  const ready = await reuse();
  const acquired = ready ? {row: ready} : await acquireClaim(directory, 'host', nonce, reuse,
    performance.now() + 20_000, 'WORKSPACE_START_BUSY');
  let child: ReturnType<typeof spawn> | undefined, handedOff = false, request: string | undefined;
  let owner: Awaited<ReturnType<typeof import('./open-workspace.ts').startOpenWorkspace>> | undefined;
  let interrupted = false;
  const stopOwner = () => {interrupted = true; void owner!.stop().catch(() => {});};
  const detach = () => {process.removeListener('SIGINT', stopOwner); process.removeListener('SIGTERM', stopOwner);};
  try {
    let record: WorkspaceRecord;
    const reused = 'row' in acquired;
    if ('row' in acquired) record = acquired.row;
    else if (options.foreground) {
      const {startOpenWorkspace} = await import('./open-workspace.ts');
      owner = await startOpenWorkspace({stateDir, fingerprint, port, idleMs: options.idleMs, graceMs: options.graceMs});
      process.once('SIGINT', stopOwner); process.once('SIGTERM', stopOwner);
      record = owner.record;
    } else {
      request = join(directory, nonce + '.request.json');
      await writePrivate(request, {schema: WORKSPACE_SCHEMA, stateDir, fingerprint, port,
        ...(options.idleMs !== undefined ? {idleMs: options.idleMs} : {}),
        ...(options.graceMs !== undefined ? {graceMs: options.graceMs} : {})});
      const logPath = join(directory, nonce + '.log');
      const log = await open(logPath, 'a', 0o600);
      try {
        child = spawn(process.execPath, [join(appRoot, 'src/open-workspace-worker.ts'), request],
          {cwd: directory, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env});
        child.unref();
      } finally {await log.close();}
      let failure = false;
      child.on('error', () => {failure = true;});
      child.on('exit', () => {failure = true;});
      const deadline = performance.now() + 20_000;
      for (;;) {
        const current = await reuse();
        if (current) {record = current; break;}
        if (failure) {
          const diagnostic = (await readFile(logPath, 'utf8')).trim();
          const occupied = `FRONT_PORT_BUSY: 127.0.0.1:${port} is held by another listener; use --direct (or set RIG_REVIEW_FRONT_PORT)`;
          const safeCodes = ['WORKSPACE_REQUEST_INVALID', 'WORKSPACE_STATE_INVALID', 'WORKSPACE_BODY_LIMIT', 'WORKSPACE_START_REFUSED'];
          throw workspaceError(diagnostic === occupied || safeCodes.includes(diagnostic) ? diagnostic : 'WORKSPACE_START_REFUSED');
        }
        if (performance.now() >= deadline) throw workspaceError('WORKSPACE_START_TIMEOUT');
        await Bun.sleep(30);
      }
    }
    try {await register(record, designations);}
    catch (error) {if (!interrupted) throw error;}
    handedOff = true;
    const waitForExit = owner ? async () => {
      try {await owner!.live.exited; await owner!.stop();}
      finally {detach();}
    } : undefined;
    return {url: record.origin + '/?workspace=' + record.incarnation + '#cap=' + record.ownerCapability,
      reused, prepared, interrupted, waitForExit};
  } catch (error) {
    if (owner) {detach(); await owner.stop().catch(() => {});}
    throw error;
  } finally {
    if (child && !handedOff && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if ('claim' in acquired) await releaseClaim(acquired.claim, nonce);
    if (request) await unlink(request).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
}

/** Trusted control CLI resolves only its exact opted-in target after authenticating the live workspace. */
export async function workspaceControlLocator(stateDir: string, key: string) {
  const directory = join(canonicalStatePath(stateDir), 'owner-workspace');
  try {await assertPrivate(directory, true);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
  const value = await readPrivate(join(directory, 'host.json'));
  if (!value) return null;
  const record = await probeWorkspace(directory, await openFingerprint());
  if (!record) return null;
  const registry = await readPrivate(join(directory, 'targets.json'));
  if (!registry) throw workspaceError('WORKSPACE_STATE_INVALID');
  const stored = parseRegistry(registry);
  if (stored.incarnation !== record.incarnation) throw workspaceError('WORKSPACE_HOST_MISMATCH');
  const target = stored.targets.find(target => target.designation.key === key);
  if (!target?.controlToken) return null;
  return {origin: record.origin, prefix: '/instances/' + key, controlToken: target.controlToken,
    capability: targetCapability(record.ownerCapability, record.incarnation, key)};
}
