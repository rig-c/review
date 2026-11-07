import { expect, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  evaluatePanelInBrowser, measurePartsExplorerPanel, PARTS_EXPLORER_DEADLINES,
  PARTS_EXPLORER_READINESS, waitForPartsExplorerReady, type CdpSession, type PanelMeasurement,
} from './parts-explorer-browser.ts';

const viewport = { width: 1440, height: 900 };
const caseId = 'self-compare-1440x900';
const longestSlot = 'hem_ownership_lower_back_drape_panel';

function fixture({ play = true, disabled = false, a = true, b = true, rig = true, rows = true } = {}) {
  return {
    getElementById(id: string) {
      expect(id).toBe('play');
      return play ? { disabled } : null;
    },
    querySelector(selector: string) {
      switch (selector) {
        case '#a-root canvas, #a-root img': return a ? {} : null;
        case '#b-root canvas, #b-root img': return b ? {} : null;
        case '#rig-root canvas, #rig-root img': return rig ? {} : null;
        default: throw Error('Unexpected selector: ' + selector);
      }
    },
    querySelectorAll(selector: string) {
      expect(selector).toBe('[data-part-list] li button[data-slot]');
      return rows ? [{}] : [];
    },
  };
}

test('declared Parts Explorer deadlines preserve readiness and the GREEN-derived measurement cap', () => {
  expect<Record<keyof typeof PARTS_EXPLORER_DEADLINES, number>>(PARTS_EXPLORER_DEADLINES).toEqual({
    PARTS_EXPLORER_READY: 600 * 25,
    PARTS_EXPLORER_MEASURE: Math.ceil(939.538594 * 4 / 1_000) * 1_000,
  });
});

const negatives: [PanelMeasurement['pageKind'], string, Parameters<typeof fixture>[0]][] = [
  ['compare', 'missing Play', { play: false }],
  ['compare', 'disabled Play', { disabled: true }],
  ['compare', 'missing A render', { a: false }],
  ['compare', 'missing B render', { b: false }],
  ['compare', 'no part rows', { rows: false }],
  ['single', 'missing rig render', { rig: false }],
  ['single', 'no part rows', { rows: false }],
];

for (const [kind, label, options] of negatives) {
  test(`${kind} readiness rejects ${label} with all other clauses satisfied`, () => {
    const ready = PARTS_EXPLORER_READINESS[kind];
    expect(runInNewContext(ready, { document: fixture() })).toEqual({ ready: true, failed: [] });
    expect(runInNewContext(ready, { document: fixture(options) })).toEqual({ ready: false, failed: [label] });
  });
}

// Drive the real deadline helper's scheduled callback without waiting wall-clock seconds.
async function expireDefault(
  expectedMs: number,
  name: string,
  start: () => Promise<unknown>,
  diagnostic = '',
) {
  const timers: { callback: () => void; ms: number | undefined }[] = [];
  const schedule = (callback: () => void, ms?: number) => {
    timers.push({ callback, ms });
    return 0 as unknown as ReturnType<typeof setTimeout>;
  };
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(schedule as typeof setTimeout);
  try {
    const pending = start();
    void pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    for (const timer of timers) timer.callback();
    expect(timers.map(timer => timer.ms)).toEqual([expectedMs]);
    await expect(pending).rejects.toThrow(`WALK_DEADLINE: ${name} (${expectedMs}ms)${diagnostic}`);
  } finally {
    set.mockRestore();
  }
}

test('actual readiness call without an override expires at 15000 ms and ignores a late CDP reply', async () => {
  let complete!: (result: { ready: boolean; failed: string[] }) => void;
  const expressions: string[] = [];
  const page = {
    evaluate<T>(expression: string) {
      expressions.push(expression);
      return new Promise<{ ready: boolean; failed: string[] }>(resolve => { complete = resolve; }) as Promise<T>;
    },
  };
  await expireDefault(15_000, 'PARTS_EXPLORER_READY', () => waitForPartsExplorerReady(page, 'compare'));
  complete({ ready: false, failed: ['missing B render'] });
  await Bun.sleep(30);
  expect(expressions).toEqual([PARTS_EXPLORER_READINESS.compare]);
});

test('actual measurement call without an override expires at 4000 ms after one dispatch', async () => {
  let calls = 0;
  const page = {
    evaluate<T>(): Promise<T> {
      calls++;
      return new Promise<T>(() => {});
    },
  };
  await expireDefault(4_000, 'PARTS_EXPLORER_MEASURE',
    () => measurePartsExplorerPanel(page, caseId, 'compare', viewport, longestSlot));
  expect(calls).toBe(1);
});

test('readiness rejects a late true reply by monotonic clock before the timer fires', async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(0);
  try {
    const page = {
      async evaluate<T>(): Promise<T> {
        clock.mockReturnValue(15_001);
        return { ready: true, failed: [] } as T;
      },
    };
    await expect(waitForPartsExplorerReady(page, 'compare'))
      .rejects.toThrow('WALK_DEADLINE: PARTS_EXPLORER_READY (15000ms)');
  } finally {
    clock.mockRestore();
  }
});

test('readiness retains the latest failed clauses on a reply past the monotonic limit', async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(0);
  try {
    const page = {
      async evaluate<T>(expression: string): Promise<T> {
        clock.mockReturnValue(15_001);
        return runInNewContext(expression, { document: fixture({ a: false, rows: false }) }) as T;
      },
    };
    await expect(waitForPartsExplorerReady(page, 'compare'))
      .rejects.toThrow('WALK_DEADLINE: PARTS_EXPLORER_READY (15000ms); last readiness failures: missing A render, no part rows');
  } finally {
    clock.mockRestore();
  }
});

test('measurement rejects a late reply by monotonic clock before the timer fires', async () => {
  const clock = spyOn(performance, 'now').mockReturnValue(0);
  try {
    const page = {
      async evaluate<T>(): Promise<T> {
        clock.mockReturnValue(4_001);
        return { caseId } as T;
      },
    };
    await expect(measurePartsExplorerPanel(page, caseId, 'compare', viewport, longestSlot))
      .rejects.toThrow('WALK_DEADLINE: PARTS_EXPLORER_MEASURE (4000ms)');
  } finally {
    clock.mockRestore();
  }
});

function panelSession(evaluate: CdpSession['evaluate'], actions: string[]): CdpSession {
  return {
    evaluate,
    async setViewport(width, height) { actions.push(`viewport ${width}×${height}`); },
    async goto() { throw Error('unexpected navigation'); },
    async screenshot() { throw Error('unexpected screenshot'); },
    async close() { throw Error('caller owns close'); },
  };
}

test('normal panel call polls before measuring and returns the complete selected measurement', async () => {
  const actions: string[] = [];
  const envelopes: NonNullable<Parameters<typeof evaluatePanelInBrowser>[5]> = [];
  let polls = 0;
  const measurement = { caseId, pageKind: 'compare', viewport, longestSlotName: longestSlot, rowCount: 40 };
  const page = panelSession(async <T>(expression: string) => {
    if (expression === PARTS_EXPLORER_READINESS.compare) {
      actions.push('ready');
      return runInNewContext(expression, { document: fixture({ b: ++polls === 2 }) }) as T;
    }
    actions.push('measure');
    expect(expression).toContain('PARTS_EXPLORER_COMPARE_PRECONDITION');
    expect(expression).toContain('PARTS_EXPLORER_SECOND_ROW_DISCONNECTED');
    return measurement as T;
  }, actions);
  expect<unknown>(await evaluatePanelInBrowser(page, caseId, 'compare', viewport, longestSlot, envelopes)).toBe(measurement);
  expect(actions).toEqual(['viewport 1440×900', 'ready', 'ready', 'measure']);
  expect(envelopes).toHaveLength(1);
  const { caseId: measuredCase, readinessMs, measureMs, combinedMs } = envelopes[0]!;
  expect(Object.keys(envelopes[0]!).sort()).toEqual(['caseId', 'combinedMs', 'measureMs', 'readinessMs']);
  expect(measuredCase).toBe(caseId);
  expect([readinessMs, measureMs, combinedMs].every(ms => Number.isFinite(ms) && ms >= 0)).toBe(true);
  expect(combinedMs).toBeCloseTo(readinessMs + measureMs, 9);
});

test('unready normal panel expires before measurement or an extra page query', async () => {
  const actions: string[] = [];
  const page = panelSession(async <T>(expression: string) => {
    actions.push('ready');
    expect(expression).toBe(PARTS_EXPLORER_READINESS.single);
    return runInNewContext(expression, { document: fixture({ rig: false }) }) as T;
  }, actions);
  // The viewport await happens before the waiter schedules its timer.
  await expireDefault(15_000, 'PARTS_EXPLORER_READY', async () => {
    return evaluatePanelInBrowser(page, caseId, 'single', viewport, longestSlot);
  }, '; last readiness failures: missing rig render');
  expect(actions).toEqual(['viewport 1440×900', 'ready']);
});

test('measurement preserves the page selector diagnostic', async () => {
  const page = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        document: { querySelector: () => null, getElementById: () => null },
        window: { dispatchEvent() {} },
        Event,
        requestAnimationFrame: (callback: () => void) => callback(),
        setTimeout: (callback: () => void) => callback(),
      }) as T;
    },
  };
  await expect(measurePartsExplorerPanel(page, caseId, 'single', viewport, longestSlot))
    .rejects.toThrow('Missing #parts-explorer or [data-part-list]');
});
