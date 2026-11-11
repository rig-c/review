/** Synthetic #645 transport fixture. No accepted manifest, producer export or metric is regenerated. */
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {jobHash} from '../../src/job-api.ts';
import type {JobPartsIdentity} from '../../src/job-contract.ts';
import {jobFixture, syntheticJobParts} from './job-api-fixture.ts';
import {writeDifferencePackage} from './parts-difference-package.ts';

export async function write645SidecarPackage(root: string) {
  const raster = await writeDifferencePackage(root, true);
  const manifest = JSON.parse(await readFile(join(root, 'parts.json'), 'utf8'));
  const inline = manifest.painting_in_rig;
  delete manifest.painting_in_rig;
  // Authored synthetic parser fields, not producer-computed quality measurements.
  manifest.ghost_px = {};
  for (const part of manifest.parts) Object.assign(part, {from: 'painting:' + part.name,
    opaque_px: 0, projected_core_px: 0, source_px_taken: 0, refused_drift_px: 0, merged_px: 0, seam_override_px: 0});
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(root, 'parts.json'), manifestBytes);
  const sidecar = {schema: 'rig-parts-painting-reference/1', manifest_sha256: jobHash(manifestBytes),
    ...inline, rig_size: manifest.rig_size};
  const sidecarBytes = Buffer.from(JSON.stringify(sidecar, null, 2) + '\n');
  await writeFile(join(root, 'painting_in_rig.json'), sidecarBytes);
  return {...raster, manifest, manifestBytes, sidecar, sidecarBytes};
}

export async function job645SidecarFixture() {
  const entry = '@rig-c/parts/src/parts.ts';
  const partsModule = await import(entry);
  const installed = JSON.parse(await readFile(new URL('../../node_modules/@rig-c/parts/package.json', import.meta.url), 'utf8'));
  const f = await jobFixture({partsEnumerator: {version: installed.version, enumerate: partsModule.partsFileReferences}});
  try {
    await syntheticJobParts(f, {project: true});
    const dir = join(f.root, 'standalone'), packet = await write645SidecarPackage(dir);
    const references = partsModule.partsFileReferences(dir) as {path: string; role: string}[];
    const images = await Promise.all(references.map(async row => ({...row, sha256: jobHash(await readFile(join(dir, row.path)))})));
    const parts: JobPartsIdentity = {enumeratorVersion: installed.version,
      manifest: {path: 'standalone/parts.json', sha256: jobHash(packet.manifestBytes)}, images};
    const files = [{path: 'standalone/painting_in_rig.json', sha256: jobHash(packet.sidecarBytes)},
      {path: 'standalone/' + packet.sidecar.path, sha256: packet.sidecar.sha256}];
    f.setContext({...f.getContext(), parts, files, partIds: packet.manifest.parts.map((part: {name: string}) => part.name)});
    return {f, dir, packet, parts, files};
  } catch (error) {await f.close(); throw error;}
}
