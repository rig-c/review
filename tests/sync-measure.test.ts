import { expect, test } from 'bun:test';
import { summary,terminalTimingNotApplicable } from './sync-measure.ts';
import type { Sample, SyncBrowserReport } from './sync-measure-browser.ts';

function row(time:number, overrides:Partial<Sample>={}):Sample {
 return {nextReferenceEstimateMs:20,decodedIndex:0,nextDecodedPts:.04,playbackRate:1,videoPaused:false,videoSeeking:false,phase:'playback',callbackNow:10,callbackStartedAt:10,mediaTime:time,currentTimeBefore:time,currentTimeAfter:time,preparedBefore:{a:time,b:time},preparedAfter:{a:time,b:time},expectedDisplayTime:20,presentedFrames:1,before:{a:time,b:time},after:{a:time,b:time},poseFinishedAt:12,seekMs:1,drawMs:1,callbackMs:2,seekCalls:2,drawCalls:2,requestedTimes:[time,time],appliedTimes:[time,time],...overrides};
}
function report(samples:Sample[]):SyncBrowserReport {
 return {samples,scrubs:[],errors:[],callbackSource:'requestVideoFrameCallback',runtimeVersion:'1.11.2',userAgent:'synthetic accounting control',visibility:'visible',mutant:null};
}
test('eligible callback denominator includes zero-work late/held rows and last drawn drift',()=>{
 const measured=summary(report([row(0),row(13,{presentedFrames:3,seekCalls:0,drawCalls:0,seekMs:0,drawMs:0,poseFinishedAt:null,callbackStartedAt:30,after:{a:0,b:0},preparedAfter:{a:13,b:13}})])).playback;
 expect(measured.callbacks).toBe(2);expect(measured.posedPairs).toBe(1);expect(measured.drawnPairs).toBe(1);
 expect(measured.callbackDeadline.misses).toBe(1);expect(measured.callbackDeadline.missPct).toBe(50);
 expect(measured.targetPoseDriftVsPresentedPtsFrames.max).toBe(312);expect(measured.presentedFrameGaps).toEqual({total:1,leading:0,max:1});expect(measured.acceptance?.pass).toBe(false);
});
test('all-held, unknown, partial clip and missing actual presentation clock cannot pass',()=>{
 const held=[row(0,{seekCalls:0,drawCalls:0}),row(13,{seekCalls:0,drawCalls:0})];
 expect(summary(report(held)).playback.acceptance?.gates.freshPairs).toBe(false);
 expect(summary(report([row(0),row(13,{after:{a:null,b:null}})])).playback.acceptance?.gates.knownEveryCallback).toBe(false);
 expect(summary(report([row(0),row(.5)])).playback.acceptance?.gates.fullDomain).toBe(false);
 expect(summary(report([row(0),row(13,{nextReferenceEstimateMs:null})])).playback.acceptance?.gates.deadlineKnown).toBe(false);
 const fallback=report([row(0),row(13)]);fallback.callbackSource='currentTime fallback';expect(summary(fallback).playback.acceptance?.pass).toBe(false);
});
test('complete actual-clock positive control passes and paused callbacks do not pollute live epoch',()=>{
 const contiguous=Array.from({length:313},(_,i)=>row(i/24,{presentedFrames:i+1}));
 const measured=summary(report([...contiguous,row(7,{videoPaused:true,callbackStartedAt:100})])).playback;
 expect(measured.rawCallbacks).toBe(314);expect(measured.callbacks).toBe(313);expect(measured.acceptance?.pass).toBe(true);
 expect(measured.callbackDeadline.eligible).toBe(313);expect(measured.bothPoseMs.p95).toBe(1);
});

test('two endpoints with 311 absent presentations cannot certify continuous playback',()=>{
 const measured=summary(report([row(0,{presentedFrames:1}),row(13,{presentedFrames:313})])).playback;
 expect(measured.acceptance?.gates.freshPairs).toBe(true);expect(measured.domain.covered).toBe(true);
 expect(measured.presentedFrameGaps.total).toBe(311);expect(measured.presentationCoverage.observedFraction).toBe(2/313);expect(measured.acceptance?.gates.decodedCadence).toBe(false);expect(measured.acceptance?.pass).toBe(false);
 const held=Array.from({length:313},(_,i)=>row(i/24,{presentedFrames:i+1,...(i<4?{seekCalls:0,drawCalls:0}:{})}));expect(summary(report(held)).playback.acceptance?.gates.drawCoverage).toBe(false);
 const duplicate=[row(0,{presentedFrames:1}),row(13,{presentedFrames:1})];expect(summary(report(duplicate)).playback.presentationCoverage.monotonic).toBe(false);
});

test('actual initial decoded PTS covers frame zero despite an interior video seek; leading gaps still fail',()=>{
 const rows=Array.from({length:312},(_,i)=>row((i+1)/24,{presentedFrames:i+2})),raw=report(rows);raw.playbackBounds={start:{videoTime:.02,presentedPts:0,drawn:{a:0,b:0},presentedFrames:1},end:{videoTime:13,presentedPts:13,drawn:{a:13,b:13},presentedFrames:313}};
 expect(summary(raw).playback.acceptance?.pass).toBe(true);raw.samples=rows.slice(20);expect(summary(raw).playback.presentedFrameGaps.leading).toBe(20);expect(summary(raw).playback.acceptance?.gates.decodedCadence).toBe(false);
});

test('only bound terminal frame followed by actual ended and valid paused inspection is N/A',()=>{
 const rows=Array.from({length:313},(_,i)=>row(i/24,{presentedFrames:i+1,decodedIndex:i}));rows[312]={...rows[312]!,nextReferenceEstimateMs:null,nextDecodedPts:null};
 const raw=report(rows);raw.bindingIdentity={sourceHash:'packageSHA',referenceSha256:'referenceSHA'};raw.referenceIndex={...raw.bindingIdentity,count:313,last:{index:312,time:13}};raw.endedEvents=[{at:30,ended:true,phase:'playback'}];raw.endInspection={at:40,videoPaused:true,feedbackDisabled:false,deadlineKind:'paused',decodedIndex:312,inspection:{reference:13,a:13,b:13,source:'video-frame'},drawn:{a:13,b:13}};
 expect(terminalTimingNotApplicable(raw,rows[312]!,{start:0,end:13})).toBe(true);const good=summary(raw).playback;expect(good.acceptance?.pass).toBe(true);expect(good.callbackDeadline.eligible).toBe(312);expect(good.callbackDeadline.unknown).toBe(0);expect(good.callbackDeadline.terminalNotApplicable).toHaveLength(1);
 const negatives:Array<(value:SyncBrowserReport)=>void>=[value=>{value.referenceIndex=null;},value=>{value.referenceIndex!.last!.index=311;},value=>{value.referenceIndex!.last!.time=12;},value=>{value.referenceIndex!.referenceSha256='changed';},value=>{value.endedEvents=[];},value=>{value.endedEvents![0]!.ended=false;},value=>{value.endInspection!.feedbackDisabled=true;},value=>{value.endInspection!.videoPaused=false;},value=>{value.endInspection!.inspection=null;},value=>{value.endInspection!.inspection!.source='current-time';},value=>{value.endInspection!.at=20;},value=>{value.endInspection!.drawn.b=12;},value=>{value.samples[311]!.nextReferenceEstimateMs=null;}];
 for(const mutate of negatives){const changed=structuredClone(raw);mutate(changed);expect(summary(changed).playback.acceptance?.pass).toBe(false);}
});
