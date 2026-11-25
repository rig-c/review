/** #908 ordinary Nova: approve, synthetic CLI ingest while open, then stale stage approval.
 * The child models the consumer's project-record write, not installed Create ingest conformance. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const at = Bun.argv.indexOf('--out');
const output = resolve(at < 0 ? 'artifacts/908' : Bun.argv[at + 1]!);
await mkdir(output, {recursive: true});
const cases: unknown[] = [];
for (const language of ['en', 'ko'] as const) {
  const fixture = await scriptedJobWindowFixture({c5Parts: 'mesh'});
  const profile = await mkdtemp(join(tmpdir(), 'review-908-chromium-'));
  const responses: {path: string; status: number}[] = [];
  let page: Awaited<ReturnType<typeof launchCdpSession>> | undefined;
  try {
    const publication = await fixture.publish('parts');
    const verdict = await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    const url = new URL(fixture.host.ownerUrl);
    const actsUrl = new URL('ui/acts', url);
    let send: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
    page = await launchCdpSession(profile, {onEvent(event, command) {
      send = command;
      if (event.method !== 'Network.responseReceived') return;
      const response = event.params?.response as {url?: string; status: number} | undefined;
      if (response?.url === actsUrl.href) responses.push({path: actsUrl.pathname, status: response.status});
    }});
    await send!('Network.enable');
    await page.setViewport(1600, 1000);
    url.searchParams.set('lang', language);
    await page.goto(url.href);
    async function wait(expression: string, label: string, ready = () => true) {
      const until = Date.now() + 20000;
      while (Date.now() < until) {
        if (ready() && await page!.evaluate<boolean>(expression)) return;
        await Bun.sleep(25);
      }
      throw new Error('908_WAIT ' + label);
    }
    const catalog = language === 'en' ? enCatalog : koCatalog;
    await wait(`document.body.dataset.ready === 'true' && !document.querySelector('#save').disabled`, 'parts ready');
    const before = await jobInputHashes(fixture.input.root);
    await click(page, '#save');
    // A clean, pending review also uses the saved draft state.
    await wait(`(() => {
      const state = document.getElementById('review-draft-state');
      return state?.dataset.saveState === 'saved' && state.textContent === ${JSON.stringify(catalog['job.review.approved'])};
    })()`, 'verdict approved after act POST', () => responses[0]?.status === 200);
    const next = await fixture.next();
    const approved = next.events.find(event => event.type === 'act' && event.act.askId === verdict.askId);
    assert.ok(approved && approved.type === 'act' && approved.act.kind === 'parts-verdict');
    assert.equal(approved.act.value.verdict, 'approved');
    assert.deepEqual(await jobInputHashes(fixture.input.root), before, 'UI approval leaves producer inputs immutable');

    // Only this fixture's project record changes; no Review state or fabricated act is ingested.
    const record = join(fixture.input.root, 'project.json');
    const ingestSource = `import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[1], '\\n'); console.log('SYNTHETIC_CLI_INGEST_RECORD_WRITE');`;
    const ingest = Bun.spawn([process.execPath, '-e', ingestSource, record], {stdout: 'pipe', stderr: 'pipe'});
    const ingestExit = await ingest.exited;
    const ingestStdout = await new Response(ingest.stdout).text();
    const ingestStderr = await new Response(ingest.stderr).text();
    assert.equal(ingestExit, 0, ingestStderr);
    const after = await jobInputHashes(fixture.input.root);
    assert.deepEqual(Object.keys(before).filter(path => before[path] !== after[path]), ['project.json']);
    const ingestedRecord = await readFile(record, 'utf8');
    assert.doesNotThrow(() => JSON.parse(ingestedRecord));
    // #1229 / #1230: record and modal ask forms are retired; submit a post-ingest comment via Send comments (act@10) so assertJobSourceCurrent triggers translated JOB_RECORD_MOVED.
    if (!await page.evaluate<boolean>(`!!document.querySelector('[data-comment-general]')?.checkVisibility()`)) {
      await click(page, '#stage-comment');
    }
    await wait(`!!document.querySelector('[data-comment-general]')?.checkVisibility() && !document.querySelector('[data-comment-general]').disabled`, 'general comment button ready');
    await page.evaluate(`document.querySelector('[data-comment-general]').scrollIntoView({block: 'nearest'})`);
    await click(page, '[data-comment-general]');
    await wait(`!!document.querySelector('.stage-comment-composer input')`, 'general comment composer');
    await page.evaluate(`(() => {
      const form = document.querySelector('.stage-comment-composer');
      form.querySelector('input').value = ${JSON.stringify('Post-ingest comment · ' + language)};
      form.requestSubmit();
    })()`);
    await wait(`!document.querySelector('.stage-comment-composer') && !document.getElementById('send-comments').hidden && !document.getElementById('send-comments').disabled`, 'Send comments enabled');
    await click(page, '#send-comments');
    const expected = catalog['Review was not submitted: {0}']!.replace('{0}', catalog['job.submit.refused']!);
    await wait(`(() => {
      const state = document.getElementById('review-draft-state');
      return state?.dataset.saveState === 'failed' && state.textContent === ${JSON.stringify(expected)};
    })()`, 'translated moved-record refusal', () => responses[1]?.status === 409);
    const status = await page.evaluate<any>(`(() => {
      const n = document.getElementById('review-draft-state'), r = n.getBoundingClientRect(), s = getComputedStyle(n);
      return {text: n.textContent, title: n.title, x: r.x, y: r.y, width: r.width, height: r.height,
        display: s.display, visibility: s.visibility, language: document.documentElement.lang,
        enabled: !document.getElementById('send-comments').disabled};
    })()`);
    const expectedTitlePrefix = (language === 'ko' ? koCatalog['JOB_RECORD_MOVED']! : 'JOB_RECORD_MOVED') + ' · POST ';
    assert.ok(status.title.startsWith(expectedTitlePrefix), status.title);
    assert.equal(status.text, expected, status.text);
    assert.equal(status.language, language);
    assert.equal(status.enabled, true);
    assert.equal(status.visibility, 'visible');
    assert.notEqual(status.display, 'none');
    assert.ok(status.width > 0 && status.height > 0 && status.x >= 0 && status.x + status.width <= 1600 && status.y >= 0 && status.y + status.height <= 1000);
    assert.deepEqual(responses.map(response => response.status), [200, 409]);
    const final = await fixture.next();
    assert.equal(final.events.filter(event => event.type === 'act').length, 1, 'stale Send comments creates no second act');
    await writeFile(join(output, 'record-moved-' + language + '.png'), await page.screenshot());
    const observation = {language, fixture: 'synthetic package and consumer CLI record write; not installed Create ingest', approvedActId: approved.act.actId, status, responses, ingest: {exit: ingestExit, stdout: ingestStdout, stderr: ingestStderr}, recordHashes: {before: before['project.json'], after: after['project.json']}};
    cases.push(observation);
    await writeFile(join(output, 'record-moved-' + language + '.json'), JSON.stringify(observation, null, 2) + '\n');
    console.log('908_BROWSER_PASS ' + language + ' approve=200 synthetic-cli-ingest=0 comments=409');
  } catch (error) {
    if (page) await writeFile(join(output, 'failure-' + language + '.png'), await page.screenshot());
    throw error;
  } finally {
    await page?.close();
    await fixture.close();
    await rm(profile, {recursive: true, force: true});
    await writeFile(join(output, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
  }
}
