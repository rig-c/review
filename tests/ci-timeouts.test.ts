import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Step = {
  name?: string;
  run?: string;
  if?: string;
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Job = {
  steps: Step[];
  'timeout-minutes'?: number;
  'continue-on-error'?: boolean;
};
type Workflow = { jobs: Record<string, Job> };
const installerName = 'Install reference video export tools';
const commands = [
  'sudo apt-get update',
  'sudo apt-get install --no-install-recommends -y ffmpeg',
  'ffmpeg -version',
  'ffprobe -version',
];

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
  expect(installer.run?.trim().split('\n').map(line => line.trim())).toEqual(commands);
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
    } else expect(installer.if).toBeUndefined();
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
    'step masks failures': (_, step) => { step['continue-on-error'] = true; },
  };
  for (const command of commands) {
    plants[`missing ${command}`] = (_, step) => { step.run = step.run!.replace(command, ''); };
  }
  for (const [label, mutate] of Object.entries(plants)) {
    test(`${file}: rejects ${label} control`, () => {
      const copy = structuredClone(job);
      mutate(copy, copy.steps.find(step => step.name === installerName)!);
      expect(() => checkBound(copy)).toThrow();
    });
  }
}
