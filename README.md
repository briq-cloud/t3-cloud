# T3 Cloud

This repository builds the standalone `ghcr.io/briq-cloud/t3-cloud` image. The
Dockerfile uses the pinned T3 source, runtime versions, and locked dependencies in
this repository. Pull requests run runtime tests and offline image checks; an
explicitly dispatched release publishes an immutable date tag and `latest`.

Build locally with `docker build --platform linux/amd64 --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) -t t3-cloud:local .` and run the runtime checks
with `npm ci --ignore-scripts && npm test`. The image build fetches the pinned
upstream source and verified release artifacts.

## Connections

The public listener serves native T3 at `/` and owner connection management at `/_cloud/`.
Native T3 retains its own authentication. The manager uses a separate owner key and an opaque,
12-hour HttpOnly, SameSite=Strict session cookie (Secure on HTTPS). It never treats a gateway
header as the owner. Management mutations require the configured public Origin.

Set `T3_CLOUD_PUBLIC_ORIGIN` to the exact HTTPS origin and `T3_CLOUD_OWNER_KEY` to a private,
random key of at least 32 bytes. Central mode also requires a distinct private
`T3_CLOUD_EDGE_TOKEN` of at least 32 cookie-compatible ASCII characters for the private sandbox
transport. Open `/_cloud/` and enter only the owner key in its sign-in form. Keep both keys
out of URLs and browser storage. The public `PORT` defaults to 8080. Native T3 and ttyd bind loopback ports 3773 and
7681; expose only the public listener. Native T3 pairing is created by its CLI with a five-minute
expiry. Pairing responses are private and must not be recorded or stored in browser storage.

The default product role is `central`; it additionally requires a stable `T3_CLOUD_OWNER_ID` and the real broker
composition in `central-runtime.mjs`, an absolute `T3_CLOUD_STATE` directory, and a digest-pinned
`T3_CLOUD_CHILD_IMAGE`. The manager calls that same broker for Codex account
operations. Codex uses native device-code sign-in in that single app server; the owner opens
the verification URL and enters the displayed code. It does not start another Codex app server. Native T3's authenticated allocation RPC
calls the local allocation route using a dedicated process-private token, which authorizes no
other management operation. The owner identity comes from server configuration. Allocation
failure must never fall back to executing a central thread locally. The central runtime and
child image need independent security review and execution qualification before release.

The current replay guard keeps unadopted mutation markers across disconnects and restarts.
A WebSocket write callback permits the same live session to continue, but does not prove that
T3 adopted the native outcome. Reconnects cannot start or steer another turn while these
markers remain. Resume history does not clear an unknown outcome. Explicit correlated
reconciliation is not implemented; normal reconnect and sleep/resume are not release-qualified.

The broker also has a candidate scoped operation protocol. It journals an exact request hash
before dispatch and saves the native result before attempting transport delivery. The same
operation can retrieve that saved result across a broker restart; an uncertain operation never
dispatches again. Its adoption call requires a matching result hash, native identity, and event
sequence. The source integration candidate now reserves root intents before native dispatch,
records the returned native identity and result hash, and sends adoption after its first native
start event commits. Startup recovery uses the original intent and a read-only receipt when a
result or committed start exists; it retains the original run, attempt and provider turn rather
than issuing another native mutation. Pending or denied receipts remain parked for reconciliation.
Canonical history can replace partial progress and fill gaps only after the receipt is adopted.
The transport shim still has no reconnect loop, and legacy mutation markers remain quarantined.

The native source candidate adds a central project catalog and source-bound child preparation.
Repository cloning and source control run in the bound child. Native thread launch records the
project source and workspace strategy before allocation; preparation sessions are revoked before
another use of that allocation. Provider status is read from the admitted central provider.
This remains a source candidate: cloud execution, restart recovery and official iPhone use require
acceptance. Claude cloud execution remains disabled.

The packaged source patch replays to the exact reviewed source tree. These remain candidate
paths: source checks and patch replay do not qualify native cloud allocation, subscription
execution, restart recovery or deployment.

The explicit diagnostic mode `T3_CLOUD_ROLE=standalone` has native T3 connections, Claude's native sign-in, Briq's native
browser sign-in, pairing, and an owner-protected terminal. Central Codex account operations,
thread allocation and the allocation-scoped Briq broker are unavailable in this mode.
Unrelated direct native MCP connections retain their own authorization.

In central mode, complete managed Briq sign-in through `/_cloud/`. Scoped resource operations
use the official CLI's central credential home, with sign-in, status and operations sharing one
credential owner. No separately copied `BRIQ_MCP_TOKEN` enables this executing-provider path.
Missing or expired CLI authentication leaves the tools unavailable; installed files alone do
not establish an authenticated connection.

The central Codex app server uses its managed `T3_CLOUD_STATE/codex` home and installs the
packaged Briq skill under `.agents/skills`. The broker supplies a separate loopback MCP
capability for each allocation on native thread start and resume. It removes the previous
managed global raw Briq MCP configuration. Unknown config edits, environment policy changes
and skill collisions stop startup. Broad Briq credentials are not forwarded to either provider.
Claude receives an in-process scoped server and the exact packaged guidance in its system
prompt; native Skill discovery, local tools, hooks and subagents remain disabled. Its enablement
gate stays closed pending the required qualification.

Use `briq_catalog` and `briq_docs` for the supported sandbox, postgres and redis recipes.
`briq_run` records newly created descendants; `briq_list` exposes only those resources.
Status, logs, execution, files and lifecycle tools accept their recorded IDs, excluding the
workspace root, central resources and other threads. Repository files and commands continue
through the allocation-bound workspace executor. Unknown mutations require reconciliation,
never automatic replay. Revocation invalidates capabilities and durably records cleanup;
failed descendant cleanup still attempts the exact workspace stop. Recovery checks unresolved
outcomes without replaying a stop.

The credential-free image checks verify central startup, installed Codex version and
configuration, Claude tool policy with fake provider/CLI inputs, and native Codex MCP
start, resume and bounded turns against a local fake Responses provider. The Codex
fixture uses the native app-server and scoped transport, but not the full broker
ledger. These offline checks do not qualify cloud resources, subscription
authentication, remote workspaces, deployment or recovery.

Vendor sign-in runs the installed CLI, preserves its existing credential home, and exposes only
its sign-in URL, device code, and state. The person approves in their own browser. Status comes
from vendor status commands; no token files are read. The vendor helper is a narrow extraction
of the sign-in/status helper, without an application or routing runtime.

The image installs exact locked dependencies, including `ws` 8.22.0, MCP SDK 1.29.0 and
Zod 4.6.5, with production-only `npm ci` and lifecycle scripts disabled. Local `node_modules` are excluded from its build
context. Manager, child and transport processes use the source-pinned Node 26.12.1 runtime;
the image also checks that `/bin/bash` is available for child execution.

Run the bounded manager contract tests with `node --test --test-timeout=20000 manager.test.mjs`.
They use fake adapters and real loopback HTTP/WebSocket services; they do not qualify the broker,
a provider login, the image, or cloud allocation.

To connect the official iPhone app to one preallocated workspace, open `/_cloud/`, sign in as the owner, and use “Pair your iPhone with one workspace”. Find an existing workspace, create a fresh five-minute child pairing, then enter the displayed server URL and code in the official app. The ordinary native exec path may wake an idle workspace; it refuses a user-stopped workspace. This pairs one allocated child: creating phone threads does not allocate more workspaces or provide central fleet management. Pairing codes are displayed only in page memory, with no additional manager or browser persistence; native T3 owns the persistent one-time grant and its consumption/expiry state. Five minutes limits the pairing grant, not the resulting client session. Official iPhone acceptance remains required.


### Central phone admission

A central runtime can use a separately configured HTTPS origin for the official T3 phone app. The private Connections page creates a native five-minute pairing code and QR for that central environment. New threads continue through T3's managed allocator. Existing child pairing still connects one workspace.

Set `T3_CLOUD_NATIVE_ORIGIN` only to the designated secondary HTTPS origin. The manager opens port 8081 for a strict set of native auth, orchestration, signed attachment and RPC WebSocket routes; native port 3773 stays on loopback. Missing configuration leaves this listener disabled. The primary management and terminal endpoint remains private on 8080. The public origin does not serve the web app or `/pair` HTML; the official app reads the QR fragment locally.

Connections exposes pending-code revocation separately from native-session revocation. Clearing a displayed code removes it from the page; use Revoke pending code to invalidate it. Revoking a session uses the native CLI to update T3 access control, then disconnects all public native connections before reporting success. Other authorized clients can reconnect; the revoked session cannot. Private management, terminal and bridge connections stay connected. Signed attachment links are capabilities and may remain usable until expiry. Pairing codes and QR data stay in page memory and clear on expiry, logout, page exit or replacement.

Source checks and synthetic native conformance do not qualify an installed phone or deployment. Release acceptance still requires the official app to pair to the central identity and create two threads with distinct managed workspaces.

### Application runtime activation candidate

The image now has a dependency-free bootstrap loader at `/opt/t3-bootstrap`.
It keeps ports 8080 and the optional phone port 8081 stable while a manager using
the selected release's Node and dependencies listens only on 8082/8083.
The original manager and native frontdoor still enforce authentication, origins,
headers and WebSocket admission. State, vendor homes and native pairing identity
keep their existing paths. New allocations use the child image digest from the
attested release; existing allocations keep their recorded identities.

`RuntimeSupervisor.stageRelease()` accepts local content-addressed blobs and a
GitHub-attested manifest, checks base OS compatibility, and records its digest.
`activate()` durably records the desired release before fencing admission;
`completeDrain()` can finish a live pending drain. The manager checks its actual
broker turns, pending mutations, allocation ledgers and process ownership before
shutdown. Standalone activation is unavailable without a trustworthy native idle
interface. Using the terminal also blocks automatic activation for that process
lifetime, since the current terminal offers no proof that background work ended.

Every selected release is rehashed before execution. Read-only staged files are
an accident guard; the same OS user can change their permissions, so the digest
check is still required. The manifest pins the sandbox base OS digest; an
incompatible base requires an explicit image/bootstrap upgrade. The bootstrap
verifier stays in the base image and cannot be replaced by an application bundle.

The journal records staged, desired, current, phase and activation receipt with
atomic rename and fsync. Admission opens after native HTTP and broker health
checks and the committed receipt. An interrupted transition, unclean process
restart, stale loader lock or failed new runtime stays closed for explicit
reconciliation. The loader never kills a persisted PID, replays a native turn,
or automatically rolls back after a possible state migration.

This local candidate includes owner-authenticated update discovery and download,
manual and opt-in automatic updates, explicit recovery controls, and a release-owned
controller. Installing the bootstrap into an existing home and proving it survives
real sandbox cold boots are incomplete. No production or staging rollout, official-phone update,
GitHub attestation verification against a published release, or end-to-end cloud
activation has been qualified by these tests.

### Initial bootstrap migration

An existing home that predates the loader requires a one-time image replacement.
The application helper only prepares durable evidence; it does not replace an
image or install files into the root filesystem.

Before stopping the old runtime, place a published runtime manifest, its
`runtime-attestation.jsonl`, and content-addressed `blobs/` under the fixed
`$T3_CLOUD_STATE/updates/bootstrap-input/` directory. Run
`node bin/prepare-bootstrap-migration.mjs` with the existing protected
`T3_CLOUD_OWNER_ID` and `T3_CLOUD_CHILD_IMAGE` deployment values and the pinned
target `T3_CLOUD_BOOTSTRAP_BASE_IMAGE` digest. The helper accepts no arguments,
verifies the publisher attestation and staged bytes, and refuses existing loader
or activation history. It inventories only the two legacy lock directories;
login, pairing and native session files are never read.

For a small existing disk, use the separate metadata-only protocol. Put only
`manifest.json` and `runtime-attestation.jsonl` in
`$T3_CLOUD_STATE/updates/bootstrap-image-input/`, then run
`node bin/prepare-bootstrap-metadata.mjs` with the same protected configuration.
It verifies and durably captures signed metadata and records protocol 2,
`mode: target-image`, `phase: metadata-prepared`. It neither downloads an archive
nor installs a release. Protocol 1 preparation remains a fully staged operation.

Stop the exact old runtime and prove its exit before changing the volume, image
or protected environment. Keep the same home and owner identity. After any needed
disk growth, start the exact pinned target image once; it remains management-only.
Explicit recovery checks revisions, the changed boot, signed inventory and legacy
fingerprints, then copies only application paths from that image into a sealed,
content-addressed release. Every file, mode and link is checked against the signed
inventory. Image-source hardlinks are read into independent single-link files;
installed release files must remain single-link. The image is a source of
candidate bytes, not verification authority.
Installation reserves the full file inventory plus filesystem and application
headroom using measured free bytes and inodes.

An interrupted partial installation remains evidence and blocks another copy;
inspect it explicitly. A complete published installation can be reverified and
reused by the same migration. Recovery never copies credentials or restores the
legacy runtime automatically. These local checks do not qualify a real volume
growth or same-home migration.

After image replacement, refresh the deployment's `T3_CLOUD_CHILD_IMAGE` to the
actual replacement digest. Keep the same durable home and owner binding. The new
loader serves only the owner management page until the owner explicitly chooses
**Install prepared runtime and quarantine old bindings**. Recovery requires a
changed kernel boot, matching replacement image/source/base, unchanged legacy
evidence, and the exact prepared runtime. Legacy lock directories are renamed
into migration evidence, never deleted. The selected release becomes the initial
installation with no fabricated activation receipt. Existing bindings remain
quarantined; recovery never replays native work, signs in or pairs a device.

Recovery status reports loader activity through `busy` and a bounded
`recovery.operation` outcome and stage. This observation is process-local;
its absence after restart does not prove that an earlier request had no effects.
Materialization can outlast an HTTP request while the receipt still says
`metadata-prepared`. A client timeout does not cancel recovery. Inspect status
without resending the mutation. An `unresolved` outcome disables recovery and
refuses another reconcile in that loader process; preserve and inspect its evidence.
The reconcile response remains synchronous, not a durable acceptance receipt.

If recovery fails, preserve the receipt, activation journal and evidence.
Unknown process outcomes keep admission closed. A subsequent changed boot can
resume the same migration operation; contradictory history requires inspection.
Local tests do not qualify an existing home's filesystem or phone continuity.
