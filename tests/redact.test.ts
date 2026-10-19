import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openUrl} from '../src/open.ts';
import {REDACTED_CAPABILITY,leaksCapability,redactCapability} from '../scripts/redact.ts';
const capability='a'.repeat(64),key='b'.repeat(64),contentHash='c'.repeat(64);
const root=join(import.meta.dir,'..');

test('open keeps the usable capability in the URL it prints (managed and direct)',()=>{
 const managed=openUrl({origin:'http://127.0.0.1:5000',key,contentHash,capability},'http://127.0.0.1:4318'),direct=openUrl({origin:'http://127.0.0.1:5000',key,contentHash,capability});
 for(const url of [managed,direct]){expect(new URL(url).hash).toBe('#cap='+capability);expect(leaksCapability(url)).toBe(true);}
});
test('redaction replaces the fragment value and keeps the rest of the line',()=>{
 const managed=openUrl({origin:'http://127.0.0.1:5000',key,contentHash,capability},'http://127.0.0.1:4318');
 const line=`ok   installed bin serves the demo on loopback · ${managed}`,safe=redactCapability(line);
 expect(safe).toBe(line.replace('#cap='+capability,REDACTED_CAPABILITY));expect(safe).not.toContain(capability);expect(leaksCapability(safe)).toBe(false);
 expect(redactCapability(safe)).toBe(safe);
 const several=redactCapability(`a http://x/#cap=${capability} b http://y/?q=1#cap=short\nc`);expect(several).toBe(`a http://x/${REDACTED_CAPABILITY} b http://y/?q=1${REDACTED_CAPABILITY}\nc`);
});
test('the foreground ready line the smoke reads carries a capability, and redaction removes it',async()=>{
 const state=await mkdtemp(join(tmpdir(),'review-redact-')),child=Bun.spawn([process.execPath,'src/cli.ts','examples/demo/review.json','--port','0'],{cwd:root,stdout:'pipe',stderr:'pipe',env:{...process.env,RIG_REVIEW_STATE_DIR:state}});
 try{
  const reader=child.stdout.getReader(),decoder=new TextDecoder(),deadline=Date.now()+20000;let out='';
  while(!/Review ready: \S+\n/.test(out)&&Date.now()<deadline){const {value,done}=await reader.read();if(done)break;out+=decoder.decode(value);}
  const url=/Review ready: (\S+)/.exec(out)?.[1]??'',served=new URL(url).hash.slice(5);
  expect(served).toMatch(/^[a-f0-9]{64}$/);
  const safe=redactCapability(out);expect(safe).not.toContain(served);expect(leaksCapability(safe)).toBe(false);expect(safe).toContain('Review ready: ');
 }finally{child.kill();await child.exited;await rm(state,{recursive:true,force:true});}
},30000);
test('the install smoke has one stdout writer, and it redacts',async()=>{
 const source=await readFile(join(root,'scripts/install-smoke.ts'),'utf8');
 expect(source.match(/console\.log\(/g)?.length).toBe(1);
 expect(source).toMatch(/function log\(line:string\)\{const safe=redactCapability\(line\);printed\.push\(safe\);console\.log\(safe\);\}/);
 expect(source).not.toMatch(/process\.stdout\.write|Bun\.write\(Bun\.stdout/);
});
