# Codex-native Chat review pack

This pack reviews the interaction substrate, not a final visual theme. Open the
authenticated Codex-first prototype and exercise an ordinary Thread before opening
Tasks. The same renderer must handle durable replay and live notifications.

## Required v1 parity

- Resume real Threads and render stable user and Agent Turn history.
- Stream Agent text, reasoning summary, plan, command output and tool progress
  without replacing the transcript with a second client-side history.
- Keep terminal, tool, file change, diff, approval, user-input and delegated-agent
  activity readable but subordinate to the conversation.
- Preserve image/audio attachments, familiar bottom composer, Send/Stop, keyboard
  behavior, automatic follow, manual-scroll preservation and focus return.
- Recover after refresh by reconciling `thread/read`; replay never claims a live
  Agent and Turn completion never claims a VibeHub Outcome.
- Render `agentMessage.memoryCitation` as inspectable source path/line/note and
  render authoritative interrupted/failed Turn boundaries without deleting partial output.
- Preserve Chat/Search/Task separation. VibeHub remains an additive action layer.

## Reuse decision

Use the official Codex app-server schema as the protocol authority. Reimplement a
small reducer using the stable-id and item-merge patterns demonstrated by the MIT
`codex-gateway` project. For production React composition, selectively adapt MIT
`assistant-ui` primitives for Composer, auto-scroll, attachments, reasoning/tool
grouping and branching. Do not adopt either product's runtime, persistence, SSH
gateway, routing or database.

## Browser matrix

Review Light and Dark at a normal desktop width and 390x844. Cover long Markdown,
code, command output, diff, approval, plan, delegated-agent progress, image/audio,
retry, interruption and completion. Verify keyboard focus, reduced motion, no
horizontal overflow, bounded disclosures and no console error. Fixture-only states
must be visibly identified in review Evidence; ordinary Chat must use the real
authenticated app-server.

## Explicitly deferred

- Pixel-identical proprietary Codex Desktop visuals or assets.
- Final VibeHub `Make Task` / `Remember` persistence.
- Task Workspace conversation and Room activation UI.
- Realtime voice until the current runtime probe reports actual support.
- Production list virtualization library choice and final React package boundary.
