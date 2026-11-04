/**
 * #356: the scrub's box inside the transport row, for the readers that lay things under it (reading ticks, the
 * idle blink strip). A played frame writes text before those readers run, so reading the box there forces a
 * layout mid-frame. The frame instead reads it once before it writes anything, and its readers use that box.
 */
export interface ScrubBox { left: number; top: number; width: number; height: number }

type Measurable = Pick<HTMLElement, 'offsetLeft' | 'offsetTop' | 'offsetWidth' | 'offsetHeight'>;

let held: { scrub: Measurable; box: ScrubBox } | null = null;

const read = (scrub: Measurable): ScrubBox => ({ left: scrub.offsetLeft, top: scrub.offsetTop, width: scrub.offsetWidth, height: scrub.offsetHeight });

/** Read the box now (before the frame's writes) and hand it to every reader until `releaseScrubBox`. */
export function holdScrubBox(scrub: Measurable): void { held = { scrub, box: read(scrub) }; }

export function releaseScrubBox(): void { held = null; }

/** The held box for this scrub inside a frame; a live read anywhere else (seek, resize, load). */
export function scrubBox(scrub: Measurable): ScrubBox { return held && held.scrub === scrub ? held.box : read(scrub); }
