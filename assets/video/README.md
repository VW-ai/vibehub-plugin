# VibeHub launch clips

HyperFrames compositions (HTML + `data-start` timeline → deterministic MP4) for the two first videos.
Messaging, format rules, toolchain and visual rules live in `.vibehub/rooms/marketing/` — read them before editing.

| dir | clip | length | status |
|-----|------|--------|--------|
| `glance/` | #1 functional demo: install → chat while Tickets form → "Start this with VibeHub." → real Workbench (demo repo), push to 3/3 accepted, ends on NEEDS YOU | 25s | v4, music (Schubert) |
| `taskstory/` | #2 narrative: lead's sentence → agent swarm, camera loses its footing → "Lost in the agent sessions." → collapses into one Task → neighbours → zoom out → real All+Fit | 34s | v7, music (Bach) |
| `taskstory-portrait/`, `glance-portrait/` | 9:16 小红书 versions of the two clips, relaid out (not cropped), Chinese captions; same footage and mix scripts | 34s / 25s | v1, music |
| `renders/` | latest MP4s (16:9, 1920×1080) | | |
| `audio/` | music stems, licenses, mix scripts — see `audio/README.md` | | |

## Render

```bash
npx --yes hyperframes render assets/video/taskstory --output assets/video/renders/taskstory.mp4
```

`npx hyperframes lint <dir>` before rendering; `check` is slower (layout/contrast sampling) but catches overlaps.

## Real footage

`*/assets/*.mp4` are Playwright headless recordings of the real Workbench served by `node skills/scripts/vh-ui.mjs --repo <repo> --no-open --json --port 4731x`
(1920×1080, 1x DPR; element shots at 3x).

- `glance/assets/wb.mp4` is recorded from `demo-onboarding.tar.gz`: a tiny acme-app whose three onboarding tickets were planned from the scoping
  conversation in the clip, implemented, evidenced, and closed out with the real VibeHub CLI (`verify-email-step` DONE 3/3, `dashboard-first-run` DONE,
  `welcome-email-copy` READY · NEEDS YOU on a human-authority criterion). Untar it anywhere and point `vh-ui.mjs --repo` at it to re-record.
- `taskstory/assets/fit.mp4` is this repo's own All + Fit view (87 tickets).

## Known gaps before publishing

- taskstory: the zoom-out field is a regular grid; should follow the real graph layout.
- taskstory: the 承 shake is hand-tuned keyframes; revisit once seen on a phone.
- both: no burned-in captions; add for sound-off feeds.
- third-party logos in `taskstory/assets/logos/` are nominative use; review before publishing.
