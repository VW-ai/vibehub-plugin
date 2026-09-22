# Platform evaluation v0

**Recommend Node 24 LTS + PostgreSQL 17, a transactional SQL job table and durable
SSE delivery for the first protected alpha.** The concrete proposed destination is
DigitalOcean App Platform plus Managed PostgreSQL Standard in San Francisco
(`sfo` application / `sfo3` database and VPC). This recommendation awaits the existing
human platform-selection Ticket. It creates no deployment or spending authority.

The [disposable spike](README.md) actually tested
the recommended **Node/PostgreSQL stack locally**, not DigitalOcean infrastructure.
Its isolated install passed 51 checks. Hosting startup, proxy streaming, secrets,
managed failover, PITR, capacity and disaster SLOs remain unmeasured. This distinction
is material: the package supports a platform choice, not service launch acceptance.
No hosted resource, real project input, model account or paid API was used.

## Proposed deployable topology

| Part | Concrete recommendation and boundary |
| --- | --- |
| Runtime | Node 24 LTS, initially pinned to tested 24.21.0; one long-lived Linux amd64 App Platform service, `apps-s-1vcpu-1gb-fixed`, 1 shared vCPU / 1 GiB, no autoscale or scale-to-zero. API, scheduler/reaper and SSE poller share this process initially. |
| Persistence | Managed PostgreSQL Standard 17, current available patched minor (local proof 17.11), 1 GiB / 1 vCPU, initial 10 GiB storage. Separate migration-owner and restricted application roles; TLS with CA verification, private VPC and trusted sources. No production data on ephemeral container disk. |
| Queue | A tenant/project-scoped PostgreSQL job table; transactional enqueue/idempotency and `FOR UPDATE SKIP LOCKED` claim; accepted Job/Attempt protocol owns lease, epoch, deadlines, reservation retention and duplicate receipts. State, receipt and outbox commit together. No Redis or separate message broker in alpha. |
| Realtime | Authenticated `fetch` SSE over HTTPS, persisted scoped outbox and cursor, bounded polling, replay on reconnect, expiry/revocation recheck. Optional LISTEN/NOTIFY is only a wake hint, never durable delivery. |
| Authentication | Invite-only internal alpha: service-signed Ed25519 JWTs, exact issuer/audience/expiry, 15-minute access lifetime, server-owned tenant/project membership and role lookup. Later auth Ticket implements owner-issued revocable bootstrap/refresh capabilities stored as hashes, rotation and real enrollment. No external IdP is required for this bounded alpha; enterprise OIDC is a separate choice. The spike's in-memory issuer proves signatures/scope/revocation only. |
| Secrets | App Platform `RUN_TIME` encrypted SECRET bindings: `DATABASE_URL`, `DATABASE_CA_PEM`, `AUTH_SIGNING_KEY_ED25519`, `JUDGE_ENDPOINT`, `JUDGE_API_KEY`. Values never enter manifests, build args, Context or audit. Rotation overlaps verification keys, revokes old bootstrap credentials and redeploys consumers; rotation has not been tested here. |
| Region | Prefer app `sfo`, database/VPC `sfo3`; alternatives `nyc`/`nyc1`, `fra`/`fra1`, `sgp`/`sgp1`. App VPC datacenter mapping is explicit; add its private egress to database trusted sources. Region choice does not by itself constrain CDN, logs, backups, identity or approved model endpoints. |
| Local/cloud | Existing Local Runtime/SQLite and ordinary Agent/plugin work remain independent of cloud availability. Future adapters buffer within bounds and expose gaps; this spike adds no hot-path network dependency. Private BYO Codex executors retain account credentials locally and enroll with scoped worker identity; they are not an App Platform worker pool. |

Node 24 is LTS, and PostgreSQL 17 remains supported through November 2029;
DigitalOcean currently supports PostgreSQL 17 and 18. Choosing 17 matches this
measured stack and avoids a needless major-version variable. Its minor version
must be rechecked at deployment. [Node releases](https://nodejs.org/en/about/previous-releases),
[PostgreSQL lifecycle](https://www.postgresql.org/support/versioning/),
[managed PostgreSQL limits](https://docs.digitalocean.com/products/databases/postgresql/details/limits/).
The VPC/region and secret primitives come from the
[VPC instructions](https://docs.digitalocean.com/products/app-platform/how-to/enable-vpc/)
and [App Spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/).

## Constraint matrix

Rows distinguish documented platform behavior from the engineering design proposed
here. Cloudflare is a documentation comparison; no Workers deployment was executed.

| Criterion | Workers + per-Project SQLite Durable Object | Node + PostgreSQL |
| --- | --- | --- |
| Local Runtime independence | Cloud sidecar/API only; local work cannot depend on object reachability. | Same boundary; library/core does not import the spike or reach into cloud state. |
| Project serialization/CAS | One object's strongly consistent transactional store fits project state. Recheck versions after external awaits. Cross-object transactions are unavailable. | Conditional revision UPDATE plus short transaction; 24 concurrent pairs in spike committed one winner each. SQL locks can serialize multi-row project operations. |
| Global/project admission | Inference: a coordinator must own global/project reservations and reconcile its commits with project objects. Crashes between reservation and dispatch require an additional fenced state machine. | Inference: lock global/project budget rows in fixed order in the same transaction as dispatch. Full multidimensional admission/fairness is still the scheduler Ticket, not this proof. |
| Queue and leases | SQLite jobs + one alarm per object can multiplex work. At-least-once alarms need idempotency, bounded retries and recovery after retry exhaustion. Queues is optional; its delivery acknowledgement is not the Runtime attempt fence. | SQL table persists pinned protocol state. Competing claims use SKIP LOCKED; lease expiry requeues, new attempt increments fence, stale result cannot commit. External reasoning holds no database lock. |
| Stable links and realtime | HTTPS routing plus hibernating WebSockets; durable cursor/replay and access recheck remain application work. | Stable scoped HTTPS paths plus SSE/outbox; observed notification, replay and revocation. Browser fetch allows bearer headers; native EventSource needs another secure auth design. |
| Outbound model calls | HTTP fetch; six simultaneous outbound connections per request. No local Codex process inside a Worker. | Built-in fetch plus abort deadline, bounded concurrency, approved endpoints. Spike calls only a fixed loopback synthetic judge and returns a bounded failure on HTTP 503. |
| Authentication | Access JWT can be a front door; exact runtime membership/source authorization still belongs to the service. | Scoped signed JWT + membership/role and restricted-role RLS. RLS does not authenticate a bearer or protect against a compromised application role setting scope. |
| Secret management | Encrypted Worker bindings, least privilege, no secrets in graph/audit; provider/worker account separation still required. | Proposed encrypted runtime env bindings and separate migration/app roles; no key in source/build. In-memory synthetic key is not a hosted secrets test. |
| Data locality | EU/US/FedRAMP object jurisdictions; location hints are best effort. Front Worker/logs/model calls need separate placement policy. | Explicit same-region app/DB/VPC; backup geography and allowed model/log destinations need owner policy and later validation. |
| Migration | Versioned object SQL schema; class lifecycle and per-object rollout complicate fleet migration. | Versioned additive SQL migrations, old/new reader compatibility, bounded batches and a schema/policy/image manifest. Major PG upgrades require planned upgrade or dump/reload. |
| Backup | SQLite DO PITR restores one object's database within 30 days. A multi-object consistent recovery epoch is additional work; local PITR is unavailable. | Managed daily backup + WAL, seven-day PITR; restore creates a new primary. Its docs do not establish a maximum archive lag or the Runtime 300s/900s disaster gates. |
| Rollback | Worker code rollback does not reverse state; class/resource changes can prevent rollback. | Deploy prior compatible image and manifest; never treat code rollback as data rollback. An incompatible schema needs forward repair or a separately tested restore. |
| Observable cost | CPU/request, DO active duration, SQL row amplification/storage and optional queue operations are visible drivers; no automatic whole-account spend cap. | Fixed process/DB floor, connections/storage/egress, model and telemetry spend. Disable automatic scaling; budgets/admission and alerts still need implementation. |

Primary references: [DO transactional storage/PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[jurisdictions](https://developers.cloudflare.com/durable-objects/reference/data-location/),
[Workers rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
[PostgreSQL concurrency](https://www.postgresql.org/docs/17/transaction-iso.html),
[queue locking](https://www.postgresql.org/docs/17/sql-select.html),
[RLS](https://www.postgresql.org/docs/17/ddl-rowsecurity.html),
[NOTIFY semantics](https://www.postgresql.org/docs/17/sql-notify.html),
[managed restore](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/).

## Actual proof and measurement

The checked-in [measured report](measured-report.json)
was produced by an actual outside-repository copy with fresh dependency installation.
Node 24.21.0 and PostgreSQL 17.11 came from official release archives verified
against their published SHA-256 checksums. PostgreSQL was built into a temporary
prefix with ICU/readline omitted; this differs from the hosted Debian build.
The machine was macOS 25.5.0 arm64, Apple M2 Max. `fsync`, `synchronous_commit` and
`full_page_writes` were on. PostgreSQL listened only on the private Unix socket.

| Observation | Count | Result (ms) | Exact meaning |
| --- | ---: | --- | --- |
| Fresh Node process startup | 5 | P50 107.319; P95/P99 115.700 | Parent monotonic spawn to child ready IPC, after pool connection and HTTP listen. Warm OS page cache; no serverless, VM, image-pull or hosted cold-start claim. |
| PostgreSQL process start | 1 | 120.680 | Local pg_ctl start and ready wait after initialization. |
| First authenticated request | 1 | 12.544 | Parent HTTP request through complete JSON response over loopback. |
| Warm scoped read | 32 | P95 2.220; P99 2.293 | No graph retrieval/compilation, two tenant/four project rows only. |
| CAS committed winner | 24 pairs | P95 1.628; P99 4.736 | 48 offered writes; 24 expected 409 conflicts, exactly one commit per pair. |
| Durable enqueue request | 1 | 6.119 | HTTP request through commit and response; duplicate is a no-op, changed content conflicts. |
| Queue wait observation | 1 | 465.630 | Parent observes durable ACK to executor's claimed IPC; includes API kill, immediate PostgreSQL restart and new executor startup. This is not the capacity SLI's server-side enqueue-to-attempt interval. |
| Enqueue through started attempt | 1 | 502.653 | Includes enqueue request and the restart fault above. |
| Expire/reclaim/start/fenced completion | 1 | 118.823 | Begins after the actual 1-second lease expired; excludes deliberate expiry wait. |
| SSE delivery | 1 | 24.711 | Before mutation request to subscriber's parsed notification; 20ms polling in this small proof. |
| Mock judge | 1 success + 1 expected 503 | Success 28.727 | Local HTTP with prescribed 15ms delay; no real model performance or price claim. |
| Store and service restart | 1 | 237.388 | pg_ctl restart through service ready; acknowledged state/job survived. Not a backup restore or managed failover. |

All sample arrays and nearest-rank percentiles remain in the report. The small
sample sizes support debugging, not production tails. Expected conflicts and
injected failures remain recorded; they are not silently excluded as success.
No offered proof operation timed out or remained pending in the passing run.

The proof exercised a signed identity, expired/forged/wrong-audience rejection,
wrong tenant/project and missing/revoked membership rejection, and RLS with an
unprivileged non-owner role. State and outbox rolled back together on injected
failure. One job survived API SIGKILL and PostgreSQL immediate shutdown/recovery.
A separate executor durably claimed/started, was SIGKILLed, lost its 1000ms lease,
and was replaced with fence 2. Old completion rejected; new completion and exact
redelivery produced one usage receipt and one proposal-only result event.
Expired-attempt usage stayed unknown/reserved. It used the accepted public Worker
protocol with a 120000ms total deadline, two attempts and exact pinned synthetic
policy/graph inputs; the short lease is within that protocol, not a change to it.
No business continuation or canonical promotion was executed.

SSE replay came from the outbox after disconnect, and revocation closed delivery.
DELETE removed all target project state, jobs, outbox and memberships, preserving
another tenant and another project. Finally the complete temporary cluster/socket
and child processes were removed. The separate
[deliberate failure report](cleanup-failure-report.json)
confirms the same cleanup after a forced failure just after database startup.
This is deletion of synthetic local resources, not a promise of immediate purge
from a managed provider's retained backups.

## Operational limits, risks and deployment handoff

Cloudflare documents 10GB per SQLite DO, soft roughly 1000 requests/s/object,
30-second default CPU allowance (configurable to five minutes), six simultaneous
outbound connections and 100 SQL bound parameters. These are ceilings, not alpha
capacity measurements. [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
The proposed 1GiB DigitalOcean database has 22 available backend connections;
start with a pool of eight, reserve headroom for migrations/health/recovery, and
keep per-request database holds short. [Database limits](https://docs.digitalocean.com/products/databases/postgresql/details/limits/).

App Platform requires Linux amd64 images; local macOS arm64 proof cannot establish
binary/container parity. Its filesystem is ephemeral and capped at 4GiB, and
app HA needs at least two containers. The chosen fixed single instance is an
explicit low-cost alpha tradeoff, with interruption during failures/deployments.
[App Platform limits](https://docs.digitalocean.com/products/app-platform/details/limits/).
Use durable SQL for all authoritative online state, and a bounded outbox poller;
large-scale SSE fanout, slow consumers, retention and cursor pagination remain
service/delivery work. A sequence allocation order is not automatically commit
order: the production outbox must serialize its scoped cursor with the commit,
not blindly copy the spike's global identity counter under concurrent transactions.

The [App Spec template](app-spec.template.yaml)
names the proposed service SKU, region, HTTPS health endpoint, image digest slot
and secret names. The [Dockerfile](Dockerfile)
is an optional isolated Linux rehearsal of the harness, not the production image;
Docker was unavailable so it was not built. The later release creates and pins the
actual Runtime service image/manifest, fills the owner-selected VPC/cluster/team
and encrypted bindings, then validates the generated spec. After that Ticket is
authorized, the deploy interface is `doctl apps create --spec <reviewed-spec>` (or
update the selected app); this command has not been run. Health is `/healthz`
plus authenticated synthetic scope/queue/SSE checks before admitting real sources.

Use expand/contract migrations, with the previous image retaining compatibility
until traffic and jobs drain. Rollback selects the prior image digest and exact
schema/policy compatibility manifest. SQL rollback and ordinary process restart
were tested here; rolling deployments, schema migration/rollback and managed
restore were not. Secret rotation, workers reconnecting after restart, slow/failed
judge calls and split network links need fault tests on the selected service.

Managed PostgreSQL daily backups plus WAL allow PITR within seven days; restore
uses a new cluster, and destroying a cluster destroys its backups. Keep project
tombstones/retention rules and the external release manifest so restored data
cannot silently restore revoked access or dispatch old fenced attempts.
[Backup behavior](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/).
No numerical lag/RTO guarantee was found in those docs. The existing recovery
Ticket must measure **RPO ≤300s / RTO ≤900s**, and the capacity Ticket must retain
**ACK P95/P99 200/500ms, candidate 1.5/5s, query 0.5/1.5s, queue age 1/3s,
worker 90/180s, ≥99% success and ≤300s backlog drain**. Ordinary restart still
requires **RPO 0 for acknowledged events**. This small restart proof does not
establish those full-workload gates, and none has been relaxed or marked passed.

## Alpha cost envelope and rejected alternatives

Prices checked 2026-09-21/22 UTC are public list prices, not an account quote.
The proposal's application is $10/month. The managed 1GiB PostgreSQL page displays
$15.15/month and $0.215/GiB-month storage with a 10GiB minimum. To avoid silently
assuming the selector's inclusion rule, budget **$25.15–27.30/month** for the two
base resources, then request an **up-to-$40/month infrastructure envelope** for
small storage/egress variation. Actual checkout must resolve storage inclusion
before provisioning; no engineering experiment is needed for that billing check.
No standby, extra application replica, paid identity provider or telemetry vendor
is included. Taxes, independent BYO machine/subscription charges and model calls
are additional. [App prices](https://docs.digitalocean.com/products/app-platform/details/pricing/),
[database price table](https://www.digitalocean.com/pricing/managed-databases).

The 1GiB app includes 100GiB monthly bandwidth; traffic mix and retention must be
observed. Provider pricing, model token costs, SQL write/storage amplification,
logs and backup/standby choices dominate uncertainty. The $40 figure is a proposed
owner ceiling, not a platform-enforced cap. Configure billing alerts, bounded
retention, no auto-scaling and explicit pause/review behavior before live use.
A separate explicit model budget and destination remain necessary.

For scale context, one unchanged 26-minute alpha trace offers 6960 events/1740
queries and 3480 prescribed synthetic model calls: 3,563,520 input + 445,440 output
tokens. One trace daily for 30 days would be 104,400 calls and 120,268,800 tokens.
Continuous steady traffic instead means 12.96 million ingress requests/month,
5.184 million model calls and about 5.972 billion tokens. At selected provider
rates `I` and `O` dollars per million tokens, the daily-trace model estimate is
`106.9056 × I + 13.3632 × O`, before retries and worker reasoning. Synthetic calls
here cost zero provider dollars; no inference about real model or subscription
cost follows. Worker usage/entitlement remains measured-or-unknown.

Cloudflare's paid floor is $5/month, including 10M Worker requests/30M CPU-ms,
1M DO requests/400k GB-s, and generous SQLite allowances. Extra DO duration costs
$12.50/M GB-s; queue write/read/delete operations add their own bill if used.
[Worker prices](https://developers.cloudflare.com/workers/platform/pricing/),
[DO prices](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Queue prices](https://developers.cloudflare.com/queues/platform/pricing/).
Inference: a small 26-minute rehearsal daily can fit the $5 infrastructure floor
if objects hibernate outside it and row/request/storage allowances hold. Four
always-active project objects alone consume 1,327,104 GB-s per 30-day month;
at those rates their excess duration is about $11.59, before coordinator, request,
row/storage, model and queue costs. Low-traffic affordability is real, but an SSE
or polling design that prevents hibernation changes the comparison.

We reject Workers+per-project DO **for this first implementation** because atomic
project/global admission plus journal/result accounting would need extra
cross-object recovery machinery, while PostgreSQL offers one transaction boundary.
This is an engineering inference, not a measured claim that Workers is slower.
Workers remains attractive when managed global coordination and hibernating
WebSockets outweigh that complexity. We reject a separate Redis/Kafka queue at
alpha because it adds another state boundary without a demonstrated need.
We reject Render's built-in PITR as the sole recovery mechanism for these targets:
its selectable recovery point excludes the latest ten minutes, exceeding the
required five-minute disaster RPO unless another mechanism is added.
[Render recovery limits](https://render.com/docs/postgresql-backups).

The owner selection can now accept the named Node/PostgreSQL/SSE/auth/secret
combination and DigitalOcean `sfo`/`sfo3` single-instance envelope, choose a different
listed region, or prefer Cloudflare with its coordination cost. Account/team,
region/data-routing policy, accepted single-instance availability and maximum
infrastructure/model spend are explicit human tradeoffs. Hosted deployment and
full recovery/capacity verification stay in their existing downstream Tickets;
this recommendation does not satisfy that human criterion itself.

Research used official Node, PostgreSQL, Cloudflare, DigitalOcean and Render pages
linked above. The smart-search registry preflight found no named vendor adapters;
no OpenCLI site search or AI-answer source was used (0 queries per site). Official
pages were opened directly with the web tool. No account or secret was inspected.
