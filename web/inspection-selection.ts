import type {InspectionTarget} from '../src/animation-inspection.ts';
/** Page-local bone selection. Existing slot identity, bookmarks and feedback formats stay unchanged. */
export class InspectionSelection {
 private selected:InspectionTarget=null;private applying=false;
 constructor(private changed:(value:InspectionTarget)=>void){}
 value():InspectionTarget{return this.selected?{...this.selected}:null;}
 select(value:InspectionTarget):void {
  if(this.applying)return;
  if(this.selected?.kind===value?.kind&&this.selected?.name===value?.name)return;
  const previous=this.selected;this.selected=value?{...value}:null;this.applying=true;
  try{this.changed(this.value());}catch(e){this.selected=previous;throw e;}finally{this.applying=false;}
 }
}
