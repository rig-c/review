import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';import {loadModel,RigPlayer} from '@rig-c/play';
import {inspectionReferenceFrame,lastSupportedReferenceFrame} from '../src/reference-frames.ts';
import {ComparePresentation} from '../src/compare-presentation.ts';
import {compareSeekStep,type InspectionPlayer} from '../src/compare-playhead.ts';
const sample=(time:number)=>({time,source:'video-frame' as const}),domain={start:0 as const,end:2};
function pair(){let ms=0;const events:string[]=[];const make=(side:string):InspectionPlayer=>({time:0,pause(){},seek(time){events.push(side+'seek');(this as {time:number}).time=time;ms+=4;},draw(){events.push(side+'draw');ms+=1;}});return {a:make('a'),b:make('b'),now:()=>ms,set:(n:number)=>{ms=n;},events};}
test('arrival-late skips all work; prepared-late preserves last drawn pair despite changed player.time',()=>{
 const p=pair(),state=new ComparePresentation();state.inspect(sample(0),p.a,p.b,domain,p.now);p.events.length=0;p.set(20);
 const late=state.present(sample(.1),10,1,p.a,p.b,domain,p.now);expect(p.events).toEqual([]);expect(late.lastDrawn?.reference).toBe(0);expect(late.inspection).toBeNull();
 p.set(0);const prepared=state.present(sample(.2),5,3,p.a,p.b,domain,p.now);expect(p.events).toEqual(['aseek','bseek']);expect(p.a.time).toBe(.2);expect(p.b.time).toBe(.2);expect(prepared.lastDrawn?.reference).toBe(0);expect(prepared.prepared?.reference).toBe(.2);expect(prepared.inspection).toBeNull();expect(prepared.status).toBe('held');expect(prepared.dropped).toBe(2);expect(prepared.presentationGaps).toBe(1);
 p.set(0);const recovered=state.present(sample(.3),100,4,p.a,p.b,domain,p.now);expect(recovered.lastDrawn?.reference).toBe(.3);expect(recovered.inspection?.reference).toBe(.3);expect(recovered.status).toBe('drawn');
 p.set(500);const inspected=state.inspect(sample(.1),p.a,p.b,domain,p.now);expect(inspected.inspection?.reference).toBe(.1);expect(inspected.lastDrawn?.reference).toBe(.1);p.set(0);expect(state.present(sample(.2),100,100,p.a,p.b,domain,p.now).presentationGaps).toBe(1);
});
test('partial second draw failure invalidates the visible pair; late completed draws stay drawn but not inspection eligible',()=>{
 const p=pair(),state=new ComparePresentation();state.inspect(sample(0),p.a,p.b,domain,p.now);p.b.draw=()=>{throw new Error('second draw failed');};expect(()=>state.present(sample(.2),1000,1,p.a,p.b,domain,p.now)).toThrow('second draw failed');expect(state.snapshot().lastDrawn).toBeNull();expect(state.snapshot().inspection).toBeNull();
 const q=pair(),other=new ComparePresentation();q.a.draw=()=>q.set(q.now()+20);const result=other.present(sample(.2),10,1,q.a,q.b,domain,q.now);expect(result.lastDrawn?.reference).toBe(.2);expect(result.inspection).toBeNull();expect(result.deadlineMisses).toBe(1);expect(result.lastLatenessMs).toBeGreaterThan(0);
});
test('public RigPlayer presentation preparation preserves exact cold fixed-history bone pose through drops and paused recovery',async()=>{
 const bytes=await readFile(new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'),assets=await loadModel({modelUrl:'http://fixture.invalid/probe.model.json',setsUrl:null,fetch:new Proxy(fetch,{apply:()=>Promise.resolve(new Response(bytes))})});
 const make=()=>{const player=new RigPlayer({style:{clipPath:''}} as unknown as HTMLElement,assets,{seekStep:compareSeekStep,meshBackend:'canvas2d'});player.environment(null);player.play('inspect',{loop:false});player.pause();return player;};
 const a=make(),b=make(),control=make(),state=new ComparePresentation();let ms=0;
 try{state.inspect(sample(0),a,b,domain,()=>ms);const dropped=state.present(sample(1.001),1,1,a,b,domain,()=>ms++);expect(dropped.inspection).toBeNull();expect(dropped.lastDrawn?.reference).toBe(0);expect(a.time).toBeCloseTo(1.001,12);const recovered=state.inspect(sample(.25),a,b,domain,()=>ms);control.seek(.25);control.draw();expect(recovered.lastDrawn?.a).toBe(a.time);expect(a.bone('probe')).toEqual(control.bone('probe'));expect(b.bone('probe')).toEqual(control.bone('probe'));
 const short={start:0 as const,end:.8},video={frames:[0,.5,1].map((time,index)=>({time,index})),duration:1.5};
 state.inspect(sample(.5),a,b,short,()=>ms);const before=state.snapshot(),boneBefore=a.bone('probe');let referenceWrites=0;
 const selectThenInspect=(requested:number)=>{const selected=inspectionReferenceFrame(video,requested,short);referenceWrites++;return state.inspect(sample(selected.time),a,b,short,()=>ms);};
 expect(()=>selectThenInspect(.76)).toThrow('REFERENCE_SELECTION_UNAVAILABLE');expect(referenceWrites).toBe(0);expect(state.snapshot()).toEqual(before);expect(a.bone('probe')).toEqual(boneBefore);expect(a.time).toBe(b.time);
 const end=lastSupportedReferenceFrame(video,short)!;expect(end.time).toBe(.5);expect(selectThenInspect(end.time).inspection?.reference).toBe(.5);expect(selectThenInspect(0).inspection?.reference).toBe(0);
 }
 finally{a.dispose();b.dispose();control.dispose();assets.dispose();}
});
