/** #989 owner URLs and screenshots using the public job API with a synthetic plan reader. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {JOB_API_V3_SCHEMA, type JobApiResponseV3, type JobAskRequestV3, type JobPublishRequestV3,
  type PendingAskV3, type RecordReopenSubject, type RecordSignoffSubject} from '../src/job-contract.ts';
import {startJobHost} from '../src/job-front.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const signoff: RecordSignoffSubject = {kind: 'signoff', stage: 'plan-approved'};
const reopen: RecordReopenSubject = {
  kind: 'reopen',
  stage: 'direction-review',
  reason: 'The left sleeve still clips on a side turn. 옆으로 돌 때 왼쪽 소매가 몸을 뚫고 나와요.',
};
const cases = {
  signoff: [signoff],
  reopen: [reopen],
  mixed: [signoff, reopen, {kind: 'signoff', stage: 'post-interview'}, {kind: 'reopen', stage: 'rigging-interview'}],
} satisfies Record<string, (RecordSignoffSubject | RecordReopenSubject)[]>;
const languages = ['en', 'ko'] as const;
const trigger = '#workspace-pending-ask';

async function startFixture(subjects: (RecordSignoffSubject | RecordReopenSubject)[]) {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'review-989-plan-'));
  let host: Awaited<ReturnType<typeof startJobHost>> | undefined;
  async function close() {
    host?.stop();
    await rm(scratch, {recursive: true, force: true});
  }
  try {
    const root = join(scratch, 'input');
    const workspace = createSyntheticPlanRecordWorkspace(root, {subjects});
    const reader = createSyntheticRecordReader({onPlan: () => workspace.context});
    const owner = host = await startJobHost({
      root, stateDir: join(scratch, 'state'), fingerprint: '9'.repeat(64), publicationMode: 'record-and-package',
      reviewer: {id: 'synthetic-owner', role: 'owner'}, readRecordPublished: reader.reader,
      recordReaderId: 'synthetic-reopen-plan-reader/1',
    });
    const jobId = owner.session.jobId;
    const endpoint = `${owner.origin}/jobs/${jobId}/api`;
    const headers = {'Content-Type': 'application/json', Authorization: `Bearer ${owner.session.hostCredentials().agent}`};
    async function call(request: JobPublishRequestV3 | JobAskRequestV3): Promise<JobApiResponseV3> {
      const response = await fetch(endpoint, {method: 'POST', headers, body: JSON.stringify(request)});
      const result = await response.json() as JobApiResponseV3;
      assert.ok(response.ok && result.ok, JSON.stringify(result));
      return result;
    }
    const request = () => ({schema: JOB_API_V3_SCHEMA, jobId, requestId: randomUUID(), idempotencyKey: randomUUID(),
      expectedGeneration: owner.session.status().generation} as const);
    const publication = await call({...request(), verb: 'publish', result: workspace.result,
      freeze: {kind: 'producer-held', holdId: 'fixture-989', record: workspace.record}});
    assert.ok(publication.ok && publication.verb === 'publish');
    const asks: PendingAskV3[] = [];
    for (const subject of subjects) {
      const ask = await call({...request(), verb: 'ask', publicationId: publication.value.publicationId, subject});
      assert.ok(ask.ok && ask.verb === 'ask');
      asks.push(ask.value);
    }
    return {ownerUrl: owner.ownerUrl, asks, close};
  } catch (error) {
    await close();
    throw error;
  }
}

function localizeUrl(ownerUrl: string, language: typeof languages[number]): string {
  const url = new URL(ownerUrl);
  url.searchParams.set('lang', language);
  return url.href;
}

interface FormReadback {
  askId: string;
  stageTitle: string;
  text: string;
  stage: string | null;
  reason: string | null;
  stageVisible: boolean;
  reasonVisible: boolean;
  reasonChildCount: number;
  buttons: {text: string; type: string; enabled: boolean}[];
  inputCount: number;
}

interface DialogReadback {
  language: string;
  opener: string;
  forms: FormReadback[];
}

async function wait(page: InputCdpSession, expression: string, label: string): Promise<void> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (await page.evaluate<boolean>(expression)) return;
    await Bun.sleep(25);
  }
  throw new Error(`989_WAIT ${label}`);
}

if (Bun.argv.includes('--serve')) {
  const fixtures: Awaited<ReturnType<typeof startFixture>>[] = [];
  try {
    for (const [scenario, subjects] of Object.entries(cases)) {
      const fixture = await startFixture(subjects);
      fixtures.push(fixture);
      for (const language of languages) console.log(JSON.stringify({scenario, language, url: localizeUrl(fixture.ownerUrl, language)}));
    }
    await new Promise<void>(done => {process.once('SIGINT', done);process.once('SIGTERM', done);});
  } finally {
    await Promise.all(fixtures.map(fixture => fixture.close()));
  }
} else {
  const at = Bun.argv.indexOf('--out');
  const output = resolve(at < 0 ? 'artifacts/989' : Bun.argv[at + 1]!);
  await mkdir(output, {recursive: true});
  const profile = await mkdtemp(join(tmpdir(), 'review-989-chromium-'));
  let page: InputCdpSession | undefined;
  let artifact: string | undefined;
  try {
    page = await launchCdpSession(profile);
    await page.setViewport(1600, 1000);
    for (const [scenario, subjects] of Object.entries(cases)) {
      const fixture = await startFixture(subjects);
      try {
        for (const language of languages) {
          artifact = join(output, `${scenario}-${language}`);
          await page.goto(localizeUrl(fixture.ownerUrl, language), language);
          const catalog = language === 'en' ? enCatalog : koCatalog;
          await wait(page, `(() => {
            const button = document.querySelector(${JSON.stringify(trigger)});
            if (!button || button.hidden || button.disabled) return false;
            const r = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          })()`, `${scenario}-${language} opener`);
          await click(page, trigger);
          await wait(page, `document.querySelectorAll('#job-record-asks[open] form[data-job-ask] fieldset:not(:disabled)').length === ${subjects.length}`,
            `${scenario}-${language} separate enabled forms`);
          const state: DialogReadback = await page.evaluate<DialogReadback>(`(() => {
            const dialog = document.querySelector('#job-record-asks[open]');
            const visible = node => {
              if (!node?.checkVisibility({opacityProperty: true, visibilityProperty: true})) return false;
              const r = node.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
            };
            return {
              language: document.documentElement.lang,
              opener: document.querySelector(${JSON.stringify(trigger)}).textContent,
              forms: Array.from(dialog.querySelectorAll('form[data-job-ask]'), form => {
                const stage = form.querySelector('[data-job-reopen-stage]');
                const reason = form.querySelector('[data-job-reopen-reason]');
                return {
                  askId: form.dataset.jobAsk, stageTitle: form.querySelector('fieldset').title, text: form.innerText,
                  stage: stage?.textContent ?? null, reason: reason?.textContent ?? null,
                  stageVisible: visible(stage), reasonVisible: visible(reason), reasonChildCount: reason?.childElementCount ?? 0,
                  buttons: Array.from(form.querySelectorAll('button'), button => ({text: button.textContent, type: button.type, enabled: !button.matches(':disabled')})),
                  inputCount: form.querySelectorAll('input,textarea,select,[contenteditable]').length,
                };
              }),
            };
          })()`);
          await writeFile(`${artifact}.json`, JSON.stringify(state, null, 2) + '\n');
          assert.equal(state.language, language);
          if (scenario !== 'mixed') assert.equal(state.opener, catalog[scenario === 'signoff' ? 'Approve…' : 'Review…']);
          assert.equal(state.forms.length, subjects.length);
          assert.deepEqual(state.forms.map(form => form.askId).sort(), fixture.asks.map(ask => ask.askId).sort());
          for (const [index, subject] of subjects.entries()) {
            const form = state.forms.find(row => row.askId === fixture.asks[index]!.askId)!;
            const reason = subject.kind === 'reopen' ? subject.reason ?? null : null;
            assert.equal(form.stageTitle, subject.stage);
            assert.equal(form.stage, reason === null ? null : subject.stage);
            assert.equal(form.reason, reason);
            if (scenario !== 'mixed') {
              assert.equal(form.stageVisible, reason !== null);
              assert.equal(form.reasonVisible, reason !== null);
            }
            assert.equal(form.reasonChildCount, 0);
            assert.equal(form.text.includes(subject.stage), reason !== null);
            assert.equal(form.inputCount, 0);
            assert.deepEqual(form.buttons, [{text: catalog[subject.kind === 'signoff' ? 'job.signoff' : 'job.reopen'], type: 'submit', enabled: true}]);
          }
          await writeFile(`${artifact}.png`, await page.screenshot());
          console.log(`989_BROWSER_PASS ${scenario} ${language} forms=${state.forms.length}`);
        }
      } finally {
        await fixture.close();
      }
    }
  } catch (error) {
    if (page && artifact) {
      const failureShot = `${artifact}-failure.png`;
      await page.screenshot().then(bytes => writeFile(failureShot, bytes)).catch(() => {});
    }
    throw error;
  } finally {
    try { await page?.close(); }
    finally { await rm(profile, {recursive: true, force: true}); }
  }
}
