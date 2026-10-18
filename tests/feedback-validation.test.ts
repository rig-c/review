import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReview } from '../src/manifest.ts';
import { feedbackLastFrame, feedbackTargetNames, validateFeedbackSelection, type FeedbackCatalog, type FeedbackSelection } from '../src/feedback-validation.ts';
import { freshSession, parseSession, readSession, saveSession, sessionFile } from '../src/session.ts';
import { loadCompare } from '../src/compare.ts';
import { compareSessionFile, freshCompareSession, parseCompareSession, readCompareSession, saveCompareSession } from '../src/compare-session.ts';
import { startServer } from '../src/server.ts';
import { startCompareServer } from '../src/compare-server.ts';

const dirs:string[]=[];
afterEach(async()=>{for(const root of dirs.splice(0))await rm(root,{recursive:true,force:true});});
async function directory(){const root=await mkdtemp(join(tmpdir(),'review-feedback-'));dirs.push(root);return root;}
// Model envelopes test metadata/HTTP boundaries, not the producer's compile gate.
async function fixture(side='a',options:{model?:boolean;clock?:boolean}={}){
 const root=await directory(),model={spec:'rigc-compiled/3',pages:[],bones:[{name:`bone_${side}`},{name:'constructor'},{name:'__proto__'}],slots:[{name:`slot_${side}`}],animations:[{name:'inspect',duration:0.9},{name:'other',duration:5}]};
 await mkdir(join(root,'build'));const modelBytes='\n'+JSON.stringify(model,null,2)+'\n';
 if(options.model!==false)await writeFile(join(root,'build/skeleton.model.json'),modelBytes);
 const manifest={schema:'rig-review/1',id:`rig-${side}`,title:`Rig ${side}`,revision:'one',...(options.model===false?{}:{model:'build/skeleton.model.json'}),authoring:[{label:'Report',path:'report.json'}]};
 await writeFile(join(root,'review.json'),JSON.stringify(manifest));
 await writeFile(join(root,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frames:5,duration:1.1,...(options.clock===false?{}:{frameTimes:[0.2,0.3,0.6,0.9,1.1]}),landings:[{bone:`bone_${side}`,frame:2}]}));
 return {root,path:join(root,'review.json'),modelBytes};
}
function note(side='a'){return {id:'note',frameStart:1,frameEnd:3,target:{kind:'bone' as const,name:`bone_${side}`},category:'defect' as const,summary:'Inspect contact',context:{animation:'inspect',time:0.6,frame:2}};}
async function comparison(){const a=await fixture('a'),b=await fixture('b'),reference=join(await directory(),'ref.mp4');await writeFile(reference,'reference transport bytes');return {a,b,p:await loadCompare({a:a.path,b:b.path,reference,animation:'inspect'})};}

test('catalog names, clip durations and reviewed model identity come from the exact model bytes',async()=>{
 const f=await fixture(),p=await loadReview(f.path);
 expect(p.feedbackCatalog).toEqual({rig:'rig-a',bones:['bone_a','constructor','__proto__'],slots:['slot_a'],animations:[{name:'inspect',duration:0.9},{name:'other',duration:5}],clock:{kind:'samples',frameTimes:[0.2,0.3,0.6,0.9,1.1]},clockAnimation:'inspect'});
 expect(p.reviewedSource.rig?.sha256).toBe(createHash('sha256').update(f.modelBytes).digest('hex'));
 expect(feedbackTargetNames(p.feedbackCatalog,'rig')).toEqual(['rig-a']);expect(feedbackLastFrame(p.feedbackCatalog,'inspect')).toBe(3);expect(feedbackLastFrame(p.feedbackCatalog,'other')).toBeNull();
 for(const name of ['constructor','__proto__'])expect(()=>validateFeedbackSelection(p.feedbackCatalog,{...note(),target:{kind:'bone',name},animation:'inspect'})).not.toThrow();
 const changed=JSON.parse(f.modelBytes);changed.bones[0].name='different';await writeFile(join(f.root,'build/skeleton.model.json'),JSON.stringify(changed));const next=await loadReview(f.path);expect(next.feedbackCatalog.bones).toContain('different');expect(next.reviewedSource.rig?.sha256).not.toBe(p.reviewedSource.rig?.sha256);expect(next.sourceHash).not.toBe(p.sourceHash);
});

test('new saves refuse wrong names, unavailable metadata, empty catalogs and forged target kinds',async()=>{
 const f=await fixture(),p=await loadReview(f.path),base=freshSession(p);
 for(const target of [{kind:'slot',name:'no_such_slot'},{kind:'bone',name:'missing'},{kind:'rig',name:'foreign'},{kind:'constructor',name:'bone_a'}])expect(()=>parseSession({...base,feedback:[{...note(),frameStart:5000,frameEnd:9000,target}]},p)).toThrow(target.kind==='constructor'?'feedback.target.kind':'feedback.target.name');
 expect(()=>validateFeedbackSelection(p.feedbackCatalog,{...note(),animation:'inspect',target:null} as unknown as FeedbackSelection)).toThrow('feedback.target.kind');
 const source=await fixture('source',{model:false}),raw=await loadReview(source.path);
 expect(raw.feedbackCatalog.bones).toBeNull();expect(raw.feedbackCatalog.slots).toBeNull();
 expect(()=>parseSession({...freshSession(raw),feedback:[{...note(),target:{kind:'bone',name:'bone_a'}}]},raw)).toThrow('validation unavailable');
 expect(()=>parseSession({...freshSession(raw),feedback:[{...note(),target:{kind:'rig',name:'rig-source'}}]},raw)).not.toThrow();
 await writeFile(join(f.root,'build/skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[],slots:[],animations:[]}));const empty=await loadReview(f.path);expect(empty.feedbackCatalog.bones).toEqual([]);expect(()=>parseSession({...freshSession(empty),feedback:[note()]},empty)).toThrow('not in model');
});

test('known bounds use only the selected clip intersection while unknown clocks keep manual ranges',async()=>{
 const f=await fixture(),p=await loadReview(f.path),base=freshSession(p);
 expect(()=>parseSession({...base,feedback:[{...note(),frameEnd:4}]},p)).toThrow('feedback.frameEnd: 4 beyond clip last frame 3');
 expect(()=>parseSession({...base,feedback:[{...note(),frameEnd:9000,context:{animation:'other'}}]},p)).not.toThrow();
 expect(()=>parseSession({...base,feedback:[{...note(),context:{animation:'missing'}}]},p)).toThrow('feedback.context.animation');
 expect(()=>parseSession({...base,feedback:[{...note(),context:{time:0.6}}]},p)).toThrow('animation: required');
 const unknown=await fixture('u',{clock:false}),u=await loadReview(unknown.path);expect(feedbackLastFrame(u.feedbackCatalog,'inspect')).toBeNull();expect(()=>parseSession({...freshSession(u),feedback:[{...note('u'),frameStart:5000,frameEnd:9000}]},u)).not.toThrow();
 const catalog:FeedbackCatalog={...p.feedbackCatalog,clock:{kind:'uniform',fps:10,frame0:2,frameCount:4},animations:[{name:'inspect',duration:2.3}]};expect(feedbackLastFrame(catalog,'inspect')).toBe(3);catalog.animations![0]!.duration=1;expect(feedbackLastFrame(catalog,'inspect')).toBe(-1);expect(()=>validateFeedbackSelection(catalog,{...note(),frameStart:0,frameEnd:0,animation:'inspect'})).toThrow('last frame -1');
});

test('safe inclusive intervals reject malformed values without using inspection playhead as the annotation',async()=>{
 const f=await fixture(),p=await loadReview(f.path),base=freshSession(p);
 for(const interval of [[-1,1],[1,0],[0.5,1],[0,Number.MAX_SAFE_INTEGER+1],[NaN,1],[0,Infinity]])expect(()=>parseSession({...base,feedback:[{...note(),frameStart:interval[0],frameEnd:interval[1]}]},p)).toThrow('feedback frames');
 const saved=parseSession({...base,feedback:[{...note(),frameStart:0,frameEnd:1,context:{animation:'inspect',time:0.9,frame:3}}]},p);expect(saved.feedback[0]?.context).toEqual({animation:'inspect',time:0.9,frame:3,interval:{frameStart:0,frameEnd:1,inclusive:true}});
 expect(()=>parseSession({...base,feedback:[{...note(),context:{animation:'inspect',frame:2,interval:{frameStart:2,frameEnd:2,inclusive:true}}}]},p)).toThrow('feedback.context.interval');
 expect(()=>parseSession({...base,feedback:[{...note(),context:{animation:7}}]},p)).toThrow('feedback.context.animation');
});

test('legacy invalid names remain readable with warnings, immutable identity and unchanged saved evidence',async()=>{
 const f=await fixture(),p=await loadReview(f.path),state=await directory(),file=sessionFile(p,state),old={...freshSession(p),status:'changes-requested',feedback:[{...note(),target:{kind:'slot',name:'no_such_slot'}}],updatedAt:'2026-01-01T00:00:00.000Z'};delete (old as {feedbackWarnings?:unknown}).feedbackWarnings;const bytes=JSON.stringify(old,null,2);await writeFile(file,bytes);
 const loaded=await readSession(p,state);expect(loaded.feedback[0]?.target.name).toBe('no_such_slot');expect(loaded.feedbackWarnings).toEqual([{id:'note',error:'feedback.target.name: slot "no_such_slot" not in model'}]);expect(loaded.reviewedSource).toEqual(p.reviewedSource);expect(loaded.updatedAt).toBe(old.updatedAt);expect(await readFile(file,'utf8')).toBe(bytes);
 await expect(saveSession(p,{...loaded,feedbackWarnings:[]},state)).rejects.toThrow('feedback.target.name');expect(await readFile(file,'utf8')).toBe(bytes);
 const fixed=await saveSession(p,{...loaded,feedback:[note()]},state);expect(fixed.feedbackWarnings).toEqual([]);expect(fixed.feedback[0]?.context).toMatchObject({interval:{frameStart:1,frameEnd:3,inclusive:true}});
 const contradictory={...old,feedback:[{...note(),context:{animation:'inspect',interval:{frameStart:3,frameEnd:3,inclusive:true}}}]};await writeFile(file,JSON.stringify(contradictory));const preserved=await readSession(p,state);expect(preserved.feedback[0]?.context).toEqual(contradictory.feedback[0]!.context);expect(preserved.feedbackWarnings[0]?.error).toContain('context.interval');
 await expect(readSession({...p,reviewedSource:{...p.reviewedSource,rig:null}},state)).resolves.toMatchObject({status:'pending'});
});

test('comparison validates each selected side and cannot use a different side or animation to bypass bounds',async()=>{
 const {p}=await comparison(),base=freshCompareSession(p);
 const valid=[{...note('a'),id:'a',side:'a'},{...note('b'),id:'b',side:'b'}];const saved=parseCompareSession({...base,feedback:valid},p);expect(saved.feedback.map(row=>row.side)).toEqual(['a','b']);expect(saved.binding).toEqual(p.response.binding);
 for(const side of ['a','b']){expect(()=>parseCompareSession({...base,feedback:[{...note(side==='a'?'b':'a'),side}]},p)).toThrow('feedback.target.name');expect(()=>parseCompareSession({...base,feedback:[{...note(side),side,frameEnd:4}]},p)).toThrow('feedback.frameEnd');expect(()=>parseCompareSession({...base,feedback:[{...note(side),side,context:{animation:'other'}}]},p)).toThrow('selected comparison animation');}
 for(const side of [undefined,'both','constructor','__proto__'])expect(()=>parseCompareSession({...base,feedback:[{...note(),side}]},p)).toThrow('feedback.side');
 expect(()=>parseCompareSession({...base,feedback:[valid[0],{...valid[1],target:{kind:'slot',name:'slot_a'}}]},p)).toThrow('feedback.target.name');
 expect(()=>parseCompareSession({...base,binding:{...base.binding,b:{...base.binding.b,reviewedSource:{...base.binding.b.reviewedSource,rig:null}}},feedback:valid},p)).toThrow('session.binding');
});

test('legacy comparison preserves invalid selected-side rows and both reviewed-source identities',async()=>{
 const {p}=await comparison(),state=await directory(),file=compareSessionFile(p,state),legacy={...freshCompareSession(p),feedback:[{...note('a'),side:'b'}],updatedAt:'original'};const bytes=JSON.stringify(legacy);await writeFile(file,bytes);const read=await readCompareSession(p,state);expect(read.feedback[0]?.side).toBe('b');expect(read.feedback[0]?.target.name).toBe('bone_a');expect(read.feedbackWarnings[0]?.error).toContain('not in model');expect(read.binding).toEqual(p.response.binding);expect(await readFile(file,'utf8')).toBe(bytes);await expect(saveCompareSession(p,{...read,feedbackWarnings:[]},state)).rejects.toThrow('feedback.target.name');expect(await readFile(file,'utf8')).toBe(bytes);
 const repaired=await saveCompareSession(p,{...read,feedback:[{...note('b'),side:'b'}]},state);expect(repaired.feedbackWarnings).toEqual([]);expect(repaired.feedback[0]?.context).toMatchObject({interval:{frameStart:1,frameEnd:3,inclusive:true}});
});

test('single HTTP reproduces the wrong-slot refusal and persists chosen interval independently of playhead',async()=>{
 const f=await fixture(),p=await loadReview(f.path),state=await directory(),server=await startServer(p,{port:0,stateDir:state});try{
  const base=`http://127.0.0.1:${server.port}`,headers={Origin:base,'Content-Type':'application/json'};const response=await fetch(base+'/api/review');expect((await response.json()).feedbackCatalog).toEqual(p.feedbackCatalog);
  const put=(feedback:unknown[])=>fetch(base+'/api/session',{method:'PUT',headers,body:JSON.stringify({...freshSession(p),feedback})});
  await writeFile(sessionFile(p,state),JSON.stringify({...freshSession(p),feedback:[{...note(),target:{kind:'slot',name:'old_missing'}}],updatedAt:'legacy'}));
  const legacyResponse=await fetch(base+'/api/session');expect(legacyResponse.status).toBe(200);const legacy=await legacyResponse.json();expect(legacy.feedback[0].target.name).toBe('old_missing');expect(legacy.feedbackWarnings[0].id).toBe('note');expect(legacy.reviewedSource).toEqual(p.reviewedSource);
  expect((await fetch(base+'/api/session',{method:'PUT',headers,body:JSON.stringify({...legacy,feedbackWarnings:[]})})).status).toBe(400);
  let result=await put([{...note(),target:{kind:'slot',name:'no_such_slot'},frameStart:5000,frameEnd:9000}]);expect(result.status).toBe(400);expect((await result.json()).error).toBe('feedback.target.name: slot "no_such_slot" not in model');
  result=await put([{...note(),frameEnd:4}]);expect(result.status).toBe(400);expect((await result.json()).error).toContain('feedback.frameEnd');
  result=await put([{...note(),frameStart:0,frameEnd:1,context:{animation:'inspect',time:0.9,frame:3}}]);expect(result.status).toBe(200);const body=await result.json();expect(body.feedback[0].context).toEqual({animation:'inspect',time:0.9,frame:3,interval:{frameStart:0,frameEnd:1,inclusive:true}});expect(body.reviewedSource).toEqual(p.reviewedSource);
  await writeFile(join(f.root,'build/skeleton.model.json'),f.modelBytes+' ');expect((await put([note()])).status).toBe(409);
 }finally{await server.stop(true);}
});

test('compare HTTP exposes separate catalogs and refuses wrong-side names before saving',async()=>{
 const {p}=await comparison(),state=await directory(),server=await startCompareServer(p,{port:0,stateDir:state});try{
  const base=`http://127.0.0.1:${server.port}`,headers={Origin:base,'Content-Type':'application/json'};const data=await(await fetch(base+'/api/compare')).json();expect(data.a.feedbackCatalog.bones).toContain('bone_a');expect(data.b.feedbackCatalog.bones).toContain('bone_b');
  const put=(feedback:unknown[])=>fetch(base+'/api/compare/session',{method:'PUT',headers,body:JSON.stringify({...freshCompareSession(p),feedback})});
  const denied=await put([{...note('a'),side:'b'}]);expect(denied.status).toBe(400);expect((await denied.json()).error).toContain('feedback.target.name');const accepted=await put([{...note('b'),side:'b',context:{time:0.2,frame:0}}]);expect(accepted.status).toBe(200);const saved=await accepted.json();expect(saved.feedback[0].context).toEqual({time:0.2,frame:0,animation:'inspect',interval:{frameStart:1,frameEnd:3,inclusive:true}});expect(saved.binding).toEqual(p.response.binding);
 }finally{await server.stop(true);}
});


test('legacy unsafe integers stay readable with named warnings but both HTTP save paths refuse them',async()=>{
 const f=await fixture(),single=await loadReview(f.path),pair=await comparison(),singleState=await directory(),pairState=await directory(),unsafe=9007199254740992;
 const singleLegacy={...freshSession(single),feedback:[{...note(),frameStart:unsafe,frameEnd:unsafe}],updatedAt:'old-single'};
 const pairLegacy={...freshCompareSession(pair.p),feedback:[{...note('b'),side:'b',frameStart:unsafe,frameEnd:unsafe}],updatedAt:'old-compare'};
 const singleBytes=JSON.stringify(singleLegacy),pairBytes=JSON.stringify(pairLegacy),singleFile=sessionFile(single,singleState),pairFile=compareSessionFile(pair.p,pairState);await writeFile(singleFile,singleBytes);await writeFile(pairFile,pairBytes);
 const singleServer=await startServer(single,{port:0,stateDir:singleState}),pairServer=await startCompareServer(pair.p,{port:0,stateDir:pairState});try{
  for(const [server,path,bytes,file] of [[singleServer,'/api/session',singleBytes,singleFile],[pairServer,'/api/compare/session',pairBytes,pairFile]] as const){
   const base=`http://127.0.0.1:${server.port}`,response=await fetch(base+path);expect(response.status).toBe(200);const old=await response.json();expect(old.feedback[0].frameStart).toBe(unsafe);expect(old.feedbackWarnings).toHaveLength(1);expect(old.feedbackWarnings[0].error).toContain('feedback frames');expect(await readFile(file,'utf8')).toBe(bytes);
   const denied=await fetch(base+path,{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({...old,feedbackWarnings:[]})});expect(denied.status).toBe(400);expect((await denied.json()).error).toContain('feedback frames');expect(await readFile(file,'utf8')).toBe(bytes);
  }
 }finally{await singleServer.stop(true);await pairServer.stop(true);}
});
