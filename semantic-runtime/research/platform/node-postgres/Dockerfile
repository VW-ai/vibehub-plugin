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
COPY research/platform/node-postgres/package.json research/platform/node-postgres/package-lock.json ./research/platform/node-postgres/
RUN cd research/platform/node-postgres && node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci --ignore-scripts --no-audit --no-fund
COPY research/platform/node-postgres/auth.mjs research/platform/node-postgres/service.mjs research/platform/node-postgres/executor.mjs research/platform/node-postgres/run.mjs research/platform/node-postgres/check.mjs research/platform/node-postgres/schema.sql research/platform/node-postgres/fixture.json ./research/platform/node-postgres/
RUN mkdir .local && chown postgres:postgres .local
USER postgres
ENV SPIKE_PG_BIN=/usr/lib/postgresql/17/bin
RUN node research/platform/node-postgres/check.mjs
ENTRYPOINT ["node", "research/platform/node-postgres/run.mjs"]
