import {expect, test} from 'bun:test';
import {hashCapabilityAccess} from '../web/instance-access.ts';

const origin = 'http://127.0.0.1:4318', token = 'a'.repeat(64);
function memory() {
  const values = new Map<string, string>();
  return {values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {values.set(key, value);}};
}

test('hash handoff writes exactly the supplied slot before stripping the hash, and reload recovers only that slot', () => {
  const storage = memory(), calls: string[] = [];
  const read = (href: string, slot: string) => hashCapabilityAccess(new URL(href), slot, () => storage,
    value => {calls.push(value); expect(storage.values.get('host:one')).toBe(token);}, {strip: 'always-after-storage', storedValue: 'validate', fallback: ''});
  expect(read(origin + '/?lang=ko#cap=' + token, 'host:one')).toBe(token);
  expect(calls).toEqual([origin + '/?lang=ko']);
  expect(read(origin + '/', 'host:one')).toBe(token);
  expect(read(origin + '/', 'host:two')).toBe('');
  expect(storage.values.size).toBe(1);
});

for (const policy of ['validate', 'preserve'] as const) {
  test(policy + ' still validates every new fragment and falls back to the saved slot', () => {
    const storage = memory(); storage.values.set('slot', token);
    for (const hash of ['', '#other=value', '#cap=short', '#cap=' + 'A'.repeat(64), '#cap=' + token + '&extra=1']) {
      let replaced = '';
      expect(hashCapabilityAccess(new URL(origin + '/?lang=en' + hash), 'slot', () => storage,
        value => {replaced = value;}, {strip: 'always-after-storage', storedValue: policy, fallback: ''})).toBe(token);
      expect(replaced).toBe(origin + '/?lang=en');
      expect(storage.values.get('slot')).toBe(token);
    }
  });
  test(policy + ' tolerates denied storage lookup, read and write while retaining a valid in-memory handoff', () => {
    const denied = () => {throw new Error('denied');};
    const broken = {getItem: denied, setItem: denied};
    for (const storage of [denied, () => broken, () => null]) {
      expect(hashCapabilityAccess(new URL(origin + '/#cap=' + token), 'slot', storage, () => {}, {strip: 'always-after-storage', storedValue: policy, fallback: ''})).toBe(token);
      expect(hashCapabilityAccess(new URL(origin + '/#cap=short'), 'slot', storage, () => {}, {strip: 'always-after-storage', storedValue: policy, fallback: ''})).toBe('');
    }
  });
}

test('the hub revalidates saved values while the owner intentionally preserves its historical stored-value behavior', () => {
  const storage = memory(); storage.values.set('slot', 'historical malformed value');
  expect(hashCapabilityAccess(new URL(origin), 'slot', () => storage, () => {}, {strip: 'always-after-storage', storedValue: 'validate', fallback: ''})).toBe('');
  expect(hashCapabilityAccess(new URL(origin), 'slot', () => storage, () => {}, {strip: 'always-after-storage', storedValue: 'preserve', fallback: ''})).toBe('historical malformed value');
  expect(storage.values.get('slot')).toBe('historical malformed value');
});

test('one core preserves each caller stripping order and saved-value policy with a configurable value check', () => {
  for (const strip of ['cap-before-storage', 'always-after-storage'] as const) {
    for (const storedValue of ['validate', 'preserve'] as const) {
      for (const hash of ['#cap=opaque', '#cap=invalid', '#other=retained', '']) {
        const calls: string[] = [], url = new URL(origin + '/' + hash);
        const storage = {getItem: () => {calls.push('get'); return 'saved-malformed';},
          setItem: (_slot: string, value: string) => {calls.push('set:' + value);}};
        const capability = hashCapabilityAccess(url, 'custom-slot', () => storage, () => {calls.push('replace');},
          {strip, storedValue, fallback: null, valueCheck: value => value === 'opaque'});
        expect(capability).toBe(hash === '#cap=opaque' ? 'opaque' : storedValue === 'preserve' ? 'saved-malformed' : null);
        const storageCall = hash === '#cap=opaque' ? 'set:opaque' : 'get';
        expect(calls).toEqual(strip === 'always-after-storage' ? [storageCall, 'replace']
          : hash.startsWith('#cap=') ? ['replace', storageCall] : [storageCall]);
        expect(url.hash).toBe(strip === 'always-after-storage' || hash.startsWith('#cap=') ? '' : hash);
      }
    }
  }
});

test('hub and owner always strip last even when storage lookup throws', () => {
  for (const storedValue of ['validate', 'preserve'] as const) {
    const calls: string[] = [];
    expect(hashCapabilityAccess(new URL(origin + '/#other=remove'), 'slot', () => {calls.push('storage'); throw new Error('denied');},
      () => {calls.push('replace');}, {strip: 'always-after-storage', storedValue, fallback: ''})).toBe('');
    expect(calls).toEqual(['storage', 'replace']);
  }
});
