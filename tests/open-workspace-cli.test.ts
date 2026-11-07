import {expect, test} from 'bun:test';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseWorkspaceRecord, readPrivate, workspaceDirectory, writePrivate} from '../src/open-workspace-state.ts';
import {openFingerprint} from '../src/open.ts';
import {WORKSPACE_SCHEMA} from '../src/open-workspace-contract.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import type {WorkspaceRecord} from '../src/open-workspace-contract.ts';

async function proveWorkspaceLaunch(mode: 'batch' | 'sequential') {
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), 'review-workspace-cli-'));
  const stateDir = join(root, 'state');
  const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
  const port = probe.port!; await probe.stop(true);
  const inputs: string[] = [];
  const children: Bun.Subprocess[] = [];
  const returnedURLs: string[] = [];
  let record: WorkspaceRecord | undefined;
  async function run(args: string[]) {
    const child = Bun.spawn([process.execPath, 'src/entry.ts', ...args], {stdout: 'pipe', stderr: 'pipe',
      env: {...process.env, RIG_REVIEW_STATE_DIR: stateDir, RIG_REVIEW_FRONT_PORT: String(port)}});
    children.push(child);
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain('#cap=');
    const url = new URL(stdout.trim());
    expect(url.origin).toBe(`http://127.0.0.1:${port}`);
    expect(url.pathname).toBe('/');
    returnedURLs.push(url.href);
    return url.href;
  }
  try {
    for (let index = 0; index < 9; index++) {
      const input = join(root, 'synthetic-' + (index + 1));
      await mkdir(input);
      await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(input, 'build'), {recursive: true});
      await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(input, 'motion.json'));
      if (index === 8 || mode === 'sequential') {
        const path = join(input, 'build/skeleton.model.json');
        const model = JSON.parse(await readFile(path, 'utf8'));
        if (mode === 'sequential') {
          model.animations[0].name = 'synthetic-animation-' + (index + 1);
          model.editorOrder.animations[0] = model.animations[0].name;
        } else {
          model.animations.push({...model.animations[0], name: 'alternate'});
          model.editorOrder.animations.push('alternate');
        }
        await writeFile(path, JSON.stringify(model));
      }
      inputs.push(input);
    }
    const before = await Promise.all(inputs.map(jobInputHashes));
    const first = mode === 'batch'
      ? await run(['open', ...inputs, '--animation', 'inspect', '--animation-for', '9', 'alternate', '--view-only'])
      : await run(['open', inputs[0]!, '--animation', 'synthetic-animation-1', '--view-only']);
    record = parseWorkspaceRecord(await readPrivate(join(stateDir, 'owner-workspace/host.json')));
    expect(first).toBe(record.origin + '/#cap=' + record.ownerCapability);
    if (mode === 'batch') {
      expect(await run(['open', inputs[8]!, '--animation', 'alternate', '--view-only'])).toBe(first);
      const repeated = await Promise.all(inputs.slice(0, 3).map(input => run(['open', input, '--animation', 'inspect', '--view-only'])));
      expect(repeated.every(value => value === first)).toBe(true);
    } else {
      for (let index = 1; index < inputs.length; index++) {
        expect(await run(['open', inputs[index]!, '--animation', 'synthetic-animation-' + (index + 1), '--view-only'])).toBe(first);
      }
    }
    const response = await fetch(record.origin + '/workspace/api/targets', {headers: {'X-Review-Capability': record.ownerCapability}});
    const list = await response.json();
    expect(list.targets).toHaveLength(9);
    if (mode === 'batch') expect(list.targets[8].animation).toBe('alternate');
    else expect(list.targets.map((target: {animation: string}) => target.animation))
      .toEqual(inputs.map((_, index) => 'synthetic-animation-' + (index + 1)));
    expect(list.targets.every((target: {viewOnly: boolean}) => target.viewOnly)).toBe(true);
    expect(new Set(returnedURLs).size).toBe(1);
    const available = Bun.spawnSync([Bun.which('lsof') ?? '/usr/sbin/lsof', '-nP', '-a', '-p', String(record.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
    expect(available.exitCode).toBe(0);
    const listeners = available.stdout.toString().split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
    expect(listeners).toEqual([`127.0.0.1:${port}`]);
    const processList = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']);
    expect(processList.exitCode).toBe(0);
    const resident = processList.stdout.toString().split('\n').filter(line => line.includes(stateDir));
    expect(resident).toHaveLength(1);
    expect(resident[0]).toContain('open-workspace-worker.ts');
    expect(await Promise.all(inputs.map(jobInputHashes))).toEqual(before);
    console.log(JSON.stringify({proof: mode === 'batch' ? 'normal-nine-target-workspace' : 'normal-nine-sequential-workspace', runtime: Bun.version, elapsedMs: Math.round(performance.now() - started),
      targets: list.targets.length, residentBackendProcesses: resident.length, ownerPid: record.pid,
      listeners, ownerURLWithoutCapability: record.origin + '/', repeatedOwnerURLEqual: true,
      launcherExits: children.map(child => child.exitCode), uniqueOwnerURLs: new Set(returnedURLs).size, inputHashesUnchanged: true}));
  } finally {
    for (const child of children) if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}
    if (!record) {
      const value = await readPrivate(join(stateDir, 'owner-workspace/host.json'));
      if (value) record = parseWorkspaceRecord(value);
    }
    if (record) {
      try {process.kill(record.pid, 'SIGTERM');}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline && await readPrivate(join(stateDir, 'owner-workspace/host.json'))) await Bun.sleep(25);
      expect(await readPrivate(join(stateDir, 'owner-workspace/host.json'))).toBeNull();
      const reachable = await fetch(record.origin, {signal: AbortSignal.timeout(500)}).then(async response => {await response.body?.cancel(); return true;}, () => false);
      expect(reachable).toBe(false);
      console.log(JSON.stringify({proof: 'workspace-cleanup', ownerDescriptorRemoved: true, listenerReachable: reachable}));
    }
    await rm(root, {recursive: true, force: true});
  }
}

test('normal CLI opens nine targets in one resident host/listener and repeated/concurrent launchers return the same owner URL',
  () => proveWorkspaceLaunch('batch'), 60000);

test('fresh workspace accepts nine sequential single-target CLI opens with distinct animations and one owner URL',
  () => proveWorkspaceLaunch('sequential'), 60000);

test('worker request cleanup tolerates a competing ENOENT, propagates other errors and redacts private details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-workspace-unlink-'));
  const source = await readFile(new URL('../src/open-workspace-worker.ts', import.meta.url), 'utf8');
  const children: Bun.Subprocess[] = [];
  try {
    for (const code of ['ENOENT', 'EACCES']) {
      const stateDir = join(root, code), directory = await workspaceDirectory(stateDir);
      const request = join(directory, 'synthetic.request.json');
      const probe = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
      const port = probe.port!; await probe.stop(true);
      await writePrivate(request, {schema: WORKSPACE_SCHEMA, stateDir, port, fingerprint: await openFingerprint()});
      const shim = join(root, code + '-unlink.ts'), worker = join(root, code + '-worker.ts');
      await writeFile(shim, `import {unlink as remove} from 'node:fs/promises';
export async function unlink(path: string) {
  await remove(path);
  ${code === 'ENOENT' ? 'return remove(path);' : "throw Object.assign(new Error('private startup detail #cap=synthetic-secret'), {code: 'EACCES'});"}
}
`);
      const imported = source.replace(/from '(\.\/[^']+)'/g, (_whole, path: string) =>
        'from ' + JSON.stringify(new URL('../src/' + path.slice(2), import.meta.url).href));
      const copied = imported.replace("import {realpath, unlink} from 'node:fs/promises';",
        "import {realpath} from 'node:fs/promises';\nimport {unlink} from " + JSON.stringify(shim) + ';');
      expect(copied).not.toBe(imported);
      await writeFile(worker, copied);
      const child = Bun.spawn([process.execPath, worker, request], {stdout: 'pipe', stderr: 'pipe'});
      children.push(child);
      if (code === 'ENOENT') {
        const deadline = performance.now() + 5000;
        let value: unknown = null;
        while (performance.now() < deadline && !(value = await readPrivate(join(directory, 'host.json')))) await Bun.sleep(10);
        expect(parseWorkspaceRecord(value).pid).toBe(child.pid);
        child.kill('SIGTERM');
      }
      const exit = await Promise.race([
        child.exited,
        Bun.sleep(5000).then(() => {throw new Error('worker did not exit autonomously within control timeout');}),
      ]);
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(stdout).toBe('');
      expect(stderr).not.toContain('synthetic-secret');
      expect(stderr).not.toContain('private startup detail');
      if (code === 'ENOENT') {
        expect(exit).toBe(0); expect(stderr).toBe('');
        expect(await readPrivate(join(directory, 'host.json'))).toBeNull();
      } else {
        expect(exit).not.toBe(0); expect(stderr).toBe('WORKSPACE_START_REFUSED\n');
      }
      expect(await readPrivate(join(directory, 'host.json'))).toBeNull();
      const reachable = await fetch('http://127.0.0.1:' + port, {signal: AbortSignal.timeout(500)})
        .then(async response => {await response.body?.cancel(); return true;}, () => false);
      expect(reachable).toBe(false);
    }
  } finally {
    for (const child of children) if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}
    await rm(root, {recursive: true, force: true});
  }
}, 15000);
