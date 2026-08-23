# VibeHub launch clips

HyperFrames compositions (HTML + `data-start` timeline → deterministic MP4) for the two first videos.
Messaging, format rules, toolchain and visual rules live in `.vibehub/rooms/marketing/` — read them before editing.

| dir | clip | length | status |
|-----|------|--------|--------|
| `glance/` | #1 functional demo: install → chat while Tickets form → "Start this with VibeHub." → real Workbench, push to 6/6 accepted | 22.3s | v2 draft, no audio |
| `taskstory/` | #2 narrative: lead's sentence → agent swarm → "Where is it now?" → collapses into one Task → neighbours → zoom out → real All+Fit | 26.6s | v3 draft, no audio |
| `renders/` | latest MP4s (16:9, 1920×1080) | | |

## Render

```bash
npx --yes hyperframes render assets/video/taskstory --output assets/video/renders/taskstory.mp4
```

`npx hyperframes lint <dir>` before rendering; `check` is slower (layout/contrast sampling) but catches overlaps.

## Real footage

`*/assets/*.mp4` are Playwright headless recordings of the real Workbench served by `node skills/scripts/vh-ui.mjs --repo . --no-open --json --port 47311`
(1920×1080, 1x DPR; element shots at 3x). Re-record from a demo repo whose tickets match the story before publishing — the current footage shows this repo's own tickets.

## Known gaps before publishing

- glance: footage tickets do not match the onboarding story told in the chat beat.
- taskstory: the zoom-out field is a regular grid; should follow the real graph layout.
- both: no voiceover/music/captions yet (HyperFrames `/hyperframes-audio`, `/media-use`).
- third-party logos in `taskstory/assets/logos/` are nominative use; review before publishing.
