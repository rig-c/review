/** Synthetic interview-only input. No writer archive or private pilot content. */
import {cp,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function interviewOpenFixture(){
 const scratch=await mkdtemp(join(tmpdir(),'review-interview-open-'));
 const root=join(scratch,'project'),stateDir=join(scratch,'state');
 await cp(new URL('../fixtures/interview-open-725/',import.meta.url),root,{recursive:true});
 await mkdir(join(root,'picks'));
 const project=JSON.parse(await readFile(join(root,'project.json'),'utf8'));
 const inputs={input:root,project:{root,picksDir:'picks'}};
 return {scratch,root,stateDir,project,inputs,close:()=>rm(scratch,{recursive:true,force:true})};
}
