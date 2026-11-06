import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const declaration = JSON.parse(readFileSync(join(root, 'scripts/tree-verdict.json'), 'utf8'));

test('the collector uploads its receipt only when the producer created it', () => {
  const workflow = Bun.YAML.parse(readFileSync(join(root, declaration.workflow), 'utf8')) as {
    jobs: Record<string, { steps: { id?: string; uses?: string; if?: string }[] }>;
  };
  const { steps } = workflow.jobs[declaration.producer.job];
  const upload = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload).toHaveLength(1);
  expect(upload[0]?.if).toBe("${{ steps.receipt.outputs.receipt-created == 'true' }}");
  const producerIndex = steps.findIndex(step => step.id === 'receipt');
  expect(producerIndex).toBeGreaterThanOrEqual(0);
  expect(steps.findIndex(step => step === upload[0])).toBeGreaterThan(producerIndex);
});

test('the publish hook declares the entire original gate in order', () => {
  expect(scripts.prepublishOnly).toBe('node scripts/prepublish.cjs');
  expect(scripts.test).toBe('bun test');
  expect(scripts['check:demo']).toBe('bun run check -- examples/demo/review.json');
  expect(declaration.commands).toEqual([
    'bun run typecheck', 'bun run test', 'bun run build', 'bun run check:demo', 'bun run smoke',
  ]);
  expect(declaration.chain).toBe(declaration.commands.join(' && '));
});

test.each([0, 19])('missing pinned helper runs the full local chain and returns exit %i', exit => {
  const fixture = mkdtempSync(join(tmpdir(), 'review-publish-fallback-'));
  try {
    const wrapper = join(fixture, 'prepublish.cjs');
    const trace = join(fixture, 'trace');
    const bun = join(fixture, 'bun');
    copyFileSync(join(root, 'scripts/prepublish.cjs'), wrapper);
    copyFileSync(join(root, 'scripts/tree-verdict.json'), join(fixture, 'tree-verdict.json'));
    writeFileSync(bun, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TRACE"\nif [ "$2" = smoke ]; then exit "$SMOKE_EXIT"; fi\n');
    chmodSync(bun, 0o755);
    const result = Bun.spawnSync(['node', wrapper], {
      cwd: fixture,
      env: { PATH: `${fixture}:${process.env.PATH}`, TRACE: trace, SMOKE_EXIT: String(exit) },
      timeout: 5000,
    });
    expect(result.exitCode).toBe(exit);
    expect(result.stdout.toString()).toContain('helper absent: executing original full chain');
    expect(readFileSync(trace, 'utf8')).toBe('run typecheck\nrun test\nrun build\nrun check:demo\nrun smoke\n');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
