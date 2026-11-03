import {expect,test} from 'bun:test';
import {ellipsePolygon} from '../src/chest-regions.ts';
import {parseRebuildRequest,meshEntryText} from '../src/rebuild.ts';
import {chestSeed,designatedRegions,seedFields} from '../web/rebuild-client.ts';
import {chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';

// #317: Apply from the chest editor keeps every region the editor did not seed (beyond its two rows), unchanged and in
// order, or refuses by name. It never drops one silently.
const circle=(name:string,bone:string,cx:number,cy:number,r:number)=>({name,shape:'circle',cx,cy,r,bone,spacing:4,band:10});
const third={name:'belly',bone:'spine',shape:'polygon',points:ellipsePolygon([200,420],[30,20],32),spacing:6,band:8};
const statusOf=(regions:unknown[])=>({parts:[{name:'topwear',regions}],contour:{topwear:{contour:{tolerance:0.5,margin:1,spacing:14,stray:4,regions}}}});
const configOf=(regions:unknown[])=>JSON.stringify({meshes:{topwear:{source:'topwear.png',contour:{tolerance:0.5,margin:1,spacing:14,stray:4,regions}}}},null,1);
const reader=(values:Record<string,string>)=>(id:string):ChestFieldValue|undefined=>id in values?{value:values[id]!}:undefined;
const seeded=(regions:unknown[])=>seedFields(statusOf(regions),()=>undefined)!;

test('Bar 1: after an edit to row 1, the request carries all three regions and the third is byte-identical to the config',()=>{
 const regions=[circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),third];
 const values=seeded(regions);values[chestRowId(0,'cx')]='220';
 const out=designatedRegions(reader(values),chestSeed(statusOf(regions)));
 if(!('regions' in out))throw new Error(out.error);
 expect(out.regions.map(r=>r.name)).toEqual(['bust_r','bust_l','belly']);
 expect(out.regions[0]).toEqual({...circle('bust_r','boob_r',220,318,17)} as never);
 expect(JSON.stringify(out.regions[2])).toBe(JSON.stringify(third));
 // The server reads the body and writes the entry with the third region as written.
 const body=JSON.parse(JSON.stringify({part:'topwear',regions:out.regions,configHash:'0'.repeat(64)}));
 const entry=JSON.parse(meshEntryText(configOf(regions),'topwear',parseRebuildRequest(body,null).regions));
 expect(JSON.stringify(entry.contour.regions[2])).toBe(JSON.stringify(third));
});

test('an untouched Apply of a three-region config sends all three verbatim, in order',()=>{
 const regions=[circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),third,circle('nape','neck',240,120,9)];
 const out=designatedRegions(reader(seeded(regions)),chestSeed(statusOf(regions)));
 if(!('regions' in out))throw new Error(out.error);
 expect(JSON.stringify(out.regions)).toBe(JSON.stringify(regions));
});

test('a region beyond the rows that cannot be sent back as written refuses Apply by name',()=>{
 const odd={name:'hem',bone:'hips',shape:'rect',x:1,y:2,w:3,h:4,spacing:4,band:10};
 const regions=[circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),odd];
 const out=designatedRegions(reader(seeded(regions)),chestSeed(statusOf(regions)));
 expect(out).toEqual({error:expect.stringContaining('hem')});
 expect('error' in out&&out.error.startsWith('CHEST_REGION_NOT_KEPT: hem')).toBe(true);
});

test('a row renamed to a kept region\'s name refuses by that name, not a server duplicate',()=>{
 const regions=[circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),third];
 const values=seeded(regions);values[chestRowId(0,'name')]='belly';
 const out=designatedRegions(reader(values),chestSeed(statusOf(regions)));
 expect('error' in out&&out.error.includes('belly')).toBe(true);
});

test('a row over a region the editor cannot show refuses Apply by name while the row stays empty, and Apply runs once the row is filled',()=>{
 const odd={name:'hem',bone:'hips',shape:'rect',x:1,y:2,w:3,h:4,spacing:4,band:10};
 const regions=[odd,circle('bust_l','boob_l',283,318,17)];
 const seed=chestSeed(statusOf(regions));
 expect(seed.refusals).toEqual([expect.stringMatching(/^CHEST_REGION_NOT_KEPT: hem /)]);
 const values=seeded(regions);
 expect(designatedRegions(reader(values),seed)).toEqual({error:seed.refusals[0]!});
 Object.assign(values,{[chestRowId(0,'name')]:'bust_r',[chestRowId(0,'bone')]:'boob_r',[chestRowId(0,'cx')]:'213',[chestRowId(0,'cy')]:'318',[chestRowId(0,'ax')]:'17',[chestRowId(0,'spacing')]:'4',[chestRowId(0,'band')]:'10'});
 const out=designatedRegions(reader(values),seed);
 if(!('regions' in out))throw new Error(out.error);
 expect(out.regions.map(r=>r.name)).toEqual(['bust_r','bust_l']);
});

test('the kept regions are announced with the seed refusals at load, and a two-region config keeps none',()=>{
 expect(chestSeed(statusOf([circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17)])).kept).toEqual([]);
 const seed=chestSeed(statusOf([circle('bust_r','boob_r',213,318,17),circle('bust_l','boob_l',283,318,17),{...third,note:'x'}]));
 expect(seed.kept).toHaveLength(1);
 expect(seed.refusals).toEqual([expect.stringMatching(/^CHEST_REGION_NOT_KEPT: belly \(polygon with keys /)]);
});
