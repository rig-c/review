import {expect,test} from 'bun:test';
import {runInNewContext} from 'node:vm';
import {
  captureStage1Fix,openStage1FixChest,openStage1FixRegion,readStage1RegionParts,STAGE1_FIX_DEADLINES,
  STAGE1_FIX_READINESS,STAGE1_REGION_READ_BASELINE,waitForStage1FixReadiness,
} from './stage1-review-fixes-browser.ts';

const short = {
  PAGE_NOT_READY: 15, STAGE1_PARTS_READY: 15, STAGE1_CHEST_BIND_READY: 15, STAGE1_REGION_PARTS_READ: 15,
};
type Ready = keyof typeof STAGE1_FIX_READINESS;

test('actual defaults match the original cadence and frozen region derivation', () => {
  expect(STAGE1_FIX_DEADLINES).toEqual({
    PAGE_NOT_READY: 10_000, STAGE1_PARTS_READY: 10_000,
    STAGE1_CHEST_BIND_READY: 5_000, STAGE1_REGION_PARTS_READ: 1_000,
  });
  expect(STAGE1_REGION_READ_BASELINE).toEqual({
    enEnvelopeMs: 96.661597, koEnvelopeMs: 71.008236, multiplier: 4, roundUpMs: 1_000,
  });
  const {enEnvelopeMs,koEnvelopeMs,multiplier,roundUpMs} = STAGE1_REGION_READ_BASELINE;
  expect<number>(STAGE1_FIX_DEADLINES.PAGE_NOT_READY).toBe(400 * 25);
  expect<number>(STAGE1_FIX_DEADLINES.STAGE1_PARTS_READY).toBe(400 * 25);
  expect<number>(STAGE1_FIX_DEADLINES.STAGE1_CHEST_BIND_READY).toBe(200 * 25);
  expect<number>(STAGE1_FIX_DEADLINES.STAGE1_REGION_PARTS_READ)
    .toBe(Math.ceil(multiplier * Math.max(enEnvelopeMs,koEnvelopeMs) / roundUpMs) * roundUpMs);
});

function fixture({
  editor = true, handoff = 'Ready', hidden = false, missingDocument = false, marker = 'true',
  stage = '3', pressed = 'true', missingChest = false, request = fetch as NonNullable<Parameters<typeof readStage1RegionParts>[1]>,
} = {}) {
  const actions: string[] = [];
  const reads: string[] = [];
  const frame = {contentDocument: missingDocument ? null : {
    body: {dataset: {ready: marker}},
    querySelector(selector: string) {
      if (selector === '#pv-corrections button') return {title: 'torsoB · correction', click: () => actions.push('correction')};
      if (selector === '#pv-corrections') return {textContent: 'direct correction'};
      if (selector === 'canvas') { actions.push('canvas'); return {}; }
      if (/^\[data-pv-item="torsoB?"\]$/.test(selector)) return {click: () => actions.push(selector)};
      throw Error(selector);
    },
    querySelectorAll: () => [],
  }};
  const globals = {
    window: {rigReviewEditor: editor ? {} : undefined},
    document: {
      documentElement: {dataset: {inspectionStage: stage}},
      getElementById(id: string) {
        if (id === 'handoff-line') return handoff === 'missing' ? null : {textContent: handoff};
        if (id === 'chest-edit') return missingChest ? null : {getAttribute: () => pressed};
        throw Error(id);
      },
      querySelector(selector: string) {
        if (selector === '[data-review-stage="1"]') return {click() { actions.push('stage'); }};
        if (!selector.startsWith('.review-stage-panel iframe')) throw Error(selector);
        return hidden && selector.includes(':not([hidden])') ? null : frame;
      },
    },
    fetch: request, AbortController, performance, setTimeout, clearTimeout,
  };
  return {
    actions,reads,
    async evaluate<T>(expression: string): Promise<T> {
      reads.push(expression);
      return runInNewContext(expression,globals) as T;
    },
  };
}

const negatives: [Ready,string,Parameters<typeof fixture>[0]][] = [
  ['PAGE_NOT_READY','no editor',{editor:false}],
  ['PAGE_NOT_READY','no handoff',{handoff:'missing'}],
  ['PAGE_NOT_READY','empty handoff',{handoff:''}],
  ['PAGE_NOT_READY','reading handoff',{handoff:'Reading producer'}],
  ['STAGE1_PARTS_READY','hidden iframe',{hidden:true}],
  ['STAGE1_PARTS_READY','no iframe document',{missingDocument:true}],
  ['STAGE1_PARTS_READY','truthy false marker',{marker:'false'}],
  ['STAGE1_PARTS_READY','empty marker',{marker:''}],
  ['STAGE1_CHEST_BIND_READY','wrong stage with pressed button',{stage:'2'}],
  ['STAGE1_CHEST_BIND_READY','correct stage with unpressed button',{pressed:'false'}],
  ['STAGE1_CHEST_BIND_READY','no chest button',{missingChest:true}],
];

for (const [name,label,options] of negatives) {
  test(`${name} rejects ${label} through the actual waiter`, async () => {
    const page = fixture(options);
    await expect(waitForStage1FixReadiness(page,name,short[name])).rejects.toThrow(`WALK_DEADLINE: ${name}`);
    expect(page.reads[0]).toBe(STAGE1_FIX_READINESS[name]);
    expect(page.actions).toEqual([]);
  });
}

test('positive readiness and one-shot chest actions retain order', async () => {
  const page = fixture();
  await waitForStage1FixReadiness(page,'PAGE_NOT_READY');
  await openStage1FixChest(page,'torsoB');
  expect(page.actions).toEqual(['stage','[data-pv-item="torsoB"]','correction']);
});

test('parts and chest expiry stop the actual action flow', async () => {
  const parts = fixture({marker:'false'});
  const chest = fixture({pressed:'false'});
  await expect(openStage1FixChest(parts,'torsoB',short)).rejects.toThrow('WALK_DEADLINE: STAGE1_PARTS_READY');
  expect(parts.actions).toEqual(['stage']);
  await expect(openStage1FixChest(chest,'torsoB',short)).rejects.toThrow('WALK_DEADLINE: STAGE1_CHEST_BIND_READY');
  expect(chest.actions).toEqual(['stage','[data-pv-item="torsoB"]','correction']);
});

test('late readiness never dispatches a follow-up command', async () => {
  let finish!: (ready: boolean) => void;
  let calls = 0;
  const page = {
    async evaluate<T>(): Promise<T> {
      calls++;
      return new Promise<boolean>(resolve => { finish = resolve; }) as Promise<T>;
    },
  };
  await expect(waitForStage1FixReadiness(page,'PAGE_NOT_READY',short.PAGE_NOT_READY))
    .rejects.toThrow('WALK_DEADLINE: PAGE_NOT_READY');
  finish(true);
  await Bun.sleep(30);
  expect(calls).toBe(1);
});

for (const stalled of ['headers','body'] as const) {
  test(`region deadline aborts stalled ${stalled} and stops before canvas or retry`, async () => {
    let requested = 0, bodies = 0;
    let signal: AbortSignal | null | undefined;
    const request: NonNullable<Parameters<typeof readStage1RegionParts>[1]> = async (url, init) => {
      expect(url).toBe('/api/stage-parts');
      signal = init?.signal;
      requested++;
      const pending = () => new Promise<never>((_, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once:true});
      });
      if (stalled === 'headers') return pending();
      return {json() { bodies++; return pending(); }};
    };
    const page = fixture({request});
    await expect(openStage1FixRegion(page,short)).rejects.toThrow('WALK_DEADLINE: STAGE1_REGION_PARTS_READ');
    expect(signal?.aborted).toBe(true);
    expect(requested).toBe(1);
    expect(bodies).toBe(stalled === 'body' ? 1 : 0);
    expect(page.actions).toEqual(['stage','[data-pv-item="torso"]']);
  });
}

test('region body success preserves output and non-timeout errors', async () => {
  const request = async () => Response.json({items:[{name:'torso'}]});
  const page = fixture({request});
  expect(await openStage1FixRegion(page)).toEqual({
    text:'direct correction', buttons:0, data:{items:[{name:'torso'}]}, canvas:true,
  });
  expect(page.actions).toEqual(['stage','[data-pv-item="torso"]','canvas']);
  const broken = async () => new Response('not JSON');
  await expect(readStage1RegionParts(100,broken)).rejects.toBeInstanceOf(SyntaxError);
});

test('an ambiguous Apply evaluation is sent once without replay', async () => {
  let commands = 0;
  let actions = 0;
  const page = {
    async evaluate<T>(expression: string): Promise<T> {
      commands++;
      const window = {captured: [] as object[]};
      const button = {disabled:false, click() { actions++; window.captured.push({part:'torso'}); }};
      await runInNewContext(expression, {window, document:{getElementById: () => button}});
      throw Error('CDP.Runtime.evaluate: ambiguous response');
    },
  };
  await expect(captureStage1Fix(page)).rejects.toThrow('ambiguous response');
  expect(commands).toBe(1);
  expect(actions).toBe(1);
});
