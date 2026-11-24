/** #1041 ordinary Nova: a refusal in the act row neither widens the row nor changes its height.
 * State: the chest-only mesh fixture, Animate → mesh slot → chest editor → Comment (COMMENT_UNAPPLIED_PREVIEW),
 * which also opens the right panel. At 1280×720 and 1440×900 in EN and KO: the row's scrollWidth equals its
 * clientWidth, Approve and Request changes sit inside the viewport and the row, the row keeps the no-refusal height
 * before, during and after the refusal, the refusal renders its whole text (one line while it fits, else two
 * unclamped lines) with that text in its title, the ask stays on one line with its full sentence in its title,
 * and the save state and both answers keep their content width.
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
type Row={width:number;row:Box&{};scrollWidth:number;clientWidth:number;panelOpen:boolean;headline:Box;headlineFull:boolean;headlineOneLine:boolean;state:Box;stateFits:boolean;save:Box;changes:Box;answersFit:boolean;
 reasonVisible:boolean;message:(Box&{text:string;natural:number;full:boolean;titled:boolean;lines:number})|null};
const measure=`(()=>{const box=n=>{if(!n||!n.getClientRects().length)return null;const b=n.getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
 const fit=n=>!!n&&n.scrollWidth<=n.clientWidth+1&&n.scrollHeight<=n.clientHeight+1;
 const row=document.getElementById('workspace-act-row'),message=document.getElementById('review-message'),headline=document.getElementById('workspace-ask-headline'),state=document.getElementById('review-draft-state');
 let natural=0;if(message?.classList.contains('error')){const copy=message.cloneNode(true);copy.removeAttribute('id');copy.style.cssText='position:absolute;visibility:hidden;white-space:nowrap;display:inline;max-width:none';row.append(copy);natural=copy.getBoundingClientRect().width;copy.remove();}
 return {width:innerWidth,row:box(row),scrollWidth:row.scrollWidth,clientWidth:row.clientWidth,panelOpen:!document.getElementById('workspace-communication').hidden,
  headline:box(headline),headlineFull:!!headline&&headline.title===headline.textContent,headlineOneLine:!!headline&&getComputedStyle(headline).whiteSpace==='nowrap'&&headline.getBoundingClientRect().height<=parseFloat(getComputedStyle(headline).fontSize)*1.6,
  state:box(state),stateFits:!state||!state.getClientRects().length||fit(state),save:box(document.getElementById('save')),changes:box(document.getElementById('request-changes')),
  answersFit:fit(document.getElementById('save'))&&fit(document.getElementById('request-changes')),reasonVisible:!!box(document.getElementById('request-changes-reason')),
  message:message?.classList.contains('error')?{...box(message),text:message.textContent,natural,full:fit(message),titled:message.title===message.textContent,
   lines:Math.round(message.getBoundingClientRect().height/(parseFloat(getComputedStyle(message).lineHeight)||parseFloat(getComputedStyle(message).fontSize)*1.25))}:null};})()`;
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
  // After: leave the chest editor; the refusal stays until the next message, and nothing else moves.
  await click(page,'#chest-edit');await wait(`!!document.getElementById('chest-editor-bar')?.hidden`,'chest editor closed');await Bun.sleep(300);
  const after=await page.evaluate<Row>(measure);
  const w=(b:Box)=>b?Math.round(b.width):null;
  const widths={headline:w(refused.headline),refusal:w(refused.message),refusalNatural:Math.round(refused.message?.natural??0),refusalLines:refused.message?.lines??null,state:w(refused.state),approve:w(refused.save),requestChanges:w(refused.changes)};
  const result={language,width,height,plainRowHeight:plain.row!.height,chestRowHeight:chest.row!.height,refusedRowHeight:refused.row!.height,afterRowHeight:after.row!.height,panelOpen:refused.panelOpen,widths,refused};
  results.push(result);console.log('ACT_ROW_REFUSAL '+JSON.stringify({language,width,height,rows:[plain.row!.height,chest.row!.height,refused.row!.height,after.row!.height],scroll:refused.scrollWidth,client:refused.clientWidth,panelOpen:refused.panelOpen,...widths}));
  const label=`${language} ${width}x${height}`;
  for(const [name,row] of [['the chest editor',chest],['the refusal',refused],['after the refusal',after]] as const)
   check(row.row!.height===plain.row!.height,`${label} ${name} keeps the row height (${row.row!.height}/${plain.row!.height})`);
  check(refused.panelOpen,label+' the refusal is measured with the right panel open');
  check(plain.reasonVisible,label+' the zero-comment reason is visible before the refusal');
  check(!refused.reasonVisible,label+' the zero-comment reason yields to the visible refusal');
  for(const [name,row] of [['refusal',refused],['after',after]] as const){
   check(row.scrollWidth===row.clientWidth,`${label} the ${name} row does not widen (${row.scrollWidth}/${row.clientWidth})`);
   for(const [button,box] of [['Approve',row.save],['Request changes',row.changes]] as const)
    check(box&&box.x>=0&&box.right<=width&&box.y>=row.row!.y&&box.bottom<=row.row!.bottom,`${label} ${name}: ${button} sits inside the viewport and the row (${box?.x}-${box?.right})`);
  }
  check(refused.answersFit&&refused.stateFits,label+' the save state and the answers keep their content width');
  check(refused.message&&refused.message.right<=width&&refused.message.bottom<=refused.row!.bottom,label+' the refusal stays inside the row');
  check(refused.message?.full,label+' the refusal renders its whole text, not clamped');
  check(refused.message&&refused.headline&&refused.headline.right<=refused.message.x+0.5,`${label} the ask ends before the refusal begins (${refused.headline?.right}/${refused.message?.x})`);
  check(refused.message?.titled,label+' the refusal carries its full text in its title');
  check(refused.headlineOneLine&&refused.headlineFull,label+' the ask stays on one line with its full sentence in its title');
 }finally{
  try{await page?.close();}finally{server.kill('SIGINT');await server.exited;await rm(profile,{recursive:true,force:true});}
 }
}
await writeFile(join(output,'observations.json'),JSON.stringify(results,null,2)+'\n');
assert.deepEqual(failures,[],'act-row refusal control');
console.log('ACT_ROW_REFUSAL_PASS');
