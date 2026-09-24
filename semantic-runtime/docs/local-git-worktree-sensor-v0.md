# Local Git worktree sensor v0

`LocalGitWorktreeSensor` turns selected, enrolled worktree observations into
actual durable `GIT_DIFF` events. It is a callable local module. It installs no
watcher, hook, plugin, listener, timer or App action; a host owns notification and
calling `drain`. Ordinary Git/editor work never waits for a successful capture.

The sensor composes the actual `GitProjectRegistry`, `ProjectActivation` and
`DurableIngress` with the same `DomainStore` and credential authority. It adds
no database namespace or durable queue. The supplied store must include all
namespaces required by these components, including `source-invalidation`.
Opening/migrating a store and minting credentials remain explicit owner work.

## Select an actual source

An owner first uses the existing `ingress.registerSource` API. Select the
`repository_id`, `checkout_id`, `worktree_id` and installation from the current
Git registry, including worktrees outside the original folder. Source configuration
must contain:

```js
{
  partition: { tenant_id, project_id, source_installation_id, partition_id },
  producer: { producer_id: 'git-sensor', epoch: 'explicit-source-incarnation' },
  producer_principal_id: ownerPrincipal,
  start_sequence: 0,
  execution: { repository_id, checkout_id, worktree_id },
  mapping: { schema_version: 1, mapping_id: 'git-sensor', revision: 'v1',
    event_types: { git_worktree_snapshot: 'GIT_DIFF' } },
  access: { enabled: true, allow_snapshots: true,
    allowed_principal_ids: [ownerPrincipal], sensitivity: 'normal' }
}
```

The sensor receives the returned `registration_id`; it never accepts a source
catalog, path, fabricated host Session or exploration enrollment from a client.
There is no automatic registration or hidden retry of a failed registration.
The producer principal must be the current authenticated caller.

```js
import { LocalGitWorktreeSensor } from './src/index.mjs';

const sensor = new LocalGitWorktreeSensor({ store, authority });
sensor.bind(context, { registration_id });
sensor.hint({ registration_id });
const result = await sensor.drain(context, { limit: 1, force: true });
const status = sensor.status(context, { registration_id });
sensor.close();
```

`bind` selects configuration and returns the registered execution tuple and
`state:'bound'`; it can run while the Project is disabled and does not read
worktree content. Each actual capture uses the current enabled epoch. A
branch-only ref cannot stand in for a worktree. Deleted/recreated physical
membership is a gap; the owner uses existing refresh/enrollment operations.
No neighboring-folder discovery or clone deduplication happens here.

| Method | Actions and behavior |
| --- | --- |
| `bind` / `drain` | `sensor:capture`, `ingress:read`, `ingress:submit`, `store:read`, `store:write`, `project:inspect`, `activation:read`, `activation:admit`; actual producer only |
| `status` | `sensor:read`, `store:read`, `ingress:read`; actual source/current captured access; caller's bound scope only |
| `hint` | Untrusted wake-up hint for a bound ID, no I/O or capture authority |
| `close` | Trusted process capability; abort its child, discard memory, preserve durable history |

Every JSON option is bounded inert data. Accessors and Proxy traps are rejected
before invocation. Scope keys use explicit tuples; slashes inside identity
components cannot cross Project boundaries. The optional `monotonicNow` function
is a trusted scheduling/test capability, never an HTTP/JSON field.

`drain` returns `{status:'drained'|'idle'|'paused', results, more_due}`. Each
result has its registration ID and `accepted`, `duplicate`, `unchanged`,
`pending`, `gap` or `paused`; only an actual committed ingress result carries
a receipt. Pending IDs, bounded codes and counters are scoped. Exceptions and
Git stderr are never returned as repository content.

## What the snapshot says

`validateGitWorktreeObservation` validates the strict version-1 metadata shape.
It records exact Git IDs, catalog version/source pin, observed physical identities,
HEAD/ref and full object format/OID, index digest, staged versus unstaged path/mode/
OID changes, conflict stages, untracked path/lstat metadata and interval gaps.
Paths are relative canonical base64 bytes; decoding into text is a UI choice.

An unborn HEAD has no fabricated commit. The actual HEAD commit, when present,
is immutable provenance. A ref association is only `catalog_observed` when its
actual name and OID match the accepted catalog; otherwise it is unmapped. Host
Session and Execution are `unknown`, and exploration is `unmapped`. Later checkout
or enrollment cannot retarget stored events.

Rename detection is disabled: movement appears as deletion/addition. Binary
changes retain flags and a digest of the complete bounded comparison stream;
patch and file bytes are discarded. Untracked files expose lstat metadata only.
Their content equality is not asserted. Staged Gitlink OID changes are retained;
`submodule_worktrees:'not_observed'` explicitly excludes nested dirty state.
No submodule program, recursion or fetch is performed.

Approved metadata enters actual ingress with the current source ACL and
sensitivity, exact approved bytes and the first capture grant. The internal
snapshot policy approves only the bytes built for that specific operation.
Relative filenames can themselves be sensitive; this capture grants no model or
external destination permission. Absolute source paths, source config contents,
commit messages/authors, transcripts, credentials, file text and patch bodies
are absent from the retained payload and diagnostics.

## Safe bounded comparison

All Git commands run through minimal private scratch metadata with a copied
bounded index and a read-only reference to the source object directory. Nothing
clones/copies object history or changes the source index, refs or config. Source
config bytes are copied under a limit and parsed with `--file --no-includes`
inside that scratch repository. Source-directory Git discovery never loads
include files. Metadata files are opened without following symlinks and with
nonblocking flags, then required to be regular files before any read; an index,
config or HEAD FIFO returns a gap without waiting for a writer. HEAD and selected loose/packed ref metadata are read with bounds;
unsupported symbolic chains, alternate object stores and ref formats are refused.

Git receives fixed argv and a clean environment with hooks, fsmonitor, pager,
external diff/textconv/filter commands, inherited config, transport and lazy fetch
disabled. Worktree conversion semantics are not emulated. Filter/encoding/text/EOL/
ident conversions, sparse/split indexes and assume-unchanged/skip-worktree entries
produce `unsupported_profile`. Tracked parent symlinks and unsafe metadata symlinks
are refused. The sensor does not claim an OS sandbox against a malicious local
process that continuously swaps filesystem objects between checks.

A copied index's fresh timestamp can incorrectly hide a same-size edit. Only
the scratch index receives a nonzero conservative timestamp (one second after
the Unix epoch), forcing Git's own racy-entry byte comparisons. Tracked leaves
with earlier mtimes are explicitly unsupported. Index flags and intent-to-add/
conflict semantics remain unchanged; there is no custom index reconstruction.

Untracked discovery uses repository `.gitignore` rules; it deliberately does not
load global exclusions or source `.git/info/exclude`. Ignore patterns and Git
attributes are transient control metadata, not captured file bodies. Binary and
text comparison streams are bounded before hashing. A truncated stream never
becomes a full digest.

Two equal complete passes plus before/after identity, HEAD, index, config and
attribute checks establish **observed stable endpoints**. One additional pass
may settle a detected edit. This is not an atomic filesystem snapshot, historical
branch-incarnation certification or proof against unobserved A→B→A changes.
Permission changes are rechecked between work and at the actual ingress commit.
Cross-process disable cannot recall an already started read, but late old-epoch
intake is rejected. Any later activation requires a new current-state observation,
not disabled-period backfill.

| Bound | Value |
| --- | --- |
| Bound sources / coalesced hints | 128 |
| Quiet debounce / maximum wait | 250 ms / 2 s; host calls `drain` |
| Work per drain | 1–4 sources; one sample in flight |
| Pending intake envelopes | One, in memory |
| Submit attempts | At most three explicit calls |
| Source index | 8 MiB |
| Child output / timeout | 2 MiB retained combined output / 5 s |
| Entire sample | 15 s, including bounded resample |
| Changed/unmerged/untracked entries | 256 total |
| Relative path / approved metadata | 4096 bytes / 48 KiB |

A larger tracked tree can also exceed output or deadline bounds even when few
paths changed. It returns a gap; this module does not claim arbitrary repository
size or native conversion fidelity. Source cursor capacity remains the inherited
4096 entries and tighter 1 MiB row. A capacity result stops the binding for the
rest of the process; further hints pause without recapturing. Rebinding does not
reset it. Restart still faces the same durable ingress capacity; there is no
pruning, checkpoint or producer-epoch rotation.

## Retry and gaps

Every fresh snapshot uses `producer.sequence:null` and no fabricated causal
parent. Its cursor entry is unordered and cannot establish a source watermark or
complete history. Coalescing suppresses an unchanged snapshot within a running
binding. Restart or another observer may create another independent observation.

One exact raw envelope, approved bytes, epoch and retry key stay in memory during
retry. The sensor first checks an authorized existing receipt and its exact
raw/payload/epoch, so a lost response after commit reconciles the original pins.
There is no second durable collector queue. Temporary failures retain that one
copy; exhaustion or changed authority/epoch/membership drops it with a bounded
gap. Unknown admission is distinguished from a confirmed rejection. Neither a
transport error nor a local status means successful intake.

A later admitted snapshot can carry a bounded in-memory gap summary. New
processes always state that the preceding interval is unknown. If storage or
authority is unavailable, no claim is made that the gap was persisted. There is
no exact missed-change count, automatic replay, downstream handoff, semantic
completion, Graph mutation or model call.

## Verification

`node --test test/sources/git-worktree-sensor.test.mjs` uses only new temporary synthetic
repositories and SQLite. It covers real external worktrees, SHA-1/SHA-256,
unborn/detached/packed refs, staged/unstaged/binary/Gitlink/conflict/intent-to-add
state, exact pathname bytes, races, source ACL/activation/expiry, cancellation,
actual committed intake and lost-response retry, source metadata preservation,
malicious helpers, config include FIFOs and bounded failure behavior.

macOS rejects non-UTF8 filesystem names; the real filesystem test uses exact
UTF-8 plus newline bytes, while the wire validator separately proves arbitrary
non-UTF8 byte preservation. Capacity-inheritance classification uses a typed
fault fixture; actual durable cursor capacity has its own ingress conformance.
The synthetic capture measurement is in
`test/fixtures/git-sensor/measurement.json`; it contains only counts, timing and
configured bounds. It is a local fixture measurement, not a throughput promise.
