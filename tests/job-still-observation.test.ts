import {expect, test} from 'bun:test';
import {admitStillOracle, armStillObservation, restoreStillOracle} from './helpers/job-still-observation.ts';
import type {InputCdpSession} from './parts-explorer-browser.ts';

/** Executes the actual restoration evaluation over isolated DOM/CSSOM test doubles. */
function restoration(stubborn = false) {
    let attribute: string | null = 'visibility: hidden !important;';
    let cssText = attribute;
    const node = {
        isConnected: true,
        style: {get cssText() {return cssText;}, set cssText(value: string) {cssText = value; attribute = value;}},
        getAttribute() {return attribute;},
        setAttribute(_name: string, value: string) {attribute = value; cssText = value;},
        removeAttribute() {
            attribute = stubborn ? '' : null;
            cssText = '';
        },
    };
    const original = () => {};
    const snapshot = {tag: 'DIV', id: 'rig-empty', hidden: true,
        rect: {x: 0, y: 0, width: 0, height: 0}, expectedAttribute: null, expectedCssText: ''};
    const saved = new Map([[node, snapshot]]);
    const state = {original, saved, restoreResult: undefined as unknown};
    const sandbox: {__jobStillObservation?: typeof state} = {__jobStillObservation: state};
    const canvas = {prototype: {toBlob: () => {}}};
    const page: InputCdpSession = {
        async evaluate<Value>(expression: string): Promise<Value> {
            return new Function('globalThis', 'HTMLCanvasElement', 'return ' + expression)(sandbox, canvas);
        },
        async setViewport() {}, async goto() {}, async close() {}, async mouse() {}, async touch() {},
        async screenshot() {throw new Error('Unexpected raster operation in restoration unit test');},
    };
    return {page, node, sandbox, state, canvas, original};
}

test('#557 observation restoration retains hidden zero-size node audit and restores exact absent style attribute', async () => {
    const h = restoration();
    const result = await restoreStillOracle(h.page);
    expect(result.restored).toBe(true);
    expect(result.details).toEqual([expect.objectContaining({id: 'rig-empty', hidden: true,
        expectedAttribute: null, actualAttribute: null, expectedCssText: '', actualCssText: '',
        attributeExact: true, cssTextExact: true, rect: {x: 0, y: 0, width: 0, height: 0}})]);
    expect(h.sandbox.__jobStillObservation).toBeUndefined();
    expect(h.state.restoreResult).toEqual(result);
    expect(h.canvas.prototype.toBlob).toBe(h.original);
});

test('#557 observation restoration preserves exact null versus empty mismatch and retains failed state/details', async () => {
    const h = restoration(true);
    const result = await restoreStillOracle(h.page);
    expect(result.restored).toBe(false);
    expect(result.details).toEqual([expect.objectContaining({id: 'rig-empty', expectedAttribute: null,
        actualAttribute: '', attributeExact: false, cssTextExact: true})]);
    expect(h.sandbox.__jobStillObservation).toBe(h.state);
    expect(h.state.restoreResult).toEqual(result);
    expect(h.node.getAttribute()).toBe('');
});

test('#559 observation toBlob wrapper records synchronous canonical/copy snapshot before delegating through replaceable state.original', async () => {
    const rect = {x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200,
        toJSON() {return {x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200};}};
    function makeNode(id: string, tagName = 'DIV') {
        let styleAttr: string | null = null;
        let cssText = '';
        const props = new Map<string, string>();
        return {
            id, tagName, hidden: false, isConnected: true, parentElement: null as unknown,
            clientLeft: 0, clientTop: 0, clientWidth: 200, clientHeight: 200, width: 200, height: 200,
            style: {
                get cssText() {return cssText;},
                set cssText(v: string) {cssText = v; styleAttr = v;},
                setProperty(k: string, v: string, p?: string) {
                    props.set(k, v);
                    cssText = [...props.entries()].map(([name, val]) => `${name}: ${val}${p ? ' !' + p : ''};`).join(' ');
                    styleAttr = cssText;
                },
            },
            getAttribute(name: string) {return name === 'style' ? styleAttr : null;},
            setAttribute(name: string, value: string) {if (name === 'style') {styleAttr = value; cssText = value;}},
            removeAttribute(name: string) {if (name === 'style') {styleAttr = null; cssText = ''; props.clear();}},
            getBoundingClientRect() {return rect;},
            getClientRects() {return [rect];},
            contains(other: unknown) {return other === this;},
            hasAttribute(name: string) {return name === 'data-job-rig-presentation' && id === 'canonical';},
            matches(sel: string) {return id === 'rig-label' && sel.includes('.pane-label');},
            closest(sel: string) {return sel === '.stage-pane' ? stage : null;},
            querySelector(sel: string) {return sel === '[data-job-rig-presentation]' ? canonical : null;},
            querySelectorAll(sel: string) {
                if (sel === 'canvas') return [nativeCanvas];
                if (sel.includes('.pane-label')) return [label];
                return [];
            },
            toDataURL() {return `data:image/png;base64,${id}`;},
            props,
        };
    }
    const stage = makeNode('rig-pane', 'SECTION');
    const pane = makeNode('rig-viewport', 'DIV');
    const root = makeNode('rig-root', 'DIV');
    const label = makeNode('rig-label', 'SPAN');
    const canonical = makeNode('canonical', 'CANVAS');
    const nativeCanvas = makeNode('native-0', 'CANVAS');
    let canonicalFrame = 'data:image/png;base64,CANONICAL_T0';
    canonical.toDataURL = () => canonicalFrame;
    pane.parentElement = stage;
    pane.contains = (other: unknown) => other === pane || other === root || other === canonical;
    root.contains = (other: unknown) => other === root || other === nativeCanvas;
    const allNodes = [stage, pane, root, label, canonical, nativeCanvas];
    const doc = {
        getElementById(id: string) {
            if (id === 'rig-viewport') return pane;
            if (id === 'rig-root') return root;
            if (id === 'job-animation') return {value: 'inspect'};
            if (id === 'job-time') return {value: '0.25'};
            return null;
        },
        querySelectorAll() {return allNodes;},
    };
    const getComputedStyle = (node: ReturnType<typeof makeNode>) => {
        const visibility = node.props.get('visibility') ?? 'visible';
        const borderRadius = node.props.get('border-radius') ?? '8px';
        return Object.assign(['background-color'], {
            position: 'static', display: 'block', visibility, opacity: '1', zIndex: 'auto',
            filter: 'none', transform: 'none', transformOrigin: '0px 0px',
            overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden',
            borderRadius, borderTopLeftRadius: borderRadius, borderTopRightRadius: borderRadius,
            borderBottomLeftRadius: borderRadius, borderBottomRightRadius: borderRadius,
            borderColor: 'rgb(0, 0, 0)',
            getPropertyValue(name: string) {return name === 'background-color' ? 'rgb(17, 17, 17)' : '0px';},
        });
    };
    class FakeDOMMatrix {
        is2D = true; a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    }
    let nativeCalls = 0;
    let nativeThis: unknown = null;
    let nativeArgs: unknown[] = [];
    const nativeToBlob = function (this: unknown, ...args: unknown[]) {
        nativeCalls++;
        nativeThis = this;
        nativeArgs = args;
    };
    const canvas = {prototype: {toBlob: nativeToBlob}};
    const sandbox: {__jobStillObservation?: {
        original: (...args: unknown[]) => unknown;
        capture: {askId: string; canonicalPng: string; copiedPng: string} | null;
    }} = {};
    const page: InputCdpSession = {
        async evaluate<Value>(expression: string): Promise<Value> {
            return new Function(
                'globalThis', 'HTMLCanvasElement', 'document', 'getComputedStyle', 'DOMMatrix', 'performance', 'devicePixelRatio',
                'return ' + expression,
            )(sandbox, canvas, doc, getComputedStyle, FakeDOMMatrix, {now: () => 42}, 1);
        },
        async setViewport() {}, async goto() {}, async close() {}, async mouse() {}, async touch() {},
        async screenshot() {throw new Error('Unexpected raster operation in unit test');},
    };

    await admitStillOracle(page);
    await armStillObservation(page, 'ask-559');

    const obs = sandbox.__jobStillObservation!;
    const realOriginal = obs.original;
    let held = false;
    let captureDuringHold: {askId: string; canonicalPng: string; copiedPng: string} | null = null;
    let releaseEncoding = (): unknown => undefined;
    obs.original = function (this: unknown, ...args: unknown[]) {
        held = true;
        captureDuringHold = obs.capture ? {...obs.capture} : null;
        releaseEncoding = () => {
            obs.original = realOriginal;
            return realOriginal.apply(this, args);
        };
    };

    const copiedCanvas = {toDataURL: () => 'data:image/png;base64,COPIED_T0'};
    const blobCallback = () => {};
    canvas.prototype.toBlob.call(copiedCanvas, blobCallback, 'image/png');

    expect(held).toBe(true);
    expect(nativeCalls).toBe(0);
    expect(captureDuringHold).toEqual(expect.objectContaining({
        askId: 'ask-559',
        canonicalPng: 'data:image/png;base64,CANONICAL_T0',
        copiedPng: 'data:image/png;base64,COPIED_T0',
    }));

    // Advancing the live canonical canvas while encoding is held must not mutate the synchronous observation snapshot.
    canonicalFrame = 'data:image/png;base64,CANONICAL_T2';
    expect(obs.capture?.canonicalPng).toBe('data:image/png;base64,CANONICAL_T0');
    expect(obs.capture?.copiedPng).toBe('data:image/png;base64,COPIED_T0');

    releaseEncoding();
    expect(nativeCalls).toBe(1);
    expect(nativeThis).toBe(copiedCanvas);
    expect(nativeArgs).toEqual([blobCallback, 'image/png']);

    const restored = await restoreStillOracle(page);
    expect(restored.restored).toBe(true);
    expect(canvas.prototype.toBlob).toBe(nativeToBlob);
});
