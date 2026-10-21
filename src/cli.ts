#!/usr/bin/env bun
import {randomBytes} from 'node:crypto';
import {parseControlCommand} from './control.ts';
import { loadReview } from './manifest.ts';
import { formatFeedbackIssues } from './feedback-export.ts';
import {loadReferencedReview,selectedReference,assertReviewUnchanged} from './reference.ts';
import {animationDiagnostic,selectAnimation} from './animation-selection.ts';
import {shellWord} from './open-shell.ts';
import {openReview,buildOpenDiagnostic,controlReview,loadOpenPackage,defaultStateDir,handoffFlags,type OpenInputs} from './open.ts';
import {checkHandoffFlags,HANDOFF_FLAGS} from './handoff.ts';
import { readFeedbackSession, readFeedbackCompareSession } from './session-history.ts';
import { startServer } from './server.ts';
import { loadCompare } from './compare.ts';
import { startCompareServer } from './compare-server.ts';
import { readSession, type Feedback } from './session.ts';
import { readCompareSession } from './compare-session.ts';
import { exportReviewStrip, exportCompareStrip, stripJson, writeStripOutput, validateStripOutput } from './strip-export.ts';
import type { StripInterval, StripRequest } from './strip.ts';
const handoffUsage='[--config <path> [--parts <dir>] [--source <png> --full <dir> [--head <dir>]] [--keypoints <file>]]';
const usage='Usage: rig-review open <dir> [--reference <video>] [--compare <dir>] [--animation <name>] [--control] [--direct] '+handoffUsage+'\n       --config declares the producer handoff (wins over the review.json "producer" block and discovery of config.json, rig/config.json, ../config.json beside an opened out/); feedback and control take the same flags.\n       open is managed by default: one loopback front at 127.0.0.1:4318 (RIG_REVIEW_FRONT_PORT overrides) serves /instances/<key>/; --direct serves the worker on its own port.\n       rig-review control <dir> [--reference <video>] [--compare <dir>] [--animation <name>] '+handoffUsage+' [--page <id> --expected-revision <n> --command <JSON> --wait-ms <n>]\n       rig-review feedback <dir> [--reference <video>] [--compare <dir>] [--animation <name>] '+handoffUsage+' [--format json|issue]\n       Usage: bun run review -- <review.json|output-directory> [--port 4317] [--checkpoint ID]\n       bun run check -- <review.json|output-directory>\n       bun run feedback -- <review.json|output-directory>\n       bun run review -- compare <a> <b> --reference <video> --animation <name> [--port 4317]\n       bun run check -- compare <a> <b> --reference <video> --animation <name>\n       bun run feedback -- compare <a> <b> --reference <video> --animation <name>';
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
/** `--config` → `config` for the producer handoff flags (#101), else null. */
function handoffOption(flag:string):(typeof HANDOFF_FLAGS)[number]|null {const name=flag.slice(2);return flag.startsWith('--')&&(HANDOFF_FLAGS as readonly string[]).includes(name)?name as (typeof HANDOFF_FLAGS)[number]:null;}
/** The retrieval words for the handoff flags, in their fixed order. */
const handoffWords=(inputs:OpenInputs)=>HANDOFF_FLAGS.flatMap(f=>inputs[f]!==undefined?['--'+f,inputs[f]!]:[]);
export function parseOpenInputs(args:string[]):OpenInputs {
 const input=args.shift();if(!input||input.startsWith('--'))throw new Error(usage);const result:OpenInputs={input},seen=new Set<string>();
 while(args.length){const flag=args.shift()!;if(seen.has(flag))throw new Error(`OPEN_OPTION_INVALID ${flag}: Duplicate open option ${flag}`);seen.add(flag);if(flag==='--control'){result.control=true;continue;}if(flag==='--direct'){result.direct=true;continue;}const value=args.shift();if(value===undefined||value==='')throw new Error(`OPEN_OPTION_INVALID ${flag}: Missing value for ${flag}`);if(flag==='--reference')result.reference=value;else if(flag==='--compare')result.compare=value;else if(flag==='--animation')result.animation=value;else if(handoffOption(flag))result[handoffOption(flag)!]=value;else throw new Error(`OPEN_OPTION_INVALID ${flag}: Unknown open option ${flag}`);}
 const problem=checkHandoffFlags(result);if(problem)throw new Error(`OPEN_OPTION_INVALID ${problem.split(':')[0]}: ${problem.slice(problem.indexOf(':')+2)}`);
 if(result.compare!==undefined&&handoffFlags(result))throw new Error('OPEN_OPTION_INVALID --config: compare takes no producer handoff; open one package with --config');
 return result;
}
async function controlCommand(args:string[],stateDir?:string){
 const input=args.shift();if(!input||input==='--help'||input==='-h'){console.log(usage);return;}
 const inputs:OpenInputs={input},options:Parameters<typeof controlReview>[1]={stateDir},seen=new Set<string>();
 while(args.length){const flag=args.shift()!;if(seen.has(flag))throw new Error(`Duplicate control option ${flag}`);seen.add(flag);const value=args.shift();if(value===undefined||value==='')throw new Error(`Missing value for ${flag}`);
  if(flag==='--reference')inputs.reference=value;else if(flag==='--compare')inputs.compare=value;else if(flag==='--animation')inputs.animation=value;
  else if(handoffOption(flag))inputs[handoffOption(flag)!]=value;
  else if(flag==='--page')options.pageId=value;else if(flag==='--request-id')options.requestId=value;
  else if(flag==='--expected-revision'){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n))throw new Error('--expected-revision: expected safe integer >= 0');options.expectedRevision=n;}
  else if(flag==='--wait-ms'){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n>30000)throw new Error('--wait-ms: expected integer 0..30000');options.waitMs=n;}
  else if(flag==='--command'){if(value.length>8192)throw new Error('--command: JSON exceeds 8 KiB');options.command=parseControlCommand(JSON.parse(value));}
  else throw new Error(`Unknown control option ${flag}`);
 }
 const result=await controlReview(inputs,options);console.log(JSON.stringify(result,null,2));if(options.command&&(result as {status?:string}).status!=='applied')process.exitCode=2;
}
/** Formatting is CLI-only; session lookup/save contracts remain unchanged. */
export function feedbackFormat(args:string[]):{args:string[];format:'json'|'issue'} {
 const remaining:string[]=[];let format:'json'|'issue'='json',seen=false,inputs=-1;
 for(let i=0;i<args.length;i++){
  const token=args[i]!;
  // Compare owns its next two positional inputs, even when they look like flags.
  if(inputs>0){remaining.push(token);inputs--;continue;}
  if(token==='--format'){
   if(seen)throw new Error('feedback --format: duplicate option');seen=true;
   const value=args[++i];if(value!=='json'&&value!=='issue')throw new Error('feedback --format: expected json | issue');format=value;continue;
  }
  remaining.push(token);
  if(inputs<0){inputs=token==='compare'?2:0;continue;}
  // The existing CLI consumes option/value pairs. Leave their validation to it;
  // in particular, --animation may legitimately own the value "--format".
  const value=args[++i];if(value!==undefined)remaining.push(value);
 }
 return {args:remaining,format};
}
/** Help flags are options; positional inputs and known option values remain literal. */
function commandHelpRequested(args:readonly string[],command:'open'|'review'|'check'|'feedback'):boolean {
 if(args[0]==='--help'||args[0]==='-h')return true;
 const compare=command!=='open'&&args[0]==='compare';
 const handoff=HANDOFF_FLAGS.map(f=>'--'+f),flags=command==='open'?['--reference','--compare','--animation',...handoff]:compare?['--reference','--animation','--port']:['--port','--checkpoint','--reference','--compare','--animation',...handoff];
 for(let i=compare?3:1;i<args.length;){
  const flag=args[i];if(flag==='--help'||flag==='-h')return true;
  if(command==='open'&&(flag==='--control'||flag==='--direct')){i++;continue;}if(!flags.includes(flag!))return false;i+=2;
 }
 return false;
}
export async function main(args:string[],options:{stateDir?:string}={}){
  options={stateDir:options.stateDir??defaultStateDir()};if(args[0]==='--')args.shift();
  if(args[0]==='control')return controlCommand(args.slice(1),options.stateDir);
  if(args[0]==='open'){const openArgs=args.slice(1);if(commandHelpRequested(openArgs,'open')){console.log(usage);return;}const inputs=parseOpenInputs(openArgs);const result=await openReview(inputs,options);// Launcher contract (README): stdout is the URL line alone; stderr is diagnostic, control notice, retrieval, in that order.
    console.log(result.url);if(result.build)console.error(buildOpenDiagnostic(result.build));if(result.selection)console.error(animationDiagnostic(result.selection));if(inputs.control)console.error('Inspection control enabled; query the current connected page with rig-review control and the same inputs.');console.error(`Review ${result.reused?'reused':'started'}; feedback: rig-review feedback ${[result.inputs.input,...(result.inputs.compare?['--compare',result.inputs.compare]:[]),...(result.inputs.reference?['--reference',result.inputs.reference]:[]),...(result.inputs.animation?['--animation',result.inputs.animation]:[]),...handoffWords(result.inputs)].map(shellWord).join(' ')}`);return;}
  if(args[0]==='strip'){args.shift();if(args.includes('--help')){console.log(usage+'\nStrip: strip <package> --reference <declared-video-id> --animation <name> (--frames FIRST:LAST | --all-feedback) [--json] [--out path]\n       strip compare <a> <b> --reference <video> --animation <name> --basis a|b (--frames FIRST:LAST | --all-feedback) [--json] [--out path]');return;}return stripCommand(args,options);}let command:'review'|'check'|'feedback'='review';if(args[0]==='check'||args[0]==='feedback'){command=args.shift() as 'check'|'feedback';}
  if(args[0]==='--help'||args[0]==='-h'){console.log(usage);return;}
  let format:'json'|'issue'='json';if(command==='feedback'){const parsed=feedbackFormat(args);args=parsed.args;format=parsed.format;}
  // Feedback formatting assigns --format/value ownership before the help pass.
  if(commandHelpRequested(args,command)){console.log(usage);return;}
  const printFeedback=(session:Parameters<typeof formatFeedbackIssues>[0])=>console.log(format==='issue'?formatFeedbackIssues(session).trimEnd():JSON.stringify(session,null,2));
  if(args[0]==='compare'){
    args.shift();const a=args.shift(),b=args.shift();if(!a||!b)throw new Error(usage);let reference:string|undefined,animation:string|undefined,port=4317;
    while(args.length){const flag=args.shift(),value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--reference')reference=value;else if(flag==='--animation')animation=value;else if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else throw new Error(`Unknown compare option ${flag}`);}
    if(!reference)throw new Error('compare: --reference and --animation are required');
    // A report naming the clip stands in for --animation; without one the flag stays required.
    if(animation===undefined){const [ra,rb]=await Promise.all([loadReview(a),loadReview(b)]);if(ra.report?.animation===undefined&&rb.report?.animation===undefined)throw new Error('compare: --reference and --animation are required');const selection=selectAnimation([{label:'a',catalog:ra.feedbackCatalog,report:ra.report},{label:'b',catalog:rb.feedbackCatalog,report:rb.report}])!;animation=selection.name;console.error(animationDiagnostic(selection));}
    const p=await loadCompare({a,b,reference,animation});
    if(command==='feedback'){printFeedback(await readFeedbackCompareSession(p,options.stateDir));return;}
    if(command==='check'){console.log(`Comparison valid: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nAnimation: ${animation}\nReference SHA-256: ${p.response.reference.sha256}\nPlayback: two compiled models present`);return;}
    const capability=randomBytes(32).toString('hex'),server=await startCompareServer(p,{port,stateDir:options.stateDir,capability});console.log(`Compare ready: http://127.0.0.1:${server.port}/#cap=${capability}\nComparison: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nPress Ctrl+C to stop.`);return;
  }
  const input=args.shift();if(!input)throw new Error(usage);let port=4317;let checkpoint:string|undefined,reference:string|undefined,compare:string|undefined,animation:string|undefined;const handoff:OpenInputs={input};
  while(args.length){const flag=args.shift();const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(handoffOption(flag!)){handoff[handoffOption(flag!)!]=value;continue;}if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else if(flag==='--checkpoint')checkpoint=value;else if(flag==='--reference')reference=value;else if(flag==='--compare')compare=value;else if(flag==='--animation')animation=value;else throw new Error(`Unknown option ${flag}\n${usage}`);}
  const handoffProblem=checkHandoffFlags(handoff);if(handoffProblem)throw new Error(handoffProblem);if(compare&&handoffFlags(handoff))throw new Error('--config: compare takes no producer handoff');
  if(compare){if(command!=='feedback')throw new Error('--compare: use open or feedback');const loaded=await loadOpenPackage({input,compare,reference,animation});if(loaded.mode!=='compare')throw new Error('Expected comparison');printFeedback(await readFeedbackCompareSession(loaded.p,options.stateDir));return;}
  const p=await loadReferencedReview(input,reference,handoffFlags(handoff));// Serving starts on the report's clip when it names one; check and feedback validate only an explicit flag.
  const fromReport=command==='review'&&animation===undefined&&p.report?.animation!==undefined;
  const selection=animation!==undefined||fromReport?selectAnimation([{label:'single',catalog:p.feedbackCatalog,report:p.report}],animation,true):null;const initialAnimation=selection?.name;if(command==='feedback'){const saved=await readFeedbackSession(p,options.stateDir);await assertReviewUnchanged(p);printFeedback(saved);return;}if(command==='check'){console.log(`Package valid: ${p.manifest.title}\nRevision: ${p.manifest.revision}\nSource SHA-256: ${p.sourceHash}\nDeclared files: ${p.files.size}\nPlayback: ${p.manifest.model?'compiled model present':'unavailable (no model)'}`);return;}
  if(checkpoint&&!p.manifest.checkpoints.some(v=>v.id===checkpoint))throw new Error(`Unknown checkpoint ${checkpoint}`);
  // Foreground serving uses the same `#cap=` fragment handoff as open: the printed link alone can submit.
  const capability=randomBytes(32).toString('hex'),server=await startServer(p,{port,stateDir:options.stateDir,initialAnimation,capability});const url=new URL(`http://127.0.0.1:${server.port}/`);if(checkpoint)url.searchParams.set('checkpoint',checkpoint);url.hash='cap='+capability;
  if(fromReport&&selection)console.error(animationDiagnostic(selection));
  console.log(`Review ready: ${url}\nPackage: ${p.manifest.title} (${p.manifest.revision})\nSource SHA-256: ${p.sourceHash}\nPress Ctrl+C to stop.`);
}
if(import.meta.main)main(Bun.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exitCode=1;});
