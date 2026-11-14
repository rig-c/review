import {writeRigDifferencePackages} from './helpers/rig-difference-package.ts';
import {instrumentRigMount} from './helpers/mount-probe.ts';
/** #739 ordinary Nova proof. Default packages are generated from small public inputs. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {loadReview} from '../src/manifest.ts';
import {createReviewRequestContext} from '../src/server.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
const arg=(key:string)=>{const i=Bun.argv.indexOf(key);return i<0?undefined:Bun.argv[i+1];};
const output=resolve(arg('--out')??'artifacts/rig-difference-739');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'rig-difference-739-'));process.env.RIG_REVIEW_STATE_DIR=join(root,'state');
let page:InputCdpSession|undefined;
const servers:{stop(close?:boolean):unknown}[]=[],report:Record<string,unknown>={};
const probe=`
Object.assign(window,{__difference739:{
 state:()=>({active:!!rigDifference,wholeRig:hostStage()?.wholeRig,selection:parts?.value()??null,slots:player?.slots,current:player?.current,time:player?.time,generation:player?.generation,layers:{...layers},camera:structuredClone(viewport.state),numeric:numericView(),bookmark:inspectionBookmark(),refusal:commentCaptureRefusal(),hidden:[...el('rig-root').children].map(n=>({tag:n.tagName,id:n.id,hidden:n.hidden})),message:sourceTextContent(el('message'))}),
 oracle:()=>{const image=el('reference-content').querySelector('img'),still=captureRigRestStill(assets,{width:image.naturalWidth,height:image.naturalHeight}),canvas=document.createElement('canvas');canvas.width=still.width;canvas.height=still.height;canvas.getContext('2d').drawImage(image,0,0);const a=still.getContext('2d').getImageData(0,0,still.width,still.height).data,b=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0,compared=0;for(let i=0;i<a.length;i+=4){if(!a[i+3])continue;compared++;if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])count++;}return {count,compared,width:still.width,height:still.height,png:still.toDataURL('image/png')};},
 difference:()=>{const c=document.getElementById('rig-difference-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let red=0;for(let i=0;i<d.length;i+=4)if(d[i]>0&&d[i+1]===0&&d[i+2]===0)red++;return {width:c.width,height:c.height,red};}
}});
`;
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'difference-observation',setup(build){build.onLoad({filter:/web\/main\.ts$/},async({path})=>({loader:'ts',contents:instrumentRigMount(await readFile(path,'utf8'),probe)}));}}]});
assert.ok(built.success,JSON.stringify(built.logs));const bundle=built.outputs[0]!;
async function wait(expression:string,label:string){const end=Date.now()+30000;while(Date.now()<end){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(50);}throw new Error('RIG_DIFFERENCE_WAIT '+label+' '+await page!.evaluate('document.body.innerText'));}
async function settle(){await page!.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function shot(name:string){await writeFile(join(output,name+'.png'),await page!.screenshot());}
async function menu(id:string){await click(page!,'#view-menu summary');await click(page!,'[data-view="'+id+'"]');await settle();}
const state=()=>page!.evaluate<any>('window.__difference739.state()');
async function open(path:string,lang:string){
 const context=await createReviewRequestContext(await loadReview(path),{port:0,bundle,exitOnClose:false,viewOnly:true,stateDir:join(root,'state-'+servers.length)});
 const server=Bun.serve({hostname:'127.0.0.1',port:0,websocket:context.live.websocket,fetch:async(req,srv)=>(await context.handle(req,srv.port,srv))!});servers.push({stop(close){context.stop();server.stop(close);}});
 await page!.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`);
 await wait(`!!window.__difference739&&document.querySelector('#player-state')?.textContent.includes('@rig-c/play')&&!!document.querySelector('#stage-comment-list')`,'loaded rig');
 await click(page!,'[data-mode="playback"]');await settle();
 if(await page!.evaluate(`document.querySelector('#play').textContent==='Ⅱ'`))await click(page!,'#play');
 await click(page!,'[data-mode="rig"]');await settle();
 return server.port;
}
try{
 page=await launchCdpSession(join(root,'profile'));await page.setViewport(1600,1000);
 const fixtures=await writeRigDifferencePackages(root);
 const reference=arg('--miko')??arg('--reference')??fixtures.reference;
 for(const lang of ['en','ko']){
  if(reference){
   await open(reference,lang);await menu('rig');await click(page,'#fit');await click(page,'#zoom-in');
   await click(page,'.layer-toggle:has(#layer-mesh)');await click(page,'.layer-toggle:has(#layer-bones)');await settle();
   const before=await state(),oracle:any=await page.evaluate<any>('window.__difference739.oracle()');
   assert.ok(oracle.compared>0);assert.ok(oracle.count>0);
   await writeFile(join(output,'rest-'+lang+'.png'),Buffer.from(oracle.png.split(',')[1],'base64'));delete oracle.png;
   await menu('difference');const during=await state(),pixels:any=await page.evaluate<any>('window.__difference739.difference()');
   const renderedMessage=await page.evaluate<string>(`document.querySelector('#message').textContent`);
   assert.equal(during.active,true);assert.equal(during.wholeRig,false);assert.match(during.refusal,/RIG_DIFFERENCE_COMMENT_UNAVAILABLE/);
   assert.deepEqual(pixels,{width:oracle.width,height:oracle.height,red:oracle.count});
   assert.match(during.message,new RegExp(String(oracle.count)));assert.match(renderedMessage,lang==='ko'?/차이:/:/Difference:/);assert.deepEqual(during.bookmark,before.bookmark);
   assert.equal(during.current,before.current);assert.equal(during.time,before.time);assert.equal(during.generation,before.generation);assert.deepEqual(during.selection,before.selection);assert.deepEqual(during.layers,before.layers);
   assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('#view-menu [data-view]'),n=>n.dataset.view)`),['compare','reference','rig','difference']);
   await shot('reference-difference-'+lang);await click(page,'#native-one');assert.equal((await state()).numeric.cameras.rig.zoom,1);await click(page,'#fit');await shot('reference-difference-fit-'+lang);
   await menu('rig');const after=await state();assert.equal(after.active,false);assert.equal(after.wholeRig,true);assert.equal(after.refusal,before.refusal);assert.deepEqual(after.layers,before.layers);assert.deepEqual(after.selection,before.selection);
   assert.equal(after.camera.zoom,before.camera.zoom);assert.deepEqual(after.camera.cameraCenter,before.camera.cameraCenter);assert.deepEqual(after.hidden,before.hidden);await shot('restored-rig-'+lang);
   await menu('difference');await click(page,'.layer-toggle:has(#layer-mesh)');await settle();const toolbarExit=await state();
   assert.equal(toolbarExit.active,false);assert.equal(toolbarExit.wholeRig,true);assert.equal(toolbarExit.layers.mesh,!before.layers.mesh);assert.equal(toolbarExit.layers.bones,before.layers.bones);
   assert.equal(toolbarExit.camera.zoom,before.camera.zoom);assert.deepEqual(toolbarExit.camera.cameraCenter,before.camera.cameraCenter);assert.deepEqual(toolbarExit.hidden,before.hidden);assert.deepEqual(toolbarExit.selection,before.selection);
   assert.equal(await page.evaluate(`document.querySelector('[data-view="rig"]').getAttribute('aria-pressed')`),'true');await shot('secondary-toolbar-exit-'+lang);
   await click(page,'.layer-toggle:has(#layer-mesh)');await settle();assert.deepEqual((await state()).layers,before.layers);
   await menu('difference');await menu('reference');assert.equal((await state()).active,false);assert.equal(await page.evaluate(`document.querySelector('#reference-pane').hidden`),false);await shot('restored-reference-'+lang);
   await menu('rig');const row=await page.evaluate<string>(`document.querySelector('[data-part-list] button[data-slot]').dataset.slot`);
   const selector='[data-part-list] button[data-slot='+JSON.stringify(row)+']';await click(page,selector);await settle();const selected=await state();assert.ok(selected.selection);
   await menu('difference');await menu('rig');assert.deepEqual((await state()).selection,selected.selection);assert.equal((await state()).wholeRig,false);await shot('selected-restored-'+lang);
   await menu('difference');await click(page,'[data-mode="playback"]');await settle();assert.equal((await state()).active,false);assert.equal(await page.evaluate(`document.querySelector('[data-view="difference"]').disabled`),true);
   report['reference-'+lang]={before,during,after,oracle,pixels,selected,renderedMessage,toolbarExit};
  }
  const wind=arg('--wind')??fixtures.wind;if(wind){await open(wind,lang);await click(page,'#view-menu summary');const unavailable:{disabled:boolean;reason:string}=await page.evaluate<{disabled:boolean;reason:string}>(`({disabled:document.querySelector('[data-view="difference"]').disabled,reason:document.querySelector('[data-view="difference"]').title})`);assert.equal(unavailable.disabled,true);assert.match(unavailable.reason,/RIG_DIFFERENCE_REFERENCE_UNAVAILABLE/);await shot('wind-no-reference-'+lang);report['wind-'+lang]=unavailable;}
  const mismatch=arg('--mismatch')??fixtures.mismatch;if(mismatch){await open(mismatch,lang);await click(page,'#view-menu summary');const unavailable:{disabled:boolean;reason:string}=await page.evaluate<{disabled:boolean;reason:string}>(`({disabled:document.querySelector('[data-view="difference"]').disabled,reason:document.querySelector('[data-view="difference"]').title})`);assert.equal(unavailable.disabled,true);assert.match(unavailable.reason,/RIG_DIFFERENCE_NATIVE_SCALE/);await shot('native-mismatch-'+lang);report['mismatch-'+lang]=unavailable;}
 }
 // Every refusal/positive case must complete in both languages; an empty run is a failure.
 assert.deepEqual(Object.keys(report).sort(),['mismatch-en','mismatch-ko','reference-en','reference-ko','wind-en','wind-ko'],'RIG_DIFFERENCE_CASES_INCOMPLETE');
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('RIG_DIFFERENCE_739_PASS '+Object.keys(report).join(','));
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),report,state:page?await state().catch(()=>null):null},null,2));if(page)await shot('failure');throw error;}
finally{await page?.close();for(const server of servers)server.stop(true);await rm(root,{recursive:true,force:true});}
