import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {singleEligibility,pairEligibility,videoReferenceAt,singleLayouts,pairLayouts,type InputState,type PairDomain,type SingleLayout} from '../src/comparison-eligibility.ts';
import {controlComparison,parseControlComparison,parseControlInspection,type ControlInspection} from '../src/control.ts';

const states:InputState[]=[{state:'loaded'},{state:'pending'},{state:'absent'},{state:'failed',reason:'decoder refused'},{state:'out-of-domain',reason:'held 3 s outside 0–2 s'}];
const code=(name:string,input:InputState)=>input.state==='loaded'?null:`${name}_${input.state==='out-of-domain'?'OUT_OF_DOMAIN':input.state.toUpperCase()}`;
const roundTrip=(value:Parameters<typeof controlComparison>[0])=>{const wire=JSON.parse(JSON.stringify(controlComparison(value)));expect(parseControlComparison(wire)).toEqual(wire);};

test('single eligibility over every rig × reference × requested combination offers only actually loaded inputs',()=>{
 for(const rig of states)for(const reference of states)for(const requested of singleLayouts){
  const value=singleEligibility({rig,reference,requested}),rigOk=rig.state==='loaded',refOk=reference.state==='loaded';
  expect(value.usable).toEqual(singleLayouts.filter(layout=>layout==='compare'?rigOk&&refOk:layout==='rig'?rigOk:refOk));
  for(const layout of singleLayouts)expect(value.reasons[layout]===undefined).toBe(value.usable.includes(layout));
  const rigCode=code('RIG',rig),refCode=code('REFERENCE',reference);
  if(rigCode){expect(value.reasons.rig!.startsWith(rigCode)).toBe(true);expect(value.reasons.compare).toContain(rigCode);}
  if(refCode){expect(value.reasons.reference!.startsWith(refCode)).toBe(true);expect(value.reasons.compare).toContain(refCode);}
  const order:SingleLayout[]=requested==='reference'?['reference','rig']:['rig','reference'];
  expect(value.effective).toBe(value.usable.includes(requested)?requested:order.find(layout=>value.usable.includes(layout))??null);
  expect(value.requested).toBe(requested);expect(value.candidate).toEqual({state:'unavailable',reason:'no producer handoff'});
  roundTrip(value);
 }
});

test('pair eligibility over every A × B × reference × domain combination keeps the survivor and gates feedback and playback',()=>{
 const sides:InputState[]=[{state:'loaded'},{state:'pending'},{state:'failed',reason:'model page missing'}];
 const domains:PairDomain[]=[null,{end:2},{end:0},{end:Number.NaN},{refused:'compare reference duration: expected finite seconds >= 0'}];
 for(const a of sides)for(const b of sides)for(const reference of sides)for(const domain of domains){
  const value=pairEligibility({a,b,reference,domain}),all=[a,b,reference].every(input=>input.state==='loaded'),end=domain&&'end' in domain&&Number.isFinite(domain.end)?domain.end:null,pair=all&&end!==null;
  expect(value.usable).toEqual(pairLayouts.filter(layout=>layout==='compare'?pair:{a,b,reference}[layout].state==='loaded'));
  for(const layout of pairLayouts)expect(value.reasons[layout]===undefined).toBe(value.usable.includes(layout));
  expect(value.effective).toBe(pair?'compare':(['a','b','reference'] as const).find(layout=>value.usable.includes(layout))??null);
  expect(value.feedback).toBe(pair);expect(value.playback).toBe(pair&&end!>0);expect(value.static).toBe(pair&&end===0);
  for(const [name,input] of [['A',a],['B',b],['REFERENCE',reference]] as const){const c=code(name,input);if(c)expect(value.reasons.compare).toContain(c);}
  if(all&&!pair)expect(value.reasons.compare).toMatch(domain===null?/^DOMAIN_PENDING/:/^DOMAIN_REFUSED/);
  roundTrip(value);
 }
});

test('fixtures: source-only, rig-only, valid reference+rig, failed source, failed player, static comparison and refused candidate read back their effective view',()=>{
 const loaded={state:'loaded'} as const,absent={state:'absent'} as const;
 const sourceOnly=singleEligibility({rig:absent,reference:loaded,requested:'compare'});
 expect(sourceOnly).toMatchObject({effective:'reference',usable:['reference']});expect(sourceOnly.reasons.compare).toBe('RIG_ABSENT: not supplied');expect(sourceOnly.reasons.rig).toBe('RIG_ABSENT: not supplied');
 const rigOnly=singleEligibility({rig:loaded,reference:absent,requested:'compare'});
 expect(rigOnly).toMatchObject({effective:'rig',usable:['rig']});expect(rigOnly.reasons.compare).toBe('REFERENCE_ABSENT: not supplied');
 expect(singleEligibility({rig:loaded,reference:loaded,requested:'compare'})).toMatchObject({effective:'compare',usable:['compare','reference','rig'],reasons:{}});
 const failedSource=singleEligibility({rig:loaded,reference:{state:'failed',reason:'Reference image load failed'},requested:'reference'});
 expect(failedSource).toMatchObject({requested:'reference',effective:'rig'});expect(failedSource.reasons.reference).toBe('REFERENCE_FAILED: Reference image load failed');
 const failedPlayer=singleEligibility({rig:{state:'failed',reason:'Could not open rig: 404'},reference:loaded,requested:'rig'});
 expect(failedPlayer).toMatchObject({requested:'rig',effective:'reference'});expect(failedPlayer.reasons.compare).toBe('RIG_FAILED: Could not open rig: 404');
 const pending=singleEligibility({rig:loaded,reference:{state:'pending'},requested:'compare'});
 expect(pending.effective).toBe('rig');expect(pending.reasons.compare).toBe('REFERENCE_PENDING: held time not decoded yet');
 const outside=singleEligibility({rig:loaded,reference:videoReferenceAt(3,2),requested:'compare'});
 expect(outside.effective).toBe('rig');expect(outside.reasons.reference).toStartWith('REFERENCE_OUT_OF_DOMAIN: held time 3 s');
 expect(singleEligibility({rig:{state:'failed',reason:'x'},reference:{state:'failed',reason:'y'},requested:'compare'}).effective).toBe(null);
 const staticPair=pairEligibility({a:loaded,b:loaded,reference:loaded,domain:{end:0}});
 expect(staticPair).toMatchObject({effective:'compare',feedback:true,playback:false,static:true});
 const survivor=pairEligibility({a:{state:'failed',reason:'A: animation "walk" Not supplied'},b:loaded,reference:loaded,domain:null});
 expect(survivor).toMatchObject({effective:'b',feedback:false,playback:false});expect(survivor.reasons.compare).toBe('A_FAILED: A: animation "walk" Not supplied');
 for(const value of [sourceOnly,rigOnly,staticPair,survivor])expect(value.candidate).toEqual({state:'unavailable',reason:'no producer handoff'});
 const wire=controlComparison(survivor);
 expect(()=>parseControlComparison({...wire,candidate:{state:'available',reason:'no producer handoff'}})).toThrow('no candidate source exists');
 expect(()=>parseControlComparison({...wire,candidate:{state:'unavailable',reason:'no producer handoff',path:'candidate.json'}})).toThrow('unknown field');
});

test('video held time outside its real domain is refused by name, never clamped',()=>{
 expect(videoReferenceAt(0,2)).toEqual({state:'pending'});expect(videoReferenceAt(2,2)).toEqual({state:'pending'});expect(videoReferenceAt(0,0)).toEqual({state:'pending'});
 for(const held of [2.0001,-1,Number.NaN,Infinity])expect(videoReferenceAt(held,2).state).toBe('out-of-domain');
 for(const duration of [Number.NaN,Infinity,-1])expect(videoReferenceAt(0,duration).state).toBe('failed');
});

test('observed comparison is closed: requested, effective and reasons must agree with usable layouts',()=>{
 const valid=controlComparison(singleEligibility({rig:{state:'loaded'},reference:{state:'pending'},requested:'compare'}));
 expect(parseControlComparison(valid)).toEqual(valid);
 for(const bad of [
  {...valid,effectiveLayout:'compare'},{...valid,effectiveLayout:null},{...valid,effectiveLayout:'a'},{...valid,requestedLayout:'pair'},{...valid,mode:'other'},
  {...valid,usableLayouts:['rig','rig']},{...valid,usableLayouts:'rig'},{...valid,reasons:{...valid.reasons,rig:'not usable'}},{...valid,reasons:{compare:valid.reasons.compare}},
  {...valid,reasons:{...valid.reasons,compare:''}},{...valid,reasons:{...valid.reasons,compare:'x'.repeat(1025)}},{...valid,approved:true},
  {...valid,mode:'compare'},
 ])expect(()=>parseControlComparison(bad)).toThrow();
 const usableRequest=controlComparison(singleEligibility({rig:{state:'loaded'},reference:{state:'loaded'},requested:'reference'}));
 expect(()=>parseControlComparison({...usableRequest,effectiveLayout:'rig'})).toThrow('usable request is effective');
 const inspection:ControlInspection={theme:'system',layout:'auto',effectiveLayout:'row',cameras:{rig:{zoom:1,pan:{x:0,y:0}},reference:{zoom:1,pan:{x:0,y:0}}},animation:'idle',time:0,playing:false,loop:'off',layers:{images:true,meshes:false,bones:false},ready:true,seeking:false,dirty:false,busy:false,feedbackEligible:true,comparison:valid,capabilities:{camera:true,referenceCamera:false,animation:true,time:true,playback:true,layers:{images:true,meshes:true,bones:true}}};
 expect(parseControlInspection(inspection)).toEqual(inspection);
 expect(()=>parseControlInspection({...inspection,comparison:{...valid,effectiveLayout:'reference'}})).toThrow();
 const {comparison:_omitted,...legacy}=inspection;expect(parseControlInspection(legacy)).toEqual(legacy);
});

test('actual single video reference counts only after seeked at the held time with a decoded frame, and is never clamped',async()=>{
 const source=await readFile(new URL('../web/main.ts',import.meta.url),'utf8'),begin=source.indexOf('function setReferenceInput('),end=source.indexOf('function svgNode(',begin);if(begin<0||end<begin)throw new Error('single video reference boundary missing');
 class Media extends EventTarget {readyState=1;duration=2;position=0;seeks:number[]=[];get currentTime(){return this.position;}set currentTime(value:number){this.position=value;this.seeks.push(value);}settle(ready:number){this.readyState=ready;this.dispatchEvent(new Event('seeked'));}}
 const script=`function open(media){let time=0,referenceGeneration=1,video=media,referenceInput={state:'pending'};const messages=[];let renders=0;const message=(value,error)=>{messages.push(value);},renderLayout=()=>{renders++;};${source.slice(begin,end)};return {hold:at=>{time=at;holdVideoReference(media,referenceGeneration);},fail:()=>{referenceInput={state:'failed',reason:'decode'};},replace:()=>{referenceGeneration++;},state:()=>referenceInput,messages:()=>messages};}`;
 const transpiled=new Bun.Transpiler({loader:'ts',target:'bun'}).transformSync(script);
 type App={hold(at:number):void;fail():void;replace():void;state():InputState;messages():string[]};
 const media=new Media(),app=new Function('videoReferenceAt',transpiled+';return open;')(videoReferenceAt)(media) as App;
 app.hold(.5);expect(app.state()).toEqual({state:'pending'});expect(media.seeks).toEqual([.5]);
 media.settle(1);expect(app.state()).toEqual({state:'pending'});media.readyState=2;media.dispatchEvent(new Event('loadeddata'));expect(app.state()).toEqual({state:'loaded'});
 app.hold(3);expect(app.state().state).toBe('out-of-domain');expect(media.seeks).toEqual([.5]);expect(app.messages().at(-1)).toStartWith('REFERENCE_OUT_OF_DOMAIN: held time 3 s');
 const messages=app.messages().length;app.hold(3.5);expect(app.messages().length).toBe(messages);expect(media.seeks).toEqual([.5]);
 app.hold(1);expect(app.state()).toEqual({state:'pending'});expect(app.messages().at(-1)).toBe('Reference back in its domain at the held time.');app.hold(1.5);media.settle(2);expect(app.state()).toEqual({state:'loaded'});expect(media.seeks).toEqual([.5,1,1.5]);
 app.hold(1.75);expect(app.state()).toEqual({state:'loaded'});expect(media.seeks.at(-1)).toBe(1.75);
 app.hold(3);app.hold(1);app.replace();media.settle(2);expect(app.state()).toEqual({state:'pending'});
 app.fail();app.hold(1);expect(app.state()).toEqual({state:'failed',reason:'decode'});expect(media.seeks.at(-1)).toBe(1);
});
