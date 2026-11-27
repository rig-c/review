import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {bindSceneCamera, ComposedTakeError, sceneCameraProjection, SCENE_CAMERA_REPORT_MAX_BYTES} from '@rig-c/play/composed-take';
import {JOB_ERROR_CODES} from '../src/job-contract.ts';
import {t, tr} from '../web/i18n.ts';
import {authoredPaneProjection} from '../web/rig-viewport-provider.ts';

test('#1273: docs/REVIEW_PACKAGE.md error codes bullet matches src/job-contract.ts JOB_ERROR_CODES', () => {
  const reviewPackage = readFileSync(new URL('../docs/REVIEW_PACKAGE.md', import.meta.url), 'utf8');
  const bullets = reviewPackage
    .split(/\r?\n/u)
    .filter(line => /^-\s+\*\*Error codes\.\*\*/u.test(line.trimStart()));
  expect(bullets).toHaveLength(1);

  const parenMatch = /\(([^)]*)\)/u.exec(bullets[0]!);
  expect(parenMatch).not.toBeNull();

  const docCodes = [...parenMatch![1]!.matchAll(/`([^`]+)`/gu)].map(match => match[1]!);
  const sourceSet = new Set<string>(JOB_ERROR_CODES);
  const docSet = new Set<string>(docCodes);
  const missing = JOB_ERROR_CODES.filter(code => !docSet.has(code));
  const extra = [...docSet].filter(code => !sourceSet.has(code));
  const duplicates = [...new Set(docCodes.filter((code, index) => docCodes.indexOf(code) !== index))];

  expect(
    {missing, extra},
    `docs/REVIEW_PACKAGE.md JOB_ERROR_CODES parity failed (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
  ).toEqual({missing: [], extra: []});
  expect(
    duplicates,
    `docs/REVIEW_PACKAGE.md JOB_ERROR_CODES contains duplicates: ${duplicates.join(', ')}`,
  ).toEqual([]);
  expect(docCodes).toEqual([...JOB_ERROR_CODES]);
});

test.each([
  ['loop', 'false', 'true'],
  ['duration', '0.7500000000000001', '0.75'],
])('#1316 direction take refusal shows both compared %s values in EN and KO', (field, found, required) => {
  const detail = `DIRECTION_TAKE_MISMATCH: direction.json take.${field} is ${found}; the idle track in producer/scene.json has ${field} ${required}.`;
  expect(tr(detail, 'en')).toBe(detail);
  expect(tr(detail, 'ko')).toBe(`DIRECTION_TAKE_MISMATCH: direction.json의 take.${field} 값은 ${found}인데, producer/scene.json의 idle 트랙은 ${required}예요.`);
});

test('#1316 the Rig and Comments refusals name the renderer or the actual numeric limit in EN and KO', () => {
  const main = readFileSync(new URL('../web/main.ts', import.meta.url), 'utf8');
  const extract = (start: string, end: string) => {
    const first = main.indexOf(start), last = main.indexOf(end, first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    return new Bun.Transpiler({loader: 'ts'}).transformSync(main.slice(first, last));
  };
  const rigGuard = extract('const renderer=player.renderer;\n   if(!(renderer instanceof CanvasRenderer))', 'const drawn={player,frame,projection:');
  const refusal = extract('function sceneCameraError(', 'async function loadSceneCamera(') +
    extract('function commentCaptureRefusal(', '/** #1048:');
  const pane = {clientWidth: 100, clientHeight: 100, clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({left: 0, top: 0})} as unknown as HTMLElement;
  const frame = {animation: 'idle', authoredSeconds: 0, compiledSeconds: 0, loop: true, zoom: 1, pan: [0, 0] as [number, number],
    viewWorld: {x: 0, y: 0, width: 100, height: 100}, output: {width: 100, height: 100}};
  const canvas = {getBoundingClientRect: () => ({left: 1e16, top: 0})} as unknown as HTMLCanvasElement;
  const authored = authoredPaneProjection(pane, canvas, 1, 1, frame, sceneCameraProjection(frame));
  expect(authored.camera).toBeNull();
  expect(authored.violation).toMatchObject({field: 'camera.limit.coordinate', min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER});
  for (const language of ['en', 'ko'] as const) {
    const scope = {player: {renderer: {}}, CanvasRenderer: class {}, ComposedTakeError,
      t: (key: string, params?: (string | number)[]) => t(key, params, language),
      errorText: (error: Error) => error.message, data: {manifest: {sceneReport: {path: 'camera.json'}}},
      sceneCameraRefusal: null, currentAuthoredProjection: () => authored, el: () => pane};
    const evaluate = new Function('scope', `with(scope){${refusal};return {rig:()=>{${rigGuard}},commentCaptureRefusal,sceneCameraError};}`)(scope);
    expect(evaluate.rig).toThrow(language === 'en'
      ? 'SCENE_CAMERA_VIEW_INVALID: Found the DOM renderer. Authored playback requires the Rig viewport canvas. Reopen the review to restore that canvas.'
      : 'SCENE_CAMERA_VIEW_INVALID: DOM 렌더러가 감지됐어요. 작성된 카메라로 재생하려면 리그 뷰포트 캔버스가 필요해요. 리뷰를 다시 열어 캔버스를 복구하세요.');
    const {value, min, max} = authored.violation!;
    expect(evaluate.commentCaptureRefusal()).toBe(language === 'en'
      ? `SCENE_CAMERA_VIEW_INVALID: camera.json · Projected world coordinate is ${value}. It must be between ${min} and ${max} to save a pinned comment. Select Fit to reset the view.`
      : `SCENE_CAMERA_VIEW_INVALID: camera.json · 투영된 월드 좌표의 현재 값은 ${value}이에요. 핀 코멘트를 저장하려면 ${min} 이상 ${max} 이하여야 해요. 맞춤을 눌러 뷰를 초기화하세요.`);
    try {
      bindSceneCamera(Uint8Array.of(0xff), {sha256: '', stage: null, animations: []});
      throw new Error('Malformed UTF-8 was accepted');
    } catch (error) {
      expect(evaluate.sceneCameraError(error)).toBe(language === 'en'
        ? 'SCENE_CAMERA_REPORT_INVALID: camera.json · The scene report is not valid UTF-8 JSON.'
        : 'SCENE_CAMERA_REPORT_INVALID: camera.json · 장면 리포트가 올바른 UTF-8 JSON 형식이 아니에요.');
    }
  }
});

test('#1316 browser refuses an oversized streamed report before hashing or binding', async () => {
  const main = readFileSync(new URL('../web/main.ts', import.meta.url), 'utf8');
  const start = main.indexOf('async function loadSceneCamera('), end = main.indexOf('function configurePartSets(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const js = new Bun.Transpiler({loader: 'ts'}).transformSync(main.slice(start, end));
  const body = new ReadableStream<Uint8Array>({start(controller) {
    controller.enqueue(new Uint8Array(SCENE_CAMERA_REPORT_MAX_BYTES));
    controller.enqueue(Uint8Array.of(1));
    controller.close();
  }});
  const scope = {data: {manifest: {sceneReport: {path: 'camera.json', sha256: '0'.repeat(64)}}},
    assetUrl: (path: string) => path, lifecycle: new AbortController(), t, ComposedTakeError,
    fetch: async () => new Response(body), SCENE_CAMERA_REPORT_MAX_BYTES,
    playbackDigest: () => { throw new Error('Oversized input reached hashing'); },
    bindSceneCamera: () => { throw new Error('Oversized input reached binding'); }};
  const load = new Function('scope', `with(scope){${js};return loadSceneCamera;}`)(scope);
  await expect(load({}, '0'.repeat(64))).rejects.toMatchObject({code: 'SCENE_CAMERA_REPORT_TOO_LARGE'});
});
