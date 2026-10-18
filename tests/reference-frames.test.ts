import {afterEach,expect,test} from 'bun:test';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,utimes,realpath} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {nextReferenceInterval,inspectionReferenceFrame,lastSupportedReferenceFrame,nearestReferenceFrame,producerFrameAssociations,referenceFrameAtTime,referenceSeekPosition,requireUniqueReferencePts,type VideoInfo} from '../src/reference-frames.ts';
import {frameAtTime,type FrameClock} from '../src/frame-clock.ts';
import {referenceFrameIndex} from '../src/reference-frame-index.ts';
import {freshCompareSession,saveCompareSession,readCompareSession} from '../src/compare-session.ts';
import {loadCompare} from '../src/compare.ts';import {startCompareServer} from '../src/compare-server.ts';
const dirs:string[]=[];afterEach(async()=>{for(const path of dirs.splice(0))await rm(path,{recursive:true,force:true});});
const info=(times:number[],duration:number):VideoInfo=>({frames:times.map((time,index)=>({time,index})),duration});
test('nearest real VFR PTS and interior seeks preserve first/last selection without rate or epsilon',()=>{
 const video=info([0,.071,.313,.9],1.7);requireUniqueReferencePts(video);
 expect(nearestReferenceFrame(video.frames,.0355).index).toBe(0);
 expect(nearestReferenceFrame(video.frames,.31).index).toBe(2);
 for(const frame of video.frames){const position=referenceSeekPosition(video,frame);expect(position).toBeGreaterThan(frame.time);expect(position).toBeLessThan(video.frames[frame.index+1]?.time??video.duration);expect(video.frames.filter(value=>value.time<=position).at(-1)?.index).toBe(frame.index);expect(referenceFrameAtTime(video,frame.time)?.index).toBe(frame.index);}
 expect(referenceFrameAtTime(video,-1)).toBeNull();expect(referenceFrameAtTime(video,.90001)?.index).toBe(3);expect(referenceFrameAtTime(video,1.7)).toBeNull();expect(referenceFrameAtTime(video,NaN)).toBeNull();
 expect(()=>requireUniqueReferencePts(info([0,.1,.1],.3))).toThrow('PTS_AMBIGUOUS');expect(()=>requireUniqueReferencePts(info([0,.3],.3))).toThrow('INDEX_INVALID');
 const tiny=info([1,1+Number.EPSILON],2);expect(()=>referenceSeekPosition(tiny,tiny.frames[0]!)).toThrow('representable interior');
});
test('browser precision uses the video domain at rounded first and final PTS without altering producer floors',()=>{
 const video=info([.041667,.083333],.125);requireUniqueReferencePts(video);
 expect(referenceFrameAtTime(video,1/24)?.index).toBe(0);expect(referenceFrameAtTime(video,2/24)?.index).toBe(1);
 expect(referenceFrameAtTime(video,0)?.index).toBe(0);expect(referenceFrameAtTime(video,.124)?.index).toBe(1);
 expect(referenceFrameAtTime(video,-Number.MIN_VALUE)).toBeNull();expect(referenceFrameAtTime(video,.125)).toBeNull();expect(referenceFrameAtTime(video,Infinity)).toBeNull();
 expect(frameAtTime({kind:'samples',frameTimes:[.041667,.083333]},1/24)).toBeNull();
});
test('nearest requests outside shorter clip are refused; playback explicitly selects the final supported decoded PTS',()=>{
 const video=info([0,.5,1],1.5),domain={start:0 as const,end:.8};
 expect(()=>inspectionReferenceFrame(video,.76,domain)).toThrow('REFERENCE_SELECTION_UNAVAILABLE');expect(()=>inspectionReferenceFrame(video,.8,domain)).toThrow('REFERENCE_SELECTION_UNAVAILABLE');
 expect(inspectionReferenceFrame(video,.7,domain).time).toBe(.5);expect(lastSupportedReferenceFrame(video,domain)?.time).toBe(.5);
 expect(lastSupportedReferenceFrame(info([.9,1],1.5),domain)).toBeNull();expect(lastSupportedReferenceFrame(video,{start:0,end:1})?.index).toBe(2);
 expect(()=>inspectionReferenceFrame(video,NaN,domain)).toThrow('outside shared domain');
});
test('review association roundtrips rounded explicit samples while exact floor stays unchanged',()=>{
 const video=info([0,7.333333,7.375,7.416667,7.458333],7.6),clock:FrameClock={kind:'samples',frameTimes:[0,7.33333,7.375,7.41667,7.45833]},mapping=producerFrameAssociations(clock,video);
 for(let frame=0;frame<clock.frameTimes.length;frame++)expect(mapping.get(nearestReferenceFrame(video.frames,clock.frameTimes[frame]!).index)).toBe(frame);
 expect(frameAtTime(clock,7.416667)).toBe(2);expect(mapping.get(3)).toBe(3);
 expect(producerFrameAssociations(null,video).size).toBe(0);
 const edges=info([.04,1],1.04),edgeMap=producerFrameAssociations({kind:'samples',frameTimes:[0,1.000003]},edges);expect(edgeMap.get(0)).toBe(0);expect(edgeMap.get(1)).toBe(1);
 const ambiguous=producerFrameAssociations({kind:'samples',frameTimes:[0,.03,.071]},info([0,.071],.2));expect(ambiguous.get(0)).toBeNull();expect(ambiguous.get(1)).toBe(2);
 expect(()=>producerFrameAssociations({kind:'uniform',fps:24,frame0:0,frameCount:100001},video)).toThrow('SAMPLE_LIMIT');
});
test('index cache rehashes actual bytes and rejects a changed reference even with restored mtime',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-frame-index-')));dirs.push(root);const video=join(root,'selected.mp4'),binary=join(root,'probe'),counter=join(root,'count');await writeFile(video,'original bytes');await utimes(video,0,1);
 await writeFile(binary,`#!/bin/sh\nprintf x >> '${counter}'\nprintf '%s' '{"frames":[{"best_effort_timestamp_time":"0"},{"best_effort_timestamp_time":"0.1"}],"streams":[{"duration":"0.2"}]}'\n`,{mode:0o755});
 const digest=createHash('sha256').update(await readFile(video)).digest('hex'),get=referenceFrameIndex(video,digest,'a'.repeat(64),binary);
 expect((await get()).available).toBe(true);await utimes(video,0,2);expect((await get()).available).toBe(true);expect(await readFile(counter,'utf8')).toBe('x');
 await writeFile(video,'different byte');await utimes(video,0,1);await expect(get()).rejects.toThrow('inputs changed');
 const missing=referenceFrameIndex(video,createHash('sha256').update(await readFile(video)).digest('hex'),'b'.repeat(64),join(root,'absent'));const unavailable=await missing();expect(unavailable.available).toBe(false);expect(JSON.stringify(unavailable)).toContain('INDEX_UNAVAILABLE');expect(JSON.stringify(unavailable)).not.toContain(root);
});
test('fixed comparison timestamp endpoint binds actual public reference and rejects path parameters/current mutations',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'review-frame-api-')));dirs.push(root);
 for(const side of ['a','b']){await mkdir(join(root,side));await cp(join(import.meta.dir,'fixtures/strip-probe/build'),join(root,side,'build'),{recursive:true});}
 const reference=join(root,'reference.mov');await cp(join(import.meta.dir,'fixtures/strip-probe/reference.mov'),reference);const p=await loadCompare({a:join(root,'a'),b:join(root,'b'),reference,animation:'inspect'}),server=await startCompareServer(p,{port:0,stateDir:join(root,'state')}),base=`http://127.0.0.1:${server.port}`;
 try{const response=await fetch(base+'/api/compare/reference-frames');expect(response.status).toBe(200);const index=await response.json();expect(index.available).toBe(true);expect(index.referenceSha256).toBe(p.response.binding.reference.sha256);expect(index.sourceHash).toBe(p.response.sourceHash);expect(index.video.frames.map((frame:{time:number})=>frame.time)).toEqual([0,.5,1]);expect(JSON.stringify(index)).not.toContain(root);
 const context={animation:'inspect',interval:{frameStart:0,frameEnd:1,inclusive:true},mediaTime:0,frames:{a:null,b:0},playheads:{reference:0,a:0,b:0},reviewFrames:{a:null,b:0},requestedProducer:{side:'b',frame:0,time:0},decodedIndex:0};const value={...freshCompareSession(p),feedback:[{id:'frame-provenance',side:'b',frameStart:0,frameEnd:1,target:{kind:'rig',name:p.b.manifest.id},category:'quality',summary:'Inspect the selected reference frame',context}]};await saveCompareSession(p,value,join(root,'state'));expect((await readCompareSession(p,join(root,'state'))).feedback[0]!.context).toEqual(context);
 expect((await fetch(base+'/api/compare/reference-frames?path=/etc/passwd')).status).toBe(400);expect((await fetch(base+'/api/compare/reference-frames',{method:'POST'})).status).toBe(405);expect((await fetch(base+'/api/compare/reference-frames',{headers:{Host:'evil.test'}})).status).toBe(403);
 await writeFile(reference,(await readFile(reference)).subarray(0,-1));expect((await fetch(base+'/api/compare/reference-frames')).status).toBe(409);
 }finally{await server.stop(true);}
});

test('next-reference estimate uses adjacent real VFR PTS and actual rate; no terminal or missing interval is invented',()=>{
 const video=info([0,.071,.313,.9],1.7);
 expect(nextReferenceInterval(video,.071,1)).toBe(.313-.071);expect(nextReferenceInterval(video,.071,2)).toBe((.313-.071)/2);expect(nextReferenceInterval(video,.071,.5)).toBe((.313-.071)/.5);
 expect(nextReferenceInterval(video,.9,1)).toBeNull();expect(nextReferenceInterval(null,0,1)).toBeNull();expect(nextReferenceInterval(video,0,0)).toBeNull();expect(nextReferenceInterval(video,0,-1)).toBeNull();expect(nextReferenceInterval(video,0,NaN)).toBeNull();expect(nextReferenceInterval(info([0,0,.1],.2),0,1)).toBeNull();
});
