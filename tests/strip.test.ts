import { expect, test } from 'bun:test';
import { parseStripRequest, planStrip, stripNoClock, type StripBinding, type StripRequest } from '../src/strip.ts';
import { parseReport } from '../src/report.ts';
const source='a'.repeat(64),rig='b'.repeat(64),motion='c'.repeat(64);
const binding:StripBinding={sourceHash:source,packages:[{id:'single',label:'Probe',sourceHash:source,reviewedSource:{packageRevision:'r1',viewerVersion:'0.1.0',runtimeVersion:'1.11.0',rig:{path:'build/skeleton.model.json',sha256:rig},motion:{path:'motion.json',sha256:motion}}}],reference:{name:'source.mp4',sha256:'d'.repeat(64)},compare:null};
const request=(overrides:Partial<StripRequest>={}):StripRequest=>({format:'png',sourceHash:source,animation:'dance',referenceId:'source',intervals:[{id:'selection',basis:'single',frameStart:0,frameEnd:2}],...overrides});
const report=parseReport({spec:'rig-pose-report/1',animation:'dance',frameTimes:[0,.037,.19,1]});
test('inclusive strip columns preserve exact irregular times and full identity',()=>{
 const plan=planStrip(request(),{mode:'single',binding,reports:{single:report}});
 expect(plan.groups[0].samples).toEqual([{requestedFrame:0,time:0},{requestedFrame:1,time:.037},{requestedFrame:2,time:.19}]);expect(plan.rows.map(r=>r.id)).toEqual(['reference','single']);expect(plan.binding.packages[0].reviewedSource.rig?.sha256).toBe(rig);expect(plan.binding.packages[0].reviewedSource.motion?.sha256).toBe(motion);expect(plan.binding.reference.sha256).toBe(binding.reference.sha256);
 plan.binding.packages[0].label='mutated';expect(binding.packages[0].label).toBe('Probe');
});
test('F176–184 means nine chronological columns, never endpoint sampling',()=>{const times=Array.from({length:190},(_,i)=>i*i/1000);const p=planStrip(request({intervals:[{id:'nine',basis:'single',frameStart:176,frameEnd:184}]}),{mode:'single',binding,reports:{single:parseReport({spec:'rig-pose-report/1',animation:'dance',frameTimes:times})}});expect(p.groups[0].samples).toEqual(times.slice(176,185).map((time,i)=>({requestedFrame:176+i,time})));});
test('missing or uniform clocks refuse PNG and retain null JSON times',()=>{for(const r of [null,parseReport({spec:'rig-pose-report/1',animation:'dance',frames:10,fps:24,frame0:0}),parseReport({spec:'rig-pose-report/1',animation:'dance',frameTimes:[]})]){expect(()=>planStrip(request(),{mode:'single',binding,reports:{single:r}})).toThrow(stripNoClock);expect(planStrip(request({format:'json'}),{mode:'single',binding,reports:{single:r}}).groups[0].samples.map(v=>v.time)).toEqual([null,null,null]);}});
test('compare B clock drives all source rows while A remains independent unknown',()=>{const paired:StripBinding={...binding,packages:[{...binding.packages[0],id:'a'},{...binding.packages[0],id:'b'}]};const p=planStrip(request({referenceId:undefined,intervals:[{id:'b',basis:'b',frameStart:1,frameEnd:2}]}),{mode:'compare',binding:paired,reports:{a:null,b:report}});expect(p.rows.map(v=>v.id)).toEqual(['reference','a','b']);expect(p.groups[0].samples.map(v=>v.time)).toEqual([.037,.19]);expect(()=>planStrip(request({referenceId:undefined,intervals:[{id:'a',basis:'a',frameStart:0,frameEnd:1}]}),{mode:'compare',binding:paired,reports:{a:null,b:report}})).toThrow(stripNoClock);});
test('overlapping feedback groups preserve own ids and interval membership',()=>{const p=planStrip(request({intervals:[{id:'first',feedbackId:'f1',basis:'single',frameStart:0,frameEnd:1},{id:'second',feedbackId:'f2',basis:'single',frameStart:1,frameEnd:2}]}),{mode:'single',binding,reports:{single:report}});expect(p.groups.map(g=>[g.feedbackId,g.samples.map(v=>v.requestedFrame)])).toEqual([['f1',[0,1]],['f2',[1,2]]]);});
test('request rejects malformed unsafe reversed oversized and path-bearing payloads',()=>{
 for(const interval of [{frameStart:-1,frameEnd:1},{frameStart:1.5,frameEnd:2},{frameStart:2,frameEnd:1},{frameStart:0,frameEnd:256},{frameStart:0,frameEnd:9007199254740992}])expect(()=>parseStripRequest({...request(),intervals:[{id:'x',basis:'single',...interval}]})).toThrow();
 for(const patch of [{output:'/tmp/arbitrary'},{format:'svg'},{sourceHash:'wrong'},{intervals:[]},{intervals:[{id:'a',basis:'both',frameStart:0,frameEnd:1}]}])expect(()=>parseStripRequest({...request(),...patch})).toThrow();
 expect(parseStripRequest(request())).toEqual(request());
});
test('wrong source identity, animation, basis and report range refuse by name',()=>{
 for(const [patch,expected] of [[{sourceHash:'0'.repeat(64)},'inputs changed'],[{animation:'other'},'animation'],[{intervals:[{id:'x',basis:'single',frameStart:0,frameEnd:4}]},'last frame'],[{intervals:[{id:'x',basis:'a',frameStart:0,frameEnd:1}]},'basis']] as const)expect(()=>planStrip({...request(),...patch} as StripRequest,{mode:'single',binding,reports:{single:report}})).toThrow(expected);
 expect(()=>planStrip(request(),{mode:'single',binding,reports:{single:parseReport({spec:'rig-pose-report/1',frameTimes:[0,1,2]})}})).toThrow('explicit report animation');
});

test('mixed compare batches identify the root as mixed and retain each own clock in either order',()=>{
 const paired:StripBinding={...binding,packages:[{...binding.packages[0],id:'a'},{...binding.packages[0],id:'b'}]};
 const reports={a:parseReport({spec:'rig-pose-report/1',animation:'dance',frameTimes:[0,.1,.7,1]}),b:report};
 const a={id:'a-note',feedbackId:'A',basis:'a' as const,frameStart:1,frameEnd:2},b={id:'b-note',feedbackId:'B',basis:'b' as const,frameStart:1,frameEnd:2};
 for(const intervals of [[a,b],[b,a]]){const plan=planStrip(request({referenceId:undefined,intervals}),{mode:'compare',binding:paired,reports});expect(plan.basis).toBe('mixed');expect(plan.groups.map(g=>g.basis)).toEqual(intervals.map(g=>g.basis));expect(Object.fromEntries(plan.groups.map(g=>[g.basis,g.samples.map(s=>s.time)]))).toEqual({a:[.1,.7],b:[.037,.19]});expect(plan.groups.map(g=>g.feedbackId)).toEqual(intervals.map(g=>g.feedbackId));}
 expect(planStrip(request({referenceId:undefined,intervals:[a,{...a,id:'a-next'}]}),{mode:'compare',binding:paired,reports}).basis).toBe('a');
 expect(planStrip(request({referenceId:undefined,intervals:[b]}),{mode:'compare',binding:paired,reports}).basis).toBe('b');
});
