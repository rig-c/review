import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { cropWorldMapping } from '../src/chest-regions.ts';
import { readingSeekTime } from '../src/readings.ts';
import { chestField } from '../web/chest-editor.ts';
import { chestOverlayPolygons, chestRegionRows, chestRowId, evaluateChestForm } from '../web/chest-regions-tool.ts';
import { formatSeconds } from '../web/format-seconds.ts';
import { chestSeed, type RebuildStatusView } from '../web/rebuild-client.ts';

const comparePickedSource = await readFile(new URL('../web/compare-picked-tools.ts', import.meta.url), 'utf8');
const transpiler = new Bun.Transpiler({ loader: 'ts' });

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end <= start) {
    throw new Error(`Slice markers not found: ${startMarker} .. ${endMarker}`);
  }
  return source.slice(start, end);
}

class MockOption {
  value: string;
  textContent: string;
  constructor(value: string, label: string) {
    this.value = value;
    this.textContent = label;
  }
}

class MockElement {
  id: string;
  tagName: string;
  type = 'text';
  checked = false;
  readOnly = false;
  disabled = false;
  hidden = false;
  textContent = '';
  title = '';
  dataset: Record<string, string> = {};
  children: MockOption[] = [];
  private _value = '';
  private classes = new Set<string>();

  classList = {
    add: (...names: string[]) => { for (const n of names) this.classes.add(n); },
    remove: (...names: string[]) => { for (const n of names) this.classes.delete(n); },
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classes.has(name);
      if (on) this.classes.add(name);
      else this.classes.delete(name);
      return on;
    },
    contains: (name: string) => this.classes.has(name),
  };

  constructor(id: string, tagName = 'INPUT') {
    this.id = id;
    this.tagName = tagName;
  }

  get value(): string {
    return this._value;
  }

  set value(next: string) {
    if (this.tagName === 'SELECT') {
      if (this.children.some(opt => opt.value === next)) {
        this._value = next;
      } else if (next === '') {
        this._value = this.children[0]?.value ?? '';
      }
      return;
    }
    this._value = next;
  }

  replaceChildren(...nodes: MockOption[]): void {
    this.children = [...nodes];
    if (this.tagName === 'SELECT') {
      this._value = this.children[0]?.value ?? '';
    }
  }

  append(...nodes: MockOption[]): void {
    const wasEmpty = this.children.length === 0;
    this.children.push(...nodes);
    if (this.tagName === 'SELECT' && wasEmpty && this._value === '' && this.children.length > 0) {
      this._value = this.children[0]!.value;
    }
  }
}

test('#1302: Compare seekReading refuses a reading time outside the shared domain without seeking', async () => {
  const fnCode = transpiler.transformSync(
    sliceBetween(comparePickedSource, '  function seekReading(', '  function sampleLocals('),
  );
  const makeSeekReading = new Function('scope', `with (scope) { ${fnCode}; return seekReading; }`);

  const sought: number[] = [];
  const messages: Array<{ text: string; error: boolean }> = [];
  let pauses = 0;
  let messageElError = false;
  const fakeDoc = {
    getElementById: (id: string) =>
      id === 'message' ? { classList: { contains: (c: string) => c === 'error' && messageElError } } : null,
  };
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });

  try {
    const seekReading = makeSeekReading({
      readingSeekTime,
      formatSeconds,
      clipDuration: () => 2,
      host: {
        duration: () => 1,
        pause: () => { pauses++; },
        message: (text: string, error = false) => {
          messageElError = error;
          messages.push({ text, error });
        },
        seekTo: async (t: number) => {
          messageElError = false;
          sought.push(t);
        },
      },
    }) as (clip: string, frame: number, exact: number | null, label: string) => void;

    // 1. Out-of-domain reading time (1.5 s > 1.0 s shared domain end) is refused with no seek.
    seekReading('inspect', 36, 1.5, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([]);
    expect(pauses).toBe(1);
    expect(messages).toEqual([
      {
        text: 'Explicit time 1.5 s is outside the current range of 1 s. No substitute time was used.',
        error: true,
      },
    ]);

    // 2. Negative or non-finite time is also refused without seeking.
    seekReading('inspect', 0, -0.25, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([]);
    expect(messages.at(-1)).toEqual({
      text: 'Explicit time -0.25 s is outside the current range of 1 s. No substitute time was used.',
      error: true,
    });

    // 3. In-domain reading time seeks normally and reports the reading time.
    seekReading('inspect', 12, 0.5, 'inspected · folds worst');
    await Promise.resolve();
    expect(sought).toEqual([0.5]);
    expect(messages.at(-1)).toEqual({
      text: 'Reading · inspected · folds worst → F12 · 0.5000 s',
      error: false,
    });
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('#1304: Compare populateChestBones keeps selected and disabled-seeded row bones across picked-side reloads', () => {
  const chestCode = transpiler.transformSync(
    sliceBetween(comparePickedSource, '  function chestInputIds()', '  function chestRegions()'),
  );
  const registerSlice = sliceBetween(comparePickedSource, '    registerSideModel:', '    loadInitialSideStatuses:')
    .trim()
    .replace(/,$/, '');
  const registerCode = transpiler.transformSync(`const { registerSideModel } = { ${registerSlice} };`);

  const nodes = new Map<string, MockElement>();
  const getEl = (id: string): MockElement => {
    let found = nodes.get(id);
    if (!found) {
      const tag = id.endsWith('-bone') ? 'SELECT' : id === 'lm-bones' ? 'DATALIST' : 'INPUT';
      found = new MockElement(id, tag);
      nodes.set(id, found);
    }
    return found;
  };
  const fakeDoc = {
    getElementById: (id: string) => getEl(id),
    querySelectorAll: () => [],
  };

  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevInput = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement');
  Object.defineProperty(globalThis, 'document', { value: fakeDoc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'HTMLInputElement', { value: MockElement, configurable: true, writable: true });

  try {
    let bonesCatalog: string[] | null = ['root', 'rigid', 'mesh'];
    const bust = { name: 'bust_r', shape: 'circle' as const, cx: 10, cy: 10, r: 8, bone: 'mesh', spacing: 4, band: 6 };
    const status = {
      available: true,
      handoff: null,
      baseline: null,
      inputs: { config: 'rig/config.json', parts: 'rig/out', rig: 'rig/out/rig', configHash: 'cfg-hash' },
      parts: [{ name: 'mesh', regions: [bust] }],
      contour: { mesh: { contour: { tolerance: 2, margin: 2, spacing: 8, bridges: true, regions: [bust] }, r: 6 } },
      producer: { package: '@rig-c/parts', version: '1.42.0' },
      compiler: { package: 'rig-c', version: '2.64.1' },
      reason: null,
    } as unknown as RebuildStatusView;

    const sideState: any = {
      inspectedModel: null,
      stageSource: null,
      stageModelHash: null,
      partModel: null,
      inspectedDocument: null,
      inspectedDocumentReason: null,
      rebuildStatus: status,
      appliedOnStage: null,
      chestInputs: {},
      chestMapping: { available: false, reason: 'none' },
      setupChestWorld: null,
      animationState: null,
    };

    const harness = new Function(
      'scope',
      `with (scope) { ${chestCode}\n${registerCode}\nreturn { populateChestBones, updateChestMapping, renderChest, registerSideModel }; }`,
    )({
      chestRegionRows,
      chestRowId,
      LANDMARKS: [],
      landmarkInputId: (k: string, a: string) => `lm-${k}-${a}`,
      option: (v: string, l: string) => new MockOption(v, l),
      chestField,
      chestSeed,
      evaluateChestForm,
      chestOverlayPolygons,
      posedChestMapping: (m: unknown) => m,
      chestPoseOffset: () => ({ x: 0, y: 0 }),
      cropWorldMapping,
      loadModelDocument: async () => ({ ok: true, document: { bones: [] } }),
      boneSetup: () => ({ names: [], get: () => undefined }),
      errorText: (e: unknown) => String(e),
      pickedSide: 'a',
      switchingSide: false,
      sides: { a: sideState, b: sideState },
      currentState: () => sideState,
      currentSideData: () => ({ feedbackCatalog: { bones: bonesCatalog } }),
      host: {
        players: { a: { bone: () => ({ x: 0, y: 0 }) } },
        assets: { a: { stage: { x: -40, y: 0, width: 80, height: 64 } } },
        data: () => ({ a: { feedbackCatalog: { bones: bonesCatalog } } }),
        redrawOverlays: () => {},
      },
      chestEditor: null,
      meshEditor: null,
      weightsView: { sync: () => {}, refresh: () => {} },
      bonesPanel: null,
      cutsPanel: null,
      clothPanel: null,
      idlePanel: null,
      refreshPhysics: () => {},
      refreshAnimationInspection: () => {},
      renderDropNotices: () => {},
    });

    // Seed valid chest row fields and initial bone dropdowns
    harness.populateChestBones();
    getEl('chest-generator').value = 'rig-parts';
    getEl('chest-tolerance').value = '2';
    getEl('chest-margin').value = '2';
    getEl('chest-spacing').value = '8';
    getEl('chest-0-name').value = 'bust_r';
    getEl('chest-0-bone').value = 'mesh';
    getEl('chest-0-cx').value = '12';
    getEl('chest-0-cy').value = '10';
    getEl('chest-0-ax').value = '8';
    getEl('chest-0-ay').value = '8';
    getEl('chest-0-spacing').value = '4';
    getEl('chest-0-band').value = '6';
    harness.updateChestMapping('a');
    expect(getEl('chest-0-bone').value).toBe('mesh');
    expect(getEl('chest-status').textContent).toBe('bust_r → mesh · valid for export');

    // 1. Reloading the picked side (Apply / Undo / Reset -> registerSideModel) preserves the selected bone.
    harness.registerSideModel('a', 'http://127.0.0.1/m.json', '/compare-rebuild/a/1/', 'h1', {});
    expect(getEl('chest-0-bone').value).toBe('mesh');
    expect(getEl('chest-status').textContent).toBe('bust_r → mesh · valid for export');
    expect(sideState.chestInputs['chest-0-bone']).toBe('mesh');

    // 2. A bone removed on reload clears the selection AND updates #chest-status so status never claims valid on Select bone.
    bonesCatalog = ['root', 'rigid'];
    harness.registerSideModel('a', 'http://127.0.0.1/m2.json', '/compare-rebuild/a/2/', 'h2', {});
    expect(getEl('chest-0-bone').value).toBe('');
    expect(getEl('chest-status').classList.contains('error')).toBe(true);

    // 3. Disabled row seeded before model bones arrive recovers its seeded bone once bones populate.
    bonesCatalog = null;
    harness.populateChestBones();
    expect(getEl('chest-0-bone').disabled).toBe(true);
    expect(getEl('chest-0-bone').value).toBe('');
    bonesCatalog = ['root', 'rigid', 'mesh'];
    harness.populateChestBones();
    expect(getEl('chest-0-bone').disabled).toBe(false);
    expect(getEl('chest-0-bone').value).toBe('mesh');
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else Reflect.deleteProperty(globalThis, 'document');
    if (prevInput) Object.defineProperty(globalThis, 'HTMLInputElement', prevInput);
    else Reflect.deleteProperty(globalThis, 'HTMLInputElement');
  }
});
