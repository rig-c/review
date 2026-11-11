import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {WORKSPACE_TARGET_LIMIT} from '../src/open-workspace-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

test('retained iframe CSS declares a scoped important override for the shared hidden rule', async () => {
  const base = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const sharedRule = /\[hidden\]\s*\{([^}]+)\}/.exec(base)![1]!;
  const retainedRule = /\.hub-stage iframe\[hidden\],\s*\.owner-stage iframe\[hidden\]\s*\{([^}]+)\}/.exec(base)![1]!;
  expect(sharedRule).toMatch(/display:\s*none\s*!important/);
  expect(retainedRule).toMatch(/display:\s*block\s*!important/);
  expect(retainedRule).toMatch(/visibility:\s*hidden/);
  expect(retainedRule).toMatch(/pointer-events:\s*none/);
});

test('owner language control declares scoped compact width constraints', async () => {
  const base = await readFile(new URL('../web/styles.css', import.meta.url), 'utf8');
  const rule = /\.hub-header select,\s*\.owner-header select\s*\{([^}]+)\}/.exec(base)![1]!;
  expect(rule).toMatch(/width:\s*auto/); expect(rule).toMatch(/max-width:\s*12rem/);
  expect(rule).toMatch(/flex:\s*0\s+0\s+auto/);
});

test('admission and retained frame mounting share one application bound with identity-only machine entries', async () => {
  const source = await readFile(new URL('../web/owner-workspace.ts', import.meta.url), 'utf8');
  const contract = await readFile(new URL('../src/open-workspace-contract.ts', import.meta.url), 'utf8');
  expect(WORKSPACE_TARGET_LIMIT).toBe(32);
  expect(source).toContain('limit: () => WORKSPACE_TARGET_LIMIT');
  expect(source).toContain('if (retained.atLimit())');
  expect(source).toContain('value.targets.length > WORKSPACE_TARGET_LIMIT');
  expect(contract).not.toContain('WORKSPACE_MOUNT_LIMIT');
  expect(enCatalog.WORKSPACE_MOUNT_LIMIT).toBeUndefined(); expect(koCatalog.WORKSPACE_MOUNT_LIMIT).toBeUndefined();
  for (const key of ['WORKSPACE_TARGET_LIMIT', 'FRONT_QUERY_REFUSED']) {
    expect(enCatalog[key]).toBe(key); expect(koCatalog[key]).toBe(key);
  }
});
