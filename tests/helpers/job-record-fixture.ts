import { mkdirSync, writeFileSync } from 'node:fs';
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

export function createSyntheticOptionRecordWorkspace(
  root: string,
  options?: {
    readonly questionId?: string;
    readonly setId?: string;
    readonly stage?: 'interview' | 'rigging-interview' | 'post-interview';
    readonly includeHistoricalSignoff?: boolean;
    readonly boundParts?: boolean;
    readonly questionImages?: boolean;
    readonly longInterview?: boolean;
  },
): SyntheticOptionWorkspace {
  const questionId = options?.questionId ?? 'rig_type';
  const setId = options?.setId ?? 'set_rig_type_01';
  const stage = options?.stage ?? 'interview';

  const inputImage = writeWorkspaceFile(root, 'inputs/reference.png', makeSyntheticPngBytes(40, 160, 220));
  const inputSpec = writeWorkspaceFile(
    root,
    'inputs/spec.json',
    JSON.stringify({ character: 'hero', version: 1 }, null, 2) + '\n',
  );

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
    drafted_at: '2026-11-01T00:00:00.000Z',
    context: options?.boundParts ? {kind:'parts',draft_id:'synthetic',parts:{path:'derived/drafts/synthetic',files:boundFiles}} : {
      kind: 'inputs',
      files: options?.questionImages===false ? [inputSpec] : [inputImage, inputSpec],
    },
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
    inputs: [inputImage, inputSpec],
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
  const files = [inputImage, inputSpec, optionSetFile, record, ...boundFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const result: RecordOptionResult = { kind: 'option-set', questionId, setId };
  const context: OptionContext = {
    label: 'Synthetic Option Project',
    parts: { ...DEFAULT_SYNTHETIC_PARTS },
    inputs: [inputImage, inputSpec],
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
      framing: [],
      waypoints: [],
      post: { items: [] },
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
