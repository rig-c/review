/** #1048 PR1 ordinary Nova: a record plan's declared `planPicture` takes pointed and region comments through the
 * existing stage-comments pin layer. They save, survive reload, stay on the same picture pixel after zoom and fit, and
 * submit with the A1 label (sealed path and sha256, integer natural pixels). Republishing new picture bytes drops the
 * unsent pin with the existing carry-over notice. Synthetic public fixtures only.
 * Usage: bun tests/job-plan-picture-comments-browser.ts --out <dir> [--lang en|ko] [--size 1440x900|1280x720]
 *        bun tests/job-plan-picture-comments-browser.ts --serve [--lang en|ko] [--republish] */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {feedbackItemComments,projectComments} from '../src/stage-comment.ts';
import {parseRecordAct} from '../src/job-api.ts';
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
const fixtureFor=()=>recordScreenFixture('signoff',true,undefined,'plan-approved',false,true,undefined,false,false,undefined,pictureBytes());

if(Bun.argv.includes('--serve')){
 const fixture=await fixtureFor(),url=new URL(fixture.ownerUrl);url.searchParams.set('lang',arg('--lang')??'en');
 if(Bun.argv.includes('--republish'))console.log(JSON.stringify({note:'leave a pin, then press Enter here to republish new picture bytes and reload'}));
 console.log(JSON.stringify({url:url.href,pid:process.pid,planPicture:(fixture.display.publication.source as {planPicture?:unknown}).planPicture,fixture:'synthetic trusted record host; plan picture'}));
 if(Bun.argv.includes('--republish')){for await(const _line of console){const next=await fixture.republishPlanPicture(pictureBytes(97));console.log(JSON.stringify({republished:next.publication.publicationId,planPicture:(next.publication.source as {planPicture?:unknown}).planPicture}));break;}}
 await new Promise<void>(done=>{process.once('SIGTERM',done);process.once('SIGINT',done);});await fixture.close();process.exit(0);
}

const output=resolve(arg('--out')??'artifacts/1048');await mkdir(output,{recursive:true});
const languages=(arg('--lang')?[arg('--lang')]:['en','ko']) as ('en'|'ko')[];
const sizes=(arg('--size')?[arg('--size')!]:['1440x900','1280x720']).map(size=>size.split('x').map(Number) as [number,number]);
const profile=await mkdtemp(join(tmpdir(),'review-1048-browser-'));let page:InputCdpSession|undefined;
const errors:unknown[]=[],cases:unknown[]=[];
async function wait(expression:string,label:string){const until=Date.now()+30000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('1048_WAIT '+label);}
async function shot(out:string,name:string){await writeFile(join(out,name+'.png'),await page!.screenshot());}
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
 await wait(`!!document.querySelector('#reference-viewport.stage-comment-mode')`,'pin mode on the plan picture');}
async function pointAt(x:number,y:number){const g=await geometry(),p=at(g,x,y);await page!.mouse('mouseMoved',p.x,p.y);await page!.mouse('mousePressed',p.x,p.y);await page!.mouse('mouseReleased',p.x,p.y);}
async function dragFrom(a:[number,number],b:[number,number]){const g=await geometry(),p=at(g,...a),q=at(g,...b);
 await page!.mouse('mouseMoved',p.x,p.y);await page!.mouse('mousePressed',p.x,p.y);await page!.mouse('mouseMoved',(p.x+q.x)/2,(p.y+q.y)/2);await page!.mouse('mouseMoved',q.x,q.y);await page!.mouse('mouseReleased',q.x,q.y);}
type Row={id:string;summary:string;target:unknown;context:{comment:{viewport:string;referenceId:string;referenceHash:string;world:{x:number;y:number;width:number;height:number};camera:{space:string}}}};
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
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:event=>{if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});
 for(const [width,height] of sizes)for(const language of languages){
  const catalog=language==='en'?enCatalog:koCatalog,name=`${width}x${height}`;
  await page.setViewport(width,height);
  // Case 1: point and region, reload, zoom, fit, submit.
  {const fixture=await fixtureFor(),out=join(output,'pins',name,language);await mkdir(out,{recursive:true});fixture.output(out);
   const picture=(fixture.display.publication.source as {planPicture?:{path:string;sha256:string}}).planPicture!;
   const selector=`form[data-job-ask="${fixture.ask.askId}"]`;
   try{
    assert.ok(picture,'the publication declares its plan picture');
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
    await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#reference-content img')?.naturalWidth`,'plan picture drawn');
    await captureOn();await shot(out,'1-pin-mode');
    await pointAt(80,60);await save('Point · 점 '+language);
    await captureOn();await dragFrom([200,150],[280,210]);await save('Region · 영역 '+language);
    await shot(out,'2-saved');
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
    await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#reference-content img')?.naturalWidth&&document.querySelectorAll('#stage-comment-list .stage-comment-item').length===2`,'reload restores both pins');
    const reloaded=await assertPinsOnPicture(rows,'after reload');await shot(out,'3-reloaded');
    await click(page,'#zoom-in');await click(page,'#zoom-in');
    await wait(`(()=>{const img=document.querySelector('#reference-content img');return img.getBoundingClientRect().width/img.naturalWidth>${reloaded.scale*1.05};})()`,'zoomed');
    const zoomed=await assertPinsOnPicture(rows,'after zoom');await shot(out,'4-zoomed');
    await click(page,'#fit');await Bun.sleep(300);
    const fitted=await assertPinsOnPicture(rows,'after fit');await shot(out,'5-fit');
    // Submit the plan sign-off: the signed words carry the A1 labels.
    const expected=projectComments(rows.map(row=>feedbackItemComments([row as never])[0]!),[picture]);
    const labels=rows.map(row=>{const w=row.context.comment.world;return JSON.stringify(['rig-review-comment/1','setup','reference',picture.path,picture.sha256,Math.round(w.x),Math.round(w.y),Math.round(w.width),Math.round(w.height)]);});
    assert.equal(expected,`[${labels[0]}]\n${rows[0]!.summary}\n\n[${labels[1]}]\n${rows[1]!.summary}`,'A1 label');
    await click(page,'#workspace-pending-ask');await wait(`!!document.querySelector('#workspace-communication:not([hidden]) #job-record-asks:not([hidden])')`,'record section');
    await shot(out,'6-before-submit');await click(page,selector+' button[type=submit]');
    await wait(`(()=>{const s=document.getElementById('dirty');return s?.textContent===${JSON.stringify(language==='en'?'Answer saved':catalog['Answer saved'])}&&s.dataset.saveState==='saved';})()&&
     !document.querySelector('#job-record-asks:not([hidden])')`,'signoff saved');
    const act=parseRecordAct(JSON.parse(await readFile(join(out,'one-screen.json'),'utf8')));
    assert.equal(act.kind,'signoff');assert.equal(act.source.sourceHash,fixture.display.publication.source.sourceHash);
    assert.equal((act.value as {words:string}).words,expected,'the act words carry the picture labels');
    await shot(out,'7-submitted');
    const result={case:'pins',size:name,language,picture,rows:rows.map(row=>({summary:row.summary,world:row.context.comment.world})),labels,words:expected,
     scales:{fresh:fresh.scale,reloaded:reloaded.scale,zoomed:zoomed.scale,fitted:fitted.scale}};
    cases.push(result);await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('1048_PINS_PASS '+name+' '+language);
   }catch(error){await shot(out,'failure').catch(()=>{});throw error;}finally{await page.goto('about:blank');await fixture.close();}
  }
  // Case 2 (B2): republish with new picture bytes; the unsent pin is reported by the carry-over notice, not kept.
  {const fixture=await fixtureFor(),out=join(output,'republish',name,language);await mkdir(out,{recursive:true});
   try{
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
    await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#reference-content img')?.naturalWidth`,'plan picture drawn');
    await captureOn();await pointAt(160,120);await save('Before republish · 재게시 전 '+language);
    assert.equal((await draft())[0]!.value.comments.length,1);await shot(out,'1-pinned');
    const before=(fixture.display.publication.source as {planPicture:{sha256:string}}).planPicture.sha256;
    const next=await fixture.republishPlanPicture(pictureBytes(97));
    const after=(next.publication.source as {planPicture:{sha256:string}}).planPicture.sha256;assert.notEqual(after,before,'new picture bytes');
    assert.notEqual(next.publication.source.sourceHash,fixture.display.publication.source.sourceHash);
    await page.goto('about:blank');await page.goto(url.href,language);
    const notice=catalog['The source changed, so {0} unsent comment(s) could not be carried over. Please add them again.']!.replace('{0}','1');
    await wait(`document.body.dataset.ready==='true'&&document.getElementById('dirty')?.textContent===${JSON.stringify(notice)}`,'carry-over notice');
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length`),0,'the old pin is not kept');
    assert.equal(await page.evaluate<number>(`document.querySelectorAll('#reference-viewport .stage-comment-region').length`),0,'the old pin is not drawn');
    await shot(out,'2-notice');
    const result={case:'republish',size:name,language,before,after,notice};cases.push(result);
    await writeFile(join(out,'observations.json'),JSON.stringify(result,null,2)+'\n');console.log('1048_REPUBLISH_PASS '+name+' '+language);
   }catch(error){await shot(out,'failure').catch(()=>{});throw error;}finally{await page.goto('about:blank');await fixture.close();}
  }
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,errors,results:cases},null,2)+'\n');
 console.log('1048_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,errors,cases},null,2)+'\n');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
