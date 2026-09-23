# Project / Exploration UX research

This directory keeps the disconnected Project / Exploration interaction study,
its synthetic fixtures, and its design record together. It is research input
for the product; it is not the connected local Runtime App in `src/app/local`.

From the repository root:

```sh
node semantic-runtime/research/ux/project-exploration/serve.mjs 51987
node --test semantic-runtime/research/ux/project-exploration/prototype.test.mjs
node --check semantic-runtime/research/ux/project-exploration/app.mjs
node --check semantic-runtime/research/ux/project-exploration/fixtures.mjs
node --check semantic-runtime/research/ux/project-exploration/serve.mjs
```

Open `http://127.0.0.1:51987/` after starting the server. The server exposes only
the checked-in static assets in this directory and accepts loopback GET/HEAD
requests. The UI uses fictional projects, people, Tickets, Context, worktrees,
provider state, and work requests. State exists only in page memory and reset or
reload removes it.

The prototype does not inspect a repository, call the Runtime, read credentials,
invoke a model or host subscription, write canonical state, or prove that its
proposed workflows are approved. Product behavior, service contracts, and open
design choices are documented in
[`project-exploration-ux-v0.md`](project-exploration-ux-v0.md).
