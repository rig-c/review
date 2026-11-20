import {expect, test} from 'bun:test';
import {canonicalJson} from '../src/canonical-json.ts';
import {
  jobBody, jobBodyLimit, jobHash, meshEditDigest, meshEditsActForEmission, parseCommentsAct,
  parseContextCommentsAct, parseMeshEdits, parseMeshEditsAct, requestDigest,
} from '../src/job-api.ts';
import {
  JOB_COMMENTS_ACT_SCHEMA, JOB_COMMENT_CONTEXT_ACT_SCHEMA, JOB_MESH_EDITS_ACT_SCHEMA, jobCaptureBodyLimit,
  type JobContextComment, type JobMeshEdit, type JobMeshEditValue, type JobRigReviewAct,
} from '../src/job-contract.ts';
import model from './fixtures/strip-probe/mesh-only/skeleton.model.json';
import legacy from './fixtures/comments-contract-legacy.json';

const attachmentHash = '576344044f966225f8e77ebf91bdbbc22b4408ab6b5c449283c2383d6f5b30c0';
const edit: JobMeshEditValue = {
  slot: 'mesh', skin: 'default', attachment: 'mesh', basis: 'setup',
  source: {
    vertexCount: 4, triangleCount: 2, hullLength: 4, hash: attachmentHash, frame: {width: 80, height: 64},
    positions: [[38, 42], [38, 22], [58.3, 22.000000000000004], [58, 42]],
  },
  ops: [
    {op: 'move', v: 2, from: [58.3, 22.000000000000004], to: [58.5, 21.25]},
    {op: 'add', at: [48, 32], onEdge: [1, 2]},
    {op: 'edge', a: 0, b: 4},
  ],
};
const canonicalEdit = '{"attachment":"mesh","basis":"setup","ops":[{"from":[58.3,22.000000000000004],"op":"move","to":[58.5,21.25],"v":2},' +
  '{"at":[48,32],"onEdge":[1,2],"op":"add"},{"a":0,"b":4,"op":"edge"}],"skin":"default","slot":"mesh","source":' +
  '{"frame":{"height":64,"width":80},"hash":"576344044f966225f8e77ebf91bdbbc22b4408ab6b5c449283c2383d6f5b30c0",' +
  '"hullLength":4,"positions":[[38,42],[38,22],[58.3,22.000000000000004],[58,42]],"triangleCount":2,"vertexCount":4}}';
const entry: JobMeshEdit = {edit, sha256: '00a3c311ea13ba5123f9351a64df1e616508be413e2e0388e48dfd205d768235'};
const {value: _oldValue, ...rig} = JSON.parse(legacy.records['@3'].raw) as JobRigReviewAct;

function rigAct(schema: string, fields: Record<string, unknown> = {meshEdits: [entry]}) {
  return {...rig, schema, value: {stage: 'rig-review', verdict: 'changes-requested', comments: [], ...fields}};
}

function withDigest<Value>(edit: Value) {
  return {edit, sha256: jobHash(canonicalJson(edit))};
}

test('#952 worked vector binds the stored entry and signed unrounded positions', () => {
  const modelEntry = model.skins.find(({name}) => name === 'default')!.attachments.mesh.mesh;
  expect(jobHash(JSON.stringify(modelEntry))).toBe(attachmentHash);
  expect(canonicalJson(edit)).toBe(canonicalEdit);
  expect(Buffer.byteLength(canonicalEdit)).toBe(445);
  expect(meshEditDigest(edit)).toBe(entry.sha256);
  expect(meshEditDigest(JSON.parse(canonicalEdit))).toBe(entry.sha256);
  // The draft vector predates the HQ amendment. Its hash and attachment hash are distinct.
  const {positions: _positions, ...draftSource} = edit.source;
  expect(jobHash(canonicalJson({...edit, source: draftSource})))
    .toBe('5dc2eb0f2d51839764117b86deca3026c8a7ac2dce75b5948731fd11a4e4bda7');
  expect(parseMeshEdits([entry])).toEqual([entry]);
  const moved = {...edit, source: {...edit.source, positions: [[39, 42], ...edit.source.positions.slice(1)]}};
  expect(() => parseMeshEdits([{...entry, edit: moved}])).toThrow('JOB_ACT_INVALID');
});

test('#952 extraction preserves the legacy request digest including JSON integer-key order', () => {
  const request = {z: {'\uE000': false, '𐀀': true, 'ä': 'a', '\n': '줄'},
    10: 'ten', 2: 'two', a: [1e-7, 22.000000000000004, {z: -0, a: null}], absent: undefined};
  expect(requestDigest(request)).toBe('cf40af60bfcccec3224781ec167421e385d118e35a6ec85ec26260aec9b90e4e');
  expect(canonicalJson(request)).toBe('{"2":"two","10":"ten","a":[1e-7,22.000000000000004,{"a":null,"z":0}],"z":{"\\n":"줄","ä":"a","𐀀":true,"":false}}');
});

test('#952 @8 keeps the @7 comment context and accepts a mesh-only Request changes', () => {
  const raw = rigAct(JOB_MESH_EDITS_ACT_SCHEMA);
  const bytes = JSON.stringify(raw);
  expect(JSON.stringify(parseMeshEditsAct(JSON.parse(bytes)))).toBe(bytes);
  const comment: JobContextComment = {text: ' 소매\n', context: {mode: 'setup', subject: {
    ask: {kind: 'review-verdict', stage: 'rig-review'}, sourceHash: rig.source.sourceHash,
    selector: rig.source.selector,
  }}};
  expect(parseMeshEditsAct(rigAct(JOB_MESH_EDITS_ACT_SCHEMA, {comments: [comment], meshEdits: [entry]})).value.comments)
    .toEqual([comment]);
  expect(parseMeshEditsAct(rigAct(JOB_MESH_EDITS_ACT_SCHEMA, {comments: [comment]})).value.comments).toEqual([comment]);
  expect(() => parseMeshEditsAct(rigAct(JOB_MESH_EDITS_ACT_SCHEMA, {comments: [], meshEdits: []}))).toThrow('JOB_ACT_INVALID');
  expect(() => parseMeshEditsAct(rigAct(JOB_MESH_EDITS_ACT_SCHEMA, {}))).toThrow('JOB_ACT_INVALID');
  expect(parseCommentsAct(rigAct(JOB_COMMENTS_ACT_SCHEMA, {})).value.comments).toEqual([]);
});

test('#952 mesh fields are exclusive to @8 compiled-rig Request changes', () => {
  const raw = rigAct(JOB_MESH_EDITS_ACT_SCHEMA);
  const direction = {path: 'direction.json', sha256: attachmentHash};
  const {still: _still, ...withoutStill} = raw;
  const invalid = [
    {...raw, value: {...raw.value, verdict: 'approved'}},
    {...raw, value: {...raw.value, verdict: 'pending'}},
    {...raw, value: {...raw.value, stage: 'image-review'}},
    {...withoutStill, source: {...raw.source, direction, selector: {kind: 'post', version: 1, rigVersion: 1}},
      value: {...raw.value, stage: 'direction-review'}},
    {...withoutStill, kind: 'signoff', value: {stage: 'rig-review', decision: 'approved', comments: [], meshEdits: [entry]}},
    {...withoutStill, kind: 'mesh-edit', value: {meshEdits: [entry]}},
    {...raw, source: {...raw.source, model: null}},
    withoutStill,
    rigAct(JOB_COMMENTS_ACT_SCHEMA), rigAct(JOB_COMMENT_CONTEXT_ACT_SCHEMA),
  ];
  for (const item of invalid) expect(() => parseMeshEditsAct(item)).toThrow('JOB_ACT_INVALID');
  expect(() => parseCommentsAct(raw)).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct(raw)).toThrow('JOB_ACT_INVALID');
  expect(() => parseCommentsAct(rigAct(JOB_COMMENTS_ACT_SCHEMA))).toThrow('JOB_ACT_INVALID');
  expect(() => parseContextCommentsAct(rigAct(JOB_COMMENT_CONTEXT_ACT_SCHEMA))).toThrow('JOB_ACT_INVALID');
});

test('#952 payload order uses UTF-16 and permits each source tuple only once', () => {
  const first = withDigest({...edit, skin: '𐀀'}), second = withDigest({...edit, skin: '\uE000'});
  expect(parseMeshEdits([first, second])).toEqual([first, second]);
  expect(() => parseMeshEdits([second, first])).toThrow('JOB_ACT_INVALID');
  const changed = withDigest({...edit, ops: [{op: 'remove', v: 0}]});
  expect(() => parseMeshEdits([entry, changed])).toThrow('JOB_ACT_INVALID');
  const slashInSkin = withDigest({...edit, skin: 'a/b', slot: 'c'});
  const slashInSlot = withDigest({...edit, skin: 'a', slot: 'b/c'});
  expect(parseMeshEdits([slashInSkin, slashInSlot])).toEqual([slashInSkin, slashInSlot]);
});

test('#952 operation grammar accepts all five ops and caps each edit at 300', () => {
  const ops = [...edit.ops, {op: 'unedge', a: 0, b: 4}, {op: 'remove', v: 4}, {op: 'add', at: [1.13, 2.22]}];
  expect(parseMeshEdits([withDigest({...edit, ops})])).toHaveLength(1);
  const largeRounded = {op: 'add', at: [35184372088832.02, 0]};
  expect(parseMeshEdits([withDigest({...edit, ops: [largeRounded]})])).toHaveLength(1);
  const limit = Array.from({length: 300}, () => ({op: 'move', v: 0, from: [38, 42], to: [38, 42]}));
  expect(parseMeshEdits([withDigest({...edit, ops: limit})])).toHaveLength(1);
  expect(() => parseMeshEdits([withDigest({...edit, ops: [...limit, limit[0]]})])).toThrow('JOB_ACT_INVALID');
});

for (const [name, badEdit] of [
  ['extra edit key', {...edit, preview: 'legacy'}],
  ['empty identity', {...edit, slot: ''}],
  ['wrong basis', {...edit, basis: 'posed'}],
  ['bad source digest', {...edit, source: {...edit.source, hash: attachmentHash.toUpperCase()}}],
  ['missing source positions', {...edit, source: {...edit.source, positions: undefined}}],
  ['wrong position count', {...edit, source: {...edit.source, positions: [[0, 0]]}}],
  ['wrong position shape', {...edit, source: {...edit.source, positions: [[1], ...edit.source.positions.slice(1)]}}],
  ['negative zero position', {...edit, source: {...edit.source, positions: [[-0, 42], ...edit.source.positions.slice(1)]}}],
  ['invalid source count', {...edit, source: {...edit.source, triangleCount: 2.5}}],
  ['non-finite frame', {...edit, source: {...edit.source, frame: {width: Infinity, height: 64}}}],
  ['non-positive frame', {...edit, source: {...edit.source, frame: {width: 80, height: 0}}}],
  ['extra frame key', {...edit, source: {...edit.source, frame: {width: 80, height: 64, x: -40}}}],
  ['empty ops', {...edit, ops: []}],
  ['non-finite move', {...edit, ops: [{op: 'move', v: 1, from: [NaN, 0], to: [0, 0]}]}],
  ['unrounded destination', {...edit, ops: [{op: 'add', at: [2.005, 3]}]}],
  ['extra op key', {...edit, ops: [{op: 'remove', v: 1, at: [0, 0]}]}],
  ['negative index', {...edit, ops: [{op: 'edge', a: -1, b: 2}]}],
  ['unsafe index', {...edit, ops: [{op: 'unedge', a: 0, b: 2 ** 53}]}],
  ['malformed onEdge', {...edit, ops: [{op: 'add', at: [0, 0], onEdge: [1, -1]}]}],
] as const) {
  test(`#952 rejects ${name} even with a recomputed digest`, () => {
    expect(() => parseMeshEdits([withDigest(badEdit)])).toThrow('JOB_ACT_INVALID');
  });
}

test('#952 rejects malformed mesh envelopes and tampered digests', () => {
  for (const packet of [null, [], [null], [{edit}], [{...entry, schema: 'extra'}], [{...entry, sha256: attachmentHash}]]) {
    expect(() => parseMeshEdits(packet)).toThrow('JOB_ACT_INVALID');
  }
});

test('#977 mesh emission writes @8 and preserves mesh-free @6 bytes', () => {
  const meshFree = parseCommentsAct(rigAct(JOB_COMMENTS_ACT_SCHEMA, {}));
  if (meshFree.kind !== 'review-verdict') throw new Error('Expected a review verdict fixture');
  const withEdits = {...meshFree, value: {...meshFree.value, meshEdits: [entry]}};
  expect(JSON.stringify(meshEditsActForEmission(withEdits))).toBe(JSON.stringify(rigAct(JOB_MESH_EDITS_ACT_SCHEMA)));
  expect(JSON.stringify(meshEditsActForEmission(meshFree))).toBe(JSON.stringify(meshFree));
});

function bodyRequest(payload: unknown, byteLength: number): Request {
  const json = JSON.stringify(payload);
  const body = json + ' '.repeat(byteLength - Buffer.byteLength(json));
  return new Request('http://127.0.0.1/jobs/job/ui/acts', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body,
  });
}

test('#952 limits canonical mesh bytes independently of the existing capture allowance', async () => {
  const value = {stage: 'rig-review', verdict: 'changes-requested',
    feedback: [{summary: '소매', context: {crop: {png: 'data:image/png;base64,AA=='}}}]};
  const capture = {png: 'data:image/png;base64,' + 'A'.repeat(jobBodyLimit)};
  const largeCapture = {kind: 'review-verdict', capture, value: {...value, meshEdits: [entry]}};
  const request = (payload: unknown) => bodyRequest(payload, Buffer.byteLength(JSON.stringify(payload)));
  await expect(jobBody(request(largeCapture), jobCaptureBodyLimit)).resolves.toEqual(largeCapture);
  await expect(jobBody(request(largeCapture))).rejects.toMatchObject({code: 'JOB_BODY_LIMIT'});

  const meshEdits = [{...entry, edit: {...entry.edit, attachment: ''}}];
  const baseBytes = Buffer.byteLength(canonicalJson(meshEdits));
  meshEdits[0]!.edit.attachment = 'x'.repeat(jobBodyLimit - baseBytes);
  const atLimit = {...largeCapture, value: {...value, meshEdits}};
  await expect(jobBody(request(atLimit), jobCaptureBodyLimit)).resolves.toEqual(atLimit);
  meshEdits[0]!.edit.attachment += 'x';
  await expect(jobBody(request(atLimit), jobCaptureBodyLimit)).rejects.toMatchObject({code: 'JOB_BODY_LIMIT'});

  const commentImages = {kind: 'review-verdict', value};
  await expect(jobBody(bodyRequest(commentImages, jobBodyLimit + 1), jobCaptureBodyLimit)).resolves.toEqual(commentImages);
});
