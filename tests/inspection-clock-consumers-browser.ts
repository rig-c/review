import projectPackage from '../package.json';
import {instrumentRigMount} from './helpers/mount-probe.ts';
/** Nova-only: generated public fixture, installed real producers, observation-only clock instrumentation. */
import {mkdir,mkdtemp,readFile,writeFile,cp,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
const red=process.argv.includes('--red'),out=resolve('clock-consumers-evidence');
await mkdir(out,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'clk-')),pkg=join(root,'package'),bench=process.env.CLOCK_PRODUCER_BENCH;
if(!bench)throw Error('CLOCK_PRODUCER_BENCH must name an isolated installed producer bench');
const parts=join(bench,'node_modules/@rig-c/parts'),core=join(bench,'node_modules/@rig-c/core');
const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const check=(v:unknown,s:string)=>{if(!v)throw Error(s);};
const pins={parts:JSON.parse(await readFile(join(parts,'package.json'),'utf8')).version,core:JSON.parse(await readFile(join(core,'package.json'),'utf8')).version,play:JSON.parse(await readFile('node_modules/@rig-c/play/package.json','utf8')).version,bun:Bun.version};
const declaredParts=JSON.parse(await readFile(join(parts,'package.json'),'utf8'));
check(pins.parts===projectPackage.devDependencies['@rig-c/parts']&&pins.core===declaredParts.dependencies['@rig-c/core'],'FROZEN_LOCK_PRODUCER_MISMATCH');
// Save the installed capabilities as evidence before using their published rig/check + animations_from contract.
await writeFile(join(out,'producer-contract.txt'),(await readFile(join(parts,'src/rig.ts'),'utf8')).split('\n').filter(l=>/animations_from|motion/.test(l)).join('\n'));
await mkdir(join(pkg,'out/parts'),{recursive:true});
const image=new PNG({width:160,height:160});for(let i=0;i<160*160;i++)image.data.set([80,140,210,255],i*4);
await writeFile(join(pkg,'out/parts/torso.png'),PNG.sync.write(image));
await writeFile(join(pkg,'out/parts.json'),JSON.stringify({rig_size:[240,240],scale_rig_per_source:1,ghost_px:{},parts:[{name:'torso',from:'full:topwear',x:40,y:40,w:160,h:160,opaque_px:25600,projected_core_px:25600,source_px_taken:25600,refused_drift_px:0,merged_px:0,seam_override_px:0}]}));
const motion={spec:'rigc-motion/1',animations:{pulse:{duration:1,loop:false,tracks:[{bone:'chest',property:'rotate',keys:[{t:0,v:[0]},{t:1,v:[15]}]}]}}};
await writeFile(join(pkg,'animations.json'),JSON.stringify(motion));
await writeFile(join(pkg,'config.json'),JSON.stringify({key:'clock-probe',assemble:{rig_scale:1,plan:[['torso','full','topwear']]},bones:[{name:'chest',parent:'root',at:[120,180],tip:[120,60]}],meshes:{torso:{grid:16,r:16,segments:[['chest',[120,180],[120,60]]]}},regions:{},motion:{duration:1,tracks:[{bone:'chest',prop:'translatey',amp:8,period:1,phase:0}],animations_from:'animations.json'}}));
async function run(args:string[],label:string){const p=Bun.spawn(['bun',join(parts,'cli.ts'),...args],{stdout:'pipe',stderr:'pipe'});const [stdout,stderr,exit]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);await writeFile(join(out,label+'.log'),stdout+stderr);check(exit===0,label+' exit '+exit+' '+stdout.slice(-2000)+stderr.slice(-1000));}
await run(['rig','--config',join(pkg,'config.json'),'--parts',join(pkg,'out'),'--out',join(pkg,'out/rig')],'initial-rig');
await run(['check','--rig',join(pkg,'out/rig'),'--parts',join(pkg,'out'),'--out',join(pkg,'check'),'--page-edges','free','--pack-shape','polygon'],'initial-check');
await cp(join(pkg,'check/build'),join(pkg,'build'),{recursive:true});
async function tree(dir:string,prefix=''):Promise<Record<string,string>>{let v:Record<string,string>={};for(const e of await readdir(dir,{withFileTypes:true})){const name=prefix+e.name;if(e.isDirectory())Object.assign(v,await tree(join(dir,e.name),name+'/'));else if(e.isFile())v[name]=hash(await readFile(join(dir,e.name)));}return v;}
const before=await tree(pkg),main=await readFile('web/main.ts','utf8');
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'clock-observation-only',setup(b){b.onLoad({filter:/\/web\/main\.ts$/},()=>({loader:'ts',contents:instrumentRigMount(main,`\nObject.assign(window,{__clockReading:()=>({display:time,runtime:player?.time,duration,playing,restoring:persistence?.restoring()??true,panel:Number(document.querySelector<HTMLInputElement>('[data-curve-time]')?.value),sourceHash:data.sourceHash,stageHash:stageModelHash,applied:appliedOnStage})});`) }));}}]});
check(built.success,String(built.logs));const bundle=await built.outputs[0]!.text();
const rows:any[]=[],cap='e'.repeat(64);
for(const lang of ['en','ko']){
 const server=await startServer(await loadReview(pkg),{port:0,stateDir:join(root,'state-'+lang),cwd:bench,capability:cap});
 const posted:any[]=[];
 const proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const u=new URL(req.url);if(u.pathname==='/main.js')return new Response(bundle,{headers:{'Content-Type':'text/javascript'}});if(req.method==='POST'&&u.pathname==='/api/rebuild')posted.push(JSON.parse(await req.clone().text()));u.port=String(server.port);const forwarded=new Request(u.href,req);forwarded.headers.set('host',u.host);if(forwarded.headers.has('origin'))forwarded.headers.set('origin',u.origin);return fetch(forwarded,{redirect:'manual'});}});
 const page=await launchCdpSession(join(root,'p-'+lang));
 const read=()=>page.evaluate<any>('window.__clockReading()');
 async function wait(e:string){for(let n=0;n<800;n++){if(await page.evaluate<boolean>(e))return;await Bun.sleep(25);}await writeFile(join(out,lang+'-timeout.json'),JSON.stringify(await page.evaluate('({text:document.body.innerText,reading:window.__clockReading?.(),gate:window.rigReviewEditor?.animation.gate()})')));throw Error('Timeout '+e);}
 async function loopPause(){await page.evaluate(`if(!window.__clockReading().playing)document.getElementById('play').click()`);await wait('window.__clockReading().runtime>2.2&&window.__clockReading().display>.25&&window.__clockReading().display<.75');await page.evaluate(`(()=>{document.getElementById('play').click()})()`);const p=await read();check(!p.playing&&p.runtime>2&&p.display<1,'independent clocks');await page.evaluate('new Promise(r=>{let n=0;function f(){if(++n===90)r(true);else requestAnimationFrame(f)}requestAnimationFrame(f)})');check(JSON.stringify(await read())===JSON.stringify(p),'paused clocks stable for 90 frames');return p;}
 try{
  await page.setViewport(1440,1000);await page.goto(`http://127.0.0.1:${proxy.port}/?lang=${lang}#cap=${cap}`);
  await wait('document.body.dataset.ready==="true"&&window.__clockReading&&!window.__clockReading().restoring&&!document.getElementById("play").disabled');
  await wait('window.rigReviewEditor.idle.source()?.tracks?.length>0');
  await page.evaluate(`(()=>{document.querySelector('[data-mode="playback"]').click();const s=document.getElementById('animation-select');s.value='idle';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const idleGate=await page.evaluate<any>('window.rigReviewEditor.animation.gate()');
  check(idleGate.code==='ANIMATION_IDLE_GOVERNED_BY_TURN_PAD','idle key editing remains refused '+JSON.stringify(idleGate));
  const paused=await loopPause();
  check(Math.abs(paused.panel-(red?paused.runtime:paused.display))<.001,'panel clock domain');
  await writeFile(join(out,lang+'-loop.png'),await page.screenshot());
  // Use the actual Idle tracks field and Apply button; no operation or clock is injected.
  await page.evaluate(`(()=>{document.querySelector('#idle-track-list button').click();const n=document.querySelector('#idle-track-editor input[aria-label="amp value"]');n.value='9';n.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('#idle-tracks [data-idle-preview]').checked=false;document.querySelector('#idle-tracks [data-idle-preview]').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('idle-apply').click()})()`);
  await wait('window.__clockReading().applied && !document.getElementById("idle-apply").disabled');
  const rebuilt=await read();
  check(Math.abs(rebuilt.display-(red?1:paused.display))<1e-5,'reload expected inspection phase');
  check(!rebuilt.playing&&rebuilt.sourceHash===paused.sourceHash,'paused source identity stable');
  const applied=await page.evaluate<any>('JSON.parse(document.getElementById("rebuild-applied").value)');
  await writeFile(join(out,lang+'-clock-report.json'),JSON.stringify({pins,paused,rebuilt,applied,posted},null,2));
  check(posted.some(p=>p.patch?.ops?.some((o:any)=>o.path==='/motion/tracks/0/amp'&&o.value===9)),'real posted idle producer patch');
  await Bun.sleep(1400);
  const draft=await page.evaluate<any>(`Object.entries(localStorage).filter(([k])=>k.startsWith('rig-review-draft/1:')).map(([k,v])=>JSON.parse(v))`);
  check(JSON.stringify(draft).includes(applied.buildId),'APPLIED inputs saved in actual local draft');
  await writeFile(join(out,lang+'-rebuilt.png'),await page.screenshot());
  await page.goto(`http://127.0.0.1:${proxy.port}/?lang=${lang}&reopen=1#cap=${cap}`);
  await wait('document.body.dataset.ready==="true"&&window.__clockReading&&!window.__clockReading().restoring&&!document.getElementById("play").disabled');
  const reopened=await page.evaluate<any>('JSON.parse(document.getElementById("rebuild-applied").value)');
  check(JSON.stringify(reopened)===JSON.stringify(applied),'actual reopen restores APPLIED inputs');
  // The editable clip is nonlooping: normal +Key and stage-pose UI retain their existing time.
  await page.evaluate(`(()=>{document.getElementById('play').click();const s=document.getElementById('animation-select');s.value='pulse';s.dispatchEvent(new Event('change',{bubbles:true}));const t=document.querySelector('[data-curve-time]');t.value='.375';document.querySelector('[data-curve-seek]').click()})()`);
  await wait('window.rigReviewEditor.animation.gate().editable');
  await page.evaluate(`(()=>{if(window.__clockReading().playing)document.getElementById('play').click();const t=document.querySelector('[data-curve-time]');t.value='.375';document.querySelector('[data-curve-seek]').click();document.querySelector('[data-add-key-track="0"]').click()})()`);
  const ops=await page.evaluate<any>('window.rigReviewEditor.animation.ops()');
  check(ops.length===1&&ops[0].op==='insert_key'&&Math.abs(ops[0].time-.375)<1e-5,'nonloop +Key at shown time');
  await page.evaluate('window.rigReviewEditor.animation.clearPending()');
  const pose=await page.evaluate<any>(`(()=>{const n=document.querySelector('[data-bone="chest"]'),r=n.getBoundingClientRect();return window.rigReviewEditor.animation.poseBone('chest','rotate',r.x+r.width/2+45,r.y+r.height/2-30)})()`);
  check(pose.ok,'stage pose inserts');
  const poseOps=await page.evaluate<any>('window.rigReviewEditor.animation.ops()');
  check(poseOps.some((o:any)=>o.op==='insert_key'&&Math.abs(o.time-.375)<1e-5),'nonloop pose at shown time');
  await page.evaluate('window.rigReviewEditor.animation.clearPending()');
  const invalid=await page.evaluate<any>('window.rigReviewEditor.animation.insertKey(0,-1,[2])');
  check(!invalid.ok&&/ANIMATION_/.test(JSON.stringify(invalid)),'invalid explicit operation named-refuses '+JSON.stringify(invalid));
  rows.push({lang,idleGate,paused,posted,applied,draft,rebuilt,reopened,ops,pose,poseOps,invalid});
  await writeFile(join(out,lang+'-report.json'),JSON.stringify(rows.at(-1),null,2));
 }finally{await page.close();proxy.stop(true);server.stop(true);}
}
const after=await tree(pkg);check(JSON.stringify(before)===JSON.stringify(after),'package source bytes unchanged');
await writeFile(join(out,'report.json'),JSON.stringify({mode:red?'RED diagnostic':'GREEN',pins,mainSha256:hash(main),before,after,rows},null,2));
console.log(JSON.stringify({mode:red?'RED diagnostic':'GREEN',pins,sourceUnchanged:true,rows:rows.map(r=>({lang:r.lang,display:r.paused.display,runtime:r.paused.runtime,panel:r.paused.panel,reloaded:r.rebuilt.display}))}));
