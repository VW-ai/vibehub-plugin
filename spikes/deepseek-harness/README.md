# DeepSeek Harness foundation Spike

This directory contains disposable, pinned feasibility probes. It is not the
production VibeHub runtime.

The exact upstream baseline is recorded in `upstream-lock.json`. Verify a
matching official source checkout with:

```sh
node spikes/deepseek-harness/probe-source.mjs /absolute/path/to/deepseek-harness
```

The `bundle/` package proves the official out-of-tree Bundle/Profile path. With
an isolated Harness home and the pinned CLI installed:

```sh
DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.7 plugin --profile web add \
  ./spikes/deepseek-harness/bundle

DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.7 --profile web --dump-config

DSH_HOME=/tmp/vibehub-dsh-home \
  npx @deepseek-ai/dsh@0.1.0-rc.7 --profile web --port 31807
```

The Bundle adds two no-model human commands. `/vibehub-demo` appends an
explicitly ignorable `vibehub/run` transition record and returns its sequence.
`/vibehub-client-fixture` appends one clearly labelled, closed assistant turn
used only to verify the assistant-action slot without an API credential.

The same package exports a real DSH browser module. In the official Web client
it registers a Context composer control, Graph and Run conversation views, an
assistant-message Fork action backed by `ctx.sessions.fork`, and a persistent
execution overlay. `Open demo Session` registers this repository as a DSH
Workspace in the isolated profile so the proof remains reproducible.

The first live replay attempt intentionally exposed an important rule: an
unknown custom Session event that is neither registered nor marked ignorable
causes DSH to reject restored history. Production VibeHub event types therefore
need an explicit schema/definition and replay test; `ignorable` is only the
disposable Spike fallback.

The temporary profile and upstream checkout stay outside this repository.
