import {readdir, mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import durations from './browser-durations.json';
import exclusions from './browser-exclusions.json';

export const SHARD_COUNT = 4;
export type Exclusions = Record<string, {issue:number;reason:string}>;
export function partitionBrowserSuites(files:readonly string[], weights:Record<string,number> = durations.seconds,
  omitted:Exclusions = exclusions, unknownSeconds = durations.unknownSeconds) {
  if (!(unknownSeconds > 0) || !Number.isFinite(unknownSeconds)) throw Error('BROWSER_UNKNOWN_WEIGHT_INVALID');
  const discovered = [...files].sort();
  if (new Set(discovered).size !== discovered.length) throw Error('BROWSER_DUPLICATE_SUITE');
  for (const [file, entry] of Object.entries(omitted)) {
    if (!discovered.includes(file) || !Number.isSafeInteger(entry.issue) || entry.issue <= 0 || !entry.reason.trim())
      throw Error('BROWSER_EXCLUSION_INVALID: '+file);
  }
  const weight = (file:string) => {
    const value = weights[file] ?? unknownSeconds;
    if (!Number.isFinite(value) || value < 0) throw Error('BROWSER_WEIGHT_INVALID: '+file);
    return value;
  };
  const shards = Array.from({length:SHARD_COUNT}, (_,index) => ({shard:index+1, seconds:0, suites:[] as string[]}));
  for (const file of discovered.filter(file=>!Object.hasOwn(omitted,file)).sort((a,b)=>weight(b)-weight(a)||a.localeCompare(b))) {
    const target = [...shards].sort((a,b)=>a.seconds-b.seconds||a.shard-b.shard)[0]!;
    target.suites.push(file); target.seconds += weight(file);
  }
  return {discovered, exclusions:omitted, shards};
}
export async function browserPlan(root = process.cwd()) {
  const files = (await readdir(join(root,'tests'))).filter(file=>file.endsWith('-browser.ts')).map(file=>'tests/'+file);
  return partitionBrowserSuites(files);
}
export async function assertExclusionIssuesOpen(omitted:Exclusions, read:(issue:number)=>Promise<string>) {
  for (const issue of new Set(Object.values(omitted).map(entry=>entry.issue))) {
    if (await read(issue) !== 'open') throw Error('BROWSER_EXCLUSION_ISSUE_NOT_OPEN: #'+issue);
  }
}
export function browserInvocation(file:string, language:string, output:string, root = process.cwd()) {
  const argv = ['bun',file];
  const env:Record<string,string|undefined> = {...process.env};
  for (const name of ['NO_ASSERT','SCREENSHOT_DIR','SCREENSHOT_BASE64','OUT_JSON','RECORD_MP4','RV367_FOCUS']) delete env[name];
  const name = file.slice('tests/'.length);
  switch (name) {
    case 'animation-editor-browser.ts': case 'compare-mode-browser.ts': env.SCREENSHOT_DIR=output; break;
    case 'chest-panel-browser.ts': argv.push('--shots',output); break;
    case 'parts-camera-race-browser.ts': env.REVIEW464_CAMERA_ARTIFACTS=output; break;
    case 'parts-explorer-browser.ts': case 'server-lifecycle-browser.ts': env.OUT_JSON=join(output,'report.json'); break;
    case 'stage3-framing-browser.ts': env.RV496_LANG=language;env.RV496_ARTIFACTS=output;break;
    case 'inspection-clock-consumers-browser.ts': env.CLOCK_PRODUCER_BENCH=root;break;
    case 'correction-handoff-browser.ts': case 'stage1-corrections-browser.ts': case 'stage1-review-fixes-browser.ts': env.RV367_BENCH=root;break;
    case 'inspection-bookmark-time-browser.ts': case 'compare-playback-stability-browser.ts': break;
    case 'job-checkpoint-evidence-browser.ts':case 'job-checkpoint-wire-browser.ts':case 'job-record-browser.ts':case 'open-workspace-browser.ts': argv.push('--lang',language,'--out',output);break;
    default: argv.push('--out',output);
  }
  return {argv,env};
}
const bilingual = new Set(['job-checkpoint-evidence','job-checkpoint-wire','job-record','open-workspace','stage3-framing'].map(name=>'tests/'+name+'-browser.ts'));
export async function runBrowserShard(shard:number, output:string) {
  const plan=await browserPlan(), selected=plan.shards.find(entry=>entry.shard===shard);
  if (!selected) throw Error('BROWSER_SHARD_INVALID');
  await mkdir(output,{recursive:true});
  await writeFile(join(output,'plan.json'),JSON.stringify(plan,null,2)+'\n');
  const results:{suite:string;language:string;exit:number;seconds:number;raw:string}[]=[];
  let failed=false;
  for (const suite of selected.suites) for (const language of bilingual.has(suite)?['en','ko']:['default']) {
    const dir=join(output,suite.slice(6,-3),language);await mkdir(dir,{recursive:true});
    const {argv,env}=browserInvocation(suite,language,dir);
    const started=performance.now(),raw=join(dir,'raw.log');
    console.log('SUITE_START '+JSON.stringify({suite,language,argv}));
    const bounded=['correction-handoff','stage1-corrections','stage1-review-fixes','inspection-clock-consumers','rig-difference'].some(name=>suite==='tests/'+name+'-browser.ts');
    const command=bounded?['timeout','-k','5s','595s',...argv]:argv;
    const child=Bun.spawn(['bash','-c','exec "$@" 2>&1','_',...command],{env,stdout:'pipe',stderr:'pipe'}),file=Bun.file(raw).writer();
    const pump=async(stream:ReadableStream<Uint8Array>)=>{const reader=stream.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;file.write(value);process.stdout.write(value);}}finally{reader.releaseLock();}};
    try {await Promise.all([pump(child.stdout),pump(child.stderr)]);}
    finally {await file.end();}
    const exit=await child.exited,seconds=(performance.now()-started)/1000;
    results.push({suite,language,exit,seconds,raw});
    await writeFile(join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
    console.log('SUITE_EXIT '+JSON.stringify(results.at(-1)));
    if (exit!==0) {failed=true;break;}
  }
  return failed?1:0;
}
if (import.meta.main) {
  if (Bun.argv.includes('--check-issues')) {
    await assertExclusionIssuesOpen(exclusions,async issue=>{
      const child=Bun.spawn(['gh','api',`repos/rig-c/review/issues/${issue}`,'--jq','.state'],{stdout:'pipe',stderr:'pipe'});
      const [output,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      if(exit!==0)throw Error('BROWSER_EXCLUSION_LOOKUP_FAILED: '+error);
      return output.trim();
    });
  } else if (Bun.argv.includes('--shard')) {
    const shard=Number(Bun.argv[Bun.argv.indexOf('--shard')+1]);
    const output=resolve(process.env.BROWSER_ARTIFACTS??'artifacts/browser-shard-'+shard);
    process.exitCode=await runBrowserShard(shard,output);
  } else console.log(JSON.stringify(await browserPlan(),null,2));
}
