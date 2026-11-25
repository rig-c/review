/** #1188: local single-rig verdicts disclose where feedback is saved. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {parseOpenInputs} from '../src/cli.ts';
import {loadOpenPackage} from '../src/open.ts';
import {startServer} from '../src/server.ts';
import type {ReviewSession} from '../src/session.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';

type Language = 'en' | 'ko';
type Verdict = 'approved' | 'changes-requested';
type Reading = {
 width:number;height:number;dpr:number;language:string;status:string;footer:string;
 statusVisible:boolean;footerVisible:boolean;reason:string;
};
const copy = {
 en: {
  before:'Saves locally. The producer receives no feedback.',
  after:'Saved locally',
  footer:'Saved locally. The producer received no feedback.',
  reason:'Add a comment where changes are needed.',
  // #1226 owner ruling: the bar shows the Send comments save state while a verdict ask is pending.
  liveBefore:'Not submitted',
  liveAfter:'Approved · Next step',
  liveFooter:'Human action saved.',
 },
 ko: {
  before:'여기에만 저장돼요. 제작 도구에는 전달되지 않아요.',
  after:'여기에만 저장됨',
  footer:'여기에만 저장했어요. 제작 도구에는 전달되지 않았어요.',
  reason:'고칠 곳에 코멘트를 달아 주세요',
  liveBefore:'제출되지 않음',
  liveAfter:'승인됨 · 다음 단계',
  liveFooter:'사용자 작업을 저장했어요.',
 },
};
const outIndex=Bun.argv.indexOf('--out');
const output=resolve(outIndex<0?'artifacts/local-verdict':Bun.argv[outIndex+1]!);
const scratch=await mkdtemp(join(tmpdir(),'review-1188-'));
const differences:string[]=[];

async function wait(page:InputCdpSession,expression:string) {
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  if(await page.evaluate<boolean>(expression))return;
  await Bun.sleep(50);
 }
 throw Error('LOCAL_VERDICT_WAIT: '+expression);
}
async function openPage(profile:string,url:string,language:Language) {
 let control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
 const page=await launchCdpSession(profile,{onEvent:(event,send)=>{if(event.sessionId)control=send;}});
 try{
  assert.ok(control);
  await control('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:2,mobile:false});
  const target=new URL(url);
  target.searchParams.set('lang',language);
  await page.goto(target.href,language);
  return page;
 }catch(error){await page.close();throw error;}
}
async function readScreen(page:InputCdpSession,language:Language,name:string) {
 const reading=await page.evaluate<Reading>(`(()=>{
  const status=document.getElementById('review-draft-state'),footer=document.getElementById('message');
  const reason=document.getElementById('request-changes-reason');
  return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,language:document.documentElement.lang,
   status:status.textContent.trim(),footer:footer.textContent.trim(),statusVisible:status.checkVisibility(),
   footerVisible:footer.checkVisibility(),reason:reason.checkVisibility()?reason.textContent.trim():''};
 })()`);
 assert.deepEqual([reading.width,reading.height,reading.dpr,reading.language],[1440,900,2,language]);
 await writeFile(join(output,name+'.json'),JSON.stringify(reading,null,2)+'\n');
 return reading;
}
function checkCopy(name:string,actual:string,expected:string) {
 if(actual!==expected)differences.push(name+' expected '+JSON.stringify(expected)+'; read '+JSON.stringify(actual));
}

async function pinComment(page:InputCdpSession) {
 await click(page,'#stage-comment');
 const point=await page.evaluate<{x:number;y:number}>(`(()=>{
  const box=document.getElementById('rig-viewport').getBoundingClientRect();
  return {x:box.left+.54*box.width,y:box.top+.49*box.height};
 })()`);
 await page.mouse('mouseMoved',point.x,point.y);
 await page.mouse('mousePressed',point.x,point.y);
 await page.mouse('mouseReleased',point.x,point.y);
 await wait(page,"!!document.querySelector('.stage-comment-composer input')");
 await page.evaluate(`(()=>{
  const form=document.querySelector('.stage-comment-composer');
  form.querySelector('input').value='Public fixture comment';
  form.requestSubmit();
 })()`);
 await wait(page,"!document.querySelector('.stage-comment-composer')&&!document.getElementById('request-changes').disabled");
}

async function checkLocal(language:Language,verdict:Verdict,opened:Extract<Awaited<ReturnType<typeof loadOpenPackage>>,{mode:'single'}>) {
 const name='local-'+language+'-'+verdict;
 const capability=randomBytes(32).toString('hex');
 const server=await startServer(opened.p,{port:0,joined:opened.joined,capability,stateDir:join(scratch,name)});
 let page:InputCdpSession|undefined;
 try{
  const origin='http://127.0.0.1:'+server.port;
  const session=async()=>(await (await fetch(origin+'/api/session')).json()) as ReviewSession;
  page=await openPage(join(scratch,'chrome-'+name),origin+'/#cap='+capability,language);
  await wait(page,"document.getElementById('request-changes')?.checkVisibility()&&!!document.getElementById('stage-comment-list')");
  if(await page.evaluate<boolean>("!!document.querySelector('dialog.workspace-drawer[open]')"))
   await click(page,'dialog.workspace-drawer[open] .workspace-drawer-close');
  const initial=await readScreen(page,language,name+'-initial');
  assert.equal(initial.reason,copy[language].reason);
  await pinComment(page);
  const before=await readScreen(page,language,name+'-before');
  assert.ok(before.statusVisible&&before.footerVisible);
  assert.equal(before.reason,'');
  assert.equal((await session()).status,'pending');
  checkCopy(name+' before',before.status,copy[language].before);
  await writeFile(join(output,name+'-before.png'),await page.screenshot());

  await click(page,verdict==='approved'?'#save':'#request-changes');
  await wait(page,`document.getElementById('review-status').value===${JSON.stringify(verdict)} && document.getElementById('message').textContent.trim()!==${JSON.stringify(before.footer)} && document.getElementById('review-draft-state').dataset.saveState==='saved'`);
  const after=await readScreen(page,language,name+'-after');
  assert.ok(after.statusVisible&&after.footerVisible);
  checkCopy(name+' after',after.status,copy[language].after);
  checkCopy(name+' footer',after.footer,copy[language].footer);
  const saved=await session();
  assert.equal(saved.status,verdict);
  assert.deepEqual(saved.feedback.map(row=>row.summary),['Public fixture comment']);
  await writeFile(join(output,name+'-after.png'),await page.screenshot());
  console.log('LOCAL_VERDICT',name,JSON.stringify({before:before.status,after:after.status,footer:after.footer,comments:saved.feedback.length}));
 }finally{
  try{await page?.close();}finally{server.stop(true);}
 }
}

async function checkLive(language:Language) {
 const fixture=await scriptedJobWindowFixture({c5Parts:'mesh',scratchParent:scratch});
 const name='live-'+language;
 let page:InputCdpSession|undefined;
 try{
  const publication=await fixture.publish('rig');
  const ask=await fixture.ask(publication,{kind:'review-verdict',stage:'rig-review'});
  page=await openPage(join(scratch,'chrome-'+name),fixture.host.ownerUrl,language);
  await wait(page,"document.body.dataset.ready==='true'&&document.getElementById('save')?.checkVisibility()&&!document.getElementById('save').disabled");
  if(await page.evaluate<boolean>("!!document.querySelector('dialog.workspace-drawer[open]')"))
   await click(page,'dialog.workspace-drawer[open] .workspace-drawer-close');
  const before=await readScreen(page,language,name+'-before');
  checkCopy(name+' before',before.status,copy[language].liveBefore);
  await click(page,'#save');
  await wait(page,`document.getElementById('message')?.textContent.trim()===${JSON.stringify(copy[language].liveFooter)}`);
  const after=await readScreen(page,language,name+'-after');
  assert.ok(after.statusVisible&&after.footerVisible);
  checkCopy(name+' after',after.status,copy[language].liveAfter);
  checkCopy(name+' footer',after.footer,copy[language].liveFooter);
  const events=await fixture.next();
  assert.ok(events.events.some(event=>event.type==='act'&&event.act.askId===ask.askId));
  await writeFile(join(output,name+'-after.png'),await page.screenshot());
  console.log('LIVE_VERDICT_CONTROL',name,JSON.stringify({before:before.status,after:after.status,footer:after.footer}));
 }finally{
  try{await page?.close();}finally{await fixture.close();}
 }
}

try{
 await mkdir(output,{recursive:true});
 const root=join(scratch,'project');
 await mkdir(root);
 const archive=join(import.meta.dir,'fixtures/create-reopened-v2/project.tar.gz');
 const extract=Bun.spawnSync(['tar','-xzf',archive,'-C',root]);
 assert.equal(extract.exitCode,0,extract.stderr.toString());
 await mkdir(join(root,'reviewer-picks'));
 const opened=await loadOpenPackage(parseOpenInputs([join(root,'derived/review/v2/out'),
  '--project',root,'--project-version','2','--picks-dir','reviewer-picks']));
 assert.equal(opened.mode,'single');
 assert.ok(opened.joined&&opened.p.manifest.model);
 for(const language of ['en','ko'] as const){
  for(const verdict of ['changes-requested','approved'] as const)await checkLocal(language,verdict,opened);
  await checkLive(language);
 }
 assert.deepEqual(differences,[],'local verdict copy and live job controls');
 console.log('LOCAL_VERDICT_PASS: 4 local verdicts, 2 live controls');
}finally{await rm(scratch,{recursive:true,force:true});}
