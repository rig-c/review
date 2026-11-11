import { lstatSync, readdirSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { boundBytes, checkedPath, digest, jsonObject, literalPath, object, partsDraftEditable, readProject, readRegular, type SetRef } from './interview-project.ts';
import { configNamedReferences, DIRECTORY_INPUT_RECEIPT, plateReceiptSpec, receiptSpec } from './handoff.ts';
import { DIRECTION_MAX_BYTES, readDirectionInspection } from './direction-inspection.ts';
import { outputDirectory } from './interview-picks.ts';
import { packagePath, type ReviewPackage } from './manifest.ts';
import { assertReviewUnchanged, withReviewAssertion } from './reference.ts';

export type ProjectDesignation={root:string;picksDir:string}&(
  {version:number;postVersion?:number;draftId?:never;partsVerdictDir?:never} |
  {draftId:string;partsVerdictDir?:string;version?:never;postVersion?:never}
);
interface DraftRecord {
  id:string;
  kind:'draft-rig';
  at:string;
  producer:{name:string;version:string};
  config:SetRef;
  config_inputs?:(SetRef&{directory?:string;spec?:string})[];
  parts:{path:string;files:SetRef[]};
  files:SetRef[];
}
interface DraftSource {
  record:DraftRecord;
  editable:boolean;
  parts:string;
  rig:string;
  meshReport:string;
  model:string;
  files:ReadonlyMap<string,string>;
  starts?:readonly string[];
}
interface JoinedSource {
  review:ReviewPackage;
  opened:ReturnType<typeof readProject>;
  designation:ProjectDesignation;
  assertCurrent:()=>Promise<void>;
  available:boolean;
  draft?:DraftSource;
  verdictDirectory?:()=>string;
}
export const interviewUnavailable = 'INTERVIEW_UNAVAILABLE';
export const interviewMismatch = 'INTERVIEW_SOURCE_MISMATCH';
export const interviewStale = 'INTERVIEW_OPTIONS_STALE';
export const directionStale = 'DIRECTION_SOURCE_STALE';

export function joinProject(p: ReviewPackage, designation: ProjectDesignation, options: { starts?: readonly string[] } = {}):JoinedSource {
  if(designation.draftId!==undefined)return joinDraft(p,designation,options);
  const opened = readProject(designation.root);
  const {root, hash, project} = opened;
  const {version} = designation;
  const fail = (): never => {throw new Error(interviewMismatch + ': expected the designated Create version’s recorded review package');};
  if (!Number.isSafeInteger(version) || version < 1) return fail();
  const versions = (Array.isArray(project.versions) ? project.versions : []).map(object);
  const matches = versions.filter(entry => entry.n === version && entry.kind === 'rig');
  const record = object(matches[0]?.review_package);
  const path = 'derived/review/v' + version;
  const files = new Map<string, string>();
  try {
    if (matches.length !== 1 || !Array.isArray(record.files)) return fail();
    const out = checkedPath(root, path + '/out', true);
    if (p.buildRoot !== out || p.handoff?.parts !== out || p.handoff.rig !== join(out, 'rig') ||
        p.handoff.config !== checkedPath(root, path + '/config.json') || !p.manifest.model) return fail();
    const pkg = checkedPath(root, path, true);
    for (const entry of record.files.map(object)) {
      const {path, sha256} = entry;
      packagePath(path, 'recorded package file');
      if (!literalPath(path) || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) || files.has(path)) return fail();
      files.set(path, sha256);
    }
    const covered = (absolute: string, sha256?: string) => {
      const expected = files.get(relative(pkg, absolute).split(sep).join('/'));
      return expected !== undefined && (sha256 === undefined || sha256 === expected);
    };
    if (!p.reviewedSource.rig || ![...p.files].every(file => covered(join(p.root, file))) ||
        !p.handoff.record.files.every(file => covered(join(p.root, file.path), file.sha256)) ||
        !covered(join(p.root, p.manifest.model), p.reviewedSource.rig.sha256) ||
        !files.has('out/parts.json') || ![...files.keys()].some(file => file.startsWith('out/parts/'))) return fail();
  } catch {return fail();}

  const assertInventory = () => {
    const pkg = checkedPath(root, path, true);
    const remaining = new Set(files.keys());
    const visit = (prefix: string) => {
      const directory = prefix ? checkedPath(pkg, prefix.slice(0,-1), true) : pkg;
      for (const entry of readdirSync(directory, {withFileTypes:true})) {
        const name = prefix + entry.name;
        if (!literalPath(name)) return fail();
        if (entry.isDirectory()) visit(name + '/');
        else if (!entry.isFile() || !remaining.delete(name)) return fail();
      }
    };
    visit('');
    if (remaining.size) return fail();
    for (const [path, sha256] of files) boundBytes(pkg, {path, sha256});
  };
  try {assertInventory();} catch {return fail();}
  outputDirectory(root, designation.picksDir, project);

  // The existing join has already matched the exact recorded package inventory.
  // Derive the project-relative model from the inspected asset, never from a SHA search.
  let direction: ReviewPackage['direction'];
  const postVersion = designation.postVersion;
  const readDirection = (path: string) => readRegular(checkedPath(root, path), DIRECTION_MAX_BYTES);
  if (postVersion !== undefined) {
    const posts = versions.filter(entry => entry.n === postVersion);
    const post = posts[0];
    if (!Number.isSafeInteger(postVersion) || postVersion < 1 || posts.length !== 1 || post?.kind !== 'post')
      throw new Error('DIRECTION_VERSION: select a recorded Create post version');
    if (post.rig_version !== version)
      throw new Error('DIRECTION_RIG_MISMATCH: selected post names a different rig version');
    const provenance = object(post.provenance);
    if (provenance.direction === undefined)
      throw new Error('DIRECTION_DOCUMENT_REQUIRED: selected post has no authored direction');
    const {path: directionPath, sha256} = object(provenance.direction);
    const bindsDirection = (value: unknown) => {
      const binding = object(value);
      return binding.path === directionPath && binding.sha256 === sha256;
    };
    if (directionPath !== `evidence/direction/v${postVersion}.json` ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256) ||
        !bindsDirection(provenance.config) || !Array.isArray(post.outputs) || !post.outputs.some(bindsDirection))
      throw new Error('DIRECTION_VERSION: selected post must bind its exact direction document');
    const file = {path: directionPath, sha256};
    let bytes: Buffer;
    try {
      bytes = readDirection(file.path);
      if (digest(bytes) !== file.sha256) throw new Error('SHA mismatch');
    } catch {
      throw new Error('DIRECTION_SOURCE_MISMATCH: selected direction is missing, unsafe or differs from its recorded SHA-256');
    }
    const model = p.reviewedSource.rig!;
    const projectModel = {...model, path: relative(root, join(p.root, model.path)).split(sep).join('/')};
    let document: unknown;
    try { document = jsonObject(bytes); }
    catch { throw new Error('DIRECTION_SCHEMA: expected a UTF-8 JSON direction object'); }
    const inspected = readDirectionInspection(document, file, projectModel);
    if (inspected.rigVersion !== version)
      throw new Error('DIRECTION_RIG_MISMATCH: authored direction names a different rig version');
    direction = {...inspected, joined: {postVersion, projectHash:hash, packageSourceHash:p.sourceHash, packageRoot:path, projectModel}};
  }
  const assertCurrent = async () => {
    try {
      await assertReviewUnchanged(p);
      assertInventory();
      if (digest(readRegular(checkedPath(root, 'project.json'), 8 * 1024 * 1024)) !== hash) throw new Error('Project changed');
    } catch {throw new Error(interviewStale + ': project or review package changed; reopen the project');}
    if (direction) {
      try {
        if (digest(readDirection(direction.file.path)) !== direction.file.sha256) throw new Error('SHA mismatch');
      } catch {
        throw new Error(directionStale);
      }
    }
  };
  const review = direction ? withReviewAssertion({
    ...p, direction,
    sourceHash:digest(JSON.stringify({schema:'rig-review-joined-direction/1', direction:direction.file, rigVersion:version, ...direction.joined})),
  }, assertCurrent) : p;
  return {review, opened, designation:{...designation, root}, assertCurrent,
    available:opened.questions.length > 0 || opened.historical.length > 0};
}
/** Match the draft writer's explicit parts and rig inventories, independently of a production version. */
function joinDraft(p:ReviewPackage,designation:Extract<ProjectDesignation,{draftId:string}>,options:{starts?:readonly string[]}={}):JoinedSource {
  const opened=readProject(designation.root);
  const {root,hash,project}=opened;
  const {draftId}=designation;
  const path='derived/drafts/'+draftId;
  const fail=():never=>{throw new Error('INTERVIEW_SOURCE_MISMATCH: expected the selected Create pre-rig draft and exact recorded files');};
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(draftId)||!Array.isArray(project.versions)||
     !Array.isArray(project.drafts)||!Array.isArray(project.signoffs)||!p.manifest.model||!p.reviewedSource.rig||
     p.direction||p.handoffInputs)return fail();
  const matches=project.drafts.map(object).filter(draft=>draft.id===draftId);
  const record=matches[0],parts=object(record?.parts);
  const producer=object(record?.producer);
  if(matches.length!==1||record?.kind!=='draft-rig'||typeof record.at!=='string'||!Number.isFinite(Date.parse(record.at))||
     producer.name!=='@rig-c/parts'||typeof producer.version!=='string'||!producer.version.trim()||
     // Create's draft-rig records the draft directory itself when --parts is omitted (rig-create src/drafts.ts `opts['--parts'] ?? from`).
     !literalPath(parts.path)||!(parts.path===path||parts.path.startsWith(path+'/'))||
     !Array.isArray(parts.files)||!Array.isArray(record.files)||
     (record.config_inputs!==undefined&&!Array.isArray(record.config_inputs)))return fail();
  const files=new Map<string,string>();
  const inventory=(refs:unknown[],prefix:string)=>{
    const paths:string[]=[];
    for(const ref of refs){
      const {path,sha256}=object(ref);
      if(!literalPath(path)||!path.startsWith(prefix+'/')||typeof sha256!=='string'||!/^[a-f0-9]{64}$/.test(sha256))return fail();
      packagePath(path);
      if(paths.includes(path)||(files.has(path)&&files.get(path)!==sha256))return fail();
      paths.push(path);
      files.set(path,sha256);
    }
    return paths;
  };
  let draft:DraftSource;
  let assertInventory:()=>void;
  const searchStarts=options.starts??[...(p.cwd?[p.cwd]:[]),process.cwd()];
  try{
    inventory([record.config,...(record.config_inputs??[])],path);
    const config=object(record.config),doc=jsonObject(boundBytes(root,config as unknown as SetRef));
    const configDir=posix.dirname(config.path as string);
    const {partsRoot,references}=configNamedReferences(doc,[join(root,configDir),root,p.root,...searchStarts]);
    const rawInputs=(record.config_inputs??[]).map(object);
    for(const entry of rawInputs){
      if(entry.directory!==undefined){
        if(!literalPath(entry.directory)||!entry.directory.startsWith(path+'/')||entry.path!==`${entry.directory}/${DIRECTORY_INPUT_RECEIPT}`||typeof entry.spec!=='string'||!entry.spec)return fail();
        checkedPath(root,entry.directory,true);
        const bytes=boundBytes(root,{path:entry.path as string,sha256:entry.sha256 as string});
        if(receiptSpec(bytes)!==entry.spec)return fail();
      }else if(entry.spec!==undefined)return fail();
    }
    for(const ref of references){
      if(!literalPath(ref.value))return fail();
      const resolved=posix.join(configDir,ref.value);
      if(ref.kind==='plate'){
        const expectedSpec=plateReceiptSpec(partsRoot,`config ${ref.at}`);
        const receiptPath=`${resolved}/${DIRECTORY_INPUT_RECEIPT}`;
        if(!rawInputs.some(entry=>entry.path===receiptPath&&entry.directory===resolved&&entry.spec===expectedSpec))return fail();
      }else if(!rawInputs.some(entry=>entry.path===resolved&&entry.directory===undefined)){
        return fail();
      }
    }
    const input=inventory(parts.files,parts.path);
    if(!input.includes(parts.path+'/parts.json')||!input.some(file=>file.startsWith(parts.path+'/parts/')))return fail();
    const manifest=jsonObject(boundBytes(root,{path:parts.path+'/parts.json',sha256:files.get(parts.path+'/parts.json')!}));
    if(!Array.isArray(manifest.parts)||manifest.parts.some(part=>{
      const {name}=object(part);
      return !literalPath(name)||name.includes('/')||!input.includes(parts.path+'/parts/'+name+'.png');
    }))return fail();
    if(manifest.painting_in_rig!==undefined){
      const painting=object(manifest.painting_in_rig);
      if(!literalPath(painting.path)||!input.includes(parts.path+'/'+painting.path)||
         files.get(parts.path+'/'+painting.path)!==painting.sha256)return fail();
    }
    const output=inventory(record.files,path);
    const rigs=output.filter(file=>file.endsWith('/rig.json'));
    if(rigs.length!==1)return fail();
    const rig=rigs[0]!,dir=rig.slice(0,-'/rig.json'.length);
    const meshReport=dir+'/mesh_report.json';
    const model=relative(root,join(p.root,p.manifest.model)).split(sep).join('/');
    const checkRoot=dir.endsWith('/rig')?dir.slice(0,-'/rig'.length):dir;
    if(!output.includes(meshReport)||!output.includes(dir+'/motion.json')||
       !model.startsWith(checkRoot+'/check/')||!output.includes(model)||files.get(model)!==p.reviewedSource.rig.sha256||
       ![...p.files].every(file=>output.includes(relative(root,join(p.root,file)).split(sep).join('/'))))return fail();
    const directoryInventory=(prefix:string,expected:string[])=>{
      const remaining=new Set(expected);
      const visit=(prefix:string)=>{
        for(const entry of readdirSync(checkedPath(root,prefix,true),{withFileTypes:true})){
          const file=prefix+'/'+entry.name;
          if(!literalPath(file))return fail();
          if(entry.isDirectory())visit(file);
          else if(!entry.isFile()||!remaining.delete(file))return fail();
        }
      };
      visit(prefix);
      if(remaining.size)return fail();
    };
    assertInventory=()=>{
      directoryInventory(parts.path+'/parts',input.filter(file=>file.startsWith(parts.path+'/parts/')));
      directoryInventory(checkRoot,output);
    };
    assertInventory();
    draft={record:record as unknown as DraftRecord,editable:partsDraftEditable(project),
      parts:checkedPath(root,parts.path,true),rig:checkedPath(root,rig),meshReport:checkedPath(root,meshReport),
      model:checkedPath(root,model),files:new Map([...files].map(([file,sha])=>[checkedPath(root,file),sha])),
      starts:[join(root,configDir),root,p.root,...searchStarts]};
    for(const [path,sha256] of files)boundBytes(root,{path,sha256});
  }catch{return fail();}
  outputDirectory(root,designation.picksDir,project);
  const assertCurrent=async()=>{
    try{
      await assertReviewUnchanged(p);
      assertInventory();
      for(const [path,sha256] of files)boundBytes(root,{path,sha256});
      if(digest(readRegular(checkedPath(root,'project.json'),8*1024*1024))!==hash)throw new Error('Project changed');
    }catch{throw new Error(interviewStale+': project or draft changed; reopen the project');}
  };
  const dir=designation.partsVerdictDir;
  // An explicit output selects the write surface. A recorded parts approval closes it.
  let verdictDirectory:JoinedSource['verdictDirectory'];
  if(dir!==undefined){
    const locate=()=>{
      const portable=(value:string)=>value.normalize('NFC').toLowerCase();
      const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
      if(overlaps(portable(dir),portable(path))||overlaps(portable(dir),portable(designation.picksDir)))
        throw new Error('PARTS_VERDICT_OUTPUT');
      try{return outputDirectory(root,dir,project);}
      catch{throw new Error('PARTS_VERDICT_OUTPUT');}
    };
    const original=lstatSync(locate());
    if(draft.editable)verdictDirectory=()=>{
      const output=locate(),stat=lstatSync(output);
      if(stat.dev!==original.dev||stat.ino!==original.ino)throw new Error('PARTS_VERDICT_OUTPUT');
      return output;
    };
  }
  const review=withReviewAssertion({...p,manifest:{...p.manifest,model:undefined},handoff:null,report:null,
    feedbackCatalog:{rig:p.feedbackCatalog.rig,bones:null,slots:null,animations:null,clock:null,clockAnimation:null},
    sourceHash:digest(JSON.stringify({schema:'rig-review-joined-draft/1',draftId,projectHash:hash,packageSourceHash:p.sourceHash})),
  },assertCurrent);
  return {review,opened,designation:{...designation,root},assertCurrent,draft,verdictDirectory,
    available:opened.questions.length>0||opened.historical.length>0};
}
export type JoinedProject = ReturnType<typeof joinProject>;
