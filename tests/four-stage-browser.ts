/** #371 explicit Nova browser walk. Run with the pinned Create archive and producer bench. */
import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { digest } from '../src/interview-project.ts';
import { loadOpenPackage, openReview, type OpenInputs } from '../src/open.ts';
import { sessionFile } from '../src/session.ts';
import { resolveProducer } from '../src/producer.ts';
import { patchId, rebuildDir } from '../src/rebuild.ts';
import { patchText } from '../src/config-patch.ts';
import { enCatalog } from '../web/catalog-en.ts';
import { koCatalog } from '../web/catalog-ko.ts';
import { inventory, materializeFourStages } from './helpers/four-stage-fixture.ts';
import { walkCheckpoint, WalkDeadlineError, withDeadline } from './helpers/walk-deadline.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';

const archive = process.env.REVIEW_371_CREATE_ARCHIVE;
const outputDirectory = process.env.REVIEW_371_OUTPUT;
const benchDirectory = process.env.REVIEW_371_CREATE_BENCH;
const language = process.env.REVIEW_371_LANGUAGE;
assert(language === undefined || language === 'en' || language === 'ko', 'REVIEW_371_LANGUAGE must be en or ko');
const languages: readonly Language[] = language === undefined ? ['en','ko'] : [language];
assert(archive && outputDirectory && benchDirectory, 'Set REVIEW_371_CREATE_ARCHIVE, REVIEW_371_OUTPUT and REVIEW_371_CREATE_BENCH');
const output = resolve(outputDirectory);
await mkdir(output);
const checkpoint = walkCheckpoint(join(output, 'walk-checkpoints.jsonl'));
checkpoint('prepare.fixture');
const scratch = await mkdtemp(join(tmpdir(), 'review371-'));
const fixture = await materializeFourStages(archive, join(scratch, 'upstream'));
const bench = resolve(benchDirectory);
for (const file of ['package.json', 'bun.lock']) {
  assert.deepEqual(await readFile(join(bench, file)), await readFile(join(fixture.create, file)), 'CREATE_BENCH_LOCK');
}
const cli = resolve('src/cli.ts');
const createCli = join(fixture.create, 'src/cli.ts');
const {symlink} = await import('node:fs/promises');
await symlink(join(bench, 'node_modules'), join(fixture.create, 'node_modules'), 'dir');
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const put = (name: string, value: unknown) => writeFile(join(output, name + '.json'), json(value));
const write = (name: string, value: string | Uint8Array) => writeFile(join(output, name), value);
const parts = await import(join(fixture.create, 'src/parts-verdict.ts'));
const choices = await import(join(fixture.create, 'src/choices.ts'));
const {collectItems} = await import(join(fixture.create, 'src/check.ts'));
const chain = join(fixture.create, 'templates/example-chain');
const frame = "document.querySelector('.review-stage-panel iframe:not([hidden]):not(.review-interview-frame)')";
const interview = "document.querySelector('.review-interview-frame:not([hidden])')";
const interviewNote = JSON.stringify('form > fieldset > label > textarea');
const interviewDom = `(()=>{
  const iframe=${interview},d=iframe?.contentDocument;
  if(!d)return null;
  const note=d.querySelector(${interviewNote}),submit=d.querySelector('form button[type=submit]');
  return {
    path:new URL(iframe.src).pathname,
    status:d.querySelector('form [role=status]')?.textContent??null,
    note:note?{value:note.value,visible:!!note.getClientRects().length,insideAsk:!!note.closest('fieldset fieldset')}:null,
    submit:submit?{disabled:submit.matches(':disabled'),visible:!!submit.getClientRects().length}:null,
    selected:[...d.querySelectorAll('form input[type=radio]:checked')].map(input=>({ask:input.name,option_id:input.value}))
  };
})()`;
type PicksExchange = {request:string; response?:{status:number; body:string}; error?:string};
type FailedSubmitExchange = {
  method:'PUT'; request:string|null; settled:boolean; error?:string;
  response?:{status:number; body:string|null; readError?:string};
};
type FailedSubmitSnapshot = {exchanges:FailedSubmitExchange[]; message:string|null; saveDisabled:boolean|null};
const actionGuard = `function action(element, selector) {
  const refuse = reason => { throw Error('FOUR_STAGE_ACTION_TARGET: ' + selector + ' (' + reason + ')'); };
  if (!element) refuse('missing');
  if (!element.isConnected) refuse('detached');
  if (element.matches(':disabled') || element.closest('[aria-disabled=true]')) refuse('disabled');
  if (element.closest('[hidden], [inert]')) refuse('hidden or inert ancestor');
  const view = element.ownerDocument.defaultView;
  if (!view) refuse('document window missing');
  for (let current=element;current;current=current.parentElement) {
    const style=view.getComputedStyle(current);
    if (style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse') refuse('computed hidden');
  }
  if (![...element.getClientRects()].some(rect=>rect.width>0&&rect.height>0)) refuse('empty rectangle');
  return element;
}`;

type Language = 'en' | 'ko';

// An in-process open has no cancellation contract. End the walk before it can start more work.
// Nova owns descendant cleanup and collects the already flushed evidence.
function terminalDeadline(key: string, error: WalkDeadlineError): never {
  try {
    writeSync(2, error.message + '\n');
    checkpoint(key + '.deadline');
  } finally {
    process.exit(1);
  }
}

async function command(name: string, args: string[], refusal?: RegExp) {
  checkpoint(name + '.command');
  const child = Bun.spawn([process.execPath, ...args], {cwd: bench, stdout: 'pipe', stderr: 'pipe'});
  const [stdout, stderr, exit] = await withDeadline(name + '.command', 30000,
    () => Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]))
    .catch(async error => {
      if (!(error instanceof WalkDeadlineError)) throw error;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await withDeadline(name + '.reap', 5000, () => child.exited).catch(reapError => {
        if (reapError instanceof WalkDeadlineError) terminalDeadline(name + '.reap', reapError);
        throw reapError;
      });
      throw error;
    });
  await put(name + '-command', {args, exit, stderr});
  await write(name + '.stdout', stdout);
  if (refusal) {
    assert.notEqual(exit, 0, name);
    assert.match(stderr + stdout, refusal, name);
  } else assert.equal(exit, 0, stderr);
  return stdout;
}
const create = (name: string, args: string[], refusal?: RegExp) => command(name, [createCli, ...args], refusal);

async function wait<T>(readValue: (signal: AbortSignal) => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 15000) {
  let value: T | undefined;
  try {
    return await withDeadline(label, timeout, async signal => {
      while (true) {
        signal.throwIfAborted();
        value = await readValue(signal);
        signal.throwIfAborted();
        if (ready(value)) return value;
        await Bun.sleep(100);
      }
    });
  } catch (error) {
    if (error instanceof WalkDeadlineError) await put(label + '-timeout', value ?? null);
    throw error;
  }
}

function fetchBody<T>(key: string, url: URL, readBody: (response: Response) => Promise<T>, init?: RequestInit) {
  return withDeadline(key, 15000, async signal => {
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
    return await readBody(await fetch(url, {...init, signal:requestSignal}));
  });
}

async function click(page: InputCdpSession, selector: string, iframe?: string) {
  const point = await page.evaluate<{x: number; y: number}>(`(()=>{
    ${actionGuard}
    const f=${iframe === undefined ? 'null' : `action(${iframe}, 'click iframe')`};
    const d=f?f.contentDocument:document;
    const button=action(d?.querySelector(${JSON.stringify(selector)}),${JSON.stringify(selector)});
    button.scrollIntoView({block:'nearest'});
    const r=button.getBoundingClientRect(),b=f?.getBoundingClientRect();
    const x=r.left+r.width/2,y=r.top+r.height/2;
    if(!r.width||!r.height||!button.contains(d.elementFromPoint(x,y)))throw Error('FOUR_STAGE_ACTION_TARGET: '+${JSON.stringify(selector)}+' (obscured)');
    return {x:x+(b?b.left+f.clientLeft:0),y:y+(b?b.top+f.clientTop:0)};
  })()`);
  await page.mouse('mouseMoved', point.x, point.y);
  await page.mouse('mousePressed', point.x, point.y);
  await page.mouse('mouseReleased', point.x, point.y);
}

function mutateOne(bytes: string, original: string, changed: string) {
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(changed));
  const index = bytes.indexOf(original);
  assert(index >= 0);
  const after = bytes.slice(0, index) + changed + bytes.slice(index + original.length);
  const a = Buffer.from(bytes), b = Buffer.from(after);
  assert.equal(a.length, b.length);
  assert.equal(a.reduce((count, byte, at) => count + Number(byte !== b[at]), 0), 1);
  return after;
}
function flipHash(bytes: string, key: string, hash: string) {
  const match = bytes.match(new RegExp('"' + key + '"\\s*:\\s*"' + hash + '"'));
  assert(match);
  return mutateOne(bytes, match[0], match[0].replace(hash, (hash.startsWith('0') ? '1' : '0') + hash.slice(1)));
}

async function runLanguage(lang: Language, page: InputCdpSession) {
  const catalog = lang === 'en' ? enCatalog : koCatalog;
  const label = (name: string) => lang + '-' + name;
  const shot = async (name: string) => write(label(name) + '.png', await page.screenshot());
  const evaluate = <T>(expression: string) => page.evaluate<T>(expression);
  const until = (expression: string, name: string) => wait(() => evaluate<boolean>(expression), Boolean, label(name));
  const choose = (stage: number) => click(page, `[data-review-stage="${stage}"]`);
  const state = join(scratch, 'state-' + lang);
  const scratchCopies: {index: number; root: string; changes: Set<string>}[] = [];
  const frontPorts = new Map<string, number>();
  const mark = (name: string) => checkpoint(label(name));
  const open = async (name: string, inputs: OpenInputs, stateDir = state) => {
    const key = label(name + '.open');
    checkpoint(key);
    let frontPort = frontPorts.get(stateDir);
    if (frontPort === undefined) {
      const portProbe = Bun.serve({hostname:'127.0.0.1', port:0, fetch:() => new Response()});
      frontPort = portProbe.port!;
      portProbe.stop(true);
      frontPorts.set(stateDir, frontPort);
    }
    const opened = await withDeadline(key, 60000,
      () => openReview(inputs, {stateDir, cwd:bench, frontPort, idleMs:180000, graceMs:30000}))
      .catch(error => {
        if (error instanceof WalkDeadlineError) terminalDeadline(key, error);
        throw error;
      });
    assert.match(new URL(opened.url).pathname, /^\/instances\/[a-f0-9]{64}\/$/);
    return opened;
  };
  async function navigate(name: string, url: string) {
    mark(name + '.navigate');
    const destination = new URL(url);
    destination.searchParams.set('lang', lang);
    await page.goto(destination.href, lang);
    await until(`document.documentElement?.lang===${JSON.stringify(lang)} && !!document.querySelector('[data-review-stage="1"]')`, name + '.shell');
  }
  async function projectCopy(index: number, suffix = '') {
    const root = join(scratch, lang + '-' + fixture.stages[index]!.name + suffix);
    await fixture.stages[index]!.copy(root);
    await mkdir(join(root, 'gate-picks'));
    const changes = new Set<string>();
    scratchCopies.push({index, root, changes});
    return {root, changes};
  }
  const draft = (root: string, partsVerdictDir?: string): OpenInputs => ({
    input: join(root, 'derived/drafts/chain/out/check'),
    project: {root, draftId: 'chain', picksDir: 'gate-picks', ...(partsVerdictDir ? {partsVerdictDir} : {})},
  });
  const rig = (root: string, postVersion?: number): OpenInputs => ({
    input: join(root, 'derived/review/v1/out'),
    project: {root, version: 1, picksDir: 'gate-picks', ...(postVersion ? {postVersion} : {})},
  });
  async function feedback(input: OpenInputs, item: string, name: string, format: 'json' | 'issue') {
    const project = input.project!;
    const flags = ['--project', project.root, '--project-version', '1', '--picks-dir', project.picksDir];
    if (project.postVersion) flags.push('--post-version', String(project.postVersion));
    const entry = 'import {main} from '+JSON.stringify(cli)+'; await main(process.argv.slice(1),{stateDir:'+JSON.stringify(state)+'});';
    return command(label(name), ['-e', entry, '--', 'feedback', input.input, ...flags, '--correction', item, '--format', format]);
  }
  const parseIssue = (text: string) => {
    const block = text.match(/^(`{3,})json\n([\s\S]*?)\n\1$/m);
    assert(block, 'Expected exported issue JSON');
    return JSON.parse(block[2]!);
  };

  try {
    // Stage 1 starts with an empty designated verdict directory. Its Save is a Review verdict only.
    mark('stage1.copy');
    const first = await projectCopy(0);
    const verdictDirectory = join(first.root, 'gate-verdicts');
    await mkdir(verdictDirectory);
    const firstInput = draft(first.root, 'gate-verdicts');
    const firstOpen = await open('stage1', firstInput);
    await navigate('stage1', firstOpen.url);
    await until(`${frame}?.contentDocument?.body?.dataset.ready==='true'`, 'parts-ready');
    assert.deepEqual(await readdir(verdictDirectory), []);
    const partNote = lang === 'en' ? '  Inspect the torso seam.\nKeep the wording.  ' : '  몸통 이음새 확인.\n문구를 유지해 주세요.  ';
    const meshNote = lang === 'en' ? '  Torso mesh reviewed.  ' : '  몸통 메시를 확인했어요.  ';
    mark('stage1.edit-back-and-compare');
    await evaluate(`(()=>{
      ${actionGuard}
      const d=action(${frame},'parts iframe').contentDocument;
      if(!d)throw Error('FOUR_STAGE_ACTION_TARGET: parts iframe document (missing)');
      const field=selector=>action(d.querySelector(selector),selector);
      const partIds=[...d.querySelectorAll('[data-pv-item]')].map(item=>item.dataset.pvItem);
      for(const partId of partIds){
        // Selecting a part and changing its verdict each replace the list buttons.
        field('[data-pv-item="'+CSS.escape(partId)+'"]').click();
        field('[data-pv-outcome][value=clean]').click();
        const mesh=d.querySelector('#pv-mesh-panel select');
        if(mesh){
          action(mesh,'#pv-mesh-panel select').value='clean';
          mesh.dispatchEvent(new Event('change'));
        }
      }
      field('[data-pv-item=torso]').click();
      for(const [selector,value] of [['#pv-note',${JSON.stringify(partNote)}],['#pv-mesh-panel textarea',${JSON.stringify(meshNote)}]]){
        const note=field(selector);note.value=value;note.dispatchEvent(new Event('input'));
      }
      field('#pv-overall').value='approved';
    })()`);
    await choose(3);
    await choose(1);
    await until(`${frame}?.contentDocument?.querySelector('#pv-note')?.value===${JSON.stringify(partNote)}`, 'parts-back');
    assert.deepEqual(await readdir(verdictDirectory), []);
    assert.match(await evaluate<string>(`${frame}?.contentDocument?.querySelector('#pv-corrections')?.textContent??''`), /torso.*v 30 t 40/);
    await evaluate(`(()=>{
      const d=${frame}?.contentDocument;
      if(!d?.body)throw Error('FOUR_STAGE_ACTION_TARGET: parts Save observer document body (missing)');
      d.addEventListener('click',event=>{
        if(event.target?.id==='pv-save'&&d.body)d.body.dataset.trustedSave=String(event.isTrusted);
      },true);
    })()`);
    mark('stage1.save');
    await click(page, '#pv-save', frame);
    await until(`${frame}?.contentDocument?.querySelector('#pv-save-status')?.dataset.result==='saved'`, 'verdict-save');
    assert.equal(await evaluate(`${frame}?.contentDocument?.body?.dataset.trustedSave`), 'true');
    const files = await readdir(verdictDirectory);
    assert.equal(files.length, 1);
    const verdictPath = 'gate-verdicts/' + files[0];
    const verdictBytes = await readFile(join(first.root, verdictPath), 'utf8');
    const verdict = JSON.parse(verdictBytes);
    assert.equal(verdict.parts.torso.note, partNote);
    assert.equal(verdict.parts.torso.mesh.note, meshNote);
    mark('stage1.export');
    const exportedVerdict = await fetchBody(label('stage1.export'), new URL('api/stage-parts/export/json', firstOpen.url),
      async response => ({status:response.status, body:await response.text()}));
    assert.equal(exportedVerdict.status, 200);
    assert.equal(exportedVerdict.body, verdictBytes);
    await write(label('parts-verdict.json'), verdictBytes);
    await navigate('stage1.reopen', (await open('stage1.reopen', firstInput)).url);
    await until(`${frame}?.contentDocument?.body?.dataset.ready==='true'`, 'parts-reopen');
    await click(page, '[data-pv-item=torso]', frame);
    assert.equal(await evaluate(`${frame}?.contentDocument?.querySelector('#pv-note')?.value`), partNote);
    await shot('stage1');
    const checkVerdict = (root: string, path: string, bytes: string, findings: unknown[]) =>
      parts.checkPartsVerdict(root, {evidence:{kind:parts.PARTS_VERDICT_KIND, path, sha256:digest(bytes)}}, 'review-371', findings);
    const findings: unknown[] = [];
    assert.equal(checkVerdict(first.root, verdictPath, verdictBytes, findings), join(first.root, 'derived/drafts/chain/input/parts.json'));
    assert.deepEqual(findings, []);
    if (lang === 'en') {
      mark('stage1.plant');
      const negative = await projectCopy(0, '-mutant');
      await mkdir(join(negative.root, 'gate-verdicts'));
      const changed = flipHash(verdictBytes, 'sha256', verdict.source.sha256);
      await writeFile(join(negative.root, verdictPath), changed);
      await write('plant1-verdict.json', changed);
      const refusals: {code:string}[] = [];
      checkVerdict(negative.root, verdictPath, changed, refusals);
      await put('plant1-first', refusals);
      assert(refusals.some(row => row.code === 'PARTS_VERDICT_SOURCE_MISMATCH'));
    }

    // The existing Stage 2 signature continues to name its own declared verdict.
    mark('stage2.copy');
    const second = await projectCopy(1);
    const prior = await read(join(second.root, 'project.json'));
    const accepted = prior.signoffs.find((row: {stage:string}) => row.stage === 'parts-review');
    const oldFindings: unknown[] = [];
    assert(parts.checkPartsVerdict(second.root, accepted, 'existing-parts-signoff', oldFindings));
    assert.deepEqual(oldFindings, []);
    const declared = fixture.stages[1]!.declared.pending;
    const sequence = declared.commands.flatMap((command, index) => {
      const match = /^rig-create interview-answer ([a-z_]+) --set (evidence\/interview\/[a-z_]+\.json) /.exec(command);
      return match && declared.command_roles[index] === 'human' ? [{question:match[1]!, path:match[2]!}] : [];
    });
    assert.deepEqual(sequence.map(item => item.question), ['bones','meshes','constraints','motion']);
    for (const [index, item] of sequence.entries()) {
      if (index > 0) {
        mark('stage2.' + item.question + '.register');
        const previous = await loadOpenPackage(draft(second.root));
        assert(previous.mode === 'single' && previous.joined);
        const declaredSet = await read(join(chain, item.path));
        const project = await read(join(second.root, 'project.json'));
        declaredSet.context = choices.optionContext(project, 'rigging-interview', Date.now());
        declaredSet.drafted_at = new Date().toISOString();
        await writeFile(join(second.root, item.path), json(declaredSet));
        await create(label('register-' + item.question), ['interview-options', item.question, second.root, '--file', item.path]);
        await assert.rejects(previous.joined.assertCurrent(), /INTERVIEW_OPTIONS_STALE/);
      }
      const secondInput = draft(second.root);
      const opened = await open('stage2.' + item.question, secondInput);
      await navigate('stage2.' + item.question, opened.url);
      mark('stage2.' + item.question + '.picker');
      await choose(2);
      await until(`!!${interview}?.contentDocument?.querySelector('main select')`, 'options-' + item.question);
      const note = lang === 'en' ? '  Keep these choices.  ' : '  이 선택을 유지해 주세요.  ';
      await evaluate(`(()=>{
        ${actionGuard}
        const d=action(${interview},'interview iframe').contentDocument;
        if(!d)throw Error('FOUR_STAGE_ACTION_TARGET: interview iframe document (missing)');
        const s=action(d.querySelector('main select'),'interview set picker');
        const index=[...s.options].findIndex(o=>o.text.includes(${JSON.stringify('chain-' + item.question)}));
        if(index<0||s.options[index].disabled)throw Error('FOUR_STAGE_ACTION_TARGET: interview set option');
        s.selectedIndex=index;
        s.dispatchEvent(new Event('change'));
        const keep='form input[type=radio][value=keep]';
        const asks=[...d.querySelectorAll(keep)].map(choice=>choice.name);
        for(const ask of asks){
          const selector=keep+'[name="'+CSS.escape(ask)+'"]';
          action(d.querySelector(selector),selector).click();
        }
        const notes=d.querySelectorAll(${interviewNote}), note=action(notes[0],${interviewNote});
        if(notes.length!==1||note.closest('fieldset fieldset'))throw Error('FOUR_STAGE_ACTION_TARGET: expected exactly one form-level interview note');
        note.value=${JSON.stringify(note)};note.dispatchEvent(new Event('input'));
      })()`);
      const sha = digest(await readFile(join(second.root, item.path)));
      const picksPath = 'gate-picks/' + sha + '.json';
      await assert.rejects(readFile(join(second.root, picksPath)), {code:'ENOENT'});
      await evaluate(`(()=>{
        const child=${interview}?.contentWindow;
        if(!child)throw Error('FOUR_STAGE_ACTION_TARGET: interview Save observer window (missing)');
        const original=child.fetch;
        child.__gatePicksExchanges=[];
        child.fetch=async function(input,init){
          if(init?.method!=='POST'||!new URL(input,child.location.href).pathname.endsWith('/api/interview/picks'))return original.call(child,input,init);
          const exchange={request:init.body};
          child.__gatePicksExchanges.push(exchange);
          try {
            const response=await original.call(child,input,init);
            exchange.response={status:response.status,body:await response.clone().text()};
            return response;
          } catch(error) {
            exchange.error=String(error);
            throw error;
          }
        };
        child.__gateRestorePicksFetch=()=>{child.fetch=original;};
      })()`);
      const readPicksSave = () => evaluate<{dom:{status:string|null}|null; exchanges:PicksExchange[]}>(`({
        dom:${interviewDom}, exchanges:${interview}?.contentWindow?.__gatePicksExchanges??[]
      })`);
      try {
        mark('stage2.' + item.question + '.save');
        await click(page, 'form button[type=submit]', interview);
        const save = await wait(readPicksSave, result => result.exchanges.some(exchange => !!exchange.error ||
          (!!exchange.response && (exchange.response.status >= 400 || result.dom?.status === catalog['interview.saved']))),
        label('picks-' + item.question));
        assert.equal(save.exchanges.length, 1);
        assert.equal(save.exchanges[0]!.response?.status, 200);
        assert.equal(save.dom?.status, catalog['interview.saved']);
        const payload = JSON.parse(save.exchanges[0]!.request);
        assert.equal(payload.note, note);
        assert(payload.picks.every((pick: {option_id:string}) => pick.option_id === 'keep' && !('other_text' in pick)));
      } finally {
        await put(label('picks-' + item.question + '-save'), await readPicksSave().catch(() => null));
        await evaluate(`${interview}?.contentWindow?.__gateRestorePicksFetch?.()`);
      }
      await choose(1);
      await choose(2);
      await until(`!!${interview}?.contentDocument?.querySelector('main select')`, 'options-back-' + item.question);
      await navigate('stage2.' + item.question + '.reopen', (await open('stage2.' + item.question + '.reopen', secondInput)).url);
      await choose(2);
      await until(`!!${interview}?.contentDocument?.querySelector('main select')`, 'options-reopen-' + item.question);
      await evaluate(`(()=>{
        ${actionGuard}
        const d=action(${interview},'interview iframe').contentDocument;
        const select=action(d?.querySelector('main select'),'interview set picker');
        const index=[...select.options].findIndex(option=>option.text.includes(${JSON.stringify('chain-' + item.question)}));
        if(index<0||select.options[index].disabled)throw Error('FOUR_STAGE_ACTION_TARGET: interview set option');
        select.selectedIndex=index;
        select.dispatchEvent(new Event('change'));
      })()`);
      await until(`(()=>{
        const fields=${interview}?.contentDocument?.querySelectorAll(${interviewNote})??[], field=fields[0];
        if(fields.length!==1||field.closest('fieldset fieldset'))return false;
        ${actionGuard}
        return action(field,${interviewNote}).value===${JSON.stringify(note)};
      })()`, 'picks-reopen-' + item.question);
      await shot('stage2-' + item.question);
      mark('stage2.' + item.question + '.read-picks');
      const bytes = await readFile(join(second.root, picksPath), 'utf8');
      const picks = JSON.parse(bytes);
      assert.deepEqual(picks.set, {path:item.path, sha256:sha});
      assert.equal(picks.note, note);
      assert(picks.picks.length > 0 && picks.picks.every((row: {option_id:string}) => row.option_id === 'keep'));
      await write(label('picks-' + item.question + '.json'), bytes);
      if (lang === 'en' && index === 0) {
        mark('stage2.bones.plant');
        const negative = await projectCopy(1, '-mutant');
        const changed = flipHash(bytes, 'sha256', sha);
        await writeFile(join(negative.root, picksPath), changed);
        await write('plant2-picks.json', changed);
        await create('plant2-first', ['interview-answer', item.question, negative.root, '--picks-file', picksPath,
          '--set', item.path, '--sha256', sha], /INTERVIEW_OPTIONS_STALE/);
      }
      await create(label('answer-' + item.question), ['interview-answer', item.question, second.root,
        '--picks-file', picksPath, '--set', item.path, '--sha256', sha]);
      const project = await read(join(second.root, 'project.json'));
      const answer = collectItems(project, {collection:null}).find((row: {id:string}) => row.id === item.question).raw;
      assert.deepEqual(answer.choice.set, picks.set);
      assert.equal(answer.choice.note, note);
      assert.deepEqual(answer.choice.picks.map((row: {option_id:string}) => row.option_id), picks.picks.map((row: {option_id:string}) => row.option_id));
      assert.deepEqual(project.signoffs, prior.signoffs);
      second.changes.add('project.json');
    }
    await create(label('stage2-check'), ['interview', '--check', second.root, '--json']);

    async function correctionForm(stage: 'rig-review' | 'direction-review', path: 'made' | 'described', words: string) {
      await click(page, '#write-review');
      await evaluate(`(()=>{
        ${actionGuard}
        const el=id=>action(document.getElementById(id),'#'+id);
        const details=el('correction-controls');
        if(!details.open)action(details.querySelector('summary'),'#correction-controls summary').click();
        for(const [id,value] of Object.entries({
          'feedback-start':'0','feedback-end':'0','feedback-target-kind':'rig','feedback-category':'quality',
          'correction-stage':${JSON.stringify(stage)},'correction-selector':${stage === 'rig-review' ? '"1"' : '"2"'},
          'correction-path':${JSON.stringify(path)}
        }))el(id).value=value;
        el('correction-stage').dispatchEvent(new Event('change',{bubbles:true}));
        if(${stage === 'direction-review'})el('correction-model').value='build/skeleton.model.json';
        const transfer=new DataTransfer();
        transfer.items.add(new File([${JSON.stringify(words)}],'request.txt',{type:'text/plain'}));
        el('correction-words').files=transfer.files;
      })()`);
      await click(page, '#add-proposal');
    }
    async function savedSession(path: string, name: string) {
      return wait(async () => {
        try { return await readFile(path, 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return '';
        }
      }, value => !!value && JSON.parse(value).feedback.length === 1, label(name));
    }

    // Stage 3 uses the approved, source-derived 2.5 edit. Only the failed control uses 0.75.
    mark('stage3.identity');
    const third = await projectCopy(2);
    const thirdInput = rig(third.root);
    const inspected = await loadOpenPackage(thirdInput);
    assert(inspected.mode === 'single');
    const inspectedPackage = inspected.p;
    const pair = resolveProducer([inspected.p.root, bench]);
    assert(pair.ok);
    assert.equal(pair.producer.version, '2.16.0');
    assert.equal(pair.compiler.version, '3.2.1');
    await put(label('rig-source'), {sourceHash:inspected.contentHash, source:inspected.p.reviewedSource, pair});

    async function refusePreviewMade(stateDir: string) {
      await evaluate(`(()=>{
        const original=window.fetch;
        window.__gatePreviewRequests=[];
        window.fetch=async function(input,init){
          if(init?.method!=='PUT'||!String(input).includes('/api/session'))return original.call(window,input,init);
          const observed={body:init.body,response:null};
          window.__gatePreviewRequests.push(observed);
          const response=await original.call(window,input,init);
          observed.response={status:response.status,body:await response.clone().text()};
          return response;
        };
        window.__gateRestorePreviewFetch=()=>{window.fetch=original;};
      })()`);
      try {
        mark('stage3.preview-only');
        await correctionForm('rig-review', 'made', 'Preview-only correction control.');
        const first = await wait(() => evaluate<{
          message: string; error: boolean; proposals: number; requests: {body: string; response: {status: number; body: string} | null}[];
        }>(`({
          message:document.getElementById('review-message')?.textContent??'',
          error:document.getElementById('review-message')?.classList.contains('error')??false,
          proposals:document.querySelectorAll('.proposal-item').length,
          requests:window.__gatePreviewRequests
        })`), result => result.error || result.proposals !== 0 || result.requests.some(request => request.response !== null), 'preview-made-first');
        await put('preview-made-first', first);
        await shot('preview-made-refusal');
        assert.match(first.message, /CORRECTION_APPLY_PENDING/);
        assert.equal(first.proposals, 0);
        assert.deepEqual(first.requests, []);
        await assert.rejects(readFile(sessionFile(inspectedPackage, stateDir)), {code:'ENOENT'});
      } finally {
        await evaluate('window.__gateRestorePreviewFetch?.()');
        await click(page, '#review-dialog-close');
      }
      await until('document.getElementById("review-dialog")?.open===false', 'preview-modal-closed');
    }

    async function idleApply(amplitude: number, stateDir: string, name: string) {
      const opened = await open(name, thirdInput, stateDir);
      await navigate(name, opened.url);
      await until('!!window.rigReviewEditor?.idle?.source?.()?.tracks?.length', name + '-idle');
      mark(name + '.controls');
      await choose(3);
      await click(page, '[data-mode="playback"]');
      await click(page, '#block-tab-idle-tracks');
      await click(page, '#idle-track-list button');
      await evaluate(`(()=>{
        ${actionGuard}
        const selector='#idle-track-editor input[type=number][aria-label="amp value"]';
        const field=action(document.querySelector(selector),selector);
        if(field.value!=='0.5')throw Error('Wrong initial amplitude');
        field.value=${JSON.stringify(String(amplitude))};field.dispatchEvent(new Event('change',{bubbles:true}));
        const preview=action(document.querySelector('[data-idle-preview]'),'[data-idle-preview]');
        if(!preview.checked)preview.click();
      })()`);
      mark(name + '.preview-ready');
      await until('document.getElementById("idle-preview-label")?.hidden===false', name + '-preview');
      assert.equal(await evaluate('document.getElementById("rebuild-applied")?.value'), '');
      await assert.rejects(readFile(sessionFile(inspectedPackage, stateDir)), {code:'ENOENT'});
      mark(name + '.preview-capture');
      await shot(name + '-preview');
      if (lang === 'en' && amplitude === 2.5) await refusePreviewMade(stateDir);
      const started = performance.now();
      mark(name + '.apply');
      await click(page, '#idle-apply');
      const applied = await wait(() => evaluate<string>('document.getElementById("rebuild-applied")?.value??""'), Boolean, label(name + '-apply'), 90000);
      const record = JSON.parse(applied);
      mark(name + '.settled-evidence');
      const job = await fetchBody(label(name + '.job'), new URL('api/rebuild/' + record.buildId, opened.url),
        response => response.json());
      const revision = rebuildDir(stateDir, inspected.contentHash, record.buildId);
      const hashes = await inventory(revision);
      const check = await read(join(revision, 'check/check.json'));
      await put(label(name + '-applied'), record);
      await put(label(name + '-job'), {uiElapsedMs:Math.round(performance.now() - started), job});
      await put(label(name + '-scratch'), hashes);
      await put(label(name + '-check'), check);
      await cp(join(revision, 'build'), join(output, label(name + '-compiled')), {recursive:true});
      await shot(name);
      assert.equal(record.schema, 'rig-review-applied/2');
      assert.equal(job.status, 'built');
      assert.equal(job.reused, false);
      assert.equal(job.exitCode, 0);
      assert.deepEqual(record.patch.ops, [{op:'replace', path:'/motion/tracks/0/amp', value:amplitude}]);
      assert.equal(digest(patchText(record.patch)), record.patchSha256);
      assert.notEqual(record.modelHash, inspectedPackage.reviewedSource.rig!.sha256);
      return {record, job, hashes, check, opened};
    }

    if (lang === 'en') {
      const failedState = join(scratch, 'failed-check-state');
      const frozen = process.env.REVIEW_371_FAILED_APPLIED;
      assert(frozen, 'Set REVIEW_371_FAILED_APPLIED to the retained 0.75 applied context');
      mark('stage3.failed-input');
      const frozenBytes = await readFile(frozen);
      assert.equal(digest(frozenBytes), '44c9cf73d6b7149edbab743483d42203b232cef5ab87ab322cc1d975f29c396c');
      const originalFailed = JSON.parse(frozenBytes.toString());
      const sourceHash = '7ee431d9a8de3fde7f06ec9ee720cf243449bd0f0a435261ce6612ae6e1a4d1d';
      assert.equal(inspected.contentHash, sourceHash);
      const requirementsHash = digest(await readFile(join(third.root, 'derived/review/v1/interview-requirements.json')));
      const configIdentity = digest(JSON.stringify([originalFailed.configHash, requirementsHash]));
      assert.equal(patchId({sourceHash, configHash:configIdentity, patch:originalFailed.patch,
        producer:'@rig-c/parts@2.16.0', compiler:'@rig-c/core@3.2.1', op:'rig'}), originalFailed.buildId);
      const failed = await idleApply(0.75, failedState, 'stage3-failed-control');
      assert.deepEqual(failed.record, originalFailed);
      assert.equal(failed.record.check.pass, false);
      assert.equal(failed.check.BREATH_VISIBLE.torso_heat_mean, 3.62);
      // Keep the actual PUT and response independently of the named refusal gate.
      await evaluate(String.raw`(()=>{
        const real=window.fetch, exchanges=[];
        window.__gateFailedExchanges=exchanges;
        window.fetch=function(...args){
          const [input,init]=args;
          if(init?.method!=='PUT'||typeof input!=='string'||!/\/api\/session(?:[?#]|$)/.test(input))return real.apply(this,args);
          const exchange={method:'PUT',request:typeof init.body==='string'?init.body:null,settled:false};
          exchanges.push(exchange);
          const fail=error=>{exchange.error=String(error);exchange.settled=true;};
          let result;
          try { result=real.apply(this,args); } catch(error) { fail(error);throw error; }
          void result.then(async response=>{
            exchange.response={status:response.status,body:null};
            try { exchange.response.body=await response.clone().text(); }
            catch(error) { exchange.response.readError=String(error); }
            finally { exchange.settled=true; }
          },fail);
          return result;
        };
        window.__gateRestoreFailedFetch=()=>{window.fetch=real;};
      })()`);
      const readFailedSubmit = () => evaluate<FailedSubmitSnapshot>(`({
        exchanges:window.__gateFailedExchanges??[],
        message:document.getElementById('review-message')?.textContent??null,
        saveDisabled:document.getElementById('save')?.disabled??null
      })`);
      let capture: FailedSubmitSnapshot | null = null;
      let clickAttempted = false;
      try {
        mark('stage3.failed-submit');
        await correctionForm('rig-review', 'made', 'Keep the measured failed correction open.');
        await until('document.querySelectorAll(".proposal-item").length===1', 'failed-item');
        clickAttempted = true;
        await click(page, '#save');
      } finally {
        try {
          if (clickAttempted) await wait(readFailedSubmit, value => value.saveDisabled === false &&
            value.exchanges.length > 0 && value.exchanges.every(exchange => exchange.settled), 'failed-submit-transport');
        } finally {
          try {
            let diagnostic: string | null = null;
            try { capture = await readFailedSubmit(); }
            catch (error) { diagnostic = 'FAILED_SUBMIT_CAPTURE_UNAVAILABLE: ' + String(error); }
            if (capture?.exchanges.length === 0) diagnostic = 'FAILED_SUBMIT_NO_OBSERVED_PUT';
            await put('failed-check-submit-wire', {diagnostic, ...capture});
            const request = capture?.exchanges[0]?.request;
            if (typeof request === 'string') await write('failed-check-refused-request.json', request);
            await put('failed-check-submit-message', capture?.message ?? null);
          } finally {
            await evaluate('window.__gateRestoreFailedFetch?.()');
          }
        }
      }
      assert.equal(capture?.exchanges.length, 1, 'Expected exactly one actual refused Review PUT');
      const exchange = capture!.exchanges[0]!;
      const response = exchange.response;
      assert.equal(response?.status, 400, 'Expected HTTP 400 for the refused Review PUT');
      assert(typeof response.body === 'string', 'Missing actual refused Review response body');
      const expectedError = 'EDIT_SUBMIT_UNCHECKED: applied build failed check — ' + originalFailed.check.line;
      assert.deepEqual(JSON.parse(response.body), {error:expectedError}, 'Unexpected refused Review response');
      assert(capture?.message?.includes(expectedError), 'Review message is missing the exact failed-check error');
      const refused = exchange.request;
      assert(refused, 'Missing actual refused Review request');
      await assert.rejects(readFile(sessionFile(inspected.p, failedState)), {code:'ENOENT'});
      const item = JSON.parse(refused).feedback[0];
      assert.deepEqual(item.context.applied, originalFailed);
      mark('stage3.failed-create-copy');
      const negative = await projectCopy(2, '-failed-checked-claim');
      const path = 'evidence/refused-request.json';
      await writeFile(join(negative.root, path), refused);
      await writeFile(join(negative.root, 'evidence/checked-claim.txt'), 'Check whether the retained Apply can claim a checked result.');
      const pending = JSON.parse(await create('failed-check-pending', ['correction','record',negative.root,'--id',item.id,
        '--path','made','--stage','rig-review','--version','1','--by','user','--feedback-file',path,'--item',item.id,'--json']));
      assert.equal(pending.artifact.kind, 'config-patch');
      assert.equal(pending.artifact.state, 'preview/pending');
      assert.equal(pending.outcome, null);
      negative.changes.add('project.json');
      const beforeResolve = await readFile(join(negative.root, 'project.json'));
      await create('failed-check-resolve-first', ['correction','resolve',item.id,negative.root,'--version','1',
        '--by','agent','--reasoning-file',join(negative.root,'evidence/checked-claim.txt')],
      /CORRECTION_APPLIED_INVALID:[\s\S]*claimed checked Apply lacks a passing producer check summary/);
      mark('stage3.post-resolve-project');
      assert.deepEqual(await readFile(join(negative.root, 'project.json')), beforeResolve);
    }

    const applied = await idleApply(2.5, state, 'stage3');
    assert(applied.check.BREATH_VISIBLE.torso_heat_mean >= 6.12);
    assert.equal(applied.record.check.pass, true);
    assert.equal(applied.record.check.exitCode, 0);
    assert.equal(applied.record.check.gate, true);
    await choose(4);
    await choose(3);
    assert.deepEqual(await evaluate('JSON.parse(document.getElementById("rebuild-applied")?.value||"null")'), applied.record);
    const words = lang === 'en' ? '  Adjust body idle amplitude to 2.5.\r\n' : '  몸통 대기 모션 진폭을 2.5로 조정.\r\n';
    mark('stage3.made-submit');
    await correctionForm('rig-review', 'made', words);
    await until('document.querySelectorAll(".proposal-item").length===1', 'made-item');
    await click(page, '#save');
    const saved = await savedSession(sessionFile(inspected.p, state), 'made-save');
    const session = JSON.parse(saved);
    assert.equal(session.status, 'pending');
    const item = session.feedback[0];
    assert.equal(item.summary, words);
    assert.deepEqual(item.context.applied, applied.record);
    await write(label('made-session.json'), saved);
    mark('stage3.made-export');
    assert.equal(await feedback(thirdInput, item.id, 'made-json', 'json'), saved);
    const madeIssue = parseIssue(await feedback(thirdInput, item.id, 'made-issue', 'issue'));
    assert.equal(madeIssue.patchBytes, patchText(applied.record.patch));
    await navigate('stage3.reopen', (await open('stage3.reopen', thirdInput)).url);
    assert.equal(await readFile(sessionFile(inspected.p, state), 'utf8'), saved);
    mark('stage3.made-create-copy');
    const copy = await projectCopy(2, '-made');
    const savedPath = 'evidence/gate-made.json';
    await writeFile(join(copy.root, savedPath), saved);
    const madeArgs = (root: string) => ['correction','record',root,'--id',item.id,'--path','made',
      '--stage','rig-review','--version','1','--by','user','--feedback-file',savedPath,'--item',item.id,'--json'];
    const made = JSON.parse(await create(label('made-record'), madeArgs(copy.root)));
    copy.changes.add('project.json');
    const madeProject = await read(join(copy.root, 'project.json'));
    assert.deepEqual(madeProject.corrections.find((row: {id:string}) => row.id === item.id), made);
    assert.deepEqual(madeProject.signoffs, (await read(join(third.root, 'project.json'))).signoffs);
    assert.equal(madeProject.stage, 'rig-review');
    assert.equal(made.verbatim, words);
    assert.equal(made.artifact.kind, 'config-patch');
    assert.equal(made.artifact.feedback.file.sha256, digest(saved));
    assert.equal(made.artifact.state, 'preview/pending');
    assert.equal(made.outcome, null);
    await create(label('made-check'), ['interview','--check',copy.root,'--json']);

    if (lang === 'en') {
      const replayState = join(scratch, 'replay-state');
      const opened = await open('stage3.replay', thirdInput, replayState);
      const url = new URL(opened.url);
      const capability = new URLSearchParams(url.hash.slice(1)).get('cap');
      assert(capability);
      const headers = {Origin:url.origin, 'Content-Type':'application/json', 'X-Review-Capability':capability};
      mark('stage3.replay.post');
      const started = await fetchBody(label('stage3.replay.post'), new URL('api/rebuild', url),
        async response => ({status:response.status, ok:response.ok, job:await response.json()}),
        {method:'POST', headers, body:JSON.stringify({patch:JSON.parse(madeIssue.patchBytes)})});
      const initial = started.job;
      await put('replay-initial', {status:started.status, job:initial});
      assert(started.ok && initial.id);
      mark('stage3.replay.settle');
      const replay = await wait(signal => fetchBody(label('stage3.replay.read'), new URL('api/rebuild/' + initial.id, url),
        response => response.json(), {signal}), job => job.status !== 'running', 'made-replay', 90000);
      await put('replay-job', replay);
      const replayRoot = rebuildDir(replayState, inspected.contentHash, replay.id);
      const hashes = await inventory(replayRoot);
      await put('replay-scratch', hashes);
      assert.equal(replay.status, 'built');
      assert.equal(replay.reused, false);
      assert.equal(replay.request.patchSha256, applied.record.patchSha256);
      assert.deepEqual(replay.build.files, applied.job.build.files);
      assert.deepEqual(replay.check, applied.job.check);
      for (const path of ['config.json','rig/motion.json','check/check.json']) assert.equal(hashes[path], applied.hashes[path]);
      // Independent Create consumer controls. Retain the first verdict and require its named reason.
      mark('stage3.stale-session');
      const stale = flipHash(saved, 'configHash', applied.record.configHash);
      await writeFile(join(copy.root, savedPath), stale);
      await write('stale-session.json', stale);
      await create('stale-first', ['interview','--check',copy.root,'--json'], /CORRECTION_HASH/);
      mark('stage3.plant-config');
      const configMutant = await projectCopy(2, '-config-mutant');
      await writeFile(join(configMutant.root, savedPath), stale);
      await write('plant3-session.json', stale);
      await create('plant3-first', madeArgs(configMutant.root), /CORRECTION_APPLIED_INVALID:[\s\S]*patch\/config\/producer mismatch/);
      mark('stage3.cross-source');
      const cross = await projectCopy(2, '-cross-source');
      const otherModel = await readFile(resolve('tests/fixtures/direction-inspection/derived/review/v1/out/check/build/skeleton.model.json'));
      const otherHash = digest(otherModel);
      assert.equal(otherHash, '63190ec6746bafbc73847fa6c6905b5811cc0adb41897dfed923fe802e4dc261');
      const crossSession = JSON.parse(saved);
      crossSession.reviewedSource.rig.sha256 = otherHash;
      await writeFile(join(cross.root, savedPath), json(crossSession));
      await put('cross-source-session', crossSession);
      await create('cross-source-first', madeArgs(cross.root), /CORRECTION_APPLIED_INVALID:[\s\S]*feedback reviewed source\/handoff differs/);
    }

    // Stage 4 begins before post v2. Use the declared authoring input and the public writer.
    mark('stage4.copy');
    const fourth = await projectCopy(3);
    const fourthBefore = await read(join(fourth.root, 'project.json'));
    assert.deepEqual(fourthBefore.versions.map((row: {n:number}) => row.n), [1]);
    const directionInputPath = 'evidence/direction-input.json';
    await assert.rejects(readFile(join(fourth.root, directionInputPath)), {code:'ENOENT'});
    const authored = await read(join(chain, directionInputPath));
    const projectModel = 'derived/review/v1/out/check/build/skeleton.model.json';
    assert.equal(authored.rig.version, 1);
    assert.deepEqual(authored.rig.model, {path:projectModel, sha256:digest(await readFile(join(fourth.root, projectModel)))});
    for (const [field, guide] of [['camera', 'camera_depth'], ['timing', 'post_timing']] as const) {
      const answer = collectItems(fourthBefore, {collection:null}).find((row: {id:string}) => row.id === guide).raw;
      assert.deepEqual(authored.citations[field], {guide, asks:[guide], quote:answer.verbatim});
    }
    const authoredBytes = json(authored);
    await writeFile(join(fourth.root, directionInputPath), authoredBytes);
    await write(label('direction-input.json'), authoredBytes);
    await create(label('direction-write'), ['direction','write','2',fourth.root,'--file',directionInputPath,'--rig','1']);
    fourth.changes.add('project.json');
    const checked = JSON.parse(await create(label('direction-check'), ['direction','check','2',fourth.root,'--json']));
    assert.equal(checked.post, 2);
    assert.deepEqual(checked.document, authored);
    const authoredOutput = await readFile(join(fourth.root, checked.direction.path), 'utf8');
    assert.equal(authoredOutput, authoredBytes);
    assert.equal(digest(authoredOutput), checked.direction.sha256);
    await write(label('direction-output.json'), authoredOutput);
    const fourthInput = {...rig(fourth.root, 2), viewOnly:true};
    const directionOpen = await open('stage4', fourthInput);
    const direction = await loadOpenPackage(fourthInput);
    assert(direction.mode === 'single' && direction.p.direction?.joined);
    await navigate('stage4', directionOpen.url);
    mark('stage4.inspect');
    await choose(4);
    const directionWords = lang === 'en' ? '  Ease into the second camera key.\r\n' : '  두 번째 카메라 키까지 부드럽게 이동해 주세요.\r\n';
    const directionReady = '!!document.querySelector("#direction-panel:not([hidden]) ul") && !!document.querySelector("#direction-panel pre")?.textContent';
    await until(directionReady, 'direction-authored-ready');
    const keys = await evaluate<{rows:string; keys:unknown}>(`(()=>{
      ${actionGuard}
      const panel=action(document.getElementById('direction-panel'),'#direction-panel');
      const details=action(panel.querySelector('div details'),'#direction-panel authored keys details');
      if(!details.open)action(details.querySelector('summary'),'#direction-panel authored keys summary').click();
      return {rows:panel.querySelector('ul')?.innerText??'',keys:JSON.parse(panel.querySelector('pre')?.textContent||'null')};
    })()`);
    await put(label('direction-visible'), keys);
    assert.deepEqual(keys.keys, {camera:authored.camera, timing:authored.timing.keys, take:authored.take});
    for (const identity of [projectModel, direction.p.sourceHash, checked.direction.sha256,
      direction.p.direction.joined.projectHash, 'CAMERA_APPLY_UNSUPPORTED']) assert(keys.rows.includes(identity), identity);
    await shot('stage4');
    await choose(3);
    await choose(4);
    await until(directionReady, 'direction-back-ready');
    assert.deepEqual(await evaluate('JSON.parse(document.querySelector("#direction-panel pre")?.textContent||"null")'), keys.keys);
    const location = sessionFile(direction.p, state);
    await assert.rejects(readFile(location), {code:'ENOENT'});
    mark('stage4.camera-refusal');
    await correctionForm('direction-review', 'made', directionWords);
    await until('document.getElementById("review-message")?.textContent?.includes("CAMERA_APPLY_UNSUPPORTED")===true', 'camera-made-refusal');
    await put(label('camera-refusal'), await evaluate('document.getElementById("review-message")?.textContent??null'));
    assert.equal(await evaluate('document.querySelectorAll(".proposal-item").length'), 0);
    await click(page, '#review-dialog-close');
    mark('stage4.described-submit');
    await correctionForm('direction-review', 'described', directionWords);
    await until('document.querySelectorAll(".proposal-item").length===1', 'direction-item');
    await click(page, '#save');
    const directionSession = await savedSession(location, 'direction-save');
    const describedItem = JSON.parse(directionSession).feedback[0];
    assert.equal(describedItem.summary, directionWords);
    assert.equal(JSON.parse(directionSession).status, 'pending');
    await write(label('direction-session.json'), directionSession);
    mark('stage4.described-export');
    const issueBytes = await feedback(fourthInput, describedItem.id, 'direction-issue', 'issue');
    const issue = parseIssue(issueBytes);
    const source = JSON.parse(issue.createSource);
    assert.equal(issue.verbatim, directionWords);
    assert.deepEqual(issue.selectorArgs, ['--version','2','--model-file',projectModel]);
    assert.equal(source.post, checked.post);
    assert.deepEqual(source.model, checked.document.rig.model);
    assert.deepEqual(source.direction, checked.direction);
    assert.deepEqual(source.inspectedModel, direction.p.reviewedSource.rig);
    await navigate('stage4.reopen', (await open('stage4.reopen', fourthInput)).url);
    await choose(4);
    await until(directionReady, 'direction-reopen-ready');
    assert.equal(await readFile(location, 'utf8'), directionSession);
    const textFile = join(fourth.root, 'evidence/gate-direction-words.txt');
    await writeFile(textFile, issue.verbatim);
    const describedArgs = (handoff: typeof issue) => ['correction','record',fourth.root,'--id',describedItem.id,
      '--path','described','--stage','direction-review',...handoff.selectorArgs,'--by','user',
      '--verbatim-file',textFile,'--source',handoff.createSource,'--json'];
    if (lang === 'en') {
      mark('stage4.plant-selector');
      const changed = mutateOne(issueBytes, '"'+projectModel+'"', '"'+projectModel.replace('/v1/', '/v2/')+'"');
      await write('plant4-direction-issue.md', changed);
      const changedIssue = parseIssue(changed);
      assert.equal(changedIssue.selectorArgs[3], projectModel.replace('/v1/', '/v2/'));
      assert.equal(changedIssue.createSource, issue.createSource);
      const beforeRecord = await readFile(join(fourth.root, 'project.json'));
      await create('plant4-first', describedArgs(changedIssue), /CORRECTION_SOURCE:[\s\S]*must name the direction source compiled model/);
      assert.deepEqual(await readFile(join(fourth.root, 'project.json')), beforeRecord);
    }
    const described = JSON.parse(await create(label('direction-record'), describedArgs(issue)));
    const fourthAfter = await read(join(fourth.root, 'project.json'));
    assert.deepEqual(fourthAfter.corrections.find((row: {id:string}) => row.id === describedItem.id), described);
    assert.deepEqual(fourthAfter.signoffs, fourthBefore.signoffs);
    assert.deepEqual(fourthAfter.reopens, fourthBefore.reopens);
    assert.equal(fourthAfter.stage, fourthBefore.stage);
    assert.equal(described.schema, 'rig-create/correction@2');
    assert.equal(described.verbatim, directionWords);
    assert.equal(described.source, issue.createSource);
    assert.equal(described.outcome, null);
    assert.deepEqual(described.on.model, checked.document.rig.model);
    assert.deepEqual(described.on.direction, checked.direction);
    await create(label('direction-consumer-check'), ['interview','--check',fourth.root,'--json']);
  } catch (error) {
    mark('failure.capture');
    const iframeDiagnostics = await evaluate(`(()=>{
      const frame=${frame};
      const doc=frame?.contentDocument;
      const save=doc?.querySelector('#pv-save');
      const status=doc?.querySelector('#pv-load');
      return {
        pagePath:location.pathname,
        iframePath:frame?new URL(frame.src).pathname:null,
        ready:doc?.body?.dataset.ready??null,
        reason:status?.textContent??null,
        reasonResult:status?.dataset.result??null,
        save:save?{disabled:save.disabled,title:save.title,hidden:save.hidden}:null,
        parts:doc?[...doc.querySelectorAll('[data-pv-item]')].map(item=>({
          id:item.dataset.pvItem,current:item.getAttribute('aria-current'),connected:item.isConnected,
          visible:[...item.getClientRects()].some(rect=>rect.width>0&&rect.height>0),
          disabled:item.matches(':disabled'),outcome:item.querySelector('[data-outcome]')?.dataset.outcome??null
        })):[],
        partOutcome:doc?.querySelector('[data-pv-outcome]:checked')?.value??null,
        partNote:doc?.querySelector('#pv-note')?.value??null,
        meshOutcome:doc?.querySelector('#pv-mesh-panel select')?.value??null,
        meshNote:doc?.querySelector('#pv-mesh-panel textarea')?.value??null,
        overall:doc?.querySelector('#pv-overall')?.value??null
      };
    })()`).catch(() => null);
    await put(label('first-error'), {error:String(error), iframeDiagnostics, interviewDiagnostics:await evaluate(interviewDom).catch(() => null)});
    await shot('first-error').catch(() => {});
    throw error;
  } finally {
    mark('inventory.copies');
    for (const copy of scratchCopies) {
      const before = fixture.stages[copy.index]!.original;
      const after = await inventory(copy.root);
      await put(label(copy.root.split('/').at(-1)! + '-inventory'), {before, after, mutable:[...copy.changes]});
      for (const [path, sha] of Object.entries(before)) {
        if (!copy.changes.has(path)) assert.equal(after[path], sha, `Source changed: ${path}`);
      }
    }
    mark('inventory.copies.complete');
  }
}

for (const stage of fixture.stages) await put(stage.name + '-original', stage.original);
try {
  for (const lang of languages) {
    const previousTmp = process.env.TMPDIR;
    let page: InputCdpSession;
    try {
      process.env.TMPDIR = '/tmp'; // Chromium's startup temp must stay short on Nova.
      checkpoint(lang + '-browser.launch');
      page = await launchCdpSession(join(scratch, 'chromium-' + lang), {sendDeadlineMs:10000});
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
    try {
      checkpoint(lang + '-browser.viewport');
      await page.setViewport(1440, 1080);
      await runLanguage(lang, page);
    } finally {
      checkpoint(lang + '-browser.close');
      await page.close();
    }
  }
} finally {
  checkpoint('inventory.originals');
  for (const stage of fixture.stages) await stage.assertOriginal();
  checkpoint('inventory.originals.complete');
}
checkpoint('walk.complete');
