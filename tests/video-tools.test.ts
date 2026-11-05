import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const action = Bun.YAML.parse(readFileSync(new URL('../.github/actions/reference-video-tools/action.yml', import.meta.url), 'utf8')) as {
  inputs: Record<'url' | 'version' | 'sha256', { default: string }>;
  runs: { using: string; steps: Record<string, unknown>[] };
};
const installer = fileURLToPath(new URL('../scripts/install-video-tools.sh', import.meta.url));
const url = action.inputs.url.default;
const version = action.inputs.version.default;
const root = url.split('/').at(-1)!.replace(/\.tar\.xz$/, '');

test('the shared composite restores and saves only the archive under the SHA-256 key', () => {
  const archive = {
    path: '${{ runner.temp }}/reference-video-tools.tar.xz',
    key: 'reference-video-tools-${{ inputs.sha256 }}',
  };
  expect(action.runs.using).toBe('composite');
  expect(action.runs.steps).toEqual([
    { uses: 'actions/cache/restore@v4', id: 'archive', with: archive },
    {
      shell: 'bash',
      env: {
        VIDEO_TOOLS_URL: '${{ inputs.url }}',
        VIDEO_TOOLS_VERSION: '${{ inputs.version }}',
        VIDEO_TOOLS_SHA256: '${{ inputs.sha256 }}',
        VIDEO_TOOLS_CACHE_HIT: '${{ steps.archive.outputs.cache-hit }}',
      },
      run: 'bash "$GITHUB_ACTION_PATH/../../../scripts/install-video-tools.sh"',
    },
    { uses: 'actions/cache/save@v4', if: "steps.archive.outputs.cache-hit != 'true'", with: archive },
  ]);
});

function fixture(
  options: { mode: 'cold' | 'warm'; missing?: boolean; badBytes?: boolean; wrongVersion?: boolean; env?: Record<string, string> },
) {
  const directory = mkdtempSync(join(tmpdir(), 'review-video-tools-'));
  try {
    const shim = join(directory, 'shim');
    const bin = join(directory, root, 'bin');
    const source = join(directory, 'source.tar.xz');
    const archive = join(directory, 'reference-video-tools.tar.xz');
    const marker = join(directory, 'events');
    const githubPath = join(directory, 'github-path');
    mkdirSync(shim);
    mkdirSync(bin, { recursive: true });
    const tar = Bun.which('tar')!;
    writeFileSync(join(shim, 'uname'), '#!/bin/bash\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; esac\n', { mode: 0o755 });
    writeFileSync(join(shim, 'tar'), '#!/bin/bash\necho extract >> "$MARKER"\nexec "$REAL_TAR" "$@"\n', { mode: 0o755 });
    writeFileSync(join(shim, 'curl'), '#!/bin/bash\necho download >> "$MARKER"\nwhile [[ "$1" != --output ]]; do shift; done\ncp "$SOURCE" "$2"\n', { mode: 0o755 });
    const tools = options.missing ? ['ffmpeg'] : ['ffmpeg', 'ffprobe'];
    for (const tool of tools) {
      const reported = options.wrongVersion && tool === 'ffprobe' ? 'unexpected' : version;
      writeFileSync(join(bin, tool), `#!/bin/bash\necho "${tool}:$1" >> "$MARKER"\necho "${tool} version ${reported} fixture"\n`, { mode: 0o755 });
    }
    const packaged = Bun.spawnSync([tar, '-cJf', source, '-C', directory, root]);
    expect(packaged.exitCode).toBe(0);
    const sha = options.badBytes
      ? action.inputs.sha256.default
      : new Bun.CryptoHasher('sha256').update(readFileSync(source)).digest('hex');
    if (options.mode === 'warm') writeFileSync(archive, readFileSync(source));
    const result = Bun.spawnSync(['bash', installer], {
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH}`,
        GITHUB_PATH: githubPath,
        RUNNER_TEMP: directory,
        VIDEO_TOOLS_CACHE_HIT: options.mode === 'warm' ? 'true' : '',
        VIDEO_TOOLS_URL: url,
        VIDEO_TOOLS_VERSION: version,
        VIDEO_TOOLS_SHA256: sha,
        MARKER: marker,
        REAL_TAR: tar,
        SOURCE: source,
        ...options.env,
      },
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      events: existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : [],
      path: existsSync(githubPath) ? readFileSync(githubPath, 'utf8').trim() : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const mode of ['cold', 'warm'] as const) {
  test(`${mode}: verifies before extraction and publishes the version-checked directory`, () => {
    const result = fixture({ mode });
    expect(result.code).toBe(0);
    expect(result.events).toEqual([
      ...(mode === 'cold' ? ['download'] : []), 'extract', 'ffmpeg:-version', 'ffprobe:-version',
    ]);
    expect(result.stdout).toContain(mode === 'cold' ? 'cache MISS' : 'cache HIT');
    expect(result.stdout).toContain('archive verified:');
    expect(result.stdout).toContain(`Resolved ffmpeg: ${result.path}/ffmpeg`);
    expect(result.stdout).toContain(`Resolved ffprobe: ${result.path}/ffprobe`);
  });

  test(`${mode}: a different archive under the unchanged production pin refuses before extraction or execution`, () => {
    const result = fixture({ mode, badBytes: true });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('VIDEO_TOOLS_SHA256_MISMATCH');
    expect(result.events).toEqual(mode === 'cold' ? ['download'] : []);
    expect(result.path).toBeUndefined();
  });
}

test('a missing tool refuses before either executable is called', () => {
  const result = fixture({ mode: 'warm', missing: true });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('VIDEO_TOOLS_MISSING');
  expect(result.events).toEqual(['extract']);
  expect(result.path).toBeUndefined();
});

test('a tool version mismatch refuses before exporting PATH', () => {
  const result = fixture({ mode: 'warm', wrongVersion: true });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('VIDEO_TOOLS_VERSION: ffprobe');
  expect(result.path).toBeUndefined();
});

for (const [label, env, refusal] of [
  ['unpinned source', { VIDEO_TOOLS_URL: url.replace(/autobuild-[^/]+/, 'latest') }, 'VIDEO_TOOLS_PIN'],
  ['inconsistent version', { VIDEO_TOOLS_VERSION: 'n8.1.3-27-g8dca1586f4-20261030' }, 'VIDEO_TOOLS_PIN'],
  ['invalid hash', { VIDEO_TOOLS_SHA256: 'abcd' }, 'VIDEO_TOOLS_PIN'],
  ['nonexact key', { VIDEO_TOOLS_CACHE_HIT: 'false' }, 'VIDEO_TOOLS_CACHE'],
  ['missing restored archive', { VIDEO_TOOLS_CACHE_HIT: 'true' }, 'VIDEO_TOOLS_CACHE'],
] as const) {
  test(`refuses ${label} before download, extraction or execution`, () => {
    const result = fixture({ mode: 'cold', env });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(refusal);
    expect(result.events).toEqual([]);
  });
}
