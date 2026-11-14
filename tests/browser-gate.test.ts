import {expect,test} from 'bun:test';
import {partitionBrowserSuites,assertExclusionIssuesOpen,browserInvocation,browserPlan} from '../scripts/browser-gate.ts';
import exclusions from '../scripts/browser-exclusions.json';

test('every discovered nonexcluded browser goes to exactly one shard, including an unknown new filename',()=>{
 const files=['tests/known-browser.ts','tests/new-browser.ts','tests/held-browser.ts'];
 const plan=partitionBrowserSuites(files,{'tests/known-browser.ts':40},{'tests/held-browser.ts':{issue:843,reason:'regression'}},10);
 const assigned=plan.shards.flatMap(shard=>shard.suites);
 expect(assigned.sort()).toEqual(['tests/known-browser.ts','tests/new-browser.ts']);
 expect(plan.shards.find(shard=>shard.suites.includes('tests/new-browser.ts'))!.seconds).toBe(10);
 expect(()=>partitionBrowserSuites(files,{}, {'tests/absent-browser.ts':{issue:842,reason:'stale'}})).toThrow('BROWSER_EXCLUSION_INVALID');
 expect(()=>partitionBrowserSuites([...files,files[0]!])).toThrow('BROWSER_DUPLICATE_SUITE');
});
test('closed issue cannot silently retain an exclusion; ordinary test injects states and never calls GitHub',async()=>{
 const seen:number[]=[];
 await expect(assertExclusionIssuesOpen(exclusions,async issue=>{seen.push(issue);return 'closed';})).rejects.toThrow('BROWSER_EXCLUSION_ISSUE_NOT_OPEN: #843');
 expect(seen).toEqual([843]);
 await assertExclusionIssuesOpen(exclusions,async()=> 'open');
});
test('live tree partition has only the named regression exemption',async()=>{
 const plan=await browserPlan();
 expect(Object.keys(plan.exclusions)).toEqual(['tests/parts-comments-browser.ts']);
 expect(new Set(plan.shards.flatMap(shard=>shard.suites))).toEqual(new Set(plan.discovered.filter(file=>!Object.hasOwn(exclusions,file))));
});
test('suite argv uses supported output/locale contracts and enables assertions',()=>{
 const open=browserInvocation('tests/open-workspace-browser.ts','ko','/tmp/evidence');
 expect(open.argv).toEqual(['bun','tests/open-workspace-browser.ts','--lang','ko','--out','/tmp/evidence']);
 expect(open.env.NO_ASSERT).toBeUndefined();
 expect(browserInvocation('tests/chest-panel-browser.ts','default','/tmp/evidence').argv.slice(-2)).toEqual(['--shots','/tmp/evidence']);
 expect(browserInvocation('tests/inspection-clock-consumers-browser.ts','default','/tmp/evidence','/isolated').env.CLOCK_PRODUCER_BENCH).toBe('/isolated');
 expect(browserInvocation('tests/parts-explorer-browser.ts','default','/tmp/evidence').env.OUT_JSON).toBe('/tmp/evidence/report.json');
});
