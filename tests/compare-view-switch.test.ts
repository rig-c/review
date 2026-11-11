import {test,expect} from 'bun:test';
import {compareViewModes,eligibilityViewSwitch,type ViewSwitchConfig} from '../web/view-controls.ts';
import {pairEligibility,pairLayouts,type InputState,type PairInputs} from '../src/comparison-eligibility.ts';
import {enCatalog} from '../web/catalog-en.ts';
import {koCatalog} from '../web/catalog-ko.ts';

const loaded:InputState={state:'loaded'};
const base:PairInputs={a:loaded,b:loaded,reference:loaded,domain:{end:2}};
const modes=(config:ViewSwitchConfig)=>config.groups.flatMap(group=>group.modes);
const reasonOf=(config:ViewSwitchConfig,id:string)=>modes(config).find(mode=>mode.id===id)?.disabledReason;
const pressed=(config:ViewSwitchConfig)=>modes(config).filter(mode=>mode.pressed).map(mode=>mode.id);
const compareViewSwitch=(state:ReturnType<typeof pairEligibility>,onChange?:(id:typeof state.requested)=>void)=>eligibilityViewSwitch(state,compareViewModes,onChange);
const build=(inputs:PairInputs)=>{const state=pairEligibility(inputs);return {state,config:compareViewSwitch(state)};};

test('one group in the order Side by side · Reference · A · B, covering every pair layout',()=>{
 const {config}=build(base);
 expect(config.groups).toHaveLength(1);
 expect(modes(config).map(mode=>[mode.id,mode.labelKey])).toEqual([['compare','Side by side'],['reference','Reference'],['a','Build A'],['b','Build B']]);
 expect(modes(config).map(mode=>mode.id).sort()).toEqual([...pairLayouts].sort());
});

test('mode labels are existing catalog keys in both languages',()=>{
 for(const [,key] of compareViewModes){expect(enCatalog[key]).toBeString();expect(koCatalog[key]).toBeString();}
});

test('every input usable: Side by side pressed and named, nothing disabled',()=>{
 for(const end of [2,0]){
  const {config}=build({...base,domain:{end}});
  expect(config.currentMode).toBe('compare');expect(pressed(config)).toEqual(['compare']);
  expect(modes(config).every(mode=>mode.disabledReason===undefined&&!('disabledReason' in mode))).toBe(true);
 }
});

test('a usable requested mode is pressed and named',()=>{
 for(const requested of pairLayouts){
  const {config}=build({...base,requested});
  expect(config.currentMode).toBe(requested);expect(pressed(config)).toEqual([requested]);
 }
});

const refusals:[string,InputState,string][]=[
 ['pending',{state:'pending'},'_PENDING: not rendered yet'],
 ['absent',{state:'absent'},'_ABSENT: not supplied'],
 ['failed',{state:'failed',reason:'decode error'},'_FAILED: decode error'],
 ['out-of-domain',{state:'out-of-domain',reason:'held time 9 s is outside'},'_OUT_OF_DOMAIN: held time 9 s is outside'],
];
for(const side of ['a','b'] as const)for(const [name,input,suffix] of refusals){
 test(`${side.toUpperCase()} ${name}: its mode and Side by side carry the existing reason; the survivor is shown`,()=>{
  const {state,config}=build({...base,[side]:input});
  const reason=`${side.toUpperCase()}${suffix}`;
  expect(reasonOf(config,side)).toBe(reason);expect(reasonOf(config,side)).toBe(state.reasons[side]!);
  expect(reasonOf(config,'compare')).toBe(reason);
  const other=side==='a'?'b':'a';
  expect(reasonOf(config,other)).toBeUndefined();expect(reasonOf(config,'reference')).toBeUndefined();
  expect(config.currentMode).toBe(other);expect(pressed(config)).toEqual([other]);
 });
}

const referenceSuffix:Record<string,string>={pending:'_PENDING: held time not decoded yet'};
for(const [name,input,suffix] of refusals){
 test(`reference ${name}: Reference and Side by side carry the existing reason; A is shown`,()=>{
  const {state,config}=build({...base,reference:input});
  const reason=`REFERENCE${referenceSuffix[name]??suffix}`;
  expect(reasonOf(config,'reference')).toBe(reason);expect(reasonOf(config,'reference')).toBe(state.reasons.reference!);
  expect(reasonOf(config,'compare')).toBe(reason);
  expect(reasonOf(config,'a')).toBeUndefined();expect(reasonOf(config,'b')).toBeUndefined();
  expect(config.currentMode).toBe('a');expect(pressed(config)).toEqual(['a']);
 });
}

const domains:[string,PairInputs['domain'],string][]=[
 ['pending',null,'DOMAIN_PENDING: shared domain not established'],
 ['refused',{refused:'clips disagree'},'DOMAIN_REFUSED: clips disagree'],
 ['non-finite end',{end:Number.NaN},'DOMAIN_REFUSED: shared end is not finite'],
 ['infinite end',{end:Number.POSITIVE_INFINITY},'DOMAIN_REFUSED: shared end is not finite'],
 ['negative end',{end:-1},'DOMAIN_REFUSED: shared end is not finite'],
];
for(const [name,domain,reason] of domains){
 test(`domain ${name}: only Side by side is disabled, with the existing reason`,()=>{
  const {state,config}=build({...base,domain});
  expect(reasonOf(config,'compare')).toBe(reason);expect(reasonOf(config,'compare')).toBe(state.reasons.compare!);
  for(const id of ['reference','a','b'])expect(reasonOf(config,id)).toBeUndefined();
  expect(config.currentMode).toBe('a');expect(pressed(config)).toEqual(['a']);
 });
}

test('several refusals join in Side by side and each side keeps its own',()=>{
 const {config}=build({a:{state:'failed',reason:'x'},b:loaded,reference:{state:'absent'},domain:null});
 expect(reasonOf(config,'compare')).toBe('A_FAILED: x · REFERENCE_ABSENT: not supplied');
 expect(reasonOf(config,'a')).toBe('A_FAILED: x');expect(reasonOf(config,'reference')).toBe('REFERENCE_ABSENT: not supplied');
 expect(reasonOf(config,'b')).toBeUndefined();expect(config.currentMode).toBe('b');
});

test('both builds refused: Reference is the fallback',()=>{
 const {config}=build({...base,a:{state:'absent'},b:{state:'pending'}});
 expect(config.currentMode).toBe('reference');expect(pressed(config)).toEqual(['reference']);
 expect(modes(config).filter(mode=>mode.disabledReason).map(mode=>mode.id)).toEqual(['compare','a','b']);
});

test('nothing drawable: no mode pressed, the requested mode is still named',()=>{
 for(const requested of [undefined,'b'] as const){
  const {state,config}=build({a:{state:'absent'},b:{state:'absent'},reference:{state:'pending'},domain:null,...requested?{requested}:{}});
  expect(state.effective).toBeNull();
  expect(config.currentMode).toBe(requested??'compare');expect(pressed(config)).toEqual([]);
  expect(modes(config).every(mode=>typeof mode.disabledReason==='string')).toBe(true);
 }
});

test('a refused requested mode falls back to the effective one, which is named and pressed',()=>{
 const {state,config}=build({...base,b:{state:'failed',reason:'y'},requested:'b'});
 expect(state.requested).toBe('b');expect(config.currentMode).toBe('a');expect(pressed(config)).toEqual(['a']);
 expect(reasonOf(config,'b')).toBe('B_FAILED: y');
});

test('onChange passes through only when supplied; the builder is pure',()=>{
 const state=pairEligibility(base),seen:string[]=[];
 expect('onChange' in compareViewSwitch(state)).toBe(false);
 const config=compareViewSwitch(state,id=>seen.push(id));config.onChange?.('b');expect(seen).toEqual(['b']);
 expect(compareViewSwitch(state)).toEqual(compareViewSwitch(state));expect(pairEligibility(base)).toEqual(state);
});

test('the generic builder serves any eligibility, e.g. rig single layouts',()=>{
 const config=eligibilityViewSwitch({requested:'compare',effective:'rig',reasons:{compare:'REFERENCE_ABSENT: not supplied',reference:'REFERENCE_ABSENT: not supplied'}},[['compare','Side by side'],['reference','Reference'],['rig','Rig']]);
 expect(config.currentMode).toBe('rig');expect(pressed(config)).toEqual(['rig']);
 expect(reasonOf(config,'reference')).toBe('REFERENCE_ABSENT: not supplied');expect(reasonOf(config,'rig')).toBeUndefined();
});
