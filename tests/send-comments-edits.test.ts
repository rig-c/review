/** #1231: a pending Edit Mesh or chest edit is content for Send comments, like an unsent comment. Runs the actual
 * main.ts helpers, save-state renderer, Send comments handler and disabled rule without a browser. */
import {expect, test} from 'bun:test';

function host(options: {edits: boolean; rows?: {id: string; summary: string}[]}) {
  const sends: [unknown, unknown][] = [];
  let edits = options.edits;
  return {sends, clearEdits: () => {edits = false;}, host: {
    verdictComments: {rows: options.rows ?? []},
    canSubmitMeshEdits: () => edits,
    reviewState: () => undefined, verdictAnswered: () => false,
    submitComments: async (feedback: unknown, general: unknown) => {sends.push([feedback, general]); edits = false; return 'job.saved';},
  }};
}

async function app(options: {edits: boolean; rows?: {id: string; summary: string}[]}) {
  const fixture = host(options), confirms: string[] = [];
  const source = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const slice = (start: string, end: string) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    if (from < 0 || to < 0) throw new Error('main.ts slice not found: ' + start);
    return source.slice(from, to);
  };
  const disabled = /\n {2}sendComments\.disabled=[^\n]*\n/.exec(source)?.[0];
  if (!disabled) throw new Error('main.ts disabled rule not found');
  const javascript = new Bun.Transpiler({loader: 'ts'}).transformSync(
    slice('const unsentFeedback=', 'function renderDraftState(): void {') +
    slice('function renderDraftState(): void {', 'function renderProvenance(') +
    slice('  sendComments.onclick=async()=>{', '  chestEditor=bindChestEditor(') +
    'function renderDisabled(blocked,readOnly){' + disabled + '}');
  const run = new Function('host', 'confirms', `
    let session = {feedback: [], updatedAt: null}, saving = false, commentSending = false, dirty = false;
    let commentSendState = null, draftConflict = false, actReadOnly = null, draftStatus = null, pendingStageComment = null;
    let recordSaveStateShown = false;
    const saveStates = [], sent = {}, sendComments = {disabled: false, hidden: false, onclick: null};
    const rigInspector = {actBar: {setSaveState: value => saveStates.push(value)}};
    const commentHost = () => true, isSubmittedFeedback = () => false, liveIssueCount = () => 0;
    const sentAloneRows = () => sent;
    function isSentAlone(row) {return sent[row.id] === JSON.stringify(row);}
    function markSentAlone(rows) {for (const row of rows) sent[row.id] = JSON.stringify(row);}
    const comments = {hasPendingComment: () => false, refresh() {}};
    const message = () => {}, jobSubmissionRefusal = error => ({text: String(error), title: ''});
    function renderAnswerControls() {} function updateSavedState() {} function renderProposals() {}
    const window = {confirm: text => {confirms.push(text); return false;}};
    globalThis.confirm = window.confirm;
    ${javascript}
    return {click: () => sendComments.onclick(), disabled: () => {renderDisabled(false, null); return sendComments.disabled;},
      saveState: () => {renderDraftState(); return saveStates.at(-1);},
      editChanged: () => {renderEditDraftState(); return saveStates.at(-1);}};
  `);
  return {...fixture, confirms, ...(run(fixture.host, confirms) as {click(): Promise<void>; disabled(): boolean;
    saveState(): {kind: string; text: string}; editChanged(): {kind: string; text: string}})};
}

test('#1231 Send comments is enabled with only a pending edit, reads Not submitted, and sends without a confirm', async () => {
  const page = await app({edits: true});
  expect(page.disabled()).toBe(false);
  expect(page.saveState()).toEqual({kind: 'unsaved', text: 'Not submitted'});
  // An edit made after the page settled refreshes the save state, not only the buttons.
  expect(page.editChanged()).toEqual({kind: 'unsaved', text: 'Not submitted'});
  await page.click();
  expect(page.sends).toEqual([[[], []]]);
  // HQ ruling: Send comments never confirms, even when it carries mesh edits.
  expect(page.confirms).toEqual([]);
  expect(page.disabled()).toBe(true);
  expect(page.saveState()).toEqual({kind: 'saved', text: 'Submitted'});
});

test('#1231 with no comment and no edit Send comments stays disabled and a click sends nothing', async () => {
  const page = await app({edits: false});
  expect(page.disabled()).toBe(true);
  expect(page.saveState()).toEqual({kind: 'unsaved', text: 'Not submitted'});
  await page.click();
  expect(page.sends).toEqual([]);
});

test('#1231 an unsent comment still enables Send comments and is sent with the edits', async () => {
  const page = await app({edits: true, rows: [{id: 'general-1', summary: 'The chest sits low.'}]});
  expect(page.disabled()).toBe(false);
  await page.click();
  expect(page.sends).toEqual([[[], ['The chest sits low.']]]);
  expect(page.confirms).toEqual([]);
});
