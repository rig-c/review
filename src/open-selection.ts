import type {ReviewManifest} from './manifest.ts';
/** An explicit CLI video wins automatic startup, never a human/deep-link choice. */
export function initialReviewSelection(manifest:Pick<ReviewManifest,'checkpoints'|'references'>&Partial<Pick<ReviewManifest,'axes'>>,requestedId:string|null,explicitId?:string,selectedAnimation?:string){
 const automatic=manifest.checkpoints[0];
 // Both the checkpoint and its optional axis must stay on the selected clip.
 const axisAnimation=automatic?.axis?manifest.axes?.find(axis=>axis.id===automatic.axis!.id)?.animation:undefined;
 const compatible=!selectedAnimation||(automatic?.animation===selectedAnimation&&(!automatic.axis||axisAnimation===selectedAnimation));
 const checkpoint=requestedId?manifest.checkpoints.find(point=>point.id===requestedId):compatible?automatic:undefined;
 const referenceId=requestedId&&checkpoint?.reference?checkpoint.reference:explicitId??checkpoint?.reference??manifest.references[0]?.id;
 return {checkpoint,referenceId,updateUrl:!!requestedId||(!explicitId&&!selectedAnimation)};
}
