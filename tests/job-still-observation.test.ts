import {expect, test} from 'bun:test';
import {restoreStillOracle} from './helpers/job-still-observation.ts';
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
