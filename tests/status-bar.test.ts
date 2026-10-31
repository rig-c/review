import {test,expect} from 'bun:test';
import {readFile} from 'node:fs/promises';
/** #74: the footer's height must not depend on its text. Per-frame readouts (renderer label, layer state)
 * grow and shrink; a wrapping footer moved the stage bottom by one text line several times a second. */
const rule=(css:string,selector:string)=>{const m=css.match(new RegExp('(?:^|[}\\s])'+selector.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\{([^}]*)\\}'));return m?m[1]!:null;};
test('footer height is fixed and its readouts never wrap',async()=>{
 const css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 const footer=rule(css,'footer');expect(footer).not.toBeNull();
 expect(footer).toContain('flex-wrap:nowrap');expect(footer).toMatch(/(^|;)height:\d+px/);expect(footer).toContain('overflow:hidden');
 const readouts=rule(css,'.status-readouts');expect(readouts).not.toBeNull();expect(readouts).toContain('flex-wrap:nowrap');
 const each=rule(css,'.status-readouts>*');expect(each).not.toBeNull();expect(each).toContain('white-space:nowrap');expect(each).toContain('text-overflow:ellipsis');
 for(const block of css.matchAll(/@media[^{]*\{((?:[^{}]*\{[^}]*\})*)\}/g)){const inner=rule(block[1]!,'footer');if(inner)expect(inner).not.toMatch(/flex-wrap:wrap|height:auto/);}
});

test('#232: compare .pane-foot, .pane-head and footer have fixed single-line heights and tabular-nums time readouts',async()=>{
 const compareCss=await readFile(new URL('../web/compare.css',import.meta.url),'utf8');
 for(const selector of ['.pane-foot','.pane-head','footer']){
  const body=rule(compareCss,selector);expect(body).not.toBeNull();
  expect(body).toContain('flex-wrap:nowrap');expect(body).toMatch(/(^|;)height:\d+px/);expect(body).toContain('overflow:hidden');
  for(const block of compareCss.matchAll(/@media[^{]*\{((?:[^{}]*\{[^}]*\})*)\}/g)){const inner=rule(block[1]!,selector);if(inner)expect(inner).not.toMatch(/flex-wrap:wrap|height:auto/);}
 }
 for(const selector of ['.pane-foot>*','.pane-head>span','footer>*']){
  const body=rule(compareCss,selector);expect(body).not.toBeNull();
  expect(body).toContain('white-space:nowrap');expect(body).toContain('overflow:hidden');expect(body).toContain('text-overflow:ellipsis');
 }
 const times=rule(compareCss,'#reference-time,#a-time,#b-time');expect(times).not.toBeNull();
 expect(times).toContain('font-variant-numeric:tabular-nums');expect(times).toMatch(/(^|;)width:\d+ch/);expect(times).toContain('flex:none');
 expect(rule(compareCss,'.transport output')).toContain('font-variant-numeric:tabular-nums');
 const singleCss=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 const stageFoot=rule(singleCss,'.stage-footer');expect(stageFoot).not.toBeNull();
 expect(stageFoot).toContain('flex-wrap:nowrap');expect(stageFoot).toMatch(/(^|;)height:\d+px/);expect(stageFoot).toContain('overflow:hidden');
 expect(rule(singleCss,'.stage-footer>*')).toContain('text-overflow:ellipsis');
 expect(rule(singleCss,'.transport output')).toContain('font-variant-numeric:tabular-nums');
 expect(rule(singleCss,'.zoom-controls output')).toContain('font-variant-numeric:tabular-nums');
 const compareTs=await readFile(new URL('../web/compare.ts',import.meta.url),'utf8');
 for(const id of ['reference-time','a-time','b-time','a-frame','b-frame','a-renderer','b-renderer','message'])expect(compareTs).toContain(`'${id}'`);
 expect(compareTs).toContain('if (titledIds.has(id)) node.title = value;');
});
