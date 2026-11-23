/** #750 trusted-host fixture: existing record readers, retained routes and act writer;
 * deterministic writer identities make separately persisted UI-path outputs comparable.
 * This is not installed Create/Parts conformance. */
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JobSession} from '../../src/job-session.ts';
import {createJobHostPorts} from '../../src/job-api.ts';
import {prepareJobRecordAct} from '../../src/job-act.ts';
import type {JobRetainedRecordSource} from '../../src/job-source.ts';
import {createJobFront, jobWindowResources, retainedPublicationRoutes} from '../../src/job-front.ts';
import {JOB_API_V3_SCHEMA, type DisplayPublicationV3, type NextValueV3, type PendingAskV3, type PublicationV3, type UISubmissionV3, type RecordSignoffStage} from '../../src/job-contract.ts';
import {createJobWindowFixture,scriptedJobWindowFixture} from './job-window-fixture.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticOptionSetsRecordWorkspace, createSyntheticPlanRecordWorkspace, createSyntheticRecordReader,writeWorkspaceFile,type PostPictureCase} from './job-record-fixture.ts';

export type RecordScreenKind='checkpoint'|'signoff'|'interview-picks';
export async function recordScreenFixture(kind:RecordScreenKind,picture:boolean|'parts'=false,output?:string,signoffStage:RecordSignoffStage='plan-approved',boundParts=false,questionImages=true,resourcesOverride?:ReturnType<typeof jobWindowResources>,longInterview=false,deferDelivery=false,postPicture?:PostPictureCase,planOptions?:Pick<NonNullable<Parameters<typeof createSyntheticPlanRecordWorkspace>[1]>,'text'|'interview'>,planPicture?:Buffer,questionImage?:Buffer){
 const scratch=await mkdtemp(join(tmpdir(),'review-750-')),root=join(scratch,'input');await mkdir(root);
 let workspace=kind==='interview-picks'&&!picture?createSyntheticOptionRecordWorkspace(root,{boundParts,questionImages:postPicture==='legacy'?false:questionImages,longInterview,postPicture,
  ...(postPicture?{questionId:'post_timing',setId:'post-picture'}:{}),...(questionImage?{inputImageBytes:questionImage}:{})}):createSyntheticPlanRecordWorkspace(root,{subjects:[
  {kind:'checkpoint',checkpointId:'step_layout'},{kind:'signoff',stage:signoffStage},{kind:'reopen',stage:'plan-approved'},
 ],...planOptions});
 // #983: a plan picture is one more sealed member of the closure, named by path and hash.
 if(planPicture&&workspace.context.plan){
  const picture=writeWorkspaceFile(root,'post/v1/render.png',planPicture);
  (workspace as {context:unknown}).context={...workspace.context,files:[...workspace.context.files,picture].sort((a,b)=>a.path<b.path?-1:1),planPicture:picture};
 }
 const reader=createSyntheticRecordReader({onOption:()=>workspace.context as never,onPlan:()=>workspace.context as never});
 let packageContext={selector:{kind:'rig',version:1},plan:null,parts:null,subjects:[],partIds:[],files:[]} as import('../../src/job-source.ts').JobPublishedContext;
 const session=new JobSession({root,stateDir:join(scratch,'state'),fingerprint:'7'.repeat(64),reviewer:{id:'synthetic-owner',role:'owner'},
  publicationMode:'record-and-package',readRecordPublished:reader.reader,
  partsEnumerator:{version:'2.25.1',enumerate:()=>[{path:'parts/body.png',role:'part'},{path:'parts/front.png',role:'part'},{path:'painting.png',role:'painting'}]},readPublished:async()=>structuredClone(packageContext)});
 const fake=createJobWindowFixture(session.jobId),resources=resourcesOverride??jobWindowResources();
 let front:ReturnType<typeof createJobFront>|undefined,mode='one-screen',writeRoot=output??join(scratch,'acts'),sequence=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:async request=>(await front?.fetch(request))??new Response(null,{status:404})});
 const origin=`http://127.0.0.1:${server.port}`,real=createJobHostPorts(session,origin),credentials=session.hostCredentials();
 const call=async(body:object)=>{const response=await real.handleJobApi(new Request(origin+`/jobs/${session.jobId}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credentials.agent},body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:session.jobId,requestId:'fixture-'+(++sequence),...body})}));const result=await response.json();if(!result.ok)throw new Error(JSON.stringify(result));return result.value;};
 try {
 let backdrop:DisplayPublicationV3|null=null;
 if(picture){
  await cp(new URL('../fixtures/viewport-387/package/',import.meta.url),join(root,'out'),{recursive:true});
  if(picture==='parts'){const builder=await scriptedJobWindowFixture({c5Parts:'mesh'});try{await builder.publish('parts');await cp(builder.packageRoot,join(root,'out'),{recursive:true});packageContext=builder.input.getContext();}finally{await builder.close();}}
  const publication=await call({verb:'publish',expectedGeneration:session.status().generation,idempotencyKey:'picture',result:{kind:'package',path:'out',selector:packageContext.selector},freeze:{kind:'producer-held',holdId:'synthetic-picture',record:workspace.record}});
  backdrop=session.displayPublication(publication.publicationId);fake.publish(backdrop);
 }
 // The prior rig is retained before the synthetic producer advances into pending options.
 if(kind==='interview-picks'&&picture)workspace=createSyntheticOptionRecordWorkspace(root,{questionImages,longInterview,...(questionImage?{inputImageBytes:questionImage}:{})});
 const publication=await call({verb:'publish',expectedGeneration:session.status().generation,idempotencyKey:'record',result:workspace.result,freeze:{kind:'producer-held',holdId:'synthetic-record',record:workspace.record}});
 const display=session.displayPublication(publication.publicationId);if(!deferDelivery)fake.publish(display);
 const subject=workspace.context.subjects.find(subject=>subject.kind===kind)!;
 if(!subject)throw new Error('SYNTHETIC_750_SUBJECT_MISSING');
 const ask:PendingAskV3={askId:'ask-'+kind,publicationId:publication.publicationId,source:publication.source,subject,status:'pending'};
 if(!deferDelivery)fake.pending(ask,publication.generation);
 if(backdrop)fake.pending({askId:'historical-incompatible',publicationId:backdrop.publication.publicationId,source:backdrop.publication.source,subject:{kind:'signoff',stage:'plan-approved'},status:'pending'},publication.generation);
 const files:string[]=[],submissions:UISubmissionV3[]=[];
 const ports={...fake.ports,async commitUIAct(_job:string,request:Request){
  const input=await request.json() as UISubmissionV3;submissions.push(structuredClone(input));
  try{
   const act=prepareJobRecordAct({jobId:session.jobId,submission:input,ask,retained:session.retainedSourceV3(ask.publicationId) as JobRetainedRecordSource,reviewer:{id:'synthetic-owner',role:'owner'},actId:'act-'+kind,at:'2026-11-08T12:00:00.000Z'});
   const path=join(writeRoot,mode+'.json');await mkdir(writeRoot,{recursive:true});await writeFile(path,JSON.stringify(act));files.push(path);
   return {ok:true as const,value:act};
  }catch(error){await mkdir(writeRoot,{recursive:true});await writeFile(join(writeRoot,mode+'.refusal.json'),JSON.stringify({error:String(error),input},null,2)+'\n');return {ok:false as const,error:{code:'JOB_ACT_INVALID',message:String(error)}};}
 }};
 const routes=retainedPublicationRoutes(session);
 let rigPictureSuppressed=false;
 front=createJobFront({origin,ports:ports as typeof fake.ports,async publication(...args){
  const [,publicationId,,path,request]=args;
  const response=await routes(...args);
  if(!rigPictureSuppressed||publicationId!==display.publication.publicationId||request.method!=='GET'||!response.ok||
    (path!=='api/review'&&path!=='api/interview'))return response;
  // Change only the presentation. The fixture replays the same pending ask on a fresh page.
  const body=await response.json();
  if(path==='api/review'){
   for(const key of ['manifest','reviewedSource','initialAnimation','setsHash','direction','scene','referenceHashes','sourcePainting'])delete body[key];
   body.capabilities.playback=false;
   body.feedbackCatalog={slots:null};
  }else{
   const question=body.questions.find((item:{set:{id:string;question:string}})=>
    subject.kind==='interview-picks'&&item.set.id===subject.setId&&item.set.question===subject.questionId);
   question.missingPicture='rig';
  }
  return Response.json(body,{headers:response.headers});
 },resource:async name=>{
  const body=await resources(name);
  return body;
 }});
 return {scratch,root,session,origin,display,ask,backdrop,workspace,reader,fake,files,submissions,ports,
  deliver(){fake.publish(display);fake.pending(ask,publication.generation);},
  /** #1048: republish the same plan (or option set) with new picture (or question image) bytes; the old publication is
   * the new one's previous. */
  async republishPicture(bytes:Buffer){
   if(kind==='interview-picks'){
    if(picture||!questionImage)throw new Error('SYNTHETIC_1048_QUESTION_IMAGE_REQUIRED');
    workspace=createSyntheticOptionRecordWorkspace(root,{boundParts,questionImages,longInterview,inputImageBytes:bytes});
   }else{
   const context=workspace.context as {files:readonly {path:string;sha256:string}[];planPicture?:{path:string;sha256:string}};
   if(!context.planPicture)throw new Error('SYNTHETIC_1048_PLAN_PICTURE_REQUIRED');
   const picture=writeWorkspaceFile(root,context.planPicture.path,bytes);
   (workspace as {context:unknown}).context={...context,files:context.files.map(file=>file.path===picture.path?picture:file),planPicture:picture};
   }
   const next=await call({verb:'publish',expectedGeneration:session.status().generation,idempotencyKey:'record-1048',result:workspace.result,freeze:{kind:'producer-held',holdId:'synthetic-record-1048',record:workspace.record}});
   const nextDisplay=session.displayPublication(next.publicationId);fake.publish(nextDisplay);
   fake.pending({...ask,askId:'ask-'+kind+'-1048',publicationId:next.publicationId,source:next.source},next.generation);
   return nextDisplay;
  },
  ownerUrl:origin+`/jobs/${session.jobId}/#cap=${credentials.ui}`,
  mode(value:string){mode=value;},output(path:string){writeRoot=path;},
  suppressRigPicture(){if(postPicture!=='bound-rig')throw new Error('SYNTHETIC_929_BOUND_RIG_REQUIRED');rigPictureSuppressed=true;},
  async metadata(){return await (await fetch(origin+display.routes.apiBase+'review')).json();},
  async close(){front?.stop();await server.stop(true);session.dispose();await rm(scratch,{recursive:true,force:true});},
 };
 }catch(error){front?.stop();await server.stop(true);session.dispose();await rm(scratch,{recursive:true,force:true});throw error;}
}

/** The real job page over a real session. One publication carries `count` question sets and each set
 * has its own pending ask. `answered` seeds that many unsent local drafts (the recommended pick of every prompt), so
 * the page opens with the same partly answered list the owner ruled on. */
export async function optionSetsJobFixture(options:Parameters<typeof createSyntheticOptionSetsRecordWorkspace>[1]&{answered?:number}){
 const scratch=await mkdtemp(join(tmpdir(),'review-1004-')),root=join(scratch,'input');await mkdir(root);
 const workspace=createSyntheticOptionSetsRecordWorkspace(root,options);
 const reader=createSyntheticRecordReader({onOption:()=>structuredClone(workspace.context)});
 const session=new JobSession({root,stateDir:join(scratch,'state'),fingerprint:'4'.repeat(64),reviewer:{id:'synthetic-owner',role:'owner'},
  publicationMode:'record-and-package',readRecordPublished:reader.reader});
 let front:ReturnType<typeof createJobFront>|undefined,seed='';
 const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:async request=>(await front?.fetch(request))??new Response(null,{status:404})});
 const origin=`http://127.0.0.1:${server.port}`,ports=createJobHostPorts(session,origin),credentials=session.hostCredentials();
 let sequence=0;
 const call=async<T>(body:object):Promise<T>=>{const response=await ports.handleJobApi(new Request(origin+`/jobs/${session.jobId}/api`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credentials.agent},body:JSON.stringify({schema:JOB_API_V3_SCHEMA,jobId:session.jobId,requestId:'fixture-'+(++sequence),...body})}));const result=await response.json();if(!result.ok)throw new Error(JSON.stringify(result));return result.value;};
 const close=async()=>{front?.stop();await server.stop(true);session.dispose();await rm(scratch,{recursive:true,force:true});};
 try{
  const publication=await call<PublicationV3>({verb:'publish',expectedGeneration:0,idempotencyKey:'publish',result:workspace.result,freeze:{kind:'producer-held',holdId:'synthetic-1004',record:workspace.record}});
  const display=session.displayPublication(publication.publicationId);
  const {asks}=await call<{asks:PendingAskV3[]}>({verb:'ask-batch',expectedGeneration:session.status().generation,idempotencyKey:'asks',publicationId:publication.publicationId,subjects:workspace.context.subjects});
  const retained=session.retainedSourceV3(publication.publicationId) as JobRetainedRecordSource;
  const forms=asks.slice(0,options.answered??0).map((ask,index)=>{const question=retained.questions[index]!;
   const selections=question.set.asks.map(item=>({itemId:item.id,optionId:item.options.find(option=>option.recommended)!.id,otherText:null}));
   return {askId:ask.askId,value:{questionId:question.set.question,selections,note:''},controls:[...selections.map(item=>({name:'choice.'+item.itemId,value:item.optionId})),{name:'note',value:''}]};});
  if(forms.length){
   const key=`rig-review-job-draft/1:${session.jobId}:${workspace.result.questionId}:${workspace.result.setId}:${publication.source.sourceHash}`;
   const value=JSON.stringify({publicationId:publication.publicationId,sourceHash:publication.source.sourceHash,source:publication.source,label:publication.label,forms});
   seed=`try{if(!localStorage.getItem(${JSON.stringify(key)}))localStorage.setItem(${JSON.stringify(key)},${JSON.stringify(value)});}catch{}`;
  }
  const resources=jobWindowResources();
  front=createJobFront({origin,ports,publication:retainedPublicationRoutes(session),resource:async name=>name==='main.js'&&seed?seed+'\n'+await new Response(await resources(name)).text():resources(name)});
  const readEvents=()=>call<NextValueV3>({verb:'next',after:null,waitMs:0});
  return {scratch,root,session,origin,workspace,publication,display,asks,call,readEvents,ownerUrl:origin+`/jobs/${session.jobId}/#cap=${credentials.ui}`,close};
 }catch(error){await close();throw error;}
}

/** Reuse the existing job-window DOM double, without registering its test suite. */
export async function recordScreenDom(){
 const source=await readFile(new URL('../job-window.test.ts',import.meta.url),'utf8'),start=source.indexOf('    class RuntimeDomNode {'),end=source.indexOf('\n});',start);
 if(start<0||end<start)throw new Error('SYNTHETIC_750_DOM_BOUNDARY');
 const Node=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end))+';return RuntimeDomNode;')();
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const set=(key:string,value:unknown)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 const document={createElement:(tag:string)=>new Node(tag)};set('document',document);
 for(const name of ['HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement'])set(name,Node);
 set('localStorage',{getItem:()=>null,setItem(){}});set('Image',class extends Node{naturalWidth=8;naturalHeight=8;constructor(){super('img');}async decode(){}});
 return {Node,document,set,restore(){for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}};
}
