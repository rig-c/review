import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import type {LiveFrame, PosedFrame, SlotIdentitySnapshot} from '@rig-c/play';
import {PartInspection, type PartEntry} from '../web/part-selection.ts';
import type {JobRigPresentation} from '../web/viewport-capture.ts';
import {freezeJobRigCapture, recordJobRigDraw, type JobRigDrawState} from '../web/job-rig-capture.ts';

const source = readFileSync(new URL('../web/job-session.ts', import.meta.url), 'utf8');
function fragment(start: string, end: string) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    return source.slice(first, last);
}
const resetBody = fragment('            resetToSetup = (setup = true) => {', '            resetToSetup();');
const poseBody = fragment('    function pose(seekReference = true): void {', '    function hubBinding()')
    .replace('pose(seekReference = true): void', 'pose(seekReference = true)')
    .replace("el<HTMLInputElement>('job-time')", "el('job-time')");
const drawBody = fragment('    function drawInspection(owner: JobPreparedInspection): void {', '    function copyRigVerdict(')
    .replace('owner: JobPreparedInspection', 'owner').replace('): void {', ') {');

/** Public-player test double models the published fresh null-pose and composed seek boundary.
 * Executes the actual reset/pose/draw bodies, without a browser or raster claim.
 */
class PublicPlayer {
    generation = 0;
    current: string | null = null;
    time = 0;
    slots = null;
    skin = undefined;
    set = null;
    composed = false;
    disposed = false;
    calls: string[] = [];
    private posed = false;
    readonly renderer: {frame?: PosedFrame; render(frame: PosedFrame | LiveFrame): void} = {
        render(frame) {
            if (!('order' in frame)) throw new Error('TEST_EXPECTS_PUBLIC_SNAPSHOT');
            this.frame = structuredClone(frame);
        },
    };
    constructor(readonly root: object, readonly assets: object, readonly visible = true) {}
    clear(track: number, options: {mix: number}) {
        expect([track, options]).toEqual([0, {mix: 0}]);
        this.calls.push('clear');
        this.composed = true;
        this.posed = true;
        this.generation++;
    }
    play(animation: string) {
        this.calls.push('play');
        this.current = animation;
        this.posed = true;
        this.generation++;
    }
    seek(time: number) {
        if (this.composed) throw new Error('seek after composition');
        this.calls.push('seek');
        this.time = time;
        this.generation++;
    }
    pause() {this.calls.push('pause');}
    draw() {this.calls.push('draw'); if (this.posed) this.renderer.render(this.posedFrame());}
    posedFrame(): PosedFrame {
        return {generation: this.generation, order: this.posed && this.visible ? [{kind: 'mesh', slot: 'mesh', z: 0,
            blend: 'Normal', tint: [1, 1, 1, 1], page: 'mesh.png', pma: false, sequence: 0,
            vertices: [this.time, 0, 1, 0, 1, 1], uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2]}] : []};
    }
    slotIdentity(): SlotIdentitySnapshot {
        return {generation: this.generation, set: null, sets: [], skin: null, slots: [{slot: 'mesh', z: 0,
            attachment: this.visible ? 'mesh' : null, skin: this.visible ? 'default' : null,
            reason: this.visible ? null : 'no-attachment'}]};
    }
    dispose() {this.disposed = true;}
}

function windowPose(visible = true) {
    const root = {}, assets = {animations: [{name: 'inspect', duration: 1}]};
    const players: PublicPlayer[] = [];
    const entries: PartEntry[] = [{slot: 'mesh', bone: 'mesh', setup: 'mesh', declarations: []}];
    const clock = {value: ''};
    const camera = {center: {x: 20, y: 20}, zoom: 1};
    const binding = {publicationId: 'publication-1', instanceKey: 'instance-1', sourceHash: 'a'.repeat(64), pageId: 'page-1'};
    const scope = {
        player: null as PublicPlayer | null, inspection: null as PartInspection | null,
        runtime: {RigPlayer: class extends PublicPlayer {
            constructor(root: object, assets: object) {super(root, assets, visible); players.push(this);}
        }}, rigRoot: root, loadedAssets: assets, parts: {PartInspection}, catalog: {entries},
        clearRigPresentation: () => {}, resetToSetup: (_setup = true) => {}, animation: '', time: 0, selectedPart: '', partMode: 'context',
        drawn: new WeakMap(), notice: {textContent: ''}, t: (key: string) => key,
        el: () => clock, setText: () => {}, viewport: {fitCamera() {}},
    };
    const reset: (setup?: boolean) => void = new Function('scope', `with(scope){${resetBody};return resetToSetup;}`)(scope);
    const current = {assets, source: binding,
        get player() {return scope.player;}, get inspection() {return scope.inspection;}, setupPose: reset};
    const context = {...scope, current,
        drawInspection: new Function('scope', `with(scope){${drawBody};return drawInspection;}`)(scope)};
    const pose: () => void = new Function('scope', `with(scope){${poseBody};return ()=>pose(false);}`)(context);
    reset();
    function at(animation: string, time: number) {context.animation = animation; context.time = time; pose();}
    function state(): JobRigDrawState {
        const presentation: JobRigPresentation = {canvas: {} as HTMLCanvasElement, width: 1, height: 1, ratio: 1,
            area: {x: 0, y: 0, width: 1, height: 1}};
        return {player: current.player!, presentation, frameGeneration: current.inspection!.frame('single')!.generation,
            source: binding, layout: JSON.stringify(camera), defaultCamera: true, wholeRig: true, playing: false};
    }
    return {current, scope, context, players, root, assets, camera, binding, at, state, reset};
}

test('#557 setup initializes a fresh null-pose public player before draw/present', () => {
    const raw = new PublicPlayer({}, {});
    raw.draw();
    expect(raw.posedFrame().order).toEqual([]);
    expect(raw.renderer.frame).toBeUndefined();
    const h = windowPose();
    expect(h.current.player!.calls).toEqual(['clear', 'draw']);
    expect(h.current.player!.renderer.frame!.order).toHaveLength(1);
    expect(h.current.inspection!.frame('single')).toEqual(h.current.player!.posedFrame());
    expect(h.current.inspection!.frame('single')!.generation).toBe(h.current.player!.generation);
});

test('#557 setup to inspect zero and .375 to setup replaces composed players and preserves source/selection/camera', () => {
    const h = windowPose(), first = h.current.player!;
    h.context.selectedPart = 'mesh';
    h.context.partMode = 'solo';
    h.at('inspect', 0);
    const animated = h.current.player!;
    expect(first.disposed).toBe(true);
    expect(animated).not.toBe(first);
    expect(animated.composed).toBe(false);
    expect(animated.calls).toEqual(['play', 'seek', 'pause', 'draw']);
    expect(h.current.inspection!.value()).toMatchObject({slot: 'mesh', mode: 'solo'});
    h.at('inspect', 0.375);
    expect(h.current.player).toBe(animated);
    expect(animated.time).toBe(0.375);
    h.at('', 0);
    expect(animated.disposed).toBe(true);
    expect(h.current.player!.current).toBeNull();
    expect(h.current.player!.composed).toBe(true);
    expect(h.current.inspection!.value()).toMatchObject({slot: 'mesh', mode: 'solo'});
    expect(h.current.inspection!.frame('single')!.generation).toBe(h.current.player!.generation);
    expect(h.players).toHaveLength(3);
    expect(h.players.every(player => player.root === h.root && player.assets === h.assets)).toBe(true);
    expect(h.current.source).toBe(h.binding);
    expect(h.camera).toEqual({center: {x: 20, y: 20}, zoom: 1});
});

test('#557 setup and seek captures bind the coherent displayed public draw through both transitions', async () => {
    const h = windowPose();
    let drawGeneration = 0;
    for (const [animation, time] of [['', 0], ['inspect', 0], ['inspect', 0.375], ['', 0]] as const) {
        h.at(animation, time);
        const state = h.state(), displayed = h.current.player!.renderer.frame!;
        expect(displayed.order).toHaveLength(1);
        expect(displayed.generation).toBe(state.frameGeneration);
        expect(h.current.inspection!.frame('single')).toEqual(displayed);
        const capture = await freezeJobRigCapture(recordJobRigDraw(state, ++drawGeneration), state, 'ask-1',
            () => ({width: 1, height: 1, encode: async () => 'data:image/png;base64,ZmFrZQ=='})).encode();
        expect(capture.frame).toBe(animation ? time : 'setup');
        if (animation) expect(capture.animation).toBe(animation);
        else expect(capture).not.toHaveProperty('animation');
        expect(capture.binding).toEqual({...h.binding, askId: 'ask-1', drawGeneration,
            playerGeneration: h.current.player!.generation});
    }
});

test('#557 setup initialization retains valid models with no visible attachment', () => {
    const h = windowPose(false);
    expect(h.current.player!.renderer.frame!.order).toEqual([]);
    expect(h.current.inspection!.frame('single')!.order).toEqual([]);
    expect(h.current.inspection!.refusal('single')).toBeNull();
    expect(h.current.inspection!.frame('single')!.generation).toBe(h.current.player!.generation);
});


test('#557 canonical selection return commits the final public frame and render failure clears capture', () => {
    const h = windowPose();
    const pane = {dataset: {} as Record<string, string>, append() {}};
    let fail = false;
    let compositions = 0;
    let presentation: JobRigPresentation | undefined;
    const owner = {player: h.current.player, assets: h.assets, rigRoot: h.root, inspection: h.current.inspection,
        get rigPresentation() {return presentation;}, set rigPresentation(value) {presentation = value;}};
    const context = {
        current: owner, selectedPart: '', partMode: 'context', hubVisible: true, drawGeneration: 0,
        drawn: new WeakMap(), CanvasRenderer: class {}, el: () => pane, setText() {},
        viewport: {numericView: () => ({cameras: {rig: {}}}), renderCameraControls() {}},
        presentJobRigViewport(_capture: unknown, pose: {posed: PosedFrame}) {
            compositions++;
            if (fail) throw new Error('declared presentation failure');
            const expectedFrame = owner.inspection!.frame('single');
            expect(expectedFrame).toBeDefined();
            expect(pose.posed).toEqual(expectedFrame!);
            return {canvas: {} as HTMLCanvasElement, width: 1, height: 1, ratio: 1,
                area: {x: 0, y: 0, width: 1, height: 1}};
        },
        rigDrawState(): JobRigDrawState {
            return {...h.state(), presentation, wholeRig: !context.selectedPart};
        }, recordJobRigDraw,
    };
    const remember = fragment('    function rememberDraw(): void {', '    function drawInspection(')
        .replace('rememberDraw(): void', 'rememberDraw()');
    const select = fragment('    function selectPart(): void {', '    function showReference()')
        .replace('selectPart(): void', 'selectPart()');
    const selectPart: () => void = new Function('scope', `with(scope){${remember};${select};return selectPart;}`)(context);
    for (const mode of ['context', 'solo']) {
        context.selectedPart = 'mesh';
        context.partMode = mode;
        selectPart();
        const selected = presentation;
        expect(selected).toBeDefined();
        expect(owner.inspection!.value()).toMatchObject({slot: 'mesh', mode});
        context.selectedPart = '';
        selectPart();
        expect(presentation).toBeDefined();
        expect(presentation).not.toBe(selected);
        expect(owner.inspection!.value()).toBeNull();
        expect(context.drawn.get(owner).presentation).toBe(presentation);
    }
    expect(compositions).toBe(4);
    fail = true;
    selectPart();
    expect(presentation).toBeUndefined();
    expect(context.drawn.has(owner)).toBe(false);
});

test('#557 setup reset clears its owned presentation before replacing the public player', () => {
    const h = windowPose();
    const previous = h.current.player!;
    let clears = 0;
    h.scope.clearRigPresentation = () => {
        clears++;
        expect(previous.disposed).toBe(false);
    };
    h.reset();
    expect(clears).toBe(1);
    expect(previous.disposed).toBe(true);
});
