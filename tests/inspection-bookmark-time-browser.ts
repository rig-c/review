import {instrumentRigMount} from './helpers/mount-probe.ts';
/** Nova-only synthetic one-second loop. Instrumentation observes clocks; it never sets them or changes restore predicates. */
import {cp,mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {encodeBookmark} from '../web/inspection-persistence.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
const red=process.argv.includes('--red'),out='bookmark-time-evidence';
await mkdir(out,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'bookmark-')),cap='d'.repeat(64);
// This original public generated fixture already declares a one-second idle clip.
await cp('examples/demo',join(root,'package'),{recursive:true});
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const files=['review.json','skeleton.model.json','lantern.png','lantern.svg','pose.json','SOURCE.md','chime.wav'];
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async f=>[f,hash(await readFile(join(root,'package',f)))])));
const before=await hashes();
const built=await Bun.build({entrypoints:['web/main.ts'],target:'browser',format:'esm',plugins:[{name:'read-only-clock-observation',setup(build){build.onLoad({filter:/\/web\/main\.ts$/},async args=>({loader:'ts',contents:instrumentRigMount(await readFile(args.path,'utf8'),`Object.assign(window,{__bookmarkReading:()=>!data||!player||!persistence?null:({display:time,runtime:player.time,duration,playing,bookmark:inspectionBookmark(),control:controlState(),restoring:persistence.restoring()})});`) }));}}]});
if(!built.success)throw new Error(String(built.logs));
const bundle=await built.outputs[0]!.text();
const server=await startServer(await loadReview(join(root,'package/review.json')),{port:0,capability:cap,stateDir:join(root,'state'),viewOnly:true,graceMs:60000});
// Same-origin transparent proxy serves the instrument-only bundle; all other traffic uses the real server.
const proxy=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){const u=new URL(req.url);if(u.pathname==='/bookmark-away')return new Response('<!doctype html><title>Inspection navigation control</title>',{headers:{'Content-Type':'text/html'}});if(u.pathname==='/main.js')return new Response(bundle,{headers:{'Content-Type':'text/javascript'}});u.port=String(server.port);const forwarded=new Request(u.href,req);forwarded.headers.set('host',u.host);if(forwarded.headers.has('origin'))forwarded.headers.set('origin',u.origin);return fetch(forwarded,{redirect:'manual'});}});
const page=await launchCdpSession(join(root,'profile'));
const rows:any[]=[];
const check=(v:unknown,s:string)=>{if(!v)throw new Error(s);};
async function wait(e:string){for(let n=0;n<400;n++){if(await page.evaluate<boolean>(e))return;await Bun.sleep(25);}await writeFile(join(out,'timeout.png'),await page.screenshot());await writeFile(join(out,'timeout.json'),JSON.stringify(await page.evaluate('({text:document.body.innerText,html:document.documentElement.outerHTML.slice(-3000),reading:typeof window.__bookmarkReading})')));throw new Error('Timeout '+e);}
const read=()=>page.evaluate<any>('window.__bookmarkReading()');
const drafts=`Object.entries(localStorage).filter(([k])=>k.startsWith('rig-review-draft/1:'))`;
try{
 await page.setViewport(1440,1000);
 for(const lang of ['en','ko']){
  const refusal=lang==='ko'?'저장된 점검 시간이 선택된 클립/레퍼런스 범위를 벗어났습니다':'Saved inspection time is outside the selected clip/reference';
  const url=`http://127.0.0.1:${proxy.port}/?lang=${lang}#cap=${cap}`;
  await page.goto(url);await wait('window.__bookmarkReading?.()&&!window.__bookmarkReading().restoring&&!document.getElementById("play").disabled');
  await page.evaluate(`document.querySelector('[data-mode="playback"]').click();document.querySelector('[data-part-list] button[data-slot="lantern"]').click();if(!window.__bookmarkReading().playing)document.getElementById('play').click()`);
  await wait('window.__bookmarkReading().runtime>2.2&&window.__bookmarkReading().display>.2&&window.__bookmarkReading().display<.8');
  await page.evaluate(`document.getElementById('play').click()`);
  const paused=await read();if(!red)check(paused.control.time===paused.display,'control observation uses inspected clock independently of runtime');check(!paused.playing&&paused.runtime>2&&paused.display<1,'independent accumulated runtime must survive multiple loops');
  await page.evaluate('new Promise(resolve=>{let n=0;function frame(){if(++n===90)resolve(true);else requestAnimationFrame(frame)}requestAnimationFrame(frame)})');
  const stable=await read();check(stable.runtime===paused.runtime&&stable.display===paused.display,'both paused clocks stable across 90 frames');
  await Bun.sleep(1200);
  const saved=await page.evaluate<any>(`({drafts:${drafts},href:location.href,language:document.documentElement.lang})`);
  check(saved.language===lang,'language');check(saved.drafts.length===1,'one source-bound draft');
  const draft=JSON.parse(saved.drafts[0][1]);check(draft.bookmark.selection.part.slot==='lantern','selected slot saved');
  check(draft.bookmark.time===(red?paused.runtime:paused.display),'saved inspection domain');
  await writeFile(join(out,`${lang}-before.png`),await page.screenshot());
  // Real pagehide, then reopen at exactly the same origin using local draft (no URL override).
  await page.goto(`http://127.0.0.1:${proxy.port}/bookmark-away`);const hiddenDraft=JSON.parse((await page.evaluate<any>(drafts))[0][1]);check(JSON.stringify(hiddenDraft.bookmark)===JSON.stringify(draft.bookmark),'pagehide preserves actual bookmark');await page.goto(url);
  await wait('window.__bookmarkReading?.()&&!window.__bookmarkReading().restoring');
  const reopened=await read(),warning=await page.evaluate<string>('document.body.innerText');
  await writeFile(join(out,`${lang}-reading.json`),JSON.stringify({paused,stable,draft,reopened,warning},null,2));
  if(red){check(warning.includes(refusal),'original named refusal');check(reopened.bookmark.selection.part===null,'RED loses selection');}
  else{check(Math.abs(reopened.display-paused.display)<1e-7,'actual inspection time restored');check(JSON.stringify(reopened.bookmark.selection.part)===JSON.stringify(draft.bookmark.selection.part),'slot identity restored');check(JSON.stringify(reopened.bookmark.view)===JSON.stringify(draft.bookmark.view),'canonical camera restored');check(!reopened.playing,'restores paused');}
  await writeFile(join(out,`${lang}-reopened.png`),await page.screenshot());
  // Explicit source-bound URL and a deliberately out-of-domain supplied bookmark. No modulo/clamp allowed.
  await page.goto(url.split('#')[0]+encodeBookmark(draft.bookmark));await wait('window.__bookmarkReading?.()&&!window.__bookmarkReading().restoring');
  const linked=await read();if(!red)check(Math.abs(linked.display-paused.display)<1e-7&&linked.bookmark.selection.part?.slot==='lantern','URL restores bounded inspection');
  const invalid={...draft.bookmark,time:9};
  await page.goto(url.split('#')[0]+encodeBookmark(invalid));await wait('window.__bookmarkReading?.()&&!window.__bookmarkReading().restoring');
  check((await page.evaluate<string>('document.body.innerText')).includes(refusal),'invalid supplied domain still named-refuses');
  rows.push({lang,paused,stable,saved:draft,pagehide:hiddenDraft,href:saved.href,reopened,linked,invalidTime:9,invalidRefused:true});
  await page.evaluate('for(const [k] of '+drafts+')localStorage.removeItem(k)');
 }
 const after=await hashes();check(JSON.stringify(before)===JSON.stringify(after),'source bytes unchanged');
 await writeFile(join(out,'report.json'),JSON.stringify({mode:red?'RED':'GREEN',browser:await page.evaluate('navigator.userAgent'),bun:Bun.version,play:JSON.parse(await readFile('node_modules/@rig-c/play/package.json','utf8')).version,before,after,rows},null,2));
 console.log(JSON.stringify({mode:red?'RED diagnostic':'GREEN',languages:rows.map(r=>({lang:r.lang,display:r.paused.display,runtime:r.paused.runtime,saved:r.saved.bookmark.time,reopened:r.reopened.display})),sourceUnchanged:true}));
}finally{await page.close();proxy.stop(true);server.stop(true);}
