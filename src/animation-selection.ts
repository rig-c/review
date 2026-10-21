/** Actual catalog membership selects a clip; report timing never invents one. */
import type {FeedbackCatalog} from './feedback-validation.ts';
import type {ReportSeeds} from './report.ts';
export interface AnimationSelection {name:string;source:'cli'|'report'|'unique';reportPaths?:string[]}
/** The message stays the shared check/feedback text; `kind` lets the open launcher name the refusal. */
export class AnimationSelectionError extends Error {
 constructor(message:string,readonly kind:'empty'|'unknown'|'ambiguous'|'unvalidatable',readonly label:string|null=null,readonly animation?:string){super(message);}
}
interface Source {label:string;catalog:Pick<FeedbackCatalog,'animations'>;report:Pick<ReportSeeds,'animation'|'path'>|null}
export function selectAnimation(sources:Source[],explicit?:string,allowStatic=false):AnimationSelection|null {
 if(!sources.length||sources.length>2)throw new Error('open.animation: expected one or two actual catalogs');
 if(explicit!==undefined&&(!explicit.trim()))throw new AnimationSelectionError('open.animation: expected nonempty animation name','empty');
 const requireName=(name:string)=>{for(const source of sources){if(source.catalog.animations===null)throw new AnimationSelectionError(`open.${source.label}.animation: validation unavailable without compiled model`,'unvalidatable',source.label);if(!source.catalog.animations.some(clip=>clip.name===name))throw new AnimationSelectionError(`open.${source.label}.animation: model has no animation ${JSON.stringify(name)}`,'unknown',source.label,name);}};
 if(explicit!==undefined){requireName(explicit);return {name:explicit,source:'cli'};}
 if(allowStatic&&sources.length===1&&sources[0]!.catalog.animations===null)return null;
 const reports=sources.filter(source=>source.report?.animation!==undefined);
 const names=[...new Set(reports.map(source=>source.report!.animation!))];
 if(names.length>1)throw new AnimationSelectionError(`open.animation: conflicting report animations: ${reports.map(source=>`${source.label}=${JSON.stringify(source.report!.animation)}`).join(', ')}; select --animation explicitly`,'ambiguous');
 if(names.length===1){requireName(names[0]!);return {name:names[0]!,source:'report',reportPaths:[...new Set(reports.map(source=>source.report!.path))]};}
 if(sources.some(source=>source.catalog.animations===null))throw new AnimationSelectionError('open.animation: validation unavailable without compiled models','unvalidatable');
 const common=sources[0]!.catalog.animations!.filter(clip=>sources.every(source=>source.catalog.animations!.some(other=>other.name===clip.name))).map(clip=>clip.name);
 if(allowStatic&&sources.length===1&&sources[0]!.catalog.animations!.length===0)return null;
 if(common.length!==1)throw new AnimationSelectionError(`open.animation: expected --animation; ${sources.length>1?'common animations':'model animations'}: ${common.join(', ')||'(none)'}`,'ambiguous');
 return {name:common[0]!,source:'unique'};
}
export function animationDiagnostic(selection:AnimationSelection):string {
 return `animation: ${selection.name} (${selection.source==='cli'?'from --animation':selection.source==='report'?'from '+selection.reportPaths!.join(', '):'unique actual clip'})`;
}
/** Runtime init validates again against loaded public assets; never fall back on stale hints. */
export function initialPlayerAnimation(names:readonly string[],selected:string|undefined,checkpoint?:{animation?:string}):string|null {
 const name=checkpoint?.animation??selected;if(name!==undefined){if(!names.includes(name))throw new Error(`initial.animation: model has no animation ${JSON.stringify(name)}`);return name;}
 return names[0]??null;
}
/** The animation a model swap keeps (#186): the staged one when the new model has it, else none — never a removed clip's name. */
export function keptAnimation(staged:string,names:readonly string[]):string {return staged&&names.includes(staged)?staged:'';}
