import { expect, test } from 'bun:test';
import type { CdpSession } from './parts-explorer-browser.ts';
import { freshWalkReopen } from './helpers/walk-reopen.ts';

const handoff = 'http://127.0.0.1:4318/instances/review/?lang=en#cap=opaque';
const step = 'en-stage4.reopen';

function probe(loaders: Array<string | undefined>, persist = false) {
  let current: Record<string, unknown> = {};
  const previous = current;
  const visits: unknown[][] = [];
  const records: unknown[][] = [];
  const page: Pick<CdpSession, 'goto' | 'evaluate'> = {
    async goto(url, locale, observe) {
      visits.push([url,locale]);
      const loaderId = loaders.shift();
      observe?.({loaderId});
      if (!persist) current = {};
    },
    async evaluate<T>(expression: string): Promise<T> {
      return new Function('window', 'return ' + expression)(current);
    },
  };
  return {
    previous, visits, records,
    run: () => freshWalkReopen(page,handoff,'en',step,7,
      key => records.push([key]), (key,detail) => records.push([key,detail])),
  };
}

test('reopen proves both loader IDs and absence of the previous document sentinel', async () => {
  const {previous, visits, records, run} = probe(['blank-loader','handoff-loader']);
  await run();
  expect(previous.__walkDoc).toBe('en-7');
  expect(visits).toEqual([['about:blank',undefined],[handoff,'en']]);
  expect(records).toEqual([
    [step + '.sentinel'], [step + '.blank'],
    ['reopen.loader',{step:step + '.blank',loaderId:'blank-loader'}],
    [step + '.handoff'], ['reopen.loader',{step:step + '.handoff',loaderId:'handoff-loader'}],
    [step + '.document'], ['reopen.fresh',{step}],
  ]);
});

test('a same-document response fails by name at either reopen hop', async () => {
  for (const [ids,failed,attempts] of [
    [[undefined],'blank',1],
    [['blank-loader',undefined],'handoff',2],
  ] as const) {
    const {visits,records,run} = probe([...ids]);
    await expect(run()).rejects.toThrow('REOPEN_SAME_DOCUMENT: ' + step + '.' + failed);
    expect(visits).toHaveLength(attempts);
    expect(records.at(-1)).toEqual(['reopen.loader',{step:step + '.' + failed,loaderId:null}]);
  }
});

test('loader metadata cannot substitute for a lost sentinel', async () => {
  const {records,run} = probe(['blank-loader','handoff-loader'], true);
  await expect(run()).rejects.toThrow('REOPEN_SENTINEL_PERSISTED: ' + step);
  expect(records.at(-1)).toEqual([step + '.document']);
});
