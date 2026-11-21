/** #1041 ordinary Nova: a refusal in the act row with the right panel open never widens the row.
 * State: the chest-only mesh fixture, Animate → mesh slot → chest editor → Comment (COMMENT_UNAPPLIED_PREVIEW).
 * At 1280×720 in EN and KO the row's scrollWidth equals its clientWidth, Approve and Request changes sit inside
 * the viewport and the refusal takes its own line under the ask. 1440×900 and the no-refusal row are measured too.
 * Usage: bun tests/act-row-refusal-browser.ts --out <dir> */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';

const at=Bun.argv.indexOf('--out'),output=resolve(at<0?'artifacts/act-row-refusal-1041':Bun.argv[at+1]!);
await mkdir(output,{recursive:true});
type Box={x:number;y:number;right:number;bottom:number;width:number;height:number}|null;
type Row={width:number;row:Box&{};scrollWidth:number;clientWidth:number;headline:Box;save:Box;changes:Box;message:(Box&{text:string})|null};
const measure=`(()=>{const box=n=>{if(!n||!n.getClientRects().length)return null;const b=n.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
 const row=document.getElementById('workspace-act-row'),message=document.getElementById('review-message');
 return {width:innerWidth,row:box(row),scrollWidth:row.scrollWidth,clientWidth:row.clientWidth,headline:box(document.getElementById('workspace-ask-headline')),
  save:box(document.getElementById('save')),changes:box(document.getElementById('request-changes')),
  message:message?.classList.contains('error')?{...box(message),text:message.textContent}:null};})()`;
const results:Record<string,unknown>[]=[],failures:string[]=[];
// Every language and size is measured before the verdict, so a failure names each case.
const check=(ok:unknown,message:string)=>{if(!ok)failures.push(message);};
for(const language of ['en','ko'] as const)for(const [width,height] of [[1280,720],[1440,900]] as const){
 const server=Bun.spawn(['bun','tests/job-mesh-act-browser.ts','--serve'],{stdout:'pipe',stderr:'inherit'});
 const reader=server.stdout.getReader();let text='';const until=Date.now()+90_000;
 while(Date.now()<until&&!/KO (\S+)/.test(text)){const {value,done}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);}
 const url=/(?:^|\n)EN (\S+)/.exec(text)?.[1],urlKo=/KO (\S+)/.exec(text)?.[1];
 if(!url||!urlKo)throw new Error('ACT_ROW_REFUSAL_SERVE '+text);
 const profile=await mkdtemp(join(tmpdir(),'review-1041-act-row-refusal-'));let page:InputCdpSession|undefined;
 try{
  page=await launchCdpSession(profile,{sendDeadlineMs:30_000});
  const wait=async(expression:string,label:string)=>{const end=Date.now()+30_000;while(Date.now()<end){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(50);}throw new Error('ACT_ROW_REFUSAL_WAIT '+label);};
  await page.setViewport(width,height);await page.goto(language==='en'?url:urlKo,language);
  await wait(`!!document.querySelector('#rig-root canvas')&&!!document.querySelector('#save:not([hidden])')`,'workspace ready');await Bun.sleep(500);
  const plain=await page.evaluate<Row>(measure);
  await click(page,'[data-mode="rig"]');
  const carrier='[data-part-list] button[data-slot=mesh]';await wait(`!!document.querySelector(${JSON.stringify(carrier)})`,'mesh slot');await click(page,carrier);
  await wait(`!!document.querySelector('#chest-edit:not([hidden]):not(:disabled)')`,'chest editor offered');await click(page,'#chest-edit');
  await wait(`!!document.querySelector('#chest-editor-bar:not([hidden])')`,'chest editor open');await Bun.sleep(300);
  const chest=await page.evaluate<Row>(measure);
  await click(page,'#stage-comment');
  await wait(`document.getElementById('review-message')?.classList.contains('error')&&!!document.querySelector('#workspace-communication:not([hidden])')`,'refusal shown with the right panel open');
  await Bun.sleep(500);
  const refused=await page.evaluate<Row>(measure);
  await writeFile(join(output,`refusal-${language}-${width}x${height}.png`),await page.screenshot());
  const result={language,width,height,plainRowHeight:plain.row!.height,chestRowHeight:chest.row!.height,refusedRowHeight:refused.row!.height,growth:refused.row!.height-plain.row!.height,refused};
  results.push(result);console.log('ACT_ROW_REFUSAL '+JSON.stringify({language,width,height,growth:result.growth,scroll:refused.scrollWidth,client:refused.clientWidth}));
  const label=`${language} ${width}x${height}`;
  check(chest.row!.height===plain.row!.height,label+' the chest editor alone does not change the row');
  check(refused.scrollWidth===refused.clientWidth,`${label} the refusal does not widen the act row (${refused.scrollWidth}/${refused.clientWidth})`);
  for(const [name,box] of [['Approve',refused.save],['Request changes',refused.changes]] as const){
   check(box&&box.x>=0&&box.right<=width&&box.y>=refused.row!.y&&box.bottom<=refused.row!.bottom,`${label} ${name} sits inside the viewport and the row (${box?.x}-${box?.right})`);
  }
  check(refused.message&&refused.message.right<=width&&refused.message.bottom<=refused.row!.bottom,label+' the refusal stays inside the row');
  if(width===1280){
   check(refused.message&&refused.message.y>=refused.headline!.bottom-1&&refused.message.y>=refused.save!.bottom-1,label+' the refusal has its own line under the ask');
   check(refused.message&&Math.abs(refused.message.x-refused.headline!.x)<=1,label+' the refusal line starts under the ask');
  }
 }finally{
  try{await page?.close();}finally{server.kill('SIGINT');await server.exited;await rm(profile,{recursive:true,force:true});}
 }
}
await writeFile(join(output,'observations.json'),JSON.stringify(results,null,2)+'\n');
assert.deepEqual(failures,[],'act-row refusal control');
console.log('ACT_ROW_REFUSAL_PASS');
