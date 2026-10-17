import { readFile } from 'node:fs/promises';
function version(text:string,label:string):string {
  const value=JSON.parse(text) as {version?:unknown};
  if(typeof value.version!=='string'||!value.version)throw new Error(`${label}: package version missing`);
  return value.version;
}
/** Read installed tool versions; never treat a producer report's generic version as one. */
export async function toolVersions():Promise<{viewerVersion:string;runtimeVersion:string}>{
  const viewerVersion=version(await readFile(new URL('../package.json',import.meta.url),'utf8'),'review');
  const runtimePackage=new URL('../node_modules/@rig-c/play/package.json',import.meta.url);
  const runtimeVersion=version(await readFile(runtimePackage,'utf8'),'@rig-c/play');
  return {viewerVersion,runtimeVersion};
}
