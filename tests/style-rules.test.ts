import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {cssRules} from './theme.test';

type Declaration={property:string;value:string};
type Exception={selector:string;property:string;value:string;reason:string};
/** Exceptions bind one declaration, never an entire selector or a class substring. */
export const styleExceptions:readonly Exception[]=[
 {selector:'.tool',property:'height',value:'auto',reason:'A tool row grows when its label wraps; min-height remains 32px.'},
 {selector:'.checkpoint',property:'height',value:'auto',reason:'Question and status text must fit the checkpoint row above its 32px minimum.'},
 {selector:'.report-event-list button',property:'height',value:'auto',reason:'Content fills its report row, rather than acting as a fixed toolbar control; min-height is 32px.'},
 {selector:'.stage-comment-item>button:first-child',property:'height',value:'auto',reason:'A multiline comment grows from 32px instead of clipping the reviewer text.'},
 {selector:'.interview-question',property:'height',value:'auto',reason:'A complete survey question can wrap above the 32px minimum.'},
 {selector:'.owner-list button',property:'height',value:'auto',reason:'An owner target row includes title and metadata above its 32px minimum.'},
 {selector:'.physics-row-pick',property:'height',value:'auto',reason:'The source-named text link can wrap above its 24px minimum.'},
 {selector:'.readings-go',property:'height',value:'auto',reason:'A source reading text link can wrap above its 24px minimum.'},
 {selector:'.idle-handle',property:'margin',value:'-7px 0 0 -7px',reason:'Centers the 14px world-space handle on the source point.'},
 {selector:'.rig-fields-handle',property:'margin',value:'-7px 0 0 -7px',reason:'Centers the 14px source-field handle on the source point.'},
 {selector:'.idle-blink-marker',property:'margin-left',value:'-7px',reason:'Centers the 14px blink glyph on the time coordinate.'},
 {selector:'.reading-tick',property:'margin-left',value:'-1px',reason:'Centers the 3px evidence tick on the frame coordinate.'},
 {selector:'.animation-key',property:'padding',value:'0 2px',reason:'Horizontal inset inside the small key glyph only.'},
 {selector:'.parts-explorer li button',property:'height',value:'36px',reason:'Uniform thumbnail list row: 24px image with 4px insets and a border.'},
 {selector:'.parts-explorer li button',property:'min-height',value:'36px',reason:'Keeps the thumbnail row at the same list density.'},
 {selector:'.parts-explorer li button',property:'max-height',value:'36px',reason:'Prevents the single-line thumbnail row from growing.'},
 {selector:'.animation-lane-label',property:'height',value:'22px',reason:'Selection label shares the existing lane coordinate system.'},
 {selector:'.animation-lane-add',property:'height',value:'16px',reason:'The add glyph must fit inside the unchanged 22px lane.'},
 {selector:'.animation-key',property:'height',value:'22px',reason:'Key hit box shares the lane and playhead geometry.'},
 {selector:'.reading-tick',property:'height',value:'6px',reason:'Frame-positioned evidence mark, not a toolbar button.'},
 {selector:'.idle-blink-marker',property:'height',value:'12px',reason:'Time-positioned blink glyph in the transport strip.'},
 {selector:'.idle-handle',property:'height',value:'14px',reason:'World-space handle paired with the -7px centering margin.'},
 {selector:'.rig-fields-handle',property:'height',value:'14px',reason:'World-space handle paired with the -7px centering margin.'},
 {selector:'.animation-bone-pick',property:'height',value:'10px',reason:'Stage bone-point pick; enlarging it changes overlapping targets.'},
 {selector:'.layer-toggle input',property:'height',value:'1px',reason:'Clipped native checkbox; the visible label is the 24px control.'},
];
const declarations=(body:string):Declaration[]=>body.split(';').filter(d=>d.trim()).map(d=>{
 const i=d.indexOf(':');if(i<0)throw new Error('Malformed declaration: '+d);
 return {property:d.slice(0,i).trim().toLowerCase(),value:d.slice(i+1).trim()};
});
/** Commas in :is/:where/:has or attribute values are not selector separators. */
function selectors(source:string):string[]{
 let depth=0,start=0;const result:string[]=[];
 for(let i=0;i<source.length;i++){
  if(source[i]==='('||source[i]==='[')depth++;
  if(source[i]===')'||source[i]===']')depth--;
  if(source[i]===','&&!depth){result.push(source.slice(start,i).trim());start=i+1;}
 }
 result.push(source.slice(start).trim());return result;
}
const spacing=/^(?:(?:margin|padding)(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|gap|row-gap|column-gap)$/;
const root=(s:string)=>/^:root(?:\[data-theme=(?:dark|light)\])?$/.test(s);
const normalise=(v:string)=>v.replace(/\s*!important\s*$/i,'').trim();
const sizes=new Set([11,12,13,14,16]);
const weights:Record<string,string>={'--font-weight-regular':'400','--font-weight-medium':'500','--font-weight-emphasis':'600'};
function control(selector:string):boolean{
 if(selector.includes('::'))return false;
 const functional=selector.match(/:(?:is|where)\(/);
 if(functional?.index!==undefined){
  const start=functional.index+functional[0].length;let depth=1,end=start;
  for(;end<selector.length&&depth;end++){if(selector[end]==='(')depth++;if(selector[end]===')')depth--;}
  if(!depth)return selectors(selector.slice(start,end-1)).some(arm=>control(selector.slice(0,functional.index)+arm+selector.slice(end)));
 }
 // Inspect the subject, not a parent button's label or the word "button" in a class.
 const subject=selector.replace(/:(?:is|where|not|has)\([^)]*\)/g,'').split(/[\s>+~]+/).at(-1)??'';
 return /^(?:button|input|select|summary)(?=$|[.#[:])/.test(subject)
  ||/^\.(?:layer-toggle|view-tool|workspace-tabs-more|settings-toggle|stage-comment-pin|animation-lane-label|animation-lane-add|animation-key|reading-tick|idle-blink-marker|idle-handle|rig-fields-handle|animation-bone-pick|tool|checkpoint|interview-question|physics-row-pick|readings-go)(?=$|[.#[:])/.test(subject)
  ||/^#(?:workspace-bottom-collapse|play)$/.test(subject)||/\[role=['"]?tab['"]?\]/.test(subject);
}
function resolve(value:string,tokens:Map<string,string>,seen:string[]=[]):string{
 return value.replace(/var\(\s*(--[\w-]+)\s*\)/g,(_,name:string)=>{
  if(seen.includes(name))throw new Error('Token cycle: '+[...seen,name].join(' -> '));
  const v=tokens.get(name);if(v===undefined)throw new Error('Undefined token: '+name);
  return resolve(v,tokens,[...seen,name]);
 });
}
function validSpacing(value:string):boolean{
 // Closed arithmetic prevents calc(4px / 2) or fallbacks hiding off-grid values.
 return value.replace(/calc\(-1 \* (\d+(?:\.\d+)?)px\)/g,'-$1px').split(/\s+/).every(v=>
  ['0','auto','normal'].includes(v)||/^-?\d+(?:\.\d+)?px$/.test(v)&&Number(v.slice(0,-2))%4===0);
}
function fontSize(property:string,value:string):number|undefined{
 if(property==='font-size')return /^\d+(?:\.\d+)?px$/.test(value)?Number(value.slice(0,-2)):undefined;
 const m=value.match(/^(?:(?:normal|italic|oblique|small-caps|400|500|600)\s+)*(\d+(?:\.\d+)?)px(?:\/[^\s]+)?\s+.+$/);
 return m?Number(m[1]):undefined;
}
const literalColour=/#(?:[\da-f]{3,8})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i;
const colourProperty=/^(?:color|background(?:-color|-image)?|(?:border|outline)(?:-(?:top|right|bottom|left|block|inline))?(?:-color)?|fill|stroke|box-shadow|text-shadow|accent-color|caret-color|column-rule(?:-color)?|text-decoration(?:-color)?)$/;
const colourKeywords=new Set(['transparent','currentcolor','inherit','initial','unset','revert','none','solid','dashed','dotted','double','inset','outset','groove','ridge','hidden','auto','radial-gradient','linear-gradient','ellipse','circle','at','to','left','right','top','bottom','center']);
/** Compare declared tokens, not an overlay that could hide a missing light declaration. */
export function styleTokenBlocks(source:string):{dark:Record<string,string>;light:Record<string,string>}{
 const dark:Record<string,string>={},light:Record<string,string>={};
 for(const r of cssRules(source).filter(r=>root(r.selector)&&!r.at.length))
  for(const d of declarations(r.body))if(d.property.startsWith('--'))(r.selector===':root[data-theme=light]'?light:dark)[d.property]=d.value;
 return {dark,light};
}
/** Pure input makes isolated planted violations possible without editing live CSS. */
export function styleRuleViolations(source:string):string[]{
 const issues:string[]=[];let rules:ReturnType<typeof cssRules>;
 try{rules=cssRules(source);}catch(error){return [String(error)];}
 const blocks=styleTokenBlocks(source),dark=new Map(Object.entries(blocks.dark)),light=new Map(Object.entries(blocks.light));
 const report=(scheme:string,selector:string,d:Declaration,reason:string)=>issues.push(scheme+': '+selector+' { '+d.property+': '+d.value+' } '+reason);
 for(const [scheme,tokens] of [['dark',dark],['light',new Map([...dark,...light])]] as const){
  // Validate definitions even when unused; aliases resolve transitively in each theme.
  for(const [name,value] of tokens){
   if(!/^--(?:space-|control-|font-size-|font-weight-|radius(?:-|$))/.test(name))continue;
   try{
    const v=resolve(value,tokens);
    if(name.startsWith('--space-')&&!validSpacing(v))throw new Error('off-grid spacing token');
    if(name.startsWith('--control-')&&!['24px','32px'].includes(v))throw new Error('control token outside 24/32px');
    if(name.startsWith('--font-size-')&&!(sizes.has(Number(v.slice(0,-2)))&&/^\d+px$/.test(v)||name==='--font-size-wordmark'&&v==='18px'))throw new Error('font token outside scale');
    if(name.startsWith('--font-weight-')&&!(weights[name]?weights[name]===v:['400','500','600'].includes(v)))throw new Error('weight token outside its named role');
    if(name.startsWith('--radius')&&!['4px','6px','8px'].includes(v))throw new Error('radius token outside scale');
   }catch(error){report(scheme,':root',{property:name,value},String(error));}
  }
  for(const r of rules)for(const d of declarations(r.body)){
   if(root(r.selector)&&d.property.startsWith('--'))continue;
   if(d.property.startsWith('--'))report(scheme,r.selector,d,'policy aliases belong in root token blocks; local overrides require an explicit contract');
   const raw=normalise(d.value),relevant=spacing.test(d.property)||/^font(?:-size|-weight)?$/.test(d.property)||/^(?:min-|max-)?(?:height|block-size)$/.test(d.property)||d.property==='border-radius';
   let value=raw;
   if(relevant)try{value=resolve(raw,tokens);}catch(error){report(scheme,r.selector,d,String(error));continue;}
   for(const selector of selectors(r.selector)){
    const exception=styleExceptions.find(e=>e.selector===selector&&e.property===d.property&&e.value===raw);
    if(spacing.test(d.property)&&!exception&&!validSpacing(value))report(scheme,selector,d,'spacing outside 4px grid');
    if(d.property==='font-size'||d.property==='font'){
     const size=fontSize(d.property,value);
     const wordmark=size===18&&selector==='.brand'&&raw==='var(--font-size-wordmark)';
     if(value!=='inherit'&&(!size||!sizes.has(size)&&!wordmark))report(scheme,selector,d,'font outside scale; named 18px token is wordmark only');
     if(d.property==='font'&&/^(?:400|500|600)\s/.test(value)&&!/^var\(--font-weight-(?:regular|medium|emphasis)\)\s/.test(raw))report(scheme,selector,d,'shorthand weight must use its named token');
    }
    if(d.property==='font-weight'&&!['400','500','600','normal','inherit'].includes(value))report(scheme,selector,d,'weight outside 400/500/600');
    if(d.property==='font-weight'&&!['normal','inherit'].includes(raw)&&!/^var\(--font-weight-(?:regular|medium|emphasis)\)$/.test(raw))report(scheme,selector,d,'weight must use its named token');
    if(/^(?:min-|max-)?(?:height|block-size)$/.test(d.property)&&control(selector)&&!exception){
     const coarse=r.at.some(at=>/^@media\s*\(pointer:\s*coarse\)$/.test(at));
     const coarseMinimum=coarse&&d.property==='min-height'&&(selector==='button'&&value==='44px'||selector==='.workspace-drawer-triggers button'&&value==='40px');
     if(!['24px','32px'].includes(value)&&!coarseMinimum)report(scheme,selector,d,'control outside 24/32px');
    }
    if(d.property==='border-radius'&&!['0','50%','4px','6px','8px'].includes(value))report(scheme,selector,d,'radius outside 4/6/8px or round');
   }
   if(!root(r.selector)){
    const withoutStrings=raw.replace(/(["'])(?:\\.|(?!\1).)*?\1/g,'');
    // Keep fallback words visible, including named colours in nested var() calls.
    const tokenless=withoutStrings.replace(/var\s*\(/g,'').replace(/--[\w-]+/g,'');
    const named=colourProperty.test(d.property)&&tokenless.replace(/-?(?:\d*\.)?\d+(?:[a-z%]+)?/gi,'').match(/[a-z][a-z-]*/gi)?.some(w=>!colourKeywords.has(w.toLowerCase()));
    if(literalColour.test(withoutStrings)||named)report(scheme,r.selector,d,'literal colour outside root tokens');
    if(relevant&&/\\/.test(raw))report(scheme,r.selector,d,'escaped policy expression is not approved');
   }
  }
 }
 return issues;
}
const read=(file:string)=>readFile(new URL('../web/'+file,import.meta.url),'utf8');
for(const file of ['styles.css','compare.css'])test(file+' follows the approved spacing, control, type, radius and colour roles',async()=>{
 expect(styleRuleViolations(await read(file))).toEqual([]);
});
test('both serving stylesheets declare identical tokens in each theme',async()=>{
 const [main,compare]=await Promise.all(['styles.css','compare.css'].map(read));
 expect(styleTokenBlocks(compare!)).toEqual(styleTokenBlocks(main!));
});
test('isolated planted violations cover longhands, shorthands, aliases and custom controls',()=>{
 const cases=[
  '.x{padding-inline-start:3px}','.x{margin-block-end:6px}','.x{column-gap:10px}',
  ':root{--odd:3px}.x{gap:var(--odd)}',':root{--space-new:3px}',
  ':root{--a:var(--b);--b:26px}button{height:var(--a)}',':root{--control-new:26px}',
  ':root{--font-size-new:15px}','.x{font:500 10px/1.5 sans-serif}','.x{font-size:18px}',
  '.x{font-size:.8rem}','.x{font-weight:700}','.x{padding:calc(4px / 2)}',
  '.x{padding:var(--missing,3px)}','summary{height:26px}','.layer-toggle{height:26px}',
  '.view-tool{height:26px}','[role=tab]{height:26px}','.workspace-tabs-more{height:26px}',
  '.x{padding:2px}','button{gap:2px}','.x{border-radius:7px}',
  '.x{color:red}','.x{border:1px solid #fff}','.x{color:rgb(0 0 0)}',
  '.x{color:hsl(0 0% 0%)}',':root[data-theme=light]{--space-1:3px}',
  '.idle-handle{padding:3px}','.animation-key{height:23px}',
  ':where(button){height:25px}',':root{--a:4px}.x{--a:3px;padding:var(--a)}',
  '.x{color:var(--a,red)}',
  'button{height:auto}','button{max-height:none}','button{min-height:0}',
  ':root{--font-weight-regular:500}',':root{--font-weight-new:700}',
  '.brand{font-size:18px}',
 ];
 for(const css of cases)expect(styleRuleViolations(css),css).not.toEqual([]);
});
test('geometry exceptions allow only the exact reasoned declaration',()=>{
 for(const e of styleExceptions)expect(styleRuleViolations(e.selector+'{'+e.property+':'+e.value+'}'),e.reason).toEqual([]);
 expect(styleRuleViolations('.another-handle{margin:-7px 0 0 -7px}')).not.toEqual([]);
 expect(styleRuleViolations('.animation-key{padding:0 2px;gap:2px}')).not.toEqual([]);
 expect(styleRuleViolations(':root{--font-size-wordmark:18px}.brand{font-size:var(--font-size-wordmark)}.x{font:13px/1.5 sans-serif}')).toEqual([]);
 expect(styleRuleViolations(':root{--a:var(--b);--b:4px}.x{padding-inline:var(--a)}')).toEqual([]);
});
