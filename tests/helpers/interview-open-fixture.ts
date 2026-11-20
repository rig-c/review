/** Synthetic interview-only input. No writer archive or private pilot content. */
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../../src/interview-project.ts';

export async function interviewOpenFixture(questions:1|2=1){
 const scratch=await mkdtemp(join(tmpdir(),'review-interview-open-'));
 const root=join(scratch,'project'),stateDir=join(scratch,'state');
 await cp(new URL('../fixtures/interview-open-725/',import.meta.url),root,{recursive:true});
 await mkdir(join(root,'picks'));
 const project=JSON.parse(await readFile(join(root,'project.json'),'utf8'));
 if(questions===2){
  const original=JSON.parse(await readFile(join(root,'evidence/options.json'),'utf8'));
  const bytes=JSON.stringify({...original,id:'synthetic-second-set',question:'rig_type'});
  await writeFile(join(root,'evidence/options-second.json'),bytes);
  project.interview.framing.push({id:'rig_type',pending_options:{path:'evidence/options-second.json',sha256:digest(bytes)}});
  await writeFile(join(root,'project.json'),JSON.stringify(project));
 }
 const inputs={input:root,project:{root,picksDir:'picks'}};
 return {scratch,root,stateDir,project,inputs,close:()=>rm(scratch,{recursive:true,force:true})};
}
