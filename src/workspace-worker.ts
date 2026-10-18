import {runWorkspaceWorker} from './workspace-manager.ts';
if(import.meta.main)runWorkspaceWorker(Bun.argv[2]??'').catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exit(1);});
