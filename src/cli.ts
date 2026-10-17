#!/usr/bin/env bun
import { loadReview } from './manifest.ts';
import { readSession } from './session.ts';
import { startServer } from './server.ts';
const usage='Usage: bun run review -- <review.json|output-directory> [--port 4317] [--checkpoint ID]\n       bun run check -- <review.json|output-directory>\n       bun run feedback -- <review.json|output-directory>';
export async function main(args:string[]){
  args=args.filter(v=>v!=='--');let command:'review'|'check'|'feedback'='review';if(args[0]==='check'||args[0]==='feedback'){command=args.shift() as 'check'|'feedback';}
  if(args.includes('--help')||args.includes('-h')){console.log(usage);return;}
  const input=args.shift();if(!input)throw new Error(usage);let port=4317;let checkpoint:string|undefined;
  while(args.length){const flag=args.shift();const value=args.shift();if(!value)throw new Error(`Missing value for ${flag}`);if(flag==='--port'){port=Number(value);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('--port: expected integer 0…65535');}else if(flag==='--checkpoint')checkpoint=value;else throw new Error(`Unknown option ${flag}\n${usage}`);}
  const p=await loadReview(input);if(command==='feedback'){console.log(JSON.stringify(await readSession(p),null,2));return;}if(command==='check'){console.log(`Package valid: ${p.manifest.title}\nRevision: ${p.manifest.revision}\nSource SHA-256: ${p.sourceHash}\nDeclared files: ${p.files.size}\nPlayback: ${p.manifest.model?'compiled model present':'unavailable (no model)'}`);return;}
  if(checkpoint&&!p.manifest.checkpoints.some(v=>v.id===checkpoint))throw new Error(`Unknown checkpoint ${checkpoint}`);
  const server=await startServer(p,{port});const url=new URL(`http://127.0.0.1:${server.port}/`);if(checkpoint)url.searchParams.set('checkpoint',checkpoint);
  console.log(`Review ready: ${url}\nPackage: ${p.manifest.title} (${p.manifest.revision})\nSource SHA-256: ${p.sourceHash}\nPress Ctrl+C to stop.`);
}
if(import.meta.main)main(Bun.argv.slice(2)).catch(e=>{console.error(e instanceof Error?e.message:e);process.exitCode=1;});
