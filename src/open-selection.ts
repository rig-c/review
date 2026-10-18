import type {ReviewManifest} from './manifest.ts';
/** An explicit CLI video wins automatic startup, never a human/deep-link choice. */
export function initialReviewSelection(manifest:Pick<ReviewManifest,'checkpoints'|'references'>,requestedId:string|null,explicitId?:string){
 const checkpoint=requestedId?manifest.checkpoints.find(point=>point.id===requestedId):manifest.checkpoints[0];
 const referenceId=requestedId&&checkpoint?.reference?checkpoint.reference:explicitId??checkpoint?.reference??manifest.references[0]?.id;
 return {checkpoint,referenceId,updateUrl:!!requestedId||!explicitId};
}
