/** Actual-browser #229 acceptance. Run only on the Nova ordinary pool; no synthetic pointer dispatch. */
import {mkdir,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {turnPackage} from '../tests/helpers/turn-pad.ts';
import {loadReview} from '../src/manifest.ts';
import {loadCompare} from '../src/compare.ts';
import {startServer} from '../src/server.ts';
import {startCompareServer} from '../src/compare-server.ts';
const args=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i]!,process.argv[i+1]!);
const out=resolve(args.get('--out')??'.review-state/229/evidence');await mkdir(out,{recursive:true});
const pw=await import(pathToFileURL(resolve(args.get('--playwright-module')??'.review-state/229/tools/node_modules/playwright/index.mjs')).href);
const browser=await pw.chromium.launch({headless:true,args:['--disable-dev-shm-usage','--disable-webgl']}),report:any={status:'running',browser:browser.version(),kind:'synthetic slider/posed geometry control; no artwork quality claim',backendScope:'Chromium with WebGL disabled; published Play Canvas2D fallback',positions:[],controls:[]};
const servers:any[]=[],openPages:any[]=[];let failures:string[]=[];
const milestone=(name:string)=>{report.stage=name;console.log('TURN_BROWSER_STAGE '+name);};
const check=(ok:boolean,why:string)=>{if(!ok)throw new Error(why);};
const near=(a:number,b:number,tol=2e-4)=>Number.isFinite(a)&&Math.abs(a-b)<tol;
async function inventory(path:string):Promise<Record<string,string>> {const result:Record<string,string>={};for(const name of (await readdir(path,{recursive:true})).sort()){const p=join(path,name);if((await stat(p)).isFile())result[name]=createHash('sha256').update(await readFile(p)).digest('hex');}return result;}
async function bundle(compare=false,plant=''){
 const file=compare?'web/compare.ts':'web/main.ts';
 const result=await Bun.build({entrypoints:[file],target:'browser',format:'esm',plugins:[{name:'read-only-acceptance-probes',setup(build){build.onLoad({filter:/(web\/(main|compare|turn-pad))\.ts$/},async({path})=>{
  let source=await readFile(path,'utf8');
  const replace=(from:string,to:string)=>{if(!source.includes(from))throw new Error('PLANT_TARGET_MISSING '+plant);source=source.replace(from,to);};
  if(path.endsWith('/web/turn-pad.ts')&&plant==='pointer')replace("stage.addEventListener('pointermove',move);","void stage; // pointer deliberately disconnected");
  if(path.endsWith('/web/main.ts')){
   if(plant==='adjust')replace('turnAdjust=state.adjust();','turnAdjust=null;');
   source+="\nObject.assign(window,{__turnProbe:()=>({time:player?.time,turn:turnPad?.snapshot()??null,rigid:player?.bone('rigid'),mesh:player?.bone('mesh'),dials:turnPad?.state.dials.map(d=>({axis:d.axis,bone:d.bone,world:player?.bone(d.bone)}))})});";
  }
  if(path.endsWith('/web/compare.ts')){
   if(plant==='compare')replace("players[side]!.adjust=state.adjust(source.filter(d=>dials.some(shared=>shared.axis===d.axis)));","if(side==='a')players[side]!.adjust=state.adjust(source.filter(d=>dials.some(shared=>shared.axis===d.axis)));");
   source+="\nObject.assign(window,{__turnProbe:()=>({ready,seeking,trace,turn:turnPad?.snapshot()??null,a:{time:players.a?.time,rigid:players.a?.bone('rigid'),mesh:players.a?.bone('mesh')},b:{time:players.b?.time,rigid:players.b?.bone('rigid'),mesh:players.b?.bone('mesh')}})});";
  }return {contents:source,loader:'ts'};
 });}}]});check(result.success,'BROWSER_BUNDLE: '+result.logs.map(l=>l.message).join('\n'));return result.outputs[0]!.text();
}
async function pageAt(url:string,compare=false,plant=''){
 const context=await browser.newContext({viewport:{width:1700,height:1100}}),page=await context.newPage(),logs:string[]=[];page.on('pageerror',(e:Error)=>logs.push(e.message));page.on('console',(m:any)=>{if(['warning','error'].includes(m.type()))logs.push(m.type()+': '+m.text());});
 await page.route('**/main.js',(route:any)=>route.fulfill({contentType:'text/javascript',body:body}));const body=await bundle(compare,plant);await page.goto(url);
 await page.waitForFunction(()=>typeof (window as any).__turnProbe==='function'&&!!(window as any).__turnProbe().rigid||typeof (window as any).__turnProbe==='function'&&!!(window as any).__turnProbe().a?.rigid,null,{timeout:30000});
 const opened={context,page,logs};openPages.push(opened);return opened;
}
const probe=async(page:any)=>page.evaluate(()=>(window as any).__turnProbe());
async function move(page:any,n:number,compare=false){const box=await page.locator(compare?'#a-viewport':'#rig-viewport').boundingBox();check(!!box,'STAGE_NOT_VISIBLE');const x=box.x+(box.width-1)*(n+1)/2,y=box.y+(box.height-1)*(1-n)/2;await page.mouse.move(x,y);return {x,y,box};}
function posed(value:any,dials:any,compare=false):boolean {
 const rig=(p:any)=>near(p.rigid.x,-18+.6*dials.yaw)&&near(p.rigid.y,.8*dials.pitch)&&near(p.mesh.rotationX,2.5*dials.body);
 return compare?rig(value.a)&&rig(value.b):rig(value);
}
async function waitPose(page:any,expected:any,compare=false){await page.waitForFunction(({expected,compare}:any)=>{const p=(window as any).__turnProbe(),same=(r:any)=>Math.abs(r.rigid.x-(-18+.6*expected.yaw))<.0002&&Math.abs(r.rigid.y-.8*expected.pitch)<.0002&&Math.abs(r.mesh.rotationX-2.5*expected.body)<.0002;return compare?same(p.a)&&same(p.b):same(p);},{expected,compare},{timeout:4000});}
try{
 milestone('prepare');
 const reference=join(out,'reference.webm');const transcode=Bun.spawn(['ffmpeg','-v','error','-nostdin','-i',resolve('tests/fixtures/strip-probe/reference.mov'),'-c:v','libvpx','-b:v','150k','-pix_fmt','yuv420p',reference],{stdout:'inherit',stderr:'inherit'});check(await transcode.exited===0,'BROWSER_REFERENCE_TRANSCODE');report.reference={original:'tests/fixtures/strip-probe/reference.mov',derived:'reference.webm',codec:'libvpx',sha256:createHash('sha256').update(await readFile(reference)).digest('hex')};
 const a=await turnPackage(join(out,'input-a')),b=await turnPackage(join(out,'input-b'),{yaw:[-10,20],body:'custom_body'}),none=await turnPackage(join(out,'input-none'),{noDials:true});
 const before={a:await inventory(a),b:await inventory(b),none:await inventory(none)},p=await loadReview(a),app=await startServer(p,{port:0,stateDir:join(out,'state-a'),initialAnimation:'inspect'});servers.push(app);const url=`http://127.0.0.1:${app.port}/`;
 milestone('single');
 const normal=await pageAt(url),{page}=normal;await page.locator('#turn-pad').waitFor();
 check(await page.getByRole('spinbutton',{name:'Turn smoothing omega',exact:true}).inputValue()==='20','DEMO_OMEGA_NOT_SHOWN');
 await page.getByRole('checkbox',{name:'Turn smoothing',exact:true}).uncheck();
 for(const n of [-1,-.5,0,.5,1]){
  const point=await move(page,n),expected={yaw:n<0?20*n:40*n,pitch:10*n,body:n<0?6*n:12*n};await waitPose(page,expected);const value=await probe(page),read=await page.locator('[data-turn-axis]').evaluateAll((nodes:HTMLOutputElement[])=>Object.fromEntries(nodes.map(n=>[n.dataset.turnAxis,Number(n.dataset.value)])));
  check(posed(value,expected)&&Object.keys(expected).every(k=>near(read[k],expected[k as keyof typeof expected])),'POINTER_READOUT_POSE_DIVERGED');report.positions.push({n,point,expected,read,actual:value});
  if(Math.abs(n)===1)await page.screenshot({path:join(out,n<0?'minimum.png':'maximum.png')});
 }
 await page.getByRole('button',{name:'Hold',exact:true}).click();const held=await probe(page);await move(page,-1);await page.waitForTimeout(100);check(JSON.stringify((await probe(page)).turn.values)===JSON.stringify(held.turn.values),'HOLD_DRIFT');
 await page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).fill('7.125');await page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).press('Tab');await waitPose(page,{yaw:7.125,pitch:10,body:12});
 await page.getByRole('button',{name:'Reset 0',exact:true}).click();await waitPose(page,{yaw:0,pitch:0,body:0});
 await page.getByRole('button',{name:'Hold',exact:true}).click();await page.getByRole('checkbox',{name:'Turn smoothing',exact:true}).check();await move(page,-1);await page.waitForTimeout(40);const easing=await probe(page);check(easing.turn.values.yaw<0&&easing.turn.values.yaw>-20,'SPRING_NOT_EASED');check(posed(easing,easing.turn.values),'EASED_READOUT_POSE_DIVERGED');await waitPose(page,{yaw:-20,pitch:-10,body:-6});report.easing={omega:20,intermediate:easing};
 await page.getByRole('button',{name:'Hold',exact:true}).click();
 await page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).fill('7.125');await page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).press('Tab');const savedTurn=(await probe(page)).turn;
 await page.getByRole('button',{name:'Write review',exact:true}).click();await page.locator('#feedback-start').fill('0');await page.locator('#feedback-end').fill('0');await page.locator('#feedback-category').selectOption('quality');await page.locator('#feedback-summary').fill('Synthetic angle control');await page.locator('#add-proposal').click();const save=page.waitForResponse((r:any)=>r.url().endsWith('/api/session')&&r.request().method()==='PUT');await page.locator('#save').click();const saved=await(await save).json();check(JSON.stringify(saved.feedback[0]?.context.turn)===JSON.stringify(savedTurn),'FEEDBACK_TURN_DISCONNECTED');
 await page.locator('#review-dialog-close').click();await page.waitForTimeout(350);await page.reload();await page.locator('#turn-pad').waitFor();await page.waitForFunction((wanted:any)=>JSON.stringify((window as any).__turnProbe().turn)===JSON.stringify(wanted),savedTurn,{timeout:10000});check(posed(await probe(page),savedTurn.values),'RELOAD_POSE_DIVERGED');report.savedFeedback=saved.feedback[0];report.reload={sameTurn:true,sameSourceHash:(await loadReview(a)).sourceHash===p.sourceHash};report.singleLogs=normal.logs;check(normal.logs.length===0,'SINGLE_BROWSER_LOGS '+normal.logs.join(';'));
 milestone('no-dial');
 const empty=await startServer(await loadReview(none),{port:0,stateDir:join(out,'state-none'),initialAnimation:'inspect'});servers.push(empty);const no=await pageAt(`http://127.0.0.1:${empty.port}/`);await move(no.page,1);await no.page.waitForTimeout(150);check(await no.page.locator('#turn-pad').count()===0,'NO_DIAL_PAD_SHOWN');check(no.logs.length===0,'NO_DIAL_LOGGED '+no.logs.join(';'));report.noDials={pad:false,logs:no.logs};await no.context.close();
 milestone('compare');
 const comparison=await loadCompare({a,b,reference,animation:'inspect'}),pair=await startCompareServer(comparison,{port:0,stateDir:join(out,'state-pair')});servers.push(pair);const pairUrl=`http://127.0.0.1:${pair.port}/`,paired=await pageAt(pairUrl,true);await paired.page.locator('#turn-pad').waitFor();await paired.page.getByRole('checkbox',{name:'Turn smoothing',exact:true}).uncheck();
 for(const n of [-1,1]){const expected={yaw:n<0?-10:20,pitch:10*n,body:n<0?-6:12};await move(paired.page,n,true);await waitPose(paired.page,expected,true);const actual=await probe(paired.page);check(posed(actual,expected,true),'COMPARE_VALUES_DIVERGED');check(actual.a.time===actual.b.time,'COMPARE_CLOCK_MOVED');await paired.page.screenshot({path:join(out,n<0?'compare-minimum.png':'compare-maximum.png')});report.compare??=[];report.compare.push({n,expected,actual});}
 milestone('compare-feedback-reload');
 await paired.page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).fill('9.25');await paired.page.getByRole('spinbutton',{name:'Turn yaw value',exact:true}).press('Tab');const pairTurn=(await probe(paired.page)).turn;
 await paired.page.locator('[data-inspector=feedback]').click();await paired.page.locator('#side').selectOption('b');await paired.page.locator('#frame-start').fill('0');await paired.page.locator('#frame-end').fill('0');await paired.page.locator('#target-kind').selectOption('rig');await paired.page.locator('#category').selectOption('quality');await paired.page.locator('#summary').fill('Shared angle control');await paired.page.locator('#add-feedback').click();const pairSave=paired.page.waitForResponse((r:any)=>r.url().endsWith('/api/compare/session')&&r.request().method()==='PUT');await paired.page.locator('#submit').click();const pairSaved=await(await pairSave).json();check(JSON.stringify(pairSaved.feedback[0]?.context.turn)===JSON.stringify(pairTurn),'COMPARE_FEEDBACK_TURN_DISCONNECTED');check(JSON.stringify(pairSaved.binding)===JSON.stringify(comparison.response.binding),'COMPARE_FEEDBACK_BINDING_CHANGED');
 await paired.page.waitForTimeout(350);await paired.page.reload();await paired.page.locator('#turn-pad').waitFor();await paired.page.waitForFunction((wanted:any)=>JSON.stringify((window as any).__turnProbe().turn)===JSON.stringify(wanted),pairTurn,{timeout:10000});check(posed(await probe(paired.page),pairTurn.values,true),'COMPARE_RELOAD_POSE_DIVERGED');report.compareSavedFeedback=pairSaved.feedback[0];report.compareReload={sameTurn:true,binding:pairSaved.binding};
 check(paired.logs.length===0,'COMPARE_BROWSER_LOGS '+paired.logs.join(';'));
 milestone('compare-no-common-axis');
 const noCommon=await loadCompare({a,b:none,reference,animation:'inspect'}),noPair=await startCompareServer(noCommon,{port:0,stateDir:join(out,'state-no-pair')});servers.push(noPair);const noAxes=await pageAt(`http://127.0.0.1:${noPair.port}/`,true);await noAxes.page.waitForFunction(()=>(window as any).__turnProbe().ready&&!(window as any).__turnProbe().seeking&&!!(window as any).__turnProbe().trace,null,{timeout:10000});check(await noAxes.page.locator('#turn-pad').count()===0,'COMPARE_NO_COMMON_AXES_PAD');check(noAxes.logs.length===0,'COMPARE_NO_COMMON_AXES_LOGS');report.noCommonAxes={pad:false,logs:noAxes.logs};await noAxes.context.close();
 milestone('disconnect-controls');
 // Read-only in-memory bundle controls: never patch a shared source file in place.
 for(const plant of ['pointer','adjust','compare']){
  const compare=plant==='compare',target=await pageAt(compare?pairUrl:url,compare,plant);await target.page.locator('#turn-pad').waitFor();await target.page.getByRole('checkbox',{name:'Turn smoothing',exact:true}).uncheck();await move(target.page,1,compare);await target.page.waitForTimeout(120);const value=await probe(target.page),expected={yaw:compare?20:40,pitch:10,body:12};const caught=!posed(value,expected,compare);check(caught,'DISCONNECTED_CONTROL_ESCAPED '+plant);report.controls.push({plant,detected:true,expected,actual:value});await target.context.close();
 }
 await normal.context.close();await paired.context.close();
 const after={a:await inventory(a),b:await inventory(b),none:await inventory(none)};check(JSON.stringify(before)===JSON.stringify(after),'SOURCE_BYTES_CHANGED');report.sourceInvariant={before,after,equal:true};report.status='pass';
}catch(error){for(let i=0;i<openPages.length;i++){const active=openPages[i];if(!active.page.isClosed()){report.failureLogs=active.logs;report.failurePage=await active.page.locator('body').innerText().catch(()=>null);await writeFile(join(out,`failure-${i}.html`),await active.page.content().catch(()=>''));await active.page.screenshot({path:join(out,`failure-${i}.png`)}).catch(()=>{});}}report.status='fail';report.error=error instanceof Error?error.stack:String(error);failures.push(report.error);}
finally{await browser.close();for(const server of servers)await server.stop(true);await writeFile(join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({status:report.status,positions:report.positions.length,controls:report.controls.length,error:report.error??null}));if(failures.length)process.exit(1);
