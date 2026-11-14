/** U3, ordinary Nova only. Existing public declared fixtures; external source packages stay outside the repository. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {PNG} from 'pngjs';
import type {JobAct} from '../src/job-contract.ts';
import {parseCommentsAct} from '../src/job-api.ts';
import {resolvedCropPath} from '../src/comment-crops.ts';
import type {PartsIssue} from '../src/parts-comment.ts';
import {loadPartsView,type PartsViewPackage} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {writeMeshPackage} from './helpers/parts-mesh-package.ts';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
interface HeldRigReadback {style:string;animation:string;time:string;playing:boolean;frame:string;viewport:{width:number;height:number};visibleBounds:unknown;numeric:unknown}
const argument=(key:string)=>{const i=Bun.argv.indexOf(key);return i<0?undefined:Bun.argv[i+1];};
const rigFitOnly=Bun.argv.includes('--rig-fit-only');
const output=resolve(argument('--out')??'artifacts/parts-setup-737');await mkdir(output,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'parts-setup-737-'));process.env.RIG_REVIEW_STATE_DIR=join(root,'state');
let page:InputCdpSession|undefined;
const servers:{stop(close?:boolean):unknown}[]=[],report:Record<string,unknown>={};
async function wait(expression:string,name:string){const end=Date.now()+20000;while(Date.now()<end){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(50);}throw new Error('U3_WAIT '+name+' '+await page!.evaluate('document.body.innerText'));}
async function settled(){await wait(`document.body.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`,'paint');await page!.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');}
async function shot(name:string){await writeFile(join(output,name+'.png'),await page!.screenshot());}
async function controls(){return page!.evaluate<{ids:string[];menu:string[];caption:string;counts:number[]}>(`({ids:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id),menu:[...document.querySelectorAll('#view-menu [data-view]')].map(n=>n.dataset.view),caption:document.querySelector('#rig-label').textContent,counts:['.topbar','.layout','.workspace-act-bar','[data-part-list]','#stage-comment'].map(s=>document.querySelectorAll(s).length)})`);}
async function menu(id:string){await click(page!,'#view-menu summary');report.lastMenu=await page!.evaluate(`({id:${JSON.stringify(id)},items:Array.from(document.querySelectorAll('#view-menu [data-view]'),n=>({id:n.dataset.view,disabled:n.disabled,reason:n.title})),message:document.querySelector('#message').textContent,renderer:document.querySelector('#renderer-state').textContent})`);await click(page!,'[data-view="'+id+'"]');await settled();}
async function part(name:string){const selector='[data-part-list] button[data-slot='+JSON.stringify(name)+']';await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);await click(page!,selector);await settled();}
async function pixel(x:number,y:number){return page!.evaluate<number[]>(`Array.from(document.getElementById('parts-canvas').getContext('2d').getImageData(${x},${y},1,1).data)`);}
/** Independent signed-edge point oracle finds an actual opaque art cell outside the supplied triangles. */
async function uncovered(pkg:PartsViewPackage){
 for(const item of pkg.items){if(!item.mesh)continue;const art=PNG.sync.read(await readFile(pkg.imagePaths[item.index]!)),v=item.mesh.vertices,t=item.mesh.triangles;
  for(let y=0;y<item.h;y++)for(let x=0;x<item.w;x++){if(!art.data[(y*art.width+x)*4+3])continue;let covered=false;
   for(let i=0;i<t.length;i+=3){const a=t[i]!*2,b=t[i+1]!*2,c=t[i+2]!*2,px=x+.5,py=y+.5,cross=(a:number,b:number)=>(v[b]!-v[a]!)*(py-v[a+1]!)-(v[b+1]!-v[a+1]!)*(px-v[a]!);const area=(v[b]!-v[a]!)*(v[c+1]!-v[a+1]!)-(v[b+1]!-v[a+1]!)*(v[c]!-v[a]!);if(area===0)continue;const edges=[cross(a,b),cross(b,c),cross(c,a)];if(edges.every(n=>n>=0)||edges.every(n=>n<=0)){covered=true;break;}}
   if(!covered)return {name:item.name,x,y};
  }
 }return null;
}
async function inspect(name:string,pkg:PartsViewPackage,expectedDifference:boolean){
 const server=await startPartsServer(pkg,{port:0,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});servers.push(server);
 const hole=await uncovered(pkg);if(name==='negative')assert.ok(hole,'accepted-v6 supplied mesh must yield a tested uncovered art pixel');
 for(const lang of ['en','ko']as const){
  console.log('U3_CASE '+name+' '+lang);
  await page!.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`);await settled();const state=await controls();assert.deepEqual(state.ids,['zoom-in','zoom-out','fit','native-one','view-menu']);assert.deepEqual(state.menu,['compare','reference','rig','difference']);assert.deepEqual(state.counts,[1,1,1,1,1]);assert.equal(state.caption,lang==='ko'?koCatalog['Assembled parts']:enCatalog['Assembled parts']);
  await wait(`document.querySelectorAll('[data-part-list] .part-thumb[data-thumbnail="image"] canvas').length>0`,'original thumbnails');
  assert.ok(await page!.evaluate(`(()=>{const list=document.querySelector('#comments-list-host #stage-comment-list');return !!list&&document.querySelector('#workspace-inspector').contains(list)&&!document.querySelector('#stage-layout').contains(list)&&getComputedStyle(list).position==='static'})()`));
  assert.ok(await page!.evaluate(`Array.from(document.querySelectorAll('#checkpoint-detail input')).every(n=>n.disabled&&!n.checked&&n.title.includes('PARTS_RIG_UNAVAILABLE'))`));

  // Fit uses the existing cameraFrame's single 24px margin and full-precision camera.
  // Compare its projection through the browser CSS serializer, as the camera-race oracle does.
  const openingProbe=`(()=>{const c=document.querySelector('#parts-canvas'),v=document.querySelector('#rig-viewport'),s=document.querySelector('#rig-root').style,zoom=Number(s.transform.match(/scale\\(([^)]+)\\)/)[1]),expected=Math.min(16,Math.max(.001,Math.min((v.clientWidth-24)/c.width,(v.clientHeight-24)/c.height))),css=document.createElement('div').style;css.left=(v.clientWidth/2-c.width/2*expected)+'px';css.top=(v.clientHeight/2-c.height/2*expected)+'px';css.transform='scale('+expected+')';const rect=c.getBoundingClientRect(),view=v.getBoundingClientRect();return {width:c.width,height:c.height,zoom,expected,viewport:{width:v.clientWidth,height:v.clientHeight},cameraSync:document.querySelector('#camera-sync').checked,layout:document.querySelector('#layout-state').textContent,rendered:{width:rect.width,height:rect.height,center:{x:rect.left+rect.width/2,y:rect.top+rect.height/2},paneCenter:{x:view.left+v.clientLeft+v.clientWidth/2,y:view.top+v.clientTop+v.clientHeight/2}},root:{left:s.left,top:s.top,transform:s.transform},expectedRoot:{left:css.left,top:css.top,transform:css.transform}}})()`;
  const initialFit=await page!.evaluate(openingProbe);report[name+'-'+lang+'-initial-fit']=initialFit;
  await wait(`(()=>{const f=${openingProbe};return JSON.stringify(f.root)===JSON.stringify(f.expectedRoot)})()`,'real-image opening Fit '+JSON.stringify(initialFit));
  const openingFit=await page!.evaluate<{width:number;height:number;root:unknown;expectedRoot:unknown}>(openingProbe);
  assert.deepEqual([openingFit.width,openingFit.height],pkg.rigSize);assert.deepEqual(openingFit.root,openingFit.expectedRoot);

  const ready=await page!.evaluate<{dirty:string;message:string;renderer:string;player:string}>(`({dirty:document.querySelector('#dirty').textContent,message:document.querySelector('#message').textContent,renderer:document.querySelector('#renderer-state').textContent,player:document.querySelector('#player-state').textContent})`);
  assert.equal(ready.dirty,lang==='ko'?koCatalog['Not submitted']:enCatalog['Not submitted']);
  assert.equal(ready.message,lang==='ko'?koCatalog['Parts ready. Source files remain unchanged.']:enCatalog['Parts ready. Source files remain unchanged.']);
  assert.equal(ready.renderer,lang==='ko'?koCatalog['Parts raster drawn · Canvas2D']:enCatalog['Parts raster drawn · Canvas2D']);
  await click(page!,'#native-one');assert.equal(await page!.evaluate(`document.querySelector('#rig-root').style.transform`),'scale(1)');await click(page!,'#fit');
  const tabs=await page!.evaluate(`Array.from(document.querySelectorAll('[data-block-target][aria-selected="true"]'),n=>n.dataset.blockTarget)`);
  for(const item of pkg.items.slice(0,2)){await part(item.name);assert.equal(await page!.evaluate(`document.querySelector('#selected-part h3').textContent`),item.name);assert.ok((await page!.evaluate<string>(`document.querySelector('#selected-part').textContent`)).includes(pkg.files.find(file=>file.abs===pkg.imagePaths[item.index])!.sha256));assert.deepEqual(await page!.evaluate(`Array.from(document.querySelectorAll('[data-block-target][aria-selected="true"]'),n=>n.dataset.blockTarget)`),tabs);assert.deepEqual((await controls()).ids,state.ids);if(item.index===pkg.items[0]!.index)await shot(name+'-'+lang+'-selected-detail');await part(item.name);}

  assert.ok(await page!.evaluate(`document.querySelector('[data-mode="playback"]').disabled&&document.querySelector('[data-block-target="weights"]').disabled&&document.querySelector('[data-block-target="bones-panel"]').disabled`));
  const availability=await page!.evaluate<Record<string,{disabled:boolean;reason:string}>>(`Object.fromEntries([...document.querySelectorAll('#view-menu [data-view]')].map(n=>[n.dataset.view,{disabled:n.disabled,reason:n.title}]))`);
  assert.equal(availability.difference!.disabled,!expectedDifference);assert.equal(availability.rig!.disabled,false);
  if(pkg.painting){assert.equal(availability.compare!.disabled,false);assert.equal(availability.reference!.disabled,false);await shot(name+'-'+lang+'-side-by-side');await menu('reference');await shot(name+'-'+lang+'-reference');await menu('rig');}
  else assert.ok(availability.compare!.disabled&&availability.reference!.disabled);
  if(!expectedDifference){assert.ok(availability.difference!.reason.length>0);if(pkg.painting)assert.match(availability.difference!.reason,/painting_in_rig/);await click(page!,'#view-menu summary');await shot(name+'-'+lang+'-difference-disabled');await click(page!,'#view-menu summary');}
  const first=pkg.items[0]!,visibleSelector='[data-pv-visible='+JSON.stringify(first.name)+']';await page!.evaluate(`document.querySelector(${JSON.stringify(visibleSelector)}).scrollIntoView({block:'nearest'})`);await click(page!,visibleSelector);await settled();assert.equal(await page!.evaluate(`document.querySelector(${JSON.stringify(visibleSelector)}).checked`),false);await shot(name+'-'+lang+'-part-hidden');await click(page!,visibleSelector);await settled();
  if(pkg.painting){await click(page!,'#parts-overlay');await settled();await page!.evaluate(`(()=>{const n=document.getElementById('parts-opacity');n.value='0.25';n.dispatchEvent(new Event('input',{bubbles:true}))})()`);await settled();await shot(name+'-'+lang+'-overlay');await click(page!,'#parts-overlay');await settled();}
  if(expectedDifference){await menu('difference');assert.equal(await page!.evaluate(`document.querySelector('[data-view="difference"]').getAttribute('aria-pressed')`),'true');await shot(name+'-'+lang+'-difference');await menu('rig');}
  let mesh:unknown='supplied assembly has no meshes; Mesh edges is disabled by name';
  if(hole){await part(hole.name);await click(page!,'#part-solo');await settled();await click(page!,'#fit');const off=await pixel(hole.x,hole.y);await shot(name+'-'+lang+'-mesh-off');await click(page!,'.layer-toggle:has(#layer-mesh)');await settled();const on=await pixel(hole.x,hole.y);assert.notDeepEqual(on,off);await shot(name+'-'+lang+'-mesh-on');await click(page!,'.layer-toggle:has(#layer-mesh)');await settled();assert.deepEqual(await pixel(hole.x,hole.y),off);mesh={hole,off,on};}
  else if(!pkg.items.some(item=>item.mesh)){assert.equal(await page!.evaluate(`document.querySelector('#layer-mesh').disabled`),true);assert.ok(await page!.evaluate(`document.querySelector('.layer-toggle:has(#layer-mesh)').title.length>0||document.querySelector('#layer-mesh').title.length>0`));await shot(name+'-'+lang+'-mesh-disabled');}
  report[name+'-'+lang]={state,openingFit,availability,mesh,meshCount:pkg.items.filter(item=>item.mesh).length,sourceFiles:[...pkg.files,...pkg.flagFiles].map(file=>({sha256:file.sha256,bytes:file.bytes}))};
 }
 return server;
}
try{
 page=await launchCdpSession(join(root,'profile'));await page.setViewport(1600,1000);
 if(!rigFitOnly){const difference=join(root,'declared-public-fixture');await writeDifferencePackage(difference,true);await inspect('declared-public-fixture',await loadPartsView(difference,{painting:join(difference,'painting.png')}),true);
 const mesh=join(root,'mesh-public-fixture');await writeMeshPackage(mesh);await inspect('mesh-public-fixture',await loadPartsView(mesh),false);}
 const wind=argument('--wind'),rig=argument('--rig');
 if(wind&&rig){
  if(!rigFitOnly)await inspect('public-wind',await loadPartsView(wind,{painting:argument('--painting')}),true);
  for(const lang of ['en','ko']as const){
   const compiled=await startServer(await loadReview(rig),{port:0,exitOnClose:false,viewOnly:true});servers.push(compiled);
   await page.goto(`http://127.0.0.1:${compiled.port}/?lang=${lang}`);await wait(`!!document.querySelector('#rig-root canvas')&&document.querySelector('#player-state')?.textContent.includes('@rig-c/play')`,'wind rig');await click(page,'[data-mode="playback"]');await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   await wait(`!!document.querySelector('#stage-comment-list')`,'rig comments bound');
   if(await page.evaluate(`document.querySelector('#play').textContent==='Ⅱ'`))await click(page,'#play');
   await page.evaluate(`(()=>{const input=document.querySelector('#scrub');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);await page.evaluate('document.fonts.ready');await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   const heldReadback:string=`(()=>{const numeric=JSON.parse(document.querySelector('#view-coordinates').textContent);return {style:document.querySelector('#rig-root').style.cssText,animation:document.querySelector('#animation-select').value,time:document.querySelector('#scrub').value,playing:document.querySelector('#play').textContent==='Ⅱ',frame:document.querySelector('#frame-label').textContent,viewport:{width:document.querySelector('#rig-viewport').clientWidth,height:document.querySelector('#rig-viewport').clientHeight},visibleBounds:numeric.cameras.rig?.visible,numeric}})()`;
   const heldBefore:HeldRigReadback=await page.evaluate<HeldRigReadback>(heldReadback);report['rig-'+lang+'-held-before']=heldBefore;assert.equal(heldBefore.playing,false);
   const openingRigFit:string=heldBefore.style;await click(page,'#fit');const heldAfter:HeldRigReadback=await page.evaluate<HeldRigReadback>(heldReadback);report['rig-'+lang+'-held-after-fit']=heldAfter;
   assert.equal(heldAfter.playing,false);assert.equal(heldAfter.animation,heldBefore.animation);assert.equal(heldAfter.time,heldBefore.time);assert.equal(heldAfter.frame,heldBefore.frame);assert.equal(heldAfter.style,openingRigFit);

   await click(page,'#zoom-in');await click(page,'#native-one');assert.equal(await page.evaluate(`document.querySelector('#rig-root').style.transform`),'scale(1)');await shot('public-wind-animate-'+lang+'-native-one');await click(page,'#fit');await shot('public-wind-animate-'+lang);
   const animate=await controls();assert.deepEqual(animate.ids,['zoom-in','zoom-out','fit','native-one','view-menu']);report['public-wind-animate-'+lang]={...animate,openingRigFit};
  }
 }
 const positive=argument('--positive'),original=argument('--original');
 if(!rigFitOnly&&positive&&original)await inspect('positive',await loadPartsView(positive,{painting:original,paintingRoot:dirname(original)}),true);
 const negative=argument('--negative-review');
 if(!rigFitOnly&&negative){const reviewed=await loadReview(negative),server=await startServer(reviewed,{port:0,exitOnClose:false,viewOnly:true});servers.push(server);const projection=await (await fetch(`http://127.0.0.1:${server.port}/api/review`)).json();assert.equal(projection.manifest.references.length,36);assert.equal(projection.manifest.references[0].label,'Original painting · painting.png');report.negativeProjection={references:projection.manifest.references.length,first:projection.manifest.references[0]};await inspect('negative',await loadPartsView(reviewed.handoff!.parts!,{painting:reviewed.handoff!.source!,paintingRoot:reviewed.root,rig:join(reviewed.handoff!.parts!,'rig/rig.json'),meshReport:join(reviewed.handoff!.parts!,'rig/mesh_report.json')}),false);}
 if(!rigFitOnly&&!Bun.argv.includes('--skip-job'))for(const lang of ['en','ko']as const){
  const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});
  try{
   const publication=await fixture.publish('parts');await fixture.ask(publication,{kind:'parts-verdict',draftId:'synthetic-parts'});await fixture.ask(publication,{kind:'signoff',stage:'plan-approved'});
   await page.goto(fixture.locator+'/?lang='+lang+'#cap='+fixture.credentials.ui);await settled();assert.deepEqual((await controls()).counts,[1,1,1,1,1]);await click(page,'[data-part-list] button');await click(page,'#part-solo');await settled();await click(page,'#fit');
   const savedCamera:string=await page.evaluate<string>(`document.querySelector('#rig-root').style.cssText`);
   for(let i=0;i<2;i++){if(await page.evaluate(`document.getElementById('stage-comment').getAttribute('aria-pressed')`)!=='true')await click(page,'#stage-comment');
    const point=await page.evaluate<{x:number;y:number}>(`(()=>{const r=document.querySelector('#parts-canvas').getBoundingClientRect(),p=document.querySelector('#rig-viewport').getBoundingClientRect();return {x:Math.max(r.left,p.left)+Math.min(r.width,p.width)*(.35+${i}*.2),y:Math.max(r.top,p.top)+Math.min(r.height,p.height)*(.35+${i}*.2)}})()`);await page.mouse('mouseMoved',point.x,point.y);await page.mouse('mousePressed',point.x,point.y);await page.mouse('mouseMoved',point.x+32,point.y+32);await page.mouse('mouseReleased',point.x+32,point.y+32);await wait(`!!document.querySelector('.stage-comment-composer input')`,'composer');
    await page.evaluate(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value=${JSON.stringify('U3 '+lang+' issue ')}+${i};form.requestSubmit()})()`);await wait(`!document.querySelector('.stage-comment-composer')`,'comment saved');
   }
   await click(page,'#stage-comment');assert.ok(await page.evaluate(`(()=>{const list=document.querySelector('#comments-list-host #stage-comment-list');return list.getClientRects().length>0&&getComputedStyle(list).position==='static'&&document.querySelector('#workspace-inspector').contains(list)})()`));await click(page,'#zoom-out');assert.notEqual(await page.evaluate(`document.querySelector('#rig-root').style.cssText`),savedCamera);await click(page,'.stage-comment-summary');await wait(`!!document.querySelector('.stage-comment-composer input')`,'saved pin replay');assert.equal(await page.evaluate(`document.querySelector('#rig-root').style.cssText`),savedCamera);await click(page,'#stage-comment');
   await shot('job-parts-'+lang+'-before-submit');await click(page,'#request-changes');let verdict:JobAct|undefined;const end=Date.now()+20000;
   while(Date.now()<end){const next=await fixture.next(),acts=next.events.filter(event=>event.type==='act'&&event.act.publicationId===publication.publicationId&&event.act.kind==='parts-verdict');assert.ok(acts.length<=1);const event=acts[0];if(event?.type==='act'){verdict=event.act;break;}await Bun.sleep(50);}
   assert.ok(verdict);const act=parseCommentsAct(verdict);assert.ok(act.kind==='parts-verdict');assert.equal(act.value.verdict,'changes-requested');assert.equal(act.value.comments.length,2);
   for(const comment of act.value.comments){const anchor=comment.anchor as Omit<PartsIssue,'summary'>;assert.equal(anchor.sourceHash,act.source.sourceHash);assert.ok(anchor.nativeCrop&&anchor.imageRegion);for(const crop of [anchor.crop,anchor.nativeCrop!]){const bytes=await readFile(resolvedCropPath(crop.path));assert.equal(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),crop.sha256);}const native=PNG.sync.read(await readFile(resolvedCropPath(anchor.nativeCrop!.path))),source=PNG.sync.read(await readFile(join(fixture.packageRoot,'parts',anchor.parts[0]!.name+'.png'))),region=anchor.imageRegion!;assert.equal(native.width,region.width);assert.equal(native.height,region.height);for(let y=0;y<native.height;y++)for(let x=0;x<native.width;x++)assert.deepEqual(native.data.subarray((y*native.width+x)*4,(y*native.width+x+1)*4),source.data.subarray(((y+region.y)*source.width+x+region.x)*4,((y+region.y)*source.width+x+region.x+1)*4));}
   assert.equal(fixture.host.session.status().pending.find(ask=>ask.subject.kind==='signoff')?.status,'pending');await shot('job-parts-'+lang+'-submitted');report['job-'+lang]=act;
  }finally{await fixture.close();}
 }
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('U3_BROWSER_PASS '+JSON.stringify({cases:Object.keys(report),viewport:[1600,1000]}));
}catch(error){if(page)await shot('failure');await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),report,observed:page?await page.evaluate(`({body:document.body.innerText,menu:Array.from(document.querySelectorAll('#view-menu [data-view]'),n=>({id:n.dataset.view,disabled:n.disabled,reason:n.title})),canvas:{width:document.querySelector('#parts-canvas')?.width,height:document.querySelector('#parts-canvas')?.height},cameraSync:document.querySelector('#camera-sync')?.checked,layout:document.querySelector('#layout-state')?.textContent})`):null},null,2)+'\n');throw error;}
finally{await page?.close();for(const server of servers)server.stop(true);await rm(root,{recursive:true,force:true});}
