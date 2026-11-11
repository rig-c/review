import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const appRoot=fileURLToPath(new URL('..',import.meta.url));
export const PLAY_SOURCE_CONDITION='@rig-c/source';
export function playBuildConditions(root:string=appRoot):string[] {
  try{return /[\\/]src[\\/]index\.ts$/.test(Bun.resolveSync('@rig-c/play',root))?[PLAY_SOURCE_CONDITION]:[];}
  catch{return [];}
}
/** #706: the one entry (`web/index.html`) marked for a screen that opens in Setup with the parts mode only. The marker
 * and asset names are trusted constants; no request or package data is interpolated. */
export async function setupEntryHtml(screen:'parts'|'stage-parts',assets:{script:string;styles:string}={script:'main.js',styles:'styles.css'},root:string=appRoot):Promise<string> {
  const html=await Bun.file(join(root,'web/index.html')).text();
  const marked=html.replace('<div id="app"></div>',`<div id="app" data-review-screen="${screen}"></div>`).replace('href="styles.css"',`href="${assets.styles}"`).replace('src="main.js"',`src="${assets.script}"`);
  if(marked===html||!marked.includes(`data-review-screen="${screen}"`))throw new Error('SETUP_ENTRY_MARKER_MISSING');
  return marked;
}
export async function buildWeb(mode:'single'|'compare'|'interview'|'workspace'|'job-hub'='single',root:string=appRoot):Promise<Blob> {
  const conditions=playBuildConditions(root);
  const entry=join(root,mode==='job-hub'?'web/job-hub.ts':mode==='workspace'?'web/owner-workspace.ts':mode==='compare'?'web/compare.ts':mode==='interview'?'web/interview.ts':'web/main.ts');
  const result=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',minify:false,...(conditions.length?{conditions}:{})});
  if(!result.success)throw new Error(result.logs.map(v=>v.message).join('\n'));
  const output=result.outputs.find(v=>v.path.endsWith('.js'));if(!output)throw new Error('frontend bundle: JavaScript output missing');return output;
}
if(import.meta.main){await buildWeb();await buildWeb('compare');console.log('Frontend bundles built successfully (single and compare).');}
