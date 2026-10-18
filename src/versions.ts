import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
function version(text:string,label:string):string {
  const value=JSON.parse(text) as {version?:unknown};
  if(typeof value.version!=='string'||!value.version)throw new Error(`${label}: package version missing`);
  return value.version;
}
/** The runtime's manifest wherever the installer put it: nested in a checkout, hoisted beside this package in an install. */
export function playPackagePath():string {
  let dir=dirname(Bun.resolveSync('@rig-c/play',fileURLToPath(new URL('.',import.meta.url))));
  for(;;){const candidate=join(dir,'package.json');if(existsSync(candidate)&&dirname(candidate).endsWith(join('@rig-c','play')))return candidate;const parent=dirname(dir);if(parent===dir)throw new Error('@rig-c/play: package.json not found from resolved entry');dir=parent;}
}
/** Read installed tool versions; never treat a producer report's generic version as one. */
export async function toolVersions():Promise<{viewerVersion:string;runtimeVersion:string}>{
  const viewerVersion=version(await readFile(new URL('../package.json',import.meta.url),'utf8'),'review');
  const runtimeVersion=version(await readFile(playPackagePath(),'utf8'),'@rig-c/play');
  return {viewerVersion,runtimeVersion};
}
