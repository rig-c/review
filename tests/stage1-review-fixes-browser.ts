/** Narrow EN/KO controls for adopted #403 chest rebinding and region-only inspection. No correction producer run. */
import {mkdir,mkdtemp,writeFile,readFile,readdir,rm,cp} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writeStage1LivePackage} from './helpers/stage1-live-package.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
import {loadReview} from '../src/manifest.ts';
import {resolveProducer,runTool,compileArgs} from '../src/producer.ts';
import {startServer} from '../src/server.ts';
const bench=process.env.RV367_BENCH;if(!bench)throw Error('Installed producer bench required');
const root=await mkdtemp(join(tmpdir(),'fix.')),out=join(process.cwd(),'artifacts/stage1-review-fixes');await mkdir(out,{recursive:true});
let page:InputCdpSession|undefined,server:Awaited<ReturnType<typeof startServer>>|undefined;
const receipt:any[]=[];
async function hashes(dir:string){const rows:Record<string,string>={};const walk=async(at:string)=>{for(const e of await readdir(at,{withFileTypes:true})){const path=join(at,e.name);if(e.isDirectory())await walk(path);else rows[relative(dir,path)]=createHash('sha256').update(await readFile(path)).digest('hex');}};await walk(dir);return rows;}
async function closeServer(){if(!server)return;const base=`http://127.0.0.1:${server.port}`;for(let i=0;i<300;i++){const status:any=await (await fetch(base+'/api/rebuild')).json();if(status.baseline?.status!=='running'&&status.inspectedCheck?.status!=='running')break;await Bun.sleep(100);}server.stop(true);server=undefined;}
async function makePackage(kind:'chests'|'regions'){
 const pkg=join(root,kind);await writeStage1LivePackage(pkg);const config=JSON.parse(await readFile(join(pkg,'config.json'),'utf8'));
 if(kind==='chests'){
  config.meshes.torso.contour.regions=[];config.meshes.torso.contour.bust={apex_r:[90,105],apex_l:[150,105],cleavage:[120,105],alpha:.6,clearance:2,bone_r:'chest',bone_l:'chest'};
  config.assemble.plan.push(['torsoB','full','author:second']);config.bones.push({name:'chestB',parent:'root',at:[360,180],tip:[360,60]});
  config.meshes.torsoB={contour:{tolerance:1,margin:2,spacing:16,maxEdge:30,stray:0,bridges:true,regions:[{name:'onlyB',shape:'circle',cx:330,cy:105,r:18,bone:'chestB',spacing:8,band:8}]},r:16,segments:[['chestB',[360,180],[360,60]]]};
  const parts=JSON.parse(await readFile(join(pkg,'out/parts.json'),'utf8'));parts.rig_size=[480,240];parts.parts.push({...parts.parts[0],name:'torsoB',from:'full:author:second',x:280});await writeFile(join(pkg,'out/parts.json'),JSON.stringify(parts));await cp(join(pkg,'out/parts/torso.png'),join(pkg,'out/parts/torsoB.png'));
 }else{config.meshes={};config.regions={torso:'chest'};}
 await writeFile(join(pkg,'config.json'),JSON.stringify(config,null,1)+'\n');
 const resolved=resolveProducer([pkg,bench!]);if(!resolved.ok)throw Error(resolved.error);
 const rig=await runTool(resolved.producer.bin,['rig','--config',join(pkg,'config.json'),'--parts',join(pkg,'out'),'--out',join(pkg,'out/rig')],{cwd:bench!});console.log(rig.lines.join('\n'));if(rig.exitCode)throw Error('FIXTURE_RIG_FAILED');
 const build=await runTool(resolved.compiler.bin,compileArgs({rig:join(pkg,'out/rig/rig.json'),motion:join(pkg,'out/rig/motion.json'),out:join(pkg,'build'),pageEdges:'free',packShape:'polygon'}),{cwd:bench!});console.log(build.lines.join('\n'));if(build.exitCode)throw Error('FIXTURE_COMPILE_FAILED');
 await writeFile(join(pkg,'review.json'),JSON.stringify({schema:'rig-review/1',id:'adopted-'+kind,title:'Generated structure '+kind,revision:'1',model:'build/skeleton.model.json',producer:{config:'config.json',parts:'out'},animations:[{id:'idle'}]}));
 return {pkg,config,versions:{producer:resolved.producer.version,compiler:resolved.compiler.version}};
}
async function ready(base:string,lang:string){await page!.goto(base+'/?lang='+lang);await page!.evaluate(`(async()=>{for(let i=0;i<400;i++){if(window.rigReviewEditor&&document.getElementById('handoff-line')?.textContent&&!/Reading/.test(document.getElementById('handoff-line').textContent))return;await new Promise(r=>setTimeout(r,25));}throw Error('PAGE_NOT_READY')})()`);}
async function openPart(name:string){await page!.evaluate(`(async()=>{document.querySelector('[data-review-stage="1"]').click();for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){d.querySelector('[data-pv-item="${name}"]').click();await Promise.resolve();const button=d.querySelector('#pv-corrections button');if(!button?.title.startsWith('${name} ·'))throw Error('CORRECTION_BUTTON_NOT_REBOUND '+button?.title);button.click();break;}await new Promise(r=>setTimeout(r,25));}for(let i=0;i<200;i++){if(document.documentElement.dataset.inspectionStage==='3'&&document.getElementById('chest-edit').getAttribute('aria-pressed')==='true')return;await new Promise(r=>setTimeout(r,25));}throw Error('CHEST_NOT_OPEN '+document.getElementById('message').textContent)})()`);}
async function capture(){return await page!.evaluate<any>(`(async()=>{const count=window.captured.length;document.getElementById('bust-apply').click();for(let i=0;i<200;i++){if(window.captured.length>count&&!document.getElementById('bust-apply').disabled)return window.captured.at(-1);await new Promise(r=>setTimeout(r,25));}throw Error('NO_CAPTURE '+document.getElementById('chest-editor-status').textContent)})()`);}
try{
 page=await launchCdpSession(join(tmpdir(),'reviewfix-cdp'));await page.setViewport(1440,1000);
 for(const kind of ['chests','regions'] as const){
  const f=await makePackage(kind),original=await hashes(f.pkg);server=await startServer(await loadReview(f.pkg),{port:0,stateDir:join(root,kind+'-state'),cwd:bench,graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});const base=`http://127.0.0.1:${server.port}`;
  for(const lang of ['en','ko']){
   await ready(base,lang);
   if(kind==='chests'){
    await page.evaluate(`(()=>{const real=window.fetch;window.captured=[];window.fetch=(url,init)=>{if(new URL(typeof url==='string'?url:url.url,location.href).pathname==='/api/rebuild'&&init?.method==='POST'){window.captured.push(JSON.parse(init.body));return Promise.resolve(Response.json({status:'refused',error:'CONTROL_CAPTURED',producerLine:null}));}return real(url,init);};})()`);
    await openPart('torsoB');const fields=await page.evaluate<any>(`({mode:document.getElementById('bust-mode').value,cx:document.getElementById('chest-0-cx').value,second:document.getElementById('chest-1-cx').value,landmark:document.getElementById('lm-apex_r-x').value})`);
    if(fields.mode!=='circles'||fields.cx!=='330'||fields.second!==''||fields.landmark!=='')throw Error('CROSS_PART_FIELDS '+JSON.stringify(fields));
    const b=await capture();if(b.part!=='torsoB'||JSON.stringify(b.regions)!==JSON.stringify(f.config.meshes.torsoB.contour.regions))throw Error('B_RECEIVED_A_SEED '+JSON.stringify(b));
    await page.evaluate(`document.getElementById('chest-0-cx').value='331';document.getElementById('chest-0-cx').dispatchEvent(new Event('input',{bubbles:true}))`);await openPart('torsoB');const edited=await capture();if(edited.regions?.[0]?.cx!==331)throw Error('SAME_BINDING_EDIT_LOST');
    await writeFile(join(out,lang+'-chest-b.png'),await page.screenshot());
    await openPart('torso');const a=await capture();if(a.part!=='torso'||JSON.stringify(a.bust?.apex_r)!=='[90,105]'||a.bust?.bone_r!=='chest'||a.regions)throw Error('A_RECEIVED_B_SEED '+JSON.stringify(a));
    await writeFile(join(out,lang+'-chest-a.png'),await page.screenshot());receipt.push({kind,lang,fields,b,edited,a,versions:f.versions,producerApplies:0});
   }else{
    const data=await page.evaluate<any>(`(async()=>{document.querySelector('[data-review-stage="1"]').click();for(let i=0;i<400;i++){const d=document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument;if(d?.body.dataset.ready==='true'){d.querySelector('[data-pv-item="torso"]').click();return {text:d.querySelector('#pv-corrections').textContent,buttons:d.querySelectorAll('#pv-corrections button').length,data:await (await fetch('/api/stage-parts')).json(),canvas:!!d.querySelector('canvas')};}await new Promise(r=>setTimeout(r,25));}throw Error('REGION_PARTS_UNAVAILABLE')})()`);
    if(data.data.items?.[0]?.name!=='torso'||data.data.items[0].mesh||data.data.draft||data.buttons!==0||!data.canvas||!data.data.draftUnavailable?.startsWith('STAGE_DRAFT_NO_MESH')||!data.text.includes(lang==='ko'?'직접 수정':'direct correction'))throw Error('REGION_INSPECTION_LOST '+JSON.stringify(data));
    await writeFile(join(out,lang+'-regions.png'),await page.screenshot());receipt.push({kind,lang,...data,versions:f.versions});
   }
   await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log('ADOPTED_UI_CASE_PASS '+kind+' '+lang);
  }
  await closeServer();if(JSON.stringify(original)!==JSON.stringify(await hashes(f.pkg)))throw Error('ORIGINALS_CHANGED '+kind);receipt.push({kind,immutable:true,originals:original});
 }
 await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log('ADOPTED_UI_PASS '+receipt.filter(r=>r.lang).length+' language/fixture cases');
}finally{await closeServer();await page?.close();await rm(root,{recursive:true,force:true});}
