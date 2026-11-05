/** #385 public/synthetic visual evidence; CI callers live in parts-classification.test.ts. */
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writePartsPackage} from './helpers/parts-package.ts';
import {loadPartsView,readVerdict} from '../src/parts-view.ts';
import {startPartsServer} from '../src/parts-server.ts';
import {launchCdpSession} from './parts-explorer-browser.ts';
const root=await mkdtemp(join(tmpdir(),'scope-')),profile=await mkdtemp(join(tmpdir(),'p')),out=resolve(process.env.PARTS_CHECK_SHOTS??'evidence/check-385');
await mkdir(out,{recursive:true});await writePartsPackage(root);
const fixture=await readFile(new URL('./fixtures/parts-check-385.json',import.meta.url));await writeFile(join(root,'check/check.json'),fixture);
const pkg=await loadPartsView(root),cap='e'.repeat(64),server=await startPartsServer(pkg,{port:0,capability:cap,exitOnClose:false}),page=await launchCdpSession(profile);
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),inputs=[...pkg.files,...pkg.flagFiles],before=await Promise.all(inputs.map(async f=>sha(await readFile(f.abs))));
const checks:any[]=[];function check(name:string,ok:boolean,actual?:unknown){checks.push({name,ok,actual});if(!ok)throw Error(name+' '+JSON.stringify(actual));}
async function wait(code:string){for(let i=0;i<200;i++){if(await page.evaluate(code))return;await Bun.sleep(25);}throw Error('WAIT '+code);}
const badges=`Object.fromEntries([...document.querySelectorAll('[data-pv-item]')].map(b=>[b.dataset.pvItem,b.querySelector('.pv-count').textContent]))`;
try{
 await page.setViewport(1440,1100);
 for(const lang of ['en','ko']){
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${cap}`);await wait(`document.body.dataset.ready==='true'`);
  const counts=await page.evaluate<any>(badges),expected=lang==='en'?{back_defect:'mesh 1 · check 0',back_control:'',front:'mesh 0 · check 1'}:{back_defect:'메시 1 · 체크 0',back_control:'',front:'메시 0 · 체크 1'};
  check(lang+' only part + mesh badges',JSON.stringify(counts)===JSON.stringify(expected),counts);
  await page.evaluate(`document.querySelector('[data-pv-item="front"]').click()`);
  const groups=await page.evaluate<any[]>(`[...document.querySelectorAll('[data-pv-category]')].map(n=>({kind:n.dataset.pvCategory,open:n.open,label:n.querySelector('summary').textContent,rows:n.querySelectorAll('[data-flag-id]').length}))`);
  check(lang+' collapsed part/pair/evidence groups',JSON.stringify(groups.map(g=>[g.kind,g.open,g.rows]))===JSON.stringify([['part',false,1],['pair',false,1],['evidence',false,4]]),groups);
  await writeFile(join(out,'collapsed-'+lang+'.png'),await page.screenshot());
  await page.evaluate(`document.querySelectorAll('[data-pv-category]>summary,[data-pv-root]>summary').forEach(s=>s.click())`);
  const rows=await page.evaluate<any[]>(`[...document.querySelectorAll('[data-flag-id]')].map(n=>({label:n.querySelector('.pv-flag-label').textContent,raw:n.querySelector('code')?.textContent,visible:n.querySelector('.pv-flag-label').getClientRects().length>0}))`);
  check(lang+' expanded rows are visible and preserve explicit subjects',rows.length===6&&rows.every(r=>r.visible)&&rows.some(r=>r.raw.includes('"part":"back_control"')&&r.raw.includes('"row_subjects":["front"]')),rows);
  await writeFile(join(out,'expanded-'+lang+'.png'),await page.screenshot());
  await page.evaluate(`document.querySelector('[data-pv-item="back_defect"]').click()`);
  check(lang+' pair shown on second explicit subject',await page.evaluate(`document.querySelector('[data-pv-category="pair"] [data-flag-id]')?.dataset.flagId==='check:UNKNOWN_ROOT.rows[2]'`));
  await page.evaluate(`document.querySelector('[data-pv-item="front"]').click();document.querySelector('input[data-pv-outcome][value="clean"]').click();document.getElementById('pv-save').click()`);
  await wait(`document.getElementById('pv-save-status').dataset.result==='saved'`);
  check(lang+' save keeps original IDs',JSON.stringify((await readVerdict(pkg)).verdict?.parts.front?.flags)==='[]');
 }
 // Pre-field legacy package: rows stay available but never count as classified findings.
 const legacy=await readFile(new URL('./fixtures/parts-check-380.json',import.meta.url));await writeFile(join(root,'check/check.json'),legacy);
 const old=await startPartsServer(await loadPartsView(root),{port:0,exitOnClose:false});
 try{for(const lang of ['en','ko']){
  await page.goto(`http://127.0.0.1:${old.port}/?lang=${lang}`);await wait(`document.body.dataset.ready==='true'`);
  check(lang+' legacy no fabricated check count',await page.evaluate(`document.querySelector('[data-pv-item="front"] .pv-count').textContent===''&&document.querySelector('[data-pv-category="unclassified"]')!==null`));
  await writeFile(join(out,'legacy-'+lang+'.png'),await page.screenshot());
 }}finally{old.stop(true);}
 // Restore before comparing original input bytes.
 await writeFile(join(root,'check/check.json'),fixture);
 check('all inspected source files unchanged',JSON.stringify(before)===JSON.stringify(await Promise.all(inputs.map(async f=>sha(await readFile(f.abs))))));
 await writeFile(join(out,'report.json'),JSON.stringify({pass:true,fixtureSha256:sha(fixture),checks},null,2)+'\n');console.log(JSON.stringify({pass:true,checks:checks.length}));
}catch(error){await writeFile(join(out,'failure.png'),await page.screenshot());await writeFile(join(out,'report.json'),JSON.stringify({pass:false,error:String(error),checks},null,2));throw error;}
finally{server.stop(true);await page.close();await rm(root,{recursive:true,force:true});await rm(profile,{recursive:true,force:true});}
