import {createHmac, randomUUID} from 'node:crypto';
import {lstat, mkdir, mkdtemp, rename, rm, unlink, writeFile} from 'node:fs/promises';
import type {Stats} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {appRoot} from './build.ts';
import {readOpenStatus, running, smallJson} from './open.ts';
import {canonicalStatePath} from './state-dir.ts';
import {capabilityPattern} from './open-protocol.ts';
import {WORKSPACE_BODY_LIMIT, WORKSPACE_SCHEMA, WORKSPACE_TARGETS_SCHEMA, WORKSPACE_TARGET_DOMAIN, WORKSPACE_TARGET_LIMIT,
  type WorkspaceDesignation, type WorkspaceRecord, type WorkspaceRegistry} from './open-workspace-contract.ts';

export function workspaceError(code: string): Error {return new Error(code);}

function assertPrivateInfo(info: Stats, directory: boolean) {
  if (!(directory ? info.isDirectory() : info.isFile()) || (info.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && info.uid !== process.getuid() || !directory && info.nlink !== 1) throw workspaceError('WORKSPACE_STATE_INVALID');
}

export async function assertPrivate(path: string, directory: boolean) {
  assertPrivateInfo(await lstat(path), directory);
}

export async function workspaceDirectory(stateDir: string) {
  const directory = join(canonicalStatePath(stateDir), 'owner-workspace');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await assertPrivate(directory, true);
  return directory;
}

export async function readPrivate(path: string): Promise<unknown | null> {
  try {
    const info = await lstat(path);
    // lstat can finish with nlink=0 during unlink. Establish that the path still
    // opens before validating that snapshot; a vanished path remains ENOENT.
    // On Linux the open can still reach that same detached inode (fstat nlink=0, #894):
    // no path names it any more, so it is absent too. A reappeared file still refuses.
    return await smallJson(path, opened => {
      if (info.nlink === 0 && opened.nlink === 0) throw Object.assign(new Error('detached'), {code: 'ENOENT'});
      assertPrivateInfo(info, false);
    });
  }
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw workspaceError('WORKSPACE_STATE_INVALID');}
}

export async function writePrivate(path: string, value: unknown, populate?: (temporary: string) => Promise<void>) {
  if (populate) {
    const temporary = await mkdtemp(path + '.tmp-');
    try {
      await populate(temporary);
      // A completed directory is nonempty, so a concurrent publisher wins intact.
      try {
        await lstat(path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(temporary, path).catch(error => {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      });
    } finally {await rm(temporary, {recursive: true, force: true});}
    return;
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > WORKSPACE_BODY_LIMIT) throw workspaceError('WORKSPACE_BODY_LIMIT');
  await readPrivate(path);
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, text, {flag: 'wx', mode: 0o600});
    await rename(temporary, path);
  } finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
}

export function targetCapability(ownerCapability: string, incarnation: string, key: string) {
  return createHmac('sha256', ownerCapability).update(WORKSPACE_TARGET_DOMAIN + '\0' + incarnation + '\0' + key).digest('hex');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workspaceError('WORKSPACE_REQUEST_INVALID');
  return value as Record<string, unknown>;
}

export function parseDesignation(value: unknown): WorkspaceDesignation {
  const row = object(value), inputs = object(row.inputs);
  if (Object.keys(row).some(key => !['key', 'contentHash', 'inputs', 'cwd', 'viewOnly'].includes(key)) ||
      !capabilityPattern.test(String(row.key)) || !capabilityPattern.test(String(row.contentHash)) ||
      typeof row.cwd !== 'string' || row.cwd.length > 4096 || !isAbsolute(row.cwd) || typeof row.viewOnly !== 'boolean') {
    throw workspaceError('WORKSPACE_REQUEST_INVALID');
  }
  const strings = ['input', 'compare', 'reference', 'animation', 'config', 'parts', 'source', 'full', 'head', 'keypoints'];
  let parsedInputs = inputs;
  for (const [key, item] of Object.entries(inputs)) {
    if (strings.includes(key)) {
      if (typeof item !== 'string' || !item || item.length > 4096) throw workspaceError('WORKSPACE_REQUEST_INVALID');
    } else if (key === 'control' || key === 'viewOnly') {
      if (typeof item !== 'boolean') throw workspaceError('WORKSPACE_REQUEST_INVALID');
    } else if (key === 'project') {
      const project = object(item);
      for (const [field, entry] of Object.entries(project)) {
        if (['root', 'picksDir', 'draftId', 'partsVerdictDir'].includes(field)) {
          if (typeof entry !== 'string' || !entry || entry.length > 4096) throw workspaceError('WORKSPACE_REQUEST_INVALID');
        } else if (field === 'version' || field === 'postVersion') {
          if (!Number.isSafeInteger(entry) || Number(entry) < 1) throw workspaceError('WORKSPACE_REQUEST_INVALID');
        } else throw workspaceError('WORKSPACE_REQUEST_INVALID');
      }
      if (typeof project.root !== 'string') throw workspaceError('WORKSPACE_REQUEST_INVALID');
      if (Object.hasOwn(project, 'picksDir')) {
        // Accept the legacy field on read and keep it out of canonical inputs.
        const {picksDir: _legacyPicksDir, ...designation} = project;
        parsedInputs = {...inputs, project: designation};
      }
    } else throw workspaceError('WORKSPACE_REQUEST_INVALID');
  }
  if (typeof inputs.input !== 'string' || !isAbsolute(inputs.input)) throw workspaceError('WORKSPACE_REQUEST_INVALID');
  return {...row, inputs: parsedInputs} as unknown as WorkspaceDesignation;
}

export function parseRegistry(value: unknown): WorkspaceRegistry {
  const row = object(value);
  if (row.schema !== WORKSPACE_TARGETS_SCHEMA || typeof row.incarnation !== 'string' || !Array.isArray(row.targets) ||
      row.targets.length > WORKSPACE_TARGET_LIMIT) throw workspaceError('WORKSPACE_STATE_INVALID');
  const seen = new Set<string>();
  const targets = Array.from(row.targets, entry => {
    const target = object(entry), designation = parseDesignation(target.designation);
    if (seen.has(designation.key) || target.controlToken !== undefined &&
        (typeof target.controlToken !== 'string' || !/^[a-f0-9-]{36}$/.test(target.controlToken))) throw workspaceError('WORKSPACE_STATE_INVALID');
    seen.add(designation.key);
    return {...target, designation};
  });
  return {...row, targets} as unknown as WorkspaceRegistry;
}

export function parseWorkspaceRecord(value: unknown): WorkspaceRecord {
  const row = object(value);
  let origin: URL;
  try {origin = new URL(String(row.origin));} catch {throw workspaceError('WORKSPACE_STATE_INVALID');}
  if (row.schema !== WORKSPACE_SCHEMA || !/^[a-f0-9-]{36}$/.test(String(row.incarnation)) ||
      !Number.isSafeInteger(row.pid) || Number(row.pid) < 1 || !Number.isSafeInteger(row.uid) ||
      typeof row.installation !== 'string' || !isAbsolute(row.installation) || typeof row.runtime !== 'string' ||
      !capabilityPattern.test(String(row.fingerprint)) || !capabilityPattern.test(String(row.registrationCapability)) ||
      !capabilityPattern.test(String(row.ownerCapability)) || origin.origin !== row.origin ||
      origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port) throw workspaceError('WORKSPACE_STATE_INVALID');
  return row as unknown as WorkspaceRecord;
}

/** A live but silent PID remains owned. A timeout never authorizes replacement. */
export async function probeWorkspace(directory: string, fingerprint: string, port?: number): Promise<WorkspaceRecord | null> {
  await assertPrivate(directory, true);
  const value = await readPrivate(join(directory, 'host.json'));
  if (value === null) return null;
  const record = parseWorkspaceRecord(value);
  if (record.uid !== (process.getuid?.() ?? 0)) throw workspaceError('WORKSPACE_OWNER_MISMATCH');
  if (!running(record.pid)) return null;
  if (record.fingerprint !== fingerprint || record.installation !== appRoot || record.runtime !== Bun.version ||
      port !== undefined && new URL(record.origin).port !== String(port)) throw workspaceError('WORKSPACE_HOST_MISMATCH');
  const response = await fetch(record.origin + '/workspace/api/status', {
    headers: {Authorization: 'Bearer ' + record.registrationCapability}, redirect: 'error', signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (!response?.ok) {void response?.body?.cancel(); throw workspaceError('WORKSPACE_HOST_UNRESPONSIVE');}
  const status = object(await readOpenStatus(response));
  if (status.schema !== WORKSPACE_SCHEMA || status.incarnation !== record.incarnation || status.pid !== record.pid ||
      status.fingerprint !== fingerprint || status.runtime !== record.runtime) throw workspaceError('WORKSPACE_HOST_MISMATCH');
  return record;
}
