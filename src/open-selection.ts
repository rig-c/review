import type {ReviewManifest} from './manifest.ts';
/** An explicit CLI video wins automatic startup, never a human/deep-link choice. */
export function initialReviewSelection(manifest:Pick<ReviewManifest,'checkpoints'|'references'>,requestedId:string|null,explicitId?:string,selectedAnimation?:string){
 const automatic=manifest.checkpoints[0];
 // A generic/default checkpoint cannot impose another clip's time or axis.
 const checkpoint=requestedId?manifest.checkpoints.find(point=>point.id===requestedId):selectedAnimation&&(automatic?.animation!==selectedAnimation||automatic.axis)?undefined:automatic;
 const referenceId=requestedId&&checkpoint?.reference?checkpoint.reference:explicitId??checkpoint?.reference??manifest.references[0]?.id;
 return {checkpoint,referenceId,updateUrl:!!requestedId||(!explicitId&&!selectedAnimation)};
}
