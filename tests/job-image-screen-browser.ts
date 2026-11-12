/** #772/#773 ordinary Nova: image asks on the one shell, EN/KO, real pointer comments and writer fetch. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {startJobHub,JOB_API_SCHEMA,type JobPublication,type JobPendingAsk,type JobImageSetInput} from '../src/job-host.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {projectComments} from '../src/stage-comment.ts';
import {jobFixture,jobInputHashes} from './helpers/job-api-fixture.ts';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
const arg=Bun.argv.indexOf('--out'),output=resolve(arg<0?'artifacts/image-screen-772':Bun.argv[arg+1]!);
await mkdir(output,{recursive:true});
const cache=process.env.REVIEW_LANE_CACHE??join(homedir(),'Library/Caches/rig-lanes/image-screen-772');await mkdir(cache,{recursive:true});
const scratch=await mkdtemp(join(cache,'browser-')),observations:any[]=[],errors:unknown[]=[];
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
let page:InputCdpSession|undefined,failure:unknown;
const fixture=await jobFixture(),before=await jobInputHashes(fixture.root);
const hub=await startJobHub({stateDir:join(scratch,'state'),port:0,reviewer:{id:'synthetic-owner',role:'owner'}});
let grant='';
const colors=[[220,36,36,255],[36,80,220,255]],images:JobImageSetInput['images'][number][]=[];
for(let i=0;i<2;i++){
 const png=new PNG({width:320,height:200});for(let at=0;at<png.data.length;at+=4)png.data.set(colors[i]!,at);
 const bytes=PNG.sync.write(png),path='image-'+i+'.png';await writeFile(join(fixture.root,path),bytes);
 images.push({name:i?'Candidate 후보':'Source 원본',role:i?'candidate':'source',path,sha256:hash(bytes)});
}
await writeFile(join(fixture.root,'out/review.json'),JSON.stringify({schema:'rig-review/1',id:'image-set-screen',revision:'one',title:'Image set',references:[]}));
const immutable=await jobInputHashes(fixture.root);
const job=await hub.openJob({root:fixture.root,fingerprint:'f'.repeat(64),readerId:'synthetic-image-screen-reader/1',
 readPublished:async()=>({selector:null,plan:null,parts:null,subjects:[],partIds:[],files:[],imageSet:{purpose:'plate-adoption',images}}),
 bindingId:'synthetic-image-screen-writer/1',installWriterBinding:binding=>{grant=binding.fetchCapability;}});
let generation=0;
async function api(verb:string,value:Record<string,unknown>={},consumer=false){
 const response=await fetch(job.origin+'/jobs/'+job.session.jobId+'/api',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(consumer?grant:job.session.hostCredentials().agent)},
 body:JSON.stringify({schema:JOB_API_SCHEMA,jobId:job.session.jobId,requestId:randomUUID(),verb,...(consumer||verb==='next'?{}:{expectedGeneration:generation,idempotencyKey:randomUUID()}),...value})});
 const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));generation=result.generation;return result.value;
}
async function wait(expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page!.evaluate(expression))return;await Bun.sleep(25);}throw new Error('IMAGE_SCREEN_WAIT '+expression);}
async function click(selector:string){await page!.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function composer(text:string){await wait(`!!document.querySelector('.stage-comment-composer input')`);await page!.evaluate(`(()=>{const form=document.querySelector('.stage-comment-composer');form.querySelector('input').value=${JSON.stringify(text)};form.requestSubmit();})()`);await wait(`!document.querySelector('.stage-comment-composer')`);}
try{
 const publication=await api('publish',{result:{path:'out',selector:null},freeze:{kind:'producer-held',holdId:'image-screen-held',record:{path:'record.json',sha256:hash(await readFile(join(fixture.root,'record.json')))}}}) as JobPublication;
 page=await launchCdpSession(join(scratch,'chrome'),{onEvent(event){if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1600,1000);
 for(const language of ['en','ko'] as const){
  const ask=await api('ask',{publicationId:publication.publicationId,subject:{kind:'review-verdict',stage:'image-review'}}) as JobPendingAsk;
  const url=new URL(job.jobUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
  await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#save').disabled`);
  assert.equal(await page.evaluate(`document.documentElement.lang`),language);
  await wait(`document.querySelector('#rig-label').textContent===${JSON.stringify((language==='en'?enCatalog:koCatalog)['job.imageSetTitle'])}`);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('[data-job-image-set] h3')].map(node=>node.textContent)`),images.map(image=>image.name));
  const layout:any=await page.evaluate(`(()=>{const r=node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom};};return {entries:document.querySelectorAll('#app').length,galleries:document.querySelectorAll('[data-job-image-set]').length,notes:[...document.querySelectorAll('textarea')].filter(n=>!n.closest('[hidden]')&&n.getBoundingClientRect().height>0).length,forms:document.querySelectorAll('form[data-job-ask]').length,stage:r(document.querySelector('#rig-viewport')),bottom:r(document.querySelector('.inspector')),bars:document.querySelectorAll('.workspace-main-toolbar').length,secondary:document.querySelectorAll('.workspace-secondary-toolbar').length,controls:['zoom-in','zoom-out','fit','native-one'].map(id=>({id,count:document.querySelectorAll('#'+id).length,x:r(document.getElementById(id)).x})),rows:[...document.querySelectorAll('[data-job-image-set] figure')].map(f=>({name:f.dataset.imageName,image:r(f.querySelector('img')),complete:f.querySelector('img').complete}))};})()`);
  assert.equal(layout.entries,1);assert.equal(layout.galleries,1);assert.equal(layout.notes,0);assert.equal(layout.forms,0);assert.equal(layout.bars,1);assert.equal(layout.secondary,1);
  assert.ok(layout.bottom.y>=layout.stage.bottom);assert.ok(layout.rows.every((r:any)=>r.complete&&r.image.width>0));assert.ok(layout.controls.every((c:any,i:number)=>c.count===1&&(!i||c.x>layout.controls[i-1].x)));
  const zoom=()=>page!.evaluate<string>(`document.querySelector('#rig-root').style.transform`);
  const initial=await zoom();await click('#zoom-in');assert.notEqual(await zoom(),initial);await click('#native-one');assert.equal(await zoom(),'scale(1)');await click('#fit');
  const resize:any=await page.evaluate(`(()=>{const n=document.querySelector('[role="separator"][aria-orientation="horizontal"]');if(!n)return null;const before=n.getAttribute('aria-valuenow');n.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));return {before,after:n.getAttribute('aria-valuenow')};})()`);assert.ok(resize&&resize.before!==resize.after);
  await click('[data-comment-general]');await composer('  General · 전체  ');
  await click('#stage-comment');
  const point:any=await page.evaluate(`(()=>{const image=document.querySelectorAll('[data-job-image-set] img')[1],r=image.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  await page.mouse('mousePressed',point.x,point.y);await page.mouse('mouseReleased',point.x,point.y);await composer('  Candidate spot · 후보  ');
  await wait(`document.querySelectorAll('.stage-comment-item').length===2`);
  await wait(`document.querySelector('.stage-comment-pin')?.textContent==='2'`);
  const screenshot=await page.screenshot();await writeFile(join(output,language+'-comments.png'),screenshot);
  await page.goto(url.href,language);await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#save').disabled&&document.querySelectorAll('.stage-comment-item').length===2`);
  await page.evaluate(`(()=>{const v=document.querySelector('#review-status');v.value='approved';v.dispatchEvent(new Event('change',{bubbles:true}));})()`);await click('#save');
  let act:any;const deadline=Date.now()+20000;while(Date.now()<deadline){const result=await api('next',{after:null,waitMs:0});act=result.events.find((e:any)=>e.type==='act'&&e.act?.askId===ask.askId)?.act;if(act)break;await Bun.sleep(25);}assert.ok(act,'UI committed act');
  assert.equal(act.schema,'rig-review/act@2');assert.equal(act.authority.channel,'review-ui');assert.deepEqual(act.source,publication.source);
  const comments=[{text:'General · 전체'},{text:'Candidate spot · 후보',anchor:{name:images[1]!.name}}];
  assert.deepEqual(act.value,{stage:'image-review',verdict:'approved',words:projectComments(comments),imageNotes:[{name:images[1]!.name,words:projectComments([comments[1]!])}]});
  assert.deepEqual(await api('fetch-act',{actId:act.actId},true),act);
  observations.push({language,layout,resize,act,commentScreenshot:language+'-comments.png',pinTransport:'text projection only; structured position/crop follow-up #776'});
 }
 const directionFixture=await scriptedJobWindowFixture();
 try{
  for(const language of ['en','ko'] as const){
   const publication=await directionFixture.publish('direction','direction-'+language);
   const frozen=await jobInputHashes(directionFixture.input.root);
   const ask=await directionFixture.ask(publication,{kind:'review-verdict',stage:'direction-review'});
   const url=new URL(directionFixture.host.ownerUrl);url.searchParams.set('lang',language);
   await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'&&!document.querySelector('#save').disabled&&!!document.querySelector('#rig-root canvas')`);
   assert.equal(await page.evaluate(`document.documentElement.lang`),language);
   const layout:any=await page.evaluate(`(()=>{const visible=n=>!!n&&!n.closest('[hidden]')&&n.getBoundingClientRect().height>0;return {shells:document.querySelectorAll('#app').length,panels:document.querySelectorAll('#direction-panel').length,directionVisible:visible(document.querySelector('#direction-panel')),actBars:document.querySelectorAll('.workspace-act-bar').length,verdictInBar:!!document.querySelector('.workspace-act-bar #review-status'),notes:[...document.querySelectorAll('textarea[name="note"],textarea[name="words"],form[data-job-ask] textarea')].filter(visible).length,legacyDumps:document.querySelectorAll('[data-job-direction]').length};})()`);
   assert.equal(layout.shells,1);assert.equal(layout.panels,1);assert.equal(layout.directionVisible,true);
   assert.equal(layout.actBars,1);assert.equal(layout.verdictInBar,true);assert.equal(layout.notes,0);assert.equal(layout.legacyDumps,0);
   // #559 successor: exercise the actual shared-screen playback for a direction-bearing post source.
   await page.evaluate(`(()=>{const select=document.querySelector('#animation-select');select.value='inspect';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),'0');
   await click('#play');await wait(`Number(document.querySelector('#scrub').value)>0.05`);await click('#play');
   const paused:string=await page.evaluate<string>(`document.querySelector('#scrub').value`);await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),paused);
   await click('#play');
   await page.evaluate(`(()=>{const scrub=document.querySelector('#scrub');scrub.value='0.123456789';scrub.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),'0.123456789');await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),'0.123456789');
   await page.evaluate(`(()=>{const select=document.querySelector('#animation-select');select.value='short';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),'0');await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),'0');
   await click('#play');await wait(`Number(document.querySelector('#scrub').value)===Number(document.querySelector('#scrub').max)`);
   const ended:string=await page.evaluate<string>(`document.querySelector('#scrub').value`);await Bun.sleep(100);
   assert.equal(await page.evaluate(`document.querySelector('#scrub').value`),ended);
   await click('[data-comment-general]');await composer('Direction comment · 연출');
   await wait(`document.querySelectorAll('.stage-comment-item').length===1`);
   const screenshot=language+'-direction.png';await writeFile(join(output,screenshot),await page.screenshot());
   await page.evaluate(`(()=>{const v=document.querySelector('#review-status');v.value='approved';v.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   await click('#save');
   let act:any;const deadline=Date.now()+20000;
   while(Date.now()<deadline){const next=await directionFixture.next();act=next.events.flatMap(e=>e.type==='act'&&e.act.askId===ask.askId?[e.act]:[])[0];if(act)break;await Bun.sleep(25);}
   assert.ok(act,'direction UI committed act');assert.equal(act.schema,'rig-review/act@6');assert.equal(act.authority.channel,'review-ui');
   assert.equal(act.value.stage,'direction-review');assert.equal(act.value.verdict,'approved');
   assert.equal(act.value.comments.length,1);assert.ok(act.value.comments[0].text.includes('Direction comment · 연출'));
   assert.equal('still' in act,false);assert.deepEqual(act.source.direction,publication.source.direction);
   observations.push({kind:'direction',language,layout,act,screenshot,pinTransport:'text projection only; positions/crops/bookmarks follow-up #776'});
   assert.deepEqual(await jobInputHashes(directionFixture.input.root),frozen);
  }
 }finally{await directionFixture.close();}
 assert.deepEqual(errors,[]);assert.deepEqual(await jobInputHashes(fixture.root),immutable);
}catch(error){failure=error;if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});}
finally{
 await page?.close();await hub.stop();await fixture.close();await rm(scratch,{recursive:true,force:true});
 await writeFile(join(output,'observations.json'),JSON.stringify({status:failure?'RED':'PASS',cases:observations,errors,error:failure instanceof Error?failure.stack:String(failure??''),fixtureBeforeSetup:before},null,2));
}
if(failure)throw failure;
