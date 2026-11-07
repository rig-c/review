import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { assertNamedDeltaOps, dragStage1Delta, type DeltaDiagnostic } from './helpers/stage1-delta-target.ts';
import type { MeshOp } from '../src/mesh-edit.ts';

// VM-only geometry and event fixtures. These are no owner review or approval acts.
function fixture(options: {edge?: boolean; changeAtPress?: boolean; neverSettles?: boolean; lostPress?: boolean; unchangedPixels?: boolean; unmovedState?: boolean} = {}) {
  const events: {type: string; x: number; y: number}[] = [];
  const diagnostics: DeltaDiagnostic[] = [];
  let frame = 0;
  let offset = 10;
  let ops: MeshOp[] = [];
  let pointerdown: ((event: unknown) => void) | undefined;
  const initialVertices: [number, number][] = [[0,0],[20,0],[10,10],[0,20]];
  const root = {
    style: {
      get left() { return offset+'px'; }, top: '20px', transform: 'scale(2)',
    },
    parentElement: {getBoundingClientRect: () => ({x:100,y:50,left:100,top:50,width:400,height:300})},
  };
  const window = {
    stage1DeltaPress: null as unknown,
    addEventListener: (name: string, listener: (event: unknown) => void, flags: unknown) => {
      expect(name).toBe('pointerdown');
      expect(flags).toEqual({capture:true,passive:true,once:true});
      pointerdown = listener;
    },
    rigReviewEditor: {
      screen: (x: number,y: number) => ({x:100+offset+x*2,y:70-y*2}),
      meshEdit: () => ({
        slot:'torso',skin:'default',attachment:'torso',hash:'fixture-source',hull:1,
        vertices:initialVertices,ops,
        drawn:initialVertices.map(([x,y],id) => {
          const op = ops.find(op => op.op === 'move' && op.v === id);
          const [dx,dy] = op?.op === 'move' && !options.unchangedPixels ? op.to : [x,y];
          return {x:100+offset+dx*2,y:70-dy*2,state:op && !options.unmovedState ? 'moved' : 'source'};
        }),
      }),
    },
  };
  const globals = {
    window,
    document: {getElementById: (id: string) => id === 'rig-root' ? root : root.parentElement},
    requestAnimationFrame: (callback: () => void) => setTimeout(() => {
      frame++;
      // Simulate layout changing after the first truthy editor read.
      offset = options.neverSettles ? frame*10 : Math.min(frame,3)*10;
      callback();
    }, 1),
  };
  const page = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression,globals) as T;
    },
    async mouse(type: string,x: number,y: number): Promise<void> {
      events.push({type,x,y});
      if (type === 'mousePressed') {
        if (options.changeAtPress) offset++;
        pointerdown?.({clientX:x,clientY:y,target:{id:'rig-overlay'}});
        pointerdown = undefined;
        if (options.lostPress) throw Error('lost press reply');
      }
      if (type === 'mouseReleased') {
        const ids = options.edge ? [1,3] : [2];
        ops = ids.map(v => ({op:'move',v,from:initialVertices[v]!,to:[initialVertices[v]![0]+1,initialVertices[v]![1]+.5]}));
      }
    },
  };
  return {page,events,diagnostics,persist:async (value: DeltaDiagnostic) => {diagnostics.push(value);}};
}

test('actual helper waits for unchanged frame geometry, preserves named interior ID and sends one drag', async () => {
  const f = fixture();
  expect(await dragStage1Delta(f.page,f.persist)).toBe(2);
  expect(f.events).toEqual([
    {type:'mouseMoved',x:150,y:50},
    {type:'mousePressed',x:150,y:50},
    {type:'mouseMoved',x:152,y:51},
    {type:'mouseReleased',x:152,y:51},
  ]);
  const d = f.diagnostics[0]!;
  expect(d.namedId).toBe(2);
  expect(d.read!.root.left).toBe('10px');
  expect(d.settled!.root.left).toBe('30px');
  expect(d.beforePress).toEqual(d.settled);
  expect(d.press!.snapshot).toEqual(d.beforePress!);
  expect(d.press!.client).toEqual({x:150,y:50});
  expect(d.press!.snapshot.projection).toEqual({origin:{x:130,y:70},unitX:{x:132,y:70},unitY:{x:130,y:68}});
  expect(d.press!.snapshot.viewport).toEqual({x:100,y:50,left:100,top:50,width:400,height:300});
  expect(d.press!.snapshot.canvas).toEqual(d.press!.snapshot.viewport);
  expect(d.press!.snapshot.hitVertices[2]).toEqual({x:50,y:0});
  expect(d.after!.edit.ops).toEqual([{op:'move',v:2,from:[10,10],to:[11,10.5]}]);
});

test('an accidental edge move fails exact IDs before Apply, retaining both actual moved IDs', async () => {
  const f = fixture({edge:true});
  await expect(dragStage1Delta(f.page,f.persist)).rejects.toThrow('DELTA_MOVED_IDS_MISMATCH expected=[2] actual=[1,3]');
  expect(f.events.map(event => event.type)).toEqual(['mouseMoved','mousePressed','mouseMoved','mouseReleased']);
  expect(f.diagnostics[0]!.after!.edit.ops.map(op => op.op === 'move' && op.v)).toEqual([1,3]);
});

test('geometry changing at actual pointerdown is recorded and refuses without a second gesture', async () => {
  const f = fixture({changeAtPress:true});
  await expect(dragStage1Delta(f.page,f.persist)).rejects.toThrow('DELTA_GEOMETRY_CHANGED_AT_PRESS');
  expect(f.events).toHaveLength(4);
  expect(f.diagnostics[0]!.press!.snapshot.root.left).toBe('31px');
  expect(f.diagnostics[0]!.beforePress!.root.left).toBe('30px');
});

test('unstable geometry reaches the existing bounded allowance before any pointer input', async () => {
  const f = fixture({neverSettles:true});
  await expect(dragStage1Delta(f.page,f.persist,40)).rejects.toThrow('WALK_DEADLINE: DELTA_GEOMETRY_SETTLE');
  expect(f.events).toEqual([]);
  expect(f.diagnostics).toHaveLength(1);
  expect(f.diagnostics[0]!.read).toBeDefined();
});

test('lost pointerdown reply never retries the press or proceeds to Apply', async () => {
  const f = fixture({lostPress:true});
  await expect(dragStage1Delta(f.page,f.persist)).rejects.toThrow('lost press reply');
  expect(f.events.map(event => event.type)).toEqual(['mouseMoved','mousePressed']);
  expect(f.diagnostics).toHaveLength(1);
});

test('a named move op and moved marker cannot pass without changed screen geometry', async () => {
  const f = fixture({unchangedPixels:true});
  await expect(dragStage1Delta(f.page,f.persist)).rejects.toThrow('DELTA_SCREEN_IDS_MISMATCH expected=[2] actual=[]');
  expect(f.events).toHaveLength(4);
  expect(f.diagnostics[0]!.after!.edit.ops).toHaveLength(1);
});

test('a named move op and changed screen geometry cannot pass without a moved drawn state', async () => {
  const f = fixture({unmovedState:true});
  await expect(dragStage1Delta(f.page,f.persist)).rejects.toThrow('DELTA_DRAWN_IDS_MISMATCH expected=[2] actual=[]');
  expect(f.events).toHaveLength(4);
  expect(f.diagnostics[0]!.after!.edit.ops).toEqual([{op:'move',v:2,from:[10,10],to:[11,10.5]}]);
  expect(f.diagnostics[0]!.after!.edit.drawn[2]).toEqual({x:152,y:49,state:'source'});
});

test('operation oracle rejects extra moves, other edit kinds, empty and no-op deltas', () => {
  const moved: MeshOp = {op:'move',v:29,from:[1,2],to:[2,3]};
  assertNamedDeltaOps([moved],29);
  for (const ops of [[],[moved,{...moved,v:42}],[moved,{op:'remove',v:7}]] as MeshOp[][]) {
    expect(() => assertNamedDeltaOps(ops,29)).toThrow('DELTA_MOVED_IDS_MISMATCH');
  }
  expect(() => assertNamedDeltaOps([{...moved,to:[1,2]}],29)).toThrow('DELTA_VERTEX_UNMOVED');
  for (const ids of [[42,62],[28,42]]) {
    expect(() => assertNamedDeltaOps(ids.map(v => ({...moved,v})),29)).toThrow(
      `DELTA_MOVED_IDS_MISMATCH expected=[29] actual=${JSON.stringify(ids)}`,
    );
  }
});

test('operation oracle refuses a double committed delta on the same vertex 29', () => {
  const moved: MeshOp = {op:'move',v:29,from:[1,2],to:[2,3]};
  const second: MeshOp = {op:'move',v:29,from:[2,3],to:[3,4]};
  expect(() => assertNamedDeltaOps([moved,second],29)).toThrow(
    'DELTA_MOVED_IDS_MISMATCH expected=[29] actual=[29]',
  );
});
