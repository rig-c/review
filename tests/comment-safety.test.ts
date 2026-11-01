import {expect,test} from 'bun:test';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {idlePreviewAdjust} from '../web/preview.ts';
import {requireFeedbackFrames} from '../src/stage-comment.ts';
import {turnPackage} from './helpers/turn-pad.ts';
import {loadCompare} from '../src/compare.ts';
import {freshCompareSession,saveCompareSession} from '../src/compare-session.ts';
const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
function singleHost(patch:Record<string,any>={}){
 let host:any;const scope:any={comments:null,bindStageComments:(h:any)=>{host=h;return {};},el:()=>({parentElement:{},hidden:true,childElementCount:0}),document:{getElementById:()=>null},saving:false,persistence:null,seekingControl:false,video:null,rebuildBusy:false,appliedOnStage:null,stripPending:null,idleAdjust:null,dialAdjust:null,physicsPreview:{read:()=>[]},meshEditor:null,bonesPanel:null,cutsPanel:null,clothPanel:null,meshPanel:null,rigFieldsPanel:null,idlePanel:null,chestRegions:()=>[],chestCircles:()=>[],chestMarkers:()=>[],inspectionBookmark:()=>({}),session:{feedback:[]},submittedBaseline:null,markDirty(){},renderProposals(){},message(){},restoreInspection(){},parseBookmark(){},inspectionBinding(){},playing:false,player:{pause(){}},turnPad:null,playbackIntent:0,desiredPlay:false,suspendedPreview:false,idleHeld:false,lastFrame:0,stopAudio(){},button:()=>({setAttribute(){}}),...patch};
 const pauseLine=source.slice(source.indexOf('function pause():')).split('\n')[0];const start=source.includes('function commentCaptureRefusal(')?source.indexOf('function commentCaptureRefusal('):source.indexOf('function setupComments():');
 const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(pauseLine+'\n'+source.slice(start));new Function('scope',`with(scope){${code};setupComments();}`)(scope);return {host,scope};
}
test('P1 real idle preview survives actual pause and must refuse stage capture by name',async()=>{
 const idleAdjust=idlePreviewAdjust({tracks:1,refusals:[],writes:[{bone:'root',channel:'rotation',prop:'rotate',sine:{amp:5,period:2,phase:0,base:0}}]},{names:['root'],get:()=>({rotation:0})});expect(idleAdjust).not.toBeNull();const {host,scope}=singleHost({idleAdjust});await host.pause();expect(scope.idleAdjust).toBe(idleAdjust);console.log('P1_CALLBACK_STATE '+JSON.stringify({idlePreviewActive:!!scope.idleAdjust,blocked:host.blocked(),refusal:host.refusal?.()??null}));expect(host.refusal?.()).toContain('COMMENT_UNAPPLIED_PREVIEW');
});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAALSURBVAiZY2AAAgAABQABYlUyiAAAAABJRU5ErkJggg==';
async function referenceFixture(fn:(args:{root:string;a:string;b:string;video:string;p:any;feedback:any})=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'comment-reference-strip-'));try{const a=await turnPackage(join(root,'a')),b=await turnPackage(join(root,'b')),video=join(root,'reference.webm');await writeFile(video,'JSON strip control, no decode');for(const dir of [a,b]){const model=JSON.parse(await readFile(join(dir,'skeleton.model.json'),'utf8'));model.animations.find((v:any)=>v.name==='inspect').duration=2;await writeFile(join(dir,'skeleton.model.json'),JSON.stringify(model));await writeFile(join(dir,'report.json'),JSON.stringify({spec:'rig-pose-report/1',animation:'inspect',frameTimes:Array.from({length:49},(_,i)=>i/24)}));const manifest=JSON.parse(await readFile(join(dir,'review.json'),'utf8'));manifest.authoring=[{label:'24Hz producer samples',path:'report.json'}];await writeFile(join(dir,'review.json'),JSON.stringify(manifest));}
 const p=await loadCompare({a,b,reference:video,animation:'inspect'});if(!p.a.reviewedSource.rig||!p.b.reviewedSource.rig)throw Error('test fixture requires both compiled rigs');const sha=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),camera={space:'image',center:{x:50,y:50},zoom:1,viewport:{width:100,height:100},visible:{x:0,y:0,width:100,height:100}},comment={schema:'rig-review-comment/1',mode:'compare',viewport:'reference',frame:{index:30,basis:'reference'},time:1,animation:'inspect',sourceHash:p.a.sourceHash,modelHash:null,referenceHash:p.response.reference.sha256,referenceId:p.response.reference.sha256,camera,screen:{x:50,y:50,width:0,height:0},world:{x:50,y:50,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:{schema:'rig-review-inspection/1',binding:{mode:'compare',sourceHash:p.response.sourceHash,rigs:[p.a.reviewedSource.rig.sha256,p.b.reviewedSource.rig.sha256]},time:1,animation:'inspect',theme:'light',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:null,a:null,b:null,reference:camera}},selection:{reference:p.response.reference.sha256}}};
 const feedback={id:'reference-f30',side:'a',frameStart:30,frameEnd:30,target:{kind:'rig',name:p.a.manifest.id},category:'defect',summary:'Reference F30 at one second',context:{time:1,frame:null,animation:'inspect',comment}};await fn({root,a,b,video,p,feedback});}finally{await rm(root,{recursive:true,force:true});}
}
test('P2 actual CLI refuses decoded reference F30 at1s before24Hz producer strip planning',()=>referenceFixture(async({root,a,b,video,p,feedback})=>{
 const state=join(root,'state');await saveCompareSession(p,{...freshCompareSession(p),feedback:[feedback]},state);const proc=Bun.spawn([process.execPath,'src/cli.ts','strip','compare',a,b,'--reference',video,'--animation','inspect','--all-feedback','--json'],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'}),stdout=await new Response(proc.stdout).text(),stderr=await new Response(proc.stderr).text(),exit=await proc.exited;
 if(exit===0){const plan=JSON.parse(stdout).plan;console.log('P2_BASELINE '+JSON.stringify({referenceIndex:30,commentSeconds:1,producerHz:24,wrongProducerSeconds:plan.groups[0].samples[0].time}));expect(plan.groups[0].samples[0].time).toBe(1.25);}
 expect(stderr).toContain('COMMENT_REFERENCE_STRIP_UNAVAILABLE');expect(exit).not.toBe(0);expect(stdout).toBe('');
}));
test('P1 actual single callback inventories active authoring effects; unchanged forms and inspection remain allowed',()=>{
 const active:[string,Record<string,any>][]=[['Idle tracks',{idleAdjust:()=>{}}],['Rig fields turn dial',{dialAdjust:()=>{}}],['Physics live overrides',{physicsPreview:{read:()=>[{}]}}],['Density strip candidate',{stripPending:{candidate:'unapplied'}}],['Edit Mesh',{meshEditor:{overlay:()=>({})}}],['Bones anchors',{bonesPanel:{overlay:()=>({})}}],['Cuts/patches/joints',{cutsPanel:{overlayRegions:()=>[{}],overlayMarkers:()=>[]}}],['Cuts/patches/joints',{cutsPanel:{overlayRegions:()=>[],overlayMarkers:()=>[{}]}}],['Cloth links',{clothPanel:{overlayRegions:()=>[{}]}}],['Mesh regions',{meshPanel:{overlayRegions:()=>[],overlayCircles:()=>[{}]}}],['Mesh regions',{meshPanel:{overlayRegions:()=>[{}],overlayCircles:()=>[]}}],['Chest regions/landmarks',{chestRegions:()=>[{}]}],['Chest regions/landmarks',{chestCircles:()=>[{}]}],['Chest regions/landmarks',{chestMarkers:()=>[{}]}],['Rig fields stage handles',{rigFieldsPanel:{handles:()=>[{}]}}],['Idle tracks stage handles',{document:{getElementById:()=>({hidden:false,childElementCount:1})}}]];
 for(const [name,patch] of active)expect(singleHost(patch).host.refusal()).toContain('COMMENT_UNAPPLIED_PREVIEW: '+name);
 expect(singleHost({rebuildBusy:true}).host.refusal()).toContain('COMMENT_SOURCE_BUSY');
 expect(singleHost({appliedOnStage:{schema:'scratch'}}).host.refusal()).toContain('COMMENT_APPLIED_BUILD_UNSUPPORTED');
 const normal=singleHost({turnAdjust:()=>{},wind:{strength:20},retargetPanel:{pendingMap:true},idlePanel:{ops:()=>[{}]},meshPanel:{entry:()=>({density:20}),overlayRegions:()=>[],overlayCircles:()=>[]},bonesPanel:{edits:()=>[{}],overlay:()=>null},cutsPanel:{overlayRegions:()=>[],overlayMarkers:()=>[]},clothPanel:{ops:()=>[{}],overlayRegions:()=>[]},rigFieldsPanel:{ops:()=>[{}],handles:()=>[]},document:{getElementById:()=>({hidden:true,childElementCount:3})}});
 expect(normal.host.refusal()).toBeNull();expect(normal.host.blocked()).toBe(false);
});
import {parseStageComment,projectMark,unprojectMark,region,feedbackTimingLabel} from '../src/stage-comment.ts';
import {textEntryFocused} from '../web/view-controls.ts';
const binderSource=await readFile(new URL('../web/stage-comments.ts',import.meta.url),'utf8');
/** Actual event controller with a controlled capture promise, no browser/pixel claim. */
function commentController(initialRows:any[]=[],sourceOverride=binderSource){
 class Node {
  children:any[]=[];parent:any=null;style:any={};dataset:Record<string,string>={};attributes=new Map();listeners=new Map<string,Function[]>();className='';id='';textContent='';title='Comment C';hidden=false;disabled=false;readOnly=false;value='';clientWidth=200;clientHeight=200;clientLeft=0;clientTop=0;captured=new Set();classList={toggle(){}};onclick:any=null;onsubmit:any=null;onkeydown:any=null;
  get offsetWidth(){return 286;}get offsetHeight(){return this.children.some((c:any)=>c.getAttribute?.('role')==='alert'&&c.textContent)?176:108;}
  append(...ns:any[]){for(const n of ns){n.parent=this;this.children.push(n);}}after(...ns:any[]){this.append(...ns);}replaceChildren(...ns:any[]){this.children=[];this.append(...ns);}remove(){if(this.parent)this.parent.children=this.parent.children.filter((n:any)=>n!==this);}setAttribute(k:string,v:string){this.attributes.set(k,v);}getAttribute(k:string){return this.attributes.get(k)??null;}closest(){return null;}focus(){}getBoundingClientRect(){return{left:0,top:0};}addEventListener(k:string,f:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),f]);}removeEventListener(){}async emit(k:string,e:any){await Promise.all((this.listeners.get(k)??[]).map(f=>f(e)));}setPointerCapture(i:number){this.captured.add(i);}hasPointerCapture(i:number){return this.captured.has(i);}releasePointerCapture(i:number){this.captured.delete(i);}
 }
 const toggle=new Node(),toolbar=new Node(),pane=new Node(),win=new Node(),doc:any=new Node();let tick=()=>{},reason:string|null=null,crops=0,restores=0,additions:any[]=[...initialRows],pause:Promise<void>=Promise.resolve(),resolveCrop:(v:any)=>void=()=>{};const messages:string[]=[];
 doc.createElement=()=>new Node();doc.getElementById=(id:string)=>id==='stage-comment'?toggle:null;
 const crop=()=>{crops++;return new Promise(resolve=>{resolveCrop=resolve;});},host={toolbar,viewports:{rig:pane},pose:()=>({mode:'animate',camera:{space:'world',center:{x:0,y:0},zoom:1,viewport:{width:200,height:200},visible:{x:-100,y:-100,width:200,height:200}},frame:{index:0,basis:'producer'},time:0,animation:null,turn:null,sourceHash:'a'.repeat(64),modelHash:null,referenceHash:null,referenceId:null,rig:'control'}),pause:()=>pause,bookmark:()=>({}),restore:async()=>{restores++;},feedback:()=>additions,locked:()=>false,add:(f:any)=>additions.push(f),changed(){},error:(v:string)=>messages.push(v),blocked:()=>false,refusal:()=>reason};
 const helpers=sourceOverride.slice(sourceOverride.indexOf('const markOf='),sourceOverride.indexOf('async function crop(')),body=sourceOverride.slice(sourceOverride.indexOf('export function bindStageComments')).replace('export function','function');const scope={host,crop,document:doc,window:win,requestAnimationFrame:(f:any)=>{tick=f;return 1;},cancelAnimationFrame(){},parseStageComment,projectMark,unprojectMark,region,feedbackTimingLabel,textEntryFocused};const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(helpers+body);const tool=new Function('scope',`with(scope){${code};return bindStageComments(host);}`)(scope);
 const event=()=>({button:0,isPrimary:true,pointerId:7,clientX:50,clientY:50,target:new Node(),preventDefault(){},stopImmediatePropagation(){}}),down=()=>pane.emit('pointerdown',event()),up=()=>pane.emit('pointerup',event()),submit=()=>{const form=pane.children.find((n:any)=>n.className.includes('stage-comment-composer'));form.children[0].value='safe note';return form.onsubmit({preventDefault(){}});};
 const list=()=>toolbar.children.find((n:any)=>n.id==='stage-comment-list');
 return {toggle,toolbar,pane,list,messages,tool,enable:()=>{if(!toggle.disabled)toggle.onclick();},down,up,submit,tick:()=>tick(),setReason:(r:string|null)=>{reason=r;},holdPause:(p:Promise<void>)=>{pause=p;},resolveCrop:()=>resolveCrop({path:'unused',sha256:'a'.repeat(64),png:'private',width:1,height:1}),crops:()=>crops,restores:()=>restores,rows:()=>additions,reasonNote:()=>toggle.children.find((n:any)=>n.id==='stage-comment-refusal')};
}
test('P1 control displays named refusal without disabling the button, cancels enabled capture and never starts a preview crop',async()=>{
 const ui=commentController();try{ui.enable();ui.setReason('COMMENT_UNAPPLIED_PREVIEW: Idle tracks');ui.tick();expect(ui.toggle.disabled).toBe(false);expect(ui.list().hidden).toBe(false);expect(ui.toggle.title).toContain('Idle tracks');expect(ui.reasonNote().hidden).toBe(false);expect(ui.reasonNote().textContent).toContain('COMMENT_UNAPPLIED_PREVIEW');await ui.down();await ui.up();expect(ui.crops()).toBe(0);expect(ui.rows()).toHaveLength(0);expect(ui.tool.active()).toBe(false);ui.setReason(null);ui.tick();expect(ui.toggle.disabled).toBe(false);}finally{ui.tool.dispose();}
});
test('P1 preview arriving during pause refuses before crop and releases only own pointer',async()=>{
 const ui=commentController();try{let release=()=>{};ui.holdPause(new Promise<void>(r=>{release=r;}));ui.enable();ui.pane.setPointerCapture(99);await ui.down();ui.setReason('COMMENT_UNAPPLIED_PREVIEW: Physics live overrides');release();await ui.up();expect(ui.crops()).toBe(0);expect(ui.rows()).toHaveLength(0);expect(ui.pane.hasPointerCapture(7)).toBe(false);expect(ui.pane.hasPointerCapture(99)).toBe(true);expect(ui.messages.join()).toContain('COMMENT_UNAPPLIED_PREVIEW');}finally{ui.tool.dispose();}
});
test('P1 preview arriving during async crop cannot save; normal capture still adds its record',async()=>{
 for(const preview of [false,true]){const ui=commentController();try{ui.enable();await ui.down();await ui.up();expect(ui.crops()).toBe(1);const save=ui.submit();if(preview)ui.setReason('COMMENT_UNAPPLIED_PREVIEW: Density strip candidate');ui.resolveCrop();await save;expect(ui.rows()).toHaveLength(preview?0:1);if(preview){expect(ui.toggle.disabled).toBe(false);expect(ui.reasonNote().textContent).toContain('Density strip');}}finally{ui.tool.dispose();}}
});
test('P2 helper refuses reference-basis on A, B or reference while preserving numeric producer/manual and null-time refusal',()=>{
 for(const viewport of ['a','b','reference'])expect(()=>requireFeedbackFrames({frameStart:30,frameEnd:30,context:{comment:{schema:'rig-review-comment/1',viewport,frame:{index:30,basis:'reference'}}}})).toThrow('COMMENT_REFERENCE_STRIP_UNAVAILABLE');
 for(const context of [undefined,{comment:'legacy text'},{comment:{schema:'rig-review-comment/1',frame:{index:30,basis:'producer'}}}])expect(requireFeedbackFrames({frameStart:30,frameEnd:30,context})).toEqual({frameStart:30,frameEnd:30});
 expect(()=>requireFeedbackFrames({frameStart:null,frameEnd:null})).toThrow('COMMENT_CLOCK_UNAVAILABLE');
});
test('P2 actual single and compare browser batch callbacks refuse before any request for every reference-basis viewport',async()=>{
 for(const page of ['main','compare'])for(const viewport of ['a','b','reference'])for(const format of ['json','png']){const text=await readFile(new URL('../web/'+page+'.ts',import.meta.url),'utf8'),start=text.indexOf('async function exportStrip()'),body=text.slice(start,text.indexOf('\n}',start)+2),messages:string[]=[];let requests=0;const scope={stripBusy:false,stripStatus:(m:string)=>messages.push(m),select:(id:string)=>({value:id==='strip-format'?format:id==='strip-scope'?'feedback':'reference'}),feedbackAnimation:()=> 'inspect',session:{feedback:[{id:'reference-f30',side:'a',frameStart:30,frameEnd:30,context:{animation:'inspect',comment:{schema:'rig-review-comment/1',viewport,frame:{index:30,basis:'reference'},time:1}}}]},data:{animation:'inspect',sourceHash:'a'.repeat(64)},requireFeedbackFrames,updateStripControls(){},access:{route:(v:string)=>v,headers:()=>({})},fetch:async()=>{requests++;throw Error('unexpected producer request');},describe:String,errorText:String};const code=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(body);await new Function('scope',`with(scope){${code};return exportStrip();}`)(scope);expect(requests).toBe(0);expect(messages.join()).toContain('COMMENT_REFERENCE_STRIP_UNAVAILABLE');}
});
test('P2 actual CLI still plans ordinary24Hz, producer-basis and manual intervals without mapping',()=>referenceFixture(async({root,a,b,video,p,feedback})=>{
 const ordinary={...feedback,id:'ordinary',context:{animation:'inspect'}},c=structuredClone(feedback.context.comment);c.viewport='a';c.frame={index:24,basis:'producer'};c.modelHash=p.a.reviewedSource.rig.sha256;c.camera.space='world';c.bookmark.view.cameras={rig:null,a:c.camera,b:null,reference:null};
 const producer={...feedback,id:'producer',frameStart:24,frameEnd:24,context:{animation:'inspect',time:1,comment:c}};
 const figures:any[]=[];
 for(const [label,row,expected] of [['ordinary',ordinary,1.25],['producer',producer,1]] as const){const state=join(root,'state-'+label);await saveCompareSession(p,{...freshCompareSession(p),feedback:[row]},state);const proc=Bun.spawn([process.execPath,'src/cli.ts','strip','compare',a,b,'--reference',video,'--animation','inspect','--all-feedback','--json'],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'}),out=await new Response(proc.stdout).text(),err=await new Response(proc.stderr).text();expect(await proc.exited,err).toBe(0);const actual=JSON.parse(out).plan.groups[0].samples[0].time;expect(actual).toBe(expected);figures.push({label,time:actual});}
 const manual=Bun.spawn([process.execPath,'src/cli.ts','strip','compare',a,b,'--reference',video,'--animation','inspect','--basis','a','--frames','30:30','--json'],{stdout:'pipe',stderr:'pipe'}),out=await new Response(manual.stdout).text(),err=await new Response(manual.stderr).text();expect(await manual.exited,err).toBe(0);expect(JSON.parse(out).plan.groups[0].samples[0].time).toBe(1.25);figures.push({label:'manual',time:1.25});console.log('P2_POSITIVES '+JSON.stringify(figures));
}));
test('P2 actual CLI PNG request refuses the reference basis before native planning/render and writes nothing',()=>referenceFixture(async({root,a,b,video,p,feedback})=>{
 const state=join(root,'state'),output=join(root,'must-not-render.png');await saveCompareSession(p,{...freshCompareSession(p),feedback:[feedback]},state);const proc=Bun.spawn([process.execPath,'src/cli.ts','strip','compare',a,b,'--reference',video,'--animation','inspect','--all-feedback','--out',output],{env:{...process.env,RIG_REVIEW_STATE_DIR:state},stdout:'pipe',stderr:'pipe'}),stdout=await new Response(proc.stdout).text(),stderr=await new Response(proc.stderr).text();expect(await proc.exited).toBe(1);expect(stderr).toContain('COMMENT_REFERENCE_STRIP_UNAVAILABLE');expect(stdout).toBe('');expect(await Bun.file(output).exists()).toBe(false);expect(await Bun.file(output+'.json').exists()).toBe(false);
}));

test('P1 refuses enable when already previewing and invalidates a crop even if preview clears before completion',async()=>{
 const first=commentController();try{first.setReason('COMMENT_UNAPPLIED_PREVIEW: Rig fields turn dial');first.enable();expect(first.tool.active()).toBe(false);expect(first.toggle.disabled).toBe(false);expect(first.list().hidden).toBe(false);expect(first.crops()).toBe(0);}finally{first.tool.dispose();}
 const ui=commentController();try{ui.enable();await ui.down();await ui.up();const save=ui.submit();ui.setReason('COMMENT_UNAPPLIED_PREVIEW: Idle tracks');ui.tick();ui.setReason(null);ui.tick();ui.resolveCrop();await save;expect(ui.rows()).toHaveLength(0);expect(ui.tool.draft()).toBe(false);}finally{ui.tool.dispose();}
});

test('#276 Bar 3: under COMMENT_UNAPPLIED_PREVIEW the list opens, rows restore, placing and editing are refused by name, and a planted button-disabling mutant fails',async()=>{
 const sha=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),camera={space:'world',center:{x:0,y:0},zoom:1,viewport:{width:200,height:200},visible:{x:-100,y:-100,width:200,height:200}},comment={schema:'rig-review-comment/1',mode:'animate',viewport:'rig',frame:{index:0,basis:'producer'},time:0,animation:null,sourceHash:'a'.repeat(64),modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:40,width:0,height:0},world:{x:0,y:0,width:0,height:0},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:{schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:'a'.repeat(64),rigs:[null]},time:0,animation:null,theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'playback'}}};
 const existing={id:'c-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'control'},category:'defect',summary:'Original wrist note',context:{time:0,frame:0,animation:null,comment}};
 const runUnderPreview=async(sourceText:string)=>{
  const ui=commentController([structuredClone(existing)],sourceText);
  try{
   ui.setReason('COMMENT_UNAPPLIED_PREVIEW: Idle tracks');
   ui.tick();
   ui.enable();
   const listOpened=!ui.list().hidden&&!ui.toggle.disabled;
   let restored=0,editRefused=false,placeRefused=false;
   if(listOpened){
    const item=ui.list().children.find((n:any)=>n.className==='stage-comment-item');
    const rowBtn=item?.children[0];
    await rowBtn?.onclick?.();
    restored=ui.restores();
    const form=ui.pane.children.find((n:any)=>n.className.includes('stage-comment-composer'));
    if(form){
     form.children[0].value='Mutated under preview';
     await form.onsubmit({preventDefault(){}});
     const delBtn=form.children.find((n:any)=>n.className==='stage-comment-delete');
     delBtn?.onclick?.();
     editRefused=ui.rows()[0]?.summary==='Original wrist note'&&ui.rows().length===1&&(form.children[2]?.textContent??'').includes('COMMENT_UNAPPLIED_PREVIEW');
    }
    ui.messages.length=0;
    await ui.down();await ui.up();
    placeRefused=ui.crops()===0&&ui.rows().length===1&&ui.messages.some(m=>m.includes('COMMENT_UNAPPLIED_PREVIEW'));
   }
   return {listOpened,disabled:ui.toggle.disabled,restored,editRefused,placeRefused};
  }finally{ui.tool.dispose();}
 };
 const actual=await runUnderPreview(binderSource);
 expect(actual).toEqual({listOpened:true,disabled:false,restored:1,editRefused:true,placeRefused:true});
 const planted=binderSource.replace('toggle.disabled=false;','toggle.disabled=!!reason;');
 expect(planted).not.toBe(binderSource);
 const mutant=await runUnderPreview(planted);
 expect(mutant.disabled).toBe(true);
 expect(mutant.listOpened).toBe(false);
});

test('#276 refusal layout & read-only controls: one-line button without bar shift, post-text measured composer clamping near bottom edge, and Read only · Escape closes hint',async()=>{
 const css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 expect(css).toContain('#stage-comment{white-space:nowrap;flex:none}');
 expect(css).toContain('#stage-comment-refusal{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}');
 expect(css).toContain('.stage-comment-refusal-note{display:block;margin-top:4px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--fg-muted)}');

 const sha=createHash('sha256').update(Buffer.from(png,'base64')).digest('hex'),camera={space:'world',center:{x:0,y:0},zoom:1,viewport:{width:200,height:200},visible:{x:-100,y:-100,width:200,height:200}};
 const bottomComment={schema:'rig-review-comment/1',mode:'animate',viewport:'rig',frame:{index:0,basis:'producer'},time:0,animation:null,sourceHash:'a'.repeat(64),modelHash:null,referenceHash:null,referenceId:null,camera,screen:{x:40,y:190,width:10,height:6},world:{x:0,y:-90,width:10,height:6},slots:[],crop:{path:`comment-crops/${sha}.png`,sha256:sha,png:'data:image/png;base64,'+png,width:1,height:1},bookmark:{schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:'a'.repeat(64),rigs:[null]},time:0,animation:null,theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},selection:{inspector:'playback'}}};
 const existing={id:'bottom-1',frameStart:0,frameEnd:0,target:{kind:'rig',name:'control'},category:'defect',summary:'Bottom hem seam note',context:{time:0,frame:0,animation:null,comment:bottomComment}};
 const refusalReason='COMMENT_UNAPPLIED_PREVIEW: Idle tracks stage handles is active; leave or disable that preview before commenting (nothing is cleared or applied automatically)';

 const evaluateRefusalState=async(sourceText:string)=>{
  const ui=commentController([structuredClone(existing)],sourceText);
  try{
   ui.setReason(refusalReason);
   ui.tick();
   ui.enable();
   const listNote=ui.list().children.find((n:any)=>n.className==='stage-comment-refusal-note');
   const item=ui.list().children.find((n:any)=>n.className==='stage-comment-item');
   await item?.children[0]?.onclick?.();
   const form=ui.pane.children.find((n:any)=>n.className.includes('stage-comment-composer'));
   const topPx=Number.parseFloat(form?.style?.top??'NaN');
   const bottomPx=topPx+(form?.offsetHeight??0);
   const hintText=form?.children[1]?.textContent??'';
   return {
    buttonNowrap:ui.toggle.style.whiteSpace==='nowrap'&&ui.toggle.style.flex==='none',
    barRefusalOutOfFlow:ui.reasonNote()?.style?.position==='absolute'&&ui.reasonNote()?.title===refusalReason,
    listNoteTruncatedWithTitle:listNote?.title===refusalReason&&listNote?.textContent===refusalReason&&listNote?.style?.textOverflow==='ellipsis'&&listNote?.style?.whiteSpace==='nowrap',
    topPx,
    bottomPx,
    fitsInsideStage:topPx>=4&&bottomPx<=ui.pane.clientHeight-4,
    hintText,
   };
  }finally{ui.tool.dispose();}
 };

 const actual=await evaluateRefusalState(binderSource);
 expect(actual.buttonNowrap).toBe(true);
 expect(actual.barRefusalOutOfFlow).toBe(true);
 expect(actual.listNoteTruncatedWithTitle).toBe(true);
 expect(actual.fitsInsideStage).toBe(true);
 expect(actual.bottomPx).toBeLessThanOrEqual(196);
 expect(actual.hintText).toBe('Read only · Escape closes');

 // Planted old control 1 & 2 & 3: fixed 132px height positioned before error.textContent is set, and old hint text.
 const plantedPreTextAndOldHint=binderSource
  .replace("hint.textContent=composerReadOnly?'Read only · Escape closes':'Enter saves · Escape cancels'","hint.textContent=locked?'Submitted · read-only · Escape cancels':'Enter saves · Escape cancels'")
  .replace("const w=form.offsetWidth||294,h=form.offsetHeight||132;Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-w-4))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-h-4))+'px'});","Object.assign(form.style,{left:Math.max(4,Math.min(screen.x+screen.width+8,pane.clientWidth-294))+'px',top:Math.max(4,Math.min(screen.y+screen.height+8,pane.clientHeight-132))+'px'});");
 expect(plantedPreTextAndOldHint).not.toBe(binderSource);
 const oldBehaviour=await evaluateRefusalState(plantedPreTextAndOldHint);
 expect(oldBehaviour.fitsInsideStage).toBe(false);
 expect(oldBehaviour.bottomPx).toBeGreaterThan(200);
 expect(oldBehaviour.hintText).toBe('Enter saves · Escape cancels');
});
