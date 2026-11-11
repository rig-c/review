/** #710 focused ordinary Nova test: synthetic record plan, native modal focus and unchanged acts. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startJobHost} from '../src/job-front.ts';
import {JOB_API_V3_SCHEMA, JOB_RECORD_READER_ID, type RecordPlanSubject, type PendingAskV3} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {createSyntheticPlanRecordWorkspace, createSyntheticRecordReader} from './helpers/job-record-fixture.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const arg = (key: string) => Bun.argv[Bun.argv.indexOf(key) + 1];
const language = Bun.argv.includes('--lang') ? arg('--lang') : 'en';
assert.ok(language === 'en' || language === 'ko');
const catalog = language === 'ko' ? koCatalog : enCatalog;
const output = Bun.argv.includes('--out') ? arg('--out')! : 'artifacts/710/' + language;
await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(tmpdir(), 'review-710-'));
const root = join(scratch, 'plan');
const subjects: RecordPlanSubject[] = [{kind:'checkpoint', checkpointId:'step_layout'},
    {kind:'signoff', stage:'plan-approved'}, {kind:'reopen', stage:'plan-approved'}];
const text = {does:'  Exact <owner> 한글 e\u0301\n', produces:'A bounded result', bar:'Watch the subject', rests_on:['input','input']};
const fixture = createSyntheticPlanRecordWorkspace(root, {subjects, text});
const hashes = await jobInputHashes(root);
const {reader} = createSyntheticRecordReader({onPlan: () => structuredClone(fixture.context)});
let host: Awaited<ReturnType<typeof startJobHost>> | undefined;
let page: InputCdpSession | undefined;
let control: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
const observations: object[] = [];
async function until(expression: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {if (await page!.evaluate<boolean>(expression)) return; await Bun.sleep(25);}
    throw new Error('MODAL_WAIT ' + expression);
}
async function call(body: object) {
    const response = await fetch(`${host!.origin}/jobs/${host!.session.jobId}/api`, {method:'POST',
        headers:{'Content-Type':'application/json', Authorization:'Bearer '+host!.session.hostCredentials().agent},
        body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:host!.session.jobId,requestId:randomUUID(),...body})});
    const json = await response.json();
    assert.equal(json.ok, true, JSON.stringify(json));
    return json.value;
}
async function openAndClose(selector: string, name: string, escape = false) {
    const q = JSON.stringify(selector);
    await page!.evaluate(`(()=>{const b=document.querySelector(${q});b.focus();b.click();})()`);
    await until('!!document.querySelector("dialog[open]")');
    const state = await page!.evaluate<{title:string;does:string[];inside:boolean}>(`(()=>{
        const d=document.querySelector('dialog[open]');return {title:d.querySelector('h2').textContent,
        does:[...d.querySelectorAll('[data-job-plan-field=does]')].map(n=>n.textContent),inside:d.contains(document.activeElement)};
    })()`);
    assert.ok(state.inside);
    assert.ok(state.does.every(value => value === text.does));
    await writeFile(join(output, name+'.png'), await page!.screenshot());
    if (escape) {
        await control!('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await control!('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    } else await page!.evaluate(`document.querySelector('dialog[open] .review-dialog-header button').click()`);
    await until(`!document.querySelector('dialog[open]') && document.activeElement===document.querySelector(${q})`);
    observations.push({name, ...state, returnedToOpener:true, closedBy:escape?'Escape':'Close'});
}
try {
    host = await startJobHost({root, stateDir:join(scratch,'state'),fingerprint:'a'.repeat(64),
        reviewer:{id:'synthetic-owner',role:'owner'},publicationMode:'record-and-package',
        readRecordPublished:reader,recordReaderId:JOB_RECORD_READER_ID});
    const publication = await call({verb:'publish',expectedGeneration:0,idempotencyKey:randomUUID(),
        result:fixture.result,freeze:{kind:'producer-held',holdId:'710-modal',record:fixture.record}});
    const asks: PendingAskV3[] = [];
    for (const subject of subjects) asks.push(await call({verb:'ask',expectedGeneration:host.session.status().generation,
        idempotencyKey:randomUUID(),publicationId:publication.publicationId,subject}));
    page = await launchCdpSession(join(scratch,'profile'),{onEvent:(event,send)=>{if(event.sessionId)control=send;}});
    await page.setViewport(1600,1000);
    const url = new URL(host.ownerUrl); url.searchParams.set('lang',language);
    await page.goto(url.href);
    await until(`document.querySelectorAll('form[data-job-ask]').length===3 && [...document.querySelectorAll('form[data-job-ask]>fieldset,form[data-job-ask] dialog fieldset')].every(n=>!n.disabled)`);
    await openAndClose('[data-job-record-opener="job.openPlan"]','plan',true);
    const checkpoint = `form[data-job-ask="${asks[0].askId}"]`;
    await openAndClose(checkpoint+' [data-job-record-opener="job.openPlanStep"]','checkpoint-plan');
    for (const [index, subject] of subjects.entries()) {
        const selector = `form[data-job-ask="${asks[index].askId}"]`;
        if (subject.kind !== 'checkpoint') {
            await openAndClose(selector+' [data-job-record-opener="job.'+subject.kind+'"]',subject.kind,true);
            await page.evaluate(`document.querySelector(${JSON.stringify(selector+' [data-job-record-opener]')}).click()`);
        }
        const words: string = `  ${subject.kind} ${language} 한글\n`;
        await page.evaluate(`(()=>{const f=document.querySelector(${JSON.stringify(selector)});
            f.querySelector('textarea[name=note]').value=${JSON.stringify(words)};
            const outcome=f.querySelector('select[name=outcome]');if(outcome)outcome.value='pass';
            f.dispatchEvent(new Event('input',{bubbles:true}));f.querySelector('button[type=submit]').click();})()`);
        await until(`document.querySelector(${JSON.stringify(selector)}).querySelector('[role=status]').dataset.jobText==='job.saved'`);
        const saved: string = await page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)}).querySelector('[role=status]').textContent`);
        assert.equal(saved,catalog['job.saved']);
        if (subject.kind !== 'checkpoint') await page.evaluate(`document.querySelector('dialog[open] .review-dialog-header button').click()`);
        const next = await call({verb:'next',after:null,waitMs:0});
        const act = next.events.find((event: any) => event.type==='act' && event.act.askId===asks[index].askId)?.act;
        assert.ok(act);
        assert.equal(act.schema,'rig-review/act@4');
        assert.equal(act.source.sourceHash,publication.source.sourceHash);
        assert.deepEqual(act.value,subject.kind==='checkpoint'?{checkpointId:'step_layout',planStepId:'step_layout',outcome:'pass',words}:
            subject.kind==='signoff'?{stage:'plan-approved',decision:'approved',words}:{stage:'plan-approved',words});
        observations.push({kind:subject.kind,value:act.value,schema:act.schema,sourceHash:act.source.sourceHash});
    }
    assert.deepEqual(await jobInputHashes(root),hashes);
    await call({verb:'close',expectedGeneration:host.session.status().generation,idempotencyKey:randomUUID(),reason:'710 test complete'});
    await writeFile(join(output,'observations.json'),JSON.stringify({language,viewport:[1600,1000],provenance:'synthetic record fixture; no producer run',observations},null,2));
    console.log('RECORD_MODALS_OK '+language+' 4 modal focus returns; 3 exact act values; immutable inputs');
} catch (error) {
    if (page) await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});
    throw error;
} finally {
    await page?.close();
    await host?.stop();
    await rm(scratch,{recursive:true,force:true});
}
