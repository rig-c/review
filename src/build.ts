import { fileURLToPath } from 'node:url';
export const appRoot=fileURLToPath(new URL('..',import.meta.url));
export async function buildWeb(mode:'single'|'compare'='single'):Promise<Blob> {
  const result=await Bun.build({entrypoints:[appRoot+(mode==='compare'?'web/compare.ts':'web/main.ts')],target:'browser',format:'esm',minify:false});
  if(!result.success)throw new Error(result.logs.map(v=>v.message).join('\n'));
  const output=result.outputs.find(v=>v.path.endsWith('.js'));if(!output)throw new Error('frontend bundle: JavaScript output missing');return output;
}
if(import.meta.main){await buildWeb();await buildWeb('compare');console.log('Frontend bundles built successfully (single and compare).');}
