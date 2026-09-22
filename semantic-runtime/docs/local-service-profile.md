# Local bootstrap profile

This is a working local process/storage entry point, not the complete VibeHub
App. It exposes a small status page, process health and database readiness.
Project registration, authentication, domain migrations, collection, semantic
processing, provider keys and Workers remain in their own Tickets.

## Run, check and stop

Use Node 24 (or the component's supported Node 22.13+; Node 23 requires 23.4+).
SQLite is bundled with Node; no database daemon, Docker, cloud account or new
runtime dependency is needed. Dependency versions remain pinned in the lockfile.

```sh
cd semantic-runtime
npm ci --ignore-scripts
npm start
```

Open the printed `http://127.0.0.1:4310` URL. To check from another terminal:

```sh
cd semantic-runtime
npm run status
```

Stop with **Ctrl+C** in the launch terminal, or SIGTERM to that process. Shutdown
closes connections and SQLite; it never removes stored data. Closing the browser
does not stop the process. Start again with the same command to reuse its data.
There is no global daemon registration, PID registry or process-killing endpoint.

Use `npm start -- --port 0` if the default port is occupied; check the actual
printed port with `npm run status -- --port <port>`. `--data-dir <path>` selects
an explicit alternative data directory; relative paths resolve from your launch
directory. The default always resolves beside the component, not the caller's cwd:
`semantic-runtime/.local/app/bootstrap.sqlite`.

## Process and storage boundaries

- One Node process, bound to **127.0.0.1**. No configurable public bind address.
- One SQLite bootstrap database in WAL mode, `synchronous=FULL`, 1-second busy
  timeout. A small timestamp row proves initialization persists. It uses its own
  application ID/schema v1; unknown/nonempty foreign stores are rejected.
- This is a bootstrap database, separate from Phase 0 replay/audit and future
  domain storage. Startup is idempotent; it does not upgrade a domain schema,
  delete files or inspect a project directory. The storage/migration Ticket will
  own domain tables and their compatibility contract.
- `GET /healthz` reports process liveness. `GET /readyz` checks the bootstrap row
  is readable and returns 503 on failure. Readiness is not a capacity, permission
  or semantic-quality guarantee. No filesystem paths or credentials are returned.
- `GET /` is a read-only status page. Unknown paths are 404, other methods 405.
  Host/Origin validation rejects rebinding and cross-origin reads; no CORS is
  enabled. These checks are not identity/authentication. Only nonsensitive
  bootstrap status is exposed until the separate local service-auth Ticket lands.

Default generated state and SQLite sidecars are ignored by Git. Store provider
credentials separately through the forthcoming secure-settings interface, never
in this bootstrap database. The process does not load `.env.local`, invoke a
model, connect a host plugin or collect any message.

Invalid options, unusable storage, unsupported Node and occupied ports produce a
nonzero exit with an actionable error. Runtime failure cannot block an existing
coding agent because no hooks are installed and no Git operations are intercepted.

## Verification and choice

`node --test test/local-service.test.mjs` exercises real loopback HTTP, SQLite and
child processes: startup, status, both stop signals, restart/data preservation,
occupied port, invalid configuration, foreign/corrupt/unavailable storage,
readiness versus liveness and bounded HTTP exposure. These checks run in
`npm run verify` and the isolated `npm run verify:standalone` copy as well.

Choose this simple SQLite local profile under Tech Design §18.1. The completed
Node/Postgres spike remains relevant to a later hosted deployment; it does not
make PostgreSQL a dependency of a one-person local app. No hosted SLOs, complete
app behavior or live provider/Worker performance are established by this profile.
