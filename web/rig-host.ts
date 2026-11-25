/** The one review screen's host seam (#709). A live job sets it before importing the rig composition
 * (`main.ts`): the job keeps the transport, the screen keeps its own view. Unset, the screen is the package page. */
import type {ModelAssets, PosedFrame} from '@rig-c/play';
import type {PartsIssue} from '../src/parts-comment.ts';
import type {JobAnsweredDirectionFeedback,JobCheckpointEvidence,JobComment,JobProgressV3, PendingAskV3} from '../src/job-contract.ts';
import type {Feedback, ReviewSession} from '../src/session.ts';
import type {InspectionBookmark} from './inspection-persistence.ts';
import type {ControlView} from '../src/control.ts';
import type {InstanceAccess} from './instance-access.ts';
import type {JobRigStage} from './job-rig-capture.ts';
import type {CommentRow} from './stage-comments.ts';

/** The rig pane as the screen holds it now, for the job's still. */
export type RigHostStage = Omit<JobRigStage, 'source' | 'presentation'> & {
  readonly posed: PosedFrame | undefined;
  readonly assets: ModelAssets | null;
};
export type RigHostNavigation = {subject:'rig';bookmark:InspectionBookmark} |
  {subject:'parts';part:string|null;solo:boolean;view:string;camera:ControlView};
export interface RigHostScreen {
    syncActRow?(): void;
  /** Fill the pre-publication frame once, keeping its shell and viewport nodes. */
  publish?(host:RigHost):void;
  navigation?():RigHostNavigation;
  incompatible?():boolean;
  suspend?():void;
  resume?():void|Promise<void>;
  dispose?():void;
  /** Null while no rig is drawn. */
  stage(): RigHostStage | null;
  /** Draw the held frame again so the posed frame and the player share one generation. */
  redraw(): void;
  message(text: string, error?: boolean, diagnostic?: string): void;
  pendingSubjects?(subjects:readonly PendingAskV3['subject'][]):void;
  progress?(value: JobProgressV3 | null):void;
  recordForms?(forms:readonly HTMLFormElement[]):void;
}
/** Only the content carried by an act the host has actually committed. This is local UI state, not an act field. */
export interface RigHostCommit {
  readonly at: string;
  readonly checkpoints?: ReviewSession['checkpoints'];
  readonly review?: Pick<ReviewSession, 'status' | 'feedback'>;
}
export interface CheckpointPairPicture {
  readonly id:string;
  readonly path:string;
  readonly sha256:string;
  readonly image:HTMLImageElement;
}
export interface CheckpointPairView {
  readonly checkpointId:JobCheckpointEvidence['checkpointId'];
  readonly before:CheckpointPairPicture;
  readonly after:CheckpointPairPicture;
  readonly differenceUrl:string;
}
export interface RigHost {
  /** All declared pairs belong to the displayed publication. The active pair below follows the pending ask. */
  readonly checkpointPairs?:ReadonlyMap<string,CheckpointPairView>;
  checkpointPair?():CheckpointPairView|undefined;
  readonly waiting?:boolean;
  readonly subject?:'parts';
  readonly unavailable?:string;
  readonly direction?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId:string;readonly previousPublicationId?:string|null;readonly sourceHash:string;readonly answeredDirectionFeedback?:readonly JobAnsweredDirectionFeedback[]};
  readonly verdictComments?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId:string;readonly previousPublicationId?:string|null;readonly sourceHash:string;readonly rows:CommentRow[];readonly available:()=>boolean};
  readonly navigation?:RigHostNavigation;
  /** Derived from the displayed subject's finalized verdict; never a mode or another subject's act. */
  reviewState?(issues:number,sending:boolean):string;
  /** #1226: this page's verdict ask was answered; the act bar keeps that outcome as its state. */
  verdictAnswered?():boolean;
  readonly record?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId?:string;readonly previousPublicationId?:string|null;readonly label:string;readonly sourceHash:string;readonly hasPicture:boolean;readonly planPicture?:{readonly name:string;readonly src:string;readonly path:string;readonly sha256:string};/** #1048: the sealed `files` entries of the record's question images. */readonly questionPictures?:readonly {readonly name:string;readonly src?:string;readonly path:string;readonly sha256:string}[];readonly missingPicture?:'rig'|'scene';readonly questionPicture?:true};
  submitParts?(issues:readonly PartsIssue[], general?:readonly string[]):Promise<string>;
  /** #1226: unsent pinned rows and general comments go out as one comment-only act; it answers no ask. #1242: parts pins too. */
  submitComments?(feedback:readonly Feedback[], general:readonly string[], issues?:readonly PartsIssue[]):Promise<string>;
  readonly access: InstanceAccess;
  /** UI act authority is separate from a retained backdrop's immutable source access. */
  readonly ownerActAccess?: Pick<InstanceAccess, 'capability'>;
  /** Existing pending subjects, for the local act heading only; no wire field. */
  pendingSubjects?():readonly PendingAskV3['subject'][];
  /** A read the host answers itself, or undefined to fetch it from the subject's routes. */
  read(path: string, method: string): Promise<unknown> | undefined;
  /** The act bar's Submit review: the session's decisions go out as the pending asks' acts. */
  submit(session: ReviewSession, committed: (commit: RigHostCommit) => void | Promise<void>, directionComments?: readonly JobComment[], general?:readonly string[],
    /** #1226: rows already sent on their own as act@10; the verdict does not carry them again. */ alreadySent?:(row:Feedback)=>boolean): Promise<string>;
  attach(screen: RigHostScreen): void;
  /** The first rig draw is on screen (or the open failed): the job acknowledges the display after it. */
  displayed(): void;
  failed(error: unknown): void;
}
let current: RigHost | null = null;
export function setRigHost(host: RigHost | null): void {current = host;}
export function rigHost(): RigHost | null {return current;}
