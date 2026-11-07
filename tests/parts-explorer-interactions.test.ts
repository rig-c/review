import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
    first.pressed = true;
    first.isConnected = false;
    savedSecond.isConnected = false;
    rows = [row('a', 'old-second'), liveSecond];
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
  { width: 460, omitAction: false, changeWideCount: false },
  { width: 460, omitAction: true, changeWideCount: false },
  { width: 1440, omitAction: false, changeWideCount: false },
  { width: 1440, omitAction: false, changeWideCount: true },
])('Compare mode before sampling (%j)', ({ width, omitAction, changeWideCount }) => {
  const wide = width === 1440;
  const stage = { dataset: { workspaceMode: wide ? 'compare' : 'setup' } };
  const a = row('a', 'first');
  const b = row('b', 'first');
  let rows = wide ? [a, b] : [a];
  let actionClicks = 0;
  let samples = 0;
  const compare = row('', '', () => {
    actionClicks++;
    compare.pressed = true;
    stage.dataset.workspaceMode = 'compare';
    rows = changeWideCount ? [a, b, row('a', 'added')] : [a, b];
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
      return rows;
    },
  };
  expect(establishCompare).toContain('compareButton?.click();');
  const action = omitAction ? establishCompare.replace('compareButton?.click();', '') : establishCompare;
  const run = new Function('caseId', 'pageKind', 'document', 'list', 'collectToolsSnapshot',
    action + checkCompare + '\nreturn compareModeTransition;');
  const measure = () => run('self-compare-' + width + 'x900', 'compare', document, list, () => { samples++; });
  if (omitAction) {
    expect(measure).toThrow('self-compare-460x900: PARTS_EXPLORER_COMPARE_PRECONDITION: ' +
      'mode=setup, comparePressed=false, visibleSides=["a"]; side B rows/images/drawn=0/0/0');
  } else if (changeWideCount) {
    expect(measure).toThrow('self-compare-1440x900: PARTS_EXPLORER_COMPARE_PRESS_CHANGED_WIDE');
  } else {
    const after = { mode: 'compare', comparePressed: 'true', visibleSides: ['a', 'b'], rows: 2, sideARows: 1, sideBRows: 1 };
    const before = wide ? after :
      { mode: 'setup', comparePressed: 'false', visibleSides: ['a'], rows: 1, sideARows: 1, sideBRows: 0 };
    expect(measure()).toEqual({ before, after });
  }
  expect(actionClicks).toBe(omitAction ? 0 : 1);
  expect(samples).toBe(omitAction || changeWideCount ? 0 : 1);
});
