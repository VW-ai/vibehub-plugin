# Codex Projects, Recents, and Fork parity

## Decision

For the Codex carrier, the user-visible **Project** is a thin product name for
Codex app-server's native `ThreadSection`. It is not a repository working
directory, a Codex configuration project layer, a VibeHub Project, or a Task.
This is the smallest mapping that reproduces the requested behavior without a
shadow database:

- Projects are custom `ThreadSection { id, name }`, persisted and versioned by Codex.
- The built-in immutable Pinned section is rendered separately, not mislabeled
  as a user-created Project.
- Chat membership is the nullable `Thread.section` field.
- Recents is the stable `thread/list` query with `sectionId` explicitly `null`.
- Dragging or choosing a destination calls `thread/section/move`.
- Fork calls `thread/fork`, preserves `Thread.forkedFromId`, and then moves the
  new Thread into the source section by default.
- Search is the stable `thread/list.searchTerm` title query across all sections.
- Archive, unarchive, resume, read, name and delete remain native Codex calls.

The executable contract is
[`project-object-contract.json`](proposals/codex-projects/project-object-contract.json)
and the adapter is [`projects.mjs`](../packages/codex-adapter/projects.mjs).

## Exact baseline and sources

The repository lock pins `@openai/codex` `0.147.0`, release tag
`rust-v0.147.0`, peeled commit
`be6e8eac029b183056b7e4402879f15d2c85f61b`, and generated protocol SHA-256
`f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2`.
The local generated-schema probe confirms every method below against that exact
binary.

Primary sources at the pinned commit:

- [app-server API overview](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/README.md)
- [`Thread`, `ThreadSection`, and persisted membership](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
- [fork, list, move, and section request contracts](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
- [restart and section lifecycle integration tests](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/tests/suite/v2/thread_sections.rs)
- [move, clear, and manual-order integration tests](https://github.com/openai/codex/blob/be6e8eac029b183056b7e4402879f15d2c85f61b/codex-rs/app-server/tests/suite/v2/thread_metadata_update.rs)

The Codex source calls this feature a *thread section*. VibeHub may label it
Project because that is the intended user mental model, but the adapter and
research retain the protocol name so we do not claim undocumented Codex
Desktop internals.

## Source-audited capability inventory

| User operation | Exact pinned protocol | Authority and behavior |
| --- | --- | --- |
| List Projects | `threadSection/list` | Codex returns paginated, independently persisted sections, including empty ones. |
| Create Project | `threadSection/create { name }` | Codex creates a stable UUIDv7 section identity. |
| Rename Project | `threadSection/update { sectionId, name }` | Identity is stable across rename. The built-in pinned section cannot be renamed. |
| Delete Project | `threadSection/delete { sectionId }` | Codex deletes the section and atomically returns members to the unsectioned list. It does not delete transcripts. |
| List Project Chats | `thread/list { sectionId, sortKey: "section_position" }` | Codex owns membership and manual thread order. |
| List Recents | `thread/list { sectionId: null, sortKey: "recency_at", archived: false }` | Explicit `null` means only unsectioned non-archived Threads. Omitting the field means every section plus unsectioned. |
| Move or remove | `thread/section/move { threadId, sectionId, beforeThreadId }` | A section ID moves/reorders; `null` removes membership. It does not change cwd or transcript. |
| Fork | `thread/fork { threadId, lastTurnId?, ephemeral: false }` | Codex creates a distinct Thread with copied durable history and `forkedFromId`. VibeHub then requests source-section placement. |
| Search | `thread/list { searchTerm }` | Stable baseline searches extracted title using a case-sensitive substring. Experimental cross-message search is deliberately not required in v1. |
| Resume/read | `thread/resume`, `thread/read` | Codex owns transcript recovery; Projects do not create another conversation record. |
| Archive/restore | `thread/archive`, `thread/unarchive` | Archived Threads are excluded from normal Recents/Project queries. Restore returns the native Thread. |
| Hard delete | `thread/delete` | Codex deletes the Thread and descendants. VibeHub does not intercept or mirror it. |

### What is not present

The pinned `ThreadSection` has only stable `id` and display `name`. There is no
native Project description, icon, VibeHub Room binding, Task ownership, or
automatic relation to repository `cwd`. The protocol has project config layers
resolved from cwd, but those are configuration scope and are not conversation
sections. Moving a Chat between UI Projects does not change where its Agent
runs.

`threadSection/list` also returns the built-in **Pinned** section with fixed ID
`01984de2-8f74-7c91-a3b2-5c5e937cf318`. Source explicitly rejects rename and
delete for it. The shell therefore presents Pinned as its own native group and
excludes it from the custom Project menu while still allowing Thread moves.

Codex does not promise that `thread/fork` inherits a section. The VibeHub
adapter therefore performs a visible two-step composition: create the native
fork, then move it to the source section. If that section disappears during
the race, the fork remains a valid native unsectioned Chat in Recents with its
lineage intact; `placement.applied=false` exposes the fallback. No Thread is
hidden or duplicated.

## Object and ownership model

### Codex Project / `ThreadSection`

Owns only conversation organization: identity, display name, nullable Thread
membership, and ordering. It may contain Chats from different cwd values.

### Codex Chat / `Thread`

Owns conversation identity, cwd, name, history, Turn lifecycle, fork lineage,
archive state, model/runtime metadata and nullable section membership. Codex is
the only transcript authority.

### VibeHub Project

Owns a repository Task graph, Project Room tree and Project Context. A product
may offer an explicit association between a Codex Project and VibeHub Project,
but neither equal names nor dragging a Chat creates that association.

### VibeHub Task

Owns Outcome, Acceptance, constraints, governed Context references, lifecycle,
Evidence and independently adjudicated Outcome. A Task may be standalone or
belong to one VibeHub Project. It may associate with several Chats or Runs.

### Continuous Chat and Task origin

One continuing Chat may birth zero, one or many independent Tasks and then keep
going. Each born Task has one singular immutable provenance locator containing
the exact source Thread, branch/fork lineage, and Turn or selected range. The
source Chat may later move Project, fork, archive, or continue; none of those
operations silently mutates the Task, its VibeHub Project, Context, Evidence or
Outcome. A Chat fork is not a Subtask.

## Executable prototype behavior

The authenticated Codex-first shell now consumes only native state:

- Sidebar Projects render native sections and their member Threads.
- Recents renders only the separate native `sectionId: null` result.
- A Chat may be dragged onto a Project or Recents drop target.
- The Chat header exposes a keyboard-accessible Project selector.
- Create, rename and delete Project actions call the exact section APIs.
- Fork opens the new native Thread, shows lineage, and preserves source Project
  membership through the adapter composition.
- Archive removes the Chat from the normal Sidebar without inventing a new
  VibeHub state.
- Search receives all-section host-owned Thread metadata; the host also exposes
  the native stable title-search action.

The deterministic matrix fixture covers empty Project, projected, unprojected,
forked and archived-not-visible states. It is visual review input only and is
explicitly marked fixture mode. Runtime membership never reads it.
The recorded browser matrix is
[`review-matrix.json`](proposals/codex-projects/review-matrix.json).

## Real-runtime result

`node packages/codex-adapter/probe-projects-live.mjs` ran against the pinned,
authenticated local app-server. It:

1. created a native Project and materialized one persistent Thread with one
   bounded no-tool Turn;
2. moved the Thread into the Project and proved it disappeared from Recents;
3. forked it, proved `forkedFromId`, and placed the fork in the source Project;
4. moved the original out and found it through native title Search;
5. archived the original and proved it did not leak into Recents;
6. restarted app-server and recovered the same Project, member fork and
   lineage;
7. unarchived the original into Recents;
8. deleted the Project and proved its member fork returned to Recents;
9. hard-deleted both temporary Threads, leaving no probe state.

## Upgrade, failure, and removal

- **Schema drift:** `probe-schema.mjs` now requires every Project, move, fork,
  archive and restore method in addition to the existing Thread/Turn contract.
  A missing method or hash mismatch stops upgrade acceptance.
- **Restart:** server-owned section IDs and memberships are recovered by fresh
  list calls. Browser memory is only a render cache.
- **Partial fork placement:** the native fork remains visible in Recents and
  the adapter reports the failed desired placement. Retrying move is
  idempotent and does not duplicate history.
- **Removal:** VibeHub stores no membership mapping, so uninstalling it leaves
  Codex Projects and Chats untouched and requires no migration.
- **Task safety:** membership mutations never call VibeHub Ticket, Context,
  Evidence or Outcome writes.

## Review matrix and downstream boundary

The current slice is production-shaped but not the final visual system. Review
must cover:

- Light and Dark at a normal desktop width;
- 390×844 with the Sidebar opened, no horizontal overflow and readable nested
  Project/Chat hierarchy;
- pointer drag and the keyboard-equivalent header selector;
- focus after opening a Chat and after a move;
- empty Project, Recents-only, projected, moved out, fork lineage,
  archived-not-visible and restart-recovered states;
- failure copy when fork placement falls back to Recents.

Downstream production work still owns polished pointer insertion/reordering,
non-modal Project menus, archived-history browsing, richer native search when a
stable capability appears, exact focus restoration after every mutation,
screen-reader live wording, pagination virtualization and final visual tokens.
None of those gaps requires a second membership or transcript store.
