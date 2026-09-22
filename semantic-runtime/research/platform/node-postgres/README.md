# Disposable Node/PostgreSQL platform spike

This is decision evidence, not a deployable Runtime service. It imports only the
Runtime's public entry, owns `pg` and its lockfile, and uses a copied, deliberately
synthetic Worker fixture. It never loads `.env`, accepts a database URL, or reads
repository/session inputs. Its generated signing key lives in harness memory;
children receive only the public key or scoped synthetic token over IPC. The
mock judge binds loopback, receives fixed synthetic text and no authorization key.

The tested stack is **Node 24.21.0, PostgreSQL 17.11, pg 8.16.3, macOS arm64**.
Use Node 24 and PostgreSQL 17 installed separately; point at the database binaries,
not an existing database. `initdb` creates a new mode-0700 `/tmp/vh-ps-*` directory,
with a private Unix socket and TCP disabled. The trust-authenticated Unix socket is
a local harness convenience, not the proposed hosted TLS/password configuration.
PostgreSQL shared memory and loopback HTTP must be permitted by the execution host.

From `semantic-runtime/`:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix spikes/platform-node-postgres
node spikes/platform-node-postgres/check.mjs
SPIKE_PG_BIN=/path/to/postgresql17/bin node spikes/platform-node-postgres/run.mjs
```

The report defaults to ignored `.local/platform-spike/report.json`. A first
positional argument selects another report path. `measured-report.json` is the
intentionally selected sanitized result from the actual standalone run; it includes
all raw latency samples, source/protocol hashes, versions, outcomes and cleanup.
`cleanup-failure-report.json` records a separate deliberately failed startup probe.
Neither report contains tokens, keys, raw HTTP logs or actual project content.

Run outside the parent repository, installing both independent lockfiles:

```sh
SPIKE_PG_BIN=/path/to/postgresql17/bin \
SPIKE_NPM_CLI=/path/to/node24/lib/node_modules/npm/bin/npm-cli.js \
node spikes/platform-node-postgres/standalone.mjs
```

The standalone script copies only Runtime source/manifests and required spike
files. It removes the temporary copy/dependencies afterward. Its source check
covers five copied modules; the in-repository check also covers the sixth,
`standalone.mjs`. `check.mjs` parses imports, permits built-ins and declared
packages, and allows exactly `../../src/index.mjs` outside the spike. It validates
the fixture through the public Worker admission contract. This is a dependency
boundary check, not a security sandbox or service hardening certification.

To exercise cleanup after an intentional early failure (expected exit code 1):

```sh
SPIKE_PG_BIN=/path/to/postgresql17/bin SPIKE_FAIL_PHASE=after-start \
node spikes/platform-node-postgres/run.mjs .local/platform-spike/failure.json
```

The runner stops its own children and database, removes its directory and reports
cleanup even when a proof fails. If database shutdown fails, it preserves the
cluster and returns `cleanup_incomplete`; it will not delete files under a live
server. Temporary official tool installations are not databases and are not removed
by each run. No system PostgreSQL service, Docker daemon or existing cluster is used.

The optional `Dockerfile` copies exact allowlisted source files into a Debian
Node/PostgreSQL harness image. It has no exposed service port and runs as postgres:

```sh
docker build --platform linux/amd64 -f spikes/platform-node-postgres/Dockerfile -t vh-platform-spike .
docker run --rm vh-platform-spike
```

This Docker route was **not built or run**: the local Docker daemon was unavailable.
Its version tags should become verified image digests in the later release Ticket.
The measured macOS result does not substantiate Linux container parity.
`app-spec.template.yaml` describes a future managed service, with deliberately
unresolved image/secret/VPC bindings. It is not valid for immediate provisioning,
does not run this IPC-only harness, and has not been submitted to DigitalOcean.

See [the evaluation](../../docs/platform-evaluation-v0.md) for the matrix,
measurements, proposed host, cost envelope and owner decision.
