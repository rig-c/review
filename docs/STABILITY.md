# Public API stability

## Interview-stage project opening

The additional CLI form is:

```sh
rig-review open /path/to/project --project /path/to/project --picks-dir scratch/review-picks
```

Both root operands must resolve to the same Create project. The picks directory
must already exist, be project-relative and be disjoint from declared inputs.
Omitting both selectors is supported only at `stage: "interview"` without a
recorded draft or a non-null `versions[].review_package`. Demo/build versions
without a review package are allowed. Unrelated files under `derived/` do not
select or manufacture a review package. Explicit `--project-version` and
`--project-draft` retain their strict package joins and never fall back here.
This form is single-target and accepts no additional inspection options;
`feedback` and `control` keep their existing selector requirements.

The existing single-entry workspace opens the interview in its existing modal.
Its internal `/api/review` transport uses `subject: "interview"`, an actual
`project.json` path/hash, source hash, label and availability flags. It carries
no manifest, compiled model, reviewed-package identity or package session.
Model-dependent APIs refuse `MODEL_UNAVAILABLE`. Project, retained option sets
and declared inputs are hash-bound and rechecked; drift refuses
`INTERVIEW_OPTIONS_STALE`. Opening and reading change no source files.
The joined dialog and standing record form use one shared list | image | survey
answer builder. There is no interview Note input. Existing saved or historical
notes remain readable as read-only text and are carried unchanged. Joined picks
omit `note` when none exists; the job act retains its required string field.
Historical records, picks/act/verdict schemas and explicit
version/draft joins retain their existing readers and checks. This introduces
no job API, act schema, consumer contract or package-export change; it does not
replace the active standing review cycle with a picks-file handoff.

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
  JobHostListenerIncarnation, JobHostReuseBinding, JobHostReuseExpectation,
  JobHostAttachField, JobHostAttachFailure,
  JobSessionOptions, JobSession, JobWorkerOptions,
  JobPublicationReader, JobPublishedContext,
} from '@rig-c/review/job-host';

function startJobHost(options: JobHostOptions): Promise<JobOwnerHost>;

type JobHostListenerIncarnation = string;

interface JobHostReuseBinding {
  readonly root: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly reviewer: JobReviewerBinding;
  readonly readerId: string | null;
  readonly bindingId: string | null;
  readonly partsEnumeratorId: string | null;
  readonly partsEnumeratorVersion: string | null;
  readonly apiSchema: typeof JOB_API_SCHEMA;
  readonly actSchema: typeof JOB_ACT_SCHEMA;
}

interface JobHostReuseExpectation {
  readonly jobId: JobId;
  readonly origin: string;
  readonly listenerIncarnation: JobHostListenerIncarnation;
  readonly binding: JobHostReuseBinding;
}

type JobHostAttachField =
  | 'jobId' | 'origin' | 'listenerIncarnation'
  | 'root' | 'stateDir' | 'fingerprint'
  | 'reviewer.id' | 'reviewer.role'
  | 'readerId' | 'bindingId' | 'partsEnumeratorId'
  | 'partsEnumeratorVersion' | 'apiSchema' | 'actSchema' | 'port';

type JobHostAttachFailure =
  | {
      readonly code: 'JOB_HOST_ATTACH_REFUSED';
      readonly reason: 'missing' | 'closed' | 'incarnation-missing'
        | 'replaced' | 'read' | 'probe' | 'stopped' | 'race';
      readonly phase: 'input' | 'state' | 'record'
        | 'probe' | 'adoption' | 'acceptance';
    }
  | {
      readonly code: 'JOB_HOST_REUSE_MISMATCH';
      readonly field: JobHostAttachField;
      readonly expected: string | null;
      readonly actual: string | null;
    };

interface JobSessionOptions {
  readonly root: string;
  readonly stateDir: string;
  readonly fingerprint: string;
  readonly reviewer: JobReviewerBinding;
  readonly readPublished?: JobPublicationReader;
  readonly partsEnumerator?: JobPartsEnumerator;
  readonly publicationMode?: JobPublicationMode;
  readonly readRecordPublished?: RecordPublicationReader;
  readonly recordReaderId?: string;
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
  readonly onRefusal?: (event: {
    readonly code: string;
    readonly route: string;
    readonly bytes: number;
    readonly limit?: number;
  }) => void;
  readonly reuseOnly?: {
    readonly expected: JobHostReuseExpectation;
  };
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
  readonly attachment: JobHostReuseExpectation | null;
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

const attached = await startJobHost({
  ...options,
  reuseOnly: {expected},
});

interface InternalJobHostAttachRequest {
  readonly expected: JobHostReuseExpectation;
  readonly observed: {
    readonly root: {readonly dev: number; readonly ino: number};
    readonly stateDir: {readonly dev: number; readonly ino: number};
    readonly store: {readonly dev: number; readonly ino: number};
    readonly record: {readonly dev: number; readonly ino: number};
  };
}

interface InternalJobHostAttachResponse {
  readonly ok: true;
  readonly attachment: JobHostReuseExpectation;
  readonly pid: number;
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
grant after reuse validation on each successful new or ordinary reused startup. The trusted
writer adapter owns its private binding and storage. A callback failure rejects
startup with `JOB_AUTHORITY_REFUSED`. `afterSnapshot` and `afterDirectorySync` are
optional disposable-test boundary hooks inherited from the existing seam.

`onRefusal` observes a newly started listener's refused owner act submissions.
It receives the same event that the listener would otherwise write as a single
JSON line to stdout. A supplied callback replaces that line. Callback failures
leave the HTTP refusal intact. The callback has no compatibility ID and is
owned by the running listener. Ordinary reuse and `reuseOnly` keep the running
listener's observer. See [Owner submit refusals](REVIEW_PACKAGE.md#owner-submit-refusals)
for the event fields and byte accounting.

Each standalone `startJobHost` and internal `startJobWorker` listener start mints a
fresh canonical lowercase UUIDv4 `listenerIncarnation` via `randomUUID()`. The format
matches `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` in
exact lowercase with version `4`, variant `8|9|a|b` and zero leading or trailing
whitespace. Stopping and restarting a listener on the same port, `jobId`, PID and
durable grants rotates `listenerIncarnation`.

`GET /jobs/<jobId>/host` preserves its exact legacy `JobHostRecord` projection, key
order and raw bytes without `listenerIncarnation` or `attachment`. Complete live
binding attestation uses the internal authenticated `POST /jobs/<jobId>/host` route
with the `X-Review-Capability` UI grant and exact normalized `Origin`. That internal
route has no public helper or wire-type export. It accepts
`{expected, observed: {root, stateDir, store, record}}` with safe nonnegative
`{dev, ino}` integers for `root`, `stateDir`, `jobs.sqlite` and
`job-ui/<jobId>.json`, and returns `{ok: true, attachment, pid}` on HTTP 200.

On a newly started standalone host (`reused === false`) or an ordinary reused host
whose descriptor carries `listenerIncarnation` and whose POST attestation succeeds,
`host.attachment` is a detached deeply frozen `JobHostReuseExpectation`. Ordinary
compatible reuse (`reuseOnly` omitted) keeps its `GET /jobs/<jobId>/host`
compatibility decision, `installWriterBinding` invocation timing and `ownerUrl`.
Ordinary reuse returns `attachment: null` when `listenerIncarnation` or the
additional POST attestation is unavailable.

Each `job-ui/<jobId>.json` descriptor, each `POST /jobs/<jobId>/host` request and
each `POST /jobs/<jobId>/host` response has a 65,536-byte (`WORKSPACE_BODY_LIMIT`)
ceiling. When adding `listenerIncarnation` to `job-ui/<jobId>.json` would exceed
65,536 UTF-8 bytes, the writer omits `listenerIncarnation` and writes the compact
legacy descriptor. Ordinary start and reuse still succeed with `attachment: null`,
while strict `reuseOnly` refuses `JOB_HOST_ATTACH_REFUSED` with
`reason: 'incarnation-missing'` and `phase: 'record'`. Opaque hook IDs and
fingerprints are bounded by each 65,536-byte descriptor, request and response
envelope without separate 1,024-byte or 4,096-byte field caps.

`startJobHost` inspects the `reuseOnly` property descriptor before invoking getters.
A `reuseOnly` getter or accessor rejects immediately with `JOB_REQUEST_INVALID`
without invoking the getter. When `reuseOnly` is absent or `undefined`,
`startJobHost` uses the ordinary `{...options}` startup path and preserves existing
ordinary getter, prototype and callback behavior. When `reuseOnly: {expected}` is
provided, `startJobHost` snapshots own data properties (including non-enumerable
declared fields) of `options`, `reviewer`, `partsEnumerator` and
`reuseOnly.expected` (`binding` and `binding.reviewer`) via `Reflect.ownKeys` and
property descriptors before the first `await` or session allocation, retaining
function callbacks by reference. In that strict branch, non-plain objects, symbol
keys, unknown keys and getters or accessors reject immediately with
`JOB_REQUEST_INVALID` without invoking getters.

When `reuseOnly: {expected}` is provided, `startJobHost` validates `expected` against
the snapped caller options (`root`, `stateDir`, `fingerprint`, `reviewer.id`,
`reviewer.role`, `readerId`, `bindingId`, `partsEnumeratorId`,
`partsEnumeratorVersion`, `apiSchema`, `actSchema`, literal
`http://127.0.0.1:<decimal-port>` `origin` in `1..65535` including explicit
`http://127.0.0.1:80`, optional `port` matching the origin port, `jobId` and
canonical lowercase UUIDv4 `listenerIncarnation`). Option, schema, hook presence or
value mismatches reject with `JOB_REQUEST_INVALID`, `JOB_STORED_SCHEMA_MISMATCH`,
`PARTS_ENUMERATOR_VERSION_MISMATCH`, `JOB_HOST_OPTION_ID_INVALID` or
`JOB_HOST_REUSE_MISMATCH` (`field`, `expected` and `actual`). This includes cases
where `expected.binding` has an explicit `null` for an omitted hook ID while the
caller supplies that callback or enumerator, or the reverse.

Strict `reuseOnly: {expected}` bootstrap invokes zero callbacks (`installWriterBinding`,
`readPublished`, `partsEnumerator.enumerate`, `afterSnapshot`, `afterDirectorySync`)
and performs zero job allocations (`JobStore.open`), DDL, `chmod` or journal-mode
changes. Its bootstrap write set is empty on both success and refusal. It resolves
existing `stateDir` without creating directories (`destinationDirectory(..., false)`),
requires private owned entries without symlinks or hardlinks, and refuses SQLite
`-wal`, `-shm` or `-journal` sidecars without running recovery. It inspects existing
`jobs.sqlite` in read-only mode without creating files (`SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW`,
`PRAGMA query_only=ON`), validates `job-ui/<jobId>.json` and PID liveness before
sending credentials, and stages a read-only session for that exact job
(`JobSession.openReadOnly`) before the single final `POST /jobs/<jobId>/host` probe.
After staging, it rechecks `root`, `stateDir`, `store`, `record`, `job-ui`,
descriptor bytes, revision, UI capability and full binding. Any drift refuses
`JOB_HOST_ATTACH_REFUSED` with `reason: 'race'` and `phase: 'adoption'`.

Literal `http://127.0.0.1:<decimal-port>` is preserved in `expected.origin` and
`attachment.origin` including explicit port 80, while the HTTP `Origin` header check
compares against normalized `new URL(origin).origin` (`http://127.0.0.1` for port 80).
The client probe enforces a 1,500 ms total deadline across headers and body
(`AbortSignal.timeout(1500)` plus a bounded body read up to 65,536 bytes within the
remaining time) and `redirect: 'error'` so redirects are refused without following.
Failed or aborted reads cancel and release their readers. The server enforces a
10,000 ms body deadline (`jobBody(request, 65536)`).

After body parsing, the owner executes a synchronous acceptance section inside a
deferred SQLite read transaction (`db.transaction(...).deferred()`). It checks
published, stopped and accepting flags and request abort, verifies UI capability, active job status and full
binding, checks `listenerIncarnation` and captured, current and observed `{dev, ino}`
identities (`root`, `stateDir`, `store`, `record`) plus exact descriptor bytes,
rechecks accepting and abort flags, freezes `{ok: true, attachment, pid}` and
finishes the read transaction. Because the deferred read transaction holds a SQLite
read snapshot while `sealClose` commits with `BEGIN IMMEDIATE`, acceptance and close
execute in a single serial order. A prior committed close returns HTTP 409 with
`reason: 'closed'` and `phase: 'acceptance'`. A concurrent close waits for the read
snapshot, and a close or stop after acceptance is an ordinary subsequent lifecycle
event. Owner stop initiated before or during body parsing returns HTTP
503 with `reason: 'stopped'` and `phase: 'acceptance'`. `JobHostAttachFailure` is a
closed two-member union of `{code: 'JOB_HOST_ATTACH_REFUSED', reason, phase}`
(`reason` in `'missing' | 'closed' | 'incarnation-missing' | 'replaced' | 'read' | 'probe' | 'stopped' | 'race'`
and `phase` in `'input' | 'state' | 'record' | 'probe' | 'adoption' | 'acceptance'`)
and `{code: 'JOB_HOST_REUSE_MISMATCH', field, expected, actual}` (`field` as
`JobHostAttachField`, `expected` and `actual` as `string | null`).

`session` retains its existing trusted-host `JobSession` type, including
`jobId`, `hostCredentials()` and `status()` for bootstrap and inspection.
`JobSession` is exported as a type for `host.session`. The host separates agent, owner UI and writer
credentials through their respective channels. Only explicit semantic `close`
ends a job and revokes its writer grant. `stop()` disposes this host handle and
stops its owned listener. A reused handle (including strict `reuseOnly` with
`reused === true` and non-null `attachment`) disposes only its local session and leaves
the owner listener running. On a strict attached handle, reads use the read-only
SQLite connection. A later semantic write (`publish`, `ask`, `close`, `ackDisplayed`,
`commitUIAct`) lazily reopens the same existing `jobs.sqlite` file with
`SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW` (omitting `SQLITE_OPEN_CREATE`) and
rechecks storage and exact job identity in the first `IMMEDIATE` transaction.

When `handleJobApi` (`POST /jobs/<jobId>/api`) catches a thrown refusal, the failure
envelope `generation: number` reports `session.lastObservedGeneration`. That value is
the last durable generation this session observed successfully in storage, carried in
memory without rereading failing storage inside `catch`. It represents the last
observed session value while preserving the original named refusal code and message
(such as `JOB_STORAGE_FAILED` when SQLite files are removed or replaced) and keeping
the numeric `generation: number` response type unchanged. A failed session
constructor exposes no API ports when its initial storage read fails. Success
responses continue to report current `session.status().generation`.

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

## Changelog

- Breaking, 4.0.0 (#806): remove `startJobHub` and its `JobHubOptions`, `JobHubJobOptions`, `JobHubJob` and `JobOwnerHub` types; the uncalled semantic-job hub is deleted.
- Additive (#987): V3 hosts advertise `progress: true` in the `next` capabilities. The HTTP `progress` verb and optional `subscribeJobPage` port implement [job progress](REVIEW_PACKAGE.md#job-progress). `subscribeJob`, the durable event union, cursors and CLI preserve their existing contracts. The owner front opts into the page stream for V3 hosts, with the published web bundle consuming the extra line. Reload an owner page left open across a host upgrade to load the matching bundle.

## Mesh-edit act compatibility

`rig-review/act@8` is additive to the managed-host act contract. Consumers
narrow on `schema`. @8 uses the @7 envelope and comment rules, with optional
`value.meshEdits` restricted to a `review-verdict` at `stage: "rig-review"` with
`verdict: "changes-requested"`. An edited request may carry an empty comments
array. Rig verdicts without edits use @7 when a comment carries top-level
`context` and @6 otherwise.
Existing @2–@7 decoder entry points, accepted shapes and historical bytes
retain their contracts. The API version, reviewer and consumer grant, and
reserved standalone `mesh-edit` kind keep their current contracts. The legacy
`rig-review-mesh-edit/1` export and `--delta` input keep their existing formats.

Starting in 4.8.0, Review emits @8 for eligible submissions carrying edits.
Create versions below 1.13.0 must not run with Review 4.8.0. Create's exact Review
dependency pin normally prevents this pairing. Review decoders older than 4.7.0
refuse @8 with `JOB_ACT_INVALID`. The consumer's required hash, frame and position
checks are part of the [act@8 wire contract](REVIEW_PACKAGE.md#mesh-edits-on-request-changes-act8).
The host facade adds `parseMeshEditsAct`, `JOB_MESH_EDITS_ACT_SCHEMA` and
the three mesh edit types listed below.

## Chest landmark act compatibility

`rig-review/act@9` carries one or more `value.chestLandmarks` rows on a
compiled rig's Request changes verdict. It accepts optional `meshEdits` and
@7 comment context. Older decoders refuse @9 with `JOB_ACT_INVALID`.
Existing decoders and historical @2–@8 bytes retain their contracts. Mesh-only
submissions still emit @8. See the [act@9 wire contract](REVIEW_PACKAGE.md#chest-landmarks-on-request-changes-act9).

The trusted adapter can detect support through
`JOB_CHEST_LANDMARKS_ACT_SCHEMA`. It supplies the draft's
`contour.bust` spec and required `source.configHash` for a rig publication.
Review verifies both against the retained config and binds them into the source
hash. With the declaration absent, the publication and all historical source
bindings keep their existing shape.

Create must pin a Review release that exports `parseChestLandmarksAct` and
support @9 before publishing the new declaration. Parts consumes the
finalized act through the existing writer grant and source checks.

## Named export inventory

The backend rig-still extension retains the original twelve runtime exports and `JOB_ACT_SCHEMA` at act@2. `JobAct` additionally includes `JobRigReviewAct` at act@3 with top-level `JobRigStill` and `JobPartsVerdictAct` at act@5 (`PartsVerdictValue` with pointed `issues` and `words`, while preserving `JobLegacyPartsVerdictValue` at act@2 for historical acts). The facade adds type-only `JobLegacyAct`, `JobRigReviewAct`, `JobPartsVerdictAct`, `JobLegacyPartsVerdictValue`, `PartsVerdictValue`, `JobPanelComposition`, `PanelComponent`, `JobRigStill` and `JobRigCapture` exports, [Review #563](https://github.com/rig-c/review/issues/563) adds five type-only exports (`JobHostListenerIncarnation`, `JobHostReuseBinding`, `JobHostReuseExpectation`, `JobHostAttachField` and `JobHostAttachFailure`), and [Review #555](https://github.com/rig-c/review/issues/555) adds four type-only interview diagnostic exports (`JobInterviewJson`, `JobInterviewRecord`, `JobInterviewDiagnostic` and `JobInterviewDiagnostics`). [Review #588](https://github.com/rig-c/review/issues/588) activates record mode when `readRecordPublished` and `recordReaderId` are supplied to a host or session (`publicationMode: 'record-and-package'`), serving `rig-review/job-api@3` (`JOB_API_V3_SCHEMA`), `rig-review/act@4` (`JOB_RECORD_ACT_SCHEMA`) and normal owner URL model-free record inspection while keeping default package-only hosts and exact `package-only` `job-ui/<jobId>.json` descriptor bytes at @2 and enforcing `publicationMode` / `recordReaderId` reuse compatibility across ordinary reuse and strict `reuseOnly` attachment. It exports six additional record-mode runtime symbols (`JOB_API_V3_SCHEMA`, `JOB_RECORD_ACT_SCHEMA`, `JOB_RECORD_READER_ID`, `parseRecordAct`, `prepareJobRecordAct` and `prepareJobRecordSource`, for eighteen runtime exports total) and the V3/record type surface listed below. The rig and parts-verdict act revision constants, transport limits and the internal `POST /jobs/<jobId>/host` helper remain internal to their modules. Consumer checks distinguish these act revisions as described in [Rig verdict still backend](REVIEW_PACKAGE.md#rig-verdict-still-backend) and [Model-free record mode and source seam](REVIEW_PACKAGE.md#model-free-record-mode-and-source-seam).

The comments decoder extension adds six functions and four schema constants,
for twenty-eight runtime exports total.
See [Comments decoder contract](REVIEW_PACKAGE.md#comments-decoder-contract).

[Review #714](https://github.com/rig-c/review/issues/714) adds the act@7 decoder
`parseContextCommentsAct` and its constant `JOB_COMMENT_CONTEXT_ACT_SCHEMA`
(`rig-review/act@7`), for thirty runtime exports total, plus the type-only
`JobCommentContext`, `JobContextComment` and `JobContextCommentsAct`. The change
is additive: `parseCommentsAct`, `JobComment` and `JobCommentsAct` keep their @6
shapes, and @2–@6 decode unchanged. Starting in 4.8.0, the comments writer
uses @7 when a comment carries top-level `context`. See [Comment context (act@7)](REVIEW_PACKAGE.md#comment-context-act7).

[Review #713](https://github.com/rig-c/review/issues/713) turns on the act@6
writers. `JobAct` widens to `JobLegacyAct | JobRigReviewAct | JobPartsVerdictAct |
JobCommentsAct`, so `JobActV3`, `JobEvent`, `JobEventV3`, `JobNextValue`,
`JobNextValueV3` and `JobHostPorts.commitUIAct` admit fresh act@6 values. No
export is added or removed, and `JobComment` is unchanged. With that change, fresh UI checkpoint,
parts-verdict, rig and direction review-verdict and signoff acts are
`rig-review/act@6`. Image-review verdicts and interview picks stay at act@2, and
record acts stay at act@4. Consumers narrow on `schema`. A consumer's
`Extract<JobAct, {kind: ...}>` alias now also contains the act@6 arm of that
kind. This changes the type on the consumer's next pin and does not break any
runtime reader. Historical act@2–@5 bytes keep their readers.

[Review #646](https://github.com/rig-c/review/issues/646) adds an `interview-picks`
arm to `JobCommentsAct` and `JobCommentsActValues`. `parseCommentsAct` accepts
act@6 picks with the existing package or record option-set binding and ordered
`comments` in the value. Each anchor uses `JobCommentImageAnchor`.
`words` remains a historical field. The @2 and @4 writers keep their encoding,
and picks at @7 and later versions still refuse. Create must pin a compatible
Review reader and release its own reader before Review switches the writer.

[Review #746](https://github.com/rig-c/review/issues/746) adds optional
`feedback: readonly Feedback[]` to `JobUIActValues['review-verdict']` only when
`stage` is `rig-review`; `stage`, `verdict` and required `words` remain.
A present list, including `[]`, supplies the pinned comments through the
existing `feedbackItemComments` mapper and act@6 decoder. It preserves entry
order, text, IDs, frames, target, category and `anchor.context` (including point,
crop, bookmark and valid time-only null-frame evidence). `words` supplies the
legacy general comment only when `feedback` is absent.
Direction and image submissions retain their previous closed shapes. Review
originally wrote this mapping as act@6. Starting in 4.8.0, pinned rig stage
comments can also carry the top-level context described above. Historical
words-only acts still parse.
See [Comments decoder contract](REVIEW_PACKAGE.md#comments-decoder-contract).

The `rig-review` verdict and `parts-verdict` accept optional
`general: readonly string[]` on their UI submission values. The writer appends
each string verbatim as `{text}` after the comments produced by the existing
fields. `words` remains required. On rig verdicts it supplies the legacy general
comment only when `feedback` is absent. On parts verdicts nonblank `words` still
produces one comment after the pinned `issues` and before `general`. A parts
Request changes verdict still requires a pinned issue, and approval still
requires zero issues.
The existing act@6 decoder checks the combined comment count, text and signed
projection. Omitting `general` preserves the existing mapping and serialized
act bytes. Adding `general` by itself keeps the existing schema selection.
[Review #831](https://github.com/rig-c/review/issues/831).

Starting in 4.8.0, fresh assembled Parts issues carry `view.visibleLayers`
with the complete source-bound visible set. Readers still accept historical
anchors without that field. See [Comments decoder contract](REVIEW_PACKAGE.md#comments-decoder-contract).

[Review #914](https://github.com/rig-c/review/issues/914) adds
`JOB_PREVIOUS_DRAFT_SCHEMA` (`rig-review-previous-draft/1`) and the
type-only `JobPreviousDraft`. A publisher may send the optional draft
context field only when installed Review exports that constant. An older
Review ignores the context key and handles its sealed files as ordinary
file identities. The finalized parts act carries the same optional
`source.previousDraft` binding, and a pointed parts comment in that
comparison carries an optional `view.comparison.operand` of
`'previous-draft'`. Both act keys require an admitted declaration.
Legacy publications, source bindings and comments
with the keys absent keep their existing contract. The Review-to-publisher
pin gate applies in its existing direction. See
[Previous accepted draft Difference](REVIEW_PACKAGE.md#previous-accepted-draft-difference).

[Review #914](https://github.com/rig-c/review/issues/914) adds the previous-draft
constant `JOB_PREVIOUS_DRAFT_SCHEMA` (`rig-review-previous-draft/1`), for twenty-nine runtime exports total after the 4.0.0 removal of `startJobHub` and `assertJobImageSetCapability`, plus the type-only `JobPreviousDraft`.

[Review #952](https://github.com/rig-c/review/issues/952) adds the act@8 decoder
`parseMeshEditsAct` and its constant `JOB_MESH_EDITS_ACT_SCHEMA`
(`rig-review/act@8`), for thirty-one runtime exports total, plus the type-only
`JobMeshEditValue`, `JobMeshEdit` and `JobMeshEditsAct`.

### Host-bound act wait

[Review #1005](https://github.com/rig-c/review/issues/1005) adds the host-bound
finalized-act waiter `waitForJobAct`, for thirty-two runtime exports total, plus
the type-only `JobActWaitOptions` and `JobActWaitOutcome`.

```ts
function waitForJobAct(host: JobOwnerHost, options: JobActWaitOptions): Promise<JobActWaitOutcome>;
// options: {after: JobCursor | null; deadlineMs: number; signal?: AbortSignal}
// outcome: {kind: 'act' | 'closed'; next: JobNextValue | JobNextValueV3; cursor}
//        | {kind: 'timeout'; code: 'JOB_NEXT_TIMEOUT'; next: JobNextValue | JobNextValueV3 | null; cursor}
```

The wait sends the host's own API schema. A package-only host gets
`rig-review/job-api@2` and answers `JobNextValue` batches. A
record-and-package host gets `rig-review/job-api@3`, as Create's agents send,
and answers `JobNextValueV3` batches. An act row there may be a
`rig-review/act@4` record act (`JobRecordAct`, checked with `parseRecordAct`)
as well as a package act. The act's own `schema` picks the decoder, so
`rig-review session next --until act` also accepts record acts from a record
host. Its output and exit codes are unchanged.

It is the `rig-review session next --until act` loop, shared code rather than a
copy, sent through `host.ports.handleJobApi` with the host's existing agent
capability. `deadlineMs` is an integer from 1 to 600000. Each server `next`
stays bounded to 30000 ms, and the wait advances the cursor through unrelated
publication and ask events. `cursor` is the cursor to resume from. An invalid
deadline refuses `JOB_REQUEST_INVALID` before any request. A refused `next`
throws its `JobError` code. Abort rejects with the signal's reason and clears
the wait's timers. When an empty server window ends less than a millisecond
before the deadline, the wait sends no zero-wait repeat and sits out the
remainder. The CLI shares this.

A strict `reuseOnly` attachment opens its own read-only session, which the
live host's in-process notifications never reach. Its `next` therefore watches
the shared store's revision with the existing 250 ms subscribe watcher, so a
finalized act the live host commits wakes it. A write that adds no deliverable
event, such as a display receipt, keeps the wait open, and a refused save
commits nothing. No API verb, act field or capability changes.

[Review #990](https://github.com/rig-c/review/issues/990) then adds
`parseChestLandmarksAct` and `JOB_CHEST_LANDMARKS_ACT_SCHEMA`
(`rig-review/act@9`), for thirty-four runtime exports total, plus the type-only
`JobChestLandmarkValue`, `JobPublishedChestLandmark`, `JobChestLandmarkEdit`
and `JobChestLandmarksAct`.

[Review #716](https://github.com/rig-c/review/issues/716) adds the checkpoint
evidence packet validator `parseCheckpointEvidencePacket`, for thirty-five
runtime exports total, plus the type-only `CheckpointEvidencePacketResult`.

The exact runtime exports are listed below. Constants preserve their literal
values from the frozen semantic contract.

- `startJobHost`
- `parseRecordAct`
- `prepareJobRecordAct`
- `prepareJobRecordSource`
- `parseCommentsAct`
- `parseContextCommentsAct`
- `parseMeshEditsAct`
- `parseChestLandmarksAct`
- `parseCheckpointEvidencePacket`
- `projectComments`
- `parseCommentsSession`
- `parseCommentsCompareSession`
- `parseCommentsPartsVerdict`
- `projectSelectedCommentsFeedback`
- `JOB_COMMENTS_ACT_SCHEMA`
- `JOB_COMMENT_CONTEXT_ACT_SCHEMA`
- `JOB_MESH_EDITS_ACT_SCHEMA`
- `JOB_CHEST_LANDMARKS_ACT_SCHEMA`
- `REVIEW_COMMENTS_SESSION_SCHEMA`
- `REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA`
- `PARTS_COMMENTS_VERDICT_SCHEMA`
- `JOB_CAPABILITIES`
- `JOB_API_SCHEMA`
- `JOB_API_V3_SCHEMA`
- `JOB_ACT_SCHEMA`
- `JOB_RECORD_ACT_SCHEMA`
- `JOB_RECORD_READER_ID`
- `JOB_PARTS_ENUMERATOR_RANGE`
- `JOB_PREVIOUS_DRAFT_SCHEMA`
- `JOB_ENABLED_ACT_KINDS`
- `JOB_RESERVED_ACT_KINDS`
- `JOB_PLAN_BOUND_SIGNOFF_STAGES`
- `JOB_CONSUMER_AUTH_MODE`
- `JOB_ERROR_CODES`
- `waitForJobAct`

The exact type-only exports follow. Their existing definitions in
`src/job-contract.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-session.ts`,
`src/job-worker.ts` and `src/job-front.ts` are reexported
without aliases or copied wire shapes.

- `JobHostOptions`
- `JobOwnerHost`
- `JobHostListenerIncarnation`
- `JobHostReuseBinding`
- `JobHostReuseExpectation`
- `JobHostAttachField`
- `JobHostAttachFailure`
- `JobSessionOptions`
- `JobSession`
- `JobWorkerOptions`
- `JobActWaitOptions`
- `JobActWaitOutcome`
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
- `JobPreviousDraft`
- `JobCapabilities`
- `JobCapabilitiesV3`
- `JobModelReviewValue`
- `JobReviewerBinding`
- `JobHumanAuthority`
- `JobVerdict`
- `JobPartOutcome`
- `JobReviewStage`
- `JobLegacyAct`
- `JobRigReviewAct`
- `JobPartsVerdictAct`
- `JobLegacyPartsVerdictValue`
- `PartsVerdictValue`
- `JobPanelComposition`
- `PanelComponent`
- `JobRigStill`
- `JobRigCapture`
- `JobActValues`
- `JobUIActValues`
- `JobActSources`
- `JobAct`
- `JobRecordAct`
- `JobActV3`
- `JobSubject`
- `JobRecordSubject`
- `JobPendingAsk`
- `JobPendingAskV3`
- `JobInterviewJson`
- `JobInterviewRecord`
- `JobInterviewDiagnostic`
- `JobInterviewDiagnostics`
- `JobPublication`
- `JobPublicationV3`
- `JobStatus`
- `JobStatusV3`
- `JobPublishRequest`
- `JobPublishRequestV3`
- `JobPublishResultV3`
- `JobAskRequest`
- `JobAskRequestV3`
- `JobAskBatchRequestV3`
- `JobAskBatchValueV3`
- `JobProgressRequestV3`
- `JobProgressValueV3`
- `JobProgressV3`
- `JobProgressLineV3`
- `JobNextRequest`
- `JobNextRequestV3`
- `JobCloseRequest`
- `JobCloseRequestV3`
- `JobAgentRequest`
- `JobAgentRequestV3`
- `JobFetchActRequest`
- `JobFetchActRequestV3`
- `JobErrorCode`
- `JobFailure`
- `JobResult`
- `JobEvent`
- `JobEventV3`
- `JobNextValue`
- `JobNextValueV3`
- `JobResponseValues`
- `JobResponseValuesV3`
- `JobApiResponse`
- `JobApiResponseV3`
- `JobUISubmission`
- `JobUISubmissionV3`
- `JobDisplayAcknowledgment`
- `JobDisplayReceipt`
- `JobDisplayPublication`
- `JobDisplayPublicationV3`
- `DisplayPublicationV3`
- `JobHostPorts`
- `JobConsumerGrant`
- `JobPublicationMode`
- `JobRecordHostHooks`
- `JobProjectRecord`
- `JobRecordFreeze`
- `JobRecordOptionResult`
- `JobRecordPlanResult`
- `JobRecordResult`
- `JobRecordPartsIdentity`
- `JobRecordActKind`
- `JobRecordSignoffStage`
- `JobRecordPicksSubject`
- `JobRecordCheckpointSubject`
- `JobRecordSignoffSubject`
- `JobRecordReopenSubject` (read-only compatibility: old records and acts parse; new `reopen` asks refuse with `JOB_ASK_INVALID` and Review neither renders nor builds `reopen`, #989)
- `JobRecordPlanSubject`
- `JobRecordSubject`
- `JobRecordContextBase`
- `JobOptionContext`
- `JobPlanContext`
- `JobRecordPublishedContext`
- `JobRecordReaderInput`
- `JobRecordPublicationReader`
- `JobRecordSourceBase`
- `JobOptionSource`
- `JobPlanSource`
- `JobRecordSource`
- `JobSourceV3`
- `JobRecordSignoffValue`
- `JobRecordReopenValue` (read-only compatibility: exported for historical record and act decoders, #989)
- `JobRecordUIActValues`
- `JobRecordUISubmission`
- `JobRetainedRecordSource`
- `JobRetainedSource`
- `JobRetainedSourceV3`
- `JobRootIdentity`
- `JobComment`
- `JobCommentAnchor`
- `JobCommentFeedbackAnchor`
- `JobCommentPartsAnchor`
- `JobCommentImageAnchor`
- `JobCommentsAct`
- `JobCommentsActValues`
- `JobCommentContext`
- `JobContextComment`
- `JobContextCommentsAct`
- `JobMeshEditValue`
- `JobMeshEdit`
- `JobMeshEditsAct`
- `JobChestLandmarkValue`
- `JobPublishedChestLandmark`
- `JobChestLandmarkEdit`
- `JobChestLandmarksAct`
- `ReviewCommentsSession`
- `CompareCommentsSession`
- `PartsCommentsVerdict`
- `CheckpointEvidencePacketResult`

## Parts enumeration boundary

C4 binds the exact public `partsFileReferences(dir)` array from `@rig-c/parts/src/parts.ts`, whose contract is frozen at Parts 2.25.0. The trusted host resolves an installed version in `JOB_PARTS_ENUMERATOR_RANGE` (`>=2.25.0 <3.0.0`), supplies its actual version and official callback through `partsEnumerator`, and declares `partsEnumeratorId`. `JobPartsIdentity.enumeratorVersion` carries that actual version. Manifest paths are work-root-relative and image paths are relative to the manifest directory. Each image carries `path`, bounded-string `role` and raw-byte `sha256`. Review compares the claimed array positionally with the official array, preserving its role/order/duplicate semantics. Upstream roles include `part`, `alternate`, `depth`, `painting` and `figure_mask`. Review bounds shape and paths, refuses traversal/symlinks, decodes PNGs and hashes retained bytes. Missing references refuse with row, role and path, including a missing sibling figure mask when a render copy exists. Unreferenced extras stay outside this parts identity. Composite source hashes use `rig-review-job-source/2`. Create #184 production reader/projection and official-hook wiring remain pending.

The directory passed to the public callback holds the retained `parts.json` bytes. The original paths resolve from the directory holding the bound manifest. The host owns the official import and same-installation version check. A supplied version string alone does not authenticate a replaced callback. Review has no Parts runtime dependency and never installs the producer. Its dev-only 2.25.1 fixture is synthetic reference evidence. Missing or out-of-range versions name the required range and received value through `PARTS_ENUMERATOR_VERSION_MISMATCH`. A claimed version differing from the host installation also refuses.

Rows are capped at 4096, roles at 128 UTF-16 code units and literal paths at 4096. Individual raw files and decoded RGBA allocations are bounded at 64 MiB, and unique retained bytes at 256 MiB. Same-path multi-role references retain all rows and seal the physical bytes once. Parts' named manifest refusals are preserved through `PARTS_ENUMERATION_REFUSED`. Consumer refusals include `PARTS_REFERENCE_SET_MISMATCH`, `PARTS_REFERENCE_PATH_REFUSED`, `PARTS_REFERENCE_MISSING`, `PARTS_REFERENCE_PNG_INVALID`, `PARTS_REFERENCE_HASH_MISMATCH` and `PARTS_REFERENCE_LIMIT`. Details carry bounded row/role/path context where applicable. Failed publication preserves the committed head, source, generation and replay state.

## Installed acceptance

`bun run smoke` packs the package and installs that tarball into an empty project.
A consumer checks the thirty-five runtime exports and the existing managed-host types, including
`JobHostListenerIncarnation`, `JobHostReuseBinding`, `JobHostReuseExpectation`,
`JobHostAttachField`, `JobHostAttachFailure`, `JobInterviewJson`,
`JobInterviewRecord`, `JobInterviewDiagnostic`, `JobInterviewDiagnostics` and
the comments decoder types and the record-mode `JobRecordAct` / `JobActV3` / `JobPlanSource` /
`JobFetchActRequestV3` / `JobRecordHostHooks` / `JobCapabilitiesV3` / `JobAskBatchRequestV3` /
`JobAskBatchValueV3` surface, through `@rig-c/review/job-host`. The consumer also
proves that `JobCapabilitiesV3` carries `askBatch: true`. In `JobCapabilitiesV3`,
`recordPublication`, `recordActSchema` and `askBatch` describe the host rather
than the current head: `ask-batch` applies only to a record-retained head
publication and a package head refuses `JOB_REQUEST_INVALID`, so a consumer
checks the publication's mode as well as the flag.
The #987 contract tests cover the progress capability and the owner page stream
against an attached publisher sharing the persisted job.
TypeScript checks the installed consumer and the runtime checks the full owner
resources, retained publication, semantic ports, declared hooks, enumerator
version/row carriage, ordinary reuse, strict `reuseOnly: {expected}` attachment
(including `JOB_HOST_REUSE_MISMATCH` on a rotated `listenerIncarnation` and
`JOB_HOST_ATTACH_REFUSED` on unavailable attachment), and explicit-close grant
lifetime using synthetic host data. Offline synthetic tarball or linked dependency
consumer probes remain separate from the fresh `bun run smoke` install executed in
hosted PR CI. This installed control uses an explicitly synthetic injected
enumerator. Production Create integration and official-import evidence have their
separate acceptance gates.

The declared export-removal control deletes only `./job-host` from the disposable
installed manifest and requires the public import to fail for that missing
subpath. It restores the exact manifest bytes, verifies their SHA-256 and imports
again. The smoke prints the planned RED's raw exit and diagnostic. This control
runs inside the ordinary installed smoke, alongside existing CLI coverage.

## Record direction-review signoff

Record publications accept `{kind: 'signoff', stage: 'direction-review'}` through
the existing signoff path. Like `plan-approved`, `rigging-interview` and
`post-interview`, it requires a declared subject and non-empty published plan.
Approval binds the frozen record revision through the existing project/source
hashes, with no separate post-version selector or new ask/act field. Existing
stages, schemas and stored act bytes retain their meaning. See the
[record contract](REVIEW_PACKAGE.md#model-free-record-mode-and-source-seam).

The public `JOB_PLAN_BOUND_SIGNOFF_STAGES` remains the original three-entry
package list. The fourth stage is record-only; package `direction-review`
signoffs and historical comments acts still accept a nullable plan.

## Record interview signoff

Record publications also accept `{kind: 'signoff', stage: 'interview'}` through
the existing modal and record act shape. A declared subject and non-empty displayed
plan remain required. The record stage type has five members; the public package
plan-bound list remains at three. Package interview signoffs and historical acts
retain their existing nullable-plan behavior. No schema or runtime export changes.

## Record option sets

An `option-set` publication may carry 2 to 64 sets ([Review #1004](https://github.com/rig-c/review/issues/1004)).
`JobPublishResultV3` gains an optional `sets` (`{questionId, setId}` in order, the
first equal to the result's own `questionId`/`setId`), and the retained record
source gains an optional `optionSets` (each set's `questionId`, `setId`,
`optionSet` and `optionSetFile`). Both are absent for one set, whose source bytes
and `sourceHash` are unchanged. `JOB_ERROR_CODES` gains
`JOB_OPTION_SET_DUPLICATE`, refused on publish when the reader declares two
subjects for one set or `sets` names a set twice. Each ask binds one set, the
asks of one publication stay pending together, and each answer finalizes one
`interview-picks` act (`rig-review/act@4`). At K ≥ 2 that act's `selection`
(`questionId`, `setId`), `optionSet` and `optionSetFile` name the act's own set,
while `subjects`, `optionSets` and `sourceHash` stay the publication's; an act
whose per-act fields disagree refuses `JOB_ACT_INVALID` by name. One set's act
bytes are unchanged. No runtime or type export is added. See the [option-set contract](REVIEW_PACKAGE.md#option-sets).

## Record plan picture

A record-plan publication context and its retained source may carry an optional
`planPicture: {path, sha256}` ([Review #983](https://github.com/rig-c/review/issues/983)):
one raster member of `files` that the record screen draws first. It is refused
on option sets and appended to the record digest only when present, so existing
sources keep their bytes and `sourceHash`. `PlanContext` and `PlanSource` gain the
optional field; no runtime export or error code is added. See the
[plan picture contract](REVIEW_PACKAGE.md#plan-picture).

A pin on the shown plan picture reuses `referenceId` and `referenceHash`
([Review #1048](https://github.com/rig-c/review/issues/1048)). In a record
publication `referenceId` is the path of an entry of that publication's `files`
and `referenceHash` is that entry's sealed sha256. In a rig package `referenceId`
stays the selected bookmark reference. `projectComments` gains an optional second
argument, the record's sealed pictures; with it, such a pin projects the label
`["rig-review-comment/1", mode, "reference", referenceId, referenceHash, x, y, w, h]`
with integer natural-pixel coordinates. Without the argument, and for every other
mark, labels are byte-identical to before. A label that does not parse back refuses
`COMMENT_PICTURE_LABEL_INVALID`. No act field or schema changes. See
[pins on the plan picture](REVIEW_PACKAGE.md#pins-on-the-plan-picture).

## Record interview comments

A record `interview-picks` act (`rig-review/act@4`) may carry an optional, additive
`value.words` ([Review #1048](https://github.com/rig-c/review/issues/1048)): the
reviewer's general and pinned comments as the `projectComments` output, the same
projection checkpoint and signoff carry. It is the last key and present only when
comments exist, so an act without comments keeps its bytes. `parseRecordAct`
accepts it with the checkpoint and signoff `words` check and still refuses any
other extra key. A pin on a sealed question image takes the same label as a plan
picture pin, and `api/interview` adds the image's sealed `path` and `sha256` on
record publications. The schema stays `rig-review/act@4`: Create decodes record
acts through this package's own `parseRecordAct`, so the producer and the parser
move together, an older parser refuses a commented act by name and drops nothing,
and acts without comments are unchanged. `JobActValues['interview-picks']` gains
the optional `words`; no runtime export or error code is added.

## Package manifest `frames` declaration

`rig-review/1` manifests accept an optional `frames` field beside `model`: a
literal package-relative path to a producer `rigc-frames/1` record inside the
package. Review reads, validates and hashes the file only when `frames` is
present, adds its path to `files`, and exposes the parsed record on the loaded
package as `frames: {path, sha256, sets: [{animation, fps, written, stride,
duration}]} | null` (`null` when the field is absent). Older manifests without
`frames` load unchanged with the same `sourceHash` and no runtime or type export
changes on `@rig-c/review/job-host`. Path validation reuses `packagePath` and
`safeFile` (`..`, absolute paths, symlinks escaping the package and files
missing from `sealedPlayback` refuse with the same messages as `model`). A
declared file missing from the package, unreadable JSON, a `spec` other than
`rigc-frames/1`, a malformed set field (`sets[].animation`, `fps`, `written`,
`stride`, `duration`), or two sets naming the same animation refuses by name
(`FRAMES_MISSING`, `FRAMES_JSON`, `FRAMES_SPEC`, `FRAMES_FIELD`,
`FRAMES_DUPLICATE_ANIMATION`), never falling back silently.

The record is the comment frame clock (#1018). On a package with a compiled
model, each set is checked against the model animation it names when the
package loads. The rule is measured from the producer, not from the clip length:
`@rig-c/core` 3.8.0 `rigc render` samples an animation of duration `D` to
`round(D * fps) + 1` frames, frame `i` at `i / fps`, writes every `stride`-th one
from frame 0 and records the last sample's time as `duration`. For example, a
0.8 s clip at 12 fps gives 11 frames and `duration` 0.8333, not 0.8, so a set's
`duration` is not compared with the clip length. A set naming no model animation, a
`written` other than `floor(round(D * fps) / stride) + 1`, or a `duration` more
than `1e-9` s from `round(D * fps) / fps` refuses the package by name
(`FRAMES_ANIMATION_UNKNOWN`, `FRAMES_COUNT_MISMATCH`, `FRAMES_DURATION_MISMATCH`)
where the other `FRAMES_*` refusals surface, and indexes nothing. The refusal
names the animation and both figures, the record's and the model's schedule. The tolerance
covers float rounding only (`i * (1 / fps)` against `i / fps` differs by at most
`7.3e-12` s over 100,000 frames at 1–240 fps). An accepted set becomes the clock
for its animation: `written` frames, frame `i` at `i * stride / fps`. The report's
clock keeps the animation it names; an animation with no set has no clock and its
comments stay time-only. The page's transport and the server's comment validation
read the same per-animation clocks from `feedbackCatalog.frameClocks`
(`[{animation, clock}]`, present only when the package declares `frames` and has a
compiled model), so a pinned comment on such an animation carries
`frame: {index, basis: "producer"}`. Packages without `frames` are unchanged, and
the comment act's shape is unchanged.
