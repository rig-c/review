import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {restoreStillOracle} from './helpers/job-still-observation.ts';
import {loadSetupAssets, setupRoot} from './helpers/setup-mesh.ts';
import {captureRigRestStill, rigRestCanvas} from '../web/job-rig-capture.ts';

test('#557 oracle restores null and empty attributes with one operation before audit reads', async () => {
  const savedGlobal = Object.getOwnPropertyDescriptor(globalThis, '__jobStillObservation');
  const savedCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement');
  let cssWrites = 0;
  const events: string[] = [];
  const saved = new Map();
  for (const expectedAttribute of [null, '', 'visibility: visible;']) {
    let attribute: string | null = 'visibility: hidden;';
    const style = {get cssText() {events.push('css-read'); return attribute ?? '';},
      set cssText(_value: string) {cssWrites++; attribute = '';}};
    const node = {isConnected: true, style,
      getAttribute() {events.push('attribute-read'); return attribute;},
      removeAttribute() {events.push('restore'); attribute = null;},
      setAttribute(_name: string, value: string) {events.push('restore'); attribute = value;}};
    saved.set(node, {expectedAttribute, expectedCssText: expectedAttribute ?? ''});
  }
  const original = () => {};
  Object.defineProperty(globalThis, 'HTMLCanvasElement', {configurable: true, value: {prototype: {toBlob: () => {}}}});
  Object.defineProperty(globalThis, '__jobStillObservation', {configurable: true, writable: true, value: {saved, original}});
  try {
    const page = {evaluate: async (script: string) => new Function('return ' + script)()};
    const result = await restoreStillOracle(page as Parameters<typeof restoreStillOracle>[0]);
    expect(result.restored).toBe(true);
    expect(cssWrites).toBe(0);
    expect(events.slice(0, 3)).toEqual(['restore', 'restore', 'restore']);
    expect(events.slice(3, 6)).toEqual(['attribute-read', 'css-read', 'attribute-read']);
  } finally {
    for (const [key, descriptor] of [['__jobStillObservation', savedGlobal], ['HTMLCanvasElement', savedCanvas]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('#739 standalone rest canvas uses the declared native stage and refuses inferred or rescaled geometry', () => {
  const stage = {x: -960, y: 0, width: 1920, height: 1080};
  expect(rigRestCanvas({stage}, {width: 1920, height: 1080})).toEqual({x: -960, y: 0, width: 1920, height: 1080});
  expect(rigRestCanvas({stage: {...stage, x: 12, y: -7}}, {width: 1920, height: 1080})).toEqual({x: 12, y: -7, width: 1920, height: 1080});
  expect(() => rigRestCanvas({stage}, {width: 960, height: 540})).toThrow('PARTS_PAINTING_SIZE');
  expect(() => rigRestCanvas({stage: null}, {width: 1920, height: 1080})).toThrow('PARTS_PAINTING_MAPPING');
  expect(() => rigRestCanvas({stage: {...stage, x: .5}}, {width: 1920, height: 1080})).toThrow('PARTS_PAINTING_MAPPING');
  expect(() => rigRestCanvas({stage: {...stage, width: 16385}}, {width: 16385, height: 1080})).toThrow('PARTS_PAINTING_MAPPING');
});

test('#1233 standalone Setup Difference keeps an independent native bitmap after player disposal', async () => {
  const model = JSON.parse(readFileSync(new URL('./fixtures/strip-probe/build/skeleton.model.json', import.meta.url), 'utf8'));
  const loaded = await loadSetupAssets(model);
  try {
    const doc = globalThis.document, create = doc.createElement.bind(doc);
    doc.createElement = ((tag: string) => tag === 'div' ? setupRoot() : create(tag)) as typeof doc.createElement;
    const {width, height} = model.stage;
    const first = captureRigRestStill(loaded.assets, {width, height});
    const second = captureRigRestStill(loaded.assets, {width, height});
    expect([first.width, first.height]).toEqual([width, height]);
    const pixels = second.getContext('2d')!.getImageData(0, 0, width, height).data;
    expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    expect(first.getContext('2d')!.getImageData(0, 0, width, height).data).toEqual(pixels);
    first.getContext('2d')!.clearRect(0, 0, width, height);
    expect(second.getContext('2d')!.getImageData(0, 0, width, height).data).toEqual(pixels);
  } finally {loaded.dispose();}
});

// #774: the shared screen owns player disposal when the host replaces it.
test('#774 disposing the replaced shared screen releases its player and assets exactly once',()=>{
 const main=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
 const body=main.slice(main.indexOf('function disposeScreen()'),main.indexOf("window.addEventListener('pagehide',disposeScreen"));
 const calls:string[]=[];
 const scope={checkpointPair:null,releaseInterview:null,disposed:false,suspendScreen:()=>calls.push('suspend'),lifecycle:{abort:()=>calls.push('abort')},comments:null,partsSubject:null,turnPad:null,inspectorBlocks:null,inspectorTabs:null,workspace:null,controlDispose:null,appearance:null,rigInspector:{actBar:{dispose(){}}},shell:{dispose(){}},viewDisposers:[],overlays:null,player:{dispose:()=>calls.push('player')},assets:{dispose:()=>calls.push('assets')}};
 const dispose=new Function('scope',`with(scope){${new Bun.Transpiler({loader:'ts'}).transformSync(body)};return disposeScreen;}`)(scope);
 dispose();dispose();expect(calls).toEqual(['suspend','abort','player','assets']);expect(scope.disposed).toBe(true);
});
