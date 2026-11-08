import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOB_API_V3_SCHEMA,
  type OptionContext,
  type PlanContext,
} from '../src/job-contract.ts';
import {
  jobHash,
  recordInstanceKey,
  recordSourceDigest,
} from '../src/job-api.ts';
import {
  assertJobSourceCurrent,
  assertRetainedSnapshotIntact,
  captureJobRoot,
  isRetainedRecordSource,
  prepareJobRecordSource,
  prepareJobSource,
  verifyJobRecordSourceFresh,
} from '../src/job-source.ts';
import { JobError } from '../src/job-store.ts';
import {
  createSyntheticOptionRecordWorkspace,
  createSyntheticPlanRecordWorkspace,
  createSyntheticRecordReader,
  SYNTHETIC_RECORD_FIXTURE_MARKER,
  writeWorkspaceFile,
} from './helpers/job-record-fixture.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Review #561 model-free record source preparation (SYNTHETIC reader fixtures)', () => {
  test('[SYNTHETIC] prepares an option-set record source via two-phase official reader without review.json or semantic readProject checks', async () => {
    const workRoot = makeTempDir('review-561-opt-root-');
    const stateRoot = makeTempDir('review-561-opt-state-');
    const fixture = createSyntheticOptionRecordWorkspace(workRoot, {
      questionId: 'rig_type',
      setId: 'set_rig_type_01',
      stage: 'interview',
      includeHistoricalSignoff: true,
    });
    expect(fixture.marker).toBe(SYNTHETIC_RECORD_FIXTURE_MARKER);
    expect(existsSync(join(workRoot, 'review.json'))).toBe(false);

    const { reader, calls } = createSyntheticRecordReader({
      onOption: () => structuredClone(fixture.context),
    });

    const root = captureJobRoot(workRoot);
    const fingerprint = 'daemon-fp-option-01\u0007-' + 'x'.repeat(160);
    const retained = await prepareJobRecordSource({
      root,
      stateRoot,
      fingerprint,
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_opt_1', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });

    expect(isRetainedRecordSource(retained)).toBe(true);
    expect(retained.kind).toBe('record');
    expect(retained.manifestPath).toBeNull();
    expect(retained.visual).toEqual({ status: 'unavailable', code: 'MODEL_UNAVAILABLE' });
    expect(retained.partIds).toEqual([]);
    expect(calls.map(call => call.phase)).toEqual(['inventory', 'retained']);
    expect(calls[0]!.root).toBe(root.path);
    expect(calls[0]!.parts).toBeUndefined();
    expect(calls[1]!.root).toBe(retained.snapshotRoot);
    expect(calls[1]!.parts).toEqual(fixture.context.parts);
    expect(retained.context.parts).toEqual(fixture.context.parts);
    expect(retained.seals).toEqual(fixture.files);

    const expectedHash = recordSourceDigest({
      record: fixture.record,
      selection: fixture.result,
      inputs: fixture.context.inputs,
      optionSet: { id: fixture.result.setId, sha256: fixture.optionSetFile.sha256 },
      optionSetFile: fixture.optionSetFile,
      plan: null,
      subjects: fixture.context.subjects,
      files: fixture.files,
    });
    expect(retained.source.sourceHash).toBe(expectedHash);
    expect(retained.source.projectHash).toBe(fixture.record.sha256);
    expect(retained.source.subject).toBe('option-set');
    expect(retained.instanceKey).toBe(recordInstanceKey(fingerprint, expectedHash));
    expect(retained.questions).toHaveLength(1);
    expect(retained.questions[0]!.set.id).toBe('set_rig_type_01');
    expect(retained.questions[0]!.set.question).toBe('rig_type');
    expect(retained.questions[0]!.images).toEqual([
      { ref: fixture.inputImage, name: 'reference.png', type: 'image/png' },
    ]);

    const viaOverload = await prepareJobSource({
      root,
      stateRoot,
      fingerprint,
      request: {
        schema: JOB_API_V3_SCHEMA,
        jobId: 'job_1',
        requestId: 'req_1',
        verb: 'publish',
        expectedGeneration: 0,
        idempotencyKey: 'idem_1',
        freeze: { kind: 'producer-held', holdId: 'hold_opt_1', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });
    expect(isRetainedRecordSource(viaOverload)).toBe(true);
    expect(viaOverload.source).toEqual(retained.source);
    expect(viaOverload.instanceKey).toBe(retained.instanceKey);
  });

  test('[SYNTHETIC] prepares a plan record source with multi-file closure and preserves opaque step hashes', async () => {
    const workRoot = makeTempDir('review-561-plan-root-');
    const stateRoot = makeTempDir('review-561-plan-state-');
    const customSteps = [
      { id: 'step_alpha', hash: 'a'.repeat(64) },
      { id: 'step_beta', hash: 'b'.repeat(64) },
    ];
    const fixture = createSyntheticPlanRecordWorkspace(workRoot, { steps: customSteps });
    const { reader, calls } = createSyntheticRecordReader({
      onPlan: () => structuredClone(fixture.context),
    });

    const root = captureJobRoot(workRoot);
    const retained = await prepareJobRecordSource({
      root,
      stateRoot,
      fingerprint: 'daemon-fp-plan-01',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_plan_1', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });

    expect(calls.map(call => call.phase)).toEqual(['inventory', 'retained']);
    expect(calls[0]!.parts).toBeUndefined();
    expect(calls[1]!.parts).toEqual(fixture.context.parts);
    expect(retained.context.parts).toEqual(fixture.context.parts);
    expect(retained.source.subject).toBe('plan');
    if (retained.source.subject === 'plan') {
      expect(retained.source.plan.steps).toEqual(customSteps);
      expect(retained.source.optionSet).toBeNull();
      expect(retained.source.optionSetFile).toBeNull();
    }
    expect(retained.seals).toEqual(fixture.files);
    expect(retained.questions).toEqual([]);
    assertJobSourceCurrent(retained);
    assertRetainedSnapshotIntact(retained.snapshotRoot, retained.seals, retained.snapshotIdentity);

    // Inspection-only empty plan (steps: [], subjects: []) is permitted by signed CP1
    const emptyPlanRoot = makeTempDir('review-561-empty-plan-root-');
    const emptyPlanFixture = createSyntheticPlanRecordWorkspace(emptyPlanRoot, {
      steps: [],
      subjects: [],
    });
    const emptyPlanReader = createSyntheticRecordReader({
      onPlan: () => structuredClone(emptyPlanFixture.context),
    });
    const emptyRetained = await prepareJobRecordSource({
      root: captureJobRoot(emptyPlanRoot),
      stateRoot,
      fingerprint: 'daemon-fp-empty-plan',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_empty_plan', record: emptyPlanFixture.record },
        result: emptyPlanFixture.result,
      },
      readRecordPublished: emptyPlanReader.reader,
    });
    expect(emptyRetained.source.subject).toBe('plan');
    if (emptyRetained.source.subject === 'plan') {
      expect(emptyRetained.source.plan.steps).toEqual([]);
      expect(emptyRetained.source.subjects).toEqual([]);
    }
    const freshEmpty = await verifyJobRecordSourceFresh({
      retained: emptyRetained,
      readRecordPublished: emptyPlanReader.reader,
      phase: 'ask',
    });
    expect(freshEmpty).toEqual(emptyRetained.source);
  });

  test('[SYNTHETIC] refuses missing reader and preserves named contract/closure refusal tokens without leaking private paths', async () => {
    const workRoot = makeTempDir('review-561-refusal-root-');
    const stateRoot = makeTempDir('review-561-refusal-state-');
    const fixture = createSyntheticPlanRecordWorkspace(workRoot);
    const root = captureJobRoot(workRoot);

    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
      }),
    ).rejects.toMatchObject({
      code: 'JOB_SOURCE_UNRETAINABLE',
      message: 'CREATE_PUBLICATION_CONTRACT_UNAVAILABLE',
    });

    const planContractUnavailableReader = createSyntheticRecordReader({
      onPlan: () => {
        const err = new Error('CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE') as Error & { code?: string };
        err.code = 'CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE';
        throw err;
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: planContractUnavailableReader.reader,
      }),
    ).rejects.toMatchObject({
      code: 'JOB_SOURCE_UNRETAINABLE',
      message: 'CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE',
    });

    const closureIncompleteReader = createSyntheticRecordReader({
      onPlan: input => {
        if (input.phase === 'retained') {
          const err = new Error('Unsealed read in retained root') as Error & { code?: string };
          err.code = 'JOB_RECORD_CLOSURE_INCOMPLETE';
          throw err;
        }
        return structuredClone(fixture.context);
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: closureIncompleteReader.reader,
      }),
    ).rejects.toMatchObject({
      code: 'JOB_RECORD_INCOMPLETE',
      message: 'JOB_RECORD_CLOSURE_INCOMPLETE',
    });

    for (const partsToken of ['JOB_RECORD_PARTS_MISMATCH', 'JOB_RECORD_PARTS_LOCK_MISSING'] as const) {
      const partsRefusalReader = createSyntheticRecordReader({
        onPlan: () => {
          const err = new Error(partsToken) as Error & { code?: string };
          err.code = partsToken;
          throw err;
        },
      });
      await expect(
        prepareJobRecordSource({
          root,
          stateRoot,
          fingerprint: 'fp',
          request: {
            freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
            result: fixture.result,
          },
          readRecordPublished: partsRefusalReader.reader,
        }),
      ).rejects.toMatchObject({
        code: 'JOB_RECORD_INCOMPLETE',
        message: partsToken,
      });
    }

    const privateErrorReader = createSyntheticRecordReader({
      onPlan: () => {
        throw new Error('Semantic check failed at /private/secret/path/project.json');
      },
    });
    try {
      await prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: privateErrorReader.reader,
      });
      throw new Error('Expected prepareJobRecordSource to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(JobError);
      const jobErr = error as JobError;
      expect(jobErr.code).toBe('JOB_RECORD_INCOMPLETE');
      expect(jobErr.message).not.toContain('/private/secret/path');
    }
  });

  test('[SYNTHETIC] enforces two-phase context equality and snapshot immutability', async () => {
    const workRoot = makeTempDir('review-561-phase-root-');
    const stateRoot = makeTempDir('review-561-phase-state-');
    const fixture = createSyntheticPlanRecordWorkspace(workRoot);
    const root = captureJobRoot(workRoot);

    const unequalPhaseReader = createSyntheticRecordReader({
      onPlan: input => {
        const clone = structuredClone(fixture.context);
        if (input.phase === 'retained') {
          return { ...clone, label: 'Different Retained Label' };
        }
        return clone;
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: unequalPhaseReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });
    expect(readdirSync(join(stateRoot, 'snapshots'))).toEqual([]);

    const unequalPartsPhaseReader = createSyntheticRecordReader({
      onPlan: input => {
        const clone = structuredClone(fixture.context);
        if (input.phase === 'retained') {
          return {
            ...clone,
            parts: { ...clone.parts, integrity: 'sha512-tampered-retained-parts' },
          };
        }
        return clone;
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: unequalPartsPhaseReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });
    expect(readdirSync(join(stateRoot, 'snapshots'))).toEqual([]);

    const mutatingReader = createSyntheticRecordReader({
      onPlan: input => {
        if (input.phase === 'retained') {
          writeFileSync(join(input.root, '.create-check.lock'), 'lock');
        }
        return structuredClone(fixture.context);
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: mutatingReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_UNRETAINABLE' });
    expect(readdirSync(join(stateRoot, 'snapshots'))).toEqual([]);
  });

  test('[SYNTHETIC] enforces mechanical root, record, closure, symlink, and structural project boundaries', async () => {
    const workRoot = makeTempDir('review-561-mech-root-');
    const stateRoot = makeTempDir('review-561-mech-state-');
    const fixture = createSyntheticOptionRecordWorkspace(workRoot);
    const root = captureJobRoot(workRoot);
    const { reader } = createSyntheticRecordReader({
      onOption: () => structuredClone(fixture.context),
    });

    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: null as unknown as typeof fixture.record },
          result: fixture.result,
        },
        readRecordPublished: reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_FREEZE_REQUIRED' });

    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: {
            kind: 'producer-held',
            holdId: 'hold_1',
            record: { path: 'project.json', sha256: 'f'.repeat(64) },
          },
          result: fixture.result,
        },
        readRecordPublished: reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_RECORD_MOVED' });

    const missingFileReader = createSyntheticRecordReader({
      onOption: () => {
        const extra = { path: 'inputs/missing.png', sha256: 'e'.repeat(64) };
        const files = [...fixture.files, extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { ...fixture.context, files };
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: missingFileReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_UNRETAINABLE' });

    const outsideTarget = join(makeTempDir('review-561-outside-'), 'secret.txt');
    writeFileSync(outsideTarget, 'secret');
    symlinkSync(outsideTarget, join(workRoot, 'inputs/escape-link.txt'));
    const symlinkReader = createSyntheticRecordReader({
      onOption: () => {
        const linkEntry = { path: 'inputs/escape-link.txt', sha256: jobHash(Buffer.from('secret')) };
        const files = [...fixture.files, linkEntry].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return { ...fixture.context, files };
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: symlinkReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_UNRETAINABLE' });
    rmSync(join(workRoot, 'inputs/escape-link.txt'));

    const wrongHashReader = createSyntheticRecordReader({
      onOption: () => {
        const files = fixture.files.map(file =>
          file.path === fixture.inputSpec.path ? { ...file, sha256: 'c'.repeat(64) } : file,
        );
        const inputs = fixture.context.inputs.map(file =>
          file.path === fixture.inputSpec.path ? { ...file, sha256: 'c'.repeat(64) } : file,
        );
        return { ...fixture.context, inputs, files };
      },
    });
    await expect(
      prepareJobRecordSource({
        root,
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: fixture.record },
          result: fixture.result,
        },
        readRecordPublished: wrongHashReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });

    // Structural plan step ID mismatch against retained project.json
    const planRoot = makeTempDir('review-561-plan-mismatch-');
    const planFixture = createSyntheticPlanRecordWorkspace(planRoot);
    const mismatchedPlanReader = createSyntheticRecordReader({
      onPlan: () => ({
        ...planFixture.context,
        plan: {
          steps: [
            { id: 'wrong_step_id', hash: '1'.repeat(64) },
            { id: 'step_weights', hash: '2'.repeat(64) },
          ],
        },
        subjects: [{ kind: 'checkpoint', checkpointId: 'wrong_step_id' }],
      }),
    });
    await expect(
      prepareJobRecordSource({
        root: captureJobRoot(planRoot),
        stateRoot,
        fingerprint: 'fp',
        request: {
          freeze: { kind: 'producer-held', holdId: 'hold_1', record: planFixture.record },
          result: planFixture.result,
        },
        readRecordPublished: mismatchedPlanReader.reader,
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });
  });

  test('[SYNTHETIC] verifyJobRecordSourceFresh re-evaluates both reader phases and maps ask vs finalize refusals', async () => {
    const workRoot = makeTempDir('review-561-fresh-root-');
    const stateRoot = makeTempDir('review-561-fresh-state-');
    const fixture = createSyntheticPlanRecordWorkspace(workRoot);
    let currentContext: PlanContext = structuredClone(fixture.context);
    let readerError: (Error & { code?: string }) | null = null;

    const { reader, calls } = createSyntheticRecordReader({
      onPlan: () => {
        if (readerError) throw readerError;
        return structuredClone(currentContext);
      },
    });

    const retained = await prepareJobRecordSource({
      root: captureJobRoot(workRoot),
      stateRoot,
      fingerprint: 'fp-fresh',
      request: {
        freeze: { kind: 'producer-held', holdId: 'hold_fresh', record: fixture.record },
        result: fixture.result,
      },
      readRecordPublished: reader,
    });
    expect(calls).toHaveLength(2);

    const freshAsk = await verifyJobRecordSourceFresh({
      retained,
      readRecordPublished: reader,
      phase: 'ask',
      subject: { kind: 'checkpoint', checkpointId: 'step_layout' },
    });
    expect(freshAsk).toEqual(retained.source);
    expect(calls).toHaveLength(4);

    const freshFinalize = await verifyJobRecordSourceFresh({
      retained,
      readRecordPublished: reader,
      phase: 'finalize',
      subject: { kind: 'signoff', stage: 'plan-approved' },
    });
    expect(freshFinalize).toEqual(retained.source);
    expect(calls).toHaveLength(6);
    expect(calls[2]!.parts).toBeUndefined();
    expect(calls[3]!.parts).toEqual(fixture.context.parts);
    expect(calls[4]!.parts).toBeUndefined();
    expect(calls[5]!.parts).toEqual(fixture.context.parts);

    // Subject no longer eligible at ask vs finalize
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
        subject: { kind: 'checkpoint', checkpointId: 'undeclared_step' },
      }),
    ).rejects.toMatchObject({ code: 'JOB_ASK_INVALID' });

    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
        subject: { kind: 'checkpoint', checkpointId: 'undeclared_step' },
      }),
    ).rejects.toMatchObject({ code: 'JOB_ACT_SOURCE_STALE' });

    // Reader throws JOB_RECORD_CLOSURE_INCOMPLETE at ask vs finalize
    readerError = Object.assign(new Error('Closure incomplete'), { code: 'JOB_RECORD_CLOSURE_INCOMPLETE' });
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
      }),
    ).rejects.toMatchObject({
      code: 'JOB_RECORD_INCOMPLETE',
      message: 'JOB_RECORD_CLOSURE_INCOMPLETE',
    });

    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
      }),
    ).rejects.toMatchObject({
      code: 'JOB_ACT_SOURCE_STALE',
      message: 'JOB_RECORD_CLOSURE_INCOMPLETE',
    });

    for (const partsToken of ['JOB_RECORD_PARTS_MISMATCH', 'JOB_RECORD_PARTS_LOCK_MISSING'] as const) {
      readerError = Object.assign(new Error(partsToken), { code: partsToken });
      await expect(
        verifyJobRecordSourceFresh({
          retained,
          readRecordPublished: reader,
          phase: 'ask',
        }),
      ).rejects.toMatchObject({
        code: 'JOB_RECORD_INCOMPLETE',
        message: partsToken,
      });
      await expect(
        verifyJobRecordSourceFresh({
          retained,
          readRecordPublished: reader,
          phase: 'finalize',
        }),
      ).rejects.toMatchObject({
        code: 'JOB_ACT_SOURCE_STALE',
        message: partsToken,
      });
    }

    // Reader throws semantic eligibility refusal at ask vs finalize
    readerError = new Error('Semantic eligibility expired');
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
      }),
    ).rejects.toMatchObject({ code: 'JOB_RECORD_INCOMPLETE' });

    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
      }),
    ).rejects.toMatchObject({ code: 'JOB_ACT_SOURCE_STALE' });
    readerError = null;

    // Context drift (e.g. opaque step hash changed) at ask vs finalize
    currentContext = {
      ...fixture.context,
      plan: {
        steps: [
          { id: 'step_layout', hash: '9'.repeat(64) },
          { id: 'step_weights', hash: '2'.repeat(64) },
        ],
      },
    };
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });

    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
      }),
    ).rejects.toMatchObject({ code: 'JOB_ACT_SOURCE_STALE' });
    currentContext = structuredClone(fixture.context);

    // Parts identity drift since publication at ask vs finalize refuses BEFORE invoking retained phase
    currentContext = {
      ...fixture.context,
      parts: { ...fixture.context.parts, version: '2.26.0' },
    };
    const callsBeforeDriftAsk = calls.length;
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'ask',
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });
    expect(calls.slice(callsBeforeDriftAsk).map(call => call.phase)).toEqual(['inventory']);

    const callsBeforeDriftFinalize = calls.length;
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
      }),
    ).rejects.toMatchObject({ code: 'JOB_ACT_SOURCE_STALE' });
    expect(calls.slice(callsBeforeDriftFinalize).map(call => call.phase)).toEqual(['inventory']);
    currentContext = structuredClone(fixture.context);

    // Original file byte modification detected by assertJobSourceCurrent
    writeWorkspaceFile(workRoot, 'inputs/spec.json', '{"character":"modified"}\n');
    await expect(
      verifyJobRecordSourceFresh({
        retained,
        readRecordPublished: reader,
        phase: 'finalize',
      }),
    ).rejects.toMatchObject({ code: 'JOB_SOURCE_MISMATCH' });
  });
});
