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
 let active=false,syncDisabled=false,drawnGeneration:number|undefined;
 const pane={target:'reference' as const,viewport,pane:left,root,player:()=>player,assets:()=>assets,
  drawnGeneration:()=>drawnGeneration,scale:()=>{}};

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

 function present(current:RigPlayer,seek=false):void {
  const name=current.current;
  const mapped=name&&Object.hasOwn(build.clipMap,name)?build.clipMap[name]:null;
  const clip=assets?.animations.find(animation=>animation.name===mapped)?.name??null;
  const unavailable=!!name&&!clip;
  if(missing.hidden===unavailable)missing.hidden=!unavailable;
  // A fresh player has no drawn pose. Clear installs setup and composes tracks,
  // so a player that presented setup must be replaced before single-track seeking.
  if(!player||(player.current===null)!==(clip===null)){
   player?.dispose();
   drawnGeneration=undefined;
   player=new RigPlayer(root,assets!);
  }
  if(!clip){
   if(drawnGeneration===undefined){player.clear();draw(player);}
   return;
  }
  const time=current.time,loop=current.entry(0)?.loop??false;
  const changed=player.current!==clip||player.entry(0)?.loop!==loop;
  if(!changed&&!seek&&Math.abs(player.time-time)<=1e-9)return;
  if(changed)player.play(clip,{loop});
  if(!changed||time!==0)player.seek(time);
  draw(player);
 }

 function draw(rig:RigPlayer):void {
  rig.draw();
  drawnGeneration=rig.generation;
 }

 function step(advance:(player:RigPlayer)=>void,held:boolean,timeScale:number):void {
  if(!player?.current)return;
  player.timeScale=timeScale;
  player.hold(held);
  player.resume();
  advance(player);
  draw(player);
 }

 function show(current:RigPlayer):void {
  // Prepare a successful first draw before making the alias or layout visible.
  present(current,true);
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

 return {load,show,hide,present,step,active:()=>active,
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
