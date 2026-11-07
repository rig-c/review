import {expect, test} from 'bun:test';
import {main, parseOpenInputs, parseOpenTargets, parseForegroundTargets} from '../src/cli.ts';

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


test('foreground multi consumes option values and preserves single dispatch', () => {
  for (const args of [['a', '--port', '0'], ['a', '--reference', 'second-folder'],
    ['a', '--animation', '--help'], ['a', '--checkpoint', 'intro']]) expect(parseForegroundTargets(args)).toBeNull();
  const parsed = parseForegroundTargets(['a', '--reference', 'video', 'b', '--animation', 'idle',
    '--animation-for', '2', 'walk', '--view-only', '--control', '--port', '4321']);
  expect(parsed).toEqual({help: false, port: 4321, targets: [
    {input: 'a', reference: 'video', animation: 'idle', viewOnly: true, control: true},
    {input: 'b', reference: 'video', animation: 'walk', viewOnly: true, control: true},
  ]});
  expect(parseForegroundTargets(['a', 'b', '--animation-for', '2', '--help', '--help'])?.help).toBe(true);
  expect(parseForegroundTargets(['a', 'b', '--animation-for', '2', '--help'])?.targets[1]?.animation).toBe('--help');
});

test('foreground multi refuses unsupported options, invalid ports and indexed overrides', () => {
  for (const flag of ['--checkpoint', '--compare', '--direct', '--project', '--project-version', '--picks-dir']) {
    expect(() => parseForegroundTargets(['a', 'b', flag, 'value'])).toThrow('OPEN_OPTION_INVALID');
  }
  for (const port of ['0', '-1', '65536', 'no', '1.5']) {
    expect(() => parseForegroundTargets(['a', 'b', '--port', port])).toThrow('OPEN_OPTION_INVALID --port');
  }
  expect(() => parseForegroundTargets(['a', 'b', '--port', '4321', '--port', '4321'])).toThrow('OPEN_OPTION_INVALID --port');
  for (const args of [['--animation-for', '3', 'idle'], ['--animation-for', '0', 'idle'],
    ['--animation-for', '1', 'idle', '--animation-for', '1', 'walk']]) {
    expect(() => parseForegroundTargets(['a', 'b', ...args])).toThrow('OPEN_OPTION_INVALID --animation-for');
  }
});


test('foreground classification leaves unknown options to the legacy validator before help', async () => {
  for (const args of [
    ['synthetic-missing-help-input', '--unknown', 'value', '--help'],
    ['synthetic-missing-help-input', '--unknown', '--help'],
  ]) expect(parseForegroundTargets(args)).toBeNull();
  const child = Bun.spawn([process.execPath, 'src/entry.ts', 'synthetic-missing-help-input', '--unknown', 'value', '--help'],
    {stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe('');
  expect(stderr.split('\n')[0]).toBe('Unknown option --unknown');
});

test('foreground multi help preserves common and indexed literal help values', () => {
  expect(parseForegroundTargets(['a', 'b', '--animation', '--help'])?.targets.map(target => target.animation))
    .toEqual(['--help', '--help']);
  expect(parseForegroundTargets(['a', 'b', '--animation', '--help', '--help'])?.help).toBe(true);
  expect(parseForegroundTargets(['a', 'b', '--animation-for', '2', '--help'])?.targets[1]?.animation).toBe('--help');
  expect(parseForegroundTargets(['a', 'b', '--animation-for', '2', '--help', '--help'])?.help).toBe(true);
});
