import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ClothFieldError,clothLinks,clothPatchKind,fieldText,fieldValue,readClothTargets,recipeFromFields,recipeOps,RECIPE_FIELDS,writtenDiff} from '../src/cloth-recipe.ts';
import {applyConfigPatch,type JsonValue} from '../src/config-patch.ts';

const recipe={chains:4,links:3,split:{at:1,into:2,hold_tip:true},damping:0.85,wind:[2,10],gravity:[5,30],strength:{trunk:50,branch:110,edge:45},swing:{scales:[1.3,1,1,1.3]},note:'kept'};
const config={key:'k',cloth:{bottomwear:recipe,'front hair':{chains:1,links:3,wind:[1,6],gravity:[2,12]}}};
const field=(key:string)=>RECIPE_FIELDS.find(f=>f.key===key)!;
const values=(r:unknown)=>Object.fromEntries(RECIPE_FIELDS.map(f=>[f.key,fieldText(r,f)]));

test('#111: the form reads a recipe as written and an unchanged form is no op',()=>{
 const v=values(recipe);
 expect(v).toMatchObject({chains:'4',links:'3','split.at':'1','split.hold_tip':'true',wind:'2, 10','swing.scales':'1.3, 1, 1, 1.3',length_ratio:'','influence.shape':''});
 expect(recipeOps(config,'bottomwear',recipeFromFields(v))).toEqual([]);
});

test('#111: each change is an op at /cloth/<tag>/…; object fields key by key; annotations and unknown keys are kept',()=>{
 const v={...values(recipe),links:'4','strength.edge':'40',damping:'','influence.across':'true','influence.max':'6','influence.shape':'smooth'};
 const ops=recipeOps(config,'bottomwear',recipeFromFields(v));
 expect(ops).toEqual([
  {op:'replace',path:'/cloth/bottomwear/links',value:4},
  {op:'remove',path:'/cloth/bottomwear/damping'},
  {op:'replace',path:'/cloth/bottomwear/strength/edge',value:40},
  {op:'add',path:'/cloth/bottomwear/influence',value:{across:true,max:6,shape:'smooth'}},
 ]);
 const patched=applyConfigPatch(config as unknown as JsonValue,ops) as {cloth:{bottomwear:Record<string,unknown>}};
 expect(patched.cloth.bottomwear.note).toBe('kept');expect(patched.cloth.bottomwear.links).toBe(4);expect('damping' in patched.cloth.bottomwear).toBe(false);
 // A tag with a space is a literal pointer token.
 expect(recipeOps(config,'front hair',recipeFromFields({...values(config.cloth['front hair']),translate:'0.2'}))).toEqual([{op:'add',path:'/cloth/front hair/translate',value:0.2}]);
});

test('#111: a tag the config lacks is added whole, a removed tag is one remove, a config without cloth gets the block',()=>{
 const next={links:3,wind:[1,8],gravity:[4,24]};
 expect(recipeOps(config,'back hair',next)).toEqual([{op:'add',path:'/cloth/back hair',value:next}]);
 expect(recipeOps(config,'front hair',null)).toEqual([{op:'remove',path:'/cloth/front hair'}]);
 expect(recipeOps(config,'back hair',null)).toEqual([]);
 expect(recipeOps({key:'k'},'bottomwear',next)).toEqual([{op:'add',path:'/cloth',value:{bottomwear:next}}]);
});

test('#111: field text is typed, never judged — the producer judges every value',()=>{
 expect(fieldValue(field('links'),'3')).toBe(3);
 expect(()=>fieldValue(field('links'),'3.5')).toThrow(ClothFieldError);
 expect(()=>fieldValue(field('wind'),'1')).toThrow('CLOTH_FIELD_INVALID wind');
 expect(fieldValue(field('wind'),'9, 1')).toEqual([9,1]);// tip below root: CONFIG_CLOTH_RESPONSE_GROWS_TO_TIP is the producer's
 expect(fieldValue(field('part'),'topwear')).toBe('topwear');expect(fieldValue(field('parts'),'a, b')).toEqual(['a','b']);
 expect(fieldValue(field('split.hold_tip'),'false')).toBe(false);expect(fieldValue(field('damping'),'  ')).toBeUndefined();
});

test('#111: the tags are the installed reader\'s own list',async()=>{
 expect(readClothTargets(`export const CLOTH_TARGETS = ['bottomwear', 'back hair', 'front hair'] as const;`)).toEqual(['bottomwear','back hair','front hair']);
 expect(readClothTargets('export const OTHER = 1;')).toBeNull();
 expect(clothPatchKind([{path:'/cloth/bottomwear/links'}])).toBe('cloth');
 expect(clothPatchKind([{path:'/cloth/bottomwear/links'},{path:'/constraints/0/damping'}])).toBe('mixed');
 expect(clothPatchKind([{path:'/constraints/0/damping'}])).toBe('none');
});

test('#111: the link preview reads each tag\'s parts (See-through tag or the recipe\'s part) and their chains\' points and tip',()=>{
 const cfg={cloth:{bottomwear:{links:2,wind:[1,2],gravity:[1,2],part:'dress'}},meshes:{skirt:{segments:[['hip',[0,0],[1,0]],'skirt0_']},dress:{segments:['dress0_']},hair:{segments:['tail_']}},
  bones:[{name:'hip',parent:'root',at:[0,0]},{chain:'skirt0_',parent:'hip',points:[[10,20],[12,40]],tip:[14,60]},{chain:'dress0_',parent:'hip',points:[[1,1]],tip:[2,2]},{chain:'tail_',parent:'head',points:[[5,5]],tip:[5,9]}]};
 const parts={parts:[{name:'skirt',from:'full:bottomwear'},{name:'hair',from:'head:back hair'},{name:'dress',from:'full:topwear'}]};
 expect(clothLinks(cfg,parts,['bottomwear','back hair','front hair'])).toEqual([
  {tag:'bottomwear',parts:['dress','skirt'],chains:[{chain:'skirt0_',points:[[10,20],[12,40],[14,60]]},{chain:'dress0_',points:[[1,1],[2,2]]}]},
  {tag:'back hair',parts:['hair'],chains:[{chain:'tail_',points:[[5,5],[5,9]]}]},
  {tag:'front hair',parts:[],chains:[]},
 ]);
});

test('#111 bar 1: the written config\'s diff lists every path, and a path outside the drafted sections is named',()=>{
 const input={key:'k',cloth:{bottomwear:{links:3}},bones:[{name:'a'}],constraints:[{name:'c',wind:1}],meshes:{skirt:{grid:31}},motion:{duration:4,tracks:[{bone:'a',prop:'rotate'}]}};
 const inside={...input,constraints:[{name:'c',wind:2}],meshes:{skirt:{influence:{cell:31}}},motion:{duration:4,tracks:[]}};
 expect(writtenDiff(input,input)).toEqual({count:0,paths:[],outside:[],sections:[]});
 expect(writtenDiff(input,inside)).toEqual({count:4,paths:['/constraints/0/wind','/meshes/skirt/grid','/meshes/skirt/influence','/motion/tracks/0'],outside:[],sections:['constraints','meshes.skirt','motion.tracks']});
 const outside=writtenDiff(input,{...inside,key:'other',motion:{duration:5,tracks:[]}});
 expect(outside.outside).toEqual(['/key','/motion/duration']);
});

test('#111 bar 3: the cloth runner and route never read or reference the producer\'s proposal file or its shape',async()=>{
 const root=join(import.meta.dir,'..');
 for(const file of ['src/cloth-recipe.ts','src/rebuild.ts','web/cloth-panel.ts','web/rebuild-client.ts']){
  const text=await readFile(join(root,file),'utf8');
  // No proposal file name, no Proposal type, no import of the producer's propose module or its serializer.
  expect({file,hits:text.match(/proposal\.json|basis\.json|\bProposal\b|serializeProposal|clothConfigEdits|writtenClothConfig|from\s+['"][^'"]*propose(\.ts)?['"]/g)}).toEqual({file,hits:null});
  // Nothing under the scratch `propose/` output directory is read back.
  expect({file,reads:text.match(/join\([^)]*['"]propose['"][^)]*\)/g)}).toEqual({file,reads:null});
 }
});

test('#185: clearing an object field\'s last known key removes the object, and keeps it while an unknown key stays',()=>{
 const base={links:3,wind:[0,1],gravity:[0,1]};
 const cleared=(rec:Record<string,unknown>)=>{const v=values(rec);v['split.at']='';return recipeOps({cloth:{t:rec}},'t',recipeFromFields(v));};
 const apply=(rec:Record<string,unknown>)=>(applyConfigPatch({cloth:{t:rec}} as unknown as JsonValue,cleared(rec)) as {cloth:{t:Record<string,unknown>}}).cloth.t;
 // Only known keys: the parent goes, never `split: {}`.
 expect(cleared({...base,split:{at:1}})).toEqual([{op:'remove',path:'/cloth/t/split'}]);
 expect(apply({...base,split:{at:1}})).toEqual(base);
 // An unknown child key is kept, so only the cleared field is removed.
 expect(cleared({...base,split:{at:1,note:'x'}})).toEqual([{op:'remove',path:'/cloth/t/split/at'}]);
 expect(apply({...base,split:{at:1,note:'x'}})).toEqual({...base,split:{note:'x'}});
});
