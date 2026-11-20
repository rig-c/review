/** Synthetic interview-only input. No writer archive or private pilot content. */
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {digest} from '../../src/interview-project.ts';

/** #1004 plan: four rigging questions on the pilot's topics (bones, meshes, constraints, motion), in Korean 해요체.
 * Fixture text, not catalog strings. Question and set ids are ASCII identifiers (src/interview-project.ts:40), so the
 * id is the short title and the prompt carries the Korean question. A fresh interview-stage set binds the project's
 * whole input context (readProject refuses any other), so all four draw the same declared painting. */
type PlanOption={id:string;label:string;effect:string;reason?:string};
const RIGGING_PLAN:{question:string;prompt:string;values:[PlanOption,PlanOption]}[]=[
 {question:'bones',prompt:'팔다리 뼈를 몇 마디로 나눌까요?',values:[
  {id:'two_segments',label:'두 마디로 나눠요',effect:'위팔·아래팔, 허벅지·정강이로 나눠요',reason:'그림의 관절 위치와 맞아요'},
  {id:'three_segments',label:'세 마디로 나눠요',effect:'비틀림 뼈를 하나 더 넣어 손목과 발목이 자연스럽게 돌아가요'}]},
 {question:'meshes',prompt:'옷자락 메시를 어떻게 나눌까요?',values:[
  {id:'single_sheet',label:'한 장으로 둬요',effect:'옷자락 전체가 함께 움직여요',reason:'그림에서 옷자락이 한 덩어리로 그려져 있어요'},
  {id:'split_panels',label:'앞뒤 두 장으로 나눠요',effect:'걸을 때 앞자락과 뒷자락이 따로 흔들려요'}]},
 {question:'constraints',prompt:'다리에 IK 제약을 걸까요?',values:[
  {id:'leg_ik',label:'다리에 IK를 걸어요',effect:'발을 바닥에 고정한 채 몸을 움직일 수 있어요',reason:'서 있는 자세가 많은 캐릭터예요'},
  {id:'fk_only',label:'FK로만 움직여요',effect:'관절을 하나씩 돌려서 자세를 잡아요'}]},
 {question:'motion',prompt:'기본 대기 모션은 어떻게 할까요?',values:[
  {id:'breathing',label:'숨쉬기만 넣어요',effect:'가슴과 어깨가 천천히 오르내려요',reason:'정면 일러스트에 가장 무난해요'},
  {id:'sway',label:'몸을 살짝 흔들어요',effect:'숨쉬기에 좌우 흔들림을 더해요'}]},
];

/** `painting` (#1004 serve only): an absolute path to a local PNG, copied into this temp project, never into the repo. */
export async function interviewOpenFixture(questions:1|2|4=1,painting?:string){
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
  let context=original.context;
  if(painting!==undefined){
   if(!isAbsolute(painting))throw new Error('PLAN_1004_PAINTING_NOT_ABSOLUTE');
   const bytes=await readFile(painting);
   if(!bytes.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))throw new Error('PLAN_1004_PAINTING_NOT_PNG');
   const image={path:'painting.png',sha256:digest(bytes)};
   await writeFile(join(root,image.path),bytes);
   project.inputs=[image];context={kind:'inputs',files:[image]};
  }
  project.interview.framing=[];
  for(const [index,item] of RIGGING_PLAN.entries()){
   const options=[
    ...item.values.map((value,n)=>({id:value.id,kind:'value',label:value.label,effect:value.effect,fragment:value.id,recommended:n===0,...(value.reason?{reason:value.reason}:{})})),
    {id:'other',kind:'other',label:'직접 적을게요',effect:'원하는 방식을 직접 적어요',recommended:false},
    {id:'auto',kind:'auto',label:'알아서 정해 주세요',effect:'AI가 그림을 보고 정해요',recommended:false},
   ];
   const set={...original,id:`rig-${item.question}-01`,question:item.question,context,
    asks:[{id:item.question,prompt:item.prompt,options}]};
   const bytes=JSON.stringify(set),path=`evidence/rigging-${index+1}.json`;
   await writeFile(join(root,path),bytes);
   project.interview.framing.push({id:item.question,pending_options:{path,sha256:digest(bytes)}});
  }
  await writeFile(join(root,'project.json'),JSON.stringify(project));
 }
 const inputs={input:root,project:{root,picksDir:'picks'}};
 return {scratch,root,stateDir,project,inputs,close:()=>rm(scratch,{recursive:true,force:true})};
}
