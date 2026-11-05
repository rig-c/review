/** Runs exactly the selected app copy. No static imports of candidate app modules. */
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const app=resolve(Bun.argv[2]!),fixture=resolve(Bun.argv[3]!),port=Number(Bun.argv[4]??0),state=resolve(Bun.argv[5]!);
const {loadReview}=await import(pathToFileURL(app+'/src/manifest.ts').href);
const {startServer}=await import(pathToFileURL(app+'/src/server.ts').href);
const p=await loadReview(fixture),token='viewport-387-test-control',instanceKey='3'.repeat(64);
const server=await startServer(p,{port,stateDir:state,viewOnly:true,initialAnimation:'inspect',control:{token,instanceKey},unopenedTimeoutMs:600000});
console.log(JSON.stringify({port:server.port,sourceHash:p.sourceHash,token,instanceKey,app}));
process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});
