/** #901 browser control (ordinary Nova, EN/KO): one optional note textarea per editable question set. */
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {joinProject} from '../src/joined-project.ts';
import {startServer} from '../src/server.ts';
import {parseRecordAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const outIndex = Bun.argv.indexOf('--out');
const output = resolve(outIndex < 0 ? 'artifacts/interview-note-901' : Bun.argv[outIndex + 1]!);
await mkdir(output, {recursive: true});
const baseline = await Bun.file(new URL('./fixtures/interview-722-empty-note.json', import.meta.url)).json();
const profile = await mkdtemp(join(tmpdir(), 'review-901-browser-'));
let page: InputCdpSession | undefined;
let command: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | undefined;
const exceptions: unknown[] = [];
const questionPanel = '#workspace-interview-answer';
// #1041: the question section of the right communication panel, under its heading.
const selectedQuestion = '#workspace-communication:not([hidden]) #workspace-interview-answer:not([hidden]) .review-dialog-header h2';
const dialogViewer = 'dialog :is(.viewport,.interview-view,.interview-viewport,#reference-content,#rig-viewport,#view-menu)';

async function wait(expression: string, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await page!.evaluate<boolean>(expression)) return;
    await Bun.sleep(30);
  }
  throw new Error('901_BROWSER_TIMEOUT ' + label + ': ' + expression);
}

async function waitForQuestion(form: string, label: string, editable = true): Promise<void> {
  const selector = `${questionPanel}:not([hidden]) ${form}${editable ? ' fieldset:not(:disabled)' : ''}`;
  await wait(`document.body.dataset.ready==='true'&&!!document.querySelector(${JSON.stringify(selectedQuestion)})&&document.querySelector(${JSON.stringify(selector)})?.getClientRects().length>0`, label);
  assert.equal(await page!.evaluate<number>(`document.querySelectorAll('dialog[open]').length`), 0, label);
  assert.equal(await page!.evaluate<number>(`document.querySelectorAll(${JSON.stringify(dialogViewer)}).length`), 0, label);
}

const results: Record<string, unknown>[] = [];
const failures: string[] = [];
function check(condition: boolean, label: string, detail?: unknown): void {
  if (!condition) failures.push(label + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}

try {
  page = await launchCdpSession(profile, {
    sendDeadlineMs: 20_000,
    onEvent: (event, send) => {
      command = send;
      if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params);
    },
  });
  await command!('Network.enable');
  await page.setViewport(1600, 1000);

  for (const language of ['en', 'ko'] as const) {
    const catalog = language === 'en' ? enCatalog : koCatalog;
    const expectedLabel = language === 'en' ? 'Your note (optional)' : '의견 (선택)';
    const expectedPlaceholder = language === 'en'
      ? "Anything the choices don't cover"
      : '선택지로 다 말하지 못한 점을 적어 주세요';
    const noteText = 'First line opinion\n둘째 줄 의견 · 그대로 보존';
    const formSelector = 'form[data-job-ask="ask-interview-picks"]';
    const selector = `${questionPanel} ${formSelector}`;

    // 1. Bars 1, 2, 5 on a job interview (empty note save + DOM placement + maxlength=10000 + >10000 typing refusal)
    const emptyFixture = await recordScreenFixture('interview-picks', false, undefined, undefined, false, false);
    const emptyOut = join(output, 'bar1-2-5', language);
    await mkdir(emptyOut, {recursive: true});
    emptyFixture.output(emptyOut);
    let bar1: Record<string, unknown> = {};
    let bar2: Record<string, unknown> = {};
    let bar5: Record<string, unknown> = {};
    try {
      const url = new URL(emptyFixture.ownerUrl);
      url.searchParams.set('lang', language);
      await page.goto('about:blank');
      await page.goto(url.href);
      await waitForQuestion(formSelector, 'bar1 pictureless Question ' + language);
      const pictureless: {empty: string; images: number; imageModes: number} = await page.evaluate(`({
        empty: document.querySelector('#rig-empty').textContent,
        images: document.querySelectorAll('#reference-content img').length,
        imageModes: document.querySelectorAll('#view-menu [data-view^="interview-image-"]').length,
      })`);
      assert.deepEqual(pictureless, {empty: catalog['This request has no picture.'], images: 0, imageModes: 0});

      const dom = await page.evaluate<{
        noteCount: number; preCount: number; noteId: string | null; noteDisabled: boolean | null;
        labelFor: string | null; labelLinked: boolean; labelText: string | null; placeholder: string | null;
        maxLengthProp: number | null; maxLengthAttr: string | null; orderOk: boolean; geometryOk: boolean;
      }>(`(()=>{
        const form = document.querySelector('${selector}');
        const fields = form.querySelector('fieldset.interview-answer-fields');
        const asks = [...fields.querySelectorAll('fieldset.interview-ask')];
        const lastAsk = asks.at(-1);
        const submit = fields.querySelector('button[type="submit"]');
        const notes = [...fields.querySelectorAll('textarea[name="note"]')];
        const note = notes[0] ?? null;
        const label = note?.id ? fields.querySelector('label[for="' + CSS.escape(note.id) + '"]') : null;
        const children = [...fields.children];
        const lastAskIndex = children.indexOf(lastAsk);
        const labelIndex = label ? children.indexOf(label) : -1;
        const noteIndex = note ? children.indexOf(note) : -1;
        const submitIndex = children.indexOf(submit);
        const askRect = lastAsk.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect() ?? null;
        const noteRect = note?.getBoundingClientRect() ?? null;
        const submitRect = submit.getBoundingClientRect();
        return {
          noteCount: notes.length,
          preCount: form.querySelectorAll('pre.interview-note').length,
          noteId: note?.id ?? null,
          noteDisabled: note?.disabled ?? null,
          labelFor: label?.getAttribute('for') ?? null,
          labelLinked: !!note && !!label && note.labels?.[0] === label,
          labelText: label?.textContent ?? null,
          placeholder: note?.placeholder ?? null,
          maxLengthProp: note?.maxLength ?? null,
          maxLengthAttr: note?.getAttribute('maxlength') ?? null,
          orderOk: labelIndex > lastAskIndex && noteIndex === labelIndex + 1 && submitIndex > noteIndex,
          geometryOk: !!labelRect && !!noteRect && labelRect.top >= askRect.bottom - 1 && noteRect.top >= labelRect.bottom - 1 && submitRect.top >= noteRect.bottom - 1,
        };
      })()`);

      let overLimitLength: number | null = null;
      let overLimitTail: string | null = null;
      if (dom.noteCount === 1) {
        await page.evaluate<void>(`(()=>{
          const note = document.querySelector('${selector} textarea[name="note"]');
          note.scrollIntoView({block: 'center'});
          note.value = 'a'.repeat(9998);
          note.focus();
          note.setSelectionRange(9998, 9998);
        })()`);
        await command!('Input.insertText', {text: 'WXYZ'});
        const typed = await page.evaluate<{length: number; tail: string}>(`(()=>{
          const note = document.querySelector('${selector} textarea[name="note"]');
          const result = {length: note.value.length, tail: note.value.slice(-4)};
          note.value = '';
          note.dispatchEvent(new Event('input', {bubbles: true}));
          return result;
        })()`);
        overLimitLength = typed.length;
        overLimitTail = typed.tail;
      }

      bar1 = {
        ...dom,
        expectedLabel,
        expectedPlaceholder,
        catalogLabel: catalog['interview.noteLabel'] ?? null,
        catalogPlaceholder: catalog['interview.notePlaceholder'] ?? null,
        passed:
          dom.noteCount === 1 &&
          dom.preCount === 0 &&
          dom.noteDisabled === false &&
          dom.labelLinked === true &&
          dom.labelText === expectedLabel &&
          dom.placeholder === expectedPlaceholder &&
          dom.orderOk === true &&
          dom.geometryOk === true &&
          catalog['interview.noteLabel'] === expectedLabel &&
          catalog['interview.notePlaceholder'] === expectedPlaceholder,
      };
      check(Boolean(bar1.passed), `Bar 1 (${language})`, bar1);

      bar5 = {
        maxLengthProp: dom.maxLengthProp,
        maxLengthAttr: dom.maxLengthAttr,
        overLimitLength,
        overLimitTail,
        passed: dom.maxLengthProp === 10000 && dom.maxLengthAttr === '10000' && overLimitLength === 10000 && overLimitTail === 'aaWX',
      };
      check(Boolean(bar5.passed), `Bar 5 (${language})`, bar5);

      // Bar 2: save with empty note
      await page.evaluate(`(()=>{
        const form = document.querySelector('${selector}');
        for (const value of ['topology_other', 'density_auto']) form.querySelector('input[type="radio"][value="' + value + '"]').click();
        const other = form.querySelector('textarea[name="other.topology"]');
        other.value = '  Custom topology · 직접 입력\\n';
        other.dispatchEvent(new Event('input', {bubbles: true}));
        form.querySelector('button[type="submit"]').scrollIntoView({block: 'center'});
      })()`);
      await click(page, `${selector} button[type="submit"]`);
      await wait(`document.querySelector('${selector} > [role="status"]')?.textContent===${JSON.stringify(catalog['job.saved'])}`, 'bar2 saved ' + language);
      const emptyAct = parseRecordAct(JSON.parse(await readFile(join(emptyOut, 'one-screen.json'), 'utf8')));
      assert.equal(emptyAct.kind, 'interview-picks');
      const afterEmptySave = await page.evaluate<{noteCount: number; preCount: number}>(`(()=>{
        const form = document.querySelector('${selector}');
        return {
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preCount: form.querySelectorAll('pre.interview-note').length,
        };
      })()`);
      bar2 = {
        postedNote: emptyAct.value.note,
        matches1793715Bytes: JSON.stringify(emptyAct.value) === baseline.expectedValueBytes,
        afterEmptySave,
        passed:
          emptyAct.value.note === '' &&
          JSON.stringify(emptyAct.value) === baseline.expectedValueBytes &&
          afterEmptySave.noteCount === 0 &&
          afterEmptySave.preCount === 0,
      };
      check(Boolean(bar2.passed), `Bar 2 (${language})`, bar2);
    } finally {
      await page.goto('about:blank');
      await emptyFixture.close();
    }

    // 2. Bar 3: saving with a note (newlines + Korean) + editable reopen prefilled + read-only pre.interview-note + 10,000-char acceptance
    const noteFixture = await recordScreenFixture('interview-picks', true);
    const noteOut = join(output, 'bar3', language);
    await mkdir(noteOut, {recursive: true});
    noteFixture.output(noteOut);
    let bar3: Record<string, unknown> = {};
    try {
      const url = new URL(noteFixture.ownerUrl);
      url.searchParams.set('lang', language);
      await page.goto('about:blank');
      await page.goto(url.href);
      await waitForQuestion(formSelector, 'bar3 ready ' + language);

      const entered = await page.evaluate<boolean>(`(()=>{
        const form = document.querySelector('${selector}');
        for (const value of ['biped_std', 'density_high']) form.querySelector('input[type="radio"][value="' + value + '"]').click();
        const note = form.querySelector('textarea[name="note"]');
        if (!note) return false;
        note.value = ${JSON.stringify(noteText)};
        note.dispatchEvent(new Event('input', {bubbles: true}));
        return true;
      })()`);

      await page.goto('about:blank');
      await page.goto(url.href);
      await waitForQuestion(formSelector, 'bar3 draft reopen ' + language);
      const editableDraftReopen = await page.evaluate<{noteCount: number; preCount: number; value: string | null}>(`(()=>{
        const form = document.querySelector('${selector}');
        const note = form.querySelector('textarea[name="note"]');
        return {
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preCount: form.querySelectorAll('pre.interview-note').length,
          value: note?.value ?? null,
        };
      })()`);

      if (!entered) {
        await page.evaluate(`(()=>{
          const form = document.querySelector('${selector}');
          for (const value of ['biped_std', 'density_high']) form.querySelector('input[type="radio"][value="' + value + '"]').click();
        })()`);
      }
      const visiblePainting = `(()=>{
        const image = document.querySelector('#reference-content img');
        return image?.complete && image.naturalWidth===2 && image.getBoundingClientRect().width>0 ? image.currentSrc : '';
      })()`;
      await wait(`Boolean(${visiblePainting})`, 'bar3 main painting before save ' + language);
      const paintingBeforeSave: string = await page.evaluate(visiblePainting);
      await page.evaluate<void>(`document.querySelector('${selector} button[type="submit"]').scrollIntoView({block: 'center'})`);
      await click(page, `${selector} button[type="submit"]`);
      await wait(`document.querySelector('${selector} > [role="status"]')?.textContent===${JSON.stringify(catalog['job.saved'])}`, 'bar3 saved ' + language);
      await waitForQuestion(formSelector, 'bar3 Question stays selected after save ' + language, false);
      const paintingAfterSave: string = await page.evaluate(visiblePainting);
      assert.equal(paintingAfterSave, paintingBeforeSave, 'saving keeps the shared painting visible');

      const savedAct = parseRecordAct(JSON.parse(await readFile(join(noteOut, 'one-screen.json'), 'utf8')));
      assert.equal(savedAct.kind, 'interview-picks');

      const immediateReadOnly = await page.evaluate<{disabled: boolean; noteCount: number; preText: string | null}>(`(()=>{
        const form = document.querySelector('${selector}');
        return {
          disabled: form.querySelector('fieldset.interview-answer-fields').disabled,
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preText: form.querySelector('pre.interview-note')?.textContent ?? null,
        };
      })()`);

      // Replay the committed act in the job stream and reload to verify read-only round-trip through web/job-session.ts:1381
      noteFixture.fake.events.push({
        type: 'act',
        jobId: noteFixture.session.jobId,
        generation: noteFixture.display.publication.generation + 2,
        cursor: String(noteFixture.fake.events.length + 1),
        act: savedAct,
      });
      await page.goto('about:blank');
      await page.goto(url.href);
      await wait(`document.querySelector('${selector}')?.dataset.interviewAnswered==='true'`, 'bar3 reload read-only ' + language);
      await waitForQuestion(formSelector, 'bar3 answered Question on reload ' + language, false);
      const reloadedReadOnly = await page.evaluate<{disabled: boolean; noteCount: number; preText: string | null}>(`(()=>{
        const form = document.querySelector('${selector}');
        return {
          disabled: form.querySelector('fieldset.interview-answer-fields').disabled,
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preText: form.querySelector('pre.interview-note')?.textContent ?? null,
        };
      })()`);

      bar3 = {
        entered,
        postedNote: savedAct.value.note,
        editableDraftReopen,
        paintingBeforeSave,
        paintingAfterSave,
        immediateReadOnly,
        reloadedReadOnly,
        passed:
          entered &&
          savedAct.value.note === noteText &&
          editableDraftReopen.noteCount === 1 &&
          editableDraftReopen.preCount === 0 &&
          editableDraftReopen.value === noteText &&
          immediateReadOnly.disabled === true &&
          immediateReadOnly.noteCount === 0 &&
          immediateReadOnly.preText === noteText &&
          reloadedReadOnly.disabled === true &&
          reloadedReadOnly.noteCount === 0 &&
          reloadedReadOnly.preText === noteText,
      };
      check(Boolean(bar3.passed), `Bar 3 (${language})`, bar3);
    } finally {
      await page.goto('about:blank');
      await noteFixture.close();
    }

    // 3. End-to-end 10,000-character note submission acceptance
    if (language === 'en') {
      const maxFixture = await recordScreenFixture('interview-picks', false);
      const maxOut = join(output, 'max-10000');
      await mkdir(maxOut, {recursive: true});
      maxFixture.output(maxOut);
      try {
        const url = new URL(maxFixture.ownerUrl);
        url.searchParams.set('lang', 'en');
        await page.goto('about:blank');
        await page.goto(url.href);
        await waitForQuestion(formSelector, 'max10000 ready');
        const maxNote = '가'.repeat(5000) + 'z'.repeat(5000);
        const canFill = await page.evaluate<boolean>(`(()=>{
          const form = document.querySelector('${selector}');
          for (const value of ['biped_std', 'density_high']) form.querySelector('input[type="radio"][value="' + value + '"]').click();
          const note = form.querySelector('textarea[name="note"]');
          if (!note) return false;
          note.value = ${JSON.stringify(maxNote)};
          note.dispatchEvent(new Event('input', {bubbles: true}));
          form.querySelector('button[type="submit"]').scrollIntoView({block: 'center'});
          return note.value.length === 10000;
        })()`);
        if (canFill) {
          await click(page, `${selector} button[type="submit"]`);
          await wait(`document.querySelector('${selector} > [role="status"]')?.textContent===${JSON.stringify(enCatalog['job.saved'])}`, 'max10000 saved');
          const maxAct = parseRecordAct(JSON.parse(await readFile(join(maxOut, 'one-screen.json'), 'utf8')));
          assert.equal(maxAct.kind, 'interview-picks');
          check(maxAct.value.note === maxNote && maxAct.value.note.length === 10000, 'End-to-end 10000-char note accepted');
        } else {
          check(false, 'End-to-end 10000-char note accepted (textarea missing)');
        }
      } finally {
        await page.goto('about:blank');
        await maxFixture.close();
      }
    }

    // 4. Bar 4: non-editable question shows disabled state with no textarea, and note as pre when present (and nothing when empty)
    const f4 = await interviewOpenFixture(2);
    let server4: {port?: number; stop(closeActiveConnections?: boolean): void} | undefined;
    let bar4: Record<string, unknown> = {};
    try {
      const project = f4.project as any;
      const item0 = project.interview.framing[0];
      const set0 = JSON.parse(await readFile(join(f4.root, item0.pending_options.path), 'utf8'));
      const pick0 = {ask: set0.asks[0].id, option_id: set0.asks[0].options[0].id, shown: {label: 'Keep', effect: 'Keep'}};
      item0.answer = {
        by: 'user',
        at: '2026-11-01T00:01:00.000Z',
        source: 'Review',
        verbatim: 'Answered with note',
        choice: {spec: 'rig-create/interview-choice@1', set: item0.pending_options, picks: [pick0], note: noteText},
      };
      delete item0.pending_options;

      const item1 = project.interview.framing[1];
      const set1 = JSON.parse(await readFile(join(f4.root, item1.pending_options.path), 'utf8'));
      const pick1 = {ask: set1.asks[0].id, option_id: set1.asks[0].options[0].id, shown: {label: 'Keep', effect: 'Keep'}};
      item1.answer = {
        by: 'user',
        at: '2026-11-01T00:02:00.000Z',
        source: 'Review',
        verbatim: 'Answered with empty note',
        choice: {spec: 'rig-create/interview-choice@1', set: item1.pending_options, picks: [pick1], note: ''},
      };
      delete item1.pending_options;

      await writeFile(join(f4.root, 'project.json'), JSON.stringify(project, null, 2) + '\n');
      const capability = 'a'.repeat(64);
      server4 = await startServer(null, {port: 0, capability, joined: joinProject(null, f4.inputs.project), stateDir: f4.stateDir});
      const url = `http://127.0.0.1:${server4.port}/?lang=${language}#cap=${capability}`;
      await page.goto('about:blank');
      await page.goto(url);
      await waitForQuestion('form.interview-answer', 'bar4 joined Question ' + language, false);
      const q0 = await page.evaluate<{disabled: boolean; noteCount: number; preText: string | null}>(`(()=>{
        const form = document.querySelector('${questionPanel} form.interview-answer');
        return {
          disabled: form.querySelector('fieldset.interview-answer-fields').disabled,
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preText: form.querySelector('pre.interview-note')?.textContent ?? null,
        };
      })()`);
      await click(page, `${questionPanel} .interview-questions li:nth-child(2) button`);
      await wait(`document.querySelector('${questionPanel} form.interview-answer h3')?.textContent==='rig_type'`, 'bar4 switched question ' + language);
      await waitForQuestion('form.interview-answer', 'bar4 joined second Question ' + language, false);
      const q1 = await page.evaluate<{disabled: boolean; noteCount: number; preCount: number}>(`(()=>{
        const form = document.querySelector('${questionPanel} form.interview-answer');
        return {
          disabled: form.querySelector('fieldset.interview-answer-fields').disabled,
          noteCount: form.querySelectorAll('textarea[name="note"]').length,
          preCount: form.querySelectorAll('pre.interview-note').length,
        };
      })()`);
      bar4 = {
        nonEmptyQuestion: q0,
        emptyNoteQuestion: q1,
        passed:
          q0.disabled === true &&
          q0.noteCount === 0 &&
          q0.preText === noteText &&
          q1.disabled === true &&
          q1.noteCount === 0 &&
          q1.preCount === 0,
      };
      check(Boolean(bar4.passed), `Bar 4 (${language})`, bar4);
    } finally {
      await page.goto('about:blank');
      server4?.stop(true);
      await f4.close();
    }

    results.push({language, bar1, bar2, bar3, bar4, bar5});
  }

  check(exceptions.length === 0, 'Zero runtime exceptions', exceptions);
  const summary = {
    passed: failures.length === 0,
    failures,
    exceptions,
    results,
  };
  await writeFile(join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('901_BROWSER_RESULT ' + JSON.stringify({passed: summary.passed, failures: failures.length}));
  assert.deepEqual(failures, []);
} finally {
  await page?.close();
  await rm(profile, {recursive: true, force: true});
}
