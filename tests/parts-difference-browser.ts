/** Trusted-input #384 evidence through the existing launcher. CI guards live in parts-comparison.test.ts. */
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {writeDifferencePackage} from './helpers/parts-difference-package.ts';
import {loadPartsView,readVerdict} from '../src/parts-view.ts';
import {resolvedCropPath} from '../src/comment-crops.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {launchCdpSession,type InputCdpSession as Page} from './parts-explorer-browser.ts';
import {paintingRectangle} from '../src/parts-comparison.ts';
import {koCatalog} from '../web/catalog-ko.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw new Error(m);},hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function wait(page:Page,condition:string,label:string){for(let i=0;i<200;i++){if(await page.evaluate(condition))return;await Bun.sleep(25);}throw new Error('BROWSER_WAIT '+label+' '+await page.evaluate(`document.getElementById('pv-save-status')?.textContent`));}
async function rect(page:Page,selector:string){return page.evaluate<{x:number;y:number;width:number;height:number}>(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n?.getBoundingClientRect();if(!r||r.width<=0||r.height<=0)throw Error('Hidden target '+${JSON.stringify(selector)});return {x:r.x,y:r.y,width:r.width,height:r.height};})()`);}
async function click(page:Page,selector:string){const r=await rect(page,selector),x=r.x+r.width/2,y=r.y+r.height/2;await page.mouse('mouseMoved',x,y);await page.mouse('mousePressed',x,y);await page.mouse('mouseReleased',x,y);}
const view=`(()=>{const root=document.getElementById('rig-root'),pane=document.getElementById('rig-viewport'),r=root.getBoundingClientRect(),p=pane.getBoundingClientRect();const scale=new DOMMatrix(root.style.transform).a,ref=document.getElementById('reference-content'),rp=document.getElementById('reference-viewport'),rs=new DOMMatrix(ref.style.transform).a;return {logical:{zoom:scale,x:(pane.clientWidth/2-parseFloat(root.style.left))/scale,y:(pane.clientHeight/2-parseFloat(root.style.top))/scale,reference:{zoom:rs,x:(rp.clientWidth/2-parseFloat(ref.style.left))/rs,y:(rp.clientHeight/2-parseFloat(ref.style.top))/rs}},left:r.left,top:r.top,scale,pane:{left:p.left,top:p.top,width:p.width,height:p.height},style:{left:root.style.left,top:root.style.top,transform:root.style.transform,reference:document.getElementById('reference-content').getAttribute('style')}};})()`;
function sameCamera(a:any,b:any){return ['zoom','x','y'].every(k=>Math.abs(a[k]-b[k])<1e-9)&&['zoom','x','y'].every(k=>Math.abs(a.reference[k]-b.reference[k])<1e-9);}
const pixels=(id:string)=>`document.getElementById(${JSON.stringify(id)}).toDataURL('image/png')`;
async function settled(page:Page){await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await Bun.sleep(30);}
async function opacity(page:Page,value:number){const r=await rect(page,'#pv-opacity'),x=r.x+8+(r.width-16)*value,y=r.y+r.height/2;await page.mouse('mouseMoved',x,y);await page.mouse('mousePressed',x,y);await page.mouse('mouseReleased',x,y);await settled(page);return page.evaluate<number>(`Number(document.getElementById('pv-opacity').value)`);}
async function mark(page:Page,summary:string){const traceStart=await page.evaluate<number>('window.__inputs.length'),v=await page.evaluate<any>(view),a={x:v.left+3.2*v.scale,y:v.top+3.2*v.scale},b={x:v.left+16.6*v.scale,y:v.top+12.4*v.scale};await page.mouse('mouseMoved',a.x,a.y);await page.mouse('mousePressed',a.x,a.y);await page.mouse('mouseMoved',b.x,b.y);await page.mouse('mouseReleased',b.x,b.y);await wait(page,`!!document.querySelector('.stage-comment-composer input')`,'composer');await page.evaluate(`(()=>{const f=document.querySelector('.stage-comment-composer');f.querySelector('input').value=${JSON.stringify(summary)};f.requestSubmit();})()`);await wait(page,`!document.querySelector('.stage-comment-composer')`,'comment accepted');const delivered=await page.evaluate<any[]>(`window.__inputs.slice(${traceStart}).filter(e=>e.type==='pointerdown'||e.type==='pointerup')`);assert(delivered.length===2&&delivered.every(e=>e.trusted),'actual trusted drag delivery');return {a,b,delivered};}
const invalidThresholdMessage='PARTS_COMPARISON_INVALID: enter an integer threshold from 0 to 255. Last valid value restored.';
async function invalidThresholds(page:Page,lang:string,out:string){
 const before=await page.evaluate<string>(pixels('pv-canvas')),rows=[];
 for(const value of ['', '1.5', '256']){
  await page.evaluate(`(()=>{const input=document.getElementById('pv-threshold');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await settled(page);
  const actual=await page.evaluate<{value:string;message:string}>(`({value:document.getElementById('pv-threshold').value,message:document.getElementById('pv-save-status').textContent})`);
  rows.push({entered:value,...actual});
  if(actual.value!=='16'||actual.message!==(lang==='ko'?koCatalog[invalidThresholdMessage]:invalidThresholdMessage)){await writeFile(join(out,'invalid-'+lang+'.png'),await page.screenshot());throw new Error('INVALID_THRESHOLD_NOT_RESTORED '+JSON.stringify(rows));}
  assert(await page.evaluate(pixels('pv-canvas'))===before,'invalid value cannot change metric behind restored valid display');
 }
 await writeFile(join(out,'invalid-'+lang+'.png'),await page.screenshot());
 await page.evaluate(`(()=>{const input=document.getElementById('pv-threshold');input.value='16';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await settled(page);
 assert(await page.evaluate(`document.getElementById('pv-save-status').textContent`)==='','valid input clears refusal');return rows;
}
async function main(){
 const out=resolve(process.env.RIG_REVIEW_DIFFERENCE_EVIDENCE??'cache/parts-difference-browser');await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'difference-'));process.env.RIG_REVIEW_STATE_DIR=join(out,'state');
 let page:Page|null=null;let server:Awaited<ReturnType<typeof startPartsServer>>|null=null;const report:Record<string,any>={};
 try{
 await writeDifferencePackage(root,true);const pkg=await loadPartsView(root),before=await Promise.all(pkg.files.map(async f=>({path:f.abs,sha256:hash(await readFile(f.abs))})));server=await startPartsServer(pkg,{port:0,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});page=await launchCdpSession(join(root,'profile'));await page.setViewport(1440,1000);const base=`http://127.0.0.1:${server.port}/`;
 const navigate=async(lang:string)=>{await page!.goto(base+'?lang='+lang);await wait(page!,`document.body.dataset.ready==='true'`,'ready');await settled(page!);};
 await navigate('en');report.browser=await page.evaluate('navigator.userAgent');report.browserVersion=await page.evaluate(`navigator.userAgentData.getHighEntropyValues(['fullVersionList','uaFullVersion'])`);
 await page.evaluate(`(()=>{window.__inputs=[];for(const n of ['pointerdown','pointerup','input','click'])document.addEventListener(n,e=>window.__inputs.push({type:n,target:e.target.id||e.target.dataset.pvComparison,x:e.clientX,y:e.clientY,trusted:e.isTrusted}),true);})()`);
 await click(page,'#native-one');for(let i=0;i<7;i++)await click(page,'#zoom-in');await settled(page);
 await click(page,'[data-pv-comparison="difference"]');await wait(page,`document.getElementById('pv-caption').textContent.includes('81')`,'covered off81');
 await click(page,'#pv-footprints');await wait(page,`document.getElementById('pv-caption').textContent.startsWith('Difference: 1 pixels')`,'covered on1');
 const rawPixel=await page.evaluate<number[]>(`Array.from(document.getElementById('pv-canvas').getContext('2d').getImageData(2,2,1,1).data)`);assert(JSON.stringify(rawPixel)==='[17,0,0,255]','literal planted cell');
 const grey=await page.evaluate<number[]>(`Array.from(document.getElementById('pv-canvas').getContext('2d').getImageData(10,4,1,1).data)`);assert(JSON.stringify(grey)==='[128,128,128,255]','literal covered cell');
 await page.evaluate(`(()=>{const input=document.getElementById('pv-threshold');input.value='17';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(page,`document.getElementById('pv-caption').textContent.includes('0 pixels')`,'strict boundary0');
 await page.evaluate(`(()=>{const input=document.getElementById('pv-threshold');input.value='16';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(page,`document.getElementById('pv-caption').textContent.startsWith('Difference: 1 pixels')`,'strict boundary1');
 report.invalidEn=await invalidThresholds(page,'en',out);
 const displayed=await page.evaluate<string>(pixels('pv-canvas'));await writeFile(join(out,'difference-en.png'),await page.screenshot());
 await click(page,'#stage-comment');report.mark=await mark(page,'Declared grid difference');await click(page,'#pv-save');await wait(page,`document.getElementById('pv-save-status').dataset.result==='saved'`,'save');
 const saved=(await readVerdict(pkg)).verdict!,comment=saved.issues[0]!;assert(comment.view.comparison?.mode==='difference'&&comment.view.comparison.threshold===16&&comment.view.footprints,'saved comparison and footprints');
 if(!comment.imageRegion)throw new Error('Expected item region');
 const original=PNG.sync.read(await readFile(pkg.imagePaths[0]!)),native=PNG.sync.read(await readFile(resolvedCropPath(comment.nativeCrop!.path))),r=comment.imageRegion;
 for(let y=0;y<r.height;y++)assert(native.data.subarray(y*r.width*4,(y+1)*r.width*4).equals(original.data.subarray(((r.y+y)*20+r.x)*4,((r.y+y)*20+r.x+r.width)*4)),'native original RGBA');
 const crop=PNG.sync.read(await readFile(resolvedCropPath(comment.crop.path))),centre=[...crop.data.subarray((Math.floor(crop.height/2)*crop.width+Math.floor(crop.width/2))*4,(Math.floor(crop.height/2)*crop.width+Math.floor(crop.width/2))*4+4)];
 const oracle=await page.evaluate<number[]>(`(()=>{const [down,up]=${JSON.stringify(report.mark.delivered)},pane=document.getElementById('rig-viewport').getBoundingClientRect(),canvas=document.getElementById('pv-canvas'),box=canvas.getBoundingClientRect(),sx=new DOMMatrix(document.getElementById('rig-root').style.transform).a;const rawLeft=Math.max(0,Math.floor(Math.min(down.x,up.x)-pane.left-24)),rawTop=Math.max(0,Math.floor(Math.min(down.y,up.y)-pane.top-24)),left=Math.ceil(pane.left+rawLeft)-pane.left,top=Math.ceil(pane.top+rawTop)-pane.top,x=Math.floor((pane.left+left+${Math.floor(crop.width/2)}+.5-box.left)/sx),y=Math.floor((pane.top+top+${Math.floor(crop.height/2)}+.5-box.top)/sx);return Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data);})()`);
 assert(JSON.stringify(centre)===JSON.stringify(oracle),'viewport crop actual displayed comparison');report.cropCentre=centre;report.view=comment.view;
 for(const kind of ['crop','nativeCrop'] as const)await writeFile(join(out,kind+'.png'),await readFile(resolvedCropPath(comment[kind]!.path)));
 for(const format of ['json','issue']){const response=await fetch(base+'api/parts/export?format='+format),text=await response.text();assert(response.ok&&text.includes('difference')&&text.includes('16')&&text.includes(comment.crop.sha256),'export comparison state');await writeFile(join(out,'export.'+(format==='json'?'json':'md')),text);}
 for(const lang of ['en','ko']){
 await navigate(lang);await click(page,'#stage-comment');await wait(page,`document.querySelectorAll('.stage-comment-item').length===1`,'reload');await click(page,'.stage-comment-summary');await wait(page,`document.querySelector('[data-pv-comparison="difference"]').getAttribute('aria-pressed')==='true'`,'restore');await settled(page);
 assert(await page.evaluate(pixels('pv-canvas'))===displayed,'restored comparison pixels '+lang);assert(await page.evaluate(`document.getElementById('pv-threshold').value`)==='16','threshold restored');
 if(lang==='ko')assert(await page.evaluate(`document.querySelector('[data-pv-comparison="difference"]').textContent`)===koCatalog.Difference,'Korean Difference label');await click(page,'#stage-comment');await writeFile(join(out,'restored-'+lang+'.png'),await page.screenshot());report['invalid'+lang]=await invalidThresholds(page,lang,out);
 }
 assert((await Promise.all(before.map(async f=>hash(await readFile(f.path))===f.sha256))).every(Boolean),'inspected sources immutable');report.status='passed';report.thresholdInput='DOM input events; comparison/footprint/capture/save are trusted CDP mouse';await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log('PARTS_DIFFERENCE_BROWSER '+JSON.stringify(report));
 }catch(error){if(page)await writeFile(join(out,'failure.png'),await page.screenshot());await writeFile(join(out,'failure.json'),JSON.stringify({error:String(error),report},null,2));throw error;}
 finally{await page?.close();server?.stop(true);await rm(root,{recursive:true,force:true});}
}
if(import.meta.main)await main();
