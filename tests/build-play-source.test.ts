import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appRoot, buildWeb, PLAY_SOURCE_CONDITION, playBuildConditions } from '../src/build.ts';
import { playPackagePath, toolVersions } from '../src/versions.ts';

const buildModuleUrl = new URL('../src/build.ts', import.meta.url).href;
const versionsModuleUrl = new URL('../src/versions.ts', import.meta.url).href;
const tscBin = join(appRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const reviewManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

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

test('manifest, frozen lockfile and tsconfig declare coherent @rig-c/parts and @rig-c/play pins and @rig-c/source customConditions', () => {
  const playPin = reviewManifest.dependencies['@rig-c/play']!;
  const partsPin = reviewManifest.devDependencies['@rig-c/parts']!;
  expect(playPin).toMatch(/^\d+\.\d+\.\d+$/);
  expect(partsPin).toMatch(/^\d+\.\d+\.\d+$/);

  const lockText = readFileSync(join(appRoot, 'bun.lock'), 'utf8');
  const lock = Bun.JSONC.parse(lockText) as {
    workspaces: { '': { dependencies: Record<string, string>; devDependencies: Record<string, string> } };
    packages: Record<string, [string, ...unknown[]]>;
  };
  expect(lock.workspaces[''].dependencies['@rig-c/play']).toBe(playPin);
  expect(lock.workspaces[''].devDependencies['@rig-c/parts']).toBe(partsPin);
  expect(lock.packages['@rig-c/play']?.[0]).toBe(`@rig-c/play@${playPin}`);
  expect(lock.packages['@rig-c/parts']?.[0]).toBe(`@rig-c/parts@${partsPin}`);
  expect(lockText).not.toContain('"@rig-c/parts@2.35.0"');

  const tsconfig = JSON.parse(readFileSync(join(appRoot, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { customConditions?: string[] };
  };
  expect(tsconfig.compilerOptions.customConditions).toEqual([PLAY_SOURCE_CONDITION]);
});

test('installed dist-only package retains default dist bundling and never enables missing source condition', async () => {
  const resolvedAppPlayManifest = JSON.parse(readFileSync(playPackagePath(), 'utf8')) as {
    name: string;
    version: string;
  };
  expect(resolvedAppPlayManifest.name).toBe('@rig-c/play');
  expect(await toolVersions()).toEqual({
    viewerVersion: reviewManifest.version,
    runtimeVersion: resolvedAppPlayManifest.version,
  });
  const appResolvedEntry = Bun.resolveSync('@rig-c/play', appRoot);
  expect(playBuildConditions(appRoot)).toEqual(
    /[\\/]src[\\/]index\.ts$/.test(appResolvedEntry) ? [PLAY_SOURCE_CONDITION] : [],
  );

  // Pre-play#254 registry dist-only package (exports has only types + import, no @rig-c/source).
  const legacyDistOnly = createSyntheticConsumer({
    exportsField: {
      '.': {
        types: './dist/index.d.ts',
        import: './dist/index.js',
      },
    },
    distCode: 'export const PLAY_BUNDLE_MARKER = "LEGACY_DIST_ONLY_MARKER";\n',
    distDts: 'export declare const PLAY_BUNDLE_MARKER: string;\n',
  });
  try {
    expect(playBuildConditions(legacyDistOnly.root)).toEqual([]);
    const withFlagOnLegacy = runSubprocessBuild(legacyDistOnly.root, true);
    expect(withFlagOnLegacy.exitCode).toBe(0);
    const legacyResult = JSON.parse(withFlagOnLegacy.stdout) as { conditions: string[]; text: string };
    expect(legacyResult.conditions).toEqual([]);
    expect(legacyResult.text).toContain('LEGACY_DIST_ONLY_MARKER');
  } finally {
    legacyDistOnly.cleanup();
  }

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

    const withFlagOnPost254DistOnly = runSubprocessBuild(fixture.root, true);
    expect(withFlagOnPost254DistOnly.exitCode).toBe(0);
    const post254Result = JSON.parse(withFlagOnPost254DistOnly.stdout) as { conditions: string[]; text: string };
    expect(post254Result.conditions).toEqual([]);
    expect(post254Result.text).toContain('DIST_ONLY_INSTALLED_MARKER');
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

test('symlinked peer target lane.ws/peers/rig-play with no dist resolves manifest identity, forwards only active source condition to spawned child, and refuses mismatched package names', () => {
  const base = mkdtempSync(join(tmpdir(), 'review-peer-link-'));
  try {
    const peerPlay = join(base, 'lane.ws', 'peers', 'rig-play');
    mkdirSync(join(peerPlay, 'src'), { recursive: true });
    writeFileSync(
      join(peerPlay, 'package.json'),
      JSON.stringify({
        name: '@rig-c/play',
        version: '1.23.0-peer',
        type: 'module',
        exports: PLAY_EXPORTS_WITH_SOURCE,
      }, null, 2) + '\n',
    );
    writeFileSync(
      join(peerPlay, 'src', 'index.ts'),
      'export const PLAY_BUNDLE_MARKER: string = "PEER_SYMLINK_SOURCE_MARKER";\n',
    );
    expect(existsSync(join(peerPlay, 'dist'))).toBe(false);

    const consumer = join(base, 'lane.ws', 'review');
    mkdirSync(join(consumer, 'node_modules', '@rig-c'), { recursive: true });
    mkdirSync(join(consumer, 'web'), { recursive: true });
    symlinkSync(peerPlay, join(consumer, 'node_modules', '@rig-c', 'play'), 'dir');
    writeFileSync(
      join(consumer, 'web', 'main.ts'),
      'import { PLAY_BUNDLE_MARKER } from "@rig-c/play";\nconsole.log(PLAY_BUNDLE_MARKER);\n',
    );

    const childWorkerScript = join(base, 'detached-child-probe.ts');
    writeFileSync(
      childWorkerScript,
      `
      import { buildWeb, playBuildConditions } from ${JSON.stringify(buildModuleUrl)};
      import { playPackagePath, toolVersions } from ${JSON.stringify(versionsModuleUrl)};
      const root = process.argv[2]!;
      const pkgPath = playPackagePath(root);
      const versions = await toolVersions(root);
      const conditions = playBuildConditions(root);
      const text = await (await buildWeb('single', root)).text();
      console.log(JSON.stringify({ execArgv: process.execArgv, pkgPath, versions, conditions, text }));
      `,
    );

    // Parent run with --smol AND --conditions=@rig-c/source spawns child forwarding ONLY playBuildConditions(consumer).
    const parentLauncherScript = `
      import { playBuildConditions } from ${JSON.stringify(buildModuleUrl)};
      const consumer = process.argv[1]!;
      const worker = process.argv[2]!;
      const forwarded = playBuildConditions(consumer).map(c => '--conditions=' + c);
      const child = Bun.spawnSync([process.execPath, ...forwarded, worker, consumer], { stdout: 'pipe', stderr: 'pipe' });
      if (child.exitCode !== 0) {
        console.error(child.stderr.toString());
        process.exit(child.exitCode);
      }
      console.log(child.stdout.toString().trim());
    `;
    const parentProc = Bun.spawnSync(
      [process.execPath, '--smol', `--conditions=${PLAY_SOURCE_CONDITION}`, '-e', parentLauncherScript, consumer, childWorkerScript],
      { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(parentProc.exitCode).toBe(0);
    const childResult = JSON.parse(parentProc.stdout.toString().trim()) as {
      execArgv: string[];
      pkgPath: string;
      versions: { viewerVersion: string; runtimeVersion: string };
      conditions: string[];
      text: string;
    };
    expect(childResult.execArgv).toEqual([`--conditions=${PLAY_SOURCE_CONDITION}`]);
    expect(childResult.pkgPath).toBe(realpathSync(join(peerPlay, 'package.json')));
    expect(childResult.versions).toEqual({ viewerVersion: reviewManifest.version, runtimeVersion: '1.23.0-peer' });
    expect(childResult.conditions).toEqual([PLAY_SOURCE_CONDITION]);
    expect(childResult.text).toContain('PEER_SYMLINK_SOURCE_MARKER');

    // Negative control: if the symlinked target manifest name is not @rig-c/play, playPackagePath refuses by name.
    writeFileSync(
      join(peerPlay, 'package.json'),
      JSON.stringify({
        name: '@rig-c/not-play',
        version: '1.23.0-peer',
        type: 'module',
        exports: PLAY_EXPORTS_WITH_SOURCE,
      }, null, 2) + '\n',
    );
    const wrongNameProc = Bun.spawnSync(
      [process.execPath, `--conditions=${PLAY_SOURCE_CONDITION}`, childWorkerScript, consumer],
      { cwd: appRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(wrongNameProc.exitCode).not.toBe(0);
    expect(wrongNameProc.stderr.toString()).toContain('@rig-c/play: package.json not found from resolved entry');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
