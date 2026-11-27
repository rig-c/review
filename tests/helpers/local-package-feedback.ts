import {LOCAL_COMMENTS_ROUTE, readPackageComments} from '../../src/local-comments.ts';
import type {ReviewPackage} from '../../src/manifest.ts';
import type {Feedback} from '../../src/session.ts';
import {feedbackContextComments} from '../../src/stage-comment.ts';

export function postLocalPackageFeedback(origin:string, sourceHash:string, feedback:readonly Feedback[],
  headers:Record<string,string>={}, base=origin) {
  return fetch(base+LOCAL_COMMENTS_ROUTE,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},
    body:JSON.stringify({sourceHash,sendId:crypto.randomUUID(),value:{comments:feedbackContextComments(feedback)}})});
}

export async function lastLocalPackageFeedback(p:ReviewPackage,stateDir:string) {
  const file=await readPackageComments(p,stateDir);
  return (file?.sends.at(-1)?.value.comments??[]).flatMap(({text,anchor})=>
    anchor&&'frameStart' in anchor?[{...anchor,summary:text}]:[]);
}
