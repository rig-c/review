import {runFront} from './front.ts';
if(import.meta.main)runFront(Bun.argv[2]??'').catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
