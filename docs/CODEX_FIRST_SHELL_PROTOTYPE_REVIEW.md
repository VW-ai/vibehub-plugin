# Codex-first VibeHub shell prototype

Status: real-runtime product and architecture prototype for owner review. It is
not final visual approval, a public release, or a DSH dependency.

Run:

```text
npm run shell:codex
```

The host binds only to loopback, starts one local Codex app-server, prints a
fragment-bearer URL, and stops the child runtime with the prototype. The browser
does not receive Codex credentials. Project files change only when the owner
starts a Codex Turn whose approved tools change them; simply opening and
reviewing the prototype is read-only.

## Product promise under review

The ordinary path should feel familiar to a Codex user:

- persistent sidebar, Chat-default landing, native Projects, and semantically exact unprojected Recents;
- drag or keyboard-equivalent Chat movement, native Project create/rename/delete,
  native Fork lineage, and archive/restart recovery;
- typed `⌘K` Search across Codex Threads, VibeHub Tasks, and durable Context;
- a quiet Task Inbox for current Needs You boundaries and successful Outcome history;
- real Codex Thread history and restart recovery;
- real Thread reading and resumption;
- Composer input, image/audio attachments, voice recording and interruption;
- streamed Turn, item, plan, diff, tool and completion events;
- command/file approval and request-user-input boundaries;
- exact Light and Dark Codex primitives.

VibeHub begins where ordinary Codex conversation history stops. It adds Tasks as a
durable work unit, a causal Task Graph, a focused Task Workspace, canonical
Context and Acceptance, Evidence, independent Outcome and return-to-work
posture. Codex owns Threads, Turns, tools, approvals and execution. VibeHub does
not translate Codex plans into Tasks, harvest every Chat, or create a second
Agent loop or Task database.

## Review path

1. Open the prototype and confirm it lands on ordinary Chat. Native Codex
   Thread Sections appear as **Projects**, while only Threads with no section
   membership appear under **Recents**.
2. Drag a Recent Chat into a Project, then use the Chat-header Project selector
   to move it back. Fork it and confirm the new Chat retains native lineage and
   appears in the source Project. Project creation, rename and deletion use the
   same server-owned identities; deleting a Project returns its Chats to Recents.
3. Open an existing Thread and inspect its persisted Turns, tools and output.
4. Start a new Codex Chat, send a text Turn, observe real streaming, and
   interrupt it if desired.
5. Attach an image or record voice. The microphone becomes live only after the
   browser grants access; the resulting recording is sent as ordinary Codex
   `audio` input. Realtime conversation is not claimed by this build.
6. Use `⌘K` Search and confirm Chats, Tasks, and Context remain visibly grouped
   and open their exact owning objects. Open the bell and confirm Running is not
   treated as notification activity.
7. Open Tasks. Select a graph card and inspect the canonical Task Context,
   Acceptance, proof posture and Recommended action.
8. On an executable Task, select **Start in Codex**. The exact host-owned Task
   handoff becomes the first input of one real Codex Thread. Return to the Task
   and confirm the linked Thread is discoverable without browser storage.
9. Switch System → Light → Dark and repeat the Chat, Search, Inbox, Graph and Task loop.
10. Review at a wide desktop size and 390×844. Confirm keyboard focus, sidebar
   drawer behavior, no horizontal overflow and reduced-motion behavior.

## Current composition

The prototype lands on lightweight Chat because that is the native environment
the owner uses today. Tasks is a distinct peer destination, not another name
for Codex Threads, a full-screen overlay, or a separate nested application.
Typed Search bridges Chat, Task and Context without converting them. A quiet
bell and bounded Needs You Sidebar group return important Tasks to the Human;
ordinary Running progress stays inspectable without becoming notification
noise. Selecting a Task replaces the center column with its focused Workspace.
Opening its linked Thread returns to normal Codex Chat inside the same shell.
The user-facing Codex Project is the app-server's native `ThreadSection`; it is
not a VibeHub Project, repository cwd, Room tree, Task, or implicit Context
authority. Moving a Chat changes none of those VibeHub objects.

This is intentionally reviewable rather than final. The protected downstream
decision chooses:

1. Exact typed-Search placement and result density.
2. Bell/Inbox tone, Sidebar Needs You density, and completion treatment.
3. Center-column Task focus or a bounded Chat-adjacent Task presentation.
4. Exact Composer and voice placement.
5. Browser-first, WebView-first or desktop-wrapper production carrier.

## Boundaries and later work

- Chat→Task, Attach Task and Remember persistence belong to the dedicated
  bridge Ticket.
- Complete microphone UX, audio preprocessing and capability fallback belong
  to the audio Ticket. Experimental realtime voice remains separately gated.
- Final typography, spacing, motion, translucency and every visual state belong
  to the visual-system Ticket and explicit owner approval.
- Packaging, onboarding, upgrade/removal and release artifacts belong to the
  developer-preview Ticket.
- DSH remains a later compatibility Plugin reusing the same adapters and core;
  it does not gate this product.
