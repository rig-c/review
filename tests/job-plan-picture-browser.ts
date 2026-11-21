/** #983 ordinary Nova: a record-plan publication that declares `planPicture` draws that sealed raster first,
 * ahead of an earlier picture publication; without it the earlier rig picture is unchanged.
 * Synthetic public fixtures only. Usage: bun tests/job-plan-picture-browser.ts --out <dir> */
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PNG} from 'pngjs';
import {recordScreenFixture} from './helpers/job-record-screen-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const arg=(key:string)=>{const at=Bun.argv.indexOf(key);return at<0?undefined:Bun.argv[at+1];};
const output=resolve(arg('--out')??'artifacts/983');await mkdir(output,{recursive:true});
const marker=[230,20,160] as const;
function pictureBytes():Buffer{
 const png=new PNG({width:64,height:48});
 for(let i=0;i<png.data.length;i+=4){png.data[i]=marker[0];png.data[i+1]=marker[1];png.data[i+2]=marker[2];png.data[i+3]=255;}
 return PNG.sync.write(png);
}
type Drawn={ready?:string;images:{src:string;width:number;height:number;pixel:number[]|null}[];message:string;rigCanvas:boolean};
const profile=await mkdtemp(join(tmpdir(),'review-983-browser-'));let page:InputCdpSession|undefined;
const errors:unknown[]=[],cases:unknown[]=[];
async function wait(expression:string,label:string){const until=Date.now()+30000;while(Date.now()<until){if(await page!.evaluate<boolean>(expression))return;await Bun.sleep(25);}throw new Error('983_WAIT '+label);}
const drawn=()=>page!.evaluate<Drawn>(`(()=>({ready:document.body.dataset.ready,message:document.getElementById('message')?.textContent??'',
 rigCanvas:!!document.querySelector('#rig-viewport canvas,#rig-root canvas'),
 images:[...document.querySelectorAll('#reference-content img')].map(img=>{let pixel=null;try{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
  const g=c.getContext('2d');g.drawImage(img,0,0);pixel=[...g.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data];}catch{}
  return {src:img.src.slice(0,5),width:img.naturalWidth,height:img.naturalHeight,pixel};})}))()`);
try{
 page=await launchCdpSession(profile,{sendDeadlineMs:20_000,onEvent:event=>{if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});
 await page.setViewport(1600,1000);
 for(const declared of [true,false])for(const language of ['en','ko'] as const){
  const catalog=language==='en'?enCatalog:koCatalog;
  const fixture=await recordScreenFixture('signoff',true,undefined,'plan-approved',false,true,undefined,false,false,undefined,undefined,declared?pictureBytes():undefined);
  const out=join(output,declared?'plan-picture':'no-plan-picture',language);await mkdir(out,{recursive:true});
  try{
   const source=fixture.display.publication.source as {planPicture?:{path:string;sha256:string}};
   assert.ok(fixture.backdrop,'an earlier picture publication precedes the record');
   assert.equal(!!source.planPicture,declared);
   const url=new URL(fixture.ownerUrl);url.searchParams.set('lang',language);await page.goto(url.href,language);
   await wait(`document.body.dataset.ready==='true'`,'workspace ready');
   if(declared)await wait(`!!document.querySelector('#reference-content img')?.naturalWidth`,'plan picture drawn');
   else await Bun.sleep(1500);
   const state=await drawn();
   await writeFile(join(out,'screen.png'),await page.screenshot());
   await writeFile(join(out,'observations.json'),JSON.stringify({declared,language,planPicture:source.planPicture??null,state},null,2)+'\n');
   if(declared){
    assert.equal(state.images.length,1,'exactly the plan picture is drawn');
    assert.deepEqual(state.images[0],{src:'blob:',width:64,height:48,pixel:[...marker,255]});
    assert.notEqual(state.message,catalog['This request has no picture.']);
   }else{
    assert.equal(state.images.some(image=>image.width===64&&image.height===48),false,'no plan picture without the declaration');
    assert.equal(state.rigCanvas,true,'the earlier rig picture is still the backdrop');
   }
   cases.push({declared,language,state});console.log('983_PLAN_PICTURE_PASS '+(declared?'declared':'absent')+' '+language);
  }finally{await page.goto('about:blank');await fixture.close();}
 }
 assert.equal(errors.length,0,JSON.stringify(errors));
 await writeFile(join(output,'result.json'),JSON.stringify({cases:cases.length,errors,results:cases},null,2)+'\n');
 console.log('983_BROWSER_PASS cases='+cases.length);
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,errors,cases},null,2)+'\n');throw error;}
finally{await page?.close();await rm(profile,{recursive:true,force:true});}
