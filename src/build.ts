import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const appRoot=fileURLToPath(new URL('..',import.meta.url));
export const PLAY_SOURCE_CONDITION='@rig-c/source';
export function playBuildConditions(root:string=appRoot):string[] {
  try{return /[\\/]src[\\/]index\.ts$/.test(Bun.resolveSync('@rig-c/play',root))?[PLAY_SOURCE_CONDITION]:[];}
  catch{return [];}
}
export type EntryScreen='rig'|'parts'|'compare'|'job'|'workspace';
/** #655, #706: the one entry (`web/index.html`) for every index.html route. Unmarked screens keep exact `web/index.html`
 * bytes. The marker and asset names are trusted constants. */
export async function entryHtml(screen:EntryScreen,assets:{script:string;styles:string}={script:'main.js',styles:'styles.css'},root:string=appRoot):Promise<string> {
  const html=await Bun.file(join(root,'web/index.html')).text();
  if(!html.includes('<div id="app"></div>')||!html.includes('href="styles.css"')||!html.includes('src="main.js"'))throw new Error('SETUP_ENTRY_MARKER_MISSING');
  const marked=screen==='parts'||screen==='compare'||screen==='workspace'?html.replace('<div id="app"></div>',`<div id="app" data-review-screen="${screen}"></div>`):html;
  const titled=screen==='compare'?marked.replace('<title>rig review</title>','<title>rig review · compare</title>'):marked;
  return titled.replace('href="styles.css"',`href="${assets.styles}"`).replace('src="main.js"',`src="${assets.script}"`);
}
export async function buildWeb(root:string=appRoot):Promise<Blob> {
  const conditions=playBuildConditions(root);
  const entry=join(root,'web/main.ts');
  const result=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',minify:false,...(conditions.length?{conditions}:{})});
  if(!result.success)throw new Error(result.logs.map(v=>v.message).join('\n'));
  const output=result.outputs.find(v=>v.path.endsWith('.js'));if(!output)throw new Error('frontend bundle: JavaScript output missing');return output;
}
if(import.meta.main){await buildWeb();console.log('Frontend bundle built successfully.');}
