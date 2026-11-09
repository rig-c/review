import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
function version(text:string,label:string):string {
  const value=JSON.parse(text) as {version?:unknown};
  if(typeof value.version!=='string'||!value.version)throw new Error(`${label}: package version missing`);
  return value.version;
}
/** The runtime's manifest wherever the installer put it: nested in a checkout, hoisted beside this package in an install, or symlinked to a peer checkout. */
export function playPackagePath(root:string=fileURLToPath(new URL('.',import.meta.url))):string {
  let dir=dirname(Bun.resolveSync('@rig-c/play',root));
  for(;;){const candidate=join(dir,'package.json');if(existsSync(candidate)){try{if((JSON.parse(readFileSync(candidate,'utf8')) as {name?:unknown}).name==='@rig-c/play')return candidate;}catch{}}const parent=dirname(dir);if(parent===dir)throw new Error('@rig-c/play: package.json not found from resolved entry');dir=parent;}
}
/** Read installed tool versions; never treat a producer report's generic version as one. */
export async function toolVersions(root?:string):Promise<{viewerVersion:string;runtimeVersion:string}>{
  const viewerVersion=version(await readFile(new URL('../package.json',import.meta.url),'utf8'),'review');
  const runtimeVersion=version(await readFile(playPackagePath(root),'utf8'),'@rig-c/play');
  return {viewerVersion,runtimeVersion};
}
