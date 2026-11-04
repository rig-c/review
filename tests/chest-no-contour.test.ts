import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {bindChestEditor} from '../web/chest-editor.ts';
import {NO_CONTOUR_CODE,noContourReason,outcomeLine,reviewerRefusal,type RebuildStatusView} from '../web/rebuild-client.ts';
import {bindDomI18n,setLanguagePreference,tr} from '../web/i18n.ts';
import {configMeshes,contourParts} from '../src/rebuild.ts';

// #342: a config whose meshes are all `grid` entries is a valid handoff with nothing for the chest tools to rebuild.
const grid=(n:number)=>({grid:10+n,r:20,segments:[['chest',[400,200+n],[400,300+n]]]});
const gridOnly=JSON.stringify({key:'k',bones:[],meshes:Object.fromEntries(Array.from({length:7},(_,i)=>[`part${i}`,grid(i)]))});
const withContour=JSON.stringify({key:'k',bones:[],meshes:{torso:{contour:{tolerance:2,margin:2,spacing:28,maxEdge:45,stray:300,regions:[{name:'bust',shape:'circle',cx:414,cy:342,r:50,bone:'chest',spacing:13,band:30}]},r:15,segments:[['chest',[416,230],[416,600]]]},neck:grid(0)}});
const inputs={config:'config.json',parts:null,rig:null,configHash:'0'.repeat(64)};
/** The status fields the page reads, built by the server's own config readers (`src/rebuild.ts` describe()). */
const statusOf=(configText:string):Pick<RebuildStatusView,'inputs'|'parts'|'meshes'>=>({inputs,parts:contourParts(configText).map(({name,regions})=>({name,regions})),meshes:configMeshes(configText)});

/** The fake DOM `tests/chest-editor.test.ts` binds the editor against. */
function fakeDom(){
 const els=new Map<string,any>();
 const makeEl=(id:string)=>{
  const e:any={id,value:'',textContent:'',title:'',hidden:id==='chest-editor-bar',disabled:false,dataset:{},attrs:new Map<string,string>(),listeners:new Map<string,Function[]>(),classList:{toggle:()=>{}},setAttribute(k:string,v:string){this.attrs.set(k,v);},getAttribute(k:string){return this.attrs.get(k)??null;},removeAttribute(k:string){this.attrs.delete(k);},addEventListener(k:string,fn:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),fn]);},removeEventListener(){},dispatch(k:string,ev:any={}){for(const fn of this.listeners.get(k)??[])fn(ev);},querySelectorAll:()=>[],closest:()=>null,getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture(){},hasPointerCapture:()=>false,releasePointerCapture(){}};
  els.set(id,e);return e;
 };
 const getEl=(id:string)=>els.get(id)??makeEl(id);
 getEl('bust-mode').value='circles';
 return getEl;
}
function withEditor(run:(getEl:(id:string)=>any,editor:ReturnType<typeof bindChestEditor>,applied:()=>number)=>void){
 const getEl=fakeDom(),prev=[(globalThis as any).document,(globalThis as any).window,(globalThis as any).MutationObserver];
 (globalThis as any).document={getElementById:getEl,activeElement:null,addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]};
 (globalThis as any).window={addEventListener(){},removeEventListener(){}};
 (globalThis as any).MutationObserver=class{observe(){}disconnect(){}};
 let applies=0;
 try{
  const mapping={available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn'} as const;
  const editor=bindChestEditor({pane:getEl('rig-pane'),canvas:getEl('rig-overlay'),project:()=>null,mapping:()=>mapping as any,changed(){},download(){},apply(){applies++;},reset(){},message(){},inspector:()=>'rig'});
  try{run(getEl,editor,()=>applies);}finally{editor.dispose();}
 }finally{[(globalThis as any).document,(globalThis as any).window,(globalThis as any).MutationObserver]=prev;}
}
/** The bar, by name: on a grid-only config the chest toggle and Apply are disabled and each names the reason in its tooltip. */
function assertChestToolsDisabled(getEl:(id:string)=>any,reason:string):void {
 for(const id of ['chest-edit','bust-apply']){
  const button=getEl(id);
  if(!button.disabled)throw new Error(`CHEST_TOOL_ENABLED_WITHOUT_CONTOUR: #${id} is enabled on a config with no contour mesh`);
  if(button.title!==reason||button.getAttribute('aria-description')!==reason)throw new Error(`CHEST_TOOL_REASON_MISSING: #${id} does not name the reason`);
 }
}

test('#342 grid-only config: the reason is a statement about the rig, counts the config\'s meshes, keeps the code last, and reads in ko and en',()=>{
 const status=statusOf(gridOnly);
 expect(status.parts).toEqual([]);
 const reason=noContourReason(status)!;
 expect(reason.lines).toEqual([
  'This rig has no contour mesh. Chest regions and bust motion need the torso built as a contour mesh, which the builder declares in the config. Nothing is wrong with this rig.',
  'The config states 7 meshes, none of them contour: 7 grid',
  NO_CONTOUR_CODE,
 ]);
 expect(reason.text).toBe(reason.lines.join('\n'));
 // The count is read from the config, never written into the text: two more grid entries read 9.
 const nine=JSON.parse(gridOnly);nine.meshes.extra0=grid(7);nine.meshes.extra1={auto:{}};
 expect(noContourReason(statusOf(JSON.stringify(nine)))!.lines[1]).toBe('The config states 9 meshes, none of them contour: 8 grid, 1 auto');
 expect(noContourReason({inputs,parts:[],meshes:{}})!.lines[1]).toBe('The config states no meshes.');
 // en reads as written; ko translates every line and keeps the code on its own last line.
 expect(tr(reason.text,'en')).toBe(reason.text);
 const ko=tr(reason.text,'ko').split('\n');
 expect(ko).toEqual([
  '이 리그에는 윤곽(contour) 메시가 없습니다. 흉부 영역과 가슴 움직임은 몸통이 윤곽 메시로 만들어져 있어야 하며, 이는 빌더가 설정에서 선언합니다. 이 리그에는 문제가 없습니다.',
  '설정에 메시 7개가 선언되어 있으며 윤곽 메시는 없습니다: 7 grid',
  'REBUILD_INPUTS_UNAVAILABLE: 설정에 선언된 윤곽 메시가 없습니다',
 ]);
});

test('#342 grid-only config: the chest toggle and Apply are disabled before use and name the reason; a click does nothing',()=>withEditor((getEl,editor,applied)=>{
 const reason=noContourReason(statusOf(gridOnly))!.text;
 editor.unavailable(reason);
 assertChestToolsDisabled(getEl,reason);
 getEl('chest-edit').dispatch('click');getEl('bust-apply').dispatch('click');
 expect(editor.active()).toBe(false);expect(applied()).toBe(0);
 // A rebuild finishing elsewhere (rebuildState) does not re-enable Apply.
 editor.rebuildState({busy:false,applied:false});
 assertChestToolsDisabled(getEl,reason);
 // An editor open when the reason arrives closes.
 editor.unavailable(null);getEl('chest-edit').dispatch('click');expect(editor.active()).toBe(true);
 editor.unavailable(reason);expect(editor.active()).toBe(false);assertChestToolsDisabled(getEl,reason);
}));

test('#342 positive control: a config with a contour mesh leaves the chest tools as they were',()=>withEditor((getEl,editor,applied)=>{
 expect(noContourReason(statusOf(withContour))).toBeNull();
 // No handoff inputs: not this card's notice (the handoff reason stands).
 expect(noContourReason({inputs:null,parts:[],meshes:{}})).toBeNull();
 editor.unavailable(noContourReason(statusOf(withContour))?.text??null);
 editor.rebuildState({busy:false,applied:false});
 for(const id of ['chest-edit','bust-apply']){expect(getEl(id).disabled).toBe(false);expect(getEl(id).getAttribute('aria-description')).toBeNull();}
 expect(getEl('chest-edit').title).toBe('Place the two chest regions on the rig: drag a centre, the core edge or the band');
 expect(getEl('bust-apply').title).toBe('Run the installed producer (rig-parts remesh) on these regions or landmarks into a scratch build and load it here; the package is unchanged');
 getEl('chest-edit').dispatch('click');expect(editor.active()).toBe(true);
 getEl('bust-apply').dispatch('click');expect(applied()).toBe(1);
 // Busy still disables Apply as before.
 editor.rebuildState({busy:true,applied:false});expect(getEl('bust-apply').disabled).toBe(true);
}));

test('#345 the detail block\'s Markers button mirrors the toggle: off at bind, either button turns both on and off, and a grid-only config disables it with the reason shown',()=>withEditor((getEl,editor)=>{
 const pressed=()=>[getEl('chest-edit').getAttribute('aria-pressed'),getEl('chest-markers').getAttribute('aria-pressed')];
 expect(editor.active()).toBe(false);expect(getEl('chest-editor-bar').hidden).toBe(true);
 getEl('chest-markers').dispatch('click');expect(editor.active()).toBe(true);expect(pressed()).toEqual(['true','true']);
 getEl('chest-edit').dispatch('click');expect(editor.active()).toBe(false);expect(pressed()).toEqual(['false','false']);
 const reason=noContourReason(statusOf(gridOnly))!.text;
 editor.unavailable(reason);
 expect(getEl('chest-markers').disabled).toBe(true);expect(getEl('chest-markers').title).toBe(reason);expect(getEl('chest-markers').getAttribute('aria-description')).toBe(reason);
 expect(getEl('chest-unavailable').hidden).toBe(false);expect(getEl('chest-unavailable').textContent).toBe(reason);
 getEl('chest-markers').dispatch('click');expect(editor.active()).toBe(false);
 editor.unavailable(null);
 expect(getEl('chest-markers').disabled).toBe(false);expect(getEl('chest-markers').title).toBe('Draw the chest regions on the rig and edit them there; the same toggle as Chest regions in the view bar');
 expect(getEl('chest-unavailable').hidden).toBe(true);
}));

test('#345 both pages draw the chest overlay only while the toggle is on',async()=>{
 for(const file of ['../web/main.ts','../web/compare-picked-tools.ts']){
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  // The guard sits at the top of each overlay source, before anything is drawn.
  for(const name of ['chestRegions','chestCircles']){const at=source.indexOf(`function ${name}()`);expect(at).toBeGreaterThan(-1);expect(source.slice(at,at+260)).toMatch(/!chestEditor\?\.active\(\)\)\s*return \[\]/);}
  // The valid-designation fallback (drawn with the toggle off) is gone.
  expect(source).not.toContain('chestOverlayCircles(');
 }
});

/** Every rule of a sheet whose selector names the chest detail block (#345), in source order. */
function chestBlockRules(css:string):string[] {
 return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>/\.chest-(regions|head|markers|crop|label|unavailable|table|side|row|check|more|foot|contour)\b|#chest-(status|export)\b/.test(m[1]!)).map(m=>`${m[1]!.trim()}{${m[2]}}`);
}
test('#345 the compare page (served web/compare.css) carries the same chest block rules as web/styles.css',async()=>{
 const [main,compare]=await Promise.all(['styles.css','compare.css'].map(f=>readFile(new URL('../web/'+f,import.meta.url),'utf8')));
 const rules=chestBlockRules(main!);
 // The rules the new layout needs: one Markers state label at a time, the regions table, the crop pair, the one-row contour.
 for(const needle of ['.chest-markers[aria-pressed=true] .chest-markers-off,.chest-markers:not([aria-pressed=true]) .chest-markers-on{display:none}','.chest-table{','.chest-crop{','.chest-row{'])expect(rules.some(r=>r.startsWith(needle)||r.includes(needle))).toBe(true);
 expect(chestBlockRules(compare!)).toEqual(rules);
});

test('#342 planted control: a re-enabled button on a grid-only config fails the bar by name',()=>withEditor((getEl,editor)=>{
 const reason=noContourReason(statusOf(gridOnly))!.text;
 editor.unavailable(reason);
 getEl('bust-apply').disabled=false;
 expect(()=>assertChestToolsDisabled(getEl,reason)).toThrow('CHEST_TOOL_ENABLED_WITHOUT_CONTOUR: #bust-apply');
 getEl('bust-apply').disabled=true;getEl('chest-edit').disabled=false;
 expect(()=>assertChestToolsDisabled(getEl,reason)).toThrow('CHEST_TOOL_ENABLED_WITHOUT_CONTOUR: #chest-edit');
 getEl('chest-edit').disabled=true;getEl('chest-edit').title='';
 expect(()=>assertChestToolsDisabled(getEl,reason)).toThrow('CHEST_TOOL_REASON_MISSING: #chest-edit');
}));

test('#342 REBUILD_PART_NOT_CONTOUR reads as a statement about the rig first, the code below, in ko and en',()=>{
 const line='REBUILD_PART_NOT_CONTOUR: config meshes.neck is not a contour entry; regions apply to contour meshes only';
 const shown=outcomeLine({status:'refused',error:line,producerLine:null}).text;
 expect(shown).toBe(reviewerRefusal(line));
 expect(shown.split('\n')).toEqual(["This part is not a contour mesh, so chest regions and bust motion cannot be rebuilt on it. The builder chooses each part's mesh kind in the config. Nothing is wrong with this rig.",line]);
 expect(tr(shown,'ko').split('\n')).toEqual(['이 파츠는 윤곽(contour) 메시가 아니어서 흉부 영역과 가슴 움직임을 다시 빌드할 수 없습니다. 파츠마다 메시 종류는 빌더가 설정에서 정합니다. 이 리그에는 문제가 없습니다.','REBUILD_PART_NOT_CONTOUR: 설정 meshes.neck은(는) 윤곽 항목이 아닙니다. 영역은 윤곽 메시에만 적용됩니다']);
 // Other refusals stay verbatim.
 expect(reviewerRefusal('REBUILD_BUSY: an Apply is still running')).toBe('REBUILD_BUSY: an Apply is still running');
});

test('#342 both pages gate the chest editor on the same reason',async()=>{
 for(const file of ['../web/main.ts','../web/compare-picked-tools.ts']){
  const source=await readFile(new URL(file,import.meta.url),'utf8');
  expect(source).toMatch(/noContourReason\((rebuildStatus|status)\)/);
  expect(source).toMatch(/chestEditor\?\.unavailable\(noContour\?\.text\s*\?\?\s*null\)/);
 }
});

test('#342 aria-description follows the language: on a grid-only rig the toggle and Apply read the ko catalog, then en after a switch',()=>{
 // A DOM whose attributes are real attributes and whose MutationObserver delivers only what its attributeFilter names,
 // as a browser does; the i18n binding and the chest editor both observe through it.
 type Obs={cb:(records:unknown[])=>void;opts:{attributeFilter?:string[]}|null};
 const observers:Obs[]=[],els=new Map<string,any>();
 const makeEl=(id:string)=>{
  const attrs=new Map<string,string>();
  const notify=(name:string)=>{for(const o of observers)if(o.opts&&(!o.opts.attributeFilter||o.opts.attributeFilter.includes(name)))o.cb([{type:'attributes',target:e,attributeName:name}]);};
  const e:any={id,nodeType:1,tagName:'BUTTON',className:'',parentElement:null,value:'',textContent:'',hidden:id==='chest-editor-bar',disabled:false,dataset:{},listeners:new Map<string,Function[]>(),classList:{toggle:()=>{},contains:()=>false},
   get title(){return attrs.get('title')??'';},set title(v:string){attrs.set('title',v);notify('title');},
   setAttribute(k:string,v:string){attrs.set(k,v);notify(k);},getAttribute(k:string){return attrs.get(k)??null;},removeAttribute(k:string){attrs.delete(k);notify(k);},
   addEventListener(k:string,fn:Function){this.listeners.set(k,[...(this.listeners.get(k)??[]),fn]);},removeEventListener(){},dispatch(k:string,ev:any={}){for(const fn of this.listeners.get(k)??[])fn(ev);},
   querySelectorAll:()=>[],closest:()=>null,getBoundingClientRect:()=>({left:0,top:0}),setPointerCapture(){},hasPointerCapture:()=>false,releasePointerCapture(){}};
  els.set(id,e);return e;
 };
 const getEl=(id:string)=>els.get(id)??makeEl(id);
 getEl('bust-mode').value='circles';
 const root:any={nodeType:1,tagName:'HTML',lang:'en',className:'',parentElement:null,getAttribute:()=>null,querySelectorAll:()=>[getEl('chest-edit'),getEl('bust-apply')]};
 const doc:any={documentElement:root,getElementById:getEl,activeElement:null,addEventListener(){},removeEventListener(){},querySelectorAll:()=>[]};
 root.ownerDocument=doc;
 const prev=[(globalThis as any).document,(globalThis as any).window,(globalThis as any).MutationObserver];
 (globalThis as any).document=doc;(globalThis as any).window={addEventListener(){},removeEventListener(){}};
 (globalThis as any).MutationObserver=class{o:Obs;constructor(cb:(r:unknown[])=>void){this.o={cb,opts:null};observers.push(this.o);}observe(_t:unknown,opts:Obs['opts']){this.o.opts=opts;}disconnect(){this.o.opts=null;}};
 try{
  setLanguagePreference('en');bindDomI18n(doc);
  const editor=bindChestEditor({pane:getEl('rig-pane'),canvas:getEl('rig-overlay'),project:()=>null,mapping:()=>({available:false,reason:'CHEST_REGION_MAPPING_UNAVAILABLE: no compiled model drawn'}) as any,changed(){},download(){},apply(){},reset(){},message(){},inspector:()=>'rig'});
  try{
   const reason=noContourReason(statusOf(gridOnly))!.text,ko=tr(reason,'ko');
   expect(ko).not.toBe(reason);
   // Set ko, then the reason arrives (the page loads the status after the language is chosen).
   setLanguagePreference('ko');
   editor.unavailable(reason);
   for(const id of ['chest-edit','bust-apply']){expect(getEl(id).getAttribute('aria-description')).toBe(ko);expect(getEl(id).getAttribute('title')).toBe(ko);}
   // Switch to en: both update.
   setLanguagePreference('en');
   for(const id of ['chest-edit','bust-apply']){expect(getEl(id).getAttribute('aria-description')).toBe(reason);expect(getEl(id).getAttribute('title')).toBe(reason);}
   // And back to ko on a live switch, with the reason already shown.
   setLanguagePreference('ko');
   for(const id of ['chest-edit','bust-apply'])expect(getEl(id).getAttribute('aria-description')).toBe(ko);
  }finally{editor.dispose();}
 }finally{
  setLanguagePreference('en');
  [(globalThis as any).document,(globalThis as any).window,(globalThis as any).MutationObserver]=prev;
 }
});
