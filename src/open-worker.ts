import {runOpenWorker} from './open.ts';
if(import.meta.main)runOpenWorker(Bun.argv[2]??'').catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
