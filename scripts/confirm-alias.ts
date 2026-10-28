/** Confirm the alias from an empty install, including its exact declared identity. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function confirmAlias(version: string, tarball?: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`ALIAS_INSTALL_VERSION: ${JSON.stringify(version)} is not a release version`);
  const work = mkdtempSync(join(tmpdir(), 'rig-review-alias-install-'));
  try {
    writeFileSync(join(work, 'package.json'), '{"name":"alias-install-confirmation","private":true}\n');
    const installed = spawnSync('npm', ['install', '--dry-run=false', '--no-audit', '--no-fund', tarball ?? `rig-review@${version}`], { cwd: work, encoding: 'utf8' });
    if (installed.status !== 0) throw new Error(`ALIAS_INSTALL: npm install exited ${installed.status}: ${installed.stderr ?? installed.error?.message}`);
    mkdirSync(join(work, 'node_modules'), { recursive: true });
    writeFileSync(join(work, 'node_modules/.metadata_never_index'), '');
    const manifest = JSON.parse(readFileSync(join(work, 'node_modules/rig-review/package.json'), 'utf8')) as { name: string; version: string };
    if (manifest.name !== 'rig-review' || manifest.version !== version) throw new Error(`ALIAS_INSTALL_IDENTITY: found ${manifest.name}@${manifest.version}; required rig-review@${version}`);
    const help = spawnSync(join(work, 'node_modules/.bin/rig-review'), ['--help'], { cwd: work, encoding: 'utf8' });
    if (help.status !== 0 || !help.stdout.includes('Usage')) throw new Error(`ALIAS_HELP: rig-review --help exited ${help.status}: ${help.stdout}${help.stderr ?? help.error?.message}`);
    console.log(`ALIAS_INSTALL: rig-review@${manifest.version} · empty install · rig-review --help exit 0`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [version, ...rest] = process.argv.slice(2);
  if (!version || rest.length > 0) {
    console.error('usage: bun scripts/confirm-alias.ts <release-version>');
    process.exit(2);
  }
  confirmAlias(version);
}
