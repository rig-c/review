import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { loadModel, RigPlayer, type ModelAssets } from '@rig-c/play';
import { commonDomain, compareSeekStep, feedbackTrace, inspectionFrame, seekAfterReference, seekSynchronizedPair, type CompareTrace, type ReferenceSample } from '../src/compare-playhead.ts';
import { ComparePresentation } from '../src/compare-presentation.ts';
import { ReferenceSelectionUnavailable, inspectionReferenceFrame, referenceFrameAtTime, referenceSeekPosition } from '../src/reference-frames.ts';
import { requireCommonTime } from '../src/compare-playhead.ts';
import { RendererBadge } from '../web/renderer-status.ts';

async function fixture(): Promise<ModelAssets> {
  const bytes = await readFile(new URL('./fixtures/compare-probe/skeleton.model.json', import.meta.url), 'utf8');
  // Keep fetch's actual public type/properties; only this fixture's file IO is
  // substituted. The published loader/parser and player/poser run unchanged.
  const fileFetch = new Proxy(fetch, { apply: () => Promise.resolve(new Response(bytes)) });
  return loadModel({ modelUrl: 'http://fixture.invalid/probe.model.json', fetch: fileFetch, setsUrl: null });
}

function player(assets: ModelAssets): RigPlayer {
  // Bone-only fixture has no slots/pages. This is a layout boundary, not a
  // player, bone, time, seek, renderer or core-method mock.
  const root = { style: { clipPath: '' } } as unknown as HTMLElement;
  const value = new RigPlayer(root, assets, { seekStep: compareSeekStep, meshBackend: 'canvas2d' });
  value.environment(null); value.play('inspect', { loop: false }); value.pause(); return value;
}

describe('reference-locked compare playhead', () => {
  test('feedback requires a current successful pair and becomes ineligible after a seek or failure', () => {
    const success: CompareTrace = { reference: .25, a: .25, b: .25, source: 'video-frame' };
    expect(feedbackTrace(false, false, null)).toBeNull();
    expect(feedbackTrace(true, false, success)).toBe(success);
    expect(feedbackTrace(true, true, success)).toBeNull();
    // A failed pair clears its trace and readiness; the previous success cannot
    // supply feedback context even if retained in the diagnostic history.
    expect(feedbackTrace(false, false, null)).toBeNull();
    expect(feedbackTrace(false, false, success)).toBeNull();
    expect(feedbackTrace(true, false, null)).toBeNull();
  });

  test('frame badges interpret the validated reference timestamp, preserving actual runtime ULP separately', () => {
    const mediaTime = 100 / 24;
    const success: CompareTrace = { reference: mediaTime, a: mediaTime - 1e-14, b: mediaTime - 1e-14, source: 'video-frame' };
    expect(inspectionFrame({ kind: 'uniform', fps: 24, frame0: 0, frameCount: 101 }, success)).toBe(100);
    expect(inspectionFrame({ kind: 'samples', frameTimes: [0, mediaTime] }, success)).toBe(1);
    expect(success.a).toBeLessThan(success.reference);
    expect(inspectionFrame(null, success)).toBeNull();
    expect(inspectionFrame({ kind: 'uniform', fps: 24, frame0: 0, frameCount: 101 }, null)).toBeNull();
  });

  test('shared domain is the intersection and never accepts an individual overrun', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    try {
      const domain = commonDomain(2.4, 2, 1.5); expect(domain).toEqual({ start: 0, end: 1.5 });
      expect(() => commonDomain(Infinity, 2, 2)).toThrow('finite');
      expect(() => commonDomain(2, -1, 2)).toThrow('finite');
      expect(() => seekSynchronizedPair({ time: 1.501, source: 'video-frame' }, a, b, domain)).toThrow('outside shared domain');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
      expect(() => seekSynchronizedPair({ time: -.001, source: 'current-time' }, a, b, domain)).toThrow('outside shared domain');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });

  test('actual public RigPlayers seek equal media times with fresh-control bone poses, including backward/repeated/end samples', async () => {
    const assetsA = await fixture(), assetsB = await fixture(), a = player(assetsA), b = player(assetsB);
    const traces: { reference: number; a: number; b: number; source: string }[] = [];
    try {
      const durationA = assetsA.animations.find(value => value.name === 'inspect')!.duration;
      const durationB = assetsB.animations.find(value => value.name === 'inspect')!.duration;
      const domain = commonDomain(2.4, durationA, durationB);
      const poses = new Map<number, ReturnType<RigPlayer['bone']>>();
      for (const time of [0, .037, 1.001, .25, 1.001, 0, domain.end]) {
        const trace = seekSynchronizedPair({ time, source: 'video-frame' }, a, b, domain); traces.push(trace);
        expect(trace.reference).toBe(time); expect(trace.a).toBeCloseTo(time, 12); expect(trace.b).toBe(trace.a);
        const control = player(assetsA);
        try {
          control.seek(time); control.draw();
          expect(a.bone('probe')).toEqual(control.bone('probe'));
          expect(b.bone('probe')).toEqual(control.bone('probe'));
          expect(a.posedFrame().order).toHaveLength(0);
          const previous = poses.get(time);
          if (previous !== undefined) expect(a.bone('probe')).toEqual(previous);
          poses.set(time, { ...a.bone('probe') });
        } finally { control.dispose(); }
      }
      expect(poses.get(0)).not.toEqual(poses.get(1.001));
      console.log('compare public-runtime traces (reference / a / b):', JSON.stringify(traces));
    } finally { a.dispose(); b.dispose(); assetsA.dispose(); assetsB.dispose(); }
  });

  test('both real players wait for reference seek completion and use decoded mediaTime, not requested time', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    let finish!: (sample: ReferenceSample) => void;
    try {
      const reference = new Promise<ReferenceSample>(resolve => { finish = resolve; });
      const pending = seekAfterReference(.05, () => reference, a, b, commonDomain(2.4, 2, 2));
      await Promise.resolve(); expect(a.time).toBe(0); expect(b.time).toBe(0);
      finish({ time: .037, source: 'video-frame' });
      const trace = await pending; expect(trace.reference).toBe(.037); expect(trace.a).toBeCloseTo(.037, 12); expect(trace.b).toBe(trace.a); expect(trace.source).toBe('video-frame');
      console.log('compare after-seeked decoded-time trace:', JSON.stringify(trace));
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });

  test('reference rejection and a real player seek refusal produce no successful pair', async () => {
    const assets = await fixture(), a = player(assets), b = player(assets);
    try {
      await expect(seekAfterReference(.2, () => Promise.reject(new Error('video seek failed')), a, b, commonDomain(2, 2, 2))).rejects.toThrow('video seek failed');
      expect(a.time).toBe(0); expect(b.time).toBe(0);
      b.play('inspect', { track: 1, loop: false });
      expect(b.composed).toBe(true);
      expect(() => seekSynchronizedPair({ time: .2, source: 'video-frame' }, a, b, commonDomain(2, 2, 2))).toThrow('seek');
    } finally { a.dispose(); b.dispose(); assets.dispose(); }
  });
});

test('actual compare seek adapter refuses mismatched decoded frame without disabling transport, then recovers on a supported seconds seek', async()=>{
  // Exercise the app's actual callback, catch, cleanup and transport-failure
  // bodies without starting a browser or replacing the public rig poser.
  const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
  const between=(from:string,to:string)=>{const start=source.indexOf(from),end=source.indexOf(to,start);if(start<0||end<start)throw new Error('compare adapter test boundary missing');return source.slice(start,end);};
  const stateFunctions=between('function updateFeedbackAvailability()', 'function renderPresentation(');
  const seekFunctions=between('function seekReferenceFrame(', 'function unionBounds(');
  // seekTo now routes through the actual held-frame draw adapter. Keep that
  // source body in this extraction too; these bone-only players have no part
  // catalog, while the separate part suite measures its registered draw path.
  const playerAdapter=between('function inspectionPlayer(', 'const layers=');
  class VideoAdapter extends EventTarget {
    paused=true;seeking=false;actual=.5;private position=0;private serial=0;private callbacks=new Map<number,VideoFrameRequestCallback>();
    pause(){this.paused=true;}
    get currentTime(){return this.position;}
    set currentTime(value:number){this.position=value;this.seeking=true;queueMicrotask(()=>{this.seeking=false;this.dispatchEvent(new Event('seeked'));for(const [id,callback] of this.callbacks){this.callbacks.delete(id);callback(0,{mediaTime:this.actual} as VideoFrameCallbackMetadata);}});}
    requestVideoFrameCallback(callback:VideoFrameRequestCallback){const id=++this.serial;this.callbacks.set(id,callback);return id;}
    cancelVideoFrameCallback(id:number){this.callbacks.delete(id);}
    get pendingCallbacks(){return this.callbacks.size;}
  }
  const assets=await fixture(),a=player(assets),b=player(assets);
  const open=(legacyGenericError=false)=>{
    const video=new VideoAdapter(),controls=new Map<string,{disabled:boolean;textContent:string;setAttribute():void}>();
    const control=(id:string)=>{let value=controls.get(id);if(!value){value={disabled:false,textContent:'',setAttribute(){}};controls.set(id,value);}return value;};
    const callbacks=legacyGenericError?seekFunctions.replace("new ReferenceSelectionUnavailable('REFERENCE_FRAME_MISMATCH:","new Error('REFERENCE_FRAME_MISMATCH:"):seekFunctions;
    if(legacyGenericError&&callbacks===seekFunctions)throw new Error('legacy mismatch mutant was not applied');
    const script=`function openAdapter(deps){const {video,players,referenceFrames,presentation,rendererBadges,overlays,ReferenceSelectionUnavailable,inspectionReferenceFrame,referenceFrameAtTime,referenceSeekPosition,requireCommonTime,feedbackTrace,button,input}=deps;let ready=true,seeking=false,trace=null,seekAbort=null,latestSeek=0,lastPresented=null,requestedProducer=null,endStopReason=null,idleHeld=true,loopRestarting=false;const parts=null;${playerAdapter}\nconst domain={start:0,end:2},traceRows=[];const text=()=>{},message=()=>{},describe=error=>error instanceof Error?error.message:String(error),frameControls=()=>{},renderTrace=value=>{trace=value;},renderPresentation=()=>{};${stateFunctions}\n${callbacks}\nreturn {seekTo,state:()=>({ready,seeking,trace})};}`;
    const compiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
    const adapter=new Function('deps',compiled+'\nreturn openAdapter(deps);')({video,players:{a,b},referenceFrames:{frames:[0,.5,1].map((time,index)=>({index,time})),duration:1.5},presentation:new ComparePresentation(),rendererBadges:{a:new RendererBadge(),b:new RendererBadge()},overlays:{},ReferenceSelectionUnavailable,inspectionReferenceFrame,referenceFrameAtTime,referenceSeekPosition,requireCommonTime,feedbackTrace,button:control,input:control}) as {seekTo(time:number):Promise<void>;state():{ready:boolean;seeking:boolean;trace:CompareTrace|null}};
    return {video,control,...adapter};
  };
  try{
    const app=open();app.video.actual=1;
    await app.seekTo(.5);
    expect(app.state()).toEqual({ready:true,seeking:false,trace:null});expect(app.control('play').disabled).toBe(false);expect(app.control('seek').disabled).toBe(false);expect(app.control('scrub').disabled).toBe(false);expect(app.control('add-feedback').disabled).toBe(true);expect(app.video.pendingCallbacks).toBe(0);expect(a.time).toBe(0);expect(b.time).toBe(0);
    app.video.actual=.5;await app.seekTo(.5);
    expect(app.state().ready).toBe(true);expect(app.state().trace?.reference).toBe(.5);expect(app.control('add-feedback').disabled).toBe(false);expect(a.time).toBeCloseTo(.5,12);expect(b.bone('probe')).toEqual(a.bone('probe'));expect(app.video.pendingCallbacks).toBe(0);
    // Negative control: only revert the error classification in memory. The
    // exact same actual app catch/failPair path now reproduces permanent stop.
    const legacy=open(true);legacy.video.actual=1;await legacy.seekTo(.5);
    expect(legacy.state().ready).toBe(false);expect(legacy.control('play').disabled).toBe(true);expect(legacy.control('seek').disabled).toBe(true);expect(legacy.control('scrub').disabled).toBe(true);legacy.video.actual=.5;await legacy.seekTo(.5);expect(legacy.state().trace).toBeNull();expect(legacy.video.pendingCallbacks).toBe(0);
  }finally{a.dispose();b.dispose();assets.dispose();}
});

test('actual idle restart cancellation aborts its old generation and restores a held inspection; uncancelled restart resumes once',async()=>{
 const source=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 const start=source.indexOf('async function cancelPendingPlayback('),end=source.indexOf('function localDraft(',start);
 if(start<0||end<start)throw new Error('idle restart adapter boundary missing');
 // Exercise the actual app orchestration, including its post-await guard. The
 // browser's asynchronous reference-seek boundary is deliberately held here;
 // public poser/actual seek accuracy is covered by the adjacent real-player test.
 const body=source.slice(start,end);
 const script=`function open(){let idleHeld=false,loopRestarting=false,latestSeek=0,seeking=false,requestedProducer=null,ready=true,disposed=false,resumes=0,trace={reference:.5};let release;const gate=new Promise(resolve=>release=resolve),seekAbort=new AbortController(),document={hidden:false};const presentation={snapshot:()=>({lastDrawn:{reference:.5}})},stop=()=>{},invalidateTrace=()=>{trace=null;},frameControls=()=>{},message=()=>{},describe=e=>String(e),canRepeatIdle=()=>true;let calls=[];async function seekTo(target){calls.push(target);const generation=++latestSeek;if(target===0)await gate;if(generation===latestSeek){trace={reference:target};seeking=false;}}async function playComparison(){resumes++;}${body};return {start:restartIdle,cancel:cancelPendingPlayback,release:()=>release(),state:()=>({idleHeld,loopRestarting,latestSeek,aborted:seekAbort.signal.aborted,resumes,trace,calls})};}`;
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type Harness={start():Promise<void>;cancel():Promise<void>;release():void;state():{idleHeld:boolean;loopRestarting:boolean;latestSeek:number;aborted:boolean;resumes:number;trace:{reference:number}|null;calls:number[]}};
 const open=()=>new Function(code+';return open();')() as Harness;
 const cancelled=open(),pending=cancelled.start();await Promise.resolve();expect(cancelled.state().loopRestarting).toBe(true);await cancelled.cancel();expect(cancelled.state().aborted).toBe(true);expect(cancelled.state().calls).toEqual([0,.5]);cancelled.release();await pending;expect(cancelled.state()).toMatchObject({idleHeld:true,loopRestarting:false,resumes:0,trace:{reference:.5}});
 const normal=open(),running=normal.start();normal.release();await running;expect(normal.state()).toMatchObject({idleHeld:false,loopRestarting:false,resumes:1,trace:{reference:0}});
});
