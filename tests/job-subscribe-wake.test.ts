import {afterEach, expect, spyOn, test} from 'bun:test';
import type {JobOwnerHost} from '../src/job-host.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {attachedPair as pair} from './helpers/job-attach-fixture.ts';

// Synthetic fixtures only. These pin subscribe's existing wake on a strict
// attachment (#1005 must not narrow it); they run unchanged at 63e37b4.
const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
const hosts: JobOwnerHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop();
  for (const f of fixtures.splice(0)) await f.close();
});

test('subscribe wakes on a republish of the same job', async () => {
  const {owner, attached, publish, cursor} = await pair(fixtures, hosts);
  const controller = new AbortController();
  const iterator = attached.ports.subscribeJob({jobId: attached.session.jobId, after: cursor, signal: controller.signal})[Symbol.asyncIterator]();
  try {
    const first = iterator.next();
    await Bun.sleep(100);
    const started = performance.now();
    const republished = await publish();
    expect(republished.ok).toBe(true);
    const woke = await first;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(woke.done).toBe(false);
    expect(woke.value?.type).toBe('published');
    expect((woke.value as {publication: {publicationId: string}}).publication.publicationId).toBe(republished.value.publicationId);
    expect(owner.session.jobId).toBe(attached.session.jobId);
  } finally {
    controller.abort();
    await iterator.return?.();
  }
});

/** A progress update (#987) commits to the shared job store without a durable event.
 * main has no progress verb yet, so the display receipt stands in: it is the
 * existing commit with exactly that shape (revision advances, no event). */
test('subscribe wakes on a progress update with no act', async () => {
  const {attached, display, cursor} = await pair(fixtures, hosts);
  const session = attached.session as unknown as {next: (...args: unknown[]) => Promise<unknown>};
  const reads = spyOn(session, 'next');
  const controller = new AbortController();
  const iterator = attached.ports.subscribeJob({jobId: attached.session.jobId, after: cursor, signal: controller.signal})[Symbol.asyncIterator]();
  const pending = iterator.next();
  void pending.catch(() => {});
  try {
    await Bun.sleep(100);
    expect(reads).toHaveBeenCalledTimes(1);
    const revision = (attached.session as unknown as {store: {revision(id: string): number}}).store.revision(attached.session.jobId);
    await display('page-progress');
    const deadline = performance.now() + 1500;
    while (reads.mock.calls.length < 2 && performance.now() < deadline) await Bun.sleep(25);
    // The no-event write advanced the shared revision and woke the subscriber's wait into a new read.
    expect((attached.session as unknown as {store: {revision(id: string): number}}).store.revision(attached.session.jobId)).toBe(revision + 1);
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2);
  } finally {
    controller.abort();
    await iterator.return?.();
    reads.mockRestore();
  }
});
