import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {jobHash} from '../../src/job-api.ts';
import {scriptedJobWindowFixture} from './job-window-fixture.ts';
import {writeDifferencePackage} from './parts-difference-package.ts';

/** Public synthetic parts draft, including the edited_parts receipt from #887. */
export async function partsDifferenceJobFixture(options: {
  declared?: boolean;
  previousDraft?: boolean;
  scratchParent?: string;
} = {}) {
  const f = await scriptedJobWindowFixture({c5Parts: 'no-mesh', scratchParent: options.scratchParent});
  try {
    const source = await writeDifferencePackage(f.packageRoot, true);
    // RGB is a valid producer operand: its original file bytes remain the bound identity.
    const rgb = PNG.sync.write(source.part, {colorType: 2, inputColorType: 6});
    const bytes = rgb;
    await writeFile(join(f.packageRoot, 'parts/body.png'), bytes);
    await mkdir(join(f.packageRoot, 'edited'), {recursive: true});
    await writeFile(join(f.packageRoot, 'edited/body.png'), bytes);
    const config = {assemble: {edited_parts: {dir: 'edited', receipts: [{file: 'body.png'}]}}};
    await writeFile(join(f.packageRoot, 'config.json'), JSON.stringify(config));
    const manifestPath = join(f.packageRoot, 'parts.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (options.declared === false) {delete manifest.painting_in_rig; await writeFile(manifestPath, JSON.stringify(manifest));}
    const context = f.input.getContext();
    const references = [...context.parts!.images.map(({path, role}) => ({path, role})),
      ...options.declared === false ? [] : [{path: 'painting_in_rig.png', role: 'painting' as const}]];
    const images = await Promise.all(references.map(async image => ({...image,
      sha256: jobHash(await readFile(join(f.packageRoot, image.path)))})));
    const additions = ['config.json', 'edited/body.png'].map(path => 'out/' + path);
    const files = [...context.files.filter(file => !additions.includes(file.path)),
      ...await Promise.all(additions.map(async path => ({path, sha256: jobHash(await readFile(join(f.input.root, path)))})))];
    const part = PNG.sync.read(rgb);
    const previousDraft = options.previousDraft ? await writePreviousDraft(f.input.root, source, part) : undefined;
    if (previousDraft) files.push(previousDraft.composites.current, previousDraft.composites.previous);
    f.input.setPartsReferences(references);
    f.input.setContext({...context, files, parts: {...context.parts!, images,
      manifest: {...context.parts!.manifest, sha256: jobHash(await readFile(manifestPath))}},
      ...(previousDraft ? {previousDraft} : {})});
    const publication = await f.publish('parts');
    const display = f.host.session.displayPublication(publication.publicationId);
    return {...f, publication, api: f.host.origin + display.routes.apiBase,
      operand: bytes, part, source, previousDraft};
  } catch (error) {await f.close(); throw error;}
}

export const previousDraftScratch = join(homedir(), 'Library/Caches/rig-lanes/review-914');
export const previousDraftRasterSize = {width: 32, height: 24};
// Literal expected pixels independent of Review's renderer. Including both-alpha-zero
// hidden RGB, a lost silhouette, and an alpha-only change rules out the painting loop.
export const previousDraftRasterProbes = [
  {name: 'lost silhouette', x: 3, y: 7, rgba: [255, 0, 0, 255]},
  {name: 'alpha only', x: 11, y: 7, rgba: [75, 0, 0, 255]},
  {name: 'RGB change', x: 9, y: 16, rgba: [31, 0, 0, 255]},
  {name: 'added silhouette', x: 5, y: 11, rgba: [255, 0, 0, 255]},
  {name: 'unchanged opaque', x: 16, y: 10, rgba: [0, 0, 0, 255]},
  {name: 'both transparent', x: 1, y: 1, rgba: [0, 0, 0, 0]},
] as const;

async function writePreviousDraft(root: string, source: Awaited<ReturnType<typeof writeDifferencePackage>>, part: PNG) {
  const current = new PNG({...previousDraftRasterSize});
  const previous = new PNG({...previousDraftRasterSize});
  PNG.bitblt(part, current, 0, 0, part.width, part.height, source.body.x, source.body.y);
  PNG.bitblt(source.cover, current, 0, 0, source.cover.width, source.cover.height, source.front.x, source.front.y);
  current.data.copy(previous.data);
  const offset = (x: number, y: number) => (y * current.width + x) * 4;
  for (let y = 5; y <= 10; y++) {
    previous.data.set([68, 82, 100, 255], offset(3, y));
    for (let x = 10; x <= 12; x++) previous.data[offset(x, y) + 3] = 180;
  }
  for (let x = 7; x <= 12; x++) previous.data[offset(x, 16)]! -= 31;
  previous.data.fill(0, offset(5, 11), offset(5, 11) + 4);
  previous.data.set([255, 60, 20, 0], offset(1, 1));
  await mkdir(join(root, 'draft-composites'));
  async function seal(path: string, png: PNG) {
    const bytes = PNG.sync.write(png);
    await writeFile(join(root, path), bytes);
    return {path, sha256: jobHash(bytes)};
  }
  return {
    schema: 'rig-review-previous-draft/1' as const,
    draft: {id: 'synthetic-accepted', revision: jobHash('synthetic accepted draft revision')},
    composites: {
      current: await seal('draft-composites/current.png', current),
      previous: await seal('draft-composites/previous.png', previous),
    },
  };
}

export function partsDifferenceOwnerUrl(fixture: Awaited<ReturnType<typeof partsDifferenceJobFixture>>, lang: 'en' | 'ko') {
  const url = new URL(fixture.host.ownerUrl);
  url.searchParams.set('lang', lang);
  return url.href;
}

/** Run from the Review checkout. Owner URLs contain temporary UI capabilities. */
async function serveFixtures() {
  const args = Bun.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--without-previous-draft') {
    throw new Error('Usage: bun tests/helpers/parts-difference-job-fixture.ts [--without-previous-draft]');
  }
  await mkdir(previousDraftScratch, {recursive: true});
  const fixtures: Awaited<ReturnType<typeof partsDifferenceJobFixture>>[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>(resolve => {stop = resolve;});
  let interrupted = false;
  const interrupt = () => {interrupted = true; stop();};
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const previousDraft of args.length ? [false] : [true, false]) {
      if (interrupted) break;
      const fixture = await partsDifferenceJobFixture({previousDraft, scratchParent: previousDraftScratch});
      fixtures.push(fixture);
      await fixture.ask(fixture.publication, {kind: 'parts-verdict', draftId: 'synthetic-parts'});
      const label = previousDraft ? 'with-previous-draft' : 'without-previous-draft';
      console.log(label + ' state ' + fixture.input.state);
      for (const lang of ['en', 'ko'] as const) console.log(label + ' ' + lang + ' ' + partsDifferenceOwnerUrl(fixture, lang));
    }
    if (!interrupted) console.log('Press Ctrl-C to stop the fixture hosts and remove their private scratch directories.');
    await stopped;
  } finally {
    const results = await Promise.allSettled(fixtures.map(fixture => fixture.close()));
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}

if (import.meta.main) await serveFixtures();
