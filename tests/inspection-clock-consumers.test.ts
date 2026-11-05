import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {applyAnimationOps,parseAnimationSourceOp} from '../src/animation-ops.ts';
const main=await readFile(new URL('../web/main.ts',import.meta.url),'utf8');
// Execute the actual consumer body with distinct clocks, without importing the page's startup side effects.
const refresh=main.slice(main.indexOf('function refreshAnimationInspection()'),main.indexOf('\nlet overlays:'));
test('inspection panel consumes shown time while the accumulated runtime remains untouched',()=>{
 for(const shown of [0,.375,1]){
  const updates:number[]=[],player={time:4.375,current:'pulse'};
  const panel={update:(t:number)=>updates.push(t),model:()=>{},unavailable:()=>{}};
  new Function('animationPanel','player','time','duration','partModel','inspectionSourceState',refresh+';refreshAnimationInspection();')(panel,player,shown,1,{},'ready');
  expect(updates).toEqual([shown,shown]);expect(player.time).toBe(4.375);
 }
});
test('scratch replacement snapshots inspected time before pause/load and retains bounded seek semantics',()=>{
 const swap=main.slice(main.indexOf('async function swapRig('),main.indexOf('\n/**\n * Mesh Apply'));
 const expression=swap.match(/keepTime=([^,]+),wasPlaying/)![1]!;
 const player={time:4.375};expect(new Function('player','time','return '+expression)(player,.375)).toBe(.375);
 expect(player.time).toBe(4.375);expect(swap).toContain("seek(keepTime,{kind:'reload'})");
});

// Supplied operations are a separate boundary: neither reader may normalize invalid input.
test('invalid supplied operation and serialized operation record keep their time refusals',()=>{
 const source=JSON.stringify({spec:'rigc-motion/1',animations:{pulse:{duration:1,tracks:[{bone:'chest',property:'rotate',keys:[{t:0,v:[0]},{t:1,v:[15]}]}]}}});
 const op={op:'insert_key' as const,animation:'pulse',track:0,time:-1,value:[2]};
 expect(()=>applyAnimationOps(source,[op])).toThrow('ANIMATION_KEY_TIME_INVALID');
 expect(()=>parseAnimationSourceOp(JSON.parse(JSON.stringify(op)),'draft.ops[0]')).toThrow('draft.ops[0].time: expected finite number >= 0');
});
