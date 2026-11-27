import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import { canonicalJson } from '../src/canonical-json.ts';
import { resolvedCropPath, storePngCrop } from '../src/comment-crops.ts';
import { frontRoute } from '../src/front.ts';
import { parseCommentOnlyAct } from '../src/job-api.ts';
import { LOCAL_COMMENTS_ROUTE, LOCAL_COMMENTS_SCHEMA, readPackageComments, readPartsComments, savePartsComments } from '../src/local-comments.ts';
import { loadReview } from '../src/manifest.ts';
import { partsIssueComments } from '../src/parts-comment.ts';
import { preparePartsComment } from '../src/parts-comment-crops.ts';
import { loadPartsView, saveVerdict, verdictSource } from '../src/parts-view.ts';
import { createReviewRequestContext } from '../src/server.ts';
import { freshSession, sessionFile, type Feedback } from '../src/session.ts';
import { feedbackContextComments } from '../src/stage-comment.ts';
import { candidate, commentFixture } from './helpers/parts-comments-package.ts';
import { useTemporaryReviewState } from './helpers/temporary-review-state.ts';

useTemporaryReviewState();
const state = () => process.env.RIG_REVIEW_STATE_DIR!;
const origin = 'http://127.0.0.1:4321', capability = 'local-comments-test';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const submission = <Value>(sourceHash: string, value: Value) => ({sendId: randomUUID(), sourceHash, value});
const binding = (sourceHash: string, ...texts: string[]) => submission(sourceHash, {comments: texts.map(text => ({text}))});
async function runCli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:state()}});
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return {stdout, stderr, exit};
}
async function cli(...args: string[]) {
  const {stdout, stderr, exit} = await runCli(...args);
  expect({exit, stderr}).toEqual({exit:0, stderr:''});
  return stdout;
}

async function packageFixture(id = 'local-pkg') {
  const dir = join(state(), id), path = join(dir, 'review.json');
  await mkdir(dir);
  const manifest = {schema:'rig-review/1', id, title:id, revision:'one', model:'skeleton.model.json'};
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(dir,manifest.model), JSON.stringify({spec:'rigc-compiled/3',pages:[],bones:[],slots:[],animations:[]}));
  return {path, manifest, pkg:await loadReview(path)};
}

async function packageServer(pkg: Awaited<ReturnType<typeof loadReview>>) {
  const context = await createReviewRequestContext(pkg,{bundle:new Blob(),capability,stateDir:state(),viewOnly:true});
  const post = (body: unknown, headers: Record<string,string> = {}) => context.handle(new Request(origin+LOCAL_COMMENTS_ROUTE,{
    method:'POST', body:JSON.stringify(body), headers:{origin,'content-type':'application/json','x-review-capability':capability,...headers},
  }),4321,{} as never);
  return {context, post};
}

test('package sends use the bounded capability-gated route and preserve earlier keys and saved status in CLI exports', async () => {
  const {pkg, manifest, path} = await packageFixture();
  const {context, post} = await packageServer(pkg);
  const request = binding(pkg.sourceHash,'Equal text in one send','Equal text in one send');
  try {
    expect(frontRoute('single','POST',LOCAL_COMMENTS_ROUTE)?.limit).toBe(1024*1024);
    expect(frontRoute('single','GET',LOCAL_COMMENTS_ROUTE)).toBeNull();
    expect(frontRoute('compare','POST',LOCAL_COMMENTS_ROUTE)).toBeNull();
    expect((await post(request,{origin:'http://127.0.0.1:4322'}))?.status).toBe(403);
    expect((await post(request,{'x-review-capability':'another'}))?.status).toBe(403);
    expect((await post(request,{'content-type':'text/plain'}))?.status).toBe(400);
    expect(await (await post(binding(pkg.sourceHash,'a'.repeat(1024*1024))))?.json()).toEqual({error:'LOCAL_COMMENTS_BODY_LIMIT'});
    expect((await post(binding('0'.repeat(64),'Stale')))?.status).toBe(409);
    expect(await (await post({...request,by:'Browser override'}))?.json()).toEqual({error:'JOB_ACT_INVALID'});
    expect(await (await post({...request,sendId:'invalid'}))?.json()).toEqual({error:'JOB_ACT_INVALID'});
    expect(await (await post(binding(pkg.sourceHash)))?.json()).toEqual({error:'JOB_ACT_INVALID'});
    const sent = await post(request);
    expect(sent?.status).toBe(200);
    const receipt = await sent!.json() as {sendId:string;at:string};
    expect(Object.keys(receipt).sort()).toEqual(['at','sendId']);
    expect(receipt.sendId).toBe(request.sendId);
    const file = sessionFile(pkg,state()).replace(/\.json$/,'.comments.json');
    const firstBytes = await readFile(file,'utf8'), raw = JSON.parse(firstBytes), initialFile = await stat(file);
    expect(raw).toEqual({schema:LOCAL_COMMENTS_SCHEMA,sends:[{...receipt,
      source:{kind:'package',id:manifest.id,revision:manifest.revision,sourceHash:pkg.sourceHash,reviewedSource:pkg.reviewedSource},
      value:request.value}]});
    expect(() => parseCommentOnlyAct(raw)).toThrow('JOB_ACT_INVALID');
    const exactRetry = await post(request);
    expect(exactRetry?.status).toBe(200);
    expect(await exactRetry!.json()).toEqual(receipt);
    for (const changed of [{...request,value:{comments:[{text:'Changed text'}]}},{...request,sourceHash:'0'.repeat(64)}]) {
      const conflict = await post(changed);
      expect(conflict?.status).toBe(409);
      expect(await conflict!.json()).toEqual({error:'JOB_IDEMPOTENCY_CONFLICT'});
    }
    const afterReplay = await stat(file);
    expect([afterReplay.ino,afterReplay.mtimeMs]).toEqual([initialFile.ino,initialFile.mtimeMs]);
    expect(await readFile(file,'utf8')).toBe(firstBytes);
    const second = await post(submission(pkg.sourceHash,request.value));
    expect(second?.status).toBe(200);
    const secondReceipt = await second!.json() as {sendId:string;at:string};
    expect(secondReceipt.sendId).not.toBe(receipt.sendId);
    const twoSends = await readFile(file,'utf8');
    expect(JSON.parse(twoSends).sends[1]).toEqual({...raw.sends[0],...secondReceipt});
    expect((await context.handle(new Request(origin+LOCAL_COMMENTS_ROUTE),4321,{} as never))?.status).toBe(404);
    await writeFile(path,JSON.stringify({...manifest,revision:'two'}));
    expect(await (await post(request))?.json()).toEqual(receipt);
    expect((await post(binding(pkg.sourceHash,'Package changed')))?.status).toBe(409);
    const next = await loadReview(path), nextServer = await packageServer(next);
    try {
      const conflict = await nextServer.post({...request,sourceHash:next.sourceHash});
      expect(conflict?.status).toBe(409);
      expect(await conflict!.json()).toEqual({error:'JOB_IDEMPOTENCY_CONFLICT'});
      expect((await nextServer.post(binding(next.sourceHash,'New revision')))?.status).toBe(200);
      await writeFile(sessionFile(next,state()),JSON.stringify({...freshSession(next),status:'approved',updatedAt:'2020-01-01T00:00:00.000Z'}));
      const legacy = await readFile(sessionFile(next,state()));
      const exported = JSON.parse(await cli('feedback',path,'--format','json'));
      expect(exported.status).toBe('approved');
      expect(exported.localComments.sends).toHaveLength(3);
      expect(exported.localComments.sends[0]).toEqual({...raw.sends[0],earlierSource:true});
      expect(exported.localComments.sends[1]).toEqual({...raw.sends[0],...secondReceipt,earlierSource:true});
      expect(exported.localComments.sends[2].earlierSource).toBeUndefined();
      expect(exported.localComments.path).toBe(sessionFile(next,state()).replace(/\.json$/,'.comments.json'));
      expect(exported.localComments.earlierPaths).toEqual([file]);
      const issue = await cli('feedback',path,'--format','issue');
      expect(issue).toContain('Recorded status: approved');
      expect(issue).toContain('"earlierSource": true');
      expect(await readFile(sessionFile(next,state()))).toEqual(legacy);
      expect(await readFile(file,'utf8')).toBe(twoSends);
    } finally {nextServer.context.stop();}
  } finally {context.stop();}
});

function packagePin(pkg: Awaited<ReturnType<typeof loadReview>>) {
  const image = PNG.sync.write(new PNG({width:1,height:1})), imageHash = sha(image);
  const camera = {space:'world',center:{x:0,y:0},zoom:1,viewport:{width:100,height:100},visible:{x:-50,y:-50,width:100,height:100}};
  const modelHash = pkg.reviewedSource.rig!.sha256;
  const pin = {schema:'rig-review-comment/1',mode:'setup',viewport:'rig',frame:{index:0,basis:'producer'},time:0,animation:null,
    sourceHash:pkg.sourceHash,modelHash,referenceHash:null,referenceId:null,camera,slots:[],
    screen:{x:50,y:50,width:0,height:0},world:{x:0,y:0,width:0,height:0},
    crop:{path:`comment-crops/${imageHash}.png`,sha256:imageHash,png:'data:image/png;base64,'+image.toString('base64'),width:1,height:1},
    bookmark:{schema:'rig-review-inspection/1',binding:{mode:'single',sourceHash:pkg.sourceHash,rigs:[modelHash]},time:0,animation:null,
      theme:'dark',layers:{images:true,meshes:false,bones:false},view:{schema:'rig-review-view/1',cameras:{rig:camera,a:null,b:null,reference:null}},
      selection:{inspector:'rig'}}};
  const row: Feedback = {id:'pinned',target:{kind:'rig',name:pkg.manifest.id},frameStart:0,frameEnd:0,category:'defect',summary:'A pinpoint',
    context:{animation:null,time:0,frame:0,comment:pin}};
  return {row, pin, modelHash};
}

test('valid package pins use the existing wire mapper and preserve PNG evidence; model and crop tampering decline', async () => {
  const {pkg} = await packageFixture(), {context, post} = await packageServer(pkg);
  const {row, pin, modelHash} = packagePin(pkg);
  const from = (feedback: Feedback) => submission(pkg.sourceHash,{comments:feedbackContextComments([feedback])});
  try {
    for (const change of [{modelHash:'0'.repeat(64)},{crop:{...pin.crop,png:'data:image/png;base64,AAAA'}}]) {
      const altered = {...row,context:{animation:null,time:0,frame:0,comment:{...pin,...change}}};
      expect((await post(from(altered)))!.status).toBeGreaterThanOrEqual(400);
    }
    const pinned = from(row), sent = await post(pinned);
    expect(sent?.status).toBe(200);
    expect(await (await post(pinned))?.json()).toEqual(await sent!.json());
    expect((await readPackageComments(pkg,state()))?.sends[0]?.value.comments).toEqual(pinned.value.comments);
    expect(await (await post(from({...row,summary:'Edited'})))?.json()).toMatchObject({error:expect.stringContaining('COMMENT_SUBMITTED')});
    expect(await (await post(from(row)))?.json()).toEqual({error:'COMMENT_SUBMITTED'});
    const edit = {skin:'default',slot:'mesh',attachment:'mesh',basis:'setup',
      source:{hash:'a'.repeat(64),frame:{width:100,height:100}},bust:{apex_r:[16,20],apex_l:[56,20],alpha:0.22}};
    const carrier = {kind:'chest-landmarks',file:pkg.reviewedSource.rig,chestLandmarks:[{edit,sha256:sha(canonicalJson(edit))}]};
    const value = {comments:[],carriers:[carrier]};
    expect(await (await post(submission(pkg.sourceHash,{...value,carriers:[]})))?.json()).toEqual({error:'JOB_ACT_INVALID'});
    expect(await (await post(submission(pkg.sourceHash,{...value,carriers:[{...carrier,file:{path:'other.json',sha256:modelHash}}]})))?.json())
      .toEqual({error:'JOB_ACT_INVALID'});
    const carrierOnly = submission(pkg.sourceHash,value), carrierReceipt = await post(carrierOnly);
    expect(carrierReceipt?.status).toBe(200);
    expect(await (await post(carrierOnly))?.json()).toEqual(await carrierReceipt!.json());
    expect((await readPackageComments(pkg,state()))?.sends).toHaveLength(2);
  } finally {context.stop();}
});

test('correction CLI keeps legacy bytes and projects sent pins only against their verified source', async () => {
  const {pkg, manifest, path} = await packageFixture(), {context, post} = await packageServer(pkg);
  const {row, pin} = packagePin(pkg);
  const sent = {...row, summary:'Keep this edge.  \r\nCompare the seam.  ', context:{
    animation:null, time:0, frame:0, comment:pin,
    correction:{path:'described',selector:{kind:'rig',stage:'rig-review',version:1}},
  }};
  const old = {...sent,id:'legacy-pin'}, oldFile = sessionFile(pkg,state());
  const localFile = oldFile.replace(/\.json$/,'.comments.json');
  const correction = (id: string, format: 'json' | 'issue') => ['feedback',path,'--correction',id,'--format',format];
  try {
    const response = await post(submission(pkg.sourceHash,{comments:feedbackContextComments([sent])}));
    expect(response?.status).toBe(200);
    const localBytes = await readFile(localFile,'utf8');
    expect(await cli(...correction(sent.id,'json'))).toBe(localBytes);
    const oldBytes = JSON.stringify({...freshSession(pkg),feedback:[old,row]},null,4)+'\n';
    await writeFile(oldFile,oldBytes);
    expect(await cli(...correction(old.id,'json'))).toBe(oldBytes);
    expect(await cli(...correction(sent.id,'json'))).toBe(localBytes);
    const legacyIssue = await cli(...correction(old.id,'issue'));
    const sentIssue = await cli(...correction(sent.id,'issue'));
    expect(sentIssue).toBe(legacyIssue.replace('"itemId": "legacy-pin"', '"itemId": "pinned"'));
    const handoff = JSON.parse(sentIssue.split('\n').slice(5,-2).join('\n'));
    expect(handoff).toMatchObject({itemId:sent.id,verbatim:sent.summary,selectorArgs:['--version','1'],
      source:{id:pkg.manifest.id,revision:pkg.manifest.revision,sourceHash:pkg.sourceHash,reviewedSource:pkg.reviewedSource},
      target:sent.target,context:{comment:pin,interval:{frameStart:0,frameEnd:0,inclusive:true}}});
    const unknown = await runCli(...correction('unknown','issue'));
    expect(unknown).toEqual({exit:1,stdout:'',stderr:'CORRECTION_ITEM_INVALID: expected a valid saved correction\n'});
    expect(await readFile(oldFile,'utf8')).toBe(oldBytes);
    expect(await readFile(localFile,'utf8')).toBe(localBytes);

    await writeFile(path,JSON.stringify({...manifest,revision:'two'}));
    const stale = await runCli(...correction(sent.id,'json'));
    expect(stale).toEqual({exit:1,stdout:'',stderr:'CORRECTION_SOURCE_STALE: saved session differs from verified source\n'});

    await writeFile(path,JSON.stringify(manifest));
    const tampered = JSON.parse(localBytes);
    tampered.sends[0].value.comments[0].anchor.context.comment.crop.png = 'data:image/png;base64,AAAA';
    await writeFile(localFile,JSON.stringify(tampered));
    const invalid = await runCli(...correction(sent.id,'issue'));
    expect(invalid).toEqual({exit:1,stdout:'',stderr:'LOCAL_COMMENTS_FILE_INVALID\n'});
  } finally {context.stop();}
});

test('parts writes serialize, preserve native bytes and old source rows, and leave malformed files untouched', async () => {
  const root = join(state(),'parts-src'), verdict = join(state(),'designated','saved-verdict.json');
  const original = await commentFixture(root), pkg = await loadPartsView(root,{verdict});
  expect(pkg.imagePaths).toEqual(original.imagePaths);
  const issue = await preparePartsComment(pkg,candidate(pkg));
  const sourceHash = verdictSource(pkg).sha256;
  const pinned = submission(sourceHash,{comments:partsIssueComments([issue])});
  const [receipt,retry] = await Promise.all([
    savePartsComments(pkg,pinned,'Owner'),
    savePartsComments(pkg,pinned,'Owner'),
    savePartsComments(pkg,binding(sourceHash,'One concurrent send')),
    savePartsComments(pkg,binding(sourceHash,'Another concurrent send')),
  ]);
  expect(receipt).toEqual(retry);
  const file = join(dirname(pkg.verdictPath),'review-comments.json'), saved = (await readPartsComments(pkg))!;
  expect(saved.path).toBe(file);
  expect(saved.sends).toHaveLength(3);
  expect(saved.sends.find(row => row.by)?.by).toBe('Owner');
  expect(new Set(saved.sends.map(row => row.sendId)).size).toBe(3);
  const crop = await readFile(resolvedCropPath(issue.nativeCrop!.path));
  expect(sha(crop)).toBe(issue.nativeCrop!.sha256);
  const native = PNG.sync.read(crop), originalPng = PNG.sync.read(await readFile(pkg.imagePaths[0]!));
  expect(native.data.subarray(0,32)).toEqual(originalPng.data.subarray((3*30+2)*4,(3*30+10)*4));
  const json = JSON.parse(await cli('parts',root,'--verdict',verdict,'--format','json'));
  expect(json.localComments).toEqual(saved);
  expect(await cli('parts',root,'--verdict',verdict,'--format','issue')).toContain(issue.nativeCrop!.sha256);
  await expect(savePartsComments(pkg,{...pinned,value:{comments:partsIssueComments([{...issue,summary:'Replacement'}])}},'Owner'))
    .rejects.toThrow('JOB_IDEMPOTENCY_CONFLICT');
  await expect(savePartsComments(pkg,submission(sourceHash,pinned.value),'Owner')).rejects.toThrow('COMMENT_SUBMITTED');
  const forged = PNG.sync.write(new PNG({width:native.width,height:native.height})), forgedHash = sha(forged);
  const nativeCrop = {...issue.nativeCrop!,path:`comment-crops/${forgedHash}.png`,sha256:forgedHash};
  await storePngCrop({...nativeCrop,png:'data:image/png;base64,'+forged.toString('base64')});
  await expect(savePartsComments(pkg,submission(sourceHash,{comments:partsIssueComments([{...issue,id:'forged',nativeCrop}])})))
    .rejects.toThrow('PARTS_COMMENT_NATIVE_CROP_TAMPERED');
  const sourceFile = join(root,'rig','parts.json');
  await writeFile(sourceFile,(await readFile(sourceFile,'utf8'))+'\n');
  await expect(savePartsComments(pkg,binding(sourceHash,'Stale old server'))).rejects.toThrow('PARTS_VIEW_SOURCE_CHANGED');
  const newer = await loadPartsView(root,{verdict});
  await expect(savePartsComments(newer,{...pinned,sourceHash:verdictSource(newer).sha256},'Owner')).rejects.toThrow('JOB_IDEMPOTENCY_CONFLICT');
  await savePartsComments(newer,binding(verdictSource(newer).sha256,'New source'));
  expect((await readPartsComments(newer))!.sends.map(row=>row.earlierSource)).toEqual([true,true,true,undefined]);
  await writeFile(file,'malformed');
  await expect(savePartsComments(newer,binding(verdictSource(newer).sha256,'Refused'))).rejects.toThrow('LOCAL_COMMENTS_FILE_INVALID');
  await expect(readPartsComments(newer)).rejects.toThrow('LOCAL_COMMENTS_FILE_INVALID');
  expect(await readFile(file,'utf8')).toBe('malformed');
});

test('parts CLI retains verdict /1–/5 and original file identity alongside local sends', async () => {
  const root = join(state(),'legacy-src'), pkg = await commentFixture(root);
  const current = await saveVerdict(pkg,{status:'approved',issues:[]});
  await savePartsComments(pkg,binding(verdictSource(pkg).sha256,'Independent local comment'));
  const {schema:_schema,issues:_issues,...common} = current;
  const legacy = Object.fromEntries(pkg.items.map(item=>[item.name,{outcome:'pending',note:''}]));
  const versions = [
    {...common,schema:'rig-review-parts-verdict/1',status:'pending',parts:legacy},
    {...common,schema:'rig-review-parts-verdict/2',status:'pending',parts:legacy,comments:[]},
    {...common,schema:'rig-review-parts-verdict/3',status:'pending',parts:legacy,comments:[],by:'Earlier reviewer'},
    current,
    {...common,schema:'rig-review-parts-verdict/5',comments:[{text:'Legacy general'}]},
  ];
  for (const row of versions) {
    const bytes = JSON.stringify(row);
    await writeFile(pkg.verdictPath,bytes);
    const json = JSON.parse(await cli('parts',root,'--format','json'));
    expect(json).toMatchObject({schema:row.schema,status:row.status,savedFileSha256:sha(bytes),localComments:{schema:LOCAL_COMMENTS_SCHEMA}});
    expect(await readFile(pkg.verdictPath,'utf8')).toBe(bytes);
  }
});
