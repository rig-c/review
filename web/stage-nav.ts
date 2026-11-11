/** Four inspection stages. Existing tools remain mounted; navigation never submits or applies. */
import {getLanguage,onLanguageChange,t} from './i18n.ts';
import {interviewModal,mountInterview} from './interview-panel.ts';
import {pageInstanceAccess,type InstanceAccess} from './instance-access.ts';
export const reviewStages = ['1 Parts + mesh','2 Interview','3 Rig + animation','4 Direction'] as const;
export type ReviewStage = 1|2|3|4;
export interface StagePartsState {
 inspectionSourceHash:string;part:string;imageHash:string;box:{x:number;y:number;w:number;h:number};mapping:{skin:string;slot:string;attachment:string};
 rig:{zoom:number;center:{x:number;y:number}|null};reference:{zoom:number;center:{x:number;y:number}|null};cameraSync:boolean;
 bg:string;alpha:boolean;footprints:boolean;view:'item'|'page'|'assembled';mesh:boolean;
}
export interface StagePartsWindow extends Window {rigReviewStageParts?:{snapshot:()=>StagePartsState|null}}
/** Navigation state transfers only over exact original-art/package identity and the same draft address. */
export function stagePartsSelectionIndex(data:{inspectionSourceHash?:string;items:{name:string;imageHash?:string;x:number;y:number;w:number;h:number}[];draft?:{mappings:{part:string;skin:string;slot:string;attachment:string}[]}},saved:StagePartsState):number {
 const i=data.items.findIndex(item=>item.name===saved.part&&item.imageHash===saved.imageHash&&(['x','y','w','h']as const).every(k=>item[k]===saved.box[k]));
 const m=data.draft?.mappings.find(m=>m.part===saved.part);
 if(i<0||data.inspectionSourceHash!==saved.inspectionSourceHash||!m||(['skin','slot','attachment']as const).some(k=>m[k]!==saved.mapping[k]))throw new Error('STAGE_DRAFT_MISMATCH');
 return i;
}
export function stageReason(stage:ReviewStage,model:boolean,direction=false,interview=false,preRig=false):string|null {
 if(stage===2&&!interview)return 'INTERVIEW_UNAVAILABLE: No interview is attached to this inspection.';
 if(preRig&&stage===3)return 'RIG_VERSION_UNAVAILABLE: this draft has no recorded rig review package.';
 if(preRig&&stage===4)return 'DIRECTION_VERSION_UNAVAILABLE: this draft has no recorded rig review package.';
 if(stage===4&&!direction)return 'DIRECTION_UNAVAILABLE: no direction inspection contract is installed.';
 if(stage===3&&!model)return 'MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.';
 return null;
}
function stageFrameRoute(access:InstanceAccess,path:'/stage-parts.html',side?:'a'|'b'):string {
 const query=new URLSearchParams({stageEmbed:'1',lang:getLanguage()});
 if(side)query.set('side',side);
 // Managed paths already identify the slot and their front accepts only the closed stage query.
 if(access.base==='/'&&/^[a-f0-9]{64}$/.test(access.key))query.set('handoff',access.key);
 return access.route(path)+'?'+query;
}
export function bindStageNav(options:{preRig?:boolean;interviewOnly?:boolean;interview?:boolean;access?:InstanceAccess;partsOnly?:boolean;model:boolean;direction?:(active:boolean)=>void;side?:()=> 'a'|'b';setup?:()=>void;draftBuild?:()=>string;refresh?:(fn:()=>void)=>void;correction?:(request:{part:string;sourceHash:string;buildId:string;instrument:string})=>Promise<void>}):()=>void {
 const host=document.querySelector<HTMLElement>('[data-stage-nav]');if(!host)return ()=>{};
 if(options.interviewOnly){
  const button=document.createElement('button');button.type='button';button.dataset.reviewStage='2';button.setAttribute('aria-current','step');host.append(button);
  const render=()=>{button.textContent=t(reviewStages[1]);host.setAttribute('aria-label',t('Inspection stages'));};
  document.documentElement.dataset.inspectionStage='2';render();
  const language=onLanguageChange(render);return ()=>{language();button.remove();};
 }
 // `/stage-interview.html` is the single entry opening on the interview modal (E2), never an embedded frame.
 const interviewEntry=new URL(location.href).pathname.endsWith('/stage-interview.html');
 const embedded=!interviewEntry&&new URL(location.href).searchParams.get('stageEmbed')==='1';
 if(embedded){host.hidden=true;return ()=>{};}
 const access=options.access??pageInstanceAccess(),panel=document.createElement('section');panel.className='review-stage-panel';panel.hidden=true;panel.setAttribute('aria-live','polite');document.body.append(panel);
 const status=document.createElement('p');status.setAttribute('role','status');panel.append(status);
 let interviewOpen=false,unmountInterview:Promise<()=>void>|null=null,entry=0;
 const sourcePicker=document.getElementById('mode-build-picker');
 const attr=(el:Element,name:string)=>typeof el.getAttribute==='function'?el.getAttribute(name):null;
 const setOrRemove=(el:Element,name:string,value:string|null)=>{if(value===null)el.removeAttribute?.(name);else el.setAttribute(name,value);};
 const modeSwitches=[...document.querySelectorAll<HTMLElement>('.mode-switch')].map(el=>({el,hidden:Boolean(el.hidden)}));
 const modeControls=[...document.querySelectorAll<HTMLButtonElement>('[data-mode],[data-inspector]')].map(button=>({
  button,disabled:Boolean(button.disabled),title:attr(button,'title'),pressed:attr(button,'aria-pressed'),selected:attr(button,'aria-selected'),
 }));
 const pickerState=sourcePicker?{hidden:Boolean(sourcePicker.hidden),label:attr(sourcePicker,'aria-label')}:null;
 const frames=new Map<string,HTMLIFrameElement>();let lastFrame:HTMLIFrameElement|null=null;let current:ReviewStage=(options.partsOnly||options.preRig)?1:3;let correctionActive=false;
 const workspace=document.querySelector<HTMLElement>(options.partsOnly?'.pv-layout':'.layout');const wasInert=workspace?.inert??false;
 const reasonFor=(stage:ReviewStage)=>stageReason(stage,options.model,!!options.direction,!!options.interview,options.preRig);
 const activeReason=(stage:ReviewStage)=>stage===3&&correctionActive?null:reasonFor(stage);
 const buttons=reviewStages.map((label,index)=>{const button=document.createElement('button');button.type='button';button.dataset.reviewStage=String(index+1);button.onclick=()=>{if(index+1===3)correctionActive=false;show(index+1 as ReviewStage);};host.append(button);return button;});
 // Create step 2 is a modal over this screen, not a stage panel; stage 2 keeps its refusal when no interview is attached.
 const modal=reasonFor(2)?null:interviewModal({parent:document.body,trigger:buttons[1]!,id:'review-interview-modal',
  onOpen:()=>{interviewOpen=true;document.documentElement.dataset.inspectionStage='2';render();if(!unmountInterview){modal!.body.textContent=t('interview.loading');unmountInterview=mountInterview(modal!.body,access);}},
  onClose:()=>{interviewOpen=false;document.documentElement.dataset.inspectionStage=String(current);render();}});
 if(modal)buttons[1]!.onclick=null;
 const mesh=document.createElement('button');mesh.type='button';mesh.onclick=()=>{if(reasonFor(3))return;show(3);options.setup?.();};panel.append(mesh);
 const syncRigControls=()=>{
  const rigReason=activeReason(3),refused=Boolean(activeReason(current));
  if(refused)document.documentElement.dataset.stageRefused='true';else delete document.documentElement.dataset.stageRefused;
  for(const item of modeSwitches)item.el.hidden=current!==3||Boolean(rigReason)?true:item.hidden;
  if(sourcePicker&&pickerState&&rigReason&&current===3)sourcePicker.hidden=true;
  if(!rigReason){
   for(const item of modeControls){
    item.button.disabled=item.disabled;item.button.title=item.title??'';setOrRemove(item.button,'title',item.title);
   }
   return;
  }
  const reasonText=t(rigReason);
  for(const item of modeControls){
   item.button.disabled=true;item.button.title=reasonText;item.button.setAttribute('title',reasonText);
   if(item.pressed!==null&&attr(item.button,'aria-pressed')!=='false')item.button.setAttribute('aria-pressed','false');
   if(item.selected!==null&&attr(item.button,'aria-selected')!=='false')item.button.setAttribute('aria-selected','false');
  }
 };
 const render=()=>{buttons.forEach((b,i)=>{b.textContent=t(reviewStages[i]!);b.setAttribute('aria-current',(interviewOpen?2:current)===i+1?'step':'false');});host.setAttribute('aria-label',t('Inspection stages'));if(sourcePicker)sourcePicker.setAttribute('aria-label',t(current===1?'Atlas source build':'Picked build for Setup and Animate'));mesh.textContent=t('Open setup mesh instruments');syncRigControls();};
 const place=()=>{panel.style.top=`${(host.closest('header')??host).getBoundingClientRect().bottom}px`;};
 const setFrameLanguage=(frame:HTMLIFrameElement)=>frame.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin);
 function show(stage:ReviewStage):void {
  if(stage!==3)correctionActive=false;
  current=stage;document.documentElement.dataset.inspectionStage=String(stage);render();place();const reason=activeReason(stage);++entry;
  options.direction?.(stage===4);
  panel.hidden=!reason&&(stage===(options.partsOnly?1:3)||stage===4)&&(!options.preRig||(stage===3&&correctionActive));
  if(workspace)workspace.inert=!panel.hidden||wasInert;
  status.textContent=reason?t(reason):stage===1&&!options.partsOnly?t(options.correction||options.preRig?'Draft rig · structure evidence only':'Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.'):'';mesh.hidden=stage!==1||Boolean(reasonFor(3))||!!options.partsOnly;
  for(const frame of frames.values())frame.hidden=true;
  if(stage===1&&!options.partsOnly)showParts();
 }
 function showParts(){
  const saved=(lastFrame?.contentWindow as StagePartsWindow|null)?.rigReviewStageParts?.snapshot()??null;const side=options.side?.(),buildId=options.draftBuild?.()??'inspected',key=(side??'single')+':'+buildId;let frame=frames.get(key);if(!frame){if(options.correction){for(const old of frames.values())old.remove();frames.clear();}frame=document.createElement('iframe');frame.title=t('Parts and atlas inspection');frame.src=stageFrameRoute(access,'/stage-parts.html',side);frame.addEventListener('load',()=>{frame!.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin);frame!.contentWindow?.postMessage({type:'review-stage-source',buildId,state:saved},location.origin);});frames.set(key,frame);panel.append(frame);}else if(options.correction||options.preRig){frame.contentWindow?.postMessage({type:'review-stage-revalidate',buildId,state:lastFrame!==frame?saved:null},location.origin);}frame.hidden=false;lastFrame=frame;
 }
 options.refresh?.(()=>{if(current===1&&!options.partsOnly)showParts();});
 const correction=async(event:MessageEvent)=>{if(event.origin!==location.origin||![...frames.values()].some(f=>f.contentWindow===event.source)||event.data?.type!=='review-stage-correction'||!options.correction)return;const r=event.data;if(typeof r.part!=='string'||typeof r.sourceHash!=='string'||typeof r.buildId!=='string'||!['chest','mesh','delta'].includes(r.instrument))return;const prev=correctionActive;correctionActive=true;syncRigControls();try{await options.correction(r);show(3);}catch(error){correctionActive=prev;syncRigControls();status.textContent=error instanceof Error?error.message:String(error);}};
 window.addEventListener('message',correction);
 // Legacy Setup/Animate/Compare selectors keep their IDs, payloads and behavior.
 const legacy=(event?:Event)=>{if(activeReason(3)){event?.preventDefault?.();event?.stopImmediatePropagation?.();syncRigControls();return;}show(3);};
 modeControls.forEach(({button})=>button.addEventListener('click',legacy,true));
 // A side choice reuses the canonical closed A/B picker, then reveals that side's retained atlas.
 let pickingSource=false;
 const sourceChanged=()=>{if(current!==1)return;pickingSource=true;show(1);queueMicrotask(()=>{pickingSource=false;});};
 sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.addEventListener('click',sourceChanged));
 // Legacy bookmark/control restoration writes these canonical attributes even when a mode is unchanged.
 const canonical=new MutationObserver(()=>{if(activeReason(3)){syncRigControls();return;}if(current!==3&&!options.partsOnly&&!options.preRig&&!pickingSource)show(3);});
 document.querySelectorAll('[data-inspector]').forEach(button=>canonical.observe(button,{attributes:true,attributeFilter:['aria-selected','aria-pressed']}));
 const language=onLanguageChange(()=>{render();if(!panel.hidden)status.textContent=t(activeReason(current)??(current===1&&(options.correction||options.preRig)?'Draft rig · structure evidence only':current===1?'Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.':''));for(const f of frames.values()){f.title=t('Parts and atlas inspection');setFrameLanguage(f);}modal?.localize();});
 window.addEventListener('resize',place);show(current);if(interviewEntry)modal?.open();
 return ()=>{entry++;modal?.dispose();void unmountInterview?.then(unmount=>unmount());window.removeEventListener('message',correction);language();canonical.disconnect();sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.removeEventListener('click',sourceChanged));delete document.documentElement.dataset.inspectionStage;delete document.documentElement.dataset.stageRefused;for(const item of modeSwitches)item.el.hidden=item.hidden;if(sourcePicker&&pickerState){sourcePicker.hidden=pickerState.hidden;setOrRemove(sourcePicker,'aria-label',pickerState.label);}if(reasonFor(3))for(const item of modeControls){item.button.disabled=item.disabled;item.button.title=item.title??'';setOrRemove(item.button,'title',item.title);setOrRemove(item.button,'aria-pressed',item.pressed);setOrRemove(item.button,'aria-selected',item.selected);}if(workspace)workspace.inert=wasInert;buttons.forEach(b=>b.remove());panel.remove();window.removeEventListener('resize',place);modeControls.forEach(({button})=>button.removeEventListener('click',legacy,true));};
}
