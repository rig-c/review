/** Synthetic interview-only input. No writer archive or private pilot content. */
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../../src/interview-project.ts';

/** #1004 plan: four rigging questions. A fresh interview-stage set binds the project's whole input
 * context (readProject refuses any other), so all four draw the same declared painting. */
const RIGGING_PLAN=[
 {question:'rig_type',prompt:'Choose the rig type.'},
 {question:'spine_chain',prompt:'Choose the spine chain.'},
 {question:'limb_ik',prompt:'Choose the limb solver.'},
 {question:'face_rig',prompt:'Choose the face rig.'},
] as const;

export async function interviewOpenFixture(questions:1|2|4=1){
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
 if(questions===4){
  const original=JSON.parse(await readFile(join(root,'evidence/options.json'),'utf8'));
  project.interview.framing=[];
  for(const [index,item] of RIGGING_PLAN.entries()){
   const set={...original,id:`synthetic-rigging-${index+1}`,question:item.question,
    asks:[{...original.asks[0],id:item.question,prompt:item.prompt}]};
   const bytes=JSON.stringify(set),path=`evidence/rigging-${index+1}.json`;
   await writeFile(join(root,path),bytes);
   project.interview.framing.push({id:item.question,pending_options:{path,sha256:digest(bytes)}});
  }
  await writeFile(join(root,'project.json'),JSON.stringify(project));
 }
 const inputs={input:root,project:{root,picksDir:'picks'}};
 return {scratch,root,stateDir,project,inputs,close:()=>rm(scratch,{recursive:true,force:true})};
}
