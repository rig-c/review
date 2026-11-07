import {expect, test} from 'bun:test';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openWorkspace} from '../src/open-workspace-launch.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';

async function fixture() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'review-foreground-'));
  const state = join(root, 'state'), inputs: string[] = [], children: Bun.Subprocess[] = [];
  const allocation = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
  const port = allocation.port!; await allocation.stop(true);
  for (let index = 0; index < 10; index++) {
    const input = join(root, 'synthetic-' + (index + 1)); await mkdir(input);
    await cp(join(import.meta.dir, 'fixtures/strip-probe/build'), join(input, 'build'), {recursive: true});
    await cp(join(import.meta.dir, 'fixtures/strip-probe/motion.json'), join(input, 'motion.json'));
    const path = join(input, 'build/skeleton.model.json'), model = JSON.parse(await readFile(path, 'utf8'));
    model.animations[0].name = 'animation-' + (index + 1); model.editorOrder.animations[0] = model.animations[0].name;
    await writeFile(path, JSON.stringify(model)); inputs.push(input);
  }
  const before = await Promise.all(inputs.map(jobInputHashes));
  function spawn(args: string[]) {
    const child = Bun.spawn([process.execPath, 'src/entry.ts', ...args], {stdout: 'pipe', stderr: 'pipe',
      env: {...process.env, RIG_REVIEW_STATE_DIR: state, RIG_REVIEW_FRONT_PORT: String(port)}});
    children.push(child); return child;
  }
  async function run(args: string[]) {
    const child = spawn(args);
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return {stdout, stderr, exit};
  }
  const args = [...inputs.slice(0, 9), '--animation', 'animation-1', '--control', '--view-only', '--port', String(port)];
  for (let index = 1; index < 9; index++) args.push('--animation-for', String(index + 1), 'animation-' + (index + 1));
  async function descriptor() {return JSON.parse(await readFile(join(state, 'owner-workspace/host.json'), 'utf8'));}
  async function list(url: URL) {
    const response = await fetch(url.origin + '/workspace/api/targets', {headers: {'X-Review-Capability': url.hash.slice(5)}});
    expect(response.status).toBe(200); return response.json();
  }
  async function inventory(pid: number) {
    const ps = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']); expect(ps.exitCode).toBe(0);
    const resident = ps.stdout.toString().split('\n').filter(line => line.includes(root) && /src\/(?:entry|open-workspace-worker)\.ts/.test(line));
    expect(resident).toHaveLength(1);
    const sockets = Bun.spawnSync([Bun.which('lsof') ?? '/usr/sbin/lsof', '-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
    expect(sockets.exitCode).toBe(0);
    expect(sockets.stdout.toString().split('\n').filter(line => line.startsWith('n'))).toEqual(['n127.0.0.1:' + port]);
  }
  async function close() {
    for (const child of children) if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}
    try {
      const host = await descriptor();
      try {process.kill(host.pid, 'SIGTERM');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && await Bun.file(join(state, 'owner-workspace/host.json')).exists()) await Bun.sleep(25);
      expect(await Bun.file(join(state, 'owner-workspace/host.json')).exists()).toBe(false);
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    expect(await Promise.all(inputs.map(jobInputHashes))).toEqual(before);
    await rm(root, {recursive: true, force: true});
  }
  return {root, state, port, inputs, children, args, spawn, run, list, descriptor, inventory, close};
}
async function ready(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>) {
  const reader = child.stdout.getReader(), decoder = new TextDecoder(); let output = '';
  const errors = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
  try {
    while (!/Review ready: (\S+)/.test(output)) {
      const {value, done} = await reader.read(); if (done) throw new Error('FOREGROUND_START: ' + await errors);
      output += decoder.decode(value);
    }
    const url = new URL(/Review ready: (\S+)/.exec(output)![1]!);
    const drained = (async () => {
      try {
        while (true) {
          const {value, done} = await reader.read();
          if (done) break;
          output += decoder.decode(value, {stream: true});
        }
        output += decoder.decode();
        return {output, error: undefined};
      } catch (error) {
        return {output, error};
      } finally {reader.releaseLock();}
    })();
    return {url, errors, drained};
  } finally {clearTimeout(timer);}
}

test('nine-target foreground creator owns one listener; bare/open joiners cannot stop it and control stays source-bound', async () => {
  const f = await fixture();
  try {
    const child = f.spawn(f.args), opened = await ready(child);
    expect(child.exitCode).toBeNull(); const host = await f.descriptor(); expect(host.pid).toBe(child.pid);
    let list = await f.list(opened.url); expect(list.targets).toHaveLength(9);
    expect(list.targets.map((target: any) => target.animation)).toEqual(f.inputs.slice(0, 9).map((_, index) => 'animation-' + (index + 1)));
    expect(list.targets.every((target: any) => target.viewOnly && !('act' in target))).toBe(true);
    const joined = await f.run([f.inputs[0]!, f.inputs[1]!, '--animation', 'animation-1', '--animation-for', '2', 'animation-2', '--control', '--view-only']);
    expect(joined.exit).toBe(0); expect(joined.stdout.trim()).toBe(opened.url.href); expect(child.exitCode).toBeNull();
    const appended = await f.run(['open', f.inputs[9]!, '--animation', 'animation-10', '--view-only']);
    expect(appended.exit).toBe(0); expect(appended.stdout.trim()).toBe(opened.url.href);
    list = await f.list(opened.url); expect(list.targets).toHaveLength(10);
    const control = await f.run(['control', f.inputs[0]!, '--animation', 'animation-1']);
    expect(control.exit).toBe(0); expect(JSON.parse(control.stdout).instanceKey).toBe(list.targets[0].key);
    const refused = await f.run([f.inputs[0]!, f.inputs[1]!, '--animation', 'absent', '--view-only']);
    expect(refused.exit).not.toBe(0); expect((await f.list(opened.url)).targets).toHaveLength(10);
    await f.inventory(host.pid);
    console.log(JSON.stringify({proof: 'foreground-nine', creatorPid: host.pid, residentBackendProcesses: 1, listeners: 1,
      initialTargets: 9, targetsAfterOpen: 10, joinerExits: [joined.exit, appended.exit], sameOwnerURL: true}));
    child.kill('SIGINT'); expect(await child.exited).toBe(0);
    expect((await opened.drained).error).toBeUndefined(); expect(await opened.errors).not.toContain('#cap=');
    expect(await Bun.file(join(f.state, 'owner-workspace/host.json')).exists()).toBe(false);
  } finally {await f.close();}
}, 30000);

test('foreground multi joins a background owner without acquiring stop ownership', async () => {
  const f = await fixture();
  try {
    const first = await f.run(['open', f.inputs[0]!, '--animation', 'animation-1', '--view-only']); expect(first.exit).toBe(0);
    const owner = new URL(first.stdout.trim()), host = await f.descriptor();
    const joined = await f.run([f.inputs[0]!, f.inputs[1]!, '--animation', 'animation-1', '--animation-for', '2', 'animation-2', '--view-only']);
    expect(joined.exit).toBe(0); expect(joined.stdout.trim()).toBe(owner.href);
    expect((await f.list(owner)).targets).toHaveLength(2); expect((await f.descriptor()).pid).toBe(host.pid);
    await f.inventory(host.pid);
  } finally {await f.close();}
}, 30000);

test('foreground owner awaits aggregate idle and last-socket shutdown', async () => {
  const f = await fixture(); let socket: WebSocket | undefined;
  try {
    const result = await openWorkspace([{input: f.inputs[0]!, animation: 'animation-1', viewOnly: true},
      {input: f.inputs[1]!, animation: 'animation-2', viewOnly: true}],
      {stateDir: f.state, frontPort: f.port, foreground: true, idleMs: 1000, graceMs: 100});
    expect(result.waitForExit).toBeDefined();
    const url = new URL(result.url); let exited = false;
    const closing = result.waitForExit!().then(() => {exited = true;});
    socket = new WebSocket(url.origin.replace('http:', 'ws:') + '/workspace/live', {headers: {Origin: url.origin}} as unknown as string[]);
    await new Promise<void>((resolve, reject) => {socket!.onmessage = () => resolve(); socket!.onerror = () => reject(new Error('foreground live socket'));});
    await Bun.sleep(1100); expect(exited).toBe(false);
    socket.close(); await closing; expect(exited).toBe(true);
    expect(await Bun.file(join(f.state, 'owner-workspace/host.json')).exists()).toBe(false);
  } finally {socket?.close(); await f.close();}
}, 15000);
