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
import {WalkDeadlineError,withDeadline} from './helpers/walk-deadline.ts';

const partsDocument = `document.querySelector('.review-stage-panel iframe:not([hidden])')?.contentDocument`;
const partsReady = `d?.body?.dataset.ready === 'true'`;
const enterParts = `document.querySelector('[data-review-stage="1"]').click()`;

export const STAGE1_REGION_READ_BASELINE = {
  enEnvelopeMs: 96.661597,
  koEnvelopeMs: 71.008236,
  multiplier: 4,
  roundUpMs: 1_000,
} as const;

export const STAGE1_FIX_DEADLINES = {
  PAGE_NOT_READY: 10_000,
  STAGE1_PARTS_READY: 10_000,
  STAGE1_CHEST_BIND_READY: 5_000,
  // Four times the slower combined EN/KO envelope, rounded up to a second.
  STAGE1_REGION_PARTS_READ: 1_000,
} as const;

export const STAGE1_FIX_READINESS = {
  PAGE_NOT_READY: `(() => {
    const text = document.getElementById('handoff-line')?.textContent;
    return Boolean(window.rigReviewEditor && text && !/Reading/.test(text));
  })()`,
  STAGE1_PARTS_READY: `(() => { const d = ${partsDocument}; return ${partsReady}; })()`,
  STAGE1_CHEST_BIND_READY: `document.documentElement.dataset.inspectionStage === '3' &&
    document.getElementById('chest-edit')?.getAttribute('aria-pressed') === 'true'`,
} as const;

type FixPage = Pick<InputCdpSession, 'evaluate'>;
type Readiness = keyof typeof STAGE1_FIX_READINESS;
type FixDeadlines = Readonly<Record<keyof typeof STAGE1_FIX_DEADLINES, number>>;

export async function waitForStage1FixReadiness(
  page: FixPage, name: Readiness, ms: number = STAGE1_FIX_DEADLINES[name],
): Promise<void> {
  const expires = performance.now() + ms;
  await withDeadline(name, ms, async signal => {
    const check = () => {
      signal.throwIfAborted();
      if (performance.now() >= expires) throw new WalkDeadlineError(name, ms);
    };
    for (;;) {
      check();
      const ready = await page.evaluate<boolean>(STAGE1_FIX_READINESS[name]);
      check();
      if (ready === true) return;
      await Bun.sleep(Math.min(25, Math.max(0, expires - performance.now())));
    }
  });
}

export async function openStage1FixChest(
  page: FixPage, name: 'torso' | 'torsoB', deadlines: FixDeadlines = STAGE1_FIX_DEADLINES,
): Promise<void> {
  await page.evaluate(enterParts);
  await waitForStage1FixReadiness(page, 'STAGE1_PARTS_READY', deadlines.STAGE1_PARTS_READY);
  await page.evaluate(`(async () => {
    const d = ${partsDocument};
    if (!(${partsReady})) throw Error('STAGE1_PARTS_READY_LOST');
    d.querySelector('[data-pv-item="${name}"]').click();
    await Promise.resolve();
    const button = d.querySelector('#pv-corrections button');
    if (!button?.title.startsWith('${name} ·')) throw Error('CORRECTION_BUTTON_NOT_REBOUND ' + button?.title);
    button.click();
  })()`);
  await waitForStage1FixReadiness(page, 'STAGE1_CHEST_BIND_READY', deadlines.STAGE1_CHEST_BIND_READY);
}

type RegionRequest = (url: string, init: {signal: AbortSignal}) => Promise<Pick<Response, 'json'>>;

// Serialized into the browser so the original same-origin fetch and its body share an abort signal.
export async function readStage1RegionParts(ms: number, request: RegionRequest = fetch): Promise<unknown> {
  const controller = new AbortController();
  const error = Error(`WALK_DEADLINE: STAGE1_REGION_PARTS_READ (${ms}ms)`);
  const expires = performance.now() + ms;
  const check = () => {
    if (performance.now() >= expires) controller.abort(error);
    controller.signal.throwIfAborted();
  };
  const timer = setTimeout(() => controller.abort(error), ms);
  try {
    const response = await request('/api/stage-parts', {signal: controller.signal});
    check();
    const data = await response.json();
    check();
    return data;
  } catch (cause) {
    controller.signal.throwIfAborted();
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

export async function openStage1FixRegion(
  page: FixPage, deadlines: FixDeadlines = STAGE1_FIX_DEADLINES,
) {
  await page.evaluate(enterParts);
  await waitForStage1FixReadiness(page, 'STAGE1_PARTS_READY', deadlines.STAGE1_PARTS_READY);
  return page.evaluate<any>(`(async () => {
    const d = ${partsDocument};
    if (!(${partsReady})) throw Error('STAGE1_PARTS_READY_LOST');
    d.querySelector('[data-pv-item="torso"]').click();
    return {
      text: d.querySelector('#pv-corrections').textContent,
      buttons: d.querySelectorAll('#pv-corrections button').length,
      data: await (${readStage1RegionParts.toString()})(${deadlines.STAGE1_REGION_PARTS_READ}),
      canvas: !!d.querySelector('canvas'),
    };
  })()`);
}

export async function captureStage1Fix(page: FixPage){return await page.evaluate<any>(`(async()=>{const count=window.captured.length;document.getElementById('bust-apply').click();for(let i=0;i<200;i++){if(window.captured.length>count&&!document.getElementById('bust-apply').disabled)return window.captured.at(-1);await new Promise(r=>setTimeout(r,25));}throw Error('NO_CAPTURE '+document.getElementById('chest-editor-status').textContent)})()`);}

if (import.meta.main) {
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
try{
 page=await launchCdpSession(join(tmpdir(),'reviewfix-cdp'), {sendDeadlineMs: 10_000});await page.setViewport(1440,1000);
 for(const kind of ['chests','regions'] as const){
  const f=await makePackage(kind),original=await hashes(f.pkg);server=await startServer(await loadReview(f.pkg),{port:0,stateDir:join(root,kind+'-state'),cwd:bench,graceMs:600000,unopenedTimeoutMs:600000,exitOnClose:false});const base=`http://127.0.0.1:${server.port}`;
  for(const lang of ['en','ko']){
   await page.goto(base+'/?lang='+lang);
   await waitForStage1FixReadiness(page, 'PAGE_NOT_READY');
   if(kind==='chests'){
    await page.evaluate(`(()=>{const real=window.fetch;window.captured=[];window.fetch=(url,init)=>{if(new URL(typeof url==='string'?url:url.url,location.href).pathname==='/api/rebuild'&&init?.method==='POST'){window.captured.push(JSON.parse(init.body));return Promise.resolve(Response.json({status:'refused',error:'CONTROL_CAPTURED',producerLine:null}));}return real(url,init);};})()`);
    await openStage1FixChest(page, 'torsoB');const fields=await page.evaluate<any>(`({mode:document.getElementById('bust-mode').value,cx:document.getElementById('chest-0-cx').value,second:document.getElementById('chest-1-cx').value,landmark:document.getElementById('lm-apex_r-x').value})`);
    if(fields.mode!=='circles'||fields.cx!=='330'||fields.second!==''||fields.landmark!=='')throw Error('CROSS_PART_FIELDS '+JSON.stringify(fields));
    const b=await captureStage1Fix(page);if(b.part!=='torsoB'||JSON.stringify(b.regions)!==JSON.stringify(f.config.meshes.torsoB.contour.regions))throw Error('B_RECEIVED_A_SEED '+JSON.stringify(b));
    await page.evaluate(`document.getElementById('chest-0-cx').value='331';document.getElementById('chest-0-cx').dispatchEvent(new Event('input',{bubbles:true}))`);await openStage1FixChest(page, 'torsoB');const edited=await captureStage1Fix(page);if(edited.regions?.[0]?.cx!==331)throw Error('SAME_BINDING_EDIT_LOST');
    await writeFile(join(out,lang+'-chest-b.png'),await page.screenshot());
    await openStage1FixChest(page, 'torso');const a=await captureStage1Fix(page);if(a.part!=='torso'||JSON.stringify(a.bust?.apex_r)!=='[90,105]'||a.bust?.bone_r!=='chest'||a.regions)throw Error('A_RECEIVED_B_SEED '+JSON.stringify(a));
    await writeFile(join(out,lang+'-chest-a.png'),await page.screenshot());receipt.push({kind,lang,fields,b,edited,a,versions:f.versions,producerApplies:0});
   }else{
    const data=await openStage1FixRegion(page);
    if(data.data.items?.[0]?.name!=='torso'||data.data.items[0].mesh||data.data.draft||data.buttons!==0||!data.canvas||!data.data.draftUnavailable?.startsWith('STAGE_DRAFT_NO_MESH')||!data.text.includes(lang==='ko'?'직접 수정':'direct correction'))throw Error('REGION_INSPECTION_LOST '+JSON.stringify(data));
    await writeFile(join(out,lang+'-regions.png'),await page.screenshot());receipt.push({kind,lang,...data,versions:f.versions});
   }
   await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log('ADOPTED_UI_CASE_PASS '+kind+' '+lang);
  }
  await closeServer();if(JSON.stringify(original)!==JSON.stringify(await hashes(f.pkg)))throw Error('ORIGINALS_CHANGED '+kind);receipt.push({kind,immutable:true,originals:original});
 }
 await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2));console.log('ADOPTED_UI_PASS '+receipt.filter(r=>r.lang).length+' language/fixture cases');
}finally{await closeServer();await page?.close();await rm(root,{recursive:true,force:true});}
}
