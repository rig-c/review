/**
 * #346: Animate's playback clock. Wall-clock time is accumulated and the clip and its physics advance in fixed
 * `PLAYBACK_STEP` steps, so the integrated physics does not depend on the display's refresh rate. A repeating clip
 * wraps its own time here; the player is opened with `loop: true` and is never re-seeked at the wrap, so physics
 * state carries across the loop seam. Only an explicit reset or a seek restarts physics.
 */
export const PLAYBACK_STEP = 1 / 60;
/** A step this close to whole counts as whole, so float residue in the accumulator never drops a step. */
const STEP_SLACK = 1e-9;

export interface PlaybackInput {
 /** The clip time before this frame, in seconds. */
 time: number;
 duration: number;
 /** Wall-clock seconds accumulated but not yet stepped, carried from the previous frame. */
 carry: number;
 /** Wall-clock seconds since the previous frame. */
 elapsed: number;
 repeat: boolean;
 /** Keep the clip time fixed while supplying wall-clock physics steps. */
 held?: boolean;
 step?: number;
}
export interface PlaybackAdvance {
 /** The player steps to take, in order. Each is `step`, except a shorter last step that lands exactly on a non-repeating clip's end. */
 steps: number[];
 time: number;
 carry: number;
 /** The clip wrapped at least once this frame (repeating clips only). */
 wrapped: boolean;
 /** A non-repeating clip reached its end this frame. */
 ended: boolean;
}

export function advancePlayback(input: PlaybackInput): PlaybackAdvance {
 const step = input.step ?? PLAYBACK_STEP, duration = input.duration, steps: number[] = [];
 let time = input.time, carry = input.carry + Math.max(0, input.elapsed), wrapped = false, ended = false;
 if (!input.held && !(duration > 0)) return { steps, time, carry: 0, wrapped, ended };
 while (carry >= step - STEP_SLACK) {
  if (!input.held && !input.repeat && time + step >= duration) {
   const last = duration - time;
   if (last > 0) steps.push(last);
   time = duration; carry = 0; ended = true;
   break;
  }
  steps.push(step); carry = Math.max(0, carry - step); if (!input.held) time += step;
  if (!input.held && input.repeat) while (time >= duration) { time -= duration; wrapped = true; }
 }
 return { steps, time, carry, wrapped, ended };
}

/**
 * Whether an audio cue at `at` seconds falls in the interval this frame played. On a wrap that is
 * (previous, duration] and then [0, time], so a cue just before the clip's end still sounds.
 */
export function cueDue(at: number, previous: number, next: PlaybackAdvance, duration: number): boolean {
 if (next.wrapped) return (previous < at && at <= duration) || at <= next.time;
 return (previous < at && at <= next.time) || (previous === 0 && at === 0 && next.steps.length > 0);
}
