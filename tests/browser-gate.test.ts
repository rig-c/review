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
 const issues=[843,847,848,842];
 for(const closed of issues){
  const seen:number[]=[];
  await expect(assertExclusionIssuesOpen(exclusions,async issue=>{seen.push(issue);return issue===closed?'closed':'open';})).rejects.toThrow('BROWSER_EXCLUSION_ISSUE_NOT_OPEN: #'+closed);
  expect(seen).toEqual(issues.slice(0,issues.indexOf(closed)+1));
 }
 const openSeen:number[]=[];
 await assertExclusionIssuesOpen(exclusions,async issue=>{openSeen.push(issue);return 'open';});
 expect(openSeen).toEqual(issues);
});
test('live tree partition covers every discovered suite once or by its named exemption',async()=>{
 const plan=await browserPlan();
 expect(Object.fromEntries(Object.entries(plan.exclusions).map(([file,entry])=>[file,entry.issue]))).toEqual({
  "tests/parts-comments-browser.ts": 843,
  "tests/stage1-corrections-browser.ts": 847,
  "tests/stage1-review-fixes-browser.ts": 847,
  "tests/job-checkpoint-evidence-browser.ts": 848,
  "tests/correction-handoff-browser.ts": 842,
  "tests/inspection-bookmark-time-browser.ts": 842,
  "tests/inspection-clock-consumers-browser.ts": 842,
  "tests/job-checkpoint-wire-browser.ts": 842,
  "tests/job-record-browser.ts": 842,
  "tests/open-workspace-browser.ts": 842,
  "tests/parts-setup-browser.ts": 842,
  "tests/rig-bottom-browser.ts": 842,
  "tests/stage3-framing-browser.ts": 842
});
 const assigned=plan.shards.flatMap(shard=>shard.suites);
 const omitted=Object.keys(exclusions);
 const expected=plan.discovered.filter(file=>!Object.hasOwn(exclusions,file));
 expect(new Set(assigned).size).toBe(assigned.length);
 expect(assigned.some(file=>Object.hasOwn(exclusions,file))).toBe(false);
 expect(new Set(assigned)).toEqual(new Set(expected));
 expect(new Set([...assigned,...omitted])).toEqual(new Set(plan.discovered));
 expect(assigned.length+omitted.length).toBe(plan.discovered.length);
});
test('suite argv uses supported output/locale contracts and enables assertions',()=>{
 const open=browserInvocation('tests/open-workspace-browser.ts','ko','/tmp/evidence');
 expect(open.argv).toEqual(['bun','tests/open-workspace-browser.ts','--lang','ko','--out','/tmp/evidence']);
 expect(open.env.NO_ASSERT).toBeUndefined();
 expect(browserInvocation('tests/chest-panel-browser.ts','default','/tmp/evidence').argv.slice(-2)).toEqual(['--shots','/tmp/evidence']);
 expect(browserInvocation('tests/inspection-clock-consumers-browser.ts','default','/tmp/evidence','/isolated').env.CLOCK_PRODUCER_BENCH).toBe('/isolated');
 expect(browserInvocation('tests/parts-explorer-browser.ts','default','/tmp/evidence').env.OUT_JSON).toBe('/tmp/evidence/report.json');
});
