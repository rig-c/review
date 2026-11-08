/**
 * Stage 1 pre-rig draft precision correction browser proof (#562).
 *
 * Supports two separately labelled phases:
 * 1. `--mode synthetic` (default): reseals a disposable contour-enabled copy of the Create pre-rig draft in a temporary
 *    directory (keeping the sealed 209-file fixture untouched and verifying the resealed project's 209-file inventory
 *    before and after) with deterministic stand-in `@rig-c/parts@2.31.0` and `@rig-c/core@3.6.0` executables outside
 *    the project, and exercises all three Stage 1 -> Stage 3 Setup precision instruments (`Chest regions`,
 *    `Mesh parameters`, `Edit Mesh`) with real two-frame-settled CDP stage pointer drags, visible Apply buttons,
 *    visible `#applied-undo` step-back restoration, visible `#mesh-panel-reset` restoration, direct Stage 3
 *    `RIG_VERSION_UNAVAILABLE` refusal, and the read-only `2-rigging-answers` Stage 1 control across `en` and `ko`.
 * 2. `--mode fixture-830fc98`: opens the sealed 209-file `create-830fc98/templates/example-remesh` fixture read-only in
 *    place (`picksDir: 'inputs/references'`) with real `@rig-c/parts@2.31.0` and `@rig-c/core@3.6.0` installed in an
 *    external toolchain directory discovered via normal `resolveProducer` (`cwd`), records and verifies preservation of
 *    the preceding view and source binding when `Chest regions` refuses (`REBUILD_PART_NOT_CONTOUR: torso`), and runs
 *    live `Mesh parameters` (`remesh --mesh` via real CDP pointer drag on the visible `grid` range control) and
 *    `Edit Mesh` (`remesh --delta` via `dragStage1Delta` + visible `#mesh-apply` CDP click), visible `#applied-undo`,
 *    and visible `#mesh-panel-reset` across `en` and `ko`.
 */
import { createCanvas, Image } from '@napi-rs/canvas';
import { loadModel, readSetupMesh } from '@rig-c/play';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { MESH_EDIT_CODES, type MeshOp } from '../src/mesh-edit.ts';
import { alive, loadOpenPackage, openReview, readRecord, running, smallJson, type RecordFile } from '../src/open.ts';
import { readStoredSetupMesh, type WeightInfluence } from '../src/setup-mesh.ts';
import { enCatalog } from '../web/catalog-en.ts';
import { koCatalog } from '../web/catalog-ko.ts';
import { assertNamedDeltaOps, dragStage1Delta, type DeltaDiagnostic } from './helpers/stage1-delta-target.ts';
import { joinedVerdictFixture } from './helpers/joined-verdict-fixture.ts';
import { withDeadline } from './helpers/walk-deadline.ts';
import { launchCdpSession, type CdpPageEvent, type InputCdpSession } from './parts-explorer-browser.ts';
import { waitForStage1Readiness } from './stage1-corrections-browser.ts';

process.env.UV_THREADPOOL_SIZE ||= '4';
process.env.BUN_JSC_forceRAMSize ||= '6442450944';
process.env.NODE_OPTIONS ||= '--max-old-space-size=6144';

type PhaseMode = 'synthetic' | 'fixture-830fc98';
type Locale = 'en' | 'ko';

interface InventoryEntry {
  path: string;
  sha256: string;
}

interface InventoryDocument {
  createCommit: string;
  reviewHead: string;
  packetCommentId: number;
  files: InventoryEntry[];
}

interface PrecedingViewSnapshot {
  inspectionStage: string | null;
  stageRefused: string | null;
  panelHidden: boolean | null;
  layoutInert: boolean | null;
  activeMode: string | null;
  activeInspector: string | null;
  stageModelHash: string | null;
  appliedBuildId: string | null;
  iframePart: string | null;
  iframeBuildId: string | null;
  iframeSourceHash: string | null;
  iframeCorrectionLine: string;
}

interface Stage3RefusedReadout {
  lang: string;
  stage: string | null;
  stageRefused: string | null;
  statusText: string;
  statusVisible: boolean;
  modeSwitchHidden: boolean;
  modeSwitchDisplay: string;
  modeSwitchRects: number;
  usableModes: string[];
}

interface SetupReadout {
  stage: string | null;
  draftLabel: string;
  chestPressed: boolean;
  chestDisabled: boolean;
  bustApplyDisabled: boolean;
  meshOpen: boolean;
  meshPart: string | null;
  meshEditPressed: boolean;
  meshEditSlot: string | null;
  meshEditVerts: number;
  posedCount: number;
  posedTris: number;
  meshLayerChecked: boolean;
  overlayTris: number | null;
}

interface DiskCompiledGeometry {
  modelPath: string;
  rawText: string;
  modelHash: string;
  vertexCount: number;
  triangleCount: number;
  weighted: boolean;
  hull: number | null;
  width: number;
  height: number;
  storedVertices: WeightInfluence[][];
  posedVertices: number[];
  triangles: number[];
  uvs: number[];
}

interface SetupGeometrySnapshot {
  buildId: string;
  diskModelHash: string;
  stageModelHash: string;
  servedModelHash: string;
  vertexCount: number;
  triangleCount: number;
  posedVertices: number[];
  posedTriangles: number[];
  meshLayerChecked: boolean;
  overlayTris: number | null;
}

interface Stage1IframeReadout {
  selectedPart: string;
  buildId: string;
  inspectionSourceHash: string;
  verdictSourceHash: string;
  servedModelHash: string;
  correctionLine: string;
  figureVertices: number;
  figureTriangles: number;
  buttonLabels: string[];
}

interface WorkerExitEvidence {
  key: string;
  nonce: string;
  pid: number;
  recordRemoved: boolean;
  processExited: boolean;
  statusClosed: boolean;
}

interface CheckpointEntry {
  at: string;
  step: string;
  detail?: Record<string, unknown>;
}

const sha256Hex = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let lastWaiterDiagnostic: { label: string; readout: unknown } | null = null;

function boundedPreview(text: string | null | undefined, limit = 240): string {
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}...(truncated)` : text;
}

async function waitFor<T>(
  label: string,
  read: (recordReadout: (readout: unknown) => void) => Promise<T | null | false | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  let lastReadout: unknown = undefined;
  const recordReadout = (readout: unknown) => {
    lastReadout = readout;
    lastWaiterDiagnostic = { label, readout };
  };
  while (performance.now() < deadline) {
    try {
      const value = await read(recordReadout);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(40);
  }
  const readoutSuffix =
    lastReadout !== undefined ? ` | lastReadout=${boundedPreview(JSON.stringify(lastReadout), 900)}` : '';
  const errorSuffix = lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '';
  throw new Error(`Timed out waiting for ${label}${errorSuffix}${readoutSuffix}`);
}

async function collectFileHashes(rootDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const rel = relative(rootDir, full).split(sep).join('/');
        out.set(rel, sha256Hex(await readFile(full)));
      }
    }
  };
  await walk(rootDir);
  return out;
}

function mapToInventoryEntries(map: Map<string, string>): InventoryEntry[] {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, sha256]) => ({ path, sha256 }));
}

async function verifyFixtureInventory(fixtureRoot: string, inventoryPath: string): Promise<number> {
  const doc = JSON.parse(await readFile(inventoryPath, 'utf8')) as InventoryDocument;
  assertCondition(Array.isArray(doc.files) && doc.files.length === 209, `Expected 209 inventory entries in ${inventoryPath}`);
  const actual = await collectFileHashes(fixtureRoot);
  assertCondition(actual.size === doc.files.length, `Fixture file count mismatch: expected ${doc.files.length}, got ${actual.size}`);
  for (const entry of doc.files) {
    const digest = actual.get(entry.path);
    assertCondition(digest === entry.sha256, `Fixture SHA-256 mismatch at ${entry.path}: expected ${entry.sha256}, got ${String(digest)}`);
  }
  return doc.files.length;
}

function equalFloat32Arrays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.fround(v) === Math.fround(b[i]!));
}

function equalIntArrays(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function servedModelUrlForBuild(buildId: string): string {
  return buildId === 'inspected'
    ? 'assets/build/skeleton.model.json'
    : `rebuild/${encodeURIComponent(buildId)}/skeleton.model.json`;
}

async function readDiskCompiledGeometry(modelPath: string): Promise<DiskCompiledGeometry> {
  const bytes = await readFile(modelPath);
  const rawText = bytes.toString('utf8');
  const modelHash = sha256Hex(bytes);
  const doc = JSON.parse(rawText) as Record<string, unknown>;
  const storedRes = readStoredSetupMesh(doc, 'torso', { skin: 'default', attachment: 'torso' }, MESH_EDIT_CODES);
  assertCondition(
    storedRes.ok,
    `Invalid torso setup mesh in compiled model ${modelPath}: ${storedRes.ok ? '' : storedRes.code}`,
  );
  const stored = storedRes.mesh;
  const uvs = stored.entry.uvs;
  const width = stored.entry.width;
  const height = stored.entry.height;
  assertCondition(
    Array.isArray(uvs) && uvs.length === stored.vertices.length * 2 && uvs.every(v => typeof v === 'number'),
    `Invalid torso uvs in compiled model ${modelPath}`,
  );
  assertCondition(
    typeof width === 'number' && Number.isInteger(width) && typeof height === 'number' && Number.isInteger(height),
    `Invalid torso width/height in compiled model ${modelPath}`,
  );

  const buildDir = dirname(modelPath);
  const pageBytes = new Map<string, Buffer>();
  const pages = Array.isArray(doc.pages) ? (doc.pages as Array<{ name?: string }>) : [{ name: 'skeleton.png' }];
  for (const p of pages) {
    const pageName = typeof p?.name === 'string' ? p.name : 'skeleton.png';
    pageBytes.set(`https://weights.invalid/${pageName}`, await readFile(join(buildDir, pageName)));
  }
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(
    ['document', 'Image'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  };
  const srcDesc = Object.getOwnPropertyDescriptor(Image.prototype, 'src')!;
  class LocalImage extends Image {}
  Object.defineProperty(LocalImage.prototype, 'src', {
    get() {
      return srcDesc.get!.call(this);
    },
    set(value: unknown) {
      const image = typeof value === 'string' ? pageBytes.get(value) : undefined;
      if (!image) throw new Error(`Undeclared compiled model page image: ${String(value)}`);
      srcDesc.set!.call(this, image);
    },
  });
  globals.Image = LocalImage;
  globals.document = {
    baseURI: 'https://weights.invalid/',
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`Unexpected native host element ${tag}`);
      return Object.assign(createCanvas(1, 1), { style: {}, remove() {} });
    },
  };

  let posedVertices: number[];
  let posedTriangles: number[];
  try {
    const assets = await loadModel({
      modelUrl: 'https://weights.invalid/skeleton.model.json',
      setsUrl: null,
      regions: 'none',
      resolvePage: name => `https://weights.invalid/${name}`,
      fetch: new Proxy(fetch, {
        apply: (_t, _s, args: Parameters<typeof fetch>) =>
          String(args[0]) === 'https://weights.invalid/skeleton.model.json'
            ? Promise.resolve(new Response(new Uint8Array(bytes)))
            : Promise.reject(new Error(`Undeclared model fetch: ${String(args[0])}`)),
      }),
    });
    try {
      const posed = readSetupMesh(assets, { slot: 'torso', attachment: 'torso' });
      assertCondition(
        posed &&
          Array.isArray(posed.vertices) &&
          posed.vertices.length === stored.vertices.length * 2 &&
          Array.isArray(posed.triangles) &&
          equalIntArrays(posed.triangles, stored.triangles),
        `Failed to compute setup-posed torso geometry via @rig-c/play for ${modelPath}`,
      );
      posedVertices = [...posed.vertices];
      posedTriangles = [...posed.triangles];
    } finally {
      assets.dispose();
    }
  } finally {
    restore();
  }

  return {
    modelPath,
    rawText,
    modelHash,
    vertexCount: stored.vertices.length,
    triangleCount: stored.triangles.length / 3,
    weighted: stored.weighted,
    hull: stored.hull,
    width,
    height,
    storedVertices: stored.vertices,
    posedVertices,
    triangles: posedTriangles,
    uvs: [...(uvs as number[])],
  };
}

async function verifySetupModelAndGeometryAgainstDisk(
  page: Pick<InputCdpSession, 'evaluate'>,
  expectedBuildId: string,
  disk: DiskCompiledGeometry,
  label: string,
): Promise<SetupGeometrySnapshot> {
  const modelUrl = servedModelUrlForBuild(expectedBuildId);
  return await waitFor(`Setup geometry & model hash match (${label})`, async recordReadout => {
    const state = await page.evaluate<{
      busy: boolean;
      stageModelHash: string | null;
      stripStageHash: string | null;
      applied: { buildId: string; modelHash: string } | null;
      stripApplied: { buildId: string; modelHash: string } | null;
      rebuildAppliedRaw: string;
      meshLayerChecked: boolean;
      overlayTris: number | null;
      posed: { vertices?: number[]; triangles?: number[] } | null;
      modelStatus: number;
      modelOk: boolean;
      servedModelText: string;
    }>(`(async () => {
      const res = await fetch(${JSON.stringify(modelUrl)});
      const servedModelText = await res.text();
      return {
        busy: Boolean(window.rigReviewEditor?.stage?.()?.busy),
        stageModelHash: window.rigReviewEditor?.stage?.()?.modelHash ?? null,
        stripStageHash: window.rigReviewEditor?.mesh?.strip?.stageHash?.() ?? null,
        applied: window.rigReviewEditor?.stage?.()?.applied ?? null,
        stripApplied: window.rigReviewEditor?.mesh?.strip?.applied?.() ?? null,
        rebuildAppliedRaw: document.getElementById('rebuild-applied')?.value ?? '',
        meshLayerChecked: Boolean(document.getElementById('layer-mesh')?.checked),
        overlayTris: window.rigReviewEditor?.mesh?.overlayTriangles?.('torso') ?? null,
        posed: window.rigReviewEditor?.posed?.('torso') ?? null,
        modelStatus: res.status,
        modelOk: res.ok,
        servedModelText,
      };
    })()`);
    const baseDiagnostic = {
      expectedBuildId,
      expectedModelHash: disk.modelHash,
      busy: state.busy,
      stageModelHash: state.stageModelHash,
      stripStageHash: state.stripStageHash,
      applied: state.applied,
      stripApplied: state.stripApplied,
      meshLayerChecked: state.meshLayerChecked,
      overlayTris: state.overlayTris,
      posedVertexCount: Array.isArray(state.posed?.vertices) ? state.posed.vertices.length / 2 : null,
      posedTriangleCount: Array.isArray(state.posed?.triangles) ? state.posed.triangles.length / 3 : null,
      modelFetch: {
        url: modelUrl,
        status: state.modelStatus,
        ok: state.modelOk,
        bodyPreview: state.modelOk ? `(length ${state.servedModelText.length})` : boundedPreview(state.servedModelText),
      },
    };
    if (state.busy) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'busy' });
      return null;
    }
    if (state.stageModelHash !== disk.modelHash || state.stripStageHash !== disk.modelHash) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'stageModelHash or stripStageHash mismatch' });
      return null;
    }
    if (!state.modelOk) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'modelFetch failed' });
      return null;
    }
    const servedModelHash = sha256Hex(state.servedModelText);
    if (servedModelHash !== disk.modelHash || state.servedModelText !== disk.rawText) {
      recordReadout({ ...baseDiagnostic, servedModelHash, mismatchReason: 'servedModelText/hash mismatch' });
      return null;
    }
    if (expectedBuildId === 'inspected') {
      if (state.applied !== null || state.stripApplied !== null) {
        recordReadout({ ...baseDiagnostic, mismatchReason: 'expected inspected with null applied' });
        return null;
      }
    } else {
      if (
        !state.applied ||
        state.applied.buildId !== expectedBuildId ||
        state.applied.modelHash !== disk.modelHash ||
        !state.stripApplied ||
        state.stripApplied.buildId !== expectedBuildId ||
        state.stripApplied.modelHash !== disk.modelHash
      ) {
        recordReadout({ ...baseDiagnostic, mismatchReason: 'applied/stripApplied buildId or modelHash mismatch' });
        return null;
      }
      if (!state.rebuildAppliedRaw) {
        recordReadout({ ...baseDiagnostic, mismatchReason: 'rebuildAppliedRaw empty' });
        return null;
      }
    }
    if (!state.posed || !Array.isArray(state.posed.vertices) || !Array.isArray(state.posed.triangles)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'posed(torso) missing' });
      return null;
    }
    if (!equalIntArrays(state.posed.triangles, disk.triangles)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'posed.triangles array mismatch' });
      return null;
    }
    if (!equalFloat32Arrays(state.posed.vertices, disk.posedVertices)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'posed.vertices array mismatch' });
      return null;
    }
    const expectedOverlayTris = state.meshLayerChecked ? disk.triangleCount : null;
    if (state.overlayTris !== expectedOverlayTris) {
      recordReadout({
        ...baseDiagnostic,
        expectedOverlayTris,
        mismatchReason: 'overlayTris mismatch for meshLayerChecked state',
      });
      return null;
    }
    return {
      buildId: expectedBuildId,
      diskModelHash: disk.modelHash,
      stageModelHash: state.stageModelHash,
      servedModelHash,
      vertexCount: disk.vertexCount,
      triangleCount: disk.triangleCount,
      posedVertices: state.posed.vertices,
      posedTriangles: state.posed.triangles,
      meshLayerChecked: state.meshLayerChecked,
      overlayTris: state.overlayTris,
    };
  });
}

function assertSetupSnapshotRestored(
  actual: SetupGeometrySnapshot,
  expected: SetupGeometrySnapshot,
  label: string,
): void {
  assertCondition(actual.buildId === expected.buildId, `${label}: buildId mismatch (${actual.buildId} vs ${expected.buildId})`);
  assertCondition(
    actual.stageModelHash === expected.stageModelHash &&
      actual.diskModelHash === expected.diskModelHash &&
      actual.servedModelHash === expected.servedModelHash,
    `${label}: modelHash mismatch (${actual.stageModelHash} vs ${expected.stageModelHash})`,
  );
  assertCondition(
    actual.vertexCount === expected.vertexCount && actual.triangleCount === expected.triangleCount,
    `${label}: vertex/triangle count mismatch`,
  );
  assertCondition(
    equalIntArrays(actual.posedTriangles, expected.posedTriangles),
    `${label}: posed triangles array mismatch`,
  );
  assertCondition(
    equalFloat32Arrays(actual.posedVertices, expected.posedVertices),
    `${label}: posed vertices array mismatch`,
  );
}

function allocateUnusedLoopbackPort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function claimOwnedWorker(
  opened: Awaited<ReturnType<typeof openReview>>,
  controlDir: string,
  frontPort: number,
  ownedWorkers: RecordFile[],
): Promise<{ record: RecordFile; frontPid: number }> {
  const key = new URL(opened.url).searchParams.get('handoff');
  assertCondition(key && /^[a-f0-9]{64}$/.test(key), 'openReview URL must carry handoff key');
  const record = await readRecord(join(controlDir, `${key}.json`), key);
  assertCondition(record !== null, 'test-owned worker record must exist in controlDir');
  assertCondition(record.nonce === opened.nonce, 'worker nonce mismatch');
  assertCondition(running(record.pid), 'worker pid must be running');
  assertCondition(await alive(record), 'worker must respond to /api/open-status');
  const front = (await smallJson(join(controlDir, `front-${frontPort}.json`))) as { pid?: number; port?: number };
  assertCondition(typeof front.pid === 'number' && front.pid > 0 && front.port === frontPort, 'front record must exist');
  ownedWorkers.push(record);
  return { record, frontPid: front.pid };
}

async function verifyOwnedWorkersExited(
  controlDir: string,
  ownedWorkers: readonly RecordFile[],
  frontPids: readonly number[],
): Promise<WorkerExitEvidence[]> {
  const evidence: WorkerExitEvidence[] = [];
  for (const worker of ownedWorkers) {
    const recordFile = join(controlDir, `${worker.key}.json`);
    await withDeadline(`WORKER_EXIT:${worker.key.slice(0, 12)}`, 10_000, async () => {
      while ((await readRecord(recordFile, worker.key)) !== null || running(worker.pid)) {
        await Bun.sleep(25);
      }
    });
    const recordRemoved = (await readRecord(recordFile, worker.key)) === null;
    const processExited = !running(worker.pid);
    const statusClosed = !(await alive(worker));
    assertCondition(recordRemoved && processExited && statusClosed, `Worker ${worker.pid} did not exit cleanly`);
    evidence.push({ key: worker.key, nonce: worker.nonce, pid: worker.pid, recordRemoved, processExited, statusClosed });
  }
  for (const frontPid of frontPids) {
    await withDeadline(`FRONT_EXIT:${frontPid}`, 10_000, async () => {
      while (running(frontPid)) {
        await Bun.sleep(25);
      }
    });
    assertCondition(!running(frontPid), `Front server ${frontPid} still running`);
  }
  return evidence;
}

interface ClickProbeEvent {
  client: { x: number; y: number };
  tag: string | null;
  id: string | null;
  matched: boolean;
}

interface ClickDiagnostic {
  label: string;
  selector: string;
  point: { x: number; y: number };
  innerPoint?: { x: number; y: number };
  outerHitTag?: string | null;
  hitTag: string | null;
  hitId: string | null;
  pointerdown: ClickProbeEvent | null;
  click: ClickProbeEvent | null;
}

interface StageRegionDragSnapshot {
  source: {
    inspectionStage: string | null;
    buildId: string;
    modelHash: string | null;
    part: string | null;
    toggleAriaPressed: string | null;
    regionKey: string;
    cx: number;
    cy: number;
  };
  root: { left: string; top: string; transform: string };
  projection: {
    origin: { x: number; y: number };
    unitX: { x: number; y: number };
    unitY: { x: number; y: number };
  };
  pane: { x: number; y: number; left: number; top: number; width: number; height: number };
  viewport: { x: number; y: number; left: number; top: number; width: number; height: number };
  canvas: { x: number; y: number; left: number; top: number; width: number; height: number };
  handle: {
    startWorld: { x: number; y: number };
    endWorld: { x: number; y: number };
    startScreen: { x: number; y: number };
    endScreen: { x: number; y: number };
    startHitTag: string | null;
    startHitId: string | null;
    startHitInsidePane: boolean;
  };
}

interface StageRegionPressReadback {
  client: { x: number; y: number };
  target: string;
  insideRigPane: boolean;
  snapshot: StageRegionDragSnapshot | null;
}

interface StageRegionDragDiagnostic {
  label: string;
  toggleBeforeDrag?: {
    ariaPressed: string | null;
    disabled: boolean;
    clickProbe?: ClickDiagnostic;
  };
  read?: StageRegionDragSnapshot;
  settled?: StageRegionDragSnapshot;
  beforePress?: StageRegionDragSnapshot;
  press?: StageRegionPressReadback;
  after?: StageRegionDragSnapshot;
  applyDisabledAfter?: boolean;
  diffTextAfter?: string;
}

async function mouseDragLine(
  page: InputCdpSession,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 8,
): Promise<void> {
  await page.mouse('mouseMoved', startX, startY);
  await page.mouse('mousePressed', startX, startY);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse('mouseMoved', startX + (endX - startX) * t, startY + (endY - startY) * t);
  }
  await page.mouse('mouseReleased', endX, endY);
}

async function twoFramePoint(
  page: Pick<InputCdpSession, 'evaluate'>,
  expression: string,
  label: string,
  timeoutMs = 10_000,
): Promise<{ x: number; y: number }> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const point = await page.evaluate<{ x: number; y: number } | null>(`new Promise(resolve => {
      const read = () => (${expression});
      requestAnimationFrame(() => {
        const a = read();
        requestAnimationFrame(() => {
          const b = read();
          if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y)) { resolve(null); return; }
          if (Math.hypot(a.x - b.x, a.y - b.y) > 0.01) { resolve(null); return; }
          resolve({ x: b.x, y: b.y });
        });
      });
    })`);
    if (point) return point;
    await Bun.sleep(25);
  }
  throw new Error(`TWO_FRAME_POINT_TIMEOUT: ${label}`);
}

async function clickVisibleIframeButton(
  page: InputCdpSession,
  btnLookupExpr: string,
  selectorSummary: string,
  label: string,
): Promise<ClickDiagnostic> {
  const settledExpr = `(() => {
    const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
    if (!frame || !frame.contentDocument) return null;
    const btn = (${btnLookupExpr})(frame.contentDocument);
    if (!btn || btn.hidden || btn.disabled) return null;
    const fRect = frame.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    if (fRect.width <= 0 || fRect.height <= 0 || bRect.width <= 0 || bRect.height <= 0) return null;
    const innerX = bRect.left + bRect.width / 2;
    const innerY = bRect.top + bRect.height / 2;
    const outerX = fRect.left + frame.clientLeft + innerX;
    const outerY = fRect.top + frame.clientTop + innerY;
    const outerInViewport = outerX >= 0 && outerY >= 0 && outerX < window.innerWidth && outerY < window.innerHeight;
    const innerInViewport = innerX >= 0 && innerY >= 0 && innerX < frame.clientWidth && innerY < frame.clientHeight;
    const outerHit = outerInViewport ? document.elementFromPoint(outerX, outerY) : null;
    const innerHit = innerInViewport ? frame.contentDocument.elementFromPoint(innerX, innerY) : null;
    const outerOk = outerHit === frame;
    const innerOk = Boolean(innerHit && (innerHit === btn || btn.contains(innerHit)));
    if (!outerInViewport || !innerInViewport || !outerOk || !innerOk) return null;
    return {
      x: outerX,
      y: outerY,
      innerX,
      innerY,
      outerHitTag: outerHit?.tagName ?? null,
      hitTag: innerHit?.tagName ?? null,
      hitId: innerHit?.id ?? null,
    };
  })()`;
  await waitFor(`iframe button scroll prep ${selectorSummary} (${label})`, async recordReadout => {
    const prep = await page.evaluate<{ ready: boolean; alreadyVisible: boolean }>(`(() => {
      const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
      if (!frame || !frame.contentDocument) return { ready: false, alreadyVisible: false };
      const btn = (${btnLookupExpr})(frame.contentDocument);
      if (!btn || btn.hidden || btn.disabled) return { ready: false, alreadyVisible: false };
      if (${settledExpr}) return { ready: true, alreadyVisible: true };
      btn.scrollIntoView({ block: 'center', inline: 'nearest' });
      return { ready: true, alreadyVisible: false };
    })()`);
    recordReadout(prep);
    return prep.ready ? prep : null;
  });
  const pt = await twoFramePoint(page, settledExpr, `iframe button ${selectorSummary} (${label})`);
  await page.mouse('mouseMoved', pt.x, pt.y);
  const beforePress = await page.evaluate<{
    ok: boolean;
    reason?: string;
    x: number;
    y: number;
    innerX: number;
    innerY: number;
    outerHitTag: string | null;
    hitTag: string | null;
    hitId: string | null;
  }>(`(() => {
    const current = ${settledExpr};
    if (!current) {
      return { ok: false, reason: 'not_visible_or_obscured_before_press', x: NaN, y: NaN, innerX: NaN, innerY: NaN, outerHitTag: null, hitTag: null, hitId: null };
    }
    if (Math.hypot(current.x - ${pt.x}, current.y - ${pt.y}) > 0.01) {
      return { ok: false, reason: 'target_moved_before_press', ...current };
    }
    const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
    const doc = frame?.contentDocument;
    if (!frame || !doc) {
      return { ok: false, reason: 'iframe_missing', ...current };
    }
    const resolveTargetElement = raw => {
      const Elem = doc.defaultView?.Element;
      if (Elem && raw instanceof Elem) return raw;
      if (raw && typeof raw === 'object' && 'nodeType' in raw && raw.nodeType === 1 && raw.ownerDocument === doc) {
        return raw;
      }
      return null;
    };
    window.stage1IframeClickProbe = { outerPointerdownHitFrame: null, pointerdown: null, click: null };
    doc.addEventListener('pointerdown', ev => {
      const btn = (${btnLookupExpr})(doc);
      const t = resolveTargetElement(ev.target);
      const outerNow = document.elementFromPoint(${pt.x}, ${pt.y});
      window.stage1IframeClickProbe.outerPointerdownHitFrame = outerNow === frame;
      window.stage1IframeClickProbe.pointerdown = {
        client: { x: ev.clientX, y: ev.clientY },
        tag: t?.tagName ?? null,
        id: t?.id ?? null,
        matched: Boolean(btn && t && (t === btn || btn.contains(t))),
      };
    }, { capture: true, passive: true, once: true });
    doc.addEventListener('click', ev => {
      const btn = (${btnLookupExpr})(doc);
      const t = resolveTargetElement(ev.target);
      window.stage1IframeClickProbe.click = {
        client: { x: ev.clientX, y: ev.clientY },
        tag: t?.tagName ?? null,
        id: t?.id ?? null,
        matched: Boolean(btn && t && (t === btn || btn.contains(t))),
      };
    }, { capture: true, passive: true, once: true });
    return { ok: true, ...current };
  })()`);
  assertCondition(
    beforePress.ok,
    `IFRAME_CLICK_TARGET_MOVED_BEFORE_PRESS (${label}): selector=${selectorSummary} pt=(${pt.x},${pt.y}) beforePress=${JSON.stringify(beforePress)}`,
  );
  await page.mouse('mousePressed', pt.x, pt.y);
  await page.mouse('mouseReleased', pt.x, pt.y);
  const probe = await page.evaluate<{
    outerPointerdownHitFrame: boolean | null;
    pointerdown: ClickProbeEvent | null;
    click: ClickProbeEvent | null;
  } | null>(`(() => {
    const p = window.stage1IframeClickProbe ?? null;
    delete window.stage1IframeClickProbe;
    return p;
  })()`);
  assertCondition(
    Boolean(probe && probe.outerPointerdownHitFrame === true && probe.pointerdown?.matched && probe.click?.matched),
    `IFRAME_CLICK_TARGET_MISSED (${label}): selector=${selectorSummary} pt=(${pt.x},${pt.y}) probe=${JSON.stringify(probe)}`,
  );
  return {
    label,
    selector: selectorSummary,
    point: { x: pt.x, y: pt.y },
    innerPoint: { x: beforePress.innerX, y: beforePress.innerY },
    outerHitTag: beforePress.outerHitTag,
    hitTag: beforePress.hitTag,
    hitId: beforePress.hitId,
    pointerdown: probe!.pointerdown,
    click: probe!.click,
  };
}

async function clickIframePartButton(
  page: InputCdpSession,
  partName: string,
  label: string,
): Promise<ClickDiagnostic> {
  const selector = `#pv-items button[data-pv-item=${JSON.stringify(partName)}]`;
  return await clickVisibleIframeButton(
    page,
    `(doc => doc.querySelector(${JSON.stringify(selector)}))`,
    selector,
    label,
  );
}

async function clickIframeCorrectionButton(
  page: InputCdpSession,
  index: 0 | 1 | 2,
  label: string,
): Promise<ClickDiagnostic> {
  return await clickVisibleIframeButton(
    page,
    `(doc => [...doc.querySelectorAll('#pv-corrections button')][${index}] ?? null)`,
    `#pv-corrections button[${index}]`,
    label,
  );
}

function makeVisibleElementHitExpr(selector: string, fractionX = 0.5): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el || el.hidden || el.disabled) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = r.left + r.width * ${fractionX};
    const y = r.top + r.height / 2;
    const inViewport = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
    const hit = inViewport ? document.elementFromPoint(x, y) : null;
    const hitOk = Boolean(hit && (hit === el || el.contains(hit) || hit.closest(${JSON.stringify(selector)}) === el));
    if (!inViewport || !hitOk) return null;
    return {
      x,
      y,
      hitTag: hit?.tagName ?? null,
      hitId: hit?.id ?? null,
    };
  })()`;
}

async function scrollTargetWithCdpWheelIfNeeded(
  page: InputCdpSession,
  selector: string,
  fractionX: number,
  label: string,
): Promise<void> {
  const hitExpr = makeVisibleElementHitExpr(selector, fractionX);
  const prep = await waitFor(`scroll prep ${selector} (${label})`, async recordReadout => {
    const info = await page.evaluate<{
      ready: boolean;
      alreadyVisible: boolean;
      hasScrollHost: boolean;
      wheelX: number;
      wheelY: number;
      deltaY: number;
    }>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.hidden || el.disabled) {
        return { ready: false, alreadyVisible: false, hasScrollHost: false, wheelX: 0, wheelY: 0, deltaY: 0 };
      }
      if (${hitExpr}) {
        return { ready: true, alreadyVisible: true, hasScrollHost: false, wheelX: 0, wheelY: 0, deltaY: 0 };
      }
      const host = el.closest('[data-inspector-panel], .animate-blocks-panel');
      if (!host) {
        return { ready: true, alreadyVisible: false, hasScrollHost: false, wheelX: 0, wheelY: 0, deltaY: 0 };
      }
      const hr = host.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (hr.width <= 0 || hr.height <= 0) {
        return { ready: false, alreadyVisible: false, hasScrollHost: true, wheelX: 0, wheelY: 0, deltaY: 0 };
      }
      const wheelX = Math.max(1, Math.min(window.innerWidth - 2, hr.left + hr.width / 2));
      const wheelY = Math.max(1, Math.min(window.innerHeight - 2, hr.top + hr.height / 2));
      const deltaY = Math.round((er.top + er.height / 2) - (hr.top + hr.height / 2)) || 120;
      return { ready: true, alreadyVisible: false, hasScrollHost: true, wheelX, wheelY, deltaY };
    })()`);
    recordReadout(info);
    return info.ready ? info : null;
  });
  if (prep.alreadyVisible) return;
  if (prep.hasScrollHost) {
    await page.mouse('mouseMoved', prep.wheelX, prep.wheelY);
    await page.mouse('mouseWheel', prep.wheelX, prep.wheelY, prep.deltaY);
  }
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  })()`);
}

async function clickVisibleButton(
  page: InputCdpSession,
  selector: string,
  label: string,
): Promise<ClickDiagnostic> {
  await scrollTargetWithCdpWheelIfNeeded(page, selector, 0.5, label);
  const settledExpr = makeVisibleElementHitExpr(selector, 0.5);
  const pt = await twoFramePoint(page, settledExpr, `visible button ${selector} (${label})`);
  await page.mouse('mouseMoved', pt.x, pt.y);
  const beforePress = await page.evaluate<{
    ok: boolean;
    reason?: string;
    x: number;
    y: number;
    hitTag: string | null;
    hitId: string | null;
  }>(`(() => {
    const current = ${settledExpr};
    if (!current) {
      return { ok: false, reason: 'not_visible_or_obscured_before_press', x: NaN, y: NaN, hitTag: null, hitId: null };
    }
    if (Math.hypot(current.x - ${pt.x}, current.y - ${pt.y}) > 0.01) {
      return { ok: false, reason: 'target_moved_before_press', ...current };
    }
    window.stage1ClickProbe = { pointerdown: null, click: null };
    document.addEventListener('pointerdown', ev => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const t = ev.target instanceof Element ? ev.target : null;
      window.stage1ClickProbe.pointerdown = {
        client: { x: ev.clientX, y: ev.clientY },
        tag: t?.tagName ?? null,
        id: t?.id ?? null,
        matched: Boolean(el && t && (t === el || el.contains(t) || t.closest(${JSON.stringify(selector)}) === el)),
      };
    }, { capture: true, passive: true, once: true });
    document.addEventListener('click', ev => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const t = ev.target instanceof Element ? ev.target : null;
      window.stage1ClickProbe.click = {
        client: { x: ev.clientX, y: ev.clientY },
        tag: t?.tagName ?? null,
        id: t?.id ?? null,
        matched: Boolean(el && t && (t === el || el.contains(t) || t.closest(${JSON.stringify(selector)}) === el)),
      };
    }, { capture: true, passive: true, once: true });
    return { ok: true, ...current };
  })()`);
  assertCondition(
    beforePress.ok,
    `CLICK_TARGET_MOVED_BEFORE_PRESS (${label}): selector=${selector} pt=(${pt.x},${pt.y}) beforePress=${JSON.stringify(beforePress)}`,
  );
  await page.mouse('mousePressed', pt.x, pt.y);
  await page.mouse('mouseReleased', pt.x, pt.y);
  const probe = await page.evaluate<{
    pointerdown: ClickProbeEvent | null;
    click: ClickProbeEvent | null;
  } | null>(`(() => {
    const p = window.stage1ClickProbe ?? null;
    delete window.stage1ClickProbe;
    return p;
  })()`);
  assertCondition(
    Boolean(probe && probe.pointerdown?.matched && probe.click?.matched),
    `CLICK_TARGET_MISSED (${label}): selector=${selector} pt=(${pt.x},${pt.y}) probe=${JSON.stringify(probe)}`,
  );
  return {
    label,
    selector,
    point: { x: pt.x, y: pt.y },
    hitTag: beforePress.hitTag,
    hitId: beforePress.hitId,
    pointerdown: probe!.pointerdown,
    click: probe!.click,
  };
}

async function dragVisibleRangeControl(
  page: InputCdpSession,
  selector: string,
  fromFraction: number,
  toFraction: number,
  label: string,
): Promise<void> {
  await scrollTargetWithCdpWheelIfNeeded(page, selector, fromFraction, label);
  const startExpr = makeVisibleElementHitExpr(selector, fromFraction);
  const endExpr = makeVisibleElementHitExpr(selector, toFraction);
  const startPt = await twoFramePoint(page, startExpr, `range start ${selector} (${label})`);
  const endPt = await twoFramePoint(page, endExpr, `range target ${selector} (${label})`);
  await page.mouse('mouseMoved', startPt.x, startPt.y);
  const beforePress = await page.evaluate<{ ok: boolean; x: number; y: number }>(`(() => {
    const current = ${startExpr};
    if (!current || Math.hypot(current.x - ${startPt.x}, current.y - ${startPt.y}) > 0.01) {
      return { ok: false, x: current?.x ?? NaN, y: current?.y ?? NaN };
    }
    window.stage1RangeProbe = null;
    document.addEventListener('pointerdown', ev => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const t = ev.target instanceof Element ? ev.target : null;
      window.stage1RangeProbe = {
        client: { x: ev.clientX, y: ev.clientY },
        tag: t?.tagName ?? null,
        id: t?.id ?? null,
        matched: Boolean(el && t && (t === el || el.contains(t) || t.closest(${JSON.stringify(selector)}) === el)),
      };
    }, { capture: true, passive: true, once: true });
    return { ok: true, x: current.x, y: current.y };
  })()`);
  assertCondition(
    beforePress.ok,
    `RANGE_TARGET_MOVED_BEFORE_PRESS (${label}): selector=${selector} startPt=(${startPt.x},${startPt.y}) beforePress=${JSON.stringify(beforePress)}`,
  );
  await mouseDragLine(page, startPt.x, startPt.y, endPt.x, endPt.y, 8);
  const probe = await page.evaluate<ClickProbeEvent | null>(`(() => {
    const p = window.stage1RangeProbe ?? null;
    delete window.stage1RangeProbe;
    return p;
  })()`);
  assertCondition(
    Boolean(probe?.matched),
    `RANGE_POINTERDOWN_MISSED (${label}): selector=${selector} probe=${JSON.stringify(probe)}`,
  );
}

async function dragStage1RegionOnPane(
  page: InputCdpSession,
  options: {
    label: string;
    kind: 'chest' | 'mesh';
    regionIndex: number;
    expectedInitial: { cx: number; cy: number };
    deltaRigX: number;
    deltaRigY: number;
    toggleBeforeDrag?: StageRegionDragDiagnostic['toggleBeforeDrag'];
    persist: (diagnostic: StageRegionDragDiagnostic) => Promise<void>;
  },
  timeoutMs = 5_000,
): Promise<StageRegionDragDiagnostic> {
  const diagnostic: StageRegionDragDiagnostic = {
    label: options.label,
    ...(options.toggleBeforeDrag ? { toggleBeforeDrag: options.toggleBeforeDrag } : {}),
  };
  const readExpr = `(() => {
    const editor = window.rigReviewEditor;
    const stage = editor?.stage?.();
    const root = document.getElementById('rig-root');
    const canvas = document.getElementById('rig-overlay');
    const pane = document.getElementById('rig-pane');
    if (!editor || !root || !root.parentElement || !canvas || !pane) return null;
    const isMesh = ${JSON.stringify(options.kind)} === 'mesh';
    const toggleBtn = document.getElementById(isMesh ? 'mesh-regions-edit' : 'chest-edit');
    let cx = NaN;
    let cy = NaN;
    let regionKey = '';
    if (isMesh) {
      const regions = editor.mesh?.regions?.();
      const r = Array.isArray(regions) ? regions[${options.regionIndex}] : null;
      cx = Number(r?.cx ?? NaN);
      cy = Number(r?.cy ?? NaN);
      regionKey = String(r?.name ?? 'region-' + ${options.regionIndex});
    } else {
      const prefix = ${options.regionIndex} === 0 ? 'bust-r' : 'bust-l';
      cx = Number(document.getElementById(prefix + '-x')?.value ?? NaN);
      cy = Number(document.getElementById(prefix + '-y')?.value ?? NaN);
      regionKey = prefix;
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
    const rect = node => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, left: r.left, top: r.top, width: r.width, height: r.height };
    };
    const startWorld = { x: -64 + cx, y: 128 - cy };
    const endWorld = { x: -64 + cx + ${options.deltaRigX}, y: 128 - cy - ${options.deltaRigY} };
    const startScreen = editor.screen(startWorld.x, startWorld.y);
    const endScreen = editor.screen(endWorld.x, endWorld.y);
    if (!startScreen || !endScreen || ![startScreen.x, startScreen.y, endScreen.x, endScreen.y].every(Number.isFinite)) return null;
    const inViewport =
      startScreen.x >= 0 &&
      startScreen.y >= 0 &&
      startScreen.x < window.innerWidth &&
      startScreen.y < window.innerHeight &&
      endScreen.x >= 0 &&
      endScreen.y >= 0 &&
      endScreen.x < window.innerWidth &&
      endScreen.y < window.innerHeight;
    const startHit = inViewport ? document.elementFromPoint(startScreen.x, startScreen.y) : null;
    const startHitInsidePane = Boolean(startHit && pane.contains(startHit) && !startHit.closest('button,input,select,textarea,a'));
    return {
      source: {
        inspectionStage: document.documentElement.dataset.inspectionStage ?? null,
        buildId: stage?.applied?.buildId ?? 'inspected',
        modelHash: stage?.modelHash ?? null,
        part: isMesh ? (editor.mesh?.part?.() ?? null) : (document.getElementById('stage-draft-label')?.textContent?.trim() ? 'torso' : null),
        toggleAriaPressed: toggleBtn?.getAttribute('aria-pressed') ?? null,
        regionKey,
        cx,
        cy,
      },
      root: { left: root.style.left, top: root.style.top, transform: root.style.transform },
      projection: { origin: editor.screen(0, 0), unitX: editor.screen(1, 0), unitY: editor.screen(0, 1) },
      pane: rect(pane),
      viewport: rect(root.parentElement),
      canvas: rect(canvas),
      handle: {
        startWorld,
        endWorld,
        startScreen,
        endScreen,
        startHitTag: startHit?.tagName ?? null,
        startHitId: startHit?.id ?? null,
        startHitInsidePane,
      },
    };
  })`;
  const sourceIdentity = (s: StageRegionDragSnapshot) => JSON.stringify(s.source);
  const geometry = (s: StageRegionDragSnapshot) => JSON.stringify(s);
  try {
    const settled = await withDeadline(`REGION_GEOMETRY_SETTLE:${options.label}`, timeoutMs, async signal => {
      let previous: StageRegionDragSnapshot | undefined;
      for (;;) {
        signal.throwIfAborted();
        const current = await page.evaluate<StageRegionDragSnapshot | null>(
          `new Promise(resolve => requestAnimationFrame(() => resolve(${readExpr}())))`,
        );
        signal.throwIfAborted();
        if (!current) continue;
        if (!diagnostic.read) {
          diagnostic.read = current;
          if (current.source.toggleAriaPressed !== 'true') {
            throw new Error(`REGION_DRAG_TOGGLE_NOT_PRESSED (${options.label}): ${JSON.stringify(current.source)}`);
          }
          if (current.source.cx !== options.expectedInitial.cx || current.source.cy !== options.expectedInitial.cy) {
            throw new Error(
              `REGION_INITIAL_COORDS_MISMATCH (${options.label}): expected=(${options.expectedInitial.cx},${options.expectedInitial.cy}) actual=(${current.source.cx},${current.source.cy})`,
            );
          }
          if (!current.handle.startHitInsidePane) {
            throw new Error(`REGION_HANDLE_NOT_HITTABLE (${options.label}): ${JSON.stringify(current.handle)}`);
          }
        }
        if (sourceIdentity(current) !== sourceIdentity(diagnostic.read)) {
          throw new Error(`REGION_SOURCE_CHANGED (${options.label})`);
        }
        if (previous && geometry(current) === geometry(previous)) {
          return current;
        }
        previous = current;
      }
    });
    diagnostic.settled = settled;
    const { startScreen, endScreen } = settled.handle;
    await page.mouse('mouseMoved', startScreen.x, startScreen.y);
    diagnostic.beforePress = await page.evaluate<StageRegionDragSnapshot>(`(() => {
      const read = ${readExpr};
      const before = read();
      window.stage1RegionPress = null;
      window.addEventListener('pointerdown', event => {
        const pane = document.getElementById('rig-pane');
        const t = event.target instanceof Element ? event.target : null;
        window.stage1RegionPress = {
          client: { x: event.clientX, y: event.clientY },
          target: (t?.tagName ?? '') + (t?.id ? '#' + t.id : ''),
          insideRigPane: Boolean(pane && t && pane.contains(t) && !t.closest('button,input,select,textarea,a')),
          snapshot: read(),
        };
      }, { capture: true, passive: true, once: true });
      return before;
    })()`);
    if (geometry(diagnostic.beforePress) !== geometry(settled)) {
      throw new Error(`REGION_GEOMETRY_CHANGED_BEFORE_PRESS (${options.label})`);
    }
    await page.mouse('mousePressed', startScreen.x, startScreen.y);
    for (let i = 1; i <= 8; i++) {
      const t = i / 8;
      await page.mouse(
        'mouseMoved',
        startScreen.x + (endScreen.x - startScreen.x) * t,
        startScreen.y + (endScreen.y - startScreen.y) * t,
      );
    }
    await page.mouse('mouseReleased', endScreen.x, endScreen.y);
    const readback = await page.evaluate<{
      press: StageRegionPressReadback | null;
      after: StageRegionDragSnapshot | null;
      applyDisabled: boolean;
      diffText: string;
    }>(`(() => {
      const p = window.stage1RegionPress ?? null;
      delete window.stage1RegionPress;
      return {
        press: p,
        after: ${readExpr}(),
        applyDisabled: Boolean(document.getElementById(${JSON.stringify(options.kind === 'mesh' ? 'mesh-panel-apply' : 'bust-apply')})?.disabled),
        diffText: document.getElementById('mesh-diff')?.textContent ?? '',
      };
    })()`);
    diagnostic.press = readback.press ?? undefined;
    diagnostic.after = readback.after ?? undefined;
    diagnostic.applyDisabledAfter = readback.applyDisabled;
    diagnostic.diffTextAfter = readback.diffText;
    if (!diagnostic.press) {
      throw new Error(`REGION_POINTERDOWN_NOT_OBSERVED (${options.label})`);
    }
    if (!diagnostic.press.insideRigPane) {
      throw new Error(`REGION_POINTERDOWN_WRONG_TARGET (${options.label}): target=${diagnostic.press.target}`);
    }
    if (!diagnostic.press.snapshot || geometry(diagnostic.press.snapshot) !== geometry(diagnostic.beforePress)) {
      throw new Error(`REGION_GEOMETRY_CHANGED_AT_PRESS (${options.label})`);
    }
    if (!diagnostic.after || diagnostic.after.source.cx === options.expectedInitial.cx) {
      throw new Error(
        `REGION_UNMOVED_AFTER_DRAG (${options.label}): beforeCx=${options.expectedInitial.cx} afterCx=${diagnostic.after?.source.cx ?? 'null'}`,
      );
    }
    return diagnostic;
  } finally {
    await options.persist(diagnostic);
  }
}

async function waitForDeltaApplySettled(
  page: Pick<InputCdpSession, 'evaluate'>,
  previousAppliedRaw: string,
  previousBuildId: string,
  label: string,
  timeoutMs = 60_000,
): Promise<{
  buildId: string;
  modelHash: string;
  delta: { ops: MeshOp[] };
  check?: { pass?: boolean };
}> {
  return await waitFor(label, async recordReadout => {
    const state = await page.evaluate<{
      busy: boolean;
      meshApplyDisabled: boolean;
      raw: string;
      statusText: string;
      statusError: boolean;
    }>(`(() => {
      const statusEl = document.getElementById('mesh-editor-status');
      return {
        busy: Boolean(window.rigReviewEditor?.stage?.()?.busy),
        meshApplyDisabled: Boolean(document.getElementById('mesh-apply')?.disabled),
        raw: document.getElementById('rebuild-applied')?.value ?? '',
        statusText: statusEl?.textContent?.trim() ?? '',
        statusError: Boolean(statusEl?.classList.contains('error')),
      };
    })()`);
    recordReadout(state);
    if (state.statusError) {
      throw new Error(`MESH_DELTA_APPLY_ERROR (${label}): ${state.statusText}`);
    }
    if (state.busy || state.meshApplyDisabled || !state.raw || state.raw === previousAppliedRaw) {
      return null;
    }
    const parsed = JSON.parse(state.raw) as {
      schema?: string;
      buildId?: string;
      modelHash?: string;
      delta?: { ops: MeshOp[] };
      check?: { pass?: boolean };
    };
    if (
      parsed.schema !== 'rig-review-applied/3' ||
      !parsed.buildId ||
      parsed.buildId === previousBuildId ||
      !parsed.modelHash ||
      !parsed.delta
    ) {
      return null;
    }
    return {
      buildId: parsed.buildId,
      modelHash: parsed.modelHash,
      delta: parsed.delta,
      check: parsed.check,
    };
  }, timeoutMs);
}

async function waitForSetupState(
  page: Pick<InputCdpSession, 'evaluate'>,
  predicate: (state: SetupReadout) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<SetupReadout> {
  return await waitFor(label, async recordReadout => {
    const state = await page.evaluate<SetupReadout>(`(() => {
      const chestBtn = document.getElementById('chest-edit');
      const bustApply = document.getElementById('bust-apply');
      const meshPanel = document.getElementById('mesh-panel');
      const meshEditBtn = document.getElementById('mesh-edit');
      const posed = window.rigReviewEditor?.posed?.('torso');
      const meshEdit = window.rigReviewEditor?.meshEdit?.();
      return {
        stage: document.documentElement.dataset.inspectionStage ?? null,
        draftLabel: document.getElementById('stage-draft-label')?.textContent?.trim() ?? '',
        chestPressed: chestBtn?.getAttribute('aria-pressed') === 'true',
        chestDisabled: Boolean(chestBtn?.hasAttribute('disabled') || chestBtn?.hidden),
        bustApplyDisabled: Boolean(bustApply?.hasAttribute('disabled')),
        meshOpen: Boolean(meshPanel && !meshPanel.hidden),
        meshPart: window.rigReviewEditor?.mesh?.part?.() ?? null,
        meshEditPressed: meshEditBtn?.getAttribute('aria-pressed') === 'true',
        meshEditSlot: meshEdit?.slot ?? null,
        meshEditVerts: Array.isArray(meshEdit?.vertices) ? meshEdit.vertices.length : 0,
        posedCount: Array.isArray(posed?.vertices) ? posed.vertices.length / 2 : 0,
        posedTris: Array.isArray(posed?.triangles) ? posed.triangles.length / 3 : 0,
        meshLayerChecked: Boolean(document.getElementById('layer-mesh')?.checked),
        overlayTris: window.rigReviewEditor?.mesh?.overlayTriangles?.('torso') ?? null,
      };
    })()`);
    recordReadout(state);
    return predicate(state) ? state : null;
  }, timeoutMs);
}

async function assertRefusedStage3(
  page: Pick<InputCdpSession, 'evaluate'>,
  locale: Locale,
  expectedRefusal: string,
): Promise<Stage3RefusedReadout> {
  return await waitFor(`Refused Stage 3 state (${locale})`, async recordReadout => {
    const readout = await page.evaluate<Stage3RefusedReadout>(`(() => {
      const status = document.querySelector('.review-stage-panel > [role=status]');
      const statusBox = status?.getBoundingClientRect();
      const modeSwitch = document.querySelector('.mode-switch');
      const controls = [...document.querySelectorAll('[data-mode],[data-inspector]')].map(btn => ({
        mode: btn.getAttribute('data-mode'),
        inspector: btn.getAttribute('data-inspector'),
        disabled: Boolean(btn.disabled),
        rects: btn.getClientRects().length,
      }));
      const usableModes = controls.filter(c => !c.disabled && c.rects > 0).map(c => c.mode ?? c.inspector ?? 'unknown');
      return {
        lang: document.documentElement.lang,
        stage: document.documentElement.dataset.inspectionStage ?? null,
        stageRefused: document.documentElement.dataset.stageRefused ?? null,
        statusText: status?.textContent ?? '',
        statusVisible: Boolean(status && statusBox && statusBox.width > 0 && statusBox.height > 0 && getComputedStyle(status).visibility !== 'hidden'),
        modeSwitchHidden: Boolean(modeSwitch?.hidden),
        modeSwitchDisplay: modeSwitch ? getComputedStyle(modeSwitch).display : 'missing',
        modeSwitchRects: modeSwitch ? modeSwitch.getClientRects().length : 0,
        usableModes,
      };
    })()`);
    recordReadout({ ...readout, expectedRefusal });
    if (
      readout.lang === locale &&
      readout.stage === '3' &&
      readout.stageRefused === 'true' &&
      readout.statusText === expectedRefusal &&
      readout.statusVisible &&
      readout.modeSwitchHidden &&
      readout.modeSwitchDisplay === 'none' &&
      readout.modeSwitchRects === 0 &&
      readout.usableModes.length === 0
    ) {
      return readout;
    }
    return null;
  });
}

async function verifyStage1IframeAndApiAgainstDisk(
  page: Pick<InputCdpSession, 'evaluate'>,
  expectedBuildId: string,
  expectedSourceHash: string,
  disk: DiskCompiledGeometry,
  expectedEditable = true,
): Promise<Stage1IframeReadout> {
  const modelUrl = servedModelUrlForBuild(expectedBuildId);
  return await waitFor(`Stage 1 iframe & /api/stage-parts build=${expectedBuildId} tris=${disk.triangleCount}`, async recordReadout => {
    const info = await page.evaluate<{
      gateReason?: string;
      stage: string | null;
      iframeReady: boolean;
      selectedPart: string;
      snapInspectionSourceHash: string;
      correctionLine: string;
      figureVertices: number;
      figureTriangles: number;
      buttonLabels: string[];
      stagePartsStatus: number;
      stagePartsOk: boolean;
      stagePartsBodyPreview: string;
      modelStatus: number;
      modelOk: boolean;
      modelBodyPreview: string;
      apiVerdictSourceHash: string;
      apiInspectionSourceHash: string;
      apiDraftInspectionSourceHash: string;
      apiBuildId: string;
      apiVertices: number;
      apiTriangles: number;
      itemW: number;
      itemH: number;
      meshWidth: number;
      meshHeight: number;
      meshVertices: number[];
      meshTriangles: number[];
      servedModelText: string | null;
    }>(`(async () => {
      const stage = document.documentElement.dataset.inspectionStage ?? null;
      const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
      const doc = frame?.contentDocument;
      const win = frame?.contentWindow;
      const iframeReady = Boolean(doc && win && doc.body?.dataset?.ready === 'true');
      const snap = win?.rigReviewStageParts?.snapshot?.() ?? null;
      const activeBtn = doc?.querySelector('#pv-items button[data-pv-item][aria-current="true"]');
      const selectedPart = activeBtn?.getAttribute('data-pv-item') ?? snap?.part ?? '';
      const correctionLine = doc?.querySelector('#pv-corrections > p')?.textContent?.trim() ?? '';
      const figVerts = Number(doc?.querySelector('#pv-mesh-panel dd[data-mesh-figure="vertices"]')?.textContent ?? NaN);
      const figTris = Number(doc?.querySelector('#pv-mesh-panel dd[data-mesh-figure="triangles"]')?.textContent ?? NaN);
      const buttons = doc ? [...doc.querySelectorAll('#pv-corrections button')].map(b => b.textContent?.trim() ?? '') : [];
      const [res, modelRes] = await Promise.all([
        fetch('api/stage-parts', { headers: { 'X-Review-Stage-Build': ${JSON.stringify(expectedBuildId)} } }),
        fetch(${JSON.stringify(modelUrl)}),
      ]);
      const [rawStageText, rawModelText] = await Promise.all([res.text(), modelRes.text()]);
      let apiData = null;
      if (res.ok) {
        try { apiData = JSON.parse(rawStageText); } catch {}
      }
      const mapping = apiData?.draft?.mappings?.find(m => m.part === 'torso');
      const torsoItem = apiData?.items?.find(i => i.name === 'torso');
      return {
        stage,
        iframeReady,
        selectedPart,
        snapInspectionSourceHash: snap?.inspectionSourceHash ?? '',
        correctionLine,
        figureVertices: figVerts,
        figureTriangles: figTris,
        buttonLabels: buttons,
        stagePartsStatus: res.status,
        stagePartsOk: res.ok,
        stagePartsBodyPreview: rawStageText.slice(0, 240),
        modelStatus: modelRes.status,
        modelOk: modelRes.ok,
        modelBodyPreview: modelRes.ok ? '(length ' + rawModelText.length + ')' : rawModelText.slice(0, 240),
        apiVerdictSourceHash: apiData?.sourceHash ?? '',
        apiInspectionSourceHash: apiData?.inspectionSourceHash ?? '',
        apiDraftInspectionSourceHash: apiData?.draft?.inspectionSourceHash ?? '',
        apiBuildId: apiData?.draft?.buildId ?? '',
        apiVertices: Number(mapping?.vertices ?? NaN),
        apiTriangles: Number(mapping?.triangles ?? NaN),
        itemW: Number(torsoItem?.w ?? NaN),
        itemH: Number(torsoItem?.h ?? NaN),
        meshWidth: Number(torsoItem?.mesh?.width ?? NaN),
        meshHeight: Number(torsoItem?.mesh?.height ?? NaN),
        meshVertices: Array.isArray(torsoItem?.mesh?.vertices) ? torsoItem.mesh.vertices : [],
        meshTriangles: Array.isArray(torsoItem?.mesh?.triangles) ? torsoItem.mesh.triangles : [],
        servedModelText: modelRes.ok ? rawModelText : null,
      };
    })()`);
    const baseDiagnostic = {
      expectedBuildId,
      expectedSourceHash,
      stage: info.stage,
      iframeReady: info.iframeReady,
      selectedPart: info.selectedPart,
      snapInspectionSourceHash: info.snapInspectionSourceHash,
      correctionLine: info.correctionLine,
      figureVertices: info.figureVertices,
      figureTriangles: info.figureTriangles,
      buttonLabels: info.buttonLabels,
      apiBuildId: info.apiBuildId,
      apiInspectionSourceHash: info.apiInspectionSourceHash,
      apiDraftInspectionSourceHash: info.apiDraftInspectionSourceHash,
      apiVerdictSourceHash: info.apiVerdictSourceHash,
      apiVertices: info.apiVertices,
      apiTriangles: info.apiTriangles,
      stagePartsFetch: {
        url: 'api/stage-parts',
        status: info.stagePartsStatus,
        ok: info.stagePartsOk,
        bodyPreview: info.stagePartsBodyPreview,
      },
      modelFetch: {
        url: modelUrl,
        status: info.modelStatus,
        ok: info.modelOk,
        bodyPreview: info.modelBodyPreview,
      },
    };
    if (info.stage !== '1' || !info.iframeReady || info.selectedPart !== 'torso') {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'stage !== 1 or iframe not ready or selectedPart !== torso' });
      return null;
    }
    if (!info.stagePartsOk || !info.modelOk || info.servedModelText === null) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'stagePartsFetch or modelFetch not ok' });
      return null;
    }
    if (
      info.snapInspectionSourceHash !== expectedSourceHash ||
      info.apiInspectionSourceHash !== expectedSourceHash ||
      info.apiDraftInspectionSourceHash !== expectedSourceHash
    ) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'inspectionSourceHash mismatch' });
      return null;
    }
    if (!/^[0-9a-f]{64}$/.test(info.apiVerdictSourceHash)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'invalid apiVerdictSourceHash' });
      return null;
    }
    const servedModelHash = sha256Hex(info.servedModelText);
    if (servedModelHash !== disk.modelHash || info.servedModelText !== disk.rawText) {
      recordReadout({ ...baseDiagnostic, servedModelHash, mismatchReason: 'servedModelText/hash mismatch' });
      return null;
    }
    if (info.apiBuildId !== expectedBuildId) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'apiBuildId mismatch' });
      return null;
    }
    if (info.apiVertices !== disk.vertexCount || info.apiTriangles !== disk.triangleCount) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'apiVertices/apiTriangles mismatch' });
      return null;
    }
    if (info.figureVertices !== disk.vertexCount || info.figureTriangles !== disk.triangleCount) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'figureVertices/figureTriangles mismatch' });
      return null;
    }
    if (info.meshWidth !== disk.width || info.meshHeight !== disk.height) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'meshWidth/meshHeight mismatch' });
      return null;
    }
    if (!equalIntArrays(info.meshTriangles, disk.triangles)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'meshTriangles array mismatch' });
      return null;
    }
    const ox = (info.meshWidth - info.itemW) / 2;
    const oy = (info.meshHeight - info.itemH) / 2;
    if (!Number.isInteger(ox) || !Number.isInteger(oy) || info.meshVertices.length !== disk.uvs.length) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'crop window ox/oy or meshVertices length mismatch' });
      return null;
    }
    const reconstructedUvs = info.meshVertices.map((v, i) =>
      i % 2 ? (v + oy) / info.meshHeight : (v + ox) / info.meshWidth,
    );
    if (!equalFloat32Arrays(reconstructedUvs, disk.uvs)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'reconstructedUvs float32 array mismatch' });
      return null;
    }
    if (!info.correctionLine.includes(`v ${disk.vertexCount} t ${disk.triangleCount}`)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'correctionLine v/t mismatch' });
      return null;
    }
    if (!info.correctionLine.endsWith(`· ${expectedBuildId}`)) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'correctionLine buildId suffix mismatch' });
      return null;
    }
    if (expectedEditable && info.buttonLabels.length !== 3) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'expected 3 correction buttons' });
      return null;
    }
    if (!expectedEditable && info.buttonLabels.length !== 0) {
      recordReadout({ ...baseDiagnostic, mismatchReason: 'expected 0 correction buttons' });
      return null;
    }
    return {
      selectedPart: info.selectedPart,
      buildId: info.apiBuildId,
      inspectionSourceHash: info.apiInspectionSourceHash,
      verdictSourceHash: info.apiVerdictSourceHash,
      servedModelHash,
      correctionLine: info.correctionLine,
      figureVertices: info.figureVertices,
      figureTriangles: info.figureTriangles,
      buttonLabels: info.buttonLabels,
    };
  });
}

async function capturePrecedingView(
  page: Pick<InputCdpSession, 'evaluate'>,
): Promise<PrecedingViewSnapshot> {
  return await page.evaluate<PrecedingViewSnapshot>(`(() => {
    const panel = document.querySelector('.review-stage-panel');
    const layout = document.querySelector('.layout');
    const activeMode = document.querySelector('[data-mode][aria-pressed="true"]')?.getAttribute('data-mode') ?? null;
    const activeInspector = document.querySelector('[data-inspector][aria-pressed="true"],[data-inspector][aria-selected="true"]')?.getAttribute('data-inspector') ?? null;
    const stageState = window.rigReviewEditor?.stage?.() ?? null;
    const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
    const doc = frame?.contentDocument;
    const snap = frame?.contentWindow?.rigReviewStageParts?.snapshot?.() ?? null;
    const correctionLine = doc?.querySelector('#pv-corrections > p')?.textContent?.trim() ?? '';
    return {
      inspectionStage: document.documentElement.dataset.inspectionStage ?? null,
      stageRefused: document.documentElement.dataset.stageRefused ?? null,
      panelHidden: panel instanceof HTMLElement ? panel.hidden : null,
      layoutInert: layout instanceof HTMLElement ? Boolean(layout.inert) : null,
      activeMode,
      activeInspector,
      stageModelHash: stageState?.modelHash ?? null,
      appliedBuildId: stageState?.applied?.buildId ?? null,
      iframePart: snap?.part ?? (doc?.querySelector('#pv-items button[data-pv-item][aria-current="true"]')?.getAttribute('data-pv-item') ?? null),
      iframeBuildId: correctionLine.split('·').at(-1)?.trim() ?? null,
      iframeSourceHash: snap?.inspectionSourceHash ?? null,
      iframeCorrectionLine: correctionLine,
    };
  })()`);
}

async function copyScratchArtifacts(
  scratchDir: string,
  destDir: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  await mkdir(destDir, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const rel of files) {
    const srcPath = join(scratchDir, rel);
    const flatName = rel.replaceAll('/', '-');
    const dstPath = join(destDir, flatName);
    const bytes = await readFile(srcPath);
    await writeFile(dstPath, bytes);
    hashes[flatName] = sha256Hex(bytes);
  }
  return hashes;
}

async function installSyntheticToolchain(
  toolchainRoot: string,
  baseRigText: string,
  baseReportText: string,
  baseModelText: string,
): Promise<void> {
  const partsBinDir = join(toolchainRoot, 'node_modules/@rig-c/parts/bin');
  const coreBinDir = join(toolchainRoot, 'node_modules/@rig-c/core/bin');
  await mkdir(partsBinDir, { recursive: true });
  await mkdir(coreBinDir, { recursive: true });

  await writeFile(
    join(toolchainRoot, 'node_modules/@rig-c/parts/package.json'),
    JSON.stringify({ name: '@rig-c/parts', version: '2.31.0', bin: { 'rig-parts': './bin/rig-parts.cjs' } }, null, 2) + '\n',
  );
  await writeFile(
    join(toolchainRoot, 'node_modules/@rig-c/core/package.json'),
    JSON.stringify({ name: '@rig-c/core', version: '3.6.0', bin: { rigc: './bin/rigc.cjs' } }, null, 2) + '\n',
  );

  await writeFile(
    join(partsBinDir, 'rig-parts.cjs'),
    `const fs = require('fs'), path = require('path'), crypto = require('crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const a = process.argv.slice(2), f = n => a[a.indexOf(n) + 1];
if (a[0] === '--version') { console.log('2.31.0'); process.exit(0); }
if (a[0] === 'remesh') {
  const out = f('--out'), part = f('--part'), inRig = f('--rig');
  fs.mkdirSync(path.join(out, 'images'), { recursive: true });
  const imgDir = path.join(inRig, 'images');
  const revisionRows = [];
  for (const name of fs.readdirSync(imgDir).sort()) {
    const bytes = fs.readFileSync(path.join(imgDir, name));
    fs.writeFileSync(path.join(out, 'images', name), bytes);
    revisionRows.push({ path: 'images/' + name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const rig = JSON.parse(${JSON.stringify(baseRigText)});
  const reports = JSON.parse(${JSON.stringify(baseReportText)});
  const isDelta = a.includes('--delta');
  let cut = 6;
  if (isDelta) {
    cut = 12;
  } else {
    const meshDoc = JSON.parse(fs.readFileSync(f('--mesh'), 'utf8'));
    const leftCx = meshDoc?.contour?.regions?.[1]?.cx;
    if (typeof leftCx === 'number' && leftCx !== 92) cut = 18;
  }
  rig.skins.default.torso.torso.triangles.splice(-cut);
  const triCount = rig.skins.default.torso.torso.triangles.length / 3;
  reports[0].triangles = triCount;
  const rigBytes = JSON.stringify(rig);
  const motionBytes = fs.readFileSync(path.join(inRig, 'motion.json'));
  const reportBytes = JSON.stringify(reports);
  fs.writeFileSync(path.join(out, 'rig.json'), rigBytes);
  fs.writeFileSync(path.join(out, 'motion.json'), motionBytes);
  fs.writeFileSync(path.join(out, 'mesh_report.json'), reportBytes);
  revisionRows.push(
    { path: 'rig.json', bytes: Buffer.byteLength(rigBytes), sha256: sha(rigBytes) },
    { path: 'motion.json', bytes: motionBytes.length, sha256: sha(motionBytes) },
    { path: 'mesh_report.json', bytes: Buffer.byteLength(reportBytes), sha256: sha(reportBytes) },
  );
  const remeshDoc = {
    spec: 'rig-parts-remesh/1',
    request: { part, page_edges: 'free', pack_shape: 'polygon' },
    target: {
      before: { vertices: 30, triangles: 40, hull: 18 },
      after: { vertices: 30, triangles: triCount, hull: 18 },
    },
    check: {
      revision: {
        pass: true,
        line: 'check: PASS — 2 bar(s) met',
        status: { gate: 'PASS', BREATH_VISIBLE: 'PASS', PART_SUPPORT_REPORT: 'PASS', TEXTURE_STRETCH: 'PASS' },
      },
    },
    revision: revisionRows,
  };
  fs.writeFileSync(path.join(out, 'remesh.json'), JSON.stringify(remeshDoc));
  console.log('rig-parts remesh: wrote 3 file(s) under ' + out);
  process.exit(0);
}
process.exit(1);
`,
  );

  await writeFile(
    join(coreBinDir, 'rigc.cjs'),
    `const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), f = n => a[a.indexOf(n) + 1];
if (a[0] === '--version') { console.log('3.6.0'); process.exit(0); }
const out = f('--out'), rigPath = f('--rig'), rig = JSON.parse(fs.readFileSync(rigPath, 'utf8'));
fs.mkdirSync(out, { recursive: true });
const model = JSON.parse(${JSON.stringify(baseModelText)});
model.skins[0].attachments.torso.torso.triangles = rig.skins.default.torso.torso.triangles;
fs.writeFileSync(path.join(out, 'skeleton.model.json'), JSON.stringify(model));
const pngSource = path.resolve(rigPath, '..', '..', 'images', 'background.png');
const fallbackPng = path.join(${JSON.stringify(toolchainRoot)}, 'atlas.png');
fs.copyFileSync(fs.existsSync(fallbackPng) ? fallbackPng : pngSource, path.join(out, 'skeleton.png'));
console.log('rigc: wrote ' + path.join(out, 'skeleton.model.json'));
process.exit(0);
`,
  );
}

async function prepareResealedContourProject(
  sealedFixtureRoot: string,
  targetProjectRoot: string,
  toolchainRoot: string,
): Promise<{ configSha: string }> {
  await cp(sealedFixtureRoot, targetProjectRoot, { recursive: true });
  await cp(
    join(sealedFixtureRoot, 'derived/drafts/remesh/out/check/build/skeleton.png'),
    join(toolchainRoot, 'atlas.png'),
  );
  const configPath = join(targetProjectRoot, 'derived/drafts/remesh/config.json');
  const configDoc = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  configDoc.meshes = {
    torso: {
      r: 16,
      segments: [['body', [64, 8], [64, 72]]],
      contour: {
        tolerance: 2,
        margin: 2,
        spacing: 16,
        maxEdge: 40,
        stray: 0,
        bridges: true,
        regions: [
          { name: 'bust_r', shape: 'circle', cx: 36, cy: 64, r: 10, bone: 'body', spacing: 8, band: 6 },
          { name: 'bust_l', shape: 'circle', cx: 92, cy: 64, r: 10, bone: 'body', spacing: 8, band: 6 },
        ],
      },
    },
  };
  const configBytes = Buffer.from(JSON.stringify(configDoc, null, 2) + '\n');
  await writeFile(configPath, configBytes);
  const configSha = sha256Hex(configBytes);

  const projectPath = join(targetProjectRoot, 'project.json');
  const projectDoc = JSON.parse(await readFile(projectPath, 'utf8')) as {
    drafts: Array<{ config: { path: string; sha256: string } }>;
  };
  projectDoc.drafts[0]!.config.sha256 = configSha;
  await writeFile(projectPath, JSON.stringify(projectDoc, null, 2) + '\n');
  return { configSha };
}

async function ensureActualToolchain(toolchainRoot: string): Promise<void> {
  const partsManifest = join(toolchainRoot, 'node_modules/@rig-c/parts/package.json');
  const coreManifest = join(toolchainRoot, 'node_modules/@rig-c/core/package.json');
  try {
    const partsPkg = JSON.parse(await readFile(partsManifest, 'utf8')) as { version?: string };
    const corePkg = JSON.parse(await readFile(coreManifest, 'utf8')) as { version?: string };
    if (partsPkg.version === '2.31.0' && corePkg.version === '3.6.0') return;
  } catch {
    // Install exact pinned toolchain below.
  }
  await mkdir(toolchainRoot, { recursive: true });
  await writeFile(
    join(toolchainRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'review-562-actual-toolchain',
        private: true,
        dependencies: {
          '@rig-c/parts': '2.31.0',
          '@rig-c/core': '3.6.0',
        },
      },
      null,
      2,
    ) + '\n',
  );
  const res = Bun.spawnSync(['bun', 'install', '--no-save'], {
    cwd: toolchainRoot,
    timeout: 60_000,
    env: {
      ...process.env,
      UV_THREADPOOL_SIZE: '4',
      BUN_JSC_forceRAMSize: '6442450944',
      NODE_OPTIONS: '--max-old-space-size=6144',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (res.exitCode !== 0) {
    throw new Error(`Failed to install @rig-c/parts@2.31.0 and @rig-c/core@3.6.0 in ${toolchainRoot}: ${res.stderr.toString()}`);
  }
  const partsPkg = JSON.parse(await readFile(partsManifest, 'utf8')) as { version?: string };
  const corePkg = JSON.parse(await readFile(coreManifest, 'utf8')) as { version?: string };
  assertCondition(partsPkg.version === '2.31.0', `Expected @rig-c/parts@2.31.0, got ${String(partsPkg.version)}`);
  assertCondition(corePkg.version === '3.6.0', `Expected @rig-c/core@3.6.0, got ${String(corePkg.version)}`);
}

function createCdpErrorCollector(): {
  runtimeExceptions: string[];
  consoleErrors: string[];
  onEvent: (event: CdpPageEvent, send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => void;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  assertClean: (contextLabel: string) => void;
} {
  const runtimeExceptions: string[] = [];
  const consoleErrors: string[] = [];
  let capturedSend: ((method: string, params?: Record<string, unknown>) => Promise<unknown>) | null = null;
  return {
    runtimeExceptions,
    consoleErrors,
    onEvent(event: CdpPageEvent, send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
      if (event.sessionId) capturedSend = send;
      if (event.method === 'Runtime.exceptionThrown') {
        const details = (event.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } } | undefined)
          ?.exceptionDetails;
        const msg = details?.exception?.description ?? details?.text ?? JSON.stringify(event.params ?? {});
        runtimeExceptions.push(msg);
      } else if (event.method === 'Runtime.consoleAPICalled') {
        const params = event.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> } | undefined;
        if (params?.type === 'error') {
          const text = (params.args ?? []).map(a => a.description ?? String(a.value ?? '')).join(' ');
          consoleErrors.push(text);
        }
      }
    },
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      assertCondition(capturedSend !== null, `CDP send callback not yet captured before ${method}`);
      return await capturedSend(method, params);
    },
    assertClean(contextLabel: string) {
      assertCondition(
        runtimeExceptions.length === 0,
        `Runtime.exceptionThrown in ${contextLabel}: ${runtimeExceptions.join(' | ')}`,
      );
      assertCondition(
        consoleErrors.length === 0,
        `Console error in ${contextLabel}: ${consoleErrors.join(' | ')}`,
      );
    },
  };
}

async function captureFailureArtifacts(
  artifactsDir: string,
  page: InputCdpSession | undefined,
  error: unknown,
  checkpoints: readonly CheckpointEntry[],
  runtimeExceptions: readonly string[],
  consoleErrors: readonly string[],
  stateDir?: string,
  ownedWorkers: readonly RecordFile[] = [],
  frontPids: readonly number[] = [],
): Promise<void> {
  await mkdir(artifactsDir, { recursive: true });
  if (page) {
    try {
      await writeFile(join(artifactsDir, 'failure-screenshot.png'), await page.screenshot());
    } catch {
      // ignore screenshot failure during error handling
    }
  }
  let domState: unknown = null;
  if (page) {
    try {
      domState = await page.evaluate(`({
        url: location.href,
        lang: document.documentElement.lang,
        inspectionStage: document.documentElement.dataset.inspectionStage ?? null,
        stageRefused: document.documentElement.dataset.stageRefused ?? null,
        stageStatus: document.querySelector('.review-stage-panel [role="status"]')?.textContent ?? null,
        chestStatus: document.getElementById('chest-editor-status')?.textContent ?? null,
        meshStatus: document.getElementById('mesh-status')?.textContent ?? null,
        meshEditorStatus: document.getElementById('mesh-editor-status')?.textContent ?? null,
        appliedStatus: document.getElementById('applied-status')?.textContent ?? null,
        stage: window.rigReviewEditor?.stage?.() ?? null,
      })`);
    } catch {
      // ignore evaluate failure during error handling
    }
  }
  const retainedScratchFiles: string[] = [];
  let teardownDiagnostics: Record<string, unknown> | null = null;
  if (stateDir) {
    const controlDir = join(stateDir, 'open');
    const controlDirEntries = await readdir(controlDir).catch(() => [] as string[]);
    const retainedOpenLogs: string[] = [];
    for (const entryName of controlDirEntries) {
      if (!entryName.endsWith('.log') && !entryName.endsWith('.json')) continue;
      try {
        const bytes = await readFile(join(controlDir, entryName));
        const outRel = join('failure-open-state', entryName);
        const outAbs = join(artifactsDir, outRel);
        await mkdir(dirname(outAbs), { recursive: true });
        await writeFile(outAbs, bytes);
        retainedOpenLogs.push(outRel);
      } catch {
        // entry removed concurrently
      }
    }
    const workerReadings: Array<Record<string, unknown>> = [];
    for (const worker of ownedWorkers) {
      const registryPath = join(controlDir, `${worker.key}.json`);
      const registryExists = await lstat(registryPath).then(() => true, () => false);
      const registryRecord = await readRecord(registryPath, worker.key).catch(e => String(e));
      const pidRunning = running(worker.pid);
      const statusAlive = await alive(worker);
      const procStatus = await readFile(`/proc/${worker.pid}/status`, 'utf8').then(s => s.slice(0, 2048), () => null);
      const procStat = await readFile(`/proc/${worker.pid}/stat`, 'utf8').then(s => s.trim(), () => null);
      const procCmdline = await readFile(`/proc/${worker.pid}/cmdline`, 'utf8').then(
        s => s.replaceAll('\0', ' ').trim(),
        () => null,
      );
      const logFileName = `${worker.key}.${worker.nonce}.log`;
      const logContent = await readFile(join(controlDir, logFileName), 'utf8').then(s => s.slice(0, 8192), () => null);
      workerReadings.push({
        key: worker.key,
        nonce: worker.nonce,
        pid: worker.pid,
        origin: worker.origin,
        registryExists,
        registryRecordPresent: registryRecord !== null && typeof registryRecord === 'object',
        pidRunning,
        statusAlive,
        procStatus,
        procStat,
        procCmdline,
        logFileName,
        logContent,
      });
    }
    const frontReadings: Array<Record<string, unknown>> = [];
    for (const fpid of frontPids) {
      const pidRunning = running(fpid);
      const procStatus = await readFile(`/proc/${fpid}/status`, 'utf8').then(s => s.slice(0, 2048), () => null);
      const procStat = await readFile(`/proc/${fpid}/stat`, 'utf8').then(s => s.trim(), () => null);
      const procCmdline = await readFile(`/proc/${fpid}/cmdline`, 'utf8').then(
        s => s.replaceAll('\0', ' ').trim(),
        () => null,
      );
      frontReadings.push({
        pid: fpid,
        pidRunning,
        procStatus,
        procStat,
        procCmdline,
      });
    }
    teardownDiagnostics = {
      controlDirEntries,
      retainedOpenLogs,
      workers: workerReadings,
      fronts: frontReadings,
    };

    for (const bucket of ['rebuild', 'rebuild-kept']) {
      const bucketDir = join(stateDir, bucket);
      try {
        const sourceHashes = await readdir(bucketDir);
        for (const sh of sourceHashes) {
          const shDir = join(bucketDir, sh);
          const buildIds = await readdir(shDir).catch(() => [] as string[]);
          for (const bid of buildIds) {
            const bidDir = join(shDir, bid);
            for (const candidateRel of [
              'result.json',
              'mesh.json',
              'mesh-edit.json',
              'config.json',
              'revision/remesh.json',
              'rig/remesh.json',
              'build/skeleton.model.json',
            ]) {
              try {
                const bytes = await readFile(join(bidDir, candidateRel));
                const outRel = join('failure-scratch', bucket, bid, candidateRel.replaceAll('/', '-'));
                const outAbs = join(artifactsDir, outRel);
                await mkdir(dirname(outAbs), { recursive: true });
                await writeFile(outAbs, bytes);
                retainedScratchFiles.push(outRel);
              } catch {
                // candidate file absent in this build directory
              }
            }
          }
        }
      } catch {
        // bucket directory absent
      }
    }
  }
  await writeFile(
    join(artifactsDir, 'failure-diagnostic.json'),
    JSON.stringify(
      {
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
        lastWaiterDiagnostic,
        domState,
        runtimeExceptions,
        consoleErrors,
        checkpoints,
        retainedScratchFiles,
        teardownDiagnostics,
      },
      null,
      2,
    ) + '\n',
  );
}

async function runSyntheticPhase(
  sealedFixtureRoot: string,
  inventoryPath: string,
  artifactsDir: string,
): Promise<Record<string, unknown>> {
  return await withDeadline('STAGE1_SYNTHETIC_PHASE', 480_000, async () => {
    await mkdir(artifactsDir, { recursive: true });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review-562-synthetic-')));
    const projectRoot = join(root, 'contour-project');
    const lockedRoot = join(root, 'locked-project');
    const toolchainRoot = join(root, 'toolchain');
    const stateDir = join(root, 'state');
    const controlDir = join(stateDir, 'open');
    const frontPort = allocateUnusedLoopbackPort();

    let page: InputCdpSession | undefined;
    const ownedWorkers: RecordFile[] = [];
    const frontPids = new Set<number>();
    const checkpoints: CheckpointEntry[] = [];
    const errorCollector = createCdpErrorCollector();

    const recordCheckpoint = async (step: string, detail?: Record<string, unknown>) => {
      checkpoints.push({ at: new Date().toISOString(), step, ...(detail ? { detail } : {}) });
      await writeFile(join(artifactsDir, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2) + '\n');
    };

    try {
      await verifyFixtureInventory(sealedFixtureRoot, inventoryPath);
      await recordCheckpoint('verified-sealed-fixture-inventory-before');

      const baseRigText = await readFile(join(sealedFixtureRoot, 'derived/drafts/remesh/out/rig.json'), 'utf8');
      const baseReportText = await readFile(join(sealedFixtureRoot, 'derived/drafts/remesh/out/mesh_report.json'), 'utf8');
      const baseModelText = await readFile(
        join(sealedFixtureRoot, 'derived/drafts/remesh/out/check/build/skeleton.model.json'),
        'utf8',
      );
      await installSyntheticToolchain(toolchainRoot, baseRigText, baseReportText, baseModelText);
      const { configSha } = await prepareResealedContourProject(sealedFixtureRoot, projectRoot, toolchainRoot);

      const syntheticInventoryBefore = await collectFileHashes(projectRoot);
      assertCondition(syntheticInventoryBefore.size === 209, `Expected 209 files in resealed synthetic project, got ${syntheticInventoryBefore.size}`);
      await writeFile(
        join(artifactsDir, 'resealed-project-inventory-before.json'),
        JSON.stringify({ files: mapToInventoryEntries(syntheticInventoryBefore) }, null, 2) + '\n',
      );
      await recordCheckpoint('prepared-resealed-contour-project', { configSha, fileCount: syntheticInventoryBefore.size });

      const inspectedModelPath = join(projectRoot, 'derived/drafts/remesh/out/check/build/skeleton.model.json');
      const diskInspected = await readDiskCompiledGeometry(inspectedModelPath);
      assertCondition(diskInspected.vertexCount === 30 && diskInspected.triangleCount === 40, 'Expected 30v / 40t in inspected model');

      const openInputs = {
        input: join(projectRoot, 'derived/drafts/remesh/out/check'),
        project: { root: projectRoot, draftId: 'remesh', picksDir: 'inputs/references' } as const,
      };
      const loadedPkg = await loadOpenPackage(openInputs);
      assertCondition(loadedPkg.mode === 'single' && loadedPkg.joined?.draft, 'Expected joined pre-rig draft package');
      assertCondition(loadedPkg.p.manifest.model === undefined, 'Stage 1 pre-rig draft must omit manifest.model');

      const launchOptions = {
        stateDir,
        cwd: toolchainRoot,
        frontPort,
        frontIdleMs: 1200,
        graceMs: 400,
        idleMs: 5_000,
      };
      const opened = await openReview(openInputs, launchOptions);
      const claimed = await claimOwnedWorker(opened, controlDir, frontPort, ownedWorkers);
      frontPids.add(claimed.frontPid);

      page = await launchCdpSession(join(root, 'browser-profile'), {
        sendDeadlineMs: 10_000,
        onEvent: errorCollector.onEvent,
      });
      await page.setViewport(1440, 1000);
      const localeReceipts: Record<Locale, unknown> = {} as Record<Locale, unknown>;

      for (const locale of ['en', 'ko'] as const) {
        const localeScratchOut = join(artifactsDir, 'scratch', locale);
        await mkdir(localeScratchOut, { recursive: true });

        const targetUrl = new URL(opened.url);
        targetUrl.searchParams.set('lang', locale);
        await page.goto(targetUrl.href, locale);
        await waitForStage1Readiness(page, 'PAGE_NOT_READY');
        let koPersistedDraftBeforeClear: Record<string, unknown> | null = null;
        if (locale === 'ko') {
          const persisted = await page.evaluate<{
            lang: string;
            bustRx: number;
            bustRy: number;
            rebuildAppliedLength: number;
            localStorageKeys: string[];
          }>(`({
            lang: document.documentElement.lang,
            bustRx: Number(document.getElementById('bust-r-x')?.value ?? NaN),
            bustRy: Number(document.getElementById('bust-r-y')?.value ?? NaN),
            rebuildAppliedLength: (document.getElementById('rebuild-applied')?.value ?? '').trim().length,
            localStorageKeys: Object.keys(localStorage),
          })`);
          assertCondition(
            persisted.lang === 'ko' &&
              persisted.bustRx === 42 &&
              persisted.bustRy === 64 &&
              persisted.rebuildAppliedLength > 0 &&
              persisted.localStorageKeys.length > 0,
            `Expected persisted EN draft (bust_r cx=42, cy=64) to survive KO navigation before profile storage clear, got ${JSON.stringify(persisted)}`,
          );
          const neutralUrl = new URL('styles.css', opened.url);
          await page.goto(neutralUrl.href);
          await errorCollector.send('Storage.clearDataForOrigin', {
            origin: targetUrl.origin,
            storageTypes: 'local_storage',
          });
          const isolation = await page.evaluate<{
            origin: string;
            pathname: string;
            hasAppGlobal: boolean;
            keysAfterClear: string[];
          }>(`(() => {
            localStorage.clear();
            return {
              origin: location.origin,
              pathname: location.pathname,
              hasAppGlobal: typeof window.rigReviewEditor !== 'undefined',
              keysAfterClear: Object.keys(localStorage),
            };
          })()`);
          assertCondition(
            isolation.origin === targetUrl.origin &&
              isolation.pathname === neutralUrl.pathname &&
              !isolation.hasAppGlobal &&
              isolation.keysAfterClear.length === 0,
            `Expected neutral same-origin storage isolation at ${neutralUrl.href}, got ${JSON.stringify(isolation)}`,
          );
          await page.goto(targetUrl.href, locale);
          await waitForStage1Readiness(page, 'PAGE_NOT_READY');
          const postReloadClean = await page.evaluate<{
            lang: string;
            bustRx: number;
            bustRy: number;
            rebuildAppliedLength: number;
          }>(`({
            lang: document.documentElement.lang,
            bustRx: Number(document.getElementById('bust-r-x')?.value ?? NaN),
            bustRy: Number(document.getElementById('bust-r-y')?.value ?? NaN),
            rebuildAppliedLength: (document.getElementById('rebuild-applied')?.value ?? '').trim().length,
          })`);
          assertCondition(
            postReloadClean.lang === 'ko' &&
              postReloadClean.bustRx === 36 &&
              postReloadClean.bustRy === 64 &&
              postReloadClean.rebuildAppliedLength === 0,
            `Expected clean KO draft after isolated profile storage clear, got ${JSON.stringify(postReloadClean)}`,
          );
          koPersistedDraftBeforeClear = {
            persistedBeforeClear: persisted,
            isolation,
            postReloadClean,
          };
          await writeFile(
            join(artifactsDir, 'ko-persisted-draft-before-clear.json'),
            JSON.stringify(koPersistedDraftBeforeClear, null, 2),
          );
          await recordCheckpoint('ko-persisted-draft-verified-before-clear', koPersistedDraftBeforeClear);
        }

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 tab (${locale})`);
        await waitForStage1Readiness(page, 'PARTS_NOT_READY');
        await clickIframePartButton(page, 'torso', `Initial torso selection (${locale})`);
        const stage1Initial = await verifyStage1IframeAndApiAgainstDisk(
          page,
          'inspected',
          loadedPkg.p.sourceHash,
          diskInspected,
          true,
        );
        await writeFile(join(artifactsDir, `${locale}-stage1-initial.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-stage1-initial`, { correctionLine: stage1Initial.correctionLine });

        // 1. Chest regions: click button 0 in Stage 1 -> Stage 3 Setup -> drag R circle centre -> click #bust-apply.
        await clickIframeCorrectionButton(page, 0, `Chest regions (${locale})`);
        const chestReady = await waitForSetupState(
          page,
          r =>
            r.stage === '3' &&
            r.draftLabel.length > 0 &&
            r.chestPressed &&
            r.posedCount === 30 &&
            r.posedTris === 40 &&
            (r.meshLayerChecked ? r.overlayTris === 40 : r.overlayTris === null),
          `Stage 3 Setup Chest regions ready (${locale})`,
        );
        assertCondition(!chestReady.chestDisabled && !chestReady.bustApplyDisabled, `Chest controls must be enabled (${locale})`);
        const inspectedSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          'inspected',
          diskInspected,
          `Setup initial before Chest Apply (${locale})`,
        );

        const rBefore = await page.evaluate<{ cx: number; cy: number }>(`({
          cx: Number(document.getElementById('bust-r-x')?.value ?? NaN),
          cy: Number(document.getElementById('bust-r-y')?.value ?? NaN),
        })`);
        assertCondition(rBefore.cx === 36 && rBefore.cy === 64, `Expected initial bust_r at (36, 64), got (${rBefore.cx}, ${rBefore.cy})`);

        const chestDragDiagnostic = await dragStage1RegionOnPane(page, {
          label: `bust_r stage drag (${locale})`,
          kind: 'chest',
          regionIndex: 0,
          expectedInitial: { cx: 36, cy: 64 },
          deltaRigX: 6,
          deltaRigY: 0,
          persist: async diag => {
            await writeFile(join(artifactsDir, `${locale}-chest-region-drag-diagnostic.json`), JSON.stringify(diag, null, 2) + '\n');
          },
        });
        const rAfterDrag = chestDragDiagnostic.after!.source.cx;
        assertCondition(
          Number.isFinite(rAfterDrag) && rAfterDrag !== rBefore.cx,
          `Expected bust_r cx changed after stage drag (${locale}), got ${rAfterDrag}`,
        );

        await clickVisibleButton(page, '#bust-apply', `Chest Apply (${locale})`);
        const chestApplied = await waitFor(`Chest Apply settled (${locale})`, async recordReadout => {
          const state = await page!.evaluate<{
            busy: boolean;
            applied: { buildId: string; modelHash: string } | null;
            posedTris: number;
            meshLayerChecked: boolean;
            overlayTris: number | null;
            chestStatus: string;
            chestError: boolean;
          }>(`(() => {
            const posed = window.rigReviewEditor?.posed?.('torso');
            const statusEl = document.getElementById('chest-editor-status');
            return {
              busy: Boolean(window.rigReviewEditor?.stage?.()?.busy),
              applied: window.rigReviewEditor?.stage?.()?.applied ?? null,
              posedTris: Array.isArray(posed?.triangles) ? posed.triangles.length / 3 : 0,
              meshLayerChecked: Boolean(document.getElementById('layer-mesh')?.checked),
              overlayTris: window.rigReviewEditor?.mesh?.overlayTriangles?.('torso') ?? null,
              chestStatus: String(statusEl?.textContent ?? '').trim(),
              chestError: Boolean(statusEl?.classList?.contains('error')),
            };
          })()`);
          recordReadout(state);
          if (!state.busy && state.chestError) return state;
          const expectedOverlay = state.meshLayerChecked ? 38 : null;
          if (state.busy || !state.applied || state.posedTris !== 38 || state.overlayTris !== expectedOverlay) return null;
          return state;
        });
        assertCondition(
          !chestApplied.chestError && chestApplied.applied !== null,
          `Chest Apply refused (${locale}): ${chestApplied.chestStatus || 'missing applied build'} | state=${JSON.stringify(chestApplied)}`,
        );
        const chestBuildId = chestApplied.applied!.buildId;
        const chestScratchDir = join(stateDir, 'rebuild', loadedPkg.p.sourceHash, chestBuildId);
        const diskChest = await readDiskCompiledGeometry(join(chestScratchDir, 'build/skeleton.model.json'));
        assertCondition(diskChest.triangleCount === 38, `Expected 38 triangles on disk for Chest scratch, got ${diskChest.triangleCount}`);
        const chestSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          chestBuildId,
          diskChest,
          `Chest Apply (${locale})`,
        );
        const chestMeshJson = JSON.parse(await readFile(join(chestScratchDir, 'mesh.json'), 'utf8')) as {
          contour: { regions: Array<{ cx: number }> };
        };
        assertCondition(
          chestMeshJson.contour.regions[0]?.cx === rAfterDrag,
          `Scratch mesh.json cx (${chestMeshJson.contour.regions[0]?.cx}) must match dragged cx (${rAfterDrag})`,
        );
        const chestCopiedHashes = await copyScratchArtifacts(chestScratchDir, join(localeScratchOut, 'chest'), [
          'mesh.json',
          'revision/remesh.json',
          'build/skeleton.model.json',
        ]);
        await writeFile(join(artifactsDir, `${locale}-setup-chest-applied.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-setup-chest-applied`, {
          chestBuildId,
          diskModelHash: diskChest.modelHash,
          rAfterDrag,
        });

        // Return to Stage 1 and verify scratch build (38 triangles) is displayed and matches disk.
        await clickVisibleButton(page, '[data-review-stage="1"]', `Return to Stage 1 after Chest Apply (${locale})`);
        await waitForStage1Readiness(page, 'SCRATCH_NOT_READY');
        await verifyStage1IframeAndApiAgainstDisk(page, chestBuildId, loadedPkg.p.sourceHash, diskChest, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-chest.png`), await page.screenshot());

        // 2. Mesh parameters: click button 1 in Stage 1 -> Stage 3 Setup -> click #mesh-regions-edit -> drag region 1 (bust_l) -> click #mesh-panel-apply.
        await clickIframeCorrectionButton(page, 1, `Mesh parameters (${locale})`);
        await waitForSetupState(
          page,
          r => r.stage === '3' && r.meshOpen && r.meshPart === 'torso' && r.overlayTris === 38,
          `Stage 3 Setup Mesh parameters ready (${locale})`,
        );

        const meshRegionsToggleClick = await clickVisibleButton(page, '#mesh-regions-edit', `Mesh regions Drag on stage (${locale})`);
        const meshRegionsToggleState = await page.evaluate<{ ariaPressed: string | null; disabled: boolean }>(`(() => {
          const btn = document.getElementById('mesh-regions-edit');
          return {
            ariaPressed: btn?.getAttribute('aria-pressed') ?? null,
            disabled: Boolean(btn?.disabled),
          };
        })()`);
        assertCondition(
          meshRegionsToggleState.ariaPressed === 'true' && !meshRegionsToggleState.disabled,
          `MESH_REGIONS_EDIT_NOT_PRESSED (${locale}): state=${JSON.stringify(meshRegionsToggleState)} click=${JSON.stringify(meshRegionsToggleClick)}`,
        );
        await recordCheckpoint(`${locale}-mesh-regions-edit-pressed`, {
          toggleState: meshRegionsToggleState,
          clickProbe: meshRegionsToggleClick,
        });

        const lBefore = await page.evaluate<{ cx: number; cy: number }>(`(() => {
          const r = window.rigReviewEditor?.mesh?.regions?.()?.[1];
          return { cx: Number(r?.cx ?? NaN), cy: Number(r?.cy ?? NaN) };
        })()`);
        assertCondition(lBefore.cx === 92 && lBefore.cy === 64, `Expected bust_l at (92, 64), got (${lBefore.cx}, ${lBefore.cy})`);

        const meshDragDiagnostic = await dragStage1RegionOnPane(page, {
          label: `bust_l stage drag (${locale})`,
          kind: 'mesh',
          regionIndex: 1,
          expectedInitial: { cx: 92, cy: 64 },
          deltaRigX: -6,
          deltaRigY: 0,
          toggleBeforeDrag: {
            ariaPressed: meshRegionsToggleState.ariaPressed,
            disabled: meshRegionsToggleState.disabled,
            clickProbe: meshRegionsToggleClick,
          },
          persist: async diag => {
            await writeFile(join(artifactsDir, `${locale}-mesh-region-drag-diagnostic.json`), JSON.stringify(diag, null, 2) + '\n');
          },
        });
        const lAfterDrag = {
          cx: meshDragDiagnostic.after!.source.cx,
          applyDisabled: Boolean(meshDragDiagnostic.applyDisabledAfter),
          diffText: meshDragDiagnostic.diffTextAfter ?? '',
        };
        assertCondition(
          Number.isFinite(lAfterDrag.cx) &&
            lAfterDrag.cx !== lBefore.cx &&
            !lAfterDrag.applyDisabled &&
            lAfterDrag.diffText.includes('/meshes/torso/contour/regions/1/cx'),
          `Expected diff and enabled Apply for region 1 cx (${locale}): ${JSON.stringify(lAfterDrag)}`,
        );

        await clickVisibleButton(page, '#mesh-panel-apply', `Mesh panel Apply (${locale})`);
        const meshApplied = await waitFor(`Mesh panel Apply settled (${locale})`, async recordReadout => {
          const state = await page!.evaluate<{
            busy: boolean;
            applied: { buildId: string; modelHash: string } | null;
            posedTris: number;
            overlayTris: number | null;
            meshStatus: string;
            meshError: boolean;
          }>(`(() => {
            const posed = window.rigReviewEditor?.posed?.('torso');
            const statusEl = document.getElementById('mesh-status');
            return {
              busy: Boolean(window.rigReviewEditor?.stage?.()?.busy),
              applied: window.rigReviewEditor?.stage?.()?.applied ?? null,
              posedTris: Array.isArray(posed?.triangles) ? posed.triangles.length / 3 : 0,
              overlayTris: window.rigReviewEditor?.mesh?.overlayTriangles?.('torso') ?? null,
              meshStatus: String(statusEl?.textContent ?? '').trim(),
              meshError: Boolean(statusEl?.classList?.contains('error')),
            };
          })()`);
          recordReadout(state);
          if (!state.busy && state.meshError) return state;
          if (state.busy || !state.applied || state.applied.buildId === chestBuildId || state.posedTris !== 34 || state.overlayTris !== 34) return null;
          return state;
        });
        assertCondition(
          !meshApplied.meshError && meshApplied.applied !== null,
          `Mesh panel Apply refused (${locale}): ${meshApplied.meshStatus || 'missing applied build'} | state=${JSON.stringify(meshApplied)}`,
        );
        const meshBuildId = meshApplied.applied!.buildId;
        const meshScratchDir = join(stateDir, 'rebuild', loadedPkg.p.sourceHash, meshBuildId);
        const diskMesh = await readDiskCompiledGeometry(join(meshScratchDir, 'build/skeleton.model.json'));
        assertCondition(diskMesh.triangleCount === 34, `Expected 34 triangles on disk for Mesh panel scratch, got ${diskMesh.triangleCount}`);
        const meshSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          meshBuildId,
          diskMesh,
          `Mesh panel Apply (${locale})`,
        );
        const meshPanelJson = JSON.parse(await readFile(join(meshScratchDir, 'mesh.json'), 'utf8')) as {
          contour: { regions: Array<{ cx: number }> };
        };
        assertCondition(meshPanelJson.contour.regions[1]?.cx === lAfterDrag.cx, 'Scratch mesh.json region 1 cx must match dragged value');
        const meshCopiedHashes = await copyScratchArtifacts(meshScratchDir, join(localeScratchOut, 'mesh-panel'), [
          'mesh.json',
          'rig/remesh.json',
          'build/skeleton.model.json',
        ]);
        await writeFile(join(artifactsDir, `${locale}-setup-mesh-applied.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-setup-mesh-applied`, {
          meshBuildId,
          diskModelHash: diskMesh.modelHash,
          lAfterDragCx: lAfterDrag.cx,
        });

        // Return to Stage 1 and verify scratch build (34 triangles) is displayed and matches disk.
        await clickVisibleButton(page, '[data-review-stage="1"]', `Return to Stage 1 after Mesh Apply (${locale})`);
        await waitForStage1Readiness(page, 'MESH_ROUTE_TIMEOUT');
        await verifyStage1IframeAndApiAgainstDisk(page, meshBuildId, loadedPkg.p.sourceHash, diskMesh, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-mesh.png`), await page.screenshot());

        // 3. Edit Mesh: click button 2 in Stage 1 -> Stage 3 Setup -> drag interior vertex hull + 1 -> click visible #mesh-apply.
        await clickIframeCorrectionButton(page, 2, `Edit Mesh (${locale})`);
        await waitForSetupState(
          page,
          r => r.stage === '3' && r.meshEditPressed && r.meshEditSlot === 'torso' && r.meshEditVerts === 30,
          `Stage 3 Setup Edit Mesh ready (${locale})`,
        );

        let deltaDiag: DeltaDiagnostic = {};
        const namedId = await dragStage1Delta(page, async diagnostic => {
          deltaDiag = diagnostic;
          await writeFile(
            join(localeScratchOut, 'delta-diagnostic.json'),
            JSON.stringify(diagnostic, null, 2) + '\n',
          );
        });
        assertCondition(
          deltaDiag.settled && deltaDiag.after && namedId === deltaDiag.settled.edit.hull + 1,
          'Expected settled & after delta diagnostic for interior vertex hull + 1',
        );

        const prevAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        await clickVisibleButton(page, '#mesh-apply', `Visible #mesh-apply (${locale})`);
        const deltaRecord = await waitForDeltaApplySettled(
          page,
          prevAppliedRaw,
          meshBuildId,
          `Edit Mesh Apply settled (${locale})`,
        );
        assertCondition(deltaRecord.check?.pass === true, `Expected passing delta check (${locale})`);
        assertNamedDeltaOps(deltaRecord.delta.ops, namedId);

        const deltaBuildId = deltaRecord.buildId;
        const deltaScratchDir = join(stateDir, 'rebuild', loadedPkg.p.sourceHash, deltaBuildId);
        const diskDelta = await readDiskCompiledGeometry(join(deltaScratchDir, 'build/skeleton.model.json'));
        assertCondition(diskDelta.triangleCount === 36, `Expected 36 triangles on disk for Delta scratch, got ${diskDelta.triangleCount}`);
        const deltaSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          deltaBuildId,
          diskDelta,
          `Edit Mesh Apply (${locale})`,
        );
        const deltaDiskDoc = JSON.parse(await readFile(join(deltaScratchDir, 'mesh-edit.json'), 'utf8')) as {
          ops: MeshOp[];
        };
        assertNamedDeltaOps(deltaDiskDoc.ops, namedId);
        const deltaCopiedHashes = await copyScratchArtifacts(deltaScratchDir, join(localeScratchOut, 'delta'), [
          'mesh-edit.json',
          'rig/remesh.json',
          'build/skeleton.model.json',
        ]);
        await writeFile(join(artifactsDir, `${locale}-setup-delta-applied.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-setup-delta-applied`, {
          deltaBuildId,
          diskModelHash: diskDelta.modelHash,
          namedId,
        });

        // Return to Stage 1 and verify scratch build (36 triangles) is displayed and matches disk.
        await clickVisibleButton(page, '[data-review-stage="1"]', `Return to Stage 1 after Delta Apply (${locale})`);
        await waitForStage1Readiness(page, 'DELTA_ROUTE_TIMEOUT');
        await verifyStage1IframeAndApiAgainstDisk(page, deltaBuildId, loadedPkg.p.sourceHash, diskDelta, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-delta.png`), await page.screenshot());

        // 4. Re-enter Stage 3 Setup via Mesh parameters, click visible #applied-undo -> verify step-back restores meshSetupSnapshot model & geometry.
        await clickIframeCorrectionButton(page, 1, `Re-open Setup for Undo (${locale})`);
        await waitForSetupState(page, r => r.stage === '3' && r.overlayTris === 36, `Setup at 36 before Undo (${locale})`);
        await clickVisibleButton(page, '#applied-undo', `Visible #applied-undo (${locale})`);
        const undoRestoredSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          meshBuildId,
          diskMesh,
          `Undo restored meshBuildId (${locale})`,
        );
        assertSetupSnapshotRestored(undoRestoredSnapshot, meshSetupSnapshot, `Undo restoration (${locale})`);
        await writeFile(join(artifactsDir, `${locale}-setup-after-undo.png`), await page.screenshot());

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after Undo (${locale})`);
        await waitForStage1Readiness(page, 'SCRATCH_NOT_READY');
        await verifyStage1IframeAndApiAgainstDisk(page, meshBuildId, loadedPkg.p.sourceHash, diskMesh, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-undo.png`), await page.screenshot());

        // 5. Re-enter Stage 3 Setup via Mesh parameters, click visible #mesh-panel-reset -> verify restoration to inspectedSetupSnapshot model & geometry while keeping #rebuild-applied unchanged.
        await clickIframeCorrectionButton(page, 1, `Re-open Setup for visible Reset (${locale})`);
        await waitForSetupState(page, r => r.stage === '3' && r.meshOpen && r.overlayTris === 34, `Setup at 34 before Reset (${locale})`);
        const preResetAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        assertCondition(preResetAppliedRaw.length > 0, `Expected non-empty #rebuild-applied before visible Reset (${locale})`);
        await clickVisibleButton(page, '#mesh-panel-reset', `Visible #mesh-panel-reset (${locale})`);
        const resetRestoredSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          'inspected',
          diskInspected,
          `Reset restored inspected (${locale})`,
        );
        assertSetupSnapshotRestored(resetRestoredSnapshot, inspectedSetupSnapshot, `Visible Reset restoration (${locale})`);
        const postResetAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        assertCondition(
          postResetAppliedRaw === preResetAppliedRaw,
          `Expected #rebuild-applied textarea string unchanged after visible Reset (${locale})`,
        );
        await writeFile(join(artifactsDir, `${locale}-setup-after-reset.png`), await page.screenshot());

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after visible Reset (${locale})`);
        await waitForStage1Readiness(page, 'SCRATCH_NOT_READY');
        await verifyStage1IframeAndApiAgainstDisk(page, 'inspected', loadedPkg.p.sourceHash, diskInspected, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-reset.png`), await page.screenshot());

        // 6. Direct Stage 3 navigation refuses with RIG_VERSION_UNAVAILABLE.
        await clickVisibleButton(page, '[data-review-stage="3"]', `Direct Stage 3 refusal check (${locale})`);
        const catalog = locale === 'ko' ? koCatalog : enCatalog;
        const expectedRefusal = catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']!;
        await assertRefusedStage3(page, locale, expectedRefusal);
        await writeFile(join(artifactsDir, `${locale}-stage3-direct-refused.png`), await page.screenshot());
        errorCollector.assertClean(`synthetic-${locale}`);

        localeReceipts[locale] = {
          ...(koPersistedDraftBeforeClear ? { persistedDraftBeforeClear: koPersistedDraftBeforeClear } : {}),
          configSha,
          inspectedModelHash: diskInspected.modelHash,
          chest: { buildId: chestBuildId, modelHash: chestSetupSnapshot.diskModelHash, scratchHashes: chestCopiedHashes },
          meshPanel: { buildId: meshBuildId, modelHash: meshSetupSnapshot.diskModelHash, scratchHashes: meshCopiedHashes },
          delta: {
            buildId: deltaBuildId,
            modelHash: deltaSetupSnapshot.diskModelHash,
            draggedVertex: namedId,
            ops: deltaRecord.delta.ops,
            scratchHashes: deltaCopiedHashes,
          },
          undoRestoredModelHash: undoRestoredSnapshot.stageModelHash,
          resetRestoredModelHash: resetRestoredSnapshot.stageModelHash,
        };
        await recordCheckpoint(`${locale}-completed`, localeReceipts[locale] as Record<string, unknown>);
      }

      // 7. Read-only Stage 1 control (`2-rigging-answers` fixture where parts-review signoff is already recorded).
      const locked = await joinedVerdictFixture(lockedRoot, '2-rigging-answers');
      const lockedOpen = await openReview({ input: locked.input, project: locked.project }, launchOptions);
      const claimedLocked = await claimOwnedWorker(lockedOpen, controlDir, frontPort, ownedWorkers);
      frontPids.add(claimedLocked.frontPid);

      await page.goto(lockedOpen.url, 'en');
      await waitForStage1Readiness(page, 'PARTS_NOT_READY');
      await clickIframePartButton(page, 'torso', 'Locked 2-rigging-answers torso selection');
      const lockedCheck = await waitFor('locked 2-rigging-answers Stage 1 read-only check', async recordReadout => {
        const res = await page!.evaluate<{
          iframeReady: boolean;
          selectedPart: string;
          correctionLine: string;
          figureVertices: number;
          figureTriangles: number;
          stagePartsStatus: number;
          stagePartsOk: boolean;
          stagePartsBodyPreview: string;
          rebuildStatus: number;
          rebuildOk: boolean;
          rebuildBodyPreview: string;
          inspectionOnly: boolean;
          torsoMapping: {
            part: string;
            skin: string;
            slot: string;
            attachment: string;
            vertices: number;
            triangles: number;
          } | null;
          torsoMeshVertices: number;
          torsoMeshTriangles: number;
          rebuildAvailable: boolean | null;
          rebuildReason: string | null;
          correctionButtons: number;
        }>(`(async () => {
          const frame = [...document.querySelectorAll('.review-stage-panel iframe')].find(f => !f.hidden && f.getAttribute('src')?.includes('/stage-parts.html'));
          const doc = frame?.contentDocument;
          const win = frame?.contentWindow;
          const iframeReady = Boolean(doc && win && doc.body?.dataset?.ready === 'true');
          const snap = win?.rigReviewStageParts?.snapshot?.() ?? null;
          const activeBtn = doc?.querySelector('#pv-items button[data-pv-item][aria-current="true"]');
          const selectedPart = activeBtn?.getAttribute('data-pv-item') ?? snap?.part ?? '';
          const correctionLine = doc?.querySelector('#pv-corrections > p')?.textContent?.trim() ?? '';
          const figureVertices = Number(doc?.querySelector('#pv-mesh-panel dd[data-mesh-figure="vertices"]')?.textContent ?? NaN);
          const figureTriangles = Number(doc?.querySelector('#pv-mesh-panel dd[data-mesh-figure="triangles"]')?.textContent ?? NaN);
          const [stageRes, rebuildRes] = await Promise.all([
            fetch('api/stage-parts'),
            fetch('api/rebuild'),
          ]);
          const [rawStage, rawRebuild] = await Promise.all([stageRes.text(), rebuildRes.text()]);
          let stageResp = null, rebuildResp = null;
          if (stageRes.ok) { try { stageResp = JSON.parse(rawStage); } catch {} }
          if (rebuildRes.ok) { try { rebuildResp = JSON.parse(rawRebuild); } catch {} }
          const torsoMapping = stageResp?.draft?.mappings?.find(m => m.part === 'torso') ?? null;
          const torsoItem = stageResp?.items?.find(i => i.name === 'torso') ?? null;
          return {
            iframeReady,
            selectedPart,
            correctionLine,
            figureVertices,
            figureTriangles,
            stagePartsStatus: stageRes.status,
            stagePartsOk: stageRes.ok,
            stagePartsBodyPreview: rawStage.slice(0, 240),
            rebuildStatus: rebuildRes.status,
            rebuildOk: rebuildRes.ok,
            rebuildBodyPreview: rawRebuild.slice(0, 240),
            inspectionOnly: Boolean(stageResp?.draft?.inspectionOnly),
            torsoMapping,
            torsoMeshVertices: Array.isArray(torsoItem?.mesh?.vertices) ? torsoItem.mesh.vertices.length / 2 : -1,
            torsoMeshTriangles: Array.isArray(torsoItem?.mesh?.triangles) ? torsoItem.mesh.triangles.length / 3 : -1,
            rebuildAvailable: typeof rebuildResp?.available === 'boolean' ? rebuildResp.available : null,
            rebuildReason: rebuildResp?.reason ?? null,
            correctionButtons: doc ? doc.querySelectorAll('#pv-corrections button').length : -1,
          };
        })()`);
        recordReadout(res);
        if (
          !res.iframeReady ||
          res.selectedPart !== 'torso' ||
          res.figureVertices !== 30 ||
          res.figureTriangles !== 40 ||
          !res.correctionLine.includes('torso · default/torso/torso · v 30 t 40 · inspected') ||
          !res.stagePartsOk ||
          !res.rebuildOk ||
          !res.inspectionOnly ||
          !res.torsoMapping ||
          res.torsoMapping.vertices !== 30 ||
          res.torsoMapping.triangles !== 40 ||
          res.torsoMeshVertices !== 30 ||
          res.torsoMeshTriangles !== 40
        ) {
          return null;
        }
        return {
          selectedPart: res.selectedPart,
          correctionLine: res.correctionLine,
          figureVertices: res.figureVertices,
          figureTriangles: res.figureTriangles,
          torsoMapping: res.torsoMapping,
          torsoMeshVertices: res.torsoMeshVertices,
          torsoMeshTriangles: res.torsoMeshTriangles,
          inspectionOnly: res.inspectionOnly,
          rebuildAvailable: res.rebuildAvailable,
          rebuildReason: res.rebuildReason,
          correctionButtons: res.correctionButtons,
        };
      });
      assertCondition(lockedCheck.selectedPart === 'torso', `Expected selectedPart === 'torso' on 2-rigging-answers, got ${lockedCheck.selectedPart}`);
      assertCondition(
        lockedCheck.figureVertices === 30 &&
          lockedCheck.figureTriangles === 40 &&
          lockedCheck.torsoMapping?.vertices === 30 &&
          lockedCheck.torsoMapping?.triangles === 40 &&
          lockedCheck.torsoMeshVertices === 30 &&
          lockedCheck.torsoMeshTriangles === 40,
        `Expected 30v / 40t torso mapping on 2-rigging-answers, got ${JSON.stringify(lockedCheck)}`,
      );
      assertCondition(lockedCheck.inspectionOnly === true, 'Expected draft.inspectionOnly === true on 2-rigging-answers');
      assertCondition(
        lockedCheck.rebuildAvailable === false &&
          typeof lockedCheck.rebuildReason === 'string' &&
          lockedCheck.rebuildReason.startsWith('PARTS_VERDICT_READ_ONLY'),
        `Expected PARTS_VERDICT_READ_ONLY, got ${String(lockedCheck.rebuildReason)}`,
      );
      assertCondition(lockedCheck.correctionButtons === 0, 'Expected 0 correction buttons on read-only Stage 1 draft');
      await writeFile(join(artifactsDir, 'locked-2-rigging-answers-stage1.png'), await page.screenshot());
      errorCollector.assertClean('synthetic-locked-control');

      await page.goto('about:blank');
      await page.close();
      page = undefined;
      const workerExitEvidence = await verifyOwnedWorkersExited(controlDir, ownedWorkers, [...frontPids]);
      await locked.assertFixture();

      // Verify resealed synthetic project inventory is unchanged after all runs.
      const syntheticInventoryAfter = await collectFileHashes(projectRoot);
      await writeFile(
        join(artifactsDir, 'resealed-project-inventory-after.json'),
        JSON.stringify({ files: mapToInventoryEntries(syntheticInventoryAfter) }, null, 2) + '\n',
      );
      assertCondition(
        JSON.stringify(mapToInventoryEntries(syntheticInventoryAfter)) ===
          JSON.stringify(mapToInventoryEntries(syntheticInventoryBefore)),
        'Resealed synthetic project files changed during browser run',
      );
      await verifyFixtureInventory(sealedFixtureRoot, inventoryPath);

      const summary = {
        phase: 'synthetic',
        resealedProjectFilesVerified: syntheticInventoryAfter.size,
        locales: localeReceipts,
        lockedControl: lockedCheck,
        runtimeExceptions: errorCollector.runtimeExceptions,
        consoleErrors: errorCollector.consoleErrors,
        workerExitEvidence,
      };
      await writeFile(join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      return summary;
    } catch (error) {
      await captureFailureArtifacts(
        artifactsDir,
        page,
        error,
        checkpoints,
        errorCollector.runtimeExceptions,
        errorCollector.consoleErrors,
        stateDir,
        ownedWorkers,
        [...frontPids],
      );
      throw error;
    } finally {
      if (page) await page.close();
      for (const worker of ownedWorkers) {
        try {
          process.kill(worker.pid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
      for (const fpid of frontPids) {
        try {
          process.kill(fpid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

async function runActualFixturePhase(
  sealedFixtureRoot: string,
  inventoryPath: string,
  artifactsDir: string,
  suppliedToolchainDir?: string,
): Promise<Record<string, unknown>> {
  return await withDeadline('STAGE1_FIXTURE_830FC98_PHASE', 480_000, async () => {
    await mkdir(artifactsDir, { recursive: true });
    const root = await realpath(await mkdtemp(join(tmpdir(), 'review-562-actual-830fc98-')));
    const toolchainRoot = suppliedToolchainDir ? resolve(suppliedToolchainDir) : join(root, 'toolchain');
    const stateDir = join(root, 'state');
    const controlDir = join(stateDir, 'open');
    const frontPort = allocateUnusedLoopbackPort();

    let page: InputCdpSession | undefined;
    const ownedWorkers: RecordFile[] = [];
    const frontPids = new Set<number>();
    const checkpoints: CheckpointEntry[] = [];
    const errorCollector = createCdpErrorCollector();

    const recordCheckpoint = async (step: string, detail?: Record<string, unknown>) => {
      checkpoints.push({ at: new Date().toISOString(), step, ...(detail ? { detail } : {}) });
      await writeFile(join(artifactsDir, 'checkpoints.json'), JSON.stringify(checkpoints, null, 2) + '\n');
    };

    try {
      const entryCountBefore = await verifyFixtureInventory(sealedFixtureRoot, inventoryPath);
      await recordCheckpoint('verified-830fc98-inventory-before', { entryCountBefore });
      await ensureActualToolchain(toolchainRoot);
      await recordCheckpoint('ensured-actual-toolchain', { toolchainRoot });

      const inspectedModelPath = join(sealedFixtureRoot, 'derived/drafts/remesh/out/check/build/skeleton.model.json');
      const diskInspected = await readDiskCompiledGeometry(inspectedModelPath);
      assertCondition(diskInspected.vertexCount === 30 && diskInspected.triangleCount === 40, 'Expected 30v / 40t in 830fc98 inspected model');

      const openInputs = {
        input: join(sealedFixtureRoot, 'derived/drafts/remesh/out/check'),
        project: { root: sealedFixtureRoot, draftId: 'remesh', picksDir: 'inputs/references' } as const,
      };
      const loadedPkg = await loadOpenPackage(openInputs);
      assertCondition(loadedPkg.mode === 'single' && loadedPkg.joined?.draft, 'Expected joined pre-rig draft on 830fc98 fixture');
      assertCondition(loadedPkg.p.manifest.model === undefined, '830fc98 Stage 1 draft must omit manifest.model');

      const launchOptions = {
        stateDir,
        cwd: toolchainRoot,
        frontPort,
        frontIdleMs: 1200,
        graceMs: 400,
        idleMs: 5_000,
      };
      const opened = await openReview(openInputs, launchOptions);
      const claimed = await claimOwnedWorker(opened, controlDir, frontPort, ownedWorkers);
      frontPids.add(claimed.frontPid);

      page = await launchCdpSession(join(root, 'browser-profile'), {
        sendDeadlineMs: 10_000,
        onEvent: errorCollector.onEvent,
      });
      await page.setViewport(1440, 1000);
      const localeReceipts: Record<Locale, unknown> = {} as Record<Locale, unknown>;

      for (const locale of ['en', 'ko'] as const) {
        const localeScratchOut = join(artifactsDir, 'scratch', locale);
        await mkdir(localeScratchOut, { recursive: true });

        const targetUrl = new URL(opened.url);
        targetUrl.searchParams.set('lang', locale);
        await page.goto(targetUrl.href, locale);
        await waitForStage1Readiness(page, 'PAGE_NOT_READY');
        let koPersistedDraftBeforeClear: Record<string, unknown> | null = null;
        if (locale === 'ko') {
          const persisted = await page.evaluate<{
            lang: string;
            rebuildAppliedLength: number;
            localStorageKeys: string[];
          }>(`({
            lang: document.documentElement.lang,
            rebuildAppliedLength: (document.getElementById('rebuild-applied')?.value ?? '').trim().length,
            localStorageKeys: Object.keys(localStorage),
          })`);
          assertCondition(
            persisted.lang === 'ko' &&
              persisted.rebuildAppliedLength > 0 &&
              persisted.localStorageKeys.length > 0,
            `Expected persisted EN draft (#rebuild-applied) to survive KO navigation before profile storage clear on 830fc98, got ${JSON.stringify(persisted)}`,
          );
          const neutralUrl = new URL('styles.css', opened.url);
          await page.goto(neutralUrl.href);
          await errorCollector.send('Storage.clearDataForOrigin', {
            origin: targetUrl.origin,
            storageTypes: 'local_storage',
          });
          const isolation = await page.evaluate<{
            origin: string;
            pathname: string;
            hasAppGlobal: boolean;
            keysAfterClear: string[];
          }>(`(() => {
            localStorage.clear();
            return {
              origin: location.origin,
              pathname: location.pathname,
              hasAppGlobal: typeof window.rigReviewEditor !== 'undefined',
              keysAfterClear: Object.keys(localStorage),
            };
          })()`);
          assertCondition(
            isolation.origin === targetUrl.origin &&
              isolation.pathname === neutralUrl.pathname &&
              !isolation.hasAppGlobal &&
              isolation.keysAfterClear.length === 0,
            `Expected neutral same-origin storage isolation at ${neutralUrl.href} on 830fc98, got ${JSON.stringify(isolation)}`,
          );
          await page.goto(targetUrl.href, locale);
          await waitForStage1Readiness(page, 'PAGE_NOT_READY');
          const postReloadClean = await page.evaluate<{
            lang: string;
            rebuildAppliedLength: number;
          }>(`({
            lang: document.documentElement.lang,
            rebuildAppliedLength: (document.getElementById('rebuild-applied')?.value ?? '').trim().length,
          })`);
          assertCondition(
            postReloadClean.lang === 'ko' && postReloadClean.rebuildAppliedLength === 0,
            `Expected clean KO draft after isolated profile storage clear on 830fc98, got ${JSON.stringify(postReloadClean)}`,
          );
          koPersistedDraftBeforeClear = {
            persistedBeforeClear: persisted,
            isolation,
            postReloadClean,
          };
          await writeFile(
            join(artifactsDir, 'ko-persisted-draft-before-clear.json'),
            JSON.stringify(koPersistedDraftBeforeClear, null, 2),
          );
          await recordCheckpoint('ko-persisted-draft-verified-before-clear', koPersistedDraftBeforeClear);
        }

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 tab (${locale})`);
        await waitForStage1Readiness(page, 'PARTS_NOT_READY');
        await clickIframePartButton(page, 'torso', `Initial torso selection (${locale})`);
        const stage1Initial = await verifyStage1IframeAndApiAgainstDisk(
          page,
          'inspected',
          loadedPkg.p.sourceHash,
          diskInspected,
          true,
        );
        await writeFile(join(artifactsDir, `${locale}-stage1-initial.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-stage1-initial`, { correctionLine: stage1Initial.correctionLine });

        // 1. Record preceding view & source binding before clicking Chest regions on non-contour 830fc98 torso.
        const beforeChestClick = await capturePrecedingView(page);
        await clickIframeCorrectionButton(page, 0, `Chest regions non-contour refusal (${locale})`);
        const statusText = await waitFor(`REBUILD_PART_NOT_CONTOUR refusal shown (${locale})`, async recordReadout => {
          const text = await page!.evaluate<string>(
            `document.querySelector('.review-stage-panel [role="status"]')?.textContent?.trim() ?? ''`,
          );
          recordReadout({ statusText: text });
          return text.includes('REBUILD_PART_NOT_CONTOUR: torso') ? text : null;
        });
        const afterChestClick = await capturePrecedingView(page);
        assertCondition(
          JSON.stringify(afterChestClick) === JSON.stringify(beforeChestClick),
          `Preceding view or source binding changed after Chest refusal (${locale}): before=${JSON.stringify(beforeChestClick)} after=${JSON.stringify(afterChestClick)}`,
        );
        await writeFile(join(artifactsDir, `${locale}-stage1-chest-refused.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-chest-refusal-verified`, {
          statusText,
          beforeChestClick,
          afterChestClick,
        });

        // 2. Click Mesh parameters in Stage 1 -> opens Stage 3 Setup on grid torso -> drag visible grid range slider -> click #mesh-panel-apply.
        await clickIframeCorrectionButton(page, 1, `Mesh parameters on 830fc98 (${locale})`);
        await waitForSetupState(
          page,
          r => r.stage === '3' && r.meshOpen && r.meshPart === 'torso' && r.overlayTris === 40,
          `830fc98 Mesh parameters ready (${locale})`,
        );
        const inspectedSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          'inspected',
          diskInspected,
          `830fc98 Setup initial before Mesh Apply (${locale})`,
        );

        const gridControls = await page.evaluate<{
          addCircleDisabled: boolean;
          drawPolygonDisabled: boolean;
          dragDisabled: boolean;
          gridVal: string;
        }>(`({
          addCircleDisabled: Boolean(document.getElementById('mesh-add-circle')?.disabled),
          drawPolygonDisabled: Boolean(document.getElementById('mesh-add-polygon')?.disabled),
          dragDisabled: Boolean(document.getElementById('mesh-regions-edit')?.disabled),
          gridVal: document.querySelector('#mesh-params input[type="number"][data-param="grid"]')?.value ?? '',
        })`);
        assertCondition(
          gridControls.addCircleDisabled && gridControls.drawPolygonDisabled && gridControls.dragDisabled,
          `Contour region buttons must be disabled on grid torso (${locale})`,
        );
        assertCondition(gridControls.gridVal === '16', `Expected initial grid=16 on 830fc98 torso, got ${gridControls.gridVal}`);

        // Drag the visible range slider for grid (min=2, max=80, initial=16 -> fraction ~0.18; drag to ~0.11 -> grid ~10..11).
        await dragVisibleRangeControl(
          page,
          '#mesh-params input[type="range"][data-param="grid"]',
          (16 - 2) / (80 - 2),
          (10 - 2) / (80 - 2),
          `830fc98 grid range slider (${locale})`,
        );

        const gridEdited = await waitFor(`#mesh-panel-apply enabled after pointer drag on grid slider (${locale})`, async recordReadout => {
          const ready = await page!.evaluate<{
            disabled: boolean;
            diff: string;
            numberVal: string;
            entryGrid: unknown;
          }>(`({
            disabled: Boolean(document.getElementById('mesh-panel-apply')?.disabled),
            diff: document.getElementById('mesh-diff')?.textContent ?? '',
            numberVal: document.querySelector('#mesh-params input[type="number"][data-param="grid"]')?.value ?? '',
            entryGrid: window.rigReviewEditor?.mesh?.entry?.()?.grid ?? null,
          })`);
          recordReadout(ready);
          if (
            ready.disabled ||
            !ready.diff.includes('/meshes/torso/grid') ||
            typeof ready.entryGrid !== 'number' ||
            ready.entryGrid === 16 ||
            ready.numberVal !== String(ready.entryGrid)
          ) {
            return null;
          }
          return ready;
        });

        await clickVisibleButton(page, '#mesh-panel-apply', `830fc98 Mesh panel Apply (${locale})`);
        const meshApplied = await waitFor(`830fc98 Mesh panel Apply settled (${locale})`, async recordReadout => {
          const state = await page!.evaluate<{
            busy: boolean;
            applied: { buildId: string; modelHash: string } | null;
            posedTris: number;
            overlayTris: number | null;
            meshStatus: string;
            meshError: boolean;
          }>(`(() => {
            const posed = window.rigReviewEditor?.posed?.('torso');
            const statusEl = document.getElementById('mesh-status');
            return {
              busy: Boolean(window.rigReviewEditor?.stage?.()?.busy),
              applied: window.rigReviewEditor?.stage?.()?.applied ?? null,
              posedTris: Array.isArray(posed?.triangles) ? posed.triangles.length / 3 : 0,
              overlayTris: window.rigReviewEditor?.mesh?.overlayTriangles?.('torso') ?? null,
              meshStatus: String(statusEl?.textContent ?? '').trim(),
              meshError: Boolean(statusEl?.classList?.contains('error')),
            };
          })()`);
          recordReadout(state);
          if (!state.busy && state.meshError) return state;
          if (state.busy || !state.applied || !state.overlayTris || state.overlayTris === 40 || state.posedTris !== state.overlayTris) {
            return null;
          }
          return state;
        }, 60_000);
        assertCondition(
          !meshApplied.meshError && meshApplied.applied !== null,
          `830fc98 Mesh panel Apply refused (${locale}): ${meshApplied.meshStatus || 'missing applied build'} | state=${JSON.stringify(meshApplied)}`,
        );
        const meshBuildId = meshApplied.applied!.buildId;
        const meshScratchDir = join(stateDir, 'rebuild', loadedPkg.p.sourceHash, meshBuildId);
        const diskMesh = await readDiskCompiledGeometry(join(meshScratchDir, 'build/skeleton.model.json'));
        assertCondition(diskMesh.triangleCount !== 40, `Expected rebuilt triangle count != 40, got ${diskMesh.triangleCount}`);
        const meshSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          meshBuildId,
          diskMesh,
          `830fc98 Mesh panel Apply (${locale})`,
        );

        const remeshDoc = JSON.parse(await readFile(join(meshScratchDir, 'rig/remesh.json'), 'utf8')) as {
          target: { before: { triangles: number }; after: { triangles: number } };
          check?: { revision?: { pass?: boolean } };
        };
        assertCondition(remeshDoc.target.after.triangles === diskMesh.triangleCount, 'remesh.json after.triangles must match disk model');
        assertCondition(remeshDoc.check?.revision?.pass === true, 'Real producer remesh check must pass');
        const meshCopiedHashes = await copyScratchArtifacts(meshScratchDir, join(localeScratchOut, 'mesh-panel'), [
          'mesh.json',
          'rig/remesh.json',
          'build/skeleton.model.json',
        ]);
        await writeFile(join(artifactsDir, `${locale}-setup-mesh-applied.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-setup-mesh-applied`, {
          meshBuildId,
          gridValue: gridEdited.entryGrid,
          diskModelHash: diskMesh.modelHash,
          vertexCount: diskMesh.vertexCount,
          triangleCount: diskMesh.triangleCount,
        });

        // Return to Stage 1 and verify scratch build is shown and matches disk.
        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after 830fc98 Mesh Apply (${locale})`);
        await waitForStage1Readiness(page, 'MESH_ROUTE_TIMEOUT');
        await verifyStage1IframeAndApiAgainstDisk(page, meshBuildId, loadedPkg.p.sourceHash, diskMesh, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-mesh.png`), await page.screenshot());

        // 3. Click Edit Mesh in Stage 1 -> opens Stage 3 Setup -> drag interior vertex hull + 1 -> click visible #mesh-apply.
        await clickIframeCorrectionButton(page, 2, `830fc98 Edit Mesh (${locale})`);
        await waitForSetupState(
          page,
          r => r.stage === '3' && r.meshEditPressed && r.meshEditSlot === 'torso' && r.overlayTris === diskMesh.triangleCount,
          `830fc98 Edit Mesh ready (${locale})`,
        );

        let deltaDiag: DeltaDiagnostic = {};
        const namedId = await dragStage1Delta(page, async diagnostic => {
          deltaDiag = diagnostic;
          await writeFile(
            join(localeScratchOut, 'delta-diagnostic.json'),
            JSON.stringify(diagnostic, null, 2) + '\n',
          );
        });
        assertCondition(
          deltaDiag.settled && deltaDiag.after && namedId === deltaDiag.settled.edit.hull + 1,
          'Expected settled & after delta diagnostic on 830fc98',
        );

        const prevAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        await clickVisibleButton(page, '#mesh-apply', `830fc98 visible #mesh-apply (${locale})`);
        const deltaRecord = await waitForDeltaApplySettled(
          page,
          prevAppliedRaw,
          meshBuildId,
          `830fc98 Edit Mesh Apply settled (${locale})`,
        );
        assertCondition(deltaRecord.check?.pass === true, `Expected passing delta check on 830fc98 (${locale})`);
        assertNamedDeltaOps(deltaRecord.delta.ops, namedId);

        const deltaBuildId = deltaRecord.buildId;
        const deltaScratchDir = join(stateDir, 'rebuild', loadedPkg.p.sourceHash, deltaBuildId);
        const diskDelta = await readDiskCompiledGeometry(join(deltaScratchDir, 'build/skeleton.model.json'));
        const deltaSetupSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          deltaBuildId,
          diskDelta,
          `830fc98 Edit Mesh Apply (${locale})`,
        );
        const deltaDiskDoc = JSON.parse(await readFile(join(deltaScratchDir, 'mesh-edit.json'), 'utf8')) as {
          ops: MeshOp[];
        };
        assertNamedDeltaOps(deltaDiskDoc.ops, namedId);
        const deltaCopiedHashes = await copyScratchArtifacts(deltaScratchDir, join(localeScratchOut, 'delta'), [
          'mesh-edit.json',
          'rig/remesh.json',
          'build/skeleton.model.json',
        ]);
        await writeFile(join(artifactsDir, `${locale}-setup-delta-applied.png`), await page.screenshot());
        await recordCheckpoint(`${locale}-setup-delta-applied`, {
          deltaBuildId,
          diskModelHash: diskDelta.modelHash,
          vertexCount: diskDelta.vertexCount,
          triangleCount: diskDelta.triangleCount,
          namedId,
        });

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after 830fc98 Delta Apply (${locale})`);
        await waitForStage1Readiness(page, 'DELTA_ROUTE_TIMEOUT');
        await verifyStage1IframeAndApiAgainstDisk(page, deltaBuildId, loadedPkg.p.sourceHash, diskDelta, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-delta.png`), await page.screenshot());

        // 4. Re-open Setup and click visible #applied-undo -> step back to meshSetupSnapshot model & geometry.
        await clickIframeCorrectionButton(page, 1, `Re-open Setup for Undo on 830fc98 (${locale})`);
        await waitForSetupState(page, r => r.stage === '3' && r.overlayTris === diskDelta.triangleCount, `Setup before Undo (${locale})`);
        await clickVisibleButton(page, '#applied-undo', `830fc98 visible #applied-undo (${locale})`);
        const undoRestoredSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          meshBuildId,
          diskMesh,
          `830fc98 Undo restored meshBuildId (${locale})`,
        );
        assertSetupSnapshotRestored(undoRestoredSnapshot, meshSetupSnapshot, `830fc98 Undo restoration (${locale})`);
        await writeFile(join(artifactsDir, `${locale}-setup-after-undo.png`), await page.screenshot());

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after 830fc98 Undo (${locale})`);
        await waitForStage1Readiness(page, 'SCRATCH_NOT_READY');
        await verifyStage1IframeAndApiAgainstDisk(page, meshBuildId, loadedPkg.p.sourceHash, diskMesh, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-undo.png`), await page.screenshot());

        // 5. Re-open Setup and click visible #mesh-panel-reset -> restore inspectedSetupSnapshot model & geometry while keeping #rebuild-applied unchanged.
        await clickIframeCorrectionButton(page, 1, `Re-open Setup for visible Reset on 830fc98 (${locale})`);
        await waitForSetupState(page, r => r.stage === '3' && r.meshOpen && r.overlayTris === diskMesh.triangleCount, `Setup before Reset (${locale})`);
        const preResetAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        assertCondition(preResetAppliedRaw.length > 0, `Expected non-empty #rebuild-applied before 830fc98 visible Reset (${locale})`);
        await clickVisibleButton(page, '#mesh-panel-reset', `830fc98 visible #mesh-panel-reset (${locale})`);
        const resetRestoredSnapshot = await verifySetupModelAndGeometryAgainstDisk(
          page,
          'inspected',
          diskInspected,
          `830fc98 Reset restored inspected (${locale})`,
        );
        assertSetupSnapshotRestored(resetRestoredSnapshot, inspectedSetupSnapshot, `830fc98 Reset restoration (${locale})`);
        const postResetAppliedRaw = await page.evaluate<string>(`document.getElementById('rebuild-applied')?.value ?? ''`);
        assertCondition(
          postResetAppliedRaw === preResetAppliedRaw,
          `Expected #rebuild-applied textarea string unchanged after 830fc98 visible Reset (${locale})`,
        );
        await writeFile(join(artifactsDir, `${locale}-setup-after-reset.png`), await page.screenshot());

        await clickVisibleButton(page, '[data-review-stage="1"]', `Stage 1 after 830fc98 Reset (${locale})`);
        await waitForStage1Readiness(page, 'SCRATCH_NOT_READY');
        await verifyStage1IframeAndApiAgainstDisk(page, 'inspected', loadedPkg.p.sourceHash, diskInspected, true);
        await writeFile(join(artifactsDir, `${locale}-stage1-after-reset.png`), await page.screenshot());

        // 6. Direct Stage 3 click refuses with RIG_VERSION_UNAVAILABLE.
        await clickVisibleButton(page, '[data-review-stage="3"]', `830fc98 direct Stage 3 refusal (${locale})`);
        const catalog = locale === 'ko' ? koCatalog : enCatalog;
        const expectedRefusal = catalog['RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.']!;
        await assertRefusedStage3(page, locale, expectedRefusal);
        await writeFile(join(artifactsDir, `${locale}-stage3-direct-refused.png`), await page.screenshot());
        errorCollector.assertClean(`fixture-830fc98-${locale}`);

        localeReceipts[locale] = {
          ...(koPersistedDraftBeforeClear ? { persistedDraftBeforeClear: koPersistedDraftBeforeClear } : {}),
          chestRefusalStatus: statusText,
          precedingViewPreserved: true,
          beforeChestClick,
          afterChestClick,
          inspectedModelHash: diskInspected.modelHash,
          meshPanel: {
            buildId: meshBuildId,
            gridValue: gridEdited.entryGrid,
            modelHash: meshSetupSnapshot.diskModelHash,
            vertices: diskMesh.vertexCount,
            triangles: diskMesh.triangleCount,
            scratchHashes: meshCopiedHashes,
          },
          delta: {
            buildId: deltaBuildId,
            modelHash: deltaSetupSnapshot.diskModelHash,
            vertices: diskDelta.vertexCount,
            triangles: diskDelta.triangleCount,
            draggedVertex: namedId,
            ops: deltaRecord.delta.ops,
            scratchHashes: deltaCopiedHashes,
          },
          undoRestoredModelHash: undoRestoredSnapshot.stageModelHash,
          resetRestoredModelHash: resetRestoredSnapshot.stageModelHash,
        };
        await recordCheckpoint(`${locale}-completed`, localeReceipts[locale] as Record<string, unknown>);
      }

      await page.goto('about:blank');
      await page.close();
      page = undefined;
      const workerExitEvidence = await verifyOwnedWorkersExited(controlDir, ownedWorkers, [...frontPids]);

      const entryCountAfter = await verifyFixtureInventory(sealedFixtureRoot, inventoryPath);
      assertCondition(entryCountBefore === 209 && entryCountAfter === 209, 'Expected 209 invariant files before and after 830fc98 phase');

      const summary = {
        phase: 'fixture-830fc98',
        fixtureFilesVerified: entryCountAfter,
        locales: localeReceipts,
        runtimeExceptions: errorCollector.runtimeExceptions,
        consoleErrors: errorCollector.consoleErrors,
        workerExitEvidence,
      };
      await writeFile(join(artifactsDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      return summary;
    } catch (error) {
      await captureFailureArtifacts(
        artifactsDir,
        page,
        error,
        checkpoints,
        errorCollector.runtimeExceptions,
        errorCollector.consoleErrors,
        stateDir,
        ownedWorkers,
        [...frontPids],
      );
      throw error;
    } finally {
      if (page) await page.close();
      for (const worker of ownedWorkers) {
        try {
          process.kill(worker.pid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
      for (const fpid of frontPids) {
        try {
          process.kill(fpid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mode: { type: 'string' },
      'fixture-root': { type: 'string' },
      inventory: { type: 'string' },
      'toolchain-dir': { type: 'string' },
      'artifacts-dir': { type: 'string' },
    },
    strict: true,
  });

  const fixtureRoot = resolve(
    values['fixture-root'] ?? '.review-562-browser-input/create-830fc98/templates/example-remesh',
  );
  const inventoryPath = resolve(values.inventory ?? '.review-562-browser-input/parent-fixture-inventory.json');
  const mode: PhaseMode =
    values.mode === 'fixture-830fc98' || (values.mode === undefined && values['fixture-root'] !== undefined)
      ? 'fixture-830fc98'
      : 'synthetic';
  const artifactsDir = resolve(values['artifacts-dir'] ?? join('.review-562-browser-result/artifacts', mode));

  const summary =
    mode === 'fixture-830fc98'
      ? await runActualFixturePhase(fixtureRoot, inventoryPath, artifactsDir, values['toolchain-dir'])
      : await runSyntheticPhase(fixtureRoot, inventoryPath, artifactsDir);
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}
