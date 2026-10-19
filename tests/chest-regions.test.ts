import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {buildChestRegions,chestRegionsBinding,cropWorldMapping,ellipsePolygon,ChestRegionError,serializeChestRegions,type ChestRegionsInput} from '../src/chest-regions.ts';
import {chestInputIds,chestOverlayPolygons,chestRowId,evaluateChestForm,type ChestFieldValue} from '../web/chest-regions-tool.ts';

/** Public generator example files (parts-examples `family/*\/chest-regions.json`), copied unchanged under neutral names. */
const fixture=(name:string)=>readFile(new URL(`./fixtures/chest-regions.${name}.json`,import.meta.url),'utf8');

/** Rebuilds a fixture from its own designation values: centre, semi-axes, band and clip as the public repair record states them. */
async function rebuild(name:string,regions:[number,number,number,number,number,number?][]):Promise<{input:ChestRegionsInput;text:string}> {
 const text=await fixture(name),json=JSON.parse(text),mesh=json['meshes.topwear'],c=mesh.contour;
 const input:ChestRegionsInput={crop:{w:800,h:2284},generator:json.publicGenerator,contour:{tolerance:c.tolerance,margin:c.margin,spacing:c.spacing,maxEdge:c.maxEdge,stray:c.stray,bridges:c.bridges},
  regions:regions.map(([cx,cy,ax,ay,band,clip],i)=>({name:c.regions[i].name,bone:c.regions[i].bone,center:[cx,cy],semiAxes:[ax,ay],spacing:c.regions[i].spacing,band,...(clip===undefined?{}:{clip})})),
  r:mesh.r,segments:mesh.segments,sourceRule:json.sourceRule};
 return {input,text};
}
const sample=()=>rebuild('sample',[[296,640,38,49,28],[438,638,40,52,28]]);
const refusal=(input:ChestRegionsInput)=>{try{buildChestRegions(input);}catch(error){if(error instanceof ChestRegionError)return error.message;throw error;}return null;};

test('the exporter reproduces the public example byte for byte from its designation values',async()=>{
 const {input,text}=await sample();
 expect(serializeChestRegions(buildChestRegions(input))).toBe(text);
});

test('a medial clip x and a fractional core reproduce the clipped example byte for byte',async()=>{
 const {input,text}=await rebuild('sample-clip',[[308,785,26.3984375,26.3984375,43.19921875,326.80078125],[436,785,26.3984375,26.3984375,43.19921875,417.19921875]]);
 expect(serializeChestRegions(buildChestRegions(input))).toBe(text);
});

test('a narrow gap at the band sum still exports and reproduces byte for byte',async()=>{
 const {input,text}=await rebuild('sample-narrow',[[295,756,32,46,20],[394,776,24,42,20]]);
 expect(serializeChestRegions(buildChestRegions(input))).toBe(text);
});

test('polygon sampling: 32 samples from +x turning toward +y (down), each on the 1/256 grid',()=>{
 const points=ellipsePolygon([296,640],[38,49]);
 expect(points.length).toBe(32);
 expect(points[0]).toEqual([334,640]);
 expect(points[1]).toEqual([333.26953125,649.55859375]);
 expect(points[8]).toEqual([296,689]);
 expect(points[16]).toEqual([258,640]);
 expect(points[24]).toEqual([296,591]);
 for(const [x,y] of points){expect(Number.isInteger(x*256)).toBe(true);expect(Number.isInteger(y*256)).toBe(true);}
});

test('one quantization step off a point no longer matches the example',async()=>{
 const {input,text}=await sample(),doc=buildChestRegions(input);
 const first=doc.mesh.value.contour.regions[0]!;if(first.shape!=='polygon')throw new Error('expected a polygon');first.points[1]![0]+=1/256;
 expect(serializeChestRegions(doc)).not.toBe(text);
});

test('named refusals: duplicate name, unknown bone, out of crop, overlap',async()=>{
 const {input}=await sample();
 expect(refusal({...input,regions:[input.regions[0]!,{...input.regions[1]!,name:input.regions[0]!.name}]})).toBe('CHEST_REGION_NAME_DUPLICATE bust_r');
 expect(refusal({...input,bones:['root','chest','boob_r']})).toBe('CHEST_REGION_BONE_UNKNOWN boob_l');
 expect(refusal({...input,bones:['root','chest','boob_r','boob_l']})).toBeNull();
 expect(refusal({...input,crop:{w:800,h:688}})).toBe('CHEST_REGION_OUT_OF_CROP bust_r');
 expect(refusal({...input,regions:[{...input.regions[0]!,center:[37,640]},input.regions[1]!]})).toBe('CHEST_REGION_OUT_OF_CROP bust_r');
 // Gap between the cores is 64 px; bands 28 + 28 = 56 fit, 28 + 37 do not.
 expect(refusal({...input,regions:[input.regions[0]!,{...input.regions[1]!,band:36}]})).toBeNull();
 expect(refusal({...input,regions:[input.regions[0]!,{...input.regions[1]!,band:37}]})).toBe('CHEST_REGIONS_OVERLAP bust_r bust_l');
 expect(refusal({...input,regions:[input.regions[0]!,{...input.regions[1]!,center:[330,640]}]})).toBe('CHEST_REGIONS_OVERLAP bust_r bust_l');
 expect(refusal({...input,regions:[{...input.regions[0]!,band:28.001}],})).toBe('CHEST_REGIONS_COUNT 1');
 expect(refusal({...input,regions:[{...input.regions[0]!,band:28.001},input.regions[1]!]})).toBe('CHEST_REGION_OFF_GRID bust_r band');
});

test('crop → world mapping only from a model stage that is the crop frame with the root at its origin',()=>{
 const mapped=cropWorldMapping({x:-416,y:0,width:832,height:1216},{x:0,y:0});
 expect(mapped.available).toBe(true);
 if(mapped.available){expect(mapped.crop).toEqual({w:832,h:1216});expect(mapped.toWorld(296,640)).toEqual({x:-120,y:576});expect(mapped.toWorld(416,1216)).toEqual({x:0,y:0});}
 expect(cropWorldMapping(null,{x:0,y:0})).toEqual({available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: the model declares no stage'});
 const box=cropWorldMapping({x:0,y:0,width:80,height:64},{x:0,y:0});expect(box.available).toBe(false);if(!box.available)expect(box.reason).toContain('not a crop frame');
 const moved=cropWorldMapping({x:-416,y:0,width:832,height:1216},{x:3,y:0});expect(moved.available).toBe(false);
});

test('form wiring: fields → document, overlay polygons in world units, and every tool field is a draft input',async()=>{
 const {text}=await sample(),json=JSON.parse(text),c=json['meshes.topwear'].contour;
 const values:Record<string,ChestFieldValue>={'chest-generator':{value:json.publicGenerator},'chest-source-rule':{value:json.sourceRule},'chest-r':{value:'15'},'chest-segments':{value:JSON.stringify(json['meshes.topwear'].segments)},'chest-bridges':{value:'on',checked:true},
  'chest-tolerance':{value:'2'},'chest-margin':{value:'2'},'chest-spacing':{value:'36'},'chest-max-edge':{value:'64'},'chest-stray':{value:'400'}};
 for(const [row,[cx,cy,ax,ay]] of [[0,[296,640,38,49]],[1,[438,638,40,52]]] as const){
  Object.assign(values,{[chestRowId(row,'name')]:{value:c.regions[row].name},[chestRowId(row,'bone')]:{value:c.regions[row].bone},[chestRowId(row,'cx')]:{value:String(cx)},[chestRowId(row,'cy')]:{value:String(cy)},[chestRowId(row,'ax')]:{value:String(ax)},[chestRowId(row,'ay')]:{value:String(ay)},[chestRowId(row,'spacing')]:{value:'14'},[chestRowId(row,'band')]:{value:'28'},[chestRowId(row,'clip')]:{value:''}});
 }
 for(const id of Object.keys(values))expect(chestInputIds).toContain(id);
 const read=(id:string)=>values[id],absent=cropWorldMapping(null,null);
 expect(evaluateChestForm(read,absent,null)).toEqual({ok:false,error:'CHEST_REGION_VALUE_INVALID crop w'});
 values['chest-crop-w']={value:'800'};values['chest-crop-h']={value:'2284'};
 const result=evaluateChestForm(read,absent,null);expect(result.ok&&result.text).toBe(text);
 expect(chestOverlayPolygons(result,absent)).toEqual([]);
 const mapped=cropWorldMapping({x:-416,y:0,width:832,height:1216},{x:0,y:0}),onModel=evaluateChestForm(read,mapped,['root','boob_r','boob_l']);
 const polygons=chestOverlayPolygons(onModel,mapped);expect(polygons.map(p=>p.points.length)).toEqual([32,32]);expect(polygons[0]!.points[0]).toEqual({x:334-416,y:1216-640});
 expect(evaluateChestForm(read,mapped,['root','chest'])).toEqual({ok:false,error:'CHEST_REGION_BONE_UNKNOWN boob_r'});
});

test('the binding names package, model and motion hashes and states evidence, not approval',()=>{
 const binding=chestRegionsBinding({fileSha256:'a'.repeat(64),sourceHash:'b'.repeat(64),reviewedSource:{viewerVersion:'0.4.0',runtimeVersion:'1.12.0',rig:{sha256:'c'.repeat(64)},motion:null},exportedAt:'2026-10-20T00:00:00.000Z',mapping:'m'});
 expect(binding).toMatchObject({package:'b'.repeat(64),model:'c'.repeat(64),motion:null,file:{name:'chest-regions.json',sha256:'a'.repeat(64)},tools:{viewerVersion:'0.4.0',runtimeVersion:'1.12.0'}});
 expect(binding.evidence).toContain('not an approval');
});

test('the rig overlay fills designation polygons only over a drawn rig',async()=>{
 const {createCanvas}=await import('@napi-rs/canvas'),{RigOverlays}=await import('../web/rig-overlays.ts');
 const surface=createCanvas(200,200);Object.assign(surface,{style:{pointerEvents:'auto'},clientWidth:200,clientHeight:200});
 const overlays=new RigOverlays({canvas:surface as unknown as HTMLCanvasElement,rigRoot:{style:{visibility:'visible'}} as unknown as HTMLElement});
 const settings={images:true,mesh:false,bones:false,meshOpacity:.65},project=(x:number,y:number)=>({x:100+x,y:100-y});
 const regions=[{name:'a',points:[{x:-20,y:-20},{x:20,y:-20},{x:20,y:20},{x:-20,y:20}],stroke:'#ff0000',fill:'#00ff00'}];
 const ink=()=>{const d=surface.getContext('2d').getImageData(0,0,200,200).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]!>0)n++;return n;};
 overlays.refresh({player:null,bones:[],project,settings,dpr:1,regions});expect(ink()).toBe(0);
 const player={posedFrame:()=>{throw new Error('unused');},bone:()=>{throw new Error('unused');}} as never;
 overlays.refresh({player,bones:[],project,settings,dpr:1,regions});expect(ink()).toBeGreaterThan(1500);
 const centre=surface.getContext('2d').getImageData(100,100,1,1).data;expect([centre[0],centre[1],centre[2]]).toEqual([0,255,0]);
 overlays.redraw({project,settings,dpr:1});expect(ink()).toBe(0);
});

/** The example rebuild script's `clamp_non_overlapping` on the example's own numbers; expected values are the script's output. */
const clampCases:[string,[number,number,number,number],[number,number,number,number],[number,number,number,number],[number,number,number,number],boolean][]=[
 ['viewer default 1',[296,650,26,42],[438,650,28,44],[296,650,26,42],[438,650,28,44],false],
 ['viewer default 2',[308,785,22,36],[436,785,22,36],[308,785,22,36],[436,785,22,36],false],
 ['viewer default 3',[384,724,24,38],[514,720,25,39],[384,724,24,38],[514,720,25,39],false],
 ['viewer default 4',[312,785,24,38],[448,785,24,38],[312,785,24,38],[448,785,24,38],false],
 ['viewer default 5',[312,775,23,36],[435,785,23,36],[312,775,23,36],[435,785,23,36],false],
 ['config 1',[382,732,16,73],[554,722,13,66],[382,732,16,73],[554,722,13,66],false],
 ['config 2',[333,811,22,59],[489,809,21,51],[333,811,22,59],[489,809,21,51],false],
 ['config 3',[319,769,19,60],[477,768,22,52],[319,769,19,60],[477,768,22,52],false],
 ['L dragged onto R',[296,650,26,42],[330,650,28,44],[296,650,11,4],[330,650,12,5],true],
 ['band sum over the gap',[384,724,24,38],[514,720,25,60],[384,724,24,30],[514,720,25,49],true],
 ['Python half-even rounding',[300.5,650.5,24.5,38.5],[441.5,650.5,25.5,39.5],[300,650,24,38],[442,650,26,40],false],
 ['r and band ranges',[296,650,3,200],[600,650,130,1],[296,650,6,120],[600,650,120,4],false],
 ['coincident centres',[400,700,40,40],[400,700,40,40],[400,700,10,4],[400,700,10,4],true],
 ['cores + 8 exactly at the gap',[300,700,40,4],[390,700,40,4],[300,700,40,4],[390,700,40,4],false],
 ['cores + 8 one past the gap',[300,700,41,4],[390,700,40,4],[300,700,40,4],[390,700,39,4],true],
];
test('clampNonOverlapping reproduces clamp_non_overlapping on the example numbers',async()=>{
 const {clampNonOverlapping}=await import('../src/chest-regions.ts');
 const circle=([cx,cy,r,band]:[number,number,number,number])=>({cx,cy,r,band});
 for(const [name,right,left,outRight,outLeft,clamped] of clampCases){
  expect({name,...clampNonOverlapping(circle(right),circle(left))}).toEqual({name,right:circle(outRight),left:circle(outLeft),clamped});
 }
});
test('pythonRound rounds halves to even like the script',async()=>{
 const {pythonRound}=await import('../src/chest-regions.ts');
 expect([0.5,1.5,2.5,24.5,25.5,-0.5,-1.5,2.4,2.6].map(pythonRound)).toEqual([0,2,2,24,26,0,-2,2,3]);
});

test('equal semi-axes export as the example config circles, byte for byte; unequal ones stay polygons',async()=>{
 const contourText=(await fixture('circle-contour')).trimEnd(),contour=JSON.parse(contourText),{input}=await sample();
 const regions=contour.regions.map((r:{name:string;bone:string;cx:number;cy:number;r:number;spacing:number;band:number})=>({name:r.name,bone:r.bone,center:[r.cx,r.cy] as [number,number],semiAxes:[r.r,r.r] as [number,number],spacing:r.spacing,band:r.band}));
 const doc=buildChestRegions({...input,contour:{tolerance:contour.tolerance,margin:contour.margin,spacing:contour.spacing,maxEdge:contour.maxEdge,stray:contour.stray,bridges:contour.bridges},regions});
 const lines=serializeChestRegions(doc).split('\n'),start=lines.indexOf('    "contour": {'),end=lines.indexOf('    },',start);
 const block=['{',...lines.slice(start+1,end).map(line=>line.slice(4)),'}'].join('\n');
 expect(block).toBe(contourText);
 expect(doc.mesh.value.contour.regions.map(r=>Object.keys(r))).toEqual([['name','shape','cx','cy','r','bone','spacing','band'],['name','shape','cx','cy','r','bone','spacing','band']]);
 // A medial clip or unequal axes keep #78's polygon.
 expect(buildChestRegions({...input,regions:[{...regions[0],clip:390},regions[1]]}).mesh.value.contour.regions.map(r=>r.shape)).toEqual(['polygon','circle']);
 expect(buildChestRegions({...input,regions:[{...regions[0],semiAxes:[16,17]},regions[1]]}).mesh.value.contour.regions.map(r=>r.shape)).toEqual(['polygon','circle']);
 // Circles: out of crop from the core, overlap from centre distance minus cores against the band sum (172.29 − 29 = 143.29: bands 73 + 70 fit, 73 + 71 do not).
 expect(refusal({...input,regions:[{...regions[0],center:[10,732]},regions[1]]})).toBe('CHEST_REGION_OUT_OF_CROP bust_r');
 expect(refusal({...input,regions:[regions[0],{...regions[1],band:70}]})).toBeNull();
 expect(refusal({...input,regions:[regions[0],{...regions[1],band:71}]})).toBe('CHEST_REGIONS_OVERLAP bust_r bust_l');
});
