import { expect, test } from 'bun:test';
import { clockForAnimation, frameAtTime, framesSetClock, lastFrame, MAX_STAGE_FRAME_TIMES, rigPaneLabel, samplesClock, timeAtFrame, transportClock, type FrameClock, type StageClock } from '../src/frame-clock.ts';
import { parseReport } from '../src/report.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('explicit 24fps clock shows F100 at its exact sample and floors only in-domain',()=>{
 const clock=parseReport({spec:'rig-pose-report/1',frames:313,fps:24,frame0:0})!.clock;
 expect(clock).toEqual({kind:'uniform',fps:24,frame0:0,frameCount:313});expect(lastFrame(clock)).toBe(312);expect(timeAtFrame(clock,100)).toBe(100/24);expect(timeAtFrame(clock,100)!.toFixed(4)).toBe('4.1667');expect(frameAtTime(clock,100/24)).toBe(100);expect(frameAtTime(clock,4.1667)).toBe(100);
 expect(frameAtTime(clock,100/24-0.000001)).toBe(99);expect(frameAtTime(clock,13)).toBe(312);expect(frameAtTime(clock,13.000001)).toBeNull();expect(frameAtTime(clock,-0.000001)).toBeNull();
 for(let frame=0;frame<=312;frame++)expect(frameAtTime(clock,timeAtFrame(clock,frame)!)).toBe(frame);
});
test('offset clock uses exact sample comparisons without subtraction round-down or epsilon snapping',()=>{
 const clock:FrameClock={kind:'uniform',fps:10,frame0:2,frameCount:4};expect(timeAtFrame(clock,3)).toBe(2.3);expect(frameAtTime(clock,2.3)).toBe(3);expect(frameAtTime(clock,2.301)).toBeNull();expect(frameAtTime(clock,2)).toBe(0);expect(frameAtTime(clock,1.9999)).toBeNull();expect(frameAtTime(clock,2.299999)).toBe(2);expect(frameAtTime(clock,2.05)).toBe(0);
 for(const fps of [1.5,24,29.97,60]){const explicit=parseReport({spec:'rig-pose-report/1',frames:100,fps,frame0:10000})!.clock;expect(Array.from({length:100},(_,i)=>frameAtTime(explicit,timeAtFrame(explicit,i)!))).toEqual(Array.from({length:100},(_,i)=>i));}
});
test('irregular frameTimes floor exact sample indices with no interpolated rate',()=>{
 const clock=parseReport({spec:'rig-pose-report/1',frameTimes:[1,1.08,1.41,2.9]})!.clock;expect(lastFrame(clock)).toBe(3);expect(timeAtFrame(clock,2)).toBe(1.41);expect(frameAtTime(clock,1.4)).toBe(1);expect(frameAtTime(clock,1.41)).toBe(2);expect(frameAtTime(clock,2.89999)).toBe(2);expect(frameAtTime(clock,2.9)).toBe(3);expect(frameAtTime(clock,0.99)).toBeNull();expect(frameAtTime(clock,2.900001)).toBeNull();
});
test('single sample domains contain only the declared instant; empty or unbounded clocks remain unknown',()=>{
 for(const clock of [{kind:'samples',frameTimes:[2]},{kind:'uniform',fps:24,frame0:2,frameCount:1}] satisfies FrameClock[]){expect(lastFrame(clock)).toBe(0);expect(frameAtTime(clock,2)).toBe(0);expect(frameAtTime(clock,1.999)).toBeNull();expect(frameAtTime(clock,2.001)).toBeNull();}
 for(const clock of [null,{kind:'samples',frameTimes:[]},{kind:'uniform',fps:24,frame0:0},{kind:'uniform',fps:24,frame0:0,frameCount:0}] satisfies (FrameClock|null)[]){expect(lastFrame(clock)).toBeNull();expect(timeAtFrame(clock,0)).toBeNull();expect(frameAtTime(clock,0)).toBeNull();}
});
test('invalid frame indices and nonfinite times never select or scrub a sample',()=>{
 const clock:FrameClock={kind:'samples',frameTimes:[0,0.5]};for(const frame of [-1,0.5,2,NaN,Infinity])expect(timeAtFrame(clock,frame)).toBeNull();for(const time of [NaN,Infinity,-Infinity])expect(frameAtTime(clock,time)).toBeNull();
});
test('player clocks require the report named active animation while source-only clocks need no invented clip',()=>{
 const clock:FrameClock={kind:'uniform',fps:24,frame0:0,frameCount:313};expect(clockForAnimation(clock,'dance','dance')).toBe(clock);expect(clockForAnimation(clock,'dance','idle')).toBeNull();expect(clockForAnimation(clock,'absent-output','idle')).toBeNull();expect(clockForAnimation(clock,undefined,'dance')).toBeNull();expect(clockForAnimation(clock,'dance','')).toBeNull();expect(clockForAnimation(null,'dance','dance')).toBeNull();expect(clockForAnimation(clock,undefined,'',false)).toBe(clock);expect(clockForAnimation(clock,'source','',false)).toBe(clock);
});
test('legacy report frame count, duration and event pairs supply no clock or context frame',()=>{
 const report=parseReport({spec:'rig-pose-report/1',animation:'dance',frames:313,duration:13,bends:[{frame:100,t:100/24}],switches:[{frames:[100,110],from:100/24,to:111/24}]})!;expect(report.clock).toBeNull();expect(frameAtTime(report.clock,100/24)).toBeNull();expect(report.categories[0]!.events[0]!.seek?.time).toBe(100/24);
});
test('declared clocks validate paired offsets, frame count and representable sample endpoints',()=>{
 for(const [body,field] of [[{fps:24},'frame0'],[{frame0:0},'fps'],[{fps:0,frame0:0},'fps'],[{frames:3,frameTimes:[0,1]},'frameTimes'],[{frames:2,fps:Number.MIN_VALUE,frame0:0},'fps'],[{frames:2,fps:1e20,frame0:1e20},'fps'],[{frames:4,fps:1.5,frame0:4503599627370496},'fps']] as const)expect(()=>parseReport({spec:'rig-pose-report/1',...body})).toThrow('report.json.'+field);
 expect(parseReport({spec:'rig-pose-report/1',fps:10,frame0:2})!.clock).toEqual({kind:'uniform',fps:10,frame0:2});
});

// #164: a retarget's own report clock for the transport counter and the rig pane header.
test('samplesClock keeps only a bounded, finite, strictly increasing frameTimes list',()=>{
 expect(samplesClock([0,0.041667,0.083333])).toEqual({kind:'samples',frameTimes:[0,0.041667,0.083333]});
 for(const bad of [null,undefined,[],[0,0],[0.1,0.05],[0,Number.NaN],[0,'1'],{0:0},Array.from({length:MAX_STAGE_FRAME_TIMES+1},(_,i)=>i)])expect(samplesClock(bad)).toBeNull();
 const source=[0,1];const clock=samplesClock(source)!;source.push(2);expect(clock).toEqual({kind:'samples',frameTimes:[0,1]});
});
test('transportClock prefers the report for its animation, else the stage build\'s clock for the animation on the stage',async()=>{
 const walk=JSON.parse(await readFile(join(import.meta.dir,'fixtures/retarget-wind-walk.json'),'utf8')) as {frameTimes:number[]};
 const stageClock=samplesClock(walk.frameTimes)!,stage:StageClock={animation:'walk',modelHash:'h1',clock:stageClock};
 const none={clock:null,animation:undefined},report:FrameClock={kind:'uniform',fps:30,frame0:0,frameCount:10};
 expect(transportClock(none,'walk',true,stage,'h1')).toEqual({clock:stageClock,source:'stage'});
 expect(transportClock({clock:report,animation:'walk'},'walk',true,stage,'h1')).toEqual({clock:report,source:'report'});
 // A report bound to another clip does not hide the stage's own clock for the active one.
 expect(transportClock({clock:report,animation:'idle'},'walk',true,stage,'h1')).toEqual({clock:stageClock,source:'stage'});
 expect(transportClock(none,'idle',true,stage,'h1')).toBeNull();
 expect(transportClock(none,'walk',true,stage,'h2')).toBeNull();
 expect(transportClock(none,'walk',false,stage,'h1')).toBeNull();
 expect(transportClock(none,'',true,{...stage,animation:''},'h1')).toBeNull();
 expect(transportClock(none,'walk',true,null,'h1')).toBeNull();
 // The FEET line's frame: F14 at the run's frameTimes[14].
 const clock=transportClock(none,'walk',true,stage,'h1')!.clock;expect(timeAtFrame(clock,14)).toBe(0.583333);expect(frameAtTime(clock,0.583333)).toBe(14);expect(lastFrame(clock)).toBe(23);
});
test('#1018: a rigc-frames/1 set states written frames at i * stride / fps, and nothing outside them',()=>{
 // The producer's own record for a 0.8 s clip at 12 fps (rigc render, measured): 11 frames, the last at 10/12 s.
 const clock=framesSetClock({fps:12,written:11,stride:1});
 expect(lastFrame(clock)).toBe(10);
 for(let i=0;i<=10;i++){const t=timeAtFrame(clock,i)!;expect(Math.abs(t-i*1/12)).toBeLessThan(1e-12);expect(frameAtTime(clock,t)).toBe(i);}
 expect(frameAtTime(clock,0.8)).toBe(9);expect(frameAtTime(clock,10/12)).toBe(10);
 for(const outside of [-0.001,10/12+1e-6,Number.NaN])expect(frameAtTime(clock,outside)).toBeNull();
 expect(timeAtFrame(clock,11)).toBeNull();expect(timeAtFrame(clock,-1)).toBeNull();expect(timeAtFrame(clock,1.5)).toBeNull();
 // A stride writes every stride-th sample from frame 0: frame i is sample i * stride.
 const strided=framesSetClock({fps:24,written:13,stride:2});
 expect(lastFrame(strided)).toBe(12);for(let i=0;i<=12;i++){expect(Math.abs(timeAtFrame(strided,i)!-i*2/24)).toBeLessThan(1e-12);expect(frameAtTime(strided,i*2/24)).toBe(i);}
 expect(frameAtTime(strided,3/24)).toBe(1);
});
test('#1018: transportClock takes the declared record after the report and before the stage, by animation only',()=>{
 const report:FrameClock={kind:'uniform',fps:30,frame0:0,frameCount:10},idle=framesSetClock({fps:12,written:13,stride:1}),walk=framesSetClock({fps:12,written:5,stride:1});
 const stageClock:FrameClock={kind:'uniform',fps:60,frame0:0,frameCount:61},stage:StageClock={animation:'idle',modelHash:'h1',clock:stageClock};
 const frameClocks=[{animation:'idle',clock:idle},{animation:'walk',clock:walk}];
 expect(transportClock({clock:report,animation:'idle',frameClocks},'idle',true,stage,'h1')).toEqual({clock:report,source:'report'});
 expect(transportClock({clock:report,animation:'walk',frameClocks},'idle',true,stage,'h1')).toEqual({clock:idle,source:'frames'});
 expect(transportClock({clock:null,animation:undefined,frameClocks},'walk',true,null,null)).toEqual({clock:walk,source:'frames'});
 // No set for the animation: no clock from the record; the stage's own clock still applies to its build.
 expect(transportClock({clock:null,animation:undefined,frameClocks},'jump',true,null,null)).toBeNull();
 expect(transportClock({clock:null,animation:undefined,frameClocks:[frameClocks[1]!]},'idle',true,stage,'h1')).toEqual({clock:stageClock,source:'stage'});
 // The record is the played model's: no player, or no animation playing, takes none of it.
 expect(transportClock({clock:null,animation:undefined,frameClocks},'idle',false,null,null)).toBeNull();
 expect(transportClock({clock:null,animation:undefined,frameClocks},'',true,null,null)).toBeNull();
 // Absent (every package without a record) is today's behaviour exactly.
 for(const absent of [undefined,null,[]])expect(transportClock({clock:null,animation:undefined,frameClocks:absent},'idle',true,stage,'h1')).toEqual(transportClock({clock:null,animation:undefined},'idle',true,stage,'h1'));
});
test('rigPaneLabel names the animation, frame and time of the drawn pose',()=>{
 expect(rigPaneLabel({hasPlayer:true,animation:'walk',time:0.583333,frame:14})).toBe('Generated rig · walk · F14 · 0.583 s');
 expect(rigPaneLabel({hasPlayer:true,animation:'idle',time:1.25,frame:null})).toBe('Generated rig · idle · 1.250 s');
 expect(rigPaneLabel({hasPlayer:true,animation:'',time:0,frame:null})).toBe('Generated rig · no animation · 0.000 s');
 expect(rigPaneLabel({hasPlayer:false,animation:'walk',time:0.5,frame:3})).toBe('Generated rig · read only');
});
