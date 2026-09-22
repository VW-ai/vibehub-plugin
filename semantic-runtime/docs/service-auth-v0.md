# Local authentication boundary

This extends the single-process bootstrap, without a login server or additional
database. `startLocalRuntime()` returns an `auth` capability to its trusted local
process owner. `auth.issue({ principal_id, kind, scope, actions, audience, ttl_ms })`
creates a random 256-bit credential, returns it once and retains only its digest
and grant in memory. The default expiry is 15 minutes, maximum one hour. Revocation
by credential ID, expiry and service restart all invalidate previously authenticated
contexts. Active credentials are bounded at 1024; expired entries are removed.

The principal kinds are human, host-adapter, service, connector and worker.
Connector/worker kinds have conformance coverage only; no enrollment infrastructure
is implied. API-provider keys cannot authenticate to the service.

There is no HTTP mint/refresh endpoint, token URL, browser storage or log output.
App pairing, UI login and persistent plugin enrollment belong to later composition.
Do not copy provider credentials into the issuer. The local OS process owner is
trusted; this does not isolate mutually hostile processes with the same OS account.

## HTTP and adapter conformance

`GET /v1/session` requires exactly one `Authorization: Bearer …` header, explicit
`X-VibeHub-Tenant` / `X-VibeHub-Project` headers, the `vibehub-local-api` audience,
`session:read` action and a human/host-adapter/service kind. Host/Origin checks from
the bootstrap still apply. The reply contains only principal kind/ID, scope and
expiry; it is an authentication inspection endpoint, **not** a registered host
Session or evidence that a Collector is attached. Missing scope is 400, absent or
invalid credential 401, denied scope/action/audience/kind 403. Nonsensitive health
and readiness remain public. Errors never echo credential, headers or request body.

`scopedReference(kind, scope, id)` constructs typed, collision-safe references for
HTTP, object pointers, queues and subscriptions. `evaluateServiceAccess` is pure
policy over a trusted grant, not a token verifier. Transports use
`LocalCredentialAuthority.authorize` / `authorizeLocalRequest` to get an opaque
in-process context. Copying, JSON round-tripping or fabricating that context cannot
authenticate it. `inspect` and `materialize` check expiry/revocation again.

Future adapters must apply these conformance checks at their actual read/dispatch
boundary. Passing the fixtures is not permission to omit their own authentication.

## Source materialization

`auth.materialize(context, { scope, sources, destination, tenant_policy })` returns
bounded denial or authorized scoped **pointers**, never raw source text. Each source
must provide a current ACL `{ revision, allowed_principal_ids }`, classification,
`local_only` boolean and provider allowlist. Every supporting source must authorize
the principal. The highest sensitivity must fit the tenant policy. External model
dispatch additionally needs the `model:dispatch` grant, tenant allowlist and every
source's allowlist; local-only sources cannot take an external route.

Selected pointers remain marked `content_trust: "untrusted"`. Source content,
including instructions it contains, never grants service authority. Unknown ACL,
classification or policy fails closed. Source adapters must supply current ACLs
and source revisions, recheck at final dispatch after asynchronous work, enforce
invalidation, and scan resolved content for secrets before sending it to a model.
This Ticket does not implement arbitrary raw-content secret recognition or source
fetching. The gate cannot establish freshness from a caller's stale snapshot.

`accessDiagnostic` projects only fixed diagnostic fields/reasons. Do not log raw
request objects, SDK errors or issuer return values. Synthetic canary tests cover
bearer/model/Git/connector/deployment credentials across these new boundaries; they
do not claim that every future payload is automatically free of secrets.

Run `node --test test/service-auth.test.mjs test/local-service.test.mjs` for actual
loopback requests, scoped negative cases, source intersections, expiry, revocation,
restart, duplicate Authorization headers and credential persistence checks.
