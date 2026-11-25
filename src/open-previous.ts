import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {jobHash} from './job-api.ts';
import {JOB_PREVIOUS_BUILD_SCHEMA} from './job-contract.ts';
import {assertRetainedSnapshotLayout} from './job-source.ts';
import {jobPath} from './job-validation.ts';
import {BUILD_ROOT_FILES} from './handoff.ts';
import {checkedPath} from './interview-project.ts';
import {loadReview, parsePreviousBuild, previousBuildFileError, type PreviousOpenSource, type ReviewPackage} from './manifest.ts';
import {handoffFlags, type OpenInputs} from './open.ts';
import {assertPrivate, readPrivate, writePrivate} from './open-workspace-state.ts';
import {hashReferenceFile} from './reference.ts';
import {canonicalStatePath, stateDirInside, stateRoots, type StateRoot} from './state-dir.ts';

export interface PreviousOpenOptions {
  previous: string;
  currentLabel?: string;
  previousLabel?: string;
  currentAtlas?: string;
  previousAtlas?: string;
  clipMap: ReadonlyMap<string, string>;
  noClipMap?: boolean;
}

const previousStateDirectory = (state: string) => join(canonicalStatePath(state), 'previous-builds');
const sourceRecordPath = (container: string, identity: string) => join(container, identity + '.source.json');
const sourceRecordSchema = 'rig-review-previous-source/1';

/** Only a generated manifest in this invocation's private Review state can recover its original lookup root. */
export async function previousProducerRoot(input: string, state: string): Promise<string | undefined> {
  const path = await realpath(input);
  const generated = /^_*review-with-previous-([a-f0-9]{64})\.json$/.exec(basename(path));
  if (!generated) return undefined;
  const container = previousStateDirectory(state);
  const [identity, current] = relative(container, path).split(sep);
  if (!identity || identity !== generated[1] || current !== 'current') return undefined;
  const pair = join(container, identity), manifest = relative(pair, path);
  const record = sourceRecordPath(container, identity);
  await assertPrivate(container, true);
  await assertPrivate(pair, true);
  const value = await readPrivate(record) as Partial<{schema: string; manifest: string; manifestHash: string; originalRoot: string}> | null;
  if (value === null) return undefined; // Retained before original lookup roots were recorded.
  if (value.schema !== sourceRecordSchema || value.manifest !== manifest ||
      typeof value.originalRoot !== 'string' || !isAbsolute(value.originalRoot) ||
      canonicalStatePath(value.originalRoot) !== value.originalRoot ||
      (await hashReferenceFile(clonePath(pair, manifest))).sha256 !== value.manifestHash) {
    throw previousBuildFileError(manifest, 'retained manifest or producer origin does not match the state record');
  }
  return value.originalRoot;
}

function clonePath(root: string, path: string, directory = false) {
  try { return checkedPath(root,jobPath(path),directory); }
  catch { throw previousBuildFileError(path,'asset unavailable or outside the admitted root (symlinks refused)'); }
}

/** Keep producer-relative layout so the existing out/ and check/ discovery finds the same handoff. */
async function cloneInput(review: ReviewPackage, source: PreviousOpenSource) {
  const {root,buildRoot,handoff}=review;
  const base=handoff && handoff.root!==root ? handoff.root : buildRoot??root;
  const packagePath=relative(base,root);
  const files=new Map<string,string>();
  const add=(path:string,sha256:string)=>{
    if(files.has(path)&&files.get(path)!==sha256)throw previousBuildFileError(path,'conflicting asset hashes');
    clonePath(base,path);
    files.set(path,sha256);
  };
  for(const [path,sha256] of source.files)add(join(packagePath,path),sha256);
  for(const file of handoff?.record.files??[])add(relative(base,resolve(root,file.path)),file.sha256);
  if(buildRoot)for(const marker of BUILD_ROOT_FILES){
    const path=relative(base,join(buildRoot,marker));
    if(!files.has(path))add(path,(await hashReferenceFile(clonePath(base,path))).sha256);
  }
  const directories=new Set([packagePath]);
  for(const dir of [handoff?.parts,handoff?.rig,handoff?.full,handoff?.head])if(dir){
    const path=relative(base,dir);
    if(path)clonePath(base,path,true);
    directories.add(path);
  }
  return {base,packagePath,files,directories:[...directories].filter(Boolean).sort()};
}

async function cloneClosure(from: string, to: string, files: PreviousOpenSource['files']) {
  for (const path of files.keys()) {
    const source=clonePath(from,path);
    const target = join(to,path);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    await copyFile(source,target,constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
  }
}

function unusedName(name: string, paths: readonly string[]) {
  const occupied = new Set(paths.map(path=>path.split('/')[0]!.toLowerCase()));
  while (occupied.has(name.toLowerCase())) name='_'+name;
  return name;
}

function assertOutside(path: string, roots: readonly StateRoot[]) {
  const inside=stateDirInside(path,roots);
  if (inside) throw new Error(`OPEN_STATE_INSIDE_PACKAGE ${inside.kind}: pair state must be outside both input packages`);
}

export async function preparePreviousOpen(inputs: OpenInputs, pair: PreviousOpenOptions, state: string) {
  const [currentPath,previousPath]=await Promise.all([realpath(inputs.input),realpath(pair.previous)]);
  if (currentPath===previousPath) throw new Error(`OPEN_PREVIOUS_SAME_ROOT: ${currentPath}`);
  let currentSource!: PreviousOpenSource, previousSource!: PreviousOpenSource;
  const current=await loadReview(inputs.input,{handoff:handoffFlags(inputs),
    previousOpen:{side:'current',atlas:pair.currentAtlas,capture:source=>{currentSource=source;}}});
  const previous=await loadReview(pair.previous,{
    previousOpen:{side:'previous',atlas:pair.previousAtlas,capture:source=>{previousSource=source;}}});
  if (current.root===previous.root) throw new Error(`OPEN_PREVIOUS_SAME_ROOT: ${current.root}`);
  if (current.manifest.previousBuild) throw previousBuildFileError(current.manifestPath,'current package already declares previousBuild');

  const roots=[...stateRoots(current),...stateRoots(previous)];
  const stateDir=canonicalStatePath(state), container=previousStateDirectory(stateDir);
  for (const path of [stateDir,container,join(stateDir,inputs.direct?'open':'owner-workspace')]) assertOutside(path,roots);

  const currentClips=(current.feedbackCatalog.animations??[]).map(clip=>clip.name);
  const previousClips=new Set((previous.feedbackCatalog.animations??[]).map(clip=>clip.name));
  const mapping=new Map<string,string>();
  if (!pair.noClipMap) {
    for (const name of currentClips) if (previousClips.has(name)) mapping.set(name,name);
    for (const [name,clip] of pair.clipMap) mapping.set(name,clip);
  }
  const clipMap=Object.fromEntries([...mapping].sort(([left],[right])=>left<right?-1:left>right?1:0));
  const [currentClone,previousClone]=await Promise.all([cloneInput(current,currentSource),cloneInput(previous,previousSource)]);
  const occupied=[...currentClone.files.keys(),...currentClone.directories]
    .map(path=>relative(currentClone.packagePath||'.',path)).filter(path=>path&&!path.startsWith('../'));
  const previousDir=unusedName('__review_previous__',occupied);
  const prefix=({path,sha256}:{path:string;sha256:string})=>({path:join(previousDir,previousClone.packagePath,path),sha256});
  const playback=previousSource.playback;
  const declaration=parsePreviousBuild({schema:JOB_PREVIOUS_BUILD_SCHEMA,
    label:pair.previousLabel??basename(previous.root),currentLabel:pair.currentLabel??basename(current.root),
    model:prefix(playback.model),atlas:prefix(playback.atlas),pages:playback.pages.map(prefix),clipMap});
  const identity=jobHash(JSON.stringify(['rig-review-open-previous/1',current.root,previous.root,
    current.sourceHash,previous.sourceHash,currentSource.playback.atlas,declaration,
    ...[currentClone,previousClone].map(clone=>[clone.packagePath,[...clone.files].sort(),clone.directories]),
    current.handoff?.record,previous.handoff?.record]));
  const path=join(container,identity);
  assertOutside(path,roots);
  const manifestName=unusedName(`review-with-previous-${identity}.json`,occupied);
  const manifest=JSON.stringify({...currentSource.rawManifest,previousBuild:declaration});
  const manifestHash=jobHash(manifest);
  const currentRoot=join('current',currentClone.packagePath);
  const previousRoot=join(currentRoot,previousDir);
  const manifestPath=join(currentRoot,manifestName);
  const placements=[['current',currentClone],[previousRoot,previousClone]] as const;
  const retainedFiles=new Map(placements.flatMap(([prefix,clone])=>[...clone.files].map(([file,hash])=>[join(prefix,file),hash] as const)));
  retainedFiles.set(manifestPath,manifestHash);
  const retainedDirectories=placements.flatMap(([prefix,clone])=>[prefix,...clone.directories.map(dir=>join(prefix,dir))]);
  const openInputs=(directory:string):OpenInputs=>{
    const flags=Object.fromEntries(Object.entries(current.handoffInputs??{})
      .map(([flag,original])=>[flag,join(directory,'current',relative(currentClone.base,original))]));
    return {...inputs,...flags,input:join(directory,manifestPath)};
  };
  const validate=async(directory:string)=>{
    await assertPrivate(directory,true);
    assertRetainedSnapshotLayout(directory,retainedFiles.keys(),retainedDirectories,previousBuildFileError);
    for(const [file,hash] of retainedFiles){
      const actual=await hashReferenceFile(clonePath(directory,file)).catch(()=>null);
      if(actual?.sha256!==hash)throw previousBuildFileError(file,'retained asset unavailable or hash mismatch');
    }
    const open=openInputs(directory);
    const retained=await loadReview(open.input,{handoff:handoffFlags(open),originalProducerRoot:current.root});
    if(!isDeepStrictEqual(retained.handoff?.record,current.handoff?.record))
      throw previousBuildFileError(current.handoff?.record.config.path??manifestName,'producer handoff changed after relocation');
    assertRetainedSnapshotLayout(directory,retainedFiles.keys(),retainedDirectories,previousBuildFileError);
  };

  await mkdir(container,{recursive:true,mode:0o700});
  await assertPrivate(container,true);
  let alreadyPublished=true;
  try {await lstat(path);}
  catch (error) {
    if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
    alreadyPublished=false;
  }
  if (!alreadyPublished) await writePrivate(path,undefined,async temporary=>{
    for(const dir of retainedDirectories)await mkdir(join(temporary,dir),{recursive:true,mode:0o700});
    for(const [prefix,clone] of placements)await cloneClosure(clone.base,join(temporary,prefix),clone.files);
    await writeFile(join(temporary,manifestPath),manifest,{flag:'wx',mode:0o600});
    await validate(temporary);
  });
  await validate(path);
  const record=sourceRecordPath(container,identity);
  const source={schema:sourceRecordSchema,manifest:manifestPath,manifestHash,originalRoot:current.root};
  const existing=await readPrivate(record);
  if (existing===null) await writePrivate(record,source);
  else if (!isDeepStrictEqual(existing,source)) throw previousBuildFileError(manifestPath,'retained producer origin has changed');
  const unmapped=currentClips.filter(name=>!mapping.has(name)||!previousClips.has(mapping.get(name)!));
  return {inputs:openInputs(path),path,clipMap,unmapped};
}
