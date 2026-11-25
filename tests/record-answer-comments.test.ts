/** #1242 (Codex P2s on #1247): on a record screen, Send comments and the record answer never carry the same row
 * twice, and never drop a row neither of them carried. Runs the actual main.ts helpers, save-state renderer, Send
 * comments handler, the record answer's comment callback and its saved listener without a browser. */
import {expect, test} from 'bun:test';

type Row = {id: string; summary: string};
type Page = {
  unsent(): string[]; add(row: Row): void; render(): void; click(): Promise<void>;
  answerComments(): {text: string}[]; answerSaved(): void; sends: unknown[];
};

const source = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
const slice = (start: string, end: string) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('main.ts slice not found: ' + start);
  return source.slice(from, to);
};
const pick = (pattern: RegExp, name: string) => {
  const found = pattern.exec(source)?.[1];
  if (!found) throw new Error('main.ts ' + name + ' not found');
  return found;
};
const javascript = new Bun.Transpiler({loader: 'ts'}).transformSync(
  slice('/** #1226: rows sent on their own', 'function renderDraftState(): void {') +
  slice('function renderDraftState(): void {', 'function renderProvenance(') +
  slice('function recordJobComments(', 'function projectRecordComments(') +
  'const interviewComments=' + pick(/\.interviewComments=([^\n]*);\n/, 'interviewComments callback') + ';\n' +
  'const onAnswerSaved=' + pick(/'job-answer-saved',(\(\)=>\{[^\n]*?\}),\{once:true\}/, 'job-answer-saved listener') + ';\n');

/** One page load over a shared localStorage; a second call with the same storage is a reload. */
function load(storage: Map<string, string>, rows: Row[], restoredAnswer: boolean): Page {
  const sends: unknown[] = [];
  const host = {
    record: {}, recordSubmission: () => undefined, reviewState: () => undefined, verdictAnswered: () => false,
    submitComments: async (feedback: unknown, general: unknown) => {sends.push([feedback, general]); return 'job.saved';},
  };
  const run = new Function('host', 'rows', 'restoredAnswer', 'storage', `
    let session = null, saving = false, commentSending = false, dirty = false, answerSaved = restoredAnswer;
    let commentSendState = null, draftConflict = false, actReadOnly = null, draftStatus = null, pendingStageComment = null;
    let recordSaveStateShown = false, recordAnswered = false, sentAloneCache = null, answerInFlightRows = [];
    const rowStoreCache = new Map(), answeredRecordRows = new Map(), submittedDirectionComments = new Set();
    const recordComments = rows.slice();
    const localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)};
    const sendComments = {disabled: false, hidden: false, onclick: null};
    const rigInspector = {actBar: {setSaveState() {}}};
    const commentBinding = () => ({publicationId: 'publication-1', sourceHash: 'source-1'});
    const commentHost = () => true, isSubmittedFeedback = () => false, liveIssueCount = () => 0;
    const comments = {hasPendingComment: () => false, refresh() {}};
    const message = () => {}, jobSubmissionRefusal = error => ({text: String(error), title: ''});
    const el = () => ({classList: {contains: () => false}}), sourceTextContent = () => '';
    const partsIssueComments = () => [], feedbackItemComments = () => [];
    function renderAnswerControls() {} function updateSavedState() {} function renderProposals() {}
    ${javascript}
    return {unsent: () => unsentComments().general.map(row => row.id), add: row => recordComments.push(row),
      render: () => renderDraftState(), click: () => sendComments.onclick(),
      answerComments: () => interviewComments(), answerSaved: () => onAnswerSaved()};
  `);
  return {sends, ...(run(host, rows, restoredAnswer, storage) as Omit<Page, 'sends'>)};
}

const first = {id: 'general-1', summary: 'The chest sits low.'};
const during = {id: 'general-2', summary: 'Written while the answer was sending.'};
const later = {id: 'general-3', summary: 'Written after the reload.'};

test('#1242 an answered record keeps comments the answer did not carry for Send comments, across a reload', () => {
  const storage = new Map<string, string>();
  const page = load(storage, [first], false);
  page.render();
  expect(page.unsent()).toEqual(['general-1']);
  expect(page.answerComments()).toEqual([{text: first.summary}]);
  // A comment written while the answer is in flight was not carried by it.
  page.add(during);
  page.answerSaved();
  expect(page.unsent()).toEqual(['general-2']);

  // Reload: the restored answered state does not swallow rows written since.
  const reloaded = load(storage, [first, during, later], true);
  reloaded.render();
  expect(reloaded.unsent()).toEqual(['general-2', 'general-3']);
});

test('#1242 a comment sent on its own is not sent again inside a later record answer', async () => {
  const page = load(new Map(), [first], false);
  page.render();
  await page.click();
  expect(page.sends).toEqual([[[], [first.summary]]]);
  expect(page.unsent()).toEqual([]);
  expect(page.answerComments()).toEqual([]);
  page.add(during);
  expect(page.answerComments()).toEqual([{text: during.summary}]);
});
