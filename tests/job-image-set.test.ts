import {afterEach, expect, test} from 'bun:test';
import {readFile, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {assertJobImageSetCapability, type JobImageSetInput, type JobImageReviewValue} from '../src/job-host.ts';
import {jobHash} from '../src/job-api.ts';
import {prepareJobImageSet, parseJobImageSetBinding} from '../src/job-image-set.ts';
import {parseCommentsAct} from '../src/job-host.ts';
import commentsLegacy from './fixtures/comments-contract-legacy.json';
import {jobFixture} from './helpers/job-api-fixture.ts';
import {imageReviewValue,projectComments} from '../src/stage-comment.ts';
import {imageCommentCodec,type ImageCommentPose} from '../web/stage-comments.ts';
import {rigStillCapture} from './helpers/job-rig-still.ts';
import {parseJobSubject as oldParseJobSubject} from './fixtures/job-image-set/old-subject-parser.ts';

const fixtures: Awaited<ReturnType<typeof jobFixture>>[] = [];
afterEach(async () => {for (const fixture of fixtures.splice(0)) await fixture.close();});
async function fixture(imageCount = 2) {
  const f = await jobFixture(); fixtures.push(f);
  const bytes = await readFile(join(f.root, 'out/rigid.png'));
  const images: JobImageSetInput['images'][number][] = [];
  for (let index = 0; index < imageCount; index++) {
    const path = `image-${index}.png`;
    await writeFile(join(f.root, path), bytes);
    images.push({role: index ? 'candidate' : 'source', name: `Image ${index}`, path, sha256: jobHash(bytes)});
  }
  await writeFile(join(f.root, 'out/review.json'), JSON.stringify({schema: 'rig-review/1',
    id: 'image-set-fixture', title: 'Synthetic image set', revision: 'one', references: []}));
  f.setContext({selector: null, plan: null, parts: null, subjects: [], partIds: [], files: [],
    imageSet: {purpose: 'plate-adoption', images}});
  return f;
}
async function submission(f: Awaited<ReturnType<typeof fixture>>) {
  const discovery = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  assertJobImageSetCapability(discovery.value.capabilities);
  const publication = await f.publish();
  const ask = await f.ask(publication, {kind: 'review-verdict', stage: 'image-review'});
  const page = await f.display(publication);
  const value: JobImageReviewValue = {stage: 'image-review', verdict: 'approved', words: '  exact human words  '};
  return {publication, ask, input: {...page, askId: ask.askId, expectedGeneration: f.session.status().generation,
    submissionId: 'image-verdict', kind: 'review-verdict', value}};
}

test('#646 shared image codec: pure sealed decoding matches actual bytes, Unicode/order and duplicate groups', async () => {
  const f = await fixture(3), original = f.getContext().imageSet!;
  const input = {...original, images: original.images.map((image, i) => ({...image, name: i === 0 ? 'e\u0301' : i === 1 ? 'é' : image.name}))};
  const actualBytes = new Map(await Promise.all(input.images.map(async image => [image.path, await readFile(join(f.root, image.path))] as const)));
  const reads: string[] = [];
  const prepared = prepareJobImageSet(input, path => {reads.push(path); return actualBytes.get(path)!;});
  const literal = JSON.stringify(prepared), decoded = parseJobImageSetBinding(JSON.parse(literal));
  expect(decoded).toEqual(prepared);
  expect(reads).toEqual(input.images.map(image => image.path));
  expect(JSON.stringify(prepared)).toBe(literal);
  expect(decoded.duplicateHashes).toEqual([{names: ['e\u0301', 'é', 'Image 2'], sha256: input.images[0]!.sha256!}]);
  const relocated = {...input, images: input.images.map((image, i) => ({...image, path: `moved-${i}.png`}))};
  const relocatedBytes = new Map(relocated.images.map((image, i) => [image.path, actualBytes.get(input.images[i]!.path)!]));
  const moved = prepareJobImageSet(relocated, path => relocatedBytes.get(path)!);
  expect(parseJobImageSetBinding(moved).imageSetDigest).toBe(decoded.imageSetDigest);
  const reversed = prepareJobImageSet({...input, images: [...input.images].reverse()}, path => actualBytes.get(path)!);
  expect(parseJobImageSetBinding(reversed).imageSetDigest).not.toBe(decoded.imageSetDigest);
  const old = JSON.parse(commentsLegacy.records['@2'].raw), {model: _model, selector: _selector, ...common} = old.source;
  const source = {...common, subject: 'image-set', ...decoded};
  const act = {...old, schema: 'rig-review/act@6', kind: 'review-verdict', source,
    value: {stage: 'image-review', verdict: 'approved', comments: [{text: 'Inspect this', anchor: {name: 'é'}}]}};
  expect(parseCommentsAct(act).source).toEqual(source);
  for (const change of [
    {imageSetDigest: '0'.repeat(64)}, {duplicateHashes: []},
    {imageSet: {...decoded.imageSet, images: [...decoded.imageSet.images].reverse()}},
    {imageSet: {...decoded.imageSet, images: decoded.imageSet.images.map(({sha256: _sha, ...row}) => row)}},
    {imageSet: {...decoded.imageSet, images: decoded.imageSet.images.map(row => ({...row, extra: true}))}},
  ]) expect(() => parseCommentsAct({...act, source: {...source, ...change}})).toThrow('JOB_ACT_INVALID');
});

test('#646 shared image codec preserves existing preparation refusal codes and read order', async () => {
  const f = await fixture(), input = f.getContext().imageSet!, images = input.images;
  const bytes = new Map(await Promise.all(images.map(async image => [image.path, await readFile(join(f.root, image.path))] as const)));
  const cases: [JobImageSetInput, string, number][] = [
    [{...input, images: [images[0]!, {...images[1]!, name: images[0]!.name}]}, 'JOB_IMAGE_SET_DUPLICATE_NAME', 1],
    [{...input, images: [images[0]!, {...images[1]!, path: images[0]!.path}]}, 'JOB_IMAGE_SET_DUPLICATE_PATH', 1],
    [{...input, images: images.map(row => ({...row, role: 'candidate' as const}))}, 'JOB_IMAGE_SET_ROLE_INVALID', 2],
    [{...input, images: [images[0]!, {...images[1]!, sha256: '0'.repeat(64)}]}, 'JOB_SOURCE_MISMATCH', 2],
  ];
  for (const [value, code, count] of cases) {
    const reads: string[] = [];
    expect(() => prepareJobImageSet(value, path => {reads.push(path); return bytes.get(path)!;})).toThrow(code);
    expect(reads).toEqual(images.slice(0, count).map(row => row.path));
  }
});

test('522 two-image model-free ask and human verdict roundtrip preserve source, digest, duplicates and optional notes', async () => {
  const f = await fixture(), {publication, ask, input} = await submission(f);
  const source = publication.source;
  expect(source.subject).toBe('image-set');
  expect(Object.hasOwn(source, 'model')).toBe(false);
  expect(Object.hasOwn(source, 'selector')).toBe(false);
  if (source.subject !== 'image-set') throw new Error('Expected image source');
  expect(ask.source).toEqual(source);
  const rows = source.imageSet.images.map(({role, name, sha256}) => ({role, name, sha256}));
  expect(source.imageSetDigest).toBe(jobHash(Buffer.from(JSON.stringify(rows), 'utf8')));
  expect(source.duplicateHashes).toEqual([{names: ['Image 0', 'Image 1'], sha256: rows[0].sha256}]);
  const payload = {...input, value: {...input.value, imageNotes: [{name: 'Image 1', words: '  image note  '}]}};
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.source).toEqual(source);
  expect(saved.value.value).toEqual(payload.value);
  expect(saved.value.authority).toEqual({actor: 'human', channel: 'review-ui', reviewer: {id: 'declared-owner', role: 'owner'}});
  expect(await f.ports.commitUIAct(f.session.jobId, f.uiRequest(payload))).toEqual(saved);
  const fetched = await (await f.call({...f.base(), verb: 'fetch-act', actId: saved.value.actId},
    f.session.writerGrant().fetchCapability)).json();
  expect(fetched.value).toEqual(saved.value);
  const next = await (await f.call({...f.base(), verb: 'next', after: null, waitMs: 0})).json();
  expect(next.value.events.find((event: {type: string}) => event.type === 'act').act).toEqual(saved.value);
});

test('522 eight images are accepted in producer order, absent notes stay absent', async () => {
  const f = await fixture(8), {publication, input} = await submission(f);
  expect(publication.source.imageSet?.images.map(image => image.name)).toEqual(Array.from({length: 8}, (_, i) => `Image ${i}`));
  const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
  expect(result.ok).toBe(true);
  if (result.ok) expect(Object.hasOwn(result.value.value, 'imageNotes')).toBe(false);
});

test('522 absent capability refuses locally and the frozen old parser refuses the image stage by name', () => {
  for (const capabilities of [undefined, null, {}, {imageSetVerdict: false}]) {
    expect(() => assertJobImageSetCapability(capabilities)).toThrow('JOB_IMAGE_SET_UNSUPPORTED');
  }
  expect(() => assertJobImageSetCapability({imageSetVerdict: true})).not.toThrow();
  expect(() => oldParseJobSubject({kind: 'review-verdict', stage: 'image-review'})).toThrow('JOB_ASK_INVALID');
  expect(oldParseJobSubject({kind: 'review-verdict', stage: 'rig-review'})).toEqual({kind: 'review-verdict', stage: 'rig-review'});
});

test('522 neither model nor images refuses ask without changing generation', async () => {
  const f = await fixture(), context = {...f.getContext()};
  delete context.imageSet; f.setContext(context);
  const publication = await f.publish(), before = f.session.status();
  for (const stage of ['image-review', 'rig-review']) {
    const result = await (await f.call({...f.base(), verb: 'ask', expectedGeneration: before.generation,
      idempotencyKey: stage, publicationId: publication.publicationId, subject: {kind: 'review-verdict', stage}})).json();
    expect(result.error.code).toBe('JOB_ASK_INVALID');
    expect(f.session.status()).toEqual(before);
  }
});

test('522 shape, purpose, counts, duplicate names/paths and closed role rules refuse publication atomically', async () => {
  const f = await fixture(), original = f.getContext(), imageSet = original.imageSet!;
  const images = imageSet.images;
  const cases: [unknown, string][] = [
    [{...imageSet, images: images.slice(0, 1)}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, images: Array(9).fill(images[0])}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, purpose: 'unknown'}, 'JOB_IMAGE_SET_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], name: images[0].name}]}, 'JOB_IMAGE_SET_DUPLICATE_NAME'],
    [{...imageSet, images: [images[0], {...images[1], path: images[0].path}]}, 'JOB_IMAGE_SET_DUPLICATE_PATH'],
    [{...imageSet, images: images.map(image => ({...image, role: 'candidate'}))}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: images.map(image => ({...image, role: 'source'}))}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], role: 'unknown'}]}, 'JOB_IMAGE_SET_ROLE_INVALID'],
    [{...imageSet, images: [images[0], {...images[1], sha256: '0'.repeat(64)}]}, 'JOB_SOURCE_MISMATCH'],
  ];
  for (const [claim, code] of cases) {
    f.setContext({...original, imageSet: claim as JobImageSetInput});
    const before = f.session.status();
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe(code);
    expect(f.session.status()).toEqual(before);
  }
});

test('522 literal containment rejects traversal, absolute and symlink leaf/parent paths', async () => {
  const f = await fixture(), original = f.getContext();
  await symlink(join(f.root, 'image-1.png'), join(f.root, 'leaf.png'));
  await symlink(f.root, join(f.root, 'parent'));
  for (const path of ['../image-1.png', '/tmp/image.png', 'parent/image-1.png', 'leaf.png', 'a%2fb.png']) {
    f.setContext({...original, imageSet: {...original.imageSet!, images: [original.imageSet!.images[0],
      {...original.imageSet!.images[1], path}]}});
    const result = await (await f.call(await f.publishRequest())).json();
    expect(result.error.code).toBe('JOB_IMAGE_SET_PATH_REFUSED');
  }
});

for (const phase of ['ask', 'finalize']) {
  test(`522 changed disk bytes refuse at ${phase}`, async () => {
    const f = await fixture(), {publication, input} = await submission(f);
    await writeFile(join(f.root, 'image-1.png'), 'changed bytes');
    const before = f.session.status();
    const result = phase === 'ask'
      ? await (await f.call({...f.base(), verb: 'ask', expectedGeneration: before.generation, idempotencyKey: 'changed',
          publicationId: publication.publicationId, subject: {kind: 'review-verdict', stage: 'image-review'}})).json()
      : await f.ports.commitUIAct(f.session.jobId, f.uiRequest(input));
    expect(result.error.code).toBe('JOB_SOURCE_MISMATCH');
    expect(f.session.status()).toEqual(before);
  });
}

test('522 notes reject extra fields, duplicate/nonmember names and browser-supplied digest', async () => {
  const f = await fixture(), {input} = await submission(f);
  for (const value of [
    {...input.value, imageNotes: [{name: 'unknown', words: ''}]},
    {...input.value, imageNotes: [{name: 'Image 0', words: ''}, {name: 'Image 0', words: ''}]},
    {...input.value, imageNotes: [{name: 'Image 0', words: '', unknown: true}]},
    {...input.value, comments: [{text:'extra field is forbidden under @2'}]},
    {...input.value, imageSetDigest: '0'.repeat(64)},
  ]) {
    const before = f.session.status();
    const result = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...input, value}));
    expect(result.ok).toBe(false); expect(f.session.status()).toEqual(before);
  }
});

test('522 canonical JSON keeps Unicode exact, excludes paths and preserves row order', () => {
  const input: JobImageSetInput = {purpose: 'plate-adoption', images: [
    {role: 'source', name: 'e\u0301', path: 'a.png'}, {role: 'candidate', name: 'é', path: 'b.png'}]};
  const bound = prepareJobImageSet(input, () => Buffer.from('same'));
  const sha256 = jobHash('same');
  expect(bound.imageSetDigest).toBe(jobHash(JSON.stringify([
    {role: 'source', name: 'e\u0301', sha256}, {role: 'candidate', name: 'é', sha256}])));
  expect(prepareJobImageSet({...input, images: input.images.map((image, i) => ({...image, path: `${i}.png`}))},
    () => Buffer.from('same')).imageSetDigest).toBe(bound.imageSetDigest);
  expect(prepareJobImageSet({...input, images: [...input.images].reverse()}, () => Buffer.from('same')).imageSetDigest)
    .not.toBe(bound.imageSetDigest);
});

test('522 original model publication, ask, act source and value serialize byte-identically to pre-edit output', async () => {
  const f = await jobFixture(); fixtures.push(f);
  const publication = await f.publish(), ask = await f.ask(publication, {kind: 'review-verdict', stage: 'rig-review'});
  const page = await f.display(publication);
  const saved = await f.ports.commitUIAct(f.session.jobId, f.uiRequest({...page, askId: ask.askId,
    expectedGeneration: f.session.status().generation, submissionId: 'model-byte-control', kind: 'review-verdict',
    value: {stage: 'rig-review', verdict: 'approved', words: 'exact verdict'},
    capture: rigStillCapture(publication, ask, page).capture}));
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error.code);
  const actual = JSON.stringify({publicationSource: publication.source, askSource: ask.source,
    source: saved.value.source, value: saved.value.value});
  const before = await readFile(new URL('./fixtures/job-image-set/model-branch.json', import.meta.url), 'utf8');
  expect(actual).toBe(before);
});


test('#772 signed image projection preserves global and member order, refusing unknown names',async()=>{
 const f=await fixture(),{publication,input}=await submission(f),source=publication.source;
 if(source.subject!=='image-set')throw new Error('Expected image source');
 const comments=[{text:'  first candidate\n',anchor:{name:'Image 1'}},{text:'General'},
  {text:'source',anchor:{name:'Image 0'}},{text:'second candidate',anchor:{name:'Image 1'}}];
 const value=imageReviewValue(source,'approved',comments);
 expect(value.words).toBe(projectComments(comments));
 expect(value.imageNotes).toEqual([{name:'Image 0',words:projectComments([comments[2]!])},
  {name:'Image 1',words:projectComments([comments[0]!,comments[3]!])}]);
 expect(imageReviewValue(source,'approved',[])).toEqual({stage:'image-review',verdict:'approved',words:''});
 expect(()=>imageReviewValue(source,'approved',[{text:'bad',anchor:{name:'missing'}}])).toThrow('JOB_ACT_INVALID');
 const result=await f.ports.commitUIAct(f.session.jobId,f.uiRequest({...input,value}));
 expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error.code);
 expect(result.value.schema).toBe('rig-review/act@2');expect(result.value.value).toEqual(value);
});

test('#772 image codec pins to one sealed image and retains local crop and camera evidence',async()=>{
 const codec=imageCommentCodec(),camera={space:'image' as const,zoom:1,center:{x:100,y:50},viewport:{width:200,height:100},visible:{x:0,y:0,width:200,height:100}};
 const pose:ImageCommentPose={mode:'setup',camera,sourceHash:'a'.repeat(64),boxes:[{name:'Source',x:0,y:0,width:80,height:100},{name:'Candidate',x:100,y:0,width:80,height:100}]};
 const crop={path:'comment-crops/test.png',sha256:'b'.repeat(64),png:'data:image/png;base64,AAAA',width:8,height:8};
 const row=await codec.create(pose,'rig',{x:110,y:20,width:10,height:10},crop,{zoom:1},'  spot  ');
 expect(row.image?.name).toBe('Candidate');expect(row.image?.mark.crop).toEqual(crop);expect(row.image?.mark.world).toEqual({x:110,y:20,width:10,height:10});
 expect(codec.signature({...pose,camera:{...camera,zoom:2}})).not.toEqual(codec.signature(pose));
 expect(codec.matches(row.image!.mark,pose,row)).toBe(true);
 expect(codec.matches(row.image!.mark,{...pose,sourceHash:'c'.repeat(64)},row)).toBe(false);
 await expect(codec.create(pose,'rig',{x:75,y:20,width:30,height:10},crop,{},'cross images')).rejects.toThrow('Mark a point or region inside one image.');
});
