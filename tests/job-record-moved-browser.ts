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
    const ctx = fixture.input.getContext();
    const qFiles = fixture.question.images.flatMap(img => img.ref ? [img.ref] : []);
    const questionSubject = {kind: 'interview-picks' as const, questionId: fixture.question.set.question, setId: fixture.question.set.id};
    fixture.input.setContext({...ctx, files: [...ctx.files, ...qFiles], subjects: [...ctx.subjects, questionSubject]});
    const publication = await fixture.publish('parts');
    const verdict = await fixture.ask(publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
    // #1229: converted from retired checkpoint Pass/Fail form to interview-picks so stale project.json submission still exercises translated JOB_RECORD_MOVED.
    const interview = await fixture.ask(publication, questionSubject);
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
    await wait(`!document.querySelector('#workspace-pending-ask').hidden && !document.querySelector('#workspace-pending-ask').disabled`, 'question offered');
    await click(page, '#workspace-pending-ask');
    const form = `#workspace-interview-answer form[data-job-ask="${interview.askId}"]`;
    await wait(`!!document.querySelector('#workspace-communication:not([hidden]) #workspace-interview-answer:not([hidden]) form[data-job-ask="${interview.askId}"] fieldset:not(:disabled)')`, 'existing question in the communication panel');
    await page.evaluate(`(()=>{const seen=new Set();for(const radio of document.querySelectorAll(${JSON.stringify(form + ' input[type=radio]')}))if(!seen.has(radio.name)){seen.add(radio.name);radio.click();}})()`);
    await page.evaluate(`document.querySelector(${JSON.stringify(form + ' button[type=submit]')}).scrollIntoView({block:'center'})`);
    await click(page, form + ' button[type=submit]');
    const expected = catalog['Review was not submitted: {0}']!.replace('{0}', catalog['job.submit.refused']!);
    await wait(`document.querySelector(${JSON.stringify(form + ' > [role=status]')})?.textContent === ${JSON.stringify(expected)}`, 'translated moved-record refusal', () => responses[1]?.status === 409);
    const status = await page.evaluate<any>(`(()=>{const n=document.querySelector(${JSON.stringify(form + ' > [role=status]')}),r=n.getBoundingClientRect(),s=getComputedStyle(n);return {text:n.textContent,title:n.title,x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,language:document.documentElement.lang,panelOpen:!!document.querySelector('#workspace-communication:not([hidden]) #workspace-interview-answer:not([hidden])'),enabled:!document.querySelector(${JSON.stringify(form + ' fieldset')}).disabled};})()`);
    assert.ok(status.title.startsWith('JOB_RECORD_MOVED'), status.title);
    assert.equal(status.text, expected, status.text);
    assert.equal(status.language, language);
    // #1041 B: the refusal stays readable in the communication panel.
    assert.equal(status.panelOpen, true, 'question section stays shown');
    assert.equal(status.enabled, true);
    assert.equal(status.visibility, 'visible');
    assert.notEqual(status.display, 'none');
    assert.ok(status.width > 0 && status.height > 0 && status.x >= 0 && status.x + status.width <= 1600 && status.y >= 0 && status.y + status.height <= 1000);
    assert.deepEqual(responses.map(response => response.status), [200, 409]);
    const final = await fixture.next();
    assert.equal(final.events.filter(event => event.type === 'act').length, 1, 'stale question creates no second act');
    await writeFile(join(output, 'record-moved-' + language + '.png'), await page.screenshot());
    const observation = {language, fixture: 'synthetic package and consumer CLI record write; not installed Create ingest', approvedActId: approved.act.actId, interviewAskId: interview.askId, status, responses, ingest: {exit: ingestExit, stdout: ingestStdout, stderr: ingestStderr}, recordHashes: {before: before['project.json'], after: after['project.json']}};
    cases.push(observation);
    await writeFile(join(output, 'record-moved-' + language + '.json'), JSON.stringify(observation, null, 2) + '\n');
    console.log('908_BROWSER_PASS ' + language + ' approve=200 synthetic-cli-ingest=0 interview=409');
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
