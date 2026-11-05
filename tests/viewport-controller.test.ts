import {expect,test} from 'bun:test';
import {createViewportController,createViewportState,type ViewportProvider} from '../web/viewport-controller.ts';
import {unprojectMark} from '../src/stage-comment.ts';
import {viewportPairMarkup,expandViewportPair,viewportPairPlaceholder} from '../web/viewport-pair.ts';
function host(){
 const nodes=new Map<string,any>();for(const target of ['rig','reference']){nodes.set(target+'-viewport',{clientWidth:640,clientHeight:480});nodes.set(target+'-pane',{hidden:false});}
 const state=createViewportState();let renders=0;
 const provider:ViewportProvider={el:(id:string)=>nodes.get(id),geometry:target=>({space:target==='rig'?'world':'image',box:{x:0,y:0,width:320,height:240},marginX:0,marginY:0}),layoutKey:()=>[...nodes.values()].map(n=>n.clientWidth??n.hidden).join(','),render:()=>{renders++;},renderControls:()=>{},selection:()=>({selected:false,bounds:null}),message:()=>{}};
 return {nodes,state,controller:createViewportController(provider,state),renders:()=>renders};
}
test('#387 provider boundary keeps cursor anchor, shared state and hidden frame behavior without a runtime model',()=>{
 const h=host(),c=h.controller;c.fitCamera();const point={x:113,y:207},before=unprojectMark(point,c.numericView().cameras.rig!);c.zoomViewport('rig',-1,point);const after=unprojectMark(point,c.numericView().cameras.rig!);expect(after.x).toBeCloseTo(before.x,12);expect(after.y).toBeCloseTo(before.y,12);expect(c.state).toBe(h.state);
 c.setCameraSync(false);const ref=structuredClone(c.paneCamera('reference'));c.panCamera('rig',64,-48);expect(c.paneCamera('reference')).toEqual(ref);const held=c.paneFrame('rig');h.nodes.get('rig-pane').hidden=true;expect(c.paneFrame('rig')).toBeNull();expect(c.paneFrame('rig',true)).toBe(held);expect(h.renders()).toBeGreaterThan(0);
});
test('#387 pair expansion preserves the exact subtree instead of maintaining another markup copy',()=>{const shell='<div id="stage-layout" class="stages">'+viewportPairPlaceholder+'</div>';expect(expandViewportPair(shell)).toBe('<div id="stage-layout" class="stages">'+viewportPairMarkup+'</div>');expect(viewportPairMarkup.match(/id="rig-viewport"/g)).toHaveLength(1);expect(viewportPairMarkup.match(/id="reference-viewport"/g)).toHaveLength(1);});
