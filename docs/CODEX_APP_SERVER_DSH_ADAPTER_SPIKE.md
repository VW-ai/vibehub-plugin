# Codex app-server × DSH adapter spike

## Decision

Build the first usable application around the official Codex app-server as its local Chat and Agent runtime, with VibeHub as the durable Task, Context, Evidence and Outcome layer. DeepSeek Harness remains a later, optional compatibility and distribution carrier for people who already use its plugin ecosystem; it does not gate the Codex-first product.

The goal is not a Codex-themed imitation or a second Agent loop. The ordinary experience should feel like Codex because it uses the owner's own Codex Threads, Turns, streaming items, approvals and tools through a locally running app-server. VibeHub adds a Task workbench around that runtime without creating another execution loop or Task database.

## Pinned compatibility envelope

The machine-readable contract is [`packages/codex-adapter/upstream-lock.json`](../packages/codex-adapter/upstream-lock.json).

- Codex npm package `0.147.0`, tag `rust-v0.147.0`, peeled commit `be6e8eac029b183056b7e4402879f15d2c85f61b`.
- Generated v2 app-server schema SHA-256 `f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`.
- DSH `0.1.0-rc.8`, commit `141eb6fef83422698aef7a981029e843e8161534`.
- Node `>=24`, verified on Darwin arm64.

Run `node packages/codex-adapter/probe-schema.mjs` before importing or upgrading either upstream. Any missing required seam or changed protocol identity stops implementation and requires a new compatibility review.

## Ownership

| Layer | Owns | Must not own |
| --- | --- | --- |
| Codex app-server | Auth, model availability, Threads, Turns, streaming items, plan/diff/tool events, approvals, interruption and execution | Canonical VibeHub Task state or DSH navigation |
| Codex-first local application | One app-server process lifecycle, shell, additive VibeHub surfaces, routing and install/remove | A second Agent loop, copied credentials or hidden Task storage |
| Optional DSH compatibility Plugin | Translate the same bounded adapter into official DSH lifecycle, Slots and Theme surfaces for DSH users | Gate the primary product, replace Codex runtime ownership or fork the Task store |
| VibeHub | Task graph, Task↔Codex Thread association, Context, Evidence, Outcome and closeout | Codex internal plan state, model auth or synthetic live presence |

The spike proves that a DSH Profile can start exactly one local app-server, expose only redacted account capability, return `405 read_only` for writes, stop the child with the Profile and restart against the same Codex Thread corpus. That is compatibility proof, not the required carrier for the first product. VibeHub records Task↔Thread identity through a replayable adapter projection; it does not use `localStorage`, SQLite or Agent Team Tasks.

## Protocol findings

The live probe uses official `initialize`, `account/read`, `thread/list`, `thread/start`, `turn/start` and streamed notifications. A real ephemeral Turn completed with the sentinel `VIBEHUB_CODEX_ADAPTER_OK`; a second app-server process recovered a stable existing Thread ID for the same Workspace. A separate ephemeral Turn accepts the byte-exact host-owned handoff built from a disposable synthetic VibeHub repository and is immediately interrupted. This exercises the real transport through the owner's authenticated Codex/OpenAI account—the same model-service boundary as ordinary Codex use—without sending private Project Context; the current repository handoff is covered locally by the same builder and exact serialization tests.

Generated contracts contain ordinary `audio` and `localAudio` Turn inputs. Experimental realtime notifications are present, but realtime request methods are not part of the generated client request schema. With `experimentalApi` enabled, the pinned build recognizes `thread/realtime/start` but the probed ephemeral Thread reports that realtime conversation is unsupported. Production therefore ships ordinary audio input first and treats realtime voice as capability-negotiated, optional and silent when unavailable.

Replay is history, never presence. Only a fresh trusted `turn/started` observation may create a live indicator. `turn/completed` clears it. Canonical VibeHub `CLOSE_OUT` renders as a non-live `RUNNING / VERIFYING` phase and still requires independent closeout; Codex completion never means VibeHub `DONE`.

## Smallest production boundary

1. `packages/codex-adapter`: version translation, process client, Thread/Turn protocol, event projection and Task↔Thread association.
2. Codex-first local shell: familiar sidebar, Thread list, Composer and stream using the owner's Codex runtime data.
3. VibeHub Task bridge: explicit Chat/Thread → Task and Task → Codex Thread operations.
4. Voice: ordinary audio input first; realtime is a separately gated enhancement.
5. Later DSH compatibility Bundle: Profile lifecycle and additive Slot/Theme surfaces only; no direct upstream calls outside the adapter and no effect on the primary product's readiness.

### Focused ecosystem reuse

| Project | Reuse candidate | Boundary |
| --- | --- | --- |
| [`dsh-workbench`](https://github.com/lee259/dsh-workbench) | File tree, preview-tab and captured-diff interaction patterns | Keep its workspace surface optional; Codex app-server remains the tool/event source and it must not own the application shell |
| [`dsh-sidechat`](https://github.com/Mintcolour/dsh-sidechat) | Resizable split geometry, selection-to-side-chat affordance and compact Turn rails | Rebuild the interaction against Codex Thread/Turn identity; do not adopt its DSH Session runtime or relationship store as VibeHub truth |
| [`deepseek-harness-themes`](https://github.com/orxz/deepseek-harness-themes) | Official `ctx.theme` registration and Settings integration pattern | Ship exact Codex light/dark VibeHub tokens rather than importing its unrelated theme catalog |

These are focused components and reference implementations, not a product shell dependency. Do not import a mega-shell that replaces runtime ownership, duplicates navigation or couples VibeHub to unrelated plugin state.

## Stop and fallback rules

- Stop on any machine-contract drift, missing approval round trip, unstable Thread recovery, hidden credential copying, duplicate Agent execution or inability to stop one owned app-server.
- Fall back from realtime to ordinary audio/text without showing microphone-live, transcript-live or audio-output claims.
- Never infer live execution from replay or a completed Turn.
- Never translate Codex plans into VibeHub Tasks automatically.
- Upgrade Codex or DSH only by updating the exact lock, regenerating schema, rerunning the live/Profile probes and reviewing the diff.
