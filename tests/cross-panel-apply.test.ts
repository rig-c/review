import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  APPLIED_PATCH_PANELS,
  APPLIED_REGIONS_SCHEMA,
  describeAppliedRecord,
  dropNoticeForPanel,
  isAppliedOutcomeStatus,
  reconcilePanelStatuses,
  REBUILD_PANEL_KINDS,
  appliedPanelOps,
  itemApplied,
  type RebuildHandoffContext,
  type RebuildPanelKind,
} from '../src/applied-blocks.ts';
import {
  APPLIED_ANIMATION_SCHEMA,
  APPLIED_DELTA_SCHEMA,
  APPLIED_PATCH_SCHEMA,
  APPLIED_RETARGET_SCHEMA,
  parseAppliedContext,
} from '../src/applied-context.ts';
import { renderCompareHtml } from '../src/compare-html.ts';
import { loadCompare } from '../src/compare.ts';
import { startCompareServer } from '../src/compare-server.ts';
import { CONFIG_PATCH_SCHEMA, type ConfigPatch, type PatchOp } from '../src/config-patch.ts';
import { loadReview } from '../src/manifest.ts';
import { startServer } from '../src/server.ts';
import {
  animationAppliedRecord,
  animationOutcomeLine,
  patchAppliedRecord,
  patchOutcomeLine,
  recordFor,
  restoredOutcomeForJob,
  type AnimationJobView,
  type AppliedHistoryView,
  type PatchJobView,
  type RebuildStatusView,
  type UndoView,
} from '../web/rebuild-client.ts';

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const hex = (c: string) => c.repeat(64);

function treeSha256(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        hash.update(relative(dir, full).replace(/\\/g, '/'));
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

const handoffContext: RebuildHandoffContext = {
  constraints: [{ type: 'physics', name: 'hairback_r0_phys', bone: 'hair_b0', rotate: 1, strength: 100, damping: 0.85 }],
  bones: [{ name: 'hip', parent: 'root', at: [400, 420] }],
  fields: { regions: { hair_back: 'head' } },
  cuts: {
    config: {
      assemble: {
        cuts: [{ from: 'bottomwear', into: 'ribbon_r', polygon: [[368, 450], [393, 450], [389, 742], [364, 742]], overlap: 2 }],
      },
    },
  },
  idle: {
    tracks: [{ bone: 'chest', prop: 'rotate', amp: 1.2, period: 4, phase: 0 }],
    blink: { t: 1.5, eyes: ['eye_r', 'eye_l'], squash: 0.85 },
  },
  cloth: { recipes: { hair_back: { translate: 0.1 } } },
  meshes: { topwear: { mode: 'contour', spacing: 28 } },
};

function makePatchRecord(
  id: string,
  op: 'rig' | 'retune' | 'remesh' | 'build' | 'cloth',
  ops: PatchOp[],
  cmd: 'rig' | 'remesh' = op === 'remesh' ? 'remesh' : 'rig',
  args: string[] = op === 'remesh' ? ['--part', 'topwear'] : [],
) {
  const patch: ConfigPatch = {
    schema: CONFIG_PATCH_SCHEMA,
    config_sha256: hex('c'),
    ops,
    producer: { name: '@rig-c/parts', version: '2.0.0' },
    op: { cmd, args },
  };
  const job = {
    id,
    kind: 'patch',
    op,
    status: 'built',
    reused: false,
    lines: [],
    producerLine: 'ok',
    exitCode: 0,
    wallMs: { op: 1, compile: 1, check: 1 },
    check: { PASS: true, gate_spine_html_green: true },
    diff: null,
    build: { modelUrl: `/rebuild/${id}/skeleton.model.json`, modelHash: hex(id[0]!), files: {} },
    request: { patch, patchSha256: hex('d'), configHash: hex('c') },
    producer: { package: '@rig-c/parts', version: '2.0.0' },
    compiler: { package: '@rig-c/core', version: '3.0.0' },
  } as unknown as PatchJobView;
  return patchAppliedRecord(job);
}

const sampleRecords: Record<RebuildPanelKind, { record: unknown; part?: string; expectedSummary: string }> = {
  chest: {
    record: {
      schema: APPLIED_REGIONS_SCHEMA,
      buildId: hex('1'),
      part: 'topwear',
      regions: [{ name: 'bust_r', shape: 'circle', cx: 380, cy: 310, r: 24, bone: 'boob_r', spacing: 14, band: 16 }],
      configHash: hex('c'),
      entrySha256: hex('e'),
      producer: { package: '@rig-c/parts', version: '2.0.0' },
      compiler: { package: '@rig-c/core', version: '3.0.0' },
      line: 'remesh: ok',
      modelHash: hex('1'),
    },
    part: 'topwear',
    expectedSummary: 'Chest regions on topwear (bust_r)',
  },
  'mesh-edit': {
    record: {
      schema: APPLIED_DELTA_SCHEMA,
      buildId: hex('2'),
      op: 'remesh',
      part: 'topwear',
      delta: {
        schema: 'rig-review-mesh-edit/1',
        slot: 'topwear',
        skin: 'default',
        attachment: 'topwear',
        source: { vertexCount: 10, triangleCount: 8, hullLength: 6, hash: hex('a') },
        units: 'crop-px-y-down',
        basis: 'setup',
        preview: true,
        ops: [{ op: 'move', v: 0, from: [10, 20], to: [12, 22] }],
      },
      deltaSha256: hex('d'),
      configHash: hex('c'),
      producer: { package: '@rig-c/parts', version: '2.0.0' },
      compiler: { package: '@rig-c/core', version: '3.0.0' },
      line: 'remesh --delta: ok',
      files: null,
      remesh: null,
      modelHash: hex('2'),
    },
    part: 'topwear',
    expectedSummary: 'Edit mesh on topwear (1 op)',
  },
  mesh: {
    record: makePatchRecord('33', 'remesh', [{ op: 'replace', path: '/meshes/topwear/spacing', value: 20 }]),
    part: 'topwear',
    expectedSummary: 'Mesh topwear spacing 28 → 20',
  },
  bones: {
    record: makePatchRecord('44', 'rig', [{ op: 'replace', path: '/bones/0/at', value: [416, 424], name: 'hip' }]),
    expectedSummary: 'Bones hip at [400, 420] → [416, 424]',
  },
  'rig-fields': {
    record: makePatchRecord('55', 'rig', [{ op: 'replace', path: '/regions/hair_back', value: 'neck' }]),
    expectedSummary: 'Rig fields regions/hair_back "head" → "neck"',
  },
  cuts: {
    record: makePatchRecord('66', 'build', [{ op: 'replace', path: '/assemble/cuts/0/overlap', value: 4, name: 'ribbon_r' }]),
    expectedSummary: 'Cuts ribbon_r overlap 2 → 4',
  },
  cloth: {
    record: makePatchRecord('77', 'cloth', [{ op: 'replace', path: '/cloth/hair_back/translate', value: 0.25 }]),
    expectedSummary: 'Cloth hair_back translate 0.1 → 0.25',
  },
  physics: {
    record: makePatchRecord('88', 'retune', [{ op: 'replace', path: '/constraints/0/damping', value: 0.5, name: 'hairback_r0_phys' }]),
    expectedSummary: 'Physics damping 0.85 → 0.5',
  },
  idle: {
    record: makePatchRecord('99', 'rig', [{ op: 'replace', path: '/motion/tracks/0/amp', value: 2.5, name: 'chest' }]),
    expectedSummary: 'Idle chest amp 1.2 → 2.5',
  },
  retarget: {
    record: {
      schema: APPLIED_RETARGET_SCHEMA,
      buildId: hex('a'),
      retarget: {
        schema: 'rig-review-retarget/1',
        sequence: { reference: 'walk_pose', path: 'walk.pose.json', sha256: hex('b'), cleaned: true },
        map: { spec: 'rig-pose-map/1', chains: [], sha256: hex('e') },
        flags: { clean: false, animation: 'walk' },
        op: { clean: null, args: [] },
      },
      recordSha256: hex('f'),
      configHash: hex('c'),
      producer: { package: '@rig-c/pose', version: '1.0.0' },
      compiler: { package: '@rig-c/core', version: '3.0.0' },
      line: 'retarget: ok',
      motion: { animation: 'walk', duration: 2.0, tracks: 12, beforeAnimations: ['idle'], afterAnimations: ['idle', 'walk'] },
      files: null,
      readings: [],
      modelHash: hex('a'),
    },
    expectedSummary: 'Retarget walk from walk_pose',
  },
  animation: {
    record: {
      schema: APPLIED_ANIMATION_SCHEMA,
      buildId: hex('b'),
      op: 'rig',
      animationsFrom: { path: 'animations.json', sha256: hex('e'), editedSha256: hex('f') },
      ops: [{ op: 'set_key_value', animation: 'breath', bone: 'chest', property: 'rotate', keyIndex: 1, value: -18 }],
      opsSha256: hex('d'),
      args: [],
      configHash: hex('c'),
      producer: { package: '@rig-c/parts', version: '2.0.0' },
      compiler: { package: '@rig-c/core', version: '3.0.0' },
      line: 'rig: ok',
      check: { PASS: true, gate_spine_html_green: true },
      files: null,
      modelHash: hex('b'),
    },
    expectedSummary: 'Animation set_key_value breath chest',
  },
};

test('#250 condition 1: every panel kind shows a plain-words statement beside its Apply button before the click when another panel is applied, none on initial/same-panel second Apply, no modal, and refuses unknown records by name (with failing control)', () => {
  const indexHtml = readFileSync(join(import.meta.dir, '../web/index.html'), 'utf8');
  const compareTemplate = readFileSync(join(import.meta.dir, '../web/compare.html'), 'utf8');
  const compareHtml = renderCompareHtml(compareTemplate, indexHtml);
  const retargetSource = readFileSync(join(import.meta.dir, '../web/retarget-panel.ts'), 'utf8');
  const animSource = readFileSync(join(import.meta.dir, '../web/animation-inspection.ts'), 'utf8');
  const stylesSource = readFileSync(join(import.meta.dir, '../web/styles.css'), 'utf8');

  // Verify DOM placement: 9 static panels in index.html + compareHtml, plus retarget and animation panels, with zero new modals.
  const staticPanels: RebuildPanelKind[] = ['chest', 'mesh-edit', 'mesh', 'bones', 'rig-fields', 'cuts', 'cloth', 'physics', 'idle'];
  for (const panel of staticPanels) {
    expect(indexHtml).toContain(`data-rebuild-drop="${panel}"`);
    expect(compareHtml).toContain(`data-rebuild-drop="${panel}"`);
  }
  expect(retargetSource).toContain("setAttribute('data-rebuild-drop','retarget')");
  expect(animSource).toContain('data-rebuild-drop="animation"');
  // Animation drop notice sits on its own full-width line in .animation-dock-status and never uses ellipsis or max-width clipping.
  expect(stylesSource).not.toContain('.animation-editor-actions .rebuild-drop-notice');
  expect(stylesSource).toContain('.animation-dock-status>[data-rebuild-drop="animation"]');
  // Only the existing review-dialog modal is in index.html; no modal was added for rebuild drop warnings.
  expect([...indexHtml.matchAll(/<dialog\b/g)].length).toBe(1);

  // Full 11x11 matrix across all panel kinds.
  for (const [ownerKind, { record, part, expectedSummary }] of Object.entries(sampleRecords) as [
    RebuildPanelKind,
    (typeof sampleRecords)[RebuildPanelKind],
  ][]) {
    const described = describeAppliedRecord(record, handoffContext);
    expect(described).toEqual({
      panel: ownerKind,
      ...(part ? { part } : {}),
      summary: expectedSummary,
    });

    for (const targetPanel of REBUILD_PANEL_KINDS) {
      // Nothing applied: no statement.
      expect(dropNoticeForPanel(null, targetPanel, { part, handoff: handoffContext })).toBe('');
      const notice = dropNoticeForPanel(record, targetPanel, { part, handoff: handoffContext });
      if (targetPanel === ownerKind) {
        // A panel's own second Apply (on the same part for per-part panels): no statement.
        expect(notice).toBe('');
      } else {
        expect(notice).toBe(`This rebuild starts from the handoff and drops: ${expectedSummary}`);
      }
    }
  }

  // Per-part panel switching to a different part warns that the applied part's edit will be dropped.
  expect(dropNoticeForPanel(sampleRecords.mesh.record, 'mesh', { part: 'hair_back', handoff: handoffContext })).toBe(
    'This rebuild starts from the handoff and drops: Mesh topwear spacing 28 → 20',
  );

  // Refusal by name when a statement cannot be derived.
  expect(() => describeAppliedRecord({ schema: 'rig-review-applied/99' })).toThrow(/APPLIED_DROP_STATEMENT_UNAVAILABLE/);
  expect(() => describeAppliedRecord({ schema: APPLIED_PATCH_SCHEMA, patch: { ops: [] } })).toThrow(
    /APPLIED_DROP_STATEMENT_UNAVAILABLE/,
  );
  expect(() =>
    describeAppliedRecord(makePatchRecord('bad', 'rig', [{ op: 'replace', path: '/unknown/0', value: 1 }])),
  ).toThrow(/APPLIED_DROP_STATEMENT_UNAVAILABLE/);
  expect(() => dropNoticeForPanel(sampleRecords.physics.record, 'unknown-panel' as RebuildPanelKind)).toThrow(
    /APPLIED_DROP_STATEMENT_UNAVAILABLE/,
  );

  // Control that fails first (planted mutant: silent fallback on unknown record or missing cross-panel notice).
  const checkCondition1Gate = (
    noticeFn: typeof dropNoticeForPanel,
  ): { ok: boolean; reason?: string } => {
    const cross = noticeFn(sampleRecords.physics.record, 'bones', { handoff: handoffContext });
    if (cross !== 'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5') {
      return { ok: false, reason: `expected cross-panel notice, got ${JSON.stringify(cross)}` };
    }
    const self = noticeFn(sampleRecords.physics.record, 'physics', { handoff: handoffContext });
    if (self !== '') return { ok: false, reason: `expected empty self-notice, got ${JSON.stringify(self)}` };
    try {
      noticeFn({ schema: 'rig-review-applied/unknown' }, 'bones');
      return { ok: false, reason: 'silent on unparseable stage record' };
    } catch (e) {
      if (!String(e).includes('APPLIED_DROP_STATEMENT_UNAVAILABLE')) {
        return { ok: false, reason: `wrong refusal code: ${String(e)}` };
      }
    }
    return { ok: true };
  };
  // Planted mutant 1: pre-#250 behavior (no drop notice).
  expect(checkCondition1Gate(() => '')).toEqual({
    ok: false,
    reason: 'expected cross-panel notice, got ""',
  });
  // Planted mutant 2: warns even on a panel's own second Apply.
  expect(
    checkCondition1Gate((rec, _panel, opts) => {
      const d = describeAppliedRecord(rec, opts?.handoff);
      return d ? `This rebuild starts from the handoff and drops: ${d.summary}` : '';
    }),
  ).toEqual({
    ok: false,
    reason: 'expected empty self-notice, got "This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5"',
  });
  // Real implementation passes.
  expect(checkCondition1Gate(dropNoticeForPanel)).toEqual({ ok: true });
});

test('#250 condition 2: after a second panel applies, the superseded panel stops reading as applied and keeps its edits in the panel for re-Apply (with failing control)', () => {
  // Pending edits held in each patch panel's in-memory edit map.
  const pendingByPanel: Record<
    (typeof APPLIED_PATCH_PANELS)[number],
    PatchOp[]
  > = {
    physics: [{ op: 'replace', path: '/constraints/0/damping', value: 0.5, name: 'hairback_r0_phys' }],
    bones: [{ op: 'replace', path: '/bones/0/at', value: [416, 424], name: 'hip' }],
    idle: [{ op: 'replace', path: '/motion/tracks/0/amp', value: 2.5, name: 'chest' }],
    'rig-fields': [{ op: 'replace', path: '/regions/hair_back', value: 'neck' }],
    cuts: [{ op: 'replace', path: '/assemble/cuts/0/overlap', value: 4, name: 'ribbon_r' }],
    cloth: [{ op: 'replace', path: '/cloth/hair_back/translate', value: 0.25 }],
  };

  // Simulate panel state: each panel holds `edits` (its user edits) and `appliedOps` (what the stage build applied).
  const createPanels = () => {
    const state = {} as Record<
      (typeof APPLIED_PATCH_PANELS)[number],
      { edits: PatchOp[]; appliedOps: PatchOp[]; isMarkedApplied: () => boolean }
    >;
    for (const panel of APPLIED_PATCH_PANELS) {
      const entry = {
        edits: pendingByPanel[panel].map(o => ({ ...o })),
        appliedOps: [] as PatchOp[],
        isMarkedApplied: (): boolean => itemApplied(entry.edits, entry.appliedOps),
      };
      state[panel] = entry;
    }
    return state;
  };

  // Control that fails first: pre-#250 renderAppliedBlocks only updated `cuts` and `cloth`, leaving `physics` marked
  // ` · applied` even after `bones` or `animation` superseded the stage build.
  const verifySupersededReconcile = (
    reconcile: (panels: ReturnType<typeof createPanels>, stageRecord: unknown) => void,
  ): { ok: boolean; reason?: string } => {
    const panels = createPanels();
    // 1. Physics applies first.
    panels.physics.appliedOps = [...pendingByPanel.physics];
    reconcile(panels, sampleRecords.physics.record);
    if (!panels.physics.isMarkedApplied()) return { ok: false, reason: 'physics not marked applied after its own Apply' };
    // 2. Bones applies second, superseding Physics.
    panels.bones.appliedOps = [...pendingByPanel.bones];
    reconcile(panels, sampleRecords.bones.record);
    if (panels.physics.isMarkedApplied()) {
      return { ok: false, reason: 'superseded physics panel still reads as applied after bones Apply' };
    }
    if (panels.physics.edits.length !== 1 || panels.physics.edits[0]!.value !== 0.5) {
      return { ok: false, reason: 'superseded physics panel lost its pending edits' };
    }
    if (!panels.bones.isMarkedApplied()) {
      return { ok: false, reason: 'bones panel not marked applied after its own Apply' };
    }
    return { ok: true };
  };

  // Pre-#250 control (only cuts and cloth reconciled from stage): fails because physics stays marked applied!
  expect(
    verifySupersededReconcile((panels, stageRecord) => {
      const on = appliedPanelOps(stageRecord);
      panels.cuts.appliedOps = on.cuts;
      panels.cloth.appliedOps = on.cloth;
    }),
  ).toEqual({
    ok: false,
    reason: 'superseded physics panel still reads as applied after bones Apply',
  });

  // Real #250 reconciliation: updates all 6 patch panels while keeping `edits` intact in every superseded panel.
  expect(
    verifySupersededReconcile((panels, stageRecord) => {
      const on = appliedPanelOps(stageRecord);
      for (const p of APPLIED_PATCH_PANELS) panels[p].appliedOps = on[p];
    }),
  ).toEqual({ ok: true });

  // Verify every pair across all 6 patch panels + animation / retarget / mesh / chest / mesh-edit records.
  const allPanels = createPanels();
  for (const [ownerKind, { record }] of Object.entries(sampleRecords) as [
    RebuildPanelKind,
    (typeof sampleRecords)[RebuildPanelKind],
  ][]) {
    const on = appliedPanelOps(record);
    for (const p of APPLIED_PATCH_PANELS) {
      allPanels[p].appliedOps = on[p];
      expect(allPanels[p].isMarkedApplied()).toBe(p === ownerKind);
      // Pending edits in the panel are never wiped by another panel's Apply.
      expect(allPanels[p].edits).toEqual(pendingByPanel[p]);
    }
  }

  // Every panel's applied-build status line across all 11 panels: cleared when superseded, restored when Undo returns
  // to that panel's build, while non-applied status text (preview notes, pre-checks, errors) is untouched.
  const sampleAppliedOutcomes: Record<RebuildPanelKind, string> = {
    chest: 'Applied topwear with @rig-c/parts 2.0.0 · remesh 0.1 s + compile 0.1 s · Reset returns to the inspected build',
    'mesh-edit':
      'Applied mesh edit 222222222222… (1 op(s) on topwear) with @rig-c/parts 2.0.0 · remesh --delta 0.1 s + compile 0.1 s · no diff · Reset returns to the inspected build',
    mesh: 'Remeshed topwear: v 40 · t 60 → v 42 · t 64 (remesh.json) · Reset returns to the inspected build',
    bones:
      'Applied patch 444444444444… (1 op(s)) with @rig-c/parts 2.0.0 · rig 0.1 s + compile 0.1 s + check 0.1 s · check PASS · Reset returns to the inspected build',
    'rig-fields':
      'Applied patch 555555555555… (1 op(s)) with @rig-c/parts 2.0.0 · rig 0.1 s + compile 0.1 s + check 0.1 s · check PASS · Reset returns to the inspected build',
    cuts: 'Applied patch 666666666666… (1 op(s)) with @rig-c/parts 2.0.0 · build 0.2 s (assemble → rig → check) + compile 0.1 s · check PASS · Reset returns to the inspected build',
    cloth:
      'Applied patch 777777777777… (1 op(s)) with @rig-c/parts 2.0.0 · propose 0.1 s + rig 0.1 s + compile 0.1 s + check 0.1 s · check PASS · Reset returns to the inspected build',
    physics:
      'Applied patch b211f66de47c… (1 op(s)) with @rig-c/parts 2.0.0 · retune 0.0 s + compile 0.0 s + check 0.0 s · check PASS · rig.json Δ1 · Reset returns to the inspected build',
    idle: 'Applied patch 999999999999… (1 op(s)) with @rig-c/parts 2.0.0 · rig 0.1 s + compile 0.1 s + check 0.1 s · check PASS · Reset returns to the inspected build',
    retarget:
      'Retargeted "walk" from walk_pose with @rig-c/pose 1.0.0 · retarget 0.1 s + compile 0.1 s · the rig\'s own animations unchanged · no diff · Reset returns to the inspected build',
    animation:
      'Applied dddddddddddd… (1 op(s) on breath) with @rig-c/parts 2.0.0 · rig 0.1 s + compile 0.1 s + check 0.1 s · check PASS · motion.json Δ1',
  };

  for (const panel of REBUILD_PANEL_KINDS) {
    expect(isAppliedOutcomeStatus(panel, sampleAppliedOutcomes[panel])).toBe(true);
    expect(isAppliedOutcomeStatus(panel, '')).toBe(false);
    expect(isAppliedOutcomeStatus(panel, 'REBUILD_FAILED: exit 1')).toBe(false);
  }
  // Animation local preview note starts with "Applied " but is NOT a scratch-build outcome line.
  expect(
    isAppliedOutcomeStatus('animation', 'Applied set_key_value on idle track 0 (1 pending op(s), preview active).'),
  ).toBe(false);

  // Failing control for status-line reconciliation:
  // Mutant A leaves the superseded panel's "Applied patch …" status line in place when another panel's build lands.
  // Mutant B clears the superseded panel's status line on the second Apply, but fails to restore it on Undo.
  const verifyStatusLineGate = (
    reconcileFn: typeof reconcilePanelStatuses,
  ): { ok: boolean; reason?: string } => {
    for (const firstPanel of REBUILD_PANEL_KINDS) {
      for (const secondPanel of REBUILD_PANEL_KINDS) {
        if (firstPanel === secondPanel) continue;
        // Step 1: `firstPanel` applies; its status line holds its applied outcome.
        let statuses: Record<RebuildPanelKind, string> = {} as Record<RebuildPanelKind, string>;
        for (const p of REBUILD_PANEL_KINDS) statuses[p] = p === firstPanel ? sampleAppliedOutcomes[p] : '';
        statuses = reconcileFn(statuses, sampleRecords[firstPanel].record, null);
        if (statuses[firstPanel] !== sampleAppliedOutcomes[firstPanel]) {
          return { ok: false, reason: `${firstPanel} lost its own status line right after its Apply` };
        }
        // Step 2: `secondPanel` applies, superseding `firstPanel`.
        statuses[secondPanel] = sampleAppliedOutcomes[secondPanel];
        statuses = reconcileFn(statuses, sampleRecords[secondPanel].record, null);
        if (statuses[firstPanel] !== '') {
          return {
            ok: false,
            reason: `superseded ${firstPanel} kept applied status line after ${secondPanel} Apply: ${JSON.stringify(statuses[firstPanel])}`,
          };
        }
        if (statuses[secondPanel] !== sampleAppliedOutcomes[secondPanel]) {
          return { ok: false, reason: `${secondPanel} lost its own status line on Apply` };
        }
        // Step 3: Undo returns the stage to `firstPanel`'s build (`restored` outcome supplied).
        statuses = reconcileFn(statuses, sampleRecords[firstPanel].record, {
          panel: firstPanel,
          ...(sampleRecords[firstPanel].part ? { part: sampleRecords[firstPanel].part } : {}),
          text: sampleAppliedOutcomes[firstPanel],
        });
        if (statuses[firstPanel] !== sampleAppliedOutcomes[firstPanel]) {
          return {
            ok: false,
            reason: `${firstPanel} status line was not restored on Undo: got ${JSON.stringify(statuses[firstPanel])}`,
          };
        }
        if (statuses[secondPanel] !== '') {
          return {
            ok: false,
            reason: `undone ${secondPanel} kept applied status line after Undo: ${JSON.stringify(statuses[secondPanel])}`,
          };
        }
      }
    }
    return { ok: true };
  };

  // Control 1 (pre-fix bug caught on superseded-panel-keeps-edits-1440x900.png): leaves status lines untouched.
  expect(
    verifyStatusLineGate(current => {
      const out = {} as Record<RebuildPanelKind, string>;
      for (const p of REBUILD_PANEL_KINDS) {
        const v = current[p];
        out[p] = typeof v === 'string' ? v : (v?.text ?? '');
      }
      return out;
    }),
  ).toEqual({
    ok: false,
    reason: `superseded chest kept applied status line after mesh-edit Apply: ${JSON.stringify(sampleAppliedOutcomes.chest)}`,
  });

  // Control 2: clears superseded status lines, but forgets to restore the earlier panel's status line on Undo.
  expect(
    verifyStatusLineGate((current, record) => reconcilePanelStatuses(current, record, null)),
  ).toEqual({
    ok: false,
    reason: 'chest status line was not restored on Undo: got ""',
  });

  // Real implementation passes across all 11x10 ordered panel pairs.
  expect(verifyStatusLineGate(reconcilePanelStatuses)).toEqual({ ok: true });

  // Non-applied status text (e.g., Animation's local preview line or a pre-check refusal) is preserved when another panel applies.
  const withPreviewAndRefusal = reconcilePanelStatuses(
    {
      physics: sampleAppliedOutcomes.physics,
      animation: 'Applied set_key_value on idle track 0 (1 pending op(s), preview active).',
      mesh: 'CONFIG_MESH_SPACING: spacing must be >= 4 (review pre-check; nothing sent)',
    },
    sampleRecords.bones.record,
    null,
  );
  expect(withPreviewAndRefusal.physics).toBe('');
  expect(withPreviewAndRefusal.animation).toBe(
    'Applied set_key_value on idle track 0 (1 pending op(s), preview active).',
  );
  expect(withPreviewAndRefusal.mesh).toBe('CONFIG_MESH_SPACING: spacing must be >= 4 (review pre-check; nothing sent)');
});

/**
 * Stand-in `@rig-c/parts@2.0.0` + `@rig-c/core@3.0.0` that faithfully implements:
 * - `rig --config <cfg>`: reads `cfg.bones`, `cfg.constraints` and `cfg.motion.animations_from` from the config and
 *   writes `out/rig.json` and `out/motion.json`.
 * - `retune --rig <handoff-rig> --config <cfg>`: copies `<handoff-rig>` (`bones` and `motion.json` from the handoff)
 *   and updates only `constraints` in `out/rig.json` from `<cfg>`, matching `@rig-c/parts@2.0.0`.
 * - `check --rig <rig> --out <out>`: writes passing `check.json`.
 */
const STANDIN_PARTS = `const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
const f = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
if (a[0] === '--version') { console.log('2.0.0'); process.exit(0); }
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
};
if (a[0] === 'check') {
  const out = f('--out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'check.json'), JSON.stringify({
    PASS: true,
    gate_spine_html_green: true,
    ANIMATIONS_DO_NOT_FOLD: { status: 'PASS', worst: 0 },
    TEXTURE_STRETCH: { status: 'PASS', worst: 1.01 }
  }));
  console.log('check: PASS (2 of 2 bar(s) met)');
  process.exit(0);
}
if (a[0] === 'retune') {
  const rigIn = f('--rig'), cfgPath = f('--config'), out = f('--out');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  copyDir(rigIn, out);
  const rigDoc = JSON.parse(fs.readFileSync(path.join(out, 'rig.json'), 'utf8'));
  rigDoc.constraints = cfg.constraints;
  fs.writeFileSync(path.join(out, 'rig.json'), JSON.stringify(rigDoc, null, 1) + '\\n');
  console.log('rig-parts retune: wrote ' + out);
  process.exit(0);
}
if (a[0] === 'rig') {
  const cfgPath = f('--config'), partsDir = f('--parts'), out = f('--out');
  const cfgDir = path.dirname(path.resolve(cfgPath));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (partsDir && fs.existsSync(path.join(partsDir, 'rig'))) copyDir(path.join(partsDir, 'rig'), out);
  else fs.mkdirSync(out, { recursive: true });
  const bones = (cfg.bones || []).map(b => ({
    name: b.name,
    ...(b.parent ? { parent: b.parent } : {}),
    x: Array.isArray(b.at) ? b.at[0] - 400 : 0,
    y: Array.isArray(b.at) ? 750 - b.at[1] : 0,
    at: b.at,
    rotation: 0,
    scaleX: 1,
    scaleY: 1
  }));
  const rigDoc = {
    spec: 'rigc-rig/1',
    bones: [{ name: 'root', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, ...bones],
    constraints: cfg.constraints || [],
    slots: [],
    skins: { default: {} }
  };
  fs.writeFileSync(path.join(out, 'rig.json'), JSON.stringify(rigDoc, null, 1) + '\\n');
  if (cfg.motion && cfg.motion.animations_from) {
    const animPath = path.resolve(cfgDir, cfg.motion.animations_from);
    const animDoc = JSON.parse(fs.readFileSync(animPath, 'utf8'));
    fs.writeFileSync(path.join(out, 'motion.json'), JSON.stringify(animDoc, null, 1) + '\\n');
  }
  fs.writeFileSync(path.join(out, 'mesh_report.json'), JSON.stringify({ spec: 'rig-parts-mesh-report/1', parts: {} }, null, 1) + '\\n');
  fs.writeFileSync(path.join(out, 'sets.json'), JSON.stringify({ sets: [{ name: 'base' }] }, null, 1) + '\\n');
  fs.mkdirSync(path.join(out, 'images'), { recursive: true });
  fs.writeFileSync(path.join(out, 'images', 'chest.png'), 'png-chest');
  console.log('rig-parts rig: wrote ' + out);
  process.exit(0);
}
process.exit(2);
`;

const STANDIN_RIGC = `const fs = require('fs'), path = require('path'), crypto = require('crypto');
const a = process.argv.slice(2);
const f = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
if (a[0] === '--version') { console.log('3.0.0'); process.exit(0); }
const out = f('--out'), rigPath = f('--rig');
const rigDir = path.dirname(path.resolve(rigPath));
const rigBytes = fs.readFileSync(rigPath);
const motionPath = path.join(rigDir, 'motion.json');
const motionBytes = fs.existsSync(motionPath) ? fs.readFileSync(motionPath) : Buffer.from('{}');
const digest = crypto.createHash('sha256').update(rigBytes).update(motionBytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'skeleton.model.json'), JSON.stringify({
  spec: 'rigc-compiled/3',
  stage: { x: -400, y: 0, width: 800, height: 750 },
  bones: [{ name: 'root', x: 0, y: 0 }, { name: 'hip', parent: 'root', x: 0, y: 330 }, { name: 'chest', parent: 'hip', x: 0, y: 20 }],
  slots: [],
  skins: [{ name: 'default', attachments: {} }],
  animations: [{ name: 'idle', duration: 2, bones: [], slots: [] }, { name: 'breath', duration: 2, bones: [], slots: [] }],
  pages: [{ name: 'skeleton.png' }],
  rigSha256: digest
}));
fs.writeFileSync(path.join(out, 'skeleton.png'), 'png-' + digest.slice(0, 16));
console.log('rigc build: wrote ' + out);
process.exit(0);
`;

function createHermeticWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'review-250-'));
  mkdirSync(join(root, 'node_modules/@rig-c/parts/bin'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@rig-c/core/bin'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules/@rig-c/parts/package.json'),
    JSON.stringify({ name: '@rig-c/parts', version: '2.0.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }),
  );
  writeFileSync(join(root, 'node_modules/@rig-c/parts/bin/rig-parts.cjs'), STANDIN_PARTS);
  writeFileSync(
    join(root, 'node_modules/@rig-c/core/package.json'),
    JSON.stringify({ name: '@rig-c/core', version: '3.0.0', bin: { rigc: './bin/rigc.cjs' } }),
  );
  writeFileSync(join(root, 'node_modules/@rig-c/core/bin/rigc.cjs'), STANDIN_RIGC);

  const makePackage = (name: string) => {
    const pkg = join(root, name);
    const rigDir = join(pkg, 'rig/out/rig');
    mkdirSync(join(rigDir, 'images'), { recursive: true });
    mkdirSync(join(pkg, 'rig/out/parts'), { recursive: true });
    const animationsDoc = {
      spec: 'rigc-motion/1',
      animations: {
        idle: {
          duration: 2,
          loop: true,
          tracks: [
            {
              bone: 'chest',
              property: 'rotate',
              keys: [
                { t: 0, v: [0] },
                { t: 1, v: [2] },
                { t: 2, v: [0] },
              ],
            },
          ],
        },
        breath: {
          duration: 2,
          loop: true,
          tracks: [
            {
              bone: 'chest',
              property: 'rotate',
              keys: [
                { t: 0, v: [0] },
                { t: 1, v: [-1.8] },
                { t: 2, v: [0] },
              ],
            },
          ],
        },
      },
    };
    const cfg = {
      bones: [
        { name: 'hip', parent: 'root', at: [400, 420] },
        { name: 'chest', parent: 'hip', at: [400, 340] },
      ],
      constraints: [
        { type: 'physics', name: 'hairback_r0_phys', bone: 'chest', rotate: 1, strength: 100, damping: 0.85 },
      ],
      motion: {
        duration: 2,
        animations_from: 'animations.json',
        tracks: [{ bone: 'chest', prop: 'rotate', amp: 2, period: 2, phase: 0 }],
      },
    };
    writeFileSync(join(pkg, 'rig/animations.json'), JSON.stringify(animationsDoc, null, 1) + '\n');
    writeFileSync(join(pkg, 'rig/config.json'), JSON.stringify(cfg, null, 1) + '\n');
    writeFileSync(join(pkg, 'rig/out/parts.json'), '{}\n');

    // Run stand-in `rig` and `rigc` once to populate the inspected build identically to the baseline.
    const proc1 = Bun.spawnSync([
      process.execPath,
      join(root, 'node_modules/@rig-c/parts/bin/rig-parts.cjs'),
      'rig',
      '--config',
      join(pkg, 'rig/config.json'),
      '--parts',
      join(pkg, 'rig/out'),
      '--out',
      rigDir,
    ]);
    if (proc1.exitCode !== 0) throw new Error(proc1.stderr.toString() || proc1.stdout.toString());
    const proc2 = Bun.spawnSync([
      process.execPath,
      join(root, 'node_modules/@rig-c/core/bin/rigc.cjs'),
      'build',
      '--rig',
      join(rigDir, 'rig.json'),
      '--out',
      pkg,
    ]);
    if (proc2.exitCode !== 0) throw new Error(proc2.stderr.toString() || proc2.stdout.toString());
    writeFileSync(join(pkg, 'motion.json'), readFileSync(join(rigDir, 'motion.json')));
    return pkg;
  };

  return { root, state: join(root, 'state'), makePackage };
}

async function waitBaseline(base: string, prefix = '/api/rebuild'): Promise<RebuildStatusView> {
  for (let i = 0; i < 200; i++) {
    const status = (await (await fetch(base + prefix)).json()) as RebuildStatusView;
    if (status.baseline && status.baseline.status !== 'running') return status;
    await Bun.sleep(25);
  }
  throw new Error('baseline did not settle');
}

async function settleJob<T extends { id: string; status: string }>(
  base: string,
  job: T,
  prefix = '/api/rebuild',
): Promise<T> {
  let current = job;
  for (let i = 0; current.status === 'running' && i < 200; i++) {
    await Bun.sleep(25);
    current = (await (await fetch(`${base}${prefix}/${current.id}`)).json()) as T;
  }
  return current;
}

test('#250 conditions 3 and 4: both measured orders (Physics ↔ Bones and Physics ↔ Animation), exported feedback record + built rig/motion values in the same test, Undo (#166) across Applies, package immutability, and Compare mode per side (with failing controls)', async () => {
  const { root, state, makePackage } = createHermeticWorkspace();
  const pkgA = makePackage('pkg-a');
  const pkgB = makePackage('pkg-b');
  const refVideo = join(root, 'ref.mp4');
  writeFileSync(refVideo, 'fake-mp4-reference-bytes');

  const beforeHashA = treeSha256(pkgA);
  const beforeHashB = treeSha256(pkgB);

  const loadedSingle = await loadReview(pkgA);
  const singleServer = await startServer(loadedSingle, { port: 0, stateDir: state, cwd: root });
  const singleBase = `http://127.0.0.1:${singleServer.port}`;

  try {
    const status = await waitBaseline(singleBase);
    expect(status.baseline?.status).toBe('reproduced');
    const configHash = status.inputs!.configHash;
    const animHash = status.animations!.sha256!;

    const post = (path: string, body: unknown) =>
      fetch(singleBase + path, {
        method: 'POST',
        headers: { Origin: singleBase, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const physicsOp: PatchOp = {
      op: 'replace',
      path: '/constraints/0/damping',
      value: 0.5,
      name: 'hairback_r0_phys',
    };
    const bonesOp: PatchOp = {
      op: 'replace',
      path: '/bones/0/at',
      value: [416, 424],
      name: 'hip',
    };
    const animOp = {
      op: 'set_key_value' as const,
      animation: 'breath',
      track: 0,
      key: 1,
      value: [-18],
    };

    const runPatch = async (op: PatchOp) => {
      const patch: ConfigPatch = {
        schema: CONFIG_PATCH_SCHEMA,
        config_sha256: configHash,
        ops: [op],
        producer: { name: '@rig-c/parts', version: '2.0.0' },
        op: { cmd: 'rig', args: [] },
      };
      const started = (await (await post('/api/rebuild', { patch })).json()) as PatchJobView;
      const settled = await settleJob(singleBase, started);
      expect(settled.status).toBe('built');
      return settled;
    };

    const runAnim = async () => {
      const started = (await (
        await post('/api/rebuild', {
          animation: { configHash, animationsFromHash: animHash, ops: [animOp] },
        })
      ).json()) as AnimationJobView;
      const settled = await settleJob(singleBase, started);
      expect(settled.status).toBe('built');
      return settled;
    };

    const readScratchRig = (jobId: string, sourceHash = loadedSingle.sourceHash) => {
      const scratchRigDir = join(state, 'rebuild', sourceHash, jobId, 'rig');
      const rigJson = JSON.parse(readFileSync(join(scratchRigDir, 'rig.json'), 'utf8')) as {
        bones: { name: string; x: number; y: number; at?: [number, number] }[];
        constraints: { name: string; damping: number }[];
      };
      const motionJson = JSON.parse(readFileSync(join(scratchRigDir, 'motion.json'), 'utf8')) as {
        animations: { breath: { tracks: { keys: { t: number; v: number[] }[] }[] } };
      };
      return {
        damping: rigJson.constraints.find(c => c.name === 'hairback_r0_phys')!.damping,
        hip: rigJson.bones.find(b => b.name === 'hip')!,
        breathKey1: motionJson.animations.breath.tracks[0]!.keys[1]!.v[0]!,
      };
    };

    // Validator that checks whether `context.applied` truthfully matches the built scratch rig on stage.
    const assertRecordMatchesBuiltRig = (
      appliedRecord: unknown,
      built: ReturnType<typeof readScratchRig>,
    ): { ok: boolean; reason?: string } => {
      parseAppliedContext(appliedRecord);
      const rec = appliedRecord as
        | { schema: typeof APPLIED_PATCH_SCHEMA; patch: ConfigPatch }
        | { schema: typeof APPLIED_ANIMATION_SCHEMA; ops: { animation: string; value?: unknown }[] };
      const claimsPhysics =
        rec.schema === APPLIED_PATCH_SCHEMA &&
        rec.patch.ops.some(o => o.path === '/constraints/0/damping' && o.value === 0.5);
      const claimsBones =
        rec.schema === APPLIED_PATCH_SCHEMA &&
        rec.patch.ops.some(o => o.path === '/bones/0/at' && JSON.stringify(o.value) === '[416,424]');
      const claimsAnim =
        rec.schema === APPLIED_ANIMATION_SCHEMA &&
        rec.ops.some(o => o.animation === 'breath' && 'value' in o && JSON.stringify(o.value) === '[-18]');

      if (claimsPhysics !== (built.damping === 0.5)) {
        return { ok: false, reason: `record claims physics=${claimsPhysics}, but built damping=${built.damping}` };
      }
      if (claimsBones !== (built.hip.x === 16 && built.hip.y === 326)) {
        return { ok: false, reason: `record claims bones=${claimsBones}, but built hip=(${built.hip.x},${built.hip.y})` };
      }
      if (claimsAnim !== (built.breathKey1 === -18)) {
        return { ok: false, reason: `record claims anim=${claimsAnim}, but built breathKey1=${built.breathKey1}` };
      }
      return { ok: true };
    };

    const saveAndReadSessionApplied = async (fbId: string, applied: unknown) => {
      const sessionDoc = (await (await fetch(singleBase + '/api/session')).json()) as {
        status: string;
        sourceHash: string;
        reviewedSource: unknown;
        checkpoints: Record<string, unknown>;
        feedback: unknown[];
      };
      sessionDoc.feedback = [
        {
          id: fbId,
          frameStart: 0,
          frameEnd: 1,
          target: { kind: 'bone', name: 'chest' },
          category: 'quality',
          summary: `Stage record ${fbId}`,
          context: {
            animation: 'idle',
            interval: { frameStart: 0, frameEnd: 1, inclusive: true },
            applied,
          },
        },
      ];
      const saveRes = await fetch(singleBase + '/api/session', {
        method: 'PUT',
        headers: { Origin: singleBase, 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionDoc),
      });
      expect(saveRes.status).toBe(200);
      const reloaded = (await (await fetch(singleBase + '/api/session')).json()) as {
        feedback: { context: { applied: unknown } }[];
      };
      return reloaded.feedback[0]!.context.applied;
    };

    // ---- Pair A Order 1: Physics Apply -> Bones Apply ---------------------------------------------------------------
    const physJob1 = await runPatch(physicsOp);
    const physRec1 = patchAppliedRecord(physJob1);
    const builtAfterPhys1 = readScratchRig(physJob1.id);
    expect(builtAfterPhys1).toEqual({
      damping: 0.5,
      hip: expect.objectContaining({ name: 'hip', x: 0, y: 330 }),
      breathKey1: -1.8,
    });
    expect(assertRecordMatchesBuiltRig(await saveAndReadSessionApplied('fb-phys-1', physRec1), builtAfterPhys1)).toEqual({
      ok: true,
    });
    // Before clicking Bones Apply, Bones shows the drop notice for Physics.
    expect(dropNoticeForPanel(physRec1, 'bones', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5',
    );

    const bonesJob1 = await runPatch(bonesOp);
    const bonesRec1 = patchAppliedRecord(bonesJob1);
    const builtAfterBones1 = readScratchRig(bonesJob1.id);
    // Built rig after Bones Apply has hip=(16,326), and Physics damping reverted to handoff 0.85!
    expect(builtAfterBones1).toEqual({
      damping: 0.85,
      hip: expect.objectContaining({ name: 'hip', x: 16, y: 326 }),
      breathKey1: -1.8,
    });
    const exportedBones1 = await saveAndReadSessionApplied('fb-bones-1', bonesRec1);
    expect(assertRecordMatchesBuiltRig(exportedBones1, builtAfterBones1)).toEqual({ ok: true });

    // Control for Condition 3: a record that falsely accumulates the dropped Physics edit onto the Bones build fails!
    const falseMergedRecord = {
      ...bonesRec1,
      patch: { ...bonesRec1.patch, ops: [physicsOp, bonesOp] },
    };
    expect(assertRecordMatchesBuiltRig(falseMergedRecord, builtAfterBones1)).toEqual({
      ok: false,
      reason: 'record claims physics=true, but built damping=0.85',
    });

    // ---- Pair A Order 2: Bones Apply -> Physics Apply ---------------------------------------------------------------
    // Before clicking Physics Apply while Bones is on stage, Physics shows the drop notice for Bones.
    expect(dropNoticeForPanel(bonesRec1, 'physics', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Bones hip at [400, 420] → [416, 424]',
    );
    const physJob2 = await runPatch(physicsOp);
    const physRec2 = patchAppliedRecord(physJob2);
    const builtAfterPhys2 = readScratchRig(physJob2.id);
    // Built rig after Physics Apply has damping=0.5, and hip reverted to handoff (0,330)!
    expect(builtAfterPhys2).toEqual({
      damping: 0.5,
      hip: expect.objectContaining({ name: 'hip', x: 0, y: 330 }),
      breathKey1: -1.8,
    });
    const exportedPhys2 = await saveAndReadSessionApplied('fb-phys-2', physRec2);
    expect(assertRecordMatchesBuiltRig(exportedPhys2, builtAfterPhys2)).toEqual({ ok: true });

    // ---- Pair B Order 1: Physics Apply -> Animation Apply -----------------------------------------------------------
    expect(dropNoticeForPanel(physRec2, 'animation', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5',
    );
    const animJob1 = await runAnim();
    const animRec1 = animationAppliedRecord(animJob1);
    const builtAfterAnim1 = readScratchRig(animJob1.id);
    expect(builtAfterAnim1).toEqual({
      damping: 0.85,
      hip: expect.objectContaining({ name: 'hip', x: 0, y: 330 }),
      breathKey1: -18,
    });
    const exportedAnim1 = await saveAndReadSessionApplied('fb-anim-1', animRec1);
    expect(assertRecordMatchesBuiltRig(exportedAnim1, builtAfterAnim1)).toEqual({ ok: true });

    // ---- Pair B Order 2: Animation Apply -> Physics Apply -----------------------------------------------------------
    expect(dropNoticeForPanel(animRec1, 'physics', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Animation set_key_value breath chest',
    );
    const physJob3 = await runPatch(physicsOp);
    const physRec3 = patchAppliedRecord(physJob3);
    const builtAfterPhys3 = readScratchRig(physJob3.id);
    expect(builtAfterPhys3).toEqual({
      damping: 0.5,
      hip: expect.objectContaining({ name: 'hip', x: 0, y: 330 }),
      breathKey1: -1.8,
    });
    const exportedPhys3 = await saveAndReadSessionApplied('fb-phys-3', physRec3);
    expect(assertRecordMatchesBuiltRig(exportedPhys3, builtAfterPhys3)).toEqual({ ok: true });

    // ---- Condition 4: Undo (#166) across those Applies restores each earlier build, applied state & drop notice -----
    const undoStep = async (fromId: string) => {
      let res = (await (await post('/api/rebuild/undo', { from: fromId })).json()) as UndoView;
      if (res.status === 'running') {
        const job = await settleJob(singleBase, res.job);
        const history = (await (await fetch(singleBase + '/api/rebuild/history')).json()) as AppliedHistoryView;
        res = { status: 'built', undone: res.undone, job, history };
      }
      return res;
    };

    // Control for Condition 4: if Undo left `appliedOnStage` stale instead of updating to `recordFor(restored.job)`,
    // the drop notice and applied panel ops would not follow the restored build.
    const undo1 = await undoStep(physJob3.id);
    expect(undo1.status).toBe('built');
    if (undo1.status !== 'built') throw new Error('expected built');
    expect(undo1.job.id).toBe(animJob1.id);
    const restoredRec1 = recordFor(undo1.job);
    const restoredOut1 = restoredOutcomeForJob(undo1.job);
    expect(restoredOut1).toEqual({
      panel: 'animation',
      text: animationOutcomeLine(undo1.job as AnimationJobView).text,
      error: false,
    });
    const statusesAfterUndo1 = reconcilePanelStatuses(
      { physics: patchOutcomeLine(physJob3).text, animation: '' },
      restoredRec1,
      restoredOut1,
    );
    expect(statusesAfterUndo1.physics).toBe('');
    expect(statusesAfterUndo1.animation).toBe(animationOutcomeLine(undo1.job as AnimationJobView).text);
    // Stale control fails:
    expect(dropNoticeForPanel(physRec3, 'physics', { handoff: status })).toBe('');
    // Restored record succeeds: Animation is back on stage, so Physics shows the drop notice for Animation, and
    // Physics panel's applied ops are now empty (`[]`).
    expect(appliedPanelOps(restoredRec1).physics).toEqual([]);
    expect(dropNoticeForPanel(restoredRec1, 'physics', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Animation set_key_value breath chest',
    );
    expect(dropNoticeForPanel(restoredRec1, 'animation', { handoff: status })).toBe('');
    expect(assertRecordMatchesBuiltRig(restoredRec1, readScratchRig(undo1.job.id))).toEqual({ ok: true });

    // Undo 2: back to physJob2
    const undo2 = await undoStep(animJob1.id);
    expect(undo2.status).toBe('built');
    if (undo2.status !== 'built') throw new Error('expected built');
    expect(undo2.job.id).toBe(physJob2.id);
    const restoredRec2 = recordFor(undo2.job);
    const restoredOut2 = restoredOutcomeForJob(undo2.job);
    expect(restoredOut2).toEqual({
      panel: 'physics',
      text: patchOutcomeLine(undo2.job as PatchJobView).text,
      error: false,
    });
    const statusesAfterUndo2 = reconcilePanelStatuses(statusesAfterUndo1, restoredRec2, restoredOut2);
    expect(statusesAfterUndo2.animation).toBe('');
    expect(statusesAfterUndo2.physics).toBe(patchOutcomeLine(undo2.job as PatchJobView).text);
    expect(appliedPanelOps(restoredRec2).physics).toEqual([physicsOp]);
    expect(appliedPanelOps(restoredRec2).bones).toEqual([]);
    expect(dropNoticeForPanel(restoredRec2, 'bones', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5',
    );

    // Undo 3: back to bonesJob1
    const undo3 = await undoStep(physJob2.id);
    expect(undo3.status).toBe('built');
    if (undo3.status !== 'built') throw new Error('expected built');
    expect(undo3.job.id).toBe(bonesJob1.id);
    const restoredRec3 = recordFor(undo3.job);
    const restoredOut3 = restoredOutcomeForJob(undo3.job);
    expect(restoredOut3).toEqual({
      panel: 'bones',
      text: patchOutcomeLine(undo3.job as PatchJobView).text,
      error: false,
    });
    const statusesAfterUndo3 = reconcilePanelStatuses(statusesAfterUndo2, restoredRec3, restoredOut3);
    expect(statusesAfterUndo3.physics).toBe('');
    expect(statusesAfterUndo3.bones).toBe(patchOutcomeLine(undo3.job as PatchJobView).text);
    expect(appliedPanelOps(restoredRec3).bones).toEqual([bonesOp]);
    expect(appliedPanelOps(restoredRec3).physics).toEqual([]);
    expect(dropNoticeForPanel(restoredRec3, 'physics', { handoff: status })).toBe(
      'This rebuild starts from the handoff and drops: Bones hip at [400, 420] → [416, 424]',
    );

    // Undo 4: back to physJob1
    const undo4 = await undoStep(bonesJob1.id);
    expect(undo4.status).toBe('built');
    if (undo4.status !== 'built') throw new Error('expected built');
    expect(undo4.job.id).toBe(physJob1.id);
    const restoredOut4 = restoredOutcomeForJob(undo4.job);
    const statusesAfterUndo4 = reconcilePanelStatuses(statusesAfterUndo3, recordFor(undo4.job), restoredOut4);
    expect(statusesAfterUndo4.bones).toBe('');
    expect(statusesAfterUndo4.physics).toBe(patchOutcomeLine(undo4.job as PatchJobView).text);

    // Undo 5: back to the inspected build (depth 0)
    const undo5 = await undoStep(physJob1.id);
    expect(undo5.status).toBe('inspected');
    const statusesAfterUndo5 = reconcilePanelStatuses(statusesAfterUndo4, null, null);
    expect(statusesAfterUndo5.physics).toBe('');
    expect(appliedPanelOps(null)).toEqual({
      cuts: [],
      cloth: [],
      physics: [],
      bones: [],
      idle: [],
      'rig-fields': [],
    });
    for (const panel of REBUILD_PANEL_KINDS) {
      expect(dropNoticeForPanel(null, panel, { handoff: status })).toBe('');
    }
    expect(treeSha256(pkgA)).toBe(beforeHashA);
  } finally {
    await singleServer.stop(true);
  }

  // ---- Compare mode per-side verification (Side A and Side B) -------------------------------------------------------
  const loadedCompare = await loadCompare({ a: pkgA, b: pkgB, reference: refVideo, animation: 'idle' });
  const compareServer = await startCompareServer(loadedCompare, { port: 0, stateDir: state, cwd: root });
  const compareBase = `http://127.0.0.1:${compareServer.port}`;
  try {
    const statusA = await waitBaseline(compareBase, '/api/compare/a/rebuild');
    const statusB = await waitBaseline(compareBase, '/api/compare/b/rebuild');
    expect(statusA.baseline?.status).toBe('reproduced');
    expect(statusB.baseline?.status).toBe('reproduced');

    const postSide = (side: 'a' | 'b', suffix: string, body: unknown) =>
      fetch(`${compareBase}/api/compare/${side}${suffix}`, {
        method: 'POST',
        headers: { Origin: compareBase, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    for (const [side, sideStatus, sideSourceHash] of [
      ['a', statusA, loadedCompare.a.sourceHash],
      ['b', statusB, loadedCompare.b.sourceHash],
    ] as const) {
      const cfgHash = sideStatus.inputs!.configHash;
      const physicsPatch: ConfigPatch = {
        schema: CONFIG_PATCH_SCHEMA,
        config_sha256: cfgHash,
        ops: [{ op: 'replace', path: '/constraints/0/damping', value: 0.5, name: 'hairback_r0_phys' }],
        producer: { name: '@rig-c/parts', version: '2.0.0' },
        op: { cmd: 'rig', args: [] },
      };
      const bonesPatch: ConfigPatch = {
        schema: CONFIG_PATCH_SCHEMA,
        config_sha256: cfgHash,
        ops: [{ op: 'replace', path: '/bones/0/at', value: [416, 424], name: 'hip' }],
        producer: { name: '@rig-c/parts', version: '2.0.0' },
        op: { cmd: 'rig', args: [] },
      };

      // 1. Apply Physics on `side`.
      const job1 = await settleJob(
        compareBase,
        (await (await postSide(side, '/rebuild', { patch: physicsPatch })).json()) as PatchJobView,
        `/api/compare/${side}/rebuild`,
      );
      expect(job1.status).toBe('built');
      const rec1 = patchAppliedRecord(job1);
      expect(dropNoticeForPanel(rec1, 'bones', { handoff: sideStatus })).toBe(
        'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5',
      );

      // 2. Apply Bones on `side` (supersedes Physics on `side`).
      const job2 = await settleJob(
        compareBase,
        (await (await postSide(side, '/rebuild', { patch: bonesPatch })).json()) as PatchJobView,
        `/api/compare/${side}/rebuild`,
      );
      expect(job2.status).toBe('built');
      const rec2 = patchAppliedRecord(job2);
      expect(appliedPanelOps(rec2).physics).toEqual([]);
      expect(appliedPanelOps(rec2).bones).toEqual(bonesPatch.ops);
      expect(dropNoticeForPanel(rec2, 'physics', { handoff: sideStatus })).toBe(
        'This rebuild starts from the handoff and drops: Bones hip at [400, 420] → [416, 424]',
      );

      const scratchRig = JSON.parse(
        readFileSync(join(state, 'rebuild', sideSourceHash, job2.id, 'rig/rig.json'), 'utf8'),
      ) as {
        bones: { name: string; x: number; y: number }[];
        constraints: { name: string; damping: number }[];
      };
      expect(scratchRig.constraints[0]!.damping).toBe(0.85);
      expect(scratchRig.bones.find(b => b.name === 'hip')).toMatchObject({ x: 16, y: 326 });

      // 3. Undo on `side` restores Physics build on `side`.
      const undone1 = (await (await postSide(side, '/rebuild/undo', { from: job2.id })).json()) as UndoView;
      expect(undone1.status).toBe('built');
      if (undone1.status !== 'built') throw new Error('expected built');
      expect(undone1.job.id).toBe(job1.id);
      const restored = recordFor(undone1.job);
      expect(appliedPanelOps(restored).physics).toEqual(physicsPatch.ops);
      expect(appliedPanelOps(restored).bones).toEqual([]);
      expect(dropNoticeForPanel(restored, 'bones', { handoff: sideStatus })).toBe(
        'This rebuild starts from the handoff and drops: Physics damping 0.85 → 0.5',
      );

      // 4. Second Undo on `side` returns to the inspected build.
      const undone2 = (await (await postSide(side, '/rebuild/undo', { from: job1.id })).json()) as UndoView;
      expect(undone2.status).toBe('inspected');
    }

    expect(treeSha256(pkgA)).toBe(beforeHashA);
    expect(treeSha256(pkgB)).toBe(beforeHashB);
  } finally {
    await compareServer.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
