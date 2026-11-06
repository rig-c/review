import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCheckpoint, withDeadline } from './helpers/walk-deadline.ts';
import { cdpRequests, navigationReadyExpression } from './parts-explorer-browser.ts';

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

test('CDP deadlines discard a late reply and disconnect rejects an outstanding command', async () => {
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
