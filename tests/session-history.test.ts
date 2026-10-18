import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadReview, type ReviewPackage } from '../src/manifest.ts';
import { freshSession, parseSession, readSession, saveSession, sessionFile, type ReviewSession } from '../src/session.ts';
import { loadCompare, type ComparePackage } from '../src/compare.ts';
import { compareSessionFile, freshCompareSession, parseCompareSession, readCompareSession, type CompareSession } from '../src/compare-session.ts';
import { readFeedbackSession, readFeedbackCompareSession, preferCurrentSession } from '../src/session-history.ts';

const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function directory(){const root=await mkdtemp(join(tmpdir(),'review-history-'));dirs.push(root);return root;}
// Metadata-only envelopes; no runtime rendering/gate claim is made here.
async function fixture(id='probe'){
 const root=await directory(),path=join(root,'review.json');
 const manifest={schema:'rig-review/1',id,title:id,revision:'one',model:'skeleton.model.json',motion:'motion.json'};
 await writeFile(path,JSON.stringify(manifest));await writeFile(join(root,'motion.json'),'unchanged motion');
 await writeFile(join(root,'skeleton.model.json'),JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[{name:'root'}],slots:[{name:'cloth'}],animations:[{name:'inspect',duration:2},{name:'other',duration:2}]}));
 return {root,path,manifest,p:await loadReview(path)};
}
function older(p:ReviewPackage,viewer='0.0.0',runtime='1.0.0'):ReviewPackage{return {...p,reviewedSource:{...p.reviewedSource,viewerVersion:viewer,runtimeVersion:runtime}};}
function feedback(p:ReviewPackage){return {id:'note',frameStart:1,frameEnd:2,target:{kind:'rig' as const,name:p.manifest.id},category:'quality' as const,summary:'Previously inspected',context:{time:0.5,frame:null}};}
async function single(p:ReviewPackage,state:string,updatedAt='2026-01-01T00:00:00.000Z',status:ReviewSession['status']='approved'){
 const value={...freshSession(p),status,feedback:[feedback(p)],updatedAt},file=sessionFile(p,state);await writeFile(file,JSON.stringify(value));return {value,file};
}
async function pair(){const a=await fixture('a'),b=await fixture('b'),reference=join(await directory(),'ref.mp4');await writeFile(reference,'reference bytes');const inputs={a:a.path,b:b.path,reference,animation:'inspect'};return {a,b,inputs,p:await loadCompare(inputs)};}
function oldPair(p:ComparePackage):ComparePackage{
 const a=older(p.a),b=older(p.b),binding={a:{sourceHash:a.sourceHash,reviewedSource:a.reviewedSource},b:{sourceHash:b.sourceHash,reviewedSource:b.reviewedSource},reference:p.response.binding.reference,animation:p.response.animation};
 const sourceHash=createHash('sha256').update(JSON.stringify(binding)).digest('hex');return {...p,a,b,response:{...p.response,sourceHash,id:'compare-'+sourceHash.slice(0,16),binding}};
}
async function compared(p:ComparePackage,state:string,updatedAt='2026-01-01T00:00:00.000Z',status:CompareSession['status']='approved'){
 const value={...freshCompareSession(p),status,feedback:[{...feedback(p.a),side:'a' as const,context:{animation:'inspect',time:0.5}}],updatedAt},file=compareSessionFile(p,state);await writeFile(file,JSON.stringify(value));return {value,file};
}

test('runtime/viewer upgrades retrieve the actual prior record and original timestamp without migrating approval',async()=>{
 for(const change of ['runtime','viewer','both']){
  const {p}=await fixture(),state=await directory(),old=older(p,change==='runtime'?p.reviewedSource.viewerVersion:'0.0.0',change==='viewer'?p.reviewedSource.runtimeVersion:'1.0.0');const saved=await single(old,state),before=await readFile(saved.file,'utf8');
  const read=await readFeedbackSession(p,state);expect(read.status).toBe('approved');expect(read.updatedAt).toBe(saved.value.updatedAt);expect(read.feedback[0]?.summary).toBe('Previously inspected');expect(read.reviewedSource).toEqual(old.reviewedSource);expect(read.retrieval).toEqual({kind:'prior-tools',toolsChangedSince:true,matchingSubmissions:1,currentTools:{viewerVersion:p.reviewedSource.viewerVersion,runtimeVersion:p.reviewedSource.runtimeVersion}});expect(await readFeedbackSession(p,state)).toEqual(read);expect(await readFile(saved.file,'utf8')).toBe(before);expect(await Bun.file(sessionFile(p,state)).exists()).toBe(false);
  expect(await readSession(p,state)).toMatchObject({status:'pending',updatedAt:null});await expect(saveSession(p,read,state)).rejects.toThrow('reviewedSource');
 }
});

test('an exact current saved pending review wins and a corrupt current record does not fall back',async()=>{
 const {p}=await fixture(),state=await directory();await single(older(p),state,'2030-01-01T00:00:00.000Z');const current=await single(p,state,'2025-01-01T00:00:00.000Z','pending');
 const read=await readFeedbackSession(p,state);expect(read.status).toBe('pending');expect(read.updatedAt).toBe(current.value.updatedAt);expect(read.retrieval).toBeUndefined();
 await writeFile(current.file,'broken JSON');await expect(readFeedbackSession(p,state)).rejects.toThrow();
});

test('latest saved record wins irrespective of status; timestamp ties are deterministic',async()=>{
 const {p}=await fixture(),state=await directory();await single(older(p,'0.0.1'),state,'2025-01-01T00:00:00.000Z','approved');const recent=await single(older(p,'0.0.2'),state,'2026-01-01T00:00:00.000Z','changes-requested');expect((await readFeedbackSession(p,state)).status).toBe('changes-requested');
 const tie=await single(older(p,'0.0.3'),state,'2026-01-01T00:00:00.000Z','pending');const first=await readFeedbackSession(p,state);expect(first.updatedAt).toBe(recent.value.updatedAt);expect(first.retrieval?.matchingSubmissions).toBe(3);
 const bytes=await readFile(recent.file,'utf8');await rm(recent.file);await writeFile(recent.file,bytes);expect(await readFeedbackSession(p,state)).toEqual(first);expect(first.reviewedSource.viewerVersion).toBe([recent,tie].sort((a,b)=>a.file<b.file?-1:1)[0]!.value.reviewedSource.viewerVersion);
});

test('single content/revision/rig/motion identities cannot borrow an older review',async()=>{
 const f=await fixture(),state=await directory();await single(older(f.p),state);
 for(const p of [{...f.p,sourceHash:'changed'},{...f.p,manifest:{...f.p.manifest,revision:'two'}},{...f.p,reviewedSource:{...f.p.reviewedSource,packageRevision:'two'}},{...f.p,reviewedSource:{...f.p.reviewedSource,rig:null}},{...f.p,reviewedSource:{...f.p.reviewedSource,motion:null}},{...f.p,reviewedSource:{...f.p.reviewedSource,rig:{...f.p.reviewedSource.rig!,sha256:'changed'}}},{...f.p,reviewedSource:{...f.p.reviewedSource,motion:{...f.p.reviewedSource.motion!,path:'other.json'}}}])expect(await readFeedbackSession(p,state)).toMatchObject({status:'pending',updatedAt:null});
 await writeFile(join(f.root,'motion.json'),'changed bytes');expect(await readFeedbackSession(await loadReview(f.path),state)).toMatchObject({status:'pending',updatedAt:null});
});

test('historical comparison validates its own version-dependent binding/hash/id/filename',async()=>{
 const {p}=await pair(),state=await directory(),old=oldPair(p);expect(old.response.id).not.toBe(p.response.id);expect(old.response.sourceHash).not.toBe(p.response.sourceHash);const saved=await compared(old,state),bytes=await readFile(saved.file,'utf8');
 const read=await readFeedbackCompareSession(p,state);expect(read.id).toBe(old.response.id);expect(read.sourceHash).toBe(old.response.sourceHash);expect(read.binding).toEqual(old.response.binding);expect(read.updatedAt).toBe(saved.value.updatedAt);expect(read.retrieval?.kind).toBe('prior-tools');expect(await readFile(saved.file,'utf8')).toBe(bytes);expect((await readCompareSession(p,state)).status).toBe('pending');expect(()=>parseCompareSession(read,p)).toThrow('session.id');
 for(const corrupt of [{...saved.value,id:'compare-forged'},{...saved.value,sourceHash:'forged'},{...saved.value,binding:{...saved.value.binding,extra:true}}]){await writeFile(saved.file,JSON.stringify(corrupt));await expect(readFeedbackCompareSession(p,state)).rejects.toThrow();}
 await writeFile(saved.file,bytes);const renamed=join(state,'a'.repeat(64)+'.json');await rename(saved.file,renamed);await expect(readFeedbackCompareSession(p,state)).rejects.toThrow('filename');
});

test('either comparison side, order, reference or animation content change returns fresh pending',async()=>{
 for(const change of ['a-model','b-motion','order','reference','reference-name','animation','revision']){
  const f=await pair(),state=await directory();await compared(oldPair(f.p),state);let inputs={...f.inputs};
  if(change==='a-model')await writeFile(join(f.a.root,'skeleton.model.json'),await readFile(join(f.a.root,'skeleton.model.json'),'utf8')+' ');
  if(change==='b-motion')await writeFile(join(f.b.root,'motion.json'),'new motion');
  if(change==='order')inputs={...inputs,a:f.inputs.b,b:f.inputs.a};
  if(change==='reference')await writeFile(f.inputs.reference,'new reference');
  if(change==='reference-name'){inputs.reference=join(await directory(),'other.mp4');await writeFile(inputs.reference,'reference bytes');}
  if(change==='animation')inputs.animation='other';
  if(change==='revision')await writeFile(f.a.path,JSON.stringify({...f.a.manifest,revision:'two'}));
  const read=await readFeedbackCompareSession(await loadCompare(inputs),state);expect(read.status).toBe('pending');expect(read.updatedAt).toBeNull();expect(read.retrieval).toBeUndefined();
 }
 const f=await pair(),state=await directory(),old=oldPair(f.p);const row=await compared(old,state);await writeFile(row.file,JSON.stringify({...row.value,binding:{...row.value.binding,a:{...row.value.binding.a,reviewedSource:{...row.value.binding.a.reviewedSource,rig:null}}}}));expect((await readFeedbackCompareSession(f.p,state)).retrieval).toBeUndefined();
});

test('legacy invalid evidence and original timestamps survive with warnings; null/invalid submission times refuse',async()=>{
 const {p}=await fixture(),state=await directory(),old=older(p),row=await single(old,state);const invalid={...row.value,feedbackWarnings:[],feedback:[{...feedback(old),frameStart:9007199254740992,frameEnd:9007199254740992,target:{kind:'slot',name:'unknown'},context:{interval:{frameStart:0,frameEnd:0,inclusive:true}}}]};const bytes=JSON.stringify(invalid);await writeFile(row.file,bytes);const read=await readFeedbackSession(p,state);expect(read.feedback[0]?.frameStart).toBe(9007199254740992);expect(read.feedbackWarnings).toHaveLength(1);expect(read.feedback[0]?.context).toEqual(invalid.feedback[0]!.context);expect(read.updatedAt).toBe(row.value.updatedAt);expect(await readFile(row.file,'utf8')).toBe(bytes);
 for(const updatedAt of [null,'tomorrow','2026-02-30T00:00:00.000Z']){await writeFile(row.file,JSON.stringify({...row.value,updatedAt}));await expect(readFeedbackSession(p,state)).rejects.toThrow('history.updatedAt');}
 const f=await pair(),compareState=await directory(),olderPair=oldPair(f.p),saved=await compared(olderPair,compareState);await writeFile(saved.file,JSON.stringify({...saved.value,feedback:[{...saved.value.feedback[0],target:{kind:'slot',name:'unknown'}}]}));expect((await readFeedbackCompareSession(f.p,compareState)).feedbackWarnings[0]?.error).toContain('target.name');
});

test('historical discovery is bounded/no-follow and missing or unrelated state stays fresh',async()=>{
 const {p}=await fixture(),state=await directory(),outside=join(await directory(),'outside.json');await writeFile(outside,'SECRET');await symlink(outside,join(state,'a'.repeat(64)+'.json'));await mkdir(join(state,'b'.repeat(64)+'.json'));const oversized=join(state,'c'.repeat(64)+'.json');await writeFile(oversized,'');await truncate(oversized,32*1024*1024+1);await writeFile(join(state,'d'.repeat(64)+'.json'),'broken');
 const read=await readFeedbackSession(p,state);expect(read.status).toBe('pending');expect(read.retrieval).toBeUndefined();expect(read.historyWarnings).toHaveLength(4);expect(JSON.stringify(read)).not.toContain('SECRET');expect(await readFile(outside,'utf8')).toBe('SECRET');
 expect(await readFeedbackSession(p,join(await directory(),'missing'))).toMatchObject({status:'pending',updatedAt:null});const unrelated=await fixture('unrelated');await single(older(unrelated.p),state);expect((await readFeedbackSession(p,state)).retrieval).toBeUndefined();
 const old=older(p),record=await single(old,state);await rename(record.file,join(state,'e'.repeat(64)+'.json'));await expect(readFeedbackSession(p,state)).rejects.toThrow('filename');
});

test('actual feedback CLI branches retrieve recorded single and compare versions in isolated state',async()=>{
 const f=await fixture(),state=await directory(),old=older(f.p);await single(old,state);const pairFixture=await pair(),pairState=await directory(),oldComparison=oldPair(pairFixture.p);await compared(oldComparison,pairState);
 for(const [args,stateDir,expected] of [[['feedback',f.path],state,old.reviewedSource.runtimeVersion],[['feedback','compare',pairFixture.inputs.a,pairFixture.inputs.b,'--reference',pairFixture.inputs.reference,'--animation','inspect'],pairState,oldComparison.a.reviewedSource.runtimeVersion]] as const){
  const code=`import {main} from ${JSON.stringify(join(import.meta.dir,'../src/cli.ts'))};await main(${JSON.stringify(args)},{stateDir:${JSON.stringify(stateDir)}});`;const process=Bun.spawn([Bun.which('bun')!,'--eval',code],{stdout:'pipe',stderr:'pipe'});const [stdout,stderr,status]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited]);expect(stderr).toBe('');expect(status).toBe(0);const read=JSON.parse(stdout);expect(read.status).toBe('approved');expect(read.retrieval.kind).toBe('prior-tools');expect(read.reviewedSource?.runtimeVersion??read.binding.a.reviewedSource.runtimeVersion).toBe(expected);
 }
});

test('aggregate historical reads stop at their byte budget and unreadable-file diagnostic limit',async()=>{
 const {p}=await fixture(),large=await directory();for(let i=0;i<3;i++){const file=join(large,i.toString(16).padStart(64,'0')+'.json');await writeFile(file,'');await truncate(file,22*1024*1024);}
 await expect(readFeedbackSession(p,large)).rejects.toThrow('64 MiB search limit');
 const malformed=await directory();for(let i=0;i<101;i++)await writeFile(join(malformed,i.toString(16).padStart(64,'0')+'.json'),'broken');await expect(readFeedbackSession(p,malformed)).rejects.toThrow('more than 100 unreadable');
});


test('a current pending save created during discovery wins even with a null timestamp',async()=>{
 for(const updatedAt of [null,'2026-02-01T00:00:00.000Z']){
  const {p}=await fixture(),state=await directory(),file=sessionFile(p,state),pending={...freshSession(p),status:'pending' as const,updatedAt};const historical={...freshSession(older(p)),status:'approved' as const,updatedAt:'2030-01-01T00:00:00.000Z'};let reads=0;
  const readCurrent=async()=>{reads++;try{const value=JSON.parse(await readFile(file,'utf8'));return {...parseSession(value,p,false),updatedAt:value.updatedAt as string|null};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  const read=await preferCurrentSession(readCurrent,async()=>{await writeFile(file,JSON.stringify(pending));return historical;});expect(reads).toBe(2);expect(read.status).toBe('pending');expect(read.updatedAt).toBe(updatedAt);expect(read.reviewedSource).toEqual(p.reviewedSource);expect(read).not.toHaveProperty('retrieval');
 }
});


test('a current save also wins if historical discovery concurrently fails',async()=>{
 const {p}=await fixture(),state=await directory(),file=sessionFile(p,state),pending={...freshSession(p),updatedAt:null};
 const current=async()=>{try{const value=JSON.parse(await readFile(file,'utf8'));return {...parseSession(value,p,false),updatedAt:value.updatedAt as string|null};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
 const read=await preferCurrentSession(current,async()=>{await writeFile(file,JSON.stringify(pending));throw new Error('historical corruption');});expect(read.status).toBe('pending');expect(read.reviewedSource).toEqual(p.reviewedSource);
});
