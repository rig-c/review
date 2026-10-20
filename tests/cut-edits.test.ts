import {expect,test} from 'bun:test';
import {applyConfigPatch,assertOpNames,jsonDiff,type JsonValue} from '../src/config-patch.ts';
import {cutOps,cutsDraft,cutsDraftText,cutsSource,dragPoint,rangeArc,setBox,setRange,setVertex} from '../src/cut-edits.ts';

const config={assemble:{plan:[['bottomwear','full','bottomwear'],['topwear','full','topwear']],
 cuts:[{from:'bottomwear',into:'ribbon_r',polygon:[[368,450],[393,450],[389,742],[364,742]],draw:{before:'topwear'},overlap:2,under:'ribbon_r_under.png'}],
 patches:[{name:'hem',box:[10,20,30,40],alpha:'silhouette',draw:'back'}]},
 limbs:{arm_r:{segments:[{part:'upperarm_r',from:'handwear_r',bone:'sleeve_r0'},{part:'forearm_r',from:'handwear_r',bone:'sleeve_r1',joint:'elbow'}]}},
 regions:{ribbon_r:'hip',hem:'hip'}};

test('#115: the config read as the Cuts block edits it',()=>{
 const s=cutsSource(config);
 expect(s.plan).toEqual(['bottomwear','topwear']);
 expect(s.cuts).toEqual([{index:0,from:'bottomwear',into:'ribbon_r',polygon:[[368,450],[393,450],[389,742],[364,742]],draw:{before:'topwear'},overlap:2,under:'ribbon_r_under.png'}]);
 expect(s.patches[0]).toMatchObject({index:0,name:'hem',box:[10,20,30,40]});
 expect(s.segments.map(g=>[g.part,g.joint,g.range])).toEqual([['upperarm_r',null,null],['forearm_r','elbow',null]]);
 expect(cutsSource({assemble:{cuts:[{from:'x',into:'y',polygon:[[1,1]],draw:'front',overlap:0}]}}).skipped).toEqual(['assemble.cuts[0] is not {from, into, polygon, draw, overlap}']);
});

test('#115: every edit is one op at its own pointer naming its entry, and the patched config differs only there',()=>{
 const s=cutsSource(config);
 let edits=setVertex(new Map(),s.cuts[0]!,2,[386,742]);
 edits=setBox(edits,s.patches[0]!,[10,20,31,40]);
 edits=setRange(edits,s.segments[1]!,[-90,45]);
 const ops=cutOps(edits,[],config);
 expect(ops).toEqual([
  {op:'replace',path:'/assemble/cuts/0/polygon/2',value:[386,742],name:'ribbon_r'},
  {op:'replace',path:'/assemble/patches/0/box',value:[10,20,31,40],name:'hem'},
  {op:'add',path:'/limbs/arm_r/segments/1/range',value:[-90,45],name:'forearm_r'},
 ]);
 expect(()=>assertOpNames(config as JsonValue,ops)).not.toThrow();
 expect(jsonDiff(config,applyConfigPatch(config as JsonValue,ops))).toEqual(['/assemble/cuts/0/polygon/2/0','/assemble/patches/0/box/2','/limbs/arm_r/segments/1/range']);
 // Back to the config's value: the edit goes.
 expect(cutOps(setVertex(edits,s.cuts[0]!,2,[389,742]),[],config).map(o=>o.path)).not.toContain('/assemble/cuts/0/polygon/2');
 // A name that is not the entry's is the server's EDIT_PATCH_NAME_MISMATCH.
 expect(()=>assertOpNames(config as JsonValue,[{...ops[0]!,name:'ribbon_l'}])).toThrow('EDIT_PATCH_NAME_MISMATCH');
});

test('#115: review refuses only what is not the loader\'s type; the rest is the producer\'s',()=>{
 const s=cutsSource(config);
 expect(()=>setVertex(new Map(),s.cuts[0]!,0,[368.5,450])).toThrow('CUTS_VALUE_INVALID');
 expect(()=>setVertex(new Map(),s.cuts[0]!,0,[-1,450])).toThrow('CUTS_VALUE_INVALID');
 expect(()=>setBox(new Map(),s.patches[0]!,[30,20,10,40])).toThrow('CUTS_VALUE_INVALID');
 expect(()=>setRange(new Map(),s.segments[0]!,[-10,10])).toThrow('CUTS_RANGE_UPPER');
 // A range out of order or a point past the rig is sent: CONFIG_LIMB_RANGE and ASSEMBLE_CUT_INSIDE are the producer's.
 expect(cutOps(setRange(new Map(),s.segments[1]!,[10,20]),[],config)[0]).toMatchObject({value:[10,20]});
 expect(cutOps(setVertex(new Map(),s.cuts[0]!,1,[9000,450]),[],config)[0]).toMatchObject({value:[9000,450]});
});

test('#115: a new cut or patch adds its entry and its regions bone; it names no under',()=>{
 const ops=cutOps(new Map(),[{kind:'cut',from:'topwear',into:'sash',polygon:[[1,2],[3,4],[5,6]],draw:'front',overlap:1,bone:'chest'},{kind:'patch',name:'gap',box:[0,0,4,4],alpha:'box',draw:{before:'topwear'},bone:'hip'}],config);
 expect(ops).toEqual([
  {op:'add',path:'/assemble/cuts/-',value:{from:'topwear',into:'sash',polygon:[[1,2],[3,4],[5,6]],draw:'front',overlap:1}},
  {op:'add',path:'/regions/sash',value:'chest'},
  {op:'add',path:'/assemble/patches/-',value:{name:'gap',box:[0,0,4,4],alpha:'box',draw:{before:'topwear'}}},
  {op:'add',path:'/regions/gap',value:'hip'},
 ]);
 const bare={assemble:{plan:[]},regions:{}};
 expect(cutOps(new Map(),[{kind:'cut',from:'a',into:'b',polygon:[[1,2],[3,4],[5,6]],draw:'front',overlap:0,bone:'hip'}],bare)[0]).toEqual({op:'add',path:'/assemble/cuts',value:[{from:'a',into:'b',polygon:[[1,2],[3,4],[5,6]],draw:'front',overlap:0}]});
 expect(()=>cutOps(new Map(),[{kind:'cut',from:'a',into:'b',polygon:[[1,2],[3,4]],draw:'front',overlap:0,bone:'hip'}],config)).toThrow('CUTS_POLYGON_SHORT');
});

test('#115: drags snap to whole rig px; the range arc turns counter-clockwise on screen; the draft keeps only edits that still resolve',()=>{
 expect(dragPoint([389,742],[100.2,100.2],[97.4,101.9])).toEqual([386,744]);
 const arc=rangeArc([0,0],[10,0],[0,90],10,45);
 expect(arc[0]).toEqual([0,0]);expect(arc[1]![0]).toBeCloseTo(10);expect(arc.at(-1)![1]).toBeCloseTo(-10);
 const s=cutsSource(config),edits=setVertex(new Map(),s.cuts[0]!,2,[386,742]);
 expect([...cutsDraft(cutsDraftText(edits,[]),s).edits.keys()]).toEqual(['/assemble/cuts/0/polygon/2']);
 const moved=cutsSource({...config,assemble:{...config.assemble,cuts:[{...config.assemble.cuts[0]!,polygon:[[368,450],[393,450],[390,742],[364,742]]}]}});
 expect(cutsDraft(cutsDraftText(edits,[]),moved).edits.size).toBe(0);
});
