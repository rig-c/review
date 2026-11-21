/** #1050: the job front's cache policy, route by route. Capability-bearing and computed responses stay `no-store`;
 * the shipped page files revalidate by a content ETag; sealed snapshot files are immutable under their publication. */
import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createJobFront} from '../src/job-front.ts';
import {createJobWindowFixture, fixturePublication, scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {useTemporaryReviewState} from './helpers/temporary-review-state.ts';

useTemporaryReviewState();
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const IMMUTABLE = 'private, max-age=31536000, immutable';

describe('#1050 job front cache policy', () => {
    test('index.html, main.js and styles.css revalidate by content ETag; a changed file is served whole', async () => {
        const fixture = createJobWindowFixture();
        let version = 1;
        // main.js arrives as a Blob-like bundle in production; the others as text.
        const front = createJobFront({origin: 'http://127.0.0.1:4318', ports: fixture.ports,
            resource: async name => name === 'main.js' ? new Blob([`${name} ${version}`]) : `${name} ${version}`});
        const get = (path: string, headers: Record<string, string> = {}) =>
            front.fetch(new Request('http://127.0.0.1:4318/jobs/window-fixture/' + path, {headers}));
        for (const [path, name] of [['', 'index.html'], ['main.js', 'main.js'], ['styles.css', 'styles.css']] as const) {
            version = 1;
            const first = (await get(path))!;
            expect(first.status).toBe(200);
            expect(first.headers.get('cache-control')).toBe('no-cache');
            const etag = first.headers.get('etag');
            expect(etag).toBe(`"${sha256(`${name} 1`)}"`);
            expect(await first.text()).toBe(`${name} 1`);
            const unchanged = (await get(path, {'If-None-Match': etag!}))!;
            expect(unchanged.status).toBe(304);
            expect(await unchanged.text()).toBe('');
            expect(unchanged.headers.get('etag')).toBe(etag);
            // A new review install serves new bytes at the same URL: the old validator never pins them.
            version = 2;
            const changed = (await get(path, {'If-None-Match': etag!}))!;
            expect(changed.status).toBe(200);
            expect(await changed.text()).toBe(`${name} 2`);
            expect(changed.headers.get('etag')).toBe(`"${sha256(`${name} 2`)}"`);
        }
    });

    test('publication JSON, the event stream and refusals stay no-store', async () => {
        const fixture = createJobWindowFixture();
        const front = createJobFront({origin: 'http://127.0.0.1:4318', ports: fixture.ports, resource: async name => name});
        fixture.publish(fixturePublication(1));
        const base = 'http://127.0.0.1:4318/jobs/window-fixture/';
        const publication = (await front.fetch(new Request(base + 'publications/publication-1')))!;
        expect(publication.status).toBe(200);
        expect(publication.headers.get('cache-control')).toBe('no-store');
        expect(publication.headers.get('etag')).toBeNull();
        const abort = new AbortController();
        const events = (await front.fetch(new Request(base + 'events', {signal: abort.signal})))!;
        expect(events.headers.get('cache-control')).toBe('no-store');
        abort.abort();
        await events.body?.cancel().catch(() => {});
        for (const path of ['unknown-route', 'publications/missing']) {
            const refused = (await front.fetch(new Request(base + path)))!;
            expect(refused.status).toBeGreaterThanOrEqual(400);
            expect(refused.headers.get('cache-control')).toBe('no-store');
        }
        front.stop();
    });

    test('sealed files are immutable under their publication; api JSON is no-store; a republish names new bytes at a new URL', async () => {
        const fixture = await scriptedJobWindowFixture();
        try {
            const read = async (publicationId: string) => {
                const descriptor = await (await fetch(fixture.locator + '/publications/' + publicationId)).json();
                const routes = descriptor.value.routes as {apiBase: string; assetsBase: string};
                const review = await fetch(fixture.host.origin + routes.apiBase + 'review');
                expect(review.headers.get('cache-control')).toBe('no-store');
                expect(review.headers.get('etag')).toBeNull();
                const metadata = await review.json() as {manifest: {model: string}; reviewedSource: {rig: {sha256: string}}};
                const url = fixture.host.origin + routes.assetsBase + metadata.manifest.model;
                const model = await fetch(url);
                expect(model.status).toBe(200);
                expect(model.headers.get('cache-control')).toBe(IMMUTABLE);
                const bytes = new Uint8Array(await model.arrayBuffer());
                expect(model.headers.get('etag')).toBe(`"${sha256(bytes)}"`);
                expect(sha256(bytes)).toBe(metadata.reviewedSource.rig.sha256);
                const revalidated = await fetch(url, {headers: {'If-None-Match': model.headers.get('etag')!}});
                expect(revalidated.status).toBe(304);
                expect(revalidated.headers.get('cache-control')).toBe(IMMUTABLE);
                const mismatched = await fetch(url, {headers: {'If-None-Match': '"' + '0'.repeat(64) + '"'}});
                expect(mismatched.status).toBe(200);
                await mismatched.arrayBuffer();
                return {url, hash: sha256(bytes)};
            };
            const first = await read((await fixture.publish('direction', 'direction-1')).publicationId);
            const second = await read((await fixture.publish('direction', 'direction-2', {stripShortAnimation: true})).publicationId);
            expect(second.hash).not.toBe(first.hash);
            expect(second.url).not.toBe(first.url);
        } finally {await fixture.close();}
    });
});
