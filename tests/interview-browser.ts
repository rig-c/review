/** Bounded Nova harness. Inputs come from pinned create's generator and public writers. */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { setSystemTime } from 'bun:test';
import { digest, readProject } from '../src/interview-project.ts';
import { startInterviewServer } from '../src/interview-server.ts';
import { launchCdpSession } from './parts-explorer-browser.ts';

/** One sequential CDP worker over disposable writer-archive copies. */
async function sceneContextMode(destination: string | undefined) {
  if (!destination) throw new Error('Supply --scene-context <fresh evidence directory>');
  const evidence = resolve(destination), fixtureDirectory = join(import.meta.dir, 'fixtures/scene-interview-551');
  await mkdir(evidence);
  const testClock = '2026-11-15T11:03:00.000Z';
  const provenance = JSON.parse(await readFile(join(fixtureDirectory, 'provenance.json'), 'utf8'));
  const archiveHashes: Record<string, string> = {};
  const receipt = {clock: {kind: 'labelled-test-clock', at: testClock, scope: 'Bun server currentness'},
    browserWorkers: 1, cases: [] as unknown[], children: [] as unknown[], screenshots: [] as unknown[], archiveHashes, error: ''};
  const profile = join(evidence, 'browser-profile');
  let browser: Awaited<ReturnType<typeof launchCdpSession>> | undefined;
  const hashes = async (root: string) => {
    const entries = await readdir(root, {recursive: true, withFileTypes: true});
    const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
    return Object.fromEntries(await Promise.all(files.map(async file => [file.slice(root.length + 1), digest(await readFile(file))])));
  };
  const waitFor = async (expression: string) => {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await browser!.evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Scene browser condition unavailable: ' + expression);
  };
  try {
    setSystemTime(new Date(testClock));
    browser = await launchCdpSession(profile);
    await browser.setViewport(1360, 950);
    const {t} = await import('../web/i18n.ts');
    for (const [name, archive] of [['current', 'writer-current'], ['history', 'writer-history'],
      ['legacy', 'writer-current'], ['issue', 'writer-history']]) {
      const archivePath = join(fixtureDirectory, archive + '.tar.gz');
      archiveHashes[archive] = digest(await readFile(archivePath));
      assert.equal(archiveHashes[archive], provenance.archives[archive + '.tar.gz']);
      const root = join(evidence, name); await mkdir(root);
      const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', root], {encoding: 'utf8'});
      receipt.children.push({command: ['tar', '-xzf', archivePath, '-C', root], exit: extracted.status,
        signal: extracted.signal, stdout: extracted.stdout, stderr: extracted.stderr, error: extracted.error?.message});
      assert.equal(extracted.status, 0, extracted.stderr);
      const pristine = await hashes(root), originals = new Map<string, Buffer>();
      const replace = async (path: string, bytes: Buffer | string) => {
        if (!originals.has(path)) originals.set(path, await readFile(join(root, path)));
        await writeFile(join(root, path), bytes);
      };
      let server: Awaited<ReturnType<typeof startInterviewServer>> | undefined, frozen = pristine;
      try {
        const project = JSON.parse(await readFile(join(root, 'project.json'), 'utf8'));
        const item = project.interview.post.items.find((entry: {id: string}) => entry.id === 'post_composition');
        if (name === 'legacy') {
          // SYNTHETIC UNIT CONTROL, matching legacy() in scene-interview-551.test.ts.
          const since = Date.parse('2026-11-08T00:00:00Z'), at = since - 5000;
          project.reopens[0].at = new Date(since - 10000).toISOString();
          const version = {...structuredClone(project.versions[0]), n: 3, at: new Date(at).toISOString(),
            verdicts: [{review: 'rig-review', by: 'synthetic-control', at: new Date(at + 1).toISOString(), verdict: 'accepted'}]};
          project.versions.push(version);
          const signature = structuredClone(project.signoffs.find((entry: {stage: string}) => entry.stage === 'rig-review'));
          signature.at = new Date(at + 2).toISOString();
          signature.target = {...signature.target, version: 3, verdict: `versions[${project.versions.length - 1}].verdicts[0]`,
            review_package: {...signature.target.review_package, path: `versions[${project.versions.length - 1}].review_package`}};
          project.signoffs.push(signature);
          const path = item.pending_options.path, set = JSON.parse(await readFile(join(root, path), 'utf8'));
          set.drafted_at = new Date(since - 1).toISOString();
          const bytes = JSON.stringify(set, null, 2) + '\n';
          await replace(path, bytes); item.pending_options = {path, sha256: digest(bytes)};
          await replace('project.json', JSON.stringify(project, null, 2) + '\n');
        }
        if (name === 'issue') {
          // SYNTHETIC UNIT CONTROL, matching historicalOnly + malformed-scene unit case.
          delete item.pending_options;
          item.history = item.history.filter((answer: {choice?: {set?: {path?: string}}}) => answer.choice?.set?.path === 'evidence/interview/review551-scene-current.json');
          item.guide = {by: 'synthetic-control', at: testClock, verbatim: 'Original replacement text\n한글'};
          await replace('project.json', JSON.stringify(project, null, 2) + '\n');
          await replace('evidence/scene/s1.json', '{}');
        }
        const opened = readProject(root);
        const question = opened.questions.find(entry => entry.set.id === 'review551-scene-current')!;
        assert(question); assert.equal(question.editable, name === 'current' || name === 'legacy');
        if (name === 'legacy') assert(opened.diagnostics.some(entry => entry.code === 'INTERVIEW_OPTIONS_SCENE_LEGACY'));
        if (name === 'issue') assert(opened.diagnostics.some(entry => entry.code === 'INTERVIEW_OPTIONS_STALE' && entry.record.includes('.history[')));
        await mkdir(join(root, 'scratch/review-picks'), {recursive: true});
        frozen = await hashes(root);
        server = await startInterviewServer(root, 'scratch/review-picks', 0);
        for (const language of ['en', 'ko'] as const) {
          const url = new URL(server.url); url.searchParams.set('lang', language);
          await browser.goto(url.href);
          // #708: the interview modal's question list replaces the set picker.
          await waitFor('!!document.querySelector("dialog.interview-modal[open] .interview-question")');
          const selected: number = await browser.evaluate<number>(`(()=>{const items=[...document.querySelectorAll('.interview-question')];const index=items.findIndex(item=>item.textContent.includes(' · review551-scene-current'));items[index]?.click();return index;})()`);
          assert(selected >= 0);
          assert.equal(await browser.evaluate('document.documentElement.lang'), language);
          assert.equal(await browser.evaluate('document.querySelector("form > fieldset").disabled'), !question.editable);
          assert((await browser.evaluate<string>('document.querySelector("form code").textContent')).includes(question.ref.sha256));
          if (question.answer) {
            assert(await browser.evaluate(`[...document.querySelectorAll('form pre')].some(node=>node.textContent===${JSON.stringify(question.answer.verbatim)})`));
            assert((await browser.evaluate<string>('document.querySelector("form").textContent')).includes(String(question.answer.at)));
          }
          if (name === 'legacy' || name === 'issue') {
            const key = name === 'legacy' ? 'INTERVIEW_OPTIONS_SCENE_LEGACY' : 'interview.historicalIssue';
            assert((await browser.evaluate<string>('document.querySelector(".interview-diagnostics").textContent')).includes(t(key, undefined, language)));
          }
          if (name === 'current') assert(question.images.length > 0);
          for (const image of question.images) {
            await browser.evaluate(`[...document.querySelectorAll('aside button')].find(button=>button.textContent===${JSON.stringify(image.name)}).click()`);
            await waitFor('document.querySelector("aside img")?.naturalWidth > 0');
            const source: string = await browser.evaluate<string>('document.querySelector("aside img").src');
            assert.equal(digest(Buffer.from(await (await fetch(source)).arrayBuffer())), image.ref.sha256);
          }
          const screenshot = `scene-${name}-${language}.png`, bytes = await browser.screenshot();
          await writeFile(join(evidence, screenshot), bytes);
          receipt.screenshots.push({name, language, path: screenshot, sha256: digest(bytes)});
        }
      } finally {
        server?.stop();
        const after = await hashes(root);
        for (const [path, bytes] of originals) await writeFile(join(root, path), bytes);
        const restored = await hashes(root);
        receipt.cases.push({name, synthetic: name === 'legacy' || name === 'issue', pristine, frozen, after, restored});
        assert.deepEqual(after, frozen); assert.deepEqual(restored, pristine);
      }
      assert.equal(digest(await readFile(archivePath)), archiveHashes[archive]);
    }
  } catch (error) {receipt.error = String(error); throw error;}
  finally {
    try {await browser?.close();}
    finally {
      setSystemTime(); await rm(profile, {recursive: true, force: true});
      await writeFile(join(evidence, 'scene-context-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    }
  }
}

if (process.argv[2] === '--scene-context') {
  await sceneContextMode(process.argv[3]);
} else {
const [historyRoot, liveRoot, artifacts] = process.argv.slice(2);
if (!historyRoot || !liveRoot || !artifacts) throw Error('Supply generated history, registered live project and evidence directory');
const out = 'scratch/review-picks';
const seal = async (root: string) => {
  const paths = (await readdir(root,{recursive:true,withFileTypes:true})).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath,entry.name)).filter(path => !path.startsWith(join(root,out) + '/')).sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path.slice(root.length + 1),digest(await readFile(path))])));
};
const histories = await seal(historyRoot), liveInputs = await seal(liveRoot);
const capturedAt = '2026-11-15T11:03:00.000Z';
setSystemTime(new Date(capturedAt));
await mkdir(artifacts,{recursive:true});
const profile = await mkdtemp(join(tmpdir(),'iv368-'));
const browser = await launchCdpSession(join(profile,'p'));
const servers: Awaited<ReturnType<typeof startInterviewServer>>[] = [];
const until = async (expression: string) => {
  for (let i = 0; i < 180; i++) {
    if (await browser.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve,50));
  }
  throw Error('Interview browser condition unavailable: ' + expression);
};
let navigation = 0;
const navigate = async (launch: string, lang: string, setId: string) => {
  const url = new URL(launch); url.searchParams.set('lang',lang);
  url.searchParams.set('visit',String(++navigation));
  await browser.goto(url.href);
  await until('!!document.querySelector("dialog.interview-modal[open] .interview-question")');
  await browser.evaluate(`[...document.querySelectorAll('.interview-question')].find(item=>item.textContent.includes(${JSON.stringify(' · ' + setId)})).click()`);
  await until('document.querySelector("aside img")?.naturalWidth > 0');
};
const selectTorso = async () => {
  await browser.evaluate(`[...document.querySelectorAll('aside button')].find(button=>button.textContent==='torso').click()`);
  await until('document.querySelector("aside img[alt=torso]")?.naturalWidth > 0');
};
const readSet = async (root: string, id: string) => {
  const bytes = await readFile(join(root,'evidence/interview',id+'.json'));
  return {snapshot:JSON.parse(bytes.toString('utf8')),sha256:digest(bytes)};
};
const verifyOptions = async (root: string, id: string) => {
  const {snapshot,sha256} = await readSet(root,id);
  const actual = await browser.evaluate(`[...document.querySelectorAll('fieldset fieldset')].map(group=>[...group.querySelectorAll('label.interview-option')].map(label=>({
    id:label.querySelector('input').value,label:label.querySelector('strong').textContent,effect:label.querySelector('span').textContent,
    reason:label.querySelector('b')?label.querySelectorAll('span')[1].textContent:null
  })))`);
  assert.deepEqual(actual,snapshot.asks.map((ask:{options:{id:string;label:string;effect:string;reason?:string}[]}) =>
    ask.options.map(option => ({id:option.id,label:option.label,effect:option.effect,reason:option.reason??null}))));
  const provenance = await browser.evaluate<string>('document.querySelector("form > p").textContent');
  assert(provenance.includes(snapshot.drafted_by) && provenance.includes(snapshot.drafted_at));
  assert((await browser.evaluate<string>('document.querySelector("form code").textContent')).includes(sha256));
  return {sha256, asks:snapshot.asks.length};
};
const results: unknown[] = [];
try {
  const {snapshot:historySet,sha256:historySha} = await readSet(historyRoot,'example-bones');
  const project = JSON.parse(await readFile(join(historyRoot,'project.json'),'utf8'));
  const historical = project.interview.waypoints.find((item:{id:string})=>item.id==='bones').guide.choice;
  const stale = {schema:'rig-review/interview-picks@1',set:historical.set,
    picks:historySet.asks.map((ask:{id:string})=>({ask:ask.id,option_id:'alternative'})),
    note:'Stale review output must not appear',by:'user',at:capturedAt};
  await writeFile(join(historyRoot,out,historySha+'.json'),JSON.stringify(stale),{flag:'wx'});
  const history = await startInterviewServer(historyRoot,out,0);
  const live = await startInterviewServer(liveRoot,out,0);
  servers.push(history,live);
  await browser.setViewport(1360,950);
  for (const lang of ['en','ko']) {
    await navigate(history.url,lang,'example-bones');
    assert.deepEqual(await browser.evaluate('[...document.querySelectorAll("input:checked")].map(radio=>radio.value)'),
      historical.picks.map((pick:{option_id:string})=>pick.option_id));
    assert.equal(await browser.evaluate('document.querySelector("form > fieldset > label > textarea").value'),historical.note??'');
    assert.equal(await browser.evaluate('document.querySelector("form [role=status]").textContent'),
      lang==='en'?'Historical answer':'이전 답변');
    const options = await verifyOptions(historyRoot,'example-bones');
    const names = await browser.evaluate<string[]>('[...document.querySelectorAll("aside button")].map(button=>button.textContent)');
    const {snapshot} = await readSet(historyRoot,'example-bones');
    const parts = snapshot.context.parts as {path:string;files:{path:string;sha256:string}[]};
    const manifestPath = parts.path + '/parts.json';
    const manifestBytes = await readFile(join(historyRoot,manifestPath));
    assert.equal(digest(manifestBytes),parts.files.find(file=>file.path===manifestPath)?.sha256);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {parts:{name:string;w:number;h:number}[]};
    assert.deepEqual(names,manifest.parts.map(part=>part.name));
    const images = [];
    for (const {name,w,h} of manifest.parts) {
      await browser.evaluate(`[...document.querySelectorAll('aside button')].find(button=>button.textContent===${JSON.stringify(name)}).click()`);
      await until('document.querySelector("aside img")?.naturalWidth > 0');
      const src = await browser.evaluate<string>('document.querySelector("aside img").src');
      const served = digest(Buffer.from(await (await fetch(src)).arrayBuffer()));
      const partPath = parts.path + '/parts/' + name + '.png';
      assert.equal(served,parts.files.find(file=>file.path===partPath)?.sha256);
      assert.equal(served,digest(await readFile(join(historyRoot,partPath))));
      const size = await browser.evaluate<number[]>('(()=>{const img=document.querySelector("aside img");return [img.naturalWidth,img.naturalHeight];})()');
      assert.deepEqual(size,[w,h]);
      images.push({name,sha256:served,width:w,height:h});
    }
    assert.equal(await browser.evaluate('document.documentElement.lang'),lang);
    assert.equal(await browser.evaluate('document.querySelector(".interview-option b").textContent'),lang==='en'?'AI recommendation':'AI 추천');
    await selectTorso();
    await writeFile(join(artifacts,'historical-parts-'+lang+'.png'),await browser.screenshot());
    await navigate(history.url,lang,'example-reference');
    assert.equal(await browser.evaluate('document.querySelectorAll("aside button").length'),1);
    assert.equal(await browser.evaluate('document.querySelector("aside p").textContent'),lang==='en'?'This set has no bound separated parts.':'이 세트에 바인딩된 분리 파츠가 없습니다.');
    await writeFile(join(artifacts,'direction-source-'+lang+'.png'),await browser.screenshot());
    results.push({lang, ...options,images});
  }
  const liveCases = [{id:'live-bones',kind:'other',lang:'en'}, {id:'live-motion',kind:'auto',lang:'ko'}];
  const words = '다른 방향\nKeep the final spaces.  \ne\u0301';
  const note = 'note  \n끝';
  const expectedOutputs: string[] = [];
  for (const {id,kind,lang} of liveCases) {
    await navigate(live.url,lang,id);
    const {sha256} = await verifyOptions(liveRoot,id);
    assert.equal(await browser.evaluate('document.querySelectorAll("input:checked").length'),0);
    await browser.evaluate('document.querySelector("button[type=submit]").click()');
    assert.deepEqual(await readdir(join(liveRoot,out)),expectedOutputs);
    await browser.evaluate(`(()=>{
      const RealDate=Date;globalThis.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[${JSON.stringify(capturedAt)}]));}static now(){return Date.parse(${JSON.stringify(capturedAt)});}};
      const groups=[...document.querySelectorAll('fieldset fieldset')];
      groups.forEach((group,index)=>group.querySelector('input[value="'+(index===0?${JSON.stringify(kind)}:'keep')+'"]').click());
      const edit=(field,value)=>{field.value=value;field.dispatchEvent(new Event('input'));};
      if(${JSON.stringify(kind)}==='other')edit(groups[0].querySelector('textarea'),${JSON.stringify(words)});
      edit(document.querySelector('form > fieldset > label > textarea'),${JSON.stringify(note)});
      document.querySelector('button[type=submit]').click();
    })()`);
    await until('document.querySelector("form [role=status]").textContent.includes(' + JSON.stringify(lang==='en'?'Picks saved.':'선택 기록을 저장했습니다.') + ')');
    const filename = sha256 + '.json';
    expectedOutputs.push(filename);
    const saved = JSON.parse(await readFile(join(liveRoot,out,filename),'utf8'));
    assert.equal(saved.schema,'rig-review/interview-picks@1');
    assert.equal(saved.picks[0].option_id,kind);
    assert.equal(saved.picks[0].other_text,kind==='other'?words:undefined);
    assert.equal(saved.note,note);
    assert.equal(saved.at,capturedAt);
    await navigate(live.url,lang,id);
    assert.equal(await browser.evaluate('document.querySelector("input:checked").value'),kind);
    assert.equal(await browser.evaluate('document.querySelector("form > fieldset > label > textarea").value'),note);
    await selectTorso();
    await writeFile(join(artifacts,'live-'+kind+'-'+lang+'.png'),await browser.screenshot());
    const status = 'document.querySelector("form [role=status]").textContent';
    const savedLabel = lang==='en'?'Picks saved.':'선택 기록을 저장했습니다.';
    const unsavedLabel = lang==='en'?'Unsaved changes.':'저장하지 않은 변경 사항이 있습니다.';
    const edit = (selector:string,value:string) => browser.evaluate(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input'));})()`);
    const noteField = 'form > fieldset > label > textarea';
    assert.equal(await browser.evaluate(status),savedLabel);
    await browser.evaluate(`document.querySelector('fieldset fieldset input[value="alternative"]').click()`);
    assert.equal(await browser.evaluate(status),unsavedLabel);
    if (kind==='other') {
      await navigate(live.url,lang,id);
      assert.equal(await browser.evaluate(status),savedLabel);
      await edit('fieldset fieldset textarea',words+' edited');
      assert.equal(await browser.evaluate(status),unsavedLabel);
      await browser.evaluate('document.querySelector("form [role=status]").scrollIntoView({block:"center"})');
      await writeFile(join(artifacts,'unsaved-other-en.png'),await browser.screenshot());
    }
    await navigate(live.url,lang,id);
    assert.equal(await browser.evaluate(status),savedLabel);
    await edit(noteField,note+' edited');
    assert.equal(await browser.evaluate(status),unsavedLabel);
    await selectTorso();
    await browser.evaluate(`(()=>{const field=document.querySelector('header select');field.value=${JSON.stringify(lang==='en'?'ko':'en')};field.dispatchEvent(new Event('change'));})()`);
    assert.equal(await browser.evaluate(status),lang==='en'?'저장하지 않은 변경 사항이 있습니다.':'Unsaved changes.');
    await browser.evaluate(`(()=>{const items=()=>[...document.querySelectorAll('.interview-question')];const previous=items().findIndex(item=>item.getAttribute('aria-current')==='true');items()[previous===0?1:0].click();items()[previous].click();})()`);
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(noteField)}).value`),note+' edited');
    assert.equal(await browser.evaluate(status),lang==='en'?'저장하지 않은 변경 사항이 있습니다.':'Unsaved changes.');
    await browser.evaluate(`(()=>{const field=document.querySelector('header select');field.value=${JSON.stringify(lang)};field.dispatchEvent(new Event('change'));})()`);
    await browser.evaluate('document.querySelector("form [role=status]").scrollIntoView({block:"center"})');
    await writeFile(join(artifacts,'unsaved-note-'+lang+'.png'),await browser.screenshot());
    assert.deepEqual(JSON.parse(await readFile(join(liveRoot,out,filename),'utf8')),saved);
    results.push({id,kind,lang,filename,saved,unsavedEditsVerified:true});
  }
  assert.deepEqual(await seal(historyRoot),histories);
  assert.deepEqual(await seal(liveRoot),liveInputs);
  await writeFile(join(artifacts,'report.json'),JSON.stringify({results,histories,liveInputs},null,2)+'\n');
  console.log('EN/KO fixture options, bound PNGs, explicit Other/Auto, reopen and immutable inputs passed');
} finally {
  await browser.close();
  for (const server of servers) server.stop();
  setSystemTime();
  await rm(profile,{recursive:true,force:true});
}

}
