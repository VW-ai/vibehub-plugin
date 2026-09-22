# Optional linux/amd64 rehearsal of this disposable harness only. Not a service image.
# Build context: semantic-runtime/. Not executed for the macOS report.
FROM node:24.21.0-bookworm-slim AS node
FROM postgres:17.11-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
WORKDIR /opt/runtime
COPY package.json package-lock.json ./
RUN node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY spikes/platform-node-postgres/package.json spikes/platform-node-postgres/package-lock.json ./spikes/platform-node-postgres/
RUN cd spikes/platform-node-postgres && node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund
COPY spikes/platform-node-postgres/auth.mjs spikes/platform-node-postgres/service.mjs spikes/platform-node-postgres/executor.mjs spikes/platform-node-postgres/run.mjs spikes/platform-node-postgres/check.mjs spikes/platform-node-postgres/schema.sql spikes/platform-node-postgres/fixture.json ./spikes/platform-node-postgres/
RUN mkdir .local && chown postgres:postgres .local
USER postgres
ENV SPIKE_PG_BIN=/usr/lib/postgresql/17/bin
RUN node spikes/platform-node-postgres/check.mjs
ENTRYPOINT ["node", "spikes/platform-node-postgres/run.mjs"]
