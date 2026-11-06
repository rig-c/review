import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCheckpoint, withDeadline } from './helpers/walk-deadline.ts';
import { cdpRequests, navigateCdpPage, navigationReadyExpression } from './parts-explorer-browser.ts';

test('walk deadline aborts a blocked operation with the named error', async () => {
  let abortReason: unknown;
  await expect(withDeadline('en-export.body', 10, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => {
      abortReason = signal.reason;
      reject(signal.reason);
    }, {once:true});
  }))).rejects.toThrow('WALK_DEADLINE: en-export.body (10ms)');
  expect(abortReason).toBeInstanceOf(Error);
});

test('checkpoints are readable before the next operation and increase monotonically', () => {
  const root = mkdtempSync(join(tmpdir(), 'walk-journal-'));
  try {
    const file = join(root, 'walk.jsonl');
    const mark = walkCheckpoint(file);
    mark('en-open');
    expect(JSON.parse(readFileSync(file, 'utf8')).key).toBe('en-open');
    mark('en-navigate');
    const [first, second] = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    expect([first.seq, second.seq, second.key]).toEqual([1, 2, 'en-navigate']);
    expect(second.monotonicms).toBeGreaterThanOrEqual(first.monotonicms);
  } finally {
    rmSync(root, {recursive:true});
  }
});

test('CDP requests schedule no deadline timer by default', async () => {
  const original = globalThis.setTimeout;
  let scheduled = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled++;
    return original(...args);
  }) as typeof setTimeout;
  const sent: number[] = [];
  const requests = cdpRequests(message => sent.push(JSON.parse(message).id));
  let response: Promise<unknown>;
  try {
    response = requests.send('Runtime.evaluate');
  } finally {
    globalThis.setTimeout = original;
  }
  requests.receive({id:sent[0], result:'legacy'});
  expect(await response).toBe('legacy');
  expect(scheduled).toBe(0);
  const pending = requests.send('Runtime.evaluate');
  requests.disconnect('probe');
  await expect(pending).rejects.toThrow('WebSocket closed during Runtime.evaluate');
});

test('opt-in CDP deadlines discard a late reply and disconnect rejects an outstanding command', async () => {
  const sent: number[] = [];
  const requests = cdpRequests(message => sent.push(JSON.parse(message).id), 30);
  await expect(requests.send('Runtime.evaluate')).rejects.toThrow('WALK_DEADLINE: CDP.Runtime.evaluate (30ms)');
  const next = requests.send('Page.captureScreenshot');
  requests.receive({id:sent[0], result:'late'});
  requests.receive({id:sent[1], result:'current'});
  expect(await next).toBe('current');
  const pending = requests.send('Input.dispatchMouseEvent');
  requests.disconnect('probe');
  await expect(pending).rejects.toThrow('WebSocket closed during Input.dispatchMouseEvent');
});

test('CDP disconnect rejects pending and future commands without sending again', async () => {
  for (const timeout of [undefined, 30]) {
    const sent: Array<{id: number; method: string}> = [];
    const requests = cdpRequests(message => sent.push(JSON.parse(message)), timeout);
    const pending = requests.send('Runtime.evaluate');
    requests.disconnect('first close');
    requests.disconnect('second close');
    await expect(pending).rejects.toThrow('WebSocket closed during Runtime.evaluate: first close');
    const future = requests.send('Page.navigate');
    // Reply to a leaked send so the timer-free regression fails without hanging.
    if (sent[1]) requests.receive({id: sent[1].id, result: {}});
    await expect(future).rejects.toThrow('WebSocket closed during Page.navigate: first close');
    expect(sent.map(({method}) => method)).toEqual(['Runtime.evaluate']);
  }
});

function navigationExchange(navigation: {errorText?: string; loaderId?: string}, ready: boolean) {
  const sent: Array<{id: number; method: string; params: Record<string, unknown>; sessionId: string}> = [];
  const requests = cdpRequests(message => {
    const command = JSON.parse(message) as typeof sent[number];
    sent.push(command);
    requests.receive({
      id: command.id,
      result: command.method === 'Page.navigate' ? navigation : {result: {value: ready}},
    });
  });
  return {sent, send: requests.send};
}

test('CDP navigation observes the loader and polls the requested document', async () => {
  const {sent, send} = navigationExchange({loaderId: 'loader'}, true);
  const url = 'http://127.0.0.1:1234/instances/expected/?lang=ko#cap=opaque';
  const observed: Array<{loaderId?: string}> = [];
  await navigateCdpPage(send, 'page', url, 'ko', result => {
    expect(sent.map(({method}) => method)).toEqual(['Page.navigate']);
    observed.push(result);
  });
  expect(observed).toEqual([{loaderId: 'loader'}]);
  expect(sent).toEqual([
    {id: 1, method: 'Page.navigate', params: {url}, sessionId: 'page'},
    {id: 2, method: 'Runtime.evaluate', params: {expression: navigationReadyExpression(url, 'ko'), returnByValue: true}, sessionId: 'page'},
  ]);
});

test('CDP navigation fails on errorText before observing or polling', async () => {
  const {sent, send} = navigationExchange({errorText: 'net::ERR_CONNECTION_REFUSED'}, false);
  await expect(navigateCdpPage(send, 'page', 'http://127.0.0.1:1234/', undefined, () => {
    throw new Error('unexpected loader observation');
  })).rejects.toThrow('CDP_NAVIGATE_FAILED: net::ERR_CONNECTION_REFUSED');
  expect(sent.map(({method}) => method)).toEqual(['Page.navigate']);
});

test('CDP navigation fails after exhausting the existing readiness polls', async () => {
  const {sent, send} = navigationExchange({}, false);
  await expect(navigateCdpPage(send, 'page', 'http://127.0.0.1:1234/')).rejects.toThrow('CDP_NAVIGATION_NOT_READY');
  expect(sent.map(({method}) => method)).toEqual(['Page.navigate', ...Array(100).fill('Runtime.evaluate')]);
}, 10_000);

test('navigation matches managed origin, instance and locale without the capability fragment', () => {
  const url = new URL('http://127.0.0.1:1234/instances/expected/?lang=ko#cap=opaque');
  const check = new Function('location', 'document', 'return ' + navigationReadyExpression(url.href, 'ko'));
  const ready = {readyState:'complete', documentElement:{lang:'ko'}};
  expect(check(new URL(url.href.split('#')[0]!), ready)).toBe(true);
  expect(check(new URL('/instances/old/', url), ready)).toBe(false);
  expect(check(new URL(url.pathname, 'http://127.0.0.1:5432'), ready)).toBe(false);
  expect(check(url, {...ready, documentElement:{lang:'en'}})).toBe(false);
  expect(check(url, {...ready, readyState:'loading'})).toBe(false);
  const ordinary = new Function('location', 'document',
    'return ' + navigationReadyExpression('http://127.0.0.1:1234/?document=2#cap=opaque'));
  expect(ordinary(new URL('http://127.0.0.1:1234/?document=2&checkpoint=new'), ready)).toBe(true);
  expect(ordinary(new URL('http://127.0.0.1:1234/?document=1'), ready)).toBe(false);
});
