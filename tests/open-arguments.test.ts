import {expect, test} from 'bun:test';
import {main, parseOpenInputs, parseOpenTargets} from '../src/cli.ts';

test('single-target open retains existing options and literal option values', () => {
  const cases = [
    ['out', '--animation', 'idle', '--view-only'],
    ['out', '--direct', '--control', '--reference', 'reference.mov'],
    ['a', '--compare', 'b', '--reference', 'reference.mov', '--animation', 'walk'],
    ['out', '--animation', '--help'],
    ['out', '--animation', '--format'],
    ['out', '--config', 'config.json', '--parts', 'parts'],
    ['out', '--project', 'project', '--project-version', '1', '--picks-dir', 'picks'],
  ];
  for (const args of cases) expect(parseOpenTargets(args)).toEqual([parseOpenInputs([...args])]);
});

test('batch open keeps operand order, common options and indexed animation precedence', () => {
  const args = ['a', 'b', 'c', '--animation', 'idle', '--animation-for', '2', 'walk', '--view-only'];
  const before = [...args];
  expect(parseOpenTargets(args)).toEqual([
    {input: 'a', animation: 'idle', viewOnly: true},
    {input: 'b', animation: 'walk', viewOnly: true},
    {input: 'c', animation: 'idle', viewOnly: true},
  ]);
  expect(args).toEqual(before);
  expect(parseOpenTargets(['a', '--animation-for', '2', 'walk', 'b', '--animation', 'idle']))
    .toEqual([{input: 'a', animation: 'idle'}, {input: 'b', animation: 'walk'}]);
  expect(parseOpenTargets(['a', 'b', '--animation-for', '1', '--help', '--animation-for', '2', '--format']))
    .toEqual([{input: 'a', animation: '--help'}, {input: 'b', animation: '--format'}]);
  const nine = Array.from({length: 9}, (_, index) => `synthetic-${index + 1}`);
  expect(parseOpenTargets([...nine, '--animation', 'idle', '--animation-for', '9', 'walk', '--view-only']))
    .toEqual(nine.map((input, index) => ({input, animation: index === 8 ? 'walk' : 'idle', viewOnly: true})));
});

test('batch parser refuses malformed, repeated and out-of-range target indices', () => {
  for (const index of ['0', '-1', '1.0', '01', 'x', '9007199254740992']) {
    expect(() => parseOpenTargets(['a', '--animation-for', index, 'idle']))
      .toThrow('OPEN_OPTION_INVALID --animation-for');
  }
  for (const rest of [[], ['1'], ['1', '']]) {
    expect(() => parseOpenTargets(['a', '--animation-for', ...rest]))
      .toThrow('OPEN_OPTION_INVALID --animation-for');
  }
  expect(() => parseOpenTargets(['a', '--animation-for', '2', 'idle'])).toThrow('target index 2 exceeds 1');
  expect(() => parseOpenTargets(['a', '--animation-for', '1', 'idle', '--animation-for', '1', 'walk']))
    .toThrow('duplicate target index 1');
});

test('direct and compare stay single-target, with named batch refusals', () => {
  expect(parseOpenTargets(['a', '--direct'])).toEqual([{input: 'a', direct: true}]);
  expect(() => parseOpenTargets(['a', 'b', '--direct'])).toThrow('OPEN_OPTION_INVALID --direct');
  expect(() => parseOpenTargets(['a', 'b', '--compare', 'c', '--reference', 'reference.mov']))
    .toThrow('OPEN_OPTION_INVALID --compare');
});

test('existing duplicate, unknown and missing-value option refusals remain named', () => {
  for (const args of [
    ['a', '--animation', 'idle', '--animation', 'walk'],
    ['a', '--view-only', '--view-only'],
    ['a', '--unknown', 'value'],
    ['a', '--animation'],
  ]) {
    expect(() => parseOpenTargets(args)).toThrow('OPEN_OPTION_INVALID');
  }
});

test('CLI validates every designated input before starting a workspace', async () => {
  await expect(main(['open', 'synthetic-missing-cp2-a', 'synthetic-missing-cp2-b', '--animation', 'idle', '--view-only']))
    .rejects.toThrow('OPEN_INPUT_MISSING');
});

test('entry-point help scanning respects batch operands and indexed animation value ownership', async () => {
  for (const input of [
    {args: ['open', 'a', 'b', '--animation-for', '2', '--help', '--help'], exit: 0, help: true},
    {args: ['open', 'synthetic-missing-cp1-open-input', '--animation-for', '1', '--help'], exit: 1, help: false},
    {args: ['open', 'a', '--animation-for', '--help', 'idle'], exit: 1, help: false},
  ]) {
    const child = Bun.spawn([process.execPath, 'src/entry.ts', ...input.args], {stdout: 'pipe', stderr: 'pipe'});
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(exit).toBe(input.exit);
    if (input.help) {
      expect(stdout).toContain('Usage: rig-review open');
      expect(stderr).toBe('');
    } else {
      expect(stdout).toBe('');
      expect(stderr).toContain('OPEN_');
    }
  }
});
