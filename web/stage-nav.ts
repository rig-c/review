/** Four inspection stages. Existing tools remain mounted; navigation never submits or applies. */
import {getLanguage,onLanguageChange,t} from './i18n.ts';
import {pageInstanceAccess} from './instance-access.ts';
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
export function stageReason(stage:ReviewStage,model:boolean):string|null {
 if(stage===2)return 'INTERVIEW_UNAVAILABLE: no interview consumer contract is installed.';
 if(stage===4)return 'DIRECTION_UNAVAILABLE: no direction inspection contract is installed.';
 if(stage===3&&!model)return 'MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.';
 return null;
}
export function bindStageNav(options:{partsOnly?:boolean;model:boolean;side?:()=> 'a'|'b';setup?:()=>void;draftBuild?:()=>string;correction?:(request:{part:string;sourceHash:string;buildId:string;instrument:string})=>Promise<void>}):()=>void {
 const host=document.querySelector<HTMLElement>('[data-stage-nav]');if(!host)return ()=>{};
 const embedded=new URL(location.href).searchParams.get('stageEmbed')==='1';
 if(embedded){host.hidden=true;return ()=>{};}
 const access=pageInstanceAccess(),panel=document.createElement('section');panel.className='review-stage-panel';panel.hidden=true;panel.setAttribute('aria-live','polite');document.body.append(panel);
 const status=document.createElement('p');status.setAttribute('role','status');panel.append(status);
 const sourcePicker=document.getElementById('mode-build-picker');
 const frames=new Map<string,HTMLIFrameElement>();let lastFrame:HTMLIFrameElement|null=null;let current:ReviewStage=options.partsOnly?1:3;
 const workspace=document.querySelector<HTMLElement>(options.partsOnly?'.pv-layout':'.layout');const wasInert=workspace?.inert??false;
 const buttons=reviewStages.map((label,index)=>{const button=document.createElement('button');button.type='button';button.dataset.reviewStage=String(index+1);button.onclick=()=>show(index+1 as ReviewStage);host.append(button);return button;});
 const mesh=document.createElement('button');mesh.type='button';mesh.onclick=()=>{show(3);options.setup?.();};panel.append(mesh);
 const render=()=>{buttons.forEach((b,i)=>{b.textContent=t(reviewStages[i]!);b.setAttribute('aria-current',current===i+1?'step':'false');});host.setAttribute('aria-label',t('Inspection stages'));if(sourcePicker)sourcePicker.setAttribute('aria-label',t(current===1?'Atlas source build':'Picked build for Setup and Animate'));mesh.textContent=t('Open setup mesh instruments');};
 const place=()=>{panel.style.top=`${(host.closest('header')??host).getBoundingClientRect().bottom}px`;};
 function show(stage:ReviewStage):void {
  current=stage;document.documentElement.dataset.inspectionStage=String(stage);render();place();const reason=stageReason(stage,options.model);
  panel.hidden=stage===(options.partsOnly?1:3)&&!reason;
  if(workspace)workspace.inert=!panel.hidden||wasInert;
  status.textContent=reason?t(reason):stage===1&&!options.partsOnly?t(options.correction?'Draft rig · structure evidence only':'Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.'):'';mesh.hidden=stage!==1||!options.model||!!options.partsOnly;
  for(const frame of frames.values())frame.hidden=true;
  if(stage===1&&!options.partsOnly){const saved=(lastFrame?.contentWindow as StagePartsWindow|null)?.rigReviewStageParts?.snapshot()??null;const side=options.side?.(),key=(side??'single')+':'+(options.draftBuild?.()??'inspected');let frame=frames.get(key);if(!frame){if(options.correction){for(const old of frames.values())old.remove();frames.clear();}frame=document.createElement('iframe');frame.title=t('Parts and atlas inspection');frame.src=access.route('/stage-parts.html')+'?stageEmbed=1&lang='+getLanguage()+(side?'&side='+side:'');frame.addEventListener('load',()=>{frame!.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin);frame!.contentWindow?.postMessage({type:'review-stage-source',buildId:options.draftBuild?.()??'inspected',state:saved},location.origin);});frames.set(key,frame);panel.append(frame);}else if(options.correction){frame.contentWindow?.postMessage({type:'review-stage-revalidate',state:lastFrame!==frame?saved:null},location.origin);}frame.hidden=false;lastFrame=frame;}
 }
 const correction=async(event:MessageEvent)=>{if(event.origin!==location.origin||![...frames.values()].some(f=>f.contentWindow===event.source)||event.data?.type!=='review-stage-correction'||!options.correction)return;const r=event.data;if(typeof r.part!=='string'||typeof r.sourceHash!=='string'||typeof r.buildId!=='string'||!['chest','mesh','delta'].includes(r.instrument))return;try{await options.correction(r);show(3);}catch(error){status.textContent=error instanceof Error?error.message:String(error);}};
 window.addEventListener('message',correction);
 // Legacy Setup/Animate/Compare selectors keep their IDs, payloads and behavior.
 const legacy=()=>show(3);document.querySelectorAll('[data-mode],[data-inspector]').forEach(b=>b.addEventListener('click',legacy));
 // A side choice reuses the canonical closed A/B picker, then reveals that side's retained atlas.
 let pickingSource=false;
 const sourceChanged=()=>{if(current!==1)return;pickingSource=true;show(1);queueMicrotask(()=>{pickingSource=false;});};
 sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.addEventListener('click',sourceChanged));
 // Legacy bookmark/control restoration writes these canonical attributes even when a mode is unchanged.
 const canonical=new MutationObserver(()=>{if(current!==3&&!options.partsOnly&&!pickingSource)show(3);});
 document.querySelectorAll('[data-inspector]').forEach(button=>canonical.observe(button,{attributes:true,attributeFilter:['aria-selected','aria-pressed']}));
 const language=onLanguageChange(()=>{render();if(!panel.hidden)status.textContent=t(stageReason(current,options.model)??(current===1&&options.correction?'Draft rig · structure evidence only':current===1?'Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.':''));for(const f of frames.values()){f.title=t('Parts and atlas inspection');f.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin);}});
 window.addEventListener('resize',place);show(current);
 return ()=>{window.removeEventListener('message',correction);language();canonical.disconnect();sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.removeEventListener('click',sourceChanged));delete document.documentElement.dataset.inspectionStage;if(workspace)workspace.inert=wasInert;panel.remove();window.removeEventListener('resize',place);document.querySelectorAll('[data-mode],[data-inspector]').forEach(b=>b.removeEventListener('click',legacy));};
}
