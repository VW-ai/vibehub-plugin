# Renders

Finished MP4s and music stems are versioned with **DVC**, stored in Cloudflare R2 (bucket `vibehub`). Git keeps the `*.dvc`
pointers, so every commit names the exact render it was made with.

```bash
# first time on a machine: install DVC and add your R2 keys locally (never committed)
python3 -m venv ~/.cache/vh-dvc && ~/.cache/vh-dvc/bin/pip install "dvc[s3]"
~/.cache/vh-dvc/bin/dvc remote modify --local r2 access_key_id '<S3 access key id>'
~/.cache/vh-dvc/bin/dvc remote modify --local r2 secret_access_key '<S3 secret access key>'

# get the files        # publish a new render
~/.cache/vh-dvc/bin/dvc pull        ~/.cache/vh-dvc/bin/dvc add renders/<clip>.mp4 && ~/.cache/vh-dvc/bin/dvc push
```

| clip | format | length | pointer |
|------|--------|--------|---------|
| taskstory v7 | 16:9 · LinkedIn | 34s | `taskstory-v7.mp4.dvc` |
| glance v4 | 16:9 · LinkedIn | 25s | `glance-v4.mp4.dvc` |
| taskstory portrait v1 | 9:16 · 小红书 | 34s | `taskstory-portrait-v1.mp4.dvc` |
| glance portrait v1 | 9:16 · 小红书 | 25s | `glance-portrait-v1.mp4.dvc` |

Published versions are also archived as GitHub Release assets for stable public links — see
[video-drafts-2026-08-23](https://github.com/VW-ai/vibehub-plugin/releases/tag/video-drafts-2026-08-23).
