/** Consumer presentation bookkeeping. Preparing a pose never claims it was drawn. */
import {drawSynchronizedPair,prepareSynchronizedPair,type CompareTrace,type ReferenceSample,type InspectionPlayer,type CompareDomain} from './compare-playhead.ts';
export interface PresentationState {
 status:'unknown'|'drawn'|'held'|'failed';target:ReferenceSample|null;prepared:CompareTrace|null;lastDrawn:CompareTrace|null;inspection:CompareTrace|null;
 callbacks:number;dropped:number;deadlineMisses:number;presentationGaps:number;lastPoseMs:number;lastDrawMs:number;lastLatenessMs:number;drawBudgetEstimateMs:number;nextReferenceEstimateMs:number|null;currentDisplayLatenessMs:number|null;deadlineKnownCallbacks:number;deadlineUnknownCallbacks:number;deadlineKind:'paused'|'next-reference-estimate'|'unknown';
}
export class ComparePresentation {
 private value:PresentationState={status:'unknown',target:null,prepared:null,lastDrawn:null,inspection:null,callbacks:0,dropped:0,deadlineMisses:0,presentationGaps:0,lastPoseMs:0,lastDrawMs:0,lastLatenessMs:0,drawBudgetEstimateMs:0,nextReferenceEstimateMs:null,currentDisplayLatenessMs:null,deadlineKnownCallbacks:0,deadlineUnknownCallbacks:0,deadlineKind:'unknown'};
 private recentDraw:number[]=[];private previousPresented:number|null=null;
 snapshot():PresentationState{return {...this.value,target:this.value.target?{...this.value.target}:null,prepared:this.value.prepared?{...this.value.prepared}:null,lastDrawn:this.value.lastDrawn?{...this.value.lastDrawn}:null,inspection:this.value.inspection?{...this.value.inspection}:null};}
 private finish(now:number,deadline:number|null):void {this.value.lastLatenessMs=deadline===null?0:Math.max(0,now-deadline);if(this.value.lastLatenessMs>0)this.value.deadlineMisses++;}
 private draw(a:InspectionPlayer,b:InspectionPlayer,trace:CompareTrace,now:()=>number):void {
  const start=now();try{drawSynchronizedPair(a,b);}catch(error){this.value.status='failed';this.value.lastDrawn=null;this.value.inspection=null;throw error;}
  this.value.lastDrawMs=now()-start;this.recentDraw.push(this.value.lastDrawMs);if(this.recentDraw.length>20)this.recentDraw.shift();
  const sorted=[...this.recentDraw].sort((x,y)=>x-y);this.value.drawBudgetEstimateMs=sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]!;
  this.value.lastDrawn={...trace};
 }
 /** Paused inspection has no presentation deadline and keeps deterministic replay. */
 inspect(sample:ReferenceSample,a:InspectionPlayer,b:InspectionPlayer,domain:CompareDomain,now:()=>number):PresentationState {
  this.previousPresented=null;this.value.deadlineKind='paused';this.value.nextReferenceEstimateMs=null;this.value.currentDisplayLatenessMs=null;this.value.target={...sample};this.value.inspection=null;const start=now();
  try{const trace=prepareSynchronizedPair(sample,a,b,domain);this.value.prepared=trace;this.value.lastPoseMs=now()-start;this.draw(a,b,trace,now);this.value.inspection={...trace};this.value.status='drawn';this.value.lastLatenessMs=0;return this.snapshot();}
  catch(error){this.value.status='failed';this.value.inspection=null;throw error;}
 }
 /** Always submit the latest observed pair immediately. Synchronous seek/draw
  * cannot receive a newer JavaScript callback midway. Lateness is classified
  * afterward; the estimated next reference boundary never suppresses drawing. */
 present(sample:ReferenceSample,expectedDisplayTime:number|null,presentedFrames:number|null,a:InspectionPlayer,b:InspectionPlayer,domain:CompareDomain,now:()=>number,nextIntervalSeconds:number|null=null):PresentationState {
  this.value.callbacks++;this.value.target={...sample};this.value.inspection=null;this.value.prepared=null;this.value.lastPoseMs=0;this.value.lastDrawMs=0;
  const estimate=expectedDisplayTime!==null&&Number.isFinite(expectedDisplayTime)&&nextIntervalSeconds!==null&&Number.isFinite(nextIntervalSeconds)&&nextIntervalSeconds>0?expectedDisplayTime+nextIntervalSeconds*1000:null;
  this.value.nextReferenceEstimateMs=estimate!==null&&Number.isFinite(estimate)?estimate:null;
  this.value.deadlineKind=this.value.nextReferenceEstimateMs===null?'unknown':'next-reference-estimate';
  if(this.value.nextReferenceEstimateMs===null)this.value.deadlineUnknownCallbacks++;else this.value.deadlineKnownCallbacks++;
  if(presentedFrames!==null){if(this.previousPresented!==null)this.value.presentationGaps+=Math.max(0,presentedFrames-this.previousPresented-1);this.previousPresented=presentedFrames;}
  const started=now();
  try{
   const trace=prepareSynchronizedPair(sample,a,b,domain);this.value.prepared=trace;this.value.lastPoseMs=now()-started;
   this.draw(a,b,trace,now);const finished=now();this.finish(finished,this.value.nextReferenceEstimateMs);
   this.value.currentDisplayLatenessMs=expectedDisplayTime===null?null:Math.max(0,finished-expectedDisplayTime);
   this.value.status='drawn';if(this.value.deadlineKind==='next-reference-estimate'&&this.value.lastLatenessMs===0)this.value.inspection={...trace};
   return this.snapshot();
  }catch(error){this.value.status='failed';this.value.inspection=null;throw error;}
 }
}
