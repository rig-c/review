import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../src/interview-project.ts';
import { loadOpenPackage } from '../../src/open.ts';

const archiveHashes={
  '1-parts-verdict':'22d27c2d68b63b3779e565dea28016315e88ec06cca2123a7cbe3514744690fb',
  '2-rigging-answers':'d57a5cc8b2fc957167087fd74457b47db53a7211c8a80ac1a47213ef3294feed',
  'reopened':'35fb7799f48336e10c7999dbeeacdfa87b2e6e015b59a76c6a37d33966f311ff',
};
export async function joinedVerdictFixture(root:string,name:keyof typeof archiveHashes='1-parts-verdict') {
  const base=new URL(name==='reopened'?'../fixtures/create-reopened-v2/project':'../fixtures/create-pre-rig/'+name,import.meta.url);
  const archive=await readFile(new URL(base.href+'.tar.gz'));
  if(digest(archive)!==archiveHashes[name])throw new Error('Joined archive changed');
  await mkdir(root,{recursive:true});
  const extracted=Bun.spawnSync(['tar','-xzf','-','-C',root],{stdin:archive});
  if(extracted.exitCode!==0)throw new Error(extracted.stderr.toString());
  const checkpoint=name==='reopened'?{
    project_sha256:'e3ec008fc9d1b3977315343d5a59c5f2b8ed0fb932b06f85a1afb8c7b74697f1',
    files:(await readFile(new URL('files.sha256',base),'utf8')).trim().split('\n').map(line=>({
      path:line.slice(66).replace(/^\.\//,''),sha256:line.slice(0,64),
    })),
  }:JSON.parse(await readFile(new URL(base.href+'.json'),'utf8')) as {project_sha256:string;files:{path:string;sha256:string}[]};
  const assertFixture=async()=>{
    if(digest(await readFile(join(root,'project.json')))!==checkpoint.project_sha256)throw new Error('Checkpoint project changed');
    for(const file of checkpoint.files)if(digest(await readFile(join(root,file.path)))!==file.sha256)
      throw new Error('Checkpoint file changed: '+file.path);
  };
  await assertFixture();
  const project={root,draftId:name==='reopened'?'example':'chain',picksDir:'reviewer-picks',partsVerdictDir:'reviewer-verdicts'};
  await mkdir(join(root,project.picksDir));
  const output=join(root,project.partsVerdictDir);
  await mkdir(output);
  const input=join(root,'derived/drafts',project.draftId,'out/check');
  const opened=await loadOpenPackage({input,project});
  if(opened.mode!=='single'||!opened.joined?.draft)throw new Error('Expected joined draft fixture');
  return {input,project,output,p:opened.p,joined:opened.joined,draft:opened.joined.draft,assertFixture};
}
