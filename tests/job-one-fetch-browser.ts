/** #1050, ordinary Nova only. One request per resource per page load on a direction job page (the model once,
 * `/api/review` once), and no stale content under the cache policy: a republish with new model bytes shows the new
 * model (in place and after a cached reload), and a changed same-URL page file is served whole after revalidation.
 * Run: bun tests/job-one-fetch-browser.ts --out artifacts/job-one-fetch-1050 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createJobFront} from '../src/job-front.ts';
import type {JobPublication} from '../src/job-contract.ts';
import {createJobWindowFixture, scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const at = Bun.argv.indexOf('--out'), output = resolve(at < 0 ? 'artifacts/job-one-fetch-1050' : Bun.argv[at + 1]!);
await mkdir(output, {recursive: true});
const profile = await mkdtemp(join(tmpdir(), 'review-1050-'));
const observations: Record<string, unknown> = {};
let page: InputCdpSession | undefined;
async function wait(expression: string) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {if (await page!.evaluate(expression)) return; await Bun.sleep(25);}
    throw new Error('ONE_FETCH_WAIT ' + expression);
}
type Entry = {name: string; transferSize: number; encodedBodySize: number};
const entries = () => page!.evaluate<Entry[]>(`performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize}))`);
const animations = () => page!.evaluate<string[]>(`[...document.querySelector('#animation-select').options].map(o=>o.value)`);
/** Ready, and the compiled-model readers that follow first paint (part catalog, physics document) have finished. */
const settled = `document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')&&
 document.querySelector('#physics-panel-state')?.textContent!=='Reading the compiled model…'`;
try {
    page = await launchCdpSession(profile);
    await page.setViewport(1440, 900);
    const fixture = await scriptedJobWindowFixture();
    try {
        const routesOf = async (publication: JobPublication) => {
            const descriptor = await (await fetch(fixture.locator + '/publications/' + publication.publicationId)).json();
            const routes = descriptor.value.routes as {apiBase: string; assetsBase: string};
            const metadata = await (await fetch(fixture.host.origin + routes.apiBase + 'review')).json() as {manifest: {model: string}};
            return {review: fixture.host.origin + routes.apiBase + 'review', model: fixture.host.origin + routes.assetsBase + metadata.manifest.model};
        };
        const count = (list: Entry[], url: string) => list.filter(entry => entry.name === url).length;
        const first = await fixture.publish('direction', 'direction-1');
        await fixture.ask(first, {kind: 'review-verdict', stage: 'direction-review'});
        const one = await routesOf(first);
        const url = new URL(fixture.host.ownerUrl);url.searchParams.set('lang', 'en');
        await page.goto(url.href, 'en');
        await wait(settled);
        await Bun.sleep(500);
        const cold = await entries();
        observations.cold = {model: count(cold, one.model), review: count(cold, one.review)};
        assert.equal(count(cold, one.model), 1, 'one model request per load');
        assert.equal(count(cold, one.review), 1, 'one /api/review request per load');
        assert.ok((await animations()).includes('short'), 'first publication draws its own model');

        // Content-addressed: the republished model has new bytes, a new publication and so a new URL.
        const second = await fixture.publish('direction', 'direction-2', {stripShortAnimation: true});
        await fixture.ask(second, {kind: 'review-verdict', stage: 'direction-review'});
        const two = await routesOf(second);
        assert.notEqual(two.model, one.model);
        await wait(`${settled}&&![...document.querySelector('#animation-select').options].some(o=>o.value==='short')`);
        await Bun.sleep(500);
        const live = await entries();
        observations.republished = {model: count(live, two.model), review: count(live, two.review), animations: await animations()};
        assert.equal(count(live, two.model), 1, 'one model request for the republished load');
        assert.equal(count(live, two.review), 1, 'one /api/review request for the republished load');

        // A reload reuses the cached immutable model and still shows the new bytes.
        await page.goto('about:blank');
        await page.goto(url.href, 'en');
        await wait(settled);
        await Bun.sleep(500);
        const warm = await entries();
        const model = warm.filter(entry => entry.name === two.model);
        observations.reload = {model, animations: await animations()};
        assert.equal(model.length, 1);
        assert.equal(model[0]!.transferSize, 0, 'the immutable model is served from the browser cache');
        assert.ok(!(await animations()).includes('short'), 'the cached reload still draws the republished model');
        assert.equal(count(warm, one.model), 0, 'the earlier publication is never requested again');
        await writeFile(join(output, 'job-direction.png'), await page.screenshot());
    } finally {await page.goto('about:blank'); await fixture.close();}

    // Validator-guarded: same-URL page files revalidate, and a changed file reaches the page whole.
    const jobs = createJobWindowFixture();
    let version = 1;
    const css = () => `#marker{color:rgb(${version},2,3)}`;
    let front: ReturnType<typeof createJobFront> | undefined;
    const served: string[] = [];
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async request => {
        const response = await front!.fetch(request) ?? new Response(null, {status: 404});
        // A browser may also ask for favicon.ico (a 404 here); only the two page files are counted.
        served.push(`${new URL(request.url).pathname.split('/').pop() || 'index.html'} ${response.status}`);
        return response;
    }});
    try {
        front = createJobFront({origin: `http://127.0.0.1:${server.port}`, ports: jobs.ports, resource: async name =>
            name === 'styles.css' ? css() : name === 'main.js' ? '' :
            `<!doctype html><title>v${version}</title><link rel="stylesheet" href="styles.css"><p id="marker">v${version}</p>`});
        const pageUrl = `http://127.0.0.1:${server.port}/jobs/window-fixture/`;
        const shown = () => page!.evaluate<{title: string; color: string; styles: Entry | undefined}>(`({title:document.title,color:getComputedStyle(document.querySelector('#marker')).color,
            styles:performance.getEntriesByType('resource').map(e=>({name:e.name,transferSize:e.transferSize,encodedBodySize:e.encodedBodySize})).find(e=>e.name.endsWith('/styles.css'))})`);
        const load = async () => {served.length = 0; await page!.goto('about:blank'); await page!.goto(pageUrl); return {...await shown(), served: served.filter(line => /^(index\.html|styles\.css) /.test(line)).sort()};};
        const v1 = await load();
        const again = await load();
        version = 2;
        const v2 = await load();
        observations.validator = {v1, again, v2};
        assert.equal(v1.title, 'v1');
        assert.equal(v1.color, 'rgb(1, 2, 3)');
        assert.deepEqual(v1.served, ['index.html 200', 'styles.css 200']);
        assert.equal(again.title, 'v1');
        assert.deepEqual(again.served, ['index.html 304', 'styles.css 304'], 'unchanged page files revalidate');
        assert.deepEqual(v2.served, ['index.html 200', 'styles.css 200'], 'changed page files are served whole');
        assert.equal(v2.title, 'v2', 'a changed index.html reaches the page');
        assert.equal(v2.color, 'rgb(2, 2, 3)', 'a changed styles.css reaches the page');
    } finally {await page.goto('about:blank'); front?.stop(); server.stop(true);}
    await writeFile(join(output, 'observations.json'), JSON.stringify({status: 'PASS', observations}, null, 2));
} catch (error) {
    await writeFile(join(output, 'observations.json'), JSON.stringify({status: 'RED', observations, error: String(error)}, null, 2));
    throw error;
} finally {await page?.close(); await rm(profile, {recursive: true, force: true});}
