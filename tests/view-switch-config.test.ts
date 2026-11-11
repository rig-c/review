import {readFileSync} from 'node:fs';
import {createRigViewControls} from './helpers/rig-view-controls.ts';
import {expect,test} from 'bun:test';
import {createViewControls,compareViewModes,eligibilityViewSwitch,type ViewSwitchConfig} from '../web/view-controls.ts';
import {pairEligibility} from '../src/comparison-eligibility.ts';
import {getLanguagePreference,setLanguagePreference,t} from '../web/i18n.ts';

/** Numeric DOM host: no browser, layout or rendering claims. */
class ControlNode {
 id='';className='';textContent='';dataset:Record<string,string>={};children:(ControlNode|string)[]=[];
 attrs=new Map<string,string>();disabled=false;title='';open=false;onclick:(()=>void)|null=null;
 constructor(readonly tagName:string){}
 append(...children:(ControlNode|string)[]){this.children.push(...children);}
 setAttribute(key:string,value:string){this.attrs.set(key,value);}
 removeAttribute(key:string){this.attrs.delete(key);}
 getAttribute(key:string){return this.attrs.get(key)??null;}
}
function withControls(run:()=>void){
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document'),language=getLanguagePreference();
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:(tag:string)=>new ControlNode(tag)}});
 try{run();}finally{
  if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else Reflect.deleteProperty(globalThis,'document');
  setLanguagePreference(language);
 }
}
function menu(config?:ViewSwitchConfig){
 const controls=config?createViewControls({layout:'rigStep1',viewSwitch:config}):createRigViewControls();
 const root=controls.viewSwitch as unknown as ControlNode;
 const summary=root.children[0] as ControlNode,list=root.children[1] as ControlNode;
 return {controls,root,summary,label:summary.children[1] as ControlNode,list,buttons:list.children.filter((node):node is ControlNode=>typeof node!=='string'&&node.tagName==='button')};
}
function partsConfig(hidden=false,onChange?:(id:string)=>void):ViewSwitchConfig{
 return {currentMode:'part',onChange,groups:[{modes:[
  {id:'assembled',labelKey:'Assembled',pressed:false},
  {id:'part',labelKey:'Part',pressed:true},
  {id:'overlay',labelKey:'Overlay',pressed:false},
  {id:'difference',labelKey:'Difference',pressed:false,disabledReason:t('Difference unavailable')},
 ]},{hidden,modes:[{id:'region',labelKey:'Region',pressed:true},{id:'pages',labelKey:'Pages',pressed:false}]}]};
}

for(const language of ['en','ko'] as const){
 test(`#677 ${language}: rig retains ids, order, aria and localized text`,()=>withControls(()=>{
  setLanguagePreference(language);
  const {controls,root,summary,label,list,buttons}=menu();
  const group=controls.zoomGroup as unknown as ControlNode;
  expect(group.children.map(node=>(node as ControlNode).id)).toEqual(['zoom-in','zoom-out','fit','native-one','view-menu','zoom-value']);
  expect(group.className).toBe('zoom-controls');expect(root.id).toBe('view-menu');expect(root.className).toBe('view-menu');
  expect(summary.getAttribute('aria-label')).toBe(t('View layout'));expect(summary.children[0]).toBe(t('View switch')+' ');
  expect(label.id).toBe('view-menu-label');expect(label.textContent).toBe(t('Side by side'));
  expect(list.getAttribute('role')).toBe('group');expect(list.getAttribute('aria-label')).toBe(t('View'));
  expect(buttons.map(button=>button.dataset.view)).toEqual(['compare','reference','rig']);
  expect(buttons.map(button=>button.textContent)).toEqual(['Side by side','Reference','Rig'].map(key=>t(key)));
  expect(buttons.map(button=>button.getAttribute('aria-pressed'))).toEqual(['true','false','false']);
  expect(buttons.every(button=>!button.disabled&&button.title==='')).toBe(true);
 }));
 test(`#677 ${language}: parts configuration orders six modes, separates groups and names disabled reason`,()=>withControls(()=>{
  setLanguagePreference(language);
  const {list,buttons,label}=menu(partsConfig());
  expect(list.children.map(node=>(node as ControlNode).dataset.view??(node as ControlNode).tagName)).toEqual(['assembled','part','overlay','difference','hr','region','pages']);
  expect((list.children[4] as ControlNode as unknown as {role:string}).role).toBe('separator');
  expect(buttons.map(button=>button.textContent)).toEqual(['Assembled','Part','Overlay','Difference','Region','Pages'].map(key=>t(key)));
  expect(buttons.map(button=>button.getAttribute('aria-pressed'))).toEqual(['false','true','false','false','true','false']);
  expect(buttons[3]!.disabled).toBe(true);expect(buttons[3]!.title).toBe(t('Difference unavailable'));
  expect(buttons[3]!.getAttribute('aria-description')).toBe(t('Difference unavailable'));expect(label.textContent).toBe(t('Part'));
  const hidden=menu(partsConfig(true));expect(hidden.buttons.map(button=>button.dataset.view)).toEqual(['assembled','part','overlay','difference']);
  expect(hidden.list.children.some(node=>(node as ControlNode).tagName==='hr')).toBe(false);
 }));
}

for(const language of ['en','ko'] as const)test(`#696 ${language}: compare eligibility renders through the shared switch with its existing reasons`,()=>withControls(()=>{
 setLanguagePreference(language);
 const state=pairEligibility({a:{state:'loaded'},b:{state:'failed',reason:'decode error'},reference:{state:'loaded'},domain:{end:2},requested:'b'});
 const {buttons,label}=menu(eligibilityViewSwitch(state,compareViewModes));
 expect(buttons.map(button=>button.dataset.view)).toEqual(['compare','reference','a','b']);
 expect(buttons.map(button=>button.textContent)).toEqual(['Side by side','Reference','Build A','Build B'].map(key=>t(key)));
 expect(buttons.map(button=>button.getAttribute('aria-pressed'))).toEqual(['false','false','true','false']);
 expect(label.textContent).toBe(t('Build A'));
 expect(buttons.map(button=>button.disabled)).toEqual([true,false,false,true]);
 expect(buttons[0]!.title).toBe(state.reasons.compare!);expect(buttons[3]!.title).toBe('B_FAILED: decode error');
 expect(buttons[3]!.getAttribute('aria-description')).toBe('B_FAILED: decode error');
}));

test('#677 mode selection notifies once, closes the switch, updates summary and preserves the other group',()=>withControls(()=>{
 const changes:string[]=[],config=partsConfig(false,id=>changes.push(id)),{root,label,buttons}=menu(config);
 root.open=true;buttons[2]!.onclick!();
 expect(changes).toEqual(['overlay']);expect(root.open).toBe(false);expect(label.textContent).toBe(t('Overlay'));
 expect(buttons.map(button=>button.getAttribute('aria-pressed'))).toEqual(['false','false','true','false','true','false']);
 buttons[3]!.onclick!();expect(changes).toEqual(['overlay']);expect(label.textContent).toBe(t('Overlay'));
 buttons[5]!.onclick!();expect(changes).toEqual(['overlay','pages']);expect(label.textContent).toBe(t('Pages'));
 expect(buttons[2]!.getAttribute('aria-pressed')).toBe('true');expect(buttons[4]!.getAttribute('aria-pressed')).toBe('false');
 expect(config.groups[0]!.modes[1]!.pressed).toBe(true); // Configuration is not mutated.
}));

test('#677 hidden modes and empty groups introduce no orphan separators',()=>withControls(()=>{
 const config=partsConfig();
 config.groups=[{modes:[]},{modes:[{id:'hidden',labelKey:'Rig',pressed:false,hidden:true}]},...config.groups,{modes:[]}];
 const {list,buttons}=menu(config);
 expect(buttons.map(button=>button.dataset.view)).toEqual(['assembled','part','overlay','difference','region','pages']);
 expect(list.children.filter(node=>(node as ControlNode).tagName==='hr')).toHaveLength(1);
}));

test('#677 runtime mode updates use configured labels without notifying, including unavailable effective input',()=>withControls(()=>{
 const changes:string[]=[],{controls,label,buttons,root}=menu(partsConfig(false,id=>changes.push(id)));
 root.open=true;controls.setMode('overlay');
 expect(label.textContent).toBe(t('Overlay'));expect(root.open).toBe(true);expect(changes).toEqual([]);
 expect(buttons.map(button=>button.getAttribute('aria-pressed'))).toEqual(['false','false','true','false','true','false']);
 controls.setMode(null,'part');expect(label.textContent).toBe(t('Part'));
 expect(buttons.every(button=>button.getAttribute('aria-pressed')==='false')).toBe(true);
 controls.setMode('missing');expect(label.textContent).toBe(t('Part'));expect(changes).toEqual([]);
 controls.setMode('pages');expect(label.textContent).toBe(t('Pages'));expect(buttons[5]!.getAttribute('aria-pressed')).toBe('true');
}));

test('#677 runtime Difference refusal can be cleared, re-enabled and selected with one callback',()=>withControls(()=>{
 const changes:string[]=[],{controls,label,buttons}=menu(partsConfig(false,id=>changes.push(id))),difference=buttons[3]!;
 controls.setDisabled('difference',null);
 expect(difference.disabled).toBe(false);expect(difference.title).toBe('');expect(difference.getAttribute('aria-description')).toBeNull();
 difference.onclick!();expect(changes).toEqual(['difference']);expect(label.textContent).toBe(t('Difference'));
 const reason=t('Difference unavailable');controls.setDisabled('difference',reason);
 expect(difference.disabled).toBe(true);expect(difference.title).toBe(reason);expect(difference.getAttribute('aria-description')).toBe(reason);
 difference.onclick!();expect(changes).toEqual(['difference']);controls.setDisabled('missing',reason);
 controls.setMode('part');expect(label.textContent).toBe(t('Part'));expect(changes).toEqual(['difference']);
}));

for(const language of ['en','ko'] as const)test(`#736 Amendment 1 ${language}: actual rig refresh keeps original names, legacy ids and named layout refusals`,()=>withControls(()=>{
 setLanguagePreference(language);
 const source=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
 const start=source.indexOf('function renderLayout():void {'),end=source.indexOf('function setReferenceInput(',start);
 const {controls,buttons,label}=menu(),panes=new Map<string,{hidden:boolean}>();
 let state:{requested:string;effective:string|null;reasons:Record<string,string>}={requested:'compare',effective:'rig',reasons:{compare:'REFERENCE_ABSENT: not supplied',reference:'REFERENCE_ABSENT: not supplied'}};
 const call=new Bun.Transpiler({loader:'ts'}).transformSync('let effectiveView;'+source.slice(start,end)+';return renderLayout;');
 const render=new Function('layoutEligibility','controls','el','text','fitCamera',call)(()=>state,controls,(id:string)=>{if(!panes.has(id))panes.set(id,{hidden:false});return panes.get(id);},()=>{},()=>{}) as ()=>void;
 render();expect(label.textContent).toBe(t('Rig'));expect(controls.viewModeIds).toEqual(['compare','reference','rig']);
 expect(buttons.map(button=>button.disabled)).toEqual([true,true,false]);
 expect(buttons[1]!.title).toBe(state.reasons.reference!);expect(buttons[1]!.getAttribute('aria-description')).toBe(state.reasons.reference!);
 expect(panes.get('reference-pane')!.hidden).toBe(true);expect(panes.get('rig-pane')!.hidden).toBe(false);
 state={requested:'compare',effective:'compare',reasons:{}};render();
 expect(buttons.every(button=>!button.disabled)).toBe(true);expect(label.textContent).toBe(t('Side by side'));
 expect(buttons.map(button=>button.textContent)).toEqual(['Side by side','Reference','Rig'].map(key=>t(key)));
 const changes:string[]=[],live=createRigViewControls(id=>changes.push(id));
 const root=live.viewSwitch as unknown as ControlNode,list=root.children[1] as ControlNode;
 root.open=true;(list.children[2] as ControlNode).onclick!();expect(changes).toEqual(['rig']);expect(root.open).toBe(false);
}));

test('#677 production view-state writes stay in the shared constructor and rig configuration is required',()=>{
 const source=readFileSync(new URL('../web/main.ts',import.meta.url),'utf8');
 expect(source).not.toContain('[data-view]');expect(source).not.toContain('view-menu-label');expect(source).not.toContain('menuLabels');
 // CI's typecheck proves that the rig layout cannot omit its screen configuration.
 if(false){
  // @ts-expect-error rigStep1 requires viewSwitch.
  createViewControls({layout:'rigStep1'});
 }
});
