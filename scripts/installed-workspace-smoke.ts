/** Narrow installed entry coverage, shared by install-smoke and the bounded delivery probe. */
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {jobInputHashes} from '../tests/helpers/job-api-fixture.ts';
import {redactCapability} from './redact.ts';

export async function installedWorkspaceSmoke(options: {
  app: string; fixtureRoot: string; work: string;
  log(line: string): void;
  evidence?: string;
  core?: boolean;
}) {
  const root = await mkdtemp(join(options.work, 'installed-workspace-'));
  const inputs: string[] = [], coreInputs: string[] = [], children: Bun.Subprocess[] = [];
  const receipts: unknown[] = [], proofs: unknown[] = [];
  let inputHashes: {before: unknown; after?: unknown} | undefined;
  let firstFailure: {error: unknown} | undefined;
  const reviewRoot = join(options.app, 'node_modules/@rig-c/review');
  const reviewBin = join(options.app, 'node_modules/.bin/rig-review');
  const coreBin = join(options.app, 'node_modules/.bin/rigc');
  const installed = JSON.parse(await readFile(join(reviewRoot, 'package.json'), 'utf8'));
  assert.equal(installed.name, '@rig-c/review');
  assert.equal(installed.bin['rig-review'], 'src/entry.ts');
  if (options.evidence) await mkdir(options.evidence, {recursive: true});
  async function evidence() {
    if (options.evidence) await writeFile(join(options.evidence, 'workspace.json'), JSON.stringify({
      installed: {name: installed.name, version: installed.version, bin: reviewBin}, inputHashes, receipts, proofs,
    }, null, 2));
  }
  try {
    for (let index = 0; index < (options.core ? 18 : 9); index++) {
      const coreTarget = index >= 9;
      const targetIndex = coreTarget ? index - 8 : index + 1;
      const input = join(root, (coreTarget ? 'synthetic-core-' : 'synthetic-') + targetIndex);
      await mkdir(input);
      await cp(join(options.fixtureRoot, 'build'), join(input, 'build'), {recursive: true});
      await cp(join(options.fixtureRoot, 'motion.json'), join(input, 'motion.json'));
      const path = join(input, 'build/skeleton.model.json');
      const model = JSON.parse(await readFile(path, 'utf8'));
      model.animations[0].name = (coreTarget ? 'core-animation-' : 'synthetic-animation-') + targetIndex;
      model.editorOrder.animations[0] = model.animations[0].name;
      await writeFile(path, JSON.stringify(model));
      (coreTarget ? coreInputs : inputs).push(input);
    }
    const allInputs = [...inputs, ...coreInputs];
    const before = await Promise.all(allInputs.map(jobInputHashes));
    inputHashes = {before}; await evidence();
    for (const mode of ['batch', 'sequential'] as const) {
      const stateDir = join(root, mode + '-state');
      const allocation = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('')});
      const port = allocation.port!; await allocation.stop(true);
      let owner: URL | undefined;
      let host: {pid: number; origin: string} | undefined;
      const exits: number[] = [];
      async function launch(args: string[], core = false) {
        const command = [core ? coreBin : reviewBin, ...(core ? ['review'] : ['open']), ...args];
        const child = Bun.spawn(command, {cwd: options.app, stdout: 'pipe', stderr: 'pipe', env: {
          ...process.env, RIG_REVIEW_STATE_DIR: stateDir, RIG_REVIEW_FRONT_PORT: String(port),
        }});
        children.push(child);
        const timer = setTimeout(() => {child.kill('SIGTERM');}, 20000);
        try {
          const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(),
            new Response(child.stderr).text(), child.exited]);
          receipts.push({command, stdout, stderr, exit}); await evidence();
          if (core && exit !== 0) throw new Error('INSTALLED_CORE_REVIEW_REFUSED: ' + redactCapability(stderr.trim()));
          assert.equal(exit, 0, 'installed launcher exit'); exits.push(exit);
          assert.equal(stderr.includes('#cap='), false, 'launcher stderr contains no grant');
          const url = new URL(stdout.trim());
          assert.equal(url.origin, 'http://127.0.0.1:' + port);
          assert.equal(url.pathname, '/'); assert.ok(url.searchParams.get('workspace'));
          assert.match(url.hash, /^#cap=[a-f0-9]{64}$/);
          if (owner) assert.equal(url.href, owner.href); else owner = url;
          return url;
        } finally {clearTimeout(timer);}
      }
      const single = (index: number) => [inputs[index]!, '--animation', 'synthetic-animation-' + (index + 1), '--view-only'];
      const batch = [...inputs, '--animation', 'synthetic-animation-1', '--view-only'];
      for (let index = 1; index < inputs.length; index++) batch.push('--animation-for', String(index + 1), 'synthetic-animation-' + (index + 1));
      async function currentList() {
        const response = await fetch(owner!.origin + '/workspace/api/targets', {
          headers: {'X-Review-Capability': owner!.hash.slice(5)}, signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200); return response.json();
      }
      try {
        if (mode === 'batch') await launch(batch);
        else for (let index = 0; index < inputs.length; index++) await launch(single(index));
        host = JSON.parse(await readFile(join(stateDir, 'owner-workspace/host.json'), 'utf8'));
        assert.ok(Number.isSafeInteger(host!.pid) && host!.pid > 0);
        assert.equal(host!.origin, owner!.origin);
        const list = await currentList();
        assert.equal(list.targets.length, 9);
        assert.deepEqual(list.targets.map((target: any) => target.animation), inputs.map((_, index) => 'synthetic-animation-' + (index + 1)));
        assert.ok(list.targets.every((target: any) => target.viewOnly && !('act' in target) && !('pending' in target)));
        for (const target of list.targets) {
          const response = await fetch(owner!.origin + '/instances/' + target.key + '/api/review');
          assert.equal(response.status, 200);
          const data = await response.json(); assert.equal(data.initialAnimation, target.animation);
        }
        await launch(single(0));
        await Promise.all([1, 2, 3].map(index => launch(single(index))));
        const descriptors = (await Bun.file(join(stateDir, 'owner-workspace/host.json')).json());
        assert.equal(descriptors.pid, host!.pid);
        const processList = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']); assert.equal(processList.exitCode, 0);
        const residents = processList.stdout.toString().split('\n').filter(line => line.includes(reviewRoot));
        assert.equal(residents.length, 1, 'all resident backend process count');
        assert.ok(residents[0]!.includes(join(reviewRoot, 'src/open-workspace-worker.ts')));
        const sockets = Bun.spawnSync([Bun.which('lsof') ?? '/usr/sbin/lsof', '-nP', '-a', '-p', String(host!.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
        assert.equal(sockets.exitCode, 0);
        const listeners = sockets.stdout.toString().split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
        assert.deepEqual(listeners, ['127.0.0.1:' + port]);
        const semantic = await fetch(owner!.origin + '/jobs/synthetic'); assert.equal(semantic.status, 404); await semantic.body?.cancel();
        inputHashes.after = await Promise.all(allInputs.map(jobInputHashes));
        assert.deepEqual(inputHashes.after, before);
        const publicURL = new URL(owner!.href); publicURL.hash = '';
        const proof = {kind: 'installed-nine-' + mode, installedVersion: installed.version, targets: 9,
          distinctAnimations: 9, launcherExits: [...exits], uniqueOwnerURLs: 1, backendPid: host!.pid,
          residentBackendProcesses: residents.length, listeners, ownerURLWithoutCapability: publicURL.href,
          viewOnly: true, actOrPendingMetadata: false, semanticRouteStatus: 404, inputHashesUnchanged: true};
        proofs.push(proof); options.log(JSON.stringify(proof)); await evidence();
        if (options.core && mode === 'batch') {
          const coreBatch = [...coreInputs, '--animation', 'core-animation-1', '--view-only'];
          for (let index = 1; index < coreInputs.length; index++) coreBatch.push('--animation-for', String(index + 1), 'core-animation-' + (index + 1));
          await launch(coreBatch, true);
          const forwarded = await currentList();
          assert.equal(forwarded.targets.length, 18);
          assert.deepEqual(forwarded.targets.slice(0, 9), list.targets);
          assert.deepEqual(forwarded.targets.slice(9).map((target: any) => target.animation), coreInputs.map((_, index) => 'core-animation-' + (index + 1)));
          assert.ok(forwarded.targets.slice(9).every((target: any) => target.viewOnly && !('act' in target) && !('pending' in target)));
          for (const target of forwarded.targets.slice(9)) {
            const response = await fetch(owner!.origin + '/instances/' + target.key + '/api/review');
            assert.equal(response.status, 200); const data = await response.json();
            assert.equal(data.initialAnimation, target.animation);
          }
          const afterCore = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']); assert.equal(afterCore.exitCode, 0);
          const coreResidents = afterCore.stdout.toString().split('\n').filter(line => line.includes(reviewRoot));
          assert.equal(coreResidents.length, 1); assert.ok(coreResidents[0]!.includes(String(host!.pid)));
          const coreSockets = Bun.spawnSync([Bun.which('lsof') ?? '/usr/sbin/lsof', '-nP', '-a', '-p', String(host!.pid), '-iTCP', '-sTCP:LISTEN', '-F', 'pn']);
          assert.equal(coreSockets.exitCode, 0);
          assert.deepEqual(coreSockets.stdout.toString().split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)), listeners);
          inputHashes.after = await Promise.all(allInputs.map(jobInputHashes)); assert.deepEqual(inputHashes.after, before);
          const coreProof = {kind: 'official-rigc-review-forwarding', requestedTargets: 9, addedTargets: 9,
            totalTargetsAfter: 18, perTargetAnimationsPreserved: true, sameOwnerURL: true, backendPid: host!.pid,
            residentBackendProcesses: coreResidents.length, listeners, launcherExit: 0, usesRealInstalledCoreBin: true};
          proofs.push(coreProof); options.log(JSON.stringify(coreProof)); await evidence();
        }
      } catch (error) {
        firstFailure ??= {error};
        throw error;
      } finally {
        if (!host) {
          try {host = JSON.parse(await readFile(join(stateDir, 'owner-workspace/host.json'), 'utf8'));}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
        }
        for (const child of children) if (child.exitCode === null) {child.kill('SIGTERM'); await child.exited;}
        if (host) {
          try {process.kill(host.pid, 'SIGTERM');}
          catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && await Bun.file(join(stateDir, 'owner-workspace/host.json')).exists()) await Bun.sleep(25);
          assert.equal(await Bun.file(join(stateDir, 'owner-workspace/host.json')).exists(), false);
          const reachable = await fetch(host.origin, {signal: AbortSignal.timeout(500)}).then(async response => {await response.body?.cancel(); return true;}, () => false);
          assert.equal(reachable, false);
          proofs.push({kind: 'installed-cleanup-' + mode, descriptorRemoved: true, listenerReachable: false});
          await evidence();
        }
      }
    }
    return {installedVersion: installed.version, proofs};
  } catch (error) {
    if (firstFailure && error !== firstFailure.error) receipts.push({cleanupError: redactCapability(String(error))});
    firstFailure ??= {error};
    throw firstFailure.error;
  } finally {
    try {
      // A launcher timeout can precede descriptor publication. Only this unique fixture's workers qualify.
      let processList = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']);
      assert.equal(processList.exitCode, 0, 'fallback cleanup process inventory');
      let remaining = processList.stdout.toString().split('\n').filter(line =>
        line.includes(root) && line.includes(join(reviewRoot, 'src/open-workspace-worker.ts')));
      for (const line of remaining) {
        const pid = Number(line.trim().split(/\s+/)[0]);
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        try {process.kill(pid, 'SIGTERM');}
        catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
      }
      const deadline = Date.now() + 5000;
      while (remaining.length && Date.now() < deadline) {
        await Bun.sleep(25);
        processList = Bun.spawnSync(['ps', '-axo', 'pid,ppid,command']);
        assert.equal(processList.exitCode, 0, 'fallback cleanup process recheck');
        remaining = processList.stdout.toString().split('\n').filter(line =>
          line.includes(root) && line.includes(join(reviewRoot, 'src/open-workspace-worker.ts')));
      }
      assert.equal(remaining.length, 0, 'owned workers exited before fixture deletion');
      await evidence(); await rm(root, {recursive: true, force: true});
    } catch (error) {
      if (firstFailure) {
        receipts.push({cleanupError: redactCapability(String(error))});
        await evidence().catch(() => {});
        throw firstFailure.error;
      }
      throw error;
    }
  }
}
