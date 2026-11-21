/** #1048 PR1 (HQ ruling 2, A1): a record-host pin on the shown plan picture projects its picture identity and
 * natural-pixel region into the signed words; rig and package labels stay byte-identical to main. */
import {expect, test} from 'bun:test';
import {parsePictureCommentLabel, projectComments, timeOnlyBasis, type StageComment} from '../src/stage-comment.ts';
import type {JobComment} from '../src/job-contract.ts';

const sha = (c: string) => c.repeat(64);
const png = 'data:image/png;base64,iVBORw0KGgo=';
function mark(viewport: 'rig' | 'reference', extra: Partial<StageComment> = {}): StageComment {
  const camera = viewport === 'rig'
    ? {space: 'world', center: {x: 0, y: 0}, zoom: 1, viewport: {width: 100, height: 100}, visible: {x: -50, y: -50, width: 100, height: 100}}
    : {space: 'image', center: {x: 32, y: 24}, zoom: 1, viewport: {width: 64, height: 48}, visible: {x: 0, y: 0, width: 64, height: 48}};
  return {schema: 'rig-review-comment/1', mode: 'setup', viewport, frame: null, timeBasis: timeOnlyBasis, time: 0, animation: null,
    sourceHash: sha('a'), modelHash: viewport === 'rig' ? sha('b') : null, referenceHash: null, referenceId: null,
    camera: camera as StageComment['camera'], screen: {x: 10.4, y: 20.6, width: 7.5, height: 3.2}, world: {x: 10.4, y: 20.6, width: 7.5, height: 3.2},
    slots: [], crop: {path: `comment-crops/${sha('c')}.png`, sha256: sha('c'), png, width: 1, height: 1},
    bookmark: {binding: {mode: 'single'}, selection: {inspector: 'rig'}}, ...extra};
}
function row(m: StageComment): JobComment {
  return {text: 'Fix this', anchor: {id: 'c1', frameStart: null, frameEnd: null, target: {kind: 'rig', name: 'plan.png'}, category: 'defect',
    context: {animation: null, time: 0, frame: null, interval: null, comment: m as never}} as never};
}
const picture = {path: 'plan/plan.png', sha256: sha('d')};
const pictureMark = mark('reference', {referenceId: picture.path, referenceHash: picture.sha256});

/* Captured from 6d58906 (main before this card) with the same inputs. */
const GOLDEN_RIG = '[["rig-review-comment/1","setup","rig","rig","plan.png",null,null]]\nFix this';
const GOLDEN_PACKAGE_REFERENCE = '[["rig-review-comment/1","setup","reference","rig","plan.png",null,null]]\nFix this';

test('#1048 rig and package reference labels stay byte-identical to main, with or without a shown picture', () => {
  const rig = row(mark('rig')), reference = row(mark('reference', {referenceId: 'ref-a', referenceHash: sha('e')}));
  expect(projectComments([rig])).toBe(GOLDEN_RIG);
  expect(projectComments([reference])).toBe(GOLDEN_PACKAGE_REFERENCE);
  expect(projectComments([rig], [picture])).toBe(GOLDEN_RIG);
  expect(projectComments([reference], [picture])).toBe(GOLDEN_PACKAGE_REFERENCE);
  // Without the record's sealed picture list a picture pin takes the old branch: a package caller is unchanged.
  expect(projectComments([row(pictureMark)])).toBe(GOLDEN_PACKAGE_REFERENCE);
});

test('#1048 A1: a plan-picture pin projects [schema, mode, reference, path, sha256, x, y, w, h] in integer natural pixels', () => {
  const words = projectComments([row(pictureMark)], [picture]);
  expect(words).toBe(`[["rig-review-comment/1","setup","reference","plan/plan.png","${sha('d')}",10,21,8,3]]\nFix this`);
  const point = projectComments([row({...pictureMark, world: {x: 31.6, y: 4.2, width: 0, height: 0}})], [picture]);
  expect(point).toBe(`[["rig-review-comment/1","setup","reference","plan/plan.png","${sha('d')}",32,4,0,0]]\nFix this`);
  const label = words.split('\n')[0]!.slice(1, -1);
  expect(parsePictureCommentLabel(label)).toEqual({mode: 'setup', referenceId: picture.path, referenceHash: picture.sha256,
    region: {x: 10, y: 21, width: 8, height: 3}});
});

test('#1048 a picture pin whose sha256 is not the sealed entry, or a label that does not parse back, refuses by name', () => {
  expect(() => projectComments([row({...pictureMark, referenceHash: sha('f')})], [picture])).toThrow('COMMENT_PICTURE_LABEL_INVALID');
  for (const bad of ['["rig-review-comment/1","setup","rig","plan/plan.png","' + sha('d') + '",1,2,3,4]',
    '["rig-review-comment/1","setup","reference","plan/plan.png","nothex",1,2,3,4]',
    '["rig-review-comment/1","setup","reference","plan/plan.png","' + sha('d') + '",1.5,2,3,4]',
    '["rig-review-comment/1","setup","reference","plan/plan.png","' + sha('d') + '",1,2,-3,4]',
    '["rig-review-comment/1","setup","reference","plan/plan.png","' + sha('d') + '",1,2,3]',
    'not json']) expect(() => parsePictureCommentLabel(bad)).toThrow('COMMENT_PICTURE_LABEL_INVALID');
});

/* The restore path is main.ts's own code (the #798 slice technique): a saved plan-picture pin restores only when its
 * A1 label parses back to the sealed entry; otherwise the draft is refused and the reason is named. */
async function restore(rows: unknown[], planPicture: object | undefined = {...picture, name: 'plan.png', src: 'blob:x'},
  questionPictures?: readonly {path: string; sha256: string}[]) {
  const {feedbackItemComments, parseStageComment} = await import('../src/stage-comment.ts');
  const main = await Bun.file(new URL('../web/main.ts', import.meta.url)).text();
  const start = main.indexOf('function restoreRecordComments('), end = main.indexOf('/** Comments remain native rows', start);
  const code = new Bun.Transpiler({loader: 'ts'}).transformSync(main.slice(start, end));
  const messages: [string, boolean][] = [];
  const saved = {publicationId: 'publication', sourceHash: sha('a'), comments: rows};
  const scope = {host: {record: {publicationId: 'publication', sourceHash: sha('a'), hasPicture: false, ...planPicture ? {planPicture} : {},
    ...questionPictures ? {questionPictures} : {}}}, recordCommentKey: '',
    recordComments: [] as unknown[], localStorage: {getItem: () => JSON.stringify(saved)}, data: undefined,
    projectComments, feedbackItemComments, parseStageComment, parsePictureCommentLabel, message: (value: string, error: boolean) => messages.push([value, error])};
  new Function('scope', `with(scope){${code};restoreRecordComments();}`)(scope);
  return {rows: scope.recordComments, messages};
}
const savedRow = (m: StageComment) => ({id: 'c1', summary: 'Fix this', frameStart: null, frameEnd: null, target: {kind: 'rig', name: 'plan.png'}, category: 'defect',
  context: {animation: null, time: 0, frame: null, interval: null, comment: m}});

test('#1048 restore keeps a pin that names the sealed picture and refuses, by name, one whose label does not parse back', async () => {
  const kept = await restore([savedRow(pictureMark)]);
  expect(kept.rows.length).toBe(1);
  expect(kept.messages).toEqual([]);
  for (const bad of [{...pictureMark, referenceHash: sha('f')}, {...pictureMark, referenceId: 'plan/other.png'}]) {
    const refused = await restore([savedRow(bad)]);
    expect(refused.rows).toEqual([]);
    expect(refused.messages.length).toBe(1);
    expect(refused.messages[0]![0]).toStartWith('COMMENT_PICTURE_LABEL_INVALID');
    expect(refused.messages[0]![1]).toBe(true);
  }
});

/* #1048 PR2: an interview question image is a second sealed source; PR1's labels must not move. */
const questionPicture = {path: 'inputs/reference.png', sha256: sha('9')};
const questionMark = mark('reference', {referenceId: questionPicture.path, referenceHash: questionPicture.sha256});
/* PR1's plan-picture label as 285a59f emits it for the A1 test's inputs. */
const GOLDEN_PLAN_PICTURE = `[["rig-review-comment/1","setup","reference","plan/plan.png","${sha('d')}",10,21,8,3]]\nFix this`;

test('#1048 PR2 rig, package and plan-picture labels stay byte-identical with question pictures in the sealed list', () => {
  const both = [picture, questionPicture];
  expect(projectComments([row(mark('rig'))], both)).toBe(GOLDEN_RIG);
  expect(projectComments([row(mark('reference', {referenceId: 'ref-a', referenceHash: sha('e')}))], both)).toBe(GOLDEN_PACKAGE_REFERENCE);
  expect(projectComments([row(pictureMark)], both)).toBe(GOLDEN_PLAN_PICTURE);
  expect(projectComments([row(pictureMark)], [picture])).toBe(GOLDEN_PLAN_PICTURE);
});

test('#1048 PR2 a question-image pin projects the same A1 label from its sealed entry', () => {
  expect(projectComments([row(questionMark)], [questionPicture]))
    .toBe(`[["rig-review-comment/1","setup","reference","inputs/reference.png","${sha('9')}",10,21,8,3]]\nFix this`);
  expect(() => projectComments([row({...questionMark, referenceHash: sha('f')})], [questionPicture])).toThrow('COMMENT_PICTURE_LABEL_INVALID');
});

test('#1048 PR2 restore keeps a question-image pin against its sealed entry and refuses one that names neither', async () => {
  const kept = await restore([savedRow(questionMark)], undefined, [questionPicture]);
  expect(kept.rows.length).toBe(1);
  expect(kept.messages).toEqual([]);
  for (const bad of [{...questionMark, referenceHash: sha('f')}, {...questionMark, referenceId: 'inputs/other.png'}]) {
    const refused = await restore([savedRow(bad)], undefined, [questionPicture]);
    expect(refused.rows).toEqual([]);
    expect(refused.messages[0]![0]).toStartWith('COMMENT_PICTURE_LABEL_INVALID');
  }
});
