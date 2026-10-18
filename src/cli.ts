#!/usr/bin/env bun
import { loadReview } from './manifest.ts';
import {loadReferencedReview,selectedReference,assertReviewUnchanged} from './reference.ts';
import {shellWord} from './open-shell.ts';
import {openReview,loadOpenPackage,defaultStateDir,type OpenInputs} from './open.ts';
import { readFeedbackSession, readFeedbackCompareSession } from './session-history.ts';
import { startServer } from './server.ts';
import { loadCompare } from './compare.ts';
import { startCompareServer } from './compare-server.ts';
import { readSession, type Feedback } from './session.ts';
import { readCompareSession } from './compare-session.ts';
import { exportReviewStrip, exportCompareStrip, stripJson, writeStripOutput, validateStripOutput } from './strip-export.ts';
import type { StripInterval, StripRequest } from './strip.ts';
const usage='Usage: rig-review open <dir> [--reference <video>] [--compare <dir>] [--animation <name>]\n       rig-review feedback <dir> [--reference <video>] [--compare <dir>] [--animation <name>]\n       Usage: bun run review -- <review.json|output-directory> [--port 4317] [--checkpoint ID]\n       bun run check -- <review.json|output-directory>\n       bun run feedback -- <review.json|output-directory>\n       bun run review -- compare <a> <b> --reference <video> --animation <name> [--port 4317]\n       bun run check -- compare <a> <b> --reference <video> --animation <name>\n       bun run feedback -- compare <a> <b> --reference <video> --animation <name>';
async function stripCommand(args:string[],options:{stateDir?:string}){
  const compare=args[0]==='compare';if(compare)args.shift();const a=args.shift(),b=compare?args.shift():undefined;if(!a||compare&&!b)throw new Error('strip: expected package input(s)');
  let reference:string|undefined,referenceVideo:string|undefined,animation:string|undefined,basis:'a'|'b'|undefined,range:string|undefined,output:string|undefined,jsonOnly=false,all=false;
  while(args.length){const flag=args.shift();if(flag==='--json'){jsonOnly=true;continue;}if(flag==='--all-feedback'){all=true;continue;}const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--reference')reference=value;else if(flag==='--reference-video')referenceVideo=value;else if(flag==='--animation')animation=value;else if(flag==='--basis'){if(value!=='a'&&value!=='b')throw new Error('strip --basis: expected a | b');basis=value;}else if(flag==='--frames')range=value;else if(flag==='--out')output=value;else throw new Error(`Unknown strip option ${flag}`);}
  if(!animation||(!reference&&!referenceVideo))throw new Error('strip: --animation and explicit --reference are required (single uses declared reference id, compare uses local video)');
  if(all===!!range)throw new Error('strip: choose exactly one --frames FIRST:LAST or --all-feedback');
  if(all&&basis)throw new Error('strip --basis: use with --frames; feedback batches retain each recorded side');
  if(!jsonOnly&&!output)throw new Error('strip: PNG requires --out outside source packages');
  let intervals:StripInterval[]=[];
  if(range){const match=/^(\d+):(\d+)$/.exec(range);if(!match)throw new Error('strip --frames: expected inclusive FIRST:LAST');if(compare&&!basis)throw new Error('strip --basis: explicitly select a | b');intervals=[{id:'selection',basis:compare?basis!:'single',frameStart:Number(match[1]),frameEnd:Number(match[2])}];}
  const request=(hash:string):StripRequest=>({format:jsonOnly?'json':'png',sourceHash:hash,animation:animation!,...(compare?{}:{referenceId:reference}),intervals});
  const fromFeedback=(feedback:(Feedback&{side?:'a'|'b'})[])=>feedback.map(f=>{const context=f.context;if(!context||typeof context!=='object'||Array.isArray(context)||context.animation!==animation)throw new Error('strip --all-feedback: every interval must identify the selected animation');return {id:f.id,feedbackId:f.id,basis:compare?f.side!:'single' as const,frameStart:f.frameStart,frameEnd:f.frameEnd};});
  let result,roots:string[];
  if(compare){if(referenceVideo)throw new Error('strip compare: use --reference local-video');const p=await loadCompare({a,b:b!,reference:reference!,animation});roots=[p.a.root,p.b.root];if(all)intervals=fromFeedback((await readCompareSession(p,options.stateDir)).feedback);if(output){await validateStripOutput(output,roots);if(!jsonOnly)await validateStripOutput(output+'.json',roots);}result=await exportCompareStrip(p,request(p.response.sourceHash));}
  else {if(basis)throw new Error('strip --basis: single package uses single basis');const p=await loadReferencedReview(a,referenceVideo);if(!reference)reference=selectedReference(p)?.binding.reference.id;roots=[p.root];if(all)intervals=fromFeedback((await readSession(p,options.stateDir)).feedback);if(output){await validateStripOutput(output,roots);if(!jsonOnly)await validateStripOutput(output+'.json',roots);}result=await exportReviewStrip(p,request(p.sourceHash));}
  if(output){await writeStripOutput(result,output,roots);console.log(`Strip exported: ${output}${result.png?' (PNG + .json provenance)':''}`);}else console.log(stripJson(result).trimEnd());
}
export function parseOpenInputs(args:string[]):OpenInputs {const input=args.shift();if(!input||input.startsWith('--'))throw new Error(usage);const result:OpenInputs={input};const seen=new Set<string>();while(args.length){const flag=args.shift()!,value=args.shift();if(!value||value.startsWith('--'))throw new Error(`Missing value for ${flag}`);if(seen.has(flag))throw new Error(`Duplicate open option ${flag}`);seen.add(flag);if(flag==='--reference')result.reference=value;else if(flag==='--compare')result.compare=value;else if(flag==='--animation')result.animation=value;else throw new Error(`Unknown open option ${flag}`);}return result;}
export async function main(args:string[],options:{stateDir?:string}={}){
  options={stateDir:options.stateDir??defaultStateDir()};args=args.filter(v=>v!=='--');
  if(args[0]==='open'){args.shift();if(args.includes('--help')||args.includes('-h')){console.log(usage);return;}const inputs=parseOpenInputs(args);const result=await openReview(inputs,options);console.log(result.url);console.error(`Review ${result.reused?'reused':'started'}; feedback: rig-review feedback ${[result.inputs.input,...(result.inputs.compare?['--compare',result.inputs.compare]:[]),...(result.inputs.reference?['--reference',result.inputs.reference]:[]),...(result.inputs.animation?['--animation',result.inputs.animation]:[])].map(shellWord).join(' ')}`);return;}
  if(args[0]==='strip'){args.shift();if(args.includes('--help')){console.log(usage+'\nStrip: strip <package> --reference <declared-video-id> --animation <name> (--frames FIRST:LAST | --all-feedback) [--json] [--out path]\n       strip compare <a> <b> --reference <video> --animation <name> --basis a|b (--frames FIRST:LAST | --all-feedback) [--json] [--out path]');return;}return stripCommand(args,options);}let command:'review'|'check'|'feedback'='review';if(args[0]==='check'||args[0]==='feedback'){command=args.shift() as 'check'|'feedback';}
  if(args.includes('--help')||args.includes('-h')){console.log(usage);return;}
  if(args[0]==='compare'){
    args.shift();const a=args.shift(),b=args.shift();if(!a||!b)throw new Error(usage);let reference:string|undefined,animation:string|undefined,port=4317;
    while(args.length){const flag=args.shift(),value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--reference')reference=value;else if(flag==='--animation')animation=value;else if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else throw new Error(`Unknown compare option ${flag}`);}
    if(!reference||!animation)throw new Error('compare: --reference and --animation are required');const p=await loadCompare({a,b,reference,animation});
    if(command==='feedback'){console.log(JSON.stringify(await readFeedbackCompareSession(p,options.stateDir),null,2));return;}
    if(command==='check'){console.log(`Comparison valid: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nAnimation: ${animation}\nReference SHA-256: ${p.response.reference.sha256}\nPlayback: two compiled models present`);return;}
    const server=await startCompareServer(p,{port,stateDir:options.stateDir});console.log(`Compare ready: http://127.0.0.1:${server.port}/\nComparison: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nPress Ctrl+C to stop.`);return;
  }
  const input=args.shift();if(!input)throw new Error(usage);let port=4317;let checkpoint:string|undefined,reference:string|undefined,compare:string|undefined,animation:string|undefined;
  while(args.length){const flag=args.shift();const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else if(flag==='--checkpoint')checkpoint=value;else if(flag==='--reference')reference=value;else if(flag==='--compare')compare=value;else if(flag==='--animation')animation=value;else throw new Error(`Unknown option ${flag}\n${usage}`);}
  if(compare){if(command!=='feedback')throw new Error('--compare: use open or feedback');const loaded=await loadOpenPackage({input,compare,reference,animation});if(loaded.mode!=='compare')throw new Error('Expected comparison');console.log(JSON.stringify(await readFeedbackCompareSession(loaded.p,options.stateDir),null,2));return;}if(animation)throw new Error('--animation: use with --compare');
  const p=await loadReferencedReview(input,reference);if(command==='feedback'){const saved=await readFeedbackSession(p,options.stateDir);await assertReviewUnchanged(p);console.log(JSON.stringify(saved,null,2));return;}if(command==='check'){console.log(`Package valid: ${p.manifest.title}\nRevision: ${p.manifest.revision}\nSource SHA-256: ${p.sourceHash}\nDeclared files: ${p.files.size}\nPlayback: ${p.manifest.model?'compiled model present':'unavailable (no model)'}`);return;}
  if(checkpoint&&!p.manifest.checkpoints.some(v=>v.id===checkpoint))throw new Error(`Unknown checkpoint ${checkpoint}`);
  const server=await startServer(p,{port,stateDir:options.stateDir});const url=new URL(`http://127.0.0.1:${server.port}/`);if(checkpoint)url.searchParams.set('checkpoint',checkpoint);
  console.log(`Review ready: ${url}\nPackage: ${p.manifest.title} (${p.manifest.revision})\nSource SHA-256: ${p.sourceHash}\nPress Ctrl+C to stop.`);
}
if(import.meta.main)main(Bun.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exitCode=1;});
