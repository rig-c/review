import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { loadReview, object, safeFile, string, type ReviewManifest, type ReviewedSource, type ReviewPackage } from './manifest.ts';
import type { FeedbackCatalog } from './feedback-validation.ts';
import type { ReportSeeds } from './report.ts';

export interface CompareInputs {a:string;b:string;reference:string;animation:string}
export interface CompareBinding {
  a:{sourceHash:string;reviewedSource:ReviewedSource};
  b:{sourceHash:string;reviewedSource:ReviewedSource};
  reference:{name:string;sha256:string};animation:string;
}
export interface CompareSide {manifest:ReviewManifest;report:ReportSeeds|null;feedbackCatalog:FeedbackCatalog;sourceHash:string;reviewedSource:ReviewedSource;assetsBase:'/compare-assets/a/'|'/compare-assets/b/'}
export interface CompareResponse {mode:'compare';id:string;title:string;revision:'compare/1';sourceHash:string;binding:CompareBinding;animation:string;a:CompareSide;b:CompareSide;reference:{name:string;sha256:string;url:'/compare-reference'}}
export interface ComparePackage {inputs:CompareInputs;a:ReviewPackage;b:ReviewPackage;referencePath:string;response:CompareResponse}

async function hashFile(path:string):Promise<string>{
  const before=await stat(path);if(!before.isFile())throw new Error('compare.reference: expected regular local video file');
  const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);
  const after=await stat(path);if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('compare.reference changed while hashing');return hash.digest('hex');
}
async function requireAnimation(p:ReviewPackage,animation:string,side:'a'|'b'):Promise<void>{
  if(!p.manifest.model||!p.reviewedSource.rig)throw new Error(`compare.${side}.model: expected compiled model for playback`);
  const bytes=await readFile(await safeFile(p.root,p.manifest.model));
  if(createHash('sha256').update(bytes).digest('hex')!==p.reviewedSource.rig.sha256)throw new Error(`compare.${side} inputs changed while reading animation`);
  const model=object(JSON.parse(bytes.toString('utf8')),`compare.${side}.model`);
  if(!Array.isArray(model.animations))throw new Error(`compare.${side}.model.animations: expected array`);
  const found=model.animations.map((value,i)=>object(value,`compare.${side}.animations[${i}]`)).find(value=>value.name===animation);
  if(!found)throw new Error(`compare.${side}.animation: model has no animation ${JSON.stringify(animation)}`);
  if(typeof found.duration!=='number'||!Number.isFinite(found.duration)||found.duration<0)throw new Error(`compare.${side}.animation.duration: expected finite number >= 0`);
}

/** Three explicit local inputs; a package manifest cannot select the external reference. */
export async function loadCompare(inputs:CompareInputs):Promise<ComparePackage>{
  const animation=string(inputs.animation,'compare.animation');
  const [a,b,referencePath]=await Promise.all([loadReview(inputs.a),loadReview(inputs.b),realpath(resolve(inputs.reference))]);
  if(!/\.(mp4|webm|mov)$/i.test(referencePath))throw new Error('compare.reference: expected local mp4, webm or mov file');
  await Promise.all([requireAnimation(a,animation,'a'),requireAnimation(b,animation,'b')]);
  const reference={name:basename(referencePath),sha256:await hashFile(referencePath)};
  const binding:CompareBinding={a:{sourceHash:a.sourceHash,reviewedSource:a.reviewedSource},b:{sourceHash:b.sourceHash,reviewedSource:b.reviewedSource},reference,animation};
  const sourceHash=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
  return {inputs:{a:a.manifestPath,b:b.manifestPath,reference:referencePath,animation},a,b,referencePath,response:{mode:'compare',id:'compare-'+sourceHash.slice(0,16),title:`${a.manifest.title} / ${b.manifest.title}`,revision:'compare/1',sourceHash,binding,animation,a:{manifest:a.manifest,report:a.report,feedbackCatalog:a.feedbackCatalog,sourceHash:a.sourceHash,reviewedSource:a.reviewedSource,assetsBase:'/compare-assets/a/'},b:{manifest:b.manifest,report:b.report,feedbackCatalog:b.feedbackCatalog,sourceHash:b.sourceHash,reviewedSource:b.reviewedSource,assetsBase:'/compare-assets/b/'},reference:{...reference,url:'/compare-reference'}}};
}

export async function assertCompareUnchanged(p:ComparePackage):Promise<void>{
  try{const current=await loadCompare(p.inputs);if(current.response.sourceHash!==p.response.sourceHash)throw new Error('source hash differs');}
  catch(e){throw new Error(`Comparison inputs changed. Restart compare to bind feedback to current inputs. ${e instanceof Error?e.message:String(e)}`);}
}

/** Re-resolve the one CLI-selected reference before each byte-range read. */
export async function safeCompareReference(p:ComparePackage):Promise<string>{
  const current=await realpath(p.referencePath);
  if(current!==p.referencePath||!(await stat(current)).isFile())throw new Error('compare.reference: expected the originally selected canonical regular file (no symlink replacement)');
  return current;
}
