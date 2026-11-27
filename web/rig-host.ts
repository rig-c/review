/** The one review screen's host seam (#709). A live job sets it before importing the rig composition
 * (`main.ts`): the job keeps the transport, the screen keeps its own view. Unset, the screen is the package page. */
import type {PartsIssue} from '../src/parts-comment.ts';
import type {JobAnsweredDirectionFeedback,JobCheckpointEvidence,JobProgressV3, PendingAskV3} from '../src/job-contract.ts';
import type {Feedback} from '../src/session.ts';
import type {InspectionBookmark} from './inspection-persistence.ts';
import type {ControlView} from '../src/control.ts';
import type {InstanceAccess} from './instance-access.ts';
import type {CommentRow} from './stage-comments.ts';

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
  message(text: string, error?: boolean, diagnostic?: string): void;
  pendingSubjects?(subjects:readonly PendingAskV3['subject'][]):void;
  progress?(value: JobProgressV3 | null):void;
  recordForms?(forms:readonly HTMLFormElement[]):void;
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
  /** All declared pairs belong to the displayed publication. A record opens on its first pair and can select another. */
  readonly checkpointPairs?:ReadonlyMap<string,CheckpointPairView>;
  checkpointPair?():CheckpointPairView|undefined;
  selectCheckpointPair?(checkpointId:string):CheckpointPairView|undefined;
  readonly waiting?:boolean;
  readonly subject?:'parts';
  readonly unavailable?:string;
  readonly direction?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId:string;readonly previousPublicationId?:string|null;readonly sourceHash:string;readonly answeredDirectionFeedback?:readonly JobAnsweredDirectionFeedback[]};
  readonly verdictComments?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId:string;readonly previousPublicationId?:string|null;readonly sourceHash:string;readonly rows:CommentRow[];readonly available:()=>boolean};
  readonly navigation?:RigHostNavigation;
  readonly record?:{readonly jobId?:string;readonly draftId?:string;readonly publicationId?:string;readonly previousPublicationId?:string|null;readonly label:string;readonly sourceHash:string;readonly hasPicture:boolean;readonly planPicture?:{readonly name:string;readonly src:string;readonly path:string;readonly sha256:string};/** #1048: the sealed `files` entries of the record's question images. */readonly questionPictures?:readonly {readonly name:string;readonly src?:string;readonly path:string;readonly sha256:string}[];readonly missingPicture?:'rig'|'scene';readonly questionPicture?:true};
  /** #1226: unsent pinned rows and general comments go out as one comment-only act; it answers no ask. #1242: parts pins too. */
  submitComments?(feedback:readonly Feedback[], general:readonly string[], issues?:readonly PartsIssue[]):Promise<string>;
  readonly access: InstanceAccess;
  /** UI act authority is separate from a retained backdrop's immutable source access. */
  readonly ownerActAccess?: Pick<InstanceAccess, 'capability'>;
  /** Existing pending subjects, for the local act heading only; no wire field. */
  pendingSubjects?():readonly PendingAskV3['subject'][];
  /** A read the host answers itself, or undefined to fetch it from the subject's routes. */
  read(path: string, method: string): Promise<unknown> | undefined;
  attach(screen: RigHostScreen): void;
  /** The first rig draw is on screen (or the open failed): the job acknowledges the display after it. */
  displayed(): void;
  failed(error: unknown): void;
}
let current: RigHost | null = null;
export function setRigHost(host: RigHost | null): void {current = host;}
export function rigHost(): RigHost | null {return current;}
