/** #750/#986/#1230 browser checks for record option-set pictures, shared main viewport controls, communication panel resize and draft survival.
 * Form-specific cases (long interview pick scroll/focus, survey hitbox layout, empty-note form baseline and joined --picks-dir form drawer)
 * were removed (#1230 removes the answer form).
 * --serve starts a loopback fixture for interactive review without launching Chromium. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {PNG} from 'pngjs';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {expectRecordActSubmitted} from './helpers/record-act-browser-status.ts';
import {recordViewportControls} from './helpers/record-viewport-controls.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {jobInputHashes} from './helpers/job-api-fixture.ts';
import {optionSetsJobFixture,recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {SYNTHETIC_RIG_MODEL,SYNTHETIC_RIG_PAGE,SYNTHETIC_RIG_RGB} from './helpers/job-record-fixture.ts';
import {parseCommentOnlyAct} from '../src/job-api.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {partsDifferenceJobFixture,partsDifferenceOwnerUrl} from './helpers/parts-difference-job-fixture.ts';
import {JOB_COMMENTS_ACT_SCHEMA,JOB_COMMENT_ONLY_ACT_SCHEMA} from '../src/job-contract.ts';
import {jobWindowResources} from '../src/job-front.ts';

const arg=(name:string)=>{const i=Bun.argv.indexOf(name);return i<0?undefined:Bun.argv[i+1];};
const interviewOnly=Bun.argv.includes('--interview-only');
const completedPicture=Bun.argv.includes('--completed-picture')||Bun.argv.includes('--question-tab');
const freshParts=Bun.argv.includes('--fresh-parts');
const postQuestionPictures=Bun.argv.includes('--post-question-pictures');
const boundRigPictureOnly=Bun.argv.includes('--bound-rig-picture');
const workspace986=Bun.argv.includes('--workspace-986');
const sharedControls=['zoom-in','zoom-out','fit','native-one','view-menu'];
const controlSelector=sharedControls.map(id=>'#'+id).join(',');
const dialogViewer='canvas,video,.viewport,.interview-view,.interview-viewport,.view-zoom,.zoom-controls,'+controlSelector;
const paintingSelector='#reference-content img';
type Rect={x:number;y:number;width:number;height:number;left:number;top:number;right:number;bottom:number};

const outputArg=arg('--out');
const output=outputArg===undefined?await mkdtemp(join(tmpdir(),'review-750-evidence-')):resolve(outputArg);
if(outputArg!==undefined)await mkdir(output,{recursive:true});
if(!Bun.argv.includes('--serve'))console.log('750_BROWSER_ARTIFACTS '+output);
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function fixtureUrl(ownerUrl:string,language:string){
 const url=new URL(ownerUrl);
 url.searchParams.set('lang',language);
 return url.href;
}

if(Bun.argv.includes('--serve')&&['live','joined-plan-1004','pictureless'].includes(arg('--fixture')??'')){
 const language=arg('--lang')??'en';
 assert.ok(language==='en'||language==='ko','--lang must be en or ko');
 const kind=arg('--fixture')!;
 const painting=arg('--painting');
 assert.ok(painting===undefined||kind==='joined-plan-1004'&&isAbsolute(painting),'--painting takes an absolute PNG path with --fixture joined-plan-1004');
 const fixture=kind==='joined-plan-1004'?await optionSetsJobFixture({count:4,subjectless:true,...painting!==undefined?{painting:await readFile(painting)}:{}}):await recordScreenFixture('option-set',false,output,undefined,false,kind==='live');
 try{
  console.log(fixtureUrl(fixture.ownerUrl,language));
  await new Promise<void>(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
 }finally{await fixture.close();}
 process.exit(0);
}

const profile=await mkdtemp(join(tmpdir(),'review-750-browser-'));
let page:InputCdpSession|undefined,command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
let holdImages=false;const pausedImages:string[]=[];
const consoleErrors:unknown[]=[];
const exceptions:unknown[]=[],mutations:{method:string;path:string}[]=[],cases:unknown[]=[];
let persistedActs=0;
async function wait(expression:string,label:string){const until=Date.now()+20000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(30);}throw new Error('750_BROWSER_TIMEOUT '+label);}

async function waitForRecordComments(){
 await wait(`document.body?.dataset.ready==='true'&&!!document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])')&&!document.getElementById('send-comments')?.hidden&&document.querySelectorAll('form[data-job-ask]').length===0`,'record option-set ready with Comments');
}
async function addGeneralComment(text:string){
 await click(page!,'[data-comment-general]');
 await wait(`!!document.querySelector('.stage-comment-composer input')`,'general composer open');
 await page!.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);
 await wait(`!document.querySelector('.stage-comment-composer')`,'general composer saved');
}
async function assertNoDialogViewer(){
 const contents=await page!.evaluate<{id:string;open:boolean;modal:boolean;viewers:number}[]>(`[...document.querySelectorAll('dialog')].map(dialog=>({
  id:dialog.id,open:dialog.open,modal:dialog.matches(':modal'),viewers:dialog.querySelectorAll(${JSON.stringify(dialogViewer)}).length
 }))`);
 assert.ok(contents.every(dialog=>dialog.viewers===0),JSON.stringify(contents));
 return contents;
}
type Painting={src:string;width:number;height:number;visible:boolean;rect:Rect;scale:number;mode:string|null};
const paintingState=()=>page!.evaluate<Painting>(`(()=>{
 const image=document.querySelector('${paintingSelector}'),content=document.querySelector('#reference-content');
 return {src:image.currentSrc,width:image.naturalWidth,height:image.naturalHeight,
  visible:!!image.getClientRects().length&&getComputedStyle(image).visibility==='visible'&&!document.querySelector('#reference-pane').hidden,
  rect:image.getBoundingClientRect().toJSON(),scale:new DOMMatrix(getComputedStyle(content).transform).a,
  mode:document.querySelector('#view-menu [data-view][aria-pressed=true]')?.dataset.view??null};
})()`);
async function readPainting(width:number,index=0){
 await wait(`document.querySelector('${paintingSelector}')?.naturalWidth===${width}&&
  !!document.querySelector('#view-menu [data-view="interview-image-${index}"][aria-pressed=true]')&&
  document.querySelector('${paintingSelector}').getBoundingClientRect().width>0`,'986 shared image '+index);
 const state=await paintingState();
 assert.ok(state.visible&&state.rect.height>0&&state.scale>0,JSON.stringify(state));
 return state;
}
async function selectInterviewImage(index:number){
 await click(page!,'#view-menu summary');
 await click(page!,`#view-menu [data-view="interview-image-${index}"]`);
}
async function sharedCameraChecks(){
 assert.deepEqual(await page!.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(controlSelector)})].map(control=>control.id)`),sharedControls);
 await click(page!,'#fit');
 const initialFit=await paintingState();
 await click(page!,'#native-one');
 const native=await paintingState();assert.ok(Math.abs(native.scale-1)<0.001,JSON.stringify(native));
 await click(page!,'#zoom-in');
 const enlarged=await paintingState();assert.ok(enlarged.rect.width>native.rect.width,JSON.stringify(enlarged));
 await click(page!,'#zoom-out');
 const reduced=await paintingState();assert.ok(Math.abs(reduced.scale-native.scale)<0.001,JSON.stringify(reduced));
 await click(page!,'#fit');
 const fit=await paintingState();assert.ok(Math.abs(fit.scale-initialFit.scale)<0.001,JSON.stringify({initialFit,fit}));
 return {native,enlarged,reduced,fit};
}
async function questionViewportControls(){
 await page!.setViewport(1440,900);
 const width=480,swatch=new PNG({width,height:240});
 swatch.data.fill(0x90);
 const bytes=PNG.sync.write(swatch);
 for(const language of ['en','ko'] as const){
  const fixture=await recordScreenFixture('option-set',false,undefined,undefined,false,false);
  const open=async()=>page!.goto(fixtureUrl(fixture.ownerUrl,language));
  try{
   await open();
   await wait(`document.body?.dataset.ready==='true'&&document.querySelector('#rig-empty')?.checkVisibility()&&
    document.querySelector('#view-menu [data-view="compare"]')`,'1128 empty record mounted');
   await recordViewportControls(page!,command!,language,true);
   await fixture.republishOptionSet({questionImages:true,questionImage:bytes});
   await readPainting(width);
   await wait(`document.querySelector('#reference-empty').hidden`,'1128 image loaded');
   await recordViewportControls(page!,command!,language,false);
   await sharedCameraChecks();
   await page!.evaluate(`globalThis.questionImage=document.querySelector('${paintingSelector}');true`);
   await selectInterviewImage(0);
   await readPainting(width);
   assert.ok(await page!.evaluate(`document.querySelector('${paintingSelector}')!==globalThis.questionImage`),'View switch invokes the image handler');
   await fixture.republishOptionSet({questionImages:false});
   await wait(`!document.querySelector('${paintingSelector}')&&!document.querySelector('#view-menu [data-view="interview-image-0"]')`,'1128 question image released');
   await recordViewportControls(page!,command!,language,true);
   // Replay a pictured option-set publication when opening the page fresh.
   await page!.goto('about:blank');
   await fixture.republishOptionSet({questionImages:true,questionImage:bytes});
   await open();
   await readPainting(width);
   await wait(`document.querySelector('#reference-empty').hidden`,'1128 image loaded at open');
   await recordViewportControls(page!,command!,language,false);
   console.log('1128_QUESTION_PASS '+language);
  }finally{await page!.goto('about:blank');await fixture.close();}
 }
}
type RememberedPainting={state:Painting;personSelectSame:boolean;nodeSame:boolean};
async function rememberPainting(){
 await page!.evaluate<void>(`(()=>{globalThis.__986Painting=document.querySelector('${paintingSelector}');globalThis.__986PersonSelect=document.querySelector('#person-select');})()`);
 return paintingState();
}
async function assertPaintingPersists(previous:Painting){
 const state=await paintingState();
 const identity=await page!.evaluate<Omit<RememberedPainting,'state'>>(`({
  nodeSame:document.querySelector('${paintingSelector}')===globalThis.__986Painting,
  personSelectSame:document.querySelector('#person-select')===globalThis.__986PersonSelect
 })`);
 assert.deepEqual(identity,{nodeSame:true,personSelectSame:true});
 assert.ok(state.visible&&state.rect.width>0&&state.rect.height>0);
 assert.equal(state.src,previous.src);
 assert.equal(state.mode,previous.mode);
 return {...identity,state};
}

async function assertNoPictureRecordControls(reason:string,catalog:Record<string,string>){
 const state=await page!.evaluate<{
  commentsOpen:boolean;
  stageHasReason:boolean;
  controls:{id:string;kind:string;ownLabel:string;accessibleName:string;ariaDescription:string|null;title:string|null}[];
 }>(`(()=>{
  const panel=document.querySelector('#workspace-communication:not([hidden]) #inspector-feedback:not([hidden])');
  const panelRect=panel?.getBoundingClientRect();
  const empty=document.getElementById('rig-empty');
  const declaredLabels={
   'idle-blink-marker':${JSON.stringify(catalog['Blink time'])},
   'play':${JSON.stringify(catalog['Play'])},
   'report-previous':${JSON.stringify(catalog['Previous event page'])},
   'report-next':${JSON.stringify(catalog['Next event page'])},
  };
  const nodes=[...document.querySelectorAll('.inspector [role="tab"]:disabled,.inspector input[type="checkbox"]:disabled:not([aria-hidden="true"]),.workspace-secondary-toolbar input[type="checkbox"]:disabled,.inspector button:not([role="tab"]):disabled,.workspace-secondary-toolbar button:disabled')];
  const controls=nodes.map(control=>{
   const labelledBy=control.getAttribute('aria-labelledby');
   const byText=labelledBy?labelledBy.split(/\\s+/).map(id=>document.getElementById(id)?.textContent?.trim()??'').filter(Boolean).join(' '):'';
   const wrapping=control.closest('label'),explicit=control.id?document.querySelector('label[for="'+control.id+'"]'):null;
   const ownLabel=(declaredLabels[control.id]||byText||(control.tagName==='BUTTON'?(control.childElementCount?control.childNodes[0]?.textContent:control.textContent):(wrapping?(wrapping.querySelector('span')?.textContent??[...wrapping.childNodes].find(n=>n.nodeType===3&&n.nodeValue?.trim())?.nodeValue):explicit?.textContent))||'').trim();
   const accessibleName=(byText||control.getAttribute('aria-label')||control.textContent||control.getAttribute('title')||'').trim();
   const kind=control.getAttribute('role')==='tab'?'tab':control.tagName==='INPUT'?'checkbox':'button';
   return {id:control.id||control.tagName.toLowerCase(),kind,ownLabel,accessibleName,ariaDescription:control.getAttribute('aria-description'),title:control.getAttribute('title')};
  });
  return {
   commentsOpen:!!panel&&!!panelRect&&panelRect.width>0&&panelRect.height>0,
   stageHasReason:empty?.textContent===${JSON.stringify(reason)},
   controls,
  };
 })()`);
 assert.equal(state.commentsOpen,true,'#955/#1230 Comments panel is open on no-picture option-set page');
 assert.equal(state.stageHasReason,true,'#955 stage states the missing-picture absence sentence');
 assert.ok(state.controls.some(c=>c.kind==='tab')&&state.controls.some(c=>c.kind==='checkbox')&&state.controls.some(c=>c.kind==='button'),'#955 unavailable tabs, checkboxes, and buttons are present');
 for(const control of state.controls){
  assert.ok(control.ownLabel.length>0,`#955 ${control.kind}#${control.id} has its own visible label`);
  assert.equal(control.accessibleName,control.ownLabel,`#955 ${control.kind}#${control.id} accessible name is its own label`);
  assert.notEqual(control.accessibleName,reason,`#955 ${control.kind}#${control.id} accessible name is not the missing-picture reason`);
  assert.equal(control.ariaDescription,reason,`#955 ${control.kind}#${control.id} aria-description is the missing-picture reason`);
  assert.notEqual(control.title,reason,`#955 ${control.kind}#${control.id} title is not the missing-picture reason`);
 }
 const ax=await command!('Accessibility.getFullAXTree') as {nodes?:{ignored?:boolean;role?:{value?:string};name?:{value?:string};description?:{value?:string};properties?:{name:string;value?:{value?:unknown}}[]}[]};
 const axNodes=ax.nodes??[];
 assert.equal(axNodes.some(node=>['tab','checkbox','button'].includes(node.role?.value??'')&&node.name?.value===reason),false,'#955 no tab, checkbox, or button in AXTree uses the missing-picture reason as its accessible name');
 const axDisabled=axNodes.filter(node=>!node.ignored&&['tab','checkbox','button'].includes(node.role?.value??'')&&node.properties?.some(p=>p.name==='disabled'&&p.value?.value===true)&&node.description?.value===reason);
 assert.ok(axDisabled.length>=3,'#955 AXTree reports visible disabled controls with aria-description');
 for(const node of axDisabled){
  assert.ok((node.name?.value?.trim().length??0)>0,'#955 AXTree node has non-empty accessible name');
  assert.notEqual(node.name?.value,reason,'#955 AXTree accessible name is own label, not the missing-picture reason');
  assert.equal(node.description?.value,reason,'#955 AXTree description is the missing-picture reason');
 }
}

/** The footer caption names the camera mode the Camera sync checkbox shows, before and after a toggle. */
async function assertCameraCaptionFollowsSync(catalog:Record<string,string>) {
 const read = () => page!.evaluate<{checked:boolean;caption:string}>(`({
  checked:document.getElementById('camera-sync').checked,caption:document.getElementById('coordinates').textContent})`);
 const expected = (checked:boolean) => catalog[checked
  ? 'Cameras synchronized · drag to pan · scroll to zoom' : 'Independent cameras · drag to pan · scroll to zoom'];
 const initial = await read();
 assert.equal(initial.caption,expected(initial.checked),'#993 camera caption follows the camera-sync checkbox');
 await click(page!,'#camera-sync');
 await wait(`document.getElementById('camera-sync').checked===${!initial.checked}`,'#993 camera-sync toggled');
 const toggled = await read();
 assert.equal(toggled.caption,expected(toggled.checked),'#993 camera caption follows the camera-sync checkbox after a toggle');
 await click(page!,'#camera-sync');
 await wait(`document.getElementById('camera-sync').checked===${initial.checked}`,'#993 camera-sync restored');
 assert.equal((await read()).caption,expected(initial.checked),'#993 camera caption follows the camera-sync checkbox after restore');
}
async function assertOriginalPainting(base: string, expectedHash: string) {
 await wait(`(()=>{const image=document.querySelector('#reference-content img');
  return !!image?.naturalWidth && image.checkVisibility() && image.getBoundingClientRect().width>0;
 })()`,'955 original painting in the main view');
 const image = await page!.evaluate<{src:string;rgba:number[]}>(`(()=>{
  const image=document.querySelector('#reference-content img'),canvas=document.createElement('canvas');
  canvas.width=canvas.height=2;
  const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
  return {src:image.currentSrc,rgba:[...ctx.getImageData(0,0,1,1).data]};
 })()`);
 assert.deepEqual(image.rgba,[40,160,220,255]);
 assert.ok(new URL(image.src).pathname.startsWith(base+'interview/image/'));
 const response = await fetch(image.src);
 assert.equal(response.status,200);
 assert.equal(sha(new Uint8Array(await response.arrayBuffer())),expectedHash);
 return expectedHash;
}

async function postQuestionPictureChecks(){
 await page!.setViewport(1440,900);
 const observations:{variant:string;language:string;sha256?:string}[]=[];
 for(const variant of ['scene','unsealed-scene','rig','legacy'] as const){
  const fixture=await recordScreenFixture('option-set',false,undefined,undefined,false,true,undefined,false,false,variant);
  try{
   for(const language of ['en','ko'] as const){
    const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
    await page!.goto('about:blank');await page!.goto(url.href);
    await waitForRecordComments();
    assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    const observation:{variant:string;language:string;sha256?:string}={variant,language};
    if(variant==='scene'){
     await wait(`(()=>{
      const image=document.querySelector('#reference-content img'),rect=image?.getBoundingClientRect();
      return image?.naturalWidth===2&&rect.width>0&&rect.height>0&&getComputedStyle(image).visibility==='visible';
     })()`,'929 painted scene plate');
     const image=await page!.evaluate<{src:string;visible:boolean;background:number[]}>(`(()=>{
      const image=document.querySelector('#reference-content img'),canvas=document.createElement('canvas');
      canvas.width=canvas.height=2;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const rect=image.getBoundingClientRect();
      return {src:image.currentSrc,visible:rect.width>0&&rect.height>0&&getComputedStyle(image).visibility==='visible',
        background:[...ctx.getImageData(0,0,1,1).data]};
     })()`);
     assert.ok(image.visible);
     assert.deepEqual(image.background,[17,91,203,255]);
     assert.equal(await page!.evaluate<string>(`document.querySelector('#message').textContent`),language==='ko'?koCatalog['Not submitted']:enCatalog['Not submitted']);
     assert.ok(new URL(image.src).pathname.startsWith(fixture.display.routes.apiBase+'interview/image/'));
     const response=await fetch(image.src);
     assert.equal(response.status,200);
     observation.sha256=sha(new Uint8Array(await response.arrayBuffer()));
     assert.equal(observation.sha256,sha(await readFile(join(fixture.root,'evidence/plate.png'))));
     const painting=await rememberPainting();
     await click(page!,'#stage-comment');
     await assertPaintingPersists(painting);
    }else{
     const key=variant==='legacy'?'This request has no picture.':variant==='rig'?
      'This question refers to a rig version that this publication does not include.':
      'This question refers to a scene that this publication does not include.';
     const catalog=language==='en'?enCatalog:koCatalog;
     const text=await page!.evaluate<string>(`document.querySelector('#rig-empty').textContent`);
     assert.equal(text,catalog[key]);
     if(variant!=='legacy') observation.sha256=await assertOriginalPainting(
      fixture.display.routes.apiBase,sha(await readFile(join(fixture.root,'inputs/reference.png'))));
     await assertNoPictureRecordControls(catalog[key],catalog);
    }
    await writeFile(join(output,variant+'-'+language+'.png'),await page!.screenshot());
    observations.push(observation);
   }
  }catch(error){
   const state=await page!.evaluate<{url:string;ready?:string;text:string}>(`({url:location.pathname,ready:document.body?.dataset.ready,text:document.body?.innerText.slice(0,3000)})`);
   await writeFile(join(output,variant+'-failure.json'),JSON.stringify({...state,consoleErrors},null,2)+'\n');
   await writeFile(join(output,variant+'-failure.png'),await page!.screenshot());
   throw error;
  }finally{await page!.goto('about:blank');await fixture.close();}
 }
 assert.equal(exceptions.length,0);
 await writeFile(join(output,'post-question-pictures.json'),JSON.stringify(observations,null,2)+'\n');
 console.log('929_BROWSER_PASS '+JSON.stringify(observations));
}

async function boundRigPictureChecks(){
 const viewport = {width:1440,height:900};
 await page!.setViewport(viewport.width,viewport.height);
 const observations: Record<string,unknown>[] = [];
 const commentText = 'Keep the idle · 원문 유지';
 const values: string[] = [];
 for (const variant of ['bound-rig','rig-signoff-hash'] as const) for (const language of ['en','ko'] as const) {
  const out = join(output,'bound-rig-picture',variant,language);
  await mkdir(out,{recursive:true});
  const fixture = await recordScreenFixture('option-set',false,out,undefined,false,true,undefined,false,false,variant);
  const catalog = language === 'ko' ? koCatalog : enCatalog;
  try {
   const publication = fixture.display.publication;
   assert.equal(publication.previousPublicationId,null);
   const retained = fixture.session.retainedSourceV3(publication.publicationId);
   const before = await jobInputHashes(fixture.root), retainedBefore = await jobInputHashes(retained.snapshotRoot);
   const url = new URL(fixture.ownerUrl);
   url.searchParams.set('lang',language);
   const capturedActs: Buffer[] = [];
   const pageIds: string[] = [];
   for (const suppressed of variant === 'bound-rig' ? [false,true] : [false]) {
    const pictured = variant === 'bound-rig' && !suppressed;
    const visit = pictured ? 'with-rig' : 'without-rig';
    const attempt = capturedActs.length;
    const priorAcknowledgments = fixture.fake.acknowledgments.length;
    await page!.goto('about:blank');
    if (suppressed) fixture.suppressRigPicture();
    await page!.evaluate(`try{localStorage.clear();}catch{}`).catch(()=>{});
    await page!.goto(url.href);
    await waitForRecordComments();
    assert.ok((await assertNoDialogViewer()).every(dialog=>!dialog.open));
    await withDeadline('929 '+variant+' '+language+' '+visit+' receipt',20_000,async signal=>{
     while(fixture.fake.acknowledgments.length===priorAcknowledgments){
      signal.throwIfAborted();
      await Bun.sleep(25);
     }
    });
    assert.equal(await page!.evaluate<string>('document.documentElement.lang'),language);
    const ack = fixture.fake.acknowledgments.at(-1)?.body as {sourceHash?:string;pageId?:string;publicationId?:string} | undefined;
    assert.equal(ack?.sourceHash,publication.source.sourceHash);
    assert.equal(ack?.publicationId,publication.publicationId);
    assert.ok(ack?.pageId && !pageIds.includes(ack.pageId),'each visit has a new displayed receipt');
    pageIds.push(ack.pageId);
    assert.equal(fixture.submissions.length,attempt,'opening did not submit an act');

    let paintedPixels = 0;
    let missingPicture: string | null = null;
    let paintingSha256: string | undefined;
    if (pictured) {
     const actualRig = catalog['@rig-c/play · Actual rig'];
     await wait(`document.querySelector('#player-state')?.textContent===${JSON.stringify(actualRig)}&&
      document.querySelector('#animation-select')?.value==='idle'&&
      document.querySelector('#rig-empty')?.hidden===true`,
     '929 bound rig, idle and Comments');
     const stage = await page!.evaluate<{left:number;top:number;right:number;bottom:number}>(`document.getElementById('rig-viewport').getBoundingClientRect().toJSON()`);
     const screen = await page!.screenshot();
     await writeFile(join(out,'question-'+visit+'.png'),screen);
     const png = PNG.sync.read(Buffer.from(screen)), scale = png.width / viewport.width;
     for (let y=Math.max(0,Math.ceil(stage.top*scale)); y<Math.min(png.height,Math.floor(stage.bottom*scale)); y++) {
      for (let x=Math.max(0,Math.ceil(stage.left*scale)); x<Math.min(png.width,Math.floor(stage.right*scale)); x++) {
       const pixel = (y*png.width+x)*4;
       if (SYNTHETIC_RIG_RGB.every((value,channel) => Math.abs(png.data[pixel+channel]!-value)<=3)) paintedPixels++;
      }
     }
     assert.ok(paintedPixels>=16,'the visible rig viewport contains the sealed mesh page color');
    } else {
     missingPicture = await page!.evaluate<string>(`document.querySelector('#rig-empty').textContent`);
     assert.equal(missingPicture,catalog['This question refers to a rig version that this publication does not include.']);
     await assertNoPictureRecordControls(missingPicture,catalog);
     if (variant==='rig-signoff-hash') {
      paintingSha256=await assertOriginalPainting(
       fixture.display.routes.apiBase,sha(await readFile(join(fixture.root,'inputs/reference.png'))));
      await assertCameraCaptionFollowsSync(catalog);
     }
     await writeFile(join(out,'question-'+visit+'.png'),await page!.screenshot());
    }
    const assetRequests = await page!.evaluate<string[]>(`performance.getEntriesByType('resource')
     .map(entry=>new URL(entry.name).pathname).filter(path=>path.includes('/assets/'))`);
    const base = fixture.display.routes.assetsBase;
    assert.deepEqual([...new Set(assetRequests)].sort(),pictured ? [base+SYNTHETIC_RIG_MODEL,base+SYNTHETIC_RIG_PAGE].sort() : []);

    await page!.evaluate(`try{localStorage.clear();}catch{}`);
    await page!.goto('about:blank');
    await page!.goto(url.href);
    await waitForRecordComments();
    const currentAck = fixture.fake.acknowledgments.at(-1)?.body as {pageId:string};
    await addGeneralComment(commentText);

    const controls = await page!.evaluate<{
     inspection:{id:string;text:string;enabled:boolean}[];
     sendComments:{id:string;text:string;enabled:boolean};
     verdictEnabled:boolean;
     editEnabled:boolean;
     edits:{id:string;text:string;enabled:boolean}[];
    }>(`(()=>{
     const enabled=node=>!!node&&node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible'&&
      !node.matches(':disabled,[aria-disabled="true"]')&&!node.closest('[inert]');
     const control=(node,id=node.id)=>({id,text:node.textContent.trim()||node.getAttribute('aria-label')||'',enabled:enabled(node)});
     const inspection=[...document.querySelectorAll('#zoom-in,#zoom-out,#fit,#native-one,#view-menu')].map(node=>
      control(node.id==='view-menu'?node.querySelector('summary'):node,node.id));
     const edits=[...document.querySelectorAll('#mesh-edit,#mesh-apply,#chest-edit,#bust-apply,[data-animation-apply]')]
      .map(node=>control(node,node.id||'data-animation-apply'));
     return {
      inspection,sendComments:control(document.getElementById('send-comments')),
      verdictEnabled:[...document.querySelectorAll('#save,#request-changes,#review-status')].some(enabled),
      editEnabled:edits.some(control=>control.enabled),edits,
     };
    })()`);
    assert.deepEqual(controls.inspection.map(control=>control.id),['zoom-in','zoom-out','fit','native-one','view-menu']);
    assert.ok(controls.inspection.every(control=>control.text.length>0));
    assert.equal(controls.sendComments.text,catalog['Send comments']);
    assert.equal(controls.sendComments.enabled,true);
    assert.equal(controls.verdictEnabled,false);
    assert.equal(controls.editEnabled,false,JSON.stringify(controls.edits));
    await click(page!,'#send-comments');
    await expectRecordActSubmitted(page!,wait,language,`${variant} ${visit} ${language} comments submitted`);
    assert.equal(fixture.submissions.length,attempt+1);
    assert.equal(fixture.files.length,attempt+1);
    const submission = fixture.submissions[attempt]!;
    if (submission.kind !== 'comments') throw new Error('Expected a comments submission');
    assert.equal(submission.pageId,currentAck.pageId);
    assert.equal(submission.publicationId,publication.publicationId);
    assert.equal(submission.displayedNonce,`nonce-${publication.publicationId}-${currentAck.pageId}`);
    const actPath = fixture.files[attempt]!;
    assert.equal(actPath,fixture.files[0],'the fixture writer uses the same act path on both visits');
    const bytes = await readFile(actPath), act = parseCommentOnlyAct(JSON.parse(bytes.toString('utf8')));
    capturedActs.push(bytes);
    await writeFile(join(out,'act-'+visit+'.json'),bytes);
    assert.equal(act.schema,JOB_COMMENT_ONLY_ACT_SCHEMA);
    assert.equal(act.kind,'comments');
    assert.deepEqual(act.source,publication.source);
    assert.deepEqual(act.value,{comments:[{text:commentText}]});
    values.push(JSON.stringify(act.value));
    assert.deepEqual(await jobInputHashes(fixture.root),before);
    assert.deepEqual(await jobInputHashes(retained.snapshotRoot),retainedBefore);
    observations.push({variant,language,visit,suppressed,paintedPixels,paintingSha256,missingPicture,assetRequests,controls,sourceHash:publication.source.sourceHash,
     actBytes:bytes.length,actSha256:sha(bytes),actValueSha256:sha(JSON.stringify(act.value))});
   }
  } finally {
   await page!.goto('about:blank');
   await fixture.close();
  }
 }
 assert.equal(new Set(values).size,1,'pictured and signoff-mismatch acts carry identical comment bytes in EN and KO');
 assert.deepEqual(exceptions,[]);
 const result = {observations};
 await writeFile(join(output,'bound-rig-picture.json'),JSON.stringify(result,null,2)+'\n');
 console.log('929_BOUND_RIG_BROWSER_PASS '+JSON.stringify(result));
}

async function resizeQuestionPanel(){
 const selector='.workspace-communicationWidth[role=separator]';
 const range=()=>page!.evaluate<{value:number;min:number;max:number}>(`(()=>{
  const handle=document.querySelector('${selector}');
  return {value:Number(handle.getAttribute('aria-valuenow')),min:Number(handle.getAttribute('aria-valuemin')),max:Number(handle.getAttribute('aria-valuemax'))};
 })()`);
 await click(page!,selector);
 const before=await range();
 assert.ok(before.max>before.min,'communication separator offers a resize range');
 const key=before.value<before.max?'End':'Home',keyCode=key==='End'?35:36;
 await command!('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:keyCode});
 await command!('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:keyCode});
 const after=await range();
 assert.ok(key==='End'?after.value>before.value:after.value<before.value,JSON.stringify({before,after}));
 return {before,after};
}

async function liveQuestionDraftChecks(){
 const sizes=interviewOnly?[[1600,1000],[1440,900]] as const:[[1600,1000]] as const;
 for(const [width,height] of sizes){
  await page!.setViewport(width,height);
  for(const language of ['en','ko'] as const){
   const fixture=await recordScreenFixture('option-set',false,undefined,undefined,freshParts);
   const before=await jobInputHashes(fixture.root);
   try{
    const catalog=language==='en'?enCatalog:koCatalog,out=join(output,`${width}x${height}`,'option-set','empty',language);
    await mkdir(out,{recursive:true});fixture.output(out);
    const url=fixtureUrl(fixture.ownerUrl,language);
    await page!.goto('about:blank');
    holdImages=!freshParts;
    if(holdImages)await command!('Page.navigate',{url});
    else await page!.goto(url);
    await waitForRecordComments();
    const dialogs=await assertNoDialogViewer();assert.ok(dialogs.every(dialog=>!dialog.open));
    const screen=await page!.evaluate<{language:string;width:number;height:number;legacySeen:boolean;legacyForms:number;topbars:number;viewports:number;noPicture:string;emptyListText:string;saveState:string;controls:string[]}>(`({
     language:document.documentElement.lang,width:innerWidth,height:innerHeight,legacySeen:globalThis.__record750legacySeen,
     legacyForms:document.querySelectorAll('[data-job-forms]').length,topbars:document.querySelectorAll('.topbar').length,
     viewports:document.querySelectorAll('#rig-viewport').length,noPicture:document.getElementById('rig-empty').textContent,
     emptyListText:document.querySelector('[data-part-list]')?.textContent??'',saveState:document.getElementById('dirty').textContent,
     controls:[...document.querySelectorAll(${JSON.stringify(controlSelector)})].map(node=>node.id)
    })`);
    assert.equal(screen.language,language);assert.equal(screen.width,width);assert.equal(screen.height,height);
    assert.equal(screen.legacySeen,false);assert.equal(screen.legacyForms,0);assert.equal(screen.topbars,1);assert.equal(screen.viewports,1);
    assert.deepEqual(screen.controls,sharedControls);
    const observation:Record<string,unknown>={language,width,height,screen,dialogs,sourceHash:fixture.display.publication.source.sourceHash,
     readerPhases:fixture.reader.calls.map(call=>call.phase),fixture:'synthetic trusted-host record reader and deterministic act writer'};
    if(freshParts){
     await wait(`document.getElementById('renderer-state')?.textContent===${JSON.stringify(catalog['Parts raster drawn · Canvas2D'])}`,'bound parts raster drawn');
     assert.notEqual(screen.noPicture,catalog['This request has no picture.']);assert.equal(fixture.display.publication.previousPublicationId,null);
     await wait(`document.querySelectorAll('[data-part-list] button').length>0`,'fresh parts list');
    }else{
     assert.equal(screen.emptyListText,'');assert.equal(screen.saveState,catalog['Not submitted']);
     // Hold the image request while the Comments panel is already available.
     await withDeadline('986 held painting request',5_000,async signal=>{
      while(!pausedImages.length){signal.throwIfAborted();await Bun.sleep(25);}
     });
     await waitForRecordComments();
     const stageRect=()=>page!.evaluate<Rect>(`document.querySelector('#stage-layout').getBoundingClientRect().toJSON()`);
     const loading=await stageRect();
     assert.ok(loading.width>0&&loading.height>0,'the shared stage has space while the painting request is held');
     assert.equal(await page!.evaluate<number>(`document.querySelector('${paintingSelector}')?.naturalWidth??0`),0);
     await writeFile(join(out,'option-loading.png'),await page!.screenshot());
     holdImages=false;
     for(const requestId of pausedImages.splice(0))await command!('Fetch.continueRequest',{requestId});
     const loadedPainting=await readPainting(2);
     const loaded=await stageRect();
     assert.deepEqual(loaded,loading,'painting load preserves the shared stage geometry');
     observation.imageLoading={loading,loaded,loadedPainting};
     const imageCount=fixture.session.retainedSourceV3(fixture.display.publication.publicationId).questions[0]!.images.length;
     assert.ok(imageCount>0);
     assert.equal(await page!.evaluate<number>(`document.querySelectorAll('#view-menu [data-view^=interview-image-]').length`),imageCount);
     for(let index=0;index<imageCount;index++){
      await selectInterviewImage(index);
      const painting=await readPainting(2,index);
      assert.ok(new URL(painting.src).pathname.startsWith(fixture.display.routes.apiBase+'interview/image/'));
      const pixel=await page!.evaluate<number[]>(`(()=>{
       const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
       context.drawImage(document.querySelector('${paintingSelector}'),0,0);
       return [...context.getImageData(0,0,1,1).data];
      })()`);
      assert.deepEqual(pixel,[40,160,220,255]);
      await writeFile(join(out,'option-image-'+index+'.png'),await page!.screenshot());
     }
     observation.optionImagesShown=imageCount;
     observation.resized=await resizeQuestionPanel();
    }
    const commentWords=`Option-set draft · ${language}`;
    await addGeneralComment(commentWords);
    await page!.goto('about:blank');await page!.goto(url);await waitForRecordComments();
    await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1`,'comment draft survives reload');
    const painting=freshParts?null:await (async()=>{await readPainting(2);return rememberPainting();})();
    await click(page!,'#send-comments');
    await expectRecordActSubmitted(page!,wait,language,'option-set comment submitted');
    if(painting){
     observation.savedPainting=await assertPaintingPersists(painting);
     await click(page!,'#stage-comment');
     await wait(`!!document.querySelector('#reference-viewport.stage-comment-mode')&&!document.querySelector('#rig-viewport.stage-comment-mode')`,'sealed question image takes pin mode (#1048)');
     await click(page!,'#stage-comment');
     await wait(`!document.querySelector('#reference-viewport.stage-comment-mode')`,'pin mode closes again');
    }
    const path=join(out,'one-screen.json');assert.ok(existsSync(path));
    const bytes=await readFile(path,'utf8'),act=parseCommentOnlyAct(JSON.parse(bytes));
    assert.equal(act.schema,JOB_COMMENT_ONLY_ACT_SCHEMA);
    assert.equal(act.kind,'comments');
    assert.deepEqual(act.value,{comments:[{text:commentWords}]});
    observation.persistedAct={bytes:Buffer.byteLength(bytes),oneScreenSha256:sha(bytes),oneScreenFile:path};
    await writeFile(join(out,'one-screen-submitted.png'),await page!.screenshot());
    await writeFile(join(out,'observations.json'),JSON.stringify(observation,null,2)+'\n');cases.push(observation);persistedActs++;
    console.log('750_BROWSER_CASE_PASS '+language+' '+width+'x'+height+' bytes='+Buffer.byteLength(bytes));
    assert.deepEqual(await jobInputHashes(fixture.root),before,'inspected source files remain immutable');
   }finally{holdImages=false;for(const requestId of pausedImages.splice(0))await command!('Fetch.continueRequest',{requestId});await page!.goto('about:blank');await fixture.close();}
  }
 }
}

async function draftSurvivalChecks(){
 holdImages=false;
 const out=join(output,'draft-survival');await mkdir(out,{recursive:true});
 const lookRoot=outputArg===undefined?resolve('evidence/look'):null;
 for(const lang of ['en','ko'] as const){
  await mkdir(join(out,'look',lang),{recursive:true});
  if(lookRoot)await mkdir(join(lookRoot,lang),{recursive:true});
 }
 const saveLook=async(lang:'en'|'ko',name:string)=>{
  const png=await page!.screenshot();
  await writeFile(join(out,'look',lang,name),png);
  if(lookRoot)await writeFile(join(lookRoot,lang,name),png);
 };
 // #1229: converted from waiting on the removed checkpoint Pass/Fail form to waiting on the no-ask plan record ready state (#send-comments).
 const fixture=await recordScreenFixture('checkpoint',false,out,undefined,false,true,undefined,false,true);
 try{
  fixture.fake.publish(fixture.display);
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang','en');
  await page!.setViewport(1440,900);
  await page!.goto('about:blank');await page!.goto(url.href);
  const planReady=`document.body.dataset.ready==='true'&&!!document.querySelector('#stage-comment-list')&&!!document.getElementById('send-comments')&&!document.getElementById('send-comments').hidden`;
  await wait(planReady,'992 initial load');
  const addGeneral=async(text:string,frameId?:string)=>{
   const root=frameId?`document.getElementById(${JSON.stringify(frameId)}).contentDocument`:'document';
   await page!.evaluate<void>(`${root}.querySelector('[data-comment-general]').click()`);
   await wait(`!!${root}.querySelector('.stage-comment-composer input')`,'992 composer open');
   await page!.evaluate<void>(`(()=>{const f=${root}.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(text)};f.requestSubmit();})()`);
   await wait(`!${root}.querySelector('.stage-comment-composer')`,'992 composer saved');
  };
  const readRows=(frameId?:string)=>page!.evaluate<string[]>(`(()=>{const root=${frameId?`document.getElementById(${JSON.stringify(frameId)}).contentDocument`:'document'};return [...root.querySelectorAll('#stage-comment-list .stage-comment-summary')].map(n=>n.textContent);})()`);
  // Bar 1: Reload
  await addGeneral('c1 · reload survival');
  assert.equal((await readRows()).length,1);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&(${planReady})`,'992 bar 1 reload');
  assert.equal((await readRows())[0]?.endsWith('c1 · reload survival'),true);
  // Bar 2: Republish, same job, draft and source hash
  await page!.evaluate<void>(`document.body.dataset.ready='republishing-bar2'`);
  const pub2=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'992-republish-same',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'992-republish-same',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'992-hold-2',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
  const display2=fixture.session.displayPublication(pub2.publicationId);
  fixture.fake.publish(display2);
  await wait(planReady,'992 bar 2 republish');
  assert.equal((await readRows())[0]?.endsWith('c1 · reload survival'),true);
  // Bar 4: Two tabs
  await page!.evaluate<void>(`(()=>{
   const [key,raw]=Object.entries(localStorage).find(([k])=>k.startsWith('rig-review-record-comments/1:'));
   const saved=JSON.parse(raw);
   const next=JSON.stringify({...saved,comments:[...saved.comments,{id:'c2-id',summary:'c2 · from tab B'}]});
   localStorage.setItem(key,next);
   window.dispatchEvent(new StorageEvent('storage',{key,newValue:next}));
   window.dispatchEvent(new StorageEvent('storage',{key,newValue:raw}));
  })()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===2`,'992 bar 4 storage event pickup');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c1 · reload survival','c2 · from tab B']);
  await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
  await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'992 bar 4 delete button');
  await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1`,'992 bar 4 delete synced');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c2 · from tab B']);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&(${planReady})`,'992 bar 4 reload after delete');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c2 · from tab B']);
  // Bar 3: Republish with a changed source hash
  const updatedEvidence=await readFile(join(fixture.root,'plan/context-evidence.json'),'utf8')+'\n';
  await writeFile(join(fixture.root,'plan/context-evidence.json'),updatedEvidence);
  const updatedEvidenceHash=sha(updatedEvidence);
  const planContext=fixture.workspace.context as unknown as {files:{path:string;sha256:string}[]};
  planContext.files=planContext.files.map(f=>f.path==='plan/context-evidence.json'?{...f,sha256:updatedEvidenceHash}:f);
  await page!.evaluate<void>(`document.body.dataset.ready='republishing-bar3'`);
  const pub3=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'992-republish-changed',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'992-republish-changed',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'992-hold-3',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
  assert.notEqual(pub3.source.sourceHash,pub2.source.sourceHash);
  const display3=fixture.session.displayPublication(pub3.publicationId);
  fixture.fake.publish(display3);
  await wait(planReady,'992 bar 3 changed source');
  await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const carryKey='The source changed, so {0} unsent comment(s) could not be carried over. Please add them again.';
  const expectedCarryEn=enCatalog[carryKey]!.replace('{0}','1');
  const expectedCarryKo=koCatalog[carryKey]!.replace('{0}','1');
  const bar3State=await page!.evaluate<{currentCount:number;oldRetained:boolean;draftState:string;dirty:string}>(`({
   currentCount:document.querySelectorAll('#stage-comment-list .stage-comment-item').length,
   oldRetained:Object.entries(localStorage).some(([k,v])=>k.startsWith('rig-review-record-comments/1:')&&v.includes('c2 · from tab B')),
   draftState:document.getElementById('review-draft-state')?.textContent??'',
   dirty:document.getElementById('dirty')?.textContent??'',
  })`);
  assert.equal(bar3State.currentCount,0);
  assert.equal(bar3State.oldRetained,true);
  assert.equal(bar3State.draftState,expectedCarryEn);
  assert.equal(bar3State.dirty,expectedCarryEn);
  await saveLook('en','changed-source.png');
  const koUrl=new URL(fixture.ownerUrl);koUrl.searchParams.set('lang','ko');
  await page!.goto('about:blank');await page!.goto(koUrl.href);
  await wait(planReady,'992 bar 3 changed source ko');
  await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const bar3Ko=await page!.evaluate<{draftState:string;dirty:string}>(`({
   draftState:document.getElementById('review-draft-state')?.textContent??'',
   dirty:document.getElementById('dirty')?.textContent??'',
  })`);
  assert.equal(bar3Ko.draftState,expectedCarryKo);
  assert.equal(bar3Ko.dirty,expectedCarryKo);
  await saveLook('ko','changed-source.png');
  // Bar 5: Existing per-publication drafts still restore (fallback)
  await page!.evaluate<void>(`(()=>{
   localStorage.clear();
   localStorage.setItem(${JSON.stringify(`rig-review-record-comments/1:${pub3.publicationId}:${pub3.source.sourceHash}`)},JSON.stringify({
    status:'pending',publicationId:${JSON.stringify(pub3.publicationId)},sourceHash:${JSON.stringify(pub3.source.sourceHash)},
    comments:[{id:'legacy-c1',summary:'c3 · legacy fallback'}],
   }));
  })()`);
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1&&(${planReady})`,'992 bar 5 fallback');
  assert.deepEqual((await readRows()).map(s=>s.split(' · ').slice(2).join(' · ')),['c3 · legacy fallback']);
  await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
  await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'992 bar 5 legacy delete button');
  await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
  await wait(`document.querySelectorAll('#stage-comment-list .stage-comment-item').length===0`,'992 bar 5 legacy deleted');
  await page!.goto('about:blank');await page!.goto(url.href);
  await wait(planReady,'992 bar 5 reload after legacy delete');
  assert.deepEqual(await readRows(),[]);

  // #999 Bar: box-pin comment on parts-verdict draft page
  const parts999:Record<string,unknown>={};
  for(const lang of ['en','ko'] as const){
   const pf=await partsDifferenceJobFixture({scratchParent:out});
   try{
    const ask=await pf.ask(pf.publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
    const pUrl=partsDifferenceOwnerUrl(pf,lang);
    await page!.setViewport(1440,900);
    await page!.goto('about:blank');await page!.goto(pUrl);
    await wait(`document.body?.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'`,'999 parts ready '+lang);
    const drawEdgeBox=async(text:string)=>{
     if(await page!.evaluate<boolean>(`!document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`))await click(page!,'#stage-comment');
     await wait(`document.querySelector('#rig-viewport').classList.contains('stage-comment-mode')`,'999 comment mode '+lang);
     const [from,to]=await page!.evaluate<[{x:number;y:number},{x:number;y:number}]>(`(()=>{
      const canvas=document.getElementById('parts-canvas'),rect=canvas.getBoundingClientRect();
      return [[1.5,1.5],[10.5,9.5]].map(([x,y])=>({x:rect.left+x*rect.width/canvas.width,y:rect.top+y*rect.height/canvas.height}));
     })()`);
     await page!.mouse('mouseMoved',from.x,from.y);
     await page!.mouse('mousePressed',from.x,from.y);
     await page!.mouse('mouseMoved',to.x,to.y);
     await page!.mouse('mouseReleased',to.x,to.y);
     await wait(`!!document.querySelector('.stage-comment-composer input')`,'999 composer open '+lang);
     await page!.evaluate<void>(`(()=>{
      const f=document.querySelector('.stage-comment-composer');
      const input=f.querySelector('input');
      input.value=${JSON.stringify(text)};
      input.dispatchEvent(new Event('input',{bubbles:true}));
     })()`);
    };
    const words=lang==='ko'?'검 손잡이가 손 뒤로 가야 함':'Sword grip must go behind the hand';
    await drawEdgeBox(words);
    await click(page!,'.stage-comment-parts [data-comment-part="body"]');
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer').requestSubmit()`);
    const expectedRefusal=(lang==='ko'?koCatalog:enCatalog)['Select at least one part.']!;
    await wait(`document.querySelector('#workspace-act-row:not([hidden]) #review-message.error')?.textContent===${JSON.stringify(expectedRefusal)}`,'999 refusal in act row '+lang);
    const footer = await page!.evaluate<{text:string;title:string}>(`(() => {
      const status = document.getElementById('message');
      return {text:status.textContent,title:status.title};
    })()`);
    assert.ok(![footer.text,footer.title].some(value=>value.includes(expectedRefusal)), 'refusal stays out of the footer');
    await click(page!,'.stage-comment-parts [data-comment-part="body"]');
    assert.equal(await page!.evaluate<boolean>(`document.activeElement===document.querySelector('.stage-comment-composer input')`),true,'chip click restores focus to composer input');
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-pin').length===1`,'999 box-pin saved '+lang);
    await page!.goto('about:blank');await page!.goto(pUrl);
    await wait(`document.body?.dataset.ready==='true'&&document.querySelector('#parts-canvas')?.width>0&&document.querySelector('#stage-layout')?.getAttribute('aria-busy')==='false'&&document.querySelectorAll('.stage-comment-pin').length===1`,'999 box-pin survives reload '+lang);
    assert.equal(await page!.evaluate<boolean>(`[...document.querySelectorAll('#stage-comment-list .stage-comment-summary')].some(n=>n.textContent.includes(${JSON.stringify(words)}))`),true);
    if(await page!.evaluate<boolean>(`document.querySelector('#stage-comment')?.getAttribute('aria-pressed')!=='true'`))await click(page!,'#stage-comment');
    await wait(`document.querySelector('#stage-comment-list .stage-comment-summary')?.checkVisibility()===true`,'999 comments panel visible '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'box-pin-edge.png');
    await page!.evaluate<void>(`document.querySelector('#stage-comment-list .stage-comment-summary').click()`);
    await wait(`!!document.querySelector('.stage-comment-composer .stage-comment-delete')`,'999 delete button '+lang);
    await page!.evaluate<void>(`document.querySelector('.stage-comment-composer .stage-comment-delete').click()`);
    await wait(`document.querySelectorAll('.stage-comment-pin').length===0&&document.querySelector('#request-changes')?.disabled===true`,'999 cleared before open-composer submit '+lang);
    await drawEdgeBox(words);
    await wait(`document.querySelector('#request-changes')?.checkVisibility()&&!document.querySelector('#request-changes').disabled`,'999 request changes enabled with open composer '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'request-changes-open-composer.png');
    await click(page!,'#request-changes');
    let submittedAct:any=null;
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline){
     const ev=(await pf.next()).events.find(e=>e.type==='act'&&e.act.askId===ask.askId);
     if(ev?.type==='act'){submittedAct=ev.act;break;}
     await Bun.sleep(50);
    }
    assert.ok(submittedAct,'999 finalized parts-verdict act '+lang);
    await wait(`!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-pin').length===1&&document.querySelectorAll('#stage-comment-list .stage-comment-item').length===1`,'999 open composer committed and act sent '+lang);
    await wait(`document.querySelector('#stage-comment-list .stage-comment-summary')?.checkVisibility()===true`,'999 committed comment visible '+lang);
    await page!.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    await saveLook(lang,'request-changes-open-composer-after.png');
    assert.equal(submittedAct.schema,JOB_COMMENTS_ACT_SCHEMA);
    assert.equal(submittedAct.kind,'parts-verdict');
    assert.equal(submittedAct.value.verdict,'changes-requested');
    assert.equal(submittedAct.value.comments.length,1);
    assert.equal(submittedAct.value.comments[0].text,words);
    assert.deepEqual(submittedAct.value.comments[0].anchor.parts.map((p:any)=>p.name),['body']);
    assert.deepEqual(submittedAct.value.comments[0].anchor.rigRegion,{x:4,y:4,width:7,height:6});
    parts999[lang]={actId:submittedAct.actId,verdict:submittedAct.value.verdict,text:submittedAct.value.comments[0].text,rigRegion:submittedAct.value.comments[0].anchor.rigRegion,refusal:expectedRefusal};
   }finally{await pf.close();}
  }
  await writeFile(join(out,'draft-survival.json'),JSON.stringify({bar3State,bar3Ko,parts999},null,2)+'\n');
  console.log('992_DRAFT_SURVIVAL_PASS '+JSON.stringify({bar3State,bar3Ko,parts999}));
 }finally{await fixture.close();}
}

/** The waiting layout can dock the inspector before the first option-set publication binds Comments in the right communication panel. */
async function firstQuestionInDrawer(){
 holdImages=false;
 for(const language of ['en','ko'] as const){
  const out=join(output,'first-question-drawer',language);
  await mkdir(out,{recursive:true});
  const fixture=await recordScreenFixture('option-set',false,out,undefined,false,true,undefined,false,true,'bound-rig');
  const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);
  const body='#workspace-drawer-inspectorHeight > .inspector-body';
  const errorsBefore=consoleErrors.length;
  try{
   await page!.setViewport(1000,320);
   await page!.goto('about:blank');await page!.goto(url.href);
   await wait(`!!document.querySelector('${body}')&&document.querySelector('#workspace-ask-headline')?.checkVisibility()`,'941 waiting inspector docked');
   const before:{inRoot:boolean;drawerBodies:number;height:number}=await page!.evaluate(`({
    inRoot:!!document.querySelector('#app .inspector-body'),drawerBodies:document.querySelectorAll('${body}').length,height:innerHeight
   })`);
   assert.deepEqual(before,{inRoot:false,drawerBodies:1,height:320});
   await writeFile(join(out,'before-delivery.json'),JSON.stringify(before));
   fixture.deliver();
   const generalButton='#workspace-communication #inspector-feedback [data-comment-general]';
   await withDeadline('941 first publication or refusal',20_000,async signal=>{
    while(!signal.aborted){
     if(consoleErrors.length>errorsBefore||await page!.evaluate<boolean>(`!!document.querySelector('${generalButton}')`))return;
     await Bun.sleep(30);
    }
    throw signal.reason;
   });
   const after:{language:string;generalVisible:boolean;drawerOpen:boolean}=await page!.evaluate(`({
    language:document.documentElement.lang,
    generalVisible:!!document.querySelector('${generalButton}')?.checkVisibility(),
    drawerOpen:!!document.querySelector('#workspace-communication')?.checkVisibility()
   })`);
   const errors=consoleErrors.slice(errorsBefore);
   await writeFile(join(out,'after-delivery.json'),JSON.stringify({after,errors},null,2));
   await writeFile(join(out,'first-load.png'),await page!.screenshot());
   console.log('941_FIRST_QUESTION '+JSON.stringify({language,before,after,errors}));
   assert.equal(errors.length,0,JSON.stringify(errors));
   assert.equal(after.language,language);assert.equal(after.drawerOpen,true);
   assert.equal(after.generalVisible,true,'first option-set publication shows Comments in the communication panel');
  }finally{await fixture.close();}
 }
}

if(Bun.argv.includes('--serve')){
 const fixtureArg=arg('--fixture');
 const serveScratch=await mkdtemp(join(tmpdir(),'review-750-serve-'));
 const closers:(()=>Promise<void>)[]=[];
 try{
  if(!fixtureArg||fixtureArg==='draft-survival-changed-source'){
   const baseResources=jobWindowResources();
   let seedScript='';
   const resources:ReturnType<typeof jobWindowResources>=async name=>{
    const res=await baseResources(name);
    if(name==='main.js'&&seedScript)return seedScript+'\n'+await new Response(res).text();
    return res;
   };
   const fixture=await recordScreenFixture('checkpoint',false,serveScratch,'plan-approved',false,true,resources,false,true);
   closers.push(()=>fixture.close());
   const priorPub=fixture.display.publication;
   const seedKey=`rig-review-record-comments/1:${fixture.session.jobId}:plan:${priorPub.source.sourceHash}`;
   const seedVal=JSON.stringify({status:'pending',publicationId:priorPub.publicationId,sourceHash:priorPub.source.sourceHash,comments:[{id:'seed-c1',summary:'c1 · unsent comment before source hash change'}]});
   seedScript=`try{if(!localStorage.getItem(${JSON.stringify(seedKey)}))localStorage.setItem(${JSON.stringify(seedKey)},${JSON.stringify(seedVal)});}catch{}`;
   const updatedEvidence=await readFile(join(fixture.root,'plan/context-evidence.json'),'utf8')+'\n';
   await writeFile(join(fixture.root,'plan/context-evidence.json'),updatedEvidence);
   const updatedEvidenceHash=sha(updatedEvidence);
   const planContext=fixture.workspace.context as unknown as {files:{path:string;sha256:string}[]};
   planContext.files=planContext.files.map(f=>f.path==='plan/context-evidence.json'?{...f,sha256:updatedEvidenceHash}:f);
   const pub2=await fixture.session.execute({schema:'rig-review/job-api@3',jobId:fixture.session.jobId,requestId:'serve-republish-changed',verb:'publish',expectedGeneration:fixture.session.status().generation,idempotencyKey:'serve-republish-changed',result:fixture.workspace.result,freeze:{kind:'producer-held',holdId:'serve-hold-2',record:fixture.workspace.record}},new AbortController().signal) as {publicationId:string;generation:number;source:typeof fixture.display.publication.source};
   const display2=fixture.session.displayPublication(pub2.publicationId);
   fixture.fake.publish(display2);
   for(const lang of ['ko','en'] as const){
    const u=new URL(fixture.ownerUrl);u.searchParams.set('lang',lang);
    console.log(JSON.stringify({fixture:'draft-survival-changed-source',lang,url:u.href,pid:process.pid,priorSourceHash:priorPub.source.sourceHash,currentSourceHash:pub2.source.sourceHash,clicks:['1. Open URL to view the Comments panel and footer #review-draft-state / #dirty.']}));
   }
  }
  if(!fixtureArg||fixtureArg==='parts-box-pin'){
   const pf=await partsDifferenceJobFixture({scratchParent:serveScratch});
   closers.push(()=>pf.close());
   await pf.ask(pf.publication,{kind:'parts-verdict',draftId:'synthetic-parts'});
   for(const lang of ['ko','en'] as const){
    console.log(JSON.stringify({fixture:'parts-box-pin',lang,url:partsDifferenceOwnerUrl(pf,lang),pid:process.pid,sourceHash:pf.publication.source.sourceHash,clicks:['1. Click + Comment (#stage-comment) and drag a box across the part edge.', '2. Type comment text in the open composer (Request changes / 수정 요청 enables immediately).', '3. Press Enter to save the clamped box pin, or click Request changes (#request-changes) directly while the composer is open.']}));
   }
  }
  await new Promise<void>(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }finally{
  for(const close of closers)await close();
  await rm(serveScratch,{recursive:true,force:true});
  await rm(profile,{recursive:true,force:true});
 }
 process.exit(0);
}

try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:(event,send)=>{command=send;if(event.method==='Fetch.requestPaused'){const id=event.params!.requestId as string;if(holdImages)pausedImages.push(id);else void send('Fetch.continueRequest',{requestId:id});}if(event.method==='Runtime.consoleAPICalled'&&event.params?.type==='error')consoleErrors.push(event.params);if(event.method==='Runtime.exceptionThrown')exceptions.push(event.params);if(event.method==='Network.requestWillBeSent'){const request=event.params?.request as {method:string;url:string}|undefined;if(request&&request.method!=='GET')mutations.push({method:request.method,path:new URL(request.url).pathname});}}});
 await command!('Fetch.enable',{patterns:[{urlPattern:'*/api/interview/image/*'}]});
 await command!('Runtime.enable');await command!('Network.enable');await command!('Network.setCacheDisabled',{cacheDisabled:true});await command!('Page.addScriptToEvaluateOnNewDocument',{source:`globalThis.__record750legacySeen=false;new MutationObserver(()=>{if(document.body?.classList.contains('job-window')||document.querySelector('[data-job-forms]'))globalThis.__record750legacySeen=true;}).observe(document,{subtree:true,childList:true,attributes:true});`});
 if(Bun.argv.includes('--viewport-controls'))await questionViewportControls();
 else if(Bun.argv.includes('--draft-survival'))await draftSurvivalChecks();
 else if(Bun.argv.includes('--first-question-drawer'))await firstQuestionInDrawer();
 else if(boundRigPictureOnly)await boundRigPictureChecks();
 else if(postQuestionPictures)await postQuestionPictureChecks();
 else{
 await questionViewportControls();
 await firstQuestionInDrawer();
 if(!completedPicture||workspace986)await liveQuestionDraftChecks();
 if(!interviewOnly&&!freshParts&&!completedPicture){
  await postQuestionPictureChecks();
  await boundRigPictureChecks();
 }
 assert.equal(exceptions.length,0,'no browser exceptions');
 assert.ok(mutations.every(request=>/\/ui\/(?:displayed|acts)$/.test(request.path)),'no backdrop mutation requests');
 const result={cases:cases.length,persistedActs,persistedByteComparisons:persistedActs,languages:['en','ko'],workspace986,exceptions,mutations,browserWorkers:'shared launchCdpSession defaults'};
 await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log('750_BROWSER_PASS '+JSON.stringify(result));
 }
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),exceptions,mutations,completedCases:cases},null,2)+'\n');if(page)await writeFile(join(output,'failure.png'),await page.screenshot()).catch(()=>{});throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
