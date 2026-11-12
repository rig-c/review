import {tmpdir} from 'node:os';
/** #796 ordinary Nova: actual shared-screen restoration of a Setup draft then animation scrub.
 * --expect-refusal is a diagnostic for the frozen pre-fix main tree, never candidate acceptance. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {scriptedJobWindowFixture} from './helpers/job-window-fixture.ts';
import {launchCdpSession,type InputCdpSession} from './parts-explorer-browser.ts';
const index=Bun.argv.indexOf('--out'),out=resolve(index<0?'artifacts/setup-screen-796':Bun.argv[index+1]!);await mkdir(out,{recursive:true});
const fixture=await scriptedJobWindowFixture();let page:InputCdpSession|undefined;let command:((method:string,params?:Record<string,unknown>)=>Promise<unknown>)|undefined;
const profile=await mkdtemp(join(tmpdir(),'review796-setup-'));const errors:unknown[]=[];
async function wait(expression:string){const end=Date.now()+20000;while(Date.now()<end){if(await page!.evaluate(expression))return;await Bun.sleep(25);}throw new Error('SETUP_SCREEN_WAIT '+expression);}
try{
 const publication=await fixture.publish('rig');await fixture.ask(publication,{kind:'review-verdict',stage:'rig-review'});
 page=await launchCdpSession(profile,{sendDeadlineMs:10000,onEvent(event,send){command=send;if(event.method==='Runtime.exceptionThrown')errors.push(event.params);}});await page.setViewport(1600,1000);await page.goto(fixture.host.ownerUrl);
 await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')`);
 await page.evaluate(`document.querySelector('#zoom-in').click()`);
 await wait(`Object.keys(localStorage).some(key=>key.startsWith('rig-review-draft/1:'))`);
 // A declared, source-bound Setup draft exercises the same restore path as an existing owner bookmark.
 const seeded=await page.evaluate<[string,string]>(`(()=>{const key=Object.keys(localStorage).find(key=>key.startsWith('rig-review-draft/1:'));const draft=JSON.parse(localStorage.getItem(key));draft.bookmark.animation=null;draft.bookmark.time=${Bun.argv.includes('--numeric-time')?'0':'null'};draft.bookmark.selection.axis=null;draft.inputs['animation-select']={value:''};return [key,JSON.stringify(draft)];})()`);
 await command!('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.origin===${JSON.stringify(new URL(fixture.host.ownerUrl).origin)})localStorage.setItem(${JSON.stringify(seeded[0])},${JSON.stringify(seeded[1])});`});
 await page.goto('about:blank');await page.goto(fixture.host.ownerUrl);
 await wait(`document.body.dataset.ready==='true'&&!!document.querySelector('#rig-root canvas')`);
 assert.equal(await page.evaluate(`document.querySelector('#animation-select').value`),'','Setup draft restored before probing');
 await page.evaluate(`(()=>{const n=document.querySelector('#animation-select');n.value='inspect';n.dispatchEvent(new Event('change',{bubbles:true}));const scrub=document.querySelector('#scrub');scrub.value='.375';scrub.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await Bun.sleep(150);
 const state:any=await page.evaluate(`({message:document.querySelector('#message').textContent,time:document.querySelector('#scrub').value,clock:document.querySelector('#time-label').textContent,source:document.querySelector('#source-hash').textContent})`);
 const refused=state.message.includes('seek is defined for a single animation');
 await writeFile(join(out,'observations.json'),JSON.stringify({fixture:'synthetic source-bound owner draft; real shared screen',sourceHash:publication.source.sourceHash,expectedRefusal:Bun.argv.includes('--expect-refusal'),refused,state,errors},null,2));await writeFile(join(out,'screen.png'),await page.screenshot());
 assert.equal(refused,Bun.argv.includes('--expect-refusal'));assert.deepEqual(errors,[]);
 if(!refused)assert.ok(Math.abs(Number(state.time)-.375)<.001);
}finally{await page?.close();await fixture.close();await rm(profile,{recursive:true,force:true});}
