/** Explicit actual-browser acceptance for #215. Requires an installed Playwright module and Chromium. */
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {inspectionControl,fixedTimes,matrixAnimations} from '../tests/helpers/animation-inspection.ts';
const fieldsSupported=(name:string)=>['rotate','translate','translatex','translatey','scale','scalex','scaley','shear','shearx','sheary'].includes(name);
const args=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i]!,process.argv[i+1]!);
const out=resolve(args.get('--out')??'.review-state/215/browser-evidence'),synthetic=!args.has('--package'),focused=args.get('--focused')==='paused-clip';await mkdir(out,{recursive:true});
let input=resolve(args.get('--package')??join(out,'package'));
if(synthetic){
 await mkdir(input,{recursive:true});const control=await inspectionControl(),doc=JSON.parse(await readFile('tests/fixtures/strip-probe/build/skeleton.model.json','utf8'));
 Object.assign(doc.bones[1],control.bones[1],{name:'rigid',parent:'root'});doc.animations=control.animations;doc.animations[0].bones[0].name='rigid';doc.animations[0].slots=[{name:'rigid',timelines:[{name:'attachment',keys:[{time:0,name:'rigid'},{time:2,name:null}]}]}];doc.animations.push(...matrixAnimations('rigid'));doc.editorOrder.animations=doc.animations.map((a:any)=>a.name);
 doc.slots.push({name:'empty',bone:'rigid',setup:null});await writeFile(join(input,'skeleton.model.json'),JSON.stringify(doc));for(const name of ['rigid.png','mesh.png'])await cp('tests/fixtures/strip-probe/build/'+name,join(input,name));
 await writeFile(join(input,'review.json'),JSON.stringify({schema:'rig-review/1',id:'inspection-control',title:'Synthetic inspection controls',revision:'1',model:'skeleton.model.json',animations:[{id:'control',label:'Control'}]}));
}
const p=await loadReview(input),raw=JSON.parse(await readFile(join(p.root,p.manifest.model!),'utf8')),animation=args.get('--animation')??(synthetic?'control':'hello'),before=p.sourceHash;
const app=await startServer(p,{port:0,stateDir:join(out,'state'),initialAnimation:animation});
const moduleName=args.get('--playwright-module')??'playwright',pw=await import(moduleName.startsWith('/')?pathToFileURL(moduleName).href:moduleName);
const browser=await pw.chromium.launch({headless:true,...(args.get('--browser-executable')?{executablePath:args.get('--browser-executable')}:{})}),context=await browser.newContext({viewport:{width:1700,height:1100}}),page=await context.newPage();
const failures:string[]=[],errors:string[]=[],report:Record<string,unknown>={status:'running',kind:synthetic?'synthetic actual browser':'public getting-started actual browser',sourceHash:before,modelSha256:p.reviewedSource.rig?.sha256,browser:browser.version(),animation};
page.on('pageerror',(e:Error)=>errors.push(e.message));
const oracle=await Bun.build({entrypoints:['scripts/animation-inspection-browser-oracle.ts'],target:'browser',format:'esm'});if(!oracle.success)throw new Error(oracle.logs.map(l=>l.message).join('\n'));const oracleText=await oracle.outputs[0]!.text();
async function inspectionBundle(plant:boolean|string=false){
 const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'inspection-acceptance-only',setup(build){build.onLoad({filter:/(?:web\/main|src\/animation-inspection)\.ts$/},async({path})=>{let source=await readFile(path,'utf8');if(path.endsWith('/web/main.ts'))source+='\nObject.assign(window,{__testSwap:swapRig,__testDraw:drawRig,__testHeld:()=>({time:player?.time,animation:player?.current,playing})});';else if(plant==='recurrence'){if(!source.includes('(p0-2*p1+p2)*0.03'))throw new Error('RECURRENCE_TARGET_NOT_FOUND');source=source.replace('(p0-2*p1+p2)*0.03','(p0-2*p1+p2)*0.031');}else if(plant){const original="return {name,duration:typeof a.duration==='number'?a.duration:0,bones,slots,tracks};";if(!source.includes(original))throw new Error('PLANT_TARGET_NOT_FOUND');source=source.replace(original,"return {name,duration:typeof a.duration==='number'?a.duration:0,bones,slots,tracks:tracks.map(track=>({...track,keys:track.keys.map(k=>({...k,curve:Array.isArray(k.curve)?[...k.curve.slice(2,4),...k.curve.slice(0,2),...k.curve.slice(4)]:k.curve}))}))};");}if(args.get('--binding-order-plant')==='true'&&path.endsWith('/web/main.ts'))source=source.replace('player!.pause();refreshAnimationInspection();player!.draw();','player!.pause();player!.draw();');return {contents:source,loader:'ts'};});}}]});if(!built.success)throw new Error(built.logs.map(l=>l.message).join('\n'));return built.outputs[0]!.text();
}
const normalBundle=await inspectionBundle();await page.route('**/main.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:normalBundle}));
const controlsBundle=await Bun.build({entrypoints:['scripts/animation-inspection-panel-controls.ts'],target:'browser',format:'esm'});if(!controlsBundle.success)throw new Error('PANEL_CONTROLS_BUNDLE_FAILED');await page.route('**/215-panel-controls.js',async(route:any)=>route.fulfill({contentType:'text/javascript',body:await controlsBundle.outputs[0]!.text()}));
await page.route('**/215-oracle.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:oracleText}));
try{
 await page.goto(`http://127.0.0.1:${app.port}/`);await page.waitForFunction(()=>document.querySelectorAll('.animation-key').length>0||document.body.textContent?.includes('Rig load failed'),null,{timeout:30000});
 if(!await page.locator('.animation-key').count())throw new Error('RIG_NOT_READY: '+await page.locator('#rig-empty').textContent());
 await page.locator('[data-mode="playback"]').click();await page.locator('.workspace-inspectorHeight').focus();for(let i=0;i<7;i++)await page.keyboard.press('Shift+ArrowUp');await page.locator('#animation-inspection').scrollIntoViewIfNeeded();
 // No seek, repose or transport refresh is allowed between clip choice and these held-frame checks.
 const pausedClip=async(label:string)=>{
  const before=await page.evaluate(()=>(window as any).__testHeld());
  if(before.playing||before.time!==0)throw new Error('CLIP_NOT_PAUSED_AT_START '+label);
  if(await page.locator('#rig-viewport').getAttribute('data-held-frame')!=='available')throw new Error('PAUSED_CLIP_FRAME_UNAVAILABLE '+label);
  await page.locator('[data-animation-view="tree"]').click();
  const boneName=raw.bones.some((b:any)=>b.name==='chest')?'chest':raw.slots.find((s:any)=>s.setup)?.bone??raw.bones[0].name;
  await page.locator(`[data-tree-kind="bone"][data-tree-name="${boneName}"]`).click();
  const marker=page.locator(`.animation-bone-pick[data-bone="${boneName}"][aria-pressed="true"]`);
  if(!await marker.isVisible())throw new Error('PAUSED_CLIP_SELECTED_MARKER_MISSING '+label);
  const related=await page.locator('[data-part-list] button[data-bone-selected="true"]').evaluateAll((nodes:HTMLElement[])=>nodes.map(n=>n.dataset.slot));
  if(JSON.stringify(related.sort())!==JSON.stringify(raw.slots.filter((s:any)=>s.bone===boneName).map((s:any)=>s.name).sort()))throw new Error('PAUSED_CLIP_RELATIONS_DIFFER');
  await page.locator('[data-part-whole]').click();
  const point=await page.evaluate((slots:string[])=>{const editor=(window as any).rigReviewEditor,box=document.getElementById('rig-viewport')!.getBoundingClientRect();for(const slot of slots.slice().reverse()){const row=editor.posed(slot);if(!row)continue;const points=row.kind==='region'?row.corners:row.kind==='mesh'?row.triangles.slice(0,3).flatMap((i:number)=>[row.vertices[i*2],row.vertices[i*2+1]]):[];if(!points.length)continue;let x=0,y=0;for(let i=0;i<points.length;i+=2){x+=points[i];y+=points[i+1];}const p=editor.screen(x/(points.length/2),y/(points.length/2));if(p.x>box.left+12&&p.x<box.right-12&&p.y>box.top+12&&p.y<box.bottom-12)return p;}return null;},raw.slots.map((s:any)=>s.name));
  if(!point)throw new Error('PAUSED_CLIP_NO_SLOT_PROBE');await page.mouse.click(point.x,point.y);
  if(await page.locator('#rig-viewport').getAttribute('data-selected-kind')!=='slot'||!await page.locator('[data-tree-kind="slot"][aria-pressed="true"]').count())throw new Error('PAUSED_CLIP_SLOT_PICK_FAILED '+label);
  const after=await page.evaluate(()=>(window as any).__testHeld());if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('PAUSED_CLIP_PICK_CHANGED_TIME '+label);
  await page.locator('[data-part-whole]').click();return {label,animation:after.animation,time:after.time,playing:after.playing,selectedBone:boneName,stageMarker:true,stageSlot:true,boneRelations:true,noSeekOrRepose:true};
 };
 report.pausedClips=[await pausedClip('initial load')];
 // Hold both clips deliberately: idle-repeat otherwise starts the guide's idle by design.
 if(await page.locator('#idle-repeat').isChecked())await page.locator('label').filter({has:page.locator('#idle-repeat')}).click();
 for(const clip of [raw.animations.find((a:any)=>a.name!==animation)?.name,animation].filter(Boolean)){
  await page.selectOption('#animation-select',clip);(report.pausedClips as unknown[]).push(await pausedClip('paused clip change'));
 }
 await page.locator('[data-animation-view="timeline"]').click();
 const source=raw.animations.find((a:any)=>a.name===animation),expected=source.bones.flatMap((b:any)=>b.timelines.flatMap((t:any)=>t.keys.map((k:any,i:number)=>['bone',b.name,t.name,i,k.time]))).concat(source.slots.flatMap((b:any)=>b.timelines.flatMap((t:any)=>t.keys.map((k:any,i:number)=>['slot',b.name,t.name,i,k.time]))));
 const marks=()=>page.locator('.animation-key').evaluateAll((nodes:HTMLElement[])=>nodes.map(n=>[n.dataset.targetKind,n.dataset.target,n.dataset.timeline,Number(n.dataset.keyIndex),Number(n.dataset.keyTime)]));
 if(JSON.stringify(await marks())!==JSON.stringify(expected))throw new Error('TIMELINE_KEYS_DIFFER');report.timeline={tracks:source.bones.reduce((n:number,b:any)=>n+b.timelines.length,0)+source.slots.reduce((n:number,b:any)=>n+b.timelines.length,0),keys:expected.length,exact:true};
 await page.locator('.animation-key').first().evaluate((n:HTMLElement)=>n.remove());const droppedDetected=JSON.stringify(await marks())!==JSON.stringify(expected);if(!droppedDetected)throw new Error('DROPPED_KEY_NOT_DETECTED');report.droppedKeyPlant={detected:droppedDetected};
 // Restore the real DOM through a real selection change.
 await page.locator('[data-animation-view="tree"]').click();await page.locator('[data-tree-kind="bone"]').first().click();await page.locator('[data-animation-pane="tree"] button').filter({hasText:'Whole rig'}).click();
 if(synthetic){await page.locator('[data-animation-view="timeline"]').click();await page.locator('.animation-lane[data-track*="/slots/"] .animation-lane-label').click();if(!await page.locator('[data-curve-readout]').textContent().then((s:string)=>s.includes('rigid · attachment has no numeric curve evaluator'))||await page.locator('.animation-curve').count())throw new Error('NONNUMERIC_TRACK_SUBSTITUTED');report.nonnumericTrackUnavailable=true;}
 await page.locator('[data-animation-view="curve"]').click();
 const modelUrl=new URL(p.manifest.model!,`http://127.0.0.1:${app.port}/assets/`).href;
 await page.evaluate(async(url:string)=>{const path='/215-oracle.js';const m=await import(path);(window as any).__inspectionOracle=m;await m.open(url);},modelUrl);
 const samples:any[]=[],matrix:any[]=[];let totalChannels=0;
 for(const clip of focused?[]:synthetic?raw.animations:[source]){
  await page.selectOption('#animation-select',clip.name);const options=await page.locator('[data-curve-channel] option').evaluateAll((nodes:HTMLOptionElement[])=>nodes.map(n=>({value:n.value,label:n.textContent})));totalChannels+=options.length;const begin=samples.length;
  for(const option of options){
   const [pointer,channel]=JSON.parse(option.value),segments=pointer.split('/'),bone=raw.animations[Number(segments[2])].bones[Number(segments[4])],track=bone.timelines[Number(segments[6])],duration=await page.evaluate((name:string)=>(window as any).__inspectionOracle.duration(name),clip.name),times=fixedTimes(track.keys,duration);
   await page.selectOption('[data-curve-channel]',option.value);
   const fields:Record<string,string[]>={rotate:['value'],translate:['x','y'],translatex:['value'],translatey:['value'],scale:['x','y'],scalex:['value'],scaley:['value'],shear:['x','y'],shearx:['value'],sheary:['value']},field=fields[track.name]![channel]!;
   const stored=track.keys.slice(0,-1).map((k:any,i:number)=>({from:[k.time,k[field]],to:[track.keys[i+1].time,track.keys[i+1][field]],curve:Array.isArray(k.curve)?k.curve.slice(channel*4,channel*4+4):k.curve??'linear'}));
   const drawn=await page.locator('.animation-curve').evaluateAll((nodes:SVGElement[])=>nodes.map(n=>({stored:JSON.parse(n.dataset.stored!),d:n.getAttribute('d')})));
   if(JSON.stringify(drawn.map((d:any)=>d.stored))!==JSON.stringify(stored))throw new Error('STORED_SVG_CONTROLS_DIFFER');
   const values=track.keys.map((k:any)=>k[field]);for(const segment of stored)if(Array.isArray(segment.curve))values.push(segment.curve[1],segment.curve[3]);const low=Math.min(...values),span=Math.max(...values)-low||1,end=Math.max(duration,track.keys.at(-1).time,Number.MIN_VALUE),plot=(t:number,v:number)=>({x:48+t/end*728,y:195-(v-low)/span*160});
   const paths=stored.map((segment:any)=>{const a=plot(segment.from[0],segment.from[1]),b=plot(segment.to[0],segment.to[1]);let d=`M${a.x} ${a.y}`;if(Array.isArray(segment.curve)){const c=plot(segment.curve[0],segment.curve[1]),e=plot(segment.curve[2],segment.curve[3]);d+=` C${c.x} ${c.y} ${e.x} ${e.y} ${b.x} ${b.y}`;}else d+=segment.curve==='stepped'?` H${b.x} V${b.y}`:` L${b.x} ${b.y}`;return d;});if(JSON.stringify(drawn.map((d:any)=>d.d))!==JSON.stringify(paths))throw new Error('STORED_SVG_PATH_DIFFER');

   const result=await page.evaluate(({times,animation}:any)=>{
    const values:any[]=[],field=document.querySelector<HTMLInputElement>('[data-curve-time]')!,seek=document.querySelector<HTMLButtonElement>('[data-curve-seek]')!,read=document.querySelector<HTMLOutputElement>('[data-curve-readout]')!,oracle=(window as any).__inspectionOracle;
    const bytes=(v:number)=>Array.from(new Uint8Array(new Float64Array([v]).buffer)).join(',');
    for(const requested of times){field.value=String(requested);seek.click();const d={...read.dataset},actual=Number(d.localValue),reference=oracle.sample(animation,d.bone,requested),expected=reference.values[d.property!];
     const ok=bytes(actual)===bytes(expected)&&Number(d.time)===reference.time&&read.textContent!.includes(`authored local: ${d.localValue}`);values.push({animation,requested,time:Number(d.time),bone:d.bone,property:d.property,displayed:actual,expected,displayedBits:bytes(actual),expectedBits:bytes(expected),ok});if(!ok)break;
    }return values;
   },{times,animation:clip.name});samples.push(...result);if(result.some((r:any)=>!r.ok)){failures.push('CURVE_RUNTIME_VALUES_DIFFER '+clip.name+' '+option.label);break;}
   console.log(JSON.stringify({completedChannel:option.label,animation:clip.name,samples:result.length}));
  }matrix.push({animation:clip.name,channels:options.length,samples:samples.length-begin});if(failures.length)break;
 }
 report.curve={skipped:focused?'focused paused-clip validation; reuse frozen scalar receipts':false,channels:totalChannels,samples:samples.length,tolerance:0,matrix,failed:samples.filter(x=>!x.ok)};await writeFile(join(out,'samples.json'),JSON.stringify(samples)+'\n');await page.selectOption('#animation-select',animation);
 // Each actual selection surface drives the other two; bone-without-slots and Whole remain explicit.
 const slot=raw.slots.find((s:any)=>s.setup)?.name??raw.slots[0]?.name,bone=raw.slots.find((s:any)=>s.name===slot)?.bone;
 await page.locator('[data-animation-view="tree"]').click();
 if(slot&&bone){
  const assertSelection=async(kind:string,name:string)=>{const state=await page.evaluate(()=>({stage:{...document.getElementById('rig-viewport')!.dataset},panel:{...document.getElementById('animation-inspection')!.dataset},parts:[...document.querySelectorAll<HTMLElement>('[data-part-list] button[aria-pressed="true"]')].map(n=>n.dataset.slot),lanes:[...document.querySelectorAll<HTMLElement>('.animation-key-lane')].map(n=>n.dataset.track),related:[...document.querySelectorAll<HTMLElement>('[data-part-list] button[data-bone-selected="true"]')].map(n=>n.dataset.slot),tree:[...document.querySelectorAll<HTMLElement>('[data-tree-kind][aria-pressed="true"]')].map(n=>({kind:n.dataset.treeKind,name:n.dataset.treeName}))}));if(state.stage.selectedKind!==kind||state.stage.selectedName!==name||state.panel.selectedKind!==kind||state.panel.selectedName!==name||state.tree.length!==1||state.tree[0]!.name!==name||kind==='slot'&&state.parts[0]!==name)throw new Error('SELECTION_SYNC_DIFFER '+JSON.stringify(state));const group=kind==='bone'?'bones':'slots',targets=source[group],wanted=targets.flatMap((b:any,i:number)=>b.name===name?b.timelines.map((_t:any,j:number)=>`/animations/${raw.animations.indexOf(source)}/${group}/${i}/timelines/${j}`):[]);if(JSON.stringify(state.lanes)!==JSON.stringify(wanted))throw new Error('TIMELINE_FILTER_DIFFER');if(kind==='bone'&&JSON.stringify(state.related.slice().sort())!==JSON.stringify(raw.slots.filter((s:any)=>s.bone===name).map((s:any)=>s.name).sort()))throw new Error('PARTS_BONE_HIGHLIGHT_DIFFER');};
  await page.locator(`[data-tree-kind="slot"][data-tree-name="${slot}"]`).click();await assertSelection('slot',slot);
  await page.locator('[data-part-whole]').click();await page.locator(`[data-part-list] button[data-slot="${slot}"]`).click();await assertSelection('slot',slot);
  await page.locator(`[data-tree-kind="bone"][data-tree-name="${bone}"]`).click();await assertSelection('bone',bone);
  await page.locator('[data-part-search]').fill(slot);if(await page.locator(`[data-part-list] button[data-slot="${slot}"]`).getAttribute('data-bone-selected')!=='true')throw new Error('BONE_HIGHLIGHT_LOST_ON_SEARCH');await page.locator('[data-part-search]').fill('');await assertSelection('bone',bone);
  await page.locator('label').filter({has:page.locator('#layer-bones')}).click();await page.locator('[data-part-whole]').click();const reachable=await page.evaluate((source:any)=>[...document.querySelectorAll<HTMLElement>('.animation-bone-pick')].filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===n;}).sort((a,b)=>Number(source.bones.some((t:any)=>t.name===b.dataset.bone))-Number(source.bones.some((t:any)=>t.name===a.dataset.bone)))[0]?.dataset.bone,source);if(!reachable)throw new Error('NO_REACHABLE_STAGE_BONE');await page.locator(`.animation-bone-pick[data-bone="${reachable}"]`).click();await assertSelection('bone',reachable);
  const attached=await page.locator('[data-part-list] button[data-bone-selected="true"]').evaluateAll((nodes:HTMLElement[])=>nodes.map(n=>n.dataset.slot));
  if(JSON.stringify(attached.slice().sort())!==JSON.stringify(raw.slots.filter((s:any)=>s.bone===reachable).map((s:any)=>s.name).sort()))throw new Error('BONE_PART_RELATION_DIFFER');
  // A disconnected tree handler must fail the same cross-surface assertion.
  const disconnectedName=raw.bones.find((b:any)=>b.name!==reachable).name,target=page.locator(`[data-tree-kind="bone"][data-tree-name="${disconnectedName}"]`);await target.evaluate((n:HTMLElement)=>n.addEventListener('click',e=>{e.stopImmediatePropagation();n.setAttribute('aria-pressed','true');},{capture:true,once:true}));await target.click();let disconnected=false;try{await assertSelection('bone',disconnectedName);}catch{disconnected=true;}if(!disconnected)throw new Error('DISCONNECTED_SELECTION_NOT_DETECTED');
  await target.click();await assertSelection('bone',disconnectedName);await page.locator('[data-part-whole]').click();
  // Drive a part pick by an actual pointer on a visible held primitive, independent of the tree/Parts callbacks.
  if(await page.locator('#layer-bones').isChecked())await page.locator('label').filter({has:page.locator('#layer-bones')}).click();
  const point=await page.evaluate((slots:string[])=>{const editor=(window as any).rigReviewEditor,box=document.getElementById('rig-viewport')!.getBoundingClientRect();for(const slot of slots.slice().reverse()){const row=editor.posed(slot);if(!row)continue;const points=row.kind==='region'?row.corners:row.kind==='mesh'?row.triangles.slice(0,3).flatMap((i:number)=>[row.vertices[i*2],row.vertices[i*2+1]]):[];if(!points.length)continue;let x=0,y=0;for(let i=0;i<points.length;i+=2){x+=points[i];y+=points[i+1];}const p=editor.screen(x/(points.length/2),y/(points.length/2));if(p.x>box.left+12&&p.x<box.right-12&&p.y>box.top+12&&p.y<box.bottom-12)return p;}return null;},raw.slots.map((s:any)=>s.name));
  if(!point)throw new Error('NO_STAGE_PART_PROBE');await page.mouse.click(point.x,point.y);const picked=await page.locator('#rig-viewport').getAttribute('data-selected-name');await assertSelection('slot',picked!);
  report.selection={tree:true,parts:true,stageBone:true,reachableBone:reachable,stageSlot:true,boneRelations:true,disconnectedPlantDetected:disconnected};
 }
 report.frameTransitions=await page.evaluate(async({raw,animation}:any)=>{const path='/215-panel-controls.js',module=await import(path);return module.frameTransitions(raw,animation);},{raw,animation});
 const unavailable=()=>page.evaluate(()=>({keys:document.querySelectorAll('.animation-key').length,tree:document.querySelectorAll('[data-tree-kind]').length,handles:document.querySelectorAll('.animation-bone-pick').length,local:document.querySelector<HTMLElement>('[data-curve-readout]')!.dataset.localValue,status:document.querySelector('[data-inspection-status]')!.textContent}));
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>{release=r;}),requested=new Promise<void>(r=>{entered=r;});const delayed=modelUrl+'?pending-test';await page.route(delayed,async(route:any)=>{entered();await held;await route.continue();});
 await page.evaluate(({url,hash}:any)=>{(window as any).__pendingSwap=(window as any).__testSwap(url,'/assets/',hash);},{url:delayed,hash:p.reviewedSource.rig!.sha256});await requested;
 await page.locator('#scrub').evaluate((n:HTMLInputElement)=>{n.value='0';n.dispatchEvent(new Event('input',{bubbles:true}));});const pending=await unavailable();release();await page.evaluate(()=>(window as any).__pendingSwap);
 if(pending.keys||pending.tree||pending.handles||pending.local!==undefined||!pending.status?.includes('SOURCE_PENDING'))throw new Error('PENDING_SOURCE_RESTORED_STALE_UI');
 const failed=modelUrl+'?failure-test';await page.route(failed,(route:any)=>route.abort());await page.evaluate(async({url,hash}:any)=>{try{await (window as any).__testSwap(url,'/assets/',hash);}catch{}},{url:failed,hash:p.reviewedSource.rig!.sha256});const refused=await unavailable();if(refused.keys||refused.tree||refused.handles||!refused.status?.includes('SOURCE_FAILED'))throw new Error('FAILED_SOURCE_RESTORED_STALE_UI');
 await page.evaluate(async({url,hash}:any)=>{await (window as any).__testSwap(url,'/assets/',hash);try{(window as any).__testDraw(()=>{throw new Error('Controlled draw failure');});}catch{}},{url:modelUrl,hash:p.reviewedSource.rig!.sha256});if(await page.locator('.animation-bone-pick').count())throw new Error('DRAW_FAILURE_RETAINED_HANDLES');await page.evaluate(async({url,hash}:any)=>(window as any).__testSwap(url,'/assets/',hash),{url:modelUrl,hash:p.reviewedSource.rig!.sha256});report.sourceTransitions={delayedSwap:true,transportDuringPending:true,failedLoadUnavailable:true,drawFailureClearsPicking:true};
 if(!focused&&synthetic&&animation==='control')for(const plantKind of ['swap','recurrence']){
  const plantContext=await browser.newContext({viewport:{width:1700,height:1100}}),plantPage=await plantContext.newPage(),planted=await inspectionBundle(plantKind);
  try{await plantPage.route('**/main.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:planted}));await plantPage.route('**/215-oracle.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:oracleText}));await plantPage.goto(`http://127.0.0.1:${app.port}/`);await plantPage.waitForFunction(()=>document.querySelectorAll('.animation-key').length>0);await plantPage.locator('[data-mode="playback"]').click();await plantPage.locator('[data-animation-view="curve"]').click();
   const plant=await plantPage.evaluate(async({url,animation}:any)=>{const path='/215-oracle.js',oracle=await import(path);await oracle.open(url);const field=document.querySelector<HTMLInputElement>('[data-curve-time]')!;field.value='.375';document.querySelector<HTMLButtonElement>('[data-curve-seek]')!.click();const read=document.querySelector<HTMLElement>('[data-curve-readout]')!,d={...read.dataset},actual=Number(d.localValue),expected=oracle.sample(animation,d.bone,.375).values[d.property!];oracle.close();return {code:'CURVE_RUNTIME_VALUES_DIFFER',displayed:actual,expected,detected:!Object.is(actual,expected),displayedText:read.textContent};},{url:modelUrl,animation});if(!plant.detected)throw new Error('DISPLAYED_BEZIER_PLANT_NOT_DETECTED');report[plantKind==='swap'?'swappedBezierPlant':'recurrenceConstantPlant']=plant;
  }finally{await plantContext.close();}
 }
 // Screenshots are receipts from this real page, never illustrations or fixture stand-ins.
 for(const [view,file]of [['timeline','timeline.png'],['curve','curve.png'],['tree','bone-tree.png']]){
  await page.selectOption('#animation-select',animation);await page.locator('[data-part-whole]').click();await page.locator('[data-animation-view="'+view+'"]').click();
  if(view==='curve'){const ci=raw.animations.findIndex((a:any)=>a.bones.some((b:any)=>b.timelines.some((t:any)=>fieldsSupported(t.name)&&t.keys.some((k:any)=>Array.isArray(k.curve)))));if(ci>=0){const a=raw.animations[ci],bi=a.bones.findIndex((b:any)=>b.timelines.some((t:any)=>fieldsSupported(t.name)&&t.keys.some((k:any)=>Array.isArray(k.curve)))),ti=a.bones[bi].timelines.findIndex((t:any)=>fieldsSupported(t.name)&&t.keys.some((k:any)=>Array.isArray(k.curve)));await page.selectOption('#animation-select',a.name);await page.selectOption('[data-curve-channel]',JSON.stringify([`/animations/${ci}/bones/${bi}/timelines/${ti}`,0]));await page.locator('[data-curve-time]').fill('.375');await page.locator('[data-curve-seek]').click();report.curveScreenshotAnimation=a.name;}}
  if(view==='tree'){const target=raw.bones.find((b:any)=>raw.slots.filter((s:any)=>s.bone===b.name).length>1)?.name??bone;if(target){await page.locator(`[data-tree-kind="bone"][data-tree-name="${target}"]`).click();if(!await page.locator(`.animation-bone-pick[data-bone="${target}"][aria-pressed="true"]`).isVisible())throw new Error('TREE_SCREENSHOT_SELECTED_MARKER_MISSING');}}
  await page.locator('#animation-inspection').evaluate((node:HTMLElement)=>{const panel=document.getElementById('inspector-playback')!,row=panel.querySelector('.block-row')!;panel.scrollTop+=node.getBoundingClientRect().top-panel.getBoundingClientRect().top-row.getBoundingClientRect().height-8;});await page.screenshot({path:join(out,file)});
 }
 await page.evaluate(()=>(window as any).__inspectionOracle.close());
 report.errors=errors;if(errors.length)failures.push('BROWSER_ERRORS');if((await loadReview(input)).sourceHash!==before)failures.push('SOURCE_CHANGED');report.immutable=failures.every(x=>x!=='SOURCE_CHANGED');report.failures=failures;
 if(failures.length)throw new Error(failures.join('\n'));report.status='passed';
}catch(error){report.status='failed';failures.push(String(error));report.error=String(error);await writeFile(join(out,'failed-page.txt'),await page.locator('body').innerText());await page.screenshot({path:join(out,'failure.png')});throw error;}finally{report.failures=failures;report.errors=errors;await writeFile(join(out,'browser.json'),JSON.stringify(report,null,2)+'\n');await browser.close();await app.stop(true);}
console.log(JSON.stringify(report));
