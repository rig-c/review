import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';

/** One leaf rule: the at-rule preludes around it, its selector and its declarations. */
interface Rule {at:string[];selector:string;body:string}

/** Small CSS tokenizer: strips comments and strings-free braces into leaf rules with their enclosing at-rule preludes. */
export function cssRules(source:string):Rule[] {
 const css=source.replace(/\/\*[\s\S]*?\*\//g,''),rules:Rule[]=[],stack:string[]=[];let start=0;
 for(let i=0;i<css.length;i++){
  const ch=css[i];
  if(ch==='{'){stack.push(css.slice(start,i).trim());start=i+1;}
  else if(ch==='}'){
   const prelude=stack.pop();if(prelude===undefined)throw new Error(`unbalanced } at ${i}`);
   const body=css.slice(start,i);if(!body.includes('{')&&!prelude.startsWith('@'))rules.push({at:[...stack],selector:prelude,body});
   start=i+1;
  }
 }
 if(stack.length)throw new Error('unbalanced {');
 return rules;
}

const literal=/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const tokenBlock=(rule:Rule)=>/^:root(\[data-theme=(dark|light)\])?$/.test(rule.selector.trim());
const schemeMedia=(rule:Rule)=>rule.at.some(at=>/^@media\s*\(\s*prefers-color-scheme\b/.test(at));
const declarations=(body:string)=>body.split(';').map(d=>d.trim()).filter(Boolean).map(d=>{const at=d.indexOf(':');return {name:d.slice(0,at).trim(),value:d.slice(at+1).trim()};});
const defined=(rules:Rule[],selector:string)=>new Set(rules.filter(r=>r.selector.trim()===selector&&!r.at.length).flatMap(r=>declarations(r.body)).filter(d=>d.name.startsWith('--')).map(d=>d.name));

export function literalColoursOutsideTokens(source:string):string[] {
 return cssRules(source).filter(r=>!tokenBlock(r)&&!schemeMedia(r)).flatMap(r=>declarations(r.body).filter(d=>literal.test(d.value)).map(d=>`${r.selector.trim()} { ${d.name}: ${d.value} }`));
}
export function undefinedTokens(source:string):string[] {
 const rules=cssRules(source),roots=new Set(rules.filter(tokenBlock).flatMap(r=>declarations(r.body)).filter(d=>d.name.startsWith('--')).map(d=>d.name));
 // Set at runtime by workspace-ui on the layout element, not a theme token.
 const runtime=new Set(['--workspace-columns']);
 const used=new Set([...source.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/var\(\s*(--[\w-]+)/g)].map(m=>m[1]!));
 return [...used].filter(name=>!roots.has(name)&&!runtime.has(name)).sort();
}
export function schemeTokenDifference(source:string):{darkOnly:string[];lightOnly:string[]} {
 const rules=cssRules(source),dark=defined(rules,':root'),light=defined(rules,':root[data-theme=light]');
 return {darkOnly:[...dark].filter(n=>!light.has(n)&&!/^--(font-|radius)/.test(n)).sort(),lightOnly:[...light].filter(n=>!dark.has(n)).sort()};
}

for(const file of ['styles.css','compare.css']){
 const read=()=>readFile(new URL('../web/'+file,import.meta.url),'utf8');
 test(`${file}: no literal colour outside the :root token blocks`,async()=>{expect(literalColoursOutsideTokens(await read())).toEqual([]);});
 test(`${file}: every var(--x) is defined in a :root block of the same file`,async()=>{expect(undefinedTokens(await read())).toEqual([]);});
 test(`${file}: dark (:root) and light (:root[data-theme=light]) define the same colour tokens`,async()=>{
  const source=await read(),diff=schemeTokenDifference(source);expect(diff).toEqual({darkOnly:[],lightOnly:[]});
  expect(defined(cssRules(source),':root[data-theme=light]').size).toBeGreaterThan(20);
 });
}

test('the tokenizer sees literals in rules and ignores token blocks, scheme media and id selectors',()=>{
 const css=':root{--a:#fff}:root[data-theme=light]{--a:#000}@media (prefers-color-scheme: light){:root{--a:#111}}#abc{color:var(--a)}@media(max-width:5px){.x{border:1px solid rgb(1,2,3)}}';
 expect(literalColoursOutsideTokens(css)).toEqual(['.x { border: 1px solid rgb(1,2,3) }']);
 expect(undefinedTokens(css+'.y{color:var(--b)}')).toEqual(['--b']);
 expect(schemeTokenDifference(':root{--a:#fff;--b:#fff}:root[data-theme=light]{--a:#000}')).toEqual({darkOnly:['--b'],lightOnly:[]});
});
