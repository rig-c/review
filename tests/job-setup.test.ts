import {expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import type {LiveFrame, PosedFrame, SlotIdentitySnapshot, TrackEntry} from '@rig-c/play';
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
/** Public-player test double models the published fresh null-pose and composed seek boundary.
 * Executes the actual retained reset body, without a browser or raster claim.
 */
class PublicPlayer {
    generation = 0;
    current: string | null = null;
    time = 0;
    loop = false;
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
    constructor(readonly root: object, readonly assets: {animations?: readonly {name: string; duration: number}[]}, readonly visible = true) {}
    clear(track: number, options: {mix: number}) {
        expect([track, options]).toEqual([0, {mix: 0}]);
        this.calls.push('clear');
        this.current = null;
        this.time = 0;
        this.loop = false;
        this.composed = true;
        this.posed = true;
        this.generation++;
    }
    play(animation: string, options?: {loop?: boolean}) {
        this.calls.push('play');
        this.current = animation;
        this.loop = options?.loop ?? false;
        this.time = 0;
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
    entry(track = 0): TrackEntry | null {
        if (track !== 0 || !this.posed) return null;
        if (this.current === null) {
            return {animation: null, loop: false, trackTime: 0, animationTime: 0, duration: 0, alpha: 1, additive: false};
        }
        const duration = this.assets.animations?.find(item => item.name === this.current)?.duration ?? 1;
        const animationTime = duration > 0
            ? (this.loop ? Number((this.time % duration).toFixed(9)) : Math.min(this.time, duration))
            : 0;
        return {animation: this.current, loop: this.loop, trackTime: this.time, animationTime, duration, alpha: 1, additive: false};
    }
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
    const root = {style: {left: '0px', top: '0px', visibility: ''}}, assets = {animations: [{name: 'inspect', duration: 1}]};
    const players: PublicPlayer[] = [];
    const entries: PartEntry[] = [{slot: 'mesh', bone: 'mesh', setup: 'mesh', declarations: []}];
    const clock = {value: ''};
    const camera = {center: {x: 20, y: 20}, zoom: 1};
    const binding = {publicationId: 'publication-1', instanceKey: 'instance-1', sourceHash: 'a'.repeat(64), pageId: 'page-1'};
    const scope = {
        player: null as PublicPlayer | null, inspection: null as PartInspection | null,
        runtime: {RigPlayer: class extends PublicPlayer {
            constructor(root: object, assets: {animations?: readonly {name: string; duration: number}[]}) {super(root, assets, visible); players.push(this);}
        }}, rigRoot: root, loadedAssets: assets, parts: {PartInspection}, catalog: {entries},
        clearRigPresentation: () => {}, resetToSetup: (_setup = true) => {}, animation: '', time: 0, loop: true,
        syncTransportControls: () => {},
        drawn: new WeakMap(), notice: {textContent: ''}, t: (key: string) => key,
        el: () => clock, setText: () => {}, viewport: {fitCamera() {}},
    };
    const reset: (setup?: boolean) => void = new Function('scope', `with(scope){${resetBody};return resetToSetup;}`)(scope);
    const current = {assets, source: binding, rigRoot: root, metadata: {feedbackCatalog: {bones: []}},
        get player() {return scope.player;}, get inspection() {return scope.inspection;}, setupPose: reset};
    reset();
    function state(): JobRigDrawState {
        const presentation: JobRigPresentation = {canvas: {} as HTMLCanvasElement, width: 1, height: 1, ratio: 1,
            area: {x: 0, y: 0, width: 1, height: 1}};
        return {player: current.player!, presentation, frameGeneration: current.inspection!.frame('single')!.generation,
            source: binding, layout: JSON.stringify(camera), defaultCamera: true, wholeRig: true, playing: false};
    }
    return {current, scope, players, root, assets, camera, binding, clock, state, reset};
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

test('#557 setup initialization retains valid models with no visible attachment', () => {
    const h = windowPose(false);
    expect(h.current.player!.renderer.frame!.order).toEqual([]);
    expect(h.current.inspection!.frame('single')!.order).toEqual([]);
    expect(h.current.inspection!.refusal('single')).toBeNull();
    expect(h.current.inspection!.frame('single')!.generation).toBe(h.current.player!.generation);
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
