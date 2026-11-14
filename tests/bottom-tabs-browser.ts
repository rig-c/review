/** #838 Part 1 browser proof: single non-wrapping bottom tab strip with overflow menu, Timeline first tab, Inspection rename, and chevron collapse control. Ordinary Nova only. */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';

const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/bottom-tabs':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const observations:unknown[]=[];

async function wait(page:InputCdpSession,expression:string,label:string){
 const end=Date.now()+20_000;
 while(Date.now()<end){if(await page.evaluate<boolean>(expression))return;await Bun.sleep(30);}
 throw new Error(`BOTTOM_TABS_WAIT(${label}): ${expression}`);
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

   const initial=await page.evaluate<any>(`(()=>{
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

   if(kind!=='parts'){
    for(const targetId of ['motion-tools','sound-panel','environment','physics-panel','animation-dock']){
     await page.evaluate(`(()=>{
      const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
      const tab=row.querySelector('button[data-block-target="${targetId}"]');
      if(tab&&!tab.hasAttribute('data-tab-overflow'))tab.click();
      else row.querySelector('button[data-block-more-target="${targetId}"]')?.click();
     })()`);
     const switched=await page.evaluate<any>(`(()=>{
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

   if(width===1100&&kind!=='parts'){
    const overflowState=await page.evaluate<any>(`(()=>{
     const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
     const more=row.querySelector('.workspace-tabs-more');
     more.click();
     const menu=row.querySelector('.workspace-tabs-menu');
     const items=[...menu.querySelectorAll('button[role="menuitem"]')].filter(b=>!b.hidden).map(b=>({target:b.dataset.blockMoreTarget,text:b.textContent}));
     return {moreVisible:!more.hidden&&getComputedStyle(more).display!=='none',menuOpen:!menu.hidden&&getComputedStyle(menu).display!=='none',items};
    })()`);
    assert.equal(overflowState.moreVisible,true,'overflow button visible when strip is narrow at 1100x800');
    assert.equal(overflowState.menuOpen,true,'clicking ⋯ opens overflow menu');
    assert.ok(overflowState.items.some((item:any)=>item.target==='report-panel'),'Report tab is in overflow menu');
    await writeFile(join(output,`${kind}-${lang}-${width}x${height}-overflow-menu.png`),await page.screenshot());

    await page.evaluate(`(()=>{
     const row=[...document.querySelectorAll('.workspace-bottom-tabs>.block-row')].find(n=>!n.hidden);
     row.querySelector('button[data-block-more-target="report-panel"]').click();
    })()`);
    const pickedFromMore=await page.evaluate<any>(`(()=>{
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
   }

   await click(page,'#workspace-bottom-collapse');
   await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
   const collapsedState=await page.evaluate<any>(`(()=>{
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

   observations.push({kind,lang,viewport:`${width}x${height}`,initial,collapsedState});
  }
 }finally{
  await page?.close();
  await fixture.close();
  await rm(profile,{recursive:true,force:true});
 }
}

for(const lang of ['en','ko'] as const){
 for(const kind of ['rig','direction','parts'] as const){
  await runCase(kind,lang);
 }
}
await writeFile(join(output,'observations.json'),JSON.stringify(observations,null,2)+'\n');
console.log(`BOTTOM_TABS_838_OK cases=${observations.length}`);
