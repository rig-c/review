import {expect, test} from 'bun:test';
import {createRetainedFrameStage} from '../web/retained-frame-stage.ts';

function host(visibilityOrder: 'before-state' | 'after-state', languageChange: 'selection' | 'visibility', limit = 2) {
  const appended: HTMLIFrameElement[] = [], messages: unknown[] = [], trace: string[] = [];
  let language = 'en';
  const stage = createRetainedFrameStage<{key: string; frame: HTMLIFrameElement; sourceHash: string}>({
    stage: {append(frame: HTMLIFrameElement) {appended.push(frame);}} as unknown as HTMLElement,
    limit: () => limit, key: entry => entry.key, message: entry => ({schema: 'existing/1', key: entry.key, sourceHash: entry.sourceHash}),
    origin: 'http://127.0.0.1:4318', language: () => language, visibilityOrder, languageChange,
  });
  function frame(key: string) {
    let hidden = true, inert = false;
    const attributes = new Map<string, string>();
    return {key, sourceHash: key.repeat(64), frame: {
      get hidden() {return hidden;}, set hidden(value: boolean) {hidden = value; trace.push(key + ':hidden:' + value);},
      get inert() {return inert;}, set inert(value: boolean) {inert = value; trace.push(key + ':inert:' + value);},
      setAttribute(name: string, value: string) {attributes.set(name, value); trace.push(key + ':' + name + ':' + value);},
      contentWindow: {postMessage(data: unknown, origin: string) {messages.push({data, origin, hidden, inert, aria: attributes.get('aria-hidden')}); trace.push(key + ':message');}},
    } as unknown as HTMLIFrameElement};
  }
  return {stage, frame, appended, messages, trace, language(value: string) {language = value;}, limit(value: number) {limit = value;}};
}

for (const order of ['before-state', 'after-state'] as const) {
  test(order + ' preserves retained window identity, selection flags and exact visibility ordering', () => {
    const h = host(order, 'selection'), a = h.frame('a'), b = h.frame('b');
    expect(h.stage.selected).toBeNull(); expect(h.stage.atLimit()).toBe(false);
    h.stage.retain(a); h.stage.retain(b); expect(h.stage.atLimit()).toBe(true);
    h.stage.select('a');
    const flags = ['a:hidden:false', 'a:inert:false', 'a:aria-hidden:false'];
    expect(h.trace.slice(0, 4)).toEqual(order === 'before-state' ? ['a:message', ...flags] : [...flags, 'a:message']);
    expect(h.messages[0]).toEqual({data: {schema: 'existing/1', key: 'a', sourceHash: 'a'.repeat(64), visible: true, language: 'en'},
      origin: 'http://127.0.0.1:4318', hidden: order === 'before-state', inert: false, aria: order === 'before-state' ? undefined : 'false'});
    h.stage.select('b'); h.stage.select('a');
    expect(h.stage.get('a')).toBe(a); expect(h.appended).toEqual([a.frame, b.frame]);
    expect(a.frame.hidden).toBe(false); expect(b.frame.hidden).toBe(true); expect(b.frame.inert).toBe(true);
    h.limit(3); expect(h.stage.atLimit()).toBe(false);
    h.stage.select('closed-without-frame'); expect(a.frame.hidden).toBe(true); expect(b.frame.hidden).toBe(true);
    expect(h.appended).toHaveLength(2);
  });
}

test('language policy preserves owner notification-only behavior and hub selection reapplication', () => {
  for (const policy of ['visibility', 'selection'] as const) {
    const h = host('after-state', policy), a = h.frame('a'); h.stage.retain(a); h.stage.select('a');
    a.frame.hidden = true; a.frame.inert = true; h.trace.length = 0; h.messages.length = 0; h.language('ko');
    h.stage.languageChanged();
    expect(a.frame.hidden).toBe(policy === 'visibility'); expect(a.frame.inert).toBe(policy === 'visibility');
    expect(h.trace).toEqual(policy === 'visibility' ? ['a:message'] : ['a:hidden:false', 'a:inert:false', 'a:aria-hidden:false', 'a:message']);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({data: {visible: true, language: 'ko'}});
  }
});

test('selection intent invalidates delayed grants on a newer selection or dispose without evicting retained drafts', () => {
  const h = host('after-state', 'selection');
  const first = h.stage.beginSelection(); expect(h.stage.isCurrent(first)).toBe(true);
  const second = h.stage.beginSelection(); expect(h.stage.isCurrent(first)).toBe(false); expect(h.stage.isCurrent(second)).toBe(true);
  const a = h.frame('a'); h.stage.retain(a); h.stage.select('a');
  h.stage.dispose(); h.stage.dispose(); expect(h.stage.isCurrent(second)).toBe(false);
  expect(h.stage.isCurrent(h.stage.beginSelection())).toBe(false); expect(h.stage.get('a')).toBe(a);
  expect(h.appended).toEqual([a.frame]);
});

test('an absent contentWindow is tolerated, and ready notification does not mutate frame state', () => {
  const h = host('before-state', 'visibility'), a = h.frame('a'); h.stage.retain(a);
  h.stage.visibility(a); expect(h.trace).toEqual(['a:message']);
  expect(h.messages[0]).toMatchObject({data: {visible: false}});
  Object.defineProperty(a.frame, 'contentWindow', {value: null});
  h.stage.select('a'); expect(a.frame.hidden).toBe(false); expect(a.frame.inert).toBe(false);
  expect(h.messages).toHaveLength(1);
});
