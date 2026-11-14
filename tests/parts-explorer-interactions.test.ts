import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {browserInvocation} from '../scripts/browser-gate.ts';

const runner = readFileSync(new URL('./parts-explorer-browser.ts', import.meta.url), 'utf8');

function runnerBlock(start: string, end: string): string {
  const from = runner.indexOf(start);
  const to = runner.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Parts explorer runner block missing: ' + start);
  return runner.slice(from, to);
}

function row(side: string, slot: string, onClick = () => {}) {
  return {
    dataset: { side, slot },
    isConnected: true,
    pressed: false,
    click: onClick,
    getAttribute(name: string) {
      return name === 'aria-pressed' ? String(this.pressed) : null;
    },
  };
}

const rowSelector = 'li > button[data-slot]';
const selectedRowSelector = rowSelector + '[aria-pressed="true"]';
const secondRowClick = runnerBlock('    let secondRowClickOk = false;', '      const soloInput');

test.each([
  { name: 'follows live physical order after replacement', stale: false },
  { name: 'refuses a detached saved second button before its handler runs', stale: true },
])('second click $name', ({ stale }) => {
  let staleClicks = 0;
  let liveClicks = 0;
  const savedSecond = row('a', 'old-second', () => { staleClicks++; });
  const first = row('a', 'first', () => {
    first.isConnected = false;
    savedSecond.isConnected = false;
    const selected = row('a', 'first');
    selected.pressed = true;
    rows = [row('a', 'old-second'), liveSecond, selected];
  });
  const liveSecond = row('a', 'new-second', () => {
    liveClicks++;
    liveSecond.isConnected = false;
    const selected = row('a', 'new-second');
    selected.pressed = true;
    rows = [selected, row('a', 'old-second')];
  });
  const buttons = [first, savedSecond, row('b', 'new-second')];
  let rows = buttons;
  const list = {
    querySelectorAll(selector: string) {
      if (selector === rowSelector) return rows;
      if (selector === selectedRowSelector) return rows.filter(button => button.pressed);
      throw new Error('Unexpected row selector: ' + selector);
    },
  };
  const liveLookup = "list.querySelectorAll('li > button[data-slot]')[1]";
  expect(secondRowClick).toContain(liveLookup);
  const block = stale ? secondRowClick.replace(liveLookup, 'buttons[1]') : secondRowClick;
  const run = new Function('caseId', 'list', 'buttons', 'let selectionOk;\n' +
    block + '\n}\nreturn { selectionOk, secondRowClickOk };');
  const measure = () => run('self-compare-1440x900', list, buttons);
  if (stale) {
    expect(measure).toThrow('self-compare-1440x900: PARTS_EXPLORER_SECOND_ROW_DISCONNECTED');
  } else {
    expect(measure()).toEqual({ selectionOk: true, secondRowClickOk: true });
    expect(liveSecond.isConnected).toBe(false);
  }
  expect(staleClicks).toBe(0);
  expect(liveClicks).toBe(stale ? 0 : 1);
});

const establishCompare = runnerBlock('    const compareButton =', '    // If in compact drawer mode');
const checkCompare = runnerBlock('    const buttons = [...list.querySelectorAll', '    const listScrollTopBefore');

test.each([
  { width: 460, press: 'restore' },
  { width: 460, press: 'omit' },
  { width: 460, press: 'leave A only' },
  { width: 1440, press: 'restore' },
  { width: 1440, press: 'add row' },
])('Compare mode at press and before sampling ($width, $press)', ({ width, press }) => {
  const wide = width === 1440;
  const stage = { dataset: { workspaceMode: wide ? 'compare' : 'setup' } };
  const a = row('a', 'first');
  const b = row('b', 'first');
  let rows = wide ? [a, b] : [a];
  let actionClicks = 0;
  let samplingLookups = 0;
  let samples = 0;
  const compare = row('', '', () => {
    actionClicks++;
    compare.pressed = true;
    stage.dataset.workspaceMode = 'compare';
    if (press === 'add row') rows = [a, b, row('a', 'added')];
    else if (press !== 'leave A only') rows = [a, b];
  });
  compare.pressed = wide;
  const document = {
    querySelector(selector: string) {
      expect(selector).toBe('.mode-switch [data-mode="compare"]');
      return compare;
    },
    querySelectorAll(selector: string) {
      expect(selector).toBe('#parts-explorer [data-part-list] ' + rowSelector);
      return rows;
    },
    getElementById(id: string) {
      expect(id).toBe('stage-layout');
      return stage;
    },
  };
  const list = {
    querySelectorAll(selector: string) {
      expect(selector).toBe(rowSelector);
      samplingLookups++;
      // Even if layout restored B before sampling, it was missing at press.
      return press === 'leave A only' ? [a, b] : rows;
    },
  };
  expect(establishCompare).toContain('compareButton?.click();');
  const action = press === 'omit' ? establishCompare.replace('compareButton?.click();', '') : establishCompare;
  const run = new Function('caseId', 'pageKind', 'document', 'list', 'collectToolsSnapshot',
    action + checkCompare + '\nreturn compareModeTransition;');
  const measure = () => run('self-compare-' + width + 'x900', 'compare', document, list, () => { samples++; });
  if (press === 'omit') {
    expect(measure).toThrow('self-compare-460x900: PARTS_EXPLORER_COMPARE_PRECONDITION: ' +
      'mode=setup, comparePressed=false, visibleSides=["a"]; side B rows/images/drawn=0/0/0');
  } else if (press === 'leave A only') {
    expect(measure).toThrow('self-compare-460x900: PARTS_EXPLORER_COMPARE_PRECONDITION: ' +
      'mode=compare, comparePressed=true, visibleSides=["a"]; side B rows/images/drawn=0/0/0');
  } else if (press === 'add row') {
    expect(measure).toThrow('self-compare-1440x900: PARTS_EXPLORER_COMPARE_PRESS_CHANGED_WIDE');
  } else {
    const after = { mode: 'compare', comparePressed: 'true', visibleSides: ['a', 'b'], rows: 2, sideARows: 1, sideBRows: 1 };
    const before = wide ? after :
      { mode: 'setup', comparePressed: 'false', visibleSides: ['a'], rows: 1, sideARows: 1, sideBRows: 0 };
    expect(measure()).toEqual({ before, after });
  }
  expect(actionClicks).toBe(press === 'omit' ? 0 : 1);
  expect(samplingLookups).toBe(press === 'restore' ? 1 : 0);
  expect(samples).toBe(press === 'restore' ? 1 : 0);
});

test('Check runs discovered browser shards without masking failures and always uploads Parts measurements', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')) as any;
  const job=workflow.jobs.browser;
  expect(job.needs).toContain('browser-plan');
  expect(job.strategy['fail-fast']).toBe(false);
  expect(job.strategy.matrix.shard).toEqual([1,2,3,4]);
  expect(job['continue-on-error']??false).toBe(false);
  const verify=job.steps.find((step:any)=>step.name==='Verify browser shard in Chrome');
  expect(verify.run).toContain('bun scripts/browser-gate.ts --shard ${{ matrix.shard }}');
  expect(verify['continue-on-error']??false).toBe(false);
  const upload=job.steps.find((step:any)=>step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload.if).toBe('${{ always() }}');expect(upload.with['if-no-files-found']).toBe('error');
  expect(job.steps.indexOf(upload)).toBeGreaterThan(job.steps.indexOf(verify));
  const invocation=browserInvocation('tests/parts-explorer-browser.ts','default','/tmp/measurements');
  expect(invocation.env.OUT_JSON).toBe('/tmp/measurements/report.json');expect(invocation.env.NO_ASSERT).toBeUndefined();
});

const mouseDispatch = runnerBlock('      async mouse(', '      async touch(');

test('launchCdpSession.mouse preserves button left during held mouseMoved while keeping hover, press, release, and wheel payloads exact', async () => {
  const dispatched: Array<{ method: string; params: Record<string, unknown>; sessionId: string }> = [];
  const send = async (method: string, params: Record<string, unknown>, sessionId: string) => {
    dispatched.push({ method, params, sessionId });
  };
  const session = new Function(
    'send',
    'sessionId',
    'let mouseButtons = 0;\nreturn {\n' + mouseDispatch + '\n};',
  )(send, 'session-1') as {
    mouse(
      type: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel',
      x: number,
      y: number,
      deltaY?: number,
    ): Promise<void>;
  };

  await session.mouse('mouseMoved', 1120, 215);
  await session.mouse('mousePressed', 1135.25, 226);
  await session.mouse('mouseMoved', 1153.25, 237);
  await session.mouse('mouseReleased', 1153.25, 237);
  await session.mouse('mouseMoved', 1160, 245);
  await session.mouse('mouseWheel', 1160, 245, -120);

  expect(dispatched).toEqual([
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 1120, y: 215, buttons: 0 },
      sessionId: 'session-1',
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1135.25, y: 226, buttons: 1, button: 'left', clickCount: 1 },
      sessionId: 'session-1',
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 1153.25, y: 237, buttons: 1, button: 'left' },
      sessionId: 'session-1',
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseReleased', x: 1153.25, y: 237, buttons: 0, button: 'left', clickCount: 1 },
      sessionId: 'session-1',
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: 1160, y: 245, buttons: 0 },
      sessionId: 'session-1',
    },
    {
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseWheel', x: 1160, y: 245, buttons: 0, deltaX: 0, deltaY: -120 },
      sessionId: 'session-1',
    },
  ]);
  expect('button' in dispatched[0]!.params).toBe(false);
  expect('clickCount' in dispatched[2]!.params).toBe(false);
  expect('button' in dispatched[4]!.params).toBe(false);
});
