/** Real canonical-pair assembly flow; CI guards are parts-assembly.test.ts. */
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {writeComparisonPackage} from './helpers/parts-comparison-package.ts';
import {loadPartsView,readVerdict} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {launchCdpSession,type InputCdpSession as Page} from './parts-explorer-browser.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m);};
async function wait(p:Page,c:string){for(let i=0;i<200;i++){if(await p.evaluate(c))return;await Bun.sleep(25);}throw Error('WAIT '+c);}
async function settle(p:Page){await p.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await Bun.sleep(60);}
async function click(p:Page,s:string){const r=await p.evaluate<any>(`(()=>{const r=document.querySelector(${JSON.stringify(s)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await p.mouse('mouseMoved',r.x,r.y);await p.mouse('mousePressed',r.x,r.y);await p.mouse('mouseReleased',r.x,r.y);await settle(p);}
const camera=`['rig-root','reference-content'].map(id=>{const n=document.getElementById(id),z=new DOMMatrix(n.style.transform).a,p=n.parentElement;return {z,x:(p.clientWidth/2-parseFloat(n.style.left))/z,y:(p.clientHeight/2-parseFloat(n.style.top))/z};})`;
const pixels=`document.getElementById('pv-canvas').toDataURL()`;
async function point(p:Page,x:number,y:number,drag=false){const r=await p.evaluate<any>(`(()=>{const r=document.getElementById('pv-canvas').getBoundingClientRect(),z=new DOMMatrix(document.getElementById('rig-root').style.transform).a;return {x:r.x+${x}*z,y:r.y+${y}*z};})()`);await p.mouse('mouseMoved',r.x,r.y);await p.mouse('mousePressed',r.x,r.y);if(drag)await p.mouse('mouseMoved',r.x+20,r.y+10);await p.mouse('mouseReleased',r.x+(drag?20:0),r.y+(drag?10:0));await settle(p);}
async function main(){
 const out=resolve(process.env.RIG_REVIEW_ASSEMBLY_EVIDENCE??'assembly-evidence');await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'assembly-browser-'));process.env.RIG_REVIEW_STATE_DIR=join(root,'state');let page:Page|null=null;const servers:Awaited<ReturnType<typeof startPartsServer>>[]=[];const report:any={state:'static parts; no playback or animation clock'};
 try{
 const f=await writeComparisonPackage(root),doc=JSON.parse(await readFile(join(root,'parts.json'),'utf8'));for(const b of doc.parts){b.x+=.125;b.y+=.375;}await writeFile(join(root,'parts.json'),JSON.stringify(doc));
 // A transparent hole in the front exposes an opaque back pixel; alpha 1 is separately exercised by bun tests.
 for(let y=2;y<6;y++)for(let x=2;x<6;x++)f.cover.data[(y*8+x)*4+3]=0;await writeFile(join(root,'parts/front.png'),PNG.sync.write(f.cover));
 const pkg=await loadPartsView(root,{painting:join(root,'painting.png')}),before=await Promise.all(pkg.files.map(async f=>createHash('sha256').update(await readFile(f.abs)).digest('hex'))),cap='a'.repeat(64),server=await startPartsServer(pkg,{port:0,capability:cap,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});servers.push(server);page=await launchCdpSession(join(root,'profile'));await page.setViewport(1440,1000);const base=`http://127.0.0.1:${server.port}/`;
 for(const lang of ['en','ko']){
 await page.goto(`${base}?lang=${lang}#cap=${cap}`);await wait(page,`document.body.dataset.ready==='true'&&document.getElementById('pv-canvas').width===20`);await click(page,'#pv-assemble');await wait(page,`document.getElementById('pv-canvas').width===32`);
 assert(await page.evaluate(`document.querySelectorAll('#rig-viewport').length===1&&document.querySelectorAll('#reference-viewport').length===1`),'canonical pair');
 const base1=await page.evaluate(pixels);await settle(page);assert(base1===await page.evaluate(pixels),'base vs base before pixel metric');
 // Browser oracle decodes the public files independently, with literal known placements and order.
 const oracle=await page.evaluate<string>(`(async()=>{const c=document.createElement('canvas');c.width=32;c.height=24;const ctx=c.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.fillStyle='#00ff00';ctx.fillRect(0,0,32,24);for(const [i,x,y] of [[0,4.125,4.375],[1,14.125,8.375]]){const img=new Image();img.src='/api/parts/image/'+i;await img.decode();ctx.drawImage(img,x,y);}return c.toDataURL();})()`);assert(base1===oracle,'independent browser pixel oracle');
 await click(page,'#fit');for(let i=0;i<3;i++)await click(page,'#zoom-out');
 await writeFile(join(out,'assembled-ab-'+lang+'.png'),await page.screenshot());
 await point(page,15,9);assert(await page.evaluate(`document.querySelector('[data-pv-item="front"]').getAttribute('aria-current')==='true'`),'frontmost opaque tap');
 await point(page,17,12);assert(await page.evaluate(`document.querySelector('[data-pv-item="body"]').getAttribute('aria-current')==='true'`),'transparent hole selects back');
 assert(await page.evaluate(`document.querySelector('[data-assembly-outline="body"]')?.getContext('2d').getImageData(0,0,32,24).data.some((v,i)=>i%4===3&&v>0)`),'outline has pixels');
 const beforePan=await page.evaluate(camera);await point(page,15,9,true);assert(await page.evaluate(`document.querySelector('[data-pv-item="body"]').getAttribute('aria-current')==='true'`),'pan never selects');assert(JSON.stringify(beforePan)!==JSON.stringify(await page.evaluate(camera)),'shared drag pans');
 await click(page,'[data-pv-visible="front"]');await point(page,15,9);assert(await page.evaluate(`document.querySelector('[data-pv-item="body"]').getAttribute('aria-current')==='true'`),'hidden front excluded');await click(page,'[data-pv-visible="front"]');
 await click(page,'#pv-save');
 await wait(page,`document.getElementById('pv-save-status').dataset.result==='saved'`);
 const verdict=(await readVerdict(pkg)).verdict!;
 assert(verdict.schema==='rig-review-parts-verdict/4'&&verdict.status==='approved'&&verdict.issues.length===0,'zero-issue verdict/4 invariant');
 const cam=await page.evaluate(camera);await click(page,'[data-pv-comparison="overlay"]');assert(JSON.stringify(cam)===JSON.stringify(await page.evaluate(camera)),'comparison preserves camera');await writeFile(join(out,'assembled-overlay-'+lang+'.png'),await page.screenshot());
 await click(page,'[data-pv-comparison="part"]');await click(page,'#pv-alpha');const alpha=await page.evaluate(pixels);assert(alpha!==base1,'alpha changes assembly');await click(page,'#pv-alpha');
 await click(page,'#pv-bg');await page.evaluate(`(()=>{const s=document.getElementById('pv-bg');s.value='magenta';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await settle(page);assert(await page.evaluate(`Array.from(document.getElementById('pv-canvas').getContext('2d').getImageData(0,0,1,1).data).join(',')==='255,0,255,255'`),'chosen sentinel');
 await click(page,'#stage-comment');assert(await page.evaluate(`document.getElementById('stage-comment-refusal').textContent.includes('PARTS_COMMENT_UNAVAILABLE')`),'assembly capture refused without changing comment contract');await click(page,'#stage-comment');
 await click(page,'#native-one');assert(await page.evaluate(`new DOMMatrix(document.getElementById('rig-root').style.transform).a===1`),'native one');await click(page,'#fit');
 assert(await page.evaluate(`document.querySelector('[data-pv-comparison="difference"]')===null`),'Difference absent');report[lang]={baseVsBase:true,oracle:true,frontmost:true,hole:true,hidden:true,outline:true,verdict:true,camera:true,label:await page.evaluate(`document.getElementById('pv-assemble').textContent`)};
 }
 assert((await Promise.all(pkg.files.map(async(f,i)=>createHash('sha256').update(await readFile(f.abs)).digest('hex')===before[i]))).every(Boolean),'inputs immutable');
 const missing=await startPartsServer(await loadPartsView(root),{port:0,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});servers.push(missing);await page.goto(`http://127.0.0.1:${missing.port}/`);await wait(page,`document.body.dataset.ready==='true'`);await click(page,'#pv-assemble');assert(await page.evaluate(`document.getElementById('pv-comparison').hidden&&document.getElementById('reference-empty').textContent.includes('PARTS_REFERENCE_UNAVAILABLE')`),'missing painting reason');
 const atlas=await startPartsServer(await loadPartsView('examples/demo'),{port:0,exitOnClose:false,graceMs:3600000,unopenedTimeoutMs:3600000});servers.push(atlas);
 for(const lang of ['en','ko']){await page.goto(`http://127.0.0.1:${atlas.port}/?lang=${lang}`);await wait(page,`document.body.dataset.ready==='true'`);assert(await page.evaluate(`document.getElementById('pv-assemble').disabled`),'atlas assembly disabled');report['atlasReason'+lang]=await page.evaluate(`document.getElementById('pv-assemble').title`);assert(report['atlasReason'+lang].length>0,'atlas missing placement reason');}
 report.status='passed';await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(e){if(page)await writeFile(join(out,'failure.png'),await page.screenshot());throw e;}finally{await page?.close();for(const s of servers)s.stop(true);await rm(root,{recursive:true,force:true});}
}
if(import.meta.main)await main();
