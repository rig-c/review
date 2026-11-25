/** #1226 direct Bun script; ordinary Nova only. Synthetic scripted job window fixture, owned headless Chromium.
 * Send comments with no ask records one act@10 with no askId; sent rows stay listed as Submitted;
 * a later Request changes carries only rows that were not already sent on their own (CONTRACT §1). EN and KO.
 * #1242: the direction, parts and record screens carry the same control, headline, hint and save states, and send act@10.
 * Run: bun tests/job-comment-send-browser.ts --out artifacts/job-comment-send-1226 [--screens rig,direction,parts,record]
 */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {finalizeCommentOnlyAct} from '../src/job-act.ts';
import type {UISubmissionV3} from '../src/job-contract.ts';
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
    message:document.getElementById('review-message')?.textContent,send:document.getElementById('send-comments')?.outerHTML,
    composer:document.querySelector('.stage-comment-composer')?.textContent,footer:document.getElementById('message')?.textContent,
    alert:[...document.querySelectorAll('[role=alert]')].map(n=>n.textContent).join('|'),
    rows:[...document.querySelectorAll('[data-comment-id]')].map(n=>n.textContent.slice(0,80))}))()`).catch(String);
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

type Screen = 'direction' | 'parts' | 'record';
/** #1242 owner ruling 11-25: on rig, direction and parts the right panel stays closed until the person comments: a
 * comment of either kind, or the toolbar's Comment pressed. Send comments stays in the bar throughout. */
type PanelState = {open: boolean; width: number; general: boolean; send: boolean; rows: number; pressed: boolean};
const panelState = `(()=>{const p=document.getElementById('workspace-communication'),g=document.querySelector('[data-comment-general]');
  return {open:!!p?.checkVisibility(),width:Math.round(p?.getBoundingClientRect().width??0),general:!!g?.checkVisibility()&&!!p?.contains(g),
    send:!!document.getElementById('send-comments')?.checkVisibility(),rows:p?.querySelectorAll('.stage-comment-item[data-comment-id]').length??0,
    pressed:document.getElementById('stage-comment')?.getAttribute('aria-pressed')==='true'};})()`;
const panelOpen = (state: PanelState) => state.open && state.width >= 240;
async function panelCase(page: InputCdpSession, label: string, open: boolean, extra: (state: PanelState) => boolean = () => true) {
  const end = Date.now() + 10_000;
  let state = await page.evaluate<PanelState>(panelState);
  while (Date.now() < end && !(panelOpen(state) === open && state.send && extra(state))) {await Bun.sleep(60); state = await page.evaluate<PanelState>(panelState);}
  assert.equal(panelOpen(state) === open && state.send && extra(state), true, `PANEL_RULE ${label}: expected ${open ? 'open' : 'closed'} ${JSON.stringify(state)}`);
  return state;
}
async function panelRule(screen: 'rig' | 'direction' | 'parts', lang: 'en' | 'ko') {
  const cases: Record<string, PanelState> = {};
  const open = async (fixture: Awaited<ReturnType<typeof scriptedJobWindowFixture>>) => {
    const page = await launchCdpSession(await mkdtemp(join(tmpdir(), 'review-1242-panel-')), {sendDeadlineMs: 20_000});
    const url = new URL(fixture.host.ownerUrl); url.searchParams.set('lang', lang);
    await page.setViewport(1440, 900);
    await page.goto(url.href);
    await wait(page, `document.body?.dataset.ready==='true'&&!!document.getElementById('send-comments')?.checkVisibility()`, 30_000);
    return page;
  };
  const write = async (page: InputCdpSession, text: string) => {
    await wait(page, `!!document.querySelector('.stage-comment-composer input')`);
    await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);
    await wait(page, `!document.querySelector('.stage-comment-composer')`);
  };
  // A: no comment → closed; one general comment → open.
  let fixture = await scriptedJobWindowFixture({c5Parts: 'mesh'});
  await fixture.publish(screen, screen);
  let page = await open(fixture);
  try {
    cases.none = await panelCase(page, `${screen} ${lang} no comment`, false);
    await wait(page, `!!document.querySelector('[data-comment-general]:not(:disabled)')`);
    await page.evaluate(`document.querySelector('[data-comment-general]').click()`);
    await write(page, words[lang][1]);
    cases.general = await panelCase(page, `${screen} ${lang} one general comment`, true, state => state.rows === 1);
    await writeFile(join(output, `panel-${screen}-${lang}-general.png`), await page.screenshot());
  } finally {await page.close?.(); await fixture.close();}
  // B: Comment pressed → open with Add general comment; released with no comment → closed; a pin → open.
  fixture = await scriptedJobWindowFixture({c5Parts: 'mesh'});
  await fixture.publish(screen, screen);
  page = await open(fixture);
  try {
    await panelCase(page, `${screen} ${lang} before Comment`, false);
    await page.evaluate(`document.getElementById('stage-comment').click()`);
    cases.pressed = await panelCase(page, `${screen} ${lang} Comment pressed`, true, state => state.general && state.rows === 0);
    await writeFile(join(output, `panel-${screen}-${lang}-pressed.png`), await page.screenshot());
    await page.evaluate(`document.getElementById('stage-comment').click()`);
    cases.released = await panelCase(page, `${screen} ${lang} Comment released with no comment`, false, state => !state.pressed);
    await page.evaluate(`document.getElementById('stage-comment').click()`);
    await panelCase(page, `${screen} ${lang} Comment pressed again`, true);
    const point = await page.evaluate<{x: number; y: number}>(`(()=>{const v=document.getElementById('rig-viewport').getBoundingClientRect();return {x:v.left+v.width*0.6,y:v.top+v.height*0.5};})()`);
    // A dragged region: parts pins need a positive region, and rig and direction take one as well.
    await page.mouse('mouseMoved', point.x, point.y); await page.mouse('mousePressed', point.x, point.y);
    await page.mouse('mouseMoved', point.x + 30, point.y + 24); await page.mouse('mouseReleased', point.x + 30, point.y + 24);
    await write(page, words[lang][0]);
    await page.evaluate(`document.getElementById('stage-comment').getAttribute('aria-pressed')==='true'&&document.getElementById('stage-comment').click()`);
    cases.pin = await panelCase(page, `${screen} ${lang} one pin, Comment released`, true, state => state.rows === 1 && !state.pressed);
    await writeFile(join(output, `panel-${screen}-${lang}-pin.png`), await page.screenshot());
  } finally {await page.close?.(); await fixture.close();}
  return {screen, lang, panel: cases};
}
const hintTail = 'Drafts save locally as you type · nothing is sent until you press Send comments';
/** #1242: one screen's bar in its no-ask state, one general comment written and sent as act@10. */
async function runScreen(screen: Screen, lang: 'en' | 'ko') {
  const catalog = lang === 'en' ? enCatalog : koCatalog;
  const scripted = screen === 'record' ? null : await scriptedJobWindowFixture({c5Parts: 'mesh'});
  const record = screen === 'record' ? await recordScreenFixture('checkpoint', false, undefined, undefined, false, true, undefined, false, true) : null;
  const recordActs: Act[] = [];
  if (record) {
    // The record fixture writes asked record acts only; a comment-only act goes through the real act@10 writer.
    const asked = record.ports.commitUIAct.bind(record.ports);
    record.ports.commitUIAct = async (job: string, request: Request) => {
      const input = await request.clone().json() as UISubmissionV3;
      if (input.kind !== 'comments') return asked(job, request);
      const act = finalizeCommentOnlyAct({jobId: record.session.jobId, submission: input as never,
        retained: record.session.retainedSourceV3(input.publicationId) as never, reviewer: {id: 'synthetic-owner', role: 'owner'}});
      recordActs.push(act as unknown as Act);
      return {ok: true as const, value: act as never};
    };
  }
  let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
  const page = await launchCdpSession(await mkdtemp(join(tmpdir(), 'review-1242-')), {sendDeadlineMs: 20_000,
    onEvent(event, send) {if (event.sessionId) control = send;}});
  try {
    if (scripted) await scripted.publish(screen as 'direction' | 'parts', screen);
    const url = new URL(scripted ? scripted.host.ownerUrl : record!.ownerUrl); url.searchParams.set('lang', lang);
    await page.setViewport(1440, 900);
    await page.goto(url.href);
    if (record) record.fake.publish(record.display);
    await wait(page, `document.body?.dataset.ready==='true'`, 30_000);
    await wait(page, `!!document.getElementById('send-comments')&&!document.getElementById('send-comments').hidden`);
    const bar = () => page.evaluate<Record<string, unknown>>(`(()=>{const b=document.getElementById('send-comments'),s=document.getElementById('review-draft-state');
      const order=[...b.parentElement.children].filter(n=>!n.hidden&&n.tagName==='BUTTON').map(n=>n.id);
      return {text:b.textContent,disabled:b.disabled,primary:b.classList.contains('primary'),state:s?.textContent,saveState:s?.dataset.saveState,
        headline:document.getElementById('workspace-ask-headline').textContent,order,
        hint:document.querySelector('#workspace-communication .review-dialog-header .hint, .review-dialog-header .hint')?.textContent};})()`);
    const idle = await bar();
    assert.equal(idle.text, catalog['Send comments'], screen);
    assert.equal(idle.headline, catalog["We're looking at the work together. Leave your thoughts as comments."], screen);
    assert.equal(idle.primary, true, screen + ' Send comments leads with no ask');
    assert.equal(idle.disabled, true, screen + ' nothing to send yet');
    // One general comment.
    await wait(page, `!!document.querySelector('[data-comment-general]:not(:disabled)')`);
    await page.evaluate(`document.querySelector('[data-comment-general]').click()`);
    await wait(page, `!!document.querySelector('.stage-comment-composer input')`);
    // As the direction suite writes its comments: the value is set, then the form submits.
    await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(words[lang][1])};f.requestSubmit();})()`);
    await wait(page, `!document.querySelector('.stage-comment-composer')`);
    await wait(page, `!document.getElementById('send-comments').disabled`);
    const written = await bar();
    assert.equal(written.state, catalog['Not submitted'], screen + ' ' + JSON.stringify(written));
    assert.equal(written.hint, catalog[hintTail], screen + ' hint tail');
    await writeFile(join(output, `${screen}-${lang}-idle.png`), await page.screenshot());
    await page.evaluate(`document.getElementById('send-comments').click()`);
    await wait(page, `document.getElementById('review-draft-state')?.dataset.saveState==='saved'`);
    const sentBar = await bar();
    assert.equal(sentBar.state, catalog['Submitted'], screen);
    assert.equal(sentBar.disabled, true, screen + ' nothing left to send');
    const sent = record ? recordActs : (await acts(scripted!)).filter(act => act.kind === 'comments');
    assert.equal(sent.length, 1, screen + ' ' + JSON.stringify(sent.map(act => act.schema)));
    assert.equal(sent[0]!.schema, 'rig-review/act@10');
    assert.equal('askId' in sent[0]!, false);
    assert.deepEqual((sent[0]!.value.comments as {text: string}[]).map(comment => comment.text), [words[lang][1]]);
    const submitted = await page.evaluate<boolean>(`[...document.querySelectorAll('[data-comment-id]')].some(row=>row.textContent.includes(${JSON.stringify(words[lang][1])})&&
      [...row.querySelectorAll('span')].some(span=>span.textContent===${JSON.stringify(catalog['Submitted'])}))`);
    assert.equal(submitted, true, screen + ' COMMENT_ROW_NOT_SUBMITTED');
    await writeFile(join(output, `${screen}-${lang}-sent.png`), await page.screenshot());
    return {screen, lang, act10: sent[0]!.schema, idle: {...idle, hint: undefined}, written, sent: sentBar};
  } finally {await page.close?.(); await scripted?.close(); await record?.close();}
}

const screensAt = Bun.argv.indexOf('--screens');
const screens = (screensAt < 0 ? 'rig,direction,parts,record' : Bun.argv[screensAt + 1]!).split(',');
const results: unknown[] = [];
for (const lang of ['en', 'ko'] as const) {
  if (screens.includes('rig')) results.push(await run(lang));
  for (const screen of ['direction', 'parts', 'record'] as const) if (screens.includes(screen)) results.push(await runScreen(screen, lang));
  for (const screen of ['rig', 'direction', 'parts'] as const) if (screens.includes(screen)) results.push(await panelRule(screen, lang));
}
await writeFile(join(output, 'report.json'), JSON.stringify(results, null, 2) + '\n');
console.log('JOB_COMMENT_SEND_1226 ' + JSON.stringify(results));
