import {sharedTurnDials} from './turn-pad.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { choice, object } from './manifest.ts';
import { parseFeedback, readPackageFeedback, validatePackageFeedback, type FeedbackWarning, type Feedback } from './session.ts';
import { assertCompareUnchanged, type CompareBinding, type ComparePackage } from './compare.ts';

export interface CompareFeedback extends Feedback {side:'a'|'b'}
export interface CompareSession {schema:'rig-review-compare-session/1';id:string;revision:'compare/1';sourceHash:string;binding:CompareBinding;status:'pending'|'approved'|'changes-requested';feedback:CompareFeedback[];feedbackWarnings:FeedbackWarning[];updatedAt:string|null}
export function freshCompareSession(p:ComparePackage):CompareSession {const d=p.response;return {schema:'rig-review-compare-session/1',id:d.id,revision:d.revision,sourceHash:d.sourceHash,binding:d.binding,status:'pending',feedback:[],feedbackWarnings:[],updatedAt:null};}
export function parseCompareSession(input:unknown,p:ComparePackage,strict=true):CompareSession {
  const value=object(input,'compare session'),fresh=freshCompareSession(p);
  for(const key of ['schema','id','revision','sourceHash'] as const)if(value[key]!==fresh[key])throw new Error(`compare session.${key}: does not match loaded comparison`);
  if(!isDeepStrictEqual(value.binding,fresh.binding))throw new Error('compare session.binding: does not match both source hashes, rig/motion identities, reference hash and animation');
  if(value.corrections!==undefined)throw new Error('compare session.corrections: motion authoring proposals are not accepted');
  if(!Array.isArray(value.feedback)||value.feedback.length>1000)throw new Error('compare session.feedback: expected array <= 1000');
  const feedbackWarnings:FeedbackWarning[]=[];
  const turnDials=sharedTurnDials(p.a.feedbackCatalog.turnDials??[],p.b.feedbackCatalog.turnDials??[]);
  const feedback:CompareFeedback[]=value.feedback.map((item:unknown)=>{const side=choice(object(item,'feedback').side,['a','b'] as const,'feedback.side'),parsed=parseFeedback(item,strict);if(strict)return {...validatePackageFeedback(parsed,p[side],p.response.animation,turnDials),side};const read=readPackageFeedback(parsed,p[side],p.response.animation,turnDials);if(read.warning)feedbackWarnings.push(read.warning);return {...read.feedback,side};});
  if(new Set(feedback.map(f=>f.id)).size!==feedback.length)throw new Error('compare session.feedback: duplicate ids');
  return {...fresh,status:choice(value.status,['pending','approved','changes-requested'] as const,'compare session.status'),feedback,feedbackWarnings,updatedAt:new Date().toISOString()};
}
export function compareSessionFile(p:ComparePackage,stateDir=join(homedir(),'.local','state','rig-c-review')):string {const key=createHash('sha256').update(JSON.stringify(['compare',p.response.sourceHash,p.response.binding])).digest('hex');return join(stateDir,key+'.json');}
export async function readCompareSession(p:ComparePackage,stateDir?:string):Promise<CompareSession>{await assertCompareUnchanged(p);try{const value=JSON.parse(await readFile(compareSessionFile(p,stateDir),'utf8'));return {...parseCompareSession(value,p,false),updatedAt:value.updatedAt};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return freshCompareSession(p);throw e;}}
export async function saveCompareSession(p:ComparePackage,input:unknown,stateDir?:string):Promise<CompareSession>{const value=parseCompareSession(input,p);await assertCompareUnchanged(p);const file=compareSessionFile(p,stateDir);await mkdir(join(file,'..'),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,file);return value;}
