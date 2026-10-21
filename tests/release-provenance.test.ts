import {expect,test} from 'bun:test';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

type Step={id?:string;name?:string;uses?:string;if?:string;env?:Record<string,string>;with?:Record<string,unknown>;run?:string};
type Workflow={on:unknown;permissions:unknown;concurrency:unknown;jobs:{release:{'runs-on':string;permissions:unknown;steps:Step[]}}};
const workflow=Bun.YAML.parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')) as Workflow;
const steps=workflow.jobs.release.steps;
const target=steps.find(step=>step.id==='target')!;
const tag='v0.11.1',commitSha='a'.repeat(40),oldSha='b'.repeat(40),tagObjectSha='c'.repeat(40);
const recovery=`gh workflow run release.yml --ref ${tag} -f tag=${tag}`;
type Fixture={
 event?:string;created?:string;cutTag?:string;inputTag?:string;runSha?:string;
 refObject?:{type:string;sha:string};commitResponse?:{sha:unknown};apiExit?:number;apiOutput?:string;
 author?:string;releaseExit?:number;tagExit?:number;mainExit?:number;ancestorExit?:number;served?:string;
};
type Call={command:string;args:string[]};

// Only these stubs and grep exist on PATH. The extracted workflow runs with no repository,
// inherited credentials, real gh/git/npm, network client, publish or dispatch command.
const stub=String.raw`
import {appendFileSync,readFileSync} from 'node:fs';
import {basename} from 'node:path';
const f=JSON.parse(readFileSync(process.env.FIXTURE,'utf8'));
const command=basename(process.argv[1]),args=process.argv.slice(2);
appendFileSync(process.env.TRACE,JSON.stringify({command,args})+'\n');
const is=(...expected)=>JSON.stringify(args)===JSON.stringify(expected);
const reply=(value,code=0)=>{if(value!==undefined)console.log(value);process.exit(code);};
if(command==='gh'){
 if(is('api','repos/rig-c/review/commits/tags%2F'+f.cutTag,'--jq','.sha')){
  if(f.apiExit)reply(f.apiOutput,f.apiExit);
  // The commit API response has a commit SHA even when the Git ref points to a tag object.
  reply(f.apiOutput!==undefined?f.apiOutput:f.commitResponse.sha);
 }
 if(is('release','view',f.inputTag,'--repo','rig-c/review','--json','author','--jq','.author.login'))reply(f.author,f.releaseExit);
}
if(command==='git'){
 if(is('rev-parse','--verify','--quiet','refs/tags/'+f.inputTag+'^{commit}'))reply(f.commitResponse.sha,f.tagExit);
 if(is('rev-parse','--verify','--quiet','refs/remotes/origin/main'))reply(f.commitResponse.sha,f.mainExit);
 if(is('merge-base','--is-ancestor',f.commitResponse.sha,'refs/remotes/origin/main'))reply(undefined,f.ancestorExit);
}
if(command==='npm'&&is('view','@rig-c/review@'+f.inputTag.slice(1),'version'))reply(f.served,f.served?0:1);
console.error('UNEXPECTED_STUB_COMMAND',command,JSON.stringify(args));process.exit(97);
`;

function resolveTag(name:string,overrides:Fixture={}){
 const root=mkdtempSync(join(tmpdir(),'review-release-provenance-'));
 try{
  const bin=join(root,'bin');mkdirSync(bin);
  const fixture={event:'push',created:'true',cutTag:tag,inputTag:tag,runSha:commitSha,
   refObject:{type:'commit',sha:commitSha},commitResponse:{sha:commitSha},author:'github-actions[bot]',...overrides};
  writeFileSync(join(root,'fixture.json'),JSON.stringify(fixture));
  const output=join(root,'output'),trace=join(root,'trace');writeFileSync(output,'');writeFileSync(trace,'');
  for(const command of ['gh','git','npm']){
   const path=join(bin,command);writeFileSync(path,`#!${process.execPath}\n${stub}`);chmodSync(path,0o755);
  }
  symlinkSync('/usr/bin/grep',join(bin,'grep'));
  expect(existsSync(join(root,'.git'))).toBe(false);
  const result=Bun.spawnSync(['/bin/bash','--noprofile','--norc','-c',target.run!],{
   cwd:root,timeout:10000,
   env:{PATH:bin,HOME:root,EVENT:fixture.event,CREATED:fixture.created,CUT_TAG:fixture.cutTag,
    INPUT_TAG:fixture.inputTag,GITHUB_SHA:fixture.runSha,GITHUB_OUTPUT:output,REPO:'rig-c/review',
    RELEASE_AUTHOR:target.env!.RELEASE_AUTHOR!,FIXTURE:join(root,'fixture.json'),TRACE:trace},
  });
  const stdout=result.stdout.toString(),stderr=result.stderr.toString();
  const outputText=readFileSync(output,'utf8');
  const traceText=readFileSync(trace,'utf8');
  const calls:Call[]=traceText.trim()?traceText.trim().split('\n').map(line=>JSON.parse(line)):[];
  // Optional raw evidence is external to the repository and includes the fake GITHUB_OUTPUT.
  const evidence=process.env.REVIEW_208_EVIDENCE_DIR;
  if(evidence){
   mkdirSync(evidence,{recursive:true});
   writeFileSync(join(evidence,`${name}.json`),JSON.stringify({fixture,exitCode:result.exitCode,stdout,stderr,output:outputText,calls},null,2)+'\n');
  }
  expect(stdout+stderr).not.toContain('UNEXPECTED_STUB_COMMAND');
  return {exitCode:result.exitCode,text:stdout+stderr,output:outputText,calls,
   outputs:Object.fromEntries(outputText.trim().split('\n').filter(Boolean).map(line=>line.split('=')))};
 }finally{rmSync(root,{recursive:true,force:true});}
}
function refused(result:ReturnType<typeof resolveTag>,code:string){
 expect(result.exitCode).toBe(1);
 expect(result.text).toContain(`::error::${code}:`);
 expect(result.output).not.toContain('publish=true');
 expect(result.outputs.sha).toBeUndefined();
}
function onlyCommitLookup(calls:Call[]){
 expect(calls).toEqual([{command:'gh',args:['api',`repos/rig-c/review/commits/tags%2F${tag}`,'--jq','.sha']}]);
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

for(const kind of ['lightweight','annotated']){
 test(`push ${kind} tag resolves to the commit without a checkout`,()=>{
  const result=resolveTag(`push-${kind}`,{refObject:{type:kind==='annotated'?'tag':'commit',sha:kind==='annotated'?tagObjectSha:commitSha}});
  expect(result.exitCode).toBe(0);
  expect(result.outputs).toEqual({publish:'true',tag,sha:commitSha});
  onlyCommitLookup(result.calls);
 });
 test(`push rerun ${kind} mismatch refuses before publishing and names both SHAs and exact recovery`,()=>{
  const result=resolveTag(`mismatch-${kind}`,{runSha:oldSha,refObject:{type:kind==='annotated'?'tag':'commit',sha:kind==='annotated'?tagObjectSha:commitSha}});
  refused(result,'PROVENANCE_SHA_MISMATCH');
  expect(result.text).toContain(oldSha);expect(result.text).toContain(commitSha);
  expect(result.text).toContain(recovery);expect(result.text).toContain('the tag remains cut');
  expect(result.output).toBe('');onlyCommitLookup(result.calls);
 });
}
test('annotated tag object SHA cannot pass as the provenance commit',()=>{
 const result=resolveTag('annotated-object-is-not-commit',{runSha:tagObjectSha,refObject:{type:'tag',sha:tagObjectSha}});
 refused(result,'PROVENANCE_SHA_MISMATCH');expect(result.text).toContain(commitSha);expect(result.text).toContain(tagObjectSha);
 onlyCommitLookup(result.calls);
});
for(const created of ['false','']){
 test(`push with release_created=${JSON.stringify(created)} does not resolve a tag or publish`,()=>{
  const result=resolveTag(`no-release-${created||'empty'}`,{created,cutTag:'',apiExit:1});
  expect(result.exitCode).toBe(0);expect(result.outputs).toEqual({publish:'false'});expect(result.calls).toEqual([]);
 });
}
test('push tag resolution error fails closed even if an API error emits a plausible SHA',()=>{
 const result=resolveTag('api-error',{apiExit:1,apiOutput:commitSha});
 refused(result,'RELEASE_TAG_UNRESOLVED');expect(result.output).toBe('');onlyCommitLookup(result.calls);
});
for(const [name,apiOutput] of [['empty',''],['null','null'],['short',commitSha.slice(0,7)],['multiline',`${commitSha}\n${oldSha}`],['object','{"sha":"bad"}']]){
 test(`push refuses ${name} commit resolution`,()=>{
  const result=resolveTag(`invalid-sha-${name}`,{apiOutput});
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
