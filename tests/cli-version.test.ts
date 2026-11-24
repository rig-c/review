import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
async function run(args:string[],entry='src/cli.ts'){const child=Bun.spawn([process.execPath,entry,...args],{stdout:'pipe',stderr:'pipe'});const [stdout,exit]=await Promise.all([new Response(child.stdout).text(),child.exited]);return {stdout,exit};}
test('--version and -v print the package version and exit 0',async()=>{
 const version=(JSON.parse(await readFile('package.json','utf8')) as {version:string}).version;
 for(const flag of ['--version','-v']){const result=await run([flag]);expect(result.exit).toBe(0);expect(result.stdout).toBe(version+'\n');}
});
test('--help names the flag',async()=>{expect((await run(['--help'])).stdout).toContain('rig-review --version');});

test('#1166 public --help lists every dispatched command',async()=>{
 const sources=await Promise.all(['src/entry.ts','src/cli.ts'].map(path=>readFile(path,'utf8')));
 const dispatched=new Set(sources.flatMap(source=>[...source.split('export async function main(')[1]!
  .matchAll(/args\[0\]\s*===\s*'([a-z][a-z-]*)'/g)].map(match=>match[1]!)));
 expect(dispatched.size).toBeGreaterThan(0);
 const {stdout,exit}=await run(['--help'],'src/entry.ts');
 expect(exit).toBe(0);
 const documented=new Set([...stdout.matchAll(/^ *(?:Usage: )?(?:rig-review|bun run) ([a-z][a-z-]*)(?: -- ([a-z][a-z-]*))?(?=\s|$)/gm)]
  .flatMap(match=>match.slice(1).filter(Boolean)));
 expect([...dispatched].filter(command=>!documented.has(command))).toEqual([]);
});
