import {expect,test} from 'bun:test';
import {selectAnimation,animationDiagnostic,initialPlayerAnimation} from '../src/animation-selection.ts';
import {initialReviewSelection} from '../src/open-selection.ts';
import {parseOpenInputs} from '../src/cli.ts';
import {RigPlayer,loadModel} from '@rig-c/play';
import {readFile} from 'node:fs/promises';
const source=(label:string,names:string[]|null,animation?:string,path='report.json')=>({label,catalog:{animations:names?.map(name=>({name,duration:1}))??null},report:animation===undefined?null:{animation,path}});
test('explicit name wins; normalized agreeing or one-sided reports precede only actual unique clips',()=>{
 const a=source('a',['idle','dance'],'dance'),b=source('b',['idle','dance'],'idle','reports/pose.json');
 expect(selectAnimation([a,b],'idle')?.source).toBe('cli');expect(()=>selectAnimation([a,b],'missing')).toThrow('a.animation: model has no animation "missing"');
 expect(()=>selectAnimation([a,b])).toThrow('conflicting report animations');
 expect(selectAnimation([a,source('b',['idle','dance'])])).toEqual({name:'dance',source:'report',reportPaths:['report.json']});
 expect(animationDiagnostic(selectAnimation([a,source('b',['idle','dance'],'dance')])!)).toBe('animation: dance (from report.json)');
 expect(animationDiagnostic(selectAnimation([source('single',['dance'],'dance','reports/pose.json')])!)).toBe('animation: dance (from reports/pose.json)');
 expect(()=>selectAnimation([a,source('b',['idle'])])).toThrow('b.animation: model has no animation "dance"');
 expect(selectAnimation([source('a',['idle','dance']),source('b',['dance'])])?.name).toBe('dance');
 expect(()=>selectAnimation([source('single',['idle','dance'])],undefined,true)).toThrow('model animations: idle, dance');
 expect(()=>selectAnimation([source('a',['idle']),source('b',['dance'])])).toThrow('common animations: (none)');
});
test('source-only and static inspection remain honest; provided stale clip is never hidden by fallback',()=>{
 expect(selectAnimation([source('single',null,'dance')],undefined,true)).toBeNull();expect(selectAnimation([source('single',[])],undefined,true)).toBeNull();
 expect(()=>selectAnimation([source('single',null)],'dance',true)).toThrow('validation unavailable');
 expect(()=>selectAnimation([source('single',[],'dance')],undefined,true)).toThrow('no animation "dance"');
 expect(selectAnimation([source('single',['only'])],undefined,true)).toEqual({name:'only',source:'unique'});
 expect(()=>selectAnimation([source('single',['dance'])],' ',true)).toThrow('nonempty');
 for(const name of ['--format','--help','--'])expect(parseOpenInputs(['producer','--animation',name]).animation).toBe(name);
 expect(()=>parseOpenInputs(['producer','--animation'])).toThrow('Missing value');
});
test('selected clip skips incompatible automatic checkpoint; explicit/manual checkpoint and later selections win',()=>{
 const manifest={references:[],checkpoints:[{id:'idle',title:'Idle',animation:'idle',time:.75,axis:{id:'look',value:2}}]};
 expect(initialReviewSelection(manifest,null,undefined,'dance').checkpoint).toBeUndefined();
 const explicit=initialReviewSelection(manifest,'idle',undefined,'dance');expect(explicit.checkpoint?.time).toBe(.75);expect(explicit.updateUrl).toBe(true);
 expect(initialPlayerAnimation(['idle','dance'],'dance')).toBe('dance');expect(initialPlayerAnimation(['idle','dance'],'dance',explicit.checkpoint)).toBe('idle');
 expect(initialPlayerAnimation(['idle','dance'],'dance',{animation:'idle'})).toBe('idle');expect(()=>initialPlayerAnimation(['idle'],'dance')).toThrow('initial.animation');
 const generic={references:[],checkpoints:[{id:'default',title:'Default',time:.75}]};expect(initialReviewSelection(generic,null,undefined,'dance').checkpoint).toBeUndefined();
 expect(initialReviewSelection({...manifest,checkpoints:[{id:'dance',title:'Dance',animation:'dance',time:.2}]},null,undefined,'dance').checkpoint?.time).toBe(.2);
});
test('the runtime init selection actually plays the report clip instead of the first idle entry',async()=>{
 const document=JSON.parse(await readFile(new URL('./fixtures/compare-probe/skeleton.model.json',import.meta.url),'utf8'));const actual=document.animations[0];document.animations=[{...actual,name:'idle'},{...actual,name:'dance'}];document.editorOrder.animations=['idle','dance'];
 const assets=await loadModel({modelUrl:'http://fixture.invalid/skeleton.model.json',setsUrl:null,fetch:new Proxy(fetch,{apply:()=>Promise.resolve(new Response(JSON.stringify(document)))})});
 const player=new RigPlayer({style:{clipPath:''}} as unknown as HTMLElement,assets,{meshBackend:'canvas2d'});
 try{const selected=selectAnimation([source('single',assets.animations.map(item=>item.name),'dance')],undefined,true)!,name=initialPlayerAnimation(assets.animations.map(item=>item.name),selected.name)!;player.play(name,{loop:false});player.pause();player.seek(.25);player.draw();expect(player.current).toBe('dance');expect(player.time).toBeCloseTo(.25,12);player.play(initialPlayerAnimation(assets.animations.map(item=>item.name),selected.name,{animation:'idle'})!,{loop:false});expect(player.current).toBe('idle');}
 finally{player.dispose();assets.dispose();}
});


test('compatible automatic axis preserves the complete checkpoint while mismatched or unavailable bindings are skipped',()=>{
 const point={id:'dance-review',title:'Review this pose',animation:'dance',time:.4,axis:{id:'look',value:.25},reference:'source',camera:{zoom:2,x:10,y:20},workspace:'modeling' as const,note:'Retain this checkpoint context'};
 const manifest={references:[{id:'source',label:'Source',type:'image' as const,path:'source.png'},{id:'explicit',label:'Explicit',type:'video' as const,path:'selected.mp4'}],axes:[{id:'look',label:'Look',animation:'dance',min:-1,max:1}],checkpoints:[point]};
 const compatible=initialReviewSelection(manifest,null,undefined,'dance');expect(compatible.checkpoint).toBe(point);expect(compatible.checkpoint).toMatchObject({id:'dance-review',time:.4,axis:{id:'look',value:.25},camera:{zoom:2,x:10,y:20},workspace:'modeling',note:'Retain this checkpoint context'});expect(compatible.referenceId).toBe('source');expect(compatible.updateUrl).toBe(false);
 const explicitReference=initialReviewSelection(manifest,null,'explicit','dance');expect(explicitReference.checkpoint).toBe(point);expect(explicitReference.referenceId).toBe('explicit');
 const wrongAxis={...manifest,axes:[{...manifest.axes[0]!,animation:'idle'}]};expect(initialReviewSelection(wrongAxis,null,undefined,'dance').checkpoint).toBeUndefined();
 expect(initialReviewSelection({...manifest,axes:[]},null,undefined,'dance').checkpoint).toBeUndefined();
 const {axes,...missingAxes}=manifest;expect(initialReviewSelection(missingAxes,null,undefined,'dance').checkpoint).toBeUndefined();
 expect(initialReviewSelection({...manifest,checkpoints:[{...point,axis:{id:'missing',value:0}}]},null,undefined,'dance').checkpoint).toBeUndefined();
 expect(initialReviewSelection({...manifest,checkpoints:[{...point,animation:'idle'}]},null,undefined,'dance').checkpoint).toBeUndefined();
 expect(initialReviewSelection({...manifest,checkpoints:[{...point,animation:undefined}]},null,undefined,'dance').checkpoint).toBeUndefined();
 const requested=initialReviewSelection(wrongAxis,point.id,'explicit','dance');expect(requested.checkpoint).toBe(point);expect(requested.referenceId).toBe('source');expect(requested.updateUrl).toBe(true);
 expect(initialReviewSelection(manifest,null).checkpoint).toBe(point);
});
