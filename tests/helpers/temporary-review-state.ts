import {beforeEach,afterEach} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
export function useTemporaryReviewState(){let previous:string|undefined,root:string;beforeEach(async()=>{previous=process.env.RIG_REVIEW_STATE_DIR;root=await mkdtemp(join(tmpdir(),'review-comment-state-'));process.env.RIG_REVIEW_STATE_DIR=root;});afterEach(async()=>{if(previous===undefined)delete process.env.RIG_REVIEW_STATE_DIR;else process.env.RIG_REVIEW_STATE_DIR=previous;await rm(root,{recursive:true,force:true});});}
