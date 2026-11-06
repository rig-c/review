import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  settleStage1Apply, settleStage1Mesh, stage1ApplyRead, STAGE1_READINESS, waitForStage1Readiness,
} from './stage1-corrections-browser.ts';

function pageWith(globals: object) {
  const reads: string[] = [];
  return {
    reads,
    async evaluate<T>(expression: string): Promise<T> {
      reads.push(expression);
      return runInNewContext(expression, globals) as T;
    },
  };
}

type ReadyName = keyof typeof STAGE1_READINESS;
const partsNames = ['PARTS_NOT_READY', 'SCRATCH_NOT_READY', 'MESH_ROUTE_TIMEOUT', 'DELTA_ROUTE_TIMEOUT'] as const;
const visibleFrame = '.review-stage-panel iframe:not([hidden])';

function partsPage(ready?: string, hidden = false) {
  const frame = {contentDocument: {body: {dataset: {ready}, textContent: 'fixture'}}};
  return pageWith({document: {querySelector: (selector: string) => {
    return hidden && selector.includes(':not([hidden])') ? undefined : frame;
  }}});
}

function handoffPage(editor: object | undefined, text?: string) {
  return pageWith({
    window: {rigReviewEditor: editor},
    document: {getElementById: (id: string) => id === 'handoff-line' && text !== undefined ? {textContent: text} : null},
  });
}

function chestPage(stage: string, pressed: string) {
  return pageWith({
    document: {
      documentElement: {dataset: {inspectionStage: stage}},
      getElementById: () => ({getAttribute: () => pressed}),
    },
  });
}

const edit = {hull: 1, drawn: []};
const deltaPage = (value: unknown) => pageWith({window: {rigReviewEditor: {meshEdit: () => value}}});
const resetPage = (disabled: boolean) => pageWith({document: {getElementById: () => ({disabled})}});

const unready: [ReadyName, string, ReturnType<typeof pageWith>][] = [
  ['PAGE_NOT_READY', 'editor absent', handoffPage(undefined, 'ready')],
  ['PAGE_NOT_READY', 'handoff missing', handoffPage({})],
  ['PAGE_NOT_READY', 'handoff empty', handoffPage({}, '')],
  ['PAGE_NOT_READY', 'handoff still reading', handoffPage({}, 'Reading producer')],
  ['CHEST_NOT_OPEN', 'wrong stage', chestPage('1', 'true')],
  ['CHEST_NOT_OPEN', 'not pressed', chestPage('3', 'false')],
  ['DELTA_EDITOR_NOT_OPEN', 'editor returned null', deltaPage(null)],
  ['RESET_TIMEOUT', 'button enabled', resetPage(false)],
];
for (const name of partsNames) {
  unready.push([name, 'false marker is truthy but not ready', partsPage('false')]);
  unready.push([name, 'ready iframe is hidden', partsPage('true', true)]);
}
for (const [name, label, page] of unready) {
  test(`${name} refuses ${label} through its actual readiness waiter`, async () => {
    let after = 0;
    await expect(waitForStage1Readiness(page, name, 60).then(() => { after++; })).rejects.toThrow(`WALK_DEADLINE: ${name}`);
    expect(after).toBe(0);
    expect(page.reads.length).toBeGreaterThan(0);
  });
}

test('the actual readiness waiter accepts complete state and returns the delta editor value', async () => {
  await waitForStage1Readiness(handoffPage({}, 'Ready'), 'PAGE_NOT_READY');
  for (const name of partsNames) {
    const page = partsPage('true');
    await waitForStage1Readiness(page, name);
    expect(page.reads[0]).toContain(visibleFrame);
  }
  await waitForStage1Readiness(chestPage('3', 'true'), 'CHEST_NOT_OPEN');
  expect(await waitForStage1Readiness<typeof edit>(deltaPage(edit), 'DELTA_EDITOR_NOT_OPEN')).toEqual(edit);
  await waitForStage1Readiness(resetPage(true), 'RESET_TIMEOUT');
});

function applyPage() {
  const actions: unknown[] = [];
  const state = {record: '', chestDisabled: false, deltaDisabled: false, chestError: false, selected: 'torso', ops: [1]};
  const field = {value: '9', dispatchEvent: () => actions.push('input')};
  const elements = {
    'bust-r-x': field,
    'bust-apply': {get disabled() { return state.chestDisabled; }, click: () => actions.push('chest apply')},
    'mesh-apply': {get disabled() { return state.deltaDisabled; }, click: () => actions.push('delta apply')},
    'rebuild-applied': {get value() { return state.record; }},
    'chest-editor-status': {textContent: 'planted chest error', classList: {contains: () => state.chestError}},
    'mesh-editor-status': {textContent: 'delta pending'},
  };
  const page = pageWith({
    Event,
    window: {rigReviewEditor: {meshEdit: () => ({ops: state.ops})}},
    document: {
      getElementById: (id: keyof typeof elements) => elements[id],
      querySelector: (selector: string) => selector.includes('data-slot="badge"')
        ? {click: () => { actions.push('badge'); state.selected = 'badge'; }}
        : {dataset: {slot: state.selected}},
    },
  });
  return {page, state, actions, field};
}

const checked = {schema: 'rig-review-applied/3', part: 'torso'};
test('Apply readback retains raw value, previous value, schema, and button guards', async () => {
  const {page, state} = applyPage();
  for (const name of ['CHEST_APPLY_SETTLE', 'CHEST_REPEAT_APPLY_SETTLE', 'MESH_DELTA_APPLY_SETTLE'] as const) {
    state.record = '';
    expect(await page.evaluate(stage1ApplyRead(name, 'old'))).not.toHaveProperty('applied');
    state.record = JSON.stringify(checked);
    state.chestDisabled = state.deltaDisabled = true;
    expect(await page.evaluate(stage1ApplyRead(name, 'old'))).not.toHaveProperty('applied');
    state.chestDisabled = state.deltaDisabled = false;
    expect(await page.evaluate(stage1ApplyRead(name, 'old'))).toHaveProperty('applied', checked);
  }
  expect(await page.evaluate(stage1ApplyRead('CHEST_REPEAT_APPLY_SETTLE', state.record))).not.toHaveProperty('applied');
  state.record = JSON.stringify({...checked, schema: 'rig-review-applied/2'});
  expect(await page.evaluate(stage1ApplyRead('MESH_DELTA_APPLY_SETTLE'))).not.toHaveProperty('applied');
});

test('repeat chest rejects unchanged evidence by name, with one dispatch and no later action', async () => {
  const {page, state, actions, field} = applyPage();
  state.record = JSON.stringify(checked);
  await expect(settleStage1Apply(page, 'CHEST_REPEAT_APPLY_SETTLE', 2, 100)
    .then(() => actions.push('after'))).rejects.toThrow('WALK_DEADLINE: CHEST_REPEAT_APPLY_SETTLE');
  expect(field.value).toBe('11');
  expect(actions).toEqual(['input', 'chest apply']);
  const atExpiry = page.reads.length;
  state.record = JSON.stringify({...checked, part: 'new'});
  await Bun.sleep(50);
  expect(page.reads).toHaveLength(atExpiry);
  expect(actions).toEqual(['input', 'chest apply']);
});

test('native chest applies once and delta refuses missing ops before dispatch', async () => {
  const {page, state, actions, field} = applyPage();
  state.record = JSON.stringify(checked);
  expect(await settleStage1Apply(page, 'CHEST_APPLY_SETTLE', 1)).toEqual(checked);
  expect(actions).toEqual(['badge', 'input', 'chest apply']);
  expect(field.value).toBe('10');
  state.ops = [];
  await expect(settleStage1Apply(page, 'MESH_DELTA_APPLY_SETTLE', 0)).rejects.toThrow('NO_DELTA_OPS');
  expect(actions).toEqual(['badge', 'input', 'chest apply']);
  state.ops = [1];
  expect(await settleStage1Apply(page, 'MESH_DELTA_APPLY_SETTLE', 0)).toEqual(checked);
  expect(actions).toEqual(['badge', 'input', 'chest apply', 'delta apply']);
});

test('chest errors propagate and a lost Apply reply never retries', async () => {
  const {page, state, actions} = applyPage();
  state.chestError = true;
  await expect(settleStage1Apply(page, 'CHEST_APPLY_SETTLE', 1)).rejects.toThrow('planted chest error');
  expect(actions).toEqual(['badge', 'input', 'chest apply']);
  const lost = applyPage();
  await expect(settleStage1Apply({
    async evaluate<T>(expression: string): Promise<T> {
      await lost.page.evaluate(expression);
      throw Error('lost dispatch reply');
    },
  }, 'CHEST_REPEAT_APPLY_SETTLE', 1)).rejects.toThrow('lost dispatch reply');
  expect(lost.actions).toEqual(['input', 'chest apply']);
  expect(lost.page.reads).toHaveLength(1);
});

function meshPage(apply: () => unknown, part = 'torso') {
  const actions: unknown[] = [];
  const window = {rigReviewEditor: {mesh: {
    part: () => part,
    set: (path: string[], value: number) => actions.push({path, value}),
    apply: () => { actions.push('apply'); return apply(); },
  }}};
  return {page: pageWith({window}), actions};
}

test('VM slow mesh Apply hits the named cap and ignores a late fulfillment', async () => {
  let finish!: (result: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const {page, actions} = meshPage(() => pending);
  await expect(settleStage1Mesh(page, 20, 500).then(() => actions.push('after'))).rejects.toThrow(
    'WALK_DEADLINE: STAGE1_MESH_SETTLE (500ms)',
  );
  expect(actions).toEqual([{path: ['contour', 'spacing'], value: 20}, 'apply']);
  const atExpiry = page.reads.length;
  expect(atExpiry).toBeGreaterThan(1);
  finish({status: 'built'});
  await Bun.sleep(50);
  expect(page.reads).toHaveLength(atExpiry);
  expect(actions).toHaveLength(2);
});

test('mesh returns the whole job and propagates async rejection', async () => {
  const job = {status: 'built', check: {pass: true}, modelHash: 'fixture'};
  const built = meshPage(() => Promise.resolve(job));
  expect(await settleStage1Mesh(built.page, 18)).toEqual(job);
  expect(built.actions).toEqual([{path: ['contour', 'spacing'], value: 18}, 'apply']);
  const rejected = meshPage(() => Promise.reject(Error('producer rejected')));
  await expect(settleStage1Mesh(rejected.page, 20)).rejects.toThrow('producer rejected');
  expect(rejected.actions).toHaveLength(2);
});

test('wrong mesh part refuses synchronously before mutating or applying', async () => {
  const {page, actions} = meshPage(() => { throw Error('must not run'); }, 'badge');
  await expect(settleStage1Mesh(page, 18)).rejects.toThrow('WRONG_PARAMETER_PART');
  expect(actions).toEqual([]);
  expect(page.reads).toHaveLength(1);
});

test('ambiguous mesh dispatch never resends or starts readback', async () => {
  const {page, actions} = meshPage(() => new Promise(() => {}));
  await expect(settleStage1Mesh({
    async evaluate<T>(expression: string): Promise<T> {
      await page.evaluate(expression);
      throw Error('lost mesh dispatch reply');
    },
  }, 18)).rejects.toThrow('lost mesh dispatch reply');
  expect(actions).toHaveLength(2);
  expect(page.reads).toHaveLength(1);
});
