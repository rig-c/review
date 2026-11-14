/** #838 bottom-panel and toolbar playback browser proof: single non-wrapping bottom tab strip with overflow menu, Timeline first tab, Inspection rename, and chevron collapse control. Ordinary Nova only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {interviewOpenFixture} from './helpers/interview-open-fixture.ts';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {startServer} from '../src/server.ts';
import {joinProject} from '../src/joined-project.ts';
import {loadReview} from '../src/manifest.ts';
import {launchCdpSession,buildTwentySlotModel,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';

const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/bottom-tabs':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];

async function wait(page:InputCdpSession,expression:string,label:string){
 const end=Date.now()+20_000;
 while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(30);}
 throw new Error(`BOTTOM_TABS_WAIT(${label}): ${expression}`);
}

async function selectTab(page:InputCdpSession,target:string){
 const selector=`.workspace-bottom-tabs > .block-row:not([hidden]) [data-block-target="${target}"]`;
 const overflow=await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(selector)}).hasAttribute('data-tab-overflow')`);
 if(overflow){
  await click(page,'.workspace-bottom-tabs > .block-row:not([hidden]) .workspace-tabs-more');
  await page.evaluate(`document.querySelector('.workspace-tabs-menu:not([hidden]) [data-block-more-target="${target}"]')?.scrollIntoView({block:'nearest'})`);
  if(Bun.argv.includes('--standalone-widths')){
   const hit:any=await page.evaluate(`(()=>{const n=document.querySelector('.workspace-tabs-menu:not([hidden]) [data-block-more-target="${target}"]'),r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2),ancestors=[];for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);ancestors.push({id:p.id,className:p.className,rect:p.getBoundingClientRect().toJSON(),overflowX:s.overflowX,overflowY:s.overflowY,scrollTop:p.scrollTop});}return {target:'${target}',language:document.documentElement.lang,width:innerWidth,rect:r.toJSON(),hit:hit?{tag:hit.tagName,id:hit.id,className:hit.className}:null,receivesHit:n.contains(hit),ancestors};})()`);
   await writeFile(join(output,`menu-hit-${hit.language}-${hit.width}-${target}.json`),JSON.stringify(hit,null,2)+'\n');
  }
  await click(page,`.workspace-tabs-menu:not([hidden]) [data-block-more-target="${target}"]`);
 }
 else await click(page,selector);
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
}

/** #856: measure the real tab strip, not just whether overflow attributes exist. */
async function proveHeading(page:InputCdpSession,label:string){
 await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
 const g:any=await page.evaluate<any>(`(()=>{
  const rect=n=>n.getBoundingClientRect().toJSON(),panel=document.getElementById('workspace-inspector'),strip=document.querySelector('.workspace-bottom-tabs'),row=strip.querySelector('.block-row:not([hidden])'),chevron=document.getElementById('workspace-bottom-collapse');
  return {panel:rect(panel),strip:rect(strip),row:rect(row),chevron:rect(chevron),width:innerWidth,act:[...document.querySelectorAll('.inspector-heading>.workspace-act-bar,.inspector-heading>.workspace-act-bar *')].filter(n=>!n.closest('[hidden]')&&n.getBoundingClientRect().width>0&&getComputedStyle(n).display!=='contents').map(n=>({id:n.id,rect:rect(n)})),tabs:[...row.querySelectorAll('[role=tab]')].filter(n=>n.getBoundingClientRect().width>0).map(n=>({id:n.dataset.blockTarget,selected:n.getAttribute('aria-selected')==='true',rect:rect(n)}))};
 })()`);
 for(const node of g.act)assert.ok(node.rect.left>=g.panel.left-1&&node.rect.right<=g.panel.right+1&&node.rect.left>=0&&node.rect.right<=g.width,label+' retained act inside panel and viewport: '+node.id);
 const center=(r:any)=>(r.top+r.bottom)/2;
 for(const tab of g.tabs){
  assert.ok(tab.rect.top>=g.panel.top-1&&tab.rect.bottom<=g.panel.bottom+1,label+' tab inside panel: '+tab.id);
  assert.ok(tab.rect.left>=g.strip.left-1&&tab.rect.right<=g.strip.right+1&&tab.rect.left>=0&&tab.rect.right<=g.width,label+' tab inside strip and viewport: '+tab.id);
  assert.ok(Math.abs(center(tab.rect)-center(g.chevron))<=1,label+' tab and chevron share centre');
 }
 assert.ok(g.row.top>=g.panel.top-1&&g.row.bottom<=g.panel.bottom+1,label+' row inside panel');
 assert.ok(g.tabs.some((tab:any)=>tab.selected),label+' selected tab has a visible box');
 return g;
}

/** Native activation of the retained transport, with time read from the shipped runtime UI. */
async function proveToolbarPlayback(page:InputCdpSession,kind:string,lang:string,width:number,height:number){
 await wait(page,`!!document.querySelector('#rig-root canvas')&&!document.getElementById('play').disabled`,kind+' playable model');
 await page.evaluate(`window.__838p2PlayNode=document.getElementById('play');window.__838p2PlayHandler=window.__838p2PlayNode.onclick`);
 const samples:unknown[]=[];
 for(const tab of ['sound-panel','report-panel']){
  await selectTab(page,tab);
  assert.equal(await page.evaluate(`document.getElementById('animation-dock').hidden`),true,'non-Timeline tab hides Timeline');
  if(await page.evaluate(`document.getElementById('play').textContent==='Ⅱ'`))await click(page,'#play');
  const before=await page.evaluate<number>(`Number(document.getElementById('scrub').value)`);
  await click(page,'#play');
  await wait(page,`document.getElementById('play').textContent==='Ⅱ'&&Math.abs(Number(document.getElementById('scrub').value)-${before})>=.04`,tab+' actual playback advances');
  const advanced=await page.evaluate<number>(`Number(document.getElementById('scrub').value)`);
  const playingBox:any=await page.evaluate(`({play:document.getElementById('play').getBoundingClientRect().toJSON(),zoom:document.getElementById('zoom-in').getBoundingClientRect().toJSON()})`);
  assert.ok(Math.abs(playingBox.play.height-playingBox.zoom.height)<=1,'Pause glyph height equals Zoom in');
  await click(page,'#play');
  await wait(page,`document.getElementById('play').textContent==='▶'`,tab+' pauses');
  const held=await page.evaluate<number>(`Number(document.getElementById('scrub').value)`);
  await Bun.sleep(220);
  const state:any=await page.evaluate<any>(`(()=>{
   const play=document.getElementById('play'),zoom=document.getElementById('zoom-in'),r=play.getBoundingClientRect();
   return {time:Number(document.getElementById('scrub').value),text:play.textContent,label:play.getAttribute('aria-label'),count:document.querySelectorAll('#play').length,
    identity:play===window.__838p2PlayNode,handler:play.onclick===window.__838p2PlayHandler,main:!!play.closest('.viewbar.workspace-main-toolbar'),
    beforeControls:play.nextElementSibling?.contains(zoom)&&r.right<=zoom.getBoundingClientRect().left,
    visible:!play.hidden&&r.width>0&&r.height>0,rect:r.toJSON(),controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id)};
  })()`);
  assert.equal(state.count,1);assert.equal(state.identity,true);assert.equal(state.handler,true);assert.equal(state.main,true);
  assert.ok(Math.abs(state.rect.height-playingBox.play.height)<=1&&Math.abs(state.rect.width-playingBox.play.width)<=1,'Play and Pause have the same dimensions');
  assert.ok(Math.abs(state.rect.height-playingBox.zoom.height)<=1,'Play glyph height equals Zoom in');
  assert.equal(state.visible,true);assert.equal(state.beforeControls,true);assert.equal(state.text,'▶');assert.equal(state.time,held,'pause holds the actual transport time');
  assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
  assert.ok(state.rect.left>=0&&state.rect.top>=0&&state.rect.right<=width&&state.rect.bottom<=height);
  samples.push({tab,before,advanced,held,after220ms:state.time,state});
  await writeFile(join(output,`${kind}-${lang}-${width}x${height}-${tab}-toolbar-pause.png`),await page.screenshot());
 }
 await click(page,'[data-mode="rig"]');
 assert.equal(await page.evaluate(`document.getElementById('play').hidden`),true,'Setup hides the retained control');
 await writeFile(join(output,`${kind}-${lang}-${width}x${height}-setup-no-play.png`),await page.screenshot());
 await click(page,'[data-mode="playback"]');
 assert.equal(await page.evaluate(`!document.getElementById('play').hidden&&document.getElementById('play')===window.__838p2PlayNode&&document.getElementById('play').onclick===window.__838p2PlayHandler`),true);
 await selectTab(page,'animation-dock');
 await writeFile(join(output,`${kind}-${lang}-${width}x${height}-playback-proof.json`),JSON.stringify(samples,null,2)+'\n');
 return samples;
}

async function runCase(kind:'rig'|'direction'|'parts',lang:'en'|'ko'){
 const catalog=lang==='ko'?koCatalog:enCatalog;
 const profile=await mkdtemp(join(tmpdir(),'review838-'));
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh'});
 let page:InputCdpSession|undefined;
 try{
  const publication=await fixture.publish(kind);
  await fixture.ask(publication,kind==='parts'?{kind:'parts-verdict',draftId:'synthetic-parts'}:{kind:'review-verdict',stage:kind==='direction'?'direction-review':'rig-review'});
  const target=new URL(fixture.locator+'/#cap='+fixture.credentials.ui);
  target.searchParams.set('lang',lang);
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000,browserArgs:['--force-device-scale-factor=2']});
  for(const [width,height]of [[1440,900],[1100,800]] as const){
   await page.setViewport(width,height);
   await page.goto(target.href,lang);
   await wait(page,`document.body.dataset.ready==='true'&&!document.body.inert&&!!document.querySelector('#workspace-ask-headline')?.textContent`,kind+'-'+lang+'-'+width);
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);

   const initial:any=await page.evaluate<any>(`(()=>{
    const strip=document.querySelector('.workspace-bottom-tabs');
    const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
    const playback=document.getElementById('inspector-playback');
    const rig=document.getElementById('inspector-rig');
    const activeSection=playback&&!playback.hidden?playback:rig;
    const buttons=[...row.querySelectorAll(':scope>button')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none');
    const rects=buttons.map(b=>b.getBoundingClientRect());
    const minTop=Math.min(...rects.map(r=>r.top)),maxBottom=Math.max(...rects.map(r=>r.bottom));
    const selected=row.querySelector('button[role="tab"][aria-selected="true"]');
    const selectedRect=selected?.getBoundingClientRect();
    const panels=[...activeSection.querySelectorAll(':scope>[role="tabpanel"]')];
    const shownPanels=panels.filter(p=>!p.hidden&&getComputedStyle(p).display!=='none').map(p=>p.id);
    const collapse=document.getElementById('workspace-bottom-collapse');
    const more=row.querySelector('.workspace-tabs-more');
    return {
     lang:document.documentElement.lang,
     stripFlexWrap:getComputedStyle(strip).flexWrap,
     rowFlexWrap:getComputedStyle(row).flexWrap,
     lineHeightSpan:maxBottom-minTop,
     playbackDisplay:playback?getComputedStyle(playback).display:null,
     animateBlocksExists:!!document.getElementById('animate-blocks'),
     tabs:[...row.querySelectorAll('button[role="tab"]')].map(b=>({id:b.dataset.blockTarget,text:b.textContent,selected:b.getAttribute('aria-selected'),overflow:b.hasAttribute('data-tab-overflow'),disabled:b.disabled})),
     selectedId:selected?.dataset.blockTarget,
     selectedVisible:!!selected&&!selected.hasAttribute('data-tab-overflow')&&(selectedRect?.width??0)>0,
     shownPanels,
     moreVisible:!!more&&!more.hidden&&getComputedStyle(more).display!=='none',
     collapseText:collapse?.textContent,
     collapseExpanded:collapse?.getAttribute('aria-expanded'),
     collapseLabel:collapse?.getAttribute('aria-label'),
    };
   })()`);

   await proveHeading(page,kind+' '+lang+' initial');
   assert.equal(initial.lang,lang);
   assert.equal(initial.stripFlexWrap,'nowrap');
   assert.equal(initial.rowFlexWrap,'nowrap');
   assert.ok(initial.lineHeightSpan<=32,`tab strip stays on one horizontal line (span=${initial.lineHeightSpan})`);
   assert.equal(initial.animateBlocksExists,false,'#animate-blocks two-column wrapper is gone');
   assert.equal(initial.selectedVisible,true,'selected tab is always visible in the strip');
   assert.equal(initial.collapseText,'⌄');
   assert.equal(initial.collapseExpanded,'true');
   assert.equal(initial.collapseLabel,catalog['Collapse bottom panel']);

   if(kind!=='parts'){
    assert.notEqual(initial.playbackDisplay,'grid','#inspector-playback is no longer a 2-column grid');
    assert.equal(initial.tabs[0].id,'animation-dock');
    assert.equal(initial.tabs[0].text,catalog['Timeline']);
    assert.equal(initial.tabs[1].id,'motion-tools');
    assert.equal(initial.tabs[1].text,catalog['Inspection']);
    assert.equal(initial.selectedId,'animation-dock');
    assert.deepEqual(initial.shownPanels,['animation-dock']);
   }else{
    assert.equal(initial.tabs[0].id,'selected-part');
    assert.equal(initial.tabs[0].text,catalog['Part']);
    assert.equal(initial.selectedId,'selected-part');
    assert.deepEqual(initial.shownPanels,['selected-part']);
   }
   await writeFile(join(output,`${kind}-${lang}-${width}x${height}-initial.png`),await page.screenshot());
   if(kind!=='parts'&&width===1440){
    const original=await page.evaluate<string>(`document.querySelector('#request-changes').textContent`);
    await page.evaluate(`document.querySelector('#request-changes').textContent+=${JSON.stringify(' · '+original.repeat(3))}`);
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const resized:any=await page.evaluate<any>(`(()=>{const row=document.querySelector('.workspace-bottom-tabs > .block-row:not([hidden])'),rect=row.getBoundingClientRect(),tabs=[...row.querySelectorAll(':scope > [role=tab]')].filter(tab=>!tab.hasAttribute('data-tab-overflow'));return {width:rect.width,contained:tabs.every(tab=>{const r=tab.getBoundingClientRect();return r.left>=rect.left-1&&r.right<=rect.right+1;}),wrap:getComputedStyle(row).flexWrap};})()`);
    assert.equal(resized.contained,true,'existing strip ResizeObserver handles act-label width changes');assert.equal(resized.wrap,'nowrap');
    await writeFile(join(output,`${kind}-${lang}-act-label-resize.json`),JSON.stringify(resized,null,2));
    await page.evaluate(`document.querySelector('#request-changes').textContent=${JSON.stringify(original)}`);
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   }


   if(kind!=='parts'){
    for(const targetId of ['motion-tools','sound-panel','environment','physics-panel','idle-tracks','readings','requirements','retarget','report-panel','animation-dock']){
     await selectTab(page,targetId);
     const switched:any=await page.evaluate<any>(`(()=>{
      const playback=document.getElementById('inspector-playback');
      const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
      const selected=row.querySelector('button[role="tab"][aria-selected="true"]');
      const shown=[...playback.querySelectorAll(':scope>[role="tabpanel"]')].filter(p=>!p.hidden&&getComputedStyle(p).display!=='none').map(p=>p.id);
      return {selectedId:selected?.dataset.blockTarget,selectedVisible:!!selected&&!selected.hasAttribute('data-tab-overflow')&&selected.getBoundingClientRect().width>0,shown};
     })()`);
     assert.equal(switched.selectedId,targetId);
     assert.equal(switched.selectedVisible,true,`selected tab ${targetId} stays visible in strip`);
     assert.deepEqual(switched.shown,[targetId]);
     if(targetId==='motion-tools'&&width===1440){
      await writeFile(join(output,`${kind}-${lang}-${width}x${height}-inspection.png`),await page.screenshot());
     }
    }
   }

   if(kind!=='parts')await proveToolbarPlayback(page,kind,lang,width,height);
   else assert.equal(await page.evaluate(`document.getElementById('play').hidden`),true,'parts Setup hides playback');

   if(width===1100&&kind!=='parts'){
    // #840 frees the heading from the act. A 1100px viewport alone no longer
    // guarantees overflow: constrain only this test's existing strip instead.
    // Hash the exact inline style attribute we own, not the live tab state that
    // these menu actions intentionally change. Restore the attribute in finally.
    const stripBefore:{style:string|null;width:number;height:number;tabs:number}=await page.evaluate<{style:string|null;width:number;height:number;tabs:number}>(`(()=>{const strip=document.querySelector('.workspace-bottom-tabs'),row=strip.querySelector('.block-row:not([hidden])');return {style:strip.getAttribute('style'),width:strip.clientWidth,height:strip.clientHeight,tabs:row.querySelectorAll('[role=tab]').length};})()`);
    assert.ok(stripBefore.tabs>2,'overflow fixture has actual inspection tabs');
    const narrowWidth=Math.min(320,Math.floor(stripBefore.width/2));
    const beforeHash=createHash('sha256').update(JSON.stringify(stripBefore.style)).digest('hex');
    const mutation={kind,lang,width,height,selector:'.workspace-bottom-tabs',scope:'test-only DOM inline style attribute',narrowWidth,beforeHash};
    const receipt=join(output,`${kind}-${lang}-${width}x${height}-overflow-mutation`);
    console.log('BOTTOM_TABS_DOM_MUTATION_BEGIN '+JSON.stringify(mutation));
    await writeFile(receipt+'-begin.json',JSON.stringify({...mutation,before:stripBefore},null,2)+'\n');
    let overflowFailed=false,overflowError:unknown;
    try{
     await page.evaluate(`(()=>{const strip=document.querySelector('.workspace-bottom-tabs');strip.style.flex='0 0 '+${narrowWidth}+'px';strip.style.width=${narrowWidth}+'px';strip.style.maxWidth=${narrowWidth}+'px';})()`);
     await wait(page,`(()=>{const row=document.querySelector('.workspace-bottom-tabs > .block-row:not([hidden])'),more=row.querySelector('.workspace-tabs-more');return row.clientWidth<=${narrowWidth}+1&&!more.hidden&&row.querySelector('[data-block-target="report-panel"]').hasAttribute('data-tab-overflow');})()`,'test-only constrained strip really overflows');
    await page.evaluate(`document.querySelector('.workspace-inspectorHeight').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
    await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const overflowState:any=await page.evaluate<any>(`(()=>{
     const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
     const more=row.querySelector('.workspace-tabs-more');
     more.click();
     const menu=row.querySelector('.workspace-tabs-menu');
     const items=[...menu.querySelectorAll('button[role="menuitem"]')].filter(b=>!b.hidden).map(b=>({target:b.dataset.blockMoreTarget,text:b.textContent}));
     return {rowWidth:row.clientWidth,overflowCount:row.querySelectorAll('[data-tab-overflow]').length,moreVisible:!more.hidden&&getComputedStyle(more).display!=='none',menuOpen:!menu.hidden&&getComputedStyle(menu).display!=='none',items,rect:menu.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight}};
    })()`);
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-overflow.json`),JSON.stringify(overflowState,null,2));
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-overflow-before.png`),await page.screenshot());
    assert.ok(overflowState.rect.bottom<=overflowState.viewport.height&&overflowState.rect.top>=0,'whole overflow menu stays inside viewport');
    assert.ok(overflowState.rowWidth<=narrowWidth+1&&overflowState.overflowCount>0,'actual tab width exceeds the constrained strip');
    assert.equal(overflowState.moreVisible,true,'overflow button visible on the test-only narrowed strip at 1100x800');
    assert.equal(overflowState.menuOpen,true,'clicking ⋯ opens overflow menu');
    assert.ok(overflowState.items.some((item:any)=>item.target==='report-panel'),'Report tab is in overflow menu');
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-overflow-menu.png`),await page.screenshot());

    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await page.evaluate(`document.activeElement.classList.contains('workspace-tabs-more')`),true,'Escape returns focus to the overflow trigger');
    await selectTab(page,'report-panel');
    const pickedFromMore:any=await page.evaluate<any>(`(()=>{
     const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
     const menu=row.querySelector('.workspace-tabs-menu');
     const selected=row.querySelector('button[role="tab"][aria-selected="true"]');
     const playback=document.getElementById('inspector-playback');
     const shown=[...playback.querySelectorAll(':scope>[role="tabpanel"]')].filter(p=>!p.hidden&&getComputedStyle(p).display!=='none').map(p=>p.id);
     const buttons=[...row.querySelectorAll(':scope>button')].filter(b=>!b.hidden&&getComputedStyle(b).display!=='none');
     const rects=buttons.map(b=>b.getBoundingClientRect());
     const span=Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top));
     return {menuHidden:menu.hidden,selectedId:selected?.dataset.blockTarget,selectedVisible:!!selected&&!selected.hasAttribute('data-tab-overflow')&&selected.getBoundingClientRect().width>0,shown,span};
    })()`);
    assert.equal(pickedFromMore.menuHidden,true);
    assert.equal(pickedFromMore.selectedId,'report-panel');
    assert.equal(pickedFromMore.selectedVisible,true,'newly selected tab from ⋯ becomes visible in the strip');
    assert.deepEqual(pickedFromMore.shown,['report-panel']);
    assert.ok(pickedFromMore.span<=32,'strip stays single-line after selecting from ⋯');
    await page.evaluate(`(()=>{
     const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
     const tab=row.querySelector('button[data-block-target="animation-dock"]');
     if(tab&&!tab.hasAttribute('data-tab-overflow'))tab.click();
     else row.querySelector('button[data-block-more-target="animation-dock"]')?.click();
    })()`);
    }catch(error){overflowFailed=true;overflowError=error;throw error;}
    finally{
     try{
      // Capture null vs empty before and after touching the live style getter,
      // then after ResizeObserver/layout callbacks. Do not equate the two values.
      const immediate:{style:string|null;cssText:string;afterGetter:string|null}=await page.evaluate<{style:string|null;cssText:string;afterGetter:string|null}>(`(()=>{
       const strip=document.querySelector('.workspace-bottom-tabs'),original=${JSON.stringify(stripBefore.style)};
       if(original===null)strip.removeAttribute('style');else strip.setAttribute('style',original);
       const style=strip.getAttribute('style'),cssText=strip.style.cssText;
       return {style,cssText,afterGetter:strip.getAttribute('style')};
      })()`);
      await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const afterSettle:{style:string|null;width:number;height:number}=await page.evaluate<{style:string|null;width:number;height:number}>(`(()=>{const strip=document.querySelector('.workspace-bottom-tabs');return {style:strip.getAttribute('style'),width:strip.clientWidth,height:strip.clientHeight};})()`);
      // Replay the original attribute once after callbacks settle. Read its exact
      // value immediately, without a style getter, and measure the normal layout.
      const finalRestore:{style:string|null;width:number;height:number}=await page.evaluate<{style:string|null;width:number;height:number}>(`(()=>{
       const strip=document.querySelector('.workspace-bottom-tabs'),original=${JSON.stringify(stripBefore.style)};
       if(original===null)strip.removeAttribute('style');else strip.setAttribute('style',original);
       return {style:strip.getAttribute('style'),width:strip.clientWidth,height:strip.clientHeight};
      })()`);
      const immediateHash:string=createHash('sha256').update(JSON.stringify(immediate.style)).digest('hex');
      const restoredHash:string=createHash('sha256').update(JSON.stringify(finalRestore.style)).digest('hex');
      const driftStage=immediate.afterGetter!==immediate.style?'style-getter':afterSettle.style!==immediate.afterGetter?'after-settle':'none';
      const restored={...mutation,immediate,immediateHash,afterSettle,finalRestore,driftStage,restoredHash,restored:restoredHash===beforeHash,overflowError:overflowFailed?String(overflowError):null};
      console.log('BOTTOM_TABS_DOM_MUTATION_RESTORED '+JSON.stringify(restored));
      await writeFile(receipt+'-restored.json',JSON.stringify(restored,null,2)+'\n');
      assert.equal(restoredHash,beforeHash,'final inline style restoration is exact immediately after settled callbacks');
      assert.ok(Math.abs(finalRestore.width-stripBefore.width)<=1,'normal strip width restored before collapse measurement');
      assert.ok(Math.abs(finalRestore.height-stripBefore.height)<=1,'normal strip height restored before collapse measurement');
      assert.ok(finalRestore.width>narrowWidth,'test-only narrow width is removed');
     }catch(restoreError){
      const failure={overflowError:overflowFailed?String(overflowError):null,restoreError:String(restoreError)};
      console.error('BOTTOM_TABS_DOM_RESTORE_FAILED '+JSON.stringify(failure));
      await writeFile(receipt+'-restore-failure.json',JSON.stringify(failure,null,2)+'\n').catch(()=>{});
      if(!overflowFailed)throw restoreError; // Otherwise preserve the original assertion and stack.
     }
    }
   }

   if(kind==='parts'&&width===1100){
    const moreVisible=await page.evaluate<boolean>(`(()=>{const more=document.querySelector('.workspace-bottom-tabs > .block-row:not([hidden]) .workspace-tabs-more');return !!more&&!more.hidden;})()`);
    if(moreVisible){
     await click(page,'.workspace-bottom-tabs > .block-row:not([hidden]) .workspace-tabs-more');
     const unavailable:any=await page.evaluate<any>(`(()=>{const menu=document.querySelector('.workspace-bottom-tabs > .block-row:not([hidden]) .workspace-tabs-menu');return {open:!menu.hidden,items:[...menu.querySelectorAll('button:not([hidden])')].map(b=>({disabled:b.disabled,title:b.title}))};})()`);
     await writeFile(join(output,`${kind}-${lang}-unavailable-menu.json`),JSON.stringify(unavailable,null,2));
     assert.equal(unavailable.open,true,'overflow exposes disabled tabs and their refusal reasons');
     assert.ok(unavailable.items.length>0&&unavailable.items.every((item:any)=>item.disabled&&item.title.includes('PARTS_RIG_UNAVAILABLE')));
     await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    }
   }

   await click(page,'#workspace-bottom-collapse');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   const collapsedState:any=await page.evaluate<any>(`(()=>{
    const collapse=document.getElementById('workspace-bottom-collapse');
    const body=document.querySelector('.inspector-body');
    const heading=document.querySelector('.inspector-heading');
    const act=document.getElementById('workspace-review-act');
    return {
     text:collapse?.textContent,
     expanded:collapse?.getAttribute('aria-expanded'),
     label:collapse?.getAttribute('aria-label'),
     bodyHidden:body?.hidden,
     headingVisible:heading.getBoundingClientRect().height>0,
     actVisible:act.getBoundingClientRect().height>0,
    };
   })()`);
   await proveHeading(page,kind+' '+lang+' collapsed');
   assert.equal(collapsedState.text,'⌃');
   assert.equal(collapsedState.expanded,'false');
   assert.equal(collapsedState.label,catalog['Expand bottom panel']);
   assert.equal(collapsedState.bodyHidden,true);
   assert.equal(collapsedState.headingVisible,true);
   assert.equal(collapsedState.actVisible,true);
   if(width===1440){
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-collapsed.png`),await page.screenshot());
   }
   await click(page,'#workspace-bottom-collapse');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   assert.equal(await page.evaluate(`document.getElementById('workspace-bottom-collapse').textContent`),'⌄');

   if(width===1100){
    const widths=[240,320,540,700,900,1100,1280,1440],sweep:unknown[]=[];
    for(const w of widths){
     await page.setViewport(w,900);
     await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
     const targets=await page.evaluate<string[]>(`[...document.querySelectorAll('.workspace-bottom-tabs>.block-row:not([hidden]) [role=tab]')].filter(n=>!n.hidden&&!n.disabled).map(n=>n.dataset.blockTarget)`);
     for(const target of targets){await selectTab(page,target);sweep.push({width:w,target,geometry:await proveHeading(page,kind+' '+lang+' '+w+' '+target)});}
    }
    await page.setViewport(width,height);await selectTab(page,kind==='parts'?'selected-part':'animation-dock');
    await page.evaluate(`document.querySelector('.workspace-inspectorHeight').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))`);
    sweep.push({minimum:await proveHeading(page,kind+' '+lang+' minimum height')});
    await click(page,'#workspace-bottom-collapse');sweep.push({collapsedMinimum:await proveHeading(page,kind+' '+lang+' minimum collapsed')});await click(page,'#workspace-bottom-collapse');
    await writeFile(join(output,`${kind}-${lang}-856-width-sweep.json`),JSON.stringify(sweep,null,2)+'\n');
   }
   observations.push({kind,lang,viewport:`${width}x${height}`,initial,collapsedState});
   await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');
  }
 }catch(error){
  await writeFile(join(output,`${kind}-${lang}-failure.json`),JSON.stringify({error:String(error)},null,2));
  if(page)await writeFile(join(output,`${kind}-${lang}-failure.png`),await page.screenshot()).catch(()=>{});
  throw error;
 }finally{
  await page?.close();
  await fixture.close();
  await rm(profile,{recursive:true,force:true});
 }
}

/** Record --plan, interview backdrops and standalone package/--question reuse the shipped shell. */
async function runSharedCase(kind:'plan'|'interview-rig'|'interview-parts'|'interview-standalone'|'standalone'|'standalone-many',lang:'en'|'ko'){
 const profile=await mkdtemp(join(tmpdir(),'review838-shared-'));
 let page:InputCdpSession|undefined,close:(()=>Promise<void>)|undefined;
 try{
  let url:string;
  if(kind.startsWith('standalone')){
   const f=await jobFixture();
   if(kind==='standalone-many')await writeFile(join(f.root,'out/skeleton.model.json'),await buildTwentySlotModel());
   const capability='b'.repeat(64),server=await startServer(await loadReview(join(f.root,'out')),{port:0,capability,stateDir:f.state});
   close=async()=>{server.stop(true);await f.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else if(kind==='interview-standalone'){
   const f=await interviewOpenFixture(2),capability='a'.repeat(64),server=await startServer(null,{port:0,capability,joined:joinProject(null,f.inputs.project),stateDir:f.stateDir});
   close=async()=>{server.stop(true);await f.close();};url=`http://127.0.0.1:${server.port}/#cap=${capability}`;
  }else{
   const f=await recordScreenFixture(kind==='plan'?'signoff':'interview-picks',kind==='interview-rig'?true:kind==='interview-parts'?'parts':false);
   close=()=>f.close();url=f.ownerUrl;
  }
  const target=new URL(url);target.searchParams.set('lang',lang);
  page=await launchCdpSession(profile,{sendDeadlineMs:20_000});
  for(const [width,height]of (Bun.argv.includes('--standalone-widths')?[[240,900],[320,900],[540,720],[700,720],[900,720],[1100,800],[1280,720],[1440,900]]:[[1440,900],[1280,720],[1100,800]])){
   await page.setViewport(width,height);await page.goto(target.href,lang);
   await wait(page,kind.startsWith('standalone')?`!!document.querySelector('#rig-root canvas')`:`document.body.dataset.ready==='true'&&!document.body.inert`,kind+' ready');
   if(kind.startsWith('interview')){
    await wait(page,`!!document.querySelector('#job-record-asks .interview-grid fieldset:not(:disabled)')`,kind+' form');
    if(!await page.evaluate(`!!document.querySelector('#job-record-asks[open]')`))await click(page,'#workspace-pending-ask');
    await wait(page,`!!document.querySelector('#job-record-asks[open] .interview-grid')`,kind+' dialog');
    const dialog:any=await page.evaluate<any>(`(()=>{const d=document.querySelector('#job-record-asks');return {title:d.getAttribute('aria-label'),focus:d.contains(document.activeElement),rect:d.getBoundingClientRect().toJSON(),forms:d.querySelectorAll('form.interview-answer').length};})()`);
    assert.equal(dialog.focus,true);assert.equal(dialog.forms,1);
    assert.ok(dialog.rect.left>=0&&dialog.rect.top>=0&&dialog.rect.right<=width&&dialog.rect.bottom<=height);
    if(kind==='interview-standalone')assert.equal(dialog.title,(lang==='en'?enCatalog:koCatalog)['interview.title']);
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-dialog.png`),await page.screenshot());
    await click(page,'#job-record-asks .workspace-drawer-close');
    assert.equal(await page.evaluate(`document.activeElement.id`),'workspace-pending-ask');
   }
   if(kind==='standalone-many'){
    const list:any=await page.evaluate<any>(`(()=>{const list=document.querySelector('[data-part-list]'),help=list.nextElementSibling;list.scrollTop=list.scrollHeight;return {count:list.children.length,overflow:getComputedStyle(list).overflowY,border:getComputedStyle(list).borderBottomWidth,rect:list.getBoundingClientRect().toJSON(),last:list.lastElementChild.getBoundingClientRect().toJSON(),help:help.getBoundingClientRect().toJSON(),client:list.clientHeight,scroll:list.scrollHeight};})()`);
    assert.equal(list.count,20);assert.equal(list.overflow,'auto');assert.ok(list.scroll>list.client&&parseFloat(list.border)>0);
    assert.ok(list.last.top>=list.rect.top&&list.last.bottom<=list.rect.bottom,'last synthetic part is entirely reachable');
    assert.ok(list.rect.bottom<list.help.top,'list has a clear end before the help paragraph');
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-list.json`),JSON.stringify(list,null,2)+'\n');
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-list.png`),await page.screenshot());
   }
   const state:any=await page.evaluate<any>(`(()=>{
    const heading=document.querySelector('.inspector-heading'),strip=heading.querySelector('.workspace-bottom-tabs'),collapse=document.querySelector('#workspace-bottom-collapse'),act=document.querySelector('#workspace-review-act');
    const row=strip.querySelector('.block-row:not([hidden])'),selected=row?.querySelector('[role=tab][aria-selected=true]:not([hidden])');
    return {language:document.documentElement.lang,entry:document.querySelectorAll('.topbar').length,viewports:document.querySelectorAll('#rig-viewport').length,
     headingOrder:[...heading.children].map(n=>n===strip?'tabs':n===collapse?'collapse':n===act?'act':n.id),wrap:getComputedStyle(row??strip).flexWrap,
     controls:[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(n=>n.id),collapseDisabled:collapse.disabled,collapseText:collapse.textContent,
     availableTabs:row?[...row.querySelectorAll('[role=tab]')].filter(n=>!n.hidden).length:0,selected:selected?.dataset.blockTarget,selectedVisible:!!selected&&!selected.hasAttribute('data-tab-overflow')&&selected.getBoundingClientRect().width>0,
     ask:document.querySelector('#workspace-ask-headline').textContent,answer:document.querySelector('#workspace-pending-ask').textContent,
     actInHeading:act.parentElement===heading,actHome:act.parentElement.id,actRowDirect:document.getElementById('workspace-act-row')?.previousElementSibling===document.querySelector('.topbar'),actRect:act.getBoundingClientRect().toJSON()};
   })()`);
   await writeFile(join(output,`${kind}-${lang}-${width}x${height}-state.json`),JSON.stringify(state,null,2));
   if(Bun.argv.includes('--standalone-widths')){
    const targets=await page.evaluate<string[]>(`[...document.querySelectorAll('.workspace-bottom-tabs>.block-row:not([hidden]) [role=tab]')].filter(n=>!n.hidden&&!n.disabled).map(n=>n.dataset.blockTarget)`);
    for(const target of targets){await selectTab(page,target);await proveHeading(page,kind+' '+lang+' '+width+' '+target);}
   }
   assert.equal(state.language,lang);assert.equal(state.entry,1);assert.equal(state.viewports,1);
   const live=!kind.startsWith('standalone')&&kind!=='interview-standalone';
   assert.deepEqual(state.headingOrder,live?['tabs','collapse']:['tabs','collapse','act'],'only live asks leave the bottom heading');
   if(live){assert.equal(state.actHome,'workspace-act-row');assert.equal(state.actRowDirect,true);}
   assert.deepEqual(state.controls,['zoom-in','zoom-out','fit','native-one','view-menu']);
   assert.equal(state.wrap,'nowrap');assert.equal(state.actInHeading,!live);assert.equal(state.collapseText,'⌄');
   if(state.availableTabs)assert.equal(state.selectedVisible,true);else assert.equal(state.selected,undefined,'subjects without rig capabilities expose no block tab');
   await writeFile(join(output,`${kind}-${lang}-${width}x${height}-workspace.png`),await page.screenshot());
   if(!state.collapseDisabled){
    await click(page,'#workspace-bottom-collapse');
    assert.equal(await page.evaluate(`document.querySelector('.inspector-body').hidden`),true);
    assert.equal(await page.evaluate(`document.querySelector('#workspace-bottom-collapse').textContent`),'⌃');
    assert.equal(await page.evaluate(`document.querySelector('#workspace-review-act').getBoundingClientRect().height>0`),true);
    assert.equal(await page.evaluate(`document.querySelector('#workspace-ask-headline').textContent`),state.ask);
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-collapsed.png`),await page.screenshot());
    await click(page,'#workspace-bottom-collapse');
   }
   observations.push({kind,lang,viewport:`${width}x${height}`,state});
   await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');
  }
 }catch(error){
  await writeFile(join(output,`${kind}-${lang}-failure.json`),JSON.stringify({error:String(error)},null,2));
  if(page)await writeFile(join(output,`${kind}-${lang}-failure.png`),await page.screenshot()).catch(()=>{});
  throw error;
 }finally{await page?.close();await close?.();await rm(profile,{recursive:true,force:true});}
}

for(const lang of ['en','ko'] as const){
 if(Bun.argv.includes('--standalone-widths')){await runSharedCase('standalone',lang);continue;}
 for(const kind of ['rig','direction','parts'] as const){
  await runCase(kind,lang);
 }
 for(const kind of ['plan','interview-rig','interview-parts','interview-standalone','standalone','standalone-many'] as const)await runSharedCase(kind,lang);
}
await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');
console.log(`BOTTOM_TABS_838_OK cases=${observations.length}`);
