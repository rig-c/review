# Public API stability

## Managed owner host

`@rig-c/review/job-host` is the installed Bun entry for the full standing owner
window and the semantic A/B host ports, introduced by Review #489. The CLI and
`@rig-c/review/package.json` remain supported.

The named exports and signatures below are the supported import contract.
Changes to them require an explicit public-contract review. The facade reexports
the existing implementation and semantic types directly. The semantic schemas
and behavior are defined in [Live job contract](REVIEW_PACKAGE.md#live-job-contract).
The C4 parts binding and schema compatibility are defined by that reference.

C4 changes `JobPartsManifestPath`, `JobPartImagePath`, `JobPartsIdentity` and their embedding public host, publication, source and act types under `JOB_API_SCHEMA` (`rig-review/job-api@2`) and `JOB_ACT_SCHEMA` (`rig-review/act@2`). API@1 and unsupported requests receive HTTP 400 with `JOB_REQUEST_INVALID`, detail `JOB_API_SCHEMA_MISMATCH`, the current response schema and unchanged generation. The CLI validates response schema before consuming values. Consumer writers must check API and act schemas. The C4 candidate requires HQ exact-head sign-off and a parent-owned final contract hash. Create #184 production integration remains pending. [C4](https://github.com/rig-c/review/issues/501), [installed control](https://github.com/rig-c/review/blob/main/scripts/install-smoke.ts).

```ts
import {startJobHost} from '@rig-c/review/job-host';
import type {
  JobHostOptions, JobOwnerHost, JobHostPorts,
  JobSessionOptions, JobSession, JobWorkerOptions,
  JobPublicationReader, JobPublishedContext,
} from '@rig-c/review/job-host';

function startJobHost(options: JobHostOptions): Promise<JobOwnerHost>;

interface JobSessionOptions {
  readonly root: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly reviewer: JobReviewerBinding;
  readonly readPublished?: JobPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  readonly afterSnapshot?: () => void | Promise<void>;
  readonly afterDirectorySync?: (path: string) => void;
}

interface JobWorkerOptions extends JobSessionOptions {
  readonly port?: number;
  readonly installWriterBinding?: (binding: {
    readonly jobId: string;
    readonly origin: string;
    readonly fetchCapability: string;
  }) => void | Promise<void>;
}

interface JobHostOptions extends JobWorkerOptions {
  readonly readerId?: string;
  readonly bindingId?: string;
  readonly partsEnumeratorId?: string;
}

type JobPublicationReader = (input: {
  readonly root: string;
  readonly record: JobFileIdentity;
  readonly result: JobPublishRequest['result'];
}) => Promise<JobPublishedContext>;

interface JobPublishedContext {
  readonly selector: JobSelector | null;
  readonly plan: JobPlanIdentity | null;
  readonly parts: JobPartsIdentity | null;
  readonly imageSet?: JobImageSetInput;
  readonly subjects: readonly JobSubject[];
  readonly partIds: readonly string[];
  readonly files: readonly JobFileIdentity[];
}

type JobPartsManifestPath = string; // Work-root-relative, runtime validated.
type JobPartImagePath = string; // Manifest-directory-relative, runtime validated.
type JobPartsRole = string; // Bounded string. Membership belongs to Parts.

interface JobPartsFileReference {
  readonly path: JobPartImagePath;
  readonly role: JobPartsRole;
}

interface JobPartsEnumerator {
  readonly version: string;
  readonly enumerate: (dir: string) => readonly JobPartsFileReference[];
}

interface JobPartsIdentity {
  readonly enumeratorVersion: string;
  readonly manifest: {readonly path: JobPartsManifestPath; readonly sha256: JobSha256};
  readonly images: readonly {readonly path: JobPartImagePath; readonly role: JobPartsRole; readonly sha256: JobSha256}[];
}

interface JobOwnerHost {
  readonly session: JobSession;
  readonly ports: JobHostPorts;
  readonly origin: string;
  readonly ownerUrl: string;
  readonly reused: boolean;
  stop(): void;
}

interface JobHostPorts {
  handleJobApi(request: Request): Promise<Response>;
  subscribeJob(input: {
    readonly jobId: JobId;
    readonly after: JobCursor | null;
    readonly signal: AbortSignal;
  }): AsyncIterable<JobEvent>;
  readPublication(jobId: JobId, publicationId: JobPublicationId): Promise<JobResult<JobDisplayPublication>>;
  commitUIAct(jobId: JobId, request: Request): Promise<JobResult<JobAct>>;
  ackDisplayed(jobId: JobId, request: Request): Promise<JobResult<JobDisplayReceipt>>;
  jobLiveness(jobId: JobId): Promise<JobResult<{
    readonly active: boolean;
    readonly busy: boolean;
  }>>;
}
```

`root` designates the producer work root. `stateDir` must be outside that root.
`fingerprint` identifies compatible host inputs, and `reviewer` is the trusted
bootstrap binding. `port` selects a loopback listener port, with `0` selecting an
available port. `ownerUrl` opens the shipped standing owner page with its private
UI capability fragment. `origin` and the returned `ports` belong to that host.

A present `readPublished` callback requires a nonempty `readerId`. A present
`installWriterBinding` callback requires a nonempty `bindingId`. A present
`partsEnumerator` requires a nonempty `partsEnumeratorId`. Each ID must be
absent when its callback is absent. Violations reject startup with
`JOB_HOST_OPTION_ID_INVALID`. Equal declared IDs permit active-listener reuse
across processes and newly allocated function objects after an authenticated host probe.
API/act schemas and the actual enumerator version must match too. Changed or unrecorded IDs
reject with `JOB_HOST_REUSE_MISMATCH`, including the option name, listener ID and
requested ID. The caller owns the semantic meaning of those IDs.
After `stop()`, an explicit new startup may change valid hook IDs or enumerator
version while keeping the same active job. Before allocating for any fingerprint,
startup checks active rows for that canonical root inside the same store transaction.
An old or missing stored API/act marker refuses `JOB_STORED_SCHEMA_MISMATCH`, naming
the canonical root, stored/current schemas and the instruction to close the old job
with its matching older installation. Old documents remain byte-identical. Current
schemas retain the existing different-fingerprint partition, and closed old-schema
rows do not block a new job. Subsequent reads also guard stored schemas before replay. Active listener
descriptors and authenticated responses with old/missing markers refuse reuse.
Retained identities and acts keep their original bytes and schemas. They are
never migrated, relabelled or rebound to new approvals.

`readPublished` supplies the producer's published semantic context for the exact
frozen record. `installWriterBinding` receives the private finalized-act fetch
grant after reuse validation on each successful new or reused startup. The trusted
writer adapter owns its private binding and storage. A callback failure rejects
startup with `JOB_AUTHORITY_REFUSED`. `afterSnapshot` and `afterDirectorySync` are
optional disposable-test boundary hooks inherited from the existing seam.

`session` retains its existing trusted-host `JobSession` type, including
`jobId`, `hostCredentials()` and `status()` for bootstrap and inspection.
`JobSession` is exported as a type for `host.session`. The host separates agent, owner UI and writer
credentials through their respective channels. Only explicit semantic `close`
ends a job and revokes its writer grant. `stop()` disposes this host handle and
stops its owned listener. A reused handle disposes its local session.

Managed state is private storage accessed through the host ports. The canonical
work root and configured managed-state directory must be disjoint. Before job
admission, a root equal to, inside or containing that state directory refuses
`JOB_SOURCE_UNRETAINABLE`. Directory aliases resolve before this comparison.
Existing root identity failures, including a directly symlinked source root,
retain `JOB_ROOT_REPLACED`. Trusted publication handles follow the origin job's
lifetime, and publishing callers must maintain their producer-held freeze.

All publications, pending asks, pages and trusted publication handles pin their
snapshots while the job is open. Explicit close invalidates pending asks, pages
and trusted handles. Subsequent trusted publication reads, UI operations and
consumer fetches refuse `JOB_CLOSED`. Finalized acts permanently preserve their
bound source bytes, hashes and retained reproduction evidence. Consumer fetch
adds no separate retention protocol.

After close, unfinalized snapshots can be reclaimed only after explicitly counted
file reads finish or cancel. Counts cover asynchronous preparation and complete
response streams across host sessions. Time never releases a count. Historical
events, replay receipts and previous-publication links preserve identities without
pinning those bytes. Reclamation leaves an immutable private tombstone containing
publication ID, snapshot hash, reclamation time and reason. A reference reaching
the reclaimed-snapshot gate refuses `JOB_SNAPSHOT_RECLAIMED`. Close and grant
revocation commit outside the bounded historical document, including at its exact
16 MiB limit. The original document and replay values remain intact. Legacy
snapshots without recorded creation ownership and interrupted readers remain
preserved until ownership or explicit completion can be proved.

The runtime entry starts the full owner host with retained publication routes
and shipped HTML, JavaScript and CSS. Raw Requests and the existing A/B ports
preserve capability, origin, size, cancellation and replay checks.

## Embedded semantic-job hub

`startJobHub` adds an embedded N-job owner to the same public
`@rig-c/review/job-host` facade. One host process owns one loopback listener and
one human owner list at `ownerUrl`. Each `openJob` registers its trusted hooks
in that process and returns the existing session and semantic ports. The jobs
use `rig-review/job-api@2` and `rig-review/act@2`.

```ts
import {startJobHub} from '@rig-c/review/job-host';
import type {
  JobHubOptions, JobHubJobOptions, JobHubJob, JobOwnerHub,
} from '@rig-c/review/job-host';

function startJobHub(options: JobHubOptions): Promise<JobOwnerHub>;

interface JobHubOptions {
  readonly stateDir: string;
  readonly reviewer: JobReviewerBinding;
  readonly port?: number;
}

type JobHubJobOptions = Omit<JobHostOptions, 'stateDir' | 'port' | 'reviewer'>;

interface JobHubJob {
  readonly session: JobSession;
  readonly ports: JobHostPorts;
  readonly origin: string;
  readonly jobUrl: string;
  readonly reused: boolean;
}

interface JobOwnerHub {
  readonly origin: string;
  readonly ownerUrl: string;
  openJob(options: JobHubJobOptions): Promise<JobHubJob>;
  stop(): Promise<void>;
}
```

`stateDir` stays outside every registered work root. `port` accepts 0..65535 and
defaults to an available port. The bootstrap `reviewer` is common to every job,
with the same trusted provenance and role checks as `startJobHost`. A retained
active job with a different reviewer refuses `JOB_AUTHORITY_REFUSED`.
`ownerUrl` has the form `/hub/?workspace=<incarnation>#cap=<private-capability>`.
`jobUrl` is the per-job owner URL, including its private UI capability.
The human receives the hub owner URL once. Agents receive their own per-job
bootstrap credentials privately and address `/jobs/<jobId>/api`.

Each job keeps its own identity, source bindings, generation CAS, idempotency
keys, cursors, asks, acts, display receipts and agent/UI/writer grants. Hook IDs
follow the existing `JobHostOptions` rules. Reopening an active root and
fingerprint with compatible hook identities returns the same session with
`reused` true and invokes the writer-binding callback again. General
cross-process callback registration is deferred. The hub refuses an active
standalone owner with `JOB_HUB_EXTERNAL_HOST`, and a live unresponsive owner
with `JOB_HUB_HOST_UNRESPONSIVE`, preserving that owner. A second live hub for
the state directory refuses `JOB_HUB_ALREADY_RUNNING`. Existing `startJobHost`
callers can still attach to a compatible hub-owned job by authenticated reuse.
Such attachment keeps the registered process-local hooks under hub ownership.

Semantic `close` ends only the addressed job and revokes its writer grant.
Closed entries remain in the current hub list. `await hub.stop()` drains work,
stops the shared transport and disposes local sessions. Active jobs retain their
durable identity, grants, publications, asks, acts and replay history across
that transport stop. Restart requires `startJobHub` and `openJob` for each
required job, registering callbacks again and refreshing the writer adapter's
origin. The hub capability and incarnation rotate, including the nonsecret
`workspace` query that forces a fresh owner document. Obtain the new owner URL
from the new handle. The retained active job's grants keep their identity until
semantic close. A later new job receives new grants.

Admission is an application bound of 32 registered entries, including closed
entries retained in that hub incarnation. `JOB_HUB_LIMIT` refuses a new entry
at the bound. Compatible reuse of an active entry still succeeds. Selected
frames are retained lazily under this bound. Hidden hub members suspend their event subscription after bootstrap and resume from the last delivered cursor when selected. Hardware performance requires its
own measurement.

Consumer-owned adoption remains external and pending in
[Review #512](https://github.com/rig-c/review/issues/512). See the
[embedded consumer example](WORKFLOWS.md#embedded-semantic-jobs) for trusted-hook
ownership and the ordinary semantic cycle.

## Image-set verdict extension

Review #522 adds an HQ-approved image branch to `rig-review/job-api@2` and
`rig-review/act@2`. The original model source and value keep their exact fields
and serialization. Model acts carry no image discriminant, digest, duplicate
array or added nulls. The image branch carries `source.subject = "image-set"`
and omits `model` and `selector` entirely. Its ask and value use
`{kind: "review-verdict", stage: "image-review"}` and the existing human UI
verdict lifecycle. HQ exact-head dependency sign-off is required before landing.
The current `src/job-contract.ts` candidate SHA-256 is
`e7d2be222af6be6cc4718a57fbfef6de606a0c6268efc7b32b15e1bd75bcce65`.
The Tower records the final signed head separately.

Agents discover support through `session next <job-url> --wait-ms 0`, reading
`response.value.capabilities.imageSetVerdict === true`. API callers send the
existing `next` request with their agent bearer capability. The authenticated
hub `/hub/host` and owner `/hub/api/jobs` metadata also advertise that capability.
`JOB_CAPABILITIES` is the current immutable capability object.
`assertJobImageSetCapability(response.value.capabilities)` throws
`JOB_IMAGE_SET_UNSUPPORTED` when support is absent. Call it before asking.
An older installed parser refuses `image-review` with `JOB_ASK_INVALID`.
The preserved parser control uses its exact original function body and shared
current validators. It does not run an older server.

The trusted `JobPublicationReader` may return optional `imageSet` in its
`JobPublishedContext`. The existing callback runs only when publication supplies
a non-null frozen record. A Create root still requires its producer-owned reader.
Review defines this return value, with no new producer record format or Parts
adoption adapter. `result.selector` is null for image publication.

```ts
interface JobImageSetInput {
  readonly purpose: 'plate-adoption';
  readonly images: readonly {
    readonly role: 'source' | 'candidate' | 'reference';
    readonly name: string;
    readonly path: string;
    readonly sha256?: string;
  }[];
}
function assertJobImageSetCapability(capabilities: unknown): void;
```

The ordered set has 2–8 rows, exactly one `source`, at least one `candidate`, and
optional `reference` rows. Names and paths must each be unique. Names use the
existing nonempty 128-unit text bound. Paths are literal job-root-relative paths
with the existing 4096-unit bound and regular-file, containment and symlink
checks. Files retain the existing 64 MiB per-file and 256 MiB total source limits.
Every supplied hash must match disk bytes. The daemon hashes retained inputs,
seals them, derives ask bindings from checked disk bytes and rechecks at finalize.
Equal hashes are allowed and produce ordered `source.duplicateHashes` groups of
`{names: string[], sha256: string}`. Groups appear by first hash occurrence and
names retain producer order. An empty group array is explicit on image sources.

`source.imageSet` contains required derived hashes. `source.imageSetDigest` is
SHA-256 over the UTF-8 bytes of the following exact JSON serialization.

```ts
JSON.stringify(images.map(({role, name, sha256}) => ({role, name, sha256})))
```

Property order is `role`, `name`, `sha256`. Array order and strings remain exact,
with no whitespace insertion or Unicode normalization. Paths are excluded from
this digest. The separate source hash binds the package source hash, frozen
record and complete image set including paths under `rig-review-job-image-set/1`.
Consumers can hash their designated bytes and reconstruct the ordered digest
without parsing Review's private files.

The image value is `{stage: "image-review", verdict, words, imageNotes?}`.
Optional notes are `{name, words}` rows with unique member names and exact human
text. Unknown fields, duplicate names and nonmember notes refuse. The UI omits
empty optional notes and preserves whitespace-only notes. Source hashes, digests,
duplicate groups and authority are daemon-owned and rejected in UI values.
All images decode and reach the existing painted lifecycle boundary before
`ackDisplayed` supplies a nonce and enables submission. Retained routes serve only
sealed indexed image rows. Drafts, visibility messages, replay and writer-owned
`fetch-act` keep their existing publication/source and capability bindings.

New named refusals are `JOB_IMAGE_SET_UNSUPPORTED`, `JOB_IMAGE_SET_INVALID`,
`JOB_IMAGE_SET_DUPLICATE_NAME`, `JOB_IMAGE_SET_DUPLICATE_PATH`,
`JOB_IMAGE_SET_ROLE_INVALID` and `JOB_IMAGE_SET_PATH_REFUSED`.
Disk hash mismatches use `JOB_SOURCE_MISMATCH`. A verdict ask with neither a valid
model binding nor a valid image-set binding uses `JOB_ASK_INVALID`.

## Named export inventory

The backend rig-still extension retains the twelve runtime exports and `JOB_ACT_SCHEMA` at act@2. `JobAct` additionally includes `JobRigReviewAct` at act@3 with top-level `JobRigStill`. The facade adds type-only `JobLegacyAct`, `JobRigReviewAct`, `JobRigStill` and `JobRigCapture` exports. Existing API/store/reuse markers and ordinary/historical acts retain @2. The rig revision constant and transport limits remain internal to `src/job-contract.ts`. Consumer checks distinguish these act revisions as described in [Rig verdict still backend](REVIEW_PACKAGE.md#rig-verdict-still-backend).

The exact runtime exports are listed below. Constants preserve their literal
values from the frozen semantic contract.

- `startJobHost`
- `startJobHub`
- `assertJobImageSetCapability`
- `JOB_CAPABILITIES`
- `JOB_API_SCHEMA`
- `JOB_ACT_SCHEMA`
- `JOB_PARTS_ENUMERATOR_RANGE`
- `JOB_ENABLED_ACT_KINDS`
- `JOB_RESERVED_ACT_KINDS`
- `JOB_PLAN_BOUND_SIGNOFF_STAGES`
- `JOB_CONSUMER_AUTH_MODE`
- `JOB_ERROR_CODES`

The exact type-only exports follow. Their existing definitions in
`src/job-contract.ts`, `src/job-source.ts`, `src/job-session.ts`,
`src/job-worker.ts`, `src/job-front.ts` and `src/job-hub.ts` are reexported
without aliases or copied wire shapes.

- `JobHubOptions`
- `JobHubJobOptions`
- `JobHubJob`
- `JobOwnerHub`
- `JobHostOptions`
- `JobOwnerHost`
- `JobSessionOptions`
- `JobSession`
- `JobWorkerOptions`
- `JobPublicationReader`
- `JobPublishedContext`
- `JobEnabledActKind`
- `JobReservedActKind`
- `JobActKind`
- `JobSha256`
- `JobId`
- `JobPublicationId`
- `JobAskId`
- `JobActId`
- `JobCursor`
- `JobFileIdentity`
- `JobPlanStepIdentity`
- `JobPlanIdentity`
- `JobPartsManifestPath`
- `JobPartImagePath`
- `JobPartsIdentity`
- `JobPartsRole`
- `JobPartsFileReference`
- `JobPartsEnumerator`
- `JobSelector`
- `JobSourceBinding`
- `JobModelSourceBinding`
- `JobImageSourceBinding`
- `JobImageSetInput`
- `JobImageSet`
- `JobCapabilities`
- `JobModelReviewValue`
- `JobImageReviewValue`
- `JobReviewerBinding`
- `JobHumanAuthority`
- `JobVerdict`
- `JobPartOutcome`
- `JobReviewStage`
- `JobActValues`
- `JobUIActValues`
- `JobActSources`
- `JobAct`
- `JobSubject`
- `JobPendingAsk`
- `JobPublication`
- `JobStatus`
- `JobPublishRequest`
- `JobAskRequest`
- `JobNextRequest`
- `JobCloseRequest`
- `JobAgentRequest`
- `JobFetchActRequest`
- `JobErrorCode`
- `JobFailure`
- `JobResult`
- `JobEvent`
- `JobNextValue`
- `JobResponseValues`
- `JobApiResponse`
- `JobUISubmission`
- `JobDisplayAcknowledgment`
- `JobDisplayReceipt`
- `JobDisplayPublication`
- `JobHostPorts`
- `JobConsumerGrant`

## Parts enumeration boundary

C4 binds the exact public `partsFileReferences(dir)` array from `@rig-c/parts/src/parts.ts`, whose contract is frozen at Parts 2.25.0. The trusted host resolves an installed version in `JOB_PARTS_ENUMERATOR_RANGE` (`>=2.25.0 <3.0.0`), supplies its actual version and official callback through `partsEnumerator`, and declares `partsEnumeratorId`. `JobPartsIdentity.enumeratorVersion` carries that actual version. Manifest paths are work-root-relative and image paths are relative to the manifest directory. Each image carries `path`, bounded-string `role` and raw-byte `sha256`. Review compares the claimed array positionally with the official array, preserving its role/order/duplicate semantics. Upstream roles include `part`, `alternate`, `depth`, `painting` and `figure_mask`. Review bounds shape and paths, refuses traversal/symlinks, decodes PNGs and hashes retained bytes. Missing references refuse with row, role and path, including a missing sibling figure mask when a render copy exists. Unreferenced extras stay outside this parts identity. Composite source hashes use `rig-review-job-source/2`. Create #184 production reader/projection and official-hook wiring remain pending.

The directory passed to the public callback holds the retained `parts.json` bytes. The original paths resolve from the directory holding the bound manifest. The host owns the official import and same-installation version check. A supplied version string alone does not authenticate a replaced callback. Review has no Parts runtime dependency and never installs the producer. Its dev-only 2.25.1 fixture is synthetic reference evidence. Missing or out-of-range versions name the required range and received value through `PARTS_ENUMERATOR_VERSION_MISMATCH`. A claimed version differing from the host installation also refuses.

Rows are capped at 4096, roles at 128 UTF-16 code units and literal paths at 4096. Individual raw files and decoded RGBA allocations are bounded at 64 MiB, and unique retained bytes at 256 MiB. Same-path multi-role references retain all rows and seal the physical bytes once. Parts' named manifest refusals are preserved through `PARTS_ENUMERATION_REFUSED`. Consumer refusals include `PARTS_REFERENCE_SET_MISMATCH`, `PARTS_REFERENCE_PATH_REFUSED`, `PARTS_REFERENCE_MISSING`, `PARTS_REFERENCE_PNG_INVALID`, `PARTS_REFERENCE_HASH_MISMATCH` and `PARTS_REFERENCE_LIMIT`. Details carry bounded row/role/path context where applicable. Failed publication preserves the committed head, source, generation and replay state.

## Installed acceptance

`bun run smoke` packs the package and installs that tarball into an empty project.
A consumer imports the runtime and every listed type through
`@rig-c/review/job-host`. TypeScript checks the installed consumer and the runtime
checks the full owner resources, retained publication, semantic ports, declared
hooks, enumerator version/row carriage, reuse and explicit-close grant lifetime using synthetic host data.
This installed control uses an explicitly synthetic injected enumerator. Production
Create integration and official-import evidence have their separate acceptance gates.

The declared export-removal control deletes only `./job-host` from the disposable
installed manifest and requires the public import to fail for that missing
subpath. It restores the exact manifest bytes, verifies their SHA-256 and imports
again. The smoke prints the planned RED's raw exit and diagnostic. This control
runs inside the ordinary installed smoke, alongside existing CLI coverage.
