import type { MeshOp } from '../../src/mesh-edit.ts';
import type { InputCdpSession } from '../parts-explorer-browser.ts';
import { withDeadline } from './walk-deadline.ts';

type Point = {x: number; y: number};
type Rect = Point & {left: number; top: number; width: number; height: number};
export interface DeltaSnapshot {
  edit: {
    slot: string; skin: string; attachment: string; hash: string; hull: number;
    vertices: [number, number][]; ops: MeshOp[];
    drawn: (Point & {state: string})[];
  };
  root: {left: string; top: string; transform: string};
  projection: {origin: Point; unitX: Point; unitY: Point};
  viewport: Rect;
  canvas: Rect;
  hitVertices: Point[];
}
interface PressReadback {
  client: Point;
  target: string;
  snapshot: DeltaSnapshot;
}
export interface DeltaDiagnostic {
  namedId?: number;
  read?: DeltaSnapshot;
  settled?: DeltaSnapshot;
  beforePress?: DeltaSnapshot;
  press?: PressReadback;
  after?: DeltaSnapshot;
}

// Passive DOM and public inspection API reads only. The three projected basis
// points retain the live scale in both axes without reaching into camera state.
export const STAGE1_DELTA_READ = `(() => {
  const editor = window.rigReviewEditor;
  const edit = editor?.meshEdit();
  if (!edit) return null;
  const root = document.getElementById('rig-root');
  const canvas = document.getElementById('rig-overlay');
  const rect = node => {
    const r = node.getBoundingClientRect();
    return {x:r.x, y:r.y, left:r.left, top:r.top, width:r.width, height:r.height};
  };
  const viewport = rect(root.parentElement);
  return {
    edit,
    root: {left:root.style.left, top:root.style.top, transform:root.style.transform},
    projection: {origin:editor.screen(0,0), unitX:editor.screen(1,0), unitY:editor.screen(0,1)},
    viewport, canvas:rect(canvas),
    hitVertices:edit.drawn.map(p => ({x:p.x-viewport.left, y:p.y-viewport.top}))
  };
})`;

function sourceIdentity(snapshot: DeltaSnapshot): string {
  const {slot, skin, attachment, hash, hull, vertices} = snapshot.edit;
  return JSON.stringify({slot, skin, attachment, hash, hull, vertices});
}

function geometry(snapshot: DeltaSnapshot): string {
  return JSON.stringify(snapshot);
}

export function assertNamedDeltaOps(ops: readonly MeshOp[], namedId: number): void {
  const movedIds = [...new Set(ops.flatMap(op => op.op === 'move' ? [op.v] : []))].sort((a,b) => a-b);
  if (ops.length !== 1 || JSON.stringify(movedIds) !== JSON.stringify([namedId]) || ops.some(op => op.op !== 'move')) {
    throw Error(`DELTA_MOVED_IDS_MISMATCH expected=${JSON.stringify([namedId])} actual=${JSON.stringify(movedIds)} ops=${JSON.stringify(ops)}`);
  }
  for (const op of ops) {
    if (op.op === 'move' && op.from[0] === op.to[0] && op.from[1] === op.to[1]) {
      throw Error(`DELTA_VERTEX_UNMOVED ${namedId}`);
    }
  }
}

/** One normal pointer gesture. A lost reply or changed geometry never resends it. */
export async function dragStage1Delta(
  page: Pick<InputCdpSession, 'evaluate' | 'mouse'>,
  persist: (diagnostic: DeltaDiagnostic) => Promise<void>,
  timeout = 5_000, // Existing editor entry allowance, 200 × 25 ms.
): Promise<number> {
  const diagnostic: DeltaDiagnostic = {};
  try {
    const settled = await withDeadline('DELTA_GEOMETRY_SETTLE', timeout, async signal => {
      let previous: DeltaSnapshot | undefined;
      for (;;) {
        signal.throwIfAborted();
        const current = await page.evaluate<DeltaSnapshot | null>(`new Promise(resolve => requestAnimationFrame(() => resolve(${STAGE1_DELTA_READ}())))`);
        signal.throwIfAborted();
        if (!current) continue;
        if (!diagnostic.read) {
          diagnostic.read = current;
          diagnostic.namedId = current.edit.hull + 1;
          const vertex = current.edit.drawn[diagnostic.namedId];
          if (current.edit.slot !== 'torso' || !vertex || ![vertex.x,vertex.y].every(Number.isFinite)) {
            throw Error('NO_INTERIOR_VERTEX');
          }
          if (current.edit.ops.length) throw Error('DELTA_ALREADY_EDITED');
        }
        if (sourceIdentity(current) !== sourceIdentity(diagnostic.read)) throw Error('DELTA_SOURCE_CHANGED');
        // Exact equality across successive animation frames, with no pixel tolerance.
        if (previous && geometry(current) === geometry(previous)) return current;
        previous = current;
      }
    });
    diagnostic.settled = settled;
    const namedId = diagnostic.namedId!;
    const vertex = settled.edit.drawn[namedId]!;
    await page.mouse('mouseMoved', vertex.x, vertex.y);
    diagnostic.beforePress = await page.evaluate<DeltaSnapshot>(`(() => {
      const read = ${STAGE1_DELTA_READ};
      const before = read();
      window.stage1DeltaPress = null;
      window.addEventListener('pointerdown', event => {
        window.stage1DeltaPress = {
          client:{x:event.clientX,y:event.clientY}, target:event.target?.id ?? '', snapshot:read()
        };
      }, {capture:true, passive:true, once:true});
      return before;
    })()`);
    if (geometry(diagnostic.beforePress) !== geometry(settled)) throw Error('DELTA_GEOMETRY_CHANGED_BEFORE_PRESS');
    await page.mouse('mousePressed', vertex.x, vertex.y);
    await page.mouse('mouseMoved', vertex.x+2, vertex.y+1);
    await page.mouse('mouseReleased', vertex.x+2, vertex.y+1);
    const readback = await page.evaluate<{press: PressReadback | null; after: DeltaSnapshot}>(`({press:window.stage1DeltaPress, after:${STAGE1_DELTA_READ}()})`);
    diagnostic.press = readback.press ?? undefined;
    diagnostic.after = readback.after;
    if (!diagnostic.press) throw Error('DELTA_POINTERDOWN_NOT_OBSERVED');
    if (geometry(diagnostic.press.snapshot) !== geometry(diagnostic.beforePress)) {
      throw Error('DELTA_GEOMETRY_CHANGED_AT_PRESS');
    }
    assertNamedDeltaOps(readback.after.edit.ops, namedId);
    const movedIds = readback.after.edit.drawn.flatMap((p,id) => p.state === 'moved' ? [id] : []);
    if (JSON.stringify(movedIds) !== JSON.stringify([namedId])) {
      throw Error(`DELTA_DRAWN_IDS_MISMATCH expected=[${namedId}] actual=${JSON.stringify(movedIds)}`);
    }
    const changedIds = readback.after.edit.drawn.flatMap((p,id) => {
      const before = settled.edit.drawn[id];
      return !before || p.x !== before.x || p.y !== before.y ? [id] : [];
    });
    if (JSON.stringify(changedIds) !== JSON.stringify([namedId])) {
      throw Error(`DELTA_SCREEN_IDS_MISMATCH expected=[${namedId}] actual=${JSON.stringify(changedIds)}`);
    }
    return namedId;
  } finally {
    await persist(diagnostic);
  }
}
