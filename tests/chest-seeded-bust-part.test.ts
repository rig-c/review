import {expect,test} from 'bun:test';
import {ellipsePolygon} from '../src/chest-regions.ts';
import {meshEntryText,parseRebuildRequest} from '../src/rebuild.ts';
import {chestSeed,designatedRegions,pickPart,seedFields} from '../web/rebuild-client.ts';
import {chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';

// #314: circles the editor seeds from `contour.bust` name their part when the config has more than one contour part.
// The part resolver reads a part's regions as the producer does: the regions it writes, then the two it derives from
// `contour.bust`. A Circles Apply on a bust-only part sends those circles as the part's regions in place of the shorthand.
const circle=(name:string,bone:string,cx:number,cy:number,r:number)=>({name,shape:'circle',cx,cy,r,bone,spacing:4,band:10});
const landmarks={apex_r:[384,345],apex_l:[446,345],cleavage:[415,350],bone_r:'boob_r',bone_l:'boob_l'};
const topwear={tolerance:2,margin:2,spacing:28,bust:landmarks};
const skirtRegions=[circle('hem','hips',300,700,30)];
const skirt={tolerance:2,margin:2,spacing:28,regions:skirtRegions};
const status={parts:[{name:'topwear',regions:[]},{name:'skirt',regions:skirtRegions}],contour:{topwear:{contour:topwear},skirt:{contour:skirt}}};
const configText=JSON.stringify({meshes:{topwear:{source:'topwear.png',contour:topwear},skirt:{source:'skirt.png',contour:skirt}}},null,1);
const reader=(values:Record<string,string>)=>(id:string):ChestFieldValue|undefined=>id in values?{value:values[id]!}:undefined;

test('Bar 1: a seeded chest circle on a bust-only part beside a second contour part rebuilds the bust part, and only it',()=>{
 const seed=chestSeed(status);
 expect(seed.part).toBe('topwear');
 const values=seedFields(status,()=>undefined)!;
 expect(values[chestRowId(0,'name')]).toBe('bust_r');
 values[chestRowId(0,'cx')]='390';
 const out=designatedRegions(reader(values),seed);
 if(!('regions' in out))throw new Error(out.error);
 expect(pickPart(status,out.regions)).toBe('topwear');
 // The server writes that one part's entry: the edited circles stand in for the landmarks they were seeded from, so
 // the producer does not meet bust_r and bust_l twice (its CONFIG_REGION_NAME_UNIQUE), and every other field is as written.
 const body=JSON.parse(JSON.stringify({part:'topwear',regions:out.regions,configHash:'0'.repeat(64)}));
 const entry=JSON.parse(meshEntryText(configText,'topwear',parseRebuildRequest(body,null).regions));
 expect(entry).toEqual({source:'topwear.png',contour:{tolerance:2,margin:2,spacing:28,regions:out.regions}});
 expect(out.regions.map(r=>[r.name,r.bone])).toEqual([['bust_r','boob_r'],['bust_l','boob_l']]);
 expect(out.regions[0]).toMatchObject({cx:390,cy:345});
 // An untouched Apply names the same part.
 const untouched=designatedRegions(reader(seedFields(status,()=>undefined)!),seed);
 if(!('regions' in untouched))throw new Error(untouched.error);
 expect(pickPart(status,untouched.regions)).toBe('topwear');
});

test('Bar 1, a skirt with no regions: the seeded circles name the bust part, where they named none before',()=>{
 const bare={parts:[{name:'topwear',regions:[]},{name:'skirt',regions:[]}],contour:{topwear:{contour:topwear},skirt:{contour:{tolerance:2,margin:2,spacing:28}}}};
 const out=designatedRegions(reader(seedFields(bare,()=>undefined)!),chestSeed(bare));
 if(!('regions' in out))throw new Error(out.error);
 expect(pickPart(bare,out.regions)).toBe('topwear');
});

test('a part that writes regions beside contour.bust keeps the shorthand: only a bust-only entry gives it up',()=>{
 const mixed={...topwear,regions:[circle('belly','spine',400,420,20)]};
 const text=JSON.stringify({meshes:{topwear:{contour:mixed}}},null,1);
 const entry=JSON.parse(meshEntryText(text,'topwear',[circle('belly','spine',402,420,20) as never]));
 expect(entry.contour.bust).toEqual(landmarks);
 expect(entry.contour.regions).toEqual([circle('belly','spine',402,420,20)]);
});

test('Bar 3 control: rows whose bones name two contour parts still refuse, derived bust bones included',()=>{
 // The skirt also writes a region on boob_r: a row on boob_r names both parts.
 const shared={parts:[{name:'topwear',regions:[]},{name:'skirt',regions:[circle('flap','boob_r',300,700,30)]}],contour:{topwear:{contour:topwear},skirt:{contour:{...skirt,regions:[circle('flap','boob_r',300,700,30)]}}}};
 const out=designatedRegions(reader(seedFields(shared,()=>undefined)!),chestSeed(shared));
 if(!('regions' in out))throw new Error(out.error);
 expect(pickPart(shared,out.regions)).toBeNull();
 // Two parts that both state contour.bust on the same bones: ambiguous.
 const twice={parts:[{name:'topwear',regions:[]},{name:'dress',regions:[]}],contour:{topwear:{contour:topwear},dress:{contour:topwear}}};
 const both=designatedRegions(reader(seedFields(twice,()=>undefined)!),chestSeed(twice));
 if(!('regions' in both))throw new Error(both.error);
 expect(pickPart(twice,both.regions)).toBeNull();
 // A landmarks spec the producer would refuse derives nothing, so it names no part.
 const broken={parts:[{name:'topwear',regions:[]},{name:'skirt',regions:skirtRegions}],contour:{topwear:{contour:{...topwear,bust:{apex_r:[384,345]}}},skirt:{contour:skirt}}};
 expect(pickPart(broken,[circle('bust_r','boob_r',384,345,6) as never])).toBeNull();
});

test('Bar 4 (#317): a kept region beyond the rows that shares a bone with another contour part resolves to the seeded part',()=>{
 const third={name:'belly',bone:'hips',shape:'polygon',points:ellipsePolygon([200,420],[30,20],32),spacing:6,band:8};
 const regions=[circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),third];
 const kept={parts:[{name:'topwear',regions},{name:'skirt',regions:skirtRegions}],contour:{topwear:{contour:{regions}},skirt:{contour:skirt}}};
 const values=seedFields(kept,()=>undefined)!;values[chestRowId(0,'cx')]='220';
 const out=designatedRegions(reader(values),chestSeed(kept));
 if(!('regions' in out))throw new Error(out.error);
 expect(out.regions.map(r=>r.name)).toEqual(['bust_r','bust_l','belly']);
 expect(pickPart(kept,out.regions)).toBe('topwear');
});
