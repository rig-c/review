import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { settleCorrectionMesh } from './correction-handoff-browser.ts';

function meshPage(apply: () => unknown, part = 'torso') {
  const actions: unknown[] = [];
  const reads: string[] = [];
  const window = {
    rigReviewEditor: {
      mesh: {
        part: () => part,
        set: (path: string[], value: number) => { actions.push({path, value}); },
        apply: () => {
          actions.push('apply');
          return apply();
        },
      },
    },
  };
  return {
    actions,
    reads,
    async evaluate<T>(expression: string): Promise<T> {
      reads.push(expression);
      return runInNewContext(expression, {window}) as T;
    },
  };
}

test('planted slow Apply hits the named deadline and stops reading without a second dispatch', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const page = meshPage(() => pending);
  await expect(settleCorrectionMesh(page, 450)).rejects.toThrow(
    'WALK_DEADLINE: CORRECTION_HANDOFF_MESH_SETTLE (450ms)',
  );
  expect(page.actions).toEqual([{path: ['contour', 'spacing'], value: 18}, 'apply']);
  const readsAtExpiry = page.reads.length;
  expect(readsAtExpiry).toBeGreaterThan(1);
  finish({status: 'built', check: {pass: true}});
  await Bun.sleep(50);
  expect(page.reads).toHaveLength(readsAtExpiry);
  expect(page.actions).toHaveLength(2);
});

test('a successful Apply returns its full job and a rejection surfaces its cause', async () => {
  const job = {status: 'built', check: {pass: true}, modelHash: 'fixture'};
  const success = meshPage(() => Promise.resolve(job));
  expect(await settleCorrectionMesh(success)).toEqual(job);
  expect(success.actions).toHaveLength(2);

  const rejected = meshPage(() => Promise.reject(Error('planted producer rejection')));
  await expect(settleCorrectionMesh(rejected)).rejects.toThrow('planted producer rejection');
  expect(rejected.actions).toHaveLength(2);
});

test('wrong part refuses before touching the mesh', async () => {
  const page = meshPage(() => { throw Error('Apply must not run'); }, 'badge');
  await expect(settleCorrectionMesh(page)).rejects.toThrow('WRONG_PARAMETER_PART');
  expect(page.actions).toEqual([]);
  expect(page.reads).toHaveLength(1);
});

test('an ambiguous dispatch failure propagates without a retry or readback', async () => {
  const page = meshPage(() => new Promise(() => {}));
  await expect(settleCorrectionMesh({
    async evaluate<T>(expression: string): Promise<T> {
      await page.evaluate(expression);
      throw Error('CDP response lost');
    },
  })).rejects.toThrow('CDP response lost');
  expect(page.actions).toHaveLength(2);
  expect(page.reads).toHaveLength(1);
});
