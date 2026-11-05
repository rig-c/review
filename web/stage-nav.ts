/** Four inspection stages. Existing tools remain mounted; navigation never submits or applies. */
import {getLanguage,onLanguageChange,t} from './i18n.ts';
import {pageInstanceAccess} from './instance-access.ts';
export const reviewStages = ['1 Parts + mesh','2 Interview','3 Rig + animation','4 Direction'] as const;
export type ReviewStage = 1|2|3|4;
export function stageReason(stage:ReviewStage,model:boolean):string|null {
 if(stage===2)return 'INTERVIEW_UNAVAILABLE: no interview consumer contract is installed.';
 if(stage===4)return 'DIRECTION_UNAVAILABLE: no direction inspection contract is installed.';
 if(stage===3&&!model)return 'MODEL_UNAVAILABLE: no compiled model is supplied in this inspection.';
 return null;
}
export function bindStageNav(options:{partsOnly?:boolean;model:boolean;side?:()=> 'a'|'b';setup?:()=>void}):()=>void {
 const host=document.querySelector<HTMLElement>('[data-stage-nav]');if(!host)return ()=>{};
 const embedded=new URL(location.href).searchParams.get('stageEmbed')==='1';
 if(embedded){host.hidden=true;return ()=>{};}
 const access=pageInstanceAccess(),panel=document.createElement('section');panel.className='review-stage-panel';panel.hidden=true;panel.setAttribute('aria-live','polite');document.body.append(panel);
 const status=document.createElement('p');status.setAttribute('role','status');panel.append(status);
 const sourcePicker=document.getElementById('mode-build-picker');
 const frames=new Map<string,HTMLIFrameElement>();let current:ReviewStage=options.partsOnly?1:3;
 const workspace=document.querySelector<HTMLElement>(options.partsOnly?'.pv-layout':'.layout');const wasInert=workspace?.inert??false;
 const buttons=reviewStages.map((label,index)=>{const button=document.createElement('button');button.type='button';button.dataset.reviewStage=String(index+1);button.onclick=()=>show(index+1 as ReviewStage);host.append(button);return button;});
 const mesh=document.createElement('button');mesh.type='button';mesh.onclick=()=>{show(3);options.setup?.();};panel.append(mesh);
 const render=()=>{buttons.forEach((b,i)=>{b.textContent=t(reviewStages[i]!);b.setAttribute('aria-current',current===i+1?'step':'false');});host.setAttribute('aria-label',t('Inspection stages'));if(sourcePicker)sourcePicker.setAttribute('aria-label',t(current===1?'Atlas source build':'Picked build for Setup and Animate'));mesh.textContent=t('Open setup mesh instruments');};
 const place=()=>{panel.style.top=`${(host.closest('header')??host).getBoundingClientRect().bottom}px`;};
 function show(stage:ReviewStage):void {
  current=stage;document.documentElement.dataset.inspectionStage=String(stage);render();place();const reason=stageReason(stage,options.model);
  panel.hidden=stage===(options.partsOnly?1:3)&&!reason;
  if(workspace)workspace.inert=!panel.hidden||wasInert;
  status.textContent=reason?t(reason):stage===1&&!options.partsOnly?t('Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.'):'';mesh.hidden=stage!==1||!options.model||!!options.partsOnly;
  for(const frame of frames.values())frame.hidden=true;
  if(stage===1&&!options.partsOnly){const side=options.side?.(),key=side??'single';let frame=frames.get(key);if(!frame){frame=document.createElement('iframe');frame.title=t('Parts and atlas inspection');frame.src=access.route('/stage-parts.html')+'?stageEmbed=1&lang='+getLanguage()+(side?'&side='+side:'');frame.addEventListener('load',()=>frame!.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin));frames.set(key,frame);panel.append(frame);}frame.hidden=false;}
 }
 // Legacy Setup/Animate/Compare selectors keep their IDs, payloads and behavior.
 const legacy=()=>show(3);document.querySelectorAll('[data-mode],[data-inspector]').forEach(b=>b.addEventListener('click',legacy));
 // A side choice reuses the canonical closed A/B picker, then reveals that side's retained atlas.
 let pickingSource=false;
 const sourceChanged=()=>{if(current!==1)return;pickingSource=true;show(1);queueMicrotask(()=>{pickingSource=false;});};
 sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.addEventListener('click',sourceChanged));
 // Legacy bookmark/control restoration writes these canonical attributes even when a mode is unchanged.
 const canonical=new MutationObserver(()=>{if(current!==3&&!options.partsOnly&&!pickingSource)show(3);});
 document.querySelectorAll('[data-inspector]').forEach(button=>canonical.observe(button,{attributes:true,attributeFilter:['aria-selected','aria-pressed']}));
 const language=onLanguageChange(()=>{render();if(!panel.hidden)status.textContent=t(stageReason(current,options.model)??(current===1?'Atlas inspection, read only — inspected package. Applied scratch atlas, pre-rig parts, mesh sign-off and draft corrections are unavailable here.':''));for(const f of frames.values()){f.title=t('Parts and atlas inspection');f.contentWindow?.postMessage({type:'review-stage-language',language:getLanguage()},location.origin);}});
 window.addEventListener('resize',place);show(current);
 return ()=>{language();canonical.disconnect();sourcePicker?.querySelectorAll('[data-build-side]').forEach(button=>button.removeEventListener('click',sourceChanged));delete document.documentElement.dataset.inspectionStage;if(workspace)workspace.inert=wasInert;panel.remove();window.removeEventListener('resize',place);document.querySelectorAll('[data-mode],[data-inspector]').forEach(b=>b.removeEventListener('click',legacy));};
}
