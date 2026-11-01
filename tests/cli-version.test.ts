import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
async function run(args:string[]){const child=Bun.spawn([process.execPath,'src/cli.ts',...args],{stdout:'pipe',stderr:'pipe'});const [stdout,exit]=await Promise.all([new Response(child.stdout).text(),child.exited]);return {stdout,exit};}
test('--version and -v print the package version and exit 0',async()=>{
 const version=(JSON.parse(await readFile('package.json','utf8')) as {version:string}).version;
 for(const flag of ['--version','-v']){const result=await run([flag]);expect(result.exit).toBe(0);expect(result.stdout).toBe(version+'\n');}
});
test('--help names the flag',async()=>{expect((await run(['--help'])).stdout).toContain('rig-review --version');});
