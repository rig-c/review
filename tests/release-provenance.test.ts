import {expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

type Step={id?:string;name?:string;uses?:string;if?:string;env?:Record<string,string>;with?:Record<string,unknown>;run?:string};
type Workflow={on:unknown;permissions:unknown;concurrency:unknown;jobs:{release:{'runs-on':string;permissions:unknown;steps:Step[]}}};
const workflow=Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')) as Workflow;
const steps=workflow.jobs.release.steps;
const target=steps.find(step=>step.id==='target')!;
const tag='v0.11.1',commitSha='a'.repeat(40),oldSha='b'.repeat(40);
type Fixture={
 event?:string;created?:string;cutTag?:string;inputTag?:string;runSha?:string;repo?:string;
 commitSha?:string;apiResponses?:Record<string,ApiResponse>;apiExit?:number;
 author?:string;releaseExit?:number;tagExit?:number;mainExit?:number;ancestorExit?:number;served?:string;
};
type Call={command:string;args:string[]};
type ApiResponse={status:number;body:string};
type ApiCall={endpoint:string;status:number;bodySha256:string};
type Capture={id:string;file:string;endpoint:string;status:number;bodyBytes:number;bodySha256:string};
type CapturedCase={repo:string;tag:string;full:string;short?:string;ref?:string};
const fixtureDir=new URL('./fixtures/release-provenance/',import.meta.url);
const provenance=JSON.parse(readFileSync(new URL('provenance.json',fixtureDir),'utf8')) as {
 responses:Capture[];cases:Record<'lightweight'|'annotated',CapturedCase>;
};
const sha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
function capture(id:string){
 const metadata=provenance.responses.find(row=>row.id===id)!;
 const body=readFileSync(new URL(metadata.file,fixtureDir),'utf8');
 return {...metadata,body};
}
function observedCase(kind:'lightweight'|'annotated'){
 const observed=provenance.cases[kind],full=capture(observed.full);
 const expectedCommit=JSON.parse(full.body).sha as string;
 const apiResponses=Object.fromEntries([observed.full,observed.short].filter((id):id is string=>!!id).map(id=>{
  const row=capture(id);return [row.endpoint,{status:row.status,body:row.body}];
 }));
 return {...observed,expectedCommit,fixture:{repo:observed.repo,cutTag:observed.tag,
  runSha:expectedCommit,apiResponses} satisfies Fixture};
}


// Only these stubs and grep exist on PATH. The extracted workflow runs with no repository,
// inherited credentials, real gh/git/npm, network client, publish or dispatch command.
const stub=String.raw`
import {appendFileSync,readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {createHash} from 'node:crypto';
const f=JSON.parse(readFileSync(process.env.FIXTURE,'utf8'));
const command=basename(process.argv[1]),args=process.argv.slice(2);
appendFileSync(process.env.TRACE,JSON.stringify({command,args})+'\n');
const is=(...expected)=>JSON.stringify(args)===JSON.stringify(expected);
const reply=(value,code=0)=>{if(value!==undefined)console.log(value);process.exit(code);};
if(command==='gh'){
 if(args.length===4&&args[0]==='api'&&args[2]==='--jq'&&args[3]==='.sha'&&Object.hasOwn(f.apiResponses,args[1])){
  // Route by the exact requested endpoint, never by the desired fixture kind.
  const response=f.apiResponses[args[1]],data=JSON.parse(response.body);
  appendFileSync(process.env.API_TRACE,JSON.stringify({endpoint:args[1],status:response.status,
   bodySha256:createHash('sha256').update(response.body).digest('hex')})+'\n');
  if(response.status>=400){console.error('gh: '+data.message+' (HTTP '+response.status+')');process.exit(1);}
  // gh api --jq .sha: parse the actual JSON body and emit its top-level .sha.
  // apiExit is a deliberate transport-failure injection, not recorded API behavior.
  reply(data.sha??null,f.apiExit);
 }
 if(is('release','view',f.inputTag,'--repo','rig-c/review','--json','author','--jq','.author.login'))reply(f.author,f.releaseExit);
}
if(command==='git'){
 if(is('rev-parse','--verify','--quiet','refs/tags/'+f.inputTag+'^{commit}'))reply(f.commitSha,f.tagExit);
 if(is('rev-parse','--verify','--quiet','refs/remotes/origin/main'))reply(f.commitSha,f.mainExit);
 if(is('merge-base','--is-ancestor',f.commitSha,'refs/remotes/origin/main'))reply(undefined,f.ancestorExit);
}
if(command==='npm'&&is('view','@rig-c/review@'+f.inputTag.slice(1),'version'))reply(f.served,f.served?0:1);
console.error('UNEXPECTED_STUB_COMMAND',command,JSON.stringify(args));process.exit(97);
`;

function resolveTag(name:string,overrides:Fixture={}){
 const root=mkdtempSync(join(tmpdir(),'review-release-provenance-'));
 try{
  const bin=join(root,'bin');mkdirSync(bin);
  // Ordinary guard probes use synthetic JSON; observed tag cases override the entire
  // endpoint table with exact recorded bodies, with no short/full alias fallback.
  const fixture={event:'push',created:'true',cutTag:tag,inputTag:tag,runSha:commitSha,repo:'rig-c/review',
   commitSha,apiResponses:{[`repos/rig-c/review/commits/refs%2Ftags%2F${tag}`]:{status:200,body:JSON.stringify({sha:commitSha})}},
   author:'github-actions[bot]',...overrides};
  writeFileSync(join(root,'fixture.json'),JSON.stringify(fixture));
  const output=join(root,'output'),trace=join(root,'trace'),apiTrace=join(root,'api-trace');
  writeFileSync(output,'');writeFileSync(trace,'');writeFileSync(apiTrace,'');
  for(const command of ['gh','git','npm']){
   const path=join(bin,command);writeFileSync(path,`#!${process.execPath}\n${stub}`);chmodSync(path,0o755);
  }
  symlinkSync('/usr/bin/grep',join(bin,'grep'));
  expect(existsSync(join(root,'.git'))).toBe(false);
  const result=Bun.spawnSync(['/bin/bash','--noprofile','--norc','-c',target.run!],{
   cwd:root,timeout:10000,
   env:{PATH:bin,HOME:root,EVENT:fixture.event,CREATED:fixture.created,CUT_TAG:fixture.cutTag,
    INPUT_TAG:fixture.inputTag,GITHUB_SHA:fixture.runSha,GITHUB_OUTPUT:output,REPO:fixture.repo,
    RELEASE_AUTHOR:target.env!.RELEASE_AUTHOR!,FIXTURE:join(root,'fixture.json'),TRACE:trace,API_TRACE:apiTrace},
  });
  const stdout=result.stdout.toString(),stderr=result.stderr.toString();
  const outputText=readFileSync(output,'utf8');
  const traceText=readFileSync(trace,'utf8');
  const calls:Call[]=traceText.trim()?traceText.trim().split('\n').map(line=>JSON.parse(line)):[];
  const apiCalls:ApiCall[]=readFileSync(apiTrace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  // Optional raw evidence is external to the repository and includes the fake GITHUB_OUTPUT.
  const evidence=process.env.REVIEW_212_EVIDENCE_DIR??process.env.REVIEW_208_EVIDENCE_DIR;
  if(evidence){
   mkdirSync(evidence,{recursive:true});
   writeFileSync(join(evidence,`${name}.json`),JSON.stringify({fixture,exitCode:result.exitCode,stdout,stderr,output:outputText,calls,apiCalls},null,2)+'\n');
  }
  expect(stdout+stderr).not.toContain('UNEXPECTED_STUB_COMMAND');
  return {exitCode:result.exitCode,text:stdout+stderr,output:outputText,calls,apiCalls,
   outputs:Object.fromEntries(outputText.trim().split('\n').filter(Boolean).map(line=>line.split('=')))};
 }finally{rmSync(root,{recursive:true,force:true});}
}
function refused(result:ReturnType<typeof resolveTag>,code:string){
 expect(result.exitCode).toBe(1);
 expect(result.text).toContain(`::error::${code}:`);
 expect(result.output).not.toContain('publish=true');
 expect(result.outputs.sha).toBeUndefined();
}
function onlyCommitLookup(calls:Call[],repo='rig-c/review',cutTag=tag){
 expect(calls).toEqual([{command:'gh',args:['api',`repos/${repo}/commits/refs%2Ftags%2F${cutTag}`,'--jq','.sha']}]);
}

test('parsed YAML preserves release authority, triggers and gates, and checks out only the validated commit',()=>{
 expect(workflow.on).toEqual({push:{branches:['main']},workflow_dispatch:{inputs:{tag:{description:'An existing release tag to publish, e.g. v0.7.1',required:true,type:'string'}}}});
 expect(workflow.permissions).toEqual({});
 expect(workflow.concurrency).toEqual({group:'release-${{ github.ref }}','cancel-in-progress':false});
 expect(workflow.jobs.release['runs-on']).toBe('ubuntu-latest');
 expect(workflow.jobs.release.permissions).toEqual({contents:'write','pull-requests':'write',issues:'write','id-token':'write'});
 expect(steps[0]).toMatchObject({id:'release',uses:'googleapis/release-please-action@v4',if:"${{ github.event_name == 'push' }}"});
 expect(steps[0]!.with).toEqual({token:'${{ secrets.RELEASE_PLEASE_TOKEN || secrets.GITHUB_TOKEN }}','config-file':'release-please-config.json','manifest-file':'.release-please-manifest.json'});
 expect(steps.slice(0,steps.indexOf(target)).filter(step=>step.uses==='actions/checkout@v4')).toEqual([
  {uses:'actions/checkout@v4',if:"${{ github.event_name == 'workflow_dispatch' }}",with:{ref:'main','fetch-depth':0,'persist-credentials':false}},
 ]);
 expect(target.env).toMatchObject({EVENT:'${{ github.event_name }}',CREATED:'${{ steps.release.outputs.release_created }}',CUT_TAG:'${{ steps.release.outputs.tag_name }}',INPUT_TAG:'${{ inputs.tag }}',GH_TOKEN:'${{ github.token }}',REPO:'${{ github.repository }}',RELEASE_AUTHOR:'github-actions[bot]'});
 const downstream=steps.slice(steps.indexOf(target)+1);
 expect(downstream[0]).toMatchObject({uses:'actions/checkout@v4',with:{ref:'${{ steps.target.outputs.sha }}'}});
 for(const step of downstream)expect(step.if).toBe("${{ steps.target.outputs.publish == 'true' }}");
 expect(steps.filter(step=>step.run?.includes('npm publish')).map(step=>step.run?.trim())).toEqual(['npm publish --provenance --access public']);
});

test('recorded API bodies retain exact byte hashes, HTTP statuses and annotated identity',()=>{
 for(const row of provenance.responses){
  const bytes=readFileSync(new URL(row.file,fixtureDir));
  expect(bytes.length).toBe(row.bodyBytes);expect(sha256(bytes)).toBe(row.bodySha256);
 }
 const observed=observedCase('annotated'),ref=JSON.parse(capture(observed.ref!).body);
 expect(ref.ref).toBe(`refs/tags/${observed.tag}`);expect(ref.object.type).toBe('tag');
 expect(ref.object.sha).toMatch(/^[0-9a-f]{40}$/);expect(ref.object.sha).not.toBe(observed.expectedCommit);
 const short=capture(observed.short!),full=capture(observed.full);
 expect(short.status).toBe(422);expect(JSON.parse(short.body)).toMatchObject({message:`No commit found for SHA: tags/${observed.tag}`,status:'422'});
 expect(full.status).toBe(200);expect(observed.expectedCommit).toMatch(/^[0-9a-f]{40}$/);
 expect(capture(provenance.cases.lightweight.full).status).toBe(200);
});

test('normal push resolves the matching commit without a checkout',()=>{
 const result=resolveTag('push-normal');
 expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'true',tag,sha:commitSha});
 onlyCommitLookup(result.calls);
});
for(const kind of ['lightweight','annotated'] as const){
 const observed=observedCase(kind);
 test(`push ${kind} tag resolves to the commit without a checkout`,()=>{
  const result=resolveTag(`push-${kind}`,observed.fixture);
  expect(result.exitCode).toBe(0);
  expect(result.outputs).toEqual({publish:'true',tag:observed.tag,sha:observed.expectedCommit});
  onlyCommitLookup(result.calls,observed.repo,observed.tag);
  const full=capture(observed.full);
  expect(result.apiCalls).toEqual([{endpoint:full.endpoint,status:200,bodySha256:full.bodySha256}]);
 });
 test(`push rerun ${kind} mismatch refuses before publishing and names both SHAs and exact recovery`,()=>{
  const result=resolveTag(`mismatch-${kind}`,{...observed.fixture,runSha:oldSha});
  refused(result,'PROVENANCE_SHA_MISMATCH');
  expect(result.text).toContain(oldSha);expect(result.text).toContain(observed.expectedCommit);
  expect(result.text).toContain(`gh workflow run release.yml --ref ${observed.tag} -f tag=${observed.tag}`);
  expect(result.text).toContain('the tag remains cut');
  expect(result.output).toBe('');onlyCommitLookup(result.calls,observed.repo,observed.tag);
 });
}
test('annotated tag object SHA cannot pass as the provenance commit',()=>{
 const observed=observedCase('annotated'),objectSha=JSON.parse(capture(observed.ref!).body).object.sha;
 const result=resolveTag('annotated-object-is-not-commit',{...observed.fixture,runSha:objectSha});
 refused(result,'PROVENANCE_SHA_MISMATCH');expect(result.text).toContain(observed.expectedCommit);expect(result.text).toContain(objectSha);
 onlyCommitLookup(result.calls,observed.repo,observed.tag);
});
for(const created of ['false','']){
 test(`push with release_created=${JSON.stringify(created)} does not resolve a tag or publish`,()=>{
  const result=resolveTag(`no-release-${created||'empty'}`,{created,cutTag:'',apiExit:1});
  expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'false'});expect(result.calls).toEqual([]);
 });
}
test('push tag resolution error fails closed even if an API error emits a plausible SHA',()=>{
 const result=resolveTag('api-error',{apiExit:1});
 refused(result,'RELEASE_TAG_UNRESOLVED');expect(result.output).toBe('');onlyCommitLookup(result.calls);
});
for(const [name,apiOutput] of [['empty',''],['null','null'],['short',commitSha.slice(0,7)],['multiline',`${commitSha}\n${oldSha}`],['object','{"sha":"bad"}']]){
 test(`push refuses ${name} commit resolution`,()=>{
  const result=resolveTag(`invalid-sha-${name}`,{apiResponses:{
   [`repos/rig-c/review/commits/refs%2Ftags%2F${tag}`]:{status:200,body:JSON.stringify({sha:name==='null'?null:apiOutput})},
  }});
  refused(result,'RELEASE_TAG_UNRESOLVED');expect(result.output).toBe('');onlyCommitLookup(result.calls);
 });
}
test('push rejects a malformed cut tag before making an API request',()=>{
 const result=resolveTag('push-invalid-tag',{cutTag:'../heads/main'});
 refused(result,'RELEASE_TAG_FORM');expect(result.calls).toEqual([]);
});

test('dispatch on the tag keeps release-author, commit, main ancestry and registry checks',()=>{
 const result=resolveTag('dispatch-success',{event:'workflow_dispatch'});
 expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'true',tag,sha:commitSha});
 expect(result.calls).toEqual([
  {command:'gh',args:['release','view',tag,'--repo','rig-c/review','--json','author','--jq','.author.login']},
  {command:'git',args:['rev-parse','--verify','--quiet',`refs/tags/${tag}^{commit}`]},
  {command:'git',args:['rev-parse','--verify','--quiet','refs/remotes/origin/main']},
  {command:'git',args:['merge-base','--is-ancestor',commitSha,'refs/remotes/origin/main']},
  {command:'npm',args:['view','@rig-c/review@0.11.1','version']},
 ]);
});
for(const [name,fixture,code,callCount] of [
 ['invalid-tag',{inputTag:'main'},'RELEASE_TAG_FORM',0],
 ['unreleased',{releaseExit:1},'RELEASE_TAG_UNRELEASED',1],
 ['wrong-author',{author:'other-maintainer'},'RELEASE_NOT_RELEASE_PLEASE',1],
 ['tag-not-commit',{tagExit:1},'RELEASE_TAG_NOT_ON_MAIN',2],
 ['missing-main',{mainExit:1},'RELEASE_TAG_NOT_ON_MAIN',3],
 ['not-on-main',{ancestorExit:1},'RELEASE_TAG_NOT_ON_MAIN',4],
 ['run-sha-mismatch',{runSha:oldSha},'PROVENANCE_SHA_MISMATCH',4],
 ['already-published',{served:'0.11.1'},'RELEASE_ALREADY_PUBLISHED',5],
 ] as const){
 test(`dispatch still refuses ${name} before publish=true`,()=>{
  const result=resolveTag(`dispatch-${name}`,{event:'workflow_dispatch',...fixture});
  refused(result,code);expect(result.calls).toHaveLength(callCount);
  if(name==='run-sha-mismatch'){
   expect(result.text).toContain(oldSha);expect(result.text).toContain(commitSha);expect(result.text).toContain(`--ref ${tag}`);
   expect(result.calls.some(call=>call.command==='npm')).toBe(false);
  }
 });
}
