/** The one review screen's host seam (#709). A live job sets it before importing the rig composition
 * (`main.ts`): the job keeps the transport, the screen keeps its own view. Unset, the screen is the package page. */
import type {ModelAssets, PosedFrame} from '@rig-c/play';
import type {ReviewSession} from '../src/session.ts';
import type {InstanceAccess} from './instance-access.ts';
import type {JobRigStage} from './job-rig-capture.ts';

/** The rig pane as the screen holds it now, for the job's still. */
export type RigHostStage = Omit<JobRigStage, 'source' | 'presentation'> & {
  readonly posed: PosedFrame | undefined;
  readonly assets: ModelAssets | null;
};
export interface RigHostScreen {
  /** Null while no rig is drawn. */
  stage(): RigHostStage | null;
  /** Draw the held frame again so the posed frame and the player share one generation. */
  redraw(): void;
  message(text: string, error?: boolean): void;
}
/** Only the content carried by an act the host has actually committed. This is local UI state, not an act field. */
export interface RigHostCommit {
  readonly at: string;
  readonly checkpoints?: ReviewSession['checkpoints'];
  readonly review?: Pick<ReviewSession, 'status' | 'feedback'>;
}
export interface RigHost {
  readonly access: InstanceAccess;
  /** A read the host answers itself, or undefined to fetch it from the subject's routes. */
  read(path: string, method: string): Promise<unknown> | undefined;
  /** The act bar's Submit review: the session's decisions go out as the pending asks' acts. */
  submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>): Promise<string>;
  attach(screen: RigHostScreen): void;
  /** The first rig draw is on screen (or the open failed): the job acknowledges the display after it. */
  displayed(): void;
  failed(error: unknown): void;
}
let current: RigHost | null = null;
export function setRigHost(host: RigHost | null): void {current = host;}
export function rigHost(): RigHost | null {return current;}
