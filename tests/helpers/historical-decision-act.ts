import {randomUUID} from 'node:crypto';
import {parseCommentsAct} from '../../src/job-api.ts';
import type {JobCommentsAct,JobEventV3,JobPendingAsk} from '../../src/job-contract.ts';
import type {JobSession} from '../../src/job-session.ts';
import type {JobStore} from '../../src/job-store.ts';

type Verdict = Extract<JobCommentsAct,{kind:'parts-verdict'|'review-verdict'}>;
type DecisionRows = {
  generation:number;
  asks:Record<string,JobPendingAsk>;
  acts:Record<string,JobCommentsAct>;
  events:JobEventV3[];
};

/** Place a base-writer act on the disposable publication used by an inspection test. */
export function seedHistoricalDecisionAct(session:JobSession, ask:JobPendingAsk, template:unknown,
  value?:Verdict['value']):Verdict {
  const recorded = parseCommentsAct(template);
  if(recorded.kind!=='review-verdict'&&recorded.kind!=='parts-verdict')throw new Error('Expected a historical verdict fixture');
  const act = parseCommentsAct({...recorded,actId:randomUUID(),jobId:session.jobId,askId:ask.askId,
    publicationId:ask.publicationId,source:ask.source,value:value??recorded.value}) as Verdict;
  const {store}=session as unknown as {store:JobStore<DecisionRows>};
  store.update(session.jobId,null,({data})=>{
    data.acts[act.actId]=act;
    data.asks[ask.askId]={...ask,status:'answered'};
    data.events.push({type:'act',cursor:randomUUID(),jobId:session.jobId,generation:++data.generation,act});
    return {data};
  });
  return act;
}
