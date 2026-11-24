import {loadModel,RigPlayer,type ModelAssets} from '@rig-c/play';
import type {JobPreviousBuild} from '../src/job-contract.ts';
import {setSourceText} from './i18n.ts';

interface Host {
 el:<T extends HTMLElement=HTMLElement>(id:string)=>T;
 signal:AbortSignal;
 url:(path:string)=>string;
 modelFetch:(url:string,hash:string)=>typeof fetch;
}

/** The existing stage owns navigation and feedback. This view owns only the retained build and its presentation. */
export function createPreviousBuildView(build:JobPreviousBuild,host:Host) {
 const left=host.el('reference-pane'),right=host.el('rig-pane'),viewport=host.el('reference-viewport');
 const stage=host.el('stage-layout'),sync=host.el<HTMLInputElement>('camera-sync');
 const root=document.createElement('div');
 root.id='previous-build-root';
 const previousLabel=buildLabel('previous-build-label','Previous ·',build.label);
 const currentLabel=buildLabel('current-build-label','Current ·',build.currentLabel);
 const missing=document.createElement('div');
 missing.className='pane-label previous-build-missing';missing.hidden=true;
 missing.setAttribute('role','status');
 setSourceText(missing,'This clip is missing from the previous version. Showing the setup pose.');
 let assets:ModelAssets|null=null,player:RigPlayer|null=null,loading:Promise<void>|null=null;
 let rendered:{clip:string|null;time:number;loop:boolean}|null=null,active=false,syncDisabled=false;
 const pane={target:'reference' as const,viewport,pane:left,root,player:()=>player,assets:()=>assets,
  drawnGeneration:()=>player?.generation,scale:()=>{}};

 async function load():Promise<void> {
  if(assets)return;
  if(loading)return loading;
  const modelUrl=host.url(build.model.path),pages=new Set(build.pages.map(page=>host.url(page.path)));
  loading=loadModel({modelUrl,setsUrl:null,fetch:host.modelFetch(modelUrl,build.model.sha256),resolvePage:(name,url)=>{
   const page=new URL(name,url).href;
   if(!pages.has(page))throw new Error('JOB_PREVIOUS_BUILD_INVALID');
   return page;
  }}).then(loaded=>{
   if(host.signal.aborted){loaded.dispose();return;}
   assets=loaded;
  }).finally(()=>{loading=null;});
  return loading;
 }

 function present(current:RigPlayer):void {
  const name=current.current;
  const mapped=name&&Object.hasOwn(build.clipMap,name)?build.clipMap[name]:null;
  const clip=assets?.animations.find(animation=>animation.name===mapped)?.name??null;
  const time=clip?current.time:0,loop=!!clip&&!!current.entry(0)?.loop;
  const unavailable=!!name&&!clip;
  if(missing.hidden===unavailable)missing.hidden=!unavailable;
  if(rendered?.clip===clip&&rendered.time===time&&rendered.loop===loop)return;
  // Play's clear enters composed-track mode. A fresh player on the same cached assets
  // gives the actual setup pose and can subsequently seek a mapped clip on one track.
  if(!player||(!clip&&rendered?.clip)){player?.dispose();player=new RigPlayer(root,assets!);}
  if(clip){
   if(rendered?.clip!==clip||rendered.loop!==loop){player.play(clip,{loop});player.pause();}
   player.seek(time);
  }
  player.draw();
  rendered={clip,time,loop};
 }

 function show(current:RigPlayer):void {
  // Prepare a successful first draw before making the alias or layout visible.
  present(current);
  active=true;syncDisabled=sync.disabled;sync.disabled=true;
  left.setAttribute('aria-labelledby',previousLabel.id);right.setAttribute('aria-labelledby',currentLabel.id);
  left.append(previousLabel,missing);right.append(currentLabel);viewport.append(root);
  stage.dataset.previousBuildActive='';
 }

 function hide():void {
  if(!active)return;
  active=false;sync.disabled=syncDisabled;
  delete stage.dataset.previousBuildActive;
  left.removeAttribute('aria-labelledby');right.removeAttribute('aria-labelledby');
  root.remove();previousLabel.remove();currentLabel.remove();missing.remove();
 }

 return {load,show,hide,present,active:()=>active,
  pane:()=>active?pane:null,
  dispose:()=>{hide();player?.dispose();assets?.dispose();player=null;assets=null;}};
}

function buildLabel(id:string,caption:string,label:string):HTMLSpanElement {
 const badge=document.createElement('span'),prefix=document.createElement('span'),value=document.createElement('span');
 badge.id=id;badge.className='pane-label';
 value.translate=false;value.textContent=label;value.className='previous-build-version';
 setSourceText(prefix,caption);badge.append(prefix,' ',value);
 return badge;
}
