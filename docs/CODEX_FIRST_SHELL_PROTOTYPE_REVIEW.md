# Codex-first VibeHub shell prototype

Status: real-runtime product and architecture prototype for owner review. It is
not final visual approval, a public release, or a DSH dependency.

Run:

```text
npm run prototype:codex-shell
```

The host binds only to loopback, starts one local Codex app-server, prints a
fragment-bearer URL, and stops the child runtime with the prototype. The browser
does not receive Codex credentials. Project files change only when the owner
starts a Codex Turn whose approved tools change them; simply opening and
reviewing the prototype is read-only.

## Product promise under review

The ordinary path should feel familiar to a Codex user:

- persistent sidebar and New task entry;
- real Codex Thread history and restart recovery;
- real Thread reading and resumption;
- Composer input, image/audio attachments, voice recording and interruption;
- streamed Turn, item, plan, diff, tool and completion events;
- command/file approval and request-user-input boundaries;
- exact Light and Dark Codex primitives.

VibeHub begins where ordinary Codex task history stops. It adds Tasks as a
durable work unit, a causal Task Graph, a focused Task Workspace, canonical
Context and Acceptance, Evidence, independent Outcome and return-to-work
posture. Codex owns Threads, Turns, tools, approvals and execution. VibeHub does
not translate Codex plans into Tasks, harvest every Chat, or create a second
Agent loop or Task database.

## Review path

1. Open the prototype and confirm existing Project Threads appear from the real
   Codex app-server.
2. Open an existing Thread and inspect its persisted Turns, tools and output.
3. Start a new Codex task, send a text Turn, observe real streaming, and
   interrupt it if desired.
4. Attach an image or record voice. The microphone becomes live only after the
   browser grants access; the resulting recording is sent as ordinary Codex
   `audio` input. Realtime conversation is not claimed by this build.
5. Open Tasks. Select a graph card and inspect the canonical Task Context,
   Acceptance, proof posture and Recommended action.
6. On an executable Task, select **Start in Codex**. The exact host-owned Task
   handoff becomes the first input of one real Codex Thread. Return to the Task
   and confirm the linked Thread is discoverable without browser storage.
7. Switch System → Light → Dark and repeat the Chat, Graph and Task loop.
8. Review at a wide desktop size and 390×844. Confirm keyboard focus, sidebar
   drawer behavior, no horizontal overflow and reduced-motion behavior.

## Current composition

The prototype lands on Codex because that is the environment the owner uses
today. Tasks is a peer top-level destination, not a full-screen overlay or a
separate nested application. Selecting a Task replaces the center column with
its focused Workspace. Opening its linked Thread returns to normal Codex Chat
inside the same persistent shell.

This is intentionally reviewable rather than final. The protected downstream
decision chooses:

1. Codex-first or Tasks-first default landing.
2. Tasks beside Codex in top-level navigation or grouped under the Project.
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
