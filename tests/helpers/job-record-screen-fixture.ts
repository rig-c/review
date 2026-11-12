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
import {JOB_API_V3_SCHEMA, type DisplayPublicationV3, type PendingAskV3, type UISubmissionV3, type RecordSignoffStage} from '../../src/job-contract.ts';
import {createJobWindowFixture,scriptedJobWindowFixture} from './job-window-fixture.ts';
import {createSyntheticOptionRecordWorkspace, createSyntheticPlanRecordWorkspace, createSyntheticRecordReader} from './job-record-fixture.ts';

export type RecordScreenKind='checkpoint'|'signoff'|'reopen'|'interview-picks';
export async function recordScreenFixture(kind:RecordScreenKind,picture:boolean|'parts'=false,output?:string,signoffStage:RecordSignoffStage='plan-approved'){
 const scratch=await mkdtemp(join(tmpdir(),'review-750-')),root=join(scratch,'input');await mkdir(root);
 let workspace=kind==='interview-picks'&&!picture?createSyntheticOptionRecordWorkspace(root):createSyntheticPlanRecordWorkspace(root,{subjects:[
  {kind:'checkpoint',checkpointId:'step_layout'},{kind:'signoff',stage:signoffStage},{kind:'reopen',stage:'plan-approved'},
 ]});
 const reader=createSyntheticRecordReader({onOption:()=>workspace.context as never,onPlan:()=>workspace.context as never});
 let packageContext={selector:{kind:'rig',version:1},plan:null,parts:null,subjects:[],partIds:[],files:[]} as import('../../src/job-source.ts').JobPublishedContext;
 const session=new JobSession({root,stateDir:join(scratch,'state'),fingerprint:'7'.repeat(64),reviewer:{id:'synthetic-owner',role:'owner'},
  publicationMode:'record-and-package',readRecordPublished:reader.reader,
  partsEnumerator:{version:'2.25.1',enumerate:()=>[{path:'parts/body.png',role:'part'},{path:'parts/front.png',role:'part'},{path:'painting.png',role:'painting'}]},readPublished:async()=>structuredClone(packageContext)});
 const fake=createJobWindowFixture(session.jobId),resources=jobWindowResources();
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
 if(kind==='interview-picks'&&picture)workspace=createSyntheticOptionRecordWorkspace(root);
 const publication=await call({verb:'publish',expectedGeneration:session.status().generation,idempotencyKey:'record',result:workspace.result,freeze:{kind:'producer-held',holdId:'synthetic-record',record:workspace.record}});
 const display=session.displayPublication(publication.publicationId);fake.publish(display);
 const subject=workspace.context.subjects.find(subject=>subject.kind===kind)!;
 if(!subject)throw new Error('SYNTHETIC_750_SUBJECT_MISSING');
 const ask:PendingAskV3={askId:'ask-'+kind,publicationId:publication.publicationId,source:publication.source,subject,status:'pending'};
 fake.pending(ask,publication.generation);
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
 front=createJobFront({origin,ports:ports as typeof fake.ports,publication:retainedPublicationRoutes(session),resource:async name=>{
  const body=await resources(name);
  if(name==='index.html'&&mode.startsWith('job-window'))return String(body).replace('<body data-job-window>','<body>');
  return body;
 }});
 return {scratch,root,session,origin,display,ask,backdrop,workspace,reader,fake,files,submissions,ports,
  ownerUrl:origin+`/jobs/${session.jobId}/#cap=${credentials.ui}`,
  mode(value:string){mode=value;},output(path:string){writeRoot=path;},
  async metadata(){return await (await fetch(origin+display.routes.apiBase+'review')).json();},
  async close(){front?.stop();await server.stop(true);session.dispose();await rm(scratch,{recursive:true,force:true});},
 };
 }catch(error){front?.stop();await server.stop(true);session.dispose();await rm(scratch,{recursive:true,force:true});throw error;}
}

/** Reuse the existing job-window DOM double, without registering its test suite. */
export async function recordScreenDom(){
 const source=await readFile(new URL('../job-window.test.ts',import.meta.url),'utf8'),start=source.indexOf('    class RuntimeDomNode {'),end=source.indexOf('    function createPublicPlayerDouble(',start);
 if(start<0||end<start)throw new Error('SYNTHETIC_750_DOM_BOUNDARY');
 const Node=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(start,end))+';return RuntimeDomNode;')();
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const set=(key:string,value:unknown)=>{saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 const document={createElement:(tag:string)=>new Node(tag)};set('document',document);
 for(const name of ['HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement'])set(name,Node);
 set('localStorage',{getItem:()=>null,setItem(){}});set('Image',class extends Node{naturalWidth=8;naturalHeight=8;constructor(){super('img');}async decode(){}});
 return {Node,document,set,restore(){for(const [key,value]of saved)if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}};
}
