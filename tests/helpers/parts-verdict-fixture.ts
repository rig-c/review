import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {buildVerdict, type PartsViewPackage} from '../../src/parts-view.ts';

/** Seed a historical reader fixture in a disposable test directory. */
export async function seedPartsVerdictFixture(pkg: PartsViewPackage, input: unknown, by?: string) {
  const verdict = buildVerdict(pkg, input, '4.24.0', new Date('2026-11-27T00:00:00.000Z'), by);
  await mkdir(dirname(pkg.verdictPath), {recursive: true});
  await writeFile(pkg.verdictPath, JSON.stringify(verdict, null, 2) + '\n');
  return verdict;
}
