/** #1226 direct Bun script; ordinary Nova only. Synthetic scripted job window fixture, owned headless Chromium.
 * Send comments with no ask records one act@10 with no askId; sent rows stay listed as Submitted;
 * a later Request changes carries only rows that were not already sent on their own (CONTRACT §1). EN and KO.
 * Run: bun tests/job-comment-send-browser.ts --out artifacts/job-comment-send-1226
 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const at = Bun.argv.indexOf('--out');
const output = resolve(at < 0 ? 'artifacts/job-comment-send-1226' : Bun.argv[at + 1]!);
await mkdir(output, {recursive: true});

type Act = {schema: string; kind: string; askId?: string; value: Record<string, unknown>};
const words = {
  en: ['The left shoulder joint sits too high.', 'The motion reads a little fast overall.', 'The hip pivots too early.'],
  ko: ['왼쪽 어깨 관절이 너무 높아요.', '전체적으로 움직임이 조금 빨라요.', '골반이 너무 일찍 돌아요.'],
} as const;

async function wait(page: InputCdpSession, expression: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(60);}
  const state = await page.evaluate<unknown>(`(()=>({state:document.getElementById('review-draft-state')?.textContent,
    message:document.getElementById('review-message')?.textContent,send:document.getElementById('send-comments')?.outerHTML}))()`).catch(String);
  throw new Error('COMMENT_SEND_WAIT ' + expression + ' ' + JSON.stringify(state));
}

async function acts(fixture: Awaited<ReturnType<typeof scriptedJobWindowFixture>>): Promise<Act[]> {
  const next = await fixture.next() as unknown as {events?: readonly {act?: Act}[]};
  return (next.events ?? []).flatMap(event => event.act ? [event.act] : []);
}

async function run(lang: 'en' | 'ko') {
  const catalog = lang === 'en' ? enCatalog : koCatalog;
  const fixture = await scriptedJobWindowFixture({c5Parts: 'mesh'});
  let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
  const page = await launchCdpSession(await mkdtemp(join(tmpdir(), 'review-1226-')), {sendDeadlineMs: 20_000,
    onEvent(event, send) {if (event.sessionId) control = send;}});
  try {
    const publication = await fixture.publish('rig', 'rig');
    const url = new URL(fixture.host.ownerUrl); url.searchParams.set('lang', lang);
    await page.setViewport(1440, 900);
    await page.goto(url.href);
    await wait(page, `document.body?.dataset.ready==='true'`, 30_000);
    const save = async (text: string) => {
      await wait(page, `!!document.querySelector('.stage-comment-composer input')`);
      // The text reaches the field as typed input data, never spliced into evaluated code.
      await page.evaluate(`(()=>{const field=document.querySelector('.stage-comment-composer input');field.focus();field.select();})()`);
      assert.ok(control, 'CDP page session');
      await control('Input.insertText', {text});
      await page.evaluate(`document.querySelector('.stage-comment-composer').requestSubmit()`);
      await wait(page, `!document.querySelector('.stage-comment-composer')`);
    };
    const general = async (text: string) => {
      await wait(page, `!!document.querySelector('[data-comment-general]:not(:disabled)')`);
      await page.evaluate(`document.querySelector('[data-comment-general]').click()`);
      await save(text);
    };
    // With no ask: the act bar carries Send comments and the approved headline.
    await wait(page, `!!document.getElementById('send-comments')&&!document.getElementById('send-comments').hidden`);
    assert.equal(await page.evaluate<string>(`document.getElementById('send-comments').textContent`), catalog['Send comments']);
    assert.equal(await page.evaluate<string>(`document.getElementById('workspace-ask-headline').textContent`),
      catalog["We're looking at the work together. Leave your thoughts as comments."]);
    // One pinned comment and one general comment.
    await wait(page, `!!document.querySelector('#stage-comment:not(:disabled)')`);
    await page.evaluate(`document.querySelector('#stage-comment').click()`);
    await wait(page, `document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`);
    const pt = await page.evaluate<{x: number; y: number}>(`(()=>{const r=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:r.left+r.width*.55,y:r.top+r.height*.62};})()`);
    await page.mouse('mouseMoved', pt.x, pt.y); await page.mouse('mousePressed', pt.x, pt.y);
    await page.mouse('mouseMoved', pt.x + 40, pt.y + 40); await page.mouse('mouseReleased', pt.x + 40, pt.y + 40);
    await save(words[lang][0]);
    await general(words[lang][1]);
    assert.equal(await page.evaluate<string>(`document.getElementById('review-draft-state').textContent`), catalog['Not submitted']);
    await writeFile(join(output, `no-ask-${lang}-idle.png`), await page.screenshot());
    // Send comments: one act@10, no askId, both rows.
    await page.evaluate(`document.getElementById('send-comments').click()`);
    await wait(page, `document.getElementById('review-draft-state')?.dataset.saveState==='saved'`);
    assert.equal(await page.evaluate<string>(`document.getElementById('review-draft-state').textContent`), catalog['Submitted']);
    const sent = await acts(fixture);
    assert.equal(sent.length, 1, JSON.stringify(sent.map(act => act.schema)));
    assert.equal(sent[0]!.schema, 'rig-review/act@10');
    assert.equal(sent[0]!.kind, 'comments');
    assert.equal('askId' in sent[0]!, false);
    const sentTexts = (sent[0]!.value.comments as {text: string}[]).map(comment => comment.text);
    assert.deepEqual(sentTexts.toSorted(), [words[lang][0], words[lang][1]].toSorted());
    // Both rows stay listed and read Submitted.
    const rows = await page.evaluate<{text: string; submitted: boolean}[]>(`[...document.querySelectorAll('[data-comment-id]')].map(row=>({text:row.textContent.slice(0,200),
      submitted:[...row.querySelectorAll('span')].some(span=>span.textContent===${JSON.stringify(catalog['Submitted'])})}))`);
    for (const text of [words[lang][0], words[lang][1]]) {
      const row = rows.find(item => item.text.includes(text));
      assert.ok(row, 'COMMENT_ROW_DROPPED ' + text + ' ' + JSON.stringify(rows));
      assert.equal(row.submitted, true, 'COMMENT_ROW_NOT_SUBMITTED ' + text);
    }
    await writeFile(join(output, `no-ask-${lang}-sent.png`), await page.screenshot());
    // A later verdict carries only the new comment.
    await fixture.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
    await wait(page, `!document.getElementById('request-changes').hidden`);
    await general(words[lang][2]);
    await wait(page, `!document.getElementById('request-changes').disabled`);
    await page.evaluate(`document.getElementById('request-changes').click()`);
    await wait(page, `document.getElementById('request-changes').hidden||document.getElementById('review-draft-state')?.dataset.saveState==='saved'`);
    const verdict = (await acts(fixture)).filter(act => act.kind === 'review-verdict');
    assert.equal(verdict.length, 1, JSON.stringify(verdict.map(act => act.schema)));
    const verdictText = JSON.stringify(verdict[0]!.value);
    assert.ok(verdictText.includes(JSON.stringify(words[lang][2]).slice(1, -1)), 'VERDICT_MISSING_NEW_COMMENT');
    for (const text of [words[lang][0], words[lang][1]])
      assert.ok(!verdictText.includes(JSON.stringify(text).slice(1, -1)), 'COMMENT_RESENT_IN_VERDICT ' + text);
    await writeFile(join(output, `verdict-${lang}.png`), await page.screenshot());
    return {lang, act10: sent[0]!.schema, verdict: verdict[0]!.schema};
  } finally {await page.close?.(); await fixture.close();}
}

const results = [];
for (const lang of ['en', 'ko'] as const) results.push(await run(lang));
await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n');
console.log('JOB_COMMENT_SEND_1226 ' + JSON.stringify(results));
