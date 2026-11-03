import {expect,test} from 'bun:test';
import {CHEST_ELLIPSE_MIN_POINTS,CHEST_ELLIPSE_TOLERANCE,ellipsePolygon,fitChestEllipse} from '../src/chest-regions.ts';
import {chestSeed,designatedRegions,seedFields,type RegionEntry} from '../web/rebuild-client.ts';
import {chestRegionFields,chestRowId,type ChestFieldValue} from '../web/chest-regions-tool.ts';
import {circleFields,dragBust,hitBustHandle,rowShape} from '../web/chest-editor.ts';
import {projectCircle} from '../web/rig-overlays.ts';

// #315: the chest editor reads back the axis-aligned ellipse polygons review (and create) write, refuses any other
// polygon by name, and an untouched row round-trips verbatim.
const polygon=(name:string,bone:string,points:[number,number][]):RegionEntry=>({name,bone,shape:'polygon',points,spacing:4,band:10});
const statusOf=(regions:unknown[],extra:{name:string;regions:unknown[]}[]=[])=>({parts:[...extra,{name:'topwear',regions}],contour:{topwear:{contour:{tolerance:0.5,margin:1,spacing:14,stray:4,regions}},...Object.fromEntries(extra.map(p=>[p.name,{contour:{regions:p.regions}}]))}});
const fieldsReader=(values:Record<string,string>)=>(id:string):ChestFieldValue|undefined=>id in values?{value:values[id]!}:undefined;
const empty=()=>undefined;

test('the tolerance and the fit minimum are stated numbers',()=>{
 expect(CHEST_ELLIPSE_TOLERANCE).toBe(0.5);
 expect(CHEST_ELLIPSE_MIN_POINTS).toBe(6);
});

test('Bar 1: a 16-point ellipse polygon (rx 17, ry 14, centre off-integer) seeds cx, cy, ax, ay within the tolerance',()=>{
 const centre:[number,number]=[213.37,318.61],points=ellipsePolygon(centre,[17,14],16);
 expect(points).toHaveLength(16);
 const seed=seedFields(statusOf([polygon('bust_r','boob_r',points)]),empty)!;
 expect(seed).not.toBeNull();
 for(const [field,want] of [['cx',213.37],['cy',318.61],['ax',17],['ay',14]] as const)expect(Math.abs(Number(seed[chestRowId(0,field)])-want)).toBeLessThanOrEqual(CHEST_ELLIPSE_TOLERANCE);
 expect(seed[chestRowId(0,'name')]).toBe('bust_r');expect(seed[chestRowId(0,'bone')]).toBe('boob_r');
 expect(seed[chestRowId(0,'spacing')]).toBe('4');expect(seed[chestRowId(0,'band')]).toBe('10');
 expect(seed[chestRowId(0,'clip')]).toBeUndefined();
 const fit=fitChestEllipse(points);expect(fit.ok).toBe(true);
 if(fit.ok)expect(fit.maxOff).toBeLessThanOrEqual(CHEST_ELLIPSE_TOLERANCE);
});

test('Bar 2: a 32-point polygon written by designatedRegions seeds back to the values that wrote it, clipped or not',()=>{
 for(const clip of [undefined,225]){
  const values:Record<string,string>={...circleFields(0,{cx:213.5,cy:318.25,band:10}),[chestRowId(0,'ax')]:'17',[chestRowId(0,'ay')]:'14',[chestRowId(0,'name')]:'bust_r',[chestRowId(0,'bone')]:'boob_r',[chestRowId(0,'spacing')]:'4',...(clip===undefined?{}:{[chestRowId(0,'clip')]:String(clip)})};
  const written=designatedRegions(fieldsReader(values));
  if(!('regions' in written))throw new Error(written.error);
  const region=written.regions[0]!;expect(region.shape).toBe('polygon');if(region.shape!=='polygon')return;expect(region.points).toHaveLength(32);
  const seed=seedFields(statusOf([region]),empty)!;
  for(const field of ['cx','cy','ax','ay','clip'] as const)expect(seed[chestRowId(0,field)]).toBe(values[chestRowId(0,field)]);
 }
});

test('Bar 3: a polygon that is not such an ellipse is refused by name, and its row stays empty',()=>{
 // A 23-point star: every other vertex pulled in, so no axis-aligned ellipse passes through them all.
 const star=Array.from({length:23},(_,i):[number,number]=>{const a=2*Math.PI*i/23,r=i%2?12:18;return [Math.round((300+r*Math.cos(a))*256)/256,Math.round((320+r*Math.sin(a))*256)/256];});
 const circle=ellipsePolygon([380,320],[16,16],16);
 const status=statusOf([polygon('bust_r','boob_r',star),polygon('bust_l','boob_l',circle)]);
 const seed=chestSeed(status);
 expect(seed.refusals).toHaveLength(1);
 expect(seed.refusals[0]).toMatch(/^CHEST_REGION_NOT_ELLIPSE: bust_r \(polygon, 23 points, max off-ellipse \d+\.\d px\)$/);
 const fields=seedFields(status,empty)!;
 for(const field of chestRegionFields)expect(fields[chestRowId(0,field)]).toBeUndefined();
 expect(fields[chestRowId(1,'cx')]).toBe('380');
 // Too few points for a fit is refused by name too, never read as an ellipse.
 const quad=chestSeed(statusOf([polygon('bust_r','boob_r',[[0,0],[10,0],[10,10],[0,10]])]));
 expect(quad.refusals).toEqual(['CHEST_REGION_NOT_ELLIPSE: bust_r (polygon, 4 points, below the 6 a fit needs)']);
 // The refused row's region is kept as written on Apply; Apply never drops it nor rewrites it from an empty row.
 const read=fieldsReader(fields),designated=designatedRegions(read,seed);
 if(!('regions' in designated))throw new Error(designated.error);
 expect(designated.regions[0]).toEqual(polygon('bust_r','boob_r',star));
});

test('Bar 4: an untouched row round-trips verbatim; an edited one becomes the 32-sample ellipse',()=>{
 const r=ellipsePolygon([213,318],[17,14],16),l=ellipsePolygon([294,322],[20,15],16);
 const status=statusOf([polygon('bust_r','boob_r',r),polygon('bust_l','boob_l',l)]),seed=chestSeed(status);
 const values=seedFields(status,empty)!;
 const untouched=designatedRegions(fieldsReader(values),seed);
 expect(untouched).toEqual({regions:[polygon('bust_r','boob_r',r),polygon('bust_l','boob_l',l)]});
 // Without the seed (today's call) the same rows rewrite both as 32-point polygons.
 const rewritten=designatedRegions(fieldsReader(values)) as {regions:{points:unknown[]}[]};
 expect(rewritten.regions.map(x=>x.points.length)).toEqual([32,32]);
 const edited=designatedRegions(fieldsReader({...values,[chestRowId(0,'ax')]:'18'}),seed) as {regions:RegionEntry[]};
 expect(edited.regions[0]!.shape==='polygon'&&edited.regions[0]!.points.length).toBe(32);
 expect(edited.regions[1]).toEqual(polygon('bust_l','boob_l',l));
});

test('the chest part is the one whose regions the editor can read, not the first part with any region',()=>{
 const hair=[{name:'hair_on_head',shape:'polygon',points:[[100,10],[200,10],[200,80],[100,80]],spacing:14,band:12,bone:'head'}];
 const status=statusOf([polygon('bust_r','boob_r',ellipsePolygon([213,318],[17,14],16))],[{name:'hair_back',regions:hair}]);
 const seed=chestSeed(status);
 expect(seed.part).toBe('topwear');expect(seed.refusals).toEqual([]);
 expect(seedFields(status,empty)![chestRowId(0,'name')]).toBe('bust_r');
});

test('Bar 5: the circle handles edit an ellipse row by one rule — r sets ax and scales ay and the clip offset with it',()=>{
 const values:Record<string,string>={[chestRowId(0,'cx')]:'200',[chestRowId(0,'cy')]:'300',[chestRowId(0,'ax')]:'17',[chestRowId(0,'ay')]:'14',[chestRowId(0,'band')]:'10'};
 const shape=rowShape(fieldsReader(values),0)!;expect(shape).toEqual({cx:200,cy:300,r:17,ry:14,band:10});
 const clipped=rowShape(fieldsReader({...values,[chestRowId(0,'clip')]:'210'}),0)!;expect(clipped).toEqual({cx:200,cy:300,r:17,ry:14,band:10,clip:210});
 const drag=(from:typeof shape,mode:'r'|'band'|'move',p:{x:number;y:number})=>dragBust({side:'r',mode,start:{x:200,y:300},centre:{x:200,y:300},from},p,1);
 expect(drag(shape,'r',{x:234,y:300})).toEqual({cx:200,cy:300,r:34,ry:28,band:10});
 expect(drag(clipped,'r',{x:234,y:300})).toEqual({cx:200,cy:300,r:34,ry:28,band:10,clip:220});
 // band is measured from the core's top (ay), where the band handle sits.
 expect(drag(shape,'band',{x:200,y:276})).toEqual({...shape,band:10});
 expect(drag(clipped,'move',{x:205,y:303})).toEqual({cx:205,cy:303,r:17,ry:14,band:10,clip:215});
 expect(circleFields(0,{cx:205,cy:303,r:34,ry:28,band:10,clip:220})).toEqual({[chestRowId(0,'cx')]:'205',[chestRowId(0,'cy')]:'303',[chestRowId(0,'ax')]:'34',[chestRowId(0,'ay')]:'28',[chestRowId(0,'band')]:'10',[chestRowId(0,'clip')]:'220'});
 // A circle row keeps the circle rule: r writes both semi-axes.
 expect(circleFields(1,{r:12})).toEqual({[chestRowId(1,'ax')]:'12',[chestRowId(1,'ay')]:'12'});
 // The ellipse's projected core and its edge hit-test follow ay, not a circle of radius ax.
 const at=projectCircle((x,y)=>({x,y}),{center:{x:200,y:300},r:40,ry:20,band:20})!;
 expect(at).toEqual({center:{x:200,y:300},pxR:40,pxRy:20,pxBand:40});
 expect(hitBustHandle([{side:'r',...at}],{x:200,y:280})).toEqual({side:'r',mode:'r'});
 expect(hitBustHandle([{side:'r',...at}],{x:200,y:262})).toEqual({side:'r',mode:'band'});
});

test('Bar 6 (#316 review): an ellipse grab anywhere on its edge or band ring changes nothing until the pointer moves; +d along the grab ray scales by (r_dir + d) / r_dir',()=>{
 const from={cx:200,cy:300,r:40,ry:20,band:10},centre={x:200,y:300};
 const rDir=(a:number)=>40*20/Math.hypot(20*Math.cos(a),40*Math.sin(a));
 const along=(a:number,dist:number)=>({x:200+dist*Math.cos(a),y:300-dist*Math.sin(a)});
 const drag=(mode:'r'|'band',start:{x:number;y:number},p:{x:number;y:number},shape:typeof from&{clip?:number}=from)=>dragBust({side:'r',mode,start,centre,from:shape},p,1);
 for(const a of [Math.PI/2,0,Math.PI/4]){
  const r=rDir(a),core=along(a,r),ring=along(a,r+10);
  // Grabbed, not yet moved: ax, ay and band stay as they were (top, side and 45°).
  expect(drag('r',core,core)).toEqual(from);
  expect(drag('band',ring,ring)).toEqual(from);
  // +d along the grab ray: the core scales by (r_dir + d) / r_dir (d = r_dir / 4 → ×1.25); band grows by d.
  expect(drag('r',core,along(a,r*1.25))).toEqual({...from,r:50,ry:25});
  expect(drag('band',ring,along(a,r+14))).toEqual({...from,band:14});
 }
 // The clip offset scales with the same factor (Bar 5's rule): top grab, +10 → ×1.5.
 expect(drag('r',along(Math.PI/2,20),along(Math.PI/2,30),{...from,clip:220})).toEqual({...from,r:60,ry:30,clip:230});
});
