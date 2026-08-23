# Renders

Finished MP4s and music stems are versioned with **DVC**, stored in Cloudflare R2 (bucket `vibehub`). Git keeps the `*.dvc`
pointers, so every commit names the exact render it was made with.

## Setup once per machine

```bash
python3 -m venv ~/.cache/vh-dvc && ~/.cache/vh-dvc/bin/pip install "dvc[s3]"
```

Auth is an AWS-style profile named `r2` in `~/.aws/credentials` (the committed `.dvc/config` says `profile = r2`; no keys in git):

```ini
[r2]
aws_access_key_id = <R2 S3 access key id>
aws_secret_access_key = <R2 S3 secret access key>
```

CI uses the same pair from repository secrets `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` (`.github/workflows/media.yml`).

## Publish a new render

```bash
D=~/.cache/vh-dvc/bin/dvc
npx hyperframes render assets/video/<clip> --output /tmp/silent.mp4
assets/video/audio/fetch.sh                                   # stems, once
assets/video/audio/mix-<clip>.sh /tmp/silent.mp4 "$PWD/assets/video/renders/<clip>-vN.mp4"
$D add assets/video/renders/<clip>-vN.mp4 && $D push          # bytes → R2
git add assets/video/renders/<clip>-vN.mp4.dvc assets/video/renders/.gitignore && git commit   # pointer → git
gh release upload <tag> assets/video/renders/<clip>-vN.mp4   # only for a public link
```

Or run the **Media** workflow (Actions → Media → Run) with the clip name: it renders, mixes, pushes to R2 and commits the pointer for you.
`dvc pull` fetches everything on another machine. CI fails any PR whose pointer has no object in R2.

| clip | format | length | pointer |
|------|--------|--------|---------|
| taskstory v7 | 16:9 · LinkedIn | 34s | `taskstory-v7.mp4.dvc` |
| glance v4 | 16:9 · LinkedIn | 25s | `glance-v4.mp4.dvc` |
| taskstory portrait v1 | 9:16 · 小红书 | 34s | `taskstory-portrait-v1.mp4.dvc` |
| glance portrait v1 | 9:16 · 小红书 | 25s | `glance-portrait-v1.mp4.dvc` |

Published versions are also archived as GitHub Release assets for stable public links — see
[video-drafts-2026-08-23](https://github.com/VW-ai/vibehub-plugin/releases/tag/video-drafts-2026-08-23).
