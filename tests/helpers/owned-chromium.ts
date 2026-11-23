import {existsSync, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export function ownedMacHeadlessShell(): string | undefined {
  if (process.platform !== 'darwin') return;
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(root)) return;
  const revisions = readdirSync(root).flatMap(entry => {
    const match = /^chromium_headless_shell-(\d+)$/.exec(entry);
    return match ? [{entry, revision: Number(match[1])}] : [];
  }).sort((a, b) => b.revision - a.revision);
  const executable = `chrome-headless-shell-mac-${process.arch}`;
  return revisions.map(({entry}) => join(root, entry, executable, 'chrome-headless-shell')).find(existsSync);
}
