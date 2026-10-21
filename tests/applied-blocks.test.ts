import {expect,test} from 'bun:test';
import {appliedBlockOps,itemApplied,opKey,recordBlock} from '../src/applied-blocks.ts';
import {recipeFromFields,recipeOps,fieldText,RECIPE_FIELDS} from '../src/cloth-recipe.ts';
import {CONFIG_PATCH_SCHEMA,type PatchOp} from '../src/config-patch.ts';
import {cutOps,cutsSource,setVertex} from '../src/cut-edits.ts';
import {patchAppliedRecord,type PatchJobView} from '../web/rebuild-client.ts';

const config={assemble:{plan:[['bottomwear','full','bottomwear'],['topwear','full','topwear']],
 cuts:[{from:'bottomwear',into:'ribbon_r',polygon:[[368,450],[393,450],[389,742],[364,742]],draw:{before:'topwear'},overlap:2}]},
 regions:{ribbon_r:'hip'},
 cloth:{'front hair':{chain:['hair_f0','hair_f1']}}};
const hex=(c:string)=>c.repeat(64);

/** The record a built patch job carries into the draft and `context.applied` — the same constructor main.ts uses. */
function record(id:string,op:'build'|'cloth'|'rig',ops:PatchOp[]){
 const patch={schema:CONFIG_PATCH_SCHEMA,config_sha256:hex('c'),ops,producer:{name:'@rig-c/parts',version:'1.50.0'},op:{cmd:'rig' as const,args:[]}};
 const job={id,kind:'patch',op,status:'built',reused:false,lines:[],producerLine:'ok',exitCode:0,wallMs:{op:1,compile:1,check:1},check:null,diff:null,
  build:{modelUrl:'m',modelHash:hex(id[0]!),files:{}},request:{patch,patchSha256:hex('d'),configHash:hex('c')},producer:{package:'@rig-c/parts',version:'1.50.0'},compiler:{package:'@rig-c/compiler',version:'1.0.0'}} as unknown as PatchJobView;
 return patchAppliedRecord(job);
}

/** The pending ops each block would send: one cut vertex edit, one cloth recipe field. */
const s=cutsSource(config);
const cutPending=cutOps(setVertex(new Map(),s.cuts[0]!,2,[386,742]),[],config);
const values=Object.fromEntries(RECIPE_FIELDS.map(f=>[f.key,fieldText(config.cloth['front hair'],f)]));
const clothPending=recipeOps(config,'front hair',recipeFromFields({...values,translate:'0.2'}));
const marks=(stage:unknown)=>{const on=appliedBlockOps(stage);return {cuts:cutPending.map(o=>itemApplied([o],on.cuts)),cloth:clothPending.map(o=>itemApplied([o],on.cloth))};};

test('#172: after an undo the blocks mark the predecessor record\'s ops; at depth 0, none',()=>{
 expect(cutPending.length).toBe(1);expect(clothPending.length).toBe(1);
 // Apply a cut op, then a cloth op: the session's stack, the last record on the stage.
 const stack=[record('a1','build',cutPending),record('b2','cloth',clothPending)];
 const stage=()=>stack.at(-1)??null;
 // The cloth build is on the stage: its record (patched from the handoff config) holds only the cloth op.
 expect(marks(stage())).toEqual({cuts:[false],cloth:[true]});
 // Undo once: the cut build is back on the stage.
 stack.pop();
 expect(marks(stage())).toEqual({cuts:[true],cloth:[false]});
 // Undo again: the inspected build, no record.
 stack.pop();
 expect(stage()).toBeNull();
 expect(marks(stage())).toEqual({cuts:[false],cloth:[false]});
});

test('#172: the record → block rule',()=>{
 expect(recordBlock(record('a1','build',cutPending))).toBe('cuts');
 expect(recordBlock(record('b2','cloth',clothPending))).toBe('cloth');
 // A physics or bones `rig` patch, a non-patch record or none marks nothing in either block.
 expect(recordBlock(record('c3','rig',[{op:'replace',path:'/constraints/0/damping',value:0.8,name:'c0'}]))).toBeNull();
 expect(recordBlock({schema:'rig-review-applied/1',buildId:hex('e'),part:'chest',regions:[]})).toBeNull();
 expect(recordBlock({schema:'rig-review-applied/3',buildId:hex('e'),op:'remesh'})).toBeNull();
 expect(recordBlock(null)).toBeNull();
 expect(appliedBlockOps(null)).toEqual({cuts:[],cloth:[]});
 expect(appliedBlockOps(record('a1','build',cutPending))).toEqual({cuts:cutPending,cloth:[]});
 expect(appliedBlockOps(record('b2','cloth',clothPending))).toEqual({cuts:[],cloth:clothPending});
});

test('#172: a pending item is applied only when every op it sends is in the record, value and name included',()=>{
 const op=cutPending[0]!;
 expect(itemApplied([op],[op])).toBe(true);
 expect(itemApplied([op],[{...op,value:[387,742]}])).toBe(false);
 expect(itemApplied([op],[{...op,name:'other'}])).toBe(false);
 expect(itemApplied([op,clothPending[0]!],[op])).toBe(false);
 expect(itemApplied([],[op])).toBe(false);
 expect(itemApplied([op],[])).toBe(false);
 expect(opKey({op:'remove',path:'/a'})).toBe(opKey({op:'remove',path:'/a'}));
});
