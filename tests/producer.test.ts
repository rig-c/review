import {expect, test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveCompiler, resolvePose, resolveProducer} from '../src/producer.ts';

// Disposable installed manifests/bins, outside the worktree: no shared dependency is modified.
async function fixture(run: (root: string, install: (name: string, bin: string, at?: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'review-producer-'));
  const install = async (name: string, bin: string, at = root) => {
    const dir = join(at, 'node_modules', name);
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'package.json'), JSON.stringify({name, version: name === '@rig-c/parts' ? '1.78.0' : name === '@rig-c/pose' ? '1.5.3' : '2.81.0', bin: {[bin]: './cli.ts'}}));
    await writeFile(join(dir, 'cli.ts'), 'throw new Error("resolution must not execute a compiler");');
  };
  try { await run(root, install); } finally { await rm(root, {recursive: true, force: true}); }
}

for (const [producer, bin, resolver] of [
  ['@rig-c/parts', 'rig-parts', resolveProducer],
  ['@rig-c/pose', 'rig-pose', resolvePose],
] as const) {
  test(`#221: ${producer} resolves a compiler installed only as @rig-c/core and reports that identity`, async () => {
    await fixture(async (root, install) => {
      await install(producer, bin); await install('@rig-c/core', 'rigc');
      const result = resolver([join(root, 'package')]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.compiler).toMatchObject({package: '@rig-c/core', version: '2.81.0', bin: join(root, 'node_modules/@rig-c/core/cli.ts')});
    });
  });
  test(`#221: ${producer} prefers scoped core even when legacy rig-c is nearer`, async () => {
    await fixture(async (root, install) => {
      await install(producer, bin); await install('@rig-c/core', 'rigc');
      await install('rig-c', 'rigc', join(root, 'node_modules', producer));
      const result = resolver([root]);
      expect(result.ok && result.compiler.package).toBe('@rig-c/core');
    });
  });
  test(`#221: ${producer} still identifies a legacy-only compiler`, async () => {
    await fixture(async (root, install) => {
      await install(producer, bin); await install('rig-c', 'rigc');
      const result = resolver([root]);
      expect(result.ok && result.compiler.package).toBe('rig-c');
    });
  });
}

test('#221: readings resolves scoped core without parts and keeps the selected version guard', async () => {
  await fixture(async (root, install) => {
    await install('@rig-c/core', 'rigc');
    const result = resolveCompiler([join(root, 'package')], '2.63.0');
    expect(result.ok && result.compiler.package).toBe('@rig-c/core');
    const old = resolveCompiler([root], '2.82.0');
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.error).toContain('bun add -d @rig-c/core@latest');
  });
});

test('#221: a malformed scoped install refuses by name instead of silently switching to legacy', async () => {
  await fixture(async (root, install) => {
    await install('@rig-c/parts', 'rig-parts'); await install('@rig-c/core', 'wrong-bin'); await install('rig-c', 'rigc');
    const result = resolveProducer([root]);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toStartWith('MODELING_COMPILER_NOT_INSTALLED: @rig-c/core'); expect(result.error).toContain('declares no "rigc" bin'); }
  });
});

test('#221: readings uses the compiler beside parts before a standalone compiler at another start', async () => {
  await fixture(async (root, install) => {
    const bench = join(root, 'bench');
    await install('@rig-c/parts', 'rig-parts', bench);
    await install('@rig-c/core', 'rigc', join(bench, 'node_modules/@rig-c/parts'));
    await install('rig-c', 'rigc');
    const result = resolveCompiler([root, bench], '2.63.0');
    expect(result.ok && result.compiler.root).toBe(join(bench, 'node_modules/@rig-c/parts/node_modules/@rig-c/core'));
  });
});

test('#221: missing compiler remedies name the canonical package for every resolver', async () => {
  await fixture(async (root, install) => {
    await install('@rig-c/parts', 'rig-parts'); await install('@rig-c/pose', 'rig-pose');
    // Limit the search to this fixture even on a host with ancestor dependencies.
    const exists = (path: string) => path.startsWith(root + '/') && existsSync(path);
    for (const result of [resolveProducer([root], exists), resolvePose([root], exists), resolveCompiler([root], '2.63.0', exists)]) {
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toContain('@rig-c/core is not installed'); expect(result.error).not.toContain('bun add -d rig-c'); }
    }
  });
});
