const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const declaration = join(__dirname, 'tree-verdict.json');
const { chain } = JSON.parse(readFileSync(declaration, 'utf8'));
if (typeof chain !== 'string' || !chain.trim()) process.exit(1);

const tools = process.env.TREE_VERDICT_TOOLS;
const helper = tools && join(tools, 'lifecycle.mjs');
let result;
if (helper && existsSync(helper)) {
  result = spawnSync(process.execPath, [helper, '--declaration', declaration], { stdio: 'inherit' });
} else {
  console.log('tree-verdict helper absent: executing original full chain');
  const windows = process.platform === 'win32';
  result = spawnSync(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    windows ? ['/d', '/s', '/c', chain] : ['-c', chain], { stdio: 'inherit' });
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
