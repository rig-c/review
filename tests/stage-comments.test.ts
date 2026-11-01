import {expect,test} from 'bun:test';
import {readFile,readdir} from 'node:fs/promises';
test('Comment is visible as one control on both stage toolbars with no reference to the removed list-toggle id',async()=>{
 const removedId='stage-comment-'+'list-toggle';
 for(const file of ['web/index.html','web/compare.html']){
  const html=await readFile(file,'utf8');
  expect(html).toContain('id="stage-comment"');
  expect(html).toContain('Comment · C (0)');
  expect(html).toContain('aria-controls="stage-comment-list"');
  expect(html).not.toContain(removedId);
 }
 for(const dir of ['src','web','docs','skills/rig-review','tests']){
  for(const entry of await readdir(dir,{ withFileTypes:true })){
   if(!entry.isFile())continue;
   const text=await readFile(`${dir}/${entry.name}`,'utf8');
   expect(text).not.toContain(removedId);
  }
 }
});

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
function commentUI(feedback:any[]=[],options:{locked?:(id:string)=>boolean;cropImpl?:()=>Promise<any>;canvasFactory?:()=>any}={}) {
 class Node {
  children:Node[]=[];parent:Node|null=null;style:any={};dataset:Record<string,string>={};className='';id='';textContent='';title='Comment · C';value='';placeholder='';type='';maxLength=0;hidden=false;disabled=false;readOnly=false;clientWidth=100;clientHeight=100;clientLeft=0;clientTop=0;captured=new Set<number>();attributes=new Map<string,string>();listeners=new Map<string,Function[]>();onclick:Function|null=null;onsubmit:Function|null=null;onkeydown:Function|null=null;
  classList={toggle:()=>{}};
  append(...nodes:Node[]){for(const n of nodes){n.parent=this;this.children.push(n);}}after(...nodes:Node[]){for(const n of nodes){n.parent=this;this.children.push(n);}}replaceChildren(...nodes:Node[]){this.children=[];this.append(...nodes);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}setAttribute(k:string,v:string){this.attributes.set(k,v);}getAttribute(k:string){return this.attributes.get(k)??null;}closest(){return null;}focus(){}getBoundingClientRect(){return {left:0,top:0};}
  addEventListener(k:string,f:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),f]);}removeEventListener(k:string,f:Function){this.listeners.set(k,(this.listeners.get(k)??[]).filter(fn=>fn!==f));}dispatch(k:string,e:any={}){for(const f of this.listeners.get(k)??[])f(e);}async emit(k:string,e:any={}){await Promise.all((this.listeners.get(k)??[]).map(f=>f(e)));}setPointerCapture(id:number){this.captured.add(id);}hasPointerCapture(id:number){return this.captured.has(id);}releasePointerCapture(id:number){this.captured.delete(id);this.dispatch('lostpointercapture',{pointerId:id});}
 }
 const toggle=new Node(),toolbar=new Node(),workspace=new Node(),pane=new Node(),doc=new Node() as any,win=new Node(),saved=new Map<string,any>(),errors:string[]=[];let next:Function=()=>{},restores=0,changes=0;
 toolbar.closest=((selector:string)=>selector==='main'?workspace:null) as any;
 doc.createElement=(tag:string)=>tag==='canvas'&&options.canvasFactory?options.canvasFactory():new Node();
 doc.getElementById=(id:string)=>id==='stage-comment'?toggle:null;
 doc.documentElement=new Node();
 const prevGetComputedStyle=(globalThis as any).getComputedStyle;
 for(const [k,v]of Object.entries({document:doc,window:win,requestAnimationFrame:(f:Function)=>{next=f;return 1;},cancelAnimationFrame:()=>{},getComputedStyle:()=>({getPropertyValue:()=>'#3b82f6',backgroundColor:'rgb(20, 24, 32)',backgroundImage:'none',backgroundSize:'auto',backgroundPosition:'0% 0%',display:'block',visibility:'visible',opacity:'1',filter:'none',transformOrigin:'0px 0px',transform:'matrix(1, 0, 0, 1, 0, 0)',zIndex:'0',width:'100px',height:'100px',mixBlendMode:'normal'})})){saved.set(k,(globalThis as any)[k]);(globalThis as any)[k]=v;}
 let pose:any={mode:'animate',camera:mark({sourceHash:'a'.repeat(64)}).camera,frame:{index:0,basis:'producer'},time:0,animation:'idle',turn:null,sourceHash:'a'.repeat(64),modelHash:null,referenceHash:null,referenceId:null,rig:'probe'};
 const tool=bindStageComments({toolbar:toolbar as any,viewports:{rig:pane as any},pose:()=>pose,pause:async()=>{},bookmark:()=>mark({sourceHash:'a'.repeat(64)}).bookmark,restore:async()=>{restores++;},feedback:()=>feedback,locked:options.locked??(()=>false),add:(f:any)=>feedback.push(f),changed:()=>{changes++;},error:(m:string)=>errors.push(m),blocked:()=>false});
 const event=(extra:any={})=>({button:0,isPrimary:true,pointerId:7,clientX:50,clientY:50,target:new Node(),preventDefault(){},stopImmediatePropagation(){},...extra});
 const list=()=>workspace.children.find(n=>n.id==='stage-comment-list')!;
 return {toggle,pane,workspace,list,tool,pose,errors,restores:()=>restores,changes:()=>changes,tick:()=>next(),down:()=>{if(!tool.active())toggle.onclick?.();pane.dispatch('pointerdown',event());},up:()=>pane.emit('pointerup',event()),key:(k:string)=>doc.dispatch('keydown',event({key:k})),escape:()=>doc.dispatch('keydown',event({key:'Escape'})),blur:()=>win.dispatch('blur'),cleanup:()=>{tool.dispose();for(const [k,v]of saved)(globalThis as any)[k]=v;if(prevGetComputedStyle===undefined)delete (globalThis as any).getComputedStyle;}};
}
test('comment list overlay lives outside the measured workspace stage chrome',()=>{const ui=commentUI();try{expect(ui.workspace.children).toHaveLength(1);expect(ui.workspace.children[0]!.className).toContain('stage-comment-list');}finally{ui.cleanup();}});
test('#284: open comment list tracks wrapped view bar bottom across widths and languages; planted fixed top:55px covers wrapped rows',()=>{
 const ui=commentUI();
 try{
  let barBottom=122;
  (ui.workspace as any).getBoundingClientRect=()=>({left:264,top:72,right:900,bottom:900,width:636,height:828});
  (ui.toggle as any).closest=()=>null;
  // Rebind toolbar rect through workspace's first-pass toolbar reference in commentUI:
  const toolbarRect=()=>({left:264,top:72,right:900,bottom:barBottom,width:636,height:barBottom-72});
  // commentUI's toolbar is the node whose closest('main') is ui.workspace; patch Node.prototype.getBoundingClientRect for that toolbar via ui.list()'s sibling/owner check:
  const origRect=Object.getPrototypeOf(ui.workspace).getBoundingClientRect;
  Object.getPrototypeOf(ui.workspace).getBoundingClientRect=function(){return this===ui.workspace?{left:264,top:72,right:900,bottom:900,width:636,height:828}:toolbarRect();};
  try{
   ui.toggle.onclick?.();
   expect(ui.list().hidden).toBe(false);
   expect(ui.list().style.top).toBe('55px');
   // 900x900 English wraps to 3 rows (bottom: 184, height: 112) -> list top becomes 117px (screen y=189 > 184).
   barBottom=184;
   ui.tick();
   expect(ui.list().style.top).toBe('117px');
   expect(72+parseFloat(ui.list().style.top)).toBeGreaterThan(barBottom);
   // 900x900 Korean wraps to 2 rows (bottom: 149, height: 77) -> list top becomes 82px (screen y=154 > 149).
   barBottom=149;
   ui.tick();
   expect(ui.list().style.top).toBe('82px');
   expect(72+parseFloat(ui.list().style.top)).toBeGreaterThan(barBottom);
   // Planted pre-#284 fixed top:55px (screen y=127) fails the non-overlap gate on both 3-row en and 2-row ko wrapped bars.
   const clearsBar=(listTopPx:number,viewbarTop:number,viewbarBottom:number)=>viewbarTop+listTopPx>=viewbarBottom;
   expect(clearsBar(parseFloat('117px'),72,184)).toBe(true);
   expect(clearsBar(parseFloat('82px'),72,149)).toBe(true);
   expect(clearsBar(55,72,184)).toBe(false);
   expect(clearsBar(55,72,149)).toBe(false);
  }finally{
   Object.getPrototypeOf(ui.workspace).getBoundingClientRect=origRect;
  }
 }finally{ui.cleanup();}
});
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

import {createCanvas} from '@napi-rs/canvas';
import {inflateSync} from 'node:zlib';
import {validateCommentCrop} from '../src/comment-crops.ts';
import {InspectionDraftStore,recoverSession,sessionFingerprint,parseBookmark,type InspectionBookmark,type LocalInspectionDraft} from '../web/inspection-persistence.ts';

function realCanvasNode(width=100,height=100){
 const c=createCanvas(width,height);
 return {
  get width(){return c.width;},
  set width(v:number){c.width=v;},
  get height(){return c.height;},
  set height(v:number){c.height=v;},
  getContext:(kind:'2d')=>c.getContext(kind),
  toDataURL:(mime?:'image/png')=>c.toDataURL(mime as any),
  raw:c,
 };
}

test('#276 Bar 2: one control and one composer handle create, pin/row restore, edit, delete and submitted read-only; planted two-path controls fail',async()=>{
 const rows:any[]=[],lockedIds=new Set<string>();
 const sourceCanvas=createCanvas(100,100),sctx=sourceCanvas.getContext('2d');
 sctx.fillStyle='#223344';sctx.fillRect(0,0,100,100);
 (sourceCanvas as any).getBoundingClientRect=()=>({left:0,top:0,width:100,height:100});
 const ui=commentUI(rows,{locked:id=>lockedIds.has(id),canvasFactory:()=>realCanvasNode(100,100)});
 try{
  (ui.pane as any).querySelectorAll=()=>[];
  ui.pose.capture={pane:ui.pane,images:true,canvas:sourceCanvas,backend:'canvas2d'};
  expect(ui.toggle.textContent).toBe('Comment · C (0)');
  expect(ui.list().hidden).toBe(true);
  expect(ui.tool.active()).toBe(false);

  // Turning it on enters comment mode and opens the list; turning it off or Escape leaves both.
  ui.toggle.onclick?.();
  expect(ui.tool.active()).toBe(true);
  expect(ui.list().hidden).toBe(false);
  expect(ui.toggle.getAttribute('aria-pressed')).toBe('true');
  expect(ui.toggle.getAttribute('aria-expanded')).toBe('true');
  ui.toggle.onclick?.();
  expect(ui.tool.active()).toBe(false);
  expect(ui.list().hidden).toBe(true);
  ui.key('c');
  expect(ui.tool.active()).toBe(true);
  expect(ui.list().hidden).toBe(false);
  ui.escape();
  expect(ui.tool.active()).toBe(false);
  expect(ui.list().hidden).toBe(true);

  // Create a comment through the composer.
  ui.down();
  await ui.up();
  let composer=ui.pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  expect(composer).toBeDefined();
  expect(composer.children[1]!.textContent).toBe('Enter saves · Escape cancels');
  expect(composer.children.find(n=>n.className==='stage-comment-delete')).toBeUndefined();
  composer.children[0]!.value='Sleeve cuff gap';
  await composer.onsubmit!({preventDefault(){}});
  expect(rows).toHaveLength(1);
  expect(rows[0].summary).toBe('Sleeve cuff gap');
  expect(ui.toggle.textContent).toBe('Comment · C (1)');

  // List row has only one button (no separate Edit or Delete button on the row).
  const item=ui.list().children.find(n=>n.className==='stage-comment-item')!;
  const rowButtons=item.children.filter(n=>n.type==='button'||n.onclick);
  expect(rowButtons).toHaveLength(1);
  expect(item.children.some(n=>n.textContent==='Edit'||n.textContent==='Delete')).toBe(false);

  // Turn comment mode off: pins stay visible on stage, and clicking a pin enters the mode, restores pose and opens composer.
  ui.toggle.onclick?.();
  expect(ui.tool.active()).toBe(false);
  expect(ui.list().hidden).toBe(true);
  ui.tick();
  const layer=ui.pane.children[0]!;
  expect(layer.children).toHaveLength(2);
  const pin=layer.children[1]!;
  expect(pin.className).toContain('stage-comment-pin');
  await pin.onclick!();
  expect(ui.tool.active()).toBe(true);
  expect(ui.list().hidden).toBe(false);
  expect(ui.restores()).toBe(1);
  composer=ui.pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  expect(composer).toBeDefined();
  expect(composer.children[0]!.value).toBe('Sleeve cuff gap');
  expect(composer.children[0]!.readOnly).toBe(false);
  expect(composer.children.find(n=>n.className==='stage-comment-delete')).toBeDefined();

  // Edit via the same composer.
  composer.children[0]!.value='Updated sleeve cuff gap';
  await composer.onsubmit!({preventDefault(){}});
  expect(rows).toHaveLength(1);
  expect(rows[0].summary).toBe('Updated sleeve cuff gap');
  expect(ui.list().children.find(n=>n.className==='stage-comment-item')!.children[0]!.textContent).toContain('Updated sleeve cuff gap');

  // Clicking the list row restores pose and opens the composer; Delete inside composer removes the comment.
  const rowBtn=ui.list().children.find(n=>n.className==='stage-comment-item')!.children[0]!;
  await rowBtn.onclick!();
  expect(ui.restores()).toBe(2);
  composer=ui.pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  const delBtn=composer.children.find(n=>n.className==='stage-comment-delete')!;
  delBtn.onclick!();
  expect(rows).toHaveLength(0);
  expect(ui.toggle.textContent).toBe('Comment · C (0)');

  // Submitted (locked) marks open read-only in the composer without a Delete button.
  const lockedComment=mark({sourceHash:'a'.repeat(64)});lockedComment.animation='idle';
  rows.push({id:'locked-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'probe'},category:'defect',summary:'Submitted shoulder note',context:{animation:'idle',time:0,frame:0,comment:lockedComment}});
  lockedIds.add('locked-1');
  ui.tool.refresh();ui.tick();
  const lockedRowBtn=ui.list().children.find(n=>n.className==='stage-comment-item')!.children[0]!;
  await lockedRowBtn.onclick!();
  composer=ui.pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
  expect(composer.children[0]!.value).toBe('Submitted shoulder note');
  expect(composer.children[0]!.readOnly).toBe(true);
  expect(composer.children[0]!.getAttribute('aria-readonly')).toBe('true');
  expect(composer.children[1]!.textContent).toBe('Read only · Escape closes');
  expect(composer.children.find(n=>n.className==='stage-comment-delete')).toBeUndefined();
  expect(ui.tool.draft()).toBe(false);
  composer.children[0]!.value='Attempted mutation';
  await composer.onsubmit!({preventDefault(){}});
  expect(rows[0].summary).toBe('Submitted shoulder note');
  expect(composer.children[2]!.textContent).toContain('COMMENT_SUBMITTED');

  // Planted control for read-only hint text: old strings fail the read-only hint gate.
  const isReadOnlyHintValid=(hint:string)=>hint==='Read only · Escape closes';
  expect(isReadOnlyHintValid(composer.children[1]!.textContent)).toBe(true);
  expect(isReadOnlyHintValid('Submitted · read-only · Escape cancels')).toBe(false);
  expect(isReadOnlyHintValid('Enter saves · Escape cancels')).toBe(false);

  // Planted controls that exhibit the old two-path behaviour (row Edit/Delete buttons, or pin not entering mode/composer) must fail the Bar 2 gate.
  const checkOneComposerContract=(state:{rowButtons:number;rowHasEditOrDelete:boolean;pinEntersMode:boolean;pinOpensComposer:boolean;composerHasDelete:boolean})=>
   state.rowButtons===1&&!state.rowHasEditOrDelete&&state.pinEntersMode&&state.pinOpensComposer&&state.composerHasDelete;
  expect(checkOneComposerContract({rowButtons:1,rowHasEditOrDelete:false,pinEntersMode:true,pinOpensComposer:true,composerHasDelete:true})).toBe(true);
  expect(checkOneComposerContract({rowButtons:3,rowHasEditOrDelete:true,pinEntersMode:true,pinOpensComposer:true,composerHasDelete:false})).toBe(false);
  expect(checkOneComposerContract({rowButtons:1,rowHasEditOrDelete:false,pinEntersMode:false,pinOpensComposer:false,composerHasDelete:true})).toBe(false);
 }finally{ui.cleanup();}
});

test('#276 Bar 4 & Bar 5: feedback output is byte-identical for a stored review with comments and stored 0.24.1 drafts still load',async()=>{
 const root=await mkdtemp(join(tmpdir(),'comment-0241-compat-'));
 try{
  const source=join(root,'package'),state=join(root,'state');
  await mkdir(source);
  await writeFile(join(source,'review.json'),JSON.stringify({schema:'rig-review/1',id:'compat-rig',title:'Compat rig',revision:'1'}));
  const p=await loadReview(source);
  const cSetup=mark(p);cSetup.mode='setup';cSetup.bookmark.selection.inspector='rig';
  const cAnimate=mark(p);cAnimate.mode='animate';cAnimate.bookmark.selection.inspector='playback';
  const feedback:any[]=[
   {id:'comment-setup',frameStart:0,frameEnd:0,target:{kind:'rig',name:'compat-rig'},category:'defect',summary:'Setup seam check',context:{animation:null,time:0,frame:0,interval:{frameStart:0,frameEnd:0,inclusive:true},comment:cSetup}},
   {id:'comment-animate',frameStart:0,frameEnd:0,target:{kind:'rig',name:'compat-rig'},category:'defect',summary:'Animate wrist check',context:{animation:null,time:0,frame:0,interval:{frameStart:0,frameEnd:0,inclusive:true},comment:cAnimate}},
  ];
  const sessionToSave={...freshSession(p),status:'changes-requested' as const,feedback};
  const saved=await saveSession(p,sessionToSave,state);
  const expectedJson=JSON.stringify(feedbackWithCommentGroups(commentCropPaths(saved,state)),null,2)+'\n';
  const expectedIssue=formatFeedbackIssues(commentCropPaths(saved,state));
  for(const [format,expected]of [['json',expectedJson],['issue',expectedIssue]] as const){
   const proc=Bun.spawn([process.execPath,'src/cli.ts','feedback',source,'--format',format],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'});
   const out=await new Response(proc.stdout).text(),err=await new Response(proc.stderr).text();
   expect(await proc.exited,err).toBe(0);
   expect(out).toBe(expected);
  }

  // Bar 5: Stored 0.24.1 local draft in localStorage loads unchanged into session and stage comments.
  const baseline=freshSession(p);
  const draftSession={...freshSession(p),feedback:[feedback[1]]};
  const bookmark0241:InspectionBookmark=cAnimate.bookmark;
  const storageMap=new Map<string,string>();
  const memoryStorage:Storage={
   get length(){return storageMap.size;},
   getItem:(k:string)=>storageMap.get(k)??null,
   setItem:(k:string,v:string)=>storageMap.set(k,v),
   removeItem:(k:string)=>storageMap.delete(k),
   key:(i:number)=>[...storageMap.keys()][i]??null,
   clear(){throw new Error('Global storage clear is forbidden');},
  };
  const draftRecord0241:LocalInspectionDraft={
   schema:'rig-review-local-draft/1',
   sourceHash:p.sourceHash,
   baseline:await sessionFingerprint(baseline),
   savedAt:'2026-10-30T00:00:00.000Z',
   reviewDirty:true,
   bookmark:bookmark0241,
   inputs:{},
   session:draftSession,
   ui:{},
  };
  const warnings:string[]=[];
  const store=new InspectionDraftStore('single:'+p.manifest.id,bookmark0241.binding,s=>warnings.push(s),memoryStorage);
  expect(store.write(draftRecord0241)).toBe(true);
  const loadedDraft=store.read();
  expect(loadedDraft).toEqual(draftRecord0241);
  expect(warnings).toEqual([]);
  const recovered=recoverSession(loadedDraft!.session,baseline);
  expect(recovered?.feedback).toHaveLength(1);
  expect(recovered?.feedback[0]?.summary).toBe('Animate wrist check');
  expect(parseBookmark(loadedDraft!.bookmark)).toEqual(bookmark0241);
  const ui=commentUI(recovered!.feedback);
  try{
   expect(ui.toggle.textContent).toBe('Comment · C (1)');
   expect(ui.list().children.filter(n=>n.className==='stage-comment-item')).toHaveLength(1);
  }finally{ui.cleanup();}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('#276 Bar 6 & Bar 10: docs, README row and skill describe one control and crop fitting while reader-side limits stay enforced',async()=>{
 const readme=await readFile('README.md','utf8');
 const panels=await readFile('docs/PANELS.md','utf8');
 const workflows=await readFile('docs/WORKFLOWS.md','utf8');
 const contract=await readFile('docs/REVIEW_PACKAGE.md','utf8');
 const skill=await readFile('skills/rig-review/SKILL.md','utf8');
 expect(readme).toContain('| Mark, read and edit stage comments | Comment · C (n) | [Stage comments — PANELS](docs/PANELS.md#stage-comments) |');
 expect(skill).toContain('**Comment · C (n)**');
 expect(workflows).toContain('**Comment · C (n)**');
 expect(panels).toContain('**Comment · C (n)**');
 expect(panels).toContain('re-renders at a smaller scale until the encoded PNG fits');
 expect(panels).toContain('still opens the list read-only');
 expect(contract).toContain('re-renders at a smaller scale when needed until the encoded PNG data URL fits inside the 200000-character limit');
 expect(contract).toContain('without disabling the button');

 // Reader-side record format limits (<= 200000 data-URL chars, <= 1024 px per side) remain unchanged.
 const c=mark({sourceHash:'a'.repeat(64)});
 expect(()=>parseStageComment({...c,crop:{...c.crop,png:'data:image/png;base64,'+'A'.repeat(200000)}})).toThrow('COMMENT_INVALID: bounded PNG crop');
 expect(()=>parseStageComment({...c,crop:{...c.crop,width:1025}})).toThrow('COMMENT_INVALID: bounded PNG crop');
});

test('#276 Bar 8 & Bar 9: full-viewport region over noisy art scales down inside the 200000-char limit with matching PNG dimensions and visible mark; old single-pass control fails with COMMENT_CROP_LIMIT',async()=>{
 const vw=768,vh=768;
 const noisy=createCanvas(vw,vh),nctx=noisy.getContext('2d');
 const img=nctx.createImageData(vw,vh);
 let seed=0x9e3779b9;
 for(let i=0;i<img.data.length;i+=4){
  seed=(Math.imul(seed,1664525)+1013904223)>>>0;
  img.data[i]=seed&0xff;
  img.data[i+1]=(seed>>>8)&0xff;
  img.data[i+2]=(seed>>>16)&0xff;
  img.data[i+3]=255;
 }
 nctx.putImageData(img,0,0);
 (noisy as any).getBoundingClientRect=()=>({left:0,top:0,width:vw,height:vh});

 // Planted old single-pass control at 768x768 throws COMMENT_CROP_LIMIT.
 const oldSinglePass=()=>{
  const out=createCanvas(vw,vh),ctx=out.getContext('2d');
  ctx.drawImage(noisy,0,0);
  const url=out.toDataURL('image/png');
  if(url.length>200000)throw new Error('COMMENT_CROP_LIMIT: mark a smaller region (PNG limit 150 KiB)');
  return url;
 };
 expect(()=>oldSinglePass()).toThrow('COMMENT_CROP_LIMIT');

 // Measure both a full-viewport box mark (768x768) and a point mark (0x0) over the noisy viewport through bindStageComments.
 const rows:any[]=[];
 const ui=commentUI(rows,{canvasFactory:()=>realCanvasNode(vw,vh)});
 try{
  ui.pane.clientWidth=vw;ui.pane.clientHeight=vh;
  (ui.pane as any).querySelectorAll=()=>[];
  ui.pose.camera={space:'world',center:{x:0,y:0},zoom:1,viewport:{width:vw,height:vh},visible:{x:-vw/2,y:-vh/2,width:vw,height:vh}};
  ui.pose.capture={pane:ui.pane,images:true,canvas:noisy,backend:'canvas2d'};

  for(const [label,start,end]of [['full-viewport',{x:0,y:0},{x:vw,y:vh}],['point',{x:384,y:384},{x:384,y:384}]] as const){
   if(!ui.tool.active())ui.toggle.onclick?.();
   ui.pane.dispatch('pointerdown',{button:0,isPrimary:true,pointerId:7,clientX:start.x,clientY:start.y,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});
   ui.pane.dispatch('pointermove',{button:0,isPrimary:true,pointerId:7,clientX:end.x,clientY:end.y,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});
   await ui.pane.emit('pointerup',{button:0,isPrimary:true,pointerId:7,clientX:end.x,clientY:end.y,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){}});
   const composer=ui.pane.children.find(n=>n.className.includes('stage-comment-composer'))!;
   composer.children[0]!.value=`Noisy ${label}`;
   await composer.onsubmit!({preventDefault(){}});
  }
  expect(rows).toHaveLength(2);
  for(const f of rows){
   const c=parseStageComment(f.context.comment);
   expect(c.crop.png.length).toBeLessThanOrEqual(200000);
   const bytes=validateCommentCrop(c);
   const ihdrWidth=bytes.readUInt32BE(16),ihdrHeight=bytes.readUInt32BE(20);
   expect(c.crop.width).toBe(ihdrWidth);
   expect(c.crop.height).toBe(ihdrHeight);
   expect(c.crop.width).toBeLessThan(vw);

   // Decode PNG scanlines to verify the #3b82f6 (RGB 59, 130, 246) mark stroke is visible at the reduced scale.
   const idat:Buffer[]=[];
   let off=8;
   while(off<bytes.length){
    const len=bytes.readUInt32BE(off),type=bytes.toString('ascii',off+4,off+8);
    if(type==='IDAT')idat.push(bytes.subarray(off+8,off+8+len));
    off+=12+len;
   }
   const raw=inflateSync(Buffer.concat(idat)),stride=ihdrWidth*4+1;
   const recon=Buffer.alloc(ihdrHeight*ihdrWidth*4);
   const paeth=(a:number,b:number,c0:number)=>{const p=a+b-c0,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c0);return pa<=pb&&pa<=pc?a:pb<=pc?b:c0;};
   let linkPixels=0;
   for(let y=0;y<ihdrHeight;y++){
    const filter=raw[y*stride]!;
    for(let i=0;i<ihdrWidth*4;i++){
     const v=raw[y*stride+1+i]!,a=i>=4?recon[y*ihdrWidth*4+i-4]!:0,b=y>0?recon[(y-1)*ihdrWidth*4+i]!:0,c0=y>0&&i>=4?recon[(y-1)*ihdrWidth*4+i-4]!:0;
     recon[y*ihdrWidth*4+i]=(v+(filter===1?a:filter===2?b:filter===3?(a+b)>>1:filter===4?paeth(a,b,c0):0))&0xff;
    }
    for(let x=0;x<ihdrWidth;x++){
     const idx=(y*ihdrWidth+x)*4;
     if(recon[idx]===59&&recon[idx+1]===130&&recon[idx+2]===246&&recon[idx+3]===255)linkPixels++;
    }
   }
   const paddedSide=f.summary.includes('point')?48:vw;
   expect(linkPixels).toBeGreaterThan(10);
   console.log('CROP_FIT_MEASUREMENT '+JSON.stringify({summary:f.summary,width:c.crop.width,height:c.crop.height,scale:+(c.crop.width/paddedSide).toFixed(6),dataUrlChars:c.crop.png.length,linkPixels}));
  }
 }finally{ui.cleanup();}
});
