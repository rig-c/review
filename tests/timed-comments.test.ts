import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {turnPackage} from './helpers/turn-pad.ts';
import {loadReview} from '../src/manifest.ts';
import {loadReferencedReview,referenceBinding} from '../src/reference.ts';
import {freshSession,parseFeedback,validatePackageFeedback,saveSession,readSession} from '../src/session.ts';
import {parseStageComment} from '../src/stage-comment.ts';
import {timeOnlyBasis} from '../src/stage-comment.ts';
import {frameAtTime} from '../src/frame-clock.ts';
import {recoverSession} from '../web/inspection-persistence.ts';
const reason='frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
const clone=(v:any)=>JSON.parse(JSON.stringify(v));
test('actual single pose adapter exposes seconds/null-frame evidence on both clockless viewports',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),body=source.slice(source.indexOf('function setupComments():void'));
 const compiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(body);let host:any;
 const camera={space:'world',center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}},turn={schema:'rig-review-turn/1',values:{yaw:7.25},held:true,smoothing:20};
 let workspaceMode='playback';const pane={clientWidth:100,clientHeight:100,parentElement:{}},scope:any={comments:null,view:'compare',document:{querySelector:(selector:string)=>{expect(selector).toBe('[data-mode][aria-pressed="true"]');return {dataset:{mode:workspaceMode}};}},layers:{images:true},inspectionBookmark:()=>({}),bindStageComments:(h:any)=>{host=h;return {};},el:()=>pane,select:()=>({value:'source'}),numericView:()=>({cameras:{rig:camera,reference:{...camera,space:'image'}}}),player:{time:.531,renderer:{meshBackendActive:'canvas2d'}},time:0,frameAtTime,activeFrameClock:()=>null,timeOnlyBasis,data:{sourceHash:'a'.repeat(64),referenceHashes:{source:'b'.repeat(64)},manifest:{id:'actual-rig'}},CanvasRenderer:class{},stageModelHash:'c'.repeat(64),animation:'inspect',turnPad:{snapshot:()=>turn},video:{},parts:{frame:()=>({order:[]})},assets:{}};
 new Function('scope',`with(scope){${compiled};setupComments();}`)(scope);
 for(const view of ['rig','reference']){const pose=host.pose(view);expect(pose.mode).toBe('animate');expect(pose.frame).toBeNull();expect(pose.timeBasis).toEqual(timeOnlyBasis);expect(pose.time).toBe(.531);expect(pose.turn).toEqual(turn);expect(pose.sourceHash).toBe('a'.repeat(64));if(view==='reference')expect(pose.referenceHash).toBe('b'.repeat(64));}
 workspaceMode='rig';expect(host.pose('rig').mode).toBe('setup');expect(scope.view).toBe('compare');
});
function timed(p:any,reference=false):any{
 const id=reference?referenceBinding(p)!.reference.id:null,sha=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex');
 const camera={space:reference?'image':'world',center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:reference?0:-50,y:reference?0:-50,width:100,height:100}};
 const turn={schema:'rig-review-turn/1',values:{yaw:7.25,pitch:0,body:0},held:true,smoothing:20};
 const comment={schema:'rig-review-comment/1',mode:'animate',viewport:reference?'reference':'rig',frame:null,timeBasis:{schema:'rig-review-time-only/1',basis:'seconds',reason},time:.25,animation:'inspect',sourceHash:p.sourceHash,modelHash:reference?null:p.reviewedSource.rig.sha256,referenceId:id,referenceHash:id?referenceBinding(p)!.reference.sha256:null,camera,screen:{x:50,y:50,width:0,height:0},world:{x:reference?50:0,y:reference?50:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:{schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:p.sourceHash,rigs:[p.reviewedSource.rig.sha256]},time:.25,animation:'inspect',theme:'light',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:reference?null:camera,a:null,b:null,reference:reference?camera:null}},selection:{inspector:'playback',turn,...(id?{reference:id}:{})}}};
 return {id:reference?'video-time':'rig-time',frameStart:null,frameEnd:null,target:{kind:'rig',name:p.manifest.id},category:'defect',summary:'Timed opaque detail',context:{time:.25,frame:null,animation:'inspect',interval:null,turn,comment}};
}
async function fixture(fn:(p:any,root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'timed-comment-'));try{const source=await turnPackage(join(root,'package'));await writeFile(join(source,'source.webm'),'inert local reference bytes');const p=await loadReferencedReview(source,join(source,'source.webm'));await fn(p,root);}finally{await rm(root,{recursive:true,force:true});}}
test('clockless single rig/reference time-only comments keep null frame and interval through validation, drafts and immutable submission',()=>fixture(async(p,root)=>{
 expect(p.feedbackCatalog.clock).toBeNull();
 for(const reference of [false,true]){const f=timed(p,reference),state=join(root,reference?'video-state':'rig-state'),baseline=freshSession(p);
  expect(parseStageComment(f.context.comment).frame).toBeNull();expect(parseFeedback(f)).toEqual(f);expect(validatePackageFeedback(f,p)).toEqual(f);
  expect(recoverSession({...baseline,feedback:[f]},baseline)?.feedback[0]).toEqual(f);
  const saved=await saveSession(p,{...baseline,feedback:[f]},state),read=await readSession(p,state);expect(read.feedback[0]).toEqual(f);expect(read.feedbackWarnings).toEqual([]);expect(saved.feedback[0]!.frameStart).toBeNull();
  await expect(saveSession(p,{...saved,feedback:[]},state)).rejects.toThrow('COMMENT_SUBMITTED');
 }
}));
test('null ordinary frames and false numeric timed intervals cannot smuggle invented frames or invalid seconds',()=>fixture(async(p)=>{
 const f=timed(p);
 for(const mode of [undefined,'future']){const forged=clone(f);if(mode===undefined)delete forged.context.comment.mode;else forged.context.comment.mode=mode;expect(()=>parseFeedback(forged)).toThrow(mode===undefined?'COMMENT_MODE_MISSING':'COMMENT_MODE_UNKNOWN');expect(recoverSession({...freshSession(p),feedback:[forged]},freshSession(p))).toBeNull();}
 expect(()=>parseFeedback({...f,context:undefined})).toThrow();expect(()=>parseFeedback({...f,frameStart:0})).toThrow();
 for(const edit of [
  (r:any)=>{r.frameStart=0;r.frameEnd=0;r.context.interval={frameStart:0,frameEnd:0,inclusive:true};},
  (r:any)=>{r.context.interval={frameStart:null,frameEnd:null,inclusive:true};},
  (r:any)=>{r.context.frame=0;},(r:any)=>{r.context.time=.5;},
  (r:any)=>{r.context.comment.timeBasis.basis='frames';},(r:any)=>{r.context.comment.timeBasis.reason='unknown';},
  (r:any)=>{r.context.comment.frame={index:0,basis:'producer'};},
  (r:any)=>{r.context.comment.bookmark.time=.5;},(r:any)=>{r.context.comment.sourceHash='0'.repeat(64);},
  (r:any)=>{r.context.comment.time=-1;},(r:any)=>{r.context.comment.time=Infinity;},
  (r:any)=>{r.context.comment.time=NaN;},(r:any)=>{r.context.comment.time='0.25';},
 ]){const r=clone(f);edit(r);expect(()=>validatePackageFeedback(parseFeedback(r),p)).toThrow();}
 const forged=clone(f);forged.frameStart=forged.frameEnd=0;expect(recoverSession({...freshSession(p),feedback:[forged]},freshSession(p))).toBeNull();
 expect(()=>validatePackageFeedback(f,p,'inspect')).toThrow();
 const reference=timed(p,true);reference.context.comment.referenceHash='0'.repeat(64);expect(()=>validatePackageFeedback(reference,p)).toThrow('COMMENT_REFERENCE_MISMATCH');
}));
test('time-only cannot falsely hide a real matching producer frame',()=>fixture(async(p)=>{
 await writeFile(join(p.root,'report.json'),JSON.stringify({spec:'rig-pose-report/1',frames:25,fps:24,frame0:0,animation:'inspect'}));
 const manifest=JSON.parse(await readFile(join(p.root,'review.json'),'utf8'));manifest.authoring=[{label:'Clock',path:'report.json'}];await writeFile(join(p.root,'review.json'),JSON.stringify(manifest));
 const declared=await loadReferencedReview(p.root,join(p.root,'source.webm'));expect(declared.feedbackCatalog.clock).not.toBeNull();expect(()=>validatePackageFeedback(timed(declared),declared)).toThrow('COMMENT_TIME_ONLY_INVALID');
}));
test('actual time-only CLI JSON/issue names unavailable frame and seconds; strip refuses by name without coercion',()=>fixture(async(p,root)=>{
 const state=join(root,'state'),f=timed(p,true);await saveSession(p,{...freshSession(p),feedback:[f]},state);
 const run=async(args:string[])=>{const proc=Bun.spawn([process.execPath,'src/cli.ts',...args],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'});return {stdout:await new Response(proc.stdout).text(),stderr:await new Response(proc.stderr).text(),exit:await proc.exited};};
 for(const format of ['json','issue']){const r=await run(['feedback',p.root,'--reference',join(p.root,'source.webm'),'--format',format]);expect(r.exit,r.stderr).toBe(0);expect(r.stdout).toContain('frame is unavailable');expect(r.stdout).toContain('seconds');expect(r.stdout).not.toContain('null–null');expect(r.stdout).not.toContain('data:image/png');if(format==='json'){const row=JSON.parse(r.stdout).feedback[0];expect(row.frameStart).toBeNull();expect(row.frameEnd).toBeNull();expect(row.context.interval).toBeNull();expect(row.context.frame).toBeNull();expect(await readFile(row.context.comment.crop.path)).toEqual(Buffer.from(png,'base64'));}}
 const strip=await run(['strip',p.root,'--animation','inspect','--reference',p.manifest.references[0].id,'--reference-video',join(p.root,'source.webm'),'--all-feedback','--json']);expect(strip.exit).not.toBe(0);expect(strip.stderr).toContain('COMMENT_CLOCK_UNAVAILABLE');expect(strip.stderr).toContain('frame is unavailable');
}));
