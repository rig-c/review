/** The one review screen's host seam (#709). A live job sets it before importing the rig composition
 * (`main.ts`): the job keeps the transport, the screen keeps its own view. Unset, the screen is the package page. */
import type {ModelAssets, PosedFrame} from '@rig-c/play';
import type {PartsIssue} from '../src/parts-comment.ts';
import type {JobComment, JobImageSourceBinding, JobImageReviewValue, PendingAskV3} from '../src/job-contract.ts';
import type {ReviewSession} from '../src/session.ts';
import type {InspectionBookmark} from './inspection-persistence.ts';
import type {ControlView} from '../src/control.ts';
import type {InstanceAccess} from './instance-access.ts';
import type {JobRigStage} from './job-rig-capture.ts';

/** The rig pane as the screen holds it now, for the job's still. */
export type RigHostStage = Omit<JobRigStage, 'source' | 'presentation'> & {
  readonly posed: PosedFrame | undefined;
  readonly assets: ModelAssets | null;
};
export type RigHostNavigation = {subject:'rig';bookmark:InspectionBookmark} |
  {subject:'parts';part:string|null;solo:boolean;view:string;camera:ControlView};
export interface RigHostScreen {
  navigation?():RigHostNavigation;
  incompatible?():boolean;
  suspend?():void;
  resume?():void|Promise<void>;
  dispose?():void;
  /** Null while no rig is drawn. */
  stage(): RigHostStage | null;
  /** Draw the held frame again so the posed frame and the player share one generation. */
  redraw(): void;
  message(text: string, error?: boolean): void;
  pendingSubjects?(subjects:readonly PendingAskV3['subject'][]):void;
  recordForms?(forms:readonly HTMLFormElement[]):void;
}
/** Only the content carried by an act the host has actually committed. This is local UI state, not an act field. */
export interface RigHostCommit {
  readonly at: string;
  readonly checkpoints?: ReviewSession['checkpoints'];
  readonly review?: Pick<ReviewSession, 'status' | 'feedback'>;
}
export interface RigHost {
  readonly subject?:'parts';
  readonly unavailable?:string;
  readonly direction?:{readonly publicationId:string;readonly sourceHash:string};
  readonly imageSet?:{readonly label:string;readonly publicationId:string;readonly source:JobImageSourceBinding;readonly gallery:HTMLElement};
  canSubmit?():boolean;
  submitImages?(verdict:JobImageReviewValue['verdict'],comments:readonly JobComment[]):Promise<string>;
  readonly navigation?:RigHostNavigation;
  /** Derived from the displayed subject's finalized verdict; never a mode or another subject's act. */
  reviewState?(issues:number,sending:boolean):string;
  readonly record?:{readonly publicationId?:string;readonly label:string;readonly sourceHash:string;readonly hasPicture:boolean};
  submitParts?(issues:readonly PartsIssue[]):Promise<string>;
  readonly access: InstanceAccess;
  /** UI act authority is separate from a retained backdrop's immutable source access. */
  readonly ownerActAccess?: Pick<InstanceAccess, 'capability'>;
  /** Existing pending subjects, for the local act heading only; no wire field. */
  pendingSubjects?():readonly PendingAskV3['subject'][];
  /** A read the host answers itself, or undefined to fetch it from the subject's routes. */
  read(path: string, method: string): Promise<unknown> | undefined;
  /** The act bar's Submit review: the session's decisions go out as the pending asks' acts. */
  submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>, directionWords?:string): Promise<string>;
  attach(screen: RigHostScreen): void;
  /** The first rig draw is on screen (or the open failed): the job acknowledges the display after it. */
  displayed(): void;
  failed(error: unknown): void;
}
let current: RigHost | null = null;
export function setRigHost(host: RigHost | null): void {current = host;}
export function rigHost(): RigHost | null {return current;}
