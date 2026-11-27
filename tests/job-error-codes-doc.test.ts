import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {JOB_ERROR_CODES} from '../src/job-contract.ts';

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
