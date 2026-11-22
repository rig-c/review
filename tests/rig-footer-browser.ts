import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {loadReview} from '../src/manifest.ts';
import {startServer} from '../src/server.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';
import {clickPartsViewControl as click} from './helpers/parts-view-shots.ts';
import {withDeadline} from './helpers/walk-deadline.ts';
import {launchCdpSession, type InputCdpSession} from './parts-explorer-browser.ts';

const help = 'Record review status and structured feedback while preserving sources. Motion is read only.';
const widths = [1440, 1600, 1920];
const outFlag = Bun.argv.indexOf('--out');
const output = resolve(outFlag < 0 ? 'artifacts/rig-footer' : Bun.argv[outFlag + 1]!);

interface Box {left: number; right: number; top: number; bottom: number}
interface Sample {
  width: number;
  language: 'en' | 'ko';
  help: Box;
  helpText: Box;
  rightGroup: Box;
  intersects: boolean;
  title: string;
  readouts: {id: string; text: string; box: Box}[];
  footer: {x: number; y: number; width: number; height: number};
}

const measure = `(() => {
  const footer = document.querySelector('footer.status-bar');
  const message = footer.querySelector('.status-message');
  const box = node => node.getBoundingClientRect().toJSON();
  const range = document.createRange();
  range.selectNodeContents(message);
  const help = box(message), helpText = box(range);
  const readouts = [...footer.querySelectorAll('.status-readouts > *, .status-source')]
    .filter(node => node.getClientRects().length)
    .map(node => ({id: node.id, text: node.textContent, box: box(node)}));
  const rightGroup = {
    left: Math.min(...readouts.map(item => item.box.left)),
    right: Math.max(...readouts.map(item => item.box.right)),
    top: Math.min(...readouts.map(item => item.box.top)),
    bottom: Math.max(...readouts.map(item => item.box.bottom)),
  };
  const intersects = help.left < rightGroup.right && help.right > rightGroup.left &&
    help.top < rightGroup.bottom && help.bottom > rightGroup.top;
  const {x, y, width, height} = box(footer);
  return {width: innerWidth, language: document.documentElement.lang, help, helpText, rightGroup,
    intersects, title: message.title, readouts, footer: {x, y: y + scrollY, width, height}};
})()`;

await mkdir(output, {recursive: true});
const scratch = await mkdtemp(join(tmpdir(), 'review-rig-footer-'));
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let page: InputCdpSession | undefined;
try {
  const packageDir = join(scratch, 'package');
  await cp('tests/fixtures/viewport-387/package', packageDir, {recursive: true});
  const manifestPath = join(packageDir, 'review.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // The original Animate reproduction had no reference, so the layout readout includes its fallback reason.
  await writeFile(manifestPath, JSON.stringify({...manifest, references: []}));
  const fixture = await loadReview(packageDir);
  server = await startServer(fixture, {port: 0, stateDir: join(scratch, 'state')});
  page = await launchCdpSession(join(scratch, 'chrome'), {browserArgs: ['--renderer-process-limit=2']});
  const browser = page;
  const samples: Sample[] = [];
  for (const lang of ['en', 'ko'] as const) {
    const catalog = lang === 'ko' ? koCatalog : enCatalog;
    await browser.setViewport(1600, 1000);
    await browser.goto(`http://127.0.0.1:${server.port}/?lang=${lang}`, lang);
    await withDeadline('rig footer ready', 20_000, async signal => {
      while (!signal.aborted) {
        if (await browser.evaluate<boolean>(`document.querySelector('#message')?.textContent === ${JSON.stringify(catalog[help])}`)) return;
        await Bun.sleep(25);
      }
      throw signal.reason;
    });
    await click(browser, '[data-mode="playback"]');
    assert.equal(await browser.evaluate(`document.querySelector('[data-mode="playback"]').getAttribute('aria-pressed')`), 'true');

    for (const width of widths) {
      await browser.setViewport(width, 1000);
      await browser.evaluate('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      const sample: Sample = await browser.evaluate<Sample>(measure);
      assert.equal(sample.width, width);
      assert.equal(sample.language, lang);
      assert.equal(sample.title, catalog[help]);
      assert.ok(sample.readouts.some(item => item.id === 'player-state' && item.text.includes('@rig-c/play')));
      samples.push(sample);
      if (width === 1600) await writeFile(join(output, lang + '.png'), await browser.screenshot(sample.footer));
    }
  }
  await writeFile(join(output, 'geometry.json'), JSON.stringify(samples, null, 2) + '\n');
  for (const {width, language, help, rightGroup, intersects} of samples) {
    console.log('RIG_FOOTER_GEOMETRY', JSON.stringify({width, language, help, rightGroup, intersects}));
  }
  assert.equal(samples.find(sample => sample.width === 1600 && sample.language === 'ko')?.intersects, false,
    'RIG_FOOTER_1600_KO: help overlaps the right status group');
  assert.ok(samples.every(sample => !sample.intersects), 'RIG_FOOTER_INTERSECTION: help and status must stay separate');
} finally {
  try { await page?.close(); }
  finally {
    server?.stop(true);
    await rm(scratch, {recursive: true, force: true});
  }
}
