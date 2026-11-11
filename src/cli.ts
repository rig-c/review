#!/usr/bin/env bun
import {requireFeedbackFrames} from './stage-comment.ts';
import {commentCropPaths} from './comment-crops.ts';
import {randomBytes} from 'node:crypto';
import {joinProject} from './joined-project.ts';
import {appliedValue,parseCorrection,projectPartsDescription,projectSessionCorrection} from './correction-handoff.ts';
import {createRebuilds} from './rebuild.ts';
import {readFile} from 'node:fs/promises';
import {parseControlCommand} from './control.ts';
import { loadReview } from './manifest.ts';
import { formatFeedbackIssues,feedbackWithCommentGroups,formatCorrectionIssue } from './feedback-export.ts';
import {loadReferencedReview,selectedReference,assertReviewUnchanged} from './reference.ts';
import {animationDiagnostic,selectAnimation} from './animation-selection.ts';
import {shellWord} from './open-shell.ts';
import {openReview,buildOpenDiagnostic,controlReview,loadOpenPackage,defaultStateDir,handoffFlags,type OpenInputs} from './open.ts';
import {checkHandoffFlags,HANDOFF_FLAGS} from './handoff.ts';
import { readFeedbackSession, readFeedbackCompareSession } from './session-history.ts';
import { startServer } from './server.ts';
import { loadCompare } from './compare.ts';
import { startCompareServer } from './compare-server.ts';
import { loadPartsView, readVerdict, readPartsVerdictForCli, readPartsVerdictJson, exportPartsVerdict, exportPartsCorrection, assertPartsUnchanged, type PartsViewOptions } from './parts-view.ts';
import { startPartsServer } from './parts-server.ts';
import { readSession, parseSession, sessionFile, type Feedback } from './session.ts';
import { readCompareSession } from './compare-session.ts';
import { exportReviewStrip, exportCompareStrip, stripJson, writeStripOutput, validateStripOutput } from './strip-export.ts';
import type { StripInterval, StripRequest } from './strip.ts';
const handoffUsage='[--config <path> [--parts <dir>] [--source <png> --full <dir> [--head <dir>]] [--keypoints <file>]]';
const usage='Usage: rig-review open <dir> [<dir> ...] [--animation-for <index> <name>] [--reference <video>] [--compare <dir>] [--animation <name>] [--control] [--direct] [--view-only] [--project <create-root> [(--project-version <rig> [--post-version <post>] | --project-draft <id> [--parts-verdict-dir <dir>])] --picks-dir <dir>] '+handoffUsage+'\n       --config declares the producer handoff (wins over the review.json "producer" block and discovery of config.json, rig/config.json, ../config.json beside an opened out/); feedback and control take the same flags; --view-only opens without a producer handoff.\n       open is managed by default: one owner workspace at 127.0.0.1:4318 (RIG_REVIEW_FRONT_PORT overrides) hosts targets in one process; --animation applies to all targets, --animation-for overrides one 1-based target, and --direct keeps a separate single-target worker.\n       rig-review control <dir> [--reference <video>] [--compare <dir>] [--animation <name>] '+handoffUsage+' [--project <create-root> --project-version <rig> --picks-dir <dir> [--post-version <post>]] [--page <id> --expected-revision <n> --command <JSON> --wait-ms <n>]\n       rig-review feedback <dir> [--reference <video>] [--compare <dir>] [--animation <name>] '+handoffUsage+' [--project <create-root> --project-version <rig> --picks-dir <dir> [--post-version <post>]] [--format json|issue] [--correction <item id>]\n       rig-review <dir> <dir> ... [--animation <name>] [--animation-for <index> <name>] [--port 4318] [--reference <video>] [--view-only] [--control] '+handoffUsage+'\n       Foreground multi owns a new workspace in this CLI process; a compatible existing owner is joined and the launcher exits. Multi --port accepts 1..65535; single foreground keeps 4317 and --port 0.\n       Usage: bun run review -- <review.json|output-directory> [--port 4317] [--checkpoint ID] [--view-only]\n       bun run check -- <review.json|output-directory>\n       bun run feedback -- <review.json|output-directory>\n       bun run review -- compare <a> <b> --reference <video> --animation <name> [--port 4317]\n       bun run check -- compare <a> <b> --reference <video> --animation <name>\n       bun run feedback -- compare <a> <b> --reference <video> --animation <name>\n       rig-review parts <build root | parts dir | review package> [--rig <file>] [--mesh-report <file>] [--check <file>] [--verdict <file>] [--painting <png>] [--by <name>] [--format json|issue] [--correction <item id> --parts-file <inventory> [--part-note <part>]] [--port <n>]\n       rig-review --version';
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
  const fromFeedback=(feedback:(Feedback&{side?:'a'|'b'})[])=>feedback.map(f=>{const context=f.context;if(!context||typeof context!=='object'||Array.isArray(context)||context.animation!==animation)throw new Error('strip --all-feedback: every interval must identify the selected animation');return {id:f.id,feedbackId:f.id,basis:compare?f.side!:'single' as const,...requireFeedbackFrames(f)};});
  let result,roots:string[];
  if(compare){if(referenceVideo)throw new Error('strip compare: use --reference local-video');const p=await loadCompare({a,b:b!,reference:reference!,animation});roots=[p.a.root,p.b.root];if(all)intervals=fromFeedback((await readCompareSession(p,options.stateDir)).feedback);if(output){await validateStripOutput(output,roots);if(!jsonOnly)await validateStripOutput(output+'.json',roots);}result=await exportCompareStrip(p,request(p.response.sourceHash));}
  else {if(basis)throw new Error('strip --basis: single package uses single basis');const p=await loadReferencedReview(a,referenceVideo);if(!reference)reference=selectedReference(p)?.binding.reference.id;roots=[p.root];if(all)intervals=fromFeedback((await readSession(p,options.stateDir)).feedback);if(output){await validateStripOutput(output,roots);if(!jsonOnly)await validateStripOutput(output+'.json',roots);}result=await exportReviewStrip(p,request(p.sourceHash));}
  if(output){await writeStripOutput(result,output,roots);console.log(`Strip exported: ${output}${result.png?' (PNG + .json provenance)':''}`);}else console.log(stripJson(result).trimEnd());
}
/** `--config` → `config` for the producer handoff flags (#101), else null. */
function handoffOption(flag:string):(typeof HANDOFF_FLAGS)[number]|null {const name=flag.slice(2);return flag.startsWith('--')&&(HANDOFF_FLAGS as readonly string[]).includes(name)?name as (typeof HANDOFF_FLAGS)[number]:null;}
const projectFlags = ['--project','--project-version','--picks-dir','--post-version','--project-draft','--parts-verdict-dir'];
/** The retrieval words for the handoff flags, in their fixed order. */
const projectWords=(inputs:OpenInputs)=>{const p=inputs.project;return p?[
 '--project',p.root,...(p.draftId!==undefined?['--project-draft',p.draftId]:p.version!==undefined?['--project-version',String(p.version)]:[]),'--picks-dir',p.picksDir,
 ...(p.partsVerdictDir===undefined?[]:['--parts-verdict-dir',p.partsVerdictDir]),
 ...(p.postVersion===undefined?[]:['--post-version',String(p.postVersion)]),
]:[];};
const handoffWords=(inputs:OpenInputs)=>HANDOFF_FLAGS.flatMap(f=>inputs[f]!==undefined?['--'+f,inputs[f]!]:[]);
export function parseOpenInputs(args:string[],options:{interview?:boolean}={}):OpenInputs {
 const input=args.shift();if(!input||input.startsWith('--'))throw new Error(usage);const result:OpenInputs={input},seen=new Set<string>();
 let root:string|undefined,version:string|undefined,postVersion:string|undefined,picksDir:string|undefined,draftId:string|undefined,partsVerdictDir:string|undefined;
 while(args.length){const flag=args.shift()!;if(seen.has(flag))throw new Error(`OPEN_OPTION_INVALID ${flag}: Duplicate open option ${flag}`);seen.add(flag);if(flag==='--control'){result.control=true;continue;}if(flag==='--direct'){result.direct=true;continue;}if(flag==='--view-only'){result.viewOnly=true;continue;}const value=args.shift();if(value===undefined||value==='')throw new Error(`OPEN_OPTION_INVALID ${flag}: Missing value for ${flag}`);if(flag==='--reference')result.reference=value;else if(flag==='--compare')result.compare=value;else if(flag==='--animation')result.animation=value;else if(flag==='--project')root=value;else if(flag==='--project-version')version=value;else if(flag==='--picks-dir')picksDir=value;else if(flag==='--project-draft')draftId=value;else if(flag==='--parts-verdict-dir')partsVerdictDir=value;else if(flag==='--post-version')postVersion=value;else if(handoffOption(flag))result[handoffOption(flag)!]=value;else throw new Error(`OPEN_OPTION_INVALID ${flag}: Unknown open option ${flag}`);}
 if(root!==undefined||version!==undefined||picksDir!==undefined||postVersion!==undefined||draftId!==undefined||partsVerdictDir!==undefined){
  if(!root||!picksDir||(Boolean(version)&&Boolean(draftId))||options.interview===false&&!version&&!draftId||result.compare!==undefined||version!==undefined&&(!/^\d+$/.test(version)||!Number.isSafeInteger(Number(version))||Number(version)<1))
   throw new Error('OPEN_OPTION_INVALID --project: single-package open requires --project, --picks-dir and one of --project-version or --project-draft together');
  if(postVersion!==undefined&&(!/^\d+$/.test(postVersion)||!Number.isSafeInteger(Number(postVersion))||Number(postVersion)<1))
   throw new Error('OPEN_OPTION_INVALID --post-version: expected a positive Create post version');
  if(!version&&postVersion)throw new Error('OPEN_OPTION_INVALID --post-version: requires --project-version');
  if(partsVerdictDir&&(!draftId||result.viewOnly))throw new Error('OPEN_OPTION_INVALID --parts-verdict-dir: requires a writable --project-draft');
  if(!version&&!draftId&&(result.reference!==undefined||result.animation!==undefined||result.control||result.direct||result.viewOnly||handoffFlags(result)))throw new Error('OPEN_OPTION_INVALID --project: interview-only open takes only the project root, --project and --picks-dir');
  result.project=!version&&!draftId?{root,picksDir}:draftId?{root,draftId,picksDir,...(partsVerdictDir?{partsVerdictDir}:{})}:{root,version:Number(version),picksDir,...(postVersion!==undefined?{postVersion:Number(postVersion)}:{})};
 }
 const problem=checkHandoffFlags(result);if(problem)throw new Error(`OPEN_OPTION_INVALID ${problem.split(':')[0]}: ${problem.slice(problem.indexOf(':')+2)}`);
 if(result.compare!==undefined&&handoffFlags(result))throw new Error('OPEN_OPTION_INVALID --config: compare takes no producer handoff; open one package with --config');
 return result;
}

/** Common open options apply to every operand; indexed animation values override the common default. */
export function parseOpenTargets(args: readonly string[]): OpenInputs[] {
 const inputs: string[] = [];
 const common: string[] = [];
 const animations = new Map<number, string>();
 const booleanFlags = ['--control', '--direct', '--view-only'];
 const valueFlags = ['--reference', '--compare', '--animation', ...projectFlags, ...HANDOFF_FLAGS.map(flag => '--' + flag)];
 for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (flag === '--animation-for') {
   const target = args[++index], animation = args[++index];
   if (target === undefined || !/^[1-9]\d*$/.test(target) || !Number.isSafeInteger(Number(target)) || animation === undefined || animation === '') {
    throw new Error('OPEN_OPTION_INVALID --animation-for: expected a positive target index and animation name');
   }
   const targetIndex = Number(target);
   if (animations.has(targetIndex)) throw new Error(`OPEN_OPTION_INVALID --animation-for: duplicate target index ${target}`);
   animations.set(targetIndex, animation);
  } else if (booleanFlags.includes(flag)) {
   common.push(flag);
  } else if (valueFlags.includes(flag)) {
   const value = args[++index];
   if (value === undefined || value === '') throw new Error(`OPEN_OPTION_INVALID ${flag}: Missing value for ${flag}`);
   common.push(flag, value);
  } else if (flag.startsWith('--')) {
   throw new Error(`OPEN_OPTION_INVALID ${flag}: Unknown open option ${flag}`);
  } else {
   inputs.push(flag);
  }
 }
 if (inputs.length === 0) throw new Error(usage);
 for (const target of animations.keys()) {
  if (target > inputs.length) throw new Error(`OPEN_OPTION_INVALID --animation-for: target index ${target} exceeds ${inputs.length} input(s)`);
 }
 const targets = inputs.map(input => parseOpenInputs([input, ...common]));
 if(targets.length>1&&targets.some(target=>target.project&&target.project.version===undefined&&target.project.draftId===undefined))throw new Error('OPEN_OPTION_INVALID --project: interview-only open requires exactly one project root');
 if (targets.length > 1 && targets.some(target => target.compare !== undefined)) {
  throw new Error('OPEN_OPTION_INVALID --compare: multi-target open requires exactly one primary input for comparison');
 }
 if (targets.length > 1 && targets.some(target => target.direct)) {
  throw new Error('OPEN_OPTION_INVALID --direct: multi-target open requires the managed owner workspace');
 }
 for (const [index, animation] of animations) targets[index - 1]!.animation = animation;
 return targets;
}
/** Multi detection consumes known option values before counting folder operands. */
export function parseForegroundTargets(args: readonly string[]): {targets: OpenInputs[]; port?: number; help: boolean} | null {
 const values = ['--port', '--checkpoint', '--reference', '--compare', '--animation', ...projectFlags,
  ...HANDOFF_FLAGS.map(flag => '--' + flag)];
 const booleans = ['--view-only', '--control', '--direct'];
 const operands: string[] = [], forwarded: string[] = [];
 const unsupported = new Set(['--checkpoint', '--compare', '--direct', ...projectFlags]);
 const refused: string[] = [];
 let port: number | undefined, help = false, duplicatePort = false;
 for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (flag === '--help' || flag === '-h') {help = true; continue;}
  if (unsupported.has(flag)) refused.push(flag);
  if (flag === '--animation-for') {
   forwarded.push(flag, ...args.slice(index + 1, index + 3)); index += 2;
  } else if (flag === '--port') {
   duplicatePort = port !== undefined;
   port = Number(args[++index]);
  } else if (values.includes(flag)) {
   forwarded.push(flag); if (args[index + 1] !== undefined) forwarded.push(args[++index]!);
  } else if (booleans.includes(flag)) forwarded.push(flag);
  else if (!flag.startsWith('-')) {operands.push(flag); forwarded.push(flag);}
  // Preserve the legacy validator's unknown-option and help precedence.
  else return null;
 }
 if (operands.length < 2) return null;
 if (help) return {targets: [], port, help};
 if (refused.length) throw new Error('OPEN_OPTION_INVALID ' + refused[0] + ': unsupported for foreground multi-target review');
 if (duplicatePort || port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535)) {
  throw new Error('OPEN_OPTION_INVALID --port: foreground multi-target review expects integer 1..65535');
 }
 return {targets: parseOpenTargets(forwarded), port, help};
}

async function controlCommand(args:string[],stateDir?:string){
 const input=args.shift();if(!input||input==='--help'||input==='-h'){console.log(usage);return;}
 const inputs:OpenInputs={input},options:Parameters<typeof controlReview>[1]={stateDir},seen=new Set<string>(),projectOptions:string[]=[];
 while(args.length){const flag=args.shift()!;if(seen.has(flag))throw new Error(`Duplicate control option ${flag}`);seen.add(flag);const value=args.shift();if(value===undefined||value==='')throw new Error(`Missing value for ${flag}`);
  if(flag==='--reference')inputs.reference=value;else if(flag==='--compare')inputs.compare=value;else if(flag==='--animation')inputs.animation=value;
  else if(handoffOption(flag))inputs[handoffOption(flag)!]=value;
  else if(projectFlags.includes(flag))projectOptions.push(flag,value);
  else if(flag==='--page')options.pageId=value;else if(flag==='--request-id')options.requestId=value;
  else if(flag==='--expected-revision'){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n))throw new Error('--expected-revision: expected safe integer >= 0');options.expectedRevision=n;}
  else if(flag==='--wait-ms'){const n=Number(value);if(!/^\d+$/.test(value)||!Number.isSafeInteger(n)||n>30000)throw new Error('--wait-ms: expected integer 0..30000');options.waitMs=n;}
  else if(flag==='--command'){if(value.length>8192)throw new Error('--command: JSON exceeds 8 KiB');options.command=parseControlCommand(JSON.parse(value));}
  else throw new Error(`Unknown control option ${flag}`);
 }
 if(projectOptions.length)inputs.project=parseOpenInputs([input,...projectOptions],{interview:false}).project;
 const result=await controlReview(inputs,options);console.log(JSON.stringify(result,null,2));if(options.command&&(result as {status?:string}).status!=='applied')process.exitCode=2;
}
/** Formatting is CLI-only; session lookup/save contracts remain unchanged. */
export function feedbackFormat(args:string[]):{args:string[];format:'json'|'issue';correctionId?:string} {
 const remaining:string[]=[];let format:'json'|'issue'='json',seen=false,inputs=-1;
 let correctionId:string|undefined;
 for(let i=0;i<args.length;i++){
  const token=args[i]!;
  // Compare owns its next two positional inputs, even when they look like flags.
  if(inputs>0){remaining.push(token);inputs--;continue;}
  if(token==='--correction'&&inputs===0){
   if(correctionId!==undefined)throw new Error('feedback --correction: duplicate option');
   correctionId=args[++i];if(!correctionId||correctionId.startsWith('--'))throw new Error('feedback --correction: expected feedback item id');continue;
  }
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
 return {args:remaining,format,correctionId};
}
/** Help flags are options; positional inputs and known option values remain literal. */
function commandHelpRequested(args:readonly string[],command:'open'|'review'|'check'|'feedback'):boolean {
 if(args[0]==='--help'||args[0]==='-h')return true;
 const compare=command!=='open'&&args[0]==='compare';
 const handoff=HANDOFF_FLAGS.map(f=>'--'+f),flags=command==='open'?['--reference','--compare','--animation',...projectFlags,...handoff]:compare?['--reference','--animation','--port']:['--port','--checkpoint','--reference','--compare','--animation',...handoff,...(command==='feedback'?projectFlags:[])];
 for(let i=compare?3:1;i<args.length;){
  const flag=args[i];if(flag==='--help'||flag==='-h')return true;
  if(command==='open'&&flag==='--animation-for'){i+=3;continue;}
  if(command==='open'&&!flag?.startsWith('--')){i++;continue;}
  if((command==='open'&&(flag==='--control'||flag==='--direct'||flag==='--view-only'))||(command==='review'&&flag==='--view-only')){i++;continue;}if(!flags.includes(flag!))return false;i+=2;
 }
 return false;
}
const partsUsage='Usage: rig-review parts <build root | parts dir | review package> [--rig <file>] [--mesh-report <file>] [--check <file>] [--verdict <file>] [--painting <png>] [--by <name>] [--format json|issue] [--correction <item id> --parts-file <inventory> [--part-note <part>]] [--port <n>]\n       A directory holding parts.json (or a build root whose rig/ holds it) opens in parts mode, before rigging; a review package or check/ folder opens its atlas.\n       The sign-off is written to parts-review.json beside parts.json (or the model), or to --verdict.';
/** `rig-review parts` (#348): the parts and atlas view, served in the foreground; exits when its last tab closes. */
async function partsCommand(args:string[]){
 const input=args.shift();if(!input||input==='--help'||input==='-h'){console.log(partsUsage);return;}
 const options:PartsViewOptions={};let port=4317,format:'json'|'issue'|null=null;const seen=new Set<string>();
 let itemId:string|undefined,partNote:string|undefined,inventory:string|undefined,by:string|undefined;
 while(args.length){const flag=args.shift()!;if(flag==='--help'||flag==='-h'){console.log(partsUsage);return;}if(seen.has(flag))throw new Error(`parts: duplicate option ${flag}`);seen.add(flag);const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);
  if(flag==='--format'){if(value!=='json'&&value!=='issue')throw new Error('--format: expected json or issue');format=value;}else if(flag==='--painting')options.painting=value;else if(flag==='--rig')options.rig=value;else if(flag==='--mesh-report')options.meshReport=value;else if(flag==='--check')options.check=value;else if(flag==='--verdict')options.verdict=value;
  else if(flag==='--by'){if(!value.trim())throw new Error('--by: expected a nonblank reviewer name');by=value;}
  else if(flag==='--correction')itemId=value;else if(flag==='--part-note')partNote=value;else if(flag==='--parts-file')inventory=value;
  else if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0..65535');}
  else throw new Error(`Unknown option ${flag}\n${partsUsage}`);}
 if(by!==undefined&&(format||itemId||partNote||inventory))throw new Error('--by: launch only; incompatible with export or correction options');
 if((itemId||partNote||inventory)&&(!format||!itemId||!inventory))throw new Error('CORRECTION_SELECTOR_INVALID: parts correction requires --format, --correction and --parts-file');
 const pkg=await loadPartsView(input,options);
 if(format&&itemId&&inventory){
   const verdict=await readPartsVerdictForCli(pkg);
   if(!verdict)throw new Error('PARTS_VERDICT_UNAVAILABLE: save a current verdict first');
   await assertPartsUnchanged(pkg);
   const projected=projectPartsDescription({verdict,source:verdict.source,selector:{stage:'parts-review',kind:'parts',inventory},selection:partNote?{kind:'note',itemId,part:partNote}:{kind:'comment',itemId}});
   process.stdout.write(format==='json'?exportPartsCorrection(verdict,projected):formatCorrectionIssue(projected)+'\n');
   return;
 }
 if(format==='json'){process.stdout.write(await readPartsVerdictJson(pkg));return;}
 if(format){const verdict=await readPartsVerdictForCli(pkg);if(!verdict)throw new Error('PARTS_VERDICT_UNAVAILABLE: save a verdict first');process.stdout.write(exportPartsVerdict(verdict,format));return;}
 const capability=randomBytes(32).toString('hex');
 let outputFailure: Error | null = null;
 let rejectWrite: ((error: Error) => void) | undefined;
 let server: Awaited<ReturnType<typeof startPartsServer>> | undefined;
 let stopping: Promise<void> | undefined;
 const shutdown = () => stopping ??= server!.shutdown();
 const failOutput = (cause: unknown) => {
   if (outputFailure) return;
   outputFailure = new Error('PARTS_VERDICT_NOTIFY_FAILED: stdout failed', {cause});
   process.exitCode = 1;
   console.error(outputFailure.message);
   rejectWrite?.(outputFailure);
   if (server) void shutdown();
 };
 const outputClosed = () => failOutput(new Error('stdout closed'));
 process.stdout.on('error', failOutput);
 process.stdout.on('close', outputClosed);
 const stop = (signal: string) => {
   if (!outputFailure) console.log(`review parts: exiting — received ${signal}.`);
   void shutdown();
 };
 const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
 try {
   server = await startPartsServer(pkg, {port, capability, by, onNotifyFailure: failOutput,
     onWriteFailure: error => console.error(error.message),
     onSaved: async event => {
       if (outputFailure) throw outputFailure;
       const line = 'RIG_REVIEW_PARTS_SAVED ' + JSON.stringify(event).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
       // The callback settles after the complete write, including when write() reports backpressure.
       await new Promise<void>((resolve, reject) => {
         rejectWrite = reject;
         try { process.stdout.write(line, error => error ? failOutput(error) : resolve()); }
         catch (error) { failOutput(error); }
       }).finally(() => { rejectWrite = undefined; });
     },
   });
   process.once('SIGINT', interrupt);process.once('SIGTERM', terminate);
   console.log(`Parts view ready: http://127.0.0.1:${server.port}/#cap=${capability}\nMode: ${pkg.mode} · ${pkg.items.length} ${pkg.mode==='parts'?'parts':'regions'} · ${pkg.flags.length} producer flags\nSign-off: ${pkg.verdictPath}\nPress Ctrl+C to stop.`);
   if (outputFailure) await shutdown();
   await server.live.exited;
   if (stopping) await stopping;
 } finally {
   process.removeListener('SIGINT', interrupt);process.removeListener('SIGTERM', terminate);
   process.stdout.removeListener('error', failOutput);process.stdout.removeListener('close', outputClosed);
 }
}
export async function main(args:string[],options:{stateDir?:string}={}){
  options={stateDir:options.stateDir??defaultStateDir()};if(args[0]==='--')args.shift();
  if(args[0]==='--version'||args[0]==='-v'){console.log((JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version);return;}
  if(args[0]==='control')return controlCommand(args.slice(1),options.stateDir);
  if(args[0]==='open'){const openArgs=args.slice(1);if(commandHelpRequested(openArgs,'open')){console.log(usage);return;}const targets=parseOpenTargets(openArgs);
    if(!targets[0]?.direct){
      const {openWorkspace}=await import('./open-workspace-launch.ts');
      const result=await openWorkspace(targets,options);
      console.log(result.url);
      for(const target of result.prepared){if(target.build)console.error(buildOpenDiagnostic(target.build));if(target.package.selection)console.error(animationDiagnostic(target.package.selection));}
      console.error(`Review workspace ${result.reused?'reused':'started'}; ${targets.length} target(s). Retrieve feedback using the original input designation.`);
      return;
    }
    const inputs=targets[0]!;const result=await openReview(inputs,options);// Launcher contract (README): stdout is the URL line alone; stderr is diagnostic, control notice, retrieval, in that order.
    console.log(result.url);if(result.build)console.error(buildOpenDiagnostic(result.build));if(result.selection)console.error(animationDiagnostic(result.selection));if(inputs.control)console.error('Inspection control enabled; query the current connected page with rig-review control and the same inputs.');console.error(`Review ${result.reused?'reused':'started'}; feedback: rig-review feedback ${[result.inputs.input,...(result.inputs.compare?['--compare',result.inputs.compare]:[]),...(result.inputs.reference?['--reference',result.inputs.reference]:[]),...(result.inputs.animation?['--animation',result.inputs.animation]:[]),...handoffWords(result.inputs),...projectWords(result.inputs)].map(shellWord).join(' ')}`);return;}
  if(args[0]==='parts')return partsCommand(args.slice(1));
  if(args[0]==='strip'){args.shift();if(args.includes('--help')){console.log(usage+'\nStrip: strip <package> --reference <declared-video-id> --animation <name> (--frames FIRST:LAST | --all-feedback) [--json] [--out path]\n       strip compare <a> <b> --reference <video> --animation <name> --basis a|b (--frames FIRST:LAST | --all-feedback) [--json] [--out path]');return;}return stripCommand(args,options);}let command:'review'|'check'|'feedback'='review';if(args[0]==='check'||args[0]==='feedback'){command=args.shift() as 'check'|'feedback';}
  if(args[0]==='--help'||args[0]==='-h'){console.log(usage);return;}
  const foreground = command === 'review' && args[0] !== 'compare' ? parseForegroundTargets(args) : null;
  if (foreground) {
    if (foreground.help) {console.log(usage); return;}
    const {openWorkspace} = await import('./open-workspace-launch.ts');
    const result = await openWorkspace(foreground.targets, {...options, frontPort: foreground.port, foreground: true});
    if (!result.interrupted) {
      for (const target of result.prepared) {
        if (target.build) console.error(buildOpenDiagnostic(target.build));
        if (target.package.selection) console.error(animationDiagnostic(target.package.selection));
      }
      if (result.waitForExit) console.log(`Review ready: ${result.url}\nTargets: ${foreground.targets.length}\nPress Ctrl+C to stop.`);
      else console.log(result.url);
    }
    await result.waitForExit?.();
    return;
  }
  let format:'json'|'issue'='json',correctionId:string|undefined;if(command==='feedback'){const parsed=feedbackFormat(args);args=parsed.args;format=parsed.format;correctionId=parsed.correctionId;}
  // Feedback formatting assigns --format/value ownership before the help pass.
  if(commandHelpRequested(args,command)){console.log(usage);return;}
  const printFeedback=(session:Parameters<typeof formatFeedbackIssues>[0])=>{const exported=commentCropPaths(session,options.stateDir);console.log(format==='issue'?formatFeedbackIssues(exported).trimEnd():JSON.stringify(feedbackWithCommentGroups(exported),null,2));};
  if(args[0]==='compare'){
    if(correctionId)throw new Error('CORRECTION_COMPARE_UNSUPPORTED: select a single reviewed package');
    args.shift();const a=args.shift(),b=args.shift();if(!a||!b)throw new Error(usage);let reference:string|undefined,animation:string|undefined,port=4317;
    while(args.length){const flag=args.shift(),value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--reference')reference=value;else if(flag==='--animation')animation=value;else if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else throw new Error(`Unknown compare option ${flag}`);}
    if(!reference)throw new Error('compare: --reference and --animation are required');
    // A report naming the clip stands in for --animation; without one the flag stays required.
    if(animation===undefined){const [ra,rb]=await Promise.all([loadReview(a),loadReview(b)]);if(ra.report?.animation===undefined&&rb.report?.animation===undefined)throw new Error('compare: --reference and --animation are required');const selection=selectAnimation([{label:'a',catalog:ra.feedbackCatalog,report:ra.report},{label:'b',catalog:rb.feedbackCatalog,report:rb.report}])!;animation=selection.name;console.error(animationDiagnostic(selection));}
    const p=await loadCompare({a,b,reference,animation});
    if(command==='feedback'){printFeedback(await readFeedbackCompareSession(p,options.stateDir));return;}
    if(command==='check'){console.log(`Comparison valid: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nAnimation: ${animation}\nReference SHA-256: ${p.response.reference.sha256}\nPlayback: two compiled models present`);return;}
    const capability=randomBytes(32).toString('hex'),server=await startCompareServer(p,{port,stateDir:options.stateDir,capability,exitOnClose:true});
    const stop=(sig:string)=>{server.stop(true);console.log(`review compare: exiting — received ${sig}.`);process.exit(0);};process.once('SIGINT',()=>stop('SIGINT'));process.once('SIGTERM',()=>stop('SIGTERM'));
    console.log(`Compare ready: http://127.0.0.1:${server.port}/#cap=${capability}\nComparison: ${p.response.title}\nSource SHA-256: ${p.response.sourceHash}\nPress Ctrl+C to stop.`);return;
  }
  const input=args.shift();if(!input)throw new Error(usage);let port=4317;let checkpoint:string|undefined,reference:string|undefined,compare:string|undefined,animation:string|undefined,viewOnly=false;const handoff:OpenInputs={input},projectOptions:string[]=[];
  while(args.length){const flag=args.shift();if(flag==='--view-only'){if(command!=='review')throw new Error(`Unknown option ${flag}\n${usage}`);viewOnly=true;continue;}const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(command==='feedback'&&projectFlags.includes(flag!)){projectOptions.push(flag!,value);continue;}if(handoffOption(flag!)){handoff[handoffOption(flag!)!]=value;continue;}if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else if(flag==='--checkpoint')checkpoint=value;else if(flag==='--reference')reference=value;else if(flag==='--compare')compare=value;else if(flag==='--animation')animation=value;else throw new Error(`Unknown option ${flag}\n${usage}`);}
  const handoffProblem=checkHandoffFlags(handoff);if(handoffProblem)throw new Error(handoffProblem);if(compare&&handoffFlags(handoff))throw new Error('--config: compare takes no producer handoff');
  if(projectOptions.length)handoff.project=parseOpenInputs([input,...projectOptions,...(compare?['--compare',compare]:[])],{interview:false}).project;
  if(compare){if(correctionId)throw new Error('CORRECTION_COMPARE_UNSUPPORTED: select a single reviewed package');if(command!=='feedback')throw new Error('--compare: use open or feedback');const loaded=await loadOpenPackage({input,compare,reference,animation});if(loaded.mode!=='compare')throw new Error('Expected comparison');printFeedback(await readFeedbackCompareSession(loaded.p,options.stateDir));return;}
  const base=await loadReferencedReview(input,reference,handoffFlags(handoff));
  const joined=handoff.project?joinProject(base,handoff.project):undefined,p=joined?.review??base;
  const unchanged=()=>joined?.assertCurrent()??assertReviewUnchanged(p);
  if(viewOnly)p.viewOnly=true;// Serving starts on the report's clip when it names one; check and feedback validate only an explicit flag.
  const fromReport=command==='review'&&animation===undefined&&p.report?.animation!==undefined;
  const selection=animation!==undefined||fromReport?selectAnimation([{label:'single',catalog:p.feedbackCatalog,report:p.report}],animation,true):null;const initialAnimation=selection?.name;if(command==='feedback'&&correctionId){
    await unchanged();
    const stateDir=options.stateDir!;
    const bytes=await readFile(sessionFile(p,stateDir)).catch(error=>{if(error.code==='ENOENT')throw new Error('CORRECTION_ITEM_INVALID: save a correction first');throw error;});
    const session=parseSession(JSON.parse(bytes.toString('utf8')),p,false);
    const item=session.feedback.find(row=>row.id===correctionId);
    const correction=parseCorrection((item?.context as any)?.correction);
    if(!item||!correction||session.feedbackWarnings.some(warning=>warning.id===item.id))throw new Error('CORRECTION_ITEM_INVALID: expected a valid saved correction');
    const source={id:p.manifest.id,revision:p.manifest.revision,sourceHash:p.sourceHash,reviewedSource:p.reviewedSource};
    const rebuilds=createRebuilds(p,{stateDir,starts:[p.root,process.cwd()],unchanged,bones:p.feedbackCatalog.bones});
    const settled=correction.path==='made'&&correction.selector.kind!=='post'?await rebuilds.correctionEvidence(appliedValue(item)):undefined;
    const projected=projectSessionCorrection({...correction,session,sessionBytes:bytes,source,itemId:item.id,settled,direction:p.direction});
    await unchanged();
    if(projected.kind==='unsupported')console.error('CORRECTION_OPERATION_UNSUPPORTED: '+projected.operation);
    process.stdout.write(format==='json'?bytes:formatCorrectionIssue(projected,item.context)+'\n');
    return;
  }
  if(command==='feedback'){const saved=await readFeedbackSession(p,options.stateDir);await unchanged();printFeedback(saved);return;}if(command==='check'){console.log(`Package valid: ${p.manifest.title}\nRevision: ${p.manifest.revision}\nSource SHA-256: ${p.sourceHash}\nDeclared files: ${p.files.size}\nPlayback: ${p.manifest.model?'compiled model present':'unavailable (no model)'}`);return;}
  if(checkpoint&&!p.manifest.checkpoints.some(v=>v.id===checkpoint))throw new Error(`Unknown checkpoint ${checkpoint}`);
  // Foreground serving uses the same `#cap=` fragment handoff as open: the printed link alone can submit.
  const capability=randomBytes(32).toString('hex'),server=await startServer(p,{port,stateDir:options.stateDir,initialAnimation,capability,exitOnClose:true,viewOnly});const url=new URL(`http://127.0.0.1:${server.port}/`);if(checkpoint)url.searchParams.set('checkpoint',checkpoint);url.hash='cap='+capability;
  const stop=(sig:string)=>{server.stop(true);console.log(`review: exiting — received ${sig}.`);process.exit(0);};process.once('SIGINT',()=>stop('SIGINT'));process.once('SIGTERM',()=>stop('SIGTERM'));
  if(fromReport&&selection)console.error(animationDiagnostic(selection));
  console.log(`Review ready: ${url}\nPackage: ${p.manifest.title} (${p.manifest.revision})\nSource SHA-256: ${p.sourceHash}\nPress Ctrl+C to stop.`);
}
if(import.meta.main)main(Bun.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exitCode=1;});
