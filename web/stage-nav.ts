/** Four inspection stages. Each chip opens a mode of the one screen or names itself unavailable; no chip loads a page. Navigation never submits or applies. */
import {onLanguageChange,t} from './i18n.ts';
export const reviewStages = ['1 Parts + mesh','2 Interview','3 Rig + animation','4 Direction'] as const;
export type ReviewStage = 1|2|3|4;
export interface StagePartsState {
 inspectionSourceHash:string;part:string;imageHash:string;box:{x:number;y:number;w:number;h:number};mapping:{skin:string;slot:string;attachment:string};
 rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};cameraSync:boolean;
 bg:string;alpha:boolean;footprints:boolean;view:'item'|'page'|'assembled';mesh:boolean;
}
/** Navigation state transfers only over exact original-art/package identity and the same draft address. */
export function stagePartsSelectionIndex(data:{inspectionSourceHash?:string;items:{name:string;imageHash?:string;x:number;y:number;w:number;h:number}[];draft?:{mappings:{part:string;skin:string;slot:string;attachment:string}[]}},saved:StagePartsState):number {
 const i=data.items.findIndex(item=>item.name===saved.part&&item.imageHash===saved.imageHash&&(['x','y','w','h']as const).every(k=>item[k]===saved.box[k]));
 const m=data.draft?.mappings.find(m=>m.part===saved.part);
 if(i<0||data.inspectionSourceHash!==saved.inspectionSourceHash||!m||(['skin','slot','attachment']as const).some(k=>m[k]!==saved.mapping[k]))throw new Error('STAGE_DRAFT_MISMATCH');
 return i;
}
export const DIRECTION_NOT_AVAILABLE='DIRECTION_NOT_AVAILABLE: Direction is not built yet.';
export const INTERVIEW_MODAL_UNAVAILABLE='INTERVIEW_MODAL_UNAVAILABLE: the interview over this screen is not built yet.';
/** The named reason a chip is unavailable, or null when it opens its mode. */
export function stageReason(stage:ReviewStage,model:boolean,interview=false,preRig=false,interviewModal=false):string|null {
 if(stage===4)return DIRECTION_NOT_AVAILABLE;
 if(stage===2)return !interview?'INTERVIEW_UNAVAILABLE: No interview is attached to this inspection.':interviewModal?null:INTERVIEW_MODAL_UNAVAILABLE;
 if(preRig)return 'RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.';
 if(!model)return 'MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.';
 return null;
}
export interface StageNavOptions {
 model:boolean;preRig?:boolean;interview?:boolean;
 /** Chip 1 opens the Setup mode of the one screen. */
 setup?:()=>void;
 /** Chip 3 opens the Animate mode of the one screen. */
 animate?:()=>void;
 /** Chip 2 opens the interview modal over the screen. Seam for #708: until it passes an opener, chip 2 names itself unavailable. */
 interviewModal?:()=>void;
 /** The stage whose mode is showing, read after every chip or mode change. */
 current?:()=>ReviewStage|null;
 /** A page outside the one screen shows only its own stage. */
 only?:ReviewStage;
}
export function bindStageNav(options:StageNavOptions):()=>void {
 const host=document.querySelector<HTMLElement>('[data-stage-nav]');if(!host)return ()=>{};
 const reason=(stage:ReviewStage)=>stageReason(stage,options.model,!!options.interview,options.preRig,!!options.interviewModal);
 const stages=options.only?[options.only]:[1,2,3,4] as ReviewStage[];
 const attr=(el:Element,name:string)=>typeof el.getAttribute==='function'?el.getAttribute(name):null;
 const setOrRemove=(el:Element,name:string,value:string|null)=>{if(value===null)el.removeAttribute?.(name);else el.setAttribute(name,value);};
 const modeControls=[...document.querySelectorAll<HTMLButtonElement>('[data-mode],[data-inspector]')].map(button=>({
  button,disabled:Boolean(button.disabled),title:attr(button,'title'),pressed:attr(button,'aria-pressed'),selected:attr(button,'aria-selected'),
 }));
 const modeSwitches=[...document.querySelectorAll<HTMLElement>('.mode-switch')].map(el=>({el,hidden:Boolean(el.hidden)}));
 const sourcePicker=document.getElementById('mode-build-picker'),pickerHidden=Boolean(sourcePicker?.hidden);
 // With no rig on the stage, every Setup/Animate/Compare control stays refused by name (#441).
 const rigReason=options.only?null:reason(3);
 const lockRigControls=()=>{
  if(!rigReason)return;
  const text=t(rigReason);
  for(const item of modeSwitches)item.el.hidden=true;
  if(sourcePicker)sourcePicker.hidden=true;
  for(const item of modeControls){
   item.button.disabled=true;item.button.title=text;item.button.setAttribute('title',text);
   if(item.pressed!==null&&attr(item.button,'aria-pressed')!=='false')item.button.setAttribute('aria-pressed','false');
   if(item.selected!==null&&attr(item.button,'aria-selected')!=='false')item.button.setAttribute('aria-selected','false');
  }
 };
 let current:ReviewStage|null=options.only??options.current?.()??null;
 const open=(stage:ReviewStage)=>{
  if(options.only)return;
  if(reason(stage)){render();return;}
  if(stage===1)options.setup?.();else if(stage===2)options.interviewModal?.();else if(stage===3)options.animate?.();
  if(stage!==2)current=stage;render();
 };
 const buttons=stages.map(stage=>{const button=document.createElement('button');button.type='button';button.dataset.reviewStage=String(stage);button.onclick=()=>open(stage);host.append(button);return button;});
 const render=()=>{
  if(!options.only)current=options.current?.()??current;
  if(current)document.documentElement.dataset.inspectionStage=String(current);
  buttons.forEach((button,index)=>{
   const stage=stages[index]!,why=options.only?null:reason(stage),label=t(reviewStages[stage-1]!);
   button.textContent=why?t('{stage} · not available',{stage:label}):label;
   button.setAttribute('aria-current',current===stage?'step':'false');
   if(why){button.setAttribute('aria-disabled','true');button.title=t(why);button.dataset.unavailable=why.split(':')[0]!;}
   else{button.removeAttribute?.('aria-disabled');button.title='';delete button.dataset.unavailable;}
  });
  host.setAttribute('aria-label',t('Inspection stages'));
  lockRigControls();
 };
 // Mode switches outside the chips keep the current chip in step, and a refused rig re-locks at once.
 const observer=options.current||rigReason?new MutationObserver(render):null;
 for(const {button} of modeControls)observer?.observe(button,{attributes:true,attributeFilter:['aria-selected','aria-pressed']});
 const relock=(event:Event)=>{if(!rigReason)return;event.preventDefault?.();event.stopImmediatePropagation?.();lockRigControls();};
 modeControls.forEach(({button})=>button.addEventListener('click',relock,true));
 if(rigReason)document.documentElement.dataset.stageRefused='true';
 const language=onLanguageChange(render);render();
 return ()=>{
  language();observer?.disconnect();modeControls.forEach(({button})=>button.removeEventListener('click',relock,true));buttons.forEach(button=>button.remove());
  delete document.documentElement.dataset.inspectionStage;delete document.documentElement.dataset.stageRefused;
  if(rigReason){
   for(const item of modeSwitches)item.el.hidden=item.hidden;
   if(sourcePicker)sourcePicker.hidden=pickerHidden;
   for(const item of modeControls){item.button.disabled=item.disabled;item.button.title=item.title??'';setOrRemove(item.button,'title',item.title);setOrRemove(item.button,'aria-pressed',item.pressed);setOrRemove(item.button,'aria-selected',item.selected);}
  }
 };
}
