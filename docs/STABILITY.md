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

The runtime entry starts the full owner host with retained publication routes
and shipped HTML, JavaScript and CSS. Raw Requests and the existing A/B ports
preserve capability, origin, size, cancellation and replay checks.

## Named export inventory

The exact runtime exports are listed below. Constants preserve their literal
values from the frozen semantic contract.

- `startJobHost`
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
`src/job-worker.ts` and `src/job-front.ts` are reexported
without aliases or copied wire shapes.

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
