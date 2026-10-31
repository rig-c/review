import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
test('Comment is visible on both stage toolbars without a menu',async()=>{for(const file of ['web/index.html','web/compare.html']){const html=await readFile(file,'utf8');expect(html).toContain('id="stage-comment"');expect(html).toContain('Comment');}});

import {drawnSlots,projectMark,unprojectMark,region,parseStageComment} from '../src/stage-comment.ts';
import type {PosedFrame} from '@rig-c/play';
const row=(slot:string,z:number,vertices:number[],triangles=[0,1,2],clip?:any)=>({kind:'mesh' as const,slot,z,vertices,triangles,uvs:vertices.map(()=>0),page:'p',pma:false,sequence:0,tint:[1,1,1,1] as [number,number,number,number],blend:'Normal' as const,...(clip?{clip}:{})});
test('drawn triangle oracle excludes a box-overlap false positive, clip holes and transparent rows; nearest is last drawn',()=>{
 const back=row('back',0,[0,0,10,0,0,10]),front=row('front',5,[0,0,10,0,0,10]),alpha={...row('transparent',8,[0,0,10,0,0,10]),tint:[1,1,1,0] as [number,number,number,number]};
 expect(drawnSlots({order:[back,front,alpha]}, {x:8,y:8,width:1,height:1})).toEqual([]);
 expect(drawnSlots({order:[back,front,alpha]}, {x:1,y:1,width:1,height:1})).toEqual([{slot:'front',z:5},{slot:'back',z:0}]);
 const clipped=row('clipped',9,[0,0,10,0,0,10],[0,1,2],{polygon:[0,0,2,0,2,2,0,2],inverse:false,convex:false});
 expect(drawnSlots({order:[back,clipped]}, {x:3,y:3,width:1,height:1})).toEqual([{slot:'back',z:0}]);
 expect(drawnSlots({order:[{...clipped,clip:{...clipped.clip,inverse:true}}]}, {x:1,y:1,width:.2,height:.2})).toEqual([]);
 expect(drawnSlots({order:[clipped]}, {x:1,y:1,width:0,height:0})).toEqual([{slot:'clipped',z:9}]);
});
test('concave clip applies its actual notch, not its AABB or convex hull unless declared convex',()=>{
 const clip={polygon:[0,0,8,0,8,2,2,2,2,8,0,8],convex:false,inverse:false};const part=row('notch',0,[0,0,10,0,0,10],[0,1,2],clip);
 expect(drawnSlots({order:[part]}, {x:3,y:3,width:.5,height:.5})).toEqual([]);
 expect(drawnSlots({order:[{...part,clip:{...clip,convex:true}}]}, {x:3,y:3,width:.5,height:.5})).toEqual([{slot:'notch',z:0}]);
});
test('world/image marks roundtrip exact per-pane camera after independent zoom and pan, including letterbox',()=>{
 for(const space of ['world','image'] as const){const camera={space,center:{x:100,y:200},zoom:2,viewport:{width:720,height:410},visible:{x:-80,y:55,width:360,height:205}};
 for(const p of [{x:0,y:0},{x:55.125,y:387.75}]){const world=unprojectMark(p,camera);expect(projectMark(world,camera)).toEqual(p);}
 const a={x:3,y:4},b={x:8,y:9};expect(region(a,b)).toEqual({x:3,y:4,width:5,height:5});}
});

import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile as read,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {freshSession,parseSession,saveSession,readSession,validatePackageFeedback} from '../src/session.ts';
import {saveCommentCrops,commentCropPaths} from '../src/comment-crops.ts';
import {feedbackWithCommentGroups,formatFeedbackIssues} from '../src/feedback-export.ts';
test('derived mode groups reference every canonical comment once and Markdown puts evidence under each mode heading',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comment-mode-export-'));try{
 await writeFile(join(root,'review.json'),JSON.stringify({schema:'rig-review/1',id:'mode-control',title:'Mode control',revision:'1'}));const p=await loadReview(root);
 const feedback:any[]=['setup','animate'].map(mode=>{const c=mark(p);c.mode=mode;c.bookmark.selection.inspector=mode==='setup'?'rig':'playback';return {id:mode,frameStart:0,frameEnd:0,target:{kind:'rig',name:p.manifest.id},category:'defect',summary:'Evidence '+mode,context:{time:0,animation:null,comment:c}};});
 feedback.push({id:'ordinary',frameStart:1,frameEnd:2,target:{kind:'rig',name:p.manifest.id},category:'quality',summary:'Ordinary',context:{comment:'legacy text'}});
 const original={...freshSession(p),feedback},session=commentCropPaths(original,join(root,'state')),before=JSON.stringify(original),json=feedbackWithCommentGroups(session);
 expect(json.feedback).toBe(session.feedback);expect(json.commentGroups).toEqual({schema:'rig-review-comment-groups/1',canonical:'feedback',modes:[{mode:'setup',feedbackIds:['setup']},{mode:'animate',feedbackIds:['animate']}]});
 const md=formatFeedbackIssues(session);for(const mode of ['setup','animate']){const section=md.split(`## Comments · ${mode} (1)\n`)[1]!.split('\n## ')[0]!;expect(section).toContain('#### Feedback '+mode);expect(section).toContain('Evidence '+mode);expect(section).toContain('Comment crop:');expect(section).toContain('"camera"');}
 expect(md.split('## Comments')[0]).toContain('#### Feedback ordinary');expect(md.match(/#### Feedback /g)).toHaveLength(3);expect(JSON.stringify(original)).toBe(before);
 const ordinary={...original,feedback:[feedback[2]]};expect(feedbackWithCommentGroups(ordinary)).toBe(ordinary);
 }finally{await rm(root,{recursive:true,force:true});}
});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
test('mode amendment planted missing-mode and unknown-mode records refuse by name',()=>{
 const c=mark({sourceHash:'a'.repeat(64)});delete c.mode;
 expect(()=>parseStageComment(c)).toThrow('COMMENT_MODE_MISSING');
});
test('mode amendment unknown-mode control refuses by name',()=>{
 expect(()=>parseStageComment({...mark({sourceHash:'a'.repeat(64)}),mode:'future'})).toThrow('COMMENT_MODE_UNKNOWN');
});
test('mode amendment rejects incompatible page, viewport and bookmark instead of guessing',()=>{
 const c=mark({sourceHash:'a'.repeat(64)});
 expect(parseStageComment(c).mode).toBe('animate');
 expect(()=>parseStageComment({...c,mode:'setup'})).toThrow('COMMENT_MODE_MISMATCH');
 expect(()=>parseStageComment({...c,mode:'compare'})).toThrow('COMMENT_MODE_MISMATCH');
 expect(()=>parseStageComment({...c,viewport:'a'})).toThrow('COMMENT_MODE_MISMATCH');
 const setup={...c,mode:'setup',bookmark:{...c.bookmark,selection:{inspector:'rig'}}};expect(parseStageComment(setup).mode).toBe('setup');
 const compare={...c,mode:'compare',viewport:'a',bookmark:{...c.bookmark,binding:{...c.bookmark.binding,mode:'compare'}}};expect(parseStageComment(compare).mode).toBe('compare');
});
function mark(p:any):any {const sha=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex');return {schema:'rig-review-comment/1',mode:'animate',viewport:'rig',frame:{index:0,basis:'producer'},time:0,animation:null,sourceHash:p.sourceHash,modelHash:null,referenceHash:null,referenceId:null,camera:{space:'world',center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}},screen:{x:50,y:50,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:{schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:p.sourceHash,rigs:[null]},time:0,animation:null,theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:{space:'world',center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}},a:null,b:null,reference:null}},selection:{inspector:'playback'}}};}
test('optional comment record roundtrips existing feedback, derives crop files and rejects stale/malformed evidence; legacy rows still read',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comments-')),state=join(root,'state');try{
 const source=join(root,'package');await mkdir(source);await writeFile(join(source,'review.json'),JSON.stringify({schema:'rig-review/1',id:'probe',title:'probe',revision:'1'}));const p=await loadReview(source),c=mark(p),f:any={id:'comment-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'probe'},category:'defect',summary:'spot',context:{animation:null,time:0,frame:0,comment:c}};
 expect(validatePackageFeedback(f,p).context).toMatchObject({comment:c});
 const saved=await saveSession(p,{...freshSession(p),feedback:[f]},state);expect((await readSession(p,state)).feedback).toEqual(saved.feedback);
 await expect(saveSession(p,{...saved,feedback:[]},state)).rejects.toThrow('COMMENT_SUBMITTED');
 await expect(saveSession(p,{...saved,feedback:[{...saved.feedback[0],summary:'changed'}]},state)).rejects.toThrow('COMMENT_SUBMITTED');
 expect(await read(join(state,c.crop.path))).toEqual(Buffer.from(png,'base64'));
 expect((commentCropPaths(saved,state).feedback[0]!.context as any).comment.crop.path).toBe(join(state,c.crop.path));
 expect(()=>validatePackageFeedback({...f,context:{...f.context,comment:{...c,sourceHash:'0'.repeat(64)}}},p)).toThrow('COMMENT_SOURCE_CHANGED');
 expect(()=>validatePackageFeedback({...f,context:{...f.context,comment:{...c,crop:{...c.crop,path:'../outside.png'}}}},p)).toThrow('COMMENT_INVALID');
 expect(()=>validatePackageFeedback({...f,context:{...f.context,comment:{...c,crop:{...c.crop,sha256:'0'.repeat(64),path:'comment-crops/'+ '0'.repeat(64)+'.png'}}}},p)).toThrow('COMMENT_CROP_INVALID');
 const legacy={...freshSession(p),status:'approved',updatedAt:'2026-01-01T00:00:00.000Z',feedback:[{...f,id:'legacy',context:undefined}]};expect(parseSession(legacy,p,false).feedback[0]!.id).toBe('legacy');
 expect(()=>parseStageComment({...c,command:'anything'})).toThrow('COMMENT_INVALID');
 }finally{await rm(root,{recursive:true,force:true});}
});

import {turnPackage} from './helpers/turn-pad.ts';
import {loadCompare} from '../src/compare.ts';
import {freshCompareSession,parseCompareSession,saveCompareSession} from '../src/compare-session.ts';
import {startCompareServer} from '../src/compare-server.ts';
test('B/reference hashes, viewport and bookmark are independently bound; loopback source change is HTTP409 and PNG path has no endpoint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comment-binding-'));let app:Awaited<ReturnType<typeof startCompareServer>>|undefined;try{
 const a=await turnPackage(join(root,'a')),b=await turnPackage(join(root,'b'),{yaw:[-10,20]}),reference=join(root,'source.mp4');await writeFile(reference,'read-only transport control');const p=await loadCompare({a,b,reference,animation:'inspect'}),c=mark(p.b);c.viewport='b';c.mode='compare';c.modelHash=p.b.reviewedSource.rig!.sha256;c.referenceHash=p.response.reference.sha256;c.referenceId=c.referenceHash;c.animation='inspect';c.bookmark.binding={mode:'compare',sourceHash:p.response.sourceHash,rigs:[p.a.reviewedSource.rig!.sha256,p.b.reviewedSource.rig!.sha256]};c.bookmark.animation='inspect';c.bookmark.view.cameras.b=c.camera;c.bookmark.view.cameras.rig=null;
 const f:any={id:'b-mark',side:'b',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.b.manifest.id},category:'defect',summary:'B edge',context:{animation:'inspect',time:0,comment:c}};const session={...freshCompareSession(p),feedback:[f]};expect(parseCompareSession(session,p).feedback[0]!.side).toBe('b');
 for(const change of [{sourceHash:p.a.sourceHash},{referenceHash:'0'.repeat(64)},{viewport:'a'},{modelHash:'0'.repeat(64)}]){expect(()=>parseCompareSession({...session,feedback:[{...f,context:{...f.context,comment:{...c,...change}}}]},p)).toThrow();}
 app=await startCompareServer(p,{port:0,stateDir:join(root,'state')} as any);const origin='http://127.0.0.1:'+app.port;
 expect((await fetch(origin+'/api/compare/session',{method:'PUT',headers:{Origin:'http://other.invalid','Content-Type':'application/json'},body:JSON.stringify(session)})).status).toBe(403);
 expect((await fetch(origin+'/'+c.crop.path)).status).toBe(404);
 const saved=await saveCompareSession(p,session,join(root,'state'));await expect(saveCompareSession(p,{...saved,feedback:[]},join(root,'state'))).rejects.toThrow('COMMENT_SUBMITTED');
 await writeFile(join(b,'motion.json'),'changed source control');expect((await fetch(origin+'/api/compare/session')).status).toBe(409);
 }finally{app?.stop(true);await rm(root,{recursive:true,force:true});}
});

const {bindStageComments}=await import(process.env.RIG_REVIEW_COMMENTS_ADAPTER??'../web/stage-comments.ts');
/** Event/DOM adapter control only; this does not claim browser pixels or native capture. */
function commentUI(feedback:any[]=[]) {
 class Node {
  children:Node[]=[];style:any={};dataset:Record<string,string>={};className='';textContent='';hidden=false;clientWidth=100;clientHeight=100;clientLeft=0;clientTop=0;captured=new Set<number>();attributes=new Map<string,string>();listeners=new Map<string,Function[]>();onclick:Function|null=null;
  classList={toggle:()=>{}};
  append(...nodes:Node[]){this.children.push(...nodes);}after(..._nodes:Node[]){}replaceChildren(...nodes:Node[]){this.children=[...nodes];}remove(){}setAttribute(k:string,v:string){this.attributes.set(k,v);}closest(){return null;}focus(){}getBoundingClientRect(){return {left:0,top:0};}
  addEventListener(k:string,f:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),f]);}removeEventListener(k:string,f:Function){this.listeners.set(k,(this.listeners.get(k)??[]).filter(fn=>fn!==f));}dispatch(k:string,e:any={}){for(const f of this.listeners.get(k)??[])f(e);}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);this.dispatch('lostpointercapture',{pointerId:id});}
 }
 const toggle=new Node(),listToggle=new Node(),toolbar=new Node(),workspace=new Node(),pane=new Node(),doc=new Node() as any,win=new Node(),saved=new Map<string,any>();let next:Function=()=>{};
 toolbar.closest=((selector:string)=>selector==='main'?workspace:null) as any;
 doc.createElement=()=>new Node();doc.getElementById=(id:string)=>id==='stage-comment'?toggle:listToggle;
 for(const [k,v]of Object.entries({document:doc,window:win,requestAnimationFrame:(f:Function)=>{next=f;return 1;},cancelAnimationFrame:()=>{}})){saved.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;}
 let pose:any={mode:'animate',camera:mark({sourceHash:'a'.repeat(64)}).camera,frame:{index:0,basis:'producer'},time:0,animation:'idle',turn:null,sourceHash:'a'.repeat(64),modelHash:null,referenceHash:null,referenceId:null,rig:'probe'};
 const tool=bindStageComments({toolbar:toolbar as any,viewports:{rig:pane as any},pose:()=>pose,pause:async()=>{},bookmark:()=>({}),restore:async()=>{},feedback:()=>feedback,locked:()=>false,add:()=>{},changed:()=>{},error:()=>{},blocked:()=>false});
 const event=(extra:any={})=>({button:0,isPrimary:true,pointerId:7,clientX:50,clientY:50,target:new Node(),preventDefault(){},stopImmediatePropagation(){},...extra});
 return {pane,workspace,tool,pose,tick:()=>next(),down:()=>{toggle.onclick?.();pane.dispatch('pointerdown',event());},escape:()=>doc.dispatch('keydown',event({key:'Escape'})),blur:()=>win.dispatch('blur'),cleanup:()=>{tool.dispose();for(const [k,v]of saved)(globalThis as any)[k]=v;}};
}
test('comment list overlay lives outside the measured workspace stage chrome',()=>{const ui=commentUI();try{expect(ui.workspace.children).toHaveLength(1);expect(ui.workspace.children[0]!.className).toContain('stage-comment-list');}finally{ui.cleanup();}});
test('actual stage comment painter hides a mark on a different animation at the same frame/time/turn',()=>{
 const c=mark({sourceHash:'a'.repeat(64)});c.animation='idle';const ui=commentUI([{id:'one',summary:'spot',context:{comment:c}}]);try{const layer=ui.pane.children[0]!;expect(layer.children).toHaveLength(2);ui.pose.animation='other';ui.tick();expect(layer.children).toHaveLength(0);ui.pose.animation='idle';ui.tick();expect(layer.children).toHaveLength(2);}finally{ui.cleanup();}
});
test('actual painter isolates setup and animate at identical animation, time, turn and camera',()=>{
 const c=mark({sourceHash:'a'.repeat(64)});c.animation='idle';const ui=commentUI([{id:'one',summary:'spot',context:{comment:c}}]);try{
 const held=JSON.stringify({...ui.pose,mode:undefined}),layer=ui.pane.children[0]!;expect(layer.children).toHaveLength(2);
 ui.pose.mode='setup';ui.tick();expect(layer.children).toHaveLength(0);expect(JSON.stringify({...ui.pose,mode:undefined})).toBe(held);
 ui.pose.mode='animate';ui.tick();expect(layer.children).toHaveLength(2);
 ui.down();expect(ui.pane.hasPointerCapture(7)).toBe(true);ui.pose.mode='setup';ui.tick();expect(ui.pane.hasPointerCapture(7)).toBe(false);expect(ui.tool.draft()).toBe(false);
 }finally{ui.cleanup();}
});
test('actual Escape, window blur and disposal release only the comment drag own pointer capture',()=>{
 for(const action of ['escape','blur','dispose'] as const){const ui=commentUI();try{ui.pane.setPointerCapture(99);ui.down();expect(ui.pane.hasPointerCapture(7)).toBe(true);if(action==='dispose')ui.tool.dispose();else ui[action]();expect(ui.pane.hasPointerCapture(7)).toBe(false);expect(ui.pane.hasPointerCapture(99)).toBe(true);}finally{ui.cleanup();}}
});

import {loadReferencedReview} from '../src/reference.ts';
test('single reference comments bind the selected declared/explicit reference hash and bookmark; clockless decoded frames remain explicitly unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comment-reference-'));try{
 const source=join(root,'package');await mkdir(source);const manifest={schema:'rig-review/1',id:'reference-control',title:'Reference control',revision:'1',references:[{id:'source',type:'video',label:'Source',path:'source.webm'}],authoring:[{label:'Clock',path:'report.json'}]};
 await writeFile(join(source,'review.json'),JSON.stringify(manifest));await writeFile(join(source,'source.webm'),'declared bytes');await writeFile(join(source,'report.json'),JSON.stringify({spec:'rig-pose-report/1',frames:2,fps:24,frame0:0}));const external=join(root,'external.webm');await writeFile(external,'explicit bytes');
 for(const p of [await loadReview(source),await loadReferencedReview(source,external)]){
  const explicit=(p as any).manifest.references.find((r:any)=>r.id.startsWith('open-reference-')),id=explicit?.id??'source',sha=explicit?createHash('sha256').update('explicit bytes').digest('hex'):createHash('sha256').update('declared bytes').digest('hex');
  expect(p.referenceHashes!.source).toBe(createHash('sha256').update('declared bytes').digest('hex'));
  const c=mark(p);c.viewport='reference';c.camera.space='image';c.referenceId=id;c.referenceHash=sha;c.bookmark.view.cameras.rig=null;c.bookmark.view.cameras.reference=c.camera;c.bookmark.selection.reference=id;
  const f:any={id:'reference-note',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.manifest.id},category:'defect',summary:'Reference detail',context:{time:0,animation:null,comment:c}};expect(validatePackageFeedback(f,p).target.kind).toBe('rig');
  for(const patch of [{referenceId:'wrong'},{referenceHash:'0'.repeat(64)},{bookmark:{...c.bookmark,selection:{...c.bookmark.selection,reference:'wrong'}}}])expect(()=>validatePackageFeedback({...f,context:{...f.context,comment:{...c,...patch}}},p)).toThrow('COMMENT_REFERENCE_MISMATCH');
  expect(()=>validatePackageFeedback({...f,context:{...f.context,comment:{...c,frame:{index:0,basis:'reference'}}}},p)).toThrow('COMMENT_FRAME_UNAVAILABLE');
 }
 await writeFile(join(source,'review.json'),JSON.stringify({...manifest,authoring:[]}));const clockless=await loadReview(source);expect(clockless.feedbackCatalog.clock).toBeNull();const c=mark(clockless);c.viewport='reference';c.camera.space='image';c.referenceId='source';c.referenceHash=clockless.referenceHashes!.source;c.bookmark.view.cameras.rig=null;c.bookmark.view.cameras.reference=c.camera;c.bookmark.selection.reference='source';expect(()=>validatePackageFeedback({id:'gap',frameStart:0,frameEnd:0,target:{kind:'rig',name:clockless.manifest.id},category:'defect',summary:'gap',context:{time:0,animation:null,comment:c}},clockless)).toThrow('COMMENT_FRAME_UNAVAILABLE');
 }finally{await rm(root,{recursive:true,force:true});}
});

import {deflateSync} from 'node:zlib';
function largePng():Buffer {
 const width=190,height=190,raw=Buffer.alloc(height*(1+4*width));let seed=123456789;for(let y=0;y<height;y++)for(let x=0;x<width*4;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;raw[y*(1+4*width)+1+x]=seed>>>24;}
 const chunk=(kind:string,data:Buffer)=>{const body=Buffer.concat([Buffer.from(kind),data]);let crc=0xffffffff;for(const n of body){crc^=n;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const start=Buffer.alloc(4),end=Buffer.alloc(4);start.writeUInt32BE(data.length);end.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([start,body,end]);};const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(raw,{level:0})),chunk('IEND',Buffer.alloc(0))]);
}
test('actual CLI exports a large crop as openable path/hash/dimensions without base64, preserving private submitted PNG bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comment-export-'));try{
 const source=join(root,'package'),state=join(root,'state');await mkdir(source);await writeFile(join(source,'review.json'),JSON.stringify({schema:'rig-review/1',id:'export-control',title:'Export control',revision:'1'}));const p=await loadReview(source),bytes=largePng(),sha256=createHash('sha256').update(bytes).digest('hex'),c=mark(p);c.crop={path:`comment-crops/${sha256}.png`,sha256,png:'data:image/png;base64,'+bytes.toString('base64'),width:190,height:190};expect(c.crop.png.length).toBeGreaterThan(190000);expect(c.crop.png.length).toBeLessThan(200000);
 const f:any={id:'large-crop',frameStart:0,frameEnd:0,target:{kind:'rig',name:p.manifest.id},category:'defect',summary:'Noisy marked crop',context:{time:0,animation:null,comment:c}},saved=await saveSession(p,{...freshSession(p),feedback:[f]},state),before=JSON.stringify(saved);const figures:any={inlineCharacters:c.crop.png.length,pngBytes:bytes.length};
 for(const format of ['json','issue']){
  const proc=Bun.spawn([process.execPath,'src/cli.ts','feedback',source,'--format',format],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'}),output=await new Response(proc.stdout).text(),error=await new Response(proc.stderr).text();expect(await proc.exited).toBe(0);expect(error).toBe('');expect(output).not.toContain('data:image/png');expect(output.length).toBeLessThan(20000);expect(output).toContain(sha256);figures[format+'Bytes']=Buffer.byteLength(output);
  if(format==='json'){const crop=JSON.parse(output).feedback[0].context.comment.crop;expect(crop).toEqual({path:join(state,c.crop.path),sha256,width:190,height:190});expect((await read(crop.path)).equals(bytes)).toBe(true);}
 }
 expect(JSON.stringify(saved)).toBe(before);expect(((await readSession(p,state)).feedback[0]!.context as any).comment.crop.png).toBe(c.crop.png);console.log('LARGE_CROP_EXPORT '+JSON.stringify(figures));
 }finally{await rm(root,{recursive:true,force:true});}
});
