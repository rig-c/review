import {expect,test} from 'bun:test';
import {partitionBrowserSuites,browserInvocation,browserPlan} from '../scripts/browser-gate.ts';
import exclusions from '../scripts/browser-exclusions.json';

test('every discovered nonexcluded browser is in the serial plan, including an unknown new filename',()=>{
 const files=['tests/known-browser.ts','tests/new-browser.ts','tests/held-browser.ts'];
 const plan=partitionBrowserSuites(files,{'tests/held-browser.ts':{issue:843,reason:'regression'}});
 expect(plan.suites).toEqual(['tests/known-browser.ts','tests/new-browser.ts']);
 expect(plan.discovered).toEqual([...files].sort());
 expect(()=>partitionBrowserSuites(files,{'tests/absent-browser.ts':{issue:842,reason:'stale'}})).toThrow('BROWSER_EXCLUSION_INVALID');
 expect(()=>partitionBrowserSuites([...files,files[0]!])).toThrow('BROWSER_DUPLICATE_SUITE');
});
test('exclusion metadata requires a positive integer issue and nonempty reason without live API lookup',()=>{
 const files=['tests/held-browser.ts'];
 for(const entry of [
  {issue:0,reason:'held'}, {issue:-1,reason:'held'}, {issue:1.5,reason:'held'},
  {issue:NaN,reason:'held'}, {issue:842,reason:''}, {issue:842,reason:'   '},
  {issue:842,reason:null}, null,
 ]) expect(()=>partitionBrowserSuites(files,{'tests/held-browser.ts':entry} as never)).toThrow('BROWSER_EXCLUSION_INVALID');
 expect(partitionBrowserSuites(files,{'tests/held-browser.ts':{issue:842,reason:'in progress'}}).suites).toEqual([]);
});
test('live tree partition covers every discovered suite once or by its named exemption',async()=>{
 const plan=await browserPlan();
 expect(Object.fromEntries(Object.entries(plan.exclusions).map(([file,entry])=>[file,entry.issue]))).toEqual({
  "tests/stage1-corrections-browser.ts": 847,
  "tests/stage1-review-fixes-browser.ts": 847,
  "tests/job-checkpoint-evidence-browser.ts": 848,
  "tests/act-row-browser.ts": 850,
  "tests/correction-handoff-browser.ts": 842,
  "tests/inspection-clock-consumers-browser.ts": 842,
  "tests/job-checkpoint-wire-browser.ts": 842,
  "tests/job-record-browser.ts": 842,
  "tests/open-workspace-browser.ts": 842,
  "tests/rig-bottom-browser.ts": 842
});
 const assigned=plan.suites;
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
 expect(browserInvocation('tests/parts-comments-browser.ts','default','/tmp/evidence').argv).toEqual(['bun','tests/parts-comments-browser.ts']);
});

test('gate CLI uses an explicit argv entry and importing it does not execute the CLI',async()=>{
 const imported=Bun.spawn([process.execPath,'-e',"await import('./scripts/browser-gate.ts');console.log('IMPORT_SAFE')"],{stdout:'pipe',stderr:'pipe'});
 const [importOut,importErr,importExit]=await Promise.all([new Response(imported.stdout).text(),new Response(imported.stderr).text(),imported.exited]);
 expect(importExit).toBe(0);expect(importErr).toBe('');expect(importOut.trim()).toBe('IMPORT_SAFE');
 const direct=Bun.spawn([process.execPath,'scripts/browser-gate.ts'],{stdout:'pipe',stderr:'pipe'});
 const [planOut,planErr,planExit]=await Promise.all([new Response(direct.stdout).text(),new Response(direct.stderr).text(),direct.exited]);
 expect(planExit).toBe(0);expect(planErr).toBe('');expect(JSON.parse(planOut)).toEqual(await browserPlan());
});
