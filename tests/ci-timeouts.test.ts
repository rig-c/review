import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Job = {
  if?: string;
  needs?: string;
  steps: Step[];
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Workflow = { jobs: Record<string, Job> };
const installerName = 'Install reference video export tools';
const actionPath = './.github/actions/reference-video-tools';

// Parse the real YAML so a bound at workflow level, on another job, or under
// `with` cannot masquerade as the named job/step's Actions timeout.
function checkBound(job: Job) {
  const budget = job['timeout-minutes'];
  expect(Number.isInteger(budget)).toBe(true);
  expect(budget!).toBeGreaterThan(0);
  expect(budget!).toBeLessThan(360); // Refuse the implicit six-hour ceiling.
  expect(job['continue-on-error'] ?? false).toBe(false);
  const installers = job.steps.filter(step => step.name === installerName);
  expect(installers).toHaveLength(1);
  const installer = installers[0]!;
  const limit = installer['timeout-minutes'];
  expect(Number.isInteger(limit)).toBe(true);
  expect(limit!).toBeGreaterThan(0);
  expect(limit!).toBeLessThan(budget!);
  expect(installer['continue-on-error'] ?? false).toBe(false);
  expect(limit).toBe(3);
  expect(installer.uses).toBe(actionPath);
  expect(installer.run).toBeUndefined();
  expect(installer.with).toBeUndefined(); // Both callers use the same pin defaults.
}

for (const [file, name] of [['check.yml', 'check'], ['release.yml', 'release']] as const) {
  const workflow = Bun.YAML.parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8')) as Workflow;
  const job = workflow.jobs[name]!;
  test(`${file}: the required tool install is bounded within its owning job`, () => {
    checkBound(job);
    const installer = job.steps.find(step => step.name === installerName)!;
    if (name === 'release') {
      expect(job['timeout-minutes']).toBe(20);
      expect(installer.if).toBe("${{ steps.target.outputs.publish == 'true' }}");
    } else {
      expect(job['timeout-minutes']).toBe(10);
      expect(installer.if).toBeUndefined();
      checkBound(workflow.jobs['video-tools-cache']!);
    }
  });

  // Mutate detached data only: never edit shared source or wait for apt.
  const plants: Record<string, (copy: Job, step: Step) => void> = {
    'missing job bound': copy => { delete copy['timeout-minutes']; },
    'missing step bound': (_, step) => { delete step['timeout-minutes']; },
    'step bound incorrectly nested under with': (_, step) => {
      Object.assign(step, { with: { 'timeout-minutes': step['timeout-minutes'] } });
      delete step['timeout-minutes'];
    },
    'step outlives job': (copy, step) => { step['timeout-minutes'] = copy['timeout-minutes']; },
    'unbounded job': copy => { copy['timeout-minutes'] = 360; },
    'job masks failures': copy => { copy['continue-on-error'] = true; },
    'installer bypasses shared action': (_, step) => { delete step.uses; step.run = 'ffmpeg -version'; },
    'caller overrides pin': (_, step) => { step.with = { version: 'latest' }; },
    'longer install bound': (_, step) => { step['timeout-minutes'] = 4; },
    'step masks failures': (_, step) => { step['continue-on-error'] = true; },
  };
  for (const [label, mutate] of Object.entries(plants)) {
    test(`${file}: rejects ${label} control`, () => {
      const copy = structuredClone(job);
      mutate(copy, copy.steps.find(step => step.name === installerName)!);
      expect(() => checkBound(copy)).toThrow();
    });
  }
}

test('Check reports a failed PR seed through the required job and preserves workflow cancellation', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')) as Workflow;
  const seed = workflow.jobs['video-tools-cache']!;
  const check = workflow.jobs.check!;
  expect(seed.if).toBe("github.event_name == 'pull_request'");
  expect(check.needs).toBe('video-tools-cache');
  expect(check.if).toBe('${{ !cancelled() }}');
  const guard = check.steps[0]!;
  expect(guard.name).toBe('Require the expected video tools seed result');
  expect(guard.if).toBeUndefined();
  expect(guard['continue-on-error']).toBeUndefined();
  expect(guard.env).toEqual({
    EVENT: '${{ github.event_name }}',
    SEED_RESULT: '${{ needs.video-tools-cache.result }}',
  });
  for (const event of ['pull_request', 'push']) {
    for (const seedResult of ['success', 'skipped', 'failure', 'cancelled']) {
      const result = Bun.spawnSync(['bash', '-e', '-c', guard.run!], {
        env: { ...process.env, EVENT: event, SEED_RESULT: seedResult },
      });
      const accepted = (event === 'pull_request' && seedResult === 'success') ||
        (event === 'push' && seedResult === 'skipped');
      expect(result.exitCode).toBe(accepted ? 0 : 1);
      if (!accepted) expect(result.stdout.toString()).toContain('VIDEO_TOOLS_SEED:');
    }
  }
  const required = check.steps.filter(step => step.run && step !== guard);
  expect(required.map(step => step.run)).toEqual([
    'bun install --frozen-lockfile', 'bun run check:readme', 'bun run typecheck',
    'bun test', 'bun run build', 'bun run check -- examples/demo/review.json',
  ]);
  for (const step of required) {
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
  }
});
