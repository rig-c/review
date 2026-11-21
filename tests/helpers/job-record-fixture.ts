import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PNG } from 'pngjs';
import type {
  JobFileIdentity,
  OptionContext,
  PlanContext,
  ProjectRecord,
  RecordOptionResult,
  RecordPartsIdentity,
  RecordPlanResult,
  RecordPublicationReader,
  RecordReaderInput,
} from '../../src/job-contract.ts';
import { jobHash } from '../../src/job-api.ts';

/**
 * SYNTHETIC test-only fixtures for the Review #561 record source and act unit.
 * These fixtures exercise `src/job-source.ts` and `src/job-act.ts` against a
 * synthetic typed `RecordPublicationReader` and do NOT substitute for Create #279
 * writer-built fixtures (`0a-interview-options`, `0b-plan-pending`).
 */
export const SYNTHETIC_RECORD_FIXTURE_MARKER = 'SYNTHETIC_REVIEW_561_RECORD_FIXTURE' as const;

export const DEFAULT_SYNTHETIC_PARTS: RecordPartsIdentity = Object.freeze({
  name: '@rig-c/parts',
  version: '2.25.1',
  integrity: 'sha512-synthetic-parts-integrity',
});

export function makeSyntheticPngBytes(r = 24, g = 120, b = 200): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function writeWorkspaceFile(root: string, relPath: string, content: Buffer | string): JobFileIdentity {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, bytes);
  return { path: relPath, sha256: jobHash(bytes) };
}

export interface SyntheticOptionWorkspace {
  readonly marker: typeof SYNTHETIC_RECORD_FIXTURE_MARKER;
  readonly root: string;
  readonly record: ProjectRecord;
  readonly result: RecordOptionResult;
  readonly inputImage: JobFileIdentity;
  readonly inputSpec: JobFileIdentity;
  readonly optionSetFile: JobFileIdentity;
  readonly files: readonly JobFileIdentity[];
  readonly context: OptionContext;
}

export const SYNTHETIC_RIG_ROOT = 'derived/review/v3';
export const SYNTHETIC_RIG_MODEL = 'build/skeleton.model.json';
export const SYNTHETIC_RIG_PAGE = 'build/skeleton.png';
export const SYNTHETIC_RIG_RGB = [239, 17, 157] as const;
export const rigPictureCases = [
  'bound-rig', 'rig-unsealed-build-row', 'rig-build-hash', 'rig-signoff-hash',
  'rig-signoff-path', 'rig-unlisted-page', 'rig-handoff', 'rig-outputs', 'rig-pre-closure',
  'rig-missing-version', 'rig-missing-version-field', 'rig-retained-model-hash',
] as const;
type RigPictureCase = typeof rigPictureCases[number];
export type PostPictureCase = 'scene' | 'unsealed-scene' | 'rig' | 'rig-no-painting' | 'legacy' | RigPictureCase;

function rigPictureFixture(root: string, variant: RigPictureCase) {
  const signoffAt = '2026-10-31T00:00:00.000Z';
  const config = writeWorkspaceFile(root, 'rig/config.json', '{}');
  const packageConfig = writeWorkspaceFile(root, SYNTHETIC_RIG_ROOT + '/config.json', '{}');
  // The public viewport fixture has one drawn mesh. Pack its single used region into one synthetic page.
  const model = JSON.parse(readFileSync(new URL('../fixtures/viewport-387/package/skeleton.model.json', import.meta.url), 'utf8'));
  const page = model.pages.find((entry: {name: string}) => entry.name === 'mesh.png');
  const still = model.animations.find((clip: {name: string}) => clip.name === 'still');
  if (!page || !still) throw new Error('Synthetic #929 fixture needs the viewport mesh page and static clip');
  model.pages = [{...page, name: 'skeleton.png'}];
  model.images = model.images.filter((entry: {region: string}) => entry.region === 'mesh')
    .map((entry: object) => ({...entry, page: 'skeleton.png'}));
  model.animations = [{...still, name: 'idle'}];
  model.editorOrder.animations = ['idle'];
  const png = new PNG({width: page.width, height: page.height});
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...SYNTHETIC_RIG_RGB, 255], i);
  const build = (path: string, bytes: Buffer | string) => writeWorkspaceFile(root, SYNTHETIC_RIG_ROOT + '/out/' + path, bytes);
  // Create #642 lists all five rows, including the three that playback does not fetch.
  const buildFiles = [
    build('check/build/run.json', '{"synthetic":true}'),
    build('check/build/skeleton.atlas', 'skeleton.png\nsize: 20, 20\n\n'),
    build('check/build/skeleton.json', '{"bones":[{"name":"root"}]}'),
    build('check/' + SYNTHETIC_RIG_MODEL, JSON.stringify(model)),
    build('check/' + SYNTHETIC_RIG_PAGE, PNG.sync.write(png)),
  ];
  const hazard = variant === 'rig-handoff' ? [
    build('check/config.json', '{}'),
    build('parts.json', '{}'),
    build('rig/rig.json', '{}'),
    packageConfig,
  ] : [];
  const files = [
    packageConfig,
    ...buildFiles.filter(row => variant !== 'rig-unlisted-page' || !row.path.endsWith(SYNTHETIC_RIG_PAGE)),
  ].map(row => ({
    path: row.path.slice(SYNTHETIC_RIG_ROOT.length + 1),
    sha256: variant === 'rig-build-hash' && row.path.endsWith(SYNTHETIC_RIG_MODEL) ? '1'.repeat(64) : row.sha256,
  }));
  const reviewPackage = {config: files[0]!, from: 'synthetic', files, open: 'out/check'};
  // Hash the canonical {config, files} shape independently of the production validator.
  const packageHash = jobHash(JSON.stringify({config: reviewPackage.config, files: reviewPackage.files}));
  const outputs = files.filter(row => row.path.endsWith(SYNTHETIC_RIG_MODEL));
  const outputBinding = {path: 'versions[1].outputs', sha256: jobHash(JSON.stringify(outputs))};
  const target = {version: 3, verdict: 'versions[1].verdicts[0]', ...(variant === 'rig-outputs'
    ? {outputs: outputBinding}
    : {review_package: {path: variant === 'rig-signoff-path' ? 'versions[0].review_package' : 'versions[1].review_package',
      sha256: variant === 'rig-signoff-hash' ? '2'.repeat(64) : packageHash}})};
  const versions = [
    {kind: 'rig', n: 2, at: '2026-10-30T00:00:00.000Z'},
    {kind: 'rig', n: 3, at: signoffAt, provenance: {config},
      ...(variant === 'rig-outputs' ? {outputs} : {review_package: reviewPackage}),
      verdicts: [{review: 'rig-review', by: 'synthetic-owner', at: signoffAt, verdict: 'accepted'}]},
  ];
  const parts = {path: 'derived/drafts/synthetic', files: []};
  return {
    context: {kind: 'rig', ...(variant === 'rig-missing-version-field' ? {} : {rig_version: 3}), signoff_at: signoffAt, config, parts},
    files: [config, ...hazard, ...buildFiles.filter(row => variant !== 'rig-outputs' && variant !== 'rig-pre-closure' &&
      (variant !== 'rig-unsealed-build-row' || !row.path.endsWith('/run.json')))],
    versions: variant === 'rig-missing-version' ? versions.slice(0,1) : versions,
    signoffs: [{stage: 'rig-review', checkpoint: null, at: signoffAt, by: 'synthetic-owner', target}],
  };
}

function postPictureFixture(root: string, variant: PostPictureCase | undefined) {
  if (variant === 'rig' || variant === 'rig-no-painting') {
    const config = writeWorkspaceFile(root,'rig/config.json','{}');
    return {context:{kind:'rig',rig_version:1,signoff_at:'2026-10-31T00:00:00Z',
      config,parts:{path:'derived/drafts/synthetic',files:[]}},files:[config]};
  }
  if (!variant || variant === 'legacy') return null;
  if (variant !== 'scene' && variant !== 'unsealed-scene') return rigPictureFixture(root, variant);
  const plate = writeWorkspaceFile(root,'evidence/plate.png',makeSyntheticPngBytes(17,91,203));
  const model = {path:'rig/model.json',sha256:'1'.repeat(64)};
  const box = {x:0,y:0,width:2,height:2};
  const reviewPackage = {config:model,files:[]};
  const acceptanceTarget = {version:1,verdict:'versions[0].verdicts[0]',
    review_package:{path:'versions[0].review_package',sha256:jobHash(JSON.stringify(reviewPackage))}};
  const signature = {stage:'rig-review',checkpoint:null,at:'2026-10-31T00:00:00Z'};
  const document = {schema:'rig-create/scene@1',n:1,rig:{version:1,model,animation:{name:'idle'},
    acceptance:{signoff:signature,verdict:acceptanceTarget.verdict,review_package:acceptanceTarget.review_package}},
    frame:{space:'rig-world-y-up',stage:box},
    plates:[{...plate,role:'background',width:2,height:2,rect:box,registered:{kind:'input',ref:'plate'}}],
    layers:['background','rig']};
  const sceneFile = writeWorkspaceFile(root,'evidence/scene/s1.json',JSON.stringify(document));
  const scene = {n:1,...sceneFile};
  const scenes = [{...scene,at:signature.at,by:'agent'}];
  const signoffs = [{...signature,by:'synthetic-owner',target:acceptanceTarget}];
  const versions = [{kind:'rig',n:1,at:signature.at,review_package:reviewPackage,
    verdicts:[{review:'rig-review',by:'synthetic-owner',at:signature.at,verdict:'accepted'}]}];
  return {context:{kind:'scene',scene},scenes,signoffs,versions,files:variant==='scene'?[sceneFile,plate]:[sceneFile]};
}

export function createSyntheticOptionRecordWorkspace(
  root: string,
  options?: {
    readonly questionId?: string;
    readonly setId?: string;
    readonly stage?: 'interview' | 'rigging-interview' | 'post-interview';
    readonly includeHistoricalSignoff?: boolean;
    readonly boundParts?: boolean;
    readonly questionImages?: boolean;
    readonly postPicture?: PostPictureCase;
    readonly longInterview?: boolean;
  },
): SyntheticOptionWorkspace {
  const questionId = options?.questionId ?? 'rig_type';
  const setId = options?.setId ?? 'set_rig_type_01';
  const stage = options?.stage ?? (options?.postPicture ? 'post-interview' : 'interview');
  const post = postPictureFixture(root, options?.postPicture);

  const inputImage = writeWorkspaceFile(root, 'inputs/reference.png', makeSyntheticPngBytes(40, 160, 220));
  const inputSpec = writeWorkspaceFile(
    root,
    'inputs/spec.json',
    JSON.stringify({ character: 'hero', version: 1 }, null, 2) + '\n',
  );

  const inputs = options?.postPicture === 'rig-no-painting' ? [inputSpec] : [inputImage, inputSpec];
  const boundFiles = options?.boundParts ? [
    writeWorkspaceFile(root, 'derived/drafts/synthetic/parts/body.png', makeSyntheticPngBytes()),
    writeWorkspaceFile(root, 'derived/drafts/synthetic/parts.json', JSON.stringify({rig_size:[2,2],parts:[{name:'body',x:0,y:0,w:2,h:2}]})),
  ] : [];
  const optionSetDoc = {
    schema: 'rig-create/interview-options@1',
    id: setId,
    question: questionId,
    stage,
    drafted_by: 'ai',
    drafted_at: post && 'scenes' in post ? '2026-11-09T00:00:00.000Z' : '2026-11-01T00:00:00.000Z',
    context: post?.context ?? (options?.boundParts ? {kind:'parts',draft_id:'synthetic',parts:{path:'derived/drafts/synthetic',files:boundFiles}} : {
      kind: 'inputs',
      files: options?.questionImages===false ? [inputSpec] : [inputImage, inputSpec],
    }),
    assembly: { rule: 'merge' },
    asks: [
      {
        id: 'topology',
        prompt: 'Select rig topology',
        options: [
          {
            id: 'biped_std',
            kind: 'value',
            label: 'Standard Biped',
            effect: 'Uses standard biped spine and limb chain',
            recommended: true,
            reason: 'Matches reference proportions',
            fragment: { topology: 'biped' },
          },
          {
            id: 'quad_alt',
            kind: 'value',
            label: 'Quadruped Variant',
            effect: 'Uses four-limbed locomotion layout',
            recommended: false,
            fragment: { topology: 'quadruped' },
          },
          {
            id: 'topology_other',
            kind: 'other',
            label: 'Custom topology',
            effect: 'Specify custom topology notes',
            recommended: false,
          },
          {
            id: 'topology_auto',
            kind: 'auto',
            label: 'Producer default',
            effect: 'Let producer choose topology',
            recommended: false,
          },
        ],
      },
      {
        id: 'detail_level',
        prompt: 'Select secondary control density',
        options: [
          {
            id: 'density_high',
            kind: 'value',
            label: 'High Density',
            effect: 'Adds secondary cloth and hair controls',
            recommended: true,
            reason: 'Reference has layered cape',
            fragment: { density: 'high' },
          },
          {
            id: 'density_low',
            kind: 'value',
            label: 'Low Density',
            effect: 'Primary body controls only',
            recommended: false,
            fragment: { density: 'low' },
          },
          {
            id: 'density_other',
            kind: 'other',
            label: 'Custom density',
            effect: 'Describe custom secondary controls',
            recommended: false,
          },
          {
            id: 'density_auto',
            kind: 'auto',
            label: 'Auto density',
            effect: 'Automatic control budget',
            recommended: false,
          },
        ],
      },
      ...(options?.longInterview ? [
      {
        id: 'limb_ik',
        prompt: 'Select limb IK solver',
        options: [
          {
            id: 'ik_two_bone',
            kind: 'value',
            label: 'Two-Bone IK',
            effect: 'Standard analytical two-bone limb solver',
            recommended: true,
            reason: 'Matches biped elbow and knee hinges',
            fragment: { limb_ik: 'two_bone' },
          },
          {
            id: 'ik_fk_blend',
            kind: 'value',
            label: 'IK/FK Blend Chain',
            effect: 'Dual chain with seamless IK/FK switch',
            recommended: false,
            fragment: { limb_ik: 'ik_fk_blend' },
          },
          {
            id: 'limb_ik_other',
            kind: 'other',
            label: 'Custom limb solver',
            effect: 'Describe custom limb kinematics',
            recommended: false,
          },
          {
            id: 'limb_ik_auto',
            kind: 'auto',
            label: 'Auto limb solver',
            effect: 'Let producer choose limb IK',
            recommended: false,
          },
        ],
      },
      {
        id: 'spine_chain',
        prompt: 'Select spine chain layout',
        options: [
          {
            id: 'spine_three',
            kind: 'value',
            label: 'Three-Bone Spine',
            effect: 'Pelvis, chest, and mid-torso controls',
            recommended: true,
            reason: 'Clean silhouette deformation',
            fragment: { spine_chain: 'three_bone' },
          },
          {
            id: 'spine_four',
            kind: 'value',
            label: 'Four-Bone Ribbon Spine',
            effect: 'Adds upper-abdominal counter-twist',
            recommended: false,
            fragment: { spine_chain: 'four_bone' },
          },
          {
            id: 'spine_chain_other',
            kind: 'other',
            label: 'Custom spine layout',
            effect: 'Describe custom torso chain',
            recommended: false,
          },
          {
            id: 'spine_chain_auto',
            kind: 'auto',
            label: 'Auto spine layout',
            effect: 'Let producer choose spine count',
            recommended: false,
          },
        ],
      },
      {
        id: 'hand_controls',
        prompt: 'Select hand control rig',
        options: [
          {
            id: 'hand_fingers',
            kind: 'value',
            label: 'Individual Finger Curl',
            effect: 'Separate curl and splay per finger',
            recommended: true,
            reason: 'Reference shows articulated grip',
            fragment: { hand_controls: 'fingers' },
          },
          {
            id: 'hand_mitt',
            kind: 'value',
            label: 'Grouped Mitt Pose',
            effect: 'Single grip dial for all fingers',
            recommended: false,
            fragment: { hand_controls: 'mitt' },
          },
          {
            id: 'hand_controls_other',
            kind: 'other',
            label: 'Custom hand rig',
            effect: 'Describe custom finger controls',
            recommended: false,
          },
          {
            id: 'hand_controls_auto',
            kind: 'auto',
            label: 'Auto hand rig',
            effect: 'Let producer choose hand controls',
            recommended: false,
          },
        ],
      },
      {
        id: 'foot_roll',
        prompt: 'Select foot roll pivots',
        options: [
          {
            id: 'foot_reverse',
            kind: 'value',
            label: 'Reverse Foot Roll',
            effect: 'Heel, ball, and toe peel pivots',
            recommended: true,
            reason: 'Supports grounded walk cycle',
            fragment: { foot_roll: 'reverse' },
          },
          {
            id: 'foot_simple',
            kind: 'value',
            label: 'Simple Ankle Pivot',
            effect: 'Single ankle rotation + toe bend',
            recommended: false,
            fragment: { foot_roll: 'simple' },
          },
          {
            id: 'foot_roll_other',
            kind: 'other',
            label: 'Custom foot pivots',
            effect: 'Describe custom foot roll setup',
            recommended: false,
          },
          {
            id: 'foot_roll_auto',
            kind: 'auto',
            label: 'Auto foot pivots',
            effect: 'Let producer choose foot roll',
            recommended: false,
          },
        ],
      },
      {
        id: 'face_rig',
        prompt: 'Select facial control rig',
        options: [
          {
            id: 'face_anchors',
            kind: 'value',
            label: 'Brow, Eye, and Jaw Anchors',
            effect: 'Direct gaze, blink, and jaw controls',
            recommended: true,
            reason: 'Supports expressive dialog poses',
            fragment: { face_rig: 'anchors' },
          },
          {
            id: 'face_minimal',
            kind: 'value',
            label: 'Blink and Head Tilt Only',
            effect: 'Minimal facial bone budget',
            recommended: false,
            fragment: { face_rig: 'minimal' },
          },
          {
            id: 'face_rig_other',
            kind: 'other',
            label: 'Custom facial rig',
            effect: 'Describe custom facial controls',
            recommended: false,
          },
          {
            id: 'face_rig_auto',
            kind: 'auto',
            label: 'Auto facial rig',
            effect: 'Let producer choose facial rig',
            recommended: false,
          },
        ],
      },
      {
        id: 'cloth_sim',
        prompt: 'Select cape simulation mode',
        options: [
          {
            id: 'cloth_baked',
            kind: 'value',
            label: 'Keyframed Follow-Through',
            effect: 'Deterministic FK/spring chain on cape',
            recommended: true,
            reason: 'Repeatable across preview loops',
            fragment: { cloth_sim: 'baked' },
          },
          {
            id: 'cloth_live',
            kind: 'value',
            label: 'Live Pendulum Physics',
            effect: 'Runtime wind and gravity response',
            recommended: false,
            fragment: { cloth_sim: 'live' },
          },
          {
            id: 'cloth_sim_other',
            kind: 'other',
            label: 'Custom cape simulation',
            effect: 'Describe custom cloth dynamics',
            recommended: false,
          },
          {
            id: 'cloth_sim_auto',
            kind: 'auto',
            label: 'Auto cape simulation',
            effect: 'Let producer choose cloth mode',
            recommended: false,
          },
        ],
      },
      ] : []),
    ],
    constraints: [
      {
        asks: ['topology', 'detail_level'],
        allowed: [
          ['biped_std', 'density_high'],
          ['biped_std', 'density_low'],
          ['quad_alt', 'density_low'],
        ],
      },
    ],
  };

  const optionSetPath = `interview/options/${questionId}-${setId}.json`;
  const optionSetFile = writeWorkspaceFile(root, optionSetPath, JSON.stringify(optionSetDoc, null, 2) + '\n');

  const framingItems = stage === 'interview'
    ? [{ id: questionId, pending_options: optionSetFile }]
    : [];
  const waypointItems = stage === 'rigging-interview'
    ? [{ id: questionId, pending_options: optionSetFile }]
    : [];
  const postItems = stage === 'post-interview'
    ? [{ id: questionId, pending_options: optionSetFile }]
    : [];

  const projectDoc: Record<string, unknown> = {
    schema: 'rig-create/project@0',
    name: 'Synthetic Option Project',
    ...(post && 'scenes' in post ? {scenes:post.scenes} : {}),
    ...(post?.versions ? {versions:post.versions,signoffs:post.signoffs} : {}),
    inputs,
    interview: {
      framing: framingItems,
      waypoints: waypointItems,
      post: { items: postItems },
    },
    ...(options?.includeHistoricalSignoff
      ? {
          // Present to verify Review does not re-run `readProject` semantic approval/reopened checks.
          signoffs: [
            {
              stage: 'plan-approved',
              by: 'reviewer_1',
              at: '2026-11-05T00:00:00.000Z',
            },
          ],
        }
      : {}),
  };

  const recordIdentity = writeWorkspaceFile(root, 'project.json', JSON.stringify(projectDoc, null, 2) + '\n');
  const record: ProjectRecord = { path: 'project.json', sha256: recordIdentity.sha256 };
  const files = [...inputs, optionSetFile, record, ...boundFiles, ...(post?.files ?? [])].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const result: RecordOptionResult = { kind: 'option-set', questionId, setId };
  const context: OptionContext = {
    label: 'Synthetic Option Project',
    parts: { ...DEFAULT_SYNTHETIC_PARTS },
    inputs,
    files,
    plan: null,
    subjects: [{ kind: 'interview-picks', questionId, setId }],
  };

  return {
    marker: SYNTHETIC_RECORD_FIXTURE_MARKER,
    root,
    record,
    result,
    inputImage,
    inputSpec,
    optionSetFile,
    files,
    context,
  };
}

/** #1004: four rigging questions (bones, meshes, constraints, motion), in Korean 해요체, for the K = 4 job fixture.
 * Fixture text, not catalog strings. Question and set ids are ASCII identifiers (src/interview-project.ts:40), so the
 * id is the short title and the prompt carries the Korean question. */
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

/** One rigging question's ask: its two values, then Other and Auto. */
function riggingPlanAsks(item:typeof RIGGING_PLAN[number]){
 const options=[
  ...item.values.map((value,n)=>({id:value.id,kind:'value',label:value.label,effect:value.effect,fragment:value.id,recommended:n===0,...(value.reason?{reason:value.reason}:{})})),
  {id:'other',kind:'other',label:'직접 적을게요',effect:'원하는 방식을 직접 적어요',recommended:false},
  {id:'auto',kind:'auto',label:'알아서 정해 주세요',effect:'AI가 그림을 보고 정해요',recommended:false},
 ];
 return [{id:item.question,prompt:item.prompt,options}];
}

/** #1004: one option-set publication carrying the plan's rigging questions, one framing question and one set each.
 * Every set binds the same declared painting (`inputs/reference.png`, or the serve-only `painting` bytes). */
export function createSyntheticOptionSetsRecordWorkspace(
  root: string,
  options: { readonly count: number; readonly painting?: Buffer },
): SyntheticOptionWorkspace & { readonly optionSetFiles: readonly JobFileIdentity[] } {
  const plan = RIGGING_PLAN.slice(0, options.count);
  if (plan.length !== options.count || options.count < 1) throw new Error('SYNTHETIC_1004_SET_COUNT');
  const inputImage = writeWorkspaceFile(root, 'inputs/reference.png', options.painting ?? makeSyntheticPngBytes(40, 160, 220));
  const inputSpec = writeWorkspaceFile(root, 'inputs/spec.json', JSON.stringify({ character: 'hero', version: 1 }, null, 2) + '\n');
  const optionSetFiles = plan.map((item, index) => writeWorkspaceFile(root, `interview/options/rigging-${index + 1}.json`,
    JSON.stringify({ schema: 'rig-create/interview-options@1', id: `rig-${item.question}-01`, question: item.question,
      stage: 'interview', drafted_by: 'ai', drafted_at: '2026-11-20T00:00:00.000Z',
      context: { kind: 'inputs', files: [inputImage, inputSpec] }, assembly: { rule: 'single' }, asks: riggingPlanAsks(item) }, null, 2) + '\n'));
  const projectDoc = {
    schema: 'rig-create/project@0',
    name: 'Synthetic Rigging Questions',
    inputs: [inputImage, inputSpec],
    interview: { framing: plan.map((item, index) => ({ id: item.question, pending_options: optionSetFiles[index] })), waypoints: [], post: { items: [] } },
  };
  const recordIdentity = writeWorkspaceFile(root, 'project.json', JSON.stringify(projectDoc, null, 2) + '\n');
  const record: ProjectRecord = { path: 'project.json', sha256: recordIdentity.sha256 };
  const files = [inputImage, inputSpec, ...optionSetFiles, record].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sets = plan.map(item => ({ questionId: item.question, setId: `rig-${item.question}-01` }));
  const result: RecordOptionResult = { kind: 'option-set', ...sets[0]!, ...(sets.length > 1 ? { sets } : {}) };
  const context: OptionContext = { label: 'Synthetic rigging questions', parts: { ...DEFAULT_SYNTHETIC_PARTS }, inputs: [inputImage, inputSpec], files, plan: null,
    subjects: sets.map(set => ({ kind: 'interview-picks', ...set })) };
  return { marker: SYNTHETIC_RECORD_FIXTURE_MARKER, root, record, result, inputImage, inputSpec,
    optionSetFile: optionSetFiles[0]!, optionSetFiles, files, context };
}

export interface SyntheticPlanWorkspace {
  readonly marker: typeof SYNTHETIC_RECORD_FIXTURE_MARKER;
  readonly root: string;
  readonly record: ProjectRecord;
  readonly result: RecordPlanResult;
  readonly inputImage: JobFileIdentity;
  readonly inputSpec: JobFileIdentity;
  readonly planEvidence: JobFileIdentity;
  readonly files: readonly JobFileIdentity[];
  readonly context: PlanContext;
}

export function createSyntheticPlanRecordWorkspace(
  root: string,
  options?: {
    readonly steps?: readonly { readonly id: string; readonly hash: string }[];
    readonly subjects?: PlanContext['subjects'];
    readonly text?: {does:string; produces:string; bar:string; rests_on:readonly string[]};
    readonly interview?: {
      readonly framing?: readonly Record<string, unknown>[];
      readonly waypoints?: readonly Record<string, unknown>[];
      readonly post?: {readonly items?: readonly Record<string, unknown>[]};
    };
  },
): SyntheticPlanWorkspace {
  const inputImage = writeWorkspaceFile(root, 'inputs/reference.png', makeSyntheticPngBytes(180, 90, 40));
  const inputSpec = writeWorkspaceFile(
    root,
    'inputs/spec.json',
    JSON.stringify({ character: 'paladin', version: 2 }, null, 2) + '\n',
  );
  const planEvidence = writeWorkspaceFile(
    root,
    'plan/context-evidence.json',
    JSON.stringify({ summary: 'Synthetic multi-file closure evidence' }, null, 2) + '\n',
  );

  const steps = options?.steps ?? [
    { id: 'step_layout', hash: '1'.repeat(64) },
    { id: 'step_weights', hash: '2'.repeat(64) },
  ];

  const projectDoc = {
    schema: 'rig-create/project@0',
    name: 'Synthetic Plan Project',
    inputs: [inputImage, inputSpec],
    interview: {
      framing: options?.interview?.framing ?? [],
      waypoints: options?.interview?.waypoints ?? [],
      post: { items: options?.interview?.post?.items ?? [] },
    },
    plan: {
      steps: steps.map(step => ({
        id: step.id,
        title: `Title for ${step.id}`,
        // Arbitrary internal fields; Review must treat official step.hash as opaque.
        customProducerField: `opaque-${step.id}`,
        ...(options?.text ?? {}),
      })),
    },
  };

  const recordIdentity = writeWorkspaceFile(root, 'project.json', JSON.stringify(projectDoc, null, 2) + '\n');
  const record: ProjectRecord = { path: 'project.json', sha256: recordIdentity.sha256 };
  const files = [inputImage, inputSpec, planEvidence, record].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const result: RecordPlanResult = { kind: 'plan' };
  const subjects: PlanContext['subjects'] = options?.subjects ?? [
    { kind: 'checkpoint', checkpointId: steps[0]!.id },
    { kind: 'checkpoint', checkpointId: steps[1]!.id },
    { kind: 'signoff', stage: 'plan-approved' },
    { kind: 'signoff', stage: 'rigging-interview' },
    { kind: 'signoff', stage: 'post-interview' },
  ];
  const context: PlanContext = {
    label: 'Synthetic Plan Project',
    parts: { ...DEFAULT_SYNTHETIC_PARTS },
    inputs: [inputImage, inputSpec],
    files,
    plan: { steps },
    subjects,
  };

  return {
    marker: SYNTHETIC_RECORD_FIXTURE_MARKER,
    root,
    record,
    result,
    inputImage,
    inputSpec,
    planEvidence,
    files,
    context,
  };
}

export function createSyntheticRecordReader(handlers: {
  readonly onOption?: (input: RecordReaderInput<RecordOptionResult>) => OptionContext | Promise<OptionContext>;
  readonly onPlan?: (input: RecordReaderInput<RecordPlanResult>) => PlanContext | Promise<PlanContext>;
}): {
  readonly reader: RecordPublicationReader;
  readonly calls: RecordReaderInput[];
} {
  const calls: RecordReaderInput[] = [];
  const reader = (async (input: RecordReaderInput): Promise<OptionContext | PlanContext> => {
    calls.push(structuredClone(input));
    if (input.result.kind === 'option-set') {
      if (!handlers.onOption) throw new Error('Unexpected option-set reader call');
      return await handlers.onOption(input as RecordReaderInput<RecordOptionResult>);
    }
    if (!handlers.onPlan) throw new Error('Unexpected plan reader call');
    return await handlers.onPlan(input as RecordReaderInput<RecordPlanResult>);
  }) as RecordPublicationReader;
  return { reader, calls };
}
