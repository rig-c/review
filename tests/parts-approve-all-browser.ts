/** #395 CDP receipt. Run only in the authorized browser environment; never invokes a producer.
 * TMPDIR=<prepared short parent> bun tests/parts-approve-all-browser.ts
 *   --public-root <sealed 23-part package> --baseline-root <installed rig-review@1.8.0>
 *   --out <persistent evidence directory> [--width 1600] [--height 1100]
 * API/save assertions and visual measurements are reported separately. Screenshots require eye review.
 * No seal-file format is inferred: the supplied public tree is hashed before and after read-only use.
 */
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { loadPartsView, readVerdict, buildVerdict, type PartsViewPackage, type PartsVerdict } from '../src/parts-view.ts';
import { startPartsServer } from '../src/parts-server.ts';
import { writeMeshPackage } from './helpers/parts-mesh-package.ts';
import { launchCdpSession, type InputCdpSession } from './parts-explorer-browser.ts';
import { enCatalog } from '../web/catalog-en.ts';
import { koCatalog } from '../web/catalog-ko.ts';

const arg = (name: string): string | undefined => {
  const i = Bun.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = Bun.argv[i + 1];
  if (!value || value.startsWith('--')) throw Error('Missing value: ' + name);
  return value;
};
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
function check(ok: unknown, label: string): asserts ok { if (!ok) throw Error(label); }
const same = (a: unknown, b: unknown, label: string) => check(isDeepStrictEqual(a, b), label);
const cap = 'd'.repeat(64), lifetime = 60 * 60 * 1000;
const serverOptions = { port: 0, capability: cap, exitOnClose: false, graceMs: lifetime, unopenedTimeoutMs: lifetime };
type Server = Awaited<ReturnType<typeof startPartsServer>>;
type Entry = { outcome: string; note: string; mesh?: { outcome: string; note: string } };
type Submission = { status: string; parts: Record<string, Entry>; comments: PartsVerdict['comments'] };
type Wire = { path: string; method: string; contentType: string | null; body: Submission; status?: number };

async function hashes(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name), st = await lstat(file);
      check(!st.isSymbolicLink(), 'Unknown sealed-tree contract: symlink ' + file);
      if (st.isDirectory()) await walk(file);
      else { check(st.isFile(), 'Unknown input entry: ' + file); found[relative(root, file)] = sha(await readFile(file)); }
    }
  }
  await walk(root); return found;
}
async function wait(page: InputCdpSession, expression: string, label: string) {
  for (let i = 0; i < 240; i++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(25); }
  throw Error('BROWSER_WAIT: ' + label + ' / ' + await page.evaluate(`document.getElementById('pv-save-status')?.textContent`));
}
async function click(page: InputCdpSession, selector: string) {
  const p = await page.evaluate<{ x: number; y: number }>(`(()=>{
    const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing control '+${JSON.stringify(selector)});
    n.scrollIntoView({block:'nearest',inline:'nearest'});const r=n.getBoundingClientRect();
    if(n.disabled||r.width<=0||r.height<=0)throw Error('Unavailable control '+${JSON.stringify(selector)});
    const x=r.left+r.width/2,y=r.top+r.height/2;if(!n.contains(document.elementFromPoint(x,y)))throw Error('Obscured control');return {x,y};
  })()`);
  await page.mouse('mouseMoved', p.x, p.y); await page.mouse('mousePressed', p.x, p.y); await page.mouse('mouseReleased', p.x, p.y);
}
async function field(page: InputCdpSession, selector: string, value: string, event = 'change') {
  await page.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw Error('Missing field');n.value=${JSON.stringify(value)};n.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
}
async function choose(page: InputCdpSession, name: string) {
  await page.evaluate(`(()=>{const n=[...document.querySelectorAll('[data-pv-item]')].find(n=>n.dataset.pvItem===${JSON.stringify(name)});if(!n)throw Error('Missing part');n.click();})()`);
}
async function open(page: InputCdpSession, server: Server, lang: string) {
  await page.goto('about:blank');
  await page.goto(`http://127.0.0.1:${server.port}/?lang=${lang}#cap=${cap}`);
  await wait(page, `document.body.dataset.ready==='true'&&document.getElementById('pv-canvas')?.width>1`, 'boot ' + lang);
  await page.evaluate(`document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
  // Passive observation: forwards the original request and response, never substitutes a save.
  await page.evaluate(`(()=>{window.__rv395wire=[];window.__rv395clicks=[];
    document.addEventListener('click',e=>{const n=e.target.closest?.('#pv-save,#pv-approve-all');if(n)window.__rv395clicks.push({id:n.id,trusted:e.isTrusted});},true);
    const original=window.fetch;window.fetch=async(...args)=>{const path=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname;
      const init=args[1]??{};let row;if(path==='/api/parts/verdict'&&init.method==='POST'){
        row={path,method:init.method,contentType:new Headers(init.headers).get('Content-Type'),body:JSON.parse(init.body)};window.__rv395wire.push(row);
      }const response=await original(...args);if(row)row.status=response.status;return response;};})()`);
}
const wire = (page: InputCdpSession) => page.evaluate<Wire[]>('window.__rv395wire');
async function save(page: InputCdpSession, button = '#pv-save') {
  await page.evaluate(`document.getElementById('pv-save-status').dataset.result=''`);
  await click(page, button);
  await wait(page, `['saved','refused'].includes(document.getElementById('pv-save-status').dataset.result)`, button);
  return page.evaluate<{ result: string; text: string }>(`(()=>{const n=document.getElementById('pv-save-status');return {result:n.dataset.result,text:n.textContent};})()`);
}
async function ui(page: InputCdpSession) {
  return page.evaluate<{ status: string; parts: Record<string, Entry> }>(`(()=>{
    const names=[...document.querySelectorAll('[data-pv-item]')].map(n=>n.dataset.pvItem),parts={},selected=document.querySelector('[data-pv-item][aria-current="true"]')?.dataset.pvItem;
    for(const name of names){[...document.querySelectorAll('[data-pv-item]')].find(n=>n.dataset.pvItem===name).click();
      const s=document.querySelector('#pv-mesh-panel select');parts[name]={outcome:document.querySelector('[data-pv-outcome]:checked').value,note:document.getElementById('pv-note').value,
        ...(s?{mesh:{outcome:s.value,note:document.querySelector('#pv-mesh-panel textarea').value}}:{})};}
    if(selected)[...document.querySelectorAll('[data-pv-item]')].find(n=>n.dataset.pvItem===selected).click();
    return {status:document.getElementById('pv-overall').value,parts};})()`);
}
async function assertSaved(page: InputCdpSession, pkg: PartsViewPackage, body: Submission) {
  const requests = await wire(page), request = requests.at(-1);
  check(request?.status === 200, 'actual verdict POST succeeded');
  same(Object.keys(request.body).sort(), ['comments', 'parts', 'status'], 'unchanged wire top-level fields');
  check(request.path === '/api/parts/verdict' && request.method === 'POST' && request.contentType === 'application/json', 'unchanged save route/method/content type');
  same(request.body, body, 'actual UI body equals expected input');
  const saved = (await readVerdict(pkg)).verdict;
  check(saved, 'saved verdict exists');
  same(saved, buildVerdict(pkg, body, saved.tool.version, new Date(saved.updatedAt)), 'disk verdict equals unchanged buildVerdict');
  check(await page.evaluate(`window.__rv395clicks.at(-1)?.trusted===true`), 'save action was a trusted CDP click');
  return saved;
}
async function addComment(page: InputCdpSession) {
  await choose(page, 'gap'); await click(page, '#native-one'); await click(page, '#stage-comment');
  const p = await page.evaluate<{ x: number; y: number }>(`(()=>{const r=document.getElementById('rig-root').getBoundingClientRect();return {x:r.left,y:r.top};})()`);
  await page.mouse('mouseMoved', p.x + 5, p.y + 6); await page.mouse('mousePressed', p.x + 5, p.y + 6);
  await page.mouse('mouseMoved', p.x + 23, p.y + 25); await page.mouse('mouseReleased', p.x + 23, p.y + 25);
  await wait(page, `!!document.querySelector('.stage-comment-composer input')`, 'comment composer');
  await field(page, '.stage-comment-composer input', 'Preserve reviewer comment 한글 395', 'input');
  await page.evaluate(`document.querySelector('.stage-comment-composer').requestSubmit()`);
  await wait(page, `!document.querySelector('.stage-comment-composer')&&document.querySelectorAll('.stage-comment-pin').length===1`, 'real accepted comment');
  await click(page, '#stage-comment');
}
async function fixture(root: string) {
  await writeMeshPackage(root);
  const doc = JSON.parse(await readFile(join(root, 'parts.json'), 'utf8'));
  const image = await readFile(join(root, 'parts/covered.png'));
  for (let i = 2; i < 23; i++) {
    const name = i === 22 ? 'long synthetic part name with spaces 전체 이름 remains accessible ' + 'detail_'.repeat(14) : `part_${String(i).padStart(2, '0')}`;
    doc.parts.push({ name, x: (i % 6) * 64, y: Math.floor(i / 6) * 64, w: 64, h: 64 });
    await writeFile(join(root, 'parts', name + '.png'), image);
  }
  doc.rig_size = [384, 256]; await writeFile(join(root, 'parts.json'), JSON.stringify(doc));
}
type Layout = { rows: Array<{ name: string; display: string; wrap: string; oneLine: boolean; contained: boolean; checkbox: boolean; accessible: boolean; caption: string; height: number }>; viewport: { width: number; height: number }; language: string; approveText: string | null };
async function layout(page: InputCdpSession): Promise<Layout> {
  return page.evaluate<Layout>(`(()=>{const list=document.querySelector('.pv-list'),lr=list.getBoundingClientRect();list.scrollTop=0;
    const rows=[...document.querySelectorAll('#pv-items>li')].map(li=>{const button=li.querySelector('[data-pv-item]'),label=li.querySelector('.pv-name'),input=li.querySelector('input[type=checkbox]'),s=getComputedStyle(li),r=li.getBoundingClientRect(),b=button.getBoundingClientRect(),c=input?.getBoundingClientRect();
      const range=document.createRange();range.selectNodeContents(label);const textRows=[...range.getClientRects()];
      const inline=[...button.querySelectorAll('.pv-name,.pv-count,.pv-badge')].filter(n=>n.textContent.trim()).map(n=>n.getBoundingClientRect());
      const name=button.dataset.pvItem;const accessibleName=button.getAttribute('aria-label')||button.textContent;
      return {name,display:s.display,wrap:s.flexWrap,height:r.height,
        oneLine:getComputedStyle(label).whiteSpace==='nowrap'&&new Set(textRows.map(r=>Math.round(r.top*100)/100)).size<=1&&inline.every(n=>Math.abs((n.top+n.height/2)-(b.top+b.height/2))<=2)&&!!c&&Math.abs((b.top+b.height/2)-(c.top+c.height/2))<=2,
        contained:r.top>=Math.max(0,lr.top)-1&&r.bottom<=Math.min(innerHeight,lr.bottom)+1&&r.left>=lr.left-1&&r.right<=lr.right+1&&!!c&&c.left>=r.left&&c.right<=r.right,
        checkbox:!!input&&!input.disabled&&input.checked&&!!input.getAttribute('aria-label')&&input.getAttribute('aria-label').includes(name),
        accessible:label.textContent===name&&button.title===name&&accessibleName.includes(name),caption:input?.parentElement.textContent.trim()??''};});
    return {rows,viewport:{width:innerWidth,height:innerHeight},language:document.documentElement.lang,approveText:document.getElementById('pv-approve-all')?.textContent??null};})()`);
}
function assertLayout(value: Layout, names: string[]) {
  same(value.rows.map(r => r.name), names, 'all 23 rows in source order');
  check(value.rows.length === 23 && value.rows.every(r => r.display === 'flex' && r.wrap === 'nowrap' && r.oneLine && r.contained && r.checkbox && r.accessible && r.caption === ''), 'every row fits, never wraps, has no Visible caption, and retains accessible full name/checkbox');
}

async function main() {
  const parent = process.env.TMPDIR; check(parent && isAbsolute(parent), 'TMPDIR must name the prepared short absolute parent');
  check((await lstat(parent)).isDirectory(), 'TMPDIR must exist');
  const root = await mkdtemp(join(parent, 'h-')), scratch = join(root, 's'), profile = join(root, 'p');
  const out = resolve(arg('--out') ?? process.env.PARTS_APPROVE_ALL_SHOTS ?? join(root, 'evidence'));
  const width = Number(arg('--width') ?? 1600), height = Number(arg('--height') ?? 1100);
  check(Number.isInteger(width) && Number.isInteger(height) && width >= 1000 && height >= 700, 'invalid viewport');
  const publicRoot = arg('--public-root'), baselineRoot = arg('--baseline-root');
  check(!baselineRoot || publicRoot, '--baseline-root requires --public-root');
  const previousState = process.env.RIG_REVIEW_STATE_DIR;
  process.env.RIG_REVIEW_STATE_DIR = join(root, 'state');
  let page: InputCdpSession | undefined;
  const servers: Server[] = [], report: Record<string, unknown> = { pass: false, viewport: { width, height }, apiSave: [], visuals: {}, eyeReview: 'NOT_PERFORMED: screenshots and geometry are separate from API/save verdicts', inputs: { publicRoot: publicRoot ?? null, baselineRoot: baselineRoot ?? null } };
  const api = report.apiSave as unknown[];
  try {
    await mkdir(out, { recursive: true }); await mkdir(scratch); await mkdir(profile);
    const input = join(scratch, 'fixture'); await fixture(input);
    const before = await hashes(input);
    page = await launchCdpSession(profile); await page.setViewport(width, height);
    const serve = async (pkg: PartsViewPackage) => { const server = await startPartsServer(pkg, serverOptions); servers.push(server); return server; };
    const load = (name: string) => loadPartsView(input, { verdict: join(scratch, name + '.json') });
    for (const lang of ['en', 'ko']) {
      // Fresh UI: one real batch click, all pending part AND mesh entries reach the existing save.
      const pkg = await load('fresh-' + lang), server = await serve(pkg);
      check(pkg.items.filter(i => i.mesh).length === 2, 'synthetic fixture has two actual meshes');
      await open(page, server, lang); const pending = await ui(page);
      check(Object.values(pending.parts).every(p => p.outcome === 'pending' && (!p.mesh || p.mesh.outcome === 'pending')), 'fresh UI pending');
      check((await readVerdict(pkg)).verdict === null, 'opening never saves approval');
      let guarded = false; try { buildVerdict(pkg, { ...pending, status: 'approved', comments: [] }, 'oracle'); } catch (e) { guarded = String(e).includes('PARTS_VERDICT_NOT_CLEAN'); }
      check(guarded, 'unchanged server validator refuses approved with pending inputs');
      const measured = await layout(page); assertLayout(measured, pkg.items.map(i => i.name));
      await writeFile(join(out, `synthetic-before-${lang}.png`), await page.screenshot());
      const approved: Submission = { status: 'approved', comments: [], parts: Object.fromEntries(Object.entries(pending.parts).map(([n, p]) => [n, { ...p, outcome: 'clean', ...(p.mesh ? { mesh: { ...p.mesh, outcome: 'clean' } } : {}) }])) };
      check((await save(page, '#pv-approve-all')).result === 'saved', 'fresh approve-all saved');
      check((await wire(page)).length === 1, 'one batch click makes exactly one save');
      await assertSaved(page, pkg, approved); same(await ui(page), { status: approved.status, parts: approved.parts }, 'approved UI refreshed');
      await writeFile(join(out, `synthetic-after-${lang}.png`), await page.screenshot());
      await open(page, server, lang); same(await ui(page), { status: approved.status, parts: approved.parts }, 'approval reopens');
      api.push({ case: 'fresh-' + lang, pendingGuard: true, oneTrustedClickOneSave: true, meshClean: true, persisted: true, expectedInput: approved });
      (report.syntheticVisuals ??= {} as Record<string, unknown>);
      (report.syntheticVisuals as Record<string, unknown>)[lang] = measured;

      // Both refusal subjects use saved evidence, then reopen. Every local field and the saved bytes stay intact.
      for (const subject of ['part', 'mesh']) {
        const flaggedPkg = await load(subject + '-' + lang), flaggedServer = await serve(flaggedPkg);
        await open(page, flaggedServer, lang); await choose(page, 'gap');
        if (subject === 'part') { await click(page, '[data-pv-outcome][value="flagged"]'); await field(page, '#pv-note', 'Keep flagged part 한글', 'input'); }
        else { await field(page, '#pv-mesh-panel select', 'flagged'); await field(page, '#pv-mesh-panel textarea', 'Keep flagged mesh 한글', 'input'); }
        await field(page, '#pv-overall', 'changes-requested'); check((await save(page)).result === 'saved', 'seed flagged evidence through UI');
        const bytes = await readFile(flaggedPkg.verdictPath), seed = (await readVerdict(flaggedPkg)).verdict!;
        await open(page, flaggedServer, lang); const stateBefore = await ui(page);
        const rejected = await save(page, '#pv-approve-all');
        const refusalKey = 'PARTS_APPROVE_ALL_FLAGGED: resolve flagged part and mesh outcomes before approving all.';
        check(rejected.result === 'refused' && rejected.text === (lang === 'ko' ? koCatalog : enCatalog)[refusalKey], 'named localized batch refusal ' + subject);
        check((await wire(page)).length === 0, 'refusal sends no POST');
        same(await ui(page), stateBefore, 'refusal is atomic across every part/mesh/note/overall');
        check(bytes.equals(await readFile(flaggedPkg.verdictPath)), 'refusal leaves disk bytes unchanged');
        let refused = false; try { buildVerdict(flaggedPkg, { ...stateBefore, status: 'approved', comments: seed.comments }, 'oracle'); } catch (e) { refused = String(e).includes('PARTS_VERDICT_NOT_CLEAN'); }
        check(refused, 'server still independently refuses flagged approval');
        await writeFile(join(out, `refused-${subject}-${lang}.png`), await page.screenshot());
        api.push({ case: subject + '-refused-' + lang, noPost: true, noLocalMutation: true, noDiskMutation: true, serverGuard: true, rejected, stateBefore, savedSha256: sha(bytes) });
      }
    }
    // Reviewer text and a real pointed comment survive batch approval unchanged; manual approval still works.
    const pkg = await load('preserve'), server = await serve(pkg);
    await open(page, server, 'en'); await choose(page, 'gap');
    await field(page, '#pv-note', 'Exact note 한글\nsecond line', 'input'); await field(page, '#pv-mesh-panel textarea', 'Exact mesh note 한글', 'input');
    await click(page, '[data-pv-outcome][value="clean"]'); await field(page, '#pv-mesh-panel select', 'clean');
    await addComment(page); check((await save(page)).result === 'saved', 'seed notes/comment');
    const seeded = (await readVerdict(pkg)).verdict!; check(seeded.comments.length === 1, 'nonempty real comment fixture');
    await open(page, server, 'ko'); const state = await ui(page);
    const expected: Submission = { status: 'approved', comments: seeded.comments, parts: Object.fromEntries(Object.entries(state.parts).map(([n, p]) => [n, { ...p, outcome: 'clean', ...(p.mesh ? { mesh: { ...p.mesh, outcome: 'clean' } } : {}) }])) };
    check((await save(page, '#pv-approve-all')).result === 'saved', 'batch preserves existing clean entries');
    const batch = await assertSaved(page, pkg, expected);
    same(batch.source, seeded.source, 'source hash/files/flags unchanged'); same(batch.comments, seeded.comments, 'comments unchanged including hashes/wire evidence');
    await open(page, server, 'en');
    for (const item of pkg.items) { await choose(page, item.name); await click(page, '[data-pv-outcome][value="pending"]'); if (item.mesh) await field(page, '#pv-mesh-panel select', 'pending'); }
    await field(page, '#pv-overall', 'pending'); check((await save(page)).result === 'saved', 'manual pending reset');
    for (const item of pkg.items) { await choose(page, item.name); await click(page, '[data-pv-outcome][value="clean"]'); if (item.mesh) await field(page, '#pv-mesh-panel select', 'clean'); }
    await field(page, '#pv-overall', 'approved'); check((await save(page)).result === 'saved', 'individual approval works');
    const manual = await assertSaved(page, pkg, expected);
    same({ ...manual, updatedAt: batch.updatedAt }, batch, 'manual and batch wire verdicts equivalent');
    api.push({ case: 'notes-comments-and-individual', nonemptyCommentPreserved: true, notesPreserved: true, sourceUnchanged: true, manualEquivalent: true, requests: await wire(page), saved: manual });
    same(await hashes(input), before, 'synthetic source tree unchanged'); report.syntheticSources = before;

    if (publicRoot) {
      const publicPath = await realpath(resolve(publicRoot)), publicBefore = await hashes(publicPath);
      const publicPkg = await loadPartsView(publicPath, { verdict: join(scratch, 'public-head.json') });
      check(publicPkg.mode === 'parts' && publicPkg.items.length === 23, 'public input must be the sealed 23-part package understood by loadPartsView');
      const head = await serve(publicPkg), visuals: Record<string, unknown> = {};
      report.visuals = visuals;
      const capture = async (served: Server, side: 'baseline' | 'after') => {
        for (const lang of ['en', 'ko']) {
          await open(page!, served, lang); const measurement = await layout(page!);
          if (side === 'after') assertLayout(measurement, publicPkg.items.map(i => i.name));
          check((await wire(page!)).length === 0, 'visual capture never submits a verdict');
          const assets = await page!.evaluate<Record<string, string>>(`Promise.all(['/', '/parts.js', '/parts.css'].map(async p=>{const r=await fetch(p);if(!r.ok)throw Error('asset '+p);const b=await r.arrayBuffer();return [p,[...new Uint8Array(await crypto.subtle.digest('SHA-256',b))].map(v=>v.toString(16).padStart(2,'0')).join('')];})).then(Object.fromEntries)`);
          const file = `${side}-${lang}.png`; await writeFile(join(out, file), await page!.screenshot());
          visuals[`${side}-${lang}`] = { screenshot: file, measurement, servedAssets: assets, noSave: true };
        }
      };
      if (baselineRoot) {
        const base = await realpath(resolve(baselineRoot)), metadata = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'));
        check(['rig-review', '@rig-c/review'].includes(metadata.name) && metadata.version === '1.8.0', 'baseline must be installed rig-review or @rig-c/review exactly 1.8.0');
        check(base.split(/[\\/]/).includes('node_modules'), 'baseline must be an isolated installed package');
        const headRoot = await realpath(new URL('..', import.meta.url));
        check(base !== headRoot, 'baseline cannot be current checkout');
        const view = await import(pathToFileURL(join(base, 'src/parts-view.ts')).href) as typeof import('../src/parts-view.ts');
        const serveBase = await import(pathToFileURL(join(base, 'src/parts-server.ts')).href) as typeof import('../src/parts-server.ts');
        check(typeof view.loadPartsView === 'function' && typeof serveBase.startPartsServer === 'function', 'unknown baseline installed source contract');
        const basePkg = await view.loadPartsView(publicPath, { verdict: join(scratch, 'public-baseline.json') });
        same(basePkg.items.map(i => i.name), publicPkg.items.map(i => i.name), 'baseline sees identical 23 source parts');
        const baseline = await serveBase.startPartsServer(basePkg, serverOptions); servers.push(baseline);
        report.baseline = { root: base, name: metadata.name, version: metadata.version, metadataSha256: sha(await readFile(join(base, 'package.json'))) };
        await capture(baseline, 'baseline');
      } else report.baseline = { skipped: 'No --baseline-root supplied; no baseline comparison claim' };
      await capture(head, 'after'); same(await hashes(publicPath), publicBefore, 'sealed public tree unchanged');
      report.visuals = visuals; report.publicSources = publicBefore;
    } else report.visuals = { skipped: 'No --public-root supplied; synthetic screenshots only' };
    report.pass = true;
  } catch (error) {
    report.error = String(error);
    if (page) { try { await writeFile(join(out, 'failure.png'), await page.screenshot()); } catch {} }
    throw error;
  } finally {
    try { await page?.close(); } finally {
      for (const server of servers) server.stop(true);
      await mkdir(out, { recursive: true }); await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      await rm(profile, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); await rm(join(root, 'state'), { recursive: true, force: true });
      if (previousState === undefined) delete process.env.RIG_REVIEW_STATE_DIR; else process.env.RIG_REVIEW_STATE_DIR = previousState;
      console.log('PARTS_395_BROWSER ' + JSON.stringify({ pass: report.pass, report: join(out, 'report.json'), out }));
    }
  }
}
if (import.meta.main) await main();
