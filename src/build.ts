import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const appRoot=fileURLToPath(new URL('..',import.meta.url));
export const PLAY_SOURCE_CONDITION='@rig-c/source';
export function playBuildConditions(root:string=appRoot):string[] {
  try{return /[\\/]src[\\/]index\.ts$/.test(Bun.resolveSync('@rig-c/play',root))?[PLAY_SOURCE_CONDITION]:[];}
  catch{return [];}
}
export async function buildWeb(mode:'single'|'compare'|'parts'|'interview'|'workspace'|'job-hub'='single',root:string=appRoot):Promise<Blob> {
  const conditions=playBuildConditions(root);
  const entry=join(root,mode==='job-hub'?'web/job-hub.ts':mode==='workspace'?'web/owner-workspace.ts':mode==='compare'?'web/compare.ts':mode==='parts'?'web/parts-page.ts':mode==='interview'?'web/interview.ts':'web/main.ts');
  const result=await Bun.build({entrypoints:[entry],target:'browser',format:'esm',minify:false,...(conditions.length?{conditions}:{})});
  if(!result.success)throw new Error(result.logs.map(v=>v.message).join('\n'));
  const output=result.outputs.find(v=>v.path.endsWith('.js'));if(!output)throw new Error('frontend bundle: JavaScript output missing');return output;
}
if(import.meta.main){await buildWeb();await buildWeb('compare');await buildWeb('parts');console.log('Frontend bundles built successfully (single, compare and parts).');}
