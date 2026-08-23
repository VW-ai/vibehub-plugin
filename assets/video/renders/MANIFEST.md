# Renders

Finished MP4s are not stored in git. They live on the GitHub Release
[video-drafts-2026-08-23](https://github.com/VW-ai/vibehub-plugin/releases/tag/video-drafts-2026-08-23).

| clip | format | length | link |
|------|--------|--------|------|
| taskstory v7 | 16:9 · LinkedIn | 34s | https://github.com/VW-ai/vibehub-plugin/releases/download/video-drafts-2026-08-23/taskstory-v7.mp4 |
| glance v4 | 16:9 · LinkedIn | 25s | https://github.com/VW-ai/vibehub-plugin/releases/download/video-drafts-2026-08-23/glance-v4.mp4 |
| taskstory portrait v1 | 9:16 · 小红书 | 34s | https://github.com/VW-ai/vibehub-plugin/releases/download/video-drafts-2026-08-23/taskstory-portrait-v1.mp4 |
| glance portrait v1 | 9:16 · 小红书 | 25s | https://github.com/VW-ai/vibehub-plugin/releases/download/video-drafts-2026-08-23/glance-portrait-v1.mp4 |

Re-render locally with `npx hyperframes render assets/video/<clip>` and mix with `assets/video/audio/mix-*.sh`
(run `assets/video/audio/fetch.sh` first to pull the music stems). Upload new versions with
`gh release upload <tag> <file>` and update this table.
