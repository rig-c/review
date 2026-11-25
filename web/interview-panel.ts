import type { Picks } from '../src/interview-picks.ts';

type Pick = Picks['picks'][number];

/** The `rig-review/interview-picks@1` record exactly as the stage interview has always posted it (key order is the file's bytes). */
export function interviewPicksRecord(ref: Picks['set'], picks: readonly Pick[], note: string | undefined, at: string): Picks {
  return {schema:'rig-review/interview-picks@1', set:ref, picks:picks as Pick[], ...(note !== undefined ? {note} : {}), by:'user', at};
}
