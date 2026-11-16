import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {jobHash} from '../../src/job-api.ts';
import {scriptedJobWindowFixture} from './job-window-fixture.ts';
import {writeDifferencePackage} from './parts-difference-package.ts';

/** Public parts-built draft, including the edited_parts file receipt from #887. */
export async function partsDifferenceJobFixture(options: {declared?: boolean} = {}) {
  const f = await scriptedJobWindowFixture({c5Parts: 'no-mesh'});
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
    f.input.setPartsReferences(references);
    f.input.setContext({...context, files, parts: {...context.parts!, images,
      manifest: {...context.parts!.manifest, sha256: jobHash(await readFile(manifestPath))}}});
    const publication = await f.publish('parts');
    const display = f.host.session.displayPublication(publication.publicationId);
    return {...f, publication, api: f.host.origin + display.routes.apiBase,
      operand: bytes, part: PNG.sync.read(rgb), source};
  } catch (error) {await f.close(); throw error;}
}
