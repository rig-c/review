import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {JOB_ERROR_CODES} from '../src/job-contract.ts';
import {tr} from '../web/i18n.ts';

test('#1273: docs/REVIEW_PACKAGE.md error codes bullet matches src/job-contract.ts JOB_ERROR_CODES', () => {
  const reviewPackage = readFileSync(new URL('../docs/REVIEW_PACKAGE.md', import.meta.url), 'utf8');
  const bullets = reviewPackage
    .split(/\r?\n/u)
    .filter(line => /^-\s+\*\*Error codes\.\*\*/u.test(line.trimStart()));
  expect(bullets).toHaveLength(1);

  const parenMatch = /\(([^)]*)\)/u.exec(bullets[0]!);
  expect(parenMatch).not.toBeNull();

  const docCodes = [...parenMatch![1]!.matchAll(/`([^`]+)`/gu)].map(match => match[1]!);
  const sourceSet = new Set<string>(JOB_ERROR_CODES);
  const docSet = new Set<string>(docCodes);
  const missing = JOB_ERROR_CODES.filter(code => !docSet.has(code));
  const extra = [...docSet].filter(code => !sourceSet.has(code));
  const duplicates = [...new Set(docCodes.filter((code, index) => docCodes.indexOf(code) !== index))];

  expect(
    {missing, extra},
    `docs/REVIEW_PACKAGE.md JOB_ERROR_CODES parity failed (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
  ).toEqual({missing: [], extra: []});
  expect(
    duplicates,
    `docs/REVIEW_PACKAGE.md JOB_ERROR_CODES contains duplicates: ${duplicates.join(', ')}`,
  ).toEqual([]);
  expect(docCodes).toEqual([...JOB_ERROR_CODES]);
});

test('#1316 direction take refusal preserves its code and artifact details in both languages', () => {
  const detail = 'DIRECTION_TAKE_MISMATCH: direction.json take.loop differs from idle in producer/scene.json';
  expect(tr(detail, 'en')).toBe(detail);
  expect(tr(detail, 'ko')).toBe('DIRECTION_TAKE_MISMATCH: direction.json의 take.loop 값이 producer/scene.json의 idle 트랙과 달라요.');
});
