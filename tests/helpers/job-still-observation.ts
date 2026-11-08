import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import type {JobRigCapture} from '../../src/job-contract.ts';
import type {InputCdpSession} from '../parts-explorer-browser.ts';

/** Test presentation only. Background declarations and model elements stay untouched. */
export async function admitStillOracle(page: InputCdpSession): Promise<unknown> {
    return page.evaluate(`(()=>{
        if(!globalThis.__jobStillObservation){
            const original=HTMLCanvasElement.prototype.toBlob;
            const saved=new Map();
            const box=node=>{
                const r=node.getBoundingClientRect(),s=getComputedStyle(node);
                const n=name=>parseFloat(s.getPropertyValue(name))||0;
                const border={left:n('border-left-width'),top:n('border-top-width'),right:n('border-right-width'),bottom:n('border-bottom-width')};
                const padding={left:n('padding-left'),top:n('padding-top'),right:n('padding-right'),bottom:n('padding-bottom')};
                const paddingBox={x:r.left+border.left,y:r.top+border.top,width:r.width-border.left-border.right,height:r.height-border.top-border.bottom};
                return {tag:node.tagName,id:node.id,className:node.getAttribute('class'),inlineStyle:node.getAttribute('style'),
                    rect:r.toJSON(),client:{left:node.clientLeft,top:node.clientTop,width:node.clientWidth,height:node.clientHeight},
                    border,padding,paddingBox,contentBox:{x:paddingBox.x+padding.left,y:paddingBox.y+padding.top,
                        width:paddingBox.width-padding.left-padding.right,height:paddingBox.height-padding.top-padding.bottom},
                    computed:{position:s.position,display:s.display,visibility:s.visibility,opacity:s.opacity,zIndex:s.zIndex,
                        filter:s.filter,transform:s.transform,transformOrigin:s.transformOrigin,
                        matrix:(()=>{const m=new DOMMatrix(s.transform);return {is2D:m.is2D,a:m.a,b:m.b,c:m.c,d:m.d,e:m.e,f:m.f}})(),
                        overflow:s.overflow,overflowX:s.overflowX,overflowY:s.overflowY,
                        borderRadius:s.borderRadius,borderTopLeftRadius:s.borderTopLeftRadius,borderTopRightRadius:s.borderTopRightRadius,
                        borderBottomLeftRadius:s.borderBottomLeftRadius,borderBottomRightRadius:s.borderBottomRightRadius,
                        borderColor:s.borderColor,background:Object.fromEntries([...s].filter(k=>k==='background'||k.startsWith('background-')).map(k=>[k,s.getPropertyValue(k)]))}};
            };
            const inventory=()=>{
                const pane=document.getElementById('rig-viewport'),root=document.getElementById('rig-root'),r=pane.getBoundingClientRect();
                return [...document.querySelectorAll('body *')].filter(node=>{
                    const a=node.getBoundingClientRect();return a.right>r.left&&a.left<r.right&&a.bottom>r.top&&a.top<r.bottom;
                }).map(node=>{
                    const value=box(node),s=value.computed;
                    const model=node===root||root.contains(node)||node.hasAttribute('data-job-rig-presentation'),ancestor=node===pane||node.contains(pane);
                    const knownUI=node.matches('.pane-label,#rig-overlay,#idle-handles,#rig-fields-stage,#rig-empty')||
                        !!node.closest('#idle-handles,#rig-fields-stage');
                    return {...value,model,ancestor,knownUI,painted:node.getClientRects().length>0&&s.display!=='none'&&s.visibility==='visible'&&Number(s.opacity)>0};
                });
            };
            const remember=node=>{
                if(!saved.has(node)){
                    const expectedAttribute=node.getAttribute('style'),expectedCssText=node.style.cssText;
                    saved.set(node,{tag:node.tagName,id:node.id,hidden:node.hidden,rect:node.getBoundingClientRect().toJSON(),
                        expectedAttribute,expectedCssText});
                }
            };
            const state={original,saved,box,inventory,askId:null,capture:null,
                apply(){
                    const before=inventory(),pane=document.getElementById('rig-viewport'),stage=pane.closest('.stage-pane');
                    for(const node of stage.querySelectorAll('.pane-label,#rig-overlay,#idle-handles,#rig-fields-stage,#rig-empty')){
                        remember(node);node.style.setProperty('visibility','hidden','important');
                    }
                    remember(stage);stage.style.setProperty('border-radius','0px','important');
                    const after=inventory();
                    const unexpected=after.filter(v=>v.painted&&!v.model&&!v.ancestor&&(v.knownUI||['absolute','fixed','sticky'].includes(v.computed.position)));
                    if(unexpected.length)throw new Error('JOB_STILL_ORACLE_UI_OVERLAP '+JSON.stringify(unexpected));
                    const prior=before.find(v=>v.id===stage.id),next=after.find(v=>v.id===stage.id);
                    if(JSON.stringify(prior.computed.background)!==JSON.stringify(next.computed.background))throw new Error('JOB_STILL_ORACLE_BACKGROUND_CHANGED');
                    return {before,after,savedStyles:[...saved.values()],presentation:'overlay-free square frame',backgroundUnchanged:true};
                }};
            HTMLCanvasElement.prototype.toBlob=function(...args){
                if(state.askId){
                    const askId=state.askId;state.askId=null;
                    const pane=document.getElementById('rig-viewport'),root=document.getElementById('rig-root');
                    const canonical=pane.querySelector('[data-job-rig-presentation]');
                    const layers=[];for(let node=pane;node;node=node.parentElement)layers.push(box(node));
                    state.capture={askId,metadata:{timestamp:performance.now(),dpr:devicePixelRatio,
                        animation:document.getElementById('job-animation').value,time:Number(document.getElementById('job-time').value),
                        pane:box(pane),root:box(root),canonical:canonical?{width:canonical.width,height:canonical.height,geometry:box(canonical)}:null,backgroundLayers:layers,overlappingElements:inventory()},
                        native:[...root.querySelectorAll('canvas')].map((canvas,index)=>({index,width:canvas.width,height:canvas.height,
                            geometry:box(canvas),png:canvas.toDataURL('image/png')})),
                        canonicalPng:canonical?.toDataURL('image/png'),copiedPng:this.toDataURL('image/png')};
                }
                return state.original.apply(this,args);
            };
            globalThis.__jobStillObservation=state;
        }
        return globalThis.__jobStillObservation.apply();
    })()`);
}

export async function armStillObservation(page: InputCdpSession, askId: string): Promise<void> {
    await page.evaluate(`(()=>{const s=globalThis.__jobStillObservation;s.capture=null;s.askId=${JSON.stringify(askId)}})()`);
}

export async function restoreStillOracle(page: InputCdpSession): Promise<{restored: boolean; elements: number; details: unknown[]}> {
    return page.evaluate(`(()=>{
        const s=globalThis.__jobStillObservation;if(!s)return {restored:true,elements:0,details:[]};
        HTMLCanvasElement.prototype.toBlob=s.original;
        for(const [node,snapshot]of s.saved){
            if(snapshot.expectedAttribute===null)node.removeAttribute('style');else node.setAttribute('style',snapshot.expectedAttribute);
        }
        const details=[...s.saved].map(([node,snapshot])=>{
            const actualAttribute=node.getAttribute('style'),actualCssText=node.style.cssText;
            const attributeAfterCssText=node.getAttribute('style');
            return {...snapshot,connected:node.isConnected,actualAttribute,actualCssText,
                attributeAfterCssText,attributeExact:actualAttribute===snapshot.expectedAttribute&&attributeAfterCssText===snapshot.expectedAttribute,cssTextExact:actualCssText===snapshot.expectedCssText};
        });
        const prototypeExact=HTMLCanvasElement.prototype.toBlob===s.original;
        const restored=prototypeExact&&details.every(row=>row.attributeExact&&row.cssTextExact);
        const result={restored,elements:s.saved.size,prototypeExact,details};s.restoreResult=result;
        if(restored)delete globalThis.__jobStillObservation;return result;
    })()`);
}

export async function persistStillObservation(page: InputCdpSession, output: string, name: string,
    askId: string, capture: JobRigCapture, exported: Buffer): Promise<void> {
    const observed = await page.evaluate<{askId: string; metadata: Record<string, unknown>;
        native: {index: number; width: number; height: number; geometry: unknown; png: string}[]; canonicalPng: string; copiedPng: string}>(
        'globalThis.__jobStillObservation.capture');
    assert.ok(observed, new Error('JOB_STILL_OBSERVATION_MISSING'));
    assert.equal(observed.askId, askId);
    assert.ok(observed.native.length > 0, new Error('JOB_STILL_NATIVE_CANVAS_MISSING'));
    const native = [];
    for (const canvas of observed.native) {
        const bytes = Buffer.from(canvas.png.split(',')[1]!, 'base64');
        const file = name + '-native-' + canvas.index + '.png';
        await writeFile(join(output, file), bytes);
        native.push({...canvas, png: undefined, path: file,
            sha256: createHash('sha256').update(bytes).digest('hex')});
    }
    assert.ok(observed.canonicalPng, new Error('JOB_STILL_CANONICAL_CANVAS_MISSING'));
    const canonical = Buffer.from(observed.canonicalPng.split(',')[1]!, 'base64');
    await writeFile(join(output, name + '-canonical.png'), canonical);
    const copied = Buffer.from(observed.copiedPng.split(',')[1]!, 'base64');
    await writeFile(join(output, name + '-copied-at-encode.png'), copied);
    const first = PNG.sync.read(copied), final = PNG.sync.read(exported), displayed = PNG.sync.read(canonical);
    assert.equal(displayed.width, first.width);
    assert.equal(displayed.height, first.height);
    const canonicalEqualsCopy = displayed.data.equals(first.data);
    assert.equal(first.width, final.width);
    assert.equal(first.height, final.height);
    const copiedEqualsExport = first.data.equals(final.data);
    await writeFile(join(output, name + '-draw-metadata.json'), JSON.stringify({
        ...observed.metadata, askId, native, canonicalEqualsCopy, copiedEqualsExport,
        canonicalPngSha256: createHash('sha256').update(canonical).digest('hex'),
        copiedPngSha256: createHash('sha256').update(copied).digest('hex'),
        actualRequest: {...capture, png: undefined},
        timing: 'Synchronous encoder entry after production pixel copy, before asynchronous toBlob encoding',
    }, null, 2));
    assert.ok(canonicalEqualsCopy, new Error('JOB_STILL_CANONICAL_COPY_MISMATCH'));
    assert.ok(copiedEqualsExport, new Error('JOB_STILL_FROZEN_COPY_EXPORT_MISMATCH'));
}
