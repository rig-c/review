// Bound by the browser harness to EACH selected app's own unchanged capture module.
// @ts-ignore test-only virtual build import
import {paintInspectionViewport} from '@viewport-387-capture';
(globalThis as any).__viewport387Capture=(view:any)=>{
 const pair=document.getElementById('stage-layout')!;
 const dom={html:pair.outerHTML,elements:[pair,...pair.querySelectorAll('*')].map(node=>{const style=getComputedStyle(node),r=node.getBoundingClientRect();return {tag:node.tagName,attrs:[...node.attributes].map(a=>[a.name,a.value]),rect:{x:r.x,y:r.y,width:r.width,height:r.height},computed:[...style].map(key=>[key,style.getPropertyValue(key)])};})};
 const pixels:any={};
 for(const key of ['rig','reference']){
  const pane=document.getElementById(key+'-viewport')!,camera=view.cameras[key];if(!camera)throw Error('Missing actual camera '+key);
  const root=key==='rig'?document.getElementById('rig-root')!:undefined,canvas=root?.querySelector('canvas')??undefined,media=key==='reference'?pane.querySelector('img')??undefined:undefined;
  if(key==='rig'&&(!canvas||root!.querySelectorAll('img,canvas').length!==1))throw Error('Oracle requires the public single-mesh fixture and a real live canvas');
  const composed=document.createElement('canvas');composed.width=pane.clientWidth;composed.height=pane.clientHeight;
  paintInspectionViewport(composed.getContext('2d')!,{x:0,y:0,width:composed.width,height:composed.height},{pane,root,canvas,images:true,backend:'canvas2d'},{camera,media});
  const bytes=composed.getContext('2d')!.getImageData(0,0,composed.width,composed.height).data;let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  pixels[key]={width:composed.width,height:composed.height,rgba:btoa(binary)};
 }
 return {dom,pixels};
};
