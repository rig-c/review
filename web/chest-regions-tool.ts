/** Setup's Chest regions tool: form fields → designation input, without DOM access (main.ts owns the elements). */
import {buildChestRegions,ChestRegionError,serializeChestRegions,type ChestRegionsDocument,type ChestRegionsInput,type CropWorldMapping} from '../src/chest-regions.ts';

export const chestRegionRows=[0,1] as const;
export const chestRegionFields=['name','bone','cx','cy','ax','ay','spacing','band','clip'] as const;
export const chestContourFields=[['tolerance','chest-tolerance'],['margin','chest-margin'],['spacing','chest-spacing'],['maxEdge','chest-max-edge'],['stray','chest-stray']] as const;
export const chestRowId=(row:number,field:typeof chestRegionFields[number])=>`chest-${row}-${field}`;
/** Every input id the tool owns; the inspection draft captures them like any other form input. */
export const chestInputIds=[
 'chest-crop-w','chest-crop-h','chest-generator','chest-source-rule','chest-r','chest-segments','chest-bridges',
 ...chestContourFields.map(([,id])=>id),
 ...chestRegionRows.flatMap(row=>chestRegionFields.map(field=>chestRowId(row,field))),
];

export interface ChestFieldValue {value:string;checked?:boolean}
export type ChestFieldReader=(id:string)=>ChestFieldValue|undefined;

const invalid=(what:string)=>new ChestRegionError('CHEST_REGION_VALUE_INVALID',what);
function numberField(read:ChestFieldReader,id:string,what:string,optional=false):number|undefined {
 const raw=(read(id)?.value??'').trim();
 if(!raw){if(optional)return undefined;throw invalid(what);}
 const value=Number(raw);if(!Number.isFinite(value))throw invalid(what);return value;
}

/** Reads the tool's fields; crop comes from the model mapping when it exists, else from the crop fields. */
export function readChestForm(read:ChestFieldReader,mapping:CropWorldMapping,bones:readonly string[]|null):ChestRegionsInput {
 const crop=mapping.available?mapping.crop:{w:numberField(read,'chest-crop-w','crop w')!,h:numberField(read,'chest-crop-h','crop h')!};
 const contour={tolerance:0,margin:0,spacing:0,maxEdge:0,stray:0,bridges:read('chest-bridges')?.checked===true};
 for(const [key,id] of chestContourFields)contour[key]=numberField(read,id,`contour ${key}`)!;
 const regions=chestRegionRows.map(row=>{
  const name=(read(chestRowId(row,'name'))?.value??'').trim()||`row ${row+1}`,num=(field:typeof chestRegionFields[number],optional=false)=>numberField(read,chestRowId(row,field),`${name} ${field}`,optional);
  const clip=num('clip',true);
  return {name:(read(chestRowId(row,'name'))?.value??'').trim(),bone:read(chestRowId(row,'bone'))?.value??'',center:[num('cx')!,num('cy')!] as [number,number],semiAxes:[num('ax')!,num('ay')!] as [number,number],spacing:num('spacing')!,band:num('band')!,...(clip===undefined?{}:{clip})};
 });
 const segmentsText=(read('chest-segments')?.value??'').trim();let segments:unknown;
 if(segmentsText){try{segments=JSON.parse(segmentsText);}catch{throw new ChestRegionError('CHEST_SEGMENTS_INVALID','not JSON');}}
 const r=numberField(read,'chest-r','mesh r',true),sourceRule=(read('chest-source-rule')?.value??'').trim();
 return {crop,generator:(read('chest-generator')?.value??'').trim(),contour,regions,...(r===undefined?{}:{r}),...(segments===undefined?{}:{segments}),...(sourceRule?{sourceRule}:{}),bones};
}

export type ChestEvaluation={ok:true;document:ChestRegionsDocument;text:string}|{ok:false;error:string};
export function evaluateChestForm(read:ChestFieldReader,mapping:CropWorldMapping,bones:readonly string[]|null):ChestEvaluation {
 try{const document=buildChestRegions(readChestForm(read,mapping,bones));return {ok:true,document,text:serializeChestRegions(document)};}
 catch(error){if(error instanceof ChestRegionError)return {ok:false,error:error.message};throw error;}
}

/** Polygon regions in rig world coordinates for the overlay; none without a model-fixed mapping. Circles are drawn as circles. */
export function chestOverlayPolygons(evaluation:ChestEvaluation,mapping:CropWorldMapping):{name:string;row:number;points:{x:number;y:number}[]}[] {
 if(!evaluation.ok||!mapping.available)return [];
 return evaluation.document.mesh.value.contour.regions.flatMap((region,row)=>region.shape==='polygon'?[{name:region.name,row,points:region.points.map(([x,y])=>mapping.toWorld(x,y))}]:[]);
}
/** Circle regions of a valid designation: world centre, core r and band (crop px = world px under the mapping). */
export function chestOverlayCircles(evaluation:ChestEvaluation,mapping:CropWorldMapping):{name:string;row:number;center:{x:number;y:number};r:number;band:number}[] {
 if(!evaluation.ok||!mapping.available)return [];
 return evaluation.document.mesh.value.contour.regions.flatMap((region,row)=>region.shape==='circle'?[{name:region.name,row,center:mapping.toWorld(region.cx,region.cy),r:region.r,band:region.band}]:[]);
}
