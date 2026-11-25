/** #1048 ordinary Nova: a record plan's declared `planPicture` (PR1) and a record interview's sealed question image
 * (PR2) take pointed and region comments through the existing stage-comments pin layer. They save, survive reload, stay
 * on the same picture pixel after zoom and fit, and submit with the A1 label (sealed path and sha256, integer natural
 * pixels): the plan sign-off in its `words`, the interview picks in structured `value.comments` with a
 * general comment (HQ ruling 3, bar 3). Republishing new picture bytes drops the unsent pin with the existing
 * carry-over notice. #1068 `backdrop`: the same question image over a retained rig backdrop takes the same pins at
 * 1440×900, and rig-backdrop rows restored on that host keep main's stored bytes (golden captured on main) and emit structured comments.
 * Synthetic public fixtures only.
 * Usage: bun tests/job-plan-picture-comments-browser.ts --out <dir> [--subject plan|question|backdrop] [--lang en|ko] [--size 1440x900|1280x720]
 *        bun tests/job-plan-picture-comments-browser.ts --serve [--subject plan|question|backdrop] [--lang en|ko] [--republish] */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {feedbackItemComments,projectComments} from '../src/stage-comment.ts';
import {createJobHostPorts,jobHash,parseCommentsAct,parseRecordAct} from '../src/job-api.ts';
import {JOB_API_V3_SCHEMA,jobRawActMediaType,type PendingAskV3} from '../src/job-contract.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(key:string)=>{const at=Bun.argv.indexOf(key);return at<0?undefined:Bun.argv[at+1];};
const W=320,H=240;
/** A quartered picture: the pins' pixels are easy to read in a capture. `shift` changes the bytes for a republish. */
function pictureBytes(shift=0):Buffer{
 const png=new PNG({width:W,height:H});
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4,q=(x<W/2?0:1)+(y<H/2?0:2);
  const c=[[230,20,160],[40,140,230],[250,200,40],[60,190,90]][q]!;png.data[i]=c[0]!;png.data[i+1]=(c[1]!+shift)%256;png.data[i+2]=c[2]!;png.data[i+3]=255;}
 return PNG.sync.write(png);
}
type Subject='plan'|'question'|'backdrop';
// #1227: checkpoint until #1229 retires record asks
const fixtureFor=(subject:Subject)=>subject==='plan'
 ?recordScreenFixture('checkpoint',true,undefined,'plan-approved',false,true,undefined,false,false,undefined,undefined,pictureBytes())
 :recordScreenFixture('interview-picks',subject==='backdrop',undefined,'plan-approved',false,true,undefined,false,false,undefined,undefined,undefined,pictureBytes());
/** The sealed `files` entry the pins must name: the plan's `planPicture`, or the question image's entry. */
function sealedPicture(subject:Subject,source:unknown):{path:string;sha256:string}{
 const value=source as {planPicture?:{path:string;sha256:string};files:{path:string;sha256:string}[]};
 const picture=subject==='plan'?value.planPicture:value.files.find(file=>file.path==='inputs/reference.png');
 assert.ok(picture,'the publication seals its '+subject+' picture');return picture;
}
/** Commit the captured browser submission through the real retained session and consumer transport. */
async function verifyPicksReplay(fixture: Awaited<ReturnType<typeof fixtureFor>>, out: string, act: ReturnType<typeof parseCommentsAct>) {
 const {session,origin,submissions}=fixture,submitted=submissions.at(-1);
 assert.ok(submitted?.kind==='interview-picks');
 const {publicationId}=submitted,expectedGeneration=session.status().generation,signal=new AbortController().signal;
 const base={schema:JOB_API_V3_SCHEMA,jobId:session.jobId} as const;
 const ask=await session.execute({...base,verb:'ask',requestId:'picks-replay-ask',idempotencyKey:'picks-replay-ask',
  expectedGeneration,publicationId,subject:fixture.ask.subject},signal) as PendingAskV3;
 const display=session.ackDisplayed({publicationId,pageId:submitted.pageId,sourceHash:ask.source.sourceHash});
 const input={...submitted,...display,askId:ask.askId,expectedGeneration:session.status().generation};
 const saved=await session.commitUIAct(input),bytes=JSON.stringify(saved);
 assert.equal(JSON.stringify(parseCommentsAct(saved)),bytes);
 assert.equal(JSON.stringify(saved.value),JSON.stringify(act.value));
 assert.equal(JSON.stringify(await session.commitUIAct(input)),bytes);
 const consumer=await createJobHostPorts(session,origin).handleJobApi(new Request(origin+'/jobs/'+session.jobId+'/api',{
  method:'POST',headers:{'Content-Type':'application/json',Accept:jobRawActMediaType,Authorization:'Bearer '+session.writerGrant().fetchCapability},
  body:JSON.stringify({...base,verb:'fetch-act',requestId:'picks-replay-fetch',actId:saved.actId}),
 }));
 assert.equal(consumer.status,200);
 const fetched=await consumer.text();
 assert.equal(fetched,bytes);
 await writeFile(join(out,'replayed-consumer-act.json'),fetched);
 return jobHash(fetched);
}
const subjectArg=arg('--subject') as Subject|undefined;

if(Bun.argv.includes('--serve')){
 const subject=subjectArg??'plan',fixture=await fixtureFor(subject),url=new URL(fixture.ownerUrl);url.searchParams.set('lang',arg('--lang')??'en');
 if(Bun.argv.includes('--republish'))console.log(JSON.stringify({note:'leave a pin, then press Enter here to republish new picture bytes and reload'}));
 console.log(JSON.stringify({url:url.href,pid:process.pid,picture:sealedPicture(subject,fixture.display.publication.source),fixture:'synthetic trusted record host; '+subject+' picture'}));
 if(Bun.argv.includes('--republish')){for await(const _line of console){const next=await fixture.republishPicture(pictureBytes(97));console.log(JSON.stringify({republished:next.publication.publicationId,picture:sealedPicture(subject,next.publication.source)}));break;}}
 await new Promise<void>(done=>{process.once('SIGTERM',done);process.once('SIGINT',done);});await fixture.close();process.exit(0);
}

const output=resolve(arg('--out')??'artifacts/1048');await mkdir(output,{recursive:true});
const languages=(arg('--lang')?[arg('--lang')]:['en','ko']) as ('en'|'ko')[];
const subjects:Subject[]=subjectArg?[subjectArg]:['plan','question','backdrop'];
const sizes=(arg('--size')?[arg('--size')!]:['1440x900','1280x720']).map(size=>size.split('x').map(Number) as [number,number]);
const profile=await mkdtemp(join(tmpdir(),'review-1048-browser-'));let page:InputCdpSession|undefined;
const errors:unknown[]=[],cases:unknown[]=[];
let control:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
async function wait(expression:string,label:string){const until=Date.now()+30000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('1048_WAIT '+label);}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
/** The sealed picture is the reference view's drawn image at its natural size. */
const pictureDrawn=`document.body.dataset.ready==='true'&&document.querySelector('#reference-content img')?.naturalWidth===${W}`;
type Geometry={scale:number;left:number;top:number};
/** Picture pixel → viewport (CSS) point, read from the drawn picture itself. */
const geometry=()=>page!.evaluate<Geometry>(`(()=>{const img=document.querySelector('#reference-content img'),r=img.getBoundingClientRect();
 return {scale:r.width/img.naturalWidth,left:r.left,top:r.top};})()`);
const at=(g:Geometry,x:number,y:number)=>({x:g.left+x*g.scale,y:g.top+y*g.scale});
async function save(text:string){await wait(`!!document.querySelector('.stage-comment-composer input')`,'composer');
 await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);
 await wait(`!document.querySelector('.stage-comment-composer')`,'composer saved');}
async function captureOn(){await wait(`!!document.querySelector('#stage-comment-list')`,'comments bound');
 if(await page!.evaluate<boolean>(`!document.querySelector('#reference-viewport.stage-comment-mode')`))await click(page!,'#stage-comment');
 await wait(`!!document.querySelector('#reference-viewport.stage-comment-mode')`,'pin mode on the picture');}
async function pointAt(x:number,y:number){const g=await geometry(),p=at(g,x,y);await page!.mouse('mouseMoved',p.x,p.y);await page!.mouse('mousePressed',p.x,p.y);await page!.mouse('mouseReleased',p.x,p.y);}
async function dragFrom(a:[number,number],b:[number,number]){const g=await geometry(),p=at(g,...a),q=at(g,...b);
 await page!.mouse('mouseMoved',p.x,p.y);await page!.mouse('mousePressed',p.x,p.y);await page!.mouse('mouseMoved',(p.x+q.x)/2,(p.y+q.y)/2);await page!.mouse('mouseMoved',q.x,q.y);await page!.mouse('mouseReleased',q.x,q.y);}
/** #1062: the composer a pin click opens takes keyboard text at once. Typing goes through CDP input, never a focus() call. */
async function typedWithoutFocus(text:string){await wait(`!!document.querySelector('.stage-comment-composer input')`,'composer');
 const focused=await page!.evaluate<boolean>(`document.activeElement===document.querySelector('.stage-comment-composer input')`);
 assert.equal(focused,true,'1062_COMPOSER_FOCUS: the pin composer focuses its text field when it opens');
 assert.ok(control,'CDP input');await control!('Input.insertText',{text});
 assert.equal(await page!.evaluate<string>(`document.querySelector('.stage-comment-composer input').value`),text,'typing without clicking the field fills it');}
/** #1062: a still picture has no clock. Its row names the picture and the place, never a time or frame warning. */
async function assertPictureRows(catalog:Readonly<Record<string,string>>,picture:{path:string},places:string[],label:string){
 const name=picture.path.split('/').at(-1)!,seconds=catalog['{0} s (seconds basis)']!.replace('{0}',''),unavailable=catalog['Frame unavailable']!;
 const rows=await page!.evaluate<string[]>(`[...document.querySelectorAll('#stage-comment-list .stage-comment-item')].map(row=>[row,...row.querySelectorAll('*')].flatMap(n=>[n.textContent,n.getAttribute('title'),n.getAttribute('aria-label'),n.getAttribute('aria-description')]).filter(Boolean).join(' | '))`);
 assert.equal(rows.length,places.length,label+' rows');
 rows.forEach((text,index)=>{
  for(const bad of ['COMMENT_FRAME_UNAVAILABLE',unavailable,seconds])assert.ok(!text.includes(bad),`1062_ROW ${label}: row ${index+1} carries ${JSON.stringify(bad)}: ${text}`);
  assert.ok(text.includes(name),`1062_ROW ${label}: row ${index+1} names the picture: ${text}`);
  assert.ok(text.includes(' · '+catalog[places[index]!]+' · '),`1062_ROW ${label}: row ${index+1} names the place ${places[index]}: ${text}`);
 });
 const tree=await control!('Accessibility.getFullAXTree',{}) as {nodes:{name?:{value?:unknown};description?:{value?:unknown}}[]};
 const named=tree.nodes.flatMap(n=>[n.name?.value,n.description?.value]).filter((v):v is string=>typeof v==='string'&&(v.includes('COMMENT_FRAME_UNAVAILABLE')||v.includes(unavailable)));
 assert.deepEqual(named,[],`1062_ROW ${label}: no accessible name or description carries the frame warning`);
 return rows;
}
type Row={id:string;summary:string;target?:unknown;context:{comment:{viewport:string;referenceId:string;referenceHash:string;world:{x:number;y:number;width:number;height:number};camera:{space:string}}}};
const draft=()=>page!.evaluate<{key:string;value:{sourceHash:string;comments:Row[]}}[]>(`Object.entries(localStorage).filter(([key])=>key.startsWith('rig-review-record-comments/1:')).map(([key,raw])=>({key,value:JSON.parse(raw)}))`);
/** Each drawn region's top-left, back in picture pixels, must be the saved `world` corner. Zoom and fit animate, so the
 * check retries until the drawn picture and the pins agree or three seconds pass. */
async function assertPinsOnPicture(rows:Row[],label:string){
 await wait(`document.querySelectorAll('#reference-viewport .stage-comment-region').length===${rows.length}`,label+' pins drawn');
 const until=Date.now()+3000;let failure='';
 while(true){
  const {g,drawn}=await page!.evaluate<{g:Geometry;drawn:{x:number;y:number;w:number;h:number}[]}>(`(()=>{const img=document.querySelector('#reference-content img'),r=img.getBoundingClientRect();
   return {g:{scale:r.width/img.naturalWidth,left:r.left,top:r.top},drawn:[...document.querySelectorAll('#reference-viewport .stage-comment-region')].map(n=>{const b=n.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height};})};})()`);
  failure='';
  rows.forEach((row,index)=>{const world=row.context.comment.world,d=drawn[index]!,tolerance=1.5/g.scale+.5;
   const px=(d.x-g.left)/g.scale,py=(d.y-g.top)/g.scale,pw=d.w/g.scale;
   if(Math.abs(px-world.x)>tolerance||Math.abs(py-world.y)>tolerance||world.width>0&&Math.abs(pw-world.width)>2/g.scale+.5)
    failure||=`${label}: pin ${index+1} drawn at picture pixel (${px.toFixed(2)},${py.toFixed(2)},w ${pw.toFixed(2)}) for saved ${JSON.stringify(world)}`;
  });
  if(!failure)return {scale:g.scale,drawn};
  if(Date.now()>until)assert.fail(failure);
  await Bun.sleep(50);
 }
}
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{if(event.sessionId)control=send;if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});
 for(const subject of subjects)for(const [width,height] of sizes)for(const language of languages){
  const catalog=language==='en'?enCatalog:koCatalog,name=`${width}x${height}`;
  if(subject==='backdrop'&&name!=='1440x900')continue;
  await page.setViewport(width,height);
  // Case 1: point and region, reload, zoom, fit, submit.
  {const fixture=await fixtureFor(subject),out=join(output,subject,'pins',name,language);await mkdir(out,{recursive:true});fixture.output(out);
   const picture=sealedPicture(subject,fixture.display.publication.source);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
   try{
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
    await wait(pictureDrawn,subject+' picture drawn');
    await captureOn();await shot(out,'1-pin-mode');
    await pointAt(80,60);await typedWithoutFocus('Point · 점 '+language);await save('Point · 점 '+language);
    await captureOn();await dragFrom([200,150],[280,210]);await save('Region · 영역 '+language);
    await shot(out,'2-saved');
    const rowText=await assertPictureRows(catalog,picture,['Point','Region'],'after save');
    const list=await page.evaluate<{x:number;y:number;width:number;height:number}>(`(()=>{const r=document.querySelector('#stage-comment-list').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:Math.max(1,r.height)};})()`);
    await writeFile(join(out,'2-saved-rows.png'),await page.screenshot(list));
    const saved=await draft();assert.equal(saved.length,1,'one record draft');
    const rows=saved[0]!.value.comments;assert.equal(rows.length,2);
    for(const row of rows){const c=row.context.comment;
     assert.equal(c.viewport,'reference');assert.equal(c.camera.space,'image');
     assert.equal(c.referenceId,picture.path,'referenceId is the sealed files entry path');
     assert.equal(c.referenceHash,picture.sha256,'referenceHash is the sealed sha256');}
    const [point,area]=rows.map(row=>row.context.comment.world) as [Row['context']['comment']['world'],Row['context']['comment']['world']];
    assert.ok(Math.abs(point.x-80)<=1&&Math.abs(point.y-60)<=1&&point.width===0&&point.height===0,'point in natural pixels '+JSON.stringify(point));
    assert.ok(Math.abs(area.x-200)<=1&&Math.abs(area.y-150)<=1&&Math.abs(area.width-80)<=1.5&&Math.abs(area.height-60)<=1.5,'region in natural pixels '+JSON.stringify(area));
    const fresh=await assertPinsOnPicture(rows,'after save');
    await page.goto('about:blank');await page.goto(url.href,language);
    await wait(`${pictureDrawn}&&document.querySelectorAll('#stage-comment-list .stage-comment-item').length===2`,'reload restores both pins');
    const reloaded=await assertPinsOnPicture(rows,'after reload');await shot(out,'3-reloaded');
    await assertPictureRows(catalog,picture,['Point','Region'],'after reload');
    await click(page,'#zoom-in');await click(page,'#zoom-in');
    await wait(`(()=>{const img=document.querySelector('#reference-content img');return img.getBoundingClientRect().width/img.naturalWidth>${reloaded.scale*1.05};})()`,'zoomed');
    const zoomed=await assertPinsOnPicture(rows,'after zoom');await shot(out,'4-zoomed');
    await click(page,'#fit');await Bun.sleep(300);
    const fitted=await assertPinsOnPicture(rows,'after fit');await shot(out,'5-fit');
    const labels=rows.map(row=>{const w=row.context.comment.world;return JSON.stringify(['rig-review-comment/1','setup','reference',picture.path,picture.sha256,Math.round(w.x),Math.round(w.y),Math.round(w.width),Math.round(w.height)]);});
    let general:string|null=null;
    if(subject!=='plan'){
     // Bar 3: a general comment on an interview host now reaches the act with the pins.
     general='General · 일반 '+language;await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await save(general);
     await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===3`,'general comment listed');
    }
    const all=(await draft())[0]!.value.comments;assert.equal(all.length,rows.length+(general?1:0));
    const expected=projectComments(all.map(row=>'target' in row?feedbackItemComments([row as never])[0]!:{text:row.summary}),[picture]);
    assert.equal(expected,`[${labels[0]}]\n${rows[0]!.summary}\n\n[${labels[1]}]\n${rows[1]!.summary}`+(general?`\n\n[general]\n${general}`:''),'A1 label');
    if(subject==='plan'){
     // #1227: checkpoint until #1229 retires record asks; the words carry the A1 labels.
     await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#workspace-communication:not([hidden]) #job-record-asks:not([hidden])')`,'record section');
     await shot(out,'6-before-submit');await click(page,selector+' button.primary[type=submit]');
     await expectRecordActSubmitted(page,wait,language,'plan checkpoint submitted');
    }else{
     // Submit the interview picks with the original pointed and general comments.
     for(const value of ['biped_std','density_high']){const option=selector+` label.interview-option:has(input[value="${value}"])`;
      await page.evaluate(`document.querySelector(${JSON.stringify(option)}).scrollIntoView({block:'center'})`);await click(page,option);}
     await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).scrollIntoView({block:'center'})`);
     await shot(out,'6-before-submit');await click(page,selector+' button[type=submit]');
     await wait(`!!document.querySelector(${JSON.stringify(selector+'[data-interview-answered=true]')})`,'interview saved');
    }
    const bytes=await readFile(join(out,'one-screen.json'),'utf8');
    const act=subject==='plan'?parseRecordAct(JSON.parse(bytes)):parseCommentsAct(JSON.parse(bytes));
    assert.equal(act.kind,subject==='plan'?'checkpoint':'interview-picks');assert.equal(act.source.sourceHash,fixture.display.publication.source.sourceHash);
    assert.ok('record' in act.source&&act.source.files.some(file=>file.path===picture.path&&file.sha256===picture.sha256),'the label names a sealed files entry of the act source');
    if(act.schema==='rig-review/act@6'){
     assert.equal(JSON.stringify(act.value.comments),JSON.stringify(all.map(row=>'target' in row?feedbackItemComments([row as never])[0]!:{text:row.summary})));
     assert.equal(JSON.stringify(act),bytes,'picks round-trip byte-for-byte');
    }else assert.equal((act.value as {words?:string}).words,expected,'plan checkpoint keeps the A1 labels');
    const replayActSha256=act.schema==='rig-review/act@6'?await verifyPicksReplay(fixture,out,act):null;
    await shot(out,'7-submitted');
    const result={case:'pins',subject,size:name,language,picture,rowText,rows:rows.map(row=>({summary:row.summary,world:row.context.comment.world})),labels,general,...(act.schema==='rig-review/act@6'?{structuredComments:act.value.comments,replayActSha256}:{words:expected}),
     scales:{fresh:fresh.scale,reloaded:reloaded.scale,zoomed:zoomed.scale,fitted:fitted.scale}};
    cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('1048_PINS_PASS '+subject+' '+name+' '+language);
   }catch(error){await shot(out,'failure').catch(()=>{});throw error;}finally{await page.goto('about:blank');await fixture.close();}
  }
  // #1068: restored rig-backdrop rows keep main's stored bytes and travel as structured pins.
  if(subject==='backdrop'){const golden=JSON.parse(await readFile(new URL('./fixtures/record-backdrop-rig-pins-1068.json',import.meta.url),'utf8')) as {rows:Row[];general:string;words:string;rowTextEn:string[]};
   const fixture=await fixtureFor(subject),out=join(output,subject,'rig-golden',name,language);await mkdir(out,{recursive:true});fixture.output(out);
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`,source=fixture.display.publication.source,ask=fixture.ask.subject as {questionId:string;setId:string};
   try{
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
    await wait(pictureDrawn,'backdrop question image drawn');
    const key=`rig-review-record-comments/1:${fixture.session.jobId}:${ask.questionId}:${ask.setId}:${source.sourceHash}`;
    await page.evaluate(`localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(JSON.stringify({status:'pending',publicationId:fixture.display.publication.publicationId,sourceHash:source.sourceHash,comments:golden.rows}))})`);
    await page.goto('about:blank');await page.goto(url.href,language);
    await wait(`${pictureDrawn}&&document.querySelectorAll('#stage-comment-list .stage-comment-item').length===${golden.rows.length}`,'rig rows restored');
    if(language==='en')assert.deepEqual(await page.evaluate<string[]>(`[...document.querySelectorAll('#stage-comment-list .stage-comment-item')].map(row=>row.textContent)`),golden.rowTextEn,'rig rows read as on main');
    await page.evaluate(`document.querySelector('[data-comment-general]').click()`);await save(golden.general);
    const stored=(await draft())[0]!.value.comments;assert.equal(stored.length,golden.rows.length+1);
    assert.equal(JSON.stringify(stored.slice(0,golden.rows.length)),JSON.stringify(golden.rows),'1068_RIG_ROWS: stored rig rows are byte-identical to main');
    for(const value of ['biped_std','density_high']){const option=selector+` label.interview-option:has(input[value="${value}"])`;
     await page.evaluate(`document.querySelector(${JSON.stringify(option)}).scrollIntoView({block:'center'})`);await click(page,option);}
    await page.evaluate(`document.querySelector(${JSON.stringify(selector+' button[type=submit]')}).scrollIntoView({block:'center'})`);await click(page,selector+' button[type=submit]');
    await wait(`!!document.querySelector(${JSON.stringify(selector+'[data-interview-answered=true]')})`,'interview saved');
    const bytes=await readFile(join(out,'one-screen.json'),'utf8'),act=parseCommentsAct(JSON.parse(bytes));
    assert.equal(JSON.stringify(act.value.comments),JSON.stringify([...feedbackItemComments(golden.rows as never),{text:golden.general}]));
    assert.equal(projectComments(act.value.comments),golden.words,'1068_RIG_LABELS: the projected rig labels are byte-identical to main');
    assert.equal(JSON.stringify(act),bytes);
    const replayActSha256=await verifyPicksReplay(fixture,out,act);
    await shot(out,'1-rig-rows-submitted');
    const result={case:'rig-golden',subject,size:name,language,rows:golden.rows.length,words:golden.words,replayActSha256};cases.push(result);
    await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('1068_RIG_GOLDEN_PASS '+name+' '+language);
   }catch(error){await shot(out,'failure').catch(()=>{});throw error;}finally{await page.goto('about:blank');await fixture.close();}
   continue;
  }
  // Case 2 (B2): republish with new picture bytes; the unsent pin is reported by the carry-over notice, not kept.
  {const fixture=await fixtureFor(subject),out=join(output,subject,'republish',name,language);await mkdir(out,{recursive:true});
   try{
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
    await wait(pictureDrawn,subject+' picture drawn');
    await captureOn();await pointAt(160,120);await save('Before republish · 재게시 전 '+language);
    assert.equal((await draft())[0]!.value.comments.length,1);await shot(out,'1-pinned');
    const before=sealedPicture(subject,fixture.display.publication.source).sha256;
    const next=await fixture.republishPicture(pictureBytes(97));
    const after=sealedPicture(subject,next.publication.source).sha256;assert.notEqual(after,before,'new picture bytes');
    assert.notEqual(next.publication.source.sourceHash,fixture.display.publication.source.sourceHash);
    await page.goto('about:blank');await page.goto(url.href,language);
    const notice=catalog['The source changed, so {0} unsent comment(s) could not be carried over. Please add them again.']!.replace('{0}','1');
    await wait(`document.body.dataset.ready==='true'&&document.getElementById('dirty')?.textContent===${JSON.stringify(notice)}`,'carry-over notice');
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length`),0,'the old pin is not kept');
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('#reference-viewport .stage-comment-region').length`),0,'the old pin is not drawn');
    await shot(out,'2-notice');
    const result={case:'republish',subject,size:name,language,before,after,notice};cases.push(result);
    await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('1048_REPUBLISH_PASS '+subject+' '+name+' '+language);
   }catch(error){await shot(out,'failure').catch(()=>{});throw error;}finally{await page.goto('about:blank');await fixture.close();}
  }
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,errors,results:cases},null,2)+'\n');
 console.log('1048_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,errors,cases},null,2)+'\n');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
