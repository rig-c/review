import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot, buildWeb, PLAY_SOURCE_CONDITION, playBuildConditions } from '../src/build.ts';

const buildModuleUrl = new URL('../src/build.ts', import.meta.url).href;
const tscBin = join(appRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const PLAY_EXPORTS_WITH_SOURCE = {
  '.': {
    [PLAY_SOURCE_CONDITION]: './src/index.ts',
    types: './dist/index.d.ts',
    import: './dist/index.js',
  },
};

function createSyntheticConsumer(options: {
  exportsField: Record<string, unknown>;
  sourceCode?: string;
  distCode?: string;
  distDts?: string;
}): { root: string; playDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'review-play-source-'));
  const playDir = join(root, 'node_modules', '@rig-c', 'play');
  mkdirSync(playDir, { recursive: true });
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(
    join(playDir, 'package.json'),
    JSON.stringify({
      name: '@rig-c/play',
      version: '1.23.0',
      type: 'module',
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: options.exportsField,
    }, null, 2) + '\n',
  );
  if (options.sourceCode !== undefined) {
    mkdirSync(join(playDir, 'src'), { recursive: true });
    writeFileSync(join(playDir, 'src', 'index.ts'), options.sourceCode);
  }
  if (options.distCode !== undefined || options.distDts !== undefined) {
    mkdirSync(join(playDir, 'dist'), { recursive: true });
    if (options.distCode !== undefined) {
      writeFileSync(join(playDir, 'dist', 'index.js'), options.distCode);
    }
    if (options.distDts !== undefined) {
      writeFileSync(join(playDir, 'dist', 'index.d.ts'), options.distDts);
    }
  }
  writeFileSync(
    join(root, 'web', 'main.ts'),
    'import { PLAY_BUNDLE_MARKER } from "@rig-c/play";\nconsole.log(PLAY_BUNDLE_MARKER);\n',
  );
  return {
    root,
    playDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function runSubprocessBuild(root: string, enableSourceCondition: boolean) {
  const script = `
    import { buildWeb, playBuildConditions } from ${JSON.stringify(buildModuleUrl)};
    const root = process.argv[1];
    const conditions = playBuildConditions(root);
    const blob = await buildWeb('single', root);
    const text = await blob.text();
    console.log(JSON.stringify({ conditions, text }));
  `;
  const args = [
    process.execPath,
    ...(enableSourceCondition ? [`--conditions=${PLAY_SOURCE_CONDITION}`] : []),
    '-e',
    script,
    root,
  ];
  const proc = Bun.spawnSync(args, { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString().trim(),
    stderr: proc.stderr.toString().trim(),
  };
}

test('manifest, frozen lockfile and tsconfig declare parts 2.36.0, play 1.23.0 and @rig-c/source customConditions', () => {
  const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(pkg.dependencies['@rig-c/play']).toBe('1.23.0');
  expect(pkg.devDependencies['@rig-c/parts']).toBe('2.36.0');

  const lock = readFileSync(join(appRoot, 'bun.lock'), 'utf8');
  expect(lock).toContain('"@rig-c/parts": "2.36.0"');
  expect(lock).toContain('"@rig-c/parts@2.36.0"');
  expect(lock).not.toContain('"@rig-c/parts@2.35.0"');
  expect(lock).toContain('"@rig-c/play": "1.23.0"');

  const tsconfig = JSON.parse(readFileSync(join(appRoot, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { customConditions?: string[] };
  };
  expect(tsconfig.compilerOptions.customConditions).toEqual([PLAY_SOURCE_CONDITION]);
});

test('installed dist-only package retains default dist bundling and never enables missing source condition', async () => {
  expect(playBuildConditions(appRoot)).toEqual([]);
  const withFlagOnInstalled = runSubprocessBuild(appRoot, true);
  expect(withFlagOnInstalled.exitCode).toBe(0);
  expect(JSON.parse(withFlagOnInstalled.stdout).conditions).toEqual([]);

  // Post-play#254 published dist-only package: exports declares @rig-c/source, but tarball ships only dist/.
  const fixture = createSyntheticConsumer({
    exportsField: PLAY_EXPORTS_WITH_SOURCE,
    distCode: 'export const PLAY_BUNDLE_MARKER = "DIST_ONLY_INSTALLED_MARKER";\n',
    distDts: 'export declare const PLAY_BUNDLE_MARKER: string;\n',
  });
  try {
    expect(existsSync(join(fixture.playDir, 'src'))).toBe(false);
    expect(playBuildConditions(fixture.root)).toEqual([]);
    const blob = await buildWeb('single', fixture.root);
    const text = await blob.text();
    expect(text).toContain('DIST_ONLY_INSTALLED_MARKER');
  } finally {
    fixture.cleanup();
  }
});

test('dual package selects dist by default and source only when @rig-c/source resolution is active', () => {
  const fixture = createSyntheticConsumer({
    exportsField: PLAY_EXPORTS_WITH_SOURCE,
    sourceCode: 'export const PLAY_BUNDLE_MARKER: string = "DUAL_SOURCE_MARKER";\n',
    distCode: 'export const PLAY_BUNDLE_MARKER = "DUAL_DIST_MARKER";\n',
  });
  try {
    const defaultRun = runSubprocessBuild(fixture.root, false);
    expect(defaultRun.exitCode).toBe(0);
    const defaultResult = JSON.parse(defaultRun.stdout) as { conditions: string[]; text: string };
    expect(defaultResult.conditions).toEqual([]);
    expect(defaultResult.text).toContain('DUAL_DIST_MARKER');
    expect(defaultResult.text).not.toContain('DUAL_SOURCE_MARKER');

    const sourceRun = runSubprocessBuild(fixture.root, true);
    expect(sourceRun.exitCode).toBe(0);
    const sourceResult = JSON.parse(sourceRun.stdout) as { conditions: string[]; text: string };
    expect(sourceResult.conditions).toEqual([PLAY_SOURCE_CONDITION]);
    expect(sourceResult.text).toContain('DUAL_SOURCE_MARKER');
    expect(sourceResult.text).not.toContain('DUAL_DIST_MARKER');
  } finally {
    fixture.cleanup();
  }
});

test('linked source-only fixture with no dist bundles and typechecks under @rig-c/source and fails without it', () => {
  const fixture = createSyntheticConsumer({
    exportsField: PLAY_EXPORTS_WITH_SOURCE,
    sourceCode: 'export const PLAY_BUNDLE_MARKER: string = "LINKED_SOURCE_NO_DIST_MARKER";\n',
  });
  try {
    expect(existsSync(join(fixture.playDir, 'dist'))).toBe(false);

    // Negative control: without --conditions=@rig-c/source, dist/index.js is absent so resolution fails.
    const defaultRun = runSubprocessBuild(fixture.root, false);
    expect(defaultRun.exitCode).not.toBe(0);

    // Explicit source mode: runtime resolution selects src/index.ts and propagates @rig-c/source to Bun.build.
    const sourceRun = runSubprocessBuild(fixture.root, true);
    expect(sourceRun.exitCode).toBe(0);
    const sourceResult = JSON.parse(sourceRun.stdout) as { conditions: string[]; text: string };
    expect(sourceResult.conditions).toEqual([PLAY_SOURCE_CONDITION]);
    expect(sourceResult.text).toContain('LINKED_SOURCE_NO_DIST_MARKER');

    // TypeScript customConditions check against linked source-only fixture with no dist/index.d.ts.
    const tsconfigWithCondition = join(fixture.root, 'tsconfig.source.json');
    writeFileSync(
      tsconfigWithCondition,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          customConditions: [PLAY_SOURCE_CONDITION],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: ['web/main.ts'],
      }),
    );
    const tscPass = Bun.spawnSync([process.execPath, tscBin, '-p', tsconfigWithCondition], {
      cwd: fixture.root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(tscPass.exitCode).toBe(0);

    const tsconfigWithoutCondition = join(fixture.root, 'tsconfig.default.json');
    writeFileSync(
      tsconfigWithoutCondition,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
        include: ['web/main.ts'],
      }),
    );
    const tscFail = Bun.spawnSync([process.execPath, tscBin, '-p', tsconfigWithoutCondition], {
      cwd: fixture.root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(tscFail.exitCode).not.toBe(0);
  } finally {
    fixture.cleanup();
  }
});
