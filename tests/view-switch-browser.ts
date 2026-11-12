/** #736 Amendment 1: original menu and toolbar in Setup/Animate, EN/KO, on ordinary Nova only.
 * Uses the existing demo, server, CDP driver and pointer-click helper; no synthetic screen or act.
 */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {assertReviewUnchanged} from '../src/reference.ts';
import {startServer} from '../src/server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';

const at=Bun.argv.indexOf('--out');
const output=resolve(at<0?'artifacts/view-switch-736-amendment-1':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
const scratch=await mkdtemp(join(tmpdir(),'review-736-amendment-1-'));
const pkg=await loadReview(resolve(import.meta.dir,'../examples/demo/review.json'));
const server=await startServer(pkg,{port:0,stateDir:join(scratch,'state'),viewOnly:true});
const expectedIds=['compare','reference','rig','difference'];
const toolbarIds=['stage-comment','camera-sync','zoom-in','zoom-out','fit','native-one','view-menu','zoom-value'];
type LayoutObservation={id:string;label:string;closed:boolean;disabled:string[];referenceHidden:boolean;rigHidden:boolean};
type MenuObservation={language:string;mode:string;viewport:{width:number;height:number};open:boolean;toolbar:string[];cameraTarget:string;zoomValue:string;
 headings:number;placement:{parent:string;previous:string;next:string;cameraSeam:boolean;left:number;top:number;width:number;height:number};
 choices:{id:string;label:string;disabled:boolean;visible:boolean}[]};
const observations:unknown[]=[];
let page:InputCdpSession|undefined;

async function wait(expression:string,name:string){
 await withDeadline('736.amendment-1.'+name,20_000,async signal=>{
  while(!signal.aborted){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}
  throw signal.reason;
 });
}

try{
 for(const language of ['en','ko'] as const){
  const catalog=language==='en'?enCatalog:koCatalog;
  let setupPlacement:MenuObservation['placement']|undefined;
  page=await launchCdpSession(join(scratch,'profile-'+language));
  await page.setViewport(1600,1000);
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${language}`,language);
  await wait(`!document.body.inert && !!document.querySelector('#stage-comment-list') &&
   !!document.querySelector('#view-menu [data-view="compare"]:not(:disabled)')`,language+'.loaded');
  // #806: preserve the standalone assertion formerly carried by the removed embedded-host probe.
  const languageSelectCount=await page.evaluate<number>(`[...document.querySelectorAll('#settings-language')].filter(node=>node.getClientRects().length>0).length`);
  assert.equal(languageSelectCount,1);
  observations.push({language,standaloneLanguageSelectCount:languageSelectCount});
  for(const mode of ['rig','playback'] as const){
   const name=language+'-'+(mode==='rig'?'setup':'animate');
   await click(page,`.topbar [data-mode="${mode}"]`);
   await wait(`document.querySelector('.topbar [data-mode="${mode}"]').getAttribute('aria-pressed')==='true'`,name+'.mode');
   await click(page,'#view-menu>summary');
   const menu:MenuObservation=await page.evaluate<MenuObservation>(`(()=>{
    const menu=document.getElementById('view-menu'),toolbar=document.querySelector('.workspace-main-toolbar');
    const rect=menu.querySelector('summary').getBoundingClientRect();
    return {language:document.documentElement.lang,mode:document.querySelector('.topbar [data-mode][aria-pressed="true"]').dataset.mode,
     viewport:{width:innerWidth,height:innerHeight},open:menu.open,
     cameraTarget:JSON.parse(document.getElementById('view-coordinates').textContent).activeCamera,zoomValue:document.getElementById('zoom-value').textContent,
     toolbar:[...toolbar.querySelectorAll(${JSON.stringify(toolbarIds.map(id=>'#'+id).join(','))})].map(node=>node.id),
     headings:menu.querySelectorAll('.view-menu-group,strong').length,
     placement:{parent:menu.parentElement.className,previous:menu.previousElementSibling.id,next:menu.nextElementSibling.id,
      cameraSeam:!!menu.closest('[data-workspace-camera]'),left:rect.left,top:rect.top,width:rect.width,height:rect.height},
     choices:[...menu.querySelectorAll('[data-view]')].map(button=>{
      const r=button.getBoundingClientRect();
      return {id:button.dataset.view,label:button.textContent,disabled:button.disabled,
       visible:!button.closest('[hidden]')&&r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};
     })};
   })()`);
   await writeFile(join(output,'menu-'+name+'.json'),JSON.stringify(menu,null,2)+'\n');
   await writeFile(join(output,'menu-'+name+'.png'),await page.screenshot());
   assert.equal(menu.language,language);assert.equal(menu.mode,mode);
   assert.deepEqual(menu.viewport,{width:1600,height:1000});assert.equal(menu.open,true);
   assert.deepEqual(menu.toolbar,toolbarIds);assert.equal(menu.headings,0);assert.equal(menu.cameraTarget,'rig');
   assert.equal(menu.zoomValue,catalog['100% · Rig']??('100% · '+catalog['Rig']));
   assert.deepEqual(menu.choices.map(choice=>choice.id),expectedIds);
   assert.deepEqual(menu.choices.map(choice=>choice.label),['Side by side','Reference','Rig','Difference'].map(key=>catalog[key]));
   assert(menu.choices.every(choice=>choice.visible));
   assert.deepEqual(menu.choices.filter(choice=>choice.disabled).map(choice=>choice.id),['difference']);
   assert.equal(menu.placement.parent,'zoom-controls');assert.equal(menu.placement.previous,'native-one');
   assert.equal(menu.placement.next,'zoom-value');assert.equal(menu.placement.cameraSeam,true);
   if(mode==='rig')setupPlacement=menu.placement;else assert.deepEqual(menu.placement,setupPlacement,'menu position must stay unchanged between Setup and Animate');
   const transitions:LayoutObservation[]=[];
   // Finish on Rig before Side by side, so the next mode has the same active-camera readout width.
   for(const id of ['reference','rig','compare']){
    if(!(await page.evaluate<boolean>(`document.getElementById('view-menu').open`)))await click(page,'#view-menu>summary');
    await click(page,`#view-menu [data-view="${id}"]`);
    await wait(`document.querySelector('#view-menu [data-view="${id}"]').getAttribute('aria-pressed')==='true'`,name+'.'+id);
    const state:LayoutObservation=await page.evaluate<LayoutObservation>(`({
     id:${JSON.stringify(id)},label:document.getElementById('view-menu-label').textContent,closed:!document.getElementById('view-menu').open,
     disabled:[...document.querySelectorAll('#view-menu [data-view]:disabled')].map(button=>button.dataset.view),
     referenceHidden:document.getElementById('reference-pane').hidden,rigHidden:document.getElementById('rig-pane').hidden
    })`);
    transitions.push(state);
    await writeFile(join(output,'transitions-'+name+'.json'),JSON.stringify(transitions,null,2)+'\n');
    assert.equal(state.closed,true);assert.deepEqual(state.disabled,['difference']);
    assert.equal(state.label,catalog[id==='rig'?'Rig':id==='reference'?'Reference':'Side by side']);
    assert.equal(state.referenceHidden,id==='rig');assert.equal(state.rigHidden,id==='reference');
   }
   await writeFile(join(output,'toolbar-'+name+'.png'),await page.screenshot());
   await assertReviewUnchanged(pkg);
   observations.push({language,mode,menu,transitions,sourceHash:pkg.sourceHash});
  }
  await page.close();page=undefined;
 }
 await writeFile(join(output,'result.json'),JSON.stringify({status:'passed',amendment:1,screens:4,languages:2,modes:2,choicesPerScreen:4,groupHeadings:0,layoutTransitions:12,placementChecks:2,source:'bundled synthetic lantern demo; no upstream compiler acceptance claim',observations},null,2)+'\n');
 console.log('PASS #736 Amendment 1: EN/KO Setup/Animate 1600x1000, 3 original choices plus unavailable Difference, unchanged toolbar and menu placement, 12 legacy-id layout transitions');
}finally{
 await page?.close();await server.stop(true);await rm(scratch,{recursive:true,force:true});
}
