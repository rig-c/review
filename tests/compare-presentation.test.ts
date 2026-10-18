import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';import {loadModel,RigPlayer} from '@rig-c/play';
import {inspectionReferenceFrame,lastSupportedReferenceFrame} from '../src/reference-frames.ts';
import {ComparePresentation} from '../src/compare-presentation.ts';
import {compareSeekStep,type InspectionPlayer} from '../src/compare-playhead.ts';
const sample=(time:number)=>({time,source:'video-frame' as const}),domain={start:0 as const,end:2};
function pair(){let ms=0;const events:string[]=[];const make=(side:string):InspectionPlayer=>({time:0,pause(){},seek(time){events.push(side+'seek');(this as {time:number}).time=time;ms+=4;},draw(){events.push(side+'draw');ms+=1;}});return {a:make('a'),b:make('b'),now:()=>ms,set:(n:number)=>{ms=n;},events};}
test('late arrival and expensive preparation still draw the latest pair; next-reference estimate classifies afterward',()=>{
 const p=pair(),state=new ComparePresentation();state.inspect(sample(0),p.a,p.b,domain,p.now);p.events.length=0;p.set(20);
 const late=state.present(sample(.1),10,1,p.a,p.b,domain,p.now,.04);expect(p.events).toEqual(['aseek','bseek','adraw','bdraw']);expect(late.lastDrawn?.reference).toBe(.1);expect(late.currentDisplayLatenessMs).toBeGreaterThan(0);expect(late.lastLatenessMs).toBe(0);expect(late.inspection?.reference).toBe(.1);
 p.events.length=0;p.set(100);const missed=state.present(sample(.2),10,3,p.a,p.b,domain,p.now,.04);expect(p.events).toEqual(['aseek','bseek','adraw','bdraw']);expect(missed.lastDrawn?.reference).toBe(.2);expect(missed.inspection).toBeNull();expect(missed.status).toBe('drawn');expect(missed.dropped).toBe(0);expect(missed.presentationGaps).toBe(1);expect(missed.deadlineMisses).toBe(1);
 p.set(0);const recovered=state.present(sample(.3),10,4,p.a,p.b,domain,p.now,.04);expect(recovered.inspection?.reference).toBe(.3);
 p.set(500);const inspected=state.inspect(sample(.1),p.a,p.b,domain,p.now);expect(inspected.inspection?.reference).toBe(.1);expect(inspected.deadlineKind).toBe('paused');
});
test('missing next-reference estimate keeps drawing and marks timing unknown instead of passing a deadline',()=>{
 const p=pair(),state=new ComparePresentation();const value=state.present(sample(.1),0,1,p.a,p.b,domain,p.now);
 expect(p.events).toEqual(['aseek','bseek','adraw','bdraw']);expect(value.lastDrawn?.reference).toBe(.1);expect(value.inspection).toBeNull();expect(value.deadlineKind).toBe('unknown');expect(value.deadlineKnownCallbacks).toBe(0);expect(value.deadlineUnknownCallbacks).toBe(1);expect(value.deadlineMisses).toBe(0);
});
test('partial second draw failure invalidates the visible pair; late completed draws stay drawn but not inspection eligible',()=>{
 const p=pair(),state=new ComparePresentation();state.inspect(sample(0),p.a,p.b,domain,p.now);p.b.draw=()=>{throw new Error('second draw failed');};expect(()=>state.present(sample(.2),1000,1,p.a,p.b,domain,p.now)).toThrow('second draw failed');expect(state.snapshot().lastDrawn).toBeNull();expect(state.snapshot().inspection).toBeNull();
 const q=pair(),other=new ComparePresentation();q.a.draw=()=>q.set(q.now()+20);const result=other.present(sample(.2),10,1,q.a,q.b,domain,q.now,.001);expect(result.lastDrawn?.reference).toBe(.2);expect(result.inspection).toBeNull();expect(result.deadlineMisses).toBe(1);expect(result.lastLatenessMs).toBeGreaterThan(0);
});
test('public RigPlayer presentation preserves exact cold fixed-history bone pose through late submissions and paused recovery',async()=>{
 const bytes=await readFile(new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'),assets=await loadModel({modelUrl:'http://fixture.invalid/probe.model.json',setsUrl:null,fetch:new Proxy(fetch,{apply:()=>Promise.resolve(new Response(bytes))})});
 const make=()=>{const player=new RigPlayer({style:{clipPath:''}} as unknown as HTMLElement,assets,{seekStep:compareSeekStep,meshBackend:'canvas2d'});player.environment(null);player.play('inspect',{loop:false});player.pause();return player;};
 const a=make(),b=make(),control=make(),state=new ComparePresentation();let ms=0;
 try{state.inspect(sample(0),a,b,domain,()=>ms);const dropped=state.present(sample(1.001),1,1,a,b,domain,()=>ms++,.001);expect(dropped.inspection).toBeNull();expect(dropped.lastDrawn?.reference).toBe(1.001);expect(a.time).toBeCloseTo(1.001,12);const recovered=state.inspect(sample(.25),a,b,domain,()=>ms);control.seek(.25);control.draw();expect(recovered.lastDrawn?.a).toBe(a.time);expect(a.bone('probe')).toEqual(control.bone('probe'));expect(b.bone('probe')).toEqual(control.bone('probe'));
 const short={start:0 as const,end:.8},video={frames:[0,.5,1].map((time,index)=>({time,index})),duration:1.5};
 state.inspect(sample(.5),a,b,short,()=>ms);const before=state.snapshot(),boneBefore=a.bone('probe');let referenceWrites=0;
 const selectThenInspect=(requested:number)=>{const selected=inspectionReferenceFrame(video,requested,short);referenceWrites++;return state.inspect(sample(selected.time),a,b,short,()=>ms);};
 expect(()=>selectThenInspect(.76)).toThrow('REFERENCE_SELECTION_UNAVAILABLE');expect(referenceWrites).toBe(0);expect(state.snapshot()).toEqual(before);expect(a.bone('probe')).toEqual(boneBefore);expect(a.time).toBe(b.time);
 const end=lastSupportedReferenceFrame(video,short)!;expect(end.time).toBe(.5);expect(selectThenInspect(end.time).inspection?.reference).toBe(.5);expect(selectThenInspect(0).inspection?.reference).toBe(0);
 }
 finally{a.dispose();b.dispose();control.dispose();assets.dispose();}
});

test('terminal unknown live draw becomes feedback eligible only after paused final-frame inspection',()=>{
 const p=pair(),state=new ComparePresentation(),video={frames:[{index:0,time:0},{index:1,time:2}],duration:2.1};
 const live=state.present(sample(2),10,2,p.a,p.b,domain,p.now);expect(live.deadlineKind).toBe('unknown');expect(live.inspection).toBeNull();
 const terminal=lastSupportedReferenceFrame(video,domain)!;expect(terminal.time).toBe(2);const paused=state.inspect(sample(terminal.time),p.a,p.b,domain,p.now);expect(paused.deadlineKind).toBe('paused');expect(paused.inspection?.reference).toBe(2);expect(paused.lastDrawn?.a).toBe(2);expect(paused.lastDrawn?.b).toBe(2);
});
