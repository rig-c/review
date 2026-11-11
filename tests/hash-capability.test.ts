import {expect, test} from 'bun:test';
import {hashCapabilityAccess} from '../web/hash-capability.ts';

const origin = 'http://127.0.0.1:4318', token = 'a'.repeat(64);
function memory() {
  const values = new Map<string, string>();
  return {values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {values.set(key, value);}};
}

test('hash handoff writes exactly the supplied slot before stripping the hash, and reload recovers only that slot', () => {
  const storage = memory(), calls: string[] = [];
  const read = (href: string, slot: string) => hashCapabilityAccess(new URL(href), slot, () => storage,
    value => {calls.push(value); expect(storage.values.get('host:one')).toBe(token);}, 'validate');
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
        value => {replaced = value;}, policy)).toBe(token);
      expect(replaced).toBe(origin + '/?lang=en');
      expect(storage.values.get('slot')).toBe(token);
    }
  });
  test(policy + ' tolerates denied storage lookup, read and write while retaining a valid in-memory handoff', () => {
    const denied = () => {throw new Error('denied');};
    const broken = {getItem: denied, setItem: denied};
    for (const storage of [denied, () => broken, () => null]) {
      expect(hashCapabilityAccess(new URL(origin + '/#cap=' + token), 'slot', storage, () => {}, policy)).toBe(token);
      expect(hashCapabilityAccess(new URL(origin + '/#cap=short'), 'slot', storage, () => {}, policy)).toBe('');
    }
  });
}

test('the hub revalidates saved values while the owner intentionally preserves its historical stored-value behavior', () => {
  const storage = memory(); storage.values.set('slot', 'historical malformed value');
  expect(hashCapabilityAccess(new URL(origin), 'slot', () => storage, () => {}, 'validate')).toBe('');
  expect(hashCapabilityAccess(new URL(origin), 'slot', () => storage, () => {}, 'preserve')).toBe('historical malformed value');
  expect(storage.values.get('slot')).toBe('historical malformed value');
});
